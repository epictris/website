// The Visuals workspace's camera, as data (see `ViewPose` in render3d/space.ts,
// which is where the one derivation of a three.js camera from a pose lives).
//
// What is here is the geometry of a pose that the gestures in `viewControls.ts`
// need and that `applyPose` states only implicitly: where the eye is, which way
// its axes point, and how far it may stand from what it looks at. Every answer
// is written to agree with `applyPose` - the pitch clamped the same way, the
// head-on case the same exact placement - and `cli render3d`'s `visuals:` cases
// check the gestures against a real three.js camera rather than against these,
// so a disagreement shows up as a failing gesture rather than hiding in both.

import {
  MAX_ORBIT_PITCH,
  poseDistance,
  type ViewPose,
} from "../../render3d/space";

export type { ViewPose } from "../../render3d/space";

// A point or a direction in three's frame (y up), metres.
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// How near and how far the camera may stand from its target, metres. Near
// enough to frame a 10 cm bracket, far enough to take in the longest level with
// the lens stood back; beyond either the view is either inside the geometry or
// a speck, and a dolly that runs away to either is a gesture that has to be
// undone by many more.
export const MIN_VIEW_DISTANCE = 0.2;
export const MAX_VIEW_DISTANCE = 200;

export function clampPitch(pitch: number): number {
  return Math.max(-MAX_ORBIT_PITCH, Math.min(MAX_ORBIT_PITCH, pitch));
}

// The pose standing `distance` metres from its target, clamped, and nothing
// else changed. The view is sized by `halfHeight` (see `ViewPose`), so this is
// the one conversion back from the quantity a person thinks in.
export function withDistance(pose: ViewPose, distance: number): ViewPose {
  const d = Math.max(MIN_VIEW_DISTANCE, Math.min(MAX_VIEW_DISTANCE, distance));
  const fovY = (pose.fovYDeg * Math.PI) / 180;
  return { ...pose, halfHeight: d * Math.tan(fovY / 2) };
}

// The camera's own axes, unit length: `right` and `up` span the image plane and
// `back` points from the target to the eye (three's camera looks down -z, so
// `back` is its +z). Head on they are the world's axes exactly. The pitch is
// clamped as `applyPose` clamps it, since the camera that is drawn is the
// clamped one.
export function poseBasis(pose: ViewPose): { right: Vec3; up: Vec3; back: Vec3 } {
  if (pose.yaw === 0 && pose.pitch === 0) {
    return { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, back: { x: 0, y: 0, z: 1 } };
  }
  const pitch = clampPitch(pose.pitch);
  const sy = Math.sin(pose.yaw);
  const cy = Math.cos(pose.yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  // `lookAt` with a world-up of +y: right is level (no roll), up is back x right.
  return {
    right: { x: cy, y: 0, z: -sy },
    up: { x: -sp * sy, y: cp, z: -sp * cy },
    back: { x: sy * cp, y: sp, z: cy * cp },
  };
}

// Where the camera stands.
export function poseEye(pose: ViewPose): Vec3 {
  const d = poseDistance(pose);
  const { back } = poseBasis(pose);
  const t = pose.target;
  return { x: t.x + back.x * d, y: t.y + back.y * d, z: t.z + back.z * d };
}
