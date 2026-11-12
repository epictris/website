// Where a chain's links fall along a wrap path. One walk, shared by the 2D
// renderer and the 3D one, because the walk is the part that is easy to get
// wrong and expensive to notice.
//
// Links are laid by ONE continuous arc length measured from `points[0]`, so a
// link straddles a wrap node rather than the run restarting there. That is what
// a chain of rigid links does over a corner, and it is the only form that
// survives a coil: `Rope` re-samples rope wound onto the ball every 0.25 rad,
// which is a node every ~3.1 cm on the rim and SHORTER than one link (3.8 cm
// then, 3.7 now), so laying links span by span floored every coil step to zero
// links. The whole wound-on part of the chain drew as blank space, one node at a
// time as the ball turned, and every CLI tool called the run perfectly healthy
// because it was (session-1467f).
//
// Callers pass the anchored (world-fixed) end FIRST and the ball-side last, so
// as the chain reels the links stay put in the world and the last one is
// consumed into the ball rather than the whole chain compressing toward the
// anchor. The sub-link remainder therefore falls at the far end, under the body.
//
// The ball's chain is laid at the pitch `chainLinkPitch` gives, so the number
// of links out of the ball is its length's, never its drawn polyline's.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";

// The ball model's forged loop (`iron-ball.glb`), measured off the file: an
// exact torus (0.01 mm residual) lying in the gameplay plane, its hole facing
// the camera, its centre 1.020 ball radii from the ball's centre, its inner
// radius 0.112 and outer 0.222 ball radii. The ball's own feet are buried in
// the surface, so it stands as an arch. In ball radii so the loop scales with
// the ball as the model does (`BallVisual`).
export const BALL_LOOP_CENTRE = 1.02;
export const BALL_LOOP_INNER = 0.112;
export const BALL_LOOP_OUTER = 0.222;
// The ball every level plays: the authored 8 px avatar at
// `BallLevel.BALL_RADIUS_SCALE` 1.5, 12 cm.
const BALL_RADIUS = 0.12;

// A link is a real short-link chain's (DIN 766, proof coil): a round bar bent
// into a stadium - two straight sides, two semicircular ends - whose INSIDE is
// 2.8 bar diameters long and 1.4 wide. Everything is derived from the bar, so
// the chain stays in proportion if the gauge ever changes.
//
// The bar stock a link is forged from, as a radius: what the 3D chain draws a
// link's section at, and the pin a link turns on where it hooks a body (the
// physics' pin friction, `level/chains.ts`). The loop's own bar (Tris,
// 2026-11-12: the links the same thickness as the ball's loop), 13.2 mm
// across on the 12 cm ball: a DIN 766 13 x 36 chain. 10 mm and 12 mm were
// tried the same day and Tris kept this.
export const CHAIN_LINK_BAR = ((BALL_LOOP_OUTER - BALL_LOOP_INNER) / 2) * BALL_RADIUS;
const BAR_D = 2 * CHAIN_LINK_BAR;
// The pitch: how far apart along the path neighbouring links fall. In a chain
// under load that is exactly a link's inside length - each link's end bar sits
// against the inside of the next one's - so it is also the inside length.
export const CHAIN_LINK_LEN = 2.8 * BAR_D;
// The inside width of a link.
const CHAIN_LINK_INNER_W = 1.4 * BAR_D;
// The bar's centreline, which is what both renderers draw round: the radius of
// a link's two end bends (and so half its centreline width), and the half
// length of its straight sides.
export const CHAIN_LINK_BEND = CHAIN_LINK_INNER_W / 2 + CHAIN_LINK_BAR;
export const CHAIN_LINK_SIDE = (CHAIN_LINK_LEN - CHAIN_LINK_INNER_W) / 2;

