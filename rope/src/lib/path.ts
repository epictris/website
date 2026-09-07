// Bezier-path geometry: flattening a node list with cubic tangent handles into
// a polyline, walking arc length along it, and projecting a point onto it. Pure
// functions with no controller state and no DOM, so they are checked directly
// by `cli camera` and `cli movers` rather than through a level.
//
// SHARED, and that is the point of it being here rather than beside either
// caller. A camera path (`CameraPathData`) and a body's travel route
// (`LevelBodyData.moveNodes`) are the same object - an authored curve with a
// direction and an arc length - and the two would otherwise carry two
// flatteners, two arc-length indices and two answers to "where is s metres
// along this". The camera reads it render-side; the mover build reads it
// sim-side, which is why nothing in here may touch a clock or a DOM.
//
// FRAME. An index is built in WORLD space: the local nodes are transformed by
// an (origin, rot) once at construction and never again, since nothing mutates
// a path at runtime. Every function here therefore takes and returns world
// points and no caller transforms anything - unlike `pointInRegion`, which
// tests in the region's local frame because a rect and a polygon have no world
// form to test against.
//
// ARC LENGTH is the coordinate everything is expressed in: `s` metres from the
// first node along the polyline. It is what makes "the camera leads the player
// by `lookahead` metres" and "the cart is `s` metres round the track" a single
// addition, and it is monotone along the path even where the path passes near
// itself, which is what the camera's windowed projection below leans on.

import { dmath } from "../engine/dmath";
import { Vec2 } from "../engine/vec2";

// Below this a segment has no direction to project onto and is treated as a
// point: duplicate consecutive verts are legal input (the editor's dedupe is a
// convenience, not a guarantee) and must contribute zero length rather than a
// division by zero.
const MIN_SEGMENT = 1e-12;

// One node of a path as the geometry deals with it: a point and its two tangent
// handles, as offsets from that point. Both zero = a corner.
export interface PathNode {
  p: Vec2;
  in: Vec2;
  out: Vec2;
}

// Metres of control polygon per flattening sample. A cubic never strays further
// from its control polygon than the polygon's own slack, so sampling at this
// spacing keeps the chordal error well under a centimetre on the segment lengths
// a level authors - far below the metres `range` is measured in.
export const PATH_FLATTEN_STEP = 0.25;

// Hard cap per edge, so a pathological handle (one dragged a hundred metres out)
// cannot turn one authored node into thousands of points.
const MAX_SAMPLES_PER_EDGE = 64;

// The on-disk node form as the geometry's own, with absent handles read as zero.
// One conversion, so the level format's optional fields and this module's plain
// vectors cannot drift apart about what "no handle" means.
export function pathNodesOf(
  verts: readonly { x: number; y: number; inX?: number; inY?: number; outX?: number; outY?: number }[],
): PathNode[] {
  return verts.map((v) => ({
    p: new Vec2(v.x, v.y),
    in: new Vec2(v.inX ?? 0, v.inY ?? 0),
    out: new Vec2(v.outX ?? 0, v.outY ?? 0),
  }));
}

// A node list as the polyline everything downstream rides.
//
// This is the whole of what curved paths cost. The camera, the projection, the
// arc length, the corridor and the debug overlay all work on a polyline, and a
// flattened cubic IS one - so the curve is a property of how the points are
// produced and of nothing else. Sampling density is what buys the smoothness,
// and `CAMERA_FOLLOW_TAU` takes care of whatever is left.
//
// An edge whose two facing handles are both zero contributes NOTHING but its
// endpoint, so a path of corners flattens to exactly its own nodes and every
// polyline path is bit-identical to what it was before handles existed.
export function flattenPath(nodes: readonly PathNode[]): Vec2[] {
  return flattenPathNodes(nodes).points;
}

