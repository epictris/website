// Level — owns the world, player and body list; drives one physics frame.
// Ported from classes/Level.cs (rendering/camera split into the renderer).

import { Vec2 } from "../engine/vec2";
import {
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
} from "../engine/body";
import { rectShape, circleShape } from "../engine/shapes";
import { Debug } from "../engine/debug";
import { World } from "../engine/world";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { Player } from "../classes/player";
import { Hook } from "../classes/hook";
import { KillZone } from "../classes/killZone";
import type { FrameInput } from "../input/frameInput";
import type { LevelData } from "./levelData";

export class Level {
  readonly world = new World();
  readonly player: Player;
  // All PhysicsBody2D the rope may wrap (player + statics + spawned bodies).
  bodies: PhysicsBody2D[] = [];
  frame = 0;
  cameraPosition = Vec2.ZERO;
  onReset: (() => void) | null = null;

  constructor(data: LevelData) {
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

    this.cameraPosition = this.player.globalPosition;
  }

  private spawnBody(body: PhysicsBody2D): void {
    this.world.add(body);
    this.bodies.push(body);
  }

  private spawnRectangle(width: number, height: number, position: Vec2): void {
    const body = new RigidBody2D();
    body.setShape(rectShape(width, height));
    body.mass = ShapeGeometry.computeMass(body.getShape());
    body.inertia = ShapeGeometry.computeMomentOfInertia(body.getShape(), body.mass);
    body.globalPosition = position;
    this.spawnBody(body);
  }

  physicsProcess(input: FrameInput, delta: number): void {
    this.frame++;
    Debug.clear();

    this.player.resolveMouseActions(input);
    if (input.spawnSmallRect.pressed) this.spawnRectangle(20, 20, input.mouseWorldPosition);
    if (input.spawnLargeRect.pressed) this.spawnRectangle(80, 80, input.mouseWorldPosition);

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
