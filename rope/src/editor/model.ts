import { mushroomCapCentre, mushroomOutline, mushroomParameters, type MushroomParameters } from "../level/mushroom";
import mushroomVariants from "../level/mushroomVariants.json";
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
import { soundMaterialOf, type SoundMaterial } from "../lib/soundMaterial";
import type { StarberrySettings } from "../level/starberry";
import { MANACLE_BORE } from "../lib/manacle";
import { strokeCurve } from "../lib/stroke";
import {
  isConvexLoop,
  nearestOnCircle,
  nearestOnOutline,
  polyCentroid,
  polySignedArea2,
  type BeltLoop,
} from "../engine/shapes";
import { outlineOfData } from "../render/shapePath";
import { beltLoopOf } from "../render/beltTread";
import { beltRunQuads } from "../lib/belt";
import {
  isSimpleLoop,
  loopContainsPoint,
  segmentsIntersect,
} from "../lib/polygon";
import { PIXELS_PER_METER, PX } from "../engine/units";
import {
  PATH_FLATTEN_STEP,
  buildPolylineIndex,
  flattenPath,
  projectOntoPolyline,
  type PathNode,
} from "../lib/path";
import { PATH_KEY_FIELDS, type PathKeyField } from "../render/cameraController";
import { catenaryPolyline } from "../level/catenary";
import { restingSpanPath } from "../level/vines";
import { buildMoveRoute, moveAngleAt, type MoveRoute } from "../level/movers";
import { DEFAULT_SPRING_DAMPING, buildLevelBodies, worldPlacement } from "../level/buildBodies";
import {
  compileLevel,
  compose2D,
  compose3D,
  enclosesShape,
  findNode,
  frameOf,
  invert3D,
  poseOf,
  poseOfFrame,
  relative2D,
  scaleLevelTree,
  TREE_FORMAT,
  upgradeTree,
  walkNodes,
  SUN_FIELDS,
  ENVIRONMENT_FIELDS,
  type LevelNode,
  type LevelTree,
  type NodeFormationGuide,
  type NodeRootBranch,
  type NodeType,
  type Pose3D,
  newNodeId,
  expandInstances,
  prefabLibrary,
  prefabsAt,
  PREFAB_ROCK_RECIPE,
  formationDataOf,
  lookNodes,
  scaleGeometry,
} from "../level/nodes";
import { ancestors, bodyAbove, canParent, childrenOf, descendants, freeName, isBodyType, nextOrder, removeSubtree, reparent, treeOf, type EdBody, type EdNode, type EdTree } from "./tree";
import { World } from "../engine/world";
import { wrapAngle } from "../engine/mathf";
import { MASK_ALL, RigidBody2D } from "../engine/body";
import {
  CUSTOM_MATERIAL,
  DEFAULT_DENSITY,
  DEFAULT_MATERIAL,
  DEFAULT_THICKNESS,
  MATERIALS,
  pieceDensity,
  prismMass,
  type MaterialName,
} from "../lib/shapeGeometry";
import {
  DEFAULT_BODY_COLOR,
  type FogRegionData,
  DEFAULT_FOG_FALLOFF,
  DEFAULT_BODY_OPACITY,
  DEFAULT_NOTE_TEXT_SIZE,
  DEFAULT_BOUNCE,
  DEFAULT_LAUNCH,
  DEFAULT_SURFACE_FRICTION,
  DEFAULT_VIEWPORT_SCALE,
  NOTE_ARROW_THICKNESS,
  maskFromPasses,
  passesFromMask,
  moveModeCloses,
  moveModeOf,
  moveNodesOf,
  scaleLevelData,
  scaleNormalized,
  loadLevelTree,
  isLightObject,
  isAreaKind,
  type LevelSource,
  type CameraPathVert,
  type CollisionObjectData,
  type FormationGuide,
  type BodyKind,
  type MoveEase,
  movePeakFactor,
  type MoveMode,
  type CameraPathData,
  type ShelterData,
  type CameraRegionData,
  type ChainData,
  type VineData,
  type EnvironmentData,
  type LevelMetaData,
  type LevelData,
  type RawLevelData,
  type LevelBodyData,
  type LightObjectData,
  type RootBranchData,
  type SceneObjectData,
  hasBearing,
  isCollisionObject,
  isAnchorObject,
  isModelObject,
  type ModelObjectData,
  type CheckpointData,
  type LevelCameraData,
  type NoteData,
  type ShapeData,
  type BeltLook,
  type DebugDrawData,
  type FormationData,
  type DecorationObjectData,
  type PaintStamp,
  isDecorationObject,
  LEVEL_FORMAT,
} from "../level/levelFormat";
import {
  DEFAULT_FILL_INTENSITY,
  DEFAULT_GROUND_FILL,
  DEFAULT_SKY,
  DEFAULT_SKY_FILL,
  DEFAULT_SUN_COLOR,
  DEFAULT_SUN_DIR,
  DEFAULT_SUN_INTENSITY,
  ENV_INTENSITY,
} from "../render3d/environment";
import {
  DEFAULT_LIGHT_COLOR,
  DEFAULT_LIGHT_INTENSITY,
  DEFAULT_LIGHT_RANGE,
  DEFAULT_LIGHT_Z,
  DEFAULT_SPOT_ANGLE,
  DEFAULT_SPOT_PENUMBRA,
} from "../render3d/lights";

// Editor layers, in draw order (the list also stacks bottom-up in the toolbar):
// `scene` is the level's bodies, `camera` the camera-behaviour volumes and
// `notes` the authoring annotations (invisible in play).
//
// There is deliberately NO decoration layer, and no drawn shape at all: what a
// level LOOKS like is what its bodies carry - formations, the decorations
// grown on them, models (docs/formations.md, docs/blender-models.md). The
// editor authors what the game simulates and lights.
//
// `lights` is the level's own light sources (see `LightData`). It is a layer
// rather than a property of a body because a light is not a piece of stuff: it
// has no collision, no mass and no surface, it is placed where the lamp SHINES
// from rather than where the lamp is, and a shaft coming down through a grate
// has no geometry at all. It is the same argument the camera layer is built on,
// and it earns the same thing - a light is drawn, picked, dragged, rubber-banded,
// duplicated, nudged and undone by exactly the code every wall goes through.
// The editor's layers. `scene` is the level itself - everything that is drawn
// in play and lives in a body - and the other two are authoring furniture.
//
// Geometry and lights used to be two layers, and merging them is the same
// correction as everything else here: a light is not a KIND OF LAYER, it is a
// scene object like a shape, and it belongs to a body exactly as a shape does.
// Two layers made that impossible to see - a lamp's fitting and its light sat on
// different layers, so one could be hidden or locked without the other, and
// welding them into a body meant a cross-layer selection. What distinguishes
// them is `EdItem.object`, which is what the FORMAT distinguishes them by.
//
// A `fireflies` layer held the firefly paths until fireflies were removed on
// 2026-11-26.
//
// Shelters and fog were layers of their own until 2026-11-26, and they went
// for the reason lights did: a fog region is not a KIND OF LAYER, it is a
// thing in the level (a `FogRegion2D` node owning its fog), and so is a
// shelter (a `Shelter2D`). They are scene objects (`EdObject` "fog" and
// "shelter"), added with their own tools or the scene tree's `+`.
export type EdLayer = "scene" | "camera" | "notes";
export const ED_LAYERS: EdLayer[] = ["scene", "camera", "notes"];

// A SHELTER's own fields (`ShelterData`), on every item and read only on a
// shelter object, as `cam` is read only on the camera layer. null = the
// format's default (DEFAULT_SHELTER_FRONT).
export interface EdShelter {
  front: number | null; // metres in front of the gameplay plane
}
export const defaultShelter = (): EdShelter => ({ front: null });

// A FOG region's own fog (`FogRegionData`), on every item and read only on a
// fog object. null = absent: the default falloff (DEFAULT_FOG_FALLOFF), no
// fog, and the background's colour.
export interface EdFog {
  falloff: number | null; // metres inward from the edge to full fog
  amount: number | null; // the fraction a surface 20 m away takes on
  color: string | null;
}
export const defaultFog = (): EdFog => ({ falloff: null, amount: null, color: null });
// What a fog region drawn in the editor starts as: a haze worth seeing, in
// the air's own blue-grey, so a fresh region is not an empty box.
export const NEW_FOG: EdFog = { falloff: null, amount: 0.3, color: "#2a5075" };

// What KIND of scene object an item is - the SAME set the format has, and one
// editor item per authored object.
//
// `anchor` joined last and is the smallest of them: a point on a body that a
// chain end ties to (`AnchorObjectData`). It is an item rather than a pair of
// numbers on the chain for the same reason - a chain end is a thing on a body,
// so it rides that body, shows up in the outliner, and is dragged like anything
// else instead of only being reachable by grabbing the rope.
//
// `model` is a 3D model of the library placed on the body (`ModelObjectData`):
// appearance only, carried by the body like its lights. Its fields are
// `modelRef`; its shape is the marker box a click lands on, as an anchor's is.
//
// `formation` is the body's generated rock (`FormationData`, docs/formations.md):
// at most one per body, its recipe and guide in `formation`, its placement the
// item's own, so it rides the body exactly as a model does and stays where it
// stands when the body's origin moves. Its shape is the marker a click on the
// plane lands on; in 3D a click on the rock picks it.
//
// `decoration` is moss, ivy or a plant grown on the body's formation
// (`DecorationObjectData`): its fields in `decoration`, its strokes (a painted
// one's) there too, saved beside the level rather than in it. Its anchor is in
// the formation's frame, so its `pos` is only where its mark is drawn on the
// plane, found from the formation item whenever it is needed.
//
// `fog` and `shelter` are the plane's two volumes that are things in the level
// rather than authoring furniture: a fog region (`FogRegion2D`, its fog in
// `fog`) and a cave's front wall (`Shelter2D`, its fields in `shelter`). Never
// in a body.
export type EdObject = "collision" | "light" | "anchor" | "model" | "formation" | "decoration" | "fog" | "shelter";

// A DECORATION object's own fields, and a painted one's strokes. Replaced
// whole on an edit, as a formation's are.
export type EdDecoration = Omit<DecorationObjectData, "type" | "x" | "y" | "rot"> & { strokes?: PaintStamp[] };

// A FORMATION object's own fields: the level's `FormationData` less its
// placement, which is the item's. On every item, read only on one whose
// `object` is "formation"; replaced whole on an edit, never mutated, since an
// undo snapshot or a copy shares it.
export type EdFormation = Omit<FormationData, "x" | "y" | "rot">;

// A MODEL object's own fields (`ModelObjectData`), metres and radians. On every
// item, read only on one whose `object` is "model", as `light` is read only on
// a light. `name` is the library's model; the placement (`pos`, `rot`) is the
// item's own, as every object's is.
export interface EdModelRef {
  mushroom?: MushroomParameters;
  name: string;
  z: number;
  rotX: number;
  rotY: number;
  scale: number;
}
export const defaultModelRef = (): EdModelRef => ({ name: "", z: 0, rotX: 0, rotY: 0, scale: 1 });
// The smallest size a model may be given, so no drag or typed value draws it
// at nothing (or inside out); `cli levels` holds the file to a positive one.
export const MODEL_MIN_SCALE = 0.01;

// `poly` vertices are metres in the item's own local frame, kept a **simple**
// outline (one that never crosses itself) - `setPolyVerts` is the one writer, so
// no edit path can leave that invariant broken. Simple rather than convex: a
// concave outline is cut into convex pieces by the loader (see "Convex-only
// polygons; compound bodies" in docs/game-design.md and `polyMustBeConvex`
// below, which holds a camera region to the older, stricter rule).
//
// They are NOT kept centred on their centroid. The origin is the placement the
// author gave the shape and a corner edit leaves it alone (see `setPolyVerts`);
// `centreShapeOrigin` puts it on the centroid once, when the shape is drawn, and
// `shapeCentre` is where "and where is its mass" is answered from the outline.
//
// `path` is an OPEN curve, permitted only on the camera layer: a camera path
// (see `CameraPathData`). It is not a degenerate polygon - it has no inside, no
// area and no winding, and its node ORDER is its direction of travel, which is
// the one thing about it that carries meaning. `setPathNodes` is its writer,
// and it leaves the origin alone exactly as a polygon's does; the node average
// is what `centreShapeOrigin` places that origin at when the curve is drawn, a
// curve having no area centroid.
//
// `verts` is the points the route passes through and `handles` the cubic Bézier
// tangents at each, as offsets, ONE PER VERT and kept exactly that long by the
// writer. Two arrays rather than one array of nodes because every shared helper
// here - bounds, hit-testing, the transform, the vertex handles - wants the
// points and nothing else, and `localVertices` is what hands them over.
// Both handles zero is a corner, which is what every vert of a freshly drawn
// path is.
//
// `keys` are the nodes' keyframes (see `CameraPathVert`), a third parallel
// array kept ONE PER VERT by the same writer: a node's keys are the node's
// exactly as its tangents are, and every renumbering - a deletion, an
// insertion, a reversal - carries them by the same indices. Parallel rather
// than folded into the handle record so `Smooth` and `Sharpen`, which rebuild
// every handle from the geometry, cannot drop a key by rebuilding it.
export type EdShape =
  | { kind: "rect"; w: number; h: number }
  | { kind: "circle"; r: number }
  | { kind: "poly"; verts: Vec2[] }
  | {
      kind: "path";
      verts: Vec2[];
      handles: { in: Vec2; out: Vec2 }[];
      keys: EdPathKey[];
      // How wide the BAR is, for a path on the scene layer - a collision curve,
      // stroked into the pieces it collides as (`ShapeData`'s `curve`). A
      // camera path is a line with no thickness and ignores it; the field is
      // carried anyway rather than made optional, so every path is a
      // well-formed one and nothing has to ask which layer it is on to know
      // whether it may be read.
      width: number;
      // The width at its LAST node, for a tapered curve (`ShapeData`'s
      // `curve.tip`) - a root branch narrowing from `width` at its base.
      // Absent is a bar of one width.
      tip?: number;
    }
  // A CONVEYOR (`ShapeData`'s `belt`, docs/conveyors.md): a band `thickness`
  // deep round the outside of two or more wheels. Each wheel is a centre `c` in
  // the item's frame and its own radius `r`; wheel 0 is at the origin, the
  // item's own `pos`, so the ordinary move gesture places the belt, and every
  // other wheel's centre is a grip dragged like a path vertex. `speed` is the
  // signed surface speed in m/s (positive turns the loop clockwise on screen).
  // `look` is how the band is drawn (`BeltLook`, its `width` in metres): the
  // game draws a belt's band itself, since its surface runs. Scene layer only.
  | { kind: "belt"; wheels: EdWheel[]; thickness: number; speed: number; look: BeltLook };

// One wheel of an editor belt: its centre in the item's frame and its radius,
// metres. Replaced wholesale by `setBelt`, never mutated in place, so an undo
// snapshot that shares one is not rewritten by the edit it exists to undo.
export interface EdWheel {
  readonly c: Vec2;
  readonly r: number;
}

// Where a root branch grows from, in the editor (`RootBranchData` on disk): the
// ITEM it grows out of - an item id, where the file holds an index into the
// body's objects - or null for a trunk, and how far along that item's
// centreline it sprouts, a fraction of its arc length. The branch's own first
// node is kept on that point by `syncRoots` (rootEditing.ts) after every edit.
export interface EdRoot {
  readonly parent: number | null;
  readonly at: number;
  bark?: RootBranchData["bark"];
  // Where the branch bends (`RootBranchData.bends`), fractions of its arc
  // length with their springs.
  bends?: RootBranchData["bends"];
}

// What a curve drawn in the editor starts out as: a bar the manacle's own ring
// closes around (`MANACLE_BORE`), which is the bar a rail is for.
export const DEFAULT_CURVE_WIDTH = MANACLE_BORE;

// One node's keyframes: null = this node does not key that field. Metres for
// the lengths, as everything in the model is.
export type EdPathKey = Record<PathKeyField, number | null>;

// One node of a body's travel route (see `EdItem.route` and
// `LevelBodyData.moveNodes`): the point, its two cubic tangent handles as
// offsets from it, and its keys.
//
// A record per node rather than the camera path's three parallel arrays, and the
// difference is what the two are edited BY. A camera path is an `EdShape`, so
// its points go through `localVertices`, `setPathVerts`, the vertex handles and
// the resize gizmo - every one of which wants the points and nothing else, and
// the parallel arrays are what hands them over. A route is not a shape: nothing
// generic ever walks it, its own gestures are the only writers, and a record is
// then the form that cannot lose a key by renumbering one array and not another.
//
// `p` is in the body's own frame and node zero's is always `Vec2.ZERO` - it IS
// the body. `rot` is an angle offset in radians and `speed` is metres per
// second; null on either is a node that does not key it.
export interface EdRouteNode {
  p: Vec2;
  in: Vec2;
  out: Vec2;
  rot: number | null;
  speed: number | null;
}

export const routeNode = (p: Vec2): EdRouteNode => ({
  p,
  in: Vec2.ZERO,
  out: Vec2.ZERO,
  rot: null,
  speed: null,
});

export const cloneRouteNode = (n: EdRouteNode): EdRouteNode => ({ ...n });

// Does this route node key anything at all? What the canvas draws a diamond for,
// the same mark and the same question a camera path's `isKeyed` asks.
export function isRouteKeyed(n: EdRouteNode): boolean {
  return n.rot !== null || n.speed !== null;
}

export const NO_KEY = (): EdPathKey => {
  const k = {} as EdPathKey;
  for (const f of PATH_KEY_FIELDS) k[f] = null;
  return k;
};

// Does this node key anything at all? What the editor and the overlay draw a
// diamond for.
export function isKeyed(k: EdPathKey | undefined): boolean {
  return k !== undefined && PATH_KEY_FIELDS.some((f) => k[f] !== null);
}

// Camera-layer properties (see CameraRegionData for the semantics). `lockX/Y`
// null = that axis follows the avatar; `buffer` null = the controller's
// default. (`blend` was here and is retired with the hand-off clock - the
// format drops it at its one gate, so a file that authored one loads and the
// editor rewrites it without.)
export interface EdCamera {
  offset: Vec2; // metres
  viewportScale: number;
  lockX: number | null; // metres
  lockY: number | null; // metres
  buffer: number | null; // metres; null = the controller's REGION_EXIT_MARGIN
  // Per-side overrides of `buffer`, in the region's own frame (left/right = ∓x,
  // top/bottom = ∓y). Rect regions only - a circle has no sides and a polygon
  // grows as an offset - and null = fall back to `buffer`.
  bufferLeft: number | null;
  bufferRight: number | null;
  bufferTop: number | null;
  bufferBottom: number | null;
  // How far INSIDE the region its influence fades to nothing, in metres - the
  // band two rooms at the same priority blend across. Region only; null = 0, a
  // region at full strength out to its own walls. (A path's band is
  // `falloffX/falloffY` below and points outward instead, the polyline being
  // the middle of its claim rather than the edge.)
  falloff: number | null;
  priority: number;
  // Whether the screen-edge guarantee holds while this region frames the camera
  // (see `CameraRegionData.keepInFrame`). Region only; true on a path.
  keepInFrame: boolean;
  // Camera PATH fields (see `CameraPathData`), meaningless on a region and left
  // null there. null = the format's DEFAULT_PATH_RANGE_X/_Y / _LOOKAHEAD.
  // Per axis, because the frame is 16:9: the corridor is the ellipse with
  // these semi-axes around the route, so it is screen-shaped.
  rangeX: number | null; // metres
  rangeY: number | null; // metres
  // How far past the range the path lets go gradually, per axis through the
  // same ellipse; null = DEFAULT_PATH_FALLOFF_X/_Y.
  falloffX: number | null; // metres
  falloffY: number | null; // metres
  // Per axis, because the frame is 16:9 (see DEFAULT_PATH_LOOKAHEAD_X/_Y).
  lookaheadX: number | null; // metres
  lookaheadY: number | null; // metres
  // Slack in where that lead is measured from, so a swing does not slosh the
  // camera (see DEFAULT_PATH_LOOKAHEAD_BUFFER_X/_Y). null = those defaults.
  lookaheadBufferX: number | null; // metres
  lookaheadBufferY: number | null; // metres
  // How far off the route two places on it count as comparable to the soft
  // projection (see DEFAULT_PATH_SOFTNESS). null = that default.
  softness: number | null; // metres
  // Seconds of warning the lead is stretched by at the speed the player is
  // travelling (see DEFAULT_PATH_REACTION). null = that default.
  reactionTime: number | null; // seconds
  // How far along the route a hanging avatar winds up their line before the
  // camera's vertical lock lets go (see DEFAULT_PATH_WIND_BUFFER). null = that
  // default.
  windBuffer: number | null; // metres
}

// Lights-layer properties (see LightData for the semantics).
//
// Two of a light's fields deliberately live OUTSIDE this object, on the item
// itself, because the item already has them and a second copy could disagree
// with what is drawn:
//
// - its RANGE is the item's `shape`, a circle of exactly that radius. A light's
//   reach is the one thing about it with a size and a place on the canvas, so
//   making it the shape means the radius handle authors it, the rubber band
//   catches what it covers, and the ring on screen is the volume rather than a
//   drawing of it.
// - its COLOUR is the item's `color`, which the geometry layer already authors
//   and the other two layers leave as fixed furniture.
export interface EdLight {
  kind: "point" | "spot";
  intensity: number; // candela, against metres (see LightData - never scaled)
  z: number; // metres off the gameplay plane, positive toward the camera
  angle: number; // degrees, spot half-angle
  penumbra: number; // 0..1
  dir: Vec2; // spot aim in the sim's frame (x right, y down); need not be unit
  dirZ: number; // ...and its component toward the camera
  castShadow: boolean;
  // Shadow camera near plane in metres, or null for the renderer's default.
  // Authored past a surrounding fitting's radius so a lantern does not shadow
  // its own light - see `LightObjectData.shadowNear`.
  shadowNear: number | null;
  // Shadow edge softness in shadow-map texels, or null for the renderer's
  // default - see `LightObjectData.shadowRadius`.
  shadowRadius: number | null;
  flicker: number; // 0 (steady) .. 1 (guttering)
  // Spot only: how visible the lit air in the cone is, and how thick the dust
  // in it, both 0..1 (see `LightObjectData.beam` / `.dust`).
  beam: number;
  dust: number;
  // Point only: a WAKING light (see `LightObjectData.wake`). `wake` in metres,
  // 0 = always on; the three times in seconds, null = the renderer's default
  // (`DEFAULT_WAKE_RISE` / `DEFAULT_WAKE_FALL`, and no delay).
  wake: number;
  wakeDelay: number | null;
  wakeRise: number | null;
  wakeFall: number | null;
}

// Notes-layer properties (see NoteData, CheckpointData). A note is always a
// rect: for a text note the box holds the wrapped text, for an arrow it is the
// segment's length and pick band, and for a checkpoint it is the marker ring the
// spawn is drawn as.
//
// A CHECKPOINT is on this layer rather than on one of its own because it is the
// same kind of thing the layer already holds: authoring furniture, drawn only in
// the editor and never seen in play. What separates it from the two annotations
// beside it is that a name here can be ASKED FOR (`?checkpoint=NAME` moves the
// spawn to it), so it is written to `LevelData.checkpoints` rather than to
// `notes` - the layer is what a thing is edited as, and the list it is written
// to is what the game does with it.
//
// `text` is its NAME, which is the same field doing the same job: the one piece
// of prose a notes-layer item carries, edited in the same panel and placed with
// the same caret-in-the-box gesture.
export interface EdNote {
  kind: "text" | "arrow" | "checkpoint";
  text: string;
  size: number; // metres, glyph height (text notes)
}

// A piece's debug geometry (see `DebugDrawData`), in the model's always-present
// spelling: `on` is the switch, and a null setting is the fallback the format's
// absent one is - the body's colour, the piece's own thickness.
export interface EdDebug {
  on: boolean;
  color: string | null;
  opacity: number; // 0..1
  depth: number | null; // metres
}

export const NO_DEBUG = (): EdDebug => ({ on: false, color: null, opacity: 1, depth: null });

export function edDebug(d: DebugDrawData | undefined): EdDebug {
  if (!d) return NO_DEBUG();
  return {
    on: d.on === true,
    color: d.color ?? null,
    opacity: typeof d.opacity === "number" ? Math.min(1, Math.max(0, d.opacity)) : 1,
    depth: typeof d.depth === "number" && d.depth > 0 ? d.depth : null,
  };
}

// The on-disk form, or undefined for a piece that is off and configures
// nothing - so every level authored before debug geometry stays byte-identical.
export function debugData(d: EdDebug): DebugDrawData | undefined {
  if (!d.on && d.color === null && d.opacity >= 1 && d.depth === null) return undefined;
  return {
    on: d.on,
    ...(d.color !== null ? { color: d.color } : {}),
    ...(d.opacity < 1 ? { opacity: d.opacity } : {}),
    ...(d.depth !== null ? { depth: d.depth } : {}),
  };
}

// A root branch's on-disk form (`RootBranchData`), its parent's item id turned
// into the index that item is written at among `run`, the body's members in
// the order `toLevelData` writes them.
// A bend's own fields and nothing else, read from disk: a bend that still
// carries a retired one (`limit`, a stop removed 2026-11-01) loses it with
// the next save.
function bendFields(k: NonNullable<RootBranchData["bends"]>[number]): NonNullable<RootBranchData["bends"]>[number] {
  return {
    at: k.at,
    ...(k.freq !== undefined ? { freq: k.freq } : {}),
    ...(k.damping !== undefined ? { damping: k.damping } : {}),
  };
}

function rootData(r: EdRoot, run: readonly EdItem[]): RootBranchData {
  const parent = r.parent === null ? -1 : run.findIndex((m) => m.id === r.parent);
  return {
    ...(parent < 0 ? {} : { parent, at: r.at }),
    ...(r.bark ? { bark: r.bark } : {}),
    ...(r.bends !== undefined && r.bends.length > 0 ? { bends: r.bends.map((k) => ({ ...k })) } : {}),
  };
}

