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
import { circleShape, nearestSurfacePoint, shapeWorldVertices, type ShapeTransform } from "../engine/shapes";
import { bodySweepConvex } from "../engine/collision";
import { shapeContacts } from "../engine/manifold";
import { CONTACT_SLOP } from "../engine/world";
import { Density, ShapeGeometry } from "../lib/shapeGeometry";
import { Vec2 } from "../engine/vec2";
import { MANACLE_HINGE_LOCAL, MANACLE_REACH, manacleShape } from "../lib/manacle";

// What the swept cuff met along a path: how far along it (`t`, in units of the
// swept motion), the piece struck, the contact normal there and the point the
// two touched at.
type SweepHit = {
  t: number;
  normal: Vec2;
  point: Vec2;
  collider: PhysicsBody2D;
  shape: CollisionShape2D;
};

export class BallHook extends RigidBody2D {
  // Speed below which a contact is too slow to bother rescaling — the direction
  // of a near-zero velocity is numerical noise, so the glancing factor below
  // would be meaningless.
  private static readonly BOUNCE_MIN_SPEED = 1e-6;
  // Below this the probe leaves a hook-proof contact to the contact solver
  // instead of deflecting it — the resting-tip case; see probeContact. Above
  // the fastest resting hover (gravity's own 0.16 m/s step) and well under
  // the slowest recorded drag the spark stream depends on.
  private static readonly PROBE_DEFLECT_MIN_SPEED = 0.5;
  // The probe's touch tolerance: how far off a surface a resting tip may be
  // and still count as on it. Deliberately NOT the solver's `CONTACT_SLOP`;
  // see `probeContact`.
  private static readonly PROBE_MARGIN = 0.5 * PX;

  private attachmentCallbacks: Array<
    (body: PhysicsBody2D, point: Vec2, piece: CollisionShape2D | null) => void
  > = [];
  private chainOutCallbacks: Array<() => void> = [];
  private bounceCallbacks: Array<
    (point: Vec2, normal: Vec2, vel: Vec2, fromFlight: boolean) => void
  > = [];
  // While the chain is still paying out, its owner budgets the flight: the
  // wrapped path's last fixed point and how much straight span is left between
  // it and the HINGE before the path reaches the chain's absolute length
  // (`allowance`). Null once nothing constrains the flight any more (chain
  // gone, or the hook already converted to the dangling tip). See the chain-out
  // cap in `physicsStep`.
  deployLimit: (() => { prev: Vec2; allowance: number } | null) | null = null;
  // Which way the cuff should face - from its centre back along the chain it
  // hangs from - or null when there is nothing to face (no chain, or a chain
  // too short to have a direction). Set by the owner; read every step by
  // `alignToChain`, which is the only thing that turns this body.
  facing: (() => Vec2 | null) | null = null;
  private armed = true;
  // Still in the straight-line throw, as opposed to the dangling chain tip a
  // hook becomes once the deploy ends. Only the throw gets the blocking-contact
  // backstop below; see `attachToBlockingContact`.
  private flying = true;

