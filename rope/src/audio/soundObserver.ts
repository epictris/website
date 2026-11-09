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

import { PhysicsBody2D, WaterArea, type CollisionObject2D, type CollisionShape2D } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import { GRAVITY } from "../engine/world";
import type { BallLevel } from "../level/ballLevel";
import { CHAIN_LINK_LEN } from "../render/chainMetrics";
import { surfaceOf, type SurfaceKind } from "./surfaces";
import { ChainSurfaceAudio, type ChainSurfaceCue, type ChainImpactCue } from "./chainSurfaceAudio";
import { ChainArticulationAudio, type ChainJingleCue } from "./chainArticulationAudio";
import { WindMotion } from "./windMotion";
import { BallPlayer } from "../classes/ballPlayer";

// One surface the ball is rolling on this step.
export interface RollState {
  // How fast the geometric contact patch travels along the contacted surface,
  // m/s, including the mounting loop and excluding rigid scenery motion.
  speed: number;
  x: number;
  y: number;
}

// The ball LANDING on a piece, or the cuff ATTACHING to or BOUNCING off one.
export interface StrikeCue {
  family: "land" | "loop-hit" | "ball-settle" | "attach" | "bounce";
  source?: "ball" | "loop";
  surface: SurfaceKind;
  // Into the surface, m/s (an attach: the cuff's whole speed, which it spends
  // there).
  speed: number;
  x: number;
  y: number;
  // When in the step it happened, 0..1 (the hook's touches are taken at the
  // moment of contact; the ball's at the end of the step).
  at: number;
}

// One link winding onto the ball.
export interface ClinkCue {
  // How fast the chain was winding on, m/s.
  speed: number;
  x: number;
  y: number;
  at: number;
}

export interface SoundStep {
  roll: Map<SurfaceKind, RollState>;
  strikes: StrikeCue[];
  clinks: ClinkCue[];
  deploy: { speed: number; x: number; y: number };
  slack: { speed: number; x: number; y: number };
  creak: { speed: number; x: number; y: number };
  creaks: { speed: number; x: number; y: number; angularSpeed: number; load: number }[];
  wraps: { speed: number; x: number; y: number; surface: SurfaceKind; load: number; at?: number }[];
  hookDrag?: ChainSurfaceCue | null;
  drag?: ChainSurfaceCue | null;
  chainImpacts?: ChainImpactCue[];
  jingles?: ChainJingleCue[];
  taut: { speed: number; x: number; y: number } | null;
  // The ball going into water this step, at this speed (m/s), or null.
  splash: { speed: number; x: number; y: number } | null;
  // Moving through the water at the surface: the speed relative to the water,
  // and how much of the ball is AT the surface (1 half in, 0 dry or under).
  wade: { speed: number; interface: number; x: number; y: number };
  // The ball's speed through the air (none of it under water).
  air: { speed: number; acceleration?: number; x: number; y: number };
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
// Emission parameters, independent of the file: angular travel in radians,
// minimum time between phrases, and rest time before a fresh movement onset.
const CREAK_ONSET_TRAVEL = 0.03;
const CREAK_CONTINUE_TRAVEL = 0.18;
const CREAK_GAP = 0.25;
const CREAK_REARM_REST = 0.12;
interface WrapState {
  local: Vec2;
  distance: number;
  bend: number;
  travel: number;
  lastPlayed: number;
  loaded: boolean;
  lastSeen: number;
}

export class SoundObserver {
  private readonly chainSurface = new ChainSurfaceAudio();
  private readonly articulation = new ChainArticulationAudio();
  private readonly windMotion = new WindMotion();
  private level: BallLevel | null = null;
  private attempt = -1;
  private dt = 1 / 60;
  // The ball's state at the end of the previous step.
  private prevVelocity = Vec2.ZERO;
  private prevAngularVelocity = 0;
  private prevSubmerged = 0;
  // The coil: which chain it is on, its length last step, and the high-water
  // mark the last clink was struck at.
  private coilChain: unknown = null;
  private coilLength = 0;
  private coilMark = 0;
  private motionChain: unknown = null;
  private materialCoil = 0;
  private previousNodes: readonly Vec2[] = [];
  private previousSlack: number | null = null;
  private slackArmed = false;
  private wasDeploying = false;
  private payoutSpeed = 0;
  private previousPull: Vec2 | null = null;
  private creakTravel = 0;
  private creakCooldown = 0;
  private creakRest = CREAK_REARM_REST;
  private creakDirection = 0;
  private creakOnsetPending = true;
  private wrapContacts = new Map<CollisionShape2D, WrapState>();
  private activeWraps = new Set<CollisionShape2D>();
  // The step each hook source last reported a touch on, and each piece the
  // ball last touched on.
  private step = 0;
  private hookLastTouch = new Map<number, number>();
  private ballLastTouch = new Map<CollisionShape2D, { step: number; normal: Vec2 }>();
  private loopLastTouch = new Map<CollisionShape2D, { step: number; normal: Vec2 }>();
  private readonly surfaceCache = new Map<CollisionShape2D, SurfaceKind>();
  private rollContacts = new Map<CollisionShape2D, Map<number, { local: Vec2; normal: Vec2; feature: number }>>();
  private loopReturn: { body: CollisionObject2D; normal: Vec2; age: number } | null = null;

