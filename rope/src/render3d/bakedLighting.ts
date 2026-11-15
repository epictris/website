// Emission-only irradiance from Blender. Static lightmaps and the dynamic
// SH field both store white diffuse radiance (E / pi), in linear RGB.
import * as THREE from "three";
import { patchBakedContactShadow, updateBakedContactShadow } from "./bakedContactShadow";

const KEY = "gameBakedLighting";
export interface BakedFieldData {
  version: 1;
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  // x fastest, then y, then z; nine RGB SH coefficients at each grid point.
  coefficients: number[];
}

export function validateBakedField(value: unknown): BakedFieldData {
  const d = value as BakedFieldData;
  if (!d || d.version !== 1 || !Array.isArray(d.size) || d.size.length !== 3 ||
      !d.size.every((n) => Number.isInteger(n) && n >= 2) ||
      d.size.reduce((a, b) => a * b, 1) > 4096 ||
      !Array.isArray(d.min) || !Array.isArray(d.max) || d.min.length !== 3 || d.max.length !== 3 ||
      !d.min.every((n, i) => Number.isFinite(n) && Number.isFinite(d.max[i]) && d.max[i]! > n) ||
      !Array.isArray(d.coefficients) || d.coefficients.length !== d.size[0] * d.size[1] * d.size[2] * 27 ||
      !d.coefficients.every(Number.isFinite)) throw new Error("Invalid baked lighting field");
  return d;
}

export function shBasis(x: number, y: number, z: number): number[] {
  return [.282095, .488603*y, .488603*z, .488603*x, 1.092548*x*y, 1.092548*y*z,
    .315392*(3*z*z-1), 1.092548*x*z, .546274*(x*x-y*y)];
}

// Nine volumes stacked along z. Half-float linear filtering is part of
// WebGL2; unlike full floats this needs no optional filtering extension.
export class BakedField {
  readonly texture: THREE.Data3DTexture;
  constructor(readonly data: BakedFieldData) {
    validateBakedField(data);
    const [nx, ny, nz] = data.size;
    const pixels = new Uint16Array(nx * ny * nz * 9 * 4);
    for (let p = 0; p < nx * ny * nz; p++) {
      for (let k = 0; k < 9; k++) {
        const at = (k * nx * ny * nz + p) * 4;
        for (let c = 0; c < 3; c++) pixels[at+c] = THREE.DataUtils.toHalfFloat(data.coefficients[p*27+k*3+c]!);
        pixels[at+3] = THREE.DataUtils.toHalfFloat(1);
      }
    }
    this.texture = new THREE.Data3DTexture(pixels, nx, ny, nz * 9);
    this.texture.format = THREE.RGBAFormat;
    this.texture.type = THREE.HalfFloatType;
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }
  dispose(): void { this.texture.dispose(); }
}

const fields = new WeakMap<THREE.Object3D, BakedField>();
export function bakedFieldOf(root: THREE.Object3D): BakedField | null {
  const value: unknown = root.userData[KEY];
  if (!value) return null;
  let field = fields.get(root);
  if (!field) {
    field = new BakedField(validateBakedField(value));
    fields.set(root, field);
  }
  return field;
}

