// BRUSH STROKES over a texture set: the painterly pass that follows the
// flattening (see optimize-texture's `--paint`), run once per SET by
// `assets:paint` for every set whose manifest entry records `strokes`.
//
// The flattening gives a set flat planes with crisp breaks; this lays the
// planes down as a painter would, in strokes. It is stroke-based rendering of
// the ordinary kind (Litwinowicz / Hertzmann): a few thousand elongated dabs,
// each one flat colour taken from the picture under its centre, laid along
// the picture's own edges, and CLIPPED where the colour under the stroke
// changes - so a stroke runs along a crack and never across it, and a moss
// blob keeps its edge. The result is the same picture, painted.
//
// One dab layout for the whole set, which is the reason this is a set pass
// rather than a per-map flag: the albedo, the normal map and the roughness
// map wear the same strokes, each sampling its OWN value under the dab, so a
// stroke is one plane of colour, one facet and one sheen at once - what a
// stroke of paint is. Sampled from the flattened maps, so a normal under a
// dab is one normal and the stroke is a facet; the strokes are laid on at
// part opacity, so they read as strokes in the surface rather than marks on
// it, and carry a faint bristle streak on the albedo only.
//
// The avatar's `painted steel` is not made this way: its strokes are baked
// from nothing by `scripts/bake-strokes.ts`, since there was no photograph
// worth keeping under them. This pass is for a set where there is.
//
// Deterministic (a fixed seed), so the same maps stroked twice are the same
// bytes and the pipeline's sha256 holds.

import { spawnSync } from "node:child_process";
import { basename, extname } from "node:path";

export interface StrokeOptions {
  // Stroke width in output pixels; the length is a few times this.
  width: number;
}

type Slot = "base" | "normal" | "roughness" | "metallic" | "ao" | "emissive";

interface Raster {
  w: number;
  h: number;
  data: Float32Array; // RGB, 0..255
}

// The dabs are the avatar's (see bake-strokes.ts): short and irregular. Widths
// vary independently over a wide range, lengths are one to four widths and
// biased toward the short end, so most strokes are dabs and a few are
// streaks. Uniform 2-6x lengths read as combed fur on the rock.
const LENGTH_RATIO: [number, number] = [1.2, 4]; // length : width, each dab its own
const LENGTH_BIAS = 1.6; // >1 favours short dabs
const WIDTH_RANGE: [number, number] = [0.6, 1.6]; // of the set's width
const OPACITY: [number, number] = [0.3, 0.8];
const EDGE = 2; // px of soft edge
const COVER = 3; // how many times over the canvas the dabs' area sums to
const CLIP_DISTANCE = 26; // RGB distance (0..255) at which a stroke stops
const ORIENT_BLEND = 60; // gradient magnitude at which the edge steers a stroke as far as it can
const ORIENT_MAX = 0.6; // how far an edge may steer: never all the way, or strokes comb along it
// How far a stroke turns from the direction it was given, either way. Wide:
// neighbouring strokes cross and overlap as dabs do, rather than lying
// combed in one direction, which a small wobble left them.
const TURN = 1.05; // radians
const BRISTLE = 0.05; // lightness ripple across an albedo stroke
// A painter never mixes the same tone twice. Without this a dab whose colour
// is the mean of a flat plateau, painted back onto that plateau, is invisible
// - the first run of this pass returned the albedo byte for byte. So every
// dab is a little lighter or darker than what it covers, drifts a little
// warm or cool, tilts its facet a little, and is a little more or less matte.
// Enough that a stroke on the reference cave reads as a stroke, not so much
// that the strokes are the picture: the facets and the cracks under them are,
// and the strokes are the handwriting. (A first try at 0.25 and 0.12 buried
// the cracks and turned the normal map into scales.)
const VALUE_JITTER = 0.14; // fraction of lightness
const WARMTH_JITTER = 6; // 0..255, added to red and taken from blue (or the reverse)
const TILT_JITTER = 0.05; // of a normal's unit range
const ROUGH_JITTER = 0.05; // 0..1

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

