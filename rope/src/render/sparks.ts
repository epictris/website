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
// - an IMPACT burst, fired once when the hook ARRIVES and sized by the speed it
//   arrived at, fanned about the reflection;
// - a SLIDE stream, sized by how fast the hook is travelling ALONG the face
//   (the tangential component) and thrown the way a grinder throws them: ALONG
//   the slide at a fraction of its speed, so the shower falls behind the hook
//   without any spark in it moving backwards (see `slideSparkDirection`). A
//   hook resting against a surface has no tangential speed and therefore throws
//   nothing, which is what `SLIDE_MIN_SPEED` implements.
//
// Every threshold lives here rather than in the sim, so tuning has one home.
// Lengths and speeds are metres and m/s per the units rule; a fixed on-screen
// size is written as `<px> * PX`.

import { PX } from "../engine/units";
import type { SparkEvent } from "../level/sparkEvents";

// Below this ARRIVAL speed a touch is a settle rather than a hit. The hook's
// own `probeContact` bounces a dangling tip off a wall repeatedly at near-zero
// speed, and those are the events this exists to throw away.
//
// Asked of the whole velocity rather than of its normal component, because a
// strike is a strike however oblique it was. A hook thrown flat down a floor
// arrives almost entirely tangentially - `session-117f` f74 is 11.55 m/s along
// the face against 0.04 m/s into it - and a threshold on the normal component
// scored that as no arrival at all, so the one burst a first contact is owed
// never fired and the whole shower was drag. The settle case this rejects is
// slow in EVERY direction, so it is rejected just as firmly by the speed.
const IMPACT_MIN_SPEED = 1.0;
// Both scaled to 21% of what they first were (1.5 and 20), by eye, in two
// passes: to 30% because a full-speed throw into a hook-proof face threw a
// fistful of sparks that read as an explosion rather than as steel glancing off
// steel, and to 70% of that again once the burst stopped being the whole of
// what a glancing hit produced (see IMPACT_MIN_SPEED - before it, an oblique
// arrival earned no burst at all and the burst was carrying every strike the
// player saw).
//
// Rate and cap move TOGETHER, or the cap alone would decide every hit above
// ~13 m/s and the burst would stop growing with the throw. The cap is an
// integer because the count is one, and 4 is what keeps the crossover where it
// was: the pair binds at 12.7 m/s against 13.3 before.
//
// The granularity is coarse at these counts and that is the honest cost of a
// small burst - a 12 m/s throw (the hook's own speed) goes from 5 particles to
// 4, which is 80% rather than 70%, while a hit at the cap goes from 6 to 4.
const IMPACT_SPARKS_PER_MPS = 0.315;
const IMPACT_BURST_CAP = 4;
// Half-angle of the fan about the reflected direction.
const IMPACT_CONE = 0.9;
// Frames of NO reported contact after which the next touch is an arrival rather
// than a continuation of one. A burst is for an arrival only (see `arriving` in
// `ingest`).
//
// The sim reports a continuous touch on every frame of it now (see
// `BallLevel.reportSpark` and the note on the impulse filter in
// `collectContactSparks`), so this no longer has a ragged supply to bridge and
// is margin rather than the mechanism. Two frames stays well under the flight
// time of any skip worth seeing as two strikes - 33 ms, in which a 10 m/s hook
// covers a third of a metre.
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
// Chips per metre of face ground, once the contact has settled into a grind.
// What a brief STRIKE gets is a fraction of it, ramped in - see
// SLIDE_RAMP_STEPS, which is what separates the two.
const SLIDE_SPARKS_PER_METRE = 30;
// Frames of unbroken contact over which the stream fades in from nothing to the
// full rate above. It is what makes a STRIKE a burst and a DRAG a stream, and
// the two need separating because the rate is per METRE and a glancing strike
// covers a lot of them in the three frames it lasts: at a flat rate a 51 degree
// hit threw four times the shower of a square one off the same throw, and
// cutting the rate to close that gap took the long grind down with it. A ramp
// closes it without touching either end - the burst is untouched, and a contact
// that goes on sliding still reaches the full per-metre rate.
//
// The fade is not arbitrary: the burst is ALREADY the material thrown off at
// the strike, so a stream at full rate over those same frames is the arrival
// counted twice, and the span to fade over is therefore the burst's own life. A
// burst particle lives `(SPARK_TTL_MIN + rand * (MAX - MIN)) * IMPACT_TTL_SCALE`
// - 4.5 frames at the shortest, 9 on average, 13.5 at the longest - so the
// stream comes up as the burst dies rather than alongside it.
//
// 8 within that range is where the pair in `session-156f` lands at the 1.5x it
// was tuned to: 6 particles for the 51 degree strike against 4 for the 5 degree
// one, on both of its angled throws. Longer ramps quiet the strike further and
// the drag with it (10 gives 1.25x on the shorter throw, 14 gives 1.25x on
// both); shorter ones give the strike its full grinder's rate back.
export const SLIDE_RAMP_STEPS = 8;
// Half-angle of the shallow scatter about the sliding direction.
const SLIDE_CONE = 0.35;
// A slide particle's launch speed, as a fraction of the sliding speed: a
// uniform draw in `[MIN, MIN + SPREAD]`. Both are fractions of a real velocity
// rather than free constants, so the sum must stay under 1 (see the note where
// they are spent).
const SLIDE_SPEED_MIN = 0.2;
const SLIDE_SPEED_SPREAD = 0.4;
// How far off the surface the cone is tilted, so a stream leaves the face
// rather than grinding along inside it.
const SLIDE_TILT = 0.25;

