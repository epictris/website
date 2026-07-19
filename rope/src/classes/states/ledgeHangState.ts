// LedgeHangState, ported from classes/PlayerStates/LedgeHangState.cs.

import { Vec2 } from "../../engine/vec2";
import type { Player } from "../player";
import { PlayerState } from "./playerState";
import { AirborneState } from "./airborneState";
import { LedgeClimbState } from "./ledgeClimbState";

export class LedgeHangState extends PlayerState {
  surfaceNormal: Vec2;
  ledgePosition: Vec2;

  constructor(ledgePosition: Vec2 = Vec2.ZERO, surfaceNormal: Vec2 = Vec2.ZERO) {
    super();
    this.ledgePosition = ledgePosition;
    this.surfaceNormal = surfaceNormal;
  }

  update(player: Player, _delta: number): PlayerState {
    player.velocity = Vec2.ZERO;
    // A taut rope drags the body positionally; hanging can't stay pinned against it.
    if (player.rope?.isTaut === true) return new AirborneState();
    if (player.xInputDirection * this.surfaceNormal.x < 0) {
      return new LedgeClimbState(this.ledgePosition, this.surfaceNormal);
    }
    if (player.xInputDirection * this.surfaceNormal.x > 0) {
      return new AirborneState();
    }
    return this;
  }

  resolveCollision(_player: Player, _delta: number): PlayerState {
    return this;
  }
}
