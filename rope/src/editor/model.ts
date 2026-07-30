// Editor scene model. Mirrors LevelData but keeps positions as Vec2 in WORLD
// METRES (so it shares the camera/pointer un-projection with the sim), plus a
// stable id per item for selection. Conversions to/from the on-disk pixel
// format live here, symmetric with the runtime loader.
//
// Everything the editor manipulates is one `EdItem` type carrying a `layer`,
// rather than a union per layer: a camera region is drawn, picked, dragged,
// resized, rotated, rubber-banded, duplicated and undone exactly like a body,
// and one item type means those paths cannot drift apart per layer. The cost is
// that an item carries the fields of every layer; serialisation drops the ones
// its layer does not use, so nothing meaningless reaches disk.

import { Vec2 } from "../engine/vec2";
import {
  isConvexLoop,
  nearestOnCircle,
  nearestOnOutline,
  polyCentroid,
  polySignedArea2,
} from "../engine/shapes";
import { PIXELS_PER_METER, PX } from "../engine/units";
import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_OPACITY,
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  DEFAULT_NOTE_TEXT_SIZE,
  DEFAULT_CHAIN_LAYER,
  DEFAULT_SURFACE_FRICTION,
  DEFAULT_VIEWPORT_SCALE,
  NOTE_ARROW_THICKNESS,
  scaleLevelData,
  type BackgroundData,
  type BodyKind,
  type CameraRegionData,
  type ChainData,
  type ChainLayer,
  type LevelData,
  type NoteData,
  type ShapeData,
} from "../level/levelFormat";

// Editor layers, in draw order (the list also stacks bottom-up in the toolbar):
// `background` is decoration behind the level, `geometry` the scene bodies,
// `camera` the camera-behaviour volumes and `notes` the authoring annotations
// (invisible in play).
export type EdLayer = "background" | "geometry" | "camera" | "notes";
export const ED_LAYERS: EdLayer[] = ["background", "geometry", "camera", "notes"];

// `poly` vertices are metres in the item's own local frame, kept **convex** and
// centred on their area centroid — `setPolyVerts` is the one writer, so no edit
// path can leave either invariant broken. Convexity is a hard rule of the
// format (see "Convex-only polygons; compound bodies" in docs/game-design.md);
// centring is what makes the item's `pos` its centre of mass, which every
// rigid-body lever arm in the engine assumes.
export type EdShape =
  | { kind: "rect"; w: number; h: number }
  | { kind: "circle"; r: number }
  | { kind: "poly"; verts: Vec2[] };

// Camera-layer properties (see CameraRegionData for the semantics). `lockX/Y`
// null = that axis follows the avatar; `blend` and `buffer` null = the
// controller's defaults.
export interface EdCamera {
  offset: Vec2; // metres
  viewportScale: number;
  lockX: number | null; // metres
  lockY: number | null; // metres
  blend: number | null; // seconds
  buffer: number | null; // metres; null = the controller's REGION_EXIT_MARGIN
  priority: number;
}

// Notes-layer properties (see NoteData). A note is always a rect: for a text
// note the box holds the wrapped text, for an arrow it is the segment's length
// and pick band.
export interface EdNote {
  kind: "text" | "arrow";
  text: string;
  size: number; // metres, glyph height (text notes)
}

export interface EdItem {
  id: number;
  layer: EdLayer;
  // Compound-body membership (geometry layer only): items sharing a group id
  // build into ONE engine body carrying all their shapes, so the rope and ledge
  // detection treat the join between two pieces as an interior seam rather than
  // as a corner (see `LevelBodyData.group`). Null = a body of its own.
  //
  // The id is editor-local and never leaves it: `toLevelData` writes a `g<id>`
  // tag, and loading mints fresh ids from whatever tags a file carries.
  group: number | null;
  pos: Vec2; // metres
  rot: number; // radians
  shape: EdShape; // metres
  // Geometry and background layers author these; camera regions and notes take
  // the fixed editor-furniture colours below.
  color: string; // hex fill colour
  opacity: number; // 0..1 fill opacity (a body's border draws fully opaque)
  // Geometry layer:
  kind: BodyKind;
  friction: number; // surface friction, 0 (ice) .. 1 (rubber)
  force: number; // force areas only: m/s² along the item's rotation
  // Camera layer:
  cam: EdCamera;
  // Notes layer:
  note: EdNote;
}

