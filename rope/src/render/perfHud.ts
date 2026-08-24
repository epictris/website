// The performance panel: what the frame cost, what it has been costing for the
// last five seconds, and the shape of that history.
//
// The FPS counter answers one question ("is it smooth") and hides the two that
// follow it: smooth compared to what, and which resource ran out. A number that
// updates once a second cannot show a hitch at all - the frame that stuttered is
// averaged into 59 that did not - so every row here carries its window's average
// AND its worst, over a graph of the window itself. A spike in the graph is the
// hitch a mean is designed to hide.
//
// It is drawn on the 2D overlay in screen space, after the frame, from readings
// the probe already had (see render/perfProbe.ts). Everything it allocates is
// allocated once: a panel that shows the cost of the frame must not be a
// meaningful part of it.

import type { PerfSnapshot } from "./perfProbe";
import { BUCKETS, HISTORY_MS, type MetricKey, type PerfHistory } from "./perfHistory";
import type { ViewTransform } from "./viewport";

// Panel geometry, in screen pixels of the fixed 16:9 frame (see viewport.ts).
const PAD = 8;
const WIDTH = 330;
const RIGHT_MARGIN = 8;
// Below the FPS counter the renderer draws at the same corner.
const TOP = 26;
const FONT = "12px monospace";
const LINE = 14;
const GRAPH_H = 28;
const ROW_GAP = 8;

const BG = "rgba(24, 28, 38, 0.86)";
const BORDER = "#313244";
const LABEL = "#8a93a3";
const DIM = "#5a6472";
const ACCENT = "#65bddb";
// Traffic light for the rows that have a budget. Green is inside the 60 Hz
// frame, amber is inside 30, red is neither.
const GOOD = "#7bd88f";
const WARN = "#f4a460";
const BAD = "#e06c75";

// The 60 Hz and 30 Hz budgets, drawn as reference lines on the time graphs. A
// frame-time graph with no budget on it is a squiggle; with them it is a
// verdict.
const BUDGET_60 = 1000 / 60;
const BUDGET_30 = 1000 / 30;

// Empty columns a trace is drawn straight through. Three is 300 ms: a game
// running slower than ten frames a second leaves gaps that wide and has not
// stopped, while anything wider is the page not running at all.
const MAX_BRIDGE = 3;

interface Row {
  key: MetricKey;
  label: string;
  // Value → the text shown for it. `bare` drops the unit, for the columns where
  // the row's own current reading has already stated it - "avg 6.9 max 12.4" is
  // the same claim as repeating "ms" three times across a panel this narrow, and
  // it is what stops the two halves of the line colliding.
  format: (value: number, bare?: boolean) => string;
  // The colour of the current reading. Null for a row with no budget to be
  // outside of (memory), which is drawn in the accent instead.
  verdict: ((value: number) => string) | null;
  // Reference lines, in the metric's own units.
  guides: readonly number[];
  // Zero-based graphs are the honest default. Memory is the exception: the
  // interesting thing about a heap is its SHAPE - flat, sawtooth or climbing -
  // and a 148 MB heap plotted from zero is a flat line whatever it does.
  zeroBased: boolean;
  // Scale to the 90th percentile of the window rather than to its worst column,
  // letting a rare spike run off the top. True for the timings, where one 250 ms
  // stall would otherwise flatten five seconds of 7 ms frames into the floor.
  // False for memory, whose peaks ARE the reading: a clipped sawtooth is a heap
  // whose collections have been cropped out of the picture.
  clipOutliers: boolean;
}

const msText = (v: number, bare = false): string => `${v.toFixed(1)}${bare ? "" : "ms"}`;
const timeVerdict = (v: number): string => (v <= BUDGET_60 ? GOOD : v <= BUDGET_30 ? WARN : BAD);

const ROWS: readonly Row[] = [
  {
    key: "frameMs",
    label: "frame",
    format: msText,
    verdict: timeVerdict,
    guides: [BUDGET_60, BUDGET_30],
    zeroBased: true,
    clipOutliers: true,
  },
  {
    key: "cpuPct",
    label: "cpu",
    format: (v, bare) => `${v.toFixed(0)}${bare ? "" : "%"}`,
    // Not a budget so much as headroom: a main thread over ~85% busy has none
    // left for the frame that costs more than average, which is where hitches
    // come from.
    verdict: (v) => (v <= 60 ? GOOD : v <= 85 ? WARN : BAD),
    guides: [100],
    zeroBased: true,
    clipOutliers: true,
  },
  {
    key: "gpuMs",
    label: "gpu",
    format: msText,
    verdict: timeVerdict,
    guides: [BUDGET_60],
    zeroBased: true,
    clipOutliers: true,
  },
  {
    key: "heapMb",
    label: "ram",
    format: (v, bare) => `${v.toFixed(0)}${bare ? "" : "MB"}`,
    verdict: null,
    guides: [],
    zeroBased: false,
    clipOutliers: false,
  },
];

