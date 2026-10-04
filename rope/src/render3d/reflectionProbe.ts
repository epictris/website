// What the ball sees: the level around it, captured from the ball's centre every
// frame and blurred for roughness, so the iron reflects the rock it is rolling
// past, the water under it and the props beside it rather than only the sky.
//
// Before this the ball reflected `scene.environment` - the generated sky (or a
// captured HDRI), the same picture everywhere in the level. That is a ball in
// an open field: nothing in the cave occluded it, so a ball pressed into a dark
// crevice still mirrored a lit blue sky. The probe is the cave itself.
//
// HOW. A `CubeCamera` at the ball's centre draws the scene into six small
// faces, the GPU builds the cube's mipmaps, and the ball's material reads the
// mip its roughness asks for (`wearProbe`, `BallVisual.setReflection`).
// Nothing about the MATERIAL's numbers changes - how mirror-like the ball is
// stays its roughness and metalness, so the reflection is as strong as the
// reflection was, only of the real surroundings.
//
// MIPMAPS, NOT PMREM (2026-10-04). `PMREMGenerator.fromCubemap` convolved the
// cube for GGX every frame, and that alone cost ~1 ms of GPU at any face size
// (128, 64 and 32 px measured the same: it is a fixed train of passes) - the
// millisecond that kept a 4K frame on an RTX 4070 SUPER over 144 Hz. A box
// mip chain is one `generateMipmap`. What it gives up is the GGX lobe's
// shape: a rough reflection is a box blur of the right width rather than a
// lobe, on a ball a few hundred pixels across.
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

// How far the probe sees, metres. Past it the ball reflects the environment
// (the sky), as it did everywhere before the probe. It was 200 m, and the
// probe then cost 2.0-2.8 ms of GPU a frame (RTX 4070 SUPER, the river's
// start view, any resolution: it is draw calls, not pixels) - nearly half of
// a 4K frame, and what stood between it and a steady 144 Hz. What a ball
// ~200 px across mirrors sharply is the rock it is touching.
const PROBE_FAR = 5;

// A capture redraws ONE face (see `capture`), so the whole picture is renewed
// every six frames. A jump further than this between captures - a respawn, a
// new level - redraws all six, or the ball would mirror where it was.
const RECAPTURE_JUMP = 1;

export class ReflectionProbe {
  // Mipmapped, and rebuilt after every face drawn into it (three generates a
  // render target's mips after each `render` into it), so the chain always
  // holds the latest face. WebGL 2 filters cube maps across their seams.
  private readonly cube = new THREE.WebGLCubeRenderTarget(PROBE_SIZE, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  private readonly camera: THREE.CubeCamera;
  // Whether a whole cube has been drawn yet.
  private captured = false;
  // Scratch for the scene state a capture borrows and puts back.
  private readonly backgroundRotation = new THREE.Euler();
  // The face the next capture redraws, and where the last capture stood.
  private nextFace = 0;
  private readonly last = new THREE.Vector3();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.camera = new THREE.CubeCamera(0.01, PROBE_FAR, this.cube);
  }

  // Draw the scene from `at` (three's frame). `near` is the radius inside
  // which nothing should be seen - the ball's own, so the floor it rests on is
  // still in the picture. Returns the mipmapped cube to wear through
  // `wearProbe`, the same object every call.
  //
  // ONE FACE A CALL, in turn, so a frame pays for one sixth of the cube: at
  // 144 Hz the whole picture is at most six frames (42 ms) old, which a worn
  // iron ball's blurred reflection does not show. All six on the first call
  // and after a jump (`RECAPTURE_JUMP`). The mips are rebuilt every call, so
  // the face that changed is seen at once rather than every sixth frame.
  capture(scene: THREE.Scene, at: THREE.Vector3, near: number): THREE.CubeTexture {
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
      if (!this.captured || at.distanceTo(this.last) > RECAPTURE_JUMP) {
        this.camera.update(renderer, scene);
        this.captured = true;
      } else {
        const target = renderer.getRenderTarget();
        const face = this.nextFace;
        renderer.setRenderTarget(this.cube, face);
        renderer.render(scene, this.camera.children[face] as THREE.PerspectiveCamera);
        renderer.setRenderTarget(target);
        this.nextFace = (face + 1) % 6;
      }
      this.last.copy(at);
    } finally {
      scene.background = background;
      scene.backgroundIntensity = backgroundIntensity;
      scene.backgroundBlurriness = backgroundBlurriness;
      scene.backgroundRotation.copy(this.backgroundRotation);
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      POINT_VIEW_HALF_HEIGHT.value = pointHalfHeight;
    }

    return this.cube.texture;
  }

  dispose(): void {
    this.cube.dispose();
  }
}

