// BallLevel — level driver for the ball & chain controller. Deliberately a
// separate class from Level: the two controllers share nothing beyond the
// arena data, and keeping the Player frame flow untouched preserves its
// recorded replays bit-for-bit.

import { Vec2 } from "../engine/vec2";
import {
  AnimatableBody2D,
  RigidBody2D,
  StaticBody2D,
  VineLink,
  type CollisionObject2D,
  type PhysicsBody2D,
} from "../engine/body";
import { Debug } from "../engine/debug";
import { PhaseTrace } from "../engine/phaseTrace";
import { PhysTrace } from "../engine/physTrace";
import { PUSH_OUT_MIN_DEPTH, World, isRealPush, type PushOut } from "../engine/world";
import { bodySweepCircle } from "../engine/collision";
import { BallPlayer } from "../classes/ballPlayer";
import { BallHook } from "../classes/ballHook";
import { FinishLine } from "../classes/finishLine";
import { NO_BUTTON, type FrameInput } from "../input/frameInput";
import {
  scaleLevelData,
  type CameraPathData,
  type FireflyPathData,
  type CameraRegionData,
  type RawLevelData,
  type SpawnData,
} from "./levelFormat";
import { buildLevelBodies, type LevelVisualSource } from "./buildBodies";
import type { MoverScript } from "./movers";
import type { ConveyorBody } from "../lib/belt";
import {
  buildVines,
  stepVines,
  syncSpanUnits,
  touchedBerries,
  updateVineLoads,
  type Vine,
} from "./vines";
import type { TieChain } from "../engine/ties";
import type { Rope } from "../classes/rope";
import { RopeClamp } from "../lib/rail";
import { RopeEmbed } from "../lib/viscous";
import { RopeVineClamp } from "../lib/vineClamp";
import {
  BallChainRow,
  buildSceneChains,
  buildTieChains,
  settleTiesAtBuild,
  RopeRow,
  type SceneChain,
} from "./chains";
import { PlantUnit } from "./plantRows";
import { buildCameraRules, type CameraHang, type CameraRule } from "../render/cameraController";
import type { SparkEvent } from "./sparkEvents";
import {
  BreakTracker,
  guardBreakables,
  removeBrokenBody,
  type BreakEvent,
} from "./breakable";
import { PX } from "../engine/units";
import { resolveArrival } from "./arrivals";

// How long the level carries on being stepped after the player crosses the
// finish line, before the page freezes it (see `main.ts`).
//
// Half a second. Crossing a line takes no time at all, but freezing on the
// frame the ball first touched the chequers would stop it INSIDE the gate,
// which reads as having been caught by it rather than as having gone through:
// the linger is what carries the ball out the far side and lets the camera
// catch up before the form is laid over it.
export const FINISH_LINGER_FRAMES = 30;

// What the ball is made of: the iron ball (Normal) or the glass one (Hard),
// which is the same ball in every number but breaks on the first solid thing
// it touches (see `BallLevel.shatterIfStruck`).
export type BallKind = "iron" | "glass";

export interface BallLevelOptions {
  // Absent = iron, which is every level built before the glass ball existed.
  ball?: BallKind;
}

// How long after a glass ball breaks a fresh one is put at the spawn, in frames:
// two seconds (Tris, 2026-10-16: "respawn the player at the beginning after a
// couple of seconds") - long enough to watch the shards land and settle, short
// enough that the next attempt is the next thing that happens. The respawn is
// the sim's own, on a frame of the run, so a replay respawns on the same frame
// the page did (see `BallLevel.respawn`).
export const SHATTER_RESPAWN_FRAMES = 120;

// The glass ball breaking, as the facts the sim had in hand - the render side
// throws the shards from them (see `render/glassShards.ts`) and keeps nothing
// of the level afterwards. Every position is in world metres.
export interface ShatterEvent {
  // The ball's centre, turn and size as it broke.
  readonly at: Vec2;
  readonly rotation: number;
  readonly radius: number;
  // Where it was struck, and the struck surface's outward normal there (out of
  // the thing it hit, toward the ball).
  readonly point: Vec2;
  readonly normal: Vec2;
  // The ball's velocity coming INTO the frame it broke on - the arrival, before
  // the contact solve stopped it - and its spin.
  readonly velocity: Vec2;
  readonly spin: number;
}

export class BallLevel {
  readonly world = new World();
  // The ball. Replaced only by a glass ball's RESPAWN (see `respawn`): a fresh
  // ball at the spawn, so no state of the one that broke can carry over.
  ball: BallPlayer;
  // Where the ball is put at the start of the level, and whether it starts on
  // its chain - what a respawn repeats (the openings, a roll or an arrival, are
  // the level's and are played once).
  private readonly spawn: { at: Vec2; hang: boolean };
  // Which attempt this is (0 for the first), and the frame it began on: a
  // respawn starts the next one, and a finish is timed from the start of the
  // attempt that made it (see `completeLevel` in main.ts).
  attempt = 0;
  attemptStartFrame = 0;
  // All PhysicsBody2D the chain may wrap (ball + statics + hook).
  bodies: PhysicsBody2D[] = [];
  frame = 0;
  cameraPosition = Vec2.ZERO;
  // Camera-behaviour volumes, in metres (see Level.cameraRegions).
  readonly cameraRegions: CameraRegionData[];
  // Camera paths, in metres (see CameraPathData). Read by the same controller
  // and, like the regions, never by the sim.
  readonly cameraPaths: CameraPathData[];
  // The two lists as the one rule set the controller governs with, built once
  // here because a path's polyline index is derived and nothing mutates it.
  readonly cameraRules: CameraRule[];
  // The routes firefly swarms guide the player along, in metres (see
  // FireflyPathData). Render-only.
  readonly fireflyPaths: FireflyPathData[];
  // Chains strung between authored bodies (see Level.sceneChains).
  readonly sceneChains: SceneChain[];
  // Chains knotted through many bodies (see `Level.tieChains`).
  readonly tieChains: TieChain[];
  // Vines hanging from authored anchors (see `level/vines.ts`). The ball level
  // builds them for the same reason the grapple level does, and it is not a
  // nicety: `BALL` is the DEFAULT level, so a bare `/` and the editor's
  // ▶ Test Ball are what a vine authored in the editor is most likely to be
  // looked at in - and left out here it did not exist there at all. Its links
  // are in the world and in `bodies`; its pair chains are in `chainSet`.
  // The BALL passes through a vine, and its HOOK grabs one: a link is non-solid
  // so nothing collides with it, and `BallHook`'s attach paths take it like any
  // other rigid body, so the chain anchors to a vine exactly as it anchors to a
  // wall. Both halves are wanted - a vine is a thing to catch a chain on, not a
  // thing to bump into.
  readonly vines: Vine[];
  // The pendulums the file authored (see `LevelBodyData.swingAmp`), stepped at
  // the top of every frame. The ball driver has no `init` hook and therefore no
  // hand-written movers, so unlike `Level.movers` this list is exactly what the
  // level FILE asked for.
  readonly movers: Array<{ body: AnimatableBody2D; script: MoverScript }> = [];
  // The conveyor belts the file authored (`lib/belt.ts`), whose running
  // surfaces wake what rests on them every frame (see `physicsProcess`).
  readonly belts: ConveyorBody[] = [];
  // Render-only: the metre-scaled level as built, and the engine object each
  // authored entry became. It is what lets the 3D renderer hand an authored
  // `visual` to the exact piece of the exact body it decorates (see
  // `render3d/scene.ts`); the sim never reads it, and neither does the 2D
  // renderer, which draws bodies and knows nothing about the file they came from.
  readonly visualSource: LevelVisualSource;
  onReset: (() => void) | null = null;
  // Render-only: this frame's hook-on-hook-proof-steel contacts, for the spark
  // system to turn into particles (see `level/sparkEvents.ts`). Cleared at the
  // top of every `physicsProcess`, so it holds one frame's worth and never
  // accumulates through a headless replay. The sim writes it and never reads it.
  sparkEvents: SparkEvent[] = [];
  // Where in `sparkEvents` each hook's event for THIS frame sits, and whether
  // that event is the arrival and therefore final, so a second report of the
  // same touch resolves against the first rather than doubling it (see
  // `reportSpark`). Cleared with `sparkEvents`.
  private sparkEventIndex = new Map<PhysicsBody2D, { at: number; arrival: boolean }>();
  // The BALL's spark event for this frame, pending the spin term the frame turns
  // out to have realised (see `settleBallSparkSpin`). Cleared with `sparkEvents`.
  private ballSparkSpin: { at: number; lever: Vec2; commanded: number } | null = null;
  // Render-only, and the same rule as the sparks above: the bodies that came
  // apart this frame, for the debris system to throw chunks from (see
  // `level/breakable.ts`). Cleared at the top of every `physicsProcess`, so a
  // headless replay that never drains it accumulates nothing.
  breakEvents: BreakEvent[] = [];
  // ...and the SIM's side of the same feature, which is the part that is not
  // render-only: what each breakable body has taken so far, and the per-pair
  // accounting that decides when a load is a fresh hit.
  private readonly breaker = new BreakTracker();

  // THE GLASS BALL (`BallPlayer.glass`, the Hard difficulty): the frame it
  // broke on, or null - on an iron ball always, and on a glass one until it
  // touches something solid (see `shatterIfStruck`).
  //
  // Sim state, for the reason `completedFrame` is: it ends the run, so it is
  // digested into every bundle of a glass run (`WorldDigest.shattered`) and a
  // replay has to break on the same frame. Never cleared; a RESET builds a
  // fresh level with a whole ball, which is what starts the run over.
  shatteredFrame: number | null = null;
  // Render-only, the sparks' and the debris' rule: the break this frame, for
  // the render side to throw the shards from (see `render/glassShards.ts`).
  // Cleared at the top of every `physicsProcess`; nothing in the sim reads it.
  shatterEvents: ShatterEvent[] = [];
  // Where the broken ball is held, and facing, until the reset (see
  // `holdShattered`).
  private shatteredPose: { at: Vec2; rotation: number } | null = null;
  // The push-outs that moved the ball this frame - surfaces the chain phase
  // hauled it into, which the contact solve never saw. Collected for a glass
  // ball only (a push-out is a touch as much as a contact is), and cleared at
  // the top of every frame.
  private readonly ballPushes: PushOut[] = [];

  // THE FRAME THE PLAYER CROSSED THE FINISH LINE, once, or null on a level with
  // no finish line and on one that has not been finished (see the `finish` body
  // kind and `classes/finishLine.ts`).
  //
  // Sim state rather than a render-side flag: it is a fact about the run, so it
  // is read by the page, digested into every bundle and asserted by the
  // invariants, and a replay of a run that finished has to finish on the same
  // frame. It never goes back to null - a line that has been crossed has been
  // crossed, and a RESET builds a fresh level, which is what starts it over.
  completedFrame: number | null = null;
  // The level's finish lines, if it has any (see `classes/finishLine.ts`).
  //
  // Held rather than looked up each frame because the swept crossing at the end
  // of `physicsProcess` needs their shapes, and because the list being EMPTY is
  // what makes a level without one run none of the arithmetic - which is what
  // keeps every recording of every other level bit-identical.
  private readonly finishAreas: readonly FinishLine[];

  // THE ROLLING ENTRY still running: the spawn the ball is rolling to (which is
  // also where the camera stands while it does), the direction it is travelling
  // in, the furthest along that run it has got and how long it has been since
  // that improved - or null, which is a level whose spawn authors no entry
  // (every level but the ones that do), and every frame after the ball has
  // arrived.
  //
  // Sim state, and it has to be: while it stands the player's aim and deploy are
  // not the ball's (see `playerInput`), so a replay that let the recorded aim
  // through on a frame the run did not would diverge on the first one. It is set
  // at build and cleared once; nothing sets it again, because the entry is the
  // opening of a run and a RESET builds a fresh level, which is what plays it
  // again.
  private entry: { at: Vec2; dir: number; best: number; since: number } | null = null;

