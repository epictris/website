// DROP ON SURFACE: the arithmetic of the Visuals workspace's Shift-drag, which
// puts a selected light down on whatever model is under the pointer
// (plans/visuals-workspace.md, "Picking and editing"). It is how a lamp is hung
// on a wall without typing a `z` and checking it by eye.
//
// Pure, so `cli render3d` holds it to its promise without a scene: the editor
// asks `Scene3D.pickSurface` for the point and the face normal, and hands them
// here for what to write.

import { Vec2 } from "../../engine/vec2";
import { threeY } from "../../render3d/space";
import type { Vec3 } from "./viewPose";

// Where an object dropped on a surface hit stands, in the sim's frame: its
// origin on the hit point. `pos` is the gameplay plane's two axes (y down) and
// `z` its depth toward the camera, metres - the pair the gizmo's move writes.
//
// Rounded to a micron (`SURFACE_STEPS`): the hit is interpolated from
// float32 vertex data, so a face at exactly -0.2 m comes back as
// -0.19999999925, which the file would carry for ever as noise nobody authored.
export function surfacePlacement(point: Vec3): { pos: Vec2; z: number } {
  // Divided rather than multiplied back, so a round number comes out as the
  // double nearest it.
  const r = (v: number): number => Math.round(v * SURFACE_STEPS) / SURFACE_STEPS;
  return { pos: new Vec2(r(point.x), r(threeY(point.y))), z: r(point.z) };
}
// Steps per metre the placement is rounded to (a micron).
const SURFACE_STEPS = 1e6;
