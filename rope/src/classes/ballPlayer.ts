// BallPlayer — the ball & chain character controller. Unlike Player (a
// CharacterBody2D driven by a state machine), the ball is a plain RigidBody2D:
// gravity, rolling and chain tension are the only things that move it. The
// chain reuses the Rope wrap solver — its start contact is a point on the
// ball's EDGE, stored in the ball's local frame, so it rotates with the ball
// and the chain can wind around the ball itself; chain tension applied at the
// edge torques the ball (the rope solver's lever-arm path, which Player
// deliberately bypasses).

import { dmath } from "../engine/dmath";
import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { wrapAngle } from "../engine/mathf";
import { PhysicsBody2D, RigidBody2D, type CollisionObject2D, type CollisionShape2D } from "../engine/body";
import { circleShape, nearestShapeIndex, type ShapeTransform } from "../engine/shapes";
import { outwardDirection } from "../engine/collision";
import { shapeContacts } from "../engine/manifold";
import { contactBounce, CONTACT_SLOP, GRAVITY, type ContactConstraint } from "../engine/world";
import { Density, ShapeGeometry } from "../lib/shapeGeometry";
import { RopeAttachment, RopeContact } from "../lib/ropeContact";
import { RopeClamp } from "../lib/rail";
import type { FrameInput } from "../input/frameInput";
import { Rope } from "./rope";
import { SlackChain } from "./slackChain";
import { BallHook } from "./ballHook";
import { chainEndFacing, MANACLE_HINGE, MANACLE_REACH, manacleShape } from "../lib/manacle";

