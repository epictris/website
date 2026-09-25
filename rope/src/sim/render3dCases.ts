// 3D rendering cases: the claims the whole `render3d/` scene stands on, checked
// directly rather than through a picture.
//
// The load-bearing one is the CAMERA CORRESPONDENCE. The 3D scene and the 2D
// overlay are two canvases stacked on one frame, and everything that makes the
// overlay useful - a collision outline landing on the geometry it describes, the
// aim reticle sitting where the player is aiming, the editor's handles gripping
// the shape under them - is the two agreeing about where a world point lands in
// view pixels. Agreement by eye at one zoom is not agreement: the perspective
// camera derives its distance from `camera.zoom`, so a wrong constant is a
// misalignment that grows with how far the point is from the centre of the frame
// and closes again as the view zooms, which is exactly the shape of a bug that
// reads as "it looks fine" in a screenshot.
//
// The rest are geometry: an extruded outline has to come out facing the camera
// and the right way up, and the winding it takes is a y-negation away from the
// physics one (see extrude.ts), which is a sign error nothing downstream would
// report as anything but a dark, inside-out prop.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { VIEW_HEIGHT, VIEW_WIDTH } from "../render/viewport";
import type { Camera } from "../render/camera";
import {
  applyPose,
  CAMERA_FAR,
  cameraDistance,
  DEFAULT_LENS,
  focalLengthFromFov,
  FOV_Y_DEG,
  isHeadOn,
  lensOf,
  MAX_ORBIT_PITCH,
  NO_ORBIT,
  poseDistance,
  poseFromCamera,
  type CameraOrbit,
  type SceneLens,
  type ViewCamera,
  type ViewPose,
  projectToView,
  syncCamera,
  threeY,
  unprojectToPlane,
  visibleHeightMetres,
} from "../render3d/space";
import { dolly, frame, headOn, orbit, pan } from "../editor/visuals/viewControls";
import { MIN_VIEW_DISTANCE, poseBasis, poseEye } from "../editor/visuals/viewPose";
import { Guides, type GuideView } from "../editor/visuals/guides";
import { guideTag, isGuideTag, SPAWN_GUIDE_ID, type GuideTag } from "../editor/visuals/tags";
import {
  draftSignature,
  handleUnder,
  itemsBox,
  itemsUnder,
  ORBIT_RADIANS_PER_PX,
  VisualsWorkspace,
  type WorkspaceScene,
} from "../editor/visuals/workspace";
import { SurfaceLoop } from "../editor/visuals/surfaceLoop";
import { alignUp, surfacePlacement, upOf } from "../editor/visuals/surfaceDrop";
import { ED_LAYERS, offsetZAfterMove, type EdLayer } from "../editor/model";
import { cylinderSolid, extrudeOutline } from "../render3d/extrude";
import { cloneWithPatches, isOrthographicMaterial } from "../render3d/projection";
import {
  DEFAULT_TEXTURE,
  emissiveMapName,
  emissiveMapNames,
  isSolidSurface,
  SOLID_SURFACE,
  surfaceKey,
  surfaceName,
  surfaceTile,
  tileMetres,
  wakeEmission,
  textureMaps,
  TEXTURE_ASSETS,
  TEXTURE_SETS,
} from "../render3d/assets";
import {
  DEFAULT_LIGHT_COLOR,
  DEFAULT_LIGHT_INTENSITY,
  DEFAULT_LIGHT_RANGE,
  LIGHT_BUDGET,
  LIGHT_SHADOW_NEAR,
  LightRig,
} from "../render3d/lights";
import {
  DEFAULT_FIREFLY_NOTICE,
  FIREFLY_MAX,
  FIREFLY_POOL,
  Swarm,
  swarmParams,
} from "../render3d/fireflies";
import {
  scaleLevelData,
  scaleObject,
  isLightObject,
  type LevelData,
  isCollisionObject,
  isAnchorObject,
  isGeometryObject,
  normalizeLevelData,
  spawnAtCheckpoint,
  type GeometryObjectData,
  type GeometryProjection,
  type LightObjectData,
  type LevelBodyData,
  type SceneObjectData,
  type RawLevelData,
} from "../level/levelFormat";
import { BodyVisual, drawnObjects, mountVisual, surfaceInstance } from "../render3d/bodyVisuals";
import {
  assignPool,
  DEFAULT_WAKE_FALL,
  DEFAULT_WAKE_RISE,
  GLOW_POOL,
  GlowState,
  MAX_GLOW_STEP,
  WAKE_HYSTERESIS,
  wakeParams,
} from "../render3d/glow";
import {
  beltNearest,
  beltOutline,
  beltPointAt,
  beltTangentAt,
  buildBeltLoop,
} from "../lib/belt";
import {
  BELT_TREAD_PITCH,
  beltFrameAt,
  beltRenderTime,
  beltTextureTile,
  beltTreadDepth,
  beltTreadPhase,
  beltTreadPitch,
} from "../render/beltTread";
import { BeltRing, beltRingStations } from "../render3d/beltTread";
import { outlineOfData } from "../render/shapePath";
import { loopContainsPoint } from "../lib/polygon";
import { DECOR_Z, depthOf } from "../level/decor";
import ballLevelJson from "../../levels/ball.json";
const BALL_LEVEL = ballLevelJson as unknown;
import { World } from "../engine/world";
import { buildLevelBodies, localPlacement, worldPlacement } from "../level/buildBodies";
import {
  modelFromDisk,
  modelToDisk,
  toLevelData,
  syncMatchedOutlines,
  setPolyVerts,
  setBelt,
  beltShapeData,
  beltLap,
  beltInsertWheel,
  beltRemoveWheel,
  bodyCentroid,
  bodyMembers,
  bodyFrameOf,
  originToCentroid,
  pinBodyFrame,
  selectionCentre,
  captureGroupPose,
  placeGroup,
  type EdItem,
  type EdModel,
  glowBody,
  fireflyBody,
  FIREFLY_COUNT,
  FIREFLY_NOTICE,
  GLOW_COLOR,
  GLOW_CUBE,
  GLOW_EMISSIVE,
  GLOW_EMISSIVE_INTENSITY,
  GLOW_INTENSITY,
  GLOW_RANGE,
  GLOW_WAKE,
  GLOW_WAKE_DELAY,
  GLOW_WAKE_FALL,
  GLOW_WAKE_RISE,
} from "../editor/model";
import { lightPlaneReach } from "../editor/render";
import { readClipboard, writeClipboard } from "../editor/clipboard";
import {
  EQUIRECT_SIZE,
  equirectPixels,
  FOG_REFERENCE_DISTANCE,
  fogDensity,
  skyInputs,
} from "../render3d/environment";
import { AVATAR_FOG, AVATAR_PROGRAM_KEY, AVATAR_WRAP, wearAvatar } from "../render3d/avatarSurface";
import { beamFarRadius, beamRadiusAt, BEAM_SOURCE_RADIUS, seedDust } from "../render3d/beam";
import { IRON_SURFACE } from "../render3d/assets";
import { glowProp, patchGlow, stretch } from "../render3d/propGlow";
import { HDRI_ASSETS, hdriNames } from "../render3d/assets";
import { PIXELS_PER_METER, PX } from "../engine/units";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalString, generatedKey, generatedMeshAsset, parseGeneratedKey } from "../render3d/generated";
import { generatedMeta } from "../render3d/generatedMeta";
import { levelStoredFiles } from "../render3d/levelAssets";
import {
  canonicalParams,
  expectedKey,
  GENERATOR_KINDS,
  GENERATOR_SCHEMAS,
  generatorInput,
  isStale,
  itemLookup,
  mergeDefaults,
  scaleParams,
  stripDefaults,
  validateParams,
  type GeneratorKind,
} from "../editor/visuals/paramSchema";
import { cloneGenerator, cloneVisual, remapPatchHosts } from "../editor/model";
import { paramSpec, wantedKey, type ParamValues } from "../editor/visuals/paramSchema";
import {
  frameOf,
  loopPointToWorld,
  patchMatrix,
  selectSurface,
  soupInFrame,
  worldToLoopPoint,
} from "../editor/visuals/surfacePatch";
import {
  existingRock,
  landMesh,
  MIN_PATCH_EXTENT,
  objectPose,
  patchFor,
  refitPatch,
  rockFor,
  rockSource,
} from "../editor/visuals/generatorEdits";
import {
  clampParam,
  generatorBadge,
  generatorStatus,
  hexOfLinear,
  linearOfHex,
  nextSeedParams,
  paramIssues,
  paramLabel,
  paramsPayload,
  parseParamsPayload,
  withParam,
} from "../editor/visuals/generatorPanel";
import { GeneratorJobs, missingTools, POLL_MISSES, type Fetcher, type Job } from "../editor/visuals/jobs";

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function camera(x: number, y: number, zoom: number): Camera {
  return {
    position: new Vec2(x, y),
    zoom,
    viewportWidth: VIEW_WIDTH,
    viewportHeight: VIEW_HEIGHT,
  };
}

// Where three.js actually puts a gameplay-plane point on screen, in view pixels:
// the projection the GPU will do, run on the CPU. Nothing here is a
// reimplementation of the correspondence - it is the camera `syncCamera` built,
// asked where a point lands.
function projectThroughThree(cam: Camera, world: Vec2): { x: number; y: number } {
  const threeCam = new THREE.PerspectiveCamera(FOV_Y_DEG, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 1000);
  syncCamera(threeCam, cam);
  threeCam.updateMatrixWorld(true);
  const ndc = new THREE.Vector3(world.x, -world.y, 0).project(threeCam);
  return {
    x: ((ndc.x + 1) / 2) * VIEW_WIDTH,
    y: ((1 - ndc.y) / 2) * VIEW_HEIGHT,
  };
}

// Sub-hundredth of a view pixel. The two projections are the same arithmetic
// reached two ways (a scale, and a perspective divide at a distance chosen to
// produce it), so what is left is float noise on a 1920-wide frame.
const PIXEL_TOL = 0.01;

// Geometry attributes are float32, so a "these are the same number" test on one
// is held to float32 precision at the magnitudes a level uses, not float64.
const F32 = 1e-6;

// A LEVEL'S LENS (`LevelCameraData`): its focal length and z offset.
//
// The claims are the correspondence's own, restated for a camera the level has
// moved. A focal length changes the lens and NOT the framing - the camera
// dollies so the gameplay plane stays exactly where the 2D view has it - and a
// z offset moves the framed plane itself, so the correspondence holds on the
// plane at that depth and (by the ratio of the two distances) not on z = 0.
function levelLens(): CaseResult[] {
  const cam = camera(13.5, -7.25, 2);
  const halfH = VIEW_HEIGHT / 2 / (cam.zoom * PIXELS_PER_METER);
  const halfW = VIEW_WIDTH / 2 / (cam.zoom * PIXELS_PER_METER);
  const corners = [
    new Vec2(halfW, halfH),
    new Vec2(-halfW, halfH),
    new Vec2(halfW, -halfH),
    new Vec2(-halfW, -halfH),
  ].map((d) => cam.position.add(d));
  // Worst view-pixel disagreement between the 2D transform and three's own
  // projection, for points on the plane at depth `z`.
  const worstAt = (lens: SceneLens, z: number): number => {
    const c = new THREE.PerspectiveCamera();
    syncCamera(c, cam, lens);
    c.updateMatrixWorld(true);
    let worst = 0;
    for (const p of corners) {
      const a = projectToView(cam, p);
      const ndc = new THREE.Vector3(p.x, -p.y, z).project(c);
      const b = { x: ((ndc.x + 1) / 2) * VIEW_WIDTH, y: ((1 - ndc.y) / 2) * VIEW_HEIGHT };
      worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    }
    return worst;
  };

  const roundTrip = lensOf({ focalLength: focalLengthFromFov(FOV_Y_DEG) }).fovYDeg;
  const defaults =
    lensOf(undefined).fovYDeg === FOV_Y_DEG &&
    lensOf(undefined).zOffset === 0 &&
    lensOf({ focalLength: 0 }).fovYDeg === FOV_Y_DEG;

  const tele = lensOf({ focalLength: 85 });
  const teleErr = worstAt(tele, 0);
  const moved: SceneLens = { fovYDeg: FOV_Y_DEG, zOffset: 1.5 };
  const movedErr = worstAt(moved, moved.zOffset);
  const movedPlaneErr = worstAt(moved, 0);

  // A long lens stands the camera far back; the far plane has to follow or the
  // gameplay plane itself is clipped away.
  const far = new THREE.PerspectiveCamera();
  syncCamera(far, cam, lensOf({ focalLength: 2000 }));
  far.updateMatrixWorld(true);
  const planeDepth = new THREE.Vector3(cam.position.x, -cam.position.y, 0).project(far).z;

  const raw: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [],
    camera: { focalLength: 85, zOffset: 150 },
  };
  const scaled = scaleLevelData(raw, 1 / PIXELS_PER_METER).camera;
  const scaledOk = scaled?.focalLength === 85 && Math.abs((scaled.zOffset ?? 0) - 1.5) < 1e-12;
  const saved = modelToDisk(modelFromDisk(raw)).camera;
  const savedOk = saved?.focalLength === 85 && Math.abs((saved.zOffset ?? 0) - 150) < 1e-9;
  const bare = modelToDisk(modelFromDisk({ player: raw.player, bodies: [] }));
  const bareOk = !("camera" in bare);

  return [
    {
      name: "lens: focal length and field of view convert both ways, and absent is the old lens",
      pass: Math.abs(roundTrip - FOV_Y_DEG) < 1e-9 && defaults,
      detail: `${FOV_Y_DEG} deg -> ${focalLengthFromFov(FOV_Y_DEG).toFixed(3)} mm -> ${roundTrip} deg`,
    },
    {
      name: "lens: an 85 mm lens frames the gameplay plane exactly as the 2D view does",
      pass: teleErr < PIXEL_TOL,
      detail: `worst corner ${teleErr.toFixed(5)} px`,
    },
    {
      name: "lens: a z offset frames the plane at that depth as the 2D view, and not z = 0",
      pass: movedErr < PIXEL_TOL && movedPlaneErr > 1,
      detail: `framed plane ${movedErr.toFixed(5)} px, gameplay plane ${movedPlaneErr.toFixed(1)} px`,
    },
    {
      name: "lens: a very long lens does not clip the gameplay plane",
      pass: planeDepth > -1 && planeDepth < 1,
      detail: `plane at ndc z ${planeDepth.toFixed(4)}, far ${far.far.toFixed(1)} m`,
    },
    {
      name: "format: a level's camera block scales its offset, keeps its focal length, and survives a save",
      pass: scaledOk && savedOk && bareOk,
      detail: `scaled ${JSON.stringify(scaled)}, saved ${JSON.stringify(saved)}, bare level writes camera: ${!bareOk}`,
    },
  ];
}

function cameraCorrespondence(): CaseResult[] {
  const out: CaseResult[] = [];
  // Camera placements across the range a level actually uses: the ball level's
  // base zoom, a region zoomed out to twice the world (viewportScale 2), one
  // zoomed in, and an off-origin camera mid-blend at a zoom between two regions.
  const cams: Array<{ name: string; cam: Camera }> = [
    { name: "origin @ base zoom", cam: camera(0, 0, 2) },
    { name: "off-centre @ base zoom", cam: camera(13.5, -7.25, 2) },
    { name: "zoomed out (viewportScale 2)", cam: camera(-4, 11, 1) },
    { name: "zoomed in (viewportScale 0.5)", cam: camera(2.5, 3.5, 4) },
    { name: "mid-blend zoom", cam: camera(-31.4, 6.28, 1.7307) },
  ];
  // Points spread to the frame's corners, where a wrong camera distance shows up
  // first: the centre agrees under almost any lens.
  const probes = (cam: Camera): Vec2[] => {
    const halfH = VIEW_HEIGHT / 2 / (cam.zoom * PIXELS_PER_METER);
    const halfW = VIEW_WIDTH / 2 / (cam.zoom * PIXELS_PER_METER);
    return [
      cam.position,
      cam.position.add(new Vec2(halfW, halfH)),
      cam.position.add(new Vec2(-halfW, halfH)),
      cam.position.add(new Vec2(halfW, -halfH)),
      cam.position.add(new Vec2(-halfW, -halfH)),
      cam.position.add(new Vec2(halfW * 0.37, -halfH * 0.81)),
    ];
  };
  for (const { name, cam } of cams) {
    let worst = 0;
    let at = Vec2.ZERO;
    for (const p of probes(cam)) {
      const a = projectToView(cam, p);
      const b = projectThroughThree(cam, p);
      const err = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      if (err > worst) {
        worst = err;
        at = p;
      }
    }
    out.push({
      name: `camera correspondence: ${name}`,
      pass: worst <= PIXEL_TOL,
      detail: `worst ${worst.toExponential(2)} px at (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`,
    });
  }
  return out;
}

// A body drawn at the centre of the frame must not move when the CAMERA moves
// and the body moves with it: the correspondence has to be a translation, not a
// translation plus a perspective wobble. This is the region-blend case - the
// camera easing across the level while the avatar sits still relative to it -
// which is the one the acceptance criterion calls out.
function blendStability(): CaseResult[] {
  const offsets = [0, 0.37, 1.6, 4.2, 11.9];
  let worst = 0;
  for (const d of offsets) {
    const cam = camera(d, -d * 0.6, 2);
    const p = cam.position.add(new Vec2(3.2, -1.7));
    const a = projectToView(cam, p);
    const b = projectThroughThree(cam, p);
    worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  return [
    {
      name: "camera correspondence: stable through a pan",
      pass: worst <= PIXEL_TOL,
      detail: `worst ${worst.toExponential(2)} px over ${offsets.length} camera positions`,
    },
  ];
}

// The editor's orbit (see `CameraOrbit`). It is the one thing that moves the
// camera off the axis every overlay in the project is aligned against, so what
// is asserted is that it changes nothing at all until it is asked to, and that
// when it is asked to it only TURNS: the view neither zooms nor slides off what
// it was centred on, which is what makes `Reset view` a return to exactly the
// picture the level was authored against.
function orbitView(): CaseResult[] {
  const out: CaseResult[] = [];
  const cam = camera(13.5, -7.25, 2);
  const dist = cameraDistance(cam);
  const make = (): THREE.PerspectiveCamera =>
    new THREE.PerspectiveCamera(FOV_Y_DEG, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 1000);

  // Zero orbit is the head-on camera, to the bit: the game passes no orbit at
  // all, and a feature that moved its camera by a float's worth would be a
  // feature that changed every level's framing.
  const plain = make();
  syncCamera(plain, cam);
  const zero = make();
  syncCamera(zero, cam, DEFAULT_LENS,{ yaw: 0, pitch: 0 });
  const same =
    plain.position.equals(zero.position) &&
    plain.rotation.x === zero.rotation.x &&
    plain.rotation.y === zero.rotation.y &&
    plain.rotation.z === zero.rotation.z;
  out.push({
    name: "orbit: zero is the head-on camera, unchanged",
    pass: same,
    detail: `${plain.position.toArray().join(",")} vs ${zero.position.toArray().join(",")}`,
  });

  // Turned: the focus stays at the frame's centre and at the same distance, so
  // the gesture is a turn and nothing else.
  const focus = new THREE.Vector3(cam.position.x, -cam.position.y, 0);
  let worstCentre = 0;
  let worstDist = 0;
  for (const yaw of [-1.2, -0.3, 0.45, 1.9, 3.0]) {
    for (const pitch of [-1.0, -0.2, 0, 0.35, 1.1]) {
      const c = make();
      syncCamera(c, cam, DEFAULT_LENS,{ yaw, pitch });
      c.updateMatrixWorld(true);
      const ndc = focus.clone().project(c);
      worstCentre = Math.max(worstCentre, Math.abs(ndc.x), Math.abs(ndc.y));
      worstDist = Math.max(worstDist, Math.abs(c.position.distanceTo(focus) - dist));
    }
  }
  out.push({
    name: "orbit: the view turns about what it is centred on, at a fixed distance",
    pass: worstCentre <= 1e-6 && worstDist <= 1e-9,
    detail: `centre off by ${worstCentre.toExponential(2)} ndc, distance by ${worstDist.toExponential(2)} m`,
  });

  // A quarter turn of yaw looks along the level's own +x axis, which is what
  // says the sign and the axis are the ones the drag handler thinks they are.
  const side = make();
  syncCamera(side, cam, DEFAULT_LENS,{ yaw: Math.PI / 2, pitch: 0 });
  out.push({
    name: "orbit: a quarter turn puts the camera out along +x",
    pass:
      Math.abs(side.position.x - (focus.x + dist)) <= 1e-9 &&
      Math.abs(side.position.y - focus.y) <= 1e-9 &&
      Math.abs(side.position.z) <= 1e-9,
    detail: `at (${side.position.x.toFixed(3)}, ${side.position.y.toFixed(3)}, ${side.position.z.toFixed(3)}), focus x ${focus.x.toFixed(3)} + ${dist.toFixed(3)}`,
  });

  // Past the poles the up vector degenerates and the view rolls, so the pitch is
  // clamped inside `syncCamera` rather than only at the drag that writes it.
  const over = make();
  syncCamera(over, cam, DEFAULT_LENS,{ yaw: 0, pitch: Math.PI / 2 });
  out.push({
    name: "orbit: pitch is clamped short of the pole",
    pass: over.position.z > 0 && Math.abs(over.position.y - focus.y) < dist,
    detail: `z ${over.position.z.toFixed(3)}, rise ${(over.position.y - focus.y).toFixed(3)} of ${dist.toFixed(3)}`,
  });

  // `unprojectToPlane` is `projectToView` backwards, and it is what lets a
  // TURNED view be clicked in at all: everything the editor resolves against the
  // gameplay plane - a collision shape, a light, a camera region, a note, the
  // point a drag carries a body to - is a screen position turned back into a
  // world one, and head on that is a scale and an offset. Off axis it is not,
  // and the only honest answer is the ray that drew the pixel.
  //
  // Asserted as a ROUND TRIP through three's own projection at a spread of
  // orbits, because that is exactly the claim a pick stands on: a click on the
  // point where a body is drawn has to answer that body's own coordinates.
  const ndcOf = (p: { x: number; y: number }): [number, number] => [
    (p.x / VIEW_WIDTH) * 2 - 1,
    1 - (p.y / VIEW_HEIGHT) * 2,
  ];
  let worstTrip = 0;
  for (const orbit of [
    { yaw: 0, pitch: 0 },
    { yaw: 0.45, pitch: 0.2 },
    { yaw: -1.2, pitch: -0.5 },
    { yaw: 2.6, pitch: 0.9 },
  ]) {
    const c = make();
    syncCamera(c, cam, DEFAULT_LENS,orbit);
    c.updateMatrixWorld(true);
    for (const p of [
      new Vec2(cam.position.x, cam.position.y),
      new Vec2(cam.position.x + 4.3, cam.position.y - 2.1),
      new Vec2(cam.position.x - 6.75, cam.position.y + 3.4),
    ]) {
      const ndc = new THREE.Vector3(p.x, -p.y, 0).project(c);
      const back = unprojectToPlane(
        c,
        ndc.x,
        ndc.y,
      );
      worstTrip = Math.max(worstTrip, back ? back.sub(p).length() : Infinity);
    }
  }
  out.push({
    name: "orbit: a screen point un-projects onto the plane it was drawn from",
    pass: worstTrip <= 1e-9,
    detail: `worst round trip ${worstTrip.toExponential(2)} m`,
  });

  // Head on the two answers are the SAME answer, which is what leaves every
  // head-on pick on the 2D un-projection it has always used - and turned they
  // are not, which is what the whole thing is for. Both halves, because an
  // implementation that quietly returned the 2D answer would pass the round trip
  // above at zero orbit and put every turned-view click somewhere else.
  const headOn = make();
  syncCamera(headOn, cam, DEFAULT_LENS,{ yaw: 0, pitch: 0 });
  headOn.updateMatrixWorld(true);
  const probe = new Vec2(cam.position.x + 5.5, cam.position.y - 2.75);
  const px = projectToView(cam, probe);
  const flat = unprojectToPlane(headOn, ...ndcOf(px));
  const turnedCam = make();
  syncCamera(turnedCam, cam, DEFAULT_LENS,{ yaw: 0.6, pitch: 0.35 });
  turnedCam.updateMatrixWorld(true);
  const turned = unprojectToPlane(turnedCam, ...ndcOf(px));
  const flatErr = flat ? flat.sub(probe).length() : Infinity;
  const turnedErr = turned ? turned.sub(probe).length() : 0;
  out.push({
    name: "orbit: the plane un-projection is the 2D one head on and is not it turned",
    pass: flatErr <= 1e-9 && turnedErr > 0.5,
    detail: `head on off by ${flatErr.toExponential(2)} m, turned by ${turnedErr.toFixed(3)} m`,
  });
  return out;
}

// The editor's orthographic lens (see `ViewProjection`). Two claims, and the
// second is the whole reason the toggle exists: the gameplay plane is framed
// exactly as the 2D renderer frames it - so the overlay, the handles and the
// picking are as exact through this lens as through the other - and geometry OFF
// the plane is drawn at the plane's own scale, which is what "no perspective, so
// things that are in line look in line" means arithmetically.
function orthographicView(): CaseResult[] {
  const out: CaseResult[] = [];
  const cams: Array<{ name: string; cam: Camera }> = [
    { name: "origin @ base zoom", cam: camera(0, 0, 2) },
    { name: "off-centre, zoomed out", cam: camera(13.5, -7.25, 1) },
  ];
  const project = (cam: Camera, world: Vec2, z: number): { x: number; y: number } => {
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    syncCamera(ortho, cam);
    ortho.updateMatrixWorld(true);
    const ndc = new THREE.Vector3(world.x, -world.y, z).project(ortho);
    return { x: ((ndc.x + 1) / 2) * VIEW_WIDTH, y: ((1 - ndc.y) / 2) * VIEW_HEIGHT };
  };
  for (const { name, cam } of cams) {
    const halfH = VIEW_HEIGHT / 2 / (cam.zoom * PIXELS_PER_METER);
    const halfW = VIEW_WIDTH / 2 / (cam.zoom * PIXELS_PER_METER);
    const probes = [
      cam.position,
      cam.position.add(new Vec2(halfW, halfH)),
      cam.position.add(new Vec2(-halfW, -halfH)),
      cam.position.add(new Vec2(halfW * 0.37, -halfH * 0.81)),
    ];
    let worst = 0;
    for (const p of probes) {
      const a = projectToView(cam, p);
      const b = project(cam, p, 0);
      worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    }
    out.push({
      name: `orthographic: the plane is framed as the 2D renderer frames it (${name})`,
      pass: worst <= PIXEL_TOL,
      detail: `worst ${worst.toExponential(2)} px over ${probes.length} points`,
    });

    // The same point at four depths, out at a corner where a divide shows first.
    // Orthographic must draw all four in one place; perspective must not, or the
    // case would pass against a camera that is not actually orthographic.
    const corner = cam.position.add(new Vec2(halfW * 0.9, -halfH * 0.9));
    const flat = project(cam, corner, 0);
    let spread = 0;
    for (const z of [-20, -2, 2, 8]) {
      const q = project(cam, corner, z);
      spread = Math.max(spread, Math.abs(q.x - flat.x), Math.abs(q.y - flat.y));
    }
    const persp = projectThroughThree(cam, corner);
    const perspShift = ((): number => {
      const c = new THREE.PerspectiveCamera(FOV_Y_DEG, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 1000);
      syncCamera(c, cam);
      c.updateMatrixWorld(true);
      const ndc = new THREE.Vector3(corner.x, -corner.y, -20).project(c);
      const p = { x: ((ndc.x + 1) / 2) * VIEW_WIDTH, y: ((1 - ndc.y) / 2) * VIEW_HEIGHT };
      return Math.max(Math.abs(p.x - persp.x), Math.abs(p.y - persp.y));
    })();
    out.push({
      name: `orthographic: depth does not move a point on screen (${name})`,
      pass: spread <= PIXEL_TOL && perspShift > 1,
      detail: `ortho spread ${spread.toExponential(2)} px over 20 m of depth, perspective ${perspShift.toFixed(1)} px`,
    });
  }
  return out;
}

// `syncCamera` exactly as it was before the pose was factored out of it
// (`ViewPose`, `poseFromCamera`, `applyPose`), kept here as the reference the
// factored version is held to BIT FOR BIT. Every overlay in the project is
// aligned against the camera this built, so "the same to a tolerance" is not
// the claim: a float's worth of drift is a change to every level's framing.
function legacySyncCamera(
  threeCam: ViewCamera,
  camera: Camera,
  lens: SceneLens = DEFAULT_LENS,
  orbit: CameraOrbit = NO_ORBIT,
): void {
  const x = camera.position.x;
  const y = threeY(camera.position.y);
  const z = lens.zOffset;
  const dist = cameraDistance(camera, lens.fovYDeg);
  const aspect = camera.viewportWidth / camera.viewportHeight;
  threeCam.far = Math.max(CAMERA_FAR, dist + z + CAMERA_FAR / 2);
  if (threeCam instanceof THREE.OrthographicCamera) {
    const halfH = visibleHeightMetres(camera) / 2;
    const halfW = halfH * aspect;
    threeCam.left = -halfW;
    threeCam.right = halfW;
    threeCam.top = halfH;
    threeCam.bottom = -halfH;
  } else {
    threeCam.fov = lens.fovYDeg;
    threeCam.aspect = aspect;
  }
  if (isHeadOn(orbit)) {
    threeCam.position.set(x, y, z + dist);
    threeCam.rotation.set(0, 0, 0);
    threeCam.updateProjectionMatrix();
    return;
  }
  const pitch = Math.max(-MAX_ORBIT_PITCH, Math.min(MAX_ORBIT_PITCH, orbit.pitch));
  const cp = Math.cos(pitch);
  threeCam.position.set(
    x + dist * Math.sin(orbit.yaw) * cp,
    y + dist * Math.sin(pitch),
    z + dist * Math.cos(orbit.yaw) * cp,
  );
  threeCam.up.set(0, 1, 0);
  threeCam.lookAt(x, y, z);
  threeCam.updateProjectionMatrix();
}

// Every number a camera is drawn and picked through.
function cameraBits(c: ViewCamera): number[] {
  c.updateMatrixWorld(true);
  const out = [
    ...c.position.toArray(),
    ...c.quaternion.toArray(),
    ...c.up.toArray(),
    c.near,
    c.far,
    ...c.projectionMatrix.elements,
    ...c.matrixWorld.elements,
  ];
  if (c instanceof THREE.OrthographicCamera) out.push(c.left, c.right, c.top, c.bottom);
  else out.push(c.fov, c.aspect);
  return out;
}

function newViewCamera(ortho: boolean): ViewCamera {
  return ortho
    ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
    : new THREE.PerspectiveCamera(FOV_Y_DEG, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 1000);
}

// A fresh camera placed at a pose, matrices current, as `Scene3D.render`
// leaves its cameras before a pick.
function posedCamera(pose: ViewPose, aspect: number, ortho = false): ViewCamera {
  const c = newViewCamera(ortho);
  applyPose(c, pose, aspect);
  c.updateMatrixWorld(true);
  return c;
}

// THE VISUALS WORKSPACE'S VIEW (plans/visuals-workspace.md, Phase 1).
//
// The workspace holds a camera pose of its own and navigates it by pure
// functions (`editor/visuals/viewControls.ts`); the Level workspace's camera
// is now that same pose derived from the 2D camera. So the first claim is that
// the derivation changed nothing, to the bit, and the rest are the promise
// each gesture makes - asserted against three's own projection of the camera
// the pose builds, not against the pose's arithmetic, so a sign error in the
// gesture and the same one in its helper cannot agree with each other.
function visualsView(): CaseResult[] {
  const out: CaseResult[] = [];
  const placements: Array<{ name: string; cam: Camera; lens: SceneLens }> = [
    { name: "origin", cam: camera(0, 0, 2), lens: DEFAULT_LENS },
    { name: "off-centre", cam: camera(13.5, -7.25, 2), lens: DEFAULT_LENS },
    { name: "zoomed out through 85 mm", cam: camera(-40.3, 12.7, 0.35), lens: lensOf({ focalLength: 85 }) },
    { name: "zoomed in with a z offset", cam: camera(3.3, 90.1, 7.5), lens: { fovYDeg: FOV_Y_DEG, zOffset: 1.5 } },
    {
      name: "an editor window through 24 mm",
      cam: { position: new Vec2(-2.2, -5.9), zoom: 1.3, viewportWidth: 1283, viewportHeight: 771 },
      lens: lensOf({ focalLength: 24, zOffset: -0.8 }),
    },
  ];
  // Head on, turned, and turned past the pole (the clamp is part of the camera).
  const orbits: CameraOrbit[] = [NO_ORBIT, { yaw: 0.45, pitch: 0.2 }, { yaw: -2.6, pitch: 1.6 }];
  let compared = 0;
  const mismatches: string[] = [];
  for (const { name, cam, lens } of placements) {
    for (const o of orbits) {
      for (const ortho of [false, true]) {
        const want = newViewCamera(ortho);
        legacySyncCamera(want, cam, lens, o);
        const bits = cameraBits(want);
        const composed = newViewCamera(ortho);
        syncCamera(composed, cam, lens, o);
        const posed = newViewCamera(ortho);
        applyPose(posed, poseFromCamera(cam, lens, o), cam.viewportWidth / cam.viewportHeight);
        const tries: Array<[string, ViewCamera]> = [
          ["syncCamera", composed],
          ["applyPose(poseFromCamera)", posed],
        ];
        // The workspace's Home is `headOn`, which must be the head-on camera.
        if (isHeadOn(o)) {
          const home = newViewCamera(ortho);
          applyPose(home, headOn(cam, lens), cam.viewportWidth / cam.viewportHeight);
          tries.push(["headOn", home]);
        }
        for (const [how, c] of tries) {
          compared++;
          const got = cameraBits(c);
          const i = got.findIndex((v, k) => !Object.is(v, bits[k]));
          if (i >= 0 || got.length !== bits.length) {
            mismatches.push(`${how} ${name} yaw ${o.yaw} ${ortho ? "ortho" : "persp"}: [${i}] ${got[i]} vs ${bits[i]}`);
          }
        }
      }
    }
  }
  out.push({
    name: "visuals: a pose from the 2D camera is today's camera to the bit (5 placements, 3 orbits, both lenses)",
    pass: mismatches.length === 0 && compared === 5 * 3 * 2 * 2 + 5 * 2,
    detail: mismatches.length ? mismatches.slice(0, 3).join("; ") : `${compared} cameras identical in every number`,
  });

  const aspect = VIEW_WIDTH / VIEW_HEIGHT;
  const ndc = (c: ViewCamera, p: { x: number; y: number; z: number }): THREE.Vector3 =>
    new THREE.Vector3(p.x, p.y, p.z).project(c);
  // A pose the Level workspace cannot express: the target 1.7 m behind the
  // gameplay plane, turned both ways.
  const free: ViewPose = { target: { x: 4.1, y: -2.3, z: -1.7 }, yaw: 0.7, pitch: 0.35, halfHeight: 3.2, fovYDeg: FOV_Y_DEG };

  // The pose's own geometry is the camera `applyPose` builds.
  {
    let worst = 0;
    for (const p of [free, { ...free, yaw: -2.2, pitch: -0.9 }, { ...free, yaw: 0, pitch: 0 }]) {
      const c = posedCamera(p, aspect);
      const eye = poseEye(p);
      const b = poseBasis(p);
      const e = c.matrixWorld.elements;
      const axes: Array<[{ x: number; y: number; z: number }, number]> = [
        [b.right, 0],
        [b.up, 4],
        [b.back, 8],
      ];
      worst = Math.max(worst, Math.abs(eye.x - c.position.x), Math.abs(eye.y - c.position.y), Math.abs(eye.z - c.position.z));
      for (const [v, o] of axes) {
        worst = Math.max(worst, Math.abs(v.x - e[o]!), Math.abs(v.y - e[o + 1]!), Math.abs(v.z - e[o + 2]!));
      }
    }
    out.push({
      name: "visuals: the pose's eye and axes are the camera applyPose places",
      pass: worst <= 1e-12,
      detail: `worst ${worst.toExponential(2)}`,
    });
  }

  // ORBIT keeps the target at the centre of the frame and the camera at its
  // distance, and clamps the pitch as the Level workspace's orbit does.
  {
    let worstCentre = 0;
    let worstDist = 0;
    const d0 = poseDistance(free);
    for (const [dy, dp] of [[0.3, 0.1], [-1.4, -0.6], [2.9, 0.05], [0, -0.3]] as const) {
      const turned = orbit(free, dy, dp);
      const c = posedCamera(turned, aspect);
      const q = ndc(c, turned.target);
      worstCentre = Math.max(worstCentre, Math.abs(q.x), Math.abs(q.y));
      worstDist = Math.max(worstDist, Math.abs(c.position.distanceTo(new THREE.Vector3(free.target.x, free.target.y, free.target.z)) - d0));
    }
    const pole = orbit(free, 0, 10);
    out.push({
      name: "visuals: orbit keeps the target's screen position and the distance, and clamps the pitch",
      pass: worstCentre <= 1e-9 && worstDist <= 1e-9 && pole.pitch === MAX_ORBIT_PITCH,
      detail: `target off centre by ${worstCentre.toExponential(2)} ndc, distance by ${worstDist.toExponential(2)} m, pitch at the pole ${pole.pitch.toFixed(4)}`,
    });
  }

  // PAN carries the grabbed point with the pointer: head on, a point ON THE
  // GAMEPLAY PLANE (the target is on it, so it is at the target's depth); turned
  // and off the plane, a point at the target's depth, through both lenses.
  {
    const from = { x: 0.31, y: -0.42 };
    const to = { x: -0.18, y: 0.27 };
    let worst = 0;
    const flat = poseFromCamera(camera(13.5, -7.25, 2));
    const c0 = posedCamera(flat, aspect);
    const grabbed = unprojectToPlane(c0, from.x, from.y)!;
    const c1 = posedCamera(pan(flat, aspect, from, to), aspect);
    const q = ndc(c1, { x: grabbed.x, y: threeY(grabbed.y), z: 0 });
    worst = Math.max(worst, Math.abs(q.x - to.x), Math.abs(q.y - to.y));
    for (const ortho of [false, true]) {
      const { right, up } = poseBasis(free);
      const u = from.x * free.halfHeight * aspect;
      const v = from.y * free.halfHeight;
      const t = free.target;
      const p = { x: t.x + right.x * u + up.x * v, y: t.y + right.y * u + up.y * v, z: t.z + right.z * u + up.z * v };
      const before = ndc(posedCamera(free, aspect, ortho), p);
      const after = ndc(posedCamera(pan(free, aspect, from, to), aspect, ortho), p);
      worst = Math.max(worst, Math.abs(before.x - from.x), Math.abs(before.y - from.y));
      worst = Math.max(worst, Math.abs(after.x - to.x), Math.abs(after.y - to.y));
    }
    out.push({
      name: "visuals: pan keeps the grabbed point under the pointer",
      pass: worst <= 1e-9,
      detail: `worst ${worst.toExponential(2)} ndc`,
    });
  }

  // DOLLY toward a point keeps that point where it is on screen (it is a zoom
  // about the cursor), moves the eye along the ray through it, and never
  // through it - clamped at the near limit, the point is still in front.
  {
    let worstScreen = 0;
    let worstRay = 0;
    let clamped = true;
    for (const ortho of [false, true]) {
      const c0 = posedCamera(free, aspect, ortho);
      const hitSim = unprojectToPlane(c0, 0.3, -0.2)!;
      const hit = { x: hitSim.x, y: threeY(hitSim.y), z: 0 };
      const before = ndc(c0, hit);
      for (const factor of [0.5, 1.7, 1e-6]) {
        const after = dolly(free, hit, factor);
        const c1 = posedCamera(after, aspect, ortho);
        const q = ndc(c1, hit);
        worstScreen = Math.max(worstScreen, Math.abs(q.x - before.x), Math.abs(q.y - before.y));
        if (!ortho) {
          // The old eye, the new eye and the point are on one line.
          const a = new THREE.Vector3().subVectors(c0.position, new THREE.Vector3(hit.x, hit.y, hit.z));
          const b = new THREE.Vector3().subVectors(c1.position, new THREE.Vector3(hit.x, hit.y, hit.z));
          worstRay = Math.max(worstRay, a.clone().normalize().cross(b.clone().normalize()).length());
          if (b.dot(a) <= 0) clamped = false;
        }
        if (factor === 1e-6) {
          clamped &&= Math.abs(poseDistance(after) - MIN_VIEW_DISTANCE) <= 1e-12 && q.z > -1 && q.z < 1;
        }
      }
    }
    out.push({
      name: "visuals: dolly keeps the point under the pointer on its ray, and never passes it",
      pass: worstScreen <= 1e-9 && worstRay <= 1e-9 && clamped,
      detail: `screen drift ${worstScreen.toExponential(2)} ndc, off the ray ${worstRay.toExponential(2)}, clamped ${clamped}`,
    });
  }

  // FRAME puts a box's centre at the centre of the frame and all of it in it.
  {
    const box = { min: { x: -3, y: 1, z: -2 }, max: { x: 5, y: 4.5, z: 0.5 } };
    const framed = frame(free, box, aspect);
    const c = posedCamera(framed, aspect);
    let inside = true;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const q = ndc(c, { x, y, z });
          inside &&= Math.abs(q.x) < 1 && Math.abs(q.y) < 1;
        }
      }
    }
    const centre = ndc(c, { x: 1, y: 2.75, z: -0.75 });
    out.push({
      name: "visuals: frame centres a box and holds all of it",
      pass: inside && Math.abs(centre.x) <= 1e-9 && Math.abs(centre.y) <= 1e-9,
      detail: `corners inside ${inside}, centre at (${centre.x.toExponential(1)}, ${centre.y.toExponential(1)})`,
    });
  }

  // UNPROJECT under a free pose: a point drawn on the gameplay plane, or on a
  // plane `z` off it, comes back as itself - which is what every plane click
  // in the workspace stands on.
  {
    let worst = 0;
    for (const ortho of [false, true]) {
      const c = posedCamera(free, aspect, ortho);
      for (const z of [0, 1.2, -0.6]) {
        for (const p of [new Vec2(4.1, 2.3), new Vec2(7.9, 0.4), new Vec2(1.2, 5.5)]) {
          const q = ndc(c, { x: p.x, y: threeY(p.y), z });
          const back = unprojectToPlane(c, q.x, q.y, z);
          worst = Math.max(worst, back ? back.sub(p).length() : Infinity);
        }
      }
    }
    out.push({
      name: "visuals: a screen point un-projects onto the plane it was drawn from under a free pose",
      pass: worst <= 1e-9,
      detail: `worst round trip ${worst.toExponential(2)} m`,
    });
  }
  return out;
}

