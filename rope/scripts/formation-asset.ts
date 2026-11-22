// Accept an asset of the editor's Assets tab into the model library
// (docs/formations.md, "The Assets tab").
//
//   bun run scripts/formation-asset.ts <name>
//
// The asset's document is `formation-assets/<name>.json`: a level of one body
// at the origin carrying a formation on a free guide. Its rock is built if the
// store lacks it (scripts/formation-build.ts), copied to
// `assets-src/models/<name>.blend` with the bake's caps set, and exported as a
// library model exactly as `just model <name>` exports one
// (scripts/model-export.ts: every face seen, the procedural slate baked). From
// then on it is a model like any other: `+ Model` places it, a level carrying
// it publishes it (`just publish`), and its source is the .blend beside the
// others. The asset's document stays, to change it and accept it again.
//
// The last line on success is `FORMATION_ASSET_DONE <json>`.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PX } from "../src/engine/units";
import { formationHash } from "../src/formation/recipe";
import { ROCK_FILE } from "../src/formation/store";
import { scaleLevelData, type RawLevelData } from "../src/level/levelFormat";
import { isModelName } from "../src/render3d/models";
import { ROOT } from "./blendExport";

const TAG = "[asset]";
const name = process.argv[2];
if (!name || !isModelName(name)) {
  console.error(`${TAG} usage: bun run scripts/formation-asset.ts <name> (a model name: lower-case letters, digits and dashes)`);
  process.exit(2);
}
const docPath = join(ROOT, "formation-assets", `${name}.json`);
if (!existsSync(docPath)) {
  console.error(`${TAG} no ${docPath}`);
  process.exit(1);
}
const data = scaleLevelData(JSON.parse(readFileSync(docPath, "utf8")) as RawLevelData, PX);
const f = data.bodies.find((b) => b.formation)?.formation;
if (!f) {
  console.error(`${TAG} ${name} carries no formation`);
  process.exit(1);
}

function run(args: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn("bun", ["run", ...args], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
    child.on("close", (status) => done(status ?? 1));
  });
}

// 1. The rock, as the recipe now asks for it.
const recipe = join(ROOT, ".cache", "formation-jobs", `asset-${name}.json`);
mkdirSync(join(recipe, ".."), { recursive: true });
writeFileSync(recipe, JSON.stringify({ generator: f.generator, ...(f.variant ? { variant: f.variant } : {}), params: f.params, guide: f.guide }));
if ((await run([join(ROOT, "scripts", "formation-build.ts"), recipe])) !== 0) {
  console.error(`${TAG} the rock could not be built`);
  process.exit(1);
}
const hash = formationHash(f);

// 2. Its source in the library.
const blend = join(ROOT, "assets-src", "models", `${name}.blend`);
mkdirSync(join(blend, ".."), { recursive: true });
copyFileSync(join(ROOT, "public", "generated", hash, ROCK_FILE), blend);
console.log(`${TAG} ${name}: assets-src/models/${name}.blend from ${hash.slice(0, 12)}`);

// 3. The model export.
if ((await run([join(ROOT, "scripts", "model-export.ts"), name])) !== 0) {
  console.error(`${TAG} the model export failed`);
  process.exit(1);
}
console.log(`FORMATION_ASSET_DONE ${JSON.stringify({ model: name, hash })}`);
