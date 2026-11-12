// Leaves knocked loose by the cuff: a handful where it strikes ivy
// (docs/leaves.md). A vine sheds slime instead (render/vineSlime.ts).
//
// Entirely render-side, on the boundary the sparks keep (docs/sparks.md): the
// sim is only READ - the hook's touches from `BallLevel.soundEvents` - once
// per step, and nothing here is ever written back,
// so every recorded bundle replays bit-for-bit with the leaves falling. The
// pool, the randomness, the thresholds, the flight and the fade all live here,
// and the 3D scene draws what is here (render3d/leafShedVisual.ts).
//
// A leaf flies as what it is: a thin plate. Its air force is almost all along
// its NORMAL (a plate cannot push air sideways along its own face), so a leaf
// tipped off level slides down its own slope as it falls - and the plate's
// centre of pressure sits ahead of its centre, toward the leading edge, which
// pitches it back toward broadside and past it. That pair is the side-to-side
// glide a falling leaf is known by, and it comes out of the two forces rather
// than being drawn on; the spin a strike gives it is worn down by the air the
// plate's own rotation pushes.

import { PX } from "../engine/units";
import { surfaceOf } from "../audio/surfaces";
import type { CollisionObject2D } from "../engine/body";
import type { BallLevel } from "../level/ballLevel";
import type { HookSoundEvent } from "../level/soundEvents";

// Air, kg/m³; gravity, m/s².
const AIR_DENSITY = 1.2;
const GRAVITY = 9.81;
// A fresh leaf's mass per area, kg/m² (ivy, a thick waxy leaf, is about 0.2).
// It is the whole of how heavy a leaf is: every force below is per area too,
// so a leaf's size changes how fast it TURNS but not how fast it falls.
const LEAF_AREAL_DENSITY = 0.2;
// A flat plate's normal-force coefficient broadside on, and the skin friction
// along its face.
const NORMAL_COEFFICIENT = 1.2;
const FRICTION_COEFFICIENT = 0.05;
// The air's pull per unit of speed², per metre: falling broadside, a leaf
// settles where gravity is matched, at sqrt(g / NORMAL_DRAG) = 1.65 m/s.
const NORMAL_DRAG = (AIR_DENSITY * NORMAL_COEFFICIENT) / (2 * LEAF_AREAL_DENSITY);
const FRICTION_DRAG = (AIR_DENSITY * FRICTION_COEFFICIENT) / (2 * LEAF_AREAL_DENSITY);
// The centre of pressure's offset from the plate's centre, in blade lengths,
// at its furthest (edge-on, where thin-aerofoil theory puts it at the quarter
// chord); it closes to the centre as the plate turns broadside. With a
// plate's moment of inertia about an axis across it (m L² / 12) this is the
// 12 x 0.25 below.
const PITCH_ARM = 0.25;
const PITCH_GAIN = 12 * PITCH_ARM * NORMAL_DRAG;
// A plate spinning about an axis across its middle pushes air with every
// part of it, against the spin: integrating the normal force over its length,
// against the same inertia, gives (12 / 64) x 2 x NORMAL_DRAG x L x ω².
const SPIN_DRAG = (12 / 64) * 2 * NORMAL_DRAG;

// The flight is stepped at no more than this, s: the pitching above swings a
// leaf at up to about 17 rad/s, and a 30 Hz frame stepped in one go would
// throw it.
const MAX_SUBSTEP = 1 / 120;

// A strike on ivy: leaves knocked off per m/s of the cuff's arrival, never
// more than the cap, and none at all below the speed a cuff settling into the
// carpet arrives at. STRIKE_BIT_CHANCE of them are torn bits rather than
// whole leaves (LEAF_BIT_LENGTH). (Halved from 0.8 and 10 at Tris's request,
// 2026-11-09.)
const STRIKE_LEAVES_PER_MPS = 0.4;
const STRIKE_LEAVES_CAP = 5;
// A body's FIRST strike takes its loose leaves, and every strike after sheds
// this share of that (Tris, 2026-11-09: "~20% of the original", then 30%),
// rate and cap alike: a full-speed repeat throws 1 or 2, averaging 1.44,
// against 4.8 the first time.
const REPEAT_SHARE = 0.3;
const STRIKE_BIT_CHANCE = 0.4;
const STRIKE_MIN_SPEED = 1.5;
// How hard they are thrown, as a fraction of the arrival (they are struck,
// not carried), and the most any leaf leaves with.
const STRIKE_THROW = [0.08, 0.2] as const;
const STRIKE_THROW_CAP = 2.5;
// Ivy leaves, metres tip to stem (the Blender add-on grows 7-12 cm cards).
const IVY_LEAF_LENGTH = [0.06, 0.11] as const;

