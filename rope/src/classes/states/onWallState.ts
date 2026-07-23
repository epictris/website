// OnWallState (wall-run / wall-slide), ported from classes/PlayerStates/OnWallState.cs.

import { Vec2 } from "../../engine/vec2";
import { Mathf } from "../../engine/mathf";
import { Colors, Debug } from "../../engine/debug";
import type { PhysicsBody2D } from "../../engine/body";
import { ShapeGeometry } from "../../lib/shapeGeometry";
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
// How close the ledge probe hit must land to a shape vertex to count as that
// vertex's ledge (px). Probe geometry offsets are 9 px, so 16 covers them.
const LEDGE_VERTEX_TOLERANCE = 16;

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
          Surface.getSurfaceType(result.normal, result.collider.isRotating) === SurfaceType.FLOOR
        ) {
          // Candidacy: the floor hit must sit on a stored ledge-candidate
          // vertex (game-design.md). Circles have no vertices — never grab.
          const vi = OnWallState.ledgeVertexIndex(result.collider, result.position);
          if (vi !== null) {
            onWallState.snapToSurface(player, delta);
            return new LedgeClimbState(
              result.position.add(this.wallDirection.mul(9)).sub(this.surfaceNormal.mul(9)),
              this.surfaceNormal,
              result.collider,
              vi,
            );
          }
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
          Surface.getSurfaceType(result.normal, result.collider.isRotating) === SurfaceType.FLOOR
        ) {
          const vi = OnWallState.ledgeVertexIndex(result.collider, result.position);
          if (vi !== null) {
            const positionalCorrection = result.position.sub(rayEnd);
            player.globalPosition = player.globalPosition.add(positionalCorrection);
            onWallState.snapToSurface(player, delta);
            return new LedgeHangState(
              result.position.add(this.wallDirection.mul(9)).sub(this.surfaceNormal.mul(9)),
              this.surfaceNormal,
              result.collider,
              vi,
            );
          }
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

  // Nearest ledge-candidate vertex of the collider to the probe hit, or null
  // when none qualifies (no vertex nearby, angle above threshold, circles).
  private static ledgeVertexIndex(collider: PhysicsBody2D, hitPosition: Vec2): number | null {
    if (!collider.hasShape()) return null;
    const shape = collider.getShape();
    const vi = ShapeGeometry.findNearestVertexIndex(shape, hitPosition, LEDGE_VERTEX_TOLERANCE);
    if (vi === null || !ShapeGeometry.isLedgeCandidate(shape.shape, vi)) return null;
    return vi;
  }

  snapToSurface(player: Player, delta: number): void {
    const col = player.moveAndCollide(this.surfaceNormal.mul(-2 / delta));
    if (col) {
      this.surfaceNormal = col.getNormal();
      this.supportBody = col.getCollider() as PhysicsBody2D;
    }
  }
}