  // THE RECORDED ARRIVAL still running: the input stream the opening is played
  // back from and how far into it the run has got - or null, which is every
  // level whose spawn names no arrival (`SpawnData.arrival`), and every frame
  // after the stream ran out.
  //
  // Sim state for the same reason the entry above is: while it stands the
  // player's input is not the ball's at all, it is the recording's (see
  // `playerInput`), so a driver that let a frame of the player's through would
  // be playing a different run from the one every other driver plays. Set at
  // build and cleared once; a RESET builds a fresh level, which is what plays
  // the arrival again.
  private arrival: { frames: readonly FrameInput[]; next: number } | null = null;

  // Did this run OPEN on a recorded arrival? Unlike `arrival` above it is a
  // fact about the build rather than about this frame, and nothing clears it:
  // the page asks so it can fade the screen up over the opening (see
  // `render/openingFade.ts`), and a fade that stopped because the arrival did
  // would be a fade that never ran - it is over in a fifth of the stream.
  readonly opensOnArrival: boolean;

  // Are the player's hands OFF the ball - because it is still rolling in, or
  // because the level is still playing back the arrival it opens on?
  get handsOff(): boolean {
    return this.entry !== null || this.arrival !== null;
  }

  // Is the ball being HELD at its entry speed by the level itself (see
  // `ENTRY_SPEED`)? A narrower question than `handsOff` above, and a different
  // one: this is the level putting energy into the ball that no input carries,
  // which is what the energy invariant has to be told about (see
  // `EnergyMonitor.push`). An arrival is not one - every joule in it was bought
  // by a recorded press, on a frame the recording carries.
  get rollingIn(): boolean {
    return this.entry !== null;
  }

  // The input the last step was actually PLAYED with, which during an arrival
  // is the recording's and not the caller's (see `playerInput`). Null before
  // the first step.
  //
  // Observation only, for the monitors that ask what was asked of the ball this
  // frame - the same job `aimSpin` does for the aim. Nothing in the sim reads
  // it.
  get playedInput(): FrameInput | null {
    return this.lastPlayed;
  }
  private lastPlayed: FrameInput | null = null;

  // Whether this level has a finish line at all, which is a fact about the FILE
  // rather than about the run. It is what the digest asks before writing
  // `finished`: a level with no finish line digests exactly what it always did,
  // so every bundle of one compares as it always did (see `WorldDigest`).
  get hasFinish(): boolean {
    return this.finishAreas.length > 0;
  }

  // What the ball is made of, as the build was asked for it (see
  // `BallLevelOptions`): what a recording of this run has to carry for its
  // replay to build the same ball.
  get ballKind(): BallKind {
    return this.ball.glass ? "glass" : "iron";
  }

  // Diagnostic for the anchor-kick invariant. On the frame the chain first
  // anchors to a fixed body, this holds the speed the length solve added to
  // the ball; null on every other frame. A rope going taut against a fixed
  // point can only brake the ball (remove its outward velocity), so a positive
  // value means the solver injected energy — the tip-anchor over-length dump
  // (see checkBallInvariants).
  anchorKickSpeedGain: number | null = null;
  // The same measurement on EVERY frame the chain solves, not only the anchoring
  // one. The anchor-kick check above catches a chain that is born over its length;
  // this catches one that becomes over-length later — the chain's path can jump
  // discontinuously mid-flight (a wrap appearing on a corner the ball has just
  // cleared), and the solver removes that whole error in one step, converting it
  // to velocity as Δposition/Δt. That is a launch, and nothing was watching for
  // it: 96 m/s in a single frame sits far under the runaway-speed ceiling
  // (session-1474f).
  chainSolveSpeedGain: number | null = null;
  // What the current chain's length was on the frame it anchored; null while
  // there is no anchored chain. Nothing pays chain out afterwards, so this is
  // the baseline the chain-growth invariant measures against.
  chainAnchorLength: number | null = null;
  // Consecutive frames the chain's winch stall has had to let length out. The
  // stall is a ratchet, so a *run* of them is the shape of every chain runaway
  // there has been — far more diagnostic than the total, which a single
  // discontinuous jump in the wrap path can dominate on its own.
  chainStallFrames = 0;
  // Consecutive frames the chain has held a real blocked-length lease while
  // NOTHING was blocking it. A lease is a loan against present geometry, so the
  // frames where the geometry has stopped saying no are the frames it must be
  // being paid back on; a run of them is the lease having become a permanent
  // payment, which is the one failure `rope-grew` cannot see (it measures growth,
  // and a lease held at a constant value grows by nothing — session-1080f).
  chainLeaseHeldFrames = 0;
  // Speed the frame's own winding entitles the solve to (see the assignment in
  // `physicsProcess`); zero on a frame with no chain.
  chainWinchSpeedBudget = 0;
  // What the chain phase itself paid the ball this frame, as a velocity: the
  // PBD credit over the phase's realised displacement, and nothing the frame
  // wrote on top of it. Zero on a frame with no chain.
  //
  // It is the one part of the ball's velocity a *constraint* is entitled to have
  // put there, which is what makes it the term `roll-unfunded` subtracts before
  // asking whether the rest of the ball's travel is accounted for by its spin.
  chainCreditVelocity = Vec2.ZERO;
  // How much inward speed the chain phase handed the ball beyond what the
  // constraint was opening at when the phase began (see `Rope.creditBound`);
  // null on a frame with no anchored chain. Measured over the phase's REALISED
  // velocity change rather than over the credit alone, so it covers everything
  // the phase writes on top of that credit - the spin rollback, the unwind, the
  // into-surface refusal - and not only the one term that is clamped.
  //
  // A chain is a constraint, so what it may take out of the ball is the motion
  // opening it and nothing else. Anything past that is the phase charging for a
  // displacement some earlier part of the frame has already answered for, which
  // is `session-360f`: the contact solve reversed the ball's fall onto the floor,
  // the chain then billed it 2.1 m/s for the same descent, and the ball left the
  // ground at three times the speed it landed at.
  chainCreditOverBound: number | null = null;
  // How much speed the chain phase handed the ball OUT of a surface the phase
  // pushed it out of, in m/s: the phase's realised velocity change, taken along
  // each of this frame's push-out normals, at its largest. Zero on a frame with
  // no push-out, or no anchored chain.
  //
  // A push-out is an answer to a haul the geometry refused, and against static
  // geometry it can never leave the ball further out than it began: the ball is
  // hauled in by `h`, overlaps by `h` less whatever gap it had, and is pushed
  // back by exactly that. What CAN leave it further out is the other body of
  // the pair moving into the ball inside the phase - hauled there by the ball's
  // own chain, which is the ball's own tension moving the thing it rests
  // against - and a push-out that then moves the ball alone converts that
  // body's share of the correction into speed the ball never earned, with the
  // body keeping its own credit for the same motion. The pair leaves together
  // (`session-324f`: 0.3 to 2.3 m/s of it a frame, the ball and its 12.6 kg
  // anchor from 1 to 19 m/s in 18 frames). `rope-push-credit` is the
  // invariant.
  chainPushOutCredit = 0;
  // Consecutive frames on which `chainPushOutCredit` stood above
  // `PUSH_CREDIT_SPEED`. A one-frame push-out credit is a flick - the unwind
  // turning the mounting loop into the scenery, cleared and credited once - and
  // the corpus carries those at up to 2 m/s. A pump is re-earned every frame
  // for as long as its cause lasts: 18 consecutive frames on `session-324f`,
  // 11 on `session-307f`, against a corpus that never strings 3 together.
  chainPushCreditFrames = 0;
  // The spin the aim steering wrote onto the ball this frame, in rad/s, and zero
  // on a frame it did not steer. Read by the energy monitor, which must know
  // whether the player is a source this frame: the ball's angular velocity at
  // the END of the frame does not say, because a wound-tight chain's unwind
  // refuses the whole turn and leaves it at exactly zero while the winch has
  // been fed the whole turn's worth of chain (`session-726f` f430-500, a ball
  // shoving its anchor along the floor at a steady 1 m/s² under a held aim,
  // read as an unforced gain).
  aimSpin = 0;
  // Radians the unwind gave back this frame: the ball's rotation before
  // `Rope.unwindOverLength` less its rotation after (see the assignment in
  // `physicsProcess`). Zero on a frame with no anchored chain, and zero on one
  // whose turn the chain let stand.
  //
  // It is the other half of `aimSpin`, and neither is legible without it. A
  // wound-tight chain refuses the whole commanded turn, so the ball's angular
  // velocity at frame end reads zero on exactly the frames that matter: the
  // steering asked for 38 rad/s, the unwind handed all of it back, and every
  // digest there was showed a ball sitting perfectly still (`session-154f`,
  // `session-477f`, `session-726f`).
  chainUnwindRefund = 0;
  // Whether the ball was BRACED this frame: carrying a load-bearing contact
  // against something off its chain's path, so the spin's reaction is the
  // world's rather than the anchor's (see `keepsHaul`). It is the gate on the
  // spin rollback and on the wind-stall latch, and a wind-up read off a bundle
  // is not legible without it: the same ask against the same holder is a
  // refused turn in free air and a haul with the ground under it.
  chainBraced = false;
  private endWasFixed = false;

  // Push-out credit above which a frame counts toward `chainPushCreditFrames`.
  // Gravity's own step is 0.16 m/s and the corpus's sustained noise sits under
  // that; the pump ran at 0.3 to 2.3.
  static readonly PUSH_CREDIT_SPEED = 0.2;
  // Passes of the ball-against-path-body pair separation, per body (see
  // `separateBallFromPathBodies`). Two, as `World.depenetrateRigid` iterates:
  // a rotation that clears one point can seat another.
  static readonly PAIR_SEPARATION_PASSES = 2;
  // Overlap below which a push-out is a pair touching, not a surface refusing
  // anything: nothing is separated for it and nothing downstream hears of it -
  // neither the stall lease nor the into-surface refusal, which stripped
  // 1.1 m/s on one machine that the other kept when it read float noise as a
  // push. The floor itself is the engine's (`PUSH_OUT_MIN_DEPTH` in
  // `engine/world.ts`), shared with the scene-chain settle.
  static readonly PUSH_OUT_MIN_DEPTH = PUSH_OUT_MIN_DEPTH;
  // Length below which a stall is float noise rather than a blocked correction.
  // Also the least chain a turn must ask to wind before the unwind refunding it
  // whole can latch the wind-stall (see the latch in `physicsProcess`).
  static readonly STALL_EPSILON = 0.001;
  // Lease below which there is nothing worth calling a surplus: the release
  // hands back 8 mm a frame, so anything under a couple of centimetres is on its
  // way out already.
  static readonly LEASE_EPSILON = 0.02;

  // The ball plays 1.5× the arena's authored avatar radius — a heftier ball
  // & chain than the grapple avatar, without hand-editing generated levelData.
  static readonly BALL_RADIUS_SCALE = 1.5;

