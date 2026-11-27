// The files `tools/blender/scene_export.py` writes, loaded and prepared for
// the game: a model of the library (models.ts), a formation's baked tier
// (formations.ts) and a decoration grown on one. Every one of them comes out
// of the same exporter, so each may hold the same ivy, moss, plants and
// pictures, and each needs the same preparation (`loadExportFile`).
//
// A file is decoded once per page and MOUNTED as often as it is drawn: a mount
// is a clone sharing the file's geometry and materials (`mountExport`), which
// the body that carries it hangs under its own root (bodyVisuals.ts). Collision
// is never derived from any of this - an export is appearance and nothing else.

import * as THREE from "three";
import { restoreLightmap } from "./bakedLighting";
import { gltfLoader, trackPending } from "./assets";
import { withDownload } from "./download";
import { wearIvyLeaves } from "./ivyLeaves";
import { isGlowFlora, reattachGlowFloraDepth, wearGlowFlora } from "./glowFlora";
import { isPicture, joinDepthPrepass, joinPictureDepth } from "./depthPrepass";
import { drawMossInOnePass, isPrintedMoss, wearMossMound } from "./mossMound";
import { wearBackgroundLift } from "./backgroundLift";
import { MODEL_ASSETS, modelFile } from "./models";

// Someone else's work shipped inside an export: a texture Blender packed into
// it. `name` is the image (or set) as the credits list it. Resolved by the
// exporter from `tools/blender/image_credits.json` and pinned on publish, so
// CREDITS.md (scripts/credits.ts) lists what a published export carries.
export interface ExportCredit {
  name: string;
  author: string;
  source: string;
  license: string;
}

// One exported object, as an export's `meta.json` records it. `node` is the
// name three will give it (GLTFLoader passes every node name through
// `PropertyBinding.sanitizeNodeName`); `position` and `bounds` are in the
// game's frame (three's: x right, y up, z toward the camera), metres.
export interface ExportNodeMeta {
  name: string;
  node: string;
  triangles: number;
  position: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  materials: string[];
}

// Toward the camera is +z; a node whose nearest point is behind this casts no
// shadow (see `castsShadow`). A hair behind the plane rather than exactly on
// it, so a backdrop ledge modelled flush with the plane still casts.
const SHADOW_Z = -0.05;

// A copy of a loaded export to mount: geometry and materials shared, and what
// three's clone drops put back (a glow plant's swaying shadow, glowFlora.ts).
export function mountExport(loaded: THREE.Object3D): THREE.Object3D {
  const clone = loaded.clone(true);
  reattachGlowFloraDepth(clone);
  return clone;
}

// The Blender names of a loaded object and its ancestors, nearest first:
// GLTFLoader keeps a node's original name in `userData.name` (its `name` has
// the dots stripped), and an unnamed node made by the optimiser is known only
// by the named node above it.
function blenderNames(o: THREE.Object3D): string[] {
  const out: string[] = [];
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    const n = typeof p.userData.name === "string" ? p.userData.name : p.name;
    if (n) out.push(n);
  }
  return out;
}

const box = new THREE.Box3();
function castsShadow(node: THREE.Object3D): boolean {
  box.setFromObject(node, true);
  return !box.isEmpty() && box.max.z >= SHADOW_Z;
}

// The rule decoration keeps: behind the gameplay plane a node is a painted
// distance and casts nothing - one throwing a shadow across the level in front
// of it reads as geometry the player ought to be able to touch - and on or in
// front of it, it is in the scene and casts like anything else. What collides
// is exempt wherever its look has been set back to (see `mountModels`).
export function noShadowBehindPlane(node: THREE.Object3D): void {
  if (!castsShadow(node)) castNoShadow(node);
}

function castNoShadow(node: THREE.Object3D): void {
  node.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false;
  });
}

// One decoded file per export, shared by every mount of it on the page. A
// failure stays cached too: a file that is not there is asked for once, not on
// every rebuild.
const files = new Map<string, Promise<THREE.Object3D | null>>();

// A model of the library (render3d/models.ts). Weighted by the published pin
// when there is one; an export not yet published is fetched unweighted, which
// only means the bar does not count it (the preload list says the same, see
// `levelStoredFiles`).
export function loadModelFile(model: string): Promise<THREE.Object3D | null> {
  return loadExportFile(modelFile(model), MODEL_ASSETS[model]?.bytes ?? 0, `model "${model}"`);
}

// The decoded file, if it has landed: undefined while it has not (or was never
// asked for), null for one that failed. What lets a mount of a file already
// decoded be made on the spot rather than a task later: the editor rebuilds
// its scene inside a frame, and a mount a task later left that frame drawing
// the body without its look - a one-frame flash on every edit.
export function decodedFile(file: string): THREE.Object3D | null | undefined {
  return decoded.get(file);
}

// Hand the cache a decoded file as though it had landed: `cli render3d`, which
// has no fetch and no GLB, mounts a model it built itself through the same path
// a page takes.
export function seedDecodedFile(file: string, loaded: THREE.Object3D | null): void {
  decoded.set(file, loaded);
  files.set(file, Promise.resolve(loaded));
}

// Drop every cached file whose path `matches`, so the next load fetches it
// again: a formation rebuilt under the same hash (`forgetFormationFiles`).
export function forgetFiles(matches: (file: string) => boolean): void {
  for (const file of [...files.keys()]) if (matches(file)) files.delete(file);
  for (const file of [...decoded.keys()]) if (matches(file)) decoded.delete(file);
}

