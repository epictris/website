import * as THREE from "three";

// A small readability floor on the iron ball, independent of cave lighting.
// Linear radiance, added before tone mapping and fog; it illuminates no scenery.
const strength = { value: 0.12 };

// Playtest comparison: ballrim=0 disables it, ballrim=1 is the default.
export function ballRimFrom(params: URLSearchParams): void {
  const raw = params.get("ballrim");
  const scale = raw === null || raw.trim() === "" ? 1 : Number(raw);
  strength.value = 0.12 * (Number.isFinite(scale) ? THREE.MathUtils.clamp(scale, 0, 3) : 1);
}

export function wearBallRim(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.ballRim) return;
  mat.userData.ballRim = true;
  const prior = mat.onBeforeCompile;
  const priorKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (shader, renderer) {
    prior.call(this, shader, renderer);
    const anchor = "#include <opaque_fragment>";
    if (!shader.fragmentShader.includes(anchor)) {
      throw new Error("ballRim: missing opaque_fragment shader anchor");
    }
    shader.uniforms.ballRimStrength = strength;
    shader.fragmentShader = `uniform float ballRimStrength;\n${shader.fragmentShader}`
      .replace(anchor, /* glsl */ `
        // Geometric normals keep the outline continuous through painted dents.
        // Both directions are in view space, including orthographic views.
        float ballRimEdge = pow(1.0 - saturate(dot(nonPerturbedNormal, geometryViewDir)), 3.5);
        float ballRimUpper = mix(0.25, 1.0, smoothstep(-0.8, 0.65, nonPerturbedNormal.y));
        outgoingLight += vec3(0.68, 0.80, 1.0) * ballRimStrength * ballRimEdge * ballRimUpper;
        ${anchor}
      `);
  };
  mat.customProgramCacheKey = function () {
    return `${priorKey.call(this)}|ball-rim:1`;
  };
  mat.needsUpdate = true;
}