  // How fast a ball rolls in on a spawn that asks for an entry (m/s — see
  // `SpawnData.roll`). One number for the whole game rather than a per-level
  // one: an entry is how the game hands the player the ball, and a game whose
  // openings each roll in at their own speed has no such gesture, only levels
  // that each start oddly. What an arena DOES author is how far out the ball
  // starts, which is how long the entry lasts.
  //
  // 1.5 m/s: a walk. The ball is a 52 kg cast-iron wrecking ball and the entry
  // is the first thing anybody sees of it, so it trundles in under its own
  // weight rather than arriving at the speed a swing would put it on the floor
  // at - and the slower it comes, the longer the player has to read the room it
  // is coming into. 2 m of entry is 1.3 s of it, and 4 m - most of the 9.6 m the
  // frame shows - is a little under three.
  //
  // It is HELD for as long as the entry runs (see `driveEntry`) rather than
  // given to the ball once at build, and that is not a shortcut, it is the
  // measurement: a ball shoved along a flat floor and left to coast stops in
  // 34 cm from this speed - and in 1.8 m from 3 m/s and 2.6 m from 5 - because
  // it climbs its own mounting lug once a revolution and loses the frames after
  // bottom-dead-centre in free fall (see docs/ball-rolling.md#the-loop-ride).
  // Every offset that could put the ball off the side of the screen is
  // further than a coast survives,
  // so a coasted entry is one that stops in plain view and hands the player a
  // ball that is already still - which is the one thing the opening must not
  // do. Held, the entry arrives at any authored distance, at the same pace, and
  // hands over a ball that is still rolling.
  static readonly ENTRY_SPEED = 1.5;

  // What counts as still arriving: an entry that has not closed
  // `ENTRY_PROGRESS` metres on the spawn in `ENTRY_STUCK_FRAMES` frames has
  // stopped getting there, and hands over where it stands.
  //
  // Being held (above), an entry cannot be argued out of its speed - it can only
  // be argued out of its PLACE, by a wall it was authored into, a step it cannot
  // climb, a pit it is sitting in the bottom of. Measuring the progress rather
  // than the speed is what tells those apart from an entry that is simply
  // taking its time. Half a second of no ground made is unambiguous: the entry
  // covers 2.5 cm a frame, so anything still coming has made three quarters of
  // a metre by then.
  static readonly ENTRY_STUCK_FRAMES = 30;
  static readonly ENTRY_PROGRESS = 0.01;

  constructor(rawData: RawLevelData, options: BallLevelOptions = {}) {
    const data = scaleLevelData(rawData, PX);
    this.cameraRegions = data.cameraRegions ?? [];
    this.cameraPaths = data.cameraPaths ?? [];
    this.cameraRules = buildCameraRules(this.cameraRegions, this.cameraPaths);
    this.fireflyPaths = data.fireflyPaths ?? [];
    this.ball =new BallPlayer(data.player.radius * BallLevel.BALL_RADIUS_SCALE);
    this.ball.glass = options.ball === "glass";
    this.ball.globalPosition = new Vec2(data.player.x, data.player.y);
    this.spawn = { at: this.ball.globalPosition, hang: data.player.hang === true };
    // The two openings a spawn may author, and only one of them can happen: the
    // arrival is the recorded one and it decides where the ball starts, so it is
    // asked first and the roll gives way to it (see `startArrival`).
    this.startArrival(data.player);
    this.opensOnArrival = this.arrival !== null;
    this.startRolling(data.player);
    this.ball.spawnBody = (b) => this.spawnBody(b);
    this.world.add(this.ball);
    this.bodies.push(this.ball);

    const built = buildLevelBodies(
      this.world,
      data,
      () => this.onReset?.(),
      () => this.finish(),
    );
    this.finishAreas = built.bodies
      .map((b) => b.body)
      .filter((b): b is FinishLine => b instanceof FinishLine);
    this.bodies.push(...built.wrapBodies);
    this.movers.push(...built.movers);
    this.belts.push(...built.belts);
    // Every authored chain is a row of the world's island solver
    // (`RopeRow`), solved with the bodies it holds and with the ball's chain
    // whenever they share one, rather than by a positional sweep beside them:
    // the ball's island hauled a lantern the sweep then put back after it, and
    // a ball on the lantern's bail ended every frame with its chain over its
    // length (`session-77f`).
    this.sceneChains = buildSceneChains(data, built, this.world);
    // Before the vines, so a vine hung from a lantern is built from where the
    // lantern comes to rest.
    settleTiesAtBuild(this.world, this.sceneRows());
    // The tied chains after the authored ropes, for the same reason: a bridge
    // hung from a chain-held body settles against where that body came to rest.
    this.tieChains = buildTieChains(data, built, this.world);
    settleTiesAtBuild(this.world, this.tieChains);
    this.vines = buildVines(this.world, data, built);
    // Both are built, so both can be asked what they hang from: a breakable
    // body under a chain or a vine anchor is one the file got wrong, and it
    // loses its threshold here rather than taking a constraint down with it
    // mid-play (see `guardBreakables`).
    guardBreakables(this.sceneChains, this.vines, this.tieChains);
    for (const vine of this.vines) this.bodies.push(...vine.allLinks);
    // A hook that strikes a link threads onto the whole vine (see
    // `lib/vineClamp.ts`), and the level is what knows which vine a link is.
    // Never a berry vine's: its cord is no target, and a berry is bitten like
    // any other moving body.
    this.ball.vineFor = (link) => this.vines.find((v) => !v.starberry && v.links.includes(link)) ?? null;
    this.visualSource = { data, built };

    // A spawn that says so opens the level already on its anchor (see
    // `SpawnData.hang`). Last of the build, because the throw is swept against
    // the world as it stands: a chain-hung lantern has come to rest
    // (`settleTiesAtBuild`) and the vines exist and know which vine each link
    // belongs to, so the spawn anchor is taken on the same geometry, in the
    // same poses, that the first frame of play will see.
    if (this.spawn.hang) this.hangAtSpawn();

    this.cameraPosition = this.cameraAnchor();
  }

  // Where the camera reads the world from this frame: the ball, or the spawn
  // while the ball is still rolling in to it (see `cameraRenderPosition`, which
  // is the same choice made against the interpolated pose). It is what the rule
  // set is evaluated at, so the debug overlay names the regions the camera is
  // actually being governed by rather than the ones the ball is passing through.
  private cameraAnchor(): Vec2 {
    return this.entry?.at ?? this.ball.globalPosition;
  }

  // The ball's chain as a row of the island solver (`BallChainRow` in
  // `level/chains.ts`; `plans/rope-bridge.md`, stage 3).
  //
  // A body knotted into a tied chain is immovable to a rope's positional
  // solve (see `Rope.getDynamicBodyState`), so a positional chain phase hauls
  // the ball against a slat the island then puts back, and the two mint
  // energy between them: stage 1's guest row (the free span as a tie segment,
  // the rest of the phase positional) left the gravity step's drift to the
  // positional solve, which hauled the ball 6 mm a frame into the slat it rode
  // and had the pair separation kick the slat 3 rad/s for its share
  // (`session-1118f`, 52 J unforced), and wound tight with the chain over a
  // slat's edge the guest was gone and the same loop flung slats at 13 m/s
  // (`session-394f`). What the physics wants is the ball, its chain and the
  // bridge in ONE velocity solve: the chain a row of the island, the ball a
  // body the island integrates, every contact on either an island row, the
  // winch the row's kinematic rate. The chain phase is then what an island
  // cannot do - refuse a rotation it does not own (the unwind and the latch)
  // and lease what geometry refuses - and nothing it moves is credited.
  //
  // `ballRow` is the unit, kept across frames for its warm start;
  // `ballRowActive` is non-null on a frame it is in the solve; `rowTied` are
  // the bodies tied for that frame, untied again once the world has stepped
  // (`untieBallRow`), so the rest of the frame reads them as the free bodies
  // they are.
  private ballRow: BallChainRow | null = null;
  private ballRowActive: BallChainRow | null = null;
  private rowTied: RigidBody2D[] = [];

  private syncBallRow(delta: number): void {
    this.untieBallRow();
    this.ballRowActive = null;
    this.world.ties.ballRow = null;
    this.world.ties.hardBody = null;
    this.world.ties.hardHolders = [];
    this.world.ties.chainPress = null;
    this.world.ties.tipBody = null;
    this.world.ties.tipPress = null;
    const chain = this.ball.chain;
    // Every chain that is out and thrown is a row: anchored, ringed onto a
    // cord, clamped to a rail, embedded in mud, or a dangling tip the ball
    // holds. A ride is carried through the substeps (`Rope.carryRidesWithin`),
    // a cuff in mud creeps inside the row's solve (`Rope.rowCreep`), a rail's
    // ring slides at each substep's opening (`Rope.rowAdvanceRing`), and a
    // ring on a cord is a row of the vine's own island (`syncSpanUnits`).
    if (!chain || !this.ball.chainAnchored) {
      this.releasePlant();
      return;
    }
    // A berry's plant is a unit of the island for as long as the chain holds
    // the berry (see `syncPlantUnit`), so its links are tied bodies below and
    // the chain is a row of the plant's island.
    this.syncPlantUnit(chain.end.contact.obj);
    let row = this.ballRow;
    if (row === null || row.rope !== chain) {
      row = new BallChainRow(
        this.ball,
        chain,
        () => this.bodies,
        (c) => this.world.ties.engaged(c),
        () => {
          const tip = this.ball.chainTip;
          return tip !== null && this.ball.chain?.end.contact.obj === tip ? tip : null;
        },
        () => this.ball.aimPowerShare,
      );
      this.ballRow = row;
    }
    row.sync(this.world.ties.chains);
    for (const body of row.bodies) {
      if (body.tied) continue;
      body.tied = true;
      this.rowTied.push(body);
    }
    // The rope's frame opens here, before the island's first substep: the
    // lease release, the per-frame books.
    chain.beginFrame(delta);
    this.world.ties.ballRow = row;
    this.world.ties.hardBody = this.ball;
    this.world.ties.hardHolders = row.bodies.filter((body) => body !== this.ball);
    this.world.ties.chainPress = (normal) => row.pressInto(normal);
    if (row.dangling) {
      this.world.ties.tipBody = this.ball.chainTip;
      this.world.ties.tipPress = (normal) => row.tipPressInto(normal);
    }
    this.ballRowActive = row;
  }

  private untieBallRow(): void {
    for (const body of this.rowTied) body.tied = false;
    this.rowTied = [];
  }

  // The berry plant the ball hangs from, as a unit of the island solver
  // (`PlantUnit` in `level/plantRows.ts`): the stalk's spring is what bounces
  // the ball, and solved positionally at the frame's step it damped a third
  // of the bounce a stroke (see the file comment there). Built the frame the
  // chain takes a berry, kept across frames for its rows' warm start, and
  // dropped the frame the chain lets go or moves to another berry - the plant
  // is then its own free unit again (`syncSpanUnits`).
  private plantUnit: PlantUnit | null = null;

  // Whether the chain ends in a ring on a cord, which `syncBallRow` makes a
  // row of a stiff span's island (see there): the span keeps its unit through
  // the hold, with the load ropes among its rows.
  private ringOnSpan(): boolean {
    return this.ball.chain?.end instanceof RopeVineClamp;
  }

  private syncPlantUnit(end: CollisionObject2D): void {
    if (end instanceof VineLink) {
      const vine = this.vines.find((v) => v.starberry && v.berries.some((b) => b.fruit === end));
      if (vine) {
        if (this.plantUnit !== null && this.plantUnit.vine === vine && this.plantUnit.berry === end) return;
        this.releasePlant();
        // The load rope is one of the unit's rows, so it exists before the
        // unit does (the same call the frame makes after the step finds it
        // built and leaves it).
        updateVineLoads(this.vines, this.ball.chain);
        // In place of the free plant's own unit (`syncSpanUnits`).
        if (vine.unit !== null) {
          this.world.ties.removeUnit(vine.unit);
          vine.unit = null;
        }
        const unit = new PlantUnit(vine, end);
        vine.unit = unit;
        this.world.ties.addUnit(unit);
        this.plantUnit = unit;
        return;
      }
    }
    this.releasePlant();
  }

  private releasePlant(): void {
    const unit = this.plantUnit;
    if (unit === null) return;
    this.world.ties.removeUnit(unit);
    unit.vine.unit = null;
    this.plantUnit = null;
  }

