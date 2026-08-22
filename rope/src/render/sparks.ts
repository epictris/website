// Sparks - the shower a steel hook throws off hook-proof steel.
//
// Entirely render-side. The simulation contributes a per-frame list of contact
// facts (`level/sparkEvents.ts`) and this module owns everything else: the
// pool, the randomness, the thresholds, the physics and the drawing. Nothing
// here is ever read back by the sim, so a spark can never move a body and every
// recorded bundle replays bit-for-bit with the whole system running.
//
// Two behaviours, both driven from the one event shape by splitting the hook's
// velocity at the surface:
//
// - an IMPACT burst, sized by the speed the hook came IN at (the normal
//   component), fanned about the reflection;
// - a SLIDE stream, sized by how fast the hook is travelling ALONG the face
//   (the tangential component), trailing behind the contact the way a grinder
//   throws them. A hook resting against a surface has no tangential speed and
//   therefore throws nothing, which is what `SLIDE_MIN_SPEED` implements.
//
// Every threshold lives here rather than in the sim, so tuning has one home.
// Lengths and speeds are metres and m/s per the units rule; a fixed on-screen
// size is written as `<px> * PX`.

import { PX } from "../engine/units";
import type { SparkEvent } from "../level/sparkEvents";

// Below this approach speed a touch is a settle rather than a hit. The hook's
// own `probeContact` bounces a dangling tip off a wall repeatedly at near-zero
// speed, and those are the events this exists to throw away.
const IMPACT_MIN_SPEED = 1.0;
// Both scaled to 30% of what they first were (1.5 and 20), by eye: a full-speed
// throw into a hook-proof face threw a fistful of sparks that read as an
// explosion rather than as steel glancing off steel. Rate and cap move
// together, or the cap alone would decide every hit above ~13 m/s and the
// burst would stop growing with the throw.
const IMPACT_SPARKS_PER_MPS = 0.45;
const IMPACT_BURST_CAP = 6;
// Half-angle of the fan about the reflected direction.
const IMPACT_CONE = 0.9;
// Frames of NO reported contact after which the next touch is an arrival rather
// than a continuation of one. A burst is for an arrival only (see `arriving` in
// `ingest`); two is enough to bridge the single-frame gaps a speculative contact
// leaves while staying well under the flight time of any skip worth seeing as
// two strikes - 33 ms, in which a 10 m/s hook covers a third of a metre.
const CONTACT_GAP_FRAMES = 2;
// A burst particle's launch speed, as a fraction of the approach speed: a
// uniform draw in `[MIN, MIN + SPREAD]`, plus a share of the tangential speed
// so a glancing hit throws its sparks along the face as well as off it.
// All three are 70% of what they first were (0.15, 0.35, 0.2).
const IMPACT_SPEED_MIN = 0.105;
const IMPACT_SPEED_SPREAD = 0.245;
const IMPACT_TANGENT_SHARE = 0.14;
// A burst particle also lives half as long as a slide one. Reach is speed times
// lifetime, so the two knobs overlap and are NOT interchangeable: the speed sets
// how hard the sparks are thrown (and, since a streak is drawn from the
// velocity, how long each drawn streak is), the lifetime how far they get before
// they wink out. Tuned by eye as a pair - all speed reads as a puff, all
// lifetime as sparks that hang in the air.
const IMPACT_TTL_SCALE = 0.5;

// Below this along-surface speed the hook is not sliding, it is sitting there:
// a seated tip's solver jitter stays under it and a real drag is well over.
const SLIDE_MIN_SPEED = 0.3;
const SLIDE_SPARKS_PER_METRE = 30;
// Half-angle of the shallow scatter about the trailing direction.
const SLIDE_CONE = 0.35;
// How far off the surface the trailing cone is tilted, so a stream leaves the
// face rather than grinding along inside it.
const SLIDE_TILT = 0.25;

// The sim's fixed step, which is what one event's worth of sliding covers.
const SIM_STEP = 1 / 60;

