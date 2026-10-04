// Bring the release store in line with every manifest entry this checkout pins:
// props, texture maps, raw water maps, skies and scenes - the whole list
// `assets:fetch` verifies.
//
//   bun run assets:publish-stored      (part of `just publish`)
//
// It exists because the manifests and the release drift apart silently. A
// commit that re-pins an entry (a re-optimised prop, a new delivery) and is
// pushed without `assets:publish <file>` leaves the release holding the old
// bytes, and nothing notices until the Docker build's fetch fails on a sha256
// mismatch - after the push, on the deploy.
//
// The manifest is the authority and this machine's `public/` is the only source
// of bytes: an entry is uploaded when the release does not hold the pinned
// bytes AND the file here is exactly those bytes. It never re-pins anything - a
// local file that differs from its pin is reported, not published, because
// replacing the release copy with it would break the fetch of the very commit
// that pins the old bytes. Re-pinning stays `assets:publish <file>`, which
// prints the entry to paste.
//
// What the release holds is read from the sha256 digest GitHub records for each
// asset, so a sync with nothing to do downloads nothing.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_REPO, ASSET_TAG, assetName, sha256, storedAssets } from "./assetStore";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");

if (spawnSync("which", ["gh"]).status !== 0) {
  console.error("the GitHub CLI (`gh`) is required to upload; see https://cli.github.com");
  process.exit(2);
}

// name -> sha256 hex, or null for an asset GitHub has no digest for (one
// uploaded before it recorded them). Unknown is treated as stale: re-uploading
// the pinned bytes is harmless, and it records the digest for next time.
function releaseDigests(): Map<string, string | null> {
  const r = spawnSync(
    "gh",
    ["release", "view", ASSET_TAG, "--repo", ASSET_REPO, "--json", "assets", "--jq", ".assets[] | [.name, .digest] | @tsv"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`[assets] cannot list the "${ASSET_TAG}" release on ${ASSET_REPO}:\n${r.stderr}`);
    process.exit(1);
  }
  const out = new Map<string, string | null>();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [name, digest] = line.split("\t");
    out.set(name!, digest?.startsWith("sha256:") ? digest.slice("sha256:".length) : null);
  }
  return out;
}

const inRelease = releaseDigests();
const failures: string[] = [];
const drifted: string[] = [];
let uploaded = 0;
let current = 0;

for (const asset of storedAssets()) {
  const name = assetName(asset);
  const path = join(PUBLIC_DIR, asset.file.replace(/^\//, ""));
  const local = existsSync(path) ? sha256(readFileSync(path)) : null;
  const released = inRelease.get(name);

  // A local file the pin does not describe is never uploaded (see the top),
  // but it is worth saying: it is usually a re-export somebody meant to pin.
  if (local !== null && local !== asset.sha256) {
    drifted.push(`${asset.key}: ${path.slice(ROOT.length + 1)} is ${local.slice(0, 12)}…, pinned ${asset.sha256.slice(0, 12)}…`);
  }

  if (released === asset.sha256) {
    current++;
    continue;
  }
  if (local !== asset.sha256) {
    failures.push(
      `${asset.key}: the release ${released === undefined ? "does not hold" : "holds other bytes for"} ${name}, ` +
        `and this machine ${local === null ? "has no copy" : "has different bytes"} - publish it from the machine that made it`,
    );
    continue;
  }

  // gh names a release asset after the file, so a file whose release name is not
  // its basename (a scene) is uploaded from a copy carrying that name.
  const staging = mkdtempSync(join(tmpdir(), "asset-"));
  const staged = join(staging, name);
  copyFileSync(path, staged);
  const up = spawnSync("gh", ["release", "upload", ASSET_TAG, staged, "--repo", ASSET_REPO, "--clobber"], {
    stdio: "inherit",
  });
  rmSync(staging, { recursive: true, force: true });
  if (up.status !== 0) {
    failures.push(`${asset.key}: upload failed`);
    continue;
  }
  uploaded++;
  console.log(
    `[assets] uploaded ${name} (${(asset.bytes / 1024).toFixed(0)} KB)` +
      (released ? ` replacing ${released.slice(0, 12)}…` : ""),
  );
}

console.log(`[assets] ${uploaded} uploaded, ${current} already current, ${failures.length} failed`);
for (const d of drifted) console.warn(`  NOTE  ${d} - \`bun run assets:publish <file>\` to re-pin it`);
for (const f of failures) console.error(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
