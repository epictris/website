// Bake the OIL-STROKE steel the ball and chain wear (`TEXTURE_ASSETS["painted
// steel"]`): the raw maps under `assets-src/painted-steel/`, which the
// ordinary texture pipeline then optimises like any photographed set.
//
//   bun run scripts/bake-strokes.ts [assets-src/painted-steel]
//
// The reference (2026-09-17) is an oil painting of a clean, polished steel
// ball on a chain: a mid-grey sphere whose surface is covered in SOFT
// STROKES - broad, low-contrast, a little bluer or warmer than the ground,
// following the form - and whose shine is a painted reflection, the warm
// ground below and the pale sky above smeared into each other with a soft
// horizon. The strokes are paint on the object, so they turn with it; the
// reflection is the scene's own.
// A first version painted the ball as a heavily dabbed dark cannonball; the
// reference is cleaner than that, and the set is tuned to it.
//
// So the maps are strokes, laid down as a painter lays them:
//   albedo     a steel-grey ground, then a few thousand elongated dabs, each
//              a flat tone near the ground's with a faint bristle streak,
//              laid on at part opacity so they read as strokes IN the steel
//              rather than marks on it; a few paler dabs cluster where a slow
//              noise field says the light falls.
//   height     every dab is a thin layer of paint over what was there, so the
//              normal map is soft ridges along the stroke edges - enough for
//              a reflection to smear along the strokes, not enough to read as
//              relief.
//   roughness  varies dab by dab about a polished mean, which is what makes
//              the reflection streaky rather than glassy.
// Everything is placed on a wrapped canvas, so the tile is seamless.
//
// Deterministic (mulberry32), so the same script is the same picture and the
// pipeline's sha256 holds.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SIZE = 1024;
const outDir = process.argv[2] ?? "assets-src/painted-steel";

// The palette: the ground, and the dabs as ranges with a relative weight and
// a roughness. Every tone is within a stroke's width of the ground, which is
// what keeps the steel clean.
const GROUND: [number, number, number] = [0x6c, 0x6f, 0x74];
const GROUND_ROUGH = 0.46;
const PALETTE: Array<{ lo: [number, number, number]; hi: [number, number, number]; w: number; rough: number }> = [
  { lo: [0x5a, 0x5d, 0x63], hi: [0x66, 0x69, 0x6f], w: 34, rough: 0.5 }, // a shade darker
  { lo: [0x72, 0x76, 0x7c], hi: [0x80, 0x84, 0x8a], w: 30, rough: 0.42 }, // a shade lighter
  { lo: [0x5e, 0x64, 0x70], hi: [0x6c, 0x73, 0x80], w: 16, rough: 0.46 }, // cooler, blue
  { lo: [0x74, 0x6e, 0x66], hi: [0x80, 0x78, 0x6e], w: 8, rough: 0.5 }, // warmer, the ground's reflection
  { lo: [0x4a, 0x4c, 0x51], hi: [0x56, 0x58, 0x5d], w: 6, rough: 0.54 }, // dark accent
  { lo: [0x92, 0x95, 0x9a], hi: [0xa6, 0xa9, 0xae], w: 0, rough: 0.38 }, // pale (the light) - weighted by the light field
];
const PALE = PALETTE.length - 1;
const DABS = 3000;
const LENGTH: [number, number] = [30, 80]; // px
const WIDTH: [number, number] = [10, 24]; // px
const OPACITY: [number, number] = [0.35, 0.7]; // a dab's cover over what is under it
const JITTER = 0.4; // radians about the stroke field's direction
const EDGE = 2.0; // px of soft edge on a dab

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
const rand = rng(0x5a17);

// Wrapped value noise on an n x n lattice, 0..1.
function noise(n: number, seed: number): (x: number, y: number) => number {
  const r = rng(seed);
  const lat = new Float32Array(n * n);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / SIZE) * n;
    const fy = (y / SIZE) * n;
    const x0 = Math.floor(fx) % n;
    const y0 = Math.floor(fy) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const tx = smooth(fx - Math.floor(fx));
    const ty = smooth(fy - Math.floor(fy));
    const a = lat[y0 * n + x0]! * (1 - tx) + lat[y0 * n + x1]! * tx;
    const b = lat[y1 * n + x0]! * (1 - tx) + lat[y1 * n + x1]! * tx;
    return a * (1 - ty) + b * ty;
  };
}
// The direction strokes follow, slowly turning across the tile (a painter
// follows the form), and where the light falls (the pale dabs cluster).
const flow = noise(3, 11);
const light = noise(2, 23);

const rgb = new Float32Array(SIZE * SIZE * 3);
const height = new Float32Array(SIZE * SIZE);
const rough = new Float32Array(SIZE * SIZE);
for (let i = 0; i < SIZE * SIZE; i++) {
  rgb[i * 3] = GROUND[0];
  rgb[i * 3 + 1] = GROUND[1];
  rgb[i * 3 + 2] = GROUND[2];
  rough[i] = GROUND_ROUGH;
}

