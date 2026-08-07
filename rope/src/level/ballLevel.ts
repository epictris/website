// BallLevel — level driver for the ball & chain controller. Deliberately a
// separate class from Level: the two controllers share nothing beyond the
// arena data, and keeping the Player frame flow untouched preserves its
// recorded replays bit-for-bit.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { Debug } from "../engine/debug";
import { PhaseTrace } from "../engine/phaseTrace";
import { PhysTrace } from "../engine/physTrace";
import { GRAVITY, World } from "../engine/world";
import { BallPlayer } from "../classes/ballPlayer";
import { BallHook } from "../classes/ballHook";
import type { FrameInput } from "../input/frameInput";
import {
  scaleLevelData,
  type CameraRegionData,
  type LevelData,
  type RawLevelData,
} from "./levelFormat";
import { buildLevelBodies, type LevelVisualSource } from "./buildBodies";
import { collectDecor, type SceneDecor } from "./decor";
import {
  buildSceneChains,
  settleChainBodies,
  snapshotChainBodies,
  stepSceneChains,
  sweepChains,
  type SceneChain,
} from "./chains";
import { PX } from "../engine/units";
import { Mathf } from "../engine/mathf";

export class BallLevel {
  readonly world = new World();
  readonly ball: BallPlayer;
  // All PhysicsBody2D the chain may wrap (ball + statics + hook).
  bodies: PhysicsBody2D[] = [];
  frame = 0;
  cameraPosition = Vec2.ZERO;
  // Camera-behaviour volumes, in metres (see Level.cameraRegions).
  readonly cameraRegions: CameraRegionData[];
  // The authored shapes that are drawn and never simulated (see Level.decor).
  readonly decor: SceneDecor[];
  // Chains strung between authored bodies (see Level.sceneChains).
  readonly sceneChains: SceneChain[];
  // Render-only: the metre-scaled level as built, and the engine object each
  // authored entry became. It is what lets the 3D renderer hand an authored
  // `visual` to the exact piece of the exact body it decorates (see
  // `render3d/scene.ts`); the sim never reads it, and neither does the 2D
  // renderer, which draws bodies and knows nothing about the file they came from.
  readonly visualSource: LevelVisualSource;
  onReset: (() => void) | null = null;

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
  private endWasFixed = false;

  // Length below which a stall is float noise rather than a blocked correction.
  static readonly STALL_EPSILON = 0.001;
  // Lease below which there is nothing worth calling a surplus: the release
  // hands back 8 mm a frame, so anything under a couple of centimetres is on its
  // way out already.
  static readonly LEASE_EPSILON = 0.02;

  // The ball plays 1.5× the arena's authored avatar radius — a heftier ball
  // & chain than the grapple avatar, without hand-editing generated levelData.
  static readonly BALL_RADIUS_SCALE = 1.5;

  constructor(rawData: RawLevelData) {
    const data = scaleLevelData(rawData, PX);
    this.cameraRegions = data.cameraRegions ?? [];
    this.ball = new BallPlayer(data.player.radius * BallLevel.BALL_RADIUS_SCALE);
    this.ball.globalPosition = new Vec2(data.player.x, data.player.y);
    this.ball.spawnBody = (b) => this.spawnBody(b);
    this.world.add(this.ball);
    this.bodies.push(this.ball);

    const built = buildLevelBodies(this.world, data, () => this.onReset?.());
    this.bodies.push(...built.wrapBodies);
    this.sceneChains = buildSceneChains(data, built);
    this.decor = collectDecor(built);
    this.visualSource = { data, built };

    this.cameraPosition = this.ball.globalPosition;
  }

  private spawnBody(body: PhysicsBody2D): void {
    this.world.add(body);
    this.bodies.push(body);
  }

  // Camera target for a render frame: the ball's interpolated position, so the
  // camera tracks exactly what is drawn. Following the raw 60 Hz position while
  // the ball renders interpolated would put the jitter back, on screen.
  cameraRenderPosition(alpha: number): Vec2 {
    return this.ball.renderPosition(alpha);
  }

