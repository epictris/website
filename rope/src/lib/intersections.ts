// Intersections — geometry queries ported from lib/Intersections.cs.
// Operates on ShapeTransform (circle | body-aligned rect | convex polygon) and
// Segment.
//
// The rect routines are the ported closed-form ones and are left untouched, so
// every recorded replay keeps reproducing bit-for-bit; convex polygons take the
// general vertex-loop path below. The three `getIntersections*` walks were
// already written over an ordered corner loop, so they serve both.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { polyEdgeNormal, shapeVertices } from "../engine/shapes";
import { shapeRadius } from "../engine/collision";
import type { ShapeTransform } from "../engine/shapes";
import { Segment } from "./segment";
import { ShapeGeometry } from "./shapeGeometry";
import { IntersectionStatus } from "./types";

export interface Intersection {
  point: Vec2;
  normalA: Vec2;
  normalB: Vec2;
}

function mkIntersection(point: Vec2, normalA: Vec2, normalB: Vec2): Intersection {
  return { point, normalA, normalB };
}

const TOLERANCE = 0.0001;

function statusFromDistance(signedDist: number): IntersectionStatus {
  if (signedDist < -TOLERANCE) return IntersectionStatus.Overlap;
  if (signedDist > TOLERANCE) return IntersectionStatus.Separate;
  return IntersectionStatus.Touching;
}

// Signed distance from a point to a rectangle: positive outside, negative inside.
function rectSignedDistance(rect: ShapeTransform, point: Vec2): number {
  const hw = ShapeGeometry.getHalfWidth(rect);
  const hh = ShapeGeometry.getHalfHeight(rect);
  const local = point.sub(rect.globalPosition).rotated(-rect.globalRotation);
  const closestX = Mathf.clamp(local.x, -hw, hw);
  const closestY = Mathf.clamp(local.y, -hh, hh);
  const dx = local.x - closestX;
  const dy = local.y - closestY;
  if (dx === 0 && dy === 0) {
    return -Mathf.min(hw - Mathf.abs(local.x), hh - Mathf.abs(local.y));
  }
  return Mathf.sqrt(dx * dx + dy * dy);
}

// --- convex polygon -------------------------------------------------------
// The general vertex-loop forms of the rect queries above. A rect keeps its own
// closed-form routines (bit-identical replays); these serve `poly`.

// Closest point to `p` on the segment a→b.
function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = b.sub(a);
  const lenSq = ab.lengthSquared();
  if (lenSq < 1e-12) return a;
  return a.add(ab.mul(Mathf.clamp(p.sub(a).dot(ab) / lenSq, 0, 1)));
}

// Minimum distance between two segments (needed because a long polygon edge can
// be the closest feature to a rope span, where a rect only ever offers corners).
function segmentDistance(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): number {
  if (getIntersectionPoint(new Segment(a0, a1), new Segment(b0, b1)) !== null) return 0;
  return Mathf.min(
    Mathf.min(
      closestOnSegment(a0, b0, b1).distanceTo(a0),
      closestOnSegment(a1, b0, b1).distanceTo(a1),
    ),
    Mathf.min(
      closestOnSegment(b0, a0, a1).distanceTo(b0),
      closestOnSegment(b1, a0, a1).distanceTo(b1),
    ),
  );
}

// Signed distance from a world point to a convex polygon: positive outside,
// negative inside (the depth of the shallowest face).
function polySignedDistance(poly: ShapeTransform, point: Vec2): number {
  const verts = shapeVertices(poly.shape);
  const local = point.sub(poly.globalPosition).rotated(-poly.globalRotation);
  let maxPlane = -Infinity;
  for (let i = 0; i < verts.length; i++) {
    const n = polyEdgeNormal(verts, i);
    if (n.x === 0 && n.y === 0) continue;
    maxPlane = Mathf.max(maxPlane, n.dot(local.sub(verts[i]!)));
  }
  if (maxPlane <= 0) return maxPlane; // inside: distance to the nearest face
  let best = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const c = closestOnSegment(local, verts[i]!, verts[(i + 1) % verts.length]!);
    best = Mathf.min(best, local.distanceSquaredTo(c));
  }
  return Mathf.sqrt(best);
}