// A torn bit of leaf, metres.
const LEAF_BIT_LENGTH = [0.018, 0.045] as const;

// Every leaf gets a little scatter of its own on top of what threw it, m/s.
const SCATTER = 0.35;
// Born just in front of the face it came off, m toward the camera, so the
// rock or the braid it was on does not swallow it at once.
const FRONT = [0.03, 0.12] as const;

// Seconds a leaf lives, and the last stretch of that over which it dissolves.
const TTL = [2.4, 3.4] as const;
const FADE_TIME = 0.7;

// Leaf colours, linear RGB: the ivy's, which the Blender add-on paints a dark,
// cool green (matched by eye against the carpet in the game's light: in the
// shade under a rock the vines' leaf tones came out three times as bright as
// the leaves they had come off), and the old yellowed leaf a knock most
// readily takes off, one in YELLOW_CHANCE.
export const LEAF_TONES: readonly (readonly [number, number, number])[] = [
  [0.035, 0.1, 0.045],
  [0.05, 0.135, 0.06],
  [0.08, 0.17, 0.075],
  [0.17, 0.16, 0.045],
];
const TONES = LEAF_TONES;
const YELLOW_CHANCE = 0.15;

export const LEAF_CAPACITY = 128;
const CAPACITY = LEAF_CAPACITY;

export class LeafShed {
  // Struct of arrays, swap-removed: no allocation per frame. Positions and
  // velocities are in three's frame (x right, y UP, z toward the camera), the
  // frame the plate's orientation is in; `z` is from the depth of `body`.
  readonly x = new Float32Array(CAPACITY);
  readonly y = new Float32Array(CAPACITY);
  readonly z = new Float32Array(CAPACITY);
  private readonly vx = new Float32Array(CAPACITY);
  private readonly vy = new Float32Array(CAPACITY);
  private readonly vz = new Float32Array(CAPACITY);
  // The blade's orientation (a unit quaternion taking the blade's own frame -
  // length along +y, width along +x, face along +z - into the world) and its
  // spin, rad/s.
  readonly qx = new Float32Array(CAPACITY);
  readonly qy = new Float32Array(CAPACITY);
  readonly qz = new Float32Array(CAPACITY);
  readonly qw = new Float32Array(CAPACITY);
  private readonly wx = new Float32Array(CAPACITY);
  private readonly wy = new Float32Array(CAPACITY);
  private readonly wz = new Float32Array(CAPACITY);
  private readonly age = new Float32Array(CAPACITY);
  private readonly ttl = new Float32Array(CAPACITY);
  readonly length = new Float32Array(CAPACITY);
  readonly tone = new Uint8Array(CAPACITY);
  // The blade's own shape, fixed for its life (vineLeafGeometry's `leafShape`
  // x and y: its bow sideways, its curl).
  readonly bow = new Float32Array(CAPACITY);
  readonly curl = new Float32Array(CAPACITY);
  // What it came off, for the depth it is drawn at (null: the gameplay plane).
  readonly body: (CollisionObject2D | null)[] = new Array<CollisionObject2D | null>(CAPACITY).fill(null);
  live = 0;

  private rngState = 1;
  private readonly arrivals = new Map<number, HookSoundEvent>();
  // The bodies that have already lost their loose leaves this run. A leafy
  // body sheds its full handful only the first time it is grabbed, and
  // REPEAT_SHARE of it after (Tris, 2026-11-09): the loose leaves are the ones
  // a first knock takes, and a carpet that rained as many on every grab would
  // read as a dispenser. Marked on the strike that threw some, so a cuff
  // settling gently into the carpet first does not spend it. Cleared with the
  // level, like everything else here.
  private readonly stripped = new Set<CollisionObject2D>();
  // Counted for the headless checks, read by nothing else.
  strikes = 0;
  shed = 0;

  reset(): void {
    this.live = 0;
    this.rngState = 1;
    this.strikes = 0;
    this.shed = 0;
    this.body.fill(null);
    this.stripped.clear();
  }

  // How much of leaf `i` is left: 1 whole, 0 gone.
  fade(i: number): number {
    return Math.min(1, (this.ttl[i]! - this.age[i]!) / FADE_TIME);
  }

