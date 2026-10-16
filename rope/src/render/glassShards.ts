// The glass ball's shards: what it, its chain and its manacle come apart into
// when it breaks (see `BallLevel.shatterIfStruck`).
//
// Entirely render-side, on the boundary the debris and the sparks keep
// (`render/debris.ts`, docs/sparks.md): the sim contributes one fact per break
// (`ShatterEvent`) and this module owns everything else - the pieces, their
// motion and the 2D drawing - and nothing here is ever read back by the sim.
// The 3D scene draws the same pieces in glass (`render3d/shardVisual.ts`).
//
// THE PIECES ARE THE SHELL. A hollow glass sphere fails as a shell does: it
// breaks into curved plates of its own wall, a few large ones and many small
// splinters, each starting where it was on the sphere, lying in the sphere's
// tangent plane. Their motion is the ball's motion at the moment it broke,
// reflected off the surface it struck the way a weak bounce reflects it, plus
// the burst the impact sends round the shell - so a ball that drops onto a
// floor splashes outward along the floor, and one that clips a wall at speed
// sprays on along its path. They fall under gravity and skid to a stop on the
// struck surface, which is a plane through the contact (the floor it hit is
// all a second of shards needs to land on), and shrink away before the level
// restarts.
//
// Positions are world METRES in the sim's frame (x right, y DOWN), with z
// toward the camera, which is the frame `render3d/space.ts` maps to three's.

import { PX } from "../engine/units";
import type { Vec2 } from "../engine/vec2";
import type { ShatterEvent } from "../level/ballLevel";
import { CHAIN_LINK_LEN, CHAIN_LINK_W } from "./chainMetrics";

export interface Shard {
  // Position, metres, and velocity, m/s.
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  // Orientation as a unit quaternion, and angular velocity (rad/s, world axes).
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  wx: number;
  wy: number;
  wz: number;
  // The plate's size: across its two in-plane axes and through its wall.
  sx: number;
  sy: number;
  thick: number;
  // Seconds alive, and how long it gets.
  age: number;
  ttl: number;
  // The struck surface, as a point and its outward normal (2D), or null for a
  // piece that started on the far side of it - a link of chain that lay
  // beyond the wall the ball hit is not on that wall's surface.
  plane: { px: number; py: number; nx: number; ny: number } | null;
}

// THE SHELL'S PIECES: the large plates, and the splinters between them.
const PLATES = 46;
const SPLINTERS = 40;
// A plate's size as a fraction of the even share of the shell's surface each
// would have (4 pi r^2 / PLATES), jittered so no two are alike.
const PLATE_SPREAD: readonly [number, number] = [0.55, 1.25];
const SPLINTER_SIZE: readonly [number, number] = [0.18, 0.4];
// The wall's thickness: a few millimetres of glass, which is what makes the
// edge of a plate catch the light.
export const GLASS_WALL = 0.003;

// How the struck side throws the pieces back: a weak bounce off the surface,
// between these fractions of the speed the ball arrived into it at.
const RESTITUTION: readonly [number, number] = [0.1, 0.45];
// What of the ball's speed ALONG the surface the pieces keep.
const CARRY: readonly [number, number] = [0.6, 0.95];
// The burst outward round the shell, per m/s of arrival into the surface, and
// its floor: even a ball set down gently breaks apart rather than in place.
const BURST_PER_SPEED = 0.22;
const BURST_MIN = 0.35;
const BURST_MAX = 3.2;
// Out of the gameplay plane, the burst is held to this fraction: the plane is
// where the player is looking, and a shard flying at the lens is a smear.
const DEPTH_BURST = 0.45;
// Tumbling, rad/s.
const SPIN: readonly [number, number] = [6, 28];

// A shard's life, seconds. A fresh ball is put at the spawn
// `SHATTER_RESPAWN_FRAMES` after the break (2 s) and the camera goes with it, so
// the pieces land, skitter to rest and are gone just before; the last stretch
// of a life is a shrink, which reads as glass catching the light less and less
// rather than as a piece vanishing.
const TTL: readonly [number, number] = [1.4, 1.9];
const SHRINK_FRACTION = 0.3;

