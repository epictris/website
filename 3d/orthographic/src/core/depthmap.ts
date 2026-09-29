// A relative depth map of the perspective reference (from a monocular depth
// model: larger is nearer, up to an unknown scale and offset), and what the
// scene can learn from it: a calibration against the objects already placed,
// boundaries where the scene's occlusion order disagrees with the picture's,
// and the depth range a traced object probably occupies. Pure; the server
// makes the maps, the page only reads them.

import { polygonMask } from "./compare";
import { frameToImage, type ImageSize, imageToFrame, overlayGeometry } from "./overlay";
import { type Raster, rasterize } from "./raster";
import { type MeshOf, pointAtDepth } from "./raycast";
import type { EditorState, Issue, Point, Trace } from "./types";

/**
 * Per pixel of the map (row 0 at the top), larger is nearer; NaN where there
 * is no value. The map covers the whole reference image, at its own
 * resolution: map pixel (x, y) spans image pixels scaled by
 * image.width / width and image.height / height.
 */
export interface DepthMap {
  width: number;
  height: number;
  values: Float32Array;
}

/** A depth map's value at an image pixel position (bilinear; NaN off the image or next to a missing value). */
export function depthAt(map: DepthMap, image: ImageSize, u: number, v: number): number {
  const x = (u * map.width) / image.width - 0.5;
  const y = (v * map.height) / image.height - 0.5;
  if (!(x > -0.5 && y > -0.5 && x < map.width - 0.5 && y < map.height - 0.5)) return Number.NaN;
  const xa = Math.max(0, Math.min(map.width - 1, Math.floor(x)));
  const ya = Math.max(0, Math.min(map.height - 1, Math.floor(y)));
  const xb = Math.min(map.width - 1, xa + 1);
  const yb = Math.min(map.height - 1, ya + 1);
  const fx = Math.max(0, Math.min(1, x - xa));
  const fy = Math.max(0, Math.min(1, y - ya));
  const w = map.width;
  const m = map.values;
  const top = m[ya * w + xa] * (1 - fx) + m[ya * w + xb] * fx;
  const bottom = m[yb * w + xa] * (1 - fx) + m[yb * w + xb] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * The map as 16-bit grey, as stored in the document: the nearest value white
 * (65535), the farthest 1, no value 0. Ordering and ratios of differences
 * survive, which is all a relative map has.
 */
export function depthToGrey16(map: DepthMap): Uint16Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of map.values)
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  const out = new Uint16Array(map.values.length);
  const span = hi - lo;
  map.values.forEach((v, i) => {
    if (Number.isFinite(v)) out[i] = span > 0 ? 1 + Math.round(((v - lo) / span) * 65534) : 65535;
  });
  return out;
}

/** A stored depth picture (grey levels, any bit depth) back as a map: 0 is no value. */
export function depthFromGrey(width: number, height: number, grey: ArrayLike<number>): DepthMap {
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = grey[i] ? grey[i] : Number.NaN;
  return { width, height, values };
}

// ---- Calibration ---------------------------------------------------------------------------

/** Visible pixels closer than this to another object's (or the background) are left out: the map blurs edges. */
const ERODE = 3;
/** Fewest usable pixels for an object to take part in the calibration. */
const MIN_OBJECT_SAMPLES = 20;

export interface Calibration {
  /** value ≈ a / depth + b, depth in metres along the camera's view axis. */
  a: number;
  b: number;
  /** How well the objects fit, 0 to 1. */
  r2: number;
  /** Per object that took part: the scene's median depth and the map's, both in metres. */
  objects: { id: string; sceneDepth: number; estimatedDepth: number | null }[];
}

/** The metres a map value means under a calibration (null where it means none: behind the camera, or at infinity). */
export function calibratedDepth(c: Pick<Calibration, "a" | "b">, value: number): number | null {
  const inv = (value - c.b) / c.a;
  return inv > 0 && Number.isFinite(inv) ? 1 / inv : null;
}

/** The camera frame's raster of the visible objects. */
const frameRaster = (s: EditorState, meshOf: MeshOf): Raster =>
  rasterize(
    s.camera,
    s.objects.filter((e) => e.visible),
    meshOf,
    s.camera.frame[0],
    s.camera.frame[1],
  );

