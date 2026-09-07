// SpanSweep - continuous wrap detection for a rope span.
//
// The wrap scan looks at a span where it IS: a straight segment between two
// nodes, tested against the scene for overlap. At speed that is a sample, not a
// path. A chain falling at 15 m/s moves 25 cm between two looks, and a 10 cm
// body between those two positions is never touched by either of them - the
// span is above the body on one frame and below it on the next, and the chain
// has passed clean through (`session-126f`). The sample also gets the DIRECTION
// wrong on the one frame it does land inside such a body, because the static
// rule reads the wrap direction off which side the body's centre happens to be
// on, and a span most of the way through a body has its centre behind it.
//
// This answers the question the sample cannot: between the two looks, did a
// point of the scene pass THROUGH the moving span? The span's endpoints move
// linearly from where they were to where they are, so the signed side of a
// (linearly moving) point against the span is a quadratic in time, and a point
// that passed through the span is one whose side changed with the crossing
// inside the span's extent. Which side it came FROM is the wrap direction: the
// rope bends round the body with the body on the side it entered from.
//
// A point that ends up where it started (in and back out) has not crossed, and
// one that went round the span's END has not either - a body the hook flew past
// is not a body the chain ran into.

import { Vec2 } from "../engine/vec2";
import type { CollisionShape2D, PhysicsBody2D } from "../engine/body";
import { ShapeGeometry } from "./shapeGeometry";
import { WrapDirection } from "./types";

// Where a span was at the last look and where it is now.
export interface SpanMotion {
  s0: Vec2;
  e0: Vec2;
  s1: Vec2;
  e1: Vec2;
}

// A body's transform at the last look, so a point of it can be placed where it
// was then. Statics need none: they were where they are.
export interface Pose {
  position: Vec2;
  rotation: number;
}

export interface Crossing {
  // When within the motion (0..1) and where along the span (0..1).
  t: number;
  u: number;
  // The side the point came from, as the wrap direction a rope bending round
  // it takes. Same convention as `Segment.calculateWrapDirection`: the sign of
  // cross(point - start, end - start) on the span as it WAS.
  side: WrapDirection;
  // How far off the previous span's line the point stood, in the cross
  // product's units - what ranks several crossings of one shape.
  commitment: number;
  // The point that crossed, where it is now.
  point: Vec2;
}

const DEGENERATE_SPAN = 1e-12;

// Did `p` (moving p0 -> p1) pass through the span (moving s0e0 -> s1e1)?
export function pointCrossesSpan(span: SpanMotion, p0: Vec2, p1: Vec2): Crossing | null {
  const a0 = p0.sub(span.s0);
  const a1 = p1.sub(span.s1).sub(a0);
  const b0 = span.e0.sub(span.s0);
  const b1 = span.e1.sub(span.s1).sub(b0);
  // f(t) = cross(a(t), b(t)), the point's signed side of the span's line.
  const f0 = a0.cross(b0);
  const f1 = a0.add(a1).cross(b0.add(b1));
  // A net change of side is exactly one root in (0, 1) of a quadratic, and no
  // change is none or two - the second being the in-and-out that is not a
  // crossing. A point ON the line at either end has no side to have changed.
  if (f0 === 0 || f1 === 0 || (f0 > 0) === (f1 > 0)) return null;

  const c2 = a1.cross(b1);
  const c1 = a0.cross(b1) + a1.cross(b0);
  let t = rootBetween(f0, c1, c2);
  if (t === null) {
    // Closed form lost to cancellation; the sign change is certain, so bisect.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      const fm = f0 + mid * (c1 + mid * c2);
      if ((fm > 0) === (f0 > 0)) lo = mid;
      else hi = mid;
    }
    t = (lo + hi) / 2;
  }

  const a = a0.add(a1.mul(t));
  const b = b0.add(b1.mul(t));
  const bb = b.lengthSquared();
  if (bb < DEGENERATE_SPAN) return null;
  const u = a.dot(b) / bb;
  if (u < 0 || u > 1) return null;
  return {
    t,
    u,
    side: f0 > 0 ? WrapDirection.CounterClockwise : WrapDirection.Clockwise,
    commitment: Math.abs(f0),
    point: p1,
  };
}

// The one root of c0 + c1 t + c2 t² in [0, 1], given the signs at 0 and 1
// differ; null where the closed form does not land one there.
function rootBetween(c0: number, c1: number, c2: number): number | null {
  if (Math.abs(c2) <= 1e-14 * (Math.abs(c0) + Math.abs(c1))) {
    if (c1 === 0) return null;
    const t = -c0 / c1;
    return t >= 0 && t <= 1 ? t : null;
  }
  const disc = c1 * c1 - 4 * c2 * c0;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  // Citardauq form for the root that would cancel.
  const q = -0.5 * (c1 + (c1 >= 0 ? sq : -sq));
  const r1 = q / c2;
  const r2 = q !== 0 ? c0 / q : r1;
  if (r1 >= 0 && r1 <= 1) return r1;
  if (r2 >= 0 && r2 <= 1) return r2;
  return null;
}

// Where a point of `body` that is at `now` was at `pose`. Rigid transform, so
// the point's offset from the body's origin simply turns back with it.
export function pointAtPose(body: PhysicsBody2D, pose: Pose, now: Vec2): Vec2 {
  return pose.position.add(now.sub(body.globalPosition).rotated(pose.rotation - body.globalRotation));
}

// Did the shape pass through the span? Polygons by their exposed vertices
// (a seam vertex has no outside to bend round, so it cannot be what the rope
// caught), circles by their centre - a disc whose centre crossed the span has
// been passed through entirely, and one whose centre did not has at most been
// brushed. Several vertices of one shape may have crossed; the answer is the
// one that stood farthest off the span before it crossed, which is the one the
// direction is least ambiguous about.
//
// `pose` is the body's transform at the last look, or null for a body that did
// not move. `exposed` filters the polygon's vertex loop.
export function shapeCrossesSpan(
  shape: CollisionShape2D,
  pose: Pose | null,
  span: SpanMotion,
  exposed: (vertexIndex: number) => boolean,
): Crossing | null {
  const body = shape.owner as PhysicsBody2D;
  const before = (p: Vec2): Vec2 => (pose ? pointAtPose(body, pose, p) : p);
  if (shape.shape.kind === "circle") {
    const c = shape.globalPosition;
    return pointCrossesSpan(span, before(c), c);
  }
  const corners = ShapeGeometry.getGlobalCorners(shape);
  let best: Crossing | null = null;
  for (let i = 0; i < corners.length; i++) {
    if (!exposed(i)) continue;
    const v = corners[i]!;
    const crossing = pointCrossesSpan(span, before(v), v);
    if (crossing && (best === null || crossing.commitment > best.commitment)) best = crossing;
  }
  return best;
}

// The world box the moving span covers, for a broadphase query.
export function spanMotionBox(span: SpanMotion): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(span.s0.x, span.e0.x, span.s1.x, span.e1.x),
    minY: Math.min(span.s0.y, span.e0.y, span.s1.y, span.e1.y),
    maxX: Math.max(span.s0.x, span.e0.x, span.s1.x, span.e1.x),
    maxY: Math.max(span.s0.y, span.e0.y, span.s1.y, span.e1.y),
  };
}