export interface EdItem {
  id: number;
  layer: EdLayer;
  // What kind of scene object this is. Only meaningful on the `scene` layer;
  // camera regions and notes carry "shape" and never read it.
  object: EdObject;
  // THE NODE THIS ITEM IS (plans/node-tree.md): every item is the payload of
  // one node of the level's tree (`EdModel.tree`) - a collision shape, an
  // anchor, a light, a model, a rock, a decoration, a volume or a note - and
  // the node is what is selected, named, grouped, layered and parented.
  node: string;
  // The nearest BODY above that node, and its properties: what this item
  // collides as, if it collides, and what carries it. Derived from the tree
  // (`relink`), held here because nearly everything that reads an item asks
  // it. The properties are the body node's own object, shared by every item
  // under it, so a body's friction is one number however many pieces it has.
  // Null for an item no body carries: a rock or a lamp standing on its own,
  // a camera region, a note.
  bodyOf: string | null;
  body: EdBody | null;
  // What this item moves and is picked as ONE THING with: its body's node,
  // or its own node when no body carries it. The editor's gestures and panels
  // that act on "the body this piece is in" act on this (`relink` keeps it).
  unit: string;
  pos: Vec2; // metres, world
  rot: number; // radians, world
  // A 3D node's depth (metres, toward the camera) and tilt about x then y
  // (radians, before the turn in the plane): a rock standing off the plane.
  // Zero for everything in it.
  z: number;
  tilt: [number, number];
  shape: EdShape; // metres
  // The fill of a 2D item that is not in a body (camera regions, notes and
  // the like take the fixed editor-furniture colours) and a light's colour.
  // A collision piece is filled with its BODY's colour (`fillOf`).
  color: string; // hex fill colour
  opacity: number; // 0..1 fill opacity (a body's border draws fully opaque)
  // There is no body depth here, and none on a collision item either: a body is
  // a thing in the gameplay plane and so is the shape it collides as (see
  // `LevelBodyData`). Depth is a light's `z`, and a water body's slab below.
  // Hook-proof (see `LevelBodyData.impermeable`): still solid, but the grapple
  // hook is destroyed on it and the ball's is deflected. Per SHAPE, not a
  // property of the body node (`EdBody`) - a compound wall with one
  // attachable ledge among hook-proof faces is what it is for.
  impermeable: boolean;
  // What this piece collides with (see `CollisionObjectData.passes`), as the
  // engine's own bitmask. `MASK_ALL` - everything - is the default and what
  // every piece authored before masks existed loads as; the inspector's
  // "collides with" group is the three bits a level may clear.
  //
  // Per SHAPE like `impermeable`, and the cases it exists for are one body
  // whose pieces answer differently: a wheel whose rim the player turns and
  // whose hub winds the chain, a stool whose seat stops the avatar and whose
  // legs, set back in z to either side of the gameplay plane, are geometry he
  // walks between and the chain hangs past.
  mask: number;
  // A rail (see `CollisionObjectData.rail`): a thin bar the manacle clamps
  // around and slides along. Per SHAPE like the two above, and mutually
  // exclusive with `impermeable` in the inspector - a hook-proof rail is a bar
  // the hook bounces off and never clamps.
  rail: boolean;
  // Viscosity (see `CollisionObjectData.viscosity`): 0 is an ordinary face,
  // anything above it is mud the manacle bites and then creeps through under
  // the chain's pull, dropping out once its mouth has crept clear - 1 the
  // reference mud, 2 twice as stiff. Per SHAPE like the three above, and
  // mutually exclusive with `impermeable` in the inspector - a hook-proof mud
  // face is a face the hook never bites.
  viscosity: number;
  // The viscous face's slip floor (see `CollisionObjectData.slipFloor`),
  // newtons: 0 creeps under any pull, above it the mud holds still until the
  // pull exceeds it. Meaningless while `viscosity` is 0, and not written then.
  slipFloor: number;
  // What the shape is made of, and how thick it is through z - the dimension
  // the 2D view cannot show (see `LevelBodyData.material` / `thickness`). Per
  // SHAPE, not properties of the body node (`EdBody`): a compound body's mass, centre of mass and inertia are sums over its
  // pieces, and a piece brings its own material to them.
  //
  // The material is a PRESET density: `density` is what the piece weighs per
  // cubic metre, picking a material sets it to that material's, and typing a
  // density makes the material `custom` (`CollisionObjectData.density`).
  material: MaterialName | typeof CUSTOM_MATERIAL;
  soundMaterial?: SoundMaterial;
  density: number; // kg/m³
  thickness: number; // metres
  // Whether this piece is drawn in 3D, and how (see `CollisionObjectData.debug`).
  // Per SHAPE like the two above. Replaced whole on an edit rather than
  // mutated, so an item copied by spreading never shares a live one.
  debug: EdDebug;
  // A ROOT branch (see `CollisionObjectData.root`, docs/roots.md), or null for
  // every other piece. Only ever set on a scene-layer curve. Replaced whole on
  // an edit, like `debug`.
  root: EdRoot | null;
  // Camera layer:
  cam: EdCamera;
  // Lights layer:
  light: EdLight;
  // Notes layer:
  note: EdNote;
  // Shelter objects:
  shelter: EdShelter;
  // Fog objects:
  fog: EdFog;
  // Anchor objects only: the id `ChainData` names this end by. It is PRESERVED
  // through a load and a save rather than minted fresh each time, so a level
  // that goes through the editor untouched comes back with the same ids it went
  // in with - the id is content, not a handle. 0 on everything else.
  // A model object's fields (see `EdModelRef`).
  modelRef: EdModelRef;
  // A formation object's fields (see `EdFormation`); null on everything else.
  formation: EdFormation | null;
  // A decoration object's (see `EdDecoration`); null on everything else.
  decoration: EdDecoration | null;
  anchorId: number;
}

// A detached copy of a shape. Undo snapshots, duplicate, copy/paste and the
// clipboard all need one: shapes are mutated in place, and a polygon carries an
// array of vertices that a shallow `{...shape}` would leave shared — the bug
// there is silent (an undo that also rewrites the state it was undoing to).
export function cloneShape(s: EdShape): EdShape {
  if (s.kind === "poly") return { kind: "poly", verts: [...s.verts] };
  // Handles are cloned per entry: the objects are replaced wholesale by the
  // writer, but an undo snapshot sharing the ARRAY would be rewritten by the
  // very edit it exists to undo.
  if (s.kind === "path") {
    return {
      kind: "path",
      verts: [...s.verts],
      handles: s.handles.map((h) => ({ ...h })),
      keys: s.keys.map((k) => ({ ...k })),
      width: s.width,
      ...(s.tip !== undefined ? { tip: s.tip } : {}),
    };
  }
  // A belt's wheel list is cloned for the same reason: `setBelt` writes a new
  // array, but a snapshot sharing the old one must not see a later edit.
  if (s.kind === "belt") return { ...s, wheels: [...s.wheels], look: { ...s.look } };
  return { ...s };
}

// Is this item an arrow note? Arrows are the one item edited by their endpoints
// rather than by corner handles, so the test is shared by picking and drawing.
export function isArrowNote(item: EdItem): boolean {
  return item.layer === "notes" && item.note.kind === "arrow";
}

// Is this item a checkpoint marker? A checkpoint is a POINT - a named place to
// start from - so it has no size to edit and no rotation that means anything,
// which is the one thing picking, drawing and the handles all have to agree on.
export function isCheckpointNote(item: EdItem): boolean {
  return item.layer === "notes" && item.note.kind === "checkpoint";
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

// A vine shorter than this is not a vine: `buildVines` fits at least one link to
// whatever length it is given, so a 1 cm vine is one link and nothing to grab.
// It is also what a click that never dragged leaves behind, so the gesture
// always produces something visible rather than a vine of nothing.
export const MIN_VINE_LENGTH = 0.3;

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
// A chain strung between two ANCHOR items (see `ChainData`). It is not an
// `EdItem`: it has no shape, no placement of its own and nothing to resize -
// both of its points belong to bodies - so it lives in its own list and carries
// its own selection rather than being forced through the item machinery.
//
// Each end is the item id of an anchor. The anchor holds the placement, so
// moving a chain end IS moving an object: there is no second copy of the point
// on the chain to keep in step, and a body carrying its anchors with it needs no
// code at all.
export interface EdChain {
  id: number;
  a: number;
  b: number;
  // WRAP POINTS: the item ids of the anchors the chain is routed over, in order
  // from `a` to `b` (see `ChainData.via`). Each is an anchor item exactly as the
  // two ends are - an object in its body, riding it - so the chain's whole
  // route is objects and this list is only the order they come in.
  via: number[];
  // TIE POINTS: the item ids of the anchors the chain is KNOTTED to, in order
  // from `a` to `b` (see `ChainData.through`). A chain with any is a tied
  // chain - a rope bridge - and has no wrap points; `length` means nothing on
  // it, and `lengths`, `slack` and `substeps` below are its.
  through: number[];
  // One length per segment of a tied chain, metres; null in a slot = that
  // segment takes `slack`. Empty for a chain with no tie points.
  lengths: (number | null)[];
  // The fraction every unauthored segment of a tied chain is built longer than
  // its gap; null = taut as authored (see `ChainData.slack`).
  slack: number | null;
  // The island solver's substeps for a tied chain; null = the default.
  substeps: number | null;
  // Metres. Null = exactly taut between the two anchors, re-derived at load, so
  // a chain dragged out between two bodies stays taut as they are moved.
  length: number | null;
  // Hex link colour; null = the renderer's own forged-iron pair.
  color: string | null;
}

// A vine hanging from ONE anchor item (see `VineData`). Held beside the chains
// and not among the items for the same reason a chain is: it has no shape and no
// placement of its own - its one point belongs to a body - and a length, which
// is not a size anything can be resized by.
//
// It is a chain with one end and a length, and it is authored that way: the same
// press on a body that starts a chain, and a drag that pulls the length out
// instead of reaching for a second body.
export interface EdVine {
  id: number;
  braidSeed: number | null;
  // The braid drawn as laid rope rather than a leafy vine (`VineData.rope`).
  rope: boolean;
  // Present = a berry vine (`VineData.starberry`), in metres like the rest of
  // the model.
  starberry?: StarberrySettings;
  // The item id of the anchor it hangs from.
  anchor: number;
  // The item id of an optional SECOND anchor, making the vine a span attached
  // at both ends (see `VineData.anchor2`). Null = the ordinary hanging vine.
  // Authored by dragging the tip handle onto a body with Shift held, and
  // detached the same way over empty space.
  anchor2: number | null;
  // Metres of vine below the anchor - or along the whole span, for a vine with
  // a second anchor: length and anchor separation are deliberately decoupled,
  // which is what lets a span sag. Always positive - a vine of no length is
  // refused at the gesture, the way a chain tied to one body is.
  length: number;
  // Metres between links; null = the builder's default.
  spacing: number | null;
  // Kilograms per metre of cord; null = the builder's default. Weight is about
  // how the vine answers a hooked player and what it leans on the body it hangs
  // from, not about how it falls (see `DEFAULT_VINE_DENSITY`).
  density: number | null;
  // How hard it is to bend, 0..1: 0 is a rope, 1 a pole (see
  // `level/vineBend.ts`). Null = the builder's default, which is a rope - and a
  // real third state, because a vine that never asked for stiffness builds no
  // bend constraints at all and is written to the file without the field.
  stiffness: number | null;
  // How viscous the cord is to the ball's manacle threaded onto it (see
  // `VineData.viscosity`). Null = the builder's default, the reference mud.
  viscosity: number | null;
  // Hex cord colour; null = the renderer's own vine colours.
  color: string | null;
}

// A body's own frame: the transform its objects are placed in, and what the file
// records as the body's `x`/`y`/`rot`.
export interface EdBodyFrame {
  pos: Vec2; // metres
  rot: number; // radians
}

// A node's depth (metres, toward the camera) and tilt (radians about three's x
// then y, before the frame's turn), as `EdItem.z`/`tilt` and `EdNode` hold
// them: what a 3D frame (`Node3D`, `Formation3D`) stands off the plane by.

export interface EdModel {
  // The spawn: where it is, how big the avatar is, whether the run starts on
  // the anchor (`SpawnData.hang`), how far off to the side it rolls in from
  // (`SpawnData.roll`, metres here as every length in the model is, 0 for no
  // entry) and the recorded run it opens on if it opens on one
  // (`SpawnData.arrival`, "" for none - a name, authored by recording a run and
  // running `scripts/make-arrival.ts`, so the editor carries it rather than
  // offering it). All of it is carried through the model rather than read off
  // the file, because the editor writes the level back whole: a field it does
  // not know about is a field it DELETES the first time a level is opened and
  // autosaved.
  player: { pos: Vec2; radius: number; hang: boolean; roll: number; arrival: string };
  items: EdItem[];
  chains: EdChain[];
  vines: EdVine[];
  // THE LEVEL'S NODE TREE (editor/tree.ts): every node, its parent and its
  // children in order, the body properties on the body nodes, and the world
  // placement of every node that is not an item (a body's frame, a group's,
  // a 3D frame's). An item's node is `item.node`; a chain's and a vine's are
  // theirs. A body's frame is its node's placement, stored and moved only
  // when the body is: an edit to one of its pieces moves that piece alone.
  tree: EdTree;
  // The level's data layers, by name (`LevelTree.layers`): what a node's
  // `layers` may name.
  dataLayers: string[];
  // The level's light is NODES (a `Sun` and an `Environment`, their fields in
  // the node's `extra`), and its fog is its fog regions'; what is left of the
  // retired environment block is the level property below.
  //
  // What is behind everything (`LevelTree.background`), or undefined for the
  // page's own. Edited in the top bar beside the 3D camera.
  background: string | undefined;
  // The 3D camera's lens and z offset (`LevelCameraData`), in metres like the
  // rest of the model. Carried because the editor rewrites the whole file every
  // 750 ms: a block it does not write back is a block it deletes the moment
  // the level is opened.
  camera: LevelCameraData | undefined;
  // What the level select shows (see `LevelMetaData`): the title, and whether
  // this level is the introduction or off the list entirely. No longer edited
  // here (there is one main level), but carried for the camera's reason: a
  // block the editor did not know about would be DELETED from disk the first
  // time the level is opened, and the level would silently fall off the menu.
  // Empty is what a level that authors nothing has, and an empty block is
  // written back as no block at all (see `toLevelData`).
  meta: LevelMetaData;
}

// The fields a `Sun` / `Environment` node authors (`SUN_FIELDS`,
// `ENVIRONMENT_FIELDS`), out of a node or its `extra`, which is where the
// editor carries them: every field it sets and nothing else.
export function skyFields(n: object): Partial<EnvironmentData> {
  const r = n as Record<string, unknown>;
  return Object.fromEntries(
    [...SUN_FIELDS, ...ENVIRONMENT_FIELDS].flatMap((k) => (r[k] !== undefined ? [[k, r[k]]] : [])),
  ) as Partial<EnvironmentData>;
}

// The one `Sun` / `Environment` node the level has, or null.
export function lightNode(model: EdModel, type: "Sun" | "Environment"): EdNode | null {
  for (const n of model.tree.nodes.values()) if (n.type === type && n.extra["inInstance"] === undefined) return n;
  return null;
}

// The level's environment block as its nodes compile it (`environmentOf` in
// level/nodes.ts): what the panels read their defaults against and the
// canvas's shelter shadows are cast by. No Sun node is no sun.
export function environmentOfModel(model: EdModel): EnvironmentData {
  const sun = lightNode(model, "Sun");
  const env = lightNode(model, "Environment");
  return {
    ...(sun ? skyFields(sun.extra) : { sunIntensity: 0 }),
    ...(env ? skyFields(env.extra) : {}),
    ...(model.background !== undefined ? { backgroundColor: model.background } : {}),
  };
}

// Every field of the environment block, in the order the inspector shows them,
// with the kind of control each wants. One table rather than a run of hand-written
// fields, so a field added to `EnvironmentData` is one line here rather than
// three places that can disagree.
export const DEFAULT_ENVIRONMENT: Required<EnvironmentData> = {
  sunX: DEFAULT_SUN_DIR.x,
  sunY: DEFAULT_SUN_DIR.y,
  sunZ: DEFAULT_SUN_DIR.z,
  sunColor: DEFAULT_SUN_COLOR,
  sunIntensity: DEFAULT_SUN_INTENSITY,
  skyColor: DEFAULT_SKY_FILL,
  groundColor: DEFAULT_GROUND_FILL,
  fillIntensity: DEFAULT_FILL_INTENSITY,
  envIntensity: ENV_INTENSITY,
  // The generated sky, which is what a level that names no capture is lit by.
  // Empty rather than absent because this table is what the panel READS, and it
  // is the value the picker's "(generated)" entry writes back as a deletion.
  hdri: "",
  hdriRotation: 0,
  hdriBackground: false,
  backgroundColor: DEFAULT_SKY,
  // Off, which is what every level that authors nothing gets. The colour still
  // needs a value for the picker to show, and the background is what an absent
  // `fogColor` resolves to anyway.
  fogAmount: 0,
  fogColor: DEFAULT_SKY,
};

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
  buffer: null,
  bufferLeft: null,
  bufferRight: null,
  bufferTop: null,
  bufferBottom: null,
  falloff: null,
  priority: 0,
  keepInFrame: true,
  rangeX: null,
  rangeY: null,
  falloffX: null,
  falloffY: null,
  lookaheadX: null,
  lookaheadY: null,
  lookaheadBufferX: null,
  lookaheadBufferY: null,
  softness: null,
  reactionTime: null,
  windBuffer: null,
});

export const defaultLight = (): EdLight => ({
  kind: "point",
  intensity: DEFAULT_LIGHT_INTENSITY,
  z: DEFAULT_LIGHT_Z,
  angle: DEFAULT_SPOT_ANGLE,
  penumbra: DEFAULT_SPOT_PENUMBRA,
  // Down the level, which is what a shaft through a grate overhead does. It is
  // only read by a spot, but it carries a real direction rather than a zero so
  // switching a point light to a spot aims it somewhere sane instead of nowhere.
  dir: new Vec2(0, 1),
  dirZ: 0,
  // Off by default: a point light's shadow is a cube map, six renders of the
  // scene (see `render3d/lights.ts`), and a corridor of torches all asking is a
  // frame rate that halves without announcing why.
  castShadow: false,
  shadowNear: null,
  shadowRadius: null,
  flicker: 0,
  beam: 0,
  dust: 0,
  // Always on: a light wakes only when the author says so (or `+ Glow` does).
  wake: 0,
  wakeDelay: null,
  wakeRise: null,
  wakeFall: null,
});

export const defaultNote = (): EdNote => ({
  kind: "text",
  text: "",
  size: DEFAULT_NOTE_TEXT_SIZE * PX,
});

// `+ Glow`: what one click drops. EDITOR defaults, not format defaults - a light
// object on disk with `wake` and nothing else gets the renderer's
// `DEFAULT_WAKE_*` - and every number here is a starting point to be played.
// What it looks like is what the body carries (a model, a formation), and
// whatever glows in that follows the light (`BodyVisual.adoptLook`).
export const GLOW_CUBE = 0.3; // metres, the collision square's side
export const GLOW_COLOR = "#8a3fd6"; // the body's fill: the 2D view and its debug geometry
export const GLOW_EMISSIVE = "#b070ff"; // the light's colour
export const GLOW_RANGE = 4; // metres
export const GLOW_INTENSITY = 6; // candela
export const GLOW_WAKE = 3; // metres
export const GLOW_WAKE_DELAY = 0.25; // seconds
export const GLOW_WAKE_RISE = 0.6; // seconds
export const GLOW_WAKE_FALL = 1.5; // seconds

// The body `+ Glow` places at `pos` (metres): one static body holding a
// collision square (a mushroom the ball rolls against; delete it for one on a
// far wall) and a waking point light at its centre. One body, so the outliner
// shows one row and the whole thing drags together. Pure, so `cli render3d`
// can hold its shapes and defaults.
export function glowBody(pos: Vec2): LevelBodyData {
  const square: ShapeData = { kind: "rect", w: GLOW_CUBE, h: GLOW_CUBE };
  return {
    kind: "static",
    x: pos.x,
    y: pos.y,
    rot: 0,
    color: GLOW_COLOR,
    objects: [
      { type: "collision", shape: { ...square } },
      {
        type: "light",
        color: GLOW_EMISSIVE,
        range: GLOW_RANGE,
        intensity: GLOW_INTENSITY,
        wake: GLOW_WAKE,
        wakeDelay: GLOW_WAKE_DELAY,
        wakeRise: GLOW_WAKE_RISE,
        wakeFall: GLOW_WAKE_FALL,
      },
    ],
  };
}

// ...as editor items, through the same loader a level comes in by, so the
// `+ Glow` tool adds exactly what a level file holding that body would load as.
export function glowModel(pos: Vec2): EdModel {
  return modelFromTree(loadLevelTree({ player: { x: pos.x, y: pos.y, radius: 0.08 }, bodies: [glowBody(pos)] }));
}

// The values a light object's absent `color`, `intensity` and `range` take in
// the renderer (`LightRig.add`). The loader fills an item from these and the
// save omits a field equal to them, so the panel and the file agree.
export const LIGHT_DEFAULTS = { color: DEFAULT_LIGHT_COLOR, intensity: DEFAULT_LIGHT_INTENSITY, range: DEFAULT_LIGHT_RANGE } as const;

// Camera regions and notes are editor-only furniture — they are never drawn in
// game, so their appearance is fixed here rather than authored and saved.
export const CAMERA_REGION_COLOR = "#c792ea";
export const CAMERA_REGION_OPACITY = 0.12;
export const NOTE_COLOR = "#98c379";
export const NOTE_OPACITY = 0.08;
// A shelter is drawn in a cold slate blue, the colour of the shade it makes:
// apart from the camera's violet, and dark enough under its wash that the
// wall reads as the part of the level kept out of the sun.
export const SHELTER_COLOR = "#5f7fa8";
export const SHELTER_OPACITY = 0.18;
export const FOG_REGION_COLOR = "#82cbd6";

// Appearance a freshly drawn item starts with, per layer. Geometry is authored
// from here on; the other two are fixed furniture.
// A light's fill is very faint on purpose: the item is as big as the light
// REACHES, which on a lamp lighting a room is most of that room, and a wash at
// the other layers' opacity would sit over the geometry being lit. What makes it
// legible is the ring and the star at its centre, not the fill.
export const LIGHT_FILL_OPACITY = 0.06;

// Size of the placeholder an ANCHOR carries, in metres. A point has no
// outline, so this is only what the editor draws and picks it by - the save
// writes no `shape` at all.
export const ANCHOR_GIZMO = 0.3;
// ...and a model's marker on the plane (`EdObject` "model"), the same size.
export const MODEL_MARK = ANCHOR_GIZMO;

// Keyed by what is being DRAWN rather than by the layer alone, since the scene
// layer draws two different things: a shape starts at the body defaults and a
// light at a warm flame it is then authored away from. A light's colour is the
// one starting value here that is genuinely AUTHORED - it is the colour the
// light shines - where the camera and note colours are fixed furniture.
export function newItemStyle(
  layer: EdLayer,
  object: EdObject,
): { color: string; opacity: number } {
  if (layer === "camera") return { color: CAMERA_REGION_COLOR, opacity: CAMERA_REGION_OPACITY };
  if (object === "shelter") return { color: SHELTER_COLOR, opacity: SHELTER_OPACITY };
  if (object === "fog") return { color: FOG_REGION_COLOR, opacity: 0.08 };
  if (layer === "notes") return { color: NOTE_COLOR, opacity: NOTE_OPACITY };
  if (object === "light") return { color: DEFAULT_LIGHT_COLOR, opacity: LIGHT_FILL_OPACITY };
  return { color: DEFAULT_BODY_COLOR, opacity: DEFAULT_BODY_OPACITY };
}

// Default box of a freshly placed text note, in metres. A text note is usually
// placed with a click rather than dragged out, so it needs a size worth typing
// into from the start.
export const NOTE_DEFAULT_SIZE = new Vec2(2.4, 0.8);
// Default length of an arrow placed with a click rather than dragged out.
export const NOTE_DEFAULT_ARROW_LENGTH = 1.2;
export const NOTE_ARROW_BAND = NOTE_ARROW_THICKNESS * PX;

// The box a checkpoint is picked and drawn by, in metres: the avatar's own
// diameter, so a marker reads as "the run starts here" and is exactly as big as
// the spawn marker it stands in for.
//
// It is DERIVED rather than authored - built here every time a checkpoint is
// loaded or placed - because a checkpoint has no size of its own to author and
// nothing on disk to hold one. That is also why it cannot drift: change the
// player radius and every marker is the new size the next time the level is
// opened, where a stored box would keep the old one.
export const checkpointBox = (playerRadius: number): EdShape => ({
  kind: "rect",
  w: playerRadius * 2,
  h: playerRadius * 2,
});

// --- conversions ------------------------------------------------------------

// On-disk shape → editor shape. A polygon's vertices are copied into Vec2s
// (they are mutated in place by the vertex handles, so they must not alias the
// loaded data).
function edShape(s: ShapeData): EdShape {
  if (s.kind === "rect") return { kind: "rect", w: s.w, h: s.h };
  if (s.kind === "circle") return { kind: "circle", r: s.r };
  // A CURVE is the camera path's node list under another name - the same
  // points and the same tangent handles - plus the width of the bar it strokes
  // into, so it is edited by the very gestures a camera path is.
  if (s.kind === "curve") {
    return {
      kind: "path",
      verts: s.verts.map((v) => new Vec2(v.x, v.y)),
      handles: s.verts.map((v) => ({
        in: new Vec2(v.inX ?? 0, v.inY ?? 0),
        out: new Vec2(v.outX ?? 0, v.outY ?? 0),
      })),
      keys: s.verts.map(() => NO_KEY()),
      width: s.width,
      ...(s.tip !== undefined ? { tip: s.tip } : {}),
    };
  }
  // A BELT keeps every field it has on disk (docs/conveyors.md): each wheel's
  // centre in the object's frame and its radius, the band's thickness, the
  // signed speed and the band's look. Wheel 0 is the item's own position.
  if (s.kind === "belt") {
    return {
      kind: "belt",
      wheels: s.wheels.map((w) => ({ c: new Vec2(w.x, w.y), r: w.r })),
      thickness: s.thickness,
      speed: s.speed,
      look: {
        ...(s.width !== undefined ? { width: s.width } : {}),
        ...(s.texture !== undefined ? { texture: s.texture } : {}),
        ...(s.color !== undefined ? { color: s.color } : {}),
        ...(s.tileScale !== undefined ? { tileScale: s.tileScale } : {}),
      },
    };
  }
  return { kind: "poly", verts: s.verts.map((v) => new Vec2(v.x, v.y)) };
}

// An on-disk material name resolved to one the editor can put in its picker.
// A name this build does not have loads as the default, exactly as the runtime
// loader resolves it (`materialDensity`), rather than as an entry the picker
// cannot show.
function materialName(name: string | undefined): MaterialName {
  return name !== undefined && name in MATERIALS ? (name as MaterialName) : DEFAULT_MATERIAL;
}

// A piece's material and density as the editor holds them: `custom` and its
// own number wherever the file states a density, whatever material it also
// names (a stated density is what the piece weighs, `pieceDensity`), and the
// named preset at its own density otherwise.
function materialOf(o: { material?: string; density?: number; soundMaterial?: string; viscosity?: number; root?: unknown; shape?: { kind: string } }): Pick<EdItem, "material" | "density" | "soundMaterial"> {
  const density = pieceDensity(o.material, o.density);
  const soundMaterial = soundMaterialOf(o);
  if (o.density !== undefined && density === o.density) return { material: CUSTOM_MATERIAL, density, soundMaterial };
  const material = materialName(o.material);
  return { material, density: MATERIALS[material], soundMaterial };
}

// Metre-space LevelData → editor model.
// --- loading -------------------------------------------------------------------
//
// THE LEVEL AS THE EDITOR HOLDS IT, from its node tree (plans/node-tree.md
// "Editor"). The tree is read twice over: compiled, for each element's own
// fields in the flat form every converter below is written against, and walked,
// for the structure and the world placement of every node. Placements are
// composed down the tree exactly as `compileLevel` composes them, so an item's
// world placement is the one the game builds it at and a level opened and saved
// untouched writes back the numbers it was read with (`toTree`).

// Nodes placed in the scene rather than the plane: a depth and a tilt as well.
const POSE_3D: ReadonlySet<NodeType> = new Set(["Node3D", "Formation3D", "Instance"]);

export interface World3 {
  pos: Vec2;
  rot: number;
  z: number;
  tilt: [number, number];
}

export const WORLD_ORIGIN: World3 = Object.freeze({ pos: Vec2.ZERO, rot: 0, z: 0, tilt: [0, 0] as [number, number] });

const tilted = (w: { tilt: readonly [number, number] }): boolean => w.tilt[0] !== 0 || w.tilt[1] !== 0;

function asPose(w: World3): Pose3D {
  return { x: w.pos.x, y: w.pos.y, rot: w.rot, z: w.z, tilt: [w.tilt[0], w.tilt[1]] };
}

