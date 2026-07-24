// Editor scene model. Mirrors LevelData but keeps positions as Vec2 in WORLD
// METRES (so it shares the camera/pointer un-projection with the sim), plus a
// stable id per body for selection. Conversions to/from the on-disk pixel
// format live here, symmetric with the runtime loader.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import {
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
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
      },
    ],
  };
}
