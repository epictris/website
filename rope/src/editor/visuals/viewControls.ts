// The Visuals workspace's navigation, as arithmetic on a `ViewPose`: each
// gesture is a pure function from the pose before to the pose after, so the
// pointer handlers only measure the pointer and `cli render3d` can hold each
// gesture to the promise it makes (the `visuals:` cases) without a page.
//
// The conventions are Blender's, since the workspace is a modelling view rather
// than a plan (plans/visuals-workspace.md, "Navigation"): orbit about a target,
// pan in the image plane at the target's depth, dolly toward what is under the
// pointer.
//
// Screen positions are normalised device coordinates, as `Scene3D.pick` and
// `unprojectToPlane` take them: x right and y UP, -1..1 across the viewport.

import type { Camera } from "../../render/camera";
import { NO_ORBIT, poseDistance, poseFromCamera, type SceneLens } from "../../render3d/space";
import {
  clampPitch,
  MAX_VIEW_DISTANCE,
  MIN_VIEW_DISTANCE,
  poseBasis,
  type Vec3,
  type ViewPose,
} from "./viewPose";

export interface Ndc {
  readonly x: number;
  readonly y: number;
}

// How much room a framed selection is given past its bounding sphere,
// dimensionless: enough that its silhouette does not touch the frame edge.
export const FRAME_MARGIN = 1.2;
// The radius framed when the bounds are a point (a single light, an empty
// level), metres: a view of nothing at all is a dolly to the minimum distance.
export const FRAME_MIN_RADIUS = 0.5;

// Turn the view about its target by `dYaw` and `dPitch` radians. The target
// stays at the centre of the frame and the camera at its distance, so the
// gesture is a turn and nothing else. The pitch is clamped short of the poles
// as the Level workspace's orbit is (`MAX_ORBIT_PITCH`), where the up vector
// degenerates and the view would roll.
export function orbit(pose: ViewPose, dYaw: number, dPitch: number): ViewPose {
  return { ...pose, yaw: pose.yaw + dYaw, pitch: clampPitch(pose.pitch + dPitch) };
}

// Slide the view in its own image plane as the pointer moves from `from` to
// `to`. The target (and the camera with it) moves along the camera's right and
// up by exactly the world distance the pointer covered AT THE TARGET'S DEPTH,
// so whatever is at that depth under the pointer stays under it - the grabbed
// point is carried, not approximated. Nearer things slide further and farther
// ones less, which is what a pan of a real camera looks like.
//
// `aspect` is the viewport's width over its height; the pose has no width.
export function pan(pose: ViewPose, aspect: number, from: Ndc, to: Ndc): ViewPose {
  const { right, up } = poseBasis(pose);
  // World metres per NDC unit at the target's depth: the frame's half height
  // is `halfHeight` there by definition, through either lens.
  const sx = (to.x - from.x) * pose.halfHeight * aspect;
  const sy = (to.y - from.y) * pose.halfHeight;
  const t = pose.target;
  return {
    ...pose,
    target: {
      x: t.x - right.x * sx - up.x * sy,
      y: t.y - right.y * sx - up.y * sy,
      z: t.z - right.z * sx - up.z * sy,
    },
  };
}

// Move the camera toward (`factor` < 1) or away from (`factor` > 1) the point
// `toward`, scaling its distance from the target by `factor`.
//
// It is a scaling of the whole camera about `toward`: the eye and the target
// both move along their lines through that point, and the view's size scales
// with them. So `toward` stays exactly where it was on screen - the dolly is a
// zoom about the cursor - and the eye can approach it for ever without passing
// through it, since a positive scale never flips a point to the other side.
// The caller passes the nearest thing under the pointer (a `pickSurface` hit,
// else the gameplay plane through `unprojectToPlane`); null dollies about the
// target itself, straight along the view axis.
//
// The distance is clamped to [MIN_VIEW_DISTANCE, MAX_VIEW_DISTANCE], and the
// factor with it, so a clamped dolly still keeps `toward` in place.
export function dolly(pose: ViewPose, toward: Vec3 | null, factor: number): ViewPose {
  const d = poseDistance(pose);
  const wanted = Math.max(MIN_VIEW_DISTANCE, Math.min(MAX_VIEW_DISTANCE, d * factor));
  const k = wanted / d;
  const t = pose.target;
  const h = toward ?? t;
  return {
    ...pose,
    target: { x: h.x + (t.x - h.x) * k, y: h.y + (t.y - h.y) * k, z: h.z + (t.z - h.z) * k },
    halfHeight: pose.halfHeight * k,
  };
}

// Look at a box (three's frame, metres) from the pose's current direction: the
// target on its centre, the view just big enough to hold its bounding sphere
// across the narrower of the two frame axes. What **F** does with the
// selection's bounds, or the level's when nothing is selected.
export function frame(pose: ViewPose, bounds: { min: Vec3; max: Vec3 }, aspect: number): ViewPose {
  const c = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  const dx = bounds.max.x - bounds.min.x;
  const dy = bounds.max.y - bounds.min.y;
  const dz = bounds.max.z - bounds.min.z;
  const radius = Math.max(FRAME_MIN_RADIUS, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2);
  const halfHeight = (radius * FRAME_MARGIN) / Math.min(1, aspect);
  const fovY = (pose.fovYDeg * Math.PI) / 180;
  const tan = Math.tan(fovY / 2);
  const d = Math.max(MIN_VIEW_DISTANCE, Math.min(MAX_VIEW_DISTANCE, halfHeight / tan));
  return { ...pose, target: c, halfHeight: d * tan };
}

// Head on, framed exactly as the 2D camera frames the plane: the pose the
// workspace is seeded with and what **Home** and `⟲ Reset view` return to. It
// is `poseFromCamera` with no orbit, so it is the Level workspace's camera to
// the bit (asserted by the `visuals:` cases).
export function headOn(camera: Camera, lens: SceneLens): ViewPose {
  return poseFromCamera(camera, lens, NO_ORBIT);
}