// They read as heavy steel slivers rather than smoke, so they fall at g.
const SPARK_GRAVITY = 9.8;
// Exponential drag, per second. Light: enough to shorten the fastest streaks,
// not enough to make them float.
const SPARK_DRAG = 1.5;
const SPARK_TTL_MIN = 0.15;
const SPARK_TTL_MAX = 0.45;

// How much of a particle's own motion a streak spans. The streak is drawn from
// the particle back along its velocity, so this is a shutter time.
const STREAK_TIME = 0.02;
const STREAK_WIDTH = 0.6 * PX;

// Hot to cool, over the particle's life.
const SPARK_HOT = { r: 0xff, g: 0xf7, b: 0xd6 };
const SPARK_MID = { r: 0xf2, g: 0xa1, b: 0x3c };
const SPARK_COOL = { r: 0xb3, g: 0x50, b: 0x2a };
// How finely that ramp is sampled into the lookup below. The colour and the
// fade are both smooth functions of one number, so they are built once into a
// table rather than formatted per particle per frame - 256 `rgba(...)` strings
// a frame is the only allocation the draw would otherwise have. 24 steps over a
// life of at most 0.45 s is a step every 19 ms, well under a frame's worth.
const SPARK_RAMP_STEPS = 24;

// The pool's size, and with it the per-frame spawn ceiling: two coincident
// events (a probe bounce and a solver contact reporting the same touch) are
// absorbed here rather than by matching them up in the sim.
const MAX_SPARKS = 256;

// A fixed seed, so a screenshot of a given bundle frame is the same picture
// every run (see `shotMain.ts`, which advances at the sim's own step).
const PRNG_SEED = 0x5eed5a11;

export class SparkSystem {
  private readonly x = new Float32Array(MAX_SPARKS);
  private readonly y = new Float32Array(MAX_SPARKS);
  private readonly vx = new Float32Array(MAX_SPARKS);
  private readonly vy = new Float32Array(MAX_SPARKS);
  private readonly age = new Float32Array(MAX_SPARKS);
  private readonly ttl = new Float32Array(MAX_SPARKS);
  private live = 0;
  // The fractional spark a slow slide is owed this frame, carried to the next
  // so it sparks occasionally rather than never.
  private slideCarry = 0;
  private rngState = PRNG_SEED;
  // Sim steps since the last one that reported any contact at all, which is how
  // a strike is told from a slide (see `ingest`). Starts high so the first touch
  // of a level is an arrival.
  private quietSteps = Number.MAX_SAFE_INTEGER;

  // Turn one frame's sim events into particles. Called once per sim step, from
  // inside the catch-up loop, so a stall drops nothing.
  //
  // EVERY event is asked BOTH questions, and each answers on its own threshold.
  // Nothing here knows or cares which part of the sim reported the touch, and
  // that is the whole design rather than a simplification: a dangling tip
  // dragged along a wall is reported by `BallHook.bounce` on every frame - the
  // probe deflects it, over and over - with a normal component of 0.03 m/s and
  // a tangential one running up to 3.6, so a system that read those as "a
  // bounce, therefore a burst" produced nothing at all for the most obvious
  // slide in the game. The burst and the stream are properties of the velocity,
  // not of the call site.
  ingest(events: readonly SparkEvent[]): void {
    // A burst is for an ARRIVAL - the hook coming out of free flight into a
    // surface - and not for every frame that happens to report a normal
    // component. Once it is down and sliding, the wall's own shape supplies
    // those: a hook skimming a faceted hook-proof polygon crosses a seam between
    // two facets and the normal turns under it, so a velocity that was 0.14 m/s
    // into the old facet is 2.78 m/s into the new one with the hook having
    // neither gained speed nor left the surface (`session-127f` f102-f103, where
    // the velocity vector is identical across the seam and only the normal moves,
    // by 15.5 degrees). Read as a fresh strike, that fired a second burst
    // mid-slide.
    //
    // Whether the hook is arriving is itself collision information - it was not
    // touching anything, and now it is - so it stays on this side of the boundary
    // like every other threshold. The counter is per SYSTEM rather than per hook,
    // which is exact while at most one hook is in contact at a time (the ball's
    // chain has a single tip, and the grapple hook is destroyed by the surface
    // that would spark); two hooks grinding different walls at once would have
    // the second one's arrival read as the first one's continuation.
    const arriving = this.quietSteps > CONTACT_GAP_FRAMES;
    this.quietSteps = events.length > 0 ? 0 : this.quietSteps + 1;
    for (const e of events) {
      const nx = e.normal.x;
      const ny = e.normal.y;
      // Split the hook's velocity at the surface: `vn` is how fast it is
      // closing (positive into the face), `vt` how fast it is travelling along.
      const vDotN = e.vel.x * nx + e.vel.y * ny;
      const vn = -vDotN;
      const tx = e.vel.x - nx * vDotN;
      const ty = e.vel.y - ny * vDotN;
      const vt = Math.hypot(tx, ty);
      // A head-on hit is all burst, a drag all stream, and a glancing skip is
      // legitimately both.
      if (arriving) this.burst(e.point.x, e.point.y, nx, ny, vn, vt, tx, ty);
      this.stream(e.point.x, e.point.y, nx, ny, vt, tx, ty);
    }
  }

