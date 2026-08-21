// One downloaded sky in, one shippable equirectangular HDR out.
//
//   bun run assets:optimize-hdri assets-src/golden_gate_hills_2k.exr \
//     public/hdri/golden-gate-hills.hdr
//
// The prop and texture pipelines' argument, one asset type over (see
// optimize-asset.ts): the settings ARE the decision, and a sky that arrives as a
// 24 MB 2k EXR because it was converted on a different day is a cost nothing
// downstream reports.
//
// Two settings carry the whole file.
//
//   --size 1024 (default)   the equirect's WIDTH; the height is half of it,
//                           because that is what equirectangular means. 1k is
//                           generous for what this is FOR: `PMREMGenerator`
//                           convolves the map into a roughness mip chain whose
//                           top level is 256 across, so every pixel past that is
//                           thrown away before a surface ever reflects it. It is
//                           the wrong size only if the sky is also the visible
//                           BACKGROUND - see `hdriBackground` in EnvironmentData,
//                           and expect to want 2k or 4k there.
//   --exposure 1 (default)  a plain multiply on the linear values, for a capture
//                           that is brighter or darker than the level wants.
//                           Applied HERE rather than at load because it is a
//                           property of these bytes; `envIntensity` is the
//                           per-level knob and stays free for the level to use.
//
// RADIANCE RGBE (.hdr) RATHER THAN EXR, and it is the format choice the whole
// script exists for. Poly Haven ships half-float EXR, which for this 2k sky is
// 24 MB - a quarter of the entire asset budget for one image nobody looks at
// directly. RGBE is one shared exponent per pixel rather than three, so the same
// sky at 1k is ~1.6 MB, and what it gives up (a mantissa of 8 bits per channel
// instead of 10) is invisible under a convolution that averages thousands of
// texels into every sample. It also needs no loader beyond the one three ships.
//
// NOT IMAGEMAGICK, which is what every other asset here goes through. It reads
// the EXR correctly and its Radiance WRITER does not round-trip: the mean linear
// luminance of this sky comes back 2.9 million times what went in, and the
// per-pixel ratios are not even consistent with each other, so it is not a scale
// factor that could be divided out. A sky that is wrong by a constant is a level
// lit wrongly and a sky that is wrong per pixel is a level lit by noise, and
// neither announces itself as anything but "the lighting looks off". Decoding
// and encoding here costs ~150 lines, has no magic constant in it, and is
// checked by the round trip this script prints.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { FloatType } from "three";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";

interface Decoded {
  width: number;
  height: number;
  // RGBA, linear, row 0 at the TOP of the image (see `decode`).
  data: Float32Array;
}

// Both of three's loaders hand back RGBA floats and disagree about which end of
// the array the top of the image is: `EXRLoader` reports `flipY: false` and
// `HDRLoader` reports `flipY: true`, which is the same picture stored in
// opposite row orders. Everything here works top-down, so an EXR is reversed on
// the way in and the encoder writes top-down, which is what Radiance's `-Y`
// scanline order means. Getting this wrong is a level lit by its own ground.
function decode(file: string): Decoded {
  const bytes = readFileSync(file);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const ext = extname(file).toLowerCase();
  if (ext === ".exr") {
    const tex = new EXRLoader().setDataType(FloatType).parse(buffer) as unknown as Decoded;
    return { width: tex.width, height: tex.height, data: flipRows(tex) };
  }
  if (ext === ".hdr" || ext === ".pic") {
    const tex = new HDRLoader().setDataType(FloatType).parse(buffer) as unknown as Decoded;
    return { width: tex.width, height: tex.height, data: new Float32Array(tex.data) };
  }
  throw new Error(`unsupported input ${ext} - this reads .exr and .hdr`);
}

