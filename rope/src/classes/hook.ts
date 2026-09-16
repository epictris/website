// Hook — the grappling projectile, ported from classes/Hook.cs.
// A CharacterBody2D that flies in a straight line and either attaches to the
// first surface it hits (firing the rope's attachment callback) or is destroyed
// by an impermeable one.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import {
  CharacterBody2D,
  LAYER_HOOK,
  MASK_ALL,
  type PhysicsBody2D,
} from "../engine/body";
import { circleShape } from "../engine/shapes";
import { Segment } from "../lib/segment";

// The fixed timestep the hook's per-frame `velocity` is expressed at, used only
// to restate it as m/s for the destruction event.
const STEP = 1 / 60;

export class Hook extends CharacterBody2D {
  private destroyedCbs: Array<(point: Vec2, normal: Vec2, vel: Vec2) => void> = [];
  private attachmentCallbacks: Array<(body: PhysicsBody2D, point: Vec2) => void> = [];

  constructor() {
    super();
    this.name = "Hook";
    // The chain end is its own collision category, so a piece of scenery can
    // leave `LAYER_HOOK` out of its mask and be geometry the hook flies through
    // while still stopping everything else (`CollisionShape2D.mask`).
    this.collisionLayer = LAYER_HOOK;
    if (!this.hasShape()) this.setShape(circleShape(PX));
  }

  // Fired when a hook-proof surface destroys the hook, with the contact point,
  // the surface normal and the hook's velocity in m/s. `Rope` ignores the
  // arguments (it only wants to know the hook is gone); `Level` reads them for
  // the impact sparks (see `level/sparkEvents.ts`).
  onDestroyed(cb: (point: Vec2, normal: Vec2, vel: Vec2) => void): void {
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
    // Every category there is: the hook is the one query that sees
    // LAYER_ANCHOR, which is exactly what makes a grate attachable while the
    // avatar (and every other `MASK_SOLID` query) passes through it.
    //
    // ...and it asks AS the hook, so a piece that has left `LAYER_HOOK` out of
    // its mask - a stool's legs, geometry set back in z from the gameplay plane
    // - is flown straight through rather than caught on, exactly as it is
    // walked through and passed through by the chain.
    const result = this.world.intersectRay(ray.start, ray.end, {
      collisionMask: MASK_ALL,
      collisionLayer: LAYER_HOOK,
      exclude: [this],
    });

    if (result) {
      const closest = result.collider;
      // The PIECE the ray reached, not the body: one wall may be a compound of
      // an attachable ledge and hook-proof faces, and the hook is answered by
      // whichever it actually flew into.
      if (result.shape.impermeable) {
        // `velocity` is the hook's per-frame displacement (it flies by adding
        // it to its own position), so it is divided by the step to be the m/s
        // the spark system's thresholds are written in.
        const vel = this.velocity.mul(1 / STEP);
        for (const cb of this.destroyedCbs) cb(result.position, result.normal, vel);
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