// A detached copy of a shape. Undo snapshots, duplicate, copy/paste and the
// clipboard all need one: shapes are mutated in place, and a polygon carries an
// array of vertices that a shallow `{...shape}` would leave shared — the bug
// there is silent (an undo that also rewrites the state it was undoing to).
export function cloneShape(s: EdShape): EdShape {
  return s.kind === "poly" ? { kind: "poly", verts: [...s.verts] } : { ...s };
}

// Is this item an arrow note? Arrows are the one item edited by their endpoints
// rather than by corner handles, so the test is shared by picking and drawing.
export function isArrowNote(item: EdItem): boolean {
  return item.layer === "notes" && item.note.kind === "arrow";
}

// The endpoints of an arrow note, in world metres: tail (local -X) to head.
export function arrowEnds(item: EdItem): { tail: Vec2; head: Vec2 } {
  // An arrow note is always a rect (its width is the shaft length); the fallback
  // keeps the accessor total for the other kinds rather than asserting.
  const half = item.shape.kind === "rect" ? item.shape.w / 2 : halfExtents(item).x;
  return {
    tail: toWorld(item, new Vec2(-half, 0)),
    head: toWorld(item, new Vec2(half, 0)),
  };
}

// An arrow shorter than this cannot be aimed (the endpoints coincide), so a
// click that never dragged still leaves something grabbable.
export const MIN_ARROW_LENGTH = 0.1;

// Re-derive an arrow's stored box from a pair of endpoints. The box centre is
// the midpoint and `rot` is the direction, so an endpoint drag and an
// arrow drawn from scratch produce exactly the same item.
export function setArrowEnds(item: EdItem, tail: Vec2, head: Vec2): void {
  const d = head.sub(tail);
  item.pos = tail.add(head).mul(0.5);
  item.rot = Math.atan2(d.y, d.x);
  if (item.shape.kind === "rect") item.shape.w = Math.max(MIN_ARROW_LENGTH, d.length());
}

// One end of a chain: the item it is tied to, and where on that item, in the
// item's own local (unrotated) frame. Local rather than world so the anchor
// rides its body through every move, rotate and resize - the same reason a
// `RopeContact` is stored in its body's frame at runtime.
export interface EdChainEnd {
  itemId: number;
  local: Vec2; // metres, item-local
}

// A chain strung between two geometry items (see `ChainData`). It is not an
// `EdItem`: it has no shape, no placement of its own and nothing to resize -
// everything about it is derived from the two bodies it holds - so it lives in
// its own list and carries its own selection rather than being forced through
// the item machinery.
export interface EdChain {
  id: number;
  a: EdChainEnd;
  b: EdChainEnd;
  // Metres. Null = exactly taut between the two anchors, re-derived at load, so
  // a chain dragged out between two bodies stays taut as they are moved.
  length: number | null;
  // Hex link colour; null = the renderer's own forged-iron pair.
  color: string | null;
  // Which plane the chain lives in - what it draws in front of and what it is
  // allowed to touch, which are one decision (see `ChainLayer`). Note this is
  // NOT the editor's own `EdLayer`: a chain is authored on the geometry layer
  // whichever plane it ends up hanging in.
  chainLayer: ChainLayer;
}

export interface EdModel {
  player: { pos: Vec2; radius: number };
  items: EdItem[];
  chains: EdChain[];
}

let nextId = 1;
export function newBodyId(): number {
  return nextId++;
}

// The layer-inapplicable half of a fresh item. Kept in one place so a new item
// (drawn, pasted, loaded) always carries the same inert defaults.
export const defaultCamera = (): EdCamera => ({
  offset: Vec2.ZERO,
  viewportScale: DEFAULT_VIEWPORT_SCALE,
  lockX: null,
  lockY: null,
  blend: null,
  buffer: null,
  priority: 0,
});

export const defaultNote = (): EdNote => ({
  kind: "text",
  text: "",
  size: DEFAULT_NOTE_TEXT_SIZE * PX,
});

// Camera regions and notes are editor-only furniture — they are never drawn in
// game, so their appearance is fixed here rather than authored and saved.
export const CAMERA_REGION_COLOR = "#c792ea";
export const CAMERA_REGION_OPACITY = 0.12;
export const NOTE_COLOR = "#98c379";
export const NOTE_OPACITY = 0.08;