  // Once per sim step, after it: what the cuff did to leaves on that step.
  ingest(level: BallLevel): void {
    // One strike per hook per step, the hardest of its reports: a flight
    // sweep and a probe may both report one touch (as `SoundObserver` reads
    // them), and two reports must not throw two handfuls.
    this.arrivals.clear();
    for (const e of level.soundEvents) {
      // An arrival only: the cuff biting ivy, or glancing off ivy it cannot
      // bite out of free flight. A tip dragged across a carpet reports a
      // bounce every frame, and a bounce that is not an arrival is that drag.
      // A vine sheds slime rather than leaves (render/vineSlime.ts).
      if (!e.fromFlight || surfaceOf(e.piece, e.body) !== "ivy") continue;
      const held = this.arrivals.get(e.source);
      if (!held || held.vel.lengthSquared() < e.vel.lengthSquared()) this.arrivals.set(e.source, e);
    }
    for (const e of this.arrivals.values()) {
      const speed = e.vel.length();
      if (speed < STRIKE_MIN_SPEED) continue;
      const share = this.stripped.has(e.body) ? REPEAT_SHARE : 1;
      const count = Math.min(Math.max(1, Math.round(STRIKE_LEAVES_CAP * share)),
        Math.floor(speed * STRIKE_LEAVES_PER_MPS * share + this.rand()));
      if (count === 0) continue;
      this.strikes++;
      this.stripped.add(e.body);
      const into = e.vel.mul(1 / speed);
      for (let n = 0; n < count; n++) {
        // Thrown back out of the carpet, mostly: the rock behind the leaves
        // stops the cuff, and what it knocked loose comes off the way it came,
        // lifted and toward the camera, scattered.
        const throwSpeed = Math.min(STRIKE_THROW_CAP, speed * this.between(STRIKE_THROW));
        const [sx, sy, sz] = this.unitVector();
        let dx = -into.x * 0.6 + sx * 0.8;
        let dy = -threeDown(into.y) * 0.6 + sy * 0.8 + 0.3;
        let dz = Math.abs(sz) * 0.8 + 0.5;
        const norm = Math.hypot(dx, dy, dz);
        dx /= norm;
        dy /= norm;
        dz /= norm;
        const r = 0.06 * Math.sqrt(this.rand());
        const a = this.rand() * 2 * Math.PI;
        this.spawn(
          e.point.x + r * Math.cos(a), threeDown(e.point.y + r * Math.sin(a)), this.between(FRONT),
          dx * throwSpeed, dy * throwSpeed, dz * throwSpeed,
          this.between(this.rand() < STRIKE_BIT_CHANCE ? LEAF_BIT_LENGTH : IVY_LEAF_LENGTH), e.body,
        );
      }
    }
  }

