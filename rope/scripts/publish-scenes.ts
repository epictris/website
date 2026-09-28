// Bring the release store in line with the Blender scenes the registered
// levels name, and write `src/render3d/sceneAssets.json` to match.
//
//   bun run assets:publish-scenes      (part of `just publish`)
//
// Run it on the machine that exported them, before committing a level that
// names one: the build fetches a scene from the store like any prop, and a
// level naming a scene the store does not hold fails the fetch (and so the
// deploy) and `cli assets`.
//
// Unlike a generated mesh, a scene is REPLACED IN PLACE: `scene-<name>.glb` is
// re-uploaded whenever this machine's export differs from the pin, because a
// scene is exported again and again for as long as the level is dressed, and
// a name per export would leave every draft in the release for ever. The pin
// (sha256 + bytes) is what says which export a commit meant; `assets:fetch`
// verifies it, so an older commit whose export was replaced fails its fetch
// loudly rather than drawing a different level - the store's stated trade
// (docs/asset-store.md).
//
// An entry no level names any more is dropped from the manifest and NOT
// deleted from the release, since an older commit may still pin it; the
// command to delete it is printed.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_ASSETS, sceneFile, sceneMetaFile, sceneReleaseName, type SceneAsset, type SceneMeta } from "../src/render3d/scenes";
import { ASSET_REPO, ASSET_TAG, levelsSceneNames, sha256 } from "./assetStore";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");
const MANIFEST = join(ROOT, "src", "render3d", "sceneAssets.json");

const named = levelsSceneNames();
const manifest: Record<string, SceneAsset> = { ...SCENE_ASSETS };
const dropped = Object.keys(manifest).filter((scene) => !named.has(scene));

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
    console.error(`[scenes] cannot list the "${ASSET_TAG}" release on ${ASSET_REPO}:\n${r.stderr}`);
    process.exit(1);
  }
  return new Set(r.stdout.split("\n").filter(Boolean));
}

const failures: string[] = [];
let uploaded = 0;
let current = 0;
if (named.size) {
  const inRelease = releaseNames();
  for (const [scene, levels] of [...named].sort()) {
    const name = sceneReleaseName(scene);
    const path = join(PUBLIC_DIR, sceneFile(scene).slice(1));
    const pinned = manifest[scene];
    if (!existsSync(path)) {
      // Nothing exported here. A pin the release honours is fine (a fresh
      // checkout publishing something else); anything less is a scene the
      // deploy cannot draw.
      if (pinned && inRelease.has(name)) {
        current++;
        continue;
      }
      failures.push(`${scene} (${levels.join(", ")}): not exported on this machine (\`just scene <level>\`) and not in the release`);
      continue;
    }
    const bytes = readFileSync(path);
    const hash = sha256(bytes);
    // The credits of what is inside it ride along with the pin, from the
    // export's own meta - which must describe this very file.
    const metaPath = join(PUBLIC_DIR, sceneMetaFile(scene).slice(1));
    const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as SceneMeta) : null;
    if (!meta || meta.sha256 !== hash) {
      failures.push(`${scene} (${levels.join(", ")}): meta.json does not describe this scene.glb; export it again (\`just scene <level>\`)`);
      continue;
    }
    const credits = meta.credits ?? [];
    if (pinned?.sha256 === hash && pinned.bytes === bytes.length && inRelease.has(name)) {
      if (JSON.stringify(pinned.credits ?? []) !== JSON.stringify(credits)) manifest[scene] = { ...pinned, credits };
      current++;
      continue;
    }
    const up = spawnSync("gh", ["release", "upload", ASSET_TAG, `${path}#${name}`, "--repo", ASSET_REPO, "--clobber"], {
      stdio: "inherit",
    });
    if (up.status !== 0) {
      failures.push(`${scene} (${levels.join(", ")}): upload failed`);
      continue;
    }
    manifest[scene] = { sha256: hash, bytes: bytes.length, credits };
    uploaded++;
    console.log(
      `[scenes] uploaded ${name} (${(bytes.length / 1024).toFixed(0)} KB)` +
        (pinned ? ` replacing ${pinned.sha256.slice(0, 12)}…` : ""),
    );
  }
}

for (const scene of dropped) {
  delete manifest[scene];
  console.log(
    `[scenes] dropped ${scene}, which no level names; still in the release for older commits ` +
      `(\`gh release delete-asset ${ASSET_TAG} ${sceneReleaseName(scene)}\` to remove it)`,
  );
}

const sorted = Object.fromEntries(Object.keys(manifest).sort().map((scene) => [scene, manifest[scene]!]));
const text = JSON.stringify(sorted, null, 2) + "\n";
const changed = text !== readFileSync(MANIFEST, "utf8");
if (changed) writeFileSync(MANIFEST, text);

console.log(
  `[scenes] ${named.size} named by the levels, ${uploaded} uploaded, ${current} already current, ` +
    `${dropped.length} dropped, ${failures.length} failed` +
    (changed ? " - commit src/render3d/sceneAssets.json with the levels" : ""),
);
for (const f of failures) console.error(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