/** Mark the positions of each run of equal non-zero keys that lie at least `radius` from both its ends. */
function runsAwayFromEnds(n: number, radius: number, key: (k: number) => number, mark: (k: number) => void) {
  let start = 0;
  for (let k = 1; k <= n; k++) {
    if (k < n && key(k) === key(start)) continue;
    if (key(start)) for (let q = start + radius; q < k - radius; q++) mark(q);
    start = k;
  }
}

/** Pixels whose whole square of radius `radius` shows the same object, as a mask over the frame. */
function eroded(r: Raster, radius: number): Uint8Array {
  const { width, height, ids } = r;
  const across = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    runsAwayFromEnds(
      width,
      radius,
      (x) => ids[y * width + x],
      (x) => {
        across[y * width + x] = 1;
      },
    );
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++)
    runsAwayFromEnds(
      height,
      radius,
      (y) => (across[y * width + x] ? ids[y * width + x] : 0),
      (y) => {
        out[y * width + x] = 1;
      },
    );
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Where frame pixel centres fall in the reference image. */
function frameToImageOf(s: EditorState, image: ImageSize) {
  const ref = s.references.perspective;
  if (!ref) return null;
  const g = overlayGeometry(s.camera.frame[0], s.camera.frame[1], ref, image);
  return (x: number, y: number): Point => frameToImage(g, image, [x, y]);
}

/**
 * Fit the map to the scene: value ≈ a / depth + b by least squares over the
 * placed objects' median depths (visible pixels, away from their edges).
 * Null with fewer than 3 objects to fit, or when they all sit at one depth.
 */
export function calibrate(
  s: EditorState,
  meshOf: MeshOf,
  map: DepthMap,
  image: ImageSize,
  raster = frameRaster(s, meshOf),
): Calibration | null {
  const toImage = frameToImageOf(s, image);
  if (!toImage) return null;
  const keep = eroded(raster, ERODE);
  const depths = raster.objects.map(() => [] as number[]);
  const values = raster.objects.map(() => [] as number[]);
  for (let j = 0; j < raster.ids.length; j++) {
    if (!keep[j]) continue;
    const x = j % raster.width;
    const [u, v] = toImage(x + 0.5, (j - x) / raster.width + 0.5);
    const value = depthAt(map, image, u, v);
    if (!Number.isFinite(value)) continue;
    depths[raster.ids[j] - 1].push(raster.depth[j]);
    values[raster.ids[j] - 1].push(value);
  }
  const rows = raster.objects.flatMap((id, i) =>
    depths[i].length >= MIN_OBJECT_SAMPLES ? [{ id, depth: median(depths[i]), value: median(values[i]) }] : [],
  );
  if (rows.length < 3) return null;
  const xs = rows.map((r) => 1 / r.depth);
  const ys = rows.map((r) => r.value);
  const n = rows.length;
  const mx = xs.reduce((p, q) => p + q) / n;
  const my = ys.reduce((p, q) => p + q) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  // All at (nearly) one depth: the slope is undetermined.
  if (!(sxx > 1e-12 * mx * mx * n) || !(syy > 0)) return null;
  const a = sxy / sxx;
  const b = my - a * mx;
  const c = { a, b };
  return {
    a,
    b,
    r2: (sxy * sxy) / (sxx * syy),
    objects: rows.map((r) => ({
      id: r.id,
      sceneDepth: r.depth,
      estimatedDepth: a > 0 ? calibratedDepth(c, r.value) : null,
    })),
  };
}

// ---- Occlusion order -------------------------------------------------------------------

/** Rendered depths closer than this (metres) are not an order the map can judge. */
const MIN_DEPTH_GAP = 0.1;
/** How far into each side of a boundary the map is read, in frame pixels. */
const REACH = 6;
/** Fewest boundary samples between two objects before their order is judged. */
const MIN_PAIR_SAMPLES = 40;
/** Below this share of samples agreeing with the scene, the pair is reported. */
const MIN_AGREEMENT = 0.3;

