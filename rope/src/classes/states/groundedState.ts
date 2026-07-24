// GroundedState, ported from classes/PlayerStates/GroundedState.cs.

import { Vec2 } from "../../engine/vec2";
import { PX } from "../../engine/units";
import { Mathf } from "../../engine/mathf";
import { PhysicsBody2D, RigidBody2D } from "../../engine/body";
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
  supportBody: PhysicsBody2D | null;

  constructor(surfaceNormal: Vec2 = Vec2.ZERO, supportBody: PhysicsBody2D | null = null) {
    super();
    this.surfaceNormal = surfaceNormal;
    this.supportBody = supportBody;
  }

  enter(player: Player, _delta: number): void {
    player.coyoteBufferFrames = PlayerClass.COYOTE_BUFFER_FRAMES;
  }

  // Contact-point velocity of the supporting surface (v + ω × r,
  // game-design.md velocity inheritance); null on static supports so the
  // static path runs the exact pre-inheritance math.
  private carriedVelocity(player: Player): Vec2 | null {
    if (!this.supportBody?.isMobile) return null;
    const shape = player.getShape().shape;
    const r = shape.kind === "circle" ? shape.radius : 0;
    return this.supportBody.velocityAtPoint(player.globalPosition.sub(this.surfaceNormal.mul(r)));
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
    // Locomotion runs relative to the supporting surface; the carried velocity
    // is re-added on the way out so exits launch with it.
    const carried = this.carriedVelocity(player);
    if (carried) player.velocity = player.velocity.sub(carried);
    const next = this.updateRelative(player, delta);
    if (carried) player.velocity = player.velocity.add(carried);
    return next;
  }

  private updateRelative(player: Player, delta: number): PlayerState {
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

    return this;
  }

  // Whether the last moveAndSlide saw a static floor contact — used by the
  // snap path so a mover's corner can't steal the locomotion basis from an
  // underlying static floor (wedge rules, game-design.md).
  private sawStaticFloor = false;

  private moveAndSlide(player: Player, delta: number): PlayerState {
    let motionVector = player.velocity.mul(delta);
    let newState: PlayerState = this;
    this.sawStaticFloor = false;
    for (let i = 0; i < 4; i++) {
      const collision = player.moveAndCollide(motionVector);
      if (!collision) return newState;
      const normal = collision.getNormal();
      const collider = collision.getCollider() as PhysicsBody2D;
      // Separating contact — a depenetration pushout from an advancing mover
      // (or skin wobble) while the player already moves away from the surface.
      // Take the positional correction but leave velocity and state alone,
      // else the redirect points an escape velocity into the opposite wedge
      // face and it gets zeroed there.
      if (player.velocity.dot(normal) > 0) {
        motionVector = collision.getRemainder();
        continue;
      }
      switch (Slide.getSlideType(motionVector, normal)) {
        case SlideType.KEEP_VELOCITY:
          player.velocity = player.velocity
            .slide(normal)
            .normalized()
            .mul(player.velocity.length());
          break;
        case SlideType.PROJECT_VELOCITY:
          // Against a mobile surface, stop only the *relative normal*
          // component — keep the relative tangent so input still moves the
          // player along the surface (a full relative stop wiped locomotion
          // every frame while riding a mover). Statics keep the hard stop.
          if (collider.isMobile) {
            const vSurf = collider.velocityAtPoint(collision.getPosition());
            player.velocity = player.velocity.sub(vSurf).slide(normal).add(vSurf);
          } else {
            player.velocity = Vec2.ZERO;
          }
          // Recover the locomotion basis when the stop is against a floor —
          // the early return otherwise leaves the basis on a mover inside a
          // wedge (static preference as below).
          if (Surface.getSurfaceType(normal, collider.isRotating) === SurfaceType.FLOOR) {
            if (!collider.isMobile) {
              this.surfaceNormal = normal;
              this.supportBody = collider;
              this.sawStaticFloor = true;
            } else if (!this.sawStaticFloor) {
              this.surfaceNormal = normal;
              this.supportBody = collider;
            }
          }
          return newState;
      }
      switch (Surface.getSurfaceType(normal, collider.isRotating)) {
        case SurfaceType.WALL:
          // Deliberate wall attach (game-design.md): only toward-input hands
          // over to the wall state. Otherwise the wall just stops motion and
          // the player stays grounded (floor still underfoot). This also
          // subsumes the mover-wedge rule: a mobile wall that is NOT the
          // supporting surface never captures the player without input.
          // A taut rope wins over the wall (see OnWallState.update).
          if (player.xInputDirection * normal.x < 0 && player.rope?.isTaut !== true) {
            newState = OnWallState.running(player.velocity, normal, collider);
          }
          break;
        case SurfaceType.FLOOR:
          // Prefer a static floor as the locomotion basis: a mobile floor
          // contact (e.g. a mover's corner) must not displace a static floor
          // seen in the same frame, else input runs in the mover's drifting
          // frame and gets eaten inside a wedge.
          if (!collider.isMobile) {
            this.surfaceNormal = normal;
            this.supportBody = collider;
            this.sawStaticFloor = true;
          } else if (!this.sawStaticFloor) {
            this.surfaceNormal = normal;
            this.supportBody = collider;
          }
          newState = this;
          break;
        case SurfaceType.CEILING:
          // A mover's underside/corner must not hard-zero the player —
          // adopt its contact velocity instead (statics still full-stop).
          player.velocity = collider.isMobile
            ? collider.velocityAtPoint(collision.getPosition())
            : Vec2.ZERO;
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
      const maxSnapSurfaceDirection = player.velocity.add(Vec2.DOWN.mul(PX / delta)).normalized();
      const testCollision = player.moveAndCollide(this.surfaceNormal.mul(-PX), true);
      if (testCollision && !(testCollision.getCollider() instanceof RigidBody2D)) {
        const normal = testCollision.getNormal();
        if (normal.dot(maxSnapSurfaceDirection) <= 0.001) {
          if (player.rope === null) {
            player.globalPosition = player.globalPosition.add(testCollision.getTravel());
          }
          const collider = testCollision.getCollider() as PhysicsBody2D;
          switch (Surface.getSurfaceType(normal, collider.isRotating)) {
            case SurfaceType.WALL: {
              // Same wedge guard as moveAndSlide: a mobile wall that is not
              // the supporting surface must not capture the player into
              // wall-slide while the floor is still underfoot.
              if (collider.isMobile && collider !== this.supportBody) return this;
              // Deliberate wall attach: walking over a crest onto a steep
              // face only flows into wall-slide under toward-input;
              // otherwise the player leaves the crest airborne. A taut rope
              // wins over the wall (see OnWallState.update).
              if (player.xInputDirection * normal.x < 0 && player.rope?.isTaut !== true) {
                return OnWallState.sliding(normal, collider);
              }
              return new AirborneState();
            }
            case SurfaceType.FLOOR: {
              // Static-floor preference (see moveAndSlide): the snap probe
              // must not hand the basis to a mover when a static floor was
              // in contact this frame.
              if (!(collider.isMobile && this.sawStaticFloor)) {
                this.surfaceNormal = normal;
                this.supportBody = collider;
              }
              return this;
            }
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
