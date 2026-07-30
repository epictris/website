// Contact manifolds between a vertex shape (rect or convex polygon) and
// anything else. `circleOverlap` already answers the circle-vs-anything case in
// one point and one normal, which is all a circle can ever have; a polygon
// resting on a floor touches along a whole face, and resolving that as a single
// point is what makes a box teeter instead of settle. So this returns up to two
// points — the clipped overlap of the two touching faces.
//
// Convexity is assumed throughout (it is a hard rule of the shape format, see
// shapes.ts): separating-axis testing and face clipping are only valid for
// convex loops, which is the same reason the rope solver needs them.

import { Vec2 } from "./vec2";
import { polyEdgeNormal, shapeVertices } from "./shapes";
import type { ShapeTransform } from "./shapes";

export interface Contact {
  // Unit normal pointing OUT of `b` and toward `a` — the same orientation
  // `circleOverlap(aCentre, r, b)` reports, so a caller can treat a circle
  // contact and a polygon contact identically.
  readonly normal: Vec2;
  // Penetration depth along the normal. Positive when the shapes overlap;
  // negative (down to the caller's `slop`) when they are merely close, which is
  // still a contact as far as a constraint solver is concerned.
  readonly depth: number;
  // World-space contact point on the boundary.
  readonly point: Vec2;
  // Which pair of features produced this point — the reference face, the
  // incident edge, which side owned the reference face, and which end of the
  // clipped segment this is. Box2D's `b2ContactID`, and the reason it exists is
  // the same: the geometry moves a little every frame, but as long as the same
  // two faces are meeting, this is the same contact, so last frame's accumulated
  // impulse is a good starting guess for this one's (see the warm start in
  // `World.solveContacts`).
  //
  // Stability is the only requirement — the number is a key, never an index into
  // anything — so a wrong guess costs iterations and never correctness.
  readonly featureId: number;
}

const EPS = 1e-9;

// A circle has no faces to key on, and only ever produces one contact point, so
// every circle contact against a given pair of shapes is the same feature.
export const CIRCLE_FEATURE = -1;

// Pack (which shape owned the reference face, reference face, incident edge,
// which end of the clip) into one small integer. Vertex counts are single
// digits in practice and the fields are given four to eight bits each, so this
// stays well inside an exact double.
function featureId(useB: boolean, refIndex: number, incIndex: number, slot: number): number {
  return (useB ? 0x100000 : 0) | (refIndex << 12) | (incIndex << 4) | slot;
}

// A shape's vertex loop in world space.
function worldVerts(t: ShapeTransform): Vec2[] {
  return shapeVertices(t.shape).map((v) => t.globalPosition.add(v.rotated(t.globalRotation)));
}

// Outward world normal of the edge leaving vertex `i`. Rotation preserves
// orientation, so the local winding contract carries over unchanged.
function worldNormal(verts: readonly Vec2[], i: number): Vec2 {
  return polyEdgeNormal(verts, i);
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = b.sub(a);
  const lenSq = ab.lengthSquared();
  if (lenSq < EPS) return a;
  return a.add(ab.mul(Math.max(0, Math.min(1, p.sub(a).dot(ab) / lenSq))));
}

// The face of `verts` that `other` is furthest clear of, and by how much.
// Positive separation on any face means the two shapes are disjoint — the
// separating-axis theorem, in the form that also hands back the face to build a
// manifold from when they are not.
function maxSeparation(
  verts: readonly Vec2[],
  other: readonly Vec2[],
): { index: number; separation: number } {
  let index = 0;
  let separation = -Infinity;
  for (let i = 0; i < verts.length; i++) {
    const n = worldNormal(verts, i);
    if (n.x === 0 && n.y === 0) continue;
    let deepest = Infinity;
    for (const v of other) deepest = Math.min(deepest, n.dot(v.sub(verts[i]!)));
    if (deepest > separation) {
      separation = deepest;
      index = i;
    }
  }
  return { index, separation };
}

// The edge of `verts` facing most directly into `normal` — the face that
// actually meets the reference face.
function incidentEdge(verts: readonly Vec2[], normal: Vec2): number {
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const d = worldNormal(verts, i).dot(normal);
    if (d < best) {
      best = d;
      index = i;
    }
  }
  return index;
}

// Clip a segment to the half-plane n·(p - o) <= 0.
function clipToPlane(a: Vec2, b: Vec2, n: Vec2, o: Vec2): [Vec2, Vec2] | null {
  const da = n.dot(a.sub(o));
  const db = n.dot(b.sub(o));
  if (da <= 0 && db <= 0) return [a, b];
  if (da > 0 && db > 0) return null;
  const t = da / (da - db);
  const cut = a.add(b.sub(a).mul(t));
  return da <= 0 ? [a, cut] : [cut, b];
}

