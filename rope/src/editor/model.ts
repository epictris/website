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
import {
  isSimpleLoop,
  loopContainsPoint,
  segmentsIntersect,
} from "../lib/polygon";
import { PIXELS_PER_METER, PX } from "../engine/units";
import {
  buildPolylineIndex,
  flattenPath,
  pathNodesOf,
  projectOntoPolyline,
  type PathNode,
} from "../render/cameraPath";
import { DECOR_Z } from "../level/decor";
import { DEFAULT_SPRING_DAMPING, worldPlacement } from "../level/buildBodies";
import {
  DEFAULT_MATERIAL,
  DEFAULT_THICKNESS,
  MATERIALS,
  prismMass,
  type MaterialName,
} from "../lib/shapeGeometry";
import {
  DEFAULT_BODY_COLOR,
  DEFAULT_BODY_OPACITY,
  DEFAULT_NOTE_TEXT_SIZE,
  DEFAULT_SURFACE_FRICTION,
  DEFAULT_VIEWPORT_SCALE,
  NOTE_ARROW_THICKNESS,
  scaleLevelData,
  type BodyKind,
  type CameraPathData,
  type CameraRegionData,
  type ChainData,
  type VineData,
  type EnvironmentData,
  type LevelData,
  type RawLevelData,
  type LevelBodyData,
  type GeometryObjectData,
  type LightObjectData,
  type SceneObjectData,
  isCollisionObject,
  isAnchorObject,
  isGeometryObject,
  type NoteData,
  type ShapeData,
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
// `geometry` is the scene's shapes, `camera` the camera-behaviour volumes and
// `notes` the authoring annotations (invisible in play).
//
// There is deliberately NO decoration layer. A drawn-but-not-simulated shape is
// a GEOMETRY OBJECT (`EdItem.object`), drawn with `+ Geometry` and living in the
// same body, on the same layer, as the collision shapes beside it - rather than
// a second kind of item with its own layer, its own inspector and its own
// resolve path. What a level actually wants is the two of them TOGETHER: a wall
// is a collision shape you cannot see and a geometry object you cannot touch,
// and putting them on separate layers would split one body across two.
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
export type EdLayer = "scene" | "camera" | "notes";
export const ED_LAYERS: EdLayer[] = ["scene", "camera", "notes"];

// What KIND of scene object an item is - the SAME set the format has, and one
// editor item per authored object.
//
// It used to be two, with a geometry object that had no shape of its own folded
// onto the collision object it dressed as that object's `visual`. That is the
// conflation this whole refactor exists to remove, seen from the other end: a
// barrel is a body holding a collision box and a mesh, and an editor that shows
// it as one thing called "mesh yellow_barrel" is teaching that a body, a
// collision shape and a model are all the same object. They are different
// things, and the outliner has to be able to say so.
//
// `anchor` joined last and is the smallest of them: a point on a body that a
// chain end ties to (`AnchorObjectData`). It is an item rather than a pair of
// numbers on the chain for the same reason - a chain end is a thing on a body,
// so it rides that body, shows up in the outliner, and is dragged like anything
// else instead of only being reachable by grabbing the rope.
export type EdObject = "collision" | "geometry" | "light" | "anchor";

// `poly` vertices are metres in the item's own local frame, kept a **simple**
// outline (one that never crosses itself) and centred on their area centroid —
// `setPolyVerts` is the one writer, so no edit path can leave either invariant
// broken. Simple rather than convex: a concave outline is cut into convex pieces
// by the loader (see "Convex-only polygons; compound bodies" in
// docs/game-design.md and `polyMustBeConvex` below, which holds a camera region
// to the older, stricter rule). Centring is what makes the item's `pos` its
// centre of mass, which every rigid-body lever arm in the engine assumes.
//
// `path` is an OPEN curve, permitted only on the camera layer: a camera path
// (see `CameraPathData`). It is not a degenerate polygon - it has no inside, no
// area and no winding, and its node ORDER is its direction of travel, which is
// the one thing about it that carries meaning. `setPathNodes` is its writer,
// and it re-centres on the node average rather than on an area centroid, a
// curve having no area centroid.
//
// `verts` is the points the route passes through and `handles` the cubic Bézier
// tangents at each, as offsets, ONE PER VERT and kept exactly that long by the
// writer. Two arrays rather than one array of nodes because every shared helper
// here - bounds, hit-testing, the transform, the vertex handles - wants the
// points and nothing else, and `localVertices` is what hands them over.
// Both handles zero is a corner, which is what every vert of a freshly drawn
// path is.
export type EdShape =
  | { kind: "rect"; w: number; h: number }
  | { kind: "circle"; r: number }
  | { kind: "poly"; verts: Vec2[] }
  | { kind: "path"; verts: Vec2[]; handles: { in: Vec2; out: Vec2 }[] };

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
  // Per-side overrides of `buffer`, in the region's own frame (left/right = ∓x,
  // top/bottom = ∓y). Rect regions only - a circle has no sides and a polygon
  // grows as an offset - and null = fall back to `buffer`.
  bufferLeft: number | null;
  bufferRight: number | null;
  bufferTop: number | null;
  bufferBottom: number | null;
  priority: number;
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
  flicker: number; // 0 (steady) .. 1 (guttering)
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
  // What kind of scene object this is. Only meaningful on the `scene` layer;
  // camera regions and notes carry "shape" and never read it.
  object: EdObject;
  // WHICH BODY THIS OBJECT IS IN. Always set: an item is a scene object, and
  // every scene object is in exactly one body, so an item on its own is a body
  // of one rather than a body of none.
  //
  // This replaced "grouping", and the difference is not only vocabulary. A group
  // was an optional tag layered on top of items that were otherwise
  // free-standing, so every path had to answer "is this grouped?" before it
  // could answer anything else, and "no group" and "a group of one" were two
  // states meaning the same thing. A body is the container itself: the question
  // is always just which body, and Ctrl+G moves objects into one rather than
  // welding loose things together.
  //
  // What being in one body MEANS is unchanged. Its collision objects build into
  // ONE engine body carrying all their shapes, so the rope and ledge detection
  // treat the join between two pieces as an interior seam rather than as a
  // corner. A non-colliding object in the same body is drawn in that body's
  // frame, so decoration on a rigid assembly swings and falls with it while
  // bringing no shape, no mass and no seam. A light in the same body rides its
  // fitting. And a body of nothing but decoration, or nothing but a light, is a
  // legitimate thing to author - it simply builds no engine body.
  //
  // The camera and notes layers each sit in a body of their own and never share
  // one: neither is drawn in play, and neither has anything a body could carry
  // it in.
  //
  // The id is editor-local and never leaves it. `toLevelData` groups by it and
  // writes the objects into one body; loading mints one id per authored body.
  bodyId: number;
  pos: Vec2; // metres
  rot: number; // radians
  shape: EdShape; // metres
  // The geometry layer authors these; camera regions and notes take the fixed
  // editor-furniture colours below.
  color: string; // hex fill colour
  opacity: number; // 0..1 fill opacity (a body's border draws fully opaque)
  // Whether this shape takes part in the simulation is not a field: it is which
  // OBJECT this is (`object` above). A collision object collides because that is
  // what it is, a geometry object does not for the same reason, and there is no
  // conversion between them - authoring one or the other is the `+ Rect` /
  // `+ Geometry` choice, made where the shape is drawn.
  //
  kind: BodyKind;
  friction: number; // surface friction, 0 (ice) .. 1 (rubber)
  // There is no body depth here, and none on a collision item either: a body is
  // a thing in the gameplay plane and so is the shape it collides as (see
  // `LevelBodyData`). Depth is `EdVisual.offsetZ`, on the geometry objects and
  // lights that draw, measured from the plane itself.
  // Hook-proof (see `LevelBodyData.impermeable`): still solid, but the grapple
  // hook is destroyed on it and the ball's is deflected. Per SHAPE, so it is
  // among the properties `syncBodyProps` leaves alone - a compound wall with
  // one attachable ledge among hook-proof faces is what it is for.
  impermeable: boolean;
  // What the shape is made of, and how thick it is through z - the dimension
  // the 2D view cannot show (see `LevelBodyData.material` / `thickness`). Per
  // SHAPE, so they are the one geometry property `syncBodyProps` leaves alone:
  // a compound body's mass, centre of mass and inertia are sums over its
  // pieces, and a piece brings its own material to them.
  material: MaterialName;
  thickness: number; // metres
  // What the 3D renderer draws for this shape (see `EdVisual`). On decoration
  // its `offsetZ` is what turns a flat backdrop into a parallax layer; the
  // camera and notes layers keep the default and never write it.
  visual: EdVisual;
  force: number; // force areas only: m/s² along the item's rotation
  // Water areas only: the current's speed in m/s along the item's rotation, and
  // how hard the water takes hold in 1/s (see `LevelBodyData.flow` / `drag`).
  flow: number;
  drag: number;
  // Hook-only (see `LevelBodyData.passable`): the hook catches on it and
  // everything else - the avatar, the rope, loose debris - passes through. Per
  // BODY, so `syncBodyProps` carries it across a group: a body half in the way
  // is not a thing a level can mean.
  passable: boolean;
  // Rigid bodies only: bolted to a bearing at the centre of mass - spins, never
  // translates (see `LevelBodyData.pivot`).
  pivot: boolean;
  // Rigid bodies only: held at the authored position by a two-axis
  // spring-damper - sags under load, springs back (see
  // `LevelBodyData.springFreqX`). Frequencies in Hz, 0 = that axis pinned; a
  // body with both at 0 has no spring at all, which is how "absent" is spelled
  // in a model whose fields are always present.
  springFreqX: number;
  springFreqY: number;
  springDamping: number;
  // Camera layer:
  cam: EdCamera;
  // Lights layer:
  light: EdLight;
  // Notes layer:
  note: EdNote;
  // Anchor objects only: the id `ChainData` names this end by. It is PRESERVED
  // through a load and a save rather than minted fresh each time, so a level
  // that goes through the editor untouched comes back with the same ids it went
  // in with - the id is content, not a handle. 0 on everything else.
  anchorId: number;
  // Geometry objects only: the item id of the COLLISION object in this body
  // whose outline this one mirrors, 0 for none. While set, the editor keeps the
  // two outlines - `pos`, `rot` and `shape` - equal in BOTH directions
  // (`syncMatchedOutlines`), so resizing either resizes both; this is the
  // standing form of the "match the collision shape" edit the
  // collision/geometry decoupling priced in. Editor-local like every item id:
  // the file records only `GeometryObjectData.matchCollision`, and the partner
  // is re-found at load by the identical outline the link itself guarantees.
  matchId: number;
}

