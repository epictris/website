// Export a level's Blender scene into the game (`just scene <level>`).
//
//   bun run scene:export <level> [--blender PATH] [--raw] [--no-cache] [--stale-occlusion]
//
// The level's `scene` names `assets-src/scenes/<scene>.blend`. Headless
// Blender runs `tools/blender/scene_export.py` over it (every object with
// geometry that is not a guide, linked or hidden in render, world transforms
// kept), the pinned prop pipeline optimises the result with its node names
// and parenting kept (`assets:optimize --keep-nodes --keep-hierarchy`), and
// what lands is
//
//   public/scenes/<scene>/scene.glb     what the game draws
//   public/scenes/<scene>/meta.json     what was exported, and how it binds
//
// Then refresh the browser. The level file is not touched: binding is by
// name, and the names are authored in the editor (docs/blender-scenes.md).
// Running Blender, optimising and checking what ships is `blendExport.ts`,
// which `just model` shares.
//
// `--raw` skips the optimiser and ships Blender's own file, for telling an
// optimiser problem from an export one. Never publish one.
//
// An object whose prepared mesh and baked maps are in the bake cache
// (`.cache/scene-bake/<scene>/`, tools/blender/bake_cache.py) is neither
// prepared nor baked again, and a map whose encode is in the encode cache
// (`.cache/scene-encode/<scene>/`, scripts/encode-textures.mjs) is not
// encoded again; `--no-cache` does every one afresh and leaves both caches
// alone (each one's key is in its file).
//
// `--stale-occlusion` keeps an object's cached maps when only its neighbours
// changed (a rock added or moved within its occlusion reach): it ships the
// occlusion of its last bake, so the export names each one in its warnings,
// and the next export without the flag re-bakes them.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { nodeNameOf, isSceneName, SCENE_ASSETS, sceneFile, sceneMetaFile, type SceneMeta } from "../src/render3d/scenes";
import type { LevelBodyData } from "../src/level/levelFormat";
import { exportArgs, exportBlend, fail as failWith, reportSkipped, ROOT } from "./blendExport";

const SCENES_SRC = join(ROOT, "assets-src", "scenes");
const TAG = "[scene]";
function fail(msg: string): never {
  return failWith(TAG, msg);
}

const usage = "usage: bun run scene:export <level> [--blender PATH] [--raw] [--no-cache] [--stale-occlusion] [--source FILE.blend]";
// An explicit generated source avoids silently exporting a stale sibling file.
const argv = process.argv.slice(2);
const sourceIndex = argv.indexOf("--source");
let sourceBlend: string | undefined;
if (sourceIndex >= 0) {
  const value = argv[sourceIndex + 1];
  if (!value || value.startsWith("--")) fail("--source needs a .blend file path");
  sourceBlend = resolve(value);
  argv.splice(sourceIndex, 2);
}
const args = exportArgs(argv, TAG, usage);
const levelArg = args.positional ?? fail(usage);
const levelPath = levelArg.endsWith(".json") ? resolve(levelArg) : join(ROOT, "levels", `${levelArg}.json`);
if (!existsSync(levelPath)) fail(`no level at ${levelPath}`);
const levelName = basename(levelPath, ".json");

interface RawLevel {
  scene?: string;
  bodies: LevelBodyData[];
}
const level = JSON.parse(readFileSync(levelPath, "utf8")) as RawLevel;
const scene = level.scene;
if (!scene) fail(`${levelName} names no scene: set one in the editor's Level panel (\`scene\`), then \`just scene-guide ${levelName}\``);
if (!isSceneName(scene)) fail(`"${scene}" is not a scene name (lower-case letters, digits and dashes)`);

const blend = sourceBlend ?? join(SCENES_SRC, `${scene}.blend`);
if (!existsSync(blend)) {
  fail(`no ${relative(ROOT, blend)}; \`just scene-guide ${levelName}\` creates it with the level's collision linked as a guide`);
}

const shipped = join(ROOT, "public", sceneFile(scene).slice(1));
const metaPath = join(ROOT, "public", sceneMetaFile(scene).slice(1));

console.log(`${TAG} exporting ${relative(ROOT, blend)} for ${levelName}`);
const blenderMeta = await exportBlend({
  blend,
  shipped,
  tag: TAG,
  kind: "scene",
  name: scene,
  allSeen: false,
  raw: args.raw,
  noCache: args.noCache,
  staleOcclusion: args.staleOcclusion,
  blender: args.blender,
  dynamicNodes: level.bodies.filter((b) => b.kind === "rigid" || b.swingAmp || b.spinPeriod || b.moveSpeed ||
    b.objects.some((o) => o.type === "collision" && o.root))
    .flatMap((b) => b.name ? [nodeNameOf(b.name)] : []),
});

// The meta: Blender's account, the shipped file's facts, and the binding
// against the level as it stands now.
const bytes = readFileSync(shipped);
const bodyNodes = new Map<string, string>(); // node name -> body name
for (const b of level.bodies) if (b.name) bodyNodes.set(nodeNameOf(b.name), b.name);
const bound: string[] = [];
const scenery: string[] = [];
for (const n of blenderMeta.nodes) (bodyNodes.has(n.node) ? bound : scenery).push(n.node);
const unbound = [...bodyNodes.keys()].filter((node) => !bound.includes(node));
const meta: SceneMeta = {
  scene,
  level: levelName,
  source: relative(ROOT, blend),
  sourceSha256: createHash("sha256").update(readFileSync(blend)).digest("hex"),
  exportedAt: new Date().toISOString(),
  blender: blenderMeta.blender,
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  triangles: blenderMeta.nodes.reduce((t, n) => t + n.triangles, 0),
  nodes: blenderMeta.nodes,
  skipped: blenderMeta.skipped,
  warnings: blenderMeta.warnings,
  credits: blenderMeta.credits,
  bound,
  scenery,
  unbound,
};
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

const kb = (statSync(shipped).size / 1024).toFixed(0);
console.log(`${TAG} ${relative(ROOT, shipped)}: ${kb} KB, ${meta.nodes.length} objects, ${meta.triangles.toLocaleString()} triangles`);
console.log(`${TAG} on bodies (${bound.length}): ${bound.join(", ") || "-"}`);
console.log(`${TAG} scenery (${scenery.length}): ${scenery.join(", ") || "-"}`);
if (unbound.length) {
  console.log(`${TAG} named in the level, not in the scene (${unbound.length}): ${unbound.map((n) => bodyNodes.get(n)).join(", ")}`);
}
reportSkipped(TAG, meta.skipped);
for (const c of meta.credits) console.log(`${TAG} credits ${c.name}: "${c.author}", ${c.source}, ${c.license}`);
for (const w of meta.warnings) console.log(`${TAG} WARNING ${w}`);
const pinned = SCENE_ASSETS[scene];
console.log(
  pinned?.sha256 === meta.sha256
    ? `${TAG} published: this export is the one the store pins`
    : `${TAG} not published: refresh the browser to see it; \`just publish\` before committing a level that shows it`,
);
