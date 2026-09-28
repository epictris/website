// Simple closed polygons ("rings") and the object outline model built on them.

import { clone, MIN_SIZE } from "./math";
import type { Point, Ring, SceneObject, ViewId } from "./types";
import { VIEWS } from "./views";

export const MAX_RING_POINTS = 512;

export function polyArea(r: Ring): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export type RingProblem =
  | "too-few-points"
  | "too-many-points"
  | "not-finite"
  | "repeated-point"
  | "self-intersection"
  | "zero-area";

export const RING_PROBLEMS: Record<RingProblem, string> = {
  "too-few-points": "needs at least 3 points",
  "too-many-points": `has more than ${MAX_RING_POINTS} points`,
  "not-finite": "has a point that is not a pair of finite numbers",
  "repeated-point": "has two consecutive identical points (do not repeat the first point at the end)",
  "self-intersection": "crosses or touches itself",
  "zero-area": "encloses no area",
};

/** Why a ring is not a simple closed polygon, or null when it is. */
export function ringProblem(r: unknown): RingProblem | null {
  if (!Array.isArray(r) || r.length < 3) return "too-few-points";
  if (r.length > MAX_RING_POINTS) return "too-many-points";
  if (r.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((x) => typeof x !== "number" || !Number.isFinite(x))))
    return "not-finite";
  const ring = r as Ring;
  // Tolerances are relative to the ring's extent so world-unit and normalised rings behave alike.
  const extent = Math.max(
    ...[0, 1].map((a) => Math.max(...ring.map((p) => p[a])) - Math.min(...ring.map((p) => p[a]))),
    1e-12,
  );
  const eps = 1e-10 * extent * extent;
  const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const tol = 1e-10 * extent;
  const on = (a: Point, b: Point, p: Point) =>
    Math.abs(cross(a, b, p)) < eps &&
    p[0] >= Math.min(a[0], b[0]) - tol &&
    p[0] <= Math.max(a[0], b[0]) + tol &&
    p[1] >= Math.min(a[1], b[1]) - tol &&
    p[1] <= Math.max(a[1], b[1]) + tol;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7 * extent) return "repeated-point";
    for (let j = i + 1; j < ring.length; j++) {
      if (j === (i + 1) % ring.length || (j + 1) % ring.length === i) continue;
      const c = ring[j];
      const d = ring[(j + 1) % ring.length];
      const c1 = cross(a, b, c);
      const c2 = cross(a, b, d);
      const c3 = cross(c, d, a);
      const c4 = cross(c, d, b);
      if ((c1 * c2 < 0 && c3 * c4 < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b))
        return "self-intersection";
    }
  }
  return Math.abs(polyArea(ring)) > 1e-8 * extent * extent ? null : "zero-area";
}

export const ringValid = (r: unknown): r is Ring => ringProblem(r) === null;

export function ringExtent(r: Ring): { lo: Point; hi: Point } {
  return {
    lo: [Math.min(...r.map((p) => p[0])), Math.min(...r.map((p) => p[1]))],
    hi: [Math.max(...r.map((p) => p[0])), Math.max(...r.map((p) => p[1]))],
  };
}

/** A normalised outline point in world units on the view plane. */
export function toWorld(e: SceneObject, view: ViewId, p: Point): Point {
  const [a, b] = VIEWS[view].axes;
  return [e.min[a] + p[0] * e.size[a], e.min[b] + p[1] * e.size[b]];
}

export function toNormalized(e: SceneObject, view: ViewId, p: Point): Point {
  const [a, b] = VIEWS[view].axes;
  return [(p[0] - e.min[a]) / e.size[a], (p[1] - e.min[b]) / e.size[b]];
}

export const worldRing = (e: SceneObject, view: ViewId): Ring => e.outlines[view].map((p) => toWorld(e, view, p));

/**
 * Replace one view's outline with `raw` (normalised against `start`'s box).
 * The outline is re-normalised to its own extent, and the object's box
 * follows it along the view's two axes; the other two views keep their shape
 * and stretch along the changed axis. Returns false (and leaves e untouched)
 * when raw is not a simple polygon or would collapse an axis.
 */
export function assignRing(e: SceneObject, start: SceneObject, view: ViewId, raw: Ring): boolean {
  if (!ringValid(raw)) return false;
  const { lo, hi } = ringExtent(raw);
  const sz = [hi[0] - lo[0], hi[1] - lo[1]];
  const axes = VIEWS[view].axes;
  if (sz.some((s, j) => s * start.size[axes[j]] < MIN_SIZE)) return false;
  e.min = [...start.min];
  e.size = [...start.size];
  e.outlines = clone(start.outlines);
  axes.forEach((a, j) => {
    e.min[a] = start.min[a] + lo[j] * start.size[a];
    e.size[a] = start.size[a] * sz[j];
  });
  e.outlines[view] = raw.map((p) => [(p[0] - lo[0]) / sz[0], (p[1] - lo[1]) / sz[1]] as Point);
  e.reviewed = false;
  return true;
}

/** Set one view's outline from world-unit points. */
export function setWorldRing(e: SceneObject, view: ViewId, world: Ring): boolean {
  const start = clone(e);
  return assignRing(
    e,
    start,
    view,
    world.map((p) => toNormalized(start, view, p)),
  );
}

/** Remove near-collinear corners while the ring stays valid. Returns the number removed. */
export function simplifyRing(ring: Ring, maxError: number): { ring: Ring; removed: number } {
  let raw = clone(ring);
  let removed = 0;
  while (raw.length > 4) {
    let best = -1;
    let dist = Infinity;
    raw.forEach((b, i) => {
      const a = raw[(i - 1 + raw.length) % raw.length];
      const c = raw[(i + 1) % raw.length];
      const dx = c[0] - a[0];
      const dy = c[1] - a[1];
      const t = Math.max(0, Math.min(1, ((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(b[0] - a[0] - t * dx, b[1] - a[1] - t * dy);
      if (d < dist) {
        best = i;
        dist = d;
      }
    });
    if (dist > maxError) break;
    const next = clone(raw);
    next.splice(best, 1);
    if (!ringValid(next)) break;
    raw = next;
    removed++;
  }
  return { ring: raw, removed };
}

export type Primitive = "box" | "ellipsoid" | "cylinder" | "rock";

/** Normalised starting outlines for a new object. */
export function presetOutlines(type: Primitive): Record<ViewId, Ring> {
  const box: Ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const round: Ring = Array.from({ length: 32 }, (_, i) => [
    0.5 + 0.5 * Math.cos((i * Math.PI) / 16),
    0.5 + 0.5 * Math.sin((i * Math.PI) / 16),
  ]);
  const ledge: Ring = [
    [0.16, 0],
    [0.72, 0],
    [0.87, 0.24],
    [1, 0.88],
    [0.84, 1],
    [0.18, 0.98],
    [0, 0.89],
    [0.04, 0.43],
  ];
  const elevation = type === "ellipsoid" ? round : type === "rock" ? ledge : box;
  const plan = type === "box" ? box : round;
  return { front: clone(elevation), top: clone(plan), side: clone(elevation) };
}