// The mip a roughness reads (see `wearProbe`). A GGX lobe of roughness r is
// about 2r^2 radians wide, and a face is a quarter turn across, so the face
// resolution that blurs to the lobe is (pi/2) / (2r^2) texels: from 128 that
// is log2(128 * 4r^2 / pi) mips down. Worn iron (~0.3) reads mip ~3.9.
const PROBE_MAX_MIP = Math.log2(PROBE_SIZE);
const PROBE_LOD_SCALE = (PROBE_SIZE * 4) / Math.PI;

// Read in place of three's environment lighting, before `main`. Falls back to
// three's own (the scene's environment) until the probe has drawn.
const PROBE_PARS = /* glsl */ `
uniform samplerCube probeCube;
uniform bool probeOn;
uniform float probeIntensity;
vec3 probeRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
  if ( probeOn ) {
    vec3 reflectVec = reflect( - viewDir, normal );
    // As three's own: rough surfaces gather nothing from behind their tangent plane.
    reflectVec = normalize( mix( reflectVec, normal, pow4( roughness ) ) );
    reflectVec = transformDirectionByInverseViewMatrix( reflectVec, viewMatrix );
    float lod = clamp( log2( max( ${PROBE_LOD_SCALE.toFixed(4)} * roughness * roughness, 1.0 ) ), 0.0, ${PROBE_MAX_MIP.toFixed(1)} );
    return textureLod( probeCube, reflectVec, lod ).rgb * probeIntensity;
  }
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    return getIBLRadiance( viewDir, normal, roughness );
  #else
    return vec3( 0.0 );
  #endif
}
vec3 probeIrradiance( const in vec3 normal ) {
  if ( probeOn ) {
    vec3 worldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
    // Two texels a face: the light from that side of the cave, which is what
    // irradiance is, near enough on a ball that is mostly metal.
    return PI * textureLod( probeCube, worldNormal, ${(PROBE_MAX_MIP - 1).toFixed(1)} ).rgb * probeIntensity;
  }
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    return getIBLIrradiance( normal );
  #else
    return vec3( 0.0 );
  #endif
}
`;

// three's indirect-light chunk with the environment's two reads turned into
// the probe's. Each rewrite is checked, so a three upgrade that changes the
// chunk fails loudly here instead of quietly dropping the reflection.
function probeLightsChunk(): string {
  let chunk = THREE.ShaderChunk.lights_fragment_maps;
  const rewrites: [string, string][] = [
    ["#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )", "#if 1"],
    ["getIBLIrradiance( geometryNormal )", "probeIrradiance( geometryNormal )"],
    ["#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )", "#if defined( RE_IndirectSpecular )"],
    [
      "getIBLRadiance( geometryViewDir, geometryNormal, material.roughness )",
      "probeRadiance( geometryViewDir, geometryNormal, material.roughness )",
    ],
  ];
  for (const [from, to] of rewrites) {
    if (!chunk.includes(from)) throw new Error(`reflectionProbe: three's lights_fragment_maps no longer has "${from}"`);
    chunk = chunk.replace(from, to);
  }
  return chunk;
}

interface ProbeUniforms {
  probeCube: THREE.IUniform<THREE.CubeTexture | null>;
  probeOn: THREE.IUniform<boolean>;
  probeIntensity: THREE.IUniform<number>;
}

// Make `mat` light itself from the probe's cube (see `setProbe`) instead of
// from an `envMap`. Idempotent, and chained after any patch the material
// already carries (the avatar's), like `wearAvatar`.
export function wearProbe(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.probe) return;
  const uniforms: ProbeUniforms = {
    probeCube: { value: null },
    probeOn: { value: false },
    probeIntensity: { value: mat.envMapIntensity },
  };
  mat.userData.probe = uniforms;
  const prior = mat.onBeforeCompile;
  const priorKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (this: THREE.MeshStandardMaterial, shader, renderer) {
    prior.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `${PROBE_PARS}\nvoid main() {`)
      .replace("#include <lights_fragment_maps>", probeLightsChunk());
  };
  mat.customProgramCacheKey = function (this: THREE.MeshStandardMaterial) {
    return `${priorKey.call(this)}|probe-mips`;
  };
  mat.needsUpdate = true;
}

// What a material worn with `wearProbe` reflects from now on.
export function setProbe(mat: THREE.MeshStandardMaterial, cube: THREE.CubeTexture): void {
  const uniforms = mat.userData.probe as ProbeUniforms | undefined;
  if (!uniforms) return;
  uniforms.probeCube.value = cube;
  uniforms.probeOn.value = true;
  uniforms.probeIntensity.value = mat.envMapIntensity;
}
