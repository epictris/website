// BallPlayer — the ball & chain character controller. Unlike Player (a
// CharacterBody2D driven by a state machine), the ball is a plain RigidBody2D:
// gravity, rolling and chain tension are the only things that move it. The
// chain reuses the Rope wrap solver — its start contact is a point on the
// ball's EDGE, stored in the ball's local frame, so it rotates with the ball
// and the chain can wind around the ball itself; chain tension applied at the
// edge torques the ball (the rope solver's lever-arm path, which Player
// deliberately bypasses).

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { wrapAngle } from "../engine/mathf";
import { RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { circleShape, nearestShapeIndex } from "../engine/shapes";
import { contactBounce, CONTACT_SLOP, GRAVITY, type ContactConstraint } from "../engine/world";
import { Density, ShapeGeometry } from "../lib/shapeGeometry";
import { RopeAttachment, RopeContact } from "../lib/ropeContact";
import type { FrameInput } from "../input/frameInput";
import { Rope } from "./rope";
import { SlackChain } from "./slackChain";
import { BallHook } from "./ballHook";

export class BallPlayer extends RigidBody2D {
  // Absolute maximum chain length: pay-out stops here, a hook still flying at
  // this length has missed, and an attachment beyond it snaps the chain.
  static readonly CHAIN_MAX_LENGTH = 1.8;
  // m/s launch speed. The throw is a straight line — the hook carries no
  // gravity until it (or the chain) hits something, or the chain runs out.
  static readonly HOOK_SPEED = 12;
  // Attachments longer than max by more than this snap the chain; within it
  // they clamp to max instead. Must cover the dangling state's solver
  // tolerance (~1 px over) — a deployed tip that finally lands attaches at
  // slightly over max and must NOT snap (found via session-1565f).
  static readonly ATTACH_SNAP_TOLERANCE = 0.2;
  // Proportional gain steering the loop toward the aim direction (1/s).
  // Stable at 1/60 while gain*dt < 1.
  static readonly AIM_TURN_GAIN = 15;
  // Coulomb coefficient for ground contact. Friction that DRIVES the ball
  // (the steered spin gripping the ground) always applies in full, so aiming
  // kicks and crawls the ball at any speed. Friction that would BRAKE the
  // ball fades with speed while aiming: full grip at rest, decaying smoothly
  // as the ball speeds up so it slides once genuinely fast (down a ramp)
  // while still gripping firmly through low/medium speeds.
  static readonly ROLL_FRICTION = 3.8;
  // Static-friction coefficient μ_s → breakaway angle atan(μ_s). 0.58 ≈ 30°:
  // the ball holds on shallow/moderate slopes and only slides once steeper.
  static readonly STATIC_FRICTION = 0.58;
  // The mounting loop's collision radius, and the gap between the ball's rim
  // and the loop ring's centre. Shared by the physics (a second collision
  // circle) and the renderer so the solid loop matches the drawn one.
  static readonly LOOP_RADIUS = 2 * PX;
  static readonly LOOP_GAP = 1.5 * PX;
  // Consecutive frames a loop ride survives with no load-bearing contact against
  // the surface it is riding before it is dropped (see `applyLoopRide`). A ride
  // holds the loop exactly ON the surface, so the contact is there every frame it
  // is genuinely riding; the grace is for solver flicker, not for a ball that has
  // left.
  static readonly RIDE_CONTACT_GRACE = 2;
  // The least share of the ball's weight a surface must carry before the ball
  // will ride its loop over it - half, which is every slope out to 60 degrees
  // and no wall at all. See `restsOn`.
  static readonly RIDE_MIN_SUPPORT = 0.5;
  // How far the mounting loop stands proud of the rim: the ring's centre sits
  // `LOOP_GAP` off the surface and the ring is `LOOP_RADIUS` across, so the
  // assembly is a 35 mm lug on an otherwise circular ball. The height a ride
  // owes back, and the bound on any one frame's instalment.
  static readonly LOOP_EXCESS = BallPlayer.LOOP_GAP + BallPlayer.LOOP_RADIUS;
  // The ball is a solid cast-iron sphere and weighs what one weighs: at the
  // level's 0.12 m radius, ρ·(4/3)πr³ ≈ 52 kg. That number is the feel - a
  // wrecking ball, sluggish under aim-kicks and chain tugs and hard for
  // anything it hits to move - and it is the same number a real one has, so the
  // masses it is compared against (a wooden slab it hauls, its own steel hook)
  // can be judged against reality rather than against it.
  static readonly DENSITY = Density.CAST_IRON;
  // Braking friction follows an exponential falloff in speed:
  //   brake = MIN + (1 - MIN) * exp(-speed / DECAY_SPEED)
  // DECAY_SPEED is the e-folding speed — the higher it is, the longer friction
  // keeps biting before it thins out. A smooth gradient the whole way, with no
  // corner where grip suddenly vanishes (the old linear ramp cliffed to the
  // floor by ~60 px/s, leaving almost no friction at medium speed).
  static readonly AIM_BRAKE_DECAY_SPEED = 1.1; // m/s — brake ≈ 0.6 at 0.6, 0.5 at 0.8
  static readonly AIM_BRAKE_MIN = 0.15; // braking fraction remaining at high speed

  chain: Rope | null = null;
  // Visual drape of the deployed chain while it has slack. Strictly one-way
  // (reads the sim, writes only its own nodes; see SlackChain) — the renderers
  // draw its polyline instead of the chain's straight spans.
  chainSlack: SlackChain | null = null;
  hookInFlight: BallHook | null = null;
  // Free chain end after a miss: the hook disarms in place and lives on as a
  // dangling tip weight — the chain stays deployed at max length until reeled
  // or released.
  chainTip: BallHook | null = null;
  spawnBody: ((body: PhysicsBody2D) => void) | null = null;
  // Scene bodies for the current frame, set by BallLevel before hooks step, so
  // the hook's attach callback can regenerate the chain's wrap path (the hook
  // fires mid-integration, with no bodies list in hand).
  sceneBodies: PhysicsBody2D[] = [];
  // The loop is mounted second, so it is shape 1. Named because a contact's
  // `shapeA` is how the cap tells a loop strike from the ball's own rim.
  static readonly LOOP_SHAPE_INDEX = 1;
  // The surface the ball is currently riding its own mounting loop over, the way
  // that surface faces, the excess the last frame left it standing at, and how
  // many frames it has gone unsupported — see `applyLoopRide`.
  private ride: {
    body: PhysicsBody2D;
    normal: Vec2;
    // The clearance over the rim this ride last placed the ball at, and where it
    // placed it. The pair is what lets the next frame measure how far the ball
    // ACTUALLY moved along the normal since - the solve's push-out and this
    // ride's own tracking velocity included - rather than assume it.
    height: number;
    placedAt: Vec2;
    missing: number;
    // The tracking speed the last frame wrote along the normal, and so the only
    // thing this ride has to give back when it ends. Zero on a frame it wrote
    // nothing, which is every frame of the ascent.
    wrote: number;
  } | null =
    null;
  // What carried the ball last frame. The test that separates a ball ROLLING
  // onto its loop, which may ride, from one LANDING on it, which may not.
  private lastSupport: PhysicsBody2D | null = null;
  // The loop excess the previous frame ended on, so a ride can tell the loop
  // turning INTO a surface from it turning out, before it has a ride to ask.
  private lastExcess = 0;

  constructor(radius = 0.08) {
    super();
    // KillZone reset and the hook's don't-attach-to-the-avatar check both
    // match by name.
    this.name = "Player";
    this.setShape(circleShape(radius));
    // The mounting loop is solid: a second collision circle fixed to the rim,
    // so the ball can rest, tip, and catch edges on the loop as it rotates.
    // (The flying chain hook still ignores it — BallHook skips bodies named
    // "Player".) Mass/inertia stay those of the ball body: the loop is a light
    // steel ring, a collision bump rather than a significant mass.
    const loop = this.addShape(circleShape(BallPlayer.LOOP_RADIUS), this.loopLocalOffset);
    // The chain deploys *through* the loop, so the loop must not also be
    // something the chain wraps: the ball's own winding already accounts for the
    // one piece of geometry the chain is threaded through, and treating the rim
    // ring as a second obstacle would double-count it.
    loop.wrappable = false;
    // Cast iron: heavy, so aim-kicks, chain tugs and collisions move it less
    // (F = ma) — sluggish, momentum-carrying feel. Gravity is
    // acceleration-based, so this does not change fall speed.
    this.mass = ShapeGeometry.computeMass(this.primaryShape(), BallPlayer.DENSITY);
    this.inertia = ShapeGeometry.computeMomentOfInertia(this.primaryShape(), this.mass);
    // Coulomb friction coefficient — ground contact gradually converts slide
    // into roll; capped by normal force, so no wall-climbing traction.
    this.contactFriction = BallPlayer.ROLL_FRICTION;
    // Static friction (stiction): the ball stays put on slopes gentler than the
    // breakaway angle atan(STATIC_FRICTION) and only slides/rolls once past it.
    this.staticFriction = BallPlayer.STATIC_FRICTION;
    // Light damp: rolling resistance comes from the Coulomb model, not the
    // historical 0.98 contact damp.
    this.contactDamp = 0.99;
    // Small bounce on impact — a cast-iron ball is not perfectly dead.
    this.restitution = 0.15;
    // A swung ball crosses more than a radius per step: integrate sweeps its
    // circles against static geometry instead of stepping discretely, so no
    // frame can carry it across a surface (see RigidBody2D.continuous and
    // session-1085f, where the hook made that crossing and lodged in the seam
    // between two convex pieces of a compound floor).
    this.continuous = true;
  }

  get radius(): number {
    const shape = this.primaryShape().shape;
    return shape.kind === "circle" ? shape.radius : 0;
  }

  // Distance from the ball's centre to the loop ring's centre — the arm the
  // loop swings on, and so the radius its tip speed is measured at.
  get loopArm(): number {
    return this.radius + BallPlayer.LOOP_GAP;
  }

  // How far the mounting loop holds the ball's centre off a surface facing
  // `normal`, over and above what the rim alone would — the support function of
  // the ball-and-loop union along `-normal`, less the radius.
  //
  // `normal` points out of the surface toward the ball, so `-loopDir·normal` is 1
  // with the loop pointing straight into it and the excess is the whole
  // `LOOP_GAP + LOOP_RADIUS`, 35 mm at the level's 12 cm ball. It falls to zero at
  // `acos((radius - LOOP_RADIUS) / loopArm)` = 42.21°, so the assembly is a plain
  // circle for 76.6% of a revolution and a lug for the rest.
  //
  // This is the ball's own silhouette and nothing more: the contact solver
  // already puts the ball exactly on it going up (measured against `e(theta)`
  // over `ball-roll-drive` f205..211, agreeing to 0.02 mm), which is why
  // `applyLoopRide` only has to own the way back down.
  loopExcess(normal: Vec2, rotation = this.globalRotation): number {
    const dir = new Vec2(0, -1).rotated(rotation);
    return Math.max(0, this.loopArm * -dir.dot(normal) + BallPlayer.LOOP_RADIUS - this.radius);
  }

  // The loop striking a surface may never launch the ball. Called once per
  // frame, after the contacts and the depenetration sweep, so what it writes is
  // the last word on the frame's velocity — as `applySteeringGrip` is for the
  // roll.
  //
  // The solve's own answer to a loop landing is a launch sized by the loop's
  // rotation phase, and it fires at ANY spin: the loop comes down at omega x r,
  // the ball's spin is kinematic so the impulse cannot be taken out of it, and
  // all of it lands in the ball's linear velocity. The size of it is set by
  // where in its arc the loop happened to be at the instant it touched, which is
  // the one variable the player can neither see nor aim — the same roll into the
  // same floor gave 1.7 m/s at one frame and 4.4 at another (session-1594f).
  //
  // So a frame the loop is in contact on has its outgoing normal speed CAPPED at
  // what the ball's own linear approach could bounce to — the plain restitution
  // the ball would have got had it landed on its rim. However hard the ball is
  // spun, driving the loop into a surface is a touch and not a hop.
  //
  // `velocityBefore` is the ball's velocity before the contacts ran, which is
  // what makes the cap a statement about the ball's own motion rather than about
  // what the solve made of the spin.
  applyLoopCap(contacts: readonly ContactConstraint[], velocityBefore: Vec2): void {
    let best: ContactConstraint | null = null;
    for (const c of contacts) {
      // The loop is this body's second shape, and only as `a`: `a` is always the
      // dynamic body of the pair, which for the ball against scenery is the ball.
      if (c.a !== this || c.shapeA !== BallPlayer.LOOP_SHAPE_INDEX) continue;
      // A speculative contact carries no impulse and is not something met.
      if (c.normalImpulse <= 0) continue;
      if (best === null || c.normalImpulse > best.normalImpulse) best = c;
    }
    if (best === null) return;

    // The normal points out of the surface toward the ball, so a positive
    // component along it is the ball leaving.
    const normal = best.normal;
    const approach = Math.max(0, -velocityBefore.dot(normal));
    const solved = Math.max(0, this.linearVelocity.dot(normal));
    // What the SPIN was worth at this contact, along the normal: the loop's own
    // velocity about the ball's centre, which is the whole of what the phase
    // contributes and the only part of the solve's answer that has no business
    // in the ball's linear velocity. Subtracting it leaves a violent landing its
    // full response — the ball's own approach is untouched — and takes the
    // phase-driven surplus off a gentle one, which is the entire difference
    // between a bounce and a launch.
    const r = best.point.sub(this.globalPosition);
    const spinAtPoint = new Vec2(-this.angularVelocity * r.y, this.angularVelocity * r.x);
    // Scaled by (1 + restitution) because that is what the solve does with an
    // approach: it cancels it and adds the bounce on top.
    const spinNormal = Math.abs(spinAtPoint.dot(normal)) * (1 + this.restitution);
    // Two floors under the cap. The first is the ball's own plain restitution
    // against its own approach, which is the line this has always been and what
    // an ordinary surface is worth.
    //
    // The second is what the SURFACE states, asked of the pair exactly as the
    // solve asks it, and it is zero everywhere a level authors no bounce. On a
    // trampoline it is the pad's throw, and the cap must not take that away: a
    // launch is the one thing on this contact deliberately independent of how
    // the ball arrived, so holding it down to what the arrival earned would put
    // the pad's answer back at the mercy of the loop's rotation phase - the
    // exact fault this cap exists to remove.
    const surfaceBounce = contactBounce(
      approach,
      Math.max(this.restitution, best.b.restitution),
      Math.max(this.launchSpeed, best.b.launchSpeed),
    );
    const allowed = Math.max(this.restitution * approach, surfaceBounce, solved - spinNormal);

    const along = this.linearVelocity.dot(normal);
    // This only ever takes speed away: what the solve did to keep the loop out
    // of the ground stays, what it paid the ball for the loop's phase does not.
    if (along > allowed) {
      this.linearVelocity = this.linearVelocity.add(normal.mul(allowed - along));
    }
  }

  // Is this a surface the ball's own WEIGHT is carried by - a floor or a slope,
  // rather than a wall or a ceiling it merely touches?
  //
  // The gate on taking a ride, and not a detail. A ride's whole job is to keep a
  // contact BEARING through the loop's descent, and a contact that bears is a
  // contact with a Coulomb cone. Against a wall the ball has no weight pressing
  // it on and every newton the wall pushes back with would be the kinematic
  // spin's own doing - which is the fabricated traction `spinFabricatedNormal`
  // exists to refuse, arriving by another door: unfenced, `cli contacts`
  // `loop-wall` climbed 148 cm at 20 rad/s on a frictionless floor against an
  // 8 cm bar, and `ball-roll-wall` rose 1.20 m against 0.15.
  //
  // The line is drawn at how much of the ball's weight the surface takes, and
  // NOT at whether the ball would slide on it. Stiction is the tempting test -
  // `World.applySteeringGrip` asks exactly that, and it is one line - but it is a
  // statement about the TANGENT and this is a question about the normal: the
  // arena's 32 degree ramp sits a degree and a half past `STATIC_FRICTION`'s
  // breakaway, so a ball rolling down it was refused a ride while carrying 85%
  // of its weight on the surface, and hopped down the slope exactly as before
  // (session-105f f85..88). A wall carries none of it, which is the case that
  // matters, and half is a long way from either.
  private restsOn(normal: Vec2): boolean {
    const g = GRAVITY.mul(this.gravityScale);
    return -g.dot(normal) >= g.length() * BallPlayer.RIDE_MIN_SUPPORT;
  }

  // The other half of the loop cap, and the half it could not state: a ball
  // rolling over its own mounting loop must come back DOWN off it, rather than
  // being left in the air where the loop put it.
  //
  // The cap above refuses to PAY the ball for the ride up, and it is right to -
  // the trace of a roll shows the ball leaving every ascent frame at a normal
  // velocity of exactly 0.000. What lifts it is the contact solve's POSITIONAL
  // correction, which tracks `loopExcess` to 0.02 mm all the way to the lug's
  // bottom-dead-centre. Past that the loop turns away from the surface faster
  // than gravity can drop a 52 kg ball - 2.45 m/s of profile against gravity's
  // 0.163 per frame, at the aim's ordinary 27 rad/s - so the overlap vanishes,
  // no contact is gathered, and nothing holds the ball to its own silhouette.
  // It free-falls the 35 mm instead: 5.1 frames airborne, once per revolution,
  // 24% of `session-105f`'s frames with no contact at all and so no
  // `applySteeringGrip` and no sideways drive. Read from the game as the ball
  // stalling every time it comes round.
  //
  // So the descent is written here, and written the way the ascent already
  // happens - as POSITION, with the velocity left alone. That symmetry is the
  // point rather than a convenience:
  //
  //  - Paid as velocity instead, the ball would carry the profile's own 2.45 m/s
  //    into the frame the rim takes back over, where the solve kills it as an
  //    approach and `maxImpulse = mu * m * (vnKilled + gravityBite)` sizes a
  //    Coulomb cone from it. The ball is spinning kinematically, so that cone is
  //    spent DRIVING - the fabricated traction `spinFabricatedNormal` and the
  //    ceiling case exist to refuse, arriving once per revolution.
  //  - Left to gravity, it is the hop.
  //
  // Position only also leaves gravity's own step in the ball's velocity, which is
  // what the solve then sizes a resting contact's normal impulse - and so its
  // honest friction cone - from. A ride is a displacement the ball owes back and
  // never a motion it is paid for, and the books balance over the window: up
  // 35 mm on the solve's correction, down 35 mm here, ending on the rim carrying
  // exactly what it would have had had the lug never been there.
  //
  // Called from `preContactStep`, so `contacts` is the set the frame BEFORE this
  // one solved, and `this.globalRotation` has already taken this frame's step:
  // `loopExcess` here is the profile the gather about to run will measure
  // against, which is what keeps the loop touching and the contact alive the
  // whole way down.
  applyLoopRide(contacts: readonly ContactConstraint[], dt: number): void {
    // An anchored chain switches the whole regime off, exactly as it does for the
    // spin-traction cap (`RigidBody2D.constraintTethered`). A ride is a statement
    // about a ball ROLLING on the ground, and a chain gone taut is the one thing
    // in the game that owns where the ball is instead - it writes position
    // straight onto the body and pays itself velocity for it, and the winch
    // budget, the unwind and the lease are what police that era's traction. A
    // ride laid over the top of it is a second author of the same quantity, and
    // it read as both bugs it could: 8.3 m/s of `rope-solve-kick` in
    // `session-611f`, and 0.42 m/s of `roll-unfunded` in `session-726f`.
    if (this.constraintTethered) this.ride = null;
    // The load-bearing contact the ball ended last frame on, either shape: `a` is
    // always the dynamic body of a pair, which against scenery is the ball.
    // Speculative contacts carry no impulse and are not something met.
    let support: ContactConstraint | null = null;
    for (const c of contacts) {
      if (c.a !== this || c.normalImpulse <= 0) continue;
      if (support === null || c.normalImpulse > support.normalImpulse) support = c;
    }
    const carriedBefore = this.lastSupport;
    this.lastSupport = support?.b ?? null;

    // Keep or drop the ride in hand. It follows the surface it started on and no
    // other: re-acquiring onto whatever the ball happens to touch would let a
    // ride begun on the floor finish against a wall.
    const held = this.ride;
    if (held !== null) {
      if (held.body.removed) {
        this.ride = null;
      } else if (support !== null && support.b === held.body) {
        held.normal = support.normal;
        held.missing = 0;
      } else if (++held.missing > BallPlayer.RIDE_CONTACT_GRACE) {
        // The ball has genuinely left - rolled off a ledge, been bounced, been
        // hauled off by the chain. There is nothing left to ride down onto.
        this.ride = null;
      }
    }

    // Take a ride while the loop is on its way IN to a surface that was already
    // carrying the ball two frames running. Both halves of that gate matter:
    // `carriedBefore` is what makes this a ball ROLLING onto its loop rather than
    // one LANDING on it, and a rising excess is the loop entering its window
    // rather than leaving it, so a ride is never picked up halfway down something
    // it did not ride up.
    //
    // A launch pad is excluded outright. A throw is deliberately independent of
    // how the ball arrived (see the cap's `surfaceBounce`), and a ride is the
    // opposite statement - that the ball stays on the surface - so the two cannot
    // both hold and the pad wins.
    const rollingOn =
      !this.constraintTethered && support !== null && support.b === carriedBefore;
    if (this.ride === null && rollingOn && support !== null) {
      const excess = this.loopExcess(support.normal);
      if (support.b.launchSpeed <= 0 && excess > this.lastExcess && this.restsOn(support.normal)) {
        this.ride = {
          body: support.b,
          normal: support.normal,
          height: this.lastExcess,
          placedAt: this.globalPosition,
          missing: 0,
          wrote: 0,
        };
      }
    }

    const ride = this.ride;
    const rot = this.globalRotation;
    const excess = ride === null ? 0 : this.loopExcess(ride.normal, rot);
    this.lastExcess =
      ride === null && support !== null ? this.loopExcess(support.normal, rot) : excess;
    if (ride === null) return;
    const normal = ride.normal;
    // Gravity has already been applied this frame, and the step it put into the
    // ball is kept ON TOP of everything below rather than overwritten by it. That
    // step is the whole of what a resting contact pushes back against: write the
    // tracking rate alone and the contact has nothing to answer, so it carries no
    // impulse, so there is no Coulomb cone and no `applySteeringGrip` - a ball
    // placed perfectly on its own profile and still not driving, which is the very
    // thing this exists to fix, arriving as a silent zero instead of as a hop.
    const gravityStep = GRAVITY.mul(this.gravityScale * dt).dot(normal);
    const surfaceNormalSpeed = ride.body.velocityAtPoint(this.globalPosition).dot(normal);

    // A ride may only ever write what a ride is WORTH: the fastest the profile can
    // move at this spin, plus a step of gravity either side of it. Asked for more,
    // the ball is not rolling on this surface - something else has hold of one of
    // them - and the ride sits the frame out rather than overruling whatever that
    // is. `session-611f` f209 is the case: the ball is wedged in a corner, the
    // chain is hauling it and the rigid body it is wedged against at 9.6 m/s,
    // gravity still presses it onto that face and that face has carried it two
    // frames running, so every gate above says roll. Written anyway, the ride
    // matched the surface's own 4.2 m/s and the chain solve put it straight back
    // on the next frame: 8.3 m/s in one, `rope-solve-kick`.
    //
    // Sitting out rather than releasing, because a bound this close to the
    // mechanic's own scale will clip a real ride now and then, and a release
    // cannot be undone until the loop comes round again - one clipped frame would
    // cost the whole of the rest of that revolution's descent.
    const rideBound = Math.abs(this.angularVelocity) * this.loopArm + 2 * Math.abs(gravityStep);
    const settle = (to: number): boolean => {
      const from = this.linearVelocity.dot(normal);
      if (Math.abs(to - from) > rideBound) return false;
      this.linearVelocity = this.linearVelocity.add(normal.mul(to - from));
      return true;
    };

    // Sit on this frame's profile - and only ever DOWNWARD onto it. Lifting is
    // the contact solve's, which is already exact there, and taking it would put
    // this in the business of raising the ball off its own kinematic spin, which
    // is `applyLoopCap`'s whole subject.
    //
    // Where the ball stands is MEASURED and not assumed: `height` is the
    // clearance this ride left it at last frame and `placedAt` is where that was,
    // so everything that has moved it since - the solve's push-out, gravity, and
    // this ride's own tracking velocity above - is in the projection. Assumed
    // instead, the two halves of the ride both descend and the same centimetres
    // are spent twice: the ball ends the frame 1.6 mm under its rim, the
    // depenetration sweep lifts it back out along the LOOP, and it leaves 2.2 mm
    // high - once a revolution, compounding, until it is floating clear of the
    // floor with nothing under it at all.
    const stood = ride.height + this.globalPosition.sub(ride.placedAt).dot(normal);
    const drop = Math.min(Math.max(0, stood - excess), BallPlayer.LOOP_EXCESS);
    if (drop > 0) this.globalPosition = this.globalPosition.sub(normal.mul(drop));
    ride.height = Math.min(stood, excess);
    ride.placedAt = this.globalPosition;

    // Off the lug and back on the rim - and set DOWN on it first, which is why
    // this follows the placement above rather than leading it. Returning before
    // it left the ball wherever the last frame's tracking had reached, which at
    // 45 rad/s is 6.4 mm short of the floor with nothing left to bring it down:
    // a two-frame hop at the end of every ride, which is the bug in miniature.
    //
    // Off the lug and back on the rim. The ride hands the normal velocity back
    // where it found it - the ball resting on its own circle with no motion
    // against the surface, carrying gravity's step and nothing else - which is
    // the state it would have been in had the lug never been there.
    //
    // Only when it actually TRACKED, though (`wrote`). A ride that ends without
    // ever having had to write is a ride with nothing to give back, and handing
    // it an opinion about the ball's normal velocity anyway reaches past the
    // mechanic every time one ends on a frame the ball is busy with something
    // else - 0.42 m/s of `roll-unfunded` in `session-726f` out of a ball
    // spinning at 0.01 rad/s, and 8.3 m/s of `rope-solve-kick` in
    // `session-611f`. Subtracting `wrote` back off instead is the other tempting
    // answer and it is worse: by the time the ride ends the solve and gravity
    // have both had their say on that term, so taking the whole of it out again
    // is a kick UPWARD - the hop, restored, at every spin (61 airborne frames at
    // 8 rad/s, where the set leaves none).
    //
    // Handed back HERE, before the gather, so the frame the rim takes over never
    // sees the tracking speed as an approach: solved as one it would be up to
    // 2.45 m/s of `vnKilled` sizing a Coulomb cone, and the ball is spinning
    // kinematically, so that cone would be spent DRIVING - the fabricated
    // traction `spinFabricatedNormal` and the ceiling case exist to refuse,
    // arriving once per revolution.
    if (excess <= 0) {
      if (ride.wrote !== 0) settle(surfaceNormalSpeed + gravityStep);
      this.ride = null;
      return;
    }

    // Carry the profile's own rate into the step about to be integrated, so the
    // loop stays ON the surface rather than merely being placed against it.
    // Without it the position tracks and the VELOCITY does not, the solver reads
    // a contact point separating at the loop's full `omega x r`, and a separating
    // contact carries no load. With it the ball's descent and the loop's rise
    // cancel at the contact point, which is what rolling on a profile means, and
    // what is left for the solve to answer is gravity's step, exactly as for a
    // resting ball.
    //
    // The rate is the ball's own support function differentiated, which is the
    // same statement as "the loop's lowest point is stationary along the normal":
    // d/dt of `loopArm * -loopDir·n` is `omega * (n x loopDir) * loopArm`, and
    // `LOOP_RADIUS` falls out because a circle's lowest point turns with the arm
    // and not with the ring. Taken analytically rather than as a difference of
    // `loopExcess` over the step, because the difference is a chord of the arc
    // and its error is exactly the thing that matters: 0.42 m/s of it left the
    // loop reading as SEPARATING on the sharpest frame of each revolution.
    //
    // Floored at the rim, plus the skin a resting contact sits in anyway. The
    // floor is what stops the ball diving THROUGH its own rim on the frame the
    // profile's corner falls faster than a 60 Hz step can follow: unfloored it
    // reached the rim carrying the profile's 2.1 m/s, which is over
    // `RESTITUTION_THRESHOLD`, and 0.15 of that came back as a bounce - the hop
    // again, once per revolution, wearing the ride's clothes, compounding 4.5 mm
    // a turn into a ball floating a centimetre off the floor. The skin is what
    // keeps that frame BEARING rather than merely touching: seated the depth
    // every resting contact carries, the rim answers on the next frame instead of
    // a frame later.
    //
    // The DESCENT only. The ascent is the solve's and is already exact there;
    // writing the rise as velocity would hand the ball up to 2.45 m/s of outgoing
    // normal speed for its own kinematic spin, which is the launch `applyLoopCap`
    // exists to refuse - and the cap, running later in the frame, would take it
    // straight back off.
    const rate = Math.max(
      this.angularVelocity * normal.cross(this.loopDirection) * this.loopArm,
      -(excess + CONTACT_SLOP) / dt,
    );

    ride.wrote = 0;
    if (rate < 0 && settle(surfaceNormalSpeed + rate + gravityStep)) ride.wrote = rate;
  }

  override preContactStep(dt: number): void {
    this.applyLoopRide(this.world?.frameContacts ?? [], dt);
  }

  get chainAnchored(): boolean {
    return this.chain !== null && this.hookInFlight === null;
  }

  // The chain deploys from a fixed material point on the rim — the "loop",
  // at the top of the ball when unrotated. Aiming rotates the ball so the
  // loop faces the aim direction; the shot always leaves through the loop.
  get loopDirection(): Vec2 {
    return new Vec2(0, -1).rotated(this.globalRotation);
  }

  // The loop ring's centre in the ball's local frame (top of the ball at
  // rotation 0). Mounts the loop's collision circle; rotates with the ball.
  get loopLocalOffset(): Vec2 {
    return new Vec2(0, -(this.radius + BallPlayer.LOOP_GAP));
  }

  // The loop ring's centre in world space (shared by physics and rendering).
  get loopCenter(): Vec2 {
    return this.globalPosition.add(this.loopDirection.mul(this.radius + BallPlayer.LOOP_GAP));
  }

  // `loopDirection` / `loopCenter` against the interpolated render transform,
  // so the loop and the chain leaving it track the drawn ball rather than its
  // 60 Hz sim pose (render-only — see CollisionObject2D.renderPosition).
  renderLoopDirection(alpha: number): Vec2 {
    return new Vec2(0, -1).rotated(this.renderRotation(alpha));
  }

  renderLoopCenter(alpha: number): Vec2 {
    return this.renderPosition(alpha).add(
      this.renderLoopDirection(alpha).mul(this.radius + BallPlayer.LOOP_GAP),
    );
  }

  resolveInput(input: FrameInput): void {
    // Aim steering: rotate the ball so the loop faces the aim point — also
    // with the chain out (winding it around the ball). An aim point at the
    // ball's centre means "not aiming" (stick released — see BallInputSource),
    // which leaves rotation to the physics. The steering overwrites this
    // frame's angular velocity; the chain solver's corrections still land on
    // top of it afterwards.
    const toAim = input.mouseWorldPosition.sub(this.globalPosition);
    const aiming = toAim.lengthSquared() > PX * PX;
    // Speed-faded braking while aiming; symmetric friction otherwise. Full grip
    // at rest, decaying exponentially with speed toward the floor — grippy at
    // low/medium speed, sliding once fast.
    let brake = 1;
    if (aiming) {
      const speed = this.linearVelocity.length();
      brake =
        BallPlayer.AIM_BRAKE_MIN +
        (1 - BallPlayer.AIM_BRAKE_MIN) * Math.exp(-speed / BallPlayer.AIM_BRAKE_DECAY_SPEED);
    }
    this.contactBrakeScale = brake;
    // While aiming, the steering below drives rotation kinematically. Flag it so
    // ground contacts stop pouring their friction impulse into angular velocity
    // (which this line would overwrite anyway) and instead brake the linear
    // slide — otherwise a ball balanced on its loop coasts sideways forever.
    this.kinematicRotation = aiming;
    // Firing snaps the facing straight to the aim point. The steered turn is
    // rate-limited, so a release-and-quick-retarget would otherwise launch the
    // hook wherever the ball happens to be pointing mid-turn, not at the
    // cursor. A pure rotation teleport: the steering below then sees zero
    // error and writes ~0 angular velocity, so the snap never becomes spin.
    if (aiming && input.fire.pressed && !this.chain) {
      this.globalRotation += wrapAngle(toAim.angle() - this.loopDirection.angle());
    }
    if (aiming) {
      const delta = wrapAngle(toAim.angle() - this.loopDirection.angle());
      this.angularVelocity = delta * BallPlayer.AIM_TURN_GAIN;
    }

    // Hold-to-keep: press shoots, release lets go (matches the grapple
    // controller's fire semantics).
    if (input.fire.pressed && !this.chain) this.shoot();
    if (input.fire.released) this.releaseChain();
  }

  // Called after the hook has flown this frame. Two triggers convert the
  // flying hook into the dangling chain tip: reaching the absolute max length
  // (a missed throw), or the deploying chain snagging on scene geometry — it
  // wraps the corner and the deploy stops there.
  //
  // The max-length trigger is normally the hook's own chain-out cap now (see
  // BallHook.physicsStep), which ends the flight at the sub-frame point the
  // chain snaps taut. This check remains the backstop for the paths the cap
  // does not budget exactly: the payout after a bounce reseats the hook, and
  // wrap-length changes during the integrate that follows the cap's measure.
  checkChainReach(bodies: PhysicsBody2D[]): void {
    if (!this.hookInFlight || !this.chain) return;
    const len = this.chain.getCurrentLength();
    if (len > BallPlayer.CHAIN_MAX_LENGTH) {
      this.deployTip(BallPlayer.CHAIN_MAX_LENGTH);
    } else if (this.chain.detectSceneCatch(bodies, this)) {
      // Snagged mid-flight: the wrap node is now in the chain, so freeze at the
      // wrapped path length (longer than the straight span was).
      this.deployTip(this.chain.getCurrentLength());
    }
  }

  // The chain has stopped paying out mid-flight (hit max, or snagged on scene
  // geometry): from here the hook is the chain tip — the rope
  // solver takes over (dangle, swing, get reeled in) — but it stays armed and
  // still anchors to the first surface it touches. `targetLength` is the
  // length to freeze at.
  private deployTip(targetLength: number): void {
    const hook = this.hookInFlight;
    const chain = this.chain;
    if (!hook || !chain) return;

    // The straight-line throw is over, so the tip falls from here: it swings
    // and dangles on the chain instead of hanging in the air where it stopped.
    hook.endFlight();

    // Pull any overshoot back along the final span so the deployed length is
    // exactly targetLength.
    const lastWrap = chain.wraps[chain.wraps.length - 1];
    const prevPos = lastWrap ? lastWrap.contact.globalPosition : chain.start.contact.globalPosition;
    const overshoot = chain.getCurrentLength() - targetLength;
    if (overshoot > 0) {
      hook.globalPosition = hook.globalPosition.add(
        hook.globalPosition.directionTo(prevPos).mul(overshoot),
      );
    }
    // Strip the outward radial velocity: the chain is taut, so integration
    // must not stretch it past target again this frame (the tangential
    // remainder becomes the swing).
    const outward = prevPos.directionTo(hook.globalPosition);
    const vr = hook.linearVelocity.dot(outward);
    if (vr > 0) hook.linearVelocity = hook.linearVelocity.sub(outward.mul(vr));

    this.chainTip = hook;
    this.hookInFlight = null;
    chain.maxRopeLength = targetLength;
  }

  private shoot(): void {
    // The shot leaves through the loop, wherever the ball is facing.
    const dir = this.loopDirection;
    const muzzle = this.globalPosition.add(dir.mul(this.radius));
    const hook = new BallHook();
    hook.globalPosition = muzzle;
    // Launch speed along the loop direction.
    hook.linearVelocity = dir.mul(BallPlayer.HOOK_SPEED);
    hook.addCollisionExceptionWith(this);
    this.hookInFlight = hook;
    this.spawnBody?.(hook);

    // Chain origin on the ball's edge, in the ball's local frame — it rotates
    // with the ball.
    this.chain = new Rope(
      new RopeContact(this, dir.mul(this.radius)),
      new RopeContact(hook, Vec2.ZERO),
      [],
      null,
    );
    this.chainSlack = new SlackChain(this.chain);
    // A hook-proof surface does not stop the deploy — BallHook.bounce deflects
    // the hook and scales its speed by how glancing the hit was, and the chain
    // keeps paying out until it reaches max length or snags on geometry.
    hook.registerAttachmentCallback((body, point) => {
      this.hookInFlight = null;
      this.chainTip = null;
      if (!this.chain) return;
      // Hook-proof surface: the chain is lost. `BallHook` deflects off one
      // rather than attaching, so this is a backstop - but it is asked of the
      // PIECE the anchor point landed on, because a wall may be hook-proof on
      // one face and attachable on the next and a body-level answer would be
      // wrong for whichever face it is not about.
      const shapes = body.getShapes();
      if (shapes[nearestShapeIndex(shapes, point)]?.impermeable) {
        this.releaseChain();
        return;
      }
      // `RopeContact.at` rather than the primary shape: on a compound body the
      // hook anchors on whichever piece it struck, and the wrap resolvers walk
      // the piece the contact names (see RopeContact.at).
      this.chain.end = new RopeAttachment(RopeContact.at(body, point));
      // Regenerate wraps now so the length below is the true wrapped path. The
      // solver (chain.physicsStep) will wrap it this same frame regardless; if we
      // measured the straight span here, clamping to it would leave the wrapped
      // path over max and the solve would dump the difference into the ball as a
      // one-frame lurch (session-116f: a 0.9 m/s kick off a resting ball).
      this.chain.syncWraps(this.sceneBodies);
      const len = this.chain.getCurrentLength();
      if (len > BallPlayer.CHAIN_MAX_LENGTH + BallPlayer.ATTACH_SNAP_TOLERANCE) {
        // Attached far beyond the chain's absolute length — snap instead of
        // letting the solver yank the ball toward a too-far anchor.
        this.releaseChain();
        return;
      }
      // Anchoring may GROW the length to what the chain reached (NOT clamped
      // to CHAIN_MAX_LENGTH) and never shrink it. Growing to `len` is what
      // keeps the constraint satisfied on the anchoring frame (path length <=
      // maxRopeLength), so the solver injects no correction — no one-frame
      // lurch/whip/launch into the ball — and the anchor stays exactly where
      // the hook hit the surface, instead of being dragged inward off the
      // geometry to hit a shorter target (which floated the anchor in mid-air —
      // session-601f). The small overshoot past CHAIN_MAX_LENGTH is bounded by
      // ATTACH_SNAP_TOLERANCE above.
      //
      // Never shrink, because a chain that was dangling SLACK when its tip
      // touched down anchors with that slack still in hand: the chain's length
      // is what was deployed, and rebasing it to the as-anchored path length
      // silently retracted the difference — a chain that had reached its full
      // 1.8 m and then brushed a wall snapped to a 0.5 m straight line on the
      // attach frame (session-161f). Invisible while the renderer drew straight
      // spans anyway; the slack drape is what made it a visible teleport. The
      // inequality constraint is satisfied either way, so keeping the slack
      // injects nothing.
      this.chain.maxRopeLength = Math.max(this.chain.maxRopeLength, len);
    });

    // The flight may not outrun the chain (see the chain-out cap in
    // BallHook.physicsStep): each frame the hook budgets its step against what
    // is left of CHAIN_MAX_LENGTH beyond the wrapped path's last fixed point,
    // and running out mid-step converts it into the dangling tip there and
    // then — at the sub-frame point the chain snapped taut, before it can
    // reach (and bounce off, session-339f) anything the chain forbids. An
    // attach alone may still land `ATTACH_SNAP_TOLERANCE` further, which is
    // the attach callback's standing forgiveness rule handed to the sweep.
    // The budget exists only while this hook is the deploying one: once it is
    // the tip, the rope solver owns its length.
    hook.deployLimit = () => {
      const chain = this.chain;
      if (!chain || this.hookInFlight !== hook) return null;
      const lastWrap = chain.wraps[chain.wraps.length - 1];
      const prev = lastWrap ? lastWrap.contact.globalPosition : chain.start.contact.globalPosition;
      const base = chain.getCurrentLength() - prev.distanceTo(hook.globalPosition);
      const allowance = BallPlayer.CHAIN_MAX_LENGTH - base;
      return { prev, allowance, attachAllowance: allowance + BallPlayer.ATTACH_SNAP_TOLERANCE };
    };
    hook.registerChainOutCallback(() => this.deployTip(BallPlayer.CHAIN_MAX_LENGTH));
  }

  // (settleAnchorOvershoot removed: anchoring at no less than the as-reached
  // length leaves the constraint satisfied, so there is no overshoot to absorb
  // and no anchor to drag off the surface.)

  releaseChain(): void {
    if (this.hookInFlight) this.hookInFlight.world?.remove(this.hookInFlight);
    if (this.chainTip) this.chainTip.world?.remove(this.chainTip);
    this.hookInFlight = null;
    this.chainTip = null;
    this.chain = null;
    this.chainSlack = null;
  }
}
