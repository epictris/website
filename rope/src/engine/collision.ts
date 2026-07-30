// Analytic collision queries used by the physics substitute:
//  - swept circle vs {rect, poly, circle}  (for CharacterBody2D.moveAndCollide)
//  - ray vs {rect, poly, circle}           (for space-state IntersectRay)
//  - point/circle overlap + depenetration normal (rest resolution)
//
// The player and hook are circles; static geometry and dynamic bodies are
// circles, body-aligned rectangles or convex polygons. Everything is expressed
// with Vec2.
//
// The rect routines are the closed-form slab method and are left exactly as
// they were: every recorded replay was simulated through them, and a rect
// re-expressed as a 4-vertex polygon would take the general path below and
// agree geometrically but not bit-for-bit. Polygons therefore get their own
// branch throughout rather than the two being merged.

import { Vec2 } from "./vec2";
import { polyEdgeNormal, shapeVertices } from "./shapes";
import type { Shape, ShapeTransform } from "./shapes";
import type { CollisionObject2D } from "./body";

const EPS = 1e-6;

export interface SweepHit {
  // Fraction of the motion vector at first contact, in [0, 1].
  readonly t: number;
  // Contact normal pointing away from the hit shape (toward the moving circle).
  readonly normal: Vec2;
}

export interface RayHit {
  readonly position: Vec2;
  readonly normal: Vec2;
  // Fraction along the ray in [0, 1].
  readonly t: number;
}

// ---------------------------------------------------------------------------
// Local-space helpers
// ---------------------------------------------------------------------------

function toLocal(p: Vec2, center: Vec2, rot: number): Vec2 {
  return p.sub(center).rotated(-rot);
}

function toWorldDir(v: Vec2, rot: number): Vec2 {
  return v.rotated(rot);
}

// Smallest root t in [0, 1] of |p + t*d - c|^2 = r^2 (ray vs circle from outside).
function rayCircleT(p: Vec2, d: Vec2, c: Vec2, r: number): number | null {
  const f = p.sub(c);
  const a = d.dot(d);
  if (a < EPS) return null;
  const b = 2 * f.dot(d);
  const cc = f.dot(f) - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  const t2 = (-b + sq) / (2 * a);
  if (t2 >= 0 && t2 <= 1) return t2;
  return null;
}

// ---------------------------------------------------------------------------
// Convex-polygon helpers (local frame)
// ---------------------------------------------------------------------------

// Closest point to `p` on the segment a→b.
function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = b.sub(a);
  const lenSq = ab.dot(ab);
  if (lenSq < EPS * EPS) return a;
  const t = Math.max(0, Math.min(1, p.sub(a).dot(ab) / lenSq));
  return a.add(ab.mul(t));
}

// Closest point on a convex loop's boundary to `p`, in the same frame.
function closestOnLoop(p: Vec2, verts: readonly Vec2[]): { point: Vec2; distSq: number } {
  let best = verts[0]!;
  let bestSq = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const c = closestOnSegment(p, verts[i]!, verts[(i + 1) % verts.length]!);
    const d = p.distanceSquaredTo(c);
    if (d < bestSq) {
      bestSq = d;
      best = c;
    }
  }
  return { point: best, distSq: bestSq };
}

// The edge whose supporting plane `p` is furthest outside (or least far inside),
// with that signed distance. Negative everywhere means `p` is inside the loop,
// and the returned edge is the shallowest one — the minimum-translation face.
function deepestPlane(p: Vec2, verts: readonly Vec2[]): { edge: number; dist: number } {
  let edge = 0;
  let dist = -Infinity;
  for (let i = 0; i < verts.length; i++) {
    const n = polyEdgeNormal(verts, i);
    if (n.x === 0 && n.y === 0) continue; // degenerate edge
    const d = n.dot(p.sub(verts[i]!));
    if (d > dist) {
      dist = d;
      edge = i;
    }
  }
  return { edge, dist };
}

