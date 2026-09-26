// DROP ON SURFACE: the arithmetic of the Visuals workspace's Shift-drag, which
// puts a selected prop or light down on whatever model is under the pointer
// (plans/visuals-workspace.md, "Picking and editing"). It is how a rock is
// stood on a ledge or a lamp is hung on a wall without typing an `off z` and
// checking it by eye.
//
// Pure, so `cli render3d` holds it to its promise without a scene: the editor
// asks `Scene3D.pickSurface` for the point and the face normal, and hands them
// here for what to write.

import * as THREE from "three";
import { Vec2 } from "../../engine/vec2";
import { threeRotation, threeY } from "../../render3d/space";
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

// An item's three angles (`rot` in the sim's convention, `rotX`/`rotY` in
// three's, radians), as `mountVisual` composes them.
export interface Tilt {
  readonly rot: number;
  readonly rotX: number;
  readonly rotY: number;
}

const _q = new THREE.Quaternion();
const _turn = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e = new THREE.Euler();

// The same object turned by the smallest rotation that takes its up (its local
// +y, three's frame) onto `normal`: a prop stood on a slope leans with the
// slope and keeps the heading it had, which is what "stand it on that" means.
// The largest turn that could be asked for is a half turn, where "smallest" has
// no one answer; three picks an axis and so does this.
//
// The composition is `mountVisual`'s (Euler order ZXY: the piece about z, the
// drawn thing inside it about x and y), so decomposing in the same order hands
// back exactly the three numbers the gizmo's ring writes.
export function alignUp(tilt: Tilt, normal: Vec3): Tilt {
  _q.setFromEuler(_e.set(tilt.rotX, tilt.rotY, threeRotation(tilt.rot), "ZXY"));
  _up.set(0, 1, 0).applyQuaternion(_q);
  _n.set(normal.x, normal.y, normal.z);
  if (_n.lengthSq() === 0) return tilt;
  _n.normalize();
  _turn.setFromUnitVectors(_up, _n);
  _q.premultiply(_turn);
  _e.setFromQuaternion(_q, "ZXY");
  return { rot: threeRotation(_e.z), rotX: _e.x, rotY: _e.y };
}

// Where a tilt points the object's up, three's frame: what `alignUp` is
// asserted against.
export function upOf(tilt: Tilt): Vec3 {
  _q.setFromEuler(_e.set(tilt.rotX, tilt.rotY, threeRotation(tilt.rot), "ZXY"));
  _up.set(0, 1, 0).applyQuaternion(_q);
  return { x: _up.x, y: _up.y, z: _up.z };
}
