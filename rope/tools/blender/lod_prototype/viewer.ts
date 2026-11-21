// Dev-only comparison. Uses the game's real Scene3D, lighting, camera and DOF.
// No animation loop: a view draws only when selected or requested by the grabber.
import * as THREE from 'three';
import { Scene3D } from '../../../src/render3d/scene';
import { assetsSettled } from '../../../src/render3d/assets';
import { BallLevel } from '../../../src/level/ballLevel';
import { Vec2 } from '../../../src/engine/vec2';
import { fitCanvas, VIEW_WIDTH, VIEW_HEIGHT } from '../../../src/render/viewport';
import type { Camera } from '../../../src/render/camera';

const q = new URLSearchParams(location.search);
const assetBase = q.get('assets') ?? '/generated/lod-prototype';
const roof = q.has('roof');
if (q.has('capture')) document.body.classList.add('capture');
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
fitCanvas(canvas, 1, VIEW_WIDTH);
const status = document.querySelector<HTMLDivElement>('#status')!;
const scene = new Scene3D(canvas, { diagnostics: true });
scene.resize();
const data = await (await fetch(`${assetBase}/level.json`)).json();
const level = new BallLevel(data);
const camera: Camera = { position: new Vec2(roof ? 10.85 : 61.7, roof ? 3.5 : 0), zoom: 2 / .65, viewportWidth: VIEW_WIDTH, viewportHeight: VIEW_HEIGHT };
scene.setLevel(level);
await assetsSettled();
scene.setDepthOfField('high');
scene.pinClock(0);
// Use the source game's lighting, including its baked emission field. Do not
// replace it with studio lighting or prewarm/upload all off-screen textures.
const render = () => scene.render(level, camera, 1);
render();
const meshes: THREE.Mesh[] = [];
scene.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
const targetName = roof ? 'Cube006' : 'Cube005';
const target = meshes.find(o => o.name === targetName);
if (!target) throw new Error(`${targetName} is missing from the snapshotted river scene`);
const bounds = new THREE.Box3().setFromObject(target);
console.log('LOD_PREVIEW_SOURCE', JSON.stringify({name: target.name, bounds, triangles: target.geometry.index!.count/3,
  attributes: Object.keys(target.geometry.attributes), camera: {at: camera.position, zoom: camera.zoom},
  maps: Object.fromEntries(['map','normalMap','lightMap'].map(k => {
    const t = (target.material as any)[k]; return [k,t ? [t.image.width,t.image.height] : null];
  }))}));

const views: Record<string, [number, number, number]> = {
  opening: [61.7, 0, 2/.65], wall: [64, 0, 2/.65], left: [63, -1.5, 2/.65], right: [65.5, 0, 2/.65],
};
if (roof) Object.assign(views, {opening:[10.85,3.5,2/.65],wall:[15,3.5,2/.65],left:[4,6,2/.65],right:[19,3.5,2/.65]});
let variant = 'original';
let selectedView = q.get('view') ?? 'opening';
const generated: THREE.Mesh[] = [];
const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
let report: unknown = null;

function draw(mode = variant, view = selectedView) {
  if (mode !== 'original' && !generated.length) throw new Error('Adaptive geometry has not been prepared');
  variant = mode; selectedView = view;
  const pose = views[view];
  if (!pose) throw new Error(`Unknown view ${view}`);
  camera.position = new Vec2(pose[0], pose[1]); camera.zoom = pose[2];
  target!.visible = mode === 'original';
  for (const mesh of generated) {
    mesh.visible = mode !== 'original';
    mesh.receiveShadow = mode !== 'noShadow' && target!.receiveShadow;
    mesh.material = mode === 'bands' ? mesh.userData.diagnostic : mode === 'geometry' ? mesh.userData.geometryOnly : mesh.userData[mode] ?? originalMaterials.get(mesh)!;
  }
  // Settle view-dependent shadows and the pool mirror before capturing the
  // probe (its capture deliberately reuses the existing shadow maps).
  render();
  // The runtime refreshes one probe face per frame. A frozen comparison must
  // refresh all six after swapping geometry, or the ball retains reflections
  // from a prior variant and a repeated reference no longer matches itself.
  scene.setReflectionProbe(false);
  scene.setReflectionProbe(true);
  render();
  // Capture synchronously, before the non-preserved drawing buffer is cleared.
  const png = canvas.toDataURL('image/png');
  for (const id of ['original','adaptive','geometry','bands']) document.getElementById(id)!.setAttribute('aria-pressed', String(mode === id));
  status.textContent = `${mode === 'original' ? 'Original exported rock' : mode === 'bands' ? 'Depth chunks (diagnostic colours)' : mode === 'geometry' ? 'Adaptive geometry, reference textures' : 'Adaptive geometry + surface bake (fixed physical material scale)'} · ${view} · fixed time and High DOF`;
  return png;
}

