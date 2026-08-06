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

export interface PerfSnapshot {
  // Frames per second over the last window, from the frames actually drawn.
  fps: number;
  // Frame time in milliseconds. p99 is the number that says whether the game
  // hitches; a mean hides exactly the frames worth knowing about.
  frameMsP50: number;
  frameMsP99: number;
  // three's own counters for the last frame, or 0 on the 2D path - which has no
  // draw calls to speak of, and where the FPS half is the whole answer.
  drawCalls: number;
  triangles: number;
  programs: number;
}

// How often the snapshot is rewritten. Once a second: a number that changes
// every frame cannot be read off a screen, and a page being scripted wants a
// settled figure rather than one frame's noise.
const WINDOW_MS = 1000;
// Room for one window at any sane refresh rate (240 Hz for 4 s). A window that
// somehow overruns it drops its oldest samples rather than growing.
const MAX_SAMPLES = 960;

export class PerfProbe {
  // ONE object, mutated in place: `window.__perf` is a live handle, and handing
  // out a fresh object every second would leave a script reading a stale one.
  readonly snapshot: PerfSnapshot = {
    fps: 0,
    frameMsP50: 0,
    frameMsP99: 0,
    drawCalls: 0,
    triangles: 0,
    programs: 0,
  };

  private readonly samples = new Float64Array(MAX_SAMPLES);
  private count = 0;
  private windowMs = 0;

  // One rendered frame. `stats` is what the 3D renderer drew, or null on the 2D
  // path.
  sample(dtSeconds: number, stats: { calls: number; triangles: number; programs: number } | null): void {
    const ms = dtSeconds * 1000;
    if (ms > 0) {
      if (this.count === MAX_SAMPLES) {
        this.samples.copyWithin(0, 1);
        this.count--;
      }
      this.samples[this.count++] = ms;
      this.windowMs += ms;
    }
    if (this.windowMs < WINDOW_MS || this.count === 0) return;

    const sorted = this.samples.subarray(0, this.count).sort();
    this.snapshot.fps = (this.count * 1000) / this.windowMs;
    this.snapshot.frameMsP50 = sorted[Math.floor(this.count * 0.5)]!;
    this.snapshot.frameMsP99 = sorted[Math.min(this.count - 1, Math.floor(this.count * 0.99))]!;
    this.snapshot.drawCalls = stats?.calls ?? 0;
    this.snapshot.triangles = stats?.triangles ?? 0;
    this.snapshot.programs = stats?.programs ?? 0;
    this.count = 0;
    this.windowMs = 0;
  }

  // The same numbers as text, for the on-screen HUD. Rebuilt only when the
  // snapshot is, so `?hud=1` costs a couple of strings a second.
  hudLines(): string[] {
    const s = this.snapshot;
    const lines = [`${s.frameMsP50.toFixed(1)}/${s.frameMsP99.toFixed(1)} ms p50/p99`];
    if (s.programs > 0) {
      lines.push(`${s.drawCalls} calls · ${(s.triangles / 1000).toFixed(0)}k tris · ${s.programs} programs`);
    }
    return lines;
  }
}
