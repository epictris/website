// Perspective camera maths. Right-handed, Z up; view space looks along local -Z,
// clip depth -1..+1 (WebGL).

import { type Mat4, multiply, vec } from "./math";
import type { Camera, Vec3 } from "./types";

/** Full-frame (36 x 24 mm) equivalent: the vertical FOV is stored, focal length derived. */
const SENSOR_HEIGHT_MM = 24;
export const fovToFocal = (fovDegrees: number) => SENSOR_HEIGHT_MM / 2 / Math.tan((fovDegrees * Math.PI) / 360);
export const focalToFov = (mm: number) => (2 * Math.atan(SENSOR_HEIGHT_MM / 2 / mm) * 180) / Math.PI;
export const horizontalFov = (c: Camera) =>
  (2 * Math.atan(Math.tan((c.fov * Math.PI) / 360) * (c.frame[0] / c.frame[1])) * 180) / Math.PI;

export const FOV_RANGE = [5, 140] as const;

export function defaultCamera(): Camera {
  return {
    position: [35, -48, 25],
    target: [20, 15, 10],
    fov: 36,
    roll: 0,
    shift: [0, 0],
    near: 0.05,
    far: 2000,
    frame: [1600, 900],
    locked: false,
  };
}

/** Why a camera is invalid, or null. */
export function cameraProblem(c: Camera): string | null {
  const nums = [c.fov, c.roll, c.near, c.far, ...c.position, ...c.target];
  if (!nums.every((v) => Number.isFinite(v) && Math.abs(v) <= 1e7)) return "Camera values must be finite.";
  if (c.shift && !(c.shift.length === 2 && c.shift.every((v) => Number.isFinite(v) && Math.abs(v) <= 1)))
    return "The lens shift must be two fractions of the frame from -1 to 1.";
  if (vec.len(vec.sub(c.position, c.target)) <= 1e-5) return "The camera position and target must differ.";
  if (c.fov < FOV_RANGE[0] || c.fov > FOV_RANGE[1]) return "The vertical FOV must be 5–140° (focal length 4.4–275 mm).";
  if (c.near < 0.0001 || c.far <= c.near) return "Clipping planes need 0.0001 ≤ near < far.";
  if (!c.frame.every((v) => Number.isInteger(v) && v >= 128 && v <= 4096))
    return "Frame dimensions must be whole pixels from 128 to 4096.";
  return null;
}

export interface CameraMatrices {
  view: Mat4;
  projection: Mat4;
  vp: Mat4;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  aspect: number;
}

export function cameraMatrices(c: Camera): CameraMatrices {
  const forward = vec.norm(vec.sub(c.target, c.position));
  let up: Vec3 = [0, 0, 1];
  if (Math.abs(vec.dot(forward, up)) > 0.9999) up = [0, 1, 0];
  const br = vec.norm(vec.cross(forward, up));
  const bu = vec.norm(vec.cross(br, forward));
  const roll = (c.roll * Math.PI) / 180;
  const cs = Math.cos(roll);
  const sn = Math.sin(roll);
  const right = vec.add(vec.mul(br, cs), vec.mul(bu, sn));
  const realUp = vec.sub(vec.mul(bu, cs), vec.mul(br, sn));
  const back = vec.mul(forward, -1);
  const view = [
    right[0],
    realUp[0],
    back[0],
    0,
    right[1],
    realUp[1],
    back[1],
    0,
    right[2],
    realUp[2],
    back[2],
    0,
    -vec.dot(right, c.position),
    -vec.dot(realUp, c.position),
    -vec.dot(back, c.position),
    1,
  ];
  const aspect = c.frame[0] / c.frame[1];
  const f = 1 / Math.tan((c.fov * Math.PI) / 360);
  const nf = 1 / (c.near - c.far);
  // Lens shift slides the frame across the image plane: an off-axis frustum.
  const [sx, sy] = c.shift ?? [0, 0];
  const projection = [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    2 * sx,
    2 * sy,
    (c.far + c.near) * nf,
    -1,
    0,
    0,
    2 * c.far * c.near * nf,
    0,
  ];
  return { view, projection, vp: multiply(projection, view), forward, right, up: realUp, aspect };
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export const boxCenter = (b: Box): Vec3 => [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2) as Vec3;
export const boxSize = (b: Box): Vec3 => [0, 1, 2].map((a) => b.max[a] - b.min[a]) as Vec3;

/** A front-facing or three-quarter camera looking at a box. */
export function presetCamera(c: Camera, which: "front" | "overview", b: Box): Camera {
  const cen = boxCenter(b);
  const extent = Math.max(...boxSize(b));
  const position: Vec3 =
    which === "front"
      ? [cen[0], b.min[1] - extent * 1.12, cen[2]]
      : [cen[0] + extent * 0.65, b.min[1] - extent * 1.12, cen[2] + extent * 0.6];
  return {
    ...c,
    target: cen,
    position,
    fov: 36,
    roll: 0,
    shift: [0, 0],
    near: Math.max(0.001, extent * 0.001),
    far: Math.max(2000, extent * 50),
  };
}

/** Keep the view direction; move so the box's bounding sphere fills the frame. */
export function fitCamera(c: Camera, b: Box): Camera {
  const center = boxCenter(b);
  const radius = vec.len(boxSize(b)) / 2;
  const aspect = c.frame[0] / c.frame[1];
  const vertical = (c.fov * Math.PI) / 180;
  const half = Math.min(vertical / 2, Math.atan(Math.tan(vertical / 2) * aspect));
  const distance = (radius / Math.sin(half)) * 1.06;
  let direction = vec.norm(vec.sub(c.position, c.target));
  if (!vec.len(direction)) direction = [0, -1, 0];
  return {
    ...c,
    target: center,
    position: vec.add(center, vec.mul(direction, distance)),
    far: Math.max(c.far, distance + radius * 3),
  };
}