// The final chunks are prepared offline; this page only mounts them and switches
// the comparison. Texture resampling here previews the proposed bake density.
async function loadAdaptive() {
  const response = await fetch(`${assetBase}/chunks.json`);
  if (!response.ok) return false;
  const prepared = await response.json();
  const source = target!.material as THREE.MeshStandardMaterial;
  const loader = new THREE.TextureLoader();
  const textureCache = new Map<string, THREE.Texture>();
  const smaller = (texture: THREE.Texture | null, factor: number): THREE.Texture | null => {
    if (!texture || factor <= 1) return texture;
    const key = `${texture.uuid}/${factor}`;
    if (textureCache.has(key)) return textureCache.get(key)!;
    const image = texture.image as HTMLImageElement;
    if (!image.width || !image.height) throw new Error('Unsupported texture source');
    const surface = document.createElement('canvas');
    surface.width = Math.max(1, Math.ceil(image.width/factor));
    surface.height = Math.max(1, Math.ceil(image.height/factor));
    const ctx = surface.getContext('2d')!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image,0,0,surface.width,surface.height);
    const result = texture.clone();
    result.source = new THREE.Source(surface); result.needsUpdate = true;
    textureCache.set(key,result); return result;
  };
  const palette = [0x55bcea,0x5ad69b,0xe4cc5e,0xf3945d,0xba91ed,0xe481ae,0x80b4be];
  for (const [i, part] of prepared.chunks.entries()) {
    const geometry = new THREE.BufferGeometry();
    const binary = await (await fetch(`${assetBase}/${part.file}`)).arrayBuffer();
    for (const [name, attribute] of Object.entries(part.attributes) as [string, any][]) {
      geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(binary,attribute.offset,attribute.count), attribute.size));
    }
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(binary,part.indices.offset,part.indices.count),1));
    geometry.computeBoundingSphere();
    const material = source.clone();
    material.onBeforeCompile = source.onBeforeCompile;
    material.customProgramCacheKey = source.customProgramCacheKey;
    const geometryOnly = source.clone();
    geometryOnly.onBeforeCompile = source.onBeforeCompile;
    geometryOnly.customProgramCacheKey = source.customProgramCacheKey;
    if (part.bakedColor && part.bakedNormal) {
      material.map = await loader.loadAsync(`${assetBase}/${part.bakedColor}`);
      material.map.colorSpace = THREE.SRGBColorSpace;
      material.map.flipY = false; material.map.channel = 2;
      material.normalMap = await loader.loadAsync(`${assetBase}/${part.bakedNormal}`);
      material.normalMap.colorSpace = THREE.NoColorSpace;
      material.normalMap.flipY = false; material.normalMap.channel = 2;
    } else {
      material.map = smaller(source.map, part.textureFactor);
      material.normalMap = smaller(source.normalMap, part.textureFactor);
    }
    // Keep baked illumination identical so the A/B measures surface detail.
    const mesh = new THREE.Mesh(geometry,material);
    mesh.name = `${targetName} depth ${i}`; mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(target!.matrix); mesh.castShadow = target!.castShadow; mesh.receiveShadow = target!.receiveShadow;
    mesh.userData = {...target!.userData, geometryOnly, diagnostic:new THREE.MeshBasicMaterial({color:palette[i%palette.length], side:THREE.DoubleSide})};
    if (q.has('diagnose')) {
      // Isolate construction from both surface maps and projected lighting.
      mesh.userData.plain = new THREE.MeshStandardMaterial({color:0x606b7a, roughness:1});
      mesh.userData.noShadow = mesh.userData.plain;
      mesh.userData.normals = new THREE.MeshNormalMaterial();
      for (const mode of ['colourOnly','normalOnly','noNormal']) {
        const diagnostic = material.clone();
        diagnostic.onBeforeCompile = material.onBeforeCompile;
        diagnostic.customProgramCacheKey = material.customProgramCacheKey;
        if (mode === 'colourOnly') diagnostic.normalMap = source.normalMap;
        if (mode === 'normalOnly') diagnostic.map = source.map;
        if (mode === 'noNormal') diagnostic.normalMap = null;
        mesh.userData[mode] = diagnostic;
      }
    }
    mesh.visible = false;
    target!.parent!.add(mesh); generated.push(mesh); originalMaterials.set(mesh,material);
  }
  report = prepared.report;
  if (prepared.report.views) {
    Object.assign(views, prepared.report.views);
    const selector = document.querySelector<HTMLSelectElement>('#view')!;
    for (const name of Object.keys(prepared.report.views)) {
      if (![...selector.options].some(option => option.value === name)) {
        selector.add(new Option(name === 'reported' ? 'Reported wall area' : name, name));
      }
    }
  }
  for (const id of ['adaptive','geometry','bands']) (document.getElementById(id) as HTMLButtonElement).disabled = false;
  console.log('LOD_PREVIEW_ADAPTIVE', JSON.stringify(report));
  return true;
}

const ready = q.has('baseline') ? false : await loadAdaptive();
for (const mode of ['original','adaptive','geometry','bands']) document.getElementById(mode)!.onclick = () => draw(mode);
document.querySelector<HTMLSelectElement>('#view')!.onchange = e => draw(variant,(e.target as HTMLSelectElement).value);
const pick = (x: number, y: number) => {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x / canvas.width * 2 - 1, 1 - y / canvas.height * 2), scene.camera);
  return ray.intersectObjects(scene.scene.children, true).filter(hit => {
    for (let ob: THREE.Object3D | null = hit.object; ob; ob = ob.parent) if (!ob.visible) return false;
    return true;
  }).slice(0, 6).map(hit => ({name:hit.object.name, distance:hit.distance, point:hit.point.toArray(),
    face:hit.faceIndex, localNormal:hit.face?.normal.toArray()}));
};
(window as any).lodPreview = {draw,scene,target,views,pick,get report(){return report;}, ready, meshes: meshes.map(m=>m.name)};
draw(q.get('variant') ?? 'original',selectedView);
(window as any).shotReady = true;