// One graph's points, reused across frames and rows (each row is drawn to
// completion before the next is filled), plus the scratch the scale is sorted
// in. Nothing here is allocated per frame.
const mean = new Float64Array(BUCKETS);
const lo = new Float64Array(BUCKETS);
const hi = new Float64Array(BUCKETS);
const sortScratch = new Float64Array(BUCKETS);

// A quantile of the filled columns, gaps skipped. Zero when the window is empty,
// which the caller turns into a scale of its own.
function percentile(values: Float64Array, q: number): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isNaN(values[i]!)) sortScratch[n++] = values[i]!;
  }
  if (n === 0) return 0;
  const filled = sortScratch.subarray(0, n).sort();
  return filled[Math.min(n - 1, Math.floor(n * q))]!;
}

export function drawPerfHud(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  snap: PerfSnapshot,
  history: PerfHistory,
): void {
  const footer = footerLines(snap);
  // Every row carries its own trailing gap, which is what separates the last
  // graph from the footer; with no footer that gap is the panel's own padding
  // twice over, so it comes back off.
  const height =
    PAD * 2 +
    ROWS.length * (LINE + GRAPH_H + ROW_GAP) +
    footer.length * LINE -
    (footer.length > 0 ? 0 : ROW_GAP);
  const x = view.width - RIGHT_MARGIN - WIDTH;
  const innerW = WIDTH - PAD * 2;

  ctx.setTransform(view.scale, 0, 0, view.scale, view.originX, view.originY);
  ctx.save();
  ctx.font = FONT;
  ctx.textBaseline = "top";

  ctx.fillStyle = BG;
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.fillRect(x, TOP, WIDTH, height);
  ctx.strokeRect(x + 0.5, TOP + 0.5, WIDTH - 1, height - 1);

  let y = TOP + PAD;
  for (const row of ROWS) {
    const stats = history.stats(row.key);
    // A metric nothing has reported (no timer extension, no heap reading) says
    // so. Plotting it at zero would claim the GPU is free.
    const available = stats.samples > 0;
    const current = history.latest(row.key);
    const colour = !available ? DIM : row.verdict ? row.verdict(current ?? stats.avg) : ACCENT;

    ctx.textAlign = "left";
    ctx.fillStyle = LABEL;
    ctx.fillText(row.label, x + PAD, y);
    if (!available) {
      ctx.fillStyle = DIM;
      ctx.fillText("unavailable", x + PAD + 48, y);
      y += LINE + GRAPH_H + ROW_GAP;
      continue;
    }

    ctx.fillStyle = colour;
    ctx.fillText(row.format(current ?? stats.avg), x + PAD + 48, y);
    ctx.textAlign = "right";
    ctx.fillStyle = DIM;
    // The five-second aggregates: the average is the level, the worst is the
    // reason the level is not the whole story.
    ctx.fillText(
      `avg ${row.format(stats.avg, true)}  max ${row.format(stats.max, true)}`,
      x + WIDTH - PAD,
      y,
    );

    history.series(row.key, mean, lo, hi);
    drawGraph(ctx, row, colour, x + PAD, y + LINE, innerW, GRAPH_H, stats.min, stats.max);
    y += LINE + GRAPH_H + ROW_GAP;
  }

  // Where the frame actually went, and what it drew. Text only: these are
  // breakdowns rather than budgets, and four more graphs would make the panel
  // the thing being watched instead of the game.
  ctx.textAlign = "left";
  ctx.fillStyle = DIM;
  for (const line of footer) {
    ctx.fillText(line, x + PAD, y);
    y += LINE;
  }

  ctx.restore();
  ctx.textAlign = "left";
}

