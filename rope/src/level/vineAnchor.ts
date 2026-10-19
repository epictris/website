// The constraint that ties a vine to its anchor: a point on the anchor body's
// surface to a link's centre, held at or under a rest length.
//
// It is the sibling of `VinePair`, and it does two jobs: the anchor-to-first-
// link joint (and a berry's stalk ropes), and the load rope from the anchor to
// the grabbed link. Vines do not collide with scene geometry at all (see
// `level/vines.ts`, "vines ignore the scenery"), so a vine's load path is a
// straight line by construction, its path is `[anchor, link]` on every frame
// it will ever have, and the wrap machinery a `Rope` carries is work whose
// answer cannot change. It is solved as a row of the vine's island unit
// (`LengthRow` in `level/plantRows.ts`); this class is the data that row is
// built from.
//
// What this has that `VinePair` does not is the TORQUE ARM: the anchor
// contact sits on the anchor body's surface, not at its centre, so if that
// body is rigid (a chain-hung platform, a pivot fin) the row turns it as well
// as moves it.
//
// The rest length is an INEQUALITY, as a rope's is: slack is satisfied. On
// the load rope that is long-range-attachment semantics - the grabbed link
// may be anywhere inside the arc, and is hauled only when the straight-line
// distance would exceed it.

import { RigidBody2D } from "../engine/body";
import { Mathf } from "../engine/mathf";
import type { RopeContact } from "../lib/ropeContact";

export class VineAnchor {
  constructor(
    private readonly a: RopeContact,
    private readonly b: RopeContact,
    // The arc of vine this constraint stands for, in metres. Nothing pays a
    // vine out, so it never moves.
    readonly restLength: number,
  ) {}

  get constraintLength(): number {
    return this.restLength;
  }

  // The two ends, for the island's row of this constraint
  // (`level/plantRows.ts`).
  get ends(): readonly [RopeContact, RopeContact] {
    return [this.a, this.b];
  }

  // How far over its length it stands. Zero while slack: the constraint is an
  // inequality, and a slack line is satisfied.
  get residual(): number {
    return Mathf.max(this.currentLength() - this.restLength, 0);
  }

  currentLength(): number {
    return this.a.globalPosition.distanceTo(this.b.globalPosition);
  }

  eachBody(fn: (body: RigidBody2D) => void): void {
    if (this.a.obj instanceof RigidBody2D) fn(this.a.obj);
    if (this.b.obj instanceof RigidBody2D) fn(this.b.obj);
  }

  holds(body: RigidBody2D): boolean {
    return this.a.obj === body || this.b.obj === body;
  }
}