// Appearance a freshly drawn item starts with, per layer. Geometry and
// background are authored from here on; the other two are fixed furniture.
export const LAYER_STYLE: Record<EdLayer, { color: string; opacity: number }> = {
  background: { color: DEFAULT_BACKGROUND_COLOR, opacity: DEFAULT_BACKGROUND_OPACITY },
  geometry: { color: DEFAULT_BODY_COLOR, opacity: DEFAULT_BODY_OPACITY },
  camera: { color: CAMERA_REGION_COLOR, opacity: CAMERA_REGION_OPACITY },
  notes: { color: NOTE_COLOR, opacity: NOTE_OPACITY },
};

// Default box of a freshly placed text note, in metres. A text note is usually
// placed with a click rather than dragged out, so it needs a size worth typing
// into from the start.
export const NOTE_DEFAULT_SIZE = new Vec2(2.4, 0.8);
// Default length of an arrow placed with a click rather than dragged out.
export const NOTE_DEFAULT_ARROW_LENGTH = 1.2;
export const NOTE_ARROW_BAND = NOTE_ARROW_THICKNESS * PX;

// --- conversions ------------------------------------------------------------

// On-disk shape → editor shape. A polygon's vertices are copied into Vec2s
// (they are mutated in place by the vertex handles, so they must not alias the
// loaded data).
function edShape(s: ShapeData): EdShape {
  if (s.kind === "rect") return { kind: "rect", w: s.w, h: s.h };
  if (s.kind === "circle") return { kind: "circle", r: s.r };
  return { kind: "poly", verts: s.verts.map((v) => new Vec2(v.x, v.y)) };
}

// Metre-space LevelData → editor model.
function fromLevelData(data: LevelData): EdModel {
  // On-disk group tags are arbitrary strings; the editor works in numeric ids,
  // so each distinct tag mints one.
  const groupIds = new Map<string, number>();
  const groupIdFor = (tag: string | undefined): number | null => {
    if (!tag) return null;
    const existing = groupIds.get(tag);
    if (existing !== undefined) return existing;
    const id = newBodyId();
    groupIds.set(tag, id);
    return id;
  };
  const bodies: EdItem[] = data.bodies.map((b) => ({
    id: newBodyId(),
    layer: "geometry",
    group: groupIdFor(b.group),
    kind: b.kind,
    pos: new Vec2(b.x, b.y),
    rot: b.rot,
    shape: edShape(b.shape),
    color: b.color ?? DEFAULT_BODY_COLOR,
    opacity: b.opacity ?? DEFAULT_BODY_OPACITY,
    friction: b.friction ?? DEFAULT_SURFACE_FRICTION,
    force: b.force ?? 0,
    cam: defaultCamera(),
    note: defaultNote(),
  }));
  const backgrounds: EdItem[] = (data.backgrounds ?? []).map((g) => ({
    id: newBodyId(),
    layer: "background",
    group: null, // grouping is a geometry-layer notion; keeps the field total
    kind: "static", // unused on this layer; keeps the field total
    pos: new Vec2(g.x, g.y),
    rot: g.rot,
    shape: edShape(g.shape),
    color: g.color ?? DEFAULT_BACKGROUND_COLOR,
    opacity: g.opacity ?? DEFAULT_BACKGROUND_OPACITY,
    friction: DEFAULT_SURFACE_FRICTION,
    force: 0,
    cam: defaultCamera(),
    note: defaultNote(),
  }));
  const regions: EdItem[] = (data.cameraRegions ?? []).map((r) => ({
    id: newBodyId(),
    layer: "camera",
    group: null, // grouping is a geometry-layer notion; keeps the field total
    kind: "static", // unused on this layer; keeps the field total
    pos: new Vec2(r.x, r.y),
    rot: r.rot,
    shape: edShape(r.shape),
    color: CAMERA_REGION_COLOR,
    opacity: CAMERA_REGION_OPACITY,
    friction: DEFAULT_SURFACE_FRICTION,
    force: 0,
    cam: {
      offset: new Vec2(r.offsetX ?? 0, r.offsetY ?? 0),
      viewportScale: r.viewportScale ?? DEFAULT_VIEWPORT_SCALE,
      lockX: r.lockX ?? null,
      lockY: r.lockY ?? null,
      blend: r.blend ?? null,
      buffer: r.buffer ?? null,
      priority: r.priority ?? 0,
    },
    note: defaultNote(),
  }));
  const notes: EdItem[] = (data.notes ?? []).map((n) => ({
    id: newBodyId(),
    layer: "notes",
    group: null, // grouping is a geometry-layer notion; keeps the field total
    kind: "static", // unused on this layer; keeps the field total
    pos: new Vec2(n.x, n.y),
    rot: n.rot,
    shape: { kind: "rect", w: n.w, h: n.h },
    color: NOTE_COLOR,
    opacity: NOTE_OPACITY,
    friction: DEFAULT_SURFACE_FRICTION,
    force: 0,
    cam: defaultCamera(),
    note: {
      kind: n.kind,
      text: n.text ?? "",
      size: n.size ?? DEFAULT_NOTE_TEXT_SIZE * PX,
    },
  }));
  // Chains name bodies by their index in `data.bodies`, which is exactly the
  // order `bodies` was just built in. A chain whose index is out of range (a
  // hand-edited file) is dropped rather than left dangling.
  const chains: EdChain[] = [];
  for (const c of data.chains ?? []) {
    const a = bodies[c.a.body];
    const b = bodies[c.b.body];
    if (!a || !b) continue;
    chains.push({
      id: newBodyId(),
      a: { itemId: a.id, local: toLocal(a, new Vec2(c.a.x, c.a.y)) },
      b: { itemId: b.id, local: toLocal(b, new Vec2(c.b.x, c.b.y)) },
      length: c.length ?? null,
      color: c.color ?? null,
      chainLayer: c.layer ?? DEFAULT_CHAIN_LAYER,
    });
  }

  return {
    player: { pos: new Vec2(data.player.x, data.player.y), radius: data.player.radius },
    items: [...backgrounds, ...bodies, ...regions, ...notes],
    chains,
  };
}

