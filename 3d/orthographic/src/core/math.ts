// Vector and matrix helpers. Matrices are column-major 4x4 arrays (WebGL order).

import type { Vec3 } from "./types";

// Every length is in metres.
export const MIN_SIZE = 0.001;
/** The smallest scene frame: a centimetre on each axis. */
export const MIN_FRAME = 0.01;
export const MAX_VALUE = 1e6;

export const vec = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: Vec3) => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const d = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / d, a[1] / d, a[2] / d];
  },
};

export type Mat4 = number[];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const m = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) m[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return m;
}

export function transform(m: Mat4, v: [number, number, number, number?]): [number, number, number, number] {
  const p = [v[0], v[1], v[2], v[3] ?? 1];
  const out = [0, 0, 0, 0] as [number, number, number, number];
  for (let r = 0; r < 4; r++) out[r] = p[0] * m[r] + p[1] * m[4 + r] + p[2] * m[8 + r] + p[3] * m[12 + r];
  return out;
}

/** A "nice" 1/2/5 x 10^n step at or above n, for grids and scale bars. */
export function niceStep(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  const r = n / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
}

/** Deep copy of plain JSON data (also works on Solid store proxies, unlike structuredClone). */
export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

export const finite = (v: unknown, max = MAX_VALUE): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;

/** Format a number with at most d decimals and no grouping. */
export const fmt = (n: number, d = 3) =>
  Number(n.toFixed(d)).toLocaleString("en-US", { maximumFractionDigits: d, useGrouping: false });

/** A length in metres as a person reads it: in km, m, cm or mm, whichever keeps it short. */
export function lengthText(m: number): string {
  const a = Math.abs(m);
  if (a >= 1000) return `${fmt(m / 1000, 3)} km`;
  if (a >= 1 || a === 0) return `${fmt(m, 3)} m`;
  if (a >= 0.01) return `${fmt(m * 100, 3)} cm`;
  return `${fmt(m * 1000, 3)} mm`;
}
