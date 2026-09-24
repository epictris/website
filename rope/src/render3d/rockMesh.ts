// GENERATED ROCKS AT RUNTIME: load a level's `public/rocks/<level>.glb` and swap
// each rock body's flat extrusion for its generated boulder (see rocks.ts for the
// pipeline and the hash).
//
// A level with no generated file is normal - every grapple level, and any level
// before its first `bun run assets:rocks` - so a missing or broken file resolves
// null and the extrusions simply stay. A body whose outline has changed since
// the file was generated keeps its extrusion too, which is how a stale rock
// shows itself in play without the level ever failing to draw.

import * as THREE from "three";
import type { LevelData } from "../level/levelFormat";
import { gltfLoader, trackPending } from "./assets";
import type { BodyVisual } from "./bodyVisuals";
import { rockMaterial } from "./rockMaterial";
import { ROCK_HASH_KEY, ROCK_INDEX_KEY, rockBodies, rocksUrl } from "./rocks";

// Replace the GLB's own material on every mesh of one body node with the rock
// material (rockMaterial.ts), which reads COLOR_0 as masks and wears the
// painted light itself. One material per body, because the AO atlas is the
// body's own: the GLB material's `aoMap` (occlusionTexture on TEXCOORD_1, so
// `channel` 1) is carried over as it is and the rest of that material is
// disposed. A mesh without COLOR_0 gets a material that reads neutral masks
// rather than the zeros an absent attribute would feed it.
function dressBody(body: THREE.Object3D): void {
  const made = new Map<string, THREE.MeshStandardMaterial>();
  body.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const old = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | THREE.MeshStandardMaterial
      | undefined;
    const aoMap = old?.aoMap ?? null;
    const masks = mesh.geometry.getAttribute("color") !== undefined;
    const side = old?.side ?? THREE.FrontSide;
    const key = `${aoMap?.uuid ?? ""}|${masks}|${side}`;
    let mat = made.get(key);
    if (!mat) {
      mat = rockMaterial({ aoMap, masks, side });
      made.set(key, mat);
    }
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
    mesh.material = mat;
  });
}

// One decoded file per level name, for the life of the page. A reset or a
// restart rebuilds the scene for the same level, and must not fetch and decode
// the rocks again to do it; `mountRocks` only ever clones out of this.
const cache = new Map<string, Promise<THREE.Object3D | null>>();

// The decoded scene of a level's generated rocks, shared: callers clone out of
// it and never dispose it. Null when the level has none.
export function loadLevelRocks(name: string): Promise<THREE.Object3D | null> {
  const cached = cache.get(name);
  if (cached) return cached;
  const url = rocksUrl(name);
  const p = (async (): Promise<THREE.Object3D | null> => {
    try {
      // Fetched by hand rather than through `loadAsync`, so an absent file is
      // told apart from a broken one by its status - and so a dev server that
      // answers a missing path with its HTML fallback is not handed to the
      // decoder as if it were a GLB.
      const [res, loader] = await Promise.all([fetch(url), gltfLoader()]);
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || type.startsWith("text/html")) {
        console.info(`[rocks] ${name}: no generated rocks (${url}: ${res.status})`);
        return null;
      }
      const gltf = await loader.parseAsync(await res.arrayBuffer(), "");
      for (const body of gltf.scene.children) dressBody(body);
      return gltf.scene;
    } catch (err: unknown) {
      console.info(`[rocks] ${name}: generated rocks failed to load (${url}):`, err);
      return null;
    }
  })();
  // Tracked so a headless grab waits for the rocks rather than shooting the
  // extrusions they are about to replace.
  cache.set(name, trackPending(p, `rocks "${name}"`));
  return p;
}

// Mount every rock body whose generated node still matches the level, hiding
// the extruded pieces it stands in for. `visuals[i]` draws `data.bodies[i]`.
// The returned group holds clones sharing the cached geometry and materials,
// so removing it from the scene is the whole of its teardown.
export function mountRocks(
  root: THREE.Object3D,
  data: LevelData,
  visuals: readonly BodyVisual[],
  level: string,
): { group: THREE.Group; mounted: number; stale: number[] } {
  const group = new THREE.Group();
  group.name = `rocks:${level}`;
  const byIndex = new Map<number, THREE.Object3D>();
  for (const child of root.children) {
    const index = child.userData[ROCK_INDEX_KEY] as unknown;
    if (typeof index === "number") byIndex.set(index, child);
  }
  let mounted = 0;
  const stale: number[] = [];
  for (const rock of rockBodies(data)) {
    const node = byIndex.get(rock.index);
    const visual = visuals[rock.index];
    if (!node || node.userData[ROCK_HASH_KEY] !== rock.hash || !visual) {
      stale.push(rock.index);
      continue;
    }
    group.add(node.clone());
    for (const g of rock.objects) visual.setDrawnVisible(g, false);
    mounted++;
  }
  const staleNote =
    stale.length > 0
      ? `, ${stale.length} stale (bodies ${stale.join(", ")}) - run: bun run assets:rocks ${level}`
      : "";
  console.info(`[rocks] ${level}: ${mounted} mounted${staleNote}`);
  return { group, mounted, stale };
}