// Editor model → metre-space LevelData. Each layer writes its own list, and
// only the fields that layer gives meaning to.
export function toLevelData(model: EdModel): LevelData {
  const shapeOf = (i: EdItem): ShapeData => {
    if (i.shape.kind === "rect") return { kind: "rect", w: i.shape.w, h: i.shape.h };
    if (i.shape.kind === "circle") return { kind: "circle", r: i.shape.r };
    return { kind: "poly", verts: i.shape.verts.map((v) => ({ x: v.x, y: v.y })) };
  };

  const backgrounds: BackgroundData[] = model.items
    .filter((i) => i.layer === "background")
    .map((i) => ({
      x: i.pos.x,
      y: i.pos.y,
      rot: i.rot,
      shape: shapeOf(i),
      // Appearance is the whole point of a background, so it is always written
      // rather than omitted at its default.
      color: i.color,
      opacity: i.opacity,
    }));

  const cameraRegions: CameraRegionData[] = model.items
    .filter((i) => i.layer === "camera")
    .map((i) => ({
      x: i.pos.x,
      y: i.pos.y,
      rot: i.rot,
      shape: shapeOf(i),
      // Omit anything left at its neutral value, so a saved region carries only
      // what was actually authored.
      ...(i.cam.offset.x !== 0 ? { offsetX: i.cam.offset.x } : {}),
      ...(i.cam.offset.y !== 0 ? { offsetY: i.cam.offset.y } : {}),
      ...(i.cam.viewportScale !== DEFAULT_VIEWPORT_SCALE
        ? { viewportScale: i.cam.viewportScale }
        : {}),
      ...(i.cam.lockX !== null ? { lockX: i.cam.lockX } : {}),
      ...(i.cam.lockY !== null ? { lockY: i.cam.lockY } : {}),
      ...(i.cam.blend !== null ? { blend: i.cam.blend } : {}),
      ...(i.cam.buffer !== null ? { buffer: i.cam.buffer } : {}),
      ...(i.cam.priority !== 0 ? { priority: i.cam.priority } : {}),
    }));

  const notes: NoteData[] = model.items
    .filter((i) => i.layer === "notes")
    .map((i) => {
      const h = halfExtents(i);
      return {
        kind: i.note.kind,
        x: i.pos.x,
        y: i.pos.y,
        rot: i.rot,
        w: h.x * 2,
        h: h.y * 2,
        // An arrow carries no text and no glyph height; a text note writes both
        // so a reopened level shows exactly what was authored.
        ...(i.note.kind === "text" ? { text: i.note.text, size: i.note.size } : {}),
      };
    });

  const geometry = model.items.filter((i) => i.layer === "geometry");
  // Chains name their bodies by index into the list written below, so the two
  // are derived from the same array in the same order.
  const indexOfItem = new Map(geometry.map((b, i) => [b.id, i]));

  const chains: ChainData[] = [];
  for (const c of model.chains) {
    const a = model.items.find((i) => i.id === c.a.itemId);
    const b = model.items.find((i) => i.id === c.b.itemId);
    const ia = indexOfItem.get(c.a.itemId);
    const ib = indexOfItem.get(c.b.itemId);
    // A chain whose body has been deleted (or is no longer geometry) has nothing
    // to hold and is simply not written.
    if (!a || !b || ia === undefined || ib === undefined) continue;
    const wa = toWorld(a, c.a.local);
    const wb = toWorld(b, c.b.local);
    chains.push({
      a: { body: ia, x: wa.x, y: wa.y },
      b: { body: ib, x: wb.x, y: wb.y },
      // Omitted = taut between the anchors, which the loader re-derives.
      ...(c.length !== null ? { length: c.length } : {}),
      ...(c.color !== null ? { color: c.color } : {}),
      // Omitted at the default, so a level of ordinary foreground chains keeps
      // the shape it had before the field existed.
      ...(c.chainLayer !== DEFAULT_CHAIN_LAYER ? { layer: c.chainLayer } : {}),
    });
  }

  return {
    player: { x: model.player.pos.x, y: model.player.pos.y, radius: model.player.radius },
    bodies: geometry.map((b) => ({
      kind: b.kind,
      x: b.pos.x,
      y: b.pos.y,
      rot: b.rot,
      shape: shapeOf(b),
      color: b.color,
      opacity: b.opacity,
      friction: b.friction,
      // Only force areas carry a magnitude; omitting it elsewhere keeps saved
      // levels free of a field that would read as meaningful.
      ...(b.kind === "force" ? { force: b.force } : {}),
      // The tag is only meaningful against the other members, so it is written
      // as a plain `g<id>` rather than carrying the editor's numbering onto disk
      // as something to be interpreted.
      ...(b.group !== null ? { group: `g${b.group}` } : {}),
    })),
    // An empty list is the same as no list, and the absent field keeps levels
    // authored before backgrounds (or camera regions, or notes) byte-identical.
    ...(backgrounds.length ? { backgrounds } : {}),
    ...(cameraRegions.length ? { cameraRegions } : {}),
    ...(notes.length ? { notes } : {}),
    ...(chains.length ? { chains } : {}),
  };
}

