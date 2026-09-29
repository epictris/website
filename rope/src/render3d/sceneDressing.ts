// The level's Blender scene, loaded and mounted (see docs/blender-scenes.md and
// `scenes.ts` for what a scene is).
//
// One file, two kinds of node. A node named like a body is BOUND: lifted out of
// the file and hung under that body's visual root, so it rides the body - a
// rigid crate, a mover, a pivot - exactly as the body's own geometry objects
// do. Every other node is SCENERY and stays in the file's own root, standing in
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
import { threeRotation, threeY } from "./space";
import { nodeNameOf, SCENE_ASSETS, sceneFile } from "./scenes";

// A body a scene node may be bound to: its name, the group its visual rides,
// and the pose that group has at rest (the engine origin and rotation for a
// built body, the authored ones for a body that built nothing - see
// `BuiltBody.origin`). `tag` is what a raycast onto the node answers with
// (see `pickTagOf`), so the editor's pick lands on the body it dresses.
export interface DressTarget {
  name: string | undefined;
  root: THREE.Object3D;
  origin: Vec2;
  rotation: number;
  tag?: unknown;
}

export interface Dressed {
  // The bound nodes by node name, each now a child of its body's root.
  bound: Map<string, THREE.Object3D>;
  // The rest of the file, to add to the scene at the identity.
  scenery: THREE.Group;
  // Body names (as node names) that matched no node in the file.
  unbound: string[];
}

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
  }

  // What is left is scenery. Reparented under a group of our own rather than
  // handing back the clone's root, so a file whose root carries a transform
  // (an exporter that wraps the scene) still stands at its world poses.
  for (const child of [...clone.children]) {
    child.removeFromParent();
    child.updateMatrixWorld(true);
    scenery.add(child);
    // Scenery keeps the rule decoration has (see `BodyVisual.buildAuthored`):
    // behind the gameplay plane it is a painted distance and casts nothing; on
    // or in front of it, it is in the scene and casts like anything else. A
    // bound node is the body and always casts.
    if (!castsShadow(child)) {
      child.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false;
      });
    }
  }
  clone.updateMatrixWorld(true);

  return {
    bound,
    scenery,
    unbound: [...byNode.keys()].filter((n) => !bound.has(n)),
  };
}

function underMoss(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (/\.moss$/.test(p.name)) return true;
  return false;
}

const box = new THREE.Box3();
export function castsShadow(node: THREE.Object3D): boolean {
  box.setFromObject(node, true);
  return !box.isEmpty() && box.max.z >= SHADOW_Z;
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
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          // Moss (the Blender add-on's `<host>.moss` objects) casts nothing:
          // its leaves are alpha-cut cards shaded by a borrowed normal, and a
          // shadow between them reads as a hole in the carpet. glTF has no
          // flag for it, so the rule lives here, by the node's name.
          mesh.castShadow = !underMoss(mesh);
          mesh.receiveShadow = true;
        });
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

  constructor(scene: string, targets: readonly DressTarget[]) {
    this.root.name = `scene:${scene}`;
    void loadSceneFile(scene).then((loaded) => {
      if (!loaded || this.disposed) return;
      const dressed = dressScene(loaded, targets);
      this.bound = dressed.bound;
      this.unbound = dressed.unbound;
      this.root.add(dressed.scenery);
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
