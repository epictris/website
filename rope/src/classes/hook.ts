// Hook — the grappling projectile, ported from classes/Hook.cs.
// A CharacterBody2D that flies in a straight line and either attaches to the
// first surface it hits (firing the rope's attachment callback) or is destroyed
// by an impermeable one.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import {
  CharacterBody2D,
  LAYER_ANCHOR,
  LAYER_SOLID,
  type PhysicsBody2D,
} from "../engine/body";
import { circleShape } from "../engine/shapes";
import { Segment } from "../lib/segment";

export class Hook extends CharacterBody2D {
  private destroyedCbs: Array<() => void> = [];
  private attachmentCallbacks: Array<(body: PhysicsBody2D, point: Vec2) => void> = [];

  constructor() {
    super();
    this.name = "Hook";
    if (!this.hasShape()) this.setShape(circleShape(PX));
  }

  onDestroyed(cb: () => void): void {
    this.destroyedCbs.push(cb);
  }

  registerAttachmentCallback(onAttach: (body: PhysicsBody2D, point: Vec2) => void): void {
    this.attachmentCallbacks.push(onAttach);
  }

  // Called by Level each physics frame (Godot _PhysicsProcess).
  physicsStep(): void {
    if (!this.world) return;
    if (this.velocity.lengthSquared() < 0.0001 * PX * PX) return;

    const ray = new Segment(this.globalPosition, this.globalPosition.add(this.velocity));
    // Solid geometry plus hook-only anchors: the hook is the one query that
    // sees LAYER_ANCHOR, which is exactly what makes a grate attachable while
    // the avatar (and every other mask-1 query) passes through it.
    const result = this.world.intersectRay(ray.start, ray.end, {
      collisionMask: LAYER_SOLID | LAYER_ANCHOR,
      exclude: [this],
    });

    if (result) {
      const closest = result.collider;
      // The PIECE the ray reached, not the body: one wall may be a compound of
      // an attachable ledge and hook-proof faces, and the hook is answered by
      // whichever it actually flew into.
      if (result.shape.impermeable) {
        for (const cb of this.destroyedCbs) cb();
        this.world.remove(this);
        return;
      }
      if (closest.name !== "Player") {
        for (const cb of this.attachmentCallbacks) cb(closest, result.position);
        this.world.remove(this);
        return;
      }
    }
    this.globalPosition = this.globalPosition.add(this.velocity);
  }
}
