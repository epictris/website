// caveFoliage.js — load, scatter and animate the Blender cave-foliage GLB in three.js
//
// Usage:
//   import { loadCaveFoliage, scatter, updateWind } from './caveFoliage.js';
//
//   const foliage = await loadCaveFoliage('/assets/cave_foliage_assets.glb');
//   scatter(scene, foliage.Fern_A, [
//     { position: new THREE.Vector3(2, 0, -1), rotY: 0.4, scale: 1.1 },
//     { position: new THREE.Vector3(-3, 0, 2) },
//   ]);
//   const vine = foliage.IvyVine_C.clone();    // pivot is the TOP of the vine
//   vine.position.set(0, 4, -2);               // hang it from a ceiling
//   scene.add(vine);
//
//   // in your render loop:
//   updateWind(clock.getElapsedTime());
//
// Asset names: Alocasia_A-C, BirdsNest_A-C, Fern_A-C, Mushrooms_A-C,
//              Creepers_A-C, Rock_A-C, IvyVine_A-D (short -> long)

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const wind = {
  uTime: { value: 0 },
  uWindStrength: { value: 0.06 },   // metres of sway at leaf tips
  uWindSpeed: { value: 1.0 },
};

// Vertex-shader wind driven by the baked _sway attribute (0 at base, 1 at tips).
export function addWind(material) {
  if (material.userData.hasWind) return material;
  material.userData.hasWind = true;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wind);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float _sway;
        uniform float uTime;
        uniform float uWindStrength;
        uniform float uWindSpeed;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 wPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        #else
          vec3 wPos = (modelMatrix * vec4(position, 1.0)).xyz;
        #endif
        float t = uTime * uWindSpeed;
        float ph = wPos.x * 0.7 + wPos.z * 0.5;
        float gust = 0.6 + 0.4 * sin(t * 0.37 + ph * 0.2);
        float s = _sway * uWindStrength * gust;
        transformed.x += sin(t * 1.3 + ph) * s;
        transformed.z += cos(t * 1.1 + ph * 1.3) * s * 0.6;
        transformed.y += sin(t * 2.3 + ph * 2.0 + position.y * 8.0) * s * 0.25;`);
  };
  material.customProgramCacheKey = () => 'caveFoliageWind';
  return material;
}

export function updateWind(elapsedSeconds) {
  wind.uTime.value = elapsedSeconds;
}

// Returns { [assetName]: THREE.Mesh } — use .clone() or scatter() to place them.
export async function loadCaveFoliage(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const assets = {};
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    if (o.geometry.attributes._sway) addWind(o.material);  // rocks have no _sway
    o.position.set(0, 0, 0);                               // drop the preview layout
    o.updateMatrix();
    assets[o.name] = o;
  });
  return assets;
}

// One draw call for any number of copies of the same asset.
// transforms: [{ position: Vector3, rotY?: number, scale?: number }]
export function scatter(scene, asset, transforms) {
  const mesh = new THREE.InstancedMesh(asset.geometry, asset.material, transforms.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const e = new THREE.Euler();
  transforms.forEach((t, i) => {
    e.set(0, t.rotY ?? Math.random() * Math.PI * 2, 0);
    q.setFromEuler(e);
    s.setScalar(t.scale ?? 1);
    m.compose(t.position, q, s);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  scene.add(mesh);
  return mesh;
}