export interface PairOrder {
  /** The two objects: a is the one the scene puts nearer on most of their boundary. */
  a: string;
  b: string;
  samples: number;
  /** Samples where the map agrees. */
  agree: number;
  /** Frame pixels of the boundary samples that disagree, inclusive. */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

/**
 * Across every boundary between two visible objects whose rendered depths
 * differ by at least 10 cm, read the map 6 px into each side and count how
 * often it agrees with the scene on which side is nearer. One entry per pair
 * of objects that meet.
 */
export function boundaryOrder(
  s: EditorState,
  meshOf: MeshOf,
  map: DepthMap,
  image: ImageSize,
  raster = frameRaster(s, meshOf),
): PairOrder[] {
  const toImage = frameToImageOf(s, image);
  if (!toImage) return [];
  const { width, height, ids, depth } = raster;
  // Per pair (lower raster index first): samples, agreements, and how often the first is the nearer.
  const pairs = new Map<
    number,
    { first: number; second: number; samples: number; agree: number; firstNearer: number; bbox: PairOrder["bbox"] }
  >();
  const sample = (x: number, y: number) => {
    const [u, v] = toImage(x + 0.5, y + 0.5);
    return depthAt(map, image, u, v);
  };
  // A boundary between pixel p (x, y) and the pixel one step (dx, dy) on.
  const judge = (x: number, y: number, dx: number, dy: number) => {
    const ax = x - (REACH - 1) * dx;
    const ay = y - (REACH - 1) * dy;
    const bx = x + REACH * dx;
    const by = y + REACH * dy;
    if (ax < 0 || ay < 0 || bx >= width || by >= height) return;
    const ia = ay * width + ax;
    const ib = by * width + bx;
    const idA = ids[y * width + x];
    const idB = ids[(y + dy) * width + x + dx];
    // Both reads must still land on the two objects that meet here.
    if (ids[ia] !== idA || ids[ib] !== idB) return;
    const da = depth[ia];
    const db = depth[ib];
    if (Math.abs(da - db) < MIN_DEPTH_GAP) return;
    const va = sample(ax, ay);
    const vb = sample(bx, by);
    if (!Number.isFinite(va) || !Number.isFinite(vb) || va === vb) return;
    const first = Math.min(idA, idB);
    const second = Math.max(idA, idB);
    const key = first * 65536 + second;
    let p = pairs.get(key);
    if (!p) {
      p = { first, second, samples: 0, agree: 0, firstNearer: 0, bbox: null };
      pairs.set(key, p);
    }
    p.samples++;
    if ((da < db ? idA : idB) === first) p.firstNearer++;
    if (va > vb === da < db) p.agree++;
    else {
      const b = p.bbox ?? { x0: x, y0: y, x1: x, y1: y };
      p.bbox = { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) };
    }
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const id = ids[y * width + x];
      if (!id) continue;
      if (x + 1 < width && ids[y * width + x + 1] && ids[y * width + x + 1] !== id) judge(x, y, 1, 0);
      if (y + 1 < height && ids[(y + 1) * width + x] && ids[(y + 1) * width + x] !== id) judge(x, y, 0, 1);
    }
  return [...pairs.values()].map((p) => {
    const [near, far] = 2 * p.firstNearer >= p.samples ? [p.first, p.second] : [p.second, p.first];
    return {
      a: raster.objects[near - 1],
      b: raster.objects[far - 1],
      samples: p.samples,
      agree: p.agree,
      bbox: p.bbox,
    };
  });
}

/**
 * Pairs of objects whose occlusion order the depth map contradicts: at least
 * 40 boundary samples, fewer than 30 % agreeing with the scene.
 */
export function depthOrderIssues(
  s: EditorState,
  meshOf: MeshOf,
  map: DepthMap,
  image: ImageSize,
  raster = frameRaster(s, meshOf),
): Issue[] {
  return boundaryOrder(s, meshOf, map, image, raster)
    .filter((p) => p.samples >= MIN_PAIR_SAMPLES && p.agree / p.samples < MIN_AGREEMENT)
    .map((p) => {
      const i = s.objects.findIndex((e) => e.id === p.a);
      const share = Math.round((100 * p.agree) / p.samples);
      const b = p.bbox!;
      return {
        severity: "warning",
        code: "depth-order",
        path: `/objects/${i}`,
        objectId: p.a,
        message: `The scene puts ${p.a} in front of ${p.b} where they meet, but the reference's depth map agrees on only ${share}% of ${p.samples} boundary samples (those that disagree lie within frame x ${b.x0}-${b.x1}, y ${b.y0}-${b.y1}): ${p.b} may stand in front of ${p.a} there. The map is an estimate; look at the picture before moving anything.`,
      } satisfies Issue;
    });
}

