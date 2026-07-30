// BallHook - the ball & chain controller's chain-end projectile. It is a
// RigidBody2D, but it flies in a straight line: gravity is switched off for
// the deploy (`gravityScale = 0`) and switched back on the moment the throw
// ends, so the shot goes exactly where it was aimed and only then starts to
// fall. Anything that stops the flight counts: the hook contacting a surface
// (attach, or a bounce off an impermeable), the chain snagging scene geometry,
// or the chain running out of length - the last two are BallPlayer's calls,
// which is why `endFlight` is public.
//
// It attaches to the first surface it contacts - during flight or later while
// dangling at full chain length - via a swept ray for fast motion plus an
// overlap probe for slow/resting contact. "Surface" includes hook-only
// `AnchorBody` scenery, which nothing else in the sim collides with.

import {
  AnchorBody,
  ImpermeableBody,
  RigidBody2D,
  StaticBody2D,
  type PhysicsBody2D,
} from "../engine/body";
import { PX } from "../engine/units";
import {
  circleShape,
  nearestShapeIndex,
  nearestSurfacePoint,
} from "../engine/shapes";
import { bodyOverlapCircle, bodySweepCircle } from "../engine/collision";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { Vec2 } from "../engine/vec2";

export class BallHook extends RigidBody2D {
  // Speed below which a contact is too slow to bother rescaling — the direction
  // of a near-zero velocity is numerical noise, so the glancing factor below
  // would be meaningless.
  private static readonly BOUNCE_MIN_SPEED = 1e-6;

  private attachmentCallbacks: Array<(body: PhysicsBody2D, point: Vec2) => void> = [];
  private armed = true;

  constructor() {
    super();
    this.name = "BallHook";
    this.setShape(circleShape(2 * PX));
    this.mass = ShapeGeometry.computeMass(this.primaryShape());
    this.inertia = ShapeGeometry.computeMomentOfInertia(this.primaryShape(), this.mass);
    // Impermeable (hook-proof) surfaces are bounced off rather than anchored to.
    // Very low restitution: the hook barely rebounds — mostly deflects and drops.
    this.restitution = 0.0375;
    // The deploy is a straight line: no gravity until the throw ends (see the
    // file header). `endFlight` restores it.
    this.gravityScale = 0;
  }

  // The throw is over — the hook falls from here on. Idempotent, and safe to
  // call for any of the endings: attach, bounce, snag, out of length.
  endFlight(): void {
    this.gravityScale = 1;
  }

  registerAttachmentCallback(onAttach: (body: PhysicsBody2D, point: Vec2) => void): void {
    this.attachmentCallbacks.push(onAttach);
  }

  private attach(body: PhysicsBody2D, point: Vec2): void {
    this.armed = false;
    this.endFlight();
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
  //
  // Swept against every shape a body carries, not its primary. A compound body
  // is one body with several convex pieces, and testing only the first left the
  // sweep blind to the rest: a hook thrown at the rotated slab of a three-piece
  // wall flew through it as if it were not there, and only the overlap probe
  // below - which is a whole frame later, and stops at the hook's centre rather
  // than on the surface - ever caught it, so the chain ended up anchored 2 cm
  // off the corner it was aimed at (`session-306f`).
  physicsStep(dt: number): void {
    if (!this.armed || !this.world) return;
    const from = this.globalPosition;
    const shape = this.primaryShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const motion = this.linearVelocity.mul(dt);

    let best: { t: number; normal: Vec2; collider: PhysicsBody2D } | null = null;
    for (const body of this.world.bodies) {
      if (body.removed || body === this || body.name === "Player") continue;
      if (this.exceptions.has(body.id)) continue;
      // AnchorBody is not solid — nothing else in the sim collides with it —
      // but the hook is what it exists for, so it is named explicitly here.
      if (
        !(body instanceof StaticBody2D || body instanceof RigidBody2D || body instanceof AnchorBody)
      ) {
        continue;
      }
      if (!body.hasShape()) continue;
      const sweep = bodySweepCircle(body, from, motion, r);
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
    const shape = this.primaryShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const probeR = r + 0.5 * PX;
    for (const body of this.world.intersectCircle(from, probeR)) {
      if (body === this || body.name === "Player") continue;
      if (body instanceof ImpermeableBody) {
        const ov = bodyOverlapCircle(body, from, probeR);
        if (ov) this.bounce(ov.normal, from.add(ov.normal.mul(ov.depth)));
        return;
      }
      if (
        !(body instanceof StaticBody2D || body instanceof RigidBody2D || body instanceof AnchorBody)
      ) {
        continue;
      }
      // Anchor ON the surface, exactly as the swept path does, rather than at
      // the hook's own centre: the probe fires while the hook is up to its own
      // radius plus the probe margin clear of the geometry, and anchoring at the
      // centre leaves the chain visibly ending short of the corner it caught and
      // the contact's `shapeIndex` resolved from a point that is on nothing.
      const shapes = body.getShapes();
      const s = shapes[nearestShapeIndex(shapes, from)];
      this.attach(body, s ? nearestSurfacePoint(s, from) : from);
      return;
    }
  }

  // Deflect off a hook-proof surface and seat the hook at `seatPos` so the
  // following World.integrate step carries it away rather than back into the
  // wall. The deploy is NOT stopped: the hook stays armed and keeps flying, so
  // a chain can be skipped along a hook-proof wall into whatever lies past it.
  // It has collided, though, so the straight-line phase is over and the
  // deflected remainder of the throw arcs under gravity.
  //
  // How much speed survives is |n × d| — the sine of the angle between the
  // surface normal and the hook's travel direction, i.e. how glancing the hit
  // was. A shot straight into the wall (d antiparallel to n) has a zero cross
  // product and is killed dead; a shot skimming along it (d perpendicular to n)
  // has |n × d| = 1 and passes through untouched, with everything in between
  // scaling smoothly. The reflection about the normal happens first, so the
  // surviving speed points away from the wall.
  private bounce(normal: Vec2, seatPos: Vec2): void {
    this.endFlight();
    const speed = this.linearVelocity.length();
    const vn = this.linearVelocity.dot(normal);
    if (vn < 0 && speed > BallHook.BOUNCE_MIN_SPEED) {
      const glance = Math.abs(normal.cross(this.linearVelocity.mul(1 / speed)));
      const reflected = this.linearVelocity.sub(normal.mul((1 + this.restitution) * vn));
      this.linearVelocity = reflected.mul(glance);
    }
    this.globalPosition = seatPos;
  }
}
