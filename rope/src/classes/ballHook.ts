// BallHook — the ball & chain controller's chain-end projectile. Unlike the
// grapple Hook (a CharacterBody2D flying in a straight line), this is a
// RigidBody2D: gravity bends its flight into an arc. It attaches to the first
// surface it contacts — during flight or later while dangling at full chain
// length — via a swept ray for fast motion plus an overlap probe for
// slow/resting contact.

import { ImpermeableBody, RigidBody2D, StaticBody2D, type PhysicsBody2D } from "../engine/body";
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
    // Impermeable (hook-proof) surfaces are bounced off rather than anchored to.
    // Very low restitution: the hook barely rebounds — mostly deflects and drops.
    this.restitution = 0.0375;
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
    const shape = this.getShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const hit = this.world.intersectRay(from, to, { collisionMask: 1, exclude: [this] });
    if (hit && hit.collider.name !== "Player") {
      // Impermeable bodies aren't attach targets — the hook bounces off them.
      // Reflect here on the swept ray rather than leaning on World.integrate's
      // discrete depenetration: a fast hook would fully cross a thin wall in one
      // step, be found on the far side with no overlap, and tunnel through.
      if (hit.collider instanceof ImpermeableBody) {
        this.bounce(hit.position, hit.normal, r);
        return;
      }
      this.attach(hit.collider, hit.position);
      return;
    }
    for (const body of this.world.intersectCircle(from, r + 0.5 * PX)) {
      if (body === this || body.name === "Player") continue;
      if (body instanceof ImpermeableBody) continue;
      if (!(body instanceof StaticBody2D || body instanceof RigidBody2D)) continue;
      this.attach(body, from);
      return;
    }
  }

  // Reflect the hook's velocity about the surface normal and seat it on the
  // surface (radius off, along the normal) so the following World.integrate step
  // carries it away instead of back into the wall.
  private bounce(point: Vec2, normal: Vec2, radius: number): void {
    const vn = this.linearVelocity.dot(normal);
    if (vn < 0) {
      this.linearVelocity = this.linearVelocity.sub(normal.mul((1 + this.restitution) * vn));
    }
    this.globalPosition = point.add(normal.mul(radius));
  }
}