  // The chain phase of a frame the island solved the chain on: the path brought
  // up to date, the winding the frame could not haul given back to the spin,
  // the latch, the books. Nothing here moves the ball but the unwind's
  // rotation, and nothing is credited.
  private closeBallRowFrame(
    row: BallChainRow,
    chain: Rope,
    delta: number,
    ballRotationAtFrameStart: number,
    anchoredThisFrame: boolean,
  ): void {
    // The last substep moved the bodies after the last regeneration; growth a
    // wrap appearing here puts on the path is leased at the next prepare.
    chain.syncWraps(this.bodies);
    const spinLength =
      Math.abs(this.ball.globalRotation - ballRotationAtFrameStart) *
      Math.abs(chain.lengthPerRadian(this.ball));
    // The birth length re-taken where the frame leaves the ball, as the
    // positional phase does (see there).
    if (anchoredThisFrame) {
      const born = chain.getCurrentLength() - spinLength;
      if (born > chain.maxRopeLength) chain.maxRopeLength = born;
      this.chainAnchorLength = chain.maxRopeLength;
    }
    this.chainWinchSpeedBudget = spinLength / delta;
    const braced = this.ballBraced(chain);
    this.chainBraced = braced;
    // The winding the row's drum did not realise is over-length the coil wound
    // on with nowhere to go, and the spin gives it back, bounded to the
    // frame's turn. The rest of the chain's over-length is the soft row's
    // stretch under load and is forgiven (see `BallChainRow.finishFrame`).
    const unrealised = row.finishFrame();
    // Forgiven up to the row's own stretch and no further: over-length the
    // ball cannot take out, wedged against a face its anchor is across, is
    // not stretch, and forgiven as though it were it stood over from frame to
    // frame and grew - 42 to 101 mm through `session-187f` f140-151, the bias
    // pulling the ball into the wall harder each frame - until the island
    // kicked the ball at 19 m/s. A ring's over-length is its creep's (see
    // `BallChainRow`) and keeps the whole forgiveness.
    // Engaged as the drum reads a face (`TieSolver.engaged`), so the two
    // refusals agree on what the ball is against.
    const againstScenery = this.world.frameContacts.some(
      (c) => c.a === this.ball && c.b instanceof StaticBody2D && this.world.ties.engaged(c),
    );
    const stretch =
      !againstScenery || chain.end instanceof RopeVineClamp
        ? Number.POSITIVE_INFINITY
        : row.stretch();
    const forgive = Math.max(0, Math.min(chain.overLength - unrealised, stretch));
    const rotationBeforeUnwind = this.ball.globalRotation;
    // A spin the motor drove is not refunded: the chain's pull on the rim met
    // the motor's rating inside the island, so the turn the frame ended with
    // is the turn the chain allowed. Refunded as well, the rotation back was
    // length handed to the chain at no cost, and every frame the chain paid
    // for the turn and the refund took it back for free, the ball whirled to
    // 22 m/s on a 0.7 m chain with the drum doing nothing (`session-1256f`).
    if (!this.ball.spinMotorActive) {
      chain.unwindOverLength(this.ball, ballRotationAtFrameStart, delta, forgive);
    }
    this.settleUnwindLatch(rotationBeforeUnwind, delta, braced);
    PhaseTrace.mark("unwind", this.world);
    // A STATIC the ball is left inside is a surface refusing the chain, and
    // the row cannot hear it: the island's contact row is soft and recovers
    // at a capped rate, the chain row pulls without bound, and between them
    // the ball stays where the chain put it. A ball spawned 35 mm into the
    // slope and hooked point-blank to it was held 30-35 mm in for frame
    // after frame (`ball-slope-rest`), where the positional phase pushes it
    // out first and leases the chain the length the surface refused. So the
    // row frame does the same, after the island: the static push-out, and
    // the lease measured against what those normals make unreachable
    // (`Rope.absorbBlockedLength`). Statics only - a body the island owns is
    // its own contact row's to answer, as a slat is.
    const pushBefore = this.ball.globalPosition;
    const pushed = this.world
      .depenetrateRigid(this.ball, 2, (other) => other instanceof StaticBody2D)
      .filter(BallLevel.realPush);
    if (this.ball.glass) this.ballPushes.push(...pushed);
    chain.noteGeometryPush(this.ball.globalPosition.distanceTo(pushBefore));
    // The free holders on the path have hard rows against the scenery too
    // (`TieSolver.hardHolders`), and a hard row stops a body sinking but never
    // recovers it: a 294 kg anchor the island had let 37 mm into a static
    // stood there for twenty frames (`session-726f` f189). The positional
    // phase's settle pushes a chain's bodies out of the statics; so does this.
    for (const holder of row.bodies) {
      if (holder !== this.ball) this.world.depenetrateRigid(holder, 2, (other) => other instanceof StaticBody2D);
    }
    // A body ON THE PATH the ball rests against refuses the chain as the
    // positional phase's pair separation reads it (`pathBlocked`, the
    // `separateBallFromPathBodies` normals): the ball cannot be drawn any
    // closer to the holder it is touching, and the over-length that stands is
    // the chain squeezing the pair through their contact. Not leased, the
    // squeeze held: `session-1195f` f278-307, the ball resting on the 430 kg
    // block it is chained to with no input at all, the length row at 16-40
    // kN, its stretch the 7 mm the chain stood over, and the two soft
    // corrections pumping 15-39 J a frame into the pair. The scenery is not
    // named here: leased against a face, a ball whirled wound tight to a
    // ceiling ratcheted its chain 5.4 cm (`ball-wind-up`).
    const path = chain.path();
    const holders: Vec2[] = [];
    for (const c of this.world.frameContacts) {
      if (c.normalImpulse <= 0 || !(c.b instanceof RigidBody2D)) continue;
      if (c.a === this.ball && path.some((n) => n.contact.obj === c.b)) holders.push(c.normal);
      else if (c.b === this.ball && path.some((n) => n.contact.obj === c.a)) holders.push(c.normal.neg());
    }
    if (holders.length > 0) chain.noteGeometryPush(chain.overLength);
    const normals = [...pushed.map((p) => p.normal), ...holders];
    const refused =
      normals.length > 0 ? chain.absorbBlockedLength([{ body: this.ball, normals }]) : 0;
    // A DRIVEN anchor taking the chain away from a ball something holds - a
    // belt's carry with the ball wedged against a wall under it, a mover
    // pulling away from a ball pinned behind a ledge - opens the path at a rate
    // nothing in the island can slow, and with the ball held the chain has to
    // give: the over-length the frame GREW (`BallChainRow.overGrowth`) is
    // leased, no more than the drivers opened the path by, as the positional
    // phase's stall lease paid a carry out at the carry's own rate. Unleased,
    // the hold row's error grew a frame of carry a frame, its impulse to 7 MN,
    // and the ride that cannot be followed never tore (`ride-tear`,
    // `tearOffOverdrawnRide`). The growth and not the over-length past the
    // row's stretch: a soft row's stretch is its error under whatever it
    // carries, the refused share included, so that read nothing once the ball
    // was held, and on a ball the ride hauled round a corner it read the
    // row's lag behind the accelerating anchor (1.2 mm a frame) as refusal and
    // grew the chain by it. Only the drivers' opening: the ball's own whirl
    // wound tight under a ceiling leaves over-length that is the spin's, which
    // the unwind answers (`ball-wind-up`).
    // And only a ball something holds, a contact engaged: in free air the
    // growth is the soft row's lag while the tension builds (a ball wound in
    // under a carried anchor, 4.5 mm over 200 frames, `ride-winch`), which the
    // row closes as the tension settles.
    let drivenRefused = false;
    const opened = row.drivenOpening();
    const grown = row.overGrowth();
    const held = this.world.frameContacts.some(
      (c) => (c.a === this.ball || c.b === this.ball) && this.world.ties.engaged(c),
    );
    if (opened > 0 && grown > 0 && held) {
      chain.leaseLength(Math.min(grown, opened));
      drivenRefused = true;
    }
    PhaseTrace.mark("push-out", this.world);
    chain.noteBlockedByGeometry((normals.length > 0 && refused > 0) || drivenRefused);
    this.chainStallFrames = 0;
    // A lease geometry is still refusing is held, not owed: the positional
    // phase's count (see `stall-lease`).
    this.chainLeaseHeldFrames =
      chain.blockedSlack > BallLevel.LEASE_EPSILON && !chain.blockedByGeometry
        ? this.chainLeaseHeldFrames + 1
        : 0;
    this.chainCreditVelocity = Vec2.ZERO;
    this.chainSolveSpeedGain = 0;
    this.anchorKickSpeedGain = anchoredThisFrame ? 0 : null;
    this.chainCreditOverBound = null;
    this.chainPushOutCredit = 0;
    this.chainPushCreditFrames = 0;
    PhaseTrace.mark("chain-velocity", this.world);
  }

  // Is the ball carrying a load-bearing contact against something NOT on its
  // chain's path this frame (see `chainBraced`).
  private ballBraced(chain: Rope): boolean {
    const pathBodies = new Set<CollisionObject2D>();
    for (const node of chain.path()) pathBodies.add(node.contact.obj);
    for (const c of this.world.frameContacts) {
      if (c.normalImpulse <= 0) continue;
      const other = c.a === this.ball ? c.b : c.b === this.ball ? c.a : null;
      if (other !== null && !pathBodies.has(other)) return true;
    }
    return false;
  }

  // After the unwind: what it refunded, and what that says about the steering
  // (`BallPlayer.windStall`, `RigidBody2D.spinDriveShare`).
  private settleUnwindLatch(rotationBeforeUnwind: number, delta: number, braced: boolean): void {
    const chain = this.ball.chain;
    if (!chain) return;
    const asked = Math.abs(this.aimSpin) * delta;
    const refunded = Math.abs(this.ball.globalRotation - rotationBeforeUnwind);
    this.chainUnwindRefund = refunded;
    const path = chain.path();
    this.ball.windStallHeld = this.world.frameContacts.some((c) => {
      if (c.a !== this.ball && c.b !== this.ball) return false;
      const other = c.a === this.ball ? c.b : c.a;
      return other instanceof RigidBody2D && path.some((n) => n.contact.obj === other);
    });
    const spool = Math.abs(chain.lengthPerRadian(this.ball));
    // The share of this ask that STAYED wound is what next frame's contact
    // solve may sell as roll (`RigidBody2D.spinDriveShare`). The unwind
    // runs after the contacts, so the frame that refuses a turn has
    // already sold it; the next frame does not. Floored the way the latch
    // is: an ask under `STALL_EPSILON` of chain is a converged aim's
    // residual, not a refusal (`session-379f`) - and it is no information
    // either way, so the share HOLDS across it rather than resetting. The
    // share is a fact about the jam, not about the ask: reset to 1 on
    // every quiet frame, a proportional aim that toggles between nothing
    // and a 24 rad/s snap had every snap's first frame funded whole, and
    // each bought the ball rim speed on the floor before the refund came
    // - 2.8 m/s in one frame from a standing start, with the stool going
    // over the top lifting the floor load off it so nothing braked the
    // coast (`session-141f` f77, f82). Held, a snap into a standing jam
    // buys what the jam last allowed, and the first frame the chain does
    // let a turn stand re-earns the drive whole.
    if (asked * spool >= BallLevel.STALL_EPSILON) {
      this.ball.spinDriveShare = Math.max(0, 1 - refunded / asked);
    }
    if (braced) this.ball.windStall = 0;
    if (
      asked * spool >= BallLevel.STALL_EPSILON &&
      this.ball.windStallHeld &&
      !braced &&
      refunded >= BallPlayer.STALL_REFUND_SHARE * asked &&
      spool >= BallPlayer.STALL_LATCH_SPOOL_SHARE * this.ball.radius
    ) {
      this.ball.windStall = Math.sign(this.aimSpin);
    }
  }