  // Once per rendered frame, on the render clock (and the fixed step in a
  // grab, so two grabs of one frame are one picture).
  advance(dt: number): void {
    if (this.live === 0 || dt <= 0) return;
    const steps = Math.ceil(dt / MAX_SUBSTEP);
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.live; i++) this.fly(i, h);
    }
    for (let i = 0; i < this.live; ) {
      this.age[i] = this.age[i]! + dt;
      if (this.age[i]! >= this.ttl[i]!) this.remove(i);
      else i++;
    }
  }

  // The 2D path: each leaf as a small dark-green ellipse, foreshortened by how
  // edge-on it is to the camera.
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.live === 0) return;
    ctx.save();
    for (let i = 0; i < this.live; i++) {
      const x = this.qx[i]!, y = this.qy[i]!, z = this.qz[i]!, w = this.qw[i]!;
      // The blade's length axis (its own +y turned), and its face's normal.
      const ax = 2 * (x * y - w * z), ay = 1 - 2 * (x * x + z * z);
      const nz = this.normal(i)[2];
      const [r, g, b] = TONES[this.tone[i]!]!;
      ctx.globalAlpha = this.fade(i);
      ctx.fillStyle = `rgb(${srgb(r)},${srgb(g)},${srgb(b)})`;
      const len = this.length[i]!;
      ctx.beginPath();
      ctx.ellipse(
        this.x[i]!, -this.y[i]!,
        Math.max(PX, len * 0.5 * Math.hypot(ax, ay)), Math.max(PX, len * 0.29 * Math.abs(nz)),
        Math.atan2(-ay, ax), 0, 2 * Math.PI,
      );
      ctx.fill();
    }
    ctx.restore();
  }

  private fly(i: number, h: number): void {
    let vx = this.vx[i]!, vy = this.vy[i]!, vz = this.vz[i]!;
    let wx = this.wx[i]!, wy = this.wy[i]!, wz = this.wz[i]!;
    const [nx, ny, nz] = this.normal(i);
    const speed = Math.hypot(vx, vy, vz);
    let ax = 0, ay = -GRAVITY, az = 0;
    if (speed > 1e-6) {
      const vn = vx * nx + vy * ny + vz * nz;
      // Pressure on the face, along the normal and against the flow through it.
      const fn = -NORMAL_DRAG * speed * vn;
      ax += fn * nx;
      ay += fn * ny;
      az += fn * nz;
      // Friction along the face.
      const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
      ax -= FRICTION_DRAG * speed * tx;
      ay -= FRICTION_DRAG * speed * ty;
      az -= FRICTION_DRAG * speed * tz;
      // The pitch toward broadside: about n x v, by cos·sin of the angle
      // between the face and the flow, signed to turn whichever face is
      // nearer the flow into it.
      const len = this.length[i]!;
      const k = (PITCH_GAIN * speed) / len;
      const cx = ny * vz - nz * vy, cy = nz * vx - nx * vz, cz = nx * vy - ny * vx;
      const cos = vn / speed;
      wx += k * cos * cx * h;
      wy += k * cos * cy * h;
      wz += k * cos * cz * h;
      const spin = Math.hypot(wx, wy, wz);
      if (spin > 1e-6) {
        const keep = 1 / (1 + SPIN_DRAG * len * spin * h);
        wx *= keep;
        wy *= keep;
        wz *= keep;
      }
    }
    vx += ax * h;
    vy += ay * h;
    vz += az * h;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.wx[i] = wx;
    this.wy[i] = wy;
    this.wz[i] = wz;
    this.x[i] = this.x[i]! + vx * h;
    this.y[i] = this.y[i]! + vy * h;
    this.z[i] = this.z[i]! + vz * h;
    // q += ½ (0, ω) q h, renormalised.
    const qx = this.qx[i]!, qy = this.qy[i]!, qz = this.qz[i]!, qw = this.qw[i]!;
    let px = qx + 0.5 * h * (wx * qw + wy * qz - wz * qy);
    let py = qy + 0.5 * h * (wy * qw + wz * qx - wx * qz);
    let pz = qz + 0.5 * h * (wz * qw + wx * qy - wy * qx);
    let pw = qw - 0.5 * h * (wx * qx + wy * qy + wz * qz);
    const qn = Math.hypot(px, py, pz, pw);
    px /= qn;
    py /= qn;
    pz /= qn;
    pw /= qn;
    this.qx[i] = px;
    this.qy[i] = py;
    this.qz[i] = pz;
    this.qw[i] = pw;
  }

  // The blade's face normal: its own +z, turned by its orientation.
  private normal(i: number): [number, number, number] {
    const x = this.qx[i]!, y = this.qy[i]!, z = this.qz[i]!, w = this.qw[i]!;
    return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  }

  private spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    length: number, body: CollisionObject2D | null,
  ): void {
    // A full pool drops the oldest leaf rather than the new one: the newest
    // is the one just struck off, in front of the player.
    if (this.live === CAPACITY) this.remove(this.oldest());
    const i = this.live++;
    this.shed++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = vx + (this.rand() - 0.5) * 2 * SCATTER;
    this.vy[i] = vy + (this.rand() - 0.5) * 2 * SCATTER;
    this.vz[i] = vz + (this.rand() - 0.5) * SCATTER;
    // Any orientation, uniformly (Shoemake), and a tumble from the knock.
    const u1 = this.rand(), u2 = this.rand() * 2 * Math.PI, u3 = this.rand() * 2 * Math.PI;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    this.qx[i] = a * Math.sin(u2);
    this.qy[i] = a * Math.cos(u2);
    this.qz[i] = b * Math.sin(u3);
    this.qw[i] = b * Math.cos(u3);
    const [sx, sy, sz] = this.unitVector();
    const spin = 4 + this.rand() * 10;
    this.wx[i] = sx * spin;
    this.wy[i] = sy * spin;
    this.wz[i] = sz * spin;
    this.age[i] = 0;
    this.ttl[i] = this.between(TTL);
    this.length[i] = length;
    this.tone[i] = this.rand() < YELLOW_CHANCE ? 3 : Math.floor(this.rand() * 3);
    this.bow[i] = (this.rand() - 0.5) * 0.09;
    this.curl[i] = this.rand() > 0.8 ? -0.09 : 0.015 + this.rand() * 0.04;
    this.body[i] = body;
  }

  private oldest(): number {
    let best = 0;
    for (let i = 1; i < this.live; i++) if (this.age[i]! > this.age[best]!) best = i;
    return best;
  }

  private remove(i: number): void {
    const last = --this.live;
    if (i !== last) {
      for (const arr of [this.x, this.y, this.z, this.vx, this.vy, this.vz, this.qx, this.qy, this.qz, this.qw,
        this.wx, this.wy, this.wz, this.age, this.ttl, this.length, this.bow, this.curl]) arr[i] = arr[last]!;
      this.tone[i] = this.tone[last]!;
      this.body[i] = this.body[last]!;
    }
    this.body[last] = null;
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

  // mulberry32, seeded and owned here (see `SparkSystem.rand`): a grab of a
  // frame is the same picture every time.
  private rand(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) | 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// The sim's y runs down the screen; three's, and this flight's, up.
function threeDown(y: number): number {
  return -y;
}

function srgb(linear: number): number {
  return Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055));
}
