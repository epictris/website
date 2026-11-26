// Where a painted decoration's brush stamps land, and how they add up: the
// stamp brush's `composite` (tools/blender/stampbrush/geometry.py), ported
// once and shared by everything that composites strokes in TypeScript - the
// editor's coverage dots (src/editor/paintCoverage.ts), a material layer's
// mask in the editor and in its build (materialMask.ts). DOM-free.

import type { PaintStamp } from "../level/levelFormat";

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Points on a rock's surface with their faces' normals (the formation's
// frame), sorted by x so a stamp visits only the points within its radius in
// x.
export class StampPoints {
  private readonly order: Uint32Array;
  private readonly xs: Float32Array;

  constructor(
    readonly points: Float32Array,
    readonly normals: Float32Array,
  ) {
    const n = points.length / 3;
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => points[i * 3]! - points[j * 3]!);
    this.order = Uint32Array.from(order);
    this.xs = Float32Array.from(order, (i) => points[i * 3]!);
  }

  get count(): number {
    return this.xs.length;
  }

  // Every point a stamp reaches, with the weight it lays there before its
  // strength (`composite` in stampbrush/geometry.py): a smooth falloff to
  // its rim, and nothing on a face turned away from the stamp's normal.
  reach(s: Pick<PaintStamp, "p" | "n" | "r">, visit: (i: number, w: number) => void): void {
    const [cx, cy, cz] = s.p;
    const r = s.r;
    const nl = Math.hypot(s.n[0], s.n[1], s.n[2]) || 1;
    const nx = s.n[0] / nl;
    const ny = s.n[1] / nl;
    const nz = s.n[2] / nl;
    let lo = lowerBound(this.xs, cx - r);
    const hi = upperBound(this.xs, cx + r);
    for (; lo < hi; lo++) {
      const i = this.order[lo]!;
      const dx = this.points[i * 3]! - cx;
      const dy = this.points[i * 3 + 1]! - cy;
      const dz = this.points[i * 3 + 2]! - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= r) continue;
      let w = smoothstep(0, 1, 1 - d / r);
      // A stamp on a ledge's top does not paint the ledge's underside.
      w *= smoothstep(-0.2, 0.35, this.normals[i * 3]! * nx + this.normals[i * 3 + 1]! * ny + this.normals[i * 3 + 2]! * nz);
      if (w > 0) visit(i, w);
    }
  }
}

// One stamp onto the paint `m` (0 to 1 per point of `points`), as `composite`
// in stampbrush/geometry.py: painting is "over", erasing scales it down.
// `touched` sees every point it changed.
export function compositeStamp(m: Float32Array, points: StampPoints, s: PaintStamp, touched?: (i: number) => void): void {
  points.reach(s, (i, w) => {
    const aw = Math.abs(s.s) * w;
    if (s.s >= 0) m[i] = m[i]! + (1 - m[i]!) * aw;
    else m[i] = m[i]! * (1 - aw);
    touched?.(i);
  });
}

function lowerBound(xs: Float32Array, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(xs: Float32Array, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
