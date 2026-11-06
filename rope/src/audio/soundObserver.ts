// What the level SOUNDS like this step, as plain numbers (docs/sound.md#what-is-heard).
//
// The observer reads a `BallLevel` after each sim step and writes nothing back:
// the sparks' rule (`level/sparkEvents.ts`), held the same way - a watcher of
// the world, stepped by the same `stepLevel` as the sparks, the debris and the
// reeling chain, and skipped where they are (a replay seeking through frames).
// What it hands on is a `SoundStep`, which `AudioOut` turns into sound by the
// events' assigned files (audio/slots.ts); nothing here knows about Web Audio,
// so a recording can be run through it headlessly and what it would have
// played read off.
//
// Most of it is read straight off the world - the ball's contacts, speeds and
// spin, the coil, how deep it is in water. The hook's touches are the
// exception, because the sim keeps them to itself (an attach removes the hook
// inside its own step), and come through `BallLevel.soundEvents`.

import { WaterArea, type CollisionObject2D, type CollisionShape2D } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import { GRAVITY } from "../engine/world";
import type { BallLevel } from "../level/ballLevel";
import { CHAIN_LINK_LEN } from "../render/chainMetrics";
import { surfaceOf, type SurfaceKind } from "./surfaces";

// One surface the ball is rolling on this step.
export interface RollState {
  // How fast the contact moves across the surface, m/s: the ball's own speed
  // along it, relative to the surface.
  speed: number;
  x: number;
}

// The ball LANDING on a piece, or the cuff ATTACHING to or BOUNCING off one.
export interface StrikeCue {
  family: "land" | "attach" | "bounce";
  surface: SurfaceKind;
  // Into the surface, m/s (an attach: the cuff's whole speed, which it spends
  // there).
  speed: number;
  x: number;
  // When in the step it happened, 0..1 (the hook's touches are taken at the
  // moment of contact; the ball's at the end of the step).
  at: number;
}

// One link winding onto the ball.
export interface ClinkCue {
  // How fast the chain was winding on, m/s.
  speed: number;
  x: number;
  at: number;
}

export interface SoundStep {
  roll: Map<SurfaceKind, RollState>;
  strikes: StrikeCue[];
  clinks: ClinkCue[];
  // The ball going into water this step, at this speed (m/s), or null.
  splash: { speed: number; x: number } | null;
  // Moving through the water at the surface: the speed relative to the water,
  // and how much of the ball is AT the surface (1 half in, 0 dry or under).
  wade: { speed: number; interface: number; x: number };
  // The ball's speed through the air (none of it under water).
  air: { speed: number; x: number };
}

// A hook's touch is a STRIKE only where it is an arrival: the first report
// after `ARRIVAL_GAP_STEPS` silent ones. A tip dragged along a hook-proof
// face is re-deflected every step, and the normal speeds those report are the
// face's facets rather than new hits (docs/sparks.md, the same rule the burst
// follows and the same number it uses).
const ARRIVAL_GAP_STEPS = 2;

// Strikes slower than this are not played at all: a strike's level is linear
// in its speed, so this is 30 dB under one at a typical reference of 5 m/s,
// and a dragged or settling body reports a great many of them.
export const STRIKE_MIN_SPEED = 0.15;

// The ball's contact with a piece is a fresh ARRIVAL after this many steps
// without one; shorter gaps are the same touch flickering as the ball rolls
// over a seam.
const BALL_ARRIVAL_GAP_STEPS = 3;

export class SoundObserver {
  private level: BallLevel | null = null;
  private dt = 1 / 60;
  // The ball's state at the end of the previous step.
  private prevVelocity = Vec2.ZERO;
  private prevSubmerged = 0;
  // The coil: which chain it is on, its length last step, and the high-water
  // mark the last clink was struck at.
  private coilChain: unknown = null;
  private coilLength = 0;
  private coilMark = 0;
  // The step each hook source last reported a touch on, and each piece the
  // ball last touched on.
  private step = 0;
  private hookLastTouch = new Map<number, number>();
  private ballLastTouch = new Map<CollisionShape2D, number>();
  private readonly surfaceCache = new Map<CollisionShape2D, SurfaceKind>();

