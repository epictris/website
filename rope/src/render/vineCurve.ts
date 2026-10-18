import type { Vec2 } from "../engine/vec2";

export interface VineCurvePoint {
  x: number; y: number; tx: number; ty: number; distance: number;
  material?: number; stretch?: number; twist?: number;
}

export function vineMaterial(p: VineCurvePoint): number { return p.material ?? p.distance; }

// The curve's tangent at link point `i`, one axis at a time. Exported so the 3D
// braid can hand the GPU the very tangents this sampler interpolates between.
export function vineTangent(path: readonly Vec2[], i: number, axis: "x" | "y"): number {
  const b = path[i]!;
  let prev = i - 1, next = i + 1;
  while (prev >= 0 && b.distanceTo(path[prev]!) < 1e-6) prev--;
  while (next < path.length && b.distanceTo(path[next]!) < 1e-6) next++;
  const a = path[Math.max(0, prev)]!, c = path[Math.min(path.length - 1, next)]!;
  const before = b.distanceTo(a), after = b.distanceTo(c);
  if (before < 1e-6) return after > 1e-6 ? (c[axis] - b[axis]) / after : 0;
  if (after < 1e-6) return (b[axis] - a[axis]) / before;
  return ((b[axis] - a[axis]) / before * after + (c[axis] - b[axis]) / after * before) / (before + after);
}

// Arc-weighted Hermite tangents join the physics links without adding bodies.
// Duplicate links are skipped; reversals have zero tangent rather than forming
// a loop. The supplied output storage is reused, and endpoints stay exact.
// `step` is the longest sample interval, in metres.
export function sampleVineCurve(
  path: readonly Vec2[], out: VineCurvePoint[] = [], storage = out, restLength?: number, step = .012,
): VineCurvePoint[] {
  let count = 0, distance = 0, lastX = 0, lastY = 0;
  const spacing = restLength === undefined ? 0 : restLength / Math.max(1, path.length - 1);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!, b = path[i + 1]!, len = a.distanceTo(b);
    if (len < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(len / step));
    const ax = vineTangent(path, i, "x"), ay = vineTangent(path, i, "y");
    const bx = vineTangent(path, i + 1, "x"), by = vineTangent(path, i + 1, "y");
    for (let j = count ? 1 : 0; j <= steps; j++) {
      const t = j / steps, t2 = t * t, t3 = t2 * t;
      const h0 = 2 * t3 - 3 * t2 + 1, h1 = t3 - 2 * t2 + t, h2 = -2 * t3 + 3 * t2, h3 = t3 - t2;
      const x = h0 * a.x + h1 * len * ax + h2 * b.x + h3 * len * bx;
      const y = h0 * a.y + h1 * len * ay + h2 * b.y + h3 * len * by;
      let tx = (6 * t2 - 6 * t) * a.x + (3 * t2 - 4 * t + 1) * len * ax + (-6 * t2 + 6 * t) * b.x + (3 * t2 - 2 * t) * len * bx;
      let ty = (6 * t2 - 6 * t) * a.y + (3 * t2 - 4 * t + 1) * len * ay + (-6 * t2 + 6 * t) * b.y + (3 * t2 - 2 * t) * len * by;
      const speed = Math.hypot(tx, ty);
      if (speed > 1e-8) { tx /= speed; ty /= speed; } else { tx = (b.x - a.x) / len; ty = (b.y - a.y) / len; }
      if (count) distance += Math.hypot(x - lastX, y - lastY);
      const p = storage[count] ?? (storage[count] = { x: 0, y: 0, tx: 0, ty: 0, distance: 0 });
      out[count] = p;
      p.x = x; p.y = y; p.tx = tx; p.ty = ty; p.distance = distance;
      p.material = spacing ? (i + t) * spacing : distance;
      // Strain belongs to the physical link, not the spline's decorative
      // derivative (which changes as it rounds a bend).
      p.stretch = spacing ? len / spacing : 1;
      p.twist = 0;
      lastX = x; lastY = y; count++;
    }
  }
  out.length = count;
  return out;
}
