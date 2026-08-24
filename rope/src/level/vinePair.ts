// The constraint that holds two adjacent vine links at their spacing.
//
// The load-bearing decision, stated once: a vine's link-to-link joint is a
// **plain two-body distance constraint solved in closed form**, not a `Rope`.
// Everything here is a consequence of that.
//
// Why it was a `Rope`. Making a pair chain a `SceneChain` bought the whole
// existing chain phase for free - the residual-gated alternating sweep, the
// static depenetration with its funded velocity clamp, the credit scaling and
// the blocked-length lease - and that argument still holds. What it also bought
// was the wrap machinery, and that is the part a vine joint cannot use.
//
// A pair chain is DEGENERATE in `Rope`'s terms, in two ways at once, and both
// are structural rather than incidental:
//
//  - Its wrap-candidate list is empty (`NOTHING`), and `Rope.regeneratePath`
//    never wraps a span around the bodies that span starts and ends on, so its
//    path is `[start, end]` on every frame it will ever have. Every span
//    rebuild, path-object build, self-intersection resolve and node cull is
//    therefore work whose answer cannot change.
//  - Both of its contacts sit at a link's CENTRE (`Vec2.ZERO`), deliberately -
//    a link is a 6 cm circle whose whole job is to be somewhere, and a rim
//    contact would give the joint a torque arm on a body whose rotation means
//    nothing. So `calculateTorqueArm` is identically zero and the correction is
//    purely linear, which is the case `correctShapePositionAndRotation`'s whole
//    mass/inertia split reduces to `1/m`.
//
// What that cost, measured on `session-608f`'s stiff 29-link vine: ONE solve of
// one joint made 18 path allocations, 13 span rebuilds, 7 full path-length walks
// and 4 path-object builds, at 5.3 us against 0.05 us for the two-contact
// distance it exists to measure - and the sweep runs ~1200 of those a frame.
//
// Solved in closed form it is the standard PBD distance projection: one step
// lands the pair exactly on the constraint, because a single constraint between
// two bodies has no residual to iterate against. `Rope` reaches the same fixed
// point by iterating to it (`maxIterations`, twice over), which is what a solver
// written for a path of many coupled spans has to do.
//
// It is a `SceneConstraint` and not a `Rope`, for the reason `VineBend` is: the
// chain phase is written against that interface, so the sweep, the depenetration
// and the credit scaling are still bought - and only the solve is its own.
//
// The vine's ANCHOR chain stays a `SceneChain`, and that is not an omission:
// its start is snapped to the anchor body's SURFACE (`snapToSurface`), so if
// that body is a rigid or spring one the joint has a real torque arm and the
// second degeneracy above does not hold. One chain of a vine is not what the
// cost is in.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D, type CollisionObject2D } from "../engine/body";
import { Mathf } from "../engine/mathf";
import { Rope } from "../classes/rope";
import type { RopeContact } from "../lib/ropeContact";
import { VINE_TOLERANCE, type SceneConstraint } from "./chains";

// How many times the projection is re-taken. One is exact for a single
// constraint; the second is the float check that it landed, and is what keeps
// the fixed point the same one `Rope`'s iteration reaches.
const MAX_PROJECTIONS = 2;

// The inverse mass this constraint may move `body` by, in `Rope`'s own terms:
// what `getDynamicBodyState` calls dynamic, with a pivot body's infinite mass
// reading zero. A static reads zero because it is not dynamic at all.
function inverseMass(body: CollisionObject2D): number {
  if (!(body instanceof RigidBody2D)) return 0;
  if (body.pivot) return 0;
  return 1 / body.mass;
}

export class VinePair implements SceneConstraint {
  // Metres of length the joint has accepted as a standing stretch, held as a
  // lease - `Rope.absorbBlockedLength`'s statement. SPAN JOINTS ONLY (see
  // `leased`): a taut span's pairs sit permanently over under their own
  // tension, and the lease banking that residual is what turns their solves
  // into no-ops so the span can be still and sleep. It is safe there exactly
  // because the tight `CHAIN_TOLERANCE` bar keeps the standing residual under
  // `SLACK_RELEASE_RATE`'s per-frame decay (5 mm against 8.3), so the lease
  // hovers instead of ratcheting.
  //
  // A HANGING vine's joints carry no lease, and must not: their exit bar is
  // the loose `VINE_TOLERANCE`, which is ABOVE the decay, and a lease there
  // banks faster than it gives back - a pure ratchet that paid a vine out at
  // ~7 mm a frame for ever (12.4 m of "5 m" vine) when it was tried. Nothing
  // needs it either: a `passable` link is never geometry-blocked, and a
  // hanging vine settles on its damping and sleeps on net displacement.
  private blockedSlack = 0;
  private leaseAtFrameStart = 0;
  private blockedLastFrame = false;
  stalledLength = 0;

  constructor(
    private readonly a: RopeContact,
    private readonly b: RopeContact,
    // The spacing this joint holds, in metres. Nothing pays a vine out, so
    // unlike a rope's `maxRopeLength` it never moves.
    readonly restLength: number,
    // The exit bar the sweep holds this joint to: `VINE_TOLERANCE` on a
    // hanging vine, `CHAIN_TOLERANCE` on a span (see `buildOne`).
    readonly tolerance: number = VINE_TOLERANCE,
    // Whether the standing-stretch lease above is live. Coupled to the
    // tolerance by the builder: tight bar with lease (a span), loose bar
    // without (a hanging vine) - the other two pairings are the ratchet and
    // the ringing this split exists to avoid.
    private readonly leased: boolean = false,
  ) {}

