// BallLevel — level driver for the ball & chain controller. Deliberately a
// separate class from Level: the two controllers share nothing beyond the
// arena data, and keeping the Player frame flow untouched preserves its
// recorded replays bit-for-bit.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { Debug } from "../engine/debug";
import { PhysTrace } from "../engine/physTrace";
import { World } from "../engine/world";
import { BallPlayer } from "../classes/ballPlayer";
import { BallHook } from "../classes/ballHook";
import type { FrameInput } from "../input/frameInput";
import {
  scaleLevelData,
  type BackgroundData,
  type CameraRegionData,
  type LevelData,
} from "./levelFormat";
import { buildLevelBodies } from "./buildBodies";
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
  // Decoration drawn behind the level, in metres (see Level.backgrounds).
  readonly backgrounds: BackgroundData[];
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
  private endWasFixed = false;

  // Length below which a stall is float noise rather than a blocked correction.
  static readonly STALL_EPSILON = 0.001;

  // The ball plays 1.5× the arena's authored avatar radius — a heftier ball
  // & chain than the grapple avatar, without hand-editing generated levelData.
  static readonly BALL_RADIUS_SCALE = 1.5;

  constructor(rawData: LevelData) {
    const data = scaleLevelData(rawData, PX);
    this.cameraRegions = data.cameraRegions ?? [];
    this.backgrounds = data.backgrounds ?? [];
    this.ball = new BallPlayer(data.player.radius * BallLevel.BALL_RADIUS_SCALE);
    this.ball.globalPosition = new Vec2(data.player.x, data.player.y);
    this.ball.spawnBody = (b) => this.spawnBody(b);
    this.world.add(this.ball);
    this.bodies.push(this.ball);

    this.bodies.push(...buildLevelBodies(this.world, data, () => this.onReset?.()));

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
    this.bodies = this.bodies.filter((b) => !b.removed);
    // The hook's attach callback (fired inside the step below) needs the scene
    // to regenerate the chain's wrap path; hand it this frame's bodies.
    this.ball.sceneBodies = this.bodies;

    // Armed hooks run their swept attach check before integration moves them.
    for (const b of this.bodies) {
      if (b instanceof BallHook) b.physicsStep(delta);
    }
    this.bodies = this.bodies.filter((b) => !b.removed);

    this.world.integrate(delta);

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
      if (anchoredThisFrame) this.chainAnchorLength = this.ball.chain.maxRopeLength;
      const speedBefore = this.ball.linearVelocity.length();
      const positionBeforeChain = this.ball.globalPosition;
      const velocityBeforeChain = this.ball.linearVelocity;

      // How much of the over-length the solve is about to see is the ball's own
      // kinematic aim spin, which `unwindOverLength` will refuse below. The rest
      // is real motion — gravity, momentum, a swing going taut — and is the
      // solve's proper business.
      this.ball.chain.beginFrame();
      this.ball.chain.syncWraps(this.bodies);
      const overLengthBeforeSolve =
        this.ball.chain.getCurrentLength() - this.ball.chain.constraintLength;
      const spinLength =
        Math.abs(this.ball.globalRotation - ballRotationAtFrameStart) *
        Math.abs(this.ball.chain.lengthPerRadian(this.ball));
      const spinShare =
        overLengthBeforeSolve > 0
          ? Mathf.clamp(spinLength / overLengthBeforeSolve, 0, 1)
          : 0;
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
      // (session-394f).
      this.ball.chain.unwindOverLength(this.ball, ballRotationAtFrameStart, delta);
      // The unwind just turned the ball, and the ball is not only a circle — it
      // carries its mounting loop out on the rim, so a rotation can swing that
      // into geometry the push-out had already cleared. Clear it again; the
      // velocity below is derived after both, so neither costs anything.
      pushedOutOf.push(...this.world.depenetrateRigid(this.ball));
      // Discounted the same way the solve discounts its own credit: a length
      // error a wrap node appearing put there is corrected in position but earns
      // no velocity (see Rope.topologyCreditScale).
      this.ball.linearVelocity = velocityBeforeChain.add(
        this.ball.globalPosition
          .sub(positionBeforeChain)
          .div(delta)
          .mul(this.ball.chain.topologyCreditScale),
      );
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
      for (const normal of pushedOutOf) {
        const into = this.ball.linearVelocity.dot(normal);
        if (into < 0) this.ball.linearVelocity = this.ball.linearVelocity.sub(normal.mul(into));
      }
      // Whatever the solve could not reach is the winch stall: a point-blank
      // anchor is held over its length by the geometry the ball is resting on,
      // and re-basing lets the constraint settle there instead of winding up.
      this.ball.chain.absorbBlockedLength(delta);
      this.chainStallFrames =
        this.ball.chain.stalledLength > BallLevel.STALL_EPSILON ? this.chainStallFrames + 1 : 0;
      const gain = this.ball.linearVelocity.length() - speedBefore;
      this.anchorKickSpeedGain = anchoredThisFrame ? gain : null;
      this.chainSolveSpeedGain = gain;
    } else {
      this.anchorKickSpeedGain = null;
      this.chainSolveSpeedGain = null;
      this.chainAnchorLength = null;
      this.chainStallFrames = 0;
    }
    this.endWasFixed = endFixed;

    this.cameraPosition = this.ball.globalPosition;
  }
}