  physicsProcess(input: FrameInput, delta: number): void {
    this.frame++;
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

    // Where the ball was facing before anything this frame turned it — the floor
    // the chain's unwind correction may walk its rotation back to, and no
    // further (see Rope.unwindOverLength).
    const ballRotationAtFrameStart = this.ball.globalRotation;

    this.ball.resolveInput(input);
    // The aim steering overwrites the ball's angular velocity outright, so it is
    // a phase in its own right - a spin that appears here is the player's, and
    // one that appears in `unwind` is the chain refusing it.
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

    const ballVelocityBeforeContacts = this.ball.linearVelocity;
    this.world.integrate(delta);

    // Driving the mounting loop into a surface may never launch the ball. It is
    // written here, after the contacts and the depenetration sweep, because it
    // REPLACES what the solve made of the loop's landing — a phase-dependent
    // launch the player cannot aim (session-1594f).
    this.ball.applyLoopCap(this.world.frameContacts, ballVelocityBeforeContacts);
    PhaseTrace.mark("loop-cap", this.world);

    // Scene chains solve straight after integration, before the ball's own chain
    // phase opens: whatever they move is then part of the state that phase
    // measures itself against, rather than a body shifting under its books. A
    // level with no chains does nothing here, so recorded replays are unchanged.
    stepSceneChains(this.sceneChains, this.world, delta);
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
    this.world.depenetrateRigid(this.ball);
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
    // The chain end is "fixed" once it anchors to a surface — before that it is
    // the (in-flight or dangling) BallHook. Catch the false→true transition so
    // the invariant only scrutinises the frame the anchor goes rigid.
    const endFixed =
      this.ball.chain !== null && !(this.ball.chain.end.contact.obj instanceof BallHook);
    const anchoredThisFrame = endFixed && !this.endWasFixed;
    if (this.ball.chainAnchored && this.ball.chain) {
      const speedBefore = this.ball.linearVelocity.length();
      const positionBeforeChain = this.ball.globalPosition;
      const velocityBeforeChain = this.ball.linearVelocity;

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
      const sceneBefore =
        this.sceneChains.length > 0 ? snapshotChainBodies(this.sceneChains, this.ball) : [];
      this.ball.chain.beginFrame(delta);
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
      const haulAtSolve = new Map<
        RigidBody2D,
        { position: Vec2; velocity: Vec2; rotation: number; spin: number }
      >();
      if (spinShare > 0) {
        for (const body of this.bodies) {
          if (body instanceof RigidBody2D && body !== this.ball) {
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
      if (this.sceneChains.length > 0) {
        sweepChains(this.sceneChains, { rope: this.ball.chain, bodies: this.bodies }, delta);
      }
      PhaseTrace.mark("rope-solve", this.world);
      for (const [body, before] of haulAtSolve) {
        body.globalPosition = body.globalPosition.sub(
          body.globalPosition.sub(before.position).mul(spinShare),
        );
        body.linearVelocity = body.linearVelocity.sub(
          body.linearVelocity.sub(before.velocity).mul(spinShare),
        );
        body.globalRotation -= (body.globalRotation - before.rotation) * spinShare;
        body.angularVelocity -= (body.angularVelocity - before.spin) * spinShare;
      }
      // What the spin's share of the solve took back off everything but the ball
      // (session-265f). Zero on a frame with no aim spin.
      PhaseTrace.mark("spin-rollback", this.world);
      // Settled after the rollback and not before it, so the displacement the
      // credit is taken over is the one the phase actually ends on - a rollback
      // run afterwards would undo part of the move while the credit for it
      // stayed, which is the whole failure this exists to prevent.
      if (sceneBefore.length > 0) {
        settleChainBodies(this.sceneChains, sceneBefore, this.world, delta);
      }
      // Position for the scene's chain-held bodies, and the velocity they are
      // owed for it - the ball's own share of this phase is `chain-velocity`.
      PhaseTrace.mark("chain-settle", this.world);
      // A rope correction is still free to shove the ball into something on its
      // way; push out again so the frame does not *end* inside the scenery, and
      // then set the chain phase's velocity contribution to the displacement it
      // actually produced, both push-outs included. This is the PBD velocity
      // update the rope does for itself (Δposition over Δt), just taken over
      // where the frame really ends — so the ball can never bank speed for a
      // move that was undone, and there is nothing left to refund.
      const pushedOutOf = this.world.depenetrateRigid(this.ball);
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
      if (endFixed) {
        this.ball.chain.unwindOverLength(this.ball, ballRotationAtFrameStart, delta);
      }
      PhaseTrace.mark("unwind", this.world);
      // The unwind just turned the ball, and the ball is not only a circle — it
      // carries its mounting loop out on the rim, so a rotation can swing that
      // into geometry the push-out had already cleared. Clear it again; the
      // velocity below is derived after both, so neither costs anything.
      pushedOutOf.push(...this.world.depenetrateRigid(this.ball));
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
      const gravityStep = GRAVITY.mul(this.ball.gravityScale * delta);
      for (const normal of pushedOutOf) {
        const into = this.ball.linearVelocity.dot(normal);
        const funded = Math.max(
          Math.min(velocityBeforeChain.dot(normal), 0),
          Math.min(gravityStep.dot(normal), 0),
        );
        if (into < funded) {
          this.ball.linearVelocity = this.ball.linearVelocity.sub(normal.mul(into - funded));
        }
      }
      // Cancelling the component the geometry has already refused (session-537f:
      // the ceiling drive). A delta here is traction the frame did NOT fund.
      PhaseTrace.mark("refuse-into-surface", this.world);
      // Whatever the solve could not reach is the winch stall: a point-blank
      // anchor is held over its length by the geometry the ball is resting on,
      // and re-basing lets the constraint settle there instead of winding up.
      this.ball.chain.absorbBlockedLength();
      // Whether the geometry actually refused the chain this frame — the same
      // push-out normals the velocity above was cancelled against. Next frame's
      // `beginFrame` reads it to decide whether the lease may be handed back:
      // released into a live block, the constraint spends every frame hauling
      // the ball into a surface that is already saying no.
      this.ball.chain.noteBlockedByGeometry(pushedOutOf.length > 0);
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
      const gain = this.ball.linearVelocity.length() - speedBefore;
      this.anchorKickSpeedGain = anchoredThisFrame ? gain : null;
      this.chainSolveSpeedGain = gain;
    } else {
      this.anchorKickSpeedGain = null;
      this.chainSolveSpeedGain = null;
      this.chainAnchorLength = null;
      this.chainCreditVelocity = Vec2.ZERO;
      this.chainStallFrames = 0;
      this.chainLeaseHeldFrames = 0;
      this.chainWinchSpeedBudget = 0;
      this.chainCreditOverBound = null;
    }
    this.endWasFixed = endFixed;

    this.cameraPosition = this.ball.globalPosition;
  }
}