  // Read one sim step of `level`.
  observe(level: BallLevel, dt: number): SoundStep {
    if (level !== this.level) this.reset(level);
    this.dt = dt;
    this.step++;
    const ball = level.ball;
    const out: SoundStep = {
      roll: new Map(),
      strikes: [],
      clinks: [],
      splash: null,
      wade: { speed: 0, interface: 0, x: ball.globalPosition.x },
      air: { speed: 0, x: ball.globalPosition.x },
    };
    if (level.shatteredFrame !== null) {
      // A broken ball is held inert until it respawns: nothing rolls, nothing
      // winds, and the shards are their own sound.
      this.carry(level);
      return out;
    }
    this.readHook(level, out);
    this.readBallContacts(level, out);
    this.readCoil(level, out);
    this.readWater(level, out);
    this.readAir(level, out);
    this.carry(level);
    return out;
  }

  private reset(level: BallLevel): void {
    this.level = level;
    this.prevVelocity = level.ball.linearVelocity;
    this.prevSubmerged = level.ball.submerged;
    this.coilChain = null;
    this.coilLength = 0;
    this.coilMark = 0;
    this.hookLastTouch.clear();
    this.ballLastTouch.clear();
    this.surfaceCache.clear();
  }

  private carry(level: BallLevel): void {
    this.prevVelocity = level.ball.linearVelocity;
    this.prevSubmerged = level.ball.submerged;
    // Forget sources long silent, so the maps do not grow across a session
    // that mints a hook per throw.
    if (this.step % 600 === 0) {
      for (const [k, at] of this.hookLastTouch) if (this.step - at > 600) this.hookLastTouch.delete(k);
      for (const [k, at] of this.ballLastTouch) if (this.step - at > 600) this.ballLastTouch.delete(k);
    }
  }

  private surface(piece: CollisionShape2D | null, body: CollisionObject2D): SurfaceKind {
    if (piece === null) return surfaceOf(null, body);
    let kind = this.surfaceCache.get(piece);
    if (kind === undefined) {
      kind = surfaceOf(piece, body);
      this.surfaceCache.set(piece, kind);
    }
    return kind;
  }

  private readHook(level: BallLevel, out: SoundStep): void {
    // One strike per hook per step: the hardest of its reports (a flight
    // sweep and a probe may both report one touch).
    const best = new Map<number, StrikeCue>();
    for (const e of level.soundEvents) {
      const last = this.hookLastTouch.get(e.source);
      this.hookLastTouch.set(e.source, this.step);
      const arriving = e.kind === "attach" || e.fromFlight || last === undefined || this.step - last > ARRIVAL_GAP_STEPS;
      if (!arriving) continue;
      // A bounce strikes at its speed INTO the face - a throw skimmed flat
      // along a floor is a graze, not a clank. An attach has no normal, and
      // needs none: the cuff stops dead in what it bit, so the whole of its
      // speed is spent there.
      const into = e.normal !== null ? Math.max(0, -e.vel.dot(e.normal)) : e.vel.length();
      if (into < STRIKE_MIN_SPEED) continue;
      const cue: StrikeCue = {
        family: e.kind,
        surface: this.surface(e.piece, e.body),
        speed: into,
        x: e.point.x,
        at: 0.5,
      };
      const held = best.get(e.source);
      if (held === undefined || held.speed < cue.speed) best.set(e.source, cue);
    }
    out.strikes.push(...best.values());
  }

