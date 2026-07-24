// Canonical, hand-editable level format — the single source of truth for the
// level schema, shared by the runtime loaders (`Level`, `BallLevel`) and the
// level editor. `levelData.ts` is auto-generated from a Godot scene and stays
// untouched; its narrower body-kind union is structurally assignable to this
// superset, so generated levels load through this format unchanged.
//
// Geometry is authored in Godot/scene pixels (as in the generated data); the
// simulation runs in metres. `scaleLevelData(data, PX)` converts on load and
// `scaleLevelData(data, PIXELS_PER_METER)` converts back for saving to disk.

// Body kinds a level can contain:
// - static:      immovable geometry the rope wraps and bodies collide with.
// - impermeable: static, but hooks are destroyed on contact instead of attaching.
// - killzone:    an Area2D that resets the level when the avatar enters it.
// - rigid:       a dynamic RigidBody2D (gravity + collisions), authored in place.
export type BodyKind = "static" | "impermeable" | "killzone" | "rigid";

export type ShapeData =
  | { kind: "rect"; w: number; h: number }
  | { kind: "circle"; r: number };

// Default shape appearance: dark grey fill at 0.5 opacity (borders always draw
// fully opaque in the same colour). Applied when a body omits color/opacity.
export const DEFAULT_BODY_COLOR = "#555555";
export const DEFAULT_BODY_OPACITY = 0.5;

export interface LevelBodyData {
  kind: BodyKind;
  x: number;
  y: number;
  rot: number;
  shape: ShapeData;
  // Optional appearance (hex colour + 0..1 fill opacity). Absent = the defaults.
  color?: string;
  opacity?: number;
}

export interface LevelData {
  player: { x: number; y: number; radius: number };
  bodies: LevelBodyData[];
}

// Scale every length by `factor` (pass PX = 1 / PIXELS_PER_METER on load, or
// PIXELS_PER_METER on save), leaving rotations and kinds untouched. Returns a
// fresh copy so the caller's data stays pristine.
export function scaleLevelData(data: LevelData, factor: number): LevelData {
  return {
    player: {
      x: data.player.x * factor,
      y: data.player.y * factor,
      radius: data.player.radius * factor,
    },
    bodies: data.bodies.map((b) => ({
      kind: b.kind,
      x: b.x * factor,
      y: b.y * factor,
      rot: b.rot,
      shape:
        b.shape.kind === "rect"
          ? { kind: "rect", w: b.shape.w * factor, h: b.shape.h * factor }
          : { kind: "circle", r: b.shape.r * factor },
      ...(b.color !== undefined ? { color: b.color } : {}),
      ...(b.opacity !== undefined ? { opacity: b.opacity } : {}),
    })),
  };
}