// On-disk pixel LevelData → editor model.
export function modelFromDisk(pixelData: LevelData): EdModel {
  return fromLevelData(scaleLevelData(pixelData, PX));
}

// Editor model → on-disk pixel LevelData.
export function modelToDisk(model: EdModel): LevelData {
  return scaleLevelData(toLevelData(model), PIXELS_PER_METER);
}

// --- geometry ---------------------------------------------------------------

// An item's local vertex loop — rect corners or polygon vertices, [] for a
// circle. The ordering matches the engine's winding contract (clockwise on
// screen), so an item drawn here and the shape it becomes agree edge for edge.
export function localVertices(item: EdItem): Vec2[] {
  if (item.shape.kind === "circle") return [];
  if (item.shape.kind === "poly") return item.shape.verts;
  const hw = item.shape.w / 2;
  const hh = item.shape.h / 2;
  return [new Vec2(-hw, hh), new Vec2(-hw, -hh), new Vec2(hw, -hh), new Vec2(hw, hh)];
}

export function worldVertices(item: EdItem): Vec2[] {
  return localVertices(item).map((v) => toWorld(item, v));
}

// Convex hull of a point set (Andrew's monotone chain), returned in the winding
// the engine expects. Drawing a polygon runs the clicked points through this
// rather than rejecting an out-of-order or slightly dented outline: a convex
// polygon *is* its own hull, so a well-drawn shape comes back exactly as
// clicked, and a badly-drawn one becomes the nearest convex shape instead of an
// error message. Returns [] if the points are collinear or too few.
export function convexHull(points: readonly Vec2[]): Vec2[] {
  if (points.length < 3) return [];
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (src: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of src) {
      while (
        out.length >= 2 &&
        out[out.length - 1]!.sub(out[out.length - 2]!).cross(p.sub(out[out.length - 1]!)) <= 0
      ) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  const hull = [...half(pts), ...half([...pts].reverse())];
  if (hull.length < 3) return [];
  return polySignedArea2(hull) >= 0 ? hull : hull.reverse();
}

// The only writer of a polygon's vertices. It re-centres them on their centroid
// and shifts `pos` to compensate, so the drawn geometry does not move while the
// origin lands where the physics needs it — and it refuses a loop that is not
// convex, leaving the shape as it was rather than saving something the rope
// solver cannot wrap. Returns whether the edit was accepted.
export function setPolyVerts(item: EdItem, verts: readonly Vec2[]): boolean {
  if (item.shape.kind !== "poly" || verts.length < 3) return false;
  const ordered = polySignedArea2(verts) >= 0 ? [...verts] : [...verts].reverse();
  if (!isConvexLoop(ordered)) return false;
  const c = polyCentroid(ordered);
  item.shape.verts = ordered.map((v) => v.sub(c));
  item.pos = item.pos.add(c.rotated(item.rot));
  return true;
}

// Half-extents of an item's (unrotated) bounding box, i.e. centre → top-left.
export function halfExtents(item: EdItem): Vec2 {
  if (item.shape.kind === "circle") return new Vec2(item.shape.r, item.shape.r);
  if (item.shape.kind === "rect") return new Vec2(item.shape.w / 2, item.shape.h / 2);
  let x = 0;
  let y = 0;
  for (const v of item.shape.verts) {
    x = Math.max(x, Math.abs(v.x));
    y = Math.max(y, Math.abs(v.y));
  }
  return new Vec2(x, y);
}

// Axis-aligned bounds of a group of items, from their unrotated extents (the
// same approximation `halfExtents` gives snapping). Empty group → a zero box.
export function groupBounds(items: readonly EdItem[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of items) {
    const h = halfExtents(b);
    minX = Math.min(minX, b.pos.x - h.x);
    minY = Math.min(minY, b.pos.y - h.y);
    maxX = Math.max(maxX, b.pos.x + h.x);
    maxY = Math.max(maxY, b.pos.y + h.y);
  }
  if (!items.length) return { min: Vec2.ZERO, max: Vec2.ZERO };
  return { min: new Vec2(minX, minY), max: new Vec2(maxX, maxY) };
}

// Does an item overlap an axis-aligned world rect (min/max sorted)? Touch
// semantics — any overlap counts, so a rubber-band need not enclose an item.
export function bodyIntersectsRect(item: EdItem, min: Vec2, max: Vec2): boolean {
  if (item.shape.kind === "circle") {
    // Closest point on the rect to the centre.
    const cx = Math.min(Math.max(item.pos.x, min.x), max.x);
    const cy = Math.min(Math.max(item.pos.y, min.y), max.y);
    return item.pos.distanceTo(new Vec2(cx, cy)) <= item.shape.r;
  }
  if (item.shape.kind === "poly") {
    // SAT between the band (world axes) and the placed vertex loop.
    const verts = worldVertices(item);
    const axes = [new Vec2(1, 0), new Vec2(0, 1)];
    for (let i = 0; i < verts.length; i++) {
      const e = verts[(i + 1) % verts.length]!.sub(verts[i]!);
      if (e.lengthSquared() > 1e-18) axes.push(e.orthogonal().normalized());
    }
    const boxCorners = [
      min,
      new Vec2(max.x, min.y),
      max,
      new Vec2(min.x, max.y),
    ];
    for (const axis of axes) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of verts) {
        const p = v.dot(axis);
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
      let blo = Infinity;
      let bhi = -Infinity;
      for (const c of boxCorners) {
        const p = c.dot(axis);
        blo = Math.min(blo, p);
        bhi = Math.max(bhi, p);
      }
      if (lo > bhi || blo > hi) return false;
    }
    return true;
  }
  // SAT between the rect (world axes) and the item's rotated box: four axes,
  // the two world ones and the item's own.
  const ha = max.sub(min).mul(0.5);
  const hb = halfExtents(item);
  const d = item.pos.sub(min.add(max).mul(0.5));
  const c = Math.abs(Math.cos(item.rot));
  const s = Math.abs(Math.sin(item.rot));
  if (Math.abs(d.x) > ha.x + hb.x * c + hb.y * s) return false;
  if (Math.abs(d.y) > ha.y + hb.x * s + hb.y * c) return false;
  const dl = d.rotated(-item.rot);
  if (Math.abs(dl.x) > hb.x + ha.x * c + ha.y * s) return false;
  if (Math.abs(dl.y) > hb.y + ha.x * s + ha.y * c) return false;
  return true;
}