  private readBallContacts(level: BallLevel, out: SoundStep): void {
    const ball = level.ball;
    const dt = this.dt;
    // What the ball was arriving with: last step's velocity and this step's
    // gravity, before the contact solve answered it.
    const arrival = this.prevVelocity.add(GRAVITY.mul(dt));
    const seen = new Set<CollisionShape2D>();
    for (const c of level.world.frameContacts) {
      const ballIsA = c.a === ball;
      if (!ballIsA && c.b !== ball) continue;
      const other = ballIsA ? c.b : c.a;
      const piece = other.getShapes()[ballIsA ? c.shapeB : c.shapeA] ?? null;
      if (piece === null || seen.has(piece)) continue;
      seen.add(piece);
      // Out of the surface, toward the ball.
      const normal = ballIsA ? c.normal : c.normal.neg();
      const surfaceVel = other.velocityAtPoint(c.point);
      const rel = ball.linearVelocity.sub(surfaceVel);
      const tangent = new Vec2(-normal.y, normal.x);
      const kind = this.surface(piece, other);
      const state: RollState = { speed: Math.abs(rel.dot(tangent)), x: c.point.x };
      // Two pieces of one surface under the ball (a seam) are one roll.
      const held = out.roll.get(kind);
      if (held === undefined || state.speed > held.speed) out.roll.set(kind, state);
      // An arrival on this piece: how fast the ball came INTO it.
      const last = this.ballLastTouch.get(piece);
      this.ballLastTouch.set(piece, this.step);
      if (last === undefined || this.step - last > BALL_ARRIVAL_GAP_STEPS) {
        const into = -arrival.sub(surfaceVel).dot(normal);
        if (into >= STRIKE_MIN_SPEED) {
          out.strikes.push({ family: "land", surface: kind, speed: into, x: c.point.x, at: 1 });
        }
      }
    }
  }

  private readCoil(level: BallLevel, out: SoundStep): void {
    const ball = level.ball;
    const chain = ball.chain;
    const length = chain?.coiledLength ?? 0;
    if (chain !== this.coilChain) {
      // A new throw is a new chain: whatever it starts with is not winding.
      this.coilChain = chain;
      this.coilLength = length;
      this.coilMark = length;
      return;
    }
    const before = this.coilLength;
    this.coilLength = length;
    if (length < this.coilMark) {
      // Unwinding lifts links off the ball, which strikes nothing; the mark
      // follows it down, so winding back on clinks from where it now is.
      this.coilMark = length;
      return;
    }
    const wound = length - before;
    if (wound <= 0) return;
    const speed = wound / this.dt;
    while (this.coilMark + CHAIN_LINK_LEN <= length) {
      this.coilMark += CHAIN_LINK_LEN;
      const at = Math.min(1, Math.max(0, (this.coilMark - before) / wound));
      out.clinks.push({ speed, x: ball.globalPosition.x, at });
    }
  }

  private readWater(level: BallLevel, out: SoundStep): void {
    const ball = level.ball;
    const s = ball.submerged;
    if (s <= 0) return;
    let flow = Vec2.ZERO;
    for (const b of level.world.bodies) {
      if (b instanceof WaterArea && !b.removed) {
        flow = b.flowVelocity;
        break;
      }
    }
    const rel = ball.linearVelocity.sub(flow);
    if (this.prevSubmerged <= 0) {
      // Into the water from above: the downward speed (+y is down).
      const down = Math.max(0, this.prevVelocity.y + GRAVITY.y * this.dt);
      if (down >= STRIKE_MIN_SPEED) out.splash = { speed: down, x: ball.globalPosition.x };
    }
    out.wade = { speed: rel.length(), interface: Math.max(0, 4 * s * (1 - s)), x: ball.globalPosition.x };
  }

  private readAir(level: BallLevel, out: SoundStep): void {
    const ball = level.ball;
    // A ball under water is not moving through air.
    const speed = ball.linearVelocity.length() * (1 - ball.submerged);
    out.air = { speed, x: ball.globalPosition.x };
  }
}