  // The authored chains' island rows (see the build).
  private sceneRows(): RopeRow[] {
    return this.sceneChains.map((chain) => chain.row);
  }

  private spawnBody(body: PhysicsBody2D): void {
    // Every hook enters the world through here, so this is the one place the
    // spark plumbing has to be. It lives at the level rather than in
    // `BallPlayer`, because the sim-to-visual boundary is the level's to hold
    // and the controller has no business knowing there is a renderer.
    if (body instanceof BallHook) {
      body.registerBounceCallback((point, normal, vel, fromFlight) =>
        this.reportSpark(body, { source: body.id, point, normal, vel }, fromFlight),
      );
    }
    this.world.add(body);
    this.bodies.push(body);
  }

  // One spark event per hook per frame: the ARRIVAL if one was reported, and
  // otherwise the LATEST report.
  //
  // A single touch is reported by three places that do not know about each
  // other: the flight sweep's hook-proof branch, `probeContact`'s deflection,
  // and the solver's contact list. Two of them fire on the same frame for the
  // same contact, and they do not agree - `physicsStep` runs BEFORE
  // `World.integrate`, so a bounce is taken at the moment of contact while
  // `collectContactSparks` runs after the solve and carries what the frame left
  // behind. Which of those is wanted depends on what the touch WAS, and the two
  // cases want opposite answers:
  //
  // A CONTINUATION - the hook already riding a face - wants the later report.
  // The bounce there is one frame stale, a verbatim copy of the previous
  // frame's contact 0.19 m back along the floor (`session-117f` f74/f75, at
  // 11.5 m/s):
  //
  //   f74 hook=(6.135,9.233)  solver@(6.134,9.255) v=(-11.53,-0.64)
  //   f75 hook=(5.943,9.221)  bounce@(6.135,9.230) v=(-11.53,-0.64)
  //                           solver@(5.942,9.244) v=(-11.30,-0.53)
  //
  // Kept as two events that doubles the slide's spark rate on the frames both
  // fire and spawns the two halves a fifth of a metre apart, which is what made
  // a steady drag read as a series of separate strikes; kept as the bounce it
  // draws every other frame's sparks a frame behind the hook.
  //
  // An ARRIVAL - the throw ending on a wall - wants the bounce, and taking the
  // later report there is exactly wrong. The solver's contact on that frame is
  // the AFTERMATH: `bounce()` has already reflected the hook and scaled what
  // survives by how glancing the hit was, so a shot straight into a face is
  // killed dead and the solver reports the touch at -0.02 m/s of separation
  // where the hook arrived at 11.99. Read as the whole of the strike that is a
  // head-on hit into hook-proof steel throwing NO SPARKS AT ALL.
  //
  // `fromFlight` is what separates them, and it is the hook's own state rather
  // than a judgement about the velocity - the hook was in free flight, and now
  // it is not. Once an arrival is recorded for a hook this frame it is final:
  // nothing later in the frame can be a better account of a touch that has
  // already happened, and `bounce()` ends the flight, so there can only be one.
  private reportSpark(body: PhysicsBody2D, event: SparkEvent, arrival = false): void {
    // Glass strikes no sparks - the ball breaks instead (`shatterIfStruck`),
    // and its glass cuff scraping a wall is glass scraping a wall. Render-only,
    // like every spark event, so this changes nothing the sim does.
    if (this.ball.glass) return;
    const held = this.sparkEventIndex.get(body);
    if (held === undefined) {
      this.sparkEventIndex.set(body, { at: this.sparkEvents.length, arrival });
      this.sparkEvents.push(event);
      return;
    }
    if (held.arrival) return;
    this.sparkEvents[held.at] = event;
    held.arrival = arrival;
  }

  // Camera target for a render frame: the ball's interpolated position, so the
  // camera tracks exactly what is drawn. Following the raw 60 Hz position while
  // the ball renders interpolated would put the jitter back, on screen.
  //
  // While the ball is ROLLING IN it is the SPAWN instead - the point the ball is
  // rolling to (see `SpawnData.roll`). A camera that followed the entry would
  // hold the ball in the middle of the screen for the whole of it, which is a
  // ball rolling on the spot in front of a sliding level: the entry only reads
  // as an entry if the frame stands still and the ball comes into it. Standing
  // where the ball will arrive is also what makes the hand-over invisible - the
  // camera is already looking at the point the ball reaches, so nothing moves on
  // the frame it takes over.
  //
  // The camera rules are evaluated at this point too, which is the right
  // reading of them: what a region frames during the entry is the room the ball
  // is arriving in, not the one it is passing through on the way.
  cameraRenderPosition(alpha: number): Vec2 {
    return this.entry === null ? this.ball.renderPosition(alpha) : this.entry.at;
  }

  // What the camera treats this frame as a SWING on (see `Level.cameraHang`),
  // or null. A chain still in flight is not one: the ball is rolling or
  // falling until the hook bites, and it is the bite that starts the
  // oscillation the lead ratchet and the vertical lock are about.
  //
  // The pull is the first span off the ball's own rim - past the coil, which
  // is chain the ball is wearing rather than chain it hangs from - and the
  // length is what is left past the coil (`Rope.hangingLength`), for the same
  // reason: winding takes chain from the free span onto the rim and the path's
  // TOTAL never changes (session-269f: 1.127 m for a whole hang the ball
  // climbed 40 cm of). It is the free span the winch shortens by hauling the
  // ball up it (see `Rope.solveLengthHolding`), and that is what the wind
  // release watches. The reach is that free span with the slack still in it,
  // which is how far the chain lets the ball get (see `CameraHang`).
  get cameraHang(): CameraHang | null {
    const chain = this.ball.chain;
    if (chain === null || !this.ball.chainAnchored) return null;
    const length = chain.hangingLength();
    return { pull: chain.startPull() ?? Vec2.ZERO, length, reach: length + chain.slack };
  }

  // The player has entered a finish line (see `classes/finishLine.ts`), fired
  // from inside the world's own overlap pass - so the frame it names is the one
  // being stepped, `this.frame` having been taken at the top of it.
  //
  // ONCE, and this is where that is enforced rather than in the area: a level
  // may hold several finish lines (a course with two ways down ends at either),
  // the ball may enter and leave one over several frames, and what any of that
  // means is the FIRST crossing. Nothing here clears it and nothing moves it,
  // which is what `finish-once` asserts.
  //
  // What the page does about it - linger, freeze, and the form - is the page's
  // (see main.ts). The sim carries on stepping exactly as it would have, so a
  // bundle of a run that finished replays and finishes on the same frame.
  private finish(): void {
    // A broken glass ball has nothing left to cross the line with: what is
    // still in the world is its inert body, held where it broke.
    if (this.ball.shattered) return;
    if (this.completedFrame === null) this.completedFrame = this.frame;
  }

  // Open the level on a RECORDED RUN, if the spawn names one (see
  // `SpawnData.arrival` and `level/arrivals.ts`). Build-time, and like the roll
  // below it moves the ball rather than the spawn: the ball starts where the
  // recording started, and the spawn stays the point a reset puts it back at.
  //
  // The stream is deserialized here, once per build, rather than a frame at a
  // time: the pressed and released edges of a frame are a diff against the one
  // before it, so the frames have to be produced in order from the hand the
  // recording began with, and a build is the one place that is true by
  // construction.
  private startArrival(spawn: SpawnData): void {
    const name = spawn.arrival;
    if (name === undefined || name === "") return;
    const arrival = resolveArrival(name);
    if (arrival === null) return;
    if (spawn.roll) {
      // Two openings that cannot both happen, and the arrival is the one that
      // was PLAYED: it says where the ball is, what it does and how long that
      // takes, and a roll underneath it would be a second hand on the same ball.
      console.warn(
        "[spawn] this level's spawn opens on a recorded arrival and also asks to roll in; the arrival is what plays.",
      );
    }
    this.ball.globalPosition = arrival.from;
    this.arrival = { frames: arrival.frames, next: 0 };
  }

  // Has the arrival run out? Run at the top of the frame, beside the entry's
  // own test, so the first frame there is no recorded input left for is the
  // first frame the player plays.
  //
  // There is only one way for an arrival to end, and that is the stream being
  // spent - unlike the roll, which can be argued out of its place by a wall.
  // Nothing about the world can shorten a recording: it is an input stream, and
  // a level that has changed under it plays it out against the level as it now
  // is (which is what `arrival-lands` is a case about).
  private stepArrival(): void {
    const arrival = this.arrival;
    if (arrival !== null && arrival.next >= arrival.frames.length) this.arrival = null;
  }

  // Set the ball rolling in from off to one side, if the spawn asks for it (see
  // `SpawnData.roll`). Build-time, and it moves the ball rather than the spawn:
  // the spawn stays the point the player is handed the ball at, and that is the
  // point everything else in the level was authored around.
  private startRolling(spawn: SpawnData): void {
    const roll = spawn.roll ?? 0;
    if (roll === 0) return;
    // A recorded arrival has already taken the opening, and said so (see
    // `startArrival`).
    if (this.arrival !== null) return;
    if (spawn.hang) {
      // Two openings that cannot both happen: `hang` throws the chain straight
      // up from the spawn and leaves the ball on the end of it, and there is
      // nothing for a ball hanging in the air to roll in ON. The hang is the
      // one kept because it is the one that decides where the ball IS.
      console.warn(
        "[spawn] this level's spawn asks to roll in and to start hanging; a hanging ball has nothing to roll on, so the entry is ignored.",
      );
      return;
    }
    // A ball placed to the left of the spawn rolls right to reach it.
    const dir = roll < 0 ? 1 : -1;
    const from = spawn.x + roll;
    this.ball.globalPosition = new Vec2(from, spawn.y);
    this.entry = { at: new Vec2(spawn.x, spawn.y), dir, best: from, since: 0 };
    // Already at speed on the first frame: the level opens on a ball rolling
    // rather than on one that stands for a frame and is then pushed.
    this.driveEntry();
  }

  // Hold the ball at the entry's roll for this frame (see `ENTRY_SPEED`).
  //
  // Along x only: what the entry is in charge of is the ball coming in, and
  // everything else about it - falling onto the floor, climbing its own lug,
  // being stopped by what stands in the way - is the world's as it always was,
  // which is what makes an entry into a wall a thing that visibly happens
  // rather than a thing that is smuggled through it.
  private driveEntry(): void {
    const entry = this.entry;
    if (entry === null) return;
    const v = entry.dir * BallLevel.ENTRY_SPEED;
    this.ball.linearVelocity = this.ball.linearVelocity.withX(v);
    // Rolling, not sliding: ω = v / r is the spin a ball that got here by
    // rolling is already carrying, so the floor has nothing to correct and the
    // entry neither scrubs nor skids.
    this.ball.angularVelocity = v / this.ball.radius;
  }

  // The input the RUN is played with: the player's own, unless the ball is still
  // rolling in, in which case the aim and the deploy are dropped and only the
  // restart survives (see `entry`).
  //
  // Dropped in the SIM rather than in the input source, so every way of driving
  // a frame gets the same gate: a browser, a scripted playtest and a replay of a
  // recording made in either. The aim is dropped by being answered with the
  // ball's own position, which is the "not aiming" sentinel the pad's released
  // stick already sends (see `BallPlayer.resolveInput`) - so an entry is not a
  // new state for the controller to know about, it is the state it is already in
  // when nobody is aiming.
  //
  // A button held down through the hand-over does NOT throw the chain on the
  // frame control arrives: `pressed` is an edge the input source measures against
  // its own last frame, and that edge happened while the ball was not the
  // player's. The throw costs a fresh press, which is the right price - the
  // alternative is a chain thrown by a hand that was resting on the mouse.
  //
  // While a RECORDED ARRIVAL is playing back, the player's input is not dropped
  // but REPLACED: the frame the recording was played with is what the
  // controller is handed, which is the whole of how an arrival works. The aim
  // steers the loop, the deploy throws the chain, and the run comes out the way
  // it was played - on this level, with this sim, rather than as a picture of
  // one that was.
  private playerInput(input: FrameInput): FrameInput {
    // A broken ball is no one's to steer: no throw, and an aim at its own
    // centre, which is "not aiming" (see `BallPlayer.resolveInput`).
    if (this.ball.shattered) {
      return { ...input, fire: { ...NO_BUTTON }, mouseWorldPosition: this.ball.globalPosition };
    }
    const arrival = this.arrival;
    if (arrival !== null) return arrival.frames[arrival.next++]!;
    if (this.entry === null) return input;
    return {
      ...input,
      fire: { ...NO_BUTTON },
      mouseWorldPosition: this.ball.globalPosition,
    };
  }

