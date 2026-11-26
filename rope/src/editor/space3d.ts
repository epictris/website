// Where an editor item is in the 3D world: its placement in the plane, and for
// a node standing off it (a rock in a 3D frame), its depth and tilt
// (`EdItem.z`/`tilt`, the convention of render3d/space.ts `placeBody3d`).
// Everything the editor draws or measures in 3D about an item - the solid
// guides, the decorations' formation frame - asks here.

import * as THREE from "three";
import type { Vec2 } from "../engine/vec2";
import { placeBody3d, threeRotation, threeY } from "../render3d/space";
import type { EdItem } from "./model";

// An item's 2D world placement (the plane's frame) as a 3D matrix (three's).
export function planeMatrix(pos: Vec2, rot: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pos.x, threeY(pos.y), 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), threeRotation(rot)),
    new THREE.Vector3(1, 1, 1),
  );
}

// A world placement with depth and tilt as a 3D matrix (three's).
export function poseMatrix(p: { pos: Vec2; rot: number; z: number; tilt: readonly [number, number] }): THREE.Matrix4 {
  if (p.z === 0 && p.tilt[0] === 0 && p.tilt[1] === 0) return planeMatrix(p.pos, p.rot);
  const o = new THREE.Object3D();
  placeBody3d(o, { x: p.pos.x, y: p.pos.y, rot: p.rot, z: p.z, tilt: [p.tilt[0], p.tilt[1]] });
  o.updateMatrix();
  return o.matrix.clone();
}

// An item's frame in the 3D world (three's).
export function itemMatrix(item: EdItem): THREE.Matrix4 {
  return poseMatrix(item);
}