// How far toward the camera this item is drawn, in metres - the editor's side of
// `depthOf` (`level/decor.ts`), which is the rule the game renders by.
//
// It is what orders overlapping shapes, both on the canvas and under a click:
// the surface nearest the viewport is the one you see, so it is the one a click
// has to select. Without it a parallax panel 20 m behind the level could swallow
// a click meant for the wall drawn on top of it, purely because it was authored
// later.
//
// Only the geometry layer has a depth at all; camera regions and notes are
// editor furniture drawn in their own fixed order, and answering 0 for them
// leaves the layer ordering to decide, which is what did decide before.
export function itemDepth(i: EdItem, bodyCollides: boolean): number {
  if (i.layer !== "scene" || i.object === "light") return 0;
  if (i.object !== "geometry") return 0;
  // An `offsetZ` of exactly 0 is indistinguishable from an unset one both here
  // and on disk (`visualData` omits a zero), and what the renderer draws that
  // case at depends on the BODY: a geometry object on something solid is on that
  // body's own plane, and one on a body that collides with nothing falls back to
  // `DECOR_Z` - which is what a flat fill drawn before every body already was.
  // The same two answers `depthOf` gives, from the same two facts.
  if (i.visual.offsetZ !== 0) return i.visual.offsetZ;
  return bodyCollides ? 0 : DECOR_Z;
}

// Which bodies of a model have a collision object in them - the one fact
// `itemDepth` needs about a body and an item cannot answer about itself.
export function collidingBodyIds(items: readonly EdItem[]): Set<number> {
  return new Set(items.filter((i) => i.object === "collision").map((i) => i.bodyId));
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
    return { kind: "path", verts: [...s.verts], handles: s.handles.map((h) => ({ ...h })) };
  }
  return { ...s };
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
  // The item id of the anchor it hangs from.
  anchor: number;
  // Metres of vine below the anchor. Always positive - a vine of no length is
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
  // Hex cord colour; null = the renderer's own vine colours.
  color: string | null;
}

// How the 3D renderer draws this shape (see `VisualData`). Every field has a
// value here rather than being optional, because the inspector edits a live
// object and a `undefined` field is a control with nothing to bind to; the
// nulls are the two fields whose default is "take it from somewhere else"
// (`depth` from the shape's thickness, `bevel` from the extruder's own), which
// is a real third state and not a missing value.
//
// Per SHAPE like `material` and `thickness`, so `syncBodyProps` leaves it
// alone: a compound body of a stone head on a wooden shaft is two visuals on
// one body, each riding its own piece.
export interface EdVisual {
  kind: "primitive" | "mesh";
  mesh: string; // manifest key; "" = none named yet
  // The object's placement is the ITEM's own `pos`/`rot` - a geometry object is
  // an object with a transform like every other, so the look does not carry a
  // second one that could disagree with it. What is left here is the two
  // rotations and the depth the item's in-plane transform cannot express.
  offsetZ: number; // metres off the gameplay plane, positive toward the camera
  rotX: number;
  rotY: number;
  scale: number; // dimensionless
  depth: number | null; // metres; null = the shape's own thickness
  texture: string; // texture key (authored set or material); "" = from material
  tileScale: number | null; // multiple of the texture's own size; null = 1 (life size)
  // Where the pattern starts, metres in level coordinates (+x right, +y down).
  // A plain number rather than nullable: 0 is both the default and a perfectly
  // ordinary authored value, so there is no third state to represent.
  tileOffset: Vec2;
  bevel: number | null; // metres; null = the extruder's default
  // What the shape GIVES OFF (see `VisualData.emissive`). "" = nothing, which is
  // every shape: emission is what makes a lamp's own geometry read as lit, and
  // it is a statement rather than an appearance, so there is no sensible
  // non-empty default.
  emissive: string;
  emissiveIntensity: number;
  // A texture set whose EMISSION MAP this shape wears - where it glows, as
  // against how much. "" = none named, which leaves the shape's own surface to
  // decide (see `GeometryObjectData.emissiveTexture`).
  //
  // These three are ALL of emission now, and they are appearance and nothing
  // else. A shape that emits used to derive a light out of seven more fields
  // here - its reach, its cone, its aim, its shadow, its flicker - because a
  // light had no way to be attached to the thing it belonged to. It has one now:
  // a light item grouped into the same body IS the lamp's light, and it cannot
  // drift from the fitting because they are one body.
  emissiveTexture: string;
}

// A body's own frame: the transform its objects are placed in, and what the file
// records as the body's `x`/`y`/`rot`.
export interface EdBodyFrame {
  pos: Vec2; // metres
  rot: number; // radians
}

export interface EdModel {
  player: { pos: Vec2; radius: number };
  items: EdItem[];
  chains: EdChain[];
  vines: EdVine[];
  // THE FRAME EACH BODY'S OBJECTS ARE PLACED IN, by body id.
  //
  // It is STORED rather than read off a member, and that is the whole point. It
  // used to be "wherever the body's FIRST object is", which made that object
  // secretly the body itself: nudging it moved the body, and since every sibling
  // is recorded as an offset from the frame, every sibling's offset changed by
  // the same amount to compensate. One object moved 10 cm and the file recorded
  // the body moving 10 cm and every other object moving 10 cm back - the same
  // geometry, written as an edit nobody made, in a panel that then read as the
  // body having moved.
  //
  // Stored, a body's frame is its own: an edit to one object inside it changes
  // that object's offset and nothing else, and the frame moves only when the
  // BODY moves (`translateItems` / `rotateItemsAbout` carry it exactly when the
  // whole body is in the set being moved).
  //
  // Absent means "wherever the body's first object is", which is where a body's
  // frame has always been measured from and is what a freshly loaded level
  // carries. That is exact for the body of ONE object almost every body is - any
  // move of that object is a move of the whole body - so a level of simple
  // bodies stores nothing and saves byte-for-byte as it did. What makes it safe
  // for the rest is that every body holding more than one object has its frame
  // written down before anything is edited (`pinBodyFrame`, from the editor's
  // `beginAction`), so a body that can be edited a piece at a time always has one.
  bodyFrames: Map<number, EdBodyFrame>;
  // The level's light and air (see `EnvironmentData`). One object rather than a
  // list, because it is a property of the LEVEL and not of anything in it.
  //
  // It is carried here rather than left out because the editor rewrites the
  // whole file every 750 ms, so anything it does not carry is DELETED from disk
  // the first time a level is opened - and this block is exactly the thing a
  // level lit from inside cannot do without (`sunIntensity: 0` is how a level
  // says it is underground). Nothing about that failure is visible in the
  // editor: the scene is rebuilt from the model, so it goes on looking however
  // the model says, and the loss only shows up next time the game loads the file.
  environment: EnvironmentData | undefined;
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
  blend: null,
  buffer: null,
  bufferLeft: null,
  bufferRight: null,
  bufferTop: null,
  bufferBottom: null,
  priority: 0,
  rangeX: null,
  rangeY: null,
  falloffX: null,
  falloffY: null,
  lookaheadX: null,
  lookaheadY: null,
  lookaheadBufferX: null,
  lookaheadBufferY: null,
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
  flicker: 0,
});

export const defaultNote = (): EdNote => ({
  kind: "text",
  text: "",
  size: DEFAULT_NOTE_TEXT_SIZE * PX,
});

// A fresh look is a `primitive` with everything defaulted: this object's own
// form given the default depth and wearing the default generated surface.
// `visualData` writes nothing at all for one in this state beyond the object's
// own shape, so a level that never touches the section stays as small on disk as
// its geometry allows.
export const defaultVisual = (): EdVisual => ({
  kind: "primitive",
  mesh: "",
  offsetZ: 0,
  rotX: 0,
  rotY: 0,
  scale: 1,
  depth: null,
  texture: "",
  tileScale: null,
  tileOffset: Vec2.ZERO,
  bevel: null,
  emissive: "",
  emissiveIntensity: 1,
  emissiveTexture: "",
});