  get constraintLength(): number {
    return this.restLength + this.blockedSlack;
  }

  // How far over its length it ended the pass. Zero while slack: like a rope's,
  // the constraint is an inequality and a slack joint is satisfied.
  get residual(): number {
    return Mathf.max(this.currentLength() - this.constraintLength, 0);
  }

  // Every correction here is honest motion - there is no path to jump, so there
  // is no discontinuity for `Rope.topologyCreditScale` to withhold payment for.
  get creditScale(): number {
    return 1;
  }

  private currentLength(): number {
    return this.a.globalPosition.distanceTo(this.b.globalPosition);
  }

  beginFrame(delta: number): void {
    if (!this.leased) return;
    this.stalledLength = 0;
    this.leaseAtFrameStart = this.blockedSlack;
    if (!this.blockedLastFrame) {
      this.blockedSlack = Mathf.max(this.blockedSlack - Rope.SLACK_RELEASE_RATE * delta, 0);
    }
  }

  solve(delta: number): void {
    const bodyA = this.a.obj;
    const bodyB = this.b.obj;
    const wa = inverseMass(bodyA);
    const wb = inverseMass(bodyB);
    const total = wa + wb;
    // Nothing this joint may move: two statics, or a pair of pivots. `Rope`
    // reads the same case as `totalEffectiveInverseInertia < 1e-6` and returns
    // without correcting.
    if (total < 1e-6) {
      this.absorbBlockedLength();
      return;
    }

    let moveA = 0;
    let moveB = 0;
    let direction = Vec2.ZERO;
    // Taken before anything moves, for the same reason `Rope.solvePass` takes
    // it there: the velocities on the bodies right now are the ones this pass
    // was handed, and what the solve is allowed to be worth is a statement
    // about those.
    let bound = 0;
    let measuredBound = false;

    for (let i = 0; i < MAX_PROJECTIONS; i++) {
      const span = this.b.globalPosition.sub(this.a.globalPosition);
      const length = span.length();
      if (length <= this.constraintLength || length < 1e-9) break;
      // The way the correction hauls A, which is the way that SHORTENS the
      // path; B is hauled the other way. This is `PathStart.directionToNext`
      // and `PathEnd.directionToPrevious`, which for a two-node path are the
      // span's direction and its negation.
      const n = span.div(length);
      if (!measuredBound) {
        // `Rope.creditBound`: the rate the constraint is opening at, summed
        // over the path with each body's mechanical advantage - 1 at both ends
        // of a two-node path. A vine joint is never retracted, so there is no
        // allowance to add. Both contacts sit at their body's centre, so the
        // velocity of the point the constraint acts through is the body's own.
        bound = Mathf.max(velocityOf(bodyB).sub(velocityOf(bodyA)).dot(n), 0);
        direction = n;
        measuredBound = true;
      }
      const error = length - this.constraintLength;
      const da = (error * wa) / total;
      const db = (error * wb) / total;
      if (da > 0) bodyA.globalPosition = bodyA.globalPosition.add(n.mul(da));
      if (db > 0) bodyB.globalPosition = bodyB.globalPosition.sub(n.mul(db));
      moveA += da;
      moveB += db;
    }

    if (measuredBound) {
      // The PBD velocity update, Δposition over Δt, bounded by what the
      // constraint was opening at (`Rope.clampCredit`). The whole credit lies
      // along the pull direction here, so the clamp is a plain minimum rather
      // than a component subtraction.
      credit(bodyA, direction.mul(Math.min(moveA / delta, bound)));
      credit(bodyB, direction.mul(-Math.min(moveB / delta, bound)));
    }

    this.absorbBlockedLength();
  }

  eachBody(fn: (body: RigidBody2D) => void): void {
    if (this.a.obj instanceof RigidBody2D) fn(this.a.obj);
    if (this.b.obj instanceof RigidBody2D) fn(this.b.obj);
  }

  holds(body: RigidBody2D): boolean {
    return this.a.obj === body || this.b.obj === body;
  }

  settle(blocked: boolean): void {
    this.absorbBlockedLength();
    this.blockedLastFrame = blocked;
  }

  // `Rope.absorbBlockedLength`, on a constraint whose length never moves - and
  // only where the lease is live (see the field above). The stall is measured
  // against the lease at FRAME START rather than the released one, so
  // re-earning this frame's instalment reads as the release working rather
  // than as the joint stalling.
  private absorbBlockedLength(): void {
    if (!this.leased) return;
    const blocked = Mathf.max(this.currentLength() - this.restLength, 0);
    this.stalledLength += Mathf.max(
      blocked - Mathf.max(this.blockedSlack, this.leaseAtFrameStart),
      0,
    );
    this.blockedSlack = Mathf.max(this.blockedSlack, blocked);
  }
}

// The velocity of the point this constraint acts through. Both contacts sit at
// their body's centre, so a rotation contributes nothing - which is why the
// kinematic-rotation exclusion `Rope.velocityAt` has to make does not arise.
function velocityOf(body: CollisionObject2D): Vec2 {
  return body instanceof RigidBody2D ? body.linearVelocity : Vec2.ZERO;
}

function credit(body: CollisionObject2D, velocity: Vec2): void {
  if (!(body instanceof RigidBody2D)) return;
  // A pivot body's axle never moves, so there is no Δposition to be paid for.
  if (body.pivot) return;
  body.linearVelocity = body.linearVelocity.add(velocity);
}