function intersectsPolyPoint(poly: ShapeTransform, point: Vec2): IntersectionStatus {
  return statusFromDistance(polySignedDistance(poly, point));
}

function intersectsPolySegment(poly: ShapeTransform, segment: Segment): IntersectionStatus {
  const bound = shapeRadius(poly.shape) + TOLERANCE;
  const c = poly.globalPosition;
  if (
    Mathf.max(segment.start.x, segment.end.x) < c.x - bound ||
    Mathf.min(segment.start.x, segment.end.x) > c.x + bound ||
    Mathf.max(segment.start.y, segment.end.y) < c.y - bound ||
    Mathf.min(segment.start.y, segment.end.y) > c.y + bound
  ) {
    return IntersectionStatus.Separate;
  }
  const d1 = polySignedDistance(poly, segment.start);
  const d2 = polySignedDistance(poly, segment.end);
  if (d1 < -TOLERANCE || d2 < -TOLERANCE) return IntersectionStatus.Overlap;

  // Clip the span to the body's half-planes, then judge by how far inside the
  // surviving interior actually gets — the same shape of answer the rect routine
  // gives (slab clip, then the signed distance at the interior midpoint).
  //
  // Deliberately NOT "any edge the span crosses means Overlap": an edge
  // *intersection* includes a mere touch, so a span whose endpoint sits exactly
  // on a face — or on a vertex, which is where a rope attachment naturally ends
  // up — reported Overlap while penetrating by nothing at all. That is a
  // permanent false positive rather than a marginal one, since a contact stored
  // in the body's local frame stays on the surface forever, and it left the
  // rope's self-intersection resolvers armed on every span touching such an
  // anchor. In session-284f that fired on a 16 mm span, and the "already on this
  // vertex, step one place round the loop" rule sent the wrap 1.54 m to the next
  // corner of a 3 m polygon: +3.08 m of path in one frame, which the length
  // solver converted into a 124 m/s launch.
  const corners = ShapeGeometry.getGlobalCorners(poly);
  const dir = segment.end.sub(segment.start);
  let tEnter = 0;
  let tExit = 1;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const e = corners[(i + 1) % corners.length]!.sub(a);
    const len = e.length();
    if (len < 1e-9) continue;
    const normal = new Vec2(e.y / len, -e.x / len); // outward (see shapes.ts)
    const dist = normal.dot(segment.start.sub(a));
    const denom = normal.dot(dir);
    if (Mathf.abs(denom) < 1e-9) {
      // Parallel to this face: outside it means the span misses the body.
      if (dist > 0) {
        tEnter = 1;
        tExit = 0;
        break;
      }
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) tEnter = Mathf.max(tEnter, t);
    else tExit = Mathf.min(tExit, t);
    if (tEnter > tExit) break;
  }
  if (tEnter <= tExit) {
    const interior = segment.start.add(dir.mul((tEnter + tExit) * 0.5));
    return statusFromDistance(polySignedDistance(poly, interior));
  }

  // Disjoint from the body: the status is its closest approach. Edges as well as
  // corners, since a long polygon face can be the nearest feature to a span
  // where a rect only ever offers a corner.
  let minDist = Mathf.min(d1, d2);
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    minDist = Mathf.min(minDist, segmentDistance(segment.start, segment.end, a, b));
  }
  return statusFromDistance(minDist);
}

