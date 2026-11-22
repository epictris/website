// Where an editor item is in the 3D world: its plane placement, carried into
// its body's 3D frame when the body is a 3D body (`EdModel.bodies3d`,
// `LevelBodyData.space`). Everything the editor draws or measures in 3D about
// an item - the solid guides, the decorations' formation frame - asks here.

import * as THREE from "three";
import type { Vec2 } from "../engine/vec2";
import { threeRotation, threeY } from "../render3d/space";
import type { EdItem } from "./model";

// An item's 2D world placement (the plane's frame) as a 3D matrix (three's).
export function planeMatrix(pos: Vec2, rot: number): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pos.x, threeY(pos.y), 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), threeRotation(rot)),
    new THREE.Vector3(1, 1, 1),
  );
}

// Per body, the matrix that carries the plane's frame onto the body's 3D one,
// or null for a 2D body. Registered once by the editor, which holds the model.
let body3dOf: (bodyId: number) => THREE.Matrix4 | null = () => null;
export function setBody3dResolver(resolve: (bodyId: number) => THREE.Matrix4 | null): void {
  body3dOf = resolve;
}

// An item's frame in the 3D world (three's).
export function itemMatrix(item: EdItem): THREE.Matrix4 {
  const m = planeMatrix(item.pos, item.rot);
  const lift = body3dOf(item.bodyId);
  return lift ? lift.multiply(m) : m;
}

// What the resolver answers for a 3D body: its 3D frame (render3d/space.ts
// `placeBody3d`, Euler ZYX) times the inverse of its 2D frame.
export function body3dLift(frame: { pos: Vec2; rot: number }, space: { z: number; tilt: [number, number] }): THREE.Matrix4 {
  const three = new THREE.Object3D();
  three.position.set(frame.pos.x, threeY(frame.pos.y), space.z);
  three.rotation.set(space.tilt[0], space.tilt[1], threeRotation(frame.rot), "ZYX");
  three.updateMatrix();
  return three.matrix.clone().multiply(planeMatrix(frame.pos, frame.rot).invert());
}