/** glTF has no standard lightmap slot. The exporter transports it in emission. */
export function restoreLightmap(material: THREE.Material): void {
  const mat = material as THREE.MeshStandardMaterial;
  if (!mat.isMeshStandardMaterial || !mat.userData[KEY] || mat.lightMap) return;
  // The optimiser folds a constant (often completely black) image into the
  // emission factor. It is still a baked receiver, not a field receiver.
  if (mat.emissiveMap) mat.lightMap = mat.emissiveMap;
  else {
    const c = mat.emissive;
    mat.lightMap = new THREE.DataTexture(new Float32Array([c.r,c.g,c.b,1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    mat.lightMap.needsUpdate = true;
  }
  const encoding = mat.userData[KEY] as { encoding?: string; range?: number };
  if (encoding.encoding === "log1p") {
    const range = encoding.range;
    if (typeof range !== "number" || !Number.isFinite(range) || range < 1) throw new Error("Invalid logarithmic lightmap range");
    const previous = mat.onBeforeCompile;
    const key = mat.customProgramCacheKey();
    mat.onBeforeCompile = function(shader, renderer) {
      previous.call(this, shader, renderer);
      // Matches lightmap_encoding.py: reserve precision for dim cave light.
      shader.uniforms.bakedLightmapLogRange = { value: Math.log2(1 + 16 * range) };
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float bakedLightmapLogRange;")
        .replace("#include <lights_fragment_maps>", THREE.ShaderChunk.lights_fragment_maps);
      const sample = "lightMapTexel.rgb * lightMapIntensity";
      if (!shader.fragmentShader.includes(sample)) throw new Error("Lightmap decode shader hook missing");
      shader.fragmentShader = shader.fragmentShader.replace(sample,
        "((exp2(lightMapTexel.rgb * bakedLightmapLogRange) - 1.0) / 16.0) * lightMapIntensity");
    };
    mat.customProgramCacheKey = () => `${key}|baked-lightmap-log1p`;
    mat.lightMapIntensity = Math.PI;
  } else {
    mat.lightMapIntensity = Math.PI * mat.emissiveIntensity;
  }
  const previous = mat.onBeforeCompile;
  const key = mat.customProgramCacheKey();
  mat.onBeforeCompile = function(shader, renderer) {
    previous.call(this, shader, renderer);
    patchBakedContactShadow(shader);
  };
  mat.customProgramCacheKey = () => `${key}|baked-contact-shadow-1`;
  mat.emissiveMap = null;
  mat.emissive.setRGB(0, 0, 0);
  mat.emissiveIntensity = 0;
  mat.needsUpdate = true;
}

const empty = new THREE.Data3DTexture(new Uint16Array(4), 1, 1, 1);
empty.type = THREE.HalfFloatType;
empty.needsUpdate = true;
const uniforms = {
  bakedFieldTexture: { value: empty },
  bakedFieldMin: { value: new THREE.Vector3() },
  bakedFieldMax: { value: new THREE.Vector3(1, 1, 1) },
  bakedFieldSize: { value: new THREE.Vector3(2, 2, 2) },
  bakedFieldEnabled: { value: 0 },
};

const declarations = /* glsl */`
varying vec3 vBakedWorldPosition;
uniform highp sampler3D bakedFieldTexture;
uniform vec3 bakedFieldMin, bakedFieldMax, bakedFieldSize;
uniform float bakedFieldEnabled;
vec3 bakedCoefficient(vec3 p, float k) {
  vec3 uv = (p + 0.5) / bakedFieldSize;
  uv.z = (uv.z + k) / 9.0;
  return texture(bakedFieldTexture, uv).rgb;
}
vec3 bakedIrradiance(vec3 worldNormal) {
  vec3 uv = (vBakedWorldPosition - bakedFieldMin) / (bakedFieldMax - bakedFieldMin);
  // Fade over one grid cell outside the volume instead of stretching the edge forever.
  vec3 outside = max(-uv, uv-1.0) * (bakedFieldSize-1.0);
  float fade = 1.0 - clamp(max(max(outside.x,outside.y),outside.z),0.0,1.0);
  vec3 p = clamp(uv,0.0,1.0) * (bakedFieldSize-1.0);
  float x=worldNormal.x, y=worldNormal.y, z=worldNormal.z;
  vec3 light = bakedCoefficient(p,0.0)*0.282095
    + bakedCoefficient(p,1.0)*(0.488603*y)
    + bakedCoefficient(p,2.0)*(0.488603*z)
    + bakedCoefficient(p,3.0)*(0.488603*x)
    + bakedCoefficient(p,4.0)*(1.092548*x*y)
    + bakedCoefficient(p,5.0)*(1.092548*y*z)
    + bakedCoefficient(p,6.0)*(0.315392*(3.0*z*z-1.0))
    + bakedCoefficient(p,7.0)*(1.092548*x*z)
    + bakedCoefficient(p,8.0)*(0.546274*(x*x-y*y));
  return max(light,vec3(0.0)) * (PI * fade);
}`;

const patched = new WeakMap<THREE.Material, THREE.Material["onBeforeCompile"]>();
function wearField(mat: THREE.Material): void {
  if (mat.userData.gameBakedLightingReceiver === false) return;
  if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial || (mat as THREE.MeshStandardMaterial).lightMap) return;
  if (patched.get(mat) === mat.onBeforeCompile) return;
  const previous = mat.onBeforeCompile;
  const key = mat.customProgramCacheKey();
  mat.onBeforeCompile = function(shader, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    if (shader.fragmentShader.includes("uniform highp sampler3D bakedFieldTexture;")) return;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vBakedWorldPosition;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec4 bakedPosition = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          bakedPosition = batchingMatrix * bakedPosition;
        #endif
        #ifdef USE_INSTANCING
          bakedPosition = instanceMatrix * bakedPosition;
        #endif
        vBakedWorldPosition = (modelMatrix * bakedPosition).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${declarations}`)
      .replace("#include <lights_fragment_end>", `
        if (bakedFieldEnabled > 0.5) {
          // Use the IBL path so metals receive the field too. SH stores
          // cosine-convolved radiance: this is a broad specular approximation,
          // while the reflection cube still supplies sharp local reflections.
          iblIrradiance += bakedIrradiance(transformDirectionByInverseViewMatrix(geometryNormal, viewMatrix));
          vec3 bakedReflect = reflect(-geometryViewDir, geometryNormal);
          bakedReflect = normalize(mix(bakedReflect, geometryNormal, pow4(material.roughness)));
          radiance += bakedIrradiance(transformDirectionByInverseViewMatrix(bakedReflect, viewMatrix)) * RECIPROCAL_PI;
        }
        #include <lights_fragment_end>`);
  };
  patched.set(mat, mat.onBeforeCompile);
  mat.customProgramCacheKey = () => `${key}|baked-field-2`;
  mat.needsUpdate = true;
}

/** Call before any view (including reflections) of the currently drawn level. */
export function useBakedLighting(root: THREE.Object3D, field: BakedField | null,
  player?: { position: THREE.Vector3; radius: number }): void {
  updateBakedContactShadow(field?.data ?? null, player?.position, player?.radius);
  uniforms.bakedFieldEnabled.value = field ? 1 : 0;
  if (!field) return;
  uniforms.bakedFieldTexture.value = field.texture;
  uniforms.bakedFieldMin.value.fromArray(field.data.min);
  uniforms.bakedFieldMax.value.fromArray(field.data.max);
  uniforms.bakedFieldSize.value.fromArray(field.data.size);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) wearField(mat);
  });
}
