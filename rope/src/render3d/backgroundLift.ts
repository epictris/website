import * as THREE from "three";

// Art-directed depth separation for dark scenery. World z keeps the amount
// stable when the gameplay camera zooms or the editor camera orbits.
const strength = { value: 0.35 };

// backlift=0 compares with the accepted ball rim + reflection alone.
export function backgroundLiftFrom(params: URLSearchParams): void {
  const raw = params.get("backlift");
  const scale = raw === null || raw.trim() === "" ? 1 : Number(raw);
  strength.value = 0.35 * (Number.isFinite(scale) ? THREE.MathUtils.clamp(scale, 0, 2) : 1);
}

// Fragment-only: safe to apply after the scenery's depth prepass is attached.
export function wearBackgroundLift(mat: THREE.Material): void {
  if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial || mat.userData.backgroundLift) return;
  mat.userData.backgroundLift = true;
  const prior = mat.onBeforeCompile;
  const priorKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (shader, renderer) {
    prior.call(this, shader, renderer);
    const anchor = "#include <opaque_fragment>";
    if (!shader.fragmentShader.includes(anchor)) {
      throw new Error("backgroundLift: missing opaque_fragment shader anchor");
    }
    shader.uniforms.backgroundLiftStrength = strength;
    shader.fragmentShader = `uniform float backgroundLiftStrength;\n${shader.fragmentShader}`
      .replace(anchor, /* glsl */ `
        // Recover world z from the view-space surface position, including
        // instanced, displaced and transformed geometry (as editorFog does).
        float backdropZ = dot(viewMatrix[2].xyz, -vViewPosition - viewMatrix[3].xyz);
        float backdropDepth = smoothstep(1.5, 6.0, -backdropZ);
        float backdropLuma = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
        float backdropDark = 1.0 - smoothstep(0.02, 0.15, backdropLuma);
        vec3 backdropAir = vec3(0.030, 0.042, 0.060);
        // Lift shadows toward cool air without dimming bright scenery or
        // emissive sources. Mix retains variation in the wall's texture.
        outgoingLight = mix(outgoingLight, max(outgoingLight, backdropAir),
          backgroundLiftStrength * backdropDepth * backdropDark);
        ${anchor}
      `);
  };
  mat.customProgramCacheKey = function () {
    return `${priorKey.call(this)}|background-lift:1`;
  };
  mat.needsUpdate = true;
}
