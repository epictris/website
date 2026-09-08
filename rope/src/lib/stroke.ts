// A CURVE WITH A WIDTH, as the geometry it is made of: the polyline down its
// middle, the convex pieces the engine collides as, and the outline it draws as.
//
// This is what an authored `curve` shape (`ShapeData`) becomes - a rail, and
// anything else a level wants to draw as a bar rather than as a box. The engine
// has no curved primitive and is never getting one (a polygon here is convex
// without exception, see "Convex-only polygons; compound bodies" in
// docs/game-design.md), so the curve is STROKED at load into the convex pieces
// that tile it, exactly as a concave outline is cut into the pieces that tile
// it (`decomposeConvex`). What the solvers see is the compound body an author
// would otherwise have had to assemble by hand out of little rects.
//
// ONE POLYLINE ANSWERS EVERYTHING. The cuff rides `line`, the pieces are built
// from `line`, and the drawn outline is offset from `line`, so the bar that is
// drawn, the bar that is collided and the bar the ring slides along cannot
// disagree by a pixel. That is why the simplification below happens HERE and
// once, rather than each consumer flattening the cubic to whatever density it
// felt like.

import { Vec2 } from "../engine/vec2";
import { flattenPath, type PathNode } from "./path";

// How far the collision polyline may stray from the flattened cubic, metres.
// `flattenPath` samples by control-polygon length, which on a gentle four-metre
// bow is twenty samples of a curve three of them would carry; every one of those
// is a collision piece, a broadphase leaf and a candidate for the rope's wrap
// scan, so the samples that buy nothing are dropped again (`simplifyPolyline`).
//
// A centimetre is the scale below which nothing in this game can tell the
// difference - a tenth of the manacle's disc, a twentieth of the ball - and it
// is capped at a fifth of the half-width besides, so a thin bar is not
// straightened by a tolerance that is a large fraction of its own thickness.
export const STROKE_TOLERANCE = 0.01;

// Where a joint stops being mitred and is bevelled instead: the ratio of the
// mitre point's reach to the half-width, `1 / cos(turn/2)`. 2 is a 120° turn -
// past that the mitre spike is longer than the bar is thick and a bevel is both
// the truer shape and the better-conditioned polygon.
export const STROKE_MITER_LIMIT = 2;

// Two points closer than this are one point: a flattened cubic whose handles
// double back can produce them, and a zero-length segment has no direction to
// offset across.
const MIN_SEGMENT = 1e-9;

// The stroke of a curve: what it is made of, in the curve's own frame.
export interface Stroke {
  // The centreline, as the pieces are actually built from it. Two or more
  // points; the arc length everything about a rail is expressed in is measured
  // along THIS, not along the cubic it was flattened from.
  line: Vec2[];
  halfWidth: number;
  // The convex pieces that tile the bar: one quad per centreline segment, plus
  // a triangle at each joint too sharp to mitre. They meet edge to edge and do
  // not overlap, so their areas sum to the bar's area and their masses to its
  // mass - which is what lets the build weigh a curve exactly as it weighs a
  // decomposed polygon.
  pieces: Vec2[][];
  // `pieceAt[i]` is the piece covering centreline segment `i`, so the cuff's
  // position along the line answers which piece it is standing on.
  pieceAt: number[];
  // The union's boundary, in order, for drawing.
  outline: Vec2[];
}

// The stroke of an authored node list. `width` is the full width of the bar;
// everything below works in half-widths.
export function strokeCurve(nodes: readonly PathNode[], width: number): Stroke {
  const halfWidth = Math.max(width, 0) * 0.5;
  const tolerance = Math.min(STROKE_TOLERANCE, halfWidth * 0.2);
  return strokeLine(simplifyPolyline(dedupe(flattenPath(nodes)), tolerance), halfWidth);
}

// The centreline of an authored node list, which is the stroke's `line` and
// nothing else: the same flattening and the same simplification, for the
// callers that want where the bar runs without what it is made of.
export function curveLine(nodes: readonly PathNode[], width: number): Vec2[] {
  const halfWidth = Math.max(width, 0) * 0.5;
  return simplifyPolyline(dedupe(flattenPath(nodes)), Math.min(STROKE_TOLERANCE, halfWidth * 0.2));
}

