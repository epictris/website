// A body's formation as the editor edits it (docs/formations.md, "The
// collision guide workflow"): the guide taken from the collision, the
// collision put back onto the guide, the collision fitted to the rock.
//
// Every conversion goes through the editor's own save and load
// (`toLevelData`, `modelFromDisk`), so a piece taken into a guide and put back
// is written and read exactly as a saved level's pieces are: nothing here
// knows which of a collision object's fields exist.
//
// FRAMES. The model holds items in world metres; a guide holds its pieces in
// the formation's frame (the formation item's placement). A placement here is
// {pos, rot} composed as every authored placement is (`worldPlacement`).

import { PIXELS_PER_METER } from "../engine/units";
import { Vec2 } from "../engine/vec2";
import { fitSection, type FitResult } from "../formation/fit";
import { isCollisionObject, scaleLevelData, type CollisionGuide, type CollisionObjectData, type GuidePiece, type LevelBodyData, type LevelData } from "../level/levelFormat";
import { piecePolygon, type Pt } from "../formation/outline";
import type { SectionLoop } from "../formation/store";
import {
  bodyFrameOf,
  bodyLead,
  bodyMembers,
  copyBodyProps,
  modelFromDisk,
  toLevelData,
  type EdBodyFrame,
  type EdItem,
  type EdModel,
  type SceneTag,
} from "./model";

interface Placement {
  pos: Vec2;
  rot: number;
}

const compose = (a: Placement, b: Placement): Placement => ({ pos: a.pos.add(b.pos.rotated(a.rot)), rot: a.rot + b.rot });
const inverse = (a: Placement): Placement => ({ pos: a.pos.rotated(-a.rot).neg(), rot: -a.rot });
const local = (p: { x?: number; y?: number; rot?: number }): Placement => ({ pos: new Vec2(p.x ?? 0, p.y ?? 0), rot: p.rot ?? 0 });
const written = (p: Placement): { x?: number; y?: number; rot?: number } => ({
  ...(p.pos.x !== 0 ? { x: p.pos.x } : {}),
  ...(p.pos.y !== 0 ? { y: p.pos.y } : {}),
  ...(p.rot !== 0 ? { rot: p.rot } : {}),
});

export function formationItemOf(model: EdModel, bodyId: number): EdItem | null {
  return model.items.find((i) => i.bodyId === bodyId && i.object === "formation") ?? null;
}

// A piece the guide can be made from: a collision object that encloses
// something. Curves (rails, roots) and belts are left out of the guide and are
// never touched by aligning or fitting.
const encloses = (o: CollisionObjectData): boolean => o.shape.kind === "rect" || o.shape.kind === "circle" || o.shape.kind === "poly";
export const enclosingItem = (i: EdItem): boolean =>
  i.object === "collision" && (i.shape.kind === "rect" || i.shape.kind === "circle" || i.shape.kind === "poly");

// The body as it would be saved: its data, and which item wrote each object.
function bodyData(model: EdModel, bodyId: number): { body: LevelBodyData; itemOf: Map<SceneTag, number> } {
  const members = bodyMembers(model.items, bodyId);
  const sub: EdModel = {
    ...model,
    items: members,
    chains: [],
    vines: [],
    bodyFrames: new Map([[bodyId, bodyFrameOf(model, bodyId)]]),
  };
  const itemOf = new Map<SceneTag, number>();
  const data = toLevelData(sub, itemOf);
  return { body: data.bodies[0]!, itemOf };
}

// The body's enclosing collision pieces as a guide in the formation's frame,
// each with the rest of its object (`GuidePiece.piece`). `subset`, when given,
// is the indices into those pieces to take.
export function guideFromCollision(model: EdModel, bodyId: number, subset?: readonly number[]): CollisionGuide {
  const { body } = bodyData(model, bodyId);
  const toFormation = inverse(local(body.formation ?? {}));
  const pieces = body.objects.filter(isCollisionObject).filter(encloses);
  const taken = subset ? pieces.filter((_, k) => subset.includes(k)) : pieces;
  return {
    kind: "collision",
    pieces: taken.map((o): GuidePiece => {
      const { type: _t, shape, x: _x, y: _y, rot: _r, ...piece } = o;
      return { ...written(compose(toFormation, local(o))), shape, piece };
    }),
    ...(subset ? { subset: [...subset] } : {}),
  };
}

