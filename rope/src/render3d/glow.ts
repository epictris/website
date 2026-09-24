// WAKING LIGHTS: the law a light with a `wake` distance follows, and how the
// small pool of real lights is handed out between the ones that are awake.
//
// Pure - no three.js in here - so `cli render3d` can step it without a GPU. The
// rig (`lights.ts`) owns the three side: the pool of point lights, the world
// positions, the materials whose emission follows the level.
//
// RENDER-SIDE and driven by the clock the rig is handed, exactly like flicker
// and the beams: the renderer reads the ball's position and writes nothing
// back, so no replay can diverge on it. See `LightObjectData.wake` and "Waking
// lights" in docs/lighting-and-surfaces.md.

import type { LightObjectData } from "../level/levelFormat";

// Seconds from dark to full, where the light authors no `wakeRise`.
export const DEFAULT_WAKE_RISE = 0.6;
// Seconds from full to dark once the ball has gone, where it authors no
// `wakeFall`. Slower than the rise: a light noticing you is an event, a light
// forgetting you is not.
export const DEFAULT_WAKE_FALL = 1.5;
// The release distance as a multiple of the trigger. The ball wakes a light
// within `wake` and lets it go only beyond `wake * WAKE_HYSTERESIS`, so a ball
// resting on the edge does not strobe it.
export const WAKE_HYSTERESIS = 1.15;
// The longest step, in seconds, a glow is advanced by. A tab that was in the
// background hands the next frame a clock seconds ahead, and unclamped that
// would snap every mushroom in the level to full (or dark) on the first frame
// back. A clock that runs BACKWARDS (a headless grab pinning it) steps nothing.
export const MAX_GLOW_STEP = 0.1;
// How many real point lights serve every waking light in a level, at most. The
// rig builds `min(GLOW_POOL, waking sources)` at `setLevel`, so a level with
// none is exactly the scene it was, and never removes one while the level is
// loaded: the light count is what three's lit programs are compiled against.
export const GLOW_POOL = 6;

export type GlowPhase = "dormant" | "armed" | "rising" | "lit" | "falling";

// One waking light's authored law, with every default applied. Metres and
// seconds.
export interface WakeParams {
  wake: number;
  delay: number;
  rise: number;
  fall: number;
}

// The law a light object authors, or null for a light that is always on
// (absent, zero or negative `wake`, and every spot: a waking light is
// point-only, and the editor clears `wake` when a light is turned into a spot).
export function wakeParams(data: LightObjectData): WakeParams | null {
  if (data.kind === "spot") return null;
  // A firefly swarm reads `wake` as where it notices the ball, and is never
  // dark (see `swarmParams`).
  if ((data.fireflies ?? 0) >= 1) return null;
  const wake = data.wake ?? 0;
  if (!(wake > 0)) return null;
  return {
    wake,
    delay: Math.max(0, data.wakeDelay ?? 0),
    rise: Math.max(0, data.wakeRise ?? DEFAULT_WAKE_RISE),
    fall: Math.max(0, data.wakeFall ?? DEFAULT_WAKE_FALL),
  };
}

export function isWaking(data: LightObjectData): boolean {
  return wakeParams(data) !== null;
}

// One waking light's life, stepped by the ball's distance to it and the time
// since the last step, answering a level in 0..1.
//
//   dormant  the ball is outside `wake`; level 0.
//   armed    the ball came within `wake` and the delay is running; level 0.
//            Leaving (beyond the hysteresis) cancels it with nothing emitted.
//   rising   linear toward 1 at 1/rise per second, from wherever it was.
//   lit      level 1 while the ball stays within the hysteresis.
//   falling  linear toward 0 at 1/fall per second. Coming back within `wake`
//            re-arms from the current level with NO delay: a mushroom half dark
//            does not wait to notice you came back.
export class GlowState {
  phase: GlowPhase = "dormant";
  level = 0;
  // Seconds the delay has run, while armed.
  private waited = 0;

  constructor(readonly params: WakeParams) {}

  step(distance: number, dt: number): number {
    const p = this.params;
    let t = dt > 0 ? Math.min(dt, MAX_GLOW_STEP) : 0;
    const inside = distance <= p.wake;
    const gone = distance > p.wake * WAKE_HYSTERESIS;

    // What the ball's position says, first.
    switch (this.phase) {
      case "dormant":
        if (inside) {
          this.phase = "armed";
          this.waited = 0;
        }
        break;
      case "armed":
        if (gone) {
          this.phase = "dormant";
          this.waited = 0;
        }
        break;
      case "rising":
      case "lit":
        if (gone) this.phase = "falling";
        break;
      case "falling":
        if (inside) this.phase = "rising";
        break;
    }

    // Then the time, spent across as many phases as it reaches. A zero-length
    // delay, rise or fall is passed through even on a step of no time, which is
    // what makes 0 mean instant rather than "one frame late".
    for (;;) {
      if (this.phase === "armed") {
        const need = p.delay - this.waited;
        if (need > t) {
          this.waited += t;
          break;
        }
        t -= Math.max(0, need);
        this.waited = 0;
        this.phase = "rising";
      } else if (this.phase === "rising") {
        if (p.rise <= 0) {
          this.level = 1;
          this.phase = "lit";
          continue;
        }
        const need = (1 - this.level) * p.rise;
        if (need > t) {
          this.level += t / p.rise;
          break;
        }
        t -= need;
        this.level = 1;
        this.phase = "lit";
      } else if (this.phase === "falling") {
        if (p.fall <= 0) {
          this.level = 0;
          this.phase = "dormant";
          break;
        }
        const need = this.level * p.fall;
        if (need > t) {
          this.level -= t / p.fall;
          break;
        }
        this.level = 0;
        this.phase = "dormant";
        break;
      } else {
        break;
      }
    }
    return this.level;
  }
}

// What the pool assignment reads of one source: how awake it is and where it is
// on the gameplay plane (metres, in whichever frame the focus is given in).
export interface PoolCandidate {
  level: number;
  x: number;
  y: number;
}

// Which sources the pool's `n` lights serve this frame, as indices into
// `sources`, nearest to `focus` first (the ball, or the editor's view centre).
// A source with level 0 never takes a light. Stable: equal distances keep
// authored order, so two mushrooms the same distance away do not swap lights
// between frames. Sources past `n` stay dark.
export function assignPool(
  sources: readonly PoolCandidate[],
  focus: { x: number; y: number },
  n: number,
): number[] {
  const awake: { i: number; d: number }[] = [];
  sources.forEach((s, i) => {
    if (s.level > 0) awake.push({ i, d: Math.hypot(s.x - focus.x, s.y - focus.y) });
  });
  // `Array.prototype.sort` is stable, and the index is the tie-break anyway so
  // the order does not rest on that.
  awake.sort((a, b) => a.d - b.d || a.i - b.i);
  return awake.slice(0, Math.max(0, n)).map((a) => a.i);
}

// How many pool lights a level with `waking` waking sources builds.
export function poolSizeFor(waking: number): number {
  return Math.max(0, Math.min(GLOW_POOL, waking));
}
