// Publish every registered level's built formations to the asset release as
// region bundles and pin them in src/render3d/formationAssets.json (part of
// `just publish`; scripts/formationBundles.ts, docs/formations.md).
//
//   bun run assets:publish-formations

import { spawnSync } from "node:child_process";
import { publishFormations } from "./formationBundles";

if (spawnSync("which", ["gh"]).status !== 0) {
  console.error("the GitHub CLI (`gh`) is required to upload; see https://cli.github.com");
  process.exit(2);
}
process.exit(publishFormations() ? 0 : 1);
