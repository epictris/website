// Debris - the chunks a breakable body comes apart into.
//
// Entirely render-side, on the same boundary the sparks keep (`render/sparks.ts`
// and the rule in `docs/sparks.md`): the simulation contributes one fact per
// break (`level/breakable.ts`) and this module owns everything else - the
// shatter, the randomness, the physics and the drawing. Nothing here is ever
// read back by the sim, so a chunk can never move a body and every recorded
// bundle replays bit-for-bit with the whole system running.
//
// The chunks are PARTICLES, not bodies, and that is the design rather than a
// simplification. Rubble that can be stood on, hooked, wrapped and knocked
// about is a second level's worth of physics for a second of spectacle, and it
// leaves the level permanently different in a way nothing authored it to be.
// What the player is owed is the moment the wall gives way; a second later
// there is nothing there, which is exactly what the sim says is there.
//
// The shatter is a recursive convex SPLIT: a chunk is cut by a line through a
// point near its middle, and each half is cut again until the pieces are about
// the size a chunk should be. Convex in, convex out, every time - so the cut is
// one half-plane clip and nothing here needs a polygon library, and a body that
// collides as one rect breaks into rubble rather than falling over as a slab.

import { PX } from "../engine/units";
import { Vec2 } from "../engine/vec2";
import { shapeVertices } from "../engine/shapes";
import type { CollisionObject2D } from "../engine/body";
import { RigidBody2D } from "../engine/body";
import type { BreakEvent } from "../level/breakable";
import { hexToRgb } from "./color";

// About how big a chunk should be, in metres each way. A wall two metres across
// wants a handful of pieces, not sixty confetti flakes and not two halves.
const CHUNK_SIZE = 0.35;
// ...and the bounds on that, because the range of things a level breaks is
// wide: a 40 cm crate must still shatter, and a whole floor must not cost a
// thousand polygons.
const MIN_CHUNKS = 3;
const MAX_CHUNKS_PER_PIECE = 12;
// The pool, and with it the per-break ceiling. Two walls going at once is the
// case this is sized for.
const MAX_CHUNKS = 96;

// How far off the middle a cut may wander, as a fraction of the piece's extent.
// Cutting through the exact centre every time tiles a rect into a neat grid,
// which reads as a jigsaw rather than as something broken.
const CUT_JITTER = 0.3;

// A chunk's life, seconds: "about a second", jittered so the shower does not
// blink out as one.
const TTL_MIN = 0.7;
const TTL_MAX = 1.2;
// The last fraction of that life is the fade. Before it a chunk is fully
// opaque: a piece of wall that starts fading the instant it is struck reads as
// a ghost rather than as stone.
const FADE_FRACTION = 0.45;

// Chunks fall - they are pieces of the level, not smoke.
const GRAVITY = 9.8;
// Exponential drag, per second. Light: it takes the edge off the fastest pieces
// without making them float.
const DRAG = 0.6;

// How fast the shower is thrown, in m/s per unit of "how much harder than it
// had to be hit this was" - the finishing force over the threshold. A break
// that only just happened crumbles; a slam blows the wall apart.
// It is deliberately small next to the speed of whatever broke it: what a floor
// giving way looks like is chunks FALLING, shoved apart as they go, and the
// first pass at 1.1 (a shower travelling at up to 4.8 m/s off a 5.6 m/s ball)
// blew the slab apart into two clouds with a hole between them - an explosion
// where a collapse belongs.
const KICK_PER_OVERDRIVE = 0.45;
// ...within these, so a colossal hit does not fire the debris off-screen in
// three frames and the gentlest break still moves.
const KICK_MIN = 0.4;
const KICK_MAX = 3;
// How much of the kick is the blow's own direction rather than straight out
// from the point it landed. All-radial reads as an explosion from a point;
// all-along reads as the whole wall sliding. Carrying on the way the blow was
// travelling, shoved apart a little, is what being punched through looks like.
const KICK_ALONG = 0.6;
// Spin, rad/s, scaled by the same overdrive and jittered in sign.
const SPIN_PER_OVERDRIVE = 3.5;
const SPIN_MAX = 12;

// A fixed seed, so a screenshot of a given bundle frame is the same picture
// every run (the same reason `SparkSystem` has one).
const PRNG_SEED = 0x1234abcd;

interface Chunk {
  // The piece's outline about its own centroid, in metres.
  verts: Vec2[];
  x: number;
  y: number;
  rot: number;
  vx: number;
  vy: number;
  spin: number;
  age: number;
  ttl: number;
  // The body's own fill, which is what the 2D renderer draws that body in. The
  // alpha is left to the draw, which multiplies in the fade.
  //
  // The same colour over the 3D canvas, deliberately. The scene lifts an
  // authored fill before tinting a lit material (`TINT_FLOOR` in
  // `render3d/bodyVisuals.ts`), and a chunk drawn in that LIFTED colour was
  // tried first and is wrong: the lift is a tint that then multiplies a texture
  // and the sun, so drawn flat it is a pale grey chip where the raw fill is the
  // stone the slab reads as (filmstrips 2026-09-16, `BREAK_TEST` f28-f68).
  // Flat debris a shade darker than the lit slab it came off is what falling
  // rubble looks like anyway.
  r: number;
  g: number;
  b: number;
  a: number;
}