// THE GUIDES (`editor/visuals/guides.ts`): what the workspace draws into the
// scene for a small model, counted by the tags the picks will come back with,
// and one pick of each kind run through a real raycast. Headless: three's fat
// lines and the data-texture sprites need no DOM.
function visualsGuides(): CaseResult[] {
  const out: CaseResult[] = [];
  const model = modelFromDisk({
    player: { x: -600, y: -300, radius: 20 },
    bodies: [
      { kind: "static", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 400, h: 60 } },
      {
        kind: "static",
        x: 300,
        y: -200,
        rot: 0,
        objects: [
          {
            type: "collision",
            shape: {
              kind: "poly",
              verts: [
                { x: -60, y: -40 },
                { x: 60, y: -40 },
                { x: 80, y: 30 },
                { x: 0, y: 10 },
                { x: -70, y: 40 },
              ],
            },
          },
        ],
      },
      {
        kind: "static",
        x: -300,
        y: -150,
        rot: 0,
        objects: [{ type: "light", range: 300, wake: 120, z: 40 }],
      },
    ],
  } as RawLevelData);
  const poly = model.items.find((i) => i.shape.kind === "poly")!;
  const rect = model.items.find((i) => i.object === "collision" && i.shape.kind === "rect")!;
  const light = model.items.find((i) => i.object === "light")!;
  const all = new Set<EdLayer>(ED_LAYERS);
  const view = (over: Partial<GuideView> = {}): GuideView => ({
    model,
    rev: 1,
    selectedIds: new Set([poly.id]),
    selectedBodyIds: new Set(),
    selectedVerts: new Set([1]),
    visibleLayers: all,
    lockedLayers: new Set(),
    ...over,
  });
  const guides = new Guides();
  const rebuilt = guides.sync(view());
  const again = guides.sync(view());
  const tags = guides.tags();
  const count = (g: GuideTag["guide"], id?: number): number =>
    tags.filter((t) => t.guide === g && (id === undefined || t.id === id)).length;
  const vertIdx = tags.filter((t) => t.guide === "vertex").map((t) => t.index);
  const vertexSprites = guides.named("vertex") as THREE.Sprite[];
  const pickedLooks = new Set(vertexSprites.map((s) => s.material)).size;
  const collisions = model.items.filter((i) => i.object === "collision").length;
  out.push({
    name: "visuals: the guides of a small model - an outline per collision object, the selected polygon's corners and midpoints, a light's icon and rings, the spawn",
    pass:
      rebuilt &&
      !again &&
      count("outline") === collisions &&
      count("outline", rect.id) === 1 &&
      count("vertex", poly.id) === 5 &&
      vertIdx.join(",") === "0,1,2,3,4" &&
      count("midpoint", poly.id) === 5 &&
      pickedLooks === 2 &&
      count("light", light.id) === 1 &&
      guides.named("light-icon").length === 1 &&
      guides.named("light-reach").length === 1 &&
      guides.named("light-wake").length === 1 &&
      guides.named("light-stalk").length === 1 &&
      count("spawn", SPAWN_GUIDE_ID) === 1 &&
      tags.every(isGuideTag),
    detail: `rebuilt ${rebuilt}, rebuilt again unchanged ${again}; outlines ${count("outline")} of ${collisions}, vertices ${count("vertex", poly.id)} [${vertIdx.join(",")}] in ${pickedLooks} looks, midpoints ${count("midpoint", poly.id)}, light icons ${count("light", light.id)} with reach/wake/stalk ${guides.named("light-reach").length}/${guides.named("light-wake").length}/${guides.named("light-stalk").length}, spawn ${count("spawn", SPAWN_GUIDE_ID)}`,
  });

  // A hidden layer draws nothing; a locked one draws and answers no pick; no
  // selection, no handles.
  guides.sync(view({ visibleLayers: new Set<EdLayer>(["camera", "fireflies", "notes"]) }));
  const hidden = guides.tags().length + guides.named("outline").length;
  guides.sync(view({ lockedLayers: new Set<EdLayer>(["scene"]) }));
  const lockedTags = guides.tags().length;
  const lockedDrawn = guides.named("outline").length;
  guides.sync(view({ selectedIds: new Set() }));
  const unselected = guides.tags().filter((t) => t.guide === "vertex" || t.guide === "midpoint").length;
  out.push({
    name: "visuals: guides follow the layers - hidden draws nothing, locked draws but is not picked - and handles follow the selection",
    pass: hidden === 0 && lockedTags === 0 && lockedDrawn === collisions && unselected === 0,
    detail: `hidden ${hidden} objects, locked ${lockedDrawn} outlines with ${lockedTags} tags, handles with nothing selected ${unselected}`,
  });

  // A PICK through a real raycast, as `Scene3D.pick` casts it: the selected
  // polygon's corner under its own pixel, and the rect's outline under a point
  // on its top edge, from a turned view.
  //
  // Both lenses, since a pixel-sized sprite is sized by different arithmetic
  // through each (see `Guides.update`), and a handle a few pixels off the
  // corner it is drawn at is the one kind of wrong a picture does not show.
  guides.sync(view());
  const pose: ViewPose = { ...poseFromCamera(camera(1, -1, 2)), yaw: 0.35, pitch: 0.25 };
  const aspect = VIEW_WIDTH / VIEW_HEIGHT;
  const corner = poly.pos.add((poly.shape as { verts: Vec2[] }).verts[2]!);
  const verdicts: string[] = [];
  let picksOk = true;
  for (const ortho of [false, true]) {
    const cam = posedCamera(pose, aspect, ortho);
    guides.setResolution(VIEW_WIDTH, VIEW_HEIGHT);
    guides.update(cam, VIEW_HEIGHT);
    guides.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    // Pointer at `p`, nudged `dx` view pixels right.
    const pickAt = (p: Vec2, dx = 0): GuideTag[] => {
      const q = new THREE.Vector3(p.x, threeY(p.y), 0).project(cam);
      ray.setFromCamera(new THREE.Vector2(q.x + (dx * 2) / VIEW_WIDTH, q.y), cam);
      return ray
        .intersectObject(guides.group, true)
        .map((h) => h.object.userData["pickTag"] as unknown)
        .filter(isGuideTag);
    };
    const isCorner = (t: GuideTag): boolean => t.guide === "vertex" && t.id === poly.id && t.index === 2;
    const atCorner = pickAt(corner);
    // Inside the 10 px sprite, and just outside it.
    const inside = pickAt(corner, 4).some(isCorner);
    const outside = pickAt(corner, 7).some(isCorner);
    const onEdge = pickAt(rect.pos.add(new Vec2(-1.1, -0.3)));
    const ok =
      atCorner.some(isCorner) &&
      !atCorner.some((t) => t.guide === "vertex" && t.index !== 2) &&
      inside &&
      !outside &&
      onEdge.some((t) => t.guide === "outline" && t.id === rect.id);
    picksOk &&= ok;
    verdicts.push(
      `${ortho ? "ortho" : "persp"}: corner -> ${JSON.stringify(atCorner)}, 4 px off ${inside}, 7 px off ${outside}; edge -> ${JSON.stringify(onEdge)}`,
    );
  }
  out.push({
    name: "visuals: a raycast picks a corner by its pixel-sized handle and a body by its outline, from a turned view",
    pass: picksOk,
    detail: verdicts.join("; "),
  });

  // A tool's draft: an open run to the cursor, then closed, then gone.
  guides.setDraft({ points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0.2, normal: { x: 0, y: 0, z: 1 } }], closed: false, cursor: { x: 0, y: 1, z: 0 } });
  const open = guides.draftCounts();
  guides.setDraft({ points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }], closed: true });
  const closed = guides.draftCounts();
  guides.setDraft(null);
  const none = guides.draftCounts();
  out.push({
    name: "visuals: a draft draws its placed points and its run to the cursor, closes, and clears",
    pass: open.segments === 3 && open.points === 3 && closed.segments === 3 && none.segments === 0 && none.points === 0,
    detail: `open ${JSON.stringify(open)}, closed ${JSON.stringify(closed)}, cleared ${JSON.stringify(none)}`,
  });

  // What a drag costs per frame: the grid is built once and survives the
  // revisions of a drag that stays inside the level's major cells, and is
  // built again only when the extent crosses one; the draft signature is a
  // number that tells a moved cursor from a still one; the painted loop hands
  // back one draft object until a point or its cursor changes.
  const gridBefore = guides.gridBuilds;
  const home = poly.pos;
  for (let rev = 2; rev < 12; rev++) {
    poly.pos = home.add(new Vec2(rev * 0.01, 0));
    guides.sync(view({ rev }));
  }
  const dragBuilds = guides.gridBuilds - gridBefore;
  // A body 100 m out widens the level by many cells.
  poly.pos = home.add(new Vec2(100, 0));
  guides.sync(view({ rev: 99 }));
  const farBuilds = guides.gridBuilds - gridBefore;
  poly.pos = home;
  guides.sync(view({ rev: 100 }));
  const gridPasses = guides.named("grid-major").length;
  const draftA = { points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], closed: false, cursor: { x: 0.5, y: 1, z: 0 } };
  const sameSig = draftSignature(draftA) === draftSignature({ ...draftA, points: [...draftA.points], cursor: { x: 0.5, y: 1, z: 0 } });
  const movedSig = draftSignature(draftA) !== draftSignature({ ...draftA, cursor: { x: 0.5, y: 1.001, z: 0 } });
  const loop = new SurfaceLoop();
  const n = new THREE.Vector3(0, 1, 0);
  loop.add({ point: new THREE.Vector3(0, 0, 0), normal: n, hostId: 1 });
  loop.cursor = new THREE.Vector3(1, 0, 0);
  const d1 = loop.draft();
  loop.cursor = new THREE.Vector3(1, 0, 0);
  const kept = loop.draft() === d1;
  loop.cursor = new THREE.Vector3(1, 0, 0.5);
  const renewed = loop.draft() !== d1 && loop.draft()?.cursor?.z === 0.5;
  const ok = dragBuilds === 0 && farBuilds === 1 && gridPasses === 1 && sameSig && movedSig && kept && renewed;
  out.push({
    name: "visuals: a drag rebuilds the outlines but not the grid (rebuilt only when the level's extent crosses a cell), and a still draft is not rebuilt",
    pass: ok,
    detail: JSON.stringify({ dragBuilds, farBuilds, gridPasses, sameSig, movedSig, kept, renewed }),
  });
  guides.dispose();
  return out;
}

// THE VISUALS WORKSPACE IN THE EDITOR (plans/visuals-workspace.md, Phase 4):
// the controller's pose bookkeeping, which guide a click means, and the drop
// on surface's arithmetic. The editor's wiring - the press handler, the
// gizmo, the frame loop - needs the page and is verified there.
function visualsWorkspace(): CaseResult[] {
  const out: CaseResult[] = [];
  const same = (a: ViewPose | null, b: ViewPose | null): boolean =>
    a !== null &&
    b !== null &&
    Object.is(a.target.x, b.target.x) &&
    Object.is(a.target.y, b.target.y) &&
    Object.is(a.target.z, b.target.z) &&
    Object.is(a.yaw, b.yaw) &&
    Object.is(a.pitch, b.pitch) &&
    Object.is(a.halfHeight, b.halfHeight) &&
    Object.is(a.fovYDeg, b.fovYDeg);

  // SEEDING. The first entry is the Level workspace's view to the bit (so a
  // switch changes nothing on screen), later entries keep the pose that was
  // left, and Reset returns to head-on framing of the 2D camera as it is NOW.
  {
    const editorLayer = new THREE.Group();
    const sceneCam = new THREE.PerspectiveCamera(FOV_Y_DEG, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 1000);
    const handed: (ViewPose | null)[] = [];
    const scene = {
      editorLayer,
      camera: sceneCam,
      setViewPose: (p: ViewPose | null) => handed.push(p),
      pick: () => [],
      pickSurface: () => null,
    } as unknown as WorkspaceScene;
    const cam2d = camera(3.2, -1.4, 1.7);
    const lens: SceneLens = { fovYDeg: 38, zOffset: -0.4 };
    const ws = new VisualsWorkspace({
      scene,
      camera2d: () => cam2d,
      lens: () => lens,
      canvasSize: () => ({ width: VIEW_WIDTH, height: VIEW_HEIGHT }),
    });
    const before = ws.view;
    ws.enter();
    const seeded = ws.view;
    const seededOk = same(seeded, headOn(cam2d, lens)) && handed[handed.length - 1] === seeded;
    // The scene camera is placed at once, exactly where the frame will place it.
    const want = newViewCamera(false);
    applyPose(want, headOn(cam2d, lens), VIEW_WIDTH / VIEW_HEIGHT);
    const placed = cameraBits(sceneCam).every((v, i) => Object.is(v, cameraBits(want)[i]));
    const guidesIn = ws.guides.group.parent === editorLayer;
    // A 50 px drag right and 20 px down orbits at the Level workspace's rate.
    ws.beginView("orbit", new Vec2(400, 300));
    ws.moveView(new Vec2(450, 320));
    ws.endView();
    const turned = ws.view!;
    const turnOk = Object.is(turned.yaw, -50 * ORBIT_RADIANS_PER_PX) && Object.is(turned.pitch, 20 * ORBIT_RADIANS_PER_PX);
    // Leave, move the 2D camera, come back: the pose is the one left behind.
    ws.leave();
    const handedBack = handed[handed.length - 1] === null && ws.guides.group.parent === null;
    cam2d.position = new Vec2(-5, 2);
    ws.enter();
    const kept = same(ws.view, turned);
    ws.resetView();
    const reset = same(ws.view, headOn(cam2d, lens));
    ws.leave();
    ws.guides.dispose();
    out.push({
      name: "visuals: the workspace seeds its pose from the 2D camera to the bit, keeps it across a switch, and Reset re-seeds it",
      pass: before === null && seededOk && placed && guidesIn && turnOk && handedBack && kept && reset,
      detail: `seeded ${seededOk}, camera placed ${placed}, guides in the scene ${guidesIn}, orbit yaw ${turned.yaw.toFixed(3)} pitch ${turned.pitch.toFixed(3)} (${turnOk}), left ${handedBack}, kept ${kept}, reset ${reset}`,
    });
  }

  // WHICH GUIDE A CLICK MEANS. At a corner the outline's segments come back
  // from the raycast at the very depth of the corner's handle, and in build
  // order the outline is first; the handle must win. A midpoint loses to a
  // corner, and a click on an edge away from both is the outline's item.
  {
    const model = modelFromDisk({
      player: { x: -600, y: -300, radius: 20 },
      bodies: [
        {
          kind: "static",
          x: 0,
          y: 0,
          rot: 0,
          objects: [{ type: "collision", shape: { kind: "poly", verts: [{ x: -80, y: -60 }, { x: 80, y: -60 }, { x: 60, y: 50 }, { x: -70, y: 40 }] } }],
        },
      ],
    } as RawLevelData);
    const poly = model.items.find((i) => i.shape.kind === "poly")!;
    const guides = new Guides();
    guides.sync({
      model,
      rev: 1,
      selectedIds: new Set([poly.id]),
      selectedBodyIds: new Set(),
      selectedVerts: new Set(),
      visibleLayers: new Set<EdLayer>(ED_LAYERS),
      lockedLayers: new Set(),
    });
    const pose: ViewPose = { ...poseFromCamera(camera(0, 0, 2)), yaw: -0.4, pitch: 0.3 };
    const cam = posedCamera(pose, VIEW_WIDTH / VIEW_HEIGHT);
    guides.setResolution(VIEW_WIDTH, VIEW_HEIGHT);
    guides.update(cam, VIEW_HEIGHT);
    guides.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const tagsAt = (p: Vec2): unknown[] => {
      const q = new THREE.Vector3(p.x, threeY(p.y), 0).project(cam);
      ray.setFromCamera(new THREE.Vector2(q.x, q.y), cam);
      return ray.intersectObject(guides.group, true).map((h) => h.object.userData["pickTag"] as unknown);
    };
    const verts = (poly.shape as { verts: Vec2[] }).verts.map((v) => poly.pos.add(v));
    const atCorner = tagsAt(verts[1]!);
    const cornerOrder = atCorner.filter(isGuideTag).map((t) => t.guide).join(",");
    const corner = handleUnder(atCorner);
    const atMid = tagsAt(verts[1]!.add(verts[2]!).mul(0.5));
    const mid = handleUnder(atMid);
    const onEdge = tagsAt(verts[0]!.mul(0.3).add(verts[1]!.mul(0.7)));
    const edge = handleUnder(onEdge);
    const edgeItems = itemsUnder(onEdge, new Set());
    // A synthetic list in the worst order: a model first, the outline, the
    // midpoint, then the corner.
    const listed = handleUnder([{}, guideTag("outline", 7), guideTag("midpoint", 7, 2), guideTag("vertex", 7, 3)]);
    const spawnOnly = itemsUnder([guideTag("spawn", SPAWN_GUIDE_ID), guideTag("vertex", 7, 0), guideTag("light", 9)], new Set());
    guides.dispose();
    out.push({
      name: "visuals: a click at a corner means the corner's handle over its outline, a midpoint over nothing, an edge its item",
      pass:
        atCorner.filter(isGuideTag).some((t) => t.guide === "outline") &&
        corner?.guide === "vertex" &&
        corner.index === 1 &&
        mid?.guide === "midpoint" &&
        mid.index === 1 &&
        edge === null &&
        edgeItems.has(poly.id) &&
        listed?.guide === "vertex" &&
        listed.index === 3 &&
        [...spawnOnly].join(",") === "9",
      detail: `corner list [${cornerOrder}] -> ${JSON.stringify(corner)}, midpoint -> ${JSON.stringify(mid)}, edge -> ${JSON.stringify(edge)} items [${[...edgeItems]}], worst-order list -> ${JSON.stringify(listed)}, items past spawn and handles [${[...spawnOnly]}]`,
    });
  }

  // THE DROP ON SURFACE: the origin lands on the hit point (sim frame, z
  // toward the camera), and an aligned prop's up is the face normal, reached by
  // the smallest turn - a prop already standing along the normal is not turned
  // at all, whatever its heading.
  {
    const at = surfacePlacement({ x: 1.25, y: -0.5, z: 0.375 });
    // A float32 face at -0.2 m is written as -0.2, not its interpolation noise.
    const noisy = surfacePlacement({ x: 0, y: 0, z: -0.19999999925494215 });
    const placedOk = at.pos.x === 1.25 && at.pos.y === 0.5 && at.z === 0.375 && noisy.z === -0.2;
    let worst = 0;
    const normals = [
      { x: 0, y: 0, z: 1 },
      { x: 0.6, y: 0.8, z: 0 },
      { x: -0.3, y: 0.2, z: 0.9 },
      { x: 0.1, y: -1, z: 0.05 },
    ];
    const tilts = [
      { rot: 0, rotX: 0, rotY: 0 },
      { rot: 0.7, rotX: 0.2, rotY: -0.4 },
      { rot: -2.1, rotX: -0.6, rotY: 0.3 },
    ];
    for (const t of tilts) {
      for (const n of normals) {
        const len = Math.hypot(n.x, n.y, n.z);
        const up = upOf(alignUp(t, n));
        worst = Math.max(worst, Math.abs(up.x - n.x / len), Math.abs(up.y - n.y / len), Math.abs(up.z - n.z / len));
      }
    }
    // Already along the normal: the heading survives exactly (to rounding).
    const t0 = { rot: 0.9, rotX: 0.25, rotY: -0.15 };
    const kept = alignUp(t0, upOf(t0));
    const keptErr = Math.max(Math.abs(kept.rot - t0.rot), Math.abs(kept.rotX - t0.rotX), Math.abs(kept.rotY - t0.rotY));
    // A level floor: a prop stood on it is upright - no turn in the plane
    // (`rot`) and no tip (`rotX`) - with its heading about its own up in
    // `rotY`, which is where the composition keeps a heading.
    const floor = alignUp({ rot: 1.1, rotX: 0.4, rotY: 0.2 }, { x: 0, y: 1, z: 0 });
    const floorOk = Math.abs(floor.rot) < 1e-12 && Math.abs(floor.rotX) < 1e-12;
    out.push({
      name: "visuals: a drop on a surface stands the origin on the hit and turns a prop's up onto the normal by the smallest turn",
      // Radians: 1e-7, not 1e-12, because the composition's gimbal is at
      // rotX = 90 degrees - a prop's up pointing straight at the camera, which
      // is a drop on the front of a wall - where `asin` hands back half the
      // digits. A tenth of a micron at a metre.
      pass: placedOk && worst < 1e-7 && keptErr < 1e-12 && floorOk,
      detail: `placed ${placedOk}, worst up error ${worst.toExponential(2)} over ${tilts.length * normals.length} tilts x normals, re-aligning changes a standing prop by ${keptErr.toExponential(2)}, on a floor rotX ${floor.rotX.toExponential(2)} rotY ${floor.rotY.toExponential(2)} rot ${floor.rot.toFixed(3)}`,
    });
  }

  // A MOVE THROUGH Z writes the new depth outright. Decoration authoring no
  // `offsetZ` is drawn at DECOR_Z, and the gizmo (and the drop, which goes
  // through the gizmo's handlers) used to write the displacement into the
  // field as if it were relative, which jumped the object 35 cm toward the
  // camera on the first touch of the blue arrow.
  {
    const up = offsetZAfterMove(0, DECOR_Z, DECOR_Z + 0.1);
    const sideways = offsetZAfterMove(0, DECOR_Z, DECOR_Z);
    const authored = offsetZAfterMove(0.4, 0.4, 0.6);
    out.push({
      name: "visuals: a move through z leaves a fallen-back depth alone sideways and writes the new depth outright",
      pass: Math.abs(up - (DECOR_Z + 0.1)) < 1e-12 && sideways === 0 && authored === 0.6,
      detail: `decor moved 10 cm toward the camera -> offsetZ ${up.toFixed(3)} (drawn at ${DECOR_Z} before), moved sideways -> ${sideways}, authored 0.4 -> 0.6 gives ${authored}`,
    });
  }

  // **F**'s box: a light by its source at its own z (not its reach), a drawn
  // object by its extrusion either side of the depth it is drawn at.
  {
    const model = modelFromDisk({
      player: { x: 0, y: 0, radius: 20 },
      bodies: [
        { kind: "static", x: 100, y: 0, rot: 0, objects: [{ type: "light", range: 400, z: 60 }] },
        {
          kind: "static",
          x: -200,
          y: 0,
          rot: 0,
          objects: [{ type: "geometry", z: -100, depth: 40, shape: { kind: "rect", w: 50, h: 20 } }],
        },
      ],
    } as RawLevelData);
    const light = model.items.find((i) => i.object === "light")!;
    const prop = model.items.find((i) => i.object === "geometry")!;
    const lb = itemsBox(model, [light])!;
    const pb = itemsBox(model, [prop])!;
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
    const ok =
      near(lb.min.x, 1) && near(lb.max.x, 1) && near(lb.min.z, 0.6) && near(lb.max.z, 0.6) &&
      near(pb.min.x, -2.25) && near(pb.max.x, -1.75) && near(pb.min.y, -0.1) && near(pb.max.y, 0.1) &&
      near(pb.min.z, -1.2) && near(pb.max.z, -0.8) &&
      itemsBox(model, []) === null;
    out.push({
      name: "visuals: F frames a light by its source at its z and a drawn object by its extrusion about its depth",
      pass: ok,
      detail: `light ${JSON.stringify(lb)}, prop ${JSON.stringify(pb)}`,
    });
  }
  return out;
}

// The extrusion's winding and depth. A physics polygon is wound clockwise ON
// SCREEN with y down (see engine/shapes.ts); after the y-negation that is
// counter-clockwise in three's frame, which is the winding `ExtrudeGeometry`
// needs for its front faces to point at +z. Get it wrong and the prop renders
// unlit and inside out - visible, but only as "the materials look broken".
function extrusionGeometry(): CaseResult[] {
  const out: CaseResult[] = [];
  const half = new Vec2(1, 0.5);
  const geo = extrudeOutline({ kind: "rect", half }, { depth: 0.4, bevel: 0 });
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  // Centred on the gameplay plane and the authored size, with y negated (a rect
  // is symmetric, so this is about the extent rather than the sign) and the
  // depth split either side of z = 0. Geometry attributes are float32, so the
  // tolerance is float32 epsilon at this magnitude rather than float64's.
  const sizeOk =
    Math.abs(bb.min.x + 1) < F32 &&
    Math.abs(bb.max.x - 1) < F32 &&
    Math.abs(bb.min.y + 0.5) < F32 &&
    Math.abs(bb.max.y - 0.5) < F32 &&
    Math.abs(bb.min.z + 0.2) < F32 &&
    Math.abs(bb.max.z - 0.2) < F32;
  out.push({
    name: "extrude: rect is authored size, centred on the plane",
    pass: sizeOk,
    detail: `bbox (${bb.min.x},${bb.min.y},${bb.min.z}) .. (${bb.max.x},${bb.max.y},${bb.max.z})`,
  });

  // The front cap must face the camera. Its normals are the first thing a wrong
  // winding flips, and a flipped cap is the whole prop in shadow.
  const normals = geo.getAttribute("normal");
  let frontFacing = 0;
  let backFacing = 0;
  const pos = geo.getAttribute("position");
  for (let i = 0; i < normals.count; i++) {
    if (Math.abs(pos.getZ(i) - 0.2) > F32) continue; // front cap only
    if (normals.getZ(i) > 0.9) frontFacing++;
    if (normals.getZ(i) < -0.9) backFacing++;
  }
  out.push({
    name: "extrude: front cap faces +z (toward the camera)",
    pass: frontFacing > 0 && backFacing === 0,
    detail: `${frontFacing} front-facing, ${backFacing} back-facing cap vertices`,
  });

  // A polygon authored in the physics winding must come out the same way up as
  // the rect does: the y-negation is applied to the vertices, so the loop's
  // signed area flips and the outline has to be re-wound for three.
  const tri = extrudeOutline(
    {
      kind: "poly",
      verts: [new Vec2(-1, 1), new Vec2(1, 1), new Vec2(0, -1)],
    },
    { depth: 0.2, bevel: 0 },
  );
  tri.computeBoundingBox();
  const tb = tri.boundingBox!;
  // The apex is at physics y = -1, which is three y = +1: a prop that came out
  // upside down would put it at -1.
  out.push({
    name: "extrude: poly keeps its orientation through the y-negation",
    pass: Math.abs(tb.max.y - 1) < F32 && Math.abs(tb.min.y + 1) < F32,
    detail: `y extent ${tb.min.y} .. ${tb.max.y}`,
  });

  const triNormals = tri.getAttribute("normal");
  const triPos = tri.getAttribute("position");
  let triFront = 0;
  let triBack = 0;
  for (let i = 0; i < triNormals.count; i++) {
    if (Math.abs(triPos.getZ(i) - 0.1) > F32) continue;
    if (triNormals.getZ(i) > 0.9) triFront++;
    if (triNormals.getZ(i) < -0.9) triBack++;
  }
  out.push({
    name: "extrude: poly front cap faces +z",
    pass: triFront > 0 && triBack === 0,
    detail: `${triFront} front-facing, ${triBack} back-facing cap vertices`,
  });

  // A BEVELLED solid must be CONTAINED by the outline it states, and this is the
  // case the two above cannot make: both ask for `bevel: 0`, and the default
  // bevel ran from the outline OUTWARD, so every drawn body stood 2 cm proud of
  // its own shape on all four sides. On a floor that is a slab 2 cm taller than
  // the collision box the ball rests on, seen as the ball sinking into the
  // ground - which no test here could see and no invariant ever will, the sim
  // being entirely correct throughout.
  const broken = extrudeOutline({ kind: "rect", half }, { depth: 0.4 });
  broken.computeBoundingBox();
  const kb = broken.boundingBox!;
  const contained =
    Math.abs(kb.min.x + 1) < F32 &&
    Math.abs(kb.max.x - 1) < F32 &&
    Math.abs(kb.min.y + 0.5) < F32 &&
    Math.abs(kb.max.y - 0.5) < F32 &&
    Math.abs(kb.min.z + 0.2) < F32 &&
    Math.abs(kb.max.z - 0.2) < F32;
  out.push({
    name: "extrude: a bevelled solid is contained by the outline it states",
    pass: contained,
    detail: `bbox (${kb.min.x},${kb.min.y},${kb.min.z}) .. (${kb.max.x},${kb.max.y},${kb.max.z}) for a 2x1x0.4 shape`,
  });

  // A circle extrudes to a disc of the authored radius, not to its bounding box.
  const disc = extrudeOutline({ kind: "circle", radius: 0.35 }, { depth: 0.1, bevel: 0 });
  disc.computeBoundingBox();
  const db = disc.boundingBox!;
  const r = Math.max(db.max.x, db.max.y);
  out.push({
    name: "extrude: circle radius survives",
    pass: Math.abs(r - 0.35) < 2e-3,
    detail: `radius ${r.toFixed(5)} (curve-sampled, so a hair under 0.35)`,
  });

  // ...and an authored circle is drawn as a CYLINDER rather than as that
  // extrusion, which is a different solid only in its shading - so what is
  // checked here is the two things that are not shading: it is the authored
  // radius and the authored depth, both to the surface rather than to a
  // circumscribed box.
  const cyl = cylinderSolid(0.35, 0.1);
  cyl.computeBoundingBox();
  const cb = cyl.boundingBox!;
  const cylOk =
    Math.abs(Math.max(cb.max.x, cb.max.y) - 0.35) < F32 &&
    Math.abs(cb.min.z + 0.05) < F32 &&
    Math.abs(cb.max.z - 0.05) < F32;
  out.push({
    name: "extrude: an authored circle is a cylinder of that radius and depth",
    pass: cylOk,
    detail: `radius ${Math.max(cb.max.x, cb.max.y).toFixed(5)}, z ${cb.min.z.toFixed(5)}..${cb.max.z.toFixed(5)}`,
  });

  // A SIDE WALL'S TEXTURE MUST STAND UP THE WAY THE CAP'S DOES. A texture's own
  // u is horizontal, so a side wall that hands u to the along-edge distance maps
  // the picture's horizontal onto world-vertical on every vertical edge: the
  // left and right returns of a wall - which is most of what an author sees of a
  // pillar or a doorway - draw their brick courses running up the wall instead
  // of across it. It is invisible to every other check here, the solid being the
  // right size, wound the right way and lit correctly throughout.
  const faceUVs = (g: THREE.BufferGeometry, nx: number, ny: number) => {
    const n = g.getAttribute("normal");
    const p = g.getAttribute("position");
    const t = g.getAttribute("uv");
    const hits: { x: number; y: number; z: number; u: number; v: number }[] = [];
    for (let i = 0; i < n.count; i++) {
      if (Math.abs(n.getX(i) - nx) > 1e-3 || Math.abs(n.getY(i) - ny) > 1e-3) continue;
      hits.push({ x: p.getX(i), y: p.getY(i), z: p.getZ(i), u: t.getX(i), v: t.getY(i) });
    }
    return hits;
  };
  // The right return of the 2 x 1 x 0.4 rect: v is world y (upright, and the same
  // number the cap beside it carries), u is the depth.
  const right = faceUVs(geo, 1, 0);
  const uprightOk =
    right.length > 0 && right.every((h) => Math.abs(h.v - h.y) < F32 && Math.abs(h.u - h.z) < F32);
  out.push({
    name: "extrude: a vertical side wall's texture stands up like the cap's",
    pass: uprightOk,
    detail: `${right.length} vertices on +x; ${right.map((h) => `y=${h.y.toFixed(2)} uv=(${h.u.toFixed(2)},${h.v.toFixed(2)})`).join(" ")}`,
  });
  // ...and the top face is the same statement about the other axis: u is world x,
  // so a texture crossing the top edge does not jump.
  const top = faceUVs(geo, 0, 1);
  const topOk =
    top.length > 0 && top.every((h) => Math.abs(h.u - h.x) < F32 && Math.abs(h.v - h.z) < F32);
  out.push({
    name: "extrude: a horizontal side wall's u is world x, continuous with the cap",
    pass: topOk,
    detail: `${top.length} vertices on +y; ${top.map((h) => `x=${h.x.toFixed(2)} uv=(${h.u.toFixed(2)},${h.v.toFixed(2)})`).join(" ")}`,
  });
  // A DIAGONAL EDGE IS MEASURED ALONG ITSELF, which is the half three's own
  // generator gets wrong: it reads u off whichever world axis varies more, so a
  // wall at 45 degrees gets the projected extent rather than the surface it
  // actually has and its texture is squashed by 1/sqrt(2). The triangle's right
  // edge runs (1,-1) to (0,1) in three's frame - 2 units of y across sqrt(5) of
  // surface - so its own axis must span the sqrt(5).
  const slope = faceUVs(tri, 2 / Math.sqrt(5), 1 / Math.sqrt(5));
  const spanV = slope.length
    ? Math.max(...slope.map((h) => h.v)) - Math.min(...slope.map((h) => h.v))
    : 0;
  out.push({
    name: "extrude: a diagonal side wall is tiled by surface travelled, not by extent",
    pass: Math.abs(spanV - Math.sqrt(5)) < F32,
    detail: `v spans ${spanV.toFixed(5)} m over an edge of ${Math.sqrt(5).toFixed(5)} m (projected extent is 2)`,
  });

  // A CHAMFER IS THE CAP UNROLLED, and both halves of that are invisible to
  // every check above - the solid is the authored size, contained by its
  // outline, wound the right way and lit correctly however its rim is tiled.
  //
  // Three lays its bevel out as a quarter-round, and the ring nearest the cap
  // covers most of the arc while advancing almost nothing through z: measuring
  // the rim by depth therefore compressed that band to 37% of its own surface
  // and the band beyond it to 90%, so the rim read as two mismatched stripes
  // smeared round the edge of every bevelled solid in the level.
  // The same 2 x 1 rect with a vertex half way along its top and bottom edges,
  // because a bare rect has no vertex that is not a corner. What the rim does AT
  // a corner is its own question - the outward direction there is the bisector,
  // which is longer than the edge normal by 1/cos of the turn - and what is
  // asserted here is the edge, where the two are the same thing.
  const rim = extrudeOutline(
    {
      kind: "poly",
      verts: [
        new Vec2(-1, -0.5),
        new Vec2(0, -0.5),
        new Vec2(1, -0.5),
        new Vec2(1, 0.5),
        new Vec2(0, 0.5),
        new Vec2(-1, 0.5),
      ],
    },
    { depth: 0.4, bevel: 0.1 },
  );
  const bevel = 0.1;
  const coreHalf = 0.4 / 2 - bevel;
  // The cap ring and the cap's own vertices are the SAME points, so the seam
  // between them is whether they carry the same uv. Zero at the join is what
  // makes the unroll an extension of the cap rather than a second mapping
  // beside it.
  const capPlane = coreHalf + bevel;
  const rp = rim.getAttribute("position");
  const rt = rim.getAttribute("uv");
  const capRing: { x: number; y: number; du: number; dv: number }[] = [];
  for (let i = 0; i < rp.count; i++) {
    if (Math.abs(Math.abs(rp.getZ(i)) - capPlane) > F32) continue;
    capRing.push({
      x: rp.getX(i),
      y: rp.getY(i),
      du: rt.getX(i) - rp.getX(i),
      dv: rt.getY(i) - rp.getY(i),
    });
  }
  const worstSeam = capRing.reduce((m, h) => Math.max(m, Math.abs(h.du), Math.abs(h.dv)), 0);
  out.push({
    name: "extrude: a chamfer carries the cap's texture off the face with no seam",
    pass: capRing.length > 0 && worstSeam < F32,
    detail: `${capRing.length} vertices on the cap plane, worst uv offset from (x, y) ${worstSeam.toExponential(2)} m`,
  });

  // ...and past the join the rim is measured by the ARC it travels rather than
  // by the depth it crosses, which is the half that stops the stretch. Read on
  // the middle of the top edge, away from the corners, where the outward
  // direction is the edge's own normal: `v` there is the cap's own y at the
  // ring, carried outward by the arc swept to reach this point.
  const rn = rim.getAttribute("normal");
  const band: { z: number; v: number; want: number }[] = [];
  for (let i = 0; i < rp.count; i++) {
    const z = rp.getZ(i);
    // On the rim of the top strip, and clear of the corners the bisector turns.
    // A cap's triangles face straight down z and the straight wall's straight
    // along y, so the rim is exactly what lies between the two - which is also
    // what takes the junction ring from the last chamfer quad rather than from
    // the wall quad beside it, those being the two sides of the one seam.
    if (Math.abs(z) < coreHalf - F32) continue;
    if (rn.getY(i) < 0.1 || rn.getY(i) > 0.999) continue;
    if (Math.abs(rp.getX(i)) > F32) continue;
    const phi = Math.acos(Math.min(1, Math.max(0, (Math.abs(z) - coreHalf) / bevel)));
    band.push({ z, v: rt.getY(i), want: half.y - bevel + bevel * phi });
  }
  const worstArc = band.reduce((m, h) => Math.max(m, Math.abs(h.v - h.want)), 0);
  const bandSpan = band.length
    ? Math.max(...band.map((h) => h.v)) - Math.min(...band.map((h) => h.v))
    : 0;
  out.push({
    name: "extrude: a chamfer is tiled by the arc it sweeps, not by the depth it crosses",
    pass: band.length > 0 && worstArc < F32 && Math.abs(bandSpan - (bevel * Math.PI) / 2) < F32,
    detail:
      `${band.length} rim vertices; worst ${worstArc.toExponential(2)} m off the unrolled arc; ` +
      `v spans ${bandSpan.toFixed(5)} m over an arc of ${((bevel * Math.PI) / 2).toFixed(5)} m ` +
      `(the depth it crosses is ${bevel.toFixed(5)})`,
  });
  return out;
}

