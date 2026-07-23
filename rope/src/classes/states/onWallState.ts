// OnWallState (wall-run / wall-slide), ported from classes/PlayerStates/OnWallState.cs.

import { Vec2 } from "../../engine/vec2";
import { Mathf } from "../../engine/mathf";
import type { PhysicsBody2D } from "../../engine/body";
import { GRAB_REACH_MARGIN, LedgeDetection } from "../../lib/ledgeDetection";
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
  supportBody: PhysicsBody2D | null = null;

  get wallDirection(): Vec2 {
    return this.surfaceNormal.orthogonal().mul(this.surfaceNormal.x > 0 ? 1 : -1);
  }

  static running(
    entryVelocity: Vec2,
    surfaceNormal: Vec2,
    supportBody: PhysicsBody2D | null = null,
  ): OnWallState {
    const s = new OnWallState();
    s.wallMode = WallMode.Running;
    s.entryVelocity = entryVelocity;
    s.surfaceNormal = surfaceNormal;
    s.supportBody = supportBody;
    return s;
  }

  static sliding(surfaceNormal: Vec2, supportBody: PhysicsBody2D | null = null): OnWallState {
    const s = new OnWallState();
    s.wallMode = WallMode.Sliding;
    s.surfaceNormal = surfaceNormal;
    s.supportBody = supportBody;
    return s;
  }

  // Contact-point velocity of the wall (game-design.md velocity inheritance);
  // null on static walls so the static path runs the exact pre-inheritance math.
  private carriedVelocity(player: Player): Vec2 | null {
    if (!this.supportBody?.isMobile) return null;
    const shape = player.getShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 0;
    return this.supportBody.velocityAtPoint(player.globalPosition.sub(this.surfaceNormal.mul(r)));
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
    // Wall physics runs relative to the wall's contact-point velocity; the
    // carried velocity is re-added on the way out so exits launch with it.
    const carried = this.carriedVelocity(player);
    if (carried) player.velocity = player.velocity.sub(carried);
    const next = this.updateRelative(player, delta);
    if (carried) player.velocity = player.velocity.add(carried);
    return next;
  }

  private updateRelative(player: Player, delta: number): PlayerState {
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
      } else if (!towardWall) {
        // Deliberate wall attach (game-design.md): the slide only holds
        // while toward-input is held. Releasing it detaches into a fall.
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
      const collider = collision.getCollider() as PhysicsBody2D;
      // Separating contact (depenetration pushout): positional correction
      // only — see GroundedState.moveAndSlide.
      if (player.velocity.dot(normal) > 0) {
        motionVector = collision.getRemainder();
        continue;
      }
      switch (Surface.getSurfaceType(normal, collider.isRotating)) {
        case SurfaceType.WALL:
          this.surfaceNormal = normal;
          this.supportBody = collider;
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
          player.velocity = player.velocity
            .slide(normal)
            .normalized()
            .mul(player.velocity.length());
          break;
        case SlideType.PROJECT_VELOCITY: {
          // Relative projection against mobile surfaces (see AirborneState).
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
    const newState = this.moveAndSlide(player, delta);

    if (newState instanceof OnWallState) {
      const world = player.world;
      const onWallState = newState;
      // Ledge grabs are deliberate: only while inputting toward the wall.
      // Otherwise the player continues past the lip with their velocity.
      const inputTowardWall = player.xInputDirection * onWallState.surfaceNormal.x < 0;

      if (world && inputTowardWall && player.rope?.isTaut !== true) {
        // Vertex-first detection over the swept path (LedgeDetection): no
        // ray, so approach speed and wall angle can't produce misses.
        const grab = LedgeDetection.findGrab(world.bodies, {
          path: player.sweptPath(),
          reach: player.radius + GRAB_REACH_MARGIN,
          wallNormalXSign: Math.sign(onWallState.surfaceNormal.x),
        });
        if (grab) {
          // Moving up transitions into ledge climb, otherwise into ledge hang.
          return player.velocity.y < 0
            ? new LedgeClimbState(grab.body, grab.vertexIndex)
            : new LedgeHangState(grab.body, grab.vertexIndex);
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
      if (
        Surface.getSurfaceType(
          onWallState.surfaceNormal,
          onWallState.supportBody?.isRotating ?? false,
        ) === SurfaceType.FLOOR
      ) {
        return new GroundedState(onWallState.surfaceNormal, onWallState.supportBody);
      }
    }
    return newState;
  }

  snapToSurface(player: Player, delta: number): void {
    const col = player.moveAndCollide(this.surfaceNormal.mul(-2 / delta));
    if (col) {
      this.surfaceNormal = col.getNormal();
      this.supportBody = col.getCollider() as PhysicsBody2D;
    }
  }
}