// Camera regions and notes are editor-only furniture — they are never drawn in
// game, so their appearance is fixed here rather than authored and saved.
export const CAMERA_REGION_COLOR = "#c792ea";
export const CAMERA_REGION_OPACITY = 0.12;
export const NOTE_COLOR = "#98c379";
export const NOTE_OPACITY = 0.08;

// Appearance a freshly drawn item starts with, per layer. Geometry is authored
// from here on; the other two are fixed furniture.
// A light's fill is very faint on purpose: the item is as big as the light
// REACHES, which on a lamp lighting a room is most of that room, and a wash at
// the other layers' opacity would sit over the geometry being lit. What makes it
// legible is the ring and the star at its centre, not the fill.
export const LIGHT_FILL_OPACITY = 0.06;

// Half-size of the placeholder a DRESSING carries, in metres. It has no authored
// outline, so this is only what the editor draws and picks it by - the save
// writes no `shape` at all.
export const DRESSING_GIZMO = 0.3;

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

// --- conversions ------------------------------------------------------------

// On-disk shape → editor shape. A polygon's vertices are copied into Vec2s
// (they are mutated in place by the vertex handles, so they must not alias the
// loaded data).
function edShape(s: ShapeData): EdShape {
  if (s.kind === "rect") return { kind: "rect", w: s.w, h: s.h };
  if (s.kind === "circle") return { kind: "circle", r: s.r };
  return { kind: "poly", verts: s.verts.map((v) => new Vec2(v.x, v.y)) };
}

// An on-disk visual, filled out into the live object the inspector edits. An
// absent field takes the default, so a file that authored one number does not
// come back with ten.
export function edVisual(v: GeometryObjectData | undefined): EdVisual {
  const d = defaultVisual();
  if (!v) return d;
  return {
    kind: v.kind ?? d.kind,
    mesh: v.mesh ?? d.mesh,
    tileScale: v.tileScale ?? d.tileScale,
    tileOffset: new Vec2(v.tileOffsetX ?? 0, v.tileOffsetY ?? 0),
    offsetZ: v.z ?? d.offsetZ,
    rotX: v.rotX ?? d.rotX,
    rotY: v.rotY ?? d.rotY,
    scale: v.scale ?? d.scale,
    depth: v.depth ?? null,
    texture: v.texture ?? d.texture,
    bevel: v.bevel ?? null,
    emissive: v.emissive ?? d.emissive,
    emissiveIntensity: v.emissiveIntensity ?? d.emissiveIntensity,
    emissiveTexture: v.emissiveTexture ?? d.emissiveTexture,
  };
}

// ...and back, writing ONLY what differs from the default. A body whose visual
// section was never touched writes no `visual` key at all, which is what keeps
// every level authored before the field byte-identical through a save - the same
// rule `material` and `thickness` are written under.
// ...and back, as the GEOMETRY OBJECT the look becomes, writing ONLY what
// differs from the default. A body whose visual section was never touched
// produces no geometry object at all, which is what keeps every level authored
// before the field byte-identical through a save - the same rule `material` and
// `thickness` are written under.
//
// `shape` is the caller's to add: a form of its own carries one and a dressing
// does not, and that is the difference between decoration and a wall wearing
// brick (see `GeometryObjectData.shape`).
export function visualData(v: EdVisual): GeometryObjectData | undefined {
  const d = defaultVisual();
  const out: GeometryObjectData = {
    type: "geometry",
    ...(v.kind !== d.kind ? { kind: v.kind } : {}),
    ...(v.kind === "mesh" && v.mesh ? { mesh: v.mesh } : {}),
    ...(v.offsetZ !== 0 ? { z: v.offsetZ } : {}),
    // Out-of-plane tips are a PROP's, like `mesh` above: `mountVisual` builds the
    // holder that carries them only for a mesh, and a primitive is its own
    // outline extruded along z, so writing them there records a pose nothing
    // draws and an author cannot see - which is exactly what the gizmo's x and y
    // rings used to be before they were dropped for a primitive.
    ...(v.kind === "mesh" && v.rotX !== 0 ? { rotX: v.rotX } : {}),
    ...(v.kind === "mesh" && v.rotY !== 0 ? { rotY: v.rotY } : {}),
    ...(v.scale !== d.scale ? { scale: v.scale } : {}),
    ...(v.depth !== null ? { depth: v.depth } : {}),
    ...(v.texture ? { texture: v.texture } : {}),
    ...(v.tileScale !== null ? { tileScale: v.tileScale } : {}),
    ...(v.tileOffset.x !== 0 ? { tileOffsetX: v.tileOffset.x } : {}),
    ...(v.tileOffset.y !== 0 ? { tileOffsetY: v.tileOffset.y } : {}),
    ...(v.bevel !== null ? { bevel: v.bevel } : {}),
    ...(v.emissive ? { emissive: v.emissive } : {}),
    // Only written alongside an emissive colour: a multiplier on nothing is a
    // field that reads as meaningful and is not.
    ...(v.emissive && v.emissiveIntensity !== d.emissiveIntensity
      ? { emissiveIntensity: v.emissiveIntensity }
      : {}),
    // Not gated on the colour: an emission MAP is emission in its own right -
    // it glows in the colours it was painted in, and the colour beside it is a
    // tint over that rather than the thing being turned on.
    ...(v.emissiveTexture ? { emissiveTexture: v.emissiveTexture } : {}),
  };
  // `type` alone means nothing was authored.
  return Object.keys(out).length > 1 ? out : undefined;
}