  // Advance the particles by `dt` seconds of RENDER time. The live game passes
  // its frame dt and `cli shot` passes the fixed step, which is what makes a
  // grab reproducible; the clamp keeps a backgrounded tab from teleporting
  // every spark off screen on the frame it comes back.
  advance(dt: number): void {
    const step = Math.min(dt, 0.1);
    if (step <= 0) return;
    const drag = Math.max(0, 1 - SPARK_DRAG * step);
    for (let i = 0; i < this.live; ) {
      const age = this.age[i]! + step;
      if (age >= this.ttl[i]!) {
        this.swapRemove(i);
        continue;
      }
      this.age[i] = age;
      const vx = this.vx[i]! * drag;
      const vy = (this.vy[i]! + SPARK_GRAVITY * step) * drag;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.x[i] = this.x[i]! + vx * step;
      this.y[i] = this.y[i]! + vy * step;
      i++;
    }
  }

  // Draw into a ctx already in world space (metres). Additive, so overlapping
  // streaks read as the brighter core of a shower.
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.live === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = STREAK_WIDTH;
    ctx.lineCap = "round";
    for (let i = 0; i < this.live; i++) {
      const px = this.x[i]!;
      const py = this.y[i]!;
      const t = this.age[i]! / this.ttl[i]!;
      ctx.strokeStyle = SPARK_RAMP[Math.min(SPARK_RAMP_STEPS - 1, (t * SPARK_RAMP_STEPS) | 0)]!;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - this.vx[i]! * STREAK_TIME, py - this.vy[i]! * STREAK_TIME);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Kill everything and reseed, so a restart does not carry the dead level's
  // embers and two runs of the same bundle draw the same sparks.
  reset(): void {
    this.live = 0;
    this.slideCarry = 0;
    this.quietSteps = Number.MAX_SAFE_INTEGER;
    this.rngState = PRNG_SEED;
  }

  // A burst off a hit, fanned about the reflection of the incoming velocity and
  // sized by how hard the hook came in.
  private burst(
    px: number,
    py: number,
    nx: number,
    ny: number,
    vn: number,
    vt: number,
    tx: number,
    ty: number,
  ): void {
    if (vn < IMPACT_MIN_SPEED) return;
    const count = Math.min(Math.round(vn * IMPACT_SPARKS_PER_MPS), IMPACT_BURST_CAP);
    // The reflection: the tangential half survives, the normal half turns
    // around. Normalised, since only its direction is wanted here.
    const rx = tx + nx * vn;
    const ry = ty + ny * vn;
    const rlen = Math.hypot(rx, ry);
    const dirx = rlen > 1e-9 ? rx / rlen : nx;
    const diry = rlen > 1e-9 ? ry / rlen : ny;
    for (let i = 0; i < count; i++) {
      const angle = (this.rand() * 2 - 1) * IMPACT_CONE;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const fx = dirx * cos - diry * sin;
      const fy = dirx * sin + diry * cos;
      // Biased away from the surface: a spark fanned back into the face would
      // spend its whole life inside the fill, so one that points inward is
      // mirrored back out.
      const into = fx * nx + fy * ny;
      const dx = into < 0 ? fx - 2 * nx * into : fx;
      const dy = into < 0 ? fy - 2 * ny * into : fy;
      const speed =
        (IMPACT_SPEED_MIN + this.rand() * IMPACT_SPEED_SPREAD) * vn + IMPACT_TANGENT_SHARE * vt;
      this.spawn(px, py, nx, ny, dx * speed, dy * speed, IMPACT_TTL_SCALE);
    }
  }

