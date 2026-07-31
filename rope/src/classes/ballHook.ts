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
  RigidBody2D,
  StaticBody2D,
  type CollisionShape2D,
  type PhysicsBody2D,
} from "../engine/body";
import { PX } from "../engine/units";
import {
  circleShape,
  nearestShapeIndex,
  nearestSurfacePoint,
} from "../engine/shapes";
import { bodySweepCircle, circleOverlap } from "../engine/collision";
import { CONTACT_SLOP } from "../engine/world";
import { Density, ShapeGeometry } from "../lib/shapeGeometry";
import { Vec2 } from "../engine/vec2";

export class BallHook extends RigidBody2D {
  // Speed below which a contact is too slow to bother rescaling — the direction
  // of a near-zero velocity is numerical noise, so the glancing factor below
  // would be meaningless.
  private static readonly BOUNCE_MIN_SPEED = 1e-6;

  private attachmentCallbacks: Array<(body: PhysicsBody2D, point: Vec2) => void> = [];
  private armed = true;
  // Still in the straight-line throw, as opposed to the dangling chain tip a
  // hook becomes once the deploy ends. Only the throw gets the blocking-contact
  // backstop below; see `attachToBlockingContact`.
  private flying = true;

  constructor() {
    super();
    this.name = "BallHook";
    this.setShape(circleShape(2 * PX));
    // Steel, like the chain it ends: a 4 cm head is ~0.26 kg, a two-hundredth
    // of the cast-iron ball throwing it. That ratio is what makes the throw a
    // throw - the hook is what the ball flicks out and reels back, not a second
    // weight the chain has to swing.
    this.mass = ShapeGeometry.computeMass(this.primaryShape(), Density.STEEL);
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
    this.flying = false;
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
  // The sweep reaches `CONTACT_SLOP` PAST the end of the step, because that is
  // how far World.integrate reaches: its constraint gather keeps speculative
  // contacts out to that band and kills the approach velocity of anything that
  // would close the gap this step, whether or not the two ever overlap. A hook
  // stopping short of a surface by less than a centimetre therefore never gets
  // a second frame in which to touch it — the solver has already turned the
  // shot into a slide along the face. In `session-593f` the hook fell 200 mm in
  // one step at a plank 193.7 mm away: the sweep wanted t=1.033, returned null,
  // and the solver converted 12 m/s of approach into 4 m/s of tangential skate
  // that carried the hook off the plank's corner over the next twelve frames.
  // Reaching one band further makes the hook win every race the solver would
  // otherwise decide. The extra reach costs no accuracy: the anchor is still
  // placed on the swept contact point, which is on the surface.
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
    if (this.attachToBlockingContact()) return;
    const from = this.globalPosition;
    const shape = this.primaryShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const step = this.linearVelocity.mul(dt);
    const speed = step.length();
    const motion = speed > 0 ? step.mul(1 + CONTACT_SLOP / speed) : step;

    let best: { t: number; normal: Vec2; collider: PhysicsBody2D; shape: CollisionShape2D } | null =
      null;
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
        best = { t: sweep.t, normal: sweep.normal, collider: body, shape: sweep.shape };
      }
    }
    if (best) {
      const contactCenter = from.add(motion.mul(best.t));
      // The piece the sweep struck answers, not the body: a compound wall may
      // be hook-proof on the face the throw came in at and attachable one piece
      // along, which is the whole point of the flag being per shape.
      if (best.shape.impermeable) {
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

  // The backstop, and the only *exact* half of the attach test: if the solver
  // has already blocked the hook against an attachable body, anchor there.
  //
  // The sweep above predicts contact; this reads what actually happened. They
  // disagree because they measure different things. The solver's speculative
  // contacts are a **perpendicular** band — separation along the contact normal,
  // closed at the normal component of the approach — while a sweep measures
  // **along the path**. On an oblique approach the path to contact is longer
  // than the perpendicular gap by 1/cos of the angle between them, so a reach
  // of one `CONTACT_SLOP` along the path under-covers a band of one
  // `CONTACT_SLOP` across it, and the shortfall grows with the obliquity. The
  // solver is also blind to the contact point sliding off the feature within
  // the step, so it blocks against a corner's face plane on paths that clear
  // the corner. `session-1154f` is 4 mm of exactly that: a throw at the swinging
  // end of a hanging plank, blocked on the end face's plane by an impulse of
  // 2.9 N·s, deflected from 12 m/s to 4.9 and 45° off aim, while every
  // predictive test said no contact.
  //
  // Rather than grow a second, ever-more-elaborate copy of the solver's
  // predicate, ask the solver. `World.frameContacts` is kept for exactly this
  // ("a caller that wants to know what a body touched this frame asks here
  // rather than re-deriving contacts it would then have to keep in step"), and
  // `normalImpulse > 0` means it really pushed back — speculative contacts that
  // asked for nothing carry zero and are skipped, so a hook coasting parallel to
  // a wall a few millimetres clear does not anchor to it.
  //
  // It reads the PREVIOUS frame's set: physicsStep runs before integrate, so
  // the deflection is one frame old by the time it is visible here. That is why
  // the sweep exists and runs first — it catches the head-on case on the right
  // frame, with the shot's own velocity intact. This catches the rest, one frame
  // late but on the right surface: the anchor is placed on the contact's own
  // shape, not on wherever the deflection has since carried the hook.
  //
  // Impermeable pieces are left to `bounce`: the solver's deflection is not the
  // glancing-speed rule that surface is defined by, and re-deriving one from the
  // other would be two bounces.
  //
  // It rescues a THROW and nothing else, because a blocking contact is only
  // evidence of a missed attach while the hook is still flying at something. A
  // dangling tip is the other case, and there the same reading is harmful: it
  // hangs at exactly `CHAIN_MAX_LENGTH`, so anchoring on a contact the solver
  // reports while the hook is still millimetres clear buys the chain that much
  // extra path, and the chain going from taut to slack in one frame drops the
  // ball it had been braking - a 0.7 m/s gain on the anchoring frame, which is
  // `rope-anchor-kick` (`session-576f` f60). A tip drifts into its surface
  // slowly and `probeContact` catches it on real contact, which is what keeps
  // the anchored length honest; nothing is missed by leaving it to that.
  private attachToBlockingContact(): boolean {
    if (!this.world || !this.flying) return false;
    for (const c of this.world.frameContacts) {
      if (c.normalImpulse <= 0) continue;
      const other = c.a === this ? c.b : c.b === this ? c.a : null;
      if (!other || other.removed || this.exceptions.has(other.id)) continue;
      if (
        !(
          other instanceof StaticBody2D ||
          other instanceof RigidBody2D ||
          other instanceof AnchorBody
        )
      ) {
        continue;
      }
      // The constraint names the piece it formed on, so a compound body anchors
      // on the shape actually struck rather than on whichever is nearest now.
      //
      // Projected from the hook's CENTRE, not from `c.point`: a manifold point
      // for a circle sits on the circle's own rim, so projecting it onto the
      // surface lands up to a diameter to the side of the hook. On a chain
      // already at full length that reads as path appearing from nowhere - the
      // anchor came out 28 mm from a hook of radius 20, the taut chain went
      // slack by 19 mm in one frame, and the ball it had been braking took off
      // (`session-576f` fails `rope-anchor-kick` on it).
      const s = other.getShapes()[c.a === this ? c.shapeB : c.shapeA];
      // Hook-proof pieces are left to `bounce` (see above), and the constraint
      // names the piece, so a wall that is hook-proof on one face and
      // attachable on another is answered per face here too.
      if (s?.impermeable) continue;
      this.attach(other, s ? nearestSurfacePoint(s, this.globalPosition) : c.point);
      return true;
    }
    return false;
  }

  // Radius-aware overlap probe for slow / resting contact the sweep (which needs
  // motion) doesn't cover: attach to a static/rigid surface, bounce off a
  // hook-proof one. Runs at the end of physicsStep.
  //
  // Its margin stays a touch tolerance and is deliberately NOT widened to the
  // solver's `CONTACT_SLOP` the way the sweep's reach is. The sweep extrapolates
  // along a known direction of travel and anchors at the swept contact point, so
  // reaching a band further still lands the anchor on the surface; the probe has
  // no direction and would simply anchor to whatever is within a centimetre —
  // floating the anchor off the geometry (session-601f) and lengthening the
  // chain's path enough to kick the ball as it anchors. A near-stationary hook
  // needs no help from it anyway: the sweep's reach never falls below
  // `CONTACT_SLOP` however slow the hook is.
  probeContact(): void {
    if (!this.armed || !this.world) return;
    const from = this.globalPosition;
    const shape = this.primaryShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const probeR = r + 0.5 * PX;
    for (const body of this.world.intersectCircle(from, probeR)) {
      if (body === this || body.name === "Player") continue;
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
      // Whichever piece is nearest is the one the tip is resting on, and it is
      // that piece that decides: hook-proof deflects, anything else anchors.
      // Asked of the body instead, one hook-proof face would make a whole
      // compound wall unattachable.
      if (s?.impermeable) {
        const ov = circleOverlap(from, probeR, s);
        if (ov) this.bounce(ov.normal, from.add(ov.normal.mul(ov.depth)));
        return;
      }
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