// The same flattening, also answering WHERE each authored node landed in the
// polyline - `nodeAt[i]` is the index of node i's own point in `points`. A
// node's keys (see `CameraPathVert`) are read off at its arc length, and the
// arc length of a node is only known once the curve into it is flattened; a
// key looked up by node index alone would sit at the wrong `s` on any curved
// edge.
export function flattenPathNodes(nodes: readonly PathNode[]): {
  points: Vec2[];
  nodeAt: number[];
} {
  if (nodes.length === 0) return { points: [], nodeAt: [] };
  const out: Vec2[] = [nodes[0]!.p];
  const nodeAt: number[] = [0];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    const c1 = a.p.add(a.out);
    const c2 = b.p.add(b.in);
    if (a.out.lengthSquared() === 0 && b.in.lengthSquared() === 0) {
      out.push(b.p);
      nodeAt.push(out.length - 1);
      continue;
    }
    const control = a.p.distanceTo(c1) + c1.distanceTo(c2) + c2.distanceTo(b.p);
    const n = Math.min(MAX_SAMPLES_PER_EDGE, Math.max(2, Math.ceil(control / PATH_FLATTEN_STEP)));
    for (let k = 1; k <= n; k++) out.push(cubicAt(a.p, c1, c2, b.p, k / n));
    // The last sample is t = 1, which is exactly the node.
    nodeAt.push(out.length - 1);
  }
  return { points: out, nodeAt };
}

// De Casteljau, written out: a cubic at parameter t.
export function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return p0
    .mul(u * u * u)
    .add(p1.mul(3 * u * u * t))
    .add(p2.mul(3 * u * t * t))
    .add(p3.mul(t * t * t));
}

// The distance along `dir` that lands on the ellipse with semi-axes `ax`, `ay`.
//
// This is how every per-axis distance on a path is resolved into the one arc
// length the geometry deals in: moving by `L` along `dir` displaces by
// `L * dir`, and this is the `L` that puts that displacement on the ellipse. So
// a horizontal route takes `ax`, a vertical one `ay`, and a diagonal what fits
// between - which is the whole point of the pairs, since a 16:9 frame has far
// less screen above and below the player than either side of them.
//
// `dir` need not be normalised, and a zero one answers `ax`: a path with
// nowhere left to go is horizontal as far as this is concerned.
//
// Here rather than in the controller because the corridor SWEEP in
// `shapePath.ts` resolves the same ellipse at every sample it draws, and the
// drawing must not depend on the controller.
export function ellipseReach(ax: number, ay: number, dir: Vec2): number {
  const a = Math.max(1e-6, ax);
  const b = Math.max(1e-6, ay);
  const len = dir.length();
  if (len < 1e-9) return a;
  return 1 / dmath.hypot(dir.x / len / a, dir.y / len / b);
}

export interface PolylineIndex {
  // World-space verts in direction-of-travel order.
  verts: Vec2[];
  // cum[i] = arc length from verts[0] to verts[i]. Same length as `verts`.
  cum: number[];
  total: number;
  // nodeS[i] = arc length of the i-th AUTHORED node, when the polyline came
  // from `flattenPathNodes` and the caller said so; empty when it did not.
  // It is what a node's keys are placed at along the route.
  nodeS: number[];
}

export function buildPolylineIndex(
  verts: readonly Vec2[],
  origin: Vec2 = Vec2.ZERO,
  rot = 0,
  // Index into `verts` of each authored node (see `flattenPathNodes`).
  nodeAt: readonly number[] = [],
): PolylineIndex {
  const world = verts.map((v) => v.rotated(rot).add(origin));
  const cum: number[] = world.length ? [0] : [];
  for (let i = 1; i < world.length; i++) {
    cum.push(cum[i - 1]! + world[i]!.distanceTo(world[i - 1]!));
  }
  return {
    verts: world,
    cum,
    total: cum.length ? cum[cum.length - 1]! : 0,
    nodeS: nodeAt.map((i) => cum[i] ?? 0),
  };
}

// The world point at arc length `s`, clamped to [0, total]. Clamping is the
// correct degenerate behaviour for the lookahead target: near the end of the
// path the camera comes to rest on the end rather than sliding off past it.
export function pointAtArcLength(ix: PolylineIndex, s: number): Vec2 {
  const { verts, cum } = ix;
  if (verts.length === 0) return Vec2.ZERO;
  const t = Math.min(Math.max(s, 0), ix.total);
  for (let i = 0; i + 1 < verts.length; i++) {
    const s0 = cum[i]!;
    const s1 = cum[i + 1]!;
    if (t > s1) continue;
    const len = s1 - s0;
    // A zero-length segment holds no interval, so `t` belongs to whichever
    // segment after it does.
    if (len < MIN_SEGMENT) continue;
    return verts[i]!.add(verts[i + 1]!.sub(verts[i]!).mul((t - s0) / len));
  }
  return verts[verts.length - 1]!;
}