// An on-disk material name resolved to one the editor can put in its picker.
// A name this build does not have loads as the default, exactly as the runtime
// loader resolves it (`materialDensity`), rather than as an entry the picker
// cannot show.
function materialName(name: string | undefined): MaterialName {
  return name !== undefined && name in MATERIALS ? (name as MaterialName) : DEFAULT_MATERIAL;
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
  // ONE ITEM PER SCENE OBJECT, and the objects of one body share a group id.
  // That is exactly what the retired `group` TAG meant, so the editor's grouping
  // machinery - selecting, moving and rotating a body as one - carries over
  // unchanged, and what it gains is that a LIGHT can be in the group too.
  //
  // The two ways an item becomes a geometry object are the two things a geometry
  // object is (see `GeometryObjectData.shape`): one with a shape of its own is a
  // FORM, and becomes an item of its own; one without DRESSES the body's
  // collision outlines, and is folded onto the collision item it dresses as that
  // item's `visual`, since the editor has no way to draw a look with no outline.
  //
  // Placement is flattened to WORLD here and re-derived on the way out. The
  // editor manipulates items in world metres throughout - every drag, handle and
  // marquee is written that way - and a body's frame is a property of the file
  // rather than of the gesture.
  const bodies: EdItem[] = [];
  // Which item stands for each authored body, so a chain naming a body by index
  // finds something to hold. The first COLLISION item, since that is what a
  // chain is bolted to; a body with none is a body a chain cannot name.
  const itemOfBody: (EdItem | null)[] = [];
  for (const b of data.bodies) {
    const firstOfBody = bodies.length;
    // ONE ITEM PER SCENE OBJECT. Nothing is folded together: a barrel is a body
    // holding a collision box and a mesh, and it arrives here as two items in
    // one body rather than as one item that is secretly both.
    const bodyId = newBodyId();
    const base = {
      layer: "scene" as const,
      bodyId,
      kind: b.kind,
      color: b.color ?? DEFAULT_BODY_COLOR,
      opacity: b.opacity ?? DEFAULT_BODY_OPACITY,
      friction: b.friction ?? DEFAULT_SURFACE_FRICTION,
      force: b.force ?? 0,
      flow: b.flow ?? 0,
      drag: b.drag ?? 0,
      passable: b.passable === true,
      pivot: b.pivot === true,
      springFreqX: b.springFreqX ?? 0,
      springFreqY: b.springFreqY ?? 0,
      springDamping: b.springDamping ?? DEFAULT_SPRING_DAMPING,
      cam: defaultCamera(),
      light: defaultLight(),
      note: defaultNote(),
      anchorId: 0,
      matchId: 0,
    };
    // Geometry objects whose file says they mirror a collision sibling; the
    // partner is resolved once the whole body is in, below.
    const matched: EdItem[] = [];
    for (const o of b.objects) {
      const w = worldPlacement(b, o);
      if (isCollisionObject(o)) {
        bodies.push({
          ...base,
          id: newBodyId(),
          object: "collision",
          pos: w.pos,
          rot: w.rot,
          shape: edShape(o.shape),
          impermeable: o.impermeable === true,
          material: materialName(o.material),
          thickness: o.thickness ?? DEFAULT_THICKNESS,
          visual: defaultVisual(),
        });
        continue;
      }
      if (isGeometryObject(o)) {
        const g: EdItem = {
          ...base,
          id: newBodyId(),
          object: "geometry",
          pos: w.pos,
          rot: w.rot,
          // Every geometry object carries its own form. One from a file that
          // predates that (a dressing, which drew the body's collision
          // outlines) gets the same placeholder gizmo an orphan prop does, and
          // is saved with it - the editor is where such a file is finished
          // being migrated, and a shape it can neither see nor drag is worse
          // than a small one it can.
          shape: o.shape ? edShape(o.shape) : { kind: "rect", w: DRESSING_GIZMO, h: DRESSING_GIZMO },
          impermeable: false,
          material: DEFAULT_MATERIAL,
          thickness: DEFAULT_THICKNESS,
          // Its own fill, which decoration carries rather than taking the
          // body's - a backdrop is authored to sit behind the geometry.
          color: o.color ?? base.color,
          opacity: o.opacity ?? base.opacity,
          visual: edVisual(o),
        };
        bodies.push(g);
        if (o.matchCollision === true) matched.push(g);
        continue;
      }
      if (isAnchorObject(o)) {
        bodies.push({
          ...base,
          id: newBodyId(),
          object: "anchor",
          pos: w.pos,
          rot: w.rot,
          // A point has no size. The gizmo is what the canvas draws and what a
          // click has to land on, and it is the same one a dressing gets.
          shape: { kind: "rect", w: DRESSING_GIZMO, h: DRESSING_GIZMO },
          impermeable: false,
          material: DEFAULT_MATERIAL,
          thickness: DEFAULT_THICKNESS,
          visual: defaultVisual(),
          anchorId: o.id,
        });
        continue;
      }
      bodies.push(lightItem(o, w.pos, w.rot, bodyId));
    }
    // Re-tie each matched geometry object to its collision partner. The link's
    // own invariant means an editor-written file always holds an EXACT twin, so
    // the outline is the identity and no index is stored to go stale. A
    // hand-edited file may have let them drift: with one collision object the
    // intent is unambiguous, so the geometry snaps back onto it; with several
    // there is nothing safe to guess and the link is dropped rather than tied
    // to a piece nobody chose.
    const made = bodies.slice(firstOfBody);
    const collisions = made.filter((i) => i.object === "collision");
    for (const g of matched) {
      const exact = collisions.find((c) => outlinesEqual(c, g));
      const target = exact ?? (collisions.length === 1 ? collisions[0]! : undefined);
      if (!target) continue;
      g.matchId = target.id;
      if (!exact) copyMatchedOutline(target, g);
    }
    itemOfBody.push(made.find((i) => i.object === "collision") ?? null);
  }

  const regions: EdItem[] = (data.cameraRegions ?? []).map((r) => ({
    id: newBodyId(),
    layer: "camera",
    object: "collision",
    bodyId: newBodyId(), // its own body: neither layer is drawn in play
    kind: "static", // unused on this layer; keeps the field total
    pos: new Vec2(r.x, r.y),
    rot: r.rot,
    shape: edShape(r.shape),
    color: CAMERA_REGION_COLOR,
    opacity: CAMERA_REGION_OPACITY,
    friction: DEFAULT_SURFACE_FRICTION,
    impermeable: false,
    // Unused off the geometry layer; keeps the field total.
    material: DEFAULT_MATERIAL,
    thickness: DEFAULT_THICKNESS,
    visual: defaultVisual(),
    force: 0,
    flow: 0,
    drag: 0,
    passable: false,
    pivot: false,
    springFreqX: 0,
    springFreqY: 0,
    springDamping: DEFAULT_SPRING_DAMPING,
    cam: {
      offset: new Vec2(r.offsetX ?? 0, r.offsetY ?? 0),
      viewportScale: r.viewportScale ?? DEFAULT_VIEWPORT_SCALE,
      lockX: r.lockX ?? null,
      lockY: r.lockY ?? null,
      blend: r.blend ?? null,
      buffer: r.buffer ?? null,
      bufferLeft: r.bufferLeft ?? null,
      bufferRight: r.bufferRight ?? null,
      bufferTop: r.bufferTop ?? null,
      bufferBottom: r.bufferBottom ?? null,
      priority: r.priority ?? 0,
      // A region has no corridor and no lookahead.
      rangeX: null,
      rangeY: null,
      falloffX: null,
      falloffY: null,
      lookaheadX: null,
      lookaheadY: null,
      lookaheadBufferX: null,
      lookaheadBufferY: null,
    },
    light: defaultLight(),
    note: defaultNote(),
    anchorId: 0,
    matchId: 0,
  }));

  // Camera paths: the same item type as a region, distinguished by its shape
  // kind. One item type per layer rather than a union is what keeps a path
  // dragged, rotated, rubber-banded, duplicated and undone by exactly the code
  // a region already goes through.
  const camPaths: EdItem[] = (data.cameraPaths ?? []).map((c) => ({
    id: newBodyId(),
    layer: "camera",
    object: "collision",
    bodyId: newBodyId(), // its own body: this layer is not drawn in play
    kind: "static", // unused on this layer; keeps the field total
    pos: new Vec2(c.x, c.y),
    rot: c.rot,
    shape: {
      kind: "path",
      verts: c.verts.map((v) => new Vec2(v.x, v.y)),
      handles: c.verts.map((v) => ({
        in: new Vec2(v.inX ?? 0, v.inY ?? 0),
        out: new Vec2(v.outX ?? 0, v.outY ?? 0),
      })),
    },
    color: CAMERA_REGION_COLOR,
    opacity: CAMERA_REGION_OPACITY,
    friction: DEFAULT_SURFACE_FRICTION,
    impermeable: false,
    // Unused off the geometry layer; keeps the field total.
    material: DEFAULT_MATERIAL,
    thickness: DEFAULT_THICKNESS,
    visual: defaultVisual(),
    force: 0,
    flow: 0,
    drag: 0,
    passable: false,
    pivot: false,
    springFreqX: 0,
    springFreqY: 0,
    springDamping: DEFAULT_SPRING_DAMPING,
    cam: {
      // A path IS the position rule, so it has no offset and no lock to compose
      // with (see "Explicitly out of scope" in plans/camera-tracking.md).
      offset: Vec2.ZERO,
      viewportScale: c.viewportScale ?? DEFAULT_VIEWPORT_SCALE,
      lockX: null,
      lockY: null,
      blend: c.blend ?? null,
      buffer: c.buffer ?? null,
      bufferLeft: null,
      bufferRight: null,
      bufferTop: null,
      bufferBottom: null,
      priority: c.priority ?? 0,
      rangeX: c.rangeX ?? null,
      rangeY: c.rangeY ?? null,
      falloffX: c.falloffX ?? null,
      falloffY: c.falloffY ?? null,
      lookaheadX: c.lookaheadX ?? null,
      lookaheadY: c.lookaheadY ?? null,
      lookaheadBufferX: c.lookaheadBufferX ?? null,
      lookaheadBufferY: c.lookaheadBufferY ?? null,
    },
    light: defaultLight(),
    note: defaultNote(),
    anchorId: 0,
    matchId: 0,
  }));
// One light OBJECT as the editor item that edits it. The lights layer is a view
// over light objects wherever they live rather than a list of its own: a light
// with no fitting is a body containing only this, and a lamp's light is this
// grouped into the body its fitting is in. Both are the same item.
function lightItem(
  l: LightObjectData,
  pos: Vec2,
  rot: number,
  bodyId: number,
): EdItem {
  return {
    id: newBodyId(),
    layer: "scene",
    object: "light",
    bodyId,
    kind: "static", // unused on this layer; keeps the field total
    pos,
    // A light's item rotation IS its object rotation, which is what turns a
    // spot's aim: the direction is authored in the object's own frame.
    rot,
    // The reach IS the shape - see `EdLight`.
    shape: { kind: "circle", r: l.range ?? DEFAULT_LIGHT_RANGE },
    color: l.color ?? DEFAULT_LIGHT_COLOR,
    opacity: LIGHT_FILL_OPACITY,
    friction: DEFAULT_SURFACE_FRICTION,
    impermeable: false,
    // Unused off the geometry layer; keeps the field total.
    material: DEFAULT_MATERIAL,
    thickness: DEFAULT_THICKNESS,
    visual: defaultVisual(),
    force: 0,
    flow: 0,
    drag: 0,
    passable: false,
    pivot: false,
    springFreqX: 0,
    springFreqY: 0,
    springDamping: DEFAULT_SPRING_DAMPING,
    cam: defaultCamera(),
    light: {
      kind: l.kind ?? "point",
      intensity: l.intensity ?? DEFAULT_LIGHT_INTENSITY,
      z: l.z ?? DEFAULT_LIGHT_Z,
      angle: l.angle ?? DEFAULT_SPOT_ANGLE,
      penumbra: l.penumbra ?? DEFAULT_SPOT_PENUMBRA,
      dir: new Vec2(l.dirX ?? 0, l.dirY ?? 1),
      dirZ: l.dirZ ?? 0,
      castShadow: l.castShadow === true,
      shadowNear: l.shadowNear ?? null,
      flicker: l.flicker ?? 0,
    },
    note: defaultNote(),
    anchorId: 0,
    matchId: 0,
  };
}

  const notes: EdItem[] = (data.notes ?? []).map((n) => ({
    id: newBodyId(),
    layer: "notes",
    object: "collision",
    bodyId: newBodyId(), // its own body: neither layer is drawn in play
    kind: "static", // unused on this layer; keeps the field total
    pos: new Vec2(n.x, n.y),
    rot: n.rot,
    shape: { kind: "rect", w: n.w, h: n.h },
    color: NOTE_COLOR,
    opacity: NOTE_OPACITY,
    friction: DEFAULT_SURFACE_FRICTION,
    impermeable: false,
    // Unused off the geometry layer; keeps the field total.
    material: DEFAULT_MATERIAL,
    thickness: DEFAULT_THICKNESS,
    visual: defaultVisual(),
    force: 0,
    flow: 0,
    drag: 0,
    passable: false,
    pivot: false,
    springFreqX: 0,
    springFreqY: 0,
    springDamping: DEFAULT_SPRING_DAMPING,
    cam: defaultCamera(),
    light: defaultLight(),
    anchorId: 0,
    matchId: 0,
    note: {
      kind: n.kind,
      text: n.text ?? "",
      size: n.size ?? DEFAULT_NOTE_TEXT_SIZE * PX,
    },
  }));
  // Chains name their two ends by ANCHOR id, and each anchor is an item above -
  // so the whole of the conversion is looking the two up. A chain naming an
  // anchor the level does not contain (a hand-edited file) is dropped rather
  // than left dangling.
  const itemOfAnchor = new Map<number, EdItem>();
  for (const i of bodies) if (i.object === "anchor") itemOfAnchor.set(i.anchorId, i);
  const chains: EdChain[] = [];
  for (const c of data.chains ?? []) {
    const a = itemOfAnchor.get(c.a);
    const b = itemOfAnchor.get(c.b);
    if (!a || !b) continue;
    chains.push({
      id: newBodyId(),
      a: a.id,
      b: b.id,
      length: c.length ?? null,
      color: c.color ?? null,
    });
  }

  // A vine names ONE anchor, and is dropped the same way a chain is when the
  // anchor it names is not in the file.
  const vines: EdVine[] = [];
  for (const v of data.vines ?? []) {
    const a = itemOfAnchor.get(v.anchor);
    if (!a) continue;
    vines.push({
      id: newBodyId(),
      anchor: a.id,
      length: v.length,
      spacing: v.spacing ?? null,
      density: v.density ?? null,
      stiffness: v.stiffness ?? null,
      color: v.color ?? null,
    });
  }

  return {
    player: { pos: new Vec2(data.player.x, data.player.y), radius: data.player.radius },
    items: [...bodies, ...regions, ...camPaths, ...notes],
    chains,
    vines,
    // None recorded on load. A body's frame is derived from its first object
    // until something is edited (`EdModel.bodyFrames`), which is the origin this
    // has always re-measured every body against on the way back out - so a level
    // opened and saved untouched is byte-stable exactly as it was, and a body
    // migrated out of a retired flat entry is still re-origined onto its shape
    // rather than left measuring from the (0, 0) the migration gave it.
    bodyFrames: new Map(),
    // Copied rather than shared, since everything else here hands the caller a
    // fresh object, and undo snapshots this by value.
    environment: data.environment ? { ...data.environment } : undefined,
  };
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
export function toLevelData(model: EdModel, itemOf?: Map<SceneObjectData, number>): LevelData {
  // A camera PATH has no ShapeData form at all - an open polyline is not one of
  // the three shapes - so it never reaches here: the camera layer is split by
  // shape kind below, and a path is written as a `CameraPathData` instead.
  const shapeOf = (i: EdItem): ShapeData => {
    if (i.shape.kind === "rect") return { kind: "rect", w: i.shape.w, h: i.shape.h };
    if (i.shape.kind === "circle") return { kind: "circle", r: i.shape.r };
    return { kind: "poly", verts: i.shape.verts.map((v) => ({ x: v.x, y: v.y })) };
  };

  const cameraPaths: CameraPathData[] = model.items
    .filter((i) => i.layer === "camera" && i.shape.kind === "path")
    .map((i) => ({
      x: i.pos.x,
      y: i.pos.y,
      rot: i.rot,
      // A zero handle is written as nothing at all, so a path of plain corners
      // saves exactly the four keys it always did.
      verts: pathNodes(i).map((n) => ({
        x: n.p.x,
        y: n.p.y,
        ...(n.in.x !== 0 ? { inX: n.in.x } : {}),
        ...(n.in.y !== 0 ? { inY: n.in.y } : {}),
        ...(n.out.x !== 0 ? { outX: n.out.x } : {}),
        ...(n.out.y !== 0 ? { outY: n.out.y } : {}),
      })),
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
      ...(i.cam.blend !== null ? { blend: i.cam.blend } : {}),
      ...(i.cam.buffer !== null ? { buffer: i.cam.buffer } : {}),
      ...(i.cam.priority !== 0 ? { priority: i.cam.priority } : {}),
    }));

  const cameraRegions: CameraRegionData[] = model.items
    .filter((i) => i.layer === "camera" && i.shape.kind !== "path")
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
      // Per-side buffers mean nothing off a rect, so they are not written for
      // one: a field on disk the loader ignores is a field that lies about what
      // it does.
      ...(i.shape.kind === "rect"
        ? {
            ...(i.cam.bufferLeft !== null ? { bufferLeft: i.cam.bufferLeft } : {}),
            ...(i.cam.bufferRight !== null ? { bufferRight: i.cam.bufferRight } : {}),
            ...(i.cam.bufferTop !== null ? { bufferTop: i.cam.bufferTop } : {}),
            ...(i.cam.bufferBottom !== null ? { bufferBottom: i.cam.bufferBottom } : {}),
          }
        : {}),
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

  // ITEMS BACK INTO BODIES. Items sharing a group id are one body; an ungrouped
  // item is a body of its own. The run is emitted where its FIRST member sits,
  // so the body order is the item order and a chain's index is stable across a
  // save.
  //
  // Geometry first and then lights, so a body's collision objects come before
  // the light in it - which is the order the renderers walk and the order the
  // light budgets are spent in. A light grouped into a geometry body joins that
  // body rather than making one of its own, which is the whole of what welding a
  // lamp's light to its fitting now takes.
  const runs = bodyRuns(
    model.items.filter((i) => i.layer === "scene"),
  );
  // A run's members are written in layer order within the run, so a light
  // authored before the wall it hangs on still lands after it.
  for (const run of runs) {
    run.sort((a, b) => (a.object === b.object ? 0 : a.object === "collision" ? -1 : a.object === "geometry" ? 0 : 1));
  }

  // The body's own frame (`EdModel.bodyFrames`), with its objects written local
  // to it. That is what gives a body a real transform on disk - turning the body
  // turns everything in it, aim included - while the editor goes on manipulating
  // items in world metres, which is what every drag, handle and marquee is
  // written in.
  const bodies: LevelBodyData[] = runs.map((run) => {
    const origin = bodyFrameOf(model, run[0]!.bodyId);
    const lead = run.find((i) => i.object === "collision") ?? run[0]!;
    const cos = Math.cos(-origin.rot);
    const sin = Math.sin(-origin.rot);
    const localOf = (i: { pos: Vec2; rot: number }): { x?: number; y?: number; rot?: number } => {
      const dx = i.pos.x - origin.pos.x;
      const dy = i.pos.y - origin.pos.y;
      const x = dx * cos - dy * sin;
      const y = dx * sin + dy * cos;
      const rot = i.rot - origin.rot;
      return {
        ...(x !== 0 ? { x } : {}),
        ...(y !== 0 ? { y } : {}),
        ...(rot !== 0 ? { rot } : {}),
      };
    };

    const objects: SceneObjectData[] = [];
    // Every object written goes through this, so one cannot reach the file
    // without `itemOf` recording which item wrote it.
    const emit = (item: EdItem, o: SceneObjectData): void => {
      objects.push(o);
      itemOf?.set(o, item.id);
    };
    for (const i of run) {
      if (i.object === "anchor") {
        // A placement and the id chains name it by, and nothing else - which is
        // all an anchor is.
        emit(i, { type: "anchor", id: i.anchorId, ...localOf(i) });
        continue;
      }
      if (i.object === "light") {
        const d = defaultLight();
        const spot = i.light.kind === "spot";
        emit(i, {
          type: "light",
          ...localOf(i),
          // Omit anything left at its default, so a saved light carries only
          // what was authored - the rule every other list here is written under.
          ...(spot ? { kind: "spot" as const } : {}),
          ...(i.light.z !== d.z ? { z: i.light.z } : {}),
          ...(i.color !== DEFAULT_LIGHT_COLOR ? { color: i.color } : {}),
          ...(i.light.intensity !== d.intensity ? { intensity: i.light.intensity } : {}),
          // The reach lives in the shape (see `EdLight`). A light whose item is
          // not a circle cannot happen through any edit path, but the fallback
          // keeps the write total rather than saving a light with no reach.
          ...(i.shape.kind === "circle" && i.shape.r !== DEFAULT_LIGHT_RANGE
            ? { range: i.shape.r }
            : {}),
          // The cone and its aim mean nothing on a point light, and a field on
          // disk the loader ignores is a field that lies about what it does.
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
          // Read only while the light casts, so - like the cone on a point
          // light - it is written only then: a field on disk the loader ignores
          // is a field that lies about what it does.
          ...(i.light.castShadow && i.light.shadowNear !== null
            ? { shadowNear: i.light.shadowNear }
            : {}),
          ...(i.light.flicker !== 0 ? { flicker: i.light.flicker } : {}),
        });
        continue;
      }
      if (i.object === "collision") {
        emit(i, {
          type: "collision",
          ...localOf(i),
          shape: shapeOf(i),
          // Absent means "an ordinary surface", so only a hook-proof one says so.
          ...(i.impermeable ? { impermeable: true } : {}),
          // Written only when the piece is something other than the default
          // 20 cm of oak, so every level authored before materials stays
          // byte-identical. Per COLLISION OBJECT and nowhere else: a body's
          // mass, centre of mass and inertia are sums over its pieces, and what
          // a thing is made of is a fact about the shape rather than about the
          // model drawn over it.
          ...(i.material !== DEFAULT_MATERIAL ? { material: i.material } : {}),
          ...(i.thickness !== DEFAULT_THICKNESS ? { thickness: i.thickness } : {}),
        });
        continue;
      }
      // A geometry object: its own transform, its own form, and its own look.
      const look = visualData(i.visual) ?? { type: "geometry" as const };
      // Its fill is written only where it DIFFERS from the body's, which is what
      // a body-level fill is for: a wall's primitive takes the colour the wall
      // is painted and writes nothing, and a backdrop welded into that body -
      // authored to sit behind the geometry rather than to match it - carries
      // its own. A body with no collision object has no fill of its own to
      // inherit, so its decoration always states one.
      const bodyFill = lead.object === "collision" ? lead : undefined;
      const ownFill = i.color !== bodyFill?.color || i.opacity !== bodyFill?.opacity;
      emit(i, {
        ...look,
        ...localOf(i),
        shape: shapeOf(i),
        // Written only while the partner is still a collision object in this
        // body, so a stale link an edit has not yet pruned cannot reach disk.
        ...(i.matchId !== 0 && run.some((m) => m.id === i.matchId && m.object === "collision")
          ? { matchCollision: true }
          : {}),
        ...(ownFill ? { color: i.color, opacity: i.opacity } : {}),
      });
    }

    return {
      kind: lead.object === "collision" ? lead.kind : "static",
      x: origin.pos.x,
      y: origin.pos.y,
      rot: origin.rot,
      // Only a GEOMETRY lead has a body fill to give. A body that is nothing but
      // a light has no fill at all, and writing the light's own faint editor
      // colour as one would put a body colour on disk that nothing draws.
      ...(lead.object === "collision" ? { color: lead.color, opacity: lead.opacity } : {}),
      // The physics half is written only for a body that HAS some. A body of
      // decoration with a friction on disk is a file stating properties nothing
      // reads, which is how a field quietly starts lying about what it does.
      ...(lead.object === "collision"
        ? {
            friction: lead.friction,
            // Only force areas carry a magnitude; omitting it elsewhere keeps
            // saved levels free of a field that would read as meaningful.
            ...(lead.kind === "force" ? { force: lead.force } : {}),
            // Water carries a current and a rate for the same reason, and only
            // where it means something.
            ...(lead.kind === "water" ? { flow: lead.flow, drag: lead.drag } : {}),
            // Hook-only geometry, and only when set: an absent field is the
            // colliding body every level authored before the flag has. Written
            // for every kind that builds a body - a static one is the retired
            // `anchor` kind, a rigid one is the leaf it could not express.
            ...(lead.passable ? { passable: true } : {}),
            // A bearing means something only on a rigid body, and only when
            // set - an absent field is the free body every old level has.
            ...(lead.kind === "rigid" && lead.pivot ? { pivot: true } : {}),
            // A spring means something only on a rigid body that is not on a
            // bearing, and only when a frequency is actually set - a body with
            // neither axis sprung is the ordinary free rigid body every old
            // level has, and writing three zeroes for it would put a mechanic
            // on disk that nothing applies. The damping rides along with them
            // rather than being written on its own, for the same reason.
            ...(lead.kind === "rigid" &&
            !lead.pivot &&
            (lead.springFreqX > 0 || lead.springFreqY > 0)
              ? {
                  ...(lead.springFreqX > 0 ? { springFreqX: lead.springFreqX } : {}),
                  ...(lead.springFreqY > 0 ? { springFreqY: lead.springFreqY } : {}),
                  springDamping: lead.springDamping,
                }
              : {}),
          }
        : {}),
      objects,
    };
  });

  // Which body each item ended up in, so a chain can be refused when both of its
  // anchors landed in one. Derived from the same runs the bodies were, in the
  // same order.
  const bodyOfItem = new Map<number, number>();
  runs.forEach((run, i) => {
    for (const item of run) bodyOfItem.set(item.id, i);
  });

  const chains: ChainData[] = [];
  for (const c of model.chains) {
    const a = model.items.find((i) => i.id === c.a);
    const b = model.items.find((i) => i.id === c.b);
    // A chain whose anchor has been deleted has nothing to hold and is simply
    // not written. Nor has one whose two anchors have ended up in the SAME body
    // - merging the two things a chain held together is a chain tied to itself,
    // which the loader would drop anyway.
    if (a?.object !== "anchor" || b?.object !== "anchor") continue;
    if (bodyOfItem.get(a.id) === bodyOfItem.get(b.id)) continue;
    chains.push({
      a: a.anchorId,
      b: b.anchorId,
      // Omitted = taut between the anchors, which the loader re-derives.
      ...(c.length !== null ? { length: c.length } : {}),
      ...(c.color !== null ? { color: c.color } : {}),
    });
  }

  const vines: VineData[] = [];
  for (const v of model.vines) {
    const a = model.items.find((i) => i.id === v.anchor);
    // A vine whose anchor has been deleted has nothing to hang from, and one of
    // no length has nothing to be - both are dropped rather than written for the
    // loader to drop again.
    if (a?.object !== "anchor" || !(v.length > 0)) continue;
    vines.push({
      anchor: a.anchorId,
      length: v.length,
      ...(v.spacing !== null ? { spacing: v.spacing } : {}),
      ...(v.density !== null ? { density: v.density } : {}),
      ...(v.stiffness !== null ? { stiffness: v.stiffness } : {}),
      ...(v.color !== null ? { color: v.color } : {}),
    });
  }

  return {
    player: { x: model.player.pos.x, y: model.player.pos.y, radius: model.player.radius },
    bodies,
    // An empty list is the same as no list, and the absent field keeps levels
    // authored before camera regions (or notes) byte-identical.
    ...(cameraRegions.length ? { cameraRegions } : {}),
    ...(cameraPaths.length ? { cameraPaths } : {}),
    // Written back verbatim. It is not derived from anything in the item list,
    // so there is nothing to rebuild - and leaving it out is not "the editor
    // does not support it", it is the editor DELETING a level's lighting the
    // first time the file is opened.
    ...(model.environment ? { environment: { ...model.environment } } : {}),
    ...(notes.length ? { notes } : {}),
    ...(chains.length ? { chains } : {}),
    ...(vines.length ? { vines } : {}),
  };
}

// On-disk pixel LevelData → editor model.
export function modelFromDisk(pixelData: RawLevelData): EdModel {
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
  // A path's verts are an OPEN run rather than a loop, so anything treating the
  // result as closed (the even-odd containment test, the seam walk) must ask
  // the shape kind first; what is shared is the bounds, the handles and the
  // transform, which read a vertex list either way.
  if (item.shape.kind === "poly" || item.shape.kind === "path") return item.shape.verts;
  const hw = item.shape.w / 2;
  const hh = item.shape.h / 2;
  return [new Vec2(-hw, hh), new Vec2(-hw, -hh), new Vec2(hw, -hh), new Vec2(hw, hh)];
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

// The only writer of a polygon's vertices. It re-centres them on their centroid
// and shifts `pos` to compensate, so the drawn geometry does not move while the
// origin lands where the physics needs it — and it refuses a loop that is not a
// shape at all, leaving the outline as it was rather than saving one that
// crosses itself (or, for a camera region, one that is not convex). Returns
// whether the edit was accepted.
export function setPolyVerts(item: EdItem, verts: readonly Vec2[]): boolean {
  if (item.shape.kind !== "poly" || verts.length < 3) return false;
  const ordered = polySignedArea2(verts) >= 0 ? [...verts] : [...verts].reverse();
  if (polyMustBeConvex(item) ? !isConvexLoop(ordered) : !isSimpleLoop(ordered)) return false;
  const c = polyCentroid(ordered);
  item.shape.verts = ordered.map((v) => v.sub(c));
  item.pos = item.pos.add(c.rotated(item.rot));
  return true;
}

// The only writer of a camera path's vertices, and the mirror of
// `setPolyVerts` - it drops consecutive duplicates, requires two verts left
// over, and re-centres `pos` on the vert AVERAGE. A polyline has no area
// centroid, and the average is what keeps the transform gizmo somewhere
// sensible on the thing it is transforming.
//
// There is deliberately no simplicity or convexity rule: a path may cross
// itself, that being exactly what a switchback is.
export function setPathVerts(
  item: EdItem,
  verts: readonly Vec2[],
  handles?: readonly { in: Vec2; out: Vec2 }[],
): boolean {
  if (item.shape.kind !== "path") return false;
  const src = handles ?? item.shape.handles;
  const kept: Vec2[] = [];
  const keptH: { in: Vec2; out: Vec2 }[] = [];
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]!;
    const last = kept[kept.length - 1];
    if (last && last.distanceTo(v) < 1e-9) continue;
    kept.push(v);
    keptH.push(src[i] ? { in: src[i]!.in, out: src[i]!.out } : ZERO_HANDLE());
  }
  if (kept.length < 2) return false;
  // Re-centred on the point AVERAGE. The handles are offsets from their own
  // point, so they are untouched by it - which is the reason they are stored as
  // offsets rather than as absolute control points.
  const c = kept.reduce((a, b) => a.add(b), Vec2.ZERO).div(kept.length);
  item.shape.verts = kept.map((v) => v.sub(c));
  item.shape.handles = keptH;
  item.pos = item.pos.add(c.rotated(item.rot));
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
    // Scaling an outline leaves it exactly as convex or as simple as it was, so
    // `setPolyVerts` refuses nothing here - it is used for the re-centring,
    // which keeps `pos` the centroid the rigid-body lever arms assume.
    setPolyVerts(
      item,
      base.verts.map((v) => new Vec2(v.x * fx, v.y * fy)),
    );
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
  for (const v of item.shape.verts) {
    x = Math.max(x, Math.abs(v.x));
    y = Math.max(y, Math.abs(v.y));
  }
  return new Vec2(x, y);
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
  if (item.shape.kind === "poly") {
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
    return distanceToPolyline(flattenPath(pathNodes(item)), l) <= PATH_PICK_HALF_WIDTH;
  }
  if (item.shape.kind === "rect") {
    return Math.abs(l.x) <= item.shape.w / 2 && Math.abs(l.y) <= item.shape.h / 2;
  }
  // Even-odd, not "inside every face's half-plane": the half-plane answer is the
  // convex one and fills in a notch, so clicking through the gap in a C-shaped
  // wall would pick the wall.
  return loopContainsPoint(item.shape.verts, l);
}

