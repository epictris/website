// Drawing a body's formation (docs/formations.md): which of its files the
// game loads, and loading it.
//
// A formation that has been baked draws the tier its `lod` asks for (or the
// automatic one): a self-contained export of the scene exporter, loaded as a
// model is (`loadExportFile`), so every per-material rule a scene's rocks get
// applies. One not baked yet draws its `geometry.glb` in the iteration look
// (`formationSlate.ts`), which is what the editor shows the moment a Generate
// lands.
//
// Files are named by the recipe's hash and never change under it, so one
// decoded file serves every mount of it on the page (an editor rebuild, ▶ Test,
// a second body built from the same recipe).

import * as THREE from "three";
import type { DecorationAnchor, DecorationObjectData, FormationData } from "../level/levelFormat";
import { formationServedFile } from "../formation/bundle";
import { isPainted } from "../formation/decoration";
import { gltfLoader, trackPending } from "./assets";
import { prepareSlateGeometry } from "./formationSlate";
import { loadExportFile, decodedFile } from "./sceneDressing";

export { autoTier, chosenTierOf as chosenTier } from "../formation/tiers";

// A frame at an anchor: its point, its normal as z, x level where it can be.
// Any consistent choice serves: only the change from one anchor's frame to
// another's is ever drawn.
export function anchorFrame(a: DecorationAnchor): THREE.Matrix4 {
  const z = new THREE.Vector3(...a.n).normalize();
  const ref = Math.abs(z.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const x = new THREE.Vector3().crossVectors(ref, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(...a.p);
}

// A placed decoration's frame in its formation's: its anchor's, turned and
// sized by its own `turn` and `scale`.
export function placedFrame(d: Pick<DecorationObjectData, "anchor" | "onRock" | "turn" | "scale">): THREE.Matrix4 {
  const own = new THREE.Matrix4().compose(
    new THREE.Vector3(),
    d.turn ? new THREE.Quaternion(...d.turn).normalize() : new THREE.Quaternion(),
    d.scale ? new THREE.Vector3(...d.scale) : new THREE.Vector3(1, 1, 1),
  );
  return anchorFrame(d.onRock ?? d.anchor).multiply(own);
}

// Where a decoration's grown mesh is drawn, in its formation's frame: a placed
// one carried from where it was grown (unturned, full size) to where it
// stands now, turned and sized; a painted one, grown on the rock where it is,
// left alone.
export function decorationDelta(d: DecorationObjectData): THREE.Matrix4 {
  if (!d.built || isPainted(d.kind)) return new THREE.Matrix4();
  return placedFrame(d).multiply(anchorFrame(d.built.at).invert());
}

export interface FormationFile {
  file: string;
  bytes: number;
  baked: boolean;
}

export function formationFile(f: FormationData): FormationFile | null {
  const served = formationServedFile(f);
  if (!served) return null;
  return { file: served.path, bytes: served.bytes, baked: !served.path.endsWith("/geometry.glb") };
}

const geometry = new Map<string, Promise<THREE.Object3D | null>>();
const decodedGeometry = new Map<string, THREE.Object3D | null>();

// The iteration look's file: every mesh folded into the rock's frame and
// dressed in the slate.
function loadGeometryFile(file: string): Promise<THREE.Object3D | null> {
  const cached = geometry.get(file);
  if (cached) return cached;
  const p = trackPending(
    gltfLoader()
      .then((loader) => loader.loadAsync(file))
      .then((gltf) => {
        const root = new THREE.Group();
        root.name = "formation-geometry";
        gltf.scene.updateMatrixWorld(true);
        const meshes: THREE.Mesh[] = [];
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
        });
        for (const mesh of meshes) {
          const toRock = mesh.matrixWorld.clone();
          if (!prepareSlateGeometry(mesh, toRock)) mesh.geometry.applyMatrix4(toRock);
          mesh.position.set(0, 0, 0);
          mesh.quaternion.identity();
          mesh.scale.set(1, 1, 1);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          root.add(mesh);
        }
        return root as THREE.Object3D;
      })
      .catch((err: unknown) => {
        console.warn(`[render3d] formation geometry failed to load from ${file}:`, err);
        return null;
      })
      .then((loaded) => {
        decodedGeometry.set(file, loaded);
        return loaded;
      }),
    `formation ${file}`,
  );
  geometry.set(file, p);
  return p;
}

export function loadFormationFile(f: FormationFile): Promise<THREE.Object3D | null> {
  return f.baked ? loadExportFile(f.file, f.bytes, `formation ${f.file}`) : loadGeometryFile(f.file);
}

// The decoded file if it has landed (undefined while not), as `decodedFile`.
export function decodedFormationFile(f: FormationFile): THREE.Object3D | null | undefined {
  return f.baked ? decodedFile(f.file) : decodedGeometry.get(f.file);
}
