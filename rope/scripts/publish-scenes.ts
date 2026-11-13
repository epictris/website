// Bring the release store in line with the Blender scenes the registered
// levels name, and write `src/render3d/sceneAssets.json` to match.
//
//   bun run assets:publish-scenes      (part of `just publish`)
//
// Run it on the machine that exported them, before committing a level that
// names one: the build fetches a scene from the store like any prop, and a
// level naming a scene the store does not hold fails the fetch (and so the
// deploy) and `cli assets`. How an export is replaced in place and pinned is
// `publishExports.ts`, which the models share.

import { join } from "node:path";
import { SCENE_ASSETS, sceneFile, sceneMetaFile, sceneReleaseName } from "../src/render3d/scenes";
import { levelsSceneNames } from "./assetStore";
import { ROOT } from "./blendExport";
import { publishExports } from "./publishExports";

const ok = publishExports({
  tag: "[scenes]",
  noun: "scene",
  named: levelsSceneNames(),
  pinned: SCENE_ASSETS,
  manifest: join(ROOT, "src", "render3d", "sceneAssets.json"),
  file: sceneFile,
  metaFile: sceneMetaFile,
  releaseName: sceneReleaseName,
  recipe: "just scene <level>",
});
process.exit(ok ? 0 : 1);