// Load one export of `scene_export.py` (a model, a formation's baked tier or a
// decoration) and prepare its meshes for the game. `label` names it in the log.
export function loadExportFile(file: string, bytes: number, label: string): Promise<THREE.Object3D | null> {
  const cached = files.get(file);
  if (cached) return cached;
  const loading = gltfLoader();
  const p = trackPending(
    withDownload(file, bytes, (href) => loading.then((loader) => loader.loadAsync(href)))
      .then((gltf) => {
        let ivyMeshes = 0;
        let foliageMeshes = 0;
        let mossMeshes = 0;
        let glowMeshes = 0;
        const blendedMoss = new Set<THREE.Material>();
        // Taken after the walk, so the walk never meets a stand-in it has
        // just added (and casts it a shadow).
        const prepass: THREE.Mesh[] = [];
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          // Ivy (the Blender ivy add-on's `<host>.ivy` objects) casts since
          // 2026-09-30: the ivy's leaves are alpha-cut cards, and the depth
          // pass cuts them by the same mask, so a leaf throws a leaf-shaped
          // shadow on the leaves and the stone below it, which is the look
          // asked for ("shadows between leaves"). Its shadow decal (the
          // `.ivy.shadow` child, a blended skin on the rock) casts nothing:
          // a translucent sheet 3 mm off a surface would shadow that surface
          // entirely. glTF has no flag for either, so the rule lives here.
          // Tested on the Blender names of the mesh AND its ancestors, as the
          // loader kept them. GLTFLoader strips the dots from a node's name
          // (`rock.ivy` arrives as `rockivy`) and keeps the original in
          // `userData.name`; and the optimiser's quantisation moves the mesh
          // of any node that has children onto a new, unnamed child of it (the
          // rock carries its ivy, the ivy its decal), so the mesh itself has
          // no Blender name at all - only its parent does. (A test on
          // `mesh.name` never matched, so until 2026-09-30 the ivy cast all along.)
          // Until 2026-10-02 the ivy add-on was "moss", and an export made
          // before then named its ivy `.moss` and `.moss.shadow`; that name
          // now belongs to the painterly moss mound, and nothing exported
          // before then is still drawn, so a `.moss` mesh is a mound. A mound
          // with a printed edge is alpha-cut and wears mossMound.ts (the
          // anti-aliased cut and the lip's shading); one with a mesh edge is
          // opaque and needs nothing.
          const names = blenderNames(mesh);
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) restoreLightmap(mat);
          const decal = names.some((n) => /\.(ivy|moss)\.shadow$/.test(n));
          const ivy = !decal && names.some((n) => /\.ivy$/.test(n));
          if (isPrintedMoss(names, mats)) {
            for (const m of mats) if (m.alphaTest > 0) wearMossMound(m);
            mossMeshes++;
          }
          // A blended moss sheet is drawn in one pass, not three's two.
          for (const m of mats) if (drawMossInOnePass(m)) blendedMoss.add(m);
          // Plants (the Blender foliage add-on's ferns, sprig bushes and
          // hanging vines) are leaves too, and wear one material, `Foliage`,
          // found by its name, which glTF and the optimiser keep: whatever
          // the plant's object is called, its cards are alpha-cut leaves.
          const foliage = mats.some((m) => /^Foliage(?:\.LOD[248])?(\.\d+)?$/.test(m.name));
          // Glow flora (the foliage add-on's glow patches) carry their
          // shader's inputs as vertex attributes, and wear the glow shader
          // in place of whatever material the optimiser left them; it sways,
          // so it keeps out of the depth prepass (its material is patched).
          if (isGlowFlora(mesh) && wearGlowFlora(mesh)) glowMeshes++;
          mesh.castShadow = !decal;
          mesh.receiveShadow = true;
          // ...and the leaves receive with finer biases than the sun's, so a
          // leaf shadows the leaf below it; two-sided and translucent (ivyLeaves.ts).
          if (ivy || foliage) {
            for (const m of mats) wearIvyLeaves(m);
            if (ivy) ivyMeshes++;
            else foliageMeshes++;
          }
          // What of it is opaque lays its depth first, and a picture lays
          // its own after it is drawn (depthPrepass.ts).
          prepass.push(mesh);
        });
        const pictures = prepass.filter(joinPictureDepth).length;
        const depthFirst = prepass.filter((m) => !isPicture(m) && joinDepthPrepass(m)).length;
        // This changes only colour, so keep the eligible meshes' existing
        // depth prepass before adding the fragment shader hook.
        for (const mesh of prepass) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) wearBackgroundLift(mat);
        }
        if (depthFirst > 0) console.log(`[render3d] ${label}: ${depthFirst} meshes lay their depth first`);
        if (pictures > 0) console.log(`[render3d] ${label}: ${pictures} pictures lay their depth after them`);
        if (ivyMeshes > 0) console.log(`[render3d] ${label}: ${ivyMeshes} ivy meshes cast and receive leaf shadows`);
        if (foliageMeshes > 0) console.log(`[render3d] ${label}: ${foliageMeshes} plant meshes cast and receive leaf shadows`);
        if (glowMeshes > 0) console.log(`[render3d] ${label}: ${glowMeshes} glow flora meshes glow and sway`);
        if (mossMeshes > 0) console.log(`[render3d] ${label}: ${mossMeshes} moss mounds cut and lipped by their print`);
        if (blendedMoss.size > 0) console.log(`[render3d] ${label}: ${blendedMoss.size} blended moss materials drawn in one pass`);
        return gltf.scene as THREE.Object3D;
      })
      .catch((err: unknown) => {
        console.warn(`[render3d] ${label} failed to load from ${file}:`, err);
        return null;
      })
      .then((loaded) => {
        decoded.set(file, loaded);
        return loaded;
      }),
    label,
  );
  files.set(file, p);
  return p;
}

// What each file's promise above settled to, once it has (see `decodedFile`).
const decoded = new Map<string, THREE.Object3D | null>();
