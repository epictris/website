// The one conversion between the simulation's plane and the three.js scene, and
// the one derivation of the 3D camera from the 2D one.
//
// Physics is x right, y DOWN, rotation clockwise-positive, all in metres. Three
// is right-handed with y UP. Every placement in `render3d/` therefore goes
// through the helpers here rather than negating a y by hand at the call site:
// the negation appears in exactly one place, so a visual that is upside down or
// spinning the wrong way is a bug in this file and nowhere else.
//
//   three.position.x =  body.x
//   three.position.y = -body.y
//   three.position.z =  z            // 0 is the gameplay plane, +z toward the camera
//   three.rotation.z = -body.rot
//
// The camera is the other half. The existing `Camera` (metres + zoom) and
// `CameraController` (regions, blending, locks, viewportScale) stay the
// authority on where the view is and how much world is in it; the perspective
// camera is DERIVED from them every frame, with zoom becoming dolly distance.
// That is what keeps camera regions, blends and `viewportScale` working
// untouched, and it is what makes off-plane props parallax as the view zooms.
//
// Nothing in the 3D scene may depend on `PIXELS_PER_METER` except through this
// file: a `<px> * PX` length is a fixed on-screen size, which only means
// something under the 2D renderer's uniform transform (see "Traps" in
// docs/3d-rendering-plan.md). Those live on the 2D overlay canvas.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER } from "../engine/units";
import { VIEW_HEIGHT, VIEW_WIDTH } from "../render/viewport";
import type { Camera } from "../render/camera";

// Vertical field of view, degrees. Deliberately narrow: at ~34 deg the gameplay
// plane reads almost orthographic - a wall at the top of the frame is barely
// foreshortened, so the collision outline the level was authored against is
// still what the player sees - while props at other depths parallax enough to
// give the scene its space. Widening this is the single knob that turns the look
// from "2.5D diorama" into "first-person-ish", so it is a constant rather than
// something a level authors.
export const FOV_Y_DEG = 34;

// The frame is a fixed 16:9 (see render/viewport.ts), so the 3D camera's aspect
// is a constant for the same reason the 2D camera's viewport is.
export const VIEW_ASPECT = VIEW_WIDTH / VIEW_HEIGHT;

// A sim y coordinate as a three.js one. Named rather than inlined so a call site
// reads as a conversion instead of as an arithmetic accident.
export function threeY(y: number): number {
  return -y;
}

// A sim rotation (clockwise-positive about a y-down axis) as a three.js rotation
// about +z. The negation is the same one `threeY` applies, one derivative up.
export function threeRotation(rot: number): number {
  return -rot;
}

// Place `obj` at a world point on the gameplay plane, or `z` metres off it
// (+z toward the camera).
//
// Takes the object rather than returning a vector because a per-frame sync must
// not allocate: this writes into the object's own vector in place.
export function placeAt(obj: THREE.Object3D, p: Vec2, z = 0): void {
  obj.position.set(p.x, threeY(p.y), z);
}

// Turn `obj` to a sim rotation. Only the z rotation is ever written by the
// transform sync - a body's pose in this game IS one angle in the plane - so an
// authored prop's own rotX/rotY live on a child object rather than being folded
// in here and then overwritten every frame.
export function orientTo(obj: THREE.Object3D, rot: number): void {
  obj.rotation.z = threeRotation(rot);
}

// How much world is on screen vertically, in metres. This is the 2D renderer's
// transform read backwards: it draws a metre as `zoom * PIXELS_PER_METER` pixels
// into a viewport `camera.viewportHeight` tall.
//
// It reads the camera's OWN viewport rather than the fixed frame, because the
// editor is a second host with a free camera and a window-shaped canvas. For the
// game the two are the same thing - `main.ts` sets the camera's viewport to the
// fixed 1920x1080 frame precisely so that every player sees the same slice of
// the world - so nothing about the game path changes.
export function visibleHeightMetres(camera: Camera): number {
  return camera.viewportHeight / (camera.zoom * PIXELS_PER_METER);
}