// A GEOMETRY OBJECT DRAWN THROUGH ITS OWN LENS (`GeometryObjectData.projection`).
//
// Every way this breaks is silent in the picture's favour - the object is simply
// drawn in perspective, which is what it looked like before anyone asked - so
// each link in the chain is asserted: the field survives the px -> m gate and the
// editor's save, the mounted mesh wears an orthographic twin that compiles to a
// program of its own, the twin's hook actually finds the chunk it rewrites in
// three's shader (a renamed chunk is a `replace` that matches nothing), and the
// editor's selection highlight - a clone - keeps the lens rather than moving the
// selected object back to where perspective would put it.
function perObjectProjection(): CaseResult[] {
  const geometry = (projection?: GeometryProjection): GeometryObjectData => ({
    type: "geometry",
    shape: { kind: "rect", w: 1, h: 1 },
    // A flat fill, for the reason `tippedPrimitive` gives: it builds headlessly.
    texture: SOLID_SURFACE,
    color: "#ff0000",
    ...(projection ? { projection } : {}),
  });
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        objects: [
          { ...geometry("orthographic"), shape: { kind: "rect", w: 100, h: 100 }, z: -300 },
          { ...geometry(), shape: { kind: "rect", w: 100, h: 100 } },
        ],
      },
    ],
  };
  const scaled = scaleLevelData(authored, 1 / PIXELS_PER_METER).bodies[0]!.objects.filter(isGeometryObject);
  const scaledKept = scaled[0]?.projection === "orthographic" && scaled[1]?.projection === undefined;
  const saved = modelToDisk(modelFromDisk(authored)).bodies[0]!.objects.filter(isGeometryObject);
  const savedKept = saved[0]?.projection === "orthographic" && !("projection" in (saved[1] ?? {}));

  const mount = (projection?: GeometryProjection): THREE.Mesh => {
    const parent = new THREE.Group();
    mountVisual(
      parent,
      () => extrudeOutline({ kind: "rect", half: new Vec2(0.5, 0.5) }, { depth: 0.2, bevel: 0 }),
      { geometry: geometry(projection) },
      { defaultZ: 0, castShadow: true, alive: () => true },
    );
    return parent.children[0] as THREE.Mesh;
  };
  const ortho = mount("orthographic");
  const orthoAgain = mount("orthographic");
  const persp = mount();
  const om = ortho.material as THREE.Material;
  const pm = persp.material as THREE.Material;
  const twinned =
    isOrthographicMaterial(om) &&
    !isOrthographicMaterial(pm) &&
    om !== pm &&
    orthoAgain.material === om &&
    om.customProgramCacheKey() !== pm.customProgramCacheKey() &&
    !ortho.frustumCulled &&
    persp.frustumCulled;

  const patchedText = (m: THREE.Material): string => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    return shader.vertexShader;
  };
  const rewrites = (m: THREE.Material): boolean => patchedText(m).includes("orthoPosition");
  const patched = rewrites(om) && !rewrites(pm);
  const highlight = cloneWithPatches(om);
  const highlightKept =
    isOrthographicMaterial(highlight) &&
    rewrites(highlight) &&
    highlight.customProgramCacheKey() === om.customProgramCacheKey();

  return [
    {
      name: "format: a geometry object's projection survives the px -> m gate and an editor save",
      pass: scaledKept && savedKept,
      detail: `scaled ${scaled.map((g) => g.projection)}, saved ${saved.map((g) => g.projection)}`,
    },
    {
      name: "render: an orthographic object wears one shared twin with a program of its own",
      pass: twinned,
      detail: `tagged ${isOrthographicMaterial(om)}, shared ${orthoAgain.material === om}, keys ${om.customProgramCacheKey()} / ${pm.customProgramCacheKey()}, culled ${ortho.frustumCulled}`,
    },
    {
      name: "render: the orthographic twin rewrites three's projection chunk",
      pass: patched,
      detail: patched ? "project_vertex rewritten for the twin alone" : "the chunk was not found or not rewritten",
    },
    {
      name: "render: a selection highlight keeps an orthographic object's lens",
      pass: highlightKept,
      detail: highlightKept ? "clone carries the tag, the hook and the key" : "the clone lost the patch",
    },
  ];
}

// A PRIMITIVE TIPPED OUT OF THE PLANE (`GeometryObjectData.rotX`/`rotY`).
//
// The two angles were a prop's alone for as long as nothing in the extrusion
// path read them, which is a bug with no symptom: the editor's rings turned, the
// inspector's numbers changed, `visualData` wrote them for a mesh and dropped
// them for a primitive, and the level went on looking exactly as it did. The
// only thing that can catch that class is asserting what `mountVisual` BUILT,
// because every other signal in the project says the pose is fine.
//
// It runs headlessly - which nothing else about a `BodyVisual` does (see
// `pickIndex`) - because a FLAT FILL builds no maps: `buildSurface` returns a
// bare `MeshStandardMaterial` for `SOLID_SURFACE` and never reaches the canvas
// the generated surfaces are drawn on. Any textured object here would need a DOM
// and this case would not exist.
function tippedPrimitive(): CaseResult[] {
  const half = new Vec2(1, 0.2);
  const depth = 0.4;
  const drawnAt = 0.7;
  const rotX = 0.35;
  const rotY = -0.8;
  const mount = (tip: boolean): THREE.Mesh => {
    const parent = new THREE.Group();
    mountVisual(
      parent,
      () => extrudeOutline({ kind: "rect", half }, { depth, bevel: 0 }),
      {
        geometry: {
          type: "geometry",
          shape: { kind: "rect", w: half.x * 2, h: half.y * 2 },
          // A flat fill, for the reason above, and the one surface that needs
          // nothing downloaded either.
          texture: SOLID_SURFACE,
          color: "#ff0000",
          ...(tip ? { rotX, rotY } : {}),
        },
      },
      { defaultZ: drawnAt, castShadow: true, alive: () => true },
    );
    const mesh = parent.children[0] as THREE.Mesh;
    mesh.updateMatrixWorld(true);
    return mesh;
  };

  const tipped = mount(true);
  const flat = mount(false);
  const turned =
    Math.abs(tipped.rotation.x - rotX) < F32 &&
    Math.abs(tipped.rotation.y - rotY) < F32 &&
    // Never z: the piece the object is mounted in carries `rot` (`BodyVisual`'s
    // own child group), so writing it here would turn the thing twice.
    tipped.rotation.z === 0;

  // WHERE THE PIVOT IS. An extrusion is built centred on z, so turning the mesh
  // about its own origin and then placing it at `defaultZ` swings the solid
  // about its MIDDLE and leaves that middle at the depth the object is drawn at.
  // Turning it about the piece's origin instead - the obvious alternative, and
  // what folding the angles into the parent group would do - would carry the
  // whole solid round an axis `drawnAt` metres behind it, which on a backdrop at
  // -6 m is a panel that leaves the frame rather than one that tips.
  const box = new THREE.Box3().setFromObject(tipped);
  const centre = box.getCenter(new THREE.Vector3());
  const centred =
    Math.abs(centre.x) < F32 && Math.abs(centre.y) < F32 && Math.abs(centre.z - drawnAt) < F32;

  // The control, and the claim that matters to every level already authored: an
  // object that tips by nothing is mounted exactly as it was before the two
  // angles were read at all.
  const unchanged =
    flat.rotation.x === 0 &&
    flat.rotation.y === 0 &&
    flat.rotation.z === 0 &&
    flat.position.x === 0 &&
    flat.position.y === 0 &&
    flat.position.z === drawnAt;

  return [
    {
      name: "render: a primitive is tipped out of the plane by rotX and rotY",
      pass: turned,
      detail: `rotation (${tipped.rotation.x}, ${tipped.rotation.y}, ${tipped.rotation.z}), want (${rotX}, ${rotY}, 0)`,
    },
    {
      name: "render: a tipped primitive turns about its own middle, at the depth it is drawn at",
      pass: centred,
      detail: `centre (${centre.x.toFixed(6)}, ${centre.y.toFixed(6)}, ${centre.z.toFixed(6)}), want (0, 0, ${drawnAt})`,
    },
    {
      name: "render: a primitive that tips by nothing is mounted exactly as before",
      pass: unchanged,
      detail: `rotation (${flat.rotation.x}, ${flat.rotation.y}, ${flat.rotation.z}) at z ${flat.position.z}`,
    },
  ];
}

// A level with every body's frame pushed onto its objects and the body left at
// the origin. It is what makes the round trips below comparable at all: a body's
// transform and its objects' placements are two halves of ONE answer, and the
// editor legitimately re-origins a body onto its first object when it saves. A
// byte comparison would read that as a lost field; this compares the thing that
// actually has to survive, which is where every object ends up.
//
// The numbers are rounded to a micrometre, because the flattening is trigonometry
// and a value that has been through px -> m -> px carries float noise in its last
// bits. A micrometre is four orders below the smallest thing any level authors.
function flattened(data: LevelData): string {
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return JSON.stringify(
    data.bodies.map((b) => ({
      kind: b.kind,
      color: b.color,
      opacity: b.opacity,
      friction: b.friction,
      bounce: b.bounce,
      launch: b.launch,
      force: b.force,
      // Keys sorted, because two builders that emit the same fields in a
      // different order have not lost anything - and they legitimately do: an
      // object's placement is written where it was authored on one side and
      // where the editor re-derived it on the other.
      objects: b.objects.map((o) => {
        const w = worldPlacement(b, o);
        const flat: Record<string, unknown> = {
          ...o,
          x: round(w.pos.x),
          y: round(w.pos.y),
          rot: round(w.rot),
        };
        return Object.fromEntries(Object.keys(flat).sort().map((k) => [k, flat[k]]));
      }),
    })),
  );
}

// What a body is drawn as: its geometry object, which is what the retired
// per-entry `visual` became - so the round-trip assertions below read it where
// they used to read that field.
function lookOf(b: LevelBodyData): GeometryObjectData | undefined {
  return b.objects.find(isGeometryObject);
}

// Every length in a `visual` has to survive the px -> m -> px round trip, or the
// field is silently dropped or double-scaled on the next save. `scaleLevelData`
// rebuilds objects field by field, so a field it does not enumerate is simply
// gone - and the editor writes the file back every 750 ms, so the loss lands on
// disk before anyone notices it was ever read.
function visualRoundTrip(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 20 },
    bodies: [
      {
        kind: "static",
        x: 100,
        y: -250,
        rot: 0.3,
        shape: { kind: "rect", w: 400, h: 60 },
        visual: {
          kind: "mesh",
          mesh: "rock-a",
          offsetX: 12,
          offsetY: -8,
          offsetZ: 35,
          rotX: 0.2,
          rotY: -1.1,
          rotZ: 0.75,
          scale: 1.4,
          depth: 90,
          texture: "stone",
          tileScale: 2,
          tileOffsetX: 25,
          tileOffsetY: -40,
          bevel: 3,
          emissive: "#ff8844",
          emissiveIntensity: 2.5,
          emissiveRange: 480,
          emissiveFlicker: 0.35,
          emissiveTexture: "furnace",
          emissiveDirX: 0.3,
          emissiveDirY: -1,
          emissiveDirZ: -0.2,
          emissiveAngle: 32,
          emissivePenumbra: 0.25,
          emissiveShadow: true,
        },
      },
      { kind: "rigid", x: 0, y: 0, rot: 0, shape: { kind: "circle", r: 25 }, visual: { kind: "none" } },
      // Decoration, in the form it is authored in now...
      {
        kind: "static",
        collision: false,
        x: -400,
        y: 120,
        rot: 0,
        shape: { kind: "rect", w: 900, h: 600 },
        visual: { offsetZ: -600, depth: 20, texture: "quarry-stone", tileScale: 0.5 },
      },
    ],
    // ...and in the retired one, which `normalizeLevelData` folds into the list
    // above. Both round trips run through that gate, so a migration that lost a
    // field would show up here as the trip not being byte-identical.
    backgrounds: [
      {
        x: 900,
        y: 120,
        rot: 0.2,
        shape: { kind: "rect", w: 400, h: 300 },
        group: "g7",
        visual: { offsetZ: -300 },
      },
    ],
  };
  // Compared against the SAME builder run at factor 1 rather than against the
  // authored literal: `scaleLevelData` rebuilds objects field by field, so it
  // also fixes their key order, and a key-order difference is not a lost field.
  // What is being asserted is that every value survives the trip.
  const a = flattened(scaleLevelData(authored, 1));
  const b = flattened(scaleLevelData(scaleLevelData(authored, PX), PIXELS_PER_METER));
  // A DIMENSIONLESS field cannot be checked by that round trip at all: scaling it
  // on the way in and back out again is the identity, so `tileScale * factor`
  // would be invisible here while silently making every authored tiling scale a
  // hundred times off in the game. It has to be asserted one way.
  const inMetres = scaleLevelData(authored, PX);
  const dimensionless =
    lookOf(inMetres.bodies[0]!)!.tileScale === 2 &&
    lookOf(inMetres.bodies[0]!)!.scale === 1.4 &&
    lookOf(inMetres.bodies[2]!)!.tileScale === 0.5;
  return [
    {
      name: "level format: visual round-trips px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
    {
      name: "level format: `scale` and `tileScale` are not scaled by the px -> m conversion",
      pass: dimensionless,
      detail: dimensionless
        ? "unchanged in metres"
        : `tileScale ${lookOf(inMetres.bodies[0]!)?.tileScale} / ${lookOf(inMetres.bodies[2]!)?.tileScale}, scale ${lookOf(inMetres.bodies[0]!)?.scale}`,
    },
  ];
}

// The editor is the other round trip, and the one that actually runs: it
// rewrites the whole file every 750 ms while a level is open, so a field it
// drops is a field that is gone from disk before anyone notices it was read.
// `modelFromDisk`/`modelToDisk` go through `EdItem`, which is a different shape
// from `LevelBodyData` entirely - the visual becomes a live object the inspector
// mutates - so the format round trip above says nothing about this one.
function editorRoundTrip(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 20 },
    bodies: [
      // A mesh visual with every placement field set...
      {
        kind: "static",
        x: 100,
        y: -250,
        rot: 0.3,
        shape: { kind: "rect", w: 400, h: 60 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        visual: {
          kind: "mesh",
          mesh: "rock-a",
          offsetX: 12,
          offsetY: -8,
          offsetZ: 35,
          rotX: 0.2,
          rotY: -1.1,
          rotZ: 0.75,
          scale: 1.4,
        },
      },
      // ...an extrusion override...
      {
        kind: "rigid",
        x: 0,
        y: 0,
        rot: 0,
        shape: { kind: "circle", r: 25 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        material: "stone",
        visual: {
          depth: 90,
          texture: "brick",
          tileScale: 1.5,
          bevel: 3,
          emissive: "#ff8844",
          emissiveIntensity: 2.5,
        },
      },
      // ...an invisible wall...
      {
        kind: "static",
        x: -300,
        y: 40,
        rot: 0,
        shape: { kind: "rect", w: 100, h: 100 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        visual: { kind: "none" },
      },
      // ...a body with no visual at all, which must come back with the
      // geometry object that draws it and nothing more.
      {
        kind: "static",
        x: 500,
        y: 0,
        rot: 0,
        shape: { kind: "rect", w: 80, h: 80 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
      },
      // ...and a PRIMITIVE tipped out of the plane. The two angles were a
      // prop's alone while nothing in the extrusion path read them, and
      // `visualData` dropped them for a primitive on the way out to say so -
      // so a save that goes back to dropping them silently flattens every
      // canted panel in a level 750 ms after it is opened.
      {
        kind: "static",
        x: 700,
        y: 0,
        rot: 0,
        shape: { kind: "rect", w: 200, h: 40 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        visual: { rotX: 0.35, rotY: -0.8 },
      },
    ],
    backgrounds: [
      {
        x: -400,
        y: 120,
        rot: 0,
        shape: { kind: "rect", w: 900, h: 600 },
        color: "#313244",
        opacity: 1,
        visual: { offsetZ: -600 },
      },
    ],
  };
  const back = modelToDisk(modelFromDisk(authored));
  // Both sides flattened, which fixes key order AND absorbs the body frame the
  // editor gives each body on the way out: what is being asserted is that every
  // value survives the trip and every object ends up where it started, not that
  // two builders chose the same origin to measure from.
  const a = flattened(scaleLevelData(authored, 1));
  const b = flattened(scaleLevelData(back, 1));
  // Nothing draws a collision shape but a geometry object, so a body authored
  // under the old default must come back carrying the PRIMITIVE that states it:
  // the same outline, stated once on each object, which is what decoupling the
  // two costs and what makes either of them separately editable.
  const twinned = JSON.stringify(back.bodies[3]!.objects) ===
    JSON.stringify([
      { type: "collision", shape: { kind: "rect", w: 80, h: 80 } },
      { type: "geometry", shape: { kind: "rect", w: 80, h: 80 } },
    ]);
  // A shape DRAWN in the editor is a collision object and nothing else, and this
  // is the trip that has to leave it that way. It is the same assertion as
  // "a body authored with a bare collision shape keeps it bare" one level down,
  // made against the round trip an author actually performs: draw, save, reopen.
  // Both halves could undo it independently - the save could invent a look, the
  // load could migrate one in - so it is checked where they meet.
  const drawn: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        objects: [{ type: "collision", shape: { kind: "rect", w: 80, h: 80 } }],
      },
    ],
  };
  const reopened = modelToDisk(modelFromDisk(drawn));
  const stayedBare =
    JSON.stringify(reopened.bodies[0]!.objects) ===
    JSON.stringify([{ type: "collision", shape: { kind: "rect", w: 80, h: 80 } }]);

  // The tipped primitive, read back off the object the editor wrote. The
  // byte-identity above already covers it, but it covers it as one difference
  // in a blob of twenty fields; this says which field went.
  const tipped = lookOf(back.bodies[4]!);
  const keptTip = tipped?.rotX === 0.35 && tipped?.rotY === -0.8;

  return [
    {
      name: "editor: a level with visuals saves back byte-identical",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  saved    ${b}`,
    },
    {
      name: "editor: a body with no visual gains the geometry object that draws it",
      pass: twinned,
      detail: twinned
        ? "one collision object and one primitive stating the same outline"
        : `wrote ${JSON.stringify(back.bodies[3]!.objects)}`,
    },
    {
      name: "editor: a drawn collision shape survives a save and reopen still bare",
      pass: stayedBare,
      detail: stayedBare
        ? "one collision object, nothing added"
        : `wrote ${JSON.stringify(reopened.bodies[0]!.objects)}`,
    },
    {
      name: "editor: a primitive's out-of-plane tip survives a save",
      pass: keptTip,
      detail: keptTip
        ? "rotX and rotY written for a primitive as for a prop"
        : `wrote rotX ${tipped?.rotX}, rotY ${tipped?.rotY}`,
    },
  ];
}

// TRANSFORMING A SELECTION AS ONE ARRANGEMENT (`selectionCentre`,
// `captureGroupPose`, `placeGroup`) - what the editor's gizmo writes when more
// than one thing is selected.
//
// None of it can be seen in a picture, and two of the three claims are the kind
// that look fine for one drag and are wrong by the tenth.
//
// The centre has to be a fixed point of its own rotation, or the handles walk
// away from the selection a turn at a time. The transform has to be measured
// from the pose the gesture STARTED in, because a drag re-applies its whole
// displacement on every pointer move - a delta-per-move reads identically for
// one move and accumulates the snap grid's rounding over a slow drag. And a
// body's frame may move only when the whole body moves, which is the rule every
// other group edit in the editor follows and the one a new writer of placements
// is most likely to miss.
function groupTransform(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      // Two bodies of one object...
      { kind: "static", x: -200, y: 0, rot: 0, shape: { kind: "rect", w: 100, h: 100 } },
      { kind: "static", x: 200, y: 0, rot: 0, shape: { kind: "rect", w: 100, h: 100 } },
      // ...and a compound one, whose frame is the thing a half-selection must
      // not move.
      {
        kind: "static",
        x: 0,
        y: 400,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 100, h: 100 } },
          { type: "collision", x: 150, shape: { kind: "rect", w: 100, h: 100 } },
        ],
      },
    ],
  };
  const fresh = (): EdModel => {
    const m = modelFromDisk(authored);
    // What `beginAction` does before any gesture: a body of more than one object
    // has its frame written down, so an edit to a piece of it cannot be read as
    // an edit to the body.
    for (const id of new Set(m.items.map((i) => i.bodyId))) {
      if (bodyMembers(m.items, id).length > 1) pinBodyFrame(m, id);
    }
    return m;
  };
  const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;

  // A TURN LEAVES THE CENTRE WHERE IT WAS. The mean of a set of points turned
  // about their own mean is that same mean - which is the whole reason the
  // centre is a mean and not the middle of a bounding box, the box of a turned
  // arrangement being a different box.
  const turning = fresh();
  const turned = turning.items;
  const centre0 = selectionCentre(turned);
  placeGroup(turning, turned, captureGroupPose(turning, turned, centre0), Vec2.ZERO, 0.7);
  const centre1 = selectionCentre(turning.items);
  const centreHeld = near(centre0.x, centre1.x) && near(centre0.y, centre1.y);

  // ...and it is a TURN: every member swings about that centre and takes its own
  // angle with it, which is what makes an arrangement keep its shape.
  const before = fresh();
  const list = before.items;
  const centre = selectionCentre(list);
  const was = list.map((i) => ({ id: i.id, pos: i.pos, rot: i.rot }));
  placeGroup(before, list, captureGroupPose(before, list, centre), Vec2.ZERO, 0.7);
  const swung = was.every((w) => {
    const now = before.items.find((i) => i.id === w.id)!;
    const want = centre.add(w.pos.sub(centre).rotated(0.7));
    return near(now.pos.x, want.x) && near(now.pos.y, want.y) && near(now.rot, w.rot + 0.7);
  });

  // MEASURED FROM THE SNAPSHOT. A drag applies its whole displacement every
  // pointer move, so the second apply against one base must land where the
  // second displacement says and not where the two of them add up to.
  const dragging = fresh();
  const dragged = dragging.items;
  const start = dragged.map((i) => ({ id: i.id, pos: i.pos }));
  const pose = captureGroupPose(dragging, dragged, selectionCentre(dragged));
  placeGroup(dragging, dragged, pose, new Vec2(1, 0), 0);
  placeGroup(dragging, dragged, pose, new Vec2(3, -2), 0);
  const fromBase = start.every((s) => {
    const now = dragging.items.find((i) => i.id === s.id)!;
    return near(now.pos.x, s.pos.x + 3) && near(now.pos.y, s.pos.y - 2);
  });

  // THE BODY FRAME MOVES WITH THE WHOLE BODY AND NOT WITH A PIECE OF IT. Both
  // halves asserted on the same compound body, since the bug is that the rule
  // holds in one direction only.
  // Ids are minted per model (`newBodyId` is a running counter), so the compound
  // body is found inside each model rather than carried between two of them.
  const compoundOf = (m: EdModel): number =>
    [...new Set(m.items.map((i) => i.bodyId))].find((id) => bodyMembers(m.items, id).length > 1)!;

  const whole = fresh();
  const members = bodyMembers(whole.items, compoundOf(whole));
  const frameWas = bodyFrameOf(whole, compoundOf(whole));
  placeGroup(whole, members, captureGroupPose(whole, members, selectionCentre(members)), new Vec2(2, 0), 0);
  const frameMoved = near(bodyFrameOf(whole, compoundOf(whole)).pos.x, frameWas.pos.x + 2);

  const part = fresh();
  const partId = compoundOf(part);
  const half = [bodyMembers(part.items, partId)[0]!];
  const partFrameWas = bodyFrameOf(part, partId);
  const memberWas = half[0]!.pos;
  placeGroup(part, half, captureGroupPose(part, half, selectionCentre(half)), new Vec2(2, 0), 0);
  const frameStayed =
    near(bodyFrameOf(part, partId).pos.x, partFrameWas.pos.x) &&
    near(half[0]!.pos.x, memberWas.x + 2);

  return [
    {
      name: "editor: a selection turns about a centre the turn does not move",
      pass: centreHeld,
      detail: `centre (${centre0.x.toFixed(6)}, ${centre0.y.toFixed(6)}) -> (${centre1.x.toFixed(6)}, ${centre1.y.toFixed(6)})`,
    },
    {
      name: "editor: a group turn swings every member about that centre and turns it with it",
      pass: swung,
      detail: swung ? `${was.length} members` : "a member did not land on the turned placement",
    },
    {
      name: "editor: a group drag is measured from the pose the drag began in",
      pass: fromBase,
      detail: fromBase ? "two applies against one base land on the second" : "the two displacements accumulated",
    },
    {
      name: "editor: a body moves its frame only when the whole body is in the selection",
      pass: frameMoved && frameStayed,
      detail: `whole body ${frameMoved ? "carried" : "LEFT"} its frame, a piece of one ${frameStayed ? "left it alone" : "MOVED it"}`,
    },
  ];
}

// The MATCHED-OUTLINE link (`GeometryObjectData.matchCollision`): a geometry
// object the editor keeps outline-equal to a collision sibling, in both
// directions, so resizing either resizes both - the standing form of the "match
// the collision shape" edit the collision/geometry decoupling priced in.
//
// Everything here is the half no picture can see. The link is editor state: a
// level renders identically with or without it, so a save that drops the flag,
// a load that ties it to the wrong piece, or a sync that stops propagating all
// leave a level that looks right and quietly stops staying in step - which is
// exactly the double-edit pain the feature exists to remove, back again with a
// checkbox claiming otherwise.
function matchedOutline(): CaseResult[] {
  const level = (objects: SceneObjectData[]): RawLevelData => ({
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        objects,
      },
    ],
  });

  // A pair already in step survives the editor round trip byte-identical, flag
  // included - the same trip every other field is held to, since the editor
  // rewrites the file every 750 ms.
  const paired = level([
    { type: "collision", shape: { kind: "rect", w: 80, h: 40 }, x: 10, y: -20, rot: 0.25 },
    {
      type: "geometry",
      shape: { kind: "rect", w: 80, h: 40 },
      x: 10,
      y: -20,
      rot: 0.25,
      matchCollision: true,
    },
  ]);
  const a = flattened(scaleLevelData(paired, 1));
  const b = flattened(scaleLevelData(modelToDisk(modelFromDisk(paired)), 1));

  // A hand-edited file whose halves have DRIFTED: with one collision object the
  // intent is unambiguous, so the load snaps the look back onto the shape - the
  // collision outline is what the level plays as - rather than dropping the
  // link or, worse, keeping a "matched" pair that is not.
  const drifted = level([
    { type: "collision", shape: { kind: "rect", w: 80, h: 40 } },
    { type: "geometry", shape: { kind: "rect", w: 120, h: 40 }, x: 15, matchCollision: true },
  ]);
  const snappedBodies = modelToDisk(modelFromDisk(drifted)).bodies[0]!.objects;
  const snapped =
    JSON.stringify(snappedBodies) ===
    JSON.stringify([
      { type: "collision", shape: { kind: "rect", w: 80, h: 40 } },
      { type: "geometry", shape: { kind: "rect", w: 80, h: 40 }, matchCollision: true },
    ]);

  // ...but with SEVERAL collision objects and no exact twin there is nothing
  // safe to guess, so the link is dropped rather than tied to a piece nobody
  // chose - and the geometry keeps the outline it authored.
  const ambiguous = level([
    { type: "collision", shape: { kind: "rect", w: 80, h: 40 } },
    { type: "collision", shape: { kind: "rect", w: 60, h: 40 }, x: 200 },
    { type: "geometry", shape: { kind: "rect", w: 50, h: 50 }, x: 90, matchCollision: true },
  ]);
  const ambiguousGeo = modelToDisk(modelFromDisk(ambiguous))
    .bodies[0]!.objects.find(isGeometryObject)!;
  const dropped =
    ambiguousGeo.matchCollision === undefined &&
    ambiguousGeo.shape?.kind === "rect" &&
    ambiguousGeo.shape.w === 50;

  // The flag means nothing in a body with no collision object at all, and a
  // meaningless field must not reach disk.
  const aloneGeo = modelToDisk(
    modelFromDisk(level([{ type: "geometry", shape: { kind: "rect", w: 80, h: 40 }, matchCollision: true }])),
  ).bodies[0]!.objects.find(isGeometryObject)!;
  const droppedAlone = aloneGeo.matchCollision === undefined;

  // The live sync, in BOTH directions - the half the round trips cannot see.
  // Which side an edit touched is what `syncMatchedOutlines` works out from the
  // signatures of the last sync, so the seed pass comes first, exactly as the
  // editor's dirty funnel runs it.
  const model = modelFromDisk(paired);
  const sigs = new Map<number, string>();
  syncMatchedOutlines(model, sigs);
  const g = model.items.find((i) => i.object === "geometry")!;
  const c = model.items.find((i) => i.object === "collision")!;
  if (c.shape.kind === "rect") c.shape.w = 2;
  syncMatchedOutlines(model, sigs);
  const followedCollision = g.shape.kind === "rect" && g.shape.w === 2;
  g.rot = 1.5;
  g.pos = new Vec2(3, -1);
  syncMatchedOutlines(model, sigs);
  const followedGeometry = c.rot === 1.5 && c.pos.x === 3 && c.pos.y === -1;
  // A link whose partner is gone is dropped, which is what lets Delete not
  // know the link exists.
  model.items = model.items.filter((i) => i !== c);
  syncMatchedOutlines(model, sigs);
  const pruned = g.matchId === 0;

  return [
    {
      name: "editor: a matched pair saves back byte-identical, link included",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  saved    ${b}`,
    },
    {
      name: "editor: a drifted matched pair snaps onto its collision shape at load",
      pass: snapped,
      detail: snapped
        ? "geometry back on the collision outline, link kept"
        : `wrote ${JSON.stringify(snappedBodies)}`,
    },
    {
      name: "editor: an ambiguous match is dropped rather than guessed",
      pass: dropped,
      detail: dropped
        ? "link dropped, authored outline kept"
        : `wrote ${JSON.stringify(ambiguousGeo)}`,
    },
    {
      name: "editor: matchCollision in a body with no collision object is not written",
      pass: droppedAlone,
      detail: droppedAlone ? "flag dropped" : `wrote ${JSON.stringify(aloneGeo)}`,
    },
    {
      name: "editor: resizing the collision shape resizes its matched geometry",
      pass: followedCollision,
      detail: followedCollision ? "w followed" : `geometry shape ${JSON.stringify(g.shape)}`,
    },
    {
      name: "editor: moving the matched geometry moves its collision shape",
      pass: followedGeometry,
      detail: followedGeometry
        ? "pos and rot followed"
        : `collision at ${c.pos.x},${c.pos.y} rot ${c.rot}`,
    },
    {
      name: "editor: a match whose partner is deleted is dropped",
      pass: pruned,
      detail: pruned ? "matchId cleared" : `matchId still ${g.matchId}`,
    },
  ];
}

// A CORNER EDIT MOVES THE CORNER AND NOTHING ELSE.
//
// `setPolyVerts` used to re-centre the loop on its area centroid and shift the
// item's `pos` to compensate, which kept a polygon item's origin its own centre
// of mass. Nothing visibly moved in the shape being dragged - and everything
// else in its body did: the polygon's placement inside the body slid by the
// centroid's own motion, so the numbers the inspector shows for it walked away
// from zero, and a `matchCollision` prop, which copies the collision object's
// PLACEMENT as well as its outline, walked across the level with them. Fitting a
// collision outline to the mesh it is being fitted TO moved the mesh, which is
// the one thing that edit must not do.
//
// The other half is what the re-centring was FOR: the editor's idea of where a
// body turns (`bodyCentroid`) has to be the point the build mounts it at
// (`mountPieces`), or the canvas draws a body rotating about a point the sim
// does not have. With the origin free that answer comes off the outline
// (`shapeCentre`) instead of off `pos`, so both halves are asserted together -
// nothing moved, and the centre of mass is still right where it was.
function vertexEditMoves(): CaseResult[] {
  const square = [
    { x: -60, y: -60 },
    { x: 60, y: -60 },
    { x: 60, y: 60 },
    { x: -60, y: 60 },
  ];
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 300,
        y: -100,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "poly", verts: square } },
          // The prop being fitted to, at its own offset in the body...
          { type: "geometry", kind: "mesh", mesh: "rock-13", x: 200, z: 30 },
          // ...and a matched primitive, which follows the outline by design and
          // is the piece the placement copy used to drag off its body.
          {
            type: "geometry",
            shape: { kind: "poly", verts: square },
            matchCollision: true,
          },
        ],
      },
    ],
  };
  const model = modelFromDisk(authored);
  const sigs = new Map<number, string>();
  syncMatchedOutlines(model, sigs);
  const poly = model.items.find((i) => i.object === "collision")!;
  const prop = model.items.find((i) => i.object === "geometry" && i.visual.kind === "mesh")!;
  const propBefore = prop.pos.clone();

  // The drag: one corner out by a metre and a half in each axis, written the way
  // every vertex gesture writes one.
  if (poly.shape.kind !== "poly") return [{ name: "editor: vertex edit", pass: false, detail: "not a polygon" }];
  const pulled = poly.shape.verts[0]!.add(new Vec2(-1.5, -1.5));
  const moved = setPolyVerts(
    poly,
    poly.shape.verts.map((v, i) => (i === 0 ? pulled : v)),
  );
  syncMatchedOutlines(model, sigs);

  const saved = modelToDisk(model).bodies[0]!;
  const collision = saved.objects.find(isCollisionObject)!;
  const matched = saved.objects.find((o) => isGeometryObject(o) && o.matchCollision === true)!;
  const mesh = saved.objects.find((o) => isGeometryObject(o) && o.mesh !== undefined)!;
  // An absent x/y IS zero on disk, which is what "it never moved" looks like
  // here - the body's own origin included.
  const still =
    saved.x === 300 &&
    saved.y === -100 &&
    (collision.x ?? 0) === 0 &&
    (collision.y ?? 0) === 0 &&
    (matched.x ?? 0) === 0 &&
    (matched.y ?? 0) === 0 &&
    (mesh.x ?? 0) === 200 &&
    (mesh.y ?? 0) === 0 &&
    prop.pos.distanceTo(propBefore) === 0;
  // ...and the corner really is where it was dragged, or "nothing moved" is a
  // case that passes on an edit that did not happen.
  const dragged =
    moved && poly.shape.kind === "poly" && poly.shape.verts[0]!.distanceTo(pulled) === 0;

  // The centre of mass, now that the origin is not it: the loop runs from -7.5 m
  // to 0.6 m in each axis about an origin that stayed at the body's own.
  const world = new World();
  const built = buildLevelBodies(world, scaleLevelData(modelToDisk(model), PX), () => {});
  const engine = built.bodies[0]!.body!;
  const centroid = bodyCentroid(bodyMembers(model.items, poly.bodyId));
  const agrees = centroid.distanceTo(engine.globalPosition) < 1e-9;
  const offOrigin = centroid.distanceTo(poly.pos) > 0.1;

  return [
    {
      name: "editor: a corner drag moves neither its own object nor anything else in the body",
      pass: still,
      detail: still
        ? "body, collision, matched prop and mesh all where they were authored"
        : `body (${saved.x}, ${saved.y}), collision (${collision.x ?? 0}, ${collision.y ?? 0}), matched (${matched.x ?? 0}, ${matched.y ?? 0}), mesh (${mesh.x ?? 0}, ${mesh.y ?? 0})`,
    },
    {
      name: "editor: the dragged corner lands exactly where it was put",
      pass: dragged,
      detail: dragged
        ? "corner at the drag's own point, loop accepted"
        : `accepted ${moved}, corner ${JSON.stringify(poly.shape.kind === "poly" ? poly.shape.verts[0] : null)}`,
    },
    {
      name: "editor: the body's centre of mass is still the point the build mounts it at",
      pass: agrees && offOrigin,
      detail:
        agrees && offOrigin
          ? `centre of mass ${centroid.distanceTo(poly.pos).toFixed(3)} m off the origin, and the engine agrees`
          : `editor (${centroid.x.toFixed(3)}, ${centroid.y.toFixed(3)}) vs engine (${engine.globalPosition.x.toFixed(3)}, ${engine.globalPosition.y.toFixed(3)})`,
    },
  ];
}

