// PNG encoding for pictures made without a canvas (the server's id, depth and
// comparison pictures). The zlib compression is the caller's: node:zlib on the
// server, CompressionStream("deflate") in a page.

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