// --- bodies -----------------------------------------------------------------

// Every object in `bodyId`, in model order.
export function bodyMembers(items: readonly EdItem[], bodyId: number): EdItem[] {
  return items.filter((i) => i.bodyId === bodyId);
}

// The selection an item click means: the whole body it is in. A body IS one
// object as far as the level is concerned, so picking one of its pieces and
// picking it are the same act (Alt+click is what reaches past this to a single
// object).
export function pickBodyOf(items: readonly EdItem[], item: EdItem): EdItem[] {
  return bodyMembers(items, item.bodyId);
}

// THE BODIES OF A MODEL, in the order their first object appears - which is the
// order `toLevelData` writes them and therefore the order a chain's body index
// counts in. One definition, so the save path and the outliner cannot disagree
// about what a body is or how many there are.
export function bodyRuns(items: readonly EdItem[]): EdItem[][] {
  const runs: EdItem[][] = [];
  const byId = new Map<number, EdItem[]>();
  for (const i of items) {
    const existing = byId.get(i.bodyId);
    if (existing) {
      existing.push(i);
      continue;
    }
    const run = [i];
    byId.set(i.bodyId, run);
    runs.push(run);
  }
  return runs;
}

// WHAT A BODY IS CALLED in the outliner: its kind, and what it is made of. A
// body has no authored name - there is nothing in the format to hold one - so
// the label is derived, and it is derived from the same things the format
// distinguishes rather than from anything the editor keeps on the side.
export function bodyLabel(members: readonly EdItem[]): string {
  const lead = bodyLead(members);
  if (lead) return lead.kind;
  const first = members[0];
  if (!first) return "empty";
  if (first.object === "light") return "light";
  if (first.layer === "camera") return "camera";
  if (first.layer === "notes") return "note";
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
  if (item.layer === "notes") return item.note.kind === "arrow" ? "arrow" : "text";
  if (item.layer === "camera") return item.shape.kind === "path" ? "path" : "region";
  const form =
    item.shape.kind === "rect"
      ? `${n(item.shape.w)}×${n(item.shape.h)}`
      : item.shape.kind === "circle"
        ? `r${n(item.shape.r)}`
        : `${item.shape.verts.length}v`;
  // A mesh is named by its asset, since that is what tells two props apart -
  // their placeholders are usually identical.
  if (item.visual.kind === "mesh") return `mesh ${item.visual.mesh || "(none)"}`;
  // A geometry object is named by the SOLID it draws rather than by the outline
  // it is authored through, since that is what the player sees and what tells it
  // apart from the collision shape it may be sitting on top of.
  const what =
    item.object === "collision" || item.shape.kind === "path"
      ? item.shape.kind
      : PRIMITIVE_NAME[item.shape.kind];
  return `${what} ${form}`;
}

