// Bake the tiling surface-foam mask the water renderer samples
// (`public/water/water-foam.webp`). Offline, because quality is the whole
// point: the shader can afford two fetches of a good mask, not the noise
// arithmetic that would generate a bad one per pixel.
//
//   bun run scripts/bake-foam.ts [out.webp]
//
// The mask is a single-channel picture of WHERE foam sits on running water:
// long torn ribbons stretched along the flow (u axis), sparse flecks between
// them, mostly-dark elsewhere. Built from periodic cellular (Worley) ridges -
// foam collects in the convergence lines between eddies, which is what the
// F2-F1 cell boundaries look like - modulated by periodic fBm so the ribbons
// vary along their length and tear rather than run forever. Everything is
// evaluated on a wrapped lattice, so the tile is seamless on both axes by
// construction.
//
// The histogram is shaped here, not in the shader: the soft threshold that
// cuts ribbons with torn edges depends on the mask's value distribution, so
// the bake normalises, gammas and soft-clips until thresholding behaves. See
// "Water" in CLAUDE.md for why this stays out of the release asset store for
// now (public/water/ is local-only).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

const SIZE = 512;
// Cell counts of the Worley lattice: few along the flow, many across, which is
// what stretches every cell - and therefore every ridge between cells - into a
// ribbon running with the current.
const WORLEY_X = 9;
const WORLEY_Y = 14;
// A second, finer cellular layer for flecks and ribbon raggedness.
const WORLEY2_X = 18;
const WORLEY2_Y = 28;
// Periodic value-noise octaves that modulate ribbon strength along the flow.
const FBM_X = 6;
const FBM_Y = 8;

// Deterministic PRNG (mulberry32) so the same script is the same picture.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One feature point per cell of a wrapped lattice.
function featurePoints(nx: number, ny: number, seed: number): Float64Array {
  const rand = rng(seed);
  const pts = new Float64Array(nx * ny * 2);
  for (let i = 0; i < nx * ny; i++) {
    pts[i * 2] = rand();
    pts[i * 2 + 1] = rand();
  }
  return pts;
}

// F2 - F1 cellular distance at (u, v) in tile space, distances measured in
// CELL units so x-stretched cells produce x-stretched ridges.
function worleyRidge(u: number, v: number, nx: number, ny: number, pts: Float64Array): number {
  const cx = Math.floor(u * nx);
  const cy = Math.floor(v * ny);
  let f1 = Infinity;
  let f2 = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = (cx + dx + nx) % nx;
      const gy = (cy + dy + ny) % ny;
      const px = cx + dx + pts[(gy * nx + gx) * 2]!;
      const py = cy + dy + pts[(gy * nx + gx) * 2 + 1]!;
      const ddx = u * nx - px;
      const ddy = v * ny - py;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return f2 - f1;
}

// Periodic value noise, one octave.
function valueNoise(u: number, v: number, nx: number, ny: number, lattice: Float64Array): number {
  const x = u * nx;
  const y = v * ny;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const at = (ix: number, iy: number): number => lattice[((iy % ny) * nx + (ix % nx)) * 2]!;
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const out = process.argv[2] ?? "public/water/water-foam.webp";

const ridge1 = featurePoints(WORLEY_X, WORLEY_Y, 101);
const ridge2 = featurePoints(WORLEY2_X, WORLEY2_Y, 202);
const mod1 = featurePoints(FBM_X, FBM_Y, 303);
const mod2 = featurePoints(FBM_X * 2, FBM_Y * 2, 404);

const field = new Float64Array(SIZE * SIZE);
let lo = Infinity;
let hi = -Infinity;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const u = x / SIZE;
    const v = y / SIZE;
    // The main ribbons: ridges of the stretched lattice, kept WIDE (a gentle
    // falloff, a mild power) so they read as patches of foam rather than a
    // web of cracks.
    const r1 = 1 - Math.min(1, worleyRidge(u, v, WORLEY_X, WORLEY_Y, ridge1) * 0.9);
    // Finer raggedness and isolated flecks.
    const r2 = 1 - Math.min(1, worleyRidge(u, v, WORLEY2_X, WORLEY2_Y, ridge2) * 1.2);
    // Strength varies along the ribbon, and HARD: the modulation is itself
    // thresholded, so most of the web is torn away entirely and what remains
    // is sparse runs - the difference between foam streaks and a caustic net.
    const m1 = valueNoise(u, v, FBM_X, FBM_Y, mod1);
    const m2 = valueNoise(u, v, FBM_X * 2, FBM_Y * 2, mod2);
    const smooth = (a: number, b: number, t: number): number => {
      const s = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return s * s * (3 - 2 * s);
    };
    // Real surface foam is an INTERCONNECTED WEB: bubbles collect in the
    // convergence lines between eddies and stay connected, cells of open
    // water between them. So the web is NEVER torn to nothing - the
    // modulation varies its weight (thick lacing here, a thin thread there)
    // but bottoms out well above zero, which is what keeps it reading as one
    // continuous structure rather than streaks that come and go.
    const weight = 0.35 + 0.65 * smooth(0.25, 0.8, m1 * 0.7 + m2 * 0.3);
    // The main web: a wide soft band along every cell boundary with a
    // brighter core, so the lace has BODY and the cells stay dark.
    const r1w = 1 - Math.min(1, worleyRidge(u, v, WORLEY_X, WORLEY_Y, ridge1) * 0.55);
    const web = (Math.pow(r1w, 1.8) * 0.55 + Math.pow(r1, 1.5) * 0.55) * weight;
    // A finer secondary web laced through the big one.
    const webFine = Math.pow(r2, 2.2) * 0.3 * (0.4 + 0.6 * m2);
    field[y * SIZE + x] = web + webFine;
    lo = Math.min(lo, field[y * SIZE + x]!);
    hi = Math.max(hi, field[y * SIZE + x]!);
  }
}

// Shape the histogram for the shader's soft threshold: normalise, gamma so the
// bulk sits dark, soft-clip the top so ribbon cores saturate white.
const bytes = new Uint8Array(SIZE * SIZE);
for (let i = 0; i < field.length; i++) {
  const n = (field[i]! - lo) / (hi - lo);
  const g = Math.pow(n, 1.7);
  const s = Math.min(1, g * 1.35);
  bytes[i] = Math.round(s * 255);
}

// PGM out, ImageMagick to lossless WebP: the mask is DATA the shader
// thresholds, and lossy ringing around ribbon edges is exactly what the soft
// shoulder would amplify (same argument as optimize-texture's scalar maps).
const tmp = `${out}.pgm`;
fs.writeFileSync(tmp, Buffer.concat([Buffer.from(`P5\n${SIZE} ${SIZE}\n255\n`), Buffer.from(bytes)]));
const magick = spawnSync("magick", [tmp, "-define", "webp:lossless=true", out]);
fs.rmSync(tmp);
if (magick.status !== 0) {
  console.error(magick.stderr?.toString() ?? "magick failed");
  process.exit(1);
}
console.log(`[bake-foam] ${SIZE}x${SIZE} -> ${out}`);
