// Sound events - what the simulation contributes to the sound of the hook, and
// the whole of the boundary between the two (docs/sound.md).
//
// The rule is the sparks' (`level/sparkEvents.ts`): a sound pushes nothing, so
// none of it exists in the sim. What exists is a per-frame list of plain facts
// the sim had in hand anyway - which piece the hook reached, where, how fast -
// written by the level, CLEARED at the top of every `physicsProcess` so a
// headless replay never accumulates them, and never read back by anything the
// sim runs. Everything else - the surface's acoustics, the thresholds, the
// synthesis - is `audio/`.
//
// Only the hook's touches come through here, because only they are moments
// the sim keeps to itself: an attach removes the hook from the world inside
// its own step, and a bounce is reflected before the contact solver ever sees
// it. The ball's rolling, landing and wading, the coil and the flight are all
// readable off the world after the step, and are read there.

import type { CollisionShape2D, PhysicsBody2D } from "../engine/body";
import type { Vec2 } from "../engine/vec2";

export interface HookSoundEvent {
  // An ATTACH is the cuff biting (or clamping onto, or threading over) the
  // piece; a BOUNCE is it being deflected off a hook-proof one.
  readonly kind: "attach" | "bounce";
  // The hook that touched (`CollisionObject2D.id`), so a burst of reports of
  // one touch can be told apart from two hooks.
  readonly source: number;
  // What it touched: the body, and the piece of it where the sim named one.
  readonly body: PhysicsBody2D;
  readonly piece: CollisionShape2D | null;
  // World metres - the contact point.
  readonly point: Vec2;
  // Out of the surface, where the sim knew it (a bounce always does; an attach
  // does not carry one).
  readonly normal: Vec2 | null;
  // The hook's velocity at the touch RELATIVE TO THE SURFACE there, m/s, taken
  // before anything answered it: the arrival, which is what the strike sounds
  // like.
  readonly vel: Vec2;
  // The bounce came out of free flight: this is the throw ending on the wall,
  // not a deflection off a face the hook was already riding
  // (`BallHook.registerBounceCallback`). Always true for an attach.
  readonly fromFlight: boolean;
}
