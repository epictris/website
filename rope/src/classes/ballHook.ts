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
// overlap probe for slow/resting contact. "Surface" includes `passable` scenery,
// which nothing else in the sim collides with.

import {
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
  private chainOutCallbacks: Array<() => void> = [];
  private bounceCallbacks: Array<
    (point: Vec2, normal: Vec2, vel: Vec2, fromFlight: boolean) => void
  > = [];
  // While the chain is still paying out, its owner budgets the flight: the
  // wrapped path's last fixed point, how much straight span is left before the
  // path reaches the chain's absolute length (`allowance`), and how much an
  // ATTACH may still reach past that (`attachAllowance`, the owner's snap
  // tolerance folded in). Null once nothing constrains the flight any more
  // (chain gone, or the hook already converted to the dangling tip). See the
  // chain-out cap in `physicsStep`.
  deployLimit: (() => { prev: Vec2; allowance: number; attachAllowance: number } | null) | null =
    null;
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
    // A 2 cm circle at up to 12 m/s crosses ten of its own diameters in a step:
    // the discrete integrate step is how it ended up inside a compound floor,
    // riding the seam between two convex pieces (session-1085f). The swept
    // attach check above integrate is a gameplay decision, not a collision
    // guarantee - it ends when the throw does, and a bounced or dangling hook
    // still moves through World.integrate.
    this.continuous = true;
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

  // Fired when the flight ends by running out of chain: the hook has been
  // seated at the exact point the wrapped path reaches its length, and the
  // owner converts it into the dangling tip (BallPlayer.deployTip).
  registerChainOutCallback(onChainOut: () => void): void {
    this.chainOutCallbacks.push(onChainOut);
  }

  // Fired on every deflection off a hook-proof surface, with the contact point,
  // the surface normal and the PRE-reflection velocity. Purely an observation:
  // `bounce` computes all three for itself and the callback reads them, so
  // nothing here can steer the sim (see `level/sparkEvents.ts`).
  //
  // `bounce()` is the single funnel for every impermeable contact the hook has
  // - the flight sweep's hook-proof branch and `probeContact`'s deflection both
  // end there - so one callback covers all of them, including the repeated
  // small probe bounces a dangling tip makes while pressed against a wall. Those
  // are the caller's problem to threshold on, not this one's to filter.
  //
  // `fromFlight` says the hook was in FREE FLIGHT when it struck: this touch is
  // the throw ending rather than a deflection off a surface it was already
  // riding. It is not a threshold and says nothing about how hard the hit was -
  // it is there so a caller holding several reports of one touch knows which of
  // them is the ARRIVAL, and therefore which velocity is the one the hook came
  // in at (see `BallLevel.reportSpark`).
  registerBounceCallback(
    onBounce: (point: Vec2, normal: Vec2, vel: Vec2, fromFlight: boolean) => void,
  ): void {
    this.bounceCallbacks.push(onBounce);
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
  //
  // Attachable and hook-proof geometry are swept as two separate questions, and
  // an attach wins a tie. They cannot be one "earliest hit" because the two
  // answers are not comparable outcomes: a bounce is "nothing happened, keep
  // going" and an attach is the throw being over, so a single best-hit scan lets
  // whichever surface happens to sort first decide for both. At a tie there is
  // no geometry to sort by at all - `t` is equal - so the winner was body build
  // order, which is to say the order the level file lists its bodies in.
  // `session-596f` is that: the hook came to rest in the seam where a hook-proof
  // disc meets an attachable pillar, touching both, and bounced off the disc at
  // `t = 0` on every frame for 250 frames while sitting on a surface it should
  // have anchored to on the first. The chain, frozen at its deployed length with
  // its tip held by geometry, fed the winch stall a blocked correction every one
  // of those frames and grew from 64 cm to 3.58 m.
  physicsStep(dt: number): void {
    if (!this.armed || !this.world) return;
    if (this.attachToBlockingContact()) return;
    const from = this.globalPosition;
    const shape = this.primaryShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const step = this.linearVelocity.mul(dt);
    const speed = step.length();

    // Chain-out cap: the flight may not outrun the chain. Uncapped, the hook
    // flies its whole step and the length check runs a phase later
    // (BallPlayer.checkChainReach, after World.integrate), which lets the hook
    // interact with the world from positions the chain could never have let it
    // reach, at a speed the jerk would already have taken. In `session-339f`
    // the chain had 0.27 mm of payout left at the top of the frame — taut 0.1%
    // of the way into the step — and a hook-proof wall stood 86 mm along it:
    // the hook crossed the whole step, bounced off that wall at the full
    // 12 m/s, and only then was pulled back and stripped, which turned a throw
    // the chain should have stopped 86 mm short into a 4.4 m/s sideways whip
    // off a wall it never touched in sub-frame time.
    //
    // Where the chain runs out is a closed-form quadratic against the last
    // fixed point of the wrapped path, and the two outcomes a surface can have
    // are cut at DIFFERENT lengths, because they are different promises:
    //
    // - An ATTACH may land out to `attachAllowance` — the owner's snap
    //   tolerance past the chain's length — and anchors at the length it
    //   actually reached, which is the standing forgiveness rule
    //   (`ATTACH_SNAP_TOLERANCE`): a throw whose target sits a hand's breadth
    //   past full stretch still sticks, rather than stopping dead just short
    //   of the ceiling it was aimed at. A falling thrower widens the span
    //   mid-flight, so cutting attaches at the bare length broke exactly that
    //   throw (`playtests/ball-hang-at-rest.json`).
    // - A BOUNCE is "nothing happened, keep going", and the flight it
    //   continues is one the chain must genuinely permit — so a hook-proof
    //   surface past the chain-out point might as well not exist. That is the
    //   session-339f rule.
    //
    // Nothing within reach: the hook is seated at the exact chain-out point
    // and handed to its owner to become the dangling tip, radial jerk and
    // all, before integration can move it anywhere the chain forbids.
    //
    // A tolerance-capped motion is deliberately NOT extended by the solver's
    // `CONTACT_SLOP` reach (below): a hook the chain stops short of a surface
    // is not racing the solver for it — it ends this frame all but stationary
    // at the chain's end, and the dangling tip's `probeContact` owns whatever
    // contact its swing brings after that.
    const limit = this.deployLimit?.() ?? null;
    const chainOutT = limit ? BallHook.chainOutTime(from, step, limit.prev, limit.allowance) : Infinity;
    const attachOutT = limit
      ? BallHook.chainOutTime(from, step, limit.prev, limit.attachAllowance)
      : Infinity;
    const slopScale = speed > 0 ? 1 + CONTACT_SLOP / speed : 1;
    const motionScale = Math.min(slopScale, attachOutT);
    const motion = step.mul(motionScale);

    type Hit = { t: number; normal: Vec2; collider: PhysicsBody2D; shape: CollisionShape2D };
    let anchor: Hit | null = null;
    let proof: Hit | null = null;
    for (const body of this.world.bodies) {
      if (body.removed || body === this || body.name === "Player") continue;
      if (this.exceptions.has(body.id)) continue;
      // No `isSolid` test: a `passable` body is scenery nothing else in the sim
      // collides with, and the hook is what it exists for.
      if (!(body instanceof StaticBody2D || body instanceof RigidBody2D)) continue;
      if (!body.hasShape()) continue;
      // The piece the sweep struck answers, not the body: a compound wall may
      // be hook-proof on the face the throw came in at and attachable one piece
      // along, which is the whole point of the flag being per shape.
      const hit = bodySweepCircle(body, from, motion, r, (s) => !s.impermeable);
      if (hit && hit.t <= 1 && (!anchor || hit.t < anchor.t)) {
        anchor = { t: hit.t, normal: hit.normal, collider: body, shape: hit.shape };
      }
      const off = bodySweepCircle(body, from, motion, r, (s) => s.impermeable === true);
      if (off && off.t <= 1 && (!proof || off.t < proof.t)) {
        proof = { t: off.t, normal: off.normal, collider: body, shape: off.shape };
      }
    }
    // Reached first decides, and an attach takes the tie.
    if (anchor && (!proof || anchor.t <= proof.t)) {
      const contactCenter = from.add(motion.mul(anchor.t));
      // Anchor on the surface itself: one radius from the contact-frame centre
      // along the (inward) contact normal.
      //
      // That projection is only the surface while the contact-frame centre is
      // genuinely a radius clear of it, which is what a sweep that travels to
      // its contact leaves. A sweep that BEGINS inside the piece returns t = 0
      // (see "rest resolution when a sweep starts embedded"), so the centre is
      // the hook where it stands and stepping a radius further along the inward
      // normal buries the anchor - 2 cm inside the pillar in `session-596f`,
      // which the chain then runs through. There the surface answers for itself,
      // exactly as `probeContact` has it answer for the same reason.
      const point = circleOverlap(from, r, anchor.shape)
        ? nearestSurfacePoint(anchor.shape, from)
        : contactCenter.sub(anchor.normal.mul(r));
      this.attach(anchor.collider, point);
      return;
    }
    // A bounce only inside the chain's true reach (see the cap above): a
    // hook-proof surface past the chain-out point is never touched. A proof
    // piece standing between the chain-out point and an attachable surface in
    // the tolerance band blocks that attach without bouncing — the chain ends
    // the flight first.
    if (proof && proof.t * motionScale <= chainOutT) {
      this.bounce(proof.normal, from.add(motion.mul(proof.t)));
      // A bounce does not end the deploy, and the chain does not stretch for
      // it: the deflected remainder of the frame is flown by World.integrate
      // at the bounced velocity, so the chain-out question has to be asked
      // AGAIN here, of that velocity, before integrate is allowed to fly it.
      // Returning without asking is how `session-2504f` ended: a graze bounce
      // ate the conversion this branch's sibling below would have made
      // (chain-out was 0.999 of the very same step), integrate carried the
      // hook across the chain's end, and the solver's speculative band then
      // deflected it off a piece 6 cm past everything the chain permits —
      // 12 m/s of radial throw handed back as a 6 m/s tangential whip.
      // Extended reach, because a hook that just hit one hook-proof piece is
      // flying at geometry the sweep has not asked about again.
      this.convertAtChainOut(dt, true);
      return;
    }
    // Nothing on the reachable part of the step: if the chain runs out on it,
    // the flight ends here, at the exact point the path reaches the chain's
    // length. The reach extends past the step only when a hook-proof piece
    // is actually ahead (a `proof` hit past the chain's reach): that is the
    // one case the next frame's integrate can end the throw the solver's way
    // instead. With nothing ahead, waiting the fraction of a frame is free —
    // and it is what keeps the snap-tolerance attach alive, since the band
    // sweep that catches an anchor just past full stretch runs on that next
    // frame.
    if (this.convertAtChainOut(dt, proof !== null)) return;
    this.probeContact();
  }

  // End the deploy at the exact point the wrapped path reaches the chain's
  // length, if the step ahead crosses it: seat the hook there and hand it to
  // the owner (BallPlayer.deployTip), which measures the path and strips the
  // radial velocity from the seated position — the jerk happens where and
  // when the chain actually snapped taut, before World.integrate can move
  // the hook anywhere the chain forbids.
  //
  // With `threatAhead`, the reach extends `CONTACT_SLOP` past the end of the
  // step, for exactly the reason the attach sweep's does: that is how far
  // World.integrate reaches. A chain-out a fraction beyond the step leaves
  // the hook flying one more frame, and in that frame the solver's
  // speculative band ends the throw its own way — approach velocity killed
  // against whatever face is within a centimetre, which on an oblique face
  // converts the throw's radial speed into a tangential whip the jerk then
  // faithfully preserves (`session-2504f`). The chain must win every race the
  // solver would otherwise decide, and the extra reach costs no accuracy: the
  // seat point is on the chain-out sphere either way.
  //
  // It is NOT extended without a threat, and that is load-bearing the other
  // way: converting a fraction of a frame early ends a throw whose next-frame
  // band sweep would have anchored it just past full stretch — the
  // snap-tolerance attach — so the extra reach is spent only where the
  // alternative is the solver, never where it is an attach.
  private convertAtChainOut(dt: number, threatAhead: boolean): boolean {
    const limit = this.deployLimit?.() ?? null;
    if (!limit) return false;
    const from = this.globalPosition;
    const step = this.linearVelocity.mul(dt);
    const t = BallHook.chainOutTime(from, step, limit.prev, limit.allowance);
    const speed = step.length();
    const reach = threatAhead && speed > 0 ? 1 + CONTACT_SLOP / speed : 1;
    if (t > reach) return false;
    this.globalPosition = from.add(step.mul(t));
    this.endFlight();
    for (const cb of this.chainOutCallbacks) cb();
    return true;
  }

  // Where along `step` the chain runs out: the smallest t >= 0 at which the
  // final span |from + step·t − prev| reaches `allowance` (what is left of the
  // chain's length once the wrapped path up to `prev` is paid for). 0 when the
  // span is already at or past it; > 1 (no cap) when the whole step stays
  // inside. Closed form, so the cut is exact and deterministic:
  //   |d + s·t|² = a²  with d = from − prev, s = step
  // has one positive root while |d| < a (the constant term is negative).
  private static chainOutTime(from: Vec2, step: Vec2, prev: Vec2, allowance: number): number {
    const d = from.sub(prev);
    const c = d.dot(d) - allowance * allowance;
    if (c >= 0) return 0;
    const a = step.dot(step);
    if (a === 0) return Infinity;
    const b = d.dot(step);
    return (-b + Math.sqrt(b * b - a * c)) / a;
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
      if (!(other instanceof StaticBody2D || other instanceof RigidBody2D)) continue;
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
  //
  // As in the sweep, an attachable surface within reach wins outright over a
  // hook-proof one, and here it does not even need a tie-break to justify it: a
  // probe has no direction of travel, so "which was reached first" has no
  // meaning and every surface in the band was reached at once. A hook-proof
  // surface the tip is also touching does not un-touch the one it caught.
  probeContact(): void {
    if (!this.armed || !this.world) return;
    const from = this.globalPosition;
    const shape = this.primaryShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 2 * PX;
    const probeR = r + 0.5 * PX;
    let proof: { normal: Vec2; depth: number } | null = null;
    for (const body of this.world.intersectCircle(from, probeR)) {
      if (body === this || body.name === "Player") continue;
      if (!(body instanceof StaticBody2D || body instanceof RigidBody2D)) continue;
      // Whichever piece is nearest is the one the tip is resting on, and it is
      // that piece that decides: hook-proof deflects, anything else anchors.
      // Asked of the body instead, one hook-proof face would make a whole
      // compound wall unattachable.
      const shapes = body.getShapes();
      const s = shapes[nearestShapeIndex(shapes, from)];
      if (s?.impermeable) {
        // Remember the deepest hook-proof surface and keep looking: it only
        // deflects if nothing here anchors.
        const ov = circleOverlap(from, probeR, s);
        if (ov && (!proof || ov.depth > proof.depth)) proof = ov;
        continue;
      }
      // Anchor ON the surface, exactly as the swept path does, rather than at
      // the hook's own centre: the probe fires while the hook is up to its own
      // radius plus the probe margin clear of the geometry, and anchoring at the
      // centre leaves the chain visibly ending short of the corner it caught and
      // the contact's `shapeIndex` resolved from a point that is on nothing.
      this.attach(body, s ? nearestSurfacePoint(s, from) : from);
      return;
    }
    if (proof) this.bounce(proof.normal, from.add(proof.normal.mul(proof.depth)));
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
    // Read before `endFlight` clears it: this is the one place that can tell a
    // throw ending on a wall from a deflection off a surface the hook was
    // already riding, and the two want opposite answers about which report of
    // the touch to keep (see `registerBounceCallback`).
    const fromFlight = this.flying;
    this.endFlight();
    const speed = this.linearVelocity.length();
    const vn = this.linearVelocity.dot(normal);
    if (vn < 0 && speed > BallHook.BOUNCE_MIN_SPEED) {
      // Before the reflection: the velocity the hook arrived with is what the
      // hit looked like (see registerBounceCallback).
      for (const cb of this.bounceCallbacks) cb(seatPos, normal, this.linearVelocity, fromFlight);
      const glance = Math.abs(normal.cross(this.linearVelocity.mul(1 / speed)));
      const reflected = this.linearVelocity.sub(normal.mul((1 + this.restitution) * vn));
      this.linearVelocity = reflected.mul(glance);
    }
    this.globalPosition = seatPos;
  }
}
