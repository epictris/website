// BallLevel — level driver for the ball & chain controller. Deliberately a
// separate class from Level: the two controllers share nothing beyond the
// arena data, and keeping the Player frame flow untouched preserves its
// recorded replays bit-for-bit.

import { Vec2 } from "../engine/vec2";
import {
  AnimatableBody2D,
  RigidBody2D,
  shapesCollide,
  VineLink,
  type CollisionObject2D,
  type PhysicsBody2D,
} from "../engine/body";
import { Debug } from "../engine/debug";
import { PhaseTrace } from "../engine/phaseTrace";
import { PhysTrace } from "../engine/physTrace";
import { GRAVITY, PUSH_OUT_MIN_DEPTH, World, isRealPush, type PushOut } from "../engine/world";
import { bodySweepCircle, circleOverlap } from "../engine/collision";
import { BallPlayer } from "../classes/ballPlayer";
import { BallHook } from "../classes/ballHook";
import { FinishLine } from "../classes/finishLine";
import { NO_BUTTON, type FrameInput } from "../input/frameInput";
import {
  scaleLevelData,
  type CameraPathData,
  type CameraRegionData,
  type LevelData,
  type RawLevelData,
  type SpawnData,
} from "./levelFormat";
import { buildLevelBodies, type LevelVisualSource } from "./buildBodies";
import type { MoverScript } from "./movers";
import { collectDecor, type SceneDecor } from "./decor";
import {
  buildVines,
  stepVines,
  updateVineLoads,
  vineChainSet,
  type Vine,
} from "./vines";
import {
  awakeChains,
  buildSceneChains,
  settleChainsAtBuild,
  CHAIN_TOLERANCE,
  refuseRopeBodiesIntoStatics,
  settleChainBodies,
  sleepChains,
  snapshotChainBodies,
  snapshotRopeBodies,
  stepSceneChains,
  sweepChains,
  wakeChains,
  type SceneChain,
  type SceneConstraint,
} from "./chains";
import { buildCameraRules, type CameraHang, type CameraRule } from "../render/cameraController";
import type { SparkEvent } from "./sparkEvents";
import {
  BreakTracker,
  guardBreakables,
  removeBrokenBody,
  type BreakEvent,
} from "./breakable";
import { PX } from "../engine/units";
import { Mathf } from "../engine/mathf";
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

export class BallLevel {
  readonly world = new World();
  readonly ball: BallPlayer;
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
  // The authored shapes that are drawn and never simulated (see Level.decor).
  readonly decor: SceneDecor[];
  // Chains strung between authored bodies (see Level.sceneChains).
  readonly sceneChains: SceneChain[];
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
  // Scratch for the set the chain phase sweeps: the authored chains plus every
  // AWAKE vine's pair chains and its load rope. Handed back as `sceneChains`
  // itself when there is nothing to add, which is what keeps every recorded ball
  // replay bit-for-bit (see `vineChainSet`).
  private readonly solveSet: SceneConstraint[] = [];
  // The authored chains awake this frame (see `awakeChains`), reused per frame.
  private readonly awakeSet: SceneChain[] = [];
  // This frame's set, settled once at the top of the frame so both halves of the
  // chain phase solve the same one.
  private frameChains: readonly SceneConstraint[] = [];
  // This frame's held vine, if the chain is holding a vine link - the vine
  // whose load ropes are in the solve set. Derived once a frame (see
  // `updateVineLoads`) and read by both halves of the chain phase, so the set
  // they solve is the same set.
  private heldVine: Vine | null = null;
  // The pendulums the file authored (see `LevelBodyData.swingAmp`), stepped at
  // the top of every frame. The ball driver has no `init` hook and therefore no
  // hand-written movers, so unlike `Level.movers` this list is exactly what the
  // level FILE asked for.
  readonly movers: Array<{ body: AnimatableBody2D; script: MoverScript }> = [];
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
  //
  // The renderer asks so it can leave the aim reticle off the screen until the
  // ball is the player's to aim (see `render/renderer.ts`): a cursor drawn over
  // an opening it cannot steer is a control that looks broken. The input source
  // asks so it can put the cursor back above the ball on the frame the level
  // hands it over (see `BallInputSource.handOver`).
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
  // Share of the aim's turn the unwind must give back for the turn to count
  // as refused outright (see `BallPlayer.windStall`).
  static readonly STALL_REFUND_SHARE = 0.9;
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

