// BallHook — the ball & chain controller's chain-end projectile. Unlike the
// grapple Hook (a CharacterBody2D flying in a straight line), this is a
// RigidBody2D: gravity bends its flight into an arc. It attaches to the first
// surface it contacts — during flight or later while dangling at full chain
// length — via a swept ray for fast motion plus an overlap probe for
// slow/resting contact.

import { ImpermeableBody, RigidBody2D, StaticBody2D, type PhysicsBody2D } from "../engine/body";
import { PX } from "../engine/units";
import { circleShape } from "../engine/shapes";
import { circleOverlap } from "../engine/collision";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { Vec2 } from "../engine/vec2";

export class BallHook extends RigidBody2D {
  private attachmentCallbacks: Array<(body: PhysicsBody2D, point: Vec2) => void> = [];
  private bounceCallbacks: Array<() => void> = [];
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

  registerBounceCallback(onBounce: () => void): void {
    this.bounceCallbacks.push(onBounce);
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
        this.bounce(hit.normal, hit.position.add(hit.normal.mul(r)));
        return;
      }
      this.attach(hit.collider, hit.position);
      return;
    }
    const probeR = r + 0.5 * PX;
    for (const body of this.world.intersectCircle(from, probeR)) {
      if (body === this || body.name === "Player") continue;
      // Impermeable contact the swept centre-ray missed — a hook grazing the
      // face with only its rim (centre passing beside the wall). Bounce off it
      // here too, so the deploy still stops instead of skimming past.
      if (body instanceof ImpermeableBody) {
        const ov = circleOverlap(from, probeR, body.getShape());
        if (ov) this.bounce(ov.normal, from.add(ov.normal.mul(ov.depth)));
        return;
      }
      if (!(body instanceof StaticBody2D || body instanceof RigidBody2D)) continue;
      this.attach(body, from);
      return;
    }
  }

  // Reflect the hook's velocity about the surface normal (outward) and seat it
  // at `seatPos` so the following World.integrate step carries it away rather
  // than back into the wall. Notifies bounce listeners (they stop the deploy).
  private bounce(normal: Vec2, seatPos: Vec2): void {
    const vn = this.linearVelocity.dot(normal);
    if (vn < 0) {
      this.linearVelocity = this.linearVelocity.sub(normal.mul((1 + this.restitution) * vn));
    }
    this.globalPosition = seatPos;
    for (const cb of this.bounceCallbacks) cb();
  }
}