// Is an item *wholly* inside an axis-aligned world rect? The window half of the
// CAD-style rubber band (dragged left→right); `bodyIntersectsRect` is the
// crossing half (dragged right→left).
export function bodyWithinRect(item: EdItem, min: Vec2, max: Vec2): boolean {
  if (item.shape.kind === "circle") {
    const r = item.shape.r;
    return (
      item.pos.x - r >= min.x &&
      item.pos.x + r <= max.x &&
      item.pos.y - r >= min.y &&
      item.pos.y + r <= max.y
    );
  }
  // A rect or a convex polygon is the hull of its vertices, so every vertex
  // inside is exactly "the whole shape is inside" — rotation included.
  return worldVertices(item).every(
    (w) => w.x >= min.x && w.x <= max.x && w.y >= min.y && w.y <= max.y,
  );
}

// A point in the item's local (unrotated) frame, origin at the item centre.
export function toLocal(item: EdItem, world: Vec2): Vec2 {
  return world.sub(item.pos).rotated(-item.rot);
}

export function toWorld(item: EdItem, local: Vec2): Vec2 {
  return item.pos.add(local.rotated(item.rot));
}

// Is a world point inside the item's shape?
export function pointInBody(item: EdItem, world: Vec2): boolean {
  if (item.shape.kind === "circle") return world.distanceTo(item.pos) <= item.shape.r;
  const l = toLocal(item, world);
  if (item.shape.kind === "rect") {
    return Math.abs(l.x) <= item.shape.w / 2 && Math.abs(l.y) <= item.shape.h / 2;
  }
  // Convex polygon: inside every face's half-plane.
  const verts = item.shape.verts;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const e = verts[(i + 1) % verts.length]!.sub(a);
    if (e.y * (l.x - a.x) - e.x * (l.y - a.y) > 0) return false;
  }
  return true;
}

