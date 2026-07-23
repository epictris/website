// LedgeHangState, ported from classes/PlayerStates/LedgeHangState.cs, then
// rebuilt on LedgeDetection (game-design.md): the hang stores only the grabbed
// body + vertex index and re-derives the corner's world position and face
// normals every frame. Statics and movers share one code path — a mover's
// corner is tracked implicitly, and a corner that rotates out of grabbability
// releases the player with the surface's contact-point velocity.
//
// The catch is momentum-aware: instead of teleporting to the hang point and
// zeroing velocity, the player settles onto it over a few frames (collision-
// checked), absorbing the entry momentum. A settle blocked by geometry times
// out into a release rather than pinning the player.

import { Vec2 } from "../../engine/vec2";
import { Mathf } from "../../engine/mathf";
import { circleOverlap } from "../../engine/collision";
import type { PhysicsBody2D } from "../../engine/body";
import { GRAB_REACH_MARGIN, LedgeDetection, type LedgeGrabInfo } from "../../lib/ledgeDetection";
import type { Player } from "../player";
import { Player as PlayerClass } from "../player";
import { PlayerState } from "./playerState";
import { AirborneState } from "./airborneState";
import { LedgeClimbState } from "./ledgeClimbState";
import { WallJumpingState } from "./wallJumpingState";

// Catch easing toward the rest pose: fraction of the remaining offset per
// frame, with a floor so the tail converges; SETTLE_EPSILON ends the settle.
const SETTLE_RATE = 0.2;
const SETTLE_MIN_STEP = 1;
const SETTLE_EPSILON = 0.5;
// Grip friction: down-the-wall momentum kept per catch frame (an early
// release keeps the remainder).
const CATCH_DAMPING = 0.75;
// A catch always finishes in bounded time (the pose is set directly, nothing
// can block it) — the timeout is a pure backstop (input-frozen rule).
const SETTLE_TIMEOUT_FRAMES = 45;

export class LedgeHangState extends PlayerState {
  readonly body: PhysicsBody2D;
  readonly vertexIndex: number;
  private info: LedgeGrabInfo | null = null;
  private settled = false;
  private settleFrames = 0;

  constructor(body: PhysicsBody2D, vertexIndex: number) {
    super();
    this.body = body;
    this.vertexIndex = vertexIndex;
  }

  update(player: Player, _delta: number): PlayerState {
    if (this.body.removed) return new AirborneState();

    // Reachability re-verification (game-design.md): the corner must still
    // have a floor top face and a wall hang face this frame.
    this.info = LedgeDetection.grabInfo(this.body, this.vertexIndex);
    if (!this.info) return this.release(player);
    const wallNormal = this.info.wallNormal;

    // Ledge jump: buffered like every other jump; launches up-and-away off
    // the hang face using the wall-jump vector.
    const jumpFrames = player.inputs.jump.framesSinceActivation;
    if (jumpFrames !== null && jumpFrames <= PlayerClass.JUMP_BUFFER_FRAMES) {
      player.inputs.jump.deactivate();
      player.velocity = this.releaseVelocity(player);
      return new WallJumpingState(wallNormal);
    }

    // A taut rope drags the body positionally; hanging can't stay pinned against it.
    if (player.rope?.isTaut === true) return this.release(player);
    // The catch finishes before a climb can start: entry momentum rides down
    // the wall as far as it carries (resolveCollision), only then does
    // toward-input climb — a fast grab must not flick straight into a climb.
    if (this.settled && player.xInputDirection * wallNormal.x < 0) {
      return new LedgeClimbState(this.body, this.vertexIndex);
    }
    if (player.xInputDirection * wallNormal.x > 0) {
      return this.release(player);
    }
    return this;
  }

  resolveCollision(player: Player, delta: number): PlayerState {
    if (!this.info) return this; // update() already scheduled a transition

    const radius = player.radius;
    const along = LedgeDetection.hangDirection(this.info);
    // Hang line: against the wall face, parameterised by depth below the corner.
    const lateralArm = radius + 1;
    const face = this.info.vertex.add(this.info.wallNormal.mul(lateralArm));
    // Rest pose: the player's centre sits exactly on the edge of the grab
    // radius — identical for every kind of catch (fall grab and run-off).
    const restDepth = LedgeDetection.hangRestDepth(radius);

    // The hang is a lock to the grabbed body: the pose is derived from the
    // corner's current transform and set directly, so a mover carries the
    // player exactly and imparts no forces (no collision response creep).
    if (this.settled) {
      player.globalPosition = face.add(along.mul(restDepth));
      player.velocity = Vec2.ZERO;
      return this;
    }

    // The catch: hands hold the corner while the body swings down the hang
    // face — entry momentum plus easing, decaying under grip friction — until
    // it reaches the rest pose. All in corner-local terms and applied as a
    // direct pose, with a single overlap pushout against the grabbed body so
    // the swing can't cut through the lip.
    const rel = player.globalPosition.sub(face);
    const depth = rel.dot(along);
    const momentum = Mathf.max(0, player.velocity.dot(along));

    const gap = restDepth - depth;
    let newDepth: number;
    if (gap >= 0) {
      const step = momentum * delta + Mathf.max(SETTLE_MIN_STEP, gap * SETTLE_RATE);
      newDepth = depth + Mathf.min(gap, step);
    } else {
      newDepth = depth - Mathf.min(-gap, Mathf.max(SETTLE_MIN_STEP, -gap * SETTLE_RATE));
    }

    const lateralVec = rel.sub(along.mul(depth));
    const lateralDist = lateralVec.length();
    const newLateralDist = Mathf.max(
      0,
      lateralDist - Mathf.max(SETTLE_MIN_STEP, lateralDist * SETTLE_RATE),
    );
    const newLateral = lateralDist > 0 ? lateralVec.mul(newLateralDist / lateralDist) : Vec2.ZERO;

    let position = face.add(along.mul(newDepth)).add(newLateral);
    if (this.body.hasShape()) {
      const overlap = circleOverlap(position, radius, this.body.getShape());
      if (overlap) position = position.add(overlap.normal.mul(overlap.depth));
    }
    player.globalPosition = position;
    // Only the down-the-wall momentum survives the catch, decayed by grip.
    player.velocity = along.mul(momentum * CATCH_DAMPING);

    if (Mathf.abs(restDepth - newDepth) <= SETTLE_EPSILON && newLateralDist <= SETTLE_EPSILON) {
      this.settled = true;
      player.velocity = Vec2.ZERO;
      return this;
    }

    this.settleFrames++;
    if (this.settleFrames > SETTLE_TIMEOUT_FRAMES) {
      player.velocity = this.releaseVelocity(player);
      return new AirborneState();
    }
    return this;
  }

  // Separation keeps the surface's contact-point velocity (game-design.md).
  private releaseVelocity(player: Player): Vec2 {
    if (this.body.isMobile && !this.body.removed) {
      return this.body.velocityAtPoint(player.globalPosition);
    }
    return this.settled ? Vec2.ZERO : player.velocity;
  }

  private release(player: Player): AirborneState {
    player.velocity = this.releaseVelocity(player);
    return new AirborneState();
  }
}
