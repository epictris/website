// What the ball sees: the level around it, captured from the ball's centre every
// frame and filtered for roughness, so the iron reflects the rock it is rolling
// past, the water under it and the props beside it rather than only the sky.
//
// Before this the ball reflected `scene.environment` - the generated sky (or a
// captured HDRI), the same picture everywhere in the level. That is a ball in
// an open field: nothing in the cave occluded it, so a ball pressed into a dark
// crevice still mirrored a lit blue sky. The probe is the cave itself.
//
// HOW. A `CubeCamera` at the ball's centre draws the scene into six small
// faces, `PMREMGenerator.fromCubemap` convolves them into the mip chain a rough
// surface samples, and the result is the ball's own `envMap` (see
// `BallVisual.setReflection`). Nothing about the MATERIAL changes - how mirror
// -like the ball is stays its roughness and metalness, so the reflection is
// as strong as the reflection was, only of the real surroundings.
//
// What the probe draws differs from the frame in four deliberate ways:
//
// - THE AVATAR IS NOT IN IT. The camera is inside the ball, and the chain
//   leaves the loop a few centimetres away: a cube map is a picture at
//   infinity, so a link that close would smear across a third of the sphere.
//   The level's own chains stay in (see `ChainLayer.withoutAvatar`).
// - THE SKY IS THE ENVIRONMENT, not the flat backdrop colour the frame clears
//   to. Where no geometry is in the way, the ball reflects exactly what it
//   reflected before - the generated sky with its sun lobe and authored glows -
//   so the change is confined to what the level's geometry occludes.
// - NO SHADOW PASS. Shadow maps are scene-wide, not per view; the probe reuses
//   last frame's rather than re-rendering every caster six more times.
// - POINT SPRITES are sized for the face, not the window (`POINT_VIEW_HALF_
//   HEIGHT`), or every mote of spray would reflect eight times its size.
//
// Linear HDR throughout: three applies tone mapping only when drawing to the
// canvas, so the faces hold radiance and the ball tone-maps it once, with the
// rest of the frame.

import * as THREE from "three";
import { POINT_VIEW_HALF_HEIGHT } from "./space";

// Face size in pixels. The reflection is seen on a ball ~200 px across in play
// and further blurred by roughness (~0.18 worn), so 128 is already past what
// the mirror level resolves; the cost of a face is in its draw calls, not its
// pixels.
export const PROBE_SIZE = 128;

// How far the probe sees, metres. Fog has eaten anything past this in every
// level authored so far, and a finite far plane keeps depth precision for the
// near one, which sits inside the ball.
const PROBE_FAR = 200;

export class ReflectionProbe {
  private readonly cube = new THREE.WebGLCubeRenderTarget(PROBE_SIZE, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
  });
  private readonly camera: THREE.CubeCamera;
  private readonly pmrem: THREE.PMREMGenerator;
  // The filtered result, allocated by the first capture and drawn into in
  // place by every one after, so its texture - the one a material holds - is
  // the same object for the probe's life.
  private filtered: THREE.WebGLRenderTarget | null = null;
  // Scratch for the scene state a capture borrows and puts back.
  private readonly backgroundRotation = new THREE.Euler();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.camera = new THREE.CubeCamera(0.01, PROBE_FAR, this.cube);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  // Draw the scene from `at` (three's frame) and filter it. `near` is the
  // radius inside which nothing should be seen - the ball's own, so the floor
  // it rests on is still in the picture. Returns the texture to wear as an
  // `envMap`, the same object every call.
  capture(scene: THREE.Scene, at: THREE.Vector3, near: number): THREE.Texture {
    const renderer = this.renderer;
    for (const face of this.camera.children as THREE.PerspectiveCamera[]) {
      if (face.near === near) break;
      face.near = near;
      face.updateProjectionMatrix();
    }
    this.camera.position.copy(at);
    this.camera.updateMatrixWorld();

    const background = scene.background;
    const backgroundIntensity = scene.backgroundIntensity;
    const backgroundBlurriness = scene.backgroundBlurriness;
    this.backgroundRotation.copy(scene.backgroundRotation);
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const pointHalfHeight = POINT_VIEW_HALF_HEIGHT.value;
    if (scene.environment) {
      scene.background = scene.environment;
      scene.backgroundIntensity = scene.environmentIntensity;
      scene.backgroundBlurriness = 0;
      scene.backgroundRotation.copy(scene.environmentRotation);
    }
    renderer.shadowMap.autoUpdate = false;
    POINT_VIEW_HALF_HEIGHT.value = PROBE_SIZE / 2;
    try {
      this.camera.update(renderer, scene);
    } finally {
      scene.background = background;
      scene.backgroundIntensity = backgroundIntensity;
      scene.backgroundBlurriness = backgroundBlurriness;
      scene.backgroundRotation.copy(this.backgroundRotation);
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      POINT_VIEW_HALF_HEIGHT.value = pointHalfHeight;
    }

    // The first call lets the generator allocate (its scratch targets are
    // sized by that call); every later one draws into the same output.
    this.filtered = this.pmrem.fromCubemap(this.cube.texture, this.filtered);
    return this.filtered.texture;
  }

  dispose(): void {
    this.cube.dispose();
    this.filtered?.dispose();
    this.filtered = null;
    this.pmrem.dispose();
  }
}