// Where the perspective camera has to sit for the gameplay plane (z = 0) to be
// framed exactly as the 2D renderer frames it at this zoom.
//
// This is the whole correspondence: the plane is a fixed distance from the
// camera, so its on-screen scale is `dist * tan(fov/2)` of world per half-frame,
// and setting `dist` from the zoom makes that identical to the 2D transform.
// Zooming out dollies back rather than widening the lens, which is what makes
// parallax scale with zoom the way a real camera's does.
export function cameraDistance(camera: Camera, fovYDeg = FOV_Y_DEG): number {
  const fovY = (fovYDeg * Math.PI) / 180;
  return visibleHeightMetres(camera) / 2 / Math.tan(fovY / 2);
}

// A turn of the view about the point the camera is looking at, in radians. It is
// EDITOR-ONLY furniture and the game never sets it: the whole correspondence
// below (and every overlay drawn on top of it) holds because the gameplay plane
// is parallel to the image plane, so a level is played from the one view it was
// authored against.
//
// What it is for is judging the scene - how deep a prop reads, whether a light
// pool falls where it looks like it does on the plane - which is a question the
// head-on view cannot answer at all. Its cost is that the 2D overlay no longer
// lines up with what is drawn, so the editor stops drawing the overlay while the
// view is turned rather than drawing outlines in the wrong place (see the reset
// button in `editor.ts`).
export interface CameraOrbit {
  yaw: number;
  pitch: number;
}
export const NO_ORBIT: CameraOrbit = { yaw: 0, pitch: 0 };
// Short of the poles, where the up vector degenerates and the view rolls.
export const MAX_ORBIT_PITCH = (80 * Math.PI) / 180;
export function isHeadOn(orbit: CameraOrbit): boolean {
  return orbit.yaw === 0 && orbit.pitch === 0;
}

// Drive `threeCam` from the 2D camera. Called every rendered frame, before
// drawing; the 2D camera has already been updated by the CameraController, so
// the two are the same view by construction rather than by being kept in step.
export function syncCamera(
  threeCam: THREE.PerspectiveCamera,
  camera: Camera,
  fovYDeg = FOV_Y_DEG,
  orbit: CameraOrbit = NO_ORBIT,
): void {
  const x = camera.position.x;
  const y = threeY(camera.position.y);
  const dist = cameraDistance(camera, fovYDeg);
  threeCam.fov = fovYDeg;
  threeCam.aspect = camera.viewportWidth / camera.viewportHeight;
  // The head-on view is written out rather than reached through the orbit path
  // at zero, so the game's camera is the same arithmetic it has always been: a
  // `lookAt` that ought to produce the identity rotation is not a thing to take
  // on trust when every overlay in the project is aligned against it.
  if (isHeadOn(orbit)) {
    threeCam.position.set(x, y, dist);
    // Looking straight down -z keeps the gameplay plane parallel to the image
    // plane, which is what makes the alignment with the 2D overlay exact rather
    // than exact-at-the-centre. `lookAt` would give the same rotation, but this
    // states it: the camera never tilts, whatever the level does with the view.
    threeCam.rotation.set(0, 0, 0);
    threeCam.updateProjectionMatrix();
    return;
  }
  // Orbited: the camera swings around the point it was looking at, at exactly
  // the dolly distance the zoom asks for, so turning the view neither zooms it
  // nor slides what it is centred on.
  const pitch = Math.max(-MAX_ORBIT_PITCH, Math.min(MAX_ORBIT_PITCH, orbit.pitch));
  const cp = Math.cos(pitch);
  threeCam.position.set(
    x + dist * Math.sin(orbit.yaw) * cp,
    y + dist * Math.sin(pitch),
    dist * Math.cos(orbit.yaw) * cp,
  );
  threeCam.up.set(0, 1, 0);
  threeCam.lookAt(x, y, 0);
  threeCam.updateProjectionMatrix();
}

// Where a world point on the gameplay plane lands in VIEW pixels under the
// derived camera - which is, by the correspondence above, exactly where the 2D
// renderer draws it. It exists to be ASSERTED against that renderer rather than
// to be drawn with: the whole 3D scene stands on the two agreeing, so the claim
// is checked (`cli render3d`) instead of being believed.
export function projectToView(camera: Camera, world: Vec2): { x: number; y: number } {
  const scale = camera.zoom * PIXELS_PER_METER;
  return {
    x: (world.x - camera.position.x) * scale + camera.viewportWidth / 2,
    y: (world.y - camera.position.y) * scale + camera.viewportHeight / 2,
  };
}
