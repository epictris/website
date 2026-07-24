// BallHook — the ball & chain controller's chain-end projectile. Unlike the
// grapple Hook (a CharacterBody2D flying in a straight line), this is a
// RigidBody2D: gravity bends its flight into an arc. It attaches to the first
// surface it contacts — during flight or later while dangling at full chain
// length — via a swept ray for fast motion plus an overlap probe for
// slow/resting contact.

import { RigidBody2D, StaticBody2D, type PhysicsBody2D } from "../engine/body";
import { PX } from "../engine/units";
import { circleShape } from "../engine/shapes";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { Vec2 } from "../engine/vec2";

export class BallHook extends RigidBody2D {
  private attachmentCallbacks: Array<(body: PhysicsBody2D, point: Vec2) => void> = [];
  private armed = true;

  constructor() {
    super();
    this.name = "BallHook";
    this.setShape(circleShape(2 * PX));
    this.mass = ShapeGeometry.computeMass(this.getShape());
    this.inertia = ShapeGeometry.computeMomentOfInertia(this.getShape(), this.mass);
  }

  registerAttachmentCallback(onAttach: (body: PhysicsBody2D, point: Vec2) => void): void {
    this.attachmentCallbacks.push(onAttach);
  }

  private attach(body: PhysicsBody2D, point: Vec2): void {
    this.armed = false;
    for (const cb of this.attachmentCallbacks) cb(body, point);
    this.world?.remove(this);
  }

  // Attach check, run before World.integrate moves the body: a swept ray
  // along the upcoming motion (anchors fast flight at the surface instead of
  // bouncing off it), then an overlap probe for slow or resting contact.
  physicsStep(dt: number): void {
    if (!this.armed || !this.world) return;
    const from = this.globalPosition;
    const to = from.add(this.linearVelocity.mul(dt));
    const hit = this.world.intersectRay(from, to, { collisionMask: 1, exclude: [this] });
    if (hit && hit.collider.name !== "Player") {
      this.attach(hit.collider, hit.position);
      return;
    }
    const shape = this.getShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    for (const body of this.world.intersectCircle(from, r + 0.5 * PX)) {
      if (body === this || body.name === "Player") continue;
      if (!(body instanceof StaticBody2D || body instanceof RigidBody2D)) continue;
      this.attach(body, from);
      return;
    }
  }
}