// Clip the ray p + t·d against a convex loop whose faces are pushed outward by
// `expand` (the swept circle's radius, or 0 for a plain ray). The n-plane
// generalisation of the slab method the rect routines use: same tEnter/tExit
// walk, one plane per edge instead of two axis slabs.
//
// Returns null when the ray misses the (expanded) region entirely. `enterEdge`
// is -1 only when no plane was ever entered, i.e. the direction is degenerate.
function clipConvex(
  p: Vec2,
  d: Vec2,
  verts: readonly Vec2[],
  expand: number,
): { tEnter: number; tExit: number; enterEdge: number } | null {
  let tEnter = -Infinity;
  let tExit = Infinity;
  let enterEdge = -1;
  for (let i = 0; i < verts.length; i++) {
    const n = polyEdgeNormal(verts, i);
    if (n.x === 0 && n.y === 0) continue;
    // Signed distance from p to the outward-offset plane of this edge.
    const dist = n.dot(p.sub(verts[i]!)) - expand;
    const denom = n.dot(d);
    if (Math.abs(denom) < EPS) {
      if (dist > 0) return null; // parallel to the plane and on its outside
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) {
      if (t > tEnter) {
        tEnter = t;
        enterEdge = i;
      }
    } else if (t < tExit) {
      tExit = t;
    }
    if (tEnter > tExit) return null;
  }
  return { tEnter, tExit, enterEdge };
}

// ---------------------------------------------------------------------------
// Swept circle vs shapes
// ---------------------------------------------------------------------------

// Swept circle (centre p0, radius r) moving by d against a convex polygon.
// Structurally the same as sweepCircleRect: clip against the outward-offset
// faces, take the entering one when the contact lands within its extent, and
// otherwise refine against the corner as a circle of radius r.
function sweepCirclePoly(
  p0: Vec2,
  d: Vec2,
  r: number,
  center: Vec2,
  rot: number,
  verts: readonly Vec2[],
): SweepHit | null {
  const p = toLocal(p0, center, rot);
  const dir = d.rotated(-rot);
  const clip = clipConvex(p, dir, verts, r);
  if (!clip || clip.enterEdge < 0) return null;
  if (clip.tEnter > 1 + EPS || clip.tExit < 0) return null;

  const t = Math.max(clip.tEnter, 0);
  const hit = p.add(dir.mul(t));
  const i = clip.enterEdge;
  const a = verts[i]!;
  const b = verts[(i + 1) % verts.length]!;
  const edge = b.sub(a);
  const len = edge.length();
  // Where along the entering face the contact sits. Inside the face's extent
  // the normal is the face normal; past either end it is a corner contact.
  const s = len > EPS ? edge.dot(hit.sub(a)) / len : 0;
  if (s >= -EPS && s <= len + EPS) {
    return { t, normal: toWorldDir(polyEdgeNormal(verts, i), rot) };
  }

  const corner = s < 0 ? a : b;
  const ct = rayCircleT(p, dir, corner, r);
  if (ct === null) return null;
  const contact = p.add(dir.mul(ct));
  const n = contact.sub(corner).normalized();
  return { t: ct, normal: toWorldDir(n, rot) };
}