// SAT over every face normal of both loops; the largest gap is the separation
// (negative = penetration depth along the minimum-translation axis). Face
// normals, not edge directions: for a rectangle the two coincide, which is why
// the ported rect routine can get away with edge vectors, but a general polygon
// separates only along a face normal.
function convexGap(a: ShapeTransform, b: ShapeTransform): number {
  const cornersA = ShapeGeometry.getGlobalCorners(a);
  const cornersB = ShapeGeometry.getGlobalCorners(b);
  const axes: Vec2[] = [];
  for (const corners of [cornersA, cornersB]) {
    for (let i = 0; i < corners.length; i++) {
      const e = corners[(i + 1) % corners.length]!.sub(corners[i]!);
      if (e.lengthSquared() > 1e-18) axes.push(e.orthogonal().normalized());
    }
  }
  let maxGap = -Infinity;
  for (const axis of axes) {
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const c of cornersA) {
      const p = c.dot(axis);
      if (p < minA) minA = p;
      if (p > maxA) maxA = p;
    }
    for (const c of cornersB) {
      const p = c.dot(axis);
      if (p < minB) minB = p;
      if (p > maxB) maxB = p;
    }
    const gap = Mathf.max(minA - maxB, minB - maxA);
    if (gap > maxGap) maxGap = gap;
  }
  return maxGap;
}

function intersectsCirclePoint(circle: ShapeTransform, point: Vec2): IntersectionStatus {
  const d = circle.globalPosition.distanceTo(point) - ShapeGeometry.getRadius(circle);
  return statusFromDistance(d);
}

function intersectsRectPoint(rect: ShapeTransform, point: Vec2): IntersectionStatus {
  return statusFromDistance(rectSignedDistance(rect, point));
}

function intersectsCircleSegment(circle: ShapeTransform, segment: Segment): IntersectionStatus {
  const r = ShapeGeometry.getRadius(circle);
  const pos = circle.globalPosition;
  const d = pos.distanceTo(segment.getClosestPointOnLine(pos)) - r;
  return statusFromDistance(d);
}

function intersectsCircleCircle(a: ShapeTransform, b: ShapeTransform): IntersectionStatus {
  const d =
    a.globalPosition.distanceTo(b.globalPosition) -
    ShapeGeometry.getRadius(a) -
    ShapeGeometry.getRadius(b);
  return statusFromDistance(d);
}

function intersectsCircleRect(circle: ShapeTransform, rect: ShapeTransform): IntersectionStatus {
  const d = rectSignedDistance(rect, circle.globalPosition) - ShapeGeometry.getRadius(circle);
  return statusFromDistance(d);
}

function intersectsRectRect(a: ShapeTransform, b: ShapeTransform): IntersectionStatus {
  const cornersA = ShapeGeometry.getGlobalCorners(a);
  const cornersB = ShapeGeometry.getGlobalCorners(b);
  const axes = [
    cornersA[3]!.sub(cornersA[0]!).normalized(),
    cornersA[1]!.sub(cornersA[0]!).normalized(),
    cornersB[3]!.sub(cornersB[0]!).normalized(),
    cornersB[1]!.sub(cornersB[0]!).normalized(),
  ];
  let maxGap = -Infinity;
  for (const axis of axes) {
    let minA = Infinity,
      maxA = -Infinity,
      minB = Infinity,
      maxB = -Infinity;
    for (const c of cornersA) {
      const p = c.dot(axis);
      if (p < minA) minA = p;
      if (p > maxA) maxA = p;
    }
    for (const c of cornersB) {
      const p = c.dot(axis);
      if (p < minB) minB = p;
      if (p > maxB) maxB = p;
    }
    const gap = Mathf.max(minA - maxB, minB - maxA);
    if (gap > maxGap) maxGap = gap;
  }
  return statusFromDistance(maxGap);
}

function localSignedDist(p: Vec2, hw: number, hh: number): number {
  const dx = Mathf.abs(p.x) - hw;
  const dy = Mathf.abs(p.y) - hh;
  if (dx <= 0 && dy <= 0) return Mathf.max(dx, dy);
  return new Vec2(Mathf.max(dx, 0), Mathf.max(dy, 0)).length();
}