// WHAT A 3D PICK ANSWERS WITH. The editor selects scene geometry by raycasting
// the scene rather than by testing an outline on the gameplay plane, and the
// whole chain from a mesh under the pointer back to a row in the outliner is:
// the drawn object carries the authored object it was built from
// (`BodyVisual`'s pick tag), and `toLevelData` is the only thing that knows
// which ITEM wrote that object.
//
// That second half is what is asserted here, because it is the half that can
// break silently. `toLevelData` writes one scene object per item, in item order,
// and a future edit that skips one, writes two, or reorders them leaves a level
// that saves, loads and renders exactly as before while every click past the
// mistake selects the wrong thing - or nothing. Nothing else in the suite can
// see it, and the 3D half cannot be checked headlessly at all (building a
// `BodyVisual` needs a DOM for the generated textures).
function pickIndex(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      // A compound body with two pieces, each dressed, plus a light: the case
      // where an object's place in its body is the only thing telling two of
      // them apart.
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 80, h: 80 } },
          {
            type: "geometry",
            x: 10,
            shape: { kind: "rect", w: 80, h: 80 },
            kind: "mesh",
            mesh: "prop-a",
          },
          { type: "collision", x: 120, shape: { kind: "rect", w: 40, h: 40 } },
          {
            type: "geometry",
            x: 120,
            shape: { kind: "rect", w: 40, h: 40 },
            kind: "mesh",
            mesh: "prop-b",
          },
          { type: "light", x: 60 },
        ],
      },
      // ...and a body that is nothing but a prop, which has no collision object
      // to be found by instead.
      {
        kind: "static",
        x: 400,
        y: -200,
        rot: 0.4,
        objects: [
          {
            type: "geometry",
            shape: { kind: "rect", w: 200, h: 200 },
            kind: "mesh",
            mesh: "prop-c",
          },
        ],
      },
    ],
  };
  const model = modelFromDisk(authored);
  const itemOf = new Map<SceneObjectData, number>();
  const data = toLevelData(model, itemOf);
  const items = new Map(model.items.map((i) => [i.id, i]));

  const written = data.bodies.reduce((n, b) => n + b.objects.length, 0);
  const missed = data.bodies.flatMap((b) => b.objects).filter((o) => !itemOf.has(o));

  // Every DRAWN object resolves to the geometry item that authored it, told
  // apart by the prop each one names - a mapping that is off by one still
  // answers with a geometry item, and only the name says which.
  const wrong: string[] = [];
  for (const g of data.bodies.flatMap((b) => drawnObjects(b))) {
    const id = itemOf.get(g);
    const item = id === undefined ? undefined : items.get(id);
    if (item?.object === "geometry" && item.visual.mesh === g.mesh) continue;
    wrong.push(
      `${g.mesh ?? "(none)"} -> ${item ? `#${item.id} ${item.object} ${item.visual.mesh ?? "(none)"}` : "nothing"}`,
    );
  }

  return [
    {
      name: "pick: every scene object written names the item that wrote it",
      pass: missed.length === 0 && itemOf.size === written,
      detail:
        missed.length === 0 && itemOf.size === written
          ? `${written} objects, ${itemOf.size} indexed`
          : `${missed.length} of ${written} unindexed (${itemOf.size} indexed)`,
    },
    {
      name: "pick: a drawn object resolves to the geometry item that authored it",
      pass: wrong.length === 0,
      detail: wrong.length === 0 ? "3 props, each its own item" : wrong.join("; "),
    },
  ];
}

// How deep a shape is drawn, which is what orders two overlapping ones - on both
// canvases and under a click in the editor (see `pickOrder`). One rule, asserted
// here because a wrong answer is not an error anywhere: the level still draws,
// and a backdrop simply swallows clicks meant for the wall in front of it.
function depthOrdering(): CaseResult[] {
  const shape = { kind: "rect" as const, w: 100, h: 100 };
  const body = (objects: SceneObjectData[]): LevelBodyData => ({
    kind: "static",
    x: 0,
    y: 0,
    rot: 0,
    objects,
  });
  const solid = body([{ type: "collision", shape }]);
  const decoration = body([{ type: "geometry", shape }]);
  const solidAt = (z: number) =>
    body([{ type: "collision", shape }, { type: "geometry", z }]);
  const decorAt = (z: number) => body([{ type: "geometry", shape, z }]);
  const depth = (b: LevelBodyData) =>
    depthOf(b, b.objects.find((o) => o.type === "geometry") as GeometryObjectData | undefined);
  const checks: Array<[string, boolean, string]> = [
    ["solid geometry sits on the gameplay plane", depth(solid) === 0, `${depth(solid)} m`],
    [
      "a body with no collision falls back behind it rather than to zero",
      depth(decoration) === DECOR_Z,
      `${depth(decoration)} m`,
    ],
    [
      "an authored z wins for either",
      depth(decorAt(3)) === 3 && depth(solidAt(-20)) === -20,
      "authored depth used as given",
    ],
    [
      "nearest the viewport sorts last, which is what a click takes first",
      [solidAt(-20), decoration, solidAt(0.5)]
        .sort((a, b) => depth(a) - depth(b))
        .map(depth)
        .join(",") === `-20,${DECOR_Z},0.5`,
      "back to front",
    ],
  ];
  return checks.map(([name, pass, detail]) => ({ name: `depth: ${name}`, pass, detail }));
}

// Which surface a name resolves to, and at what tiling scale. Pure arithmetic
// over the two manifests, which is why it can live in this suite at all - there
// is no canvas here and no GPU, so the materials themselves cannot be built.
//
// What it is guarding is the ONE namespace. A level names a surface; whether
// that surface is a downloaded set of maps or a few hundred bytes of generated
// noise is `assets.ts`'s answer, and the point of the arrangement is that
// dressing a level in authored textures is adding manifest entries rather than
// re-authoring every body that named the material. Get the precedence backwards
// and every level goes on wearing noise while the downloaded maps sit unused -
// which looks like nothing at all, since the generated surfaces are perfectly
// presentable.
function surfaceResolution(): CaseResult[] {
  const key = "test-quarry-stone";
  // The manifest is a plain record and this is the only way to exercise a
  // resolution rule with an empty one. Removed again below, so no other case
  // (and no build) can see it.
  TEXTURE_ASSETS[key] = {
    maps: { base: { file: "/textures/x-base.webp", sha256: "0", bytes: 1 } },
    tile: 2.5,
    source: "test",
    author: "test",
    license: "test",
  };
  try {
    const checks: Array<[string, boolean, string]> = [
      [
        "an authored set resolves to itself",
        surfaceName(key) === key,
        surfaceName(key),
      ],
      [
        "a material name still resolves to its generated surface",
        surfaceName("stone") === "stone",
        surfaceName("stone"),
      ],
      [
        "an unknown name falls back rather than vanishing",
        surfaceName("no-such-surface") === DEFAULT_TEXTURE,
        surfaceName("no-such-surface"),
      ],
      // The flat fill is IN the namespace rather than beside it, so it has to
      // survive the same resolution every other key goes through - and it must
      // not be swallowed by the unknown-name fallback above, which would draw a
      // wooden wall where the level asked for a block of colour.
      [
        "the solid fill resolves to itself rather than to the fallback",
        surfaceName(SOLID_SURFACE) === SOLID_SURFACE && isSolidSurface(surfaceName(SOLID_SURFACE)),
        surfaceName(SOLID_SURFACE),
      ],
      [
        "a solid fill has nothing to tile",
        surfaceTile(SOLID_SURFACE) === 1 && tileMetres(SOLID_SURFACE, 4) === 4,
        `${surfaceTile(SOLID_SURFACE)} m`,
      ],
      [
        "two colours of flat fill are two materials",
        surfaceKey({ texture: SOLID_SURFACE, color: "#ff0000" }) !==
          surfaceKey({ texture: SOLID_SURFACE, color: "#00ff00" }),
        surfaceKey({ texture: SOLID_SURFACE, color: "#ff0000" }),
      ],
      [
        "an authored set's tile is its own",
        surfaceTile(key) === 2.5,
        `${surfaceTile(key)} m`,
      ],
      [
        "a generated set's tile is the table's",
        surfaceTile("stone") === TEXTURE_SETS.stone.tile,
        `${surfaceTile("stone")} m`,
      ],
      [
        "life size is the texture's own size, whatever the texture",
        tileMetres(key) === 2.5 && tileMetres("stone") === TEXTURE_SETS.stone.tile,
        `${tileMetres(key)} m / ${tileMetres("stone")} m`,
      ],
      [
        "a tile scale multiplies that rather than replacing it",
        tileMetres(key, 2) === 5 && tileMetres(key, 0.5) === 1.25 && tileMetres(key, null) === 2.5,
        `x2 -> ${tileMetres(key, 2)} m, x0.5 -> ${tileMetres(key, 0.5)} m`,
      ],
      [
        "only the map slots a set actually carries are enumerated",
        textureMaps(TEXTURE_ASSETS[key]!).length === 1,
        `${textureMaps(TEXTURE_ASSETS[key]!).length} map(s)`,
      ],
    ];
    return checks.map(([name, pass, detail]) => ({
      name: `surfaces: ${name}`,
      pass,
      detail,
    }));
  } finally {
    delete TEXTURE_ASSETS[key];
  }
}

// The level's own lights. Two round trips and one thing neither can see.
//
// `intensity` is the trap and it is the reason this case exists at all. Every
// other number on a light is a length and converts between the file's pixels
// and the sim's metres; a point light's brightness is candela, which is an
// irradiance times a distance SQUARED, so a field converted with the rest would
// have to be converted as the square of the factor. It is defined against the
// sim's metres and passes through untouched instead - and a round trip cannot
// tell that apart from scaling it by the factor and back, exactly as it cannot
// for `tileScale`, so it is asserted one way.
function lightRoundTrip(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 20 },
    // Carries the fields the editor always writes back, so this case is about
    // the lights alone rather than about the body defaults (which
    // `editorRoundTrip` already covers).
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        shape: { kind: "rect", w: 100, h: 100 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
      },
    ],
    lights: [
      // Every field an authored light has, so a dropped one shows up as the trip
      // not being byte-identical.
      {
        kind: "spot",
        x: 240,
        y: -180,
        z: 60,
        color: "#ffcc88",
        intensity: 22,
        range: 750,
        angle: 24,
        penumbra: 0.6,
        dirX: 0.2,
        // Deliberately NOT the default 1: the editor writes back only what
        // differs from a default, so a field authored at its default is
        // legitimately dropped and would make this case about that instead.
        dirY: 0.8,
        dirZ: -0.3,
        castShadow: true,
        // 30 rather than 35 because the assertion below compares the scaled
        // value exactly, and 35 px picks up a last-ulp residue through `* PX`.
        shadowNear: 30,
        flicker: 0.35,
      },
      // ...and one carrying nothing but a position, which must come back that
      // way rather than filled out with the defaults it was drawn at.
      { x: -400, y: 60 },
    ],
  };
  const a = JSON.stringify(scaleLevelData(authored, 1));
  const b = JSON.stringify(scaleLevelData(scaleLevelData(authored, PX), PIXELS_PER_METER));

  const inMetres = scaleLevelData(authored, PX);
  // The retired top-level light list migrates to a body containing nothing but
  // the light, which is what a light with no visible source is. The body carries
  // the placement and the object carries the rest.
  const litBody = inMetres.bodies.find((b) => b.objects.some(isLightObject))!;
  const lit = litBody.objects.find(isLightObject)!;
  // The lengths converted, the candela did not. `shadowNear` is a length like
  // `range` - the shadow camera's near plane - and forgetting its line in
  // `scaleObject` is silent everywhere else: the light still lights, and the
  // near plane is simply a hundred times too deep.
  const scaled =
    lit.range === 7.5 && lit.z === 0.6 && litBody.x === 2.4 && lit.shadowNear === 0.3;
  const unscaled = lit.intensity === 22 && lit.angle === 24 && lit.penumbra === 0.6;

  // The environment block rides along, and this is the sharp half of the case.
  // The editor rewrites the whole file every 750 ms while a level is open, so a
  // block it does not carry is DELETED from disk the first time the level is
  // opened - and nothing about that is visible in the editor, since the scene is
  // rebuilt from the model and goes on looking however the model says. It showed
  // up as an authored `sunIntensity: 0` sewer being sunlit again on the next
  // game load, with no edit having been made.
  const withEnv: RawLevelData = {
    ...authored,
    environment: { sunIntensity: 0, envIntensity: 0.1, backgroundColor: "#080a0f" },
  };
  const envBack = modelToDisk(modelFromDisk(withEnv));
  const envKept = JSON.stringify(envBack.environment) === JSON.stringify(withEnv.environment);

  const back = modelToDisk(modelFromDisk(authored));
  const ea = flattened(scaleLevelData(authored, 1));
  const eb = flattened(scaleLevelData(back, 1));
  // A level with no lights must gain no `lights` key, or every level authored
  // before the field stops being byte-identical the first time it is opened.
  // A level with no lights must gain none, which now means no body carrying a
  // light object rather than an absent top-level key.
  const none = modelToDisk(modelFromDisk({ ...authored, lights: undefined })).bodies.every(
    (b) => !b.objects.some(isLightObject),
  );

  return [
    {
      name: "level format: lights round-trip px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
    {
      name: "level format: a light's lengths scale and its intensity does not",
      pass: scaled && unscaled,
      detail:
        scaled && unscaled
          ? "range/z/x in metres, intensity in candela"
          : `range ${lit.range}, z ${lit.z}, x ${litBody.x}, intensity ${lit.intensity}, angle ${lit.angle}`,
    },
    {
      name: "editor: a level with lights saves back byte-identical",
      pass: ea === eb,
      detail: ea === eb ? "byte-identical" : `\n  authored ${ea}\n  saved    ${eb}`,
    },
    {
      name: "editor: a level with no lights gains none",
      pass: none,
      detail: none ? "no light object written" : "wrote a light nobody authored",
    },
    {
      name: "editor: a level's environment block survives a save",
      pass: envKept,
      detail: envKept ? "carried verbatim" : `became ${JSON.stringify(envBack.environment)}`,
    },
    ...planeReach(),
    ...fogBand(),
    ...skyBand(),
    {
      name: "editor: a level with no environment gains none",
      pass: back.environment === undefined,
      detail:
        back.environment === undefined
          ? "no `environment` key written"
          : `wrote ${JSON.stringify(back.environment)}`,
    },
  ];
}

// How far a light reaches ON the gameplay plane, which is what the editor draws
// its ring at. The authored `range` is a sphere's radius and the level is a
// plane through it, so the two agree only for a lamp sitting exactly on the
// plane - and a lamp further off than it reaches lights the level not at all.
//
// It is asserted because `z` is otherwise invisible: a light has no geometry, so
// nothing on the 2D canvas moves when it is authored, and the ring is the only
// feedback the field has.
function planeReach(): CaseResult[] {
  const lit = (range: number, z: number): EdItem => {
    const item = modelFromDisk({
      player: { x: 0, y: 0, radius: 20 },
      bodies: [{ kind: "static", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 10, h: 10 } }],
      lights: [{ x: 0, y: 0, range, z }],
    }).items.find((i) => i.object === "light")!;
    return item;
  };
  const near = lightPlaneReach(lit(500, 300)); // 5 m sphere, 3 m off: 3-4-5
  const on = lightPlaneReach(lit(500, 0));
  const past = lightPlaneReach(lit(500, 700));
  const exact = lightPlaneReach(lit(500, 500));
  const ok =
    Math.abs(near - 4) < 1e-9 &&
    Math.abs(on - 5) < 1e-9 &&
    past === 0 &&
    exact === 0;
  return [
    {
      name: "editor: a light's reach on the plane shrinks with z, and can reach nothing",
      pass: ok,
      detail: ok
        ? "5 m reach: 5 m on the plane at z 0, 4 m at z 3, none at z >= 5"
        : `on ${on}, near ${near}, exact ${exact}, past ${past}`,
    },
  ];
}

// Fog is authored as a FRACTION at a fixed distance and drawn as an exponential
// falloff from the camera, so the two ends of that translation are the whole
// feature and neither is visible in a picture: a fog measured over the wrong
// distance, or one that does not actually thicken with depth, still renders a
// perfectly plausible hazy scene - just not the one that was authored.
//
// Asserted rather than eyeballed for the same reason the light's plane reach is,
// and it is pure arithmetic, so it needs no GPU and no canvas.
function fogBand(): CaseResult[] {
  // What a surface actually receives at distance `z`, which is three.js's own
  // `FogExp2` law: the fraction of the surface the air has replaced.
  const received = (amount: number, z = FOG_REFERENCE_DISTANCE): number =>
    1 - Math.exp(-((fogDensity(amount) * z) ** 2));
  // The round trip the authored number promises: at the reference distance, the
  // fog IS the amount.
  const honoured = [0.1, 0.25, 0.5, 0.9].every(
    (a) => Math.abs(received(a) - a) < 1e-9,
  );
  // ...and the thing the author asked for: further away is foggier, nearer is
  // clearer, monotonically, with none of it at the camera itself.
  const near = received(0.2, 5);
  const mid = received(0.2, FOG_REFERENCE_DISTANCE);
  const far = received(0.2, 40);
  const ramp = received(0.2, 0) === 0 && near < mid && mid < far && far < 1;
  // A dimensionless fraction must pass through the px <-> m conversion
  // untouched, exactly as the colours and the sun direction do - it is the trap
  // the block's own comment names, and a round trip cannot see a value scaled
  // one way and back, so it is asserted one way.
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 20 },
    bodies: [{ kind: "static", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 10, h: 10 } }],
    environment: { fogAmount: 0.25, fogColor: "#2b2f36" },
  };
  const converted = scaleLevelData(authored, PX).environment!;
  const unscaled = converted.fogAmount === 0.25 && converted.fogColor === "#2b2f36";
  return [
    {
      name: "render3d: fog thickens with camera distance, and is the authored fraction at the reference one",
      pass: ramp && honoured,
      detail:
        ramp && honoured
          ? `0.2 authored: ${(near * 100).toFixed(1)}% at 5 m, 20.0% at ${FOG_REFERENCE_DISTANCE} m, ${(far * 100).toFixed(1)}% at 40 m`
          : `near ${near}, mid ${mid}, far ${far}, received ${[0.1, 0.25, 0.5, 0.9].map((a) => received(a)).join(", ")}`,
    },
    {
      name: "level format: fog is dimensionless and does not scale",
      pass: unscaled,
      detail: unscaled
        ? "amount and colour carried verbatim into metres"
        : `became ${JSON.stringify(converted)}`,
    },
  ];
}

// A CAPTURED SKY: that a level can name one, that naming one is not a length,
// and that naming one this build does not have is not a failure.
//
// None of it is visible in a picture, which is why it is asserted here. A level
// whose `hdri` was dropped on the way to disk goes on rendering perfectly well -
// lit by the generated sky, which is what it looked like before anyone reached
// for a capture - and the loss shows up as "the lighting looks flatter than I
// left it" some days later.
function skyBand(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 20 },
    bodies: [{ kind: "static", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 10, h: 10 } }],
    environment: { hdri: "golden-gate-hills", hdriRotation: 135, hdriBackground: true },
  };
  // A sky's NAME is a key, its rotation is an angle and its background flag is a
  // flag: not one of the three is a length, so the px <-> m conversion must
  // carry all of them verbatim. A round trip cannot see a value scaled one way
  // and back, so it is asserted one way, as the fog fraction is.
  const converted = scaleLevelData(authored, PX).environment!;
  const unscaled =
    converted.hdri === "golden-gate-hills" &&
    converted.hdriRotation === 135 &&
    converted.hdriBackground === true;
  // And it survives the editor, which rewrites the whole file every 750 ms while
  // a level is open - the same trap the environment block as a whole is checked
  // for above, one level down, since these fields are newer than that case.
  const back = modelToDisk(modelFromDisk(authored));
  const kept = JSON.stringify(back.environment) === JSON.stringify(authored.environment);
  // Every entry is a `.hdr` under `/hdri/` with a label to show. The format is
  // not a preference: `loadHdri` reads it with three's Radiance loader, so an
  // EXR or a WebP that found its way into this manifest would fetch, fail to
  // decode and fall back to the generated sky - which looks exactly like a level
  // that named nothing.
  const bad = Object.entries(HDRI_ASSETS).filter(
    ([, a]) => !a.file.startsWith("/hdri/") || !a.file.endsWith(".hdr") || !a.label.trim(),
  );
  // The picker's list and the manifest are the same list. They are two calls in
  // the editor and one of them is what an author can choose from.
  const listed =
    hdriNames().length === Object.keys(HDRI_ASSETS).length &&
    hdriNames().every((k) => HDRI_ASSETS[k] !== undefined);
  return [
    {
      name: "level format: a captured sky is named, not measured, and does not scale",
      pass: unscaled,
      detail: unscaled
        ? "name, rotation and background flag carried verbatim into metres"
        : `became ${JSON.stringify(converted)}`,
    },
    {
      name: "editor: a level's captured sky survives a save",
      pass: kept,
      detail: kept ? "carried verbatim" : `became ${JSON.stringify(back.environment)}`,
    },
    {
      name: "assets: every sky in the manifest is a labelled .hdr under /hdri/",
      pass: bad.length === 0 && listed,
      detail:
        bad.length === 0 && listed
          ? `${hdriNames().length} sk(ies): ${hdriNames().join(", ")}`
          : `${bad.map(([k]) => k).join(", ") || "the picker and the manifest disagree"}`,
    },
  ];
}

// WHAT KEEPS A LAMP AND ITS LIGHT TOGETHER, which is the whole reason a light is
// an object in a body rather than an entry in a list of its own.
//
// A lamp is two things - a fitting you can see and a light you cannot - and for a
// long time they were two authored objects at the same point that nothing kept in
// step, so moving the sconce left its light behind. The patch was to DERIVE a
// light from the fitting's emissive colour, out of seven fields describing a
// light in a second vocabulary. The guarantee is structural now: the light is
// INSIDE the body, so it rides that body's pose because there is nothing else it
// could do.
//
// Asserted on the scene graph, because nothing else can see it. A light in the
// wrong frame is a level that is simply lit somewhere else - it renders, every
// round trip passes, and no invariant has an opinion.
function lightRidesBody(): CaseResult[] {
  const rig = new LightRig();
  const body = new THREE.Group();
  // A body ten metres from the origin, as any real level has, and turned - which
  // is what a world-framed light gets wrong in two different ways at once.
  body.position.set(10, -4, 0);
  body.rotation.z = Math.PI / 2;
  const mounted = rig.add(body, { type: "light", kind: "spot", range: 5 }, { x: 0.3, y: 0, rot: 0, z: 0 });
  if (!mounted) {
    rig.dispose();
    return [{ name: "lights: a light rides the body it is in", pass: false, detail: "no light built" }];
  }
  body.updateWorldMatrix(true, true);
  const at = new THREE.Vector3();
  mounted.holder.getWorldPosition(at);
  // Placed 30 cm along the body's own +x, and the body is turned a quarter turn,
  // so in the world that 30 cm has become +y. A light left in world space would
  // still be 30 cm to the RIGHT of the body.
  const rode = Math.abs(at.x - 10) < 1e-9 && Math.abs(at.y - (-4 + 0.3)) < 1e-9;

  // ...and it keeps riding: move the body, and the light has moved with it
  // without anything having synced a transform, because it is a child.
  body.position.set(-2, 7, 0);
  body.updateWorldMatrix(true, true);
  mounted.holder.getWorldPosition(at);
  const followed = Math.abs(at.x - -2) < 1e-9 && Math.abs(at.y - 7.3) < 1e-9;
  rig.dispose();
  // Disposing hands the budget slot back; a rig that leaked one would light a
  // reloaded level less than the level it was reloaded from.
  const freed = rig.add(new THREE.Group(), { type: "light" }, { x: 0, y: 0, rot: 0, z: 0 }) !== null;

  return [
    {
      name: "lights: a light is placed in its body's frame, not the world's",
      pass: rode,
      detail: rode
        ? "30 cm along the body's +x lands where the body points"
        : `light at (${at.x.toFixed(3)}, ${at.y.toFixed(3)})`,
    },
    {
      name: "lights: it follows the body with no per-frame sync at all",
      pass: followed,
      detail: followed ? "moved with its parent" : `light at (${at.x.toFixed(3)}, ${at.y.toFixed(3)})`,
    },
    {
      name: "lights: a disposed rig hands its budget back",
      pass: freed,
      detail: freed ? "slot reusable" : "budget leaked",
    },
  ];
}

// Which way a spot throws, and the two conversions it goes through. Authored in
// the OBJECT's own frame, so turning the lamp turns the beam; and +y is DOWN in
// the sim and up in three, so an authored "down the level" has to come back
// negated. A sign error in either is a level that is simply dark, which nothing
// else reports.
function lightAim(): CaseResult[] {
  const rig = new LightRig();
  const scene = new THREE.Group();
  const aimed = (rot: number, dir: { dirX?: number; dirY?: number; dirZ?: number }) => {
    const holder = rig.add(scene, { type: "light", kind: "spot", range: 4, ...dir }, { x: 0, y: 0, rot, z: 0 });
    scene.updateWorldMatrix(true, true);
    const light = holder!.holder.children.find((c) => (c as THREE.SpotLight).isSpotLight) as THREE.SpotLight;
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    light.getWorldPosition(from);
    light.target.getWorldPosition(to);
    return to.sub(from).normalize();
  };
  // Absent, it points down the level - +y in sim terms - which is what a grate
  // overhead does. In three's frame that is -y.
  const def = aimed(0, {});
  const down = Math.abs(def.y + 1) < 1e-9 && Math.abs(def.x) < 1e-9;
  // The object's own rotation turns it. A quarter turn takes "down the level"
  // round to "along -x": rotation is clockwise-positive on screen because +y is
  // DOWN, so sim +y goes to sim -x, which is -x in three as well.
  const turned = aimed(Math.PI / 2, {});
  const rotated = Math.abs(turned.x + 1) < 1e-9 && Math.abs(turned.y) < 1e-9;
  // Authored lengths are arbitrary - it is a direction, so it arrives normalised.
  const long = aimed(0, { dirX: 30, dirY: 0, dirZ: -40 });
  const unit = Math.abs(long.length() - 1) < 1e-9 && Math.abs(long.x - 0.6) < 1e-9;
  // A direction of nothing would be a lamp aiming nowhere, which renders as a
  // lamp that does not work; it falls back rather than being refused.
  const zero = aimed(0, { dirX: 0, dirY: 0, dirZ: 0 });
  const fallback = Math.abs(zero.y + 1) < 1e-9;
  rig.dispose();
  return [
    {
      name: "lights: a spot with no aim points down the level, and a zero aim falls back",
      pass: down && fallback,
      detail: down && fallback ? "+y in the sim, -y in three" : `(${def.x.toFixed(2)}, ${def.y.toFixed(2)})`,
    },
    {
      name: "lights: its aim is in the object's own frame, so turning the lamp turns the beam",
      pass: rotated && unit,
      detail:
        rotated && unit
          ? "a quarter turn takes it to -x; arbitrary lengths normalise"
          : `turned (${turned.x.toFixed(2)}, ${turned.y.toFixed(2)}), unit ${long.length().toFixed(3)}`,
    },
  ];
}

// The authored shadow near plane lands on the shadow camera, and its clamps
// hold. Asserted on the built light because nothing else can see it: a wrong
// near plane still lights the level and still shadows it, just with the lantern
// case broken (the fitting back in its own shadow map) or the camera degenerate
// (near past far, which three renders as no shadow at all).
function lightShadowNear(): CaseResult[] {
  const rig = new LightRig();
  const scene = new THREE.Group();
  const built = (data: Partial<Omit<LightObjectData, "type">>) => {
    const holder = rig.add(scene, { type: "light", castShadow: true, ...data }, { x: 0, y: 0, rot: 0, z: 0 });
    const light = holder!.holder.children.find(
      (c) => (c as THREE.Light).isLight,
    ) as THREE.PointLight;
    return light.shadow.camera;
  };
  // A 30 cm lantern around a 6 m lamp: the fitting is inside the near plane.
  const lantern = built({ shadowNear: 0.3, range: 6 });
  const applied = lantern.near === 0.3 && lantern.far === 6;
  // Absent, the default - the lamp-clear-of-its-fitting case, unchanged.
  const plain = built({ range: 6 });
  const defaulted = plain.near === LIGHT_SHADOW_NEAR;
  // Over-authored: a near past the reach is capped at half of it, so the camera
  // still has depth to work in rather than a near past its far.
  const over = built({ shadowNear: 40, range: 6 });
  const capped = over.near === 3 && over.far === 6;
  // `range: 0` is three's "no cutoff", so the cap has nothing to cap against
  // and the floor is what must win - the default, not a degenerate 0.
  const cutless = built({ shadowNear: 0.5, range: 0 });
  const floored = cutless.near === LIGHT_SHADOW_NEAR && cutless.far > cutless.near;
  rig.dispose();
  return [
    {
      name: "lights: an authored shadowNear is the shadow camera's near plane",
      pass: applied && defaulted,
      detail:
        applied && defaulted
          ? "authored 0.3 lands; absent is the default"
          : `authored near ${lantern.near}, far ${lantern.far}; default near ${plain.near}`,
    },
    {
      name: "lights: shadowNear is capped at half the reach and floored at the default",
      pass: capped && floored,
      detail:
        capped && floored
          ? "40 on a 6 m lamp caps at 3; 0.5 on a cutoff-free lamp floors at the default"
          : `capped near ${over.near}, far ${over.far}; range-0 near ${cutless.near}, far ${cutless.far}`,
    },
  ];
}

// A body has an AUTHORED frame and an ENGINE frame, and they are deliberately
// not the same point: the engine's origin has to be the pieces' combined centre
// of mass (every lever arm in the engine is measured from it) and it moves as
// pieces are added, while the authored one has to stay put or every offset in a
// body would shift whenever a piece was added to it.
//
// `buildLevelBodies` absorbs the difference once, at load. Getting it wrong is
// silent in the way this whole layer's bugs are silent: the level builds, the
// physics is right, and the lamp is drawn somewhere else.
function bodyFrame(): CaseResult[] {
  const world = new World();
  const data = scaleLevelData(
    {
      player: { x: 0, y: 0, radius: 8 },
      bodies: [
        {
          kind: "static",
          x: 300,
          y: -100,
          rot: Math.PI / 2,
          objects: [
            // Two pieces either side of the body's origin, so the centre of mass
            // is the origin and a light at a local offset is demonstrably not.
            { type: "collision", x: -100, shape: { kind: "rect", w: 100, h: 100 } },
            { type: "collision", x: 100, shape: { kind: "rect", w: 100, h: 100 } },
            { type: "light", x: 0, y: 200, range: 400 },
          ],
        },
      ],
    },
    PX,
  );
  const built = buildLevelBodies(world, data, () => {});
  const b = built.bodies[0]!;
  const engine = b.body!;
  // Two equal pieces at ±1 m along the body's own +x, which a quarter turn sends
  // to ±1 m in y: their centre of mass is the authored origin.
  const com =
    Math.abs(engine.globalPosition.x - 3) < 1e-9 && Math.abs(engine.globalPosition.y - -1) < 1e-9;
  const twoPieces = engine.getShapes().length === 2;
  // The light is 2 m along the body's own +y, which the quarter turn sends to
  // -2 m in x. That is where `worldPlacement` says it is, and where
  // `localPlacement` has to put it relative to whatever the engine chose.
  const light = data.bodies[0]!.objects.find(isLightObject)!;
  const w = worldPlacement(data.bodies[0]!, light);
  const local = localPlacement(b, light);
  const resolved = engine.globalPosition.add(local.pos.rotated(engine.globalRotation));
  const agrees = Math.abs(w.pos.x - 1) < 1e-9 && Math.abs(w.pos.y - -1) < 1e-9;
  const round = resolved.distanceTo(w.pos) < 1e-9;
  return [
    {
      name: "bodies: the engine origin is the pieces' centre of mass, not the authored one",
      pass: com && twoPieces,
      detail:
        com && twoPieces
          ? "two pieces, origin at their centre of mass"
          : `origin (${engine.globalPosition.x.toFixed(3)}, ${engine.globalPosition.y.toFixed(3)}), ${engine.getShapes().length} piece(s)`,
    },
    {
      name: "bodies: an object placed in the body's frame lands where the body points",
      pass: agrees,
      detail: agrees
        ? "2 m along the body's +y, a quarter turn round"
        : `world (${w.pos.x.toFixed(3)}, ${w.pos.y.toFixed(3)})`,
    },
    {
      name: "bodies: resolving it through the engine frame gives the same point back",
      pass: round,
      detail: round ? "authored and engine frames agree" : `off by ${resolved.distanceTo(w.pos).toFixed(6)} m`,
    },
  ];
}

// The editor's "Origin to COM" (`originToCentroid`): the body's origin moves
// onto its centre of mass and every object's offset takes up the step, so the
// level does not move.
//
// Asserted across the round trip an author actually performs - press it, autosave,
// reopen - because the frame is the one thing about a body that is NOT in the
// model's items. A load that re-derived it from a member would put the origin
// back on that member, and since the editor rewrites the whole file, the next
// autosave would write that undo to disk.
function originToCom(): CaseResult[] {
  const drawn: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "rigid",
        x: 100,
        y: 200,
        rot: 0,
        color: "#555555",
        opacity: 1,
        friction: 1,
        // A bearing, because it is the one thing besides an object placement
        // that is recorded IN the frame and so has to be carried with it.
        pivot: true,
        pivotX: 40,
        pivotY: 0,
        objects: [
          // Two equal boxes, so the centre of mass is halfway between them -
          // 100 px along from the origin the first one sits on.
          { type: "collision", shape: { kind: "rect", w: 40, h: 40 } },
          { type: "collision", x: 200, y: 0, shape: { kind: "rect", w: 40, h: 40 } },
        ],
      },
    ],
  };
  // Every world point the body states, so a frame move that forgot one shows up:
  // the objects, and the bearing.
  const points = (d: RawLevelData): { pos: Vec2; rot: number }[] => {
    const b = d.bodies[0] as LevelBodyData;
    return [
      ...b.objects.map((o) => worldPlacement(b, o)),
      worldPlacement(b, { x: b.pivotX ?? 0, y: b.pivotY ?? 0 }),
    ];
  };
  const before = modelToDisk(modelFromDisk(drawn));

  const model = modelFromDisk(drawn);
  const bodyId = model.items[0]!.bodyId;
  const moved = originToCentroid(model, bodyId);
  const saved = modelToDisk(model);
  // The frame the file now states, in pixels: 100 px along from where it was.
  const body = saved.bodies[0] as LevelBodyData;
  const onMass = Math.abs(body.x - 200) < 1e-9 && Math.abs(body.y - 200) < 1e-9;
  const stillThere = points(before).every(
    (p, i) => p.pos.distanceTo(points(saved)[i]!.pos) < 1e-9,
  );

  // Reopened, the origin is still on the mass and the file is the same file.
  const reopened = modelToDisk(modelFromDisk(saved));
  const survives = JSON.stringify(reopened) === JSON.stringify(saved);

  // ...and pressing it again does nothing, which is what greys the button out.
  const twice = modelFromDisk(saved);
  const againId = twice.items[0]!.bodyId;
  const idempotent = !originToCentroid(twice, againId);
  const centred = bodyCentroid(bodyMembers(twice.items, againId))
    .sub(bodyFrameOf(twice, againId).pos)
    .length();

  return [
    {
      name: "editor: Origin to COM puts the body's origin on its centre of mass",
      pass: moved && onMass,
      detail:
        moved && onMass
          ? "origin moved 100 px onto the mass"
          : `moved ${moved}, origin now (${body.x.toFixed(3)}, ${body.y.toFixed(3)}) px`,
    },
    {
      name: "editor: ...and every object and bearing stays where it was",
      pass: stillThere,
      detail: stillThere
        ? "offsets took up the step; nothing in the level moved"
        : points(before)
            .map((p, i) => `${p.pos.distanceTo(points(saved)[i]!.pos).toFixed(6)} m`)
            .join(", "),
    },
    {
      name: "editor: ...and the origin is still there when the level is reopened",
      pass: survives,
      detail: survives ? "byte-identical through save, load and save" : "the reopen moved it back",
    },
    {
      name: "editor: ...and pressing it again is a no-op",
      pass: idempotent && centred === 0,
      detail:
        idempotent && centred === 0
          ? "already on the mass, so nothing to undo"
          : `reported ${!idempotent ? "a move" : "no move"}, off by ${centred.toFixed(9)} m`,
    },
  ];
}

// An emission MAP is where a shape glows, as against how much: another set's
// map worn over whatever surface the shape has (`VisualData.emissiveTexture`).
// Two things about it are invisible everywhere else and are asserted here.
function emissiveMaps(): CaseResult[] {
  // It changes what the material IS - three.js reads the map from the material,
  // not from the mesh - so two shapes differing only in the map they wear may
  // not share one. Getting this wrong is silent: whichever was built first wins,
  // so either every wall glows or the lit one does not.
  const plain = surfaceKey({ material: "brick" });
  const lit = surfaceKey({ material: "brick", emissiveTexture: "brick" });
  // ...but only for a key that HAS an emission map. `brick` in this build does
  // not, so naming it must land on the plain material rather than on a second
  // one that renders identically - a cache split by a field that changes nothing
  // is a draw call per shape for no picture at all.
  const mapped = emissiveMapName("brick") !== "";
  const keyed = mapped ? plain !== lit : plain === lit;
  // An unknown key is nothing rather than a fallback surface's map, which is the
  // one place the texture resolution rules deliberately differ: `texture` falls
  // back so an unknown name is an ordinary wall, and this does not, because a
  // borrowed glow the author never asked for is not ordinary.
  const unknown = emissiveMapName("no such set") === "" && emissiveMapName(undefined) === "";
  const listed = emissiveMapNames().every((k) => emissiveMapName(k) === k);
  return [
    {
      name: "surfaces: an emission map is part of the material key exactly when it exists",
      pass: keyed,
      detail: keyed
        ? mapped
          ? "keyed apart"
          : "no emission map in this manifest, so no split"
        : `${plain} vs ${lit}`,
    },
    {
      name: "surfaces: an unknown emission map is no map at all",
      pass: unknown && listed,
      detail: unknown && listed ? `${emissiveMapNames().length} set(s) carry one` : "resolved to something",
    },
  ];
}


// Emission changes what a material IS, so it has to change the material CACHE
// KEY. Getting it wrong is invisible in every other check: the level renders,
// every round trip passes, and what happens is that whichever of the two was
// built first wins - so either every wall of that stone glows, or the lamp made
// of it does not.
function emissiveMaterials(): CaseResult[] {
  const plain = surfaceKey({ material: "stone" });
  const glowing = surfaceKey({ material: "stone", emissive: "#ff8844", emissiveIntensity: 3 });
  const dimmer = surfaceKey({ material: "stone", emissive: "#ff8844", emissiveIntensity: 1 });
  const again = surfaceKey({ material: "stone", emissive: "#ff8844", emissiveIntensity: 3 });
  const distinct = plain !== glowing && glowing !== dimmer;
  const stable = glowing === again;
  // A brightness multiplier on a shape that emits nothing multiplies black, so
  // it may NOT split the cache: every ordinary wall would otherwise get its own
  // material the moment the editor started writing a default alongside.
  const notSplit = plain === surfaceKey({ material: "stone", emissiveIntensity: 4 });
  return [
    {
      name: "surfaces: emission is part of the material key",
      pass: distinct && stable,
      detail:
        distinct && stable
          ? "one material per (surface, tint, emission)"
          : `distinct ${distinct}, cached ${stable}`,
    },
    {
      name: "surfaces: a glow multiplier with no glow colour does not split the cache",
      pass: notSplit,
      detail: notSplit ? "same key" : `${plain} vs ${surfaceKey({ material: "stone", emissiveIntensity: 4 })}`,
    },
  ];
}

