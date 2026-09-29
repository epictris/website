// Upload the Blender scenes' sources to the release store and pin them in
// `scripts/sceneSources.json` (see `scripts/sceneSources.ts` for what a source
// is and why it is stored).
//
//   bun run assets:publish-sources [path ...]   (part of `just publish`)
//
// Publishes the `.blend` of every scene a registered level names, every source
// already pinned, and any further path given (under `assets-src/`, e.g.
// `scenes/textures/soft-moss-v2.png`), each only when this machine's copy
// differs from its pin. A pinned source missing here is fine as long as the
// release holds it (a checkout that never fetched it); a scene a level names
// with no source here and none in the store is a failure, because its
// dressing could not be made again.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_REPO, ASSET_TAG, sha256 } from "./assetStore";
import {
  levelSceneSources,
  MANIFEST,
  readManifest,
  sourceKey,
  sourceReleaseName,
  SOURCES_DIR,
} from "./sceneSources";

const manifest = readManifest();
const paths = [
  ...new Set([...levelSceneSources(), ...Object.keys(manifest), ...process.argv.slice(2).map(sourceKey)]),
].sort();

if (spawnSync("which", ["gh"]).status !== 0) {
  console.error("the GitHub CLI (`gh`) is required to upload; see https://cli.github.com");
  process.exit(2);
}
const listed = spawnSync(
  "gh",
  ["release", "view", ASSET_TAG, "--repo", ASSET_REPO, "--json", "assets", "--jq", ".assets[].name"],
  { encoding: "utf8" },
);
if (listed.status !== 0) {
  console.error(`[sources] cannot list the "${ASSET_TAG}" release on ${ASSET_REPO}:\n${listed.stderr}`);
  process.exit(1);
}
const inRelease = new Set(listed.stdout.split("\n").filter(Boolean));

const failures: string[] = [];
let uploaded = 0;
let current = 0;
for (const path of paths) {
  const name = sourceReleaseName(path);
  const file = join(SOURCES_DIR, path);
  const pinned = manifest[path];
  if (!existsSync(file)) {
    if (pinned && inRelease.has(name)) {
      current++;
      continue;
    }
    failures.push(`${path}: not on this machine and not in the release`);
    continue;
  }
  const bytes = readFileSync(file);
  const hash = sha256(bytes);
  if (pinned?.sha256 === hash && pinned.bytes === bytes.length && inRelease.has(name)) {
    current++;
    continue;
  }
  // gh names a release asset after the file, so upload a copy carrying the name.
  const staging = mkdtempSync(join(tmpdir(), "source-"));
  const staged = join(staging, name);
  copyFileSync(file, staged);
  const up = spawnSync("gh", ["release", "upload", ASSET_TAG, staged, "--repo", ASSET_REPO, "--clobber"], {
    stdio: "inherit",
  });
  rmSync(staging, { recursive: true, force: true });
  if (up.status !== 0) {
    failures.push(`${path}: upload failed`);
    continue;
  }
  manifest[path] = { sha256: hash, bytes: bytes.length };
  uploaded++;
  console.log(
    `[sources] uploaded ${name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)` +
      (pinned ? ` replacing ${pinned.sha256.slice(0, 12)}…` : ""),
  );
}

const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + "\n");
console.log(`[sources] ${uploaded} uploaded, ${current} current`);
if (failures.length) {
  for (const f of failures) console.error(`[sources] ${f}`);
  process.exit(1);
}
