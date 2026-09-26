// What a click on a GUIDE lands on. The Visuals workspace draws the level's
// editor furniture - collision outlines, light icons, the spawn, a polygon's
// corners - into the 3D scene rather than onto the 2D overlay (see
// `guides.ts`), and those objects are picked by the same raycast as the models
// they annotate (`Scene3D.pick`). Each one carries one of these as its
// `userData.pickTag`, the slot a drawn model carries its authored object in, so
// a pick comes back as one nearest-first list of both.
//
// A tag names an editor ITEM by id and, for the parts that are one of many on
// that item (a corner, an edge's midpoint), which one. It is plain data rather
// than a reference to the item, because the guides are rebuilt from the model
// on every revision and an item object is replaced wholesale by an undo: an id
// is the one thing about it that survives both.

export type GuidePart =
  // A collision object's outline on the gameplay plane.
  | "outline"
  // One corner of the selected polygon or path (`index` is the vertex).
  | "vertex"
  // The midpoint of the edge from vertex `index` to the next, where a new
  // vertex is inserted.
  | "midpoint"
  // A light's source icon. Only the icon: the reach and wake rings are a
  // readout, and a light picked by its pool would be a sheet over everything it
  // lit (see `lightPickRadius` in editor/render.ts).
  | "light"
  // The player's spawn ring (`id` is `SPAWN_GUIDE_ID`).
  | "spawn"
  // A camera region's outline.
  | "region"
  // A camera path or firefly path.
  | "path"
  // A note: a text box, an arrow or a checkpoint.
  | "note";

export interface GuideTag {
  readonly guide: GuidePart;
  // The item's id (`EdItem.id`), or `SPAWN_GUIDE_ID` for the spawn.
  readonly id: number;
  // Which vertex, for "vertex" and "midpoint"; absent otherwise.
  readonly index?: number;
}

// The spawn is not an item, so it has no id of its own. Ids are allocated
// from 1 upward (`newBodyId`), so a negative one can never name an item.
export const SPAWN_GUIDE_ID = -1;

export function guideTag(guide: GuidePart, id: number, index?: number): GuideTag {
  return index === undefined ? { guide, id } : { guide, id, index };
}

// A pick list mixes these with the authored objects drawn models carry, so the
// caller sorts them apart by asking.
export function isGuideTag(tag: unknown): tag is GuideTag {
  if (typeof tag !== "object" || tag === null) return false;
  const t = tag as Partial<GuideTag>;
  return typeof t.guide === "string" && typeof t.id === "number";
}

// Equality by what a tag names rather than by identity: two rebuilds of the
// guides tag the same corner with two different objects.
export function sameGuide(a: GuideTag, b: GuideTag): boolean {
  return a.guide === b.guide && a.id === b.id && a.index === b.index;
}
