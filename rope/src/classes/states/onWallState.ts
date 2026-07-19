// OnWallState (wall-run / wall-slide), ported from classes/PlayerStates/OnWallState.cs.

import { Vec2 } from "../../engine/vec2";
import { Mathf } from "../../engine/mathf";
import { Colors, Debug } from "../../engine/debug";
import { Surface } from "../../lib/surface";
import { Slide } from "../../lib/slide";
import { SlideType, SurfaceType } from "../../lib/types";
import type { Player } from "../player";
import { Player as PlayerClass } from "../player";
import { PlayerState } from "./playerState";
import { AirborneState } from "./airborneState";
import { GroundedState } from "./groundedState";
import { WallJumpingState } from "./wallJumpingState";
import { LedgeClimbState } from "./ledgeClimbState";
import { LedgeHangState } from "./ledgeHangState";

const WALL_RUN_ACCELERATION = 0.1;

export enum WallMode {
  Running,
  Sliding,
}

export class OnWallState extends PlayerState {
  surfaceNormal: Vec2 = Vec2.ZERO;
  wallMode: WallMode = WallMode.Sliding;
  entryVelocity: Vec2 = Vec2.ZERO;

  get wallDirection(): Vec2 {
    return this.surfaceNormal.orthogonal().mul(this.surfaceNormal.x > 0 ? 1 : -1);
  }

  static running(entryVelocity: Vec2, surfaceNormal: Vec2): OnWallState {
    const s = new OnWallState();
    s.wallMode = WallMode.Running;
    s.entryVelocity = entryVelocity;
    s.surfaceNormal = surfaceNormal;
    return s;
  }

  static sliding(surfaceNormal: Vec2): OnWallState {
    const s = new OnWallState();
    s.wallMode = WallMode.Sliding;
    s.surfaceNormal = surfaceNormal;
    return s;
  }

  enter(player: Player, delta: number): void {
    if (this.wallMode !== WallMode.Running) return;

    const pushMagnitude = Mathf.min(
      this.entryVelocity.dot(this.surfaceNormal.neg()),
      PlayerClass.JUMP_FORCE / delta,
    );
    const projectedVelocityMagnitude = this.entryVelocity.dot(this.wallDirection);

    if (this.entryVelocity.y > 0) {
      player.velocity = this.wallDirection.mul(projectedVelocityMagnitude + pushMagnitude);
    } else {
      player.velocity = this.wallDirection.mul(
        Mathf.max(
          projectedVelocityMagnitude,
          Mathf.min(this.entryVelocity.dot(this.surfaceNormal.neg()), PlayerClass.JUMP_FORCE / delta),
        ),
      );
    }
  }

  update(player: Player, delta: number): PlayerState {
    player.velocity = player.velocity.add(Vec2.DOWN.mul(0.25 / delta));

    const rightDirection = this.surfaceNormal.rotated(Mathf.Pi * 0.5);
    const leftDirection = this.surfaceNormal.rotated(Mathf.Pi * -0.5);

    const currentSpeed = player.velocity.cross(this.surfaceNormal.neg());
    const currentDirection = currentSpeed > 0 ? rightDirection : leftDirection;
    let velocity = currentDirection.mul(Mathf.abs(currentSpeed));

    const jumpFrames = player.inputs.jump.framesSinceActivation;
    if (jumpFrames !== null && jumpFrames <= PlayerClass.JUMP_BUFFER_FRAMES) {
      player.inputs.jump.deactivate();
      return new WallJumpingState(this.surfaceNormal);
    }

    const towardWall = player.xInputDirection * this.surfaceNormal.x < 0;
    const awayFromWall = player.xInputDirection * this.surfaceNormal.x > 0;
    const movingUp = velocity.y < 0;

    player.velocity = velocity;

    if (this.wallMode === WallMode.Running) {
      if (towardWall && movingUp) {
        velocity = velocity.add(currentDirection.mul(WALL_RUN_ACCELERATION / delta));
        player.velocity = velocity;
      } else {
        this.wallMode = WallMode.Sliding;
      }
    } else {
      if (this.surfaceNormal.y > 0.001) return new AirborneState();
      if (towardWall && movingUp) {
        this.wallMode = WallMode.Running;
      } else if (awayFromWall) {
        return new AirborneState();
      } else {
        if (velocity.y > PlayerClass.WALL_SLIDE_SPEED / delta) {
          velocity = velocity.sub(currentDirection.mul(PlayerClass.WALL_FRICTION / delta));
          if (velocity.length() < PlayerClass.WALL_SLIDE_SPEED / delta) {
            velocity = velocity.normalized().mul(PlayerClass.WALL_SLIDE_SPEED / delta);
          }
        }
        player.velocity = velocity;
      }
    }
    return this;
  }