export interface ChainLink {
  // Centre of the link, in world metres: the midpoint of its chord (see
  // `walkChain`), which cuts inside a bend rather than sitting on the path.
  mid: Vec2;
  // Unit vector along the link's chord, end to end.
  dir: Vec2;
  // Alternating: a broad link lies in the plane, a narrow one is the same link
  // seen edge-on. In 3D that is literally a 90 degree twist about the tangent;
  // in 2D it is drawn as a thinner ellipse, which is the same statement.
  //
  // The FIRST link of a walk is the edge-on one. A path is walked from its
  // anchor end, and the ball & chain's anchor end is the manacle's hinge pin,
  // whose axis lies in the plane (the ring is seen edge-on, see lib/manacle):
  // a link hooked through a pin hangs in the plane square to that pin, which
  // is the plane the camera looks along - the edge-on link.
  broad: boolean;
  index: number;
  // Arc length from `points[0]` to the link's centre along the path.
  at: number;
}

// The pitch to lay the ball's chain at along its drawn polyline (loop to
// anchor, `drawnPath`), so that exactly `length / CHAIN_LINK_LEN` links fit
// between the cuff and the loop: the NUMBER of links out of the ball is the
// chain's length, never the polyline's. The drape only converges toward its
// length, so the polyline runs a few percent long and breathes, and at a
// fixed pitch every change in it slid the links along the chain and out of
// the ball or back in (`session-339f`: 22 cm out and 12 cm back, the chain's
// length never changing). The drape's error shows as a link drawn a few
// percent long instead, and taut - where the polyline IS the length - the
// pitch is exactly `CHAIN_LINK_LEN`.
export function chainLinkPitch(drawnPath: readonly Vec2[], length: number): number {
  let drawn = 0;
  for (let i = 1; i < drawnPath.length; i++) drawn += drawnPath[i - 1]!.distanceTo(drawnPath[i]!);
  if (!(length > 0) || !(drawn > 0)) return CHAIN_LINK_LEN;
  return (CHAIN_LINK_LEN * drawn) / length;
}

// Walk `points` and emit every whole link that fits, one every `pitch` of arc
// length. Emits nothing for a degenerate path (fewer than two distinct
// points), which is what a chain with its ends coincident is.
//
// `count`, when given, is how many links to lay instead of as many as fit: the
// ball's shackled chain, whose pitch was chosen to fit exactly that many
// (`ballChainLayout`), where flooring the quotient could lose the last one to
// rounding.
export function walkChain(
  points: readonly Vec2[],
  emit: (link: ChainLink) => void,
  pitch: number = CHAIN_LINK_LEN,
  count?: number,
): void {
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

  // A link is laid as the CHORD between its two ends on the path, at `s ± pitch/2`,
  // which is what a rigid link on a chain is: its end bars hooked into its
  // neighbours, which share those ends. Its heading and centre then turn
  // smoothly as it rounds a bend. Taken from the one span its centre fell on
  // instead, a link at a sharp kink of the drape (a chain heaped on the ground
  // bends ~85 degrees between 2.8 cm segments, shorter than a link) snapped
  // between the two spans' headings on every sub-millimetre jiggle of the
  // node it straddled - a link flipping a quarter turn back and forth under a
  // ball lying still (`session-685f` f600-685). Each end keeps its own cursor:
  // both only move forward.
  let lo = 0;
  let hi = 0;
  const pointAt = (s: number, seg: number): Vec2 => {
    const a = verts[seg]!;
    return a.add(a.directionTo(verts[seg + 1]!).mul(s - at[seg]!));
  };
  const n = count ?? Math.floor(total / pitch);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) * pitch;
    const sLo = i * pitch;
    const sHi = (i + 1) * pitch;
    while (seg + 2 < verts.length && at[seg + 1]! < s) seg++;
    while (lo + 2 < verts.length && at[lo + 1]! < sLo) lo++;
    while (hi + 2 < verts.length && at[hi + 1]! < sHi) hi++;
    const from = pointAt(sLo, lo);
    const to = pointAt(sHi, hi);
    const chord = to.sub(from);
    // A link folded back on itself (a hairpin as tight as the link, its two
    // ends meeting) has no chord to lie along: it takes its centre's span.
    if (chord.length() < pitch * 1e-3) {
      const a = verts[seg]!;
      const dir = a.directionTo(verts[seg + 1]!);
      emit({ mid: a.add(dir.mul(s - at[seg]!)), dir, broad: i % 2 === 1, index: i, at: s });
      continue;
    }
    emit({ mid: from.add(chord.mul(0.5)), dir: chord.normalized(), broad: i % 2 === 1, index: i, at: s });
  }
}
