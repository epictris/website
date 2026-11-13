// Export a model of the library into the game (`just model <model>`).
//
//   bun run model:export <model> [--blender PATH] [--raw] [--no-cache] [--stale-occlusion]
//
// `assets-src/models/<model>.blend` goes through the scene exporter exactly as
// a level's scene does (`blendExport.ts`: every object with geometry that is
// not a guide, linked or hidden in render; procedural materials baked; the
// optimiser), with one difference: every face counts as seen when the unwrap
// shares out the texels (`--all-seen`), since a level may turn a model to show
// any side of it. What lands is
//
//   public/models/<model>/model.glb     what the game draws
//   public/models/<model>/meta.json     what was exported, and its extent
//
// Then refresh the browser: every body carrying a `model` object of this name,
// in every level, draws it. The model is modelled in the game's frame, Blender's
// front view: metres, its ORIGIN the point a level places (Blender's world
// origin, not any object's), -y toward the camera. See docs/blender-models.md.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isModelName, MODEL_ASSETS, modelFile, modelMetaFile, type ModelMeta } from "../src/render3d/models";
import { exportArgs, exportBlend, fail as failWith, reportSkipped, ROOT } from "./blendExport";

export const MODELS_SRC = join(ROOT, "assets-src", "models");
const TAG = "[model]";
function fail(msg: string): never {
  return failWith(TAG, msg);
}

const usage = "usage: bun run model:export <model> [--blender PATH] [--raw] [--no-cache] [--stale-occlusion]";
const args = exportArgs(process.argv.slice(2), TAG, usage);
const known = (): string =>
  existsSync(MODELS_SRC)
    ? readdirSync(MODELS_SRC).filter((f) => f.endsWith(".blend")).map((f) => f.slice(0, -".blend".length)).join(", ") || "none"
    : "none";
const model = args.positional ?? fail(`${usage}\nmodels: ${known()}`);
if (!isModelName(model)) fail(`"${model}" is not a model name (lower-case letters, digits and dashes)`);
const blend = join(MODELS_SRC, `${model}.blend`);
if (!existsSync(blend)) fail(`no ${relative(ROOT, blend)} (models: ${known()})`);

const shipped = join(ROOT, "public", modelFile(model).slice(1));
const metaPath = join(ROOT, "public", modelMetaFile(model).slice(1));

console.log(`${TAG} exporting ${relative(ROOT, blend)}`);
const blenderMeta = await exportBlend({
  blend,
  shipped,
  tag: TAG,
  kind: "model",
  name: model,
  allSeen: true,
  raw: args.raw,
  noCache: args.noCache,
  staleOcclusion: args.staleOcclusion,
  blender: args.blender,
});

// The model's extent: every node's bounds together, in the model's own frame
// (Blender's world, which IS the model's frame: its origin is what a level
// places).
let bounds: ModelMeta["bounds"] = null;
for (const n of blenderMeta.nodes) {
  if (!bounds) bounds = { min: [...n.bounds.min], max: [...n.bounds.max] };
  else {
    for (let k = 0; k < 3; k++) {
      bounds.min[k] = Math.min(bounds.min[k]!, n.bounds.min[k]!);
      bounds.max[k] = Math.max(bounds.max[k]!, n.bounds.max[k]!);
    }
  }
}

const bytes = readFileSync(shipped);
const meta: ModelMeta = {
  model,
  source: relative(ROOT, blend),
  sourceSha256: createHash("sha256").update(readFileSync(blend)).digest("hex"),
  exportedAt: new Date().toISOString(),
  blender: blenderMeta.blender,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  triangles: blenderMeta.nodes.reduce((t, n) => t + n.triangles, 0),
  nodes: blenderMeta.nodes,
  bounds,
  skipped: blenderMeta.skipped,
  warnings: blenderMeta.warnings,
  credits: blenderMeta.credits,
};
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

const kb = (statSync(shipped).size / 1024).toFixed(0);
const size = bounds ? bounds.max.map((v, k) => (v - bounds!.min[k]!).toFixed(2)).join(" x ") : "-";
console.log(`${TAG} ${relative(ROOT, shipped)}: ${kb} KB, ${meta.nodes.length} objects, ${meta.triangles.toLocaleString()} triangles, ${size} m`);
reportSkipped(TAG, meta.skipped);
for (const c of meta.credits) console.log(`${TAG} credits ${c.name}: "${c.author}", ${c.source}, ${c.license}`);
for (const w of meta.warnings) console.log(`${TAG} WARNING ${w}`);
if (!meta.nodes.length) fail(`${relative(ROOT, blend)} exported nothing: a model needs at least one object with geometry that is not a guide, linked or hidden in render`);
console.log(
  MODEL_ASSETS[model]?.sha256 === meta.sha256
    ? `${TAG} published: this export is the one the store pins`
    : `${TAG} not published: refresh the browser to see it; \`just publish\` before committing a level that carries it`,
);
