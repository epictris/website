// LedgeClimbState, ported from classes/PlayerStates/LedgeClimbState.cs.
// Extended for mobile shapes (game-design.md): the climb target is stored in
// body-local space and re-derived each frame so it follows a moving ledge.

import { Vec2 } from "../../engine/vec2";
import type { PhysicsBody2D } from "../../engine/body";
import { Surface } from "../../lib/surface";
import { SurfaceType } from "../../lib/types";
import type { Player } from "../player";
import { PlayerState } from "./playerState";
import { GroundedState } from "./groundedState";

export class LedgeClimbState extends PlayerState {
  targetPosition: Vec2;
  surfaceNormal: Vec2;
  body: PhysicsBody2D | null;
  vertexIndex: number;
  private localTarget: Vec2 = Vec2.ZERO;
  private supportBody: PhysicsBody2D | null;

  constructor(
    targetPosition: Vec2 = Vec2.ZERO,
    surfaceNormal: Vec2 = Vec2.ZERO,
    body: PhysicsBody2D | null = null,
    vertexIndex = -1,
  ) {
    super();
    this.targetPosition = targetPosition;
    this.surfaceNormal = surfaceNormal;
    this.body = body;
    this.vertexIndex = vertexIndex;
    this.supportBody = body;
  }

  private get tracksMobileBody(): boolean {
    return (this.body?.isMobile ?? false) && this.vertexIndex >= 0;
  }

  enter(_player: Player, _delta: number): void {
    if (!this.tracksMobileBody || !this.body) return;
    const rot = this.body.globalRotation;
    this.localTarget = this.targetPosition.sub(this.body.globalPosition).rotated(-rot);
  }

  update(_player: Player, _delta: number): PlayerState {
    return this;
  }

  resolveCollision(player: Player, delta: number): PlayerState {
    if (this.tracksMobileBody && this.body && !this.body.removed) {
      this.targetPosition = this.body.globalPosition.add(
        this.localTarget.rotated(this.body.globalRotation),
      );
    }

    player.velocity = player.globalPosition.directionTo(this.targetPosition).mul(0.75 / delta);

    for (let i = 0; i < 4; i++) {
      const collision = player.moveAndCollide(player.velocity.mul(delta));
      if (collision) {
        const normal = collision.getNormal();
        player.velocity = player.velocity.slide(normal);
        this.surfaceNormal = normal;
        this.supportBody = collision.getCollider() as PhysicsBody2D;
      }
    }

    // Snap to surface.
    const newCol = player.moveAndCollide(this.surfaceNormal.mul(-2 / delta));
    if (newCol) {
      this.surfaceNormal = newCol.getNormal();
      this.supportBody = newCol.getCollider() as PhysicsBody2D;
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