// A prop that ships an emission MAP but no emissive FACTOR emits nothing, since
// glTF's default factor is black and three.js multiplies the two. `wakeEmission`
// lifts exactly that case to white on load. Asserted because the failure is
// silent in both directions: unrepaired, a lamp is simply dark and looks like a
// texture that failed to load; over-eager, it makes surfaces glow that never
// asked to.
function propEmission(): CaseResult[] {
  const withMap = (emissive: number) => {
    const m = new THREE.MeshStandardMaterial();
    m.emissiveMap = new THREE.Texture();
    m.emissive.setHex(emissive);
    wakeEmission(m);
    return m.emissive.getHex();
  };
  const bare = new THREE.MeshStandardMaterial();
  bare.emissive.setHex(0x000000);
  wakeEmission(bare);
  const woken = withMap(0x000000) === 0xffffff;
  const kept = withMap(0xff8844) === 0xff8844;
  const untouched = bare.emissive.getHex() === 0x000000;
  return [
    {
      name: "props: an emission map with no emissive factor is woken to white",
      pass: woken && kept,
      detail:
        woken && kept
          ? "black + map -> white, authored colour left alone"
          : `black -> ${withMap(0x000000).toString(16)}, authored -> ${withMap(0xff8844).toString(16)}`,
    },
    {
      name: "props: a material with no emission map is left dark",
      pass: untouched,
      detail: untouched ? "no map, no glow" : "lit a material that ships no emission",
    },
    ...propGlow(),
  ];
}

// A prop whose geometry object authors `emissive` (the river's moss) glows in
// its own pattern: its materials are swapped for cached copies, the file's own
// materials are left alone, and the mask is spliced into three's real
// physical fragment shader.
function propGlow(): CaseResult[] {
  const prop = () => {
    const group = new THREE.Group();
    const source = new THREE.MeshPhysicalMaterial({ color: 0x44aa44 });
    group.add(new THREE.Mesh(new THREE.BufferGeometry(), source));
    group.add(new THREE.Mesh(new THREE.BufferGeometry(), [source, new THREE.MeshBasicMaterial()]));
    return { group, source };
  };
  const { group, source } = prop();
  const twin = group.clone(true);
  glowProp(group, "#2fe6d0", 0.6);
  glowProp(twin, "#2fe6d0", 0.6);
  const [one, many] = group.children as THREE.Mesh[];
  const copy = one!.material as THREE.MeshStandardMaterial;
  const arr = many!.material as THREE.Material[];
  const swapped =
    copy !== source &&
    copy.emissive.getHexString() === "2fe6d0" &&
    copy.emissiveIntensity === 0.6 &&
    source.emissive.getHex() === 0 &&
    arr[0] === copy &&
    (arr[1] as THREE.MeshBasicMaterial).isMeshBasicMaterial === true &&
    (twin.children[0] as THREE.Mesh).material === copy;

  const fragment = THREE.ShaderLib.physical.fragmentShader;
  const patched = patchGlow(fragment);
  const spliced =
    patched.includes("uniform vec2 uGlowRange;") &&
    patched.indexOf("smoothstep( uGlowRange.x") > patched.indexOf("#include <emissivemap_fragment>");
  let refused = false;
  try {
    patchGlow("void main() {}");
  } catch {
    refused = true;
  }

  const lum = Array.from({ length: 100 }, (_, i) => i / 100);
  const [lo, hi] = stretch(lum);
  const [flatLo, flatHi] = stretch([0.2, 0.2, 0.2]);
  const stretched = lo === 0.05 && hi === 0.95 && flatHi > flatLo;

  return [
    {
      name: "props: an authored glow swaps a prop's materials for shared glowing copies and leaves the file's own dark",
      pass: swapped,
      detail: `copy ${copy !== source} emissive #${copy.emissive.getHexString()} x${copy.emissiveIntensity}, source #${source.emissive.getHexString()}, shared across mounts ${(twin.children[0] as THREE.Mesh).material === copy}`,
    },
    {
      name: "props: the glow mask is spliced after three's emissive chunk, and a three without it is refused",
      pass: spliced && refused,
      detail: `spliced ${spliced}, refused ${refused}`,
    },
    {
      name: "props: the glow mask spans its map's 5th to 95th luminance percentile, and a flat map divides by nothing",
      pass: stretched,
      detail: `ramp -> ${lo}..${hi}, flat -> ${flatLo}..${flatHi}`,
    },
  ];
}

// THE REAL LEVEL, through the editor's save path. Every case above is a fixture
// small enough to reason about, and a fixture is exactly what a silent drop
// hides from: the loss is in the shape the fixture does not have.
//
// It earns its place because the editor rewrites the whole file every 750 ms
// while a level is open, so anything its round trip does not carry is gone from
// disk before anyone notices it was read - and the failure is invisible in the
// editor itself, which goes on drawing the model it holds. It is asserted on
// COUNTS rather than bytes because the editor legitimately re-origins bodies and
// folds a dressing onto the object it dresses; what may never change is how much
// of the level there is.
//
// The level arrives through the registry's own import rather than off disk, so
// this case keeps `cli render3d` pure - no filesystem, no canvas, no GPU.
function realLevelRoundTrip(): CaseResult[] {
  const tally = (d: LevelData) => ({
    bodies: d.bodies.length,
    objects: d.bodies.reduce((n, b) => n + b.objects.length, 0),
    collision: d.bodies.reduce((n, b) => n + b.objects.filter(isCollisionObject).length, 0),
    geometry: d.bodies.reduce((n, b) => n + b.objects.filter(isGeometryObject).length, 0),
    lights: d.bodies.reduce((n, b) => n + b.objects.filter(isLightObject).length, 0),
    chains: d.chains?.length ?? 0,
  });
  const before = tally(normalizeLevelData(BALL_LEVEL as RawLevelData));
  const after = tally(modelToDisk(modelFromDisk(BALL_LEVEL as RawLevelData)));
  const same = JSON.stringify(before) === JSON.stringify(after);
  return [
    {
      name: "editor: the authored ball level survives a save with nothing dropped",
      pass: same,
      detail: same
        ? `${before.bodies} bodies, ${before.objects} objects (${before.collision} collision, ${before.geometry} geometry, ${before.lights} lights), ${before.chains} chains`
        : `\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`,
    },
  ];
}

// WATER: one authored speed, one authored rate, and a surface to displace.
//
// The format half is the units. `flow` is a speed and `drag` is a reciprocal
// time, so exactly one of them converts between the file's pixels and the sim's
// metres - and both failure modes are silent. A `drag` scaled by 1/100 is water
// that takes twenty seconds to notice a body has fallen in it; a `flow` left in
// pixels is a current a hundred times too fast, which reads as the level
// exploding rather than as a units bug. Neither is visible in a screenshot of
// the editor, where both numbers are shown in the units they were typed in.
//
// The geometry half is the waterline. A rect has four corners, and a four-corner
// top edge cannot ripple however good the shader is: the vertices the waves live
// on have to be built, and `aWave` has to say which of them are the surface.
function waterFormat(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "water",
        x: 100,
        y: 200,
        rot: 0,
        color: "#3d6b52",
        opacity: 1,
        friction: 1,
        flow: -150,
        drag: 5,
        spill: 200,
        spillSpeed: 100,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 2430, h: 46 } },
          { type: "geometry" },
        ],
      },
    ],
  };
  const a = flattened(scaleLevelData(normalizeLevelData(authored), 1));
  const b = flattened(
    scaleLevelData(scaleLevelData(normalizeLevelData(authored), PX), PIXELS_PER_METER),
  );
  const inMetres = normalizeLevelData(authored);
  const scaled = scaleLevelData(inMetres, PX);
  // The spill is a drop and a speed - two more lengths that convert.
  const units =
    scaled.bodies[0]!.flow === -1.5 &&
    scaled.bodies[0]!.drag === 5 &&
    scaled.bodies[0]!.spill === 2 &&
    scaled.bodies[0]!.spillSpeed === 1;
  const saved = modelToDisk(modelFromDisk(authored));
  const kept =
    saved.bodies[0]!.flow === -150 &&
    saved.bodies[0]!.drag === 5 &&
    saved.bodies[0]!.spill === 200 &&
    saved.bodies[0]!.spillSpeed === 100;

  return [
    {
      name: "level format: water round-trips px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
    {
      name: "level format: a water current is a speed and its drag is a rate",
      pass: units,
      detail: units
        ? "flow -150 px/s -> -1.5 m/s, drag 5/s unchanged"
        : `flow ${scaled.bodies[0]!.flow}, drag ${scaled.bodies[0]!.drag}`,
    },
    {
      name: "editor: a water area keeps its current through a save",
      pass: kept,
      detail: kept ? "flow and drag survive" : JSON.stringify(saved.bodies[0]),
    },
  ];
}

// A TRAMPOLINE: one authored ratio and one authored speed.
//
// The same units trap water sets, and the same silence when it is sprung. A
// `bounce` is dimensionless, so scaling it would make every pad a hundred times
// bouncier than it was typed; a `launch` is a speed, so leaving it in pixels
// makes a pad that throws the ball a hundred times as far. Neither is visible in
// the editor, which shows both in the units they were typed in.
//
// And the editor round trip, because the pair is written CONDITIONALLY (an
// unset field stays off disk, so a level of ordinary walls does not grow a
// `bounce: 0` on every body). A conditional write is exactly the shape of thing
// that loses a value: the condition is one more place the field can be
// forgotten, and the editor rewrites the file every 750 ms.
function bounceFormat(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 300,
        rot: 0,
        color: "#8a4f7d",
        opacity: 1,
        friction: 1,
        bounce: 0.6,
        launch: 900,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 300, h: 40 } },
          { type: "geometry" },
        ],
      },
      // A body that authors NEITHER, so the conditional write is asserted in
      // both directions: a wall must not come back from the editor carrying a
      // pad's fields at zero.
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        friction: 1,
        objects: [{ type: "collision", shape: { kind: "rect", w: 300, h: 40 } }],
      },
    ],
  };
  const a = flattened(scaleLevelData(normalizeLevelData(authored), 1));
  const b = flattened(
    scaleLevelData(scaleLevelData(normalizeLevelData(authored), PX), PIXELS_PER_METER),
  );
  const scaled = scaleLevelData(normalizeLevelData(authored), PX);
  const units = scaled.bodies[0]!.bounce === 0.6 && scaled.bodies[0]!.launch === 9;
  const saved = modelToDisk(modelFromDisk(authored));
  const kept =
    saved.bodies[0]!.bounce === 0.6 &&
    saved.bodies[0]!.launch === 900 &&
    saved.bodies[1]!.bounce === undefined &&
    saved.bodies[1]!.launch === undefined;

  return [
    {
      name: "level format: a trampoline round-trips px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
    {
      name: "level format: a bounce is a ratio and a launch is a speed",
      pass: units,
      detail: units
        ? "bounce 0.6 unchanged, launch 900 px/s -> 9 m/s"
        : `bounce ${scaled.bodies[0]!.bounce}, launch ${scaled.bodies[0]!.launch}`,
    },
    {
      name: "editor: a trampoline keeps its throw through a save, and a wall gains none",
      pass: kept,
      detail: kept
        ? "bounce and launch survive, and stay off a body that authors neither"
        : JSON.stringify([saved.bodies[0], saved.bodies[1]]),
    },
  ];
}

// NOTHING BUT A GEOMETRY OBJECT DRAWS. A collision shape used to draw itself
// whenever no one said otherwise, and this is the case that keeps that from
// creeping back: the old default was invisible by construction (a level that
// relied on it looked right, so nothing reported it), and the same is true of a
// regression - a stray extrusion beside an authored mesh reads as a level that
// needs its geometry nudged rather than as a renderer drawing twice.
//
// The migration half matters just as much. Every level on disk was authored
// under the old default, so `withGeometryTwin` is the only thing standing
// between the split and a hundred and twenty-eight invisible bodies.
function renderNeedsGeometry(): CaseResult[] {
  // Built as `LevelData` rather than through `normalizeLevelData`, deliberately:
  // the gate would hand this body the geometry object it is asserting the
  // absence of.
  const level = (objects: SceneObjectData[]): LevelData => ({
    player: { x: 0, y: 0, radius: 8 * PX },
    bodies: [{ kind: "static", x: 0, y: 0, rot: 0, objects }],
  });
  const shape = { kind: "rect" as const, w: 1, h: 1 };
  const drawnBy = (objects: SceneObjectData[]) => drawnObjects(level(objects).bodies[0]!);

  const bare = drawnBy([{ type: "collision", shape }]);
  // A geometry object draws its OWN form, wherever the collision objects are and
  // however many of them there are. A compound body of two pieces dressed by one
  // primitive draws ONE thing - the primitive - and not one per piece.
  const compound = drawnBy([
    { type: "collision", shape },
    { type: "collision", x: 2, shape },
    { type: "geometry", texture: "brick", shape: { kind: "rect", w: 3, h: 1 } },
  ]);
  const decoupled =
    compound.length === 1 &&
    compound[0]!.shape?.kind === "rect" &&
    (compound[0]!.shape as { w: number }).w === 3;

  // ...and the migration that keeps every level authored under the old default
  // looking as it did. It is asked of a LEGACY body - a flat entry carrying its
  // own shape - because that is the only form the old default was ever expressed
  // in, and the only form the migration still runs on.
  //
  // What it must produce is the whole claim of the decoupling: a PRIMITIVE that
  // states the outline, the placement, the depth and the surface the extrusion
  // used to read off the collision object, so the level looks identical while
  // nothing is being read off anything any more.
  const legacy: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 * PX },
    bodies: [
      { kind: "static", x: 3, y: -5, rot: 0.25, shape, thickness: 0.4, material: "stone" },
    ],
  };
  const once = normalizeLevelData(legacy);
  const twice = normalizeLevelData(once);
  const twin = once.bodies[0]!.objects.filter(isGeometryObject);
  const collision = once.bodies[0]!.objects.filter(isCollisionObject)[0]!;
  const g = twin[0];
  const migrated =
    twin.length === 1 &&
    JSON.stringify(g!.shape) === JSON.stringify(collision.shape) &&
    g!.x === collision.x &&
    g!.y === collision.y &&
    g!.rot === collision.rot &&
    g!.depth === collision.thickness &&
    g!.texture === collision.material;
  const stable = twice.bodies[0]!.objects.length === once.bodies[0]!.objects.length;
  // ...and the other half of that rule, which is what makes a bare collision
  // shape an authorable thing rather than a state the loader edits away. A body
  // already in the nested form said what objects it has; a load that added a
  // geometry object to it would mean an author could draw a collision shape,
  // save, and get back a level saying something they did not write.
  const nested = normalizeLevelData(level([{ type: "collision", shape }]));
  const leftBare = nested.bodies[0]!.objects.filter(isGeometryObject).length === 0;
  // A body that already says how it looks is left alone. Twinning it too puts an
  // extrusion of the collision box inside the authored prop - a grey brick in the
  // middle of a lamp, drawn in play and absent from the editor.
  const authored = level([
    { type: "collision", shape },
    { type: "geometry", kind: "mesh", mesh: "bulkhead-lamp", shape },
  ]);
  const untouched =
    normalizeLevelData(authored).bodies[0]!.objects.length === authored.bodies[0]!.objects.length;

  return [
    {
      name: "render: a collision shape with no geometry object draws nothing",
      pass: bare.length === 0,
      detail: bare.length === 0 ? "not drawn" : "drawn by something",
    },
    {
      name: "render: a geometry object draws its own form, not the body's outlines",
      pass: decoupled,
      detail: decoupled
        ? "one primitive, its own 3 m shape"
        : `${compound.length} drawn: ${JSON.stringify(compound.map((o) => o.shape))}`,
    },
    {
      name: "render: a level authored under the old default gains the primitive that draws it",
      pass: migrated,
      detail: migrated
        ? "one primitive stating the outline, placement, depth and surface"
        : `wrote ${JSON.stringify(twin)}`,
    },
    {
      name: "render: and gains it exactly once, however many times it is loaded",
      pass: stable,
      detail: stable
        ? `${once.bodies[0]!.objects.length} objects, unchanged on a second pass`
        : `${once.bodies[0]!.objects.length} then ${twice.bodies[0]!.objects.length}`,
    },
    {
      name: "render: a body authored with a bare collision shape keeps it bare",
      pass: leftBare,
      detail: leftBare
        ? "no geometry object invented at load"
        : "the loader added a geometry object nobody authored",
    },
    {
      name: "render: a body that already says how it looks is left alone",
      pass: untouched,
      detail: untouched
        ? "authored geometry stands; no extrusion added beside it"
        : "an extrusion was added inside the authored prop",
    },
  ];
}

// A chain end is an ANCHOR OBJECT on a body, and the two halves of that are
// checked here because neither fails loudly. A migration that put the anchor in
// the wrong place gives a chain that is a few centimetres off and still swings;
// an anchor that did not ride its body would only show once something moved.
function chainAnchors(): CaseResult[] {
  // A body a long way out AND turned, which is what a body-local placement gets
  // wrong in two different ways at once.
  const rot = Math.PI / 6;
  const raw: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      { kind: "static", x: 0, y: 0, rot: 0, objects: [{ type: "collision", shape: { kind: "rect", w: 40, h: 40 } }] },
      { kind: "rigid", x: 300, y: -120, rot, objects: [{ type: "collision", shape: { kind: "rect", w: 40, h: 40 } }] },
    ],
    // Authored the retired way: a body INDEX and a WORLD point per end.
    chains: [{ a: { body: 0, x: 0, y: 0 }, b: { body: 1, x: 320, y: -100 } }],
  };
  const d = normalizeLevelData(raw);
  const anchors = d.bodies.flatMap((b) =>
    b.objects.filter(isAnchorObject).map((o) => ({ body: b, anchor: o })),
  );
  const chain = d.chains![0]!;
  // Two anchors, one per body, and the chain names them rather than the bodies.
  const shaped =
    anchors.length === 2 &&
    typeof chain.a === "number" &&
    chain.a === anchors[0]!.anchor.id &&
    chain.b === anchors[1]!.anchor.id;
  // ...and the placement survives the trip into the body's frame. The end
  // authored at world (320, -100) has to resolve back to exactly that, which is
  // the half a rotated body is what tests at all.
  const back = worldPlacement(anchors[1]!.body, anchors[1]!.anchor).pos;
  const placed = Math.abs(back.x - 320) < 1e-9 && Math.abs(back.y - -100) < 1e-9;
  // ...and it RIDES. Turn the body another quarter turn and the anchor's world
  // point turns with it, with nothing re-derived and nothing else touched.
  const turned = { ...anchors[1]!.body, rot: rot + Math.PI / 2 };
  const after = worldPlacement(turned, anchors[1]!.anchor).pos;
  const before = back.sub(new Vec2(anchors[1]!.body.x, anchors[1]!.body.y));
  const want = before.rotated(Math.PI / 2).add(new Vec2(turned.x, turned.y));
  const rode = after.distanceTo(want) < 1e-9;
  // Loading twice must not mint a second pair. The gate rewrites the chain to
  // the new form, so the second pass has nothing legacy left to convert -
  // getting this wrong doubled the anchors of the real level on every save.
  const twice = normalizeLevelData(d);
  const stable = twice.bodies.flatMap((b) => b.objects.filter(isAnchorObject)).length === 2;
  // The same, through the EDITOR, which is where the anchors have to survive as
  // objects and the chain as a pair of ids.
  const round = modelToDisk(modelFromDisk(raw));
  const kept =
    round.chains?.length === 1 &&
    round.bodies.flatMap((b) => b.objects.filter(isAnchorObject)).length === 2;

  return [
    {
      name: "chains: a retired chain end becomes an anchor object the chain names by id",
      pass: shaped,
      detail: shaped ? `2 anchors, chain ${chain.a} → ${chain.b}` : JSON.stringify(chain),
    },
    {
      name: "chains: the anchor lands exactly where it was authored in world space",
      pass: placed,
      detail: placed ? "(320, -100) through a body turned 30°" : `(${back.x.toFixed(6)}, ${back.y.toFixed(6)})`,
    },
    {
      name: "chains: and rides its body from then on, with nothing re-derived",
      pass: rode,
      detail: rode ? "turned with the body" : `off by ${after.distanceTo(want).toFixed(6)} m`,
    },
    {
      name: "chains: loading a migrated level again mints no second pair of anchors",
      pass: stable,
      detail: stable ? "2 anchors, unchanged on a second pass" : `${twice.bodies.flatMap((b) => b.objects.filter(isAnchorObject)).length} anchors`,
    },
    {
      name: "chains: anchors and the chain that names them survive the editor round trip",
      pass: kept,
      detail: kept ? "2 anchors, 1 chain" : JSON.stringify(round.chains),
    },
  ];
}

// A chain's WRAP POINTS (`ChainData.via`) and a piece's collision MASK are both
// content the format has to carry unchanged: through the pixel-to-metre scale
// every load applies, and through the editor, where a wrap point is an anchor
// item like the ends and the mask is a row of per-piece checkboxes. Neither
// failing is loud - a dropped `via` is a chain that hangs straight, a dropped
// mask is a rim the chain suddenly winds onto.
//
// The rim is authored in the RETIRED spelling (`wrappable: false`), so the
// migration to `passes: ["chain"]` is asserted at the same time and on the one
// gate it runs in (`normalizeLevelData`). A level on disk still carries the old
// key; what comes out of the gate never does.
function chainWrapPoints(): CaseResult[] {
  const raw: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "rigid",
        pivot: true,
        x: 0,
        y: 0,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "circle", r: 100 }, wrappable: false },
          { type: "collision", shape: { kind: "circle", r: 25 } },
          { type: "anchor", id: 1, x: 0, y: -25 },
        ],
      },
      {
        kind: "static",
        x: 300,
        y: -300,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 40, h: 20 } },
          { type: "anchor", id: 2, x: -20, y: -10 },
        ],
      },
      {
        kind: "rigid",
        x: 320,
        y: 100,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 60, h: 60 } },
          { type: "anchor", id: 3, x: 0, y: -30 },
        ],
      },
    ],
    chains: [{ a: 1, b: 3, via: [2] }],
  };
  const scaled = scaleLevelData(raw, 0.01);
  const viaScaled = JSON.stringify(scaled.chains?.[0]?.via) === "[2]";
  const rim = scaled.bodies[0]!.objects[0]!;
  const flagScaled =
    rim.type === "collision" &&
    JSON.stringify(rim.passes) === '["chain"]' &&
    rim.wrappable === undefined;

  const round = modelToDisk(modelFromDisk(raw));
  const rc = round.chains?.[0];
  const viaKept =
    round.chains?.length === 1 &&
    rc !== undefined &&
    typeof rc.a === "number" &&
    Array.isArray(rc.via) &&
    rc.via.length === 1 &&
    round.bodies.flatMap((b) => b.objects.filter(isAnchorObject)).some((o) => o.id === rc.via![0]) &&
    round.bodies[1]!.objects.some((o) => isAnchorObject(o) && o.id === rc.via![0]);
  const roundRim = round.bodies[0]!.objects[0]!;
  const roundHub = round.bodies[0]!.objects[1]!;
  const flagKept =
    roundRim.type === "collision" &&
    JSON.stringify(roundRim.passes) === '["chain"]' &&
    roundHub.type === "collision" &&
    roundHub.passes === undefined;

  return [
    {
      name: "chains: a wrap point and a piece's mask survive the scale every load applies",
      pass: viaScaled && flagScaled,
      detail: viaScaled && flagScaled ? 'via [2], rim passes ["chain"]' : JSON.stringify({ via: scaled.chains?.[0]?.via, rim }),
    },
    {
      name: "chains: ...and the editor round trip, the wrap point as an anchor on the beam",
      pass: viaKept && flagKept,
      detail: viaKept && flagKept ? "1 chain, via on body 1, rim masked, hub not" : JSON.stringify({ chain: rc, rim: roundRim, hub: roundHub }),
    },
  ];
}

// CHECKPOINTS: named spawns, reached by `?checkpoint=NAME` (see
// `CheckpointData`).
//
// Three things are worth holding, and all three are silent when they break. The
// placement is a LENGTH and the name is not, which is the units trap water and
// the trampoline both set. The editor rewrites the file every 750 ms, so a
// checkpoint it does not know about is a checkpoint deleted the first time the
// level is opened - and it must land in `checkpoints` rather than in `notes`,
// since it is authored on the notes layer beside the annotations. And the
// lookup is what the URL asks through, so the trimming and the case-folding are
// the feature rather than a nicety.
function checkpointFormat(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 300,
        rot: 0,
        friction: 1,
        objects: [{ type: "collision", shape: { kind: "rect", w: 300, h: 40 } }],
      },
    ],
    notes: [{ kind: "text", x: 0, y: -100, rot: 0, w: 240, h: 80, text: "why", size: 12 }],
    checkpoints: [
      { name: "vines", x: 400, y: -200 },
      { name: "the gap", x: -800, y: 120 },
    ],
  };
  const list = (d: LevelData): string => JSON.stringify(d.checkpoints);
  const a = list(scaleLevelData(normalizeLevelData(authored), 1));
  const b = list(scaleLevelData(scaleLevelData(normalizeLevelData(authored), PX), PIXELS_PER_METER));
  const scaled = scaleLevelData(normalizeLevelData(authored), PX);
  const units = scaled.checkpoints?.[0]?.x === 4 && scaled.checkpoints[0]?.name === "vines";

  const saved = modelToDisk(modelFromDisk(authored));
  const kept =
    saved.checkpoints?.length === 2 &&
    saved.checkpoints[1]?.name === "the gap" &&
    Math.round(saved.checkpoints[1].x) === -800 &&
    // ...and the annotation beside them is still an annotation: the two share a
    // layer in the editor and must not share a list on disk.
    saved.notes?.length === 1 &&
    saved.notes[0]?.kind === "text";

  // Asked for the way a playtester types it: a different case, with the spaces
  // a browser leaves on either side of a pasted name.
  const moved = spawnAtCheckpoint(authored, " The Gap ");
  const hit = moved.player.x === -800 && moved.player.y === 120 && authored.player.x === 0;
  const missed = spawnAtCheckpoint(authored, "nowhere");
  const none = spawnAtCheckpoint(authored, null);
  const left = missed.player.x === 0 && none.player.x === 0;

  // A name nothing can ask for, and a name that would answer to something
  // else's request. Both are mid-edit states rather than errors, so the
  // conversion KEEPS them - this function is the editor's save as well as the
  // game's load, and dropping one deletes a marker that was placed a moment ago
  // and not yet named. What they do at the lookup is the assertion: a blank
  // request matches nothing, and a repeated name keeps meaning the first.
  const slippy: RawLevelData = {
    ...authored,
    checkpoints: [
      { name: "vines", x: 400, y: -200 },
      { name: "  ", x: 0, y: 0 },
      { name: "VINES", x: 999, y: 999 },
    ],
  };
  const slips = scaleLevelData(normalizeLevelData(slippy), 1);
  const kept3 = slips.checkpoints?.length === 3;
  const firstWins = spawnAtCheckpoint(slippy, "vines").player.x === 400;
  const blankAsks = spawnAtCheckpoint(slippy, "   ").player.x === 0;
  const slipsHandled = kept3 && firstWins && blankAsks;

  return [
    {
      name: "level format: a checkpoint round-trips px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
    {
      name: "level format: a checkpoint's placement is a length and its name is not",
      pass: units,
      detail: units
        ? "x 400 px -> 4 m, name unchanged"
        : `x ${scaled.checkpoints?.[0]?.x}, name ${scaled.checkpoints?.[0]?.name}`,
    },
    {
      name: "editor: a checkpoint survives a save, and stays out of the notes",
      pass: kept,
      detail: kept
        ? "2 checkpoints, 1 note"
        : JSON.stringify({ checkpoints: saved.checkpoints, notes: saved.notes }),
    },
    {
      name: "level format: ?checkpoint= moves the spawn, trimmed and ignoring case",
      pass: hit,
      detail: hit
        ? "' The Gap ' -> (-800, 120), the level itself untouched"
        : JSON.stringify(moved.player),
    },
    {
      name: "level format: an unknown or absent checkpoint leaves the spawn alone",
      pass: left,
      detail: left ? "both start at the level's spawn" : JSON.stringify([missed.player, none.player]),
    },
    {
      name: "level format: a blank or repeated checkpoint name is kept, and asks for nothing",
      pass: slipsHandled,
      detail: slipsHandled
        ? "3 of 3 written; `vines` finds the first, a blank request finds none"
        : JSON.stringify({ kept: slips.checkpoints?.length, firstWins, blankAsks }),
    },
  ];
}

// THE LEVEL BLOCK and the FINISH KIND (see `LevelMetaData` and the `finish`
// body kind), held to the two things that carry them.
//
// Neither is a length, so both have to cross `scaleLevelData` untouched - the
// units trap the trampoline's `bounce`/`launch` pair sets, and the same silent
// failure: a title is not a number, but a field the scaler does not enumerate is
// DROPPED rather than reported, and the loss shows up as a level that has fallen
// off the menu with nothing to say why.
//
// And the editor rewrites the whole file every 750 ms, so a block it does not
// carry is a block deleted the first time the level is opened. That is what the
// `hang` flag and the `environment` block each cost an afternoon to learn, and
// it is what `EdModel.meta` exists for.
function levelMetaFormat(): CaseResult[] {
  const authored: RawLevelData = {
    meta: { title: "The Long Fall", intro: true },
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 300,
        rot: 0,
        objects: [{ type: "collision", shape: { kind: "rect", w: 300, h: 40 } }],
      },
      {
        // The finish line: a region across the way out, with the gantry that
        // marks it mounted on the same body.
        kind: "finish",
        x: 100,
        y: -100,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 520, h: 450 } },
          {
            type: "geometry",
            kind: "mesh",
            mesh: "finish-line",
            shape: { kind: "rect", w: 259, h: 247 },
            scale: 0.4,
          },
        ],
      },
    ],
  };

  const meta = (d: LevelData): string => JSON.stringify(d.meta);
  const a = meta(scaleLevelData(normalizeLevelData(authored), 1));
  const b = meta(scaleLevelData(scaleLevelData(normalizeLevelData(authored), PX), PIXELS_PER_METER));
  const scaled = scaleLevelData(normalizeLevelData(authored), PX);
  // A title and a kind are not lengths and the region's own width is: the block
  // and the kind cross whole while the geometry beside them converts, which is
  // the split that says the scaler read all three and mixed none of them up.
  const gate = scaled.bodies[1]!;
  const gateShape = gate.objects[0]!;
  const units =
    scaled.meta?.title === "The Long Fall" &&
    scaled.meta.intro === true &&
    gate.kind === "finish" &&
    gateShape.type === "collision" &&
    gateShape.shape.kind === "rect" &&
    gateShape.shape.w === 5.2;

  const saved = modelToDisk(modelFromDisk(authored));
  const savedGate = saved.bodies[1]!;
  const kept =
    saved.meta?.title === "The Long Fall" &&
    saved.meta.intro === true &&
    saved.meta.unlisted === undefined &&
    savedGate.kind === "finish" &&
    savedGate.objects.some((o) => o.type === "geometry" && o.mesh === "finish-line");
  // ...and a level that authors NO block writes none, which is what keeps every
  // level from before the field byte-identical through a save.
  const { meta: _dropped, ...bare } = authored;
  const bareSaved = modelToDisk(modelFromDisk(bare as RawLevelData));
  const silent = bareSaved.meta === undefined;

  // The gantry's own SCALE, which is the second not-a-length on this body and
  // the one with nowhere else to be recovered from: a prop's size in a level is
  // a decision somebody made by eye, and a scaler or a save that dropped it
  // would put a 6.5 m gate where a 2.6 m one was authored, with nothing to say
  // what happened.
  const savedMesh = savedGate.objects.find((o) => o.type === "geometry");
  const scaledMesh = gate.objects.find((o) => o.type === "geometry");
  const propScale =
    savedMesh?.type === "geometry" &&
    savedMesh.scale === 0.4 &&
    scaledMesh?.type === "geometry" &&
    scaledMesh.scale === 0.4;

  return [
    {
      name: "level format: the level block round-trips px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
    {
      name: "level format: a title and a body kind are not lengths, and the region beside them is",
      pass: units,
      detail: units
        ? "title and `finish` unchanged, the gate 520 px -> 5.2 m"
        : JSON.stringify({ meta: scaled.meta, kind: gate.kind, shape: gateShape }),
    },
    {
      name: "editor: the level block and the finish line survive a save",
      pass: kept,
      detail: kept
        ? "title, intro, the `finish` kind and its gantry all written back"
        : JSON.stringify({ meta: saved.meta, kind: savedGate.kind, objects: savedGate.objects.length }),
    },
    {
      name: "editor: a level that authors no level block still writes none",
      pass: silent,
      detail: silent ? "no `meta` key" : JSON.stringify(bareSaved.meta),
    },
    {
      name: "level format: the gantry's scale is not a length either, through the scaler and through a save",
      pass: propScale,
      detail: propScale
        ? "`scale` 0.4 unchanged by both"
        : JSON.stringify({ scaled: scaledMesh, saved: savedMesh }),
    },
  ];
}

// THE EDITOR'S CLIPBOARD (see `editor/clipboard.ts`): a fragment of a level
// file, as text, so Ctrl+C in one tab reaches Ctrl+V in another.
//
// What is asserted here is that the payload is LOSSLESS, because that is where
// the failure is silent: a copy is a save of a sub-model, so anything the
// serialisation forgets - a chain, a vine, a wrap point, a matched outline, a
// body's own frame - comes back as an assembly that is missing a piece, with
// nothing to report. It is the same trap the format's own round trips cover,
// one scope down.
//
// What is NOT asserted here is the id REMINTING, which happens inside the
// editor's `cloneBodies` against the target model and cannot be reached from a
// pure case. That half is checked in a real browser, two tabs, which is the
// only place the system clipboard exists at all.
function clipboardPayload(): CaseResult[] {
  // A beam with a chain to a crate, a vine off the beam, a matched geometry
  // object, and a wrap point on a third body - one of everything a payload has
  // to carry.
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 100,
        y: -300,
        rot: 0.2,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 200, h: 20 } },
          { type: "geometry", shape: { kind: "rect", w: 200, h: 20 }, matchCollision: true, texture: "brick" },
          { type: "anchor", id: 1, x: -90, y: 0 },
          { type: "anchor", id: 4, x: 90, y: 0 },
        ],
      },
      {
        kind: "rigid",
        x: 300,
        y: -100,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "rect", w: 60, h: 60 } },
          { type: "anchor", id: 2, x: 0, y: -30 },
        ],
      },
      {
        kind: "static",
        x: 200,
        y: -200,
        rot: 0,
        objects: [
          { type: "collision", shape: { kind: "circle", r: 20 } },
          { type: "anchor", id: 3, x: 0, y: -20 },
        ],
      },
    ],
    chains: [{ a: 1, b: 2, via: [3], length: 400 }],
    vines: [{ anchor: 4, length: 250, stiffness: 0 }],
  };

  const source = modelFromDisk(authored);
  const payload = writeClipboard(source, source.items);
  const parsed = readClipboard(payload);
  const back = parsed ? modelToDisk(modelFromDisk(parsed)) : null;
  const saved = modelToDisk(source);

  // Everything is there, and the relations still name anchors that exist.
  const anchorIds = (d: LevelData): number[] =>
    d.bodies.flatMap((b) => b.objects.filter(isAnchorObject).map((o) => o.id)).sort((x, y) => x - y);
  const whole =
    back !== null &&
    back.bodies.length === saved.bodies.length &&
    back.chains?.length === 1 &&
    back.vines?.length === 1 &&
    JSON.stringify(anchorIds(back)) === JSON.stringify(anchorIds(saved)) &&
    JSON.stringify(back.chains![0]!.via) === JSON.stringify(saved.chains![0]!.via) &&
    back.vines![0]!.anchor === saved.vines![0]!.anchor;

  // ...and it is the SAME serialisation a save performs, which is what makes
  // the round-trip cases above hold a copy as well as a save.
  //
  // To within float noise rather than byte for byte, and the distinction is the
  // payload's own: a copy crosses the pixel-to-metre conversion twice where a
  // save crosses it once, so a vertex authored at -90 px comes back at
  // -90.00000000000003. A nanometre is not a difference an author can author,
  // and a byte comparison here would be a case that fails on arithmetic
  // associativity rather than on anything a copy lost.
  const near = (x: unknown, y: unknown): boolean => {
    if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) <= 1e-9;
    if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => near(v, y[i]));
    if (typeof x === "object" && x !== null && typeof y === "object" && y !== null) {
      const kx = Object.keys(x).sort();
      const ky = Object.keys(y).sort();
      return JSON.stringify(kx) === JSON.stringify(ky) && kx.every((k) => near((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]));
    }
    return x === y;
  };
  const same = back !== null && near(back.bodies, saved.bodies);

  // The level-wide blocks are NOT in it: none of them is a thing in the level,
  // and a paste that brought a spawn would move the target level's.
  const parsedRaw = parsed as (RawLevelData & { meta?: unknown; environment?: unknown }) | null;
  const fragment =
    parsedRaw !== null &&
    parsedRaw.meta === undefined &&
    parsedRaw.environment === undefined &&
    !payload.includes('"environment"');

  // A paste of something that is not a payload does nothing rather than
  // throwing: the input is whatever happened to be on the system clipboard.
  const junk =
    readClipboard("not json at all") === null &&
    readClipboard('{"hello":1}') === null &&
    readClipboard(JSON.stringify({ "rope-clipboard": 99, bodies: [] })) === null;

  return [
    {
      name: "clipboard: a copied assembly carries its chains, its vines and its wrap points",
      pass: whole,
      detail: whole
        ? `${back!.bodies.length} bodies, 1 chain (via ${JSON.stringify(back!.chains![0]!.via)}), 1 vine, anchors ${anchorIds(back!).join(",")}`
        : JSON.stringify({ bodies: back?.bodies.length, chains: back?.chains, vines: back?.vines }),
    },
    {
      name: "clipboard: ...and the payload is the same serialisation a save writes",
      pass: same,
      detail: same ? "the same bodies, to within a nanometre" : "the copy and the save disagree",
    },
    {
      name: "clipboard: the spawn, the level block and the environment stay out of it",
      pass: fragment,
      detail: fragment ? "a fragment, not a level" : JSON.stringify({ meta: parsedRaw?.meta, env: parsedRaw?.environment }),
    },
    {
      name: "clipboard: text that is not a payload is ignored rather than fatal",
      pass: junk,
      detail: junk ? "a sentence, a stray object and a future version all decline" : "something that is not a payload was accepted",
    },
  ];
}

