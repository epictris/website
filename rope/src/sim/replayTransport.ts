// The replay transport: play/pause, speed, and seeking inside a recorded
// session (`?replay=`, driven by main.ts and drawn by render/replayHud.ts).
//
// **Seeking is re-simulation, not rewinding.** The sim has no reverse step and
// no state snapshot, so the only way to be at frame N is to have stepped N
// times from a build - which is exactly what every headless command already
// does (`cli render --frame N` re-simulates to it), so the frame the transport
// lands on is bit-identical to the one the tools describe and to the one the
// recording played. Nothing here touches the sim's inputs: the recorded frames
// are fed in the recorded order whatever the transport is doing, and speed,
// pausing and seeking only decide WHEN a step runs.
//
// That makes the two directions cost very different things. Forward is free -
// keep stepping - and backward costs every frame between a build and the
// target. A build is not only frame 0: a run that ended in a reset (a jump
// press, a kill zone) built a fresh level, and the recording replays that build
// exactly, so the transport remembers where each run began and a seek inside
// the last run never pays for the runs before it.
//
// Backward seeks are therefore paid off across rendered frames under a budget
// rather than in one blocking burst (see `seekBudgetMs`): a 2500-frame bundle
// re-simulates in about a second, and a second of frozen page with no progress
// on screen is indistinguishable from a hang.

import type { FrameInput } from "../input/frameInput";

// The step the transport counts in. The same fixed 1/60 the sim runs at - a
// transport that scaled `delta` instead of the rate of steps would be feeding
// the sim a step size no recording was made at.
const STEP = 1 / 60;

// The live loop's catch-up allowance (see main.ts's MAX_STEPS_PER_FRAME), which
// the transport spends the same way: as the headroom above the rate being asked
// for, past which the debt is shed rather than banked.
const MAX_STEPS_PER_FRAME = 5;

// Selectable playback rates, slowest first. 1 is the recorded rate; below it
// the renderer interpolates between steps (see `alpha`), above it the loop
// takes several steps per rendered frame.
export const REPLAY_SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16] as const;

// How long one rendered frame may spend paying off a seek. 24 ms keeps the page
// answering the pointer (a drag on the scrub bar has to track it) while still
// clearing ~55 steps a frame, so a 2500-frame rewind lands in well under a
// second and shows the frames it passes through while it does.
const SEEK_BUDGET_MS = 24;

// What the transport drives. The level, the scene and the recording all live in
// main.ts; this is the whole of what it needs from them.
export interface ReplayHost {
  // Build the level afresh, exactly as the recorded page built it at the start
  // of a run, and make it current. Called only when a seek has to go backwards.
  rebuild(): void;
  // Step the current level on one recorded input. `seeking` is true while a
  // seek is being paid off: the step is real and the sim sees what it saw the
  // first time, but the frame is being passed THROUGH rather than watched, so
  // the host feeds nothing render-side from it.
  step(input: FrameInput, seeking: boolean): void;
  // A seek has landed. The host puts back what it held off during it - the
  // scene, the camera, the particles.
  seekEnded(): void;
}

export class ReplayTransport {
  // The frame of the recording now on screen: how many recorded inputs have
  // been stepped. `frames.length` is the end, where the last input repeats for
  // ever and the counter stops - the recording has run out, the world has not,
  // and holding the final input is what lets a pose settle for a reading.
  index = 0;
  paused = false;
  private speedIndex: number = REPLAY_SPEEDS.indexOf(1);
  // Where a seek is headed, or null when the transport is simply playing.
  target: number | null = null;
  // Per-frame seek budget, in milliseconds. A field so a test can hand the
  // whole seek to one pump (`Infinity`) rather than timing its own.
  seekBudgetMs: number = SEEK_BUDGET_MS;

  // Sub-step remainder, carried for render interpolation exactly as the live
  // loop carries its accumulator: without it, 0.25x speed would show each
  // physics step four times instead of interpolating across them.
  private accumulator = 0;
  // Where each run in the recording begins: frame 0, and every frame after a
  // reset the transport has stepped through. Discovered rather than declared -
  // a bundle carries a flat frame list and says nothing about its runs - so it
  // only ever holds boundaries that have actually been replayed, which is
  // precisely the set a backward seek is allowed to trust.
  readonly runStarts: number[] = [0];
  private resetDuringStep = false;

  constructor(
    readonly frames: readonly FrameInput[],
    private readonly host: ReplayHost,
  ) {}

  get speed(): number {
    return REPLAY_SPEEDS[this.speedIndex]!;
  }

  get seeking(): boolean {
    return this.target !== null;
  }

  // Whether the recording has run out and the final input is being held.
  get atEnd(): boolean {
    return this.index >= this.frames.length;
  }

  // How far past the last completed step this rendered frame lands, for the
  // renderer's interpolation. Frozen while paused, which is what keeps a paused
  // picture still rather than snapping it to the last step.
  get alpha(): number {
    return Math.min(1, this.accumulator / STEP);
  }

