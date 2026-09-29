// A plain TypeScript rasteriser of the solids through the perspective camera:
// which object covers each pixel, and how far away it is. No GPU and no DOM,
// so the server can compare a scene with its reference, draw id and depth
// pictures, and fit outlines without a browser. Pixel centres are sampled like
// the GPU's, so it agrees with the WebGL renderer pixel for pixel away from
// triangle edges.

import { cameraMatrices } from "./camera";
import type { MeshOf } from "./raycast";
import type { Camera, SceneObject } from "./types";

export interface Raster {
  width: number;
  height: number;
  /** Per pixel: 1 + the index into `objects` of the nearest object, 0 for none. Row 0 is the top. */
  ids: Uint16Array;
  /** Per pixel: depth along the view axis in metres (Infinity where nothing is drawn). */
  depth: Float32Array;
  /** The objects in `ids` order. */
  objects: string[];
}

type V4 = [number, number, number, number];

/** Clip a polygon in clip space to near (z >= -w) and far (z <= w). */
function clipPolygon(poly: V4[]): V4[] {
  for (const side of [1, -1]) {
    // Inside when side * z + w >= 0: near for side 1, far for side -1.
    const out: V4[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = side * a[2] + a[3];
      const db = side * b[2] + b[3];
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push([0, 1, 2, 3].map((k) => a[k] + t * (b[k] - a[k])) as V4);
      }
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly;
}

/**
 * Rasterise objects into a frame of width x height pixels. Later objects win
 * exact depth ties, as with the GPU's LEQUAL test.
 */
export function rasterize(
  camera: Camera,
  objects: SceneObject[],
  meshOf: MeshOf,
  width: number,
  height: number,
): Raster {
  const ids = new Uint16Array(width * height);
  // 1 / depth: larger is nearer, and linear in screen space.
  const inv = new Float32Array(width * height);
  const vp = cameraMatrices(camera).vp;
  const drawn: string[] = [];
  const screen = new Float64Array(9);
  objects.forEach((e) => {
    const mesh = meshOf(e);
    if (!mesh?.indices.length) return;
    drawn.push(e.id);
    const id = drawn.length;
    // Unit box to clip space.
    const m = vp.slice();
    for (let a = 0; a < 3; a++) for (let r = 0; r < 4; r++) m[a * 4 + r] *= e.size[a];
    for (let r = 0; r < 4; r++) m[12 + r] = vp[r] * e.min[0] + vp[4 + r] * e.min[1] + vp[8 + r] * e.min[2] + vp[12 + r];
    const count = mesh.pos.length / 3;
    const clip = new Float64Array(count * 4);
    for (let i = 0; i < count; i++) {
      const x = mesh.pos[i * 3] / 65535;
      const y = mesh.pos[i * 3 + 1] / 65535;
      const z = mesh.pos[i * 3 + 2] / 65535;
      for (let r = 0; r < 4; r++) clip[i * 4 + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
    }
    const idx = mesh.indices;
    const at = (i: number): V4 => [clip[i * 4], clip[i * 4 + 1], clip[i * 4 + 2], clip[i * 4 + 3]];
    for (let t = 0; t < idx.length; t += 3) {
      const a = at(idx[t]);
      const b = at(idx[t + 1]);
      const c = at(idx[t + 2]);
      const inside = (v: V4) => v[2] >= -v[3] && v[2] <= v[3];
      const poly = inside(a) && inside(b) && inside(c) ? [a, b, c] : clipPolygon([a, b, c]);
      for (let k = 1; k + 1 < poly.length; k++) {
        const tri = [poly[0], poly[k], poly[k + 1]];
        for (let j = 0; j < 3; j++) {
          const v = tri[j];
          screen[j * 3] = ((v[0] / v[3]) * 0.5 + 0.5) * width;
          screen[j * 3 + 1] = ((-v[1] / v[3]) * 0.5 + 0.5) * height;
          screen[j * 3 + 2] = 1 / v[3];
        }
        fill(screen, width, height, ids, inv, id);
      }
    }
  });
  const depth = new Float32Array(width * height);
  for (let i = 0; i < depth.length; i++) depth[i] = ids[i] ? 1 / inv[i] : Infinity;
  return { width, height, ids, depth, objects: drawn };
}

/** Fill one screen-space triangle (x, y, 1/w per corner), sampling pixel centres. */
function fill(s: Float64Array, width: number, height: number, ids: Uint16Array, inv: Float32Array, id: number) {
  const [ax, ay, aw, bx, by, bw, cx, cy, cw] = s;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (!(Math.abs(area) > 1e-12)) return;
  const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
  const x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
  const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
  const y1 = Math.min(height - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
  if (x0 > x1 || y0 > y1) return;
  const r = 1 / area;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * r;
      const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * r;
      const wc = 1 - wa - wb;
      if (wa < 0 || wb < 0 || wc < 0) continue;
      const w = wa * aw + wb * bw + wc * cw;
      const j = y * width + x;
      if (w < inv[j]) continue;
      inv[j] = w;
      ids[j] = id;
    }
  }
}

/**
 * Flat colours for an object-id picture, one per object, all distinct and none
 * black (the background): hues a golden angle apart, in three lightness bands.
 */
export function idPalette(count: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const taken = new Set<number>([0]);
  for (let i = 0; out.length < count; i++) {
    const h = (i * 137.508) % 360;
    const l = [0.55, 0.38, 0.72][Math.floor(i / 7) % 3];
    const s = 0.85;
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    const rgb: [number, number, number] = [f(0), f(8), f(4)];
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(rgb);
  }
  return out;
}

const hexOf = (rgb: [number, number, number]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** The legend of an id picture: colour to object id. */
export function idLegend(objects: string[]): Record<string, string> {
  const palette = idPalette(objects.length);
  return Object.fromEntries(objects.map((id, i) => [hexOf(palette[i]), id]));
}

/** An id picture as RGBA pixels (background black, opaque). */
export function idPixels(r: Pick<Raster, "width" | "height" | "ids" | "objects">): Uint8ClampedArray<ArrayBuffer> {
  const palette = idPalette(r.objects.length);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let i = 0; i < r.ids.length; i++) {
    const id = r.ids[i];
    if (id) out.set(palette[id - 1], i * 4);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * A depth picture as 16-bit grey: the nearest visible surface is white
 * (65535), the farthest 1, nothing drawn 0. A value v >= 1 decodes to
 * far - (v - 1) / 65534 * (far - near) metres along the view axis.
 */
export function depthPixels(r: Pick<Raster, "ids" | "depth">): { grey16: Uint16Array; near: number; far: number } {
  let near = Infinity;
  let far = 0;
  for (let i = 0; i < r.ids.length; i++)
    if (r.ids[i]) {
      near = Math.min(near, r.depth[i]);
      far = Math.max(far, r.depth[i]);
    }
  const grey16 = new Uint16Array(r.ids.length);
  if (!Number.isFinite(near)) return { grey16, near: 0, far: 0 };
  const span = far - near;
  for (let i = 0; i < r.ids.length; i++)
    if (r.ids[i]) grey16[i] = span > 0 ? 1 + Math.round(((far - r.depth[i]) / span) * 65534) : 65535;
  return { grey16, near, far };
}