// The closest point on the polyline to `p`, as the arc length of that point and
// the distance to it.
export function projectOntoPolyline(ix: PolylineIndex, p: Vec2): { s: number; dist: number } {
  return projectRange(ix, p, 0, ix.total);
}

// The same, restricted to arc lengths in [sMin, sMax].
//
// This exists because the global query is DISCONTINUOUS wherever the path
// passes near itself: on a switchback one frame's projection can teleport many
// metres of arc length, taking the lookahead target with it, and no blend can
// help because the rule in force has not changed. Confining the query to a
// window around last frame's answer keeps the projection on the branch the
// player is actually riding, and lets the distance to that branch grow past the
// release threshold instead of silently jumping to the other one.
export function projectOntoPolylineWindow(
  ix: PolylineIndex,
  p: Vec2,
  sMin: number,
  sMax: number,
): { s: number; dist: number } {
  const lo = Math.min(Math.max(sMin, 0), ix.total);
  const hi = Math.min(Math.max(sMax, lo), ix.total);
  return projectRange(ix, p, lo, hi);
}

function projectRange(
  ix: PolylineIndex,
  p: Vec2,
  sLo: number,
  sHi: number,
): { s: number; dist: number } {
  const { verts, cum } = ix;
  let bestS = sLo;
  let bestDist = Infinity;
  for (let i = 0; i + 1 < verts.length; i++) {
    const s0 = cum[i]!;
    const s1 = cum[i + 1]!;
    const lo = Math.max(s0, sLo);
    const hi = Math.min(s1, sHi);
    if (lo > hi) continue;
    const len = s1 - s0;
    const a = verts[i]!;
    let s = lo;
    if (len >= MIN_SEGMENT) {
      const d = verts[i + 1]!.sub(a);
      const along = s0 + (p.sub(a).dot(d) / (len * len)) * len;
      s = Math.min(hi, Math.max(lo, along));
    }
    const q = len >= MIN_SEGMENT ? a.add(verts[i + 1]!.sub(a).mul((s - s0) / len)) : a;
    const dist = q.distanceTo(p);
    // Strictly closer, so a tie at a shared vertex keeps the earlier segment -
    // which reports the same `s` either way, the corner being one point.
    if (dist < bestDist) {
      bestDist = dist;
      bestS = s;
    }
  }
  if (bestDist === Infinity) {
    // No segment overlapped the window: a path of coincident verts, or one
    // whose only segments are zero-length. The clamped point is still an answer.
    const s = Math.min(Math.max(sLo, 0), ix.total);
    return { s, dist: pointAtArcLength(ix, s).distanceTo(p) };
  }
  return { s: bestS, dist: bestDist };
}

// How much arc length either side of `s` the tangent below is measured over.
//
// A corner therefore turns a body aligned to the route over half a metre of
// track rather than in one frame. The number is a statement about how sharply a
// rideable thing may turn, which is why it is a length rather than a count of
// samples: measured between adjacent polyline vertices instead, a corner between
// two straight legs would spread its whole turn over an entire 4 m leg (a
// straight leg flattens to its two endpoints) while the same corner on a curved
// one turned within centimetres - the same authored shape reading differently
// for a reason that is about the flattener rather than about the route.
export const TANGENT_WINDOW = 0.25;

