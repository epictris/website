// Globs of slime off a vine: a splash where the cuff grabs one, and drips
// flicked off while its ring slides along one (docs/leaves.md#slime). The
// vines are wet - their grab and slide are wet recordings (docs/sound.md) - so
// what comes off them is the wet, not their leaves.
//
// Render-side on the sparks' terms (docs/sparks.md), as the leaves are
// (render/leafShed.ts): the hook's touches are read from
// `BallLevel.soundEvents` and the ring from `ball.chain.end` once per step,
// and nothing is written back. The 3D scene draws what is here
// (render3d/vineSlimeVisual.ts).
//
// A glob is a small dense drop, so it flies as one: gravity and the air's
// drag on a sphere, `3 ρ_air C_d / (8 ρ_slime r) |v| v`, which for a
// centimetre of slime is a few percent of gravity at the speeds here - nearly
// ballistic, as a flung drop is.

import { RopeVineClamp, vineArc } from "../lib/vineClamp";
import { surfaceOf } from "../audio/surfaces";
import type { BallLevel } from "../level/ballLevel";
import type { HookSoundEvent } from "../level/soundEvents";

const GRAVITY = 9.81;
// Air, and slime (mostly water), kg/m³; a sphere's drag coefficient.
const AIR_DENSITY = 1.2;
const SLIME_DENSITY = 1050;
const SPHERE_DRAG = 0.47;

// The cuff grabbing a vine: globs per m/s of its arrival, at most the cap,
// none for a cuff arriving slower than STRIKE_MIN_SPEED.
// Halved from 0.4 and 5 (Tris, 2026-11-09: "too much slime on attach"); the
// cap is 3 rather than 2.5 so the rate, not the cap, halves a full-speed grab
// (12 m/s: 2 or 3, averaging 2.4, where it averaged 4.8).
const GRAB_GLOBS_PER_MPS = 0.2;
const GRAB_GLOBS_CAP = 3;
const STRIKE_MIN_SPEED = 1.5;
// Flung at this share of the arrival, at most THROW_CAP: the cuff closes
// round the cord and carries on, and what it splashes off goes on with it.
// Slime is viscous and clings, so it is shaken loose more than thrown: at
// 10-25% of the arrival, capped at 3 m/s, with 0.4 m/s of scatter, the globs
// read as too energetic (Tris, 2026-11-09), and every speed here was cut to
// about 40% of that.
const GRAB_THROW = [0.04, 0.1] as const;
const THROW_CAP = 1.2;

// The ring sliding along a vine: globs per metre slid, above the creep a ring
// does at rest, leaving with a share of the ring's own velocity.
const SLIDE_GLOBS_PER_METRE = 4;
const SLIDE_MIN_SPEED = 0.1;
const SLIDE_CARRY = [0.08, 0.2] as const;
// ...and drifting off the cord toward or away from the camera, m/s.
const SLIDE_DEPTH_DRIFT = 0.12;

// Scatter on top of what threw it, m/s, and a glob's radius, m.
const SCATTER = 0.15;
const RADIUS = [0.008, 0.02] as const;

// Seconds a glob lives, and the last stretch of it over which it shrinks away.
const TTL = [1.2, 2] as const;
const FADE_TIME = 0.35;

export const SLIME_CAPACITY = 96;
const CAPACITY = SLIME_CAPACITY;

export class VineSlime {
  // Three's frame (x right, y UP, z toward the camera), on the gameplay
  // plane's depth, where the vines are drawn.
  readonly x = new Float32Array(CAPACITY);
  readonly y = new Float32Array(CAPACITY);
  readonly z = new Float32Array(CAPACITY);
  private readonly vx = new Float32Array(CAPACITY);
  private readonly vy = new Float32Array(CAPACITY);
  private readonly vz = new Float32Array(CAPACITY);
  readonly radius = new Float32Array(CAPACITY);
  // A glob is not a perfect ball: its own fixed squash along each axis.
  readonly sx = new Float32Array(CAPACITY);
  readonly sy = new Float32Array(CAPACITY);
  readonly sz = new Float32Array(CAPACITY);
  private readonly age = new Float32Array(CAPACITY);
  private readonly ttl = new Float32Array(CAPACITY);
  live = 0;

  private rngState = 7;
  private slide: { clamp: RopeVineClamp; segment: number; fraction: number; x: number; y: number } | null = null;
  private slideCarry = 0;
  private readonly arrivals = new Map<number, HookSoundEvent>();
  // Counted for the headless checks, read by nothing else.
  grabs = 0;
  thrown = 0;

  reset(): void {
    this.live = 0;
    this.rngState = 7;
    this.slide = null;
    this.slideCarry = 0;
    this.grabs = 0;
    this.thrown = 0;
  }

  // How much of glob `i` is left, as a scale: 1 whole, 0 gone.
  fade(i: number): number {
    return Math.min(1, (this.ttl[i]! - this.age[i]!) / FADE_TIME);
  }