// The manacle as the renderers draw it: see `BallPlayer.manaclePose`.
export interface ManaclePose {
  centre: Vec2;
  // Unit vector out of the hinge - along the cuff's long axis toward the end
  // the chain is shackled to.
  dir: Vec2;
  // Clamped to something (a face, half-buried; or a rail), rather than a free
  // body on the end of the chain.
  clamped: boolean;
  // Clamped around a RAIL: the bar passes through the ring and nothing about
  // the cuff is buried.
  onRail: boolean;
  // Bitten into a face: the face's outward normal, through the cuff's centre.
  // Everything on the far side of that plane is inside the geometry. Null for
  // a free cuff and around a rail.
  buriedUnder: Vec2 | null;
}

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
  // The direction (+1/-1, 0 for none) of a turn the chain refused in full on
  // the last frame that asked for one, latched by `BallLevel` after the
  // unwind and read by the aim steering (see `resolveInput`). Cleared by a
  // demand in the other direction, or by the chain going.
  windStall = 0;
  // Whether the ball was still resting against a body on its chain's path at
  // the end of the last frame, kept by `BallLevel`. A stall is a turn refused
  // by that contact, so it holds only while the contact does: a ball whose
  // anchor is a hand's width away turns and rides around it as it always did,
  // and a single refused frame on the way there does not freeze it for good.
  // Without this a ball anchored point-blank to the weight, five centimetres
  // clear of it, had its rotation frozen through a 166 degree sweep of the aim
  // (`session-142f` f73-116).
  windStallHeld = false;
  // Spool rate (m per radian) below which turning does not wind chain and the
  // stall has nothing to limit.
  static readonly STALL_MIN_SPOOL = 0.001;
  // Share of the ball's radius the spool must reach for a refused turn to
  // LATCH the stall at all. A chain wound onto the rim leaves it tangentially,
  // at the radius itself; one anchored point-blank and leaving radially winds
  // nothing per radian (2% of the radius on `session-287f`), so a turn there
  // is never a wind-up the chain could refuse, whatever the unwind - answering
  // push-out over-length that is not the spin's - happens to hand back. The
  // wound-tight endgame that must still latch read 43% (`session-611f` f283).
  static readonly STALL_LATCH_SPOOL_SHARE = 0.25;
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
  // Which way the manacle faces, in the ANCHOR BODY's frame. A clamped manacle
  // is bolted to what it bit: it does not turn at all for as long as it holds,
  // however the chain swings around it afterwards - and it turns with the thing
  // it is bolted to, which a world-frame direction would not do on a windmill or
  // a moving platform. Purely what the renderers draw (the sim never reads it),
  // but it belongs to the attachment, so it is stored and cleared with it. Read
  // through `manacleFacing`.
  private anchorFacingLocal: Vec2 | null = null;
  // The outward normal of the face the cuff bit, in the anchor body's frame:
  // the plane the cuff is half buried under, which is not the cuff's own
  // midline once it has bitten at an angle. Render-only, like the facing.
  private anchorNormalLocal: Vec2 | null = null;
  private anchorBody: PhysicsBody2D | null = null;
  // The clamped cuff as a solid piece of the body it bit (see `onHookAttached`),
  // to be unmounted when the chain lets go. Null while there is none: no
  // anchor, a rail, or a bite the ball was already standing on.
  private anchorCuff: { body: CollisionObject2D; shape: CollisionShape2D } | null = null;
  // The anchor is a clamp around a rail rather than a bite into a face, so
  // `anchorFacingLocal` is the rail's tangent - the cuff's AXIS - and the
  // renderers turn the cuff to encircle the bar instead of half-burying it.
  // Render-only, like the facing; cleared with it.
  private anchorOnRail = false;
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

  // Which way an ANCHORED manacle faces - the way its hinge points - or null
  // while the chain end is still a free body, when the cuff simply faces the
  // chain it hangs from.
  //
  // It is the way the cuff ARRIVED: the throw drives the mouth into the face at
  // whatever angle it came in at and the cuff stays at that angle, half in the
  // geometry and half out, which is what a spike driven into a wall does. The
  // one exception is a cuff whose BACK met the geometry - the hinge pointing
  // into the surface, a tip lying hinge-down on a ledge - where no mouth bit
  // anything, and the cuff is set square to the face on the surface's own
  // outward normal instead (`onHookAttached`).
  //
  // Frozen from there. A clamped manacle does not turn as the ball swings around
  // it - it is bolted to what it bit - so the chain's touch point slides round
  // the rim instead (see `chainEndFacing`). It turns only with the body itself.
  //
  // A cuff on a RAIL is the exception, and is not frozen at all: it is bolted to
  // nothing, and a ring resting on a bar hangs in the plane of what is pulling
  // it, so its facing is read live off the clamp - the end of the ring the
  // chain leaves over, which is where the hinge is (`RopeClamp.rimLocal`),
  // wherever along the bar the ring has got to. A frozen facing would be the
  // way the ring hung where the hook first STRUCK, which on a curved handle is
  // not even the way it hangs under the ring any more.
  manacleFacing(alpha: number): Vec2 | null {
    const clamp = this.railClamp;
    if (clamp !== null) return clamp.rimLocal().rotated(clamp.body.renderRotation(alpha));
    const local = this.anchorFacingLocal;
    if (local === null) return null;
    const body = this.anchorBody;
    return body === null ? local : local.rotated(body.renderRotation(alpha));
  }

  // Where the manacle is and which way it faces, for the renderers: its
  // centre, the direction its hinge points (out of the face it bit, or back
  // along the chain it hangs from), and whether it is clamped - to a face,
  // half of it buried, or around a rail, nothing buried. Null while there is no
  // chain out at all.
  //
  // One answer for both renderers, derived from the sim's own end node: the
  // chain's end IS the hinge pin, so the cuff's centre is one hinge offset
  // back from it along the facing, and the drawn cuff can never come apart
  // from the point the drawn chain ends at.
  manaclePose(alpha: number): ManaclePose | null {
    const chain = this.chain;
    if (!chain) return null;
    const free = this.hookInFlight ?? this.chainTip;
    if (free !== null) {
      return {
        centre: free.renderPosition(alpha),
        dir: Vec2.RIGHT.rotated(free.renderRotation(alpha)),
        clamped: false,
        onRail: false,
        buriedUnder: null,
      };
    }
    const dir = this.manacleFacing(alpha);
    if (dir === null) return null;
    const clamp = this.railClamp;
    if (clamp !== null) {
      return { centre: clamp.contact.renderGlobalPosition(alpha), dir, clamped: true, onRail: true, buriedUnder: null };
    }
    const hinge = chain.end.contact.renderGlobalPosition(alpha);
    const body = this.anchorBody;
    const normal = this.anchorNormalLocal ?? dir;
    return {
      centre: hinge.sub(dir.mul(MANACLE_HINGE)),
      dir,
      clamped: true,
      onRail: false,
      buriedUnder: body === null ? normal : normal.rotated(body.renderRotation(alpha)),
    };
  }

  // Which way a FREE cuff should face: from its centre back along the chain it
  // hangs from (see `chainEndFacing`), or null once the chain no longer ends
  // on it. Measured on the sim's own path, so the rotation the hook body takes
  // from it is as deterministic as everything else about the sim; the drape
  // the renderers draw is not consulted.
  private hookFacing(hook: BallHook): Vec2 | null {
    const chain = this.chain;
    if (!chain || chain.end.contact.obj !== hook) return null;
    const path = chain.path().map((n) => n.contact.globalPosition);
    // From the CENTRE, not the hinge: the hinge is what turning moves.
    path[path.length - 1] = hook.globalPosition;
    return chainEndFacing(path, Vec2.RIGHT.rotated(hook.globalRotation));
  }

  // The chain's end as a rail clamp, or null for a bite, a dangling tip or a
  // hook still in flight.
  private get railClamp(): RopeClamp | null {
    const end = this.chain?.end;
    return end instanceof RopeClamp ? end : null;
  }

  // Is the anchored manacle CLAMPED AROUND A RAIL, rather than bitten into a
  // face? Then `manacleFacing` is the axis the bar runs through the ring on and
  // nothing about the cuff is buried: the bar passes through it. False while
  // the chain end is free, and for every bite.
  get manacleOnRail(): boolean {
    return this.anchorOnRail && this.anchorFacingLocal !== null;
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

  resolveInput(input: FrameInput, delta = 1 / 60): void {
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
        (1 - BallPlayer.AIM_BRAKE_MIN) * dmath.exp(-speed / BallPlayer.AIM_BRAKE_DECAY_SPEED);
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
      const angleError = wrapAngle(toAim.angle() - this.loopDirection.angle());
      const demand = angleError * BallPlayer.AIM_TURN_GAIN;
      // Stalled: the chain refunded the whole of a turn in this direction and
      // nothing has changed since (see `windStall`), so the loop may turn only
      // as far as the chain's OWN length allows - the slack between the path
      // and `maxRopeLength`, with no lease counted - which for a ball wound
      // all the way up to its anchor is nothing at all. The steering is
      // kinematic and knows nothing about the chain, and a chain wound tight
      // refunds the whole turn every frame (`Rope.unwindOverLength`): the
      // loop never reaches the aim, the error never shrinks, and the same
      // 40 rad/s was written again next frame, forever. Every phase that runs
      // BEFORE the refund saw that spin as real: the contact solve read the
      // mounting loop, 14 cm out on the rim, as a hammer swinging at 5.5 m/s
      // with infinite inertia behind it, and hit the 12.6 kg weight the ball
      // rested against with 35-41 N·s a frame, 3 m/s per blow - the ball
      // thrown off its anchor and hauled back by the chain, over and over
      // (`session-154f` f77-82). A decaying memory of the refused spin was
      // tried first and converges to demanding HALF the command every frame
      // (m = D - m): the hammer at half strength. The stall clears the moment
      // the player aims the other way, because paying chain out is always
      // allowed, and the allowance grows by itself as the anchor recedes.
      let allowed = demand;
      if (
        this.chain &&
        this.windStall !== 0 &&
        this.windStallHeld &&
        Math.sign(demand) === this.windStall
      ) {
        const spool = Math.abs(this.chain.lengthPerRadian(this));
        const slack = Math.max(0, this.chain.maxRopeLength - this.chain.getCurrentLength());
        if (spool > BallPlayer.STALL_MIN_SPOOL) {
          allowed = this.windStall * Math.min(Math.abs(demand), slack / spool / delta);
        }
      } else {
        this.windStall = 0;
      }
      this.angularVelocity = allowed;
    }

    // Hold-to-keep: press shoots, release lets go (matches the grapple
    // controller's fire semantics).
    if (input.fire.pressed && !this.chain) this.shoot();
    if (input.fire.released) this.releaseChain();
    if (!this.chain || !this.windStallHeld) this.windStall = 0;
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
    // Measured to the HINGE, where the chain ends; the body moves with it.
    if (overshoot > 0) {
      hook.globalPosition = hook.globalPosition.add(hook.hinge.directionTo(prevPos).mul(overshoot));
    }
    // Strip the outward radial velocity: the chain is taut, so integration
    // must not stretch it past target again this frame (the tangential
    // remainder becomes the swing).
    const outward = prevPos.directionTo(hook.hinge);
    const vr = hook.linearVelocity.dot(outward);
    if (vr > 0) hook.linearVelocity = hook.linearVelocity.sub(outward.mul(vr));

    this.chainTip = hook;
    this.hookInFlight = null;
    chain.maxRopeLength = targetLength;
  }

  private shoot(): void {
    // The shot leaves through the loop, wherever the ball is facing.
    const dir = this.loopDirection;
    // The cuff leaves mouth first, hinge trailing toward the ball, with its
    // MOUTH on the ball's rim: the hook collides as the whole cuff, so a muzzle
    // on the rim spawns it half inside the ball, and a muzzle any further out
    // spawns the mouth past whatever thin surface the ball is resting against -
    // a hook aimed down at a slat the ball sits on has to meet that slat, not
    // appear underneath it. The hinge is then a band's half-width off the rim,
    // and the chain's first span is that short for one frame.
    const muzzle = this.globalPosition.add(dir.mul(this.radius + MANACLE_REACH));
    const hook = new BallHook();
    hook.globalPosition = muzzle;
    hook.globalRotation = dir.neg().angle();
    // Launch speed along the loop direction.
    hook.linearVelocity = dir.mul(BallPlayer.HOOK_SPEED);
    hook.addCollisionExceptionWith(this);
    this.hookInFlight = hook;
    this.spawnBody?.(hook);

    // Chain origin on the ball's edge, in the ball's local frame — it rotates
    // with the ball.
    //
    // The chain ends on the cuff's HINGE PIN, in the cuff's own frame, which is
    // where the links are shackled and where both renderers end the drawn
    // chain. The pin is what the chain's length is measured to at every moment
    // of the throw, and it is what the anchor becomes when the cuff bites (see
    // `onHookAttached`), so the physics end and the drawn end are one point
    // throughout.
    //
    // The last span therefore ends inside the hook's own collision shape, which
    // the wrap resolvers would read as the chain having snagged on the scene -
    // that is what `wrappable = false` on the hook's shape is for.
    this.chain = new Rope(
      new RopeContact(this, dir.mul(this.radius)),
      new RopeContact(hook, hook.hingeOffset()),
      [],
      null,
    );
    // The player's chain is the one rope in the game that moves fast enough
    // to pass clean through a small body between two looks at it, so it is
    // the one that sweeps (see `Rope.continuous`).
    this.chain.continuous = true;
    this.chain.onClampRunOff = (clamp, end) => this.dropFromRail(clamp, end);
    this.chainSlack = new SlackChain(this.chain);
    // A hook-proof surface does not stop the deploy — BallHook.bounce deflects
    // the hook and scales its speed by how glancing the hit was, and the chain
    // keeps paying out until it reaches max length or snags on geometry.
    hook.registerAttachmentCallback((body, point, struck) => this.onHookAttached(hook, body, point, struck));
    this.wireDeploy(hook);
  }

  // The chain's end has caught `body` at `point`, on `struck`: anchor there,
  // or clamp around it if it is a rail, or lose the chain if it is hook-proof.
  private onHookAttached(
    hook: BallHook,
    body: PhysicsBody2D,
    point: Vec2,
    struck: CollisionShape2D | null,
  ): void {
    this.hookInFlight = null;
    this.chainTip = null;
    this.anchorFacingLocal = null;
    this.anchorNormalLocal = null;
    this.anchorBody = null;
    this.anchorOnRail = false;
    this.unmountCuff();
    if (!this.chain) return;
    // Hook-proof surface: the chain is lost. `BallHook` deflects off one
    // rather than attaching, so this is a backstop - but it is asked of the
    // PIECE the hook reached, because a wall may be hook-proof on one face
    // and attachable on the next and a body-level answer would be wrong for
    // whichever face it is not about. The hook names the piece it struck;
    // the nearest piece to the point is the fallback for a path that could
    // not, and at the joint between a rail and its lid the two can differ.
    const shapes = body.getShapes();
    const struckIndex = struck ? shapes.indexOf(struck) : -1;
    const pieceIndex = struckIndex >= 0 ? struckIndex : nearestShapeIndex(shapes, point);
    const piece = shapes[pieceIndex];
    if (piece?.impermeable) {
      this.releaseChain();
      return;
    }
    // The surface's outward normal at the bite (for a piece the hook could not
    // name, back toward the ball), and which way the cuff stands once it has
    // bitten: the way it ARRIVED, hinge trailing the chain, driven into the face
    // at whatever angle the throw came in at - unless it is the cuff's BACK
    // that met the geometry, the hinge pointing into the surface, where no
    // mouth bit anything and the cuff is set square to the face instead (see
    // `manacleFacing`).
    const normal = piece ? outwardDirection(point, piece) : point.directionTo(this.globalPosition);
    const arrived = Vec2.RIGHT.rotated(hook.globalRotation);
    const facing = arrived.dot(normal) > 0 ? arrived : normal;
    if (piece?.rail) {
      // A RAIL: the cuff closes around the bar rather than biting its face,
      // so the anchor is a clamp on the bar's own authored CURVE, which
      // slides under the chain's pull against the rail's friction (see
      // `lib/rail.ts`). The piece names the whole curve, however many pieces
      // the bar was stroked into. The bite point was on the surface; the
      // cuff's centre is a half-width in from it, which is the jump the cuff
      // makes as it shuts.
      this.chain.end = RopeClamp.at(body, piece.rail, point, this.globalPosition, [this, hook]);
    } else {
      // The cuff bites at the angle it arrived at, centred on the surface - the
      // mouth half embedded in the geometry, the hinge half standing proud of
      // it - and the chain is shackled to the hinge pin, one ring radius from
      // the bite along the cuff. So the chain's end node is that pin and not
      // the bite point: the anchor the solver pulls on stands clear of the
      // surface, on the one part of the cuff that is not inside it, exactly
      // where the drawn chain ends.
      //
      // On the piece the hook struck, named as such rather than resolved from
      // the pin: a radius off the face, the nearest piece of a compound body
      // can be the neighbour that face meets, and the wrap resolvers walk the
      // piece the contact names.
      const hinge = point.add(facing.mul(MANACLE_HINGE));
      this.chain.end = new RopeAttachment(
        new RopeContact(body, hinge.sub(body.globalPosition), pieceIndex),
      );
      this.mountCuff(body, point, facing);
    }
    // Regenerate wraps now so the length below is the true wrapped path. The
    // solver (chain.physicsStep) will wrap it this same frame regardless; if we
    // measured the straight span here, clamping to it would leave the wrapped
    // path over max and the solve would dump the difference into the ball as a
    // one-frame lurch (session-116f: a 0.9 m/s kick off a resting ball).
    this.chain.syncWraps(this.sceneBodies);
    const len = this.chain.getCurrentLength();
    // The manacle clamps shut around the bite point - half in the geometry and
    // half out of it - facing the way it was driven in, and stays exactly so
    // for as long as it holds (see `manacleFacing`). The face's normal is kept
    // beside it: it is the plane the renderers bury the cuff's far half under.
    //
    // Around a rail the facing is read live off the clamp instead (see
    // `manacleFacing`); what is stored here for a rail is only that there IS
    // an anchor to face from.
    this.anchorBody = body;
    const clamp = this.chain.end instanceof RopeClamp ? this.chain.end : null;
    this.anchorOnRail = clamp !== null;
    this.anchorFacingLocal = facing.rotated(-body.globalRotation);
    this.anchorNormalLocal = normal.rotated(-body.globalRotation);
    // The tolerance here is a SNAP backstop, not a range: it is sized for the
    // ~1 px of solver slop a dangling tip carries when it finally lands (see
    // the constant), and what it rejects is an anchor no throw could have
    // reached — one offered by `probeContact` or by the solver's own
    // contacts — because that is what would drag the ball to a too-far
    // anchor. A throw cannot reach it: the flight budget stops an attach one
    // hook radius past full stretch (see `deployLimit`), so the longest path
    // a deploy can anchor at is ~1.84 m against this 2.0 m gate.
    //
    // It was not always slack: while the flight was ALSO forgiven 0.2 m, the
    // sweep would accept a hit whose anchor — placed on the surface, a radius
    // past the centre the sweep had budgeted — landed a few millimetres over
    // this same 2.0 m, and the chain was then dropped on the anchoring frame.
    // Eight of the last fourteen throws in `session-1355f` did that, which
    // reads from the game as the chain retracting itself while the deploy
    // button is still held.
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
  }

  // The clamped cuff stays in the scene as a PIECE of the body it bit: half of
  // it stands proud of the face, and the ball is stopped by it exactly as it
  // would be by anything else bolted there - a ball wound all the way up to its
  // anchor comes to rest with the hinge on its rim, one ring radius off the
  // face, rather than passing through the manacle to the face behind it, which
  // is where the wind-up's whole endgame (the latch, the unwind, the lease) was
  // written to end. Solid but not rope geometry - the chain is shackled to it,
  // and a span leaving the hinge is clear of it by construction - and not part
  // of the body's drawn outline, since the chain renderer draws it at the
  // cuff's own pose. Mounted AFTER the end contact is made, so the contact's
  // piece index is the face's and stays so when the cuff is unmounted.
  //
  // Not mounted where the ball already STANDS: a point-blank throw bites the
  // face at the ball's own contact, and a cuff appearing inside the ball would
  // be a shove the throw never made. There is nothing there for the ball to be
  // stopped by that it is not already touching.
  private mountCuff(body: PhysicsBody2D, point: Vec2, normal: Vec2): void {
    const bar: ShapeTransform = { globalPosition: point, globalRotation: normal.angle(), shape: manacleShape() };
    for (const own of this.getShapes()) {
      if (shapeContacts(bar, own).length > 0) return;
    }
    const cuff = body.addShape(
      bar.shape,
      point.sub(body.globalPosition).rotated(-body.globalRotation),
      normal.angle() - body.globalRotation,
    );
    cuff.wrappable = false;
    cuff.hidden = true;
    this.anchorCuff = { body, shape: cuff };
  }

  private unmountCuff(): void {
    if (!this.anchorCuff) return;
    this.anchorCuff.body.removeShape(this.anchorCuff.shape);
    this.anchorCuff = null;
  }

  // The rest of a thrown hook's wiring: its flight budget and what happens
  // when it runs out of chain.
  private wireDeploy(hook: BallHook): void {
    // The flight may not outrun the chain (see the chain-out cap in
    // BallHook.physicsStep): each frame the hook budgets its step against what
    // is left of CHAIN_MAX_LENGTH beyond the wrapped path's last fixed point,
    // and running out mid-step converts it into the dangling tip there and
    // then — at the sub-frame point the chain snapped taut, before it can
    // reach (and bounce off, session-339f) anything the chain forbids.
    //
    // The budget is measured to the HINGE, where the chain ends, and an
    // ATTACH gets no allowance beyond it: the reach the player is shown is
    // where the tip stops with the cuff drawn on the end of it, so that is the
    // reach an attach gets. The cuff's own body is the forgiveness - the mouth
    // leads the hinge by `MANACLE_MOUTH`, so a face the mouth can touch with
    // the hinge at full stretch is bitten, and the sweep of the bar is what
    // finds it (see the chain-out cap in `BallHook.physicsStep`).
    //
    // It used to be `ATTACH_SNAP_TOLERANCE` (0.2 m), which is the attach
    // callback's snap backstop below — a number sized for ~1 px of solver
    // slop on a dangling tip (see the constant) that was handed to the sweep
    // as flight forgiveness and never re-picked for the job. It made the reach
    // dishonest: the tip always stops at CHAIN_MAX_LENGTH, while an attach
    // reached 0.2 m further, so a wall a hand's breadth past the chain's real
    // length caught roughly half the throws aimed at it and the eye had
    // nothing to predict it by (`session-366f`: seven throws inside 4° of aim
    // at a wall 1.95-2.01 m out on a 1.8 m chain, four stuck, three did not,
    // and the sticking ones anchored further out than the failing ones had
    // reached). Then it was one hook radius, for a disc whose anchor was
    // placed a radius past its centre; the bar carries its reach in its own
    // shape.
    //
    // The budget exists only while this hook is the deploying one: once it is
    // the tip, the rope solver owns its length.
    hook.deployLimit = () => {
      const chain = this.chain;
      if (!chain || this.hookInFlight !== hook) return null;
      const lastWrap = chain.wraps[chain.wraps.length - 1];
      const prev = lastWrap ? lastWrap.contact.globalPosition : chain.start.contact.globalPosition;
      const base = chain.getCurrentLength() - prev.distanceTo(hook.hinge);
      return { prev, allowance: BallPlayer.CHAIN_MAX_LENGTH - base };
    };
    hook.registerChainOutCallback(() => this.deployTip(BallPlayer.CHAIN_MAX_LENGTH));
    // Free - flying or dangling - the cuff trails the chain, hinge first.
    hook.facing = () => this.hookFacing(hook);
  }

  // A clamped ring has run off the OPEN end of its rail (see `RopeClamp.coast`):
  // it is loose again, so it goes back to being the dangling chain tip, a body
  // in the world at the ring's own position with the speed it ran off at, and
  // the chain goes back to ending at its centre. It stays DISARMED - a manacle
  // that has slid off a rail is a weight on the end of a chain until it is
  // thrown again, rather than something that re-catches the bar's end on the
  // frame after it left it.
  private dropFromRail(clamp: RopeClamp, end: -1 | 1): void {
    const chain = this.chain;
    if (!chain || chain.end !== clamp) return;
    const at = clamp.runOffPoint(end);
    const hook = new BallHook();
    hook.globalPosition = at;
    // Hinge toward the chain, as it will be turned every step from here on.
    const lastWrap = chain.wraps[chain.wraps.length - 1];
    const prev = lastWrap ? lastWrap.contact.globalPosition : chain.start.contact.globalPosition;
    if (at.distanceTo(prev) > 1e-6) hook.globalRotation = at.directionTo(prev).angle();
    const along = clamp.tangent();
    const carried = clamp.body instanceof PhysicsBody2D ? clamp.body.velocityAtPoint(at) : Vec2.ZERO;
    hook.linearVelocity = carried.add(along ? along.mul(clamp.speed) : Vec2.ZERO);
    hook.endFlight();
    hook.disarm();
    hook.addCollisionExceptionWith(this);
    hook.registerAttachmentCallback((body, point, struck) => this.onHookAttached(hook, body, point, struck));
    this.wireDeploy(hook);
    this.spawnBody?.(hook);
    this.chainTip = hook;
    this.anchorBody = null;
    this.anchorOnRail = false;
    this.anchorFacingLocal = null;
    this.anchorNormalLocal = null;
    chain.end = new RopeAttachment(new RopeContact(hook, hook.hingeOffset()));
  }

  // (settleAnchorOvershoot removed: anchoring at no less than the as-reached
  // length leaves the constraint satisfied, so there is no overshoot to absorb
  // and no anchor to drag off the surface.)

  releaseChain(): void {
    if (this.hookInFlight) this.hookInFlight.world?.remove(this.hookInFlight);
    if (this.chainTip) this.chainTip.world?.remove(this.chainTip);
    this.unmountCuff();
    this.hookInFlight = null;
    this.chainTip = null;
    this.anchorFacingLocal = null;
    this.anchorNormalLocal = null;
    this.anchorBody = null;
    this.anchorOnRail = false;
    this.chain = null;
    this.chainSlack = null;
  }
}