// The stroke of a polyline that has already been flattened and simplified.
//
// Each JOINT is mitred: the two pieces meeting there share the edge that lies
// along the bisector of their normals, so the bar has neither the gap a butt
// joint leaves on the outside of a bend nor the doubled sliver it leaves on the
// inside. Where the mitre would spike (`STROKE_MITER_LIMIT`) the outer side is
// bevelled instead and the wedge between the two pieces becomes a triangle of
// its own, which keeps the tiling exact.
export function strokeLine(line: readonly Vec2[], halfWidth: number): Stroke {
  const verts = line.map((v) => v.clone());
  if (verts.length < 2 || halfWidth <= 0) {
    return { line: verts, halfWidth, pieces: [], pieceAt: [], outline: [] };
  }
  const n = verts.length;
  // Per segment: its unit direction and the normal to one side of it (Godot's
  // orthogonal, so "left" here is (y, -x) and the other side is its negation).
  const dir: Vec2[] = [];
  const norm: Vec2[] = [];
  const len: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const e = verts[i + 1]!.sub(verts[i]!);
    const l = e.length();
    const d = l < MIN_SEGMENT ? Vec2.RIGHT : e.div(l);
    dir.push(d);
    norm.push(d.orthogonal());
    len.push(l);
  }
  // The offset points at each vertex, in path order: one per side at a plain
  // joint or an end, two on the OUTER side of a bevelled one.
  const left: Vec2[][] = [];
  const right: Vec2[][] = [];
  // Which joints were bevelled, and toward which side the bar turns there.
  const bevelled: (1 | -1 | 0)[] = [];
  for (let i = 0; i < n; i++) {
    const v = verts[i]!;
    const a = i > 0 ? norm[i - 1]! : null;
    const b = i + 1 < n ? norm[i]! : null;
    if (a === null || b === null) {
      const s = (a ?? b)!;
      left.push([v.add(s.mul(halfWidth))]);
      right.push([v.sub(s.mul(halfWidth))]);
      bevelled.push(0);
      continue;
    }
    const bis = a.add(b);
    const cosHalf = bis.lengthSquared() < 1e-18 ? 0 : bis.normalized().dot(b);
    // A joint the bar doubles back through has no bisector to mitre along: butt
    // both sides and let the two pieces meet however they meet. An authored kink
    // that sharp is a level-design pathology rather than a shape to be exact
    // about.
    if (cosHalf <= 1e-6) {
      left.push([v.add(a.mul(halfWidth)), v.add(b.mul(halfWidth))]);
      right.push([v.sub(a.mul(halfWidth)), v.sub(b.mul(halfWidth))]);
      bevelled.push(0);
      continue;
    }
    const unit = bis.normalized();
    // The mitre point sits `halfWidth / cos(turn/2)` along the bisector, which
    // is `halfWidth * tan(turn/2)` back along each of the two segments. A mitre
    // that runs back further than its segment is long would cross the joint at
    // the far end and turn the piece into a bow tie, so the reach is capped at
    // not quite half of the shorter segment - the one case where the tiling
    // narrows the bar at a kink rather than emitting an invalid polygon.
    const sinHalf = Math.sqrt(Math.max(0, 1 - cosHalf * cosHalf));
    const room = 0.45 * Math.min(len[i - 1]!, len[i]!);
    const reach = Math.min(
      halfWidth / cosHalf,
      sinHalf < 1e-9 ? Infinity : room / sinHalf,
    );
    // Which way the bar turns: the outer side is the one the turn leaves.
    const turn = dir[i - 1]!.cross(dir[i]!);
    const bevel = 1 / cosHalf > STROKE_MITER_LIMIT;
    const outerLeft = turn > 0;
    if (bevel && outerLeft) {
      left.push([v.add(a.mul(halfWidth)), v.add(b.mul(halfWidth))]);
      right.push([v.sub(unit.mul(reach))]);
      bevelled.push(1);
    } else if (bevel) {
      left.push([v.add(unit.mul(reach))]);
      right.push([v.sub(a.mul(halfWidth)), v.sub(b.mul(halfWidth))]);
      bevelled.push(-1);
    } else {
      left.push([v.add(unit.mul(reach))]);
      right.push([v.sub(unit.mul(reach))]);
      bevelled.push(0);
    }
  }

  const pieces: Vec2[][] = [];
  const pieceAt: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    // The offset points belonging to THIS segment: the last at its start vertex
    // and the first at its end vertex, which for a bevelled joint are the two
    // sides of the wedge.
    const startLeft = left[i]![left[i]!.length - 1]!;
    const startRight = right[i]![right[i]!.length - 1]!;
    const endLeft = left[i + 1]![0]!;
    const endRight = right[i + 1]![0]!;
    pieceAt.push(pieces.length);
    pieces.push([startLeft, endLeft, endRight, startRight]);
    // The wedge the bevel leaves between this piece and the next.
    const side = bevelled[i + 1] ?? 0;
    if (side === 1) pieces.push([left[i + 1]![0]!, left[i + 1]![1]!, right[i + 1]![0]!]);
    else if (side === -1) pieces.push([right[i + 1]![0]!, right[i + 1]![1]!, left[i + 1]![0]!]);
  }

  // The boundary: down one side and back the other, with each joint's points in
  // path order going out and reversed coming back.
  const outline: Vec2[] = [];
  for (let i = 0; i < n; i++) for (const p of left[i]!) outline.push(p);
  for (let i = n - 1; i >= 0; i--) for (let k = right[i]!.length - 1; k >= 0; k--) outline.push(right[i]![k]!);
  return { line: verts, halfWidth, pieces, pieceAt, outline };
}

// Consecutive duplicates removed, so every segment has a direction.
function dedupe(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.distanceSquaredTo(p) < MIN_SEGMENT * MIN_SEGMENT) continue;
    out.push(p);
  }
  return out;
}

// Douglas-Peucker: the fewest of the given points whose polyline stays within
// `tolerance` of the original everywhere. The endpoints are always kept, so a
// simplified line still starts and ends exactly where the curve does.
export function simplifyPolyline(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3 || tolerance <= 0) return points.map((p) => p.clone());
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  // Iterative rather than recursive: a flattened cubic is at most a few dozen
  // points, but the stack depth of a recursive walk is the one thing that would
  // depend on the data rather than on the shape.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi <= lo + 1) continue;
    const a = points[lo]!;
    const b = points[hi]!;
    const e = b.sub(a);
    const l = e.length();
    let worst = -1;
    let worstAt = lo;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i]!.sub(a);
      const d = l < MIN_SEGMENT ? p.length() : Math.abs(e.cross(p)) / l;
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
    if (worst <= tolerance) continue;
    keep[worstAt] = true;
    stack.push([lo, worstAt], [worstAt, hi]);
  }
  return points.filter((_, i) => keep[i]).map((p) => p.clone());
}
