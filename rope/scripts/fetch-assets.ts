// Populate `public/meshes/`, `public/textures/` (and the other stored kinds,
// the levels' Blender scenes among them) from the release store. Run by hand after a clone
// (`bun run assets:fetch`) and by the Dockerfile before `bun run build`, so the
// bytes reach the image without ever entering git.
//
// Every file is verified against the `sha256` its manifest entry names. That is
// not ceremony: a release asset can be replaced in place, so the manifest is the
// only thing that says WHICH bytes a given revision of this repo was written
// against. A mismatch is a hard failure rather than a warning, because the two
// ways to get one - a re-uploaded asset, or a truncated download - both produce
// a game that is subtly not the one anybody tested.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_ASSETS } from "../src/render3d/scenes";
import { MODEL_ASSETS } from "../src/render3d/models";
import { assetName, assetUrl, levelsModelNames, levelsSceneNames, sha256, storedAssets } from "./assetStore";
import { fetchFormations } from "./formationBundles";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public");

// A Blender scene a level names and the store does not hold would ship a level
// with no look at all - the build succeeds and the level draws nothing but its
// water and the ball - so it stops the fetch, and with it the Docker build,
// before the empty-manifest early exit below can wave it through.
// A model a body carries is the same failure on a smaller scale: the body
// draws nothing at all.
const unpublished = [
  ...[...levelsSceneNames()].filter(([scene]) => !SCENE_ASSETS[scene]).map(([scene, levels]) => `scene "${scene}" (${levels.join(", ")})`),
  ...[...levelsModelNames()].filter(([model]) => !MODEL_ASSETS[model]).map(([model, levels]) => `model "${model}" (${levels.join(", ")})`),
];
if (unpublished.length) {
  for (const what of unpublished) console.error(`  FAIL  ${what} is not in the store`);
  console.error(`\n[assets] publish them from the machine that exported them: \`just publish\`.`);
  process.exit(1);
}

// Props and texture maps in one list: both live in the same flat release, both
// are pinned by sha256, and a fetch that knew about only one of the two
// manifests would leave a level half-dressed with nothing to report.
const entries = storedAssets();
if (entries.length === 0) {
  console.log("[assets] manifests are empty, nothing to fetch");
  process.exit(0);
}

// Deliberately UNAUTHENTICATED. The release is public and its download URL
// redirects to object storage that signs the request itself, so an
// `authorization` header is at best ignored and at worst rejected by the
// redirect target - and carrying a token here would mean getting one into the
// Docker build, where a build ARG is readable by anyone who pulls the image.
let fetched = 0;
let skipped = 0;
const failures: string[] = [];

for (const asset of entries) {
  const key = asset.key;
  const dest = join(PUBLIC_DIR, asset.file.replace(/^\//, ""));

  // Already correct? Then leave it alone. This is what makes the fetch cheap to
  // run habitually - a rebuild after an unrelated edit re-downloads nothing.
  if (existsSync(dest) && sha256(readFileSync(dest)) === asset.sha256) {
    skipped++;
    continue;
  }

  const url = assetUrl(asset);
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      failures.push(`${key}: ${res.status} ${res.statusText} <- ${url}`);
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const got = sha256(bytes);
    if (got !== asset.sha256) {
      failures.push(
        `${key}: sha256 mismatch\n      manifest ${asset.sha256}\n      download ${got}\n` +
          `      the release asset was replaced, or the download truncated`,
      );
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    console.log(`[assets] fetched ${assetName(asset)} (${(bytes.length / 1024).toFixed(0)} KB)`);
    fetched++;
  } catch (err) {
    failures.push(`${key}: ${String(err)} <- ${url}`);
  }
}

// The levels' formations: region bundles unpacked into the loose store
// (scripts/formationBundles.ts), which is what the editor and the build read.
{
  const f = await fetchFormations();
  fetched += f.fetched;
  skipped += f.current;
  failures.push(...f.failures);
}

console.log(`[assets] ${fetched} fetched, ${skipped} already current, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) {
  console.error(
    `\n[assets] a missing asset usually means it was deleted from the release, which is\n` +
      `[assets] allowed and expected - remove its manifest entry, or re-upload it with\n` +
      `[assets] \`bun run assets:publish <file>\`.`,
  );
}
process.exit(failures.length ? 1 : 0);
