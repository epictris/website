// The two constraints between adjacent vine links: the joint's ceiling
// (`VinePair`) and, on a stiff vine, its floor (`VineStrut`).
//
// Both are plain two-body distance constraints between link CENTRES, not
// `Rope`s, and both are solved as rows of the vine's island unit
// (`LengthRow` in `level/plantRows.ts`); these classes are the data those rows
// are built from.
//
// Why not a `Rope`. A pair chain is DEGENERATE in `Rope`'s terms, in two ways
// at once, and both are structural rather than incidental:
//
//  - Its wrap-candidate list is empty (`NOTHING`), and `Rope.regeneratePath`
//    never wraps a span around the bodies that span starts and ends on, so its
//    path is `[start, end]` on every frame it will ever have. Every span
//    rebuild, path-object build, self-intersection resolve and node cull is
//    therefore work whose answer cannot change.
//  - Both of its contacts sit at a link's CENTRE (`Vec2.ZERO`), deliberately -
//    a link is a 6 cm circle whose whole job is to be somewhere, and a rim
//    contact would give the joint a torque arm on a body whose rotation means
//    nothing. So the torque arm is identically zero and the row is purely
//    linear.
//
// What that cost as a `Rope`, measured on `session-608f`'s stiff 29-link vine:
// ONE solve of one joint made 18 path allocations, 13 span rebuilds, 7 full
// path-length walks and 4 path-object builds, at 5.3 us against 0.05 us for the
// two-contact distance it exists to measure.

import { RigidBody2D } from "../engine/body";
import { Mathf } from "../engine/mathf";
import type { RopeContact } from "../lib/ropeContact";

export class VinePair {
  constructor(
    private readonly a: RopeContact,
    private readonly b: RopeContact,
    // The spacing this joint holds, in metres. Nothing pays a vine out, so
    // unlike a rope's `maxRopeLength` it never moves.
    readonly restLength: number,
  ) {}

  get constraintLength(): number {
    return this.restLength;
  }

  // The two ends, for the island's row of this joint (`level/plantRows.ts`).
  get ends(): readonly [RopeContact, RopeContact] {
    return [this.a, this.b];
  }

  // How far over its length the joint stands. Zero while slack: like a rope's,
  // the constraint is an inequality and a slack joint is satisfied.
  get residual(): number {
    return Mathf.max(this.a.globalPosition.distanceTo(this.b.globalPosition) - this.restLength, 0);
  }

  eachBody(fn: (body: RigidBody2D) => void): void {
    if (this.a.obj instanceof RigidBody2D) fn(this.a.obj);
    if (this.b.obj instanceof RigidBody2D) fn(this.b.obj);
  }

  holds(body: RigidBody2D): boolean {
    return this.a.obj === body || this.b.obj === body;
  }
}

// The other half of a STIFF vine's joint: the floor under its length, where a
// `VinePair` is the ceiling over it.
//
// A pair is a rope's joint - it refuses to stretch and is satisfied slack - and
// on a limp vine that is the truth: a rope pushed end to end folds. A stiff
// vine's bends (`VineBend`) then had nothing to argue with but the stretch, and
// straightened a span by letting its links pile into each other instead: a
// 3 m span between anchors 1.49 m apart (testing.json) settled as a nearly
// straight line 1.8 m long, 753 mm off the catenary it is drawn as, its slack
// gone into overlapping links. A rod does not shorten under bending, so a
// stiff vine's joints hold a floor as well: no shorter than the spacing less
// `STRUT_GIVE`, the band between floor and ceiling being what keeps the two
// from grinding at one length.
export class VineStrut {
  constructor(
    private readonly a: RopeContact,
    private readonly b: RopeContact,
    // The shortest this joint may be, metres.
    readonly minLength: number,
  ) {}

  get ends(): readonly [RopeContact, RopeContact] {
    return [this.a, this.b];
  }
}

// The give between a stiff vine's floor and its ceiling, metres: the joint may
// be anywhere from its length less this to its length, the same give the
// hanging vine's long-range attachments leave (`VINE_LRA_GIVE`), so a strut and
// a pair are never asked for one length.
export const STRUT_GIVE = 0.005;
