// Remove from the formation store what no level names (docs/formations.md,
// "The store").
//
//   bun run formation:sweep            say what would go
//   bun run formation:sweep --delete   and remove it
//
// Named is everything built that a file under levels/ (registered or not: the
// editor opens any of them) or prefabs/ (a prefab's rock is built from the
// prefab, plans/node-tree.md "Formations in prefabs") holds: every
// `Formation3D` node's build and every imported mesh its solid guide uses,
// every `Decoration3D` node's build and the baked material a material layer
// lays (`built.maps`), disabled nodes included, since enabling one again
// should not want a Regenerate. Every hash a pinned bundle holds is named too.
// A save never removes anything; this does, by hand. An editor's undo history
// can still name a build the file no longer does, so sweep with the editors
// closed, or expect an undo past the sweep to want a Regenerate.
//
// Only the store's own names are touched: a 64-hex folder, and `meshes/`.
// Everything else under public/generated (the retired generator service's
// folders) is left alone.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { meshFiles } from "../src/formation/solid";
import { FORMATION_HASH, MESHES } from "../src/formation/store";
import { walkNodes, type LevelNode } from "../src/level/nodes";
import { pinnedBundles } from "./formationBundles";
import { LEVELS_DIR, readLevelTree, readPrefabs } from "./levelTree";

const ROOT = join(import.meta.dirname, "..");
const STORE = join(ROOT, "public", "generated");
const remove = process.argv.includes("--delete");

const hashes = new Set<string>();
const meshes = new Set<string>();
const collect = (nodes: readonly LevelNode[]): void =>
  walkNodes(nodes, (n) => {
    if (n.type === "Formation3D") {
      if (n.built) hashes.add(n.built.hash);
      if (n.guide.kind === "solid") for (const m of meshFiles(n.guide.tree)) meshes.add(m);
    } else if (n.type === "Decoration3D" && n.built) {
      hashes.add(n.built.hash);
      if (n.built.maps) hashes.add(n.built.maps);
    }
  });
for (const file of readdirSync(LEVELS_DIR).filter((f) => f.endsWith(".json"))) collect(readLevelTree(join(LEVELS_DIR, file)).nodes);
const prefabs = readPrefabs();
for (const prefab of prefabs.values()) collect([prefab.root]);
for (const regions of Object.values(pinnedBundles())) for (const pin of Object.values(regions)) for (const h of pin.hashes) hashes.add(h);

const size = (path: string): number => {
  const s = statSync(path);
  return s.isDirectory() ? readdirSync(path).reduce((n, f) => n + size(join(path, f)), 0) : s.size;
};
let gone = 0;
let bytes = 0;
const sweep = (path: string, what: string): void => {
  const b = size(path);
  bytes += b;
  gone++;
  console.log(`  ${remove ? "removed" : "would remove"} ${what} (${(b / 1024).toFixed(0)} KB)`);
  if (remove) rmSync(path, { recursive: true, force: true });
};
if (existsSync(STORE)) {
  for (const entry of readdirSync(STORE)) {
    if (FORMATION_HASH.test(entry) && !hashes.has(entry)) sweep(join(STORE, entry), entry.slice(0, 12));
    // A build that died before its rename leaves its staging folder.
    if (/^\.[0-9a-f]{64}\.\d+$/.test(entry)) sweep(join(STORE, entry), `${entry.slice(1, 13)} (unfinished)`);
  }
  const meshDir = join(STORE, MESHES);
  if (existsSync(meshDir)) {
    for (const f of readdirSync(meshDir)) {
      // The leaf's name: the bare hash for a JSON mesh, the file name for a
      // binary one (formation/meshBin.ts).
      const name = f.replace(/\.json$/, "");
      if (!meshes.has(name)) sweep(join(meshDir, f), `mesh ${name.slice(0, 12)}`);
    }
  }
}
console.log(
  `[formations] ${hashes.size} builds and ${meshes.size} meshes named (${prefabs.size} prefab${prefabs.size === 1 ? "" : "s"} read); ${gone} ${remove ? "removed" : "unnamed"} (${(bytes / 1024 / 1024).toFixed(1)} MB)` +
    (!remove && gone ? " - run with --delete to remove them" : ""),
);
