// Where a body's root meshes come from (docs/roots.md#baked-roots): the level's
// BAKE when it holds them, grown on the spot when it does not, and either way
// shared by every visual that draws the same body.
//
// Growing a branched root is hundreds of milliseconds of main thread per body
// (`rootFork.ts`), so a level's roots are grown once, by `bun run roots:bake`,
// into one file per level (`public/roots/<level>.glb`), published to the asset
// store and pinned in `rootBakes.json` with the KEY of every body in it
// (`rootMeshKey`). A body whose key is in a bake is drawn from the file; one
// whose key is not - a root edited since the bake, or a level never baked - is
// grown here, as the editor does for the root being drawn. Nothing about the
// look depends on which: the bake is the same build, written down.
//
// The cache is what the editor's rebuilds stand on: a whole-scene rebuild (any
// edit the in-place restyle does not cover) asks again for every body's
// meshes, and every body but an edited one gets back the same geometry, not a
// second growth of it.

import * as THREE from "three";

import type { LevelBodyData } from "../level/levelFormat";
import { gltfLoader, trackPending } from "./assets";
import { withDownload } from "./download";
import { buildRootMeshes, rootBuildIsReady, rootBuildReady } from "./rootBuild";
import manifest from "./rootBakes.json";

// One level's pinned bake: its file, the store's pin, and the key of every
// body it holds.
export interface RootBake {
  file: string;
  sha256: string;
  bytes: number;
  keys: string[];
}

export const ROOT_BAKES: Readonly<Record<string, RootBake>> = manifest as Record<string, RootBake>;

// Where a level's bake lives on disk and is served from.
export function rootBakeFile(level: string): string {
  return `/roots/${level}.glb`;
}

// The name a body's node has in a bake, and a branch's mesh in it: the key,
// and the branch's object index.
export function rootBodyNodeName(key: string): string {
  return `roots-${key}`;
}
export function rootPieceNodeName(index: number): string {
  return `root-${index}`;
}

// One branch's mesh, as it is drawn: the geometry and, for a baked one, the
// placement the bake's quantisation put on it (positions are stored as
// integers over the mesh's own bounds, and this scales them back to metres).
export interface RootPieceMesh {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4 | null;
}
export type RootMeshSet = ReadonlyMap<number, RootPieceMesh>;

const bakeByKey = new Map<string, RootBake>();
for (const bake of Object.values(ROOT_BAKES)) for (const key of bake.keys) bakeByKey.set(key, bake);

interface Entry {
  meshes: RootMeshSet | null;
  pending: Promise<RootMeshSet> | null;
  users: number;
  used: number;
}
const entries = new Map<string, Entry>();
let clock = 0;
// Bodies kept after nothing draws them, for the editor's next rebuild. A
// body is a few hundred kilobytes of buffers; this is a few levels' worth.
const KEEP_UNUSED = 64;

// The meshes for the body with this key: now when they are to hand, else a
// promise of them. Every call is a USE, given back by `releaseRootMeshes`.
export function acquireRootMeshes(key: string, data: LevelBodyData): RootMeshSet | Promise<RootMeshSet> {
  let entry = entries.get(key);
  if (!entry) {
    entry = { meshes: null, pending: null, users: 0, used: 0 };
    entries.set(key, entry);
  }
  entry.users++;
  entry.used = ++clock;
  if (entry.meshes) return entry.meshes;
  if (entry.pending) return entry.pending;
  const bake = typeof window === "undefined" ? undefined : bakeByKey.get(key);
  if (!bake && rootBuildIsReady()) return (entry.meshes = grown(data));
  const settled = entry;
  entry.pending = trackPending(
    (bake ? loadBake(bake).then((found) => found.get(key) ?? grownLater(key, data)) : grownLater(key, data))
      .then((meshes) => {
        settled.meshes = meshes;
        settled.pending = null;
        return meshes;
      }),
    `roots ${key}`,
  );
  return entry.pending;
}