// A conveyor belt as the renderers and the editor see it (docs/conveyors.md,
// "Rendering" and "The editor"). What these can say without a GPU: that the 3D
// tread's allocation-free placement IS the loop's own closed form, that the
// tread's pitch closes round the loop and its phase runs with the speed's
// sign, that the band is its own ring of geometry - outer wall on the loop with
// arc-length UVs that close on a whole number of repeats, inner wall a
// thickness in, caps at the width - whose texture the sim clock scrolls, that
// an untextured belt keeps a ring of cleats inside its band, that the 2D
// outline is the band with its hollow, and that the editor keeps every field
// of the shape and refuses what is not a belt. What they cannot say is how it
// looks, which is `cli shot --3d --frames` on TEST_BELT.
function beltRendering(): CaseResult[] {
  const out: CaseResult[] = [];
  // The drive: a small wheel top-left, a large one right, a medium one
  // bottom-left, under a 5 cm band.
  const wheelsM = [
    { x: 0, y: 0, r: 0.15 },
    { x: 1.7, y: 0.3, r: 0.45 },
    { x: 0.3, y: 1.3, r: 0.25 },
  ];
  const thickness = 0.05;
  const loop = buildBeltLoop(
    wheelsM.map((w) => ({ c: new Vec2(w.x, w.y), r: w.r })),
    thickness,
  );

  // The tread's frame against `beltPointAt` / `beltTangentAt`, over several
  // laps either way, so the reduction and every segment are exercised.
  let worst = 0;
  const frame = { x: 0, y: 0, tx: 0, ty: 0 };
  for (let k = -1000; k <= 1000; k++) {
    const s = (k / 1000) * loop.total * 2.3;
    beltFrameAt(loop, s, frame);
    const p = beltPointAt(loop, s);
    const t = beltTangentAt(loop, s);
    worst = Math.max(worst, Math.hypot(frame.x - p.x, frame.y - p.y), Math.hypot(frame.tx - t.x, frame.ty - t.y));
  }
  out.push({
    name: "belt: the 3D tread's allocation-free frame is the loop's own point and tangent",
    pass: worst < 1e-9,
    detail: `worst disagreement ${worst.toExponential(2)} over 2001 stations, 4.6 laps`,
  });

  // A whole number of pitches round the loop (no seam), near the nominal 20 cm,
  // and the phase carried the way the speed's sign says: positive advances `s`,
  // which is clockwise on screen, and a negative belt runs the pattern back.
  const pitch = beltTreadPitch(loop);
  const n = loop.total / pitch;
  const dt = 1 / 60;
  const fwd = beltTreadPhase(loop, 1.5, dt);
  const back = beltTreadPhase(loop, -1.5, dt);
  out.push({
    name: "belt: the tread's pitch closes round the loop and its phase runs with the speed's sign",
    pass:
      Math.abs(n - Math.round(n)) < 1e-9 &&
      Math.abs(pitch - BELT_TREAD_PITCH) < BELT_TREAD_PITCH * 0.5 &&
      Math.abs(fwd - 1.5 * dt) < 1e-12 &&
      Math.abs(back - (pitch - 1.5 * dt)) < 1e-12 &&
      beltRenderTime(0, 1) === 0 &&
      Math.abs(beltRenderTime(60, 0.5) - 59.5 / 60) < 1e-12,
    detail: `P ${loop.total.toFixed(4)} m = ${n.toFixed(6)} x ${pitch.toFixed(4)} m; one frame at +/-1.5 m/s: ${fwd.toFixed(4)} / ${back.toFixed(4)}`,
  });

  // A body with a belt, collided AND drawn (a matched pair, as `Add geometry`
  // makes it), through the real build and the real visual.
  const px = PIXELS_PER_METER;
  const belt = {
    kind: "belt" as const,
    wheels: wheelsM.map((w) => ({ x: w.x * px, y: w.y * px, r: w.r * px })),
    thickness: thickness * px,
    speed: 1.5 * px,
  };
  const raw: RawLevelData = {
    player: { x: 0, y: -200, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 40,
        y: 60,
        rot: 0.2,
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        objects: [
          { type: "collision", shape: belt },
          // A flat fill: the one surface that needs no canvas and no download.
          { type: "geometry", shape: belt, matchCollision: true, depth: 0.5 * px, texture: SOLID_SURFACE },
        ],
      },
    ],
  };
  const built = buildLevelBodies(new World(), scaleLevelData(raw, 1 / PIXELS_PER_METER), () => {});
  const b = built.bodies[0]!;
  const visual = new BodyVisual(b.body, b);
  const meshes: THREE.Mesh[] = [];
  visual.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  const cleats = meshes.find((m) => (m as THREE.InstancedMesh).isInstancedMesh) as
    | THREE.InstancedMesh
    | undefined;
  const solids = meshes.filter((m) => m !== cleats);
  // The cleat ring in the geometry object's own frame, where the loop is
  // (wheel 0 at the origin): every centre inside the outline, within a
  // tread's depth of it, and never on it.
  const outline = beltOutline(loop);
  const m4 = new THREE.Matrix4();
  const at = new THREE.Vector3();
  let inside = true;
  let nearest = Infinity;
  let farthest = 0;
  const centres: Vec2[] = [];
  for (let k = 0; k < (cleats?.count ?? 0); k++) {
    cleats!.getMatrixAt(k, m4);
    at.setFromMatrixPosition(m4);
    const c = new Vec2(at.x, -at.y);
    centres.push(c);
    if (!loopContainsPoint(outline, c)) inside = false;
    const d = beltNearest(loop, c).distSq ** 0.5;
    nearest = Math.min(nearest, d);
    farthest = Math.max(farthest, d);
  }
  const depth = beltTreadDepth(loop);
  const ringUv = solids[0]?.geometry.getAttribute("uv");
  out.push({
    name: "belt: an untextured belt draws ONE band and a ring of cleats inside the band",
    pass:
      solids.length === 1 &&
      ringUv !== undefined &&
      cleats !== undefined &&
      cleats.count === Math.round(n) &&
      inside &&
      nearest > 0 &&
      farthest < depth &&
      depth < thickness,
    detail: `${solids.length} band(s), ${cleats?.count ?? 0} cleats (pitch count ${Math.round(n)}); centres ${nearest.toFixed(4)}..${farthest.toFixed(4)} m inside, tread depth ${depth.toFixed(3)} m in a ${thickness} m band`,
  });

  // The sim clock carries them: a frame of 1.5 m/s later every cleat has moved
  // 2.5 cm along the loop in +s. Measured as the arc length each centre
  // projects to, which is where the cleat sits along the loop.
  visual.sync(1, 1 / 60);
  let moved = Infinity;
  let movedMax = 0;
  for (let k = 0; k < (cleats?.count ?? 0); k++) {
    cleats!.getMatrixAt(k, m4);
    at.setFromMatrixPosition(m4);
    const s0 = beltNearest(loop, centres[k]!).s;
    const s1 = beltNearest(loop, new Vec2(at.x, -at.y)).s;
    let ds = s1 - s0;
    if (ds < -loop.total / 2) ds += loop.total;
    moved = Math.min(moved, ds);
    movedMax = Math.max(movedMax, ds);
  }
  visual.dispose();
  out.push({
    name: "belt: the cleats ride the loop in the belt's sense at its speed, by the sim clock",
    // Loose: a centre inside a roller's arc projects onto the arc at a
    // radius-scaled arc length, so it is a band either side of 2.5 cm.
    pass: cleats !== undefined && moved > 0.02 && movedMax < 0.03,
    detail: `per-cleat advance over one frame at 1.5 m/s: ${(moved * 100).toFixed(2)}..${(movedMax * 100).toFixed(2)} cm (2.5 cm on the loop)`,
  });

  // THE RING, textured: its own geometry, measured directly (a generated
  // surface needs a canvas to build, which a headless case has not got).
  const width = 0.5;
  const tile = 0.6;
  const ring = new BeltRing(loop, width, tile, 1.5);
  const pos = ring.geometry.getAttribute("position");
  const nor = ring.geometry.getAttribute("normal");
  const uv = ring.geometry.getAttribute("uv");
  const stations = beltRingStations(loop);
  const PER = pos.count / stations.length;
  // Per station: outer wall (2), front cap (2), inner wall (2), back cap (2).
  let worstOuter = 0;
  let worstInner = 0;
  let worstNormal = 0;
  let zs = new Set<number>();
  for (let j = 0; j < stations.length; j++) {
    const at = (k: number): Vec2 => new Vec2(pos.getX(j * PER + k), -pos.getY(j * PER + k));
    const onLoop = beltPointAt(loop, stations[j]!);
    worstOuter = Math.max(worstOuter, at(0).distanceTo(onLoop), at(1).distanceTo(onLoop));
    const n = beltTangentAt(loop, stations[j]!).orthogonal();
    const innerAt = onLoop.sub(n.mul(thickness));
    worstInner = Math.max(worstInner, at(4).distanceTo(innerAt), at(5).distanceTo(innerAt));
    worstNormal = Math.max(
      worstNormal,
      Math.hypot(nor.getX(j * PER) - n.x, -nor.getY(j * PER) - n.y),
      Math.hypot(nor.getX(j * PER + 4) + n.x, -nor.getY(j * PER + 4) + n.y),
      Math.abs(nor.getZ(j * PER + 2) - 1),
      Math.abs(nor.getZ(j * PER + 6) + 1),
    );
    for (let k = 0; k < PER; k++) zs.add(Math.round(pos.getZ(j * PER + k) * 1e6) / 1e6);
  }
  zs = new Set([...zs].sort());
  out.push({
    name: "belt: the band is its own ring - outer wall on the loop, inner wall a thickness in, caps at the width",
    pass:
      PER === 8 &&
      worstOuter < 1e-6 &&
      worstInner < 1e-6 &&
      worstNormal < 1e-6 &&
      zs.size === 2 &&
      zs.has(width / 2) &&
      zs.has(-width / 2) &&
      (ring.geometry.getIndex()?.count ?? 0) === (stations.length - 1) * 4 * 6,
    detail: `${stations.length} stations x ${PER} vertices; outer ${worstOuter.toExponential(2)} m, inner ${worstInner.toExponential(2)} m, normals ${worstNormal.toExponential(2)}; z planes ${[...zs].join(", ")}`,
  });
  // u is arc length, at a rate that closes on a whole number of repeats: the
  // first and last stations are the same point with u a whole number of tiles
  // apart (no seam where s wraps), and u runs linearly with s everywhere, round
  // the wheels too (no stretching), on the outer wall and the caps' rim alike.
  const u0 = uv.getX(0);
  const uEnd = uv.getX((stations.length - 1) * PER);
  const laps = (uEnd - u0) / tile;
  const rate = (uEnd - u0) / loop.total;
  let worstRate = 0;
  for (let j = 1; j < stations.length; j++) {
    for (const k of [0, 2, 4, 6]) {
      worstRate = Math.max(worstRate, Math.abs(uv.getX(j * PER + k) - u0 - rate * stations[j]!));
    }
  }
  out.push({
    name: "belt: the running surface's u is arc length, closing on a whole number of repeats",
    pass: Math.abs(laps - Math.round(laps)) < 1e-4 && Math.abs(rate - 1) < 0.1 && worstRate < 1e-4,
    detail: `${laps.toFixed(6)} repeats of ${tile} m round a ${loop.total.toFixed(4)} m loop (u per metre of s ${rate.toFixed(6)}); worst departure from linear ${worstRate.toExponential(2)}`,
  });
  // The scroll: a frame of 1.5 m/s later, u has moved back 2.5 cm of arc (the
  // pattern carried forward in +s), the same at every vertex; a negative belt
  // runs it the other way; and the clock, not a counter, decides it.
  ring.sync(1 / 60);
  const du = uv.getX(0) - u0;
  let spread = 0;
  for (let j = 0; j < stations.length; j++) spread = Math.max(spread, Math.abs(uv.getX(j * PER + 3) - uv.getX(3) - (uv.getX(j * PER) - uv.getX(0))));
  const reverse = new BeltRing(loop, width, tile, -1.5);
  reverse.sync(1 / 60);
  const duBack = reverse.geometry.getAttribute("uv").getX(0) - u0;
  const period = beltTextureTile(loop, tile);
  out.push({
    name: "belt: the sim clock scrolls the running surface's texture at the belt's speed",
    pass:
      Math.abs(du + 0.025 * rate) < 1e-6 &&
      Math.abs(duBack + (period - 0.025) * rate) < 1e-5 &&
      spread < 1e-5,
    detail: `u moved ${du.toFixed(6)} at +1.5 m/s and ${duBack.toFixed(6)} at -1.5 m/s over one frame (repeat ${period.toFixed(4)} m of arc)`,
  });
  ring.geometry.dispose();
  reverse.geometry.dispose();

  // The 2D outline of a belt is its BAND: the outer loop with the inner one as
  // a hole, the hole a thickness inside everywhere.
  const band = outlineOfData({ ...belt, wheels: wheelsM, thickness });
  const hole = band.kind === "poly" ? (band.hole ?? []) : [];
  let worstHole = 0;
  for (const v of hole) worstHole = Math.max(worstHole, Math.abs(Math.sqrt(beltNearest(loop, v).distSq) - thickness));
  out.push({
    name: "belt: the 2D outline is the band - the outer loop with the inner loop as its hole",
    pass: band.kind === "poly" && hole.length > 10 && worstHole < 1e-9,
    detail: `${band.kind === "poly" ? band.verts.length : 0} outer and ${hole.length} inner points; inner loop ${worstHole.toExponential(2)} m off a thickness in`,
  });

  // The editor keeps every field, the wheel list and the matched link
  // included: the file comes back from the model byte-identical.
  const back2 = modelToDisk(modelFromDisk(raw));
  const authoredObjects = (raw.bodies[0] as { objects: SceneObjectData[] }).objects;
  const kept = JSON.stringify(back2.bodies[0]!.objects) === JSON.stringify(authoredObjects);
  out.push({
    name: "belt: the editor round trip keeps every field of a belt - its wheel list included - and its matched twin",
    pass: kept,
    detail: kept ? "byte-identical objects" : JSON.stringify(back2.bodies[0]!.objects),
  });

  // The editor's one writer refuses what is not a belt, and a refused edit
  // leaves the belt as it was; inserting a wheel on a run changes nothing about
  // the loop (the new wheel touches the band); removing wheel 0 moves the item
  // onto the next wheel without moving the belt.
  const model = modelFromDisk(raw);
  const item = model.items.find((i) => i.object === "collision" && i.shape.kind === "belt")!;
  const shape = () => (item.shape.kind === "belt" ? item.shape : null)!;
  const before = JSON.stringify(beltShapeData(shape()));
  const w = shape().wheels;
  const idler = !setBelt(item, { wheels: [...w, { c: new Vec2(0.6, 0.55), r: 0.05 }] });
  const nested = !setBelt(item, { wheels: [w[0]!, w[1]!, { c: w[1]!.c.add(new Vec2(0.05, 0)), r: 0.2 }] });
  const flat = !setBelt(item, { thickness: 0 });
  const unchanged = JSON.stringify(beltShapeData(shape())) === before;
  const perimeter = beltLap(shape())!.perimeter;
  const inserted = beltInsertWheel(item, 1);
  const afterInsert = beltLap(shape())!.perimeter;
  // Every wheel but the removed one, in the world, before and after.
  const wheelCentres = (): Vec2[] => shape().wheels.map((wh) => item.pos.add(wh.c.rotated(item.rot)));
  const kept0 = wheelCentres().slice(1);
  const removed = beltRemoveWheel(item, 0);
  const kept1 = wheelCentres();
  let shifted = kept0.length === kept1.length ? 0 : Infinity;
  kept0.forEach((p, i) => (shifted = Math.max(shifted, p.distanceTo(kept1[i] ?? new Vec2(Infinity, 0)))));
  out.push({
    name: "belt: the editor refuses an idler, a disc inside another and a zero thickness; inserts on a run and removes wheel 0 without moving the belt",
    pass:
      idler &&
      nested &&
      flat &&
      unchanged &&
      inserted === 2 &&
      Math.abs(afterInsert - perimeter) < 1e-9 &&
      removed &&
      shape().wheels[0]!.c.x === 0 &&
      shape().wheels[0]!.c.y === 0 &&
      shifted < 1e-12,
    detail: `refused idler ${idler}, nested ${nested}, zero thickness ${flat}, unchanged ${unchanged}; inserted at ${inserted} (perimeter ${perimeter.toFixed(6)} -> ${afterInsert.toFixed(6)} m); wheel 0 removed ${removed}, the other wheels moved ${shifted.toExponential(2)} m`,
  });
  return out;
}

// THE AVATAR'S OWN SURFACE (render3d/avatarSurface.ts). Two facts, neither
// visible in a picture that looks fine: the avatar's copy of the painted steel
// is a cache entry of its own, so its fog and its sky never leak onto a wall of
// the same steel; and the fog patch really rewrites three's chunk - a renamed
// chunk would be a `replace` matching nothing, and the ball would quietly go
// back to the world's air.
function avatarSurface(): CaseResult[] {
  const req = { texture: IRON_SURFACE, tileScale: 5, color: "#f2eadf" };
  const plain = surfaceKey(req);
  const avatar = surfaceKey({ ...req, avatar: true });
  const keyed = plain !== avatar && avatar === surfaceKey({ ...req, avatar: true }) && !plain.includes("avatar");

  const mat = wearAvatar(wearAvatar(new THREE.MeshStandardMaterial()));
  const shader = { fragmentShader: THREE.ShaderLib.standard.fragmentShader, vertexShader: "", uniforms: {} };
  const hadChunk = shader.fragmentShader.includes("#include <fog_fragment>");
  mat.onBeforeCompile(shader as never, null as never);
  const patched = shader.fragmentShader;
  const scaled = patched.includes(`fogFactor * ${AVATAR_FOG}`);
  const once = patched.split(`fogFactor * ${AVATAR_FOG}`).length === 2;
  const replaced = !patched.includes("#include <fog_fragment>");
  const key = mat.customProgramCacheKey();
  const programKeyed = key.includes(AVATAR_PROGRAM_KEY) && key.split(AVATAR_PROGRAM_KEY).length === 2;
  const fogOk = hadChunk && scaled && once && replaced && programKeyed;
  // The wrap: the direct diffuse term spends the wrapped irradiance and the
  // specular does not, under the same program key.
  const wrapLit = `+ ${AVATAR_WRAP}.0 ) / ( 1.0 + ${AVATAR_WRAP}.0 )`;
  const wrapped = patched.includes(wrapLit) && patched.split(wrapLit).length === 2;
  const diffuseWrapped = patched.includes("directDiffuse += wrapIrradiance * BRDF_Lambert");
  const specularPlain = patched.includes("directSpecular += irradiance * BRDF_GGX");
  const lightsReplaced = !patched.includes("#include <lights_physical_pars_fragment>");
  const wrapKeyed = key.includes(`avatar-wrap:${AVATAR_WRAP}`);
  // The bounce part spends the light BEFORE its shadow: each of the three
  // direct-light reads stashes it, and the wrapped irradiance adds it back.
  const stashes = patched.split("avatarUnshadowed = directLight.color;").length - 1;
  const bounceUnshadowed = patched.includes("max( wrapNL - dotNL, 0.0 ) * avatarUnshadowed");
  const beginReplaced = !patched.includes("#include <lights_fragment_begin>");
  const wrapOk =
    wrapped && diffuseWrapped && specularPlain && lightsReplaced && wrapKeyed &&
    stashes === 3 && bounceUnshadowed && beginReplaced;
  return [
    {
      name: "avatar: its surface key differs from the plain key for the same request, and is stable",
      pass: keyed,
      detail: keyed ? `${plain} vs ${avatar}` : `plain ${plain}, avatar ${avatar}`,
    },
    {
      name: "avatar: the patched fog chunk scales the fog factor by AVATAR_FOG, once, under a program key of its own",
      pass: fogOk,
      detail: fogOk
        ? `fogFactor * ${AVATAR_FOG}, key "${key}"`
        : `chunk present ${hadChunk}, scaled ${scaled}, once ${once}, include replaced ${replaced}, key "${key}"`,
    },
    {
      name: "avatar: the patched light chunk wraps the direct DIFFUSE by AVATAR_WRAP, unshadowed, and leaves the specular alone",
      pass: wrapOk,
      detail: wrapOk
        ? `wrap ${AVATAR_WRAP}, key "${key}"`
        : `wrapped ${wrapped}, diffuse ${diffuseWrapped}, specular plain ${specularPlain}, include replaced ${lightsReplaced}, keyed ${wrapKeyed}, stashes ${stashes}, bounce unshadowed ${bounceUnshadowed}, begin replaced ${beginReplaced}`,
    },
  ];
}

// THE GENERATED SKIES (environment.ts `equirectPixels`), read the way three
// reads them. `equirectUv` in three's common.glsl is restated here rather than
// imported, so the painter is checked against three's convention and not
// against itself: that is exactly the mistake the painter made until
// 2026-09-24, painting row 0 as straight up and the azimuth as atan2(x, z), so
// every generated sky was upside down and mirrored and the sun lobe sat
// opposite the sun.
function threeReads(px: Float32Array, dir: THREE.Vector3): [number, number, number] {
  const { width: W, height: H } = EQUIRECT_SIZE;
  const d = dir.clone().normalize();
  const u = Math.atan2(d.z, d.x) / (Math.PI * 2) + 0.5;
  const v = Math.asin(Math.max(-1, Math.min(1, d.y))) / Math.PI + 0.5;
  const x = Math.min(W - 1, Math.floor(u * W));
  const y = Math.min(H - 1, Math.floor(v * H));
  const i = (y * W + x) * 4;
  return [px[i]!, px[i + 1]!, px[i + 2]!];
}

function generatedSkies(): CaseResult[] {
  // Orientation: straight up reads the sky, straight down the ground, and the
  // lobe peaks where three looks for the sun. A black-and-white sky with no
  // sun for the first half, and the default level (which has one) for the
  // lobe.
  const bw = equirectPixels(skyInputs({ skyColor: "#ffffff", groundColor: "#000000", sunIntensity: 0 }));
  const up = threeReads(bw, new THREE.Vector3(0, 1, 0))[0];
  const down = threeReads(bw, new THREE.Vector3(0, -1, 0))[0];
  const sunny = skyInputs();
  const lit = equirectPixels(sunny);
  const sunward = threeReads(lit, sunny.sunDir)[0];
  const antisun = threeReads(lit, sunny.sunDir.clone().negate())[0];
  const upright = up > 0.99 && down < 0.01 && sunward > antisun * 2;

  return [
    {
      name: "sky: a generated sky is painted as three reads it - sky overhead, ground below, the lobe toward the sun",
      pass: upright,
      detail: `straight up reads ${up.toFixed(3)} (sky 1), down ${down.toFixed(3)} (ground 0); toward the sun ${sunward.toFixed(3)}, away ${antisun.toFixed(3)}`,
    },
  ];
}

// A SPOT'S VISIBLE BEAM (render3d/beam.ts). What is asserted is geometry and
// format, never the look: the cone is the spot's own cone, the dust starts
// inside it, the two fields survive both round trips, and a spot asking for
// neither builds nothing at all - which is the proof that every level authored
// before the fields draws exactly what it drew.
function beamCases(): CaseResult[] {
  const out: CaseResult[] = [];

  // The far radius, and the built cone: lamp at the holder's origin, the far
  // ring `range` along the authored aim at that radius. Aimed along +x in sim
  // terms so the aim is not the cone's own default axis.
  const expected = 10 * Math.tan((7 * Math.PI) / 180);
  const rig = new LightRig();
  const scene = new THREE.Group();
  const mounted = rig.add(
    scene,
    { type: "light", kind: "spot", range: 10, angle: 7, dirX: 1, dirY: 0, beam: 0.6, dust: 0.5 },
    { x: 0, y: 0, rot: 0, z: 0 },
  );
  const cone = mounted?.holder.getObjectByName("beam-cone") as THREE.Mesh | undefined;
  const dust = mounted?.holder.getObjectByName("beam-dust") as THREE.Points | undefined;
  let farErr = Infinity;
  let nearErr = Infinity;
  if (cone) {
    scene.updateMatrixWorld(true);
    const pos = cone.geometry.getAttribute("position");
    const v = new THREE.Vector3();
    farErr = 0;
    nearErr = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(cone.matrixWorld);
      // Along +x, the far ring is at x = 10 and radius `expected` about the axis.
      const r = Math.hypot(v.y, v.z);
      if (Math.abs(v.x - 10) < 1e-6) farErr = Math.max(farErr, Math.abs(r - expected));
      else if (Math.abs(v.x) < 1e-6) nearErr = Math.max(nearErr, Math.abs(r - BEAM_SOURCE_RADIUS));
    }
  }
  const radiusOk = Math.abs(beamFarRadius(10, 7) - expected) < 1e-12 && farErr < 1e-5 && nearErr < 1e-5;
  out.push({
    name: "beam: the cone reaches `range` along the spot's aim, at range x tan(angle)",
    pass: radiusOk && dust !== undefined,
    detail: cone
      ? `far radius ${expected.toFixed(4)} m, far ring off by ${farErr.toExponential(2)}, lamp ring off by ${nearErr.toExponential(2)}; dust ${dust ? "built" : "MISSING"}`
      : "no cone built",
  });
  rig.dispose();

  // Every seeded mote inside the cone, over several beams.
  let worst = -Infinity;
  let seeded = 0;
  for (const [range, angle, seed] of [
    [10, 7, 0],
    [4, 30, 2.4],
    [25, 3, 9.6],
    [1, 60, 17],
  ] as const) {
    const far = beamFarRadius(range, angle);
    const source = Math.min(BEAM_SOURCE_RADIUS, far);
    const { positions } = seedDust(500, range, source, far, seed);
    for (let i = 0; i < 500; i++) {
      const x = positions[i * 3]!;
      const y = positions[i * 3 + 1]!;
      const z = positions[i * 3 + 2]!;
      const along = -y / range;
      const over = Math.max(
        Math.hypot(x, z) - beamRadiusAt(along, source, far),
        -along,
        along - 1,
      );
      worst = Math.max(worst, over);
      seeded++;
    }
  }
  out.push({
    name: "beam: every dust mote is seeded inside the cone",
    pass: worst <= 1e-6,
    detail: `${seeded} motes over four cones, furthest outside by ${worst.toExponential(2)} m`,
  });

  // The format: dimensionless, so untouched by px -> m, and carried by the
  // editor's model on a spot.
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 20 },
    bodies: [
      {
        kind: "static",
        x: 100,
        y: -300,
        rot: 0,
        objects: [
          {
            type: "light",
            kind: "spot",
            z: 0,
            color: "#f3ecd8",
            intensity: 300,
            range: 1000,
            angle: 7,
            penumbra: 0.6,
            castShadow: true,
            beam: 0.6,
            dust: 0.5,
          },
        ],
      },
    ],
  };
  const inMetres = scaleLevelData(authored, PX);
  const lit = inMetres.bodies[0]!.objects.find(isLightObject)!;
  const unscaled = lit.beam === 0.6 && lit.dust === 0.5 && lit.range === 10;
  const a = JSON.stringify(scaleLevelData(authored, 1));
  const b = JSON.stringify(scaleLevelData(inMetres, PIXELS_PER_METER));
  const saved = modelToDisk(modelFromDisk(authored)).bodies[0]!.objects.find(isLightObject);
  const kept = saved?.beam === 0.6 && saved?.dust === 0.5;
  // On a point light the fields mean nothing, so the editor does not write them.
  const pointed = modelToDisk(
    modelFromDisk({
      ...authored,
      bodies: [{ ...authored.bodies[0]!, objects: [{ type: "light", beam: 0.6, dust: 0.5 }] }],
    } as RawLevelData),
  ).bodies[0]!.objects.find(isLightObject);
  const pointDropped = pointed !== undefined && pointed.beam === undefined && pointed.dust === undefined;
  out.push({
    name: "format: a spot's beam and dust pass px -> m unscaled and survive an editor save",
    pass: unscaled && a === b && kept && pointDropped,
    detail: `in metres beam ${lit.beam} dust ${lit.dust} range ${lit.range}; px round trip ${a === b ? "byte-identical" : "DIFFERS"}; editor save ${kept ? "kept" : `became ${JSON.stringify(saved)}`}; on a point light ${pointDropped ? "not written" : JSON.stringify(pointed)}`,
  });

  // No beam asked for, no beam built: a spot with neither field, with both at
  // zero, and a point light asking for one.
  const bare = new LightRig();
  const kids = (data: LightObjectData): string[] => {
    const m = bare.add(new THREE.Group(), data, { x: 0, y: 0, rot: 0, z: 0 });
    const names: string[] = [];
    m?.holder.traverse((o) => {
      if (o === m.holder) return;
      if ((o as THREE.Light).isLight) names.push("light");
      else if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || o.name === "beam") names.push(o.name || o.type);
      else names.push("target");
    });
    return names.sort();
  };
  const shapes = [
    kids({ type: "light", kind: "spot", range: 8 }),
    kids({ type: "light", kind: "spot", range: 8, beam: 0, dust: 0 }),
    kids({ type: "light", kind: "point", range: 8, beam: 0.6, dust: 0.5 }),
  ];
  bare.dispose();
  const nothing =
    JSON.stringify(shapes[0]) === JSON.stringify(["light", "target"]) &&
    JSON.stringify(shapes[1]) === JSON.stringify(["light", "target"]) &&
    JSON.stringify(shapes[2]) === JSON.stringify(["light"]);
  out.push({
    name: "beam: a light asking for no beam builds no beam objects at all",
    pass: nothing,
    detail: shapes.map((s) => `[${s.join(", ")}]`).join(" / "),
  });
  return out;
}