const totalW = PALETTE.reduce((s, p) => s + p.w, 0);
function pick(lightHere: number): number {
  // The pale entry's weight is the light field's say: nothing in the dark,
  // a strong presence in the bright clusters.
  const paleW = Math.max(0, (lightHere - 0.6) / 0.4) * 30;
  let u = rand() * (totalW + paleW);
  for (let i = 0; i < PALE; i++) {
    if (u < PALETTE[i]!.w) return i;
    u -= PALETTE[i]!.w;
  }
  return PALE;
}

for (let d = 0; d < DABS; d++) {
  const cx = rand() * SIZE;
  const cy = rand() * SIZE;
  const len = LENGTH[0] + rand() * (LENGTH[1] - LENGTH[0]);
  const wid = WIDTH[0] + rand() * (WIDTH[1] - WIDTH[0]);
  const ang = flow(cx, cy) * Math.PI + (rand() - 0.5) * 2 * JITTER;
  const p = PALETTE[pick(light(cx, cy))]!;
  const t = rand();
  const col = [0, 1, 2].map((c) => p.lo[c]! + (p.hi[c]! - p.lo[c]!) * t + (rand() - 0.5) * 6);
  const cover = OPACITY[0] + rand() * (OPACITY[1] - OPACITY[0]);
  const thick = 0.55 + rand() * 0.45; // this dab's paint thickness
  const streak = rand() * Math.PI * 2;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const half = Math.hypot(len, wid) / 2 + EDGE;
  for (let py = Math.floor(cy - half); py <= Math.ceil(cy + half); py++) {
    for (let px = Math.floor(cx - half); px <= Math.ceil(cx + half); px++) {
      const dx = px - cx;
      const dy = py - cy;
      const u = dx * ca + dy * sa; // along the stroke
      const v = -dx * sa + dy * ca; // across it
      // A capsule: a soft edge over EDGE px, the ends rounded.
      const along = Math.abs(u) - (len / 2 - wid / 2);
      const dist = along > 0 ? Math.hypot(along, v) : Math.abs(v);
      const a = Math.min(1, Math.max(0, (wid / 2 - dist) / EDGE)) * cover;
      if (a <= 0) continue;
      const i = (((py % SIZE) + SIZE) % SIZE) * SIZE + (((px % SIZE) + SIZE) % SIZE);
      // The bristle streak: a faint lightness ripple across the stroke.
      const bristle = 1 + 0.06 * Math.sin(v * 1.6 + streak);
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgb[i * 3 + c]! * (1 - a) + col[c]! * bristle * a;
      // Paint over: the dab's own thickness where it is opaque, a ramp at
      // its edge, which is the ridge the normal map draws.
      height[i] = height[i]! * (1 - a) + thick * a;
      rough[i] = rough[i]! * (1 - a) + p.rough * a;
    }
  }
}

// The normal map from the height, on the wrapped canvas.
const at = (x: number, y: number) => height[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)]!;
const STRENGTH = 1.2; // soft ridges: a reflection smears along them, they do not read as relief
const base = new Uint8Array(SIZE * SIZE * 3);
const normal = new Uint8Array(SIZE * SIZE * 3);
const roughness = new Uint8Array(SIZE * SIZE);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x;
    for (let c = 0; c < 3; c++) base[i * 3 + c] = Math.round(Math.min(255, Math.max(0, rgb[i * 3 + c]!)));
    const dx = (at(x + 1, y) - at(x - 1, y)) * STRENGTH;
    const dy = (at(x, y + 1) - at(x, y - 1)) * STRENGTH;
    const n = Math.hypot(dx, dy, 1);
    normal[i * 3] = Math.round(((-dx / n) * 0.5 + 0.5) * 255);
    normal[i * 3 + 1] = Math.round(((dy / n) * 0.5 + 0.5) * 255); // +Y up (OpenGL), image y runs down
    normal[i * 3 + 2] = Math.round(((1 / n) * 0.5 + 0.5) * 255);
    roughness[i] = Math.round(rough[i]! * 255);
  }
}

// PPM/PGM out, ImageMagick to lossless PNG: these are the RAW maps the
// pipeline reads, so nothing lossy happens before it decides what is lossy.
fs.mkdirSync(outDir, { recursive: true });
function write(name: string, header: string, bytes: Uint8Array): void {
  const tmp = path.join(outDir, `${name}.tmp.${header.startsWith("P6") ? "ppm" : "pgm"}`);
  const out = path.join(outDir, `${name}.png`);
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from(header), Buffer.from(bytes)]));
  const r = spawnSync("magick", [tmp, out]);
  fs.rmSync(tmp);
  if (r.status !== 0) {
    console.error(r.stderr?.toString() ?? "magick failed");
    process.exit(1);
  }
  console.log(`[bake-strokes] ${SIZE}x${SIZE} -> ${out}`);
}
write("painted-steel-base", `P6\n${SIZE} ${SIZE}\n255\n`, base);
write("painted-steel-normal", `P6\n${SIZE} ${SIZE}\n255\n`, normal);
write("painted-steel-roughness", `P5\n${SIZE} ${SIZE}\n255\n`, roughness);
