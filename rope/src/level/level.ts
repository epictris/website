// Level — owns the world, player and body list; drives one physics frame.
// Ported from classes/Level.cs (rendering/camera split into the renderer).

import { Vec2 } from "../engine/vec2";
import {
  AnimatableBody2D,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
} from "../engine/body";
import { rectShape, circleShape } from "../engine/shapes";
import { Debug } from "../engine/debug";
import { PhysTrace } from "../engine/physTrace";
import { World } from "../engine/world";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { Player } from "../classes/player";
import { Hook } from "../classes/hook";
import { KillZone } from "../classes/killZone";
import type { FrameInput } from "../input/frameInput";
import type { LevelData } from "./levelData";

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
  onReset: (() => void) | null = null;

  constructor(data: LevelData, init?: (level: Level) => void) {
    this.player = new Player(data.player.radius);
    this.player.globalPosition = new Vec2(data.player.x, data.player.y);
    this.player.spawnBody = (b) => this.spawnBody(b);
    this.world.add(this.player);
    this.bodies.push(this.player);

    for (const b of data.bodies) {
      const shape = b.shape.kind === "rect" ? rectShape(b.shape.w, b.shape.h) : circleShape(b.shape.r);
      if (b.kind === "killzone") {
        const kz = new KillZone(() => this.onReset?.());
        kz.setShape(shape);
        kz.globalPosition = new Vec2(b.x, b.y);
        kz.globalRotation = b.rot;
        this.world.add(kz);
      } else {
        const sb = new StaticBody2D();
        sb.setShape(shape);
        sb.globalPosition = new Vec2(b.x, b.y);
        sb.globalRotation = b.rot;
        this.world.add(sb);
        this.bodies.push(sb);
      }
    }

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
    body.mass = ShapeGeometry.computeMass(body.getShape());
    body.inertia = ShapeGeometry.computeMomentOfInertia(body.getShape(), body.mass);
    body.globalPosition = position;
    this.spawnBody(body);
  }

  physicsProcess(input: FrameInput, delta: number): void {
    this.frame++;
    Debug.clear();
    PhysTrace.frame = this.frame;

    // Scripted movers run first so the player and rope see current-frame
    // transforms with matching per-frame contact velocities.
    const time = this.frame * delta;
    for (const m of this.movers) {
      m.body.beginMove();
      m.script(m.body, time);
      m.body.commitMove(delta);
    }

    this.player.resolveMouseActions(input);
    if (input.spawnSmallCircle.pressed) this.spawnCircle(10, input.mouseWorldPosition);
    if (input.spawnLargeCircle.pressed) this.spawnCircle(40, input.mouseWorldPosition);

    this.player.rope?.updateFrameStartDistanceLookup();
    this.player.resolveInput(input, delta);

    // Drop bodies removed from the world this frame.
    this.bodies = this.bodies.filter((b) => !b.removed);

    if (this.player.rope) this.player.rope.physicsStep(this.bodies, delta);

    // Hooks fly independently (Godot Hook._PhysicsProcess), after level logic.
    for (const b of this.bodies) {
      if (b instanceof Hook) b.physicsStep();
    }
    this.bodies = this.bodies.filter((b) => !b.removed);

    // Godot integrates dynamic bodies after _physics_process.
    this.world.integrate(delta);

    this.cameraPosition = this.player.globalPosition;
  }
}