  // A stream off a slide, trailing the motion and sized by the distance slid.
  private stream(
    px: number,
    py: number,
    nx: number,
    ny: number,
    vt: number,
    tx: number,
    ty: number,
  ): void {
    if (vt < SLIDE_MIN_SPEED) return;
    const wanted = vt * SIM_STEP * SLIDE_SPARKS_PER_METRE + this.slideCarry;
    const count = Math.floor(wanted);
    this.slideCarry = wanted - count;
    if (count <= 0) return;
    // Behind the contact, tilted a little off the face.
    const backx = -tx / vt + nx * SLIDE_TILT;
    const backy = -ty / vt + ny * SLIDE_TILT;
    const blen = Math.hypot(backx, backy);
    const dirx = backx / blen;
    const diry = backy / blen;
    for (let i = 0; i < count; i++) {
      const angle = (this.rand() * 2 - 1) * SLIDE_CONE;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = dirx * cos - diry * sin;
      const dy = dirx * sin + diry * cos;
      const speed = (0.2 + this.rand() * 0.4) * vt;
      this.spawn(px, py, nx, ny, dx * speed, dy * speed, 1);
    }
  }

  // One particle, nudged off the surface by half the streak it will draw so it
  // never starts embedded in the fill it came off. `ttlScale` is how long this
  // one lives against the base range - 1 for a slide, `IMPACT_TTL_SCALE` for a
  // burst.
  private spawn(
    px: number,
    py: number,
    nx: number,
    ny: number,
    vx: number,
    vy: number,
    ttlScale: number,
  ): void {
    const i = this.claim();
    const nudge = 0.5 * Math.hypot(vx, vy) * STREAK_TIME;
    this.x[i] = px + nx * nudge;
    this.y[i] = py + ny * nudge;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.ttl[i] = (SPARK_TTL_MIN + this.rand() * (SPARK_TTL_MAX - SPARK_TTL_MIN)) * ttlScale;
  }

  // A free slot, or the oldest particle when the pool is full - the one with
  // least life left to lose.
  private claim(): number {
    if (this.live < MAX_SPARKS) return this.live++;
    let oldest = 0;
    let best = -1;
    for (let i = 0; i < MAX_SPARKS; i++) {
      const t = this.age[i]! / this.ttl[i]!;
      if (t > best) {
        best = t;
        oldest = i;
      }
    }
    return oldest;
  }

  private swapRemove(i: number): void {
    const last = --this.live;
    this.x[i] = this.x[last]!;
    this.y[i] = this.y[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.age[i] = this.age[last]!;
    this.ttl[i] = this.ttl[last]!;
  }

  // mulberry32. Seeded and owned here rather than `Math.random`, so the shot
  // tooling can diff two runs of the same frame (see `reset`).
  private rand(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) | 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// White-yellow through orange to ember, fading over the last half of life.
const SPARK_RAMP: string[] = Array.from({ length: SPARK_RAMP_STEPS }, (_, i) =>
  sparkColor((i + 0.5) / SPARK_RAMP_STEPS),
);

function sparkColor(t: number): string {
  const from = t < 0.5 ? SPARK_HOT : SPARK_MID;
  const to = t < 0.5 ? SPARK_MID : SPARK_COOL;
  const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const r = Math.round(from.r + (to.r - from.r) * k);
  const g = Math.round(from.g + (to.g - from.g) * k);
  const b = Math.round(from.b + (to.b - from.b) * k);
  const alpha = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
  return `rgba(${r},${g},${b},${alpha})`;
}