// A node's world placement from its parent's and its own. In the plane it is
// `compileLevel`'s arithmetic, to the bit; only a tilt above takes the full
// rotation.
export function composeWorld(parent: World3, local: Pose3D): World3 {
  if (!tilted(parent)) {
    const f = compose2D({ x: parent.pos.x, y: parent.pos.y, rot: parent.rot }, poseOf(local));
    return { pos: new Vec2(f.x, f.y), rot: f.rot, z: parent.z + (local.z ?? 0), tilt: local.tilt ? [local.tilt[0], local.tilt[1]] : [0, 0] };
  }
  const p = poseOfFrame(compose3D(frameOf(asPose(parent)), frameOf(local)));
  return { pos: new Vec2(p.x, p.y), rot: p.rot, z: p.z, tilt: p.tilt };
}

// ...and back: where a world placement is in a parent's frame.
// A PREFAB'S ROOT STANDS AT ITS ORIGIN. Expanded, the root takes the
// instance's pose (level/nodes.ts `expandInstances`), so a pose of its own in
// the file is never seen in any level - but it was in the editor, which drew
// the prefab in it: a root turned 11.7 degrees by a gizmo ring showed every
// instance's track straight in the level and tilted in its prefab, and what
// was built in the tilted frame landed elsewhere (2026-11-26). `root` with its
// pose taken off; with `keep` the pose is carried into its children first, so
// what was moved with the root (a save after an edit) stays where it was put,
// and without it (an open) the prefab is drawn as its instances draw it.
export function prefabRootAtOrigin(root: LevelNode, keep: boolean): LevelNode {
  const r = root as LevelNode & Pose3D;
  const posed = (r.x ?? 0) !== 0 || (r.y ?? 0) !== 0 || (r.rot ?? 0) !== 0 || (r.z ?? 0) !== 0 || (r.tilt !== undefined && (r.tilt[0] !== 0 || r.tilt[1] !== 0));
  const { x: _x, y: _y, rot: _r, z: _z, tilt: _t, ...bare } = r;
  if (!posed) return bare as LevelNode;
  if (!keep || !root.children?.length) return bare as LevelNode;
  const frame = composeWorld(WORLD_ORIGIN, r);
  const children = root.children.map((c) => {
    const k = c as LevelNode & Pose3D;
    const w = composeWorld(frame, k);
    // A placement at its default is left out, as everywhere in the format.
    const { x: _cx, y: _cy, rot: _cr, ...rest } = k;
    const out: Record<string, unknown> = { ...rest, ...(w.pos.x !== 0 ? { x: w.pos.x } : {}), ...(w.pos.y !== 0 ? { y: w.pos.y } : {}), ...(w.rot !== 0 ? { rot: w.rot } : {}) };
    // Depth and tilt where the child has them to carry: a 3D frame's pose, or
    // a lamp's or a model's own depth.
    if (POSE_3D.has(c.type) || k.z !== undefined) out["z"] = w.z;
    if (POSE_3D.has(c.type) && (w.tilt[0] !== 0 || w.tilt[1] !== 0)) out["tilt"] = [w.tilt[0], w.tilt[1]];
    return out as unknown as LevelNode;
  });
  return { ...(bare as LevelNode), children };
}

export function relativeLocal(parent: World3, world: World3): Pose3D {
  if (!tilted(parent)) {
    const f = relative2D({ x: parent.pos.x, y: parent.pos.y, rot: parent.rot }, { x: world.pos.x, y: world.pos.y, rot: world.rot });
    return { x: f.x, y: f.y, rot: f.rot, z: world.z - parent.z, tilt: [world.tilt[0], world.tilt[1]] };
  }
  return poseOfFrame(compose3D(invert3D(frameOf(asPose(parent))), frameOf(asPose(world))));
}

export function sameWorld(a: World3, b: World3): boolean {
  return a.pos.x === b.pos.x && a.pos.y === b.pos.y && a.rot === b.rot && a.z === b.z && a.tilt[0] === b.tilt[0] && a.tilt[1] === b.tilt[1];
}

// Every field of an item at its default, which each kind below starts from.
export function blankItem(layer: EdLayer, object: EdObject, node: string): EdItem {
  return {
    id: newBodyId(),
    layer,
    object,
    node,
    bodyOf: null,
    body: null,
    unit: node,
    pos: Vec2.ZERO,
    rot: 0,
    z: 0,
    tilt: [0, 0],
    shape: { kind: "rect", w: MODEL_MARK, h: MODEL_MARK },
    color: DEFAULT_BODY_COLOR,
    opacity: DEFAULT_BODY_OPACITY,
    impermeable: false,
    mask: MASK_ALL,
    rail: false,
    viscosity: 0,
    slipFloor: 0,
    material: DEFAULT_MATERIAL,
    density: DEFAULT_DENSITY,
    thickness: DEFAULT_THICKNESS,
    debug: NO_DEBUG(),
    root: null,
    cam: defaultCamera(),
    light: defaultLight(),
    note: defaultNote(),
    shelter: defaultShelter(),
    fog: defaultFog(),
    modelRef: defaultModelRef(),
    formation: null,
    decoration: null,
    anchorId: 0,
  };
}

// A body's properties as its node carries them, from its compiled flat form.
// The bearing and the route are in the body's own frame on disk, and so here.
export function edBodyOf(b: LevelBodyData, order: number): EdBody {
  return {
    kind: b.kind,
    order,
    color: b.color ?? DEFAULT_BODY_COLOR,
    opacity: b.opacity ?? DEFAULT_BODY_OPACITY,
    friction: b.friction ?? DEFAULT_SURFACE_FRICTION,
    bounce: b.bounce ?? DEFAULT_BOUNCE,
    launch: b.launch ?? DEFAULT_LAUNCH,
    breakForce: b.breakForce ?? 0,
    durability: b.durability ?? 1,
    force: b.force ?? 0,
    flow: b.flow ?? 0,
    drag: b.drag ?? 0,
    spill: b.spill ?? 0,
    waterZ: b.waterZ ?? 0,
    waterDepth: b.waterDepth ?? null,
    passable: b.passable === true,
    pivot: b.pivot === true,
    pivotAt: hasBearing(b) && (b.pivotX !== undefined || b.pivotY !== undefined) ? new Vec2(b.pivotX ?? 0, b.pivotY ?? 0) : null,
    pivotFreq: b.pivotFreq ?? 0,
    pivotDamping: b.pivotDamping ?? DEFAULT_SPRING_DAMPING,
    springFreqX: b.springFreqX ?? 0,
    springFreqY: b.springFreqY ?? 0,
    springDamping: b.springDamping ?? DEFAULT_SPRING_DAMPING,
    swingAmp: b.swingAmp ?? 0,
    swingPeriod: b.swingPeriod ?? 0,
    swingPhase: b.swingPhase ?? 0,
    spinPeriod: b.spinPeriod ?? 0,
    spinPhase: b.spinPhase ?? 0,
    route: moveNodesOf(b).map((n, i) => ({
      p: i === 0 ? Vec2.ZERO : new Vec2(n.x, n.y),
      in: new Vec2(n.inX ?? 0, n.inY ?? 0),
      out: new Vec2(n.outX ?? 0, n.outY ?? 0),
      rot: n.rot ?? null,
      speed: n.speed ?? null,
    })),
    moveMode: moveModeOf(b),
    moveSpeed: b.moveSpeed ?? 0,
    movePhase: b.movePhase ?? 0,
    moveEase: b.moveEase ?? "linear",
    moveAlign: b.moveAlign === true,
  };
}

// A fresh body's properties: a plain static.
export function defaultBody(order: number): EdBody {
  return edBodyOf({ kind: "static", x: 0, y: 0, rot: 0, objects: [] }, order);
}

function cameraOf(r: Partial<CameraRegionData & CameraPathData>): EdCamera {
  return {
    offset: new Vec2(r.offsetX ?? 0, r.offsetY ?? 0),
    viewportScale: r.viewportScale ?? DEFAULT_VIEWPORT_SCALE,
    lockX: r.lockX ?? null,
    lockY: r.lockY ?? null,
    buffer: r.buffer ?? null,
    bufferLeft: r.bufferLeft ?? null,
    bufferRight: r.bufferRight ?? null,
    bufferTop: r.bufferTop ?? null,
    bufferBottom: r.bufferBottom ?? null,
    falloff: r.falloff ?? null,
    priority: r.priority ?? 0,
    keepInFrame: r.keepInFrame ?? true,
    rangeX: r.rangeX ?? null,
    rangeY: r.rangeY ?? null,
    falloffX: r.falloffX ?? null,
    falloffY: r.falloffY ?? null,
    lookaheadX: r.lookaheadX ?? null,
    lookaheadY: r.lookaheadY ?? null,
    lookaheadBufferX: r.lookaheadBufferX ?? null,
    lookaheadBufferY: r.lookaheadBufferY ?? null,
    softness: r.softness ?? null,
    reactionTime: r.reactionTime ?? null,
    windBuffer: r.windBuffer ?? null,
  };
}

function pathShape(c: { verts: readonly CameraPathVert[] }): EdShape {
  return {
    kind: "path",
    verts: c.verts.map((v) => new Vec2(v.x, v.y)),
    handles: c.verts.map((v) => ({
      in: new Vec2(v.inX ?? 0, v.inY ?? 0),
      out: new Vec2(v.outX ?? 0, v.outY ?? 0),
    })),
    keys: c.verts.map((v) => {
      const k = NO_KEY();
      for (const f of PATH_KEY_FIELDS) if (v[f] !== undefined) k[f] = v[f]!;
      return k;
    }),
    width: DEFAULT_CURVE_WIDTH,
  };
}

// One light object as the item that edits it.
function lightItem(l: LightObjectData, node: string): EdItem {
  const d = LIGHT_DEFAULTS;
  return {
    ...blankItem("scene", "light", node),
    shape: { kind: "circle", r: l.range ?? d.range },
    color: l.color ?? d.color,
    opacity: LIGHT_FILL_OPACITY,
    light: {
      kind: l.kind ?? "point",
      intensity: l.intensity ?? d.intensity,
      z: l.z ?? DEFAULT_LIGHT_Z,
      angle: l.angle ?? DEFAULT_SPOT_ANGLE,
      penumbra: l.penumbra ?? DEFAULT_SPOT_PENUMBRA,
      dir: new Vec2(l.dirX ?? 0, l.dirY ?? 1),
      dirZ: l.dirZ ?? 0,
      castShadow: l.castShadow === true,
      shadowNear: l.shadowNear ?? null,
      shadowRadius: l.shadowRadius ?? null,
      flicker: l.flicker ?? 0,
      beam: l.beam ?? 0,
      dust: l.dust ?? 0,
      wake: l.wake ?? 0,
      wakeDelay: l.wakeDelay ?? null,
      wakeRise: l.wakeRise ?? null,
      wakeFall: l.wakeFall ?? null,
    },
  };
}

// The item a scene object of a body becomes (not a decoration or a rock,
// which are built against their formation below).
function objectItem(o: SceneObjectData, node: string): EdItem | null {
  if (isCollisionObject(o)) {
    return {
      ...blankItem("scene", "collision", node),
      shape: edShape(o.shape),
      impermeable: o.impermeable === true,
      mask: maskFromPasses(o.passes),
      rail: o.rail === true,
      viscosity: typeof o.viscosity === "number" && o.viscosity > 0 ? o.viscosity : 0,
      slipFloor: typeof o.slipFloor === "number" && o.slipFloor > 0 ? o.slipFloor : 0,
      ...materialOf(o),
      thickness: o.thickness ?? DEFAULT_THICKNESS,
      debug: edDebug(o.debug),
    };
  }
  if (isAnchorObject(o)) {
    return { ...blankItem("scene", "anchor", node), shape: { kind: "rect", w: ANCHOR_GIZMO, h: ANCHOR_GIZMO }, anchorId: o.id };
  }
  if (isModelObject(o)) {
    return {
      ...blankItem("scene", "model", node),
      modelRef: {
        name: o.model,
        ...(o.mushroom ? { mushroom: { ...o.mushroom } } : {}),
        z: o.z ?? 0,
        rotX: o.rotX ?? 0,
        rotY: o.rotY ?? 0,
        scale: o.scale ?? 1,
      },
    };
  }
  if (isLightObject(o)) return lightItem(o, node);
  return null;
}

// The model of a level from its tree, in metres.
export function modelFromTree(source: LevelTree): EdModel {
  // A format-3 tree is read as format 4 (`upgradeTree`): its environment block
  // as light nodes and a background, its fog on its regions.
  const tree = upgradeTree(source);
  const compiled = compileLevel(tree);
  const data = compiled.data;
  const nodeOf = compiled.nodeOf;

  // The structure, each node placed in the world as the compile placed it.
  // Read off the EXPANDED tree, so a placed prefab's insides are nodes here
  // too (marked below), drawn, picked and edited like any others, their edits
  // written back as the instance's overrides (`toTree`).
  const edTree = treeOf(compiled.nodes, (n, parent) => {
    const up = parent && parent.type !== "Node" ? { pos: parent.pos, rot: parent.rot, z: parent.z, tilt: parent.tilt } : WORLD_ORIGIN;
    const own = n as LevelNode & Pose3D;
    const local: Pose3D = POSE_3D.has(n.type) ? own : { x: own.x, y: own.y, rot: own.rot };
    return composeWorld(up, local);
  });

  // PLACED PREFABS: the instance node stands where its prefab's root was
  // expanded (taking the root's class, `rootType`), and every node the prefab
  // brought is marked as the outermost instance's (`inInstance`).
  walkNodes(tree.nodes, (n) => {
    if (n.type !== "Instance") return;
    const e = edTree.nodes.get(n.id);
    if (!e) return "skip";
    // A prefab missing from the library expanded to an empty holder: there is
    // nothing of it here to compare with the prefab, so its overrides are kept
    // as they are (`instanceOverrides`) until it is read again with the
    // prefab. Diffed, a holder written after the library gained its prefab
    // overrode every node of it `disabled` (2026-11-26: a Place made while the
    // page's library was stale, then the prefab saved in the same page).
    e.extra = { rootType: e.type, order: n.order, ...(prefabLibrary()[n.prefab] ? {} : { holder: true }) };
    e.type = "Instance";
    e.instance = { prefab: n.prefab, scale: n.scale ?? 1, overrides: structuredClone(n.overrides ?? {}), editable: false };
    const prefix = `${n.id}/`;
    const mark = (id: string): void => {
      const k = edTree.nodes.get(id);
      if (!k) return;
      if (k.id.startsWith(prefix) && k.extra["inInstance"] === undefined) k.extra = { ...k.extra, inInstance: n.id };
      for (const c of k.children) mark(c);
    };
    for (const c of e.children) mark(c);
  });

  // The extra fields of a node this editor does not model, carried untouched.
  const items: EdItem[] = [];
  const itemOfNode = new Map<string, EdItem>();
  // An item whose node is not in the tree is inside a placed prefab, which is
  // edited as overrides on its instance rather than as items of its own.
  const add = (item: EdItem): EdItem => {
    const n = edTree.nodes.get(item.node);
    if (!n) return item;
    {
      item.pos = n.pos;
      item.rot = n.rot;
      item.z = n.z;
      item.tilt = [n.tilt[0], n.tilt[1]];
      n.item = item.id;
    }
    items.push(item);
    itemOfNode.set(item.node, item);
    return item;
  };

  // Bodies: their properties onto their nodes, their shapes and anchors into
  // items (what the sim is given, `compileLevel`).
  data.bodies.forEach((b) => {
    const id = b.node?.id;
    const node = id ? edTree.nodes.get(id) : undefined;
    if (node && (isBodyType(node.type) || isBodyType((node.extra["rootType"] ?? "Node") as NodeType))) {
      node.body = edBodyOf(b, (findNodeData(compiled.nodes, node.id) as { order?: number } | null)?.order ?? 0);
    }
    b.objects.forEach((o) => {
      const nodeId = o.node ?? nodeOf.get(o);
      if (!nodeId) return;
      const item = objectItem(o, nodeId);
      if (item) add(item);
    });
  });

  // THE LOOK, from the tree itself (it is not the sim's, so not compiled):
  // rocks, lamps, models, and decorations grown on their rock, placed where
  // their anchor lands on it.
  const rocks: EdItem[] = [];
  for (const { node: n, formation: rockId } of lookNodes(compiled.nodes)) {
    switch (n.type) {
      case "Light3D": {
        const { type: _t, id, name: _n, children: _c, grouped: _g, locked: _lk, layers: _l, disabled: _d, x: _x, y: _y, rot: _r, ...fields } = n;
        add(lightItem({ type: "light", ...fields } as LightObjectData, id));
        break;
      }
      case "Model3D": {
        const { type: _t, id, name: _n, children: _c, grouped: _g, locked: _lk, layers: _l, disabled: _d, x: _x, y: _y, rot: _r, ...fields } = n;
        const item = objectItem({ type: "model", ...fields } as ModelObjectData, id);
        if (item) add(item);
        break;
      }
      case "Formation3D":
        rocks.push(add({ ...blankItem("scene", "formation", n.id), formation: formationDataOf(n) }));
        break;
      case "Decoration3D": {
        const { type: _t, id, name: _n, children: _c, grouped: _g, locked: _lk, layers: _l, disabled: _d, ...fields } = n;
        const decoration = { id, formation: rockId ?? "", ...fields } as EdDecoration;
        const item = add({ ...blankItem("scene", "decoration", id), shape: { kind: "rect", w: MODEL_MARK / 2, h: MODEL_MARK / 2 }, decoration });
        const rock = rockId ? edTree.nodes.get(rockId) : undefined;
        if (rock) {
          const at = decoration.onRock ?? decoration.anchor;
          item.pos = rock.pos.add(new Vec2(at.p[0], -at.p[1]).rotated(rock.rot));
          item.rot = 0;
        }
        break;
      }
    }
  }
  // Root branches name their parent branch by item.
  for (const b of data.bodies) {
    b.objects.forEach((o) => {
      if (!isCollisionObject(o) || !o.root || !o.node) return;
      const item = itemOfNode.get(o.node);
      if (!item || item.shape.kind !== "path") return;
      const parentObject = o.root.parent !== undefined ? b.objects[o.root.parent] : undefined;
      const parent = parentObject?.node ? itemOfNode.get(parentObject.node) : undefined;
      item.root = {
        parent: parent && parent !== item ? parent.id : null,
        at: o.root.at ?? 0,
        ...(o.root.bark ? { bark: o.root.bark } : {}),
        ...(o.root.bends !== undefined && o.root.bends.length > 0 ? { bends: o.root.bends.map(bendFields) } : {}),
      };
    });
  }

  // The volumes, paths and marks of the plane.
  const region = (layer: EdLayer, node: string, shape: ShapeData, object: EdObject = "collision"): EdItem => ({
    ...blankItem(layer, object, node),
    shape: edShape(shape),
    ...newItemStyle(layer, object),
  });
  for (const r of data.cameraRegions ?? []) {
    const node = nodeOf.get(r);
    if (node) add({ ...region("camera", node, r.shape), color: CAMERA_REGION_COLOR, opacity: CAMERA_REGION_OPACITY, cam: cameraOf(r) });
  }
  for (const c of data.cameraPaths ?? []) {
    const node = nodeOf.get(c);
    if (node) add({ ...blankItem("camera", "collision", node), shape: pathShape(c), color: CAMERA_REGION_COLOR, opacity: CAMERA_REGION_OPACITY, cam: { ...cameraOf(c), offset: Vec2.ZERO, lockX: null, lockY: null, keepInFrame: true } });
  }
  for (const s of data.shelters ?? []) {
    const node = nodeOf.get(s);
    if (node) add({ ...region("scene", node, s.shape, "shelter"), shelter: { front: s.front ?? null } });
  }
  for (const f of data.fogRegions ?? []) {
    const node = nodeOf.get(f);
    if (node) add({ ...region("scene", node, f.shape, "fog"), fog: { falloff: f.falloff ?? null, amount: f.amount ?? null, color: f.color ?? null } });
  }
  const noteItem = (node: string, shape: EdShape, note: EdNote): EdItem => ({
    ...blankItem("notes", "collision", node),
    shape,
    color: NOTE_COLOR,
    opacity: NOTE_OPACITY,
    note,
  });
  for (const n of data.notes ?? []) {
    const node = nodeOf.get(n);
    if (node) add(noteItem(node, { kind: "rect", w: n.w, h: n.h }, { kind: n.kind, text: n.text ?? "", size: n.size ?? DEFAULT_NOTE_TEXT_SIZE * PX }));
  }
  for (const c of data.checkpoints ?? []) {
    const node = nodeOf.get(c);
    if (node) add(noteItem(node, checkpointBox(data.player.radius), { kind: "checkpoint", text: c.name, size: DEFAULT_NOTE_TEXT_SIZE * PX }));
  }

  // Chains and vines, their ends by anchor item.
  const itemOfAnchor = new Map<number, EdItem>();
  for (const i of items) if (i.object === "anchor") itemOfAnchor.set(i.anchorId, i);
  const chains: EdChain[] = [];
  for (const c of data.chains ?? []) {
    const node = nodeOf.get(c);
    const a = itemOfAnchor.get(c.a);
    const b = itemOfAnchor.get(c.b);
    if (!node || !a || !b) continue;
    const chain: EdChain = {
      id: newBodyId(),
      a: a.id,
      b: b.id,
      via: (c.via ?? []).flatMap((id) => itemOfAnchor.get(id)?.id ?? []),
      through: (c.through ?? []).flatMap((id) => itemOfAnchor.get(id)?.id ?? []),
      lengths: (c.lengths ?? []).map((l) => (l > 0 ? l : null)),
      slack: c.slack ?? null,
      substeps: c.substeps ?? null,
      length: c.length ?? null,
      color: c.color ?? null,
    };
    chains.push(chain);
    const n = edTree.nodes.get(node);
    if (n) n.chain = chain.id;
  }
  const vines: EdVine[] = [];
  for (const v of data.vines ?? []) {
    const node = nodeOf.get(v);
    const a = itemOfAnchor.get(v.anchor);
    if (!node || !a) continue;
    const a2 = v.anchor2 !== undefined ? itemOfAnchor.get(v.anchor2) : undefined;
    const vine: EdVine = {
      id: newBodyId(),
      anchor: a.id,
      anchor2: a2 && a2 !== a ? a2.id : null,
      length: v.length,
      spacing: v.spacing ?? null,
      density: v.density ?? null,
      stiffness: v.stiffness ?? null,
      viscosity: v.viscosity ?? null,
      color: v.color ?? null,
      braidSeed: v.braidSeed ?? null,
      rope: v.braidSeed !== undefined && v.rope === true,
      ...(v.starberry ? { starberry: structuredClone(v.starberry) } : {}),
    };
    vines.push(vine);
    const n = edTree.nodes.get(node);
    if (n) n.vine = vine.id;
  }

  // What a node carries that this editor holds beside it.
  walkNodes(compiled.nodes, (n) => {
    const e = edTree.nodes.get(n.id);
    if (!e) return;
    if (n.type === "Spawn2D") e.extra = { ...e.extra, spawn: true };
    // A chain's and a vine's build order key (the sim builds them in it).
    if (n.type === "Chain" || n.type === "Vine") e.extra = { ...e.extra, order: n.order };
    // The level's light: what the node authors, every field it sets.
    if (n.type === "Sun" || n.type === "Environment") e.extra = { ...e.extra, ...skyFields(n) };
  });
  // A DISABLED node, and everything under one, is out of the compile, so
  // nothing above built an item, a body or a chain of it: its own fields are
  // held as they were loaded and written back as they are (`toTree`). Without
  // them a disabled shape was saved with no shape, a lamp with no light, and
  // a prefab instance at a scale other than 1 that disabled a shape could not
  // be written at all (2026-11-26).
  const holdDisabled = (list: readonly LevelNode[], off: boolean): void => {
    for (const n of list) {
      const out = off || n.disabled === true;
      const e = edTree.nodes.get(n.id);
      if (out && e) {
        const { type: _t, id: _i, name: _n, children: _c, grouped: _g, locked: _lk, layers: _l, disabled: _d, x: _x, y: _y, rot: _r, z: _z, tilt: _tl, ...held } = n as LevelNode & Pose3D;
        if (Object.keys(held).length) e.extra = { ...e.extra, held: structuredClone(held) };
      }
      holdDisabled(n.children ?? [], out);
    }
  };
  holdDisabled(compiled.nodes, false);

  const model: EdModel = {
    player: {
      pos: new Vec2(data.player.x, data.player.y),
      radius: data.player.radius,
      hang: data.player.hang === true,
      roll: data.player.roll ?? 0,
      arrival: data.player.arrival ?? "",
    },
    items,
    chains,
    vines,
    tree: edTree,
    dataLayers: [...(tree.layers ?? [])],
    background: tree.background,
    camera: tree.camera ? { ...tree.camera } : undefined,
    meta: { ...tree.meta },
  };
  relink(model);
  // A collision guide's `subset` names its pieces by node id in the tree; the
  // editor holds indices into its body's enclosing pieces (`nodeGuide` is the
  // way back). A "#n" id is the flat form's index as it was.
  for (const item of rocks) {
    const guide = item.formation!.guide as NodeFormationGuide;
    if (guide.kind !== "collision" || !guide.subset) continue;
    const body = bodyAbove(model.tree, item.node);
    const pieces = body ? enclosingPiecesOf(model, body.id).map((p) => p.node) : [];
    const subset = guide.subset.map((id) => (id.startsWith("#") ? Number(id.slice(1)) : pieces.indexOf(id)));
    item.formation = { ...item.formation!, guide: { ...guide, subset } as FormationGuide };
  }
  return model;
}

function findNodeData(nodes: readonly LevelNode[], id: string): LevelNode | null {
  return findNode(nodes, id);
}

// Point every item at the body above its node (`EdItem.bodyOf`/`body`). Run
// after anything that changes the tree's structure or replaces the model.
export function relink(model: EdModel): void {
  for (const item of model.items) {
    const body = bodyAbove(model.tree, item.node);
    item.bodyOf = body?.id ?? null;
    item.body = body?.body ?? null;
    item.unit = body?.id ?? item.node;
  }
}

// Editor model → metre-space LevelData. Each layer writes its own list, and
// only the fields that layer gives meaning to.
//
// `itemOf`, when given, is filled with the item each written scene object came
// from, keyed by the OBJECT ITSELF. That is what lets the editor act on a 3D
// pick: the scene is built from this data, a drawn object carries the authored
// object it was built from (`pickTagOf`), and this is the only place that knows
// which item wrote it. It is an out-parameter rather than a second return value
// so the save path - which wants the data and nothing else - is unchanged, and
// nothing about the file depends on whether it was passed.
// A camera path as the game reads it, in metres - what `toLevelData` writes
// and what the inspector builds a rule from to show a node's EFFECTIVE value.
// One mapping, so the two cannot disagree about what a key means.
export function pathDataOf(i: EdItem): CameraPathData {
  return {
    x: i.pos.x,
    y: i.pos.y,
    rot: i.rot,
    // A zero handle is written as nothing at all, so a path of plain corners
    // saves exactly the four keys it always did.
    // ...and a node's keys are written only where it has them, for the same
    // reason: an unkeyed node is the two keys it always was.
    verts: pathNodes(i).map((n, j) => {
      const key = i.shape.kind === "path" ? i.shape.keys[j] : undefined;
      const keyed: Partial<Record<PathKeyField, number>> = {};
      if (key) for (const f of PATH_KEY_FIELDS) if (key[f] !== null) keyed[f] = key[f]!;
      return {
        x: n.p.x,
        y: n.p.y,
        ...(n.in.x !== 0 ? { inX: n.in.x } : {}),
        ...(n.in.y !== 0 ? { inY: n.in.y } : {}),
        ...(n.out.x !== 0 ? { outX: n.out.x } : {}),
        ...(n.out.y !== 0 ? { outY: n.out.y } : {}),
        ...keyed,
      };
    }),
    // Omit anything left at its default, so a saved path carries only what
    // was actually authored - the same rule the region block follows, and
    // what keeps a re-save byte-stable.
    ...(i.cam.rangeX !== null ? { rangeX: i.cam.rangeX } : {}),
    ...(i.cam.rangeY !== null ? { rangeY: i.cam.rangeY } : {}),
    ...(i.cam.falloffX !== null ? { falloffX: i.cam.falloffX } : {}),
    ...(i.cam.falloffY !== null ? { falloffY: i.cam.falloffY } : {}),
    ...(i.cam.lookaheadX !== null ? { lookaheadX: i.cam.lookaheadX } : {}),
    ...(i.cam.lookaheadY !== null ? { lookaheadY: i.cam.lookaheadY } : {}),
    ...(i.cam.lookaheadBufferX !== null ? { lookaheadBufferX: i.cam.lookaheadBufferX } : {}),
    ...(i.cam.lookaheadBufferY !== null ? { lookaheadBufferY: i.cam.lookaheadBufferY } : {}),
    ...(i.cam.viewportScale !== DEFAULT_VIEWPORT_SCALE
      ? { viewportScale: i.cam.viewportScale }
      : {}),
    ...(i.cam.buffer !== null ? { buffer: i.cam.buffer } : {}),
    ...(i.cam.softness !== null ? { softness: i.cam.softness } : {}),
    ...(i.cam.reactionTime !== null ? { reactionTime: i.cam.reactionTime } : {}),
    ...(i.cam.windBuffer !== null ? { windBuffer: i.cam.windBuffer } : {}),
    ...(i.cam.priority !== 0 ? { priority: i.cam.priority } : {}),
  };
}