export class DebrisSystem {
  private chunks: Chunk[] = [];
  private rngState = PRNG_SEED;
  // Breaks shown and chunks thrown since the last `reset`. Nothing reads them;
  // they exist so the shower is OBSERVABLE from a test, the way the spark
  // system's counters are - debris reaches no digest and no invariant, so
  // without them "the wall shattered" and "the wall vanished" are the same
  // thing to everything but a person looking at the screen.
  breaks = 0;
  spawned = 0;

  // Turn one frame's breaks into chunks. Called once per sim step, from inside
  // the catch-up loop, so a stall drops nothing.
  //
  // The body is read HERE and never afterwards: it has left the world by now
  // (the level removed it the moment it broke), and what is taken off it is its
  // outline, its colour and the speed it was travelling at - facts about the
  // frame it broke on, not a handle kept into the next one.
  ingest(events: readonly BreakEvent[]): void {
    for (const e of events) {
      this.breaks++;
      const body = e.body;
      const overdrive = e.threshold > 0 ? Math.max(1, e.force / e.threshold) : 1;
      const kick = clamp(KICK_PER_OVERDRIVE * overdrive, KICK_MIN, KICK_MAX);
      const spin = Math.min(SPIN_PER_OVERDRIVE * overdrive, SPIN_MAX);
      const carried = body instanceof RigidBody2D ? body.linearVelocity : Vec2.ZERO;
      for (const piece of outlines(body)) {
        for (const chunk of this.shatter(piece)) {
          this.spawn(chunk, e, kick, spin, carried, body);
        }
      }
    }
  }

  // On the render clock, outside the fixed step - like the sparks and the
  // camera ease, because none of it is simulation.
  advance(dt: number): void {
    const step = Math.min(dt, 0.1);
    if (step <= 0) return;
    const drag = Math.max(0, 1 - DRAG * step);
    let live = 0;
    for (const c of this.chunks) {
      c.age += step;
      if (c.age >= c.ttl) continue;
      c.vx *= drag;
      c.vy = (c.vy + GRAVITY * step) * drag;
      c.x += c.vx * step;
      c.y += c.vy * step;
      c.rot += c.spin * step;
      this.chunks[live++] = c;
    }
    this.chunks.length = live;
  }