// Swept circle (center p0, radius r) moving by d against a body-aligned rect.
function sweepCircleRect(
  p0: Vec2,
  d: Vec2,
  r: number,
  rectCenter: Vec2,
  rectRot: number,
  hw: number,
  hh: number,
): SweepHit | null {
  // Work in rect-local space where the rect is axis-aligned.
  const p = toLocal(p0, rectCenter, rectRot);
  const dir = d.rotated(-rectRot);
  const ex = hw + r;
  const ey = hh + r;

  // Ray vs expanded AABB [-ex, ex] x [-ey, ey] using the slab method.
  let tEnter = -Infinity;
  let enterAxis = -1; // 0 = x, 1 = y
  let enterSign = 0;
  let tExit = Infinity;

  const comps = [
    { pos: p.x, dd: dir.x, e: ex, axis: 0 },
    { pos: p.y, dd: dir.y, e: ey, axis: 1 },
  ];
  for (const { pos, dd, e, axis } of comps) {
    if (Math.abs(dd) < EPS) {
      if (pos < -e || pos > e) return null; // parallel and outside the slab
      continue;
    }
    let tNear = (-e - pos) / dd;
    let tFar = (e - pos) / dd;
    let nearSign = -1; // hitting the -e face → local normal points -axis
    if (tNear > tFar) {
      const tmp = tNear;
      tNear = tFar;
      tFar = tmp;
      nearSign = 1;
    }
    if (tNear > tEnter) {
      tEnter = tNear;
      enterAxis = axis;
      enterSign = nearSign;
    }
    if (tFar < tExit) tExit = tFar;
    if (tEnter > tExit) return null;
  }

  if (tEnter > 1 + EPS || tExit < 0) return null;
  const t = Math.max(tEnter, 0);
  const hit = p.add(dir.mul(t));

  // If the contact lies within the flat extent of the entering face, the normal
  // is axis-aligned. Otherwise it is a corner contact — refine with a circle.
  const localNormal =
    enterAxis === 0 ? new Vec2(enterSign, 0) : new Vec2(0, enterSign);
  const withinFace =
    enterAxis === 0 ? Math.abs(hit.y) <= hh + EPS : Math.abs(hit.x) <= hw + EPS;

  if (withinFace) {
    return { t, normal: toWorldDir(localNormal, rectRot) };
  }

  // Corner region: sweep against the nearest rect vertex as a circle of radius r.
  const corner = new Vec2(
    hit.x >= 0 ? hw : -hw,
    hit.y >= 0 ? hh : -hh,
  );
  const ct = rayCircleT(p, dir, corner, r);
  if (ct === null) return null;
  const contact = p.add(dir.mul(ct));
  const n = contact.sub(corner).normalized();
  return { t: ct, normal: toWorldDir(n, rectRot) };
}

// Swept circle (radius r0) vs a static circle (radius r1).
function sweepCircleCircle(
  p0: Vec2,
  d: Vec2,
  r0: number,
  center: Vec2,
  r1: number,
): SweepHit | null {
  const t = rayCircleT(p0, d, center, r0 + r1);
  if (t === null) return null;
  const contact = p0.add(d.mul(t));
  const n = contact.sub(center).normalized();
  return { t, normal: n };
}

// Sweep a moving circle of radius r from p0 along d against a target shape.
export function sweepCircle(
  p0: Vec2,
  d: Vec2,
  r: number,
  target: ShapeTransform,
): SweepHit | null {
  const s = target.shape;
  if (s.kind === "circle") {
    return sweepCircleCircle(p0, d, r, target.globalPosition, s.radius);
  }
  if (s.kind === "poly") {
    return sweepCirclePoly(p0, d, r, target.globalPosition, target.globalRotation, s.verts);
  }
  return sweepCircleRect(
    p0,
    d,
    r,
    target.globalPosition,
    target.globalRotation,
    s.size.x * 0.5,
    s.size.y * 0.5,
  );
}

// ---------------------------------------------------------------------------
// Overlap + depenetration (rest resolution when a sweep starts embedded)
// ---------------------------------------------------------------------------

