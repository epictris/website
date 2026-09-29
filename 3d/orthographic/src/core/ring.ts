// Simple closed polygons ("rings") and the object outline model built on them.

import { clone, MIN_SIZE } from "./math";
import { partBox, setWorldParts, worldParts } from "./parts";
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

/** A normalised outline point of a part in world units on the view plane. */
export function toWorld(e: SceneObject, view: ViewId, p: Point, part = 0): Point {
  const [a, b] = VIEWS[view].axes;
  const box = partBox(e, e.parts[part]);
  return [box.min[a] + p[0] * box.size[a], box.min[b] + p[1] * box.size[b]];
}

export function toNormalized(e: SceneObject, view: ViewId, p: Point, part = 0): Point {
  const [a, b] = VIEWS[view].axes;
  const box = partBox(e, e.parts[part]);
  return [(p[0] - box.min[a]) / box.size[a], (p[1] - box.min[b]) / box.size[b]];
}

export const worldRing = (e: SceneObject, view: ViewId, part = 0): Ring =>
  e.parts[part].outlines[view].map((p) => toWorld(e, view, p, part));

/**
 * Replace one view's outline of a part with `raw` (normalised against
 * `start`'s part box). The outline is re-normalised to its own extent, and the
 * part's box follows it along the view's two axes (and the object's box
 * follows its parts); the other two views keep their shape and stretch along
 * the changed axis. Returns false (and leaves e untouched) when raw is not a
 * simple polygon or would collapse an axis.
 */
export function assignRing(e: SceneObject, start: SceneObject, view: ViewId, raw: Ring, part = 0): boolean {
  if (!ringValid(raw)) return false;
  const { lo, hi } = ringExtent(raw);
  const sz = [hi[0] - lo[0], hi[1] - lo[1]];
  const axes = VIEWS[view].axes;
  const parts = clone(worldParts(start));
  const p = parts[part];
  if (sz.some((s, j) => s * p.size[axes[j]] < MIN_SIZE)) return false;
  axes.forEach((a, j) => {
    p.min[a] += lo[j] * p.size[a];
    p.size[a] *= sz[j];
  });
  p.outlines[view] = raw.map((q) => [(q[0] - lo[0]) / sz[0], (q[1] - lo[1]) / sz[1]] as Point);
  setWorldParts(e, parts);
  e.reviewed = false;
  return true;
}

/** Set one view's outline of a part from world-unit points. */
export function setWorldRing(e: SceneObject, view: ViewId, world: Ring, part = 0): boolean {
  const start = clone(e);
  return assignRing(
    e,
    start,
    view,
    world.map((p) => toNormalized(start, view, p, part)),
    part,
  );
}

/** Do segments ab and cd cross or touch (sharing no endpoint)? */
function segmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: Point, q: Point, r: Point, k: number) =>
    k === 0 &&
    r[0] >= Math.min(p[0], q[0]) &&
    r[0] <= Math.max(p[0], q[0]) &&
    r[1] >= Math.min(p[1], q[1]) &&
    r[1] <= Math.max(p[1], q[1]);
  return on(a, b, c, d1) || on(a, b, d, d2) || on(c, d, a, d3) || on(c, d, b, d4);
}

/**
 * Remove corners, least significant first (the one nearest the chord of its
 * neighbours), while the error stays within maxError, and beyond that until
 * at most maxPoints remain. A removal that would make the ring cross itself is
 * skipped. The ring stays a simple polygon throughout.
 */
export function simplify(ring: Ring, opts: { maxError: number; maxPoints?: number; minPoints?: number }): Ring {
  const n = ring.length;
  const minPoints = Math.max(3, opts.minPoints ?? 3);
  const maxPoints = Math.max(minPoints, opts.maxPoints ?? Infinity);
  const prev = Int32Array.from({ length: n }, (_, i) => (i - 1 + n) % n);
  const next = Int32Array.from({ length: n }, (_, i) => (i + 1) % n);
  const alive = new Uint8Array(n).fill(1);
  const version = new Uint32Array(n);
  const errorOf = (i: number) => {
    const a = ring[prev[i]];
    const b = ring[i];
    const c = ring[next[i]];
    const dx = c[0] - a[0];
    const dy = c[1] - a[1];
    const t = Math.max(0, Math.min(1, ((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(b[0] - a[0] - t * dx, b[1] - a[1] - t * dy);
  };
  // A binary heap of [error, index, version]; stale entries are skipped.
  const heap: [number, number, number][] = [];
  const push = (e: [number, number, number]) => {
    heap.push(e);
    let k = heap.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (heap[up][0] <= heap[k][0]) break;
      [heap[up], heap[k]] = [heap[k], heap[up]];
      k = up;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) push([errorOf(i), i, 0]);
  let count = n;
  // Removing i joins a = prev[i] to c = next[i]. The chord must meet no other edge, and the
  // edges beside it (into a, out of c) may share only their endpoint, never fold back along it.
  const foldsBack = (at: Point, other: Point, far: Point) => {
    const cr = (far[0] - at[0]) * (other[1] - at[1]) - (far[1] - at[1]) * (other[0] - at[0]);
    return cr === 0 && (far[0] - at[0]) * (other[0] - at[0]) + (far[1] - at[1]) * (other[1] - at[1]) > 0;
  };
  const chordClear = (i: number) => {
    const ia = prev[i];
    const ic = next[i];
    const a = ring[ia];
    const c = ring[ic];
    if (foldsBack(c, a, ring[next[ic]]) || foldsBack(a, c, ring[prev[ia]])) return false;
    const lo = [Math.min(a[0], c[0]), Math.min(a[1], c[1])];
    const hi = [Math.max(a[0], c[0]), Math.max(a[1], c[1])];
    for (let j = next[ic]; next[j] !== ia && j !== ia; j = next[j]) {
      const p1 = ring[j];
      const p2 = ring[next[j]];
      if (Math.max(p1[0], p2[0]) < lo[0] || Math.min(p1[0], p2[0]) > hi[0]) continue;
      if (Math.max(p1[1], p2[1]) < lo[1] || Math.min(p1[1], p2[1]) > hi[1]) continue;
      if (segmentsMeet(a, c, p1, p2)) return false;
    }
    return true;
  };
  while (heap.length && count > minPoints) {
    const [error, i, v] = pop();
    if (!alive[i] || v !== version[i]) continue;
    if (error > opts.maxError && count <= maxPoints) break;
    if (!chordClear(i)) continue;
    alive[i] = 0;
    count--;
    const [a, c] = [prev[i], next[i]];
    next[a] = c;
    prev[c] = a;
    for (const k of [a, c]) {
      version[k]++;
      push([errorOf(k), k, version[k]]);
    }
  }
  const start = alive.indexOf(1);
  const out: Ring = [];
  for (let i = start, k = 0; k < count; i = next[i], k++) out.push([...ring[i]] as Point);
  return out;
}

/** Remove near-collinear corners while the ring stays valid. Returns the number removed. */
export function simplifyRing(ring: Ring, maxError: number): { ring: Ring; removed: number } {
  const out = simplify(ring, { maxError, minPoints: 4 });
  return ringValid(out) ? { ring: out, removed: ring.length - out.length } : { ring: clone(ring), removed: 0 };
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