  // Has the rolling entry ended, and if not, carry it. Run at the top of the
  // frame, so the frame the ball arrives on is the first one the player plays.
  //
  // Two ways to end, and the second is not a fallback so much as the honest
  // reading of the first: the ball reaches the spawn, or it stops getting any
  // nearer to it - stopped by a wall, a step it cannot climb, a pit it was
  // authored into. Either way the entry is spent, and a spent entry hands over
  // where it stands rather than holding the player's hands off a ball that is
  // never going to arrive.
  private stepEntry(): void {
    const entry = this.entry;
    if (entry === null) return;
    const x = this.ball.globalPosition.x;
    if ((x - entry.at.x) * entry.dir >= 0) {
      this.entry = null;
      return;
    }
    if ((x - entry.best) * entry.dir >= BallLevel.ENTRY_PROGRESS) {
      entry.best = x;
      entry.since = 0;
    } else if (++entry.since > BallLevel.ENTRY_STUCK_FRAMES) {
      this.entry = null;
      return;
    }
    this.driveEntry();
  }

  physicsProcess(input: FrameInput, delta: number): void {
    this.frame++;
    // A broken glass ball is replaced at the spawn once the shards have had
    // their moment (see `respawn`). Until then the world carries on around the
    // inert ball (see `holdShattered`), and a jump press below is still the
    // way to restart the whole level. First thing in the frame, so everything
    // below - the swept finish, the render snapshot - starts from the new
    // ball rather than seeing it jump from where the old one broke.
    if (this.shatteredFrame !== null && this.frame - this.shatteredFrame >= SHATTER_RESPAWN_FRAMES) {
      this.respawn();
    }
    // Where the ball stands as the frame BEGINS, for the swept finish test at
    // the bottom of this method. A local rather than a field because that is
    // the whole of its life, and deliberately not the render interpolation's
    // snapshot beside it (`captureRenderTransforms`), which is render-side
    // state the sim may not read.
    const ballWasAt = this.ball.globalPosition;
    // ...and how fast it was going, which is what a glass ball breaking this
    // frame breaks AT: by the end of the frame the contact solve has stopped it.
    const ballArrival = this.ball.linearVelocity;
    this.sparkEvents.length = 0;
    this.sparkEventIndex.clear();
    this.breakEvents.length = 0;
    this.shatterEvents.length = 0;
    this.ballPushes.length = 0;
    this.ballSparkSpin = null;
    Debug.clear();
    PhysTrace.frame = this.frame;
    PhaseTrace.begin(this.frame, this.world);
    // Snapshot the pre-step transforms the renderer interpolates from.
    this.world.captureRenderTransforms();

    // Restart (top face button → jump field). Replaces this level instance;
    // bail before touching more of the frame.
    if (input.jump.pressed) {
      this.onReset?.();
      return;
    }


    // The two openings, before anything reads the input: while either stands
    // the player's own hands are off the ball (see `playerInput`), and both end
    // at the TOP of a frame, so the frame they hand over on is played with the
    // player's hands on it. The restart above is deliberately upstream of both -
    // a run the player wants to start over is one they may restart while
    // watching it open.
    this.stepArrival();
    this.stepEntry();
    const played = this.playerInput(input);
    this.lastPlayed = played;

    // Scripted movers run first, exactly as they do in `Level`: the ball, the
    // chain and the contact solve all have to see current-frame transforms with
    // the matching per-frame contact velocities, or a body riding a pendulum
    // inherits last frame's motion from it.
    const time = this.frame * delta;
    for (const m of this.movers) {
      m.body.beginMove();
      m.script(m.body, time, delta);
      m.body.commitMove(delta);
      // A platform that moved this frame wakes whatever rests on it; one
      // parked at the end of its route lets that settle and sleep.
      if (
        m.body.linearVelocity.x !== 0 ||
        m.body.linearVelocity.y !== 0 ||
        m.body.angularVelocity !== 0
      ) {
        this.world.wakeTouching(m.body);
      }
    }
    // A running belt wakes what rests on it EVERY frame, not only the frames
    // it moved: its frame never moves while its surface always does, and a
    // static is never a contact's leading side, so nothing else would notice
    // it carrying a sleeping crate. A belt at speed 0 is scenery and wakes
    // nothing.
    for (const belt of this.belts) {
      if (belt.running) this.world.wakeTouching(belt);
    }
    // A cuff riding a belt is carried to where this frame has it, beside the
    // movers and BEFORE anything regenerates the chain's path: the continuous
    // sweep measures the end's motion from where the last regeneration left
    // it, so a carry made here is end motion it sweeps, and a post the belt
    // carries the chain across is caught (`RopeRide`, docs/conveyors.md). The
    // clock is what a hook biting a belt later in this frame starts from.
    this.ball.clock.frame = this.frame;
    this.ball.clock.dt = delta;
    // A ride the geometry has held the ball against until the chain would be
    // longer than any attach may make it is torn off first (see
    // `tearOffOverdrawnRide`).
    this.ball.tearOffOverdrawnRide();
    this.ball.chain?.carryRides(this.frame);

    // Where the ball was facing before anything this frame turned it — the floor
    // the chain's unwind correction may walk its rotation back to, and no
    // further (see Rope.unwindOverLength).
    const ballRotationAtFrameStart = this.ball.globalRotation;
    // A frame's refund is the frame's; a frame whose unwind does not run
    // refunded nothing rather than whatever the last one did.
    this.chainUnwindRefund = 0;
    this.chainBraced = false;

    this.ball.resolveInput(played, delta);
    // The aim steering overwrites the ball's angular velocity outright, so it is
    // a phase in its own right - a spin that appears here is the player's, and
    // one that appears in `unwind` is the chain refusing it.
    this.aimSpin = this.ball.kinematicRotation ? this.ball.angularVelocity : 0;
    PhaseTrace.mark("aim", this.world);
    this.bodies = this.bodies.filter((b) => !b.removed);
    // The hook's attach callback (fired inside the step below) needs the scene
    // to regenerate the chain's wrap path; hand it this frame's bodies.
    this.ball.sceneBodies = this.bodies;

    // Armed hooks run their swept attach check before integration moves them.
    for (const b of this.bodies) {
      if (b instanceof BallHook) b.physicsStep(delta);
    }
    this.bodies = this.bodies.filter((b) => !b.removed);

    // Every body the chain runs over - the anchor it took this frame included,
    // since the attach above has already put it on the path - is held awake
    // for as long as it is on the path: the solve moves it every frame, and
    // what the player does with it next is exactly what a sleeping body could
    // not answer. Before integration, so the anchor integrates on the frame it
    // is taken.
    if (this.ball.chain) {
      for (const node of this.ball.chain.path()) {
        const body = node.contact.obj;
        if (body instanceof RigidBody2D && body.canSleep) body.keepAwake();
      }
    }

    // Whether the contact solver's spin-traction ramp applies this frame: an
    // ATTACHED chain keeps contact dynamics exactly as they always were (see
    // `RigidBody2D.constraintTethered`). Read before the solve from last
    // frame's chain state; the regime does not flip mid-press.
    //
    // Attached, not merely anchored: a dangling tip is a chain the ball is
    // holding rather than one holding the ball, and the chain phase below
    // already charges it nothing (`spinShare` is zero until the end is fixed).
    // Handing the free-ball guards over on its account left the ball with
    // neither - `session-251f` rolled a dangling chain into a rock at 2.5 m/s
    // and was launched 3.3 m/s up its face by a 290 N·s arrival impulse spent
    // against the spin, three times over, and climbed it.
    this.ball.constraintTethered = this.ball.chainAttached;

    const ballVelocityBeforeContacts = this.ball.linearVelocity;
    // The ball's pose BEFORE the contact solve answers it. Sparks are struck by
    // the arrival, and by the time `collectContactSparks` runs the solve has
    // already cancelled it (see there).
    const ballSpinBeforeContacts = this.ball.angularVelocity;
    // A ring the island walked off a hanging cord's free end last frame comes
    // back as the dangling tip before anything reads the chain's end (see
    // `Rope.settleRowEnd`). Only a ring on a link the island owns: a
    // positional ring is answered at its own first look.
    // So does a cuff the island's creep took clear of the mud it bit.
    const ringEnd = this.ball.chain?.end;
    if (
      (ringEnd instanceof RopeVineClamp && ringEnd.link.tied) ||
      ringEnd instanceof RopeEmbed ||
      ringEnd instanceof RopeClamp
    ) {
      this.ball.chain!.settleRowEnd();
    }
    // A stiff span the hook has just threaded onto (the swept attach above)
    // leaves the island before the world steps: the hold is positional, and
    // the ring and the island may not both move its links (see
    // `syncSpanUnits`).
    syncSpanUnits(this.world, this.vines, this.ball.chain, this.ringOnSpan());
    // The authored chains' rows hold what their paths run over now (see
    // `RopeRow.sync`), and the ball's chain is a row of the island it is
    // hooked to, if it is (see `syncBallRow`) - set before the world steps,
    // read inside it.
    for (const row of this.sceneRows()) row.sync(this.world.ties);
    this.syncBallRow(delta);
    this.world.integrate(delta);
    // The flags were for the world's step; the rest of the frame reads the
    // row's bodies as the free bodies they are (the unwind's spin credit, the
    // rest rule, the digest).
    this.untieBallRow();

    // Driving the mounting loop into a surface may never launch the ball. It is
    // written here, after the contacts and the depenetration sweep, because it
    // REPLACES what the solve made of the loop's landing — a phase-dependent
    // launch the player cannot aim (session-1594f).
    this.ball.applyLoopCap(this.world.frameContacts, ballVelocityBeforeContacts);
    PhaseTrace.mark("loop-cap", this.world);

    this.collectContactSparks(ballVelocityBeforeContacts, ballSpinBeforeContacts);

    // The held vine's load ropes, settled for the next frame's rows (see
    // `updateVineLoads`), and every vine's unit kept in step with who holds
    // it (`syncSpanUnits`).
    updateVineLoads(this.vines, this.ball.chain);
    syncSpanUnits(this.world, this.vines, this.ball.chain, this.ringOnSpan());
    // A berry the ball has just struck, or the chain lies over, wakes its vine
    // (see `stepVines`).
    stepVines(
      this.vines,
      touchedBerries(this.vines, this.world.frameContacts, () => this.ball.chain?.path() ?? []),
    );
    // A ball with no chain row is pushed clear of the scenery here.
    // `World.integrate` resolves a circle against one shape at a time, so a
    // ball wedged between two of them keeps a residual that only this
    // simultaneous two-normal solve clears - 3.3 cm of it in `session-726f`,
    // with no chain out at all. Not on a frame the ball is a body of an
    // island (see `syncBallRow`): its overlaps are that island's contact rows,
    // and the statics' push-out follows the island (`closeBallRowFrame`).
    if (this.ballRowActive === null) {
      const leading = this.world.depenetrateRigid(this.ball);
      // A surface the ball was left buried in is one it touched (see
      // `shatterIfStruck`). Collected only for the glass ball, which is the
      // only one that cares.
      if (this.ball.glass) this.ballPushes.push(...leading.filter(BallLevel.realPush));
    }
    PhaseTrace.mark("push-out", this.world);

    // The chain's own bookkeeping, after the island has solved it: the throw's
    // reach, the stow, and the row frame's close.
    this.ball.checkChainReach(this.bodies);
    // A stowed chain pays back out on the frame the ball turns the unwinding
    // way (see `BallPlayer.unstowIfUnwinding`): the frame's rotation is known
    // here, and the phase below then solves the dangling tip it has become.
    this.ball.unstowIfUnwinding(this.ball.globalRotation - ballRotationAtFrameStart);
    // The chain end is "fixed" once it anchors to a surface — before that it is
    // the (in-flight or dangling) BallHook. Catch the false→true transition so
    // the invariant only scrutinises the frame the anchor goes rigid.
    const endFixed = this.ball.chainAttached;
    const anchoredThisFrame = endFixed && !this.endWasFixed;
    if (this.ballRowActive !== null && this.ball.chain) {
      this.closeBallRowFrame(
        this.ballRowActive,
        this.ball.chain,
        delta,
        ballRotationAtFrameStart,
        anchoredThisFrame,
      );
    } else {
      this.anchorKickSpeedGain = null;
      this.chainSolveSpeedGain = null;
      this.chainAnchorLength = null;
      this.chainCreditVelocity = Vec2.ZERO;
      this.chainStallFrames = 0;
      this.chainLeaseHeldFrames = 0;
      this.chainWinchSpeedBudget = 0;
      this.chainCreditOverBound = null;
      this.chainPushOutCredit = 0;
      this.chainPushCreditFrames = 0;
    }
    this.endWasFixed = endFixed;
    // A dangling tip wound all the way onto the rim is stowed there (see
    // `BallPlayer.stowIfWoundIn`). After the phase, on its final length, and
    // before the drape reads a chain whose end has moved onto the ball.
    this.ball.stowIfWoundIn();
    this.settleBallSparkSpin(ballRotationAtFrameStart, delta);

    // The slack chain's visual drape, stepped against the frame's FINAL
    // transforms — after the chain phase, the push-out and the stall lease, so
    // its pinned ends sit exactly where the renderer will draw the ball and
    // the hook. Strictly read-only against the sim (see SlackChain): it moves
    // no body, so every phase mark and invariant above is blind to it.
    this.ball.chainSlack?.step(this.bodies, delta);

    // Last: everything that could move a body this frame has.
    this.world.settleSleep();

    // ...and then what the frame's contacts destroyed (see `level/breakable.ts`).
    // After every phase, because a body taken out of the world mid-frame is one
    // taken out from under whatever was holding a reference to it - the chain
    // phase, the drape, the sleep pass. The contacts this reads are the frame's
    // own and nothing above touches them, so waiting costs the measurement
    // nothing and costs the reader one frame of scenery that was already broken.
    this.breakBodies(delta);

    // The glass ball, on the frame's final contacts: broken by anything solid
    // it touched this frame, and held where it broke on every frame after.
    // After every phase that moves it, for the reason the breakables wait: the
    // chain it lets go of is one the chain phase was holding a reference to.
    if (this.ball.shattered) this.holdShattered();
    else if (this.ball.glass) this.shatterIfStruck(ballArrival);

    // THE CROSSING, SWEPT (see `classes/finishLine.ts`). Last, on the frame's
    // final poses, so what is asked about is the step the player just took.
    //
    // The area's own entry test (`World.notifyAreas`) is a SAMPLE: it asks
    // where the ball is now, once a frame. That is right for a killzone, which
    // is a volume you fall into and stay in, and wrong for a finish line, which
    // is a plane you cross - a region W metres thick is passed through
    // untouched by a ball that travels more than W + its own diameter in one
    // step, which at 1/60 s is 24 m/s through a 16 cm gate. The corpus has the
    // ball at 24.8 m/s in a real session and 34.5 m/s in a rig, so this is a
    // speed the game reaches rather than a theoretical one.
    //
    // So the segment the ball actually travelled is swept against every finish
    // area, with the ball's own radius, exactly as the chain sweeps the spans
    // between its regenerations (see docs/wrap-detection.md). What it buys is
    // that a level may draw its line as thin as the gate it is marking: the
    // promise is "touch the line and the level is over", and a sampled test
    // keeps that promise only below a speed nobody authoring a level is
    // thinking about.
    //
    // The sample stays as well, because the two answer different questions:
    // the sweep catches the ball that crossed, `notifyAreas` catches the ball
    // that was PUT there - a spawn or a checkpoint inside the gate, which moves
    // no distance at all.
    if (this.completedFrame === null && this.finishAreas.length > 0) {
      const motion = this.ball.globalPosition.sub(ballWasAt);
      if (motion.lengthSquared() > 0) {
        for (const area of this.finishAreas) {
          if (bodySweepCircle(area, ballWasAt, motion, this.ball.radius)) {
            this.finish();
            break;
          }
        }
      }
    }

    this.cameraPosition = this.cameraAnchor();
  }