// What a primitive's outline is drawn as in 3D - the same mapping
// `primitiveGeometry` makes, said in words for the outliner.
// A camera path is never a geometry object, so it has no solid to be named
// after and is not in this table.
const PRIMITIVE_NAME: Record<"rect" | "circle" | "poly", string> = {
  rect: "box",
  circle: "cylinder",
  poly: "prism",
};

// Area of an item's shape, in m².
export function shapeArea(item: EdItem): number {
  if (item.shape.kind === "circle") return Math.PI * item.shape.r * item.shape.r;
  if (item.shape.kind === "rect") return item.shape.w * item.shape.h;
  // An open polyline has none. It is never a piece of a body, so nothing weighs
  // it - answering zero rather than the signed area of a loop that is not there
  // is what keeps that true if one ever reaches a mass sum.
  if (item.shape.kind === "path") return 0;
  return Math.abs(polySignedArea2(item.shape.verts)) / 2;
}

// Mass of an item's shape, in kg - the same answer `ShapeGeometry.computeMass`
// gives the built body, asked through the same function rather than restated
// here. Area is NOT a stand-in for it: a circle is a sphere and a rect or
// polygon a slab of `SCENE_DEPTH`, so the two stopped being proportional the
// moment masses became physical.
export function shapeMass(item: EdItem): number {
  return prismMass(shapeArea(item), item.thickness, MATERIALS[item.material]);
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
    acc = acc.add(i.pos.mul(a));
  }
  if (total > 0) return acc.div(total);
  // Degenerate (zero-area) shapes: fall back to the plain mean so the answer is
  // still inside the group rather than NaN.
  return weighed.reduce((c, i) => c.add(i.pos), Vec2.ZERO).div(Math.max(1, weighed.length));
}

