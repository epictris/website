// Bake the WOODY bark the roots wear (`TEXTURE_ASSETS["painted root woody"]`):
// the raw maps under `assets-src/painted-root/`, which the ordinary texture
// pipeline then optimises like any painted set.
//
//   bun run scripts/bake-root-bark.ts [assets-src/painted-root]
//
// The reference (2026-10-18) is the painted cave backdrop's own roots. What
// reads as blocks of colour there is RELIEF under light: veins standing
// proud of the wood and running down it, each lit along its crest and
// shaded down one flank, the valleys between them in their own shadow. The
// wood itself is one colour. So the maps here are the relief's, from the one
// field the root mesh displaces its rings by (`render3d/rootBarkField.ts`):
//
//   base    one bark colour, drifting a few percent lighter or darker and
//           warmer or cooler in patches of twenty to thirty centimetres (as
//           bark's colour does, well under anything that reads as shading),
//           laid in broad strokes along the root that stay on one vein (so
//           it is paint, not a gradient); the valleys are the same colour
//           as the veins.
//   normal  the field's slope, at the physical aspect of the tile on a root
//           (a texel is longer along the root than around it).
//   ao      horizon occlusion of the same height field: the valleys in
//           shadow, the crests open to the sky.
//
// A roughness map (crests smoother than valleys) was baked and dropped on
// 2026-10-18: it changed a tenth of a percent of the frame, and the sheen
// that would show it made the veins glossy.
//
// Deterministic (the field's own stream and this script's), so the same
// script is the same picture and the pipeline's sha256 holds.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { barkAt } from "../src/render3d/rootBarkField";

const SIZE = 1024;
const outDir = process.argv[2] ?? "assets-src/painted-root";

type Rgb = [number, number, number];
// The bark, sRGB: the reference's warm brown between its lit and shaded
// plates, since the light will take it either way.
const BARK: Rgb = [0x77, 0x50, 0x2a];
// Pigment left in a valley: all of it. The veins are the wood's own colour,
// and only the light tells them apart (Tris, 2026-10-18).
const GAP_SHADE = 1;

// Physical shape of the tile on a typical 8 cm root: a texel is this many
// times longer along the root (0.65 m per tile) than around it (one
// circumference per tile), and the relief's full height is this many
// across-texels (about 4 mm, a tenth of the radius: rootMesh.ts RELIEF).
const ALONG = 2.6;
const AMP = 16;