  constructor(rawData: RawLevelData) {
    const data = scaleLevelData(rawData, PX);
    this.cameraRegions = data.cameraRegions ?? [];
    this.cameraPaths = data.cameraPaths ?? [];
    this.cameraRules = buildCameraRules(this.cameraRegions, this.cameraPaths);
    this.ball = new BallPlayer(data.player.radius * BallLevel.BALL_RADIUS_SCALE);
    this.ball.globalPosition = new Vec2(data.player.x, data.player.y);
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
    this.sceneChains = buildSceneChains(data, built);
    // Before the vines, so a vine hung from a lantern is built from where the
    // lantern comes to rest.
    settleChainsAtBuild(this.world, this.sceneChains);
    this.vines = buildVines(this.world, data, built);
    // Both are built, so both can be asked what they hang from: a breakable
    // body under a chain or a vine anchor is one the file got wrong, and it
    // loses its threshold here rather than taking a constraint down with it
    // mid-play (see `guardBreakables`).
    guardBreakables(this.sceneChains, this.vines);
    for (const vine of this.vines) this.bodies.push(...vine.links);
    // A hook that strikes a link threads onto the whole vine (see
    // `lib/vineClamp.ts`), and the level is what knows which vine a link is.
    this.ball.vineFor = (link) => this.vines.find((v) => v.links.includes(link)) ?? null;
    this.decor = collectDecor(built);
    this.visualSource = { data, built };

    // A spawn that says so opens the level already on its anchor (see
    // `SpawnData.hang`). Last of the build, because the throw is swept against
    // the world as it stands: a chain-hung lantern has come to rest
    // (`settleChainsAtBuild`) and the vines exist and know which vine each link
    // belongs to, so the spawn anchor is taken on the same geometry, in the
    // same poses, that the first frame of play will see.
    if (data.player.hang) {
      // The attach callback regenerates the chain's wrap path against the
      // scene, exactly as it does mid-play (see `physicsProcess`), so the build
      // has to hand it the bodies first.
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

  // The chain set as it stands this frame: the authored chains, every vine's
  // pair chains, and the one load rope if a vine is being held. The same array
  // when nothing is held, so the common case allocates nothing.
  private solveChains(): readonly SceneConstraint[] {
    return this.frameChains;
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
  // release watches.
  get cameraHang(): CameraHang | null {
    const chain = this.ball.chain;
    if (chain === null || !this.ball.chainAnchored) return null;
    return { pull: chain.startPull() ?? Vec2.ZERO, length: chain.hangingLength() };
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
    // Where the ball stands as the frame BEGINS, for the swept finish test at
    // the bottom of this method. A local rather than a field because that is
    // the whole of its life, and deliberately not the render interpolation's
    // snapshot beside it (`captureRenderTransforms`), which is render-side
    // state the sim may not read.
    const ballWasAt = this.ball.globalPosition;
    this.sparkEvents.length = 0;
    this.sparkEventIndex.clear();
    this.breakEvents.length = 0;
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
    this.world.integrate(delta);

    // Driving the mounting loop into a surface may never launch the ball. It is
    // written here, after the contacts and the depenetration sweep, because it
    // REPLACES what the solve made of the loop's landing — a phase-dependent
    // launch the player cannot aim (session-1594f).
    this.ball.applyLoopCap(this.world.frameContacts, ballVelocityBeforeContacts);
    PhaseTrace.mark("loop-cap", this.world);

    this.collectContactSparks(ballVelocityBeforeContacts, ballSpinBeforeContacts);

    // A vine is damped and its load rope settled before anything solves against
    // either, so both halves of the chain phase below see the same set.
    this.heldVine = updateVineLoads(this.vines, this.ball.chain);
    stepVines(this.vines);
    // After integration, so a lantern the ball bumped is awake by contact
    // before its chain asks, and its chain comes into this frame's set.
    wakeChains(this.sceneChains);
    this.frameChains = vineChainSet(
      awakeChains(this.sceneChains, this.awakeSet),
      this.vines,
      this.heldVine,
      this.solveSet,
    );

    // Scene chains solve straight after integration, before the ball's own chain
    // phase opens: whatever they move is then part of the state that phase
    // measures itself against, rather than a body shifting under its books. A
    // level with no chains does nothing here, so recorded replays are unchanged.
    //
    // NOT skipped on the frames the coupled sweep below re-solves the same set
    // - which looks like the same system swept twice per frame, and an attempt
    // to drop this pass on those frames measured exactly why it stays: the
    // ball phase's books (its velocity baseline, its credit entitlement) are
    // taken at the top of that phase, so scene chains left to move shared
    // bodies INSIDE it are bodies shifting under its measurements - 1.15 m/s
    // of `rope-credit-unearned` on session-291f, against a corpus that
    // otherwise peaks at 0.21. What made the second sweep cheap instead is
    // `SceneChain.solve`'s identity skip: this pass leaves the set converged,
    // so the coupled sweep's re-solves of it skip until the rope actually
    // disturbs something.
    stepSceneChains(this.solveChains(), this.world, delta);
    PhaseTrace.mark("scene-chains", this.world);

    // Push the ball clear of the scenery before anything measures against it,
    // and before the chain solve rather than after.
    //
    // The rope writes positional corrections straight onto rigid bodies (it
    // sweeps only for the grapple avatar) and pays itself velocity for them,
    // Δposition over Δt — a standard PBD velocity update, and honest, but only
    // if the correction is the last word on where the body ends up. Push out
    // afterwards and it is not: the correction is partly undone while the credit
    // for it is kept, so a ball being hauled into a surface it is resting
    // against banked a little more speed every frame and dragged its whole
    // assembly across the level — `session-394f`, `session-458f`,
    // `session-431f`, `session-726f`, the same bug found four times.
    //
    // Refunding the difference is what each of those fixes tried, and it cannot
    // be made to work: the credit is taken along the correction and has to be
    // handed back along the contact normal, so a refund big enough to stop the
    // compounding also injects velocity sideways, and one small enough not to
    // leaves the compounding. Ordering the frame so the question never arises is
    // the fix — the rope moves the ball last, its credit is exactly the motion
    // the frame ends with, and there is nothing to refund.
    //
    // A rope correction can still bury the ball for one frame; this clears it at
    // the top of the next, before anything measures a length or a velocity
    // against it. That is what keeps a point-blank anchor on the far side of a
    // surface from hauling the ball a little deeper every frame until it is
    // buried in the geometry (session-1048f: 5 cm in, for 49 frames).
    //
    // Unconditional, not only while a chain is anchored: `World.integrate`
    // resolves a circle against one shape at a time, so a ball wedged between
    // two of them keeps a residual that only this simultaneous two-normal solve
    // clears — 3.3 cm of it in session-726f, with no chain out at all.
    // How far the geometry moved the ball, kept because it is the SIZE of what
    // geometry refused this frame and the blocked-length lease may not exceed it
    // (see `Rope.noteGeometryPush`). This leading push-out is part of that sum:
    // it is the frame's first statement that a surface would not let the ball be
    // where the last chain solve put it.
    const pushOutBefore = this.ball.globalPosition;
    this.world.depenetrateRigid(this.ball);
    const leadingPush = this.ball.globalPosition.distanceTo(pushOutBefore);
    // Position-only, so this phase never shows a velocity of its own; it is
    // marked so that what follows is measured from a ball already clear of the
    // scenery, which is the whole point of the ordering.
    PhaseTrace.mark("push-out", this.world);

    // Chain logic runs AFTER integration — the ball is a RigidBody2D, so
    // integration moves it; solving afterwards leaves the frame's final state
    // within the length constraint (solve-then-integrate ended every fast
    // swing frame over-length by |v|·dt). The solver runs only once the chain
    // is fully deployed or anchored; while the hook is in flight the chain is
    // slack (Rope.physicsStep's unfurl handling is Player-specific, so the
    // ball controller skips it entirely).
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
    if (this.ball.chainAnchored && this.ball.chain) {
      const speedBefore = this.ball.linearVelocity.length();
      const positionBeforeChain = this.ball.globalPosition;
      const velocityBeforeChain = this.ball.linearVelocity;
      // Where the steered grip's surface sees the ball as the phase begins, so
      // the grip can be handed what the phase did to it, in the surface's own
      // terms (see `carryStickAnchor` at the end of the phase). The steered
      // grip alone: a ball that is not aiming holds the crate's pin
      // (`applyStaticGrip`), whose anchor IS its stiction, and that one keeps
      // its stand against the chain as it does against everything else.
      const gripSurface = this.ball.kinematicRotation ? this.ball.stickBody : null;
      const gripLocalBefore = gripSurface === null ? null : this.ball.stickLocalOf(positionBeforeChain);
      const gripSurfaceVelocityBefore =
        gripSurface === null ? Vec2.ZERO : gripSurface.velocityAtPoint(positionBeforeChain);

      // How much of the over-length the solve is about to see is the ball's own
      // kinematic aim spin, which `unwindOverLength` will refuse below. The rest
      // is real motion — gravity, momentum, a swing going taut — and is the
      // solve's proper business.
      // The scene bodies this whole phase may move, snapshotted before any of it
      // does. The ball's own chain solve moves whatever lies on its path and the
      // coupled sweep below moves whatever the scene chains hold, and both pay
      // those bodies velocity for it - the same credit `stepSceneChains` has to
      // close against the geometry, and for the same reason (see
      // `settleChainBodies`). The ball is excluded because the books below are
      // its own, taken over this phase with both of its push-outs in them.
      const solveChains = this.solveChains();
      const sceneBefore =
        solveChains.length > 0 ? snapshotChainBodies(solveChains, this.ball) : [];
      // And the rigid bodies the ball's OWN chain runs over - its anchor, and
      // anything it wraps - which no scene chain holds and the settle below
      // therefore never reaches. Their books are the rope's own (see
      // `refuseRopeBodiesIntoStatics`); what is snapshotted here is the
      // velocity each one brought into the phase, which is the bound on what
      // the phase may leave it moving into a surface with.
      const sceneHeld = new Set(sceneBefore.map((s) => s.body));
      const pathBefore = snapshotRopeBodies(this.ball.chain, this.ball).filter(
        (s) => !sceneHeld.has(s.body),
      );
      this.ball.chain.beginFrame(delta);
      // Opens the frame's geometry-push account (see `Rope.noteGeometryPush`),
      // so from here the lease is bounded by what surfaces actually pushed
      // rather than merely by whether any of them touched.
      this.ball.chain.noteGeometryPush(leadingPush);
      this.ball.chain.syncWraps(this.bodies);
      const spinLength =
        Math.abs(this.ball.globalRotation - ballRotationAtFrameStart) *
        Math.abs(this.ball.chain.lengthPerRadian(this.ball));
      // An anchor is born at the length the chain had reached, which is what
      // leaves the constraint already satisfied on its first frame and the
      // solver with nothing to correct (`BallPlayer`'s attach callback). That
      // measurement is taken where the hook attaches - in the swept check at the
      // TOP of the frame, before `integrate` and the push-out move the ball - so
      // the promise holds only for a ball that then does not move. One that does
      // is charged, on its very first frame, for the distance it travelled after
      // the chain was already attached: a ball falling the last 2.5 cm onto the
      // ground had its 6 cm chain measured 2 cm short and the solve flicked it
      // back off the floor at 0.9 m/s (`session-1195f` f590), which is precisely
      // the resting-ball lurch `rope-anchor-kick` is named for.
      //
      // So the birth length is re-taken here, where the frame actually leaves
      // the ball. Not the winding's share of it: chain wound onto the ball's own
      // rim this frame is the winch's to haul in and the unwind's to refuse (see
      // below), and handing it to the length instead would pay the ball for its
      // own kinematic spin. It only ever lengthens, so an anchor born slack -
      // the ball travelling towards it - keeps the length it reached at.
      if (anchoredThisFrame) {
        const born = this.ball.chain.getCurrentLength() - spinLength;
        if (born > this.ball.chain.maxRopeLength) this.ball.chain.maxRopeLength = born;
        this.chainAnchorLength = this.ball.chain.maxRopeLength;
      }
      const overLengthBeforeSolve =
        this.ball.chain.getCurrentLength() - this.ball.chain.constraintLength;
      // Winding chain onto the ball's rim is charged to the ball's spin — the
      // rollback below and the unwind at the end of the phase — only once the
      // chain is ATTACHED to something. Until it is, the far end is the ball's
      // own hook: a quarter-kilo weight on the end of a chain the ball is
      // holding, and pulling it in is the whole of what winding against it can
      // mean. There is no anchor to protect from the spin's share, and nothing
      // for the rotation to be refused on behalf of.
      //
      // Refusing it anyway is what `session-315f` reported. A deployed, unattached
      // chain draped over the scenery blocked its own correction, the unwind
      // walked the frame's rotation back every frame — the aim demanding 4 rad/s
      // and getting none of it — and the contact solve, which had already run,
      // had sold that rotation as roll: the ball crossed 40 cm of the platform it
      // was resting on at 0.46 m/s while its rotation stood still, read from the
      // game as the platform turning to ice for as long as the chain was out.
      // Until the hook lands, the ball turns as freely as it does with no chain
      // deployed at all.
      const spinShare =
        endFixed && overLengthBeforeSolve > 0
          ? Mathf.clamp(spinLength / overLengthBeforeSolve, 0, 1)
          : 0;
      // What winding this frame's chain onto the ball is *worth* as a speed: the
      // winch has to haul the ball that far towards its anchor to pay for it, so
      // it is the floor under how big the solve's correction can honestly be.
      // The kick invariant measures against it (see `rope-solve-kick`).
      this.chainWinchSpeedBudget = spinLength / delta;
      // The solve moves *every* body on the chain's path, so it settles the
      // ball's spin partly by hauling the far end. Hauling the ball is fine —
      // that is the winch, and it is how winding chain onto yourself pulls you
      // towards the anchor. Exporting it to the anchor is not: the spin is a
      // kinematic input with no force behind it, the unwind is about to refuse
      // it anyway, and the anchor keeps whatever it was given. A chain anchored
      // to a rigid polygon resting on the floor was fed 0.08 m/s of it every
      // frame, accelerated from 0.24 to 0.84 m/s, and slid 31 cm across the
      // level carrying the wound-up ball on its corner (session-265f).
      //
      // So the spin's share of the correction is rolled back off everything but
      // the ball, and the unwind pays for it in rotation instead. A frame with
      // no spin, or one whose over-length is real motion, leaves `spinShare` at
      // zero and nothing here happens at all.
      //
      // Off every body but the ball - save the free holder the ball is not
      // riding, and every holder of a BRACED ball, which keep their share (see
      // `keepsHaul` below) - and what the frame then does
      // with the length that rollback re-creates is the whole of the
      // difficulty. Rolling a body back re-breaks a constraint the solve had
      // just satisfied, and the over-length that reappears has to be answered
      // by somebody: by the ball's rotation through the unwind below, or by the
      // ball's POSITION through the winch pass that follows this loop.
      //
      // Which of the two is right turns on whether the body is one a coupled
      // constraint holds. A free body, a pivot or a sprung mount is answered by
      // the unwind: the re-break is the winch's governor, it is what hands the
      // unwind the length to refuse, and weakening it is what ran away on
      // `session-136f`'s sprung log and on `whirl-anchor`'s bar. A body a scene
      // chain or a vine joint holds is answered by the winch: there the
      // correction was split by effective inverse mass against an anchor that is
      // usually LIGHTER than the 52 kg ball, so the unwind would be refusing
      // most of the player's aim rather than the spin's own excess.
      //
      // That distinction used to be drawn by excluding constraint-held bodies
      // from the rollback altogether, and both halves of that were wrong.
      // Excluded, the anchor kept the whole of a rotation the unwind then
      // refused in full: the aim wound 0.55 rad a frame onto a ball whose net
      // turn was exactly zero, the anchor was hauled and PAID for the winding
      // every frame of it, and the pair accelerated together from 3 to 25 m/s
      // over 35 frames with the chain leased out from 1.18 m to 1.80
      // (`session-215f`, the ball wound up into a body suspended on a chain and
      // flung across the level - `session-265f`'s failure exactly, wearing the
      // one mounting that fix did not cover). Rolled back with the length simply
      // dropped, the ball kept only its 19% share and the wind-up would not
      // start at all (`session-190f`). Paid by the winch, both are right, and
      // the vine keeps its aim without needing an exclusion of its own: a link
      // is ~0.05 kg against the ball's 52, which is the same arithmetic taken
      // to its limit (`session-1260f`, 100% of the aim walked back for 59
      // frames at a time with the cursor 90 degrees off the loop).
      //
      // `cli contacts` `hung-anchor` is the slingshot detector - the same weight
      // bolted to the ceiling and hung from it, whipped with identical inputs,
      // 1.6 m/s against 8.5 - and `cli vines` `ball-steer` is the aim detector,
      // 5.8 degrees of loop lag against a 45 degree bar.
      //
      // A SPRUNG body is rolled back like every other - and then handed the
      // LOAD it is still carrying as an explicit force (below, after the
      // rollback), because for it the rollback's premise is half right and
      // half wrong, and the two halves want different answers. Wrong half:
      // a ball winding itself up a chain anchored to a sprung branch is
      // hanging off that branch the whole time, so a rollback that removes
      // the branch's entire share leaves it standing at its UNLOADED rest
      // angle with the ball dangling from it, then springing past it as the
      // wind-up shortens the chain (session-454f, the pivoting log pulled UP
      // by a wind-up that should bear down on it). Right half: the rollback
      // is also the winch's GOVERNOR - re-breaking the constraint is what
      // hands the unwind the length to refuse - and weakening it for a
      // sprung body removes that governor exactly where the anchor is
      // lightest. Both weakenings were tried and both ran away on
      // session-136f's log (torque-arm effective mass arm²/I comparable to
      // the ball's own, torsion damping 0.94/s against a credit re-earned at
      // 60/s): exempted from the rollback entirely, the solve's velocity
      // credit compounded at -2 rad/s per frame into a 13 rad/s whip that
      // buried the log 733 mm in the wall and slung the ball at 24 m/s;
      // keeping only the position share re-broke nothing, so the unwind
      // refused nothing and the same whip arrived through position at
      // -7 rad/s. Bounding the credit by `creditBound` was measured and does
      // not hold either: the bound is computed from the bodies' own
      // velocities, so once the pump pollutes them it chases the runaway
      // (1.9 -> 7.9 rad/s while the credit ran away underneath it). So the
      // rollback stays whole, and the load crosses by the ledge hang's
      // mechanism instead (`applyHangLoad`): a bounded weight-sized impulse
      // per frame, which a spring answers with a damped, settled droop.
      const haulAtSolve = new Map<
        RigidBody2D,
        { position: Vec2; velocity: Vec2; rotation: number; spin: number }
      >();
      // Where the ball stood before the solve, for the one case its own share
      // is rolled back too (an unsupported holder in free air, below).
      const ballAtSolve = this.ball.globalPosition;
      if (spinShare > 0) {
        for (const body of this.bodies) {
          // A sleeping body is not in the solve and cannot be hauled.
          if (body instanceof RigidBody2D && body !== this.ball && !body.asleep) {
            haulAtSolve.set(body, {
              position: body.globalPosition,
              velocity: body.linearVelocity,
              rotation: body.globalRotation,
              spin: body.angularVelocity,
            });
          }
        }
      }
      this.ball.chain.physicsStep(this.bodies, delta);
      // The chain and the scenery's chains are ONE system whenever they share a
      // body, so the solve is swept over the set rather than run once each (see
      // `sweepChains`). The scene chains have already converged among themselves
      // above, so what this sweep resolves is only their answer to what the ball
      // has just pulled on - which is exactly the motion the rollback below is
      // written about, and the reason the anchor's share of the winch stops
      // being spent on an anchor that cannot move.
      //
      // Skipped when the level has no chains, so every level and playtest that
      // predates scene chains replays bit-for-bit.
      if (solveChains.length > 0) {
        sweepChains(
          solveChains,
          {
            rope: this.ball.chain,
            bodies: this.bodies,
            // The coupling's own residual is the whole gate here - see
            // `CoupledRope.settleSet`, which carries the measurement - EXCEPT
            // while the chain is holding a vine, which is a series of pair
            // chains one sweep cannot hold. False whenever no vine is held, so a
            // level without them sweeps exactly as it always did.
            settleSet: this.heldVine !== null,
          },
          delta,
        );
      }
      PhaseTrace.mark("rope-solve", this.world);
      // The solve has just moved the ball and the bodies on its path TOGETHER,
      // and where the ball rests against one of them it has moved the two into
      // each other. That overlap is cleared here, as the pair it is, before
      // anything else reads the positions (see `separateBallFromPathBodies`).
      const pushedOutOf: PushOut[] = this.separateBallFromPathBodies(delta);
      PhaseTrace.mark("pair-push-out", this.world);
      // The rollback's premise - that the winding has no force behind it - is a
      // statement about winding the frame REFUSES: a ball wound tight against
      // its anchor, whose turn the unwind hands back, must not leave the anchor
      // hauled and paid for chain that never wound on (session-215f,
      // session-265f). It is false of winding that is KEPT. Chain that stays
      // wound was hauled in by a tension, and a tension has two ends: the haul
      // that draws the ball up its chain draws the holder down it by the same
      // impulse, split by the effective masses the solve already split it by.
      //
      // Rolling a free holder back and hauling the ball alone against it - the
      // winch pass below, with every other body on the path held immovable -
      // treated that holder as a body of infinite mass for exactly the frames
      // the tension on it was largest. A 21 kg plank hung by its middle from a
      // post, the 15 kg ball hooked to one end and winding itself up in free
      // air, was turned toward the ball by 1.3 rad/s a frame in the solve and
      // handed all of it back by the rollback, every frame for thirty frames,
      // while the ball was hauled from 2 to 12 m/s round an anchor that would
      // not answer: the plank swung on at -4 rad/s, barely touched, and the
      // player was whipped round the end of it (`session-149f` f83-112). The
      // physical answer is the one the solve had already written - the plank's
      // swing stops and reverses under the ball's haul, and the ball, sharing
      // its angular momentum with the plank, is not whipped.
      //
      // So a free rigid body keeps its coupled share, and neither the
      // rollback nor the winch pass touches it. What separates it from the
      // holders the rollback still reaches is what answers the haul: a PIVOT
      // stores it in a frictionless bearing and a SPRING mount in its spring,
      // both of which the whirl governor and `applyHangLoad` are written for;
      // a VINE LINK is the limit case of a light holder (~0.05 kg against the
      // ball) whose whole vine the coupled sweep has to be left to apportion
      // (`session-1260f`, `cli vines` `ball-steer`), and it stays the winch
      // pass's. A free body answers the haul the way the plank does - by
      // moving - and the pair push-out (`separateBallFromPathBodies`) is what
      // keeps the wound-tight regime honest for it: both bodies hauled into
      // each other are pushed back by the shares they were hauled by, so the
      // length the unwind then refuses is the whole of the winding, and
      // neither is credited a thing. `cli contacts` `hung-anchor` holds the
      // slingshot side of this line, `cli spring` `winch-anchor-load-hung` the
      // load side (red on purpose until this landed), `session-149f` is the
      // recorded artifact and `playtests/rigs/hung-plank-wind.json` the
      // instrument.
      //
      // Held by a scene chain or held by nothing. The first cut kept the
      // share only for the chain-held holder, on the argument that a body
      // held by nothing answers only through contacts the rope solve cannot
      // see, and `session-155f` is what that argument costs: a 25 kg stool
      // thrown up and over a grounded ball at rim speed (the braced haul,
      // below) and then, the moment the ball's own share lifted it off the
      // floor, the stool rolled back and the ball hauled ALONE after a 25 kg
      // body flying at 4 m/s as though it were bolted to the sky - 9.7 m/s in
      // sixteen frames, 500 kg m/s from nowhere, the stool's own speed
      // untouched (f110-126). The contacts the solve cannot see are answered
      // where they were answered for the chain-held plank: statics by
      // `refuseRopeBodiesIntoStatics` on the same `pathBefore` snapshot, and
      // another dynamic body by next frame's contact solve. What the kept
      // share buys is the momentum the pair actually has: the ball hauling on
      // a free body across open air closes on it at the share the masses say,
      // not at the winch's whole rate.
      //
      // And only in FREE AIR - while nothing on the chain's path is touching
      // the ball. Riding the body it is wound up to, the ball's winding is
      // exactly the refused kind, and the pair push-out does not keep that
      // regime honest on its own: the solve hauled a ball wound tight onto a
      // hung lamp 94 mm into it in one frame (the aim snapping 0.78 rad), the
      // separation split the overlap by effective mass at the CONTACT - a
      // corner, so the lamp's share was 43 mm and 2.5 m/s straight down against
      // the ball's 37 - the winch pass hauled the ball straight back in, and
      // the frame ended with the lamp knocked into the scenery beneath it and
      // the ball credited 2.7 m/s for a haul the lamp had mostly absorbed. Every
      // frame, for as long as the aim turned: 1 to 7.4 m/s in eight frames and
      // the lamp 117 mm inside a static (`session-193f` f152-177). That is the
      // kinematic spin reaching the anchor through the separation instead of
      // through the solve, which is the whole of what the rollback is for, and
      // the rollback restoring the lamp's pre-solve state is what undid the
      // separation's share of it before. So a holder the ball is touching -
      // by this frame's contact solve, or by the pair separation that has just
      // run - is rolled back exactly as it always was, and only a holder the
      // ball is hauling on across open air keeps the reaction.
      //
      // Open air is the premise of all of that. Every runaway above is a ball
      // with nothing to push against but the chain's own far end: the spin's
      // reaction can only reach the anchor through the chain, so whatever the
      // anchor keeps of it is momentum from nowhere. A ball BRACED - carrying
      // a load-bearing contact this frame against something that is not on
      // the chain's path - has a reaction the world supplies, and there the
      // premise is simply false: the same kinematic spin that the contact
      // solve already lets drive the ball along the ground at rim speed
      // (a gripping contact drives the centre until the contact point stands
      // still, whatever the load) drives the chain onto the rim against the
      // same ground, and a free body on the far end of that chain is hauled
      // by it. It is bounded the way a winch is bounded: the solve's
      // correction is the frame's winding, so nothing on the path is credited
      // more than rim speed, and the pair push-out and the statics refusal
      // stand between the haul and any overlap it creates. `session-427f` is
      // the recording: the ball resting on a slope beside a 25 kg stool it is
      // hooked to, winding on with the stool against it, and the rollback
      // stripped the stool's share on every taut frame (rope-solve +0.35 m/s,
      // spin-rollback -0.35 at f352, whole at f353-357) - the stool crept at
      // the creditless frames' leftovers, then the ball wound tight, stalled
      // at zero spin for 36 frames with 6 cm on lease, and the stool rocked
      // back where it was. Kept, the same wind hauls the stool up and over
      // the ball. So a free holder keeps the coupled share while the ball is
      // braced, riding it or not - the ball hauling on across open air is the
      // only regime the riding gate is about. Pivots, spring mounts and vine
      // links keep their own governors either way.
      const pathBodies = new Set<CollisionObject2D>();
      for (const node of this.ball.chain.path()) pathBodies.add(node.contact.obj);
      let ridingPath = pushedOutOf.length > 0;
      let braced = false;
      for (const c of this.world.frameContacts) {
        if (c.normalImpulse <= 0) continue;
        const other = c.a === this.ball ? c.b : c.b === this.ball ? c.a : null;
        if (other === null) continue;
        if (pathBodies.has(other)) ridingPath = true;
        else braced = true;
      }
      this.chainBraced = braced;
      const freeHolder = (body: RigidBody2D): boolean =>
        !body.pivot && body.spring === null && !(body instanceof VineLink);
      const chainHeld = (body: RigidBody2D): boolean => solveChains.some((c) => c.holds(body));
      const keepsHaul = (body: RigidBody2D): boolean =>
        freeHolder(body) && (braced || !ridingPath);
      // A FREE rigid holder the ball is hauling on across open air, or that a
      // braced ball is hauling on at all, is NOT rolled back: it keeps the
      // coupled solve's share of the haul, which is the reaction to the
      // tension that hauled the ball (see `keepsHaul`). Rolled back: the
      // holder a ball in free air is riding, and every pivot, spring mount and
      // vine link.
      const rolledBack = new Set<RigidBody2D>();
      for (const [body, before] of haulAtSolve) {
        if (keepsHaul(body)) continue;
        rolledBack.add(body);
        body.globalPosition = body.globalPosition.sub(
          body.globalPosition.sub(before.position).mul(spinShare),
        );
        body.linearVelocity = body.linearVelocity.sub(
          body.linearVelocity.sub(before.velocity).mul(spinShare),
        );
        body.globalRotation -= (body.globalRotation - before.rotation) * spinShare;
        body.angularVelocity -= (body.angularVelocity - before.spin) * spinShare;
      }
      // And the BALL's own share goes with it when the holder it is riding is
      // held by nothing at all - not the ground, not a scene chain, not
      // another body - and the ball has no brace of its own. The rollback
      // restores such a holder to the digit and leaves the ball's share of
      // the winding standing, which is the ball winching itself toward a body
      // that never answers: `session-325f`, a 25 kg stool thrown up by the
      // braced haul with the ball wound point-blank onto it, both in the air
      // for 36 frames, the stool in plain free fall (its solve share +12 mm a
      // frame, rolled back whole) while the ball was hauled 5.5 mm a frame
      // toward it and credited 0.33 m/s for each - rising 0.9 m against
      // gravity, swinging round the stool at 3.7 m/s and landing at 5.7
      // (f144-182). Keeping the holder's share instead was measured first and
      // pumps the same way `session-215f` does (the stool thrown at 5.3 m/s,
      // the ball still lifted 0.7 m). Nothing in the air can wind against a
      // body that nothing holds, so the winding is refused whole: the ball's
      // position goes back to where the solve found it, the phase-end credit
      // reads the displacement that survived (none), and the unwind hands the
      // frame's turn back. A holder resting on the floor, hanging from a
      // scene chain or leaning on anything else still gives the ball its
      // winch, exactly as before - that support is what a wind-up onto a
      // crate on a ledge is pulling against.
      //
      // And with it when the ball is BRACED and the free holder is riding it
      // (or it the holder): a winch drum bolted to the ground by its brace
      // does not move toward the load it is hauling over itself. The solve
      // splits the winding by inverse mass, so the ball takes a third of it
      // toward the holder's anchor and the holder two thirds toward the
      // ball's rim; the pair push-out then splits their overlap along the
      // CONTACT normal, and where the chain and the contact are not
      // collinear - a stool sitting on the ball, hooked at a corner - the
      // difference leaks out as motion every frame: 3.4 mm right and 6.8 mm
      // up on the ball, 1.2 and 2.8 back, net a hop of 4 mm a frame that
      // outran gravity, unloaded the floor, and let a 52 kg ball creep 7 cm
      // to the right under the stool going over it with friction reading
      // nothing to hold (`session-179f` f134-170, felt as the ball being
      // pushed back). The holder keeps its share and climbs; the ball's own
      // share is re-broken length the unwind hands back; the ground supplies
      // what the drum needed, which it always could.
      const holder = this.ball.chain.end.contact.obj;
      const holderUnsupported =
        holder instanceof RigidBody2D &&
        !chainHeld(holder) &&
        !this.world.frameContacts.some(
          (c) =>
            c.normalImpulse > 0 &&
            ((c.a === holder && c.b !== this.ball) || (c.b === holder && c.a !== this.ball)),
        );
      if (
        spinShare > 0 &&
        holder instanceof RigidBody2D &&
        freeHolder(holder) &&
        ((!braced && rolledBack.has(holder) && holderUnsupported) || (braced && ridingPath))
      ) {
        this.ball.globalPosition = this.ball.globalPosition.sub(
          this.ball.globalPosition.sub(ballAtSolve).mul(spinShare),
        );
      }
      // The rollback has taken the spin's share off the anchor, and the length
      // that share was paying for is still OWED. The winch is what pays it, and
      // the winch hauls the BALL - so the same constraint is solved once more
      // with every other body on the path held immovable
      // (`Rope.solveLengthHolding`). Nothing here is a new entitlement: it is
      // the length the ordinary solve already measured, put where the rollback
      // says it belongs instead of being dropped on the floor.
      //
      // Dropped, what the ball keeps is its own inverse-mass share of the
      // correction, and against a light anchor that is almost nothing: a 12.6 kg
      // anchor leaves the 52 kg ball 19% of it, the unwind refuses the other 81%
      // out of the frame's rotation, and the wind-up cannot start. The cursor
      // was circled twice right round the ball over 65 frames and the ball
      // gained no wraps at all (`session-190f`, reported as the ball's rotation
      // being fixed in place while it was being wrapped up its chain). It is the
      // same arithmetic that made `session-1260f`'s 0.05 kg vine link refuse
      // 100% of the aim, and the reason the rollback used to skip a body a scene
      // constraint holds - an exclusion this replaces, since the length is now
      // paid rather than merely un-exported.
      //
      // Forgiving the unwind that length instead is the other tempting answer
      // and it is worse: the re-break is the winch's GOVERNOR, and un-governed
      // the same wind-up slings the ball at 31 m/s (measured, on the light hung
      // weight `cli contacts` `hung-anchor` whirls).
      //
      // Owed only where a coupled constraint holds the anchor, and that gate is
      // load-bearing rather than cautious. A PIVOT or a SPRING mount is held by
      // its own mounting, not by the sweep, and there the re-break is exactly
      // what `pivotSpinDebt` and the unwind are written to charge back: paying
      // it by hauling the ball instead re-feeds the orbit the whirl governor
      // exists to starve, and `cli spring` `whirl-anchor` goes from 8.6 m/s to
      // 27.3 with the gate removed.
      //
      // And owed only for a holder ON THE PATH. The gate used to ask whether
      // any rolled-back chain-held body existed at all, and `haulAtSolve` is
      // every rigid body in the level: in an arena with eleven scene chains
      // the answer was yes on every frame the ball rode its anchor in free
      // air, whatever it was anchored to, and the winch pass then hauled the
      // ball alone with the path held immovable - a 25 kg stool the ball was
      // riding, already thrown at 4 m/s, treated as bolted to the sky for the
      // length its rollback re-created, and the ball hauled after it by 44 mm
      // a frame to 9.7 m/s while the stool's own speed never changed
      // (`session-155f` f110-126). A hung lamp on the far side of the level
      // is not what makes the stool's re-broken length the winch's to pay.
      const winchOwed = [...haulAtSolve.keys()].some(
        (b) =>
          pathBodies.has(b) &&
          !keepsHaul(b) &&
          !b.pivot &&
          b.spring === null &&
          solveChains.some((c) => c.holds(b)),
      );
      if (spinShare > 0 && winchOwed) {
        const heldForWinch = new Set<CollisionObject2D>();
        for (const node of this.ball.chain.path()) {
          const obj = node.contact.obj;
          if (obj !== this.ball) heldForWinch.add(obj);
        }
        if (heldForWinch.size > 0) this.ball.chain.solveLengthHolding(heldForWinch);
      }
      // Length the solve paid by rotating a PIVOT body, and which the rollback
      // kept, is length the ball's spin still owes (the unwind below is handed
      // it as negative forgiveness). A pivot anchor is the one body the winch's
      // governor cannot reach on its own: it co-rotates with a whirling ball, so
      // the chain never winds tight, the unwind never sees the over-length, and
      // the kinematic aim's winch budget pays the whirl every frame with the
      // frictionless bearing storing it - the elbow rig's slingshot (static
      // anchor 2.5 m/s, the same bar on a pivot 37 m/s, identical inputs).
      // Charging the paid length back to the spin stalls the whirl the way a
      // static anchor does. Free rigid bodies are deliberately NOT charged: their
      // kept share is real momentum transfer, damped by their own contacts and
      // mass, and double-refusing it is session-337f's stiffness. The unwind's
      // own window bounds the charge to the frame's turn, so a frame with no
      // aim spin is charged nothing whatever the debt says.
      let pivotSpinDebt = 0;
      for (const [body, before] of haulAtSolve) {
        if (!body.pivot) continue;
        const keptRotation = body.globalRotation - before.rotation;
        if (keptRotation === 0) continue;
        const lengthChange = this.ball.chain.lengthPerRadian(body) * keptRotation;
        if (lengthChange < 0) pivotSpinDebt -= lengthChange;
      }
      // What the spin's share of the solve took back off everything but the ball
      // (session-265f). Zero on a frame with no aim spin.
      PhaseTrace.mark("spin-rollback", this.world);
      // Settled after the rollback and not before it, so the displacement the
      // credit is taken over is the one the phase actually ends on - a rollback
      // run afterwards would undo part of the move while the credit for it
      // stayed, which is the whole failure this exists to prevent.
      const blockedScene =
        sceneBefore.length > 0
          ? settleChainBodies(solveChains, sceneBefore, this.world, delta)
          : new Set<RigidBody2D>();
      // The same closure for the ball's own anchor, which used to have none.
      //
      // A rigid body the chain is anchored to is hauled by the solve exactly as
      // a scene chain's plank is, and paid velocity for it exactly the same
      // way: Δposition over Δt, honest only if the correction is the last word
      // on where the body ends up. For an anchor resting on static geometry it
      // was not. The frame ended with the anchor inside the surface and the
      // credit kept; next frame's `integrate` pushed it out positionally and
      // the contact solve killed the approach at the contact - but the chain
      // had already re-measured a gap that was the push-out's depth plus the
      // distance the credit had carried the body, and paid for that too. Gain
      // above one, and it compounded: `session-133f`, a 91 kg plank resting
      // across two posts, the ball re-hooked to it while falling at 1.7 m/s.
      // The snap credited the plank 0.37 m/s and 0.48 rad/s, next frame 0.49
      // and 0.63, and once the credited spin had lifted the plank's far end off
      // its post the contact could only pivot it on the near post's corner:
      // 1.9, 2.5, 3.0, 3.6, 4.1 m/s downward over the next five frames, the
      // corner's push-out growing 92, 111, 130, 144, 156 mm to match, until the
      // plank's end stood 89 mm inside a 200 mm foot and the next push-out
      // let it out sideways through the foot's inner face. It replayed
      // HEALTHY: nothing watched a rigid anchor's depth in the scenery, and
      // the ball's every invariant is about the ball.
      //
      // `session-147f` was this failure on a scene chain and `settleChainBodies`
      // is its fix, in the same words; the ball's chain never went through it
      // because its anchor is held by no scene constraint. What is applied
      // here is the closure alone - push out of the statics, refuse the
      // velocity into them - and NOT the credit replacement: the ball's chain
      // bounds its own credit and those bounds stay. `plank-anchor` in `cli
      // contacts` is the detector, and `chain-body-embedded` is the invariant
      // that would have caught the recording.
      const blockedPath = refuseRopeBodiesIntoStatics(pathBefore, this.world, delta);
      // ...and a chain-held body on the ball's path that the scene settle had to
      // push out of the scenery is blocked by the same token, whichever phase
      // did the pushing: the plank under the ball's hook that the feet refused
      // (`session-193f`) is the ball's to take the correction for exactly as a
      // plank no scene chain holds is.
      for (const body of blockedScene) {
        if (this.ball.chain.path().some((n) => n.contact.obj === body)) blockedPath.add(body);
      }
      const pathBlocked = blockedPath.size > 0;
      // What a blocked anchor could not take of the correction is still owed,
      // and it is the ball's: the same constraint solved once more with the
      // blocked bodies held immovable, as the winch pass above holds the whole
      // path. Without it the ball keeps the anchor's refused share as
      // over-length every frame and hangs that much lower than its chain says,
      // re-corrected and re-refused for as long as it hangs there.
      if (pathBlocked) this.ball.chain.solveLengthHolding(blockedPath);
      // Position for the scene's chain-held bodies, and the velocity they are
      // owed for it - the ball's own share of this phase is `chain-velocity`.
      PhaseTrace.mark("chain-settle", this.world);
      // The load the rollback just removed from the anchor, re-applied as the
      // bounded force it really is (see the comment above `haulAtSolve`): the
      // ball's weight, straight down at the anchor point, scaled by the share
      // the rollback removed - `applyHangLoad`'s statement, made about the
      // chain. A constant force is what a spring answers with a damped,
      // settled droop; a velocity credit is what it answers with a whip
      // (session-136f).
      //
      // Every PIVOT holder, plain or sprung, and the linear spring. The
      // rollback's premise - that the winding has no force behind it - is
      // about the winch's haul, and the ball's weight hangs on the anchor
      // whether or not the ball is winding. Once the ball is rising under the
      // previous frame's winch credit its own motion closes the constraint,
      // the whole of the frame's over-length is the winding's, `spinShare`
      // reads 1 and the rollback strips the anchor's entire share - the
      // weight with it. So a wind-up UNLOADED its anchor, and the harder the
      // player wound the less the anchor felt: a pulley disc the ball had spun
      // to 2.4 rad/s by hanging off it slowed to a stop and reversed as the
      // ball wound up its chain, driven only by its counterweight
      // (`session-106f`, a plain pivot with no path for the weight at all -
      // its rotation credit saturates, see `Rope.boundRotationCredit`). What
      // it should have felt is a chain hauling 52 kg upwards, which is a
      // tension of at least the weight. The haul's own acceleration is
      // deliberately NOT paired onto the anchor: the winch is kinematic and
      // unbounded, and exporting it is the slingshot `session-215f` and
      // `whirl-anchor` are about. The weight is the bounded statement, exactly
      // as it is for a spring.
      //
      // A FREE rigid holder is deliberately still left out, and the omission
      // is measured rather than cautious. The same wind-up unloads it the same
      // way - `session-126f`'s ceiling-hung wheel slows and reverses exactly
      // as the disc did - but a steady force is a stand-in only for a body
      // that answers it with a bounded state: a bearing takes the torque, a
      // spring droops. A free body answers with acceleration, and the impulse
      // model has no same-frame tension to resist it: handed the ball's weight
      // at the wrap's tangent, `session-324f`'s 12.6 kg hung weight was spun
      // by up to 7 rad/s a FRAME, fought back by its hanger chain the frame
      // after, and the jitter read 85 J of unforced gain against a 47 J bar;
      // and `session-611f`'s 430 kg floor polygon was tipped by it into a
      // wound-tight pose whose unwind stalls 25 cm over length. The honest
      // answer for a free holder is the coupled solve itself keeping the
      // load's share of the correction - which is the rollback's own
      // machinery - not a second force. `cli spring` `winch-anchor-load-hung`
      // is the red-on-purpose record of that half.
      //
      // Scaled by the rollback share, so a frame with no winding hands over
      // nothing: there the anchor's share of the correction stands and its
      // credit already carries the load (a free body's Δθ/dt is the effective-
      // mass split, m·g·r/(I + m·r²), measured to the digit on session-106f's
      // disc), and a second full weight would double it - `chain-load`'s
      // closed form is the detector for the linear spring, whose semantics
      // this generalises. A TORSION-SPRUNG holder is the exception and carries
      // the FULL weight on every hanging frame: its rotation credit no longer
      // refunds the spring's bite (see `Rope.boundRotationCredit` and
      // `RigidBody2D.pivotFrameAccelDw`), so its credits cannot stand in for
      // the static load at all - without this the branch hovers ABOVE its
      // torque balance, lifting against a weight it never feels.
      //
      // It is applied ONLY while the chain is what carries the ball: the ball
      // hanging below the anchor, with no loaded contact under it. Both gates
      // are load-bearing, and the second was found the hard way. A ball wound
      // all the way up RIDES the body it is anchored to, and the contact solve
      // is already delivering its whole weight there - so the ungated impulse
      // was a second, phantom 510 N, aimed along the anchor-to-ball line,
      // which ROTATES as the wound-up ball orbits: a rotating force pumps the
      // hinge like a hand on a swing, and over 40 riding frames of
      // session-1010f it wound the log to -4 rad/s with the ball surfing the
      // tip at 13 m/s, read as the branch flinging the player off. Gravity's
      // own direction cannot pump (it is the constant force the spring's rest
      // pose already answers), and a frame where a contact carries the ball
      // has nothing for the chain to hand over.
      //
      // And applied AFTER `settleChainBodies`, which is not a detail. The
      // settle SETS a scene-chain-held body's velocity - the phase's snapshot
      // plus the displacement that survived the rollback, over dt - and so
      // discards every impulse laid on such a body earlier in the phase.
      // `session-106f`'s disc carries its counterweight on a scene chain, and
      // with this impulse applied before the settle it was measured arriving
      // at +0.075 rad/s a frame (m·g·r/I on the disc) and being removed to
      // the last digit in the same frame. A holder no scene chain holds is
      // untouched by the settle, so its frame is bit-identical either side.
      if (this.ball.chain && endFixed) {
        const holder = this.ball.chain.end.contact.obj;
        const share =
          holder instanceof RigidBody2D && holder.pivotSpring !== null
            ? 1
            : spinShare;
        if (
          share > 0 &&
          holder instanceof RigidBody2D &&
          (holder.pivotSpring !== null ||
            (haulAtSolve.has(holder) && (holder.pivot || holder.spring !== null)))
        ) {
          // At the point the chain LEAVES the holder, not the knot: a chain that
          // has come round its holder pulls at the tangent beside it (see
          // `Rope.endLoadPoint`), and a weight hung on the far side's knot turns
          // the holder the wrong way once the wrap passes a half turn.
          const anchor = this.ball.chain.endLoadPoint() ?? this.ball.chain.end.contact.globalPosition;
          const hanging =
            this.ball.globalPosition.y > anchor.y &&
            !this.world.frameContacts.some(
              (c) => c.normalImpulse > 0 && (c.a === this.ball || c.b === this.ball),
            );
          if (hanging) {
            holder.applyImpulse(
              GRAVITY.mul(this.ball.mass * share * delta),
              anchor.sub(holder.globalPosition),
            );
          }
        }
      }
      // The hanging ball's weight, handed to whatever holds the chain's far end.
      PhaseTrace.mark("hang-load", this.world);
      // A rope correction is still free to shove the ball into something on its
      // way; push out again so the frame does not *end* inside the scenery, and
      // then set the chain phase's velocity contribution to the displacement it
      // actually produced, both push-outs included. This is the PBD velocity
      // update the rope does for itself (Δposition over Δt), just taken over
      // where the frame really ends — so the ball can never bank speed for a
      // move that was undone, and there is nothing left to refund.
      const solvePushBefore = this.ball.globalPosition;
      pushedOutOf.push(...this.world.depenetrateRigid(this.ball).filter(BallLevel.realPush));
      this.ball.chain.noteGeometryPush(this.ball.globalPosition.distanceTo(solvePushBefore));
      // Whatever length the frame still owes after that, take it out of the
      // ball's spin before anything else sees it. Winding chain onto the ball is
      // meant to work, and while the solve can pay for it by hauling the ball
      // towards the anchor it does; this is only the end of that, wound all the
      // way up with nowhere left to be hauled, where the spin has to give the
      // last radian back instead (session-475f). Never more than the frame's own
      // turn, so a wound-up ball stalls rather than unwinding itself
      // (session-394f). And never at all while the chain is unattached: the
      // rotation is only the spin's to give back where winding it on was
      // something an anchor could refuse — see `spinShare` above.
      // The whole slingshot machinery below - the kept-winding allowance and
      // the geometry-gated lease - is scoped to a chain ANCHORED TO A PIVOT
      // body, which is the diagnosed class: only a frictionless bearing lets
      // the whirl run, and only there do the two gates bite. Every other
      // anchor's frame is bit-identical to what it always was, which is what
      // keeps session-726f's legitimately blocked point-blank anchor (whose
      // wound-tight unwind runs for hundreds of resting frames) exactly as
      // recorded - scoped wider, the dying allowance there stripped credit for
      // travel the solve still wrote, and `roll-unfunded` fired on it.
      const anchorHolder = this.ball.chain.end.contact.obj;
      const pivotAnchored = anchorHolder instanceof RigidBody2D && anchorHolder.pivot;
      let unwindRemoved = 0;
      if (endFixed) {
        // Forgiving the sweep's own tolerance while a vine is held: that is the
        // one case where the coupled sweep leaves the chain inside
        // `CHAIN_TOLERANCE` instead of solving it to convergence, and the spin
        // may not be billed for a solve the phase chose to skip (session-337f,
        // and see `Rope.unwindOverLength`). Zero on every other frame, so
        // nothing without a vine in it changes at all.
        const lengthBeforeUnwind = this.ball.chain.getCurrentLength();
        const rotationBeforeUnwind = this.ball.globalRotation;
        this.ball.chain.unwindOverLength(
          this.ball,
          ballRotationAtFrameStart,
          delta,
          (this.heldVine !== null ? CHAIN_TOLERANCE : 0) - pivotSpinDebt,
        );
        // The unwind only rotates the ball, so this difference is exactly the
        // wound length it gave back - winding the frame did not keep.
        unwindRemoved = Math.max(
          0,
          lengthBeforeUnwind - this.ball.chain.getCurrentLength(),
        );
        // A turn the chain refunded (nearly) whole is one the steering may
        // not write again until something changes (`BallPlayer.windStall`).
        // Nearly, because a partial refund is a wind-up in progress - the
        // ball riding around the body it is hauled against - and only a turn
        // that bought nothing is a stall.
        // And only where a body on the path is what refused it: the stall is
        // the contact's, and it lasts exactly as long as the contact does
        // (`BallPlayer.windStallHeld`, cleared by the steering when it drops).
        //
        // And only where turning WINDS. The unwind refunds whatever of its
        // window the standing over-length asks for, and that over-length is
        // rarely the spin's own: a ball resting against its anchor body
        // carries millimetres of it from the push-out every frame. So a ball
        // anchored point-blank with the chain leaving it RADIALLY - a spool of
        // 2.6 mm/rad, turning winds nothing - had a 0.5 rad/s ask refunded
        // whole by 3.5 mm of push-out that had nothing to do with it, and read
        // in radians the refund was 100% (`session-287f` f181). Latched on
        // that, the steering was dead for a 200 degree sweep of the aim while
        // the ball sat against a pulley disc: a rotation frozen by a refusal
        // that refused nothing, because there was nothing to refuse.
        // The stall is a statement about a chain WOUND onto the rim - the
        // hammer is 40 rad/s winding 6 cm a frame (`session-154f`), and the
        // wound-tight endgame it also holds is `session-611f`'s: a coil that
        // has taken the whole chain, the unwind's search failing for 35 frames
        // with 19 cm standing, and a 3 rad/s ask refunded whole at a spool of
        // 52 mm/rad the one thing that stopped the ball winding further. What
        // separates the two is the spool, not the size of the refund (2.7 mm
        // there, and it MUST latch), so the latch asks for a spool at rim
        // scale: `BallPlayer.STALL_LATCH_SPOOL_SHARE` of the ball's radius.
        //
        // And only where the turn asked for a stall's worth of chain. The
        // refund is judged as a share of the ask, and the ask of a steering
        // that has REACHED its aim is the proportional residual - thousandths
        // of a radian a second, micrometres of chain at any spool - which a
        // ball hanging on a taut chain against its anchor body has refunded
        // whole every frame, there being nothing to wind. So the ball latched
        // the moment it settled on its aim, with nothing refused, and stayed
        // latched for as long as it touched the weight: dead through a 180
        // degree sweep of the aim on a 7 micrometre ask (`session-379f`
        // f301-360). The ask must be worth at least `STALL_EPSILON` of chain
        // at the spool - the same floor under which `chainStallFrames` calls a
        // stall float noise - before a whole refund is a refusal. The wound-
        // tight latch is far above it (`session-611f` f284 asked 3.4 mm), and
        // so is the hammer; what sits under it is the last degree or two of a
        // turn the chain will not give, which the steering may go on asking
        // for and being refused, since a refused micrometre costs nothing.
        //
        // And only in FREE AIR - never while the ball is braced (see `braced`
        // above). The latch is a statement about a ball held by nothing but
        // the body it is wound up to: there a refused turn will be refused
        // again next frame by the same geometry, and asking on is churn.
        // Braced, the ball has the leverage to haul, the holder keeps the
        // haul, and a turn refunded whole is the frame the haul JAMMED - the
        // free body dragged up against the ball, its base stopped by the
        // ball's own side while the chain pulls its top over - not the frame
        // it ended. Each frame from there the solve lifts the holder a few
        // millimetres up the rim, the pair push-out and the statics refusal
        // take the rest back, and the unwind refunds the ask less that
        // progress; latched on the first such frame, the spin is dead for as
        // long as the two touch and the holder never climbs (`session-427f`,
        // the stool jammed against the grounded ball with the aim turning;
        // `rig-braced-box-wind` reproduces it on a flat floor, the box
        // dragged at 0.57 m/s up to the ball and the latch closing on the
        // frame it arrives, f72). A static anchor point-blank has never
        // latched - `windStallHeld` asks for a rigid body - and runs its
        // wound-tight unwind for hundreds of resting frames (`session-726f`);
        // a braced ball against a rigid holder is that case with a holder
        // that can move.
        //
        // Released by bracing, not merely withheld: a haul up a slope hops
        // the ball off the floor for a frame or two (the ball's own share of
        // the correction has an upward component the floor does not answer
        // while the ball is in the air), the latch closed on that frame, and
        // it then held for as long as the stool was touched - the ball back
        // on the ground with its leverage and its spin dead (the `session-427f`
        // continuation, f497). The latch is a statement about a ball with no
        // leverage, so the frame the ball has some is the frame it ends.
        const asked = Math.abs(this.aimSpin) * delta;
        const refunded = Math.abs(this.ball.globalRotation - rotationBeforeUnwind);
        this.chainUnwindRefund = refunded;
        const path = this.ball.chain.path();
        this.ball.windStallHeld = this.world.frameContacts.some((c) => {
          if (c.a !== this.ball && c.b !== this.ball) return false;
          const other = c.a === this.ball ? c.b : c.a;
          return other instanceof RigidBody2D && path.some((n) => n.contact.obj === other);
        });
        const spool = Math.abs(this.ball.chain.lengthPerRadian(this.ball));
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
          refunded >= BallLevel.STALL_REFUND_SHARE * asked &&
          spool >= BallPlayer.STALL_LATCH_SPOOL_SHARE * this.ball.radius
        ) {
          this.ball.windStall = Math.sign(this.aimSpin);
        }
      } else {
        // Nothing anchored refuses a turn, so nothing withholds its drive.
        this.ball.spinDriveShare = 1;
      }
      PhaseTrace.mark("unwind", this.world);
      // The unwind just turned the ball, and the ball is not only a circle — it
      // carries its mounting loop out on the rim, so a rotation can swing that
      // into geometry the push-out had already cleared. Clear it again; the
      // velocity below is derived after both, so neither costs anything.
      const unwindPushBefore = this.ball.globalPosition;
      pushedOutOf.push(...this.world.depenetrateRigid(this.ball).filter(BallLevel.realPush));
      this.ball.chain.noteGeometryPush(this.ball.globalPosition.distanceTo(unwindPushBefore));
      // Discounted the same way the solve discounts its own credit: a length
      // error a wrap node appearing put there is corrected in position but earns
      // no velocity (see Rope.topologyCreditScale).
      //
      // And bounded the same way: the phase may not hand the ball more inward
      // speed than the constraint it enforces was opening at when the phase
      // began (see Rope.creditBound). Taken against `velocityBeforeChain`,
      // because that is what the ball carried in — by here the contact solve has
      // already answered for whatever the ball was doing before it, and a chain
      // charging the ball a second time for the same descent is what flicked a
      // landing ball off the floor at 3 m/s (`session-360f` f305). The winch
      // budget rides in as the allowance the path Jacobian cannot see: chain
      // wound onto the ball's own rim shortens the free path with nothing
      // moving, and hauling the ball in to pay for it is the mechanic.
      // The winch allowance is granted for winding that STAYED wound: the raw
      // budget, less what the unwind just gave back and what a pivot anchor's
      // bearing absorbed (`pivotSpinDebt` - length the solve paid by rotating
      // the anchor, kept after the rollback). Neither sink hauled the ball in,
      // so neither entitles it to credit. On an ordinary wind-up both are zero
      // and the allowance is exactly what it always was; wound tight the unwind
      // refuses the winding and the allowance dies with it, which is the same
      // statement the stall already makes in length. Against a whirled pivot
      // this is the half of the slingshot the rotation-credit bound cannot
      // reach: the aim's winding churned on and off the rim every cycle, never
      // accumulating, while its full raw budget re-fed the ball's orbit 4-7 m/s
      // of fresh credit per frame (the `whirl-anchor` case in `cli spring`).
      // The field keeps the effective value so `rope-solve-kick` measures
      // against the entitlement the clamp actually used.
      if (pivotAnchored) {
        this.chainWinchSpeedBudget = Math.max(
          0,
          this.chainWinchSpeedBudget - (unwindRemoved + pivotSpinDebt) / delta,
        );
      }
      const chainBound = this.ball.chain.creditBound(
        delta,
        new Map([[this.ball as PhysicsBody2D, velocityBeforeChain]]),
        this.chainWinchSpeedBudget,
      );
      this.chainCreditVelocity = this.ball.chain.clampCredit(
        this.ball,
        this.ball.globalPosition
          .sub(positionBeforeChain)
          .div(delta)
          .mul(this.ball.chain.topologyCreditScale),
        chainBound,
      );
      this.ball.linearVelocity = velocityBeforeChain.add(this.chainCreditVelocity);
      // The PBD velocity update taken over the whole chain phase — the single
      // largest source of one-frame ball velocity there is, and the one every
      // launch has come through.
      PhaseTrace.mark("chain-velocity", this.world);
      // A surface the frame had to push the ball out of is one the ball is
      // resting against, so the frame must not *end* with the chain driving it
      // through that surface. The push-out already undid the motion in position;
      // this is the same statement in velocity, and without it the frame ends
      // with a velocity the geometry has already refused.
      //
      // That refused velocity is not inert. Next frame's integrate kills it at
      // the contact and sizes the Coulomb friction budget from it — and the ball
      // is spinning under kinematic aim steering, so that budget is spent
      // *driving*. A ball held against a ceiling by a taut chain therefore
      // funded its own traction out of the constraint pulling it up there, drove
      // itself sideways at ~1.2 m/s per frame of Δv, and ratcheted the chain 2mm
      // longer each frame through `absorbBlockedLength` as the solve tried and
      // failed to haul it back — 11% chain growth in 30 frames, and a ball that
      // slides along the ceiling until it runs out of ceiling (session-537f).
      //
      // Cancelling it restores the rule the wall case already obeys: once
      // resting, a surface gravity does not press the ball into gives no
      // traction, so a spinning ball cannot climb a wall — or drive along a
      // ceiling. A constraint is not a force here, and it may not act like one.
      //
      // It is the CHAIN's share that may not act like one, though, and only
      // that: the ball arrives at this phase already pressing into whatever it
      // rests on, because integrate applied gravity and the contact solve does
      // not run again before the frame ends. Cancelling that share too is the
      // same statement about gravity, and gravity IS a force — it is what a
      // resting contact carries and what the Coulomb cone is sized from
      // (`maxImpulse = mu * Pn`). Taken outright, the frame ended with no
      // approach velocity left at all, so next frame's contact spent a normal
      // impulse of 0.4 where a chainless one on the same slope spends 8, the
      // friction cone collapsed with it, and a ball resting on a rigid platform
      // accelerated down a 15 degree slope at very nearly the full tangential
      // gravity for as long as the chain stayed anchored — 35 cm in 30 frames,
      // against a free ball that stops in 15 (`session-291f`).
      //
      // So the bound is gravity's own per-frame step, not zero — and no more
      // than the ball brought in with it, so a frame the contact solve has
      // already answered for hands back nothing. Gravity's step is the one part
      // of the entering approach that is provably not the chain's: the rest of
      // it may be momentum an earlier chain solve wrote, and refusing that stays
      // exactly as it was. A chain hauling the ball at a ceiling still gets
      // nothing either way, because gravity there points out of the surface and
      // both bounds are zero — which is what keeps the wall and ceiling cases
      // (`session-537f`) as they were.
      //
      // And measured against the SURFACE, not against the world. A static wall
      // stands still and the two read the same, but the surface here is as
      // often a rigid body - the anchor the ball is wound up to - and a body
      // has a velocity of its own along the normal it pushed the ball out
      // along. "Into" is the closing rate between the two, and a ball may keep
      // whatever keeps pace with a surface that is moving away from it: read
      // in world terms, a ball hauled after an anchor that had just been
      // knocked off at 4.8 m/s was stripped of the whole of its 4.2 m/s toward
      // it in one frame, every frame, while the solve went on dragging it after
      // the anchor in position - stopped dead in velocity, towed in position,
      // its momentum simply gone (`session-307f` f192-194).
      const gravityStep = GRAVITY.mul(this.ball.gravityScale * delta);
      const surfaceSpeed = (p: PushOut): number =>
        p.other instanceof RigidBody2D ? p.other.linearVelocity.dot(p.normal) : 0;
      //
      // And taken as the PAIR it is where the surface is a rigid body. The
      // refusal removes the closing rate between the ball and the surface, and
      // a closing rate belongs to two bodies: written onto the ball alone, a
      // body moving AT the ball hands it that speed and keeps its own, which is
      // an impulse with one end. A 12.6 kg hung weight the wound-up ball was
      // riding, pushed back into the ball by the pair separation at 1.3 m/s,
      // was answered by the ball being sped up 0.44 m/s a frame to keep clear
      // of it - 40 J over six frames, the aim idle, the ball's spin zero, on a
      // 52 kg body the weight could not have moved a quarter of that
      // (`session-239f` f93-98, `energy-gained` at f121). Split by the same
      // effective masses the pair separation splits its push by - the body's
      // rotation about the contact in the split, since the pushing edge is as
      // often a corner as a face - the weight is slowed by what the ball is sped
      // up, which is the one impulse seen from its two ends. A static surface
      // has no share and reads exactly as it always did, and so do a PIVOT and
      // a SPRING mount: their answer to a load is a bearing or a spring with a
      // governor of its own (`whirl-anchor`, `winch-load`), and an impulse
      // laid on the bearing here is the whirl's seed spin by another door.
      // So does a body the spin rollback has just restored: the closing rate
      // being refused there is the winch's kinematic credit, and handing the
      // holder a share of it every frame is `session-265f`'s anchor fed the
      // spin by another door again.
      for (const p of pushedOutOf) {
        const surface = surfaceSpeed(p);
        const into = this.ball.linearVelocity.dot(p.normal) - surface;
        const funded = Math.max(
          Math.min(velocityBeforeChain.dot(p.normal) - surface, 0),
          Math.min(gravityStep.dot(p.normal), 0),
        );
        if (into < funded) {
          const other = p.other;
          if (
            other instanceof RigidBody2D &&
            !other.asleep &&
            !other.pivot &&
            other.spring === null &&
            !rolledBack.has(other)
          ) {
            const arm = p.point.sub(other.globalPosition).cross(p.normal);
            const effectiveInverseMass =
              this.ball.inverseMass + other.inverseMass + arm * arm * other.inverseInertia;
            const impulse = (funded - into) / effectiveInverseMass;
            this.ball.linearVelocity = this.ball.linearVelocity.add(
              p.normal.mul(impulse * this.ball.inverseMass),
            );
            other.linearVelocity = other.linearVelocity.sub(p.normal.mul(impulse * other.inverseMass));
            other.angularVelocity -= arm * impulse * other.inverseInertia;
          } else {
            this.ball.linearVelocity = this.ball.linearVelocity.sub(p.normal.mul(into - funded));
          }
        }
      }
      // Cancelling the component the geometry has already refused (session-537f:
      // the ceiling drive). A delta here is traction the frame did NOT fund.
      PhaseTrace.mark("refuse-into-surface", this.world);
      // Whatever the solve could not reach is the winch stall: a point-blank
      // anchor is held over its length by the geometry the ball is resting on,
      // and re-basing lets the constraint settle there instead of winding up.
      //
      // On a pivot anchor, only where geometry actually refused something. The
      // lease's whole premise is a correction a SURFACE would not let through,
      // and this frame's push-out normals are the direct evidence of that. With
      // the ball whirled in free air nothing blocked anything - what stands
      // over-length there is the spin-rollback's re-broken share that the
      // unwind's window could not refund this frame, and leasing it mints real
      // chain out of the kinematic spin: the elbow whirl banked 1.7 m of lease
      // on a 1.63 m chain that way, and the doubled radius is most of what its
      // 37 m/s slingshot was made of. Left un-leased, next frame's solve
      // corrects it like any other length error. Every other anchor keeps the
      // unconditional raise it always had (see `pivotAnchored` above).
      //
      // The lease is measured against what those surfaces make UNREACHABLE, not
      // against where the solve left the path: a surface the chain pulls along
      // rather than into deflects the correction and refuses nothing, and the
      // residual its push-out leaves is next frame's ordinary length error (see
      // `Rope.absorbBlockedLength`; `session-483f` is the ball resting on a
      // slope, ratcheting 0.2 mm of lease a frame out of exactly that residual).
      const refused =
        !pivotAnchored || pushedOutOf.length > 0
          ? this.ball.chain.absorbBlockedLength([
              { body: this.ball, normals: pushedOutOf.map((p) => p.normal) },
            ])
          : 0;
      // Whether the geometry actually refused the chain this frame — the same
      // push-out normals the velocity above was cancelled against, and only
      // where they stand in the way of a shorter chain. Next frame's
      // `beginFrame` reads it to decide whether the lease may be handed back:
      // released into a live block, the constraint spends every frame hauling
      // the ball into a surface that is already saying no.
      // A static that pushed one of the chain's own path bodies is geometry in
      // the chain's way by the same token: the solve hauled the anchor into it
      // and it said no, and a lease released into that hauls it there again.
      this.ball.chain.noteBlockedByGeometry(
        (pushedOutOf.length > 0 && refused > 0) || pathBlocked,
      );
      // Length only, never velocity — a delta showing up here would mean the
      // stall lease had learnt to move something, which it must not.
      PhaseTrace.mark("stall-lease", this.world);
      this.chainStallFrames =
        this.ball.chain.stalledLength > BallLevel.STALL_EPSILON ? this.chainStallFrames + 1 : 0;
      this.chainLeaseHeldFrames =
        this.ball.chain.blockedSlack > BallLevel.LEASE_EPSILON &&
        !this.ball.chain.blockedByGeometry
          ? this.chainLeaseHeldFrames + 1
          : 0;
      // What the phase actually took out of the ball along the chain's pull,
      // against what the constraint was entitled to take. Measured here, at the
      // very end, so every term the phase wrote is in it - the credit, the spin
      // rollback, the unwind and the into-surface refusal - which is what makes
      // this a statement about the FRAME rather than a restatement of the clamp
      // one of those terms carries.
      const pull = this.ball.chain.pullDirection(this.ball);
      this.chainCreditOverBound =
        pull === null
          ? null
          : this.ball.linearVelocity.sub(velocityBeforeChain).dot(pull) - chainBound;
      // And what it handed the ball out of the surfaces it pushed it out of
      // (see the field): how much faster the ball is LEAVING each of them, along
      // its push-out normal and relative to the surface's own motion, than it
      // was when the phase began. A refusal reads zero here - it removes speed
      // into the surface, and a ball that arrived moving into one leaves at
      // rest against it - so this is the credit alone.
      let pushOutCredit = 0;
      for (const p of pushedOutOf) {
        const surface = surfaceSpeed(p);
        const leaving = Math.max(this.ball.linearVelocity.dot(p.normal) - surface, 0);
        const arrived = Math.max(velocityBeforeChain.dot(p.normal) - surface, 0);
        pushOutCredit = Math.max(pushOutCredit, leaving - arrived);
      }
      this.chainPushOutCredit = pushOutCredit;
      this.chainPushCreditFrames =
        pushOutCredit > BallLevel.PUSH_CREDIT_SPEED ? this.chainPushCreditFrames + 1 : 0;
      const gain = this.ball.linearVelocity.length() - speedBefore;
      this.anchorKickSpeedGain = anchoredThisFrame ? gain : null;
      this.chainSolveSpeedGain = gain;
      // The steered grip takes the whole of what this phase did to the ball as
      // its own, so next frame's pin does not undo the haul (see
      // `RigidBody2D.carryStickAnchor`). After every term above, because every
      // one of them moved the ball or its velocity and the pin measures against
      // the frame's end. Relative to the surface, which this phase may have
      // moved as well, and only while the grip still names that surface.
      if (gripSurface !== null && gripLocalBefore !== null && this.ball.stickBody === gripSurface) {
        const gripLocalAfter = this.ball.stickLocalOf(this.ball.globalPosition)!;
        const surfaceVelocityAfter = gripSurface.velocityAtPoint(this.ball.globalPosition);
        this.ball.carryStickAnchor(
          gripLocalAfter.sub(gripLocalBefore),
          this.ball.linearVelocity
            .sub(velocityBeforeChain)
            .sub(surfaceVelocityAfter.sub(gripSurfaceVelocityBefore)),
        );
      }
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

    // Last: everything that could move a body this frame has. The bodies
    // decide first and the chains follow them (see `SceneChain.asleep`).
    this.world.settleSleep();
    sleepChains(this.sceneChains);

    // ...and then what the frame's contacts destroyed (see `level/breakable.ts`).
    // After every phase, because a body taken out of the world mid-frame is one
    // taken out from under whatever was holding a reference to it - the chain
    // phase, the drape, the sleep pass. The contacts this reads are the frame's
    // own and nothing above touches them, so waiting costs the measurement
    // nothing and costs the reader one frame of scenery that was already broken.
    this.breakBodies(delta);

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

  private separateBallFromPathBodies(delta: number): PushOut[] {
    const out: PushOut[] = [];
    const chain = this.ball.chain;
    if (!chain) return out;
    const partners: RigidBody2D[] = [];
    for (const node of chain.path()) {
      const obj = node.contact.obj;
      // Not the chain's own dangling hook: until it lands it is the chain's far
      // end, not a body the ball is resting against, and a quarter-kilo body
      // "separated" from the ball by effective mass is a hook flung clear of the
      // floor it was about to anchor on (`attach-keeps-length` went red on it).
      if (obj instanceof BallHook) continue;
      if (obj instanceof RigidBody2D && obj !== this.ball && obj.isSolid && !partners.includes(obj)) {
        partners.push(obj);
      }
    }
    const ballShapes = this.ball.getShapes();
    for (const body of partners) {
      for (let pass = 0; pass < BallLevel.PAIR_SEPARATION_PASSES; pass++) {
        let deepest: { normal: Vec2; depth: number; point: Vec2 } | null = null;
        for (const ballShape of ballShapes) {
          if (ballShape.shape.kind !== "circle") continue;
          const centre = ballShape.globalPosition;
          const radius = ballShape.shape.radius;
          for (const shape of body.getShapes()) {
            // Only the pieces the ball is actually stopped by. The partner is
            // picked by BODY - whatever the chain's path touches - and a body
            // is not one answer: the stool the chain is anchored to by its seat
            // has legs the ball passes between, and separating it from those
            // put back exactly the block the mask had taken out. Being pushed
            // out of a piece IS being blocked by it, which is the rule the
            // engine's own recovery passes are written to (`shapesCollide`),
            // and this is the one recovery outside the engine.
            if (!shapesCollide(ballShape, shape)) continue;
            const overlap = circleOverlap(centre, radius, shape);
            if (
              overlap &&
              overlap.depth > BallLevel.PUSH_OUT_MIN_DEPTH &&
              (deepest === null || overlap.depth > deepest.depth)
            ) {
              // Where the ball's circle meets the body's surface: the circle's
              // deepest point, brought back out by the depth.
              deepest = {
                normal: overlap.normal,
                depth: overlap.depth,
                point: centre.sub(overlap.normal.mul(radius - overlap.depth)),
              };
            }
          }
        }
        if (deepest === null) break;
        // Out of the body, toward the ball - `circleOverlap`'s orientation, and
        // the one every `PushOut` carries.
        const normal = deepest.normal;
        const arm = deepest.point.sub(body.globalPosition).cross(normal);
        const effectiveInverseMass =
          this.ball.inverseMass + body.inverseMass + arm * arm * body.inverseInertia;
        if (effectiveInverseMass <= 0) break;
        const correction = deepest.depth / effectiveInverseMass;
        const ballMove = normal.mul(correction * this.ball.inverseMass);
        const bodyMove = normal.mul(-correction * body.inverseMass);
        const bodyTurn = -arm * correction * body.inverseInertia;
        this.ball.globalPosition = this.ball.globalPosition.add(ballMove);
        body.globalPosition = body.globalPosition.add(bodyMove);
        body.globalRotation += bodyTurn;
        body.linearVelocity = body.linearVelocity.add(bodyMove.div(delta));
        body.angularVelocity += bodyTurn / delta;
        chain.noteGeometryPush(ballMove.length());
        out.push({ normal, depth: deepest.depth, other: body, point: deepest.point });
      }
    }
    return out;
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