function slabClip(
  lo: number,
  hi: number,
  start: number,
  dir: number,
  t: { enter: number; exit: number },
): boolean {
  if (Mathf.abs(dir) < 1e-6) return start >= lo && start <= hi;
  let t1 = (lo - start) / dir;
  let t2 = (hi - start) / dir;
  if (t1 > t2) [t1, t2] = [t2, t1];
  t.enter = Mathf.max(t.enter, t1);
  t.exit = Mathf.min(t.exit, t2);
  return t.enter <= t.exit;
}

function intersectsRectSegment(rect: ShapeTransform, segment: Segment): IntersectionStatus {
  const hw = ShapeGeometry.getHalfWidth(rect);
  const hh = ShapeGeometry.getHalfHeight(rect);
  const halfDiag = Mathf.sqrt(hw * hw + hh * hh) + TOLERANCE;
  const rectPos = rect.globalPosition;
  if (
    Mathf.max(segment.start.x, segment.end.x) < rectPos.x - halfDiag ||
    Mathf.min(segment.start.x, segment.end.x) > rectPos.x + halfDiag ||
    Mathf.max(segment.start.y, segment.end.y) < rectPos.y - halfDiag ||
    Mathf.min(segment.start.y, segment.end.y) > rectPos.y + halfDiag
  ) {
    return IntersectionStatus.Separate;
  }

  const s = segment.start.sub(rectPos).rotated(-rect.globalRotation);
  const e = segment.end.sub(rectPos).rotated(-rect.globalRotation);
  const d1 = localSignedDist(s, hw, hh);
  const d2 = localSignedDist(e, hw, hh);
  if (d1 < -TOLERANCE || d2 < -TOLERANCE) return IntersectionStatus.Overlap;

  const delta = e.sub(s);
  const t = { enter: 0, exit: 1 };
  if (
    slabClip(-hw, hw, s.x, delta.x, t) &&
    slabClip(-hh, hh, s.y, delta.y, t)
  ) {
    const interior = s.add(delta.mul((t.enter + t.exit) * 0.5));
    return statusFromDistance(localSignedDist(interior, hw, hh));
  }

  let minDist = Mathf.min(d1, d2);
  const lenSq = delta.dot(delta);
  if (lenSq > 1e-8) {
    const localCorners = [
      new Vec2(-hw, -hh),
      new Vec2(-hw, hh),
      new Vec2(hw, hh),
      new Vec2(hw, -hh),
    ];
    for (const c of localCorners) {
      const tc = Mathf.clamp(delta.dot(c.sub(s)) / lenSq, 0, 1);
      const cornerDist = s.add(delta.mul(tc)).sub(c).length();
      if (cornerDist < minDist) minDist = cornerDist;
    }
  }
  return statusFromDistance(minDist);
}

function isOnSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    p.x >= Mathf.min(a.x, b.x) &&
    p.x <= Mathf.max(a.x, b.x) &&
    p.y >= Mathf.min(a.y, b.y) &&
    p.y <= Mathf.max(a.y, b.y)
  );
}

export function getIntersectionPoint(a: Segment, b: Segment): Vec2 | null {
  const d1 = b.end.sub(b.start).cross(a.start.sub(b.start));
  const d2 = b.end.sub(b.start).cross(a.end.sub(b.start));
  const d3 = a.end.sub(a.start).cross(b.start.sub(a.start));
  const d4 = a.end.sub(a.start).cross(b.end.sub(a.start));

  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    const t = d1 / (d1 - d2);
    return a.start.add(a.end.sub(a.start).mul(t));
  }

  if (d1 === 0 && isOnSegment(b.start, b.end, a.start)) return a.start;
  if (d2 === 0 && isOnSegment(b.start, b.end, a.end)) return a.end;
  if (d3 === 0 && isOnSegment(a.start, a.end, b.start)) return b.start;
  if (d4 === 0 && isOnSegment(a.start, a.end, b.end)) return b.end;
  return null;
}

