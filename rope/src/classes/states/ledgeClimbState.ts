// LedgeClimbState, ported from classes/PlayerStates/LedgeClimbState.cs, then
// rebuilt on LedgeDetection (game-design.md): the climb stores the grabbed
// body + vertex index and re-derives the corner and its face normals every
// frame, so the target follows a moving ledge and a corner that rotates out
// of grabbability releases the player mid-climb.
//
// The climb runs in two phases: straight up along the hang face until the
// player's body clears the lip, then laterally onto the top face. The old
// single straight-line path dragged the player into the corner and could
// wedge in notches; the timeout is now a true dead-man switch.

import { Vec2 } from "../../engine/vec2";
import type { PhysicsBody2D } from "../../engine/body";
import { LedgeDetection } from "../../lib/ledgeDetection";
import { Surface } from "../../lib/surface";
import { SurfaceType } from "../../lib/types";
import type { Player } from "../player";
import { Player as PlayerClass } from "../player";
import { PlayerState } from "./playerState";
import { AirborneState } from "./airborneState";
import { GroundedState } from "./groundedState";
import { WallJumpingState } from "./wallJumpingState";

// A climb normally completes in under a second. If the target is unreachable
// the climb would otherwise push forever with input locked out — bail to
// airborne instead. Must stay under the climb-stall invariant (90 frames,
// src/sim/trace.ts).
const CLIMB_TIMEOUT_FRAMES = 80;
const CLIMB_SPEED = 1.5; // px per frame-step, scaled by 1/delta

export class LedgeClimbState extends PlayerState {
  readonly body: PhysicsBody2D;
  readonly vertexIndex: number;
  private surfaceNormal: Vec2 = Vec2.ZERO;
  private supportBody: PhysicsBody2D | null = null;
  private frames = 0;

  constructor(body: PhysicsBody2D, vertexIndex: number) {
    super();
    this.body = body;
    this.vertexIndex = vertexIndex;
    this.supportBody = body;
  }

  update(player: Player, _delta: number): PlayerState {
    if (this.body.removed) return this.release(player);
    const info = LedgeDetection.grabInfo(this.body, this.vertexIndex);
    if (!info) return this.release(player); // corner rotated out mid-climb

    // Ledge jump mid-climb (mirrors LedgeHangState): buffered jump launches
    // up-and-away off the hang face using the wall-jump vector.
    const jumpFrames = player.inputs.jump.framesSinceActivation;
    if (jumpFrames !== null && jumpFrames <= PlayerClass.JUMP_BUFFER_FRAMES) {
      player.inputs.jump.deactivate();
      this.release(player); // sets the separation velocity
      return new WallJumpingState(info.wallNormal);
    }

    // Input away from the wall cancels the climb (mirrors LedgeHangState);
    // the timeout is the backstop for unreachable targets.
    if (player.xInputDirection * info.wallNormal.x > 0) return this.release(player);
    this.frames++;
    if (this.frames > CLIMB_TIMEOUT_FRAMES) return this.release(player);
    return this;
  }

  // Separation keeps the surface's contact-point velocity (game-design.md).
  private release(player: Player): AirborneState {
    if (this.body.isMobile && !this.body.removed) {
      player.velocity = this.body.velocityAtPoint(player.globalPosition);
    } else {
      player.velocity = Vec2.ZERO;
    }
    return new AirborneState();
  }

  resolveCollision(player: Player, delta: number): PlayerState {
    const info = LedgeDetection.grabInfo(this.body, this.vertexIndex);
    if (!info) return this; // update() already scheduled the release

    const shape = player.getShape().shape;
    const radius = shape.kind === "circle" ? shape.radius : 0;
    const target = LedgeDetection.climbTarget(info, radius);

    // Phase 1: rise along the hang face until the body clears the lip.
    // Phase 2: move laterally onto the top face.
    const cleared = (): boolean =>
      player.globalPosition.sub(info.vertex).dot(info.floorNormal) >= radius + 1;
    const direction = cleared()
      ? player.globalPosition.directionTo(target)
      : LedgeDetection.hangDirection(info).neg();
    player.velocity = direction.mul(CLIMB_SPEED / delta);

    // One frame's motion, sliding along obstructions — the loop iterates on
    // the collision remainder only (re-applying the full motion each pass
    // quadrupled the climb speed and made it snap).
    let motion = player.velocity.mul(delta);
    for (let i = 0; i < 4; i++) {
      const collision = player.moveAndCollide(motion);
      if (!collision) break;
      const normal = collision.getNormal();
      player.velocity = player.velocity.slide(normal);
      this.surfaceNormal = normal;
      this.supportBody = collision.getCollider() as PhysicsBody2D;
      motion = collision.getRemainder().slide(normal);
    }

    // Directed snap probe (post-move): into the hang face while rising, down
    // onto the top face once horizontally past the wall plane — that floor
    // contact ends the climb grounded. In the corner-transit region between
    // the two (over the lip, not yet over the face) probing would drag the
    // player off the path, so no probe runs there.
    const overFace = player.globalPosition.sub(info.vertex).dot(info.wallNormal) < 0;
    const probeDir = cleared()
      ? overFace
        ? info.floorNormal.neg()
        : null
      : info.wallNormal.neg();
    if (probeDir) {
      const newCol = player.moveAndCollide(probeDir.mul(2));
      if (newCol) {
        this.surfaceNormal = newCol.getNormal();
        this.supportBody = newCol.getCollider() as PhysicsBody2D;
      }
    }

    if (
      Surface.getSurfaceType(this.surfaceNormal, this.supportBody?.isRotating ?? false) ===
      SurfaceType.FLOOR
    ) {
      return new GroundedState(this.surfaceNormal, this.supportBody);
    }
    return this;
  }
}