  // World space, over everything else, exactly where the sparks are drawn - so
  // one implementation serves both the 2D renderer and the 3D one (the overlay
  // is drawn over the scene, and the gameplay plane is where the two agree).
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.chunks.length === 0) return;
    ctx.save();
    ctx.lineJoin = "round";
    for (const c of this.chunks) {
      const { r, g, b } = c;
      const t = c.age / c.ttl;
      const fade = t < 1 - FADE_FRACTION ? 1 : Math.max(0, (1 - t) / FADE_FRACTION);
      const alpha = c.a * fade;
      const cos = Math.cos(c.rot);
      const sin = Math.sin(c.rot);
      ctx.beginPath();
      for (let i = 0; i < c.verts.length; i++) {
        const v = c.verts[i]!;
        const x = c.x + v.x * cos - v.y * sin;
        const y = c.y + v.x * sin + v.y * cos;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
      ctx.fill();
      // The same edge a body draws, so a chunk in flight is recognisably a
      // piece of the wall it came out of rather than a flat silhouette.
      ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(1, alpha * 1.6).toFixed(3)})`;
      ctx.lineWidth = PX;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Kill everything and reseed, so a restart does not carry the dead level's
  // rubble and two runs of the same bundle draw the same shower.
  reset(): void {
    this.chunks.length = 0;
    this.rngState = PRNG_SEED;
    this.breaks = 0;
    this.spawned = 0;
  }

  private spawn(
    verts: Vec2[],
    e: BreakEvent,
    kick: number,
    spin: number,
    carried: Vec2,
    body: CollisionObject2D,
  ): void {
    if (this.chunks.length >= MAX_CHUNKS) return;
    const c = centroid(verts);
    // Out from where the blow landed, biased along the way it was travelling
    // (the normal points OUT of the broken surface, so the blow came the other
    // way).
    let ax = c.x - e.point.x;
    let ay = c.y - e.point.y;
    const len = Math.hypot(ax, ay);
    if (len > 1e-6) {
      ax /= len;
      ay /= len;
    } else {
      ax = -e.normal.x;
      ay = -e.normal.y;
    }
    const dx = ax * (1 - KICK_ALONG) - e.normal.x * KICK_ALONG;
    const dy = ay * (1 - KICK_ALONG) - e.normal.y * KICK_ALONG;
    const dlen = Math.hypot(dx, dy) || 1;
    // Uneven: a shower in which every piece leaves at the same speed reads as
    // one object expanding.
    const speed = kick * (0.4 + 1.2 * this.rand());
    const rgba = colorOf(body);
    this.chunks.push({
      verts: verts.map((v) => v.sub(c)),
      x: c.x,
      y: c.y,
      rot: 0,
      vx: carried.x + (dx / dlen) * speed,
      vy: carried.y + (dy / dlen) * speed,
      spin: (this.rand() * 2 - 1) * spin,
      age: 0,
      ttl: TTL_MIN + this.rand() * (TTL_MAX - TTL_MIN),
      ...rgba,
    });
    this.spawned++;
  }

  // Cut one convex loop into chunk-sized convex pieces.
  private shatter(verts: Vec2[]): Vec2[][] {
    const bounds = extent(verts);
    const want = clamp(
      Math.round((bounds.x * bounds.y) / (CHUNK_SIZE * CHUNK_SIZE)),
      MIN_CHUNKS,
      MAX_CHUNKS_PER_PIECE,
    );
    let pieces = [verts];
    // Each pass cuts every piece in two, so the count doubles: a target of 12
    // is four passes, and the biggest piece is always the one worth cutting.
    while (pieces.length < want) {
      const next: Vec2[][] = [];
      for (const piece of pieces) {
        const halves = this.cut(piece);
        if (halves) next.push(halves[0], halves[1]);
        else next.push(piece);
      }
      if (next.length === pieces.length) break;
      pieces = next;
    }
    return pieces;
  }

  // One half-plane cut through a point near the loop's centre, at a random
  // angle. Null where the cut left nothing on one side, which a degenerate
  // sliver can do.
  private cut(verts: Vec2[]): [Vec2[], Vec2[]] | null {
    if (verts.length < 3) return null;
    const c = centroid(verts);
    const size = extent(verts);
    const px = c.x + (this.rand() * 2 - 1) * CUT_JITTER * size.x;
    const py = c.y + (this.rand() * 2 - 1) * CUT_JITTER * size.y;
    const angle = this.rand() * Math.PI;
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const front = clip(verts, px, py, nx, ny);
    const back = clip(verts, px, py, -nx, -ny);
    if (front.length < 3 || back.length < 3) return null;
    return [front, back];
  }

  private rand(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) | 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// Sutherland-Hodgman against one half-plane: the part of the loop on the side
// the normal points away from (`(v - p)·n <= 0`), which for a convex loop is
// itself convex.
function clip(verts: readonly Vec2[], px: number, py: number, nx: number, ny: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const da = (a.x - px) * nx + (a.y - py) * ny;
    const db = (b.x - px) * nx + (b.y - py) * ny;
    if (da <= 0) out.push(a);
    if (da * db < 0) {
      const t = da / (da - db);
      out.push(new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
    }
  }
  return out;
}

// What a broken body was, as world-space convex loops. A circle has no vertex
// loop of its own, so it is drawn round here at the one resolution a chunk of
// it could ever need.
const CIRCLE_STEPS = 12;

// What a body with no authored fill breaks into: the renderer's own grey.
const DEFAULT_CHUNK_COLOR = "#8b8b8b";

function outlines(body: CollisionObject2D): Vec2[][] {
  const out: Vec2[][] = [];
  for (const shape of body.getShapes()) {
    if (shape.hidden) continue;
    const s = shape.shape;
    if (s.kind === "circle") {
      const c = shape.globalPosition;
      const loop: Vec2[] = [];
      for (let i = 0; i < CIRCLE_STEPS; i++) {
        const a = (i / CIRCLE_STEPS) * Math.PI * 2;
        loop.push(new Vec2(c.x + Math.cos(a) * s.radius, c.y + Math.sin(a) * s.radius));
      }
      out.push(loop);
      continue;
    }
    if (shapeVertices(s).length < 3) continue;
    out.push(shape.worldVertices().map((v) => v));
  }
  return out;
}

function colorOf(body: CollisionObject2D): { r: number; g: number; b: number; a: number } {
  const { r, g, b } = hexToRgb(body.fillColor ?? DEFAULT_CHUNK_COLOR);
  return {
    r,
    g,
    b,
    // Never see-through: a chunk is a piece of a solid thing, and a body's fill
    // opacity is about the wall reading as a wall against what is behind it,
    // not about its rubble.
    a: Math.max(0.65, body.fillOpacity),
  };
}

function centroid(verts: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const v of verts) {
    x += v.x;
    y += v.y;
  }
  return new Vec2(x / verts.length, y / verts.length);
}

function extent(verts: readonly Vec2[]): Vec2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of verts) {
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
  }
  return new Vec2(maxX - minX, maxY - minY);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