function getIntersectionsCircleCircle(a: ShapeTransform, b: ShapeTransform): Intersection[] {
  const posA = a.globalPosition;
  const posB = b.globalPosition;
  const r1 = ShapeGeometry.getRadius(a);
  const r2 = ShapeGeometry.getRadius(b);
  const d = posA.distanceTo(posB);
  if (d > r1 + r2) return [];
  if (d <= Mathf.abs(r1 - r2)) return []; // one contained in the other

  const aa = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSquared = r1 * r1 - aa * aa;
  const h = hSquared > 0 ? Mathf.sqrt(hSquared) : 0;
  const dirAB = posB.sub(posA).div(d);
  const perpendicular = dirAB.orthogonal();
  const midpoint = posA.add(dirAB.mul(aa));
  const p1 = midpoint.add(perpendicular.mul(h));
  const p2 = midpoint.sub(perpendicular.mul(h));
  return [
    mkIntersection(p1, p1.sub(posA).normalized(), p1.sub(posB).normalized()),
    mkIntersection(p2, p2.sub(posA).normalized(), p2.sub(posB).normalized()),
  ];
}

function getIntersectionsCircleSegment(
  circle: ShapeTransform,
  line: Segment,
): { entry: Intersection | null; exit: Intersection | null } {
  const r = ShapeGeometry.getRadius(circle);
  const center = circle.globalPosition;
  const d = line.end.sub(line.start);
  const f = line.start.sub(center);
  const a = d.dot(d);
  const b = 2 * f.dot(d);
  const c = f.dot(f) - r * r;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return { entry: null, exit: null };

  const sqrtDisc = Mathf.sqrt(discriminant);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  const edgeNormal = d.orthogonal().neg().normalized();

  let entry: Intersection | null = null;
  let exit: Intersection | null = null;
  if (t1 >= 0 && t1 <= 1) {
    const p = line.start.add(d.mul(t1));
    entry = mkIntersection(p, p.sub(center).normalized(), edgeNormal);
  }
  if (t2 >= 0 && t2 <= 1) {
    const p = line.start.add(d.mul(t2));
    exit = mkIntersection(p, p.sub(center).normalized(), edgeNormal);
  }
  return { entry, exit };
}

// Entry/exit of a segment through a convex vertex loop (rect or polygon alike —
// the walk was already written over the ordered corner list).
function getIntersectionsLoopSegment(
  rect: ShapeTransform,
  segment: Segment,
): { entry: Intersection | null; exit: Intersection | null } {
  const corners = ShapeGeometry.getGlobalCorners(rect);
  const n = corners.length;
  const segDir = segment.end.sub(segment.start);
  const segLenSq = segDir.lengthSquared();
  const segNormal = segDir.orthogonal().neg().normalized();

  let entry: Intersection | null = null;
  let exit: Intersection | null = null;
  let tEntry = Infinity;
  let tExit = -Infinity;

  for (let i = 0; i < n; i++) {
    const edge = new Segment(corners[i]!, corners[(i + 1) % n]!);
    const p = getIntersectionPoint(segment, edge);
    if (p === null) continue;
    const edgeDir = edge.end.sub(edge.start);
    const rectNormal = edgeDir.orthogonal().neg().normalized();
    const t = segLenSq > 1e-8 ? p.sub(segment.start).dot(segDir) / segLenSq : 0;
    if (t < tEntry) {
      tEntry = t;
      entry = mkIntersection(p, rectNormal, segNormal);
    }
    if (t > tExit) {
      tExit = t;
      exit = mkIntersection(p, rectNormal, segNormal);
    }
  }
  if (tEntry === tExit) return { entry, exit: null };
  return { entry, exit };
}

function getIntersectionsCircleLoop(circle: ShapeTransform, rect: ShapeTransform): Intersection[] {
  const intersections: Intersection[] = [];
  const corners = ShapeGeometry.getGlobalCorners(rect);
  for (let i = 0; i < corners.length; i++) {
    const edge = new Segment(corners[i]!, corners[(i + 1) % corners.length]!);
    const { entry, exit } = getIntersectionsCircleSegment(circle, edge);
    if (entry) intersections.push(entry);
    if (exit) intersections.push(exit);
  }
  return intersections;
}

