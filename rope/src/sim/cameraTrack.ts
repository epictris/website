// The game camera as a pose per frame, for a host that is not the game to
// look through: `just scene-guide` bakes it into the level's Blender guide as
// an animated camera (tools/blender/scene_guide.py), so a scene is modelled
// from exactly the view the player gets.
//
// Nothing here re-derives the camera. The 2D camera comes out of the REAL
// `CameraController`, stepped at the fixed 1/60 `cameraRide` uses, and the 3D
// pose out of `poseFromCamera` with the level's own lens - the two functions the
// renderer runs every frame (`Scene3D` via `syncCamera`). So a change to the
// camera's feel, or to a level's regions, paths or lens, is in the next guide
// without anything here being touched.
//
// Two ways to drive it:
//
// - ALONG THE PATHS (the default): a follow point walks each of the level's
//   camera paths from its start to its end at a steady pace, and the controller
//   follows it through every region and path rule it passes. There is no
//   canonical player run for a level, and the route is what the level authors
//   the camera around, so this is the view the level is built for.
// - A RIDE of a recorded run (`--ride <bundle>`): the sim replayed frame by
//   frame and the camera fed exactly what `cli camera --ride` feeds it, for the
//   view a particular playthrough had.
//
// Both drive the controller at a fixed dt with `alpha = 1`, which is the game's
// camera up to the browser's wall-clock jitter - the same statement
// `cameraRide.ts` makes about itself.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { scaleLevelData, type RawLevelData } from "../level/levelFormat";
import { buildPolylineIndex, flattenPathNodes, pathNodesOf, pointAtArcLength } from "../lib/path";
import { BALL_ZOOM, GRAPPLE_ZOOM, type Camera } from "../render/camera";
import { buildCameraRules, CameraController } from "../render/cameraController";
import { CAMERA_SAMPLE_STEP } from "../render/pathProgress";
import { VIEW_HEIGHT, VIEW_WIDTH } from "../render/viewport";
import { CAMERA_FAR, lensOf, poseDistance, poseFromCamera, type SceneLens } from "../render3d/space";
import { RIDE_DT, rideRecording } from "./cameraRide";
import type { Recording } from "./trace";

// How fast the follow point walks a path, m/s. About a brisk roll: fast enough
// that a long route is a watchable length, slow enough that the lookahead and
// the spring settle the way they do under a player rather than trailing a
// point that outruns them.
export const WALK_SPEED = 3;

// Held at each path's end before the next one starts, so the spring settles on
// the end of the route rather than being cut off mid-arrival.
const SETTLE_SECONDS = 1.5;

// One frame of the camera, in THREE's frame (x right, y up, +z toward the
// viewer), metres. The camera stands at `eye` and looks straight down -z (the
// game's camera never tilts: `applyPose`'s head-on branch), so the eye is the
// whole placement.
export interface TrackFrame {
  eye: [number, number, number];
  // World metres from the frame's centre to its top edge on the plane the lens
  // frames - what the zoom is, as a size.
  halfHeight: number;
}

export interface CameraTrack {
  fps: number;
  // The level's lens: vertical field of view, and the 35 mm-equivalent focal
  // length it is (24 mm sensor height), which is how Blender states a lens.
  fovYDeg: number;
  focalLength: number;
  aspect: number;
  // The far plane the renderer would use at the farthest the camera stood.
  far: number;
  frames: TrackFrame[];
  // What drove it, for the log and the guide's own record.
  source: string;
}

function trackOf(cams: readonly Camera[], lens: SceneLens, source: string): CameraTrack {
  let far = CAMERA_FAR;
  const frames = cams.map((camera): TrackFrame => {
    const pose = poseFromCamera(camera, lens);
    const dist = poseDistance(pose);
    // `applyPose`'s far plane, operation for operation.
    far = Math.max(far, dist + pose.target.z + CAMERA_FAR / 2);
    return {
      eye: [pose.target.x, pose.target.y, pose.target.z + dist],
      halfHeight: pose.halfHeight,
    };
  });
  const fovY = (lens.fovYDeg * Math.PI) / 180;
  return {
    fps: Math.round(1 / RIDE_DT),
    fovYDeg: lens.fovYDeg,
    focalLength: 12 / Math.tan(fovY / 2),
    aspect: VIEW_WIDTH / VIEW_HEIGHT,
    far,
    frames,
    source,
  };
}

function freshCamera(): Camera {
  return { position: Vec2.ZERO, zoom: BALL_ZOOM, viewportWidth: VIEW_WIDTH, viewportHeight: VIEW_HEIGHT };
}

// Walk every camera path of `raw` (the on-disk level, pixels) in order.
export function trackAlongPaths(raw: RawLevelData, ball: boolean, speed = WALK_SPEED): CameraTrack {
  const level = scaleLevelData(raw, PX);
  const rules = buildCameraRules(level.cameraRegions ?? [], level.cameraPaths ?? []);
  const baseZoom = ball ? BALL_ZOOM : GRAPPLE_ZOOM;
  const camera = freshCamera();
  const ctl = new CameraController();
  const cams: Camera[] = [];
  const step = (follow: Vec2): void => {
    ctl.update(camera, RIDE_DT, follow, rules, baseZoom, null);
    cams.push({ ...camera });
  };
  for (const path of level.cameraPaths ?? []) {
    const flat = flattenPathNodes(pathNodesOf(path.verts), CAMERA_SAMPLE_STEP);
    const ix = buildPolylineIndex(flat.points, new Vec2(path.x, path.y), path.rot);
    if (ix.total <= 0) continue;
    // Each path starts from rest on its start, as a level does on its spawn.
    ctl.snap();
    const frames = Math.ceil(ix.total / (speed * RIDE_DT));
    for (let i = 0; i <= frames; i++) step(pointAtArcLength(ix, (ix.total * i) / frames));
    const end = pointAtArcLength(ix, ix.total);
    for (let i = 0; i < SETTLE_SECONDS / RIDE_DT; i++) step(end);
  }
  if (!cams.length) {
    // No route: the camera the level opens on, held.
    ctl.snap();
    for (let i = 0; i < SETTLE_SECONDS / RIDE_DT; i++) step(new Vec2(level.player.x, level.player.y));
  }
  const paths = level.cameraPaths?.length ?? 0;
  const source = cams.length
    ? `walked ${paths} camera path${paths === 1 ? "" : "s"} at ${speed} m/s`
    : "the spawn, held (no camera paths)";
  return trackOf(cams, lensOf(level.camera), source);
}

// The camera a recorded run had. The lens is the recording's level's.
export function trackFromRecording(rec: Recording, lensSource: RawLevelData, source: string): CameraTrack {
  const ride = rideRecording(rec);
  const cams = ride.frames.map((f): Camera => ({ ...freshCamera(), position: f.pos, zoom: f.zoom }));
  return trackOf(cams, lensOf(scaleLevelData(lensSource, PX).camera), source);
}