  // Read one sim step of `level`.
  observe(level: BallLevel, dt: number): SoundStep {
    if (level !== this.level || level.attempt !== this.attempt) this.reset(level);
    this.dt = dt;
    this.step++;
    const ball = level.ball;
    const out: SoundStep = {
      roll: new Map(),
      strikes: [],
      clinks: [],
      deploy: { speed: 0, x: ball.globalPosition.x, y: ball.globalPosition.y },
      slack: { speed: 0, x: ball.globalPosition.x, y: ball.globalPosition.y },
      creak: { speed: 0, x: ball.globalPosition.x, y: ball.globalPosition.y },
      creaks: [],
      wraps: [],
      taut: null,
      splash: null,
      wade: { speed: 0, interface: 0, x: ball.globalPosition.x, y: ball.globalPosition.y },
      air: { speed: 0, x: ball.globalPosition.x, y: ball.globalPosition.y },
    };
    if (level.shatteredFrame !== null) {
      this.windMotion.reset();
      // A broken ball is held inert until it respawns: nothing rolls, nothing
      // winds, and the shards are their own sound.
      this.carry(level);
      this.rollContacts.clear();
      this.loopReturn = null;
      this.previousNodes = [];
      this.slackArmed = false;
      this.wasDeploying = false;
      this.previousPull = null;
      this.resetFriction();
      return out;
    }
    this.readHook(level, out);
    this.readBallContacts(level, out);
    this.readCoil(level, out);
    this.readChainMotion(level, out);
    this.readWater(level, out);
    this.readAir(level, out);
    this.carry(level);
    return out;
  }

  private reset(level: BallLevel): void {
    this.windMotion.reset();
    this.level = level;
    this.attempt = level.attempt;
    this.prevVelocity = level.ball.linearVelocity;
    this.prevAngularVelocity = level.ball.angularVelocity;
    this.prevSubmerged = level.ball.submerged;
    this.coilChain = null;
    this.coilLength = 0;
    this.coilMark = 0;
    // A level may open already attached. That initial chain is not a throw.
    this.motionChain = level.ball.chain;
    this.previousNodes = [];
    this.previousSlack = null;
    this.slackArmed = false;
    this.wasDeploying = false;
    this.payoutSpeed = 0;
    this.previousPull = null;
    this.resetFriction();
    this.hookLastTouch.clear();
    this.ballLastTouch.clear();
    this.loopLastTouch.clear();
    this.surfaceCache.clear();
    this.rollContacts.clear();
    this.loopReturn = null;
  }