// Which way a slide throws its sparks: ALONG the hook's travel over the face,
// tilted `SLIDE_TILT` out of it. `tx`/`ty` is the hook's velocity in the plane
// of the surface and `vt` its length.
//
// Along and not against, which is the whole of what this exists to state. A
// spark is a chip sheared off the steel and carried away by whatever sheared
// it, so it leaves at a fraction of the sliding speed IN THE SLIDING
// DIRECTION - which is why an angle grinder throws its fan the way the rim is
// travelling at the contact, and why a car scraping the road throws sparks that
// are moving forwards even though they fall behind the car. Nothing at the
// contact can push a chip backwards; a spark that recedes is one the hook has
// outrun, and the launch speeds below are under 1 for exactly that reason.
//
// It read as backwards for a while because "trailing the hook" and "moving
// backwards" are the same picture in the HOOK's frame and opposite ones in the
// world, and this is drawn in the world. Sparks streaming out of the leading
// edge of a hook is what that looks like.
//
// Exported and pure because it is the one claim about the shower that a number
// can be put on (`cli contacts` `hook-sparks`); everything else about how a
// spark looks is a matter for eyes and a screenshot.
export function slideSparkDirection(
  nx: number,
  ny: number,
  tx: number,
  ty: number,
  vt: number,
): { x: number; y: number } {
  const ax = tx / vt + nx * SLIDE_TILT;
  const ay = ty / vt + ny * SLIDE_TILT;
  const len = Math.hypot(ax, ay);
  return { x: ax / len, y: ay / len };
}

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

// The pool's size, and with it the per-frame spawn ceiling.
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
  // Sim steps of UNBROKEN contact, counted from the arrival. It is what tells a
  // strike from a grind, and the stream's rate is ramped in over the first
  // `SLIDE_RAMP_STEPS` of it.
  private contactSteps = 0;
  // Impact bursts fired, and slide particles spawned, since the last `reset`.
  // Nothing here reads either and the draw does not either: they exist so the
  // shower is OBSERVABLE, which is what `cli contacts` `hook-sparks` counts.
  // Sparks reach no digest and no invariant, so without them the difference
  // between "a head-on hit throws a shower" and "it throws nothing at all", or
  // between a drag that grinds and one that trickles, is a thing only a person
  // looking at the game can see.
  bursts = 0;
  slideParticles = 0;

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
    if (arriving) this.contactSteps = 0;
    this.quietSteps = events.length > 0 ? 0 : this.quietSteps + 1;
    if (events.length > 0) this.contactSteps++;
    // How far this contact has settled into a grind, 0 at the strike and 1 once
    // it has been sliding for `SLIDE_RAMP_STEPS`. Computed once a step rather
    // than per event: it is a property of the contact, and there is one event
    // per hook per frame in any case.
    const settled = Math.min(1, this.contactSteps / SLIDE_RAMP_STEPS);
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
      this.stream(e.point.x, e.point.y, nx, ny, vt, tx, ty, settled);
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
    this.contactSteps = 0;
    this.rngState = PRNG_SEED;
    this.bursts = 0;
    this.slideParticles = 0;
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
    // The speed the hook arrived at, whatever direction it was pointed: `vn`
    // and `vt` are the two legs of it (see IMPACT_MIN_SPEED).
    const speed = Math.hypot(vn, vt);
    if (speed < IMPACT_MIN_SPEED) return;
    this.bursts++;
    // Only the closing half of the velocity throws sparks OFF the face, and it
    // is negative when the frame that first reported contact already has the
    // hook turning away - a graze that has bounced. Clamped rather than
    // rejected, so that graze still gets its burst, thrown along the surface by
    // the tangent share below.
    const vnOut = Math.max(0, vn);
    const count = Math.min(Math.round(speed * IMPACT_SPARKS_PER_MPS), IMPACT_BURST_CAP);
    // The reflection: the tangential half survives, the normal half turns
    // around. Normalised, since only its direction is wanted here.
    const rx = tx + nx * vnOut;
    const ry = ty + ny * vnOut;
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
      const launch =
        (IMPACT_SPEED_MIN + this.rand() * IMPACT_SPEED_SPREAD) * vnOut + IMPACT_TANGENT_SHARE * vt;
      this.spawn(px, py, nx, ny, dx * launch, dy * launch, IMPACT_TTL_SCALE);
    }
  }

  // A stream off a slide, thrown along the motion and sized by the distance slid
  // - times how far the contact has settled into a grind (see SLIDE_RAMP_STEPS),
  // which is what keeps a three-frame glancing strike from being charged a
  // grinder's worth of it.
  private stream(
    px: number,
    py: number,
    nx: number,
    ny: number,
    vt: number,
    tx: number,
    ty: number,
    settled: number,
  ): void {
    if (vt < SLIDE_MIN_SPEED) return;
    const wanted = vt * SIM_STEP * SLIDE_SPARKS_PER_METRE * settled + this.slideCarry;
    const count = Math.floor(wanted);
    this.slideCarry = wanted - count;
    if (count <= 0) return;
    // Along the slide, tilted a little off the face (see slideSparkDirection).
    const along = slideSparkDirection(nx, ny, tx, ty, vt);
    const dirx = along.x;
    const diry = along.y;
    for (let i = 0; i < count; i++) {
      const angle = (this.rand() * 2 - 1) * SLIDE_CONE;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const dx = dirx * cos - diry * sin;
      const dy = dirx * sin + diry * cos;
      // How much of the sliding speed the chip keeps. Under 1 by construction:
      // the contact is what threw it, so it cannot leave faster than the thing
      // that threw it, and the shortfall is what makes the shower fall behind
      // the hook while every spark in it still travels forwards.
      const speed = (SLIDE_SPEED_MIN + this.rand() * SLIDE_SPEED_SPREAD) * vt;
      this.slideParticles++;
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