// If a circle at `p` (radius r) overlaps `target`, return the minimum-translation
// normal (pointing out of the target) and penetration depth; else null.
export function circleOverlap(
  p: Vec2,
  r: number,
  target: ShapeTransform,
): { normal: Vec2; depth: number } | null {
  const s = target.shape;
  if (s.kind === "circle") {
    const delta = p.sub(target.globalPosition);
    const dist = delta.length();
    const pen = r + s.radius - dist;
    if (pen <= 0) return null;
    const normal = dist < EPS ? Vec2.UP : delta.div(dist);
    return { normal, depth: pen };
  }
  if (s.kind === "poly") {
    const rot = target.globalRotation;
    const local = toLocal(p, target.globalPosition, rot);
    const plane = deepestPlane(local, s.verts);
    // Every face plane cleared by more than r: no contact is possible, and this
    // is exact for the plane test even when the true closest feature is a corner
    // (the plane distance is a lower bound on the boundary distance).
    if (plane.dist > r) return null;
    if (plane.dist <= 0) {
      // Inside the polygon: push out through the shallowest face, as the rect
      // path pushes out along the axis of least penetration.
      return {
        normal: toWorldDir(polyEdgeNormal(s.verts, plane.edge), rot),
        depth: r - plane.dist,
      };
    }
    const near = closestOnLoop(local, s.verts);
    if (near.distSq > r * r) return null;
    if (near.distSq > EPS * EPS) {
      const dist = Math.sqrt(near.distSq);
      return {
        normal: toWorldDir(local.sub(near.point).div(dist), rot),
        depth: r - dist,
      };
    }
    // Exactly on the boundary — no direction to take from the closest point.
    return { normal: toWorldDir(polyEdgeNormal(s.verts, plane.edge), rot), depth: r };
  }
  const hw = s.size.x * 0.5;
  const hh = s.size.y * 0.5;
  const local = toLocal(p, target.globalPosition, target.globalRotation);
  const cx = Math.max(-hw, Math.min(hw, local.x));
  const cy = Math.max(-hh, Math.min(hh, local.y));
  const dx = local.x - cx;
  const dy = local.y - cy;
  const distSq = dx * dx + dy * dy;
  if (distSq > r * r) return null;
  if (distSq > EPS) {
    const dist = Math.sqrt(distSq);
    const n = new Vec2(dx / dist, dy / dist);
    return { normal: toWorldDir(n, target.globalRotation), depth: r - dist };
  }
  // Deep inside: push out along the axis of least penetration.
  const dRight = hw - local.x;
  const dLeft = hw + local.x;
  const dTop = hh + local.y;
  const dBottom = hh - local.y;
  const minPen = Math.min(dRight, dLeft, dTop, dBottom);
  let n: Vec2;
  if (minPen === dRight) n = new Vec2(1, 0);
  else if (minPen === dLeft) n = new Vec2(-1, 0);
  else if (minPen === dBottom) n = new Vec2(0, 1);
  else n = new Vec2(0, -1);
  return { normal: toWorldDir(n, target.globalRotation), depth: r + minPen };
}

// Direction from the shape's closest surface point toward p — which side of
// the shape p is on. Used to validate sweep normals against phantom
// "hit-from-inside" contacts on thin shapes.
export function outwardDirection(p: Vec2, target: ShapeTransform): Vec2 {
  const s = target.shape;
  if (s.kind === "circle") {
    const delta = p.sub(target.globalPosition);
    return delta.length() < EPS ? Vec2.UP : delta.normalized();
  }
  if (s.kind === "poly") {
    const rot = target.globalRotation;
    const local = toLocal(p, target.globalPosition, rot);
    const plane = deepestPlane(local, s.verts);
    if (plane.dist <= 0) return toWorldDir(polyEdgeNormal(s.verts, plane.edge), rot);
    const near = closestOnLoop(local, s.verts);
    if (near.distSq <= EPS * EPS) {
      return toWorldDir(polyEdgeNormal(s.verts, plane.edge), rot);
    }
    return toWorldDir(local.sub(near.point).div(Math.sqrt(near.distSq)), rot);
  }
  const hw = s.size.x * 0.5;
  const hh = s.size.y * 0.5;
  const local = toLocal(p, target.globalPosition, target.globalRotation);
  const dx = local.x - Math.max(-hw, Math.min(hw, local.x));
  const dy = local.y - Math.max(-hh, Math.min(hh, local.y));
  const distSq = dx * dx + dy * dy;
  if (distSq > EPS) {
    const dist = Math.sqrt(distSq);
    return toWorldDir(new Vec2(dx / dist, dy / dist), target.globalRotation);
  }
  // Inside: side of the axis with least penetration (as in circleOverlap).
  const dRight = hw - local.x;
  const dLeft = hw + local.x;
  const dTop = hh + local.y;
  const dBottom = hh - local.y;
  const minPen = Math.min(dRight, dLeft, dTop, dBottom);
  let n: Vec2;
  if (minPen === dRight) n = new Vec2(1, 0);
  else if (minPen === dLeft) n = new Vec2(-1, 0);
  else if (minPen === dBottom) n = new Vec2(0, 1);
  else n = new Vec2(0, -1);
  return toWorldDir(n, target.globalRotation);
}