  // Break whatever this frame's contacts finished off: the chain lets go of it,
  // the world loses it, and the render side is handed the one fact it needs to
  // throw the debris.
  //
  // The chain DETACHES rather than following the piece down. A hook that rode
  // the fragment would be an anchor on a body the sim no longer has, and the
  // break is loud enough to read without it: the surface the player was hanging
  // from is gone, and so is the chain.
  private breakBodies(delta: number): void {
    for (const event of this.breaker.scan(this.world, delta)) {
      if (this.ball.anchoredTo === event.body) this.ball.releaseChain();
      removeBrokenBody(this.world, this.bodies, event.body);
      this.breakEvents.push(event);
    }
  }

  // Break the glass ball if it touched anything solid this frame.
  //
  // WHAT A TOUCH IS. Either the contact solve pushed back on it - a contact on
  // the ball that ended the solve carrying normal impulse, which is a landing,
  // a graze or a crate knocked into it, and includes the speculative contact
  // that stops a ball arriving within the slop before it ever overlaps - or a
  // push-out moved it out of a surface the chain had hauled it into, which the
  // contact solve never saw. A speculative contact that pushed nothing is a
  // ball passing close, and is not one.
  //
  // WHAT IS NOT SOLID is everything the solver never pairs the ball with, which
  // is exactly the list the request makes: water and every other area (a region,
  // not a body), a vine (a non-solid link), and the ball's own hook, which it
  // has a collision exception with. The hook and the chain touch whatever they
  // like - neither is the ball.
  //
  // A level already FINISHED is not broken by what the ball meets on its way
  // out of the gate: the run is over and the linger is the page's presentation
  // of that (see `FINISH_LINGER_FRAMES`).
  private shatterIfStruck(arrival: Vec2): void {
    if (this.completedFrame !== null) return;
    const ball = this.ball;
    let struck: { point: Vec2; normal: Vec2; load: number } | null = null;
    for (const c of this.world.frameContacts) {
      // The most it pushed this frame, not what it ended on: a ball tied to a
      // vine is solved in the island's substeps, and a contact there that
      // struck early and let go by the last substep ends on zero
      // (`ContactConstraint.maxNormalImpulse`).
      if (c.maxNormalImpulse <= 0) continue;
      // `normal` is out of `b`, toward `a` (see `ContactConstraint`), so it is
      // out of the struck surface when the ball is `a`.
      let normal: Vec2;
      if (c.a === ball) normal = c.normal;
      else if (c.b === ball) normal = c.normal.neg();
      else continue;
      if (struck === null || c.maxNormalImpulse > struck.load) {
        struck = { point: c.point, normal, load: c.maxNormalImpulse };
      }
    }
    if (struck === null) {
      for (const p of this.ballPushes) {
        if (!p.other.isSolid || p.other instanceof BallHook) continue;
        if (struck === null || p.depth > struck.load) struck = { point: p.point, normal: p.normal, load: p.depth };
      }
    }
    if (struck === null) return;

    this.shatteredFrame = this.frame;
    // Only the ball breaks into pieces; its chain and hook, let go of below,
    // simply go (Tris, 2026-10-16: "the chain and hook shouldn't shatter - just
    // the ball. The chain and hook should just disappear").
    this.shatterEvents.push({
      at: ball.globalPosition,
      rotation: ball.globalRotation,
      radius: ball.radius,
      point: struck.point,
      normal: struck.normal,
      velocity: arrival,
      spin: ball.angularVelocity,
    });
    ball.releaseChain();
    ball.shattered = true;
    // In nothing's way from here on, and nothing in its: a broken ball is not
    // there to be landed on, pushed or hooked.
    ball.passable = true;
    this.shatteredPose = { at: ball.globalPosition, rotation: ball.globalRotation };
    this.holdShattered();
  }

  // Make the ball iron or glass BEFORE THE LEVEL HAS STEPPED - the menu page's
  // pick (see `chooseDifficulty` in main.ts), which must not rebuild a level
  // that is already built, warmed and on the GPU: a rebuild there was a
  // 0.7-0.8 s first frame (measured 2026-10-16), the whole scene re-uploaded.
  //
  // Exact rather than approximate: nothing in the build reads `glass` (the
  // ball's kind is read only by `physicsProcess` and the renderers), so a level
  // built iron and made glass before frame 1 steps bit for bit as one built
  // glass - which is what a replay of the run does (`levelFromRecording`).
  // After frame 0 that is no longer true, and it is refused.
  setBallKind(kind: BallKind): void {
    if (this.frame !== 0) throw new Error("BallLevel.setBallKind: the level has already stepped");
    this.ball.glass = kind === "glass";
  }

  // Start the ball on its anchor, as a spawn that says so asks (see
  // `SpawnData.hang`): at build, and again at a respawn.
  private hangAtSpawn(): void {
    // The attach callback regenerates the chain's wrap path against the
    // scene, exactly as it does mid-play (see `physicsProcess`), so it has to
    // be handed the bodies first.
    this.ball.sceneBodies = this.bodies;
    if (this.ball.anchorOverhead()) {
      // The anchor is OLDER THAN THE FIRST FRAME, so frame 1 is an ordinary
      // frame of a chain that already holds the ball, not the frame it
      // anchored on. The difference is the birth-length re-take below (see
      // `anchoredThisFrame`): it exists because an anchor taken at the top of
      // a frame must not charge the ball for the distance it travels during
      // the rest of that frame, and applied to a spawn anchor it would hand
      // the chain the first frame's fall - the ball hanging 2.7 mm below the
      // point the level authored, off a chain 2.7 mm longer than the one it
      // was built with. Armed here, the solve holds the authored pose
      // instead: nothing moves, and nothing has to settle.
      this.endWasFixed = true;
    } else {
      console.warn(
        "[spawn] this level's spawn asks to start hanging, but nothing within the chain's reach is overhead: starting on the ground.",
      );
    }
  }

  // THE RESPAWN after a glass ball breaks: a fresh ball at the spawn, in the
  // same level, with everything else in it exactly as the last attempt left it.
  //
  // Not a rebuild, which is what a kill zone's reset is (Tris, 2026-10-16:
  // "don't reload the whole page when the glass ball shatters, just respawn the
  // player at the beginning"): a rebuild is a new world and a new 3D scene, and
  // after a break - a thing Hard asks the player to do over and over - it read
  // as the page reloading. A fresh BallPlayer rather than the broken one put
  // back, so that nothing of it carries over (its loop ride, its aim, its wind
  // stall, the layer `passable` moved it to): the old one leaves the world, the
  // new one takes its place in the level's body list, and the renderers follow
  // `ball` to it.
  //
  // Sim state, on a frame of the run: a replay respawns on the same frame, and
  // the recorder's run simply carries on through it.
  private respawn(): void {
    const old = this.ball;
    old.releaseChain();
    this.world.remove(old);
    const ball = new BallPlayer(old.radius);
    ball.glass = old.glass;
    ball.globalPosition = this.spawn.at;
    ball.spawnBody = (b) => this.spawnBody(b);
    ball.vineFor = old.vineFor;
    this.world.add(ball);
    const at = this.bodies.indexOf(old);
    if (at >= 0) this.bodies[at] = ball;
    else this.bodies.unshift(ball);
    this.ball = ball;
    this.shatteredFrame = null;
    this.shatteredPose = null;
    this.endWasFixed = false;
    this.attempt++;
    this.attemptStartFrame = this.frame;
    if (this.spawn.hang) this.hangAtSpawn();
    this.cameraPosition = this.cameraAnchor();
  }