const GRAVITY = 9.8;
// Light air drag, per second.
const DRAG = 0.5;
// On the struck surface: what of a piece's speed into it comes back, and what
// of its speed along it survives each landing.
const LAND_BOUNCE = 0.25;
const LAND_FRICTION = 0.55;

// The cap: one break's worth and its chain, with room for the longest chain.
const MAX_SHARDS = 256;

// A small fixed-seed generator (mulberry32), reseeded on reset, so the same
// break draws the same shower every time it is watched - in a replay, a grab,
// a filmstrip.
const SEED = 0x9e3779b9;

export class GlassShards {
  readonly shards: Shard[] = [];
  private rng = SEED;

  // Throw the pieces of every break this frame.
  ingest(events: readonly ShatterEvent[]): void {
    for (const e of events) this.shatter(e);
  }

  get active(): boolean {
    return this.shards.length > 0;
  }

  // On the render clock, outside the fixed step - none of this is simulation.
  advance(dt: number): void {
    const step = Math.min(dt, 0.1);
    if (step <= 0) return;
    const drag = Math.max(0, 1 - DRAG * step);
    let live = 0;
    for (const s of this.shards) {
      s.age += step;
      if (s.age >= s.ttl) continue;
      s.vx *= drag;
      s.vy = (s.vy + GRAVITY * step) * drag;
      s.vz *= drag;
      s.x += s.vx * step;
      s.y += s.vy * step;
      s.z += s.vz * step;
      this.land(s);
      integrateSpin(s, step);
      this.shards[live++] = s;
    }
    this.shards.length = live;
  }

  // How big a shard is drawn this frame, as a fraction of its size: whole, and
  // then shrinking to nothing over the end of its life.
  static scaleOf(s: Shard): number {
    const t = s.age / s.ttl;
    return t < 1 - SHRINK_FRACTION ? 1 : Math.max(0, (1 - t) / SHRINK_FRACTION);
  }