// A shelter item as the format writes it, or null for any other item. `front`
// only where it was authored: absent is the format's default, so the file
// keeps following it.
export function shelterDataOf(i: EdItem): ShelterData | null {
  if (i.object !== "shelter") return null;
  const s = i.shape;
  const shape: ShapeData | null =
    s.kind === "rect"
      ? { kind: "rect", w: s.w, h: s.h }
      : s.kind === "circle"
        ? { kind: "circle", r: s.r }
        : s.kind === "poly"
          ? { kind: "poly", verts: s.verts.map((v) => ({ x: v.x, y: v.y })) }
          : null;
  if (!shape) return null;
  return {
    x: i.pos.x,
    y: i.pos.y,
    rot: i.rot,
    shape,
    ...(i.shelter.front !== null ? { front: i.shelter.front } : {}),
  };
}

export function fogRegionDataOf(i: EdItem): FogRegionData | null {
  if (i.object !== "fog" || (i.shape.kind !== "rect" && i.shape.kind !== "circle")) return null;
  return { x: i.pos.x, y: i.pos.y, rot: i.rot, shape: { ...i.shape },
    ...(i.fog.falloff !== null ? { falloff: i.fog.falloff } : {}),
    ...(i.fog.amount !== null ? { amount: i.fog.amount } : {}),
    ...(i.fog.color !== null ? { color: i.fog.color } : {}) };
}

// The line where the edge fade reaches full strength, for both editors.
export function fogRegionInner(i: EdItem): EdItem | null {
  const f = Math.max(0, i.fog.falloff ?? DEFAULT_FOG_FALLOFF);
  if (f === 0) return null;
  const s = i.shape;
  if (s.kind === "rect" && s.w > 2 * f && s.h > 2 * f) {
    return { ...i, shape: { kind: "rect", w: s.w - 2 * f, h: s.h - 2 * f } };
  }
  if (s.kind === "circle" && s.r > f) return { ...i, shape: { kind: "circle", r: s.r - f } };
  return null;
}

// What a drawn thing in the 3D scene is tagged with, which `toLevelData`'s
// `itemOf` maps back to the item that wrote it: an object, or a formation.
// --- saving --------------------------------------------------------------------
//
// The model back to its node tree, in metres (`toTree`), and the flat level the
// sim, the renderer and a test read, compiled from that tree exactly as the
// game compiles a level file (`toLevelData`): one path from what is edited to
// what is played.

// An item's shape as the flat form spells it. A camera path never reaches
// here: it is written as a `CameraPathData`.
export function shapeDataOf(i: EdItem): ShapeData {
  if (i.shape.kind === "rect") return { kind: "rect", w: i.shape.w, h: i.shape.h };
  if (i.shape.kind === "circle") return { kind: "circle", r: i.shape.r };
  // A path on the SCENE layer is an authored curve: the same nodes, plus the
  // width of the bar. A handle that is zero is written as absent, exactly as
  // a camera path's is, so a curve of corners stores nothing extra.
  if (i.shape.kind === "path") {
    const handles = i.shape.handles;
    return {
      kind: "curve",
      width: i.shape.width,
      ...(i.shape.tip !== undefined ? { tip: i.shape.tip } : {}),
      verts: i.shape.verts.map((v, k) => {
        const h = handles[k];
        return {
          x: v.x,
          y: v.y,
          ...(h && h.in.x !== 0 ? { inX: h.in.x } : {}),
          ...(h && h.in.y !== 0 ? { inY: h.in.y } : {}),
          ...(h && h.out.x !== 0 ? { outX: h.out.x } : {}),
          ...(h && h.out.y !== 0 ? { outY: h.out.y } : {}),
        };
      }),
    };
  }
  if (i.shape.kind === "belt") return beltShapeData(i.shape);
  return { kind: "poly", verts: i.shape.verts.map((v) => ({ x: v.x, y: v.y })) };
}

// A light item's fields as written: a field left at its default is not.
function lightFields(i: EdItem): Omit<LightObjectData, "type" | "x" | "y" | "rot"> {
  const d = defaultLight();
  const spot = i.light.kind === "spot";
  const fill = LIGHT_DEFAULTS;
  return {
    ...(spot ? { kind: "spot" as const } : {}),
    ...(i.light.z !== d.z ? { z: i.light.z } : {}),
    ...(i.color !== fill.color ? { color: i.color } : {}),
    ...(i.light.intensity !== fill.intensity ? { intensity: i.light.intensity } : {}),
    ...(i.shape.kind === "circle" && i.shape.r !== fill.range ? { range: i.shape.r } : {}),
    ...(spot
      ? {
          ...(i.light.angle !== d.angle ? { angle: i.light.angle } : {}),
          ...(i.light.penumbra !== d.penumbra ? { penumbra: i.light.penumbra } : {}),
          ...(i.light.dir.x !== d.dir.x ? { dirX: i.light.dir.x } : {}),
          ...(i.light.dir.y !== d.dir.y ? { dirY: i.light.dir.y } : {}),
          ...(i.light.dirZ !== d.dirZ ? { dirZ: i.light.dirZ } : {}),
        }
      : {}),
    ...(i.light.castShadow ? { castShadow: true } : {}),
    ...(i.light.castShadow && i.light.shadowNear !== null ? { shadowNear: i.light.shadowNear } : {}),
    ...(i.light.castShadow && i.light.shadowRadius !== null ? { shadowRadius: i.light.shadowRadius } : {}),
    ...(i.light.flicker !== 0 ? { flicker: i.light.flicker } : {}),
    ...(spot && i.light.beam !== 0 ? { beam: i.light.beam } : {}),
    ...(spot && i.light.dust !== 0 ? { dust: i.light.dust } : {}),
    ...(!spot && i.light.wake > 0
      ? {
          wake: i.light.wake,
          ...(i.light.wakeDelay !== null ? { wakeDelay: i.light.wakeDelay } : {}),
          ...(i.light.wakeRise !== null ? { wakeRise: i.light.wakeRise } : {}),
          ...(i.light.wakeFall !== null ? { wakeFall: i.light.wakeFall } : {}),
        }
      : {}),
  };
}

// A collision item's fields as written.
function collisionFields(i: EdItem, rootParent: (id: number) => string | null): Omit<CollisionObjectData, "type" | "x" | "y" | "rot" | "root"> & { root?: NodeRootBranch } {
  const root = i.root && i.shape.kind === "path" ? i.root : null;
  const parent = root && root.parent !== null ? rootParent(root.parent) : null;
  return {
    shape: shapeDataOf(i),
    ...(i.impermeable ? { impermeable: true } : {}),
    ...(passesFromMask(i.mask).length > 0 ? { passes: passesFromMask(i.mask) } : {}),
    ...(i.rail && (i.shape.kind === "path" || i.shape.kind === "circle") ? { rail: true } : {}),
    ...(i.viscosity > 0 ? { viscosity: i.viscosity } : {}),
    ...(i.viscosity > 0 && i.slipFloor > 0 ? { slipFloor: i.slipFloor } : {}),
    ...(i.material !== DEFAULT_MATERIAL ? { material: i.material } : {}),
    ...((i.soundMaterial ?? "auto") !==
    soundMaterialOf({
      ...(i.material !== DEFAULT_MATERIAL ? { material: i.material } : {}),
      viscosity: i.viscosity,
      root: i.root ?? undefined,
      shape: { kind: i.shape.kind },
    })
      ? { soundMaterial: i.soundMaterial ?? "auto" }
      : {}),
    ...(i.material === CUSTOM_MATERIAL ? { density: i.density } : {}),
    ...(i.thickness !== DEFAULT_THICKNESS ? { thickness: i.thickness } : {}),
    ...(i.shape.kind !== "belt" && debugData(i.debug) ? { debug: debugData(i.debug) } : {}),
    ...(root
      ? {
          root: {
            ...(parent !== null ? { parent, at: root.at } : {}),
            ...(root.bark ? { bark: root.bark } : {}),
            ...(root.bends !== undefined && root.bends.length > 0 ? { bends: root.bends.map((k) => ({ ...k })) } : {}),
          },
        }
      : {}),
  };
}

// WHAT KIND OF SURFACE a collision piece is: every field it writes but its
// outline, and its node's data layers and enablement. Two pieces with the same
// key differ only in where they are, which is what lets Join fuse them into
// one outline without either losing a setting (editor/splitJoin.ts). Read off
// `collisionFields`, the one statement of what a piece writes, so a per-piece
// field added later is compared without anyone remembering to.
export function surfaceKey(model: EdModel, i: EdItem): string {
  const { shape: _s, ...fields } = collisionFields(i, () => null);
  const n = model.tree.nodes.get(i.node);
  return JSON.stringify({ layer: i.layer, object: i.object, fields, layers: [...(n?.layers ?? [])].sort(), disabled: n?.disabled === true });
}

// A camera region item's fields as written.
function cameraRegionFields(i: EdItem): Omit<CameraRegionData, "x" | "y" | "rot"> {
  return {
    shape: shapeDataOf(i),
    ...(i.cam.offset.x !== 0 ? { offsetX: i.cam.offset.x } : {}),
    ...(i.cam.offset.y !== 0 ? { offsetY: i.cam.offset.y } : {}),
    ...(i.cam.viewportScale !== DEFAULT_VIEWPORT_SCALE ? { viewportScale: i.cam.viewportScale } : {}),
    ...(i.cam.lockX !== null ? { lockX: i.cam.lockX } : {}),
    ...(i.cam.lockY !== null ? { lockY: i.cam.lockY } : {}),
    ...(i.cam.buffer !== null ? { buffer: i.cam.buffer } : {}),
    ...(i.shape.kind === "rect"
      ? {
          ...(i.cam.bufferLeft !== null ? { bufferLeft: i.cam.bufferLeft } : {}),
          ...(i.cam.bufferRight !== null ? { bufferRight: i.cam.bufferRight } : {}),
          ...(i.cam.bufferTop !== null ? { bufferTop: i.cam.bufferTop } : {}),
          ...(i.cam.bufferBottom !== null ? { bufferBottom: i.cam.bufferBottom } : {}),
        }
      : {}),
    ...(i.cam.falloff !== null ? { falloff: i.cam.falloff } : {}),
    ...(i.cam.priority !== 0 ? { priority: i.cam.priority } : {}),
    ...(!i.cam.keepInFrame ? { keepInFrame: false } : {}),
  };
}

// Is this body moved by script (a pendulum, a rotor or a route)? Then it is an
// `AnimatableBody2D` on disk.
export function bodyIsMover(b: EdBody): boolean {
  return b.kind === "static" && ((b.swingAmp !== 0 && b.swingPeriod > 0) || b.spinPeriod !== 0 || (b.route.length > 1 && b.moveSpeed > 0));
}

// The class a body node is written as.
export function bodyNodeType(b: EdBody): NodeType {
  if (b.kind === "rigid") return "RigidBody2D";
  if (b.kind === "static") return bodyIsMover(b) ? "AnimatableBody2D" : "StaticBody2D";
  return "Area2D";
}

// A body's properties as written: only what its class gives meaning to, and a
// field at its default not at all.
export function bodyFields(b: EdBody): Record<string, unknown> {
  const swingsHere = b.kind === "static" && b.swingAmp !== 0 && b.swingPeriod > 0;
  const spinsHere = b.kind === "static" && b.spinPeriod !== 0;
  const movesHere = b.kind === "static" && b.route.length > 1 && b.moveSpeed > 0;
  return {
    order: b.order,
    ...(isAreaKind(b.kind) ? { area: b.kind } : {}),
    color: b.color,
    opacity: b.opacity,
    friction: b.friction,
    ...(b.bounce ? { bounce: b.bounce } : {}),
    ...(b.launch ? { launch: b.launch } : {}),
    ...(b.breakForce > 0 ? { breakForce: b.breakForce, durability: b.durability } : {}),
    ...(b.kind === "force" ? { force: b.force } : {}),
    ...(b.kind === "water" ? { flow: b.flow, drag: b.drag } : {}),
    ...(b.kind === "water" && b.spill > 0 ? { spill: b.spill } : {}),
    ...(b.kind === "water" && b.waterZ !== 0 ? { waterZ: b.waterZ } : {}),
    ...(b.kind === "water" && b.waterDepth !== null ? { waterDepth: b.waterDepth } : {}),
    ...(b.passable ? { passable: true } : {}),
    ...(b.kind === "rigid" && b.pivot
      ? { pivot: true, ...(b.pivotFreq > 0 ? { pivotFreq: b.pivotFreq, pivotDamping: b.pivotDamping } : {}) }
      : {}),
    ...(swingsHere ? { swingAmp: b.swingAmp, swingPeriod: b.swingPeriod, ...(b.swingPhase ? { swingPhase: b.swingPhase } : {}) } : {}),
    ...(spinsHere ? { spinPeriod: b.spinPeriod, ...(b.spinPhase ? { spinPhase: b.spinPhase } : {}) } : {}),
    ...(movesHere
      ? {
          moveNodes: b.route.map((n) => ({
            x: n.p.x,
            y: n.p.y,
            ...(n.in.x !== 0 ? { inX: n.in.x } : {}),
            ...(n.in.y !== 0 ? { inY: n.in.y } : {}),
            ...(n.out.x !== 0 ? { outX: n.out.x } : {}),
            ...(n.out.y !== 0 ? { outY: n.out.y } : {}),
            ...(n.rot !== null ? { rot: n.rot } : {}),
            ...(n.speed !== null ? { speed: n.speed } : {}),
          })),
          moveSpeed: b.moveSpeed,
          ...(b.moveMode !== "backAndForth" ? { moveMode: b.moveMode } : {}),
          ...(b.movePhase ? { movePhase: b.movePhase } : {}),
          ...(b.moveEase !== "linear" ? { moveEase: b.moveEase } : {}),
          ...(b.moveAlign ? { moveAlign: true } : {}),
        }
      : {}),
    ...((b.kind === "rigid" && b.pivot) || swingsHere || spinsHere ? (b.pivotAt ? { pivotX: b.pivotAt.x, pivotY: b.pivotAt.y } : {}) : {}),
    ...(b.kind === "rigid" && !b.pivot && (b.springFreqX > 0 || b.springFreqY > 0)
      ? {
          ...(b.springFreqX > 0 ? { springFreqX: b.springFreqX } : {}),
          ...(b.springFreqY > 0 ? { springFreqY: b.springFreqY } : {}),
          springDamping: b.springDamping,
        }
      : {}),
  };
}

// Where a node stands in the world: an item's own placement, the spawn's, or
// the node's.
export function worldOfNode(model: EdModel, id: string): World3 {
  const n = model.tree.nodes.get(id);
  if (!n) return WORLD_ORIGIN;
  if (n.item !== null) {
    const i = model.items.find((it) => it.id === n.item);
    if (i) return { pos: i.pos, rot: i.rot, z: i.z, tilt: i.tilt };
  }
  if (n.extra["spawn"] === true) return { pos: model.player.pos, rot: 0, z: 0, tilt: [0, 0] };
  return { pos: n.pos, rot: n.rot, z: n.z, tilt: n.tilt };
}

// The frame a node's children are placed in: its own world placement, or the
// world itself under a plain `Node`.
function frameForChildren(model: EdModel, n: EdNode): World3 {
  return n.type === "Node" ? WORLD_ORIGIN : worldOfNode(model, n.id);
}

// THE MODEL AS ITS NODE TREE, in metres. Each node's placement is written in
// its parent's frame; a node that stands where it was loaded, under a parent
// that does too, is written with exactly the numbers it was loaded with.
//
// `keep`, when given, writes only the nodes it keeps and the structure above
// them (a body or a group with none of its own kept is left out), and only
// the chains and vines whose every anchor is kept: a FRAGMENT of the level, for
// the clipboard and for a duplicate (`subModel`).
export function toTree(model: EdModel, keep?: (id: string) => boolean): LevelTree {
  const itemById = new Map(model.items.map((i) => [i.id, i]));
  const kept = keep ? keptNodes(model, keep) : null;
  const chainById = new Map(model.chains.map((c) => [c.id, c]));
  const vineById = new Map(model.vines.map((v) => [v.id, v]));
  const nodeOfItem = (id: number): string | null => itemById.get(id)?.node ?? null;

  const write = (id: string, parentFrame: World3): LevelNode | null => {
    const n = model.tree.nodes.get(id);
    if (!n) return null;
    if (kept && !kept.has(id)) return null;
    const item = n.item !== null ? itemById.get(n.item) : undefined;
    // A node whose item is gone from the model (taken out of `items` without
    // the tree being reconciled yet) is gone too: what it would write is a
    // node with nothing in it - a region with no shape - that the compile
    // cannot read.
    if (n.item !== null && !item) return null;
    const world = worldOfNode(model, id);
    const out: Record<string, unknown> = { type: n.type, id: n.id, name: n.name };
    if (n.grouped) out["grouped"] = true;
    if (n.locked) out["locked"] = true;
    if (n.layers.length) out["layers"] = [...n.layers];
    if (n.disabled) out["disabled"] = true;

    // The placement, in the parent's frame.
    const pose3 = POSE_3D.has(n.type);
    const placed = n.type !== "Node" && n.type !== "Decoration3D" && n.type !== "Chain" && n.type !== "Vine" && n.type !== "Sun" && n.type !== "Environment";
    if (placed) {
      const own: Pose3D = n.local ?? {};
      const loaded = n.local !== null && sameWorld(composeWorld(parentFrame, pose3 ? own : { x: own.x, y: own.y, rot: own.rot }), world);
      const local: Pose3D = loaded ? own : relativeLocal(parentFrame, world);
      const required = n.type === "Spawn2D" || n.type === "Checkpoint2D" || n.type.endsWith("Region2D") || n.type === "CameraPath2D" || n.type === "Shelter2D" || n.type === "Note2D";
      const put = (k: "x" | "y" | "rot" | "z", v: number | undefined): void => {
        if (v === undefined) return;
        if (loaded ? true : v !== 0) out[k] = v;
      };
      if (required) {
        out["x"] = local.x ?? 0;
        out["y"] = local.y ?? 0;
        if (n.type !== "Spawn2D" && n.type !== "Checkpoint2D") out["rot"] = local.rot ?? 0;
      } else {
        put("x", local.x);
        put("y", local.y);
        put("rot", local.rot);
        if (pose3) {
          put("z", local.z);
          if (local.tilt && (loaded || local.tilt[0] !== 0 || local.tilt[1] !== 0)) out["tilt"] = [local.tilt[0], local.tilt[1]];
        }
      }
    }

    // What the node carries.
    if (n.body && !n.instance) {
      out["type"] = bodyNodeType(n.body);
      Object.assign(out, bodyFields(n.body));
    } else if (n.type === "Sun" || n.type === "Environment") {
      Object.assign(out, skyFields(n.extra));
    } else if (n.extra["spawn"] === true) {
      out["radius"] = model.player.radius;
      if (model.player.hang) out["hang"] = true;
      if (model.player.roll) out["roll"] = model.player.roll;
      if (model.player.arrival) out["arrival"] = model.player.arrival;
    } else if (n.chain !== null) {
      const c = chainById.get(n.chain);
      if (!c) return null;
      const a = nodeOfItem(c.a);
      const b = nodeOfItem(c.b);
      if (!a || !b) return null;
      if (kept && ![a, b, ...c.via.flatMap((v) => nodeOfItem(v) ?? []), ...c.through.flatMap((v) => nodeOfItem(v) ?? [])].every((x) => kept.has(x))) return null;
      const tied = c.through.length > 0;
      const lengths = c.lengths.map((l) => l ?? 0);
      while (lengths.length > 0 && lengths[lengths.length - 1] === 0) lengths.pop();
      const via = c.via.flatMap((v) => nodeOfItem(v) ?? []);
      const through = c.through.flatMap((v) => nodeOfItem(v) ?? []);
      Object.assign(out, {
        order: typeof n.extra["order"] === "number" ? n.extra["order"] : 0,
        a,
        b,
        ...(c.length !== null && !tied ? { length: c.length } : {}),
        ...(c.color !== null ? { color: c.color } : {}),
        ...(via.length > 0 && !tied ? { via } : {}),
        ...(tied ? { through } : {}),
        ...(tied && lengths.length > 0 ? { lengths } : {}),
        ...(tied && c.slack !== null ? { slack: c.slack } : {}),
        ...(tied && c.substeps !== null ? { substeps: c.substeps } : {}),
      });
    } else if (n.vine !== null) {
      const v = vineById.get(n.vine);
      const anchor = v ? nodeOfItem(v.anchor) : null;
      if (!v || !anchor || !(v.length > 0)) return null;
      const anchor2 = v.anchor2 !== null ? nodeOfItem(v.anchor2) : null;
      if (kept && (!kept.has(anchor) || (anchor2 !== null && !kept.has(anchor2)))) return null;
      Object.assign(out, {
        order: typeof n.extra["order"] === "number" ? n.extra["order"] : 0,
        anchor,
        ...(anchor2 ? { anchor2 } : {}),
        length: v.length,
        ...(v.spacing !== null ? { spacing: v.spacing } : {}),
        ...(v.density !== null ? { density: v.density } : {}),
        ...(v.stiffness !== null ? { stiffness: v.stiffness } : {}),
        ...(v.viscosity !== null ? { viscosity: v.viscosity } : {}),
        ...(v.color !== null ? { color: v.color } : {}),
        ...(v.braidSeed !== null ? { braidSeed: v.braidSeed } : {}),
        ...(v.braidSeed !== null && v.rope ? { rope: true } : {}),
        ...(v.starberry ? { starberry: structuredClone(v.starberry) } : {}),
      });
    } else if (n.instance) {
      // A PLACED PREFAB: its prefab, its key, its scale, and what has been
      // changed inside it, as overrides by prefab node id; the nodes the
      // prefab brought are not written, only the ones added under it.
      const frame = frameForChildren(model, n);
      const overrides = instanceOverrides(model, n, (c) => write(c, frame));
      Object.assign(out, {
        type: "Instance",
        prefab: n.instance.prefab,
        order: typeof n.extra["order"] === "number" ? n.extra["order"] : 0,
        ...(n.instance.scale !== 1 ? { scale: n.instance.scale } : {}),
        ...(Object.keys(overrides).length ? { overrides } : {}),
      });
      const own = n.children.filter((c) => model.tree.nodes.get(c)?.extra["inInstance"] === undefined).flatMap((c) => write(c, frame) ?? []);
      if (own.length) out["children"] = own;
      return out as unknown as LevelNode;
    } else if (item) {
      Object.assign(out, itemFields(model, item, n, nodeOfItem));
    } else if (n.extra["held"] && n.chain === null && n.vine === null) {
      // Out of the level (disabled, or under a disabled node): what it was
      // loaded with, as it was (`holdDisabled` in `modelFromTree`).
      for (const [k, v] of Object.entries(n.extra["held"] as Record<string, unknown>)) if (!(k in out)) out[k] = structuredClone(v);
    }

    const kids = n.children.flatMap((c) => write(c, frameForChildren(model, n)) ?? []);
    if (kids.length) out["children"] = kids;
    return out as unknown as LevelNode;
  };

  return {
    format: TREE_FORMAT,
    ...(Object.keys(metaOf(model)).length ? { meta: metaOf(model) } : {}),
    ...(model.background !== undefined ? { background: model.background } : {}),
    ...(model.camera ? { camera: { ...model.camera } } : {}),
    ...(model.dataLayers.length && !keep ? { layers: [...model.dataLayers] } : {}),
    // The editor works in metres; its instances expand at that scale.
    lengthScale: PX,
    nodes: model.tree.roots.flatMap((r) => write(r, WORLD_ORIGIN) ?? []),
  };
}

// The nodes a fragment keeps: those `keep` keeps, everything above them, and
// every chain and vine (they are judged by their anchors as they are written).
function keptNodes(model: EdModel, keep: (id: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const n of model.tree.nodes.values()) {
    if (n.chain !== null || n.vine !== null) {
      out.add(n.id);
      continue;
    }
    if (!keep(n.id)) continue;
    out.add(n.id);
    for (const a of ancestors(model.tree, n.id)) out.add(a.id);
  }
  return out;
}

