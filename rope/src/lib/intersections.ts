// Intersections — geometry queries ported from lib/Intersections.cs.
// Operates on ShapeTransform (circle | body-aligned rect) and Segment.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
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

const TOLERANCE = 0.01;

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

function getIntersectionsRectSegment(
  rect: ShapeTransform,
  segment: Segment,
): { entry: Intersection | null; exit: Intersection | null } {
  const corners = ShapeGeometry.getGlobalCorners(rect);
  const segDir = segment.end.sub(segment.start);
  const segLenSq = segDir.lengthSquared();
  const segNormal = segDir.orthogonal().neg().normalized();

  let entry: Intersection | null = null;
  let exit: Intersection | null = null;
  let tEntry = Infinity;
  let tExit = -Infinity;

  for (let i = 0; i < 4; i++) {
    const edge = new Segment(corners[i]!, corners[(i + 1) % 4]!);
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

function getIntersectionsCircleRect(circle: ShapeTransform, rect: ShapeTransform): Intersection[] {
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

function getIntersectionsRectRect(a: ShapeTransform, b: ShapeTransform): Intersection[] {
  const intersections: Intersection[] = [];
  const cornersA = ShapeGeometry.getGlobalCorners(a);
  const cornersB = ShapeGeometry.getGlobalCorners(b);
  for (let i = 0; i < 4; i++) {
    const edgeA = new Segment(cornersA[i]!, cornersA[(i + 1) % 4]!);
    const dirA = edgeA.end.sub(edgeA.start);
    const normalA = dirA.orthogonal().normalized().neg();
    for (let j = 0; j < 4; j++) {
      const edgeB = new Segment(cornersB[j]!, cornersB[(j + 1) % 4]!);
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
    return shape.shape.kind === "circle"
      ? intersectsCirclePoint(shape, point)
      : intersectsRectPoint(shape, point);
  },

  intersectsSegment(shape: ShapeTransform, segment: Segment): IntersectionStatus {
    return shape.shape.kind === "circle"
      ? intersectsCircleSegment(shape, segment)
      : intersectsRectSegment(shape, segment);
  },

  intersects(a: ShapeTransform, b: ShapeTransform): IntersectionStatus {
    const ka = a.shape.kind;
    const kb = b.shape.kind;
    if (ka === "circle" && kb === "circle") return intersectsCircleCircle(a, b);
    if (ka === "circle" && kb === "rect") return intersectsCircleRect(a, b);
    if (ka === "rect" && kb === "circle") return intersectsCircleRect(b, a);
    return intersectsRectRect(a, b);
  },

  getIntersectionPoint,

  getIntersectionsCircleCircle,

  getIntersectionsCircleRect,

  // shape-vs-shape intersection points
  getIntersections(a: ShapeTransform, b: ShapeTransform): Intersection[] {
    const ka = a.shape.kind;
    const kb = b.shape.kind;
    if (ka === "circle" && kb === "circle") return getIntersectionsCircleCircle(a, b);
    if (ka === "circle" && kb === "rect") return getIntersectionsCircleRect(a, b);
    if (ka === "rect" && kb === "circle") return swapNormals(getIntersectionsCircleRect(b, a));
    return getIntersectionsRectRect(a, b);
  },

  // shape-vs-segment (entry/exit)
  getIntersectionsShapeSegment(
    shape: ShapeTransform,
    segment: Segment,
  ): { entry: Intersection | null; exit: Intersection | null } {
    return shape.shape.kind === "circle"
      ? getIntersectionsCircleSegment(shape, segment)
      : getIntersectionsRectSegment(shape, segment);
  },
};