  // The sim reset itself during the step being run (a jump press or a kill
  // zone). Called by the host from the same call stack as `step`, because the
  // reset is the host rebuilding the level underneath it.
  noteReset(): void {
    this.resetDuringStep = true;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  // Step through the speed table. Clamped at both ends rather than wrapping: a
  // key held at the top should sit at 16x, not drop back to 0.1x.
  nudgeSpeed(direction: number): void {
    const next = this.speedIndex + Math.sign(direction);
    this.speedIndex = Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, next));
  }

  // Seek to a recorded frame, clamped to the recording. A seek that is already
  // where it is going still goes through `pumpSeek`, so the host gets its
  // `seekEnded` and the picture is put back together the same way every time.
  seek(frame: number): void {
    this.target = Math.max(0, Math.min(this.frames.length, Math.round(frame)));
  }

  // Seek relative to where the transport is HEADED rather than to where it is,
  // so tapping a seek key twice moves twice as far instead of the second tap
  // landing where the first one started from.
  seekBy(frames: number): void {
    this.seek((this.target ?? this.index) + frames);
  }

  // Frame-by-frame stepping, which is a pause and a one-frame seek: a single
  // frame is the unit the tools and the digests speak in, and stepping into one
  // while still playing would immediately leave it.
  stepFrames(frames: number): void {
    this.paused = true;
    this.seekBy(frames);
  }

  // Advance the replay by one rendered frame's worth of wall time.
  pump(dt: number): void {
    if (this.target !== null) {
      this.pumpSeek();
      return;
    }
    if (this.paused) return;
    this.accumulator += dt * this.speed;
    // One step per 1/60 of scaled time, capped so a stalled tab (or a speed the
    // machine cannot hold) sheds the debt rather than banking it - the same
    // trade the live loop makes, for the same reason. The cap is the speed's own
    // steps plus the live loop's catch-up allowance on top, so 4x still reaches
    // 4x on a display running at 30 Hz (eight steps a frame) and only a machine
    // further behind than that plays slower than it was asked to.
    const cap = Math.ceil(this.speed) + MAX_STEPS_PER_FRAME;
    let steps = 0;
    while (this.accumulator >= STEP && steps < cap) {
      this.stepOne(false);
      this.accumulator -= STEP;
      steps++;
    }
    if (this.accumulator >= STEP) this.accumulator %= STEP;
  }

  // One rendered frame's share of a seek. A backward target rebuilds first, at
  // the start of the run that contains it; from there, and for every forward
  // target, a seek is plain stepping under the budget.
  private pumpSeek(): void {
    const target = this.target!;
    if (target < this.index) {
      this.index = this.runStartAtOrBefore(target);
      this.host.rebuild();
    }
    const t0 = performance.now();
    while (this.index < target) {
      this.stepOne(true);
      if (performance.now() - t0 >= this.seekBudgetMs) break;
    }
    if (this.index >= target) {
      this.target = null;
      // The landing is a completed step, not a fraction past one.
      this.accumulator = 0;
      this.host.seekEnded();
    }
  }

  // The latest run boundary at or before `frame`. Frame 0 is always one, so
  // this always answers.
  private runStartAtOrBefore(frame: number): number {
    let start = 0;
    for (const s of this.runStarts) {
      if (s <= frame && s > start) start = s;
    }
    return start;
  }

  private stepOne(seeking: boolean): void {
    const input = this.frames[Math.min(this.index, this.frames.length - 1)]!;
    this.resetDuringStep = false;
    this.host.step(input, seeking);
    // Past the end the counter stands still: the input repeats, and a frame
    // number beyond the recording would be a claim about a frame nobody
    // recorded.
    if (this.index < this.frames.length) this.index++;
    if (this.resetDuringStep) {
      // The frame that reset the level belongs to the run that just ended; the
      // fresh level's first frame is the next one (see main.ts's loop, which
      // records the same boundary the same way).
      if (!this.runStarts.includes(this.index)) {
        this.runStarts.push(this.index);
        this.runStarts.sort((a, b) => a - b);
      }
      this.resetDuringStep = false;
    }
  }
}

// The keyboard, as one place rather than as a switch buried in main.ts's
// listener. Returns whether the key was the transport's, so the page can leave
// everything else alone.
//
// Borrowed wholesale from video players (mpv, and every browser's own): space
// for play/pause, arrows to seek, `,`/`.` for a single frame, brackets for
// speed. A replay is a video with a simulation behind it, and the hands that
// watch one already know these.
export function handleReplayKey(t: ReplayTransport, e: KeyboardEvent): boolean {
  // A second of recording, and the coarse jump a shifted arrow makes.
  const SECOND = 60;
  const LEAP = 10 * SECOND;
  switch (e.code) {
    case "Space":
      t.togglePause();
      return true;
    case "ArrowLeft":
      t.seekBy(e.shiftKey ? -LEAP : -SECOND);
      return true;
    case "ArrowRight":
      t.seekBy(e.shiftKey ? LEAP : SECOND);
      return true;
    case "Comma":
      t.stepFrames(-1);
      return true;
    case "Period":
      t.stepFrames(1);
      return true;
    case "BracketLeft":
      t.nudgeSpeed(-1);
      return true;
    case "BracketRight":
      t.nudgeSpeed(1);
      return true;
    case "Home":
      t.seek(0);
      return true;
    case "End":
      t.seek(t.frames.length);
      return true;
    default:
      return false;
  }
}
