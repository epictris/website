// The shared scale of the orthographic pictures: every view drawn at one
// pixels-per-metre over the same world box (the scene frame and every visible
// object, plus a margin), so views that share an axis cover the same range of
// it at the same size. Front and top share x, top and side share y, front and
// side share z: a picture of one view lines up with the others pixel for pixel,
// and a picture made from it can go back in as that view's reference with the
// same placement.

import type { Box } from "./camera";
import { sceneBounds } from "./model";
import type { EditorState, Point, ViewId } from "./types";
import { axisNames, VIEW_IDS, VIEWS } from "./views";

/** Room kept around the scene in every picture, for labels and the scale bar. */
export const MARGIN_PX = 48;
export const MAX_IMAGE_PX = 4096;

/** What one orthographic picture shows. */
export interface ViewWindow {
  /** Lower-left corner and size of the pictured area on the view plane, metres, in the view's (horizontal, vertical) axes. */
  min: Point;
  size: Point;
  /** Picture size in pixels. */
  width: number;
  height: number;
}

export interface Projection {
  pixelsPerMeter: number;
  views: Record<ViewId, ViewWindow>;
}

/**
 * The largest round scale at or below n: 1, 2, 2.5, 4, 5 or 8 x 10^k pixels
 * per metre, so a pixel is a round length too (1, 0.5, 0.4, 0.25, 0.2 or
 * 0.125 x 10^-k m), losing at most 37.5% of the resolution n allows.
 */
export function roundScale(n: number): number {
  const p = 10 ** Math.floor(Math.log10(n));
  const r = n / p;
  return ([8, 5, 4, 2.5, 2].find((step) => r >= step) ?? 1) * p;
}

/** The world box every orthographic picture covers (before the margin). */
export const pictureBox = (s: EditorState): Box => sceneBounds(s);

/** The largest round scale at which every view fits in width x height pixels, margins included. */
export function fittingScale(s: EditorState, width: number, height: number): number {
  const b = pictureBox(s);
  let fit = Infinity;
  for (const view of VIEW_IDS) {
    const [a, v] = VIEWS[view].axes;
    fit = Math.min(
      fit,
      (width - 2 * MARGIN_PX) / Math.max(b.max[a] - b.min[a], 1e-6),
      (height - 2 * MARGIN_PX) / Math.max(b.max[v] - b.min[v], 1e-6),
    );
  }
  return roundScale(fit);
}

/**
 * Every orthographic view's picture at one scale: `pixelsPerMeter` when given,
 * otherwise the largest round scale at which all three fit in width x height
 * (default 1200 x 900). Each picture is as large as its view needs, centred on
 * the scene. Returns a message instead when a picture would exceed 4096 px.
 */
export function projection(
  s: EditorState,
  opts: { pixelsPerMeter?: number; width?: number; height?: number } = {},
): Projection | string {
  const ppm = opts.pixelsPerMeter ?? fittingScale(s, opts.width ?? 1200, opts.height ?? 900);
  const b = pictureBox(s);
  const pixels = (axis: number) => Math.ceil((b.max[axis] - b.min[axis]) * ppm + 2 * MARGIN_PX);
  const largest = Math.max(...[0, 1, 2].map(pixels));
  if (!(largest <= MAX_IMAGE_PX)) {
    const most = Math.min(...[0, 1, 2].map((a) => (MAX_IMAGE_PX - 2 * MARGIN_PX) / (b.max[a] - b.min[a])));
    return `At ${ppm} px/m a picture would be ${largest} px across; the most is ${MAX_IMAGE_PX}. This scene fits at up to ${roundScale(most)} px/m.`;
  }
  // Per axis, the pictured range: the box grown to whole pixels, centred.
  const range = [0, 1, 2].map((axis) => {
    const size = pixels(axis) / ppm;
    return { min: (b.min[axis] + b.max[axis]) / 2 - size / 2, size, px: pixels(axis) };
  });
  const views = {} as Record<ViewId, ViewWindow>;
  for (const view of VIEW_IDS) {
    const [a, v] = VIEWS[view].axes;
    views[view] = {
      min: [range[a].min, range[v].min],
      size: [range[a].size, range[v].size],
      width: range[a].px,
      height: range[v].px,
    };
  }
  return { pixelsPerMeter: ppm, views };
}

/** Where each picture sits, in the document's vocabulary: min and size named by the view's axes, as set_reference takes them. */
export function placements(p: Projection, views: readonly ViewId[] = VIEW_IDS) {
  const tidy = (v: number) => Math.round(v * 1e9) / 1e9;
  const named = (view: ViewId, q: Point) => {
    const [a, b] = axisNames(view);
    return { [a]: tidy(q[0]), [b]: tidy(q[1]) };
  };
  return Object.fromEntries(
    views.map((view) => {
      const w = p.views[view];
      return [view, { min: named(view, w.min), size: named(view, w.size), width: w.width, height: w.height }];
    }),
  );
}
