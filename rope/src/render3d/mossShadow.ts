import * as THREE from "three";

// The ivy's leaves receive the sun's shadow with a fraction of the sun's
// biases (2026-09-30). The sun's constant bias and normal push are sized for
// the level's rock (environment.ts: about 6 cm of depth slack on the 75 m
// shadow camera, plus 3 cm along the normal), which is more than the gap
// between the ivy's sheets of leaves, so with them a leaf could never shadow
// the leaf below it and the carpet read flat. A bias is a property of the
// light, not the receiver, in three; this scales it inside the moss
// material's own program, where the receiver is known. The leaves are flat
// cards whose normal is the rock's rounded hull, pointing out of the stack
// toward the light, so the small push is enough against acne on them.
//
// Constant bias x 0.1 and normal bias x 0.5: 6 mm + 1.5 cm, against sheets
// 3 cm apart (build.STRATUM_GAP); more bias (x 0.3 / x 1) only thinned the
// shade between leaves. The filter radius is x 0.33: the sun's 3 texels
// spread three's nine PCF taps 4.5 cm apart on the moss, which drew every
// penumbra as a dither over the whole carpet (the carpet is all penumbra);
// at one texel the taps are adjacent and the penumbra is a smooth 4.5 cm.
let CONSTANT_SCALE = 0.1;
let NORMAL_SCALE = 0.5;
let RADIUS_SCALE = 0.33;
const PROGRAM_KEY = "moss-shadow-bias";

/** For the moss harness's experiments only: the scales, before any moss material is worn. */
export function setMossShadowScales(s: { constant?: number; normal?: number; radius?: number }): void {
  CONSTANT_SCALE = s.constant ?? CONSTANT_SCALE;
  NORMAL_SCALE = s.normal ?? NORMAL_SCALE;
  RADIUS_SCALE = s.radius ?? RADIUS_SCALE;
}

interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
}

const VERTEX_NEEDLE = "directionalLightShadows[ i ].shadowNormalBias";
const FRAGMENT_NEEDLE = "directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius,";

function patched(): { vertex: string; fragment: string } {
  const v = THREE.ShaderChunk.shadowmap_vertex;
  const f = THREE.ShaderChunk.lights_fragment_begin;
  // A text patch on three's chunks: say so the moment a three upgrade moves
  // the text, rather than silently shading the ivy flat again.
  if (!v.includes(VERTEX_NEEDLE) || !f.includes(FRAGMENT_NEEDLE)) {
    console.warn("[render3d] mossShadow: three's shadow chunks changed; the ivy receives with the sun's full biases");
  }
  return {
    vertex: v.replace(VERTEX_NEEDLE, `( ${VERTEX_NEEDLE} * ${NORMAL_SCALE.toFixed(3)} )`),
    fragment: f.replace(
      FRAGMENT_NEEDLE,
      `( directionalLightShadow.shadowBias * ${CONSTANT_SCALE.toFixed(3)} ), ( directionalLightShadow.shadowRadius * ${RADIUS_SCALE.toFixed(3)} ),`,
    ),
  };
}

/** Make the moss material cast, and receive with its finer shadow biases. Idempotent: the material is shared. */
export function wearMossShadowBias(mat: THREE.Material): THREE.Material {
  if (mat.userData.mossShadowBias === true) return mat;
  mat.userData.mossShadowBias = true;
  // CAST: for a PCF map three draws the shadow pass with the OPPOSITE side
  // of the material (WebGLShadowMap's `shadowSide` table), its trick against
  // acne on a closed mesh. The leaves are single-sided cards, so that drew
  // their backs only and every leaf facing the sun cast nothing at all.
  mat.shadowSide = THREE.DoubleSide;
  const prior = mat.onBeforeCompile;
  const priorKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (this: THREE.Material, shader: ShaderSource, renderer: THREE.WebGLRenderer) {
    prior.call(this, shader as Parameters<typeof prior>[0], renderer);
    const p = patched();
    shader.vertexShader = shader.vertexShader.replace("#include <shadowmap_vertex>", p.vertex);
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_begin>", p.fragment);
  } as typeof mat.onBeforeCompile;
  mat.customProgramCacheKey = function (this: THREE.Material) {
    return `${priorKey.call(this)}|${PROGRAM_KEY}`;
  };
  mat.needsUpdate = true;
  return mat;
}