// WHAT HAS CHANGED INSIDE A PLACED PREFAB, as overrides keyed by prefab node
// id (plans/node-tree.md "Prefabs"). The prefab as this instance places it -
// expanded at its scale, with no overrides - and the insides as they stand
// now are both written by the same writer (`toTree`), so a default spelt one
// way and a placement rounded through a frame never read as an edit; then
// every field that differs is an override (in the prefab's own units, a
// scaled instance's lengths taken back to the prefab's), and a node the
// prefab has that is gone here is overridden `disabled`. An override naming
// a node the prefab no longer has is kept, shown as orphaned, never dropped.
function instanceOverrides(model: EdModel, n: EdNode, writeChild: (id: string) => LevelNode | null): Record<string, Record<string, unknown>> {
  const inst = n.instance!;
  const prefab = prefabLibrary()[inst.prefab];
  if (!prefab || n.extra["holder"] === true) return structuredClone(inst.overrides);
  const prefix = `${n.id}/`;
  const strip = (id: string): string => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
  // The prefab's own placing of itself: what this instance would be with no
  // overrides, written canonically.
  const placed = expandInstances([{ type: "Instance", id: n.id, name: n.name, prefab: inst.prefab, order: 0, ...(inst.scale !== 1 ? { scale: inst.scale } : {}) } as LevelNode], prefabsAt(PX))[0]!;
  const base = toTree(modelFromTree({ format: TREE_FORMAT, lengthScale: PX, nodes: [placed] })).nodes[0]!;
  const baseById = new Map<string, Record<string, unknown>>();
  walkNodes([base], (b) => void baseById.set(b.id === n.id ? prefab.root.id : strip(b.id), b as unknown as Record<string, unknown>));
  // The insides now: the root's own payload, and each node the prefab brought.
  const nowById = new Map<string, Record<string, unknown>>();
  const rootType = (n.extra["rootType"] ?? n.type) as NodeType;
  const rootItem = n.item !== null ? model.items.find((i) => i.id === n.item) : undefined;
  const rootNow: Record<string, unknown> = n.body ? { type: rootType, ...bodyFields(n.body) } : rootItem ? itemFields(model, rootItem, { ...n, type: rootType }, (id) => model.items.find((i) => i.id === id)?.node ?? null) : {};
  nowById.set(prefab.root.id, rootNow);
  for (const c of n.children) {
    if (model.tree.nodes.get(c)?.extra["inInstance"] === undefined) continue;
    const w = writeChild(c);
    if (w) walkNodes([w], (x) => void nowById.set(strip(x.id), x as unknown as Record<string, unknown>));
  }
  const out: Record<string, Record<string, unknown>> = {};
  // Kept as they were: overrides naming nodes the prefab no longer has.
  for (const [id, props] of Object.entries(inst.overrides)) if (!baseById.has(id)) out[id] = structuredClone(props);
  const skip = new Set(["id", "type", "children"]);
  const rootSkip = new Set([...skip, "name", "x", "y", "rot", "z", "tilt", "grouped", "locked", "layers", "order"]);
  // Each prefab node's parent, by the same keys: a node gone with its parent
  // is not overridden itself, since `disabled` takes a node and everything
  // under it out. Written for each, a deleted body left its shapes `disabled`
  // after the body's override was reverted, and came back empty (2026-11-26).
  const keyOf = (bid: string): string => (bid === n.id ? prefab.root.id : strip(bid));
  const parentOf = new Map<string, string>();
  const mapParents = (x: LevelNode): void => {
    for (const c of x.children ?? []) {
      parentOf.set(keyOf(c.id), keyOf(x.id));
      mapParents(c);
    }
  };
  mapParents(base);
  for (const [id, b] of baseById) {
    const now = nowById.get(id);
    if (!now) {
      const up = parentOf.get(id);
      if (up === undefined || nowById.has(up)) out[id] = { disabled: true };
      continue;
    }
    const ignore = id === prefab.root.id ? rootSkip : skip;
    // A prefab's rock is never re-made by an instance (`PREFAB_ROCK_RECIPE`).
    const recipe = b["type"] === "Formation3D";
    const keys = new Set([...Object.keys(b), ...Object.keys(now)].filter((k) => !ignore.has(k) && !(recipe && PREFAB_ROCK_RECIPE.has(k))));
    let unscaled: Record<string, unknown> | null = null;
    for (const k of keys) {
      if (near(b[k], now[k])) continue;
      // A placement left out IS zero (the format writes no default), and the
      // writer spells a zero only for a node whose loaded placement still
      // holds exactly: a pasted copy of a copy, offset twice, lands a float's
      // last bit off it and wrote `x: null` against the prefab's `x: 0`.
      if (POSE_KEYS.has(k) && near(b[k] ?? POSE_ZERO[k], now[k] ?? POSE_ZERO[k])) continue;
      if (inst.scale !== 1 && !unscaled) {
        unscaled = structuredClone(now);
        scaleGeometry(unscaled as unknown as LevelNode, 1 / inst.scale, id === prefab.root.id);
      }
      const v = (unscaled ?? now)[k];
      (out[id] ??= {})[k] = v === undefined ? null : structuredClone(v);
    }
  }
  return out;
}

// Equal to a part in 1e9, structurally: what an override is judged by.
// A node's placement fields and the value each has when it is left out.
const POSE_ZERO: Record<string, unknown> = { x: 0, y: 0, rot: 0, z: 0, tilt: [0, 0] };
const POSE_KEYS = new Set(Object.keys(POSE_ZERO));