  // The 2D path's drawing: each plate as the triangle it projects to on the
  // gameplay plane, a pale fill and a bright edge, which is how a sliver of
  // clear glass reads against anything.
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.shards.length === 0) return;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineWidth = PX * 0.6;
    for (const s of this.shards) {
      const k = GlassShards.scaleOf(s);
      if (k <= 0) continue;
      ctx.beginPath();
      for (let i = 0; i < SHARD_TRIANGLE.length; i++) {
        const [lx, ly] = SHARD_TRIANGLE[i]!;
        const [wx, wy] = rotate(s, lx * s.sx * k, ly * s.sy * k, 0);
        if (i === 0) ctx.moveTo(s.x + wx, s.y + wy);
        else ctx.lineTo(s.x + wx, s.y + wy);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(205, 228, 245, 0.22)";
      ctx.fill();
      ctx.strokeStyle = "rgba(240, 248, 255, 0.75)";
      ctx.stroke();
    }
    ctx.restore();
  }

  // Everything gone and the generator reseeded, so a restart carries no glass
  // from the run that broke it.
  reset(): void {
    this.shards.length = 0;
    this.rng = SEED;
  }

  private random(): number {
    let t = (this.rng = (this.rng + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + (hi - lo) * this.random();
  }

  private shatter(e: ShatterEvent): void {
    const n = e.normal;
    const plane = { px: e.point.x, py: e.point.y, nx: n.x, ny: n.y };
    // The arrival, split into the part INTO the surface and the part along it.
    const into = Math.min(0, e.velocity.x * n.x + e.velocity.y * n.y);
    const alongX = e.velocity.x - into * n.x;
    const alongY = e.velocity.y - into * n.y;
    const burst = Math.min(BURST_MAX, BURST_MIN + BURST_PER_SPEED * -into);
    const r = e.radius;

    const plate = Math.sqrt((4 * Math.PI * r * r) / PLATES);
    for (let i = 0; i < PLATES + SPLINTERS; i++) {
      const splinter = i >= PLATES;
      // Where on the shell: evenly over the sphere (a Fibonacci spiral),
      // jittered so the plates are not a lattice.
      const k = splinter ? this.random() * PLATES : i + this.between([-0.35, 0.35]);
      const cz = 1 - (2 * (k + 0.5)) / PLATES;
      const ring = Math.sqrt(Math.max(0, 1 - cz * cz));
      const phi = k * GOLDEN_ANGLE + this.between([-0.2, 0.2]);
      const dx = ring * Math.cos(phi);
      const dy = ring * Math.sin(phi);
      const dz = cz;
      const size = splinter ? plate * this.between(SPLINTER_SIZE) : plate * this.between(PLATE_SPREAD);
      const bounce = this.between(RESTITUTION) * -into;
      const carry = this.between(CARRY);
      const kick = burst * this.between([0.45, 1.15]);
      const s = this.add({
        x: e.at.x + dx * r,
        y: e.at.y + dy * r,
        z: dz * r,
        vx: alongX * carry + n.x * bounce + dx * kick,
        vy: alongY * carry + n.y * bounce + dy * kick,
        vz: dz * kick * DEPTH_BURST,
        sx: size * this.between([0.7, 1.3]),
        sy: size * this.between([0.7, 1.3]),
        thick: GLASS_WALL,
        plane,
      });
      // Lying in the shell's tangent plane: the plate's own z onto the radial.
      if (s) tangentTo(s, dx, dy, dz, this.random() * Math.PI * 2);
    }

    // The chain and its cuff: a splinter or two per link, dropping where the
    // link was, nudged apart. A link beyond the struck surface lands on
    // nothing; one on the ball's side of it lands where the ball's shards do.
    const step = CHAIN_LINK_LEN * 1.4;
    walk(e.chain, step, (x, y) => {
      for (let j = 0; j < 2; j++) {
        const side = (x - plane.px) * plane.nx + (y - plane.py) * plane.ny;
        const s = this.add({
          x: x + this.between([-1, 1]) * CHAIN_LINK_W,
          y: y + this.between([-1, 1]) * CHAIN_LINK_W,
          z: this.between([-1, 1]) * CHAIN_LINK_W,
          vx: this.between([-0.5, 0.5]),
          vy: this.between([-0.6, 0.2]),
          vz: this.between([-0.2, 0.2]),
          sx: CHAIN_LINK_LEN * this.between([0.25, 0.6]),
          sy: CHAIN_LINK_W * this.between([0.5, 1.1]),
          thick: GLASS_WALL,
          plane: side >= 0 ? plane : null,
        });
        if (s) tangentTo(s, this.between([-1, 1]), this.between([-1, 1]), this.between([-1, 1]), this.random() * 6.28);
      }
    });
    if (e.manacle) {
      const c = e.manacle.centre;
      const side = (c.x - plane.px) * plane.nx + (c.y - plane.py) * plane.ny;
      for (let j = 0; j < 8; j++) {
        const a = (j / 8) * Math.PI * 2;
        const s = this.add({
          x: c.x + Math.cos(a) * 2 * PX,
          y: c.y + Math.sin(a) * 2 * PX,
          z: this.between([-1, 1]) * PX,
          vx: Math.cos(a) * this.between([0.2, 0.7]),
          vy: Math.sin(a) * this.between([0.2, 0.7]) - 0.2,
          vz: this.between([-0.2, 0.2]),
          sx: 2.4 * PX * this.between([0.6, 1.2]),
          sy: 1.6 * PX * this.between([0.6, 1.2]),
          thick: GLASS_WALL,
          plane: side >= 0 ? plane : null,
        });
        if (s) tangentTo(s, Math.cos(a), Math.sin(a), 0, this.random() * 6.28);
      }
    }
  }

  private add(p: {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    sx: number;
    sy: number;
    thick: number;
    plane: Shard["plane"];
  }): Shard | null {
    if (this.shards.length >= MAX_SHARDS) return null;
    // A random axis, at a random rate.
    const ax = this.between([-1, 1]);
    const ay = this.between([-1, 1]);
    const az = this.between([-1, 1]);
    const len = Math.hypot(ax, ay, az) || 1;
    const rate = this.between(SPIN);
    const s: Shard = {
      ...p,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      wx: (ax / len) * rate,
      wy: (ay / len) * rate,
      wz: (az / len) * rate,
      age: 0,
      ttl: this.between(TTL),
    };
    this.shards.push(s);
    return s;
  }

  // Keep a piece on the ball's side of the surface it broke on: pushed back
  // out of it, its speed into the surface mostly lost and some of its speed
  // along it, and its tumble damped - glass skittering to a stop.
  private land(s: Shard): void {
    const p = s.plane;
    if (p === null) return;
    const d = (s.x - p.px) * p.nx + (s.y - p.py) * p.ny;
    if (d >= 0) return;
    s.x -= d * p.nx;
    s.y -= d * p.ny;
    const vn = s.vx * p.nx + s.vy * p.ny;
    if (vn < 0) {
      const tx = s.vx - vn * p.nx;
      const ty = s.vy - vn * p.ny;
      s.vx = tx * LAND_FRICTION - vn * LAND_BOUNCE * p.nx;
      s.vy = ty * LAND_FRICTION - vn * LAND_BOUNCE * p.ny;
      s.vz *= LAND_FRICTION;
      s.wx *= 0.6;
      s.wy *= 0.6;
      s.wz *= 0.6;
    }
  }
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// A plate is a triangle in its own x-y plane, centred on its centroid, one
// unit across; it is scaled by `sx`/`sy` and turned by its quaternion. Shared
// with the 3D layer, which extrudes it through the wall's thickness.
export const SHARD_TRIANGLE: readonly (readonly [number, number])[] = [
  [0, 0.58],
  [-0.5, -0.29],
  [0.5, -0.29],
];

// Turn `s` so its own z axis lies along (dx, dy, dz) - the shell's radial -
// twisted by `twist` about it.
function tangentTo(s: Shard, dx: number, dy: number, dz: number, twist: number): void {
  const len = Math.hypot(dx, dy, dz) || 1;
  const x = dx / len;
  const y = dy / len;
  const z = dz / len;
  // The shortest arc from +z to the radial...
  let qx = -y;
  let qy = x;
  let qz = 0;
  let qw = 1 + z;
  if (qw < 1e-6) {
    // ...which is a half turn about x when the radial is -z.
    qx = 1;
    qy = 0;
    qw = 0;
  }
  const n = Math.hypot(qx, qy, qz, qw);
  qx /= n;
  qy /= n;
  qw /= n;
  // ...after the twist about +z.
  const tw = Math.cos(twist / 2);
  const tz = Math.sin(twist / 2);
  s.qx = qx * tw + qy * tz;
  s.qy = qy * tw - qx * tz;
  s.qz = qw * tz + qz * tw;
  s.qw = qw * tw - qz * tz;
}

// q <- q + dt/2 * (w, 0) * q, renormalised.
function integrateSpin(s: Shard, dt: number): void {
  const h = dt / 2;
  const { wx, wy, wz } = s;
  const qx = s.qx + h * (wx * s.qw + wy * s.qz - wz * s.qy);
  const qy = s.qy + h * (wy * s.qw + wz * s.qx - wx * s.qz);
  const qz = s.qz + h * (wz * s.qw + wx * s.qy - wy * s.qx);
  const qw = s.qw - h * (wx * s.qx + wy * s.qy + wz * s.qz);
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  s.qx = qx / n;
  s.qy = qy / n;
  s.qz = qz / n;
  s.qw = qw / n;
}

// A local vector turned into the world by the shard's quaternion.
function rotate(s: Shard, x: number, y: number, z: number): [number, number, number] {
  const { qx, qy, qz, qw } = s;
  // t = 2 q.xyz x v; v' = v + w t + q.xyz x t
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

// Call `at` every `step` metres along a polyline.
function walk(points: readonly Vec2[], step: number, at: (x: number, y: number) => void): void {
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let s = carry;
    while (s < len) {
      const t = s / len;
      at(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      s += step;
    }
    carry = s - len;
  }
}