// WAKING LIGHTS (render3d/glow.ts, the pool in lights.ts, the instance key, the
// editor's fields and `+ Glow`). The law, the assignment and the format -
// never the look: how far apart the mushrooms are, how far they reach and how
// bright they rise are the play's to decide and get no case.
function glowCases(): CaseResult[] {
  const out: CaseResult[] = [];
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  const law = { wake: 3, delay: 0.25, rise: 0.6, fall: 1.5 };
  const IN = 1;
  const OUT = 10;
  // Run a script of (steps, distance) at a fixed dt, recording after each step.
  const run = (
    state: GlowState,
    script: readonly (readonly [number, number])[],
    dt = 0.05,
  ): { phase: string; level: number }[] => {
    const rows: { phase: string; level: number }[] = [];
    for (const [steps, distance] of script) {
      for (let i = 0; i < steps; i++) {
        state.step(distance, dt);
        rows.push({ phase: state.phase, level: state.level });
      }
    }
    return rows;
  };

  // The phases in order, at a fixed 50 ms step: inside from t = 0 until
  // t = 1.0 s, then gone. Delay to 0.25, rise over 0.6 to 0.85, lit, fall over
  // 1.5 from 1.0 to 2.5, dormant.
  {
    const rows = run(new GlowState(law), [
      [20, IN],
      [40, OUT],
    ]);
    const at = (t: number) => rows[Math.round(t / 0.05) - 1]!;
    const table: [number, string, number][] = [
      [0.05, "armed", 0],
      [0.2, "armed", 0],
      [0.55, "rising", 0.5],
      [0.7, "rising", 0.75],
      [1.0, "lit", 1],
      [1.05, "falling", 1 - 0.05 / 1.5],
      [1.75, "falling", 0.5],
      [2.6, "dormant", 0],
      [3.0, "dormant", 0],
    ];
    const bad = table.filter(([t, phase, level]) => at(t).phase !== phase || !near(at(t).level, level));
    out.push({
      name: "glow: dormant, armed, rising, lit, falling, dormant - the levels against time at a fixed step",
      pass: bad.length === 0,
      detail:
        bad.length === 0
          ? table.map(([t, p, l]) => `${t}s ${p} ${l.toFixed(3)}`).join(", ")
          : bad.map(([t, p, l]) => `${t}s wanted ${p} ${l.toFixed(3)}, got ${at(t).phase} ${at(t).level.toFixed(4)}`).join("; "),
    });
  }

  // Leaving during the delay emits nothing, ever.
  {
    const rows = run(new GlowState(law), [
      [3, IN],
      [40, OUT],
    ]);
    const peak = Math.max(...rows.map((r) => r.level));
    const last = rows[rows.length - 1]!;
    out.push({
      name: "glow: a ball that leaves during the delay wakes nothing",
      pass: peak === 0 && last.phase === "dormant",
      detail: `peak level ${peak} over ${rows.length} steps, ends ${last.phase}`,
    });
  }

  // Hysteresis: parked just outside `wake` (inside the release band) after
  // waking it stays lit; parked past the band it falls.
  {
    const parked = run(new GlowState(law), [
      [20, IN],
      [60, law.wake * 1.05],
    ]);
    const beyond = run(new GlowState(law), [
      [20, IN],
      [1, law.wake * WAKE_HYSTERESIS * 1.01],
    ]);
    const held = parked.slice(20).every((r) => r.phase === "lit" && r.level === 1);
    const released = beyond[beyond.length - 1]!.phase === "falling";
    out.push({
      name: "glow: a ball parked at wake x 1.05 after waking it keeps it lit; past the hysteresis it falls",
      pass: held && released,
      detail: `3 s at 1.05 x wake: ${held ? "lit throughout" : "LET GO"}; at ${(WAKE_HYSTERESIS * 1.01).toFixed(3)} x wake: ${beyond[beyond.length - 1]!.phase}`,
    });
  }

  // Re-entry during the fall re-arms from the current level with no delay.
  {
    const rows = run(new GlowState(law), [
      [20, IN],
      [15, OUT],
      [1, IN],
    ]);
    const before = rows[34]!;
    const after = rows[35]!;
    const ok =
      before.phase === "falling" &&
      near(before.level, 0.5) &&
      after.phase === "rising" &&
      near(after.level, 0.5 + 0.05 / 0.6);
    out.push({
      name: "glow: coming back during the fall rises again from where it was, with no delay",
      pass: ok,
      detail: `falling at ${before.level.toFixed(4)}, one step back inside: ${after.phase} at ${after.level.toFixed(4)} (wanted ${(0.5 + 0.05 / 0.6).toFixed(4)})`,
    });
  }

  // The clamp: a 5 s step moves it no further than MAX_GLOW_STEP would, a
  // backwards clock moves it not at all, and a zero rise or fall is instant.
  {
    const lit = new GlowState({ ...law, delay: 0 });
    run(lit, [[20, IN]]);
    lit.step(OUT, 5);
    const clampedFall = near(lit.level, 1 - MAX_GLOW_STEP / law.fall);
    const fresh = new GlowState({ ...law, delay: 0 });
    fresh.step(IN, 5);
    const clampedRise = near(fresh.level, MAX_GLOW_STEP / law.rise);
    const back = fresh.level;
    fresh.step(IN, -3);
    const backwards = fresh.level === back;
    const snap = new GlowState({ ...law, delay: 0, rise: 0, fall: 0 });
    snap.step(IN, 0);
    const onAtOnce = snap.level === 1 && snap.phase === "lit";
    snap.step(OUT, 0);
    const offAtOnce = snap.level === 0 && snap.phase === "dormant";
    out.push({
      name: "glow: a step is clamped to MAX_GLOW_STEP, a clock running backwards steps nothing, and a rise or fall of 0 is instant",
      pass: clampedFall && clampedRise && backwards && onAtOnce && offAtOnce,
      detail: `5 s step: fell to ${lit.level.toFixed(4)}, rose to ${back.toFixed(4)}; -3 s step ${backwards ? "held" : "MOVED"}; rise 0 ${onAtOnce ? "instant" : "NOT"}, fall 0 ${offAtOnce ? "instant" : "NOT"}`,
    });
  }

  // The format: `wake` is a length, the times are not.
  {
    const scaled = scaleObject(
      { type: "light", wake: 300, wakeDelay: 0.25, wakeRise: 0.6, wakeFall: 1.5, range: 400 },
      PX,
    ) as LightObjectData;
    const ok =
      near(scaled.wake!, 3) &&
      scaled.wakeDelay === 0.25 &&
      scaled.wakeRise === 0.6 &&
      scaled.wakeFall === 1.5 &&
      near(scaled.range!, 4);
    const defaults = wakeParams({ type: "light", wake: 3 });
    const spot = wakeParams({ type: "light", kind: "spot", wake: 3 });
    const off = wakeParams({ type: "light", wake: 0 });
    const lawOk =
      defaults !== null &&
      defaults.delay === 0 &&
      defaults.rise === DEFAULT_WAKE_RISE &&
      defaults.fall === DEFAULT_WAKE_FALL &&
      spot === null &&
      off === null;
    out.push({
      name: "format: scaleObject converts wake like range and passes wakeDelay, wakeRise and wakeFall untouched",
      pass: ok && lawOk,
      detail: `300 px -> wake ${scaled.wake} m, delay ${scaled.wakeDelay} s, rise ${scaled.wakeRise} s, fall ${scaled.wakeFall} s; defaults ${JSON.stringify(defaults)}; a spot ${spot === null ? "never wakes" : "WAKES"}; wake 0 ${off === null ? "is always on" : "WAKES"}`,
    });
  }

  // The pool's assignment: nearest first, authored order on a tie, a dark
  // source never served, and never more than n.
  {
    const sources = [
      { level: 1, x: 5, y: 0 }, // 0: 5 m
      { level: 0.5, x: 1, y: 0 }, // 1: 1 m
      { level: 0, x: 0.5, y: 0 }, // 2: dark, nearest of all
      { level: 1, x: -5, y: 0 }, // 3: 5 m, ties with 0
      { level: 1, x: 0, y: 2 }, // 4: 2 m
    ];
    const three = assignPool(sources, { x: 0, y: 0 }, 3);
    const all = assignPool(sources, { x: 0, y: 0 }, 10);
    const none = assignPool(sources, { x: 0, y: 0 }, 0);
    const ok =
      JSON.stringify(three) === "[1,4,0]" && JSON.stringify(all) === "[1,4,0,3]" && none.length === 0;
    out.push({
      name: "glow pool: nearest awake source first, ties in authored order, a dark source never served",
      pass: ok,
      detail: `n=3 ${JSON.stringify(three)} (want [1,4,0]), n=10 ${JSON.stringify(all)} (want [1,4,0,3]), n=0 ${JSON.stringify(none)}`,
    });
  }

  // The pool the rig builds: none for a level with no waking light (so every
  // existing level is the scene it was), one per waking source up to
  // GLOW_POOL, and a waking light mounts no light of its own.
  {
    const poolOf = (waking: number, steady: number): { size: number; lights: number; own: number } => {
      const rig = new LightRig();
      const scene = new THREE.Scene();
      const body = new THREE.Group();
      scene.add(body);
      let own = 0;
      for (let i = 0; i < steady; i++) rig.add(body, { type: "light", range: 4 }, { x: i, y: 0, rot: 0, z: 0 });
      for (let i = 0; i < waking; i++) {
        const m = rig.add(body, { type: "light", range: 4, wake: 3 }, { x: i, y: 1, rot: 0, z: 0 });
        m?.holder.traverse((o) => {
          if ((o as THREE.Light).isLight) own++;
        });
      }
      rig.buildPool(scene);
      let lights = 0;
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight) lights++;
      });
      const size = rig.poolSize;
      rig.dispose();
      return { size, lights, own };
    };
    const none = poolOf(0, 3);
    const few = poolOf(3, 2);
    const many = poolOf(GLOW_POOL + 4, 0);
    const ok =
      none.size === 0 &&
      none.lights === 3 &&
      few.size === 3 &&
      few.lights === 5 &&
      many.size === GLOW_POOL &&
      many.lights === GLOW_POOL &&
      few.own === 0 &&
      many.own === 0;
    out.push({
      name: "glow pool: a level with no waking light builds none, and the pool never exceeds GLOW_POOL",
      pass: ok,
      detail: `0 waking + 3 steady: pool ${none.size}, ${none.lights} lights; 3 + 2: pool ${few.size}, ${few.lights} lights; ${GLOW_POOL + 4} waking: pool ${many.size} (GLOW_POOL ${GLOW_POOL}); a waking source's own lights: ${few.own + many.own}`,
    });
  }

  // The instance key: a body of its own, different from the shared material
  // and from any other body's; and no body without a waking light asks for
  // one, which is the proof that no existing level gains a material.
  {
    const req = { texture: "color", color: "#8a3fd6", emissive: "#b070ff", emissiveIntensity: 2 };
    const plain = surfaceKey(req);
    const mine = surfaceKey({ ...req, instance: "b3" });
    const theirs = surfaceKey({ ...req, instance: "b4" });
    const keyed = plain !== mine && mine !== theirs && mine === surfaceKey({ ...req, instance: "b3" });
    const river = scaleLevelData(ballLevelJson as RawLevelData, PX);
    const wakingBodies = river.bodies.filter((b) => b.objects.some((o) => isLightObject(o) && wakeParams(o) !== null));
    const asking = river.bodies.filter((b, i) => surfaceInstance(b, `b${i}`) !== undefined);
    const steady: LevelBodyData = {
      kind: "static",
      x: 0,
      y: 0,
      rot: 0,
      objects: [
        { type: "geometry", shape: { kind: "rect", w: 1, h: 1 }, emissive: "#ffaa00" },
        { type: "light", range: 4 },
      ],
    };
    const ok =
      keyed &&
      surfaceInstance(steady, "b0") === undefined &&
      surfaceInstance(glowBody(new Vec2(0, 0)), "b0") === "b0" &&
      surfaceInstance(glowBody(new Vec2(0, 0)), undefined) === undefined &&
      asking.length === wakingBodies.length &&
      asking.every((b) => wakingBodies.includes(b));
    out.push({
      name: "glow: a waking body's instance key is its own, and a body with no waking light asks for none",
      pass: ok,
      detail: `plain ${plain} / b3 ${mine} / b4 ${theirs}; river: ${asking.length} of ${river.bodies.length} bodies ask for an instance, ${wakingBodies.length} carry a waking light`,
    });
  }

  // The editor: the four fields round-trip on a point light, a spot never
  // writes them, a waking light with no times writes only `wake`.
  {
    const level = (light: LightObjectData): RawLevelData => ({
      player: { x: 0, y: 0, radius: 20 },
      bodies: [{ kind: "static", x: 100, y: -300, rot: 0, objects: [light] }],
    });
    const saved = (light: LightObjectData) =>
      modelToDisk(modelFromDisk(level(light))).bodies[0]!.objects.find(isLightObject)!;
    const full = saved({ type: "light", range: 400, wake: 300, wakeDelay: 0.25, wakeRise: 0.4, wakeFall: 2 });
    const bare = saved({ type: "light", range: 400, wake: 250 });
    const spot = saved({ type: "light", kind: "spot", range: 400, wake: 300, wakeDelay: 0.25 });
    const steady = saved({ type: "light", range: 400 });
    const ok =
      near(full.wake!, 300) &&
      full.wakeDelay === 0.25 &&
      full.wakeRise === 0.4 &&
      full.wakeFall === 2 &&
      near(bare.wake!, 250) &&
      bare.wakeDelay === undefined &&
      bare.wakeRise === undefined &&
      bare.wakeFall === undefined &&
      spot.wake === undefined &&
      spot.wakeDelay === undefined &&
      steady.wake === undefined;
    out.push({
      name: "editor: wake, wakeDelay, wakeRise and wakeFall survive a save; a spot never writes them",
      pass: ok,
      detail: `point ${JSON.stringify({ wake: full.wake, wakeDelay: full.wakeDelay, wakeRise: full.wakeRise, wakeFall: full.wakeFall })}; wake alone ${JSON.stringify({ wake: bare.wake, wakeDelay: bare.wakeDelay })}; spot ${JSON.stringify({ wake: spot.wake })}; always-on ${JSON.stringify({ wake: steady.wake })}`,
    });
  }

  // `+ Glow`: one body, a solid purple cube with its glow, the collision rect
  // it mirrors, and a waking point light at the cube's centre with the
  // editor's defaults.
  {
    const body = glowBody(new Vec2(4, -2));
    const collision = body.objects.filter(isCollisionObject);
    const geometry = body.objects.filter(isGeometryObject);
    const light = body.objects.filter(isLightObject);
    const square = (s: unknown): boolean =>
      JSON.stringify(s) === JSON.stringify({ kind: "rect", w: GLOW_CUBE, h: GLOW_CUBE });
    const g = geometry[0];
    const l = light[0];
    const ok =
      body.kind === "static" &&
      body.x === 4 &&
      body.y === -2 &&
      collision.length === 1 &&
      square(collision[0]!.shape) &&
      geometry.length === 1 &&
      square(g!.shape) &&
      g!.matchCollision === true &&
      g!.depth === GLOW_CUBE &&
      g!.texture === "color" &&
      g!.color === GLOW_COLOR &&
      g!.emissive === GLOW_EMISSIVE &&
      g!.emissiveIntensity === GLOW_EMISSIVE_INTENSITY &&
      light.length === 1 &&
      (l!.kind ?? "point") === "point" &&
      (l!.x ?? 0) === 0 &&
      (l!.y ?? 0) === 0 &&
      l!.color === GLOW_EMISSIVE &&
      l!.range === GLOW_RANGE &&
      l!.intensity === GLOW_INTENSITY &&
      l!.wake === GLOW_WAKE &&
      l!.wakeDelay === GLOW_WAKE_DELAY &&
      l!.wakeRise === GLOW_WAKE_RISE &&
      l!.wakeFall === GLOW_WAKE_FALL;
    out.push({
      name: "editor: + Glow places one static body - a solid purple cube, its collision rect, and a waking point light at its centre",
      pass: ok,
      detail: `${body.objects.length} objects; cube ${JSON.stringify(g?.shape)} ${g?.color} glowing ${g?.emissive} x${g?.emissiveIntensity}; light range ${l?.range} m, ${l?.intensity} cd, wake ${l?.wake} m, delay ${l?.wakeDelay} s, rise ${l?.wakeRise} s, fall ${l?.wakeFall} s`,
    });
  }

  // FIREFLIES. Only the plumbing has cases here: how a swarm flies (its lag,
  // its spread, its leashes) is feel, and gets its cases once it has been
  // played and settled (CLAUDE.md, "Validate the behaviour before writing the
  // cases").

  // The format: `fireflies` is a count and passes untouched; a swarm reads
  // `wake` as its notice distance and is never a waking light; a spot never
  // swarms; the count is clamped.
  {
    const scaled = scaleObject({ type: "light", fireflies: 12, wake: 250 }, PX) as LightObjectData;
    const swarm = swarmParams(scaled);
    const bare = swarmParams({ type: "light", fireflies: 5 });
    const spot = swarmParams({ type: "light", kind: "spot", fireflies: 5 });
    const none = swarmParams({ type: "light", fireflies: 0 });
    const big = swarmParams({ type: "light", fireflies: FIREFLY_MAX + 10 });
    const ok =
      scaled.fireflies === 12 &&
      swarm !== null &&
      swarm.count === 12 &&
      near(swarm.notice, 2.5) &&
      wakeParams(scaled) === null &&
      bare !== null &&
      bare.notice === DEFAULT_FIREFLY_NOTICE &&
      spot === null &&
      none === null &&
      big?.count === FIREFLY_MAX;
    out.push({
      name: "format: fireflies is a count, a swarm notices at `wake` and never wakes, a spot never swarms",
      pass: ok,
      detail: `12 @ 250 px -> ${JSON.stringify(swarm)}, waking ${wakeParams(scaled) === null ? "no" : "YES"}; bare ${JSON.stringify(bare)}; spot ${JSON.stringify(spot)}; 0 ${JSON.stringify(none)}; ${FIREFLY_MAX + 10} -> ${big?.count}`,
    });
  }

  // The rig: a swarm mounts no light of its own and spends none of the budget;
  // a level with no swarm builds no firefly light and no mote draw (so every
  // existing level is the scene it was); the pool never exceeds FIREFLY_POOL.
  {
    const rigOf = (swarms: number, steady: number) => {
      const rig = new LightRig();
      const scene = new THREE.Scene();
      const body = new THREE.Group();
      scene.add(body);
      let own = 0;
      for (let i = 0; i < steady; i++) rig.add(body, { type: "light", range: 4 }, { x: i, y: 0, rot: 0, z: 0 });
      for (let i = 0; i < swarms; i++) {
        const m = rig.add(body, { type: "light", fireflies: 8 }, { x: i, y: 1, rot: 0, z: 0 });
        m?.holder.traverse((o) => {
          if ((o as THREE.Light).isLight) own++;
        });
      }
      rig.buildPool(scene);
      let lights = 0;
      let draws = 0;
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight) lights++;
        if ((o as THREE.Points).isPoints && o.name === "fireflies") draws++;
      });
      rig.dispose();
      return { lights, draws, own };
    };
    const none = rigOf(0, 3);
    const few = rigOf(2, LIGHT_BUDGET);
    const many = rigOf(FIREFLY_POOL + 3, 0);
    const ok =
      none.lights === 3 &&
      none.draws === 0 &&
      few.lights === LIGHT_BUDGET + 2 &&
      few.draws === 1 &&
      many.lights === FIREFLY_POOL &&
      many.draws === 1 &&
      few.own + many.own === 0;
    out.push({
      name: "fireflies: a level with no swarm builds nothing, a swarm spends no light budget, the pool never exceeds FIREFLY_POOL",
      pass: ok,
      detail: `0 swarms + 3 steady: ${none.lights} lights, ${none.draws} draws; 2 + ${LIGHT_BUDGET} steady: ${few.lights} lights, ${few.draws} draw; ${FIREFLY_POOL + 3} swarms: ${many.lights} lights (FIREFLY_POOL ${FIREFLY_POOL}); a swarm's own lights: ${few.own + many.own}`,
    });
  }

  // The swarm is reproducible (two hatchings of the same seed fly the same
  // path, so a headless grab is evidence), stays home with no ball to follow,
  // and follows once the ball has come within its notice - for good.
  {
    const params = swarmParams({ type: "light", fireflies: 10 })!;
    const home = { x: 0, y: 0, z: 0.5 };
    const a = new Swarm(params, home, 3);
    const b = new Swarm(params, home, 3);
    const alone = new Swarm(params, home, 3);
    for (let i = 0; i < 120; i++) {
      a.step(1 / 60, home, { x: 1, y: 0, z: 0 });
      b.step(1 / 60, home, { x: 1, y: 0, z: 0 });
      alone.step(1 / 60, home, null);
    }
    const same = a.positions.every((v, i) => v === b.positions[i]);
    const far = new Swarm(params, home, 3);
    far.step(1 / 60, home, { x: DEFAULT_FIREFLY_NOTICE * 1.01, y: 0, z: 0 });
    const farHome = !far.following;
    far.step(1 / 60, home, { x: DEFAULT_FIREFLY_NOTICE * 0.99, y: 0, z: 0 });
    const noticed = far.following;
    far.step(1 / 60, home, { x: 50, y: 0, z: 0 });
    const ok = same && a.following && !alone.following && farHome && noticed && far.following;
    out.push({
      name: "fireflies: a swarm is reproducible, stays home with no ball, and follows once the ball comes within notice",
      pass: ok,
      detail: `same seed ${same ? "same path" : "DIFFERENT PATHS"}; no ball ${alone.following ? "FOLLOWS" : "home"}; just outside notice ${farHome ? "home" : "FOLLOWS"}, just inside ${noticed ? "follows" : "HOME"}, then 50 m away ${far.following ? "still follows" : "LET GO"}`,
    });
  }

  // A swarm on a FIREFLY PATH, through the rig that looks the path up by id:
  // it follows the ball along the path, leaves it at the path's end, flies back
  // to the start (not its authored home) and waits there - not noticing the
  // ball, still standing at the end within reach of nothing, until it has
  // come back. A swarm on the camera paths beside it follows for good.
  {
    const rig = new LightRig();
    const scene = new THREE.Scene();
    const body = new THREE.Group();
    scene.add(body);
    rig.add(body, { type: "light", fireflies: 6, path: 4 }, { x: -1, y: -0.5, rot: 0, z: 0.5 });
    rig.add(body, { type: "light", fireflies: 6 }, { x: -1, y: -0.5, rot: 0, z: 0.5 });
    rig.buildPool(scene);
    // Sim frame, metres: 10 m to the right along y = 0, starting at x = 0.
    rig.setRoutes([], [{ id: 4, x: 0, y: 0, rot: 0, verts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }]);
    let t = 0;
    const ball = { x: -1.5, y: 0 };
    const run = (seconds: number, vx: number) => {
      for (let i = 0; i < seconds * 60; i++) {
        ball.x += vx / 60;
        t += 1 / 60;
        rig.update(t, 1080, { ball, view: ball });
      }
      return rig.swarmStates();
    };
    const state = (s: { following: boolean; returning: boolean }) =>
      s.following ? "follow" : s.returning ? "return" : "home";
    const rolling = run(3, 3); // x 7.5: on the way
    const atEnd = run(1.5, 3); // x 12: past the end
    const back = run(8, 0); // 10 m at RETURN_SPEED, and time to settle
    const [pathed, camera] = back;
    const waitsAtStart = Math.hypot(pathed!.x - 0, pathed!.y - 0) < 0.6;
    const returned = run(4.5, -3); // x -1.5: back past the start
    const ok =
      state(rolling[0]!) === "follow" &&
      state(atEnd[0]!) === "return" &&
      state(pathed!) === "home" &&
      waitsAtStart &&
      state(camera!) === "follow" &&
      state(returned[0]!) === "follow";
    rig.dispose();
    out.push({
      name: "fireflies: a swarm on a firefly path leaves the player at its end, flies back to its start, and waits there until they come back",
      pass: ok,
      detail: `rolling ${state(rolling[0]!)}; past the end ${state(atEnd[0]!)}; 8 s later ${state(pathed!)} at ${pathed!.x.toFixed(2)},${pathed!.y.toFixed(2)} (start 0,0; home -1,-0.5); camera-path swarm ${state(camera!)}; back at the start ${state(returned[0]!)}`,
    });
  }

  // The editor: a firefly path round-trips with its id and curve (and no
  // keys), a swarm's `path` round-trips, and a light that is not a swarm never
  // writes one.
  {
    const raw: RawLevelData = {
      player: { x: 0, y: 0, radius: 20 },
      bodies: [
        {
          kind: "static",
          x: 100,
          y: -300,
          rot: 0,
          objects: [
            { type: "light", fireflies: 9, path: 3 },
            { type: "light", path: 3 },
          ],
        },
      ],
      fireflyPaths: [{ id: 3, x: 50, y: 60, rot: 0.5, verts: [{ x: 0, y: 0 }, { x: 400, y: 0, inX: -100, inY: 40 }] }],
    };
    const disk = modelToDisk(modelFromDisk(raw));
    const [swarm, lamp] = disk.bodies[0]!.objects.filter(isLightObject);
    const p = disk.fireflyPaths?.[0];
    const ok =
      disk.fireflyPaths?.length === 1 &&
      p!.id === 3 &&
      near(p!.x, 50) &&
      near(p!.y, 60) &&
      near(p!.rot, 0.5) &&
      p!.verts.length === 2 &&
      near(p!.verts[1]!.x, 400) &&
      near(p!.verts[1]!.inX!, -100) &&
      near(p!.verts[1]!.inY!, 40) &&
      Object.keys(p!.verts[1]!).length === 4 &&
      disk.cameraPaths === undefined &&
      swarm!.path === 3 &&
      lamp!.path === undefined;
    out.push({
      name: "editor: firefly paths and a swarm's `path` survive a save; only a swarm writes `path`",
      pass: ok,
      detail: `paths ${JSON.stringify(disk.fireflyPaths)}; camera paths ${JSON.stringify(disk.cameraPaths)}; swarm path ${swarm!.path}; lamp path ${lamp!.path}`,
    });
  }

  // The editor: `fireflies` round-trips on a point light, a swarm's colour,
  // intensity and reach are omitted at the FIREFLY's defaults (not a lamp's),
  // a swarm never writes the wake times, a spot never writes it at all; and
  // `+ Fireflies` places a body holding only the swarm's light.
  {
    const level = (light: LightObjectData): RawLevelData => ({
      player: { x: 0, y: 0, radius: 20 },
      bodies: [{ kind: "static", x: 100, y: -300, rot: 0, objects: [light] }],
    });
    const saved = (light: LightObjectData) =>
      modelToDisk(modelFromDisk(level(light))).bodies[0]!.objects.find(isLightObject)!;
    const swarm = saved({ type: "light", fireflies: 9, wake: 300, wakeRise: 0.4 });
    const spot = saved({ type: "light", kind: "spot", fireflies: 9 });
    const tinted = saved({ type: "light", fireflies: 9, color: DEFAULT_LIGHT_COLOR, intensity: DEFAULT_LIGHT_INTENSITY });
    const body = fireflyBody(new Vec2(4, -2));
    const l = body.objects.filter(isLightObject);
    const ok =
      swarm.fireflies === 9 &&
      near(swarm.wake!, 300) &&
      swarm.wakeRise === undefined &&
      swarm.color === undefined &&
      swarm.intensity === undefined &&
      swarm.range === undefined &&
      spot.fireflies === undefined &&
      tinted.color === DEFAULT_LIGHT_COLOR &&
      tinted.intensity === DEFAULT_LIGHT_INTENSITY &&
      body.objects.length === 1 &&
      l.length === 1 &&
      l[0]!.fireflies === FIREFLY_COUNT &&
      l[0]!.wake === FIREFLY_NOTICE &&
      l[0]!.color === undefined;
    out.push({
      name: "editor: fireflies survive a save against the firefly's own defaults; + Fireflies places a body holding only the swarm",
      pass: ok,
      detail: `swarm ${JSON.stringify(swarm)}; spot ${JSON.stringify({ fireflies: spot.fireflies })}; lamp-coloured swarm ${JSON.stringify({ color: tinted.color, intensity: tinted.intensity })}; + Fireflies ${JSON.stringify(body.objects)}`,
    });
  }
  return out;
}

// GENERATED GEOMETRY: the `generator` block on a geometry object, its parameter
// schemas, and the content-addressed mesh key (plans/visuals-workspace.md,
// Phase 2).
//
// Nothing here is visible in a picture, and every failure is silent in the way
// the rest of this file guards against: a length parameter left in pixels is a
// rock a hundred times too deep, a patch's host index that goes stale is a patch
// growing on the wrong object, and a key that drifts between the editor and the
// server is every rock in every level reading as stale (or, worse, as current).
function generatorCases(): CaseResult[] {
  const out: CaseResult[] = [];
  // Rounded to a micrometre for comparison, as `flattened` is: px -> m -> px
  // leaves float noise in the last bits of a length.
  const r6 = (_k: string, v: unknown): unknown => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a, r6) === JSON.stringify(b, r6);
  // A loader warning is part of what is asserted, never noise in the suite's
  // output, so a case that expects one catches it.
  const quietly = <T,>(run: () => T): { value: T; warnings: string[] } => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      return { value: run(), warnings };
    } finally {
      console.warn = warn;
    }
  };

  // One body, on disk in pixels: a collision outline, the boulder dressing it
  // (a length parameter and two that are not), the rock's mushroom patch naming
  // the rock as its host by index, and a second patch whose index names the
  // collision object - which is no host at all.
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 300,
        y: -100,
        rot: 0.25,
        color: "#555555",
        opacity: 1,
        friction: 1,
        objects: [
          { type: "collision", shape: { kind: "poly", verts: [{ x: -100, y: -50 }, { x: 100, y: -50 }, { x: 80, y: 60 }, { x: -90, y: 50 }] } },
          {
            type: "geometry",
            x: 20,
            y: 5,
            z: 12,
            kind: "mesh",
            mesh: "mushrooms:0000000000000000",
            shape: { kind: "rect", w: 40, h: 30 },
            generator: {
              kind: "mushrooms",
              version: 1,
              params: { density: 220, height: 25, noOverlaps: false },
              patch: { host: 2, points: [{ x: -20, y: 10, z: 3 }, { x: 20, y: 10, z: 4 }, { x: 0, y: -15, z: 6 }] },
            },
          },
          {
            type: "geometry",
            kind: "mesh",
            mesh: "boulder:0000000000000000",
            shape: { kind: "poly", verts: [{ x: -100, y: -50 }, { x: 100, y: -50 }, { x: 80, y: 60 }, { x: -90, y: 50 }] },
            generator: { kind: "boulder", version: 1, params: { depth: 120, weathering: 0.5, fractureAngle: 10, color: [0.2, 0.2, 0.25] } },
          },
          {
            type: "geometry",
            kind: "mesh",
            shape: { kind: "rect", w: 10, h: 10 },
            generator: { kind: "mushrooms", version: 1, patch: { host: 0, points: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 7, y: 8, z: 9 }] } },
          },
        ],
      },
    ],
  };
  const geometries = (d: LevelData): GeometryObjectData[] => d.bodies[0]!.objects.filter(isGeometryObject);

  // --- the format: px <-> m by schema unit ---------------------------------
  {
    const m = scaleLevelData(authored, PX);
    const [patch, rock] = geometries(m);
    const p = rock!.generator!.params!;
    const unitsRight =
      same(p.depth, 1.2) &&
      p.weathering === 0.5 &&
      p.fractureAngle === 10 &&
      JSON.stringify(p.color) === "[0.2,0.2,0.25]" &&
      same(patch!.generator!.params!.height, 0.25) &&
      patch!.generator!.params!.density === 220 &&
      patch!.generator!.params!.noOverlaps === false &&
      patch!.generator!.patch!.host === 2 &&
      same(patch!.generator!.patch!.points[2], { x: 0, y: -0.15, z: 0.06 });
    const back = scaleLevelData(m, PIXELS_PER_METER);
    const trip = same(geometries(back).map((g) => g.generator), geometries(scaleLevelData(authored, 1)).map((g) => g.generator));
    out.push({
      name: "generator: the block crosses px -> m by schema unit (a length scales; a count, a flag, an angle, a ratio, a colour and the host index do not) and back",
      pass: unitsRight && trip,
      detail: `in metres ${JSON.stringify({ rock: p, patch: patch!.generator })}; round trip ${trip ? "kept" : `became ${JSON.stringify(geometries(back).map((g) => g.generator))}`}`,
    });
  }

  // --- the editor: host index <-> item id ----------------------------------
  {
    const { value: model, warnings } = quietly(() => modelFromDisk(authored));
    const items = model.items.filter((i) => i.object === "geometry");
    const [patch, rock, orphan] = items;
    const g = patch!.visual.generator!;
    const loaded =
      g.kind === "mushrooms" &&
      g.patch!.hostId === rock!.id &&
      same(g.params.height, 0.25) &&
      same(rock!.visual.generator!.params.depth, 1.2) &&
      orphan!.visual.generator!.patch!.hostId === 0 &&
      orphan!.visual.generator!.patch!.points.length === 3 &&
      warnings.length === 1 &&
      warnings[0]!.includes("no host");
    out.push({
      name: "generator: a patch's host index loads as the host's item id; an index naming no other geometry object loads as no host, loop kept, with a warning",
      pass: loaded,
      detail: `host ${g.patch!.hostId} (rock ${rock!.id}); orphan ${JSON.stringify(orphan!.visual.generator!.patch)}; warnings ${JSON.stringify(warnings)}`,
    });

    // Saved back: the host is written as the index it now has, the orphan
    // writes none, and everything else is what was loaded.
    const saved = geometries(modelToDisk(model));
    const want = geometries(scaleLevelData(authored, 1)).map((o) => o.generator);
    delete want[2]!.patch!.host;
    const kept = same(saved.map((o) => o.generator), want);
    out.push({
      name: "generator: the editor saves the block back in pixels, the host as its index in the body, a hostless patch with no index",
      pass: kept,
      detail: kept ? "kept" : `\n  want  ${JSON.stringify(want, r6)}\n  saved ${JSON.stringify(saved.map((o) => o.generator), r6)}`,
    });

    // The body's objects reordered under the patch: a new object ahead of the
    // host moves the host's index, and the save follows it.
    const shifted: RawLevelData = JSON.parse(JSON.stringify(authored));
    const shiftedObjects = (shifted.bodies[0] as LevelBodyData).objects;
    shiftedObjects.splice(1, 0, { type: "geometry", shape: { kind: "rect", w: 5, h: 5 } });
    // The file states the host where it now is; the editor re-derives it.
    (shiftedObjects[2] as GeometryObjectData).generator!.patch!.host = 3;
    const moved = geometries(quietly(() => modelToDisk(modelFromDisk(shifted))).value);
    const follows = moved[1]!.generator!.patch!.host === 3 && moved[2]!.generator?.kind === "boulder";
    out.push({
      name: "generator: a patch whose host moved within the body is written with the host's new index",
      pass: follows,
      detail: `host ${moved[1]!.generator!.patch!.host}, object 3 is ${moved[2]!.generator?.kind ?? "not generated"}`,
    });

    // Clipboard: a copy of the whole body pastes as a patch hosted by the
    // PASTED rock, which is what `toLevelData` writing indexes buys for free.
    const payload = writeClipboard(model, model.items);
    const parsed = readClipboard(payload);
    const pasted = parsed ? quietly(() => modelFromDisk(parsed)).value : null;
    const pItems = pasted?.items.filter((i) => i.object === "geometry") ?? [];
    const pasteOk =
      pItems.length === 3 &&
      pItems[0]!.visual.generator!.patch!.hostId === pItems[1]!.id &&
      same(pItems[1]!.visual.generator!.params, rock!.visual.generator!.params) &&
      same(pItems[0]!.visual.generator!.patch!.points, g.patch!.points);
    out.push({
      name: "generator: copy and paste carries the block, the patch hosted by the pasted rock",
      pass: pasteOk,
      detail: pasteOk ? "kept" : `pasted ${JSON.stringify(pItems.map((i) => i.visual.generator), r6)}`,
    });

    // The deep copy the editor's snapshot, duplicate and paste make, and the
    // host remap a duplicate does: a copy's colour is its own array, its loop
    // its own list, and a patch copied without its host has none.
    const copy = cloneVisual(rock!.visual);
    (copy.generator!.params.color as number[])[0] = 0.9;
    const patchCopy = { ...patch!, visual: cloneVisual(patch!.visual) };
    remapPatchHosts([patchCopy], new Map([[patch!.id, 999]]));
    const detached =
      (rock!.visual.generator!.params.color as number[])[0] === 0.2 &&
      copy.generator !== rock!.visual.generator &&
      patchCopy.visual.generator!.patch !== g.patch &&
      patchCopy.visual.generator!.patch!.points !== g.patch!.points &&
      patchCopy.visual.generator!.patch!.hostId === 0 &&
      g.patch!.hostId === rock!.id &&
      cloneGenerator(g).patch!.hostId === rock!.id;
    out.push({
      name: "generator: cloneVisual detaches the block (params and loop), and a patch copied without its host is re-hosted to nothing",
      pass: detached,
      detail: `original colour ${JSON.stringify(rock!.visual.generator!.params.color)}, copy's host ${patchCopy.visual.generator!.patch!.hostId}`,
    });
  }

  // --- an untouched level saves byte-identically -----------------------------
  {
    const disk = JSON.stringify(BALL_LEVEL, null, 2);
    const saved = JSON.stringify(modelToDisk(modelFromDisk(BALL_LEVEL as RawLevelData)), null, 2);
    const identical = disk === saved;
    let at = 0;
    while (at < disk.length && disk[at] === saved[at]) at++;
    out.push({
      name: "generator: levels/ball.json (no generated objects) saves back byte-identical",
      pass: identical,
      detail: identical ? `${disk.length} bytes` : `first difference at ${at}: ${JSON.stringify(disk.slice(at - 40, at + 40))} vs ${JSON.stringify(saved.slice(at - 40, at + 40))}`,
    });
  }

  // --- the key ----------------------------------------------------------------
  {
    // Two fixed contents, and the keys they must make everywhere, for ever: a
    // change to either string is every generated mesh in every level going
    // stale, and is only ever made on purpose (with a schema version bump).
    const rockInput = { outline: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]] as [number, number][] };
    const rockParams = { seed: 7, depth: 1.2 };
    //
    // The patch's key was re-pinned once, on 2026-09-25 (it was
    // mushrooms:a63d3184bac129bb): its key INPUT changed shape - the host's
    // pose became its whole frame relative to the patch (`frame`, both tilts
    // and scales), and the side the loop was painted on (`facing`) joined it -
    // before any patch had been saved into a level. The schema `version` is the
    // parameters' and was not bumped; a changed input shape changes keys by
    // itself (docs/generators.md, "The editor's side").
    const patchInput = {
      loop: [[0, 0, 0.1], [0.5, 0, 0.1], [0.25, 0.4, 0.12]] as [number, number, number][],
      facing: [0, 0.6, 0.8] as [number, number, number],
      host: { kind: "mesh" as const, mesh: "boulder:0123456789abcdef", frame: [1, 0, 0, 0.1, 0, 1, 0, -0.2, 0, 0, 1, 0] },
    };
    const patchParams = { density: 200, noOverlaps: false };
    const rockKey = generatedKey("boulder", 1, rockInput, rockParams);
    const patchKey = generatedKey("mushrooms", 1, patchInput, patchParams);
    // Also computed under node (V8) when pinned, which agreed with bun (JSC).
    const ROCK_KEY = "boulder:c82bc75873f0956b";
    const PATCH_KEY = "mushrooms:b23c95d4426ccdcd";
    const text = canonicalString({ kind: "boulder", version: 1, input: rockInput, params: rockParams });
    const TEXT = `{"input":{"outline":[[-1,-0.5],[1,-0.5],[1,0.5],[-1,0.5]]},"kind":"boulder","params":{"depth":1.2,"seed":7},"version":1}`;
    out.push({
      name: "generator: generatedKey is pinned on two fixed inputs (a boulder outline, a mushroom patch) and on its canonical string",
      pass: rockKey === ROCK_KEY && patchKey === PATCH_KEY && text === TEXT,
      detail: `${rockKey}, ${patchKey}; canonical ${text}`,
    });

    // One rock, however its parameters are spelled: defaults written out,
    // float noise from a px round trip, keys in another order. And a different
    // rock for a different seed, version, outline or kind.
    const spelled = generatedKey("boulder", 1, rockInput, { depth: 1.2 + 1e-12, edgeVariation: 0.65, seed: 7, tolerance: null });
    const moved = generatedKey("boulder", 1, { outline: [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.51]] }, rockParams);
    const distinct = new Set([
      rockKey,
      generatedKey("boulder", 1, rockInput, { ...rockParams, seed: 8 }),
      generatedKey("boulder", 2, rockInput, rockParams),
      moved,
      generatedKey("mushrooms", 1, rockInput, {}),
    ]);
    const stable = spelled === rockKey && distinct.size === 5;
    out.push({
      name: "generator: generatedKey ignores defaults, float noise and key order, and changes with seed, version, outline and kind",
      pass: stable,
      detail: `spelled ${spelled}; ${distinct.size} distinct of 5`,
    });

    const hash = rockKey.split(":")[1]!;
    const resolved =
      generatedMeshAsset(rockKey)?.file === `/generated/boulder/${hash}/mesh.glb` &&
      generatedMeshAsset(patchKey)?.file === `/generated/mushrooms/${patchKey.split(":")[1]}/mesh.glb` &&
      generatedMeshAsset("rock-196") === null &&
      generatedMeshAsset("boulder-v5:263a5a5c-58d7-437c-b957-9900893e48b5:5129496") === null &&
      generatedMeshAsset("boulder:XYZ") === null &&
      parseGeneratedKey(patchKey)?.kind === "mushrooms";
    out.push({
      name: "generator: a generated key resolves to /generated/<kind>/<hash>/mesh.glb, and nothing else does",
      pass: resolved,
      detail: `${rockKey} -> ${generatedMeshAsset(rockKey)?.file}`,
    });

    // The preload list: a generated file is listed at the bytes its meta.json
    // records, and at 0 with a warning when there is none.
    const dir = mkdtempSync(join(tmpdir(), "rope-generated-"));
    mkdirSync(join(dir, "generated", "boulder", hash), { recursive: true });
    writeFileSync(join(dir, "generated", "boulder", hash, "meta.json"), JSON.stringify({ key: rockKey, bytes: 123456 }));
    const meta = generatedMeta(rockKey, dir);
    const missing = generatedMeta(patchKey, dir);
    rmSync(dir, { recursive: true, force: true });
    const level: RawLevelData = {
      player: { x: 0, y: 0, radius: 8 },
      bodies: [{ kind: "static", x: 0, y: 0, rot: 0, objects: [{ type: "geometry", kind: "mesh", mesh: patchKey }] }],
    };
    const { value: files, warnings } = quietly(() => levelStoredFiles(level));
    const listed = files.find((f) => f.file === generatedMeshAsset(patchKey)!.file);
    const preload = meta?.bytes === 123456 && missing === null && listed?.bytes === 0 && warnings.some((w) => w.includes("meta.json"));
    out.push({
      name: "generator: meta.json gives a generated file its bytes; the preload list names one without it at 0, with a warning",
      pass: preload,
      detail: `meta bytes ${meta?.bytes}, missing ${JSON.stringify(missing)}, listed ${JSON.stringify(listed)}, warnings ${warnings.length}`,
    });
  }

  // --- the schemas -------------------------------------------------------------
  {
    const problems: string[] = [];
    const counts: string[] = [];
    for (const kind of GENERATOR_KINDS) {
      const s = GENERATOR_SCHEMAS[kind];
      if (s.kind !== kind || !Number.isInteger(s.version) || s.version < 1) problems.push(`${kind}: kind/version`);
      if (!Array.isArray(s.notes?.constants) || s.notes.constants.length === 0) problems.push(`${kind}: no constants note`);
      const keys = new Set<string>();
      for (const p of s.params) {
        const where = `${kind}.${p.key}`;
        if (keys.has(p.key)) problems.push(`${where}: duplicate`);
        keys.add(p.key);
        if (!s.groups.includes(p.group)) problems.push(`${where}: group ${p.group}`);
        if (typeof p.basic !== "boolean" || typeof p.doc !== "string" || p.doc.length < 10) problems.push(`${where}: basic/doc`);
        if (p.unit !== undefined && p.unit !== "m" && p.unit !== "deg") problems.push(`${where}: unit ${p.unit}`);
        if (p.type === "int" || p.type === "number" || p.type === "color") {
          if (typeof p.min !== "number" || typeof p.max !== "number" || typeof p.step !== "number") problems.push(`${where}: min/max/step`);
        }
        if (p.type === "enum" && !(p.options ?? []).includes(p.default as number | string)) problems.push(`${where}: default not an option`);
        // Every default is itself a valid value (null is "derived").
        if (p.default !== null && validateParams({ [p.key]: p.default }, s).length > 0) problems.push(`${where}: default invalid`);
      }
      counts.push(`${kind} ${s.groups.map((g) => `${g} ${s.params.filter((p) => p.group === g).length}`).join(", ")}`);
    }
    out.push({
      name: "generator: both params.json files are well formed (unique keys, known groups and units, ranges, a doc each, defaults valid)",
      pass: problems.length === 0,
      detail: problems.length === 0 ? counts.join("; ") : problems.join("; "),
    });

    // The values the fork's editor actually sent, which is what "the port
    // changes nothing about an approved rock" rests on.
    const d = (kind: GeneratorKind) => Object.fromEntries(GENERATOR_SCHEMAS[kind].params.map((p) => [p.key, p.default]));
    const b = d("boulder");
    const m = d("mushrooms");
    const fork =
      b.seed === 31 && b.depth === 1.6 && b.tolerance === null && b.edgeVariation === 0.65 && b.weathering === 0.38 &&
      b.fractureAngle === 4 && b.detail === 1 && b.secondarySlabs === 0 && b.slabsPerArea === 10 &&
      JSON.stringify(b.color) === "[0.13,0.15,0.18]" && b.faceBudget === 3000 && b.bakeSize === 2048 &&
      m.seed === 0 && m.density === 150 && m.height === 0.16 && m.clumping === 0.75 && m.maxSlope === 75 &&
      m.detail === 0.3 && m.spacing === 0.02 && m.noOverlaps === true && m.glow === 2 && m.maxTriangles === 40000 &&
      m.maxEstimate === 3000;
    out.push({
      name: "generator: the defaults are the values the fork's editor sent (boulder seed 31, depth 1.6, ...; mushrooms density 150, detail 0.3, ...)",
      pass: fork,
      detail: `boulder ${JSON.stringify(b)}; mushrooms ${JSON.stringify(m)}`,
    });
  }

  // --- scaling, validation, defaults -----------------------------------------
  {
    const boulder = GENERATOR_SCHEMAS.boulder;
    const mushrooms = GENERATOR_SCHEMAS.mushrooms;
    const scaled = scaleParams(
      { depth: 1.2, edgeBevelWidth: 0.02, weathering: 0.5, fractureAngle: 10, faceBudget: 4000, color: [0.1, 0.2, 0.3], mystery: 3 },
      boulder,
      100,
    );
    const grown = scaleParams({ height: 0.2, spacing: 0.03, gap: 0.004, clumpSize: 0.5, density: 180, maxTilt: 20, noOverlaps: false }, mushrooms, 100);
    const byUnit =
      same(scaled, { depth: 120, edgeBevelWidth: 2, weathering: 0.5, fractureAngle: 10, faceBudget: 4000, color: [0.1, 0.2, 0.3], mystery: 3 }) &&
      same(grown, { height: 20, spacing: 3, gap: 0.4, clumpSize: 50, density: 180, maxTilt: 20, noOverlaps: false });
    out.push({
      name: "generator: scaleParams scales exactly the unit-m parameters (a degree, a count, a ratio, a density, a colour and an unknown key pass)",
      pass: byUnit,
      detail: `${JSON.stringify(scaled, r6)}; ${JSON.stringify(grown, r6)}`,
    });

    const bad = validateParams(
      { depth: 9, seed: 1.5, weathering: "much", bakeSize: 3000, color: [0.1, 2, 0.1], mystery: 1 },
      boulder,
    ).map((i) => i.key);
    const badBool = validateParams({ noOverlaps: 1, density: 0 }, mushrooms).map((i) => i.key);
    const good = validateParams({ depth: 5, seed: 0, color: [0, 1, 0.5], bakeSize: 4096, tolerance: 0.03 }, boulder);
    const rejects =
      JSON.stringify(bad.sort()) === JSON.stringify(["bakeSize", "color", "depth", "mystery", "seed", "weathering"]) &&
      JSON.stringify(badBool.sort()) === JSON.stringify(["density", "noOverlaps"]) &&
      good.length === 0;
    out.push({
      name: "generator: validateParams rejects out-of-range, mistyped, non-option and unknown values and passes the edges of the range",
      pass: rejects,
      detail: `flagged ${JSON.stringify(bad)} and ${JSON.stringify(badBool)}; valid set ${JSON.stringify(good)}`,
    });

    const authoredParams = { depth: 1.2, color: [0.2, 0.2, 0.25] };
    const merged = mergeDefaults(authoredParams, boulder);
    const stripped = stripDefaults(merged, boulder);
    const allDefaults = stripDefaults(mergeDefaults({}, boulder), boulder);
    const nearDefault = stripDefaults({ depth: 1.6 + 1e-9, seed: 31, weathering: 0.3801 }, boulder);
    const mergeOk =
      Object.keys(merged).length === boulder.params.length &&
      merged.depth === 1.2 &&
      merged.seed === 31 &&
      merged.tolerance === null &&
      same(stripped, authoredParams) &&
      Object.keys(allDefaults).length === 0 &&
      same(nearDefault, { weathering: 0.3801 }) &&
      same(canonicalParams({ weathering: 0.5, depth: 1.6, seed: 9 }, boulder), { seed: 9, weathering: 0.5 }) &&
      JSON.stringify(Object.keys(canonicalParams({ weathering: 0.5, seed: 9 }, boulder))) === '["seed","weathering"]';
    out.push({
      name: "generator: mergeDefaults fills every parameter and stripDefaults takes it back to what was authored, at 1e-4 resolution",
      pass: mergeOk,
      detail: `merged ${Object.keys(merged).length} of ${boulder.params.length}; stripped ${JSON.stringify(stripped)}; near-default ${JSON.stringify(nearDefault)}`,
    });
  }

  // --- staleness -----------------------------------------------------------------
  {
    const model = quietly(() => modelFromDisk(authored)).value;
    const lookup = itemLookup(model.items);
    const [patch, rock] = model.items.filter((i) => i.object === "geometry");
    // Generated as it stands.
    rock!.visual.mesh = expectedKey(rock!, lookup)!;
    patch!.visual.mesh = expectedKey(patch!, lookup)!;
    const fresh = !isStale(rock!, lookup) && !isStale(patch!, lookup);
    const plain = model.items.find((i) => i.object === "collision")!;
    const outline = boulderOutline(rock!);

    // The whole body moved and turned: nothing the generators read changed.
    const turn = 0.4;
    const pivot = new Vec2(1, 2);
    for (const i of model.items) {
      i.pos = pivot.add(i.pos.sub(pivot).rotated(turn));
      i.rot += turn;
    }
    const bodyMoved = !isStale(rock!, lookup) && !isStale(patch!, lookup);

    // The host alone moved: the patch is stale, the rock is not.
    const home = rock!.pos;
    rock!.pos = rock!.pos.add(new Vec2(0.05, 0));
    const hostMoved = !isStale(rock!, lookup) && isStale(patch!, lookup);
    rock!.pos = home;

    // The patch tipped or scaled on its own, or the host tipped: the relative
    // frame the key holds moved, so the patch is stale.
    const alone = (edit: () => void, undo: () => void): boolean => {
      edit();
      const stale = isStale(patch!, lookup);
      undo();
      return stale && !isStale(patch!, lookup);
    };
    const patchTipped = alone(() => (patch!.visual.rotX = 0.1), () => (patch!.visual.rotX = 0));
    const patchScaled = alone(() => (patch!.visual.scale = 1.2), () => (patch!.visual.scale = 1));
    const hostTipped = alone(() => (rock!.visual.rotY = 0.1), () => (rock!.visual.rotY = 0));

    // A primitive host: what it wears and its lens are part of its surface.
    rock!.visual.kind = "primitive";
    patch!.visual.mesh = expectedKey(patch!, lookup)!;
    const retextured = alone(() => (rock!.visual.texture = "moss"), () => (rock!.visual.texture = ""));
    const lens = rock!.visual.projection;
    const relensed = alone(
      () => (rock!.visual.projection = lens === "orthographic" ? "perspective" : "orthographic"),
      () => (rock!.visual.projection = lens),
    );
    rock!.visual.kind = "mesh";
    patch!.visual.mesh = expectedKey(patch!, lookup)!;

    // Two rocks never generated are two hosts: a patch on one keys the rock's
    // future key, so a different seed is a different patch; once the rock has
    // a mesh, its mesh key alone speaks for it.
    const rockMesh = rock!.visual.mesh;
    rock!.visual.mesh = "";
    const unmadeA = expectedKey(patch!, lookup);
    rock!.visual.generator!.params.seed = 99;
    const unmadeB = expectedKey(patch!, lookup);
    delete rock!.visual.generator!.params.seed;
    rock!.visual.mesh = rockMesh;
    const unmadeHosts = unmadeA !== null && unmadeB !== null && unmadeA !== unmadeB && !isStale(patch!, lookup);

    // A parameter, a vertex, the version.
    rock!.visual.generator!.params.depth = 1.3;
    const paramChanged = isStale(rock!, lookup) && isStale(patch!, lookup) === false;
    rock!.visual.generator!.params.depth = 1.2;
    const shape = rock!.shape as Extract<EdItem["shape"], { kind: "poly" }>;
    const vert = shape.verts[0]!;
    shape.verts[0] = vert.add(new Vec2(0.01, 0));
    const vertexChanged = isStale(rock!, lookup);
    shape.verts[0] = vert;
    rock!.visual.generator!.version = 2;
    const versionChanged = isStale(rock!, lookup);
    rock!.visual.generator!.version = 1;
    // Stale when the host goes, when never generated, never without a block.
    patch!.visual.generator!.patch!.hostId = 0;
    const hostless = isStale(patch!, lookup) && expectedKey(patch!, lookup) === null;
    const unmade = { ...rock!, visual: { ...rock!.visual, mesh: "" } };
    const results = {
      fresh,
      bodyMoved,
      hostMoved,
      patchTipped,
      patchScaled,
      hostTipped,
      retextured,
      relensed,
      unmadeHosts,
      paramChanged,
      vertexChanged,
      versionChanged,
      hostless,
      neverGenerated: isStale(unmade, lookup),
      noBlock: !isStale(plain, lookup),
      outlineUp: same(outline[0], [-1, 0.5]),
    };
    const ok = Object.values(results).every(Boolean);
    out.push({
      name: "generator: isStale follows the outline, the loop's host (its whole frame relative to the patch, a primitive's texture and lens, an ungenerated rock's future key), the patch's own tilt and scale, the params and the version, and not a move of the whole body",
      pass: ok,
      detail: JSON.stringify(results),
    });
  }
  return out;
}

