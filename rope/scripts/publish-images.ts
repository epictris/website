// Upload every picture in the image manifest that the release store does not
// hold yet.
//
//   bun run assets:publish-images      (part of `just publish`)
//
// The editor's upload (src/server/images.ts) already optimised, hashed and
// pinned each picture in `src/render3d/imageAssets.json`; this is the other half,
// run on the machine that uploaded them before the level showing them is
// committed. A manifest entry the release does not hold fails `assets:fetch`,
// and so the deploy, loudly.
//
// A key names one picture for ever (it carries the bytes' hash), so an upload
// never clobbers: a name the release already holds is checked against its pin
// and left alone.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_ASSETS } from "../src/render3d/images";
import { ASSET_REPO, ASSET_TAG, assetName, sha256 } from "./assetStore";

const PUBLIC_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "public");

const entries = Object.entries(IMAGE_ASSETS);
if (!entries.length) {
  console.log("[images] the manifest is empty; nothing to publish");
  process.exit(0);
}
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
  console.error(`[images] cannot list the "${ASSET_TAG}" release on ${ASSET_REPO}:\n${listed.stderr}`);
  process.exit(1);
}
const inRelease = new Set(listed.stdout.split("\n").filter(Boolean));

const failures: string[] = [];
let uploaded = 0;
for (const [key, asset] of entries) {
  const name = assetName(asset);
  if (inRelease.has(name)) continue;
  const path = join(PUBLIC_DIR, asset.file.replace(/^\//, ""));
  if (!existsSync(path)) {
    failures.push(`${key}: ${asset.file} is not on this machine and not in the release - upload it again in the editor`);
    continue;
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== asset.sha256) {
    failures.push(`${key}: ${asset.file} is not the bytes the manifest pins`);
    continue;
  }
  const up = spawnSync("gh", ["release", "upload", ASSET_TAG, path, "--repo", ASSET_REPO], { stdio: "inherit" });
  if (up.status !== 0) {
    failures.push(`${key}: upload failed`);
    continue;
  }
  uploaded++;
  console.log(`[images] uploaded ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

console.log(`[images] ${uploaded} uploaded, ${entries.length - uploaded - failures.length} already in the release`);
if (failures.length) {
  for (const f of failures) console.error(`[images] ${f}`);
  process.exit(1);
}
