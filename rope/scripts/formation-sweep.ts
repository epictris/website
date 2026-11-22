// Remove from the formation store what no level names (docs/formations.md,
// "The store").
//
//   bun run formation:sweep            say what would go
//   bun run formation:sweep --delete   and remove it
//
// Named is every `formation.built.hash` in every file under levels/ (registered
// or not: the editor opens any of them), every hash a pinned bundle holds, and
// every imported mesh a solid guide in those files uses. A save never removes
// anything; this does, by hand. An editor's undo history can still name a
// build the file no longer does, so sweep with the editors closed, or expect
// an undo past the sweep to want a Regenerate.
//
// Only the store's own names are touched: a 64-hex folder, and `meshes/`.
// Everything else under public/generated (the retired generator service's
// folders) is left alone.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { meshFiles } from "../src/formation/solid";
import { FORMATION_HASH, MESHES } from "../src/formation/store";
import { normalizeLevelData, type RawLevelData } from "../src/level/levelFormat";
import { pinnedBundles } from "./formationBundles";

const ROOT = join(import.meta.dirname, "..");
const STORE = join(ROOT, "public", "generated");
const remove = process.argv.includes("--delete");

const hashes = new Set<string>();
const meshes = new Set<string>();
for (const file of readdirSync(join(ROOT, "levels")).filter((f) => f.endsWith(".json"))) {
  const data = normalizeLevelData(JSON.parse(readFileSync(join(ROOT, "levels", file), "utf8")) as RawLevelData);
  for (const b of data.bodies) {
    const f = b.formation;
    if (!f) continue;
    if (f.built) hashes.add(f.built.hash);
    if (f.guide.kind === "solid") for (const m of meshFiles(f.guide.tree)) meshes.add(m);
  }
}
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
      const name = f.replace(/\.json$/, "");
      if (!meshes.has(name)) sweep(join(meshDir, f), `mesh ${name.slice(0, 12)}`);
    }
  }
}
console.log(
  `[formations] ${hashes.size} builds and ${meshes.size} meshes named; ${gone} ${remove ? "removed" : "unnamed"} (${(bytes / 1024 / 1024).toFixed(1)} MB)` +
    (!remove && gone ? " - run with --delete to remove them" : ""),
);