// The five-second graph for one metric: a band between the best and worst frame
// of each 100 ms, and the mean through it.
function drawGraph(
  ctx: CanvasRenderingContext2D,
  row: Row,
  colour: string,
  x: number,
  y: number,
  w: number,
  h: number,
  windowMin: number,
  windowMax: number,
): void {
  // The scale, from the window rather than from a constant, so a machine that is
  // nowhere near its budget still shows a readable trace. A budget line joins the
  // scale only while it is within reach of the data: a 2 ms GPU trace flattened
  // against a 16.7 ms ceiling says nothing about the 2 ms.
  //
  // It is the 90th percentile of the columns rather than the worst of them,
  // because a single stall - a page load, an alt-tab, a screenshot - is 250 ms
  // against a 7 ms frame, and scaling to it flattens the whole five seconds into
  // a line along the floor for as long as it stays in the window. A spike past
  // the top is clipped and reads as running off the graph, which is what it is
  // doing; the exact worst is the `max` on the row above, where a number belongs.
  const ceiling = row.clipOutliers ? percentile(hi, 0.9) : windowMax;
  let top = Math.max(ceiling, ...row.guides.filter((g) => g <= ceiling * 2.5));
  let bottom = row.zeroBased ? 0 : windowMin;
  if (!(top > bottom)) top = bottom + 1;
  // Headroom, so the worst frame is a peak inside the graph rather than a
  // clipped flat line along its top edge.
  top += (top - bottom) * 0.12;
  if (!row.zeroBased) bottom -= (top - bottom) * 0.08;

  const plot = (value: number): number => y + h - ((value - bottom) / (top - bottom)) * h;
  const at = (i: number): number => x + (i / (BUCKETS - 1)) * w;

  // The window's runs of columns: [from, to] pairs, where a gap of up to
  // MAX_BRIDGE empty columns stays inside a run (see the trace below).
  const forEachRun = (draw: (from: number, to: number) => void): void => {
    let from = -1;
    let last = -1;
    for (let k = 0; k < BUCKETS; k++) {
      if (Number.isNaN(mean[k]!)) continue;
      if (from < 0) {
        from = k;
      } else if (k - last > MAX_BRIDGE + 1) {
        draw(from, last);
        from = k;
      }
      last = k;
    }
    if (from >= 0) draw(from, last);
  };

  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.fillRect(x, y, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // Budget lines under the trace: they are the graph's grid, not its subject.
  ctx.strokeStyle = BORDER;
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1;
  for (const guide of row.guides) {
    if (guide <= bottom || guide >= top) continue;
    const gy = Math.round(plot(guide)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // The min/max band, then the mean through it. Both are drawn over RUNS of
  // columns rather than over the array, because a column can be empty two very
  // different ways.
  //
  // A game at 8 fps puts a frame in roughly every other 100 ms, so half its
  // columns are empty while nothing at all has stopped - and a trace broken at
  // every one of them is 25 invisible one-point segments, which is exactly what
  // the first version of this drew: a page loading at 124 ms a frame showed four
  // completely blank graphs, at the one moment the numbers mattered most.
  // Genuinely stopped (an alt-tab, a breakpoint) is a gap of many columns, and
  // bridging THAT would draw history that did not happen.
  //
  // So a short gap is bridged and a long one breaks the trace, and a run of one
  // column is drawn as a mark rather than as a zero-length line.
  ctx.fillStyle = withAlpha(colour, 0.22);
  forEachRun((from, to) => {
    if (from === to) return; // no area in a single column; the mean's mark says it
    ctx.beginPath();
    for (let k = from; k <= to; k++) if (!Number.isNaN(hi[k]!)) ctx.lineTo(at(k), plot(hi[k]!));
    for (let k = to; k >= from; k--) if (!Number.isNaN(lo[k]!)) ctx.lineTo(at(k), plot(lo[k]!));
    ctx.closePath();
    ctx.fill();
  });

  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1.5;
  forEachRun((from, to) => {
    if (from === to) {
      ctx.fillRect(at(from) - 1, plot(mean[from]!) - 1, 2, 2);
      return;
    }
    ctx.beginPath();
    let drawing = false;
    for (let k = from; k <= to; k++) {
      if (Number.isNaN(mean[k]!)) continue;
      const px = at(k);
      const py = plot(mean[k]!);
      if (drawing) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      drawing = true;
    }
    ctx.stroke();
  });
  ctx.restore();

  // The axis, on the graph rather than beside it: the top of the scale, and how
  // far back the left edge is. Both sit on the left, over the oldest columns -
  // the newest end of the trace is the half being read, and a label is not
  // allowed to sit on it.
  ctx.font = "10px monospace";
  ctx.fillStyle = DIM;
  ctx.textAlign = "left";
  ctx.fillText(row.format(top), x + 3, y + 2);
  ctx.fillText(`-${(HISTORY_MS / 1000).toFixed(0)}s`, x + 3, y + h - 11);
  ctx.font = FONT;
}

// The frame's own breakdown, from the once-a-second snapshot. Empty entries are
// dropped rather than shown as zeros: the 2D path has no draw calls, and a
// caller that passes no phase clocks has no breakdown.
function footerLines(snap: PerfSnapshot): string[] {
  const lines: string[] = [];
  if (snap.simMsP50 > 0 || snap.draw3dMsP50 > 0 || snap.draw2dMsP50 > 0) {
    lines.push(
      `sim ${snap.simMsP50.toFixed(1)} · 3d ${snap.draw3dMsP50.toFixed(1)} · 2d ${snap.draw2dMsP50.toFixed(1)} p50`,
    );
  }
  if (snap.programs > 0) {
    lines.push(
      `${snap.drawCalls} calls · ${(snap.triangles / 1000).toFixed(0)}k tris · ${snap.programs} progs`,
    );
  }
  return lines;
}

// The row colours are hex literals above, so this is a hex-only conversion by
// construction.
function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