// ---- Depth range for a trace ----------------------------------------------------------------

/** Most trace pixels read for a depth range; larger traces are sampled on a grid. */
const MAX_RANGE_SAMPLES = 40_000;

export interface DepthRange {
  /** World y (metres) to build between: the visible surface's range, deepened to `assumedThickness` when thinner. */
  min: number;
  max: number;
  /** The 5th and 95th percentile of world y over the surface the map sees inside the trace. */
  visible: { min: number; max: number };
  /**
   * Set when the visible surface was thinner than half the object's smaller
   * extent across the picture: the depth assumed instead (metres). A picture
   * never shows an object's back.
   */
  assumedThickness?: number;
  samples: number;
}

/**
 * The depth range a traced object probably occupies. Each of the trace's
 * pixels (away from its edge, where the map blurs into whatever is beside it)
 * is placed on its ray at its calibrated depth; the 5th and 95th percentile of
 * those points' world y is the visible surface's range. That is only the
 * front: when it is thinner than half the object's smaller extent across the
 * picture (width or height, at its median depth), that thickness is assumed.
 * Null when too little of the trace has a usable value.
 */
export function depthRangeFor(
  s: EditorState,
  map: DepthMap,
  calibration: Pick<Calibration, "a" | "b">,
  trace: Pick<Trace, "points">,
  image: ImageSize,
): DepthRange | null {
  const ref = s.references.perspective;
  if (!ref) return null;
  const g = overlayGeometry(s.camera.frame[0], s.camera.frame[1], ref, image);
  const mask = polygonMask(trace.points, image.width, image.height);
  const inside = (x: number, y: number) =>
    x >= mask.x0 &&
    y >= mask.y0 &&
    x < mask.x0 + mask.w &&
    y < mask.y0 + mask.h &&
    mask.bits[(y - mask.y0) * mask.w + x - mask.x0] === 1;
  const step = Math.max(1, Math.floor(Math.sqrt(mask.count / MAX_RANGE_SAMPLES)));
  const ys: number[] = [];
  const depths: number[] = [];
  for (let y = mask.y0; y < mask.y0 + mask.h; y += step)
    for (let x = mask.x0; x < mask.x0 + mask.w; x += step) {
      if (!inside(x, y)) continue;
      if (!inside(x - ERODE, y) || !inside(x + ERODE, y) || !inside(x, y - ERODE) || !inside(x, y + ERODE)) continue;
      const d = calibratedDepth(calibration, depthAt(map, image, x + 0.5, y + 0.5));
      if (d === null) continue;
      ys.push(pointAtDepth(s, imageToFrame(g, image, [x + 0.5, y + 0.5]), d)[1]);
      depths.push(d);
    }
  if (ys.length < MIN_OBJECT_SAMPLES) return null;
  const percentile = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  ys.sort((p, q) => p - q);
  depths.sort((p, q) => p - q);
  const visible = { min: percentile(ys, 0.05), max: percentile(ys, 0.95) };
  // The trace's extent across the picture, at the object's median depth.
  const at = depths[depths.length >> 1];
  const across = trace.points.map((p) => pointAtDepth(s, imageToFrame(g, image, p), at));
  const extent = (k: number) => Math.max(...across.map((p) => p[k])) - Math.min(...across.map((p) => p[k]));
  const thickness = 0.5 * Math.min(extent(0), extent(2));
  if (visible.max - visible.min >= thickness) return { ...visible, visible, samples: ys.length };
  return {
    min: visible.min,
    max: visible.min + thickness,
    visible,
    assumedThickness: thickness,
    samples: ys.length,
  };
}