  private carry(level: BallLevel): void {
    this.prevVelocity = level.ball.linearVelocity;
    this.prevAngularVelocity = level.ball.angularVelocity;
    this.prevSubmerged = level.ball.submerged;
    // Forget sources long silent, so the maps do not grow across a session
    // that mints a hook per throw.
    if (this.step % 600 === 0) {
      for (const [k, at] of this.hookLastTouch) if (this.step - at > 600) this.hookLastTouch.delete(k);
      for (const [k, touch] of this.ballLastTouch) if (this.step - touch.step > 600) this.ballLastTouch.delete(k);
      for (const [k, touch] of this.loopLastTouch) if (this.step - touch.step > 600) this.loopLastTouch.delete(k);
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
      // Sliding is continuous contact, independent of slack and of whether a
      // bounce qualifies as a fresh strike. Both pull directions scrape.
      if (e.kind === "bounce" && e.normal && !level.ball.hookInFlight) {
        const slide = e.vel.sub(e.normal.mul(e.vel.dot(e.normal))).length() * (1 - level.ball.submerged);
        if (slide > 0.06 && (!out.hookDrag || slide > out.hookDrag.speed)) {
          out.hookDrag = { speed: slide, x: e.point.x, y: e.point.y, surface: this.surface(e.piece, e.body) };
        }
      }
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
        x: e.point.x, y: e.point.y,
        at: 0.5,
      };
      const held = best.get(e.source);
      if (held === undefined || held.speed < cue.speed) best.set(e.source, cue);
    }
    // Slow sliding can be handled wholly by the contact solver without a
    // probe bounce. Read those force-bearing hook contacts as well.
    const tip = level.ball.chainTip;
    if (tip && !level.ball.hookInFlight) {
      for (const c of level.world.frameContacts) {
        const isA = c.a === tip;
        if ((!isA && c.b !== tip) || c.maxNormalImpulse <= 0) continue;
        const other = isA ? c.b : c.a;
        const normal = isA ? c.normal : c.normal.neg();
        const relative = tip.linearVelocity.sub(other.velocityAtPoint(c.point));
        const slide = relative.sub(normal.mul(relative.dot(normal))).length() * (1 - level.ball.submerged);
        if (slide > 0.06 && (!out.hookDrag || slide > out.hookDrag.speed)) {
          const piece = other.getShapes()[isA ? c.shapeB : c.shapeA] ?? null;
          out.hookDrag = { speed: slide, x: c.point.x, y: c.point.y, surface: this.surface(piece, other) };
        }
      }
    }
    out.strikes.push(...best.values());
  }

