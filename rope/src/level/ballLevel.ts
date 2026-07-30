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
      // How much of the over-length the solve is about to see is the ball's own
      // kinematic aim spin, which `unwindOverLength` will refuse below. The rest
      // is real motion — gravity, momentum, a swing going taut — and is the
      // solve's proper business.
      this.ball.chain.syncWraps(this.bodies);
      const overLengthBeforeSolve =
        this.ball.chain.getCurrentLength() - this.ball.chain.maxRopeLength;
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
      const haulAtSolve = new Map<RigidBody2D, { position: Vec2; velocity: Vec2; rotation: number; spin: number }>();
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
      const positionBeforeSolve = this.ball.globalPosition;
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
      // The solve just wrote a positional correction straight onto the ball
      // (Rope sweeps only for the grapple avatar) and it runs after
      // World.integrate, so this is the frame's last chance to keep the ball
      // out of the scenery. Without it a short anchor on the far side of a
      // surface — a point-blank shot into the block you are resting against —
      // hauls the ball a little deeper every frame until it is buried in the
      // geometry (session-1048f: 5 cm in, for 49 frames).
      const positionAfterSolve = this.ball.globalPosition;
      this.world.depenetrateRigid(this.ball);
      // The solve pays itself velocity for the correction it wrote (Δposition
      // over Δt, inside Rope.physicsStep) — but it books that before the
      // push-out, so a correction the push-out immediately takes back leaves the
      // ball holding speed for a move it never made. Hand that part back. A ball
      // wound up against its anchor is exactly this case every frame: the solve
      // hauls it towards the anchor, the surface it is resting on refuses, and
      // un-refunded the credit accumulated until the ball was crawling sideways
      // along the floor under its own chain, over-length by a fresh centimetre a
      // frame for the winch stall to cover (session-394f).
      //
      // Only the credit *along the push-out* goes back, and only the part of it
      // that pointed into the surface. The push-out is a contact normal: it
      // cancels the correction's normal component and nothing else, so the
      // tangential credit is real and stays. Refunding a share of the whole
      // correction vector instead — the obvious reading of "30% of it was undone"
      // — pays back sideways velocity that was never undone, and a ball that
      // reaches its ceiling still carrying speed along it gets that sideways
      // kick re-applied every frame and rolls away under its own chain
      // (session-458f).
      const correction = positionAfterSolve.sub(positionBeforeSolve);
      const pushOut = this.ball.globalPosition.sub(positionAfterSolve);
      if (pushOut.lengthSquared() > 0) {
        const outward = pushOut.normalized();
        const intoSurface = Mathf.min(correction.dot(outward), 0);
        this.ball.linearVelocity = this.ball.linearVelocity.sub(
          outward.mul(intoSurface / delta),
        );
      }
      // Whatever length the frame still owes after that, take it out of the
      // ball's spin before anything else sees it. Winding chain onto the ball is
      // meant to work, and while the solve can pay for it by hauling the ball
      // towards the anchor it does; this is only the end of that, wound all the
      // way up with nowhere left to be hauled, where the spin has to give the
      // last radian back instead (session-475f). Never more than the frame's own
      // turn, so a wound-up ball stalls rather than unwinding itself
      // (session-394f).
      this.ball.chain.unwindOverLength(this.ball, ballRotationAtFrameStart, delta);
      // The push-out just moved the ball after the chain had solved, so the
      // frame can end over-length through geometry the solver could not fight.
      // That is the winch stall, and it has to be absorbed here rather than
      // inside the solve: a point-blank anchor otherwise leaves the chain
      // permanently over its length, every frame, for as long as the ball is
      // held off the surface it is anchored to.
      this.ball.chain.absorbBlockedLength();
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
