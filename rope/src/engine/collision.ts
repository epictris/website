// Analytic collision queries used by the physics substitute:
//  - swept circle vs {rect, circle}  (for CharacterBody2D.moveAndCollide)
//  - ray vs {rect, circle}           (for space-state IntersectRay)
//  - point/circle overlap + depenetration normal (rest resolution)
//
// The player and hook are circles; static geometry and dynamic bodies are
// circles or body-aligned rectangles. Everything is expressed with Vec2.

import { Vec2 } from "./vec2";
import type { Shape, ShapeTransform } from "./shapes";

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
// Swept circle vs shapes
// ---------------------------------------------------------------------------

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

export function shapeRadius(s: Shape): number {
  return s.kind === "circle" ? s.radius : Math.hypot(s.size.x * 0.5, s.size.y * 0.5);
}
