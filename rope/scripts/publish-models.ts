// Bring the release store in line with the models the registered levels'
// bodies carry, and write `src/render3d/modelAssets.json` to match.
//
//   bun run assets:publish-models      (part of `just publish`)
//
// Run it on the machine that exported them, before committing a level that
// carries one: the build fetches a model from the store like any prop, and a
// level carrying a model the store does not hold fails the fetch (and so the
// deploy) and `cli assets`. How an export is replaced in place and pinned is
// `publishExports.ts`, which the scenes share (docs/blender-models.md).

import { join } from "node:path";
import { MODEL_ASSETS, modelFile, modelMetaFile, modelReleaseName } from "../src/render3d/models";
import { levelsModelNames } from "./assetStore";
import { ROOT } from "./blendExport";
import { publishExports } from "./publishExports";

const ok = publishExports({
  tag: "[models]",
  noun: "model",
  named: levelsModelNames(),
  pinned: MODEL_ASSETS,
  manifest: join(ROOT, "src", "render3d", "modelAssets.json"),
  file: modelFile,
  metaFile: modelMetaFile,
  releaseName: modelReleaseName,
  recipe: "just model <model>",
});
process.exit(ok ? 0 : 1);
