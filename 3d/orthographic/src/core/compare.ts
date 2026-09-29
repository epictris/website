// Comparing the scene with its perspective reference: each object's rendered
// silhouette against the silhouette traced for it in the reference image.
// Uses the CPU rasteriser (core/raster.ts), so the server needs no browser.
//
// For each traced object, over the camera frame:
//   spill    pixels where the object is visible but outside its trace (always
//            wrong, whatever is in front of it);
//   missing  pixels inside its trace, away from hidden runs, where what is
//            visible is the background or an object whose own trace does not
//            contain the pixel;
//   iou      of its visible region against its trace, less the parts that
//            nearer traced objects rightly cover;
//   order    pixels where an inFrontOf hint is contradicted: both objects are
//            there, and the one said to be behind is nearer.

import { type ImageSize, imageToFrame, overlayGeometry } from "./overlay";
import { type Raster, rasterize } from "./raster";
import type { MeshOf } from "./raycast";
import type { EditorState, Issue, Point, SceneObject } from "./types";

/** A difference smaller than this many pixels, or this share of the trace, is not reported as an issue. */
export const MIN_PIXELS = 25;
export const MIN_SHARE = 0.01;

export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PixelSet {
  count: number;
  /** Frame pixels, inclusive; null when count is 0. */
  bbox: PixelBox | null;
}

export interface ObjectComparison {
  id: string;
  /** Frame pixels inside the trace. */
  tracePixels: number;
  /** Frame pixels where the object is the nearest thing drawn. */
  visiblePixels: number;
  spill: PixelSet;
  missing: PixelSet;
  iou: number;
  /** Per object named in inFrontOf: pixels where that object is nearer (only those contradicted). */
  order: Record<string, PixelSet>;
}

export interface Comparison {
  width: number;
  height: number;
  objects: ObjectComparison[];
  issues: Issue[];
  /** RGBA: correct in grey, spill in red, missing in blue, other geometry dark grey, nothing black. */
  diff?: Uint8ClampedArray<ArrayBuffer>;
}

/** A polygon's pixels (centres inside, even-odd), stored over its bounding box on the frame. */
export interface Mask {
  x0: number;
  y0: number;
  w: number;
  h: number;
  bits: Uint8Array;
  count: number;
}

