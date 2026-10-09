// The level's Blender scene, loaded and mounted (see docs/blender-scenes.md and
// `scenes.ts` for what a scene is).
//
// One file, two kinds of node. A node named like a body is BOUND: lifted out of
// the file and hung under that body's visual root, so it rides the body - a
// rigid crate, a mover, a pivot. Every other node is SCENERY and stays in the
// file's own root, standing in
// the world where Blender placed it. Blender is the author of WHERE everything
// is, in both cases: a bound node is mounted at Blender's pose minus the body's
// rest pose, so at rest it is drawn exactly where Blender put it, and the body
// carries it from there.
//
// The placement (`dressScene`) is a pure function of a loaded object and the
// bodies, so `cli render3d` holds it without a file, a fetch or a GPU.

import * as THREE from "three";
import type { Vec2 } from "../engine/vec2";
import { gltfLoader, trackPending } from "./assets";
import { withDownload } from "./download";
import { wearIvyLeaves } from "./ivyLeaves";
import { isPrintedMoss, wearMossMound } from "./mossMound";
import { threeRotation, threeY } from "./space";
import { nodeNameOf, SCENE_ASSETS, sceneFile } from "./scenes";

// A body a scene node may be bound to: its name, the group its visual rides,
// and the pose that group has at rest (the engine origin and rotation for a
// built body, the authored ones for a body that built nothing - see
// `BuiltBody.origin`). `tag` is what a raycast onto the node answers with
// (see `pickTagOf`), so the editor's pick lands on the body it dresses.
// `solid` is whether the body collides, which decides its shadow (below), and
// `adopt` is handed the node once it is on the body (`BodyVisual.adoptDressing`).
export interface DressTarget {
  name: string | undefined;
  root: THREE.Object3D;
  origin: Vec2;
  rotation: number;
  solid: boolean;
  tag?: unknown;
  adopt?: (node: THREE.Object3D) => void;
}

export interface Dressed {
  // The bound nodes by node name, each now a child of its body's root.
  bound: Map<string, THREE.Object3D>;
  // The rest of the file, to add to the scene at the identity.
  scenery: THREE.Group;
  // Body names (as node names) that matched no node in the file.
  unbound: string[];
}

// What a raycast onto SCENERY answers with (see `pickTagOf`): it is in no body,
// so there is nothing an editor can select by it, but it is a surface a light
// can be dropped on (`Scene3D.pickSurface`), which a hit with no tag at all -
// the ball, a chain - is not.
export const SCENERY_TAG: unique symbol = Symbol("scenery");

// Toward the camera is +z; a node whose nearest point is behind this casts no
// shadow (see `castsShadow`). A hair behind the plane rather than exactly on
// it, so a backdrop ledge modelled flush with the plane still casts.
const SHADOW_Z = -0.05;

