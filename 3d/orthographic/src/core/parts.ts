// Objects as unions of parts. A part's box is kept as fractions of its
// object's box, so moving or scaling the object carries every part along;
// edits that change a part's own box go through its world box and then
// re-express every part in the object's new box.

import type { Part, Ring, SceneObject, Vec3, ViewId } from "./types";

/** A part with its box in metres (outlines still normalised to that box). */
export interface WorldPart {
  id?: string;
  min: Vec3;
  size: Vec3;
  outlines: Record<ViewId, Ring>;
}

/** One part filling the whole object: what a plain object is. */
export const wholePart = (outlines: Record<ViewId, Ring>): Part => ({ min: [0, 0, 0], size: [1, 1, 1], outlines });

/** A part's box in metres. */
export function partBox(e: SceneObject, part: Part): { min: Vec3; size: Vec3 } {
  return {
    min: [0, 1, 2].map((a) => e.min[a] + part.min[a] * e.size[a]) as Vec3,
    size: [0, 1, 2].map((a) => part.size[a] * e.size[a]) as Vec3,
  };
}

export const worldParts = (e: SceneObject): WorldPart[] =>
  e.parts.map((p) => ({ ...(p.id !== undefined && { id: p.id }), ...partBox(e, p), outlines: p.outlines }));

/** Set an object's parts from world boxes: its box becomes their union, and each part a fraction of it. */
export function setWorldParts(e: SceneObject, parts: WorldPart[]) {
  const min = [0, 1, 2].map((a) => Math.min(...parts.map((p) => p.min[a]))) as Vec3;
  const max = [0, 1, 2].map((a) => Math.max(...parts.map((p) => p.min[a] + p.size[a])));
  e.min = min;
  e.size = [0, 1, 2].map((a) => max[a] - min[a]) as Vec3;
  e.parts = parts.map((p) => ({
    ...(p.id !== undefined && { id: p.id }),
    // A part filling its object on an axis is exactly 0..1 there, whatever the float noise.
    min: [0, 1, 2].map((a) => (p.min[a] === min[a] ? 0 : (p.min[a] - min[a]) / e.size[a])) as Vec3,
    size: [0, 1, 2].map((a) =>
      p.min[a] === min[a] && p.min[a] + p.size[a] === max[a] ? 1 : p.size[a] / e.size[a],
    ) as Vec3,
    outlines: p.outlines,
  }));
}

/**
 * Bring an object stored before parts existed (outlines on the object) to
 * the current form. Returns true when it changed anything.
 */
export function upgradeObject(o: SceneObject): boolean {
  const old = o as SceneObject & { outlines?: Record<ViewId, Ring> };
  if (o.parts || !old.outlines) return false;
  o.parts = [wholePart(old.outlines)];
  delete old.outlines;
  return true;
}
