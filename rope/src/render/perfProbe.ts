// What the renderer is actually costing, on the machine it is actually running
// on.
//
// It exists because a performance question was once answered with draw-call
// counts taken under SwiftShader at 2.87 seconds a frame - a proxy, and one that
// says nothing at all about whether the tuned constants that shipped alongside
// it hold up on real hardware. No FPS number was ever produced. `cli shot` is
// the wrong channel for that by construction: it has no GPU, and its whole point
// is a reproducible picture rather than a representative frame time.
//
// So this is read from the LIVE page: `window.__perf` for a scripted read (the
// claude-in-chrome workflow in CLAUDE.md), `?hud=1` for a human looking at the
// same numbers on screen.
//
// It is render-side only, allocated once, and touches no sim state, so it can
// never reach the fixed step.

import { PerfHistory, type MetricKey as HistoryMetric, type MetricStats } from "./perfHistory";

export type { MetricStats };

export interface PerfSnapshot {
  // Frames per second over the last window, from the frames actually drawn.
  fps: number;
  // The frame just drawn, in milliseconds. Every other figure here is a window
  // - which is what makes them readable - but a HUD also has to show the number
  // that is true RIGHT NOW, or a change made while watching it takes a second to
  // appear and reads as having done nothing.
  frameMs: number;
  // Frame time in milliseconds. p99 is the number that says whether the game
  // hitches; a mean hides exactly the frames worth knowing about.
  frameMsP50: number;
  frameMsP99: number;
  // Where the frame went: the fixed-step physics (all steps this frame), the
  // WebGL scene, the 2D overlay. What the three do not add up to is the loop's
  // own overhead - digests, sparks, camera. Zero until the caller passes
  // phases.
  simMsP50: number;
  simMsP99: number;
  draw3dMsP50: number;
  draw3dMsP99: number;
  draw2dMsP50: number;
  draw2dMsP99: number;
  // three's own counters for the last frame, or 0 on the 2D path - which has no
  // draw calls to speak of, and where the FPS half is the whole answer.
  drawCalls: number;
  triangles: number;
  programs: number;
  // What the machine is spending, beyond the frame time itself. The browser
  // exposes no process CPU or GPU utilisation, so each of these is the honest
  // proxy rather than a task-manager figure:
  //
  // - `cpuPct` is the MAIN THREAD's busy fraction: the milliseconds the frame
  //   callback occupied over the milliseconds of wall clock it covered. 100%
  //   means the loop is the frame; a low number with a high frame time means the
  //   wait is somewhere else (the GPU, the compositor, vsync).
  // - `gpuMs` is the GPU's own clock around the draw (see render/gpuTimer.ts),
  //   null on a context with no timer extension.
  // - `heapMb` is the JS heap in use (`performance.memory`, Chromium-only, and
  //   null elsewhere). It is JS objects only - textures, geometry and the
  //   drawing buffers are GPU memory and appear in no browser API at all.
  cpuPct: number;
  gpuMs: number | null;
  heapMb: number | null;
  heapLimitMb: number | null;
  // The same four readings aggregated over the last five seconds (see
  // render/perfHistory.ts), which is the window the HUD graphs. Rewritten in
  // place with the rest of the snapshot.
  w5: Record<HistoryMetric, MetricStats>;
}

// How often the snapshot is rewritten. Once a second: a number that changes
// every frame cannot be read off a screen, and a page being scripted wants a
// settled figure rather than one frame's noise.
const WINDOW_MS = 1000;
// Room for one window at any sane refresh rate (240 Hz for 4 s). A window that
// somehow overruns it drops its oldest samples rather than growing.
const MAX_SAMPLES = 960;
// The metrics carried into the snapshot's five-second fold, in the order the HUD
// draws them.
const W5_METRICS: readonly HistoryMetric[] = ["frameMs", "cpuPct", "gpuMs", "heapMb"];

export class PerfProbe {
  // ONE object, mutated in place: `window.__perf` is a live handle, and handing
  // out a fresh object every second would leave a script reading a stale one.
  readonly snapshot: PerfSnapshot = {
    fps: 0,
    frameMs: 0,
    frameMsP50: 0,
    frameMsP99: 0,
    simMsP50: 0,
    simMsP99: 0,
    draw3dMsP50: 0,
    draw3dMsP99: 0,
    draw2dMsP50: 0,
    draw2dMsP99: 0,
    drawCalls: 0,
    triangles: 0,
    programs: 0,
    cpuPct: 0,
    gpuMs: null,
    heapMb: null,
    heapLimitMb: null,
    w5: {
      frameMs: { avg: 0, min: 0, max: 0, samples: 0 },
      cpuPct: { avg: 0, min: 0, max: 0, samples: 0 },
      gpuMs: { avg: 0, min: 0, max: 0, samples: 0 },
      heapMb: { avg: 0, min: 0, max: 0, samples: 0 },
    },
  };