// Whether the body's collision is, to a micrometre, the guide's pieces in shape
// and placement (`subset`, if the guide has one, picks which pieces count).
export function collisionMatchesGuide(model: EdModel, bodyId: number, guide: CollisionGuide): boolean {
  const now = guideFromCollision(model, bodyId, guide.subset);
  if (now.pieces.length !== guide.pieces.length) return false;
  const near = (a: unknown, b: unknown): boolean => {
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-6;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, k) => near(v, b[k]));
    if (a && b && typeof a === "object" && typeof b === "object") {
      const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
      const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
      return ka.length === kb.length && ka.every((k) => near((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
    }
    return a === b;
  };
  const shapeAndPlace = (p: GuidePiece) => ({ x: p.x ?? 0, y: p.y ?? 0, rot: p.rot ?? 0, shape: p.shape });
  return now.pieces.every((p, k) => near(shapeAndPlace(p), shapeAndPlace(guide.pieces[k]!)));
}

// Items for `objects` placed in the frame `frame`, built by the editor's own
// load: as a level holding them in one body would load.
function itemsFor(frame: EdBodyFrame, objects: CollisionObjectData[]): EdItem[] {
  const data: LevelData = {
    player: { x: 0, y: 0, radius: 0.1 },
    bodies: [{ kind: "static", x: frame.pos.x, y: frame.pos.y, rot: frame.rot, objects }],
  };
  return modelFromDisk(scaleLevelData(data, PIXELS_PER_METER)).items.filter((i) => i.object === "collision");
}

// Swap the body's enclosing collision pieces for `fresh`, which take the body's
// properties (`copyBodyProps`) and the place in the item list the first of the
// old ones had. Returns the new items.
function replacePieces(model: EdModel, bodyId: number, fresh: EdItem[]): EdItem[] {
  const members = bodyMembers(model.items, bodyId);
  const template = bodyLead(members) ?? members[0]!;
  for (const i of fresh) {
    copyBodyProps(i, template);
    i.bodyId = bodyId;
    i.layer = "scene";
  }
  const at = model.items.findIndex((i) => i.bodyId === bodyId && enclosingItem(i));
  const kept = model.items.filter((i) => !(i.bodyId === bodyId && enclosingItem(i)));
  const insertAt = at < 0 ? kept.length : Math.min(at, kept.length);
  model.items = [...kept.slice(0, insertAt), ...fresh, ...kept.slice(insertAt)];
  return fresh;
}

// "Align collision to guide": the body's collision becomes exactly the pieces
// the guide was taken from (shape, placement and every field of each).
export function alignCollisionToGuide(model: EdModel, bodyId: number, formation: EdItem): EdItem[] {
  const guide = formation.formation?.guide;
  if (!guide || guide.kind !== "collision") return [];
  const frame: Placement = { pos: formation.pos, rot: formation.rot };
  const objects = guide.pieces.map((p): CollisionObjectData => ({ type: "collision", ...(p.piece ?? {}), ...written(local(p)), shape: p.shape }));
  return replacePieces(model, bodyId, itemsFor(frame, objects));
}

// The body's enclosing pieces grouped by their fields (everything of the
// object but its shape and placement): one class per set of alike pieces, each
// with its pieces' polygons in the formation's frame and the fields the
// fitted pieces take.
export interface FitClass {
  polygons: Pt[][];
  piece: Omit<CollisionObjectData, "type" | "shape" | "x" | "y" | "rot">;
}

export function fitClasses(model: EdModel, bodyId: number): FitClass[] {
  const guide = guideFromCollision(model, bodyId);
  const classes = new Map<string, FitClass>();
  for (const p of guide.pieces) {
    const key = JSON.stringify(p.piece ?? {}, Object.keys(p.piece ?? {}).sort());
    const poly = piecePolygon(p);
    if (!poly) continue;
    const c = classes.get(key) ?? { polygons: [], piece: p.piece ?? {} };
    c.polygons.push(poly);
    classes.set(key, c);
  }
  return [...classes.values()];
}

// The fit at `accuracy` (metres) of the body's collision to `section` (the
// formation's frame), without changing anything: for the live vertex count.
export function previewFit(model: EdModel, bodyId: number, section: readonly SectionLoop[], accuracy: number): FitResult & { classes: FitClass[] } {
  const classes = fitClasses(model, bodyId);
  const result = fitSection(section, accuracy, classes.length ? classes.map((c) => c.polygons) : [[]]);
  return { ...result, classes };
}

// "Fit collision to geometry": the body's enclosing pieces become the fit's
// polygons, each class's with that class's fields. Returns the new items.
export function applyFit(model: EdModel, bodyId: number, formation: EdItem, fit: FitResult & { classes: FitClass[] }): EdItem[] {
  const frame: Placement = { pos: formation.pos, rot: formation.rot };
  const objects: CollisionObjectData[] = [];
  fit.polygons.forEach((polys, c) => {
    const piece = fit.classes[c]?.piece ?? {};
    for (const poly of polys) {
      // Each piece's origin on its own centroid, as a drawn shape's is.
      let cx = 0;
      let cy = 0;
      for (const q of poly) {
        cx += q.x;
        cy += q.y;
      }
      cx /= poly.length;
      cy /= poly.length;
      objects.push({
        type: "collision",
        ...piece,
        ...written({ pos: new Vec2(cx, cy), rot: 0 }),
        shape: { kind: "poly", verts: poly.map((q) => ({ x: q.x - cx, y: q.y - cy })) },
      });
    }
  });
  if (!objects.length) return [];
  return replacePieces(model, bodyId, itemsFor(frame, objects));
}
