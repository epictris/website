import * as THREE from "three";

// A broad virtual softbox reflected only by the iron avatar. Linear radiance:
// the material's own metal colour, roughness and specular BRDF still shape it.
const strength = { value: 1.2 };

// Independent of ballrim: ballfill=0 returns to the rim-only playtest.
export function ballReflectionFrom(params: URLSearchParams): void {
  const raw = params.get("ballfill");
  const scale = raw === null || raw.trim() === "" ? 1 : Number(raw);
  strength.value = 1.2 * (Number.isFinite(scale) ? THREE.MathUtils.clamp(scale, 0, 3) : 1);
}

export function wearBallReflection(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.ballReflection) return;
  mat.userData.ballReflection = true;
  const prior = mat.onBeforeCompile;
  const priorKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (shader, renderer) {
    prior.call(this, shader, renderer);
    const anchor = "#include <lights_fragment_end>";
    if (!shader.fragmentShader.includes(anchor)) {
      throw new Error("ballReflection: missing lights_fragment_end shader anchor");
    }
    shader.uniforms.ballReflectionStrength = strength;
    shader.fragmentShader = `uniform float ballReflectionStrength;\n${shader.fragmentShader}`
      .replace(anchor, /* glsl */ `
        #if defined(RE_IndirectSpecular)
          // Camera-relative upper left. The real normal map makes the steel's
          // facets catch the soft reflection as the ball rolls underneath it.
          vec3 ballReflectionDirection = reflect(-geometryViewDir, geometryNormal);
          vec3 ballSoftboxDirection = normalize(vec3(-0.4, 0.7, 0.6));
          float ballSoftboxPower = mix(5.0, 1.5, material.roughness);
          float ballSoftbox = pow(saturate(dot(ballReflectionDirection, ballSoftboxDirection)), ballSoftboxPower);
          radiance += vec3(0.72, 0.84, 1.0) * ballReflectionStrength * ballSoftbox;
        #endif
        ${anchor}
      `);
  };
  mat.customProgramCacheKey = function () {
    return `${priorKey.call(this)}|ball-reflection:1`;
  };
  mat.needsUpdate = true;
}
