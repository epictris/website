// KillZone — resets the level when the player enters, ported from classes/KillZone.cs.

import { Area2D, type CollisionObject2D } from "../engine/body";

export class KillZone extends Area2D {
  constructor(onPlayerKilled: () => void) {
    super();
    this.name = "KillZone";
    this.onBodyEntered((body: CollisionObject2D) => {
      if (body.name === "Player") onPlayerKilled();
    });
  }
}
