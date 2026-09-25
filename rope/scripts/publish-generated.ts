// Bring the release store in line with the generated meshes the registered
// levels name, and write `src/render3d/generatedAssets.json` to match.
//
//   bun run assets:publish-generated
//
// Run it on the machine that generated them, before committing the level that
// names them: the build fetches generated meshes from the store like any prop,
// and a level naming one the store does not hold fails the fetch (and so the
// deploy) and `cli assets`.
//
// Unlike `assets:publish`, it WRITES its manifest rather than printing a line to
// paste. A prop's entry carries decisions (its source, its licence, the recipe
// it was optimised with) that someone should be looking at when they are
// written; a generated mesh's entry is its hash and its size, nothing else, and
// which meshes need one is decided by the levels.
//
// A key names one mesh for ever, so an upload never clobbers. When the release
// already holds a key's name (published from another machine, whose manifest
// entry has not reached this tree), the published bytes win: they are fetched,
// pinned, and written over the local copy, since Blender run twice may not write
// the same file and the store's copy is the one other revisions may already pin.
//
// An entry no level names any more is dropped from the manifest and NOT deleted
// from the release: an older commit may still pin it. The command to delete it
// is printed, for when that no longer matters.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedMeshAsset } from "../src/render3d/generated";
import {
  GENERATED_ASSETS,
  GENERATED_ASSETS_FILE,
  generatedReleaseName,
  type GeneratedAsset,
} from "../src/render3d/generatedMeta";
import { ASSET_REPO, ASSET_TAG, assetUrl, levelsGeneratedKeys, sha256 } from "./assetStore";

const PUBLIC_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "public");

const named = levelsGeneratedKeys();
const manifest: Record<string, GeneratedAsset> = { ...GENERATED_ASSETS };
const todo = [...named.keys()].filter((key) => !manifest[key]).sort();
const dropped = Object.keys(manifest).filter((key) => !named.has(key));

// What the release holds, read once. Only needed when there is something to
// publish, so an in-sync tree runs this without `gh`.
function releaseNames(): Set<string> {
  if (spawnSync("which", ["gh"]).status !== 0) {
    console.error("the GitHub CLI (`gh`) is required to upload; see https://cli.github.com");
    process.exit(2);
  }
  const r = spawnSync(
    "gh",
    ["release", "view", ASSET_TAG, "--repo", ASSET_REPO, "--json", "assets", "--jq", ".assets[].name"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`[generated] cannot list the "${ASSET_TAG}" release on ${ASSET_REPO}:\n${r.stderr}`);
    process.exit(1);
  }
  return new Set(r.stdout.split("\n").filter(Boolean));
}

const failures: string[] = [];
if (todo.length) {
  const inRelease = releaseNames();
  // `gh release upload` names an asset after its file, and every generated file
  // is `mesh.glb`, so each upload goes through a copy under its release name.
  const scratch = mkdtempSync(join(tmpdir(), "generated-publish-"));
  try {
    for (const key of todo) {
      const name = generatedReleaseName(key);
      const file = generatedMeshAsset(key)!.file;
      const path = join(PUBLIC_DIR, file.replace(/^\//, ""));
      const levels = named.get(key)!.join(", ");

      if (inRelease.has(name)) {
        const res = await fetch(assetUrl({ file, name }), { redirect: "follow" });
        if (!res.ok) {
          failures.push(`${key} (${levels}): the release lists ${name} but it fetched ${res.status}`);
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const hash = sha256(bytes);
        const local = existsSync(path) ? sha256(readFileSync(path)) : null;
        if (local !== hash) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, bytes);
        }
        manifest[key] = { sha256: hash, bytes: bytes.length };
        console.log(
          `[generated] pinned ${name}, already in the release` +
            (local === null ? " (fetched)" : local !== hash ? " (it differs from this machine's; the local copy is replaced)" : ""),
        );
        continue;
      }

      if (!existsSync(path)) {
        failures.push(`${key} (${levels}): not generated on this machine and not in the release - generate it in the editor`);
        continue;
      }
      const bytes = readFileSync(path);
      const upload = join(scratch, name);
      writeFileSync(upload, bytes);
      const up = spawnSync("gh", ["release", "upload", ASSET_TAG, upload, "--repo", ASSET_REPO], { stdio: "inherit" });
      if (up.status !== 0) {
        failures.push(`${key} (${levels}): upload failed`);
        continue;
      }
      manifest[key] = { sha256: sha256(bytes), bytes: bytes.length };
      console.log(`[generated] uploaded ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const key of dropped) {
  delete manifest[key];
  console.log(
    `[generated] dropped ${key}, which no level names; still in the release for older commits ` +
      `(\`gh release delete-asset ${ASSET_TAG} ${generatedReleaseName(key)}\` to remove it)`,
  );
}

const sorted = Object.fromEntries(Object.keys(manifest).sort().map((key) => [key, manifest[key]!]));
const text = JSON.stringify(sorted, null, 2) + "\n";
const changed = text !== readFileSync(GENERATED_ASSETS_FILE, "utf8");
if (changed) writeFileSync(GENERATED_ASSETS_FILE, text);

console.log(
  `[generated] ${named.size} named by the levels, ${todo.length - failures.length} published, ` +
    `${dropped.length} dropped, ${failures.length} failed` +
    (changed ? " - commit src/render3d/generatedAssets.json with the levels" : ""),
);
for (const f of failures) console.error(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