// A boulder's outline as the key sees it: the object's own shape, y up.
function boulderOutline(item: EdItem): [number, number][] {
  const input = generatorInput(item, () => undefined);
  return input && "outline" in input ? input.outline : [];
}

// A small level for the tools' cases, on disk in pixels: one static body with
// an irregular collision polygon (about 2 m across) and the geometry matched
// to it, and a circle body that no rock can be fitted to.
function toolLevel(): RawLevelData {
  return {
    player: { x: 0, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 200,
        y: 100,
        rot: 0,
        objects: [
          {
            type: "collision",
            shape: { kind: "poly", verts: [{ x: -100, y: -40 }, { x: -30, y: -70 }, { x: 90, y: -50 }, { x: 110, y: 20 }, { x: 40, y: 60 }, { x: -80, y: 45 }] },
          },
          {
            type: "geometry",
            matchCollision: true,
            shape: { kind: "poly", verts: [{ x: -100, y: -40 }, { x: -30, y: -70 }, { x: 90, y: -50 }, { x: 110, y: 20 }, { x: 40, y: 60 }, { x: -80, y: 45 }] },
          },
        ],
      },
      { kind: "static", x: -300, y: 0, rot: 0, objects: [{ type: "collision", shape: { kind: "circle", r: 30 } }] },
    ],
  };
}

// THE TOOLS' PURE HALVES (Phase 5 of plans/visuals-workspace.md): the surface a
// mushroom loop covers, the objects + Rock and + Mushrooms add, and the panel's
// reading and writing of parameters. The editor's wiring (one undo step per
// gesture, the scene's meshes) is driven in the browser, not here.
function generatorTools(): CaseResult[] {
  const out: CaseResult[] = [];
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

  // --- the surface a loop covers, on a 1 m box at the origin ---------------
  {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    box.updateMatrixWorld(true);
    // A 0.6 m square on the top face, and one on the front face (a wall).
    const up = new THREE.Vector3(0, 1, 0);
    const toward = new THREE.Vector3(0, 0, 1);
    const top = [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]].map(([x, z]) => ({
      point: new THREE.Vector3(x!, 0.5, z!),
      normal: up,
    }));
    const front = [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]].map(([x, y]) => ({
      point: new THREE.Vector3(x!, y!, 0.5),
      normal: toward,
    }));
    const f = frameOf(top)!;
    const frameOk = f !== null && near(f.n.y, 1, 1e-9) && near(f.origin.y, 0.5, 1e-9) && f.band >= 0.05 && f.step > 0;
    const topSel = selectSurface([box], top, { maxSlopeDeg: 75, maxTriangles: 40000 });
    const topArea = topSel.ok ? topSel.selection.area : 0;
    const topTris = topSel.ok ? topSel.selection.triangles : 0;
    // The step cuts the box's two top triangles to the loop's edge: the area is
    // the loop's own 0.36 m^2 to within the cut's staircase.
    const areaOk = near(topArea, 0.36, 0.36 * 0.05) && topTris > 2;
    // A wall: refused at 75 degrees, taken at 90.
    const wall75 = selectSurface([box], front, { maxSlopeDeg: 75, maxTriangles: 40000 });
    const wall90 = selectSurface([box], front, { maxSlopeDeg: 90, maxTriangles: 40000 });
    const slopeOk = !wall75.ok && wall75.reason === "empty" && wall90.ok && near(wall90.selection.area, 0.36, 0.36 * 0.05);
    // A second box 3 m under the first: its top faces the loop and is inside it
    // seen from above, but it is far outside the band.
    const below = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    below.position.set(0, -3, 0);
    below.updateMatrixWorld(true);
    const banded = selectSurface([box, below], top, { maxSlopeDeg: 75, maxTriangles: 40000 });
    const bandOk = banded.ok && near(banded.selection.area, topArea, 1e-9);
    // Over the cap: an answer, not a search that never ends.
    const capped = selectSurface([box], top, { maxSlopeDeg: 75, maxTriangles: 1 });
    const capOk = !capped.ok && capped.reason === "overflow";
    // The soup in the patch's frame: world minus the patch origin, 1e-4 m.
    const pose = { x: 0, y: -0.5, z: 0, rot: 0, rotX: 0, rotY: 0, scale: 1 };
    const soup = topSel.ok ? soupInFrame(topSel.selection.positions, patchMatrix(pose).invert()) : [];
    const soupOk = soup.length === topTris * 9 && soup.filter((_, i) => i % 3 === 1).every((y) => y === 0);
    const ok = frameOk && areaOk && slopeOk && bandOk && capOk && soupOk;
    out.push({
      name: "generator: a painted loop collects the faces inside it (area, triangles), leaves a wall past maxSlope, a face outside the band and a soup over the cap",
      pass: ok,
      detail: JSON.stringify({ frameOk, topArea, topTris, slopeOk, bandOk, capOk, soupOk }),
    });
  }

  // --- the patch frame: a loop stored in it comes back where it was painted --
  {
    const pose = { x: 1.2, y: -0.4, z: 0.3, rot: 0.7, rotX: 0.2, rotY: -0.3, scale: 1.5 };
    const m = patchMatrix(pose);
    const inv = m.clone().invert();
    const w = new THREE.Vector3(1.5, 0.9, 0.1);
    const back = loopPointToWorld(m, worldToLoopPoint(inv, w));
    // The frame is the one `mountVisual` builds: a piece turned by `rot`, a
    // holder at `z` tipped (rotX, rotY) and scaled.
    const piece = new THREE.Group();
    piece.position.set(pose.x, -pose.y, 0);
    piece.rotation.z = -pose.rot;
    const holder = new THREE.Group();
    holder.position.z = pose.z;
    holder.rotation.set(pose.rotX, pose.rotY, 0);
    holder.scale.setScalar(pose.scale);
    piece.add(holder);
    piece.updateMatrixWorld(true);
    const local = new THREE.Vector3(0.1, -0.2, 0.3);
    const viaScene = local.clone().applyMatrix4(holder.matrixWorld);
    const viaFrame = local.clone().applyMatrix4(m);
    const ok = back.distanceTo(w) < 1e-12 && viaScene.distanceTo(viaFrame) < 1e-12;
    out.push({
      name: "generator: a patch's frame is the one mountVisual draws its mesh in, and a loop point round-trips through it",
      pass: ok,
      detail: `round trip ${back.distanceTo(w).toExponential(2)} m; scene vs frame ${viaScene.distanceTo(viaFrame).toExponential(2)} m`,
    });
  }

  // --- + Rock: one body gains one generated object ---------------------------
  {
    const model = modelFromDisk(toolLevel());
    const lookup = itemLookup(model.items);
    const [coll, matched] = model.items.filter((i) => i.bodyId === model.items[0]!.bodyId);
    const circle = model.items.find((i) => i.shape.kind === "circle")!;
    const fromOutline = rockSource(model.items, coll!);
    const fromMatched = rockSource(model.items, matched!);
    const noCircle = rockSource(model.items, circle) === null;
    const before = model.items.length;
    const rock = rockFor(fromOutline!, 9001);
    model.items.push(rock);
    const g = rock.visual.generator!;
    const block =
      g.kind === "boulder" &&
      g.version === GENERATOR_SCHEMAS.boulder.version &&
      Object.keys(g.params).length === 0 &&
      g.patch === null &&
      rock.visual.kind === "mesh" &&
      rock.visual.mesh === "" &&
      rock.object === "geometry" &&
      rock.bodyId === coll!.bodyId &&
      rock.matchId === coll!.id;
    // Not yet generated: stale, with a key to generate under.
    const stale = isStale(rock, itemLookup(model.items)) && wantedKey(rock, itemLookup(model.items)) !== null;
    const again = existingRock(model.items, coll!) === rock;
    // On disk: the same body, one more object, the block and the match.
    const data = toLevelData(model);
    const body = data.bodies.find((b) => b.objects.length === 3)!;
    const written = body?.objects.filter(isGeometryObject).find((o) => o.generator);
    const disk =
      model.items.length === before + 1 &&
      written?.generator?.kind === "boulder" &&
      written.matchCollision === true &&
      written.generator.params === undefined &&
      written.mesh === undefined;
    const ok = fromOutline === coll && fromMatched === coll && noCircle && block && stale && again && disk && lookup(coll!.id) === coll;
    out.push({
      name: "generator: + Rock adds one matched mesh object with a default boulder block to the outline's body, and finds it again",
      pass: ok,
      detail: JSON.stringify({ fromOutline: fromOutline === coll, fromMatched: fromMatched === coll, noCircle, block, stale, again, disk, written: written?.generator }),
    });
  }

  // --- + Mushrooms: the patch in the host's body, its loop in its own frame ---
  {
    const model = modelFromDisk(toolLevel());
    const host = model.items.find((i) => i.object === "geometry")!;
    // A loop on the host's front face, 0.1 m toward the camera, and a soup
    // under it.
    const loop = [
      new THREE.Vector3(1.8, -0.9, 0.1),
      new THREE.Vector3(2.2, -0.9, 0.12),
      new THREE.Vector3(2.1, -1.2, 0.14),
      new THREE.Vector3(1.85, -1.15, 0.1),
    ];
    const soup = new Float32Array([1.8, -1.2, 0.1, 2.2, -1.2, 0.14, 2.2, -0.9, 0.12, 1.8, -1.2, 0.1, 2.2, -0.9, 0.12, 1.8, -0.9, 0.1]);
    // The painted normals summed: toward the camera, a little up.
    const patch = patchFor(host, 9002, loop, soup, new THREE.Vector3(0, 0.4, 3.8));
    model.items.push(patch);
    const g = patch.visual.generator!;
    const m = patchMatrix(objectPose(patch, patch.visual.offsetZ));
    const worst = Math.max(...g.patch!.points.map((p, i) => loopPointToWorld(m, p).distanceTo(loop[i]!)));
    const lookup = itemLookup(model.items);
    const input = generatorInput(patch, lookup);
    const shape = patch.shape.kind === "rect" ? patch.shape : null;
    // The facing stored unit length, y down like the points, and keyed y up.
    const f = g.patch!.facing;
    const facingOk =
      f !== null && near(Math.hypot(f.x, f.y, f.z), 1, 1e-4) && near(f.y, -0.1047, 1e-4) && f.z > 0.99 &&
      input !== null && "facing" in input && near(input.facing![1], 0.1047, 1e-4);
    const placed =
      patch.bodyId === host.bodyId &&
      g.kind === "mushrooms" &&
      g.patch?.hostId === host.id &&
      patch.matchId === 0 &&
      patch.visual.mesh === "" &&
      near(patch.pos.x, 2, 1e-6) &&
      near(patch.pos.y, 1.05, 1e-6) &&
      near(patch.visual.offsetZ, 0.12, 1e-6) &&
      shape !== null && near(shape.w, 0.4, 1e-6) && near(shape.h, 0.3, 1e-6);
    const data = toLevelData(model);
    const objects = data.bodies.find((b) => b.objects.some((o) => isGeometryObject(o) && o.generator))!.objects;
    const written = objects.filter(isGeometryObject).find((o) => o.generator?.kind === "mushrooms");
    const hostIndex = objects.findIndex((o) => isGeometryObject(o) && !o.generator);
    const disk = written?.generator?.patch?.host === hostIndex && written.generator.patch.points.length === 4;
    // The facing is a direction: written as held, and not scaled px <-> m.
    const px = scaleLevelData(data, PIXELS_PER_METER);
    const pxPatch = px.bodies.flatMap((b) => b.objects).filter(isGeometryObject).find((o) => o.generator?.kind === "mushrooms");
    const asText = (v: unknown): string => JSON.stringify(v ?? null);
    const facingDisk =
      f !== null && asText(written?.generator?.patch?.facing) === asText(f) && asText(pxPatch?.generator?.patch?.facing) === asText(f);
    const ok = placed && worst < 1e-9 && input !== null && disk && facingOk && facingDisk;
    out.push({
      name: "generator: + Mushrooms adds one patch in the host's body, at the soup's middle and extent, its loop in its own frame naming the host, with the side it was painted on",
      pass: ok,
      detail: JSON.stringify({ placed, worst, input: input !== null, disk, facingOk, facingDisk, f, hostIndex, written: written?.generator?.patch?.host }),
    });

    // Edit loop moved the loop: the patch is fitted to what it covers now, and
    // the loop stays where it was painted in the world. A turned, tipped and
    // scaled patch, so the fit is shown in its own frame and not the world's.
    patch.rot = 0.3;
    patch.visual.rotX = 0.2;
    patch.visual.scale = 1.5;
    const frame = patchMatrix(objectPose(patch, patch.visual.offsetZ));
    const before = g.patch!.points.map((p) => loopPointToWorld(frame, p));
    // A soup 0.5 m further right in the patch's own frame, 0.2 x 0.1 x 0.02.
    const local = [[0.4, -0.05, 0], [0.6, -0.05, 0.02], [0.6, 0.05, 0.01]];
    const moved = new Float32Array(local.flatMap(([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(frame).toArray()));
    const fit = refitPatch(patch, frame, moved)!;
    const refitted = { ...patch, pos: fit.pos, visual: { ...patch.visual, offsetZ: fit.offsetZ } };
    const after = patchMatrix(objectPose(refitted, fit.offsetZ));
    const drift = Math.max(...fit.points.map((p, i) => loopPointToWorld(after, p).distanceTo(before[i]!)));
    const centre = new THREE.Vector3(0.5, 0, 0.01).applyMatrix4(frame);
    const origin = new THREE.Vector3().applyMatrix4(after);
    // The soup is a Float32Array (as `selectSurface` makes it), so the box it
    // gives is good to a few tenths of a micrometre.
    const refitOk =
      drift < 1e-9 &&
      origin.distanceTo(centre) < 1e-6 &&
      near(fit.w, 0.2, 1e-6) && near(fit.h, 0.1, 1e-6) && near(fit.depth, MIN_PATCH_EXTENT, 1e-9) &&
      refitPatch(patch, frame, new Float32Array(0)) === null;
    out.push({
      name: "generator: Edit loop re-fits the patch to the faces its loop covers now (origin, rect, depth in its own turned, tipped, scaled frame), the loop staying put in the world",
      pass: refitOk,
      detail: JSON.stringify({ drift, origin: origin.toArray(), centre: centre.toArray(), w: fit.w, h: fit.h, depth: fit.depth }),
    });
  }

  // --- a landing mesh in the redo states ------------------------------------
  // The swap keeps the redo stack and writes the mesh into every redo state
  // that wants it, so a redo after a landing keeps the rock; a state whose
  // content differs is left alone, as is a state without the object.
  {
    const redoState = (seed?: number) => {
      const m = modelFromDisk(toolLevel());
      const coll = m.items.find((i) => i.object === "collision" && i.shape.kind === "poly")!;
      const rock = rockFor(coll, 9004);
      if (seed !== undefined) rock.visual.generator!.params = { seed };
      m.items.push(rock);
      return m.items;
    };
    const same = redoState();
    const key = wantedKey(same.find((i) => i.id === 9004)!, itemLookup(same))!;
    const other = redoState(5);
    const without = redoState().filter((i) => i.id !== 9004);
    const landed = landMesh(same, 9004, key) && same.find((i) => i.id === 9004)!.visual.mesh === key;
    const again = !landMesh(same, 9004, key);
    const leftAlone = !landMesh(other, 9004, key) && other.find((i) => i.id === 9004)!.visual.mesh === "";
    const absent = !landMesh(without, 9004, key);
    out.push({
      name: "generator: a landed mesh goes into every redo state that wants that very key, and no other",
      pass: landed && again && leftAlone && absent,
      detail: JSON.stringify({ landed, again, leftAlone, absent }),
    });
  }

  // --- the panel: parameters in and out -------------------------------------
  {
    const schema = GENERATOR_SCHEMAS.boulder;
    const authored: ParamValues = { seed: 7, depth: 1.2, weathering: 0.5, bakeSize: 1024, color: [0.2, 0.2, 0.25] };
    // Every field written from the merged values, as the panel's setters do,
    // one at a time over an empty block: the defaults fall away and what was
    // authored is what is left.
    let params: ParamValues = {};
    for (const [key, value] of Object.entries(mergeDefaults(authored, schema))) params = withParam(params, schema, key, value);
    const sorted = (p: ParamValues) => JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));
    const trip = sorted(params) === sorted(stripDefaults(authored, schema)) && !("tolerance" in params);
    // A value set back to its default, and a cleared field, remove the key.
    const reset = withParam(withParam(params, schema, "depth", 1.6), schema, "seed", null);
    const resetOk = !("depth" in reset) && !("seed" in reset) && reset.weathering === 0.5;
    const intSpec = paramSpec(schema, "seed")!;
    const numSpec = paramSpec(schema, "depth")!;
    const clampOk = clampParam(intSpec, 7.6) === 8 && clampParam(intSpec, -3) === 0 && clampParam(numSpec, 9) === 5 && clampParam(numSpec, 0) === 0.02;
    const colour = paramSpec(schema, "color")!.default as number[];
    const hexTrip = linearOfHex(hexOfLinear(colour)).every((c, i) => Math.abs(c - colour[i]!) < 2e-3);
    const seeded = nextSeedParams({}, schema).seed === 32 && nextSeedParams({ seed: 2147483647 }, schema).seed === 0;
    const pasted = parseParamsPayload(paramsPayload("boulder", 1, authored), schema);
    const pasteOk =
      "params" in pasted &&
      JSON.stringify(pasted.params) === JSON.stringify(stripDefaults(authored, schema)) &&
      "error" in parseParamsPayload(paramsPayload("mushrooms", 1, { density: 10 }), schema) &&
      "error" in parseParamsPayload(paramsPayload("boulder", 1, { depth: 99 }), schema) &&
      "error" in parseParamsPayload("not json", schema);
    const pairs = paramIssues({ slabWidthMin: 0.6 }, schema);
    const pairOk = pairs.length === 1 && pairs[0]!.startsWith("slabWidthMin:");
    const labelOk = paramLabel(numSpec) === "depth (m)" && paramLabel(paramSpec(schema, "slabYaw")!) === "slab yaw°";
    const ok = trip && resetOk && clampOk && hexTrip && seeded && pasteOk && pairOk && labelOk;
    out.push({
      name: "generator: the panel writes only non-default values (stripDefaults round trip through the setters), clamps, pastes and flags a Min over its Max",
      pass: ok,
      detail: JSON.stringify({ trip, params, resetOk, clampOk, hexTrip, seeded, pasteOk, pairs, labelOk }),
    });
  }

  // --- the status line -------------------------------------------------------
  {
    const model = modelFromDisk(toolLevel());
    const coll = model.items.find((i) => i.object === "collision" && i.shape.kind === "poly")!;
    const rock = rockFor(coll, 9003);
    model.items.push(rock);
    const lookup = itemLookup(model.items);
    const key = wantedKey(rock, lookup)!;
    const none = () => null;
    const job = (state: Job["state"], extra: Partial<Job> = {}): Job => ({ itemId: rock.id, key, kind: "boulder", state, elapsed: 12.4, ...extra });
    const never = generatorStatus(rock, lookup, undefined, none);
    const running = generatorStatus(rock, lookup, job("running"), none);
    const failed = generatorStatus(rock, lookup, job("failed", { message: "Boulder generation failed.\nboulder: PASS; outline 0.02\nboulder: FAIL centre slice 0.041790\nkept in /tmp/x" }), none);
    const unexplained = generatorStatus(rock, lookup, job("failed", { message: "a\nb\nc\nd" }), none);
    rock.visual.mesh = key;
    const done = generatorStatus(rock, lookup, job("done"), () => ({ bytes: 1_499_436, triangles: 7504 }));
    const badgeFresh = generatorBadge(rock, lookup, job("done"));
    rock.visual.generator!.params = { depth: 1.2 };
    const stale = generatorStatus(rock, lookup, job("done"), none);
    // A failure for content the object no longer holds is not its status.
    const oldFailure = generatorStatus(rock, lookup, job("failed", { message: "x" }), none);
    // A current key with no file on this machine (the service answers 404).
    rock.visual.generator!.params = {};
    const missing = generatorStatus(rock, lookup, undefined, none, () => true);
    // The job's server restarted under it: lost, said as such.
    const lost = generatorStatus(rock, lookup, job("lost", { message: "the dev server restarted: press Generate again" }), none);
    // A value the key cannot be made of: said, never thrown out of the frame
    // loop that asks every frame. (A field never writes one; a file could.)
    rock.visual.generator!.params = { depth: Number.NaN };
    let invalid = { text: "threw", tone: "" } as { text: string; tone: string };
    let invalidBadge = "threw";
    try {
      invalid = generatorStatus(rock, lookup, undefined, none);
      invalidBadge = generatorBadge(rock, lookup, undefined);
    } catch {
      // `invalid` stays "threw"
    }
    rock.visual.generator!.params = { depth: 1.2 };
    const results = {
      lost: lost.text === "the dev server restarted: press Generate again" && lost.tone === "warn",
      invalid: invalid.text.startsWith("stale: invalid value") && invalid.tone === "warn" && invalidBadge === "stale",
      never: never.text === "stale: never generated" && never.tone === "warn",
      running: running.text === "generating 12 s" && running.tone === "busy",
      failed:
        failed.text === "failed: boulder: FAIL centre slice 0.041790\nanother seed or a looser tolerance may pass" &&
        failed.tone === "fail" &&
        unexplained.text === "failed: a\nb\nc",
      done: done.text === "7,504 triangles · 1.5 MB" && badgeFresh === "",
      stale: stale.text === "stale" && generatorBadge(rock, lookup, undefined) === "stale",
      oldFailure: oldFailure.text === "stale",
      missing: missing.text === "stale: file missing" && missing.tone === "warn",
      // The toolbar's line: nothing when everything is here.
      health:
        missingTools({ python: "3.14.0", blender: "5.2.0", deps: true, venv: true, queue: 0 }) === "" &&
        missingTools({ python: "3.14.0", blender: null, deps: false, venv: true, queue: 0 }) ===
          "Blender not found (rocks, mushrooms) · rock packages missing: bun run generators:setup",
    };
    out.push({
      name: "generator: the status line says never generated, generating N s, the failing check (and the remedy), the mesh's size, stale once edited, stale: file missing, lost to a restart, and stale: invalid value without throwing",
      pass: Object.values(results).every(Boolean),
      detail: JSON.stringify({ results, texts: [never.text, running.text, failed.text, done.text, stale.text] }),
    });
  }
  return out;
}

// THE JOB CLIENT against a scripted service: what it asks, and what it writes.
// Async because the client is (its fetches are promises); the timers it sets
// are a queue drained here in order.
export async function generatorJobCases(): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  // A fake service: the POST answers `post`, each GET the next of `gets` (the
  // last repeats), and every request is logged.
  interface Script {
    post: { status: number; body: unknown };
    gets: Record<string, unknown[]>;
  }
  const rig = (script: Script, wanted: () => string | null | undefined) => {
    const log: string[] = [];
    const timers: (() => void)[] = [];
    const swaps: string[] = [];
    let writable = true;
    const seen = new Map<string, number>();
    const fetcher: Fetcher = async (url, init) => {
      const method = init?.method ?? "GET";
      log.push(`${method} ${url}`);
      if (method === "POST") {
        const p = script.post;
        return { ok: p.status < 400, status: p.status, json: async () => p.body };
      }
      const key = decodeURIComponent(url.split("/").pop()!);
      const list = script.gets[key] ?? [];
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      const body = list[Math.min(n, list.length - 1)];
      // "offline": the server does not answer at all (mid-restart).
      if (body === "offline") throw new Error("fetch failed");
      return body === undefined
        ? { ok: false, status: 404, json: async () => ({ error: "No such job." }) }
        : { ok: true, status: 200, json: async () => body };
    };
    const jobs = new GeneratorJobs({
      fetch: fetcher,
      later: (fn) => void timers.push(fn),
      canWrite: () => writable,
      wantedKey: () => wanted(),
      swap: (_id, key) => void swaps.push(key),
      changed: () => {},
    });
    const drain = async () => {
      for (let i = 0; i < 50; i++) {
        await tick();
        const fn = timers.shift();
        if (!fn) {
          await tick();
          if (!timers.length) return;
          continue;
        }
        fn();
      }
    };
    return { jobs, log, swaps, drain, setWritable: (w: boolean) => (writable = w) };
  };
  const A = "boulder:00000000000000aa";
  const B = "boulder:00000000000000bb";
  const req = (key: string) => ({ kind: "boulder" as const, key, input: { outline: [] }, params: {} });

  // submit -> running -> done: one swap, and the mesh's facts kept.
  {
    const r = rig(
      { post: { status: 200, body: { key: A, state: "running" } }, gets: { [A]: [{ state: "running", elapsed: 1 }, { state: "done", elapsed: 6.9, bytes: 1000, triangles: 50 }] } },
      () => A,
    );
    await r.jobs.submit(7, req(A));
    await r.drain();
    const job = r.jobs.job(7);
    const ok = r.swaps.length === 1 && r.swaps[0] === A && job?.state === "done" && job.triangles === 50 && r.jobs.facts(A)?.bytes === 1000;
    out.push({
      name: "generator: the job client follows submit -> running -> done and puts the key on the object once",
      pass: ok,
      detail: JSON.stringify({ swaps: r.swaps, job, log: r.log }),
    });
  }

  // A key the service has no file for (a 404): the facts stay null and the key
  // reads as missing, where a key with a file does not.
  {
    const r = rig({ post: { status: 200, body: { key: A, state: "done" } }, gets: { [A]: [{ state: "done", elapsed: 1, bytes: 10, triangles: 2 }] } }, () => A);
    r.jobs.facts(A);
    r.jobs.facts(B);
    await r.drain();
    const ok = r.jobs.facts(B) === null && r.jobs.missing(B) && r.jobs.facts(A)?.bytes === 10 && !r.jobs.missing(A);
    out.push({
      name: "generator: the job client reads a 404 for a mesh key as a missing file",
      pass: ok,
      detail: JSON.stringify({ missingB: r.jobs.missing(B), missingA: r.jobs.missing(A), log: r.log }),
    });
  }

  // A newer submit for the same object: the older job is no longer followed,
  // and only the newer key lands.
  {
    const r = rig(
      {
        post: { status: 200, body: { state: "queued" } },
        gets: { [A]: [{ state: "done", elapsed: 1, bytes: 1, triangles: 1 }], [B]: [{ state: "running", elapsed: 0 }, { state: "done", elapsed: 2, bytes: 2, triangles: 2 }] },
      },
      () => B,
    );
    await r.jobs.submit(7, req(A));
    await r.jobs.submit(7, req(B));
    await r.drain();
    const askedA = r.log.filter((l) => l === `GET /api/generate/${encodeURIComponent(A)}`).length;
    const ok = r.swaps.length === 1 && r.swaps[0] === B && askedA === 0 && r.jobs.job(7)?.key === B;
    out.push({
      name: "generator: a newer submit for the same object supersedes the older job, whose result never lands",
      pass: ok,
      detail: JSON.stringify({ swaps: r.swaps, askedA, log: r.log }),
    });
  }

  // Failed: the model is untouched and the message is kept; a refused request
  // (400) is a failure too.
  {
    const r = rig(
      { post: { status: 200, body: { state: "running" } }, gets: { [A]: [{ state: "failed", elapsed: 3, message: "centre: FAIL\nkept in /tmp" }] } },
      () => A,
    );
    await r.jobs.submit(7, req(A));
    await r.drain();
    const refused = rig({ post: { status: 400, body: { error: "Invalid boulder parameters: depth: 9 is outside 0.02..5." } }, gets: {} }, () => A);
    await refused.jobs.submit(8, req(A));
    await refused.drain();
    const ok =
      r.swaps.length === 0 &&
      r.jobs.job(7)?.state === "failed" &&
      r.jobs.job(7)?.message === "centre: FAIL\nkept in /tmp" &&
      refused.swaps.length === 0 &&
      refused.jobs.job(8)?.state === "failed" &&
      (refused.jobs.job(8)?.message ?? "").includes("depth: 9 is outside");
    out.push({
      name: "generator: a failed job, or a refused request, keeps the model and the service's message",
      pass: ok,
      detail: JSON.stringify({ swaps: r.swaps, job: r.jobs.job(7), refused: refused.jobs.job(8) }),
    });
  }

  // During a drag the result waits, and lands once on the next flush; an
  // object deleted or edited away meanwhile gets nothing.
  {
    let wanted: string | null | undefined = A;
    const r = rig({ post: { status: 200, body: { state: "done" } }, gets: { [A]: [{ state: "done", elapsed: 0, bytes: 1, triangles: 1 }] } }, () => wanted);
    r.setWritable(false);
    await r.jobs.submit(7, req(A));
    await r.drain();
    const held = r.swaps.length === 0;
    r.jobs.flush();
    const stillHeld = r.swaps.length === 0;
    r.setWritable(true);
    r.jobs.flush();
    r.jobs.flush();
    const landedOnce = r.swaps.length === 1;
    // Deleted (undefined) and moved on (another key).
    const gone = rig({ post: { status: 200, body: { state: "done" } }, gets: { [A]: [{ state: "done", elapsed: 0, bytes: 1, triangles: 1 }] } }, () => undefined);
    await gone.jobs.submit(7, req(A));
    await gone.drain();
    wanted = B;
    const moved = rig({ post: { status: 200, body: { state: "done" } }, gets: { [A]: [{ state: "done", elapsed: 0, bytes: 1, triangles: 1 }] } }, () => wanted);
    await moved.jobs.submit(7, req(A));
    await moved.drain();
    const ok = held && stillHeld && landedOnce && gone.swaps.length === 0 && moved.swaps.length === 0;
    out.push({
      name: "generator: a result waits out a drag and lands once after it; a deleted or since-edited object gets nothing",
      pass: ok,
      detail: JSON.stringify({ held, stillHeld, landedOnce, gone: gone.swaps, moved: moved.swaps }),
    });
  }

  // The dev server restarted mid-job: a 404 for a running job is `lost` (not
  // `failed`: the generator said nothing), and says to Generate again. A few
  // unanswered polls (the second a restart takes) are asked again rather than
  // judged, and a server that never answers again is lost after POLL_MISSES.
  {
    const running = { state: "running", elapsed: 1 };
    const post = { status: 200, body: { state: "running" } };
    const restarted = rig({ post, gets: { [A]: [running, undefined] } }, () => A);
    await restarted.jobs.submit(7, req(A));
    await restarted.drain();
    const blip = rig({ post, gets: { [A]: [running, "offline", "offline", { state: "done", elapsed: 2, bytes: 1, triangles: 1 }] } }, () => A);
    await blip.jobs.submit(7, req(A));
    await blip.drain();
    const gone = rig({ post, gets: { [A]: ["offline"] } }, () => A);
    await gone.jobs.submit(7, req(A));
    await gone.drain();
    const asked = gone.log.filter((l) => l.startsWith("GET ")).length;
    const lost = restarted.jobs.job(7);
    const ok =
      lost?.state === "lost" &&
      (lost.message ?? "").includes("Generate again") &&
      restarted.swaps.length === 0 &&
      blip.jobs.job(7)?.state === "done" &&
      blip.swaps.length === 1 &&
      gone.jobs.job(7)?.state === "lost" &&
      asked === POLL_MISSES;
    out.push({
      name: "generator: a job the restarted dev server has no record of is lost (Generate again), not failed; unanswered polls are retried, then lost",
      pass: ok,
      detail: JSON.stringify({ lost, blip: blip.jobs.job(7), gone: gone.jobs.job(7), asked }),
    });
  }
  return out;
}

export function runRender3dCases(): CaseResult[] {
  return [
    ...beltRendering(),
    ...renderNeedsGeometry(),
    ...chainAnchors(),
    ...chainWrapPoints(),
    ...cameraCorrespondence(),
    ...levelLens(),
    ...blendStability(),
    ...orbitView(),
    ...orthographicView(),
    ...visualsView(),
    ...visualsGuides(),
    ...visualsWorkspace(),
    ...extrusionGeometry(),
    ...tippedPrimitive(),
    ...perObjectProjection(),
    ...depthOrdering(),
    ...surfaceResolution(),
    ...visualRoundTrip(),
    ...editorRoundTrip(),
    ...matchedOutline(),
    ...groupTransform(),
    ...vertexEditMoves(),
    ...pickIndex(),
    ...lightRoundTrip(),
    ...lightRidesBody(),
    ...lightAim(),
    ...lightShadowNear(),
    ...avatarSurface(),
    ...generatedSkies(),
    ...beamCases(),
    ...glowCases(),
    ...bodyFrame(),
    ...originToCom(),
    ...emissiveMaps(),
    ...propEmission(),
    ...emissiveMaterials(),
    ...realLevelRoundTrip(),
    ...waterFormat(),
    ...bounceFormat(),
    ...checkpointFormat(),
    ...levelMetaFormat(),
    ...clipboardPayload(),
    ...generatorCases(),
    ...generatorTools(),
  ];
}