  // Once per sim step, after it.
  ingest(level: BallLevel, dt: number): void {
    const ball = level.ball;
    // The grab: the cuff arriving on a vine out of free flight, once per hook
    // per step (a flight sweep and a probe may both report it).
    this.arrivals.clear();
    for (const e of level.soundEvents) {
      if (!e.fromFlight || surfaceOf(e.piece, e.body) !== "vine") continue;
      const held = this.arrivals.get(e.source);
      if (!held || held.vel.lengthSquared() < e.vel.lengthSquared()) this.arrivals.set(e.source, e);
    }
    for (const e of this.arrivals.values()) {
      const speed = e.vel.length();
      if (speed < STRIKE_MIN_SPEED) continue;
      this.grabs++;
      const count = Math.min(GRAB_GLOBS_CAP, Math.floor(speed * GRAB_GLOBS_PER_MPS + this.rand()));
      const ix = e.vel.x / speed, iy = -e.vel.y / speed;
      for (let n = 0; n < count; n++) {
        const throwSpeed = Math.min(THROW_CAP, speed * this.between(GRAB_THROW));
        const [ux, uy, uz] = this.unitVector();
        let dx = ix * 0.7 + ux * 0.7;
        let dy = iy * 0.7 + uy * 0.7;
        let dz = uz * 0.5;
        const norm = Math.hypot(dx, dy, dz);
        dx /= norm;
        dy /= norm;
        dz /= norm;
        this.spawn(e.point.x, -e.point.y, dx * throwSpeed, dy * throwSpeed, dz * throwSpeed);
      }
    }

    // The slide: how far the ring went ALONG the vine this step, on the line
    // as it stands now (`vineArc`), so the vine swinging tears nothing off.
    const clamp = ball.chain?.end;
    if (clamp instanceof RopeVineClamp && !ball.hookInFlight) {
      const at = clamp.contact.globalPosition;
      const previous = this.slide;
      this.slide = { clamp, segment: clamp.segment, fraction: clamp.fraction, x: at.x, y: at.y };
      if (previous?.clamp === clamp && dt > 0) {
        const along = Math.abs(vineArc(clamp.vine, clamp.segment, clamp.fraction) -
          vineArc(clamp.vine, previous.segment, previous.fraction));
        if (along / dt > SLIDE_MIN_SPEED) {
          this.slideCarry += along * SLIDE_GLOBS_PER_METRE;
          const rvx = (at.x - previous.x) / dt;
          const rvy = -(at.y - previous.y) / dt;
          while (this.slideCarry >= 1) {
            this.slideCarry -= 1;
            const t = this.rand();
            const carry = this.between(SLIDE_CARRY);
            this.spawn(
              previous.x + (at.x - previous.x) * t, -(previous.y + (at.y - previous.y) * t),
              rvx * carry, rvy * carry, (this.rand() - 0.5) * SLIDE_DEPTH_DRIFT,
            );
          }
        }
      }
    } else {
      this.slide = null;
      this.slideCarry = 0;
    }
  }

  // Once per rendered frame, on the render clock (the fixed step in a grab).
  advance(dt: number): void {
    if (this.live === 0 || dt <= 0) return;
    for (let i = 0; i < this.live; i++) {
      let vx = this.vx[i]!, vy = this.vy[i]!, vz = this.vz[i]!;
      const k = (3 * AIR_DENSITY * SPHERE_DRAG) / (8 * SLIME_DENSITY * this.radius[i]!);
      const keep = 1 / (1 + k * Math.hypot(vx, vy, vz) * dt);
      vx *= keep;
      vy = (vy - GRAVITY * dt) * keep;
      vz *= keep;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.x[i] = this.x[i]! + vx * dt;
      this.y[i] = this.y[i]! + vy * dt;
      this.z[i] = this.z[i]! + vz * dt;
    }
    for (let i = 0; i < this.live; ) {
      this.age[i] = this.age[i]! + dt;
      if (this.age[i]! >= this.ttl[i]!) this.remove(i);
      else i++;
    }
  }

  // The 2D path: a dot per glob.
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.live === 0) return;
    ctx.save();
    ctx.fillStyle = "#8fa84a";
    for (let i = 0; i < this.live; i++) {
      ctx.beginPath();
      ctx.arc(this.x[i]!, -this.y[i]!, this.radius[i]! * this.fade(i), 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  private spawn(x: number, y: number, vx: number, vy: number, vz: number): void {
    if (this.live === CAPACITY) this.remove(this.oldest());
    const i = this.live++;
    this.thrown++;
    this.x[i] = x;
    this.y[i] = y;
    // Off the near side of the cord, so the braid does not swallow it.
    this.z[i] = 0.02 + this.rand() * 0.03;
    this.vx[i] = vx + (this.rand() - 0.5) * 2 * SCATTER;
    this.vy[i] = vy + (this.rand() - 0.5) * 2 * SCATTER;
    this.vz[i] = vz + (this.rand() - 0.5) * SCATTER;
    // Mostly small, now and then a big one.
    this.radius[i] = RADIUS[0] + (RADIUS[1] - RADIUS[0]) * this.rand() ** 2;
    this.sx[i] = 0.85 + this.rand() * 0.3;
    this.sy[i] = 0.85 + this.rand() * 0.3;
    this.sz[i] = 0.85 + this.rand() * 0.3;
    this.age[i] = 0;
    this.ttl[i] = this.between(TTL);
  }

  private oldest(): number {
    let best = 0;
    for (let i = 1; i < this.live; i++) if (this.age[i]! > this.age[best]!) best = i;
    return best;
  }

  private remove(i: number): void {
    const last = --this.live;
    if (i === last) return;
    for (const arr of [this.x, this.y, this.z, this.vx, this.vy, this.vz, this.radius,
      this.sx, this.sy, this.sz, this.age, this.ttl]) arr[i] = arr[last]!;
  }

  private between(range: readonly [number, number]): number {
    return range[0] + (range[1] - range[0]) * this.rand();
  }

  private unitVector(): [number, number, number] {
    const z = this.rand() * 2 - 1;
    const a = this.rand() * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), r * Math.sin(a), z];
  }

  // mulberry32, seeded (see `SparkSystem.rand`).
  private rand(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) | 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
