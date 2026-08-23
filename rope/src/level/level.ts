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
import type { SparkEvent } from "./sparkEvents";
import type { FrameInput } from "../input/frameInput";
import {
  scaleLevelData,
  type CameraPathData,
  type CameraRegionData,
  type LevelData,
  type RawLevelData,
} from "./levelFormat";
import { buildLevelBodies, type LevelVisualSource } from "./buildBodies";
import { collectDecor, type SceneDecor } from "./decor";
import {
  buildSceneChains,
  stepSceneChains,
  type SceneChain,
  type SceneConstraint,
} from "./chains";
import {
  buildVines,
  stepVines,
  updateVineLoads,
  vineChainSet,
  vineWrapBodies,
  type Vine,
} from "./vines";
import { buildCameraRules, type CameraRule } from "../render/cameraController";
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
  data: RawLevelData;
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
  // Camera paths, in metres (see CameraPathData). Read by the same controller
  // and, like the regions, never by the sim.
  readonly cameraPaths: CameraPathData[];
  // The two lists as the one rule set the controller governs with, built once
  // here because a path's polyline index is derived and nothing mutates it.
  readonly cameraRules: CameraRule[];
  // The authored shapes that are drawn and never simulated, in metres, each
  // resolved against the body it is welded to (see SceneDecor). Read only by
  // the renderer; like the camera regions, the sim never touches them.
  readonly decor: SceneDecor[];
  // Chains strung between authored bodies, solved every frame after the world
  // integrates (see SceneChain). AUTHORED chains only - a vine's pair chains are
  // `SceneChain`s too and are swept with these, but they are the vine's and are
  // drawn as one, so they are not in this list (see `chainSet`).
  readonly sceneChains: SceneChain[];
  // Vines hanging from authored anchors (see `level/vines.ts`). Their links are
  // in the world and in `bodies`; their pair chains are in `chainSet`.
  readonly vines: Vine[];
  // Scratch for the set the chain phase sweeps: the authored chains plus every
  // AWAKE vine's pair chains and its load rope, as ONE system. They share bodies
  // wherever a vine hangs off something a chain also holds, and a set solved in
  // two passes is two constraints spending every frame undoing each other (see
  // `sweepChains`). Rebuilt in place once a frame (see `vineChainSet`).
  private readonly solveSet: SceneConstraint[] = [];
  // What a vine's load rope may bend around: the level's static geometry.
  private readonly vineWraps: PhysicsBody2D[];
  // Render-only: the metre-scaled level as built, and the engine object each
  // authored entry became. It is what lets the 3D renderer hand an authored
  // `visual` to the exact piece of the exact body it decorates (see
  // `render3d/scene.ts`); the sim never reads it, and neither does the 2D
  // renderer, which draws bodies and knows nothing about the file they came from.
  readonly visualSource: LevelVisualSource;
  onReset: (() => void) | null = null;
  // Render-only: this frame's hook-on-hook-proof-steel contacts, for the spark
  // system (see `level/sparkEvents.ts` and BallLevel's field of the same name).
  // Cleared at the top of every `physicsProcess`; the sim never reads it.
  //
  // The grapple hook is DESTROYED by a hook-proof surface rather than deflected
  // by it, so this level only ever produces the impact burst - there is no hook
  // left to slide.
  sparkEvents: SparkEvent[] = [];

  constructor(rawData: RawLevelData, init?: (level: Level) => void) {
    const data = scaleLevelData(rawData, PX);
    this.cameraRegions = data.cameraRegions ?? [];
    this.cameraPaths = data.cameraPaths ?? [];
    this.cameraRules = buildCameraRules(this.cameraRegions, this.cameraPaths);
    this.player = new Player(data.player.radius);
    this.player.globalPosition = new Vec2(data.player.x, data.player.y);
    this.player.spawnBody = (b) => this.spawnBody(b);
    this.world.add(this.player);
    this.bodies.push(this.player);

    const built = buildLevelBodies(this.world, data, () => this.onReset?.());
    this.bodies.push(...built.wrapBodies);
    this.sceneChains = buildSceneChains(data, built);
    this.vines = buildVines(this.world, data, built);
    // The links go in the rope's candidate list like every other body. They are
    // never wrapped - `isPassThrough` drops a non-solid body from the wrap scan -
    // so what this buys is that the list is what the world holds, rather than a
    // second, quieter definition of the scene.
    for (const vine of this.vines) this.bodies.push(...vine.links);
    this.vineWraps = vineWrapBodies(built);
    this.decor = collectDecor(built);
    this.visualSource = { data, built };

    init?.(this);

    this.cameraPosition = this.player.globalPosition;
  }

  private spawnBody(body: PhysicsBody2D): void {
    // Every hook enters the world through here (see BallLevel.spawnBody, which
    // does the same for the ball's).
    if (body instanceof Hook) {
      body.onDestroyed((point, normal, vel) =>
        this.sparkEvents.push({ point, normal, vel }),
      );
    }
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
    this.sparkEvents.length = 0;
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

    // A vine's load rope is derived from the state of the world rather than
    // driven by grab and release events, so it is settled here, immediately
    // before the sweep that has to solve it.
    const lra = updateVineLoads(this.vines, this.player.rope, this.vineWraps);
    stepVines(this.vines);
    const chains = vineChainSet(this.sceneChains, this.vines, lra, this.solveSet);
    // Scene chains solve last, after integration has moved the bodies they hold
    // - so the frame ends inside the constraint rather than |v|·dt outside it.
    // A level with no chains does nothing here, which is what keeps every
    // recorded replay bit-identical.
    //
    // The player's rope is coupled into that sweep exactly while it is holding a
    // vine, because that is exactly when the two share a body: solved in
    // separate phases each one's correction is the other's residual, and the
    // winch spends its correction moving an anchor the pair chains put straight
    // back (`session-521f`, in the ball's words). Its own `physicsStep` above is
    // left where it is - that is what moves the player - and this is the sweep
    // having the last word on where the frame leaves the pair.
    stepSceneChains(
      chains,
      this.world,
      delta,
      lra && this.player.rope
        ? // The set here is a vine - pair chains in series, which one sweep
          // cannot hold - so it has to reach its own tolerance too (see
          // `CoupledRope.settleSet`).
          { rope: this.player.rope, bodies: this.bodies, settleSet: true }
        : null,
    );
    PhaseTrace.mark("scene-chains", this.world);

    this.cameraPosition = this.player.globalPosition;
  }
}