  // The last five seconds, bucketed, for the HUD's graphs and its five-second
  // aggregates (see render/perfHistory.ts). Written every frame; the snapshot's
  // `w5` is a fold of it taken on the snapshot's own cadence.
  readonly history = new PerfHistory();

  private readonly samples = new Float64Array(MAX_SAMPLES);
  private readonly simSamples = new Float64Array(MAX_SAMPLES);
  private readonly draw3dSamples = new Float64Array(MAX_SAMPLES);
  private readonly draw2dSamples = new Float64Array(MAX_SAMPLES);
  private count = 0;
  private windowMs = 0;

  // One rendered frame. `stats` is what the 3D renderer drew, or null on the 2D
  // path. `phases` is where the frame's ms went, from the caller's own clocks.
  sample(
    dtSeconds: number,
    stats: { calls: number; triangles: number; programs: number } | null,
    phases?: {
      simMs: number;
      draw3dMs: number;
      draw2dMs: number;
      // The whole frame callback's own wall time, the GPU's clock for the draw,
      // and the JS heap - see the snapshot's `cpuPct`/`gpuMs`/`heapMb`. Absent
      // from a caller that has no clock for them (`shotMain`), which leaves
      // those rows unavailable rather than zero.
      cpuMs?: number;
      gpuMs?: number | null;
      heapMb?: number | null;
      heapLimitMb?: number | null;
    },
  ): void {
    const ms = dtSeconds * 1000;
    if (ms > 0) {
      // The rolling five seconds is fed from every frame, independently of the
      // snapshot's own once-a-second cadence: the graph is what happened, and a
      // window that only advanced on the tick would be a graph of the ticks.
      const cpuPct = phases?.cpuMs !== undefined ? (phases.cpuMs / ms) * 100 : 0;
      this.history.push(
        performance.now(),
        ms,
        cpuPct,
        phases?.gpuMs ?? null,
        phases?.heapMb ?? null,
      );
      this.snapshot.frameMs = ms;
      this.snapshot.cpuPct = cpuPct;
      this.snapshot.gpuMs = phases?.gpuMs ?? null;
      this.snapshot.heapMb = phases?.heapMb ?? null;
      this.snapshot.heapLimitMb = phases?.heapLimitMb ?? null;

      if (this.count === MAX_SAMPLES) {
        this.samples.copyWithin(0, 1);
        this.simSamples.copyWithin(0, 1);
        this.draw3dSamples.copyWithin(0, 1);
        this.draw2dSamples.copyWithin(0, 1);
        this.count--;
      }
      this.samples[this.count] = ms;
      this.simSamples[this.count] = phases?.simMs ?? 0;
      this.draw3dSamples[this.count] = phases?.draw3dMs ?? 0;
      this.draw2dSamples[this.count] = phases?.draw2dMs ?? 0;
      this.count++;
      this.windowMs += ms;
    }
    if (this.windowMs < WINDOW_MS || this.count === 0) return;

    const p = (sorted: Float64Array, q: number): number =>
      sorted[Math.min(this.count - 1, Math.floor(this.count * q))]!;
    // `slice`, not `subarray`: each phase array must be sorted on a copy, or
    // the sort would shuffle samples out from under the shared frame index.
    const sorted = this.samples.slice(0, this.count).sort();
    const sortedSim = this.simSamples.slice(0, this.count).sort();
    const sorted3d = this.draw3dSamples.slice(0, this.count).sort();
    const sorted2d = this.draw2dSamples.slice(0, this.count).sort();
    this.snapshot.fps = (this.count * 1000) / this.windowMs;
    this.snapshot.frameMsP50 = p(sorted, 0.5);
    this.snapshot.frameMsP99 = p(sorted, 0.99);
    this.snapshot.simMsP50 = p(sortedSim, 0.5);
    this.snapshot.simMsP99 = p(sortedSim, 0.99);
    this.snapshot.draw3dMsP50 = p(sorted3d, 0.5);
    this.snapshot.draw3dMsP99 = p(sorted3d, 0.99);
    this.snapshot.draw2dMsP50 = p(sorted2d, 0.5);
    this.snapshot.draw2dMsP99 = p(sorted2d, 0.99);
    this.snapshot.drawCalls = stats?.calls ?? 0;
    this.snapshot.triangles = stats?.triangles ?? 0;
    this.snapshot.programs = stats?.programs ?? 0;
    // `stats()` hands back a reused object, so each fold is COPIED into the
    // snapshot's own - `window.__perf` is a live handle, and storing the scratch
    // would leave all four rows aliasing the last metric folded.
    for (const key of W5_METRICS) {
      const from = this.history.stats(key);
      const into = this.snapshot.w5[key];
      into.avg = from.avg;
      into.min = from.min;
      into.max = from.max;
      into.samples = from.samples;
    }
    this.count = 0;
    this.windowMs = 0;
  }

}