function readPpm(file: string): Raster {
  const r = spawnSync("magick", [file, "-depth", "8", "ppm:-"], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`magick read failed: ${file}\n${r.stderr}`);
  const buf: Buffer = r.stdout;
  // P6\n<w> <h>\n255\n<bytes>
  const header = buf.subarray(0, 40).toString("latin1");
  const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(header);
  if (!m) throw new Error(`unexpected PPM header from ${file}`);
  const w = Number(m[1]);
  const h = Number(m[2]);
  const start = m[0].length;
  const data = new Float32Array(w * h * 3);
  for (let i = 0; i < data.length; i++) data[i] = buf[start + i]!;
  return { w, h, data };
}

function writeWebp(raster: Raster, file: string, colour: boolean): void {
  const bytes = Buffer.alloc(raster.w * raster.h * 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.min(255, Math.max(0, raster.data[i]!)));
  const ppm = Buffer.concat([Buffer.from(`P6\n${raster.w} ${raster.h}\n255\n`), bytes]);
  // The same encoding rule as optimize-texture: a picture lossy at q90, data
  // lossless, and data reinterpreted rather than converted.
  const args = colour
    ? ["ppm:-", "-quality", "90", "-strip", file]
    : ["ppm:-", "-set", "colorspace", "sRGB", "-define", "webp:lossless=true", "-strip", file];
  const r = spawnSync("magick", args, { input: ppm, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`magick write failed: ${file}\n${r.stderr}`);
}

// Wrapped value noise on an n x n lattice, 0..1 - the direction strokes take
// where the picture has no edge to follow.
function noise(n: number, seed: number, w: number, h: number): (x: number, y: number) => number {
  const r = rng(seed);
  const lat = new Float32Array(n * n);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / w) * n;
    const fy = (y / h) * n;
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

// Stroke every map of a set: read each slot's flattened map from `inputs`
// (lossless intermediates, so the albedo is encoded lossy once, here), write
// the stroked map to `outputs`. The base is required, since it steers and
// clips the strokes.
export function strokeSet(
  inputs: Partial<Record<Slot, string>>,
  outputs: Partial<Record<Slot, string>>,
  opts: StrokeOptions,
  seed = 0x57a0,
): void {
  if (!inputs.base) throw new Error("strokes need the set's base map");
  const slots = (Object.keys(inputs) as Slot[]).filter((s) => inputs[s] && outputs[s]);
  const maps = new Map<Slot, Raster>();
  for (const s of slots) maps.set(s, readPpm(inputs[s]!));
  const base = maps.get("base")!;
  const { w, h } = base;
  for (const [s, r] of maps) {
    if (r.w !== w || r.h !== h) throw new Error(`${s} is ${r.w}x${r.h}, base is ${w}x${h}`);
  }
  // Every map is sampled from its ORIGINAL - the strokes never sample each
  // other - so keep a copy of each to read from while writing the other.
  const source = new Map<Slot, Float32Array>();
  for (const [s, r] of maps) source.set(s, Float32Array.from(r.data));

  const idx = (x: number, y: number) => ((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 3;
  const lum = (d: Float32Array, x: number, y: number) => {
    const i = idx(x, y);
    return 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  };
  const baseSrc = source.get("base")!;

  // The edge field: the gradient of the albedo's luminance, blurred to about
  // the stroke's width so a stroke follows the shape of a break rather than
  // its pixels. Box-blurred twice for a cheap Gaussian.
  const blurred = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) blurred[y * w + x] = lum(baseSrc, x, y);
  const radius = Math.max(1, Math.round(opts.width / 3));
  const boxBlur = (src: Float32Array): Float32Array => {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const span = 2 * radius + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += src[y * w + (((k % w) + w) % w)]!;
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / span;
        acc += src[y * w + (((x + radius + 1) % w) + w) % w]! - src[y * w + (((x - radius) % w) + w) % w]!;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) acc += tmp[(((k % h) + h) % h) * w + x]!;
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / span;
        acc += tmp[((((y + radius + 1) % h) + h) % h) * w + x]! - tmp[((((y - radius) % h) + h) % h) * w + x]!;
      }
    }
    return out;
  };
  const smooth = boxBlur(boxBlur(blurred));
  // Sampled at a dab's centre, which is fractional: rounded, or the index is
  // fractional too, the read is undefined, the angle is NaN and every dab's
  // raster loop runs over an empty range - the first run of this pass
  // painted nothing and said so with an "albedo moved 0.00".
  const at = (x: number, y: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return smooth[(((yi % h) + h) % h) * w + (((xi % w) + w) % w)]!;
  };
  const flow = noise(3, seed ^ 0x1234, w, h);

  const rand = rng(seed);
  const meanLen = opts.width * (LENGTH_RATIO[0] + (LENGTH_RATIO[1] - LENGTH_RATIO[0]) / (LENGTH_BIAS + 1));
  const count = Math.round((COVER * w * h) / (meanLen * opts.width));
  const dist = (a: Float32Array, i: number, r: number, g: number, b: number) =>
    Math.hypot(a[i]! - r, a[i + 1]! - g, a[i + 2]! - b);

  let painted = 0;
  let clipped = 0;
  for (let d = 0; d < count; d++) {
    const cx = rand() * w;
    const cy = rand() * h;
    const wid = opts.width * (WIDTH_RANGE[0] + rand() * (WIDTH_RANGE[1] - WIDTH_RANGE[0]));
    const full = wid * (LENGTH_RATIO[0] + Math.pow(rand(), LENGTH_BIAS) * (LENGTH_RATIO[1] - LENGTH_RATIO[0]));
    const cover = OPACITY[0] + rand() * (OPACITY[1] - OPACITY[0]);
    const streak = rand() * Math.PI * 2;
    const value = 1 + (rand() - 0.5) * 2 * VALUE_JITTER;
    const warmth = (rand() - 0.5) * 2 * WARMTH_JITTER;
    const tiltX = (rand() - 0.5) * 2 * TILT_JITTER * 127.5;
    const tiltY = (rand() - 0.5) * 2 * TILT_JITTER * 127.5;
    const roughShift = (rand() - 0.5) * 2 * ROUGH_JITTER * 255;

    // Direction: along the edge where there is one, the flow where there is
    // not, blended by how strong the edge is.
    const gx = at(cx + 1, cy) - at(cx - 1, cy);
    const gy = at(cx, cy + 1) - at(cx, cy - 1);
    const mag = Math.hypot(gx, gy);
    const edgeAng = Math.atan2(gy, gx) + Math.PI / 2;
    const flowAng = flow(cx, cy) * Math.PI;
    const t = Math.min(ORIENT_MAX, mag / ORIENT_BLEND);
    // Blend two angles on the circle (they are directions, so mod pi), then
    // turn the stroke its own way.
    const ang =
      Math.atan2(
        Math.sin(2 * edgeAng) * t + Math.sin(2 * flowAng) * (1 - t),
        Math.cos(2 * edgeAng) * t + Math.cos(2 * flowAng) * (1 - t),
      ) /
        2 +
      (rand() - 0.5) * 2 * TURN;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);

    // The dab's colour on every map: the mean of that map under a small disc
    // at the centre.
    const sampleR = Math.max(1, wid / 3);
    const sampled = new Map<Slot, [number, number, number]>();
    for (const [s, src] of source) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let oy = -sampleR; oy <= sampleR; oy++) {
        for (let ox = -sampleR; ox <= sampleR; ox++) {
          if (ox * ox + oy * oy > sampleR * sampleR) continue;
          const i = idx(Math.round(cx + ox), Math.round(cy + oy));
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          n++;
        }
      }
      sampled.set(s, [r / n, g / n, b / n]);
    }
    const [br, bg, bb] = sampled.get("base")!;
    // This dab's own mix of each map's value.
    const mixed = new Map<Slot, [number, number, number]>();
    for (const [s, [r, g, b]] of sampled) {
      if (s === "base" || s === "emissive") mixed.set(s, [r * value + warmth, g * value, b * value - warmth]);
      else if (s === "normal") mixed.set(s, [r + tiltX, g + tiltY, b]);
      else mixed.set(s, [r + roughShift, g + roughShift, b + roughShift]);
    }

    // Clip: walk out from the centre along the stroke until the albedo under
    // it is no longer this dab's colour. That is the crack, or the edge of the
    // moss, and the stroke stops there.
    let uMin = -full / 2;
    let uMax = full / 2;
    for (let u = 0; u <= full / 2; u += 2) {
      if (dist(baseSrc, idx(Math.round(cx + ca * u), Math.round(cy + sa * u)), br, bg, bb) > CLIP_DISTANCE) {
        uMax = u;
        break;
      }
    }
    for (let u = 0; u >= -full / 2; u -= 2) {
      if (dist(baseSrc, idx(Math.round(cx + ca * u), Math.round(cy + sa * u)), br, bg, bb) > CLIP_DISTANCE) {
        uMin = u;
        break;
      }
    }
    if (uMax - uMin < wid) {
      clipped++;
      continue; // nothing left to paint
    }
    painted++;
    const mid = (uMin + uMax) / 2;
    const half = (uMax - uMin) / 2;
    const mx = cx + ca * mid;
    const my = cy + sa * mid;
    const reach = Math.hypot(half, wid / 2) + EDGE;

    for (let py = Math.floor(my - reach); py <= Math.ceil(my + reach); py++) {
      for (let px = Math.floor(mx - reach); px <= Math.ceil(mx + reach); px++) {
        const dx = px - mx;
        const dy = py - my;
        const u = dx * ca + dy * sa;
        const v = -dx * sa + dy * ca;
        const along = Math.abs(u) - (half - wid / 2);
        const dd = along > 0 ? Math.hypot(along, v) : Math.abs(v);
        const a = Math.min(1, Math.max(0, (wid / 2 - dd) / EDGE)) * cover;
        if (a <= 0) continue;
        const i = idx(px, py);
        for (const [s, r] of maps) {
          const [vr, vg, vb] = mixed.get(s)!;
          const k = s === "base" ? 1 + BRISTLE * Math.sin(v * 1.4 + streak) : 1;
          r.data[i] = r.data[i]! * (1 - a) + vr * k * a;
          r.data[i + 1] = r.data[i + 1]! * (1 - a) + vg * k * a;
          r.data[i + 2] = r.data[i + 2]! * (1 - a) + vb * k * a;
        }
      }
    }
  }

  // A normal map's strokes are mixes of unit vectors: put them back on the
  // sphere, or a blend of two tilted normals reads as a flatter one.
  const normal = maps.get("normal");
  if (normal) {
    const d = normal.data;
    for (let i = 0; i < d.length; i += 3) {
      const x = d[i]! / 127.5 - 1;
      const y = d[i + 1]! / 127.5 - 1;
      const z = d[i + 2]! / 127.5 - 1;
      const n = Math.hypot(x, y, z) || 1;
      d[i] = (x / n + 1) * 127.5;
      d[i + 1] = (y / n + 1) * 127.5;
      d[i + 2] = (z / n + 1) * 127.5;
    }
  }

  // How much the albedo moved, as a mean absolute change in levels: the
  // number that says the strokes are visible, or that they are not.
  let moved = 0;
  for (let i = 0; i < base.data.length; i++) moved += Math.abs(base.data[i]! - baseSrc[i]!);
  moved /= base.data.length;
  for (const [s, r] of maps) writeWebp(r, outputs[s]!, s === "base" || s === "emissive");
  console.log(
    `[strokes] ${basename(outputs.base!, extname(outputs.base!)).replace(/-base$/, "")}: ${painted} of ${count} dabs of ${opts.width}px painted (${clipped} clipped away) over ${slots.join(", ")}; albedo moved ${moved.toFixed(2)} levels`,
  );
}
