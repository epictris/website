// Screen mapping for an orthographic view: world (u, v) on the view plane to
// SVG pixels, with v up.

import type { Box } from "../core/camera";
import { MIN_FRAME } from "../core/math";
import type { ViewWindow } from "../core/projection";
import type { Point, SceneObject, ViewId } from "../core/types";
import { VIEWS } from "../core/views";
import type { OrthoCamera } from "../store";

export interface Frame {
  W: number;
  H: number;
  s: number;
  tx: number;
  ty: number;
}

export function frameOf(cam: { scale: number; center: Point }, W: number, H: number): Frame {
  return { W, H, s: cam.scale, tx: W / 2 - cam.center[0] * cam.scale, ty: H / 2 + cam.center[1] * cam.scale };
}

/** The frame of a picture of a fixed world window at a fixed scale (core/projection.ts). */
export const windowFrame = (w: ViewWindow, pixelsPerMeter: number): Frame => ({
  W: w.width,
  H: w.height,
  s: pixelsPerMeter,
  tx: -w.min[0] * pixelsPerMeter,
  ty: (w.min[1] + w.size[1]) * pixelsPerMeter,
});

export const toScreen = (f: Frame, u: number, v: number): Point => [f.tx + u * f.s, f.ty - v * f.s];
export const toWorld = (f: Frame, x: number, y: number): Point => [(x - f.tx) / f.s, (f.ty - y) / f.s];

/** The camera that fits a box into a W x H view with a margin for labels and the scale bar. */
export function fitCamera(view: ViewId, box: Box, W: number, H: number): OrthoCamera {
  const [a, b] = VIEWS[view].axes;
  let scale = Math.min(
    Math.max(W - 80, 30) / Math.max(box.max[a] - box.min[a], MIN_FRAME),
    Math.max(H - 72, 25) / Math.max(box.max[b] - box.min[b], MIN_FRAME),
  );
  scale = Math.max(1e-4, Math.min(1e5, scale));
  return { scale, center: [(box.min[a] + box.max[a]) / 2, (box.min[b] + box.max[b]) / 2], autoFit: true };
}

export interface ScreenBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export function screenBox(f: Frame, view: ViewId, min: number[], max: number[]): ScreenBox {
  const [a, b] = VIEWS[view].axes;
  const lo = toScreen(f, min[a], min[b]);
  const hi = toScreen(f, max[a], max[b]);
  return { left: lo[0], right: hi[0], top: hi[1], bottom: lo[1], width: hi[0] - lo[0], height: lo[1] - hi[1] };
}

export const objectScreenBox = (f: Frame, view: ViewId, e: SceneObject) =>
  screenBox(
    f,
    view,
    e.min,
    e.min.map((v, i) => v + e.size[i]),
  );

export function outlinePath(f: Frame, view: ViewId, e: SceneObject): string {
  const [a, b] = VIEWS[view].axes;
  return `${e.outlines[view]
    .map((p, i) => {
      const q = toScreen(f, e.min[a] + p[0] * e.size[a], e.min[b] + p[1] * e.size[b]);
      return `${i ? "L" : "M"}${q[0].toFixed(2)},${q[1].toFixed(2)}`;
    })
    .join("")}Z`;
}

export interface LabelBox {
  id: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Leader line from the label to the object's box, when they are apart. */
  leader: [Point, Point] | null;
  selected: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Place id labels around each object's box, avoiding each other and the reserved areas where possible. */
export function layoutLabels(
  f: Frame,
  view: ViewId,
  items: SceneObject[],
  selected: (id: string) => boolean,
  reserved: Rect[] = [],
): LabelBox[] {
  const [i0, i1] = VIEWS[view].axes;
  const sorted = [...items].sort((a, b) => {
    if (selected(a.id) !== selected(b.id)) return selected(a.id) ? -1 : 1;
    return a.size[i0] * a.size[i1] - b.size[i0] * b.size[i1];
  });
  const occupied: Rect[] = [...reserved];
  const out: LabelBox[] = [];
  const intersect = (a: Rect, b: Rect) =>
    a.x < b.x + b.w + 4 && a.x + a.w + 4 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y;
  for (const e of sorted) {
    const sb = objectScreenBox(f, view, e);
    if (sb.right < 0 || sb.left > f.W || sb.bottom < 0 || sb.top > f.H) continue;
    const w = e.id.length * 6.3 + 12;
    const h = 17;
    const cx = (sb.left + sb.right) / 2;
    const cy = (sb.top + sb.bottom) / 2;
    const candidates: Point[] = [
      [sb.left + 3, sb.top - 20],
      [sb.right - w - 3, sb.top - 20],
      [cx - w / 2, cy - h / 2],
      [sb.left + 3, sb.bottom + 4],
      [sb.right + 6, cy - h / 2],
      [sb.left - w - 6, cy - h / 2],
      [cx - w / 2, sb.top - 40],
      [cx - w / 2, sb.bottom + 22],
    ];
    let best: Rect | null = null;
    let bestScore = Infinity;
    candidates.forEach(([x0, y0], i) => {
      const x = Math.max(3, Math.min(f.W - w - 3, x0));
      const y = Math.max(3, Math.min(f.H - h - 48, y0));
      const r = { x, y, w, h };
      const score = occupied.filter((o) => intersect(r, o)).length * 100 + i;
      if (score < bestScore) {
        bestScore = score;
        best = r;
      }
    });
    if (!best) continue;
    const r = best as Rect;
    occupied.push(r);
    const lx = r.x + w / 2;
    const ly = r.y + h / 2;
    const nx = Math.max(sb.left, Math.min(sb.right, lx));
    const ny = Math.max(sb.top, Math.min(sb.bottom, ly));
    out.push({
      id: e.id,
      color: e.color,
      ...r,
      leader:
        Math.hypot(lx - nx, ly - ny) > 13
          ? [
              [lx, ly],
              [nx, ny],
            ]
          : null,
      selected: selected(e.id),
    });
  }
  return out;
}