function near(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => near(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => near((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

// THE PART OF A MODEL a set of items is: their nodes, the bodies and groups
// above them with the frames they stand in, and the chains and vines strung
// wholly between them, as a model of its own. A whole body's items take the
// body; some of a body's take a body of just those, in the body's frame.
export function subModel(model: EdModel, items: readonly EdItem[]): EdModel {
  const nodes = new Set(items.map((i) => i.node));
  return modelFromTree(toTree(model, (id) => nodes.has(id)));
}

// PUT ONE MODEL INTO ANOTHER: every node, item, chain and vine of `source`
// added to `target` under fresh ids, moved by `offset`, its top-level nodes
// under `parent` (the level's root when null) with names free there, and its
// bodies' build order keys after every key `target` has, in their own order.
// What paste, duplicate and the placing tools (`+ Glow`, `+ Mushroom`) do.
// Returns the items and the top-level nodes it added.
export function graftModel(
  target: EdModel,
  source: EdModel,
  offset: Vec2 = Vec2.ZERO,
  parent: string | null = null,
): { items: EdItem[]; roots: string[] } {
  const taken = new Set(target.tree.nodes.keys());
  const ids = new Map<string, string>();
  for (const id of source.tree.nodes.keys()) {
    const fresh = newNodeId(taken);
    taken.add(fresh);
    ids.set(id, fresh);
  }
  // A placed prefab's insides are named after it (`inst/node`, the prefab
  // node's id after the slash) and marked as its (`inInstance`), which is how
  // a write tells them from what was added under it and diffs them against
  // the prefab (`instanceOverrides`). So they follow their instance's fresh
  // id, keeping the prefab's part: under ids of their own, a copied instance
  // was written with every node of its prefab `disabled` and its insides
  // dropped (2026-11-26, a pasted and a duplicated `mine-track`).
  const instanceOf = (n: EdNode): string | null => {
    const inst = n.extra["inInstance"];
    return typeof inst === "string" && ids.has(inst) && n.id.startsWith(`${inst}/`) ? inst : null;
  };
  for (const n of source.tree.nodes.values()) {
    const inst = instanceOf(n);
    if (inst) ids.set(n.id, ids.get(inst)! + n.id.slice(inst.length));
  }
  const itemIds = new Map<number, number>();
  const items: EdItem[] = [];
  for (const i of source.items) {
    const node = ids.get(i.node);
    if (!node) continue;
    const id = newBodyId();
    itemIds.set(i.id, id);
    const copy: EdItem = {
      ...i,
      id,
      node,
      pos: i.pos.add(offset),
      shape: cloneShape(i.shape),
      ...(i.formation ? { formation: { ...structuredClone(i.formation), id: node } } : {}),
      // A decoration names the rock it grows on, which is its parent.
      ...(i.decoration
        ? { decoration: { ...structuredClone(i.decoration), id: node, formation: ids.get(source.tree.nodes.get(i.node)?.parent ?? "") ?? i.decoration.formation } }
        : {}),
      ...(i.root ? { root: { ...i.root } } : {}),
    };
    items.push(copy);
  }
  for (const i of items) {
    if (i.root?.parent != null) i.root = { ...i.root, parent: itemIds.get(i.root.parent) ?? null };
  }
  // Anchor numbers are content (a chain names them), so the arrivals take
  // numbers the target does not use yet.
  let nextAnchor = Math.max(0, ...target.items.filter((i) => i.object === "anchor").map((i) => i.anchorId)) + 1;
  for (const i of items) if (i.object === "anchor") i.anchorId = nextAnchor++;
  const chainIds = new Map<number, number>();
  for (const c of source.chains) {
    const id = newBodyId();
    chainIds.set(c.id, id);
    target.chains.push({
      ...c,
      id,
      a: itemIds.get(c.a) ?? c.a,
      b: itemIds.get(c.b) ?? c.b,
      via: c.via.map((v) => itemIds.get(v) ?? v),
      through: c.through.map((v) => itemIds.get(v) ?? v),
      lengths: [...c.lengths],
    });
  }
  const vineIds = new Map<number, number>();
  for (const v of source.vines) {
    const id = newBodyId();
    vineIds.set(v.id, id);
    target.vines.push({ ...structuredClone(v), id, anchor: itemIds.get(v.anchor) ?? v.anchor, anchor2: v.anchor2 !== null ? (itemIds.get(v.anchor2) ?? v.anchor2) : null });
  }
  const base = nextOrder(target.tree);
  // A copied instance's own insides keep their prefab's build order keys (an
  // instance's bodies build in its key, then their own, `level/nodes.ts`) and
  // the placement they were loaded with (they move with it), so the copy
  // writes them exactly as the prefab does and no key or `x: 0` reads as an
  // override of it.
  const keys = [...source.tree.nodes.values()].filter((n) => !instanceOf(n));
  const sourceMin = Math.min(...keys.flatMap((n) => (n.body ? [n.body.order] : typeof n.extra["order"] === "number" ? [n.extra["order"] as number] : [])), 0);
  for (const n of source.tree.nodes.values()) {
    const id = ids.get(n.id)!;
    const inside = instanceOf(n) !== null;
    const copy: EdNode = {
      ...n,
      id,
      parent: n.parent === null ? parent : ids.get(n.parent)!,
      children: n.children.map((c) => ids.get(c)!),
      layers: [...n.layers],
      pos: n.pos.add(offset),
      tilt: [n.tilt[0], n.tilt[1]],
      local: inside && n.local ? structuredClone(n.local) : null,
      item: n.item !== null ? (itemIds.get(n.item) ?? null) : null,
      chain: n.chain !== null ? (chainIds.get(n.chain) ?? null) : null,
      vine: n.vine !== null ? (vineIds.get(n.vine) ?? null) : null,
      body: n.body ? { ...n.body, order: inside ? n.body.order : base + n.body.order - sourceMin, route: n.body.route.map(cloneRouteNode) } : null,
      instance: n.instance ? structuredClone(n.instance) : null,
      extra: { ...n.extra, ...(typeof n.extra["order"] === "number" && !inside ? { order: base + (n.extra["order"] as number) - sourceMin } : {}) },
    };
    // Inside a copied instance: the copy's. A piece copied out of one without
    // it is the level's own from here on.
    if (n.extra["inInstance"] !== undefined) {
      const inst = instanceOf(n);
      if (inst) copy.extra = { ...copy.extra, inInstance: ids.get(inst)! };
      else delete copy.extra["inInstance"];
    }
    // The spawn is the level's own: a fragment never brings one. Nor does it
    // bring the light: a fragment read through the loader (a placed mushroom,
    // an old flat copy) is given a default Sun and Environment by the upgrade
    // (`upgradeTree`), and grafting those would put a sun back into a level
    // that deleted its own to go underground.
    if (copy.extra["spawn"] === true) continue;
    if (n.type === "Sun" || n.type === "Environment") continue;
    target.tree.nodes.set(id, copy);
  }
  const roots = source.tree.roots.flatMap((r) => {
    const id = ids.get(r)!;
    return target.tree.nodes.has(id) ? [id] : [];
  });
  for (const r of roots) {
    const n = target.tree.nodes.get(r)!;
    n.name = freeName(target.tree, parent, n.name);
    childrenOf(target.tree, parent).push(r);
  }
  // A child pointing at the dropped spawn is dropped with it.
  for (const n of target.tree.nodes.values()) n.children = n.children.filter((c) => target.tree.nodes.has(c));
  target.items.push(...items);
  relink(target);
  return { items, roots };
}

// --- editing the tree ------------------------------------------------------------

// The class of the node an item is.
export function nodeTypeOfItem(i: EdItem): NodeType {
  switch (i.layer) {
    case "scene":
      return i.object === "collision"
        ? "CollisionShape2D"
        : i.object === "anchor"
          ? "Anchor2D"
          : i.object === "light"
            ? "Light3D"
            : i.object === "model"
              ? "Model3D"
              : i.object === "formation"
                ? "Formation3D"
                : i.object === "fog"
                  ? "FogRegion2D"
                  : i.object === "shelter"
                    ? "Shelter2D"
                    : "Decoration3D";
    case "camera":
      return i.shape.kind === "path" ? "CameraPath2D" : "CameraRegion2D";
    case "notes":
      return i.note.kind === "checkpoint" ? "Checkpoint2D" : "Note2D";
  }
}

// What a new node is called before anyone names it.
export function defaultNameOf(i: EdItem): string {
  if (i.object === "model" && i.layer === "scene") return i.modelRef.name ? i.modelRef.name[0]!.toUpperCase() + i.modelRef.name.slice(1) : "Model";
  if (i.object === "decoration" && i.decoration) return i.decoration.kind[0]!.toUpperCase() + i.decoration.kind.slice(1);
  if (i.object === "collision" && i.layer === "scene") return i.root ? "Root" : i.shape.kind === "path" ? "Curve" : i.shape.kind[0]!.toUpperCase() + i.shape.kind.slice(1);
  if (i.object === "formation") return "Formation";
  if (i.object === "fog") return "Fog";
  if (i.object === "shelter") return "Shelter";
  if (i.object === "light") return "Light";
  if (i.object === "anchor") return "Anchor";
  const type = nodeTypeOfItem(i);
  return type.replace(/2D$|3D$/, "");
}

function blankNode(id: string, type: NodeType, name: string, parent: string | null): EdNode {
  return {
    id,
    type,
    name,
    parent,
    children: [],
    grouped: false,
    locked: false,
    layers: [],
    disabled: false,
    pos: Vec2.ZERO,
    rot: 0,
    z: 0,
    tilt: [0, 0],
    local: null,
    item: null,
    chain: null,
    vine: null,
    body: null,
    instance: null,
    extra: {},
  };
}

// ADD AN ITEM to the level as a new node under `parent` (the level's root
// when null), at `index` among its siblings (the end when absent), named
// freely there. Its id is fresh, and so is the node's, whatever the item
// carried; a rock's and a decoration's id is their node's.
//
// `keepId` asks for a particular node id - a decoration's, which its paint is
// filed under - and is honoured when no node has it.
export function addItem(model: EdModel, item: EdItem, parent: string | null, index?: number, name?: string, keepId?: string): EdItem {
  const id = keepId && !model.tree.nodes.has(keepId) ? keepId : newNodeId(new Set(model.tree.nodes.keys()));
  item.node = id;
  if (item.formation) item.formation = { ...item.formation, id };
  if (item.decoration) {
    const rock = parent !== null ? model.tree.nodes.get(parent) : undefined;
    item.decoration = { ...item.decoration, id, formation: rock?.type === "Formation3D" ? rock.id : item.decoration.formation };
  }
  const n = blankNode(id, nodeTypeOfItem(item), freeName(model.tree, parent, name ?? defaultNameOf(item)), parent);
  n.item = item.id;
  n.pos = item.pos;
  n.rot = item.rot;
  n.z = item.z;
  n.tilt = [item.tilt[0], item.tilt[1]];
  model.tree.nodes.set(id, n);
  const list = childrenOf(model.tree, parent);
  list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, id);
  if (!model.items.includes(item)) model.items.push(item);
  const body = bodyAbove(model.tree, id);
  item.bodyOf = body?.id ?? null;
  item.body = body?.body ?? null;
  item.unit = body?.id ?? id;
  return item;
}

// ADD A FRAME: a body (with `body`), a group (`Node2D`), a 3D frame
// (`Node3D`) or a plain `Node`, standing at `pos`/`rot` in the world.
export function addFrameNode(
  model: EdModel,
  type: NodeType,
  parent: string | null,
  opts: { pos?: Vec2; rot?: number; name?: string; body?: EdBody; grouped?: boolean; index?: number; z?: number; tilt?: [number, number] } = {},
): EdNode {
  const id = newNodeId(new Set(model.tree.nodes.keys()));
  const n = blankNode(id, type, freeName(model.tree, parent, opts.name ?? type), parent);
  n.pos = opts.pos ?? Vec2.ZERO;
  n.rot = opts.rot ?? 0;
  n.z = opts.z ?? 0;
  n.tilt = opts.tilt ?? [0, 0];
  n.body = opts.body ?? null;
  n.grouped = opts.grouped ?? false;
  model.tree.nodes.set(id, n);
  const list = childrenOf(model.tree, parent);
  list.splice(opts.index === undefined ? list.length : Math.max(0, Math.min(opts.index, list.length)), 0, id);
  return n;
}

// A new chain or vine is a node too, top level, its build order after every
// other's.
export function addLinkNode(model: EdModel, kind: "Chain" | "Vine", payload: number): EdNode {
  const n = addFrameNode(model, kind, null, { name: kind });
  if (kind === "Chain") n.chain = payload;
  else n.vine = payload;
  n.extra = { order: nextOrder(model.tree) };
  return n;
}

// REMOVE ITEMS and their nodes, with everything under those nodes (a rock's
// decorations go with it) and every chain or vine that loses an anchor. A
// body or group left with nothing in it stays: it is a node of its own.
export function removeItems(model: EdModel, items: readonly EdItem[]): void {
  const gone = new Set<number>();
  for (const i of items) {
    for (const n of removeSubtree(model.tree, i.node)) if (n.item !== null) gone.add(n.item);
    gone.add(i.id);
  }
  model.items = model.items.filter((i) => !gone.has(i.id));
  const lost = (id: number): boolean => gone.has(id);
  const chains = model.chains.filter((c) => lost(c.a) || lost(c.b) || c.via.some(lost) || c.through.some(lost));
  const vines = model.vines.filter((v) => lost(v.anchor));
  for (const c of chains) removeLinkNode(model, "chain", c.id);
  for (const v of vines) removeLinkNode(model, "vine", v.id);
  model.chains = model.chains.filter((c) => !chains.includes(c));
  model.vines = model.vines.filter((v) => !vines.includes(v));
  for (const v of model.vines) if (v.anchor2 !== null && lost(v.anchor2)) v.anchor2 = null;
}

export function removeLinkNode(model: EdModel, kind: "chain" | "vine", id: number): void {
  for (const n of model.tree.nodes.values()) {
    if ((kind === "chain" ? n.chain : n.vine) === id) {
      removeSubtree(model.tree, n.id);
      return;
    }
  }
}

// MOVE A NODE TO A NEW WORLD PLACEMENT, carrying everything under it: each
// descendant keeps its placement in its parent's frame, so a turned or tilted
// frame turns and tilts what it holds. What a gizmo on a group, a body or a 3D
// frame writes.
export function setNodeWorld(model: EdModel, id: string, world: World3): void {
  const itemById = new Map(model.items.map((i) => [i.id, i]));
  const read = (nid: string): World3 => worldOfNode(model, nid);
  const write = (nid: string, w: World3): void => {
    const n = model.tree.nodes.get(nid);
    if (!n) return;
    const item = n.item !== null ? itemById.get(n.item) : undefined;
    if (item) {
      item.pos = w.pos;
      item.rot = w.rot;
      item.z = w.z;
      item.tilt = [w.tilt[0], w.tilt[1]];
    }
    if (n.extra["spawn"] === true) model.player.pos = w.pos;
    n.pos = w.pos;
    n.rot = w.rot;
    n.z = w.z;
    n.tilt = [w.tilt[0], w.tilt[1]];
  };
  // Every descendant's placement in its parent's frame, read before anything
  // moves, then laid back out from the new placement down.
  const locals: { id: string; parent: string; local: Pose3D }[] = [];
  const gather = (nid: string): void => {
    const n = model.tree.nodes.get(nid);
    if (!n) return;
    const frame = n.type === "Node" ? WORLD_ORIGIN : read(nid);
    for (const c of n.children) {
      locals.push({ id: c, parent: nid, local: relativeLocal(frame, read(c)) });
      gather(c);
    }
  };
  gather(id);
  write(id, world);
  for (const l of locals) {
    const p = model.tree.nodes.get(l.parent);
    const frame = p?.type === "Node" ? WORLD_ORIGIN : read(l.parent);
    write(l.id, composeWorld(frame, l.local));
  }
}

// Every item under a node (and the node's own, if it is one): what selecting
// the node selects to move, delete or duplicate.
export function membersOf(model: EdModel, id: string): EdItem[] {
  const ids = new Set<string>([id, ...descendants(model.tree, id).map((n) => n.id)]);
  return model.items.filter((i) => ids.has(i.node));
}

// MOVE A NODE IN THE TREE (the scene tree's drag): under `parent` at `index`.
// Keep world (the default, Unreal's rule) leaves it where it stands; keep
// relative keeps the numbers it was recorded with against its old parent, so
// it lands at the same offset on the new one. Refused with the reason when
// the tree would not accept it (`canParent`).
export function moveNode(model: EdModel, id: string, parent: string | null, index: number | undefined, keepRelative = false): string | null {
  const why = canParent(model.tree, id, parent);
  if (why) return why;
  const n = model.tree.nodes.get(id);
  if (!n) return "no such node";
  const frameOf = (p: string | null): World3 => {
    if (p === null) return WORLD_ORIGIN;
    const pn = model.tree.nodes.get(p);
    return !pn || pn.type === "Node" ? WORLD_ORIGIN : worldOfNode(model, p);
  };
  const local = keepRelative ? relativeLocal(frameOf(n.parent), worldOfNode(model, id)) : null;
  // A sibling moved further down its own list lands one place up once it is
  // taken out of it.
  const list = childrenOf(model.tree, parent);
  const from = list.indexOf(id);
  const at = index !== undefined && from >= 0 && n.parent === parent && from < index ? index - 1 : index;
  reparent(model.tree, id, parent, at);
  if (local) setNodeWorld(model, id, composeWorld(frameOf(parent), local));
  relink(model);
  return null;
}

// KEEP THE TREE AND THE LISTS IN AGREEMENT, after an edit that changed the
// lists alone (an item filtered out, an anchor pushed in, a chain dropped):
// a node whose item, chain or vine is gone goes (with what is under it); an
// item with no node gets one, under the body its `unit` names when that is a
// body, else at the top; a chain or vine with no node gets one. Run by the
// editor after every edit, so a path written against the lists cannot leave
// the tree describing a level that is not there.
export function reconcileTree(model: EdModel): void {
  const items = new Set(model.items.map((i) => i.id));
  const chains = new Set(model.chains.map((c) => c.id));
  const vines = new Set(model.vines.map((v) => v.id));
  for (const n of [...model.tree.nodes.values()]) {
    if (!model.tree.nodes.has(n.id)) continue;
    const gone = (n.item !== null && !items.has(n.item)) || (n.chain !== null && !chains.has(n.chain)) || (n.vine !== null && !vines.has(n.vine));
    if (!gone) continue;
    const removed = removeSubtree(model.tree, n.id);
    // An item under a removed node (a rock's decorations) goes with it.
    const lost = new Set(removed.filter((r) => r.id !== n.id).flatMap((r) => (r.item !== null ? [r.item] : [])));
    if (lost.size) model.items = model.items.filter((i) => !lost.has(i.id));
  }
  const placed = new Set<number>();
  for (const n of model.tree.nodes.values()) if (n.item !== null) placed.add(n.item);
  for (const i of [...model.items]) {
    if (placed.has(i.id) && model.tree.nodes.get(i.node)?.item === i.id) continue;
    const host = model.tree.nodes.get(i.unit);
    const parent = host?.body ? host.id : null;
    const keep = model.tree.nodes.has(i.node) ? undefined : i.node || undefined;
    addItem(model, i, parent, undefined, undefined, keep);
  }
  const linked = new Set<string>();
  for (const n of model.tree.nodes.values()) {
    if (n.chain !== null) linked.add(`c${n.chain}`);
    if (n.vine !== null) linked.add(`v${n.vine}`);
  }
  for (const c of model.chains) if (!linked.has(`c${c.id}`)) addLinkNode(model, "Chain", c.id);
  for (const v of model.vines) if (!linked.has(`v${v.id}`)) addLinkNode(model, "Vine", v.id);
  relink(model);
}

// The node an item is.
export function nodeOfItem(model: EdModel, i: EdItem): EdNode | null {
  return model.tree.nodes.get(i.node) ?? null;
}

function metaOf(model: EdModel): LevelMetaData {
  return {
    ...(model.meta.title ? { title: model.meta.title } : {}),
    ...(model.meta.intro ? { intro: true } : {}),
    ...(model.meta.unlisted ? { unlisted: true } : {}),
  };
}

// The fields of the node an item is, past its placement.
function itemFields(
  model: EdModel,
  i: EdItem,
  n: EdNode,
  nodeOfItem: (id: number) => string | null,
): Record<string, unknown> {
  switch (n.type) {
    case "CollisionShape2D":
      return collisionFields(i, nodeOfItem);
    case "Anchor2D":
      return {};
    case "Model3D": {
      const m = i.modelRef;
      return {
        model: m.name,
        ...(m.mushroom ? { mushroom: { ...m.mushroom } } : {}),
        ...(m.z !== 0 ? { z: m.z } : {}),
        ...(m.rotX !== 0 ? { rotX: m.rotX } : {}),
        ...(m.rotY !== 0 ? { rotY: m.rotY } : {}),
        ...(m.scale !== 1 ? { scale: m.scale } : {}),
      };
    }
    case "Light3D":
      return lightFields(i);
    case "Formation3D": {
      if (!i.formation) return {};
      const { id: _id, guide, ...f } = i.formation;
      return { ...f, guide: nodeGuide(model, guide, n) };
    }
    case "Decoration3D": {
      if (!i.decoration) return {};
      const { strokes: _s, id: _id, formation: _f, ...d } = i.decoration;
      return d;
    }
    case "CameraRegion2D":
      return cameraRegionFields(i);
    case "CameraPath2D": {
      const { x: _x, y: _y, rot: _r, ...p } = pathDataOf(i);
      return p;
    }
    case "Shelter2D": {
      const s = shelterDataOf(i);
      if (!s) return {};
      const { x: _x, y: _y, rot: _r, ...rest } = s;
      return rest;
    }
    case "FogRegion2D": {
      const f = fogRegionDataOf(i);
      if (!f) return {};
      const { x: _x, y: _y, rot: _r, ...rest } = f;
      return rest;
    }
    case "Note2D": {
      const h = halfExtents(i);
      return {
        kind: i.note.kind === "arrow" ? "arrow" : "text",
        w: h.x * 2,
        h: h.y * 2,
        ...(i.note.kind === "text" ? { text: i.note.text, size: i.note.size } : {}),
      };
    }
    case "Checkpoint2D":
      return { checkpoint: i.note.text };
    default:
      return {};
  }
}

// A collision guide's `subset` names the pieces it was taken from by node id
// (`NodeCollisionGuide`); the editor holds the flat form's indices into the
// body's enclosing pieces, in tree order.
function nodeGuide(model: EdModel, guide: FormationGuide, n: EdNode): NodeFormationGuide {
  if (guide.kind !== "collision" || !guide.subset) return guide as NodeFormationGuide;
  const body = bodyAbove(model.tree, n.id);
  const pieces = body ? enclosingPiecesOf(model, body.id) : [];
  const { subset, ...rest } = guide;
  return { ...rest, subset: subset.flatMap((k) => pieces[k]?.node ?? []) };
}

// A body's collision items that enclose an area (what a guide is taken
// from), in the order the body compiles them.
export function enclosingPiecesOf(model: EdModel, bodyNode: string): EdItem[] {
  const out: EdItem[] = [];
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const walk = (ids: readonly string[]): void => {
    for (const id of ids) {
      const c = model.tree.nodes.get(id);
      if (!c || c.disabled || isBodyType(c.type)) continue;
      const item = c.item !== null ? byId.get(c.item) : undefined;
      if (item && item.object === "collision" && enclosesShape({ shape: shapeDataOf(item) })) out.push(item);
      walk(c.children);
    }
  };
  walk(model.tree.nodes.get(bodyNode)?.children ?? []);
  return out;
}

export type SceneTag = SceneObjectData | FormationData;

// THE FLAT LEVEL, in metres, compiled from the model's tree as the game compiles
// a level file: what the sim is given, the look in its `tree` alone. `itemOf`,
// when given, is filled with which item each written object came from, so a
// 3D pick on one can be answered with its item (the look answers a pick with
// its node's id, `pickTagOf`).
export function toLevelData(model: EdModel, itemOf?: Map<SceneTag, number>): LevelData {
  const compiled = compileLevel(toTree(model));
  if (itemOf) {
    const itemOfNode = new Map(model.items.map((i) => [i.node, i.id]));
    for (const [element, node] of compiled.nodeOf) {
      const item = itemOfNode.get(node);
      if (item !== undefined) itemOf.set(element as SceneTag, item);
    }
  }
  return { ...compiled.data, tree: compiled.nodes, format: LEVEL_FORMAT };
}

export function modelFromDisk(pixelData: LevelSource): EdModel {
  return modelFromTree(scaleLevelTree(loadLevelTree(pixelData), PX));
}

// Editor model → on-disk pixel LevelData.
// The model as its level file: the node tree in pixels.
export function modelToDisk(model: EdModel): LevelTree {
  return scaleLevelTree(toTree(model), PIXELS_PER_METER);
}

// ...and as the flat level that file compiles to, in pixels: for a test that
// reads a body or an object back.
export function modelToFlatDisk(model: EdModel): LevelData {
  const { tree: _tree, ...flat } = scaleNormalized(toLevelData(model), PIXELS_PER_METER);
  // The node references compilation adds are the editor's and the tools',
  // not the level's.
  return {
    ...flat,
    bodies: flat.bodies.map(({ node: _n, ...b }) => ({
      ...b,
      ...(b.formation ? { formation: (({ node: _f, ...f }) => f)(b.formation) } : {}),
      objects: b.objects.map(({ node: _o, ...o }) => o as SceneObjectData),
    })),
  };
}

// --- geometry ---------------------------------------------------------------

// An item's local vertex loop — rect corners or polygon vertices, [] for a
// circle. The ordering matches the engine's winding contract (clockwise on
// screen), so an item drawn here and the shape it becomes agree edge for edge.
export function localVertices(item: EdItem): Vec2[] {
  if (item.shape.kind === "circle") return [];
  // A path's verts are an OPEN run rather than a loop, so anything treating the
  // result as closed (the even-odd containment test, the seam walk) must ask
  // the shape kind first; what is shared is the bounds, the handles and the
  // transform, which read a vertex list either way.
  if (item.shape.kind === "poly" || item.shape.kind === "path") return item.shape.verts;
  // A belt's outer loop, flattened: a closed outline like a polygon's, so the
  // bounds, the rubber band and the surface snaps all read it as one. It is
  // DERIVED, never edited vertex by vertex - the vertex interface is gated on
  // `poly` and `path`, and a belt is edited by its wheels.
  if (item.shape.kind === "belt") return beltOutlineLocal(item.shape);
  const hw = item.shape.w / 2;
  const hh = item.shape.h / 2;
  return [new Vec2(-hw, hh), new Vec2(-hw, -hh), new Vec2(hw, -hh), new Vec2(hw, hh)];
}

export type EdBelt = Extract<EdShape, { kind: "belt" }>;

// What `+ Belt` drops with a click: a belt a crate can ride and a ball can roll
// on - two 10 cm wheels 1.5 m apart under a 5 cm band, so the running surface
// is 15 cm round each end (a 24 cm ball is on the scale of it), running at a
// walking 1 m/s. A drag from the first wheel places the second instead.
export const DEFAULT_BELT_LENGTH = 1.5;
export const DEFAULT_BELT_RADIUS = 0.1;
export const DEFAULT_BELT_THICKNESS = 0.05;
export const DEFAULT_BELT_SPEED = 1;

// Do these wheels make a belt? At least two, every radius and the band's
// thickness at least a pixel, every pair of discs
// clear of each other's inside by a pixel more than the build needs (external
// tangents exist only then), and every wheel ON the hull - asked of the build's
// own loop (`beltLoopOf`), so the editor and the build cannot disagree about
// what is a belt. The margins are so no edit can hand the build one it refuses:
// the editor rebuilds the level from the model on every edit, so a gesture that
// let one through would take the preview down mid-drag rather than stall.
// Wheel 0 sitting at the item's origin is kept by the gestures (it has no drag
// grip of its own, and removing it re-origins the item), not demanded here:
// the build reads every centre as an offset, and a hand-edited file with wheel
// 0 elsewhere must still be editable rather than frozen.
export function beltValid(wheels: readonly EdWheel[], thickness: number): boolean {
  if (wheels.length < 2 || !(thickness >= MIN_SHAPE_EXTENT)) return false;
  for (let i = 0; i < wheels.length; i++) {
    const a = wheels[i]!;
    if (!(a.r >= MIN_SHAPE_EXTENT) || !a.c.isFinite()) return false;
    for (let j = i + 1; j < wheels.length; j++) {
      const b = wheels[j]!;
      if (!(a.c.distanceTo(b.c) > Math.abs(a.r - b.r) + MIN_SHAPE_EXTENT)) return false;
    }
  }
  return beltLoopOf({ wheels: wheels.map((w) => ({ x: w.c.x, y: w.c.y, r: w.r })), thickness }) !== null;
}

// The one writer of a belt's geometry: applies `patch` if the result is still a
// belt and reports whether it did. A refused edit leaves the belt exactly as it
// was, so a drag stalls at the last valid shape - what `setPolyVerts` does for
// a polygon that would turn inside out. The wheel list is REPLACED, never
// edited in place (see `EdWheel`).
export function setBelt(
  item: EdItem,
  patch: { wheels?: readonly EdWheel[]; thickness?: number; speed?: number },
): boolean {
  if (item.shape.kind !== "belt") return false;
  const wheels = patch.wheels ?? item.shape.wheels;
  const thickness = patch.thickness ?? item.shape.thickness;
  if (!beltValid(wheels, thickness)) return false;
  item.shape.wheels = [...wheels];
  item.shape.thickness = thickness;
  if (patch.speed !== undefined) item.shape.speed = patch.speed;
  return true;
}

// One wheel moved to `c` or resized to `r`, through `setBelt`.
export function setBeltWheel(item: EdItem, index: number, patch: { c?: Vec2; r?: number }): boolean {
  if (item.shape.kind !== "belt") return false;
  const w = item.shape.wheels[index];
  if (!w) return false;
  const wheels = [...item.shape.wheels];
  wheels[index] = { c: patch.c ?? w.c, r: patch.r ?? w.r };
  return setBelt(item, { wheels });
}

// Where a belt's grips sit, in WORLD metres: every wheel's centre (dragged like
// a path vertex, wheel 0's being the item's own position), one radius grip per
// wheel on its own rim, on the side facing away from the middle of the belt so
// dragging it out makes the wheel bigger, and the midpoint of every run's outer
// line, which inserts a wheel there (`beltInsertWheel`). Runs in loop order,
// each naming the wheel it leaves.
export interface BeltGrips {
  centres: Vec2[];
  radii: Vec2[];
  runs: { mid: Vec2; from: number }[];
}

export function beltGrips(item: EdItem): BeltGrips | null {
  if (item.shape.kind !== "belt") return null;
  const s = item.shape;
  let middle = Vec2.ZERO;
  for (const w of s.wheels) middle = middle.add(w.c);
  middle = middle.div(s.wheels.length);
  const radii = s.wheels.map((w) => {
    const away = w.c.sub(middle);
    const u = away.length() > 1e-9 ? away.normalized() : new Vec2(1, 0);
    return toWorld(item, w.c.add(u.mul(w.r)));
  });
  const loop = beltLoopOfShape(s);
  const runs: BeltGrips["runs"] = [];
  if (loop) {
    loop.segments.forEach((seg, i) => {
      if (seg.kind !== "run") return;
      const arc = loop.segments[i - 1];
      runs.push({
        mid: toWorld(item, seg.from.add(seg.to).mul(0.5)),
        from: arc && arc.kind === "arc" ? arc.wheel : 0,
      });
    });
  }
  return { centres: s.wheels.map((w) => toWorld(item, w.c)), radii, runs };
}

// Insert a wheel under the midpoint of the run that leaves wheel `from`: the
// size of the smaller of that run's two wheels, set so its band just TOUCHES
// the run's outer line there - which changes nothing about the loop (a wheel
// touching the band is on it, with an arc of no sweep), so inserting a wheel
// and placing it is one gesture, as a path's edge midpoint is. Placed after
// `from` in the list. The new wheel's index, or -1 if the belt refuses it (a
// disc that would sit inside another).
export function beltInsertWheel(item: EdItem, from: number): number {
  if (item.shape.kind !== "belt") return -1;
  const s = item.shape;
  const loop = beltLoopOfShape(s);
  if (!loop) return -1;
  const k = loop.segments.findIndex((seg) => seg.kind === "arc" && seg.wheel === from);
  const run = loop.segments[k + 1];
  const next = loop.segments[(k + 2) % loop.segments.length];
  if (k < 0 || !run || run.kind !== "run" || !next || next.kind !== "arc") return -1;
  const r = Math.min(s.wheels[from]!.r, s.wheels[next.wheel]!.r);
  const mid = run.from.add(run.to).mul(0.5);
  const c = mid.sub(run.normal.mul(r + s.thickness));
  const wheels = [...s.wheels];
  wheels.splice(from + 1, 0, { c, r });
  return setBelt(item, { wheels }) ? from + 1 : -1;
}

// Remove wheel `index`, never below two. Wheel 0 is the item's own position,
// so removing it moves the item onto the wheel that takes its place and every
// other centre by the same amount - the belt stays where it was. False if the
// belt refuses what is left (a wheel the removed one held out that now falls
// inside the hull).
export function beltRemoveWheel(item: EdItem, index: number): boolean {
  if (item.shape.kind !== "belt") return false;
  const s = item.shape;
  if (s.wheels.length <= 2 || !s.wheels[index]) return false;
  const rest = s.wheels.filter((_, j) => j !== index);
  const origin = rest[0]!.c;
  const shifted = rest.map((w, j) => ({ c: j === 0 ? Vec2.ZERO : w.c.sub(origin), r: w.r }));
  const pos = toWorld(item, origin);
  if (!setBelt(item, { wheels: shifted })) return false;
  item.pos = pos;
  return true;
}

// The perimeter of a belt's loop in metres, and how long one lap of its surface
// takes at its speed (Infinity for a belt that does not run) - the inspector's
// readout, from the same loop the build makes.
export function beltLap(s: EdBelt): { perimeter: number; lap: number } | null {
  const loop = beltLoopOfShape(s);
  if (!loop) return null;
  return { perimeter: loop.total, lap: s.speed === 0 ? Infinity : loop.total / Math.abs(s.speed) };
}

// A belt shape in the on-disk form (`ShapeData`'s `belt`), still in metres -
// what `outlineOfData` and `beltLoopOf` take, so the editor's belt is drawn by
// the one outline the game draws it by.
export function beltShapeData(s: EdBelt): Extract<ShapeData, { kind: "belt" }> {
  return {
    kind: "belt",
    wheels: s.wheels.map((w) => ({ x: w.c.x, y: w.c.y, r: w.r })),
    thickness: s.thickness,
    speed: s.speed,
    ...s.look,
  };
}

// The key a belt's derived geometry is cached against: everything the loop is
// made of. A shape is replaced field by field by its gestures, so the caches
// below are checked rather than trusted.
function beltKey(s: EdBelt): string {
  return `${s.thickness}|${s.wheels.map((w) => `${w.c.x},${w.c.y},${w.r}`).join(";")}`;
}

// The belt's loop in the item's frame, or null for wheels that make none -
// which the build refuses and `setBelt` never lets through, so only a
// hand-edited file reaches it. Cached per shape: every frame of the editor
// asks for it several times over (the draw, the grips, the pick).
const beltLoops = new WeakMap<EdBelt, { key: string; loop: BeltLoop | null }>();
export function beltLoopOfShape(s: EdBelt): BeltLoop | null {
  const key = beltKey(s);
  const hit = beltLoops.get(s);
  if (hit && hit.key === key) return hit.loop;
  const loop = beltLoopOf(beltShapeData(s));
  beltLoops.set(s, { key, loop });
  return loop;
}

// The band's OUTER loop, flattened: a closed outline like a polygon's, so the
// bounds, the rubber band and the surface snaps all read it as one. Cached for
// the reason the loop is.
const beltOutlines = new WeakMap<EdBelt, { key: string; verts: Vec2[] }>();
function beltOutlineLocal(s: EdBelt): Vec2[] {
  const key = beltKey(s);
  const hit = beltOutlines.get(s);
  if (hit && hit.key === key) return hit.verts;
  const o = outlineOfData(beltShapeData(s));
  // Degenerate wheels draw as one disc; as a vertex loop that is a polygon
  // round it, so every consumer still gets a closed outline.
  const verts =
    o.kind === "poly"
      ? [...o.verts]
      : Array.from({ length: 24 }, (_, k) => {
          const t = (k / 24) * Math.PI * 2;
          const r = o.kind === "circle" ? o.radius : 0;
          return new Vec2(Math.cos(t) * r, Math.sin(t) * r);
        });
  beltOutlines.set(s, { key, verts });
  return verts;
}

// The band's INNER loop - the wheels' side of it - in the item's frame, or
// empty for a belt that builds none: the hole a click inside the belt falls
// through (`pointInBody`), since the inside of a belt is where an author puts
// the props that stand for its wheels.
function beltInnerLocal(s: EdBelt): readonly Vec2[] {
  const o = outlineOfData(beltShapeData(s));
  return o.kind === "poly" ? (o.hole ?? []) : [];
}

export function worldVertices(item: EdItem): Vec2[] {
  return localVertices(item).map((v) => toWorld(item, v));
}

// Convex hull of a point set (Andrew's monotone chain), returned in the winding
// the engine expects. What the poly tool falls back to when the points clicked
// out do not describe a shape - a loop that crosses itself has no inside, and
// the hull is the nearest thing to what was drawn. It is also what a CAMERA
// REGION takes outright, since a region must stay convex (`polyMustBeConvex`).
// Returns [] if the points are collinear or too few.
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

// Must this item's polygon stay CONVEX, or may it be any simple outline?
//
// A scene polygon may be concave: the loader cuts it into the convex pieces the
// engine's convex-only primitive needs (`makeShapes` in level/buildBodies.ts),
// so an author draws the shape the geometry has - an L-shaped ledge, a notched
// pillar - instead of overlapping several convex ones by hand.
//
// A camera region may not, and it is the one exception because nothing cuts it
// up: a region is tested by its face half-planes and grown into a buffer zone by
// offsetting them (`pointInRegion`, `pathOutlineGrown`), and both of those read
// a notch as solid. Refusing the drag is what keeps the zone that is tested the
// zone that is drawn.
export function polyMustBeConvex(item: EdItem): boolean {
  return item.layer === "camera";
}

// The only writer of a polygon's vertices. It writes the loop AS GIVEN and
// leaves `pos` exactly where it was - a corner edit changes the outline and
// nothing else - and it refuses a loop that is not a shape at all, leaving the
// outline as it was rather than saving one that crosses itself (or, for a
// camera region, one that is not convex). Returns whether the edit was
// accepted.
//
// IT DOES NOT RE-CENTRE. It used to: the loop was re-centred on its area
// centroid and `pos` moved to compensate, which kept an item's `pos` its own
// centre of mass at the price of making every corner drag a MOVE of the object
// inside its body. Everything else in the body stayed put while the polygon's
// placement slid out from under it. `pos` is the
// placement the author put the shape at; where its mass is, is a question about
// the outline, and `shapeCentre` derives it (`bodyCentroid` is the one caller
// that needs it). A shape being CREATED still starts centred - see
// `centreShapeOrigin`, which the draw gestures call once, at birth.
export function setPolyVerts(item: EdItem, verts: readonly Vec2[]): boolean {
  if (item.shape.kind !== "poly" || verts.length < 3) return false;
  const ordered = polySignedArea2(verts) >= 0 ? [...verts] : [...verts].reverse();
  if (polyMustBeConvex(item) ? !isConvexLoop(ordered) : !isSimpleLoop(ordered)) return false;
  item.shape.verts = ordered.map((v) => v.clone());
  return true;
}

// Move an item's origin onto its own outline's centre, taking the shift back out
// of the vertices so nothing drawn moves: `pos` lands on the polygon's area
// centroid (or a curve's node average), which is where a freshly drawn shape
// wants its origin - the transform gizmo, the rotate knob and the rot° field all
// turn the shape about `pos`, and a shape that turns about a corner of itself is
// not what clicking out an outline asks for.
//
// Called at CREATION and nowhere else. Doing it on every write is what made a
// corner drag move the object (see `setPolyVerts`); doing it once, on a shape
// that has no placement yet to disturb, costs nothing and is what makes a drawn
// outline's `pos` mean something.
export function centreShapeOrigin(item: EdItem): void {
  const s = item.shape;
  if (s.kind === "poly") {
    if (s.verts.length < 3) return;
    const c = polyCentroid(s.verts);
    s.verts = s.verts.map((v) => v.sub(c));
    item.pos = item.pos.add(c.rotated(item.rot));
    return;
  }
  if (s.kind !== "path" || !s.verts.length) return;
  // A polyline has no area centroid, so the node average is its centre. The
  // handles are offsets from their own node, so they are untouched by the shift
  // - which is the reason they are stored as offsets rather than as absolute
  // control points.
  const c = s.verts.reduce((a, b) => a.add(b), Vec2.ZERO).div(s.verts.length);
  s.verts = s.verts.map((v) => v.sub(c));
  item.pos = item.pos.add(c.rotated(item.rot));
}

// The only writer of a camera path's vertices, and the mirror of
// `setPolyVerts` - it drops consecutive duplicates, requires two verts left
// over, and leaves `pos` where it is for the same reason (a node edit is not a
// move of the curve; `centreShapeOrigin` places the origin once, at creation).
//
// There is deliberately no simplicity or convexity rule: a path may cross
// itself, that being exactly what a switchback is.
//
// `handles` and `keys` are read by the SAME index as `verts`, and both default
// to the item's own - so a caller that only renumbers the points (a deletion,
// an insertion) passes the arrays it renumbered the same way, and a caller
// that only moves them (a drag, a resize) passes nothing and keeps both.
export function setPathVerts(
  item: EdItem,
  verts: readonly Vec2[],
  handles?: readonly { in: Vec2; out: Vec2 }[],
  keys?: readonly EdPathKey[],
): boolean {
  if (item.shape.kind !== "path") return false;
  const src = handles ?? item.shape.handles;
  const srcK = keys ?? item.shape.keys;
  const kept: Vec2[] = [];
  const keptH: { in: Vec2; out: Vec2 }[] = [];
  const keptK: EdPathKey[] = [];
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]!;
    const last = kept[kept.length - 1];
    if (last && last.distanceTo(v) < 1e-9) continue;
    kept.push(v);
    keptH.push(src[i] ? { in: src[i]!.in, out: src[i]!.out } : ZERO_HANDLE());
    keptK.push(srcK[i] ? { ...srcK[i]! } : NO_KEY());
  }
  if (kept.length < 2) return false;
  item.shape.verts = kept;
  item.shape.handles = keptH;
  item.shape.keys = keptK;
  return true;
}

export const ZERO_HANDLE = (): { in: Vec2; out: Vec2 } => ({ in: Vec2.ZERO, out: Vec2.ZERO });

// A camera path's nodes in its own local frame, handles included - what the
// flattener wants. Absent entries read as corners, so a hand-built shape or one
// mid-edit can never produce a hole.
export function pathNodes(item: EdItem): PathNode[] {
  if (item.shape.kind !== "path") return [];
  const h = item.shape.handles;
  return item.shape.verts.map((p, i) => ({
    p,
    in: h[i]?.in ?? Vec2.ZERO,
    out: h[i]?.out ?? Vec2.ZERO,
  }));
}

// The curve as the polyline everything draws and picks it by, in WORLD metres -
// the same flattening the camera controller rides, so what an author clicks and
// what the camera releases at cannot disagree about where the path is.
export function pathPolyline(item: EdItem): Vec2[] {
  return flattenPath(pathNodes(item)).map((v) => toWorld(item, v));
}

// Reverse a path's direction of travel. Direction IS the design - the lookahead
// never flips - so re-drawing a long path backwards is the alternative, and
// this is the inspector action that avoids it.
export function reversePathVerts(item: EdItem): boolean {
  if (item.shape.kind !== "path") return false;
  item.shape.verts = [...item.shape.verts].reverse();
  // Each node's handles swap with the reversal: `in` faces the previous node
  // and `out` the next, and reversing the order swaps which is which. Reversing
  // the array alone would turn every smooth node into a mirrored kink.
  item.shape.handles = [...item.shape.handles].reverse().map((h) => ({ in: h.out, out: h.in }));
  // A key is the node's, and goes where the node goes.
  item.shape.keys = [...item.shape.keys].reverse();
  return true;
}

// Give every node the tangent that makes the route smooth through it: the
// Catmull-Rom handle, a third of the way along the chord between the node's two
// neighbours. That is the standard interpolating spline, and it is what "smooth
// this path" means - the curve still passes through every authored point, and
// only the way it arrives at them changes.
//
// The end nodes take the one neighbour they have, so a two-node path smooths to
// exactly the straight line it already was.
export function smoothPathNodes(item: EdItem): boolean {
  if (item.shape.kind !== "path") return false;
  const v = item.shape.verts;
  item.shape.handles = v.map((p, i) => {
    const prev = v[i - 1] ?? p;
    const next = v[i + 1] ?? p;
    const t = next.sub(prev).div(3);
    return { in: t.neg(), out: t };
  });
  return true;
}

// ...and the inverse: every node a corner again, which is what a freshly drawn
// path is and what the whole handle set collapses to on disk.
export function sharpenPathNodes(item: EdItem): boolean {
  if (item.shape.kind !== "path") return false;
  item.shape.handles = item.shape.verts.map(() => ZERO_HANDLE());
  return true;
}

// Resize `item` to `base` scaled by (fx, fy) in its own frame. A circle takes
// the mean of the two, since it has one radius and a squashed circle is not a
// shape this format has - which is the same answer `radius` handle gives.
export function scaleShape(
  item: EdItem,
  base: EdShape,
  fx: number,
  fy: number,
  // What a resulting extent is rounded to, so a gizmo drag lands on the same
  // grid a corner drag does. A polygon is deliberately exempt: rounding each
  // vertex on its own is not a size, it is a different shape.
  round: (v: number) => number = (v) => v,
): void {
  const floor = (v: number) => Math.max(MIN_SHAPE_EXTENT, round(v));
  if (item.shape.kind === "rect" && base.kind === "rect") {
    item.shape.w = floor(base.w * Math.abs(fx));
    item.shape.h = floor(base.h * Math.abs(fy));
    return;
  }
  if (item.shape.kind === "circle" && base.kind === "circle") {
    item.shape.r = floor((base.r * (Math.abs(fx) + Math.abs(fy))) / 2);
    return;
  }
  if (item.shape.kind === "poly" && base.kind === "poly") {
    // Scaled about the item's own origin, which is where the gizmo's scale
    // handles pivot too, so the drag and the shape agree about what is standing
    // still. Scaling an outline leaves it exactly as convex or as simple as it
    // was, so `setPolyVerts` refuses nothing here.
    setPolyVerts(
      item,
      base.verts.map((v) => new Vec2(v.x * fx, v.y * fy)),
    );
    return;
  }
  if (item.shape.kind === "belt" && base.kind === "belt") {
    // Every wheel's centre scales with the frame, as a vertex would, about
    // wheel 0 (the item's origin, where the gizmo pivots); each radius and the
    // band's thickness take the mean of the two factors, as a circle's radius
    // does. The SPEED is a rate the author chose, not an extent of the shape,
    // and a resize leaves it alone. Through `setBelt`, so a scale that would
    // sink one wheel inside another, or inside the hull, is refused rather than
    // handed to the build.
    const mean = (Math.abs(fx) + Math.abs(fy)) / 2;
    setBelt(item, {
      wheels: base.wheels.map((w) => ({
        c: new Vec2(w.c.x * fx, w.c.y * fy),
        r: floor(w.r * mean),
      })),
      thickness: floor(base.thickness * mean),
    });
    return;
  }
  if (item.shape.kind === "path" && base.kind === "path") {
    // A path scales like any other vertex list, and its tangent handles scale
    // with it - they are offsets in the same frame, so a stretched curve keeps
    // its shape. What is NOT scaled is `range` or `lookahead`: those are
    // authored distances in metres, not extents of the shape, and widening the
    // corridor because the route got longer is not what a resize means.
    setPathVerts(
      item,
      base.verts.map((v) => new Vec2(v.x * fx, v.y * fy)),
      base.handles.map((h) => ({
        in: new Vec2(h.in.x * fx, h.in.y * fy),
        out: new Vec2(h.out.x * fx, h.out.y * fy),
      })),
    );
  }
}

// One on-disk pixel. A shape scaled to nothing can never be grabbed again, and
// one scaled through zero is inside out.
const MIN_SHAPE_EXTENT = 0.01;

// Half-extents of an item's (unrotated) bounding box, i.e. centre → top-left.
export function halfExtents(item: EdItem): Vec2 {
  if (item.shape.kind === "circle") return new Vec2(item.shape.r, item.shape.r);
  if (item.shape.kind === "rect") return new Vec2(item.shape.w / 2, item.shape.h / 2);
  // A curve's control points, not only its nodes: a cubic never leaves its
  // control polygon, so this bounds the drawn route rather than the points it
  // happens to pass through - which is what the rotate knob and the label are
  // placed against.
  if (item.shape.kind === "path") {
    let px = 0;
    let py = 0;
    for (const n of pathNodes(item)) {
      for (const q of [n.p, n.p.add(n.in), n.p.add(n.out)]) {
        px = Math.max(px, Math.abs(q.x));
        py = Math.max(py, Math.abs(q.y));
      }
    }
    return new Vec2(px, py);
  }
  let x = 0;
  let y = 0;
  for (const v of localVertices(item)) {
    x = Math.max(x, Math.abs(v.x));
    y = Math.max(y, Math.abs(v.y));
  }
  return new Vec2(x, y);
}

// The point a move snaps to the grid, in the world: the top-left corner or
// vertex of the top-left piece. Every candidate the items offer is gathered -
// a polygon's vertices and a rect's four corners, both as turned, and the box
// corner of anything else (a circle has no corner of its own) - and the one
// nearest the top-left of their joint box wins. A polygon's centre is wherever
// its hull's extremes put it, and a body's origin wherever it was authored, so
// snapping either carries grid-drawn corners off the grid; snapping a corner
// keeps them on (while nothing is turned). Ties - a diamond's top and left
// corners - go to the higher point, then the further left, so the choice is
// the same every time the thing is picked up.
export function moveSnapPoint(items: readonly EdItem[]): Vec2 {
  const points: Vec2[] = [];
  for (const i of items) {
    const s = i.shape;
    if (s.kind === "poly") {
      for (const v of s.verts) points.push(i.pos.add(v.rotated(i.rot)));
    } else if (s.kind === "rect") {
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        points.push(i.pos.add(new Vec2((x * s.w) / 2, (y * s.h) / 2).rotated(i.rot)));
      }
    } else {
      points.push(i.pos.sub(halfExtents(i)));
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  const corner = new Vec2(minX, minY);
  const EPS = 1e-9;
  let best = points[0] ?? Vec2.ZERO;
  let bestD = Infinity;
  for (const p of points) {
    const d = p.distanceTo(corner);
    if (
      d < bestD - EPS ||
      (d < bestD + EPS && (p.y < best.y - EPS || (p.y < best.y + EPS && p.x < best.x)))
    ) {
      best = p;
      bestD = Math.min(bestD, d);
    }
  }
  return best;
}

// One item's axis-aligned bounds IN THE WORLD, rotation included - the box it
// actually occupies on screen, which is what "this shape is inside that one"
// has to be decided from. `halfExtents` is deliberately not that: it is the
// unrotated approximation snapping and `bodyBounds` are written against, and a
// long bar turned 45° occupies a far bigger box than it reports.
export function itemBounds(item: EdItem): { min: Vec2; max: Vec2 } {
  if (item.shape.kind === "circle") {
    const r = new Vec2(item.shape.r, item.shape.r);
    return { min: item.pos.sub(r), max: item.pos.add(r) };
  }
  // A rect and a convex polygon are both the hull of their vertices, so the
  // placed loop's extremes are the box. A camera path is the hull of its DRAWN
  // curve and not of its nodes: a bowed edge leaves the node hull, and a box
  // that does not contain what is on screen is a box the pick rejects before it
  // ever tests the shape.
  const verts = item.shape.kind === "path" ? pathPolyline(item) : worldVertices(item);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const w of verts) {
    minX = Math.min(minX, w.x);
    minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x);
    maxY = Math.max(maxY, w.y);
  }
  if (!verts.length) return { min: item.pos, max: item.pos };
  return { min: new Vec2(minX, minY), max: new Vec2(maxX, maxY) };
}

