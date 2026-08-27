// Level editor. Owns its own canvas loop and DOM overlay (toolbar + inspector),
// manipulates an EdModel with the mouse, tests the scene with either controller,
// and saves/loads levels from disk through the dev-server API.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { BALL_ZOOM, GRAPPLE_ZOOM, screenToWorld, worldToScreen, type Camera } from "../render/camera";
import { LETTERBOX_COLOR, VIEW_HEIGHT, VIEW_WIDTH, viewTransform } from "../render/viewport";
import {
  CAMERA_BLEND_TIME,
  CameraController,
  REGION_EXIT_MARGIN,
} from "../render/cameraController";
import { render, renderBall } from "../render/renderer";
import { SparkSystem } from "../render/sparks";
import { Level } from "../level/level";
import { BallLevel } from "../level/ballLevel";
import { LiveInputSource } from "../input/liveInput";
import { BallInputSource } from "../input/ballInput";
import type { FrameInput, IInputSource } from "../input/frameInput";
import {
  DEFAULT_FORCE_MAGNITUDE,
  DEFAULT_PATH_FALLOFF_X,
  DEFAULT_PATH_FALLOFF_Y,
  DEFAULT_PATH_LOOKAHEAD_BUFFER_X,
  DEFAULT_PATH_LOOKAHEAD_BUFFER_Y,
  DEFAULT_PATH_LOOKAHEAD_X,
  DEFAULT_PATH_LOOKAHEAD_Y,
  DEFAULT_PATH_RANGE_X,
  DEFAULT_PATH_RANGE_Y,
  DEFAULT_WATER_DRAG,
  DEFAULT_WATER_FLOW,
  DEFAULT_BOUNCE,
  DEFAULT_LAUNCH,
  DEFAULT_SURFACE_FRICTION,
  type BodyKind,
} from "../level/levelFormat";
import {
  arrowEnds,
  bodyIntersectsRect,
  anchorItem,
  chainEnds,
  chainEndWorld,
  vineAnchorWorld,
  vineAnchor2World,
  vineRestPath,
  distanceToVine,
  MIN_VINE_LENGTH,
  cloneChain,
  cloneVine,
  cloneShape,
  convexHull,
  bodyWithinRect,
  defaultCamera,
  defaultNote,
  defaultVisual,
  type EdVisual,
  distanceToChain,
  ED_LAYERS,
  emptyModel,
  bodyBounds,
  boundsInside,
  itemBounds,
  bodyCentroid,
  bodyLabel,
  bodyLead,
  bodyMembers,
  bodyRuns,
  objectLabel,
  halfExtents,
  isArrowNote,
  collidingBodyIds,
  itemDepth,
  newItemStyle,
  type EdObject,
  MIN_ARROW_LENGTH,
  DEFAULT_ENVIRONMENT,
  defaultLight,
  modelFromDisk,
  modelToDisk,
  toLevelData,
  newBodyId,
  NOTE_ARROW_BAND,
  NOTE_DEFAULT_ARROW_LENGTH,
  NOTE_DEFAULT_SIZE,
  nearestSurfaceLocal,
  DRESSING_GIZMO,
  pickBodyOf,
  pointInBody,
  rotateItemsAbout,
  translateItems,
  bodyFrameOf,
  settledGhosts,
  type SettleGhost,
  pinBodyFrame,
  setArrowEnds,
  shapeMass,
  polyMustBeConvex,
  PATH_PICK_HALF_WIDTH,
  pathNodes,
  pathPolyline,
  reversePathVerts,
  sharpenPathNodes,
  smoothPathNodes,
  setPathVerts,
  ZERO_HANDLE,
  setPolyVerts,
  scaleShape,
  syncBodyProps,
  syncMatchedOutlines,
  copyMatchedOutline,
  outlinesEqual,
  toWorld,
  visualData,
  worldVertices,
  type EdChain,
  type EdVine,
  type EdBodyFrame,
  type EdItem,
  type EdShape,
  type EdLayer,
  type EdModel,
} from "./model";
import {
  computeChainHandles,
  computeVineHandles,
  computeGroupHandles,
  computeHandles,
  drawEditor,
  hasPlaneHandles,
  BODY_MEMBER,
  SELECT,
  CHAIN_DEFAULT_COLOR,
  VINE_DEFAULT_COLOR,
  CHAIN_HIT_PX,
  HANDLE_HIT_PX,
  lightPickRadius,
  depthOf,
} from "./render";
import {
  DEFAULT_MATERIAL,
  DEFAULT_THICKNESS,
  MATERIALS,
  MATERIAL_NAMES,
  type MaterialName,
} from "../lib/shapeGeometry";
import { decomposeConvex, isSimpleLoop, normalizeWinding } from "../lib/polygon";
import { deleteLevel, listLevels, loadLevel, saveLevel } from "./api";
import {
  emissiveMapNames,
  HDRI_ASSETS,
  hdriNames,
  isSolidSurface,
  MESH_ASSETS,
  SOLID_SURFACE,
  surfaceName,
  tileMetres,
  TEXTURE_ASSETS,
} from "../render3d/assets";
import * as THREE from "three";
import { Scene3D, type Scene3DLevel } from "../render3d/scene";
import {
  isHeadOn,
  MAX_ORBIT_PITCH,
  threeY,
  threeRotation,
  unprojectToPlane,
  type CameraOrbit,
  type ViewProjection,
} from "../render3d/space";
import { EditorGizmo, type GizmoAxes, type GizmoHandlers, type GizmoMode } from "./gizmo";
import { World } from "../engine/world";
import { buildLevelBodies, DEFAULT_SPRING_DAMPING, MAX_SPRING_FREQ } from "../level/buildBodies";
import {
  BRANCH_DEFAULT_DAMPING,
  BRANCH_DEFAULT_STIFFNESS,
  DEFAULT_VINE_DAMPING,
  DEFAULT_VINE_DENSITY,
  DEFAULT_VINE_SPACING,
  vineTargetSpacing,
  DEFAULT_VINE_STIFFNESS,
  LIGHT_LINK_MASS,
  MIN_VINE_DENSITY,
} from "../level/vines";
import { Player } from "../classes/player";
import {
  digest,
  digestBall,
  serializeInput,
  type Digest,
  type Recording,
  type SerializedFrame,
} from "../sim/trace";
import type { EnvironmentData, LevelData, SceneObjectData } from "../level/levelFormat";
import {
  DEFAULT_LIGHT_COLOR,
  DEFAULT_LIGHT_RANGE,
  LIGHT_SHADOW_BUDGET,
} from "../render3d/lights";

// `geometry` draws the OTHER kind of scene object: a rect like `rect`, but one
// that is drawn and never simulated. It is a tool rather than a mode on the rect
// tool because what a shape IS is the first thing an author decides about it, and
// a draw that has to be corrected afterwards in the inspector is the coupling
// this pair of objects exists to avoid.
type Tool =
  | "select"
  | "rect"
  | "circle"
  | "poly"
  | "path"
  | "geometry"
  | "text"
  | "arrow"
  | "chain"
  | "vine"
  | "light";

// Which tools each layer offers. A shape tool has no meaning on the notes layer
// (a note is a text box or an arrow, never a circle) and vice versa, so the
// toolbar shows only the applicable ones and switching layer drops a tool that
// no longer applies. `+Chain` is scene-only: a chain is strung between two
// bodies, and no other layer has any.
//
// `+Light` sits beside the shape tools rather than on a layer of its own,
// because that is what a light is: another kind of scene object, dropped into
// the same layer and welded into a body with the shape it belongs to.
const LAYER_TOOLS: Record<EdLayer, Tool[]> = {
  scene: ["select", "rect", "circle", "poly", "geometry", "light", "chain", "vine"],
  camera: ["select", "rect", "circle", "poly", "path"],
  notes: ["select", "text", "arrow"],
};

// Kinds a chain may be tied to. An area is a region, not a body - nothing hangs
// off a killzone or a current - so the chain tool passes straight through one.
const CHAINABLE_KINDS: BodyKind[] = ["static", "rigid"];
// Decoration is excluded for the plainer reason that it builds no body at all:
// a chain tied to one would have nothing to constrain, and the loader drops it.
const chainable = (b: EdItem): boolean =>
  b.object === "collision" && CHAINABLE_KINDS.includes(b.kind);

// What the inspector says when nothing is selected: what the active layer is
// for, and how to put something on it.
const EMPTY_HINTS: Record<EdLayer, string> = {
  scene:
    "No selection. Click a body, or pick +Rect / +Circle and drag on the canvas; +Poly clicks out an outline, concave corners and all (Enter or click the first vertex to close, Esc to cancel) - the physics gets it cut into convex pieces, so a notch is one object rather than three overlapping ones. Those draw a COLLISION shape - what the body is made of, simulated and never drawn. +Geometry draws the other half: an object that is drawn and never simulated, which is what carries a mesh or a texture. A body wants one of each, and they are two decisions. +Chain drags a chain from one body to another. Ctrl+G moves the selected objects into ONE body (Ctrl+Shift+G takes bodies apart again; Alt+click picks one object out of a body). The panel bottom-left lists every body and expands it into the objects it is made of, which is the only way to reach an object with no outline - a light, or the mesh a wall is dressed in. Rubber-band from empty space: drag left→right to catch what the box encloses, right→left for anything it touches. +Light drops a lamp - drag as you place it to set how far it reaches. A light with no visible source is a body of its own (a shaft down a grate, a fill); a lamp you can see is a light merged into the body its fitting is in, so moving the fitting moves the light. Any visible layer can be selected.",
  camera:
    "Camera layer. Click a region, drag to rubber-band select, or pick +Rect / +Circle and drag one out (+Poly clicks out an outline). Tab switches layer.",
  notes:
    "Notes layer. +Text drops a box to type into, +Arrow drags a pointer out. Notes are editor-only and never appear in play. Tab switches layer.",
};

// Kinds offered by both kind pickers (toolbar + inspector), in one place so
// they can't drift apart.
const BODY_KINDS: BodyKind[] = ["static", "rigid", "killzone", "force", "water"];

// How far the pointer must travel before a press that could mean either becomes
// a drag rather than a click, in screen pixels. Small enough that a deliberate
// drag never reads as a click, large enough that a hand shaking on a mouse
// button does not turn a selection into a pan.
const CLICK_SLOP_PX = 4;
// Orbit sensitivity: a drag across a 1600px window is a bit over a half turn,
// which is enough to see round a prop without a level swinging past under a
// nudge.
const ORBIT_RADIANS_PER_PX = 0.006;

type Drag =
  | { mode: "pan"; lastScreen: Vec2 }
  // A press on something that is NOT selected yet: it pans, and selects only if
  // the pointer never really moved. The level is the thing you are looking at
  // most of the time, so dragging it about has to be the cheapest gesture there
  // is - and moving geometry by accident, while reaching for the view, is the
  // one editing mistake that is silent (it looks like the level, and the level
  // is different). Selecting first and dragging second is what makes moving a
  // body deliberate.
  | { mode: "panPick"; lastScreen: Vec2; travel: number; pick: () => void }
  // Turning the 3D view about what it is centred on (see `CameraOrbit`). Middle
  // button, and only while a scene is drawn: in the 2D view there is nothing to
  // orbit, so the button keeps panning there.
  | { mode: "orbit"; lastScreen: Vec2 }
  // Rubber-band select. `additive` (shift) unions the hits into the existing
  // selection instead of replacing it. `verts` is the shape whose VERTICES the
  // band catches instead of bodies: drawn while a polygon is being edited, a
  // band is asking about that shape's corners, which is the only thing on
  // screen it could sensibly mean once the shape itself is already picked.
  | { mode: "marquee"; start: Vec2; current: Vec2; additive: boolean; verts: EdItem | null }
  // The lead body follows the pointer (and the grid); the rest of the
  // selection rides along at a fixed offset from it.
  // `press` and `moved` are what keep a click apart from a drag on something
  // already selected: until the pointer has really travelled, the gesture is
  // still a click and `pick` is what it means (drilling into the body under it).
  | {
      mode: "move";
      lead: EdItem;
      others: Array<{ body: EdItem; offset: Vec2 }>;
      grab: Vec2;
      press: Vec2;
      moved: boolean;
      pick?: () => void;
    }
  | { mode: "movePlayer"; grab: Vec2 }
  | { mode: "corner"; body: EdItem; anchor: Vec2 }
  | { mode: "radius"; body: EdItem }
  // The one axis the canvas has no direction for: dragging up moves the object
  // toward the camera. Measured from where the press was rather than per move,
  // so the grid's rounding cannot accumulate across the drag.
  | { mode: "depth"; body: EdItem; base: number; press: Vec2 }
  | { mode: "rotate"; body: EdItem }
  // One vertex of a polygon follows the pointer. `accepted` is the last position
  // the loop was still a shape at, so a drag that would fold the outline over
  // itself stalls there instead of writing something with no inside. Denting the
  // outline inward is not that and is allowed: a concave outline is cut into
  // convex pieces at load (a camera region is the exception - see
  // `polyMustBeConvex` - and stalls at the last convex position).
  // `others` is the rest of the vertex selection, riding along at a fixed offset
  // from the pressed vertex in the SHAPE's own frame - a difference of two local
  // positions, which is what survives `setPolyVerts` re-centring the loop on its
  // centroid, since the re-centring subtracts the same point from both.
  | {
      mode: "polyVertex";
      body: EdItem;
      index: number;
      others: Array<{ index: number; offset: Vec2 }>;
      accepted: Vec2;
    }
  // One Bézier tangent grip of a camera path. `mirror` keeps the node smooth by
  // writing the opposite handle as the negation of this one; Alt breaks it, so a
  // deliberate cusp is a modifier away rather than unauthorable.
  | { mode: "pathHandle"; body: EdItem; index: number; side: "in" | "out"; mirror: boolean }
  // One end of an arrow note follows the pointer; the other stays put.
  | { mode: "arrowEnd"; body: EdItem; fixed: Vec2; movingIsHead: boolean }
  // A whole compound body turns about its centre of mass - the point its built
  // body's origin sits at, so the drag is the body's own rotation and not a
  // per-piece one. `grabAngle` is where the pointer was when the drag started,
  // so the group turns by how far the pointer has swung rather than snapping its
  // (arbitrary) first member's angle to the cursor.
  | { mode: "rotateGroup"; items: EdItem[]; centre: Vec2; grabAngle: number; applied: number }
  // Stringing a new chain out from a body: the anchor is fixed in `from`'s local
  // frame, and the free end follows the pointer until it is dropped on a body.
  | { mode: "chainDraw"; from: EdItem; local: Vec2; cursor: Vec2 }
  // Re-anchoring one end of an existing chain. It follows the pointer and lands
  // on whatever body it is dropped on, so moving a chain end and moving it to a
  // different body are one gesture.
  | { mode: "chainEnd"; chain: EdChain; end: "a" | "b"; cursor: Vec2 }
  // Pulling a new vine out of a body: the anchor is fixed in `from`'s local
  // frame, and the drag's DIRECTION is authored along with its length -
  // straight down is the ordinary hanging vine, and any other direction makes
  // a springy BRANCH (an angled, stiff, lightly damped vine - see `addVine`) and the drag sets the LENGTH rather than reaching for a second body,
  // which is the whole of the difference between a vine and a chain.
  | { mode: "vineDraw"; from: EdItem; local: Vec2; cursor: Vec2 }
  // Dragging a placed vine's free end, which is the same edit by hand - or,
  // with SHIFT held over a body, carrying that end toward a second anchor:
  // releasing there attaches the vine at both ends and makes it a span.
  // `startLength` is the length the drag began at, restored while the attach
  // gesture is live (the vertical length tracking means nothing sideways) and
  // kept as the span's slack when it lands.
  | { mode: "vineLength"; vine: EdVine; startLength: number; cursor: Vec2; attach: EdItem | null }
  // Dragging a SPAN's second-anchor end: the same act as re-anchoring a chain
  // end - the anchor object moves, and over nothing it stays on the body it
  // has. Releasing with SHIFT over empty space DETACHES it instead, back to a
  // hanging vine of the same length.
  | { mode: "vineEnd"; vine: EdVine; cursor: Vec2; detach: boolean }
  // Moving a placed vine: its anchor follows the pointer and lands on whatever
  // body it is dropped on, so sliding a vine along the branch it hangs from and
  // moving it to a different branch are one gesture. The same drag a chain end
  // is re-anchored by, and for the same reason - the anchor IS the vine's
  // placement, so this moves an object rather than re-pointing the vine at one.
  | { mode: "vineAnchor"; vine: EdVine }
  | { mode: "draw"; body: EdItem; start: Vec2 };

// Arrow-key nudge directions (world axes, +y down).
const NUDGE_DIRS: Record<string, Vec2 | undefined> = {
  ArrowLeft: new Vec2(-1, 0),
  ArrowRight: new Vec2(1, 0),
  ArrowUp: new Vec2(0, -1),
  ArrowDown: new Vec2(0, 1),
};

const STEP = 1 / 60;
// One step plus one of catch-up, deeper debt shed - same policy and same
// measurement as `MAX_STEPS_PER_FRAME` in main.ts: five banked catch-up steps
// were the 13 fps death spiral on a machine whose sim step is over the render
// budget.
const MAX_STEPS = 2;

const M2PX = PIXELS_PER_METER;

// Angles are authored in degrees everywhere in the inspector (`rot°`), and
// stored in radians everywhere else.
const deg = (r: number): number => (r * 180) / Math.PI;
const rad = (d: number): number => (d * Math.PI) / 180;

