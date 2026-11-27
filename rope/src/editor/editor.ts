import { mushroomParameters, type MushroomParameters } from "../level/mushroom";
import { propsOf, resizeMushroom } from "./model";
// Level editor. Owns its own canvas loop and DOM overlay (toolbar + inspector),
// manipulates an EdModel with the mouse, tests the scene with either controller,
// and saves/loads levels from disk through the dev-server API.

import { Vec2 } from "../engine/vec2";
import { SOUND_MATERIALS, type SoundMaterial } from "../lib/soundMaterial";
import { uiIcon } from "./uiIcons";
import { ROOT_BARK_VARIANTS, ROOT_BARK_LABELS, rootBarkVariant } from "../level/rootAppearance";
import { setRootBark } from "./rootEditing";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { BALL_ZOOM, screenToWorld, worldToScreen, type Camera } from "../render/camera";
import { LETTERBOX_COLOR, VIEW_HEIGHT, VIEW_WIDTH, viewTransform } from "../render/viewport";
import { DEPTH_OF_FIELD_LEVELS } from "../render/settings";
import { attachProjector, ProjectedContext, ViewProjector } from "./projectedCanvas";
import { itemMatrix, planeMatrix, poseMatrix } from "./space3d";
import {
  CameraController,
  REGION_EXIT_MARGIN,
  buildCameraRules,
  pathParamsAt,
  restingCameraZoom,
  type CameraRule,
  type PathKeyField,
} from "../render/cameraController";
import { renderBall } from "../render/renderer";
import { SparkSystem } from "../render/sparks";
import { ChainSnap } from "../render/chainSnap";
import { ChainRetract } from "../render/chainRetract";
import { ROPE_COLOR } from "../render/ropeLay";
import { DebrisSystem } from "../render/debris";
import { LeafShed } from "../render/leafShed";
import { VineSlime } from "../render/vineSlime";
import { BallLevel } from "../level/ballLevel";
// The ball's density, for the panel's "what speed breaks this" readout: the
// number an author is choosing is a speed, and only the ball's own mass turns
// a threshold in newtons into one (see `addBreakFields`).
import { BallPlayer } from "../classes/ballPlayer";
import { BallInputSource } from "../input/ballInput";
import { WHEEL_STATIC_FRICTION } from "../level/tracks";
import { BUTTON_BITS, InputTrace } from "../input/inputTrace";
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
  DEFAULT_SHELTER_FRONT,
  DEFAULT_TRACK_EXIT_RADIUS,
  DEFAULT_TRACK_INTERVAL,
  DEFAULT_TRACK_MAX,
  DEFAULT_TRACK_PULL_G,
  DEFAULT_TRACK_SPEED,
  DEFAULT_TRACK_WHEEL_BASE,
  DEFAULT_TRACK_WHEEL_RADIUS,
  DEFAULT_FOG_FALLOFF,
  DEFAULT_PATH_REACTION,
  DEFAULT_PATH_SOFTNESS,
  DEFAULT_PATH_RANGE_Y,
  DEFAULT_PATH_WIND_BUFFER,
  DEFAULT_WATER_DRAG,
  DEFAULT_WATER_FLOW,
  DEFAULT_BOUNCE,
  DEFAULT_LAUNCH,
  DEFAULT_ROOT_COLOR,
  DEFAULT_SURFACE_FRICTION,
  type BodyKind,
  COLLISION_CATEGORIES,
  COLLISION_CATEGORY_BITS,
  isAreaKind,
  isMover,
  MOVE_EASES,
  MOVE_MODES,
  moveModeCloses,
  moveModeEases,
  type MoveMode,
  spawnMovedTo,
  embeddedLevelOf,
  type LevelSource,
  loadLevelTree,
} from "../level/levelFormat";
import { LAYER_ROPE, MASK_ALL } from "../engine/body";
import { moveAngleAt } from "../level/movers";
import { smoothTangents, splitCubicAtHalf } from "../lib/path";
import { keyValueAt } from "../lib/keyframes";
import { ROD_MAX_RADIUS } from "../lib/rod";

// The three movement modes as an author reads them (see `MoveMode`). The stored
// names are camelCase because they are a format's; the picker says the thing.
const MOVE_MODE_LABELS: Readonly<Record<MoveMode, string>> = {
  backAndForth: "back & forth",
  loop: "loop",
  repeat: "repeat",
};
import {
  arrowEnds,
  bodyIntersectsRect,
  anchorItem,
  chainEnds,
  chainPath,
  chainSegments,
  chainThroughItems,
  chainViaItems,
  isTiedChain,
  nearestChainSpan,
  nearestCornerLocal,
  vineAnchorWorld,
  vineAnchor2World,
  vineRestPath,
  distanceToVine,
  MIN_VINE_LENGTH,
  cloneChain,
  cloneShape,
  cloneVine,
  DEFAULT_CURVE_WIDTH,
  convexHull,
  bodyWithinRect,
  defaultCamera,
  defaultNote,
  defaultShelter,
  distanceToChain,
  ED_LAYERS,
  emptyModel,
  bodyBounds,
  boundsInside,
  itemBounds,
  bodyCentroid,
  bodyLabel,
  bodyMembers,
  bodyRuns,
  objectLabel,
  halfExtents,
  moveSnapPoint,
  isArrowNote,
  isCheckpointNote,
  checkpointBox,
  newItemStyle,
  type EdObject,
  MIN_ARROW_LENGTH,
  DEFAULT_ENVIRONMENT,
  defaultLight,
  modelFromDisk,
  modelToDisk,
  modelToFlatDisk,
  toLevelData,
  newBodyId,
  NOTE_ARROW_BAND,
  NOTE_DEFAULT_ARROW_LENGTH,
  NOTE_DEFAULT_SIZE,
  nearestSurfaceLocal,
  ANCHOR_GIZMO,
  MODEL_MARK,
  MODEL_MIN_SCALE,
  defaultModelRef,
  pickBodyOf,
  pointInBody,
  rotateItemsAbout,
  translateItems,
  flipItemsH,
  bodyFrameOf,
  captureGroupPose,
  type GroupPose,
  placeGroup,
  selectionCentre,
  settledGhosts,
  type SettleGhost,
  originToCentroid,
  setArrowEnds,
  shapeMass,
  polyMustBeConvex,
  PATH_PICK_HALF_WIDTH,
  pathNodes,
  reversePathVerts,
  sharpenPathNodes,
  smoothPathNodes,
  setPathVerts,
  ZERO_HANDLE,
  NO_KEY,
  NO_DEBUG,
  type EdDebug,
  pathDataOf,
  setPolyVerts,
  setBelt,
  setBeltWheel,
  beltInsertWheel,
  beltRemoveWheel,
  beltLap,
  DEFAULT_BELT_LENGTH,
  DEFAULT_BELT_RADIUS,
  DEFAULT_BELT_THICKNESS,
  DEFAULT_BELT_SPEED,
  toLocal,
  centreShapeOrigin,
  scaleShape,
  relink,
  toWorld,
  worldVertices,
  type EdChain,
  type EdVine,
  type EdBodyFrame,
  type EdItem,
  type EdTrack,
  type EdLight,
  type EdShape,
  type EdLayer,
  type EdModel,
  glowModel,
  mushroomModel,
  cloneRouteNode,
  peakSurfaceSpeed,
  routeNode,
  routeOf,
  routeWorldPoints,
  type SceneTag,
  setNodeWorld,
  worldOfNode,
  reconcileTree,
  graftModel,
  subModel,
  membersOf,
  moveNode,
  prefabRootAtOrigin,
  addItem,
  addFrameNode,
  blankItem,
  defaultBody,
  bodyNodeType,
  WORLD_ORIGIN,
  type World3,
  modelFromTree,
  toTree,
  lightNode,
  environmentOfModel,
  NEW_FOG,
} from "./model";
import { pickTagOf } from "../render3d/bodyVisuals";
import { paintLayerAt } from "../render3d/paintLayers";
import { setMaterialLayerSource } from "../render3d/materialLayers";
import { MaterialMasks } from "./materialMasks";
import { ancestors, bodyAbove, canParent, childrenOf, clickTarget, cloneTree, descendants, layersOf, outermostGroup, nextOrder, pathOf, removeSubtree, rename as renameNode, type EdBody, type EdNode } from "./tree";
import { ENVIRONMENT_FIELDS, is3D, lookNodes, newNodeId, poseOfFrame, prefabLibrary, relative2D, scaleLevelTree, setPrefab, walkNodes, TREE_FORMAT, validateTree, type LevelNode, type LevelTree, type NodeType, type PrefabData } from "../level/nodes";
import { materialLabel } from "../formation/materialLayer";
import { readClipboard, writeClipboard } from "./clipboard";
import { FormationJobs, mountJobsPanel } from "./formationJobs";
import { addShapeToGuide, applyJobResult, buildFormationSection, createBackdrop, guideCentre, requestFormationBuild, SHAPE_KINDS, type FormationHost } from "./formationPanel";
import { enclosingItem } from "./formationEdit";
import { formationHash, isStale, newFormationId } from "../formation/recipe";
import { decorationHash, isPainted } from "../formation/decoration";
import { carryTree, frameBetween, guideBounds, SolidGuideView, type SolidSel } from "./solidGuides";
import { SculptController } from "./sculpt";
import { appendEntry, type StackMode } from "../formation/solidStack";
import { guideColor, guideCss } from "./guideColors";
import { CUBE_FACES, ViewCube, type CubeFace } from "./viewCube";
import { headOn } from "./visuals/viewControls";
import { DECORATION_LABELS, DecorationController, decorationLabel, type SurfaceHit } from "./decorationPanel";
import { newPrimitive, nodeAt, replaceAt, scaleTree, scaleTreeAxes, type PrimitiveKind } from "../formation/solidTree";
import { PAINTED_DECORATIONS, scaleLevelData, type DecorationKind, type PaintStamp, type RawLevelData, type SolidNode, type SolidPrim } from "../level/levelFormat";
import { PAINT_API } from "../formation/store";
import {
  ROOT_TIP_WIDTH,
  ROOT_TRUNK_WIDTH,
  branchWidths,
  isRootItem,
  rootAt,
  rootDescendants,
  setRootSprings,
  slideRootJunction,
  syncRoots,
  type RootItem,
} from "./rootEditing";
import { berryAlongAt, growBerry, moveBerry, placeBerry, removeBerry, sizeBerry } from "./berryEditing";
import {
  DEFAULT_BERRY_DENSITY,
  DEFAULT_BERRY_RADIUS,
  DEFAULT_STALK_DENSITY,
  MAX_BERRIES,
  MAX_BERRY_DENSITY,
  MAX_BERRY_RADIUS,
  MAX_STALK_DENSITY,
  MIN_BERRY_DENSITY,
  MIN_BERRY_RADIUS,
  MIN_STALK,
  MIN_STALK_DENSITY,
  DEFAULT_STALK_STRETCH,
  MAX_STALK_STRETCH,
  MIN_STALK_STRETCH,
  berryMass,
  stalkMass,
  stalkReach,
  STARBERRY_STIFFNESS,
  berryOffset,
  berryRadius,
  minBerryVineLength,
  pointAlong,
  restStarberries,
  starberrySettings,
} from "../level/starberry";
import {
  computeChainHandles,
  computeVineHandles,
  computeBerryHandles,
  computeGroupHandles,
  computeHandles,
  drawEditor,
  BODY_MEMBER,
  COMBINE_PICK,
  SELECT,
  CHAIN_DEFAULT_COLOR,
  VINE_DEFAULT_COLOR,
  CHAIN_HIT_PX,
  HANDLE_HIT_PX,
  lightPickRadius,
  depthOf,
  hasDepth,
  setDepth,
  curvePieceCount,
  routeHandlePoints,
  routeMidpoints,
} from "./render";
import {
  CUSTOM_MATERIAL,
  DEFAULT_DENSITY,
  DEFAULT_MATERIAL,
  DEFAULT_THICKNESS,
  MATERIALS,
  MATERIAL_NAMES,
  type MaterialName,
} from "../lib/shapeGeometry";
import { decomposeConvex, isSimpleLoop, normalizeWinding } from "../lib/polygon";
import { deleteLevel, listLevels, listPrefabs, loadLevel, loadPrefab, saveLevel, savePrefab } from "./api";
import {
  HDRI_ASSETS,
  hdriNames,
  SOLID_SURFACE,
  TEXTURE_ASSETS,
} from "../render3d/assets";
import * as THREE from "three";
import { Scene3D, type Scene3DLevel } from "../render3d/scene";
import type { LevelScene } from "../render3d/levelScene";
import { MODEL_ASSETS, MODELS_API, modelMetaFile, isModelName, type ModelMeta } from "../render3d/models";
import { setGameFogCamera } from "../render3d/editorFog";
import {
  cameraDistance,
  focalLengthFromFov,
  FOV_Y_DEG,
  isHeadOn,
  lensOf,
  MAX_ORBIT_PITCH,
  NO_ORBIT,
  poseFromCamera,
  threeY,
  threeRotation,
  unprojectToPlane,
  type CameraOrbit,
  type SceneLens,
  type ViewPose,
  type ViewProjection,
} from "../render3d/space";
import { EditorGizmo, type GizmoAxes, type GizmoHandlers } from "./gizmo";
import {
  itemsBox,
  levelBox,
  ORBIT_RADIANS_PER_PX,
  VisualsWorkspace,
  type Box3,
} from "./visuals/workspace";
import { guidePlaneZ } from "./visuals/guides";
import { EDITOR_FOV_Y_DEG } from "./visuals/viewPose";
import { NdofInput } from "./ndof";
import { surfacePlacement } from "./visuals/surfaceDrop";
import { describe, fieldRow, heading, PANEL_UI_CSS, pruneEmptySections, revealInSection, section, setDefaultOpen } from "./panelUi";
import {
  EMPTY_HINTS as WORKSPACE_EMPTY_HINTS,
  inWorkspace,
  parseWorkspace,
  paintsRocks,
  PRIMARY_SECTIONS,
  readWorkspace,
  sectionShown,
  WORKSPACE_LABELS,
  WORKSPACE_TITLES,
  WORKSPACES,
  workspaceLayers,
  writeWorkspace,
  type Workspace,
} from "./workspaces";
import { World } from "../engine/world";
import { buildLevelBodies, DEFAULT_SPRING_DAMPING, MAX_SPRING_FREQ, worldPlacement } from "../level/buildBodies";
import {
  DEFAULT_VINE_DENSITY,
  vineTargetSpacing,
  DEFAULT_VINE_STIFFNESS,
  DEFAULT_VINE_VISCOSITY,
  LIGHT_LINK_MASS,
  MIN_VINE_DENSITY,
} from "../level/vines";
import {
  digestBall,
  serializeInput,
  worldDigestBall,
  type Recording,
} from "../sim/trace";
import { RunRecording } from "../sim/runRecording";
import type {
  EnvironmentData,
  FormationData,
  DecorationObjectData,
  LevelBodyData,
  LevelCameraData,
  LevelData,
  SceneObjectData,
} from "../level/levelFormat";
// The tree this page was served from, not the commit the dev server booted at
// (see src/sim/treeStamp.ts). Aliased because `commit` and `dirty` are ordinary
// words in an editor that autosaves.
import { selfReplayLine, verifySelfReplay } from "../sim/selfReplay";
import { verifySelfReplayOffThread } from "../sim/selfReplayOffThread";
import { hideToast, showToast } from "../render/toast";
import {
  commit as treeCommit,
  dirty as treeDirty,
  srcHash as treeSrcHash,
} from "virtual:tree-stamp";
import {
  DEFAULT_LIGHT_RANGE,
  LIGHT_SHADOW_BUDGET,
  LIGHT_SHADOW_RADIUS,
} from "../render3d/lights";
import { DEFAULT_WAKE_FALL, DEFAULT_WAKE_RISE } from "../render3d/glow";
import { colorInput } from "./colorPicker";
import {
  readDockWidth,
  readLastLevel,
  readLayerSettings,
  readOpenPrefab,
  readRootWidths,
  readViewSettings,
  writeDockWidth,
  writeLastLevel,
  writeOpenPrefab,
  writeLayerSettings,
  writeRootWidths,
  writeViewSetting,
} from "./prefs";
import { editorViewHref, MAX_ZOOM, MIN_ZOOM, readEditorView, type EditorView } from "./viewUrl";
import { ROOT_BEND_DAMPING, ROOT_BEND_FREQ } from "../level/levelFormat";
import type { EdRoot } from "./model";
import { applyCut, cuttable, joinBodies, planCut } from "./splitJoin";
import { installToolTips, refreshBlocks, setToolName, toolBlock, toolize, toolSet, watchToolbarWidth } from "./toolbar";
import { menuButton } from "./menu";
import type { ToolIconName } from "./toolIcons";
import { SoundSystem } from "../audio/soundSystem";
import { SoundMenu } from "./soundMenu";

type Tool =
  | "select"
  | "rect"
  | "circle"
  | "belt"
  | "poly"
  | "path"
  // The knife: two clicks draw a line, and every polygon or box it crosses
  // edge to edge is cut along it, what no longer touches parted into bodies
  // of their own (editor/splitJoin.ts).
  | "cut"
  | "text"
  | "arrow"
  | "checkpoint"
  | "chain"
  | "vine"
  | "root"
  | "light"
  | "model"
  | "glow"
  // The plane's volumes that are things in the level: a fog region dragged out
  // as a box (`FogRegion2D`), a cave's front wall clicked out as an outline
  // like +Poly's (`Shelter2D`).
  | "fog"
  | "shelter"
  // A minecart track clicked out as a curve is, with a cart placed on it
  // (`Track2D`, docs/minecarts.md).
  | "track";

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
  scene: [
    "select",
    "rect",
    "circle",
    "belt",
    "poly",
    "path",
    "cut",
    "light",
    "model",
    "glow",
    "chain",
    "vine",
    "root",
    "fog",
    "shelter",
    "track",
  ],
  camera: ["select", "rect", "circle", "poly", "path"],
  notes: ["select", "text", "arrow", "checkpoint"],
};


// Kinds a chain may be tied to. An area is a region, not a body - nothing hangs
// off a killzone or a current - so the chain tool passes straight through one.
const CHAINABLE_KINDS: BodyKind[] = ["static", "rigid"];
// A piece the rope passes through (the `chain` box unticked) cannot hold
// a chain either: the loader lands an anchor authored on one on the nearest
// piece the rope CAN hold (`tieablePieces` in level/chains.ts), so the editor
// offers only what the level will actually build - which for a wheel is its
// hub, not its rim.
const chainable = (b: EdItem): boolean =>
  b.object === "collision" && CHAINABLE_KINDS.includes(propsOf(b).kind) && (b.mask & LAYER_ROPE) !== 0;

// What the inspector says when nothing is selected: what the active layer is
// for, and how to put something on it.
const EMPTY_HINTS: Record<EdLayer, string> = {
  scene:
    "Scene layer. Click a body, or pick +Rect / +Circle and drag on the canvas; +Poly clicks out an outline, concave corners and all (Enter or click the first vertex to close, Esc to cancel) - the physics gets it cut into convex pieces, so a notch is one object rather than three overlapping ones. Those draw a COLLISION shape - what the body is made of. What a level LOOKS like is what its bodies carry - formations, their decorations, models - and a shape is drawn in 3D only while its Debug section's draw box is ticked (it starts ticked). +Chain drags a chain from one body to another. New body puts the selected pieces under one new body; drag a row in the scene tree (the right column) onto another to reparent it. +Fog drags out a fog region, which owns its fog (amount, colour, falloff); +Shelter clicks out a cave's front wall, which hides the cave from the sun alone. Ctrl+G groups the selection, so a click selects the group first and a second click goes inside (Ctrl+Shift+G ungroups; Alt+click picks the thing under the pointer itself). The scene tree lists every node and is the way to reach one with no outline, like a light. Rubber-band from empty space: drag left→right to catch what the box encloses, right→left for anything it touches. +Light drops a lamp - drag as you place it to set how far it reaches. A light with no body above it stands on its own (a shaft down a grate, a fill); a lamp you can see goes under the body its fitting is in, so moving the fitting moves the light. Any visible layer can be selected.",
  camera:
    "Camera layer. Click a region, drag to rubber-band select, or pick +Rect / +Circle and drag one out (+Poly clicks out an outline). Tab switches layer.",
  notes:
    "Notes layer. +Text drops a box to type into, +Arrow drags a pointer out, +Checkpoint drops a named place to start from - play with ?checkpoint=NAME to spawn there instead of at the level's spawn, or select one and press ▶ Test. None of the three is drawn in play. Tab switches layer.",
};

// Kinds offered by both kind pickers (toolbar + inspector), in one place so
// they can't drift apart.
const BODY_KINDS: BodyKind[] = ["static", "rigid", "killzone", "force", "water", "finish"];

// How far the pointer must travel before a press that could mean either becomes
// a drag rather than a click, in screen pixels. Small enough that a deliberate
// drag never reads as a click, large enough that a hand shaking on a mouse
// button does not turn a selection into a pan.
const CLICK_SLOP_PX = 4;
// How near a corner a knife's end lands on it, in screen pixels.
const CUT_SNAP_PX = 8;
// The smallest a point-like mark may be to aim at, in screen pixels. The spawn
// marker and a checkpoint are both drawn at the avatar's radius - 16 cm across,
// which is a handful of pixels at the zoom a level is laid out at - so both take
// this as the floor on what a click has to land within. Drawn size is unchanged:
// this is about what can be hit, not about what is seen.
const SMALL_MARK_PICK_PX = 12;
// The gameplay plane in three's frame (z = 0): where a 3D pick meets the
// outlines drawn on it (`raycastItems`).
const GAMEPLAY_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
// (Orbit sensitivity, `ORBIT_RADIANS_PER_PX`, is the Visuals workspace's
// module's, so the two workspaces' orbits are one constant.)

type Drag =
  | { mode: "pan"; lastScreen: Vec2 }
  // Navigating the Visuals workspace's free view (see `VisualsWorkspace`):
  // Alt + middle drag orbits, a middle or right drag pans.
  | { mode: "view" }
  // DROP ON SURFACE (Visuals, Shift-drag of a selected light): the light
  // follows the nearest model surface under the pointer. Written through the
  // gizmo's own handlers (`handlers`), begun at the first real movement so the
  // whole drag is one undo step; a press that never travels is the Shift+click
  // it would otherwise have been (`pick`).
  | {
      mode: "surfaceDrop";
      item: EdItem;
      press: Vec2;
      handlers: GizmoHandlers | null;
      pick: () => void;
    }
  // Turning the 3D view about what it is centred on (see `CameraOrbit`). Middle
  // button, and only while a scene is drawn: in the 2D view there is nothing to
  // orbit, so the button keeps panning there.
  | { mode: "orbit"; lastScreen: Vec2 }
  // Rubber-band select: EVERY left drag with the select tool that does not
  // start on a handle, the gizmo or the spawn marker (Blender's Select Box,
  // since 2026-11-27). `additive` (shift) unions the hits into the existing
  // selection instead of replacing it. `verts` is the shape whose VERTICES the
  // band catches instead of bodies: drawn while a polygon is being edited, a
  // band is asking about that shape's corners, which is the only thing on
  // screen it could sensibly mean once the shape itself is already picked.
  // The press is a click until the pointer leaves `CLICK_SLOP_PX` of `press`
  // (`banding`), and `pick` is what that click means where it landed on
  // something; a click on empty space (no `pick`) clears.
  | {
      mode: "marquee";
      start: Vec2;
      current: Vec2;
      press: Vec2;
      banding: boolean;
      additive: boolean;
      verts: EdItem | null;
      pick?: () => void;
    }
  | { mode: "movePlayer"; grab: Vec2 }
  | { mode: "corner"; body: EdItem; anchor: Vec2 }
  | { mode: "radius"; body: EdItem }
  | { mode: "wake"; body: EdItem }
  // One of a conveyor's wheels (not wheel 0, which is the item's position),
  // dragged like a path vertex: its centre follows the pointer and the other
  // wheels stay put.
  | { mode: "beltWheel"; body: EdItem; index: number }
  // ...and one wheel's radius, by the round grip on its rim.
  | { mode: "beltRadius"; body: EdItem; index: number }
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
  // positions, and the shape's frame stands still through a corner edit
  // (`setPolyVerts`), so the offsets a press captured still name the same
  // corners at the end of the drag.
  | {
      mode: "polyVertex";
      body: EdItem;
      index: number;
      others: Array<{ index: number; offset: Vec2 }>;
      accepted: Vec2;
      // The plane the corner is drawn in (see `move`'s).
      planeZ?: number;
    }
  // One Bézier tangent grip of a camera path. `mirror` keeps the node smooth by
  // writing the opposite handle as the negation of this one; Alt breaks it, so a
  // deliberate cusp is a modifier away rather than unauthorable.
  | { mode: "pathHandle"; body: EdItem; index: number; side: "in" | "out"; mirror: boolean }
  // One node of a body's route follows the pointer (see
  // `LevelBodyData.moveNodes`). `lead` is the body's collision lead, which is
  // where the route is held, and `index` counts the whole node list - so 0 is
  // the body itself, which is never dragged this way because moving the body is
  // what moves it.
  | { mode: "moveWaypoint"; lead: EdItem; index: number }
  // ...and one of that node's two Bezier tangent grips, on exactly the terms a
  // camera path's are: `mirror` keeps the node smooth by writing the opposite
  // handle as the negation of this one, and Alt at the press breaks the pair
  // into a cusp.
  | { mode: "routeHandle"; lead: EdItem; index: number; side: "in" | "out"; mirror: boolean }
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
  // Stringing a chain out from a body. `knots` are the bodies it has been TIED
  // to on the way (Shift-release over a body, see `finishOrTieChainDraw`): a
  // chain with any is a tied chain (`EdChain.through`), and the draft lives on
  // past the release until a plain press ends it on a body or Escape drops it.
  | { mode: "chainDraw"; from: EdItem; local: Vec2; cursor: Vec2; knots: { item: EdItem; local: Vec2 }[] }
  // Re-anchoring one end of an existing chain. It follows the pointer and lands
  // on whatever body it is dropped on, so moving a chain end and moving it to a
  // different body are one gesture.
  | { mode: "chainEnd"; chain: EdChain; end: "a" | "b"; cursor: Vec2 }
  // Moving one of a chain's WRAP POINTS (`EdChain.via`): the same act as
  // re-anchoring an end, landing on the nearest corner of whatever body it is
  // dropped on, since a wrap point is a corner the chain bends around.
  | { mode: "chainVia"; chain: EdChain; index: number; cursor: Vec2 }
  // Pulling a NEW wrap point out of a chain's span (Shift-drag on a selected
  // chain): `index` is the span it was pulled from, so the point lands in the
  // route between that span's two ends. The route follows the pointer until it
  // is dropped on a body, and is abandoned over nothing.
  | { mode: "chainWrapOut"; chain: EdChain; index: number; cursor: Vec2 }
  // Pulling a new vine out of a body: the anchor is fixed in `from`'s local
  // frame and the drag sets the LENGTH rather than reaching for a second body,
  // which is the whole of the difference between a vine and a chain.
  | { mode: "vineDraw"; from: EdItem; local: Vec2; length: number }
  // Pulling out the Bézier handles of the root node just placed (`rootDraft`):
  // `index` is which node.
  | { mode: "rootHandle"; index: number }
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
  // Sliding berry `index`'s root along its vine, by the handle the selected
  // berry shows there. The berry keeps its offset from the root.
  | { mode: "berryPosition"; vine: EdVine; index: number }
  // A berry being dragged off a vine: the press was on the cord `along`
  // metres down it (`root`), and releasing past the click's slop grows a
  // berry where the pointer is. Nothing is written until then.
  | { mode: "berryDraw"; vine: EdVine; along: number; root: Vec2; cursor: Vec2; press: Vec2 }
  // `made`: the body drawn for it, whose class is asked on release.
  | { mode: "draw"; body: EdItem; start: Vec2; made: string | null };

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


// The way out of a test: Esc, or Space, since the ball's input source binds no
// keyboard at all (input/ballInput.ts).
const TEST_BANNER = "TESTING - Space or Esc to return to the editor";

// Angles are authored in degrees everywhere in the inspector (`rot°`), and
// stored in radians everywhere else.
const deg = (r: number): number => (r * 180) / Math.PI;
const rad = (d: number): number => (d * Math.PI) / 180;

export function startEditor(canvas: HTMLCanvasElement, sceneCanvas?: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  // The overlay drawn through the 3D view when it is turned (see the frame
  // loop and projectedCanvas.ts).
  const overlayProjector = new ViewProjector();
  const projectedOverlay = new ProjectedContext(ctx, overlayProjector);

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
  // THE WORKSPACE: Level (the editor as it has always been, driven by the 2D
  // camera) or Visuals (a free 3D camera, the overlay's marks drawn into the
  // scene - see editor/visuals/workspace.ts and docs/editor-visuals.md). One
  // editor either way: the model, the selection, the layer, the tool and the
  // inspector carry across a switch; what changes is how the view is driven,
  // what stands in for the overlay, and where a press lands.
  //
  // Declared before everything that asks `inScene`, and built lazily below
  // once the camera and the model exist (`visuals` is null without WebGL).
  //
  // ONE 3D VIEW (2026-11-22, plans/editor-ux-pass.md). The editor no longer
  // has two workspaces: the workspace object is kept as the editor's CAMERA -
  // its pose and Blender's navigation - with its guides off, and the overlay
  // is drawn through the pose at any angle (projectedCanvas.ts). So a press is
  // resolved by the one path, and a turned view is simply `orbited`.
  let visuals: VisualsWorkspace | null = null;
  // THE SPACEMOUSE (editor/ndof.ts, docs/editor.md "SpaceMouse"): read once a
  // frame and flown through the pose (`VisualsWorkspace.ndof`). Its side
  // buttons are keys (2026-11-26): the left (spacenavd's 0) Escape, the right
  // (1) Enter, each a keydown and keyup dispatched where the focus is, so it
  // reaches every handler the key would - a draft, a transform, a picker, a
  // menu, the paint brush's confirm and cancel.
  const NDOF_KEYS: Record<number, { key: string; code: string; keyCode: number }> = {
    0: { key: "Escape", code: "Escape", keyCode: 27 },
    1: { key: "Enter", code: "Enter", keyCode: 13 },
  };
  const ndof = new NdofInput((button) => {
    const k = NDOF_KEYS[button];
    if (!k) return;
    const target = document.activeElement ?? document.body;
    for (const type of ["keydown", "keyup"] as const) {
      target.dispatchEvent(new KeyboardEvent(type, { ...k, bubbles: true, cancelable: true }));
    }
  });
  let ndofLast = -1;
  function flyNdof(now: number): void {
    const dt = ndofLast < 0 ? 0 : Math.min(0.1, (now - ndofLast) / 1000);
    ndofLast = now;
    if (!visuals?.active || mode !== "edit" || dt <= 0) return;
    if (!visuals.ndof(ndof.axes, dt, projection === "orthographic")) return;
    // A cube swing in flight gives way to the cap, as it does to the wheel.
    viewSwing++;
    cameraFromPose();
    refreshOrbitBtn();
  }
  // Is a scene drawn this frame? Whenever there is WebGL to draw one.
  const sceneShown = (): boolean => scene3d !== null && viewMode !== "2d";
  // How much of the scene the 2D overlay is responsible for. With a scene under
  // it the overlay drops every fill, since the scene draws the level (see
  // `drawEditor`).
  const overlayLayers = (): "fill" | "outline" => (sceneShown() ? "outline" : "fill");
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
  //
  // Since the one 3D view, the camera is the pose (`visuals.view`), and the
  // orbit the 2D camera kept is always none: the pose is what turns.
  const orbit: CameraOrbit = { yaw: 0, pitch: 0 };
  // Is the view anything but the gameplay plane head on, framed as the 2D
  // camera frames it? Then the overlay is drawn projected through the pose and
  // presses are resolved through the scene's camera; head on, the plain
  // transform is the same picture (asserted by `cli render3d`).
  const orbited = (): boolean => {
    if (scene3d === null || viewMode === "2d") return false;
    const p = visuals?.view;
    if (!p) return !isHeadOn(orbit);
    return p.yaw !== 0 || p.pitch !== 0 || p.target.z !== lensOf(model.camera).zOffset;
  };
  // WHERE A PRESS IS RESOLVED. Head on in the Level workspace the 2D camera's
  // scale and offset are the answer, and the overlay is drawn; anywhere else -
  // the Level workspace turned, or the Visuals workspace at all - a screen
  // position means a world point only through the ray that drew it, and the
  // overlay is not on screen. Every branch that used to ask "is the view
  // turned" asks this, and then, where the two differ, which of the two it is:
  // a turned Level view offers only select and move, the Visuals workspace
  // draws its own chrome into the scene (the guides) and offers the gestures
  // those marks make possible.
  const inScene = (): boolean => orbited();
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
  // THE VIEW CUBE (viewCube.ts): top right of the viewport, the lens under it;
  // the cube itself in the 3D workspaces only.
  let viewCube: ViewCube | null = null;
  function setProjection(p: ViewProjection): void {
    projection = p;
    viewCube?.setProjection(p);
  }
  // A face of the cube clicked: the view swung to look from that side, about
  // the same target and at the same distance, eased over `VIEW_SWING_MS` as
  // Blender's smooth view is (a cut would lose which way it went). Front is
  // the gameplay plane head on, so it ends as "Align camera to plane" does.
  const VIEW_SWING_MS = 220;
  let viewSwing = 0;
  function swingView(face: CubeFace): void {
    const pose = visuals?.view;
    const to = CUBE_FACES.find((f) => f.face === face);
    if (!visuals || !pose || !to) return;
    const from = { yaw: pose.yaw, pitch: pose.pitch };
    // The shorter way round; at a pole the yaw is the face's own (Top and
    // Bottom have the front at the foot of the screen).
    let dYaw = (to.yaw - from.yaw) % (2 * Math.PI);
    if (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    if (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    const run = ++viewSwing;
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = visuals?.view;
      if (run !== viewSwing || !p || mode !== "edit") return;
      const t = Math.min(1, (now - t0) / VIEW_SWING_MS);
      const e = t * t * (3 - 2 * t);
      visuals!.setView({ ...p, yaw: from.yaw + dYaw * e, pitch: from.pitch + (to.pitch - from.pitch) * e });
      cameraFromPose();
      if (t < 1) requestAnimationFrame(step);
      else {
        // Exactly on the axis, the yaw folded back into one turn.
        visuals!.setView({ ...visuals!.view!, yaw: to.yaw, pitch: to.pitch });
        if (face === "front") resetView();
        cameraFromPose();
        refreshOrbitBtn();
      }
    };
    requestAnimationFrame(step);
  }
  let resetViewBtn: HTMLButtonElement | null = null;
  function refreshOrbitBtn(): void {
    resetViewBtn?.classList.toggle("active", orbited());
  }
  // `Align camera to plane` and **Numpad 1** (Blender's front view): the
  // gameplay plane head on, where the view is looking, at the zoom it has.
  function resetView(): void {
    cameraFromPose();
    visuals?.resetView();
    resetOrbit();
    refreshOrbitBtn();
  }
  // The 2D camera read off the pose: where it looks on the plane and the zoom
  // that frames the plane at the pose's height (the inverse of `headOn`).
  // Every frame, so everything sized or resolved by the 2D camera - the
  // overlay's line weights, the address bar, a paste - follows the view.
  function cameraFromPose(): void {
    const p = visuals?.view;
    if (!p || mode !== "edit") return;
    camera.position = new Vec2(p.target.x, threeY(p.target.y));
    camera.zoom = camera.viewportHeight / (2 * p.halfHeight * PIXELS_PER_METER);
  }
  // ...and the other way: the pose head on at the 2D camera, after a load or
  // anything else that places the view by the camera.
  function poseFromCameraNow(): void {
    visuals?.setView(headOn(camera, editorLens()));
  }
  // The lens the editor's view is navigated through: the level's depth, the
  // editor's own wide field of view (`EDITOR_FOV_Y_DEG`).
  function editorLens(): SceneLens {
    return { ...lensOf(model.camera), fovYDeg: EDITOR_FOV_Y_DEG };
  }
  // The solid formation being edited: the selected formation, or the one in
  // the selected body. Null for none, or for one guided by collision.
  function activeSolidFormation(): EdItem | null {
    const f = model.items.find(
      (i) => i.object === "formation" && i.formation?.guide.kind === "solid" && (selectedIds.has(i.id) || selectedBodyIds.has(i.unit)),
    );
    return f ?? null;
  }
  // The Shift+A menu: a column of shapes at the pointer; a pick adds one in
  // the middle of the selected guide (`guideCentre`), or with no guide
  // selected a new guide where the view is looking (`addPrimitive`, the dock's
  // Primitives). Esc or a click elsewhere closes it.
  let shapeMenu: HTMLElement | null = null;
  function closeShapeMenu(): void {
    shapeMenu?.remove();
    shapeMenu = null;
  }
  function showShapeMenu(f: EdItem | null): void {
    closeShapeMenu();
    const menu = el("div", "ed-shape-menu");
    const title = el("div", "ed-shape-menu-title");
    title.textContent = f ? "Add to guide" : "Add primitive";
    menu.appendChild(title);
    for (const { label, kind } of SHAPE_KINDS) {
      menu.appendChild(
        button(label, () => {
          closeShapeMenu();
          if (!f) {
            addPrimitive(kind);
            return;
          }
          addShapeShown(f, kind);
        }),
      );
    }
    // At the pointer, which is kept in the canvas's own coordinates.
    const box = canvas.getBoundingClientRect();
    const p = lastPointerScreen ?? new Vec2(box.width / 2, box.height / 2);
    menu.style.left = `${box.left + p.x}px`;
    menu.style.top = `${box.top + p.y}px`;
    root.appendChild(menu);
    shapeMenu = menu;
    setTimeout(() => window.addEventListener("pointerdown", (ev) => { if (!menu.contains(ev.target as Node)) closeShapeMenu(); }, { once: true }), 0);
  }
  // A SCENE TREE ROW'S MENU (a right click on the row): what can be done to
  // that node from where it is listed - Make root in an open prefab (Godot's
  // "Make Scene Root"), Rename, Delete. An action that cannot be taken is
  // shown greyed with why.
  let nodeMenu: HTMLElement | null = null;
  function closeNodeMenu(): void {
    nodeMenu?.remove();
    nodeMenu = null;
  }
  function showNodeMenu(n: EdNode, label: HTMLElement, x: number, y: number): void {
    closeNodeMenu();
    closeShapeMenu();
    const menu = el("div", "ed-shape-menu");
    const title = el("div", "ed-shape-menu-title");
    title.textContent = n.name;
    menu.appendChild(title);
    const item = (text: string, why: string | null, run: () => void): void => {
      const b = button(text, () => {
        closeNodeMenu();
        run();
      });
      if (why) {
        b.disabled = true;
        b.title = why;
      }
      menu.appendChild(b);
    };
    if (prefabMode) item("Make root", makeRootRefusal(n.id), () => makePrefabRoot(n.id));
    // The row as it stands when chosen: picking it on the right click may
    // have rebuilt the tree under the label the menu was opened on.
    item("Rename", null, () => {
      const live = nodeRows.get(n.id)?.querySelector<HTMLElement>(".ed-out-label") ?? label;
      const node = model.tree.nodes.get(n.id);
      if (node) renameNodeInline(node, live);
    });
    const undeletable = n.extra["spawn"] === true ? "the level's spawn is not deleted" : prefabMode && n.id === prefabRootId ? "a prefab needs its root (Make root another node first)" : null;
    item("Delete", undeletable, () => {
      pickNodeRow(n, false);
      deleteSelected();
    });
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    root.appendChild(menu);
    nodeMenu = menu;
    const away = (ev: Event): void => {
      if (ev instanceof KeyboardEvent && ev.code !== "Escape") return;
      if (ev instanceof PointerEvent && menu.contains(ev.target as Node)) return;
      closeNodeMenu();
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", away, true);
    };
    setTimeout(() => {
      window.addEventListener("pointerdown", away, true);
      window.addEventListener("keydown", away, true);
    }, 0);
  }

  // What **F** frames: the items' box in three's frame, each at the depth it
  // really occupies - a solid guide (a backdrop, metres behind the plane) by
  // the guide drawn, everything else by its outline on the plane at the depth
  // it is drawn at (`itemsBox`). Null for nothing.
  function focusBox(items: readonly EdItem[]): Box3 | null {
    const box = new THREE.Box3();
    const flat: EdItem[] = [];
    for (const it of items) {
      const solid = it.object === "formation" ? solidView?.boxOf(it.id) : null;
      // A decoration is what grew, where it grew: its mark on the plane is a
      // 15 cm glyph at the wrong depth, so F on a fern came in to a few
      // centimetres of its root (2026-11-25).
      // A model the same: its mark is a small cube at its origin, so a 2.6 m
      // length of track framed as a few centimetres at one end (2026-11-26).
      const drawn = !solid && (it.object === "decoration" || it.object === "model") ? drawnBox(it.id) : null;
      if (solid) box.union(solid);
      else if (drawn) box.union(drawn);
      else flat.push(it);
    }
    const rest = itemsBox(flat);
    if (rest) box.union(new THREE.Box3(new THREE.Vector3(rest.min.x, rest.min.y, rest.min.z), new THREE.Vector3(rest.max.x, rest.max.y, rest.max.z)));
    return box.isEmpty() ? null : { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
  }
  // What the scene draws of an item, as a box in three's world: every object
  // carrying its pick tag (`pickTagOf`). Null when nothing is drawn of it.
  function drawnBox(id: number): THREE.Box3 | null {
    const tag = sceneObjectOfItem.get(id);
    if (tag === undefined || !scene3d) return null;
    const box = new THREE.Box3();
    scene3d.scene.traverse((o) => {
      if (o.userData["pickTag"] === tag) box.union(new THREE.Box3().setFromObject(o));
    });
    return box.isEmpty() ? null : box;
  }
  // The view taken to the game's camera at rest where it is looking
  // (`gameFogCameraZ` is the same camera, asked for its depth).
  function gameCameraView(): void {
    if (!visuals) return;
    const target = visuals.view?.target;
    const centre = target ? new Vec2(target.x, threeY(target.y)) : camera.position;
    if (fogRulesRev !== modelRev) {
      fogRulesRev = modelRev;
      const data = toLevelData(model);
      fogRules = buildCameraRules(data.cameraRegions ?? [], data.cameraPaths ?? []);
    }
    const zoom = restingCameraZoom(fogRules, centre, BALL_ZOOM);
    visuals.setView(headOn({ position: centre, zoom, viewportWidth: VIEW_WIDTH, viewportHeight: VIEW_HEIGHT }, lensOf(model.camera)));
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
  // The scene is rebuilt from the model whenever something it DRAWS changes
  // (`sceneKeyOf`), and it is rebuilt whole: correctness beats cleverness where
  // the alternative is a diff of what an edit touched. What it is not rebuilt
  // for is an edit to collision the scene does not draw - a corner of a dressed
  // body's outline - because a rebuild is not cheap: measured 2026-10-07 on
  // `ball` at ~30 ms of building plus nine shader programs re-linked, every
  // frame of a vertex drag. It is debounced to a frame rather than run per
  // edit, so a drag rebuilds at most once per rendered frame.
  let sceneLevel: Scene3DLevel | null = null;
  let sceneRev = -1;
  // What the scene on screen was built from (`sceneKeyOf`), and how many times
  // it has been built - the highlight is painted once per build, not per edit.
  let sceneKey: string | null = null;
  let sceneBuilds = 0;
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
  if (scene3d) {
    visuals = new VisualsWorkspace({
      scene: scene3d,
      camera2d: () => camera,
      // The editor's own lens at the level's depth (`editorLens`).
      lens: editorLens,
      canvasSize: () => ({ width: cssW, height: cssH }),
    });
    // Its camera alone: the overlay is drawn projected, not as guides.
    visuals.showGuides = false;
  }

  // --- state ----------------------------------------------------------------
  let model: EdModel = emptyModel();

  // THE WORKSPACE (editor/workspaces.ts, docs/editor.md "Workspaces"): 2D,
  // Formations or Decorations - how the view moves, what the dock offers,
  // what is drawn and picked, and which inspector sections show. The
  // address bar's wins over the one this browser last used.
  let workspace: Workspace = parseWorkspace(new URLSearchParams(location.search).get("ws")) ?? readWorkspace();
  setDefaultOpen(PRIMARY_SECTIONS);
  // Is an item part of the workspace (drawn, picked)?
  const inWs = (b: EdItem): boolean => inWorkspace(workspace, b, in3D(b));
  // Is an item in the scene rather than the plane: carried by no body, and a
  // rock or under a 3D frame (what a "3D body" was before the tree).
  const in3D = (i: EdItem): boolean =>
    i.bodyOf === null &&
    (i.object === "formation" || ancestors(model.tree, i.node).some((a) => a.type === "Node3D" || a.type === "Formation3D"));
  // Is a layer drawn and picked: shown in the layer list, and one the
  // workspace works on.
  const layerShown = (l: EdLayer): boolean => visibleLayers.has(l) && (workspaceLayers(workspace)?.includes(l) ?? true);
  // Chains, vines and berries are the plane's, the 2D workspace's alone.
  const planeFurniturePickable = (): boolean => workspace === "2d" && visibleLayers.has("scene") && !lockedLayers.has("scene");

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
  // A SET of node ids (bodies, groups, frames): grouping, reparenting and
  // deleting act on several at once, and the scene tree is where several are
  // picked. Shift or Ctrl on a scene-tree row extends it, exactly as they
  // extend the item selection.
  const selectedBodyIds = new Set<string>();
  // The one body being edited, or null when none or several are. A body panel
  // shows one body's transform, and there is no sane transform for a set.
  const soleBodyId = (): string | null =>
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
  // One BERRY of a berry vine, picked out of it: what the gizmo moves and
  // Delete removes. Only meaningful while its vine is the one thing selected
  // (`currentBerry`), so every path that changes the selection drops it
  // without having to say so.
  let selectedBerry: { vineId: number; index: number } | null = null;
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
  // ...and the same second level for a mover's ROUTE, as indices into one body's
  // node list. A separate selection rather than a third arm of the one above,
  // because a route is not a shape: it belongs to a body that has a shape of its
  // own, so a body can perfectly well have a polygon vertex and a route node
  // picked at once and the two must not stand for each other.
  //
  // It carries the BODY it indexes, and that is the whole reason it is a record
  // rather than a bare set: an index means nothing without the list it indexes,
  // and a set alone would have to be cleared at every one of the ten places a
  // selection changes - miss one and node 2 of the body just deselected reads as
  // node 2 of the body just selected. Carrying the id makes a stale pick
  // impossible to express instead of merely unlikely (`selectedRouteNodes` is
  // the one reader, and it asks whose nodes these are).
  let routeSel: { bodyId: string; nodes: Set<number> } | null = null;
  const NO_NODES: ReadonlySet<number> = new Set<number>();
  // An empty selection, for drawing the overlay as if nothing were selected.
  const NO_IDS: ReadonlySet<number> = new Set<number>();
  const NO_NODE_IDS: ReadonlySet<string> = new Set<string>();
  const NO_ITEMS: readonly EdItem[] = [];
  // The layers the overlay draws: the list's visible ones the workspace works
  // on (`layerShown`).
  let shownLayersCache: { key: string; set: ReadonlySet<EdLayer> } | null = null;
  function shownLayers(): ReadonlySet<EdLayer> {
    const key = `${workspace}|${[...visibleLayers].join(",")}`;
    if (shownLayersCache?.key !== key) shownLayersCache = { key, set: new Set(ED_LAYERS.filter(layerShown)) };
    return shownLayersCache.set;
  }
  let tool: Tool = "select";
  let placingMushroom = false;
  // The class the last drawn shape's new body was given (`offerParentPick`),
  // which the next one is given too until another is picked.
  let newKind: BodyKind = "static";
  // The menu asking for that class, while it is open.
  let parentPick: { body: string; menu: HTMLElement } | null = null;
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
  // Both sets open as this browser last left them (prefs.ts), applied at boot
  // through the same setters a click uses. Until then the setters are only
  // painting the defaults, which must not overwrite what is stored.
  let layerPrefsLive = false;
  function saveLayerState(): void {
    if (!layerPrefsLive) return;
    writeLayerSettings({
      hidden: ED_LAYERS.filter((l) => !visibleLayers.has(l)),
      locked: ED_LAYERS.filter((l) => lockedLayers.has(l)),
    });
  }
  // The toolbar's view toggles open as this browser last left them
  // (prefs.ts); each one's change writes itself back.
  const viewSettings = readViewSettings();
  let snapOn = viewSettings.snap;
  // GUIDES AND ROCKS in the Formations workspace (docs/editor.md): whether
  // every formation's guide is drawn and whether every generated rock is,
  // and per formation an override of the two (`formationView`), set from
  // the dock's Guide / Rock / Both or Tab. Setting either global clears the
  // overrides, so it applies to every formation in the level. Outside
  // Formations the rocks are always drawn and the guides never.
  let showGuides = viewSettings.guides;
  let showRocks = viewSettings.rocks;
  // The Decorations dock's "Collision": the collision outlines over the
  // rocks there, drawn and not picked (`shownModel`).
  let showCollisionOutlines = viewSettings.collision;
  type FormationView = "guide" | "rock" | "both";
  const formationView = new Map<number, FormationView>();
  let formationViewRev = 0;
  // Sculpt mode (editor/sculpt.ts), made with the Formations dock below. The
  // formation being sculpted shows neither guide nor rock: Sculpt draws its
  // working mesh in their place.
  let sculptCtl: SculptController | null = null;
  const guideShown = (f: EdItem): boolean => {
    if (sculptCtl?.itemId === f.id) return false;
    const o = formationView.get(f.id);
    return o ? o !== "rock" : showGuides;
  };
  const rockShown = (f: EdItem): boolean => {
    if (sculptCtl?.itemId === f.id) return false;
    const o = formationView.get(f.id);
    return o ? o !== "guide" : showRocks;
  };
  // A formation's guide colour, by its id (guideColors.ts).
  const guideHex = (f: EdItem): number => guideColor(f.formation?.id ?? String(f.id));
  const guideCssOf = (f: EdItem): string => guideCss(f.formation?.id ?? String(f.id));
  // The overlay's collision guides in Formations (render.ts).
  const formationGuideView = { shown: guideShown, color: guideCssOf };
  // Whether the editor's own view draws the level's fog. Off by default: the
  // haze is the player's view of the level, and through it a distant piece is
  // hard to judge. ▶ Test always draws it. A view setting like `snapOn`, so it
  // is not written into the level, and remembered with the others.
  let fogInEditor = viewSettings.fog;
  // Whether the 3D scene draws EVERY collision shape's debug geometry, ticked or
  // not, here and in ▶ Test - to see the collision under a dressed level
  // without flipping, and then having to remember to unflip, each shape's own
  // `draw`. A view setting like `fogInEditor`, held by the renderer
  // (`Scene3D.setAllDebugShown`), so no shape's `debug` changes and a test's
  // recording carries the level as authored.
  let allDebugShown = viewSettings.allDebug;
  // Whether the ball's reflection probe and the pools' mirror are drawn, here
  // and in ▶ Test. Each compiles a second program for every material it sees
  // (the probe draws untone-mapped into a linear target), first-use, mid-run:
  // without the game's prewarm, a test paid 100-140 ms GPU-process stalls
  // each time new scenery came into one of them (trace 2026-10-09). A view
  // setting held by the renderer, never written into the level.
  let reflectionsOn = viewSettings.reflections;
  // Whether the sun and the lamps cast shadows, here and in ▶ Test. The shadow
  // pass compiles a depth program per kind of caster the first time one is
  // inside a shadow camera, mid-run (a 44 ms frame in the same trace). A view
  // setting like `reflectionsOn`; no light's `castShadow` changes.
  let shadowsOn = viewSettings.shadows;
  // Whether the water is drawn, here and in ▶ Test, for the same reason: its
  // shaders compile the first time a body of it comes into view. The sim's
  // water is untouched. A view setting like `reflectionsOn`.
  let waterShown = viewSettings.water;
  // Whether the roots are grown and drawn, here and in ▶ Test: an edit to a
  // branched root regrows its mesh, which off skips while one is drawn and
  // reshaped. The sim's roots are untouched. A view setting like `waterShown`.
  let rootsShown = viewSettings.roots;
  // Whether the bodies' look (formations, decorations, models) is drawn, here
  // and in ▶ Test: off, the collision and what the game draws itself stand
  // alone. A view setting like
  // `reflectionsOn`.
  let blenderSceneShown = viewSettings.scene;
  // A remembered toggle may open off, which the renderer has to be told once;
  // it keeps each across every rebuild after.
  if (scene3d) {
    scene3d.setAllDebugShown(allDebugShown);
    scene3d.setReflectionProbe(reflectionsOn);
    scene3d.setPoolMirror(reflectionsOn);
    scene3d.setShadows(shadowsOn);
    scene3d.setWaterShown(waterShown);
    scene3d.setRootsShown(rootsShown);
    scene3d.setSceneShown(blenderSceneShown);
  }
  const gridStep = 0.05; // snap spacing: fixed 5 cm (half the backdrop's 10 cm minor grid)
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
      try {
        settleGhostCache = settledGhosts(model);
        noteBuildError(null);
      } catch (err) {
        settleGhostCache = [];
        noteBuildError(err);
      }
    }
    return settleGhostCache;
  }
  // What the level's build refuses about the model as it stands, or null. The
  // editor builds the level from the model on every edit (the settled ghosts
  // above, the 3D scene), and most of what the build would refuse the editor
  // cannot author in the first place - but a BELT is valid only on a static
  // body that does not move, which is a fact about the body and not the shape,
  // and a kind change or a merge can break it after the belt is drawn. Said in
  // the title rather than thrown, so the editor keeps running and the author
  // sees what to undo; the file still saves, and the game refuses it loudly.
  let buildError: string | null = null;
  // A one-off message in the status line, for an edit that quietly took
  // something with it (a waking light turned into a spot loses its `wake`).
  // Cleared after a few seconds rather than by the next edit, so it is read.
  let notice: string | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  function noteBuildError(err: unknown): void {
    const msg = err === null ? null : err instanceof Error ? err.message : String(err);
    if (msg === buildError) return;
    buildError = msg;
    if (msg) console.warn("[editor] the level does not build:", msg);
    updateTitle();
  }
  let drag: Drag | null = null;
  // Vertices clicked out so far for a polygon in progress, in world metres.
  // Drawing a polygon is a run of clicks rather than one drag, so it needs state
  // that outlives a mouse gesture — unlike every other tool.
  // A run-of-clicks draft, and which tool is drafting it: `+Poly` closes into an
  // outline, `+Path` ends open as a camera path. One draft rather than two so
  // Esc, Enter, the title readout and the preview cannot drift apart per tool.
  let polyDraft: { kind: "poly" | "path" | "shelter" | "track"; verts: Vec2[] } | null = null;
  // A knife being drawn (the Cut tool): where its first click landed.
  let cutDraft: { from: Vec2 } | null = null;
  // A ROOT being drawn (`+ Root`, docs/roots.md): its nodes so far in world
  // metres and each node's Bézier handles (pulled out by dragging as it is
  // placed), the widths it will taper between, and - for a branch - the root
  // it grows out of and where along it. Kept apart from `polyDraft` because it
  // is a curve with handles and a parent rather than a run of corners.
  let rootDraft: {
    verts: Vec2[];
    handles: { in: Vec2; out: Vec2 }[];
    width: number;
    tip: number;
    from: { item: RootItem; at: number } | null;
  } | null = null;
  let dragPushed = false; // history snapshot taken for the in-progress drag?
  let nudging = false; // arrow-key run in progress? (coalesces into one undo step)

  // --- formations -------------------------------------------------------------
  // The dev server's job runner (src/server/formations.ts): every build any
  // tab asked for, shown in the Jobs panel, and a finished one recorded on the
  // formations it was built for (`applyJobResult`) - which is an edit like any
  // other, so it autosaves and rebuilds the scene to draw the new rock.
  const formationJobs = new FormationJobs();
  // The node of a solid guide the Formation panel has picked: what the gizmo
  // moves while its formation or body is selected.
  let solidSel: SolidSel | null = null;
  function currentSolidSel(): SolidSel | null {
    const sel = solidSel;
    if (!sel) return null;
    const it = model.items.find((i) => i.id === sel.itemId);
    if (!it || it.formation?.guide.kind !== "solid" || !(selectedIds.has(it.id) || selectedBodyIds.has(it.unit))) return null;
    return nodeAt(it.formation.guide.tree, sel.path) ? sel : null;
  }
  // The solid guides, drawn through the scene in both workspaces.
  const solidView = scene3d ? new SolidGuideView(() => {}) : null;
  if (solidView) scene3d!.editorLayer.add(solidView.group);
  // MATERIAL LAYERS drawn live (materialMasks.ts): the library, the bakes
  // onto each rock and each patch's mask as it is painted. What the scene
  // draws for one changing builds the scene again (its key holds it,
  // `sceneKeyOf`).
  const materialMasks = new MaterialMasks(
    () => model,
    formationJobs,
    () => {
      sceneRev = -1;
    },
    () => {
      rebuildMaterialPalette();
      rebuildInspector();
    },
  );
  if (scene3d) setMaterialLayerSource((o) => materialMasks.draw(o));
  void materialMasks.refreshLibrary();
  // The decorations' gestures, and the strokes being painted.
  const decorations = new DecorationController({
    model: () => model,
    jobs: formationJobs,
    library: (material) => materialMasks.libraryOf(material),
    materials: () => materialMasks.materials,
    drawsLive: (d) => materialMasks.drawsLive(d),
    beginAction: () => beginAction(),
    markDirty: () => markDirty(),
    rebuildInspector: () => rebuildInspector(),
    select: (ids) => {
      selectedIds.clear();
      selectedBodyIds.clear();
      for (const id of ids) selectedIds.add(id);
      rebuildInspector();
    },
    lens: () => model.camera?.focalLength,
  });
  if (scene3d) scene3d.editorLayer.add(decorations.preview, decorations.cursor.object);
  // Where a decoration gesture lands: the formation's rock under the pointer.
  // The palette's placing (`decorations.anyRock`) lands on whichever generated
  // rock is under the pointer.
  function decorationHit(scr: Vec2): SurfaceHit | null {
    if (!paintsRocks(workspace) || !visuals) return null;
    const target = decorations.target(model.items.filter((i) => selectedIds.has(i.id)));
    const any = target === null && decorations.anyRock;
    if (target === null && !any) return null;
    const accept = (id: number | undefined): boolean =>
      id !== undefined && (any ? decorations.isRock(id) && !itemHidden(itemOf(id)) : id === target);
    const hit = visuals.surfaceAt(scr, (tag) => accept(itemOfSceneObject.get(tag as SceneTag)));
    if (!hit) return null;
    return {
      itemId: any ? itemOfSceneObject.get(hit.tag as SceneTag)! : target!,
      point: new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
    };
  }
  const formationHost: FormationHost = {
    model: () => model,
    jobs: formationJobs,
    solidSel: () => currentSolidSel(),
    setSolidSel: (sel) => {
      solidSel = sel;
      rebuildInspector();
    },
    beginAction: () => beginAction(),
    markDirty: () => markDirty(),
    rebuildInspector: () => rebuildInspector(),
    bodyName: (bodyId) => {
      const members = bodyMembers(model.items, bodyId);
      // Its name when it has one, which is what a level's author knows it by.
      return model.tree.nodes.get(bodyId)?.name || `body #${bodyIndexOf(bodyId)}`;
    },
    sculpt: (item) => enterSculpt(item),
    sculpting: () => sculptCtl?.itemId ?? null,
  };
  formationJobs.onFailed((job) => materialMasks.onJob(job));
  formationJobs.onDone((job) => {
    const regenerated = applyJobResult(model, job);
    if (regenerated.length) {
      markDirty();
      rebuildInspector();
      // Their decorations follow the new rocks (`afterRegenerate`), and the
      // material layers' masks are made over them again.
      for (const f of regenerated) {
        decorations.afterRegenerate(f);
        if (f.formation?.built) materialMasks.forgetRock(f.formation.built.hash);
      }
    }
    if (decorations.applyResult(job)) {
      markDirty();
      rebuildInspector();
    }
    materialMasks.onJob(job);
  });

  // PREFABS (plans/node-tree.md "Prefabs"): shared assets that are editable
  // node trees, one file each (`prefabs/<name>.json`), placed in a level as
  // INSTANCES that may override any property of any node inside them. The
  // Prefabs tab (beside Level, in every workspace) is their library: place
  // one, open one to edit it, make a new one, or save the selected node as one
  // (it is replaced by an instance of what it became). It took the place of
  // the Assets tab, whose reusable rocks are prefabs now.
  //
  // Opening a prefab edits it IN PLACE OF the level, with every tool: the
  // level's session (its model, its undo, its name) is put aside and given
  // back after, and the level is read again on the way back so every
  // instance of the prefab shows the edit.
  let prefabMode = false;
  let prefabName: string | null = null;
  // THE OPEN PREFAB'S ROOT, by id. A prefab is a scene with ONE root node, as
  // a Godot scene is: what is saved is that node and everything under it,
  // its id and class kept, and anything an edit leaves at the top beside it -
  // a placed prefab, a body drawn into nothing, a paste - is moved under it
  // (`adoptPrefabStrays`). Until 2026-11-26 a second top-level node was
  // wrapped at save in a new group with a NEW id, which changed the root's
  // id and class on every save: every instance's overrides of the root came
  // loose, and a body-rooted prefab became a group the gizmo could not move.
  let prefabRootId: string | null = null;
  // What a save of the open prefab last refused, said once rather than on
  // every edit while it stands.
  let prefabRefusal: string | null = null;
  let prefabsShown = false;
  let prefabSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let prefabNames: string[] | null = null;
  // The level put aside while a prefab is open: its model and its undo steps
  // each AS WRITTEN (`Shelved`), since an instance's insides are expanded from
  // the prefab, and the prefab is what is about to change. Read back after,
  // every instance shows the edit, and an undo step taken back to cannot
  // carry the prefab's old values as if they were this level's overrides.
  type Shelved = { tree: LevelTree; strokes: Map<string, PaintStamp[]> };
  let levelSession: { model: Shelved; history: Shelved[]; future: Shelved[]; name: string | null; dirty: boolean; cam: Vec2; zoom: number; pose: ViewPose | null } | null = null;
  const shelve = (m: EdModel): Shelved => {
    const strokes = new Map<string, PaintStamp[]>();
    for (const i of m.items) if (i.decoration?.strokes) strokes.set(i.decoration.id, i.decoration.strokes);
    return { tree: toTree(m), strokes };
  };
  const unshelve = (s: Shelved): EdModel => {
    const m = modelFromTree(s.tree);
    for (const i of m.items) {
      const strokes = i.decoration && s.strokes.get(i.decoration.id);
      if (strokes) i.decoration = { ...i.decoration!, strokes };
    }
    return m;
  };

  // Is this node the level's furniture the open prefab is shown among - the
  // spawn the editor's model always holds, the level's Sun and Environment it
  // is lit by - rather than the prefab's own? Never saved into it, and not
  // listed in its scene tree.
  const isLevelFurniture = (n: EdNode): boolean => n.extra["spawn"] === true || n.type === "Sun" || n.type === "Environment";

  // The open prefab as its file: its root and everything under it, in pixels.
  // A string says why it cannot be saved as it stands.
  function prefabOfModel(): PrefabData | string {
    const tree = scaleLevelTree(toTree(model), PIXELS_PER_METER);
    const nodes = tree.nodes.filter((n) => n.type !== "Spawn2D" && n.type !== "Sun" && n.type !== "Environment");
    const root = nodes.find((n) => n.id === prefabRootId);
    if (!root) return "its root node is gone (undo brings it back)";
    const strays = nodes.filter((n) => n !== root);
    if (strays.length) {
      const names = strays.map((n) => n.name).join(", ");
      return `${names} cannot go under the root ${root.name}: move ${strays.length === 1 ? "it" : "them"} into a node that can hold ${strays.length === 1 ? "it" : "them"}, or delete ${strays.length === 1 ? "it" : "them"}`;
    }
    const refused = validateTree([root], { prefab: true }).filter((p) => p.error);
    if (refused.length) return refused[0]!.message;
    // The root is the prefab's origin: moved or turned while open, what came
    // with it is kept where it was put and the root written at the origin.
    return { format: TREE_FORMAT, root: prefabRootAtOrigin(root, true) };
  }

  // ONE ROOT: whatever an edit left at the top beside the open prefab's root
  // goes under it, where it stands. A node the root may not hold (a body
  // under a rigid body) stays, and the prefab is not saved until it is moved
  // or deleted (`prefabOfModel`), which the title and a notice say.
  function adoptPrefabStrays(): void {
    if (!prefabMode || prefabRootId === null || !model.tree.nodes.has(prefabRootId)) return;
    for (const r of [...model.tree.roots]) {
      const n = model.tree.nodes.get(r);
      if (!n || r === prefabRootId || isLevelFurniture(n)) continue;
      moveNode(model, r, prefabRootId, undefined);
    }
  }

  const refusalNotice = (name: string, why: string): string => `The prefab ${name} is not saved: ${why}`;
  // What a refusal said goes once it no longer holds.
  function clearPrefabRefusal(): void {
    if (prefabRefusal !== null && prefabName) hideToast(refusalNotice(prefabName, prefabRefusal));
    prefabRefusal = null;
  }

  // The open prefab's root as the model has it: undo and redo replace the
  // model, root and all, so after one the root is the one node standing at
  // the top beside the level's furniture (a Make root undone gives the old
  // root back).
  function syncPrefabRoot(): void {
    if (!prefabMode) return;
    const tops = model.tree.roots.filter((r) => {
      const n = model.tree.nodes.get(r);
      return !!n && !isLevelFurniture(n);
    });
    if (tops.length === 1) prefabRootId = tops[0]!;
  }

  // Why `id` cannot be made the open prefab's root, or null.
  function makeRootRefusal(id: string): string | null {
    if (!prefabMode || prefabRootId === null) return "only a prefab has a root to change";
    const n = model.tree.nodes.get(id);
    if (!n) return "it is gone";
    if (id === prefabRootId) return "it is the root";
    if (isLevelFurniture(n)) return "it is the level's, not the prefab's";
    if (n.extra["inInstance"] !== undefined) return "it is part of a placed prefab (Make local first)";
    return canParent(model.tree, id, null);
  }

  // MAKE ROOT (Godot's "Make Scene Root"): `id` becomes the open prefab's
  // root, where it stands. The old root comes under it - or, a plain group
  // with nothing of its own (the `Node2D` a second top-level node was once
  // wrapped in at save), is dissolved: what it held comes under the new root
  // and the group goes, its name kept on a new root still called after its
  // class. One undo step; anything the new root may not hold, or anything the
  // prefab could then not be saved as, refuses the whole of it.
  function makePrefabRoot(id: string): void {
    const n = model.tree.nodes.get(id);
    const refused = makeRootRefusal(id);
    if (!n || refused) {
      showToast(`Cannot make ${n?.name ?? "it"} the root: ${refused}`, "warn");
      return;
    }
    const old = model.tree.nodes.get(prefabRootId!)!;
    beginAction();
    const fail = (why: string): void => {
      replaceModel(history.pop()!);
      afterHistoryChange();
      showToast(`Cannot make ${n.name} the root: ${why}`, "warn");
    };
    let why = moveNode(model, id, null, 0);
    if (why) return fail(why);
    const plain = (old.type === "Node2D" || old.type === "Node") && !old.body && old.item === null && !old.instance;
    if (plain) {
      for (const c of [...old.children]) {
        why = moveNode(model, c, id, undefined);
        if (why) return fail(why);
      }
      removeSubtree(model.tree, old.id);
      if (n.name === n.type || n.name === bodyNodeTypeOf(n)) renameNode(model.tree, id, old.name);
    } else {
      why = moveNode(model, old.id, id, undefined);
      if (why) return fail(why);
    }
    prefabRootId = id;
    const check = prefabOfModel();
    if (typeof check === "string") return fail(check);
    markDirty();
    setBodySelection(id);
    rebuildInspector();
  }

  // The class name a body node is written as (its `kind`), for "is it still
  // called after its class".
  function bodyNodeTypeOf(n: EdNode): string {
    return n.body ? bodyNodeType(n.body) : n.type;
  }

  function savePrefabSoon(): void {
    if (!prefabMode || !prefabName) return;
    if (prefabSaveTimer) clearTimeout(prefabSaveTimer);
    const name = prefabName;
    prefabSaveTimer = setTimeout(() => {
      prefabSaveTimer = null;
      void writePrefab(name);
    }, AUTOSAVE_DELAY_MS);
  }

  // Write the open prefab, as a level's autosave writes the level: what was
  // being written is snapshotted so an edit landing meanwhile stays unsaved,
  // and a refusal or a failure stands in the title until the next write
  // succeeds (`saveError`), said once in a notice rather than on every edit.
  async function writePrefab(name: string): Promise<boolean> {
    const data = prefabOfModel();
    if (typeof data === "string") {
      saveError = `prefab not saved: ${data}`;
      if (prefabRefusal !== data) showToast(refusalNotice(name, data), "warn");
      prefabRefusal = data;
      updateTitle();
      return false;
    }
    clearPrefabRefusal();
    const rev = modelRev;
    try {
      await savePrefab(name, data);
      setPrefab(name, data);
      await savePaint(name);
      if (modelRev === rev) dirty = false;
      saveError = null;
      updateTitle();
      return true;
    } catch (e) {
      saveError = String(e);
      showToast(`The prefab ${name} could not be saved (${String(e)})`, "warn");
      updateTitle();
      return false;
    }
  }

  // Write the open prefab now if it has anything unwritten. False when it
  // could not be, and the author chose to stay with it.
  async function flushPrefab(): Promise<boolean> {
    if (!prefabMode || !prefabName) return true;
    if (!prefabSaveTimer && !dirty) return true;
    if (prefabSaveTimer) clearTimeout(prefabSaveTimer);
    prefabSaveTimer = null;
    if (await writePrefab(prefabName)) return true;
    return confirm(`The prefab ${prefabName} is not saved (${saveError ?? "unknown"}). Leave it anyway and lose its unsaved edits?`);
  }

  // What "everything" is to the view (Home, and an opened prefab's first
  // frame): an open prefab's own scene items, not the model's spawn at its
  // origin; else the whole level.
  function wholeBox(): ReturnType<typeof levelBox> {
    if (prefabMode) {
      const box = focusBox(model.items.filter((i) => i.layer === "scene"));
      if (box) return box;
    }
    return levelBox(model);
  }

  // An opened prefab framed whole: at once by what is known, and again once
  // every model in it is drawn (a model's file lands after the open; until
  // then it is measured by its mark) - unless the view has been moved since,
  // which is the author's. Given up after a few seconds.
  let prefabFraming: { pose: unknown; until: number } | null = null;
  function framePrefab(): void {
    if (!visuals?.active) return;
    visuals.frameBox(wholeBox());
    // ...head on: framed, the view looks at the box's middle in depth too (a
    // model has some), which is a turned view, and a turned view hides the
    // overlay and offers only select and move.
    resetView();
  }
  function settlePrefabFraming(now: number): void {
    if (!prefabFraming) return;
    if (!prefabMode || !visuals?.active || visuals.view !== prefabFraming.pose || now > prefabFraming.until) {
      prefabFraming = null;
      return;
    }
    const models = model.items.filter((i) => i.object === "model");
    if (!models.every((i) => drawnBox(i.id) !== null)) return;
    framePrefab();
    prefabFraming = null;
  }

  // Edit a prefab as a scene of its own, in place of the level: the level is
  // written, put aside with its undo steps (`levelSession`), and given back
  // by `closePrefab`. Another prefab opened over it replaces this one.
  async function openPrefab(name: string): Promise<void> {
    if (mode !== "edit") return;
    let data: PrefabData;
    try {
      data = await loadPrefab(name);
    } catch {
      showToast(`No prefab ${name}`, "warn");
      if (readOpenPrefab() === name) writeOpenPrefab(null);
      return;
    }
    if (!(await flushPrefab())) return;
    // The level is written before it is put aside: its paint is read again
    // from disk on the way back.
    if (!levelSession && currentName && dirty) await doSave(false, true);
    cancelAutosave();
    if (!levelSession) {
      levelSession = { model: shelve(model), history: history.map(shelve), future: future.map(shelve), name: currentName, dirty, cam: camera.position, zoom: camera.zoom, pose: visuals?.view ?? null };
    }
    // Lit as the level is: its Sun and Environment stand beside the prefab
    // while it is open (no lengths in them, so the units do not matter), and
    // are never written into it nor listed in its tree (`isLevelFurniture`).
    const light = toTree(model).nodes.filter((n) => n.type === "Sun" || n.type === "Environment");
    clearPrefabRefusal();
    prefabMode = true;
    prefabName = name;
    prefabRootId = data.root.id;
    saveError = null;
    writeOpenPrefab(name);
    // What is open is worked on in the scene tree; the banner over it is the
    // way back.
    prefabsShown = false;
    currentName = null;
    // At its origin, as every instance places it: a pose the file's root
    // carries is the instance's to give, never seen in a level.
    replaceModel(modelFromTree(scaleLevelTree({ format: TREE_FORMAT, nodes: [...light, prefabRootAtOrigin(data.root, false)] }, PX)));
    await loadPaint(name);
    resetHistory();
    dirty = false;
    camera.position = Vec2.ZERO;
    poseFromCameraNow();
    // Framed whole, as Home frames it: a prefab whose origin is at one end
    // (a length of track) opened half out of view.
    framePrefab();
    prefabFraming = visuals?.active ? { pose: visuals.view, until: performance.now() + 4000 } : null;
    selectedIds.clear();
    selectedVerts.clear();
    selectedBodyIds.clear();
    solidSel = null;
    setBodySelection(prefabRootId);
    refreshDocButtons();
    rebuildInspector();
    updateTitle();
  }

  // Leave the open prefab, written, without restoring anything: what the
  // caller opens next takes the editor's place.
  function endPrefab(): void {
    if (prefabSaveTimer) clearTimeout(prefabSaveTimer);
    prefabSaveTimer = null;
    clearPrefabRefusal();
    levelSession = null;
    prefabMode = false;
    prefabName = null;
    prefabRootId = null;
    saveError = null;
    writeOpenPrefab(null);
  }

  // Back to the level, read again through the prefab library so every
  // instance of what was edited shows it. With no level put aside (the
  // prefab was reopened by a reload) the level this browser had open is
  // loaded from disk. False when the author chose to stay with a prefab that
  // could not be saved.
  async function closePrefab(): Promise<boolean> {
    if (!prefabMode) return true;
    if (!(await flushPrefab())) return false;
    const s = levelSession;
    endPrefab();
    if (s) {
      replaceModel(unshelve(s.model));
      history.splice(0, history.length, ...s.history.map(unshelve));
      future.splice(0, future.length, ...s.future.map(unshelve));
      currentName = s.name;
      // What is placed from the prefab paints as the prefab now does.
      if (currentName) await loadPaint(currentName);
      dirty = s.dirty;
      camera.position = s.cam;
      camera.zoom = s.zoom;
      if (s.pose) visuals?.setView(s.pose);
      else poseFromCameraNow();
    } else {
      const back = readLastLevel();
      if (back) await doLoad(back);
      else {
        replaceModel(emptyModel());
        resetHistory();
        currentName = null;
        dirty = false;
        camera.position = Vec2.ZERO;
        poseFromCameraNow();
      }
    }
    selectedIds.clear();
    selectedVerts.clear();
    selectedBodyIds.clear();
    solidSel = null;
    refreshDocButtons();
    rebuildInspector();
    updateTitle();
    return true;
  }

  // A new, empty prefab: a group at its origin, saved under `name`.
  async function newPrefab(name: string): Promise<void> {
    const data: PrefabData = { format: TREE_FORMAT, root: { type: "Node2D", id: newNodeId(), name, grouped: true } as LevelNode };
    await savePrefab(name, data);
    setPrefab(name, data);
    prefabNames = null;
    await openPrefab(name);
  }

  // The level read again through the prefab library, keeping the undo stack:
  // what placing or changing a prefab needs, since an instance's insides are
  // nodes of the model (`modelFromTree`).
  // A tree other than the model's own written form may be given: one with a
  // node changed as written (`replaceTreeNode`). Which instances have their
  // children open is the session's, kept across.
  function reexpand(tree: LevelTree = toTree(model)): void {
    const editable = new Set([...model.tree.nodes.values()].filter((x) => x.instance?.editable).map((x) => x.id));
    replaceModel(modelFromTree(tree));
    for (const e of editable) {
      const x = model.tree.nodes.get(e);
      if (x?.instance) x.instance.editable = true;
    }
  }

  // PLACE: an instance of `name` at the view's centre, its bodies built after
  // every other's, grouped as a prefab's instance always is. Placed in the
  // level AS WRITTEN and read back, so its insides come in expanded: an
  // instance in the model is never without them, which is what lets every
  // write of it read what is missing inside as removed.
  async function placePrefab(name: string): Promise<void> {
    if (prefabMode && name === prefabName) {
      showToast("A prefab cannot be placed in itself", "warn");
      return;
    }
    // A prefab this page has not read yet (made since it loaded - by another
    // tab, a script, a hand): read now, or the placing would expand against
    // a library without it into an empty holder (2026-11-26).
    if (!prefabLibrary()[name]) {
      try {
        setPrefab(name, await loadPrefab(name));
      } catch {
        showToast(`No prefab ${name}`, "warn");
        return;
      }
    }
    beginAction();
    const tree = toTree(model);
    const id = newNodeId(new Set(model.tree.nodes.keys()));
    const at = snapVec(camera.position);
    const taken = new Set(model.tree.roots.map((r) => model.tree.nodes.get(r)?.name ?? ""));
    let label = name;
    for (let k = 2; taken.has(label); k++) label = `${name}${k}`;
    tree.nodes.push({ type: "Instance", id, name: label, grouped: true, x: at.x, y: at.y, prefab: name, order: nextOrder(model.tree) } as LevelNode);
    reexpand(tree);
    markDirty();
    setBodySelection(id);
  }

  // SAVE BRANCH AS PREFAB: the selected node and everything under it becomes
  // the prefab `name`, and is replaced in the level by an instance of it,
  // standing where it stood (its written place is the instance's) and built
  // in its turn (its key is the instance's).
  async function saveBranchAsPrefab(name: string): Promise<void> {
    const ids = selectionNodes();
    if (ids.length !== 1) {
      showToast("Select one node to make a prefab of", "warn");
      return;
    }
    const id = ids[0]!;
    const n = model.tree.nodes.get(id);
    if (!n || n.extra["spawn"] === true) return;
    const tree = toTree(model);
    const top = findNodeIn(tree.nodes, id) as (LevelNode & Record<string, unknown>) | null;
    if (!top) return;
    const root: Record<string, unknown> = structuredClone(top);
    for (const k of ["x", "y", "rot", "z", "tilt"]) delete root[k];
    const data: PrefabData = { format: TREE_FORMAT, root: scaleLevelTree({ format: TREE_FORMAT, lengthScale: PX, nodes: [root as unknown as LevelNode] }, PIXELS_PER_METER).nodes[0]! };
    const refused = validateTree([data.root], { prefab: true }).filter((p) => p.error);
    if (refused.length) {
      showToast(`Not a prefab: ${refused[0]!.message}`, "warn");
      return;
    }
    await savePrefab(name, data);
    setPrefab(name, data);
    prefabNames = null;
    beginAction();
    const instId = newNodeId(new Set(model.tree.nodes.keys()));
    const order = typeof top["order"] === "number" ? top["order"] : nextOrder(model.tree);
    const inst: Record<string, unknown> = { type: "Instance", id: instId, name: n.name, grouped: true, prefab: name, order };
    for (const k of ["x", "y", "rot", "z", "tilt"]) if (top[k] !== undefined) inst[k] = top[k];
    replaceIn(tree.nodes, id, inst as unknown as LevelNode);
    reexpand(tree);
    markDirty();
    setBodySelection(instId);
  }

  // Put `next` where the node `id` stands, among its siblings.
  function replaceIn(nodes: LevelNode[], id: string, next: LevelNode): boolean {
    const at = nodes.findIndex((x) => x.id === id);
    if (at >= 0) {
      nodes[at] = next;
      return true;
    }
    return nodes.some((x) => x.children !== undefined && replaceIn(x.children, id, next));
  }

  function descendantsOf(id: string): string[] {
    const out: string[] = [];
    const walk = (x: string): void => {
      for (const c of model.tree.nodes.get(x)?.children ?? []) {
        out.push(c);
        walk(c);
      }
    };
    walk(id);
    return out;
  }

  // MAKE LOCAL (unpack): the instance becomes the nodes it places, ordinary
  // nodes of the level with ids of their own, the prefab's and the
  // overrides' values as they stand.
  function makeLocal(id: string): void {
    const n = model.tree.nodes.get(id);
    if (!n?.instance) return;
    beginAction();
    const fresh = new Map<string, string>();
    for (const d of descendantsOf(id)) {
      const k = model.tree.nodes.get(d)!;
      if (k.extra["inInstance"] !== id) continue;
      fresh.set(d, newNodeId(new Set([...model.tree.nodes.keys(), ...fresh.values()])));
    }
    // The instance node becomes its root, of the root's class.
    n.type = (n.extra["rootType"] ?? "Node2D") as NodeType;
    n.instance = null;
    const { rootType: _r, ...extra } = n.extra;
    n.extra = extra;
    // Every node it brought: an id of its own, no longer the prefab's.
    for (const [old, now] of fresh) {
      const k = model.tree.nodes.get(old)!;
      model.tree.nodes.delete(old);
      const { inInstance: _i, ...rest } = k.extra;
      k.extra = rest;
      k.id = now;
      model.tree.nodes.set(now, k);
    }
    for (const k of model.tree.nodes.values()) {
      if (k.parent !== null && fresh.has(k.parent)) k.parent = fresh.get(k.parent)!;
      k.children = k.children.map((c) => fresh.get(c) ?? c);
    }
    for (const i of model.items) {
      const now = fresh.get(i.node);
      if (!now) continue;
      i.node = now;
      if (i.formation) i.formation = { ...i.formation, id: now };
      if (i.decoration) i.decoration = { ...i.decoration, id: now, formation: fresh.get(i.decoration.formation) ?? i.decoration.formation };
    }
    relink(model);
    markDirty();
    rebuildInspector();
  }

  // A placed prefab's insides shown in the scene tree and picked on the
  // canvas (Godot's "editable children"); an edit made there is an override.
  function setEditableChildren(id: string, on: boolean): void {
    const n = model.tree.nodes.get(id);
    if (!n?.instance) return;
    n.instance.editable = on;
    if (on) expandedBodies.add(id);
    outlinerRev = -1;
    modelRev++;
    rebuildInspector();
  }

  // A click landing inside a placed prefab whose children are not editable
  // selects the instance, whatever the group rule or Alt said: its insides
  // are the prefab's until they are opened.
  function sealedTarget(id: string): string {
    const owner = model.tree.nodes.get(id)?.extra["inInstance"];
    if (typeof owner !== "string") return id;
    return model.tree.nodes.get(owner)?.instance?.editable ? id : owner;
  }

  // The dock's tabs say which pane is up, and the pane shows it; a prefab open
  // for editing says so over the tree, with the way back.
  function refreshDocButtons(): void {
    workspaceBtns.prefabs?.classList.toggle("active", prefabsShown);
    workspaceBtns.prefabs?.setAttribute("aria-selected", String(prefabsShown));
    workspaceBtns.level?.classList.toggle("active", !prefabsShown);
    workspaceBtns.level?.setAttribute("aria-selected", String(!prefabsShown));
    scenePane.hidden = prefabsShown;
    prefabPane.hidden = !prefabsShown;
    prefabBanner.hidden = !prefabMode;
    prefabBannerName.textContent = `Prefab ${prefabName ?? ""}`;
  }

  // THE PREFAB LIBRARY, the right dock's Prefabs pane.
  function buildPrefabsGroup(): void {
    prefabPane.innerHTML = "";
    const g = el("div", "ed-group");
    g.appendChild(
      heading(
        prefabMode ? `Prefab ${prefabName ?? ""}` : "Prefabs",
        "Shared assets that are editable node trees (prefabs/<name>.json). Place one in the level as an instance, which may override any property of any node in it; open one to edit it, and every instance in every level follows.",
      ),
    );
    if (prefabMode) {
      const back = button("Back to the level", () => void closePrefab());
      back.title = "Save the prefab and go back to the level, every instance of it showing the edit";
      g.appendChild(back);
    }
    const list = el("div", "ed-col");
    const fill = (names: string[]): void => {
      list.innerHTML = "";
      if (!names.length) list.appendChild(el("div", "ed-hint")).textContent = "No prefabs yet.";
      for (const name of names) {
        const row = el("div", "ed-row");
        const label = el("span", "ed-layer-name");
        label.textContent = name;
        const place = button("Place", () => void placePrefab(name));
        place.title = `Place ${name} at the view's centre`;
        const open = button("Open", () => void openPrefab(name));
        open.title = `Edit ${name}: every instance follows`;
        row.append(label, place, open);
        list.appendChild(row);
      }
    };
    if (prefabNames) fill(prefabNames);
    else
      void listPrefabs()
        .then((names) => {
          prefabNames = names;
          fill(names);
        })
        .catch(() => fill([]));
    g.appendChild(list);
    const nameRow = fieldRow("name");
    const nameInput = Object.assign(document.createElement("input"), { className: "ed-text", placeholder: "prefab-name" });
    nameInput.addEventListener("keydown", (e) => e.stopPropagation());
    nameRow.appendChild(nameInput);
    describe(nameRow, "The name a new prefab is saved as (letters, digits, - and _).");
    g.appendChild(nameRow);
    const nameOf = (): string | null => {
      const n = nameInput.value.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
      if (!n) {
        showToast("Name the prefab first", "warn");
        return null;
      }
      return n;
    };
    const actions = el("div", "ed-row");
    const make = button("New prefab", () => {
      const n = nameOf();
      if (n) void newPrefab(n);
    });
    make.title = "An empty prefab, opened to be built";
    const branch = button("Save selection as prefab", () => {
      const n = nameOf();
      if (n) void saveBranchAsPrefab(n);
    });
    branch.title = "The selected node and everything under it becomes a prefab, and is replaced here by an instance of it";
    branch.disabled = selectionNodes().length !== 1;
    actions.append(make, branch);
    g.appendChild(actions);
    prefabPane.appendChild(g);
  }

  // --- undo/redo ------------------------------------------------------------
  // Snapshots of the whole model. Shapes, camera framing and note bodies are
  // mutated in place, so clone them; Vec2 is immutable, so its refs are safe to
  // share.
  const HISTORY_MAX = 50; // undo steps retained
  const history: EdModel[] = [];
  // The models' `meta.json`s, by model name (see `modelMetaFor`).
  const modelMetas = new Map<string, ModelMeta | null | undefined>();
  const modelMetaWaiters = new Map<string, Array<() => void>>();
  const future: EdModel[] = [];
  const snapshot = (m: EdModel): EdModel => withLinks({
    player: {
      pos: m.player.pos,
      radius: m.player.radius,
      hang: m.player.hang,
      roll: m.player.roll,
      arrival: m.player.arrival,
    },
    items: m.items.map((b) => ({
      ...b,
      shape: cloneShape(b.shape),
      cam: { ...b.cam },
      light: { ...b.light },
      note: { ...b.note },
      shelter: { ...b.shelter },
      fog: { ...b.fog },
      modelRef: { ...b.modelRef },
    })),
    chains: m.chains.map(cloneChain),
    vines: m.vines.map(cloneVine),
    // The tree's nodes are mutated in place (a body's properties, a frame's
    // placement), so every node is copied; `withLinks` points the copied
    // items at the copied bodies.
    tree: cloneTree(m.tree),
    dataLayers: [...m.dataLayers],
    // A string: nothing to alias. (The Sun and Environment nodes' fields are
    // their nodes' `extra`, copied with the tree.)
    background: m.background,
    // Mutated in place by the top bar's lens fields exactly as `cam` and
    // `light` are, so a snapshot sharing it would alias the state it restores.
    camera: m.camera ? { ...m.camera } : undefined,
    meta: { ...m.meta },
  });
  const resetHistory = (): void => {
    history.length = 0;
    future.length = 0;
  };
  // A snapshot's items, pointed at its own copies of the bodies.
  function withLinks(m: EdModel): EdModel {
    relink(m);
    return m;
  }

  // Record the current state before a mutating action, so it can be undone.
  // It clears the redo stack: redoing past a new edit would replay the undone
  // one over it.
  function beginAction(): void {
    nudging = false; // any other action ends the current nudge run
    // ...and the parent pick, whose answer belongs to the draw before it.
    closeParentPick();
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
    closeParentPick();
    syncPrefabRoot();
    // An undone edit may have been the one that placed a corner, so an index
    // carried across it names a different vertex or none at all. A route node's
    // index is the same kind of thing over the same kind of list - undoing the
    // midpoint insert that picked it leaves the index naming the node that used
    // to be the one after it - so it goes the same way.
    selectedVerts.clear();
    clearRouteSel();
    const live = new Set(model.items.map((b) => b.id));
    for (const id of selectedIds) if (!live.has(id)) selectedIds.delete(id);
    const liveChains = new Set(model.chains.map((c) => c.id));
    for (const id of selectedChainIds) if (!liveChains.has(id)) selectedChainIds.delete(id);
    const liveVines = new Set(model.vines.map((v) => v.id));
    for (const id of selectedVineIds) if (!liveVines.has(id)) selectedVineIds.delete(id);
    // Undoing a merge retires the body it made, so a selection still naming it
    // would leave the panel showing a body with nothing in it.
    const liveBodies = new Set(model.items.map((b) => b.unit));
    for (const id of selectedBodyIds) if (!liveBodies.has(id)) selectedBodyIds.delete(id);
    rebuildInspector();
    markDirty(); // an undo/redo is a change like any other - it autosaves too
  }

  // Model order, so a group keeps its z-order through copy/duplicate.
  const selectedBodies = () => model.items.filter((b) => selectedIds.has(b.id));
  // The items a click or a rubber-band may touch: everything on a layer that is
  // both visible and unlocked, in a body that is not hidden (H), and part of
  // the workspace (`inWs`).
  const pickableItems = () =>
    model.items.filter((b) => layerShown(b.layer) && !lockedLayers.has(b.layer) && !itemHidden(b) && !itemLocked(b) && inWs(b));

  // HIDDEN BODIES (H, Alt+H, Shift+H, the outliner's eye; Blender's viewport
  // hide): not drawn - not in the overlay, the scene or the guides - and not
  // picked, while they are worked round. A view setting of this session's,
  // never in the level, and a ▶ Test plays the level whole.
  const hiddenBodies = new Set<string>();
  // ...and the user's DATA LAYERS (plans/node-tree.md "Editor"): layers made
  // and named here, any node in any number of them (`EdNode.layers`, saved in
  // the level), a child in its ancestors' too. A node is shown only if no layer
  // it is in is hidden, and editable only if none is locked. View state of
  // this session, as the eye above is; the game ignores layers.
  const hiddenUserLayers = new Set<string>();
  const lockedUserLayers = new Set<string>();
  // Is an item hidden: its node or any above it hidden (H, the tree's eye),
  // or in a hidden data layer?
  function itemHidden(i: EdItem | null | undefined): boolean {
    if (!i) return false;
    if (hiddenBodies.has(i.unit) || hiddenBodies.has(i.node)) return true;
    for (const a of ancestors(model.tree, i.node)) if (hiddenBodies.has(a.id)) return true;
    if (hiddenUserLayers.size) for (const l of layersOf(model.tree, i.node)) if (hiddenUserLayers.has(l)) return true;
    return false;
  }
  // ...and locked: drawn, but not picked on the canvas. A node is locked by
  // its own `locked` or an ancestor's (Godot's lock: saved in the level, the
  // scene tree still selects it), or by a locked data layer it is in.
  function nodeLocked(id: string): boolean {
    const n = model.tree.nodes.get(id);
    if (!n) return false;
    if (n.locked || lockedBy(id) !== null) return true;
    if (lockedUserLayers.size) for (const l of layersOf(model.tree, id)) if (lockedUserLayers.has(l)) return true;
    return false;
  }
  // The nearest ancestor whose own lock covers a node, or null.
  function lockedBy(id: string): EdNode | null {
    return ancestors(model.tree, id).find((a) => a.locked) ?? null;
  }
  function itemLocked(i: EdItem | null | undefined): boolean {
    return !!i && nodeLocked(i.node);
  }
  // The chains and vines a click may not reach: their nodes locked. Asked once
  // per pick rather than per chain, since a chain names no node of its own.
  function lockedLinks(): { chains: Set<number>; vines: Set<number> } {
    const chains = new Set<number>();
    const vines = new Set<number>();
    for (const n of model.tree.nodes.values()) {
      if ((n.chain === null && n.vine === null) || !nodeLocked(n.id)) continue;
      if (n.chain !== null) chains.add(n.chain);
      if (n.vine !== null) vines.add(n.vine);
    }
    return { chains, vines };
  }
  // LOCK (Ctrl+L, Ctrl+Shift+L, the scene tree's padlock, the Node section's
  // box): an edit like grouping, undone like one. What it locks leaves the
  // selection, as a locked layer's does: "out of harm's way" starts now, not
  // at the next click. The scene tree can select it again on purpose.
  function setNodesLocked(ids: Iterable<string>, lock: boolean): void {
    const nodes = [...ids].map((id) => model.tree.nodes.get(id)).filter((n): n is EdNode => !!n && n.locked !== lock);
    if (!nodes.length) return;
    beginAction();
    for (const n of nodes) n.locked = lock;
    if (lock) {
      for (const id of [...selectedIds]) if (itemLocked(itemOf(id))) selectedIds.delete(id);
      for (const id of [...selectedBodyIds]) if (nodeLocked(id)) selectedBodyIds.delete(id);
      const links = lockedLinks();
      for (const id of [...selectedChainIds]) if (links.chains.has(id)) selectedChainIds.delete(id);
      for (const id of [...selectedVineIds]) if (links.vines.has(id)) selectedVineIds.delete(id);
    }
    markDirty();
    rebuildInspector();
    syncGizmo();
  }
  let hiddenRev = 0;
  function setBodiesHidden(ids: Iterable<string>, hide: boolean): void {
    let changed = false;
    for (const id of ids) {
      if (hide === hiddenBodies.has(id)) continue;
      if (hide) hiddenBodies.add(id);
      else hiddenBodies.delete(id);
      changed = true;
    }
    if (!changed) return;
    hiddenRev++;
    // What is hidden cannot stay selected: it could not be seen being edited.
    if (hide) {
      for (const id of [...selectedIds]) if (itemHidden(itemOf(id))) selectedIds.delete(id);
      for (const id of [...selectedBodyIds]) if (hiddenBodies.has(id)) selectedBodyIds.delete(id);
    }
    outlinerRev = -1;
    rebuildInspector();
    syncGizmo();
  }
  // The model as drawn: without the hidden bodies' items, and only what is
  // part of the workspace (`inWs`; the chains and vines are the 2D
  // workspace's). The same object while nothing is hidden in 2D with no 3D
  // body or decoration to leave out.
  // In Decorations the collision outlines are drawn too while its dock's
  // Collision is on (`showCollisionOutlines`): for reference only, so they
  // stay out of `inWs` and a click passes through them to the rock.
  let shownCache: { rev: number; hidden: number; ws: Workspace; collision: boolean; model: EdModel } | null = null;
  const referenceOutline = (i: EdItem): boolean =>
    paintsRocks(workspace) && showCollisionOutlines && i.layer === "scene" && i.object === "collision" && !in3D(i);
  function shownModel(): EdModel {
    if (
      shownCache &&
      shownCache.rev === modelRev &&
      shownCache.hidden === hiddenRev &&
      shownCache.ws === workspace &&
      shownCache.collision === showCollisionOutlines &&
      shownCache.model.player === model.player
    ) {
      return shownCache.model;
    }
    const items = model.items.filter((i) => !itemHidden(i) && (inWs(i) || referenceOutline(i)));
    const plane = workspace === "2d";
    const shown = items.length === model.items.length && plane ? model : { ...model, items, chains: plane ? model.chains : [], vines: plane ? model.vines : [] };
    shownCache = { rev: modelRev, hidden: hiddenRev, ws: workspace, collision: showCollisionOutlines, model: shown };
    return shown;
  }
  // The same set in click order, bottom-first (callers walk it backwards to take
  // the topmost hit): draw order — layer, then model order — with the active
  // layer lifted above the rest, so a camera region drawn over a wall does not
  // swallow the click while the scene is the layer being edited.
  const pickOrder = (): EdItem[] => {
    return pickableItems()
      .map((b, i) => ({ b, i }))
      .sort(
        (p, q) =>
          Number(p.b.layer === activeLayer) - Number(q.b.layer === activeLayer) ||
          ED_LAYERS.indexOf(p.b.layer) - ED_LAYERS.indexOf(q.b.layer) ||
          // A COLLISION object wins over a light whose reach it sits inside: a
          // click means the thing that decides where the player can go.
          Number(p.b.object === "collision") - Number(q.b.object === "collision") ||
          p.i - q.i,
      )
      .map((p) => p.b);
  };
  const selected = () => (selectedIds.size === 1 ? selectedBodies()[0] ?? null : null);
  const selectedChains = () => model.chains.filter((c) => selectedChainIds.has(c.id));
  const selectedVines = () => model.vines.filter((v) => selectedVineIds.has(v.id));
  // The picked berry, if it still is one: its vine alone selected and still
  // carrying a berry at that index (an undo can take either away).
  function currentBerry(): { vine: EdVine; index: number } | null {
    if (!selectedBerry || selectedVineIds.size !== 1 || !selectedVineIds.has(selectedBerry.vineId)) return null;
    const vine = model.vines.find((v) => v.id === selectedBerry!.vineId);
    if (!vine?.starberry || selectedBerry.index >= vine.starberry.along.length) return null;
    return { vine, index: selectedBerry.index };
  }
  function selectBerry(vine: EdVine, index: number): void {
    setVineSelection([vine.id]);
    selectedBerry = { vineId: vine.id, index };
    rebuildInspector();
  }
  // Take berry `index` off `vine`. The last berry takes the berry vine with
  // it: a vine with no berries is a plain vine again, its cord a target.
  function deleteBerry(vine: EdVine, index: number): void {
    if (!vine.starberry) return;
    removeBerry(vine.starberry, index);
    if (vine.starberry.along.length === 0) delete vine.starberry;
    selectedBerry = null;
  }
  // The shape whose VERTICES are editable right now: the lone selected item, if
  // it is one of the two vertex-authored kinds and its handles are on screen at
  // all. Everything about the vertex selection - what a band catches, what
  // Delete removes, what an arrow nudges - is asked of this, so there is one
  // statement of when a shape is open for vertex editing rather than a test
  // repeated at each of them.
  function vertexEditTarget(): EdItem | null {
    const s = selected();
    if (!s || (s.shape.kind !== "poly" && s.shape.kind !== "path")) return null;
    // At any angle: the overlay draws the corners turned as head on.
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
  // The one WHEEL picked on a belt, or null. A belt's wheels are picked by
  // their centre squares (or radius grips) into the same set a polygon's
  // corners go in, so every rule that drops that set - a click on empty space,
  // Esc, a new selection - drops a picked wheel too; everything that EDITS
  // corners asks `vertexEditTarget`, which a belt never is.
  function selectedBeltWheel(item: EdItem): number | null {
    if (item.shape.kind !== "belt" || selectedVerts.size !== 1) return null;
    const i = [...selectedVerts][0]!;
    return i < item.shape.wheels.length ? i : null;
  }
  // Pick wheel `index` of a belt, for the panel's `r`.
  function pickBeltWheel(index: number): void {
    if (selectedVerts.size === 1 && selectedVerts.has(index)) return;
    selectedVerts.clear();
    selectedVerts.add(index);
    rebuildInspector();
  }
  // The body whose ROUTE nodes are pickable right now: the lone selected body,
  // if it is a static with a route. The same one statement `vertexEditTarget`
  // makes for shape vertices, so what a click selects, what the panel keys and
  // what the canvas draws as grabbable cannot drift apart.
  function routeEditTarget(): EdItem | null {
    const id = soleBodyId();
    if (id === null) return null;
    const lead = routeLeadOf(id);
    // A route's nodes and grips are overlay handles, drawn at any angle.
    return lead && propsOf(lead).route.length > 1 ? lead : null;
  }
  // ...and the nodes actually picked on it, sorted, empty for any body but the
  // one they were picked on, and with anything past the route's end dropped: an
  // index outlives the list it indexes only until the next edit, and reading one
  // that has gone is how a stale set keys the wrong node.
  function selectedRouteNodes(item: EdItem): number[] {
    if (routeSel?.bodyId !== item.unit) return [];
    return [...routeSel.nodes].filter((i) => i < propsOf(item).route.length).sort((a, b) => a - b);
  }
  function pickRouteNode(item: EdItem, index: number, add: boolean): void {
    nudging = false; // a new set of nodes starts a new undo step, as a shape's does
    if (!add || routeSel?.bodyId !== item.unit) {
      routeSel = { bodyId: item.unit, nodes: new Set([index]) };
      return;
    }
    if (!routeSel.nodes.delete(index)) routeSel.nodes.add(index);
  }
  function clearRouteSel(): void {
    routeSel = null;
  }
  // Whether the pickable route has any node picked out of it. What Delete and
  // Escape ask, so the two agree about when a keystroke is about the route's
  // nodes rather than about the body carrying them.
  function routeNodesPicked(): boolean {
    const lead = routeEditTarget();
    return !!lead && selectedRouteNodes(lead).length > 0;
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
      if (item) revealBody(item.node);
    }
    rebuildInspector();
  }
  // Select a BODY. Its objects are deliberately left unselected: what the
  // inspector then shows is the body's own properties and nothing else.
  function setBodySelection(id: string | null): void {
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

  // Several bodies selected as bodies, the first first: what a split leaves.
  function setBodiesSelection(ids: readonly string[]): void {
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    for (const id of ids) selectedBodyIds.add(id);
    nudging = false;
    if (ids.length) revealBody(ids[0]!);
    rebuildInspector();
  }

  // Add or remove one body from the selection, which is how two are picked to be
  // merged. It drops the item and chain selections for the same reason
  // `setBodySelection` does: there is no panel that could speak for a body and an
  // object at once.
  function toggleBodySelection(id: string): void {
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
  function revealBody(id: string): void {
    for (const n of ancestors(model.tree, id)) {
      if (!expandedBodies.has(n.id)) {
        expandedBodies.add(n.id);
        outlinerRev = -1;
      }
    }
  }

  // What Delete, Duplicate and a nudge act on. A selected BODY means all of it -
  // deleting a body deletes the objects in it, and moving one moves them - which
  // is a different question from what the inspector is editing.
  const operandItems = (): EdItem[] =>
    selectedBodyIds.size
      ? [...new Set([...[...selectedBodyIds].flatMap((id) => membersOf(model, id)), ...selectedBodies()])]
      : selectedBodies();

  // Items and frames together: what a band takes, items it caught alone and
  // the group roots it caught things of.
  function setNodeSelection(items: readonly number[], nodes: readonly string[]): void {
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    for (const id of items) selectedIds.add(id);
    for (const id of nodes) selectedBodyIds.add(id);
    nudging = false;
    for (const id of nodes) revealBody(id);
    rebuildInspector();
  }

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
    selectedBerry = null;
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
    selectedBodyIds.has(hit.unit) ||
    model.items.some((i) => i.unit === hit.unit && selectedIds.has(i.id));

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
    const bodies = new Set<string>();
    for (const b of model.items) if (out.has(b.id)) bodies.add(b.unit);
    for (const b of model.items) if (bodies.has(b.unit)) out.add(b.id);
    return [...out];
  }

  const snap = (v: number) => (snapOn ? Math.round(v / gridStep) * gridStep : v);
  const snapVec = (v: Vec2) => new Vec2(snap(v.x), snap(v.y));
  // Snap a shape dimension (width/height/radius) to the grid, never below one cell.
  const snapLen = (v: number) => Math.max(gridStep, snap(v));
  // What a move lines up with the grid (see `moveSnapPoint`): a body's
  // colliders, whichever piece was grabbed - a light or an anchor is not the
  // outline being lined up - or everything, where there is nothing else.
  const snapOutlineOf = (items: readonly EdItem[]): Vec2 => {
    const outline = items.filter((m) => m.object === "collision");
    return moveSnapPoint(outline.length ? outline : items);
  };
  // A move's displacement, adjusted so the point it lines up (`at`, taken at
  // the press) lands on the grid.
  const snapMove = (at: Vec2, d: Vec2): Vec2 => (snapOn ? snapVec(at.add(d)).sub(at) : d);
  // Where the gizmo's live move is lining up, for the overlay's marker - the
  // same one a 2D drag shows. Null outside a gizmo translate.
  let gizmoSnapPoint: Vec2 | null = null;
  const snapAngle = (a: number) => {
    if (!snapOn) return a;
    const step = Math.PI / 12; // 15°
    return Math.round(a / step) * step;
  };
  const ANGLE_STEP = Math.PI / 12; // the gizmo's rotation snap, same 15° as above

  // --- the 3D gizmo's side of the model -------------------------------------
  //
  // Nothing below writes anything the 2D handles do not also write; what it adds
  // is the one axis the plane has none of: a light's `z`, which was a number
  // typed into the inspector.
  //
  // A handle is offered ONLY where the format has somewhere to put its answer -
  // a collision shape has no rotation about x and no z, a body has no z of its
  // own, a light has no size - so the gizmo shows a level's real degrees of
  // freedom rather than three of everything, most of which would do nothing.

  // The item's orientation as three sees it: a turn in the plane, about z.
  function itemQuat(i: EdItem): THREE.Quaternion {
    // A model is tilted about the screen's axes before it is turned in the
    // plane (`ModelObjectData`): Rz * Ry * Rx, which is three's "ZYX".
    if (i.object === "model") {
      return new THREE.Quaternion().setFromEuler(new THREE.Euler(i.modelRef.rotX, i.modelRef.rotY, threeRotation(i.rot), "ZYX"));
    }
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, threeRotation(i.rot), "ZXY"));
  }

  // A gizmo drag is one undo step and one save, exactly like a 2D drag.
  const gizmoBegin = (): void => beginAction();
  function gizmoTouched(): void {
    markDirty();
    refreshFields();
  }

  // Where an item's handles stand in z: the depth the thing they are attached to
  // is at - a light's own `z`, and the gameplay plane for everything else. A
  // translate drag writes the proxy's z straight onto a light's field, so the
  // handles have to start exactly there.
  const handleZ = (it: EdItem): number => depthOf(it);

  // AN OBJECT OF A 3D BODY is placed in the body's frame, which stands off the
  // plane and tilts (`EdItem.z`/`tilt`, `itemMatrix`), while its handlers speak
  // the plane's coordinates. This carries what they say into the body's frame
  // and what the handles do back out of it, so the handles stand on the object
  // where it is drawn rather than where it would be on an untilted plane at
  // z 0. The frame is held for a drag: an object's edit does not move it.
  function lifted(h: GizmoHandlers, lift: () => THREE.Matrix4 | null): GizmoHandlers {
    let held: { into: THREE.Matrix4; turn: THREE.Quaternion } | null = null;
    const turnOf = (m: THREE.Matrix4) => new THREE.Quaternion().setFromRotationMatrix(m);
    return {
      pose() {
        const p = h.pose();
        const m = lift();
        return m ? { pos: p.pos.clone().applyMatrix4(m), quat: turnOf(m).multiply(p.quat) } : p;
      },
      axes: (mode) => h.axes(mode),
      begin(mode) {
        const m = lift();
        held = m ? { into: m.clone().invert(), turn: turnOf(m).invert() } : null;
        h.begin(mode);
      },
      apply(mode, pos, quat, scale) {
        if (!held) return h.apply(mode, pos, quat, scale);
        h.apply(mode, pos.clone().applyMatrix4(held.into), held.turn.clone().multiply(quat), scale);
      },
      end(mode) {
        held = null;
        h.end(mode);
      },
    };
  }

  // HANDLES STANDING ON WHAT IS DRAWN rather than on the frame it is placed by.
  //
  // For most things the two are one point. A solid guide is not: it is a mesh
  // placed anywhere in its frame, and a backdrop migrated from a Blender scene
  // keeps its vertices where the scene had them, with its body's frame left at
  // the level's origin (or on its first decoration's anchor) and at the plane's
  // depth - so handles on the frame stood metres off the rock, out in front of
  // it, with nothing under them.
  //
  // `centre` names the point in the world (three's frame); the handles stand
  // there, turned with the frame, and the handlers are handed the pose their
  // FRAME takes. A move carries the frame by what the handles moved, and a turn
  // swings it round the handles, which is what keeps the thing turning in place
  // under them. The point is held in the frame for a drag, so it rides the
  // frame rather than being measured afresh off a scene being rebuilt.
  function pivoted(h: GizmoHandlers, centre: () => THREE.Vector3 | null): GizmoHandlers {
    let held: THREE.Vector3 | null = null;
    const local = (frame: { pos: THREE.Vector3; quat: THREE.Quaternion }): THREE.Vector3 | null => {
      const at = centre();
      return at ? at.sub(frame.pos).applyQuaternion(frame.quat.clone().invert()) : null;
    };
    return {
      pose() {
        const p = h.pose();
        const at = local(p);
        return at ? { pos: at.applyQuaternion(p.quat).add(p.pos), quat: p.quat } : p;
      },
      axes: (mode) => h.axes(mode),
      begin(mode) {
        held = local(h.pose());
        h.begin(mode);
      },
      apply(mode, pos, quat, scale) {
        h.apply(mode, held ? pos.clone().sub(held.clone().applyQuaternion(quat)) : pos, quat, scale);
      },
      end(mode) {
        held = null;
        h.end(mode);
      },
    };
  }

  // The middle of the solid guides among these objects, in three's frame: the
  // mean of each one's own middle (the centre of the box round its solid in
  // its own frame, `guideBounds`), carried by its placement. Taken in the
  // guide's frame rather than off the box round it in the world so that it is
  // a point OF the solid, turning with it: a box measured in the world is a
  // different box once the thing has turned, and handles stood on it would
  // hop at the end of every turn. Null with no solid guide, or none whose
  // meshes have loaded yet.
  function solidCentre(items: readonly EdItem[]): THREE.Vector3 | null {
    const sum = new THREE.Vector3();
    let n = 0;
    for (const it of items) {
      const guide = it.object === "formation" ? it.formation?.guide : undefined;
      const box = guide?.kind === "solid" ? guideBounds(guide.tree) : null;
      if (!box) continue;
      sum.add(box.getCenter(new THREE.Vector3()).applyMatrix4(itemMatrix(it)));
      n++;
    }
    return n ? sum.divideScalar(n) : null;
  }

  // THE POINT ONE BODY TURNS ABOUT, whichever control turns it - the gizmo's
  // ring, the 2D knob, the panel's rot°. A body with collision turns about the
  // centre of mass the engine mounts it at (`bodyCentroid`). One with none but
  // a solid guide (a backdrop) has no mass to agree with, and its pieces'
  // placement points are not where it is - a migrated backdrop's are the
  // level's origin - so it turns about the middle of its solids, and its
  // handles stand there, at that depth (`solidCentre`). In three's frame.
  function bodyTurnPoint(items: readonly EdItem[]): THREE.Vector3 {
    const solid = items.some((i) => i.object === "collision") ? null : solidCentre(items);
    if (solid) return solid;
    const c = bodyCentroid(items);
    const at = new THREE.Vector3(c.x, threeY(c.y), 0);
    const lift = items.length ? bodyLift(items[0]!.unit) : null;
    return lift ? at.applyMatrix4(lift) : at;
  }

  // ...as a point of the plane the body's objects are placed in, which is what
  // a turn in that plane (`rotateItemsAbout`) goes round: the plane a 3D body
  // stands off and tilts (`bodyLift`), carried back out of it.
  function bodyTurnCentre(items: readonly EdItem[]): Vec2 {
    const p = bodyTurnPoint(items);
    const lift = items.length ? bodyLift(items[0]!.unit) : null;
    if (lift) p.applyMatrix4(lift.invert());
    return new Vec2(p.x, threeY(p.y));
  }

  // A 3D frame as a transform of the plane its placement is in: what carries
  // a point of that plane to where the frame's depth and tilt put it. Null for
  // a unit in the plane.
  function bodyLift(unit: string): THREE.Matrix4 | null {
    const w = worldOfNode(model, unit);
    if (w.z === 0 && w.tilt[0] === 0 && w.tilt[1] === 0) return null;
    return poseMatrix(w).multiply(planeMatrix(w.pos, w.rot).invert());
  }

  // The handles for one object: on it where its body draws it, and on the
  // middle of its solid when it is a solid guide's formation.
  function objectHandlers(id: number): GizmoHandlers {
    const find = (): EdItem | null => model.items.find((b) => b.id === id) ?? null;
    const lift = (): THREE.Matrix4 | null => {
      const it = find();
      return it ? bodyLift(it.unit) : null;
    };
    return pivoted(lifted(itemHandlers(id), lift), () => {
      const it = find();
      return it ? solidCentre([it]) : null;
    });
  }

  // The item the handles are on, resolved by id every time rather than held:
  // undo and redo replace the model wholesale, so a captured object is a stale
  // one the moment a drag is undone.
  function itemHandlers(id: number): GizmoHandlers {
    const find = (): EdItem | null => model.items.find((b) => b.id === id) ?? null;
    // The sizes a scale drag is measured against (see `GizmoHandlers.apply`).
    let base: { shape: EdShape; pos: Vec2; snapAt: Vec2; scale: number } | null = null;
    // Where a turn leaves the placement: carried round the handles when they
    // stand off it (`pivoted`), so the thing turns in place under them, and
    // nowhere otherwise. Under a nanometre is the round trip through a 3D
    // body's frame (`lifted`) and back, not a move.
    const swung = (pos: THREE.Vector3): Vec2 => {
      const d = new Vec2(pos.x, threeY(pos.y)).sub(base!.pos);
      return d.length() < 1e-9 ? Vec2.ZERO : d;
    };
    return {
      pose() {
        const it = find();
        if (!it) return { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
        return { pos: new THREE.Vector3(it.pos.x, threeY(it.pos.y), handleZ(it)), quat: itemQuat(it) };
      },
      axes(mode): GizmoAxes {
        const it = find();
        if (!it) return null;
        // A light is placed through z - a lamp pulled toward the camera lights
        // a smaller circle of the plane (see `lightPlaneReach`).
        if (mode === "translate") return { x: true, y: true, z: hasDepth(it) };
        // A shape's rotation in the plane is the only one the level records;
        // a model also records its tilts out of it.
        if (mode === "rotate") return { x: it.object === "model", y: it.object === "model", z: true };
        // A model has one size, a uniform factor, which any box drags.
        if (it.object === "model") return { x: true, y: true, z: true };
        // Scale. An anchor is a point and a light is a reach authored by its own
        // radius handle, so neither has a size this could write; a collision
        // shape has no depth - `thickness` is what its mass is computed from.
        if (it.object === "anchor" || it.object === "light") return null;
        return { x: true, y: true, z: false };
      },
      begin() {
        const it = find();
        gizmoBegin();
        if (!it) return;
        base = { shape: cloneShape(it.shape), pos: it.pos, snapAt: moveSnapPoint([it]), scale: it.modelRef.scale };
      },
      apply(mode, pos, quat, scale) {
        const it = find();
        if (!it) return;
        if (mode === "translate" && base) {
          // The plane is snapped here rather than by three (see `syncGizmo`),
          // by the same corner a 2D drag lines up; depth has no corner and
          // snaps as the proxy's own z.
          const d = snapMove(base.snapAt, new Vec2(pos.x, threeY(pos.y)).sub(base.pos));
          it.pos = base.pos.add(d);
          gizmoSnapPoint = base.snapAt.add(d);
          if (hasDepth(it)) setDepth(it, snap(pos.z));
        } else if (mode === "rotate" && it.object === "model") {
          // Read back in the order it was built in (`itemQuat`).
          const e = new THREE.Euler().setFromQuaternion(quat, "ZYX");
          it.rot = threeRotation(e.z);
          it.modelRef.rotX = e.x;
          it.modelRef.rotY = e.y;
          if (base) it.pos = base.pos.add(swung(pos));
        } else if (mode === "rotate") {
          const e = new THREE.Euler().setFromQuaternion(quat, "ZXY");
          it.rot = threeRotation(e.z);
          if (base) it.pos = base.pos.add(swung(pos));
        } else if (base && it.object === "model") {
          // One factor, whichever box is dragged: the axis furthest from 1.
          const f = [scale.x, scale.y, scale.z].reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
          it.modelRef.scale = Math.max(MODEL_MIN_SCALE, Math.round(base.scale * f * 100) / 100);
        } else if (base) {
          scaleShape(it, base.shape, scale.x, scale.y, snapOn ? snapLen : undefined);
        }
        gizmoTouched();
      },
      end() {
        base = null;
        gizmoSnapPoint = null;
        rebuildInspector();
      },
    };
  }

  // SEVERAL THINGS AT ONCE: whatever the selection is - a handful of objects, a
  // handful of whole bodies - moved and turned as one arrangement about a single
  // point, which is what the gizmo standing at their middle says it will do.
  //
  // It is the one gesture the plane could never offer. The 2D overlay draws
  // handles on ONE shape and a rotate knob on ONE body (`computeGroupHandles`),
  // so laying out a run of pillars or a stack of crates meant turning each piece
  // about its own centre and then dragging every one of them back into
  // formation - an arrangement is a thing with a pose, and nothing in the editor
  // could say so.
  //
  // What it writes is exactly what a single body's gizmo writes, member by
  // member: each item's `pos` and `rot`, plus the frame of any body wholly
  // inside the selection (`placeGroup`). A body only half-selected keeps its
  // frame, so dragging two objects out of a compound body moves those two and
  // leaves the body they came from where it was - the rule every other group
  // edit in the editor already follows (`translateItems`, the nudge, delete).
  function selectionHandlers(ids: readonly number[]): GizmoHandlers {
    const wanted = new Set(ids);
    // Resolved by id every time, like `itemHandlers`: undo and redo replace the
    // model wholesale, so a captured item is a stale one the moment a drag is
    // undone.
    const items = (): EdItem[] => model.items.filter((i) => wanted.has(i.id));
    // Has ANY member somewhere to put a depth? The blue arrow is offered as soon
    // as one has (a light), and it moves every member that has one: a level's
    // collision is the gameplay PLANE and is never anywhere else, so a selection
    // holding one piece of collision would otherwise be one that could never
    // move its lamps through z.
    const anyZ = (list: readonly EdItem[]): boolean => list.some(hasDepth);
    let base: {
      pose: GroupPose;
      // Where the handles stood in depth, which is the mean of the members':
      // the gizmo sits in the middle of the selection in all three axes, and a
      // displacement is measured from there.
      z: number;
      own: Map<number, number>;
      snapAt: Vec2;
    } | null = null;
    return {
      pose() {
        const list = items();
        const c = selectionCentre(list);
        const z = list.length
          ? list.reduce((a, i) => a + handleZ(i), 0) / list.length
          : 0;
        return { pos: new THREE.Vector3(c.x, threeY(c.y), z), quat: new THREE.Quaternion() };
      },
      axes(mode): GizmoAxes {
        const list = items();
        if (list.length < 2) return null;
        if (mode === "translate") return { x: true, y: true, z: anyZ(list) };
        // In the plane only: a member's placement is two numbers and an angle in
        // that plane, so there is nowhere to put a tip.
        if (mode === "rotate") return { x: false, y: false, z: true };
        // Size is deliberately absent. Every member has its own, in its own
        // units - an outline, a light's reach - and one handle over the lot of
        // them would have to invent a rule for each. The members' own handles
        // say it exactly.
        return null;
      },
      begin() {
        gizmoBegin();
        const list = items();
        base = {
          pose: captureGroupPose(model, list, selectionCentre(list)),
          z: list.length ? list.reduce((a, i) => a + handleZ(i), 0) / list.length : 0,
          own: new Map(list.map((i) => [i.id, handleZ(i)])),
          snapAt: snapOutlineOf(list),
        };
      },
      apply(mode, pos, quat) {
        if (!base) return;
        const list = items();
        if (mode === "translate") {
          const centre = base.pose.centre;
          const d = snapMove(base.snapAt, new Vec2(pos.x - centre.x, threeY(pos.y) - centre.y));
          placeGroup(model, list, base.pose, d, 0);
          gizmoSnapPoint = base.snapAt.add(d);
          // A light's depth moves by the drag's displacement from where it was
          // at the press, so a drag that goes out through z and comes back
          // leaves each one as it was; a collision shape is passed over, the
          // plane being the only place it can be.
          const dz = snap(pos.z) - base.z;
          for (const i of list) {
            const was = base.own.get(i.id);
            if (was !== undefined && hasDepth(i)) setDepth(i, was + dz);
          }
        } else if (mode === "rotate") {
          // The ring returns to zero when the drag ends (`pose` answers the
          // identity), so what it means is a DELTA - the same reading a body's
          // ring has, and for the same reason: an arrangement has no angle of
          // its own to write.
          const e = new THREE.Euler().setFromQuaternion(quat, "ZXY");
          placeGroup(model, list, base.pose, Vec2.ZERO, threeRotation(e.z));
        }
        gizmoTouched();
      },
      end() {
        base = null;
        gizmoSnapPoint = null;
        rebuildInspector();
      },
    };
  }

  // A whole body. It has no z, no size and no rotation of its own - what it has
  // is a placement and an arrangement - so the handles offered are a move in the
  // plane and a turn about the centre of mass, which is the point the built body
  // rotates about and exactly what the 2D group handle turns it about.
  // A 3D FRAME'S HANDLES - a rock standing off the plane, a `Node3D` - the
  // full gizmo, as any 3D editor gives an object: move along x, y and z, turn
  // about all three, at the node's own origin and in its own orientation.
  // Everything under it is carried (`setNodeWorld`).
  // A frame of the PLANE (`plane`: a `Node2D`, `isFramePlane`) is moved the
  // same way and held to the plane, as a body is: a move along x and y and a
  // turn about z, its depth and tilt kept as they were.
  function body3dHandlers(id: string, plane = false): GizmoHandlers {
    const quatOf = (w: World3): THREE.Quaternion =>
      new THREE.Quaternion().setFromEuler(new THREE.Euler(w.tilt[0], w.tilt[1], threeRotation(w.rot), "ZYX"));
    let base: World3 | null = null;
    return {
      pose() {
        const w = worldOfNode(model, id);
        return { pos: new THREE.Vector3(w.pos.x, threeY(w.pos.y), w.z), quat: quatOf(w) };
      },
      axes(mode): GizmoAxes {
        if (!model.tree.nodes.has(id) || mode === "scale") return null; // a frame has no size
        if (plane) return mode === "translate" ? { x: true, y: true, z: false } : { x: false, y: false, z: true };
        return { x: true, y: true, z: true };
      },
      begin() {
        gizmoBegin();
        base = worldOfNode(model, id);
      },
      apply(mode, pos, quat) {
        if (!base) return;
        if (mode === "translate") {
          setNodeWorld(model, id, {
            ...base,
            pos: snapVec(new Vec2(pos.x, threeY(pos.y))),
            z: plane ? base.z : snapOn ? Math.round(pos.z / gridStep) * gridStep : pos.z,
          });
        } else if (mode === "rotate") {
          const e = new THREE.Euler().setFromQuaternion(quat, "ZYX");
          setNodeWorld(model, id, plane
            ? { ...base, rot: threeRotation(e.z) }
            : { pos: new Vec2(pos.x, threeY(pos.y)), rot: threeRotation(e.z), z: pos.z, tilt: [e.x, e.y] });
        }
        gizmoTouched();
      },
      end() {
        base = null;
        rebuildInspector();
      },
    };
  }

  function bodyHandlers(id: string): GizmoHandlers {
    const members = (): EdItem[] => bodyMembers(model.items, id);
    let base: {
      centre: Vec2;
      pos: Map<number, Vec2>;
      frame: EdBodyFrame;
      applied: number;
      snapAt: Vec2;
    } | null = null;
    return {
      pose() {
        return { pos: bodyTurnPoint(members()), quat: new THREE.Quaternion() };
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
          centre: bodyTurnCentre(items),
          pos: new Map(items.map((m) => [m.id, m.pos])),
          frame: bodyFrameOf(model, id),
          applied: 0,
          snapAt: snapOutlineOf(items),
        };
      },
      apply(mode, pos, quat) {
        if (!base) return;
        if (mode === "translate") {
          // Measured from where the body was, so a drag cannot accumulate the
          // grid's rounding across its own moves.
          const d = snapMove(
            base.snapAt,
            new Vec2(pos.x - base.centre.x, threeY(pos.y) - base.centre.y),
          );
          gizmoSnapPoint = base.snapAt.add(d);
          for (const m of members()) {
            const from = base.pos.get(m.id);
            if (from) m.pos = from.add(d);
          }
          // Written from the base for the same reason the members are: the drag
          // re-applies its whole displacement each frame rather than adding to
          // what it did last, so the frame has to be re-derived, not advanced.
          const frame = model.tree.nodes.get(id);
          if (frame && frame.item === null) frame.pos = base.frame.pos.add(d);
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
        gizmoSnapPoint = null;
        rebuildInspector();
      },
    };
  }

  // What the handles are on: a single object, a single body, or the whole
  // selection where it is wider than one of those. A chain has no transform at
  // all, so a chain or a vine in the selection is still nothing to attach to.
  //
  // The three are ordered by how MUCH is known about the target rather than by
  // how many things it holds: one object offers its own depth, tip and size; one
  // body turns about the centre of mass the engine mounts it at; a selection is
  // an arrangement, and what an arrangement has is a place and an angle.
  type GizmoTarget =
    | { kind: "item" | "decoration"; id: number }
    | { kind: "body"; id: string }
    | { kind: "selection"; ids: number[] }
    | { kind: "berry"; vineId: number; index: number }
    | { kind: "solid"; key: string };

  // A NODE of a solid guide's tree, picked in the
  // Formation panel (`solidSel`): moved, turned and sized in the tree's frame,
  // which is the formation item's placement (docs/formations.md). Every write
  // is a new tree on a new formation, never an edit in place, so the undo
  // snapshot taken at `begin` keeps the old one.
  function solidHandlers(): GizmoHandlers {
    const find = () => {
      const sel = solidSel;
      const it = sel ? model.items.find((i) => i.id === sel.itemId) : undefined;
      const guide = it?.formation?.guide;
      if (!sel || !it || guide?.kind !== "solid") return null;
      const node = nodeAt(guide.tree, sel.path);
      return node && !("op" in node) ? { sel, it, tree: guide.tree, node } : null;
    };
    const frameOf = (it: EdItem): THREE.Matrix4 =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(it.pos.x, threeY(it.pos.y), 0),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), threeRotation(it.rot)),
        new THREE.Vector3(1, 1, 1),
      );
    const nodeQuat = (n: SolidPrim): THREE.Quaternion =>
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(n.rot ?? [0, 0, 0]), "XYZ"));
    let baseScale: [number, number, number] = [1, 1, 1];
    return {
      pose() {
        const f = find();
        if (!f) return { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
        const frame = frameOf(f.it);
        const frameQuat = new THREE.Quaternion().setFromRotationMatrix(frame);
        return { pos: new THREE.Vector3(...(f.node.pos ?? [0, 0, 0])).applyMatrix4(frame), quat: frameQuat.multiply(nodeQuat(f.node)) };
      },
      axes(mode): GizmoAxes {
        const f = find();
        if (!f) return null;
        return { x: true, y: true, z: true };
      },
      begin() {
        gizmoBegin();
        baseScale = [...(find()?.node.scale ?? [1, 1, 1])];
      },
      apply(mode, pos, quat, scale) {
        const f = find();
        if (!f) return;
        const toTree = frameOf(f.it).invert();
        const local = pos.clone().applyMatrix4(toTree);
        let next: SolidPrim;
        if (mode === "translate") {
          next = { ...f.node, pos: [local.x, local.y, local.z] };
        } else if (mode === "rotate") {
          const q = new THREE.Quaternion().setFromRotationMatrix(toTree).multiply(quat);
          const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
          next = { ...f.node, rot: [e.x, e.y, e.z] };
        } else {
          next = { ...f.node, scale: [baseScale[0] * scale.x, baseScale[1] * scale.y, baseScale[2] * scale.z] };
        }
        const tree = replaceAt(f.tree, f.sel.path, () => next);
        f.it.formation = { ...f.it.formation!, guide: { kind: "solid", tree } };
        gizmoTouched();
      },
      end() {
        rebuildInspector();
      },
    };
  }

  // A BERRY picked out of its vine (`selectedBerry`): moved in the plane, its
  // root on the vine unmoved, exactly as dragging it on the overlay moves it.
  // It hangs in the gameplay plane, so the handles stand there.
  function berryHandlers(vineId: number, index: number): GizmoHandlers {
    const find = (): { vine: EdVine; root: Vec2; fruit: Vec2 } | null => {
      const vine = model.vines.find((v) => v.id === vineId);
      const path = vine?.starberry ? vineRestPath(model, vine) : null;
      if (!vine?.starberry || !path || index >= vine.starberry.along.length) return null;
      const root = pointAlong(path, vine.starberry.along[index]!);
      return { vine, root, fruit: root.add(berryOffset(index, vine.starberry)) };
    };
    // The radius a scale drag is measured against.
    let baseRadius: number | null = null;
    return {
      pose() {
        const b = find();
        return { pos: b ? new THREE.Vector3(b.fruit.x, threeY(b.fruit.y), 0) : new THREE.Vector3(), quat: new THREE.Quaternion() };
      },
      axes(mode): GizmoAxes {
        if (!find() || mode === "rotate") return null;
        // Moved in the plane; scaled as a whole, which is its radius.
        return { x: true, y: true, z: false };
      },
      begin() {
        gizmoBegin();
        const b = find();
        baseRadius = b ? berryRadius(index, b.vine.starberry!) : null;
      },
      apply(mode, pos, _quat, scale) {
        const b = find();
        if (!b) return;
        if (mode === "translate") {
          placeBerry(b.vine.starberry!, index, snapVec(new Vec2(pos.x, threeY(pos.y))).sub(b.root));
        } else if (mode === "scale" && baseRadius !== null) {
          // Either handle scales the whole berry: it is round.
          const factor = Math.abs(scale.x - 1) > Math.abs(scale.y - 1) ? scale.x : scale.y;
          sizeBerry(b.vine.starberry!, index, baseRadius * factor);
        }
        gizmoTouched();
      },
      end() {
        baseRadius = null;
        rebuildInspector();
      },
    };
  }

  function gizmoSpec(): GizmoTarget | null {
    if (mode === "test" || !sceneShown()) return null;
    // Drawing roots: a press on one starts a branch, so nothing may sit on it
    // waiting to be dragged instead.
    if (tool === "root") return null;
    const berry = currentBerry();
    if (berry) return { kind: "berry", vineId: berry.vine.id, index: berry.index };
    if (selectedChainIds.size || selectedVineIds.size) return null;
    // A node of a solid guide picked in the panel, while its formation (or the
    // formation's body) is what is selected.
    const solid = currentSolidSel();
    if (solid) {
      const it = model.items.find((i) => i.id === solid.itemId)!;
      const node = it.formation?.guide.kind === "solid" ? nodeAt(it.formation.guide.tree, solid.path) : null;
      if (node && !("op" in node)) return { kind: "solid", key: JSON.stringify(solid) };
    }
    if (selectedBodyIds.size === 1) return { kind: "body", id: [...selectedBodyIds][0]! };
    if (selectedIds.size === 1) {
      const id = [...selectedIds][0]!;
      // A decoration is what grew, in 3D, not its mark on the plane: a placed
      // one has handles of its own on it (`DecorationController.gizmo`), and
      // a painted one none - it is moved by painting, and the object handles
      // on its mark moved nothing but the mark.
      const dec = itemOf(id)?.decoration;
      if (dec) return isPainted(dec.kind) ? null : { kind: "decoration", id };
      return { kind: "item", id };
    }
    // Whatever Delete, Duplicate and a nudge would act on (`operandItems`), so
    // the gizmo and the keyboard move the same things: selected BODIES mean
    // every object in them, and selected objects mean themselves.
    const operands = operandItems();
    // Decorations alone have nothing the shared handles could move: those
    // would move their marks on the plane, not what grew.
    if (operands.every((i) => i.object === "decoration")) return null;
    const ids = operands.map((i) => i.id);
    return ids.length > 1 ? { kind: "selection", ids } : null;
  }

  // The key an attach is skipped on. It has to name the whole target, not just
  // its kind: a selection that gains or loses a member is a different target
  // with different members to move, and a key that said only "selection" would
  // leave the handles writing the set that was selected before.
  const gizmoKeyOf = (t: GizmoTarget | null): string =>
    t === null
      ? ""
      : t.kind === "selection"
        ? `selection:${t.ids.join(",")}`
        : t.kind === "berry"
          ? `berry:${t.vineId}:${t.index}`
          : t.kind === "solid"
            ? `solid:${t.key}`
            : // A body made 3D (or 2D), or a frame, is a different set of handles.
              `${t.kind}:${t.id}${t.kind === "body" ? (isFrame3D(t.id) ? ":3d" : isFramePlane(t.id) ? ":frame" : "") : ""}`;

  // The class a node is to these rules: a placed prefab takes its root's
  // (`rootType`), as everywhere else (level/nodes.ts `classOf`).
  function nodeClass(id: string): string | null {
    const n = model.tree.nodes.get(id);
    if (!n) return null;
    return n.type === "Instance" ? String(n.extra["rootType"] ?? n.type) : n.type;
  }

  // Is this unit a frame standing in the scene rather than the plane - a rock
  // with no body, a `Node3D` - and so moved with the full 3D handles?
  function isFrame3D(id: string): boolean {
    const type = nodeClass(id);
    return type === "Node3D" || (type === "Formation3D" && bodyAbove(model.tree, id) === null);
  }

  // Is this unit a frame of the plane - a `Node2D`, or a prefab placed with
  // one at its root - and so moved as a node, everything under it riding
  // (`setNodeWorld`)? It has no items of its own: as a body it was given the
  // body handles, which move the body's items and found none, so the gizmo
  // drew nothing (2026-11-26, Tris's `mine-track` once its root became a
  // `Node2D` holding two bodies).
  function isFramePlane(id: string): boolean {
    return nodeClass(id) === "Node2D" && !model.tree.nodes.get(id)?.body;
  }

  // What moves a target, for the gizmo's handles and for **G** alike, so the
  // two move the same thing the same way, in one undo step each.
  function handlersFor(spec: GizmoTarget): GizmoHandlers {
    return spec.kind === "selection"
      ? selectionHandlers(spec.ids)
      : spec.kind === "berry"
        ? berryHandlers(spec.vineId, spec.index)
        : spec.kind === "solid"
          ? solidHandlers()
          : spec.kind === "decoration"
            ? (decorations.gizmo(spec.id) ?? objectHandlers(spec.id))
            : spec.kind === "body"
            ? isFrame3D(spec.id)
              ? pivoted(body3dHandlers(spec.id), () => solidCentre(bodyMembers(model.items, spec.id)))
              : isFramePlane(spec.id)
                ? body3dHandlers(spec.id, true)
                : bodyHandlers(spec.id)
            : objectHandlers(spec.id);
  }

  // THE MODAL TRANSFORMS (Blender's **G**, **R** and **S**): what the gizmo
  // would move, turn or size follows the pointer until a click or Enter
  // places it, or Esc or a right click puts it back. Driven through the
  // gizmo's own handlers (`handlersFor`), so each does exactly what the
  // matching handle drag would, as one undo step, and a cancel leaves no step
  // behind.
  //
  // - Grab moves in the plane facing the camera through where the target
  //   stood (in a plane parallel to the gameplay plane for a target with no
  //   depth to move along); an axis holds it to that world axis.
  // - Rotate turns by the pointer's angle round the target's centre on
  //   screen, about the view axis (the world z for a target that turns only
  //   in the plane); an axis turns about that world axis instead. It snaps to
  //   the editor's 15° while snap is on, as the rings do.
  // - Scale sizes by the pointer's distance from the target's centre on
  //   screen against where it started, on every axis the target sizes along;
  //   an axis sizes along that one of the target's own (the gizmo's boxes are
  //   local too).
  //
  // CONSTRAINTS. X, Y or Z holds it to that axis; Shift+X, Y or Z to the
  // plane of the other two (a turn: about the axis left out, as Blender's).
  // The same key again frees it.
  //
  // NUMBERS (Blender's numeric input). Digits typed make it exact: metres for
  // a grab, degrees for a turn, a factor for a size. While a number is typed
  // the pointer is ignored; Backspace takes it back a character at a time
  // (Ctrl+Backspace all of it), and with nothing typed the pointer leads
  // again. Minus negates. One number per free axis, Tab stepping to the next
  // (X, then Y, then Z); a size's one number sizes every free axis until Tab
  // is pressed. A typed amount is not snapped to the grid.
  type XformKind = "translate" | "rotate" | "scale";
  type XformAxis = "x" | "y" | "z";
  const XFORM_AXES: readonly XformAxis[] = ["x", "y", "z"];
  // The smallest factor a size is taken to: a solid sized to nothing is no
  // solid at all.
  const MIN_SCALE_FACTOR = 1e-3;
  interface Xform {
    kind: XformKind;
    h: GizmoHandlers;
    axes: NonNullable<GizmoAxes>;
    pos0: THREE.Vector3;
    quat: THREE.Quaternion;
    plane: THREE.Plane;
    hit0: THREE.Vector3 | null;
    // The target's centre on screen, and where the pointer started (rotate
    // and scale measure from the centre; a grab held to a plane from the
    // start).
    centre: Vec2;
    start: Vec2;
    // Rotate: the pointer's angle last frame, and the turn so far (unwrapped,
    // so going round more than once keeps turning).
    lastAngle: number;
    turn: number;
    axis: XformAxis | null;
    // With `axis`: held to the plane of the other two instead (Shift).
    planeLock: boolean;
    // A guide sized as a whole whose shapes are turned off its axes
    // (`guideScaleHandlers`): evenly only.
    uniform: boolean;
    // The numbers typed, one per field (`fieldCount`): each one's digits and
    // sign, the field being typed into, and whether Tab has been pressed (a
    // size's first number then stops sizing every axis).
    typed: string[];
    neg: boolean[];
    field: number;
    tabbed: boolean;
    // The undo step `begin` pushed, so a cancel takes back that one only.
    step: EdModel | undefined;
  }
  let grab: Xform | null = null;
  const XFORM_NAMES: Record<XformKind, string> = { translate: "Grab", rotate: "Rotate", scale: "Scale" };
  const unitAxis = (a: XformAxis): THREE.Vector3 => new THREE.Vector3(a === "x" ? 1 : 0, a === "y" ? 1 : 0, a === "z" ? 1 : 0);
  const grabRay = new THREE.Raycaster();
  // Where the pointer's ray meets a plane.
  function rayOnPlane(plane: THREE.Plane, scr: Vec2): THREE.Vector3 | null {
    if (!visuals || !scene3d) return null;
    const n = visuals.ndc(scr);
    grabRay.setFromCamera(new THREE.Vector2(n.x, n.y), scene3d.camera);
    return grabRay.ray.intersectPlane(plane, new THREE.Vector3());
  }
  // A world point on the canvas (CSS pixels).
  function screenOfWorld(p: THREE.Vector3): Vec2 {
    const v = p.clone().project(scene3d!.camera);
    return new Vec2(((v.x + 1) / 2) * cssW, ((1 - v.y) / 2) * cssH);
  }
  // The pointer's angle about the centre, counterclockwise on screen.
  const screenAngle = (g: { centre: Vec2 }, scr: Vec2): number => Math.atan2(-(scr.y - g.centre.y), scr.x - g.centre.x);
  // The axes a grab moves along or a size sizes along: the one held, the two
  // of a held plane, or every one the target has.
  function freeAxes(g: Xform): XformAxis[] {
    const want = !g.axis ? XFORM_AXES : g.planeLock ? XFORM_AXES.filter((a) => a !== g.axis) : [g.axis];
    return want.filter((a) => g.axes[a]);
  }
  // How many numbers can be typed: one angle for a turn, one factor for a
  // guide sized evenly, else one per free axis.
  const fieldCount = (g: Xform): number => (g.kind === "rotate" || g.uniform ? 1 : Math.max(1, freeAxes(g).length));
  const isTyping = (g: Xform): boolean => g.typed.some((t, i) => t !== "" || g.neg[i]);
  // Field i's number; an empty one changes nothing (0, or a factor of 1).
  function typedValue(g: Xform, i: number): number {
    const t = g.typed[i] ?? "";
    const v = t === "" || t === "." ? (g.kind === "scale" ? 1 : 0) : Number(t);
    return g.neg[i] ? -v : v;
  }
  // THE READOUT, Blender's header: what a transform is doing, over the
  // viewport's top left for as long as it lasts. Not the title bar's notice,
  // which sits under the dock's tools, out of sight in Formations. Made on
  // first use, when the editor's root is there to hold it.
  let xformReadoutEl: { box: HTMLElement; amount: HTMLElement; hint: HTMLElement } | null = null;
  // An amount: plain text, and the number being typed (drawn with its caret).
  type ReadoutPart = string | { typing: string };
  function xformReadout(amount: readonly ReadoutPart[] | null, hint: string, warn = false): void {
    if (!xformReadoutEl) {
      const box = el("div", "ed-xform");
      const a = el("div", "ed-xform-amount");
      const h = el("div", "ed-xform-hint");
      box.append(a, h);
      box.setAttribute("role", "status");
      root.appendChild(box);
      xformReadoutEl = { box, amount: a, hint: h };
    }
    const r = xformReadoutEl;
    if (amount !== null) {
      r.amount.replaceChildren(
        ...amount.map((p) => {
          if (typeof p === "string") return document.createTextNode(p);
          const f = el("span", "ed-xform-field");
          f.textContent = p.typing;
          return f;
        }),
      );
    }
    r.hint.textContent = hint;
    r.hint.classList.toggle("ed-xform-warn", warn);
    r.box.hidden = false;
  }
  // Something it cannot do, said where the eye is.
  function xformWarn(text: string): void {
    xformReadout(null, text, true);
  }
  // What it is held to, and the amount on each free axis (`vals`, in metres,
  // degrees or a factor): the typed text in place of each amount while
  // typing, the field being typed into marked.
  function xformNotice(g: Xform, vals: readonly number[]): void {
    const typing = isTyping(g);
    const free = freeAxes(g);
    const unit = g.kind === "translate" ? " m" : g.kind === "rotate" ? "°" : "";
    const pre = g.kind === "scale" ? "×" : "";
    const amount = (i: number): ReadoutPart[] => {
      if (!typing) return [`${pre}${g.kind === "rotate" ? Math.round(vals[i] ?? 0) : (vals[i] ?? 0).toFixed(2)}${unit}`];
      const s = `${g.neg[i] ? "-" : ""}${g.typed[i] ?? ""}`;
      return i === g.field ? [pre, { typing: s }, unit] : [`${pre}${s || (g.kind === "scale" ? "1" : "0")}${unit}`];
    };
    const held =
      !g.axis ? "" : g.kind === "rotate" ? ` about ${g.axis.toUpperCase()}` : ` along ${free.map((a) => a.toUpperCase()).join(" and ")}`;
    // One number when there is one field, or a size's one number sizing
    // every free axis (until Tab).
    const one = fieldCount(g) === 1 || (g.kind === "scale" && !g.tabbed);
    const amounts = one ? amount(0) : free.flatMap((a, i) => [...(i ? [" · "] : []), `${a.toUpperCase()} `, ...amount(i)]);
    const keys = typing
      ? `${fieldCount(g) > 1 ? "Tab next axis · " : ""}Backspace · Enter places · Esc cancels`
      : "type a number · X Y Z axis · Shift+X Y Z plane · click or Enter places · Esc cancels";
    xformReadout([`${XFORM_NAMES[g.kind]}${held}: `, ...amounts], keys);
  }
  // **S** on a body holding a solid guide: a body has no size, so the guide
  // is what is sized - every shape of it, about its middle. Along one axis
  // of the guide's frame only while every shape lies along its axes
  // (`scaleTreeAxes`: sizing a turned shape along an axis would be a shear),
  // else evenly (`scaleTree`). Null for a body with no solid guide.
  function guideScaleHandlers(spec: GizmoTarget): { h: GizmoHandlers; perAxis: boolean } | null {
    if (spec.kind !== "body") return null;
    const f = bodyMembers(model.items, spec.id).find((m) => m.object === "formation" && m.formation?.guide.kind === "solid");
    if (!f) return null;
    const g0 = f.formation!.guide;
    const perAxis = g0.kind === "solid" && scaleTreeAxes(g0.tree, [0, 0, 0], [1, 1, 1]) !== null;
    const base = handlersFor(spec);
    let tree0: SolidNode | null = null;
    let centre: [number, number, number] = [0, 0, 0];
    const h: GizmoHandlers = {
      pose: () => base.pose(),
      axes: (m) => (m === "scale" ? { x: true, y: true, z: true } : base.axes(m)),
      begin() {
        beginAction();
        const g = f.formation!.guide;
        tree0 = g.kind === "solid" ? g.tree : null;
        if (tree0) centre = guideCentre(tree0);
      },
      apply(_m, _pos, _quat, scale) {
        if (!tree0) return;
        const k = (v: number): number => Math.max(MIN_SCALE_FACTOR, v);
        const even = scale.x === scale.y && scale.y === scale.z;
        const tree = even || !perAxis ? scaleTree(tree0, centre, k(scale.x)) : scaleTreeAxes(tree0, centre, [k(scale.x), k(scale.y), k(scale.z)]);
        if (!tree) return;
        f.formation = { ...f.formation!, guide: { kind: "solid", tree } };
        markDirty();
      },
      end() {
        tree0 = null;
        rebuildInspector();
      },
    };
    return { h, perAxis };
  }
  // Start one. False when the selection offers nothing of this kind (no
  // target, or a light that has no size), so the key can mean what it means
  // without a selection (R and S arm the Rect and Checkpoint tools in 2D).
  function startTransform(kind: XformKind): boolean {
    if (mode !== "edit" || !scene3d || !visuals || grab) return false;
    const spec = gizmoSpec();
    if (!spec) return false;
    const guideScale = kind === "scale" ? guideScaleHandlers(spec) : null;
    const h = guideScale?.h ?? handlersFor(spec);
    const axes = h.axes(kind);
    if (!axes || !(axes.x || axes.y || axes.z)) return false;
    const { pos, quat } = h.pose();
    const before = history[history.length - 1];
    h.begin(kind);
    const top = history[history.length - 1];
    // A target that cannot leave the gameplay plane's depth moves in a plane
    // parallel to it; anything else in the plane facing the camera.
    const normal = kind !== "translate" || axes.z ? scene3d.camera.getWorldDirection(new THREE.Vector3()) : new THREE.Vector3(0, 0, 1);
    const pointer = lastPointerScreen ?? new Vec2(cssW / 2, cssH / 2);
    const g: Xform = {
      kind,
      h,
      axes,
      pos0: pos.clone(),
      quat: quat.clone(),
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pos),
      hit0: null,
      centre: screenOfWorld(pos),
      start: pointer,
      lastAngle: 0,
      turn: 0,
      axis: null,
      planeLock: false,
      uniform: guideScale !== null && !guideScale.perAxis,
      typed: ["", "", ""],
      neg: [false, false, false],
      field: 0,
      tabbed: false,
      step: top !== before ? top : undefined,
    };
    grab = g;
    g.hit0 = rayOnPlane(g.plane, pointer);
    g.lastAngle = screenAngle(g, pointer);
    syncGizmo();
    xformNotice(g, kind === "rotate" ? [0] : freeAxes(g).map(() => (kind === "scale" ? 1 : 0)));
    canvas.style.cursor = kind === "translate" ? "move" : "crosshair";
    return true;
  }
  // How far the pointer has carried a grab, on its free axes only. Held to a
  // plane, the pointer's ray is met with that plane through where the target
  // stood, unless it is seen nearly edge on; otherwise with the plane facing
  // the camera, and the axes it may not move along dropped.
  function grabDelta(g: Xform, scr: Vec2): THREE.Vector3 | null {
    let d: THREE.Vector3 | null = null;
    if (g.axis && g.planeLock && scene3d) {
      const n = unitAxis(g.axis);
      if (Math.abs(n.dot(scene3d.camera.getWorldDirection(new THREE.Vector3()))) > 0.2) {
        const held = new THREE.Plane().setFromNormalAndCoplanarPoint(n, g.pos0);
        const from = rayOnPlane(held, g.start);
        const to = rayOnPlane(held, scr);
        if (from && to) d = to.sub(from);
      }
    }
    if (!d) {
      const hit = rayOnPlane(g.plane, scr);
      if (!hit) return null;
      if (!g.hit0) g.hit0 = hit.clone();
      d = hit.sub(g.hit0);
    }
    const free = freeAxes(g);
    for (const a of XFORM_AXES) if (!free.includes(a)) d[a] = 0;
    return d;
  }
  // The pointer moved: a turn keeps count of how far it has gone round (even
  // while a number is typed, so the pointer takes over again where it is).
  function moveTransform(scr: Vec2): void {
    const g = grab;
    if (!g) return;
    if (g.kind === "rotate") {
      const a = screenAngle(g, scr);
      let d = a - g.lastAngle;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      g.turn += d;
      g.lastAngle = a;
    }
    if (!isTyping(g)) applyTransform();
  }
  // Puts the target where the pointer, or the typed number, says.
  function applyTransform(): void {
    const g = grab;
    if (!g || !scene3d) return;
    const typing = isTyping(g);
    const scr = lastPointerScreen ?? g.start;
    const one = new THREE.Vector3(1, 1, 1);
    const free = freeAxes(g);
    // A typed amount is exact: the handlers' grid snap would round it.
    const run = (apply: () => void): void => {
      if (!typing) return apply();
      const was = snapOn;
      snapOn = false;
      try {
        apply();
      } finally {
        snapOn = was;
      }
    };
    if (g.kind === "translate") {
      const d = typing ? new THREE.Vector3() : grabDelta(g, scr);
      if (!d) return;
      if (typing) free.forEach((a, i) => (d[a] = typedValue(g, i)));
      run(() => g.h.apply("translate", g.pos0.clone().add(d), g.quat, one));
      xformNotice(g, free.map((a) => d[a]));
    } else if (g.kind === "rotate") {
      // Counterclockwise on screen is a right-handed turn about the axis
      // pointing at the viewer; about a world axis, by which way it faces. A
      // typed angle is right-handed about the axis itself, as Blender's.
      const back = scene3d.camera.getWorldDirection(new THREE.Vector3()).negate();
      const axis = g.axis ? unitAxis(g.axis) : g.axes.x && g.axes.y && g.axes.z ? back.clone() : new THREE.Vector3(0, 0, 1);
      let angle: number;
      if (typing) angle = (typedValue(g, 0) * Math.PI) / 180;
      else {
        const facing = axis.dot(back);
        angle = g.turn * (Math.abs(facing) < 1e-6 ? 1 : Math.sign(facing));
        if (snapOn) angle = Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
      }
      const q = new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(g.quat);
      run(() => g.h.apply("rotate", g.pos0, q, one));
      xformNotice(g, [(angle * 180) / Math.PI]);
    } else {
      const f = scr.distanceTo(g.centre) / Math.max(1, g.start.distanceTo(g.centre));
      const factor = (a: XformAxis): number => {
        const i = free.indexOf(a);
        if (i < 0) return 1;
        if (!typing) return f;
        return Math.max(MIN_SCALE_FACTOR, typedValue(g, g.tabbed ? i : 0));
      };
      run(() => g.h.apply("scale", g.pos0, g.quat, new THREE.Vector3(factor("x"), factor("y"), factor("z"))));
      xformNotice(g, free.map(factor));
    }
    syncGizmo();
  }
  function endTransform(keep: boolean): void {
    const g = grab;
    if (!g) return;
    grab = null;
    if (xformReadoutEl) xformReadoutEl.box.hidden = true;
    if (!keep) g.h.apply(g.kind, g.pos0, g.quat, new THREE.Vector3(1, 1, 1));
    g.h.end(g.kind);
    if (!keep && g.step && history[history.length - 1] === g.step) {
      // Nothing changed: the step the transform began is taken back unseen.
      replaceModel(history.pop()!);
      afterHistoryChange();
    }
    notice = null;
    updateTitle();
    rebuildInspector();
    syncGizmo();
    applyToolCursor();
  }
  // X, Y or Z (`planeLock`: with Shift) pressed mid-transform.
  function setTransformAxis(axis: XformAxis, planeLock: boolean): void {
    const g = grab;
    if (!g) return;
    const A = axis.toUpperCase();
    if (g.uniform) {
      xformWarn("This guide has shapes turned off its axes, so it sizes evenly; to size one shape along an axis, pick it in the guide's stack first");
      return;
    }
    const verb = g.kind === "translate" ? "move along" : g.kind === "rotate" ? "turn about" : "size along";
    // A turn held to a plane turns about the axis it leaves out.
    const ok = planeLock && g.kind !== "rotate" ? XFORM_AXES.some((a) => a !== axis && g.axes[a]) : g.axes[axis];
    if (!ok) {
      xformWarn(`This has ${planeLock && g.kind !== "rotate" ? `nothing but ${A}` : `no ${A}`} to ${verb}`);
      return;
    }
    const lock = planeLock && g.kind !== "rotate";
    const same = g.axis === axis && g.planeLock === lock;
    g.axis = same ? null : axis;
    g.planeLock = !same && lock;
    g.field = Math.min(g.field, fieldCount(g) - 1);
    applyTransform();
  }
  // A key typed into the transform's number (Blender's numeric input); false
  // when it is not one.
  function typeTransformKey(e: KeyboardEvent): boolean {
    const g = grab;
    if (!g) return false;
    const i = g.field;
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (digit && !e.ctrlKey && !e.altKey && !e.metaKey) g.typed[i] += digit[1];
    else if (e.code === "Period" || e.code === "NumpadDecimal" || e.code === "Comma") {
      if (!g.typed[i]!.includes(".")) g.typed[i] += ".";
    } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
      if (g.kind === "scale") {
        xformWarn("A negative factor would turn it inside out; type a factor above 0");
        return true;
      }
      g.neg[i] = !g.neg[i];
    } else if (e.code === "Backspace") {
      if (e.ctrlKey) {
        g.typed = ["", "", ""];
        g.neg = [false, false, false];
        g.field = 0;
        g.tabbed = false;
      } else if (g.typed[i]) g.typed[i] = g.typed[i]!.slice(0, -1);
      else if (g.neg[i]) g.neg[i] = false;
      else if (g.field > 0) g.field--;
    } else if (e.code === "Tab") {
      const n = fieldCount(g);
      if (n > 1) {
        g.field = (g.field + (e.shiftKey ? n - 1 : 1)) % n;
        g.tabbed = true;
      }
    } else return false;
    applyTransform();
    return true;
  }

  function syncGizmo(): void {
    if (!gizmo) return;
    // Put away while grabbing: the press that places the grab must not land
    // on a handle (three listens for it first). And while sculpting or
    // drawing a cut, where every press is the brush's or the polygon's.
    if (grab || sculptCtl?.active || sculptCtl?.cutting) {
      if (gizmoKey !== "grab") {
        gizmoKey = "grab";
        gizmo.attach(null);
      }
      return;
    }
    const spec = gizmoSpec();
    const key = gizmoKeyOf(spec);
    if (key !== gizmoKey) {
      gizmoKey = key;
      gizmo.attach(spec === null ? null : handlersFor(spec));
    }
    // The same 15° the 2D drags snap to. A move is NOT snapped by three: that
    // would round the proxy, which stands at the centre, and a 2D drag lines up
    // a corner (`moveSnapPoint`) - so the handlers snap the move themselves,
    // and a gizmo drag and a handle drag cannot land a body in different places.
    gizmo.setSnap(snapOn ? ANGLE_STEP : null);
    gizmo.follow();
  }

  function markDirty(): void {
    // The tree and the lists agree after every edit (`reconcileTree`).
    reconcileTree(model);
    // An open prefab keeps its one root: what the edit left beside it goes in.
    adoptPrefabStrays();
    // Every edit leaves a root a tree (rootEditing.ts): a branch whose parent
    // went away is a trunk, and every branch starts on its parent again.
    syncRoots(model);
    dirty = true;
    modelRev++;
    scheduleAutosave();
    savePrefabSoon();
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
  let itemOfSceneObject = new Map<SceneTag, number>();
  // ...and the way back, which is what a SELECTION needs: the editor knows the
  // item and has to name the drawn object to paint.
  let sceneObjectOfItem = new Map<number, SceneTag>();

  // The ball as it stands at the spawn, for the scene to draw (see
  // `syncEditorScene`). At the spawn point itself rather than at a rolling
  // entry's start (`SpawnData.roll`): the entry is drawn as its own ring on the
  // overlay, and where the ball comes to rest is the placement everything
  // around it was authored for.
  //
  // Rotation 0, which puts the mounting loop straight up - the pose a run opens
  // in, and the one the chain leaves through on the first throw.
  function spawnBall(): BallPlayer {
    const ball = new BallPlayer(model.player.radius * BallLevel.BALL_RADIUS_SCALE);
    ball.globalPosition = model.player.pos;
    return ball;
  }

  // WHAT THE SCENE IS BUILT FROM, as a string two builds can be compared by: the
  // level as the builder gets it, the vines' rest paths, and which item wrote
  // which object (the pick and highlight maps are rebuilt with the scene, so a
  // load or an undo that renumbers items must rebuild it even when nothing
  // drawn has moved).
  //
  // On a body whose pose at rest does not depend on its mass, two things are
  // left out. A collision piece's GEOMETRY and its debug geometry's settings,
  // for every piece but a belt: a dressed body's look is its Blender node,
  // placed in the world where Blender put it (`dressScene`), so moving a
  // corner of its outline changes no pixel of it, and the one thing here that
  // does draw the outline - the piece's debug geometry - is rebuilt IN PLACE
  // when that is all that changed (`Scene3D.restyleDebug`). And the body's
  // FRAME, with every other object said in the world instead: a frame is where
  // offsets are measured from, and an edit that moves it while every drawn
  // thing stays put - the frame of a body of one piece follows that piece -
  // draws the same scene.
  //
  // The bodies whose pose DOES depend on their mass are kept whole: a pivot
  // hangs its centre of mass under its bearing, a mover turns about it, and a
  // spring droops from it; water draws its own outline. Leaving one of those
  // out would draw a stale pose.
  //
  // What is NOT re-derived for such an edit is the throwaway world's own
  // collision, which nothing drawn in the preview reads; it catches up at the
  // next edit that rebuilds.
  function sceneKeyOf(data: LevelData, itemOf: ReadonlyMap<SceneTag, number>, vines: unknown): string {
    const nm = (v: number): number => Math.round(v * 1e9) / 1e9;
    const restsAsAuthored = (b: LevelBodyData): boolean =>
      b.kind !== "water" && b.pivot !== true && !(b.springFreqX ?? 0) && !(b.springFreqY ?? 0) && !isMover(b);
    const bodyOfNode = new Map(data.bodies.flatMap((b) => (b.node ? [[b.node.id, b] as const] : [])));
    // THE LOOK, from the tree (`lookNodes`), each thing by what it DRAWS and
    // where: in the world, or in its body's frame on a body whose pose
    // depends on its mass (which the engine moves the look with).
    const look = lookNodes(data.tree ?? []).map(({ node: n, world, body, formation }) => {
      const ridden = body ? bodyOfNode.get(body) : undefined;
      const w = poseOfFrame(world);
      const at = ridden && !restsAsAuthored(ridden) ? relative2D({ x: ridden.x, y: ridden.y, rot: ridden.rot }, w) : w;
      const pose = { x: nm(at.x), y: nm(at.y), rot: nm(at.rot), z: nm(w.z), tilt: [nm(w.tilt[0]), nm(w.tilt[1])] };
      const { type: _t, name: _n, children: _c, grouped: _g, locked: _lk, layers: _l, disabled: _d, x: _x, y: _y, rot: _r, ...fields } = n as LevelNode & Record<string, unknown>;
      switch (n.type) {
        // A formation draws what it BUILT, where it stands: its recipe and its
        // guide change no pixel until a Generate lands, so a parameter typed
        // into the panel rebuilds nothing.
        case "Formation3D":
          return { id: n.id, built: n.built, lod: n.lod, placedScale: n.placedScale, ...pose };
        // A decoration draws what it grew; where it stands now is moved in
        // place (`Scene3D.moveDecorations`), and its strokes are not here. A
        // material layer draws what the editor has for it now
        // (materialMasks.ts): its bake and its live mask.
        case "Decoration3D": {
          const o = { type: "decoration", formation: formation ?? "", ...fields } as DecorationObjectData;
          return { id: n.id, kind: n.kind, formation, built: n.built, ...(n.kind === "material" ? { live: materialMasks.drawKey(o) } : {}) };
        }
        default:
          return { type: n.type, ...fields, ...pose };
      }
    });
    const bodies = data.bodies.map((b) => {
      if (!restsAsAuthored(b)) return b;
      const { x: _x, y: _y, rot: _rot, ...body } = b;
      return {
        ...body,
        objects: b.objects.map((o) => {
          if (o.type === "collision" && o.shape.kind !== "belt") {
            const { shape: _s, x: _ox, y: _oy, rot: _or, thickness: _t, material: _m, soundMaterial: _sm, density: _dn, debug: _d, ...kept } = o;
            // Bark switches only rebuild this body's root visuals, not the
            // entire river scene and its lighting/shader warmup.
            if (o.root) {
              const { bark: _bark, ...root } = o.root;
              return { ...kept, root };
            }
            return kept;
          }
          // To the nanometre: an offset re-measured from a moved frame comes
          // back a rounding error from where it was, which is not a move.
          const w = worldPlacement(b, o);
          return { ...o, x: nm(w.pos.x), y: nm(w.pos.y), rot: nm(w.rot) };
        }),
      };
    });
    // Not the tree itself: every node's every field is in it, so a corner
    // dragged on an outline would read as a new scene. What it draws is `look`.
    const { tree: _tree, ...rest } = data;
    return JSON.stringify({ ...rest, bodies, look, vines, items: [...itemOf.values()] });
  }

  // THE GAME'S CAMERA, FOR THE FOG. The editor fogs every surface by the depth
  // the game's camera sees it at rather than its own (`render3d/editorFog.ts`),
  // so the haze reads as it plays at any zoom and orbit. That camera is the one
  // the game settles at with the ball at rest where the editor is looking -
  // the 3D scene is the ball's, hence `BALL_ZOOM` - framed through the level's
  // own lens in the game's fixed frame. Its rules are rebuilt per model
  // revision, since a camera path's index is not free.
  let fogRules: CameraRule[] = [];
  let fogRulesRev = -1;
  function gameFogCameraZ(): number {
    if (fogRulesRev !== modelRev) {
      fogRulesRev = modelRev;
      const data = toLevelData(model);
      fogRules = buildCameraRules(data.cameraRegions ?? [], data.cameraPaths ?? []);
    }
    // Where the view is looking: the 2D camera, read off the pose.
    const centre = camera.position;
    const zoom = restingCameraZoom(fogRules, centre, BALL_ZOOM);
    const lens = lensOf(model.camera);
    const game: Camera = { position: centre, zoom, viewportWidth: VIEW_WIDTH, viewportHeight: VIEW_HEIGHT };
    return lens.zOffset + cameraDistance(game, lens.fovYDeg);
  }

  function syncEditorScene(): void {
    if (!scene3d || sceneRev === modelRev) return;
    sceneRev = modelRev;
    const itemOf = new Map<SceneTag, number>();
    const data = toLevelData(model, itemOf);
    // Vines DO reach the 3D scene, where chains do not, and the difference is
    // that a vine's rest pose is exact rather than guessed: straight down
    // from its anchor by its authored length, or the resting catenary of a
    // span, until something moves it - a fact about the level rather than a
    // simulation of one (see `vineRestPath`). It has to be drawn there, too -
    // the overlay is dropped in the 3D-only and orbited views, and a vine is
    // the level rather than chrome.
    const vinePaths = model.vines.flatMap((v) => {
      const points = vineRestPath(model, v);
      return points ? [{ color: v.color, braidSeed: v.braidSeed, rope: v.rope, points,
        restLength: Math.max(v.length, points[0]!.distanceTo(points.at(-1)!)),
        attachedAtBothEnds: v.anchor2 !== null,
        ...(v.starberry ? { starberry: starberrySettings(v.starberry, v.length) } : {}) }] : [];
    });
    const key = sceneKeyOf(data, itemOf, vinePaths);
    if (key === sceneKey) {
      // Nothing the scene draws has changed but, at most, some pieces' debug
      // geometry - a corner of a drawn piece dragged, its colour retuned, its
      // switch flipped - which is rebuilt in place, body by body; and where
      // the decorations stand, moved in place.
      scene3d.restyleDebug(data.bodies);
      scene3d.moveDecorations(data.tree ?? []);
      return;
    }
    const world = new World();
    let built: ReturnType<typeof buildLevelBodies>;
    try {
      built = buildLevelBodies(world, data, () => {});
    } catch (err) {
      // The scene on screen stays the last one that built (see `buildError`),
      // and so do the maps that pick it.
      noteBuildError(err);
      return;
    }
    noteBuildError(null);
    itemOfSceneObject = itemOf;
    sceneObjectOfItem = new Map();
    for (const [object, id] of itemOfSceneObject) sceneObjectOfItem.set(id, object);
    // The look - rocks, decorations, models - is drawn from the level's tree
    // (render3d/treeLook.ts) and answers a pick with its NODE's id.
    for (const i of model.items) {
      if (i.object === "formation" || i.object === "decoration" || i.object === "model") {
        itemOfSceneObject.set(i.node as unknown as SceneTag, i.id);
        sceneObjectOfItem.set(i.id, i.node as unknown as SceneTag);
      }
    }
    sceneLevel = {
      world,
      vines: vinePaths.map(({ color, braidSeed, rope, points, restLength, attachedAtBothEnds, starberry }) => ({
        color,
        braidSeed,
        rope,
        restLength,
        attachedAtBothEnds,
        ...(starberry ? { starberry } : {}),
        path: (_alpha: number, out: Vec2[]) => {
          out.length = 0;
          out.push(...points);
        },
      })),
      // Chains stay on the 2D canvas while editing: the editor draws a chain
      // STRAIGHT on purpose (a span between wrap nodes is straight, and a
      // guessed sag would be a drawing of something the level does not contain),
      // and solving them here to draw them would be a second simulation running
      // under the editor.
      sceneChains: [],
      visualSource: { data, built },
      // THE AVATAR AT THE SPAWN, because a level is authored against the thing
      // that plays it. Every gap, ledge and shelf in the file is a decision
      // about a 12 cm iron ball, and a ring drawn on the overlay says where the
      // run starts without saying how much room it takes - so a slot judged by
      // eye in the editor was judged against nothing until it was played.
      //
      // Built here rather than borrowed from a `BallLevel`, and at the radius it
      // is PLAYED at (`BALL_RADIUS_SCALE` over the authored spawn radius, which
      // is the grapple avatar's), so what stands in the scene is the size that
      // has to fit. It is a body nothing steps: `BallVisual` reads its pose, and
      // with no chain thrown there is nothing else of the assembly to draw.
      // None over an open prefab: it has no spawn, and the model's stands at
      // the prefab's origin, a 12 cm ball drawn over whatever is there.
      ...(prefabMode ? {} : { ball: spawnBall() }),
    };
    scene3d.setLevel(sceneLevel);
    sceneKey = key;
    sceneBuilds++;
    highlightKey = null; // a fresh scene holds none of the last one's paint
  }

  // WHAT IS SELECTED, SAID IN THE SCENE: on the model as well as on the
  // overlay's outline, since with a scene drawn the model is what is looked at.
  //
  // The colours are the overlay's own, so the two views say the same thing -
  // orange is "an edit applies to this", blue is "this is what the selected body
  // is made of". What carries a pick tag is a collision object's debug
  // geometry and a body's Blender dressing, which answers as the body's first
  // object (`DressTarget.tag`); a light or an anchor is simply nothing to paint.
  let highlightKey: string | null = null;
  function syncHighlight(): void {
    if (!scene3d) return;
    const rocksKey = workspace === "formations" ? `${formationViewRev}|${combineRev}` : "-";
    const key = `${sceneBuilds}|${hiddenRev}|${rocksKey}|${[...selectedIds].join(",")}|${[...selectedBodyIds].join(",")}`;
    if (key === highlightKey) return;
    highlightKey = key;
    // The hidden bodies' drawn objects (H), from the same map.
    const hiddenTags = new Set<unknown>();
    if (hiddenBodies.size || hiddenUserLayers.size) {
      for (const item of model.items) {
        if (!itemHidden(item)) continue;
        const object = sceneObjectOfItem.get(item.id);
        if (object) hiddenTags.add(object);
      }
    }
    // ...and in Formations, the rocks it is set not to draw (`rockShown`):
    // hidden as the H-hidden are, so neither drawn nor picked.
    if (workspace === "formations") {
      for (const item of model.items) {
        if (item.object !== "formation" || rockShown(item)) continue;
        const object = sceneObjectOfItem.get(item.id);
        if (object) hiddenTags.add(object);
      }
    }
    scene3d.setHidden(hiddenTags);
    const tags = new Map<unknown, string>();
    const paint = (id: number, color: string): void => {
      const object = sceneObjectOfItem.get(id);
      if (object) tags.set(object, color);
    };
    for (const item of model.items) {
      if (selectedBodyIds.has(item.unit)) paint(item.id, BODY_MEMBER);
    }
    // Second, so an object picked out of a selected body reads as the selection
    // rather than as one more of its siblings.
    for (const id of selectedIds) paint(id, SELECT);
    // The guides picked to combine with the selected one, in the combine
    // colour (their guides are drawn in front too: `solidView.sync`).
    for (const id of combine?.picks ?? []) paint(id, COMBINE_PICK);
    scene3d.setHighlight(tags);
  }

  // --- mode: edit | test ----------------------------------------------------
  // (`mode` itself is declared above `resize`, which reads it.)
  let testLevel: BallLevel | null = null;
  // The same object, typed as what the 3D renderer wants of it.
  let testLevel3d: Scene3DLevel | null = null;
  // The editor's own 3D scene while a test is drawn in its place (see
  // `startTest`), or null.
  let editScene: LevelScene | null = null;
  // The hook's sparks while a test runs (see render/sparks.ts). One system for
  // the editor's life, cleared at every ▶ Test, so a test never opens carrying
  // the embers of the last one.
  const testSparks = new SparkSystem();
  // ...and the debris of whatever breaks in it (see render/debris.ts), on the
  // same terms: a level whose breakable geometry is being authored has to be
  // seen breaking from inside the editor.
  const testDebris = new DebrisSystem();
  // ...and the leaves and slime the cuff knocks loose in it (see
  // render/leafShed.ts, render/vineSlime.ts).
  const testLeaves = new LeafShed();
  const testSlime = new VineSlime();
  // ...and a chain that snaps in it (see render/chainSnap.ts).
  const testSnap = new ChainSnap();
  // ...and a chain let go in it, reeling back into the ball (see
  // render/chainRetract.ts), as the game draws and plays it.
  const testRetract = new ChainRetract();
  // ...and what it sounds like (see audio/soundSystem.ts), played with the
  // Sounds menu's own copy of the assignments, so a file assigned there is
  // heard on the next step of a test. At the game's default volume, so what
  // is judged here is what a player hears; it does not listen for broadcasts,
  // being the page that sends them.
  const testSound = new SoundSystem("medium", { listen: false });
  let ballInput: BallInputSource | null = null;
  let savedCam: { pos: Vec2; zoom: number } | null = null;
  // The test run's camera (eased follow + camera regions). Separate from the
  // editor's own camera handling, which is a direct pan/zoom.
  const testCameraCtl = new CameraController();
  // See the `edge clamp` toggle: an authoring instrument for ▶ Test, not a
  // level property, so it is remembered by the browser (prefs.ts) and
  // never written to a file.
  let edgeClampOn = viewSettings.edgeClamp;

  // Full-session recording of the current test run — press P to download a
  // self-contained replay bundle (embeds the tested geometry, since an
  // in-editor level isn't in the registry). Mirrors main.ts's P export.
  // The game's debug overlay (L) inside ▶ Test. Off at the start of every test:
  // it is an instrument, and a test opens as the picture the player gets.
  let testShowDebug = false;
  // Has this test already said the line was crossed? The sim's
  // `completedFrame` is set for every frame after it, so without this the toast
  // would be raised sixty times a second for the rest of the run.
  let testFinished = false;
  let testData: LevelSource | null = null;
  // The test's bundle, as `main.ts` records the game's: every input, and the
  // avatar's and every moving body's digest for the last thirty seconds and one
  // a second before that (see sim/runRecording.ts). A test-mode bundle without
  // the world digests can say where the AVATAR first left the recording and
  // nothing about what the body it was anchored to was doing, which is the
  // wrong half of a chain bug.
  const recording = new RunRecording();
  // The raw DOM button story beside the frames, as `main.ts` carries it (see
  // input/inputTrace.ts): session-2191f was a test-mode bundle with a dropped
  // click near its end and no trace to place it with, because only the game's
  // export had one. Stamped with the test's run number, and with -1 outside a
  // test, so `cli clicks` lays only the tested run's events against the frames.
  let testRuns = 0;
  const inputTrace = new InputTrace(
    canvas,
    () => ({
      run: mode === "test" ? testRuns : -1,
      frame: testLevel?.frame ?? 0,
    }),
    () => BUTTON_BITS.ball,
  );
  inputTrace.install();

  // `spawn` (world metres) overrides the level's own spawn marker for this run
  // only — the model is untouched, so a spot-check from the cursor never edits
  // the level. It is baked into the data the test level is built from, so a
  // reset (and the exported bundle) respawns at the same place.
  function startTest(spawn?: Vec2): void {
    if (mode === "test") stopTest();
    const asked = testDataFor(spawn);
    // The level built ahead (`prebuildTest`) when it is of exactly this data,
    // or one built now. A level the build refuses cannot be played, and the
    // refusal is a throw from inside the level's constructor - so the level is
    // built FIRST, before the camera and the recording are handed over to a
    // test that would never start, and the refusal said where the title says
    // it.
    const ready = prebuilt?.key === testKeyOf(asked) ? prebuilt : null;
    if (!ready) discardPrebuilt();
    prebuilt = null;
    // Asked for again once the editor is idle: this one is about to be played.
    prebuildAsked = null;
    const pixelData = ready?.data ?? asked;
    let level: BallLevel;
    try {
      level = ready?.level ?? buildTestLevel(pixelData);
    } catch (err) {
      noteBuildError(err);
      return;
    }
    testShowDebug = false;
    // A test opens as the game does, with the pieces' debug geometry drawn.
    scene3d?.setDebugShown(true);
    // ...through the player's lens at its fullest: the maximum depth of field,
    // whatever the game's settings panel was left at, so a test always judges
    // the level by the deepest blur a player can choose (the editor's own view
    // is drawn without it). Nothing of the editor's is in the picture - the
    // paint marks, the solid guides, the guides of the old Visuals view - since
    // a test is meant to be the level exactly as it is played.
    scene3d?.setDepthOfField(DEPTH_OF_FIELD_LEVELS[DEPTH_OF_FIELD_LEVELS.length - 1]);
    if (scene3d) scene3d.editorLayer.visible = false;
    // The camera is the game's for the test: no projection through the
    // editor's turned view (see the frame loop).
    attachProjector(camera, null);
    // The game is on the card the bakes use: none starts while this runs.
    formationJobs.hold(true);
    testFinished = false;
    savedCam = { pos: camera.position, zoom: camera.zoom };
    // The test is played in the game's fixed 16:9 frame, so the camera is given
    // the frame's dimensions rather than the editor window's: `viewportScale`,
    // the follow point and every pointer un-projection are in view pixels while
    // a test runs, exactly as they are in the game.
    camera.viewportWidth = VIEW_WIDTH;
    camera.viewportHeight = VIEW_HEIGHT;
    testData = pixelData;
    testRuns++;
    recording.clear();
    // The camera controller owns the zoom from here (base framing × the active
    // region's viewportScale), and re-derives it every frame, so a resize
    // mid-test needs no separate handling.
    testCameraCtl.edgeClamp = edgeClampOn;
    testCameraCtl.snap();
    testLevel = level;
    ballInput ??= new BallInputSource(
      canvas,
      camera,
      () => testLevel?.ball.globalPosition ?? Vec2.ZERO,
      // The input source outlives the test that made it, so its canvas
      // listeners are still live in edit mode. Without this a click meant for a
      // body or the toolbar takes pointer lock and the editor loses its cursor
      // to a level nobody is playing (see input/aimPointer.ts).
      () => mode === "test",
    );
    testLevel.onReset = () => startTest(spawn);
    // A test uses the real game render path, so the 3D scene comes with it: the
    // level IS a `Scene3DLevel`, carrying the `visualSource` the renderer reads.
    testLevel3d = testLevel;
    // The editor's own scene is PARKED for the length of the test rather than
    // thrown away (see render3d/levelScene.ts): built still, its materials
    // keep the programs the test's scene - the same level, built again - is
    // drawn with, and `stopTest` puts it straight back up. Thrown away, each
    // way cost a rebuild and a relink of the same programs: on `ball`, a
    // ~1 s frame at the start of a test and ~0.9 s over three on the way back.
    if (sceneShown()) editScene = scene3d!.show(ready?.scene ?? scene3d!.prepare(level));
    else if (ready?.scene) scene3d?.retire(ready.scene);
    // A test is the player's camera and the player's picture, from whichever
    // workspace it started in: the Visuals pose and guides are set aside here
    // and taken up again when the test stops, so Esc returns to the view it
    // left rather than to the Level workspace.
    visuals?.suspend();
    accumulator = 0;
    lastNow = -1;
    testSparks.reset();
    testDebris.reset();
    testLeaves.reset();
    testSlime.reset();
    testSnap.reset();
    testRetract.reset();
    mode = "test";
    // AFTER the mode flips, because that is the thing `gizmoSpec` asks about.
    // The gizmo lives in the SCENE rather than on the overlay, so it is still
    // drawn once the test takes the canvas - a set of editing arrows hanging in
    // the middle of the level being played. `gizmoSpec` already answers null in
    // test mode; what it lacked was anyone to ask it, since the sync runs on the
    // edit frame loop and a test has its own. Selecting something and pressing
    // ▶ Test is the ordinary way in now that a checkpoint is tested by being
    // selected, so the detach happens here, and `stopTest` asks again.
    syncGizmo();
    root.style.display = "none";
    testBanner.textContent = TEST_BANNER;
    testBanner.style.display = "block";
    // The ball controller draws its own aim reticle, so the OS cursor would be
    // a second pointer — hide it.
    canvas.style.cursor = "none";
  }

  function downloadTestRecording(): void {
    if (!testData || recording.length === 0) return;
    const rec: Recording = {
      level: currentName ?? "editor",
      git: treeCommit,
      dirty: treeDirty,
      srcHash: treeSrcHash,
      controller: "ball",
      data: testData,
      ...recording.bundle(),
      inputTrace: inputTrace.bundle(),
    };
    // The same check the game's P-download runs: a bundle that does not
    // reproduce on the machine that made it is a determinism finding, and this
    // is the last place anyone can be told so (see sim/selfReplay.ts). Off the
    // page's thread, so the test does not freeze while it runs.
    const name = `session-${rec.frames.length}f.json`;
    showToast(`${name}\nself-replay: checking…`);
    void verifySelfReplayOffThread(rec)
      .catch((err: unknown) => {
        console.warn(`[self-replay] ${String(err)}; checking on the page instead`);
        return verifySelfReplay(rec);
      })
      .then((verdict) => {
        rec.selfReplay = verdict;
        showToast(`${name}\n${selfReplayLine(verdict)}`, verdict.identical ? "ok" : "warn");
        const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      });
  }

  function stopTest(): void {
    mode = "edit";
    formationJobs.hold(false);
    testLevel = null;
    testLevel3d = null;
    // The test's loops (a roll, the whoosh) fade rather than hang on at the
    // level the last step left them.
    testSound.silence();
    // The edit-mode scene, parked by `startTest`, goes back up and the test's
    // goes. The model cannot change during a test, so the parked scene is of
    // the model as it stands. With none parked (a test started without the
    // 3D view, or before the editor's scene ever built) the edit-mode scene is
    // rebuilt on the next frame rather than left showing the level that just
    // stopped - whatever the key says, since the key is of the model and the
    // model has not changed.
    if (scene3d && editScene) {
      scene3d.retire(scene3d.show(editScene));
      editScene = null;
    } else {
      sceneRev = -1;
      sceneKey = null;
    }
    // Authoring always sees the debug geometry it is configuring, whatever the
    // test's G left it at.
    scene3d?.setDebugShown(true);
    // ...without the lens, and with the editor's marks back (see startTest).
    scene3d?.setDepthOfField("off");
    if (scene3d) scene3d.editorLayer.visible = true;
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
    // Test mode's input source may hold pointer lock (see input/aimPointer.ts).
    // Leaving the test has to give the cursor back whichever way it was left, or
    // the editor comes back with nothing to click its toolbar with.
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    // ...and the selection's gizmo comes back with the editor (see startTest),
    // and the Visuals workspace's view, if the test was started from there.
    visuals?.resume();
    syncGizmo();
  }

  // The data a test from `spawn` (world metres; the level's own spawn when
  // absent) is built from.
  //
  // A ROLLING ENTRY IS NOT PLAYED HERE (`spawnWithoutEntry`, the same drop a
  // checkpoint start makes - see `SpawnData.roll`). A test is a spot-check of
  // the thing being edited - press it, see whether the ledge is reachable,
  // press Esc, move the ledge - and an entry is the opening of a RUN: two
  // metres of rolling in and a second of hands off, between every edit and the
  // thing it is being checked against. The game plays the opening; the editor
  // plays the level.
  //
  // The spawn override is baked in here rather than into the model, so a
  // spot-check never edits the level, and a reset (and the exported bundle)
  // respawns at the same place.
  // The level as a bundle embeds it (`embeddedLevelOf`): the tree in pixels,
  // its placed prefabs expanded, so a test replays - and draws - as played
  // whatever the prefabs it places become later.
  function testDataFor(spawn: Vec2 | undefined): LevelSource {
    return spawnMovedTo(embeddedLevelOf(modelToDisk(model)), spawn ? { x: spawn.x * M2PX, y: spawn.y * M2PX } : null);
  }

  function testKeyOf(data: LevelSource): string {
    return JSON.stringify(data);
  }

  function buildTestLevel(data: LevelSource): BallLevel {
    return new BallLevel(data);
  }

  // ▶ TEST, BUILT AHEAD. A test's level is a real build of the level - its
  // chains and vines settled to rest, ~80 ms on `ball` (`settleVinesAtBuild`)
  // - and its 3D scene ~30 ms more, which paid at the press was one frame of
  // that length between the click and the test. So both are built before the
  // press, at the two moments a long frame is least seen:
  //
  // - when the pointer comes onto a ▶ Test button, the click being on its
  //   way. The system cursor moves on regardless, and the button's own hover
  //   is all the page has to show for it.
  // - when the editor has been idle for `PREBUILD_QUIET_MS` - no edit, no
  //   press, no key, no wheel, and so no drag or orbit - the level and, on a
  //   later frame, its scene (two shorter frames rather than one of both).
  //   Long enough that an author mid-edit is not met by it after every
  //   change: at 0.6 s it landed after every pause in a run of nudges.
  //
  // The press then only puts it up. What is built ahead is exactly what the
  // press would build: it is kept under the data itself, compared at the
  // press, so an edit that moved no revision is a build at the press rather
  // than a test of a stale level. `B` (from the cursor) has nowhere to be built
  // ahead for, and builds at the press as before.
  const PREBUILD_QUIET_MS = 1500;
  let prebuilt: { key: string; data: LevelSource; level: BallLevel; scene: LevelScene | null } | null = null;
  // What the last prebuild was of - the revision, the controller, the start,
  // whether a scene was wanted - so each is built once rather than every idle
  // frame. Cleared by a test, whose level is played and so has to be built
  // again.
  let prebuildAsked: string | null = null;
  // When the editor last stopped being still: an edit, a press, a wheel.
  let stillSince = 0;
  let stillRev = -1;
  let buttonsHeld = false;
  window.addEventListener("pointerdown", () => {
    buttonsHeld = true;
    stillSince = performance.now();
  }, true);
  for (const type of ["pointerup", "pointercancel"] as const) {
    window.addEventListener(type, (e) => {
      buttonsHeld = e.buttons !== 0;
      stillSince = performance.now();
    }, true);
  }
  for (const type of ["wheel", "keydown"] as const) {
    window.addEventListener(type, () => (stillSince = performance.now()), { capture: true, passive: true });
  }

  function discardPrebuilt(): void {
    if (prebuilt?.scene) scene3d?.retire(prebuilt.scene);
    prebuilt = null;
  }

  // Once an edit frame, while editing; and `eager` when the pointer comes onto
  // a ▶ Test button, which builds whatever is not built yet there and then.
  function prebuildTest(now: number, eager = false): void {
    if (mode !== "edit") return;
    if (modelRev !== stillRev) {
      stillRev = modelRev;
      stillSince = now;
    }
    if (!eager && (drag || buttonsHeld || now - stillSince < PREBUILD_QUIET_MS)) return;
    const spawn = testSpawn();
    const wantScene = sceneShown() && scene3d !== null;
    const asked = `${modelRev}|${spawn ? `${spawn.x},${spawn.y}` : "spawn"}|${wantScene}`;
    if (asked !== prebuildAsked) {
      prebuildAsked = asked;
      discardPrebuilt();
      const data = testDataFor(spawn);
      try {
        prebuilt = { key: testKeyOf(data), data, level: buildTestLevel(data), scene: null };
      } catch {
        // Refused: the press will say so, where the title does.
      }
      if (!eager) return;
    }
    if (prebuilt && wantScene && !prebuilt.scene) prebuilt.scene = scene3d!.prepare(prebuilt.level);
  }

  // --- DOM ------------------------------------------------------------------
  injectStyles();
  const root = document.createElement("div");
  root.className = "ed-root";
  document.body.appendChild(root);

  const testBanner = document.createElement("div");
  testBanner.className = "ed-test-banner";
  testBanner.textContent = TEST_BANNER;
  testBanner.style.display = "none";
  document.body.appendChild(testBanner);

  // The formation jobs, in a corner over the canvas while there are any.
  formationJobs.connect();
  mountJobsPanel(root, formationJobs);
  // A running job's progress in the Formation section, between rebuilds.
  formationJobs.onChange(() => {
    for (const s of inspector.querySelectorAll<HTMLElement>(".ed-formation-status, .ed-asset-status")) s.dispatchEvent(new Event("refresh"));
    // ...and the out-of-date counts in the 3D workspaces' docks.
    refreshWorkspaceDock();
  });

  // THE TOOL SETTINGS (Blender's tool header): a strip across the top of the
  // viewport holding what the workspace's tools are set to and what it does
  // to the level as a whole - a brush's radius, Generate. 2D has none: its
  // tools are set as they draw (a new shape's body is asked for at the shape,
  // Root's widths stand in a card while it is armed), so in 2D the strip is
  // not there and the view starts under the workspace tabs.
  // The tools themselves are the TOOLBAR, a column of icons over the
  // viewport's left edge (editor/toolbar.ts), one set per workspace.
  const bar = el("div", "ed-toolhead");
  bar.setAttribute("aria-label", "Tool settings");
  const toolbar = el("div", "ed-toolbar");
  installToolTips(toolbar);
  const fitToolbar = watchToolbarWidth(toolbar, root);
  root.appendChild(bar);

  // The right dock's tabs: the SCENE tree of what is open (the level, or the
  // prefab being edited), or the PREFAB library. How it is seen is the one 3D
  // view's, the same for both.
  const workspaceBtns: Partial<Record<"level" | "prefabs", HTMLButtonElement>> = {};
  workspaceBtns.level = button("Scene", () => {
    prefabsShown = false;
    refreshDocButtons();
    rebuildInspector();
  });
  workspaceBtns.level.title = "The scene tree: every node of what is open, nested as it is nested";
  workspaceBtns.prefabs = button("Prefabs", () => {
    prefabsShown = true;
    refreshDocButtons();
    rebuildInspector();
  });
  workspaceBtns.prefabs.title = "The prefab library: shared node trees to place, open and make (plans/node-tree.md \"Prefabs\")";
  for (const b of [workspaceBtns.level, workspaceBtns.prefabs]) b.setAttribute("role", "tab");

  // THE TOP BAR: the File menu, the level's own settings, the workspace tabs
  // and ▶ Test.
  const fileRow = el("div", "ed-row ed-file-row ed-commandbar");
  root.appendChild(fileRow);
  const newLevel = (): void => {
    // Over an open prefab: the prefab is written and left first.
    if (prefabMode) {
      void closePrefab().then((ok) => {
        if (ok) newLevel();
      });
      return;
    }
    if (dirty && !confirm("Discard unsaved changes?")) return;
    cancelAutosave();
    replaceModel(emptyModel());
    resetHistory();
    selectedIds.clear();
    selectedVerts.clear();
    selectedBodyIds.clear();
    currentName = null;
    writeLastLevel(null);
    dirty = false;
    camera.position = Vec2.ZERO;
    poseFromCameraNow();
    rebuildInspector();
    updateTitle();
  };
  // The saved levels, as the server last listed them (`refreshLevelList`).
  let levelNames: string[] = [];
  const openLevel = async (name: string): Promise<void> => {
    if (name === currentName && !dirty) return;
    // An open prefab is written by the load (`doLoad`), not discarded.
    if (!prefabMode && dirty && !confirm("Discard unsaved changes?")) return;
    await doLoad(name);
  };
  const deleteFile = async (): Promise<void> => {
    if (!currentName) return;
    if (!confirm(`Delete level "${currentName}" from disk?`)) return;
    cancelAutosave(); // a queued write would recreate the file
    await deleteLevel(currentName);
    currentName = null;
    writeLastLevel(null);
    dirty = true;
    await refreshLevelList();
    updateTitle();
  };
  // The game's sounds (see soundMenu.ts): not part of any level, so with the
  // files rather than in the inspector, and heard in ▶ Test as they change.
  // Its panel links the sound mixer and the sound lab.
  const soundMenu = new SoundMenu(root, testSound);
  const fileMenu = menuButton("File", () => [
    { kind: "item", label: "New", title: "Start an empty, unsaved level", run: newLevel },
    {
      kind: "sub",
      label: "Open",
      title: "Open a saved level",
      entries: () =>
        levelNames.length
          ? levelNames.map((n) => ({ kind: "item", label: n, checked: n === currentName, run: () => void openLevel(n) }))
          : [{ kind: "note", label: "No saved levels" }],
    },
    { kind: "sep" },
    { kind: "item", label: "Save", title: currentName ? `Save to levels/${currentName}.json` : "Save under a new name", run: () => void doSave(false) },
    { kind: "item", label: "Save As…", title: "Save under a new name, which is then the level open", run: () => void doSave(true) },
    { kind: "sep" },
    {
      kind: "item",
      label: "Sounds…",
      title: "Assign sound files to the game's events: rolling, attaching, bouncing, winding, the whoosh",
      checked: soundMenu.isOpen,
      run: () => soundMenu.toggle(),
    },
    { kind: "sep" },
    {
      kind: "item",
      label: "Delete File",
      title: currentName ? `Delete levels/${currentName}.json from disk` : "Nothing open is saved",
      disabled: !currentName,
      danger: true,
      run: () => void deleteFile(),
    },
  ]);
  fileMenu.title = "New, open, save and delete levels; the game's sounds";
  fileRow.append(fileMenu);

  // THE LEVEL'S OWN SETTINGS, beside the files: what is behind everything and
  // the 3D camera's lens. Level-wide and few, so here rather than in a panel;
  // the level's light is its Sun and Environment nodes, its fog its fog
  // regions. Built here, before anything can rebuild the inspector, which
  // refreshes them (`refreshLevelSettings`).
  const levelSettings = el("div", "ed-level-settings");
  levelSettings.setAttribute("role", "group");
  levelSettings.setAttribute("aria-label", "Level settings");
  const bgInput = colorInput(model.background ?? DEFAULT_ENVIRONMENT.backgroundColor, beginAction, (hex) => {
    model.background = hex;
    markDirty();
  });
  bgInput.el.title = "Background: what is behind everything - the horizon and the letterbox bars. A fog region with no colour of its own takes it.";
  bgInput.el.setAttribute("aria-label", "Background colour");
  const bgLabel = labelWrap("Background", bgInput.el);
  // A number in the top bar: blank is the default (`onEmpty`), and a focused
  // field is left alone by a refresh, as the inspector's are.
  const levelNums: { input: HTMLInputElement; get: () => number | null }[] = [];
  const levelNum = (
    label: string,
    title: string,
    step: number,
    placeholder: string,
    get: () => number | null,
    set: (v: number) => void,
    onEmpty: () => void,
  ): HTMLElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-num";
    input.step = String(step);
    input.placeholder = placeholder;
    input.title = title;
    input.setAttribute("aria-label", label);
    input.addEventListener("focus", () => beginAction());
    input.addEventListener("keydown", (e) => e.stopPropagation());
    input.addEventListener("input", () => {
      if (input.value.trim() === "") onEmpty();
      else {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        set(v);
      }
      markDirty();
    });
    levelNums.push({ input, get });
    const wrap = labelWrap(label, input);
    wrap.title = title;
    return wrap;
  };
  const lensCam = (): LevelCameraData => (model.camera ??= {});
  const dropLens = (key: keyof LevelCameraData): void => {
    if (!model.camera) return;
    delete model.camera[key];
    if (Object.keys(model.camera).length === 0) model.camera = undefined;
  };
  const lensField = levelNum(
    "Lens mm",
    "The 3D camera's 35 mm-equivalent focal length. Longer flattens the scene toward orthographic, shorter deepens it; the gameplay plane stays framed the same because the camera dollies to keep it so. Blank is the default.",
    5,
    focalLengthFromFov(FOV_Y_DEG).toFixed(1),
    () => model.camera?.focalLength ?? null,
    // Below a millimetre the field of view runs out past 170 degrees and the
    // frame stops being a picture of anything.
    (v) => (lensCam().focalLength = Math.max(1, v)),
    () => dropLens("focalLength"),
  );
  const camZField = levelNum(
    "Cam z",
    "How far the 3D camera stands along z from where the zoom puts it, positive toward you. The plane at this depth is framed exactly like the 2D view; at anything but 0 the gameplay plane is drawn smaller (positive) or larger (negative) than the overlay's outlines, handles and reticle.",
    10,
    "0",
    () => (model.camera?.zOffset === undefined ? null : model.camera.zOffset * M2PX),
    (v) => (lensCam().zOffset = v * PX),
    () => dropLens("zOffset"),
  );
  levelSettings.append(bgLabel, lensField, camZField);
  fileRow.append(levelSettings);
  function refreshLevelSettings(): void {
    if (!bgInput.editing) bgInput.value = model.background ?? DEFAULT_ENVIRONMENT.backgroundColor;
    for (const f of levelNums) if (document.activeElement !== f.input) f.input.value = fmtOrBlank(f.get());
  }

  // THE RIGHT DOCK: the scene tree of what is open (or the prefab library),
  // full height and as wide as the author drags it. What is selected in it is
  // edited in the inspector, the window floating to its left.
  const rightDock = el("aside", "ed-right-dock");
  rightDock.setAttribute("aria-label", "Scene");
  const dockResize = el("div", "ed-dock-resize");
  dockResize.setAttribute("role", "separator");
  dockResize.setAttribute("aria-orientation", "vertical");
  dockResize.setAttribute("aria-label", "Resize the scene tree");
  dockResize.title = "Drag to resize; double-click for the default width";
  const dockTabs = el("div", "ed-dock-tabs");
  dockTabs.setAttribute("role", "tablist");
  dockTabs.append(workspaceBtns.level, workspaceBtns.prefabs);
  const prefabBanner = el("div", "ed-prefab-banner");
  const prefabBannerName = el("span", "ed-prefab-banner-name");
  const prefabBack = button("Back to the level", () => void closePrefab());
  prefabBack.title = "Save the prefab and go back to the level, every instance of it showing the edit";
  prefabBanner.append(prefabBannerName, prefabBack);
  prefabBanner.hidden = true;
  const scenePane = el("div", "ed-dock-pane ed-scene-pane");
  const prefabPane = el("div", "ed-dock-pane ed-prefab-pane");
  prefabPane.hidden = true;
  rightDock.append(dockResize, dockTabs, prefabBanner, scenePane, prefabPane);
  root.appendChild(rightDock);
  // The width, in CSS pixels: never so narrow a name cannot be read, never
  // more than half the window.
  const DOCK_DEFAULT_WIDTH = 300;
  const clampDock = (px: number): number => Math.round(Math.min(Math.max(200, px), Math.max(200, window.innerWidth * 0.5)));
  const setDockWidth = (px: number): void => root.style.setProperty("--dock-width", `${clampDock(px)}px`);
  setDockWidth(readDockWidth() ?? DOCK_DEFAULT_WIDTH);
  dockResize.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dockResize.setPointerCapture(e.pointerId);
    dockResize.classList.add("active");
    const move = (m: PointerEvent): void => setDockWidth(window.innerWidth - m.clientX);
    const up = (u: PointerEvent): void => {
      dockResize.releasePointerCapture(u.pointerId);
      dockResize.classList.remove("active");
      dockResize.removeEventListener("pointermove", move);
      dockResize.removeEventListener("pointerup", up);
      writeDockWidth(rightDock.getBoundingClientRect().width);
    };
    dockResize.addEventListener("pointermove", move);
    dockResize.addEventListener("pointerup", up);
  });
  dockResize.addEventListener("dblclick", () => {
    setDockWidth(DOCK_DEFAULT_WIDTH);
    writeDockWidth(DOCK_DEFAULT_WIDTH);
  });
  // A window made narrower keeps the dock inside its half of it.
  window.addEventListener("resize", () => setDockWidth(rightDock.getBoundingClientRect().width));

  // THE VIEWPORT'S OWN CONTROLS, over its top edge: the overlays, the way back
  // to the plane, the game's camera, and the preview settings. How the level is
  // SEEN here, not what it is - so neither the workspace's dock nor a panel.
  const viewBar = el("div", "ed-viewbar");
  viewBar.setAttribute("aria-label", "View");
  root.appendChild(viewBar);
  // ...and down its right edge, beside the dock: the view cube and the lens,
  // then the inspector, the selection's window, under them.
  const floatCol = el("div", "ed-float");
  root.appendChild(floatCol);
  // The status line along the viewport's foot: what is open, whether it is
  // saved, what is in it, and the draft or notice of the moment.
  const statusLine = el("div", "ed-status");
  statusLine.setAttribute("role", "status");
  root.appendChild(statusLine);
  // Where the top bars end, for everything placed under them (`--chrome-top`):
  // the command bar wraps on a narrow window, and a fixed number would put
  // the docks over its second row.
  const chromeTop = (): void => root.style.setProperty("--chrome-top", `${Math.round(fileRow.getBoundingClientRect().bottom)}px`);
  new ResizeObserver(chromeTop).observe(fileRow);
  chromeTop();

  // The workspace tabs (1, 2, 3), as Blender's are along its top bar.
  const workspaceTabs = el("div", "ed-ws-tabs");
  workspaceTabs.setAttribute("role", "tablist");
  workspaceTabs.setAttribute("aria-label", "Workspace");
  const workspaceTabBtns = new Map<Workspace, HTMLButtonElement>();
  for (const ws of WORKSPACES) {
    const b = button(WORKSPACE_LABELS[ws], () => setWorkspace(ws));
    b.setAttribute("role", "tab");
    // What the workspace is, then how to work in it: the help the inspector
    // used to show with nothing selected.
    b.title = ws === "2d" ? WORKSPACE_TITLES[ws] : `${WORKSPACE_TITLES[ws]}\n\n${WORKSPACE_EMPTY_HINTS[ws]}`;
    workspaceTabBtns.set(ws, b);
    workspaceTabs.appendChild(b);
  }
  fileRow.append(workspaceTabs);

  const toolBtns: Record<Tool, HTMLButtonElement> = {
    select: button("Select", () => setTool("select")),
    rect: button("Rect", () => setTool("rect")),
    circle: button("Circle", () => setTool("circle")),
    belt: button("Belt", () => setTool("belt")),
    poly: button("Poly", () => setTool("poly")),
    path: button("Path", () => setTool("path")),
    cut: button("Cut", () => setTool("cut")),
    text: button("Text", () => setTool("text")),
    arrow: button("Arrow", () => setTool("arrow")),
    checkpoint: button("Checkpoint", () => setTool("checkpoint")),
    chain: button("Chain", () => setTool("chain")),
    vine: button("Vine", () => setTool("vine")),
    root: button("Root", () => setTool("root")),
    light: button("Light", () => setTool("light")),
    model: button("Model", () => setTool("model")),
    glow: button("Glow", () => { placingMushroom = false; setTool("glow"); }),
    fog: button("Fog", () => setTool("fog")),
    shelter: button("Shelter", () => setTool("shelter")),
    track: button("Track", () => setTool("track")),
  };
  const mushroomButton = toolize(button("", () => { placingMushroom = true; setTool("glow"); }), "Bouncy mushroom", "mushroom");
  mushroomButton.title = "Click to plant a glowing, bouncy mushroom. Its cap expands on impact. Adjust Bounce and Launch on its body.";
  for (const [key, shortcut] of Object.entries({ select: "V", rect: "R", circle: "C", poly: "P", text: "T", arrow: "A", chain: "K", checkpoint: "S" })) {
    toolBtns[key as Tool].dataset["shortcut"] = shortcut;
    toolBtns[key as Tool].setAttribute("aria-keyshortcuts", shortcut);
  }
  // Each tool's face and name on the toolbar.
  const TOOL_FACES: Record<Tool, [string, ToolIconName]> = {
    select: ["Select", "select"],
    rect: ["Rectangle", "rect"],
    circle: ["Circle", "circle"],
    belt: ["Belt", "belt"],
    poly: ["Polygon", "poly"],
    path: ["Curve", "curve"],
    cut: ["Cut", "cut"],
    text: ["Text", "text"],
    arrow: ["Arrow", "arrow"],
    checkpoint: ["Checkpoint", "checkpoint"],
    chain: ["Chain", "chain"],
    vine: ["Vine", "vine"],
    root: ["Root", "root"],
    light: ["Light", "light"],
    model: ["Model", "model"],
    glow: ["Glowing mushroom", "glow"],
    fog: ["Fog region", "fog"],
    shelter: ["Shelter", "shelter"],
    track: ["Minecart track", "track"],
  };
  for (const [t, [name, icon]] of Object.entries(TOOL_FACES)) toolize(toolBtns[t as Tool], name, icon);
  toolBtns.select.title = "Click to select, drag anywhere to rubber-band; move what is selected with the gizmo, G or the arrows";
  // The path tool's tooltip is the active layer's (see `refreshToolButtons`):
  // the one gesture draws three different things.
  const PATH_TOOL_TITLE: Record<EdLayer, string> = {
    scene:
      "Click out a curve: a bar stroked to its width, which a rail's cuff slides along. Enter or double-click finishes it, Esc drops it.",
    camera:
      "Click out a camera path: the route the camera rides, in the direction it is drawn. Enter or double-click finishes it, Esc drops it. The camera targets a point `lookahead` further along than the player, and lets go if they stray more than `range` from it.",
    notes: "",
  };
  toolBtns.path.title = PATH_TOOL_TITLE[activeLayer];
  toolBtns.fog.title =
    "Drag out a fog region: the air inside it thickens with distance from the camera by its own amount and colour, fading in from its edge over its falloff. Outside every region the view is clear, and overlapping regions do not add. A rect or a circle (its panel switches).";
  toolBtns.track.title =
    "Click out a minecart track along the rails, in the direction the carts travel (Enter or double-click finishes it, Esc drops it). A minecart is placed on its start as the cart every cart is built from; move it to set how high the carts ride. Carts are sent from the first node and turn out of the play plane at the last.";
  toolBtns.shelter.title =
    "Click out a shelter - the front wall of an enclosed cave, concave corners and all (Enter or click the first vertex to close, Esc to cancel). It is never drawn: it casts the sun's shadow alone, so the cave's rock faces and its inside go out of the sun while its air stays. The dotted outline is where the shadow lands on the play plane.";
  toolBtns.chain.title =
    "Drag from one body to another to string a chain between them. Shift-release on a body ties the chain there and keeps going (a rope bridge: post, each slat's two ends, ..., post); a plain click on a body ends it, Esc drops it";
  toolBtns.belt.title =
    "Press where the first wheel goes and drag to the second to lay a conveyor belt; a click drops one 1.5 m long. Click a run's midpoint to add a wheel, Alt+click a wheel's square to remove it. The band wraps the outside of every wheel and its surface runs round the loop at the panel's speed (positive = clockwise on screen), carrying whatever rests on it. It builds only on a static body that does not move.";
  toolBtns.model.title =
    "Click to place a 3D model of the library (assets-src/models/<model>.blend, `just model <model>`). With a body selected it goes INTO that body and is carried by it - a lantern on a chained body, a crate - otherwise it is a body of its own. Pick which model in its panel; the last one picked is placed next.";
  toolBtns.vine.title =
    "Press on a body and drag DOWN to hang a vine from it. Shift-drag its end handle onto another body to span between the two. The player passes through a vine and the hook grabs it anywhere along its length.";
  toolBtns.root.title =
    "Draw a root: click out its curve from base to tip - press and drag to pull out a node's Bézier handles - and Enter or a double-click grows it. Start a stroke ON a root to grow a branch out of it, at any depth. Roots are hook-only and static; tick pivot on the body to make one spring about its base.";
  toolBtns.light.title = "Click to drop a light; drag to set how far it reaches";
  toolBtns.glow.title =
    "Click to drop a glowing mushroom: one static body holding a collision box and a WAKING light that stays dark until the ball comes within its wake (the dashed ring) and fades out after it leaves. Give the body a model (or a formation) for its look; what glows in it follows the light. The 3D preview shows it awake.";
  toolBtns.checkpoint.title =
    "Click to drop a named spawn. Playing with ?checkpoint=NAME starts there instead of at the level's spawn - and stays there over a reset - so an area can be playtested without swinging out to it first. Selecting one and pressing ▶ Test starts the test there.";
  // `+ Root`'s own options, while it is armed: the width a root STARTS at
  // (its base) and the width it tapers to, in px like every length in the
  // panels. They are the widths a new root is drawn at, remembered by
  // this browser (`readRootWidths`); while a root or branch is being drawn they
  // show - and set - that one's, so a branch, which starts from its parent's
  // girth, can be made thicker or thinner before it is grown. Every grown root
  // keeps its own two in its panel (`start width` / `tip width`).
  const storedRootWidths = readRootWidths();
  let rootStartWidth = storedRootWidths.start ?? ROOT_TRUNK_WIDTH;
  let rootTipWidth = storedRootWidths.tip ?? ROOT_TIP_WIDTH;
  const rootWidthInput = (title: string, min: number, apply: (metres: number) => void): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-num";
    input.step = "1";
    input.min = String(min);
    input.title = title;
    input.addEventListener("input", () => {
      const px = Number(input.value);
      if (!Number.isFinite(px) || px < min) return;
      apply(px * PX);
    });
    return input;
  };
  const rootStartInput = rootWidthInput(
    "How wide the root starts, at its base (px). Set while drawing, it is the width of the root or branch being drawn; otherwise the width new roots start at.",
    1,
    (w) => {
      if (rootDraft) rootDraft.width = w;
      if (!rootDraft || !rootDraft.from) {
        rootStartWidth = w;
        writeRootWidths({ start: rootStartWidth, tip: rootTipWidth });
      }
    },
  );
  const rootTipInput = rootWidthInput(
    "How wide the root ends, at its tip (px). Set while drawing, it is the tip of the root or branch being drawn; otherwise the tip new roots end at.",
    0.5,
    (w) => {
      if (rootDraft) rootDraft.tip = w;
      if (!rootDraft || !rootDraft.from) {
        rootTipWidth = w;
        writeRootWidths({ start: rootStartWidth, tip: rootTipWidth });
      }
    },
  );
  // 2D has no tool-settings strip (the class of a drawn shape's body is asked
  // as it is drawn, `offerParentPick`), so Root's two fields stand in a card
  // of their own at the foot of the view, there only while Root is armed.
  const rootOptions = el("div", "ed-tool-options");
  rootOptions.setAttribute("role", "group");
  rootOptions.setAttribute("aria-label", "Root tool settings");
  rootOptions.append(labelWrap("start width", rootStartInput), labelWrap("tip", rootTipInput));
  root.appendChild(rootOptions);
  // The fields say what the next press will draw: the draft's widths while
  // there is one, the remembered ones otherwise. Called when a draft starts or
  // ends and when the tool changes - never from the fields' own input, so it
  // cannot fight the caret.
  function refreshRootWidthFields(): void {
    const round = (m: number): string => String(Math.round(m * M2PX * 10) / 10);
    rootStartInput.value = round(rootDraft ? rootDraft.width : rootStartWidth);
    rootTipInput.value = round(rootDraft ? rootDraft.tip : rootTipWidth);
  }
  // The armed tool's options: Root's widths, in 2D.
  function refreshToolOptions(): void {
    rootOptions.style.display = tool === "root" && workspace === "2d" ? "" : "none";
    refreshRootWidthFields();
  }
  toolBtns.poly.title =
    "Click out an outline, concave corners included; Enter or the first vertex closes it, Esc cancels";
  toolBtns.cut.title =
    "Click where a cut starts and where it ends: every polygon or box it crosses edge to edge is cut, and what no longer touches becomes a body of its own, a copy of the body it came from, taking the anchors (and the chains and vines on them) on its side. With bodies selected, only they are cut. Hold Alt on the second click to keep the pieces in one body. Snaps to corners. Esc cancels.";
  // A heading in the tool settings: a muted word before the controls it names.
  const toolGroup = (text: string): HTMLElement => {
    const h = el("span", "ed-toolhead-label");
    h.textContent = text;
    return h;
  };
  // ...a rule between two runs of them, and the gap that pushes what follows
  // (the workspace's Generate, Grow or Bake) to the strip's far end.
  const toolheadDivider = (): HTMLElement => el("span", "ed-toolhead-divider");
  const toolheadSpacer = (): HTMLElement => el("span", "ed-toolhead-spacer");
  // 2D's toolbar, in blocks by what they make: select and the knife, which
  // make nothing but work on what is there; the outlines the ball collides
  // with; the things it plays with; what lights and dresses the plane; the
  // plane's volumes; and the notes layer's. A layer shows only its own
  // (`refreshToolButtons`), and a block with none of them shown goes.
  const toolbar2d = toolSet(
    "2D tools",
    toolBlock(toolBtns.select, toolBtns.cut),
    toolBlock(toolBtns.rect, toolBtns.circle, toolBtns.poly, toolBtns.path, toolBtns.belt),
    toolBlock(toolBtns.chain, toolBtns.vine, toolBtns.root, mushroomButton, toolBtns.glow),
    toolBlock(toolBtns.light, toolBtns.model),
    toolBlock(toolBtns.fog, toolBtns.shelter),
    toolBlock(toolBtns.track),
    toolBlock(toolBtns.text, toolBtns.arrow, toolBtns.checkpoint),
  );
  toolbar.appendChild(toolbar2d);

  // THE FORMATIONS WORKSPACE'S DOCK: Primitives - each a new guide where the
  // view is looking, Blender's Add menu - then, with a solid guide selected,
  // shapes added to its stack (Shift+A in the view), and generating every
  // rock whose recipe or guide has changed in one go.
  const formationsDock = el("div", "ed-toolhead-set ed-ws-dock");
  formationsDock.setAttribute("role", "group");
  formationsDock.setAttribute("aria-label", "Formation tool settings");
  bar.appendChild(formationsDock);
  const primitiveButtons = SHAPE_KINDS.map(({ label, kind }) => {
    const b = toolize(button("", () => addPrimitive(kind)), `Add ${label.toLowerCase()}`, kind === "box" ? "addBox" : "addCylinder");
    b.title = `Add a new guide, a ${label.toLowerCase()}, where the view is looking: a background rock of its own, behind nothing, colliding with nothing, generated in its Formation panel (Shift+A in the view with nothing selected)`;
    return b;
  });
  const stackGroup = toolGroup("Add to guide");
  const shapeButtons = SHAPE_KINDS.map(({ label, kind }) => {
    const b = button(`+ ${label}`, () => {
      const f = activeSolidFormation();
      if (f) addShapeShown(f, kind);
    });
    b.title = `Add a ${label.toLowerCase()} to the selected guide's stack, in its middle, to add to, cut or intersect it (Shift+A in the view)`;
    return b;
  });
  const generateStaleBtn = button("Generate", () => generateStale());
  generateStaleBtn.title =
    "Generate every rock in the level that is not generated yet or whose guide or recipe has changed since (the iteration look; Bake stays per rock)";
  // COMBINING GUIDES (Blender's boolean, applied): with a solid guide
  // selected, Union, Subtract or Intersect, then a click on each other guide
  // to fold in (again to leave it out), Enter to apply, Esc to drop it. Each
  // picked guide becomes an entry of the selected guide's stack in that mode,
  // carried into its frame, and leaves the level, with the decorations tied
  // to it; one undo step.
  const combineBtns = new Map<StackMode, HTMLButtonElement>();
  for (const [op, label, icon, tip] of [
    ["add", "Union", "union", "Pick other guides to merge into this one"],
    ["subtract", "Subtract", "subtract", "Pick other guides to cut out of this one"],
    ["intersect", "Intersect", "intersect", "Pick other guides to keep only what this one shares with them"],
  ] as const) {
    const b = toolize(button("", () => startCombine(op)), label, icon);
    b.title = `${tip}: click them in the view or the list, then Enter (Esc cancels). The picked guides leave the level.`;
    combineBtns.set(op, b);
  }
  const combineHint = el("span", "ed-hint ed-toolhead-hint");
  const combineApply = button("Apply", () => applyCombine());
  const combineCancel = button("Cancel", () => cancelCombine());
  // Formations' toolbar: Select (which also ends combining), the new guides,
  // and - with a solid guide selected - the three ways of combining others
  // into it. While sculpting, the sculpt's own tools instead (`ed-sculpting`).
  const formSelectBtn = toolize(button("", () => cancelCombine()), "Select", "select");
  formSelectBtn.dataset["shortcut"] = "Esc";
  formSelectBtn.title = "Click a guide or a rock to select it; Tab swaps the selection's guide and rock";
  const combineBlock = toolBlock(...combineBtns.values());
  const toolbarFormations = toolSet("Formation tools", toolBlock(formSelectBtn), toolBlock(...primitiveButtons), combineBlock);
  toolbar.appendChild(toolbarFormations);

  let combine: { op: StackMode; target: number; picks: number[] } | null = null;
  let combineRev = 0;
  const isSolidGuide = (i: EdItem | null | undefined): i is EdItem => i?.object === "formation" && i.formation?.guide.kind === "solid";
  function startCombine(op: StackMode): void {
    const target = activeSolidFormation();
    if (!target) return;
    combine = { op, target: target.id, picks: combine?.target === target.id ? combine.picks : [] };
    combineRev++;
    // Enter is the mode's: a button left focused would take it as a press.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    refreshWorkspaceDock();
  }
  function cancelCombine(): void {
    if (!combine) return;
    combine = null;
    combineRev++;
    refreshWorkspaceDock();
  }
  // A guide picked or let go again.
  function toggleCombinePick(id: number): void {
    if (!combine || id === combine.target || !isSolidGuide(itemOf(id))) return;
    const k = combine.picks.indexOf(id);
    if (k >= 0) combine.picks.splice(k, 1);
    else combine.picks.push(id);
    combineRev++;
    refreshWorkspaceDock();
  }
  function applyCombine(): void {
    const c = combine;
    if (!c) return;
    const target = itemOf(c.target);
    const picks = c.picks.map((id) => itemOf(id)).filter(isSolidGuide);
    combine = null;
    combineRev++;
    if (!isSolidGuide(target) || target.formation!.guide.kind !== "solid" || !picks.length) {
      refreshWorkspaceDock();
      return;
    }
    beginAction();
    let tree = target.formation!.guide.tree;
    for (const p of picks) {
      if (p.formation!.guide.kind !== "solid") continue;
      const carried = carryTree(p.formation!.guide.tree, frameBetween(p, target));
      // A guide that is one shape is that shape, not a group of one.
      const node = "op" in carried && carried.op === "union" && carried.of.length === 1 ? carried.of[0]! : carried;
      tree = appendEntry(tree, node, c.op).tree;
    }
    target.formation = { ...target.formation!, guide: { kind: "solid", tree } };
    // The picked guides go, and what grows on them: their anchors are on
    // guides that are no longer there.
    const ids = new Set(picks.map((p) => p.formation!.id));
    const gone = new Set(picks.map((p) => p.id));
    let decorationsGone = 0;
    for (const i of model.items) {
      if (i.object === "decoration" && i.decoration && ids.has(i.decoration.formation)) {
        gone.add(i.id);
        decorationsGone++;
      }
    }
    model.items = model.items.filter((i) => !gone.has(i.id));
    for (const id of gone) selectedIds.delete(id);
    solidSel = null;
    markDirty();
    rebuildInspector();
    syncGizmo();
    const verb = { add: "Merged", subtract: "Cut", intersect: "Intersected" }[c.op];
    flashNotice(`${verb} ${picks.length} guide${picks.length === 1 ? "" : "s"} into this one${decorationsGone ? `; ${decorationsGone} decoration${decorationsGone === 1 ? "" : "s"} on ${picks.length === 1 ? "it" : "them"} removed` : ""} (Ctrl+Z undoes)`);
  }

  // A primitive as a new guide of its own (a 3D body holding one formation),
  // standing where the view is looking - at the view's target, depth and all -
  // and selected, as Blender adds at the 3D cursor.
  function addPrimitive(kind: PrimitiveKind): void {
    const t = visuals?.view?.target;
    const at = t ? { x: t.x, y: threeY(t.y), z: t.z } : { x: camera.position.x, y: camera.position.y, z: 0 };
    const made = createBackdrop(formationHost, at, newPrimitive(kind, [0, 0, 0]));
    if (!made) return;
    revealGuide(made);
    setBodySelection(made.unit);
  }
  // A guide just made, or just added a shape to, is drawn whatever Show ->
  // Guides says: it was made to be worked on, and with it hidden the add
  // would look like nothing happened. Its own override (`formationView`), so
  // the next Show setting takes it back with the rest; its rock keeps
  // whatever it showed.
  function revealGuide(f: EdItem): void {
    if (guideShown(f)) return;
    formationView.set(f.id, rockShown(f) ? "both" : "guide");
    formationViewRev++;
    refreshWorkspaceDock();
  }
  // A shape added to a guide's stack, the guide shown.
  function addShapeShown(f: EdItem, kind: PrimitiveKind): void {
    const guide = f.formation?.guide;
    if (guide?.kind !== "solid") return;
    addShapeToGuide(formationHost, f, newPrimitive(kind, guideCentre(guide.tree)));
    revealGuide(f);
  }

  // What is drawn: every guide and every rock in the level (each setting
  // clears the per-formation choices, so it applies to all), and the
  // selected formations' own Guide / Rock / Both (Tab swaps guide and rock).
  const guidesChk = checkbox("Guides", showGuides, (v) => setGlobalFormationView("guides", v));
  guidesChk.title = "Draw every formation's guide, each in its own colour (clears the per-formation choices)";
  const rocksChk = checkbox("Rocks", showRocks, (v) => setGlobalFormationView("rocks", v));
  rocksChk.title = "Draw every generated rock (clears the per-formation choices)";
  const formationViewBtns = new Map<FormationView, HTMLButtonElement>();
  const viewSeg = el("div", "ed-seg");
  for (const [v, label, tip] of [
    ["guide", "Guide", "Show the selected formation's guide and hide its rock (Tab swaps)"],
    ["rock", "Rock", "Show the selected formation's generated rock and hide its guide (Tab swaps)"],
    ["both", "Both", "Show the selected formation's guide over its rock"],
  ] as const) {
    const b = button(label, () => setFormationView(v));
    b.title = tip;
    formationViewBtns.set(v, b);
    viewSeg.appendChild(b);
  }
  const viewHint = el("span", "ed-hint ed-toolhead-hint");
  viewHint.textContent = "no formation";
  // SCULPT (plans/sculpt-guides.md): the selected solid guide shaped with
  // Draw, Grab and Cut; Ctrl+Tab enters and leaves. While it is on, the dock
  // is the mode's alone (`ed-sculpting` in studio.css).
  const sculptBtn = button("Sculpt", () => {
    const f = activeSolidFormation();
    if (f) enterSculpt(f);
  });
  sculptBtn.title = "Sculpt the selected guide (Ctrl+Tab): Draw (D), Grab (G), Cut (C). Applies its stack into one mesh first.";
  // Formations' tool settings: the selection's guide or rock and its Sculpt,
  // shapes added to the selected guide and a combine under way; at the far
  // end what is drawn, then Generate.
  formationsDock.append(
    toolGroup("Selected"),
    viewSeg,
    viewHint,
    sculptBtn,
    stackGroup,
    ...shapeButtons,
    combineHint,
    combineApply,
    combineCancel,
    toolheadSpacer(),
    toolGroup("Show"),
    guidesChk,
    rocksChk,
    toolheadDivider(),
    generateStaleBtn,
  );
  if (scene3d && visuals) {
    const vis = visuals;
    sculptCtl = new SculptController({
      layer: scene3d.editorLayer,
      camera: () => scene3d.camera,
      overlayParent: root,
      canvas,
      ndc: (scr) => vis.ndc(scr),
      item: (id) => itemOf(id) ?? undefined,
      stillSelected: (item) => selectedIds.has(item.id) || selectedBodyIds.has(item.unit),
      frame: (item) => itemMatrix(item),
      color: guideHex,
      formation: formationHost,
      notice: (text) => flashNotice(text),
      changed: () => {
        formationViewRev++;
        refreshWorkspaceDock();
        syncGizmo();
        rebuildInspector();
      },
      ui: { el, button, checkbox, toolGroup },
    });
    formationsDock.appendChild(sculptCtl.dock);
    sculptCtl.toolBlock.classList.add("ed-sculpt-tools");
    toolbarFormations.appendChild(sculptCtl.toolBlock);
  }
  // Sculpt mode on a formation's guide, from the dock, the panel or Ctrl+Tab.
  function enterSculpt(item: EdItem): void {
    if (!sculptCtl || workspace !== "formations") return;
    if (grab) endTransform(true);
    cancelCombine();
    sculptCtl.enter(item);
  }

  // The formations selected, or in a selected body.
  function selectedFormations(): EdItem[] {
    return model.items.filter((i) => i.object === "formation" && (selectedIds.has(i.id) || selectedBodyIds.has(i.unit)));
  }
  // What a formation shows now, as the dock's buttons say it (null: nothing).
  function viewOf(f: EdItem): FormationView | null {
    const g = guideShown(f);
    const r = rockShown(f);
    return g && r ? "both" : g ? "guide" : r ? "rock" : null;
  }
  function setFormationView(v: FormationView): void {
    const sel = selectedFormations();
    if (!sel.length) return;
    for (const f of sel) formationView.set(f.id, v);
    formationViewRev++;
    refreshWorkspaceDock();
  }
  function setGlobalFormationView(which: "guides" | "rocks", on: boolean): void {
    if (which === "guides") showGuides = on;
    else showRocks = on;
    writeViewSetting(which, on);
    formationView.clear();
    formationViewRev++;
    refreshWorkspaceDock();
  }
  // Tab in Formations, as Blender's Tab enters and leaves the mesh's edit
  // mode: the selection between its guide and its rock.
  function toggleFormationView(): void {
    const first = selectedFormations()[0];
    if (!first) return;
    setFormationView(viewOf(first) === "guide" && first.formation?.built ? "rock" : "guide");
  }
  // The items whose guides the solid guide view draws.
  let guideItemsCache: { rev: number; view: number; shown: EdModel; items: readonly EdItem[] } | null = null;
  function shownGuideItems(): readonly EdItem[] {
    const shown = shownModel();
    if (guideItemsCache && guideItemsCache.rev === modelRev && guideItemsCache.view === formationViewRev && guideItemsCache.shown === shown) return guideItemsCache.items;
    const items = shown.items.filter((i) => i.object === "formation" && guideShown(i));
    guideItemsCache = { rev: modelRev, view: formationViewRev, shown, items };
    return items;
  }

  // THE DECORATIONS WORKSPACE'S DOCK: the palette - pick a kind, click any
  // generated rock - and growing every decoration that is out of date.
  const decorationsDock = el("div", "ed-toolhead-set ed-ws-dock");
  decorationsDock.setAttribute("role", "group");
  decorationsDock.setAttribute("aria-label", "Decoration tool settings");
  bar.appendChild(decorationsDock);
  const DECORATION_ICONS: Record<Exclude<DecorationKind, "material">, ToolIconName> = {
    moss: "moss",
    ivy: "ivy",
    fern: "fern",
    vine: "hangingVine",
    mushroom: "mushrooms",
    orbs: "orbs",
    glow: "glowFlora",
  };
  const paletteButtons = new Map<DecorationKind, HTMLButtonElement>();
  for (const kind of Object.keys(DECORATION_LABELS) as DecorationKind[]) {
    // A material layer is the Texturing workspace's.
    if (kind === "material") continue;
    const b = toolize(
      button("", () => {
        decorations.arm(kind);
        refreshWorkspaceDock();
      }),
      DECORATION_LABELS[kind],
      DECORATION_ICONS[kind],
    );
    b.title = PAINTED_DECORATIONS.includes(kind)
      ? `Drag on a generated rock to paint ${DECORATION_LABELS[kind].toLowerCase()} onto it and right-drag to erase (the ring under the pointer is the brush); Enter grows it, Enter again stops, Esc throws away the strokes since the last Enter`
      : `Click a generated rock to place ${DECORATION_LABELS[kind].toLowerCase()}; stays armed for the next click (Enter, Esc or a right-click stops)`;
    paletteButtons.set(kind, b);
  }
  const growStaleBtn = button("Grow", () => growStale());
  growStaleBtn.title = "Grow every decoration that is not grown yet or whose settings, paint or rock have changed since";
  // Select: the workspace's own tool whenever no kind is armed - a click on
  // what grew (moss, ivy, a fern...) selects that decoration, not its rock's
  // body first. Picking it disarms the palette, as Esc does.
  const decoSelectBtn = toolize(
    button("", () => {
      decorations.end();
      refreshWorkspaceDock();
    }),
    "Select",
    "select",
  );
  decoSelectBtn.dataset["shortcut"] = "Esc";
  decoSelectBtn.title = "Click a decoration (moss, ivy, a fern...) to select it; a click on bare rock selects the rock";
  // The palette brush's own settings, shown while moss or ivy is armed: it
  // selects nothing, so they cannot live in a decoration's panel. Painting or
  // erasing is the button's (left / right), not a setting.
  const brushRadiusRow = el("label", "ed-inline ed-brush-radius");
  brushRadiusRow.title = "The brush's radius on the rock, metres";
  brushRadiusRow.appendChild(document.createTextNode("Radius m"));
  const brushRadiusInput = Object.assign(document.createElement("input"), { type: "number", className: "ed-num", step: "0.05", min: "0.02" });
  brushRadiusInput.addEventListener("input", () => decorations.setBrushRadius(Number(brushRadiusInput.value)));
  brushRadiusRow.appendChild(brushRadiusInput);
  const brushHint = el("span", "ed-hint ed-toolhead-hint");
  brushHint.textContent = "Drag to paint, right-drag to erase · Enter grows it · Esc drops the strokes since";
  const brushControls = [brushRadiusRow, brushHint];
  // Decorations' toolbar: Select, the two that are painted on, and the ones
  // placed with a click.
  const toolbarDecorations = toolSet(
    "Decoration tools",
    toolBlock(decoSelectBtn),
    toolBlock(...[...paletteButtons].filter(([k]) => PAINTED_DECORATIONS.includes(k)).map(([, b]) => b)),
    toolBlock(...[...paletteButtons].filter(([k]) => !PAINTED_DECORATIONS.includes(k)).map(([, b]) => b)),
  );
  toolbar.appendChild(toolbarDecorations);
  decorationsDock.append(...brushControls, toolheadSpacer());
  // The collision outlines over the rocks, for reference while dressing
  // them: drawn as 2D draws them, never picked (a click goes to the rock).
  const collisionChk = checkbox("Collision", showCollisionOutlines, (v) => {
    showCollisionOutlines = v;
    writeViewSetting("collision", v);
  });
  collisionChk.title = "Draw the collision outlines over the rocks, for reference (they are edited in 2D)";
  decorationsDock.append(toolGroup("Show"), collisionChk, toolheadDivider(), growStaleBtn);

  // THE TEXTURING WORKSPACE'S DOCK (docs/formations.md "Material layers"):
  // the material library - pick a material, drag on any generated rock - the
  // brush, and baking the patches that are out of date for the game. The
  // palette is the library's files (`assets-src/materials`), read again while
  // the workspace is open (`MaterialMasks.watchLibrary`).
  const texturingDock = el("div", "ed-toolhead-set ed-ws-dock");
  texturingDock.setAttribute("role", "group");
  texturingDock.setAttribute("aria-label", "Texturing tool settings");
  bar.appendChild(texturingDock);
  const texSelectBtn = toolize(
    button("", () => {
      decorations.end();
      refreshWorkspaceDock();
    }),
    "Select",
    "select",
  );
  texSelectBtn.dataset["shortcut"] = "Esc";
  texSelectBtn.title = "Click a painted patch to select it; a click on bare rock selects the rock";
  // PAINT, Blender's texture-paint brush: the material it lays is the tool's
  // setting (the header's Material), not a tool of its own, since the library
  // is whatever files `assets-src/materials` holds.
  const texPaintBtn = toolize(button("", () => armMaterial(materialSel.value)), "Paint", "paint");
  texPaintBtn.title =
    "Drag on a generated rock to paint the Material onto it and right-drag to erase; Enter bakes it for the game, Enter again stops, Esc throws away the strokes since the last Enter";
  const toolbarTexturing = toolSet("Texturing tools", toolBlock(texSelectBtn), toolBlock(texPaintBtn));
  toolbar.appendChild(toolbarTexturing);
  const materialSel = document.createElement("select");
  materialSel.className = "ed-select";
  materialSel.title = "The material Paint lays: a Blender file in assets-src/materials, its Surface a Principled BSDF. Picking one picks up Paint.";
  materialSel.addEventListener("change", () => armMaterial(materialSel.value));
  const materialWrap = labelWrap("Material", materialSel);
  function armMaterial(name: string): void {
    if (!name) return;
    decorations.arm("material", name);
    refreshWorkspaceDock();
  }
  const noMaterials = el("span", "ed-hint ed-toolhead-hint");
  noMaterials.textContent = "No materials yet: add a Blender file to assets-src/materials";
  function rebuildMaterialPalette(): void {
    const was = materialSel.value;
    materialSel.replaceChildren();
    for (const name of materialMasks.materials) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = materialLabel(name);
      materialSel.appendChild(o);
    }
    if (materialMasks.materials.includes(was)) materialSel.value = was;
    const any = materialMasks.materials.length > 0;
    materialWrap.style.display = any ? "" : "none";
    noMaterials.style.display = any ? "none" : "";
    texPaintBtn.disabled = !any;
    refreshWorkspaceDock();
  }
  const texRadiusRow = el("label", "ed-inline ed-brush-radius");
  texRadiusRow.title = "The brush's radius on the rock, metres";
  texRadiusRow.appendChild(document.createTextNode("Radius m"));
  const texRadiusInput = Object.assign(document.createElement("input"), { type: "number", className: "ed-num", step: "0.05", min: "0.02" });
  texRadiusInput.addEventListener("input", () => decorations.setBrushRadius(Number(texRadiusInput.value)));
  texRadiusRow.appendChild(texRadiusInput);
  const texHint = el("span", "ed-hint ed-toolhead-hint");
  texHint.textContent = "Drag to paint, right-drag to erase · Enter bakes it · Esc drops the strokes since";
  const texBrushControls = [texRadiusRow, texHint];
  const bakeStaleBtn = button("Bake", () => growStale(true));
  bakeStaleBtn.title = "Bake every painted material that is not baked yet, or whose paint, material or rock has changed since";
  const texCollisionChk = checkbox("Collision", showCollisionOutlines, (v) => {
    showCollisionOutlines = v;
    writeViewSetting("collision", v);
  });
  texCollisionChk.title = collisionChk.title;
  // Texturing's tool settings: Paint's material and brush; at the far end what
  // is drawn, then Bake.
  texturingDock.append(materialWrap, noMaterials, ...texBrushControls, toolheadSpacer(), toolGroup("Show"), texCollisionChk, toolheadDivider(), bakeStaleBtn);
  // Filled when the library is first read (after the editor is up).
  noMaterials.style.display = "none";
  materialWrap.style.display = "none";

  // What the two 3D docks offer right now: which shapes can be added, how
  // many rocks and decorations are out of date, which kind is armed. Called
  // whenever the inspector is rebuilt (every selection change and edit) and
  // when a job moves.
  function refreshWorkspaceDock(): void {
    const solid = activeSolidFormation();
    // The stack's own buttons only while there is a stack to add to.
    for (const b of [stackGroup, ...shapeButtons, combineBlock]) b.style.display = solid ? "" : "none";
    // Sculpt: offered with a solid guide selected; while on, the tool settings
    // and the toolbar are its.
    sculptBtn.style.display = solid && sculptCtl ? "" : "none";
    formationsDock.classList.toggle("ed-sculpting", !!sculptCtl?.active);
    toolbarFormations.classList.toggle("ed-sculpting", !!sculptCtl?.active);
    if (sculptCtl?.active) sculptCtl.refreshDock();
    // Combining belongs to the guide it was started on: selecting anything
    // else ends it.
    if (combine && solid?.id !== combine.target) {
      combine = null;
      combineRev++;
    }
    for (const [op, b] of combineBtns) {
      b.classList.toggle("active", combine?.op === op);
      b.setAttribute("aria-pressed", String(combine?.op === op));
    }
    formSelectBtn.classList.toggle("active", !combine);
    formSelectBtn.setAttribute("aria-pressed", String(!combine));
    const picked = combine?.picks.length ?? 0;
    combineHint.textContent = combine
      ? picked
        ? `${picked} guide${picked === 1 ? "" : "s"} picked. Enter applies, Esc cancels.`
        : "Click the guides to combine with this one (view or list), then Enter."
      : "";
    combineHint.style.display = combine ? "" : "none";
    combineApply.style.display = combine ? "" : "none";
    combineCancel.style.display = combine ? "" : "none";
    combineApply.disabled = !picked;
    const rocks = staleFormations().length;
    generateStaleBtn.textContent = rocks ? `Generate ${rocks} out of date` : "All rocks up to date";
    generateStaleBtn.disabled = !rocks;
    generateStaleBtn.classList.toggle("ed-attention", rocks > 0);
    const grown = staleDecorations(false).length;
    growStaleBtn.textContent = grown ? `Grow ${grown} out of date` : "All decorations grown";
    growStaleBtn.disabled = !grown;
    growStaleBtn.classList.toggle("ed-attention", grown > 0);
    const baked = staleDecorations(true).length;
    bakeStaleBtn.textContent = baked ? `Bake ${baked} out of date` : "All materials baked";
    bakeStaleBtn.disabled = !baked;
    bakeStaleBtn.classList.toggle("ed-attention", baked > 0);
    // The selection's guide / rock view.
    const formationSel = selectedFormations();
    const view = formationSel[0] ? viewOf(formationSel[0]) : null;
    for (const [v, b] of formationViewBtns) {
      b.classList.toggle("active", v === view);
      b.setAttribute("aria-pressed", String(v === view));
      // A rock not generated has nothing to show but its guide.
      b.disabled = !formationSel.length || (v !== "guide" && !formationSel.some((f) => f.formation?.built));
    }
    // With no formation selected there is nothing for Guide / Rock / Both to
    // act on, so the run says so rather than offering three dead buttons.
    viewSeg.style.display = formationSel.length ? "" : "none";
    viewHint.style.display = formationSel.length ? "none" : "";
    const armed = decorations.anyRock ? decorations.placing!.kind : null;
    for (const [kind, b] of paletteButtons) {
      b.classList.toggle("active", kind === armed);
      b.setAttribute("aria-pressed", String(kind === armed));
    }
    decoSelectBtn.classList.toggle("active", armed === null);
    decoSelectBtn.setAttribute("aria-pressed", String(armed === null));
    const brushOn = armed !== null && PAINTED_DECORATIONS.includes(armed);
    for (const c of brushControls) c.style.display = brushOn ? "" : "none";
    if (document.activeElement !== brushRadiusInput) brushRadiusInput.value = String(decorations.brushRadius);
    // The Texturing dock's: which material is armed, and its brush.
    const armedMaterial = armed === "material" ? (decorations.placing!.material ?? null) : null;
    texPaintBtn.classList.toggle("active", armedMaterial !== null);
    texPaintBtn.setAttribute("aria-pressed", String(armedMaterial !== null));
    if (armedMaterial !== null && materialSel.value !== armedMaterial) materialSel.value = armedMaterial;
    texSelectBtn.classList.toggle("active", armedMaterial === null);
    texSelectBtn.setAttribute("aria-pressed", String(armedMaterial === null));
    for (const c of texBrushControls) c.style.display = armedMaterial !== null ? "" : "none";
    if (document.activeElement !== texRadiusInput) texRadiusInput.value = String(decorations.brushRadius);
    // Arming, the brush and their ends all rebuild the inspector; a drag in
    // progress owns the cursor until it lets go.
    if (!drag) applyToolCursor();
    // Combining's block, or the sculpt's, came or went.
    fitToolbar();
  }
  // The formations in the level that are not generated, or are stale, and
  // have no build of their recipe on its way.
  function staleFormations(): EdItem[] {
    return model.items.filter((i) => {
      const f = i.object === "formation" ? i.formation : null;
      if (!f || (f.built && !isStale(f))) return false;
      const job = formationJobs.latest(formationHash(f));
      return !(job && (job.state === "queued" || job.state === "running"));
    });
  }
  function generateStale(): void {
    for (const item of staleFormations()) requestFormationBuild(formationHost, item, "geometry");
    refreshWorkspaceDock();
  }
  // The decorations that are not grown, or are stale, on a rock that is
  // generated, with no growth of theirs on its way.
  // `materials`: the material layers (the Texturing workspace's), or every
  // other decoration (the Decorations workspace's).
  function staleDecorations(materials: boolean): EdItem[] {
    return model.items.filter((i) => {
      if (i.object !== "decoration" || !i.decoration || i.decoration.lost || !decorations.stale(i)) return false;
      if ((i.decoration.kind === "material") !== materials) return false;
      // A painted one with no paint yet has nothing to grow.
      if (isPainted(i.decoration.kind) && !i.decoration.strokes?.length) return false;
      const r = decorations.request(i);
      if (!r) return false;
      const job = formationJobs.latest(decorationHash(r));
      return !(job && (job.state === "queued" || job.state === "running"));
    });
  }
  function growStale(materials = false): void {
    for (const d of staleDecorations(materials)) decorations.grow(d);
    refreshWorkspaceDock();
  }

  // Layer list: which layer is being edited (Tab cycles), plus a visibility
  // toggle each. Visibility is independent of active — a hidden active layer
  // would be an invisible edit target, so hiding one also moves the edit focus.
  // It stacks vertically, with the visibility boxes in a column down the left:
  // a layer stack is a fixed, ordered set you read down, not a row of toolbar
  // buttons, and one row per layer leaves room for a name of any length.
  // It stands in the right dock, over the data layers and the scene tree
  // (Tris, 2026-11-26): what is shown, locked and drawn onto is set where
  // the nodes are, not among the tools.
  const layerList = el("div", "ed-layers ed-type-layers");
  const layerHeading = el("div", "ed-layer-label");
  layerHeading.textContent = "Layers";
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
    b.title = `Edit the ${l} layer (Tab cycles).\n\n${EMPTY_HINTS[l]}`;
    layerBtns[l] = b;
    row.append(eye, lock, b);
    layerList.appendChild(row);
    setLayerVisible(l, true); // paints the icon and its tooltip
    setLayerLocked(l, false); // ditto
  }

  // DATA LAYERS (plans/node-tree.md "Editor"): the user's own, over the
  // scene tree in the right dock, since what they hold is its nodes (the type
  // layers are the 2D workspace's, in the left dock). Each has an eye and a
  // lock, and assigns or unassigns the selection; a node is in its ancestors'
  // layers too, so a layer holding a body holds everything in it. Made with
  // `+`, removed with `×` (which takes it off every node).
  const dataLayerList = el("div", "ed-layers ed-data-layers");
  function buildDataLayers(): void {
    dataLayerList.innerHTML = "";
    const head = el("div", "ed-layer-label");
    head.textContent = "Data layers";
    const add = button("+", () => {
      const input = document.createElement("input");
      input.className = "ed-out-rename";
      input.placeholder = "layer name";
      head.appendChild(input);
      input.focus();
      // Once: Enter (or Escape) takes the field away, and taking it away blurs
      // it, which would end the edit a second time on a field already gone.
      let finished = false;
      const done = (keep: boolean): void => {
        if (finished) return;
        finished = true;
        const name = input.value.trim();
        input.remove();
        if (!keep || !name || model.dataLayers.includes(name)) return;
        beginAction();
        model.dataLayers.push(name);
        markDirty();
        buildDataLayers();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      });
      input.addEventListener("blur", () => done(true));
    });
    add.title = "Make a data layer";
    head.appendChild(add);
    dataLayerList.appendChild(head);
    const selection = (): string[] => [...selectedNodeIds()];
    for (const name of model.dataLayers) {
      const row = el("div", "ed-layer-row");
      const eye = document.createElement("button");
      eye.className = "ed-eye";
      const shown = !hiddenUserLayers.has(name);
      eye.innerHTML = eyeIcon(shown);
      eye.classList.toggle("off", !shown);
      eye.title = `${shown ? "Hide" : "Show"} everything in ${name}`;
      eye.addEventListener("click", () => {
        if (!hiddenUserLayers.delete(name)) hiddenUserLayers.add(name);
        hiddenRev++;
        modelRev++;
        buildDataLayers();
      });
      const lock = document.createElement("button");
      lock.className = "ed-eye ed-lock";
      const locked = lockedUserLayers.has(name);
      lock.innerHTML = lockIcon(locked);
      lock.classList.toggle("on", locked);
      lock.title = `${locked ? "Unlock" : "Lock"} everything in ${name}`;
      lock.addEventListener("click", () => {
        if (!lockedUserLayers.delete(name)) lockedUserLayers.add(name);
        modelRev++;
        buildDataLayers();
      });
      const label = el("span", "ed-layer-name");
      const count = [...model.tree.nodes.values()].filter((n) => n.layers.includes(name)).length;
      label.textContent = `${name} (${count})`;
      const assign = button("+sel", () => {
        const ids = selection();
        if (!ids.length) return;
        beginAction();
        for (const id of ids) {
          const n = model.tree.nodes.get(id);
          if (n && !n.layers.includes(name)) n.layers.push(name);
        }
        markDirty();
        buildDataLayers();
      });
      assign.title = `Put the selection in ${name}`;
      const unassign = button("−sel", () => {
        const ids = selection();
        if (!ids.length) return;
        beginAction();
        for (const id of ids) {
          const n = model.tree.nodes.get(id);
          if (n) n.layers = n.layers.filter((l) => l !== name);
        }
        markDirty();
        buildDataLayers();
      });
      unassign.title = `Take the selection out of ${name}`;
      const remove = button("×", () => {
        beginAction();
        model.dataLayers = model.dataLayers.filter((l) => l !== name);
        for (const n of model.tree.nodes.values()) n.layers = n.layers.filter((l) => l !== name);
        hiddenUserLayers.delete(name);
        lockedUserLayers.delete(name);
        markDirty();
        buildDataLayers();
      });
      remove.title = `Remove the layer ${name} (every node leaves it)`;
      row.append(eye, lock, label, assign, unassign, remove);
      dataLayerList.appendChild(row);
    }
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
    saveLayerState();
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
    saveLayerState();
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
    const tools: Tool[] = lockedLayers.has(activeLayer) || workspace !== "2d"
      ? ["select"]
      : LAYER_TOOLS[activeLayer];
    for (const [k, b] of Object.entries(toolBtns)) {
      b.style.display = tools.includes(k as Tool) ? "" : "none";
    }
    mushroomButton.style.display = tools.includes("glow") ? "" : "none";
    refreshBlocks(toolbar2d);
    fitToolbar();
    // The same gesture draws two different things: a camera path is a route the
    // camera rides, and a scene one is a BAR - the curve a rail's cuff slides
    // along, stroked out to its width. The button says which.
    if (activeLayer === "scene") setToolName(toolBtns.path, "Curve", "curve");
    else setToolName(toolBtns.path, "Camera path", "path");
    toolBtns.path.title = PATH_TOOL_TITLE[activeLayer];
    if (!tools.includes(tool)) setTool("select");
  }

  function setLayer(l: EdLayer): void {
    if (!visibleLayers.has(l)) setLayerVisible(l, true);
    activeLayer = l;
    // The selection survives: every visible layer is pickable, so items on the
    // outgoing layer are still selectable and still shown by the inspector.
    for (const [k, b] of Object.entries(layerBtns)) {
      b.classList.toggle("active", k === l);
      b.setAttribute("aria-pressed", String(k === l));
    }
    // `kind` is a geometry property; a camera region and a note have none.
    refreshToolOptions();
    refreshToolButtons();
    rebuildInspector();
  }

  // PREVIEW SETTINGS: what the editor's view (and ▶ Test) draws, as a menu
  // off the viewport bar. Editor settings, remembered per browser, never
  // written into the level.
  const testRow = el("div", "ed-row ed-preview-panel");
  const previewOptions = document.createElement("details");
  previewOptions.className = "ed-preview-options";
  const previewSummary = document.createElement("summary");
  previewSummary.className = "ed-btn";
  previewSummary.textContent = "Preview settings";
  previewOptions.append(previewSummary, testRow);
  viewBar.appendChild(previewOptions);
  // A click anywhere else closes the menu, as a menu does.
  window.addEventListener("pointerdown", (e) => {
    if (previewOptions.open && !previewOptions.contains(e.target as Node)) previewOptions.open = false;
  }, true);
  // Where a ▶ Test starts: the SELECTED CHECKPOINT if one is picked, and
  // otherwise the level's own spawn.
  //
  // A checkpoint is a named place to start from, so selecting one and pressing
  // Test meaning anything else would be the editor ignoring what is selected.
  // It is the same override the cursor spot-check uses (`B`), and it goes the
  // same way into the data the test is built from, so a reset during the test -
  // and the bundle it exports - comes back to the checkpoint too.
  function testSpawn(): Vec2 | undefined {
    const picked = selectedBodies().filter(isCheckpointNote);
    return picked.length === 1 ? picked[0]!.pos : undefined;
  }
  const btnTestBall = button("Test level", () => startTest(testSpawn()));
  btnTestBall.classList.add("ed-primary");
  btnTestBall.title =
    "Test from the level's spawn, or from the selected checkpoint (B tests from the cursor)";
  // The click is on its way: build its level now (see `prebuildTest`).
  btnTestBall.addEventListener("pointerenter", () => prebuildTest(performance.now(), true));
  fileRow.append(btnTestBall);
  const snapChk = checkbox("snap 5cm", snapOn, (v) => {
    snapOn = v;
    writeViewSetting("snap", v);
  });
  testRow.append(snapChk);
  // The screen-edge guarantee, off-switchable for a test and NOWHERE else. The
  // game never turns it off - it is the one camera rule a level may not opt out
  // of - but an author tuning a lock or a lookahead needs to see the framing it
  // is actually asking for, and that question is unanswerable while the answer
  // is being silently corrected. Editor state, never written to a file.
  const edgeChk = checkbox("edge clamp", edgeClampOn, (v) => {
    edgeClampOn = v;
    testCameraCtl.edgeClamp = v;
    writeViewSetting("edgeClamp", v);
  });
  edgeChk.title =
    "Keep the avatar out of the outer 8% of the frame during ▶ Test. On in the game always; untick to see the raw framing a camera rule is asking for (the overlay draws the clamp in amber on the frames it is holding).";
  testRow.append(edgeChk);
  if (scene3d) {
    const allDebugChk = checkbox("all debug", allDebugShown, (v) => {
      allDebugShown = v;
      scene3d.setAllDebugShown(v);
      writeViewSetting("allDebug", v);
    });
    allDebugChk.title =
      "Draw every collision shape's debug geometry in 3D, here and in ▶ Test, whether or not its own draw box is ticked. An editor setting: no shape's Debug settings change, and the game draws each shape as authored.";
    testRow.append(allDebugChk);
    const reflectionsChk = checkbox("reflections", reflectionsOn, (v) => {
      reflectionsOn = v;
      scene3d.setReflectionProbe(v);
      scene3d.setPoolMirror(v);
      writeViewSetting("reflections", v);
    });
    reflectionsChk.title =
      "Draw the ball's reflection of the level and the pools' mirror, here and in ▶ Test. Untick to skip the shader compiles they cost the first time new scenery comes into them (the editor runs no prewarm). Off, the ball reflects the sky. An editor setting: the game always draws both.";
    testRow.append(reflectionsChk);
    const shadowsChk = checkbox("shadows", shadowsOn, (v) => {
      shadowsOn = v;
      scene3d.setShadows(v);
      writeViewSetting("shadows", v);
    });
    shadowsChk.title =
      "Draw the sun's and the lamps' shadows, here and in ▶ Test. Untick to skip the shader compiles the shadow pass costs the first time a new kind of object comes into a shadow (the editor runs no prewarm). Switching either way recompiles the lit shaders once. An editor setting: no light's Cast shadow changes, and the game always draws them.";
    testRow.append(shadowsChk);
    const waterChk = checkbox("water", waterShown, (v) => {
      waterShown = v;
      scene3d.setWaterShown(v);
      writeViewSetting("water", v);
    });
    waterChk.title =
      "Draw the water - pools, currents, falls and the scene's water continuing a pool - here and in ▶ Test. Untick to skip the shader compiles it costs the first time a body of it comes into view (the editor runs no prewarm). Only the picture: the ball still floats and drags in the water. An editor setting: the game always draws it.";
    testRow.append(waterChk);
    const rootsChk = checkbox("roots", rootsShown, (v) => {
      rootsShown = v;
      scene3d.setRootsShown(v);
      writeViewSetting("roots", v);
    });
    rootsChk.title =
      "Draw the roots, here and in ▶ Test. Untick to draw and reshape a root without regrowing its mesh on every edit (a branched root takes a few hundred ms each time); its outline still shows where it is. Only the picture: the hook still bites the roots. An editor setting: the game always draws them.";
    testRow.append(rootsChk);
    const sceneChk = checkbox("scene", blenderSceneShown, (v) => {
      blenderSceneShown = v;
      scene3d.setSceneShown(v);
      writeViewSetting("scene", v);
    });
    sceneChk.title =
      "Draw the bodies' look - their formations, decorations and models - here and in ▶ Test. Untick to see the collision and what the game draws itself (water, belts, chains, lights, the ball) on their own; a hidden look is not picked or dropped onto. An editor setting: the game always draws it.";
    testRow.append(sceneChk);
    const fogChk = checkbox("fog in editor", fogInEditor, (v) => {
      fogInEditor = v;
      writeViewSetting("fog", v);
    });
    fogChk.title =
      "Draw the fog regions' fog in the editor's view as well as in ▶ Test - as the game's camera sees it, at any zoom or orbit. Off, a distant piece is easier to judge. An editor setting: ▶ Test always draws it.";
    testRow.append(fogChk);
  }

  // View toggle. Only offered when there is a WebGL context to toggle: a machine
  // that cannot draw the scene should not be shown two dead buttons.
  const viewBtns: Partial<Record<ViewMode, HTMLButtonElement>> = {};
  if (scene3d) {
    const viewRow = el("div", "ed-row ed-view-btns");
    viewBar.prepend(viewRow);
    const setViewMode = (m: ViewMode): void => {
      viewMode = m;
      for (const [k, b] of Object.entries(viewBtns)) {
        b.classList.toggle("active", k === m);
        b.setAttribute("aria-pressed", String(k === m));
      }
      // The 3D canvas keeps its last frame otherwise, showing a stale scene
      // under a 2D view that is meant to be the editor exactly as it was.
      refreshSceneCanvas();
      // A turned view is only a turned view while a scene is drawn: the 2D mode
      // is the plane itself and edits normally, orbit or no orbit.
      refreshOrbitBtn();
      applyToolCursor();
    };
    // The overlay (outlines, handles, regions, drafts) over the scene, or the
    // scene alone for judging the level as it reads - Blender's overlays
    // toggle. One button, lit while the overlays are shown.
    viewBtns.overlay = button("Overlays", () => setViewMode(viewMode === "overlay" ? "3d" : "overlay"));
    viewBtns.overlay.title = "Draw the outlines, handles, regions and drafts over the scene; off shows the level alone";
    // Back to the gameplay plane head on, where the view is looking. It
    // lights up while the view is turned, so it reads as the way back rather
    // than as a button that usually does nothing.
    resetViewBtn = button("Align camera to plane", resetView);
    resetViewBtn.title =
      "Face the gameplay plane head on (Numpad 1). Middle or right drag pans, Alt + middle drag orbits, the wheel dollies, F frames the selection, Home frames everything";
    // The lens is the view cube's (top right of the viewport, `viewCube`).
    // THE GAME'S CAMERA, in the Visuals workspace: what a player sees where the
    // view is looking, through the level's lens at the zoom its camera regions
    // rest at - where foreground decoration is judged (docs/formations.md).
    const gameViewBtn = button("Game camera", () => gameCameraView());
    gameViewBtn.title = "See the level through the game's camera where the view is looking: its lens and the zoom it rests at there (Numpad 0)";
    viewRow.append(
      viewBtns.overlay!,
      resetViewBtn,
      gameViewBtn,
    );
    setViewMode(viewMode);
    refreshOrbitBtn();
    viewCube = new ViewCube({ face: swingView, projection: setProjection });
    floatCol.appendChild(viewCube.el);
    setProjection(projection);
  }

  // The scene canvas is shown whenever a scene is drawn.
  function refreshSceneCanvas(): void {
    if (sceneCanvas) sceneCanvas.style.display = sceneShown() ? "" : "none";
  }

  // --- workspaces (workspaces.ts) -------------------------------------------
  function setWorkspace(ws: Workspace, boot = false): void {
    if (!boot && (ws === workspace || mode !== "edit")) return;
    workspace = ws;
    writeWorkspace(ws);
    // The brush is the workspace's: leaving it ends it.
    decorations.end();
    // The library is read again while Texturing is open: a material saved
    // in Blender shows on the rocks.
    materialMasks.watchLibrary(ws === "texturing");
    // A grab in progress is placed where it is; combining is Formations'.
    if (grab) endTransform(true);
    if (ws !== "formations") cancelCombine();
    // Nothing outside the workspace stays selected: it is neither drawn nor
    // picked here, but a nudge, a field or a Delete would still reach it.
    for (const id of [...selectedIds]) {
      const it = itemOf(id);
      if (!it || !inWs(it)) selectedIds.delete(id);
    }
    for (const id of [...selectedBodyIds]) if (!bodyMembers(model.items, id).some(inWs)) selectedBodyIds.delete(id);
    if (ws !== "2d") {
      selectedChainIds.clear();
      selectedVineIds.clear();
      selectedVerts.clear();
      selectedBerry = null;
      clearRouteSel();
      cancelPolyDraft();
      cancelRootDraft();
    }
    // The view STAYS WHERE IT IS: the switch is to work on the same place
    // another way, so the camera keeps its position and direction (Tris,
    // 2026-11-25; each 3D workspace used to come back at the angle it was left
    // at, which moved the camera on every switch between Formations and
    // Decorations). 2D too since 2026-11-26, when its head-on lock went: it is
    // navigated as the others are, and Align camera to plane faces the plane.
    viewSwing++;
    refreshOrbitBtn();
    // The toolbar and the tool settings are the workspace's own; the layers
    // are 2D's.
    layerList.style.display = ws === "2d" ? "" : "none";
    formationsDock.style.display = ws === "formations" ? "" : "none";
    decorationsDock.style.display = ws === "decorations" ? "" : "none";
    texturingDock.style.display = ws === "texturing" ? "" : "none";
    toolbar2d.style.display = ws === "2d" ? "" : "none";
    toolbarFormations.style.display = ws === "formations" ? "" : "none";
    toolbarDecorations.style.display = ws === "decorations" ? "" : "none";
    toolbarTexturing.style.display = ws === "texturing" ? "" : "none";
    fitToolbar();
    for (const [w, b] of workspaceTabBtns) {
      b.classList.toggle("active", w === ws);
      b.setAttribute("aria-selected", String(w === ws));
    }
    root.dataset["workspace"] = ws;
    refreshToolButtons();
    outlinerRev = -1;
    rebuildInspector();
    syncGizmo();
    applyToolCursor();
  }

  const title = el("div", "ed-title");
  statusLine.appendChild(title);

  // THE INSPECTOR: the selection's window, floating over the viewport under
  // the view cube and the lens, beside the scene tree it was picked in. Not
  // drawn with nothing selected.
  const inspector = el("div", "ed-inspector");
  inspector.setAttribute("aria-label", "Properties");
  inspector.hidden = true;
  floatCol.appendChild(inspector);
  // On a narrow screen, make room for the scene; either dock can be reached
  // explicitly instead of pinning both over the entire viewport.
  const paneSwitcher = el("div", "ed-pane-switcher");
  const paneButtons = new Map<string, HTMLButtonElement>();
  for (const [label, pane] of [["Scene", "scene"]]) {
    const toggle = button(label!, () => {
      const opening = !root.classList.contains(`ed-${pane}-open`);
      for (const [key, control] of paneButtons) {
        const open = key === pane && opening;
        root.classList.toggle(`ed-${key}-open`, open);
        control.setAttribute("aria-expanded", String(open));
      }
    });
    toggle.setAttribute("aria-expanded", "false");
    paneButtons.set(pane!, toggle);
    paneSwitcher.appendChild(toggle);
  }
  root.appendChild(paneSwitcher);

  // --- outliner -------------------------------------------------------------
  // The level as it actually IS: every node, nested as it is nested, in the
  // right dock (its Scene tab), the data layers over it.
  //
  // It exists because the canvas cannot show the structure: on it a body is a
  // diamond and a dashed hull around shapes that look like separate things,
  // and the nodes with no outline at all - a light, the Sun, a plain group -
  // are a faint ring or nothing.
  //
  // The workspace's tools are its toolbar and tool settings, over the
  // viewport.
  const outliner = el("div", "ed-outliner");
  // The layers first - the type layers (2D's), then the data layers - over
  // the tree and its search: what is shown and locked is set before what is
  // picked (Tris, 2026-11-26).
  scenePane.append(layerList, dataLayerList, outliner);
  // The workspace's tool settings across the viewport's top, and its toolbar
  // down the viewport's left edge (there is no left dock since 2026-11-26).
  root.append(bar, toolbar);
  const outlinerHead = el("div", "ed-outliner-head");
  const outlinerTitle = el("span", "ed-outliner-title");
  const outlinerBody = el("div", "ed-outliner-list");
  let outlinerOpen = true;
  const outlinerToggle = button("", () => {
    outlinerOpen = !outlinerOpen;
    outlinerToggle.setAttribute("aria-expanded", String(outlinerOpen));
    outlinerBody.style.display = outlinerOpen ? "" : "none";
    outlinerTools.style.display = outlinerOpen ? "" : "none";
  });
  outlinerToggle.classList.add("ed-twist");
  outlinerToggle.innerHTML = uiIcon("chevron");
  outlinerToggle.setAttribute("aria-label", "Show objects");
  outlinerToggle.setAttribute("aria-expanded", "true");
  // `+` on the heading adds at the top level, as a row's `+` adds under it.
  const outlinerAdd = button("+", () => showAddChildMenu(null, outlinerAdd));
  outlinerAdd.classList.add("ed-out-head-add");
  outlinerAdd.title = "Add a node at the top of the tree: a group, a body, fog, a shelter, the level's Sun or Environment";
  outlinerHead.append(outlinerToggle, outlinerTitle, outlinerAdd);
  // SEARCH, and opening or folding every row at once. A query shows the
  // nodes whose name (or class) holds it, and the rows above each, opened
  // down to it whatever was open before, so a match is never hidden in a
  // folded row; clearing it gives back the tree as it was left. Escape clears.
  const outlinerTools = el("div", "ed-out-tools");
  const searchWrap = el("label", "ed-out-search");
  searchWrap.innerHTML = uiIcon("search");
  const outlinerSearch = document.createElement("input");
  outlinerSearch.type = "search";
  outlinerSearch.className = "ed-text";
  outlinerSearch.placeholder = "Search nodes";
  outlinerSearch.setAttribute("aria-label", "Search the scene tree");
  outlinerSearch.addEventListener("input", () => {
    outlinerRev = -1;
    refreshOutliner();
  });
  outlinerSearch.addEventListener("keydown", (e) => {
    // The tree's field, not the canvas's shortcuts.
    e.stopPropagation();
    if (e.key === "Escape" && outlinerSearch.value) {
      outlinerSearch.value = "";
      outlinerRev = -1;
      refreshOutliner();
    }
  });
  searchWrap.appendChild(outlinerSearch);
  const expandAll = button("", () => {
    for (const n of model.tree.nodes.values()) if (listedChildren(n).length) expandedBodies.add(n.id);
    outlinerRev = -1;
    refreshOutliner();
  });
  expandAll.innerHTML = uiIcon("expandAll");
  expandAll.title = "Expand every row";
  expandAll.setAttribute("aria-label", "Expand all");
  const collapseAll = button("", () => {
    expandedBodies.clear();
    outlinerRev = -1;
    refreshOutliner();
  });
  collapseAll.innerHTML = uiIcon("collapseAll");
  collapseAll.title = "Collapse every row";
  collapseAll.setAttribute("aria-label", "Collapse all");
  for (const b of [expandAll, collapseAll]) b.classList.add("ed-out-tool");
  outlinerTools.append(searchWrap, expandAll, collapseAll);
  outliner.append(outlinerHead, outlinerTools, outlinerBody);

  // THE SCENE TREE (plans/node-tree.md "Editor"): every node of the level,
  // nested as the level is nested. A row click selects exactly that node,
  // grouped or not, as Godot's does; a drag moves a node under another (onto
  // a row) or among its siblings (between rows), keeping where it stands in
  // the world - Alt keeps its numbers instead, so it lands at the same offset
  // on its new parent. A row's `+` adds a node under it, a double-click
  // renames it. The breadcrumb over the list is the path of what is selected.
  //
  // Which nodes are open, kept across rebuilds so a drag does not collapse the
  // tree under the pointer. Keyed by node id, which never changes.
  const expandedBodies = new Set<string>();
  // What the tree was last built from. A real level is several hundred nodes,
  // so it is rebuilt when the MODEL changes and only re-highlighted when the
  // selection does.
  let outlinerRev = -1;
  // What the tree was last highlighted for, so a selection made on the canvas
  // is scrolled to once, not fought for every frame.
  let outlinerSelKey = "";
  // The breadcrumb: the selected node's path of names.
  const outlinerCrumb = el("div", "ed-out-crumb");
  outliner.insertBefore(outlinerCrumb, outlinerBody);

  // The node ids a row stands for, by kind of selection it answers to.
  const nodeRows = new Map<string, HTMLElement>();

  // Every node the canvas selection covers: the items' nodes, the selected
  // frames, chains and vines.
  function selectedNodeIds(): Set<string> {
    const out = new Set<string>(selectedBodyIds);
    for (const id of selectedIds) {
      const item = itemOf(id);
      if (item) out.add(item.node);
    }
    for (const n of model.tree.nodes.values()) {
      if ((n.chain !== null && selectedChainIds.has(n.chain)) || (n.vine !== null && selectedVineIds.has(n.vine))) out.add(n.id);
    }
    return out;
  }

  function refreshOutliner(): void {
    if (outlinerRev !== modelRev) {
      outlinerRev = modelRev;
      buildOutliner();
    }
    const sel = selectedNodeIds();
    let first: HTMLElement | null = null;
    for (const [id, row] of nodeRows) {
      const on = sel.has(id);
      row.classList.toggle("sel", on);
      if (on && !first) first = row;
    }
    const only = sel.size === 1 ? [...sel][0]! : null;
    outlinerCrumb.textContent = only ? pathOf(model.tree, only) : sel.size ? `${sel.size} nodes` : "";
    const key = [...sel].sort().join(",");
    if (key === outlinerSelKey) return;
    outlinerSelKey = key;
    first?.scrollIntoView({ block: "nearest" });
  }

  // A short mark for a node's class: what it is at a glance.
  const TYPE_MARK: Partial<Record<NodeType, string>> = {
    Node: "○",
    Node2D: "◇",
    Node3D: "◆",
    StaticBody2D: "▣",
    AnimatableBody2D: "⟳",
    RigidBody2D: "●",
    Area2D: "▢",
    CollisionShape2D: "▭",
    Anchor2D: "⚓",
    Spawn2D: "☺",
    Checkpoint2D: "⚑",
    CameraRegion2D: "⬚",
    CameraPath2D: "⤳",
    Track2D: "⛟",
    Shelter2D: "⌂",
    FogRegion2D: "≋",
    Note2D: "✎",
    Formation3D: "⛰",
    Decoration3D: "❦",
    Model3D: "⬢",
    Light3D: "☀",
    Chain: "⛓",
    Vine: "⌇",
    Instance: "⧉",
    Sun: "☼",
    Environment: "◐",
  };

  // The class a node shows as: a body's follows what it is now.
  // A placed prefab shows as one (its root's class is in its title).
  const shownType = (n: EdNode): NodeType => (n.instance ? "Instance" : n.body ? bodyNodeType(n.body) : n.type);
  // The class a node is: a placed prefab's is its root's.
  const classOfNode = (n: EdNode): NodeType => (n.instance ? ((n.extra["rootType"] as NodeType | undefined) ?? "Node2D") : shownType(n));
  // The children a scene-tree row lists: a placed prefab's insides only once
  // they are made editable, what was added under it always.
  const listedChildren = (n: EdNode): string[] =>
    n.instance && !n.instance.editable ? n.children.filter((c) => model.tree.nodes.get(c)?.extra["inInstance"] !== n.id) : n.children;

  // Is a node shown in the scene tree. Every node is, in every workspace (the
  // tree is the level, not the workspace's view of it; since 2026-11-27), but
  // an open prefab's tree is the prefab: its one root, not the level's spawn
  // and light it is shown among.
  const listedInTree = (n: EdNode): boolean => !(prefabMode && isLevelFurniture(n));

  // Where a drag would drop: onto a row (under it) or between two (among its
  // siblings, before or after it).
  let treeDrag: string | null = null;
  function dropOf(row: HTMLElement, e: DragEvent): "into" | "before" | "after" {
    const r = row.getBoundingClientRect();
    const t = (e.clientY - r.top) / Math.max(1, r.height);
    return t < 0.25 ? "before" : t > 0.75 ? "after" : "into";
  }

  function buildOutliner(): void {
    nodeRows.clear();
    outlinerBody.innerHTML = "";
    let count = 0;
    // The search: the nodes that match, and every node with a match below it
    // (shown for the path, dimmed, opened). Null with no query.
    const query = outlinerSearch.value.trim().toLowerCase();
    const matched = new Set<string>();
    const onPath = new Set<string>();
    if (query) {
      const visit = (id: string): boolean => {
        const n = model.tree.nodes.get(id);
        if (!n || !listedInTree(n)) return false;
        let below = false;
        for (const c of listedChildren(n)) if (visit(c)) below = true;
        const hit = n.name.toLowerCase().includes(query) || shownType(n).toLowerCase().includes(query);
        if (hit) matched.add(n.id);
        if (below) onPath.add(n.id);
        return hit || below;
      };
      for (const r of model.tree.roots) visit(r);
    }
    const addRow = (n: EdNode, depth: number): void => {
      if (!listedInTree(n)) return;
      if (query && !matched.has(n.id) && !onPath.has(n.id)) return;
      count++;
      const open = query ? onPath.has(n.id) : expandedBodies.has(n.id);
      const type = shownType(n);
      const row = el("div", `ed-out-row node${n.body ? " body" : ""}${n.item !== null ? " obj" : ""}${query && !matched.has(n.id) ? " ctx" : ""}`);
      row.style.paddingLeft = `${depth}ch`;
      row.draggable = true;
      const listed = listedChildren(n);
      const twist = el("span", `ed-out-twist${listed.length ? " live" : ""}`);
      twist.textContent = listed.length ? (open ? "▾" : "▸") : "";
      twist.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!listed.length) return;
        if (open) expandedBodies.delete(n.id);
        else expandedBodies.add(n.id);
        buildOutliner();
        refreshOutliner();
      });
      const mark = el("span", "ed-out-type");
      mark.textContent = TYPE_MARK[type] ?? "·";
      const cls = classOfNode(n);
      mark.title = n.instance ? `Instance of the prefab ${n.instance.prefab} (a ${cls})` : type;
      const dim = el("span", "ed-out-dim");
      dim.textContent = is3D(cls) ? "3D" : cls === "Node" || cls === "Chain" || cls === "Vine" || cls === "Instance" || cls === "Sun" || cls === "Environment" ? "" : "2D";
      const label = el("span", "ed-out-label");
      label.textContent = n.name;
      label.title = `${pathOf(model.tree, n.id)} · ${type}${n.item !== null ? ` · ${objectLabel(itemOf(n.item)!, M2PX)}` : ""}`;
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        renameNodeInline(n, label);
      });
      // The group mark is its toggle: lit on a grouped node, drawn dim under
      // the pointer on one that is not, a click flipping it as the Node
      // section's box does.
      const group = el("span", `ed-out-group${n.grouped ? " on" : ""}`);
      group.textContent = "⊞";
      group.title = n.grouped
        ? "Grouped: a click on the canvas selects this first (click or Ctrl+Shift+G ungroups)"
        : "Group: a click on the canvas will select this first (Ctrl+G groups the selection)";
      group.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        beginAction();
        n.grouped = !n.grouped;
        markDirty();
        rebuildInspector();
      });
      const add = el("span", "ed-out-add");
      add.textContent = "+";
      add.title = "Add a node under this one";
      add.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        showAddChildMenu(n.id, add);
      });
      const hidden = hiddenBodies.has(n.id);
      const eye = document.createElement("button");
      eye.className = "ed-eye ed-out-eye";
      eye.innerHTML = eyeIcon(!hidden);
      eye.classList.toggle("off", hidden);
      eye.title = `${hidden ? "Show" : "Hide"} this node (H hides the selection, Alt+H shows everything)`;
      eye.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        setBodiesHidden([n.id], !hiddenBodies.has(n.id));
      });
      // The padlock: amber on a node locked itself, dim but shut on one a
      // node above it locks, and shown only under the pointer otherwise, so
      // a tree of several hundred rows is not a column of open padlocks.
      const above = n.locked ? null : lockedBy(n.id);
      const lock = document.createElement("button");
      lock.className = "ed-eye ed-lock ed-out-eye ed-out-lock";
      lock.innerHTML = lockIcon(n.locked || above !== null);
      lock.classList.toggle("on", n.locked);
      lock.classList.toggle("inherited", above !== null);
      lock.title = n.locked
        ? "Locked: not picked on the canvas, nor anything under it; the tree still selects it (click or Ctrl+Shift+L unlocks)"
        : above
          ? `Locked with ${above.name}; click to lock this node itself too`
          : "Lock: the canvas will not pick this node or anything under it (Ctrl+L locks the selection)";
      lock.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        setNodesLocked([n.id], !n.locked);
      });
      row.classList.toggle("hidden", hidden || n.disabled);
      row.append(twist, mark, dim, label, group, add, eye, lock);
      row.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        // Combining guides: the row picks its formation instead.
        if (combine) {
          const f = membersOf(model, n.id).find((m) => m.object === "formation");
          if (f) toggleCombinePick(f.id);
          return;
        }
        pickNodeRow(n, e.shiftKey || e.ctrlKey || e.metaKey);
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pickNodeRow(n, false);
        showNodeMenu(n, label, e.clientX, e.clientY);
      });
      row.addEventListener("dragstart", (e) => {
        if (n.extra["spawn"] === true) {
          e.preventDefault();
          return;
        }
        treeDrag = n.id;
        e.dataTransfer?.setData("text/plain", n.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        treeDrag = null;
        for (const r of nodeRows.values()) r.classList.remove("drop-into", "drop-before", "drop-after");
      });
      row.addEventListener("dragover", (e) => {
        if (treeDrag === null || treeDrag === n.id) return;
        const where = dropOf(row, e);
        const parent = where === "into" ? n.id : n.parent;
        if (canParent(model.tree, treeDrag, parent) !== null) return;
        e.preventDefault();
        row.classList.remove("drop-into", "drop-before", "drop-after");
        row.classList.add(`drop-${where}`);
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-into", "drop-before", "drop-after"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("drop-into", "drop-before", "drop-after");
        const dragged = treeDrag;
        treeDrag = null;
        if (dragged === null || dragged === n.id) return;
        const where = dropOf(row, e);
        const parent = where === "into" ? n.id : n.parent;
        const siblings = where === "into" ? n.children : n.parent === null ? model.tree.roots : model.tree.nodes.get(n.parent)!.children;
        const index = where === "into" ? undefined : siblings.indexOf(n.id) + (where === "after" ? 1 : 0);
        moveNodeTo(dragged, parent, index, e.altKey);
      });
      outlinerBody.appendChild(row);
      nodeRows.set(n.id, row);
      if (!open) return;
      for (const c of listed) {
        const k = model.tree.nodes.get(c);
        if (k) addRow(k, depth + 1);
      }
    };
    for (const r of model.tree.roots) {
      const n = model.tree.nodes.get(r);
      if (n) addRow(n, 0);
    }
    outlinerTitle.textContent = query ? `Scene (${matched.size} of ${model.tree.nodes.size})` : `Scene (${model.tree.nodes.size})`;
    if (query && !matched.size) {
      const none = el("div", "ed-hint ed-out-none");
      none.textContent = `No node matches "${outlinerSearch.value.trim()}"`;
      outlinerBody.appendChild(none);
    }
    void count;
  }

  // A drag's drop, as one undo step: refused with the reason when the tree
  // would not have the node there.
  function moveNodeTo(id: string, parent: string | null, index: number | undefined, keepRelative: boolean): void {
    if (canParent(model.tree, id, parent) !== null) {
      flashNotice(canParent(model.tree, id, parent)!);
      return;
    }
    beginAction();
    const why = moveNode(model, id, parent, index, keepRelative);
    if (why) {
      history.pop();
      flashNotice(why);
      return;
    }
    if (parent !== null) expandedBodies.add(parent);
    markDirty();
  }

  // A row's name, edited where it stands: Enter keeps it (made free among its
  // siblings), Escape or leaving puts it back.
  function renameNodeInline(n: EdNode, label: HTMLElement): void {
    const input = document.createElement("input");
    input.className = "ed-out-rename";
    input.value = n.name;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (keep && name && name !== n.name) {
        beginAction();
        renameNode(model.tree, n.id, name);
        markDirty();
      } else {
        outlinerRev = -1;
        refreshOutliner();
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("mousedown", (e) => e.stopPropagation());
  }

  // The `+` on a row (or on the tree's heading, for the top level): the nodes
  // that may be added under it, and only those (`canParent`). The level's
  // light is offered while it has none of that class.
  function showAddChildMenu(parent: string | null, anchor: HTMLElement): void {
    const kinds: { type: NodeType; label: string }[] = [
      { type: "Node2D", label: "Node2D (a group in the plane)" },
      { type: "Node3D", label: "Node3D (a frame in the scene)" },
      { type: "StaticBody2D", label: "StaticBody2D" },
      { type: "RigidBody2D", label: "RigidBody2D" },
      { type: "Area2D", label: "Area2D (killzone)" },
      { type: "Anchor2D", label: "Anchor2D" },
      { type: "FogRegion2D", label: "Fog (a fog region)" },
      { type: "Shelter2D", label: "Shelter (a cave's front wall)" },
      { type: "Sun", label: "Sun (the level's sunlight)" },
      { type: "Environment", label: "Environment (the sky and fill)" },
      { type: "Node", label: "Node (a folder)" },
    ].filter((k) => {
      if ((k.type === "Sun" || k.type === "Environment") && lightNode(model, k.type)) return false;
      return canParentNew(parent, k.type as NodeType, true);
    }) as { type: NodeType; label: string }[];
    const menu = el("div", "ed-out-menu");
    for (const k of kinds) {
      const item = el("div", "ed-out-menu-item");
      item.textContent = `${TYPE_MARK[k.type] ?? ""} ${k.label}`;
      item.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        menu.remove();
        addChildNode(parent, k.type);
      });
      menu.appendChild(item);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${r.right}px`;
    menu.style.top = `${r.top}px`;
    document.body.appendChild(menu);
    const close = (e: MouseEvent): void => {
      if (menu.contains(e.target as Node)) return;
      menu.remove();
      window.removeEventListener("mousedown", close, true);
    };
    window.addEventListener("mousedown", close, true);
  }

  // A new node under `parent`, standing where its parent is (or at the
  // view's centre at the top level), and selected.
  function addChildNode(parent: string | null, type: NodeType): void {
    const at = parent !== null ? worldOfNode(model, parent) : { ...WORLD_ORIGIN, pos: camera.position };
    if (type === "Anchor2D") {
      const item: EdItem = { ...blankItem("scene", "anchor", ""), shape: { kind: "rect", w: ANCHOR_GIZMO, h: ANCHOR_GIZMO }, anchorId: newAnchorId(), pos: at.pos, rot: at.rot };
      if (canParentNew(parent, "Anchor2D")) {
        beginAction();
        addItem(model, item, parent);
        markDirty();
        setSelection([item.id]);
      }
      return;
    }
    if (type === "FogRegion2D" || type === "Shelter2D") {
      // A volume of a size worth seeing at the view's centre (or its parent's
      // place), to be dragged and reshaped from there.
      if (!canParentNew(parent, type)) return;
      const fog = type === "FogRegion2D";
      const item: EdItem = {
        ...blankItem("scene", fog ? "fog" : "shelter", ""),
        ...newItemStyle("scene", fog ? "fog" : "shelter"),
        shape: { kind: "rect", w: 4, h: 3 },
        pos: at.pos,
        ...(fog ? { fog: { ...NEW_FOG } } : {}),
      };
      beginAction();
      addItem(model, item, parent);
      if (parent !== null) expandedBodies.add(parent);
      markDirty();
      setSelection([item.id]);
      return;
    }
    if (!canParentNew(parent, type)) return;
    beginAction();
    const body =
      type === "StaticBody2D" || type === "RigidBody2D" || type === "Area2D" || type === "AnimatableBody2D"
        ? { ...defaultBody(nextOrder(model.tree)), kind: (type === "RigidBody2D" ? "rigid" : type === "Area2D" ? "killzone" : "static") as BodyKind }
        : undefined;
    const n = addFrameNode(model, type, parent, { pos: at.pos, rot: at.rot, z: at.z, tilt: [at.tilt[0], at.tilt[1]], ...(body ? { body, grouped: true } : {}) });
    if (parent !== null) expandedBodies.add(parent);
    markDirty();
    setBodySelection(n.id);
  }

  // Would a new node of `type` be allowed under `parent`? Asked of a stand-in
  // so the rule stays the tree's (`canParent`).
  function canParentNew(parent: string | null, type: NodeType, quiet = false): boolean {
    const probe = "__probe__";
    const like = model.tree.nodes.values().next().value;
    if (!like) return parent === null;
    model.tree.nodes.set(probe, { ...like, id: probe, type, parent: null, children: [], body: type.endsWith("Body2D") || type === "Area2D" ? defaultBody(0) : null, item: null, extra: {} });
    const why = canParent(model.tree, probe, parent);
    model.tree.nodes.delete(probe);
    if (why && !quiet) flashNotice(why);
    return why === null;
  }

  // A row click: exactly that node, extended with Shift or Ctrl.
  function pickNodeRow(n: EdNode, extend: boolean): void {
    if (n.chain !== null) return setChainSelection([n.chain]);
    if (n.vine !== null) return setVineSelection([n.vine]);
    if (n.item !== null) {
      const item = itemOf(n.item);
      // Picking on a hidden or locked layer would select something that cannot
      // be seen or edited, so the row reveals it first.
      if (item && (!visibleLayers.has(item.layer) || lockedLayers.has(item.layer))) {
        setLayerVisible(item.layer, true);
        setLayerLocked(item.layer, false);
      }
      if (extend) {
        const next = new Set(selectedIds);
        if (!next.delete(n.item)) next.add(n.item);
        setSelection([...next]);
      } else {
        setSelection([n.item]);
      }
      return;
    }
    if (extend) toggleBodySelection(n.id);
    else setBodySelection(n.id);
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
    const state =
      // A prefab the editor will not write as it stands says why; anything
      // else that stops a write is a failure of the write.
      (prefabMode && prefabRefusal ? ` · NOT SAVED: ${prefabRefusal}` : saveError ? " · SAVE FAILED" : dirty ? " *" : "") +
      (buildError ? ` · DOES NOT BUILD: ${buildError}` : "");
    const count = (l: EdLayer) => model.items.filter((i) => i.layer === l).length;
    // Only the layers that have anything on them are named, so the title stays
    // short on a level that only uses geometry.
    // Bodies rather than items: a body is the unit the level is written in, and
    // the outliner counts the same thing the same way.
    // The scene's things, its volumes (fog, shelters) counted on their own.
    const things = model.items.filter((i) => i.layer === "scene" && i.object !== "fog" && i.object !== "shelter" && i.object !== "track");
    const bodies = new Set(things.map((i) => i.unit)).size;
    const lights = model.items.filter((i) => i.object === "light").length;
    // The notes layer holds two different things (see `EdNote`), so it is
    // counted as two: "3 notes" that silently included two checkpoints would be
    // a count of neither.
    const checkpoints = model.items.filter(isCheckpointNote).length;
    const objects = (o: EdObject, one: string, many: string): string => {
      const n = model.items.filter((i) => i.object === o && i.layer === "scene").length;
      return n ? ` · ${n} ${n === 1 ? one : many}` : "";
    };
    const extra =
      objects("shelter", "shelter", "shelters") +
      objects("fog", "fog region", "fog regions") +
      objects("track", "track", "tracks") +
      ([
        ["camera", "cam", "cam"],
        ["notes", "note", "notes"],
      ] as const)
        .map(([l, one, many]) => {
          const n = l === "notes" ? count(l) - checkpoints : count(l);
          return n ? ` · ${n} ${n === 1 ? one : many}` : "";
        })
        .join("") +
      (checkpoints ? ` · ${checkpoints} checkpoint${checkpoints === 1 ? "" : "s"}` : "") +
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
    const openDraft = polyDraft?.kind === "path" || polyDraft?.kind === "track";
    const draft = polyDraft
      ? ` · ${polyDraft.kind === "track" ? "track" : openDraft ? "path" : "polygon"}: ${polyDraft.verts.length} ` +
        `${polyDraft.verts.length === 1 ? "vertex" : "vertices"}` +
        (polyDraft.verts.length >= (openDraft ? 2 : 3)
          ? openDraft
            ? " · Enter to finish"
            : " · Enter to close"
          : "")
      : rootDraft
        ? ` · ${rootDraft.from ? "branch" : "root"}: ${rootDraft.verts.length} ` +
          `${rootDraft.verts.length === 1 ? "node" : "nodes"} · drag to pull handles` +
          (rootDraft.verts.length >= 2 ? " · Enter to grow it" : "")
        : cutDraft
          ? " · cut: click where it ends (Alt keeps one body) · Esc cancels"
          : tool === "cut"
            ? " · cut: click where it starts"
            : "";
    const named = prefabMode ? `prefab ${prefabName ?? "(unnamed)"}` : (currentName ?? "(unsaved)");
    title.textContent = `${named}${state} · ${things.length} object${things.length === 1 ? "" : "s"}${extra}${draft}${notice ? ` · ${notice}` : ""}`;
  }
  function flashNotice(text: string): void {
    notice = text;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = null;
      noticeTimer = null;
      updateTitle();
    }, 5000);
    updateTitle();
  }
  // The cursor a drag borrows and must hand back (pan swaps in a grab hand).
  function applyToolCursor(): void {
    // Every tool draws at any angle (its preview is the projected overlay's).
    // ...and a decoration armed from the palette, or the brush, aims too.
    canvas.style.cursor = tool === "select" && !decorations.busy ? "default" : "crosshair";
  }
  function setTool(t: Tool): void {
    if (!LAYER_TOOLS[activeLayer].includes(t)) return;
    // The draw tools are the 2D workspace's; the 3D ones select, and their
    // own docks make what they make.
    if (t !== "select" && workspace !== "2d") return;
    // A locked layer accepts no new geometry either, so its draw tools cannot be
    // armed by the keyboard shortcuts any more than by the (hidden) buttons.
    if (t !== "select" && lockedLayers.has(activeLayer)) return;
    if (t !== "poly" && t !== "path") cancelPolyDraft();
    if (t !== "root") cancelRootDraft();
    if (t !== "cut") cancelCutDraft();
    const was = tool;
    tool = t;
    // The title bar says what the knife wants next.
    if (was === "cut" || t === "cut") updateTitle();
    for (const [k, b] of Object.entries(toolBtns)) {
      b.classList.toggle("active", k === t && !(t === "glow" && placingMushroom));
      b.setAttribute("aria-pressed", String(k === t && !(t === "glow" && placingMushroom)));
    }
    mushroomButton.classList.toggle("active", t === "glow" && placingMushroom);
    mushroomButton.setAttribute("aria-pressed", String(t === "glow" && placingMushroom));
    refreshToolOptions();
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
    const wrap = fieldRow(label);
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

  // Nothing rests on a region (see `isAreaKind`) or on hook-only scenery, so
  // neither carries a friction - and hook-only is a flag rather than a kind, so
  // it is asked of the body rather than of its kind. A force area and a body of
  // water both carry a direction, hence a rot° even when they are circles
  // (whose rotation is otherwise invisible).
  //
  // Water's own effect on friction is not this: it scales the friction of
  // whatever is INSIDE it (see `WATER_TRACTION_LOSS`), which is a property of
  // the submerged body rather than a number the water authors.
  const frictionless = (b: EdItem) => isAreaKind(propsOf(b).kind) || propsOf(b).passable;

  // May this item be welded into one body? Geometry that is not an area,
  // decoration included - it rides the body rather than adding a piece to it -
  // and lights. An area is refused because a body has ONE kind: a region is what
  // a body IS rather than something a piece of it can be, so there is no body a
  // killzone and a wall could both be pieces of. (An area
  // with a notch in it is a different matter and perfectly ordinary - it is one
  // authored outline, cut into pieces at load.) Camera regions and notes are
  // never drawn in play and have nothing to ride.
  //
  // A LIGHT is groupable, and it is the reason this is worth stating twice: a
  // lamp is a fitting and the light it throws, and welding the two into one body
  // is what stops them drifting apart. Moving the sconce moves the light because
  // they are the same body, which is the thing that used to have to be faked by
  // deriving a light out of the fitting's emissive colour.
  // Can this item share a body with others? Anything in the scene can: an
  // area may have any number of shapes (plans/node-tree.md "Area2D with
  // several shapes"), its overlap, push, drag and drawing reading every piece.
  // A fog region and a shelter are volumes the camera and the sky read as
  // fixed in the world (`WORLD_FIXED_TYPES`), so they are never part of one.
  // A track is a line in the world with its cart under it, never in a body.
  const canShareBody = (b: EdItem) =>
    b.layer === "scene" && b.object !== "fog" && b.object !== "shelter" && b.object !== "track";

  // An area is a region of space rather than a piece of stuff, so it is made of
  // nothing and carries no density. Every other kind does, `anchor` included:
  // a grate is a real object, and its material fixes the centre of mass a
  // compound one is built and rotated about even though nothing collides with
  // it.
  const massless = (b: EdItem) => isAreaKind(propsOf(b).kind);

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
      opts?: { placeholder?: string; onEmpty?: () => void; disabled?: boolean },
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
    const g = items[0]!.unit;
    if (g === null || !items.every((b) => b.unit === g)) return null;
    const members = bodyMembers(model.items, g);
    return members.length === items.length ? [...items] : null;
  }

  // Placement and size. Shared by every layer's panel: whatever layer an item
  // lives on, it is a placed shape and moves, rotates and resizes the same way.
  // The frame an object is placed IN, which is the origin `toLevelData` measures
  // every object against. One rule, so what the inspector shows and what the
  // file records cannot disagree.
  const bodyOrigin = (b: EdItem): EdBodyFrame => bodyFrameOf(model, b.unit);
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
  // Then `bodyFrameOf` derives the frame FROM IT (the node is the item's own), and
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
  const framedByItself = (b: EdItem): boolean => b.bodyOf === null && b.unit === b.node;

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
    // the body node's own pose (`bodyFrameOf`) rather than a member's, so there is
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
    // A checkpoint is a point: it has a place and nothing else, so the panel
    // stops at x and y (as the handles do - see `computeHandles`).
    if (items.some(isCheckpointNote)) return;
    // A circle's rotation is invisible, so it only gets the field where it aims
    // something (a force area's current).
    if (
      items.every(
        (b) => b.shape.kind !== "circle" || (b.object === "collision" && propsOf(b).kind === "force"),
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
        const frame = (): EdBodyFrame => bodyFrameOf(model, whole[0]!.unit);
        numField(
          g,
          "rot°",
          () => (frame().rot * 180) / Math.PI,
          (v) =>
            rotateItemsAbout(model, whole, bodyTurnCentre(whole), (v * Math.PI) / 180 - frame().rot),
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
              rotateItemsAbout(model, [b], bodyTurnCentre([b]), rad(v) - b.rot);
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
    // Size is per-shape, so it only appears when the group is all one shape.
    // An anchor's box and a model's are the marks a click lands on, not sizes
    // the file records: a model is sized by its own `scale` (its panel).
    if (items.every((b) => b.shape.kind === "rect" && b.object !== "anchor" && b.object !== "model")) {
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
    } else if (items.every((b) => b.shape.kind === "belt")) {
      // A CONVEYOR: the two radii (px, as every length here) and the signed
      // surface speed in m/s, which is the one number on this panel whose sign
      // matters - positive turns the loop clockwise on screen. Three knobs that
      // must not be confused, named so they cannot be: `thickness` is the
      // band's depth IN THE PLANE (collision: the running surface stands that
      // far off every wheel), `width` how wide the band is ACROSS the pulleys
      // (the 3D look, `BeltLook.width`), and `r` one
      // wheel's own radius, shown for the wheel whose square is picked. A value
      // the belt cannot take - a zero thickness, a wheel swallowing another or
      // falling inside the hull - is refused by `setBelt`, and the field reads
      // back what the belt still has.
      num("thickness", (b) => (b.shape.kind === "belt" ? b.shape.thickness * M2PX : 0), (b, v) => {
        setBelt(b, { thickness: Math.max(1, v) * PX });
      });
      // The band's LOOK (`BeltLook`): the game draws a belt's band itself, since
      // its surface runs, so it is authored here rather than in Blender. Held on
      // the shape, like the speed that moves it.
      const looks = items.flatMap((b) => (b.shape.kind === "belt" ? [b.shape.look] : []));
      num(
        "width",
        (b) => (b.shape.kind === "belt" ? (b.shape.look.width ?? DEFAULT_THICKNESS) : 0) * M2PX,
        (b, v) => {
          if (b.shape.kind === "belt") b.shape.look.width = Math.max(1, v) * PX;
        },
        5,
      );
      const tw = fieldRow("texture");
      const ts = document.createElement("select");
      ts.className = "ed-select";
      const keys = new Set<string>([SOLID_SURFACE, ...Object.keys(TEXTURE_ASSETS), ...MATERIAL_NAMES]);
      for (const l of looks) if (l.texture) keys.add(l.texture);
      for (const key of ["", ...keys]) {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = key
          ? key === SOLID_SURFACE
            ? `${key} (flat, cleats)`
            : key in TEXTURE_ASSETS
              ? `${key} (authored)`
              : key
          : "(default)";
        ts.appendChild(o);
      }
      ts.value = looks.every((l) => l.texture === looks[0]!.texture) ? (looks[0]!.texture ?? "") : "";
      ts.addEventListener("change", () => {
        beginAction();
        for (const l of looks) {
          if (ts.value) l.texture = ts.value;
          else delete l.texture;
        }
        markDirty();
        rebuildInspector();
      });
      tw.appendChild(ts);
      g.appendChild(tw);
      // The flat band's colour, or the tint a generated surface wears; absent
      // takes the body's own fill.
      const cw = fieldRow("band colour");
      const ci = colorInput(looks[0]!.color ?? items[0]!.color, beginAction, (hex) => {
        for (const l of looks) l.color = hex;
        markDirty();
      });
      cw.appendChild(ci.el);
      g.appendChild(cw);
      // A multiple of the texture's own size, so not a length and not scaled.
      num(
        "tile scale",
        (b) => (b.shape.kind === "belt" ? (b.shape.look.tileScale ?? 1) : 1),
        (b, v) => {
          if (b.shape.kind === "belt") b.shape.look.tileScale = Math.max(0.01, v);
        },
        0.1,
      );
      num(
        "speed m/s",
        (b) => (b.shape.kind === "belt" ? b.shape.speed : 0),
        (b, v) => {
          setBelt(b, { speed: v });
        },
        0.1,
      );
      // One wheel's radius, when a single belt is selected and one of its
      // wheels is picked (its centre square, or its radius grip).
      const wheel = items.length === 1 ? selectedBeltWheel(items[0]!) : null;
      if (wheel !== null) {
        num(`wheel ${wheel} r`, (b) => (b.shape.kind === "belt" ? (b.shape.wheels[wheel]?.r ?? 0) * M2PX : 0), (b, v) => {
          setBeltWheel(b, wheel, { r: Math.max(1, v) * PX });
        });
      }
      // What the belt IS, as numbers: how far round the loop is and how long
      // one lap of its surface takes - the figure a crate riding it, or a hook
      // bitten into it, is timed by.
      const lap = (which: "perimeter" | "lap"): string => {
        const values = items.map((b) => {
          const l = b.shape.kind === "belt" ? beltLap(b.shape) : null;
          if (!l) return "-";
          if (which === "perimeter") return `${l.perimeter.toFixed(2)} m`;
          return Number.isFinite(l.lap) ? `${l.lap.toFixed(2)} s` : "stopped";
        });
        return values.every((v) => v === values[0]) ? values[0]! : "mixed";
      };
      for (const which of ["perimeter", "lap"] as const) {
        const row = fieldRow(which);
        const val = document.createElement("span");
        val.textContent = lap(which);
        row.appendChild(val);
        g.appendChild(row);
        readouts.push({ el: val, get: () => lap(which) });
      }
      describe(g,
        "The object's position is wheel 0. Drag a square to move a wheel (click one to edit its r here), a round grip on a wheel's rim to size it, a run's midpoint to add a wheel there; Alt+click a square removes its wheel. Every wheel must touch the band. Speed is signed: positive runs the loop clockwise on screen, negative runs it back. A belt builds only on a static body that does not move.");
    } else if (items.every((b) => b.shape.kind === "path" && b.layer === "scene" && b.object !== "track")) {
      // A CURVE has one size and it is the width of the bar: the line itself is
      // edited on the canvas, node by node, exactly as a polygon's outline is.
      // A ROOT branch tapers (docs/roots.md), so its `width` is where it STARTS,
      // at its base, and the panel says so.
      const roots = items.every(isRootItem);
      num(roots ? "start width" : "width", (b) => (b.shape.kind === "path" ? b.shape.width * M2PX : 0), (b, v) => {
        if (b.shape.kind === "path") b.shape.width = Math.max(1, v) * PX;
      });
      // ...and this is what it narrows to at its tip.
      if (roots) {
        const barkRow = fieldRow("bark texture");
        const barkSelect = document.createElement("select");
        barkSelect.className = "ed-select";
        barkSelect.setAttribute("aria-label", "Root bark texture");
        barkSelect.title = "Changes this root and all branches in its body.";
        for (const variant of ROOT_BARK_VARIANTS) {
          const option = document.createElement("option");
          option.value = variant; option.textContent = ROOT_BARK_LABELS[variant];
          barkSelect.appendChild(option);
        }
        const selectedBark = rootBarkVariant(items[0]!.root?.bark);
        if (items.some(b => rootBarkVariant(b.root?.bark) !== selectedBark)) {
          const mixed = document.createElement("option");
          mixed.value = ""; mixed.textContent = "Mixed"; mixed.disabled = true;
          barkSelect.prepend(mixed); barkSelect.value = "";
        } else barkSelect.value = selectedBark;
        barkSelect.addEventListener("change", () => {
          beginAction(); setRootBark(model, items, rootBarkVariant(barkSelect.value));
          markDirty(); rebuildInspector();
        });
        barkRow.appendChild(barkSelect); g.appendChild(barkRow);
        num("tip width", (b) => (b.shape.kind === "path" ? (b.shape.tip ?? b.shape.width) * M2PX : 0), (b, v) => {
          if (b.shape.kind === "path") b.shape.tip = Math.max(0.5, v) * PX;
        });
        const grows = (): string => {
          const says = items.map((b) => {
            const parent = b.root?.parent ?? null;
            return parent === null ? "the ground (a trunk)" : `${Math.round((b.root?.at ?? 0) * 100)}% along its root`;
          });
          return says.every((s) => s === says[0]) ? says[0]! : "mixed";
        };
        const grow = fieldRow("grows from");
        const gval = document.createElement("span");
        gval.textContent = grows();
        grow.appendChild(gval);
        g.appendChild(grow);
        readouts.push({ el: gval, get: grows });
        // Where the branch BENDS (`RootBranchData.bends`): each a place along
        // it with a return spring, the stretch past it a body of its own
        // hinged there. One branch at a time, since bends are the branch's own.
        if (items.length === 1) {
          const item = items[0]!;
          const bendsOf = (b: EdItem): NonNullable<EdRoot["bends"]> => b.root?.bends ?? [];
          const setBends = (b: EdItem, bends: NonNullable<EdRoot["bends"]>): void => {
            if (!b.root) return;
            const { bends: _old, ...rest } = b.root;
            b.root = bends.length > 0 ? { ...rest, bends } : rest;
          };
          const editBend = (k: number, patch: Partial<NonNullable<EdRoot["bends"]>[number]>) => (b: EdItem) => {
            const bends = bendsOf(b).map((x, j) => (j === k ? { ...x, ...patch } : x));
            setBends(b, bends);
          };
          bendsOf(item).forEach((_bend, k) => {
            num(
              `bend ${k + 1} at %`,
              (b) => Math.round((bendsOf(b)[k]?.at ?? 0) * 1000) / 10,
              (b, v) => editBend(k, { at: Math.min(1, Math.max(0, v / 100)) })(b),
              1,
            );
            num(
              `bend ${k + 1} Hz`,
              (b) => bendsOf(b)[k]?.freq ?? ROOT_BEND_FREQ,
              (b, v) => editBend(k, { freq: Math.max(0, v) })(b),
              0.1,
            );
            num(
              `bend ${k + 1} damp`,
              (b) => bendsOf(b)[k]?.damping ?? ROOT_BEND_DAMPING,
              (b, v) => editBend(k, { damping: Math.min(1, Math.max(0, v)) })(b),
              0.05,
            );
            const row = fieldRow("");
            row.appendChild(
              button(`remove bend ${k + 1}`, () => {
                beginAction();
                setBends(item, bendsOf(item).filter((_, j) => j !== k));
                markDirty();
                rebuildInspector();
              }),
            );
            g.appendChild(row);
          });
          const addRow = fieldRow("");
          addRow.appendChild(
            button("+ bend", () => {
              beginAction();
              // Halfway along the longest stretch the branch has unbent.
              const ats = [0, ...bendsOf(item).map((x) => x.at).sort((a, b) => a - b), 1];
              let at = 0.5;
              let widest = -1;
              for (let j = 0; j + 1 < ats.length; j++) {
                if (ats[j + 1]! - ats[j]! > widest) {
                  widest = ats[j + 1]! - ats[j]!;
                  at = (ats[j]! + ats[j + 1]!) / 2;
                }
              }
              setBends(item, [...bendsOf(item), { at }]);
              markDirty();
              rebuildInspector();
            }),
          );
          g.appendChild(addRow);
        }
      }
      // What the curve BUILDS as, for the reason a polygon reports its piece
      // count: the bar is stroked into the convex pieces that tile it at load
      // (`lib/stroke.ts`), and a straight bar is one of them however many nodes
      // it was drawn with - so the number only ever grows where the curve
      // actually bends.
      const pieces = (): string => {
        const counts = items.map((b) =>
          b.shape.kind === "path" ? curvePieceCount(b.shape) : 0,
        );
        return counts.every((c) => c === counts[0]) ? String(counts[0]) : "mixed";
      };
      const prow = fieldRow("pieces");
      const pval = document.createElement("span");
      pval.textContent = pieces();
      prow.appendChild(pval);
      g.appendChild(prow);
      readouts.push({ el: pval, get: pieces });
      describe(g,
        items.every(isRootItem)
          ? "A root branch, tapering from its width to its tip; the game grows the root you see in 3D from it. Drag a node to move it, its round grip to bow the curve, an edge midpoint to add a node, Alt+click to remove one. A branch's first node is where it grows out of its root: drag it to slide the branch along the root. With +Root, start a stroke on any branch to grow another out of it. Delete takes a branch and everything growing from it."
          : "Drag a node to move it, its round grip to bow the curve either side of it (Alt at the press breaks the pair into a corner), an edge midpoint to add a node, Alt+click a node to remove it. The bar is what the curve strokes out at this width, and a rail's cuff rides the line down its middle.");
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
      const row = fieldRow("vertices");
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
      // Only a collision outline is cut up: a shelter is read whole, notch
      // and all (render3d/shelter.ts), so a piece count would be a number about
      // nothing it does.
      const collides = items.every((b) => b.layer === "scene");
      if (!region && collides) {
        const pieces = (): string => {
          const counts = items.map((b) =>
            b.shape.kind === "poly" ? decomposeConvex(b.shape.verts).length : 0,
          );
          return counts.every((c) => c === counts[0]) ? String(counts[0]) : "mixed";
        };
        const prow = fieldRow("pieces");
        const pval = document.createElement("span");
        pval.textContent = pieces();
        prow.appendChild(pval);
        g.appendChild(prow);
        readouts.push({ el: pval, get: pieces });
      }

      describe(g, region
        ? "Drag a corner to move it, an edge midpoint to add one, Alt+click a corner to remove it. Click a corner to pick it out (Shift adds, a rubber band catches several, Esc drops them); Delete removes the picked corners and the arrows nudge them, and dragging any one of them moves the lot. A camera region always stays convex."
        : collides
          ? "Drag a corner to move it, an edge midpoint to add one, Alt+click a corner to remove it. Click a corner to pick it out (Shift adds, a rubber band catches several, Esc drops them); Delete removes the picked corners and the arrows nudge them, and dragging any one of them moves the lot. Corners may be dented inward - a concave outline is cut into convex pieces (dashed) for the physics."
          : "Drag a corner to move it, an edge midpoint to add one, Alt+click a corner to remove it. Click a corner to pick it out (Shift adds, a rubber band catches several, Esc drops them); Delete removes the picked corners and the arrows nudge them, and dragging any one of them moves the lot. Corners may be dented inward: the outline is taken whole, notch and all.");
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
    const cw = fieldRow(label);
    // A colour input has no mixed state; it shows the first item's and writes
    // to all of them, which is the only sane reading of "set the colour".
    const ci = colorInput(items[0]!.color, beginAction, (hex) => {
      for (const b of items) b.color = hex;
      after?.();
      markDirty();
    });
    cw.appendChild(ci.el);
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
      for (const b of items) {
        b.impermeable = box.checked;
        // A hook-proof rail is a bar the hook bounces off and never clamps, and
        // a hook-proof mud face is one it never bites, so the flags are one
        // choice: ticking this unticks the others.
        if (box.checked) {
          b.rail = false;
          b.viscosity = 0;
          b.slipFloor = 0;
        }
      }
      markDirty();
      // The border style is what says a surface is hook-proof, and it is drawn
      // from the item, so the canvas is already right; the panel is rebuilt so
      // the box loses its indeterminate state.
      rebuildInspector();
    });
    const wrap = fieldRow("hook-proof");
    wrap.appendChild(box);
    g.appendChild(wrap);
    describe(wrap,
      "The hook is destroyed (grapple) or deflected (ball) on this surface instead of anchoring — drawn with a dashed steel edge. It stays solid: you can stand on it and the rope still wraps its corners. Per shape, so one piece of a compound body can be the only place a hook will catch.");
  }

  // What this piece collides with (see `CollisionObjectData.passes`), as one
  // ticked box per category. Per shape and not collapsed onto the body,
  // exactly as hook-proof is, because the cases it exists for are two pieces of
  // ONE body that answer differently: a wheel whose rim the player rolls and
  // whose hub winds the chain, a stool whose seat stops the player and whose
  // legs he walks between.
  //
  // Stated POSITIVELY here and negatively in the file (`passes` is the list of
  // what goes through) because the two readers want opposite things. An author
  // is looking at a piece and asking what it is in the way of, and three ticked
  // boxes is that question answered; a level file needs absent to mean the
  // ordinary case, or every piece ever authored would have to be rewritten each
  // time the engine gains a category.
  //
  // The `chain` box is what the "chain-through" checkbox was, inverted: one
  // mechanism now says both (`CollisionShape2D.wrappable` is the rope bit of
  // the mask), so it belongs beside its siblings rather than on its own.
  function addMaskFields(g: HTMLElement, items: EdItem[]): void {
    const wrap = fieldRow("collides with", "div");
    g.appendChild(wrap);
    for (const name of COLLISION_CATEGORIES) {
      const bit = COLLISION_CATEGORY_BITS[name];
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = items.every((b) => (b.mask & bit) !== 0);
      // A mixed selection says so rather than reporting one piece's answer as
      // the group's, exactly as hook-proof does.
      box.indeterminate = !box.checked && items.some((b) => (b.mask & bit) !== 0);
      box.addEventListener("change", () => {
        beginAction();
        for (const b of items) b.mask = box.checked ? b.mask | bit : b.mask & ~bit;
        markDirty();
        // The edge style is what says something passes through a piece, and it
        // is drawn from the item, so the canvas is already right; the panel is
        // rebuilt so the box loses its indeterminate state.
        rebuildInspector();
      });
      const cell = fieldRow(name, "label", "ed-field ed-sub");
      cell.appendChild(box);
      g.appendChild(cell);
    }
    describe(wrap,
      "What this piece is in the way of. Untick one and it passes straight through: the player walks between unticked legs, the hook flies past them, chains and ropes neither wrap their corners nor tie to them - drawn with a dotted edge. It still collides with the level, so it stands on the floor and carries its share of the body's weight. Per shape, so a stool's seat can stop the player while the legs it is welded to do not, and a wheel's hub can wind a chain while its rim is ignored.");
  }

  // A rail (see `CollisionObjectData.rail`): the ball's manacle clamps AROUND
  // this piece and slides along it, instead of biting its face. Per shape for
  // the reason hook-proof is, and the case it exists for is a body of both: a
  // lantern whose handles are rails and whose lid, bulb and base are
  // hook-proof. Mutually exclusive with hook-proof - ticking either unticks the
  // other - since a hook-proof rail is a bar the hook bounces off.
  function addRailField(g: HTMLElement, items: EdItem[]): void {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = items.every((b) => b.rail);
    box.indeterminate = !box.checked && items.some((b) => b.rail);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of items) {
        b.rail = box.checked;
        if (box.checked) b.impermeable = false;
        // A CIRCLE is a rod, and the cuff closes round no bar thicker than
        // its bore: ticked, a circle any fatter is shrunk to it rather than
        // left a rail the build ignores (`ROD_MAX_RADIUS`).
        if (box.checked && b.shape.kind === "circle") {
          b.shape = { kind: "circle", r: Math.min(b.shape.r, ROD_MAX_RADIUS) };
        }
      }
      markDirty();
      rebuildInspector();
    });
    const wrap = fieldRow("rail");
    wrap.appendChild(box);
    g.appendChild(wrap);
    describe(wrap,
      items.every((b) => b.shape.kind === "circle")
        ? `A rod running into the screen - a ladder's rung, a handle. The ball's manacle closes around it centred on its axis and turns freely about it, the chain swinging round it at any angle, instead of biting its face. No thicker than the cuff's bore (${(ROD_MAX_RADIUS * M2PX).toFixed(2)} px radius): ticking the box shrinks the circle to fit, and a fatter circle is bitten as a face. Solid for everything else.`
        : "The ball's manacle clamps around this bar and slides along it under the chain's pull, held by the body's friction (a zipline, a pipe, a lantern's handle) - drawn with a steel line down its middle, which is the curve itself and where the cuff rides. The cuff stops a half-width in from each end, and where it would meet a piece of the same body that is not part of this bar. Solid for everything else. A bar shorter than it is thick is a peg the ring hangs on without sliding.");
  }

  // Viscosity (see `CollisionObjectData.viscosity`): mud the ball's manacle
  // bites and then creeps through under the chain's pull, and how stiff it
  // is. A checkbox to make a face mud at all, with the number beside it while
  // it is one - ticking it is the common gesture, and the number is the
  // tuning. Per shape for the reason hook-proof is - a stone wall with one
  // mud patch is one body - and mutually exclusive with hook-proof, since a
  // hook-proof mud face is one the hook never bites.
  function addViscousField(g: HTMLElement, items: EdItem[]): void {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = items.every((b) => b.viscosity > 0);
    box.indeterminate = !box.checked && items.some((b) => b.viscosity > 0);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of items) {
        b.viscosity = box.checked ? 1 : 0;
        // A face that is not mud has no floor, and one left on it would come
        // back with the tick in this session but not after a reload, since
        // only mud writes it.
        if (!box.checked) b.slipFloor = 0;
        if (box.checked) b.impermeable = false;
      }
      markDirty();
      rebuildInspector();
    });
    const wrap = fieldRow("viscous");
    wrap.appendChild(box);
    g.appendChild(wrap);
    if (items.every((b) => b.viscosity > 0)) {
      numField(
        g,
        "viscosity",
        () => shared(items, (b) => b.viscosity),
        (v) => {
          for (const b of items) b.viscosity = Math.max(0.01, v);
        },
        0.1,
        items.length > 1,
      );
      const floor = numField(
        g,
        "slip floor",
        () => shared(items, (b) => b.slipFloor),
        (v) => {
          for (const b of items) b.slipFloor = Math.max(0, v);
        },
        50,
        items.length > 1,
      );
      describe(floor.parentElement!,
        "Newtons of pull the mud holds the cuff dead still under - static friction for mud. Above it the cuff creeps exactly as the viscosity says, as if there were no floor. 0 creeps under any pull. The hanging ball weighs about 510 N, so a floor above that is mud you can hang from for ever that a falling catch still drags the cuff through, and stops once the ball has been slowed to a hang.");
    }
    describe(wrap,
      "Mud: the ball's manacle bites this face and then creeps through it in the direction the chain pulls, faster the harder it pulls - a hanging ball draws it slowly toward itself, a falling ball caught on it drags it a long way before it is slowed to a hang - and it drops out once its mouth has crept clear of the geometry. The viscosity is how stiff the mud is: 1 is the reference mud, 2 needs twice the pull for the same creep, 0.5 half. Drawn with a dash-dot ochre edge. Solid for everything else: you can stand on it and the rope still wraps its corners.");
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
    num("bounce", (b) => propsOf(b).bounce, (b, v) => (propsOf(b).bounce = Math.min(1, Math.max(0, v))), 0.1);
    // A speed in px/s, like every other length per second on the panel. Never
    // negative: a surface that threw a body INTO itself is not a thing to
    // author, and the sign a force area and a current carry means direction,
    // which a launch takes from the contact normal instead.
    num("launch", (b) => propsOf(b).launch * M2PX, (b, v) => (propsOf(b).launch = Math.max(0, v) * PX), 50);
    // Live, and re-derived from the items rather than from the values the panel
    // was built with, for the same reason the spring's droop is: typing a launch
    // has to move the number the launch was typed FOR.
    const height = (): string => {
      const v = shared(leads, (b) => propsOf(b).launch);
      if (v === null) return "mixed";
      if (v <= 0) return "-";
      return `${((v * v) / (2 * 9.8)).toFixed(2)} m`;
    };
    const row = fieldRow("throws");
    const val = document.createElement("span");
    val.textContent = height();
    row.appendChild(val);
    g.appendChild(row);
    readouts.push({ el: val, get: height });
    describe(g,
      "A trampoline. Bounce is the fraction of an impact given back, so what lands gently leaves gently (0 is a dead surface, 1 a perfect bounce). Launch is the spring stored in the pad itself: a floor under the speed anything leaves at, whatever speed it arrived with, so a short drop onto it throws as far as a long one. Nothing can rest on a pad: anything that touches it, the ball on its chain and the hook included, is thrown at the full launch, and the hook never bites one. Both are read off both surfaces meeting and the bouncier wins.");
  }

  // Breakable geometry (see `LevelBodyData.breakForce`): what it takes to
  // destroy this body, and how many of those it survives.
  //
  // Beside the trampoline pair because it is the same sort of property - what
  // this surface is like to meet - and per BODY for the reason stated there: a
  // hit on any piece counts toward the one tally, because a compound crate's
  // pieces are one crate.
  //
  // THE READOUT IS THE POINT OF THE PANEL, exactly as the launch's height is. A
  // threshold in newtons is unauthorable on its own: nobody is choosing 6,000.
  // What an author is choosing is one of two things - "it holds a crate this
  // heavy" or "the ball has to come in this fast" - and both are one division
  // away, because a contact reports the weight it carries plus `m·Δv/dt` of
  // arrival (`cli breaks`, case `break-load`). So the panel says both, for the
  // ball this level is actually authored around.
  function addBreakFields(g: HTMLElement, num: GroupNum, leads: EdItem[]): void {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = leads.every((b) => propsOf(b).breakForce > 0);
    box.indeterminate = !box.checked && leads.some((b) => propsOf(b).breakForce > 0);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of leads) {
        // A fresh threshold is 6 kN: the ball arriving at about 6.4 m/s, or a
        // 600 kg resting load. Breakable but not fragile, and a number to tune
        // from rather than one that gives way to the first thing that touches
        // it (the readouts below say what it means as it is typed).
        propsOf(b).breakForce = box.checked ? 6000 : 0;
        propsOf(b).durability = 1;
      }
      markDirty();
      rebuildInspector();
    });
    const wrap = fieldRow("breakable");
    wrap.appendChild(box);
    g.appendChild(wrap);
    if (leads.every((b) => propsOf(b).breakForce > 0)) {
      num("threshold", (b) => propsOf(b).breakForce, (b, v) => (propsOf(b).breakForce = Math.max(1, v)), 1000);
      num(
        "durability",
        (b) => propsOf(b).durability,
        (b, v) => (propsOf(b).durability = Math.max(1, Math.round(v))),
        1,
      );
      // Live, and re-derived from the items rather than from the values the
      // panel was built with, for the reason the launch's height is: typing a
      // threshold has to move the numbers it was typed FOR.
      const ballMass = () => {
        const r = model.player.radius;
        return (4 / 3) * Math.PI * r * r * r * BallPlayer.DENSITY;
      };
      const holds = (): string => {
        const f = shared(leads, (b) => propsOf(b).breakForce);
        if (f === null) return "mixed";
        return `${(f / 9.8).toFixed(0)} kg`;
      };
      const arrives = (): string => {
        const f = shared(leads, (b) => propsOf(b).breakForce);
        if (f === null) return "mixed";
        const m = ballMass();
        // The ball's own weight is already on the face while it lands, so what
        // the arrival has to find is the rest.
        const v = (f - m * 9.8) / (m * 60);
        return v <= 0 ? "its own weight" : `${v.toFixed(1)} m/s`;
      };
      for (const [label, get] of [
        ["holds", holds],
        ["ball breaks it at", arrives],
      ] as const) {
        const row = fieldRow(label);
        const val = document.createElement("span");
        val.textContent = get();
        row.appendChild(val);
        g.appendChild(row);
        readouts.push({ el: val, get });
      }
    }
    describe(g,
      "Geometry that gives way. The threshold is how hard something has to hit this body to hurt it, in newtons, and the durability is how many such hits it survives before it breaks apart and is gone - in a shower of chunks that fade out, not as rubble you can stand on. Only impacts count: a body resting on it presses once, however long it sits there, and one sliding along it is not hitting it at all. Anything the chain is anchored to when it goes lets go of the chain. A body a scene chain or a vine hangs from cannot be breakable.");
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
    box.checked = leads.every((b) => propsOf(b).passable);
    // A mixed selection says so rather than reporting one body's answer as the
    // group's, exactly as the hook-proof and pivot checkboxes do.
    box.indeterminate = !box.checked && leads.some((b) => propsOf(b).passable);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of leads) propsOf(b).passable = box.checked;
      markDirty();
      // Rebuilt because the answer decides which OTHER fields the panel offers:
      // hook-only geometry carries no friction (nothing rests on it) and no
      // hook-proofing (it exists to be caught on).
      rebuildInspector();
    });
    const wrap = fieldRow("hook-only");
    wrap.appendChild(box);
    g.appendChild(wrap);
    describe(wrap,
      "Only the hook can find this body: the player walks and swings straight through it, loose bodies fall through it and the rope never wraps it — drawn with a grate lattice and a dotted edge, behind the solid geometry. A rigid one still falls, still hangs on its spring and is still hauled by a chain; what it stops having is contacts.");
  }

  // A ROOT that SPRINGS (docs/roots.md): one checkbox for what is otherwise
  // three edits - the body made rigid, mounted on a pivot, the bearing put at
  // the trunk's base, and a torsion return spring about it - because that is
  // the one thing a springy root is: a body hinged where it grows out of the
  // wall, bending under the player and coming back. Unticked, it is a static
  // root again. The Pivot section below it tunes the spring like any other.
  function addRootSpringField(g: HTMLElement, leads: EdItem[]): void {
    const box = document.createElement("input");
    box.type = "checkbox";
    const springs = (b: EdItem): boolean => propsOf(b).kind === "rigid" && propsOf(b).pivot;
    box.checked = leads.every(springs);
    box.indeterminate = !box.checked && leads.some(springs);
    box.addEventListener("change", () => {
      beginAction();
      setRootSprings(model, leads, box.checked);
      markDirty();
      rebuildInspector();
    });
    const wrap = fieldRow("springs");
    wrap.appendChild(box);
    g.appendChild(wrap);
    describe(wrap,
      "Hinge this root where its trunk grows from, on a torsion spring: it bends under the ball and comes back. The Pivot section tunes how stiff (return Hz) and how quickly it settles (damping). Unticked, the root is static. To spring one branch on its own, select it and press New body - it becomes a trunk where it stood - and tick this there.");
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
    box.checked = leads.every((b) => propsOf(b).pivot);
    // Mutually exclusive with a spring (see `addSpringFields`): a body that
    // could neither translate nor rotate is not a thing to author, so the two
    // controls lock each other out here rather than letting a file be saved
    // that the loader has to break the tie in.
    box.disabled = leads.some((b) => propsOf(b).springFreqX > 0 || propsOf(b).springFreqY > 0);
    // A mixed selection says so rather than reporting one body's answer as the
    // group's, exactly as the hook-proof checkbox does.
    box.indeterminate = !box.checked && leads.some((b) => propsOf(b).pivot);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of leads) propsOf(b).pivot = box.checked;
      markDirty();
      // Rebuilt so the box loses its indeterminate state.
      rebuildInspector();
    });
    const wrap = fieldRow("pivot");
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
        const members = bodyMembers(model.items, lead.unit).filter(
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
        const f = bodyFrameOf(model, lead.unit);
        return world.sub(f.pos).rotated(-f.rot);
      };
      const at = (b: EdItem): Vec2 => propsOf(b).pivotAt ?? comLocalOf(b);
      const setAt =
        (mut: (cur: Vec2, v: number) => Vec2) =>
        (v: number): void => {
          for (const b of leads) propsOf(b).pivotAt = mut(at(b), v);
        };
      const clearAt = (): void => {
        for (const b of leads) propsOf(b).pivotAt = null;
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
        () => shared(leads, (b) => propsOf(b).pivotFreq),
        (v) => {
          for (const b of leads) propsOf(b).pivotFreq = Math.min(MAX_SPRING_FREQ, Math.max(0, v));
        },
        0.1,
        leads.length > 1,
      );
      numField(
        g,
        "damping",
        () => shared(leads, (b) => propsOf(b).pivotDamping),
        (v) => {
          for (const b of leads) propsOf(b).pivotDamping = Math.min(1, Math.max(0, v));
        },
        0.05,
        leads.length > 1,
        { disabled: !leads.some((b) => propsOf(b).pivotFreq > 0) },
      );

    }

    describe(g, box.checked
      ? "Bolted to a bearing: the body swings about the pivot point (blank = the centre of mass, where gravity has no leverage) and never translates. An off-centre bearing feels gravity - an unbalanced body hangs from it - and a return frequency makes it a branch: it bends away under a load and springs back to its authored angle when the load leaves."
      : "Bolted to a bearing at the centre of mass: the body spins freely when torque is applied - a landing, a hook, a chain - but never moves from where it is authored. Gravity does not pull it down.");
  }

  // SCRIPTED MOTION, static bodies only: the pendulum on a bearing
  // (`LevelBodyData.swingAmp`), the rotor on the same bearing (`spinPeriod`) and
  // the body that travels a route (`moveNodes`). All on one panel because they
  // are the same kind of thing - a static the LEVEL drives rather than one the
  // solver owns - and because they compose on one body, which is a windmill
  // bolted to a travelling cart.
  //
  // A static rather than a rigid, and the panel says which by simply not being
  // offered elsewhere: a `rigid` body wanting to turn about a bearing has
  // `pivot`, which is the PHYSICAL pendulum - gravity swings it, a load on the
  // end changes the swing, and it eventually comes to hang. This one is driven,
  // so nothing in the level can disturb it, which is what a rhythm an author is
  // timing a jump against has to be.
  function addMoverFields(g: HTMLElement, leads: EdItem[]): void {
    // A body's route and its speed readout are the BODY's, not a collision
    // object's, so what decides whether they can be shown is how many bodies are
    // selected rather than how many leads there are - a compound body has
    // several leads and exactly one route. (`numField`'s `mixable` is the other
    // question and stays per lead: it only picks the placeholder.)
    const bodyIds = new Set(leads.map((b) => b.unit));
    const one = bodyIds.size === 1 ? leads[0]! : null;
    const swinging = (b: EdItem): boolean => propsOf(b).swingAmp !== 0 && propsOf(b).swingPeriod > 0;
    const spinning = (b: EdItem): boolean => propsOf(b).spinPeriod !== 0;
    const travelling = (b: EdItem): boolean => propsOf(b).route.length > 1 && propsOf(b).moveSpeed > 0;
    const anySwing = leads.some(swinging);
    const anySpin = leads.some(spinning);
    const anyTurn = anySwing || anySpin;
    const anyRoute = leads.some((b) => propsOf(b).route.length > 1);

    // Three fields below appear and disappear with whether the body turns at all
    // - the two phases and the bearing they share - so a value typed into any of
    // the motions has to rebuild the panel rather than only revalue it.
    const rebuildIfTurnChanged = (): void => {
      if (leads.some(swinging) !== anySwing || leads.some(spinning) !== anySpin) {
        rebuildInspector();
      }
    };

    // Degrees, like every other angle the inspector shows - the model and the
    // file hold radians (see `LevelBodyData.swingAmp`).
    numField(
      g,
      "swing °",
      () => {
        const v = shared(leads, (b) => propsOf(b).swingAmp);
        return v === null ? null : (v * 180) / Math.PI;
      },
      (v) => {
        for (const b of leads) propsOf(b).swingAmp = (Math.min(180, Math.max(-180, v)) * Math.PI) / 180;
        rebuildIfTurnChanged();
      },
      1,
      leads.length > 1,
      { placeholder: "still" },
    );
    numField(
      g,
      "swing s",
      () => shared(leads, (b) => propsOf(b).swingPeriod),
      (v) => {
        for (const b of leads) propsOf(b).swingPeriod = Math.max(0, v);
        rebuildIfTurnChanged();
      },
      0.5,
      leads.length > 1,
      { placeholder: "still" },
    );
    if (anySwing) {
      // In CYCLES, which is the whole point of the field: a row of pendulums at
      // 0, 0.25, 0.5 is the interleaving an author means, and nobody has to
      // divide by 2π to write it.
      numField(
        g,
        "swing phase",
        () => shared(leads, (b) => propsOf(b).swingPhase),
        (v) => {
          for (const b of leads) propsOf(b).swingPhase = v;
        },
        0.125,
        leads.length > 1,
      );
    }

    // The ROTOR: the seconds of one full turn, SIGNED, which is the whole of its
    // authored motion (see `LevelBodyData.spinPeriod`). Not clamped positive the
    // way the swing's beat is, because here the sign is the direction and
    // throwing it away would be a blade that will only turn one way.
    numField(
      g,
      "spin s",
      () => shared(leads, (b) => propsOf(b).spinPeriod),
      (v) => {
        for (const b of leads) propsOf(b).spinPeriod = v;
        rebuildIfTurnChanged();
      },
      0.5,
      leads.length > 1,
      { placeholder: "still" },
    );
    if (anySpin) {
      numField(
        g,
        "spin phase",
        () => shared(leads, (b) => propsOf(b).spinPhase),
        (v) => {
          for (const b of leads) propsOf(b).spinPhase = v;
        },
        0.125,
        leads.length > 1,
      );
    }
    // ONE bearing for both, because it is one point: a body that swings and one
    // that spins turn about the same authored hinge (see `LevelBodyData.pivotX`),
    // and offering the fields twice would be two names for it.
    if (anyTurn) addBearingFields(g, leads);

    // The route. A speed rather than a duration (see `LevelBodyData.moveSpeed`),
    // in the file's px/s like every other length, so re-drawing a route makes
    // the trip longer rather than the platform faster.
    //
    // Shown INERT and reading `keyed` where a node keys a speed, the same way a
    // camera path's path-level field is once a node keys it: its value is read
    // only on the stretches nothing keys, and a live dial that governs some of a
    // route and not the rest is a dial that says the wrong thing.
    const speedKeyed = keyedRouteNodes(leads, "speed");
    const speedInput = numField(
      g,
      "speed",
      () => (speedKeyed ? NaN : shared(leads, (b) => propsOf(b).moveSpeed * M2PX)),
      (v) => {
        for (const b of leads) propsOf(b).moveSpeed = Math.max(0, v) * PX;
        refreshFields();
      },
      10,
      leads.length > 1,
      {
        placeholder: speedKeyed ? "keyed" : anyRoute ? "still" : "draw a route first",
        disabled: !anyRoute || speedKeyed !== null,
      },
    );
    if (speedKeyed) speedInput.title = speedKeyed;

    if (anyRoute) {
      numField(
        g,
        "move phase",
        () => shared(leads, (b) => propsOf(b).movePhase),
        (v) => {
          for (const b of leads) propsOf(b).movePhase = v;
        },
        0.125,
        leads.length > 1,
      );
      // The MODE, which is the one thing that decides what a route means (see
      // `MoveMode`): travelled there and back, gone round for ever, or run once
      // and teleported home. The ease belongs to the two that have ends - a lap
      // has none to ease at - so picking `loop` disables it rather than leaving
      // a control that says nothing.
      picker(
        g,
        "mode",
        MOVE_MODES,
        MOVE_MODE_LABELS,
        leads,
        (b) => propsOf(b).moveMode,
        (b, v) => {
          propsOf(b).moveMode = v;
        },
        true,
      );
      const easeSel = picker(
        g,
        "ease",
        MOVE_EASES,
        null,
        leads,
        (b) => propsOf(b).moveEase,
        (b, v) => {
          propsOf(b).moveEase = v;
        },
        false,
      );
      easeSel.disabled = leads.some((b) => !moveModeEases(propsOf(b).moveMode));

      // Whether the route AIMS the body. A checkbox rather than a keyed field
      // because it is a statement about the whole route: either the track
      // decides which way the body faces or the drawn angle does, and a node
      // keying its own answer to that would be a cart that detaches from its
      // rails half way along (see `LevelBodyData.moveAlign`).
      checkField(g, "align", leads, (b) => propsOf(b).moveAlign, (b, v) => {
        propsOf(b).moveAlign = v;
      });

      // What the route IS, since the canvas draws it but nothing on the panel
      // otherwise says how long the trip is - which is the number a speed has to
      // be picked against. With a keyed speed the seconds come from the route's
      // own time table rather than from a division, which is exactly the point
      // of keying one.
      const trip = (): string => {
        if (!one) return "mixed";
        const route = routeOf(model, one);
        const legs = `${propsOf(one).route.length} nodes, ${(route.total * M2PX).toFixed(0)} px`;
        return route.traverse > 0 && propsOf(one).moveSpeed > 0
          ? `${legs}, ${route.traverse.toFixed(1)} s`
          : legs;
      };
      const trow = fieldRow(one && moveModeCloses(propsOf(one).moveMode) ? "lap" : "trip");
      const tval = document.createElement("span");
      tval.textContent = trip();
      trow.appendChild(tval);
      g.appendChild(trow);
      readouts.push({ el: tval, get: trip });
    }

    // The gesture that STARTS a route, which the canvas cannot offer: an empty
    // route has no node to drag and no leg to insert into, so there is nothing
    // on screen to press. Past the first one the canvas is where a route is
    // shaped - drag a node, click a midpoint to add one, Alt+click to remove
    // one, drag a round grip to bow a leg - and this row goes on offering the
    // append because reaching the far end of a long route by halving legs is
    // miserable.
    if (one) {
      const lead = one;
      const row = el("div", "ed-row");
      row.appendChild(
        button(propsOf(lead).route.length ? "+ node" : "draw a route", () => {
          beginAction();
          // A metre on from wherever the route currently ends, along the leg it
          // arrived by - so appending twice draws a straight run rather than
          // stacking two nodes on one point. A route that does not exist yet is
          // the body plus one, which is the shortest thing that is a route.
          const frame = bodyFrameOf(model, lead.unit);
          const pts = propsOf(lead).route.length ? routeWorldPoints(model, lead) : [frame.pos];
          const last = pts[pts.length - 1]!;
          const prev = pts.length > 1 ? pts[pts.length - 2]! : last.sub(new Vec2(1, 0));
          const dir = last.sub(prev);
          const step = dir.length() > 1e-9 ? dir.normalized() : new Vec2(1, 0);
          const next = propsOf(lead).route.length ? [...propsOf(lead).route] : [routeNode(Vec2.ZERO)];
          next.push(routeNode(last.add(step).sub(frame.pos).rotated(-frame.rot)));
          propsOf(lead).route = next;
          // A route with no speed never moves, so the first node brings one
          // rather than leaving a body that has a route and stands still.
          if (propsOf(lead).moveSpeed <= 0) propsOf(lead).moveSpeed = 0.5;
          markDirty();
          rebuildInspector();
        }),
      );
      if (propsOf(lead).route.length > 1) {
        // The two curve gestures, which are the camera path's own (`Smooth` /
        // `Sharpen`) doing the same thing to the same kind of node list: a route
        // is a Bezier curve and a corner is a route whose handles are zero, so
        // rounding every corner at once and dropping every tangent at once are
        // the two ends an author works between. Shaping ONE leg is a grip drag
        // on the canvas.
        row.appendChild(
          button("smooth", () => {
            beginAction();
            const t = smoothTangents(
              propsOf(lead).route.map((n) => n.p),
              moveModeCloses(propsOf(lead).moveMode),
            );
            propsOf(lead).route = propsOf(lead).route.map((n, i) => ({ ...n, in: t[i]!.in, out: t[i]!.out }));
            markDirty();
            rebuildInspector();
          }),
        );
        row.appendChild(
          button("sharpen", () => {
            beginAction();
            propsOf(lead).route = propsOf(lead).route.map((n) => ({ ...n, in: Vec2.ZERO, out: Vec2.ZERO }));
            markDirty();
            rebuildInspector();
          }),
        );
        row.appendChild(
          button("clear route", () => {
            beginAction();
            propsOf(lead).route = [];
            clearRouteSel();
            markDirty();
            rebuildInspector();
          }),
        );
      }
      g.appendChild(row);
    }

    // The one number a mover can get WRONG without anything saying so: how fast
    // its surface crosses a frame. Past about 2 cm the character sweep resolves
    // against a surface that has already crossed the avatar (see `MoverScript`),
    // and the failure is a player shoved through geometry in one corner of one
    // level. Derived from the authored fields rather than measured, so it is
    // live while the fields are being typed into.
    if (anyTurn || leads.some(travelling)) {
      const speed = (): string => {
        if (!one) return "mixed";
        const cm = peakSurfaceSpeed(model, one) * 100;
        return `${cm.toFixed(2)} cm/frame${cm > 2 ? " - TOO FAST" : ""}`;
      };
      const srow = fieldRow("surface");
      const sval = document.createElement("span");
      sval.textContent = speed();
      srow.appendChild(sval);
      g.appendChild(srow);
      readouts.push({ el: sval, get: speed });
    }

    // The picked nodes' own fields, under the route's, exactly where a camera
    // path's node keys sit under its path-level ones - and reached the same way,
    // by clicking a node on the canvas.
    const pickedNodes = one ? selectedRouteNodes(one) : [];
    if (one && pickedNodes.length && propsOf(one).route.length > 1) {
      buildRouteNodeKeys(g, one, pickedNodes);
    }

    describe(g, anyTurn || anyRoute
      ? "Driven by the level rather than by the solver: nothing in the scene can disturb it, and it carries whatever rides it. A route is drawn on the canvas - drag a node to move it, the small handles between them to add one, Alt+click to remove one, a round grip to bow a leg; the body itself is node zero. Click a node to key its angle or its speed there (Shift picks out several); Delete removes the picked nodes, the arrows nudge them and Esc drops them. Keep the surface speed under 2 cm/frame."
      : "A static that MOVES. A swing angle and a beat make it a pendulum about its bearing; a spin time makes it a rotor that turns about the same bearing for ever, negative the other way round; a route drawn on the canvas makes it a platform, travelled there and back, round and round, or run and repeated. Nothing in the level can disturb any of them, which is what lets a jump be timed against it.");
  }

  // Which nodes of the selected routes key `field`, as the sentence the inert
  // route-level input wears in its tooltip - or null when none do.
  //
  // The camera path's `keyedAt` asked of a path's `shape.keys`; this asks of a
  // body's route, and both are here for the same reason: a route-level value
  // that some of the route overrides is a value the panel must stop offering as
  // if it governed the whole thing.
  function keyedRouteNodes(leads: readonly EdItem[], field: "rot" | "speed"): string | null {
    const bodies = new Map<string, number[]>();
    for (const b of leads) {
      if (bodies.has(b.unit)) continue;
      const at = propsOf(b).route.flatMap((n, i) => (n[field] !== null ? [i] : []));
      if (at.length) bodies.set(b.unit, at);
    }
    if (bodies.size === 0) return null;
    const one = bodies.size === 1;
    const parts = [...bodies].map(([id, at]) =>
      one ? at.join(", ") : `#${id}:${at.join(",")}`,
    );
    return `keyed at node${one && bodies.values().next().value!.length === 1 ? "" : "s"} ${parts.join("  ")}`;
  }

  // The picked route nodes' keys: what the body's angle and its speed ARE where
  // those nodes sit (see `MoveNodeData`).
  //
  // Blank is no key, and the placeholder is the value the node has anyway - the
  // route's own where nothing keys the field, the interpolation's where other
  // nodes do, computed through the very route the sim builds (`routeOf`) - so
  // typing a key starts from what it is replacing rather than from a zero that
  // is not what is happening there.
  function buildRouteNodeKeys(g: HTMLElement, item: EdItem, picked: number[]): void {
    g = section(g, "body/Mover/Node", picked.length === 1 ? `Node ${picked[0]}` : `${picked.length} nodes`);
    describe(g,
      "Where the body is on the route decides these. A node that carries one keys that field only; between two keys the value is eased by distance along the route, and before the first and past the last it holds. Blank drops the key.");

    const route = routeOf(model, item);
    const at = (i: number): number => route.index.nodeS[i] ?? 0;
    const effAngle = (i: number): number => moveAngleAt(route, propsOf(item).moveAlign, at(i));
    // Both read the route the SIM builds rather than a track assembled here: a
    // `loop` repeats node zero's key at the far end of the arc length, and a
    // second construction that forgot to would offer a placeholder the motion
    // disagrees with (see `MoveRoute.speedKeys`).
    const effSpeed = (i: number): number =>
      keyValueAt(route.speedKeys, at(i), propsOf(item).moveSpeed);

    // Every angle the inspector shows is in degrees and every length in the
    // file's pixels, so the keys are too - the model holds radians and metres.
    //
    // The placeholders are rounded to what the field can SHOW: a numeric input
    // is 64px of monospace, so `fmt`'s three decimals put "-173.336" half
    // outside it, and a placeholder that has to be selected to be read is worse
    // than a coarser one. A tenth of a degree and a whole pixel per second are
    // finer than either dial is authored at anyway.
    field("angle °", "rot", (v) => (v * 180) / Math.PI, (v) => (v * Math.PI) / 180, effAngle, 5, 1);
    field("speed", "speed", (v) => v * M2PX, (v) => Math.max(0, v) * PX, effSpeed, 10, 0);

    function field(
      label: string,
      key: "rot" | "speed",
      show: (model: number) => number,
      store: (shown: number) => number,
      effective: (node: number) => number,
      step: number,
      // Decimals the placeholder is rounded to, so it fits the input.
      places: number,
    ): void {
      const eff = picked.map((i) => show(effective(i)));
      const agreed = eff.every((v) => Math.abs(v - eff[0]!) < 1e-9)
        ? eff[0]!.toFixed(places)
        : "mixed";
      numField(
        g,
        label,
        () => {
          const vals = picked.map((i) => propsOf(item).route[i]?.[key] ?? null);
          if (vals.some((v) => v === null)) return null;
          const first = show(vals[0]!);
          return vals.every((v) => Math.abs(show(v!) - first) < 1e-9) ? first : null;
        },
        (v) => {
          for (const i of picked) {
            const n = propsOf(item).route[i];
            if (n) n[key] = store(v);
          }
          refreshFields();
        },
        step,
        true,
        {
          placeholder: agreed,
          onEmpty: () => {
            for (const i of picked) {
              const n = propsOf(item).route[i];
              if (n) n[key] = null;
            }
          },
        },
      );
    }
  }

  // A one-of-N `<select>` over a group of bodies, with a blank `mixed` entry
  // while they disagree. The mover panel's mode and ease pickers are the same
  // control twice, and the pair was written out twice before there were three
  // of them to keep in step.
  function picker<T extends string>(
    parent: HTMLElement,
    label: string,
    values: readonly T[],
    // Display names where the stored name is not what an author should read;
    // null uses the value itself.
    labels: Readonly<Record<string, string>> | null,
    leads: EdItem[],
    get: (b: EdItem) => T,
    set: (b: EdItem, v: T) => void,
    // Does changing this change what the rest of the panel offers?
    rebuild: boolean,
  ): HTMLSelectElement {
    const wrap = fieldRow(label);
    const sel = document.createElement("select");
    sel.className = "ed-select";
    const agreed = leads.every((b) => get(b) === get(leads[0]!)) ? get(leads[0]!) : null;
    if (!agreed) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "mixed";
      sel.appendChild(o);
    }
    for (const v of values) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = labels?.[v] ?? v;
      sel.appendChild(o);
    }
    sel.value = agreed ?? "";
    sel.addEventListener("change", () => {
      if (!sel.value) return;
      beginAction();
      for (const b of leads) set(b, sel.value as T);
      markDirty();
      if (rebuild) rebuildInspector();
      else refreshFields();
    });
    wrap.appendChild(sel);
    parent.appendChild(wrap);
    return sel;
  }

  // ...and a checkbox over the same group, indeterminate while they disagree.
  function checkField(
    parent: HTMLElement,
    label: string,
    leads: EdItem[],
    get: (b: EdItem) => boolean,
    set: (b: EdItem, v: boolean) => void,
  ): void {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = leads.every(get);
    box.indeterminate = !box.checked && leads.some(get);
    box.addEventListener("change", () => {
      beginAction();
      for (const b of leads) set(b, box.checked);
      markDirty();
      rebuildInspector();
    });
    const wrap = fieldRow(label);
    wrap.appendChild(box);
    parent.appendChild(wrap);
  }

  // The bearing a pendulum turns about, which is the rigid pivot's own pair of
  // fields (`LevelBodyData.pivotX`) because it is the same point - so the two
  // panels offer it through one function rather than each writing its own idea
  // of what "blank means the centre of mass" is.
  function addBearingFields(g: HTMLElement, leads: EdItem[]): void {
    const comLocalOf = (lead: EdItem): Vec2 => {
      const members = bodyMembers(model.items, lead.unit).filter((m) => m.object === "collision");
      let mass = 0;
      let acc = Vec2.ZERO;
      for (const m of members) {
        const kg = shapeMass(m);
        mass += kg;
        acc = acc.add(m.pos.mul(kg));
      }
      const world = mass > 0 ? acc.div(mass) : (members[0]?.pos ?? Vec2.ZERO);
      const f = bodyFrameOf(model, lead.unit);
      return world.sub(f.pos).rotated(-f.rot);
    };
    const at = (b: EdItem): Vec2 => propsOf(b).pivotAt ?? comLocalOf(b);
    const setAt =
      (mut: (cur: Vec2, v: number) => Vec2) =>
      (v: number): void => {
        for (const b of leads) propsOf(b).pivotAt = mut(at(b), v);
        refreshFields();
      };
    const clearAt = (): void => {
      for (const b of leads) propsOf(b).pivotAt = null;
      refreshFields();
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
    const sprung = (b: EdItem): boolean => propsOf(b).springFreqX > 0 || propsOf(b).springFreqY > 0;
    const anySprung = leads.some(sprung);
    const anyPivot = leads.some((b) => propsOf(b).pivot);

    const freq = (label: string, get: (b: EdItem) => number, set: (b: EdItem, v: number) => void) =>
      numField(
        g,
        label,
        () => shared(leads, get),
        (v) => {
          for (const b of leads) set(b, Math.min(MAX_SPRING_FREQ, Math.max(0, v)));
          // The pivot checkbox's enabled state depends on these, and the axle
          // ring is drawn from the item - so a frequency typed in has to rebuild
          // the panel rather than only revalue it.
          if (leads.some(sprung) !== anySprung) rebuildInspector();
        },
        0.1,
        leads.length > 1,
        { disabled: anyPivot },
      );
    freq("spring x (Hz)", (b) => propsOf(b).springFreqX, (b, v) => (propsOf(b).springFreqX = v));
    freq("spring y (Hz)", (b) => propsOf(b).springFreqY, (b, v) => (propsOf(b).springFreqY = v));
    numField(
      g,
      "damping",
      () => shared(leads, (b) => propsOf(b).springDamping),
      (v) => {
        for (const b of leads) propsOf(b).springDamping = Math.min(1, Math.max(0, v));
      },
      0.05,
      leads.length > 1,
      { disabled: anyPivot || !anySprung },
    );

    // Live, and re-derived from the items rather than from the values the panel
    // was built with, for the same reason the mass readout is: typing a
    // frequency has to move the number the frequency was typed FOR.
    const droop = (): string => {
      const f = shared(leads, (b) => propsOf(b).springFreqY);
      if (f === null) return "mixed";
      if (f <= 0) return "pinned";
      const w = 2 * Math.PI * f;
      return `${((9.8 / (w * w)) * 100).toFixed(1)} cm`;
    };
    const hang = (): string => {
      const f = shared(leads, (b) => propsOf(b).springFreqY);
      if (f === null) return "mixed";
      if (f <= 0) return "pinned";
      const w = 2 * Math.PI * f;
      // Every collision piece of every selected body: the spring pulls on the
      // body's whole mass, not on the piece whose panel this is.
      const kg = leads.reduce(
        (m, lead) =>
          m +
          bodyMembers(model.items, lead.unit)
            .filter((x) => x.object === "collision")
            .reduce((a, x) => a + shapeMass(x), 0),
        0,
      );
      if (kg <= 0) return "—";
      const ballKg = new BallPlayer(model.player.radius * BallLevel.BALL_RADIUS_SCALE).mass;
      return `+${(((ballKg * 9.8) / (kg * w * w)) * 100).toFixed(1)} cm`;
    };
    for (const [label, get] of [["droop", droop], ["+ the ball hanging", hang]] as const) {
      const row = fieldRow(label);
      const val = document.createElement("span");
      val.textContent = get();
      row.appendChild(val);
      g.appendChild(row);
      readouts.push({ el: val, get });
    }

    describe(g,
      "Held at the authored position by a spring per axis, so the body sags under its own weight and further under a load — a hanging player, a resting rock, a chain — then springs back past its rest height before settling. 0 on an axis pins that axis instead (a leaf that only bobs vertically). Frequency, not stiffness: the droop under its own weight is the same whatever the body is made of, while a heavier body notices a hung player less. A spring body cannot rotate, so it cannot also be pivot-mounted.");
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
    const mw = fieldRow("physics material");
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
    for (const name of [...MATERIAL_NAMES, CUSTOM_MATERIAL]) {
      const o = document.createElement("option");
      o.value = name;
      // The name alone: the picker is as wide as the panel and no wider, and
      // "aluminium · 2700 kg/m³" clips in it. The density it stands for is the
      // field below it.
      o.textContent = name;
      // `custom` is what a TYPED density makes the material, never a pick:
      // there is no density for it to set.
      if (name === CUSTOM_MATERIAL) o.disabled = true;
      ms.appendChild(o);
    }
    ms.value = sharedMaterial ?? "";
    // A material is a PRESET density (`CollisionObjectData.density`): picking
    // one sets the density to its own.
    ms.addEventListener("change", () => {
      if (!ms.value || ms.value === CUSTOM_MATERIAL) return;
      beginAction();
      const name = ms.value as MaterialName;
      for (const b of items) {
        b.material = name;
        b.density = MATERIALS[name];
      }
      markDirty();
      refreshFields();
    });
    mw.appendChild(ms);
    g.appendChild(mw);

    const sw = fieldRow("sound material");
    const ss = document.createElement("select");
    ss.className = "ed-select";
    const sharedSound = items.every(b => (b.soundMaterial ?? "auto") === (items[0]!.soundMaterial ?? "auto"))
      ? items[0]!.soundMaterial ?? "auto" : null;
    if (sharedSound === null) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "mixed";
      ss.appendChild(option);
    }
    for (const value of ["auto", ...SOUND_MATERIALS] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "auto" ? "automatic (surface behaviour)" : value;
      ss.appendChild(option);
    }
    ss.value = sharedSound ?? "";
    ss.addEventListener("change", () => {
      if (!ss.value) return;
      beginAction();
      for (const item of items) item.soundMaterial = ss.value as SoundMaterial;
      markDirty();
      refreshFields();
    });
    sw.appendChild(ss);
    g.appendChild(sw);

    // ...and the density itself is editable: typing one makes the material
    // `custom`, the picker showing so as it is typed rather than once the
    // panel is next rebuilt.
    numField(
      g,
      "density",
      () => shared(items, (b) => b.density),
      (v) => {
        if (!(v > 0)) return;
        for (const b of items) {
          b.density = v;
          b.material = CUSTOM_MATERIAL;
        }
        ms.value = CUSTOM_MATERIAL;
      },
      50,
      items.length > 1,
    );

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
    const row = fieldRow(items.length > 1 ? "total mass" : "mass");
    const val = document.createElement("span");
    val.textContent = mass();
    row.appendChild(val);
    g.appendChild(row);
    readouts.push({ el: val, get: mass });
    describe(g,
      "Physics material sets a density preset. Sound material independently chooses impact and sliding sounds; automatic uses surface behaviour, never density. Set it to ivy for leafy attachment sounds. Both are per shape, including pieces of a compound body. Mass is area × thickness × density; sound material does not change physics.");
  }

  // Debug geometry (see `CollisionObjectData.debug`): whether the shape is drawn
  // in 3D, in the game as here, and how. One checkbox is the whole switch -
  // ticking it is the common gesture, and a piece ticked on is drawn as itself
  // (the body's colour, the shape's thickness, opaque) before anything is
  // tuned. The settings are offered whether it is on or not: unticking keeps
  // them, so a piece switched back on comes back as it was, and an unticked
  // piece can be tuned ahead of switching it on, or while the toolbar's "all
  // debug" draws it (`allDebugShown`).
  function addDebugFields(g: HTMLElement, items: EdItem[]): void {
    const write = (patch: Partial<EdDebug>): void => {
      for (const b of items) b.debug = { ...b.debug, ...patch };
    };
    const allOn = items.every((b) => b.debug.on);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = allOn;
    box.indeterminate = !allOn && items.some((b) => b.debug.on);
    box.addEventListener("change", () => {
      beginAction();
      write({ on: box.checked });
      markDirty();
    });
    const wrap = fieldRow("draw");
    wrap.appendChild(box);
    g.appendChild(wrap);
    describe(wrap,
      "Draws this shape in 3D, in the game and in ▶ Test as well as here: its outline extruded through the depth, in a flat colour. It is an instrument, not a look - what a level is blocked out in before it has a look, or what a piece the look has nothing over is seen by. G hides every shape's debug geometry at once while playing. The settings below apply whenever it is drawn, and unticking keeps them.");

    // The colour, or the body's own fill while none is picked.
    const cw = fieldRow("colour");
    const ci = colorInput(items[0]!.debug.color ?? items[0]!.color, beginAction, (hex) => {
      write({ color: hex });
      markDirty();
    });
    cw.appendChild(ci.el);
    if (items.some((b) => b.debug.color !== null)) {
      cw.appendChild(
        button("body colour", () => {
          beginAction();
          write({ color: null });
          markDirty();
          rebuildInspector();
        }),
      );
    }
    g.appendChild(cw);
    numField(
      g,
      "opacity",
      () => shared(items, (b) => b.debug.opacity),
      (v) => write({ opacity: Math.min(1, Math.max(0, v)) }),
      0.1,
      items.length > 1,
    );
    // A length like the thickness it defaults to, so authored in pixels. Blank
    // is "the shape's own thickness", which follows that field as it changes;
    // the placeholder is that thickness as a number, which is all the field
    // has room for, and the row's help says what it is.
    const depth = numField(
      g,
      "depth",
      // Blank while any is on the default, as well as while they disagree.
      () => (items.some((b) => b.debug.depth === null) ? null : shared(items, (b) => b.debug.depth! * M2PX)),
      (v) => write({ depth: Math.max(1, v) * PX }),
      10,
      items.length > 1,
      {
        placeholder: items.every((b) => b.thickness === items[0]!.thickness)
          ? fmtOrBlank(items[0]!.thickness * M2PX)
          : "mixed",
        onEmpty: () => write({ depth: null }),
      },
    );
    describe(depth.parentElement!,
      "How deep the debug geometry is drawn through z, in pixels. Blank draws it as deep as the shape's own thickness (the Material section), and follows that as it changes; a number here changes the drawing only, never the mass.");
  }

  // Every layer's panel ends the same way: the actions that apply to any
  // selection, whatever it is made of. Duplicate, Flip H and Delete act on the *whole*
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
    const flip = button("Flip H", () => flipSelectedH());
    flip.title =
      "Mirror the selection left-for-right about its own middle: shapes, curves, routes, lights, pushes and currents all turn round, so a route built to go right goes left. Library models keep their own handedness and are turned instead.";
    row.append(
      button("Duplicate", () => duplicateSelected()),
      flip,
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
  // A LOOK is not here at all: what a body looks like is what it carries (a
  // formation, a model), so a collision shape has none to edit.
  function buildBodyGroup(bodies: EdItem[]): void {
    const g = el("div", "ed-group");
    // Named for what it IS. A panel headed "Body #12" on something that is one
    // object inside a body is the same confusion in the title bar.
    const title = heading(
      bodies.length === 1 ? `Collision #${bodies[0]!.id}` : `${bodies.length} collision shapes selected`,
      bodies.length > 1
        ? "Edits apply to all of them. Shift+click adds or removes; rubber-band left→right encloses, right→left touches."
        : undefined,
    );
    g.appendChild(title);

    // A body's properties are held once, on its node: nothing to keep in step.
    const sync = (): void => {};
    const transform = section(g, "object/Transform", "Transform");
    const placeNum = groupNum(transform, bodies, sync);
    addTransformFields(transform, placeNum, bodies);
    // Hook-proof, offered for the solid kinds it means something on: an area is
    // a region the rope passes through, and a hook-only body exists to be caught
    // on, so neither has a hook to repel.
    if (bodies.every((b) => (propsOf(b).kind === "static" || propsOf(b).kind === "rigid") && !propsOf(b).passable)) {
      const surface = section(g, "object/Surface", "Surface");
      addImpermeableField(surface, bodies);
      addViscousField(surface, bodies);
      // Only a CURVE may be a rail: a rail's centreline is the line the author
      // drew, and there is none to ride on a box or a vertex loop (see
      // `CollisionObjectData.rail`). Offered elsewhere it is a checkbox that
      // writes a field the loader ignores.
      // A ROOT is bitten, never clamped round: it tapers, and a rail rides a
      // bar of one width (docs/roots.md).
      // A CIRCLE may be one too: a rod, a rail running through the plane,
      // which the plane cuts as that circle (`lib/rod.ts`). Offered on a
      // selection of one kind, since the two are different things to tick.
      if (
        bodies.every((b) => b.shape.kind === "path" && !isRootItem(b)) ||
        bodies.every((b) => b.shape.kind === "circle")
      ) {
        addRailField(surface, bodies);
      }
      addMaskFields(surface, bodies);
    }
    // Material and thickness are what a shape WEIGHS.
    if (!bodies.some(massless)) addMaterialFields(section(g, "object/Material", "Material"), bodies);
    // A belt draws its own band (see `mountBelt`), so it has no debug geometry.
    if (bodies.every((b) => b.shape.kind !== "belt")) addDebugFields(section(g, "object/Debug", "Debug"), bodies);

    addGroupSection(g, title);
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
  // group may span layers - a light welded to the body it hangs on is the
  // case - and a Group button that silently left the panels out of it would be
  // making a different body than the one on screen. Gated like the actions row:
  // a cross-layer selection carries one shared section above the per-layer
  // panels instead of the same buttons repeated in each of them.
  // What it says about the body goes on `title`, the heading of the panel the
  // buttons sit under.
  function addGroupSection(g: HTMLElement, title: HTMLElement): void {
    if (selectionSpansLayers) return;
    appendGroupSection(g, title);
  }
  function appendGroupSection(g: HTMLElement, title: HTMLElement): void {
    const sel = selectedBodies();
    // Nodes picked in the scene tree count here too, as the canvas's do.
    const bodies = new Set(selectedBodyIds.size ? selectedBodyIds : sel.map((b) => b.unit));
    const row = el("div", "ed-row");
    // New body is offered while anything selected is not a body already: the
    // pieces go under one new body, each where it stands. Taking a body apart
    // is dragging its pieces out of it in the scene tree.
    if (selectionNodes().some((id) => !model.tree.nodes.get(id)?.body)) {
      const b = button("New body", () => newBodyFromSelection());
      b.title = "Put these under a new static body, each where it stands: one compound body";
      row.appendChild(b);
    }
    if (selectedJoinBodies().length >= 2) {
      const b = button("Join", () => joinSelection());
      b.title =
        "Fold these bodies into the first one selected, keeping its settings (Ctrl+J): pieces of the same surface that overlap or share an edge become one outline";
      row.appendChild(b);
    }
    {
      const grouped = selectionNodes().some((id) => model.tree.nodes.get(id)?.grouped);
      const b = button(grouped ? "Ungroup" : "Group", () => (grouped ? ungroupSelection() : groupSelection()));
      b.title = grouped ? "A click on the canvas no longer selects this as one (Ctrl+Shift+G)" : "A click on the canvas selects this as one first (Ctrl+G)";
      row.appendChild(b);
    }
    if (row.childElementCount) g.appendChild(row);
    const only = bodies.size === 1 ? [...bodies][0]! : null;
    if (!row.childElementCount && only === null) return;
    if (only !== null) {
      const members = bodyMembers(model.items, only);
      const shapes = members.filter((m) => m.object === "collision").length;
      const lights = members.filter((m) => m.object === "light").length;
      const panels = members.length - shapes - lights;
      const parts: string[] = [];
      if (shapes) parts.push(`${shapes} ${shapes === 1 ? "shape" : "shapes"}`);
      if (panels) parts.push(`${panels} decoration`);
      if (lights) parts.push(`${lights} ${lights === 1 ? "light" : "lights"}`);
      describe(
        title,
        shapes
          ? `One body of ${parts.join(", ")}: they share a transform, and the rope and ledge grabs treat the seams between the shapes as interior. Alt+click an object to edit it alone.`
          : `One body of ${parts.join(", ")}, moved and turned as one. Nothing here collides, so it builds no engine body: it stays where it is authored in play. Merge it with a colliding shape to have it ride that.`,
      );
    } else {
      describe(
        title,
        "Merging puts these objects in ONE body. Its collision shapes build as a single body, so the rope runs straight over the seams between them instead of snagging; kind, fill and friction collapse onto the first shape's, while material, thickness and hook-proof stay per shape. Decoration in the body is carried by it - its own fill, no mass, drawn in the body's frame. A light in it is that body's light, and moving the body moves the light. Without merging anything, the 3D view's gizmo stands at the middle of this selection and moves and turns all of it as one arrangement.",
      );
    }
  }

  // A body's position in the outliner, which is what names it everywhere in the
  // UI. Derived from the same `bodyRuns` the tree and `toLevelData` walk, so the
  // number on a panel is the number in the tree is the index on disk.
  const bodyIndexOf = (id: string): number =>
    bodyRuns(model.items.filter((i) => i.layer === "scene")).findIndex(
      (r) => r[0]!.unit === id,
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
    const sync = (): void => {};
    // The physics half exists only for a body that HAS some. A body of pure
    // decoration or a lone light has no kind, no friction and no force, and
    // offering them would be three controls that change nothing.
    if (leads.length) {
      const physics = section(g, "body/Physics", "Physics");
      const num = groupNum(physics, leads, sync);
      const kw = fieldRow("kind");
      const ks = document.createElement("select");
      ks.className = "ed-select";
      const sharedKind = leads.every((b) => propsOf(b).kind === propsOf(leads[0]!).kind) ? propsOf(leads[0]!).kind : null;
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
        for (const m of leads) propsOf(m).kind = ks.value as BodyKind;
        markDirty();
        // Which fields apply depends on the kind (force magnitude, friction), so
        // the panel has to be rebuilt rather than just revalued.
        rebuildInspector();
      });
      kw.appendChild(ks);
      physics.appendChild(kw);
      if (!leads.some(frictionless)) {
        num("friction", (b) => propsOf(b).friction, (b, v) => (propsOf(b).friction = Math.min(1, Math.max(0, v))), 0.1);
      }
      if (leads.every((b) => propsOf(b).kind === "force")) {
        // Acceleration along rot°, authored in px/s² like every other length.
        // Negative reverses the flow, so it is deliberately not clamped at 0.
        num("force", (b) => propsOf(b).force * M2PX, (b, v) => (propsOf(b).force = v * PX), 50);
      }
      if (leads.every((b) => propsOf(b).kind === "water")) {
        // The current's SPEED along rot°, in px/s - a length per second, so it
        // converts like every other length, and signed for the same reason the
        // force does.
        num("flow", (b) => propsOf(b).flow * M2PX, (b, v) => (propsOf(b).flow = v * PX), 25);
        // ...and the rate it takes hold at, in 1/s. NOT a length: it is a
        // reciprocal time, so it is authored and stored as the same number.
        num("drag", (b) => propsOf(b).drag, (b, v) => (propsOf(b).drag = Math.max(0, v)), 0.5);
        // The fall off the downstream end: its drop in px (0 = none, the run
        // ends against its bank). How fast it leaves the lip is not authored:
        // it follows from the current's speed and depth (see
        // `LevelBodyData.spill`).
        num("spill", (b) => propsOf(b).spill * M2PX, (b, v) => (propsOf(b).spill = Math.max(0, v) * PX), 10);
        // The slab through z, drawn by the game (see `LevelBodyData.waterZ`):
        // its middle's offset from the plane and its depth, both in px. An
        // empty depth is the renderer's own.
        num("water z", (b) => propsOf(b).waterZ * M2PX, (b, v) => (propsOf(b).waterZ = v * PX), 5);
        num(
          "water depth",
          (b) => (propsOf(b).waterDepth ?? 0) * M2PX,
          (b, v) => (propsOf(b).waterDepth = Math.max(1, v) * PX),
          10,
          {
            placeholder: leads.length > 1 ? "mixed" : "default",
            onEmpty: () => {
              for (const b of leads) propsOf(b).waterDepth = null;
            },
          },
        );
      }
      // The finish line has nothing to tune - being entered IS the whole of it
      // - so what its panel carries is the one thing that is not on the canvas:
      // what happens when the player gets there.
      if (leads.every((b) => propsOf(b).kind === "finish")) {
        describe(kw,
          "The end of the level: the run is over the moment the player touches this region, however they arrive. Draw it across the way out - wide enough that a swing cannot miss it - and give the body a model for its finish gantry. A listed level needs exactly one.");
      }
      // Offered for the kinds that build a BODY: an area is a region the sim
      // walks through already, so "the hook is the only thing that finds it"
      // says nothing about one.
      if (leads.every((b) => propsOf(b).kind === "static" || propsOf(b).kind === "rigid")) {
        addPassableField(physics, leads);
      }
      if (!leads.some(frictionless)) {
        const bounce = section(g, "body/Bounce", "Bounce");
        addBounceFields(bounce, groupNum(bounce, leads, sync), leads);
      }
      // Offered for the kinds that build a BODY, like hook-only above: an
      // area is a region rather than a thing anything can hit.
      if (leads.every((b) => propsOf(b).kind === "static" || propsOf(b).kind === "rigid")) {
        const breaks = section(g, "body/Breakable", "Breakable");
        addBreakFields(breaks, groupNum(breaks, leads, sync), leads);
      }
      // A ROOT's one body question: does it spring about where it grows from.
      if (
        leads.every((b) => (propsOf(b).kind === "static" || propsOf(b).kind === "rigid") && bodyMembers(model.items, b.unit).some(isRootItem))
      ) {
        addRootSpringField(section(g, "body/Root", "Root"), leads);
      }
      if (leads.every((b) => propsOf(b).kind === "rigid")) {
        addPivotField(section(g, "body/Pivot", "Pivot"), leads);
        addSpringFields(section(g, "body/Spring", "Spring"), leads);
      }
      // ...and the two motions a static may carry, which are the same shape of
      // thing one kind along: a body the LEVEL drives rather than the solver.
      if (leads.every((b) => propsOf(b).kind === "static")) {
        addMoverFields(section(g, "body/Mover", "Mover"), leads);
      }
    }
    // The body's name, for a body of any make-up.
    addBodyNameField(section(g, "body/Name", "Name"), members);
    // ...and the fill, which only a body written from a collision lead has: a
    // body that is nothing but a light is not painted at all. It is the 2D
    // view's fill, and the colour a piece's debug geometry takes unless the
    // piece picks its own.
    if (leads.length) {
      const fill = section(g, "body/Fill", "Fill");
      addFillFields(fill, groupNum(fill, leads, sync), leads, sync);
    }
  }

  // A NODE's name (plans/node-tree.md "Identity"): a label, unique among its
  // siblings (a clash is suffixed with the next free number as it is typed),
  // shown in the scene tree and in the replay tools' paths.
  function addBodyNameField(g: HTMLElement, members: EdItem[]): void {
    const ids = [...new Set(members.map((m) => m.unit))];
    if (ids.length !== 1) return; // a name is one node's; several selected have several
    const id = ids[0]!;
    const input = document.createElement("input");
    input.className = "ed-text";
    input.value = model.tree.nodes.get(id)?.name ?? "";
    input.placeholder = "unnamed";
    let edited = false;
    input.addEventListener("blur", () => (edited = false));
    input.addEventListener("input", () => {
      if (!edited) {
        beginAction();
        edited = true;
      }
      const text = input.value.replace(/\s+/g, " ").trim();
      if (text) renameNode(model.tree, id, text);
      markDirty();
      refreshOutliner();
    });
    const row = fieldRow("name");
    row.appendChild(input);
    describe(row, "This node's name: what the scene tree lists it by. Unique among its siblings.");
    g.appendChild(row);
  }

  // A model's exported `meta.json` (`ModelMeta`), fetched once per model name
  // and kept for the page (the maps live with the editor's other state,
  // above): undefined while it is on its way, null when the model has never
  // been exported here (a 404). `onChange` is called when the answer lands, so
  // a panel built before it can redraw its line. A re-export while the editor
  // is open is picked up on the next page load, like the model's mesh itself.
  function modelMetaFor(name: string, onChange: () => void): ModelMeta | null | undefined {
    return name ? exportMetaFor(modelMetas, modelMetaWaiters, name, modelMetaFile(name), onChange) : null;
  }

  // One export's `meta.json`, fetched once and kept: undefined while it is on
  // its way (and `onChange` is called when it lands - every caller asking
  // meanwhile, not only the first), null when there is none (a 404).
  function exportMetaFor<T>(
    metas: Map<string, T | null | undefined>,
    waiters: Map<string, Array<() => void>>,
    key: string,
    file: string,
    onChange: () => void,
  ): T | null | undefined {
    if (metas.has(key)) {
      const known = metas.get(key);
      if (known === undefined) waiters.get(key)?.push(onChange);
      return known;
    }
    metas.set(key, undefined);
    waiters.set(key, [onChange]);
    void fetch(file, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
      .catch(() => null)
      .then((meta) => {
        metas.set(key, meta);
        for (const w of waiters.get(key) ?? []) w();
        waiters.delete(key);
      });
    return undefined;
  }

  // The model `+ Model` places: the last one picked or selected, else the
  // first the editor offers.
  let lastModelName = "";

  // The models the editor offers (`/api/models`: exported here or pinned),
  // fetched once a page. Off the dev server there is no such endpoint, and the
  // pinned ones are all there is.
  let modelNames: string[] | null = null;
  function modelNamesFor(onChange: () => void): string[] {
    if (modelNames) return modelNames;
    modelNames = Object.keys(MODEL_ASSETS).sort();
    void fetch(MODELS_API, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<string[]>) : null))
      .catch(() => null)
      .then((names) => {
        if (!names) return;
        modelNames = names;
        onChange();
      });
    return modelNames;
  }

  // THE BODY panel: a container with a transform and the properties a body has
  // exactly one of. Deliberately narrow - everything it does NOT offer is a
  // thing that belongs to a scene object, and offering it here is what made a
  // body and its one object look like the same thing.
  function buildBodyPanel(id: string): void {
    const members = bodyMembers(model.items, id);
    if (!members.length) return;
    const index = bodyIndexOf(id);
    const g = el("div", "ed-group");
    const kinds = members.map((m) => m.object);
    const title = heading(
      `Body #${index} — ${bodyLabel(members)}`,
      `${members.length} object${members.length === 1 ? "" : "s"}: ` +
        `${kinds.filter((k) => k === "collision").length} collision, ` +
        `${kinds.filter((k) => k === "light").length} light. ` +
        "A body is the frame they are placed in and the properties they share - what each one IS lives on the object. Expand this body in the panel bottom-left and click an object to edit its shape or material. What it LOOKS like is what it carries: its formation, the decorations on it, its models.",
    );
    g.appendChild(title);
    const transform = section(g, "body/Transform", "Transform");

    // The transform. It is the frame every object in the body is placed from,
    // so moving it moves them: the fields write a DELTA onto the members rather
    // than a position onto a body the model does not separately store.
    // Read on every use, never captured: a frame is REPLACED rather than mutated
    // (see `translateItems`), so a reference taken when the panel was built goes
    // stale the moment the body moves.
    const origin = (): EdBodyFrame => bodyFrameOf(model, id);
    const nudgeBy = (dx: number, dy: number) => translateItems(model, members, new Vec2(dx, dy));
    numField(transform, "x", () => origin().pos.x * M2PX, (v) => nudgeBy(v * PX - origin().pos.x, 0));
    numField(transform, "y", () => origin().pos.y * M2PX, (v) => nudgeBy(0, v * PX - origin().pos.y));
    // No z beside them: a body's position is x and y, and depth belongs to the
    // objects that draw (see `LevelBodyData`), where the geometry panel's
    // `z` authors it.
    // Turning a body turns everything in it about the point it is built to
    // rotate about - its centre of mass, which is where the engine puts the
    // origin (see `bodyCentroid`).
    numField(
      transform,
      "rot°",
      () => deg(origin().rot),
      // About the point the built body actually turns about - its centre of
      // mass - so the editor's rotation and the engine's are the same operation.
      (v) => rotateItemsAbout(model, members, bodyTurnCentre(members), rad(v) - origin().rot),
    );
    // A FRAME IN THE SCENE (a rock with no body, a `Node3D`): off the plane
    // by a depth and tilted, everything under it carried (`setNodeWorld`).
    // A body is in the plane, and so is what it holds.
    if (isFrame3D(id)) {
      const at = (): World3 => worldOfNode(model, id);
      const write = (s: Partial<World3>): void => setNodeWorld(model, id, { ...at(), ...s });
      numField(transform, "z", () => at().z * M2PX, (v) => write({ z: v * PX }));
      numField(transform, "tilt x°", () => deg(at().tilt[0]), (v) => write({ tilt: [rad(v), at().tilt[1]] }));
      numField(transform, "tilt y°", () => deg(at().tilt[1]), (v) => write({ tilt: [at().tilt[0], rad(v)] }));
    }
    // ...and the one thing that can be done TO the frame rather than through it:
    // put it on the centre of mass, which is where the engine's origin is
    // whatever the file says and the point the two fields above already turn the
    // body about. Nothing in the level moves - every object's offset takes up
    // the step (see `originToCentroid`).
    //
    // Offered rather than done automatically, because where a body's origin sits
    // is the author's: a hinge pinned on the bracket it swings from reads better
    // than one floating in the middle of the assembly, and nothing downstream
    // needs the two to agree.
    const row = el("div", "ed-row");
    const centre = button("Origin to COM", () => originOntoCentroid(id));
    centre.disabled = originIsCentred(id);
    centre.title = centre.disabled
      ? "This body's origin is already on its centre of mass."
      : "Move this body's origin onto its centre of mass - the point the engine builds it about - and take up the step in every object's offset. Nothing moves in the level.";
    row.appendChild(centre);
    transform.appendChild(row);

    addBodyProps(g, members);
    // The body's rock, generated in its frame (docs/formations.md): offered on
    // any body with a piece that encloses something, edited in place.
    if (workspace === "formations" && members.some((m) => m.object === "formation" || enclosingItem(m))) {
      buildFormationSection(formationHost, section(g, "body/Formation", "Formation"), id);
    }
    // What grows on its rock (the Decorations workspace's).
    const rock = members.find((m) => m.object === "formation");
    if (workspace === "decorations" && rock) decorations.buildList(section(g, "body/Decorations", "Decorations"), rock);
    if (workspace === "texturing" && rock) decorations.buildList(section(g, "body/Materials", "Materials"), rock, true);
    // The buttons are not properties: they stay in view under the sections.
    appendGroupSection(g, title);
    appendActions(g);
    inspector.appendChild(g);
  }

  // SEVERAL bodies. No transform, because there is no one frame to edit - what
  // this panel is for is the operations that take a set: Merge above all, and
  // the body properties they can be given in one go.
  function buildBodiesPanel(ids: string[]): void {
    const members = ids.flatMap((id) => bodyMembers(model.items, id));
    const g = el("div", "ed-group");
    const title = heading(
      `${ids.length} bodies selected`,
      "Shift or Ctrl+click a body row to add or remove one. Merge puts every object in these bodies into a single body; edits below apply to all of them.",
    );
    g.appendChild(title);
    addBodyProps(g, members);
    appendGroupSection(g, title);
    appendActions(g);
    inspector.appendChild(g);
  }

  // Chain panel. A chain has no placement of its own - both ends are points on
  // bodies - so the panel is what it holds, how long it is, and its colour.
  function buildChainGroup(chains: EdChain[]): void {
    const g = el("div", "ed-group");
    const title = heading(
      chains.length === 1 ? `Chain #${chains[0]!.id}` : `${chains.length} chains selected`,
      "Strung between two bodies and solved every frame: a rigid body on either end hangs and swings from it, a static one just holds. Drag an end handle to move or re-anchor it. Shift-drag the chain itself to pull a wrap point out of it and drop it on a corner the chain should bend around - a beam, a pulley - and drag a wrap point's handle to move it. One wrap point per piece is enough: a circle gets its two tangent points and a beam its corners from that one. The chain winds onto its A end when that body turns.",
    );
    describe(
      title,
      "Scenery: drawn behind the level, and solved against the level's geometry - it catches on corners as the ball's chain does - but never against the player or the hook, which pass straight through it.",
    );
    g.appendChild(title);

    // A TIED chain (`EdChain.through`) has knots where an ordinary chain has
    // wrap points, and its own length fields: one slack for the lot and a
    // length per segment, in place of the one length below.
    if (chains.length === 1 && isTiedChain(chains[0]!)) {
      addTiePointRows(section(g, "chain/Tie points", "Tie points"), chains[0]!);
      addTiedLengthRows(section(g, "chain/Segments", "Segments"), chains[0]!);
    } else if (chains.length === 1) {
      addWrapPointRows(section(g, "chain/Wrap points", "Wrap points"), chains[0]!);
    }

    // Slack is what a chain is for, so the length is authored in scene pixels
    // like every other length. Blank = exactly taut between the two anchors,
    // re-derived on load, which is what dragging one out gives.
    const length = section(g, "chain/Length", "Length");
    if (chains.some(isTiedChain)) {
      const hint = el("div", "ed-hint");
      hint.textContent = "A tied chain's lengths are its segments' (above).";
      length.appendChild(hint);
    } else {
      addLengthField(length, chains);
    }

    const color = section(g, "chain/Color", "Color");
    const cw = fieldRow("color");
    const ci = colorInput(chains[0]!.color ?? CHAIN_DEFAULT_COLOR, beginAction, (hex) => {
      for (const c of chains) c.color = hex;
      markDirty();
    });
    cw.appendChild(ci.el);
    color.appendChild(cw);
    const reset = el("div", "ed-row");
    reset.appendChild(
      button("Reset color", () => {
        beginAction();
        for (const c of chains) c.color = null;
        markDirty();
        rebuildInspector();
      }),
    );
    color.appendChild(reset);

    const row = el("div", "ed-row");
    row.appendChild(button("Delete", () => deleteSelected()));
    g.appendChild(row);
    inspector.appendChild(g);
  }

  // An ordinary chain's one length, in scene pixels, with a slack readout.
  function addLengthField(length: HTMLElement, chains: EdChain[]): void {
    numField(
      length,
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
    const srow = fieldRow("slack");
    const sval = document.createElement("span");
    sval.textContent = slack();
    srow.appendChild(sval);
    length.appendChild(srow);
    readouts.push({ el: sval, get: slack });
  }

  // A tied chain's knots, one row each in route order - which body each is on,
  // by its outliner number, and a way to untie it: the knots either side join
  // up, as the loader joins them around a dead anchor.
  function addTiePointRows(g: HTMLElement, c: EdChain): void {
    const runs = bodyRuns(model.items.filter((i) => i.layer === "scene"));
    const indexOfBody = new Map<string, number>();
    runs.forEach((members, i) => indexOfBody.set(members[0]!.unit, i));
    const hint = el("div", "ed-hint");
    hint.textContent =
      "Knotted to each body it passes: a rope bridge is one chain, post, slat, slat, ..., post. Each segment between knots on different bodies is straight and has its own length.";
    g.appendChild(hint);
    chainThroughItems(model, c).forEach((t, i) => {
      const row = el("div", "ed-row");
      const label = el("span", "ed-hint");
      const at = indexOfBody.get(t.unit);
      label.textContent = `tie ${i + 1} · body ${at === undefined ? "?" : at}`;
      row.append(
        label,
        button("×", () => {
          beginAction();
          c.through = c.through.filter((id) => id !== t.id);
          c.lengths = [];
          pruneAnchors();
          markDirty();
          rebuildInspector();
        }),
      );
      g.appendChild(row);
    });
  }

  // A tied chain's slack, its substeps, and a length per segment. A segment's
  // field blank = that segment takes the slack; the readout beside each is
  // the authored gap it would be built at.
  function addTiedLengthRows(g: HTMLElement, c: EdChain): void {
    numField(
      g,
      "slack",
      () => c.slack,
      (v) => {
        c.slack = Math.max(0, v);
      },
      0.01,
      false,
      {
        placeholder: "taut",
        onEmpty: () => {
          c.slack = null;
        },
      },
    );
    numField(
      g,
      "substeps",
      () => c.substeps,
      (v) => {
        c.substeps = Math.max(1, Math.min(32, Math.round(v)));
      },
      1,
      false,
      {
        placeholder: "8",
        onEmpty: () => {
          c.substeps = null;
        },
      },
    );
    const segments = chainSegments(model, c);
    while (c.lengths.length < segments.length) c.lengths.push(null);
    segments.forEach((s, i) => {
      numField(
        g,
        `segment ${i + 1} (gap ${Math.round(s.gap * M2PX)} px)`,
        () => {
          const l = c.lengths[i];
          return l === null || l === undefined ? null : l * M2PX;
        },
        (v) => {
          c.lengths[i] = Math.max(0, v * PX);
        },
        1,
        false,
        {
          placeholder: c.slack !== null ? `${Math.round(s.gap * (1 + c.slack) * M2PX)}` : "taut",
          onEmpty: () => {
            c.lengths[i] = null;
          },
        },
      );
    });
  }

  // The chain's wrap points, one row each in route order - which body each is
  // on, by its outliner number, and a way to take it out of the route again -
  // and a button that adds one without the drag: at the midpoint of the
  // chain's longest span, on the nearest corner of whatever chainable piece is
  // closest, for a route whose spans are too short or too buried to Shift-drag.
  function addWrapPointRows(g: HTMLElement, c: EdChain): void {
    const runs = bodyRuns(model.items.filter((i) => i.layer === "scene"));
    const indexOfBody = new Map<string, number>();
    runs.forEach((members, i) => indexOfBody.set(members[0]!.unit, i));
    const vias = chainViaItems(model, c);
    vias.forEach((v, i) => {
      const row = el("div", "ed-row");
      const label = el("span", "ed-hint");
      const at = indexOfBody.get(v.unit);
      label.textContent = `wrap ${i + 1} · body ${at === undefined ? "?" : at}`;
      row.append(
        label,
        button("×", () => {
          beginAction();
          c.via = c.via.filter((id) => id !== v.id);
          // The anchor it was is now named by nothing, and an anchor nothing
          // names is wreckage rather than something an author placed.
          pruneAnchors();
          markDirty();
          rebuildInspector();
        }),
      );
      g.appendChild(row);
    });
    const row = el("div", "ed-row");
    row.appendChild(button("+ Wrap point", () => addWrapPointAuto(c)));
    g.appendChild(row);
  }

  // Put a wrap point on `host` at (the corner nearest) `world`, in the route
  // after span `index` - between the two points that span ran between.
  function addWrapPoint(c: EdChain, index: number, host: EdItem, world: Vec2): void {
    if (!chainable(host)) return;
    beginAction();
    const v = newAnchorOn(host, world, nearestCornerLocal);
    model.items.push(v);
    const via = [...c.via];
    via.splice(Math.max(0, Math.min(index, via.length)), 0, v.id);
    c.via = via;
    markDirty();
    rebuildInspector();
  }

  // The button's version of the drag: the longest span's midpoint, on the
  // piece under it, or failing that on the chainable piece whose nearest corner
  // is closest - which is where a wrap point pulled out there would land.
  function addWrapPointAuto(c: EdChain): void {
    const path = chainPath(model, c);
    if (!path) return;
    let index = 0;
    let longest = -1;
    for (let i = 0; i < path.length - 1; i++) {
      const l = path[i + 1]!.distanceTo(path[i]!);
      if (l > longest) {
        longest = l;
        index = i;
      }
    }
    const mid = path[index]!.add(path[index + 1]!).mul(0.5);
    let host = topmostAt(mid, (b) => chainable(b));
    if (!host) {
      let bestD = Infinity;
      for (const it of model.items) {
        if (!chainable(it)) continue;
        const d = toWorld(it, nearestCornerLocal(it, mid)).distanceTo(mid);
        if (d < bestD) {
          bestD = d;
          host = it;
        }
      }
    }
    if (host) addWrapPoint(c, index, host, mid);
  }

  // Vine panel. A vine has no placement of its own either - its one point is on
  // a body - so the panel is how long it is, how finely it is made, and its
  // colour.
  function buildVineGroup(vines: EdVine[]): void {
    const group = el("div", "ed-group");
    const title = heading(
      vines.length === 1 ? `Vine #${vines[0]!.id}` : `${vines.length} vines selected`,
      "Hangs from one anchor, free at the bottom - or spans between two. The player passes straight through it and the hook grabs it anywhere along its length; it drapes over whatever it lands on. Drag the top handle to move it - along the body it hangs from, or onto another one - and the end handle to set how long it is. SHIFT-drag the end handle onto a body to attach it there and make the vine a span (length stays its own, so a span longer than the gap sags); Shift-drop a span's end over empty space to detach it again.",
    );
    group.appendChild(title);
    // The section the next fields go in: its shape, then how it behaves, then
    // its colour.
    let g = section(group, "vine/Shape", "Shape");

    numField(
      g,
      "length",
      () => {
        const first = vines[0]!.length;
        return vines.every((v) => v.length === first) ? first * M2PX : null;
      },
      (v) => {
        // Never shorter than a berry vine's lowest berry (`minBerryVineLength`).
        for (const vine of vines) vine.length = Math.max(minBerryVineLength(vine.starberry, MIN_VINE_LENGTH), v * PX);
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
    const lrow = fieldRow("links");
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
      const srow = fieldRow("slack");
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
    g = section(group, "vine/Physics", "Physics");
    const density = numField(
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
    describe(
      density,
      "Kilograms per metre of cord: it sets how the vine answers a hooked player and what it leans on what it hangs from, not how it falls.",
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
      const row = fieldRow(label);
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
    // Under the title rather than in its section, so a collapsed Physics does
    // not hide it.
    const warn = el("div", "ed-hint ed-warn");
    warn.textContent = light();
    title.after(warn);
    readouts.push({ el: warn, get: light });

    // How hard it is to BEND, 0..1 - the one thing on this panel that is not a
    // length, a weight or a colour (see `level/vineBend.ts`). Blank is the
    // builder's default, and blank is a real third state rather than a spelling
    // of zero: a vine that never asked for stiffness builds no bend constraints
    // at all, so it costs what a vine always cost and replays as one.
    const stiffness = numField(
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
        placeholder: `${vines.every((v) => v.starberry) ? STARBERRY_STIFFNESS : DEFAULT_VINE_STIFFNESS}`,
        onEmpty: () => {
          for (const vine of vines) vine.stiffness = null;
        },
      },
    );
    describe(
      stiffness,
      "How hard it is to bend - 0 is a rope, 1 a pole that holds itself straight and springs back to hanging. On a span the ends are pinned and stiffness presses the drape toward straight: 0 rests in the catenary, 1 reads as a taut wire.",
    );

    // What that number reads as in the game, because 0.75 says nothing on its
    // own and the thing it stands for is a bending rigidity nobody can picture.
    // The bands are the measured ones (see `BEND_EI_POLE`).
    readout("bends like", () => {
      if (vines.length > 1) return "-";
      const s = vines[0]!.stiffness ?? (vines[0]!.starberry ? STARBERRY_STIFFNESS : DEFAULT_VINE_STIFFNESS);
      if (s < 0.2) return "a rope";
      if (s < 0.4) return "a heavy cord";
      if (s < 0.65) return "a springy branch";
      if (s < 0.85) return "a sapling";
      return "a pole";
    });

    // How viscous the cord is to the ball's manacle threaded onto it - the
    // ring creeps down the vine under a hanging ball by mud's own law, and
    // this scales the load that law reads exactly as a mud patch's viscosity
    // does (see `VineData.viscosity`). Blank is the builder's default, the
    // reference mud; 0 is a ring that never slides.
    const viscosity = numField(
      g,
      "viscosity",
      () => {
        const first = vines[0]!.viscosity;
        return vines.every((v) => v.viscosity === first) ? (first ?? NaN) : null;
      },
      (v) => {
        for (const vine of vines) vine.viscosity = Math.max(0, v);
      },
      0.1,
      vines.length > 1,
      {
        placeholder: `${DEFAULT_VINE_VISCOSITY}`,
        onEmpty: () => {
          for (const vine of vines) vine.viscosity = null;
        },
      },
    );
    describe(
      viscosity,
      "The ball's manacle threads onto a vine like a ring and creeps down it under the ball's weight, locked to the cord until it slides off the free end - viscosity sets how slowly, as it does for mud: blank is mud's own, 0 never slides.",
    );

    // A BERRY VINE (`level/starberry.ts`): berries on stalks off the cord, and
    // only the berries catch the hook - the cord is drawn set back behind the
    // gameplay plane to say so. Its stiffness left blank is a sapling's
    // (`STARBERRY_STIFFNESS`) rather than a rope's.
    const berried = vines.every((v) => v.starberry);
    g = section(group, "vine/Berries", "Berries");
    describe(
      g,
      "Drag out from a vine to grow a berry: its stalk leaves the vine where you pressed and the berry hangs where you let go. Click a berry to pick it and move it with its gizmo (or drag it), or size it with the gizmo's scale or its radius field; drag the square at its root to slide it along the vine; Alt-click or Delete removes it. Only the berries catch the hook - a vine with berries is drawn set back behind the play plane, and nothing on it collides with the ball or the chain. The last berry removed makes it a plain vine again.",
    );
    const vine = vines.length === 1 ? vines[0]! : null;
    const settings = vine?.starberry;
    if (vine && settings) {
      for (const [key, label, step, min, max, scale] of [
        ["radius", "new berry radius", 1, MIN_BERRY_RADIUS, MAX_BERRY_RADIUS, M2PX],
        ["sway", "berry sway", 0.05, 0, 1, 1],
        ["glow", "glow", 0.1, 0, 3, 1],
        ["seed", "vine seed", 1, 0, 2147483647, 1],
      ] as const) {
        numField(g, label, () => settings[key] * scale, (n) => {
          settings[key] = Math.min(max, Math.max(min, n / scale));
        }, step);
      }
      // What a berry is made of (kilograms per cubic metre, so each berry
      // weighs its own drawn sphere) and what a stalk is made of (kilograms
      // per metre, as the cord's `density` is, so each stem weighs its own
      // stalk's reach). Blank is the builder's default, as the cord's is;
      // neither is a length, so neither is scaled by `M2PX`. The numbers set
      // how the plant answers the ball (a PBD correction is split by inverse
      // mass, so a light berry takes the whole of what the chain hands it),
      // not how it falls.
      // And how far a stalk stretches on its spring before its ropes catch it,
      // as a fraction of its reach: the bounce. A fraction, so not scaled
      // either.
      for (const [key, label, fallback, min, max, step] of [
        ["berryDensity", "berry density kg/m³", DEFAULT_BERRY_DENSITY, MIN_BERRY_DENSITY, MAX_BERRY_DENSITY, 10],
        ["stalkDensity", "stem density kg/m", DEFAULT_STALK_DENSITY, MIN_STALK_DENSITY, MAX_STALK_DENSITY, 0.5],
        ["stretch", "stem stretch", DEFAULT_STALK_STRETCH, MIN_STALK_STRETCH, MAX_STALK_STRETCH, 0.05],
      ] as const) {
        const field = numField(
          g,
          label,
          () => settings[key] ?? NaN,
          (n) => {
            settings[key] = Math.min(max, Math.max(min, n));
          },
          step,
          false,
          {
            placeholder: `${fallback}`,
            onEmpty: () => {
              delete settings[key];
            },
          },
        );
        describe(
          field,
          key === "berryDensity"
            ? "What the berries are made of, so a bigger berry weighs more: it sets how the plant answers the ball on the chain, not how it falls - a light berry is whipped about and takes the whole of every pull, a heavy one barely gives. Blank is a fruit's (640); the ball is iron at 7200. For a berry that bounces the ball, keep it light: a heavy berry takes a share of the ball's speed the moment the chain goes taut, the way a chain catch does."
            : key === "stalkDensity"
              ? "What the stalks are made of, per metre like the cord, so a longer stalk weighs more: the weight of the stem between the cord and the berry. Blank is the default (8.3, a third of the cord's)."
              : "How far a stalk stretches on its spring before its ropes catch it, as a fraction of its length: the bounce. At 0 a pull along the stalk is caught dead, as a chain catches; at 0.5 a 0.6 m stalk stretches to 0.9 m and throws the ball back. Sway sets the spring's rate; above 0.5 sway the stalk sags too far under a hanging ball to bounce it. Blank is 0.5.",
        );
      }
      // Each berry, to pick; the picked one's place in the level, exactly.
      const picked = currentBerry();
      const list = el("div", "ed-row");
      settings.along.forEach((_, index) => {
        const b = button(`${picked?.index === index ? "▸ " : ""}Berry ${index + 1}`, () => selectBerry(vine, index));
        list.appendChild(b);
      });
      g.appendChild(list);
      if (picked?.vine === vine) {
        const index = picked.index;
        const root = (): Vec2 | null => {
          const path = vineRestPath(model, vine);
          return path && vine.starberry ? pointAlong(path, vine.starberry.along[index]!) : null;
        };
        const at = (): Vec2 | null => {
          const r = root();
          return r && vine.starberry ? r.add(berryOffset(index, vine.starberry)) : null;
        };
        // Where the berry hangs in the level (its centre, in the file's
        // pixels), and where its stalk leaves the vine.
        numField(g, `berry ${index + 1} x`, () => (at()?.x ?? NaN) * M2PX, (n) => {
          const r = root();
          const a = at();
          if (r && a && vine.starberry) placeBerry(vine.starberry, index, new Vec2(n * PX, a.y).sub(r));
        });
        numField(g, `berry ${index + 1} y`, () => (at()?.y ?? NaN) * M2PX, (n) => {
          const r = root();
          const a = at();
          if (r && a && vine.starberry) placeBerry(vine.starberry, index, new Vec2(a.x, n * PX).sub(r));
        });
        numField(g, `berry ${index + 1} radius`, () => berryRadius(index, settings) * M2PX, (n) => {
          sizeBerry(settings, index, n * PX);
        });
        // What that berry weighs at the plant's density - the number the chain
        // actually pulls against - and what its stem weighs at the stalk's.
        readout(`berry ${index + 1} weight`, () => `${berryMass(berryRadius(index, settings), settings).toFixed(1)} kg`);
        readout(
          `stem ${index + 1} weight`,
          () => `${stalkMass(stalkReach(berryOffset(index, settings).length()), settings).toFixed(1)} kg`,
        );
        // How far down the vine the stalk leaves it, in the file's pixels:
        // fixed whatever the vine's length does.
        numField(g, "stalk leaves at", () => settings.along[index]! * M2PX, (n) => {
          moveBerry(settings, index, n * PX, vine.length);
        });
        const row = el("div", "ed-row");
        row.appendChild(
          button(`Remove berry ${index + 1}`, () => {
            beginAction();
            deleteBerry(vine, index);
            markDirty();
            rebuildInspector();
          }),
        );
        g.appendChild(row);
      }
    }

    // A berry vine draws its own single woody cord, so neither the braid nor
    // the colour has anything to say about one.
    if (!berried) {
      // Keyed by its old name, so the open state a browser remembers for it
      // carries over.
      g = section(group, "vine/Braid", "Look");
      const braidSeed = document.createElement("input");
      braidSeed.type = "number";
      braidSeed.className = "ed-num";
      braidSeed.min = "0"; braidSeed.max = "2147483647"; braidSeed.step = "1";
      braidSeed.value = String(vines[0]!.braidSeed ?? 1701);
      braidSeed.setAttribute("aria-label", "Vine seed");
      // Both looks are the braid with the seed in the box: a leafy vine, or
      // the same three strands laid as rope.
      const renderAs = (rope: boolean) => () => {
        if (!braidSeed.reportValidity()) return;
        beginAction();
        for (const vine of vines) { vine.braidSeed = Number(braidSeed.value); vine.rope = rope; }
        markDirty(); rebuildInspector();
      };
      const braidRow = el("div", "ed-row");
      braidRow.append(braidSeed, button("Render as vine", renderAs(false)), button("Render as rope", renderAs(true)));
      g.appendChild(braidRow);
      const plainRow = el("div", "ed-row");
      plainRow.appendChild(button("Plain vine", () => {
        beginAction();
        for (const vine of vines) { vine.braidSeed = null; vine.rope = false; }
        markDirty(); rebuildInspector();
      }));
      g.appendChild(plainRow);

      g = section(group, "vine/Color", "Color");
      const cw = fieldRow("color");
      const roped = vines[0]!.braidSeed !== null && vines[0]!.rope;
      const ci = colorInput(vines[0]!.color ?? (roped ? ROPE_COLOR : VINE_DEFAULT_COLOR), beginAction, (hex) => {
        for (const v of vines) v.color = hex;
        markDirty();
      });
      cw.appendChild(ci.el);
      g.appendChild(cw);
      const reset = el("div", "ed-row");
      reset.appendChild(
        button("Reset color", () => {
          beginAction();
          for (const v of vines) v.color = null;
          markDirty();
          rebuildInspector();
        }),
      );
      g.appendChild(reset);
    }

    const row = el("div", "ed-row");
    row.appendChild(button("Delete", () => deleteSelected()));
    group.appendChild(row);
    inspector.appendChild(group);
  }

  // Camera-layer panel. Same shape as the body panel — group-wide edits, blank
  // for a value the group disagrees on — over the region's framing properties.
  function buildCameraGroup(regions: EdItem[]): void {
    const group = el("div", "ed-group");
    group.appendChild(
      heading(
        regions.length === 1 ? `Camera region #${regions[0]!.id}` : `${regions.length} regions selected`,
        "While the avatar is inside, the camera offsets, rescales the viewport, or pins to a locked axis. Every change eases in.",
      ),
    );

    // The section the next fields go in, and a field builder bound to it.
    let g = section(group, "camera/Transform", "Transform");
    let num = groupNum(g, regions);
    addTransformFields(g, num, regions);

    g = section(group, "camera/Framing", "Framing");
    num = groupNum(g, regions);
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
    // Whether the screen-edge guarantee holds the player in frame while this
    // region frames the camera. Unticked, they may leave the frame - or fall
    // into it, which is what a level's opening shot wants.
    {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = regions.every((b) => b.cam.keepInFrame);
      box.indeterminate = !box.checked && regions.some((b) => b.cam.keepInFrame);
      box.addEventListener("change", () => {
        beginAction();
        for (const b of regions) b.cam.keepInFrame = box.checked;
        markDirty();
        rebuildInspector();
      });
      const wrap = fieldRow("keep in frame");
      describe(
        wrap,
        "Hold the player on screen while this region frames the camera. Untick to let them leave the frame - or fall into it, for a level's opening shot.",
      );
      wrap.appendChild(box);
      g.appendChild(wrap);
    }

    // How it hands the camera over to its neighbours.
    g = section(group, "camera/Hand-off", "Hand-off");
    num = groupNum(g, regions);
    // (`blend s` was here. The camera has no hand-off clock any more: a rule
    // change is a step in the aim, and the motion layer answers every step at a
    // bounded acceleration.)
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
    // How far INSIDE the region its influence fades out - the band it blends
    // with an equal-priority neighbour across. Blank = 0: full strength out to
    // its own walls, which is what every region authored before the band is.
    num(
      "falloff",
      (b) => (b.cam.falloff ?? NaN) * M2PX,
      (b, v) => (b.cam.falloff = Math.max(0, v * PX)),
      10,
      {
        placeholder: "0",
        onEmpty: () => {
          for (const b of regions) b.cam.falloff = null;
        },
      },
    );
    // Lowest number wins outright; rules tied at it blend (see `ruleWeight`).
    num("priority", (b) => b.cam.priority, (b, v) => (b.cam.priority = Math.round(v)), 1);

    addActionsRow(group);
    inspector.appendChild(group);
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
      heading(
        paths.length === 1 ? `Camera path #${paths[0]!.id}` : `${paths.length} paths selected`,
        "The route the camera rides, in the direction it was drawn. The player is projected onto it and the camera targets a point further ALONG it, so the screen leads them the way the level wants them to go - even when they backtrack.",
      ),
    );

    const transform = section(g, "campath/Transform", "Transform");
    describe(
      transform,
      "Drag a node to move it, its round grips to shape the curve through it, an edge midpoint to insert one, Alt+click a node to remove it; click a node to pick it out (Shift adds, a rubber band catches several, Esc drops them), and Delete removes the picked nodes while the arrows nudge them.",
    );
    addTransformFields(transform, groupNum(transform, paths), paths);
    // The fields below fall into three sections but are written in the order
    // their reasoning runs, so `num` is switched to the one each goes in.
    const corridor = section(g, "campath/Corridor", "Corridor");
    describe(
      corridor,
      "`range x`/`range y` are the corridor, per axis because the frame is 16:9 - the pair is an ellipse around the route, so the corridor is screen-shaped. Stray past it and the path's grip fades over `falloff x`/`falloff y`, then lets go, handing the camera to whatever region contains them (or to the plain follow); coming back takes it again. Both hand-offs are bounded by the camera's own acceleration cap rather than blended on a clock.",
    );
    const lead = section(g, "campath/Lead", "Lead");
    describe(
      lead,
      "`lead x`/`lead y` are how far ahead, per axis, because the frame is 16:9; `lead buf x`/`lead buf y` are slack in where that lead is measured FROM, so a swing running back and forth along the route does not slosh the camera - and while the player is on a line that band is one-sided, so a swing wider than it ratchets the camera down the route instead of sawing it back and forth.",
    );
    const framing = section(g, "campath/Framing", "Framing");
    const corridorNum = groupNum(corridor, paths);
    const leadNum = groupNum(lead, paths);
    const framingNum = groupNum(framing, paths);
    let num = corridorNum;

    // The nodes of these paths that KEY a field (see `CameraPathVert`). A keyed
    // field's path-level value is read nowhere - the keys hold at both ends of
    // the route - so its field below is shown inert, reading `keyed`, with the
    // nodes that have taken it over in its tooltip (the input is too narrow to
    // list them), rather than being a dial connected to nothing.
    const keyedAt = (key: PathKeyField): string | null => {
      const nodes: string[] = [];
      for (const p of paths) {
        if (p.shape.kind !== "path") continue;
        p.shape.keys.forEach((k, i) => {
          if (k[key] !== null) nodes.push(paths.length > 1 ? `#${p.id}:${i}` : String(i));
        });
      }
      return nodes.length ? `keyed at node${nodes.length === 1 ? "" : "s"} ${nodes.join(", ")}` : null;
    };
    // Every per-axis pair below is two numbers for the one reason: the frame is
    // 16:9, so there is far less screen above and below the player than there
    // is either side of them. The pairs measured OFF the route - the range and
    // the falloff - are the semi-axes of an ellipse, so the corridor is
    // screen-shaped; the pairs measured ALONG it - the lead and its slack - are
    // blended by the heading the route runs in (see `axisBlend`), so zeroing
    // one of those axes means a route running that way leads by nothing while
    // the other axis carries on. Blank = the format's default, which is what
    // every path authored before a number was typed into it has.
    const axisField = (
      label: string,
      key: "rangeX" | "rangeY" | "falloffX" | "falloffY" | "lookaheadX" | "lookaheadY" | "lookaheadBufferX" | "lookaheadBufferY",
      fallback: number,
    ): void => {
      const keyed = keyedAt(key);
      const input = num(
        label,
        (b) => (keyed ? NaN : (b.cam[key] ?? NaN) * M2PX),
        (b, v) => (b.cam[key] = Math.max(0, v * PX)),
        10,
        {
          placeholder: keyed ? "keyed" : String(Math.round(fallback * M2PX)),
          disabled: keyed !== null,
          onEmpty: () => {
            for (const b of paths) b.cam[key] = null;
          },
        },
      );
      if (keyed) input.title = keyed;
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
    num = leadNum;
    axisField("lead x", "lookaheadX", DEFAULT_PATH_LOOKAHEAD_X);
    axisField("lead y", "lookaheadY", DEFAULT_PATH_LOOKAHEAD_Y);
    // Slack in where the lead is measured FROM, not in the lead itself: a swing
    // runs the player forward and back along the route several times a second,
    // and a camera that tracks that exactly sloshes with it. Wider than the
    // swing's travel along the path and the camera does not move at all.
    axisField("lead buf x", "lookaheadBufferX", DEFAULT_PATH_LOOKAHEAD_BUFFER_X);
    axisField("lead buf y", "lookaheadBufferY", DEFAULT_PATH_LOOKAHEAD_BUFFER_Y);
    // How much world is on screen: 2 = twice as much (zoomed out).
    num = framingNum;
    const viewKeyed = keyedAt("viewportScale");
    const viewInput = num(
      "view ×",
      (b) => (viewKeyed ? NaN : b.cam.viewportScale),
      (b, v) => (b.cam.viewportScale = Math.min(10, Math.max(0.1, v))),
      0.1,
      viewKeyed ? { placeholder: "keyed", disabled: true } : {},
    );
    if (viewKeyed) viewInput.title = viewKeyed;
    // Extra hysteresis outside `range` before the path lets go, on top of the
    // corridor itself. Blank = the controller's jitter margin, which is the same
    // default a region's buffer falls back to.
    num = corridorNum;
    const bufKeyed = keyedAt("buffer");
    const bufInput = num(
      "buffer",
      (b) => (bufKeyed ? NaN : (b.cam.buffer ?? NaN) * M2PX),
      (b, v) => (b.cam.buffer = Math.max(0, v * PX)),
      10,
      {
        placeholder: bufKeyed ? "keyed" : String(Math.round(REGION_EXIT_MARGIN * M2PX)),
        disabled: bufKeyed !== null,
        onEmpty: () => {
          for (const b of paths) b.cam.buffer = null;
        },
      },
    );
    if (bufKeyed) bufInput.title = bufKeyed;
    // How far off the route two places on it count as comparable to the camera's
    // SOFT projection - the width of the blur that makes progress along the
    // route a continuous function of where the player is. Much smaller than the
    // route's own bend radii and the camera cuts back to a nearest point, with
    // the jerk that goes with it; much larger and it cuts a corner before the
    // player does. Not keyable: it is a property of the route's shape rather
    // than of the framing at a place on it.
    num = framingNum;
    num(
      "softness",
      (b) => (b.cam.softness ?? NaN) * M2PX,
      (b, v) => (b.cam.softness = Math.max(0, v * PX)),
      10,
      {
        placeholder: String(Math.round(DEFAULT_PATH_SOFTNESS * M2PX)),
        onEmpty: () => {
          for (const b of paths) b.cam.softness = null;
        },
      },
    );
    // Seconds of warning the lead is stretched by at the speed the player is
    // travelling: the lead an author types is a DISTANCE, so on its own a
    // player at 8 m/s sees exactly as far ahead as one strolling at 1. The
    // stretch is capped at the authored lead, so a fast player sees at most
    // twice as far and a shaft with a zeroed vertical lead leads by nothing
    // however fast they fall. Blank = the controller's default.
    num = leadNum;
    const reactKeyed = keyedAt("reactionTime");
    const reactInput = num(
      "reaction s",
      (b) => (reactKeyed ? NaN : (b.cam.reactionTime ?? NaN)),
      (b, v) => (b.cam.reactionTime = Math.max(0, v)),
      0.05,
      {
        placeholder: reactKeyed ? "keyed" : String(DEFAULT_PATH_REACTION),
        disabled: reactKeyed !== null,
        onEmpty: () => {
          for (const b of paths) b.cam.reactionTime = null;
        },
      },
    );
    if (reactKeyed) reactInput.title = reactKeyed;
    // How far along the route a hanging player winds themselves up their line
    // before the camera's vertical lock lets go: a swing locks the frame's
    // vertical at the furthest the guarantee pushed it, and winding toward an
    // anchor ahead on the route is the one thing that says the player is going
    // the level's way rather than swinging. Blank = the controller's default.
    const windKeyed = keyedAt("windBuffer");
    const windInput = num(
      "wind buf",
      (b) => (windKeyed ? NaN : (b.cam.windBuffer ?? NaN) * M2PX),
      (b, v) => (b.cam.windBuffer = Math.max(0, v * PX)),
      10,
      {
        placeholder: windKeyed ? "keyed" : String(Math.round(DEFAULT_PATH_WIND_BUFFER * M2PX)),
        disabled: windKeyed !== null,
        onEmpty: () => {
          for (const b of paths) b.cam.windBuffer = null;
        },
      },
    );
    if (windKeyed) windInput.title = windKeyed;
    framingNum("priority", (b) => b.cam.priority, (b, v) => (b.cam.priority = Math.round(v)), 1);

    appendPathActions(transform, paths, "Reverse the direction of travel - the way the camera leads along this path");

    // The picked nodes' KEYS, when the path is open for vertex editing and
    // some are picked. Under the path's own fields because a key is one of
    // those fields said at one place on the route.
    const sole = paths.length === 1 ? paths[0]! : null;
    if (sole && sole.shape.kind === "path" && vertexEditTarget() === sole) {
      const picked = selectedVertIndices(sole);
      if (picked.length) buildPathNodeKeys(g, sole, picked);
    }

    addActionsRow(g);
    inspector.appendChild(g);
  }

  // A FOG REGION owns its fog (`FogRegion2D`): how thick, what colour, and
  // how far in from its edge it fades up to that.
  function buildFogGroup(regions: EdItem[]): void {
    const group = el("div", "ed-group");
    group.appendChild(heading(regions.length === 1 ? `Fog #${regions[0]!.id}` : `${regions.length} fog regions selected`,
      "Fog is present inside this outline and clear outside it, thickening with distance from the camera. The falloff fades it in from the edge; where regions overlap a surface takes the thickest fog any of them gives it, tinted by each in proportion, never the sum."));
    const transform = section(group, "fog/Transform", "Transform");
    addTransformFields(transform, groupNum(transform, regions), regions);

    const g = section(group, "fog/Fog", "Fog", true);
    const num = groupNum(g, regions);
    // A fraction rather than a density, so it is neither a length nor scaled
    // on the way to disk; stepped in twentieths, since the useful range is the
    // bottom of it. Blank is no fog at all.
    const amount = num(
      "amount",
      (b) => b.fog.amount ?? NaN,
      (b, v) => (b.fog = { ...b.fog, amount: Math.min(1, Math.max(0, v)) }),
      0.05,
      { placeholder: "0", onEmpty: () => { for (const b of regions) b.fog = { ...b.fog, amount: null }; } },
    );
    describe(amount, "How much of the fog colour a surface 20 m from the camera takes on - about where the gameplay plane sits - from 0 (clear) toward 1. Nearer surfaces take less and further ones more, on the exponential law.");
    const cw = fieldRow("colour");
    const fallback = environmentOfModel(model).backgroundColor ?? DEFAULT_ENVIRONMENT.backgroundColor;
    const ci = colorInput(regions[0]!.fog.color ?? fallback, beginAction, (hex) => {
      for (const b of regions) b.fog = { ...b.fog, color: hex };
      markDirty();
    });
    cw.appendChild(ci.el);
    describe(cw, "The air's colour. Unset, it is the level's background.");
    g.appendChild(cw);
    const falloff = num(
      "falloff",
      (b) => (b.fog.falloff ?? DEFAULT_FOG_FALLOFF) * M2PX,
      (b, v) => (b.fog = { ...b.fog, falloff: Math.max(0, v * PX) }),
      10,
    );
    describe(falloff, "Distance in pixels from the outline in to full fog. Zero gives a hard edge.");

    // Rect or circle: the two outlines a fog region may have. The switch keeps
    // the region's extent - a rect becomes the circle that fits its width,
    // a circle the square that holds it.
    const sw = fieldRow("shape");
    const pair = el("span", "ed-pair");
    for (const kind of ["rect", "circle"] as const) {
      const b = button(kind, () => {
        if (regions.every((r) => r.shape.kind === kind)) return;
        beginAction();
        for (const r of regions) {
          const s = r.shape;
          if (kind === "circle" && s.kind === "rect") r.shape = { kind: "circle", r: Math.max(s.w, s.h) / 2 };
          if (kind === "rect" && s.kind === "circle") r.shape = { kind: "rect", w: s.r * 2, h: s.r * 2 };
        }
        markDirty();
        rebuildInspector();
      });
      b.classList.toggle("active", regions.every((r) => r.shape.kind === kind));
      pair.appendChild(b);
    }
    sw.appendChild(pair);
    g.appendChild(sw);
    addActionsRow(group);
    inspector.appendChild(group);
  }

  // A shelter is the cave's front wall, visible only to shadow maps.
  function buildShelterGroup(shelters: EdItem[]): void {
    const group = el("div", "ed-group");
    group.appendChild(
      heading(
        shelters.length === 1 ? `Shelter #${shelters[0]!.id}` : `${shelters.length} shelters selected`,
        "The front wall of an enclosed cave - the wall between the camera and the play space, cut away so the player can be seen - put back for the sun alone. It is never drawn; it casts the sun's shadow, so the sun stops lighting the rock faces facing the camera and the cave's inside. The fill, the environment, the fog and the lamps are untouched. The dotted outline is where its shadow lands on the play plane.",
      ),
    );
    let g = section(group, "shelter/Transform", "Transform");
    addTransformFields(g, groupNum(g, shelters), shelters);

    g = section(group, "shelter/Wall", "Wall");
    const num = groupNum(g, shelters);
    // Blank = the format's default, which a level keeps following until one
    // is typed.
    num(
      "front",
      (b) => (b.shelter.front ?? NaN) * M2PX,
      (b, v) => (b.shelter.front = Math.max(0, v * PX)),
      10,
      {
        placeholder: String(Math.round(DEFAULT_SHELTER_FRONT * M2PX)),
        onEmpty: () => {
          for (const b of shelters) b.shelter.front = null;
        },
      },
    );
    describe(
      g,
      "front: how far in front of the play plane the wall stands. It has to be in front of every rock face it should shade (the river's reach 230 px toward the camera); the further out, the further down and along the sun its shadow lands.",
    );

    addActionsRow(group);
    inspector.appendChild(group);
  }

  // A minecart track (docs/minecarts.md): its line is edited on the canvas as
  // a camera path's is, and its spawner here. Every field blank is the
  // format's default, which a level keeps following until one is typed.
  function buildTrackGroup(tracks: EdItem[]): void {
    const group = el("div", "ed-group");
    group.appendChild(
      heading(
        tracks.length === 1 ? `Track #${tracks[0]!.id}` : `${tracks.length} tracks selected`,
        "A minecart track: carts are sent from its first node along the line to its last, where they turn out of the play plane and are gone. The body under it in the scene tree is the cart every cart is built from - placed on the line where it sits on the rails, which says how high a cart rides. Carts are powered: held by the ball or the chain, they stop and their wheels spin and spark.",
      ),
    );
    let g = section(group, "track/Transform", "Transform");
    addTransformFields(g, groupNum(g, tracks), tracks);
    appendPathActions(g, tracks, "Reverse the direction carts travel - they start from the other end");

    g = section(group, "track/Carts", "Carts");
    const num = groupNum(g, tracks);
    const field = (
      label: string,
      key: Exclude<keyof EdTrack, "exitTurn">,
      toShown: number,
      def: number,
      step: number,
      clamp: (v: number) => number,
    ): void => {
      num(
        label,
        (b) => (b.track[key] ?? NaN) * toShown,
        (b, v) => (b.track[key] = clamp(v / toShown)),
        step,
        {
          placeholder: String(Math.round(def * toShown * 1000) / 1000),
          onEmpty: () => {
            for (const b of tracks) b.track[key] = null;
          },
        },
      );
    };
    field("speed", "speed", M2PX, DEFAULT_TRACK_SPEED, 10, (v) => Math.max(0, v));
    field("interval", "interval", 1, DEFAULT_TRACK_INTERVAL, 0.5, (v) => Math.max(0.1, v));
    field("max", "max", 1, DEFAULT_TRACK_MAX, 1, (v) => Math.max(0, Math.round(v)));
    field("phase", "phase", 1, 0, 0.05, (v) => v - Math.floor(v));
    describe(
      g,
      "speed: the cruise speed, px/s. interval: seconds between spawn slots; a slot whose cart cannot go (the cap is reached, or the start of the line is not clear) is skipped, never delayed, so held-up carts never change the spacing for good. max: the most carts on the track at once. phase: where in a slot the clock starts, 0..1 - two tracks a half apart alternate.",
    );

    g = section(group, "track/Drive", "Drive");
    const drive = groupNum(g, tracks);
    drive(
      "pull",
      (b) => b.track.pull ?? NaN,
      (b, v) => (b.track.pull = Math.max(0, v)),
      50,
      {
        placeholder: `${DEFAULT_TRACK_PULL_G} x weight`,
        onEmpty: () => {
          for (const b of tracks) b.track.pull = null;
        },
      },
    );
    drive(
      "grip",
      (b) => b.track.grip ?? NaN,
      (b, v) => (b.track.grip = Math.max(0, v)),
      0.05,
      {
        placeholder: String(WHEEL_STATIC_FRICTION),
        onEmpty: () => {
          for (const b of tracks) b.track.grip = null;
        },
      },
    );
    // What the grip buys, said as the angle an author draws the line at.
    const climb = (): string => {
      const angles = tracks.map((b) => (Math.atan(b.track.grip ?? WHEEL_STATIC_FRICTION) * 180) / Math.PI);
      const lo = Math.min(...angles);
      const hi = Math.max(...angles);
      return lo === hi ? `${lo.toFixed(0)}°` : `${lo.toFixed(0)}-${hi.toFixed(0)}°`;
    };
    const climbRow = fieldRow("steepest climb");
    const climbVal = document.createElement("span");
    climbVal.textContent = climb();
    climbRow.appendChild(climbVal);
    g.appendChild(climbRow);
    readouts.push({ el: climbVal, get: climb });
    const wheel = (label: string, key: "wheelBase" | "wheelRadius" | "exitRadius", def: number): void => {
      drive(
        label,
        (b) => (b.track[key] ?? NaN) * M2PX,
        (b, v) => (b.track[key] = Math.max(1, v) * PX),
        5,
        {
          placeholder: String(Math.round(def * M2PX)),
          onEmpty: () => {
            for (const b of tracks) b.track[key] = null;
          },
        },
      );
    };
    wheel("wheel base", "wheelBase", DEFAULT_TRACK_WHEEL_BASE);
    wheel("wheel radius", "wheelRadius", DEFAULT_TRACK_WHEEL_RADIUS);
    describe(
      g,
      "pull: the most the motor pulls with at the rims, newtons; past what the wheels' grip on the rail can pass on, they slip and spark. grip: the wheels' friction on this track's rail (0.35 is steel on steel); a cart climbs no slope steeper than the angle shown, whatever its pull, and a held cart pushes with 0.7 x grip x its weight while its wheels spin. wheel base and wheel radius: px, the cart model's own.",
    );

    // The way out: drawn only, after the sim has let the cart go.
    g = section(group, "track/Exit", "Exit");
    const exitNum = groupNum(g, tracks);
    exitNum(
      "bend",
      (b) => (b.track.exitRadius ?? NaN) * M2PX,
      (b, v) => (b.track.exitRadius = Math.max(1, v) * PX),
      10,
      {
        placeholder: String(Math.round(DEFAULT_TRACK_EXIT_RADIUS * M2PX)),
        onEmpty: () => {
          for (const b of tracks) b.track.exitRadius = null;
        },
      },
    );
    exitNum(
      "depth",
      (b) => (b.track.exitDepth ?? NaN) * M2PX,
      (b, v) => (b.track.exitDepth = Math.max(0, v) * PX),
      10,
      {
        placeholder: "0",
        onEmpty: () => {
          for (const b of tracks) b.track.exitDepth = null;
        },
      },
    );
    const turnRow = fieldRow("turn");
    const turnSel = document.createElement("select");
    turnSel.className = "ed-select";
    for (const [value, label] of [
      ["", "on (the way it was going)"],
      ["left", "left"],
      ["right", "right"],
    ] as const) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      turnSel.appendChild(o);
    }
    const turns = new Set(tracks.map((b) => b.track.exitTurn ?? ""));
    if (turns.size > 1) {
      const o = document.createElement("option");
      o.value = "mixed";
      o.textContent = "mixed";
      o.disabled = true;
      turnSel.appendChild(o);
    }
    turnSel.value = turns.size === 1 ? [...turns][0]! : "mixed";
    turnSel.addEventListener("change", () => {
      if (turnSel.value === "mixed") return;
      beginAction();
      for (const b of tracks) b.track.exitTurn = turnSel.value === "left" || turnSel.value === "right" ? turnSel.value : null;
      markDirty();
    });
    turnRow.appendChild(turnSel);
    g.appendChild(turnRow);
    describe(
      g,
      "Past the end of the line the drawn cart turns away from the camera on a bend of this radius (px), runs depth (px) straight on into the rock, then turns again to run sideways - left, right, or on the way it was going - and is gone behind the scenery. Drawn only: the ball and the chain were let go at the end of the line.",
    );

    addActionsRow(group);
    inspector.appendChild(group);
  }


  // Three whole-path actions, because each is miserable to do node by node.
  function appendPathActions(g: HTMLElement, paths: EdItem[], reverseTitle: string): void {
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
    act("Reverse", reverseTitle, (b) => void reversePathVerts(b));
    act(
      "Smooth",
      "Round every corner: each node gets the tangent that carries the curve through it (drag a node's round grips to shape one by hand)",
      (b) => void smoothPathNodes(b),
    );
    act("Sharpen", "Drop every tangent - the path is its corners again", (b) =>
      void sharpenPathNodes(b),
    );
    g.appendChild(row);
  }

  // The keyframe fields of a path's picked nodes (see `CameraPathVert`). Each
  // is the path-level field of the same name said at THIS node: blank is no
  // key, and the placeholder is the value the node has anyway - the path's own
  // when nothing keys the field, the interpolation's when other nodes do - so
  // typing a key starts from what it is replacing.
  function buildPathNodeKeys(g: HTMLElement, item: EdItem, picked: number[]): void {
    if (item.shape.kind !== "path") return;
    const shape = item.shape;
    g = section(g, "campath/Node", picked.length === 1 ? `Node ${picked[0]}` : `${picked.length} nodes`);
    describe(g,
      "Keys: the path's fields, said at these nodes. A keyed field is interpolated along the route between its keyed nodes and held beyond the first and last; a node with no key is transparent to it, and a field no node keys is the path's own. View, lead and reaction are read where the lead is measured from, so a swing across a change does not pump the camera; range, falloff and buffer are read at the player's nearest point on the route, and the corridor is drawn as they vary. Blank drops the key.");

    // What each picked node is effectively at, through the SAME rule the game
    // builds - so the placeholder is the number the camera would use there.
    const rule = buildCameraRules([], [pathDataOf(item)])[0];
    const effective = (f: PathKeyField): number[] =>
      rule?.kind === "path"
        ? picked.map((i) => pathParamsAt(rule, rule.index.nodeS[i] ?? 0)[f])
        : [];
    const field = (label: string, f: PathKeyField, toShown: number, step: number): void => {
      const eff = effective(f).map((v) => v * toShown);
      const agreed =
        eff.length && eff.every((v) => Math.abs(v - eff[0]!) < 1e-9) ? fmt(eff[0]!) : "mixed";
      numField(
        g,
        label,
        () => {
          const vals = picked.map((i) => shape.keys[i]?.[f] ?? null);
          const first = vals[0] ?? null;
          return first !== null && vals.every((v) => v === first) ? first * toShown : null;
        },
        (v) => {
          for (const i of picked) {
            const k = (shape.keys[i] ??= NO_KEY());
            k[f] = f === "viewportScale" ? Math.min(10, Math.max(0.1, v)) : Math.max(0, v / toShown);
          }
        },
        step,
        picked.length > 1,
        {
          placeholder: agreed,
          onEmpty: () => {
            for (const i of picked) if (shape.keys[i]) shape.keys[i]![f] = null;
          },
        },
      );
    };
    field("range x", "rangeX", M2PX, 10);
    field("range y", "rangeY", M2PX, 10);
    field("falloff x", "falloffX", M2PX, 10);
    field("falloff y", "falloffY", M2PX, 10);
    field("lead x", "lookaheadX", M2PX, 10);
    field("lead y", "lookaheadY", M2PX, 10);
    field("lead buf x", "lookaheadBufferX", M2PX, 10);
    field("lead buf y", "lookaheadBufferY", M2PX, 10);
    field("view ×", "viewportScale", 1, 0.1);
    field("buffer", "buffer", M2PX, 10);
    field("reaction s", "reactionTime", 1, 0.05);
    field("wind buf", "windBuffer", M2PX, 10);
  }

  // Lights-layer panel. The two fields that matter most are at the top and in
  // this order on purpose: what KIND of source it is, and how far it REACHES.
  // Falloff is inverse-square, so past a couple of metres a brighter lamp is
  // barely a wider pool - the reach is what says where the lit part of the level
  // ends, and therefore what does the framing.
  function buildLightsGroup(lights: EdItem[]): void {
    const g = el("div", "ed-group");
    const title = heading(
      lights.length === 1 ? `Light #${lights[0]!.id}` : `${lights.length} lights selected`,
      "Lights the 3D scene from inside the level, with no visible source of its own - a shaft down a grate, a fill, a spot, or the one light that has to cast a shadow. A lamp the player can SEE is a shape carrying an emissive on the geometry layer, which throws its own light and cannot drift away from it. Set the level's sun intensity to 0 (and env intensity near 0) for an interior.",
    );
    g.appendChild(title);
    // A warning is put under the title rather than in a section, so a
    // collapsed section cannot hide it.
    let warnAt: Element = title;
    const warn = (text: string): void => {
      const w = el("div", "ed-hint ed-warn");
      w.textContent = text;
      warnAt.after(w);
      warnAt = w;
    };
    const transform = section(g, "light/Transform", "Transform");
    const light = section(g, "light/Light", "Light");

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
    kindSel.addEventListener("change", () => {
      beginAction();
      const kind = kindSel.value as "point" | "spot";
      // A waking light is point-only (the pool that serves it is point
      // lights), so turning one into a spot takes its wake with it - said in
      // the status line, since the fields that showed it are about to go.
      let slept = 0;
      for (const b of lights) {
        b.light.kind = kind;
        if (kind === "spot" && b.light.wake > 0) {
          b.light.wake = 0;
          slept++;
        }
      }
      markDirty();
      if (slept > 0) flashNotice(`a spot cannot wake: cleared the wake on ${slept} light${slept === 1 ? "" : "s"}`);
      rebuildInspector(); // the cone fields appear or go
    });
    const kw = fieldRow("kind");
    kw.appendChild(kindSel);
    describe(kw, "point throws in every direction; spot is a cone (a shaft through a grate)");
    transform.appendChild(kw);

    addTransformFields(transform, groupNum(transform, lights), lights); // x, y and the reach (labelled "range")
    let num = groupNum(light, lights);
    addColorField(light, lights, "color");
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

    const lightNum = num;
    if (lights.every((b) => b.light.kind === "point")) {
      num = groupNum(section(g, "light/Wake", "Wake"), lights);

      // A WAKING light (see `LightObjectData.wake`): dark until the ball comes
      // within `wake`, then rising to its intensity with the glowing shapes of
      // its body. Canvas pixels here like the reach, metres on disk; blank or 0
      // is a light that is always on. The canvas draws the wake as a dashed
      // ring outside the reach; the 3D preview shows every waking light AWAKE.
      const wakeInput = num(
        "wake",
        (b) => (b.light.wake > 0 ? b.light.wake * M2PX : NaN),
        (b, v) => (b.light.wake = Math.max(0, v * PX)),
        10,
        {
          placeholder: "always on",
          onEmpty: () => {
            for (const b of lights) b.light.wake = 0;
          },
        },
      );
      // Set or cleared, the times appear or go and the shadow box greys or
      // not - rebuilt once the value is committed rather than per keystroke,
      // which would take the caret out of the field being typed into.
      wakeInput.addEventListener("change", () => rebuildInspector());
      if (lights.every((b) => b.light.wake > 0)) {
        // Seconds, floored at 0; blank is the renderer's default (no delay,
        // DEFAULT_WAKE_RISE, DEFAULT_WAKE_FALL).
        const secs = (
          label: string,
          get: (l: EdLight) => number | null,
          set: (l: EdLight, v: number | null) => void,
          fallback: string,
        ): void => {
          num(
            label,
            (b) => get(b.light) ?? NaN,
            (b, v) => set(b.light, Math.max(0, v)),
            0.05,
            {
              placeholder: fallback,
              onEmpty: () => {
                for (const b of lights) set(b.light, null);
              },
            },
          );
        };
        secs("delay s", (l) => l.wakeDelay, (l, v) => (l.wakeDelay = v), "0");
        secs("rise s", (l) => l.wakeRise, (l, v) => (l.wakeRise = v), String(DEFAULT_WAKE_RISE));
        secs("fall s", (l) => l.wakeFall, (l, v) => (l.wakeFall = v), String(DEFAULT_WAKE_FALL));
      }
    }

    if (lights.every((b) => b.light.kind === "spot")) {
      num = groupNum(section(g, "light/Spot", "Spot"), lights);
      // The cone made visible, beside the flicker it flickers with: how much
      // the lit air shows, and how thick the dust drifting in it is. The 3D
      // view shows both; the 2D canvas does not draw the cone.
      num("beam", (b) => b.light.beam, (b, v) => (b.light.beam = Math.min(1, Math.max(0, v))), 0.05);
      num("dust", (b) => b.light.dust, (b, v) => (b.light.dust = Math.min(1, Math.max(0, v))), 0.05);
      num("cone°",(b) => b.light.angle, (b, v) => (b.light.angle = Math.min(89, Math.max(1, v))), 5);
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
    // A waking light casts none, whatever it says: it is served by a pool light
    // handed between sources as they wake, and a shadow map swapped with it
    // would flash (see `render3d/lights.ts`). The box stays, greyed, so the
    // authored flag is visible and survives turning the wake off again.
    const waking = lights.some((b) => b.light.kind === "point" && b.light.wake > 0);
    shadowBox.disabled = waking;
    const sw = fieldRow("shadows");
    if (waking) {
      describe(sw, "A waking light casts no shadow (the pool lights that serve it cast none).");
      sw.style.opacity = "0.5";
    }
    sw.appendChild(shadowBox);
    light.appendChild(sw);
    num = lightNum;
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
      // How soft the shadow's edge is, in shadow-map texels: the sun's soft
      // edge authored per lamp (see `LightObjectData.shadowRadius`); blank is
      // the renderer's default, a near-hard edge.
      num(
        "shadow soft",
        (b) => b.light.shadowRadius ?? NaN,
        (b, v) => (b.light.shadowRadius = Math.max(0, v)),
        0.5,
        {
          placeholder: String(LIGHT_SHADOW_RADIUS),
          onEmpty: () => {
            for (const b of lights) b.light.shadowRadius = null;
          },
        },
      );
    }
    const budget = model.items.filter(
      (b) => b.object === "light" && b.light.castShadow,
    ).length;
    if (budget > LIGHT_SHADOW_BUDGET) {
      warn(
        `${budget} lights ask for shadows and only the first ${LIGHT_SHADOW_BUDGET} get them; the rest still light the scene.`,
      );
    }

    addActionsRow(g);
    inspector.appendChild(g);
  }

  // The live note field, so a freshly placed note can be typed into without a
  // trip to the inspector: a text note's prose textarea, or a checkpoint's name
  // input - both are the one piece of writing their item is placed FOR, and both
  // are reached by the same placement and double-click gestures. Null whenever
  // the panel shows no single item with one.
  let noteText: HTMLTextAreaElement | HTMLInputElement | null = null;

  // Put the caret in that field, at the end of whatever is already written.
  // It is scrolled into view because the inspector is a scrolling stack of
  // per-layer panels, so the note's panel need not be on screen.
  function focusNoteText(): void {
    if (!noteText) return;
    // It is in a section like every other field, which may be collapsed.
    revealInSection(noteText);
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
    const tied = model.chains.filter((c) => anchors.some((a) => c.a === a.id || c.b === a.id));
    const routed = model.chains.filter((c) => anchors.some((a) => c.via.includes(a.id)));
    const held = tied.length + routed.filter((c) => !tied.includes(c)).length;
    const title = heading(
      anchors.length === 1
        ? `Anchor #${anchors[0]!.anchorId}`
        : `${anchors.length} anchors selected`,
      anchors.length === 1
        ? `${tied.length ? "A chain's tie point on this body" : "A chain's wrap point on this body - a corner the chain bends around"}. It is an object IN the body, so it rides it: moving or turning the body moves the anchor, and the chain follows without anything being re-derived. ${held === 1 ? "One chain" : `${held} chains`} ${tied.length ? "tied here" : "routed over it"}.`
        : "Chain tie and wrap points. Each is an object in its body and rides it; the chains follow.",
    );
    g.appendChild(title);

    const transform = section(g, "anchor/Transform", "Transform");
    addTransformFields(transform, groupNum(transform, anchors), anchors);
    // No fill, no material, no look: an anchor is a point. Its canvas mark is the
    // ring its chain already draws at it, which is also the handle that drags it.
    addGroupSection(g, title);
    addActionsRow(g);
    inspector.appendChild(g);
  }

  // MODELS (`ModelObjectData`): a model of the library placed on the body, which
  // carries it. Its own fields are which model, its depth, its tilts out of the
  // plane and its size; where it is and its turn in the plane are the
  // transform every object has.
  function buildModelsGroup(items: EdItem[]): void {
    const g = el("div", "ed-group");
    const first = items[0]!;
    const title = heading(
      items.length === 1 ? `Model ${first.modelRef.name || "(none)"} #${first.id}` : `${items.length} models selected`,
      "A 3D model of the library (assets-src/models/<model>.blend, exported by `just model <model>`), drawn on this body and carried by it - a lantern on its chain, a crate, a mover's platform. Appearance only: what the body collides as is its collision objects, drawn by hand. The model's origin is the point placed here, modelled in Blender's front view (-y toward the camera).",
    );
    g.appendChild(title);
    const transform = section(g, "model/Transform", "Transform");
    addTransformFields(transform, groupNum(transform, items), items);
    const look = section(g, "model/Model", "Model");

    // Which model: typed, and offered the models exported here or published.
    const names = new Set(items.map((b) => b.modelRef.name));
    // The model picked is the one `+ Model` places next.
    if (names.size === 1 && first.modelRef.name) lastModelName = first.modelRef.name;
    const input = document.createElement("input");
    input.className = "ed-text";
    input.value = names.size === 1 ? first.modelRef.name : "";
    input.placeholder = names.size === 1 ? "none" : "mixed";
    const list = document.createElement("datalist");
    list.id = `ed-models-${first.id}`;
    input.setAttribute("list", list.id);
    const fillList = (): void => {
      list.replaceChildren();
      for (const n of modelNamesFor(fillList)) {
        const o = document.createElement("option");
        o.value = n;
        list.appendChild(o);
      }
    };
    fillList();
    let edited = false;
    input.addEventListener("blur", () => (edited = false));
    input.addEventListener("input", () => {
      if (!edited) {
        beginAction();
        edited = true;
      }
      // Held to what a model may be called as it is typed, as the scene field is.
      const text = input.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "");
      if (text !== input.value) input.value = text;
      const name = text.replace(/-+$/, "");
      for (const b of items) b.modelRef.name = name;
      if (name) lastModelName = name;
      markDirty();
      hint.textContent = hintText();
    });
    const nw = fieldRow("model");
    nw.append(input, list);
    describe(nw, "The model's name: assets-src/models/<model>.blend. The list offers every model exported here (`just model <model>`) or published.");
    look.appendChild(nw);
    const hint = el("div", "ed-hint");
    const hintText = (): string => {
      if (items.length > 1 && new Set(items.map((b) => b.modelRef.name)).size > 1) return "Several models.";
      const name = first.modelRef.name;
      if (!name) return "No model: nothing is drawn. Type or pick one.";
      if (!isModelName(name)) return `"${name}" is not a model name.`;
      if (mushroomParameters(name)) return "Procedural mushroom · edit dimensions below · no model export needed";
      const meta = modelMetaFor(name, () => (hint.textContent = hintText()));
      if (meta === undefined) return `Looking for /models/${name}/meta.json…`;
      if (meta === null) return `Not exported here: run \`just model ${name}\` (assets-src/models/${name}.blend).`;
      const size = meta.bounds ? meta.bounds.max.map((v, k) => (v - meta.bounds!.min[k]!).toFixed(2)).join(" × ") : "empty";
      return `${meta.triangles.toLocaleString()} triangles, ${size} m, exported ${meta.exportedAt.slice(0, 16).replace("T", " ")}` +
        (MODEL_ASSETS[name]?.sha256 === meta.sha256 ? "" : ", not published (`just publish`)") +
        (meta.warnings.length ? `. ${meta.warnings.length} exporter warning(s), see meta.json` : "");
    };
    hint.textContent = hintText();
    look.appendChild(hint);

    const num = groupNum(look, items);
    const deg = (r: number): number => Math.round(((r * 180) / Math.PI) * 1e6) / 1e6;
    // Off the body's plane, toward the camera, in the inspector's own units.
    const z = num("z", (b) => b.modelRef.z * M2PX, (b, v) => (b.modelRef.z = v * PX), 10);
    describe(z.parentElement!, "How far the model's origin sits off the body's plane, toward the camera (the depth handle and the gizmo's blue arrow drag it).");
    const tx = num("tilt x°", (b) => deg(b.modelRef.rotX), (b, v) => (b.modelRef.rotX = (v * Math.PI) / 180), 15);
    describe(tx.parentElement!, "Turned about the screen's horizontal axis before its turn in the plane: positive tips its top toward the camera.");
    const ty = num("tilt y°", (b) => deg(b.modelRef.rotY), (b, v) => (b.modelRef.rotY = (v * Math.PI) / 180), 15);
    describe(ty.parentElement!, "Turned about the screen's vertical axis before its turn in the plane: positive brings its right side toward the camera.");
    const sc = num("scale", (b) => b.modelRef.scale, (b, v) => {
      b.modelRef.scale = Math.max(MODEL_MIN_SCALE, v);
      const params = mushroomParameters(b.modelRef.name, b.modelRef.mushroom);
      if (params) resizeMushroom(model, b, "width", params.width);
    }, 0.1);
    describe(sc.parentElement!, "Its size against the size it was modelled at.");

    if (items.every(b => mushroomParameters(b.modelRef.name))) {
      const shape = section(g, "model/Mushroom", "Mushroom shape");
      const control = groupNum(shape, items);
      for (const [key, label] of [["width", "cap width"], ["capHeight", "cap height"], ["stemHeight", "stem height"]] as [keyof MushroomParameters, string][]) {
        const field = control(label, b => mushroomParameters(b.modelRef.name, b.modelRef.mushroom)![key],
          (b, v) => resizeMushroom(model, b, key, v), .05);
        describe(field.parentElement!, "Metres before model scale. Lower cap height makes a flatter cap; higher makes a rounded bell. Updates the body's single cap collision too.");
      }
    }

    addGroupSection(g, title);
    addActionsRow(g);
    inspector.appendChild(g);
  }

  // A FORMATION selected on its own (`EdFormation`, docs/formations.md): where
  // it stands in its body, and its Formation section, which is the same one
  // its body's panel shows.
  function buildFormationGroup(items: EdItem[]): void {
    const g = el("div", "ed-group");
    const first = items[0]!;
    const title = heading(
      items.length === 1 ? `Formation ${first.formation?.id ?? ""} #${first.id}` : `${items.length} formations selected`,
      "Rock generated from a guide in this body (docs/formations.md), drawn on the body and carried by it. Its recipe is in the level; what it built is in the store, named by the recipe. Appearance only: what the body collides as is its collision, which only \"Fit collision to geometry\" ever writes from the rock.",
    );
    g.appendChild(title);
    const transform = section(g, "formation/Transform", "Transform");
    addTransformFields(transform, groupNum(transform, items), items);
    if (items.length === 1 && workspace === "formations") buildFormationSection(formationHost, section(g, "formation/Formation", "Formation"), first.unit);
    if (items.length === 1 && workspace === "decorations") decorations.buildList(section(g, "formation/Decorations", "Decorations"), first);
    if (items.length === 1 && workspace === "texturing") decorations.buildList(section(g, "formation/Materials", "Materials"), first, true);
    addGroupSection(g, title);
    addActionsRow(g);
    inspector.appendChild(g);
  }

  // A DECORATION selected (`EdDecoration`, docs/formations.md): what it is,
  // whether it is grown, its seed and settings, and its brush if painted.
  function buildDecorationGroup(items: EdItem[]): void {
    const g = el("div", "ed-group");
    const first = items[0]!;
    const dec = first.decoration!;
    const title = heading(
      items.length === 1 ? `${decorationLabel(dec)} ${dec.id}` : `${items.length} decorations selected`,
      dec.kind === "material"
        ? "A material from the library (assets-src/materials, a Blender Principled BSDF) baked onto its formation's rock and laid on where it is painted. Its strokes are tied to the formation's guide, so it follows the rock through a regenerate, and it is baked again whenever its paint, its material or its rock changes."
        : "Grown on its formation's rock by the decoration add-ons (moss, ivy, foliage) and tied to the formation's guide, so it follows the rock through a regenerate. A placed one is grown once and dragged along the rock; a painted one is grown again whenever its paint or its rock changes.",
    );
    g.appendChild(title);
    if (items.length === 1) decorations.buildGroup(section(g, "decoration/Decoration", dec.kind === "material" ? "Material layer" : "Decoration"), first);
    addGroupSection(g, title);
    addActionsRow(g);
    inspector.appendChild(g);
  }

  function buildNotesGroup(notes: EdItem[]): void {
    const g = el("div", "ed-group");
    const allCheckpoints = notes.every((n) => n.note.kind === "checkpoint");
    // The two things this layer holds are used for opposite things, so the help
    // says which one is selected rather than describing the layer.
    g.appendChild(
      heading(
        notes.length === 1
          ? allCheckpoints
            ? `Checkpoint #${notes[0]!.id}`
            : `Note #${notes[0]!.id}`
          : `${notes.length} ${allCheckpoints ? "checkpoints" : "notes"} selected`,
        allCheckpoints
          ? "A named place to start from. Play with ?checkpoint=NAME to spawn here instead of at the level's spawn - a killzone reset comes back here too, so an area can be played over and over. Selecting one and pressing ▶ Test starts the test here. Invisible in play."
          : "Editor-only: notes record why geometry is placed as it is, so it isn't later removed as arbitrary. They never appear in play.",
      ),
    );

    if (allCheckpoints && notes.length === 1) {
      const n = notes[0]!;
      const name = section(g, "notes/Name", "Name");
      describe(name, "What ?checkpoint= asks for. Matched trimmed and ignoring case.");
      const input = document.createElement("input");
      input.className = "ed-text";
      input.value = n.note.text;
      input.placeholder = "name";
      // The URL this checkpoint is reached by, written out in full: the name is
      // half of a query string, and a name that has to be assembled by hand into
      // one is a name that gets mistyped.
      //
      // It is also where the two ways a name fails are reported. Nothing on disk
      // drops either of them (see `scaleLevelData`), because both are ordinary
      // mid-edit states: a marker is placed before it is named, and a name is
      // typed one letter at a time past an existing one. The place to say so is
      // the panel the author is looking at, live.
      const url = el("div", "ed-hint");
      const updateUrlHint = (): void => {
        const named = n.note.text.trim();
        if (!named) {
          url.textContent = "Unnamed: nothing can ask for this checkpoint yet.";
          return;
        }
        const twin = model.items.some(
          (i) =>
            i !== n && isCheckpointNote(i) && i.note.text.trim().toLowerCase() === named.toLowerCase(),
        );
        url.textContent = twin
          ? `Another checkpoint is already called "${named}", and ?checkpoint= finds the first one. Rename one of them.`
          : `/?level=${currentName ?? "..."}&checkpoint=${encodeURIComponent(named)}`;
      };
      // One undo step per editing session, snapshotted on the first keystroke,
      // exactly as the note textarea does it and for the same reason: placing a
      // checkpoint focuses this, and a focus-time snapshot would make the first
      // Ctrl+Z a visible no-op.
      let edited = false;
      input.addEventListener("blur", () => (edited = false));
      input.addEventListener("input", () => {
        if (!edited) {
          beginAction();
          edited = true;
        }
        // A name is a URL parameter, so it is kept to one line: the field is an
        // input rather than a textarea, and a paste carrying newlines or edge
        // whitespace is cleaned rather than saved as a name nothing can type.
        n.note.text = input.value.replace(/\s+/g, " ").trim();
        markDirty();
        updateUrlHint();
      });
      noteText = input;
      name.appendChild(input);
      updateUrlHint();
      name.appendChild(url);
    } else if (allCheckpoints) {
      const many = el("div", "ed-hint");
      many.textContent = "Select one checkpoint to name it.";
      g.appendChild(many);
    }

    const allText = notes.every((n) => n.note.kind === "text");
    const allArrows = notes.every((n) => n.note.kind === "arrow");
    const text = allText ? section(g, "notes/Text", "Text") : null;
    if (text && notes.length === 1) {
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
      text.appendChild(ta);
    } else if (text) {
      // Merging prose across a group has no sane meaning, so the text stays a
      // single-selection edit while placement stays group-wide.
      const many = el("div", "ed-hint");
      many.textContent = "Select one note to edit its text.";
      text.appendChild(many);
    }
    if (text) {
      groupNum(text, notes)("text px", (b) => b.note.size * M2PX, (b, v) => (b.note.size = Math.max(4, v) * PX), 1);
    }

    const transform = section(g, "notes/Transform", "Transform");
    const num = groupNum(transform, notes);
    addTransformFields(transform, num, notes);
    if (allArrows) {
      num("length", (b) => (b.shape.kind === "rect" ? b.shape.w * M2PX : 0), (b, v) => {
        if (b.shape.kind === "rect") b.shape.w = Math.max(MIN_ARROW_LENGTH, v * PX);
      });
    }

    addActionsRow(g);
    inspector.appendChild(g);
  }

  // THE LEVEL'S LIGHT (format 4): the `Sun` and `Environment` nodes' own
  // fields, held in the node's `extra` (`skyFields`). Reads fall back to the
  // renderer's defaults, so a field shows what the level actually looks like
  // rather than a blank; a node that authors nothing writes no field.
  type EnvKey = keyof EnvironmentData & string;
  function lightFieldHelpers(g: HTMLElement, n: EdNode) {
    const cur = (k: EnvKey): number | string | boolean => (n.extra[k] ?? DEFAULT_ENVIRONMENT[k]) as number | string | boolean;
    const numEnv = (label: string, key: EnvKey, step: number, clamp?: (v: number) => number): HTMLInputElement =>
      numField(g, label, () => cur(key) as number, (v) => (n.extra = { ...n.extra, [key]: clamp ? clamp(v) : v }), step);
    const colorEnv = (label: string, key: EnvKey): HTMLElement => {
      const cw = fieldRow(label);
      const ci = colorInput(cur(key) as string, beginAction, (hex) => {
        n.extra = { ...n.extra, [key]: hex };
        markDirty();
      });
      cw.appendChild(ci.el);
      g.appendChild(cw);
      return cw;
    };
    const drop = (...keys: EnvKey[]): void => {
      const next = { ...n.extra };
      for (const k of keys) delete next[k];
      n.extra = next;
    };
    return { cur, numEnv, colorEnv, drop };
  }
  const nonNeg = (v: number): number => Math.max(0, v);

  // THE SUN: a light at infinity, so it reaches everything in frame equally -
  // right outdoors, wrong underground, where a level deletes its Sun (or turns
  // it to 0) and is lit by its own lamps alone.
  function buildSunGroup(n: EdNode): void {
    const g = section(inspector, "light/Sun", "Sun", true);
    const { numEnv, colorEnv } = lightFieldHelpers(g, n);
    describe(g, "The level's sunlight: a light at infinity that casts the shadows. Delete this node (or turn it to 0) and the level is lit only by its own lights - how an underground level is made.");
    numEnv("intensity", "sunIntensity", 0.1, nonNeg);
    colorEnv("colour", "sunColor");
    // The direction the sunlight TRAVELS, in the sim's frame: +x right, +y down,
    // +z toward the camera. Not normalised and not a length, so it neither
    // scales nor needs to be typed to any particular magnitude.
    describe(numEnv("dir x", "sunX", 0.1), "The way the light travels, +x to the right. Not normalised: only the direction counts.");
    describe(numEnv("dir y", "sunY", 0.1), "The way the light travels, +y down the screen.");
    describe(numEnv("dir z", "sunZ", 0.1), "The way the light travels, +z toward the camera: negative shines into the scene from in front.");
  }

  // THE ENVIRONMENT: the sky the level is lit and reflected by, and the
  // hemisphere fill.
  function buildEnvironmentGroup(n: EdNode): void {
    const g = section(inspector, "light/Environment", "Environment", true);
    const { cur, numEnv, colorEnv, drop } = lightFieldHelpers(g, n);
    describe(g, "The sky the level is lit and reflected by, and the fill from above and below. Drop `env ×` near 0 and a surface out of reach of the level's own lights goes dark, which an interior wants.");
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
    const sw = fieldRow("sky hdr");
    const ss = document.createElement("select");
    ss.className = "ed-select";
    const skies = new Set(hdriNames());
    const named = (cur("hdri") || "") as string;
    if (named) skies.add(named);
    for (const key of ["", ...[...skies].sort()]) {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = key ? (HDRI_ASSETS[key]?.label ?? key) : "(generated)";
      ss.appendChild(o);
    }
    ss.value = named;
    ss.addEventListener("change", () => {
      if (ss.value === named) return;
      beginAction();
      if (ss.value) n.extra = { ...n.extra, hdri: ss.value };
      // The two fields that only mean anything against a capture go with it,
      // rather than sitting in the file describing a sky the level no longer
      // names.
      else drop("hdri", "hdriRotation", "hdriBackground");
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
      const bw = fieldRow("hdr bg");
      const bb = document.createElement("input");
      bb.type = "checkbox";
      bb.checked = cur("hdriBackground") === true;
      describe(
        bw,
        "Draw the sky behind the level as well as reflecting it. A 1k capture is ample for the reflection and visibly soft as a background - re-optimise it larger before leaning on this.",
      );
      bb.addEventListener("change", () => {
        beginAction();
        if (bb.checked) n.extra = { ...n.extra, hdriBackground: true };
        else drop("hdriBackground");
        markDirty();
      });
      bw.appendChild(bb);
      g.appendChild(bw);
    }

    if (ENVIRONMENT_FIELDS.some((k) => n.extra[k] !== undefined)) {
      const row = el("div", "ed-row");
      const clear = button("Use defaults", () => {
        beginAction();
        drop(...ENVIRONMENT_FIELDS);
        markDirty();
        rebuildInspector();
      });
      clear.title = "Clear every field this node authors and take the renderer's own sky and fill";
      row.appendChild(clear);
      g.appendChild(row);
    }
  }

  function rebuildInspector(): void {
    try {
      buildInspector();
    } finally {
      // The builders open a section per concern before they know whether any
      // field of it applies; the ones left empty go here, whichever way the
      // build returned - and the ones the workspace does not show.
      pruneEmptySections(inspector, (key) => sectionShown(workspace, key));
      refreshWorkspaceDock();
      // The window is drawn only while it has something to say.
      inspector.hidden = inspector.childElementCount === 0;
      // The right dock's prefab pane and the top bar's level settings read the
      // model too, and every change of it comes through here.
      if (prefabsShown) buildPrefabsGroup();
      refreshDocButtons();
      refreshLevelSettings();
    }
  }

  // THE NODE SECTION: what every node has (plans/node-tree.md "The model") -
  // its name (a label, unique among its siblings), its class and path, whether
  // it is grouped, and which data layers it is in.
  function addNodeSection(id: string): void {
    const n = model.tree.nodes.get(id);
    if (!n) return;
    const g = section(inspector, "node/Node", "Node", true);
    const nameRow = fieldRow("name");
    const name = document.createElement("input");
    name.className = "ed-text";
    name.value = n.name;
    name.addEventListener("change", () => {
      const text = name.value.replace(/\s+/g, " ").trim();
      if (!text || text === n.name) return;
      beginAction();
      renameNode(model.tree, id, text);
      markDirty();
      rebuildInspector();
    });
    name.addEventListener("keydown", (e) => e.stopPropagation());
    nameRow.appendChild(name);
    describe(nameRow, "A label for this node, unique among its siblings (a clash takes the next free number). What the scene tree and the replay tools' paths show. Never what anything refers to it by: that is its id.");
    g.appendChild(nameRow);
    const what = fieldRow("class", "div");
    const type = n.body ? bodyNodeType(n.body) : n.type;
    what.appendChild(document.createTextNode(`${type}${n.instance ? ` of ${n.instance.prefab}` : ""}`));
    describe(what, `${pathOf(model.tree, id)} (id ${id})`);
    g.appendChild(what);
    const groupRow = fieldRow("grouped");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = n.grouped;
    box.addEventListener("change", () => {
      beginAction();
      n.grouped = box.checked;
      markDirty();
      rebuildInspector();
    });
    groupRow.appendChild(box);
    describe(groupRow, "A click on the canvas selects this first; a second click goes inside (Ctrl+G, Ctrl+Shift+G). Changes nothing in the level but what a click picks.");
    g.appendChild(groupRow);
    const lockRow = fieldRow("locked");
    const lockBox = document.createElement("input");
    lockBox.type = "checkbox";
    const above = lockedBy(id);
    lockBox.checked = n.locked || above !== null;
    lockBox.disabled = above !== null;
    lockBox.addEventListener("change", () => setNodesLocked([id], lockBox.checked));
    lockRow.appendChild(lockBox);
    describe(
      lockRow,
      above
        ? `Locked with ${above.name}, above it. Unlock that to pick this on the canvas again.`
        : "The canvas does not pick this or anything under it (Ctrl+L, Ctrl+Shift+L); the scene tree still selects it. Changes nothing in the level but what a click picks.",
    );
    g.appendChild(lockRow);
    if (model.dataLayers.length) {
      const layersRow = fieldRow("layers", "div");
      const inherited = new Set(ancestors(model.tree, id).flatMap((a) => a.layers));
      for (const l of model.dataLayers) {
        const chip = document.createElement("label");
        chip.className = "ed-chip";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = n.layers.includes(l) || inherited.has(l);
        cb.disabled = inherited.has(l);
        cb.addEventListener("change", () => {
          beginAction();
          n.layers = cb.checked ? [...n.layers, l] : n.layers.filter((x) => x !== l);
          markDirty();
          rebuildInspector();
        });
        chip.append(cb, document.createTextNode(l));
        layersRow.appendChild(chip);
      }
      describe(layersRow, "The data layers this node is in. One its parent is in it is in too (greyed).");
      g.appendChild(layersRow);
    }
  }

  // A NODE THAT IS NOT A BODY: a group in the plane, a frame in the scene, a
  // folder, a placed prefab. Its node section and where it stands; moving it
  // carries everything under it.
  function buildNodePanel(n: EdNode): void {
    addNodeSection(n.id);
    if (n.type === "Node") return; // a folder has no transform
    // The level's own nodes: what they are, not where (the spawn's place is
    // its own fields, and the light has none).
    if (n.extra["spawn"] === true) return buildPlayerGroup();
    if (n.type === "Sun") return buildSunGroup(n);
    if (n.type === "Environment") return buildEnvironmentGroup(n);
    const t = section(inspector, "node/Transform", "Transform", true);
    const at = (): World3 => worldOfNode(model, n.id);
    const write = (w: Partial<World3>): void => setNodeWorld(model, n.id, { ...at(), ...w });
    numField(t, "x", () => at().pos.x * M2PX, (v) => write({ pos: at().pos.withX(v * PX) }));
    numField(t, "y", () => at().pos.y * M2PX, (v) => write({ pos: at().pos.withY(v * PX) }));
    numField(t, "rot°", () => deg(at().rot), (v) => write({ rot: rad(v) }));
    if (is3D(n.type) || n.type === "Instance") {
      numField(t, "z", () => at().z * M2PX, (v) => write({ z: v * PX }));
      numField(t, "tilt x°", () => deg(at().tilt[0]), (v) => write({ tilt: [rad(v), at().tilt[1]] }));
      numField(t, "tilt y°", () => deg(at().tilt[1]), (v) => write({ tilt: [at().tilt[0], rad(v)] }));
    }
    if (n.instance) buildInstanceSection(n);
  }

  // A PLACED PREFAB (plans/node-tree.md "Prefabs"): which prefab, its uniform
  // scale, its insides opened for editing (an edit there is an override),
  // each override with a revert, and the prefab itself opened or unpacked.
  function buildInstanceSection(n: EdNode): void {
    const inst = n.instance;
    if (!inst) return;
    const id = n.id;
    const g = section(inspector, "node/Prefab", "Prefab", true);
    const row = fieldRow("prefab", "div");
    const known = prefabLibrary()[inst.prefab] !== undefined;
    row.appendChild(document.createTextNode(known ? inst.prefab : `${inst.prefab} (missing)`));
    g.appendChild(row);
    // The scale re-places the insides: the instance is written out first, its
    // overrides in the prefab's own units, so they survive the change.
    numField(g, "scale", () => inst.scale, (v) => {
      const next = Math.max(0.01, v);
      if (next === inst.scale) return;
      replaceTreeNode(id, (w) => {
        if (next === 1) delete w["scale"];
        else w["scale"] = next;
      });
    }, 0.1);
    const editable = Object.assign(document.createElement("input"), { type: "checkbox", checked: inst.editable });
    editable.addEventListener("change", () => setEditableChildren(id, editable.checked));
    const er = fieldRow("editable children");
    er.appendChild(editable);
    describe(er, "Show the prefab's insides in the scene tree and let a click reach them. What is changed there is saved as an override on this instance; the prefab itself is untouched.");
    g.appendChild(er);
    // What this instance changes, by the prefab node it changes.
    const written = findNodeIn(toTree(model).nodes, id) as { overrides?: Record<string, Record<string, unknown>> } | null;
    const overrides = written?.overrides ?? {};
    const prefab = prefabLibrary()[inst.prefab];
    const names = new Map<string, string>();
    if (prefab) walkNodes([prefab.root], (x) => void names.set(x.id, x.name));
    for (const [target, props] of Object.entries(overrides)) {
      const r = el("div", "ed-row");
      const label = el("span", "ed-hint");
      const orphan = !names.has(target);
      label.textContent = `${names.get(target) ?? target}${orphan ? " (no longer in the prefab)" : ""}: ${Object.keys(props).join(", ")}`;
      const revert = button("Revert", () => {
        replaceTreeNode(id, (w) => {
          const o = { ...(w["overrides"] as Record<string, unknown>) };
          delete o[target];
          if (Object.keys(o).length) w["overrides"] = o;
          else delete w["overrides"];
        });
      });
      revert.title = orphan ? "Drop this override: the node it names is gone from the prefab" : "Back to the prefab's values for this node";
      r.append(label, revert);
      g.appendChild(r);
    }
    const actions = el("div", "ed-row");
    const open = button("Open prefab", () => void openPrefab(inst.prefab));
    open.title = "Edit the prefab itself: every instance in every level follows";
    open.disabled = !known;
    const local = button("Make local", () => makeLocal(id));
    local.title = "Unpack: the prefab's nodes become this level's own, as they stand with the overrides, no longer following the prefab";
    local.disabled = !known;
    actions.append(open, local);
    g.appendChild(actions);
  }

  // Change one node AS WRITTEN (its tree form) and read the model back from
  // it: what changing an instance's scale or its overrides is, since its
  // insides are expanded from them.
  function replaceTreeNode(id: string, edit: (w: Record<string, unknown>) => void): void {
    beginAction();
    const tree = toTree(model);
    const w = findNodeIn(tree.nodes, id) as unknown as Record<string, unknown> | null;
    if (!w) return;
    edit(w);
    reexpand(tree);
    markDirty();
    setBodySelection(id);
  }

  function findNodeIn(nodes: readonly LevelNode[], id: string): LevelNode | null {
    let found: LevelNode | null = null;
    walkNodes(nodes, (x) => {
      if (found) return "skip";
      if (x.id === id) found = x;
    });
    return found;
  }

  // The player spawn's fields.
  function buildPlayerGroup(): void {
    const player = section(inspector, "level/Player spawn", "Player spawn", true);
    numField(player, "x", () => model.player.pos.x * M2PX, (v) => (model.player.pos = model.player.pos.withX(v * PX)));
    numField(player, "y", () => model.player.pos.y * M2PX, (v) => (model.player.pos = model.player.pos.withY(v * PX)));
    numField(player, "radius", () => model.player.radius * M2PX, (v) => (model.player.radius = Math.max(1, v) * PX));
    // Start the run on the anchor rather than on the ground (ball & chain
    // only). Its own checkbox rather than a field on a body, because the spawn
    // is not an item: it is the level's, like the environment block below.
    const hang = fieldRow("hang");
    const hangBox = document.createElement("input");
    hangBox.type = "checkbox";
    hangBox.checked = model.player.hang;
    describe(
      hang,
      "Start the ball & chain already hanging: at build the chain is thrown straight up from the spawn and bites the first surface within its 1.8 m reach. It anchors the chain, it does not lift the ball - put the spawn where the ball should HANG, under something to hang from. With nothing overhead in reach the level starts on the ground as usual. The grapple controller ignores it.",
    );
    hangBox.addEventListener("change", () => {
      beginAction();
      model.player.hang = hangBox.checked;
      markDirty();
    });
    hang.appendChild(hangBox);
    player.appendChild(hang);
    // How far off to the side the run rolls in from (ball & chain only), 0 for
    // a ball that simply stands at its spawn. A plain number field beside the
    // spawn's own x, because that is what it is: an offset along x from it.
    const rollField = numField(
      player,
      "roll in",
      () => model.player.roll * M2PX,
      (v) => (model.player.roll = v * PX),
    );
    describe(
      rollField,
      "Open the level on the ball rolling in from this far to the side of the spawn: negative to come in from the left, positive from the right, 0 for a ball that starts standing at its spawn. The ball is placed there and rolls to the spawn at 1.5 m/s, and the player's aim and chain do nothing until it arrives - so the spawn is still where the run starts, it is where the player is handed the ball. The camera stands at the spawn the whole way in rather than following the ball, so the offset is also how far off the standing frame the ball begins: 2 to 4 m rolls it in from the edge, past about 4.8 m it starts out of shot. The grapple controller ignores it, as do a start from a checkpoint and a ▶ Test here - a test starts at the spawn, in your hands, so an edit is not two metres of rolling in away from being checked. Play the level to see the opening.",
    );
  }

  function buildInspector(): void {
    refreshOutliner();
    buildDataLayers();
    fields.length = 0;
    readouts.length = 0;
    noteText = null;
    inspector.innerHTML = "";

    // The inspector is the SELECTION's: the level's own settings are nodes
    // (the spawn, the Sun, the Environment, picked in the scene tree) or the
    // top bar's (the background, the 3D camera). With nothing selected the
    // window is not drawn at all (`refreshInspectorShown`).

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
    //
    // A node that is not a body - a group, a 3D frame, a folder, a placed
    // prefab - shows what its class has: its name, its group flag and layers,
    // and its placement (plans/node-tree.md: the inspector shows the fields of
    // the node's class, nothing else).
    if (selectedBodyIds.size) {
      const sole = soleBodyId();
      const n = sole !== null ? model.tree.nodes.get(sole) : undefined;
      if (n && !n.body) {
        buildNodePanel(n);
        return;
      }
      if (sole !== null) {
        addNodeSection(sole);
        // A placed prefab whose root is a body: the prefab first, then the
        // body's own fields (a change there is an override).
        if (n?.instance) buildInstanceSection(n);
        buildBodyPanel(sole);
      } else {
        buildBodiesPanel([...selectedBodyIds].filter((id) => model.tree.nodes.get(id)?.body));
      }
      return;
    }

    const sel = selectedBodies();
    // Nothing selected: no window. How to put something on a layer is that
    // layer's button's help, and a workspace's is its tab's.
    if (!sel.length) return;
    if (sel.length === 1) addNodeSection(sel[0]!.node);
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
      "model",
      "formation",
      "decoration",
      "camera",
      "campath",
      "shelter",
      "fog",
      "track",
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
      const title = heading(
        `${sel.length} objects of ${panels.length} kinds`,
        `${panels.join(", ")} - each kind's properties are edited in its own panel below. Merge, Duplicate and Delete apply to all of them, and so does the 3D view's gizmo: it stands at the middle of the selection and moves and turns the lot as one arrangement.`,
      );
      g.appendChild(title);
      appendGroupSection(g, title);
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
      else if (k === "shelter") buildShelterGroup(items);
      else if (k === "fog") buildFogGroup(items);
      else if (k === "track") buildTrackGroup(items);
      else if (k === "light") buildLightsGroup(items);
      else if (k === "anchor") buildAnchorsGroup(items);
      else if (k === "model") buildModelsGroup(items);
      else if (k === "formation") buildFormationGroup(items);
      else if (k === "decoration") buildDecorationGroup(items);
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
  // PUT A PIECE OF LEVEL IN (`graftModel`): every node, item, chain and vine
  // of `source` added under fresh ids, moved by `offset`, under `parent`, and
  // selected - what is added, nothing else.
  function graftAndSelect(source: EdModel, offset: Vec2 = Vec2.ZERO, parent: string | null = null): void {
    const added = graftModel(model, source, offset, parent);
    selectedIds.clear();
    selectedVerts.clear();
    selectedChainIds.clear();
    selectedVineIds.clear();
    selectedBodyIds.clear();
    // A whole frame arrived (a body, a group): select it as one; loose items
    // are selected as themselves.
    const frames = added.roots.filter((r) => model.tree.nodes.get(r)?.item === null);
    if (frames.length && frames.length === added.roots.length) for (const r of frames) selectedBodyIds.add(r);
    else for (const i of added.items) selectedIds.add(i.id);
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
  // The bodies it acts on come from whichever selection is live: rows picked
  // in the scene tree, or objects picked on the canvas (whose WHOLE bodies
  // count, not the selected objects alone).
  // The nodes the selection stands for: the frames selected as such, else the
  // nodes of the items selected.
  function selectionNodes(): string[] {
    if (selectedBodyIds.size) return [...selectedBodyIds];
    return [...new Set(selectedBodies().map((b) => b.node))];
  }

  // NEW BODY FROM SELECTION (plans/node-tree.md "What replaces what"): the
  // selected pieces reparented under a new `StaticBody2D`, each keeping where
  // it stands, which is what making a compound body is now. The new body
  // stands where the first piece's parent did, on the pieces' centre of mass,
  // and is created grouped, as every body is.
  function newBodyFromSelection(): void {
    const ids = selectionNodes().filter((id) => {
      const n = model.tree.nodes.get(id);
      return !!n && !n.body && n.extra["spawn"] !== true;
    });
    if (!ids.length) return;
    const first = model.tree.nodes.get(ids[0]!)!;
    const items = ids.flatMap((id) => membersOf(model, id));
    const centre = items.length ? bodyCentroid(items) : first.pos;
    beginAction();
    const body = addFrameNode(model, "StaticBody2D", first.parent, {
      pos: centre,
      name: "StaticBody2D",
      body: defaultBody(nextOrder(model.tree)),
      grouped: true,
      index: childrenOf(model.tree, first.parent).indexOf(first.id),
    });
    for (const id of ids) {
      const why = moveNode(model, id, body.id, undefined);
      if (why) {
        // Refused: put everything back as it was.
        replaceModel(history.pop()!);
        showToast(why, "warn");
        return;
      }
    }
    expandedBodies.add(body.id);
    markDirty();
    setBodySelection(body.id);
  }

  // The bodies a Join folds together, in the order they were selected: the
  // bodies picked as such, else the bodies of the objects picked.
  function selectedJoinBodies(): string[] {
    const ids = selectedBodyIds.size ? [...selectedBodyIds] : selectedBodies().map((i) => i.unit);
    return [...new Set(ids)].filter((id) => model.tree.nodes.get(id)?.body);
  }

  // JOIN (Ctrl+J, editor/splitJoin.ts): the first body selected takes in the
  // rest, its settings kept, and pieces of the same surface fuse. One undo
  // step; a refusal (a chain that would end on one body, an area left in two
  // pieces) changes nothing and says why.
  function joinSelection(): void {
    const ids = selectedJoinBodies();
    if (ids.length < 2) {
      showToast("Select two or more bodies to join", "warn");
      return;
    }
    beginAction();
    const r = joinBodies(model, ids);
    if (typeof r === "string") {
      replaceModel(history.pop()!);
      showToast(r, "warn");
      return;
    }
    const name = model.tree.nodes.get(r.body)?.name ?? "the body";
    const fused = r.fused ? `, ${r.fused} ${r.fused === 1 ? "piece" : "pieces"} fused` : "";
    const kinds = r.otherKinds.length ? `; ${r.otherKinds.join(", ")} took ${name}'s kind and settings` : "";
    expandedBodies.add(r.body);
    markDirty();
    setBodySelection(r.body);
    showToast(`Joined ${ids.length} bodies into ${name}${fused}${kinds}`);
  }

  // GROUP (Ctrl+G) and UNGROUP (Ctrl+Shift+G): a node's `grouped` flag, which
  // changes only what a click on the canvas selects (plans/node-tree.md
  // "Groups"). Grouping several nodes that are not one already puts them
  // under a new group node (a `Node2D`, or a `Node3D` for things in the
  // scene) first.
  function groupSelection(): void {
    const ids = selectionNodes();
    if (!ids.length) return;
    beginAction();
    if (ids.length === 1) {
      model.tree.nodes.get(ids[0]!)!.grouped = true;
    } else {
      const first = model.tree.nodes.get(ids[0]!)!;
      const threeD = ids.every((id) => is3D(model.tree.nodes.get(id)?.type ?? "Node"));
      const group = addFrameNode(model, threeD ? "Node3D" : "Node2D", first.parent, {
        pos: bodyCentroid(ids.flatMap((id) => membersOf(model, id))),
        name: "Group",
        grouped: true,
        index: childrenOf(model.tree, first.parent).indexOf(first.id),
      });
      for (const id of ids) {
        const why = moveNode(model, id, group.id, undefined);
        if (why) {
          replaceModel(history.pop()!);
          showToast(why, "warn");
          return;
        }
      }
      setBodySelection(group.id);
    }
    markDirty();
    rebuildInspector();
  }

  function ungroupSelection(): void {
    const ids = selectionNodes().filter((id) => model.tree.nodes.get(id)?.grouped);
    // An item's own group root when the item itself is not one.
    const roots = ids.length ? ids : [...new Set(selectedBodies().map((b) => ancestors(model.tree, b.node).find((a) => a.grouped)?.id).filter((x): x is string => !!x))];
    if (!roots.length) return;
    beginAction();
    for (const id of roots) model.tree.nodes.get(id)!.grouped = false;
    markDirty();
    rebuildInspector();
  }

  // Is this body's origin already where its mass is? Asked exactly as
  // `originToCentroid` asks it, so the button it greys out and the operation it
  // guards cannot disagree about whether there is anything to do.
  const originIsCentred = (id: string): boolean => {
    const members = bodyMembers(model.items, id);
    if (!members.length) return true;
    const d = bodyCentroid(members).sub(bodyFrameOf(model, id).pos);
    return d.x === 0 && d.y === 0;
  };

  // Put the body's origin on its centre of mass. Checked BEFORE `beginAction`
  // rather than after: taking a snapshot pins the frame of every compound body
  // in the level (`pinCompoundFrames`), so an action that turns out to have
  // nothing to do has still changed the model and would leave an undo step that
  // undoes nothing visible.
  function originOntoCentroid(id: string): void {
    if (originIsCentred(id)) return;
    beginAction();
    originToCentroid(model, id);
    markDirty();
    rebuildInspector();
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
  //
  // `snap` is where on the host it lands: the surface for a chain END, which
  // is what bolting a chain to a body means (and an anchor in a body's interior
  // leaves the chain's span starting inside it, which the wrap generator
  // resolves as a self-intersection - see `nearestSurfaceLocal`); a CORNER for
  // a wrap point, since a corner is what a chain bends around.
  function newAnchorOn(
    host: EdItem,
    world: Vec2,
    snap: (host: EdItem, world: Vec2) => Vec2 = nearestSurfaceLocal,
  ): EdItem {
    return {
      ...host,
      id: newBodyId(),
      object: "anchor",
      pos: toWorld(host, snap(host, world)),
      rot: host.rot,
      shape: { kind: "rect", w: ANCHOR_GIZMO, h: ANCHOR_GIZMO },
      cam: { ...host.cam },
      light: { ...host.light },
      note: { ...host.note },
      modelRef: defaultModelRef(),
      formation: null, decoration: null,
      anchorId: newAnchorId(),
    };
  }

  // String a chain between two bodies, anchored where each end was placed. A
  // chain to the body you started on (or to another piece of the same compound
  // body) is a chain tied to itself and is refused.
  // The chain draw's release, or a press while a tied chain is being strung
  // out: over a body with Shift, TIE the chain there (a knot on the body's
  // surface where the pointer is) and keep going; over a body without, end the
  // chain there; over nothing, abandon it - a chain lands only on a body, and
  // leaving an end in mid-air is not a thing that could be meant. A rope
  // bridge is therefore one gesture: press on the left post, Shift-release on
  // the left end of slat 1, Shift-click its right end, slat 2's left end, ...,
  // and a plain click on the right post.
  function finishOrTieChainDraw(tie: boolean): void {
    if (!drag || drag.mode !== "chainDraw") return;
    const to = topmostAt(drag.cursor, (b) => chainable(b));
    if (tie && to) {
      drag.knots.push({ item: to, local: nearestSurfaceLocal(to, drag.cursor) });
      return;
    }
    if (to) addChain(drag.from, toWorld(drag.from, drag.local), drag.knots, to, drag.cursor);
    drag = null;
  }

  function addChain(
    from: EdItem,
    fromWorld: Vec2,
    knots: readonly { item: EdItem; local: Vec2 }[],
    to: EdItem,
    world: Vec2,
  ): void {
    if (!chainable(to)) return;
    if (to.id === from.id) return;
    if (to.unit === from.unit) return;
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
    const through: number[] = [];
    for (const k of knots) {
      const anchor = newAnchorOn(k.item, toWorld(k.item, k.local));
      model.items.push(anchor);
      through.push(anchor.id);
    }
    const b = newAnchorOn(to, world);
    model.items.push(b);
    const chain: EdChain = {
      id: newBodyId(),
      a: a.id,
      b: b.id,
      via: [],
      through,
      lengths: [],
      // A tied chain starts with the sag a bridge needs rather than taut, since
      // taut it hangs stretched on its rows' softness (see `buildTie`); the
      // panel's `slack` field is where it is tuned.
      slack: through.length > 0 ? 0.03 : null,
      substeps: null,
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
  function addVine(from: EdItem, local: Vec2, length: number): void {
    if (!chainable(from)) return;
    if (length < MIN_VINE_LENGTH) return;
    beginAction();
    const a = newAnchorOn(from, toWorld(from, local));
    model.items.push(a);
    const vine: EdVine = {
      id: newBodyId(),
      braidSeed: null,
      rope: false,
      anchor: a.id,
      anchor2: null,
      length,
      spacing: null,
      density: null,
      stiffness: null,
      viscosity: null,
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
    // A chain outlives a WRAP POINT the way a vine outlives its second anchor:
    // the route loses the point and the chain keeps its ends.
    for (const c of model.chains) {
      if (c.via.some((id) => !live.has(id))) c.via = c.via.filter((id) => live.has(id));
      // ...and a TIE POINT the same way: the knots either side join up, and the
      // segment lengths are re-read against the knots that are left.
      if (c.through.some((id) => !live.has(id))) {
        c.through = c.through.filter((id) => live.has(id));
        c.lengths = [];
      }
    }
    model.vines = model.vines.filter((v) => live.has(v.anchor));
    for (const v of model.vines) {
      if (v.anchor2 !== null && !live.has(v.anchor2)) v.anchor2 = null;
    }
  }

  // The shape an anchor slides along: the first collision object in its body,
  // which is what a chain is bolted to. A body with none cannot hold a chain at
  // all (`chainable`), so this is null only for a body taken apart under it.
  //
  // The first piece the rope can hold, where the body has one (a wheel's hub
  // rather than its rim - see `chainable`), else its first piece at all.
  const anchorHost = (a: EdItem): EdItem | null => {
    const members = bodyMembers(model.items, a.unit);
    return (
      members.find((m) => m.object === "collision" && (m.mask & LAYER_ROPE) !== 0) ??
      members.find((m) => m.object === "collision") ??
      null
    );
  };

  // ...and the mirror of it: an anchor no chain names has nothing to be. They
  // are created only by stringing a chain, so one left behind is the wreckage of
  // a deleted chain rather than something an author placed and may want.
  function pruneAnchors(): void {
    const used = new Set<number>();
    for (const c of model.chains) {
      used.add(c.a);
      used.add(c.b);
      for (const id of c.via) used.add(id);
      for (const id of c.through) used.add(id);
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
  // `+ Glow`: the body `glowBody` describes, centred on `at`, through the same
  // loader a level (and a paste) comes in by, so it is exactly what a file
  // holding that body would load as. Always a body of its own: a mushroom is a
  // thing in the level, not a part of whatever happens to be selected.
  function placeGlow(at: Vec2): void {
    const arrived = placingMushroom ? mushroomModel(at) : glowModel(at);
    beginAction();
    graftAndSelect(arrived);
  }

  function newDrawnItem(t: Exclude<Tool, "select" | "chain" | "glow">, start: Vec2): EdItem {
    const object: EdObject = t === "light" ? "light" : t === "model" ? "model" : t === "fog" ? "fog" : t === "shelter" ? "shelter" : "collision";
    const style = newItemStyle(activeLayer, object);
    // Not in the tree yet: `insertDrawn` puts it there, into the body it is
    // drawn into or a new one.
    const base: EdItem = {
      ...blankItem(activeLayer, object, ""),
      pos: start,
      color: style.color,
      opacity: style.opacity,
      rail: t === "path" && activeLayer === "scene",
      // A new piece is seen by its debug geometry, as every piece a level is
      // blocked out in is.
      debug: object === "collision" && activeLayer === "scene" ? { ...NO_DEBUG(), on: true } : NO_DEBUG(),
    };
    if (t === "model") {
      // Dropped ON the click: a model's size is its own, and its placement is
      // the whole of the gesture, as a checkpoint's is. It is the last model
      // picked, so a run of lanterns is a run of clicks.
      return {
        ...base,
        shape: { kind: "rect", w: MODEL_MARK, h: MODEL_MARK },
        modelRef: { ...defaultModelRef(), name: lastModelName || (modelNamesFor(() => {})[0] ?? "") },
      };
    }
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
    if (t === "checkpoint") {
      // Dropped ON the click rather than growing from it, and at the avatar's
      // size: a checkpoint is a named POINT, so where it is placed is the whole
      // of the gesture and there is nothing for a drag to size (see
      // `checkpointBox`). It lands unnamed, with the caret in the name field -
      // the same first act a text note is placed for - because a checkpoint with
      // no name is one nothing can ask for yet.
      return {
        ...base,
        pos: start,
        shape: checkpointBox(model.player.radius),
        note: { ...base.note, kind: "checkpoint", text: "" },
      };
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
          keys: [NO_KEY(), NO_KEY()],
          width: DEFAULT_CURVE_WIDTH,
        },
      };
    }
    if (t === "fog") {
      // A rect at the grid step that the drag sizes, as +Rect's, carrying a
      // fog worth seeing from the first instant.
      return { ...base, shape: { kind: "rect", w: gridStep, h: gridStep }, fog: { ...NEW_FOG } };
    }
    if (t === "poly" || t === "shelter") {
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
    if (t === "belt") {
      // The press is wheel 0 and a click drops a two-wheel belt of the default
      // length running right; a drag places the second wheel instead (the draw
      // case below). More wheels are added on a run's midpoint once it is down.
      // A static body whatever kind the selector is on, since a belt builds on
      // nothing else - the kind selector is for the next box.
      return {
        ...base,
        shape: {
          kind: "belt",
          wheels: [
            { c: Vec2.ZERO, r: DEFAULT_BELT_RADIUS },
            { c: new Vec2(DEFAULT_BELT_LENGTH, 0), r: DEFAULT_BELT_RADIUS },
          ],
          thickness: DEFAULT_BELT_THICKNESS,
          speed: DEFAULT_BELT_SPEED,
          // A fresh band draws at the defaults (`BeltLook`), set on the panel.
          look: {},
        },
      };
    }
    // A click drops one at the grid step and a drag sizes it - the drag itself
    // reads `shape.kind` and needs to know nothing about which tool drew it.
    return {
      ...base,
      shape: t === "rect" ? { kind: "rect", w: gridStep, h: gridStep } : { kind: "circle", r: gridStep },
    };
  }

  // How close (in screen px) a click must land to the draft's first vertex to
  // close the loop rather than adding another vertex.
  // PUT A DRAWN ITEM IN THE TREE. A piece drawn while one body is selected
  // goes into that body (when it may: an area is one kind of thing); any
  // other collision piece gets a body of its own, created grouped as every
  // body is; a light or a model drawn into nothing stands on its own, and so
  // does everything on the other layers.
  //
  // A new body is of the class last picked for one (`newKind`), and which
  // class is the author's to say once the shape is down: the new body is
  // returned for `offerParentPick`. A belt's is not: a belt builds only on a
  // static body, so it gets one and nothing is asked.
  // In an open prefab with nothing selected, the root is what is selected: a
  // piece drawn into nothing joins a body root, and anything else drawn is
  // put under the root (`adoptPrefabStrays`).
  function insertDrawn(item: EdItem): string | null {
    const sole = soleBodyId();
    const rootHost = prefabMode && sole === null && !selectedIds.size && prefabRootId !== null && model.tree.nodes.get(prefabRootId)?.body ? prefabRootId : null;
    const host = canShareBody(item) ? (sole ?? rootHost) : null;
    const hostNode = host !== null ? model.tree.nodes.get(host) : undefined;
    if (hostNode?.body && bodyMembers(model.items, host!).every(canShareBody)) {
      addItem(model, item, host);
      return null;
    }
    if (item.layer === "scene" && item.object === "collision") {
      const ask = item.shape.kind !== "belt";
      const body: EdBody = { ...defaultBody(nextOrder(model.tree)), kind: ask ? newKind : "static", color: item.color, opacity: item.opacity };
      const node = addFrameNode(model, bodyNodeType(body), null, {
        pos: item.pos,
        rot: item.rot,
        name: bodyNodeType(body),
        body,
        grouped: true,
      });
      addItem(model, item, node.id);
      return ask ? node.id : null;
    }
    addItem(model, item, null);
    return null;
  }

  // THE PARENT PICK. A collision shape needs a body above it, as Godot's
  // CollisionShape2D needs a PhysicsBody2D, and which class of body is asked
  // where the shape was drawn: a menu at the pointer once the shape is down,
  // listing the classes with the one the new body already has lit, so a run
  // of walls is a click each and needs no answer. A pick changes the new
  // body's class (and its name, while that is still the class's) within the
  // draw's own undo step, and is what the next shape's body is given; Esc,
  // any other key, a press anywhere else or any other edit closes the menu
  // and keeps the class it has. With one body selected nothing is asked: the
  // shape goes into it (`insertDrawn`).
  const PARENT_CHOICES: readonly { kind: BodyKind; note: string }[] = [
    { kind: "static", note: "stays put" },
    { kind: "rigid", note: "falls and tumbles" },
    { kind: "killzone", note: "kill zone" },
    { kind: "force", note: "pushes" },
    { kind: "water", note: "water" },
    { kind: "finish", note: "finish line" },
  ];
  function closeParentPick(): void {
    parentPick?.menu.remove();
    parentPick = null;
  }
  function offerParentPick(bodyId: string): void {
    closeParentPick();
    const node = model.tree.nodes.get(bodyId);
    if (!node?.body) return;
    const menu = el("div", "ed-shape-menu ed-parent-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Parent body");
    const title = el("div", "ed-shape-menu-title");
    title.textContent = "Parent body";
    menu.appendChild(title);
    for (const { kind, note } of PARENT_CHOICES) {
      const type = bodyNodeType({ ...node.body, kind });
      const b = button("", () => pickParent(kind));
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(node.body.kind === kind));
      b.classList.toggle("active", node.body.kind === kind);
      const mark = el("span", "ed-parent-mark");
      mark.textContent = TYPE_MARK[type] ?? "";
      const name = el("span", "ed-parent-type");
      name.textContent = type;
      const sub = el("span", "ed-parent-note");
      sub.textContent = note;
      b.append(mark, name, sub);
      menu.appendChild(b);
    }
    root.appendChild(menu);
    // Beside the shape, never over it: to its right, or its left where the
    // right has no room, level with its top - kept inside the view. The
    // canvas runs under the top bar, the dock and the status line, so those
    // bound it.
    const box = canvas.getBoundingClientRect();
    const r = menu.getBoundingClientRect();
    const top = fileRow.getBoundingClientRect().bottom;
    // (On a phone the dock is a drawer, hidden while closed.)
    const dock = rightDock.getBoundingClientRect();
    const right = dock.width > 0 ? dock.left : window.innerWidth;
    const bottom = statusLine.getBoundingClientRect().top;
    const shape = bodyMembers(model.items, bodyId)[0];
    const s = shape?.shape;
    const outline = !shape || !s
      ? []
      : s.kind === "circle"
        ? [new Vec2(-s.r, -s.r), new Vec2(s.r, s.r), new Vec2(-s.r, s.r), new Vec2(s.r, -s.r)].map((v) => toWorld(shape, v))
        : worldVertices(shape);
    const onScreen = outline.map((w) => canvasScreen(w)).filter((v) => Number.isFinite(v.x) && Number.isFinite(v.y));
    const fallback = lastPointerScreen ?? new Vec2(box.width / 2, box.height / 2);
    const xs = onScreen.length ? onScreen.map((v) => box.left + v.x) : [box.left + fallback.x];
    const ys = onScreen.length ? onScreen.map((v) => box.top + v.y) : [box.top + fallback.y];
    const [minX, maxX, minY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys)];
    const x = maxX + 12 + r.width <= right - 8 ? maxX + 12 : minX - 12 - r.width;
    menu.style.left = `${Math.round(Math.max(box.left + 8, Math.min(right - r.width - 8, x)))}px`;
    menu.style.top = `${Math.round(Math.max(top + 8, Math.min(bottom - r.height - 8, minY)))}px`;
    parentPick = { body: bodyId, menu };
  }
  function pickParent(kind: BodyKind): void {
    const pick = parentPick;
    closeParentPick();
    const node = pick ? model.tree.nodes.get(pick.body) : undefined;
    if (!node?.body) return;
    newKind = kind;
    if (node.body.kind === kind) return;
    const wasName = bodyNodeType(node.body);
    node.body.kind = kind;
    node.type = bodyNodeType(node.body);
    // Still the class's own name (numbered apart from its siblings', as
    // `StaticBody2D3`): it names the new class instead.
    if (new RegExp(`^${wasName}\\d*$`).test(node.name)) renameNode(model.tree, node.id, node.type);
    markDirty();
    rebuildInspector();
  }
  window.addEventListener("pointerdown", (e) => {
    if (parentPick && !parentPick.menu.contains(e.target as Node)) closeParentPick();
  }, true);
  window.addEventListener("keydown", (e) => {
    if (!parentPick || e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    closeParentPick();
    // Esc and Enter are answers to the menu, and go no further.
    if (e.code === "Escape" || e.code === "Enter" || e.code === "NumpadEnter") {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  const POLY_CLOSE_PX = 10;
  // The cart a fresh track is given, and how far along its first stretch it
  // is placed (metres): clear of the start, where the spawner sends carts from.
  const TRACK_CART_PREFAB = "minecart";
  const TRACK_CART_START = 0.8;

  function cancelPolyDraft(): void {
    if (!polyDraft) return;
    polyDraft = null;
    updateTitle();
  }

  // THE KNIFE (the Cut tool, editor/splitJoin.ts). What it may cut: the
  // polygons and boxes a click could pick, and with anything selected only
  // what is in the selection, so a cut through a stack of overlapping walls
  // cuts the one being worked on.
  function cutTargets(): EdItem[] {
    const items = pickableItems().filter(cuttable);
    const sel = selectedNodeIds();
    if (!sel.size) return items;
    return items.filter((i) => sel.has(i.node) || sel.has(i.unit) || ancestors(model.tree, i.node).some((a) => sel.has(a.id)));
  }

  // Where a knife's end lands: on a corner of something it may cut when the
  // pointer is within a few pixels of one (corner to corner is the exact
  // diagonal), else on the grid as every other draw tool's points do.
  function cutPoint(scr: Vec2): { at: Vec2; corner: boolean } {
    let best: Vec2 | null = null;
    let bestD = CUT_SNAP_PX;
    for (const i of cutTargets()) {
      for (const v of worldVertices(i)) {
        const d = canvasScreen(v).distanceTo(scr);
        if (d < bestD) {
          bestD = d;
          best = v;
        }
      }
    }
    return best ? { at: best, corner: true } : { at: snapVec(canvasWorld(scr)), corner: false };
  }

  function cancelCutDraft(): void {
    if (!cutDraft) return;
    cutDraft = null;
    updateTitle();
  }

  // What the knife from its first click to the pointer would make, for the
  // preview: the pieces, the line, and whether the end is on a corner.
  function cutDraftView(): { from: Vec2; to: Vec2; pieces: Vec2[][]; corner: boolean } | null {
    if (!cutDraft || tool !== "cut") return null;
    const end = cutPoint(lastPointerScreen ?? canvasScreen(cutDraft.from));
    return { from: cutDraft.from, to: end.at, pieces: planCut(cutTargets(), cutDraft.from, end.at).flatMap((p) => p.pieces), corner: end.corner };
  }

  // The second click: cut, and part what no longer touches into bodies of
  // its own unless Alt is held. One undo step. A line that crosses nothing
  // edge to edge keeps its first point, so the end can be clicked again.
  function commitCut(to: Vec2, keepTogether: boolean): void {
    if (!cutDraft) return;
    const plan = planCut(cutTargets(), cutDraft.from, to);
    if (!plan.length) {
      showToast("A cut has to cross a polygon or box from edge to edge", "warn");
      return;
    }
    beginAction();
    const r = applyCut(model, plan, !keepTogether);
    if (typeof r === "string") {
      replaceModel(history.pop()!);
      showToast(r, "warn");
      return;
    }
    cutDraft = null;
    for (const id of r.bodies) expandedBodies.add(id);
    markDirty();
    setBodiesSelection(r.bodies);
    const held = r.held.map((id) => model.tree.nodes.get(id)?.name ?? id);
    showToast(
      keepTogether
        ? `Cut ${plan.length === 1 ? "one shape" : `${plan.length} shapes`}, the pieces kept in one body`
        : r.made.length
          ? `Cut into ${r.bodies.length} bodies${held.length ? `; ${held.join(", ")} still held together by a piece across the cut` : ""}`
          : `Cut, but ${held.join(", ")} ${held.length === 1 ? "is" : "are"} still held together by a piece across the cut`,
    );
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
    if (draft.kind === "track") {
      commitTrackDraft(draft.verts);
      return;
    }
    const pts = draft.verts;
    const drawn = pts.length >= 3 && isSimpleLoop(pts) ? normalizeWinding(pts) : convexHull(pts);
    if (drawn.length < 3) {
      updateTitle();
      return;
    }
    const item = newDrawnItem(draft.kind === "shelter" ? "shelter" : "poly", drawn[0]!);
    // The loop is clicked out in WORLD metres, so the item starts at the world
    // origin and `centreShapeOrigin` below moves `pos` onto the drawn outline's
    // centroid - the one place a shape's origin is placed for it, and the only
    // one, since from here on a corner edit leaves `pos` alone.
    item.pos = Vec2.ZERO;
    item.shape = { kind: "poly", verts: drawn.map((h) => h.clone()) };
    // A camera region falls back to the hull here rather than at the draft:
    // `setPolyVerts` is the one place that knows a region must stay convex.
    if (!setPolyVerts(item, drawn) && !setPolyVerts(item, convexHull(drawn))) {
      updateTitle();
      return;
    }
    centreShapeOrigin(item);
    beginAction();
    const made = insertDrawn(item);
    setSelection([item.id]);
    markDirty();
    if (made) offerParentPick(made);
  }

  // The clicked points as a camera path: taken exactly as drawn, with no
  // closing edge, no winding to normalise and no hull to fall back to. A path
  // that crosses itself is a switchback, which is the case the whole mechanism
  // is built around - so the only draft that is dropped is one with fewer than
  // two distinct points, which has no direction.
  function commitPathDraft(pts: readonly Vec2[]): void {
    const item = newDrawnItem("path", pts[0] ?? Vec2.ZERO);
    // Clicked out in WORLD metres, exactly as a polygon is: the item starts at
    // the world origin and `centreShapeOrigin` below puts `pos` on the node
    // average once the nodes are in.
    item.pos = Vec2.ZERO;
    // Every node a corner to begin with: a drawn path is the polyline that was
    // clicked, and smoothing a corner is a handle drag away.
    item.shape = {
      kind: "path",
      verts: pts.map((p) => p.clone()),
      handles: pts.map(() => ZERO_HANDLE()),
      keys: pts.map(() => NO_KEY()),
      width: DEFAULT_CURVE_WIDTH,
    };
    if (!setPathVerts(item, pts)) {
      updateTitle();
      return;
    }
    centreShapeOrigin(item);
    beginAction();
    const made = insertDrawn(item);
    setSelection([item.id]);
    markDirty();
    if (made) offerParentPick(made);
  }

  // The clicked points as a MINECART TRACK (docs/minecarts.md): a `Track2D`
  // whose origin is the first node, its line as clicked, and a `minecart`
  // placed on its first stretch as the cart every cart is built from - its
  // model's wheels on the line, turned with the line - so a fresh track runs
  // carts with no further step. Written into the level as a tree and read
  // back, as a placed prefab is (`placePrefab`), so the cart comes in expanded.
  function commitTrackDraft(pts: readonly Vec2[]): void {
    const first = pts[0];
    const next = pts.find((p) => first !== undefined && p.distanceTo(first) > 1e-6);
    if (!first || !next) {
      updateTitle();
      return;
    }
    const local = pts.map((p) => p.sub(first));
    const along = next.sub(first).normalized();
    // Upright on the line whichever way it runs: turned with its slope, not
    // with its direction, so a line drawn right to left does not put the cart
    // upside down under it. Which way the cart travels is the line's alone.
    const rot = (along.x < 0 ? along.neg() : along).angle();
    const prefab = prefabLibrary()[TRACK_CART_PREFAB];
    // How far above its model's ground the prefab's origin stands: the model
    // node's own offset, so its wheels land on the line.
    const model3d = prefab?.root.children?.find((c) => c.type === "Model3D") as { y?: number } | undefined;
    const ride = (model3d?.y ?? 0) * PX;
    const cartAt = along.mul(TRACK_CART_START).add(new Vec2(0, -ride).rotated(rot));
    const tree = toTree(model);
    const taken = new Set(model.tree.nodes.keys());
    const trackId = newNodeId(taken);
    taken.add(trackId);
    const cartId = newNodeId(taken);
    const names = new Set(model.tree.roots.map((r) => model.tree.nodes.get(r)?.name ?? ""));
    let name = "Track";
    for (let k = 2; names.has(name); k++) name = `Track${k}`;
    tree.nodes.push({
      type: "Track2D",
      id: trackId,
      name,
      x: first.x,
      y: first.y,
      rot: 0,
      verts: local.map((p) => ({ x: p.x, y: p.y })),
      children: prefab
        ? [
            {
              type: "Instance",
              id: cartId,
              name: "Cart",
              grouped: true,
              x: cartAt.x,
              y: cartAt.y,
              rot,
              prefab: TRACK_CART_PREFAB,
              order: nextOrder(model.tree),
            },
          ]
        : [],
    } as unknown as LevelNode);
    beginAction();
    reexpand(tree);
    const item = model.items.find((i) => i.node === trackId);
    if (item) setSelection([item.id]);
    markDirty();
    if (!prefab) showToast(`No ${TRACK_CART_PREFAB} prefab: put a body under the track to be its cart`, "warn");
  }

  // How close (in screen px) outside a root's bar a stroke may start and still
  // grow a branch out of it, so a tip a few pixels wide can be started from.
  const ROOT_PICK_PX = 6;

  function cancelRootDraft(): void {
    if (!rootDraft) return;
    rootDraft = null;
    if (drag?.mode === "rootHandle") drag = null;
    refreshRootWidthFields();
    updateTitle();
  }

  // Grow the drafted ROOT (docs/roots.md). A branch joins the body of the root
  // it grows out of, with its first node on that root's centreline where the
  // stroke began; anything else is a new root - a body of its own whatever is
  // selected, since a root is not a part of the rock it grows out of. A new
  // root is static and hook-only, in the bark colour; `pivot` on its body is
  // what makes it spring.
  function commitRootDraft(): void {
    const draft = rootDraft;
    rootDraft = null;
    if (drag?.mode === "rootHandle") drag = null;
    // Back to the widths the next root starts at.
    refreshRootWidthFields();
    if (!draft || draft.verts.length < 2) {
      updateTitle();
      return;
    }
    const parent = draft.from ? model.items.find((i) => i.id === draft.from!.item.id) : undefined;
    const item = newDrawnItem("path", draft.verts[0]!);
    item.pos = Vec2.ZERO;
    item.shape = {
      kind: "path",
      verts: draft.verts.map((p) => p.clone()),
      handles: draft.handles.map((h) => ({ in: h.in, out: h.out })),
      keys: draft.verts.map(() => NO_KEY()),
      width: draft.width,
      tip: draft.tip,
    };
    if (!setPathVerts(item, item.shape.verts, item.shape.handles)) {
      updateTitle();
      return;
    }
    centreShapeOrigin(item);
    // Bitten, never clamped round (a tapered curve is never a rail), and drawn
    // by its own generated mesh rather than by debug geometry.
    item.rail = false;
    item.debug = NO_DEBUG();
    beginAction();
    if (parent && isRootItem(parent) && draft.from) {
      // A branch: in its root's body, beside the branch it grows out of.
      item.root = {
        parent: parent.id,
        at: draft.from.at,
        bark: parent.root?.bark,
      };
      addItem(model, item, model.tree.nodes.get(parent.node)?.parent ?? parent.unit);
    } else {
      // A new root: a hook-only static body of its own.
      item.color = DEFAULT_ROOT_COLOR;
      item.root = { parent: null, at: 0 };
      const body = addFrameNode(model, "StaticBody2D", null, {
        pos: item.pos,
        name: "Root",
        body: { ...defaultBody(nextOrder(model.tree)), kind: "static", passable: true, color: DEFAULT_ROOT_COLOR },
        grouped: true,
      });
      addItem(model, item, body.id);
    }
    setSelection([item.id]);
    markDirty();
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
    // A branch's first node is where it grows out of its parent, not a node it
    // could do without; it is slid along the parent instead.
    if (doomed.has(0) && isRootItem(item) && item.root.parent !== null) {
      flashNotice("a branch's first node is where it grows out of its root - drag it along the root instead");
      return true;
    }
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
            item.shape.keys.filter((_, i) => !doomed.has(i)),
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

  // Remove the picked route nodes from the body that carries them. Answers
  // whether it handled the keystroke, so the caller can fall through to deleting
  // the BODY when none is picked - the order `deleteSelectedVerts` sets, one
  // level out: with nodes picked out of a route, Delete is about them, and the
  // body is one Escape away from being what it means again.
  //
  // Node zero is never removed: it IS the body, pinned at the frame origin, so a
  // route without it is not a route and removing it could only mean removing the
  // body. A selection naming it removes the OTHERS and leaves it, which is the
  // answer Alt+click already gives - and a selection of nothing else still
  // counts as handled, because the alternative is Delete quietly taking the body
  // while the author was looking at one of its nodes.
  //
  // Below two nodes there is no route left to have, so the remainder is dropped
  // and the body stands still. Alt+click's own rule again, so the last leg
  // removed by either gesture leaves the same level.
  function deleteSelectedRouteNodes(): boolean {
    const lead = routeEditTarget();
    if (!lead) return false;
    const picked = selectedRouteNodes(lead);
    if (!picked.length) return false;
    const doomed = new Set(picked.filter((i) => i > 0));
    if (!doomed.size) return true;
    beginAction();
    const rest = propsOf(lead).route.filter((_, i) => !doomed.has(i)).map(cloneRouteNode);
    propsOf(lead).route = rest.length > 1 ? rest : [];
    clearRouteSel();
    markDirty();
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

  // Move the picked route nodes by one grid cell, the arrow-key half of what
  // Delete does to them - and the same answer to the same question, so a picked
  // node means BOTH keys are about the route rather than about the body.
  //
  // Node zero does not move: it is the body's own origin, so nudging it would be
  // a second, quieter way of moving the body that left every other node behind -
  // the reason it is not draggable either. A pick that names only node zero
  // still counts as handled, for the reason Delete's does: falling through would
  // walk the whole body off while the author was aiming at one of its nodes.
  //
  // The step is rotated into the BODY's frame, exactly as a polygon's is into
  // its shape's, so an arrow moves a node along the world axis it names rather
  // than along whatever angle the body was drawn at.
  function nudgeSelectedRouteNodes(dir: Vec2, fine: boolean): boolean {
    const lead = routeEditTarget();
    if (!lead) return false;
    const picked = selectedRouteNodes(lead);
    if (!picked.length) return false;
    const moving = new Set(picked.filter((i) => i > 0));
    if (!moving.size) return true;
    if (!nudging) {
      beginAction();
      nudging = true;
    }
    const d = dir.mul(fine ? NUDGE_FINE : gridStep).rotated(-bodyFrameOf(model, lead.unit).rot);
    propsOf(lead).route = propsOf(lead).route.map((n, i) => (moving.has(i) ? { ...n, p: n.p.add(d) } : n));
    markDirty();
    refreshFields();
    return true;
  }

  function deleteSelected(): void {
    // A berry picked out of its vine is what is selected, not the vine.
    const berry = currentBerry();
    if (berry) {
      beginAction();
      deleteBerry(berry.vine, berry.index);
      markDirty();
      rebuildInspector();
      return;
    }
    // A selected BODY means all of it: deleting a body deletes the objects in
    // it. Reading `selectedIds` alone left the body panel's own Delete button
    // doing nothing at all.
    const doomed = new Set(operandItems().map((b) => b.id));
    // A root branch goes with everything growing out of it: cutting a root
    // cuts what it carries, rather than leaving its branches standing in the
    // air as trunks of their own.
    for (const b of model.items) {
      if (doomed.has(b.id) && isRootItem(b)) for (const d of rootDescendants(model, b)) doomed.add(d.id);
    }
    // ...and a node selected AS ITSELF (a body, a group, the Sun) goes with
    // everything under it, the ones that carry nothing included. The spawn
    // is the level's and stays.
    const holdsSpawn = (id: string): boolean =>
      model.tree.nodes.get(id)?.extra["spawn"] === true || descendants(model.tree, id).some((d) => d.extra["spawn"] === true);
    const doomedNodes = [...selectedBodyIds].filter((id) => model.tree.nodes.has(id) && !holdsSpawn(id));
    if (doomedNodes.length < [...selectedBodyIds].filter((id) => model.tree.nodes.has(id)).length) flashNotice("the spawn is the level's own: it is not deleted");
    if (!doomed.size && !doomedNodes.length && !selectedChainIds.size && !selectedVineIds.size) return;
    beginAction();
    model.items = model.items.filter((b) => !doomed.has(b.id));
    for (const id of doomedNodes) {
      const gone = removeSubtree(model.tree, id);
      const lost = new Set(gone.flatMap((n) => (n.item !== null ? [n.item] : [])));
      if (lost.size) model.items = model.items.filter((b) => !lost.has(b.id));
      for (const n of gone) {
        if (n.chain !== null) selectedChainIds.add(n.chain);
        if (n.vine !== null) selectedVineIds.add(n.vine);
      }
    }
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

  // Mirror the selection left-for-right about its own middle (`flipItemsH`), so
  // a route can be turned round to run the other way without redrawing it.
  function flipSelectedH(): void {
    const sel = operandItems();
    if (!sel.length) return;
    beginAction();
    flipItemsH(model, sel);
    markDirty();
    rebuildInspector();
  }

  function duplicateSelected(): void {
    const sel = operandItems();
    if (!sel.length) return;
    beginAction();
    // The part of the level the selection is, beside it: its nodes, the
    // bodies and groups above them, and the chains and vines between them.
    graftAndSelect(subModel(model, sel), new Vec2(gridStep * 2, gridStep * 2), commonParentOf(sel));
  }

  // The parent every one of these items' top nodes shares, so a duplicate
  // lands beside what it copies; the level's root when they differ.
  function commonParentOf(items: readonly EdItem[]): string | null {
    const tops = new Set(items.map((i) => {
      let id = i.unit;
      for (const a of ancestors(model.tree, i.node)) if (a.grouped && selectedBodyIds.has(a.id)) id = a.id;
      return model.tree.nodes.get(id)?.parent ?? null;
    }));
    return tops.size === 1 ? [...tops][0]! : null;
  }

  // --- clipboard ------------------------------------------------------------
  //
  // THE CLIPBOARD IS TEXT, and its text is a fragment of a LEVEL FILE (see
  // `editor/clipboard.ts`). That is what makes Ctrl+C in one tab and Ctrl+V in
  // another work at all: the system clipboard is the only thing two tabs share
  // without a server, and an assembly built once - a finish gantry, a lamp, a
  // rail rig - has to be able to reach the other levels.
  //
  // What was here before was three arrays of live `EdItem`s, which a reload
  // emptied and a second tab never saw.

  // Whether a keyboard shortcut may act at all: the same test the keydown
  // handler makes, since a `copy` or `paste` event fires wherever the caret is
  // and the inspector's fields have their own editing to do.
  function clipboardUsable(target: EventTarget | null): boolean {
    if (mode !== "edit") return false;
    return !(
      (target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "radio") ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    );
  }

  // The body a paste JOINS, or null for a paste that brings bodies of its own.
  //
  // It is the rule `newDrawnItem` follows, one gesture along: with a body
  // selected the thing being pasted is a part of it - the collision box under a
  // mesh copied off another wall, a second shape for a compound one, the light
  // a lamp throws - and giving it a body of its own would mean pasting it,
  // selecting both and merging, every single time.
  //
  // Both sides have to be able to share one. The selected body is refused on the
  // same terms merging refuses it (an area is single-shape wherever it is used),
  // and so is the arriving payload - a camera region or a note is not a piece of
  // anything and keeps the body of its own that `cloneBodies` mints.
  //
  // ...and the payload has to BE one body. A copy spanning several is an
  // assembly rather than a part: folding it into one would collapse the chains
  // and vine spans between its pieces, which need two bodies to hold on to and
  // are dropped at load when they have one (see `addChain`). That pastes as it
  // always did, and New body is there to make one of it afterwards on purpose.
  function pasteHostBody(items: readonly EdItem[]): string | null {
    const host = soleBodyId();
    if (host === null) return null;
    if (!bodyMembers(model.items, host).every(canShareBody)) return null;
    if (!items.every(canShareBody)) return null;
    if (!items.every((i) => i.unit === items[0]!.unit)) return null;
    return host;
  }

  // Ctrl+C. Returns the payload, or null when there is nothing to copy.
  function copySelection(): string | null {
    const sel = operandItems();
    if (!sel.length) return null;
    return writeClipboard(model, sel);
  }

  // Ctrl+V. `text` is whatever the system clipboard had, and anything that is
  // not a payload does nothing rather than throwing - the input is whatever
  // happened to be on the clipboard, and a sentence is not an error the author
  // made.
  //
  // What is NOT here is a fallback to this tab's own last copy. It read as
  // generosity - a paste that works even once the clipboard has moved on - and
  // was the whole of the middle-click bug below: every paste the page did not
  // ask for, carrying text that is not a payload, landed the last copy instead
  // of declining. A paste pastes what is on the clipboard, or nothing.
  function pasteClipboard(text: string | null): void {
    // The payload is a fragment of a level file (`editor/clipboard.ts`),
    // read through the same loader a level is, as a model of its own.
    const arrived = text !== null ? readClipboard(text) : null;
    if (!arrived || !arrived.items.length) return;
    // Pasted items keep the layer they were copied from - a camera region can't
    // become a body - so a paste reveals and unlocks any layer it lands on
    // rather than dropping items where they can be neither seen nor clicked.
    for (const l of new Set(arrived.items.map((i) => i.layer))) {
      setLayerVisible(l, true);
      setLayerLocked(l, false);
    }
    const box = bodyBounds(arrived.items);
    let delta = pointerWorld().sub(box.min.add(box.max).mul(0.5));
    // Land the group's top-left corner on the grid, as a move does.
    if (snapOn) delta = snapVec(box.min.add(delta)).sub(box.min);
    // A placed prefab arrives whole: joining would move its insides out of it
    // into the selected body, where they are neither its (it wrote them
    // `disabled`) nor the body's (they were still marked as its), and both
    // lost them on save (2026-11-26, a pasted `mine-sleeper` with another
    // selected lost its model).
    const host = [...arrived.tree.nodes.values()].some((n) => n.instance) ? null : pasteHostBody(arrived.items);
    beginAction();
    // Anchor numbers are re-minted by the graft, so a paste
    // into a level that already holds anchor 1 does not end up with two.
    const before = new Set(model.tree.nodes.keys());
    graftAndSelect(arrived, delta, null);
    // INTO THE SELECTED BODY: the pasted pieces move under it, each where it
    // landed, and the body the copy came in leaves. What joining a body
    // changes is what the piece is PART of.
    if (host !== null) {
      const arrivedRoots = model.tree.roots.filter((r) => !before.has(r));
      for (const r of arrivedRoots) {
        const n = model.tree.nodes.get(r);
        if (!n?.body) continue;
        for (const c of [...n.children]) moveNode(model, c, host, undefined);
        if (!n.children.length) removeSubtree(model.tree, r);
      }
      relink(model);
      setSelection(model.items.filter((i) => i.bodyOf === host && !before.has(i.node)).map((i) => i.id));
    }
  }

  // THE DOM'S OWN EVENTS rather than the keydown switch, and that is what the
  // system clipboard costs: `copy` and `paste` are the only places a page may
  // read or write it without a permission prompt, and neither fires when
  // keydown has already cancelled the key. So the two cases moved out of the
  // Ctrl block (`Ctrl+D`, duplicate, is untouched - it touches no clipboard).
  document.addEventListener("copy", (e) => {
    if (!clipboardUsable(e.target)) return;
    const payload = copySelection();
    if (payload === null) return;
    e.clipboardData?.setData("text/plain", payload);
    e.preventDefault();
  });
  // MIDDLE CLICK IS PAN, NOT PASTE. On Linux the browser pastes the X primary
  // selection when the middle button is RELEASED, and it does it by dispatching
  // a `paste` at the page - over a canvas, with nothing editable under it and
  // nothing to insert into, the event still arrives here. So every middle-drag
  // of the view ended in a paste the author never asked for.
  //
  // The gesture the editor gives that button is panning, and it has to be able
  // to end without the view gaining a copy of something. This is the only tell
  // the DOM offers that a paste came from the mouse rather than from Ctrl+V,
  // and it holds because the browser dispatches the paste from inside its own
  // handling of that release: the flag is still standing one task later.
  let middleButtonPaste = false;
  window.addEventListener("mousedown", (e) => {
    if (e.button === 1) middleButtonPaste = true;
  }, true);
  window.addEventListener("mouseup", (e) => {
    if (e.button !== 1) return;
    middleButtonPaste = true;
    setTimeout(() => (middleButtonPaste = false), 0);
  }, true);
  // ...and a KEY PRESS takes it down again, whatever the mouse is doing. Ctrl+V
  // dispatches its `paste` from inside the keydown, so a paste that follows a
  // key is the author's by construction - and this is what keeps a middle press
  // whose release never arrived (a drag out of the window, a lost button) from
  // silently costing the editor its paste for the rest of the session.
  window.addEventListener("keydown", () => (middleButtonPaste = false), true);
  document.addEventListener("paste", (e) => {
    if (middleButtonPaste) return;
    if (!clipboardUsable(e.target)) return;
    pasteClipboard(e.clipboardData?.getData("text/plain") ?? null);
    e.preventDefault();
  });

  // --- disk -----------------------------------------------------------------
  // Whether the list arrived; a failed one leaves the dropdown as it was.
  async function refreshLevelList(): Promise<boolean> {
    try {
      levelNames = await listLevels();
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  // The level's paint: every painted decoration's strokes, by its id, in
  // `levels/paint/<level>.json`; a prefab's in `prefabs/paint/<prefab>.json`
  // (`paintDoc`). A placed prefab's decorations start from the prefab's
  // strokes (`inst/deco` reads the prefab's `deco`), and only those painted
  // over here are written to the level's: the rest go on following the prefab.
  let savedPaint = "";
  const inheritedPaint = new Map<string, string>();
  const paintDoc = (name: string): string => (prefabMode ? `${PAINT_API}/prefabs/${name}` : `${PAINT_API}/${name}`);
  async function savePaint(name: string): Promise<void> {
    const strokes: Record<string, PaintStamp[]> = {};
    for (const i of model.items) {
      const own = i.decoration?.strokes;
      if (!own?.length || inheritedPaint.get(i.decoration!.id) === JSON.stringify(own)) continue;
      strokes[i.decoration!.id] = own;
    }
    const text = JSON.stringify(strokes);
    if (text === savedPaint) return;
    const res = await fetch(paintDoc(name), { method: "PUT", headers: { "Content-Type": "application/json" }, body: text });
    if (!res.ok) throw new Error(`the paint could not be saved (${res.status})`);
    savedPaint = text;
  }
  async function loadPaint(name: string): Promise<void> {
    // Paint that cannot be read is no paint: the level still opens.
    const read = async (url: string): Promise<Record<string, PaintStamp[]>> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        return res.ok ? ((await res.json()) as Record<string, PaintStamp[]>) : {};
      } catch {
        return {};
      }
    };
    const strokes = await read(paintDoc(name));
    // Each placed prefab's own strokes, under the ids its decorations take.
    inheritedPaint.clear();
    const inherited: Record<string, PaintStamp[]> = {};
    for (const n of model.tree.nodes.values()) {
      if (!n.instance) continue;
      const theirs = await read(`${PAINT_API}/prefabs/${n.instance.prefab}`);
      for (const [id, list] of Object.entries(theirs)) {
        inherited[`${n.id}/${id}`] = list;
        inheritedPaint.set(`${n.id}/${id}`, JSON.stringify(list));
      }
    }
    for (const i of model.items) {
      if (!i.decoration) continue;
      const list = strokes[i.decoration.id] ?? inherited[i.decoration.id];
      if (list) i.decoration = { ...i.decoration, strokes: list };
    }
    savedPaint = JSON.stringify(strokes);
  }

  async function doLoad(name: string): Promise<void> {
    // A level opened over an open prefab takes its place, the prefab written.
    if (prefabMode) {
      if (!(await flushPrefab())) return;
      endPrefab();
      refreshDocButtons();
    }
    cancelAutosave(); // don't write the outgoing model to the incoming name
    try {
      const data = await loadLevel(name);
      replaceModel(modelFromDisk(data));
      await loadPaint(name);
      resetHistory();
      selectedIds.clear();
      selectedVerts.clear();
      // Body ids are per-model, so one carried across a load would highlight a
      // body in the incoming level that has nothing to do with the one picked.
      selectedBodyIds.clear();
      currentName = name;
      writeLastLevel(name);
      dirty = false;
      camera.position = model.player.pos;
      poseFromCameraNow();
      rebuildInspector();
      updateTitle();
    } catch (e) {
      // A toast, not a modal: a modal blocks the page outright (and with it
      // any tool driving it) for news that needs no answer.
      showToast(`Load failed: ${e}`, "warn");
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
    // An open prefab is saved as itself, never as a level.
    if (prefabMode) {
      if (!auto && prefabName) {
        if (prefabSaveTimer) clearTimeout(prefabSaveTimer);
        prefabSaveTimer = null;
        await writePrefab(prefabName);
      }
      return;
    }
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
      // ...and its paint, beside it (docs/formations.md, "Decorations").
      await savePaint(name);
      currentName = name;
      writeLastLevel(name);
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
    // ...and an open prefab's, which is written the same way.
    if (prefabMode && prefabName && prefabSaveTimer !== null) {
      const data = prefabOfModel();
      if (typeof data !== "string") void savePrefab(prefabName, data, { keepalive: true }).catch(() => {});
      return;
    }
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
  //
  // `z` asks about the plane that far in front of the gameplay plane instead
  // (metres), for a drag of something DRAWN at a depth of its own - a light
  // hanging at its `z`, a prop's corners on the face it is drawn at - so what is
  // dragged stays under the pointer rather than sliding at the plane's rate.
  // Head on every such plane is the same picture, and the answer is the 2D one.
  //
  // In the Visuals workspace the camera is the pose's (placed by the workspace
  // the moment a gesture moves it), and a ray that misses the plane - the
  // camera standing behind it - falls back to where the pointer last met it
  // rather than to a 2D camera that is not the view on screen.
  let lastPlaneHit: Vec2 = Vec2.ZERO;
  function canvasWorld(scr: Vec2, z = 0): Vec2 {
    if (!inScene() || !scene3d) return screenToWorld(camera, scr.x, scr.y);
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return screenToWorld(camera, scr.x, scr.y);
    const hit = unprojectToPlane(
      scene3d.camera,
      (scr.x / r.width) * 2 - 1,
      1 - (scr.y / r.height) * 2,
      z,
    );
    if (hit) lastPlaneHit = hit;
    return hit ?? lastPlaneHit;
  }
  // Where a world point (at depth `z`) is on the canvas, in CSS pixels: the
  // inverse of `canvasWorld`, for a press tested against something drawn (the
  // first vertex a polygon draft closes on). Turned, through the 3D view.
  function canvasScreen(world: Vec2, z = 0): Vec2 {
    // Behind the camera it is nowhere on the canvas, so no press is near it.
    if (camera.project) return camera.project(world, z) ?? new Vec2(Infinity, Infinity);
    return worldToScreen(camera, world);
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
  function grabVertex(item: EdItem, index: number, shift: boolean, planeZ = 0): Drag | "consumed" | null {
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
    // Offsets in the SHAPE's own frame, taken from the pressed vertex. A corner
    // edit leaves that frame exactly where it is (`setPolyVerts` writes the loop
    // and moves nothing), so an offset captured at the press still names the
    // same corner however far the drag goes.
    const lead = verts[index]!;
    const others = selectedVertIndices(item)
      .filter((i) => i !== index)
      .map((i) => ({ index: i, offset: verts[i]!.sub(lead) }));
    return { mode: "polyVertex", body: item, index, others, accepted: lead, planeZ };
  }

  // A press on corner `i` of the shape open for vertex editing: Alt+click
  // removes it (never below the loop's floor: three for a polygon, two for an
  // open path), anything else picks it and drags it. One function for the
  // overlay's square and the Visuals workspace's guide handle, so the two
  // cannot come to mean different things. `planeZ` is the plane the corner is
  // drawn in, which a drag of it stays in.
  function pressVertex(s: EdItem, i: number, alt: boolean, shift: boolean, planeZ = 0): Drag | "consumed" | null {
    const shape = s.shape;
    if (shape.kind !== "poly" && shape.kind !== "path") return null;
    if (!alt) return grabVertex(s, i, shift, planeZ);
    if (shape.verts.length <= (shape.kind === "path" ? 2 : 3)) return null;
    // A branch's junction is not a node it could lose (`deleteSelectedVerts`).
    if (i === 0 && isRootItem(s) && s.root.parent !== null) return "consumed";
    beginAction();
    const ok =
      shape.kind === "path"
        ? setPathVerts(
            s,
            shape.verts.filter((_, j) => j !== i),
            shape.handles.filter((_, j) => j !== i),
            shape.keys.filter((_, j) => j !== i),
          )
        : setPolyVerts(s, shape.verts.filter((_, j) => j !== i));
    if (ok) {
      // Every index past the removed one has shifted, so the set names corners
      // nobody picked; it goes rather than being renumbered, since a removal
      // is the end of the gesture that made it.
      selectedVerts.clear();
      markDirty();
      rebuildInspector();
    }
    return "consumed";
  }

  // A press on the midpoint of edge `i` (from vertex `i` to the next): insert
  // a vertex there and drag it straight away, so adding a corner and placing it
  // is one gesture.
  function pressMidpoint(s: EdItem, i: number, planeZ = 0): Drag | null {
    const shape = s.shape;
    let mid: Vec2;
    if (shape.kind === "path") {
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
      mid = n1.add(n2).mul(0.5);
      const verts = [...shape.verts.slice(0, i + 1), mid, ...shape.verts.slice(i + 1)];
      const handles = shape.handles.map((x) => ({ ...x }));
      handles[i] = { in: handles[i]!.in, out: m1.sub(a.p) };
      handles[i + 1] = { in: m3.sub(b.p), out: handles[i + 1]!.out };
      handles.splice(i + 1, 0, { in: n1.sub(mid), out: n2.sub(mid) });
      // The new node keys nothing: an unkeyed node is transparent to the
      // interpolation, so the split changes the framing along the route by
      // exactly as much as it changes the curve - nothing.
      const keys = shape.keys.map((k) => ({ ...k }));
      keys.splice(i + 1, 0, NO_KEY());
      beginAction();
      dragPushed = true;
      if (!setPathVerts(s, verts, handles, keys)) return null;
    } else if (shape.kind === "poly") {
      const verts = shape.verts;
      mid = verts[i]!.add(verts[(i + 1) % verts.length]!).mul(0.5);
      const next = [...verts.slice(0, i + 1), mid, ...verts.slice(i + 1)];
      beginAction();
      dragPushed = true;
      if (!setPolyVerts(s, next)) return null;
    } else {
      return null;
    }
    markDirty();
    // The inserted vertex becomes the selection: it is the one the gesture is
    // about, and every index past it has just shifted, so carrying the old set
    // over would name different corners than the ones that were picked.
    selectedVerts.clear();
    selectedVerts.add(i + 1);
    return { mode: "polyVertex", body: s, index: i + 1, others: [], accepted: mid, planeZ };
  }

  // The nearest level surface under the pointer, leaving out the
  // body `exclude` - the thing being put down must not be put down on itself.
  // Whatever the level draws counts - the bodies' formations and models, and
  // the pieces' debug geometry; the guides, the gizmo and the ball at the
  // spawn do not.
  function surfaceUnder(scr: Vec2, exclude: string | null): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const hit = visuals?.surfaceAt(scr, (tag) => {
      const id = itemOfSceneObject.get(tag as SceneTag);
      const it = id === undefined ? null : itemOf(id);
      return it !== null && it.unit !== exclude;
    });
    return hit ? { point: new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z), normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) } : null;
  }

  // Run a write with the grid off. A drop on a surface is exact by nature: the
  // point it lands on is where the face IS, and rounding it to the 5 cm grid
  // would sink a lamp into the rock it was stood on or float it off.
  function unsnapped(write: () => void): void {
    const was = snapOn;
    snapOn = false;
    try {
      write();
    } finally {
      snapOn = was;
    }
  }

  // One pointer move of a DROP ON SURFACE. Written through the gizmo's own
  // item handler - the move - so what it writes (`pos` and a light's `z`) is
  // written exactly as the arrows write it. Begun at the first move past the
  // click's slop, which is the one undo step.
  function surfaceDropMove(d: Extract<Drag, { mode: "surfaceDrop" }>, scr: Vec2): void {
    if (!d.handlers) {
      if (scr.distanceTo(d.press) < CLICK_SLOP_PX) return;
      d.handlers = itemHandlers(d.item.id);
      d.handlers.begin("translate");
    }
    const it = itemOf(d.item.id);
    if (!it) return;
    const hit = surfaceUnder(scr, it.unit);
    // Over nothing it stays where it last landed: a drop has no plane to fall
    // back to, and snapping to the gameplay plane would be a move nobody made.
    if (!hit) return;
    const at = surfacePlacement(hit.point);
    const pos = new THREE.Vector3(at.pos.x, threeY(at.pos.y), at.z);
    const handlers = d.handlers;
    unsnapped(() => handlers.apply("translate", pos, itemQuat(it), new THREE.Vector3(1, 1, 1)));
  }

  // A press on a mover's route: a node, a tangent grip, or a leg midpoint that
  // inserts one - the camera path's three gestures, on the one other kind of
  // path this editor authors, and deliberately in the same order and with the
  // same modifiers so an author who has shaped one has shaped both.
  //
  // Node zero is pickable but not draggable: it IS the body, and dragging it
  // would be a second, quieter way of moving the body that left every other node
  // behind. It is still picked, because it keys like any other node - the angle
  // and the speed a cart sets off at are exactly the kind of thing to want to
  // state.
  function pickRouteHandle(
    lead: EdItem,
    scr: Vec2,
    alt: boolean,
    shift: boolean,
  ): Drag | "consumed" | null {
    const pts = routeWorldPoints(model, lead);
    for (let i = 0; i < pts.length; i++) {
      if (worldToScreen(camera, pts[i]!).distanceTo(scr) > HANDLE_HIT_PX) continue;
      // Alt removes it, the same gesture that removes a polygon's corner - and
      // never node zero, which is the body. A route of one node is not a route,
      // so the last leg's removal takes the whole thing.
      if (alt && i > 0) {
        beginAction();
        propsOf(lead).route = propsOf(lead).route.filter((_, j) => j !== i).map(cloneRouteNode);
        if (propsOf(lead).route.length < 2) propsOf(lead).route = [];
        clearRouteSel();
        markDirty();
        rebuildInspector();
        return "consumed";
      }
      // Picking a node is what opens its key fields, and Shift extends the set
      // exactly as it does for a polygon's corners.
      if (shift || selectedRouteNodes(lead).indexOf(i) < 0) pickRouteNode(lead, i, shift);
      rebuildInspector();
      return i === 0 ? "consumed" : { mode: "moveWaypoint", lead, index: i };
    }
    // The tangent grips, AFTER the nodes: a handle pulled back onto its own node
    // sits under it, and the node is the thing that has to stay pickable.
    for (const g of routeHandlePoints(camera, model, lead)) {
      if (worldToScreen(camera, g.pos).distanceTo(scr) > HANDLE_HIT_PX) continue;
      return { mode: "routeHandle", lead, index: g.node, side: g.side, mirror: !alt };
    }
    // ...and the leg midpoints, which insert a node and drag it in the same
    // gesture. A de Casteljau split at t = 1/2 (`splitCubicAtHalf`), so a bowed
    // leg gains a node and changes shape by nothing - splitting the chord would
    // straighten the leg the moment it was subdivided.
    const mids = routeMidpoints(model, lead);
    for (let i = 0; i < mids.length; i++) {
      if (worldToScreen(camera, mids[i]!).distanceTo(scr) > HANDLE_HIT_PX) continue;
      beginAction();
      const a = propsOf(lead).route[i]!;
      const b = propsOf(lead).route[(i + 1) % propsOf(lead).route.length]!;
      const split = splitCubicAtHalf(
        { p: a.p, in: a.in, out: a.out },
        { p: b.p, in: b.in, out: b.out },
      );
      const next = propsOf(lead).route.map(cloneRouteNode);
      next[i] = { ...next[i]!, out: split.outA };
      next[(i + 1) % next.length] = { ...next[(i + 1) % next.length]!, in: split.inB };
      // The new node keys nothing: putting a key mid-leg is then one further
      // gesture, and an insert that invented one would be an insert that changed
      // the motion.
      next.splice(i + 1, 0, {
        p: split.mid,
        in: split.inMid,
        out: split.outMid,
        rot: null,
        speed: null,
      });
      propsOf(lead).route = next;
      pickRouteNode(lead, i + 1, false);
      markDirty();
      rebuildInspector();
      return { mode: "moveWaypoint", lead, index: i + 1 };
    }
    // Nothing on the route was under the pointer, so the press falls through to
    // whatever is: the body, or the empty space that clears the selection.
    return null;
  }

  // Which handle of the selected body (if any) is under the pointer?
  //
  // `"consumed"` means the press *was* a handle interaction that finished on the
  // spot and started no drag — removing a polygon vertex. It has to be
  // distinguishable from "no handle here": falling through to the body pick
  // would land on empty space (the vertex just went away) and clear the
  // selection, so a removal would deselect the shape it edited.
  // The item a body's route is held on: its collision lead, and only when it
  // actually has a route. One place, so the press handler, the panel and the
  // canvas cannot disagree about which item carries the nodes.
  function routeLeadOf(id: string): EdItem | null {
    const lead = bodyMembers(model.items, id).find((m) => m.object === "collision");
    return lead && propsOf(lead).kind === "static" && propsOf(lead).route.length > 0 ? lead : null;
  }

  function pickHandle(scr: Vec2, alt = false, shift = false): Drag | "consumed" | null {
    // A selected body's ROUTE, first: its nodes sit over the geometry that
    // carries them, so a press on one has to mean the node rather than the body
    // under it. Only while exactly one body is selected, since a route belongs
    // to a body and two of them have two.
    const routeBody = routeEditTarget();
    if (routeBody) {
      const hit = pickRouteHandle(routeBody, scr, alt, shift);
      if (hit) return hit;
    }
    // A selected vine is edited by its two handles and nothing else: the anchor
    // it hangs from, which is where it is, and its free end, which is how long
    // it is. The tip is tested first, so the two cannot fight over a press on a
    // vine drawn short enough for them to overlap.
    const vines = selectedVines();
    if (vines.length === 1) {
      const vine = vines[0]!;
      // The picked berry's root, which slides along the vine, before the
      // vine's ends: a root can sit over either.
      const picked = currentBerry();
      if (picked?.vine === vine) {
        const handle = computeBerryHandles(camera, model, vine)[picked.index];
        if (handle && scr.distanceTo(handle.rootScreen) <= HANDLE_HIT_PX) {
          return { mode: "berryPosition", vine, index: picked.index };
        }
      }
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
        // ...and by its wrap points, each a handle of the same kind.
        for (let i = 0; i < ends.via.length; i++) {
          const p = ends.via[i]!;
          if (scr.distanceTo(p) <= HANDLE_HIT_PX) {
            return { mode: "chainVia", chain: chains[0]!, index: i, cursor: p };
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
        const centre = bodyTurnCentre(whole);
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
    if (!s) return null;
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
      for (let i = 0; i < h.verts.length; i++) {
        if (scr.distanceTo(h.verts[i]!) > HANDLE_HIT_PX) continue;
        return pressVertex(s, i, alt, shift);
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
        return pressMidpoint(s, i);
      }
    }
    // Vertices before the rotate knob: on a small polygon the knob can overlap a
    // corner, and the corner is what the pointer is far more often after.
    if (h.verts && s.shape.kind === "poly") {
      for (let i = 0; i < h.verts.length; i++) {
        if (scr.distanceTo(h.verts[i]!) > HANDLE_HIT_PX) continue;
        return pressVertex(s, i, alt, shift);
      }
      // An edge midpoint splits that edge: insert a vertex there and drag it
      // straight away, so adding a corner and placing it is one gesture.
      for (let i = 0; i < (h.vertMids?.length ?? 0); i++) {
        if (scr.distanceTo(h.vertMids![i]!) > HANDLE_HIT_PX) continue;
        return pressMidpoint(s, i);
      }
    }
    // A belt's wheel centres before their radius grips, as a path's vertex is
    // tested before its tangent grips: a wheel shrunk to nothing puts its grip
    // on its own centre, and the centre is the one reached for. Then the run
    // midpoints, which insert a wheel.
    if (h.beltCentres && s.shape.kind === "belt") {
      for (let i = 0; i < h.beltCentres.length; i++) {
        if (scr.distanceTo(h.beltCentres[i]!) > HANDLE_HIT_PX) continue;
        // Alt+click removes the wheel instead of dragging it - two is the
        // floor, and `beltRemoveWheel` refuses a removal that would leave a
        // wheel inside the hull the others make.
        if (alt) {
          if (s.shape.wheels.length <= 2) return null;
          beginAction();
          if (beltRemoveWheel(s, i)) {
            selectedVerts.clear();
            markDirty();
            rebuildInspector();
          }
          return "consumed";
        }
        pickBeltWheel(i);
        // Wheel 0 IS the item's position: pressing it picks it and then moves
        // the belt the way a press on the body does.
        if (i === 0) return null;
        return { mode: "beltWheel", body: s, index: i };
      }
      for (let i = 0; i < (h.beltRadii?.length ?? 0); i++) {
        if (scr.distanceTo(h.beltRadii![i]!) > HANDLE_HIT_PX) continue;
        pickBeltWheel(i);
        return { mode: "beltRadius", body: s, index: i };
      }
      for (let i = 0; i < (h.beltMids?.length ?? 0); i++) {
        if (scr.distanceTo(h.beltMids![i]!) > HANDLE_HIT_PX) continue;
        // Inserted TOUCHING the band at the midpoint, which changes nothing
        // about the loop, and dragged straight away, so adding a wheel and
        // placing it is one gesture - the path's insert.
        beginAction();
        dragPushed = true;
        const index = beltInsertWheel(s, h.beltRunFrom![i]!);
        if (index < 0) return null;
        markDirty();
        selectedVerts.clear();
        selectedVerts.add(index);
        rebuildInspector();
        return { mode: "beltWheel", body: s, index };
      }
    }
    if (h.depth && scr.distanceTo(h.depth) <= HANDLE_HIT_PX) {
      return { mode: "depth", body: s, base: depthOf(s), press: scr };
    }
    if (h.rotate && scr.distanceTo(h.rotate) <= HANDLE_HIT_PX) return { mode: "rotate", body: s };
    if (h.wake && scr.distanceTo(h.wake) <= HANDLE_HIT_PX) return { mode: "wake", body: s };
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

  // Where a right press with the paint brush on began (see `apply` on mouseup).
  let brushRightPress: Vec2 | null = null;
  // Off the canvas, the paint brush's cursor is not over anything it would paint.
  canvas.addEventListener("mouseleave", () => {
    if (!decorations.dragging) decorations.hover(null);
  });
  canvas.addEventListener("mousedown", (e) => {
    if (mode !== "edit") return;
    // A grab ends on the next press: the left places, any other cancels.
    if (grab) {
      endTransform(e.button === 0);
      e.preventDefault();
      return;
    }
    // The gizmo took this press. Its own listener is on `pointerdown`, which
    // fires first, so by now it has already decided whether a handle was hit -
    // and a press that grabs an arrow must not also select, pan or rubber-band
    // whatever happens to be under it. Only the LEFT button is the gizmo's:
    // the middle and right buttons navigate wherever they are pressed, as in
    // any 3D editor (a hovered handle under the pointer swallowed the orbit).
    if (gizmo?.busy && e.button === 0) return;
    // NAVIGATION, in every workspace (since 2026-11-27): a middle or right
    // drag pans, Alt + middle orbits, the wheel dollies, and the left button
    // is the level's alone. Panning is how you get around a level and is the
    // gesture made most, so it is the unmodified one; the turn is the rarer
    // act and the one you come back from. (Until then the middle button
    // orbited and Shift + middle panned, Blender's way.) Without WebGL there
    // is no pose, and the middle and right buttons pan the 2D camera.
    // The paint brush's eraser (since 2026-11-26): a right press on the rock
    // the brush paints erases where it drags. Anywhere else the right button
    // pans, as ever.
    if (e.button === 2 && visuals?.active && decorations.brush && decorations.press(decorationHit(pointerScreen(e)), model.items.filter((i) => selectedIds.has(i.id)), true)) {
      rebuildInspector();
      e.preventDefault();
      return;
    }
    // A right press while a placed kind is armed may be a click, which ends
    // it (`decorations.apply`), or the start of a pan, as ever: told apart
    // when it is let go.
    brushRightPress = e.button === 2 && decorations.rightClickEnds ? pointerScreen(e) : null;
    if (visuals?.active && (e.button === 1 || e.button === 2)) {
      // A swing to a cube face in flight gives way to the hand.
      viewSwing++;
      visuals.beginView(e.button === 1 && e.altKey ? "orbit" : "pan", pointerScreen(e));
      drag = { mode: "view" };
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
    // Sculpt mode's brush, or a cut's next corner: the left button is theirs.
    if (sculptCtl && (sculptCtl.active || sculptCtl.cutting || sculptCtl.busy) && sculptCtl.press(scr, e)) {
      e.preventDefault();
      return;
    }
    // Combining guides: a click picks (or lets go) the guide under it, the
    // nearest one drawn there, and selects nothing.
    if (combine) {
      const target = combine.target;
      const hit = pickCandidatesAt(canvasWorld(scr), scr).find((i) => isSolidGuide(i) && i.id !== target);
      if (hit) toggleCombinePick(hit.id);
      e.preventDefault();
      return;
    }
    // A decoration being placed, painted or dragged along its rock (the
    // Visuals workspace's: docs/formations.md, "Decorations").
    if (visuals?.active && decorations.press(decorationHit(scr), model.items.filter((i) => selectedIds.has(i.id)))) {
      rebuildInspector();
      e.preventDefault();
      return;
    }
    // A shape of the solid guide being edited (the boolean stack, see
    // formation/solidStack.ts): picked for the gizmo by a click on it, as an
    // object is in any 3D editor. Only the selected formation's shapes are
    // there to be hit.
    if (visuals?.active && workspace === "formations" && solidView && scene3d && !e.shiftKey && !e.altKey) {
      const shape = solidView.pickShape(visuals.ndc(scr), scene3d.camera);
      if (shape) {
        solidSel = shape;
        rebuildInspector();
        syncGizmo();
        e.preventDefault();
        return;
      }
    }
    const world = canvasWorld(scr);
    // A tied chain being strung out knot by knot (see `finishOrTieChainDraw`):
    // this press is the next knot or the chain's end, and nothing else.
    if (drag?.mode === "chainDraw" && drag.knots.length > 0) {
      drag.cursor = world;
      finishOrTieChainDraw(e.shiftKey);
      e.preventDefault();
      return;
    }
    dragPushed = false;

    // AT ANY ANGLE (the one 3D view, plans/editor-ux-pass.md): a ray answers
    // for the models and meets the gameplay plane for everything resolved
    // against it (`canvasWorld`), and the overlay - handles, band, drafts - is
    // drawn through the view, with `worldToScreen` mapping through it too, so
    // every step below means turned what it means head on.
    // With +Root armed the selection's handles are not drawn (see the frame
    // loop) and so are not grabbed: a press on a root starts a branch there.
    // The knife's the same: a press on a corner is where the cut starts.
    if (tool !== "root" && tool !== "cut") {
      // 1. Handles of the current selection.
      const h = pickHandle(scr, e.altKey, e.shiftKey);
      if (h === "consumed") return; // handled outright; no drag, selection intact
      if (h) {
        drag = h;
        return;
      }
    }
    // What this press draws: the armed tool at any angle, its preview drawn
    // with the rest of the overlay on the gameplay plane.
    const drawTool = tool;
    // 1a. The knife: two clicks, the second cutting (Alt: into one body).
    if (drawTool === "cut") {
      const p = cutPoint(scr).at;
      if (!cutDraft) {
        cutDraft = { from: p };
        updateTitle();
      } else commitCut(p, e.altKey);
      e.preventDefault();
      return;
    }
    // 1b. Polygon drafting: a run of clicks, not a drag. Clicking the first
    // vertex again (or Enter) closes the loop; Esc drops it.
    if (drawTool === "poly" || drawTool === "path" || drawTool === "shelter" || drawTool === "track") {
      const p = snapVec(world);
      const open = drawTool === "path" || drawTool === "track";
      // A path is finished by Enter or a double-click, never by clicking back on
      // its first vertex: an open run may legitimately end where it started (a
      // loop of a level), and closing on it would make that unauthorable.
      if (!open && polyDraft && polyDraft.verts.length >= 3) {
        const first = canvasScreen(polyDraft.verts[0]!);
        if (scr.distanceTo(first) <= POLY_CLOSE_PX) {
          commitPolyDraft();
          return;
        }
      }
      if (open && e.detail >= 2 && polyDraft && polyDraft.verts.length >= 2) {
        commitPolyDraft();
        return;
      }
      polyDraft = { kind: drawTool, verts: [...(polyDraft?.verts ?? []), p] };
      updateTitle();
      return;
    }
    // 1b'. Root drafting: the same run of clicks a curve is, each press placing
    // a node and its drag pulling out that node's handles (`rootHandle`). The
    // FIRST press decides what is being drawn: on a root it grows a branch out
    // of that root, from the point on its centreline under the pointer; over
    // anything else it starts a new root.
    if (drawTool === "root") {
      if (rootDraft && e.detail >= 2 && rootDraft.verts.length >= 2) {
        commitRootDraft();
        return;
      }
      if (!rootDraft) {
        const slop = canvasWorld(scr.add(new Vec2(ROOT_PICK_PX, 0))).distanceTo(world);
        const from = rootAt(model, world, slop, (i) => visibleLayers.has(i.layer) && !lockedLayers.has(i.layer) && !itemLocked(i));
        rootDraft = from
          ? {
              verts: [from.point],
              handles: [ZERO_HANDLE()],
              ...branchWidths(from.item, from.at),
              from: { item: from.item, at: from.at },
            }
          : { verts: [snapVec(world)], handles: [ZERO_HANDLE()], width: rootStartWidth, tip: rootTipWidth, from: null };
        // The toolbar's widths now show (and set) this draft's.
        refreshRootWidthFields();
      } else {
        rootDraft.verts.push(snapVec(world));
        rootDraft.handles.push(ZERO_HANDLE());
      }
      drag = { mode: "rootHandle", index: rootDraft.verts.length - 1 };
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
        drag = { mode: "chainDraw", from, local: nearestSurfaceLocal(from, world), cursor: world, knots: [] };
      }
      return;
    }
    // 1d. Vine tool: the same press on a body that starts a chain, and then a
    // drag that pulls a LENGTH out instead of reaching for a second body. A
    // vine has one end, so there is nowhere else for the gesture to go.
    if (drawTool === "vine") {
      const from = topmostAt(world, (b) => chainable(b));
      if (from) {
        drag = { mode: "vineDraw", from, local: nearestSurfaceLocal(from, world), length: 0 };
      }
      return;
    }
    // 1e. Glow tool: one click places a whole body - the cube, its collision
    // box and its waking light - so there is nothing to drag out.
    if (drawTool === "glow") {
      placeGlow(snapVec(world));
      return;
    }
    // 2. Draw tool: create a new item on the active layer and drag out its size.
    if (drawTool !== "select") {
      beginAction();
      dragPushed = true;
      const start = snapVec(world);
      const body = newDrawnItem(drawTool, start);
      // Into the selected body, or a body of its own (`insertDrawn`): a body
      // has one kind, one fill, one friction, held on its node.
      const made = insertDrawn(body);
      setSelection([body.id]);
      // A checkpoint has no size to drag out (see `newDrawnItem`), so the press
      // IS the whole gesture: entering a draw drag would offer a resize that
      // does nothing and leave the marker's box disagreeing with the avatar it
      // is drawn at.
      drag = drawTool === "checkpoint" || drawTool === "model" ? null : { mode: "draw", body, start, made };
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
    // 3. Player spawn marker (small target — needs pointer within its radius),
    // at any angle: the marker is drawn with the rest of the overlay, and the
    // pointer is resolved on the plane it stands on.
    // The spawn is gameplay: the 2D workspace's.
    // Not over an open prefab: its origin is where the model's spawn stands,
    // and a press there is a press on the prefab.
    const spawnHit =
      workspace === "2d" &&
      !prefabMode &&
      world.distanceTo(model.player.pos) <= Math.max(model.player.radius, SMALL_MARK_PICK_PX * worldLine());
    if (spawnHit) {
      drag = { mode: "movePlayer", grab: model.player.pos.sub(world) };
      return;
    }
    // Everything below that is not an authoring grip of its own is a click or
    // a band (see `marquee`): `pick` is what the press means if it never
    // leaves the click's slop.
    const band = (pick?: () => void): void => {
      drag = {
        mode: "marquee",
        start: world,
        current: world,
        press: scr,
        banding: false,
        additive: e.shiftKey,
        // While a polygon or a camera path is the selection, a band is asking
        // about ITS corners: the shape is already picked, so its vertices are
        // the only thing left on screen the band could sensibly mean. To band
        // bodies again, clear the selection first - a click on empty space
        // does that, dropping the vertex selection before the item one so
        // there is a way back out in two clicks.
        verts: vertexEditTarget(),
        pick,
      };
    };
    // 3b. A berry, before the bodies: it hangs in front of whatever is behind
    // it. A click picks it out (its gizmo moves it); Alt-click removes it.
    const berry = berryAt(world);
    if (berry) {
      if (e.altKey) {
        beginAction();
        deleteBerry(berry.vine, berry.index);
        markDirty();
        setVineSelection([berry.vine.id]);
        return;
      }
      band(() => selectBerry(berry.vine, berry.index));
      return;
    }
    // 3c. A vine, before the items too: it is a line a few pixels wide drawn
    // over everything, so a press within its band means it - not the camera
    // region or the wall behind it, which are reached anywhere else. Not in
    // the Visuals workspace, whose guides do not draw vines.
    const vine = topmostVineAt(world);
    if (vine) {
      setVineSelection([vine.id]);
      // ...and a press that DRAGS off the vine grows a berry on it, its stalk
      // leaving the cord where the press was and the berry where the drag is
      // released (see `berryDraw`), at any angle: the draft is drawn with the
      // overlay, through the view when it is turned.
      const path = vineRestPath(model, vine);
      if (path) {
        const along = Math.min(vine.length, berryAlongAt(path, world));
        drag = { mode: "berryDraw", vine, along, root: pointAlong(path, along), cursor: world, press: scr };
      } else drag = null;
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
    const cands = pickCandidatesAt(world, scr);
    const hit = cands[0] ?? null;
    // 3a. THE DECORATIONS WORKSPACE'S SELECT: a click on what grew selects
    // that decoration, not its rock's body first - what grows is what that
    // workspace edits, and a second click to drill into the body was a click
    // nobody meant (2026-11-25). A drag bands, as anywhere; Shift and Alt
    // keep their usual meaning.
    if (paintsRocks(workspace) && hit?.object === "decoration" && !selectedIds.has(hit.id) && !e.shiftKey && !e.altKey) {
      band(() => {
        pickCycle = null;
        setSelection([hit.id]);
      });
      return;
    }
    // 3b. DROP ON SURFACE: Shift-drag of the selected light, wherever it is in
    // the stack under the pointer - the gesture is about the selected thing,
    // which is plainly what was pressed on.
    if (visuals?.active && e.shiftKey && !e.altKey && selectedIds.size === 1) {
      const dropped = cands.find((c) => selectedIds.has(c.id) && c.object === "light");
      if (dropped) {
        drag = {
          mode: "surfaceDrop",
          item: dropped,
          press: scr,
          handlers: null,
          pick: () => toggleSelection(dropped.id),
        };
        return;
      }
    }
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
        band(() => toggleBodySelection(hit.unit));
        return;
      }
      // A DRAG IS A BAND, selected or not (Blender's Select Box, since
      // 2026-11-27): what is selected moves by the gizmo, G or the arrows,
      // never by a drag that may have meant to band. Before that a press on
      // the selection dragged it and a press on anything else panned.
      if (selectedBodyIds.has(hit.unit)) {
        // A click still drills into the object under it, the second half of
        // "click the body, then click into it".
        band(pickAt(world, scr));
        return;
      }
      if (selectedIds.has(hit.id) && !e.shiftKey && !e.altKey) {
        // A click on a picked object is the cycle's next step - which for a
        // lone object is what it already is, and past that is how the thing
        // underneath is reached. A multi-selection keeps itself: a click on
        // one of its members must not silently collapse it to one object.
        band(selectedIds.size === 1 ? pickAt(world, scr) : () => {});
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
          pickCycle = null;
          // Alt ignores groups: the thing under the pointer itself.
          const target = sealedTarget(e.altKey ? hit.node : clickTarget(model.tree, hit.node, selectedNodeIds()));
          const n = model.tree.nodes.get(target);
          if (e.shiftKey) {
            if (n?.item !== null && n?.item !== undefined && !selectedBodyIds.size) toggleSelection(n.item);
            else toggleBodySelection(target);
            return;
          }
          selectNode(target);
          return;
        }
        cycle();
      };
      band(pick);
      return;
    }
    // 5. A chain under the pointer. Tested after the bodies, since a chain is
    // strung over the geometry it holds and its ends sit inside those bodies -
    // picking it first would swallow every click near an anchor.
    //
    // Not in the Visuals workspace, and neither is a vine: the guides draw
    // neither (a chain is not in the editor's scene at all, and a vine is drawn
    // there untagged), so there is nothing on screen a press could be aimed
    // at. The outliner and the Level workspace reach them.
    const chain = topmostChainAt(world);
    if (chain) {
      // Shift-drag on the chain that is already selected pulls a new WRAP POINT
      // out of the span under the pointer (see `chainWrapOut`); a plain click
      // selects and a drag bands, as on anything else.
      if (e.shiftKey && selectedChainIds.has(chain.id)) {
        const span = nearestChainSpan(model, chain, world);
        drag = { mode: "chainWrapOut", chain, index: span?.index ?? 0, cursor: world };
        return;
      }
      band(() => setChainSelection([chain.id]));
      return;
    }
    // 6. Empty space: rubber-band select. A click that never moves deselects
    // (shift keeps the selection, so a miss doesn't undo the picking so far).
    //
    // At any angle: the band is a rectangle on the gameplay plane between the
    // two points pressed and dragged to, drawn through the view like the rest
    // of the overlay, so what is dragged out is exactly what is caught.
    band();
  });

  // The world distance one screen pixel covers, which is what a screen-sized
  // pick target has to be measured in.
  const worldLine = (): number => 1 / (camera.zoom * PIXELS_PER_METER);

  // Whether a pick asks the SCENE rather than the gameplay plane: with a 3D view
  // on screen there are models to ask (a body's Blender dressing, a piece's
  // debug geometry).
  // In the 2D view there is no scene to ask and the outline is both what is
  // drawn and what is picked.
  const picks3d = (): boolean => overlayLayers() === "outline" && sceneLevel !== null;

  // The items under the pointer in the 3D scene: each one's id and how far
  // along the ray it is first met, and how far along it the gameplay plane is
  // (null where the ray never meets it - the camera behind the plane, or
  // looking along it), which is where everything drawn as an outline on the
  // plane is met. `pickCandidatesAt` orders the lot by those distances. Null
  // when the scene is not what is on screen, which leaves the 2D view as it
  // was.
  function raycastItems(scr: Vec2): { near: Map<number, number>; toPlane: number | null } | null {
    if (!picks3d()) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const near = new Map<number, number>();
    const meet = (id: number, distance: number): void => {
      if (!(near.get(id)! <= distance)) near.set(id, distance);
    };
    const ndc = { x: (scr.x / r.width) * 2 - 1, y: 1 - (scr.y / r.height) * 2 };
    for (const hit of scene3d!.hitsAt(ndc.x, ndc.y)) {
      const id = itemOfSceneObject.get(pickTagOf(hit.object) as SceneTag);
      if (id !== undefined) meet(id, hit.distance);
      // A texture layer (a texture-only moss) is drawn by its rock's own
      // material, so a click on it is a hit on the rock: where the layer
      // covers the point hit, it is the layer's, just in front of its rock.
      const layer = paintLayerAt((hit.object as THREE.Mesh).material, hit.uv);
      const layerId = layer === undefined ? undefined : itemOfSceneObject.get(layer as SceneTag);
      if (layerId !== undefined) meet(layerId, hit.distance - 1e-4);
    }
    // ...and the solid guides drawn: a backdrop not generated yet is only its
    // guide, and a click on the guide is a click on the formation.
    for (const g of solidView?.pickGuides(ndc, scene3d!.camera) ?? []) meet(g.id, g.distance);
    planeRay.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), scene3d!.camera);
    return { near, toPlane: planeRay.ray.distanceToPlane(GAMEPLAY_PLANE) };
  }
  const planeRay = new THREE.Raycaster();

  // Does a click at `world` land on this item? Everything is its own outline
  // except a LIGHT, which is its icon rather than its reach - see
  // `lightPickRadius` - and whatever the scene's models under the pointer name
  // (see `raycastItems`).
  function hitsItem(b: EdItem, world: Vec2, ray: ReadonlyMap<number, number> | null = null): boolean {
    // An anchor is never picked as an ITEM. Its canvas presence is the ring its
    // chain draws at it, and that ring is already a drag handle - two things
    // answering one click, one of them an invisible 30 cm box sitting on the wall
    // the anchor is bolted to, is how a click on a wall starts selecting
    // something else. It is reached by its chain's handle, or by its row in the
    // outliner.
    if (b.object === "anchor") return false;
    // Whatever the scene DRAWS of an item is where a click on it lands, at any
    // depth: a water body's surface, a piece's debug geometry, a rock.
    if (ray?.has(b.id)) return true;
    // A model is its mesh wherever the scene is drawn (its pick tag names it,
    // `BodyVisual.mountModels`), and its marker on the plane the overlay draws.
    // A formation the same: its rock where the scene is drawn, its mark on the
    // plane. Its guide is drawn but not picked: a click inside it is a click
    // on the collision it was taken from.
    // A formation or a decoration is what the scene draws of it (its rock, its
    // guide's volume, what grew), never its placement point on the plane,
    // which can be anywhere relative to them.
    if (b.object === "formation" || b.object === "decoration") return ray?.has(b.id) === true;
    if (b.object === "model") return ray?.has(b.id) === true || pointInBody(b, world);
    // A light is its icon (`lightPickRadius`), not its reach.
    if (b.object === "light") return world.distanceTo(b.pos) <= lightPickRadius(worldLine());
    // A checkpoint is its RING, and never smaller on screen than a thing can be
    // aimed at: the ring is the avatar's size in world metres (see
    // `checkpointBox`), which at the zoom a level is laid out at is a few pixels
    // across. The level's own spawn marker is picked under exactly this rule.
    if (isCheckpointNote(b)) return world.distanceTo(b.pos) <= checkpointPickRadius(b);
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
    if (isCheckpointNote(b)) {
      const r = new Vec2(checkpointPickRadius(b), checkpointPickRadius(b));
      return { min: b.pos.sub(r), max: b.pos.add(r) };
    }
    if (b.object !== "light") return itemBounds(b);
    const r = new Vec2(lightPickRadius(worldLine()), lightPickRadius(worldLine()));
    return { min: b.pos.sub(r), max: b.pos.add(r) };
  }

  // How close a click has to land to a checkpoint's centre, in world metres:
  // its ring, or a 12-pixel target when the ring is smaller than that on screen
  // - the same floor the spawn marker's own pick uses, and for the same reason
  // (an avatar is 16 cm across, and a level is authored zoomed out).
  function checkpointPickRadius(b: EdItem): number {
    return Math.max(halfExtents(b).x, SMALL_MARK_PICK_PX * worldLine());
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
    // Where the ray never meets the plane, nothing drawn on it is under the
    // pointer (and `world` is only the last place it did meet it).
    const onPlane = !ray || ray.toPlane !== null;
    const all = pickOrder().filter((b) => hitsItem(b, world, ray?.near) && (onPlane || ray!.near.has(b.id)));
    const inStackOrder = (items: EdItem[]): EdItem[] => {
      const out: EdItem[] = [];
      for (let best = bestHit(items); best; best = bestHit(items)) {
        out.push(best);
        items.splice(items.indexOf(best), 1);
      }
      return out;
    };
    // LINES FIRST: a line drawn on the plane off the scene layer (a camera
    // path, a note's arrow) that the click lands on comes
    // ahead of everything else, whichever layer is active, as a chain or a
    // vine does. It is a stroke a few pixels wide, so a click on it can
    // hardly mean anything else, and it cannot swallow the clicks around it
    // as an area on another layer would (the reason the active layer leads
    // otherwise); behind the active layer, a path over water or a wall took
    // three to five clicks to reach. A collision curve, on the scene layer, is
    // a bar with a width and keeps the ordinary rules.
    const lines = all.filter((b) => b.layer !== "scene" && b.shape.kind === "path");
    const first = inStackOrder([...lines]);
    const hit = lines.length ? all.filter((b) => !lines.includes(b)) : all;
    if (!ray) return [...first, ...inStackOrder(hit)];
    // In 3D, THE NEAREST THING DRAWN UNDER THE POINTER: a rock, a model or a
    // guide where the ray first meets it, an outline on the plane where the
    // ray crosses the plane. That is the whole rule. The plane's own rules
    // (which outline holds which, which is drawn over which) only settle ties,
    // and the outlines on the plane are the only things that ever tie.
    //
    // ...with the active layer's items ahead of the other layers', as
    // `pickOrder` has it: a fog region drawn over the pool must not swallow a
    // click on a rock while the scene is the layer being edited.
    //
    // ...except in the 2D workspace, where THE PLANE COMES FIRST: what is hit
    // on the plane (an outline, a marker, an icon) is ahead of anything only
    // the ray meets, however near. Head on, the plane is what is being worked
    // on and the overlay draws it over everything, while a rock on a 2D body
    // bulges out in front of it and a model stands proud of its marker, so
    // by depth they took the click on the outline drawn over them. Everything
    // hit on the plane is taken at the plane's own depth, so the plane's
    // rules settle it among them as they do in the 2D editor; what only the
    // ray meets follows, nearest first, reached by clicking again.
    const planeFirst = workspace === "2d" && ray.toPlane !== null;
    const onPlane2d = new Set(planeFirst ? hit.filter((b) => hitsItem(b, world)) : []);
    const depth = (b: EdItem): number => (onPlane2d.has(b) ? ray.toPlane! : (ray.near.get(b.id) ?? ray.toPlane!));
    const key = (b: EdItem): [number, number, number] => [b.layer === activeLayer ? 0 : 1, planeFirst && !onPlane2d.has(b) ? 1 : 0, depth(b)];
    const sorted = [...hit].sort((p, q) => key(p)[0] - key(q)[0] || key(p)[1] - key(q)[1] || key(p)[2] - key(q)[2]);
    const out: EdItem[] = [...first];
    while (sorted.length) {
      const [layer, off, d] = key(sorted[0]!);
      const tied = hit.filter((b) => {
        const k = key(b);
        return sorted.includes(b) && k[0] === layer && k[1] === off && k[2] === d;
      });
      for (const b of tied) sorted.splice(sorted.indexOf(b), 1);
      out.push(...inStackOrder(tied));
    }
    return out;
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
    let prevBody: string | null = null;
    for (const it of cands) {
      // One step per body rather than per object, since a body is what a click
      // on any of its objects means. A body appears twice only where the stack
      // genuinely interleaves - its own object, something else's, then its next
      // one - which is the order those things are drawn in.
      //
      // Only on the scene layer: everything on the others (a shelter, a camera
      // region, a note) is alone in a body that is never built, so its body
      // step was a panel of physics, bounce and mover fields for a thing that
      // has none, and the click that reached the item's own panel the second.
      if (it.layer === "scene" && it.unit !== prevBody) {
        const bodyId = it.unit;
        steps.push({
          apply: () => setBodySelection(bodyId),
          isCurrent: () =>
            soleBodyId() === bodyId && !selectedIds.size && !selectedChainIds.size,
        });
        prevBody = it.unit;
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
      const key = cands.map((c) => c.id).join(",");
      // THE GROUP RULE (plans/node-tree.md "Groups"): from the outermost group
      // root on the path down to what is under the pointer, a group not
      // entered (nothing in it selected) selects its root; an entered one
      // passes the click to the next group root down, and with none left the
      // thing under the pointer is selected.
      const targetOf = (hit: EdItem): string => sealedTarget(clickTarget(model.tree, hit.node, selectedNodeIds()));
      const selectedNow = (target: string): boolean => {
        const sel = selectedNodeIds();
        return sel.size === 1 && sel.has(target);
      };
      // A click on what is already selected steps on to the next thing stacked
      // under the pointer (the cycle `pickCycle` remembers).
      const repeat = pickCycle !== null && pickCycle.key === key && scr.distanceTo(pickCycle.screen) <= CLICK_SLOP_PX;
      let index = repeat ? pickCycle!.index : 0;
      let target = targetOf(cands[index]!);
      if (selectedNow(target)) {
        index = (index + 1) % cands.length;
        target = targetOf(cands[index]!);
      }
      selectNode(target);
      pickCycle = { screen: scr, key, index };
    };
  }

  // Select one node: an item's node selects the item, any other the node.
  function selectNode(id: string): void {
    const n = model.tree.nodes.get(id);
    if (!n) return;
    if (n.item !== null) setSelection([n.item]);
    else if (n.chain !== null) setChainSelection([n.chain]);
    else if (n.vine !== null) setVineSelection([n.vine]);
    else setBodySelection(id);
  }

  // The chain nearest a world point, within the pick band, or null. Chains are
  // only pickable while the geometry layer is one a click can reach - they are
  // geometry-layer furniture, and a hidden or locked layer must not be editable
  // through them.
  function topmostChainAt(world: Vec2): EdChain | null {
    if (!planeFurniturePickable()) return null;
    const band = CHAIN_HIT_PX / (camera.zoom * PIXELS_PER_METER);
    let best: EdChain | null = null;
    let bestD = band;
    const locked = lockedLinks().chains;
    for (const c of model.chains) {
      if (locked.has(c.id)) continue;
      const d = distanceToChain(model, c, world);
      if (d <= bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // Whether a berry drag-off released here would grow a berry: it left the
  // click's slop (a click on a vine only selects it), the stalk is long enough
  // to be one, and the vine has room for another.
  function berryDraftValid(d: Extract<Drag, { mode: "berryDraw" }>): boolean {
    return (
      canvasScreen(d.cursor).distanceTo(d.press) >= CLICK_SLOP_PX &&
      d.cursor.distanceTo(d.root) >= MIN_STALK &&
      (d.vine.starberry?.along.length ?? 0) < MAX_BERRIES
    );
  }

  // A berry drag-off, released: the berry grows where the pointer is, on a
  // stalk from where the press was on the cord, and is picked out so its gizmo
  // is on it. A plain vine becomes a berry vine by it.
  function growDraggedBerry(d: Extract<Drag, { mode: "berryDraw" }>): void {
    if (!berryDraftValid(d)) return;
    beginAction();
    const grown = growBerry(d.vine.starberry, d.along, d.cursor.sub(d.root), d.vine.length);
    if (!grown) return;
    d.vine.starberry = grown.settings;
    markDirty();
    selectBerry(d.vine, grown.index);
  }

  // The berry under a world point (on the gameplay plane, where berries hang),
  // nearest first: within its radius, or a few pixels of its centre when it
  // is drawn small.
  function berryAt(world: Vec2): { vine: EdVine; index: number; fruit: Vec2 } | null {
    if (!planeFurniturePickable()) return null;
    const floor = SMALL_MARK_PICK_PX * worldLine();
    let best: { vine: EdVine; index: number; fruit: Vec2 } | null = null;
    let bestD = Infinity;
    const locked = lockedLinks().vines;
    for (const v of model.vines) {
      if (locked.has(v.id)) continue;
      const path = v.starberry ? vineRestPath(model, v) : null;
      if (!path || !v.starberry) continue;
      for (const [index, berry] of restStarberries(path, v.starberry).entries()) {
        const d = world.distanceTo(berry.fruit);
        if (d <= Math.max(berry.radius, floor) && d < bestD) {
          bestD = d;
          best = { vine: v, index, fruit: berry.fruit };
        }
      }
    }
    return best;
  }

  // The vine nearest a world point, within the same band a chain is picked by,
  // measured against its drawn rest pose.
  function topmostVineAt(world: Vec2): EdVine | null {
    if (!planeFurniturePickable()) return null;
    const band = CHAIN_HIT_PX / (camera.zoom * PIXELS_PER_METER);
    let best: EdVine | null = null;
    let bestD = band;
    const locked = lockedLinks().vines;
    for (const v of model.vines) {
      if (locked.has(v.id)) continue;
      let d = distanceToVine(model, v, world);
      // A berry vine is picked by its berries too, which hang off the line.
      const path = v.starberry ? vineRestPath(model, v) : null;
      if (path && v.starberry) {
        for (const berry of restStarberries(path, v.starberry)) {
          d = Math.min(d, Math.max(0, world.distanceTo(berry.fruit) - berry.radius));
        }
      }
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
      // A checkpoint's NAME is opened by the same gesture: it is the one piece
      // of writing the item carries, as a text note's prose is.
      if (b.layer !== "notes" || b.note.kind === "arrow") return;
      setSelection([b.id]);
      focusNoteText();
      return;
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (mode !== "edit") return;
    const scr = pointerScreen(e);
    lastPointerScreen = scr;
    if (grab) {
      moveTransform(scr);
      return;
    }
    // A sculpt stroke, a cut being drawn, a radius being set; the brush's
    // cursor follows the pointer either way.
    if (sculptCtl?.move(scr, e)) return;
    // The paint brush's cursor follows the pointer over the canvas, and a
    // stroke goes on wherever the pointer is.
    if (decorations.busy || decorations.dragging) {
      const hit = decorations.dragging || e.target === canvas ? decorationHit(scr) : null;
      decorations.hover(hit);
      if (decorations.dragging) {
        decorations.move(hit);
        return;
      }
    }
    if (!drag) return;
    // Resolved in the plane the dragged thing is drawn in (see `polyVertex`'s
    // `planeZ`); every other drag is on the gameplay plane.
    const world = canvasWorld(scr, drag.mode === "polyVertex" ? (drag.planeZ ?? 0) : 0);

    // Snapshot once, on the first movement of a model-mutating drag (pan and
    // marquee don't touch the model; draw already snapshotted at mousedown;
    // a chain being strung out has not created anything yet, and takes its
    // snapshot in `addChain` when it lands).
    if (
      !dragPushed &&
      drag.mode !== "pan" &&
      drag.mode !== "orbit" &&
      drag.mode !== "view" &&
      // Begun through the gizmo's handlers, which take their own snapshot.
      drag.mode !== "surfaceDrop" &&
      drag.mode !== "marquee" &&
      drag.mode !== "chainDraw" &&
      drag.mode !== "vineDraw" &&
      // Writes nothing until it is released (see `growDraggedBerry`).
      drag.mode !== "berryDraw" &&
      // Shapes a root that is not in the model until it is finished.
      drag.mode !== "rootHandle"
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
      case "view":
        visuals?.moveView(scr);
        cameraFromPose();
        refreshOrbitBtn();
        break;
      case "surfaceDrop":
        surfaceDropMove(drag, scr);
        break;
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
        // A click until the pointer has really travelled, so a press that
        // jitters by a pixel still means what it was aimed at.
        if (!drag.banding && scr.distanceTo(drag.press) < CLICK_SLOP_PX) break;
        drag.banding = true;
        drag.current = world;
        break;
      case "movePlayer":
        model.player.pos = snapVec(world.add(drag.grab));
        markDirty();
        refreshFields();
        break;
      case "moveWaypoint": {
        // Written into the BODY's frame, which is where a route is held: the
        // nodes ride the body through every gesture that moves or turns it, and
        // a world position would have to be re-derived by each of them.
        const frame = bodyFrameOf(model, drag.lead.unit);
        const local = snapVec(world).sub(frame.pos).rotated(-frame.rot);
        const next = propsOf(drag.lead).route.map(cloneRouteNode);
        const at = next[drag.index];
        if (at) at.p = local;
        propsOf(drag.lead).route = next;
        markDirty();
        refreshFields();
        break;
      }
      case "routeHandle": {
        // NOT snapped to the grid: a tangent is a direction and a length, not a
        // placement, and a snapped one quantises the curve's shape rather than
        // where it sits - the same reason a camera path's grips are free.
        const frame = bodyFrameOf(model, drag.lead.unit);
        const next = propsOf(drag.lead).route.map(cloneRouteNode);
        const at = next[drag.index];
        if (at) {
          const offset = world.sub(frame.pos).rotated(-frame.rot).sub(at.p);
          at[drag.side] = offset;
          if (drag.mirror) at[drag.side === "in" ? "out" : "in"] = offset.neg();
        }
        propsOf(drag.lead).route = next;
        markDirty();
        refreshFields();
        break;
      }
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
        } else if (b.shape.kind === "belt") {
          // Dragged from wheel 0 to the second wheel. Short of the two bands'
          // own size it is still a click, and keeps the default length.
          const end = p.sub(drag.start).rotated(-b.rot);
          const [w0, w1] = b.shape.wheels;
          if (w0 && w1 && end.length() >= w0.r + w1.r + 2 * b.shape.thickness) {
            setBeltWheel(b, 1, { c: end });
          }
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
        if (hasDepth(drag.body)) setDepth(drag.body, z);
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
      case "wake": {
        // Floored above 0: dragging the ring onto the source would silently
        // turn the waking light into an always-on one, which is the field's
        // job (blank it) rather than a drag's.
        const b = drag.body;
        b.light.wake = Math.max(snapLen(world.distanceTo(b.pos)), PX);
        markDirty();
        refreshFields();
        break;
      }
      case "beltWheel": {
        // The wheel's centre follows the pointer on the grid; `setBelt` refuses
        // a spot where its disc sinks inside another's, or where it or another
        // wheel falls inside the hull, so the drag stalls at the last belt
        // rather than handing the build one it cannot make.
        const b = drag.body;
        if (b.shape.kind !== "belt") break;
        if (setBeltWheel(b, drag.index, { c: toLocal(b, snapVec(world)) })) {
          markDirty();
          refreshFields();
        }
        break;
      }
      case "beltRadius": {
        const b = drag.body;
        if (b.shape.kind !== "belt") break;
        const w = b.shape.wheels[drag.index];
        if (!w) break;
        const r = Math.max(gridStep, snapLen(world.distanceTo(toWorld(b, w.c))));
        if (setBeltWheel(b, drag.index, { r })) {
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
        // A BRANCH's first node is its junction: dragged, it slides along the
        // root it grows out of rather than leaving it (`slideRootJunction`).
        const junction = moved.get(0);
        if (ok && junction) slideRootJunction(model, b, b.pos.add(junction.rotated(b.rot)));
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
        // placement, and rounding it to the grid quantises the curvature into
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
      case "rootHandle": {
        // The pen tool's gesture: the node stays where it was pressed and the
        // drag pulls its handles out, the one under the pointer leading on
        // toward the next node and its mirror trailing back, so the curve runs
        // smoothly through the node. A drag inside the click's slop leaves it a
        // corner, which is what a plain click means.
        const d = rootDraft;
        const node = d?.verts[drag.index];
        if (!d || !node) break;
        const pull = world.sub(node);
        const smooth = canvasScreen(world).distanceTo(canvasScreen(node)) >= CLICK_SLOP_PX;
        d.handles[drag.index] = smooth ? { in: pull.mul(-1), out: pull } : ZERO_HANDLE();
        break;
      }
      case "vineDraw":
        // Downward only: a vine hangs, so what the drag measures is how far
        // BELOW the anchor the pointer has got. Dragging up is a vine of no
        // length, which the draft draws as refused.
        drag.length = Math.max(0, world.y - toWorld(drag.from, drag.local).y);
        break;
      case "berryPosition": {
        const path = vineRestPath(model, drag.vine);
        if (!path || !drag.vine.starberry) break;
        moveBerry(drag.vine.starberry, drag.index, berryAlongAt(path, world), drag.vine.length);
        markDirty();
        refreshFields();
        break;
      }
      case "berryDraw":
        drag.cursor = snapVec(world);
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
        drag.vine.length = drag.attach
          ? drag.startLength
          : Math.max(minBerryVineLength(drag.vine.starberry, MIN_VINE_LENGTH), snap(world.y - top.y));
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
        anchor.unit = host.unit;
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
        anchor.unit = host.unit;
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
        const host = over && over.unit !== other?.unit ? over : anchorHost(anchor);
        if (!host) break;
        anchor.unit = host.unit;
        anchor.rot = host.rot;
        anchor.pos = toWorld(host, nearestSurfaceLocal(host, world));
        markDirty();
        refreshFields();
        break;
      }
      case "chainVia": {
        drag.cursor = world;
        const anchor = anchorItem(model, drag.chain.via[drag.index] ?? -1);
        if (!anchor) break;
        // Any body under the pointer, an end's own included - a chain may well
        // bend over the far corner of the beam it is bolted to. Over nothing it
        // stays on the body it has. It lands on a CORNER, since that is what a
        // wrap point is (see `nearestCornerLocal`).
        const host = topmostAt(world, (b) => chainable(b)) ?? anchorHost(anchor);
        if (!host) break;
        anchor.unit = host.unit;
        anchor.rot = host.rot;
        anchor.pos = toWorld(host, nearestCornerLocal(host, world));
        markDirty();
        refreshFields();
        break;
      }
      case "chainWrapOut": {
        drag.cursor = world;
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
    if (!drag || drag.mode !== "marquee" || !drag.banding) return null;
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

  window.addEventListener("mouseup", (e) => {
    // A sculpt stroke ends with the left button (a view drag with another
    // button may end meanwhile and leave the stroke going).
    if (e.button === 0) sculptCtl?.release();
    // A right-click with a placed kind armed (a press the pointer did not pan
    // away from) ends it.
    if (e.button === 2 && brushRightPress) {
      const press = brushRightPress;
      brushRightPress = null;
      if (pointerScreen(e).distanceTo(press) < CLICK_SLOP_PX && decorations.apply()) {
        rebuildInspector();
        refreshWorkspaceDock();
      }
    }
    // The decoration drag this button began: the left's paint or move, the
    // right's erase.
    if (decorations.release(e.button)) {
      rebuildInspector();
      return;
    }
    if (mode !== "edit" || !drag) return;
    if (drag.mode === "view") visuals?.endView();
    if (drag.mode === "surfaceDrop") {
      if (drag.handlers) drag.handlers.end("translate");
      else drag.pick();
    }
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
              : b.object === "light" || b.object === "model" || b.object === "formation" || b.object === "decoration"
                ? b.pos.x >= box.min.x &&
                  b.pos.x <= box.max.x &&
                  b.pos.y >= box.min.y &&
                  b.pos.y <= box.max.y
                : caught(b, box.min, box.max),
          )
          .map((b) => b.id);
        // A band selects the OUTERMOST GROUP ROOT of everything it takes
        // (plans/node-tree.md "Groups"): a body caught by one piece is the
        // body, a group caught by one of its things the group.
        const roots = new Set<string>(drag.additive ? selectedBodyIds : []);
        const items = new Set<number>(drag.additive ? selectedIds : []);
        for (const id of hits) {
          const it = itemOf(id);
          if (!it) continue;
          const root = outermostGroup(model.tree, it.node);
          if (root === it.node) items.add(id);
          else roots.add(root);
        }
        setNodeSelection([...items], [...roots]);
      } else if (drag.pick) {
        // A press on something that never left the click's slop means what a
        // click on that thing has always meant.
        drag.pick();
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
      addVine(drag.from, drag.local, snap(drag.length));
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
    // The berry's own fields, rebuilt to where it was dropped.
    if (drag.mode === "berryPosition") rebuildInspector();
    if (drag.mode === "berryDraw") growDraggedBerry(drag);
    if (drag.mode === "chainDraw") {
      finishOrTieChainDraw(e.shiftKey);
      // Tied, and still going: the draft lives on past the release.
      if (drag) return;
      applyToolCursor();
      return;
    }
    if (drag.mode === "chainWrapOut") {
      // A wrap point lands only on a body: released over empty space the
      // gesture is abandoned and the chain is exactly as it was.
      const to = topmostAt(drag.cursor, (b) => chainable(b));
      if (to) addWrapPoint(drag.chain, drag.index, to, drag.cursor);
    }
    const made = drag.mode === "draw" ? drag.made : null;
    drag = null;
    applyToolCursor();
    if (made) offerParentPick(made);
  });

  canvas.addEventListener("wheel", (e) => {
    if (mode !== "edit") return;
    e.preventDefault();
    const scr = pointerScreen(e);
    // The one 3D view dollies toward what is under the pointer.
    if (visuals?.active) {
      viewSwing++;
      visuals.wheel(scr, e.deltaY);
      cameraFromPose();
      refreshOrbitBtn();
      return;
    }
    const before = screenToWorld(camera, scr.x, scr.y);
    const factor = Math.exp(-e.deltaY * 0.001);
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
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
    // A grab owns the keyboard until it ends: Esc cancels, Enter places,
    // X / Y / Z hold an axis (Shift: a plane), digits type an exact amount,
    // and nothing else may act on what is mid-move.
    if (grab) {
      if (e.code === "Escape") endTransform(false);
      else if (e.code === "Enter" || e.code === "NumpadEnter") endTransform(true);
      else if (e.code === "KeyX" || e.code === "KeyY" || e.code === "KeyZ") setTransformAxis(e.code === "KeyX" ? "x" : e.code === "KeyY" ? "y" : "z", e.shiftKey);
      else typeTransformKey(e);
      e.preventDefault();
      return;
    }
    // Sculpt mode, and a cut's polygon, own the keyboard but for the view
    // and the workspaces (editor/sculpt.ts).
    if (mode === "edit" && sculptCtl) {
      if (e.key === "Control" || e.key === "Shift") sculptCtl.modifiers(e);
      if (sculptCtl.keydown(e)) {
        e.preventDefault();
        return;
      }
    }
    if (e.code === "Escape") {
      if (shapeMenu) closeShapeMenu();
      // Combining guides ends, leaving the guides as they were.
      else if (mode === "edit" && combine) cancelCombine();
      // Placing or painting a decoration ends before anything else does.
      // Esc throws away the strokes since the last Enter (`decorations.cancel`).
      else if (mode === "edit" && decorations.busy) decorations.cancel();
      else if (mode === "test") stopTest();
      else if (polyDraft) cancelPolyDraft();
      else if (rootDraft) cancelRootDraft();
      else if (cutDraft) cancelCutDraft();
      // A tied chain being strung out is dropped whole: its knots are not in
      // the model until the chain ends on a body.
      else if (drag?.mode === "chainDraw") {
        drag = null;
        applyToolCursor();
      }
      // The vertex selection goes first, for the reason a click on empty space
      // drops it first: it is the innermost thing selected, and dropping it is
      // how the shape stops being open for vertex editing.
      else if (selectedVerts.size) {
        selectedVerts.clear();
        rebuildInspector();
      } else if (routeNodesPicked()) {
        // ...and a route's picked nodes are that same innermost thing for a body
        // that travels: dropping them is how Delete and the arrows go back to
        // meaning the body.
        clearRouteSel();
        rebuildInspector();
      } else setSelection([]);
      return;
    }
    // Enter with a decoration armed or its brush on confirms it
    // (`decorations.apply`: grows the paint, or with nothing to grow ends the
    // tool). Before the focus checks below: the dock's Moss button keeps the
    // focus after arming it, and a focused button's Enter would click it,
    // disarming. Typing in a field still gets its own Enter too.
    if ((e.code === "Enter" || e.code === "NumpadEnter") && mode === "edit" && decorations.busy && !(e.target instanceof HTMLTextAreaElement)) {
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) e.preventDefault();
      if (decorations.apply()) {
        rebuildInspector();
        refreshWorkspaceDock();
      }
      return;
    }
    if (mode === "test") {
      // Space leaves the test: the keyboard has no bindings at all in a test
      // (see input/ballInput.ts) and the hand is on the mouse, so the way out
      // should be under the thumb rather than across the board.
      if (e.code === "Space") {
        e.preventDefault();
        stopTest();
        return;
      }
      if (e.code === "KeyP") downloadTestRecording();
      // The same toggle the game has, and for the same reason: camera rules are
      // invisible in play, so a path that leads, releases or re-acquires has no
      // on-screen cause. A test is where an author tunes `range` and
      // `lookahead`, so it is where the overlay has to be reachable.
      if (e.code === "KeyL") testShowDebug = !testShowDebug;
      // ...and the game's G: the pieces' debug geometry off, to see the
      // level's look alone.
      if (e.code === "KeyG" && scene3d) scene3d.setDebugShown(!scene3d.debugGeometryShown);
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
    // Keep native keyboard access to the DOM controls. Tab still cycles the
    // editing layer when the canvas/body owns focus.
    if (focused instanceof Element && focused.closest("button,a,summary")) {
      if (e.code === "Tab" || e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter") return;
    }
    // Arrows before the Ctrl block: Ctrl+Arrow is the fine nudge, not a combo.
    const dir = NUDGE_DIRS[e.code];
    if (dir) {
      // Same rule as Delete, and in the same order: a nudge is about the
      // corners while there are corners picked, then about a route's nodes while
      // there are nodes picked, rather than moving the whole thing out from
      // under either.
      if (
        !nudgeSelectedVerts(dir, e.ctrlKey || e.metaKey) &&
        !nudgeSelectedRouteNodes(dir, e.ctrlKey || e.metaKey)
      ) {
        nudgeSelection(dir, e.ctrlKey || e.metaKey);
      }
      e.preventDefault(); // don't scroll the page
      return;
    }
    // Ctrl+Tab in Formations: Sculpt mode on the selected solid guide
    // (Blender's mode switch; plain Tab is guide/rock). Leaving is Sculpt's.
    if (e.code === "Tab" && e.ctrlKey && workspace === "formations") {
      const f = activeSolidFormation();
      if (f) enterSculpt(f);
      e.preventDefault();
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
          // Ctrl+G groups the selection, Ctrl+Shift+G ungroups it - the
          // pairing every editor uses. A compound body is made with "New
          // body" instead (plans/node-tree.md).
          if (e.shiftKey) ungroupSelection();
          else groupSelection();
          break;
        case "KeyL":
          // Ctrl+L locks the selection, Ctrl+Shift+L unlocks it (Godot's
          // pair). The selection is the node as picked: an object picked out
          // of a body locks that object, a body the whole body.
          setNodesLocked(selectedNodeIds(), !e.shiftKey);
          break;
        case "KeyJ":
          // Ctrl+J joins the selected bodies into the first (Blender's Join).
          if (mode === "edit") joinSelection();
          break;
        // Ctrl+C and Ctrl+V are NOT here. They are `copy` and `paste`
        // listeners on the document, because those are the only events that
        // may touch the system clipboard - and neither fires when a keydown
        // handler has already cancelled the key (see the clipboard section).
        default:
          return;
      }
      e.preventDefault();
      return;
    }
    // 1, 2, 3, 4: the workspaces, in the tabs' order.
    const wsKey = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(e.code);
    if (wsKey >= 0 && !e.shiftKey && !e.altKey) {
      setWorkspace(WORKSPACES[wsKey]!);
      e.preventDefault();
      return;
    }
    // Tab in Formations: the selection between its guide and its rock.
    if (e.code === "Tab" && workspace === "formations") {
      toggleFormationView();
      e.preventDefault();
      return;
    }
    if (e.code === "Tab" && workspace === "2d") {
      // Cycle the edit layer. Preventing the default keeps focus on the canvas
      // rather than walking the toolbar.
      const i = ED_LAYERS.indexOf(activeLayer);
      setLayer(ED_LAYERS[(i + 1) % ED_LAYERS.length]!);
      e.preventDefault();
      return;
    }
    if ((e.code === "Enter" || e.code === "NumpadEnter") && combine) {
      applyCombine();
      e.preventDefault();
      return;
    }
    if ((e.code === "Enter" || e.code === "NumpadEnter") && polyDraft) {
      commitPolyDraft();
      e.preventDefault();
      return;
    }
    if ((e.code === "Enter" || e.code === "NumpadEnter") && rootDraft) {
      commitRootDraft();
      e.preventDefault();
      return;
    }
    // The view keys, as 3D editors have them. Each is one action per press: a
    // held key's auto-repeat would re-frame the view until it is let go.
    const viewKey = ["KeyF", "NumpadDecimal", "Home", "Numpad1"].includes(e.code);
    if (viewKey && e.repeat) {
      e.preventDefault();
      return;
    }
    if (viewKey && visuals?.active) {
      if (e.code === "Numpad1") {
        // Blender's front view: the gameplay plane, head on.
        resetView();
      } else {
        // F (Unity) or Numpad . (Blender): the selection framed and orbited
        // about; Home (Blender's View All): everything.
        const all = e.code === "Home";
        visuals.frameBox((all ? null : focusBox(operandItems())) ?? wholeBox());
        cameraFromPose();
        refreshOrbitBtn();
      }
      e.preventDefault();
      return;
    }
    // Blender's camera view.
    // Shift+A, Blender's add menu: a shape for the selected solid guide's
    // stack (formation/solidStack.ts), at the view's centre.
    if (e.code === "KeyA" && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const target = activeSolidFormation();
      if (target || workspace === "formations") {
        showShapeMenu(target);
        e.preventDefault();
        return;
      }
    }
    // Blender's grab, rotate and scale. R and S only take the key when there
    // is something to turn or size; otherwise they arm the Rect and
    // Checkpoint tools below, as they always have.
    const plainKey = !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && mode === "edit";
    if (plainKey && (e.code === "KeyR" || e.code === "KeyS") && startTransform(e.code === "KeyR" ? "rotate" : "scale")) {
      e.preventDefault();
      return;
    }
    // C in Formations: Cut the selected solid guide to a polygon drawn on the
    // view (editor/sculpt.ts; C is the Circle tool in 2D only).
    if (e.code === "KeyC" && plainKey && workspace === "formations" && sculptCtl) {
      const f = activeSolidFormation();
      if (f) {
        if (grab) endTransform(true);
        sculptCtl.startCut(f);
        e.preventDefault();
        return;
      }
    }
    if (e.code === "KeyG" && plainKey) {
      startTransform("translate");
      e.preventDefault();
      return;
    }
    // Blender's hide: H hides the selected bodies, Shift+H every other one,
    // Alt+H shows them all again.
    if (e.code === "KeyH" && !e.ctrlKey && !e.metaKey && mode === "edit") {
      if (e.altKey) setBodiesHidden([...hiddenBodies], false);
      else {
        const chosen = new Set<string>([...selectedBodyIds, ...[...selectedIds].map((id) => itemOf(id)?.unit ?? "")].filter((id) => id !== ""));
        if (e.shiftKey) setBodiesHidden(model.items.map((i) => i.unit).filter((id) => !chosen.has(id)), true);
        else setBodiesHidden(chosen, true);
      }
      e.preventDefault();
      return;
    }
    if (e.code === "Numpad0") {
      gameCameraView();
      e.preventDefault();
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") {
      // Corners before objects: with vertices picked out of a shape, Delete is
      // about them, and the shape itself is one Escape away from being what it
      // means again. A mover's route nodes are the same rule and sit between the
      // two - they are picked out of a body, so they are asked after the shape's
      // own corners and before the body itself.
      if (!deleteSelectedVerts() && !deleteSelectedRouteNodes()) deleteSelected();
      e.preventDefault();
    } else if (e.code === "KeyB") {
      // Spot-check a spot: test the ball from wherever the cursor is, without
      // moving the level's own spawn marker.
      startTest(pointerWorld());
    } else if (e.code === "KeyV") setTool("select");
    else if (e.code === "KeyR") setTool("rect");
    else if (e.code === "KeyC") setTool("circle");
    else if (e.code === "KeyP") setTool("poly");
    else if (e.code === "KeyT") setTool("text");
    else if (e.code === "KeyA") setTool("arrow");
    else if (e.code === "KeyK") setTool("chain");
    // A checkpoint is a named SPAWN, on the letter that says so. `setTool`
    // refuses a tool the active layer does not offer, so this arms nothing until
    // the notes layer is the one being edited, exactly as T and A do.
    else if (e.code === "KeyS") setTool("checkpoint");
    // The lens (see `ViewProjection`), on the letter it is named by.
    else if (e.code === "KeyO")
      setProjection(projection === "orthographic" ? "perspective" : "orthographic");
  });

  // Releasing an arrow closes the nudge run, so the next press starts a fresh
  // undo step.
  window.addEventListener("keyup", (e) => {
    if (NUDGE_DIRS[e.code]) nudging = false;
    // The brush's cursor says what a modifier does the moment it is let go.
    if (e.key === "Control" || e.key === "Shift") sculptCtl?.modifiers(e);
  });

  // The chain being strung out, as the renderer wants it: the fixed anchor, the
  // pointer, and whether releasing here would actually make a chain.
  function chainDraftView(): { path: Vec2[]; to: Vec2; valid: boolean } | null {
    if (!drag || drag.mode !== "chainDraw") return null;
    const path = [toWorld(drag.from, drag.local), ...drag.knots.map((k) => toWorld(k.item, k.local))];
    const to = topmostAt(drag.cursor, (b) => chainable(b));
    const valid =
      to !== null &&
      to.id !== drag.from.id &&
      !(drag.from.unit !== null && to.unit === drag.from.unit);
    return { path, to: drag.cursor, valid };
  }

  // A wrap point being pulled out of a chain, as the renderer wants it: the
  // whole route with the new point in the span it came from - already on the
  // corner it would land on, where there is a body under the pointer - and
  // whether releasing there would land it at all.
  function wrapDraftView(): { path: Vec2[]; valid: boolean } | null {
    if (!drag || drag.mode !== "chainWrapOut") return null;
    const path = chainPath(model, drag.chain);
    if (!path) return null;
    const to = topmostAt(drag.cursor, (b) => chainable(b));
    const at = to ? toWorld(to, nearestCornerLocal(to, drag.cursor)) : drag.cursor;
    path.splice(drag.index + 1, 0, at);
    return { path, valid: to !== null };
  }

  // The vine being pulled out - or a tip being Shift-carried toward a second
  // anchor - as the renderer wants it: where it starts, where the gesture has
  // got, and whether releasing here would build (or attach) anything.
  function vineDraftView():
    | { kind: "hang"; from: Vec2; length: number; valid: boolean }
    | { kind: "attach"; from: Vec2; to: Vec2; valid: boolean }
    | null {
    if (drag?.mode === "vineDraw") {
      return {
        kind: "hang",
        from: toWorld(drag.from, drag.local),
        length: drag.length,
        valid: drag.length >= MIN_VINE_LENGTH,
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
      const src: IInputSource = ballInput!;
      let steps = 0;
      while (accumulator >= STEP && steps < MAX_STEPS) {
        const fi: FrameInput = src.sample();
        testLevel.physicsProcess(fi, STEP);
        // Drained inside the catch-up loop, as `main.ts` does: a frame that
        // runs several steps must not drop the caught-up steps' events.
        testSparks.ingest(testLevel.sparkEvents);
        testDebris.ingest(testLevel.breakEvents);
        scene3d?.ingestTrackExits(testLevel.trackExits);
        testLeaves.ingest(testLevel);
        testSlime.ingest(testLevel, STEP);
        testRetract.observe(testLevel, STEP);
        testSnap.observe(testLevel, STEP, testSparks);
        testSound.observe(testLevel, STEP, testRetract);
        recording.push(
          serializeInput(fi),
          digestBall(testLevel),
          worldDigestBall(testLevel),
        );
        // The LINE WAS CROSSED. A test is an authoring instrument, so it says
        // so and carries on: what an author is judging here is where the line
        // is and whether the run arrives at it, and a test that froze and asked
        // for a star rating would be answering a question nobody in the editor
        // is asking. The game's own completion flow is in main.ts (see
        // `checkCompletion`).
        if (testLevel.completedFrame !== null && !testFinished) {
          testFinished = true;
          showToast(`finished at frame ${testLevel.completedFrame}`, "ok");
        }
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
      testDebris.advance(dt);
      testLeaves.advance(dt);
      testSlime.advance(dt);
      testCameraCtl.update(
        camera,
        dt,
        testLevel.cameraRenderPosition(alpha),
        testLevel.cameraRules,
        BALL_ZOOM,
        testLevel.cameraHang,
      );
      // Render-rate refresh of stick aim (see LiveInputSource.pollAim).
      ballInput?.pollAim();
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
      const testIn3d = sceneShown() && testLevel3d !== null;
      if (testIn3d) {
        // A test is the player's view, so it is always the perspective camera:
        // the editor's orthographic lens is an authoring instrument, and a level
        // judged through it would be judged through a lens nobody plays in.
        scene3d!.setProjection("perspective");
        // ...and the mushrooms wake for the ball, as they do in the game.
        scene3d!.setGlowPreview(false);
        // ...and the level's fog is drawn, which authoring leaves out, from
        // the camera drawing it, which here is the player's.
        scene3d!.setFogShown(true);
        setGameFogCamera(null);
        const w = Math.round(view.width * view.scale);
        const h = Math.round(view.height * view.scale);
        scene3d!.setViewportRect({
          x: Math.round(view.originX),
          y: canvas.height - Math.round(view.originY) - h,
          w,
          h,
        });
        scene3d!.render(testLevel3d!, camera, alpha, NO_ORBIT, testRetract, null, testSnap, testLeaves, testSlime);
      }
      testSound.flush(camera, testIn3d ? scene3d!.camera : null);
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
        testRetract,
        testDebris,
        null,
        testShowDebug,
        testCameraCtl.held,
        testSnap,
        testLeaves,
        testSlime,
      );
    } else {
      flyNdof(now);
      settlePrefabFraming(now);
      syncViewUrl(now);
      // The next ▶ Test's level, while nothing is moving.
      prebuildTest(now);
      // The tree tracks the model, and a drag changes the model every frame
      // without touching the inspector - so it is refreshed here rather than
      // only on selection. It is a revision check and a class toggle per row
      // unless the model actually moved.
      refreshOutliner();
      // A decoration's brush or placing ends once the selection leaves what it
      // belongs to (`followSelection`): checked here, once a frame, rather than
      // at each of the many places the selection changes.
      if (decorations.busy) decorations.followSelection(model.items.filter((i) => selectedIds.has(i.id)), selectedBodyIds);
      // The scene first, then the editor's own canvas over it. Both are driven
      // from the SAME free camera through `space.ts`, so an outline drawn on top
      // lands on the geometry it describes underneath at any pan or zoom - which
      // is the whole reason the editor can gain a 3D view without giving up
      // precise collision authoring.
      if (scene3d && sceneShown()) {
        scene3d.setViewportRect(null);
        // Set per frame rather than only at the toggle, because ▶ Test borrows
        // the same scene and puts it back on the perspective camera.
        scene3d.setProjection(projection);
        // Every waking light AWAKE while authoring: there is nobody in this
        // scene to wake one, and an author has to see what a mushroom lights
        // before anyone does. ▶ Test hands it back to the ball.
        scene3d.setGlowPreview(true);
        // No fog while authoring unless asked for (see `fogInEditor`); and the
        // fog when it is shown, and the spots' lit air always, at the depths
        // the game's camera sees them from (see `gameFogCameraZ`).
        scene3d.setFogShown(fogInEditor);
        setGameFogCamera(gameFogCameraZ());
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
        // The solid guides (a key, so a frame where nothing changed redraws
        // nothing).
        // Formations' alone: a guide is what that workspace edits, and in the
        // others it is wireframe in the way of the rock.
        solidView?.sync(
          workspace === "formations" ? shownGuideItems() : NO_ITEMS,
          currentSolidSel(),
          new Set([
            ...model.items.filter((i) => i.object === "formation" && (selectedIds.has(i.id) || selectedBodyIds.has(i.unit))).map((i) => i.id),
            // ...and the guides picked to combine with it, drawn as strongly.
            ...(combine?.picks ?? []),
          ]),
          guideHex,
        );
        materialMasks.sync();
        decorations.syncPreview();
        // The one 3D view: the pose drives the scene's camera, and the 2D
        // camera is read off it (`cameraFromPose`) for everything sized or
        // resolved by it.
        if (visuals?.active) {
          visuals.apply();
          cameraFromPose();
          // The cube turns with the view (redrawn only when it has).
          const p = visuals.view;
          if (p) viewCube?.setView(p.yaw, p.pitch);
        }
        // Sculpt's working mesh follows its body and takes this frame's edits
        // (and the mode ends if its guide left the selection or the workspace).
        sculptCtl?.frame(workspace === "formations" && mode === "edit");
        if (sceneLevel) scene3d.render(sceneLevel, camera, 1, visuals?.active ? NO_ORBIT : orbit);
      }
      // Scene only: the overlay draws nothing at all, so what is on screen is
      // the level as it will be played. Selection chrome goes with it, which is
      // the point - this mode is for looking, and "3D + overlay" is for editing.
      // Sculpt mode draws no overlay either: its marks are its own cursor and
      // the sculpt itself, as Blender's sculpt mode hides the overlays.
      if (viewMode === "3d" || sculptCtl?.active) {
        attachProjector(camera, null);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        requestAnimationFrame(frame);
        return;
      }
      // WHENEVER A SCENE IS DRAWN the overlay is drawn through the 3D camera
      // (projectedCanvas.ts): every outline, handle, band and draft lands on
      // the geometry it describes at any angle, and the 2D camera maps through
      // the same view, so every hit test and drag written against it does too.
      // Head on too, not only turned: the plane is the same picture either way
      // (`cli render3d` holds the two to 1e-6 px), but a mark at a depth - a
      // decoration on a backdrop, a model off the plane - is drawn where it is
      // only through the camera; the plain transform drew it on the plane.
      const turned = scene3d !== null && viewMode !== "2d";
      if (turned) overlayProjector.update(scene3d!.camera, cssW, cssH);
      attachProjector(camera, turned ? overlayProjector : null);
      drawEditor(
        turned ? (projectedOverlay as unknown as CanvasRenderingContext2D) : ctx,
        dpr,
        cssW,
        cssH,
        camera,
        // Without the hidden bodies (H).
        shownModel(),
        // While +Root is armed the selection keeps its inspector but loses its
        // handles: a press anywhere on a root starts a branch there, so no
        // corner, midpoint or knob may be drawn as if it would be grabbed.
        tool === "root" || tool === "cut" ? NO_IDS : selectedIds,
        marqueeBand(),
        shownLayers(),
        polyDraft ? { ...polyDraft, cursor: pointerWorld() } : null,
        selectedChainIds,
        chainDraftView(),
        selectedVineIds,
        vineDraftView(),
        // In 3D the scene below is what shows what a body IS; the overlay drops
        // its fills to outlines so the geometry stays visible through them.
        overlayLayers(),
        tool === "root" ? NO_NODE_IDS : selectedBodyIds,
        tool === "root" || tool === "cut" ? NO_IDS : selectedVerts,
        currentSettleGhosts(),
        wrapDraftView(),
        routeSel?.bodyId === soleBodyId() ? routeSel.nodes : NO_NODES,
        snapOn ? gizmoSnapPoint : null,
        {
          selected: (() => {
            const b = currentBerry();
            return b ? { vineId: b.vine.id, index: b.index } : null;
          })(),
          draft:
            drag?.mode === "berryDraw" && canvasScreen(drag.cursor).distanceTo(drag.press) >= CLICK_SLOP_PX
              ? {
                  root: drag.root,
                  to: drag.cursor,
                  radius: drag.vine.starberry?.radius ?? DEFAULT_BERRY_RADIUS,
                  valid: berryDraftValid(drag),
                }
              : null,
        },
        rootDraft
          ? {
              verts: rootDraft.verts,
              handles: rootDraft.handles,
              // While a node's handles are being pulled out the pointer is ON
              // the handle, not the next node, so the preview ends at the node.
              cursor:
                drag?.mode === "rootHandle"
                  ? rootDraft.verts[rootDraft.verts.length - 1]!
                  : snapVec(pointerWorld()),
              width: rootDraft.width,
              tip: rootDraft.tip,
              from: rootDraft.from ? rootDraft.verts[0]! : null,
            }
          : null,
        workspace === "formations" ? formationGuideView : null,
        cutDraftView(),
        // An open prefab has no spawn: the one the model holds stands at its
        // origin, over the prefab, and is no part of it.
        !prefabMode,
      );
    }
    requestAnimationFrame(frame);
  }

  // --- the view in the address bar (viewUrl.ts) ------------------------------
  // What the address said the editor was looking at when the page loaded.
  const urlView = readEditorView(location.search);
  // Nothing is written until that view has been taken up (or found to be of
  // another level): the first frames are of the empty model at its spawn, and
  // writing them would overwrite the very view the reload is reopening.
  let viewUrlLive = false;
  // The view last written and when. `vis` holds the Visuals pose itself: it is
  // replaced on every change and never mutated, so identity says it moved.
  let viewWritten: EditorView | null = null;
  let viewWrittenAt = -Infinity;
  // At most twice a second, since a pan changes the view every frame and
  // browsers throttle `replaceState` (Safari: 100 calls in 30 s). The first
  // frame after a gesture's last half second writes where it ended.
  const VIEW_URL_INTERVAL_MS = 500;

  // The level the address names: the one open, or the one put aside under an
  // open prefab, which a reload loads before opening the prefab over it.
  const viewLevel = (): string | null => (prefabMode ? (levelSession?.name ?? readLastLevel()) : currentName);

  function viewMatches(w: EditorView): boolean {
    return (
      w.level === viewLevel() &&
      w.prefab === (prefabMode ? prefabName : null) &&
      w.cam !== null &&
      w.cam.x === camera.position.x &&
      w.cam.y === camera.position.y &&
      w.cam.zoom === camera.zoom &&
      w.cam.yaw === orbit.yaw &&
      w.cam.pitch === orbit.pitch &&
      w.vis === (visuals?.view ?? null) &&
      w.workspace === workspace &&
      w.ortho === (projection === "orthographic")
    );
  }

  // Per edit-mode frame. Compared field by field first, so a view standing
  // still costs no allocation; a ▶ Test is never written, since its camera is
  // the player's and the editor's comes back when it stops.
  function syncViewUrl(now: number): void {
    if (!viewUrlLive || mode !== "edit" || now - viewWrittenAt < VIEW_URL_INTERVAL_MS) return;
    if (viewWritten && viewMatches(viewWritten)) return;
    const view: EditorView = {
      level: viewLevel(),
      prefab: prefabMode ? prefabName : null,
      cam: { x: camera.position.x, y: camera.position.y, zoom: camera.zoom, yaw: orbit.yaw, pitch: orbit.pitch },
      vis: visuals?.view ?? null,
      workspace,
      ortho: projection === "orthographic",
    };
    const href = editorViewHref(location.href, view);
    // `window.` because `history` in here is the undo stack.
    if (href !== location.href) window.history.replaceState(window.history.state, "", href);
    viewWritten = view;
    viewWrittenAt = now;
  }

  function takeUpUrlView(): void {
    const { cam, vis } = urlView;
    if (cam) {
      camera.position = new Vec2(cam.x, cam.y);
      camera.zoom = cam.zoom;
    }
    if (urlView.ortho) setProjection("orthographic");
    // The pose is the view: the one the address wrote, else the 2D camera's
    // with the orbit an older address carried. The field of view is the
    // editor's lens, which is why the address does not carry it.
    const lens = editorLens();
    if (vis && visuals) visuals.setView({ ...vis, fovYDeg: lens.fovYDeg });
    else if (cam && visuals) {
      const pitch = Math.max(-MAX_ORBIT_PITCH, Math.min(MAX_ORBIT_PITCH, cam.pitch));
      visuals.setView(poseFromCamera(camera, lens, { yaw: cam.yaw, pitch }));
    }
    refreshOrbitBtn();
    applyToolCursor();
  }

  // --- boot -----------------------------------------------------------------
  camera.position = model.player.pos;
  // The one 3D view's camera, head on at the spawn to start (see `inVisuals`).
  visuals?.enter();
  setLayer("scene");
  // The layer stack as this browser left it. Hiding the active layer here moves
  // the edit focus exactly as the eye does.
  {
    const layerPrefs = readLayerSettings();
    for (const l of layerPrefs.hidden) setLayerVisible(l, false);
    for (const l of layerPrefs.locked) setLayerLocked(l, true);
    layerPrefsLive = true;
  }
  setWorkspace(workspace, true);
  updateTitle();
  // Reopen the level this browser last had open (prefs.ts), once the list
  // says it is still on disk; a name that is gone is forgotten rather than
  // reported. Skipped if the empty model was edited, or a level loaded, while
  // the list was on its way: the author has already started on something.
  //
  // The address's level comes first (viewUrl.ts): it is this tab's, where the
  // level last open is the browser's. Its view is taken up only over the level
  // it was written for - or over the unnamed model, for an address naming none.
  const bootRev = modelRev;
  void refreshLevelList()
    .then(async (listed) => {
      const fresh = modelRev === bootRev && currentName === null;
      const name = urlView.level ?? readLastLevel();
      if (fresh && listed && name !== null) {
        if (levelNames.includes(name)) await doLoad(name);
        else if (urlView.level === null) writeLastLevel(null);
      }
      // ...and the prefab that was open over it, as a reload in the middle of
      // editing one comes back to it (a prefab is a scene of its own).
      const prefab = urlView.prefab ?? readOpenPrefab();
      if (fresh && prefab !== null) {
        await openPrefab(prefab);
        if (prefabMode && urlView.prefab === prefab) takeUpUrlView();
      } else if (fresh && currentName === urlView.level) takeUpUrlView();
    })
    .finally(() => {
      viewUrlLive = true;
    });
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
  .ed-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .ed-btn { background: #2a2f3d; color: #cbccc6; border: 1px solid #3c445c;
    padding: 3px 8px; font-family: monospace; font-size: 13px; cursor: pointer;
    border-radius: 2px; }
  .ed-btn:hover { background: #343b4d; }
  .ed-btn.active { border-color: #65bddb; color: #65bddb; }
  /* A control that cannot be used has to LOOK it. Every colour here is set
     explicitly, so the browser's own disabled greying never lands and a dead
     field or button was drawn exactly like a live one. */
  .ed-btn:disabled, .ed-num:disabled, .ed-select:disabled, .ed-text:disabled {
    opacity: 0.4; cursor: default; }
  .ed-btn:disabled:hover { background: #2a2f3d; }
  .ed-select, .ed-num { background: #1f2430; color: #cbccc6; border: 1px solid #3c445c;
    font-family: monospace; font-size: 13px; padding: 2px 4px; border-radius: 2px; }
  .ed-num { width: 64px; }
  .ed-text { background: #1f2430; color: #cbccc6; border: 1px solid #3c445c;
    font-family: monospace; font-size: 13px; padding: 4px; border-radius: 2px;
    width: 100%; box-sizing: border-box; resize: vertical; }
  .ed-color { width: 44px; height: 22px; padding: 0; background: #1f2430;
    border: 1px solid #3c445c; border-radius: 2px; cursor: pointer; }
  /* The colour picker (colorPicker.ts). A child of body rather than of the
     panel, so no scrolling or clipping ancestor can cut it off. */
  .ed-picker { position: fixed; z-index: 1000; display: flex; flex-direction: column;
    gap: 6px; padding: 8px; background: #1f2430; border: 1px solid #3c445c;
    border-radius: 2px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); font-family: monospace;
    font-size: 13px; color: #cbccc6; }
  .ed-picker-sv { position: relative; cursor: crosshair; touch-action: none;
    background-image: linear-gradient(to top, #000, transparent),
      linear-gradient(to right, #fff, transparent); }
  .ed-picker-hue { position: relative; cursor: ew-resize; touch-action: none;
    background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
  .ed-picker-dot { position: absolute; width: 10px; height: 10px; margin: -6px 0 0 -6px;
    border: 1px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px #000;
    pointer-events: none; }
  .ed-picker-bar { position: absolute; top: -2px; bottom: -2px; width: 4px; margin-left: -3px;
    border: 1px solid #fff; box-shadow: 0 0 0 1px #000; pointer-events: none; }
  /* The hex field takes what the square leaves beside the eyedropper: no width
     of its own, or its default size would widen the picker past the square. */
  .ed-picker-row { display: flex; gap: 6px; }
  .ed-picker-hex { width: 0; flex: 1; min-width: 0; }
  .ed-picker-pick { display: inline-flex; align-items: center; justify-content: center;
    padding: 0 6px; cursor: pointer; }
  /* The eyedropper (eyedropper.ts): a cover over the whole page while picking,
     above the picker, and the swatch it shows beside the pointer. */
  .ed-dropper { position: fixed; inset: 0; z-index: 1001; cursor: crosshair; }
  .ed-dropper-chip { position: fixed; display: flex; gap: 6px; align-items: center;
    padding: 3px 6px; background: #1f2430; border: 1px solid #3c445c; border-radius: 2px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5); font-family: monospace; font-size: 13px;
    color: #cbccc6; pointer-events: none; white-space: nowrap; }
  .ed-dropper-chip[hidden] { display: none; }
  .ed-dropper-swatch { width: 14px; height: 14px; border: 1px solid #3c445c; }
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
  /* Buttons that are one choice (2D | 3D), kept together at the row's end. */
  .ed-pair { display: inline-flex; gap: 4px; }
  /* A READOUT is the one thing in a field that cannot be sized: it is a
     sentence the panel computes, and the panel is 190px wide. Left nowrap it
     was simply cut off - "2.67 cm/frame - TOO FAST" read "2.67 cm/frame - TO",
     losing exactly the half that was the warning. So the value wraps where the
     label does not, and a long one takes a second line instead of a haircut. */
  .ed-field > span:not(.ed-name) { white-space: normal; text-align: right; min-width: 0; }
  /* A picker is bounded by the row it is in, whatever its longest option says.
     A <select> sizes itself to its widest option and "min-width: auto" refuses
     to shrink below that, so one long name - a sky called after the place it was
     captured rather than after a file - stretched the control to 404px inside a
     179px panel, overlapping the row above it and running off the edge. The
     option list still opens at full width, which is where the name is read. */
  .ed-field > select { min-width: 0; flex: 0 1 auto; text-overflow: ellipsis; }
  /* A field that belongs to the one above it rather than to the group: the
     three categories under "collides with". Indented so the heading reads as
     theirs, and stacked one per row like every other field rather than laid out
     across - three labelled boxes side by side need 171px of a 176px content
     column, so they wrapped after the second and read as "player, hook" and
     then "chain" on its own. */
  .ed-sub { padding-left: 10px; }
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
  .ed-out-row.obj { color: #9aa0ac; }
  /* What an object can be, coloured as the canvas already colours it: solid
     geometry plain, decoration teal (its dashed editor outline), a light amber
     (it is the one furniture layer whose colour is authored), an anchor the
     forged iron of the chain it ties. */
  .ed-out-row.obj.light .ed-out-label { color: #e5c07b; }
  .ed-out-row.obj.anchor .ed-out-label { color: #9a8c7a; }
  .ed-out-row.obj.chain .ed-out-label { color: #9a8c7a; }
  /* A section head inside the list: a chain is not in any body, so it cannot be
     a child row, and the count belongs where the body count is. */
  .ed-out-row.head { color: #6b7280; cursor: default; margin-top: 4px; }
  .ed-out-row.head:hover { background: none; }
  .ed-out-twist { width: 10px; color: #6b7280; text-align: center; flex: none; }
  .ed-out-twist.live:hover { color: #cbccc6; }
  .ed-out-label { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .ed-out-count { margin-left: auto; color: #6b7280; }
  /* THE SCENE TREE (plans/node-tree.md): a node's class as a mark, whether it
     is in the plane or the scene, its name, then the group mark, the add and
     the eye at the right edge. Indented a character per level. */
  .ed-out-type { width: 2ch; flex: none; text-align: center; color: #6b7280; }
  .ed-out-dim { width: 2.5ch; flex: none; color: #4b5263; }
  .ed-out-group { width: 2ch; flex: none; text-align: center; color: transparent; }
  .ed-out-group.on { color: #65bddb; }
  .ed-out-row:hover .ed-out-group:not(.on) { color: #4b5263; }
  .ed-out-group:hover { color: #cbccc6 !important; }
  .ed-out-add { width: 2ch; flex: none; text-align: center; color: transparent; }
  .ed-out-row:hover .ed-out-add { color: #6b7280; }
  .ed-out-add:hover { color: #cbccc6 !important; }
  .ed-out-row.drop-into { outline: 1px solid #65bddb; }
  .ed-out-row.drop-before { box-shadow: inset 0 2px 0 #65bddb; }
  .ed-out-row.drop-after { box-shadow: inset 0 -2px 0 #65bddb; }
  .ed-out-crumb { color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ed-out-crumb:empty { display: none; }
  .ed-out-rename { flex: 1; min-width: 0; background: #1f2430; color: #cbccc6;
    border: 1px solid #65bddb; font: inherit; padding: 0 2px; }
  .ed-out-menu { position: fixed; z-index: 50; background: rgba(31,36,48,0.98);
    border: 1px solid #313244; padding: 4px; display: flex; flex-direction: column; }
  .ed-out-menu-item { padding: 2px 6px; cursor: pointer; white-space: nowrap; color: #cbccc6; }
  .ed-out-menu-item:hover { background: #2a2f3d; }
  .ed-chip { display: inline-flex; gap: 2px; align-items: center; margin-right: 6px; }
  .ed-data-layers .ed-layer-row { display: flex; gap: 4px; align-items: center; }
  .ed-data-layers .ed-layer-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Formations (formationPanel.ts): a stale rock's status and its Regenerate
     in the amber that says "a consequence", not "invalid". */
  .ed-formation-status.ed-stale { color: #d0a215; }
  .ed-btn.ed-attention { border-color: #d0a215; color: #e5c07b; }
  .ed-field > label { display: inline-flex; gap: 2px; align-items: center; }
  /* The jobs panel (formationJobs.ts): bottom-right, out of the inspector's and
     the outliner's way, only while there are jobs. */
  .ed-jobs { position: absolute; right: 8px; bottom: 8px; width: 280px; z-index: 5;
    background: rgba(31,36,48,0.92); border: 1px solid #313244; padding: 6px;
    border-radius: 2px; display: flex; flex-direction: column; gap: 4px;
    color: #cbccc6; pointer-events: auto; }
  .ed-jobs-head { display: flex; justify-content: space-between; align-items: center; color: #65bddb; }
  .ed-jobs-head button, .ed-job-cancel { background: transparent; color: #9aa0ac; border: 1px solid #3c445c;
    border-radius: 2px; font: inherit; cursor: pointer; padding: 0 6px; }
  .ed-jobs-list { display: flex; flex-direction: column; gap: 6px; max-height: 40vh; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: #3c445c transparent; }
  .ed-job { display: flex; flex-direction: column; gap: 2px; }
  .ed-job-top { display: flex; gap: 6px; align-items: center; }
  .ed-job-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ed-job-state { color: #9aa0ac; white-space: nowrap; }
  .ed-job-done .ed-job-state { color: #8fbf7f; }
  .ed-job-failed .ed-job-state { color: #d98a5f; }
  .ed-job-bar { height: 4px; background: #2a2f3d; border-radius: 2px; overflow: hidden; }
  .ed-job-bar > div { height: 100%; background: #65bddb; }
  .ed-job-step { color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ed-job-error { margin: 0; color: #d98a5f; white-space: pre-wrap; word-break: break-word;
    max-height: 120px; overflow-y: auto; font-size: 12px; }
  .ed-job a { color: #65bddb; }
  /* A solid guide's tree in its Formation panel: one row a node, the picked
     one in the selection's colour. */
  .ed-solid-tree { display: flex; flex-direction: column; max-height: 30vh; overflow-y: auto; }
  .ed-solid-row { cursor: pointer; padding: 1px 4px; border-radius: 2px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .ed-solid-row:hover { background: #2a2f3d; }
  .ed-solid-row.sel { background: #33405a; }
  .ed-test-banner { position: fixed; top: 8px; left: 50%; transform: translateX(-50%);
    background: rgba(31,36,48,0.92); border: 1px solid #65bddb; color: #65bddb;
    font-family: monospace; font-size: 13px; padding: 4px 12px; border-radius: 2px; z-index: 10; }
  ${PANEL_UI_CSS}
  `;
  document.head.appendChild(s);
}
