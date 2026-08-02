// Upload one optimised prop to the release store and print the manifest entry it
// wants. The printing is the point: the `sha256` is what pins a revision of this
// repo to a specific set of bytes (see fetch-assets.ts), and a hash anybody has
// to compute by hand is a hash that ends up wrong or omitted.
//
//   bun run assets:publish public/meshes/rock.glb
//
// Deleting is the other half, and it is a one-liner precisely because being able
// to delete is why the bytes live here rather than in git:
//
//   gh release delete-asset assets rock.glb

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ASSET_REPO, ASSET_TAG, sha256 } from "./assetStore";

const [input] = process.argv.slice(2);
if (!input) {
  console.error("usage: bun run assets:publish <public/meshes/file.glb>");
  process.exit(2);
}
if (!existsSync(input)) {
  console.error(`no such file: ${input}`);
  process.exit(2);
}
if (spawnSync("which", ["gh"]).status !== 0) {
  console.error("the GitHub CLI (`gh`) is required to upload; see https://cli.github.com");
  process.exit(2);
}

const name = basename(input);
const bytes = readFileSync(resolve(input));
const hash = sha256(bytes);

// The store tag holds no version meaning, so it is created once and reused
// forever. `view` first rather than `create --if-not-exists`, which gh has no
// flag for.
const exists = spawnSync("gh", ["release", "view", ASSET_TAG, "--repo", ASSET_REPO], {
  stdio: "ignore",
}).status === 0;
if (!exists) {
  console.log(`[assets] creating the "${ASSET_TAG}" release on ${ASSET_REPO}`);
  const r = spawnSync(
    "gh",
    [
      "release",
      "create",
      ASSET_TAG,
      "--repo",
      ASSET_REPO,
      "--title",
      "Prop assets",
      "--notes",
      "Binary props for the rope 3D renderer, fetched at build time. Not a release of anything - see rope/CLAUDE.md, Prop assets.",
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// `--clobber` so re-publishing a re-optimised prop is the same command as
// publishing it. The sha256 below is what makes that safe to do.
const up = spawnSync(
  "gh",
  ["release", "upload", ASSET_TAG, resolve(input), "--repo", ASSET_REPO, "--clobber"],
  { stdio: "inherit" },
);
if (up.status !== 0) process.exit(up.status ?? 1);

console.log(`\n[assets] uploaded ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
console.log(`[assets] MESH_ASSETS entry (src/render3d/assets.ts):\n`);
console.log(`  "${name.replace(/\.[^.]+$/, "")}": {`);
console.log(`    file: "/meshes/${name}",`);
console.log(`    sha256: "${hash}",`);
console.log(`    source: "<url the model came from>",`);
console.log(`    license: "<e.g. CC0>",`);
console.log(`  },\n`);
console.log(`[assets] then \`bun run replay assets\` to check it against the budget.`);
