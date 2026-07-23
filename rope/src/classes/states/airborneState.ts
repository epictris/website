// AirborneState, ported from classes/PlayerStates/AirborneState.cs.

import { Vec2 } from "../../engine/vec2";
import { Mathf } from "../../engine/mathf";
import type { PhysicsBody2D } from "../../engine/body";
import { Surface } from "../../lib/surface";
import { Slide } from "../../lib/slide";
import { SlideType, SurfaceType } from "../../lib/types";
import type { Player } from "../player";
import { Player as PlayerClass } from "../player";
import { PlayerState } from "./playerState";
import { OnWallState } from "./onWallState";
import { GroundedState } from "./groundedState";

export class AirborneState extends PlayerState {
  update(player: Player, delta: number): PlayerState {
    player.coyoteBufferFrames--;

    let velocity = player.velocity;
    velocity = velocity.add(Vec2.DOWN.mul(0.25 / delta));
    const maxXSpeed = Mathf.max(PlayerClass.MAX_AIR_SPEED / delta, Mathf.abs(velocity.x));

    const input = player.xInputDirection;

    if (player.rope?.isTaut ?? false) {
      velocity = velocity.withX(velocity.x + (0.05 / delta) * input);
    } else {
      if (velocity.x * input < 0) {
        velocity = velocity.withX(velocity.x + (PlayerClass.AIR_ACCELERATION / delta) * input);
        velocity = velocity.withX(velocity.x * 0.8);
      } else {
        velocity = velocity.withX(velocity.x + (PlayerClass.AIR_ACCELERATION / delta) * input);
      }
    }

    velocity = velocity.withX(Mathf.clamp(velocity.x, -maxXSpeed, maxXSpeed));
    player.velocity = velocity;

    const jumpFrames = player.inputs.jump.framesSinceActivation;
    if (jumpFrames !== null && jumpFrames <= PlayerClass.JUMP_BUFFER_FRAMES) {
      player.inputs.jump.deactivate();
      if (player.coyoteBufferFrames > 0) {
        player.velocity = player.velocity.withY(-PlayerClass.JUMP_FORCE / delta);
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
      const collider = collision.getCollider() as PhysicsBody2D;
      // Separating contact (depenetration pushout): positional correction
      // only — see GroundedState.moveAndSlide.
      if (player.velocity.dot(normal) > 0) {
        motionVector = collision.getRemainder();
        continue;
      }
      switch (Surface.getSurfaceType(normal, collider.isRotating)) {
        case SurfaceType.WALL:
          if (player.xInputDirection * normal.x < 0)
            newState = OnWallState.running(player.velocity, normal, collider);
          else if (player.xInputDirection * normal.x === 0)
            newState = OnWallState.sliding(normal, collider);
          // else: pressing away from wall — don't attach
          break;
        case SurfaceType.FLOOR:
          newState = new GroundedState(normal, collider);
          break;
        case SurfaceType.CEILING:
          newState = new AirborneState();
          break;
      }
      switch (Slide.getSlideType(motionVector, normal)) {
        case SlideType.KEEP_VELOCITY:
          player.velocity = player.velocity.slide(normal).normalized().mul(player.velocity.length());
          break;
        case SlideType.PROJECT_VELOCITY: {
          // Project the velocity *relative* to a mobile surface so an
          // advancing mover imparts its motion (statics reduce to the plain
          // slide as before).
          if (collider.isMobile) {
            const vSurf = collider.velocityAtPoint(collision.getPosition());
            player.velocity = player.velocity.sub(vSurf).slide(normal).add(vSurf);
          } else {
            player.velocity = player.velocity.slide(normal);
          }
          break;
        }
      }
      motionVector = collision.getRemainder().slide(normal);
    }
    return newState;
  }

  resolveCollision(player: Player, delta: number): PlayerState {
    return this.moveAndSlide(player, delta);
  }
}