// --- groups -----------------------------------------------------------------

// Every item of `group`, in model order. An item with no group is its own body,
// so a null group has no members - callers pass a concrete id.
export function groupMembers(items: readonly EdItem[], group: number): EdItem[] {
  return items.filter((i) => i.group === group);
}

// The selection an item click means: the whole compound body it belongs to, or
// just the item when it is ungrouped. A group IS one body, so picking one piece
// of it and picking it are the same act.
export function pickGroupOf(items: readonly EdItem[], item: EdItem): EdItem[] {
  return item.group === null ? [item] : groupMembers(items, item.group);
}

// Area of an item's shape, in m². Mass is proportional to area everywhere in
// this project (`ShapeGeometry.computeMass` is area/1000 for every kind), so
// this is what weights a group's centre of mass.
export function shapeArea(item: EdItem): number {
  if (item.shape.kind === "circle") return Math.PI * item.shape.r * item.shape.r;
  if (item.shape.kind === "rect") return item.shape.w * item.shape.h;
  return Math.abs(polySignedArea2(item.shape.verts)) / 2;
}

// A group's centre of mass - the point `buildLevelBodies` puts the compound
// body's origin at, and therefore the point it rotates about. Weighted by area,
// not the bounding-box centre: every rigid-body lever arm in the engine is
// measured from the body origin, so the two have to agree.
export function groupCentroid(items: readonly EdItem[]): Vec2 {
  let total = 0;
  let acc = Vec2.ZERO;
  for (const i of items) {
    const a = shapeArea(i);
    total += a;
    acc = acc.add(i.pos.mul(a));
  }
  if (total > 0) return acc.div(total);
  // Degenerate (zero-area) shapes: fall back to the plain mean so the answer is
  // still inside the group rather than NaN.
  return items.reduce((c, i) => c.add(i.pos), Vec2.ZERO).div(Math.max(1, items.length));
}