  constructor() {
    super();
    this.name = "BallHook";
    // The manacle itself: the ring seen edge-on, a bar as long as the ring is
    // wide and as thick as its lock housing (`lib/manacle`), so the shape the
    // sim rests, bounces and anchors is the shape that is drawn. It used to
    // collide as a 3 cm circle under a 13 cm drawn cuff, and every millimetre
    // of difference had to be papered over in the renderers - the cuff sank
    // into whatever the tip was lying on, and the clearance had to be worked
    // out from the resting surface's normal to hide it.
    //
    // +x is the hinge end, where the chain is shackled; -x the mouth, which
    // leads the throw and bites.
    this.setShape(manacleShape());
    // Solid, but not rope geometry - the same opt-out the ball's mounting loop
    // takes. The chain ENDS on this cuff, so a span reaching it is inside it by
    // construction, and the wrap machinery reads that as the chain having caught
    // on the scene: every throw ended on the frame it was fired. It cost nothing
    // while the chain end was a circle a chain-width wide.
    this.primaryShape().wrappable = false;
    // The cuff's rotation is DRIVEN, not integrated: every step turns it to
    // face back along the chain (`alignToChain`), the way a shackle on the end
    // of a chain trails the chain, so the drawn cuff, the bar the sim collides
    // and the hinge the chain is measured to cannot come apart. Told to the
    // contact solver and the rope solver in the vocabulary they already have
    // for the steered ball - infinite rotational inertia, no torque arm - so
    // neither spends an impulse on a spin the next step overwrites.
    this.kinematicRotation = true;
    // Steel, like the chain it ends: a 4 cm head is ~0.26 kg, a two-hundredth
    // of the cast-iron ball throwing it. That ratio is what makes the throw a
    // throw - the hook is what the ball flicks out and reels back, not a second
    // weight the chain has to swing.
    //
    // Weighed as that head and not as the disc it collides as: a cuff is a ring
    // of bar stock, mostly air, and a solid 15 cm steel disc would be 5 kg -
    // twenty times the hook, and a wrecking ball on the end of its own chain.
    this.mass = ShapeGeometry.computeMass(
      { globalPosition: Vec2.ZERO, globalRotation: 0, shape: circleShape(2 * PX) },
      Density.STEEL,
    );
    // The bar's own second moment. Nothing solves against it - the rotation is
    // driven (above) - but it is what the energy bookkeeping reads, and a real
    // figure keeps that honest.
    this.inertia = ShapeGeometry.computeMomentOfInertia(this.primaryShape(), this.mass);
    // Impermeable (hook-proof) surfaces are bounced off rather than anchored to.
    // Very low restitution: the hook barely rebounds — mostly deflects and drops.
    this.restitution = 0.0375;
    // Steel on steel, so a hook that lands on a hook-proof surface and stays
    // there behaves like a lump of steel rather than a puck on ice: without
    // these the only thing resisting a resting tip's slide was `contactDamp`'s
    // exponential coast, which never grips, so the tip crept indefinitely
    // across the shallowest of slopes. Real coefficients, not the ball's
    // drive-mechanic 3.8: kinetic 0.55 decelerates a slide on anything up to
    // atan(0.55) ≈ 29°, and static 0.6 puts the breakaway at atan(0.6) ≈ 31° —
    // the tip rests on a moderate incline and still slides off a steep one.
    this.contactFriction = 0.55;
    this.staticFriction = 0.6;
    // The deploy is a straight line: no gravity until the throw ends (see the
    // file header). `endFlight` restores it.
    this.gravityScale = 0;
    // A 2 cm bar at up to 12 m/s crosses ten of its own thicknesses in a step:
    // the discrete integrate step is how it ended up inside a compound floor,
    // riding the seam between two convex pieces (session-1085f). The swept
    // attach check above integrate is a gameplay decision, not a collision
    // guarantee - it ends when the throw does, and a bounced or dangling hook
    // still moves through World.integrate.
    this.continuous = true;
  }

  // The hinge pin - where the chain is shackled and where its end node sits -
  // as an offset from the cuff's centre in the world, and as a point.
  hingeOffset(): Vec2 {
    return MANACLE_HINGE_LOCAL.rotated(this.globalRotation);
  }

  get hinge(): Vec2 {
    return this.globalPosition.add(this.hingeOffset());
  }

  // The bar the cuff collides as, in the world, with its centre at `at` and its
  // present rotation.
  private loopAt(at: Vec2): Vec2[] {
    const bs = this.primaryShape();
    return shapeWorldVertices({ globalPosition: at, globalRotation: bs.globalRotation, shape: bs.shape });
  }

  // Turn the cuff to face back along the chain (see `facing`), about its own
  // centre. Every step, armed or not, before anything measures or sweeps it:
  // the hinge the chain is budgeted to and the bar the sweep flies both follow
  // from the rotation, so it has to be settled first. The angular velocity is
  // held at zero so integration adds nothing to what was set here.
  private alignToChain(): void {
    const dir = this.facing?.() ?? null;
    if (dir !== null && (dir.x !== 0 || dir.y !== 0)) this.globalRotation = dir.angle();
    this.angularVelocity = 0;
  }

