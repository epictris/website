// Decoration - the authored shapes that are drawn and nothing else, resolved
// against the bodies the level was built from.
//
// A non-colliding shape (`LevelBodyData.collision: false`) is kept out of the
// simulation by never being built: it becomes no collision shape, enters no
// `World`, and carries no mass, so no physics query has to know it exists. That
// is the same guarantee the retired `backgrounds` list gave, made by
// construction rather than by keeping decoration in a type the sim has no name
// for - and it costs decoration nothing, since it is otherwise an ordinary
// authored shape with an ordinary 3D visual.
//
// What resolving adds is the one thing a drawn-only shape still needs from the
// build: WHICH body it rides. An entry tagged into a compound group is drawn in
// that group's engine body's frame, so a lantern bolted to a swinging crate
// swings, falls and turns with it.
//
// The conversion happens exactly once, here, for the reason chains convert their
// anchors here: a group's origin is its combined centre of mass, which moves as
// pieces are added, so the file authors a WORLD placement and the loader turns
// it into the offset and angle the body actually carries.
//
// An untagged entry - or one whose group has no colliding piece at all, which is
// a perfectly ordinary thing to author - resolves to `body: null` and is drawn
// exactly where it says it is.

import { Vec2 } from "../engine/vec2";
import type { CollisionObject2D } from "../engine/body";
import type { LevelBodyData } from "./levelFormat";

export interface SceneDecor {
  // The authored entry (metres): shape, colour, opacity and visual. The
  // placement in it is the authored world one, and stays the answer for an
  // unattached piece of decoration.
  readonly data: LevelBodyData;
  // The body this rides, or null for decoration fixed in the world.
  readonly body: CollisionObject2D | null;
  // Placement in that body's frame - meaningless when `body` is null.
  readonly localPos: Vec2;
  readonly localRot: number;
}

// Does this authored entry take part in the simulation? Absent means yes, which
// is what every entry authored before the field is. One predicate, so "is this
// drawn only" is asked the same way by the builder, both renderers and the
// editor rather than being spelled out per call site.
export function collides(b: LevelBodyData): boolean {
  return b.collision !== false;
}

// Where decoration sits, and how thick it is, when its visual says nothing.
// Just behind the gameplay plane and thin: that is what a flat fill drawn before
// every body already was, so a level that authors no depth looks exactly as it
// did. A shape's `thickness` is deliberately not consulted - it is the number a
// MASS is computed from, and decoration has none.
export const DECOR_Z = -0.35;
export const DECOR_DEPTH = 0.1;

// How far toward the camera this shape is drawn, in metres: 0 is the gameplay
// plane and positive is nearer the viewer.
//
// It is what DEPTH-ORDERS the scene, and both renderers and the editor's picking
// go through it so that what is drawn in front is what a click selects. Solid
// geometry is on the plane unless the level says otherwise; decoration falls
// back to `DECOR_Z` rather than to 0, which is what the 3D renderer draws it at.
export function depthOf(b: LevelBodyData): number {
  return b.visual?.offsetZ ?? (collides(b) ? 0 : DECOR_Z);
}

// Where a piece of decoration is drawn this render frame, in world metres. An
// attached one is resolved against the body's INTERPOLATED transform, not its
// sim transform: every other piece of derived geometry (the rope's wrap nodes,
// the ball's loop) is drawn that way, and decoration tracking the 60 Hz pose
// while the body it is bolted to draws interpolated would visibly detach from it
// between steps.
export function decorTransform(d: SceneDecor, alpha: number): { pos: Vec2; rot: number } {
  if (!d.body) return { pos: new Vec2(d.data.x, d.data.y), rot: d.data.rot };
  const rot = d.body.renderRotation(alpha);
  return { pos: d.body.renderPosition(alpha).add(d.localPos.rotated(rot)), rot: rot + d.localRot };
}

// Resolve one authored entry (metres) against the body its group built, if any.
export function resolveDecor(
  data: LevelBodyData,
  body: CollisionObject2D | null,
): SceneDecor {
  if (!body) return { data, body: null, localPos: Vec2.ZERO, localRot: 0 };
  const rot = body.globalRotation;
  return {
    data,
    body,
    localPos: new Vec2(data.x - body.globalPosition.x, data.y - body.globalPosition.y).rotated(-rot),
    localRot: data.rot - rot,
  };
}
