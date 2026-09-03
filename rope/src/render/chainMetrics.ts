// Where a chain's links fall along a wrap path. One walk, shared by the 2D
// renderer and the 3D one, because the walk is the part that is easy to get
// wrong and expensive to notice.
//
// Links are laid by ONE continuous arc length measured from `points[0]`, so a
// link straddles a wrap node rather than the run restarting there. That is what
// a chain of rigid links does over a corner, and it is the only form that
// survives a coil: `Rope` re-samples rope wound onto the ball every 0.25 rad,
// which is a node every ~3.1 mm on the rim and SHORTER than one 3.8 mm link, so
// laying links span by span floored every coil step to `floor(3.1/3.8)` = zero
// links. The whole wound-on part of the chain drew as blank space, one node at a
// time as the ball turned, and every CLI tool called the run perfectly healthy
// because it was (session-1467f).
//
// Callers pass the anchored (world-fixed) end FIRST and the ball-side last, so
// as the chain reels the links stay put in the world and the last one is
// consumed into the ball rather than the whole chain compressing toward the
// anchor. The sub-link remainder therefore falls at the far end, under the body.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";

// Link length along the path, and the half-width of the broad (in-plane) link.
// Written as `<px> * PX` because that is what they were tuned as - a fixed
// on-screen size under the 2D renderer's uniform transform - but they are a
// world length either way, which is why the 3D scene can lay the same links in
// metres and get a chain of the right gauge for a 24 cm ball.
export const CHAIN_LINK_LEN = 3.8 * PX;
export const CHAIN_LINK_W = 1.8 * PX;

// Pull a chain path's ANCHOR-side end back along itself by `by` metres, in
// place.
//
// The chain has to stop on the cuff's RIM rather than at its centre, which is
// where the chain's end node is, or the links are drawn straight through the
// middle of it.
export function trimPathStart(points: Vec2[], by: number): void {
  if (points.length < 2 || by <= 0) return;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += points[i]!.distanceTo(points[i + 1]!);
  // Never eat the whole path: a chain reeled almost to the ball still draws as a
  // chain, with the manacle simply overlapping what is left of it.
  let budget = Math.min(by, total * 0.8);
  let i = 0;
  while (i < points.length - 1) {
    const seg = points[i]!.distanceTo(points[i + 1]!);
    if (seg > budget) {
      points[i] = points[i]!.add(points[i]!.directionTo(points[i + 1]!).mul(budget));
      break;
    }
    budget -= seg;
    i++;
  }
  if (i > 0) points.splice(0, i);
}

export interface ChainLink {
  // Centre of the link, in world metres.
  mid: Vec2;
  // Unit vector along the path there.
  dir: Vec2;
  // Alternating: a broad link lies in the plane, a narrow one is the same link
  // seen edge-on. In 3D that is literally a 90 degree twist about the tangent;
  // in 2D it is drawn as a thinner ellipse, which is the same statement.
  //
  // The FIRST link of a walk is the edge-on one. A path is walked from its
  // anchor end, and the ball & chain's anchor end is the manacle - a ring lying
  // in the plane, like a broad link. Two rings in the same plane cannot be
  // linked, and a broad first link was drawn crossing the cuff's band rather
  // than looped over it.
  broad: boolean;
  index: number;
}

// Walk `points` and emit every whole link that fits. Emits nothing for a
// degenerate path (fewer than two distinct points), which is what a chain with
// its ends coincident is.
export function walkChain(points: readonly Vec2[], emit: (link: ChainLink) => void): void {
  // Cumulative arc length at each vertex, skipping degenerate repeats (a wrap
  // node landing on its neighbour) so no link takes its heading from a zero span.
  const verts: Vec2[] = [];
  const at: number[] = [];
  let total = 0;
  for (const p of points) {
    const last = verts[verts.length - 1];
    if (last) {
      const d = last.distanceTo(p);
      if (d < 1e-3 * PX) continue;
      total += d;
    }
    verts.push(p);
    at.push(total);
  }
  if (verts.length < 2) return;

  const n = Math.floor(total / CHAIN_LINK_LEN);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * CHAIN_LINK_LEN;
    while (seg + 2 < verts.length && at[seg + 1]! < s) seg++;
    const a = verts[seg]!;
    const b = verts[seg + 1]!;
    const dir = a.directionTo(b);
    emit({ mid: a.add(dir.mul(s - at[seg]!)), dir, broad: i % 2 === 1, index: i });
  }
}