  // Keep the broken ball where it broke, still. It stays in the world - every
  // phase of the frame takes the ball as given, and the camera reads it - but
  // as a body that collides with nothing and is put back each frame wherever
  // gravity or water took it, so the world goes on around it unchanged and the
  // camera holds on the place it broke until the reset.
  private holdShattered(): void {
    const pose = this.shatteredPose;
    if (pose === null) return;
    this.ball.globalPosition = pose.at;
    this.ball.globalRotation = pose.rotation;
    this.ball.linearVelocity = Vec2.ZERO;
    this.ball.angularVelocity = 0;
  }

  // Rewrite the ball's spark event with the spin the frame actually REALISED,
  // in place of the one it carried into the contact solve.
  //
  // A spin a later phase refuses is not a spin: the chain's unwind walks the
  // ball's rotation back to where the frame started it (`Rope.unwindOverLength`)
  // when the chain is wound tight with nowhere left to be hauled, so a ball held
  // against hook-proof steel on a wound-up chain is COMMANDED 25 rad/s by the
  // aim, turns exactly 0 rad, and never moves. `collectContactSparks` runs
  // before that phase and read the command, which put a permanent 3.0 m/s of
  // slip on a contact whose point, pose and velocity were bit-identical frame
  // after frame - a stream of sparks off a stationary ball (`session-313f`,
  // f255 onward: rot=18.8522 unchanged with vt=3.005 every frame).
  //
  // Only the SPIN half is settled here, and only for the ball. The linear half
  // stays the pre-solve arrival on purpose - the contact solve cancels the
  // approach the sparks are struck by, which is the whole reason that half is
  // sampled early (see `collectContactSparks`) - and nothing rolls a body's
  // POSITION back the way the unwind rolls its rotation. Nothing else turns the
  // ball either: `World.integrate` is the only writer of `globalRotation` in the
  // solve, so on every frame no rollback touches, the realised spin equals the
  // commanded one to the bit and this rewrites the event to itself.

  // Clear any overlap between the ball and a rigid body on its chain's path as
  // the PAIR it is: the two pushed apart along the contact normal, split by
  // effective mass with the body's rotation about the contact in the split,
  // and the body debited the velocity for its share - the PBD velocity update
  // for the move, exactly as the ball is credited for its own over the phase.
  // Returns what it pushed the ball out of, for the same books every other
  // push-out feeds (the into-surface refusal, the stall lease, the invariants).
  //
  // The length solve moves EVERY body on the path, split by effective mass, so
  // where the ball rests against the body it is anchored to the solve moves the
  // two into each other - and against a light anchor most of the closing is
  // the anchor's: 80% of it, for a 12.6 kg weight under the 52 kg ball. Cleared
  // by a push-out that moves the ball ALONE, the anchor keeps its position
  // inside where the ball was and the velocity the solve credited it for
  // getting there, while the ball, whose books are taken over the phase, is
  // credited the push-out as speed OUT of the anchor: the two leave together,
  // 0.3 to 2.3 m/s of fresh speed a frame, the ball and its anchor from 1 to
  // 19 m/s in eighteen frames with the stall lease paying out 3 cm of chain a
  // frame to cover the separation (`session-324f` f252-270, the pair flung
  // across the level on winding up into a hung weight). The spin-share
  // rollback cannot reach it: what it rolls back is the kinematic spin's share
  // of the correction, and this over-length is the pair's own motion.
  //
  // Cleared as a pair, each body is pushed back by the share it was hauled in
  // by - the same effective-mass ratio the solve split the haul by - so a ball
  // wound all the way up to a hanging weight sits at the weight's edge with
  // neither of them credited a thing, which is the statement that the chain's
  // tension on the weight and the contact's reaction to it are one force seen
  // from its two ends. Rotation is in the split because the anchor point is on
  // the body's rim: a light body hauled by a corner is turned into the ball as
  // much as it is dragged, and a translation-only push leaves that turn and
  // its credit standing, which is the pivot whip by another door.
  //
  // Only the bodies on the path, because only those did the solve move: the
  // ball hauled into anything else was hauled there alone, and the one-sided
  // push-out that follows is the right answer for a one-sided haul. The winch
  // pass after the rollback hauls the ball alone by construction (the anchor
  // held still for it), so its overlap is left to that same one-sided push-out
  // rather than being split here - pushing the anchor away by a share of a
  // haul the kinematic spin paid for would hand the spin the anchor's momentum.
  //
  // Holding the body still for the solve instead - immovable, as the winch
  // pass holds it - was tried first and is too coarse: it also stops the chain
  // resisting the body's ROTATION while the ball rides it, so a hung weight
  // turning under a wound-tight ball carried 11 cm of length error the solve
  // was forbidden to correct, then took all of it in one frame as a 28 rad/s
  // whip the instant the contact broke (`session-268f` f124-132).
  // A push-out deep enough to be a surface's answer rather than float noise
  // (see `PUSH_OUT_MIN_DEPTH`).
  private static realPush(p: PushOut): boolean {
    return isRealPush(p);
  }

  private settleBallSparkSpin(rotationAtFrameStart: number, delta: number): void {
    const pending = this.ballSparkSpin;
    if (pending === null || delta <= 0) return;
    const realised = (this.ball.globalRotation - rotationAtFrameStart) / delta;
    const correction = realised - pending.commanded;
    if (correction === 0) return;
    const event = this.sparkEvents[pending.at];
    if (event === undefined) return;
    const perp = new Vec2(-pending.lever.y, pending.lever.x);
    this.sparkEvents[pending.at] = { ...event, vel: event.vel.add(perp.mul(correction)) };
  }

  // The touches the SOLVER reports: a hook it is holding against a hook-proof
  // face, which `bounce()` may never see again once the contact does the
  // holding. The
  // constraint list is the honest answer to "what did this body touch this
  // frame" (see `attachToBlockingContact`, which reads it for the same reason),
  // so ask it rather than re-deriving a second contact test that would then have
  // to be kept in step with the solver's.
  //
  // Reports the contact and judges nothing: whether a touch is a hit, a drag or
  // a hook sitting still is a question about the velocity's components, and
  // every spark threshold lives on the render side (`render/sparks.ts`) so
  // tuning has one home.
  private collectContactSparks(ballVel: Vec2, ballSpin: number): void {
    for (const c of this.world.frameContacts) {
      // Deliberately NOT filtered on `normalImpulse > 0`, the "it really pushed
      // back" test `attachToBlockingContact` uses. That is the right question
      // for an attach and the wrong one for a drag: a hook riding along a face
      // it is neither sinking into nor bouncing off carries no normal load at
      // all, so the solver asks for nothing and the filter threw the middle of
      // every slide away. `session-117f` f78-f80 is three consecutive frames of
      // a 8 m/s drag at `normalImpulse = 0.0000`, which is where the stream
      // went silent - and a silence long enough to pass `CONTACT_GAP_FRAMES` is
      // what lets the render side read the far side of it as a fresh arrival
      // and fire a second impact burst mid-slide.
      //
      // What is left is exactly the narrowphase's own answer: a pair inside
      // `CONTACT_SLOP` of each other. On a 2 cm hook that band is 1 cm, and the
      // slide frames above sit 2-3 mm out - touching by any reading. How fast
      // the two are rubbing is then the render side's question, and
      // `SLIDE_MIN_SPEED` is where it is asked.
      // STEEL is what strikes sparks off hook-proof steel, and the level has two
      // pieces of it: the hook, and the cast-iron ball itself. Either side of
      // the pair may be either one. Hook-proof is a per-SHAPE flag, so the
      // surface may be a rigid body (see "Hook-proof surfaces"), and which body
      // leads a constraint is an id ordering - reading `a` alone would answer
      // for half the pairs (the same mistake `applyStaticGrip` was fixed for).
      const aSparks = c.a === this.ball || c.a instanceof BallHook;
      const bSparks = c.b === this.ball || c.b instanceof BallHook;
      // A pair of them meeting each other strikes nothing: the flag is about
      // the SURFACE, and neither of these is one.
      if (aSparks === bSparks) continue;
      const steel = aSparks ? c.a : c.b;
      const other = aSparks ? c.b : c.a;
      const s = other.getShapes()[aSparks ? c.shapeB : c.shapeA];
      if (!s?.impermeable) continue;
      // `c.normal` points out of `b` toward `a`, so it is out of the SURFACE
      // only when the sparking body is `a`.
      const normal = aSparks ? c.normal : c.normal.neg();
      // The relative velocity AT THE CONTACT POINT, which for the ball is the
      // whole question and not a refinement.
      //
      // A rolling ball's contact point is stationary against the ground - that
      // is what rolling IS - so `omega x r` cancels its linear velocity there
      // exactly, and a ball rolling along hook-proof steel throws nothing while
      // one SKIDDING along it throws a stream. Read from `linearVelocity`
      // instead, every ball crossing the level would grind sparks the whole
      // way, and in `levels/ball.json` that is the entire terrain: measured
      // over the corpus the ball is on hook-proof steel on 79 to 99% of frames
      // and its slip there is a mean of 0.00 to 0.05 m/s, so the distinction
      // is the difference between silence and a permanent shower.
      //
      // It is the honest quantity for the hook too and costs it nothing: a
      // `BallHook` carries no spin at all (measured at exactly 0 rad/s across
      // the corpus), so the two spellings agree to the bit and one rule serves
      // both.
      //
      // The BALL's half is taken from the pose it had BEFORE the contact solve,
      // which is the same correction `BallHook.bounce` makes by reporting its
      // pre-reflection velocity. This routine runs after `World.integrate`, and
      // by then the solve has cancelled the approach the sparks are struck by:
      // a ball dropped twelve metres onto hook-proof steel arrives at 15.4 m/s
      // and is reported at 0.11 m/s of closing, under every threshold, so the
      // slam threw nothing at all. The hook needs no such reconstruction, its
      // own `bounce()` having read the arrival at the moment of contact.
      //
      // The lever arm is measured from where the ball ENDED the step, a frame's
      // worth of travel from where it began the approach, which is a millimetre
      // on a 12 cm ball and nothing any threshold here can see.
      //
      // Relative to the surface, since sparks are struck by the two rubbing
      // together: steel riding a moving platform is not sliding on it.
      const r = c.point.sub(steel.globalPosition);
      const arrival =
        steel === this.ball
          ? ballVel.add(new Vec2(-r.y, r.x).mul(ballSpin))
          : steel.velocityAtPoint(c.point);
      const vel = arrival.sub(other.velocityAtPoint(c.point));
      this.reportSpark(steel, { source: steel.id, point: c.point, normal, vel });
      // The ball's spin term is provisional until the frame ends - see
      // `settleBallSparkSpin`. Recorded after the report so the index is the one
      // the event actually landed at, and overwritten by each further ball
      // contact for the same reason `reportSpark` keeps the latest.
      if (steel === this.ball) {
        const held = this.sparkEventIndex.get(this.ball);
        if (held !== undefined) {
          this.ballSparkSpin = { at: held.at, lever: r, commanded: ballSpin };
        }
      }
    }
  }
}
