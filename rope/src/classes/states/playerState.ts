// PlayerState base class, ported from classes/PlayerStates/PlayerState.cs.

import { Mathf } from "../../engine/mathf";
import type { Player } from "../player";

export abstract class PlayerState {
  enter(_player: Player, _delta: number): void {}
  exit(_player: Player, _delta: number): void {}

  abstract update(player: Player, delta: number): PlayerState;

  postUpdate(_player: Player, _delta: number): PlayerState {
    return this;
  }

  resolveCollision(player: Player, delta: number): PlayerState {
    let motionVector = player.velocity.mul(delta);
    for (let i = 0; i < 4; i++) {
      const collision = player.moveAndCollide(motionVector);
      if (collision) {
        if (Mathf.abs(collision.getNormal().angleTo(motionVector)) > Mathf.Pi * 0.75) break;
        motionVector = collision.getRemainder().slide(collision.getNormal());
      } else {
        break;
      }
    }
    return this;
  }
}
