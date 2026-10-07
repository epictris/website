import * as THREE from "three";

const time = { value: 0 }, strength = { value: 1 };
let enabled = true, amount = 1;
export function setFoliageWind(on: boolean, value = amount): void {
  enabled = on; amount = value; strength.value = enabled ? amount : 0;
}
export function updateFoliageWind(clock: number): void { time.value = clock; }
export function foliageWindSettings(): { enabled: boolean; strength: number } { return { enabled, strength: amount }; }

function patch(material: THREE.Material, phase: number): void {
  const before = material.onBeforeCompile.bind(material), key = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.uniforms.foliageTime = time; shader.uniforms.foliageWind = strength; shader.uniforms.foliagePhase = { value: phase };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float sway;\nuniform float foliageTime;\nuniform float foliageWind;\nuniform float foliagePhase;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        float fw = sway * foliageWind, ft = foliageTime + foliagePhase;
        transformed.x += fw * (0.030 * sin(ft * 1.3 + sway * 1.7) + 0.010 * sin(ft * 3.1 + sway * 4.0));
        transformed.z += fw * 0.022 * sin(ft * 1.05 + sway * 2.3 + 1.3);
      `);
  };
  material.customProgramCacheKey = () => `${key()}|decorative-foliage-wind-v1`;
  material.needsUpdate = true;
}

/** Patch local material copies, including shadow passes; cached GLBs and textures stay shared. */
export function attachFoliageWind(root: THREE.Object3D, copyMaterials = true): void {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.foliageWind) return;
    const weight = object.geometry.getAttribute("sway") ?? object.geometry.getAttribute("_sway");
    if (!weight) return;
    object.geometry.setAttribute("sway", weight);
    object.userData.foliageWind = true;
    const phase = 1.7;
    const clone = (source: THREE.Material) => {
      const material = copyMaterials ? source.clone() : source; material.onBeforeCompile = source.onBeforeCompile;
      material.customProgramCacheKey = source.customProgramCacheKey; material.userData.foliageOwnedWind = true;
      if (material.userData.fernLeaf && !Object.prototype.hasOwnProperty.call(source, "onBeforeCompile")) {
        material.onBeforeCompile = shader => {
          shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_begin>",
            THREE.ShaderChunk.normal_fragment_begin.replace("float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;", "float faceDirection = 1.0;"))
            .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
            vec3 toEye = normalize(vViewPosition), toSun = directionalLights[0].direction;
            float through = 0.55 * pow(max(0.0, dot(-toEye, toSun)), 2.0) + 0.35 * max(0.0, -dot(normal, toSun));
            reflectedLight.directDiffuse += diffuseColor.rgb * vec3(1.0, 1.12, 0.55) * directionalLights[0].color * through * 0.45;
#endif`);
        };
        material.customProgramCacheKey = () => "fern-two-sided-glow";
      }
      patch(material, phase); return material;
    };
    object.material = Array.isArray(object.material) ? object.material.map(clone) : clone(object.material);
    const source = (Array.isArray(object.material) ? object.material[0] : object.material) as THREE.MeshStandardMaterial;
    const properties = { map: source.map, alphaTest: source.alphaTest, side: source.side };
    object.customDepthMaterial = new THREE.MeshDepthMaterial({ ...properties, depthPacking: THREE.RGBADepthPacking });
    object.customDistanceMaterial = new THREE.MeshDistanceMaterial(properties);
    patch(object.customDepthMaterial, phase); patch(object.customDistanceMaterial, phase);
    // Prevent animated tips disappearing when their still bounds are just outside the viewport.
    object.frustumCulled = false;
  });
}

export function disposeFoliageWind(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.userData.foliageWind) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      if (material.userData.foliageOwnedWind) materials.add(material);
    if (object.customDepthMaterial) materials.add(object.customDepthMaterial);
    if (object.customDistanceMaterial) materials.add(object.customDistanceMaterial);
  });
  for (const material of materials) material.dispose();
}