// Turn a whole group about `centre` by `delta` radians: each piece's placement
// swings round the centre and its own angle follows. That is exactly what
// rotating the built body does, since a piece is mounted at a local offset and
// a local angle off that origin.
export function rotateGroupAbout(items: readonly EdItem[], centre: Vec2, delta: number): void {
  for (const i of items) {
    i.pos = centre.add(i.pos.sub(centre).rotated(delta));
    i.rot += delta;
  }
}

// Body-level properties a compound body has exactly one of. When several items
// build into one body only the first member's are used, so the editor copies
// the lead's onto the rest rather than letting a file disagree with what it
// draws.
export function syncGroupProps(lead: EdItem, members: readonly EdItem[]): void {
  for (const m of members) {
    if (m === lead) continue;
    m.kind = lead.kind;
    m.color = lead.color;
    m.opacity = lead.opacity;
    m.friction = lead.friction;
    m.force = lead.force;
  }
}

// --- chains -----------------------------------------------------------------

export function cloneChain(c: EdChain): EdChain {
  return { ...c, a: { ...c.a }, b: { ...c.b } };
}

// A world point pushed onto the item's own surface, returned in the item's local
// frame - where a chain anchor actually goes. A chain is bolted to a surface, so
// this is what clicking a body to anchor one means; it is also what the solver
// needs, since an anchor in a body's interior leaves the chain's span starting
// *inside* that body and the wrap generator resolves that as a self-intersection
// (see `snapToSurface` in level/chains.ts, which applies the same rule at load
// so a hand-edited file cannot author the degenerate case either).
export function nearestSurfaceLocal(item: EdItem, world: Vec2): Vec2 {
  const local = toLocal(item, world);
  if (item.shape.kind === "circle") return nearestOnCircle(item.shape.r, local);
  return nearestOnOutline(localVertices(item), local);
}

// Where a chain end currently sits in the world, or null if its item is gone.
export function chainEndWorld(model: EdModel, end: EdChainEnd): Vec2 | null {
  const item = model.items.find((i) => i.id === end.itemId);
  return item ? toWorld(item, end.local) : null;
}

// Both ends in the world, or null if either item is gone (a chain in that state
// is dropped on save and drawn as nothing).
export function chainEnds(model: EdModel, c: EdChain): { a: Vec2; b: Vec2 } | null {
  const a = chainEndWorld(model, c.a);
  const b = chainEndWorld(model, c.b);
  return a && b ? { a, b } : null;
}

// Distance from a world point to the chain's straight span, for picking. The
// editor draws a chain straight - how it drapes and what it wraps is a runtime
// answer the solver gives, and drawing a guess at it would be a drawing of
// something that is not the level.
export function distanceToChain(model: EdModel, c: EdChain, world: Vec2): number {
  const ends = chainEnds(model, c);
  if (!ends) return Infinity;
  const d = ends.b.sub(ends.a);
  const len2 = d.lengthSquared();
  if (len2 < 1e-12) return world.distanceTo(ends.a);
  const t = Math.min(1, Math.max(0, world.sub(ends.a).dot(d) / len2));
  return world.distanceTo(ends.a.add(d.mul(t)));
}

// A blank level: a single wide floor under a spawn point so it is immediately
// testable.
export function emptyModel(): EdModel {
  return {
    player: { pos: new Vec2(0, -1), radius: 0.08 },
    chains: [],
    items: [
      {
        id: newBodyId(),
        layer: "geometry",
        group: null,
        kind: "static",
        pos: new Vec2(0, 0),
        rot: 0,
        shape: { kind: "rect", w: 8, h: 0.6 },
        color: DEFAULT_BODY_COLOR,
        opacity: DEFAULT_BODY_OPACITY,
        friction: DEFAULT_SURFACE_FRICTION,
        force: 0,
        cam: defaultCamera(),
        note: defaultNote(),
      },
    ],
  };
}