// ---------------------------------------------------------------------------
// Ray casts (space-state IntersectRay)
// ---------------------------------------------------------------------------

function rayVsCircle(
  from: Vec2,
  to: Vec2,
  center: Vec2,
  r: number,
  hitFromInside: boolean,
): RayHit | null {
  const d = to.sub(from);
  const f = from.sub(center);
  const a = d.dot(d);
  if (a < EPS) return null;
  const b = 2 * f.dot(d);
  const c = f.dot(f) - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  let t = -1;
  if (t1 >= 0 && t1 <= 1) t = t1;
  else if (hitFromInside && t2 >= 0 && t2 <= 1) t = t2;
  if (t < 0) return null;
  const pos = from.add(d.mul(t));
  return { position: pos, normal: pos.sub(center).normalized(), t };
}

function rayVsRect(
  from: Vec2,
  to: Vec2,
  center: Vec2,
  rot: number,
  hw: number,
  hh: number,
  hitFromInside: boolean,
): RayHit | null {
  const p = toLocal(from, center, rot);
  const q = toLocal(to, center, rot);
  const d = q.sub(p);

  let tEnter = -Infinity;
  let tExit = Infinity;
  let enterAxis = -1;
  let enterSign = 0;

  const comps = [
    { pos: p.x, dd: d.x, e: hw, axis: 0 },
    { pos: p.y, dd: d.y, e: hh, axis: 1 },
  ];
  for (const { pos, dd, e, axis } of comps) {
    if (Math.abs(dd) < EPS) {
      if (pos < -e || pos > e) return null;
      continue;
    }
    let tNear = (-e - pos) / dd;
    let tFar = (e - pos) / dd;
    let nearSign = -1;
    if (tNear > tFar) {
      const tmp = tNear;
      tNear = tFar;
      tFar = tmp;
      nearSign = 1;
    }
    if (tNear > tEnter) {
      tEnter = tNear;
      enterAxis = axis;
      enterSign = nearSign;
    }
    if (tFar < tExit) tExit = tFar;
    if (tEnter > tExit) return null;
  }

  let t = tEnter;
  let sign = enterSign;
  let axis = enterAxis;
  if (t < 0) {
    if (!hitFromInside) return null;
    // Origin is inside the rect — report the exit face instead.
    t = tExit;
    // Recompute which face tExit belongs to.
    axis = -1;
  }
  if (t < 0 || t > 1) return null;

  let localNormal: Vec2;
  if (axis === 0) localNormal = new Vec2(sign, 0);
  else if (axis === 1) localNormal = new Vec2(0, sign);
  else {
    // Inside-hit exit: normal from the closest face at the exit point.
    const hit = p.add(d.mul(t));
    const dRight = Math.abs(hw - hit.x);
    const dLeft = Math.abs(hw + hit.x);
    const dTop = Math.abs(hh + hit.y);
    const dBottom = Math.abs(hh - hit.y);
    const m = Math.min(dRight, dLeft, dTop, dBottom);
    if (m === dRight) localNormal = new Vec2(1, 0);
    else if (m === dLeft) localNormal = new Vec2(-1, 0);
    else if (m === dBottom) localNormal = new Vec2(0, 1);
    else localNormal = new Vec2(0, -1);
  }
  const worldPos = from.add(to.sub(from).mul(t));
  return { position: worldPos, normal: toWorldDir(localNormal, rot), t };
}

// Ray vs convex polygon: the n-plane version of rayVsRect's slab walk.
function rayVsPoly(
  from: Vec2,
  to: Vec2,
  center: Vec2,
  rot: number,
  verts: readonly Vec2[],
  hitFromInside: boolean,
): RayHit | null {
  const p = toLocal(from, center, rot);
  const q = toLocal(to, center, rot);
  const d = q.sub(p);
  const clip = clipConvex(p, d, verts, 0);
  if (!clip) return null;

  let t = clip.tEnter;
  let edge = clip.enterEdge;
  if (t < 0 || edge < 0) {
    if (!hitFromInside) return null;
    // Origin is inside the polygon — report the exit face instead, recovered
    // from the exit point (exactly as rayVsRect does for its inside hits).
    t = clip.tExit;
    edge = -1;
  }
  if (t < 0 || t > 1) return null;
  const localNormal =
    edge >= 0
      ? polyEdgeNormal(verts, edge)
      : polyEdgeNormal(verts, deepestPlane(p.add(d.mul(t)), verts).edge);
  return {
    position: from.add(to.sub(from).mul(t)),
    normal: toWorldDir(localNormal, rot),
    t,
  };
}

