// The constraint that ties a vine to its anchor: a point on the anchor body's
// surface to a link's centre, held at or under a rest length.
//
// It is the closed-form sibling of `VinePair`, and it exists because the two
// jobs it does - the anchor-to-first-link pair chain, and the load rope from
// the anchor to the grabbed link - stopped needing the one thing that made
// them `SceneChain`s: the wrap machinery. Vines no longer collide with scene
// geometry at all (see `level/vines.ts`, "vines ignore the scenery"), so a
// vine's load path is a straight line by construction, its path is
// `[anchor, link]` on every frame it will ever have, and every span rebuild
// and wrap scan a `Rope` runs is work whose answer cannot change. `VinePair`
// measured that class of swap at 0.14 us against 1.6 per solve; the load rope
// was the dearer case again, a full `Rope.solvePass` per coupled sweep.
//
// What this keeps that `VinePair` does not have is the TORQUE ARM: the anchor
// contact sits on the anchor body's surface, not at its centre, so if that
// body is rigid (a chain-hung platform, a pivot fin) the correction has to
// turn it as well as move it. The solve is the standard PBD point-distance
// projection with the rotational term in the effective mass -
// `w = 1/m + (r x n)^2 / I` - which reduces to `VinePair`'s `1/m` exactly
// when the contact is at the centre, covers a pivot body (inverse mass 0,
// real inverse inertia: the correction lands wholly in rotation about the
// axle) and a spring body (inverse inertia 0: wholly in translation), and
// leaves a static as infinite mass.
//
// The rest length is an INEQUALITY, as a rope's is: slack is satisfied. On
// the load rope that is long-range-attachment semantics - the grabbed link
// may be anywhere inside the arc, and is hauled only when the straight-line
// distance would exceed it - which with the routing gone is the whole of what
// the load rope means.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D, type CollisionObject2D } from "../engine/body";
import { Mathf } from "../engine/mathf";
import { Rope } from "../classes/rope";
import type { RopeContact } from "../lib/ropeContact";
import { VINE_TOLERANCE, type SceneConstraint } from "./chains";

// As `VinePair`: one projection is exact for a single constraint, the second
// is the float check that it landed.
const MAX_PROJECTIONS = 2;

// The generalized inverse mass of `body` at a contact `r` from its centre,
// against a correction along `n`. Zero for anything the constraint may not
// move; `RigidBody2D.inverseMass` already reads 0 for a pivot and
// `inverseInertia` 0 for a spring body, so both fall out of the one formula.
function effectiveInverse(body: CollisionObject2D, r: Vec2, n: Vec2): number {
  if (!(body instanceof RigidBody2D)) return 0;
  const rxn = r.cross(n);
  return body.inverseMass + body.inverseInertia * rxn * rxn;
}

export class VineAnchor implements SceneConstraint {
  // The standing-stretch lease, live on SPAN end joints only - the same
  // split, for the same two failure modes, as `VinePair`'s (see the long note
  // there): a taut span's joints must be allowed to accept their standing
  // residual or the span rings for ever, and a loose-bar joint must not carry
  // a lease or it ratchets the vine out for ever.
  private blockedSlack = 0;
  private leaseAtFrameStart = 0;
  private blockedLastFrame = false;
  stalledLength = 0;

  constructor(
    private readonly a: RopeContact,
    private readonly b: RopeContact,
    // The arc of vine this constraint stands for, in metres. Nothing pays a
    // vine out, so it never moves.
    readonly restLength: number,
    // The exit bar the sweep holds this constraint to. A hanging vine's own
    // joints take `VINE_TOLERANCE`; a span's end joints and every LOAD rope
    // take `CHAIN_TOLERANCE` - the load rope because it is the line the
    // player hangs from, and its solve is closed-form anyway.
    readonly tolerance: number = VINE_TOLERANCE,
    // Whether the lease is live - span end joints only, paired with the tight
    // bar by the builder (see `VinePair.leased`).
    private readonly leased: boolean = false,
  ) {}

  get constraintLength(): number {
    return this.restLength + this.blockedSlack;
  }

  // How far over its length it ended the pass. Zero while slack: the
  // constraint is an inequality, and a slack line is satisfied.
  get residual(): number {
    return Mathf.max(this.currentLength() - this.constraintLength, 0);
  }

  // Every correction here is honest motion - there is no path to jump.
  get creditScale(): number {
    return 1;
  }

  currentLength(): number {
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

    let movedA = 0;
    let movedB = 0;
    let direction = Vec2.ZERO;
    // Taken before anything moves, as `VinePair` does: what the solve may be
    // paid is a statement about the velocities this pass was handed.
    let bound = 0;
    let measuredBound = false;

    for (let i = 0; i < MAX_PROJECTIONS; i++) {
      const pa = this.a.globalPosition;
      const pb = this.b.globalPosition;
      const span = pb.sub(pa);
      const length = span.length();
      if (length <= this.constraintLength || length < 1e-9) break;
      const n = span.div(length);
      const ra = pa.sub(bodyA.globalPosition);
      const rb = pb.sub(bodyB.globalPosition);
      const wa = effectiveInverse(bodyA, ra, n);
      const wb = effectiveInverse(bodyB, rb, n);
      const total = wa + wb;
      // Nothing this constraint may move. `Rope` reads the same case as
      // `totalEffectiveInverseInertia < 1e-6` and returns without correcting.
      if (total < 1e-6) break;
      if (!measuredBound) {
        // `Rope.creditBound`: the rate the constraint is opening at. The
        // anchor contact rides its body's rotation, so its point velocity
        // carries the `w x r` term a centre contact does not have.
        bound = Mathf.max(velocityAt(bodyB, rb).sub(velocityAt(bodyA, ra)).dot(n), 0);
        direction = n;
        measuredBound = true;
      }
      const error = length - this.constraintLength;
      const impulse = error / total;
      applyCorrection(bodyA, ra, n, impulse);
      applyCorrection(bodyB, rb, n.mul(-1), impulse);
      movedA += impulse * wa;
      movedB += impulse * wb;
    }

    if (measuredBound) {
      // The PBD velocity update, Δposition over Δt, bounded by what the
      // constraint was opening at. `settleChainBodies` rewrites the phase's
      // final velocities from the whole displacement; this in-sweep credit is
      // what the bounds of the other constraints in the sweep read.
      credit(bodyA, direction.mul(Math.min(movedA / delta, bound)));
      credit(bodyB, direction.mul(-Math.min(movedB / delta, bound)));
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

// One body's share of a projection: translate by its inverse mass, turn by the
// torque the contact's lever arm carries. `n` is the direction that hauls THIS
// body; the caller negates it for the other side.
function applyCorrection(body: CollisionObject2D, r: Vec2, n: Vec2, impulse: number): void {
  if (!(body instanceof RigidBody2D)) return;
  if (body.inverseMass > 0) {
    body.globalPosition = body.globalPosition.add(n.mul(impulse * body.inverseMass));
  }
  if (body.inverseInertia > 0) {
    body.globalRotation += body.inverseInertia * r.cross(n) * impulse;
  }
}

// The velocity of the material point `r` from the body's centre.
function velocityAt(body: CollisionObject2D, r: Vec2): Vec2 {
  if (!(body instanceof RigidBody2D)) return Vec2.ZERO;
  const w = body.angularVelocity;
  return body.linearVelocity.add(new Vec2(-w * r.y, w * r.x));
}

function credit(body: CollisionObject2D, velocity: Vec2): void {
  if (!(body instanceof RigidBody2D)) return;
  if (body.pivot) return;
  body.linearVelocity = body.linearVelocity.add(velocity);
}
