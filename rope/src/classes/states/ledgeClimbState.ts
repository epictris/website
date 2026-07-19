// LedgeClimbState, ported from classes/PlayerStates/LedgeClimbState.cs.

import { Vec2 } from "../../engine/vec2";
import { Surface } from "../../lib/surface";
import { SurfaceType } from "../../lib/types";
import type { Player } from "../player";
import { PlayerState } from "./playerState";
import { GroundedState } from "./groundedState";

export class LedgeClimbState extends PlayerState {
  targetPosition: Vec2;
  surfaceNormal: Vec2;

  constructor(targetPosition: Vec2 = Vec2.ZERO, surfaceNormal: Vec2 = Vec2.ZERO) {
    super();
    this.targetPosition = targetPosition;
    this.surfaceNormal = surfaceNormal;
  }

  update(_player: Player, _delta: number): PlayerState {
    return this;
  }

  resolveCollision(player: Player, delta: number): PlayerState {
    player.velocity = player.globalPosition.directionTo(this.targetPosition).mul(0.75 / delta);

    for (let i = 0; i < 4; i++) {
      const collision = player.moveAndCollide(player.velocity.mul(delta));
      if (collision) {
        const normal = collision.getNormal();
        player.velocity = player.velocity.slide(normal);
        this.surfaceNormal = normal;
      }
    }

    // Snap to surface.
    const newCol = player.moveAndCollide(this.surfaceNormal.mul(-2 / delta));
    if (newCol) this.surfaceNormal = newCol.getNormal();

    if (Surface.getSurfaceType(this.surfaceNormal) === SurfaceType.FLOOR) {
      return new GroundedState(this.surfaceNormal);
    }
    return this;
  }
}
