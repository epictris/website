// BallHook — the ball & chain controller's chain-end projectile. Unlike the
// grapple Hook (a CharacterBody2D flying in a straight line), this is a
// RigidBody2D: gravity bends its flight into an arc. It attaches to the first
// surface it contacts — during flight or later while dangling at full chain
// length — via a swept ray for fast motion plus an overlap probe for
// slow/resting contact.

import { ImpermeableBody, RigidBody2D, StaticBody2D, type PhysicsBody2D } from "../engine/body";
import { PX } from "../engine/units";
import { circleShape } from "../engine/shapes";
import { circleOverlap, sweepCircle } from "../engine/collision";
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

  // Attach check, run before World.integrate moves the body: a swept *circle*
  // (radius-aware) along the upcoming motion, then an overlap probe for slow or
  // resting contact. Sweeping the circle rather than a centre-ray means a hook
  // whose rim clips a surface — a graze the bare centre would pass beside —
  // still registers as first contact, so it anchors to a static (or bounces off
  // impermeable) instead of slipping into World.integrate's discrete collision,
  // which merely deflects it (a stray bounce, and a max-length hook then whips
  // off). The contact is exact, so the hook never anchors to geometry it isn't
  // touching.
  physicsStep(dt: number): void {
    if (!this.armed || !this.world) return;
    const from = this.globalPosition;
    const shape = this.getShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const motion = this.linearVelocity.mul(dt);

    let best: { t: number; normal: Vec2; collider: PhysicsBody2D } | null = null;
    for (const body of this.world.bodies) {
      if (body.removed || body === this || body.name === "Player") continue;
      if (this.exceptions.has(body.id)) continue;
      if (!(body instanceof StaticBody2D || body instanceof RigidBody2D)) continue;
      if (!body.hasShape()) continue;
      const sweep = sweepCircle(from, motion, r, body.getShape());
      if (sweep && sweep.t <= 1 && (!best || sweep.t < best.t)) {
        best = { t: sweep.t, normal: sweep.normal, collider: body };
      }
    }
    if (best) {
      const contactCenter = from.add(motion.mul(best.t));
      if (best.collider instanceof ImpermeableBody) {
        this.bounce(best.normal, contactCenter);
        return;
      }
      // Anchor on the surface itself: one radius from the contact-frame centre
      // along the (inward) contact normal.
      this.attach(best.collider, contactCenter.sub(best.normal.mul(r)));
      return;
    }
    this.probeContact();
  }

  // Radius-aware overlap probe for slow / resting contact the sweep (which needs
  // motion) doesn't cover: attach to a static/rigid surface, bounce off
  // impermeable. Runs at the end of physicsStep.
  probeContact(): void {
    if (!this.armed || !this.world) return;
    const from = this.globalPosition;
    const shape = this.getShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const probeR = r + 0.5 * PX;
    for (const body of this.world.intersectCircle(from, probeR)) {
      if (body === this || body.name === "Player") continue;
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
