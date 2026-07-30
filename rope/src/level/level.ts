// Level — owns the world, player and body list; drives one physics frame.
// Ported from classes/Level.cs (rendering/camera split into the renderer).

import { Vec2 } from "../engine/vec2";
import {
  AnimatableBody2D,
  PhysicsBody2D,
  RigidBody2D,
} from "../engine/body";
import { circleShape } from "../engine/shapes";
import { Debug } from "../engine/debug";
import { PhaseTrace } from "../engine/phaseTrace";
import { PhysTrace } from "../engine/physTrace";
import { World } from "../engine/world";
import { Density, ShapeGeometry } from "../lib/shapeGeometry";
import { Player } from "../classes/player";
import { Hook } from "../classes/hook";
import type { FrameInput } from "../input/frameInput";
import {
  scaleLevelData,
  type BackgroundData,
  type CameraRegionData,
  type LevelData,
} from "./levelFormat";
import { buildLevelBodies } from "./buildBodies";
import { buildSceneChains, type SceneChain } from "./chains";
import { PX } from "../engine/units";

// Scripted-mover update: sets the body's transform for the given sim time.
// Deterministic — must be a pure function of time (frame * dt). Keep contact
// speeds under ~2 px/frame so movers can't trip the embed invariant.
export type MoverScript = (body: AnimatableBody2D, time: number) => void;

// A registry entry: static geometry plus an optional init hook that adds
// scripted movers (hand-written levels only — levelData.ts stays generated).
// controller: "ball" runs the arena with the ball & chain controller
// (BallLevel) instead of the grappling character controller.
export interface LevelSpec {
  data: LevelData;
  init?: (level: Level) => void;
  controller?: "ball";
}

export class Level {
  readonly world = new World();
  readonly player: Player;
  // All PhysicsBody2D the rope may wrap (player + statics + spawned bodies).
  bodies: PhysicsBody2D[] = [];
  readonly movers: Array<{ body: AnimatableBody2D; script: MoverScript }> = [];
  frame = 0;
  cameraPosition = Vec2.ZERO;
  // Camera-behaviour volumes, in metres. Read by the render-side
  // CameraController; the sim never touches them.
  readonly cameraRegions: CameraRegionData[];
  // Decoration drawn behind the level, in metres. Read only by the renderer;
  // like the camera regions, the sim never touches them.
  readonly backgrounds: BackgroundData[];
  // Chains strung between authored bodies, solved every frame after the world
  // integrates (see SceneChain).
  readonly sceneChains: SceneChain[];
  onReset: (() => void) | null = null;

  constructor(rawData: LevelData, init?: (level: Level) => void) {
    const data = scaleLevelData(rawData, PX);
    this.cameraRegions = data.cameraRegions ?? [];
    this.backgrounds = data.backgrounds ?? [];
    this.player = new Player(data.player.radius);
    this.player.globalPosition = new Vec2(data.player.x, data.player.y);
    this.player.spawnBody = (b) => this.spawnBody(b);
    this.world.add(this.player);
    this.bodies.push(this.player);

    const built = buildLevelBodies(this.world, data, () => this.onReset?.());
    this.bodies.push(...built.wrapBodies);
    this.sceneChains = buildSceneChains(data, built.byIndex);

    init?.(this);

    this.cameraPosition = this.player.globalPosition;
  }

  private spawnBody(body: PhysicsBody2D): void {
    this.world.add(body);
    this.bodies.push(body);
  }

  addMover(body: AnimatableBody2D, script: MoverScript): void {
    this.spawnBody(body);
    this.movers.push({ body, script });
  }

  // Circles are the only physics-driven shape (game-design.md).
  private spawnCircle(radius: number, position: Vec2): void {
    const body = new RigidBody2D();
    body.setShape(circleShape(radius));
    // Rock: the sandbox's loose circles are boulders, so a 20 cm one is 10 kg
    // and the avatar shoves it aside, while the 80 cm one is 640 kg and barely
    // shifts. That spread is the point of having two of them.
    body.mass = ShapeGeometry.computeMass(body.primaryShape(), Density.STONE);
    body.inertia = ShapeGeometry.computeMomentOfInertia(body.primaryShape(), body.mass);
    body.globalPosition = position;
    this.spawnBody(body);
  }

  // Camera target for a render frame: the avatar's interpolated position (see
  // BallLevel.cameraRenderPosition).
  cameraRenderPosition(alpha: number): Vec2 {
    return this.player.renderPosition(alpha);
  }

  physicsProcess(input: FrameInput, delta: number): void {
    this.frame++;
    Debug.clear();
    PhysTrace.frame = this.frame;
    PhaseTrace.begin(this.frame, this.world);
    // Snapshot the pre-step transforms the renderer interpolates from.
    this.world.captureRenderTransforms();

    // Scripted movers run first so the player and rope see current-frame
    // transforms with matching per-frame contact velocities.
    const time = this.frame * delta;
    for (const m of this.movers) {
      m.body.beginMove();
      m.script(m.body, time);
      m.body.commitMove(delta);
    }

    this.player.resolveMouseActions(input);
    if (input.spawnSmallCircle.pressed) this.spawnCircle(0.1, input.mouseWorldPosition);
    if (input.spawnLargeCircle.pressed) this.spawnCircle(0.4, input.mouseWorldPosition);

    this.player.rope?.updateFrameStartDistanceLookup();
    this.player.resolveInput(input, delta);
    // Locomotion and the character sweep (`moveAndCollide`), which is where the
    // grapple avatar's velocity is decided.
    PhaseTrace.mark("locomotion", this.world);

    // Drop bodies removed from the world this frame.
    this.bodies = this.bodies.filter((b) => !b.removed);

    if (this.player.rope) this.player.rope.physicsStep(this.bodies, delta);
    PhaseTrace.mark("rope-solve", this.world);

    // Hooks fly independently (Godot Hook._PhysicsProcess), after level logic.
    for (const b of this.bodies) {
      if (b instanceof Hook) b.physicsStep();
    }
    this.bodies = this.bodies.filter((b) => !b.removed);

    // Godot integrates dynamic bodies after _physics_process.
    this.world.integrate(delta);

    // Scene chains solve last, after integration has moved the bodies they hold
    // - so the frame ends inside the constraint rather than |v|·dt outside it.
    // A level with no chains does nothing here, which is what keeps every
    // recorded replay bit-identical.
    for (const chain of this.sceneChains) chain.physicsStep(delta);
    PhaseTrace.mark("scene-chains", this.world);

    this.cameraPosition = this.player.globalPosition;
  }
}
