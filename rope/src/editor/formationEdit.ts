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
import { isCollisionObject, loadLevelTree, scaleLevelData, type CollisionGuide, type CollisionObjectData, type GuidePiece, type LevelBodyData, type LevelData } from "../level/levelFormat";
import { piecePolygon, type Pt } from "../formation/outline";
import type { SectionLoop } from "../formation/store";
import {
  addItem,
  composeWorld,
  modelFromDisk,
  modelFromTree,
  removeItems,
  worldOfNode,
  toLevelData,
  type EdBodyFrame,
  type EdItem,
  type EdModel,
  type SceneTag,
} from "./model";
import { childrenOf } from "./tree";
import type { Pose2D } from "../level/nodes";

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

export function formationItemOf(model: EdModel, unit: string): EdItem | null {
  return model.items.find((i) => i.unit === unit && i.object === "formation") ?? null;
}

// A piece the guide can be made from: a collision object that encloses
// something. Curves (rails, roots) and belts are left out of the guide and are
// never touched by aligning or fitting.
const encloses = (o: CollisionObjectData): boolean => o.shape.kind === "rect" || o.shape.kind === "circle" || o.shape.kind === "poly";
export const enclosingItem = (i: EdItem): boolean =>
  i.object === "collision" && (i.shape.kind === "rect" || i.shape.kind === "circle" || i.shape.kind === "poly");

// The body as it would be saved: its data, and which item wrote each object.
// A rock with no body above it has none (nothing of it is the sim's): an
// empty body at the origin, which has no pieces to take a guide from.
function bodyData(model: EdModel, unit: string): { body: LevelBodyData; itemOf: Map<SceneTag, number> } {
  const itemOf = new Map<SceneTag, number>();
  const data = toLevelData(model, itemOf);
  const body = data.bodies.find((b) => b.node?.id === unit) ?? { kind: "static" as const, x: 0, y: 0, rot: 0, objects: [] };
  return { body, itemOf };
}

// The body's rock's placement in the body's frame: its item's world
// placement measured from the body's. (The rock is the look, so it is not in
// the compiled body; the model holds it.)
function rockInBody(model: EdModel, unit: string, body: LevelBodyData): Placement {
  const rock = formationItemOf(model, unit);
  if (!rock) return local({});
  return compose(inverse(local(body)), { pos: rock.pos, rot: rock.rot });
}

// The body's enclosing collision pieces as a guide in the formation's frame,
// each with the rest of its object (`GuidePiece.piece`). `subset`, when given,
// is the indices into those pieces to take.
export function guideFromCollision(model: EdModel, unit: string, subset?: readonly number[]): CollisionGuide {
  const { body } = bodyData(model, unit);
  const toFormation = inverse(rockInBody(model, unit, body));
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
export function collisionMatchesGuide(model: EdModel, unit: string, guide: CollisionGuide): boolean {
  const now = guideFromCollision(model, unit, guide.subset);
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
// The pieces as items placed in the world, each with the placement it was
// given in `frame` (`local`), built through the editor's own loader without
// leaving metres, so nothing is rounded through pixels and back.
function itemsFor(frame: EdBodyFrame, objects: CollisionObjectData[]): { items: EdItem[]; locals: Pose2D[] } {
  const data: LevelData = {
    player: { x: 0, y: 0, radius: 0.1 },
    bodies: [{ kind: "static", x: frame.pos.x, y: frame.pos.y, rot: frame.rot, objects }],
  };
  const items = modelFromTree(loadLevelTree(data)).items.filter((i) => i.object === "collision");
  return { items, locals: objects.map((o) => ({ ...(o.x !== undefined ? { x: o.x } : {}), ...(o.y !== undefined ? { y: o.y } : {}), ...(o.rot !== undefined ? { rot: o.rot } : {}) })) };
}

// Swap the body's enclosing collision pieces for `fresh`, which take the body's
// properties (`copyBodyProps`) and the place in the item list the first of the
// old ones had. Returns the new items.
// The body's enclosing pieces replaced by `fresh`, as nodes of the body put
// where the first of the old ones stood among its siblings.
function replacePieces(model: EdModel, unit: string, made: { items: EdItem[]; locals: Pose2D[] }, frame: EdBodyFrame): EdItem[] {
  const fresh = made.items;
  const old = model.items.filter((i) => i.unit === unit && i.bodyOf === unit && enclosingItem(i));
  const first = old[0] ? model.tree.nodes.get(old[0].node) : undefined;
  const parent = first ? first.parent : model.tree.nodes.has(unit) ? unit : null;
  const index = first ? childrenOf(model.tree, parent).indexOf(first.id) : undefined;
  removeItems(model, old);
  // Where the body's frame IS the frame the pieces were given in (a rock at
  // its body's origin, the usual case), each keeps exactly the placement it
  // was given, so the file says what the guide said.
  const parentWorld = parent !== null ? worldOfNode(model, parent) : null;
  const sameFrame = parentWorld !== null && parentWorld.pos.x === frame.pos.x && parentWorld.pos.y === frame.pos.y && parentWorld.rot === frame.rot && parentWorld.z === 0;
  fresh.forEach((i, k) => {
    i.layer = "scene";
    addItem(model, i, parent, index === undefined || index < 0 ? undefined : index + k);
    if (sameFrame) {
      const local = made.locals[k] ?? {};
      const w = composeWorld(parentWorld!, local);
      i.pos = w.pos;
      i.rot = w.rot;
      const n = model.tree.nodes.get(i.node);
      if (n) n.local = local;
    }
  });
  return fresh;
}

// "Align collision to guide": the body's collision becomes exactly the pieces
// the guide was taken from (shape, placement and every field of each).
export function alignCollisionToGuide(model: EdModel, unit: string, formation: EdItem): EdItem[] {
  const guide = formation.formation?.guide;
  if (!guide || guide.kind !== "collision") return [];
  const frame: Placement = { pos: formation.pos, rot: formation.rot };
  const objects = guide.pieces.map((p): CollisionObjectData => ({ type: "collision", ...(p.piece ?? {}), ...written(local(p)), shape: p.shape }));
  return replacePieces(model, unit, itemsFor(frame, objects), frame);
}

// The body's enclosing pieces grouped by their fields (everything of the
// object but its shape and placement): one class per set of alike pieces, each
// with its pieces' polygons in the formation's frame and the fields the
// fitted pieces take.
export interface FitClass {
  polygons: Pt[][];
  piece: Omit<CollisionObjectData, "type" | "shape" | "x" | "y" | "rot">;
}

export function fitClasses(model: EdModel, unit: string): FitClass[] {
  const guide = guideFromCollision(model, unit);
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
export function previewFit(model: EdModel, unit: string, section: readonly SectionLoop[], accuracy: number): FitResult & { classes: FitClass[] } {
  const classes = fitClasses(model, unit);
  const result = fitSection(section, accuracy, classes.length ? classes.map((c) => c.polygons) : [[]]);
  return { ...result, classes };
}

// "Fit collision to geometry": the body's enclosing pieces become the fit's
// polygons, each class's with that class's fields. Returns the new items.
export function applyFit(model: EdModel, unit: string, formation: EdItem, fit: FitResult & { classes: FitClass[] }): EdItem[] {
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
  return replacePieces(model, unit, itemsFor(frame, objects), frame);
}
