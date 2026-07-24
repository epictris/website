// Hook — the grappling projectile, ported from classes/Hook.cs.
// A CharacterBody2D that flies in a straight line and either attaches to the
// first body it hits (firing the rope's attachment callback) or is destroyed by
// an ImpermeableBody.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { CharacterBody2D, ImpermeableBody, type PhysicsBody2D } from "../engine/body";
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
    const result = this.world.intersectRay(ray.start, ray.end, {
      collisionMask: 1,
      exclude: [this],
    });

    if (result) {
      const closest = result.collider;
      if (closest instanceof ImpermeableBody) {
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
