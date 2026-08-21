// Camera-path geometry: projecting a point onto an open polyline, and walking
// arc length along it. Pure functions with no controller state and no DOM, so
// they are checked directly by `cli camera` rather than through a level.
//
// FRAME. An index is built in WORLD space: the path's local verts are
// transformed by its (origin, rot) once at construction and never again, since
// nothing mutates a path at runtime. Every function here therefore takes and
// returns world points and no caller transforms anything - unlike
// `pointInRegion`, which tests in the region's local frame because a rect and a
// polygon have no world form to test against.
//
// ARC LENGTH is the coordinate everything is expressed in: `s` metres from the
// first vert along the polyline. It is what makes "the camera leads the player
// by `lookahead` metres" a single addition, and it is monotone along the path
// even where the path passes near itself, which is what the windowed projection
// below leans on.

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
  if (nodes.length === 0) return [];
  const out: Vec2[] = [nodes[0]!.p];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    const c1 = a.p.add(a.out);
    const c2 = b.p.add(b.in);
    if (a.out.lengthSquared() === 0 && b.in.lengthSquared() === 0) {
      out.push(b.p);
      continue;
    }
    const control = a.p.distanceTo(c1) + c1.distanceTo(c2) + c2.distanceTo(b.p);
    const n = Math.min(MAX_SAMPLES_PER_EDGE, Math.max(2, Math.ceil(control / PATH_FLATTEN_STEP)));
    for (let k = 1; k <= n; k++) out.push(cubicAt(a.p, c1, c2, b.p, k / n));
  }
  return out;
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

export interface PolylineIndex {
  // World-space verts in direction-of-travel order.
  verts: Vec2[];
  // cum[i] = arc length from verts[0] to verts[i]. Same length as `verts`.
  cum: number[];
  total: number;
}

export function buildPolylineIndex(
  verts: readonly Vec2[],
  origin: Vec2 = Vec2.ZERO,
  rot = 0,
): PolylineIndex {
  const world = verts.map((v) => v.rotated(rot).add(origin));
  const cum: number[] = world.length ? [0] : [];
  for (let i = 1; i < world.length; i++) {
    cum.push(cum[i - 1]! + world[i]!.distanceTo(world[i - 1]!));
  }
  return { verts: world, cum, total: cum.length ? cum[cum.length - 1]! : 0 };
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
