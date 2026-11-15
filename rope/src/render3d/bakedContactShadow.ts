import * as THREE from "three";
import type { BakedFieldData } from "./bakedLighting";

export const bakedContactUniforms = {
  bakedContactCenter: { value: new THREE.Vector3() },
  bakedContactDirection: { value: new THREE.Vector3(0, 1, 0) },
  bakedContactRadius: { value: 0 },
};

/** First-order SH gives the local average direction towards the emitters. */
export function contactLightDirection(field: BakedFieldData, at: THREE.Vector3, out: THREE.Vector3): void {
  const p = [at.x, at.y, at.z].map((v, i) => THREE.MathUtils.clamp(
    (v - field.min[i]!) / (field.max[i]! - field.min[i]!), 0, 1) * (field.size[i]! - 1));
  const base = p.map(Math.floor), t = p.map((v, i) => v - base[i]!);
  out.set(0, 0, 0);
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const q = [x, y, z].map((v, i) => Math.min(field.size[i]! - 1, base[i]! + v));
    const w = (x ? t[0]! : 1-t[0]!) * (y ? t[1]! : 1-t[1]!) * (z ? t[2]! : 1-t[2]!);
    const index = ((q[2]! * field.size[1] + q[1]!) * field.size[0] + q[0]!) * 27;
    for (const [axis, k] of [[0,3],[1,1],[2,2]] as const) {
      const i = index + k * 3;
      const luma = field.coefficients[i]! * .2126 + field.coefficients[i+1]! * .7152 + field.coefficients[i+2]! * .0722;
      out.setComponent(axis, out.getComponent(axis) + w * luma);
    }
  }
  if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
  else out.normalize();
}

export function updateBakedContactShadow(field: BakedFieldData | null, at?: THREE.Vector3, radius = 0): void {
  bakedContactUniforms.bakedContactRadius.value = field && at ? radius : 0;
  if (!field || !at || radius <= 0) return;
  bakedContactUniforms.bakedContactCenter.value.copy(at);
  contactLightDirection(field, at, bakedContactUniforms.bakedContactDirection.value);
}

/** Analytic sphere shadow on existing receivers; no extra draw or texture read. */
export function patchBakedContactShadow(shader: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, bakedContactUniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vBakedContactPosition;")
    .replace("#include <project_vertex>", `#include <project_vertex>
      vec4 contactPosition = vec4(transformed, 1.0);
      #ifdef USE_BATCHING
        contactPosition = batchingMatrix * contactPosition;
      #endif
      #ifdef USE_INSTANCING
        contactPosition = instanceMatrix * contactPosition;
      #endif
      vBakedContactPosition = (modelMatrix * contactPosition).xyz;`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>
      varying vec3 vBakedContactPosition;
      uniform vec3 bakedContactCenter, bakedContactDirection;
      uniform float bakedContactRadius;
      float bakedContactVisibility(vec3 surfaceNormal) {
        if (bakedContactRadius <= 0.0) return 1.0;
        vec3 delta = bakedContactCenter - vBakedContactPosition;
        float along = dot(delta, bakedContactDirection);
        float distanceToRay = sqrt(max(0.0, dot(delta,delta) - along*along));
        float r = bakedContactRadius;
        float edge = smoothstep(r * 0.55, r * 1.35 + max(along,0.0) * 0.2, distanceToRay);
        float nearPlayer = 1.0 - smoothstep(r * 2.0, r * 6.0, length(delta));
        float directional = (1.0-edge) * step(0.0,along);
        // Diffuse emitters surround the player: also approximate the solid
        // angle blocked by its sphere, strongest on surfaces facing it.
        vec3 worldNormal = inverseTransformDirection(surfaceNormal, viewMatrix);
        float facing = max(0.0, dot(worldNormal, normalize(delta)));
        float contact = min(1.0, r*r / max(dot(delta,delta), r*r)) * facing;
        return 1.0 - nearPlayer * max(0.65 * directional, 0.75 * contact);
      }`)
    .replace("#include <lights_fragment_maps>", THREE.ShaderChunk.lights_fragment_maps);
  const add = "irradiance += lightMapIrradiance;";
  if (!shader.fragmentShader.includes(add)) throw new Error("Baked contact shadow shader hook missing");
  shader.fragmentShader = shader.fragmentShader.replace(add, "irradiance += lightMapIrradiance * bakedContactVisibility(normal);");
}