// Is one box wholly inside another, and STRICTLY smaller? The strictness is
// what makes "keep taking the box inside this one" terminate: area falls at
// every step, so two identical boxes cannot hand the answer back and forth.
export function boundsInside(
  inner: { min: Vec2; max: Vec2 },
  outer: { min: Vec2; max: Vec2 },
): boolean {
  if (
    inner.min.x < outer.min.x ||
    inner.min.y < outer.min.y ||
    inner.max.x > outer.max.x ||
    inner.max.y > outer.max.y
  ) {
    return false;
  }
  const area = (b: { min: Vec2; max: Vec2 }) => (b.max.x - b.min.x) * (b.max.y - b.min.y);
  return area(inner) < area(outer);
}

// Axis-aligned bounds of a group of items, from their unrotated extents (the
// same approximation `halfExtents` gives snapping). Empty group → a zero box.
export function bodyBounds(items: readonly EdItem[]): { min: Vec2; max: Vec2 } {
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
  if (item.shape.kind === "path") {
    // A polyline is its segments: the band touches if either end of a segment
    // is in the rect or the segment crosses one of its sides. No containment
    // question, an open run having no inside for the rect to be in.
    // The FLATTENED curve, not the node points: a bowed segment may pass
    // through the band with both its nodes outside it.
    const verts = pathPolyline(item);
    const corners = [min, new Vec2(max.x, min.y), max, new Vec2(min.x, max.y)];
    for (const v of verts) {
      if (v.x >= min.x && v.x <= max.x && v.y >= min.y && v.y <= max.y) return true;
    }
    for (let i = 0; i + 1 < verts.length; i++) {
      for (let j = 0; j < 4; j++) {
        if (segmentsIntersect(verts[i]!, verts[i + 1]!, corners[j]!, corners[(j + 1) % 4]!)) {
          return true;
        }
      }
    }
    return false;
  }
  // A belt is a closed loop like a polygon's, and not centred on its origin, so
  // the box-about-the-origin SAT below would be the wrong box.
  if (item.shape.kind === "poly" || item.shape.kind === "belt") {
    // Directly, rather than by SAT: a separating axis exists only between
    // CONVEX shapes, and an authored outline may have a notch the band sits in
    // without touching it. Three questions cover every arrangement of two simple
    // outlines - a vertex of one inside the other, either way round, or a pair
    // of edges that cross.
    const verts = worldVertices(item);
    const corners = [min, new Vec2(max.x, min.y), max, new Vec2(min.x, max.y)];
    for (const v of verts) {
      if (v.x >= min.x && v.x <= max.x && v.y >= min.y && v.y <= max.y) return true;
    }
    for (const c of corners) if (loopContainsPoint(verts, c)) return true;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i]!;
      const b = verts[(i + 1) % verts.length]!;
      for (let j = 0; j < 4; j++) {
        if (segmentsIntersect(a, b, corners[j]!, corners[(j + 1) % 4]!)) return true;
      }
    }
    return false;
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
  // The drawn curve, for the reason `bodyIntersectsRect` reads it: a bowed
  // segment may leave the band with both its nodes inside it.
  if (item.shape.kind === "path") {
    return pathPolyline(item).every(
      (w) => w.x >= min.x && w.x <= max.x && w.y >= min.y && w.y <= max.y,
    );
  }
  if (item.shape.kind === "circle") {
    const r = item.shape.r;
    return (
      item.pos.x - r >= min.x &&
      item.pos.x + r <= max.x &&
      item.pos.y - r >= min.y &&
      item.pos.y + r <= max.y
    );
  }
  // A rect or a polygon lies within the hull of its vertices, so every vertex
  // inside is exactly "the whole shape is inside" — rotation included.
  return worldVertices(item).every(
    (w) => w.x >= min.x && w.x <= max.x && w.y >= min.y && w.y <= max.y,
  );
}

// A camera path is a line rather than an area, so it is picked by a band around
// it - the arrow note's band, since both are segments and both are grabbed the
// same way. `NOTE_ARROW_THICKNESS` is in scene pixels; halved and converted, it
// is how far from the polyline a click may land.
export const PATH_PICK_HALF_WIDTH = (NOTE_ARROW_THICKNESS / 2) * PX;

// Distance from a point to an open polyline, through the same projection the
// camera controller rides it by - one implementation, so what the editor picks
// and what the camera releases at cannot disagree about where the path is.
export function distanceToPolyline(verts: readonly Vec2[], p: Vec2): number {
  return projectOntoPolyline(buildPolylineIndex(verts), p).dist;
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
  // A polyline has no inside, so it is picked by a band around it - the same
  // band an arrow note is picked by, since both are segments rather than areas.
  if (item.shape.kind === "path") {
    // A ROOT is picked anywhere on its bar, which at its base is far wider
    // than the band: a trunk is clicked where it is drawn.
    const reach = item.root ? Math.max(PATH_PICK_HALF_WIDTH, item.shape.width / 2) : PATH_PICK_HALF_WIDTH;
    return distanceToPolyline(flattenPath(pathNodes(item)), l) <= reach;
  }
  if (item.shape.kind === "rect") {
    return Math.abs(l.x) <= item.shape.w / 2 && Math.abs(l.y) <= item.shape.h / 2;
  }
  // A belt is picked where it COLLIDES: on the band, or on a wheel (whose disc
  // is solid), and not in the hollow between the wheels - that is where an
  // author puts the props that stand for the wheels, and a click there is
  // meant for them.
  if (item.shape.kind === "belt") {
    const s = item.shape;
    if (!loopContainsPoint(localVertices(item), l)) return false;
    const hole = beltInnerLocal(s);
    if (hole.length < 3 || !loopContainsPoint(hole, l)) return true;
    return s.wheels.some((w) => w.c.distanceTo(l) <= w.r + s.thickness);
  }
  // Even-odd, not "inside every face's half-plane": the half-plane answer is the
  // convex one and fills in a notch, so clicking through the gap in a C-shaped
  // wall would pick the wall.
  return loopContainsPoint(localVertices(item), l);
}

// --- bodies -----------------------------------------------------------------

// Every item of a unit (`EdItem.unit`: a body, or a node no body carries),
// in model order.
export function bodyMembers(items: readonly EdItem[], unit: string): EdItem[] {
  return items.filter((i) => i.unit === unit);
}

// The selection an item click means: the whole body it is in. A body IS one
// object as far as the level is concerned, so picking one of its pieces and
// picking it are the same act (Alt+click is what reaches past this to a single
// object).
export function pickBodyOf(items: readonly EdItem[], item: EdItem): EdItem[] {
  return bodyMembers(items, item.unit);
}

// THE BODIES OF A MODEL, in the order their first object appears - which is the
// order `toLevelData` writes them and therefore the order a chain's body index
// counts in. One definition, so the save path and the outliner cannot disagree
// about what a body is or how many there are.
export function bodyRuns(items: readonly EdItem[]): EdItem[][] {
  const runs: EdItem[][] = [];
  const byId = new Map<string, EdItem[]>();
  for (const i of items) {
    const existing = byId.get(i.unit);
    if (existing) {
      existing.push(i);
      continue;
    }
    const run = [i];
    byId.set(i.unit, run);
    runs.push(run);
  }
  return runs;
}

// WHAT KIND OF THING A UNIT IS: its body's kind, or what it is made of. Its
// name is its node's (the scene tree shows both).
export function bodyLabel(members: readonly EdItem[]): string {
  return bodyKindLabel(members);
}

function bodyKindLabel(members: readonly EdItem[]): string {
  const lead = bodyLead(members);
  if (lead?.body) return lead.body.kind;
  const first = members[0];
  if (!first) return "empty";
  if (first.object === "light") return "light";
  if (first.object === "model") return "model";
  // A body of nothing but a formation: a background guide's rock.
  if (first.object === "formation") return "backdrop";
  if (first.layer === "camera") return "camera";
  if (first.object === "shelter") return "shelter";
  if (first.object === "fog") return "fog";
  if (first.layer === "notes") return first.note.kind === "checkpoint" ? "checkpoint" : "note";
  return "decor";
}

// ...and what one of its objects is called: the type first, because that is the
// thing being distinguished, then enough of its size to tell two of them apart.
export function objectLabel(item: EdItem, metresToPx: number): string {
  const n = (v: number) => Math.round(v * metresToPx).toString();
  if (item.object === "light") {
    const reach = item.shape.kind === "circle" ? ` ${n(item.shape.r)}` : "";
    return `${item.light.kind}${reach}`;
  }
  // A chain's tie point. Hook-only scenery used to share the word as a
  // `BodyKind`; it is the `passable` flag now, so nothing else answers to it.
  if (item.object === "anchor") return `anchor ${item.anchorId}`;
  if (item.object === "model") return `model ${item.modelRef.name || "(none)"}`;
  if (item.object === "decoration" && item.decoration) {
    const d = item.decoration;
    // A material layer by its material (`dirt material-x1y2z`).
    const what = d.kind === "material" ? String(d.settings?.["material"] ?? d.kind) : d.kind;
    return `${what} ${d.id}${d.lost ? " (lost)" : ""}`;
  }
  // A formation by its generator, and by its id when a decoration names it.
  if (item.object === "formation" && item.formation) {
    const f = item.formation;
    return `formation ${f.generator}${f.variant ? ` ${f.variant}` : ""}`;
  }
  // A checkpoint is named by the name it is REACHED by (`?checkpoint=vines`),
  // since that is what tells two of them apart; an unnamed one says so, being a
  // marker nothing can ask for yet.
  if (item.layer === "notes") {
    if (item.note.kind === "checkpoint") return `checkpoint ${item.note.text.trim() || "(unnamed)"}`;
    return item.note.kind === "arrow" ? "arrow" : "text";
  }
  if (item.layer === "camera") return item.shape.kind === "path" ? "path" : "region";
  if (item.object === "shelter") return "shelter";
  if (item.object === "fog") return "fog";
  const form =
    item.shape.kind === "rect"
      ? `${n(item.shape.w)}×${n(item.shape.h)}`
      : item.shape.kind === "circle"
        ? `r${n(item.shape.r)}`
        : item.shape.kind === "belt"
          ? `${item.shape.wheels.length} wheels t${n(item.shape.thickness)}`
          : `${item.shape.verts.length}v`;
  // A root piece is a trunk or a branch, which is what tells one from another
  // in a tree of them; a scene path that is not one is the bar it always was.
  if (item.root) return `${item.root.parent === null ? "root" : "branch"} ${form}`;
  return `${item.shape.kind} ${form}`;
}

// Area of an item's shape, in m².
export function shapeArea(item: EdItem): number {
  if (item.shape.kind === "circle") return Math.PI * item.shape.r * item.shape.r;
  if (item.shape.kind === "rect") return item.shape.w * item.shape.h;
  // A CURVE weighs what its bar weighs: the pieces the stroke tiles it with,
  // which is what the build weighs (`makeShapes`), so the panel's readout and
  // the body's mass are the one answer. A camera path is not a piece of a body
  // and nothing weighs it, which its own zero area says.
  if (item.shape.kind === "path") {
    if (item.layer !== "scene") return 0;
    return strokeCurve(pathNodes(item), item.shape.width, item.shape.tip).pieces.reduce(
      (a, piece) => a + Math.abs(polySignedArea2(piece)) / 2,
      0,
    );
  }
  // A BELT weighs what its pieces weigh - a disc of `r + thickness` per wheel
  // and a quad per run, overlaps and all - which is what the build weighs
  // (docs/conveyors.md, "The build"). A belt only builds on a static, whose mass
  // nothing reads, but the pieces' masses are what place its body's origin, and
  // that is what `shapeCentre` beside this has to agree with.
  if (item.shape.kind === "belt") {
    return beltPieces(item.shape).reduce((a, p) => a + p.area, 0);
  }
  return Math.abs(polySignedArea2(item.shape.verts)) / 2;
}

// A belt's build pieces as areas at centres, in the item's frame: every
// wheel's disc at its centre and every run's quad at its centroid, as
// `makePieces` cuts them. Wheels that make no belt build nothing and weigh
// nothing here.
function beltPieces(s: EdBelt): { area: number; at: Vec2 }[] {
  const loop = beltLoopOfShape(s);
  if (!loop) return [];
  const discs = s.wheels.map((w) => {
    const r = w.r + s.thickness;
    return { area: Math.PI * r * r, at: w.c };
  });
  const quads = beltRunQuads(loop).map((q) => ({
    area: Math.abs(polySignedArea2(q)) / 2,
    at: polyCentroid(q),
  }));
  return [...discs, ...quads];
}

// Mass of an item's shape, in kg - the same answer `ShapeGeometry.computeMass`
// gives the built body, asked through the same function rather than restated
// here. Area is NOT a stand-in for it: a circle is a sphere and a rect or
// polygon a slab of `SCENE_DEPTH`, so the two stopped being proportional the
// moment masses became physical.
export function shapeMass(item: EdItem): number {
  return prismMass(shapeArea(item), item.thickness, item.density);
}

// Where one item's own mass sits, in world metres - the point the piece (or
// pieces) it builds into are mounted at, which is NOT its `pos`: a rect and a
// circle are centred on their origin, but a polygon's origin is wherever the
// author left it and its mass is at its area centroid, and a curve's is spread
// along the bar the stroke tiles it with.
//
// The same three answers `shapeArea` gives, from the same geometry and in the
// same order, because the pair is one question: the build weighs every piece it
// cuts a shape into and mounts the body at their combined centre of mass
// (`mountPieces`), so anything here that disagreed would be the editor drawing a
// body turning about a point the sim does not have.
export function shapeCentre(item: EdItem): Vec2 {
  const s = item.shape;
  if (s.kind === "rect" || s.kind === "circle") return item.pos;
  if (s.kind === "path") {
    let total = 0;
    let acc = Vec2.ZERO;
    for (const piece of strokeCurve(pathNodes(item), s.width, s.tip).pieces) {
      const a = Math.abs(polySignedArea2(piece)) / 2;
      total += a;
      acc = acc.add(polyCentroid(piece).mul(a));
    }
    // A camera path is stroked for its bar all the same (nothing weighs one), and
    // a degenerate run has no area to weigh: both fall back to the placement.
    return total > 0 ? toWorld(item, acc.div(total)) : item.pos;
  }
  if (s.kind === "belt") {
    let total = 0;
    let acc = Vec2.ZERO;
    for (const p of beltPieces(s)) {
      total += p.area;
      acc = acc.add(p.at.mul(p.area));
    }
    return total > 0 ? toWorld(item, acc.div(total)) : item.pos;
  }
  return toWorld(item, polyCentroid(s.verts));
}

// A group's centre of mass - the point `buildLevelBodies` puts the compound
// body's origin at, and therefore the point it rotates about. Weighted by mass,
// not the bounding-box centre: every rigid-body lever arm in the engine is
// measured from the body origin, so the two have to agree.
//
// Measured over the group's COLLIDING shapes alone. Decoration brings no shape
// to the built body, so it brings no mass to this sum either - welding a
// backdrop onto a body may not shift the point that body turns about, or the
// editor would be rotating a group about a point the sim does not have. A group
// of decoration alone has no body to agree with, so its members are weighed
// among themselves and the group turns about their own centre.
export function bodyCentroid(items: readonly EdItem[]): Vec2 {
  const shapes = items.filter((i) => i.object === "collision");
  const weighed = shapes.length ? shapes : items;
  let total = 0;
  let acc = Vec2.ZERO;
  for (const i of weighed) {
    const a = shapeMass(i);
    total += a;
    // Each piece weighed where its own mass is (`shapeCentre`), not at its
    // placement: a polygon's origin is wherever its author left it, and summing
    // origins would put a body's turning point somewhere no mass is.
    acc = acc.add(shapeCentre(i).mul(a));
  }
  if (total > 0) return acc.div(total);
  // Degenerate (zero-area) shapes: fall back to the plain mean so the answer is
  // still inside the group rather than NaN.
  return weighed.reduce((c, i) => c.add(shapeCentre(i)), Vec2.ZERO).div(Math.max(1, weighed.length));
}

// The point a SELECTION of several things is moved and turned about: the plain
// mean of its members' own centres.
//
// It is deliberately NOT `bodyCentroid`, which answers a different question and
// answers it for one body. That one is mass-weighted over the COLLIDING shapes
// alone, because a body has to turn about the point the engine mounts it at; a
// selection is not a body, nothing in the sim has an opinion about it, and both
// of those properties read as the gizmo being somewhere strange - a backdrop
// selected beside a wall would be ignored entirely (no mass), and a small dense
// block would drag the handles off the middle of what is lit up on screen.
//
// A MEAN rather than the centre of the selection's bounding box, and that is the
// load-bearing part: the mean of a set of points turned about their own mean is
// that same mean, so the handles stay put across a rotation. A bounding box does
// not - an arrangement turned 45° has a different box - so the gizmo would hop
// sideways the moment a turn was released, which reads as the selection having
// moved when nothing did.
export function selectionCentre(items: readonly EdItem[]): Vec2 {
  if (!items.length) return Vec2.ZERO;
  return items.reduce((c, i) => c.add(shapeCentre(i)), Vec2.ZERO).div(items.length);
}

// Where a set of items stood when a gesture began, and the frames of the bodies
// WHOLLY inside that set (the same rule `carryBodyFrames` states: a body's frame
// moves when the body moves, and an edit to some of its objects is not that).
//
// A gesture that transforms a group works from a snapshot rather than by adding
// up its own steps. It is the reason `bodyHandlers` writes placements from a
// base map instead of calling `translateItems` per frame: a drag re-applies its
// WHOLE displacement every time the pointer moves, so a delta-per-move would
// accumulate the snap grid's rounding across the drag and leave a group that was
// dragged slowly a few millimetres off one that was dragged fast.
export interface GroupPose {
  centre: Vec2;
  items: Map<number, { pos: Vec2; rot: number }>;
  // The frames that move with the group, by node id: a body's, a group's, a
  // 3D frame's - every structural node whose items all move.
  frames: Map<string, EdBodyFrame>;
}

export function captureGroupPose(
  model: EdModel,
  items: readonly EdItem[],
  centre: Vec2,
): GroupPose {
  const frames = new Map<string, EdBodyFrame>();
  for (const n of framesCarriedBy(model, items)) frames.set(n.id, { pos: n.pos, rot: n.rot });
  return {
    centre,
    items: new Map(items.map((i) => [i.id, { pos: i.pos, rot: i.rot }])),
    frames,
  };
}

// Put a group back down: each member turned by `turn` about the snapshot's
// centre and then displaced by `move`, measured from where it stood when the
// gesture began rather than from where it is now.
//
// It is `rotateItemsAbout` and `translateItems` composed, from a base - the two
// orders differing only in whether the displacement is turned as well, and it is
// not: a drag says "this far in the level's own axes", which is what the gizmo's
// world-space move arrows mean.
export function placeGroup(
  model: EdModel,
  items: readonly EdItem[],
  base: GroupPose,
  move: Vec2,
  turn: number,
): void {
  const place = (p: Vec2): Vec2 => base.centre.add(p.sub(base.centre).rotated(turn)).add(move);
  for (const [id, f] of base.frames) {
    const n = model.tree.nodes.get(id);
    if (!n) continue;
    n.pos = place(f.pos);
    n.rot = f.rot + turn;
  }
  for (const i of items) {
    const was = base.items.get(i.id);
    if (!was) continue;
    i.pos = place(was.pos);
    i.rot = was.rot + turn;
  }
}

// --- settled ghosts ---------------------------------------------------------

// A body whose REST pose differs from its authored one - a spring body's droop,
// a pivot branch's settled angle, a free pendulum's hang - and by how much.
// The editor's canvas draws geometry at the authored pose (that is the datum
// being edited: the spring's anchor, the torsion spring's rest angle), so
// without this the picture says nothing about where the body will actually
// stand when the level opens.
//
// The BUILD is the authority: `buildLevelBodies` spawns sprung bodies at their
// rest pose (`applyRestPose`), so the model is built into a throwaway world and
// each displacement is read off the difference between the authored frame the
// `BuiltBody` records and the pose the body spawned at - the ghost cannot
// disagree with where the level stands, because it IS where the level stands.
export interface SettleGhost {
  unit: string;
  // The point the displacement turns about (a pivot's bearing; unused while
  // `drot` is 0), the turn, and the translation, all in world metres. An item
  // at authored pose `(p, r)` rests at `about + (p - about).rotated(drot) +
  // dpos`, rotated `r + drot`.
  about: Vec2;
  drot: number;
  dpos: Vec2;
}

export function settledGhosts(model: EdModel): SettleGhost[] {
  const itemOf = new Map<SceneTag, number>();
  const data = toLevelData(model, itemOf);
  const built = buildLevelBodies(new World(), data, () => {});
  const out: SettleGhost[] = [];
  for (const b of built.bodies) {
    const body = b.body;
    if (!(body instanceof RigidBody2D)) continue;
    const dpos = body.globalPosition.sub(b.origin);
    const drot = body.globalRotation - b.rotation;
    if (dpos.x === 0 && dpos.y === 0 && drot === 0) continue;
    // Back from the written body to the editor's items, through the same map a
    // 3D pick uses: `toLevelData` records which item wrote each object.
    const first = b.data.objects[0];
    const itemId = first !== undefined ? itemOf.get(first) : undefined;
    const item = itemId !== undefined ? model.items.find((i) => i.id === itemId) : undefined;
    if (!item) continue;
    out.push({ unit: item.unit, about: b.origin, drot, dpos });
  }
  return out;
}

// --- frames -------------------------------------------------------------------

// THE FRAMES THAT MOVE WITH A SET OF ITEMS: every structural node - a body, a
// group, a 3D frame - all of whose items are in the set. A node's frame moves
// when the node moves, and an edit to some of what is in it is not that: a
// piece of a body dragged on its own leaves the body's frame where it is.
export function framesCarriedBy(model: EdModel, items: readonly EdItem[]): EdNode[] {
  const moving = new Set(items.map((i) => i.id));
  const out: EdNode[] = [];
  const count = (id: string): { total: number; held: number } => {
    const n = model.tree.nodes.get(id);
    let total = 0;
    let held = 0;
    if (!n) return { total, held };
    if (n.item !== null) {
      total++;
      if (moving.has(n.item)) held++;
    }
    for (const c of n.children) {
      const k = count(c);
      total += k.total;
      held += k.held;
    }
    if (n.item === null && k0(n) && total > 0 && held === total) out.push(n);
    return { total, held };
  };
  const k0 = (n: EdNode): boolean => n.type !== "Node" && n.type !== "Chain" && n.type !== "Vine";
  for (const r of model.tree.roots) count(r);
  return out;
}

// The frame a unit's objects are placed in (`EdItem.unit`): its body node's
// placement, or the item's own for an item no body carries.
export function bodyFrameOf(model: EdModel, unit: string): EdBodyFrame {
  const n = model.tree.nodes.get(unit);
  if (n && n.item === null) return { pos: n.pos, rot: n.rot };
  const item = model.items.find((i) => i.node === unit);
  if (item) return { pos: item.pos, rot: item.rot };
  return { pos: n?.pos ?? Vec2.ZERO, rot: n?.rot ?? 0 };
}

// Move a body's ORIGIN onto its centre of mass, without moving the body.
//
// Nothing in the world shifts: every object keeps the world placement it had, so
// what changes is the frame those placements are RECORDED against - each one's
// offset moves by exactly as much as the origin did, in the other direction.
//
// It is worth having because the centre of mass is the one point the body is
// really about: `buildLevelBodies` puts the engine origin there whatever the
// file says, the editor turns a body about it (`bodyCentroid`), and a body's
// route is a run of offsets from its origin.
//
// THE BEARING (`pivotAt`), a point in the body's frame, is re-measured, so the
// body goes on turning about the same place in the level. THE ROUTE is not: its
// nodes are offsets from node zero - the origin itself - so leaving them alone
// is what keeps the travel identical.
//
// Returns whether anything moved.
export function originToCentroid(model: EdModel, unit: string): boolean {
  const n = model.tree.nodes.get(unit);
  if (!n || !n.body) return false;
  const members = bodyMembers(model.items, unit);
  if (!members.length) return false;
  const centre = bodyCentroid(members);
  const d = centre.sub(n.pos);
  if (d.x === 0 && d.y === 0) return false;
  const step = d.rotated(-n.rot);
  n.pos = centre;
  if (n.body.pivotAt) n.body.pivotAt = n.body.pivotAt.sub(step);
  return true;
}

// Translate a set of items, carrying the frame of any node moving in full.
export function translateItems(model: EdModel, items: readonly EdItem[], d: Vec2): void {
  if (d.x === 0 && d.y === 0) return;
  for (const n of framesCarriedBy(model, items)) n.pos = n.pos.add(d);
  for (const i of items) i.pos = i.pos.add(d);
}

// Turn a set of items about `centre` by `delta` radians: each piece's placement
// swings round the centre and its own angle follows. That is exactly what
// rotating the built body does, since a piece is mounted at a local offset and
// a local angle off that origin - so a body turning in full turns its frame too.
export function rotateItemsAbout(
  model: EdModel,
  items: readonly EdItem[],
  centre: Vec2,
  delta: number,
): void {
  if (delta === 0) return;
  for (const n of framesCarriedBy(model, items)) {
    n.pos = centre.add(n.pos.sub(centre).rotated(delta));
    n.rot += delta;
  }
  for (const i of items) {
    i.pos = centre.add(i.pos.sub(centre).rotated(delta));
    i.rot += delta;
  }
}

// --- flip ---------------------------------------------------------------------

// Mirror a set of items left-for-right about the vertical line through the
// middle of what they cover (`flipCentreX`), so a route built to go right can be
// turned round to go left without being redrawn.
//
// A placement is a position and an ANGLE, and an angle cannot hold a mirror: a
// mirrored frame is a turned frame with one of its own axes turned over. Either
// axis will do, and which one decides only how the result is spelled:
//
// - "x": the angle goes to -rot and the shape's own x is negated. A box at 0°
//   stays at 0°, a text note stays readable, and an outline comes out mirrored
//   about its own origin. What everything uses unless it has a reason not to.
// - "y": the angle goes to π - rot and the shape's own y is negated. For the
//   things whose angle IS a direction - a force area's push, a current's flow,
//   an arrow note - since a push to the right has to become a push to the left,
//   and under "x" it would come out pointing right again, tipped the other way.
//
// Each item picks its own: what is written to disk is world placements and the
// frame-local offsets measured from them, so two members of one body may turn
// over different axes and still come out as one mirrored body.
//
// What a body holds in its OWN frame (the bearing, the route) is mirrored with
// the frame, and only where the whole body is in the set - the rule
// `carryBodyFrames` states: an edit to some of a body's objects is not a move of
// the body. Its motions are what a mirror image of them does: a route keyed to
// turn one way turns the other, a pendulum starts out to the other side (half a
// cycle on, since its swing is a sine), a rotor spins the other way round, and a
// belt runs the other way.
//
// Two things cannot be mirrored, only turned: a library MODEL is a mesh with no
// mirror switch, so it keeps its own handedness and takes the mirrored placement
// and tilt (its vertical-axis turn negated); and a vine's crooked line is drawn
// from a seed. A berry's stalk, which is an offset, is mirrored.
export type FlipAxis = "x" | "y";

