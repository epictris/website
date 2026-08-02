// Decoration - the geometry a level is drawn with that it is not built from -
// resolved against the bodies the level was built from.
//
// What decoration IS changed shape when bodies gained objects, and the new
// statement is simpler than the flag it replaced. A body's COLLISION objects are
// what the sim sees; its GEOMETRY objects are what it looks like. A geometry
// object that authors its own `shape` is a form the level draws and never
// simulates - a backdrop, a lantern, a sign - and that is decoration. One that
// authors none is the body's own collision outline dressed differently, so it is
// drawn as the body rather than in front of it and does not appear here at all.
//
// The exclusion from the sim needs no enforcing: a geometry object is never
// built, so it becomes no collision shape, enters no `World`, carries no mass
// and gives the rope no vertex to wrap. That is the same guarantee the retired
// `backgrounds` list gave and the `collision: false` flag after it, made by
// construction rather than by a rule every physics query has to honour.
//
// What resolving adds is the one thing a drawn-only shape still needs from the
// build: WHICH body it rides. A geometry object in a body that also has
// collision objects is drawn in that body's engine frame, so a lantern bolted to
// a swinging crate swings, falls and turns with it; one in a body that built
// nothing stands where it was authored.
//
// The conversion happens exactly once, at load, because the two frames genuinely
// differ: a body's engine origin is its combined centre of mass and the authored
// one is wherever the author put it (see `BuiltBody.origin`).

import { Vec2 } from "../engine/vec2";
import { localPlacement, type BuiltBodies, type BuiltBody } from "./buildBodies";
import { isGeometryObject, type GeometryObjectData, type LevelBodyData } from "./levelFormat";

export interface SceneDecor {
  // The body this belongs to, as built. Carries the authored data and whatever
  // engine object (if any) it rides.
  readonly built: BuiltBody;
  // The geometry object itself. Always one with a `shape` of its own - that is
  // what makes it a form rather than a re-dressing.
  readonly object: GeometryObjectData;
  // Placement in the frame that actually moves - the engine body's, or the
  // authored one for a body that built nothing.
  readonly localPos: Vec2;
  readonly localRot: number;
}

// Where decoration sits, and how thick it is, when its geometry object says
// nothing AND its body has no collision objects. Just behind the gameplay plane
// and thin: that is what a flat fill drawn before every body already was, so a
// level that authors no depth looks exactly as it did.
//
// A collision object's `thickness` is deliberately not consulted for the depth -
// it is the number a MASS is computed from, and decoration has none.
export const DECOR_Z = -0.35;
export const DECOR_DEPTH = 0.1;

// How far toward the camera a geometry object is drawn, in metres: 0 is the
// gameplay plane and positive is nearer the viewer.
//
// It is what DEPTH-ORDERS the scene, and both renderers and the editor's picking
// go through it so that what is drawn in front is what a click selects. Geometry
// on a body with collision is on the plane unless the level says otherwise;
// geometry on a body without falls back to `DECOR_Z` rather than to 0, which is
// what the 3D renderer draws it at.
export function depthOf(body: LevelBodyData, o?: GeometryObjectData): number {
  const collides = body.objects.some((x) => x.type === "collision");
  return o?.z ?? (collides ? 0 : DECOR_Z);
}

// Where a piece of decoration is drawn this render frame, in world metres. An
// attached one is resolved against the body's INTERPOLATED transform, not its
// sim transform: every other piece of derived geometry (the rope's wrap nodes,
// the ball's loop) is drawn that way, and decoration tracking the 60 Hz pose
// while the body it is bolted to draws interpolated would visibly detach from it
// between steps.
export function decorTransform(d: SceneDecor, alpha: number): { pos: Vec2; rot: number } {
  const body = d.built.body;
  if (!body) {
    return {
      pos: d.built.origin.add(d.localPos.rotated(d.built.rotation)),
      rot: d.built.rotation + d.localRot,
    };
  }
  const rot = body.renderRotation(alpha);
  return { pos: body.renderPosition(alpha).add(d.localPos.rotated(rot)), rot: rot + d.localRot };
}

// Every drawn-only form in a built level, in authored order - by body, then by
// object within the body. Depth ordering is applied where it is drawn rather
// than here, since the editor's picking wants the same rule over a model that
// has not been built.
export function collectDecor(built: BuiltBodies): SceneDecor[] {
  const out: SceneDecor[] = [];
  for (const b of built.bodies) {
    for (const o of b.data.objects) {
      if (!isGeometryObject(o) || o.shape === undefined) continue;
      const local = localPlacement(b, o);
      out.push({ built: b, object: o, localPos: local.pos, localRot: local.rot });
    }
  }
  return out;
}