export function releaseRootMeshes(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.users = Math.max(0, entry.users - 1);
  const unused = [...entries].filter(([, e]) => e.users === 0 && e.meshes);
  if (unused.length <= KEEP_UNUSED) return;
  unused.sort((a, b) => a[1].used - b[1].used);
  for (const [k, e] of unused.slice(0, unused.length - KEEP_UNUSED)) {
    for (const piece of e.meshes!.values()) piece.geometry.dispose();
    entries.delete(k);
  }
}

// Grown here, reported in the page: a body grown at a game's load is one the
// level's bake should have held (`cli assets` says which).
function grown(data: LevelBodyData): RootMeshSet {
  const started = performance.now();
  const out = new Map<number, RootPieceMesh>();
  for (const [i, geometry] of buildRootMeshes(data)) out.set(i, { geometry, matrix: null });
  if (typeof window !== "undefined") {
    console.log(`[roots] grew a body of ${out.size} piece(s) in ${(performance.now() - started).toFixed(0)} ms (not baked)`);
  }
  return out;
}

function grownLater(key: string, data: LevelBodyData): Promise<RootMeshSet> {
  return rootBuildReady.then(() => entries.get(key)?.meshes ?? grown(data));
}

// One decoded file per bake, every body in it entered in the cache as it
// lands (so a level's other bodies are there before they are asked for). A
// bake that fails to load is reported once and its bodies are grown instead.
const bakes = new Map<string, Promise<Map<string, RootMeshSet>>>();

function loadBake(bake: RootBake): Promise<Map<string, RootMeshSet>> {
  const cached = bakes.get(bake.file);
  if (cached) return cached;
  const loading = withDownload(bake.file, bake.bytes, (href) => gltfLoader().then((loader) => loader.loadAsync(href)))
    .then((gltf) => {
      const found = readRootBake(gltf.scene);
      for (const [key, set] of found) {
        const entry = entries.get(key);
        if (!entry) entries.set(key, { meshes: set, pending: null, users: 0, used: ++clock });
        else if (!entry.meshes) entry.meshes = set;
      }
      console.log(`[roots] ${bake.file}: ${found.size} baked bodies`);
      return found;
    })
    .catch((err: unknown) => {
      console.warn(`[roots] the bake ${bake.file} did not load; growing its roots instead`, err);
      return new Map<string, RootMeshSet>();
    });
  bakes.set(bake.file, loading);
  return loading;
}

// Every body in a loaded bake, by key (the layout `scripts/rootBakeEncode.ts`
// writes).
export function readRootBake(scene: THREE.Object3D): Map<string, RootMeshSet> {
  const found = new Map<string, RootMeshSet>();
  for (const node of scene.children) {
    const key = keyOfBodyNode(node);
    if (!key) continue;
    const set = new Map<number, RootPieceMesh>();
    node.updateMatrixWorld(true);
    for (const child of node.children) {
      const mesh = child as THREE.Mesh;
      const index = pieceIndexOf(mesh);
      if (!mesh.isMesh || index === undefined) continue;
      set.set(index, { geometry: adoptBakedGeometry(mesh.geometry), matrix: mesh.matrix.clone() });
    }
    found.set(key, set);
  }
  return found;
}

// glTF keeps a node's name in `userData.name` and gives the object a
// sanitised copy; the bake's names need no sanitising, but the original is
// the one to trust.
function nodeName(o: THREE.Object3D): string {
  return (o.userData["name"] as string | undefined) ?? o.name;
}
function keyOfBodyNode(o: THREE.Object3D): string | undefined {
  const name = nodeName(o);
  return name.startsWith("roots-") ? name.slice("roots-".length) : undefined;
}
function pieceIndexOf(o: THREE.Object3D): number | undefined {
  const m = /^root-(\d+)$/.exec(nodeName(o));
  return m ? Number(m[1]) : undefined;
}

// A custom glTF attribute arrives under its file name lowercased (`_ROOTAGE`
// as `_rootage`); the bark's shader reads `rootAge` and `rootJoin`.
function adoptBakedGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const [from, to] of [["_rootage", "rootAge"], ["_rootjoin", "rootJoin"]] as const) {
    const attribute = geometry.getAttribute(from);
    if (!attribute) continue;
    geometry.setAttribute(to, attribute);
    geometry.deleteAttribute(from);
  }
  return geometry;
}