  private moveAndSlide(player: Player, delta: number): PlayerState {
    let motionVector = player.velocity.mul(delta);
    let newState: PlayerState = this;
    for (let i = 0; i < 4; i++) {
      const collision = player.moveAndCollide(motionVector);
      if (!collision) return newState;
      const normal = collision.getNormal();
      switch (Surface.getSurfaceType(normal)) {
        case SurfaceType.WALL:
          this.surfaceNormal = normal;
          break;
        case SurfaceType.FLOOR:
          newState = new GroundedState(normal);
          break;
        case SurfaceType.CEILING:
          newState = new AirborneState();
          break;
      }
      switch (Slide.getSlideType(motionVector, normal)) {
        case SlideType.KEEP_VELOCITY:
          player.velocity = player.velocity
            .slide(normal)
            .normalized()
            .mul(player.velocity.length());
          break;
        case SlideType.PROJECT_VELOCITY:
          player.velocity = player.velocity.slide(normal);
          break;
      }
      motionVector = collision.getRemainder().slide(normal);
    }
    return newState;
  }

  resolveCollision(player: Player, delta: number): PlayerState {
    const newState = this.moveAndSlide(player, delta);

    if (newState instanceof OnWallState) {
      const world = player.world;
      const onWallState = newState;

      if (world && player.velocity.y < 0) {
        const rayStart = player.globalPosition
          .add(onWallState.wallDirection.mul(9))
          .sub(onWallState.surfaceNormal.mul(9));
        const rayEnd = rayStart.sub(onWallState.wallDirection.mul(player.velocity.length() * delta));
        Debug.drawArrow(rayStart, rayEnd, Colors.Yellow);
        const result = world.intersectRay(rayStart, rayEnd, { hitFromInside: true });
        if (
          result &&
          !result.normal.equals(Vec2.ZERO) &&
          Surface.getSurfaceType(result.normal) === SurfaceType.FLOOR
        ) {
          onWallState.snapToSurface(player, delta);
          return new LedgeClimbState(
            result.position.add(this.wallDirection.mul(9)).sub(this.surfaceNormal.mul(9)),
            this.surfaceNormal,
          );
        }
      } else if (world) {
        const rayEnd = player.globalPosition
          .add(onWallState.wallDirection.mul(9))
          .sub(onWallState.surfaceNormal.mul(9));
        const rayStart = rayEnd.add(onWallState.wallDirection.mul(player.velocity.length() * delta));
        Debug.drawArrow(rayStart, rayEnd, Colors.Yellow);
        const result = world.intersectRay(rayStart, rayEnd, { hitFromInside: true });
        if (
          result &&
          !result.normal.equals(Vec2.ZERO) &&
          Surface.getSurfaceType(result.normal) === SurfaceType.FLOOR
        ) {
          const positionalCorrection = result.position.sub(rayEnd);
          player.globalPosition = player.globalPosition.add(positionalCorrection);
          onWallState.snapToSurface(player, delta);
          return new LedgeHangState(
            result.position.add(this.wallDirection.mul(9)).sub(this.surfaceNormal.mul(9)),
            this.surfaceNormal,
          );
        }
      }

      if (world) {
        const raycast = world.intersectRay(
          player.globalPosition,
          player.globalPosition.sub(onWallState.surfaceNormal.mul(12)),
          { collisionMask: 1, exclude: [player] },
        );
        if (!raycast) return new AirborneState();
      }

      onWallState.snapToSurface(player, delta);
      if (Surface.getSurfaceType(onWallState.surfaceNormal) === SurfaceType.FLOOR) {
        return new GroundedState(onWallState.surfaceNormal);
      }
    }
    return newState;
  }

  snapToSurface(player: Player, delta: number): void {
    const col = player.moveAndCollide(this.surfaceNormal.mul(-2 / delta));
    if (col) this.surfaceNormal = col.getNormal();
  }
}
