// How far the platform's own `Math` is from the sim's deterministic libm.
//
//   bun run scripts/dmath-crosscheck.ts [samples]      # JavaScriptCore + its libm
//   node scripts/dmath-crosscheck.ts [samples]         # V8
//
// Prints, per function, how many of N random inputs the engine's `Math` answers
// differently from `engine/dmath.ts`, with a few examples. It is an instrument,
// not a test: the sim never calls `Math` for any of these, and the point of the
// table is to see how often it would have disagreed if it did. Measured on
// 2026-09-07: node 24 (V8 13.6, fdlibm) agrees to the bit on every function but
// `pow` (glibc's, correctly rounded; 6% of inputs differ by an ulp); bun 1.3
// (JavaScriptCore, the system libm) differs on 2-27% of inputs per function.

import { dmath, type DmathName } from "../src/engine/dmath";

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const bits = (x: number) => {
  f64[0] = x;
  return u32[1]!.toString(16).padStart(8, "0") + u32[0]!.toString(16).padStart(8, "0");
};

let seed = 12345;
const rnd = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const PI = 3.141592653589793;
function sample(): number {
  const r = rnd();
  const sign = rnd() < 0.5 ? -1 : 1;
  if (r < 0.3) return sign * rnd() * 10;
  if (r < 0.5) return sign * rnd() * 2 * PI;
  if (r < 0.6) return sign * (PI / 2) * Math.round(rnd() * 64) + (rnd() - 0.5) * 1e-6;
  if (r < 0.75) {
    u32[1] = (rnd() * 0x7ff00000) >>> 0;
    u32[0] = (rnd() * 4294967296) >>> 0;
    return sign * f64[0]!;
  }
  if (r < 0.9) return sign * rnd();
  if (r < 0.95) return sign * Math.round(rnd() * 1000);
  return sign * rnd() * 1e6;
}

const N = Number(process.argv[2] ?? 100000);
const names = Object.keys(dmath).filter((n) => n !== "scalbn") as DmathName[];
for (const name of names) {
  const two = name === "atan2" || name === "pow" || name === "hypot";
  let mism = 0;
  const ex: string[] = [];
  for (let i = 0; i < N; i++) {
    let x = sample();
    let y = sample();
    if (name === "asin" || name === "acos" || name === "atanh") x = x % 1;
    if (name === "log" || name === "log1p") x = Math.abs(x);
    if (name === "pow") {
      x = Math.abs(x);
      if (i % 3 === 0) y = Math.trunc(y) % 64;
      else if (i % 2) y = y / 50;
    }
    const d = two ? (dmath[name] as (a: number, b: number) => number)(x, y) : (dmath[name] as (a: number) => number)(x);
    const m = two ? (Math[name] as (a: number, b: number) => number)(x, y) : (Math[name] as (a: number) => number)(x);
    if (bits(d) !== bits(m) && !(Number.isNaN(d) && Number.isNaN(m))) {
      mism++;
      if (ex.length < 2) ex.push(`${name}(${x}${two ? `, ${y}` : ""}) dmath=${d} Math=${m}`);
    }
  }
  const pct = ((100 * mism) / N).toFixed(2).padStart(6);
  console.log(`${name.padEnd(6)} ${String(mism).padStart(7)}/${N} (${pct}%)${ex.length ? "  e.g. " + ex.join(" | ") : ""}`);
}