export function rayVsShape(
  from: Vec2,
  to: Vec2,
  target: ShapeTransform,
  hitFromInside: boolean,
): RayHit | null {
  const s = target.shape;
  if (s.kind === "circle") {
    return rayVsCircle(from, to, target.globalPosition, s.radius, hitFromInside);
  }
  if (s.kind === "poly") {
    return rayVsPoly(
      from,
      to,
      target.globalPosition,
      target.globalRotation,
      s.verts,
      hitFromInside,
    );
  }
  return rayVsRect(
    from,
    to,
    target.globalPosition,
    target.globalRotation,
    s.size.x * 0.5,
    s.size.y * 0.5,
    hitFromInside,
  );
}

// Radius of the shape's bounding circle about its own origin.
export function shapeRadius(s: Shape): number {
  if (s.kind === "circle") return s.radius;
  if (s.kind === "rect") return Math.hypot(s.size.x * 0.5, s.size.y * 0.5);
  let best = 0;
  for (const v of s.verts) best = Math.max(best, v.length());
  return best;
}

// Support point of a convex shape's vertex loop along a world-space direction —
// the SAT primitive the polygon contact solver is built from. Circles have no
// vertices, so the caller handles them separately.
export function shapeSupport(t: ShapeTransform, worldDir: Vec2): Vec2 {
  const verts = shapeVertices(t.shape);
  const local = worldDir.rotated(-t.globalRotation);
  let best = verts[0]!;
  let bestDot = -Infinity;
  for (const v of verts) {
    const d = v.dot(local);
    if (d > bestDot) {
      bestDot = d;
      best = v;
    }
  }
  return t.globalPosition.add(best.rotated(t.globalRotation));
}

// --- whole-body queries ------------------------------------------------------
// The same three questions, asked of a BODY rather than of one of its shapes.
//
// They exist because "ask the body" is what every caller actually meant, and the
// shape-at-a-time form let them mean it while only ever testing the first piece.
// A compound body is one body of several convex shapes (see "Convex-only
// polygons; compound bodies" in docs/game-design.md), and a query that stops at
// the primary treats the rest of it as empty space: the ball hook's swept attach
// test flew clean through the second piece of a three-piece wall, and the
// embedding invariants could not see a chain buried in one (`session-306f`).
//
// A single-shape body runs exactly the call it always ran, once.

// Deepest overlap of a probe circle against any shape `body` carries, or null.
// Deepest rather than first, because the piece the probe is furthest inside is
// the one whose normal actually pushes it out.
export function bodyOverlapCircle(
  body: CollisionObject2D,
  center: Vec2,
  radius: number,
): { normal: Vec2; depth: number } | null {
  let best: { normal: Vec2; depth: number } | null = null;
  for (const s of body.getShapes()) {
    const ov = circleOverlap(center, radius, s);
    if (ov && (!best || ov.depth > best.depth)) best = ov;
  }
  return best;
}

// Earliest swept-circle hit against any shape `body` carries, or null. Earliest
// because a sweep stops at first contact, and which piece that is depends on the
// direction of travel, not on the order the pieces were mounted.
export function bodySweepCircle(
  body: CollisionObject2D,
  from: Vec2,
  motion: Vec2,
  radius: number,
): SweepHit | null {
  let best: SweepHit | null = null;
  for (const s of body.getShapes()) {
    const hit = sweepCircle(from, motion, radius, s);
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  return best;
}

// Is `p` inside any shape `body` carries?
export function bodyContainsPoint(body: CollisionObject2D, p: Vec2): boolean {
  for (const s of body.getShapes()) {
    if (circleOverlap(p, 0, s)) return true;
  }
  return false;
}
