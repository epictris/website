// Bake every registered level's roots into one file per level, so the game
// draws them instead of growing them at load (docs/roots.md#baked-roots):
//
//   bun run roots:bake            every level with roots
//   bun run roots:bake ball       just levels/ball.json
//   bun run roots:bake --force    rewrite even a bake that is current
//
// Writes `public/roots/<level>.glb` and pins it in
// `src/render3d/rootBakes.json` with the key of every body in it. A level
// whose bodies all have the keys its pin already lists is left alone, so an
// unchanged level is never re-pinned (and never re-uploaded); a bake is the
// same bytes every time it is made from the same level on the same machine.
// `just publish` runs this first, and `assets:publish-stored` uploads what it
// pinned.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PX } from "../src/engine/units";
import { scaleLevelData, type RawLevelData } from "../src/level/levelFormat";
import { LEVELS } from "../src/level/registry";
import { rootBakeFile, type RootBake } from "../src/render3d/rootBake";
import { buildRootMeshes, rootBuildReady } from "../src/render3d/rootBuild";
import { rootMeshKey } from "../src/render3d/rootKey";
import { sha256 } from "./assetStore";
import { encodeRootBake } from "./rootBakeEncode";

const ROPE = join(import.meta.dir, "..");
const MANIFEST = join(ROPE, "src/render3d/rootBakes.json");

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));

await rootBuildReady;

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, RootBake>;
// A level generated in code (`levelData.ts`) has no file, and no roots.
const files = new Set(Object.values(LEVELS).flatMap((spec) => (spec.file ? [spec.file] : [])));
for (const name of only) if (!files.has(name)) throw new Error(`no registered level is levels/${name}.json`);

for (const level of [...files].sort()) {
  if (only.length && !only.includes(level)) continue;
  // From disk, not the registry's import: the editor may have written the
  // file since this process started.
  const raw = JSON.parse(readFileSync(join(ROPE, "levels", `${level}.json`), "utf8")) as RawLevelData;
  const data = scaleLevelData(raw, PX);
  const bodies = data.bodies.flatMap((body) => {
    const key = rootMeshKey(body);
    return key ? [{ body, key }] : [];
  });
  const file = rootBakeFile(level);
  const path = join(ROPE, "public", file);
  if (!bodies.length) {
    if (manifest[level]) {
      delete manifest[level];
      if (existsSync(path)) rmSync(path);
      console.log(`${level}: no roots any more, bake dropped`);
    }
    continue;
  }
  const keys = [...new Set(bodies.map((b) => b.key))].sort();
  const pinned = manifest[level];
  if (!force && pinned && pinned.keys.join() === keys.join() && existsSync(path) && sha256(readFileSync(path)) === pinned.sha256) {
    console.log(`${level}: current (${keys.length} bodies)`);
    continue;
  }
  const started = performance.now();
  const grown = bodies.map(({ body, key }) => ({ key, meshes: buildRootMeshes(body) }));
  const bytes = await encodeRootBake(level, grown);
  let triangles = 0;
  for (const { meshes } of grown) {
    for (const geometry of meshes.values()) {
      triangles += geometry.getIndex()!.count / 3;
      geometry.dispose();
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  manifest[level] = { file, sha256: sha256(bytes), bytes: bytes.byteLength, keys };
  console.log(
    `${level}: baked ${keys.length} bodies, ${triangles} triangles, ${(bytes.byteLength / 1024).toFixed(0)} KB ` +
      `in ${((performance.now() - started) / 1000).toFixed(1)} s -> ${file}`,
  );
}

const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`);
