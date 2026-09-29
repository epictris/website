// PNG encoding for pictures made without a canvas (the server's id, depth and
// comparison pictures), and decoding of the plain kinds a depth map is stored
// as (a canvas would round 16 bits to 8). The zlib step is the caller's:
// node:zlib on the server, CompressionStream / DecompressionStream("deflate")
// in a page.

export type Deflate = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode pixels as a PNG. `rgba` 8-bit (4 bytes a pixel, alpha kept) or
 * `grey16` (one 16-bit value a pixel, as a Uint16Array).
 */
export async function encodePng(
  width: number,
  height: number,
  pixels: { rgba: Uint8Array | Uint8ClampedArray } | { grey16: Uint16Array },
  deflate: Deflate,
): Promise<Uint8Array> {
  const grey = "grey16" in pixels;
  const bpp = grey ? 2 : 4;
  const row = width * bpp;
  const raw = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (row + 1);
    raw[o] = 0; // no filter
    if (grey) {
      const g = pixels.grey16;
      for (let x = 0; x < width; x++) {
        const v = g[y * width + x];
        raw[o + 1 + x * 2] = v >> 8;
        raw[o + 2 + x * 2] = v & 0xff;
      }
    } else raw.set(pixels.rgba.subarray(y * row, (y + 1) * row), o + 1);
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = grey ? 16 : 8; // bit depth
  header[9] = grey ? 0 : 6; // colour type: greyscale or RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export type Inflate = (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface DecodedPng {
  width: number;
  height: number;
  /** Samples per pixel: 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA. */
  channels: number;
  /** 8 or 16. */
  bitDepth: number;
  /** Every sample, row by row, at its own bit depth. */
  samples: Uint16Array;
}

/**
 * Decode a PNG of 8- or 16-bit samples (grey, RGB, with or without alpha),
 * not interlaced: what a depth map is stored as. Null for anything else
 * (palettes, fewer bits, interlacing), which a caller decodes another way.
 */
export async function decodePng(bytes: Uint8Array, inflate: Inflate): Promise<DecodedPng | null> {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || signature.some((b, i) => bytes[i] !== b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  const bitDepth = bytes[24];
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[bytes[25]];
  if (!channels || (bitDepth !== 8 && bitDepth !== 16) || bytes[28] !== 0 || !width || !height) return null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = v.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IDAT") idat.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let filled = 0;
  for (const c of idat) {
    joined.set(c, filled);
    filled += c.length;
  }
  const raw = await inflate(joined);
  const bpp = (channels * bitDepth) / 8;
  const row = width * bpp;
  if (raw.length < (row + 1) * height) return null;
  // Undo each row's filter in place, against the row above (already unfiltered).
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (row + 1)];
    const src = y * (row + 1) + 1;
    const dst = y * row;
    for (let x = 0; x < row; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y ? out[dst - row + x] : 0;
      const c = x >= bpp && y ? out[dst - row + x - bpp] : 0;
      let p = raw[src + x];
      if (filter === 1) p += a;
      else if (filter === 2) p += b;
      else if (filter === 3) p += (a + b) >> 1;
      else if (filter === 4) {
        const e = a + b - c;
        const pa = Math.abs(e - a);
        const pb = Math.abs(e - b);
        const pc = Math.abs(e - c);
        p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      out[dst + x] = p & 0xff;
    }
  }
  const samples = new Uint16Array(width * height * channels);
  if (bitDepth === 8) samples.set(out);
  else for (let i = 0; i < samples.length; i++) samples[i] = (out[i * 2] << 8) | out[i * 2 + 1];
  return { width, height, channels, bitDepth, samples };
}