export function startEditor(canvas: HTMLCanvasElement, sceneCanvas?: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;

  // --- 3D view --------------------------------------------------------------
  // The editor is the SECOND host of `Scene3D` (see its header): everything
  // mutable lives on the instance, so the game page and this page each have
  // their own and share only the immutable material cache.
  //
  // Three states rather than two, because collision authoring and looking at the
  // level are different jobs:
  //   "2d"      - exactly the editor as it was, no WebGL at all.
  //   "3d"      - the scene alone, for judging how a level reads.
  //   "overlay" - the default: the scene beneath, collision outlines and handles
  //               on top, which is what makes placing geometry against a 3D
  //               scene as precise as placing it against nothing.
  type ViewMode = "2d" | "3d" | "overlay";
  let viewMode: ViewMode = "overlay";
  const scene3d = ((): Scene3D | null => {
    if (!sceneCanvas) return null;
    try {
      return new Scene3D(sceneCanvas);
    } catch (err) {
      console.warn("[render3d] WebGL unavailable, the editor stays 2D:", err);
      return null;
    }
  })();
  if (!scene3d) viewMode = "2d";
  // How much of the scene the 2D overlay is responsible for. With a scene under
  // it the overlay drops every fill - and the geometry objects entirely, since
  // the scene draws those and an outline on the plane describes something else
  // (see `drawEditor` and `hasPlaneHandles`). One statement of it, because what
  // the overlay DRAWS and what it offers handles for have to be the same set.
  const overlayLayers = (): "fill" | "outline" =>
    scene3d && viewMode !== "2d" ? "outline" : "fill";
  // How far the 3D view is turned from the side-on view the level is authored
  // against. Editor-only, and zero for every other host (see `CameraOrbit`).
  //
  // Turned at all, the overlay is not drawn: it is a projection of the gameplay
  // plane straight onto the screen, so at any other angle its outlines, handles
  // and marquee would sit somewhere the geometry is not - a level authored
  // against a picture that is a few degrees out is a level authored wrongly.
  //
  // What the overlay drew is not the same set as what a click can MEAN, though,
  // and those two were run together for as long as the pick was resolved on the
  // plane by the 2D camera. A ray answers for the models and meets the plane for
  // everything else at any angle (`canvasWorld`, `raycastItems`), so selecting
  // and dragging survive the turn and only the drawn chrome - handles, band,
  // draw previews - drops out with the overlay. See the press handler.
  const orbit: CameraOrbit = { yaw: 0, pitch: 0 };
  const orbited = (): boolean => scene3d !== null && viewMode !== "2d" && !isHeadOn(orbit);
  // Which lens the scene is drawn through (see `ViewProjection`). Perspective is
  // what the level is played in and so the default; orthographic is the
  // authoring instrument - with no perspective divide, geometry at any depth is
  // drawn at exactly the scale the plane is, so two things being in line on
  // screen means they are in line in the level.
  //
  // It is a property of EDITING rather than of the scene: a ▶ Test is played
  // through the perspective camera whatever this says, since the whole point of
  // a test is that the framing is the player's (see the frame loop).
  let projection: ViewProjection = "perspective";
  let projectionBtn: HTMLButtonElement | null = null;
  function setProjection(p: ViewProjection): void {
    projection = p;
    projectionBtn?.classList.toggle("active", p === "orthographic");
  }
  let resetViewBtn: HTMLButtonElement | null = null;
  function refreshOrbitBtn(): void {
    resetViewBtn?.classList.toggle("active", orbited());
  }
  function resetOrbit(): void {
    orbit.yaw = 0;
    orbit.pitch = 0;
    refreshOrbitBtn();
    applyToolCursor();
  }

  // The 3D transform gizmo (see `editor/gizmo.ts`). It lives in the scene, so it
  // is offered exactly when there is a scene to put it in - and it is the only
  // way to author the three fields the plane has no axis for: how far off the
  // plane a form sits, how it is tipped about x and y, and how large a mesh is
  // drawn.
  const gizmo = scene3d ? new EditorGizmo(scene3d.scene, scene3d.camera, canvas) : null;
  // What the handles are attached to right now, so the target is rebuilt when
  // the selection changes and left alone when it has not.
  let gizmoKey = "";
  // The scene is rebuilt from the model whenever the model changes. A full
  // rebuild on every revision is deliberate: the model is small (a level is a
  // couple of hundred shapes), a rebuild is a few milliseconds, and correctness
  // beats cleverness where the alternative is a diff of what an edit touched.
  // It is debounced to a frame rather than run per edit, so a drag rebuilds once
  // per rendered frame instead of once per pointer move.
  let sceneLevel: Scene3DLevel | null = null;
  let sceneRev = -1;
  const camera: Camera = {
    position: Vec2.ZERO,
    zoom: 2,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };

  let cssW = window.innerWidth;
  let cssH = window.innerHeight;
  let dpr = window.devicePixelRatio || 1;
  // Editing, or playing a level inline (▶ Test). Declared here because `resize`
  // below has to know which of the two the camera is framing for; the rest of
  // the test state lives further down, under "mode: edit | test".
  let mode: "edit" | "test" = "edit";
  function resize(): void {
    dpr = window.devicePixelRatio || 1;
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    if (sceneCanvas) {
      sceneCanvas.width = canvas.width;
      sceneCanvas.height = canvas.height;
      scene3d?.resizeTo(canvas.width, canvas.height);
    }
    // Editing spans the whole canvas; a test plays in the game's fixed frame, so
    // a resize mid-test must not hand the camera the window's shape back.
    if (mode !== "test") {
      camera.viewportWidth = cssW;
      camera.viewportHeight = cssH;
    }
  }
  resize();
  window.addEventListener("resize", resize);

  // --- state ----------------------------------------------------------------
  let model: EdModel = emptyModel();
  // Selection is a set: plain click selects one, shift+click toggles a body in
  // or out. Handles and the per-body inspector only apply to a lone selection.
  const selectedIds = new Set<number>();
  // THE BODY selected as an entity, as opposed to a selection of its objects.
  //
  // They are different selections because a body and a scene object are
  // different things: a body has a kind, a transform, a fill, a friction and a
  // force, and NO shape, material or look - those belong to the objects in it.
  // Selecting a body and selecting everything in it would show the union of two
  // vocabularies and let an edit meant for the body land on each of its objects.
  //
  // Exclusive with the item selection, like the chain selection is, and for the
  // same reason: there is no panel that could say anything sensible about both.
  // A SET, because merging is an operation on two bodies and the tree is where
  // two bodies are picked. Shift or Ctrl on an outliner row extends it, exactly
  // as they extend the item selection.
  const selectedBodyIds = new Set<number>();
  // The one body being edited, or null when none or several are. A body panel
  // shows one body's transform, and there is no sane transform for a set.
  const soleBodyId = (): number | null =>
    selectedBodyIds.size === 1 ? [...selectedBodyIds][0]! : null;
  // Chains carry their own selection, and the two are mutually exclusive: a
  // chain has no shape, no placement and no properties in common with an item,
  // so a mixed selection would have nothing an inspector panel could say about
  // it and nothing a nudge or a resize could mean.
  const selectedChainIds = new Set<number>();
  // ...and vines carry theirs, for the same reason and with the same rules: a
  // vine has one anchor, a length and a colour, which is nothing an item panel
  // or a chain panel could speak for.
  const selectedVineIds = new Set<number>();
  // Which of the selected shape's VERTICES an edit acts on, as indices into its
  // vert loop. A second level of selection inside the item one, because a
  // polygon is the item whose parts are separately editable: once the shape is
  // picked, a Delete, a nudge or a drag can just as well mean its corners.
  //
  // Only ever non-empty while exactly one polygon or camera path is selected
  // (`vertexEditTarget`), and cleared by every change of selection and every
  // edit that renumbers the loop - an index means nothing once the shape it
  // indexes is not the one on screen.
  const selectedVerts = new Set<number>();
  let tool: Tool = "select";
  let newKind: BodyKind = "static";
  // Layers. Every *visible* layer is hit-testable, so a selection may span them
  // and the inspector shows one panel per layer it contains. The active layer is
  // what new items are drawn onto, and it breaks the pick: a camera region
  // blankets the geometry it governs, so a click that could mean either takes
  // the active layer's item. Hidden layers are excluded from picking entirely —
  // an item that cannot be seen must not be selectable.
  let activeLayer: EdLayer = "scene";
  const visibleLayers = new Set<EdLayer>(ED_LAYERS);
  // Locked layers still draw — that is the point, they are the reference you are
  // working against — but nothing on them can be picked, drawn or edited. Lock
  // and visibility are independent: one keeps a layer out of the way, the other
  // keeps it on screen and out of harm's way.
  const lockedLayers = new Set<EdLayer>();
  let snapOn = true;
  const gridStep = 0.1; // snap spacing: fixed 10 cm (matches the backdrop minor grid)
  let currentName: string | null = null;
  let dirty = false;
  // Bumped by every model edit, so a save that started before an edit knows not
  // to clear `dirty` on a model that has moved on under it, and so the 3D scene
  // knows to rebuild (see `syncEditorScene`).
  let modelRev = 0;
  let saveError: string | null = null;
  // Where sprung bodies rest, for the canvas's settled ghosts (see
  // `settledGhosts` in model.ts). Cached per model revision because computing
  // it is a full level build - the same cost, and the same cadence, as the 3D
  // scene rebuild.
  let settleGhostRev = -1;
  let settleGhostCache: SettleGhost[] = [];
  function currentSettleGhosts(): readonly SettleGhost[] {
    if (settleGhostRev !== modelRev) {
      settleGhostRev = modelRev;
      settleGhostCache = settledGhosts(model);
    }
    return settleGhostCache;
  }
  let drag: Drag | null = null;
  // Vertices clicked out so far for a polygon in progress, in world metres.
  // Drawing a polygon is a run of clicks rather than one drag, so it needs state
  // that outlives a mouse gesture — unlike every other tool.
  // A run-of-clicks draft, and which tool is drafting it: `+Poly` closes into an
  // outline, `+Path` ends open as a camera path. One draft rather than two so
  // Esc, Enter, the title readout and the preview cannot drift apart per tool.
  let polyDraft: { kind: "poly" | "path"; verts: Vec2[] } | null = null;
  let dragMoved = false;
  let dragPushed = false; // history snapshot taken for the in-progress drag?
  let nudging = false; // arrow-key run in progress? (coalesces into one undo step)

  // --- undo/redo ------------------------------------------------------------
  // Snapshots of the whole model. Shapes, camera framing and note bodies are
  // mutated in place, so clone them; Vec2 is immutable, so its refs are safe to
  // share.
  const HISTORY_MAX = 50; // undo steps retained
  const history: EdModel[] = [];
  const future: EdModel[] = [];
  const snapshot = (m: EdModel): EdModel => ({
    player: { pos: m.player.pos, radius: m.player.radius },
    items: m.items.map((b) => ({
      ...b,
      shape: cloneShape(b.shape),
      cam: { ...b.cam },
      light: { ...b.light },
      note: { ...b.note },
      // The visual is mutated in place by the inspector exactly as `cam`,
      // `light` and `note` are, so an undo snapshot that shared it would alias
      // the state it is meant to be restoring - the known trap on this line.
      visual: { ...b.visual },
    })),
    chains: m.chains.map(cloneChain),
    vines: m.vines.map(cloneVine),
    // A frame is never mutated in place - `translateItems` and friends replace
    // the entry - so copying the map is enough to detach the snapshot.
    bodyFrames: new Map(m.bodyFrames),
    // Mutated in place by the environment panel exactly as `cam` and `light`
    // are, so a snapshot sharing it would alias the state it restores.
    environment: m.environment ? { ...m.environment } : undefined,
  });
  const resetHistory = (): void => {
    history.length = 0;
    future.length = 0;
  };
  // Every body holding more than one object has its frame written down (see
  // `EdModel.bodyFrames`): past one object a body can be edited a piece at a
  // time, and a frame still being read off a member is a frame that member
  // silently moves. Settled here, once per action and before anything is
  // mutated, rather than at each of the half-dozen places a body gains one -
  // membership grows by merging, by drawing into a selected body, by dressing a
  // shape, by pasting, and the next of those cannot forget a rule it is not
  // written into.
  function pinCompoundFrames(): void {
    const held = new Map<number, number>();
    for (const i of model.items) held.set(i.bodyId, (held.get(i.bodyId) ?? 0) + 1);
    for (const [id, n] of held) if (n > 1) pinBodyFrame(model, id);
  }

  // Record the current state before a mutating action, so it can be undone.
  function beginAction(): void {
    nudging = false; // any other action ends the current nudge run
    pinCompoundFrames();
    history.push(snapshot(model));
    if (history.length > HISTORY_MAX) history.shift();
    future.length = 0;
  }
  function undo(): void {
    if (!history.length) return;
    future.push(snapshot(model));
    replaceModel(history.pop()!);
    afterHistoryChange();
  }
  function redo(): void {
    if (!future.length) return;
    history.push(snapshot(model));
    replaceModel(future.pop()!);
    afterHistoryChange();
  }
  function afterHistoryChange(): void {
    drag = null;
    nudging = false;
    // An undone edit may have been the one that placed a corner, so an index
    // carried across it names a different vertex or none at all.
    selectedVerts.clear();
    const live = new Set(model.items.map((b) => b.id));
    for (const id of selectedIds) if (!live.has(id)) selectedIds.delete(id);
    const liveChains = new Set(model.chains.map((c) => c.id));
    for (const id of selectedChainIds) if (!liveChains.has(id)) selectedChainIds.delete(id);
    const liveVines = new Set(model.vines.map((v) => v.id));
    for (const id of selectedVineIds) if (!liveVines.has(id)) selectedVineIds.delete(id);
    // Undoing a merge retires the body it made, so a selection still naming it
    // would leave the panel showing a body with nothing in it.
    const liveBodies = new Set(model.items.map((b) => b.bodyId));
    for (const id of selectedBodyIds) if (!liveBodies.has(id)) selectedBodyIds.delete(id);
    rebuildInspector();
    markDirty(); // an undo/redo is a change like any other - it autosaves too
  }

  // Model order, so a group keeps its z-order through copy/duplicate.
  const selectedBodies = () => model.items.filter((b) => selectedIds.has(b.id));
  // The items a click or a rubber-band may touch: everything on a layer that is
  // both visible and unlocked.
  const pickableItems = () =>
    model.items.filter((b) => visibleLayers.has(b.layer) && !lockedLayers.has(b.layer));
  // The same set in click order, bottom-first (callers walk it backwards to take
  // the topmost hit): draw order — layer, then DEPTH, then model order — with the
  // active layer lifted above the rest, so a camera region drawn over a wall does
  // not swallow the click while geometry is the layer being edited.
  //
  // Depth is what makes a click mean what it looks like it means. Two shapes
  // whose outlines overlap are not ambiguous on screen - one of them is in front
  // - so the pick takes the one nearest the viewport (`itemDepth`, the same rule
  // both renderers draw by) rather than whichever happened to be authored later.
  // A backdrop 20 m behind the level can no longer swallow a click meant for the
  // wall drawn over it.
  // Does this body have a collision object in it? The one fact about a BODY that
  // `itemDepth` needs and an item cannot answer about itself: a geometry object
  // with no authored `offsetZ` is drawn on the gameplay plane if its body
  // collides and at `DECOR_Z` if it does not (see `depthOf`).
  const bodyCollides = (bodyId: number): boolean =>
    model.items.some((o) => o.bodyId === bodyId && o.object === "collision");

  const pickOrder = (): EdItem[] => {
    // What a geometry object's depth means turns on whether its body collides
    // (see `itemDepth`), which is a fact about the model rather than the item.
    const colliding = collidingBodyIds(model.items);
    const depth = (b: EdItem) => itemDepth(b, colliding.has(b.bodyId));
    return pickableItems()
      .map((b, i) => ({ b, i }))
      .sort(
        (p, q) =>
          Number(p.b.layer === activeLayer) - Number(q.b.layer === activeLayer) ||
          ED_LAYERS.indexOf(p.b.layer) - ED_LAYERS.indexOf(q.b.layer) ||
          depth(p.b) - depth(q.b) ||
          // At the same depth a COLLISION object wins, and that tie is now the
          // common case: a body's primitive states the same outline in the same
          // place, so on the canvas the two are one shape. A click means the
          // thing that decides where the player can go; the form drawn over it
          // is one row away in the tree, which a canvas pick has already
          // unfolded and scrolled to.
          Number(p.b.object === "collision") - Number(q.b.object === "collision") ||
          p.i - q.i,
      )
      .map((p) => p.b);
  };
  const selected = () => (selectedIds.size === 1 ? selectedBodies()[0] ?? null : null);
  const selectedChains = () => model.chains.filter((c) => selectedChainIds.has(c.id));
  const selectedVines = () => model.vines.filter((v) => selectedVineIds.has(v.id));
  // The shape whose VERTICES are editable right now: the lone selected item, if
  // it is one of the two vertex-authored kinds and its handles are on screen at
  // all. Everything about the vertex selection - what a band catches, what
  // Delete removes, what an arrow nudges - is asked of this, so there is one
  // statement of when a shape is open for vertex editing rather than a test
  // repeated at each of them.
  function vertexEditTarget(): EdItem | null {
    const s = selected();
    if (!s || (s.shape.kind !== "poly" && s.shape.kind !== "path")) return null;
    if (orbited() || !hasPlaneHandles(s, overlayLayers())) return null;
    return s;
  }
  // The vertices actually selected on that shape, sorted and with anything past
  // its end dropped: an index outlives the loop it indexes only until the next
  // edit, and reading one that has gone is how a stale set writes the wrong
  // vertex.
  function selectedVertIndices(item: EdItem): number[] {
    const n = item.shape.kind === "poly" || item.shape.kind === "path" ? item.shape.verts.length : 0;
    return [...selectedVerts].filter((i) => i < n).sort((a, b) => a - b);
  }
  function setSelection(ids: readonly number[]): void {
    // Every selection this clears has to be in the test, or the early return is
    // the selection surviving a call that meant to replace it: `setSelection([])`
    // with a BODY selected read as "already empty" and left it selected, so a
    // click on empty space deselected an object and did nothing to a body.
    const unchanged =
      ids.length === selectedIds.size &&
      ids.every((id) => selectedIds.has(id)) &&
      selectedChainIds.size === 0 &&
      selectedVineIds.size === 0 &&
      selectedBodyIds.size === 0;
    if (unchanged) return;
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    for (const id of ids) selectedIds.add(id);
    nudging = false;
    // A canvas pick has to be findable in the tree, so the body it landed in
    // opens. Without it, clicking a wall on the canvas leaves the outliner
    // showing a collapsed row that happens to be highlighted, which is the
    // panel failing at the one thing it is for.
    for (const id of ids) {
      const item = model.items.find((i) => i.id === id);
      if (item) revealBody(item.bodyId);
    }
    rebuildInspector();
  }
  // Select a BODY. Its objects are deliberately left unselected: what the
  // inspector then shows is the body's own properties and nothing else.
  function setBodySelection(id: number | null): void {
    if (
      soleBodyId() === id &&
      !selectedIds.size &&
      !selectedChainIds.size &&
      !selectedVineIds.size
    ) {
      return;
    }
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    if (id !== null) selectedBodyIds.add(id);
    nudging = false;
    // Unfold it in the tree and force the rebuild that shows it, so a click on
    // the canvas lands somewhere you can see: the panel jumps to the body and
    // opens it, and `refreshOutliner` scrolls the row into view.
    if (id !== null) revealBody(id);
    rebuildInspector();
  }

  // Add or remove one body from the selection, which is how two are picked to be
  // merged. It drops the item and chain selections for the same reason
  // `setBodySelection` does: there is no panel that could speak for a body and an
  // object at once.
  function toggleBodySelection(id: number): void {
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    if (!selectedBodyIds.delete(id)) selectedBodyIds.add(id);
    nudging = false;
    revealBody(id);
    rebuildInspector();
  }

  // Open a body in the tree and make sure the next refresh actually redraws it.
  // The tree is rebuilt on MODEL revision, and unfolding is not a model change,
  // so it has to say so itself.
  function revealBody(id: number): void {
    if (!expandedBodies.has(id)) {
      expandedBodies.add(id);
      outlinerRev = -1;
    }
  }

  // What Delete, Duplicate and a nudge act on. A selected BODY means all of it -
  // deleting a body deletes the objects in it, and moving one moves them - which
  // is a different question from what the inspector is editing.
  const operandItems = (): EdItem[] =>
    selectedBodyIds.size
      ? [...selectedBodyIds].flatMap((id) => bodyMembers(model.items, id))
      : selectedBodies();

  function setChainSelection(ids: readonly number[]): void {
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    for (const id of ids) selectedChainIds.add(id);
    nudging = false;
    rebuildInspector();
  }
  function setVineSelection(ids: readonly number[]): void {
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    for (const id of ids) selectedVineIds.add(id);
    nudging = false;
    rebuildInspector();
  }
  function toggleSelection(id: number): void {
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    selectedVerts.clear();
    if (!selectedIds.delete(id)) selectedIds.add(id);
    nudging = false;
    rebuildInspector();
  }
  // Is the body this object is in already the thing being edited - either
  // selected as a body, or with one of its objects picked out? That is what
  // decides whether a click selects the BODY or drills into it.
  const insideCurrentBody = (hit: EdItem): boolean =>
    selectedBodyIds.has(hit.bodyId) ||
    model.items.some((i) => i.bodyId === hit.bodyId && selectedIds.has(i.id));

  // The items a click on `hit` selects. A click that has DRILLED IN - Alt, or a
  // second click on the body already being edited - means the single object
  // under the pointer, which is what the per-vertex and per-shape edits need.
  // Anything else means the whole body, since a body IS one object as far as
  // the level is concerned.
  //
  // Group membership beats layer state here, and deliberately: a group that
  // spans layers (a backdrop welded to the body it decorates) is still one
  // object, and picking up half of it would silently re-place the other half
  // against it. Hiding or locking a layer stops its items being TARGETED - it
  // cannot dismantle a body that is already welded.
  const clickTargets = (hit: EdItem, drill: boolean): EdItem[] =>
    drill ? [hit] : pickBodyOf(model.items, hit);
  // Expand a set of item ids so no group is ever half-selected - a rubber band
  // that touches one piece of a body has touched the body.
  function withWholeBodies(ids: Iterable<number>): number[] {
    const out = new Set<number>(ids);
    const bodies = new Set<number>();
    for (const b of model.items) if (out.has(b.id)) bodies.add(b.bodyId);
    for (const b of model.items) if (bodies.has(b.bodyId)) out.add(b.id);
    return [...out];
  }

  const snap = (v: number) => (snapOn ? Math.round(v / gridStep) * gridStep : v);
  const snapVec = (v: Vec2) => new Vec2(snap(v.x), snap(v.y));
  // Snap a shape dimension (width/height/radius) to the grid, never below one cell.
  const snapLen = (v: number) => Math.max(gridStep, snap(v));
  // Snap a would-be centre so the body's top-left corner lands on the grid
  // (moves snap the corner rather than the centre).
  const snapCorner = (b: EdItem, center: Vec2) => {
    const off = halfExtents(b);
    return snapVec(center.sub(off)).add(off);
  };
  const snapAngle = (a: number) => {
    if (!snapOn) return a;
    const step = Math.PI / 12; // 15°
    return Math.round(a / step) * step;
  };
  const ANGLE_STEP = Math.PI / 12; // the gizmo's rotation snap, same 15° as above

  // --- the 3D gizmo's side of the model -------------------------------------
  //
  // Nothing below writes anything the 2D handles do not also write; what it adds
  // is the axes the plane has none: `EdVisual.offsetZ`, `rotX`, `rotY` and a
  // mesh's `scale`. Every one of them was a number typed into the inspector.
  //
  // A handle is offered ONLY where the format has somewhere to put its answer -
  // a collision shape has no rotation about x, a body has no z of its own, a
  // light has no size - so the gizmo shows a level's real degrees of freedom
  // rather than three of everything, two thirds of which would do nothing.

  // The smallest a gizmo drag may make a shape: one on-disk pixel. Zero is a
  // shape that can never be grabbed again, and negative is a shape inside out.
  const MIN_EXTENT = PX;

  // Does this item tip out of the gameplay plane? Only a MESH does. A primitive
  // is its own shape extruded along z, so there is no `rotX`/`rotY` anywhere in
  // the path that draws it, and the rings that wrote those fields were a dial
  // connected to nothing: the gizmo tilted, the inspector's numbers changed, the
  // level went on looking exactly as it did.
  const tips = (i: EdItem): boolean => i.object === "geometry" && i.visual.kind === "mesh";

  // The item's orientation as three sees it: the same composition the renderer
  // builds (`mountVisual` turns the piece about z and the holder about x and y),
  // which is why the decomposition below reads Euler order ZXY and gets exactly
  // `rotX`, `rotY` and `-rot` back.
  //
  // That holder is built for a MESH alone - `mountVisual` returns before it on a
  // primitive - so `rotX`/`rotY` are a prop's fields and nothing else's.
  function itemQuat(i: EdItem): THREE.Quaternion {
    const geo = tips(i);
    return new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        geo ? i.visual.rotX : 0,
        geo ? i.visual.rotY : 0,
        threeRotation(i.rot),
        "ZXY",
      ),
    );
  }

  // A gizmo drag is one undo step and one save, exactly like a 2D drag.
  const gizmoBegin = (): void => beginAction();
  function gizmoTouched(): void {
    markDirty();
    refreshFields();
  }

  // Where an item's handles stand in z: the depth the thing they are attached to
  // is DRAWN at, which is the only place a handle may be.
  //
  // `itemDepth` answers for a geometry object - including the `DECOR_Z` fallback
  // a body that collides with nothing draws at - and answers 0 for a LIGHT,
  // deliberately: it is the pick order's rule, and a light is picked by the burst
  // on the plane rather than by where it hangs in z. Read as a depth, that 0 put
  // the whole gizmo on the gameplay plane while the light was lit at `light.z`,
  // and since a translate drag writes the proxy's z straight onto the field, a
  // light's z was re-based to the drag's own displacement every time - so an
  // arrow dragged twice the same way left it exactly where the first drag had
  // put it, and a press on any other handle set it to zero.
  const handleZ = (it: EdItem): number =>
    it.object === "light" ? it.light.z : itemDepth(it, bodyCollides(it.bodyId));

  // The item the handles are on, resolved by id every time rather than held:
  // undo and redo replace the model wholesale, so a captured object is a stale
  // one the moment a drag is undone.
  function itemHandlers(id: number): GizmoHandlers {
    const find = (): EdItem | null => model.items.find((b) => b.id === id) ?? null;
    // The sizes a scale drag is measured against (see `GizmoHandlers.apply`).
    let base: {
      shape: EdShape;
      depth: number;
      scale: number;
      z: number;
      offsetZ: number;
    } | null = null;
    return {
      pose() {
        const it = find();
        if (!it) return { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
        return {
          // `handleZ` rather than the authored field, because the handles have
          // to sit on the thing they move and that is decided by the BODY: a
          // geometry object with no authored `offsetZ` is drawn on the plane if
          // its body collides and at `DECOR_Z` if it does not. Read as a plain
          // 0, the whole gizmo stood 35 cm in front of every piece of decoration
          // it was attached to - invisible head on, and the first thing you see
          // when the view is turned, which is the view it exists for.
          pos: new THREE.Vector3(it.pos.x, threeY(it.pos.y), handleZ(it)),
          quat: itemQuat(it),
        };
      },
      axes(mode): GizmoAxes {
        const it = find();
        if (!it) return null;
        // Off-plane placement and tipping belong to the things that are DRAWN.
        // A light is placed through z as well - a lamp pulled toward the camera
        // lights a smaller circle of the plane (see `lightPlaneReach`).
        const offPlane = it.object === "geometry" || it.object === "light";
        if (mode === "translate") return { x: true, y: true, z: offPlane };
        if (mode === "rotate") {
          // A shape's rotation in the plane is the only one the level records
          // for it; the two out-of-plane ones exist on a PROP alone, since a
          // primitive is drawn by extruding its own outline along z and nothing
          // in that path reads `rotX`/`rotY` (see `tips`).
          return { x: tips(it), y: tips(it), z: true };
        }
        // Scale. An anchor is a point and a light is a reach authored by its own
        // radius handle, so neither has a size this could write.
        if (it.object === "anchor" || it.object === "light") return null;
        // A mesh has ONE scale, so any axis scales it; a primitive's third axis
        // is its extrusion depth, and a collision shape has no depth at all -
        // `thickness` is what its mass is computed from and is not a size on
        // screen.
        return { x: true, y: true, z: it.object === "geometry" };
      },
      begin() {
        const it = find();
        gizmoBegin();
        if (!it) return;
        base = {
          shape: cloneShape(it.shape),
          // `null` depth means the shape's own thickness, which is what the
          // extrusion falls back to - so that is what a scale starts from.
          depth: it.visual.depth ?? it.thickness,
          scale: it.visual.scale,
          // Where the handles started, and what the file said about it. The two
          // differ for a piece of decoration authoring no `offsetZ`: it is DRAWN
          // at `DECOR_Z` (see `itemDepth`), which is where the handles have to
          // be, and the field is 0. A move is therefore written as a CHANGE
          // against where the handles started rather than as the pose's own z -
          // which would stamp that default into the file the first time a
          // backdrop was nudged sideways, an edit nobody asked for that turns a
          // fallback into an authored number.
          z: handleZ(it),
          offsetZ: it.visual.offsetZ,
        };
      },
      apply(mode, pos, quat, scale) {
        const it = find();
        if (!it) return;
        if (mode === "translate") {
          it.pos = new Vec2(pos.x, threeY(pos.y));
          if (it.object === "geometry" && base) {
            it.visual.offsetZ = base.offsetZ + (pos.z - base.z);
            // A light's field is written outright rather than as a change, and
            // may be: `light.z` is always a concrete number in the model, so
            // `handleZ` starts the proxy exactly there and there is no fallback
            // for a drag to stamp into the file.
          } else if (it.object === "light") it.light.z = pos.z;
        } else if (mode === "rotate") {
          const e = new THREE.Euler().setFromQuaternion(quat, "ZXY");
          it.rot = threeRotation(e.z);
          if (tips(it)) {
            it.visual.rotX = e.x;
            it.visual.rotY = e.y;
          }
        } else if (base) {
          if (it.object === "geometry" && it.visual.kind === "mesh") {
            // One number, so every axis of the handle drives it: the mean of the
            // three factors, which makes the uniform (centre) handle exact and
            // any single axis a sensible approximation of "bigger".
            const f = (scale.x + scale.y + scale.z) / 3;
            it.visual.scale = Math.max(0.01, base.scale * f);
          } else {
            const round = snapOn ? snapLen : undefined;
            scaleShape(it, base.shape, scale.x, scale.y, round);
            if (it.object === "geometry") {
              const depth = base.depth * scale.z;
              it.visual.depth = Math.max(MIN_EXTENT, round ? round(depth) : depth);
            }
          }
        }
        gizmoTouched();
      },
      end() {
        base = null;
        rebuildInspector();
      },
    };
  }

  // A whole body. It has no z, no size and no rotation of its own - what it has
  // is a placement and an arrangement - so the handles offered are a move in the
  // plane and a turn about the centre of mass, which is the point the built body
  // rotates about and exactly what the 2D group handle turns it about.
  function bodyHandlers(id: number): GizmoHandlers {
    const members = (): EdItem[] => bodyMembers(model.items, id);
    let base: {
      centre: Vec2;
      pos: Map<number, Vec2>;
      frame: EdBodyFrame;
      applied: number;
    } | null = null;
    return {
      pose() {
        const c = bodyCentroid(members());
        return {
          pos: new THREE.Vector3(c.x, threeY(c.y), 0),
          quat: new THREE.Quaternion(),
        };
      },
      axes(mode): GizmoAxes {
        if (!members().length) return null;
        if (mode === "translate") return { x: true, y: true, z: false };
        if (mode === "rotate") return { x: false, y: false, z: true };
        return null; // a body has no size: its objects do
      },
      begin() {
        gizmoBegin();
        const items = members();
        base = {
          centre: bodyCentroid(items),
          pos: new Map(items.map((m) => [m.id, m.pos])),
          frame: bodyFrameOf(model, id),
          applied: 0,
        };
      },
      apply(mode, pos, quat) {
        if (!base) return;
        if (mode === "translate") {
          // Measured from where the body was, so a drag cannot accumulate the
          // grid's rounding across its own moves.
          const d = new Vec2(pos.x - base.centre.x, threeY(pos.y) - base.centre.y);
          for (const m of members()) {
            const from = base.pos.get(m.id);
            if (from) m.pos = from.add(d);
          }
          // Written from the base for the same reason the members are: the drag
          // re-applies its whole displacement each frame rather than adding to
          // what it did last, so the frame has to be re-derived, not advanced.
          model.bodyFrames.set(id, { pos: base.frame.pos.add(d), rot: base.frame.rot });
        } else if (mode === "rotate") {
          // The ring returns to zero when the drag ends (`pose` answers the
          // identity), so what it means is a DELTA, exactly as the 2D group
          // handle does - a body has no angle of its own to write.
          const e = new THREE.Euler().setFromQuaternion(quat, "ZXY");
          const wanted = threeRotation(e.z);
          rotateItemsAbout(model, members(), base.centre, wanted - base.applied);
          base.applied = wanted;
        }
        gizmoTouched();
      },
      end() {
        base = null;
        rebuildInspector();
      },
    };
  }

  // What the handles are on: a single object, or a single body. A wider
  // selection keeps the 2D handles alone - there is one transform to show and a
  // group of things has several - and a chain has no transform at all.
  function gizmoSpec(): { kind: "item" | "body"; id: number } | null {
    if (mode === "test" || !scene3d || viewMode === "2d") return null;
    if (selectedChainIds.size || selectedVineIds.size) return null;
    if (selectedBodyIds.size === 1) return { kind: "body", id: [...selectedBodyIds][0]! };
    if (selectedIds.size === 1) return { kind: "item", id: [...selectedIds][0]! };
    return null;
  }

  function syncGizmo(): void {
    if (!gizmo) return;
    const spec = gizmoSpec();
    const key = spec ? `${spec.kind}:${spec.id}` : "";
    if (key !== gizmoKey) {
      gizmoKey = key;
      gizmo.attach(
        spec === null ? null : spec.kind === "body" ? bodyHandlers(spec.id) : itemHandlers(spec.id),
      );
    }
    // The same grid and the same 15° the 2D drags snap to, so a gizmo drag and a
    // handle drag cannot land a body in different places.
    gizmo.setSnap(snapOn ? gridStep : null, snapOn ? ANGLE_STEP : null);
    gizmo.follow();
  }

  // Each matched item's outline as of the last sync, which is how
  // `syncMatchedOutlines` tells which side of a pair an edit touched. Held here
  // rather than on the model because it is edit-session memory, not level
  // content: an undo restores the items and the next sync re-reads them.
  const matchedSigs = new Map<number, string>();

  function markDirty(): void {
    // Before the rev moves: the scene is rebuilt from the model, so a matched
    // partner has to be brought up to date before anything reads it.
    syncMatchedOutlines(model, matchedSigs);
    dirty = true;
    modelRev++;
    scheduleAutosave();
    updateTitle();
  }

  // The one way to replace the model WHOLESALE (New, Load, undo/redo). It exists
  // so that `modelRev` cannot be forgotten: a load is not an edit - it neither
  // dirties the model nor schedules a save, so it does not go through
  // `markDirty` - but it is very much a change the 3D scene has to be rebuilt
  // from, and leaving the rev alone left the scene showing the model that was on
  // screen before the load while the overlay drew the one that had just arrived.
  function replaceModel(next: EdModel): void {
    model = next;
    modelRev++;
  }

  // The edit-mode scene, rebuilt from the model whenever it has changed. It goes
  // through exactly the same builder the game does - `buildLevelBodies` over
  // `toLevelData(model)` - so what an author sees
  // while editing is what the level will look like when it is played, rather
  // than a second interpretation of the same file that can drift from it.
  //
  // The world it builds is a throwaway: nothing steps it, and it exists only to
  // give the bodies the transforms and shapes the visuals hang off.
  // Which item wrote each scene object the current 3D scene was built from. It
  // is what turns a raycast into a selection: a drawn object carries the
  // authored object it was built from (`pickTagOf`), and this says which item
  // that was. Rebuilt with the scene, so it can never name an item the scene on
  // screen was not built from.
  let itemOfSceneObject = new Map<SceneObjectData, number>();
  // ...and the way back, which is what a SELECTION needs: the editor knows the
  // item and has to name the drawn object to paint.
  let sceneObjectOfItem = new Map<number, SceneObjectData>();

  function syncEditorScene(): void {
    if (!scene3d || sceneRev === modelRev) return;
    sceneRev = modelRev;
    const world = new World();
    itemOfSceneObject = new Map();
    const data = toLevelData(model, itemOfSceneObject);
    sceneObjectOfItem = new Map();
    for (const [object, id] of itemOfSceneObject) sceneObjectOfItem.set(id, object);
    const built = buildLevelBodies(world, data, () => {});
    sceneLevel = {
      world,
      // Vines DO reach the 3D scene, where chains do not, and the difference is
      // that a vine's rest pose is exact rather than guessed: straight down
      // from its anchor by its authored length, or the resting catenary of a
      // span, until something moves it - a fact about the level rather than a
      // simulation of one (see `vineRestPath`). It
      // has to be drawn there, too - the overlay is dropped in the 3D-only and
      // orbited views, and a vine is the level rather than chrome.
      vines: model.vines.flatMap((v) => {
        const points = vineRestPath(model, v);
        if (!points) return [];
        return [{ color: v.color, path: (_alpha: number, out: Vec2[]) => {
          out.length = 0;
          out.push(...points);
        } }];
      }),
      // Chains stay on the 2D canvas while editing: the editor draws a chain
      // STRAIGHT on purpose (a span between wrap nodes is straight, and a
      // guessed sag would be a drawing of something the level does not contain),
      // and solving them here to draw them would be a second simulation running
      // under the editor.
      sceneChains: [],
      visualSource: { data, built },
    };
    scene3d.setLevel(sceneLevel);
    highlightKey = null; // a fresh scene holds none of the last one's paint
  }

  // WHAT IS SELECTED, SAID IN THE SCENE. A geometry object has no outline on the
  // overlay any more (see `drawEditor`'s outline mode) precisely because the
  // outline described a rectangle rather than the thing drawn, and the same
  // argument says where the selection has to be shown: on the model.
  //
  // The colours are the overlay's own, so the two views say the same thing -
  // orange is "an edit applies to this", blue is "this is what the selected body
  // is made of". Only geometry objects carry a pick tag, so naming a collision
  // object or a light here is simply nothing to paint.
  let highlightKey: string | null = null;
  function syncHighlight(): void {
    if (!scene3d) return;
    const key = `${sceneRev}|${[...selectedIds].join(",")}|${[...selectedBodyIds].join(",")}`;
    if (key === highlightKey) return;
    highlightKey = key;
    const tags = new Map<unknown, string>();
    const paint = (id: number, color: string): void => {
      const object = sceneObjectOfItem.get(id);
      if (object) tags.set(object, color);
    };
    for (const item of model.items) {
      if (selectedBodyIds.has(item.bodyId)) paint(item.id, BODY_MEMBER);
    }
    // Second, so an object picked out of a selected body reads as the selection
    // rather than as one more of its siblings.
    for (const id of selectedIds) paint(id, SELECT);
    scene3d.setHighlight(tags);
  }

  // --- mode: edit | test ----------------------------------------------------
  // (`mode` itself is declared above `resize`, which reads it.)
  let testLevel: Level | BallLevel | null = null;
  // The same object, typed as what the 3D renderer wants of it. Held separately
  // so the render path does not have to re-narrow a union it has already
  // narrowed for the 2D one.
  let testLevel3d: Scene3DLevel | null = null;
  // The hook's sparks while a test runs (see render/sparks.ts). One system for
  // the editor's life, cleared at every ▶ Test, so a test never opens carrying
  // the embers of the last one.
  const testSparks = new SparkSystem();
  let liveInput: LiveInputSource | null = null;
  let ballInput: BallInputSource | null = null;
  let savedCam: { pos: Vec2; zoom: number } | null = null;
  // The test run's camera (eased follow + camera regions). Separate from the
  // editor's own camera handling, which is a direct pan/zoom.
  const testCameraCtl = new CameraController();
  // See the `edge clamp` toggle: an authoring instrument for ▶ Test, not a
  // level property, so it is remembered here and saved nowhere.
  let edgeClampOn = true;

  // Full-session recording of the current test run — press P to download a
  // self-contained replay bundle (embeds the tested geometry, since an
  // in-editor level isn't in the registry). Mirrors main.ts's P export.
  let testController: "grapple" | "ball" = "grapple";
  // The game's debug overlay (L) inside ▶ Test. Off at the start of every test:
  // it is an instrument, and a test opens as the picture the player gets.
  let testShowDebug = false;
  let testData: LevelData | null = null;
  const recFrames: SerializedFrame[] = [];
  const recDigests: Digest[] = [];

  // `spawn` (world metres) overrides the level's own spawn marker for this run
  // only — the model is untouched, so a spot-check from the cursor never edits
  // the level. It is baked into the data the test level is built from, so a
  // reset (and the exported bundle) respawns at the same place.
  function startTest(controller: "grapple" | "ball", spawn?: Vec2): void {
    if (mode === "test") stopTest();
    const pixelData = modelToDisk(model);
    if (spawn) {
      pixelData.player = { ...pixelData.player, x: spawn.x * M2PX, y: spawn.y * M2PX };
    }
    testShowDebug = false;
    savedCam = { pos: camera.position, zoom: camera.zoom };
    // The test is played in the game's fixed 16:9 frame, so the camera is given
    // the frame's dimensions rather than the editor window's: `viewportScale`,
    // the follow point and every pointer un-projection are in view pixels while
    // a test runs, exactly as they are in the game.
    camera.viewportWidth = VIEW_WIDTH;
    camera.viewportHeight = VIEW_HEIGHT;
    testController = controller;
    testData = pixelData;
    recFrames.length = 0;
    recDigests.length = 0;
    // The camera controller owns the zoom from here (base framing × the active
    // region's viewportScale), and re-derives it every frame, so a resize
    // mid-test needs no separate handling.
    testCameraCtl.edgeClamp = edgeClampOn;
    testCameraCtl.snap();
    if (controller === "ball") {
      testLevel = new BallLevel(pixelData);
      ballInput ??= new BallInputSource(canvas, camera, () =>
        testLevel instanceof BallLevel ? testLevel.ball.globalPosition : Vec2.ZERO,
      );
    } else {
      testLevel = new Level(pixelData);
      liveInput ??= new LiveInputSource(canvas, camera, () =>
        testLevel instanceof Level ? testLevel.player.globalPosition : Vec2.ZERO,
      );
    }
    testLevel.onReset = () => startTest(controller, spawn);
    // A test uses the real game render path, so the 3D scene comes with it: the
    // level IS a `Scene3DLevel`, since both drivers carry the `visualSource` the
    // renderer reads. A grapple test keeps its avatar and rope on the 2D canvas
    // (the Player slice is 2D-only), which is what `overlayOnly` leaves there.
    testLevel3d = testLevel;
    if (scene3d && viewMode !== "2d") scene3d.setLevel(testLevel);
    accumulator = 0;
    lastNow = -1;
    testSparks.reset();
    mode = "test";
    root.style.display = "none";
    testBanner.style.display = "block";
    // The ball controller draws its own aim reticle, so the OS cursor would be
    // a second pointer — hide it there (the grapple aims with the cursor).
    canvas.style.cursor = controller === "ball" ? "none" : "crosshair";
  }

  function downloadTestRecording(): void {
    if (!testData || recFrames.length === 0) return;
    const rec: Recording = {
      level: currentName ?? "editor",
      git: __GIT_COMMIT__,
      controller: testController,
      data: testData,
      frames: recFrames.slice(),
      digests: recDigests.slice(),
    };
    const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${recFrames.length}f.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function stopTest(): void {
    mode = "edit";
    testLevel = null;
    testLevel3d = null;
    // The edit-mode scene was replaced by the test level's, so it is rebuilt on
    // the next frame rather than left showing the level that just stopped.
    sceneRev = -1;
    // Back to editing the whole canvas (see startTest).
    camera.viewportWidth = cssW;
    camera.viewportHeight = cssH;
    if (savedCam) {
      camera.position = savedCam.pos;
      camera.zoom = savedCam.zoom;
    }
    root.style.display = "";
    testBanner.style.display = "none";
    canvas.style.cursor = "default";
  }

  // --- DOM ------------------------------------------------------------------
  injectStyles();
  const root = document.createElement("div");
  root.className = "ed-root";
  document.body.appendChild(root);

  const testBanner = document.createElement("div");
  testBanner.className = "ed-test-banner";
  testBanner.textContent = "TESTING — Esc to return to the editor";
  testBanner.style.display = "none";
  document.body.appendChild(testBanner);

  // Toolbar.
  const bar = el("div", "ed-bar");
  root.appendChild(bar);

  const fileRow = el("div", "ed-row");
  bar.appendChild(fileRow);
  const btnNew = button("New", () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    cancelAutosave();
    replaceModel(emptyModel());
    resetHistory();
    selectedIds.clear();
    selectedVerts.clear();
    selectedBodyIds.clear();
    currentName = null;
    dirty = false;
    camera.position = Vec2.ZERO;
    rebuildInspector();
    updateTitle();
  });
  const loadSel = document.createElement("select");
  loadSel.className = "ed-select";
  loadSel.title = "Load level from disk";
  loadSel.addEventListener("change", async () => {
    const name = loadSel.value;
    if (!name) return;
    if (dirty && !confirm("Discard unsaved changes?")) {
      loadSel.value = "";
      return;
    }
    await doLoad(name);
    loadSel.value = "";
  });
  const btnSave = button("Save", () => doSave(false));
  const btnSaveAs = button("Save As", () => doSave(true));
  const btnDelete = button("Delete File", async () => {
    if (!currentName) return;
    if (!confirm(`Delete level "${currentName}" from disk?`)) return;
    cancelAutosave(); // a queued write would recreate the file
    await deleteLevel(currentName);
    currentName = null;
    dirty = true;
    await refreshLevelList();
    updateTitle();
  });
  fileRow.append(btnNew, loadSel, btnSave, btnSaveAs, btnDelete);

  const toolRow = el("div", "ed-row");
  bar.appendChild(toolRow);
  const toolBtns: Record<Tool, HTMLButtonElement> = {
    select: button("Select", () => setTool("select")),
    rect: button("+ Rect", () => setTool("rect")),
    circle: button("+ Circle", () => setTool("circle")),
    poly: button("+ Poly", () => setTool("poly")),
    path: button("+ Path", () => setTool("path")),
    geometry: button("+ Geometry", () => setTool("geometry")),
    text: button("+ Text", () => setTool("text")),
    arrow: button("+ Arrow", () => setTool("arrow")),
    chain: button("+ Chain", () => setTool("chain")),
    vine: button("+ Vine", () => setTool("vine")),
    light: button("+ Light", () => setTool("light")),
  };
  toolBtns.geometry.title =
    "Click to drop a geometry object; drag to size it. It is DRAWN and never simulated - nothing collides with it, the rope does not wrap it, no force reaches it. Give it a mesh or a texture on the panel; drop it on a selected body to have it ride that body.";
  toolBtns.path.title =
    "Click out a camera path: the route the camera rides, in the direction it is drawn. Enter or double-click finishes it, Esc drops it. The camera targets a point `lookahead` further along than the player, and lets go if they stray more than `range` from it.";
  toolBtns.chain.title = "Drag from one body to another to string a chain between them";
  toolBtns.vine.title =
    "Press on a body and drag DOWN to hang a vine from it - or drag out at an ANGLE to grow a springy branch (stiff, lightly damped, held out along the drag). Shift-drag its end handle onto another body to span between the two. The player passes through either and the hook grabs anywhere along the length.";
  toolBtns.light.title = "Click to drop a light; drag to set how far it reaches";
  const kindSel = document.createElement("select");
  kindSel.className = "ed-select";
  for (const k of BODY_KINDS) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    kindSel.appendChild(o);
  }
  kindSel.value = newKind;
  kindSel.title = "Kind for new bodies (and every selected body)";
  kindSel.addEventListener("change", () => {
    newKind = kindSel.value as BodyKind;
    const sel = selectedBodies();
    if (sel.length) {
      beginAction();
      for (const b of sel) b.kind = newKind;
      markDirty();
      rebuildInspector();
    }
  });
  const kindWrap = labelWrap("kind", kindSel);
  toolBtns.poly.title =
    "Click out an outline, concave corners included; Enter or the first vertex closes it, Esc cancels";
  toolRow.append(
    toolBtns.select,
    toolBtns.rect,
    toolBtns.circle,
    toolBtns.poly,
    toolBtns.path,
    toolBtns.geometry,
    toolBtns.text,
    toolBtns.arrow,
    toolBtns.chain,
    toolBtns.vine,
    toolBtns.light,
    kindWrap,
  );

  // Layer list: which layer is being edited (Tab cycles), plus a visibility
  // toggle each. Visibility is independent of active — a hidden active layer
  // would be an invisible edit target, so hiding one also moves the edit focus.
  // It stacks vertically, with the visibility boxes in a column down the left:
  // a layer stack is a fixed, ordered set you read down, not a row of toolbar
  // buttons, and one row per layer leaves room for a name of any length.
  const layerList = el("div", "ed-layers");
  bar.appendChild(layerList);
  const layerHeading = el("div", "ed-layer-label");
  layerHeading.textContent = "layer";
  layerList.appendChild(layerHeading);
  const layerBtns = {} as Record<EdLayer, HTMLButtonElement>;
  const layerEyes = {} as Record<EdLayer, HTMLButtonElement>;
  const layerLocks = {} as Record<EdLayer, HTMLButtonElement>;
  for (const l of ED_LAYERS) {
    const row = el("div", "ed-layer-row");
    const eye = document.createElement("button");
    eye.className = "ed-eye";
    eye.addEventListener("click", () => setLayerVisible(l, !visibleLayers.has(l)));
    layerEyes[l] = eye;
    const lock = document.createElement("button");
    lock.className = "ed-eye ed-lock";
    lock.addEventListener("click", () => setLayerLocked(l, !lockedLayers.has(l)));
    layerLocks[l] = lock;
    const b = button(l, () => setLayer(l));
    b.classList.add("ed-layer-btn");
    b.title = `Edit the ${l} layer (Tab cycles)`;
    layerBtns[l] = b;
    row.append(eye, lock, b);
    layerList.appendChild(row);
    setLayerVisible(l, true); // paints the icon and its tooltip
    setLayerLocked(l, false); // ditto
  }

  // Show or hide a layer. Hiding everything would leave a blank canvas nothing
  // can be clicked on, so the last visible layer refuses to go; hiding the one
  // being edited moves the edit focus rather than leaving an invisible target.
  function setLayerVisible(l: EdLayer, visible: boolean): void {
    if (!visible && visibleLayers.size === 1) return;
    if (visible) visibleLayers.add(l);
    else visibleLayers.delete(l);
    const eye = layerEyes[l];
    eye.innerHTML = eyeIcon(visible);
    eye.classList.toggle("off", !visible);
    eye.title = `${visible ? "Hide" : "Show"} the ${l} layer`;
    eye.setAttribute("aria-pressed", String(visible));
    if (!visible) {
      // Nothing hidden stays selected: it can no longer be seen or clicked, but
      // a nudge, an inspector edit or a Delete would still reach it.
      let dropped = false;
      for (const b of model.items) {
        if (b.layer === l && selectedIds.delete(b.id)) dropped = true;
      }
      if (dropped) rebuildInspector();
    }
    if (!visible && activeLayer === l) {
      setLayer(ED_LAYERS.find((o) => visibleLayers.has(o))!);
    }
  }

  // Lock or unlock a layer. A locked layer keeps drawing and keeps its place in
  // the stack; what it loses is every edit path — picking, drawing into it, and
  // any selection it was part of, since a selected item on it would still be
  // reached by a nudge, an inspector field or a Delete.
  function setLayerLocked(l: EdLayer, locked: boolean): void {
    if (locked) lockedLayers.add(l);
    else lockedLayers.delete(l);
    const lock = layerLocks[l];
    lock.innerHTML = lockIcon(locked);
    lock.classList.toggle("on", locked);
    lock.title = `${locked ? "Unlock" : "Lock"} the ${l} layer`;
    lock.setAttribute("aria-pressed", String(locked));
    if (locked) {
      let dropped = false;
      for (const b of model.items) {
        if (b.layer === l && selectedIds.delete(b.id)) dropped = true;
      }
      if (dropped) rebuildInspector();
    }
    // The toolbar has to stop offering what the layer no longer accepts.
    if (l === activeLayer) refreshToolButtons();
  }

  // Which draw tools the toolbar offers: the active layer's own set, and none at
  // all while it is locked. An armed tool the new state cannot draw falls back to
  // Select rather than lingering as a lit dead button.
  function refreshToolButtons(): void {
    const tools: Tool[] = lockedLayers.has(activeLayer) ? ["select"] : LAYER_TOOLS[activeLayer];
    for (const [k, b] of Object.entries(toolBtns)) {
      b.style.display = tools.includes(k as Tool) ? "" : "none";
    }
    if (!tools.includes(tool)) setTool("select");
  }

  function setLayer(l: EdLayer): void {
    if (!visibleLayers.has(l)) setLayerVisible(l, true);
    activeLayer = l;
    // The selection survives: every visible layer is pickable, so items on the
    // outgoing layer are still selectable and still shown by the inspector.
    for (const [k, b] of Object.entries(layerBtns)) b.classList.toggle("active", k === l);
    // `kind` is a geometry property; a camera region and a note have none.
    kindWrap.style.display = l === "scene" ? "" : "none";
    refreshToolButtons();
    rebuildInspector();
  }

  const testRow = el("div", "ed-row");
  bar.appendChild(testRow);
  const btnTestBall = button("▶ Test Ball", () => startTest("ball"));
  btnTestBall.title = "Test from the level's spawn (B tests from the cursor)";
  testRow.append(button("▶ Test Grapple", () => startTest("grapple")), btnTestBall);
  const snapChk = checkbox("snap 10cm", snapOn, (v) => (snapOn = v));
  testRow.append(snapChk);
  // The screen-edge guarantee, off-switchable for a test and NOWHERE else. The
  // game never turns it off - it is the one camera rule a level may not opt out
  // of - but an author tuning a lock or a lookahead needs to see the framing it
  // is actually asking for, and that question is unanswerable while the answer
  // is being silently corrected. Editor state, never written to a file.
  const edgeChk = checkbox("edge clamp", edgeClampOn, (v) => {
    edgeClampOn = v;
    testCameraCtl.edgeClamp = v;
  });
  edgeChk.title =
    "Keep the avatar out of the outer 8% of the frame during ▶ Test. On in the game always; untick to see the raw framing a camera rule is asking for (the overlay draws the clamp in amber on the frames it is holding).";
  testRow.append(edgeChk);

  // View toggle. Only offered when there is a WebGL context to toggle: a machine
  // that cannot draw the scene should not be shown two dead buttons.
  const viewBtns: Partial<Record<ViewMode, HTMLButtonElement>> = {};
  if (scene3d) {
    const viewRow = el("div", "ed-row");
    bar.appendChild(viewRow);
    const setViewMode = (m: ViewMode): void => {
      viewMode = m;
      for (const [k, b] of Object.entries(viewBtns)) b.classList.toggle("active", k === m);
      // The 3D canvas keeps its last frame otherwise, showing a stale scene
      // under a 2D view that is meant to be the editor exactly as it was.
      if (sceneCanvas) sceneCanvas.style.display = m === "2d" ? "none" : "";
      // A turned view is only a turned view while a scene is drawn: the 2D mode
      // is the plane itself and edits normally, orbit or no orbit.
      refreshOrbitBtn();
      applyToolCursor();
    };
    viewBtns["2d"] = button("2D", () => setViewMode("2d"));
    viewBtns["3d"] = button("3D", () => setViewMode("3d"));
    viewBtns.overlay = button("3D + overlay", () => setViewMode("overlay"));
    // Back to the view the level is authored against. A turned view draws no
    // overlay and offers none of its handles (see `orbit`), so this is the only
    // way back to those, and it lights up while the view is turned so it reads
    // as the way back rather than as a button that usually does nothing.
    resetViewBtn = button("⟲ Reset view", resetOrbit);
    resetViewBtn.title = "Face the gameplay plane again (Ctrl + middle-drag orbits)";
    // The lens. One toggle rather than two buttons, because unlike the view
    // modes these are not three jobs: it is one view, drawn with the perspective
    // divide or without it, and what the button says is which.
    projectionBtn = button("⧉ Ortho", () =>
      setProjection(projection === "orthographic" ? "perspective" : "orthographic"),
    );
    projectionBtn.title =
      "Orthographic view: no perspective, so geometry at any depth is drawn at the plane's scale and lines up exactly (O)";
    viewRow.append(
      viewBtns["2d"]!,
      viewBtns["3d"]!,
      viewBtns.overlay!,
      resetViewBtn,
      projectionBtn,
    );
    setViewMode(viewMode);
    refreshOrbitBtn();
    setProjection(projection);
  }

  const title = el("div", "ed-title");
  bar.appendChild(title);

  // Inspector.
  const inspector = el("div", "ed-inspector");
  root.appendChild(inspector);

  // --- outliner -------------------------------------------------------------
  // The level as it actually IS: a list of bodies, each expandable into the
  // scene objects that make it up.
  //
  // It exists because a body is the unit the format is written in and the canvas
  // cannot show one. On the canvas a body is a diamond and a dashed hull around
  // shapes that look like separate things; the objects that have no outline at
  // all - a light, a mesh dressing on a wall - are either a faint ring or
  // nothing. So "which body is this in, and what else is in it" was a question
  // you answered by clicking things and watching what else lit up.
  //
  // Camera regions and notes are deliberately NOT here. Neither is a body:
  // neither is drawn in play, neither builds anything, and listing them would
  // make the panel a second copy of the layer list rather than a view of the
  // level's structure.
  const outliner = el("div", "ed-outliner");
  root.appendChild(outliner);
  const outlinerHead = el("div", "ed-outliner-head");
  const outlinerTitle = el("span", "ed-outliner-title");
  const outlinerBody = el("div", "ed-outliner-list");
  let outlinerOpen = true;
  const outlinerToggle = button("▾", () => {
    outlinerOpen = !outlinerOpen;
    outlinerToggle.textContent = outlinerOpen ? "▾" : "▸";
    outlinerBody.style.display = outlinerOpen ? "" : "none";
  });
  outlinerToggle.classList.add("ed-twist");
  outlinerHead.append(outlinerToggle, outlinerTitle);
  outliner.append(outlinerHead, outlinerBody);

  // Which bodies are expanded, kept across rebuilds so a drag does not collapse
  // the tree under the pointer. Keyed by body id rather than by row index, since
  // the row index moves whenever anything is added.
  const expandedBodies = new Set<number>();
  // What the tree was last built from. The list is a few hundred rows on a real
  // level, so it is rebuilt when the MODEL changes and only re-highlighted when
  // the selection does.
  let outlinerRev = -1;

  // What the tree was last highlighted for, so a selection made on the CANVAS
  // can be scrolled to without the scroll fighting the user every frame: a real
  // level is a couple of hundred bodies, and highlighting a row a hundred rows
  // off-screen is the same as not highlighting it.
  let outlinerSelKey = "";

  function refreshOutliner(): void {
    if (outlinerRev !== modelRev) {
      outlinerRev = modelRev;
      buildOutliner();
    }
    let first: HTMLElement | null = null;
    for (const [row, ids] of outlinerRows) {
      const on = ids.length > 0 && ids.some((id) => selectedIds.has(id));
      row.classList.toggle("sel", on);
      if (on && !first) first = row;
    }
    for (const [row, id] of bodyRows) {
      const on = selectedBodyIds.has(id);
      row.classList.toggle("sel", on);
      if (on && !first) first = row;
    }
    for (const [row, id] of chainRows) {
      const on = selectedChainIds.has(id);
      row.classList.toggle("sel", on);
      if (on && !first) first = row;
    }
    for (const [row, id] of vineRows) {
      const on = selectedVineIds.has(id);
      row.classList.toggle("sel", on);
      if (on && !first) first = row;
    }
    const bodyKey = [...selectedBodyIds].sort((a, b) => a - b).join(",");
    const chainKey = [...selectedChainIds].sort((a, b) => a - b).join(",");
    const vineKey = [...selectedVineIds].sort((a, b) => a - b).join(",");
    const key = `${bodyKey}|${chainKey}|${vineKey}|${[...selectedIds].sort((a, b) => a - b).join(",")}`;
    if (key === outlinerSelKey) return;
    outlinerSelKey = key;
    first?.scrollIntoView({ block: "nearest" });
  }

  // Every row, with the item ids it stands for - one for an object row, all of
  // the body's for a body row.
  const outlinerRows: Array<[HTMLElement, number[]]> = [];
  // Body rows are highlighted by the BODY selection rather than by the item one,
  // since the two are different selections. Chain rows are a third, for the same
  // reason: a chain has its own selection because it has nothing an item panel
  // could say about it.
  const bodyRows: Array<[HTMLElement, number]> = [];
  const chainRows: Array<[HTMLElement, number]> = [];
  const vineRows: Array<[HTMLElement, number]> = [];

  function buildOutliner(): void {
    outlinerRows.length = 0;
    bodyRows.length = 0;
    chainRows.length = 0;
    vineRows.length = 0;
    outlinerBody.innerHTML = "";
    const runs = bodyRuns(model.items.filter((i) => i.layer === "scene"));
    outlinerTitle.textContent = `Bodies (${runs.length})`;
    runs.forEach((members: EdItem[], index: number) => {
      const id = members[0]!.bodyId;
      const open = expandedBodies.has(id);
      const row = el("div", "ed-out-row body");
      // EVERY body expands, including one holding a single object. A body and a
      // scene object are two different things - one is a container with a
      // transform, a kind and a fill, the other is a shape or a light inside it -
      // and a row that collapsed the two whenever a body happened to hold one
      // object would teach exactly the confusion this refactor removed. It also
      // makes the count of rows stop matching the count of bodies as objects are
      // added and removed, which is the thing the panel is read for.
      const twist = el("span", "ed-out-twist live");
      twist.textContent = open ? "▾" : "▸";
      twist.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (open) expandedBodies.delete(id);
        else expandedBodies.add(id);
        buildOutliner();
        refreshOutliner();
      });
      const label = el("span", "ed-out-label");
      label.textContent = `${index}  ${bodyLabel(members)}`;
      const count = el("span", "ed-out-count");
      count.textContent = `${members.length}`;
      row.append(twist, label, count);
      // Selecting a body selects THE BODY - not the objects in it. That is the
      // whole point of the row existing: a body has properties of its own, and
      // they are what the inspector should offer when you click one.
      //
      // Shift or Ctrl extends, which is how two bodies are picked to be merged.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey || e.ctrlKey || e.metaKey) toggleBodySelection(id);
        else setBodySelection(id);
      });
      outlinerBody.appendChild(row);
      outlinerRows.push([row, []]);
      bodyRows.push([row, id]);
      if (!open) return;
      for (const m of members) {
        const objRow = el(
          "div",
          `ed-out-row obj ${
            m.object === "light"
              ? "light"
              : m.object === "anchor"
                ? "anchor"
                : m.object === "collision"
                  ? "solid"
                  : "decor"
          }`,
        );
        const objLabel = el("span", "ed-out-label");
        objLabel.textContent = objectLabel(m, M2PX);
        objRow.append(el("span", "ed-out-twist"), objLabel);
        // ...and selecting ONE object selects only it, which is what Alt+click
        // reaches for on the canvas. That is the whole point of the panel: the
        // objects with no outline are not clickable there at all.
        objRow.addEventListener("mousedown", (e) => pickRow(e, [m.id]));
        outlinerBody.appendChild(objRow);
        outlinerRows.push([objRow, [m.id]]);
      }
    });

    // CHAINS, after the bodies and not inside any of them - which is exactly what
    // a chain is. Its two anchors are objects and appear under their own bodies
    // above; the chain itself belonged to neither, so before this it was the one
    // thing in a level with no row at all and could only be found by clicking the
    // rope on the canvas.
    const indexOfBodyRun = new Map<number, number>();
    runs.forEach((members, i) => indexOfBodyRun.set(members[0]!.bodyId, i));
    if (model.chains.length) buildChainRows(runs);
    if (model.vines.length) buildVineRows(indexOfBodyRun);
  }

  // CHAINS, after the bodies and not inside any of them - which is exactly what
  // a chain is. Its two anchors are objects and appear under their own bodies
  // above; the chain itself belonged to neither, so before this it was the one
  // thing in a level with no row at all and could only be found by clicking the
  // rope on the canvas.
  function buildChainRows(runs: EdItem[][]): void {
    const head = el("div", "ed-out-row head");
    head.append(el("span", "ed-out-twist"), el("span", "ed-out-label"));
    head.lastElementChild!.textContent = `Chains (${model.chains.length})`;
    outlinerBody.appendChild(head);
    // Named by the two BODIES they hold, which is what a chain is read as - "the
    // one between the winch and the gate" - rather than by ids nothing else
    // shows. The index is the body's outliner number, so the name says where to
    // look.
    const indexOfBody = new Map<number, number>();
    runs.forEach((members, i) => indexOfBody.set(members[0]!.bodyId, i));
    const endLabel = (end: number): string => {
      const anchor = anchorItem(model, end);
      if (!anchor) return "?";
      const i = indexOfBody.get(anchor.bodyId);
      return i === undefined ? "?" : `${i}`;
    };
    for (const c of model.chains) {
      const row = el("div", "ed-out-row obj chain");
      const label = el("span", "ed-out-label");
      label.textContent = `${endLabel(c.a)} ↔ ${endLabel(c.b)}`;
      row.append(el("span", "ed-out-twist"), label);
      if (c.length !== null) {
        const len = el("span", "ed-out-count");
        len.textContent = `${Math.round(c.length * M2PX)}`;
        row.appendChild(len);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setChainSelection([c.id]);
      });
      outlinerBody.appendChild(row);
      chainRows.push([row, c.id]);
    }
  }

  // ...and VINES, after them, for the same reason: a vine's one anchor is an
  // object under its own body, and the vine itself belongs to no body at all.
  // Named by the body it hangs from and how long it is, which is the whole of
  // what a vine is.
  function buildVineRows(indexOfBody: Map<number, number>): void {
    const head = el("div", "ed-out-row head");
    head.append(el("span", "ed-out-twist"), el("span", "ed-out-label"));
    head.lastElementChild!.textContent = `Vines (${model.vines.length})`;
    outlinerBody.appendChild(head);
    for (const v of model.vines) {
      const row = el("div", "ed-out-row obj chain");
      const anchor = model.items.find((i) => i.id === v.anchor);
      const at = anchor ? indexOfBody.get(anchor.bodyId) : undefined;
      const label = el("span", "ed-out-label");
      label.textContent = `from ${at === undefined ? "?" : at}`;
      row.append(el("span", "ed-out-twist"), label);
      const len = el("span", "ed-out-count");
      len.textContent = `${Math.round(v.length * M2PX)}`;
      row.append(len);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setVineSelection([v.id]);
      });
      outlinerBody.appendChild(row);
      vineRows.push([row, v.id]);
    }
  }

  // A row click, with the same Shift-to-extend rule the canvas has. It
  // suppresses the default so the click cannot move focus off the canvas and
  // swallow the keyboard shortcuts.
  function pickRow(e: MouseEvent, ids: number[]): void {
    e.preventDefault();
    e.stopPropagation();
    const layer = model.items.find((i) => i.id === ids[0])?.layer;
    // Picking on a hidden or locked layer would select something that cannot be
    // seen or edited, so the row reveals it first - the same courtesy a paste
    // does when it lands on a hidden layer.
    if (layer && (!visibleLayers.has(layer) || lockedLayers.has(layer))) {
      setLayerVisible(layer, true);
      setLayerLocked(layer, false);
    }
    if (e.shiftKey) {
      const next = new Set(selectedIds);
      const on = ids.every((id) => next.has(id));
      for (const id of ids) (on ? next.delete(id) : next.add(id));
      setSelection([...next]);
    } else {
      setSelection(ids);
    }
  }

  function updateTitle(): void {
    // A named level autosaves, so `*` is a brief in-flight marker rather than a
    // standing warning; an unnamed one keeps it until the first Save names it.
    const state = saveError ? " · SAVE FAILED" : dirty ? " *" : "";
    const count = (l: EdLayer) => model.items.filter((i) => i.layer === l).length;
    // Only the layers that have anything on them are named, so the title stays
    // short on a level that only uses geometry.
    // Bodies rather than items: a body is the unit the level is written in, and
    // the outliner counts the same thing the same way.
    const bodies = new Set(
      model.items.filter((i) => i.layer === "scene").map((i) => i.bodyId),
    ).size;
    const lights = model.items.filter((i) => i.object === "light").length;
    const extra =
      ([
        ["camera", "cam"],
        ["notes", "notes"],
      ] as const)
        .map(([l, name]) => (count(l) ? ` · ${count(l)} ${name}` : ""))
        .join("") +
      // Lights are counted as OBJECTS now rather than as a layer, which is what
      // they are: a light lives in a body beside the shapes it lights.
      (lights ? ` · ${lights} light${lights === 1 ? "" : "s"}` : "") +
      (bodies > 1 ? ` · ${bodies} bodies` : "") +
      (model.chains.length
        ? ` · ${model.chains.length} chain${model.chains.length === 1 ? "" : "s"}`
        : "") +
      (model.vines.length
        ? ` · ${model.vines.length} vine${model.vines.length === 1 ? "" : "s"}`
        : "");
    const draft = polyDraft
      ? ` · ${polyDraft.kind === "path" ? "path" : "polygon"}: ${polyDraft.verts.length} ` +
        `${polyDraft.verts.length === 1 ? "vertex" : "vertices"}` +
        (polyDraft.verts.length >= (polyDraft.kind === "path" ? 2 : 3)
          ? polyDraft.kind === "path"
            ? " · Enter to finish"
            : " · Enter to close"
          : "")
      : "";
    title.textContent = `${currentName ?? "(unsaved)"}${state} · ${count("scene")} objects${extra}${draft}`;
  }
  // The cursor a drag borrows and must hand back (pan swaps in a grab hand).
  function applyToolCursor(): void {
    // A turned view selects and moves but draws nothing (see the press handler),
    // so the pointer is the select one whatever the toolbar has armed rather
    // than a crosshair over a canvas that will not draw.
    canvas.style.cursor = orbited() || tool === "select" ? "default" : "crosshair";
  }
  function setTool(t: Tool): void {
    if (!LAYER_TOOLS[activeLayer].includes(t)) return;
    // A locked layer accepts no new geometry either, so its draw tools cannot be
    // armed by the keyboard shortcuts any more than by the (hidden) buttons.
    if (t !== "select" && lockedLayers.has(activeLayer)) return;
    if (t !== "poly" && t !== "path") cancelPolyDraft();
    tool = t;
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle("active", k === t);
    applyToolCursor();
  }
  setTool("select");

  // --- inspector build ------------------------------------------------------
  // `get` returns null when the selected bodies disagree — a mixed field shows
  // blank and only writes once something is typed into it.
  const fields: Array<{
    input: HTMLInputElement;
    get: () => number | null;
    set: (v: number) => void;
  }> = [];
  // Read-only panel values (a polygon's vertex count). They refresh with the
  // number fields rather than only on a panel rebuild: a canvas drag can change
  // one — inserting or removing a vertex — and the panel is deliberately not
  // rebuilt mid-drag, so without this the count silently goes stale.
  const readouts: Array<{ el: HTMLElement; get: () => string }> = [];

  function numField(
    parent: HTMLElement,
    label: string,
    get: () => number | null,
    set: (v: number) => void,
    step = 1,
    mixable = false, // can the selected bodies disagree on this value?
    // `placeholder` overrides the "mixed" hint (an optional field shows its
    // default there instead); `onEmpty` makes clearing the field meaningful —
    // without it a blank input is simply ignored.
    opts: {
      placeholder?: string;
      onEmpty?: () => void;
      disabled?: boolean;
      // A control that sits between the label and the number (the lock toggle).
      prefix?: HTMLElement;
    } = {},
  ): HTMLInputElement {
    const wrap = el("label", "ed-field");
    wrap.textContent = label;
    if (opts.prefix) wrap.appendChild(opts.prefix);
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-num";
    input.step = String(step);
    input.value = fmtOrBlank(get());
    if (opts.placeholder !== undefined) input.placeholder = opts.placeholder;
    else if (mixable) input.placeholder = "mixed";
    if (opts.disabled) input.disabled = true;
    // One undo step per editing session (snapshot on focus, before any edit).
    input.addEventListener("focus", () => beginAction());
    input.addEventListener("input", () => {
      if (input.value.trim() === "" && opts.onEmpty) {
        opts.onEmpty();
        markDirty();
        // Clearing a field is an edit like any other, so the readouts derived
        // from it are as stale as they are after a value is typed - a vine's
        // weight is the default's the moment its density is cleared, and its
        // link count the default spacing's. Without this the panel went on
        // reporting the number that had just been deleted.
        refreshFields();
        return;
      }
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        set(v);
        markDirty();
        // Anything the panel DERIVES from what was just typed - a body's mass
        // from its size, thickness or material, a chain's slack from its length
        // - is stale the instant the value lands, and the panel is deliberately
        // not rebuilt while a field is being typed into. `refreshFields` leaves
        // the focused input alone, so this costs the typing nothing.
        refreshFields();
      }
    });
    wrap.appendChild(input);
    parent.appendChild(wrap);
    fields.push({ input, get, set });
    return input;
  }

  // The value every body in the group agrees on, or null if they differ.
  function shared(bodies: readonly EdItem[], get: (b: EdItem) => number): number | null {
    const first = get(bodies[0]!);
    return bodies.every((b) => get(b) === first) ? first : null;
  }

  // Nothing rests on a region or on hook-only scenery, so neither carries a
  // friction - and hook-only is a flag rather than a kind, so it is asked of the
  // body rather than of its kind. A force area and a body of water both carry a direction, hence a
  // rot° even when they are circles (whose rotation is otherwise invisible).
  //
  // Water's own effect on friction is not this: it scales the friction of
  // whatever is INSIDE it (see `WATER_TRACTION_LOSS`), which is a property of
  // the submerged body rather than a number the water authors.
  const frictionless = (b: EdItem) =>
    b.kind === "killzone" || b.kind === "force" || b.kind === "water" || b.passable;

  // May this item be welded into one body? Geometry that is not an area,
  // decoration included - it rides the body rather than adding a piece to it -
  // and lights. An area is refused because a body has ONE kind: killzone, water
  // and force are what a body IS rather than something a piece of it can be, so
  // there is no body a killzone and a wall could both be pieces of. (An area
  // with a notch in it is a different matter and perfectly ordinary - it is one
  // authored outline, cut into pieces at load.) Camera regions and notes are
  // never drawn in play and have nothing to ride.
  //
  // A LIGHT is groupable, and it is the reason this is worth stating twice: a
  // lamp is a fitting and the light it throws, and welding the two into one body
  // is what stops them drifting apart. Moving the sconce moves the light because
  // they are the same body, which is the thing that used to have to be faked by
  // deriving a light out of the fitting's emissive colour.
  const canShareBody = (b: EdItem) =>
    b.layer === "scene" &&
    (b.object !== "collision" ||
      (b.kind !== "killzone" && b.kind !== "force" && b.kind !== "water"));

  // An area is a region of space rather than a piece of stuff, so it is made of
  // nothing and carries no density. Every other kind does, `anchor` included:
  // a grate is a real object, and its material fixes the centre of mass a
  // compound one is built and rotated about even though nothing collides with
  // it.
  const massless = (b: EdItem) =>
    b.kind === "killzone" || b.kind === "force" || b.kind === "water";

  // A number field bound to one panel and one selection: it shows the value the
  // group agrees on (blank if they differ) and writes to every member. `after`
  // runs once per write - the geometry panel uses it to keep a compound body's
  // members in agreement when only one piece of it is selected.
  function groupNum(g: HTMLElement, items: EdItem[], after?: () => void) {
    return (
      label: string,
      get: (b: EdItem) => number,
      set: (b: EdItem, v: number) => void,
      step?: number,
      opts?: { placeholder?: string; onEmpty?: () => void },
    ): HTMLInputElement =>
      numField(
        g,
        label,
        () => shared(items, get),
        (v) => {
          for (const b of items) set(b, v);
          after?.();
        },
        step,
        items.length > 1,
        opts,
      );
  }
  type GroupNum = ReturnType<typeof groupNum>;

  // Is this set of items exactly one whole compound body of several pieces? The
  // properties a body has one of - most visibly its rotation - are edited on the
  // group when it is, and per item when it is not.
  function wholeGroup(items: readonly EdItem[]): EdItem[] | null {
    if (items.length < 2) return null;
    const g = items[0]!.bodyId;
    if (g === null || !items.every((b) => b.bodyId === g)) return null;
    const members = bodyMembers(model.items, g);
    return members.length === items.length ? [...items] : null;
  }

  // Placement and size. Shared by every layer's panel: whatever layer an item
  // lives on, it is a placed shape and moves, rotates and resizes the same way.
  // The frame an object is placed IN, which is the origin `toLevelData` measures
  // every object against. One rule, so what the inspector shows and what the
  // file records cannot disagree.
  const bodyOrigin = (b: EdItem): EdBodyFrame => bodyFrameOf(model, b.bodyId);
  // An item's placement IN its body's frame, which is the pair of numbers the
  // file records for it - so the frame's rotation is taken out on the way in and
  // put back on the way out, exactly as `toLevelData`'s `localOf` does. Without
  // that the panel showed the world-axis distance to the body's origin instead,
  // which for a turned body is a different number from the one on disk: a
  // compound body turned 15° had an object the file records at (20, 20) reading
  // as (14.1, 24.5). Identical for the unturned body almost every body is.
  const localPlacement = (b: EdItem): Vec2 => {
    const f = bodyOrigin(b);
    return b.pos.sub(f.pos).rotated(-f.rot);
  };
  // Is this object its body's ONLY member, with no frame of the body's own?
  // Then `bodyFrameOf` derives the frame FROM IT (see `EdModel.bodyFrames`), and
  // measuring its placement against that frame measures the thing being edited
  // against itself: the offset is always (0, 0, 0), and a value typed into one
  // of these fields lands as a DELTA - typing 10 into `rot°` turned the object
  // by another 10 every time, and the field went on reading 0.
  //
  // Such an object IS its body, so it is placed in the world exactly as the body
  // panel places a body: the value is absolute and applied as a move of the
  // whole (one-member) body, which carries the derived frame with it.
  //
  // A body of one that DOES have a stored frame - one whose siblings were
  // deleted - is left alone: its frame is a real frame, an offset from it is a
  // real offset, and the ordinary local reading is right.
  const framedByItself = (b: EdItem): boolean =>
    !model.bodyFrames.has(b.bodyId) && bodyMembers(model.items, b.bodyId).length === 1;

  function addTransformFields(g: HTMLElement, num: GroupNum, items: EdItem[]): void {
    // RELATIVE TO THE BODY, because that is what an object's placement IS - the
    // file records an offset from its body's frame, and a panel showing world
    // coordinates would be showing a number the level does not contain.
    //
    // It also makes the two readings agree about what moving something means:
    // typing 0 into a scene object's x puts it on its body's origin, where
    // before it put it on the world's.
    //
    // It moves THE OBJECT and nothing else, whichever object it is. The frame is
    // the body's own (`EdModel.bodyFrames`) rather than a member's, so there is
    // no longer an object that secretly IS the body and moves it when it moves.
    //
    // ...with ONE exception, and it is the case a level is mostly made of: an
    // object that is its body's only member (`framedByItself`), which is also
    // every camera region and every note. There the body's frame is not a frame
    // the object sits in, it is the object - so a relative reading measures the
    // thing against itself, shows 0 whatever it is, and turns each value typed
    // into a delta on top of the last (typing 10 into `rot°` turned it by 10
    // again, every time). Those fields read and write WORLD coordinates instead,
    // which for a body of one are the numbers the body panel shows.
    const moveRelative = (b: EdItem, axis: "x" | "y", v: number): void => {
      if (framedByItself(b)) {
        // Through `translateItems` rather than by writing `b.pos`, so the move
        // goes the one way a body moves and the derived frame follows it.
        translateItems(
          model,
          [b],
          axis === "x" ? new Vec2(v - b.pos.x, 0) : new Vec2(0, v - b.pos.y),
        );
        return;
      }
      const origin = bodyOrigin(b);
      const local = localPlacement(b);
      const want = axis === "x" ? local.withX(v) : local.withY(v);
      translateItems(model, [b], origin.pos.add(want.rotated(origin.rot)).sub(b.pos));
    };
    const placement = (b: EdItem): Vec2 => (framedByItself(b) ? b.pos : localPlacement(b));
    num(
      "x",
      (b) => placement(b).x * M2PX,
      (b, v) => moveRelative(b, "x", v * PX),
    );
    num(
      "y",
      (b) => placement(b).y * M2PX,
      (b, v) => moveRelative(b, "y", v * PX),
    );
    // A circle's rotation is invisible, so it only gets the field where it aims
    // something (a force area's current).
    if (
      items.every(
        (b) => b.shape.kind !== "circle" || (b.object === "collision" && b.kind === "force"),
      )
    ) {
      // Measured against the whole SELECTION, not this panel's slice of it: a
      // group that spans layers (a backdrop welded to the body it decorates) is
      // still one body, and turning the geometry panel's items alone would leave
      // the panel behind.
      const whole = wholeGroup(selectedBodies());
      if (whole) {
        // A compound body has ONE rotation, about the centre of mass its built
        // body's origin sits at. Turning each piece about its own centre would
        // pull the body apart, so the field is a delta applied to the group -
        // shown against the BODY's own angle, which is what the file records and
        // what the body panel's `rot°` reads, so the two cannot disagree.
        // Read per use rather than captured, for the reason the body panel's own
        // transform fields are: a frame is replaced, not mutated.
        const frame = (): EdBodyFrame => bodyFrameOf(model, whole[0]!.bodyId);
        numField(
          g,
          "rot°",
          () => (frame().rot * 180) / Math.PI,
          (v) =>
            rotateItemsAbout(model, whole, bodyCentroid(whole), (v * Math.PI) / 180 - frame().rot),
        );
      } else {
        // Also relative: an object's `rot` is an offset from its body's, which
        // is what the file writes and what turning the body then carries. It
        // turns THE OBJECT in place, whichever object it is - the body's angle
        // is the frame's, not a member's, so there is no object here that
        // secretly is the body.
        //
        // An object that is its body's only member is the same exception the x
        // and y fields make (`framedByItself`): its body's angle is its own, so
        // the offset would always read 0 and the angle typed would be added to
        // what is already there. It turns as its body turns - about the centre
        // of mass the built body's origin sits at, which is what the body
        // panel's `rot°` does with the very same object.
        num(
          "rot°",
          (b) => deg(framedByItself(b) ? b.rot : b.rot - bodyOrigin(b).rot),
          (b, v) => {
            if (framedByItself(b)) {
              rotateItemsAbout(model, [b], bodyCentroid([b]), rad(v) - b.rot);
              return;
            }
            b.rot = bodyOrigin(b).rot + rad(v);
          },
        );
      }
    }
    // An arrow is stored as a box, but its height is only a pick band and its
    // width is its length — the notes panel exposes that instead.
    if (items.some(isArrowNote)) return;
    // A MESH has no size to type either. What is drawn is the model's own
    // geometry at its own dimensions, sized by `scale` on the visual panel; the
    // outline it still carries is the editor's handle on it and the placeholder
    // drawn until the file arrives, neither of which is a number an author
    // authors. Offering w/h here is a pair of fields that appear to resize the
    // prop and do not - the shape they change is invisible the moment the mesh
    // loads.
    if (items.every((b) => b.object === "geometry" && b.visual.kind === "mesh")) return;
    // Size is per-shape, so it only appears when the group is all one shape.
    if (items.every((b) => b.shape.kind === "rect")) {
      num("w", (b) => (b.shape.kind === "rect" ? b.shape.w * M2PX : 0), (b, v) => {
        if (b.shape.kind === "rect") b.shape.w = Math.max(1, v) * PX;
      });
      num("h", (b) => (b.shape.kind === "rect" ? b.shape.h * M2PX : 0), (b, v) => {
        if (b.shape.kind === "rect") b.shape.h = Math.max(1, v) * PX;
      });
    } else if (items.every((b) => b.shape.kind === "circle")) {
      // On the lights layer the circle IS the light's reach (see `EdLight`), so
      // it is labelled as what it means rather than as the geometry carrying it.
      const label = items.every((b) => b.object === "light") ? "range" : "radius";
      num(label, (b) => (b.shape.kind === "circle" ? b.shape.r * M2PX : 0), (b, v) => {
        if (b.shape.kind === "circle") b.shape.r = Math.max(1, v) * PX;
      });
    } else if (items.every((b) => b.shape.kind === "poly")) {
      // A polygon has no width or height to type: it is edited on the canvas,
      // vertex by vertex. The panel says so and reports the count, rather than
      // leaving a gap where every other shape has its size fields.
      const count = (): string => {
        const counts = items.map((b) => (b.shape.kind === "poly" ? b.shape.verts.length : 0));
        const total = counts.every((c) => c === counts[0]) ? String(counts[0]) : "mixed";
        // How many corners are PICKED, where any are. It rides the vertex count
        // rather than taking a row of its own because it is the same question
        // asked twice, and because a row that says "0 selected" most of the time
        // is a row that stops being read.
        const target = vertexEditTarget();
        const picked = target ? selectedVertIndices(target).length : 0;
        return picked ? `${total} (${picked} selected)` : total;
      };
      const row = el("label", "ed-field");
      row.textContent = "vertices";
      const val = document.createElement("span");
      val.textContent = count();
      row.appendChild(val);
      g.appendChild(row);
      readouts.push({ el: val, get: count });

      // What the outline BUILDS as. The engine's polygon is convex, so a
      // concave outline is cut into the convex pieces that tile it at load, and
      // this is where an author sees how many that is: the cut is drawn on the
      // canvas, but the count is what says whether a fiddly corner has quietly
      // turned one wall into six. A convex outline reads 1, which is the point -
      // the number only ever grows when the shape needs it to.
      const region = items.every((b) => polyMustBeConvex(b));
      if (!region) {
        const pieces = (): string => {
          const counts = items.map((b) =>
            b.shape.kind === "poly" ? decomposeConvex(b.shape.verts).length : 0,
          );
          return counts.every((c) => c === counts[0]) ? String(counts[0]) : "mixed";
        };
        const prow = el("label", "ed-field");
        prow.textContent = "pieces";
        const pval = document.createElement("span");
        pval.textContent = pieces();
        prow.appendChild(pval);
        g.appendChild(prow);
        readouts.push({ el: pval, get: pieces });
      }

      const hint = el("div", "ed-hint");
      hint.textContent = region
        ? "Drag a corner to move it, an edge midpoint to add one, Alt+click a corner to remove it. Click a corner to pick it out (Shift adds, a rubber band from empty space catches several, Esc drops them); Delete removes the picked corners and the arrows nudge them, and dragging any one of them moves the lot. A camera region always stays convex."
        : "Drag a corner to move it, an edge midpoint to add one, Alt+click a corner to remove it. Click a corner to pick it out (Shift adds, a rubber band from empty space catches several, Esc drops them); Delete removes the picked corners and the arrows nudge them, and dragging any one of them moves the lot. Corners may be dented inward - a concave outline is cut into convex pieces (dashed) for the physics.";
      g.appendChild(hint);
    }
  }

  // Authored appearance: a colour swatch plus a fill opacity. The geometry
  // layer's, which is the one whose look is saved and played, as against the
  // fixed colours of the editor-only furniture.
  function addFillFields(
    g: HTMLElement,
    num: GroupNum,
    items: EdItem[],
    after?: () => void,
  ): void {
    addColorField(g, items, "color", after);
    num("opacity", (b) => b.opacity, (b, v) => (b.opacity = Math.min(1, Math.max(0, v))), 0.1);
  }

  // Just the swatch. Separate from the fill fields above because the lights
  // layer authors a colour and has no opacity: an item's fill there is editor
  // furniture, while the colour is the colour the lamp actually shines.
  function addColorField(
    g: HTMLElement,
    items: EdItem[],
    label: string,
    after?: () => void,
  ): void {
    const cw = el("label", "ed-field");
    cw.textContent = label;
    const ci = document.createElement("input");
    ci.type = "color";
    ci.className = "ed-color";
    // A colour input has no mixed state; it shows the first item's and writes
    // to all of them, which is the only sane reading of "set the colour".
    ci.value = items[0]!.color;
    ci.addEventListener("focus", () => beginAction());
    ci.addEventListener("input", () => {
      for (const b of items) b.color = ci.value;
      after?.();
      markDirty();
    });
    cw.appendChild(ci);
    g.appendChild(cw);
  }

  // Hook-proof: the grapple hook is destroyed on this surface and the ball's is
  // deflected, instead of either anchoring. Still solid - it is about the rope
  // and nothing else - so the avatar stands on it and the rope still wraps its
  // corners.
  //
  // A checkbox on the shape rather than an entry in the kind picker, which is
  // where it used to live, and the two things that could not be said there are
  // exactly the two a level wants: a hook-proof crate that still falls (a body
  // cannot be `rigid` and `impermeable` at once when both are kinds), and a
  // compound wall with one attachable ledge among hook-proof faces. So it is
  // per shape and, like material and thickness, a group does not collapse it
  // onto its first member's.
  function addImpermeableField(g: HTMLElement, items: EdItem[]): void {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = items.every((b) => b.impermeable);
    // A mixed selection says so rather than reporting one piece's answer as the
    // group's - which on a wall that is half hook-proof would be a lie either
    // way round.
    box.indeterminate = !box.checked && items.some((b) => b.impermeable);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of items) b.impermeable = box.checked;
      markDirty();
      // The border style is what says a surface is hook-proof, and it is drawn
      // from the item, so the canvas is already right; the panel is rebuilt so
      // the box loses its indeterminate state.
      rebuildInspector();
    });
    const wrap = el("label", "ed-field");
    wrap.textContent = "hook-proof";
    wrap.appendChild(box);
    g.appendChild(wrap);
    const hint = el("div", "ed-hint");
    hint.textContent =
      "The hook is destroyed (grapple) or deflected (ball) on this surface instead of anchoring — drawn with a dashed steel edge. It stays solid: you can stand on it and the rope still wraps its corners. Per shape, so one piece of a compound body can be the only place a hook will catch.";
    g.appendChild(hint);
  }

  // The trampoline pair (see `LevelBodyData.bounce`): how much of an arrival the
  // surface gives back, and the speed it throws with regardless of the arrival.
  // Beside the friction because it is the same sort of property - what this
  // surface is LIKE to meet - and offered wherever a friction is, so a bouncy
  // crate and a bouncy wall are authored the same way.
  //
  // The readout is the point of the panel, as the spring's droop is of its. A
  // launch speed is not a height and an author is choosing a height, so the
  // field on its own is unauthorable; `v²/2g` turns it into the number actually
  // being picked - how far up the pad throws what lands on it.
  function addBounceFields(g: HTMLElement, num: GroupNum, leads: EdItem[]): void {
    num("bounce", (b) => b.bounce, (b, v) => (b.bounce = Math.min(1, Math.max(0, v))), 0.1);
    // A speed in px/s, like every other length per second on the panel. Never
    // negative: a surface that threw a body INTO itself is not a thing to
    // author, and the sign a force area and a current carry means direction,
    // which a launch takes from the contact normal instead.
    num("launch", (b) => b.launch * M2PX, (b, v) => (b.launch = Math.max(0, v) * PX), 50);
    // Live, and re-derived from the items rather than from the values the panel
    // was built with, for the same reason the spring's droop is: typing a launch
    // has to move the number the launch was typed FOR.
    const height = (): string => {
      const v = shared(leads, (b) => b.launch);
      if (v === null) return "mixed";
      if (v <= 0) return "-";
      return `${((v * v) / (2 * 9.8)).toFixed(2)} m`;
    };
    const row = el("label", "ed-field");
    row.textContent = "throws";
    const val = document.createElement("span");
    val.textContent = height();
    row.appendChild(val);
    g.appendChild(row);
    readouts.push({ el: val, get: height });
    const hint = el("div", "ed-hint");
    hint.textContent =
      "A trampoline. Bounce is the fraction of an impact given back, so what lands gently leaves gently (0 is a dead surface, 1 a perfect bounce). Launch is the spring stored in the pad itself: a floor under the speed anything leaves at, whatever speed it arrived with, so a short drop onto it throws as far as a long one. It fades out on the gentlest touches, so a body that has come to rest on the pad stays put instead of humming. Both are read off both surfaces meeting and the bouncier wins.";
    g.appendChild(hint);
  }

  // Hook-only geometry (see `LevelBodyData.passable`): the hook catches on this
  // body and everything else - the avatar, the rope, loose debris - passes
  // straight through it. A background leaf on a sprung stem, a grate, a girder,
  // a chandelier behind the level.
  //
  // A checkbox on the BODY and not a kind, which is where it used to live
  // (`anchor`), and not per shape either, which is where hook-proof lives. A
  // kind is what a body IS, so hook-only could only ever be immovable scenery -
  // and the case levels want it for is a leaf on a stem, which is a rigid body
  // that still falls and still sags when it is grabbed. Per body rather than
  // per shape because "is this thing in the way at all" has no half-answer: a
  // compound leaf's pieces are one leaf.
  function addPassableField(g: HTMLElement, leads: EdItem[]): void {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = leads.every((b) => b.passable);
    // A mixed selection says so rather than reporting one body's answer as the
    // group's, exactly as the hook-proof and pivot checkboxes do.
    box.indeterminate = !box.checked && leads.some((b) => b.passable);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of leads) b.passable = box.checked;
      syncEditedBodies(leads);
      markDirty();
      // Rebuilt because the answer decides which OTHER fields the panel offers:
      // hook-only geometry carries no friction (nothing rests on it) and no
      // hook-proofing (it exists to be caught on).
      rebuildInspector();
    });
    const wrap = el("label", "ed-field");
    wrap.textContent = "hook-only";
    wrap.appendChild(box);
    g.appendChild(wrap);
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Only the hook can find this body: the player walks and swings straight through it, loose bodies fall through it and the rope never wraps it — drawn with a grate lattice and a dotted edge, behind the solid geometry. A rigid one still falls, still hangs on its spring and is still hauled by a chain; what it stops having is contacts.";
    g.appendChild(hint);
  }

  // Pivot mounting, rigid bodies only (see `LevelBodyData.pivot`): bolted to a
  // frictionless bearing at the centre of mass, so the body spins under torque
  // but never translates - a windmill fin, a paddle wheel. A checkbox beside
  // the kind picker rather than a kind of its own, because a pivot body is a
  // rigid body with one degree of freedom removed rather than a different kind
  // of thing.
  function addPivotField(g: HTMLElement, leads: EdItem[]): void {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = leads.every((b) => b.pivot);
    // Mutually exclusive with a spring (see `addSpringFields`): a body that
    // could neither translate nor rotate is not a thing to author, so the two
    // controls lock each other out here rather than letting a file be saved
    // that the loader has to break the tie in.
    box.disabled = leads.some((b) => b.springFreqX > 0 || b.springFreqY > 0);
    // A mixed selection says so rather than reporting one body's answer as the
    // group's, exactly as the hook-proof checkbox does.
    box.indeterminate = !box.checked && leads.some((b) => b.pivot);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of leads) b.pivot = box.checked;
      syncEditedBodies(leads);
      markDirty();
      // Rebuilt so the box loses its indeterminate state.
      rebuildInspector();
    });
    const wrap = el("label", "ed-field");
    wrap.textContent = "pivot";
    wrap.appendChild(box);
    g.appendChild(wrap);

    // The bearing's own fields, offered once every selected body is on one.
    // `pivot x`/`pivot y` are in the body's frame, like every placement the
    // inspector shows, and an unauthored bearing READS as the centre of mass -
    // which is what it is at build - so typing a value moves the bearing off
    // it and clearing the field puts it back. `return` is the torsion spring
    // (`LevelBodyData.pivotFreq`): 0 leaves the bearing free-spinning, a
    // frequency makes the body bend away under a load and come back to its
    // authored angle - a tree branch, a springboard, a swing gate.
    if (box.checked) {
      const comLocalOf = (lead: EdItem): Vec2 => {
        const members = bodyMembers(model.items, lead.bodyId).filter(
          (m) => m.object === "collision",
        );
        let mass = 0;
        let acc = Vec2.ZERO;
        for (const m of members) {
          const kg = shapeMass(m);
          mass += kg;
          acc = acc.add(m.pos.mul(kg));
        }
        const world = mass > 0 ? acc.div(mass) : (members[0]?.pos ?? Vec2.ZERO);
        const f = bodyFrameOf(model, lead.bodyId);
        return world.sub(f.pos).rotated(-f.rot);
      };
      const at = (b: EdItem): Vec2 => b.pivotAt ?? comLocalOf(b);
      const setAt =
        (mut: (cur: Vec2, v: number) => Vec2) =>
        (v: number): void => {
          for (const b of leads) b.pivotAt = mut(at(b), v);
          syncEditedBodies(leads);
        };
      const clearAt = (): void => {
        for (const b of leads) b.pivotAt = null;
        syncEditedBodies(leads);
      };
      numField(
        g,
        "pivot x",
        () => shared(leads, (b) => at(b).x),
        setAt((c, v) => new Vec2(v, c.y)),
        0.1,
        leads.length > 1,
        { onEmpty: clearAt, placeholder: "centre of mass" },
      );
      numField(
        g,
        "pivot y",
        () => shared(leads, (b) => at(b).y),
        setAt((c, v) => new Vec2(c.x, v)),
        0.1,
        leads.length > 1,
        { onEmpty: clearAt, placeholder: "centre of mass" },
      );
      numField(
        g,
        "return (Hz)",
        () => shared(leads, (b) => b.pivotFreq),
        (v) => {
          for (const b of leads) b.pivotFreq = Math.min(MAX_SPRING_FREQ, Math.max(0, v));
          syncEditedBodies(leads);
        },
        0.1,
        leads.length > 1,
      );
      numField(
        g,
        "damping",
        () => shared(leads, (b) => b.pivotDamping),
        (v) => {
          for (const b of leads) b.pivotDamping = Math.min(1, Math.max(0, v));
          syncEditedBodies(leads);
        },
        0.05,
        leads.length > 1,
        { disabled: !leads.some((b) => b.pivotFreq > 0) },
      );
    }

    const hint = el("div", "ed-hint");
    hint.textContent = box.checked
      ? "Bolted to a bearing: the body swings about the pivot point (blank = the centre of mass, where gravity has no leverage) and never translates. An off-centre bearing feels gravity - an unbalanced body hangs from it - and a return frequency makes it a branch: it bends away under a load and springs back to its authored angle when the load leaves."
      : "Bolted to a bearing at the centre of mass: the body spins freely when torque is applied - a landing, a hook, a chain - but never moves from where it is authored. Gravity does not pull it down.";
    g.appendChild(hint);
  }

  // Spring mounting, rigid bodies only (see `LevelBodyData.springFreqX`): held
  // at the authored position by a two-axis spring-damper, so the body sags
  // under load and springs back. Beside the pivot checkbox because the two are
  // the same shape of thing - a rigid body with one degree of freedom traded
  // away - and mutually exclusive for that reason: a body on a bearing that
  // also could not rotate could not move at all, so each control disables the
  // other while it is set rather than letting a file be authored that the
  // loader would then have to break the tie in.
  //
  // The two DROOP readouts are the point of the panel. A frequency is not a
  // distance and an author is choosing a distance, so the field on its own is
  // unauthorable; `g/w²` and `F/(m·w²)` turn it into the two numbers that are
  // actually being picked - how far the leaf hangs on its own, and how far it
  // goes when the player is on it. The second is the one that needs the mass,
  // which is why this sits below the material fields rather than above them.
  function addSpringFields(g: HTMLElement, leads: EdItem[]): void {
    const sprung = (b: EdItem): boolean => b.springFreqX > 0 || b.springFreqY > 0;
    const anySprung = leads.some(sprung);
    const anyPivot = leads.some((b) => b.pivot);

    const freq = (label: string, get: (b: EdItem) => number, set: (b: EdItem, v: number) => void) =>
      numField(
        g,
        label,
        () => shared(leads, get),
        (v) => {
          for (const b of leads) set(b, Math.min(MAX_SPRING_FREQ, Math.max(0, v)));
          syncEditedBodies(leads);
          // The pivot checkbox's enabled state depends on these, and the axle
          // ring is drawn from the item - so a frequency typed in has to rebuild
          // the panel rather than only revalue it.
          if (leads.some(sprung) !== anySprung) rebuildInspector();
        },
        0.1,
        leads.length > 1,
        { disabled: anyPivot },
      );
    freq("spring x (Hz)", (b) => b.springFreqX, (b, v) => (b.springFreqX = v));
    freq("spring y (Hz)", (b) => b.springFreqY, (b, v) => (b.springFreqY = v));
    numField(
      g,
      "damping",
      () => shared(leads, (b) => b.springDamping),
      (v) => {
        for (const b of leads) b.springDamping = Math.min(1, Math.max(0, v));
        syncEditedBodies(leads);
      },
      0.05,
      leads.length > 1,
      { disabled: anyPivot || !anySprung },
    );

    // Live, and re-derived from the items rather than from the values the panel
    // was built with, for the same reason the mass readout is: typing a
    // frequency has to move the number the frequency was typed FOR.
    const droop = (): string => {
      const f = shared(leads, (b) => b.springFreqY);
      if (f === null) return "mixed";
      if (f <= 0) return "pinned";
      const w = 2 * Math.PI * f;
      return `${((9.8 / (w * w)) * 100).toFixed(1)} cm`;
    };
    const hang = (): string => {
      const f = shared(leads, (b) => b.springFreqY);
      if (f === null) return "mixed";
      if (f <= 0) return "pinned";
      const w = 2 * Math.PI * f;
      // Every collision piece of every selected body: the spring pulls on the
      // body's whole mass, not on the piece whose panel this is.
      const kg = leads.reduce(
        (m, lead) =>
          m +
          bodyMembers(model.items, lead.bodyId)
            .filter((x) => x.object === "collision")
            .reduce((a, x) => a + shapeMass(x), 0),
        0,
      );
      if (kg <= 0) return "—";
      return `+${(((Player.MASS * 9.8) / (kg * w * w)) * 100).toFixed(1)} cm`;
    };
    for (const [label, get] of [["droop", droop], ["+ a hanging player", hang]] as const) {
      const row = el("label", "ed-field");
      row.textContent = label;
      const val = document.createElement("span");
      val.textContent = get();
      row.appendChild(val);
      g.appendChild(row);
      readouts.push({ el: val, get });
    }

    const hint = el("div", "ed-hint");
    hint.textContent =
      "Held at the authored position by a spring per axis, so the body sags under its own weight and further under a load — a hanging player, a resting rock, a chain — then springs back past its rest height before settling. 0 on an axis pins that axis instead (a leaf that only bobs vertically). Frequency, not stiffness: the droop under its own weight is the same whatever the body is made of, while a heavier body notices a hung player less. A spring body cannot rotate, so it cannot also be pivot-mounted.";
    g.appendChild(hint);
  }

  // The standing "match the collision shape" link (see `EdItem.matchId`): while
  // ticked, this geometry object's outline and its collision partner's are kept
  // equal in both directions, so resizing or moving either does both. Offered
  // only where a partner exists to link to - decoration in a body with no
  // collision object has nothing to match.
  function addMatchField(g: HTMLElement, items: EdItem[]): void {
    const linkable = items.filter(
      (b) =>
        b.layer === "scene" &&
        b.object === "geometry" &&
        bodyMembers(model.items, b.bodyId).some((m) => m.object === "collision"),
    );
    if (!linkable.length) return;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = linkable.every((b) => b.matchId !== 0);
    box.indeterminate = !box.checked && linkable.some((b) => b.matchId !== 0);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of linkable) {
        if (!box.checked) {
          b.matchId = 0;
          continue;
        }
        const target = matchTargetFor(b);
        if (!target) continue;
        b.matchId = target.id;
        // Ticking the box is the one edit that SNAPS: the collision shape is
        // what the level plays as, so the look moves onto it rather than the
        // gameplay being dragged to wherever the look was left.
        copyMatchedOutline(target, b);
      }
      markDirty();
      refreshFields();
      rebuildInspector();
    });
    const wrap = el("label", "ed-field");
    wrap.textContent = "match collision";
    wrap.appendChild(box);
    g.appendChild(wrap);
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Keeps this outline equal to the collision shape it dresses, in both directions: resize or move either and the other follows. Ticking it snaps this object onto the collision shape. Untick to author a look that deliberately differs from what the body collides as.";
    g.appendChild(hint);
  }

  // Which collision object a fresh link ties to: the one already stating the
  // same outline when there is one, else the nearest - the piece the author is
  // most plausibly dressing.
  function matchTargetFor(b: EdItem): EdItem | null {
    const cs = bodyMembers(model.items, b.bodyId).filter((m) => m.object === "collision");
    if (!cs.length) return null;
    const exact = cs.find((c) => outlinesEqual(c, b));
    if (exact) return exact;
    let best = cs[0]!;
    for (const c of cs) {
      if (c.pos.sub(b.pos).length() < best.pos.sub(b.pos).length()) best = c;
    }
    return best;
  }

  // What the shapes are made of: a material, a thickness through the z axis the
  // 2D view cannot show, and the mass those two work out to. Per SHAPE, not per
  // body - the one geometry property a compound body does not collapse onto its
  // first member's, since a body's mass, centre of mass and inertia are sums
  // over its pieces and a piece brings its own material to them (see
  // `LevelBodyData.material`).
  //
  // The mass readout is what makes either number authorable at all: an author
  // is choosing a weight, and a density and a depth only become one once the
  // shape's own size is in it. It is the same `prismMass` the built body uses,
  // through `shapeMass`, and it is a live readout for the same reason the
  // vertex count is - a canvas resize changes it while the panel is
  // deliberately not rebuilt.
  function addMaterialFields(g: HTMLElement, items: EdItem[]): void {
    const mw = el("label", "ed-field");
    mw.textContent = "material";
    const ms = document.createElement("select");
    ms.className = "ed-select";
    const sharedMaterial = items.every((b) => b.material === items[0]!.material)
      ? items[0]!.material
      : null;
    if (!sharedMaterial) {
      // Mixed: a blank entry holds the selection until one is picked, exactly as
      // the kind picker does, so it never reports one material as the group's.
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "mixed";
      ms.appendChild(o);
    }
    for (const name of MATERIAL_NAMES) {
      const o = document.createElement("option");
      o.value = name;
      // The name alone: the picker is as wide as the panel and no wider, and
      // "aluminium · 2700 kg/m³" clips in it. The density it stands for gets a
      // readout row of its own below, which cannot overflow.
      o.textContent = name;
      ms.appendChild(o);
    }
    ms.value = sharedMaterial ?? "";
    ms.addEventListener("change", () => {
      if (!ms.value) return;
      beginAction();
      for (const b of items) b.material = ms.value as MaterialName;
      markDirty();
      refreshFields();
    });
    mw.appendChild(ms);
    g.appendChild(mw);

    // What the picked material is worth, since the picker itself has room for
    // the name alone. Re-derived from the items rather than from the value the
    // panel was built with, so picking a material updates it without a rebuild.
    const density = () => {
      const first = items[0]!.material;
      return items.every((b) => b.material === first) ? `${MATERIALS[first]} kg/m³` : "mixed";
    };
    const drow = el("label", "ed-field");
    drow.textContent = "density";
    const dval = document.createElement("span");
    dval.textContent = density();
    drow.appendChild(dval);
    g.appendChild(drow);
    readouts.push({ el: dval, get: density });

    // Authored in pixels like every other length, since it is one: the z
    // dimension of the same prism the width and height are the other two of.
    numField(
      g,
      "thickness",
      () => shared(items, (b) => b.thickness * M2PX),
      (v) => {
        for (const b of items) b.thickness = Math.max(1, v) * PX;
      },
      10,
      items.length > 1,
    );

    const mass = () => {
      const kg = items.reduce((m, b) => m + shapeMass(b), 0);
      // Under a kilogram (a pebble, a shard) the interesting digits are grams.
      return kg < 1 ? `${(kg * 1000).toFixed(0)} g` : `${kg.toFixed(kg < 10 ? 2 : 1)} kg`;
    };
    const row = el("label", "ed-field");
    row.textContent = items.length > 1 ? "total mass" : "mass";
    const val = document.createElement("span");
    val.textContent = mass();
    row.appendChild(val);
    g.appendChild(row);
    readouts.push({ el: val, get: mass });
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Thickness is the shape's depth through z, the dimension the 2D view cannot show: mass is area × thickness × density. Both are per shape, so a compound body's pieces each carry their own. Only a rigid body has a mass, but the material also fixes where a body's centre of mass — the point it rotates about — sits.";
    g.appendChild(hint);
  }

  // How the 3D renderer draws these shapes (see `VisualData`). Per SHAPE like
  // material and thickness, and left alone by `syncBodyProps` for the same
  // reason: a compound body of a stone head on a wooden shaft is two visuals on
  // one body, each riding its own piece.
  //
  // The section is deliberately shallow. `auto` is the default and needs
  // nothing, so a level author never has to open it; the fields that appear
  // depend on the kind, because a mesh's placement means nothing to an
  // extrusion and an extrusion's depth means nothing to a mesh.
  function addVisualFields(g: HTMLElement, items: EdItem[]): void {
    const kw = el("label", "ed-field");
    kw.textContent = "kind";
    const ks = document.createElement("select");
    ks.className = "ed-select";
    const sharedKind = items.every((b) => b.visual.kind === items[0]!.visual.kind)
      ? items[0]!.visual.kind
      : null;
    if (!sharedKind) {
      // Mixed: a blank entry holds the selection until one is picked, exactly as
      // the kind and material pickers do.
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "mixed";
      ks.appendChild(o);
    }
    for (const [value, label] of [
      ["primitive", "primitive"],
      ["mesh", "mesh"],
    ] as const) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      ks.appendChild(o);
    }
    ks.value = sharedKind ?? "";
    ks.addEventListener("change", () => {
      if (!ks.value) return;
      beginAction();
      for (const b of items) b.visual.kind = ks.value as EdVisual["kind"];
      markDirty();
      // Which fields apply depends on the kind, so the panel is rebuilt rather
      // than revalued - the same reason the body kind picker rebuilds.
      rebuildInspector();
    });
    kw.appendChild(ks);
    g.appendChild(kw);

    const num = (
      label: string,
      get: (v: EdVisual) => number,
      set: (v: EdVisual, x: number) => void,
      step = 1,
      opts: { placeholder?: string; onEmpty?: () => void } = {},
    ): void => {
      numField(
        g,
        label,
        () => shared(items, (b) => get(b.visual)),
        (x) => {
          for (const b of items) set(b.visual, x);
        },
        step,
        items.length > 1,
        opts,
      );
    };

    if (sharedKind === "mesh" || sharedKind === null) {
      const mw = el("label", "ed-field");
      mw.textContent = "mesh";
      const ms = document.createElement("select");
      ms.className = "ed-select";
      // The manifest, plus a blank for "not chosen yet". An unlisted key already
      // on the item is kept as an option of its own rather than silently
      // rewritten, so opening a level built against a manifest this build does
      // not have cannot lose what it named.
      const keys = new Set<string>(Object.keys(MESH_ASSETS));
      for (const b of items) if (b.visual.mesh) keys.add(b.visual.mesh);
      for (const key of ["", ...[...keys].sort()]) {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = key || "(none)";
        ms.appendChild(o);
      }
      ms.value = items.every((b) => b.visual.mesh === items[0]!.visual.mesh)
        ? items[0]!.visual.mesh
        : "";
      ms.addEventListener("change", () => {
        beginAction();
        for (const b of items) b.visual.mesh = ms.value;
        markDirty();
        refreshFields();
      });
      mw.appendChild(ms);
      g.appendChild(mw);

      // Placement of the prop in the shape's own frame. Lengths in pixels like
      // every other length; the rotations are angles and are authored in
      // degrees, as `rot°` is.
      // The two rotations the item's own in-plane transform cannot express.
      // Its x, y and rotation are the ITEM's, edited above like every other
      // object's - a geometry object has a transform of its own now, so the look
      // does not carry a second one that could disagree with it.
      num("rot x°", (v) => deg(v.rotX), (v, d) => (v.rotX = rad(d)), 5);
      num("rot y°", (v) => deg(v.rotY), (v, d) => (v.rotY = rad(d)), 5);
      // Dimensionless: it multiplies the model's own size, so it is not a length
      // and does not scale on the way to disk.
      num("scale", (v) => v.scale, (v, s) => (v.scale = s), 0.1);
    }

    // Depth placement applies whatever the kind is: 0 is the gameplay plane and
    // negative is away from the camera. On a background panel it is the whole
    // point of the section - a panel at -20 m parallaxes as the camera pans,
    // where a panel at 0 is the flat fill the 2D renderer draws.
    num("off z", (v) => v.offsetZ * M2PX, (v, z) => (v.offsetZ = z * PX), 5);

    if (sharedKind !== "mesh") {
      // Extrusion controls. Both are optional overrides with a real third state
      // - "take it from somewhere else" - so clearing the field is meaningful
      // and the placeholder says what the fallback is.
      num("depth", (v) => (v.depth ?? 0) * M2PX, (v, d) => (v.depth = Math.max(1, d) * PX), 5, {
        placeholder: items.length > 1 ? "mixed" : "default",
        onEmpty: () => {
          for (const b of items) b.visual.depth = null;
        },
      });
      num("bevel", (v) => (v.bevel ?? 0) * M2PX, (v, b) => (v.bevel = Math.max(0, b) * PX), 1, {
        placeholder: items.length > 1 ? "mixed" : "none",
        onEmpty: () => {
          for (const b of items) b.visual.bevel = null;
        },
      });
    }

    // The surface, offered whatever the kind. It is what an extrusion is
    // textured with, and it is what a prop wears INSTEAD of the materials its
    // own file carries - which is what dresses a bare geometry-only export as
    // the same stone the walls are made of.
    {
      const tw = el("label", "ed-field");
      tw.textContent = "texture";
      const ts = document.createElement("select");
      ts.className = "ed-select";
      // One namespace, authored sets first: a level names a surface, and whether
      // it is a downloaded set of maps or generated noise is not a distinction
      // the author has to carry (see `surfaceFor`). A key already on the item
      // that this build has no manifest entry for is kept as an option of its
      // own rather than silently rewritten, exactly as the mesh picker does.
      const keys = new Set<string>([
        SOLID_SURFACE,
        ...Object.keys(TEXTURE_ASSETS),
        ...MATERIAL_NAMES,
      ]);
      for (const b of items) if (b.visual.texture) keys.add(b.visual.texture);
      for (const key of ["", ...keys]) {
        const o = document.createElement("option");
        o.value = key;
        // Blank is the default generated surface. It is NOT "whatever the
        // collision object's material says" any more: what a piece is made of is
        // a fact about its mass, and a geometry object states its own surface -
        // one made with **Add geometry** starts out carrying the material's name
        // here explicitly, which is the same thing said where it can be edited.
        o.textContent = key
          ? key === SOLID_SURFACE
            ? `${key} (solid fill)`
            : key in TEXTURE_ASSETS
              ? `${key} (authored)`
              : key
          : "(default)";
        ts.appendChild(o);
      }
      ts.value = items.every((b) => b.visual.texture === items[0]!.visual.texture)
        ? items[0]!.visual.texture
        : "";
      ts.addEventListener("change", () => {
        beginAction();
        for (const b of items) b.visual.texture = ts.value;
        markDirty();
        // A flat fill has no tiling, so the three fields below it appear and go
        // with the choice rather than sitting there editing numbers nothing
        // reads.
        rebuildInspector();
      });
      tw.appendChild(ts);
      g.appendChild(tw);

      // Everything from here down is about a PATTERN - how large it is worn,
      // where it starts - and a solid fill has none. The colour it wears is the
      // object's own `color`, edited in the fill fields below this section, so
      // the section says where that is rather than restating the swatch.
      if (items.every((b) => isSolidSurface(b.visual.texture))) {
        const hint = el("div", "ed-hint");
        hint.textContent =
          "A flat fill of this object's `color` below - no pattern, nothing to tile, and the colour is worn exactly as picked rather than as a tint.";
        g.appendChild(hint);
      } else {
        // How large this shape wears the texture, as a MULTIPLE of the size the
        // texture was authored at: 1 is life size, 2 twice as large. Dimensionless
        // like `scale`, so it is typed as written and never converted - and blank
        // is 1, which is why the placeholder says so rather than naming a fallback
        // the author would have to go and look up.
        num(
          "tile scale",
          (v) => v.tileScale ?? 1,
          (v, x) => (v.tileScale = Math.max(0.01, x)),
          0.1,
          {
            placeholder: items.length > 1 ? "mixed" : "1",
            onEmpty: () => {
              for (const b of items) b.visual.tileScale = null;
            },
          },
        );
        // What that multiple works out to on the ground. The scale is the right
        // thing to AUTHOR - it survives swapping the texture for one captured at a
        // different size, and 1 always means life size - but "×2" says nothing
        // about whether these bricks will read as bricks, and the metres do. Same
        // trick the material picker uses for density, re-derived per refresh so it
        // tracks both this field and the texture picker above it.
        const tileReadout = () => {
          const first = items[0]!;
          const same = items.every(
            (b) =>
              b.visual.tileScale === first.visual.tileScale &&
              b.visual.texture === first.visual.texture,
          );
          if (!same) return "mixed";
          const metres = tileMetres(
            surfaceName(first.visual.texture || first.material),
            first.visual.tileScale,
          );
          return `${metres.toFixed(2)} m per repeat`;
        };
        const trow = el("label", "ed-field");
        trow.textContent = "";
        const tval = document.createElement("span");
        tval.textContent = tileReadout();
        trow.appendChild(tval);
        g.appendChild(trow);
        readouts.push({ el: tval, get: tileReadout });

        // Where the pattern starts on this shape, so a course of bricks can be
        // lined up with the edge of the wall rather than with the world origin.
        // In scene pixels like every other length here, which on this project's
        // scale is centimetres exactly (100 px to the metre), and it shifts the
        // texture rather than the geometry: +x right, +y down.
        num(
          "tile off x",
          (v) => v.tileOffset.x * M2PX,
          (v, x) => (v.tileOffset = new Vec2(x * PX, v.tileOffset.y)),
          5,
        );
        num(
          "tile off y",
          (v) => v.tileOffset.y * M2PX,
          (v, y) => (v.tileOffset = new Vec2(v.tileOffset.x, y * PX)),
          5,
        );
      }
    }

    // Emission: what this shape gives off, as against what it reflects. It is
    // the whole of a lamp - the shape reads as bright AND throws a light of this
    // colour that reaches the walls (see `EmissiveRig`), so a sconce is one
    // authored thing rather than a glowing shape and a `LightData` beside it
    // that nothing keeps in step.
    //
    // A colour input has no empty state, so the tick is what says whether the
    // shape emits at all; unticking clears the colour rather than leaving a hex
    // string on disk that nothing renders.
    {
      const on = items.map((b) => b.visual.emissive !== "");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = on.every(Boolean);
      box.indeterminate = !box.checked && on.some(Boolean);
      box.addEventListener("change", () => {
        beginAction();
        for (const b of items) {
          b.visual.emissive = box.checked ? b.visual.emissive || DEFAULT_LIGHT_COLOR : "";
        }
        markDirty();
        rebuildInspector(); // the colour and its multiplier appear or go
      });
      const ew = el("label", "ed-field");
      ew.textContent = "emissive";
      ew.appendChild(box);
      g.appendChild(ew);
      // WHERE it glows: another set's emission map worn over this surface, so a
      // brick wall gets lit windows without the brick becoming a different
      // surface. Offered only when there is something to offer - a manifest with
      // no emission map in it would otherwise show a picker whose only entry is
      // "(none)" - and always when the shape already names one, so a level built
      // against a manifest this build lacks cannot lose what it named.
      const glowKeys = new Set<string>(emissiveMapNames());
      for (const b of items) if (b.visual.emissiveTexture) glowKeys.add(b.visual.emissiveTexture);
      if (glowKeys.size > 0) {
        const gw = el("label", "ed-field");
        gw.textContent = "glow map";
        const gs = document.createElement("select");
        gs.className = "ed-select";
        for (const key of ["", ...[...glowKeys].sort()]) {
          const o = document.createElement("option");
          o.value = key;
          o.textContent = key || "(none)";
          gs.appendChild(o);
        }
        const first = items[0]!.visual.emissiveTexture;
        gs.value = items.every((b) => b.visual.emissiveTexture === first) ? first : "";
        gs.addEventListener("change", () => {
          beginAction();
          for (const b of items) b.visual.emissiveTexture = gs.value;
          markDirty();
          rebuildInspector(); // a map is emission, so the reach and flicker appear
        });
        gw.appendChild(gs);
        g.appendChild(gw);
      }
      const emits =
        box.checked || box.indeterminate || items.some((b) => b.visual.emissiveTexture !== "");
      if (box.checked || box.indeterminate) {
        const cw = el("label", "ed-field");
        cw.textContent = "glow";
        const ci = document.createElement("input");
        ci.type = "color";
        ci.className = "ed-color";
        ci.value = items.find((b) => b.visual.emissive)?.visual.emissive || DEFAULT_LIGHT_COLOR;
        ci.addEventListener("focus", () => beginAction());
        ci.addEventListener("input", () => {
          for (const b of items) b.visual.emissive = ci.value;
          markDirty();
        });
        cw.appendChild(ci);
        g.appendChild(cw);
      }
      // The light this shape throws, which a MAP earns as much as a colour does:
      // an emission map glows in the colours it was painted in, so a shape
      // wearing one is a lamp whether or not a tint was ticked on.
      if (emits) {
        // Above 1 pushes the colour past white into the headroom ACES tone
        // mapping still has, which is what makes a small flame read as a source
        // rather than as a pale patch of paint - and, since the light this shape
        // throws is scaled from it, lights further by the same act.
        num("glow ×", (v) => v.emissiveIntensity, (v, x) => (v.emissiveIntensity = Math.max(0, x)), 0.5);
        // ...and that is ALL of emission. It is appearance: what this shape
        // gives off, so it reads as bright whatever is shining on it. What it
        // does NOT do is light the room - three.js has no global illumination,
        // so an emissive material reaches nothing at all.
        //
        // A lamp that lights is this plus a LIGHT on the lights layer, grouped
        // into the same body (Ctrl+G). That used to be impossible to keep in
        // step, which is why a glowing shape derived its own light out of seven
        // fields here - a reach, a cone, an aim, a shadow, a flicker. A light in
        // the same body cannot drift from the fitting, because it IS the body.
      }
    }

    const hint = el("div", "ed-hint");
    hint.textContent =
      "How the 3D renderer draws this shape: `auto` extrudes the shape's own primitive through z and wears the texture below, which is what every body gets for free; `mesh` replaces that with a GLB prop, which wears the texture too if one is named and keeps its own materials otherwise; `none` draws nothing at all (an invisible wall). `tile` is how much world one repeat of the texture covers, so the same stone reads the same on a plank and on a cliff. The texture `color` is the one that names no surface: a flat fill of the shape's own `color`, worn exactly as picked, with nothing to tile. A shape that emits reads as BRIGHT and lights nothing - emission is appearance, and three.js has no global illumination. A lamp that lights the room is this plus a light on the lights layer, grouped into the same body with Ctrl+G, which is what makes the fitting and its light one thing that cannot drift apart. `glow map` makes the emission a pattern (lit windows, cracks) rather than the whole face. Per shape, so a body's pieces each carry their own. Render-only — nothing here reaches the simulation.";
    g.appendChild(hint);
  }

  // Every layer's panel ends the same way: the two actions that apply to any
  // selection, whatever it is made of. Duplicate and Delete act on the *whole*
  // selection, so a cross-layer one carries a single shared row above the
  // per-layer panels instead of one per panel that would each claim to be about
  // its own layer while reaching outside it.
  let selectionSpansLayers = false;
  function addActionsRow(g: HTMLElement): void {
    if (selectionSpansLayers) return;
    appendActions(g);
  }
  function appendActions(g: HTMLElement): void {
    const row = el("div", "ed-row");
    // On a COLLISION shape, and only there: it is the object that has no look of
    // its own, and giving it one is the step a draw no longer takes for you.
    // A geometry object already is the look, and offering it a second one would
    // stack two extrusions in the same place.
    const solids = selectedBodies().filter(
      (b) => b.object === "collision" && b.layer === "scene",
    );
    if (solids.length && solids.length === selectedBodies().length) {
      const b = button("Add geometry", () => addGeometryFor(solids));
      b.title =
        "Give this shape a look: a geometry object with its own copy of the outline, in the same body. Nothing draws a collision shape by itself.";
      row.appendChild(b);
    }
    row.append(
      button("Duplicate", () => duplicateSelected()),
      button("Delete", () => deleteSelected()),
    );
    g.appendChild(row);
  }

  // One panel for the whole selection: every property the group has in common
  // is editable and writes to all of them. A lone object is just the N=1 case, so
  // single and multi editing can't drift apart.
  //
  // It edits an OBJECT, so it shows only what an object has: its form, where it
  // sits in its body, and what it is made of. A kind, a friction, a force and a
  // fill are the BODY's - one each, for the whole assembly - and they are edited
  // on the body panel, reached by selecting the body. They used to be repeated
  // here, which read as a collision shape having its own `kind: static` and its
  // own friction; it did not, and the file it saves to has never had a place to
  // put them.
  //
  // A LOOK is the same story one level down. Nothing draws a collision shape but
  // a geometry object, so the visual fields belong to the geometry panel: on a
  // collision shape they were controls that wrote to a field `toLevelData` has
  // never written for a collision object, which is a dial connected to nothing.
  function buildBodyGroup(bodies: EdItem[]): void {
    const g = el("div", "ed-group");
    // Named for what it IS. A panel headed "Body #12" on something that is one
    // object inside a body is the same confusion in the title bar.
    const solid = bodies.some((b) => (b.object === "collision"));
    const noun = solid ? "Collision" : "Geometry";
    g.appendChild(
      heading(
        bodies.length === 1
          ? `${noun} #${bodies[0]!.id}`
          : `${bodies.length} ${solid ? "collision shapes" : "geometry objects"} selected`,
      ),
    );
    if (bodies.length > 1) {
      const hint = el("div", "ed-hint");
      hint.textContent =
        "Edits apply to all of them. Shift+click adds or removes; rubber-band left→right encloses, right→left touches.";
      g.appendChild(hint);
    }

    const sync = () => syncEditedBodies(bodies);
    const num = groupNum(g, bodies, sync);
    addTransformFields(g, num, bodies);
    // Hook-proof, offered for the solid kinds it means something on: an area is
    // a region the rope passes through, and a hook-only body exists to be caught
    // on, so neither has a hook to repel.
    if (
      solid &&
      bodies.every((b) => (b.kind === "static" || b.kind === "rigid") && !b.passable)
    ) {
      addImpermeableField(g, bodies);
    }
    // Material and thickness are what a shape WEIGHS, and decoration weighs
    // nothing - its extrusion depth is `visual.depth` instead.
    if (solid && !bodies.some(massless)) addMaterialFields(g, bodies);
    // The link that keeps a look and the collision shape it dresses one
    // outline; beside the transform fields, since it is those it takes over.
    if (!solid) addMatchField(g, bodies);
    // What a thing LOOKS like is a geometry object's business and only its own.
    // A collision shape is drawn by whichever geometry object dresses it, and
    // `toLevelData` writes no look for a collision object at all - so these
    // fields on one edited a value that never reached disk.
    if (!solid) addVisualFields(g, bodies);

    // A geometry object carries its OWN fill - `toLevelData` writes its colour
    // and opacity onto the object. A collision shape does not: the colour a wall
    // is painted is its BODY's, and it is edited there.
    if (!solid) addFillFields(g, num, bodies, sync);

    addGroupSection(g);
    addActionsRow(g);
    inspector.appendChild(g);
  }

  // Compound-body controls. A group is one engine body carrying several convex
  // shapes: the pieces share a transform, and the joins between them stop being
  // corners - the rope will not wrap a vertex buried inside a sibling shape, and
  // ledge detection will not grab one. That is the whole reason to group, so the
  // panel says it rather than offering a bare button.
  //
  // It reads the WHOLE selection rather than the panel's own layer, because a
  // group may span layers - a backdrop welded to the body it decorates is the
  // case - and a Group button that silently left the panels out of it would be
  // making a different body than the one on screen. Gated like the actions row:
  // a cross-layer selection carries one shared section above the per-layer
  // panels instead of the same buttons repeated in each of them.
  function addGroupSection(g: HTMLElement): void {
    if (selectionSpansLayers) return;
    appendGroupSection(g);
  }
  function appendGroupSection(g: HTMLElement): void {
    const sel = selectedBodies();
    // Bodies picked in the TREE count here too - selecting two rows and pressing
    // Merge is the plainest way to say "these are one body from now on", and it
    // is the reason the body selection is a set.
    const bodies = new Set(selectedBodyIds.size ? selectedBodyIds : sel.map((b) => b.bodyId));
    const row = el("div", "ed-row");
    if (mergeableBodies().length > 1) {
      const b = button("Merge", () => mergeIntoBody());
      b.title = "Move these objects into one body (Ctrl+G)";
      row.appendChild(b);
    }
    const compound = [...bodies].some((id) => bodyMembers(model.items, id).length > 1);
    if (compound) {
      const b = button("Split", () => splitIntoBodies());
      b.title = "Take these bodies apart - every object becomes its own body (Ctrl+Shift+G)";
      row.appendChild(b);
    }
    g.appendChild(row);
    const only = bodies.size === 1 ? [...bodies][0]! : null;
    if (!row.childElementCount && only === null) return;
    const hint = el("div", "ed-hint");
    if (only !== null) {
      const members = bodyMembers(model.items, only);
      const shapes = members.filter((m) => m.object === "collision").length;
      const lights = members.filter((m) => m.object === "light").length;
      const panels = members.length - shapes - lights;
      const parts: string[] = [];
      if (shapes) parts.push(`${shapes} ${shapes === 1 ? "shape" : "shapes"}`);
      if (panels) parts.push(`${panels} decoration`);
      if (lights) parts.push(`${lights} ${lights === 1 ? "light" : "lights"}`);
      hint.textContent = shapes
        ? `One body of ${parts.join(", ")}: they share a transform, and the rope and ledge grabs treat the seams between the shapes as interior. Alt+click an object to edit it alone.`
        : `One body of ${parts.join(", ")}, moved and turned as one. Nothing here collides, so it builds no engine body: it stays where it is authored in play. Merge it with a colliding shape to have it ride that.`;
    } else {
      hint.textContent =
        "Merging puts these objects in ONE body. Its collision shapes build as a single body, so the rope runs straight over the seams between them instead of snagging; kind, fill and friction collapse onto the first shape's, while material, thickness and hook-proof stay per shape. Decoration in the body is carried by it - its own fill, no mass, drawn in the body's frame. A light in it is that body's light, and moving the body moves the light.";
    }
    g.appendChild(hint);
  }

  // A body's position in the outliner, which is what names it everywhere in the
  // UI. Derived from the same `bodyRuns` the tree and `toLevelData` walk, so the
  // number on a panel is the number in the tree is the index on disk.
  const bodyIndexOf = (id: number): number =>
    bodyRuns(model.items.filter((i) => i.layer === "scene")).findIndex(
      (r) => r[0]!.bodyId === id,
    );

  // The properties a BODY has exactly one of: what it is, what it rubs like,
  // what drives it, what it is painted. Shared by the body panel and by the
  // body section above an object selection, so those two can't drift apart
  // about which fields a kind makes applicable.
  //
  // Read and written on the LEADS - the collision object each body's record is
  // written from - and pushed to the rest of each body by `syncBodyProps`. Going
  // through the members instead is what put a `mixed` in the opacity field of a
  // body whose decoration is deliberately a different opacity from its walls:
  // that decoration's own opacity is not the body's, and reading it as a second
  // opinion on the body's fill is reading the wrong field.
  function addBodyProps(g: HTMLElement, members: EdItem[]): void {
    const leads = members.filter((b) => b.object === "collision");
    const num = groupNum(g, leads, () => syncEditedBodies(leads));
    // The physics half exists only for a body that HAS some. A body of pure
    // decoration or a lone light has no kind, no friction and no force, and
    // offering them would be three controls that change nothing.
    if (leads.length) {
      const kw = el("label", "ed-field");
      kw.textContent = "kind";
      const ks = document.createElement("select");
      ks.className = "ed-select";
      const sharedKind = leads.every((b) => b.kind === leads[0]!.kind) ? leads[0]!.kind : null;
      if (!sharedKind) {
        // Mixed kinds: a blank entry holds the selection until one is picked, so
        // the picker never misreports one body's kind as the group's.
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "mixed";
        ks.appendChild(o);
      }
      for (const k of BODY_KINDS) {
        const o = document.createElement("option");
        o.value = k;
        o.textContent = k;
        ks.appendChild(o);
      }
      ks.value = sharedKind ?? "";
      ks.addEventListener("change", () => {
        if (!ks.value) return;
        beginAction();
        for (const m of leads) m.kind = ks.value as BodyKind;
        markDirty();
        // Which fields apply depends on the kind (force magnitude, friction), so
        // the panel has to be rebuilt rather than just revalued.
        rebuildInspector();
      });
      kw.appendChild(ks);
      g.appendChild(kw);
      if (!leads.some(frictionless)) {
        num("friction", (b) => b.friction, (b, v) => (b.friction = Math.min(1, Math.max(0, v))), 0.1);
        addBounceFields(g, num, leads);
      }
      if (leads.every((b) => b.kind === "force")) {
        // Acceleration along rot°, authored in px/s² like every other length.
        // Negative reverses the flow, so it is deliberately not clamped at 0.
        num("force", (b) => b.force * M2PX, (b, v) => (b.force = v * PX), 50);
      }
      if (leads.every((b) => b.kind === "water")) {
        // The current's SPEED along rot°, in px/s - a length per second, so it
        // converts like every other length, and signed for the same reason the
        // force does.
        num("flow", (b) => b.flow * M2PX, (b, v) => (b.flow = v * PX), 25);
        // ...and the rate it takes hold at, in 1/s. NOT a length: it is a
        // reciprocal time, so it is authored and stored as the same number.
        num("drag", (b) => b.drag, (b, v) => (b.drag = Math.max(0, v)), 0.5);
      }
      // Offered for the kinds that build a BODY: an area is a region the sim
      // walks through already, so "the hook is the only thing that finds it"
      // says nothing about one.
      if (leads.every((b) => b.kind === "static" || b.kind === "rigid")) {
        addPassableField(g, leads);
      }
      if (leads.every((b) => b.kind === "rigid")) {
        addPivotField(g, leads);
        addSpringFields(g, leads);
      }
    }
    // ...and the fill, which only a body written from a collision lead has: a
    // body of pure decoration is painted by its objects' own colours, and a
    // body that is nothing but a light is not painted at all.
    if (leads.length) addFillFields(g, num, leads, () => syncEditedBodies(leads));
  }

  // THE BODY panel: a container with a transform and the properties a body has
  // exactly one of. Deliberately narrow - everything it does NOT offer is a
  // thing that belongs to a scene object, and offering it here is what made a
  // body and its one object look like the same thing.
  function buildBodyPanel(id: number): void {
    const members = bodyMembers(model.items, id);
    if (!members.length) return;
    const index = bodyIndexOf(id);
    const g = el("div", "ed-group");
    g.appendChild(heading(`Body #${index} — ${bodyLabel(members)}`));

    // The transform. It is the frame every object in the body is placed from,
    // so moving it moves them: the fields write a DELTA onto the members rather
    // than a position onto a body the model does not separately store.
    // Read on every use, never captured: a frame is REPLACED rather than mutated
    // (see `translateItems`), so a reference taken when the panel was built goes
    // stale the moment the body moves.
    const origin = (): EdBodyFrame => bodyFrameOf(model, id);
    const nudgeBy = (dx: number, dy: number) => translateItems(model, members, new Vec2(dx, dy));
    numField(g, "x", () => origin().pos.x * M2PX, (v) => nudgeBy(v * PX - origin().pos.x, 0));
    numField(g, "y", () => origin().pos.y * M2PX, (v) => nudgeBy(0, v * PX - origin().pos.y));
    // No z beside them: a body's position is x and y, and depth belongs to the
    // objects that draw (see `LevelBodyData`), where the geometry panel's
    // `off z` authors it.
    // Turning a body turns everything in it about the point it is built to
    // rotate about - its centre of mass, which is where the engine puts the
    // origin (see `bodyCentroid`).
    numField(
      g,
      "rot°",
      () => deg(origin().rot),
      // About the point the built body actually turns about - its centre of
      // mass - so the editor's rotation and the engine's are the same operation.
      (v) => rotateItemsAbout(model, members, bodyCentroid(members), rad(v) - origin().rot),
    );

    addBodyProps(g, members);
    inspector.appendChild(g);

    const actions = el("div", "ed-group");
    appendGroupSection(actions);
    appendActions(actions);
    inspector.appendChild(actions);

    const hint = el("div", "ed-hint");
    const kinds = members.map((m) => m.object);
    hint.textContent =
      `${members.length} object${members.length === 1 ? "" : "s"}: ` +
      `${kinds.filter((k) => k === "collision").length} collision, ` +
      `${kinds.filter((k) => k === "geometry").length} geometry, ` +
      `${kinds.filter((k) => k === "light").length} light. ` +
      "A body is the frame they are placed in and the properties they share - what each one IS lives on the object. Expand this body in the panel bottom-left and click an object to edit its shape, material or look.";
    inspector.appendChild(hint);
  }

  // SEVERAL bodies. No transform, because there is no one frame to edit - what
  // this panel is for is the operations that take a set: Merge above all, and
  // the body properties they can be given in one go.
  function buildBodiesPanel(ids: number[]): void {
    const members = ids.flatMap((id) => bodyMembers(model.items, id));
    const g = el("div", "ed-group");
    g.appendChild(heading(`${ids.length} bodies selected`));
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Shift or Ctrl+click a body row to add or remove one. Merge puts every object in these bodies into a single body; edits below apply to all of them.";
    g.appendChild(hint);
    addBodyProps(g, members);
    inspector.appendChild(g);

    const actions = el("div", "ed-group");
    appendGroupSection(actions);
    appendActions(actions);
    inspector.appendChild(actions);
  }

  // Chain panel. A chain has no placement of its own - both ends are points on
  // bodies - so the panel is what it holds, how long it is, and its colour.
  function buildChainGroup(chains: EdChain[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(chains.length === 1 ? `Chain #${chains[0]!.id}` : `${chains.length} chains selected`),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Strung between two bodies and solved every frame: a rigid body on either end hangs and swings from it, a static one just holds. Drag an end handle to move or re-anchor it.";
    g.appendChild(hint);

    const planeHint = el("div", "ed-hint");
    planeHint.textContent =
      "Scenery: drawn behind the level, and solved against nothing but its own two bodies, so it passes through the geometry, the player and the hook.";
    g.appendChild(planeHint);

    // Slack is what a chain is for, so the length is authored in scene pixels
    // like every other length. Blank = exactly taut between the two anchors,
    // re-derived on load, which is what dragging one out gives.
    numField(
      g,
      "length",
      () => {
        const first = chains[0]!.length;
        return chains.every((c) => c.length === first) ? (first ?? NaN) * M2PX : null;
      },
      (v) => {
        for (const c of chains) c.length = Math.max(0, v * PX);
      },
      10,
      chains.length > 1,
      {
        placeholder: "taut",
        onEmpty: () => {
          for (const c of chains) c.length = null;
        },
      },
    );

    // A "slack" readout: how much longer than the straight gap the chain is, so
    // the number above can be set by eye against the drape it produces.
    const slack = (): string => {
      const c = chains[0]!;
      const ends = chainEnds(model, c);
      if (!ends || chains.length > 1) return "-";
      const straight = ends.a.distanceTo(ends.b);
      const len = c.length ?? straight;
      return `${Math.round((len - straight) * M2PX)} px`;
    };
    const srow = el("label", "ed-field");
    srow.textContent = "slack";
    const sval = document.createElement("span");
    sval.textContent = slack();
    srow.appendChild(sval);
    g.appendChild(srow);
    readouts.push({ el: sval, get: slack });

    const cw = el("label", "ed-field");
    cw.textContent = "color";
    const ci = document.createElement("input");
    ci.type = "color";
    ci.className = "ed-color";
    ci.value = chains[0]!.color ?? CHAIN_DEFAULT_COLOR;
    ci.addEventListener("focus", () => beginAction());
    ci.addEventListener("input", () => {
      for (const c of chains) c.color = ci.value;
      markDirty();
    });
    cw.appendChild(ci);
    g.appendChild(cw);

    const row = el("div", "ed-row");
    row.append(
      button("Reset color", () => {
        beginAction();
        for (const c of chains) c.color = null;
        markDirty();
        rebuildInspector();
      }),
      button("Delete", () => deleteSelected()),
    );
    g.appendChild(row);
    inspector.appendChild(g);
  }

  // Vine panel. A vine has no placement of its own either - its one point is on
  // a body - so the panel is how long it is, how finely it is made, and its
  // colour.
  function buildVineGroup(vines: EdVine[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(vines.length === 1 ? `Vine #${vines[0]!.id}` : `${vines.length} vines selected`),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Hangs from one anchor, free at the bottom - or spans between two. The player passes straight through it and the hook grabs it anywhere along its length; it drapes over whatever it lands on. Drag the top handle to move it - along the body it hangs from, or onto another one - and the end handle to set how long it is. SHIFT-drag the end handle onto a body to attach it there and make the vine a span (length stays its own, so a span longer than the gap sags); Shift-drop a span's end over empty space to detach it again. Density is kilograms per metre of cord: it sets how the vine answers a hooked player and what it leans on what it hangs from, not how it falls. Stiffness is how hard it is to bend - 0 is a rope, 1 a pole that holds itself straight and springs back to hanging. With stiffness, an ANGLE makes it a springy branch: held out along that direction, drooping under weight and springing back - lower the damping and the recoil can throw a swinging player. On a span the ends are pinned, the angle is ignored and stiffness presses the drape toward straight: 0 rests in the catenary, 1 reads as a taut wire.";
    g.appendChild(hint);

    numField(
      g,
      "length",
      () => {
        const first = vines[0]!.length;
        return vines.every((v) => v.length === first) ? first * M2PX : null;
      },
      (v) => {
        for (const vine of vines) vine.length = Math.max(MIN_VINE_LENGTH, v * PX);
      },
      10,
      vines.length > 1,
    );

    // Spacing is a COST decision as much as a look (see `DEFAULT_VINE_SPACING`),
    // so it is authorable and blank means the builder's own default rather than
    // a number this panel would have to keep in step with it.
    numField(
      g,
      "spacing",
      () => {
        const first = vines[0]!.spacing;
        return vines.every((v) => v.spacing === first) ? (first ?? NaN) * M2PX : null;
      },
      (v) => {
        for (const vine of vines) vine.spacing = Math.max(PX, v * PX);
      },
      1,
      vines.length > 1,
      {
        placeholder: "default",
        onEmpty: () => {
          for (const vine of vines) vine.spacing = null;
        },
      },
    );

    // The builder's own (length, gap) for a vine, so the readouts below use
    // exactly the spacing rule `buildVines` will (see `vineTargetSpacing`): a
    // span's arc is clamped to its gap, and a near-taut span keeps the flat
    // spacing where a slack one widens with length.
    const vineSpacingArgs = (v: EdVine): [number, number | null] => {
      const a = vineAnchorWorld(model, v);
      const b = vineAnchor2World(model, v);
      const gap = a && b ? a.distanceTo(b) : null;
      return [gap === null ? v.length : Math.max(v.length, gap), gap];
    };

    // How many links that works out to, which is the number the cost is in.
    // The same fit `buildVines` makes: segments between constraint points, of
    // which a span spends one on its second anchor.
    const links = (): string => {
      const v = vines[0]!;
      if (vines.length > 1) return "-";
      const spacing = v.spacing ?? vineTargetSpacing(...vineSpacingArgs(v));
      const length = vineSpacingArgs(v)[0];
      const segments = Math.max(v.anchor2 !== null ? 2 : 1, Math.ceil(length / spacing));
      return `${v.anchor2 !== null ? segments - 1 : segments}`;
    };
    const lrow = el("label", "ed-field");
    lrow.textContent = "links";
    const lval = document.createElement("span");
    lval.textContent = links();
    lrow.appendChild(lval);
    g.appendChild(lrow);
    readouts.push({ el: lval, get: links });

    // A span's slack: how much longer the vine is than the straight gap between
    // its anchors, which is what its sag is made of. "taut" at or under zero.
    const slack = (): string => {
      const v = vines[0]!;
      if (vines.length > 1 || v.anchor2 === null) return "-";
      const a = vineAnchorWorld(model, v);
      const b = vineAnchor2World(model, v);
      if (!a || !b) return "-";
      const s = v.length - a.distanceTo(b);
      return s > 0 ? `${(s * M2PX).toFixed(0)}` : "taut";
    };
    if (vines.length === 1 && vines[0]!.anchor2 !== null) {
      const srow = el("label", "ed-field");
      srow.textContent = "slack";
      const sval = document.createElement("span");
      sval.textContent = slack();
      srow.appendChild(sval);
      g.appendChild(srow);
      readouts.push({ el: sval, get: slack });
    }

    // Weight, in kilograms per metre of cord rather than per vine, so it stays
    // put when the end handle is dragged. Blank is the builder's default, the
    // same as spacing.
    //
    // It is NOT scaled by `M2PX` on the way in or out: every other number in
    // this panel is a length the file keeps in pixels, and this one is already
    // per metre (see `VineData.density`).
    numField(
      g,
      "density",
      () => {
        const first = vines[0]!.density;
        return vines.every((v) => v.density === first) ? (first ?? NaN) : null;
      },
      (v) => {
        for (const vine of vines) vine.density = Math.max(MIN_VINE_DENSITY, v);
      },
      1,
      vines.length > 1,
      {
        placeholder: `${DEFAULT_VINE_DENSITY}`,
        onEmpty: () => {
          for (const vine of vines) vine.density = null;
        },
      },
    );

    // What that weighs, whole and per link - the second is the number that
    // matters, because what a hooked player does to a vine is set by the ratio
    // between the player and ONE link (see `DEFAULT_VINE_DENSITY`).
    const linkMass = (v: EdVine): number => {
      const [length, gap] = vineSpacingArgs(v);
      const count = Math.max(1, Math.ceil(length / (v.spacing ?? vineTargetSpacing(length, gap))));
      return ((v.density ?? DEFAULT_VINE_DENSITY) * length) / count;
    };
    // Two rows rather than one, because the panel is 230 px wide and a row is
    // `white-space: nowrap`: "9.0 kg (0.45 per link)" beside its label ran off
    // the edge of the inspector.
    const readout = (label: string, get: () => string): void => {
      const row = el("label", "ed-field");
      row.textContent = label;
      const val = document.createElement("span");
      val.textContent = get();
      row.appendChild(val);
      g.appendChild(row);
      readouts.push({ el: val, get });
    };
    readout("weight", () =>
      vines.length > 1
        ? "-"
        : `${((vines[0]!.density ?? DEFAULT_VINE_DENSITY) * vines[0]!.length).toFixed(1)} kg`,
    );
    // The per-link number is the one that decides how the vine answers a hooked
    // player, so it is shown rather than left to be divided out.
    readout("per link", () =>
      vines.length > 1 ? "-" : `${linkMass(vines[0]!).toFixed(2)} kg`,
    );

    // Below the convergence knee the panel says so, because nothing else will:
    // a light vine looks right until a player hangs on it, and then the load
    // rope loses the mass split and the thing reads as a bungee. Measured on a
    // 3 m vine with a player swinging on the middle of it - 3.75 kg a link is
    // 0 mm of stretch, 1.2 kg is 23 mm, 0.3 kg is 622 mm and costs four times
    // as much to solve (see `DEFAULT_VINE_DENSITY`).
    const light = (): string =>
      vines.length === 1 && linkMass(vines[0]!) < LIGHT_LINK_MASS
        ? "Light: a link this size stretches under a hooked player."
        : "";
    const warn = el("div", "ed-hint ed-warn");
    warn.textContent = light();
    g.appendChild(warn);
    readouts.push({ el: warn, get: light });

    // How hard it is to BEND, 0..1 - the one thing on this panel that is not a
    // length, a weight or a colour (see `level/vineBend.ts`). Blank is the
    // builder's default, and blank is a real third state rather than a spelling
    // of zero: a vine that never asked for stiffness builds no bend constraints
    // at all, so it costs what a vine always cost and replays as one.
    numField(
      g,
      "stiffness",
      () => {
        const first = vines[0]!.stiffness;
        return vines.every((v) => v.stiffness === first) ? (first ?? NaN) : null;
      },
      (v) => {
        for (const vine of vines) vine.stiffness = Math.min(1, Math.max(0, v));
      },
      0.05,
      vines.length > 1,
      {
        placeholder: `${DEFAULT_VINE_STIFFNESS}`,
        onEmpty: () => {
          for (const vine of vines) vine.stiffness = null;
        },
      },
    );

    // The direction a stiff vine is held out along - what makes it a BRANCH.
    // Degrees on screen, radians in the file, like every other angle here;
    // blank is straight down, and the field only means anything with stiffness
    // behind it and no second anchor (the builder's own gate, see
    // `VineData.angle`).
    numField(
      g,
      "angle °",
      () => {
        const first = vines[0]!.angle;
        return vines.every((v) => v.angle === first)
          ? first !== null
            ? (first * 180) / Math.PI
            : NaN
          : null;
      },
      (v) => {
        for (const vine of vines) vine.angle = (v * Math.PI) / 180;
      },
      15,
      vines.length > 1,
      {
        placeholder: "down",
        onEmpty: () => {
          for (const vine of vines) vine.angle = null;
        },
      },
    );

    // Velocity lost per frame, 0..1. Blank is the vine default (2% a frame);
    // a branch wants far less, or its spring-back is eaten before it can
    // throw anyone (see `VineData.damping`).
    numField(
      g,
      "damping",
      () => {
        const first = vines[0]!.damping;
        return vines.every((v) => v.damping === first) ? (first ?? NaN) : null;
      },
      (v) => {
        for (const vine of vines) vine.damping = Math.min(1, Math.max(0, v));
      },
      0.005,
      vines.length > 1,
      {
        placeholder: `${DEFAULT_VINE_DAMPING}`,
        onEmpty: () => {
          for (const vine of vines) vine.damping = null;
        },
      },
    );

    // What that number reads as in the game, because 0.75 says nothing on its
    // own and the thing it stands for is a bending rigidity nobody can picture.
    // The bands are the measured ones (see `BEND_EI_POLE`).
    readout("bends like", () => {
      if (vines.length > 1) return "-";
      const s = vines[0]!.stiffness ?? DEFAULT_VINE_STIFFNESS;
      if (s < 0.2) return "a rope";
      if (s < 0.4) return "a heavy cord";
      if (s < 0.65) return "a springy branch";
      if (s < 0.85) return "a sapling";
      return "a pole";
    });

    const cw = el("label", "ed-field");
    cw.textContent = "color";
    const ci = document.createElement("input");
    ci.type = "color";
    ci.className = "ed-color";
    ci.value = vines[0]!.color ?? VINE_DEFAULT_COLOR;
    ci.addEventListener("focus", () => beginAction());
    ci.addEventListener("input", () => {
      for (const v of vines) v.color = ci.value;
      markDirty();
    });
    cw.appendChild(ci);
    g.appendChild(cw);

    const row = el("div", "ed-row");
    row.append(
      button("Reset color", () => {
        beginAction();
        for (const v of vines) v.color = null;
        markDirty();
        rebuildInspector();
      }),
      button("Delete", () => deleteSelected()),
    );
    g.appendChild(row);
    inspector.appendChild(g);
  }

  // Camera-layer panel. Same shape as the body panel — group-wide edits, blank
  // for a value the group disagrees on — over the region's framing properties.
  function buildCameraGroup(regions: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(
        regions.length === 1 ? `Camera region #${regions[0]!.id}` : `${regions.length} regions selected`,
      ),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "While the avatar is inside, the camera offsets, rescales the viewport, or pins to a locked axis. Every change eases in.";
    g.appendChild(hint);

    const num = groupNum(g, regions);
    addTransformFields(g, num, regions);

    num("off x", (b) => b.cam.offset.x * M2PX, (b, v) => (b.cam.offset = b.cam.offset.withX(v * PX)), 10);
    num("off y", (b) => b.cam.offset.y * M2PX, (b, v) => (b.cam.offset = b.cam.offset.withY(v * PX)), 10);
    // How much world is on screen: 2 = twice as much (zoomed out).
    num(
      "view ×",
      (b) => b.cam.viewportScale,
      (b, v) => (b.cam.viewportScale = Math.min(10, Math.max(0.1, v))),
      0.1,
    );

    // A locked axis pins the camera at a world coordinate and ignores that
    // axis's offset; the checkbox seeds the lock from the region's own centre,
    // which is the sane starting point for "frame this room".
    const lockField = (label: string, axis: "lockX" | "lockY", centre: (b: EdItem) => number): void => {
      const box = document.createElement("input");
      box.type = "checkbox";
      const locked = regions.map((b) => b.cam[axis] !== null);
      box.checked = locked.every(Boolean);
      box.indeterminate = !box.checked && locked.some(Boolean);
      box.addEventListener("change", () => {
        beginAction();
        for (const b of regions) b.cam[axis] = box.checked ? centre(b) : null;
        markDirty();
        rebuildInspector(); // enables/disables the value field
      });
      numField(
        g,
        label,
        // An unlocked axis has no value: NaN never equals itself, so `shared`
        // reports it as "no agreed value" and the field shows blank.
        () => shared(regions, (b) => (b.cam[axis] ?? NaN) * M2PX),
        (v) => {
          for (const b of regions) b.cam[axis] = v * PX;
        },
        10,
        regions.length > 1,
        { disabled: !box.checked, placeholder: box.checked ? "mixed" : "follow", prefix: box },
      );
    };
    lockField("lock x", "lockX", (b) => b.pos.x);
    lockField("lock y", "lockY", (b) => b.pos.y);

    // Blank = the controller's default cross-fade (CAMERA_BLEND_TIME).
    num(
      "blend s",
      (b) => b.cam.blend ?? NaN,
      (b, v) => (b.cam.blend = Math.max(0, v)),
      0.1,
      {
        placeholder: String(CAMERA_BLEND_TIME),
        onEmpty: () => {
          for (const b of regions) b.cam.blend = null;
        },
      },
    );
    // How far outside the region the avatar may travel before it gives the
    // camera up. Blank = the controller's jitter margin (REGION_EXIT_MARGIN),
    // which is what every region authored before this field had.
    num(
      "buffer",
      (b) => (b.cam.buffer ?? NaN) * M2PX,
      (b, v) => (b.cam.buffer = Math.max(0, v * PX)),
      10,
      {
        placeholder: String(Math.round(REGION_EXIT_MARGIN * M2PX)),
        onEmpty: () => {
          for (const b of regions) b.cam.buffer = null;
        },
      },
    );
    // Per-side overrides of that, for rects only: a circle has no sides and a
    // polygon grows as a signed-distance offset, so neither can express them
    // (see `pathOutlineGrown`) and offering the fields there would be four
    // controls that do nothing. Sides are the region's own - a rotated region's
    // "top" turns with it - and blank means the buffer above.
    if (regions.every((b) => b.shape.kind === "rect")) {
      const sideField = (
        label: string,
        key: "bufferLeft" | "bufferRight" | "bufferTop" | "bufferBottom",
      ): void => {
        num(
          label,
          (b) => (b.cam[key] ?? NaN) * M2PX,
          (b, v) => (b.cam[key] = Math.max(0, v * PX)),
          10,
          {
            placeholder: "buffer",
            onEmpty: () => {
              for (const b of regions) b.cam[key] = null;
            },
          },
        );
      };
      sideField("buf left", "bufferLeft");
      sideField("buf right", "bufferRight");
      sideField("buf top", "bufferTop");
      sideField("buf bottom", "bufferBottom");
    }
    num("priority", (b) => b.cam.priority, (b, v) => (b.cam.priority = Math.round(v)), 1);

    addActionsRow(g);
    inspector.appendChild(g);
  }

  // Camera-path panel. `range` and `lookahead` are what an author actually
  // tunes, so they come first and in that order: how far off the route the
  // player may be while the camera still narrates it, and how far ahead of them
  // the screen sits.
  //
  // There is deliberately no offset, no lock and no per-side buffer. A path IS
  // the position rule, so composing it with an offset or a lock reintroduces
  // exactly the ambiguity regions already cover; and a corridor has no sides to
  // hang four buffers on.
  function buildCameraPathGroup(paths: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(paths.length === 1 ? `Camera path #${paths[0]!.id}` : `${paths.length} paths selected`),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "The route the camera rides, in the direction it was drawn. The player is projected onto it and the camera targets a point further ALONG it, so the screen leads them the way the level wants them to go - even when they backtrack. `lead x`/`lead y` are how far ahead, per axis, because the frame is 16:9; `lead buf x`/`lead buf y` are slack in where that lead is measured FROM, so a swing running back and forth along the route does not slosh the camera. `range x`/`range y` are the corridor, per axis for the same reason - the pair is an ellipse around the route, so the corridor is screen-shaped. Stray past it and the path's grip fades over `falloff x`/`falloff y`, then lets go, handing the camera to whatever region contains them (or to the plain follow); coming back takes it again. Both hand-offs are blended. Drag a node to move it, its round grips to shape the curve through it, an edge midpoint to insert one, Alt+click a node to remove it; click a node to pick it out (Shift adds, a rubber band from empty space catches several, Esc drops them), and Delete removes the picked nodes while the arrows nudge them.";
    g.appendChild(hint);

    const num = groupNum(g, paths);
    addTransformFields(g, num, paths);

    // Every per-axis pair below is two numbers for the one reason: the frame is
    // 16:9, so there is far less screen above and below the player than there
    // is either side of them. Each pair is read as the semi-axes of an ellipse -
    // the range and falloff around the route (so the corridor is
    // screen-shaped), the lead and its slack along it (see `pathLookahead`).
    // Blank = the format's default, which is what every path authored before a
    // number was typed into it has.
    const axisField = (
      label: string,
      key: "rangeX" | "rangeY" | "falloffX" | "falloffY" | "lookaheadX" | "lookaheadY" | "lookaheadBufferX" | "lookaheadBufferY",
      fallback: number,
    ): void => {
      num(label, (b) => (b.cam[key] ?? NaN) * M2PX, (b, v) => (b.cam[key] = Math.max(0, v * PX)), 10, {
        placeholder: String(Math.round(fallback * M2PX)),
        onEmpty: () => {
          for (const b of paths) b.cam[key] = null;
        },
      });
    };
    // How far off the route the player may be while the path still narrates it.
    axisField("range x", "rangeX", DEFAULT_PATH_RANGE_X);
    axisField("range y", "rangeY", DEFAULT_PATH_RANGE_Y);
    // How far past the range the path lets go GRADUALLY. Through this band the
    // camera's target fades from the path's (lookahead and all) to the plain
    // follow, so by the band's outer edge the release moves the camera by
    // nothing: leaving the route reads as the camera loosening its grip rather
    // than swapping what it frames.
    axisField("falloff x", "falloffX", DEFAULT_PATH_FALLOFF_X);
    axisField("falloff y", "falloffY", DEFAULT_PATH_FALLOFF_Y);
    axisField("lead x", "lookaheadX", DEFAULT_PATH_LOOKAHEAD_X);
    axisField("lead y", "lookaheadY", DEFAULT_PATH_LOOKAHEAD_Y);
    // Slack in where the lead is measured FROM, not in the lead itself: a swing
    // runs the player forward and back along the route several times a second,
    // and a camera that tracks that exactly sloshes with it. Wider than the
    // swing's travel along the path and the camera does not move at all.
    axisField("lead buf x", "lookaheadBufferX", DEFAULT_PATH_LOOKAHEAD_BUFFER_X);
    axisField("lead buf y", "lookaheadBufferY", DEFAULT_PATH_LOOKAHEAD_BUFFER_Y);
    // How much world is on screen: 2 = twice as much (zoomed out).
    num(
      "view ×",
      (b) => b.cam.viewportScale,
      (b, v) => (b.cam.viewportScale = Math.min(10, Math.max(0.1, v))),
      0.1,
    );
    num(
      "blend s",
      (b) => b.cam.blend ?? NaN,
      (b, v) => (b.cam.blend = Math.max(0, v)),
      0.1,
      {
        placeholder: String(CAMERA_BLEND_TIME),
        onEmpty: () => {
          for (const b of paths) b.cam.blend = null;
        },
      },
    );
    // Extra hysteresis outside `range` before the path lets go, on top of the
    // corridor itself. Blank = the controller's jitter margin, which is the same
    // default a region's buffer falls back to.
    num(
      "buffer",
      (b) => (b.cam.buffer ?? NaN) * M2PX,
      (b, v) => (b.cam.buffer = Math.max(0, v * PX)),
      10,
      {
        placeholder: String(Math.round(REGION_EXIT_MARGIN * M2PX)),
        onEmpty: () => {
          for (const b of paths) b.cam.buffer = null;
        },
      },
    );
    num("priority", (b) => b.cam.priority, (b, v) => (b.cam.priority = Math.round(v)), 1);

    // Three whole-path actions, because each is miserable to do node by node.
    const row = el("div", "ed-row");
    const act = (label: string, title: string, apply: (b: EdItem) => void): void => {
      const b = button(label, () => {
        beginAction();
        for (const p of paths) apply(p);
        // Reverse renumbers the nodes, so a picked set would name different ones
        // after it; the other two are safe and it goes anyway, a whole-path
        // action being a statement about the path rather than about a corner.
        selectedVerts.clear();
        markDirty();
        rebuildInspector();
      });
      b.title = title;
      row.appendChild(b);
    };
    // Direction is meaning, and re-drawing a long path backwards is miserable.
    act(
      "Reverse",
      "Reverse the direction of travel - the way the camera leads along this path",
      (b) => void reversePathVerts(b),
    );
    act(
      "Smooth",
      "Round every corner: each node gets the tangent that carries the curve through it (drag a node's round grips to shape one by hand)",
      (b) => void smoothPathNodes(b),
    );
    act("Sharpen", "Drop every tangent - the path is its corners again", (b) =>
      void sharpenPathNodes(b),
    );
    g.appendChild(row);

    addActionsRow(g);
    inspector.appendChild(g);
  }

  // Lights-layer panel. The two fields that matter most are at the top and in
  // this order on purpose: what KIND of source it is, and how far it REACHES.
  // Falloff is inverse-square, so past a couple of metres a brighter lamp is
  // barely a wider pool - the reach is what says where the lit part of the level
  // ends, and therefore what does the framing.
  function buildLightsGroup(lights: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(lights.length === 1 ? `Light #${lights[0]!.id}` : `${lights.length} lights selected`),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Lights the 3D scene from inside the level, with no visible source of its own - a shaft down a grate, a fill, a spot, or the one light that has to cast a shadow. A lamp the player can SEE is a shape carrying an emissive on the geometry layer, which throws its own light and cannot drift away from it. Set the level's sun intensity to 0 (and env intensity near 0) for an interior.";
    g.appendChild(hint);

    const kindSel = document.createElement("select");
    kindSel.className = "ed-select";
    for (const k of ["point", "spot"] as const) {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      kindSel.appendChild(o);
    }
    const kinds = new Set(lights.map((b) => b.light.kind));
    kindSel.value = kinds.size === 1 ? lights[0]!.light.kind : "point";
    kindSel.title = "point throws in every direction; spot is a cone (a shaft through a grate)";
    kindSel.addEventListener("change", () => {
      beginAction();
      for (const b of lights) b.light.kind = kindSel.value as "point" | "spot";
      markDirty();
      rebuildInspector(); // the cone fields appear or go
    });
    g.appendChild(labelWrap("kind", kindSel));

    const num = groupNum(g, lights);
    addTransformFields(g, num, lights); // x, y and the reach (labelled "range")
    addColorField(g, lights, "color");
    // Candela against METRES, and the one number here that is not converted on
    // the way to disk - see `LightData`.
    num("intensity", (b) => b.light.intensity, (b, v) => (b.light.intensity = Math.max(0, v)), 1);
    // How far off the gameplay plane it sits. A body's extrusion is centred on
    // the plane, so a lamp at 0 is inside the wall it is mounted on.
    num("z", (b) => b.light.z * M2PX, (b, v) => (b.light.z = v * PX), 10);
    num(
      "flicker",
      (b) => b.light.flicker,
      (b, v) => (b.light.flicker = Math.min(1, Math.max(0, v))),
      0.1,
    );

    if (lights.every((b) => b.light.kind === "spot")) {
      num("cone°", (b) => b.light.angle, (b, v) => (b.light.angle = Math.min(89, Math.max(1, v))), 5);
      num(
        "penumbra",
        (b) => b.light.penumbra,
        (b, v) => (b.light.penumbra = Math.min(1, Math.max(0, v))),
        0.1,
      );
      // The aim, in the sim's own frame: +x right, +y DOWN, +z toward the
      // camera. Not normalised - only the direction is read - so an author can
      // type whole numbers.
      num("aim x", (b) => b.light.dir.x, (b, v) => (b.light.dir = b.light.dir.withX(v)), 0.1);
      num("aim y", (b) => b.light.dir.y, (b, v) => (b.light.dir = b.light.dir.withY(v)), 0.1);
      num("aim z", (b) => b.light.dirZ, (b, v) => (b.light.dirZ = v), 0.1);
    }

    // Opt-in, and capped: a point light's shadow is a cube map, six renders of
    // the scene, so the first LIGHT_SHADOW_BUDGET that ask are the ones honoured
    // and the rest still light without occluding.
    const shadowBox = document.createElement("input");
    shadowBox.type = "checkbox";
    const casting = lights.map((b) => b.light.castShadow);
    shadowBox.checked = casting.every(Boolean);
    shadowBox.indeterminate = !shadowBox.checked && casting.some(Boolean);
    shadowBox.addEventListener("change", () => {
      beginAction();
      for (const b of lights) b.light.castShadow = shadowBox.checked;
      markDirty();
      rebuildInspector();
    });
    const sw = el("label", "ed-field");
    sw.textContent = "shadows";
    sw.appendChild(shadowBox);
    g.appendChild(sw);
    if (lights.every((b) => b.light.castShadow)) {
      // The shadow camera's near plane: casters closer than this are not in the
      // map. Author it past a surrounding fitting's radius so a lantern casts
      // nothing from its own light (see `LightObjectData.shadowNear`); blank is
      // the renderer's default, sized for a lamp mounted clear of its fitting.
      num(
        "shadow near",
        (b) => (b.light.shadowNear ?? NaN) * M2PX,
        (b, v) => (b.light.shadowNear = Math.max(0, v * PX)),
        10,
        {
          placeholder: "default",
          onEmpty: () => {
            for (const b of lights) b.light.shadowNear = null;
          },
        },
      );
    }
    const budget = model.items.filter(
      (b) => b.object === "light" && b.light.castShadow,
    ).length;
    if (budget > LIGHT_SHADOW_BUDGET) {
      const over = el("div", "ed-hint");
      over.textContent = `${budget} lights ask for shadows and only the first ${LIGHT_SHADOW_BUDGET} get them; the rest still light the scene.`;
      g.appendChild(over);
    }

    addActionsRow(g);
    inspector.appendChild(g);
  }

  // The live note textarea, so a freshly placed text note can be typed into
  // without a trip to the inspector. Null whenever the panel shows no single
  // text note.
  let noteText: HTMLTextAreaElement | null = null;

  // Put the caret in that textarea, at the end of whatever is already written.
  // It is scrolled into view because the inspector is a scrolling stack of
  // per-layer panels, so the note's panel need not be on screen.
  function focusNoteText(): void {
    if (!noteText) return;
    noteText.scrollIntoView({ block: "nearest" });
    noteText.focus();
    const end = noteText.value.length;
    noteText.setSelectionRange(end, end);
  }

  // Notes-layer panel. A note's whole point is its prose, so the text box leads;
  // everything below it is placement.
  // An ANCHOR: a chain's tie point on a body. It has a placement and an id and
  // nothing else, which is the whole of what the format gives it - so the panel
  // is a transform, the chains it holds, and a sentence saying what it is for.
  //
  // (Hook-only scenery used to share the word as a `BodyKind`; it is the
  // `passable` flag now, so an anchor here is only ever a chain's tie point.)
  function buildAnchorsGroup(anchors: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(
        anchors.length === 1
          ? `Anchor #${anchors[0]!.anchorId}`
          : `${anchors.length} anchors selected`,
      ),
    );
    const held = model.chains.filter((c) =>
      anchors.some((a) => c.a === a.id || c.b === a.id),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      anchors.length === 1
        ? `A chain's tie point on this body. It is an object IN the body, so it rides it: moving or turning the body moves the anchor, and the chain follows without anything being re-derived. ${held.length === 1 ? "One chain" : `${held.length} chains`} tied here.`
        : "Chain tie points. Each is an object in its body and rides it; the chains follow.";
    g.appendChild(hint);

    const num = groupNum(g, anchors);
    addTransformFields(g, num, anchors);
    // No fill, no material, no look: an anchor is a point. Its canvas mark is the
    // ring its chain already draws at it, which is also the handle that drags it.
    addGroupSection(g);
    addActionsRow(g);
    inspector.appendChild(g);
  }

  function buildNotesGroup(notes: EdItem[]): void {
    const g = el("div", "ed-group");
    g.appendChild(
      heading(notes.length === 1 ? `Note #${notes[0]!.id}` : `${notes.length} notes selected`),
    );
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Editor-only: notes record why geometry is placed as it is, so it isn't later removed as arbitrary. They never appear in play.";
    g.appendChild(hint);

    const allText = notes.every((n) => n.note.kind === "text");
    const allArrows = notes.every((n) => n.note.kind === "arrow");
    if (allText && notes.length === 1) {
      const n = notes[0]!;
      const ta = document.createElement("textarea");
      ta.className = "ed-text";
      ta.rows = 4;
      ta.value = n.note.text;
      ta.placeholder = "Why is this here?";
      // One undo step per editing session, snapshotted on the first keystroke
      // rather than on focus: placing a note focuses it, and a focus-time
      // snapshot would make the first Ctrl+Z a visible no-op.
      let edited = false;
      ta.addEventListener("blur", () => (edited = false));
      ta.addEventListener("input", () => {
        if (!edited) {
          beginAction();
          edited = true;
        }
        n.note.text = ta.value;
        markDirty();
      });
      noteText = ta;
      g.appendChild(ta);
    } else if (allText) {
      // Merging prose across a group has no sane meaning, so the text stays a
      // single-selection edit while placement stays group-wide.
      const many = el("div", "ed-hint");
      many.textContent = "Select one note to edit its text.";
      g.appendChild(many);
    }

    const num = groupNum(g, notes);
    addTransformFields(g, num, notes);
    if (allArrows) {
      num("length", (b) => (b.shape.kind === "rect" ? b.shape.w * M2PX : 0), (b, v) => {
        if (b.shape.kind === "rect") b.shape.w = Math.max(MIN_ARROW_LENGTH, v * PX);
      });
    }
    if (allText) {
      num("text px", (b) => b.note.size * M2PX, (b, v) => (b.note.size = Math.max(4, v) * PX), 1);
    }

    addActionsRow(g);
    inspector.appendChild(g);
  }

  // The level's light and air (`EnvironmentData`). Level-wide rather than
  // per-selection, so it sits with the player spawn at the top of the inspector
  // and is always shown.
  //
  // It is here mostly for one field: `sun ×` at 0 is how a level says it is
  // UNDERGROUND, and without a control for it an author dressing an interior
  // with the lights layer would have to hand-edit the file for the one decision
  // the whole layer is downstream of.
  //
  // A level with no environment block carries none until something is authored,
  // which is what keeps a file that never touches this byte-identical.
  function buildEnvironmentGroup(): void {
    const g = el("div", "ed-group");
    g.appendChild(heading("Environment"));
    const authored = model.environment !== undefined;
    const hint = el("div", "ed-hint");
    hint.textContent = authored
      ? "The sun is a light at infinity, so it reaches everything in frame equally: right outdoors, wrong underground. Drop `sun ×` and `env ×` to 0 and the level is lit only by what the lights layer puts in it."
      : "Using the renderer's own defaults (a warm sun, a cool fill). Edit any field to author a block for this level.";
    g.appendChild(hint);

    // Reads fall back to the renderer's defaults, so the fields show what the
    // level actually looks like rather than blanks; the first write is what
    // mints the block.
    type EnvKey = keyof EnvironmentData & string;
    const env = (): Record<string, unknown> =>
      (model.environment ??= {}) as Record<string, unknown>;
    const cur = (k: EnvKey): number | string =>
      (model.environment?.[k] ?? DEFAULT_ENVIRONMENT[k]) as number | string;

    const numEnv = (label: string, key: EnvKey, step: number, clamp?: (v: number) => number): void => {
      numField(
        g,
        label,
        () => cur(key) as number,
        (v) => {
          env()[key] = clamp ? clamp(v) : v;
        },
        step,
      );
    };
    const colorEnv = (label: string, key: EnvKey): void => {
      const cw = el("label", "ed-field");
      cw.textContent = label;
      const ci = document.createElement("input");
      ci.type = "color";
      ci.className = "ed-color";
      ci.value = cur(key) as string;
      ci.addEventListener("focus", () => beginAction());
      ci.addEventListener("input", () => {
        env()[key] = ci.value;
        markDirty();
      });
      cw.appendChild(ci);
      g.appendChild(cw);
    };

    const nonNeg = (v: number): number => Math.max(0, v);
    numEnv("sun ×", "sunIntensity", 0.1, nonNeg);
    colorEnv("sun col", "sunColor");
    // The direction the sunlight TRAVELS, in the sim's frame: +x right, +y down,
    // +z toward the camera. Not normalised and not a length, so it neither
    // scales nor needs to be typed to any particular magnitude.
    numEnv("sun dir x", "sunX", 0.1);
    numEnv("sun dir y", "sunY", 0.1);
    numEnv("sun dir z", "sunZ", 0.1);
    numEnv("fill ×", "fillIntensity", 0.1, nonNeg);
    colorEnv("sky col", "skyColor");
    colorEnv("ground col", "groundColor");
    // Image-based lighting contributes diffuse as well as specular, so this is
    // an ambient term as much as a reflection one: near zero is what stops an
    // interior being lit from every direction by a sky it cannot see.
    numEnv("env ×", "envIntensity", 0.05, nonNeg);

    // What that environment IS: the sky generated from the three colours above,
    // or a captured one out of `HDRI_ASSETS`. The picker is the manifest, so a
    // sky added to the store is a sky this panel offers with nothing here to
    // edit - and a key this build has no asset for is kept as an option of its
    // own rather than silently rewritten, exactly as the mesh picker does, so
    // opening a level built against a manifest this build lacks cannot lose what
    // it named.
    const sw = el("label", "ed-field");
    sw.textContent = "sky hdr";
    const ss = document.createElement("select");
    ss.className = "ed-select";
    const skies = new Set(hdriNames());
    const named = (model.environment?.hdri ?? "") as string;
    if (named) skies.add(named);
    for (const key of ["", ...[...skies].sort()]) {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = key ? (HDRI_ASSETS[key]?.label ?? key) : "(generated)";
      ss.appendChild(o);
    }
    ss.value = named;
    ss.addEventListener("change", () => {
      // Choosing the generated sky on a level that authors no block must not
      // mint one: "no environment" is a state a file is entitled to be in, and
      // opening the panel is not authoring.
      if (!ss.value && model.environment === undefined) return;
      beginAction();
      if (ss.value) env().hdri = ss.value;
      else {
        // The two fields that only mean anything against a capture go with it,
        // rather than sitting in the file describing a sky the level no longer
        // names.
        delete env().hdri;
        delete env().hdriRotation;
        delete env().hdriBackground;
      }
      markDirty();
      rebuildInspector();
    });
    sw.appendChild(ss);
    g.appendChild(sw);

    if (named) {
      // Which way round the sky is. A capture faces wherever its camera was
      // pointing and a level faces wherever it was built; this is what puts the
      // sky's own sun on the same side as the `sun dir` above, which is what
      // makes the shadow and the light agree about where the light comes from.
      numEnv("hdr °", "hdriRotation", 15);
      const bw = el("label", "ed-field");
      bw.textContent = "hdr bg";
      const bb = document.createElement("input");
      bb.type = "checkbox";
      bb.checked = model.environment?.hdriBackground === true;
      bb.title =
        "Draw the sky behind the level as well as reflecting it. A 1k capture is ample for the reflection and visibly soft as a background - re-optimise it larger before leaning on this.";
      bb.addEventListener("change", () => {
        beginAction();
        if (bb.checked) env().hdriBackground = true;
        else delete env().hdriBackground;
        markDirty();
      });
      bw.appendChild(bb);
      g.appendChild(bw);
    }

    colorEnv("background", "backgroundColor");
    // Air, thickening with distance from the camera. The number is how much of
    // it a surface 20 m away takes on (`FOG_REFERENCE_DISTANCE`, about where the
    // gameplay plane sits): 0 is none, and it is a fraction rather than a density
    // so it is neither a length nor scaled on the way to disk. Stepped in
    // twentieths, since the useful range is the bottom of it.
    numEnv("fog", "fogAmount", 0.05, (v) => Math.min(1, Math.max(0, v)));
    colorEnv("fog col", "fogColor");

    if (authored) {
      const row = el("div", "ed-row");
      const clear = button("Use defaults", () => {
        beginAction();
        model.environment = undefined;
        markDirty();
        rebuildInspector();
      });
      clear.title = "Drop this level's environment block and take the renderer's own";
      row.appendChild(clear);
      g.appendChild(row);
    }
    inspector.appendChild(g);
  }

  function rebuildInspector(): void {
    refreshOutliner();
    fields.length = 0;
    readouts.length = 0;
    noteText = null;
    inspector.innerHTML = "";

    const player = el("div", "ed-group");
    player.appendChild(heading("Player spawn"));
    numField(player, "x", () => model.player.pos.x * M2PX, (v) => (model.player.pos = model.player.pos.withX(v * PX)));
    numField(player, "y", () => model.player.pos.y * M2PX, (v) => (model.player.pos = model.player.pos.withY(v * PX)));
    numField(player, "radius", () => model.player.radius * M2PX, (v) => (model.player.radius = Math.max(1, v) * PX));
    inspector.appendChild(player);

    buildEnvironmentGroup();

    // Chains carry their own, exclusive selection (see `selectedChainIds`).
    const chains = selectedChains();
    if (chains.length) {
      buildChainGroup(chains);
      return;
    }

    // ...and so do vines.
    const vines = selectedVines();
    if (vines.length) {
      buildVineGroup(vines);
      return;
    }

    // ...and so does a BODY. What it shows is the body's own properties: its
    // transform, what it is, how it is painted, what it rubs like. There is no
    // shape here, no material and no look, because a body has none of those -
    // they belong to the objects in it, which are edited by picking one out of
    // the tree.
    if (selectedBodyIds.size) {
      const sole = soleBodyId();
      if (sole !== null) buildBodyPanel(sole);
      else buildBodiesPanel([...selectedBodyIds]);
      return;
    }

    const sel = selectedBodies();
    if (!sel.length) {
      const hint = el("div", "ed-hint");
      // A locked layer explains itself first: with nothing pickable on it, the
      // usual "click a body" hint would read as the editor being broken.
      hint.textContent = lockedLayers.has(activeLayer)
        ? `The ${activeLayer} layer is locked: it still draws, but nothing on it can be picked, drawn or edited. Use the padlock in the layer list to unlock it.`
        : EMPTY_HINTS[activeLayer];
      inspector.appendChild(hint);
      return;
    }
    // A selection may span KINDS of thing, and their properties have nothing in
    // common (a note has no kind, a camera region no fill, a light no shape), so
    // it gets one panel per kind rather than a reconciled mixed one. Panels come
    // in a fixed order, so the same selection always reads the same way down the
    // inspector.
    //
    // The key is the panel rather than the layer, because merging lights into
    // the scene layer means one layer now holds two kinds of object: a lamp and
    // its light are ONE body and a perfectly ordinary thing to select together,
    // and they still want two panels.
    // A camera PATH is its own panel and not a variant of the region one: a
    // path has no offset, no lock and no per-side buffer, and a panel showing
    // them greyed out would be saying a path might have them.
    const PANELS = [
      "collision",
      "geometry",
      "light",
      "anchor",
      "camera",
      "campath",
      "notes",
    ] as const;
    const panelOf = (b: EdItem): (typeof PANELS)[number] =>
      b.layer === "camera"
        ? b.shape.kind === "path"
          ? "campath"
          : "camera"
        : b.layer === "notes"
          ? "notes"
          : b.object;
    const panels = PANELS.filter((k) => sel.some((b) => panelOf(b) === k));
    selectionSpansLayers = panels.length > 1;
    if (selectionSpansLayers) {
      const g = el("div", "ed-group");
      g.appendChild(heading(`${sel.length} objects of ${panels.length} kinds`));
      const hint = el("div", "ed-hint");
      hint.textContent = `${panels.join(", ")} - each kind's properties are edited in its own panel below. Merge, Duplicate and Delete apply to all of them.`;
      g.appendChild(hint);
      appendGroupSection(g);
      appendActions(g);
      inspector.appendChild(g);
    }
    // No body section here. A body's properties belong to the body, and the body
    // is selected by clicking it - in the outliner or on the canvas. Showing them
    // alongside an object's is what made a collision shape look like it had a
    // kind and a friction of its own.
    for (const k of panels) {
      const items = sel.filter((b) => panelOf(b) === k);
      if (k === "camera") buildCameraGroup(items);
      else if (k === "campath") buildCameraPathGroup(items);
      else if (k === "light") buildLightsGroup(items);
      else if (k === "anchor") buildAnchorsGroup(items);
      else if (k === "notes") buildNotesGroup(items);
      else buildBodyGroup(items);
    }
  }

  // Refresh field values after a canvas drag, without disturbing a focused input.
  function refreshFields(): void {
    for (const f of fields) {
      if (document.activeElement === f.input) continue;
      f.input.value = fmtOrBlank(f.get());
    }
    for (const r of readouts) r.el.textContent = r.get();
  }

  // --- editing ops ----------------------------------------------------------
  // Detached copies of the given bodies, each with a fresh id and shifted by
  // `offset`. Shapes are mutated in place, so clone them. Group ids are remapped
  // too: a duplicated compound body is a NEW body, not a second set of pieces
  // welded into the one it was copied from. `idOf` maps old id → new, which is
  // what lets the chains between them be copied along with the bodies.
  function cloneBodies(
    bodies: readonly EdItem[],
    offset: Vec2,
  ): { items: EdItem[]; idOf: Map<number, number> } {
    const groups = new Map<number, number>();
    const idOf = new Map<number, number>();
    const items = bodies.map((b) => {
      const id = newBodyId();
      idOf.set(b.id, id);
      let group = b.bodyId;
      if (group !== null) {
        let mapped = groups.get(group);
        if (mapped === undefined) {
          mapped = newBodyId();
          groups.set(group, mapped);
        }
        group = mapped;
      }
      return {
        ...b,
        id,
        // The COPY's body, not the original's. `...b` carries `bodyId` over, so
        // writing the remapped id to any other field left a duplicated wall
        // silently joining the body it was copied from.
        bodyId: group,
        pos: b.pos.add(offset),
        shape: cloneShape(b.shape),
        cam: { ...b.cam },
        light: { ...b.light },
        note: { ...b.note },
        visual: { ...b.visual },
      };
    });
    // A matched pair copied together stays a pair; a geometry object copied
    // WITHOUT its partner drops the link rather than pointing at the original,
    // which is in another body and would be pruned as stale anyway.
    for (const it of items) {
      if (it.matchId !== 0) it.matchId = idOf.get(it.matchId) ?? 0;
    }
    // A copied anchor is a NEW anchor and needs an on-disk id of its own:
    // `anchorId` is what chains and vines name their ends by in the file, so a
    // copy carrying the original's id loads with both ends resolving to
    // whichever body the loader finds first.
    let nextAnchorId = newAnchorId();
    for (const it of items) {
      if (it.object === "anchor") it.anchorId = nextAnchorId++;
    }
    return { items, idOf };
  }

  // Copies of the chains whose BOTH ends landed in the copied set. A chain with
  // one end outside it would be a chain to a body that is not there, so it is
  // left behind rather than silently re-pointed at the original.
  function cloneChainsWithin(
    chains: readonly EdChain[],
    idOf: ReadonlyMap<number, number>,
  ): EdChain[] {
    const out: EdChain[] = [];
    for (const c of chains) {
      const a = idOf.get(c.a);
      const b = idOf.get(c.b);
      if (a === undefined || b === undefined) continue;
      out.push({ ...cloneChain(c), id: newBodyId(), a, b });
    }
    return out;
  }

  // The vines whose anchor is among the copied items, re-pointed at the copies.
  // A vine whose anchor was not copied is left behind rather than pointed at the
  // original, which would give one anchor two vines nobody authored.
  function cloneVinesWithin(
    vines: readonly EdVine[],
    idOf: ReadonlyMap<number, number>,
  ): EdVine[] {
    const out: EdVine[] = [];
    for (const v of vines) {
      const anchor = idOf.get(v.anchor);
      if (anchor === undefined) continue;
      // A span's second anchor is re-pointed the same way. One whose second
      // anchor was NOT copied falls back to hanging rather than staying bolted
      // to the original's anchor, which nobody authored.
      const anchor2 = v.anchor2 !== null ? (idOf.get(v.anchor2) ?? null) : null;
      out.push({ ...cloneVine(v), id: newBodyId(), anchor, anchor2 });
    }
    return out;
  }

  // Add freshly created bodies to the model and leave them selected, so the
  // group can immediately be dragged or pasted again.
  function addAndSelect(bodies: EdItem[], chains: EdChain[] = [], vines: EdVine[] = []): void {
    model.items.push(...bodies);
    model.chains.push(...chains);
    model.vines.push(...vines);
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    for (const b of bodies) selectedIds.add(b.id);
    markDirty();
    rebuildInspector();
  }

  // --- bodies ---------------------------------------------------------------
  // Move the selected objects into ONE body. They keep their placement exactly;
  // what changes is which body they are in, and that is what everything else
  // follows from - the collision objects among them build as a single engine
  // body (so the rope refuses to wrap the seams between them and ledge detection
  // refuses to grab one), decoration among them rides that body, and a light
  // among them is the lamp's light rather than a light that happens to be nearby.
  //
  // Body-level properties (kind, fill, friction, force) collapse onto the lead's,
  // since a body has only one of each.
  //
  // The bodies it acts on come from whichever selection is live: two rows picked
  // in the outliner, or objects picked on the canvas (whose WHOLE bodies move,
  // not the selected objects alone - dragging one piece of a body into another
  // and leaving its siblings behind would silently take that body apart, which
  // is a thing to do on purpose with Ctrl+Shift+G rather than a side effect of
  // merging).
  const mergeableBodies = (): number[] => {
    const ids = selectedBodyIds.size
      ? [...selectedBodyIds]
      : [...new Set(selectedBodies().map((b) => b.bodyId))];
    // A body only merges if EVERY object in it may share one. An area is
    // single-shape wherever it is used, so a merged one would silently act
    // through its first piece alone.
    return ids.filter((id) => bodyMembers(model.items, id).every(canShareBody));
  };

  function mergeIntoBody(): void {
    const ids = mergeableBodies();
    if (ids.length < 2) return;
    const id = newBodyId();
    const absorbed = new Set(ids);
    beginAction();
    for (const b of model.items) if (absorbed.has(b.bodyId)) b.bodyId = id;
    const members = bodyMembers(model.items, id);
    syncBodyProps(members);
    // The result is selected the way its ingredients were: merging two rows in
    // the tree leaves the new body selected as a BODY, so the panel is still
    // showing a body and not suddenly a heap of objects.
    if (selectedBodyIds.size) setBodySelection(id);
    else setSelection(members.map((b) => b.id));
    markDirty();
    rebuildInspector();
  }

  // Take the selected bodies apart: every object in them becomes a body of its
  // own. Nothing else changes - the objects stay exactly where they are, and
  // only stop sharing a transform, a seam rule and a set of body properties.
  function splitIntoBodies(): void {
    // Every body the selection touches, taken WHOLE: splitting half a body would
    // leave the other half claiming to be a body of two that has one object in
    // it, which is exactly the state having no null stopped being possible.
    const ids = new Set(
      selectedBodyIds.size ? selectedBodyIds : selectedBodies().map((b) => b.bodyId),
    );
    const affected = model.items.filter((i) => ids.has(i.bodyId));
    // Nothing to do when every one of them already holds a single object.
    if (affected.length === ids.size) return;
    beginAction();
    // An ANCHOR does not become a body of its own. A chain is bolted to a shape,
    // and an anchor alone in a body is tied to something that builds nothing at
    // all - the chain would simply be dropped at load. It follows the first
    // collision object out of the body it was in, which is the shape it was
    // bolted to in the first place.
    const wasIn = new Map<EdItem, number>(affected.map((b) => [b, b.bodyId]));
    const leadOf = new Map<number, number>();
    // A geometry object MATCHED to a collision sibling follows that sibling out
    // for the same reason an anchor follows a shape: the pair is one authored
    // thing (a wall and the look that mirrors it), and splitting them into two
    // bodies would break the link as a side effect of a gesture about bodies.
    const follows = (b: EdItem): boolean =>
      b.object === "geometry" && b.matchId !== 0 && affected.some((o) => o.id === b.matchId);
    const bodyOf = new Map<number, number>();
    for (const b of affected) {
      if (b.object === "anchor" || follows(b)) continue;
      const id = newBodyId();
      const old = wasIn.get(b)!;
      if (b.object === "collision" && !leadOf.has(old)) leadOf.set(old, id);
      bodyOf.set(b.id, id);
      b.bodyId = id;
    }
    for (const b of affected) {
      if (follows(b)) {
        b.bodyId = bodyOf.get(b.matchId) ?? b.bodyId;
        continue;
      }
      if (b.object !== "anchor") continue;
      b.bodyId = leadOf.get(wasIn.get(b)!) ?? b.bodyId;
    }
    // The bodies that were selected no longer exist, so the selection follows
    // the objects out - leaving it pointing at retired ids would empty the panel
    // and leave the tree highlighting nothing.
    if (selectedBodyIds.size) setSelection(affected.map((b) => b.id));
    markDirty();
    rebuildInspector();
  }

  // Keep a compound body's members in agreement after an edit to one of them.
  // Only the lead's body-level properties are built, so this is what stops a
  // file from disagreeing with what the editor draws.
  function syncEditedBodies(edited: readonly EdItem[]): void {
    const seen = new Set<number>();
    for (const b of edited) {
      if (seen.has(b.bodyId)) continue;
      seen.add(b.bodyId);
      syncBodyProps(bodyMembers(model.items, b.bodyId));
    }
  }

  // --- chains ---------------------------------------------------------------

  // The next free anchor id. Unique across the LEVEL, since that is the scope a
  // chain names its two ends in.
  function newAnchorId(): number {
    let next = 1;
    for (const i of model.items) if (i.object === "anchor" && i.anchorId >= next) next = i.anchorId + 1;
    return next;
  }

  // A fresh ANCHOR object on `host`, at a world point pushed onto that item's
  // surface. It joins the host's BODY, which is the whole point of the anchor
  // being an object: it rides the body from then on, with nothing to keep in
  // step and no re-derivation at load.
  function newAnchorOn(host: EdItem, world: Vec2): EdItem {
    return {
      ...host,
      id: newBodyId(),
      object: "anchor",
      // Snapped to the surface, because that is what bolting a chain to a body
      // means - and because an anchor in a body's interior leaves the chain's
      // span starting inside it, which the wrap generator resolves as a
      // self-intersection (see `nearestSurfaceLocal`).
      pos: toWorld(host, nearestSurfaceLocal(host, world)),
      rot: host.rot,
      shape: { kind: "rect", w: DRESSING_GIZMO, h: DRESSING_GIZMO },
      visual: defaultVisual(),
      cam: { ...host.cam },
      light: { ...host.light },
      note: { ...host.note },
      anchorId: newAnchorId(),
    };
  }

  // String a chain between two bodies, anchored where each end was placed. A
  // chain to the body you started on (or to another piece of the same compound
  // body) is a chain tied to itself and is refused.
  function addChain(from: EdItem, fromWorld: Vec2, to: EdItem, world: Vec2): void {
    if (!chainable(to)) return;
    if (to.id === from.id) return;
    if (to.bodyId === from.bodyId) return;
    beginAction();
    // One at a time, and IN THE MODEL before the next is minted: `newAnchorId`
    // reads the model to find the next free id, so minting both against the
    // model as it was gives them the SAME id. A chain then names one anchor
    // twice, `buildSceneChains` resolves both ends to the first body carrying
    // that id, and a chain whose two ends are one body is dropped at load - so
    // the thing it was holding up simply falls, in a level that looks correct
    // in the editor and carries no error anywhere.
    const a = newAnchorOn(from, fromWorld);
    model.items.push(a);
    const b = newAnchorOn(to, world);
    model.items.push(b);
    const chain: EdChain = {
      id: newBodyId(),
      a: a.id,
      b: b.id,
      length: null, // taut as drawn
      color: null,
    };
    model.chains.push(chain);
    setChainSelection([chain.id]);
    markDirty();
  }

  // Hang a vine from a body. The anchor is a real anchor object like a chain's,
  // so the vine rides its body through every move, rotate and resize with no
  // second copy of the point to keep in step.
  // `angle` null is the ordinary hanging vine; an angle makes the one-gesture
  // BRANCH - the same vine held out along the drag by an authored stiffness,
  // with the damping taken down so the spring-back survives (see
  // `BRANCH_DEFAULT_STIFFNESS`). The stiffness and damping are ordinary fields
  // after that: the panel turns a branch back into a rope, or a rope into a
  // branch, by editing them.
  function addVine(from: EdItem, local: Vec2, length: number, angle: number | null): void {
    if (!chainable(from)) return;
    if (length < MIN_VINE_LENGTH) return;
    beginAction();
    const a = newAnchorOn(from, toWorld(from, local));
    model.items.push(a);
    const vine: EdVine = {
      id: newBodyId(),
      anchor: a.id,
      anchor2: null,
      length,
      spacing: null,
      density: null,
      stiffness: angle !== null ? BRANCH_DEFAULT_STIFFNESS : null,
      angle,
      damping: angle !== null ? BRANCH_DEFAULT_DAMPING : null,
      color: null,
    };
    model.vines.push(vine);
    setVineSelection([vine.id]);
    markDirty();
  }

  // Attach a hanging vine's free end to `host`, making it a span: a new anchor
  // object on the host's surface, exactly as the vine's first anchor was made.
  // The length the vine already had becomes the span's slack; one shorter than
  // the gap it now crosses is topped up to a slight sag rather than left
  // over-taut.
  function attachVineEnd(vine: EdVine, host: EdItem, world: Vec2): void {
    if (!chainable(host) || vine.anchor2 !== null) return;
    const top = vineAnchorWorld(model, vine);
    if (!top) return;
    const a = newAnchorOn(host, world);
    model.items.push(a);
    vine.anchor2 = a.id;
    vine.length = Math.max(vine.length, a.pos.distanceTo(top) * 1.05);
    markDirty();
    refreshFields();
    rebuildInspector();
  }

  // ...and the inverse: back to a hanging vine of the same length. The anchor
  // object goes with it unless something else still ties to it.
  function detachVineEnd(vine: EdVine): void {
    if (vine.anchor2 === null) return;
    const id = vine.anchor2;
    vine.anchor2 = null;
    const used =
      model.chains.some((c) => c.a === id || c.b === id) ||
      model.vines.some((v) => v.anchor === id || v.anchor2 === id);
    if (!used) model.items = model.items.filter((i) => i.id !== id);
    markDirty();
    refreshFields();
    rebuildInspector();
  }

  // Drop chains that no longer have two anchors to hold. Called after any item
  // deletion, so a chain can never outlive what it was tied to. A vine outlives
  // its SECOND anchor - it falls back to hanging - and not its first.
  function pruneChains(): void {
    const live = new Set(model.items.filter((i) => i.object === "anchor").map((i) => i.id));
    model.chains = model.chains.filter((c) => live.has(c.a) && live.has(c.b));
    model.vines = model.vines.filter((v) => live.has(v.anchor));
    for (const v of model.vines) {
      if (v.anchor2 !== null && !live.has(v.anchor2)) v.anchor2 = null;
    }
  }

  // The shape an anchor slides along: the first collision object in its body,
  // which is what a chain is bolted to. A body with none cannot hold a chain at
  // all (`chainable`), so this is null only for a body taken apart under it.
  const anchorHost = (a: EdItem): EdItem | null =>
    bodyMembers(model.items, a.bodyId).find((m) => m.object === "collision") ?? null;

  // ...and the mirror of it: an anchor no chain names has nothing to be. They
  // are created only by stringing a chain, so one left behind is the wreckage of
  // a deleted chain rather than something an author placed and may want.
  function pruneAnchors(): void {
    const used = new Set<number>();
    for (const c of model.chains) {
      used.add(c.a);
      used.add(c.b);
    }
    for (const v of model.vines) {
      used.add(v.anchor);
      // A span's second anchor is just as used as its first - without this,
      // any deletion pruned every draped vine's far end.
      if (v.anchor2 !== null) used.add(v.anchor2);
    }
    model.items = model.items.filter((i) => i.object !== "anchor" || used.has(i.id));
  }

  // A fresh item for the draw tool, on the active layer. Every layer's item is
  // the same type, so this only picks the appearance and the starting size —
  // the drag that follows resizes it identically whatever it is.
  function newDrawnItem(t: Exclude<Tool, "select" | "chain">, start: Vec2): EdItem {
    // Which of the three scene objects the tool draws. `+ Geometry` is the only
    // way to get a drawn-and-not-simulated object in one gesture; every other
    // shape tool draws a collision object, and NOTHING is created beside it.
    const object: EdObject =
      t === "light" ? "light" : t === "geometry" ? "geometry" : "collision";
    const style = newItemStyle(activeLayer, object);
    // Drawn INTO the selected body, when one is selected. With a body selected
    // the thing being authored is a part of it - the collision box under a mesh,
    // a second shape for a compound wall, the light a lamp throws - and making it
    // a body of its own would mean drawing it, selecting both and merging, every
    // single time. An area is refused for the reason `canShareBody` gives: it is
    // single-shape wherever it is used.
    //
    // Camera regions and notes are never in a body in any meaningful sense, so
    // they keep getting one of their own.
    const host = activeLayer === "scene" ? soleBodyId() : null;
    const bodyId =
      host !== null && bodyMembers(model.items, host).every(canShareBody)
        ? host
        : newBodyId();
    const base = {
      id: newBodyId(),
      layer: activeLayer,
      object,
      // The selected body, or one of its own when nothing is selected. Ctrl+G
      // moves it later, which is a decision rather than something a draw has an
      // opinion about.
      bodyId,
      pos: start,
      rot: 0,
      kind: newKind,
      color: style.color,
      opacity: style.opacity,
      friction: DEFAULT_SURFACE_FRICTION,
      // ...and a fresh shape is a dead one: bounce is opt-in, exactly as
      // hook-proofing below is.
      bounce: DEFAULT_BOUNCE,
      launch: DEFAULT_LAUNCH,
      // Hook-proof is opt-in: a fresh shape is one the hook can catch.
      impermeable: false,
      // A fresh shape is 20 cm of oak, which is what every body authored before
      // materials existed is made of.
      material: DEFAULT_MATERIAL,
      thickness: DEFAULT_THICKNESS,
      // A fresh shape is drawn as its own outline extruded, which is what every
      // body authored before the 3D renderer existed is drawn as.
      visual: defaultVisual(),
      // Only meaningful on a force area, but a new one needs a non-zero pull
      // or it would draw no arrows and do nothing until the field is touched.
      force: DEFAULT_FORCE_MAGNITUDE * PX,
      // Likewise only meaningful on a water area, and likewise non-zero so a
      // fresh one runs and drags rather than sitting there as a coloured box.
      flow: DEFAULT_WATER_FLOW * PX,
      drag: DEFAULT_WATER_DRAG,
      // A fresh body is free; the bearing and the spring are both opted into on
      // the panel, and a spring of no frequency is no spring at all.
      // Hook-only is opt-in: a fresh body is one that collides.
      passable: false,
      pivot: false,
      pivotAt: null,
      pivotFreq: 0,
      pivotDamping: DEFAULT_SPRING_DAMPING,
      springFreqX: 0,
      springFreqY: 0,
      springDamping: DEFAULT_SPRING_DAMPING,
      // A fresh region is a no-op until a framing field is authored.
      cam: defaultCamera(),
      light: defaultLight(),
      note: defaultNote(),
      anchorId: 0,
      matchId: 0,
    };
    if (t === "light") {
      // Placed with a click at a reach worth having, and a drag overrides it -
      // the same rule a note is placed under, and for the same reason: dropping
      // a lamp that reaches nowhere until a field is typed into is a lamp that
      // looks broken.
      return { ...base, shape: { kind: "circle", r: DEFAULT_LIGHT_RANGE } };
    }
    if (t === "text" || t === "arrow") {
      const item: EdItem = {
        ...base,
        shape:
          t === "arrow"
            ? { kind: "rect", w: NOTE_DEFAULT_ARROW_LENGTH, h: NOTE_ARROW_BAND }
            : { kind: "rect", w: NOTE_DEFAULT_SIZE.x, h: NOTE_DEFAULT_SIZE.y },
        note: { ...base.note, kind: t },
      };
      // A note is usually placed with a click rather than dragged out, so it
      // starts at a size worth writing in: a box growing down-right from the
      // click, or an arrow pointing right from it. A drag overrides both.
      if (t === "arrow") {
        setArrowEnds(item, start, start.add(new Vec2(NOTE_DEFAULT_ARROW_LENGTH, 0)));
      } else {
        item.pos = start.add(NOTE_DEFAULT_SIZE.mul(0.5));
      }
      return item;
    }
    if (t === "path") {
      // A placeholder two-vert run; the caller replaces it with the drafted
      // points immediately. It exists so the item is a well-formed path at
      // every instant, never a shape with no direction.
      return {
        ...base,
        shape: {
          kind: "path",
          verts: [new Vec2(-gridStep, 0), new Vec2(gridStep, 0)],
          handles: [ZERO_HANDLE(), ZERO_HANDLE()],
        },
      };
    }
    if (t === "poly") {
      // A placeholder triangle; the caller replaces the loop with the drafted
      // hull immediately. It exists so the item is a well-formed convex polygon
      // at every instant, never a shape with no vertices.
      return {
        ...base,
        shape: {
          kind: "poly",
          verts: [
            new Vec2(-gridStep, gridStep),
            new Vec2(0, -gridStep),
            new Vec2(gridStep, gridStep),
          ],
        },
      };
    }
    // A geometry object is a rect like `+ Rect`, so a click drops one at the grid
    // step and a drag sizes it - the drag itself reads `shape.kind` and needs to
    // know nothing about which tool drew it.
    return {
      ...base,
      shape:
        t === "rect" || t === "geometry"
          ? { kind: "rect", w: gridStep, h: gridStep }
          : { kind: "circle", r: gridStep },
    };
  }

  // A geometry object for an existing collision shape: what makes a drawn body
  // visible, on request. Drawing a shape creates the collision object and NOTHING
  // else, so being drawn and being simulated are two decisions an author makes
  // separately - which is the whole of the collision/geometry split, and was
  // undermined by a draw that quietly made one of each.
  //
  // It carries its OWN copy of the outline, and of the two things the extrusion
  // used to read off the collision object: how thick it is (`thickness`, which
  // is the number that piece's MASS is computed from) and what it is made of
  // (`material`, which names a surface). Copied ONCE, here, so the two objects
  // are independent in both directions from the moment they exist - the
  // collision shape can be resized, re-materialled or deleted and the look stays
  // exactly as authored. The cost is real and is the point: a wall widened after
  // it is dressed is widened twice.
  //
  // The same statement `primitiveOf` (`levelFormat.ts`) makes for a level
  // migrated from the legacy form, which is why the two copy the same fields.
  function addGeometryFor(items: EdItem[]): void {
    const made = items.map((item) => ({
      ...item,
      id: newBodyId(),
      object: "geometry" as const,
      shape: cloneShape(item.shape),
      cam: { ...item.cam },
      light: { ...item.light },
      note: { ...item.note },
      visual: { ...item.visual, depth: item.thickness, texture: item.material },
      // Born MATCHED to the shape it dresses (see `EdItem.matchId`): the two
      // start out identical, and the link is what keeps them so - resizing
      // either resizes both, which is what "give this shape a look" almost
      // always wants. Untick "match collision" on the geometry panel to
      // diverge them on purpose.
      matchId: item.id,
    }));
    if (!made.length) return;
    beginAction();
    addAndSelect(made);
  }

  // How close (in screen px) a click must land to the draft's first vertex to
  // close the loop rather than adding another vertex.
  const POLY_CLOSE_PX = 10;

  function cancelPolyDraft(): void {
    if (!polyDraft) return;
    polyDraft = null;
    updateTitle();
  }

  // Turn the clicked points into an item on the active layer.
  //
  // The outline is taken AS CLICKED, corners and notches and all, which is the
  // whole of what makes drawing a C-shaped wall one gesture rather than three
  // overlapping boxes - the loader cuts a concave outline into convex pieces
  // (`makeShapes`). The convex hull is what a draft falls back to when the loop
  // it describes is not a shape: one that crosses itself (a bow tie, or a stray
  // click landing back over the outline) has no inside, and the hull is the
  // nearest thing to what was drawn, exactly as it was before concave outlines
  // were authorable. A camera region has no cut and takes the hull as it always
  // did. Fewer than three non-collinear points is not a shape at all, so that
  // draft is simply dropped.
  function commitPolyDraft(): void {
    const draft = polyDraft;
    polyDraft = null;
    if (!draft) return;
    if (draft.kind === "path") {
      commitPathDraft(draft.verts);
      return;
    }
    const pts = draft.verts;
    const drawn = pts.length >= 3 && isSimpleLoop(pts) ? normalizeWinding(pts) : convexHull(pts);
    if (drawn.length < 3) {
      updateTitle();
      return;
    }
    const item = newDrawnItem("poly", drawn[0]!);
    // `setPolyVerts` re-centres the loop and moves `pos` to the centroid, so the
    // starting position only has to be somewhere sane in the item's own frame.
    item.pos = Vec2.ZERO;
    item.shape = { kind: "poly", verts: drawn.map((h) => h.clone()) };
    // A camera region falls back to the hull here rather than at the draft:
    // `setPolyVerts` is the one place that knows a region must stay convex.
    if (!setPolyVerts(item, drawn) && !setPolyVerts(item, convexHull(drawn))) {
      updateTitle();
      return;
    }
    beginAction();
    addAndSelect([item]);
    // Same rules the drag-drawn shapes take: a polygon drawn into a selected
    // body wears that body's properties rather than the tool's defaults.
    syncBodyProps(bodyMembers(model.items, item.bodyId));
  }

  // The clicked points as a camera path: taken exactly as drawn, with no
  // closing edge, no winding to normalise and no hull to fall back to. A path
  // that crosses itself is a switchback, which is the case the whole mechanism
  // is built around - so the only draft that is dropped is one with fewer than
  // two distinct points, which has no direction.
  function commitPathDraft(pts: readonly Vec2[]): void {
    const item = newDrawnItem("path", pts[0] ?? Vec2.ZERO);
    // `setPathVerts` re-centres on the vert average and moves `pos` with it, so
    // the starting position only has to be somewhere sane in the item's frame.
    item.pos = Vec2.ZERO;
    // Every node a corner to begin with: a drawn path is the polyline that was
    // clicked, and smoothing a corner is a handle drag away.
    item.shape = {
      kind: "path",
      verts: pts.map((p) => p.clone()),
      handles: pts.map(() => ZERO_HANDLE()),
    };
    if (!setPathVerts(item, pts)) {
      updateTitle();
      return;
    }
    beginAction();
    addAndSelect([item]);
  }

  // Remove the picked vertices from the shape they belong to. Answers whether
  // it handled the keystroke, so the caller can fall through to deleting the
  // OBJECT when no vertex is picked.
  //
  // The floors are the shape kinds' own - three for a loop, two for an open run
  // - and a request that would go under one removes NOTHING rather than as many
  // as it can: "delete these four" answered by deleting two leaves a shape
  // nobody asked for, and the corners that survived are not the ones the author
  // would have kept.
  function deleteSelectedVerts(): boolean {
    const item = vertexEditTarget();
    if (!item) return false;
    if (item.shape.kind !== "poly" && item.shape.kind !== "path") return false;
    const doomed = new Set(selectedVertIndices(item));
    if (!doomed.size) return false;
    const floor = item.shape.kind === "path" ? 2 : 3;
    if (item.shape.verts.length - doomed.size < floor) return true;
    beginAction();
    const rest = item.shape.verts.filter((_, i) => !doomed.has(i));
    const ok =
      item.shape.kind === "path"
        ? setPathVerts(
            item,
            rest,
            item.shape.handles.filter((_, i) => !doomed.has(i)),
          )
        : setPolyVerts(item, rest);
    // A refusal leaves the shape exactly as it was - a removal can turn a simple
    // outline into one that crosses itself - and the selection stands, so the
    // corners that were picked are still picked.
    if (ok) {
      selectedVerts.clear();
      markDirty();
    }
    rebuildInspector();
    return true;
  }

  // Move the picked vertices by one grid cell. Answers whether it handled the
  // keystroke, exactly as `deleteSelectedVerts` does.
  function nudgeSelectedVerts(dir: Vec2, fine: boolean): boolean {
    const item = vertexEditTarget();
    if (!item) return false;
    if (item.shape.kind !== "poly" && item.shape.kind !== "path") return false;
    const picked = new Set(selectedVertIndices(item));
    if (!picked.size) return false;
    if (!nudging) {
      beginAction();
      nudging = true;
    }
    // In the shape's own frame, so a nudge on a turned shape moves its corner
    // along the world axis the arrow names rather than along the shape's.
    const d = dir.mul(fine ? NUDGE_FINE : gridStep).rotated(-item.rot);
    const next = item.shape.verts.map((v, i) => (picked.has(i) ? v.add(d) : v));
    if (item.shape.kind === "path") setPathVerts(item, next);
    else setPolyVerts(item, next);
    markDirty();
    refreshFields();
    return true;
  }

  function deleteSelected(): void {
    // A selected BODY means all of it: deleting a body deletes the objects in
    // it. Reading `selectedIds` alone left the body panel's own Delete button
    // doing nothing at all.
    const doomed = new Set(operandItems().map((b) => b.id));
    if (!doomed.size && !selectedChainIds.size && !selectedVineIds.size) return;
    beginAction();
    model.items = model.items.filter((b) => !doomed.has(b.id));
    model.chains = model.chains.filter((c) => !selectedChainIds.has(c.id));
    model.vines = model.vines.filter((v) => !selectedVineIds.has(v.id));
    // A chain whose anchor has just gone has nothing left to hold, and an anchor
    // whose chain has just gone has nothing left to be - the two prunes are each
    // other's mirror and both are needed, since either end may be what was
    // deleted. There is nothing to prune about the bodies themselves: a body down
    // to its last object is still a body, which is the state "a group of one"
    // used to have to be cleaned up into.
    pruneChains();
    pruneAnchors();
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    markDirty();
    rebuildInspector();
  }
  // Arrow-key nudge: one grid cell, or `NUDGE_FINE` with Ctrl held. A pure
  // translation — deliberately not snapped, so a body keeps whatever sub-cell
  // offset it has and a fine nudge survives with snap on.
  const NUDGE_FINE = 0.01; // 1 cm
  function nudgeSelection(dir: Vec2, fine: boolean): void {
    const sel = operandItems();
    if (!sel.length) return;
    // One undo step per run of nudges (a held arrow is a single gesture, like
    // a drag); releasing the key or any other action ends it.
    if (!nudging) {
      beginAction();
      nudging = true;
    }
    const d = dir.mul(fine ? NUDGE_FINE : gridStep);
    // The body's frame comes along only where the whole body is being nudged, so
    // nudging ONE object inside a body moves that object and leaves its body and
    // its siblings exactly where they were.
    translateItems(model, sel, d);
    markDirty();
    refreshFields();
  }

  function duplicateSelected(): void {
    const sel = operandItems();
    if (!sel.length) return;
    beginAction();
    const copy = cloneBodies(sel, new Vec2(gridStep * 2, gridStep * 2));
    addAndSelect(
      copy.items,
      cloneChainsWithin(model.chains, copy.idOf),
      cloneVinesWithin(model.vines, copy.idOf),
    );
  }

  // --- clipboard ------------------------------------------------------------
  // Copies detached from the model (so later edits or an undo can't mutate
  // them); paste re-centres the group's bounding box on the cursor.
  let clipboard: EdItem[] = [];
  // Chains whose two ends are both inside `clipboard`, so a copied assembly
  // (two bodies and the chain between them) pastes as the assembly.
  let clipboardChains: EdChain[] = [];
  // ...and vines whose anchor is inside it, so copying a wall with a vine on it
  // pastes the vine too.
  let clipboardVines: EdVine[] = [];

  function copySelection(): void {
    const sel = operandItems();
    if (!sel.length) return;
    clipboard = sel.map((b) => ({
      ...b,
      shape: cloneShape(b.shape),
      // Every per-layer property object is mutated in place by the inspector, so
      // a clipboard sharing one would paste whatever the ORIGINAL was edited to
      // after the copy rather than what was copied.
      cam: { ...b.cam },
      light: { ...b.light },
      note: { ...b.note },
      visual: { ...b.visual },
    }));
    const copied = new Set(sel.map((b) => b.id));
    clipboardChains = model.chains
      .filter((c) => copied.has(c.a) && copied.has(c.b))
      .map(cloneChain);
    clipboardVines = model.vines.filter((v) => copied.has(v.anchor)).map(cloneVine);
  }
  function pasteClipboard(): void {
    if (!clipboard.length) return;
    // Pasted items keep the layer they were copied from — a camera region can't
    // become a body — so a paste reveals and unlocks any layer it lands on
    // rather than dropping items where they can be neither seen nor clicked.
    for (const l of new Set(clipboard.map((i) => i.layer))) {
      setLayerVisible(l, true);
      setLayerLocked(l, false);
    }
    const box = bodyBounds(clipboard);
    let delta = pointerWorld().sub(box.min.add(box.max).mul(0.5));
    // Land the group's top-left corner on the grid, as a move does.
    if (snapOn) delta = snapVec(box.min.add(delta)).sub(box.min);
    beginAction();
    const copy = cloneBodies(clipboard, delta);
    addAndSelect(
      copy.items,
      cloneChainsWithin(clipboardChains, copy.idOf),
      cloneVinesWithin(clipboardVines, copy.idOf),
    );
  }

  // --- disk -----------------------------------------------------------------
  async function refreshLevelList(): Promise<void> {
    try {
      const names = await listLevels();
      loadSel.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = names.length ? "Load…" : "(no saved levels)";
      loadSel.appendChild(placeholder);
      for (const n of names) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        loadSel.appendChild(o);
      }
    } catch (e) {
      console.error(e);
    }
  }
  async function doLoad(name: string): Promise<void> {
    cancelAutosave(); // don't write the outgoing model to the incoming name
    try {
      const data = await loadLevel(name);
      replaceModel(modelFromDisk(data));
      resetHistory();
      selectedIds.clear();
      selectedVerts.clear();
      // Body ids are per-model, so one carried across a load would highlight a
      // body in the incoming level that has nothing to do with the one picked.
      selectedBodyIds.clear();
      currentName = name;
      dirty = false;
      camera.position = model.player.pos;
      rebuildInspector();
      updateTitle();
    } catch (e) {
      alert(`Load failed: ${e}`);
    }
  }
  // --- autosave -------------------------------------------------------------
  // Once a model has a name on disk, every edit is written back, debounced so a
  // drag (or a burst of nudges) collapses into one write. An unnamed model is
  // left alone: the first Save/Save As names the file, and everything after it
  // persists on its own. Writes do not reload the page - the levelApi plugin in
  // vite.config.ts keeps levels/*.json out of HMR.
  const AUTOSAVE_DELAY_MS = 750;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelAutosave(): void {
    if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  function scheduleAutosave(): void {
    if (!currentName) return;
    cancelAutosave();
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      void doSave(false, true);
    }, AUTOSAVE_DELAY_MS);
  }

  async function doSave(saveAs: boolean, auto = false): Promise<void> {
    // A queued autosave can fire after New/Delete cleared the name, or after a
    // manual Save already wrote the model. Either way it must be a no-op - and
    // in particular must never reach the "Save as" prompt below.
    if (auto && (!dirty || !currentName)) return;
    let name = currentName;
    if (saveAs || !name) {
      const input = prompt("Save level as (letters, digits, _ and - only):", name ?? "level");
      if (!input) return;
      if (!/^[A-Za-z0-9_-]+$/.test(input)) {
        alert("Invalid name. Use letters, digits, _ and - only.");
        return;
      }
      name = input;
    }
    cancelAutosave();
    // Snapshot what is being written, so edits landing during the request are
    // still seen as unsaved when it returns.
    const isNewFile = name !== currentName;
    const rev = modelRev;
    const data = modelToDisk(model);
    try {
      await saveLevel(name, data);
      currentName = name;
      if (modelRev === rev) dirty = false;
      saveError = null;
      if (isNewFile) await refreshLevelList();
      updateTitle();
    } catch (e) {
      if (!auto) {
        alert(`Save failed: ${e}`);
        return;
      }
      // An autosave failure must not throw a modal dialog at someone mid-drag; the
      // title carries the state and the next edit retries.
      console.error(e);
      saveError = String(e);
      updateTitle();
    }
  }

  // A pending autosave would otherwise be lost on navigation/close; `keepalive`
  // lets the request outlive the page.
  window.addEventListener("pagehide", () => {
    if (autosaveTimer === null || !dirty || !currentName) return;
    cancelAutosave();
    void saveLevel(currentName, modelToDisk(model), { keepalive: true }).catch(() => {});
  });

  // --- canvas input ---------------------------------------------------------
  function pointerScreen(e: MouseEvent): Vec2 {
    const r = canvas.getBoundingClientRect();
    return new Vec2(e.clientX - r.left, e.clientY - r.top);
  }

  // Where a canvas position is on the GAMEPLAY PLANE, in world metres.
  //
  // Head on the 2D camera's own un-projection is the answer and always has been:
  // the plane is parallel to the image plane, so the mapping is a scale and an
  // offset. Orbited it is not, and a screen position means a world point only
  // through the ray that drew it - which is what `unprojectToPlane` casts,
  // through the same camera `Scene3D.pick` raycasts geometry with, so the plane
  // and the models a click is resolved against cannot disagree about where the
  // pointer is aimed.
  function canvasWorld(scr: Vec2): Vec2 {
    if (!orbited() || !scene3d) return screenToWorld(camera, scr.x, scr.y);
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return screenToWorld(camera, scr.x, scr.y);
    const hit = unprojectToPlane(
      scene3d.camera,
      (scr.x / r.width) * 2 - 1,
      1 - (scr.y / r.height) * 2,
    );
    return hit ?? screenToWorld(camera, scr.x, scr.y);
  }

  // Last pointer position, kept in screen space so it un-projects through the
  // current camera (paste targets where the cursor is *now*, after any zoom or
  // pan). Falls back to the view centre before the mouse has moved.
  let lastPointerScreen: Vec2 | null = null;
  const pointerWorld = (): Vec2 =>
    lastPointerScreen ? canvasWorld(lastPointerScreen) : camera.position;

  // A press that landed on vertex `index` of `item`: what it does to the vertex
  // selection, and the drag that follows.
  //
  // It is the same rule a press on a BODY follows, one level down. Shift
  // toggles, and a vertex toggled OFF starts no drag - the gesture was the
  // toggle. A plain press on a vertex already in the selection keeps the whole
  // set and drags it, so a group of corners is moved by grabbing any of them; a
  // plain press on any other vertex means that vertex alone.
  function grabVertex(item: EdItem, index: number, shift: boolean): Drag | "consumed" | null {
    if (item.shape.kind !== "poly" && item.shape.kind !== "path") return null;
    const verts = item.shape.verts;
    if (shift) {
      if (selectedVerts.delete(index)) {
        rebuildInspector();
        return "consumed";
      }
      selectedVerts.add(index);
    } else if (!selectedVerts.has(index)) {
      selectedVerts.clear();
      selectedVerts.add(index);
    }
    nudging = false; // a new set of corners starts a new undo step
    rebuildInspector();
    // Offsets in the SHAPE's own frame, taken from the pressed vertex. That is a
    // difference of two local positions, which is what survives `setPolyVerts`
    // re-centring the loop on its centroid: the re-centring subtracts the same
    // point from every vertex, so it leaves every difference alone.
    const lead = verts[index]!;
    const others = selectedVertIndices(item)
      .filter((i) => i !== index)
      .map((i) => ({ index: i, offset: verts[i]!.sub(lead) }));
    return { mode: "polyVertex", body: item, index, others, accepted: lead };
  }

  // Which handle of the selected body (if any) is under the pointer?
  //
  // `"consumed"` means the press *was* a handle interaction that finished on the
  // spot and started no drag — removing a polygon vertex. It has to be
  // distinguishable from "no handle here": falling through to the body pick
  // would land on empty space (the vertex just went away) and clear the
  // selection, so a removal would deselect the shape it edited.
  function pickHandle(scr: Vec2, alt = false, shift = false): Drag | "consumed" | null {
    // A selected vine is edited by its two handles and nothing else: the anchor
    // it hangs from, which is where it is, and its free end, which is how long
    // it is. The tip is tested first, so the two cannot fight over a press on a
    // vine drawn short enough for them to overlap.
    const vines = selectedVines();
    if (vines.length === 1) {
      const vine = vines[0]!;
      const hs = computeVineHandles(camera, model, vine);
      if (hs) {
        if (scr.distanceTo(hs.tip) <= HANDLE_HIT_PX) {
          // A span's tip IS its second anchor, so the drag moves that; a
          // hanging vine's tip is its length (and, Shift-dragged onto a body,
          // the gesture that attaches a second anchor).
          return vine.anchor2 !== null
            ? { mode: "vineEnd", vine, cursor: canvasWorld(scr), detach: false }
            : {
                mode: "vineLength",
                vine,
                startLength: vine.length,
                cursor: canvasWorld(scr),
                attach: null,
              };
        }
        if (scr.distanceTo(hs.top) <= HANDLE_HIT_PX) {
          return { mode: "vineAnchor", vine };
        }
      }
      return null;
    }
    // A selected chain is edited by its two end handles and nothing else.
    const chains = selectedChains();
    if (chains.length === 1) {
      const ends = computeChainHandles(camera, model, chains[0]!);
      if (ends) {
        for (const end of ["a", "b"] as const) {
          const p = ends[end];
          if (scr.distanceTo(p) <= HANDLE_HIT_PX) {
            return { mode: "chainEnd", chain: chains[0]!, end, cursor: p };
          }
        }
      }
      return null;
    }
    // A whole compound body turns as one, about the centre of mass its built
    // body's origin sits at, so it gets a rotate knob where a lone shape does.
    const whole = wholeGroup(selectedBodies());
    if (whole) {
      const gh = computeGroupHandles(camera, whole);
      if (scr.distanceTo(gh.rotate) <= HANDLE_HIT_PX) {
        const centre = bodyCentroid(whole);
        const world = screenToWorld(camera, scr.x, scr.y).sub(centre);
        return {
          mode: "rotateGroup",
          items: whole,
          centre,
          grabAngle: Math.atan2(world.y, world.x),
          applied: 0,
        };
      }
      return null;
    }
    const s = selected();
    // A handle that is not DRAWN must not be grabbable either, or a click in
    // what looks like empty space starts a resize (see `hasPlaneHandles`).
    if (!s || !hasPlaneHandles(s, overlayLayers())) return null;
    const h = computeHandles(camera, s);
    if (h.ends) {
      // Head first, so a zero-length arrow (a click that never dragged) still
      // has an end that grows it rather than two coincident ones.
      const { tail, head } = arrowEnds(s);
      if (scr.distanceTo(h.ends[1]!) <= HANDLE_HIT_PX) {
        return { mode: "arrowEnd", body: s, fixed: tail, movingIsHead: true };
      }
      if (scr.distanceTo(h.ends[0]!) <= HANDLE_HIT_PX) {
        return { mode: "arrowEnd", body: s, fixed: head, movingIsHead: false };
      }
      return null;
    }
    // A camera path takes the same vertex interface, minus the wrap: its ends
    // do not join, so the last vert has no edge after it to split and two verts
    // is the floor rather than three.
    if (h.verts && s.shape.kind === "path") {
      const shape = s.shape;
      for (let i = 0; i < h.verts.length; i++) {
        if (scr.distanceTo(h.verts[i]!) > HANDLE_HIT_PX) continue;
        if (alt) {
          if (shape.verts.length <= 2) return null;
          beginAction();
          const rest = shape.verts.filter((_, j) => j !== i);
          const restH = shape.handles.filter((_, j) => j !== i);
          if (setPathVerts(s, rest, restH)) {
            // Every index past the removed one has shifted, so the set names
            // corners nobody picked; it goes rather than being renumbered,
            // since a removal is the end of the gesture that made it.
            selectedVerts.clear();
            markDirty();
            rebuildInspector();
          }
          return "consumed";
        }
        return grabVertex(s, i, shift);
      }
      // Tangent grips after the vertices: a handle pulled back onto its own node
      // sits under it, and the node is what the pointer is far more often after.
      for (const g of h.pathHandles ?? []) {
        if (scr.distanceTo(g.pos) > HANDLE_HIT_PX) continue;
        beginAction();
        dragPushed = true;
        return { mode: "pathHandle", body: s, index: g.vert, side: g.side, mirror: !alt };
      }
      for (let i = 0; i < (h.vertMids?.length ?? 0); i++) {
        if (scr.distanceTo(h.vertMids![i]!) > HANDLE_HIT_PX) continue;
        // A de Casteljau split at t = 1/2: the two halves are exactly the curve
        // that was there, so inserting a node on a bowed edge adds a grip and
        // changes nothing about the shape. Splitting the chord instead would
        // straighten the edge the moment it was subdivided.
        const nodes = pathNodes(s);
        const a = nodes[i]!;
        const b = nodes[i + 1]!;
        const c1 = a.p.add(a.out);
        const c2 = b.p.add(b.in);
        const m1 = a.p.add(c1).mul(0.5);
        const m2 = c1.add(c2).mul(0.5);
        const m3 = c2.add(b.p).mul(0.5);
        const n1 = m1.add(m2).mul(0.5);
        const n2 = m2.add(m3).mul(0.5);
        const mid = n1.add(n2).mul(0.5);
        const verts = [...shape.verts.slice(0, i + 1), mid, ...shape.verts.slice(i + 1)];
        const handles = shape.handles.map((x) => ({ ...x }));
        handles[i] = { in: handles[i]!.in, out: m1.sub(a.p) };
        handles[i + 1] = { in: m3.sub(b.p), out: handles[i + 1]!.out };
        handles.splice(i + 1, 0, { in: n1.sub(mid), out: n2.sub(mid) });
        beginAction();
        dragPushed = true;
        if (!setPathVerts(s, verts, handles)) return null;
        markDirty();
        // The inserted vertex becomes the selection: it is the one the gesture
        // is about, and every index past it has just shifted, so carrying the
        // old set over would name different corners than the ones that were
        // picked.
        selectedVerts.clear();
        selectedVerts.add(i + 1);
        return { mode: "polyVertex", body: s, index: i + 1, others: [], accepted: mid };
      }
    }
    // Vertices before the rotate knob: on a small polygon the knob can overlap a
    // corner, and the corner is what the pointer is far more often after.
    if (h.verts && s.shape.kind === "poly") {
      for (let i = 0; i < h.verts.length; i++) {
        if (scr.distanceTo(h.verts[i]!) > HANDLE_HIT_PX) continue;
        // Alt+click removes the vertex instead of dragging it — a triangle is
        // the floor, so the last three are not removable.
        if (alt) {
          if (s.shape.verts.length <= 3) return null;
          beginAction();
          const rest = s.shape.verts.filter((_, j) => j !== i);
          if (setPolyVerts(s, rest)) {
            selectedVerts.clear();
            markDirty();
            rebuildInspector();
          }
          return "consumed";
        }
        return grabVertex(s, i, shift);
      }
      // An edge midpoint splits that edge: insert a vertex there and drag it
      // straight away, so adding a corner and placing it is one gesture.
      for (let i = 0; i < (h.vertMids?.length ?? 0); i++) {
        if (scr.distanceTo(h.vertMids![i]!) > HANDLE_HIT_PX) continue;
        const verts = s.shape.verts;
        const mid = verts[i]!.add(verts[(i + 1) % verts.length]!).mul(0.5);
        const next = [...verts.slice(0, i + 1), mid, ...verts.slice(i + 1)];
        beginAction();
        dragPushed = true;
        if (!setPolyVerts(s, next)) return null;
        markDirty();
        // The inserted vertex becomes the selection: it is the one the gesture
        // is about, and every index past it has just shifted, so carrying the
        // old set over would name different corners than the ones that were
        // picked.
        selectedVerts.clear();
        selectedVerts.add(i + 1);
        return { mode: "polyVertex", body: s, index: i + 1, others: [], accepted: mid };
      }
    }
    if (h.depth && scr.distanceTo(h.depth) <= HANDLE_HIT_PX) {
      return { mode: "depth", body: s, base: depthOf(s), press: scr };
    }
    if (h.rotate && scr.distanceTo(h.rotate) <= HANDLE_HIT_PX) return { mode: "rotate", body: s };
    if (h.radius && scr.distanceTo(h.radius) <= HANDLE_HIT_PX) return { mode: "radius", body: s };
    if (s.shape.kind === "rect") {
      const hw = s.shape.w / 2;
      const hh = s.shape.h / 2;
      // Same order as computeHandles: TL, TR, BR, BL.
      const local = [new Vec2(-hw, -hh), new Vec2(hw, -hh), new Vec2(hw, hh), new Vec2(-hw, hh)];
      for (let i = 0; i < h.corners.length; i++) {
        if (scr.distanceTo(h.corners[i]!) <= HANDLE_HIT_PX) {
          // Anchor the diagonally opposite corner so the box grows toward the drag.
          return { mode: "corner", body: s, anchor: toWorld(s, local[(i + 2) % 4]!) };
        }
      }
    }
    return null;
  }

  canvas.addEventListener("mousedown", (e) => {
    if (mode !== "edit") return;
    // The gizmo took this press. Its own listener is on `pointerdown`, which
    // fires first, so by now it has already decided whether a handle was hit -
    // and a press that grabs an arrow must not also select, pan or rubber-band
    // whatever happens to be under it.
    if (gizmo?.busy) return;
    // Pan is the middle button (right too, as a convenience) and CTRL+middle
    // ORBITS the 3D view; the left button belongs to the level - it selects,
    // drags what is selected, and pans everything else (see `panPick`).
    //
    // Orbit is the modified gesture rather than the plain one because it is the
    // rarer act and the one you come back from: panning is how you get around a
    // level and is wanted on every view, orbiting is how you judge one. With no
    // scene to turn, Ctrl+middle simply pans like any other middle drag.
    if (e.button === 1 && e.ctrlKey && scene3d && viewMode !== "2d") {
      drag = { mode: "orbit", lastScreen: pointerScreen(e) };
      canvas.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }
    if (e.button === 1 || e.button === 2) {
      drag = { mode: "pan", lastScreen: pointerScreen(e) };
      canvas.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const scr = pointerScreen(e);
    const world = canvasWorld(scr);
    dragMoved = false;
    dragPushed = false;

    // A TURNED VIEW SELECTS AND MOVES, AND DOES NOTHING THAT IS DRAWN ON THE
    // OVERLAY. What a click MEANS survives the view being turned - a ray answers
    // for the models and meets the gameplay plane for everything resolved
    // against it (see `canvasWorld`) - so bodies and objects are picked there
    // exactly as they are head on, and the gizmo the pick puts on them is in the
    // scene and works from any angle. That pairing is the whole point of the
    // orbit: turn the view to see the depth, then drag the blue arrow to author
    // it, on the thing you just turned the view to look at.
    //
    // What does NOT survive is everything whose feedback is the overlay, since
    // the overlay is the plane projected straight onto the screen and is not
    // drawn at all here: the resize handles, the marquee band and the draw
    // tools' previews would each be somewhere the geometry is not. Those press
    // like empty space, which is a pan.
    const turned = orbited();
    if (!turned) {
      // 1. Handles of the current selection.
      const h = pickHandle(scr, e.altKey, e.shiftKey);
      if (h === "consumed") return; // handled outright; no drag, selection intact
      if (h) {
        drag = h;
        return;
      }
    }
    // What this press draws. A turned view draws nothing whatever the toolbar
    // says: every draw gesture previews on the overlay, and the overlay is not
    // on screen here, so an armed tool would author geometry blind.
    const drawTool = turned ? "select" : tool;
    // 1b. Polygon drafting: a run of clicks, not a drag. Clicking the first
    // vertex again (or Enter) closes the loop; Esc drops it.
    if (drawTool === "poly" || drawTool === "path") {
      const p = snapVec(world);
      // A path is finished by Enter or a double-click, never by clicking back on
      // its first vertex: an open run may legitimately end where it started (a
      // loop of a level), and closing on it would make that unauthorable.
      if (drawTool === "poly" && polyDraft && polyDraft.verts.length >= 3) {
        const first = worldToScreen(camera, polyDraft.verts[0]!);
        if (scr.distanceTo(first) <= POLY_CLOSE_PX) {
          commitPolyDraft();
          return;
        }
      }
      if (drawTool === "path" && e.detail >= 2 && polyDraft && polyDraft.verts.length >= 2) {
        commitPolyDraft();
        return;
      }
      polyDraft = { kind: drawTool, verts: [...(polyDraft?.verts ?? []), p] };
      updateTitle();
      return;
    }
    // 1c. Chain tool: a chain is not a shape to drag out but a link between two
    // bodies, so the gesture is a drag FROM one body TO another. Pressing
    // anywhere else does nothing rather than dropping a chain with one end in
    // mid-air.
    if (drawTool === "chain") {
      const from = topmostAt(world, (b) => chainable(b));
      if (from) {
        // The anchor lands on the body's surface, not where the pointer happens
        // to be inside it (see `nearestSurfaceLocal`).
        drag = { mode: "chainDraw", from, local: nearestSurfaceLocal(from, world), cursor: world };
      }
      return;
    }
    // 1d. Vine tool: the same press on a body that starts a chain, and then a
    // drag that pulls a LENGTH out instead of reaching for a second body. A
    // vine has one end, so there is nowhere else for the gesture to go.
    if (drawTool === "vine") {
      const from = topmostAt(world, (b) => chainable(b));
      if (from) {
        drag = { mode: "vineDraw", from, local: nearestSurfaceLocal(from, world), cursor: world };
      }
      return;
    }
    // 2. Draw tool: create a new item on the active layer and drag out its size.
    if (drawTool !== "select") {
      beginAction();
      dragPushed = true;
      const start = snapVec(world);
      const body = newDrawnItem(drawTool, start);
      model.items.push(body);
      // A body has one kind, one fill, one friction: an object drawn into an
      // existing body takes them rather than bringing the draw tool's defaults
      // and disagreeing with its siblings about what the body is.
      syncBodyProps(bodyMembers(model.items, body.bodyId));
      setSelection([body.id]);
      drag = { mode: "draw", body, start };
      markDirty();
      rebuildInspector();
      // A text note is placed to be written in, so the caret goes there rather
      // than making the first act after every note a trip to the inspector.
      // The default mousedown action moves focus to the document *after* this
      // listener, which would blur the textarea the moment it was focused, so a
      // note placement is the one canvas press that suppresses it. Every other
      // press keeps the default, since clicking the canvas has to blur whatever
      // inspector field was being typed into — otherwise the keyboard shortcuts
      // would stay swallowed by it.
      if (noteText) e.preventDefault();
      focusNoteText();
      return;
    }
    // 3. Player spawn marker (small target — needs pointer within its radius).
    if (
      !turned &&
      world.distanceTo(model.player.pos) <=
        Math.max(model.player.radius, 12 / (camera.zoom * PIXELS_PER_METER))
    ) {
      drag = { mode: "movePlayer", grab: model.player.pos.sub(world) };
      return;
    }
    // 4. Topmost item under the pointer, over every visible layer — the active
    // layer wins a tie (see `pickOrder`), so the layer switch still says which
    // of two stacked items a click means. A grouped item selects its whole
    // compound body, since a group IS one body; Alt reaches past that to the
    // single piece.
    //
    // Taken as the first CANDIDATE rather than through `topmostAt`, because the
    // candidates are the only list that knows about the 3D pick: they are the
    // same rule applied down the stack (`pickCandidatesAt`), so the first of them
    // IS what `topmostAt` answers and the press and the cycle it may turn into
    // cannot disagree about what was under the pointer.
    const hit = pickCandidatesAt(world, scr)[0] ?? null;
    if (hit) {
      // CLICK THE BODY, THEN CLICK INTO IT. A click on a body that is not the
      // one being edited selects the BODY - the thing with the transform, the
      // kind and the fill - because that is what you are pointing at: a wall, a
      // barrel, a lamp. Clicking again, once that body is the current one,
      // selects the OBJECT under the pointer, which is how you reach the
      // collision box or the mesh inside it.
      //
      // It is the drill-in every scene editor has, and it exists here for the
      // reason the whole refactor does: a body and the objects in it are
      // different things, and a single click cannot mean both.
      // Shift extends whatever is already selected, and while that is BODIES it
      // extends the body selection - so two bodies can be picked on the canvas
      // and merged, exactly as they can in the tree. Falling through to the item
      // selection here would quietly swap what the panel is editing mid-gesture.
      if (e.shiftKey && !e.altKey && selectedBodyIds.size) {
        toggleBodySelection(hit.bodyId);
        drag = null;
        return;
      }
      // SELECTED FIRST, MOVED SECOND. A press on something already selected
      // drags it; a press on anything else pans and selects on release, so
      // reaching for the view over a wall moves the view and not the wall.
      // Geometry cannot be nudged out of place by a gesture that meant to look
      // around, which is the one editing mistake that leaves no trace on screen.
      if (selectedBodyIds.has(hit.bodyId)) {
        // The whole body drags, since the body is what is selected - and a press
        // that turns out to be a CLICK still drills into the object under it,
        // which is the second half of "click the body, then click into it".
        const members = bodyMembers(model.items, hit.bodyId);
        const others = members
          .filter((o) => o !== hit)
          .map((o) => ({ body: o, offset: o.pos.sub(hit.pos) }));
        drag = {
          mode: "move",
          lead: hit,
          others,
          grab: hit.pos.sub(world),
          press: scr,
          moved: false,
          pick: pickAt(world, scr),
        };
        return;
      }
      if (selectedIds.has(hit.id) && !e.shiftKey && !e.altKey) {
        // An object picked out of a body drags with everything else selected. A
        // click on it is the cycle's next step - which for a lone object is what
        // it already is, and past that is how the thing underneath is reached. A
        // multi-selection has no pick at all: a click that meant to grab it and
        // did not travel must not silently collapse it to one object.
        const others = selectedBodies()
          .filter((o) => o !== hit)
          .map((o) => ({ body: o, offset: o.pos.sub(hit.pos) }));
        drag = {
          mode: "move",
          lead: hit,
          others,
          grab: hit.pos.sub(world),
          press: scr,
          moved: false,
          pick: selectedIds.size === 1 ? pickAt(world, scr) : undefined,
        };
        return;
      }
      // Not selected: what the press MEANS if it turns out to be a click.
      //
      // CLICK THE BODY, THEN CLICK INTO IT, THEN INTO WHAT IS BEHIND IT. A click
      // on a body that is not the one being edited selects the BODY - the thing
      // with the transform, the kind and the fill - because that is what you are
      // pointing at: a wall, a barrel, a lamp. Clicking again, once that body is
      // the current one, selects the OBJECT under the pointer, which is how you
      // reach the collision box or the mesh inside it; clicking again walks on
      // down whatever else is under the pointer (see `pickAt`).
      //
      // It is the drill-in every scene editor has, and it exists here for the
      // reason the whole refactor does: a body and the objects in it are
      // different things, and a single click cannot mean both.
      const cycle = pickAt(world, scr);
      const pick = (): void => {
        // Alt and Shift say outright what the click means, so they answer it
        // themselves rather than taking a turn in the cycle: Alt drills straight
        // to the object under the pointer, Shift extends what is selected. Both
        // end the cycle, since the next plain click at that point is starting a
        // fresh question rather than continuing this one.
        if (e.shiftKey || e.altKey) {
          const targets = clickTargets(hit, e.altKey || insideCurrentBody(hit));
          pickCycle = null;
          if (e.shiftKey) {
            if (targets.length === 1) toggleSelection(hit.id);
            else setSelection(withWholeBodies([...selectedIds, ...targets.map((t) => t.id)]));
            return;
          }
          setSelection(targets.map((t) => t.id));
          return;
        }
        cycle();
      };
      drag = { mode: "panPick", lastScreen: scr, travel: 0, pick };
      return;
    }
    // 5. A chain under the pointer. Tested after the bodies, since a chain is
    // strung over the geometry it holds and its ends sit inside those bodies -
    // picking it first would swallow every click near an anchor.
    const chain = topmostChainAt(world);
    if (chain) {
      setChainSelection([chain.id]);
      drag = null;
      return;
    }
    // ...and a vine, for the same reason and after the same bodies: a vine hangs
    // over the geometry it is bolted to.
    const vine = topmostVineAt(world);
    if (vine) {
      setVineSelection([vine.id]);
      drag = null;
      return;
    }
    // 6. Empty space: rubber-band select. A click that never moves deselects
    // (shift keeps the selection, so a miss doesn't undo the picking so far).
    //
    // A turned view pans instead, and clears on a click that did not travel, the
    // same way a band that catches nothing does: the band is drawn on the
    // overlay, and a screen-aligned rectangle is a slanted quadrilateral on the
    // plane the moment the camera is off axis - so what is dragged out and what
    // is caught could not be the same shape.
    drag = turned
      ? {
          mode: "panPick",
          lastScreen: scr,
          travel: 0,
          pick: () => {
            if (!e.shiftKey) setSelection([]);
          },
        }
      : {
          mode: "marquee",
          start: world,
          current: world,
          additive: e.shiftKey,
          // While a polygon or a camera path is the selection, a band drawn from
          // empty space is asking about ITS corners: the shape is already picked,
          // so its vertices are the only thing left on screen the band could
          // sensibly mean. To band bodies again, clear the selection first - a
          // click on empty space does that, dropping the vertex selection before
          // the item one so there is a way back out in two clicks.
          verts: vertexEditTarget(),
        };
  });

  // The world distance one screen pixel covers, which is what a screen-sized
  // pick target has to be measured in.
  const worldLine = (): number => 1 / (camera.zoom * PIXELS_PER_METER);

  // Whether a pick asks the SCENE rather than the gameplay plane. With a 3D view
  // on screen a geometry object is drawn as a solid - an extrusion through z, or
  // a prop that is not its authored outline at all - so where that solid is on
  // screen is where it is clickable. In the 2D view there is no scene to ask and
  // the outline is both what is drawn and what is picked, exactly as before.
  const picks3d = (): boolean => overlayLayers() === "outline" && sceneLevel !== null;

  // The geometry objects under the pointer in the 3D scene, as item ids, nearest
  // first collapsed into a set - the ORDER a pick prefers them in is `pickOrder`'s
  // and is not this function's to have an opinion about. Null when the scene is
  // not what is on screen, which is what leaves the 2D view untouched.
  function raycastItems(scr: Vec2): Set<number> | null {
    if (!picks3d()) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ids = new Set<number>();
    for (const tag of scene3d!.pick((scr.x / r.width) * 2 - 1, 1 - (scr.y / r.height) * 2)) {
      const id = itemOfSceneObject.get(tag as SceneObjectData);
      if (id !== undefined) ids.add(id);
    }
    return ids;
  }

  // Does a click at `world` land on this item? Everything is its own outline
  // except a LIGHT, which is its icon rather than its reach - see
  // `lightPickRadius` - and a GEOMETRY OBJECT once there is a scene to ask, which
  // is the model that was drawn for it rather than the rectangle it was placed
  // with (see `raycastItems`).
  function hitsItem(b: EdItem, world: Vec2, ray: ReadonlySet<number> | null = null): boolean {
    // An anchor is never picked as an ITEM. Its canvas presence is the ring its
    // chain draws at it, and that ring is already a drag handle - two things
    // answering one click, one of them an invisible 30 cm box sitting on the wall
    // the anchor is bolted to, is how a click on a wall starts selecting
    // something else. It is reached by its chain's handle, or by its row in the
    // outliner.
    if (b.object === "anchor") return false;
    if (b.object === "light") return world.distanceTo(b.pos) <= lightPickRadius(worldLine());
    if (ray && b.object === "geometry") return ray.has(b.id);
    return pointInBody(b, world);
  }

  // The box a click is judged to have landed in. A LIGHT is its icon and not
  // its reach, exactly as `hitsItem` has it: a lamp's pool is as wide as the
  // room it lights, and taken as the lamp's own box it would contain every wall
  // in that room and hand each of them the click.
  function pickBounds(b: EdItem): { min: Vec2; max: Vec2 } {
    // A camera path is a line, so its box is the curve's - grown by the band a
    // click on it is allowed to land in, or the prefilter would reject presses
    // that `pointInBody` would have accepted.
    if (b.shape.kind === "path") {
      const box = itemBounds(b);
      const m = new Vec2(PATH_PICK_HALF_WIDTH, PATH_PICK_HALF_WIDTH);
      return { min: box.min.sub(m), max: box.max.add(m) };
    }
    if (b.object !== "light") return itemBounds(b);
    const r = new Vec2(lightPickRadius(worldLine()), lightPickRadius(worldLine()));
    return { min: b.pos.sub(r), max: b.pos.add(r) };
  }

  // Topmost pickable item at a world point (optionally filtered), or null.
  //
  // CONTAINMENT BEATS DEPTH. A shape drawn wholly inside another - a hatch in a
  // door, a collision box inside the wall it belongs to - is the smaller thing
  // the pointer is on, and the bigger one is what it is on TOP of; taking the
  // topmost there would mean the inner shape could never be clicked at all,
  // since every point of it is also a point of its container. Depth still
  // decides between shapes that merely overlap, which is the case it is for.
  //
  // Applied repeatedly, so nesting several deep lands on the innermost, and
  // taking the LAST hit that qualifies so that two siblings inside one box are
  // still separated by the ordinary top-first rule.
  function topmostAt(world: Vec2, accept?: (b: EdItem) => boolean): EdItem | null {
    return bestHit(pickOrder().filter((b) => hitsItem(b, world) && (!accept || accept(b))));
  }

  // The one this rule prefers out of a set of hits already in pick order. Split
  // out of `topmostAt` so the cycle below can ask it repeatedly and get the same
  // preference at every step rather than a second opinion about what is on top.
  function bestHit(hits: readonly EdItem[]): EdItem | null {
    if (!hits.length) return null;
    const bounds = new Map(hits.map((b) => [b, pickBounds(b)] as const));
    let best = hits[hits.length - 1]!;
    for (;;) {
      let inner: EdItem | null = null;
      for (let i = hits.length - 1; i >= 0; i--) {
        const b = hits[i]!;
        if (b !== best && boundsInside(bounds.get(b)!, bounds.get(best)!)) {
          inner = b;
          break;
        }
      }
      if (!inner) return best;
      best = inner;
    }
  }

  // Everything under a world point, in the order the pick prefers it: what
  // `topmostAt` answers, then what it would answer with that taken away, and so
  // on. It is the same rule applied down the stack rather than a second ordering
  // beside it, so the first candidate IS the pick and nothing can disagree.
  function pickCandidatesAt(world: Vec2, scr: Vec2): EdItem[] {
    const ray = raycastItems(scr);
    const left = pickOrder().filter((b) => hitsItem(b, world, ray));
    const out: EdItem[] = [];
    for (;;) {
      const best = bestHit(left);
      if (!best) return out;
      out.push(best);
      left.splice(left.indexOf(best), 1);
    }
  }

  // One click, and what a REPEAT of it at the same point means.
  //
  // Every rule the pick has - depth, containment, the active layer - can only
  // ever name ONE winner, and an object nested inside or behind other outlines
  // is by definition not it: there is no pointer position that reaches it,
  // because every point of it is also a point of the things over it. So a click
  // that lands where the last one did takes the NEXT answer instead of repeating
  // the same one, which is what makes the whole stack reachable with the mouse.
  //
  // The steps are the editor's own "click the body, then click into it" (see
  // `insideCurrentBody`) run down the candidate list: body, its object, the next
  // body, its object. A fresh click starts exactly where it always did, so the
  // first two clicks anywhere are unchanged and the cycle is only what happens
  // past the point the pick used to stop.
  type PickStep = { apply: () => void; isCurrent: () => boolean };

  function pickSteps(cands: readonly EdItem[]): PickStep[] {
    const steps: PickStep[] = [];
    let prevBody: number | null = null;
    for (const it of cands) {
      // One step per body rather than per object, since a body is what a click
      // on any of its objects means. A body appears twice only where the stack
      // genuinely interleaves - its own object, something else's, then its next
      // one - which is the order those things are drawn in.
      if (it.bodyId !== prevBody) {
        const bodyId = it.bodyId;
        steps.push({
          apply: () => setBodySelection(bodyId),
          isCurrent: () =>
            soleBodyId() === bodyId && !selectedIds.size && !selectedChainIds.size,
        });
        prevBody = it.bodyId;
      }
      const id = it.id;
      steps.push({
        apply: () => setSelection([id]),
        isCurrent: () => selectedIds.size === 1 && selectedIds.has(id),
      });
    }
    return steps;
  }

  // Where the last cycling click landed, so the next one at that point can take
  // the step after it. Keyed on the candidates as well as the point, because a
  // pan under a resting cursor asks a different question rather than continuing
  // the old one.
  let pickCycle: { screen: Vec2; key: string; index: number } | null = null;

  // What a press MEANS if it turns out to be a click. Read at release rather
  // than captured at press: nothing between the two touches the selection, since
  // the drag can only have panned or moved what was already selected.
  function pickAt(world: Vec2, scr: Vec2): () => void {
    return () => {
      const cands = pickCandidatesAt(world, scr);
      if (!cands.length) return;
      const steps = pickSteps(cands);
      const key = cands.map((c) => c.id).join(",");
      // A repeat is the same point, the same stack, AND the selection still
      // being what the last step left - anything else (the outliner, a band, an
      // undo) has moved on, and continuing the cycle from there would jump to
      // something nobody pointed at.
      const repeat =
        pickCycle !== null &&
        pickCycle.key === key &&
        scr.distanceTo(pickCycle.screen) <= CLICK_SLOP_PX &&
        (steps[pickCycle.index]?.isCurrent() ?? false);
      const index = repeat
        ? (pickCycle!.index + 1) % steps.length
        : // A fresh click is exactly the old behaviour: the body under the
          // pointer, or the object in it when that body is already the one being
          // edited.
          insideCurrentBody(cands[0]!)
          ? 1
          : 0;
      steps[index]!.apply();
      pickCycle = { screen: scr, key, index };
    };
  }

  // The chain nearest a world point, within the pick band, or null. Chains are
  // only pickable while the geometry layer is one a click can reach - they are
  // geometry-layer furniture, and a hidden or locked layer must not be editable
  // through them.
  function topmostChainAt(world: Vec2): EdChain | null {
    if (!visibleLayers.has("scene") || lockedLayers.has("scene")) return null;
    const band = CHAIN_HIT_PX / (camera.zoom * PIXELS_PER_METER);
    let best: EdChain | null = null;
    let bestD = band;
    for (const c of model.chains) {
      const d = distanceToChain(model, c, world);
      if (d <= bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // The vine nearest a world point, within the same band a chain is picked by,
  // measured against its drawn rest pose.
  function topmostVineAt(world: Vec2): EdVine | null {
    if (!visibleLayers.has("scene") || lockedLayers.has("scene")) return null;
    const band = CHAIN_HIT_PX / (camera.zoom * PIXELS_PER_METER);
    let best: EdVine | null = null;
    let bestD = band;
    for (const v of model.vines) {
      const d = distanceToVine(model, v, world);
      if (d <= bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  // Double-clicking a text note opens its prose for editing — the gesture every
  // other canvas editor uses for "edit this thing's content". The text itself
  // still lives in the inspector's textarea (one editor for it, not two that
  // could disagree), so this selects the note alone and drops the caret in.
  canvas.addEventListener("dblclick", (e) => {
    if (mode !== "edit" || e.button !== 0 || tool !== "select") return;
    const world = canvasWorld(pointerScreen(e));
    const pickable = pickOrder();
    for (let i = pickable.length - 1; i >= 0; i--) {
      const b = pickable[i]!;
      if (!pointInBody(b, world)) continue;
      // Only the topmost item under the pointer is considered: a note behind
      // something else is not what was double-clicked.
      if (b.layer !== "notes" || b.note.kind !== "text") return;
      setSelection([b.id]);
      focusNoteText();
      return;
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (mode !== "edit") return;
    const scr = pointerScreen(e);
    lastPointerScreen = scr;
    if (!drag) return;
    const world = canvasWorld(scr);
    dragMoved = true;

    // A press on something selected is not a move until the pointer has left the
    // click's slop, so a click that drills into a body cannot also nudge it by
    // the pixel the hand shook by - and, since nothing is written before that,
    // there is no undo step for the nudge that did not happen either.
    if (drag.mode === "move" && !drag.moved) {
      if (scr.distanceTo(drag.press) < CLICK_SLOP_PX) return;
      drag.moved = true;
    }

    // Snapshot once, on the first movement of a model-mutating drag (pan and
    // marquee don't touch the model; draw already snapshotted at mousedown;
    // a chain being strung out has not created anything yet, and takes its
    // snapshot in `addChain` when it lands).
    if (
      !dragPushed &&
      drag.mode !== "pan" &&
      drag.mode !== "panPick" &&
      drag.mode !== "orbit" &&
      drag.mode !== "marquee" &&
      drag.mode !== "chainDraw" &&
      drag.mode !== "vineDraw"
    ) {
      beginAction();
      dragPushed = true;
    }

    switch (drag.mode) {
      case "pan": {
        const scale = camera.zoom * PIXELS_PER_METER;
        const d = scr.sub(drag.lastScreen);
        camera.position = camera.position.sub(d.div(scale));
        drag.lastScreen = scr;
        break;
      }
      case "panPick": {
        // Nothing happens at all until the pointer has really travelled: a click
        // that jitters by a pixel is a click, and it must still select what it
        // was aimed at rather than panning the level by a pixel instead.
        drag.travel += scr.distanceTo(drag.lastScreen);
        if (drag.travel >= CLICK_SLOP_PX) {
          const scale = camera.zoom * PIXELS_PER_METER;
          camera.position = camera.position.sub(scr.sub(drag.lastScreen).div(scale));
          canvas.style.cursor = "grabbing";
        }
        drag.lastScreen = scr;
        break;
      }
      case "orbit": {
        const d = scr.sub(drag.lastScreen);
        orbit.yaw -= d.x * ORBIT_RADIANS_PER_PX;
        // Both axes read the same way: the pointer drags the SCENE, so dragging
        // down tips the level's far side down and the camera rises to look at
        // it. The two signs agree for that reason - a control whose axes
        // disagree about which of the two things is being dragged is one you
        // have to re-learn every time you touch it.
        orbit.pitch = Math.max(
          -MAX_ORBIT_PITCH,
          Math.min(MAX_ORBIT_PITCH, orbit.pitch + d.y * ORBIT_RADIANS_PER_PX),
        );
        drag.lastScreen = scr;
        refreshOrbitBtn();
        break;
      }
      case "marquee":
        drag.current = world;
        break;
      case "move": {
        // Snap the lead body's corner; the rest keep their relative offsets so
        // a group's internal layout survives the move.
        const lead = snapCorner(drag.lead, world.add(drag.grab));
        // Written as the translation it is, so a body dragged whole carries its
        // frame and a piece dragged out of one does not (see `translateItems`).
        // The others keep their offsets, which is the same delta by definition.
        translateItems(model, [drag.lead, ...drag.others.map((o) => o.body)], lead.sub(drag.lead.pos));
        markDirty();
        refreshFields();
        break;
      }
      case "movePlayer":
        model.player.pos = snapVec(world.add(drag.grab));
        markDirty();
        refreshFields();
        break;
      case "arrowEnd": {
        const p = snapVec(world);
        if (drag.movingIsHead) setArrowEnds(drag.body, drag.fixed, p);
        else setArrowEnds(drag.body, p, drag.fixed);
        markDirty();
        refreshFields();
        break;
      }
      case "draw": {
        const b = drag.body;
        const p = snapVec(world);
        if (isArrowNote(b)) {
          // An arrow is dragged out tail-first, exactly as an endpoint handle
          // moves it afterwards.
          setArrowEnds(b, drag.start, p);
          markDirty();
          refreshFields();
        } else if (b.shape.kind === "rect") {
          const w = Math.max(gridStep, Math.abs(p.x - drag.start.x));
          const h = Math.max(gridStep, Math.abs(p.y - drag.start.y));
          b.shape.w = w;
          b.shape.h = h;
          b.pos = new Vec2((drag.start.x + p.x) / 2, (drag.start.y + p.y) / 2);
        } else if (b.shape.kind === "circle") {
          const r = snapLen(drag.start.distanceTo(p));
          // A light is placed with a click and keeps the default reach unless
          // the gesture was actually a drag; every other circle is dragged out
          // from nothing, so it takes whatever the pointer says including zero.
          if (b.object !== "light" || r >= gridStep) b.shape.r = r;
        }
        markDirty();
        refreshFields();
        break;
      }
      case "corner": {
        const b = drag.body;
        if (b.shape.kind === "rect") {
          // Fixed opposite corner (anchor); the dragged corner follows the
          // pointer. Extents measured in the body's local axes so it works
          // rotated; the anchor stays put and the centre shifts to the midpoint.
          const A = drag.anchor;
          const d = world.sub(A).rotated(-b.rot);
          const w = snapLen(Math.abs(d.x));
          const h = snapLen(Math.abs(d.y));
          const sx = d.x >= 0 ? 1 : -1;
          const sy = d.y >= 0 ? 1 : -1;
          b.shape.w = w;
          b.shape.h = h;
          b.pos = A.add(new Vec2((sx * w) / 2, (sy * h) / 2).rotated(b.rot));
          markDirty();
          refreshFields();
        }
        break;
      }
      case "depth": {
        // Screen up is +z, at the same scale x and y move at, so a metre of
        // depth is a metre of the level on screen.
        const dz = (drag.press.y - scr.y) / (camera.zoom * PIXELS_PER_METER);
        const z = snap(drag.base + dz);
        if (drag.body.object === "geometry") drag.body.visual.offsetZ = z;
        else if (drag.body.object === "light") drag.body.light.z = z;
        markDirty();
        refreshFields();
        break;
      }
      case "radius": {
        const b = drag.body;
        if (b.shape.kind === "circle") {
          b.shape.r = snapLen(world.distanceTo(b.pos));
          markDirty();
          refreshFields();
        }
        break;
      }
      case "polyVertex": {
        const b = drag.body;
        if (b.shape.kind !== "poly" && b.shape.kind !== "path") break;
        const local = snapVec(world).sub(b.pos).rotated(-b.rot);
        const index = drag.index;
        // The grabbed vertex follows the pointer (and the grid) and the rest of
        // the vertex selection rides along at its own fixed offset from it -
        // the same rule a group of BODIES is dragged by, one level down.
        const moved = new Map<number, Vec2>([[index, local]]);
        for (const o of drag.others) moved.set(o.index, local.add(o.offset));
        const next = b.shape.verts.map((v, i) => moved.get(i) ?? v);
        // A rejected edit leaves the loop exactly as it was, so the vertex stalls
        // at the last convex position instead of the shape turning inside out.
        // A PATH refuses almost nothing - it may cross itself - so the stall is
        // only for the degenerate case of every vert landing on one point.
        const ok = b.shape.kind === "path" ? setPathVerts(b, next) : setPolyVerts(b, next);
        if (ok) drag.accepted = local;
        markDirty();
        refreshFields();
        break;
      }
      case "pathHandle": {
        const b = drag.body;
        if (b.shape.kind !== "path") break;
        const h = b.shape.handles[drag.index];
        const p = b.shape.verts[drag.index];
        if (!h || !p) break;
        // NOT snapped to the grid: a tangent is a direction and a length, not a
        // placement, and rounding it to 10 cm quantises the curvature into
        // visible steps.
        const offset = world.sub(b.pos).rotated(-b.rot).sub(p);
        const other = drag.side === "in" ? "out" : "in";
        b.shape.handles[drag.index] = {
          ...h,
          [drag.side]: offset,
          // A smooth node is one whose handles are opposite. Mirrored in length
          // as well as direction, which is what "smooth" means in every pen
          // tool; Alt held at the press breaks the pair into a cusp.
          ...(drag.mirror ? { [other]: offset.neg() } : {}),
        } as { in: Vec2; out: Vec2 };
        markDirty();
        refreshFields();
        break;
      }
      case "rotate": {
        const b = drag.body;
        const d = world.sub(b.pos);
        // Local up (0,-1) rotated by rot should point at the pointer.
        b.rot = snapAngle(Math.atan2(d.x, -d.y));
        markDirty();
        refreshFields();
        break;
      }
      case "rotateGroup": {
        // How far the pointer has swung since the grab, applied to the whole
        // body about its centre of mass. Tracked as a total rather than a
        // per-move delta so snapping cannot accumulate rounding across a drag.
        const d = world.sub(drag.centre);
        const wanted = snapAngle(Math.atan2(d.y, d.x) - drag.grabAngle);
        rotateItemsAbout(model, drag.items, drag.centre, wanted - drag.applied);
        drag.applied = wanted;
        markDirty();
        refreshFields();
        break;
      }
      case "chainDraw":
        drag.cursor = world;
        break;
      case "vineDraw":
        // Any direction: the drag's length is the vine's, and its DIRECTION
        // decides what is being drawn - straight down (within the snap step)
        // is the ordinary hanging vine, anything else a springy branch held
        // out along the drag (resolved at release, see `vineDraftGeometry`).
        drag.cursor = world;
        break;
      case "vineLength": {
        const top = vineAnchorWorld(model, drag.vine);
        if (!top) break;
        drag.cursor = world;
        // Shift over a body arms the ATTACH gesture (see the drag's own doc):
        // the draft line follows the pointer and the length is held at what the
        // drag started with, since dragging sideways toward an anchor is not a
        // statement about length.
        drag.attach = e.shiftKey ? (topmostAt(world, (b) => chainable(b)) ?? null) : null;
        if (drag.attach) {
          drag.vine.length = drag.startLength;
        } else if (drag.vine.angle !== null && (drag.vine.stiffness ?? 0) > 0) {
          // A BRANCH's tip re-aims and re-lengths in one gesture, the way an
          // arrow's endpoint does: the tip is where the pointer is.
          const delta = world.sub(top);
          drag.vine.length = Math.max(MIN_VINE_LENGTH, snap(delta.length()));
          if (delta.lengthSquared() > 1e-12) {
            drag.vine.angle = snapAngle(Math.atan2(delta.y, delta.x));
          }
        } else {
          drag.vine.length = Math.max(MIN_VINE_LENGTH, snap(world.y - top.y));
        }
        markDirty();
        refreshFields();
        break;
      }
      case "vineEnd": {
        drag.cursor = world;
        // Shift over empty space arms the DETACH, resolved at release; over a
        // body the drag moves the second anchor exactly as a chain end moves.
        const over = topmostAt(world, (b) => chainable(b));
        drag.detach = e.shiftKey && !over;
        const anchor = drag.vine.anchor2 !== null ? anchorItem(model, drag.vine.anchor2) : null;
        if (!anchor) break;
        const host = over ?? anchorHost(anchor);
        if (!host) break;
        anchor.bodyId = host.bodyId;
        anchor.rot = host.rot;
        anchor.pos = toWorld(host, nearestSurfaceLocal(host, world));
        markDirty();
        refreshFields();
        break;
      }
      case "vineAnchor": {
        // The anchor IS where the vine hangs from, so the drag moves that
        // object - the same act as re-anchoring a chain end, minus the second
        // end there is nothing to collide with. Over nothing a vine could hang
        // from, it stays on the body it has, so a drag can never leave a vine
        // hanging from thin air.
        const anchor = anchorItem(model, drag.vine.anchor);
        if (!anchor) break;
        const host = topmostAt(world, (b) => chainable(b)) ?? anchorHost(anchor);
        if (!host) break;
        anchor.bodyId = host.bodyId;
        anchor.rot = host.rot;
        anchor.pos = toWorld(host, nearestSurfaceLocal(host, world));
        markDirty();
        refreshFields();
        break;
      }
      case "chainEnd": {
        drag.cursor = world;
        const c = drag.chain;
        // The end IS an anchor object, so the drag MOVES that object rather than
        // re-pointing the chain at something else. Re-anchoring onto another body
        // is the same act: the anchor changes which body it is in.
        const anchor = anchorItem(model, c[drag.end]);
        if (!anchor) break;
        const other = anchorItem(model, drag.end === "a" ? c.b : c.a);
        // Land on whatever body is under the pointer, so sliding an end along its
        // own body and moving it onto a different one are one gesture. Over the
        // body the OTHER end already holds, or over nothing at all, it stays on
        // the body it has - a drag can never leave a chain tied to itself or to
        // nothing.
        const over = topmostAt(world, (b) => chainable(b));
        const host = over && over.bodyId !== other?.bodyId ? over : anchorHost(anchor);
        if (!host) break;
        anchor.bodyId = host.bodyId;
        anchor.rot = host.rot;
        anchor.pos = toWorld(host, nearestSurfaceLocal(host, world));
        markDirty();
        refreshFields();
        break;
      }
    }
  });

  const itemOf = (id: number): EdItem | null => model.items.find((i) => i.id === id) ?? null;

  // The in-progress rubber-band, as a sorted world-space box (null unless one is
  // actually being dragged out — a click that never moves draws nothing).
  // The rubber band, plus which of the two CAD selection modes the drag
  // direction asks for: left→right is a **window** (only what it fully encloses),
  // right→left a **crossing** (anything it touches). Same convention as Fusion
  // 360 and AutoCAD. A drag with no horizontal travel counts as a window, so the
  // stricter mode is the one a degenerate drag falls into.
  function marqueeBand(): { min: Vec2; max: Vec2; window: boolean } | null {
    if (!drag || drag.mode !== "marquee" || !dragMoved) return null;
    const { start, current } = drag;
    return {
      min: new Vec2(Math.min(start.x, current.x), Math.min(start.y, current.y)),
      max: new Vec2(Math.max(start.x, current.x), Math.max(start.y, current.y)),
      // A vertex band is always drawn as a window, because a vertex is a point
      // and there is no crossing mode for it to be in: dashing it by the drag
      // direction would advertise a distinction that catches the same corners
      // either way.
      window: drag.verts !== null || current.x >= start.x,
    };
  }

  window.addEventListener("mouseup", () => {
    if (mode !== "edit" || !drag) return;
    // A press that panned nowhere was a click, and it means what a click on that
    // item has always meant.
    if (drag.mode === "panPick" && drag.travel < CLICK_SLOP_PX) drag.pick();
    if (drag.mode === "move" && !drag.moved) drag.pick?.();
    if (drag.mode === "marquee") {
      const box = marqueeBand();
      const vertTarget = drag.verts;
      if (box && vertTarget) {
        // A vertex is a point, so the window/crossing distinction has nothing to
        // bite on - a point is either in the box or it is not - and both drag
        // directions catch the same corners. Shift unions, exactly as it does
        // for bodies.
        if (!drag.additive) selectedVerts.clear();
        nudging = false;
        for (const [i, w] of worldVertices(vertTarget).entries()) {
          if (w.x >= box.min.x && w.x <= box.max.x && w.y >= box.min.y && w.y <= box.max.y) {
            selectedVerts.add(i);
          }
        }
        rebuildInspector();
      } else if (box) {
        const caught = box.window ? bodyWithinRect : bodyIntersectsRect;
        const hits = pickableItems()
          // A light is caught by its SOURCE, not by its reach, for the reason a
          // click lands on the icon: a band drawn anywhere inside a lamp's pool
          // would otherwise drag in every light in the room.
          .filter((b) =>
            // An anchor is not caught on its own account, for the reason a click
            // does not land on one: it has no canvas presence but its chain's
            // ring. It still comes along when its BODY is caught, through
            // `withWholeBodies` below - which is the whole point of it being an
            // object in that body.
            b.object === "anchor"
              ? false
              : b.object === "light"
                ? b.pos.x >= box.min.x &&
                  b.pos.x <= box.max.x &&
                  b.pos.y >= box.min.y &&
                  b.pos.y <= box.max.y
                : caught(b, box.min, box.max),
          )
          .map((b) => b.id);
        // No group is ever half-caught: a band that touches one piece of a
        // compound body has touched the body.
        setSelection(
          withWholeBodies(drag.additive ? [...selectedIds, ...hits] : hits),
        );
      } else if (!drag.additive) {
        // A plain click on empty space clears - the VERTEX selection first, if
        // there is one, and the item selection only once there is not. Two
        // clicks rather than one, which is what leaves a way back to banding
        // bodies from a shape that is open for vertex editing.
        if (selectedVerts.size) {
          selectedVerts.clear();
          rebuildInspector();
        } else {
          setSelection([]);
        }
      }
    }
    if (drag.mode === "vineDraw") {
      // A vine that was never dragged out is not a vine, so the gesture is
      // abandoned rather than dropping a one-link stub on the wall.
      const g = vineDraftGeometry(drag);
      addVine(drag.from, drag.local, g.length, g.angle);
    }
    // The two Shift gestures on a vine's end, resolved at release: a hanging
    // vine's tip carried onto a body attaches there and becomes a span, and a
    // span's end dropped over empty space detaches back to hanging.
    if (drag.mode === "vineLength" && drag.attach) {
      attachVineEnd(drag.vine, drag.attach, drag.cursor);
    }
    if (drag.mode === "vineEnd" && drag.detach) {
      detachVineEnd(drag.vine);
    }
    if (drag.mode === "chainDraw") {
      // A chain lands only on a body: released over empty space the gesture is
      // simply abandoned, rather than leaving one end in mid-air.
      const to = topmostAt(drag.cursor, (b) => chainable(b));
      if (to) addChain(drag.from, toWorld(drag.from, drag.local), to, drag.cursor);
    }
    drag = null;
    applyToolCursor();
  });

  canvas.addEventListener("wheel", (e) => {
    if (mode !== "edit") return;
    e.preventDefault();
    const scr = pointerScreen(e);
    const before = screenToWorld(camera, scr.x, scr.y);
    const factor = Math.exp(-e.deltaY * 0.001);
    camera.zoom = Math.min(20, Math.max(0.2, camera.zoom * factor));
    // Keep the point under the cursor under the cursor - but only head on, where
    // the zoom is a scale about the screen. Orbited it is a DOLLY along the view
    // direction, so the correction would want the ray through the new camera,
    // which is not built until the frame is drawn; zooming about the centre of
    // the view is the honest answer there rather than a correction computed from
    // a camera that is one frame stale.
    if (orbited()) return;
    const after = screenToWorld(camera, scr.x, scr.y);
    camera.position = camera.position.add(before.sub(after));
  }, { passive: false });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") {
      if (mode === "test") stopTest();
      else if (polyDraft) cancelPolyDraft();
      // The vertex selection goes first, for the reason a click on empty space
      // drops it first: it is the innermost thing selected, and dropping it is
      // how the shape stops being open for vertex editing.
      else if (selectedVerts.size) {
        selectedVerts.clear();
        rebuildInspector();
      } else setSelection([]);
      return;
    }
    if (mode === "test") {
      if (e.code === "KeyP") downloadTestRecording();
      // The same toggle the game has, and for the same reason: camera rules are
      // invisible in play, so a path that leads, releases or re-acquires has no
      // on-screen cause. A test is where an author tunes `range` and
      // `lookahead`, so it is where the overlay has to be reachable.
      if (e.code === "KeyL") testShowDebug = !testShowDebug;
      return;
    }
    if (mode !== "edit") return;
    // Ignore shortcuts while a field that consumes keystrokes has focus (let
    // its native editing/undo win). Toggles don't consume them, so clicking the
    // snap checkbox must not leave the editor deaf to shortcuts.
    const focused = e.target;
    const typing =
      (focused instanceof HTMLInputElement &&
        focused.type !== "checkbox" &&
        focused.type !== "radio") ||
      focused instanceof HTMLTextAreaElement ||
      focused instanceof HTMLSelectElement;
    if (typing) return;
    // Arrows before the Ctrl block: Ctrl+Arrow is the fine nudge, not a combo.
    const dir = NUDGE_DIRS[e.code];
    if (dir) {
      // Same rule as Delete: a nudge is about the corners while there are
      // corners picked, rather than moving the whole shape out from under them.
      if (!nudgeSelectedVerts(dir, e.ctrlKey || e.metaKey)) {
        nudgeSelection(dir, e.ctrlKey || e.metaKey);
      }
      e.preventDefault(); // don't scroll the page
      return;
    }
    // Modifier combos first: the bare-key tool shortcuts share letters with
    // them (V/C), so Ctrl+V must not also switch tools.
    if (e.ctrlKey || e.metaKey) {
      switch (e.code) {
        case "KeyZ":
          if (e.shiftKey) redo();
          else undo();
          break;
        case "KeyY":
          redo();
          break;
        case "KeyD":
          duplicateSelected();
          break;
        case "KeyG":
          // Ctrl+G welds the selection into one compound body; Ctrl+Shift+G
          // breaks one back up - the pairing every editor uses.
          if (e.shiftKey) splitIntoBodies();
          else mergeIntoBody();
          break;
        case "KeyC":
          copySelection();
          break;
        case "KeyV":
          pasteClipboard();
          break;
        default:
          return;
      }
      e.preventDefault();
      return;
    }
    if (e.code === "Tab") {
      // Cycle the edit layer. Preventing the default keeps focus on the canvas
      // rather than walking the toolbar.
      const i = ED_LAYERS.indexOf(activeLayer);
      setLayer(ED_LAYERS[(i + 1) % ED_LAYERS.length]!);
      e.preventDefault();
      return;
    }
    if ((e.code === "Enter" || e.code === "NumpadEnter") && polyDraft) {
      commitPolyDraft();
      e.preventDefault();
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") {
      // Corners before objects: with vertices picked out of a shape, Delete is
      // about them, and the shape itself is one Escape away from being what it
      // means again.
      if (!deleteSelectedVerts()) deleteSelected();
      e.preventDefault();
    } else if (e.code === "KeyB") {
      // Spot-check a spot: test the ball from wherever the cursor is, without
      // moving the level's own spawn marker.
      startTest("ball", pointerWorld());
    } else if (e.code === "KeyV") setTool("select");
    else if (e.code === "KeyR") setTool("rect");
    else if (e.code === "KeyC") setTool("circle");
    else if (e.code === "KeyP") setTool("poly");
    else if (e.code === "KeyT") setTool("text");
    else if (e.code === "KeyA") setTool("arrow");
    else if (e.code === "KeyK") setTool("chain");
    // The lens (see `ViewProjection`), on the letter it is named by.
    else if (e.code === "KeyO")
      setProjection(projection === "orthographic" ? "perspective" : "orthographic");
  });

  // Releasing an arrow closes the nudge run, so the next press starts a fresh
  // undo step.
  window.addEventListener("keyup", (e) => {
    if (NUDGE_DIRS[e.code]) nudging = false;
  });

  // The chain being strung out, as the renderer wants it: the fixed anchor, the
  // pointer, and whether releasing here would actually make a chain.
  function chainDraftView(): { from: Vec2; to: Vec2; valid: boolean } | null {
    if (!drag || drag.mode !== "chainDraw") return null;
    const from = toWorld(drag.from, drag.local);
    const to = topmostAt(drag.cursor, (b) => chainable(b));
    const valid =
      to !== null &&
      to.id !== drag.from.id &&
      !(drag.from.bodyId !== null && to.bodyId === drag.from.bodyId);
    return { from, to: drag.cursor, valid };
  }

  // What the current +Vine drag would build: its length, and the authored
  // angle - null for a drag within half a snap step of straight down, which is
  // the ordinary hanging vine. One function for the draft and the release, so
  // what is drawn while dragging cannot disagree with what a release builds.
  function vineDraftGeometry(d: { from: EdItem; local: Vec2; cursor: Vec2 }): {
    top: Vec2;
    length: number;
    angle: number | null;
  } {
    const top = toWorld(d.from, d.local);
    const delta = d.cursor.sub(top);
    const length = snap(delta.length());
    if (length < MIN_VINE_LENGTH) return { top, length, angle: null };
    const a = snapAngle(Math.atan2(delta.y, delta.x));
    // Down within half the 15° snap step is DOWN, snap or no snap: nobody
    // drags a hanging vine out at 3° and means a branch.
    const off = a - Math.PI / 2;
    const offDown = Math.abs(Math.atan2(Math.sin(off), Math.cos(off)));
    return { top, length, angle: offDown < Math.PI / 24 ? null : a };
  }

  // The vine being pulled out - or a tip being Shift-carried toward a second
  // anchor - as the renderer wants it: where it starts, where the gesture has
  // got, and whether releasing here would build (or attach) anything.
  function vineDraftView():
    | { kind: "hang"; from: Vec2; to: Vec2; valid: boolean }
    | { kind: "attach"; from: Vec2; to: Vec2; valid: boolean }
    | null {
    if (drag?.mode === "vineDraw") {
      const g = vineDraftGeometry(drag);
      const dir =
        g.angle !== null ? new Vec2(Math.cos(g.angle), Math.sin(g.angle)) : new Vec2(0, 1);
      return {
        kind: "hang",
        from: g.top,
        to: g.top.add(dir.mul(g.length)),
        valid: g.length >= MIN_VINE_LENGTH,
      };
    }
    if (drag?.mode === "vineLength" && drag.attach) {
      const top = vineAnchorWorld(model, drag.vine);
      return top ? { kind: "attach", from: top, to: drag.cursor, valid: true } : null;
    }
    return null;
  }

  // --- loop -----------------------------------------------------------------
  let accumulator = 0;
  let lastNow = -1;
  let fps = 0;

  function frame(now: number): void {
    if (mode === "test" && testLevel) {
      if (lastNow < 0) lastNow = now;
      let dt = (now - lastNow) / 1000;
      lastNow = now;
      if (dt > 0.25) dt = 0.25;
      accumulator += dt;
      if (dt > 0) fps += (1 / dt - fps) * 0.1;
      const src: IInputSource = (testLevel instanceof BallLevel ? ballInput : liveInput)!;
      let steps = 0;
      while (accumulator >= STEP && steps < MAX_STEPS) {
        const fi: FrameInput = src.sample();
        testLevel.physicsProcess(fi, STEP);
        // Drained inside the catch-up loop, as `main.ts` does: a frame that
        // runs several steps must not drop the caught-up steps' events.
        testSparks.ingest(testLevel.sparkEvents);
        recFrames.push(serializeInput(fi));
        recDigests.push(
          testLevel instanceof BallLevel ? digestBall(testLevel) : digest(testLevel),
        );
        accumulator -= STEP;
        steps++;
      }
      // Debt beyond the capped catch-up is shed, as in main.ts - overload plays
      // slightly slow rather than collapsing the frame rate.
      if (accumulator >= STEP) accumulator %= STEP;
      // Same camera the game runs (eased follow + the level's camera rules), so
      // a region or a path authored here is tested exactly as it will play.
      // Render interpolation factor, as in main.ts: the sim is a fixed 60 Hz,
      // so bodies are drawn between steps rather than snapping to the newest.
      const alpha = Math.min(1, accumulator / STEP);
      // Once per rendered frame, on the render clock (see main.ts).
      testSparks.advance(dt);
      testCameraCtl.update(
        camera,
        dt,
        testLevel.cameraRenderPosition(alpha),
        testLevel.cameraRules,
        testController === "ball" ? BALL_ZOOM : GRAPPLE_ZOOM,
      );
      // Render-rate refresh of stick aim (see LiveInputSource.pollAim).
      ballInput?.pollAim();
      liveInput?.pollAim();
      // A test is played in the game's own fixed 16:9 frame, fitted into the
      // editor canvas — the point of ▶ Test is that framing is felt exactly as
      // it will play, and a window-shaped view would show a different slice of
      // the level from the one the player gets. What is left over is the same
      // letterbox the game has, painted here because the frame no longer covers
      // the whole canvas.
      const view = viewTransform(canvas.width, canvas.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = LETTERBOX_COLOR;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // A test uses the real game render path, so it gets the 3D scene for free
      // - drawn into the letterboxed frame rather than the whole canvas, since
      // the bars are not part of the picture the player is shown. WebGL's
      // viewport origin is the BOTTOM left, hence the flipped y.
      const testIn3d = scene3d !== null && viewMode !== "2d" && testLevel3d !== null;
      if (testIn3d) {
        // A test is the player's view, so it is always the perspective camera:
        // the editor's orthographic lens is an authoring instrument, and a level
        // judged through it would be judged through a lens nobody plays in.
        scene3d!.setProjection("perspective");
        const w = Math.round(view.width * view.scale);
        const h = Math.round(view.height * view.scale);
        scene3d!.setViewportRect({
          x: Math.round(view.originX),
          y: canvas.height - Math.round(view.originY) - h,
          w,
          h,
        });
        scene3d!.render(testLevel3d!, camera, alpha);
      }
      if (testLevel instanceof BallLevel) {
        renderBall(
          ctx,
          view,
          testLevel,
          camera,
          fps,
          ballInput?.aimPoint() ?? null,
          alpha,
          testIn3d,
          testSparks,
        );
      } else {
        render(
          ctx,
          view,
          testLevel,
          camera,
          fps,
          testShowDebug,
          liveInput!.gamepadAim(),
          alpha,
          testCameraCtl.held,
          testIn3d,
          testSparks,
        );
      }
    } else {
      // The tree tracks the model, and a drag changes the model every frame
      // without touching the inspector - so it is refreshed here rather than
      // only on selection. It is a revision check and a class toggle per row
      // unless the model actually moved.
      refreshOutliner();
      // The scene first, then the editor's own canvas over it. Both are driven
      // from the SAME free camera through `space.ts`, so an outline drawn on top
      // lands on the geometry it describes underneath at any pan or zoom - which
      // is the whole reason the editor can gain a 3D view without giving up
      // precise collision authoring.
      if (scene3d && viewMode !== "2d") {
        scene3d.setViewportRect(null);
        // Set per frame rather than only at the toggle, because ▶ Test borrows
        // the same scene and puts it back on the perspective camera.
        scene3d.setProjection(projection);
        gizmo?.setCamera(scene3d.camera);
        syncEditorScene();
        // What is selected, said on the models themselves - the geometry
        // objects' only selection feedback, since their outline is not drawn
        // here (see `syncHighlight`). After the rebuild, which retires the
        // paint along with the meshes that were wearing it.
        syncHighlight();
        // After the scene is rebuilt and before it is drawn: the handles are on
        // a proxy rather than on a visual precisely so a rebuild cannot take
        // them with it, and this is where they pick the model's pose back up.
        syncGizmo();
        if (sceneLevel) scene3d.render(sceneLevel, camera, 1, orbit);
      }
      // Scene only: the overlay draws nothing at all, so what is on screen is
      // the level as it will be played. Selection chrome goes with it, which is
      // the point - this mode is for looking, and "3D + overlay" is for editing.
      //
      // A TURNED VIEW IS THE SAME STATEMENT about what is DRAWN. The overlay is
      // the gameplay plane projected straight onto the screen, so at any other
      // angle every outline, handle and band it draws would be somewhere the
      // geometry is not - which is worse than drawing nothing, since it looks
      // exactly like the editor still being aligned. `Reset view` is the way
      // back. What survives the turn is what is drawn in the SCENE - the
      // selection highlight and the transform gizmo - and the picking, which is
      // a ray rather than a projection (see the press handler).
      if (viewMode === "3d" || orbited()) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        requestAnimationFrame(frame);
        return;
      }
      drawEditor(
        ctx,
        dpr,
        cssW,
        cssH,
        camera,
        model,
        selectedIds,
        marqueeBand(),
        visibleLayers,
        polyDraft ? { ...polyDraft, cursor: pointerWorld() } : null,
        selectedChainIds,
        chainDraftView(),
        selectedVineIds,
        vineDraftView(),
        // In 3D the scene below is what shows what a body IS; the overlay drops
        // its fills to outlines so the geometry stays visible through them.
        overlayLayers(),
        selectedBodyIds,
        selectedVerts,
        currentSettleGhosts(),
      );
    }
    requestAnimationFrame(frame);
  }

  // --- boot -----------------------------------------------------------------
  camera.position = model.player.pos;
  setLayer("scene");
  rebuildInspector();
  updateTitle();
  refreshLevelList();
  requestAnimationFrame(frame);
}

// --- DOM helpers ------------------------------------------------------------
function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ed-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
function checkbox(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLElement {
  const wrap = el("label", "ed-check");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = initial;
  box.addEventListener("change", () => onChange(box.checked));
  wrap.appendChild(box);
  wrap.appendChild(document.createTextNode(label));
  return wrap;
}
function labelWrap(label: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "ed-inline");
  wrap.appendChild(document.createTextNode(label));
  wrap.appendChild(control);
  return wrap;
}
// Layer visibility icon: an open eye when the layer draws, a closed lid when it
// does not. Inline SVG rather than an emoji or a glyph, so it inherits the
// toolbar's colour through `currentColor`, stays crisp at any DPI, and looks the
// same on every platform (👁 does not).
function eyeIcon(open: boolean): string {
  const svg = (body: string) =>
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return open
    ? svg('<path d="M1 8s2.6-4.4 7-4.4S15 8 15 8s-2.6 4.4-7 4.4S1 8 1 8Z"/><circle cx="8" cy="8" r="1.9"/>')
    : // The same almond, shut: the lid curve plus three lashes, so a hidden
      // layer reads as "closed" and not merely as a missing icon.
      svg(
        '<path d="M1.4 6.6S4 10.4 8 10.4s6.6-3.8 6.6-3.8"/><path d="M3.1 9.3 1.9 11"/><path d="M8 10.4V12.5"/><path d="M12.9 9.3 14.1 11"/>',
      );
}

// Padlock for the layer list, drawn the same way as the eye (inline SVG on
// `currentColor`, so it takes the toolbar's colour and stays crisp at any DPI).
// The open state lifts the shackle off the case and hangs it to one side — an
// upright shackle that merely failed to meet the case reads as a rendering
// glitch rather than as "open".
function lockIcon(locked: boolean): string {
  const svg = (body: string) =>
    `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const body = '<rect x="2.8" y="7" width="9" height="6.2" rx="1.2"/>';
  return locked
    ? svg(`${body}<path d="M5 7V4.9a2.3 2.3 0 0 1 4.6 0V7"/>`)
    : svg(`${body}<path d="M9.6 7V4.9a2.3 2.3 0 0 1 4.6 0"/>`);
}

function heading(text: string): HTMLElement {
  const h = el("div", "ed-heading");
  h.textContent = text;
  return h;
}
// Three decimals: enough for a 0.05 friction or opacity step to survive a
// panel rebuild (1 dp used to redisplay 0.25 as 0.3), and short enough that
// float noise from the metre/pixel round trip rounds away.
function fmt(v: number): string {
  return String(Number(v.toFixed(3)));
}
// A field whose selected bodies disagree shows blank (with a "mixed"
// placeholder) rather than picking one body's value to display.
function fmtOrBlank(v: number | null): string {
  return v === null ? "" : fmt(v);
}

function injectStyles(): void {
  if (document.getElementById("ed-styles")) return;
  const s = document.createElement("style");
  s.id = "ed-styles";
  s.textContent = `
  .ed-root { position: fixed; inset: 0; pointer-events: none; color: #cbccc6;
    font-family: monospace; font-size: 13px; }
  .ed-root button, .ed-root select, .ed-root input, .ed-inspector { pointer-events: auto; }
  .ed-bar { position: absolute; top: 8px; left: 8px; display: flex; flex-direction: column;
    gap: 6px; background: rgba(31,36,48,0.92); border: 1px solid #313244; padding: 8px;
    border-radius: 2px; }
  .ed-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .ed-btn { background: #2a2f3d; color: #cbccc6; border: 1px solid #3c445c;
    padding: 3px 8px; font-family: monospace; font-size: 13px; cursor: pointer;
    border-radius: 2px; }
  .ed-btn:hover { background: #343b4d; }
  .ed-btn.active { border-color: #65bddb; color: #65bddb; }
  .ed-select, .ed-num { background: #1f2430; color: #cbccc6; border: 1px solid #3c445c;
    font-family: monospace; font-size: 13px; padding: 2px 4px; border-radius: 2px; }
  .ed-num { width: 64px; }
  .ed-text { background: #1f2430; color: #cbccc6; border: 1px solid #3c445c;
    font-family: monospace; font-size: 13px; padding: 4px; border-radius: 2px;
    width: 100%; box-sizing: border-box; resize: vertical; }
  .ed-color { width: 44px; height: 22px; padding: 0; background: #1f2430;
    border: 1px solid #3c445c; border-radius: 2px; cursor: pointer; }
  .ed-inline, .ed-check { display: inline-flex; gap: 4px; align-items: center; color: #9aa0ac; }
  .ed-layers { display: flex; flex-direction: column; gap: 4px; align-self: flex-start; }
  .ed-layer-label { color: #9aa0ac; }
  .ed-layer-row { display: flex; gap: 6px; align-items: center; }
  /* One width for every layer, so the list reads as a column rather than as
     buttons that happen to be stacked - but sized to its own longest name, not
     stretched across the whole toolbar. */
  .ed-layer-btn { min-width: 96px; text-align: left; }
  .ed-eye { display: flex; align-items: center; justify-content: center;
    width: 24px; height: 22px; padding: 0; background: transparent; color: #cbccc6;
    border: 1px solid transparent; border-radius: 2px; cursor: pointer; }
  .ed-eye:hover { background: #2a2f3d; border-color: #3c445c; }
  .ed-eye.off { color: #5b6172; }
  /* The padlock's resting state is *unlocked*, so it is the dim one: a row of
     lit padlocks would read as "everything is locked". Locked is amber rather
     than the accent blue, which the layer list already spends on "active". */
  .ed-lock { color: #5b6172; }
  .ed-lock.on { color: #e5c07b; }
  .ed-title { color: #65bddb; padding-top: 2px; }
  /* A cross-layer selection stacks one panel per layer, so the inspector can
     outgrow the viewport — it scrolls rather than running off the bottom. */
  .ed-inspector { position: absolute; top: 8px; right: 8px; width: 190px;
    background: rgba(31,36,48,0.92); border: 1px solid #313244; padding: 8px;
    border-radius: 2px; display: flex; flex-direction: column; gap: 10px;
    max-height: calc(100vh - 16px); overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: #3c445c transparent; }
  .ed-group { display: flex; flex-direction: column; gap: 4px; }
  .ed-heading { color: #65bddb; border-bottom: 1px solid #313244; padding-bottom: 2px; margin-bottom: 2px; }
  .ed-field { display: flex; justify-content: space-between; align-items: center; color: #9aa0ac;
    gap: 6px; white-space: nowrap; }
  /* A picker is bounded by the row it is in, whatever its longest option says.
     A <select> sizes itself to its widest option and "min-width: auto" refuses
     to shrink below that, so one long name - a sky called after the place it was
     captured rather than after a file - stretched the control to 404px inside a
     179px panel, overlapping the row above it and running off the edge. The
     option list still opens at full width, which is where the name is read. */
  .ed-field > select { min-width: 0; flex: 0 1 auto; text-overflow: ellipsis; }
  .ed-hint { color: #6b7280; line-height: 1.4; }
  /* A hint about a value the author can still legitimately want. Amber rather
     than red: nothing here is invalid, it is a number with a consequence. */
  .ed-warn { color: #d0a215; }
  .ed-warn:empty { display: none; }
  /* The outliner: the level's real structure, which the canvas cannot show.
     Bottom-left, under the toolbar, and scrolling on its own - a real level is
     a couple of hundred bodies and the list is meant to be scanned rather than
     to fit. */
  .ed-outliner { position: absolute; left: 8px; bottom: 8px; width: 230px;
    background: rgba(31,36,48,0.92); border: 1px solid #313244; padding: 6px;
    border-radius: 2px; display: flex; flex-direction: column; gap: 4px;
    pointer-events: auto; }
  .ed-outliner-head { display: flex; gap: 6px; align-items: center; }
  .ed-outliner-title { color: #65bddb; }
  .ed-outliner-list { display: flex; flex-direction: column;
    max-height: 40vh; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: #3c445c transparent; }
  .ed-twist { padding: 0 6px; min-width: 0; }
  .ed-out-row { display: flex; gap: 4px; align-items: center; cursor: pointer;
    padding: 1px 2px; border-radius: 2px; white-space: nowrap; }
  .ed-out-row:hover { background: #2a2f3d; }
  .ed-out-row.sel { background: #33405a; color: #cbccc6; }
  /* A body row reads as the heading it is; its objects are indented under it and
     dimmer, so the eye runs down the bodies and only drops into one when it is
     looking for a piece. */
  .ed-out-row.body { color: #cbccc6; }
  .ed-out-row.obj { color: #9aa0ac; padding-left: 14px; }
  /* What an object can be, coloured as the canvas already colours it: solid
     geometry plain, decoration teal (its dashed editor outline), a light amber
     (it is the one furniture layer whose colour is authored), an anchor the
     forged iron of the chain it ties. */
  .ed-out-row.obj.decor .ed-out-label { color: #6fb3a8; }
  .ed-out-row.obj.light .ed-out-label { color: #e5c07b; }
  .ed-out-row.obj.anchor .ed-out-label { color: #9a8c7a; }
  .ed-out-row.obj.chain .ed-out-label { color: #9a8c7a; }
  /* A section head inside the list: a chain is not in any body, so it cannot be
     a child row, and the count belongs where the body count is. */
  .ed-out-row.head { color: #6b7280; cursor: default; margin-top: 4px; }
  .ed-out-row.head:hover { background: none; }
  .ed-out-twist { width: 10px; color: #6b7280; text-align: center; flex: none; }
  .ed-out-twist.live:hover { color: #cbccc6; }
  .ed-out-label { overflow: hidden; text-overflow: ellipsis; }
  .ed-out-count { margin-left: auto; color: #6b7280; }
  .ed-test-banner { position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
    background: rgba(31,36,48,0.92); border: 1px solid #65bddb; color: #65bddb;
    font-family: monospace; font-size: 13px; padding: 4px 12px; border-radius: 2px; z-index: 10; }
  `;
  document.head.appendChild(s);
}