// --- body frames ------------------------------------------------------------

// The frame `bodyId`'s objects are placed in. Absent from the model it is the
// body's first object, which is exact for a body of one - see `EdModel.bodyFrames`.
export function bodyFrameOf(model: EdModel, bodyId: number): EdBodyFrame {
  const stored = model.bodyFrames.get(bodyId);
  if (stored) return stored;
  const first = model.items.find((i) => i.bodyId === bodyId);
  return first ? { pos: first.pos, rot: first.rot } : { pos: Vec2.ZERO, rot: 0 };
}

// Write down where a body's frame currently is, so that it stops following the
// object it was being read off. Called wherever a body gains a second member:
// past that point the body can be edited a piece at a time, and a frame derived
// from one of those pieces is a frame that piece silently moves.
export function pinBodyFrame(model: EdModel, bodyId: number): void {
  if (!model.bodyFrames.has(bodyId)) model.bodyFrames.set(bodyId, bodyFrameOf(model, bodyId));
}

// Carry the frames of the bodies `items` touches, but only where the WHOLE body
// is in the set: a body's frame moves when the body moves, and an edit to some
// of its objects is not that. Returns nothing - it is called for its effect on
// the model, before the items themselves are moved (the derived frame of a body
// with none stored has to be read while it still means what it meant).
function carryBodyFrames(
  model: EdModel,
  items: readonly EdItem[],
  move: (f: EdBodyFrame) => EdBodyFrame,
): void {
  const moving = new Map<number, number>();
  for (const i of items) moving.set(i.bodyId, (moving.get(i.bodyId) ?? 0) + 1);
  for (const [bodyId, count] of moving) {
    if (count < bodyMembers(model.items, bodyId).length) continue; // part of a body: its frame stays
    const stored = model.bodyFrames.get(bodyId);
    // With none stored the frame is the first object's and moves with it, which
    // is what moving the whole body does to it anyway.
    if (stored) model.bodyFrames.set(bodyId, move(stored));
  }
}