  private readBallContacts(level: BallLevel, out: SoundStep): void {
    const ball = level.ball;
    const dt = this.dt;
    const nextRollContacts: typeof this.rollContacts = new Map();
    if (this.loopReturn) {
      this.loopReturn.age += dt;
      if (this.loopReturn.age > .25) this.loopReturn = null;
    }
    // What the ball was arriving with: last step's velocity and this step's
    // gravity, before the contact solve answered it.
    const arrival = this.prevVelocity.add(GRAVITY.mul(dt));
    // Snapshot before reading this frame: new contacts must not suppress one
    // another, but a seam between supporting pieces is continuous rolling.
    const recent = [...this.ballLastTouch.values()].filter(touch => this.step - touch.step <= BALL_ARRIVAL_GAP_STEPS);
    const recentLoop = [...this.loopLastTouch.values()].filter(touch => this.step - touch.step <= BALL_ARRIVAL_GAP_STEPS);
    const seen = new Set<CollisionShape2D>();
    const seenLoop = new Set<CollisionShape2D>();
    for (const c of level.world.frameContacts) {
      const ballIsA = c.a === ball;
      if (!ballIsA && c.b !== ball) continue;
      // Broad-phase/speculative contacts can be separated and carry no force.
      // Approaching their tilted normals while rolling is not a collision.
      if (c.maxNormalImpulse <= 0) continue;
      const other = ballIsA ? c.b : c.a;
      const piece = other.getShapes()[ballIsA ? c.shapeB : c.shapeA] ?? null;
      const ballShapeIndex = ballIsA ? c.shapeA : c.shapeB;
      const loop = ballShapeIndex === BallPlayer.LOOP_SHAPE_INDEX;
      const contactSeen = loop ? seenLoop : seen;
      if (piece === null || contactSeen.has(piece)) continue;
      contactSeen.add(piece);
      // Out of the surface, toward the ball.
      const normal = ballIsA ? c.normal : c.normal.neg();
      const surfaceVel = other.velocityAtPoint(c.point);
      const tangent = new Vec2(-normal.y, normal.x);
      const kind = this.surface(piece, other);
      // Both avatar shapes are circles. Track the geometric patch, not the
      // material point's velocity (which is zero in ideal no-slip rolling).
      // Reconstruct it from the circle and normal, avoiding solver point jitter.
      const shape = ball.getShapes()[ballShapeIndex];
      if (shape?.shape.kind === "circle") {
        const patch = shape.globalPosition.sub(normal.mul(shape.shape.radius));
        const local = patch.sub(other.globalPosition).rotated(-other.globalRotation);
        const localNormal = normal.rotated(-other.globalRotation);
        const previous = this.rollContacts.get(piece)?.get(ballShapeIndex);
        // First touch has no measured displacement. The circle centre's
        // tangential velocity is the instantaneous flat-face limit, including
        // the loop's offset/rotation. Normal migration is measured thereafter.
        const centreMotion = ball.velocityAtPoint(shape.globalPosition).sub(other.velocityAtPoint(patch));
        let speed = Math.abs(centreMotion.dot(tangent));
        if (previous && previous.feature === c.featureId && previous.normal.dot(localNormal) > 0.9 && dt > 0) {
          const n = previous.normal.add(localNormal).normalized();
          speed = Math.abs(local.sub(previous.local).dot(new Vec2(-n.y, n.x))) / dt;
        }
        // Position correction can shuffle a resting patch without physical
        // motion. Below 5 mm/s of relative circle-centre motion, treat it as
        // settled rather than amplifying solver jitter into rolling texture.
        if (centreMotion.length() < .005) speed = 0;
        let contacts = nextRollContacts.get(piece);
        if (!contacts) nextRollContacts.set(piece, contacts = new Map());
        // Distinct pieces have distinct normals/patches, even on one body.
        // Switching support must not turn their separation into apparent travel.
        if (!contacts.has(ballShapeIndex)) contacts.set(ballShapeIndex, { local, normal: localNormal, feature: c.featureId });
        const state: RollState = { speed, x: patch.x, y: patch.y };
        const held = out.roll.get(kind);
        if (held === undefined || state.speed > held.speed) out.roll.set(kind, state);
      }
      // An arrival on this piece: how fast the ball came INTO it.
      const touches = loop ? this.loopLastTouch : this.ballLastTouch;
      const last = touches.get(piece);
      touches.set(piece, { step: this.step, normal });
      const continuingSupport = (loop ? recentLoop : [...recent, ...recentLoop]).some(touch => touch.normal.dot(normal) > 0.9);
      const returning = !loop && this.loopReturn?.body === other && this.loopReturn.normal.dot(normal.rotated(-other.globalRotation)) > .9;
      if (returning || (!continuingSupport && (last === undefined || this.step - last.step > BALL_ARRIVAL_GAP_STEPS))) {
        // The mounting ring can strike while the centre is still supported.
        // Include its rotational point velocity, independently of rim contacts.
        const arm = c.point.sub(ball.globalPosition);
        const pointArrival = loop ? arrival.add(new Vec2(-arm.y, arm.x).mul(this.prevAngularVelocity)) : arrival;
        const into = -pointArrival.sub(surfaceVel).dot(normal);
        const settle = returning && into < 3;
        if (returning) this.loopReturn = null;
        if (into >= (settle ? .04 : STRIKE_MIN_SPEED)) {
          out.strikes.push({ family: loop ? "loop-hit" : settle ? "ball-settle" : "land", source: loop ? "loop" : "ball", surface: kind, speed: into, x: c.point.x, y: c.point.y, at: 1 });
        }
      }
    }
    for (const [piece, contacts] of nextRollContacts) {
      const loop = contacts.get(BallPlayer.LOOP_SHAPE_INDEX);
      const rimSupported = [...nextRollContacts].some(([other, shapes]) => other.owner === piece.owner && shapes.has(0));
      if (loop && !rimSupported) this.loopReturn = { body: piece.owner, normal: loop.normal, age: 0 };
    }
    this.rollContacts = nextRollContacts;
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
      out.clinks.push({ speed, x: ball.globalPosition.x, y: ball.globalPosition.y, at });
    }
  }

  private readChainMotion(level: BallLevel, out: SoundStep): void {
    const ball = level.ball;
    const chain = ball.chain;
    const changed = chain !== this.motionChain;
    const materialSpeed = changed || !chain ? 0 : Math.abs(chain.coiledLength - this.materialCoil) / this.dt;
    this.materialCoil = chain?.coiledLength ?? 0;
    this.motionChain = chain;
    if (!chain || ball.chainStowed) {
      this.previousNodes = [];
      this.previousSlack = null;
      this.previousPull = null;
      this.slackArmed = false;
      this.wasDeploying = false;
      this.resetFriction();
      return;
    }
    // A throw that attaches inside one step has no remaining payout to play.
    if (changed) {
      this.previousNodes = [];
      this.previousSlack = null;
      this.previousPull = null;
      this.slackArmed = false;
      this.wasDeploying = false;
      this.resetFriction();
    }
    const loose = chain.maxRopeLength - chain.getCurrentLength();
    if (ball.hookInFlight) {
      out.deploy.speed = ball.hookInFlight.linearVelocity.length();
      this.payoutSpeed = out.deploy.speed;
    }
    if (!ball.hookInFlight) {
      // Hysteresis: a chain must acquire real slack before it can catch again.
      // Small solver fluctuations near full extension cannot retrigger it.
      const instantCatch = changed ? Math.max(0, ...out.strikes.filter(s => s.family === "attach").map(s => s.speed)) : 0;
      if (loose <= 0.015 && (this.slackArmed || this.wasDeploying || instantCatch > 0)) {
        const speed = this.wasDeploying ? this.payoutSpeed : instantCatch || Math.max(0, ((this.previousSlack ?? loose) - loose) / this.dt);
        if (speed >= STRIKE_MIN_SPEED) out.taut = { speed, x: ball.globalPosition.x, y: ball.globalPosition.y };
        this.slackArmed = false;
      }
      if (loose > 0.06) this.slackArmed = true;
      this.previousSlack = loose;
    }
    this.wasDeploying = ball.hookInFlight !== null;

    const pull = chain.startPull();
    const beforePull = this.previousPull;
    const topologyChanged = this.readWrapContacts(level, loose, !changed && beforePull === null, out);
    this.previousPull = pull;
    this.creakCooldown = Math.max(0, this.creakCooldown - this.dt);
    let rubbing = false;
    if (!ball.hookInFlight && !changed && !topologyChanged && loose <= 0.03 && pull && beforePull && level.chainTension > 0) {
      // Direction changes at the ball-side span approximate link articulation
      // under load. A taut chain moving bodily without turning does not squeak.
      const cross = beforePull.x * pull.y - beforePull.y * pull.x;
      const signedAngle = Math.atan2(cross, beforePull.dot(pull));
      const angularSpeed = Math.abs(signedAngle) / this.dt;
      if (angularSpeed >= 0.03) {
        rubbing = true;
        const weight = Math.max(1, ball.mass * GRAVITY.length());
        const load = Math.min(2, Math.sqrt(level.chainTension / weight));
        out.creak.speed = Math.min(3, angularSpeed) * load * (1 - ball.submerged);
        const direction = Math.sign(signedAngle);
        const freshMotion = this.creakRest >= CREAK_REARM_REST || this.creakDirection !== direction;
        if (freshMotion) this.creakOnsetPending = true;
        this.creakTravel += Math.abs(signedAngle);
        const threshold = this.creakOnsetPending ? CREAK_ONSET_TRAVEL : CREAK_CONTINUE_TRAVEL;
        if (out.creak.speed > 0.03 && this.creakTravel >= threshold && this.creakCooldown === 0) {
          out.creaks.push({ ...out.creak, angularSpeed, load });
          this.creakTravel = 0;
          this.creakCooldown = CREAK_GAP;
          this.creakOnsetPending = false;
        }
        this.creakRest = 0;
        this.creakDirection = direction;
      }
    }
    if (!rubbing) {
      this.creakRest += this.dt;
      if (this.creakRest >= CREAK_REARM_REST) {
        this.creakTravel = 0;
        this.creakDirection = 0;
        this.creakOnsetPending = true;
      }
    }

    const nodes = ball.chainSlack?.nodePositions() ?? [];
    const before = this.previousNodes;
    this.previousNodes = nodes.slice();
    // A new drape or a changed node count has no motion history to measure.
    if (ball.hookInFlight || changed || before.length !== nodes.length || nodes.length < 3) {
      this.chainSurface.reset();
      this.articulation.reset();
      return;
    }
    const free = chain.maxRopeLength - chain.coiledLength;
    const snapshot = ball.chainSlack?.contactSnapshot() ?? [];
    const contact = this.chainSurface.observe(snapshot, this.dt, ball, ball.submerged);
    out.drag = contact.drag;
    if (loose <= 0.03) {
      // A taut drape can shuffle cosmetic interior nodes while its ends and
      // material are completely still. Those constraint corrections are not
      // links sliding. Require genuine transport or moving scenery as well.
      const ends = Math.max(nodes[0]!.distanceTo(before[0]!), nodes[nodes.length - 1]!.distanceTo(before[before.length - 1]!)) / this.dt;
      const scenery = Math.max(0, ...snapshot.map(hit => hit.shape.owner instanceof PhysicsBody2D
        ? hit.shape.owner.velocityAtPoint(hit.point).length() : 0));
      if (Math.max(ends, materialSpeed, scenery) < 0.03) out.drag = null;
    }
    if (loose <= 0.03 || free <= CHAIN_LINK_LEN * 2) {
      this.articulation.reset();
      return;
    }
    // Loaded taut contact already has Wrap cues; loose arrivals use the
    // actual drape contacts. No complete drop performance is triggered.
    out.chainImpacts = contact.impacts;
    out.jingles = this.articulation.observe(nodes, this.dt, ball.submerged);
    let mean = Vec2.ZERO;
    let x = 0;
    let y = 0;
    const velocities: Vec2[] = [];
    for (let i = 1; i < nodes.length - 1; i++) {
      const velocity = nodes[i]!.sub(before[i]!).div(this.dt);
      velocities.push(velocity);
      mean = mean.add(velocity);
      x += nodes[i]!.x;
      y += nodes[i]!.y;
    }
    mean = mean.div(velocities.length);
    // Relative motion is the main signal: links moving differently from one
    // another. A small translation contribution keeps a dragged loose chain
    // audible, without treating its full world speed as violent articulation.
    let variation = 0;
    for (const velocity of velocities) variation += velocity.sub(mean).lengthSquared();
    const motion = Math.sqrt(variation / velocities.length) + mean.length() * 0.15;
    if (motion < 0.06) return;
    const slackWeight = Math.min(1, loose / 0.15);
    out.slack = { speed: Math.min(4, motion) * slackWeight * (1 - ball.submerged), x: x / velocities.length, y: y / velocities.length };
  }

  private resetFriction(): void {
    this.chainSurface.reset();
    this.articulation.reset();
    this.creakTravel = 0;
    this.creakCooldown = 0;
    this.creakRest = CREAK_REARM_REST;
    this.creakDirection = 0;
    this.creakOnsetPending = true;
    this.wrapContacts.clear();
    this.activeWraps.clear();
  }

  private readWrapContacts(level: BallLevel, loose: number, baselineOnly: boolean, out: SoundStep): boolean {
    const ball = level.ball;
    const chain = ball.chain!;
    const nodes = chain.path();
    const groups = new Map<CollisionShape2D, { local: Vec2; point: Vec2; distance: number; bend: number }>();
    let distance = 0;
    for (let i = 1; i < nodes.length; i++) {
      const contact = nodes[i]!.contact;
      const point = contact.globalPosition;
      const previous = nodes[i - 1]!.contact.globalPosition;
      distance += point.distanceTo(previous);
      if (i === nodes.length - 1 || contact.obj === ball || contact.obj.removed) continue;
      const incoming = point.sub(previous).normalized();
      const outgoing = nodes[i + 1]!.contact.globalPosition.sub(point).normalized();
      const bend = Math.atan2(Math.abs(incoming.x * outgoing.y - incoming.y * outgoing.x), incoming.dot(outgoing));
      const shape = contact.shape;
      const held = groups.get(shape);
      if (held) held.bend += bend;
      else groups.set(shape, { local: contact.position, point, distance, bend });
    }
    const loaded = !ball.hookInFlight && loose <= 0.03 && level.chainTension > 0 && ball.submerged < 1;
    const load = Math.min(2, Math.sqrt(Math.max(0, level.chainTension) / Math.max(1, ball.mass * GRAVITY.length())));
    const next = new Map<CollisionShape2D, WrapState>();
    let changed = groups.size !== this.activeWraps.size;
    for (const [shape, contact] of groups) {
      const before = this.wrapContacts.get(shape);
      if (!this.activeWraps.has(shape)) changed = true;
      // Group by the actual shape, not regenerated RopeWrap node identities.
      // Local movement excludes the motion of the scenery itself. Distance
      // from the chain's material start catches links sliding over a corner.
      const slip = before ? Math.max(contact.local.distanceTo(before.local), Math.abs(contact.distance - before.distance)) : 0;
      // Links strike the surface when new chain travels over it. Changing
      // bend angle alone is friction, not another link impact.
      const travel = (before?.travel ?? 0) + slip;
      const state: WrapState = { ...contact, travel, lastPlayed: before?.lastPlayed ?? -Infinity, loaded, lastSeen: this.step };
      const caught = !before || !before.loaded;
      const cooled = this.step - state.lastPlayed >= Math.ceil(0.12 / this.dt);
      if (!baselineOnly && loaded && caught && cooled && out.wraps.length < 6) {
        const surfaceVelocity = shape.owner instanceof PhysicsBody2D ? shape.owner.velocityAtPoint(contact.point) : Vec2.ZERO;
        const approach = ball.linearVelocity.sub(surfaceVelocity).length() * Math.sin(Math.min(Math.PI, contact.bend) / 2);
        const motion = Math.max(0.3, Math.min(6, Math.max(slip / this.dt, approach)));
        out.wraps.push({ speed: motion * load, x: contact.point.x, y: contact.point.y, surface: this.surface(shape, shape.owner), load, at: 1 });
        state.travel = 0;
        state.lastPlayed = this.step;
      } else if (!baselineOnly && loaded && !caught && slip > 0) {
        const links = Math.floor(travel / CHAIN_LINK_LEN);
        // A recorded clink already contains link articulation. Replaying it
        // several times per frame creates a pitched buzz. Group rapid links
        // into one contact gesture, at most once per 40 ms per shape.
        if (links > 0 && this.step - state.lastPlayed >= Math.ceil(0.04 / this.dt) && out.wraps.length < 6) {
          const at = Math.min(1, Math.max(0, (CHAIN_LINK_LEN - (before?.travel ?? 0)) / slip));
          out.wraps.push({ speed: Math.min(6, slip / this.dt) * load, x: contact.point.x, y: contact.point.y,
            surface: this.surface(shape, shape.owner), load, at });
          state.lastPlayed = this.step;
        }
        // Drop excess crossings, including during cooldown; never queue a
        // rattle to be heard after the chain has stopped moving.
        state.travel = travel % CHAIN_LINK_LEN;
      }
      if (!loaded) state.travel = 0;
      next.set(shape, state);
    }
    // A one-frame topology flicker at a facet seam is not a new collision.
    for (const [shape, state] of this.wrapContacts) {
      if (!next.has(shape) && this.step - state.lastSeen <= 3) next.set(shape, state);
    }
    this.activeWraps = new Set(groups.keys());
    this.wrapContacts = next;
    return changed;
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
      if (down >= STRIKE_MIN_SPEED) out.splash = { speed: down, x: ball.globalPosition.x, y: ball.globalPosition.y };
    }
    out.wade = { speed: rel.length(), interface: Math.max(0, 4 * s * (1 - s)), x: ball.globalPosition.x, y: ball.globalPosition.y };
  }

  private readAir(level: BallLevel, out: SoundStep): void {
    const ball = level.ball;
    // A ball under water is not moving through air.
    const motion = this.windMotion.observe(ball.linearVelocity.length(), this.dt, ball.submerged);
    out.air = { ...motion, x: ball.globalPosition.x, y: ball.globalPosition.y };
  }
}