  // A weight on the end of the chain and nothing more: it no longer anchors to
  // what it touches. What a ring that has run off the open end of a rail comes
  // back as (see `BallPlayer.dropFromRail`), until it is thrown again.
  disarm(): void {
    this.armed = false;
  }

  // The throw is over — the hook falls from here on. Idempotent, and safe to
  // call for any of the endings: attach, bounce, snag, out of length.
  endFlight(): void {
    this.gravityScale = 1;
    this.flying = false;
  }

  // `piece` is the shape the hook actually reached - every attach path here
  // knows it (the sweep's hit, the blocking contact's constraint, the probe's
  // nearest piece) - so the owner decides by that piece rather than by
  // re-deriving one from the point: at the joint between a rail and the lid
  // it meets, the nearest surface to the bite can be either, and which the
  // hook is on is the difference between clamping around a bar and biting a
  // face. Null only where a path had no piece to name.
  registerAttachmentCallback(
    onAttach: (body: PhysicsBody2D, point: Vec2, piece: CollisionShape2D | null) => void,
  ): void {
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

  private attach(body: PhysicsBody2D, point: Vec2, piece: CollisionShape2D | null): void {
    this.armed = false;
    this.endFlight();
    for (const cb of this.attachmentCallbacks) cb(body, point, piece);
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
    this.alignToChain();
    if (!this.armed || !this.world) return;
    if (this.attachToBlockingContact()) return;
    const from = this.globalPosition;
    const hinge = this.hinge;
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
    // fixed point of the wrapped path, measured to the HINGE - the chain's end
    // node, where the links are shackled - and it cuts a bite and a bounce
    // alike: a surface past the chain-out point might as well not exist, for
    // either. That is the session-339f rule, and it is also all the reach a
    // bite is allowed, because the cuff's own body is the forgiveness. The
    // mouth leads the throw a whole `MANACLE_MOUTH` ahead of the pin the chain
    // is budgeted to, so a face the mouth can touch with the pin at full
    // stretch is bitten - a throw whose target sits a hand's breadth past full
    // stretch still sticks rather than stopping dead just short of the ceiling
    // it was aimed at (a falling thrower widens the span mid-flight, which is
    // exactly `playtests/ball-hang-at-rest.json`) - and a face the mouth cannot
    // reach is not, however the frames happen to fall. The cuff the player is
    // shown on the end of the chain is the reach the player gets, no more.
    //
    // Nothing within reach: the hook is seated with its hinge at the exact
    // chain-out point and handed to its owner to become the dangling tip,
    // radial jerk and all, before integration can move it anywhere the chain
    // forbids.
    const limit = this.deployLimit?.() ?? null;
    const chainOutT = limit ? BallHook.chainOutTime(hinge, step, limit.prev, limit.allowance) : Infinity;
    const motionScale = speed > 0 ? 1 + CONTACT_SLOP / speed : 1;
    const motion = step.mul(motionScale);

    // Swept to the solver's reach, so a piece the chain forbids but the solver
    // would act on next frame is at least SEEN (see `convertAtChainOut`); only
    // what the chain lets the cuff reach then counts.
    const { anchor, proof } = this.sweepPath(from, motion);
    const inReach = (hit: SweepHit | null): SweepHit | null =>
      hit !== null && hit.t * motionScale <= chainOutT ? hit : null;
    const bite = inReach(anchor);
    const off = inReach(proof);
    // Reached first decides, and an attach takes the tie.
    if (bite && (!off || bite.t <= off.t)) {
      this.anchorTo(from, bite);
      return;
    }
    // A bounce only inside the chain's true reach (see the cap above): a
    // hook-proof surface past the chain-out point is never touched. A proof
    // piece standing between the cuff and an attachable surface further along
    // blocks that attach without bouncing if the chain runs out first — it is
    // the chain and not the surface that ends the flight.
    if (off) {
      this.bounce(off.normal, from.add(motion.mul(off.t)));
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
    // length. The reach extends past the step only when a piece is actually
    // ahead (a hit past the chain's reach, of either kind): that is the one
    // case the next frame's integrate can end the throw the solver's way
    // instead - and, for an attachable piece, the one case the blocking-contact
    // backstop would then anchor a throw to a face the chain never let it
    // reach. With nothing ahead, waiting the fraction of a frame is free.
    if (this.convertAtChainOut(dt, proof !== null || anchor !== null)) return;
    this.probeContact();
  }

  // Sweep the cuff's bar along `motion` and report the nearest attachable
  // piece and the nearest hook-proof one. Two separate questions, for the
  // reason the header gives: a bounce is "nothing happened, keep going" and an
  // attach is the throw being over, so a single earliest-hit scan would let
  // build order decide both. The caller ranks them.
  private sweepPath(from: Vec2, motion: Vec2): { anchor: SweepHit | null; proof: SweepHit | null } {
    let anchor: SweepHit | null = null;
    let proof: SweepHit | null = null;
    if (!this.world) return { anchor, proof };
    const bar = this.loopAt(from);
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
      const hit = bodySweepConvex(body, bar, motion, (s) => !s.impermeable);
      if (hit && hit.t <= 1 && (!anchor || hit.t < anchor.t)) {
        anchor = { t: hit.t, normal: hit.normal, point: hit.point, collider: body, shape: hit.shape };
      }
      const off = bodySweepConvex(body, bar, motion, (s) => s.impermeable === true);
      if (off && off.t <= 1 && (!proof || off.t < proof.t)) {
        proof = { t: off.t, normal: off.normal, point: off.point, collider: body, shape: off.shape };
      }
    }
    return { anchor, proof };
  }

  // Does the bar, centred at `at` with its present rotation, stand inside
  // `piece` - genuinely overlapping it, not merely touching?
  private overlaps(at: Vec2, piece: CollisionShape2D): boolean {
    const bs = this.primaryShape();
    const bar: ShapeTransform = { globalPosition: at, globalRotation: bs.globalRotation, shape: bs.shape };
    return shapeContacts(bar, piece).length > 0;
  }

  // Anchor on the surface itself, where the bar touched it: the sweep's own
  // contact point - the mouth's corner meeting a face, or a corner of the
  // piece meeting the bar's side - projected onto the piece, which for a
  // point already on it is the point.
  //
  // A sweep that BEGINS inside the piece returns t = 0 with the bar's deepest
  // corner for a point (see "rest resolution when a sweep starts embedded"),
  // and that corner is inside the geometry. There the surface answers for the
  // cuff's centre instead, exactly as `probeContact` has it answer for the
  // same reason: `session-596f` was the disc's version of this, an anchor
  // placed a radius INTO the pillar along a normal that meant nothing, which
  // the chain then ran through.
  private anchorTo(from: Vec2, hit: SweepHit): void {
    const at = this.overlaps(from, hit.shape) ? from : hit.point;
    this.attach(hit.collider, nearestSurfacePoint(hit.shape, at), hit.shape);
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
  // It is NOT extended without a threat, so a conversion is never made a
  // fraction of a frame early where the alternative is the solver deciding the
  // throw.
  //
  // There is no forgiveness band swept here any more. There used to be one -
  // an attach was budgeted a hook radius further than the flight, and because
  // `CHAIN_MAX_LENGTH / (HOOK_SPEED * dt)` = 1.8 / 0.2 is exactly 9, every
  // straight throw from a stationary player arrived at chain-out on a frame
  // boundary and a few ULP decided whether a throw got that band at all
  // (`session-1017f`: 17 throws at one target, 8 stuck, 9 dangled) - so the
  // band was swept from the chain-out point as a second sweep. The cuff's own
  // body is now the whole of the forgiveness (see `physicsStep`): the mouth
  // rides `MANACLE_MOUTH` ahead of the hinge the chain is measured to, inside
  // the one sweep, on every frame alike, so there is no band to sweep and no
  // tie for the frame boundary to decide.
  private convertAtChainOut(dt: number, threatAhead: boolean): boolean {
    const limit = this.deployLimit?.() ?? null;
    if (!limit) return false;
    const step = this.linearVelocity.mul(dt);
    const t = BallHook.chainOutTime(this.hinge, step, limit.prev, limit.allowance);
    const speed = step.length();
    const reach = threatAhead && speed > 0 ? 1 + CONTACT_SLOP / speed : 1;
    if (t > reach) return false;
    this.globalPosition = this.globalPosition.add(step.mul(t));
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
  static chainOutTime(from: Vec2, step: Vec2, prev: Vec2, allowance: number): number {
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
      // The manifold's own point, projected onto the piece: for a bar that is
      // the corner of the bar that met the face, or the corner of the piece
      // that met the bar's side, so the projection lands on the surface where
      // the two actually touched. (For the disc this used to be, a manifold
      // point sat on the rim up to a diameter to the side of the hook and had
      // to be projected from the centre instead - `session-576f` was 19 mm of
      // path appearing from nowhere on a taut chain.)
      const s = other.getShapes()[c.a === this ? c.shapeB : c.shapeA];
      // Hook-proof pieces are left to `bounce` (see above), and the constraint
      // names the piece, so a wall that is hook-proof on one face and
      // attachable on another is answered per face here too.
      if (s?.impermeable) continue;
      this.attach(other, s ? nearestSurfacePoint(s, c.point) : c.point, s ?? null);
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
    const speed = this.linearVelocity.length();
    const margin = BallHook.PROBE_MARGIN;
    const bar = this.primaryShape();
    let proof: { normal: Vec2; depth: number } | null = null;
    // Candidates by the cuff's bounding circle; what decides is the bar.
    for (const body of this.world.intersectCircle(from, MANACLE_REACH + margin)) {
      if (body === this || body.name === "Player") continue;
      if (!(body instanceof StaticBody2D || body instanceof RigidBody2D)) continue;
      // The piece the bar stands deepest in is the one the tip is resting on,
      // and it is that piece that decides: hook-proof deflects, anything else
      // anchors. Asked of the body instead, one hook-proof face would make a
      // whole compound wall unattachable.
      let deepest: { shape: CollisionShape2D; normal: Vec2; depth: number; point: Vec2 } | null = null;
      for (const s of body.getShapes()) {
        for (const c of shapeContacts(bar, s, margin)) {
          if (!deepest || c.depth > deepest.depth) {
            deepest = { shape: s, normal: c.normal, depth: c.depth, point: c.point };
          }
        }
      }
      if (!deepest) continue;
      if (deepest.shape.impermeable) {
        // Remember the deepest hook-proof surface and keep looking: it only
        // deflects if nothing here anchors.
        if (!proof || deepest.depth > proof.depth) proof = deepest;
        continue;
      }
      // Anchor ON the surface, exactly as the swept path does, at the point
      // the bar is touching it, rather than at the hook's own centre: the probe
      // fires while the bar is up to the probe margin clear of the geometry,
      // and anchoring at the centre leaves the chain visibly ending short of
      // the corner it caught and the contact's `shapeIndex` resolved from a
      // point that is on nothing.
      this.attach(body, nearestSurfacePoint(deepest.shape, deepest.point), deepest.shape);
      return;
    }
    // Deflect only a hook genuinely MOVING: the probe's seat holds the hook a
    // probe margin clear of the surface, so a resting tip deflected every
    // frame hovers just outside the solver's reach for ever — no loaded
    // contact, no normal impulse, and therefore no friction cone however real
    // the hook's coefficients are. It slid down the shallowest hook-proof
    // slope like a puck on ice, with `contactFriction` powerless to stop it.
    // Below this speed the tip is left to the contact solver, which holds it
    // ON the surface with a real normal load — friction and stiction included
    // (see the coefficients in the constructor). Above it the deflection is
    // the mechanic: a skipping or dragged hook keeps its bounce, and with it
    // the spark reports the drag stream is made of (well over this speed in
    // every recorded drag).
    // A manifold depth is measured from touching (negative inside the margin
    // band), so the seat is a margin clear of the surface, as the probe's own
    // reach is.
    if (proof && speed > BallHook.PROBE_DEFLECT_MIN_SPEED) {
      this.bounce(proof.normal, from.add(proof.normal.mul(proof.depth + margin)));
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
