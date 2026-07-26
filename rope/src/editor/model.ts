// Editor scene model. Mirrors LevelData but keeps positions as Vec2 in WORLD
// METRES (so it shares the camera/pointer un-projection with the sim), plus a
// stable id per body for selection. Conversions to/from the on-disk pixel
// format live here, symmetric with the runtime loader.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import {
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  DEFAULT_SURFACE_FRICTION,
  scaleLevelData,
  type BodyKind,
  type LevelData,
} from "../level/levelFormat";

export type EdShape =
  | { kind: "rect"; w: number; h: number }
  | { kind: "circle"; r: number };

export interface EdBody {
  id: number;
  kind: BodyKind;
  pos: Vec2; // metres
  rot: number; // radians
  shape: EdShape; // metres
  color: string; // hex fill colour
  opacity: number; // 0..1 fill opacity (border draws fully opaque)
  friction: number; // surface friction, 0 (ice) .. 1 (rubber)
  force: number; // force areas only: m/s² along the body's rotation
}

export interface EdModel {
  player: { pos: Vec2; radius: number };
  bodies: EdBody[];
}

let nextId = 1;
export function newBodyId(): number {
  return nextId++;
}

// --- conversions ------------------------------------------------------------

// Metre-space LevelData → editor model.
function fromLevelData(data: LevelData): EdModel {
  return {
    player: { pos: new Vec2(data.player.x, data.player.y), radius: data.player.radius },
    bodies: data.bodies.map((b) => ({
      id: newBodyId(),
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
    })),
  };
}

// Editor model → metre-space LevelData.
export function toLevelData(model: EdModel): LevelData {
  return {
    player: { x: model.player.pos.x, y: model.player.pos.y, radius: model.player.radius },
    bodies: model.bodies.map((b) => ({
      kind: b.kind,
      x: b.pos.x,
      y: b.pos.y,
      rot: b.rot,
      shape:
        b.shape.kind === "rect"
          ? { kind: "rect", w: b.shape.w, h: b.shape.h }
          : { kind: "circle", r: b.shape.r },
      color: b.color,
      opacity: b.opacity,
      friction: b.friction,
      // Only force areas carry a magnitude; omitting it elsewhere keeps saved
      // levels free of a field that would read as meaningful.
      ...(b.kind === "force" ? { force: b.force } : {}),
    })),
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

// Half-extents of a body's (unrotated) bounding box, i.e. centre → top-left.
export function halfExtents(body: EdBody): Vec2 {
  return body.shape.kind === "circle"
    ? new Vec2(body.shape.r, body.shape.r)
    : new Vec2(body.shape.w / 2, body.shape.h / 2);
}

// Axis-aligned bounds of a group of bodies, from their unrotated extents (the
// same approximation `halfExtents` gives snapping). Empty group → a zero box.
export function groupBounds(bodies: readonly EdBody[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of bodies) {
    const h = halfExtents(b);
    minX = Math.min(minX, b.pos.x - h.x);
    minY = Math.min(minY, b.pos.y - h.y);
    maxX = Math.max(maxX, b.pos.x + h.x);
    maxY = Math.max(maxY, b.pos.y + h.y);
  }
  if (!bodies.length) return { min: Vec2.ZERO, max: Vec2.ZERO };
  return { min: new Vec2(minX, minY), max: new Vec2(maxX, maxY) };
}

// Does a body overlap an axis-aligned world rect (min/max sorted)? Touch
// semantics — any overlap counts, so a rubber-band need not enclose a body.
export function bodyIntersectsRect(body: EdBody, min: Vec2, max: Vec2): boolean {
  if (body.shape.kind === "circle") {
    // Closest point on the rect to the centre.
    const cx = Math.min(Math.max(body.pos.x, min.x), max.x);
    const cy = Math.min(Math.max(body.pos.y, min.y), max.y);
    return body.pos.distanceTo(new Vec2(cx, cy)) <= body.shape.r;
  }
  // SAT between the rect (world axes) and the body's rotated box: four axes,
  // the two world ones and the body's own.
  const ha = max.sub(min).mul(0.5);
  const hb = halfExtents(body);
  const d = body.pos.sub(min.add(max).mul(0.5));
  const c = Math.abs(Math.cos(body.rot));
  const s = Math.abs(Math.sin(body.rot));
  if (Math.abs(d.x) > ha.x + hb.x * c + hb.y * s) return false;
  if (Math.abs(d.y) > ha.y + hb.x * s + hb.y * c) return false;
  const dl = d.rotated(-body.rot);
  if (Math.abs(dl.x) > hb.x + ha.x * c + ha.y * s) return false;
  if (Math.abs(dl.y) > hb.y + ha.x * s + ha.y * c) return false;
  return true;
}

// A point in the body's local (unrotated) frame, origin at the body centre.
export function toLocal(body: EdBody, world: Vec2): Vec2 {
  return world.sub(body.pos).rotated(-body.rot);
}

export function toWorld(body: EdBody, local: Vec2): Vec2 {
  return body.pos.add(local.rotated(body.rot));
}

// Is a world point inside the body's shape?
export function pointInBody(body: EdBody, world: Vec2): boolean {
  if (body.shape.kind === "circle") return world.distanceTo(body.pos) <= body.shape.r;
  const l = toLocal(body, world);
  return Math.abs(l.x) <= body.shape.w / 2 && Math.abs(l.y) <= body.shape.h / 2;
}

// A blank level: a single wide floor under a spawn point so it is immediately
// testable.
export function emptyModel(): EdModel {
  return {
    player: { pos: new Vec2(0, -1), radius: 0.08 },
    bodies: [
      {
        id: newBodyId(),
        kind: "static",
        pos: new Vec2(0, 0),
        rot: 0,
        shape: { kind: "rect", w: 8, h: 0.6 },
        color: DEFAULT_BODY_COLOR,
        opacity: DEFAULT_BODY_OPACITY,
        friction: DEFAULT_SURFACE_FRICTION,
        force: 0,
      },
    ],
  };
}
