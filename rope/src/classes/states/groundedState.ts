// GroundedState, ported from classes/PlayerStates/GroundedState.cs.

import { Vec2 } from "../../engine/vec2";
import { Mathf } from "../../engine/mathf";
import { Colors, Debug } from "../../engine/debug";
import { RigidBody2D } from "../../engine/body";
import { Surface } from "../../lib/surface";
import { Slide } from "../../lib/slide";
import { SlideType, SurfaceType } from "../../lib/types";
import type { Player } from "../player";
import { Player as PlayerClass } from "../player";
import { PlayerState } from "./playerState";
import { AirborneState } from "./airborneState";
import { OnWallState } from "./onWallState";

export class GroundedState extends PlayerState {
  surfaceNormal: Vec2;

  constructor(surfaceNormal: Vec2 = Vec2.ZERO) {
    super();
    this.surfaceNormal = surfaceNormal;
  }

  enter(player: Player, _delta: number): void {
    player.coyoteBufferFrames = PlayerClass.COYOTE_BUFFER_FRAMES;
  }

  private applySurfaceFriction(currentSpeed: number, delta: number): number {
    const f = PlayerClass.GROUND_FRICTION / delta;
    if (currentSpeed > f) return currentSpeed - f;
    if (currentSpeed < -f) return currentSpeed + f;
    return 0;
  }

  private applyInputForce(currentSpeed: number, player: Player, delta: number): number {
    if (player.xInputDirection !== 0) {
      if (currentSpeed * player.xInputDirection > 0) currentSpeed *= 0.8;
      currentSpeed -= (player.xInputDirection * PlayerClass.GROUND_ACCELERATION) / delta;
    }
    return currentSpeed;
  }

  update(player: Player, delta: number): PlayerState {
    player.coyoteBufferFrames = PlayerClass.COYOTE_BUFFER_FRAMES;

    let currentSpeed = player.velocity.cross(this.surfaceNormal);
    const maxSpeed = Mathf.max(PlayerClass.MAX_GROUND_SPEED / delta, Mathf.abs(currentSpeed));

    currentSpeed = this.applySurfaceFriction(currentSpeed, delta);
    currentSpeed = this.applyInputForce(currentSpeed, player, delta);
    currentSpeed = Mathf.clamp(currentSpeed, -maxSpeed, maxSpeed);

    player.velocity = this.surfaceNormal.orthogonal().mul(currentSpeed);

    const jumpFrames = player.inputs.jump.framesSinceActivation;
    if (jumpFrames !== null && jumpFrames <= PlayerClass.JUMP_BUFFER_FRAMES) {
      player.inputs.jump.deactivate();
      player.velocity = player.velocity.withY(-PlayerClass.JUMP_FORCE / delta);
      return new AirborneState();
    }

    Debug.drawArrow(
      player.globalPosition,
      player.globalPosition.sub(this.surfaceNormal.mul(12)),
      Colors.Red,
    );
    return this;
  }

  private moveAndSlide(player: Player, delta: number): PlayerState {
    let motionVector = player.velocity.mul(delta);
    let newState: PlayerState = this;
    for (let i = 0; i < 4; i++) {
      const collision = player.moveAndCollide(motionVector);
      if (!collision) return newState;
      const normal = collision.getNormal();
      switch (Slide.getSlideType(motionVector, normal)) {
        case SlideType.KEEP_VELOCITY:
          player.velocity = player.velocity
            .slide(normal)
            .normalized()
            .mul(player.velocity.length());
          break;
        case SlideType.PROJECT_VELOCITY:
          player.velocity = Vec2.ZERO;
          return newState;
      }
      switch (Surface.getSurfaceType(normal)) {
        case SurfaceType.WALL:
          newState =
            player.xInputDirection * normal.x < 0
              ? OnWallState.running(player.velocity, normal)
              : OnWallState.sliding(normal);
          break;
        case SurfaceType.FLOOR:
          this.surfaceNormal = normal;
          newState = this;
          break;
        case SurfaceType.CEILING:
          player.velocity = Vec2.ZERO;
          return new AirborneState();
      }
      motionVector = collision.getRemainder().slide(normal);
    }
    return newState;
  }

  resolveCollision(player: Player, delta: number): PlayerState {
    const newState = this.moveAndSlide(player, delta);

    if (newState instanceof GroundedState) {
      // If the player moved past the surface edge, try to snap to the closest surface
      // in the direction of the current normal, unless the new normal is too different.
      const maxSnapSurfaceDirection = player.velocity.add(Vec2.DOWN.mul(1 / delta)).normalized();
      const testCollision = player.moveAndCollide(this.surfaceNormal.mul(-1), true);
      if (testCollision && !(testCollision.getCollider() instanceof RigidBody2D)) {
        const normal = testCollision.getNormal();
        if (normal.dot(maxSnapSurfaceDirection) <= 0.001) {
          if (player.rope === null) {
            player.globalPosition = player.globalPosition.add(testCollision.getTravel());
          }
          switch (Surface.getSurfaceType(normal)) {
            case SurfaceType.WALL:
              return OnWallState.sliding(normal);
            case SurfaceType.FLOOR:
              this.surfaceNormal = normal;
              return this;
            case SurfaceType.CEILING:
              return new AirborneState();
          }
        }
      }
      return new AirborneState();
    }
    return newState;
  }
}
