// WallJumpingState, ported from classes/PlayerStates/WallJumpingState.cs.

import { Vec2 } from "../../engine/vec2";
import { Mathf } from "../../engine/mathf";
import { Surface } from "../../lib/surface";
import { Slide } from "../../lib/slide";
import { SlideType, SurfaceType } from "../../lib/types";
import type { Player } from "../player";
import { Player as PlayerClass } from "../player";
import { PlayerState } from "./playerState";
import { AirborneState } from "./airborneState";
import { GroundedState } from "./groundedState";
import { OnWallState } from "./onWallState";

const WALL_JUMP_FRAMES = 25;
const ACCELERATION_REDUCTION = 0.5;

export class WallJumpingState extends PlayerState {
  surfaceNormal: Vec2;
  framesRemaining = WALL_JUMP_FRAMES;

  constructor(wallNormal: Vec2 = Vec2.ZERO) {
    super();
    this.surfaceNormal = wallNormal;
  }

  enter(player: Player, delta: number): void {
    let jumpDirection: Vec2;
    const jumpSide = this.surfaceNormal.x > 0 ? 1 : -1;
    const angleToVertical = Mathf.radToDeg(this.surfaceNormal.angleTo(Vec2.UP));

    if (Mathf.abs(angleToVertical) < 90) {
      jumpDirection = Vec2.UP.rotated(Mathf.degToRad(45) * jumpSide);
    } else if (Mathf.abs(angleToVertical) < 90 + 45) {
      const weight = (Mathf.abs(angleToVertical) - 90) / 45;
      jumpDirection = Vec2.UP.rotated(Mathf.degToRad(45) * jumpSide).slerp(this.surfaceNormal, weight);
    } else {
      jumpDirection = this.surfaceNormal;
    }

    let velocity = player.velocity;
    const jumpImpulse = jumpDirection.mul((PlayerClass.JUMP_FORCE / delta) * 1.5);
    const maxYVelocity = Mathf.max(Mathf.abs(jumpImpulse.y), Mathf.abs(player.velocity.y));

    velocity = velocity.withY(Mathf.min(velocity.y, 0));
    velocity = velocity.add(jumpImpulse);
    velocity = velocity.withY(Mathf.clamp(velocity.y, -maxYVelocity, maxYVelocity));
    player.velocity = velocity;
  }

  update(player: Player, delta: number): PlayerState {
    let velocity = player.velocity;
    velocity = velocity.add(Vec2.DOWN.mul(0.25 / delta));
    const maxXSpeed = Mathf.max(PlayerClass.MAX_AIR_SPEED / delta, Mathf.abs(velocity.x));

    const input = player.xInputDirection;
    velocity = velocity.withX(
      velocity.x + (PlayerClass.AIR_ACCELERATION * ACCELERATION_REDUCTION * input) / delta,
    );
    velocity = velocity.withX(Mathf.clamp(velocity.x, -maxXSpeed, maxXSpeed));
    player.velocity = velocity;

    if (this.framesRemaining <= 0) return new AirborneState();
    this.framesRemaining--;
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
          if (player.xInputDirection * normal.x < 0)
            newState = OnWallState.running(player.velocity, normal);
          else if (player.xInputDirection * normal.x === 0) newState = OnWallState.sliding(normal);
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
    return this.moveAndSlide(player, delta);
  }
}