export function flipAxisOf(i: EdItem): FlipAxis {
  if (isArrowNote(i)) return "y";
  if (i.layer === "scene" && i.object === "collision" && (i.body?.kind === "force" || i.body?.kind === "water")) return "y";
  return "x";
}

const flipAngle = (rot: number, axis: FlipAxis): number => {
  const r = wrapAngle(axis === "x" ? -rot : Math.PI - rot);
  // Never -0 (a panel shows "-0"), and never the 1e-16 that π - π leaves,
  // which would be written to the file as a rotation nobody authored.
  return Math.abs(r) < 1e-12 ? 0 : r;
};
const flipLocal = (v: Vec2, axis: FlipAxis): Vec2 =>
  axis === "x" ? new Vec2(-v.x || 0, v.y) : new Vec2(v.x, -v.y || 0);
const fracCycle = (v: number): number => {
  const f = ((v % 1) + 1) % 1;
  return f === 0 ? 0 : f;
};

// The x of the line a flip mirrors about: the middle of the box the items
// cover. A LIGHT counts as its point and not its reach, which is a circle that
// can be far wider than the fitting it hangs in and would pull the line off the
// geometry the author is looking at.
export function flipCentreX(items: readonly EdItem[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const i of items) {
    const b = i.object === "light" ? { min: i.pos, max: i.pos } : itemBounds(i);
    minX = Math.min(minX, b.min.x);
    maxX = Math.max(maxX, b.max.x);
  }
  return Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
}

export function flipItemsH(model: EdModel, items: readonly EdItem[], cx = flipCentreX(items)): void {
  if (!items.length) return;
  const mirror = (p: Vec2): Vec2 => new Vec2(2 * cx - p.x, p.y);
  const ids = new Set(items.map((i) => i.id));

  // The frames wholly in the set turn over "x" (a node's frame is its own,
  // stored, so it is mirrored as a frame), read before anything moves.
  const whole = framesCarriedBy(model, items);
  for (const n of whole) {
    n.pos = mirror(n.pos);
    n.rot = flipAngle(n.rot, "x");
  }

  for (const i of items) {
    const axis = flipAxisOf(i);
    const f = (v: Vec2) => flipLocal(v, axis);
    i.pos = mirror(i.pos);
    i.rot = flipAngle(i.rot, axis);
    const s = i.shape;
    // A mirror of a simple (or convex) loop is one, so neither writer refuses.
    if (s.kind === "poly") setPolyVerts(i, s.verts.map(f));
    else if (s.kind === "path") {
      setPathVerts(
        i,
        s.verts.map(f),
        s.handles.map((h) => ({ in: f(h.in), out: f(h.out) })),
      );
    } else if (s.kind === "belt") {
      setBelt(i, { wheels: s.wheels.map((w) => ({ c: f(w.c), r: w.r })), speed: -s.speed || 0 });
    }
    if (i.object === "light") i.light = { ...i.light, dir: f(i.light.dir) };
    if (i.object === "model") i.modelRef = { ...i.modelRef, rotY: -i.modelRef.rotY || 0 };
    if (i.layer === "camera") {
      const c = i.cam;
      i.cam = {
        ...c,
        // `offset` is a world offset from the avatar and `lockX` a world x; the
        // per-side buffers are in the region's own frame, whose x turned over.
        offset: new Vec2(-c.offset.x || 0, c.offset.y),
        lockX: c.lockX === null ? null : 2 * cx - c.lockX,
        ...(axis === "x"
          ? { bufferLeft: c.bufferRight, bufferRight: c.bufferLeft }
          : { bufferTop: c.bufferBottom, bufferBottom: c.bufferTop }),
      };
    }
  }

  // What a body holds in its own frame turns over with it: its bearing and
  // its route, and its motions run the other way.
  for (const n of whole) {
    const b = n.body;
    if (!b) continue;
    const f = (v: Vec2) => flipLocal(v, "x");
    if (b.pivotAt) b.pivotAt = f(b.pivotAt);
    b.route = b.route.map((r) => ({ ...r, p: f(r.p), in: f(r.in), out: f(r.out), rot: r.rot === null ? null : -r.rot || 0 }));
    if (b.swingAmp !== 0) b.swingPhase = fracCycle(b.swingPhase + 0.5);
    if (b.spinPeriod !== 0) {
      b.spinPeriod = -b.spinPeriod;
      b.spinPhase = fracCycle(-b.spinPhase);
    }
  }

  // A berry vine hanging in the set: its stalks reach the other way. A berry
  // with no offset of its own grows to its `sides` entry (alternating from the
  // left when there is none), so those are written out and turned over too.
  for (const v of model.vines) {
    const sb = v.starberry;
    if (!sb || !ids.has(v.anchor)) continue;
    const n = sb.along.length;
    const offsets = sb.offsets?.map((o) => ({ x: -o.x || 0, y: o.y }));
    const needSides = (sb.offsets?.length ?? 0) < n || sb.sides !== undefined;
    v.starberry = {
      ...structuredClone(sb),
      ...(offsets ? { offsets } : {}),
      ...(needSides
        ? { sides: Array.from({ length: n }, (_, k) => -(sb.sides?.[k] ?? (k % 2 === 0 ? -1 : 1))) }
        : {}),
    };
  }
}

// The member whose body-level properties the group is built from: the first
// COLLIDING item in model order, which is the first of the group's colliding
// entries in the body list `toLevelData` writes, which is the entry
// `buildLevelBodies` takes a group's kind, style, friction and force from. Null
// for a group of decoration alone, which builds no body at all.
export function bodyLead(members: readonly EdItem[]): EdItem | null {
  return members.find((m) => m.object === "collision") ?? null;
}


// A formation item (`EdFormation`) placed at `pos`/`rot`, not in the tree
// yet (`addItem` puts it there, its id becoming its node's).
export function formationItem(pos: Vec2, rot: number, data: EdFormation): EdItem {
  return { ...blankItem("scene", "formation", data.id), pos, rot, formation: data };
}


// --- scripted motion --------------------------------------------------------

// A body's authored route as the travelled thing (see `MoveRoute`): its nodes in
// the body's frame, built exactly the way `buildBodies.authoredRoute` builds
// them at load - so the canvas, the panel's trip readout and the sim cannot each
// measure a route their own way.
// A body's properties as read through any item of it: a default static's for
// an item no body carries, so every question about motion has an answer.
const NO_BODY: EdBody = Object.freeze(edBodyOf({ kind: "static", x: 0, y: 0, rot: 0, objects: [] }, 0)) as EdBody;
export function propsOf(item: EdItem): EdBody {
  return item.body ?? NO_BODY;
}

export function routeOf(model: EdModel, item: EdItem): MoveRoute {
  const frame = bodyFrameOf(model, item.unit);
  return buildMoveRoute(
    propsOf(item).route,
    propsOf(item).moveMode,
    frame.rot,
    propsOf(item).moveSpeed,
    propsOf(item).route.map((n) => n.rot ?? undefined),
    propsOf(item).route.map((n) => n.speed ?? undefined),
  );
}

// ...and the same route's NODES in world points, which is what a node handle is
// placed at and what a tangent grip is measured from. Node zero is the body's
// frame origin, which is why moving the body moves the whole route with it.
export function routeWorldPoints(model: EdModel, item: EdItem): Vec2[] {
  const frame = bodyFrameOf(model, item.unit);
  return propsOf(item).route.map((n) => frame.pos.add(n.p.rotated(frame.rot)));
}

// ...and the CURVE it draws as: the flattened polyline in world points, closing
// leg included on a loop. What the canvas strokes, what the picks are measured
// against, and the same flattening the sim rides - so what an author drags and
// what the platform travels cannot disagree about where the route is.
export function routePolyline(model: EdModel, item: EdItem): Vec2[] {
  const frame = bodyFrameOf(model, item.unit);
  const nodes = propsOf(item).route.map((n) => ({ p: n.p, in: n.in, out: n.out }));
  const seq =
    moveModeCloses(propsOf(item).moveMode) && nodes.length > 1 ? [...nodes, nodes[0]!] : nodes;
  return flattenPath(seq).map((v) => frame.pos.add(v.rotated(frame.rot)));
}

// Where each node landed along the route, in metres of arc length - what a key
// is read at, and what the panel's placeholders interpolate against.
export function routeNodeArcLengths(model: EdModel, item: EdItem): number[] {
  return [...routeOf(model, item).index.nodeS];
}

// The fastest any point of a mover's surface crosses a frame, in metres - the
// one number a mover can get wrong with nothing else saying so (see
// `MoverScript`: past about 2 cm the character sweep resolves against a surface
// that has already crossed the avatar).
//
// Derived rather than measured, so the panel can show it live while the fields
// are being typed into: a pendulum's fastest point is `amp · 2π/period` times the
// distance from its bearing to its farthest corner, a rotor's is `2π/|period|`
// times the same reach at EVERY instant (a rotor never slows down, which is what
// makes it the harder of the two to author under the bar), and a route's is its
// average speed times what the ease peaks at. A body carrying several is charged
// for the sum, which is the bound rather than the exact answer - the peaks need
// not fall on the same frame - and a bound is the right side to be wrong on here.
export function peakSurfaceSpeed(model: EdModel, item: EdItem): number {
  let peak = 0;
  if ((propsOf(item).swingAmp !== 0 && propsOf(item).swingPeriod > 0) || propsOf(item).spinPeriod !== 0) {
    // The bearing and the reach are the two motions' shared geometry - they turn
    // the same body about the same point - so they are measured once.
    const reach = sweptReach(model, item, bearingOf(model, item));
    if (propsOf(item).swingAmp !== 0 && propsOf(item).swingPeriod > 0) {
      peak += Math.abs(propsOf(item).swingAmp) * ((2 * Math.PI) / propsOf(item).swingPeriod) * reach;
    }
    if (propsOf(item).spinPeriod !== 0) {
      peak += ((2 * Math.PI) / Math.abs(propsOf(item).spinPeriod)) * reach;
    }
  }
  if (propsOf(item).route.length > 1 && propsOf(item).moveSpeed > 0) {
    // The route's peak is its FASTEST stretch times what the ease peaks at,
    // rather than its authored speed: a node may key a speed of its own, and a
    // cart that runs away downhill crosses a frame at the speed it gets to
    // there. The unkeyed route answers `moveSpeed`, which is what it always did.
    let fastest = propsOf(item).moveSpeed;
    for (const n of propsOf(item).route) if (n.speed !== null) fastest = Math.max(fastest, n.speed);
    peak += fastest * movePeakFactor(propsOf(item).moveEase, propsOf(item).moveMode);
    // ...plus what TURNING the body drags its far corners round at. A route that
    // aligns the body to its own tangent, or keys a rotation along it, sweeps
    // the surface as well as carrying it - and on a tight bend that is the
    // larger of the two. Measured as the worst turn per metre anywhere on the
    // route times the speed and the reach, which is `ω × r` with the arc length
    // as the clock.
    const turn = peakRouteTurnRate(model, item);
    if (turn > 0) peak += turn * fastest * bodyReach(model, item);
  }
  return peak / 60;
}

// The worst turn per metre the route asks of the body anywhere along it, in
// radians per metre - the `dθ/ds` the surface-speed readout multiplies by the
// speed to get an angular rate.
//
// Sampled off the flattened polyline rather than differentiated, because that
// is the curve the body actually rides: `moveAngleAt` reads the polyline's own
// tangent, so a bend that only exists between two flattening samples is a bend
// the mover does not take either.
function peakRouteTurnRate(model: EdModel, item: EdItem): number {
  if (!propsOf(item).moveAlign && propsOf(item).route.every((n) => n.rot === null)) return 0;
  const route = routeOf(model, item);
  let worst = 0;
  const step = PATH_FLATTEN_STEP;
  for (let s = 0; s < route.total; s += step) {
    const b = Math.min(s + step, route.total);
    if (b <= s) break;
    const d = moveAngleAt(route, propsOf(item).moveAlign, b) - moveAngleAt(route, propsOf(item).moveAlign, s);
    worst = Math.max(worst, Math.abs(wrapAngle(d)) / (b - s));
  }
  return worst;
}

// How far the body's farthest corner sits from the point it turns about, which
// for a travelling body is its own frame origin.
function bodyReach(model: EdModel, item: EdItem): number {
  return sweptReach(model, item, bodyFrameOf(model, item.unit).pos);
}

// ...and the general form: the radius a body's surface sweeps about `about`, in
// world metres. The one answer to "how big is the circle this body turns in",
// shared by the panel's contact-speed readout and by the canvas mark that draws
// that circle - drawn off a second opinion, the picture and the number it is
// judged against would be about different geometry.
//
// CORNERS rather than the shapes' own centres, which is the difference between
// the radius the surface sweeps and a radius nothing is at. A rotor is the case
// that makes it structural rather than a nicety: a cross drawn round its own
// axle has every piece centred ON the bearing, so a reach taken off the centres
// is zero and the mark is a circle of no radius at all.
export function sweptReach(model: EdModel, item: EdItem, about: Vec2): number {
  let reach = 0;
  for (const m of bodyMembers(model.items, item.unit)) {
    if (m.object !== "collision") continue;
    for (const c of shapeCorners(m)) reach = Math.max(reach, c.sub(about).length());
  }
  return reach;
}

// Where a body turns: its authored bearing carried into world metres, or the
// centre of mass an absent one means (see `LevelBodyData.pivotX`). Asked in one
// place so the panel, the canvas mark and the build cannot each decide.
export function bearingOf(model: EdModel, item: EdItem): Vec2 {
  if (!propsOf(item).pivotAt) return bodyCentroid(bodyMembers(model.items, item.unit));
  const frame = bodyFrameOf(model, item.unit);
  return frame.pos.add(propsOf(item).pivotAt!.rotated(frame.rot));
}

// Every point of a shape a rider can meet, in world metres: the corners of a
// rect or a polygon, and for a circle its centre alone with the radius left to
// the caller (nothing that carries a route or a bearing is one, and a circle
// spun about its own centre sweeps no new ground anyway).
//
// The exact corners rather than the half-diagonal added to the centre, because
// the two disagree by a third on an arm-and-plank pendulum - and the looser
// answer would have the panel calling a level too fast that `cli movers`
// `levels`, which measures the same points, passes.
function shapeCorners(item: EdItem): Vec2[] {
  const s = item.shape;
  const local =
    s.kind === "rect"
      ? [
          new Vec2(-s.w / 2, -s.h / 2),
          new Vec2(s.w / 2, -s.h / 2),
          new Vec2(s.w / 2, s.h / 2),
          new Vec2(-s.w / 2, s.h / 2),
        ]
      : s.kind === "circle"
        ? [new Vec2(s.r, 0), new Vec2(-s.r, 0), new Vec2(0, s.r), new Vec2(0, -s.r)]
        : s.kind === "poly" || s.kind === "path"
          ? s.verts
          : s.kind === "belt"
            ? localVertices(item)
            : [Vec2.ZERO];
  return local.map((v) => item.pos.add(v.rotated(item.rot)));
}

// --- chains -----------------------------------------------------------------

export function cloneChain(c: EdChain): EdChain {
  return { ...c, via: [...c.via], through: [...c.through], lengths: [...c.lengths] };
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

// A world point pushed onto the item's nearest CORNER (or, on a circle, its
// rim), in the item's local frame - where a chain WRAP POINT goes. A corner
// rather than the nearest surface point because a corner is what a rope bends
// around: the loader lands a wrap point on one whatever the file says
// (`snapToCorner` in level/chains.ts), so the editor shows the route the level
// will actually have rather than one the loader quietly moves.
export function nearestCornerLocal(item: EdItem, world: Vec2): Vec2 {
  const local = toLocal(item, world);
  if (item.shape.kind === "circle") return nearestOnCircle(item.shape.r, local);
  let best = local;
  let bestSq = Infinity;
  for (const v of localVertices(item)) {
    const d = v.sub(local).lengthSquared();
    if (d < bestSq) {
      bestSq = d;
      best = v;
    }
  }
  return best;
}

// Where a chain end currently sits in the world, or null if its anchor is gone.
// It is simply the anchor's own position: the anchor IS the end, so there is no
// second copy of the point to keep in step with it.
export function chainEndWorld(model: EdModel, end: number): Vec2 | null {
  const item = model.items.find((i) => i.id === end);
  return item?.object === "anchor" ? item.pos : null;
}

// The anchor item an id names, or null. A chain end and a vine's one anchor are
// the same thing, so they are looked up the same way.
export function anchorItem(model: EdModel, id: number): EdItem | null {
  const item = model.items.find((i) => i.id === id);
  return item?.object === "anchor" ? item : null;
}

// Both ends in the world, or null if either item is gone (a chain in that state
// is dropped on save and drawn as nothing).
export function chainEnds(model: EdModel, c: EdChain): { a: Vec2; b: Vec2 } | null {
  const a = chainEndWorld(model, c.a);
  const b = chainEndWorld(model, c.b);
  return a && b ? { a, b } : null;
}

// The chain's wrap points as items, in route order. One whose anchor item has
// gone is simply not in the route (see `pruneChains`, which also drops it from
// the list; between a deletion and the prune this is what keeps the route
// drawable).
export function chainViaItems(model: EdModel, c: EdChain): EdItem[] {
  const out: EdItem[] = [];
  for (const id of c.via) {
    const item = anchorItem(model, id);
    if (item) out.push(item);
  }
  return out;
}

// The chain's tie points as items, in route order, under the same tolerance.
export function chainThroughItems(model: EdModel, c: EdChain): EdItem[] {
  const out: EdItem[] = [];
  for (const id of c.through) {
    const item = anchorItem(model, id);
    if (item) out.push(item);
  }
  return out;
}

export function isTiedChain(c: EdChain): boolean {
  return c.through.length > 0;
}

// The whole route in the world - end, wrap points (or tie points), end - or
// null if either end is gone. What the canvas draws and what a click on the
// chain is tested against: a chain with wrap points IS its polyline, since a
// span between two wrap nodes is straight and the solver renders exactly this,
// and a tied chain is its knots in order for the same reason.
export function chainPath(model: EdModel, c: EdChain): Vec2[] | null {
  const ends = chainEnds(model, c);
  if (!ends) return null;
  const middle = isTiedChain(c) ? chainThroughItems(model, c) : chainViaItems(model, c);
  return [ends.a, ...middle.map((i) => i.pos), ends.b];
}

// A tied chain's SEGMENTS as the loader builds them: consecutive knots on
// different bodies, with the authored gap between them. Two knots on one body
// are the body and no rope.
export function chainSegments(
  model: EdModel,
  c: EdChain,
): { from: EdItem; to: EdItem; gap: number }[] {
  const a = anchorItem(model, c.a);
  const b = anchorItem(model, c.b);
  if (!a || !b) return [];
  const knots = [a, ...chainThroughItems(model, c), b];
  const out: { from: EdItem; to: EdItem; gap: number }[] = [];
  for (let i = 0; i + 1 < knots.length; i++) {
    const from = knots[i]!;
    const to = knots[i + 1]!;
    if (from.unit === to.unit) continue;
    out.push({ from, to, gap: from.pos.distanceTo(to.pos) });
  }
  return out;
}

// Distance from a world point to the chain's straight span, for picking. The
// editor draws a chain straight - how it drapes and what it wraps is a runtime
// answer the solver gives, and drawing a guess at it would be a drawing of
// something that is not the level.
export function distanceToChain(model: EdModel, c: EdChain, world: Vec2): number {
  return nearestChainSpan(model, c, world)?.distance ?? Infinity;
}

// The span of the chain's route nearest a world point: its index (0 = the span
// leaving end `a`) and how far the point is from it. What a press on the chain
// resolves to, and - for a wrap point pulled out of the chain - where in the
// route the new point goes.
export function nearestChainSpan(
  model: EdModel,
  c: EdChain,
  world: Vec2,
): { index: number; distance: number } | null {
  const path = chainPath(model, c);
  if (!path) return null;
  let best: { index: number; distance: number } | null = null;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const d = path[i + 1]!.sub(a);
    const len2 = d.lengthSquared();
    const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, world.sub(a).dot(d) / len2));
    const distance = world.distanceTo(a.add(d.mul(t)));
    if (!best || distance < best.distance) best = { index: i, distance };
  }
  return best;
}

// --- vines ------------------------------------------------------------------

export function cloneVine(v: EdVine): EdVine {
  return { ...v, ...(v.starberry ? { starberry: structuredClone(v.starberry) } : {}) };
}

// Where a vine hangs from, or null if its anchor has gone.
export function vineAnchorWorld(model: EdModel, v: EdVine): Vec2 | null {
  return anchorItem(model, v.anchor)?.pos ?? null;
}

// Where a spanning vine's second anchor sits, or null if the vine has none (or
// the anchor item has gone, which is the same thing on screen).
export function vineAnchor2World(model: EdModel, v: EdVine): Vec2 | null {
  return v.anchor2 !== null ? (anchorItem(model, v.anchor2)?.pos ?? null) : null;
}

// Segments the editor samples a span's catenary at. A drawing resolution and
// nothing more - the builder fits its own links to the length.
const VINE_REST_SEGMENTS = 24;

// The vine's rest pose as the EDITOR draws it: straight down from the anchor by
// its authored length, or - with a second anchor - where that length rests
// between the two: the catenary for a limp span, and for a stiff one the
// flatter bow its bends hold it in, settled by the builder itself
// (`restingSpanPath`).
//
// That is the rest pose and nothing more. Where a vine actually hangs is a
// runtime answer - it drapes over whatever is under it, and the player drags it
// about - and drawing a guess at that would be a drawing of something the level
// does not contain, which is the same rule the editor draws a chain straight by.
// The rest pose is not a guess: it is where the vine rests over empty ground,
// and where the level's own vine stands when it opens (a hanging vine on its
// drawn length, a span settled at build - see `buildVines`).
export function vineRestPath(model: EdModel, v: EdVine): Vec2[] | null {
  const top = vineAnchorWorld(model, v);
  if (!top) return null;
  const end = vineAnchor2World(model, v);
  if (!end) return [top, top.add(new Vec2(0, v.length))];
  if (v.stiffness !== null && v.stiffness > 0) return restingSpan(top, end, v);
  return catenaryPolyline(top, end, v.length, VINE_REST_SEGMENTS);
}

// A stiff span's settled pose, cached by everything that decides it - its
// anchors, length, spacing, weight and stiffness - since settling one is a
// build and 8-28 ms (measured on BALL's and testing's spans), and the editor
// asks for the rest pose every frame it draws or picks.
const restingSpans = new Map<string, Vec2[]>();
const RESTING_SPAN_CACHE = 64;
function restingSpan(top: Vec2, end: Vec2, v: EdVine): Vec2[] {
  const key = [top.x, top.y, end.x, end.y, v.length, v.spacing, v.density, v.stiffness].join(",");
  let path = restingSpans.get(key);
  if (!path) {
    path =
      restingSpanPath(top, end, {
        length: v.length,
        ...(v.spacing !== null ? { spacing: v.spacing } : {}),
        ...(v.density !== null ? { density: v.density } : {}),
        ...(v.stiffness !== null ? { stiffness: v.stiffness } : {}),
      }) ?? catenaryPolyline(top, end, v.length, VINE_REST_SEGMENTS);
    if (restingSpans.size >= RESTING_SPAN_CACHE) restingSpans.clear();
    restingSpans.set(key, path);
  }
  return path;
}

// Distance from a world point to that rest pose, for picking.
export function distanceToVine(model: EdModel, v: EdVine, world: Vec2): number {
  const path = vineRestPath(model, v);
  if (!path) return Infinity;
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const d = path[i]!.sub(a);
    const len2 = d.lengthSquared();
    const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, world.sub(a).dot(d) / len2));
    best = Math.min(best, world.distanceTo(a.add(d.mul(t))));
  }
  return best;
}

// A blank level: a single wide floor under a spawn point so it is immediately
// testable.
export function emptyModel(): EdModel {
  // A sun, the default sky, a spawn over a wide floor, a body of one piece,
  // through the loader a level comes in by. The floor's debug geometry is on,
  // as every piece a new level is blocked out in is.
  return modelFromTree({
    format: TREE_FORMAT,
    nodes: [
      { type: "Sun", id: newNodeId(), name: "Sun" },
      { type: "Environment", id: newNodeId(), name: "Environment" },
      { type: "Spawn2D", id: newNodeId(), name: "Spawn", x: 0, y: -1, radius: 0.08 },
      {
        type: "StaticBody2D",
        id: newNodeId(),
        name: "Floor",
        order: 0,
        grouped: true,
        children: [{ type: "CollisionShape2D", id: newNodeId(), name: "Rect", shape: { kind: "rect", w: 8, h: 0.6 }, debug: { on: true } }],
      },
    ],
  });
}

/** A complete reusable bounce mushroom. Randomness is editor-only; the saved
 * model, scale and collision preserve the chosen variation exactly. */
export function mushroomBody(pos: Vec2, variant = 0, scale = 1): LevelBodyData {
  const spec = mushroomVariants[Math.abs(variant) % mushroomVariants.length]!;
  const params = mushroomParameters(spec.model)!;
  return {
    kind: "static", x: pos.x, y: pos.y, rot: 0,
    color: "#b28be8", bounce: 1, launch: 6.5,
    objects: [
      { type: "collision", debug: { on: false }, shape: { kind: "poly", verts: mushroomOutline(params, scale) } },
      { type: "model", model: spec.model, scale, mushroom: params },
      // In the cap (`mushroomCapCentre`), at the model's depth.
      { type: "light", ...mushroomCapCentre(params, scale), z: 0, color: "#9cbbff", intensity: 5, range: 2.5*scale,
        wake: 6, wakeDelay: 0, wakeRise: .2, wakeFall: 1 },
    ],
  };
}

export function mushroomModel(pos: Vec2): EdModel {
  const variant = Math.floor(Math.random() * mushroomVariants.length);
  const scale = .75 + Math.random() * .6;
  return modelFromTree(loadLevelTree({ player: { x: pos.x, y: pos.y, radius: .08 }, bodies: [mushroomBody(pos, variant, scale)] }));
}

export function resizeMushroom(model: EdModel, item: EdItem, key: keyof MushroomParameters, value: number): void {
  const was = mushroomParameters(item.modelRef.name, item.modelRef.mushroom);
  const params = mushroomParameters(item.modelRef.name, { ...was!, [key]: value });
  if (!was || !params) return;
  item.modelRef.mushroom = params;
  // The body's light stays in the middle of the cap as it grows or shrinks -
  // if that is where it was: one put somewhere else on purpose stays there.
  const centre = (p: MushroomParameters): Vec2 => {
    const c = mushroomCapCentre(p, item.modelRef.scale);
    return item.pos.add(new Vec2(c.x, c.y).rotated(item.rot));
  };
  const before = centre(was);
  for (const light of model.items) {
    if (light.unit !== item.unit || light.object !== "light") continue;
    if (light.pos.distanceTo(before) > 1e-6 || Math.abs(light.light.z - item.modelRef.z) > 1e-6) continue;
    light.pos = centre(params);
  }
  const caps = model.items.filter(b => b.unit === item.unit && b.object === "collision");
  if (caps.length !== 1) return;
  const cap = caps[0]!;
  const c = Math.cos(item.rot - cap.rot), s = Math.sin(item.rot - cap.rot);
  const dx = item.pos.x - cap.pos.x, dy = item.pos.y - cap.pos.y;
  const ox = dx * Math.cos(cap.rot) + dy * Math.sin(cap.rot);
  const oy = -dx * Math.sin(cap.rot) + dy * Math.cos(cap.rot);
  cap.shape = { kind: "poly", verts: mushroomOutline(params, item.modelRef.scale).map(v => new Vec2(ox + v.x*c - v.y*s, oy + v.x*s + v.y*c)) };
}
