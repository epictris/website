// FinishLine — the level is over when the player enters, the mirror of
// `KillZone`.
//
// The whole mechanic is one overlap test, and it is deliberately the SAME one
// the killzone runs through (`World.notifyAreas`, exact SAT rather than a
// bounding circle): a level ends where the author drew the line, on the frame
// the avatar's own shape touches it, however it arrived - swinging, rolling or
// dropped through it from above. What "reaching the end" means is then a thing
// a player can see rather than a rule they have to be told.
//
// It fires ONCE for the run, because it is the run's ending: `onBodyEntered`
// reports an entry rather than a state, and `BallLevel` writes `completedFrame`
// only while it is null (see there). A level that RESETS builds a fresh world
// and a fresh area, which is what starts it over.

import { Area2D, type CollisionObject2D } from "../engine/body";

export class FinishLine extends Area2D {
  constructor(onPlayerFinished: () => void) {
    super();
    this.name = "FinishLine";
    this.onBodyEntered((body: CollisionObject2D) => {
      if (body.name === "Player") onPlayerFinished();
    });
  }
}