// Place a loaded scene against the bodies. `loaded` is cloned, never touched:
// the file is cached for the page and mounted again on every rebuild (the
// editor rebuilds on every edit), and geometry and materials are shared
// between the clones as a pack's props share theirs.
export function dressScene(loaded: THREE.Object3D, targets: readonly DressTarget[]): Dressed {
  const scenery = new THREE.Group();
  scenery.name = "scenery";
  scenery.userData["pickTag"] = SCENERY_TAG;
  const clone = loaded.clone(true);
  clone.updateMatrixWorld(true);

  const byNode = new Map<string, DressTarget>();
  for (const t of targets) {
    if (!t.name) continue;
    const node = nodeNameOf(t.name);
    // Two bodies of one name: the first keeps it, as `cli levels` says it must.
    if (!byNode.has(node)) byNode.set(node, t);
  }

  // Outermost matches only: a node inside a bound node rides the bound node,
  // as it did in Blender. `traverse` is parent-first, so a descendant is seen
  // after its ancestor, and one whose ancestor was taken is skipped.
  const bound = new Map<string, THREE.Object3D>();
  const taken: THREE.Object3D[] = [];
  clone.traverse((o) => {
    if (o === clone || !byNode.has(o.name) || bound.has(o.name)) return;
    for (let p = o.parent; p; p = p.parent) if (taken.includes(p)) return;
    taken.push(o);
    bound.set(o.name, o);
  });

  const rest = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  for (const node of taken) {
    const t = byNode.get(node.name)!;
    // The body's root at rest, as `placeAt`/`orientTo` pose it.
    rest.makeRotationZ(threeRotation(t.rotation));
    rest.setPosition(t.origin.x, threeY(t.origin.y), 0);
    // world = rest * local, so local = rest^-1 * world.
    local.copy(rest).invert().multiply(node.matrixWorld);
    node.removeFromParent();
    local.decompose(node.position, node.quaternion, node.scale);
    if (t.tag !== undefined) node.userData["pickTag"] = t.tag;
    t.root.add(node);
    // WHAT COLLIDES, CASTS, wherever its dressing has been set back to: a
    // hanging cage modelled 20 cm behind the plane so the ball reads in front
    // of it is still the thing the ball is standing in, and without its shadow
    // it reads as a sticker. A body that collides with nothing is decoration
    // and keeps the scenery's rule below.
    if (!t.solid) noShadowBehindPlane(node);
    t.adopt?.(node);
  }

  // What is left is scenery. Reparented under a group of our own rather than
  // handing back the clone's root, so a file whose root carries a transform
  // (an exporter that wraps the scene) still stands at its world poses.
  for (const child of [...clone.children]) {
    child.removeFromParent();
    child.updateMatrixWorld(true);
    scenery.add(child);
    noShadowBehindPlane(child);
  }
  clone.updateMatrixWorld(true);

  return {
    bound,
    scenery,
    unbound: [...byNode.keys()].filter((n) => !bound.has(n)),
  };
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

// The scene's own flat water: the plane the backdrop tool lays at the pool's
// height, 2 cm under it, across the backdrop (tools/blender/backdrop.py,
// `pool`). The game draws it as the pool it continues (see
// `Scene3D.adoptSceneryWater`).
const SCENERY_WATER = "backdrop pool";

export function sceneryWater(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && blenderNames(o).includes(SCENERY_WATER)) out.push(o as THREE.Mesh);
  });
  return out;
}

const box = new THREE.Box3();
export function castsShadow(node: THREE.Object3D): boolean {
  box.setFromObject(node, true);
  return !box.isEmpty() && box.max.z >= SHADOW_Z;
}

// The rule scenery and decoration keep: behind the gameplay plane a node is a
// painted distance and casts nothing - one throwing a shadow across the level in
// front of it reads as geometry the player ought to be able to touch - and on
// or in front of it, it is in the scene and casts like anything else.
function noShadowBehindPlane(node: THREE.Object3D): void {
  if (castsShadow(node)) return;
  node.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false;
  });
}

// One decoded file per scene, shared by every mount of it on the page. A
// failure stays cached too: a scene that is not there is asked for once, not
// on every rebuild.
const files = new Map<string, Promise<THREE.Object3D | null>>();