export function polygonMask(poly: Point[], width: number, height: number): Mask {
  const ys = poly.map((p) => p[1]);
  const xs = poly.map((p) => p[0]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  const w = Math.max(0, x1 - x0 + 1);
  const h = Math.max(0, y1 - y0 + 1);
  const bits = new Uint8Array(w * h);
  let count = 0;
  const cross: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    cross.length = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a[1] > py !== b[1] > py) cross.push(a[0] + ((py - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    cross.sort((p, q) => p - q);
    for (let k = 0; k + 1 < cross.length; k += 2) {
      const from = Math.max(x0, Math.ceil(cross[k] - 0.5));
      const to = Math.min(x1, Math.ceil(cross[k + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) {
        bits[(y - y0) * w + x - x0] = 1;
        count++;
      }
    }
  }
  return { x0, y0, w, h, bits, count };
}

export const maskHas = (m: Mask, x: number, y: number) =>
  x >= m.x0 && y >= m.y0 && x < m.x0 + m.w && y < m.y0 + m.h && m.bits[(y - m.y0) * m.w + x - m.x0] === 1;

class Pixels {
  count = 0;
  private b: PixelBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  add(x: number, y: number) {
    this.count++;
    if (x < this.b.x0) this.b.x0 = x;
    if (y < this.b.y0) this.b.y0 = y;
    if (x > this.b.x1) this.b.x1 = x;
    if (y > this.b.y1) this.b.y1 = y;
  }
  get set(): PixelSet {
    return { count: this.count, bbox: this.count ? { ...this.b } : null };
  }
}

/** Squared distance from a point to a segment. */
function segmentDistance(px: number, py: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const den = dx * dx + dy * dy;
  const t = den ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / den)) : 0;
  return (px - a[0] - t * dx) ** 2 + (py - a[1] - t * dy) ** 2;
}

/** Which edges of a trace are guessed: edge i runs from vertex i to i + 1. */
export function hiddenEdges(n: number, runs: [number, number][]): boolean[] {
  const hidden = new Array<boolean>(n).fill(false);
  for (const [a, b] of runs) for (let e = a; e !== b; e = (e + 1) % n) hidden[e] = true;
  return hidden;
}

/** Hidden runs from per-edge flags (the inverse of hiddenEdges): each maximal run of hidden edges, wrapping. */
export function hiddenRuns(flags: boolean[]): [number, number][] {
  const n = flags.length;
  if (!flags.some(Boolean)) return [];
  // A run must start and end at different vertices, so an all-hidden trace is two runs.
  if (flags.every(Boolean))
    return n > 1
      ? [
          [0, 1],
          [1, 0],
        ]
      : [];
  const runs: [number, number][] = [];
  const first = flags.findIndex((f) => !f);
  for (let k = 1; k <= n; k++) {
    const e = (first + k) % n;
    if (flags[e] && !flags[(e - 1 + n) % n]) {
      let end = e;
      while (flags[(end + 1) % n]) end = (end + 1) % n;
      runs.push([e, (end + 1) % n]);
    }
  }
  return runs.sort((p, q) => p[0] - q[0]);
}

/** The trace of an object on the frame: its points in frame pixels, and a test for "nearer a hidden edge than a traced one". */
export interface FrameTrace {
  points: Point[];
  mask: Mask;
  /** True where a pixel centre is nearer a hidden edge than any traced edge (always false without hidden runs). */
  guessed(x: number, y: number): boolean;
}

function frameTrace(
  e: SceneObject,
  s: EditorState,
  image: ImageSize,
  width: number,
  height: number,
): FrameTrace | null {
  const ref = s.references.perspective;
  if (!e.trace || !ref) return null;
  const g = overlayGeometry(width, height, ref, image);
  const points = e.trace.points.map((p) => imageToFrame(g, image, p));
  const hidden = hiddenEdges(points.length, e.trace.hidden);
  const anyHidden = hidden.some(Boolean);
  const edges = points.map((a, i) => [a, points[(i + 1) % points.length]] as const);
  return {
    points,
    mask: polygonMask(points, width, height),
    guessed(x, y) {
      if (!anyHidden) return false;
      const px = x + 0.5;
      const py = y + 0.5;
      let nearHidden = Infinity;
      let nearTraced = Infinity;
      edges.forEach(([a, b], i) => {
        const d = segmentDistance(px, py, a, b);
        if (hidden[i]) nearHidden = Math.min(nearHidden, d);
        else nearTraced = Math.min(nearTraced, d);
      });
      return nearHidden < nearTraced;
    },
  };
}

export interface CompareOptions {
  /** Compare only these objects (default: every visible object with a trace). */
  ids?: string[];
  /** Also draw the difference picture. */
  diff?: boolean;
  /** Frame width in pixels (default the camera frame's); the height follows. */
  width?: number;
}

/**
 * Compare each traced object with the reference. Null when there is nothing
 * to compare: no perspective reference, or no visible object with a trace.
 */
export function compareToReference(
  s: EditorState,
  meshOf: MeshOf,
  image: ImageSize | undefined,
  opts: CompareOptions = {},
): Comparison | null {
  const ref = s.references.perspective;
  if (!ref || !image) return null;
  const width = opts.width ?? s.camera.frame[0];
  const height = Math.round((width * s.camera.frame[1]) / s.camera.frame[0]);
  const shown = s.objects.filter((e) => e.visible);
  const wanted = opts.ids ? new Set(opts.ids) : null;
  const traced = shown.filter((e) => e.trace && (!wanted || wanted.has(e.id)));
  if (!traced.length) return null;
  const raster = rasterize(s.camera, shown, meshOf, width, height);
  const index = new Map(raster.objects.map((id, i) => [id, i + 1]));
  // Every traced object's trace, compared or not: they decide what may rightly cover what.
  const traces = new Map<number, FrameTrace>();
  for (const e of shown) {
    const t = frameTrace(e, s, image, width, height);
    const k = index.get(e.id);
    if (t && k) traces.set(k, t);
  }
  // Where each object is visible, so each comparison scans only its own area.
  const seen = raster.objects.map(() => ({ x0: width, y0: height, x1: -1, y1: -1 }));
  for (let j = 0; j < raster.ids.length; j++) {
    const at = raster.ids[j];
    if (!at) continue;
    const b = seen[at - 1];
    const x = j % width;
    const y = (j - x) / width;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }
  const diff = opts.diff ? new Uint8ClampedArray(width * height * 4) : undefined;
  const results: ObjectComparison[] = [];
  const issues: Issue[] = [];
  const correct = new Uint8Array(opts.diff ? width * height : 0);
  const marks = new Uint8Array(opts.diff ? width * height : 0); // 1 spill, 2 missing
  for (const e of traced) {
    const k = index.get(e.id);
    const t: FrameTrace | null | undefined = k ? traces.get(k) : frameTrace(e, s, image, width, height);
    if (!t) continue;
    const spill = new Pixels();
    const missing = new Pixels();
    let visible = 0;
    let both = 0;
    let target = 0;
    const v = k ? seen[k - 1] : { x0: width, y0: height, x1: -1, y1: -1 };
    const m: Mask = t.mask;
    const ya: number = Math.min(v.y0, m.y0);
    const yb: number = Math.max(v.y1, m.y0 + m.h - 1);
    const xa: number = Math.min(v.x0, m.x0);
    const xb: number = Math.max(v.x1, m.x0 + m.w - 1);
    for (let y = ya; y <= yb; y++)
      for (let x = xa; x <= xb; x++) {
        const j = y * width + x;
        const at = raster.ids[j];
        const mine = k !== undefined && at === k;
        const inside = maskHas(t.mask, x, y);
        if (!mine && !inside) continue;
        if (mine) visible++;
        if (mine && !inside) {
          spill.add(x, y);
          if (diff) marks[j] = 1;
          continue;
        }
        // Inside the trace from here on.
        const coveredRightly = at !== 0 && !mine && !!traces.get(at) && maskHas(traces.get(at)!.mask, x, y);
        if (coveredRightly) continue;
        if (mine) {
          target++;
          both++;
          if (diff) correct[j] = 1;
          continue;
        }
        if (t.guessed(x, y)) continue;
        target++;
        missing.add(x, y);
        if (diff && marks[j] !== 1) marks[j] = 2;
      }
    const union = visible + target - both;
    const order: Record<string, PixelSet> = {};
    const orderIssues: Issue[] = [];
    for (const other of e.inFrontOf ?? []) {
      const q = shown.find((o) => o.id === other);
      if (!q || !k) continue;
      const px = contradicted(s, meshOf, e, q, width, height);
      if (!px.count) continue;
      order[other] = px;
      if (px.count >= MIN_PIXELS) orderIssues.push(orderIssue(s, e, q, px));
    }
    const i = s.objects.indexOf(e);
    const threshold = Math.max(MIN_PIXELS, MIN_SHARE * t.mask.count);
    if (spill.count >= threshold)
      issues.push({
        severity: "warning",
        code: "trace-spill",
        path: `/objects/${i}/trace`,
        objectId: e.id,
        message: `${e.id} is drawn on ${spill.count} pixels outside its trace (${boxText(spill.set.bbox!)}): the solid reaches too far there.`,
      });
    if (missing.count >= threshold)
      issues.push({
        severity: "warning",
        code: "trace-missing",
        path: `/objects/${i}/trace`,
        objectId: e.id,
        message: `${e.id} leaves ${missing.count} pixels of its trace uncovered (${boxText(missing.set.bbox!)}): the solid falls short there, or something that should be behind it is in front.`,
      });
    issues.push(...orderIssues);
    results.push({
      id: e.id,
      tracePixels: t.mask.count,
      visiblePixels: visible,
      spill: spill.set,
      missing: missing.set,
      iou: union ? both / union : 1,
      order,
    });
  }
  if (diff)
    for (let j = 0; j < width * height; j++) {
      const c =
        marks[j] === 1
          ? [235, 64, 52]
          : marks[j] === 2
            ? [52, 120, 235]
            : correct[j]
              ? [170, 170, 170]
              : raster.ids[j]
                ? [60, 60, 60]
                : [0, 0, 0];
      diff.set([c[0], c[1], c[2], 255], j * 4);
    }
  return { width, height, objects: results, issues, diff };
}

const boxText = (b: PixelBox) => `frame x ${b.x0}-${b.x1}, y ${b.y0}-${b.y1}`;

function orderIssue(s: EditorState, front: SceneObject, back: SceneObject, px: PixelSet): Issue {
  return {
    severity: "warning",
    code: "occlusion-order",
    path: `/objects/${s.objects.indexOf(front)}/inFrontOf/${front.inFrontOf!.indexOf(back.id)}`,
    objectId: front.id,
    message: `${front.id} should be in front of ${back.id}, but ${back.id} is nearer on ${px.count} pixels (${boxText(px.bbox!)}). Move ${front.id} nearer the camera there, or ${back.id} further.`,
  };
}

/** Pixels where both objects are drawn and `back` is nearer than `front`. */
function contradicted(
  s: EditorState,
  meshOf: MeshOf,
  front: SceneObject,
  back: SceneObject,
  width: number,
  height: number,
): PixelSet {
  const a: Raster = rasterize(s.camera, [front], meshOf, width, height);
  const b: Raster = rasterize(s.camera, [back], meshOf, width, height);
  const px = new Pixels();
  for (let j = 0; j < a.ids.length; j++)
    if (a.ids[j] && b.ids[j] && b.depth[j] < a.depth[j]) px.add(j % width, Math.floor(j / width));
  return px.set;
}

/** The comparison's problems, for validation: none when there is nothing to compare. */
export function referenceIssues(
  s: EditorState,
  meshOf: MeshOf,
  image: ImageSize | undefined,
  only?: ReadonlySet<string>,
): Issue[] {
  const ids = only ? [...only] : undefined;
  return compareToReference(s, meshOf, image, { ids })?.issues ?? [];
}