const DABS = 2600;
const LENGTH: [number, number] = [50, 140]; // px
const WIDTH: [number, number] = [16, 40]; // px
const OPACITY: [number, number] = [0.3, 0.5];
const JITTER = 0.25; // radians about the root's direction
const EDGE = 3; // px of soft edge on a dab

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
const rand = rng(0x2008);
const span = (r: [number, number]): number => r[0] + rand() * (r[1] - r[0]);
const at = (x: number, y: number): number => (((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE);

// Wrapped value noise on an nx by ny lattice over the tile, 0..1.
function noise(nx: number, ny: number, seed: number): (u: number, v: number) => number {
  const r = rng(seed);
  const lat = new Float32Array(nx * ny);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u, v) => {
    const fx = (((u % 1) + 1) % 1) * nx;
    const fy = (((v % 1) + 1) % 1) * ny;
    const x0 = Math.floor(fx) % nx;
    const y0 = Math.floor(fy) % ny;
    const x1 = (x0 + 1) % nx;
    const y1 = (y0 + 1) % ny;
    const tx = smooth(fx - Math.floor(fx));
    const ty = smooth(fy - Math.floor(fy));
    const a = lat[y0 * nx + x0]! * (1 - tx) + lat[y0 * nx + x1]! * tx;
    const b = lat[y1 * nx + x0]! * (1 - tx) + lat[y1 * nx + x1]! * tx;
    return a * (1 - ty) + b * ty;
  };
}
// The pigment's slow drift: patches of a fifth to a third of the tile along
// the root (13-22 cm) and a few around it, the value this far either way and
// the warmth (red up, blue down, in sRGB units) this far.
const DRIFT_VALUE = 0.06;
const DRIFT_WARMTH = 5;
const driftValue = noise(4, 3, 3001);
const driftWarmth = noise(3, 4, 3002);

// The field, sampled once per texel.
const height = new Float32Array(SIZE * SIZE);
const patch = new Int32Array(SIZE * SIZE);
const rgb = new Float32Array(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  const u = (x + 0.5) / SIZE, v = (y + 0.5) / SIZE;
  const s = barkAt(u, v);
  const i = y * SIZE + x;
  height[i] = s.height;
  patch[i] = s.patch;
  const shade = (0.9 + 0.2 * s.tone) * (1 - (1 - GAP_SHADE) * s.gap) * (1 + (driftValue(u, v) - 0.5) * 2 * DRIFT_VALUE);
  const warm = (driftWarmth(u, v) - 0.5) * 2 * DRIFT_WARMTH;
  rgb[i * 3] = BARK[0] * shade + warm;
  rgb[i * 3 + 1] = BARK[1] * shade;
  rgb[i * 3 + 2] = BARK[2] * shade - warm;
}

// The strokes: the plate's tone under the centre, nudged a little lighter or
// darker, a touch warmer or cooler, clipped at the plate's border.
for (let d = 0; d < DABS; d++) {
  const cx = rand() * SIZE, cy = rand() * SIZE;
  const centre = at(Math.round(cx), Math.round(cy));
  const own = patch[centre]!;
  const col: Rgb = [rgb[centre * 3]!, rgb[centre * 3 + 1]!, rgb[centre * 3 + 2]!];
  const shade = 1 + (rand() - 0.5) * 0.06;
  const warm = (rand() - 0.5) * 3;
  col[0] = col[0] * shade + warm; col[1] *= shade; col[2] = col[2] * shade - warm;
  const len = span(LENGTH), wid = span(WIDTH), cover = span(OPACITY);
  const ang = Math.PI / 2 + (rand() - 0.5) * 2 * JITTER;
  const streak = rand() * Math.PI * 2;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const half = Math.hypot(len, wid) / 2 + EDGE;
  for (let py = Math.floor(cy - half); py <= Math.ceil(cy + half); py++) {
    for (let px = Math.floor(cx - half); px <= Math.ceil(cx + half); px++) {
      const i = at(px, py);
      if (patch[i] !== own) continue;
      const dx = px - cx, dy = py - cy;
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      const along = Math.abs(u) - (len / 2 - wid / 2);
      const dist = along > 0 ? Math.hypot(along, v) : Math.abs(v);
      const a = Math.min(1, Math.max(0, (wid / 2 - dist) / EDGE)) * cover;
      if (a <= 0) continue;
      const bristle = 1 + 0.04 * Math.sin(v * 1.7 + streak);
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgb[i * 3 + c]! * (1 - a) + col[c]! * bristle * a;
    }
  }
}

// The normal map from the height, on the wrapped tile, at the tile's physical
// aspect: a slope along the root is gentler per texel than one around it.
const h = (x: number, y: number): number => height[at(x, y)]!;
const base = new Uint8Array(SIZE * SIZE * 3);
const normal = new Uint8Array(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  const i = y * SIZE + x;
  for (let c = 0; c < 3; c++) base[i * 3 + c] = Math.round(Math.min(255, Math.max(0, rgb[i * 3 + c]!)));
  const dx = (h(x + 1, y) - h(x - 1, y)) * 0.5 * AMP;
  const dy = (h(x, y + 1) - h(x, y - 1)) * 0.5 * AMP / ALONG;
  const n = Math.hypot(dx, dy, 1);
  normal[i * 3] = Math.round(((-dx / n) * 0.5 + 0.5) * 255);
  normal[i * 3 + 1] = Math.round(((dy / n) * 0.5 + 0.5) * 255); // +Y up (OpenGL), image y runs down
  normal[i * 3 + 2] = Math.round(((1 / n) * 0.5 + 0.5) * 255);
}

// Occlusion: in each of eight directions, the highest the relief rises
// above this texel within reach, as the sine of that horizon; open sky is 1.
const REACH = 28; // across-texels
const DIRECTIONS = 8;
const ao = new Uint8Array(SIZE * SIZE);
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  const h0 = h(x, y) * AMP;
  let shut = 0;
  for (let k = 0; k < DIRECTIONS; k++) {
    const ang = (k / DIRECTIONS) * Math.PI * 2;
    const cx = Math.cos(ang), cy = Math.sin(ang) / ALONG;
    let horizon = 0;
    for (let t = 2; t <= REACH; t += 2) {
      const rise = h(Math.round(x + cx * t), Math.round(y + cy * t)) * AMP - h0;
      if (rise > 0) horizon = Math.max(horizon, rise / Math.hypot(rise, t));
    }
    shut += horizon;
  }
  ao[y * SIZE + x] = Math.round(255 * (1 - shut / DIRECTIONS));
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
  console.log(`[bake-root-bark] ${SIZE}x${SIZE} -> ${out}`);
}
write("painted-root-woody-base", `P6\n${SIZE} ${SIZE}\n255\n`, base);
write("painted-root-woody-normal", `P6\n${SIZE} ${SIZE}\n255\n`, normal);
write("painted-root-woody-ao", `P5\n${SIZE} ${SIZE}\n255\n`, ao);