// The direction the route runs at arc length `s`, as a unit vector, clamped to
// [0, total] like `pointAtArcLength`.
//
// Read off the flattened polyline rather than differentiated from the cubic, so
// it is the tangent of the curve everything ELSE rides: a body aligned to the
// route and the route it is drawn on cannot disagree about which way the track
// points.
//
// The chord across a WINDOW rather than the segment's own direction, and that is
// the whole of the function. A segment's direction is constant along it, so
// answering with it makes the tangent a STAIRCASE - a body aligned to the route
// would hold one angle for a whole segment and then turn the entire
// segment-to-segment angle on the single frame it crossed the vertex, which is a
// jerk on screen and a contact-velocity spike for anything riding it. On a
// smooth stretch the chord's direction is the tangent at its midpoint, so the
// window costs a curve nothing; what it spreads is a CORNER, over
// `TANGENT_WINDOW` either side of it.
//
// The window clamps at the ends of an OPEN route, so the tangent at `s = 0` is
// the direction the route sets off in over its first quarter-metre - which is
// the right answer to "which way does this start". A `closed` route has no ends
// to clamp at and wraps instead; see below for why that is load-bearing.
//
// A degenerate path (one point, or all points coincident, or a route shorter
// than the window that doubles back on itself) answers `Vec2.RIGHT`, the same
// nothing-to-go-on default `ellipseReach` takes.
export function tangentAtArcLength(ix: PolylineIndex, s: number, closed = false): Vec2 {
  if (ix.verts.length < 2 || ix.total <= 0) return Vec2.RIGHT;
  const total = ix.total;
  // A CLOSED route has no ends, so the window must not clamp at them: it wraps,
  // and the two samples straddle the seam exactly as they straddle any other
  // point. Clamped, the seam frame reads two one-sided chords over opposite
  // halves of the window, which differ by the route's own turn across it - on a
  // 2 m circuit that is 0.13 rad delivered in one frame, an 8 rad/s kick handed
  // to whatever is riding the platform. It is the same seam `buildMoveRoute`
  // repeats node zero's keys across and the same one `repeat` guards with
  // `teleported`; the tangent needs its own answer to it.
  if (closed) {
    const t = ((s % total) + total) % total;
    const at = (x: number): Vec2 => pointAtArcLength(ix, ((x % total) + total) % total);
    const d = at(t + TANGENT_WINDOW).sub(at(t - TANGENT_WINDOW));
    return d.lengthSquared() < 1e-18 ? Vec2.RIGHT : d.normalized();
  }
  const t = Math.min(Math.max(s, 0), total);
  const lo = Math.max(0, t - TANGENT_WINDOW);
  const hi = Math.min(total, t + TANGENT_WINDOW);
  const d = pointAtArcLength(ix, hi).sub(pointAtArcLength(ix, lo));
  return d.lengthSquared() < 1e-18 ? Vec2.RIGHT : d.normalized();
}

// The angle of that direction. Its own function because both callers want the
// angle rather than the vector, and `atan2` on a tangent is the kind of line
// that gets written slightly differently in two places.
export function tangentAngleAt(ix: PolylineIndex, s: number, closed = false): number {
  const d = tangentAtArcLength(ix, s, closed);
  return dmath.atan2(d.y, d.x);
}

// One cubic edge split at t = 1/2, as the four handle offsets the split leaves
// behind: the edge's own two are shortened and the new node between them gets a
// pair of its own.
//
// De Casteljau, so the two halves TOGETHER are the curve that was there - a
// bowed edge gains a node and changes shape by nothing. Splitting the chord
// instead would straighten the edge the moment it was subdivided, which is the
// one thing an insert must not do.
//
// Offsets rather than control points, because that is how both node forms store
// a handle (see `PathNode`): the caller writes them straight onto the nodes.
export function splitCubicAtHalf(
  a: PathNode,
  b: PathNode,
): { mid: Vec2; outA: Vec2; inB: Vec2; inMid: Vec2; outMid: Vec2 } {
  const c1 = a.p.add(a.out);
  const c2 = b.p.add(b.in);
  const m1 = a.p.add(c1).mul(0.5);
  const m2 = c1.add(c2).mul(0.5);
  const m3 = c2.add(b.p).mul(0.5);
  const n1 = m1.add(m2).mul(0.5);
  const n2 = m2.add(m3).mul(0.5);
  const mid = n1.add(n2).mul(0.5);
  return { mid, outA: m1.sub(a.p), inB: m3.sub(b.p), inMid: n1.sub(mid), outMid: n2.sub(mid) };
}

// The Catmull-Rom tangent at every node: a third of the chord between a node's
// two neighbours, which is the standard interpolating spline and what "smooth
// this" means - the curve still passes through every authored point and only
// the way it arrives at them changes. End nodes take the one neighbour they
// have, so a two-node path smooths to exactly the straight line it already was.
//
// `wrap` treats the list as a closed loop, so a route that comes back round to
// its first node is smooth THROUGH it rather than cornering there.
export function smoothTangents(
  points: readonly Vec2[],
  wrap = false,
): { in: Vec2; out: Vec2 }[] {
  const n = points.length;
  return points.map((p, i) => {
    const prev = points[wrap ? (i - 1 + n) % n : i - 1] ?? p;
    const next = points[wrap ? (i + 1) % n : i + 1] ?? p;
    const t = next.sub(prev).div(3);
    return { in: t.neg(), out: t };
  });
}