// Translate a set of items, carrying the frame of any body moving in full.
export function translateItems(model: EdModel, items: readonly EdItem[], d: Vec2): void {
  if (d.x === 0 && d.y === 0) return;
  carryBodyFrames(model, items, (f) => ({ pos: f.pos.add(d), rot: f.rot }));
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
  carryBodyFrames(model, items, (f) => ({
    pos: centre.add(f.pos.sub(centre).rotated(delta)),
    rot: f.rot + delta,
  }));
  for (const i of items) {
    i.pos = centre.add(i.pos.sub(centre).rotated(delta));
    i.rot += delta;
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

// Body-level properties a compound body has exactly one of. When several items
// build into one body only the first member's are used, so the editor copies
// the lead's onto the rest rather than letting a file disagree with what it
// draws.
//
// `material`, `thickness` and `visual` are deliberately NOT among them: they
// are per shape, and a body whose pieces are made of different things is the
// case that motivates them (a stone head on a wooden shaft). The build reads
// every piece's own (`makePiece`, and `render3d/scene.ts` for the visual), so
// copying the lead's would be the editor overwriting what was authored.
//
// Non-colliding members are left alone entirely: decoration is not a piece of
// the body, it is carried by it, and it has none of these properties - its fill
// is its own (a backdrop is authored to sit behind the geometry, so painting it
// the geometry's colour is exactly wrong), and kind, friction and force mean
// nothing on a shape nothing collides with.
export function syncBodyProps(members: readonly EdItem[]): void {
  const lead = bodyLead(members);
  if (!lead) return;
  for (const m of members) {
    if (m === lead || m.object !== "collision") continue;
    m.kind = lead.kind;
    m.color = lead.color;
    m.opacity = lead.opacity;
    m.friction = lead.friction;
    m.force = lead.force;
    m.flow = lead.flow;
    m.drag = lead.drag;
    m.passable = lead.passable;
    m.pivot = lead.pivot;
    m.springFreqX = lead.springFreqX;
    m.springFreqY = lead.springFreqY;
    m.springDamping = lead.springDamping;
  }
}

// --- matched outlines -------------------------------------------------------

// Do two items state the SAME outline - position, rotation and shape? It is the
// identity a matched pair is resolved by at load, so it takes an epsilon: the
// editor writes the pair byte-equal, but a hand-edited file is allowed a
// rounding error without silently losing its link.
export function outlinesEqual(a: EdItem, b: EdItem, eps = 1e-9): boolean {
  if (Math.abs(a.pos.x - b.pos.x) > eps || Math.abs(a.pos.y - b.pos.y) > eps) return false;
  if (Math.abs(a.rot - b.rot) > eps) return false;
  const s = a.shape;
  const t = b.shape;
  if (s.kind === "rect" && t.kind === "rect")
    return Math.abs(s.w - t.w) <= eps && Math.abs(s.h - t.h) <= eps;
  if (s.kind === "circle" && t.kind === "circle") return Math.abs(s.r - t.r) <= eps;
  if (s.kind === "poly" && t.kind === "poly")
    return (
      s.verts.length === t.verts.length &&
      s.verts.every(
        (v, i) => Math.abs(v.x - t.verts[i]!.x) <= eps && Math.abs(v.y - t.verts[i]!.y) <= eps,
      )
    );
  return false;
}

// Write one item's outline onto the other - the whole of what a matched pair
// shares. The shape is cloned, never aliased: both sides' shapes are mutated in
// place by every resize path, and a shared object would turn "kept equal" into
// "secretly one shape", which no edit could ever diverge again.
export function copyMatchedOutline(from: EdItem, to: EdItem): void {
  to.pos = new Vec2(from.pos.x, from.pos.y);
  to.rot = from.rot;
  to.shape = cloneShape(from.shape);
}

// An item's outline as one comparable string - what `syncMatchedOutlines` uses
// to tell WHICH side of a pair an edit touched. The bodyId is in it so a
// membership change reads as a change too.
function outlineSig(i: EdItem): string {
  const s = i.shape;
  const shape =
    s.kind === "rect"
      ? `r${s.w},${s.h}`
      : s.kind === "circle"
        ? `c${s.r}`
        : `${s.kind === "path" ? "L" : "p"}${s.verts.map((v) => `${v.x},${v.y}`).join(";")}`;
  return `${i.pos.x},${i.pos.y},${i.rot},${i.bodyId}|${shape}`;
}

// Keep every matched pair's outlines equal, in whichever direction the last
// edit went. Called from the editor's one dirty funnel (`markDirty`), so every
// edit path - inspector field, corner handle, gizmo, nudge, vertex drag - flows
// through it without knowing the link exists.
//
// `sigs` is the caller's memory of each linked item's outline as of the last
// sync: the side that differs from its record is the side that was edited, and
// the other side follows it. Both differing means they moved together (a body
// drag) or the model was replaced wholesale (undo, load) - in either case the
// pair is already consistent, and the collision side leads if it somehow is
// not, since collision is what the level PLAYS as. A link whose partner is
// gone, is not a collision object, or has left the body is dropped here, which
// is what lets Delete and Split not know about it either.
//
// The pass repeats until nothing moves (two geometry objects may mirror one
// collision shape, so a copy can make a second pair stale); it converges
// because every copy makes two outlines equal and none makes any unequal.
export function syncMatchedOutlines(model: EdModel, sigs: Map<number, string>): void {
  const byId = new Map(model.items.map((i) => [i.id, i]));
  const pairs: Array<[EdItem, EdItem]> = [];
  for (const g of model.items) {
    if (g.object !== "geometry" || g.matchId === 0) continue;
    const c = byId.get(g.matchId);
    if (!c || c.object !== "collision" || c.bodyId !== g.bodyId) {
      g.matchId = 0;
      continue;
    }
    pairs.push([g, c]);
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const [g, c] of pairs) {
      if (outlineSig(g) === outlineSig(c)) continue;
      const gEdited = sigs.get(g.id) !== outlineSig(g);
      const cEdited = sigs.get(c.id) !== outlineSig(c);
      const lead = gEdited && !cEdited ? g : c;
      copyMatchedOutline(lead, lead === g ? c : g);
      changed = true;
    }
    if (!changed) break;
  }
  sigs.clear();
  for (const [g, c] of pairs) {
    sigs.set(g.id, outlineSig(g));
    sigs.set(c.id, outlineSig(c));
  }
}

// --- chains -----------------------------------------------------------------

export function cloneChain(c: EdChain): EdChain {
  return { ...c };
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

// Where a chain end currently sits in the world, or null if its anchor is gone.
// It is simply the anchor's own position: the anchor IS the end, so there is no
// second copy of the point to keep in step with it.
export function chainEndWorld(model: EdModel, end: number): Vec2 | null {
  const item = model.items.find((i) => i.id === end);
  return item?.object === "anchor" ? item.pos : null;
}

// The anchor item a chain end names, or null.
export function chainAnchor(model: EdModel, end: number): EdItem | null {
  const item = model.items.find((i) => i.id === end);
  return item?.object === "anchor" ? item : null;
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

// --- vines ------------------------------------------------------------------

export function cloneVine(v: EdVine): EdVine {
  return { ...v };
}

// Where a vine hangs from, or null if its anchor has gone.
export function vineAnchorWorld(model: EdModel, v: EdVine): Vec2 | null {
  const item = model.items.find((i) => i.id === v.anchor);
  return item?.object === "anchor" ? item.pos : null;
}

// The two ends of the vine as the EDITOR draws it: straight down from the anchor
// by its authored length.
//
// That is the rest pose and nothing more. Where a vine actually hangs is a
// runtime answer - it drapes over whatever is under it, and the player drags it
// about - and drawing a guess at that would be a drawing of something the level
// does not contain, which is the same rule the editor draws a chain straight by.
export function vineRest(model: EdModel, v: EdVine): { top: Vec2; tip: Vec2 } | null {
  const top = vineAnchorWorld(model, v);
  return top ? { top, tip: top.add(new Vec2(0, v.length)) } : null;
}

// Distance from a world point to that rest pose, for picking.
export function distanceToVine(model: EdModel, v: EdVine, world: Vec2): number {
  const ends = vineRest(model, v);
  if (!ends) return Infinity;
  const d = ends.tip.sub(ends.top);
  const len2 = d.lengthSquared();
  if (len2 < 1e-12) return world.distanceTo(ends.top);
  const t = Math.min(1, Math.max(0, world.sub(ends.top).dot(d) / len2));
  return world.distanceTo(ends.top.add(d.mul(t)));
}

// A blank level: a single wide floor under a spawn point so it is immediately
// testable.
export function emptyModel(): EdModel {
  return {
    player: { pos: new Vec2(0, -1), radius: 0.08 },
    chains: [],
    vines: [],
    // Nothing stored: a fresh level's one body holds one object, whose placement
    // IS the frame (see `EdModel.bodyFrames`).
    bodyFrames: new Map(),
    // A fresh level authors none, which is every level authored before the
    // block and is what the renderer's own defaults are for.
    environment: undefined,
    items: [
      {
        id: newBodyId(),
        layer: "scene",
        object: "collision",
        bodyId: newBodyId(),
        kind: "static",
        pos: new Vec2(0, 0),
        rot: 0,
        shape: { kind: "rect", w: 8, h: 0.6 },
        color: DEFAULT_BODY_COLOR,
        opacity: DEFAULT_BODY_OPACITY,
        friction: DEFAULT_SURFACE_FRICTION,
        impermeable: false,
        material: DEFAULT_MATERIAL,
        thickness: DEFAULT_THICKNESS,
        visual: defaultVisual(),
        force: 0,
        flow: 0,
        drag: 0,
        passable: false,
        pivot: false,
        springFreqX: 0,
        springFreqY: 0,
        springDamping: DEFAULT_SPRING_DAMPING,
        cam: defaultCamera(),
        light: defaultLight(),
        note: defaultNote(),
        anchorId: 0,
        matchId: 0,
      },
    ],
  };
}
