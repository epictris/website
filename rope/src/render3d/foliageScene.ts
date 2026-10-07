import * as THREE from "three";
import { gltfLoader, trackPending } from "./assets";
import { generatedVineAsset } from "./generatedVines";
import { attachFoliageWind, disposeFoliageWind } from "./foliage/wind";

/** Decorative plants use host-local matrices in metres, independent of level pixels. */
export interface ScenePlantData { id: number; host: string; mesh: string; transform: number[] }
export interface PlantSurface { id: number; key: string; root: THREE.Object3D; visual: { mesh: string; scale: number } }
const models = new Map<string, Promise<THREE.Object3D>>();
function identity(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % 1000000000;
}
export function plantMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  root.traverseVisible(node => {
    if (!(node instanceof THREE.Mesh)) return;
    for (let parent: THREE.Object3D | null = node; parent; parent = parent.parent) if (parent.userData.scenePlant) return;
    result.push(node);
  });
  return result;
}
export class SceneFoliage {
  surfaces: PlantSurface[] = [];
  plants = new Map<number, PlantSurface>();
  private epoch = 0;
  private pending: readonly ScenePlantData[] = [];
  setPlants(data: readonly ScenePlantData[]): void { this.pending = data; }
  bind(bound: ReadonlyMap<string, THREE.Object3D>, scenery: THREE.Object3D): void {
    const add = (key: string, root: THREE.Object3D) => {
      if (plantMeshes(root).length) this.surfaces.push({ id: identity(key), key, root, visual: { mesh: key, scale: 1 } });
    };
    for (const [name, root] of bound) if (!/water/i.test(name)) add(`body:${name}`, root);
    const visit = (node: THREE.Object3D, path: string) => {
      if (/water/i.test(node.name)) return;
      if (node instanceof THREE.Mesh) add(`scene:${path}`, node);
      else node.children.forEach((child, i) => visit(child, `${path}/${child.name || i}`));
    };
    scenery.children.forEach((node, i) => visit(node, node.name || String(i)));
    const epoch = this.epoch;
    for (const data of this.pending) {
      const host = this.surfaces.find(surface => surface.key === data.host);
      const asset = generatedVineAsset(data.mesh);
      if (!host || !asset || !Array.isArray(data.transform) || data.transform.length !== 16 || !data.transform.every(Number.isFinite)) {
        console.warn(`[foliage] Missing host or invalid plant ${data.id}: ${data.host}`); continue;
      }
      const holder = new THREE.Group(); holder.name = `plant:${data.id}`;
      holder.userData.scenePlant = true; holder.matrixAutoUpdate = false;
      holder.matrix.fromArray(data.transform); host.root.add(holder);
      this.plants.set(data.id, { id: data.id, key: data.host, root: holder, visual: { mesh: data.mesh, scale: 1 } });
      let loading = models.get(asset.file);
      if (!loading) {
        loading = trackPending(gltfLoader().then(loader => loader.loadAsync(asset.file)).then(gltf => gltf.scene), `plant ${data.id}`);
        models.set(asset.file, loading);
        loading.catch(() => models.delete(asset.file));
      }
      void loading.then(root => {
        if (epoch !== this.epoch) return;
        const plant = root.clone(true);
        plant.traverse(node => { if (node instanceof THREE.Mesh) { node.castShadow = true; node.receiveShadow = true; } });
        attachFoliageWind(plant); holder.add(plant);
      }).catch(error => console.error(`[foliage] Could not load plant ${data.id}`, error));
    }
  }
  meshes(item: PlantSurface): THREE.Mesh[] {
    const result: THREE.Mesh[] = [];
    item.root.traverseVisible(node => { if (node instanceof THREE.Mesh) result.push(node); });
    return result;
  }
  clear(): void {
    this.epoch++;
    for (const plant of this.plants.values()) { disposeFoliageWind(plant.root); plant.root.removeFromParent(); }
    this.plants.clear(); this.surfaces = []; this.pending = [];
  }
}