export function loadSceneFile(scene: string): Promise<THREE.Object3D | null> {
  const file = sceneFile(scene);
  const cached = files.get(file);
  if (cached) return cached;
  // Weighted by the published pin when there is one; an export not yet
  // published is fetched unweighted, which only means the bar does not count
  // it (the preload list says the same, see `levelStoredFiles`).
  const bytes = SCENE_ASSETS[scene]?.bytes ?? 0;
  const loading = gltfLoader();
  const p = trackPending(
    withDownload(file, bytes, (href) => loading.then((loader) => loader.loadAsync(href)))
      .then((gltf) => {
        let ivyMeshes = 0;
        let foliageMeshes = 0;
        let mossMeshes = 0;
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
          // Until 2026-10-02 the ivy add-on was "moss", and a scene exported
          // before then named its ivy `.moss` and `.moss.shadow`; that name
          // now belongs to the painterly moss mound, and every published scene
          // has been exported since (checked 2026-10-10: river's `.moss`
          // nodes wear their own `<rock>.moss` print materials, grotto and
          // rails have none), so a `.moss` mesh is a mound. A mound with a
          // printed edge is alpha-cut and wears mossMound.ts (the
          // anti-aliased cut and the lip's shading); one with a mesh edge is
          // opaque and needs nothing.
          const names = blenderNames(mesh);
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const decal = names.some((n) => /\.(ivy|moss)\.shadow$/.test(n));
          const ivy = !decal && names.some((n) => /\.ivy$/.test(n));
          if (isPrintedMoss(names, mats)) {
            for (const m of mats) if (m.alphaTest > 0) wearMossMound(m);
            mossMeshes++;
          }
          // Plants (the Blender foliage add-on's ferns, sprig bushes and
          // hanging vines) are leaves too, and wear one material, `Foliage`,
          // found by its name, which glTF and the optimiser keep: whatever
          // the plant's object is called, its cards are alpha-cut leaves.
          const foliage = mats.some((m) => /^Foliage(\.\d+)?$/.test(m.name));
          mesh.castShadow = !decal;
          mesh.receiveShadow = true;
          // ...and the leaves receive with finer biases than the sun's, so a
          // leaf shadows the leaf below it; two-sided and translucent (ivyLeaves.ts).
          if (ivy || foliage) {
            for (const m of mats) wearIvyLeaves(m);
            if (ivy) ivyMeshes++;
            else foliageMeshes++;
          }
        });
        if (ivyMeshes > 0) console.log(`[render3d] scene "${scene}": ${ivyMeshes} ivy meshes cast and receive leaf shadows`);
        if (foliageMeshes > 0) console.log(`[render3d] scene "${scene}": ${foliageMeshes} plant meshes cast and receive leaf shadows`);
        if (mossMeshes > 0) console.log(`[render3d] scene "${scene}": ${mossMeshes} moss mounds cut and lipped by their print`);
        return gltf.scene as THREE.Object3D;
      })
      .catch((err: unknown) => {
        console.warn(`[render3d] scene "${scene}" failed to load from ${file}:`, err);
        return null;
      }),
    `scene "${scene}"`,
  );
  files.set(file, p);
  return p;
}

// A mounted scene: asks for the file, places it when it lands, and takes it
// all down again on `dispose`. The bound nodes live under the bodies' roots,
// which their `BodyVisual`s clear; `root` is the scenery.
export class SceneDressing {
  readonly root = new THREE.Group();
  private disposed = false;
  // What was bound, for a probe or a panel; empty until the file lands.
  bound: Map<string, THREE.Object3D> = new Map();
  unbound: string[] = [];

  // `landed` is handed the scenery once it is mounted, for what the scene
  // itself still draws over it (the pool's water, `Scene3D.adoptSceneryWater`).
  constructor(scene: string, targets: readonly DressTarget[], landed?: (scenery: THREE.Group) => void) {
    this.root.name = `scene:${scene}`;
    void loadSceneFile(scene).then((loaded) => {
      if (!loaded || this.disposed) return;
      const dressed = dressScene(loaded, targets);
      this.bound = dressed.bound;
      this.unbound = dressed.unbound;
      this.root.add(dressed.scenery);
      landed?.(dressed.scenery);
      // Where each bound node landed, in the world, so a headless grab's log
      // says whether the dressing is on its body (see docs/blender-scenes.md).
      const placed = [...dressed.bound].map(([name, node]) => {
        node.updateWorldMatrix(true, false);
        const p = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
        return `${name} @ ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
      });
      console.log(
        `[render3d] scene "${scene}": ${dressed.bound.size} on bodies (${placed.join("; ") || "-"}), ${dressed.scenery.children.length} scenery`,
      );
      if (dressed.unbound.length) {
        console.warn(`[render3d] scene "${scene}": no object named ${dressed.unbound.join(", ")}`);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    // Geometry and materials are the cached file's, shared with every other
    // mount, so nothing is freed here - as a pack's props are not.
    this.root.clear();
    this.bound.clear();
  }
}