// Manifold between two vertex shapes.
function loopVsLoop(a: ShapeTransform, b: ShapeTransform, slop: number): Contact[] {
  const va = worldVerts(a);
  const vb = worldVerts(b);
  if (va.length < 3 || vb.length < 3) return [];

  const sa = maxSeparation(va, vb);
  const sb = maxSeparation(vb, va);
  if (sa.separation > slop || sb.separation > slop) return [];

  // Reference face: the shallower penetration. The small bias toward `b` keeps
  // a resting box on a floor picking the *floor's* face frame for frame rather
  // than flickering between the two when the depths are all but equal — a flip
  // there swaps the manifold and the box jitters.
  const useB = sb.separation > sa.separation + 1e-9;
  const [refVerts, incVerts] = useB ? [vb, va] : [va, vb];
  const refIndex = useB ? sb.index : sa.index;
  const refNormal = worldNormal(refVerts, refIndex);
  const refA = refVerts[refIndex]!;
  const refB = refVerts[(refIndex + 1) % refVerts.length]!;

  const incIndex = incidentEdge(incVerts, refNormal);
  let p0 = incVerts[incIndex]!;
  let p1 = incVerts[(incIndex + 1) % incVerts.length]!;

  // Trim the incident edge to the reference face's extent.
  const tangent = refB.sub(refA);
  const len = tangent.length();
  if (len < EPS) return [];
  const dir = tangent.div(len);
  let clipped = clipToPlane(p0, p1, dir.neg(), refA);
  if (!clipped) return [];
  clipped = clipToPlane(clipped[0], clipped[1], dir, refB);
  if (!clipped) return [];
  [p0, p1] = clipped;

  // The normal must point out of `b` toward `a`; the reference normal points out
  // of whichever shape owns the reference face.
  const normal = useB ? refNormal : refNormal.neg();
  const out: Contact[] = [];
  [p0, p1].forEach((p, slot) => {
    // Negative depth is separation, and within the slop band it is still a
    // contact - see `shapeContacts`.
    const depth = -refNormal.dot(p.sub(refA));
    if (depth > -slop) {
      out.push({ normal, depth, point: p, featureId: featureId(useB, refIndex, incIndex, slot) });
    }
  });
  return out;
}

// Manifold between a vertex shape `a` and a circle `b`: one point, on the
// polygon boundary nearest the circle's centre.
function loopVsCircle(a: ShapeTransform, centre: Vec2, radius: number, slop: number): Contact[] {
  const va = worldVerts(a);
  if (va.length < 3) return [];
  let closest = va[0]!;
  let bestSq = Infinity;
  for (let i = 0; i < va.length; i++) {
    const c = closestOnSegment(centre, va[i]!, va[(i + 1) % va.length]!);
    const d = centre.distanceSquaredTo(c);
    if (d < bestSq) {
      bestSq = d;
      closest = c;
    }
  }
  const dist = Math.sqrt(bestSq);
  // Is the centre inside the polygon? Then the boundary point is behind it and
  // the overlap is the radius plus the distance back out, not minus it.
  let inside = true;
  for (let i = 0; i < va.length; i++) {
    const n = worldNormal(va, i);
    if (n.x === 0 && n.y === 0) continue;
    if (n.dot(centre.sub(va[i]!)) > 0) {
      inside = false;
      break;
    }
  }
  if (!inside && dist > radius + slop) return [];
  // Points from the circle toward the polygon — out of `b` toward `a`.
  const normal =
    dist > EPS
      ? closest.sub(centre).div(dist).mul(inside ? -1 : 1)
      : Vec2.UP;
  return [
    { normal, depth: inside ? radius + dist : radius - dist, point: closest, featureId: CIRCLE_FEATURE },
  ];
}

// Contacts between `a` (a rect or convex polygon) and `b` (any shape), with
// normals pointing out of `b` toward `a`.
//
// `slop` widens the band a point is emitted in: at 0 (the default, and what
// every positional-recovery caller wants) only genuinely penetrating points come
// back, and a positive value also emits points that are merely CLOSE, reporting
// their separation as a negative `depth`.
//
// The constraint solver needs that band and nothing else does. A pile at rest is
// pushed to exactly zero overlap, and then every body in it falls by the same
// gravity step, so the interfaces between them never re-penetrate at all: at a
// strict `depth > 0` a resting stack's contacts simply vanish from the set. Warm
// starting has nothing to hold across a frame, the pile is re-derived from
// nothing every time its contacts flicker back, and the noise from that is what
// walked a four-box stack apart across the floor.
//
// A caller that pushes bodies out along `depth` must NOT pass a slop, or it will
// push a separated pair together.
export function shapeContacts(a: ShapeTransform, b: ShapeTransform, slop = 0): Contact[] {
  if (a.shape.kind === "circle") return []; // circles go through circleOverlap
  if (b.shape.kind === "circle") {
    return loopVsCircle(a, b.globalPosition, b.shape.radius, slop);
  }
  return loopVsLoop(a, b, slop);
}
