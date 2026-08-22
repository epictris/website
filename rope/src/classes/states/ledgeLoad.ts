// The weight a hanging player puts on the thing it hangs from.
//
// A ledge grab pins the player KINEMATICALLY to the corner: the pose is derived
// from the corner's current transform and set directly, so the hang imparts no
// forces and a mover carries the player exactly (see `LedgeHangState`). For a
// static or a mover that is the whole truth - both are infinite mass and a
// force on them means nothing - but for a RIGID body it means a hanging player
// weighs nothing, which is wrong the moment the body is one that can answer to
// a load: a spring-mounted leaf the player grabs would not sag at all.
//
// So the load is transferred explicitly, one frame's worth of the player's
// weight applied at the corner. Impulse rather than force because that is what
// `RigidBody2D` speaks; `m·g·dt` is the same thing gravity applies to the body
// itself every frame.
//
// The lever arm is moot on a spring body (its rotation is locked) but it is
// written correctly anyway, so hanging from a FREE rigid body torques it the way
// a real weight on that corner would.
//
// The coupling is deliberately one-way and stable. The player is positionally
// pinned to the corner and the hang re-derives the corner's world position every
// frame, so the player simply rides the droop down - the same path a mover
// already takes - while the body feels a constant `m·g`. There is no force
// feedback loop and no oscillator driven by its own constraint. Frame order
// already works: the hang runs inside `Player.resolveInput`, before
// `World.integrate` applies the spring, so the load and the response land in the
// same frame.

import { Vec2 } from "../../engine/vec2";
import { GRAVITY } from "../../engine/world";
import { RigidBody2D, type PhysicsBody2D } from "../../engine/body";
import { Player } from "../player";

export function applyHangLoad(body: PhysicsBody2D, corner: Vec2, delta: number): void {
  if (!(body instanceof RigidBody2D) || body.removed) return;
  body.applyImpulse(GRAVITY.mul(Player.MASS * delta), corner.sub(body.globalPosition));
}