function flipRows({ width, height, data }: Decoded): Float32Array {
  const out = new Float32Array(data.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    out.set(data.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  }
  return out;
}

// Area averaging, in LINEAR light, which is what the values already are - there
// is no gamma to undo here and undoing one would be the mistake. A box average
// is also the only filter that is safe on this data: a Lanczos or Mitchell
// kernel rings around a discontinuity, and the sun in this sky is 130,000x the
// mean, so the ring around it is a halo of NEGATIVE radiance several times
// brighter than anything else in the picture.
//
// Every destination pixel takes the mean of the source rectangle it covers,
// weighted by how much of each edge pixel falls inside it, so a non-integer
// ratio is neither refused nor quietly point-sampled.
function resample(src: Decoded, width: number, height: number): Decoded {
  if (src.width === width && src.height === height) return src;
  const out = new Float32Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let w = 0;
      for (let iy = Math.floor(y0); iy < Math.min(src.height, Math.ceil(y1)); iy++) {
        const wy = Math.min(iy + 1, y1) - Math.max(iy, y0);
        for (let ix = Math.floor(x0); ix < Math.min(src.width, Math.ceil(x1)); ix++) {
          const weight = wy * (Math.min(ix + 1, x1) - Math.max(ix, x0));
          const i = (iy * src.width + ix) * 4;
          r += src.data[i]! * weight;
          g += src.data[i + 1]! * weight;
          b += src.data[i + 2]! * weight;
          w += weight;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / w;
      out[o + 1] = g / w;
      out[o + 2] = b / w;
      out[o + 3] = 1;
    }
  }
  return { width, height, data: out };
}

// --- Radiance RGBE -------------------------------------------------------
//
// One byte per channel plus a shared exponent: `value = mantissa * 2^(e - 128)`,
// so the format's range is astronomical and its precision is 8 bits of mantissa,
// which is the trade that makes it a tenth the size of half-float RGB.

function encodePixel(r: number, g: number, b: number, out: Uint8Array, at: number): void {
  const v = Math.max(r, g, b);
  if (!(v > 1e-32)) {
    out[at] = 0;
    out[at + 1] = 0;
    out[at + 2] = 0;
    out[at + 3] = 0;
    return;
  }
  // frexp: the exponent such that the mantissa lands in [0.5, 1). Derived from
  // log2 and then corrected, because a value that is exactly a power of two
  // lands on the boundary and floating point puts it on either side of it.
  let e = Math.floor(Math.log2(v)) + 1;
  let m = v / 2 ** e;
  if (m >= 1) {
    m /= 2;
    e += 1;
  } else if (m < 0.5) {
    m *= 2;
    e -= 1;
  }
  // A value outside the format's exponent range is clamped rather than wrapped:
  // an exponent byte that overflows encodes a completely different brightness,
  // which in a sky means one pixel of the sun rendered as darkness.
  const clamped = Math.max(-127, Math.min(127, e));
  const scale = (m * 256) / v * 2 ** (e - clamped);
  out[at] = Math.max(0, Math.min(255, Math.floor(r * scale)));
  out[at + 1] = Math.max(0, Math.min(255, Math.floor(g * scale)));
  out[at + 2] = Math.max(0, Math.min(255, Math.floor(b * scale)));
  out[at + 3] = clamped + 128;
}

// New-style run-length encoding: a scanline is the four components' bytes stored
// SEPARATELY, each as a stream of runs (a count with the high bit set, then the
// repeated byte) and literals (a count, then that many bytes). Separating the
// components is where the compression comes from - a gradient's exponent byte is
// the same for hundreds of pixels in a row even where its mantissas all differ.
function encodeScanline(row: Uint8Array, width: number, out: number[]): void {
  for (let c = 0; c < 4; c++) {
    let i = 0;
    while (i < width) {
      let run = 1;
      while (
        run < 127 &&
        i + run < width &&
        row[(i + run) * 4 + c] === row[i * 4 + c]
      ) {
        run++;
      }
      if (run >= 4) {
        out.push(128 + run, row[i * 4 + c]!);
        i += run;
        continue;
      }
      // A literal run, ending where a run of four begins - four being where the
      // two-byte run encoding starts paying for itself.
      let lit = 0;
      while (i + lit < width && lit < 128) {
        const at = (i + lit) * 4 + c;
        if (
          i + lit + 3 < width &&
          row[at] === row[at + 4] &&
          row[at] === row[at + 8] &&
          row[at] === row[at + 12]
        ) {
          break;
        }
        lit++;
      }
      if (lit === 0) lit = 1;
      out.push(lit);
      for (let k = 0; k < lit; k++) out.push(row[(i + k) * 4 + c]!);
      i += lit;
    }
  }
}

function encodeHdr({ width, height, data }: Decoded): Uint8Array {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nSOFTWARE=rope assets:optimize-hdri\n\n-Y ${height} +X ${width}\n`;
  const bytes: number[] = [...new TextEncoder().encode(header)];
  const row = new Uint8Array(width * 4);
  // The RLE scanline header can only state a width in [8, 32767]; anything else
  // is written flat, which every reader still understands.
  const rle = width >= 8 && width < 32768;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      encodePixel(data[i]!, data[i + 1]!, data[i + 2]!, row, x * 4);
    }
    if (rle) {
      bytes.push(2, 2, (width >> 8) & 0xff, width & 0xff);
      encodeScanline(row, width, bytes);
    } else {
      for (let x = 0; x < width * 4; x++) bytes.push(row[x]!);
    }
  }
  return new Uint8Array(bytes);
}

// --- what the conversion actually did ------------------------------------

function stats(d: Decoded): { mean: number; max: number } {
  let sum = 0;
  let max = 0;
  const n = d.width * d.height;
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * d.data[i * 4]! + 0.7152 * d.data[i * 4 + 1]! + 0.0722 * d.data[i * 4 + 2]!;
    sum += l;
    if (l > max) max = l;
  }
  return { mean: sum / n, max };
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const v = Number(args[at + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`${name} wants a positive number`);
    process.exit(2);
  }
  args.splice(at, 2);
  return v;
};
const size = flag("--size", 1024);
const exposure = flag("--exposure", 1);
const [input, output] = args;
if (!input || !output) {
  console.error(
    "usage: bun run assets:optimize-hdri <in.exr|in.hdr> <public/hdri/name.hdr> [--size 1024] [--exposure 1]",
  );
  process.exit(2);
}
if (!existsSync(input)) {
  console.error(`no such file: ${input}`);
  process.exit(2);
}
if (!output.endsWith(".hdr")) {
  console.error("the output must be a .hdr - that is the format this writes");
  process.exit(2);
}

const src = decode(resolve(input));
if (src.width !== src.height * 2) {
  console.error(
    `${input} is ${src.width}x${src.height}, which is not 2:1 - an environment map is equirectangular`,
  );
  process.exit(2);
}
// Measured before anything is done to it, since `resample` hands back the source
// array unchanged when the size already matches and the exposure multiply is in
// place.
const before = stats(src);
const out = resample(src, size, size / 2);
if (exposure !== 1) {
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i]! *= exposure;
    out.data[i + 1]! *= exposure;
    out.data[i + 2]! *= exposure;
  }
}

mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), encodeHdr(out));

// The round trip, printed, because an encoder nobody checks is an encoder that
// silently stops being one. What is compared is the mean and peak LINEAR
// luminance through three's own reader - the same class the game loads this
// with - so the numbers say the file this build produced is the picture this
// build read.
const wanted = stats(out);
const got = stats(decode(resolve(output)));
const pct = (a: number, b: number): string => `${(((a - b) / (b || 1)) * 100).toFixed(2)}%`;
console.log(`[hdri] ${src.width}x${src.height} -> ${out.width}x${out.height}`);
console.log(
  `[hdri] source   mean ${before.mean.toFixed(4)}  peak ${before.max.toFixed(0)}` +
    (exposure === 1 ? "" : `  (x${exposure} exposure)`),
);
console.log(
  `[hdri] resample mean ${wanted.mean.toFixed(4)} (${pct(wanted.mean, before.mean * exposure)})` +
    `  peak ${wanted.max.toFixed(0)}`,
);
console.log(
  `[hdri] rgbe     mean ${got.mean.toFixed(4)} (${pct(got.mean, wanted.mean)})` +
    `  peak ${got.max.toFixed(0)} (${pct(got.max, wanted.max)})`,
);
console.log(
  `[hdri] wrote ${output} (${(statSync(resolve(output)).size / 1024).toFixed(0)} KB)` +
    ` - publish it with \`bun run assets:publish ${output}\``,
);
