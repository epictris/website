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
import { PIXELS_PER_METER, PX } from "../engine/units";
import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_OPACITY,
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  DEFAULT_NOTE_TEXT_SIZE,
  DEFAULT_SURFACE_FRICTION,
  DEFAULT_VIEWPORT_SCALE,
  NOTE_ARROW_THICKNESS,
  scaleLevelData,
  type BackgroundData,
  type BodyKind,
  type CameraRegionData,
  type LevelData,
  type NoteData,
} from "../level/levelFormat";

// Editor layers, in draw order (the list also stacks bottom-up in the toolbar):
// `background` is decoration behind the level, `geometry` the scene bodies,
// `camera` the camera-behaviour volumes and `notes` the authoring annotations
// (invisible in play).
export type EdLayer = "background" | "geometry" | "camera" | "notes";
export const ED_LAYERS: EdLayer[] = ["background", "geometry", "camera", "notes"];

export type EdShape =
  | { kind: "rect"; w: number; h: number }
  | { kind: "circle"; r: number };

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

// Is this item an arrow note? Arrows are the one item edited by their endpoints
// rather than by corner handles, so the test is shared by picking and drawing.
export function isArrowNote(item: EdItem): boolean {
  return item.layer === "notes" && item.note.kind === "arrow";
}

// The endpoints of an arrow note, in world metres: tail (local -X) to head.
export function arrowEnds(item: EdItem): { tail: Vec2; head: Vec2 } {
  const half = item.shape.kind === "rect" ? item.shape.w / 2 : item.shape.r;
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

export interface EdModel {
  player: { pos: Vec2; radius: number };
  items: EdItem[];
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

// Metre-space LevelData → editor model.
function fromLevelData(data: LevelData): EdModel {
  const bodies: EdItem[] = data.bodies.map((b) => ({
    id: newBodyId(),
    layer: "geometry",
    kind: b.kind,
    pos: new Vec2(b.x, b.y),
    rot: b.rot,
    shape:
      b.shape.kind === "rect"
        ? { kind: "rect", w: b.shape.w, h: b.shape.h }
        : { kind: "circle", r: b.shape.r },
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
    kind: "static", // unused on this layer; keeps the field total
    pos: new Vec2(g.x, g.y),
    rot: g.rot,
    shape:
      g.shape.kind === "rect"
        ? { kind: "rect", w: g.shape.w, h: g.shape.h }
        : { kind: "circle", r: g.shape.r },
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
    kind: "static", // unused on this layer; keeps the field total
    pos: new Vec2(r.x, r.y),
    rot: r.rot,
    shape:
      r.shape.kind === "rect"
        ? { kind: "rect", w: r.shape.w, h: r.shape.h }
        : { kind: "circle", r: r.shape.r },
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
  return {
    player: { pos: new Vec2(data.player.x, data.player.y), radius: data.player.radius },
    items: [...backgrounds, ...bodies, ...regions, ...notes],
  };
}

// Editor model → metre-space LevelData. Each layer writes its own list, and
// only the fields that layer gives meaning to.
export function toLevelData(model: EdModel): LevelData {
  const shapeOf = (i: EdItem) =>
    i.shape.kind === "rect"
      ? ({ kind: "rect", w: i.shape.w, h: i.shape.h } as const)
      : ({ kind: "circle", r: i.shape.r } as const);

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

  return {
    player: { x: model.player.pos.x, y: model.player.pos.y, radius: model.player.radius },
    bodies: model.items
      .filter((i) => i.layer === "geometry")
      .map((b) => ({
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
      })),
    // An empty list is the same as no list, and the absent field keeps levels
    // authored before backgrounds (or camera regions, or notes) byte-identical.
    ...(backgrounds.length ? { backgrounds } : {}),
    ...(cameraRegions.length ? { cameraRegions } : {}),
    ...(notes.length ? { notes } : {}),
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

// Half-extents of an item's (unrotated) bounding box, i.e. centre → top-left.
export function halfExtents(item: EdItem): Vec2 {
  return item.shape.kind === "circle"
    ? new Vec2(item.shape.r, item.shape.r)
    : new Vec2(item.shape.w / 2, item.shape.h / 2);
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
  // A box is the convex hull of its corners, so all four corners inside is
  // exactly "the whole box is inside" — rotation included.
  const h = halfExtents(item);
  const corners = [
    new Vec2(-h.x, -h.y),
    new Vec2(h.x, -h.y),
    new Vec2(h.x, h.y),
    new Vec2(-h.x, h.y),
  ];
  return corners.every((c) => {
    const w = toWorld(item, c);
    return w.x >= min.x && w.x <= max.x && w.y >= min.y && w.y <= max.y;
  });
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
  return Math.abs(l.x) <= item.shape.w / 2 && Math.abs(l.y) <= item.shape.h / 2;
}

// A blank level: a single wide floor under a spawn point so it is immediately
// testable.
export function emptyModel(): EdModel {
  return {
    player: { pos: new Vec2(0, -1), radius: 0.08 },
    items: [
      {
        id: newBodyId(),
        layer: "geometry",
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