function getIntersectionsLoopLoop(a: ShapeTransform, b: ShapeTransform): Intersection[] {
  const intersections: Intersection[] = [];
  const cornersA = ShapeGeometry.getGlobalCorners(a);
  const cornersB = ShapeGeometry.getGlobalCorners(b);
  const na = cornersA.length;
  const nb = cornersB.length;
  for (let i = 0; i < na; i++) {
    const edgeA = new Segment(cornersA[i]!, cornersA[(i + 1) % na]!);
    const dirA = edgeA.end.sub(edgeA.start);
    const normalA = dirA.orthogonal().normalized().neg();
    for (let j = 0; j < nb; j++) {
      const edgeB = new Segment(cornersB[j]!, cornersB[(j + 1) % nb]!);
      const point = getIntersectionPoint(edgeA, edgeB);
      if (point !== null) {
        const dirB = edgeB.end.sub(edgeB.start);
        const normalB = dirB.orthogonal().normalized().neg();
        intersections.push(mkIntersection(point, normalA, normalB));
      }
    }
  }
  return intersections;
}

function swapNormals(intersections: Intersection[]): Intersection[] {
  return intersections.map((i) => mkIntersection(i.point, i.normalB, i.normalA));
}

export const Intersections = {
  // point tests
  intersectsPoint(shape: ShapeTransform, point: Vec2): IntersectionStatus {
    if (shape.shape.kind === "circle") return intersectsCirclePoint(shape, point);
    if (shape.shape.kind === "poly") return intersectsPolyPoint(shape, point);
    return intersectsRectPoint(shape, point);
  },

  intersectsSegment(shape: ShapeTransform, segment: Segment): IntersectionStatus {
    if (shape.shape.kind === "circle") return intersectsCircleSegment(shape, segment);
    if (shape.shape.kind === "poly") return intersectsPolySegment(shape, segment);
    return intersectsRectSegment(shape, segment);
  },

  intersects(a: ShapeTransform, b: ShapeTransform): IntersectionStatus {
    const ka = a.shape.kind;
    const kb = b.shape.kind;
    if (ka === "circle" && kb === "circle") return intersectsCircleCircle(a, b);
    if (ka === "circle" && kb === "rect") return intersectsCircleRect(a, b);
    if (ka === "rect" && kb === "circle") return intersectsCircleRect(b, a);
    if (ka === "rect" && kb === "rect") return intersectsRectRect(a, b);
    // At least one convex polygon from here on.
    if (ka === "circle") {
      return statusFromDistance(polySignedDistance(b, a.globalPosition) - ShapeGeometry.getRadius(a));
    }
    if (kb === "circle") {
      return statusFromDistance(polySignedDistance(a, b.globalPosition) - ShapeGeometry.getRadius(b));
    }
    return statusFromDistance(convexGap(a, b));
  },

  getIntersectionPoint,

  getIntersectionsCircleCircle,

  getIntersectionsCircleRect: getIntersectionsCircleLoop,

  // shape-vs-shape intersection points
  getIntersections(a: ShapeTransform, b: ShapeTransform): Intersection[] {
    const ka = a.shape.kind;
    const kb = b.shape.kind;
    if (ka === "circle" && kb === "circle") return getIntersectionsCircleCircle(a, b);
    if (ka === "circle") return getIntersectionsCircleLoop(a, b);
    if (kb === "circle") return swapNormals(getIntersectionsCircleLoop(b, a));
    return getIntersectionsLoopLoop(a, b);
  },

  // shape-vs-segment (entry/exit)
  getIntersectionsShapeSegment(
    shape: ShapeTransform,
    segment: Segment,
  ): { entry: Intersection | null; exit: Intersection | null } {
    return shape.shape.kind === "circle"
      ? getIntersectionsCircleSegment(shape, segment)
      : getIntersectionsLoopSegment(shape, segment);
  },
};
