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
  MAX_VIEW_PITCH,
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

// THE EDITOR'S OWN LENS, degrees of vertical field of view: the editor is a
// place to move around in, so it looks through a wide lens of its own rather
// than the level's. A level's lens is the game's framing - 70 mm, ~20 degrees,
// on the river - and through a lens that long a "close" view is magnification:
// a rock filling the screen is still metres away, and an orbit swings the eye
// round on that radius, through the rocks in between. Through this one, what
// fills the screen is what the eye is next to. The Game camera view still uses
// the level's lens (`gameCameraView`), and the first gesture after it comes
// back to this one (`withLens`).
export const EDITOR_FOV_Y_DEG = 60;

// To the poles (`MAX_VIEW_PITCH`): the view cube's Top and Bottom are there,
// and an orbit from one must not jump back to 80 degrees on its first move.
export function clampPitch(pitch: number): number {
  return Math.max(-MAX_VIEW_PITCH, Math.min(MAX_VIEW_PITCH, pitch));
}

// OVER THE POLES (the SpaceMouse, 2026-11-25): a pitch past +-90 degrees is
// the view carried on over the top, upside down - pitch pi is the plane seen
// from behind with the sky at the foot of the screen. Kept in (-pi, pi], and
// returned untouched when it already is.
export function wrapPitch(pitch: number): number {
  if (pitch > Math.PI) return pitch - 2 * Math.PI;
  if (pitch <= -Math.PI) return pitch + 2 * Math.PI;
  return pitch;
}

// Whether the view is upside down: carried over a pole, so the camera's up
// points below the horizon.
export function upsideDown(pitch: number): boolean {
  return Math.abs(pitch) > MAX_VIEW_PITCH;
}

// What a gesture's new pitch becomes. The mouse's orbit stops at the poles
// (`clampPitch`) from an upright view; a view the SpaceMouse turned over is
// orbited on round, since clamping it would snap it upright, and stops at the
// poles again once it is back.
export function nextPitch(from: number, to: number, overPoles: boolean): number {
  return overPoles || upsideDown(from) ? wrapPitch(to) : clampPitch(to);
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
// `back` is its +z). Head on they are the world's axes exactly. Any pitch, as
// `applyPose` takes any: past a pole (`upsideDown`) `up` points below the
// horizon, and `right` stays the same level axis, so the basis turns over the
// top continuously.
export function poseBasis(pose: ViewPose): { right: Vec3; up: Vec3; back: Vec3 } {
  if (pose.yaw === 0 && pose.pitch === 0) {
    return { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, back: { x: 0, y: 0, z: 1 } };
  }
  const pitch = pose.pitch;
  const sy = Math.sin(pose.yaw);
  const cy = Math.cos(pose.yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  // The pitch is a turn about the level `right`: right is level (no roll),
  // up is back x right.
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

// The pose seen through a lens of `fovYDeg` from exactly where it stands: the
// eye, the direction and the target are kept, and only the view's size changes
// with the lens. The same pose when the lens is already that one.
export function withLens(pose: ViewPose, fovYDeg: number): ViewPose {
  if (pose.fovYDeg === fovYDeg) return pose;
  const d = poseDistance(pose);
  return { ...pose, fovYDeg, halfHeight: d * Math.tan((fovYDeg * Math.PI) / 360) };
}
