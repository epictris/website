// Export a level's Blender scene into the game (`just scene <level>`).
//
//   bun run scene:export <level> [--blender PATH] [--raw]
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
//
// `--raw` skips the optimiser and ships Blender's own file, for telling an
// optimiser problem from an export one. Never publish one.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { nodeNameOf, isSceneName, SCENE_ASSETS, sceneFile, sceneMetaFile, type SceneMeta, type SceneNodeMeta } from "../src/render3d/scenes";

const ROOT = resolve(import.meta.dirname, "..");
const SCENES_SRC = join(ROOT, "assets-src", "scenes");

function fail(msg: string): never {
  console.error(`[scene] ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const bare = new Set(["--raw"]);
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && !bare.has(args[i - 1]!)),
);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const levelArg = positional[0] ?? fail("usage: bun run scene:export <level> [--blender PATH] [--raw]");
const levelPath = levelArg.endsWith(".json") ? resolve(levelArg) : join(ROOT, "levels", `${levelArg}.json`);
if (!existsSync(levelPath)) fail(`no level at ${levelPath}`);
const levelName = basename(levelPath, ".json");

interface RawLevel {
  scene?: string;
  bodies: { name?: string }[];
}
const level = JSON.parse(readFileSync(levelPath, "utf8")) as RawLevel;
const scene = level.scene;
if (!scene) fail(`${levelName} names no scene: set one in the editor's Level panel (\`scene\`), then \`just scene-guide ${levelName}\``);
if (!isSceneName(scene)) fail(`"${scene}" is not a scene name (lower-case letters, digits and dashes)`);

const blend = join(SCENES_SRC, `${scene}.blend`);
if (!existsSync(blend)) {
  fail(`no ${relative(ROOT, blend)}; \`just scene-guide ${levelName}\` creates it with the level's collision linked as a guide`);
}

const blender = flag("blender") ?? process.env["BLENDER_PATH"] ?? process.env["BLENDER"] ?? "blender";
const outDir = join(ROOT, "public", "scenes", scene);
mkdirSync(outDir, { recursive: true });
const shipped = join(ROOT, "public", sceneFile(scene).slice(1));
const metaPath = join(ROOT, "public", sceneMetaFile(scene).slice(1));

const scratch = mkdtempSync(join(tmpdir(), "scene-export-"));
try {
  const raw = join(scratch, "raw.glb");
  const rawMeta = join(scratch, "meta.json");
  const t0 = Date.now();
  const run = spawnSync(
    blender,
    ["-b", blend, "--factory-startup", "--python-exit-code", "1", "--python", join(ROOT, "tools", "blender", "scene_export.py"), "--", raw, rawMeta],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error) fail(`could not run ${blender}: ${run.error.message} (install Blender 5.2, or name it with --blender or BLENDER_PATH)`);
  for (const line of run.stdout.split("\n")) if (line.startsWith("[scene_export]")) console.log(line);
  if (run.status !== 0 || !existsSync(raw) || !existsSync(rawMeta)) {
    console.error(run.stderr);
    const err = run.stdout.split("\n").filter((l) => /Error|Traceback|nothing to export/.test(l)).slice(-5);
    fail(`Blender wrote nothing (exit ${run.status}): ${err.join(" | ") || "see above"}`);
  }
  const blenderSecs = ((Date.now() - t0) / 1000).toFixed(1);

  if (args.includes("--raw")) {
    writeFileSync(shipped, readFileSync(raw));
    console.log(`[scene] --raw: shipped Blender's own file, unoptimised`);
  } else {
    const opt = spawnSync("bun", ["run", join(ROOT, "scripts", "optimize-asset.ts"), raw, shipped, "--keep-nodes", "--keep-hierarchy"], {
      encoding: "utf8",
    });
    // The optimiser's own summary line, and none of its MESH_ASSETS advice,
    // which is for a prop.
    for (const line of opt.stdout.split("\n")) if (/^\[assets\] \d/.test(line)) console.log(line.replace("[assets]", "[scene]"));
    if (opt.status !== 0) {
      console.error(opt.stderr);
      fail("the optimiser failed; `--raw` ships Blender's file as is, to tell whose problem it is");
    }
  }

  // The meta: Blender's account, the shipped file's facts, and the binding
  // against the level as it stands now.
  const blenderMeta = JSON.parse(readFileSync(rawMeta, "utf8")) as Pick<SceneMeta, "blender" | "nodes" | "skipped" | "warnings" | "credits">;
  const bytes = readFileSync(shipped);
  const bodyNodes = new Map<string, string>(); // node name -> body name
  for (const b of level.bodies) if (b.name) bodyNodes.set(nodeNameOf(b.name), b.name);
  const bound: string[] = [];
  const scenery: string[] = [];
  for (const n of blenderMeta.nodes as SceneNodeMeta[]) (bodyNodes.has(n.node) ? bound : scenery).push(n.node);
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
  console.log(`[scene] ${relative(ROOT, shipped)}: ${kb} KB, ${meta.nodes.length} objects, ${meta.triangles.toLocaleString()} triangles (Blender ${blenderSecs}s)`);
  console.log(`[scene] on bodies (${bound.length}): ${bound.join(", ") || "-"}`);
  console.log(`[scene] scenery (${scenery.length}): ${scenery.join(", ") || "-"}`);
  if (unbound.length) {
    console.log(`[scene] named in the level, not in the scene (${unbound.length}): ${unbound.map((n) => bodyNodes.get(n)).join(", ")}`);
  }
  // The guide is dozens of linked objects and one fact; everything else
  // skipped is named, since a hidden object is the one an author looks for.
  const linked = meta.skipped.filter((s) => s.reason.startsWith("linked from") || s.reason.startsWith("data linked from"));
  if (linked.length) console.log(`[scene] skipped ${linked.length} linked objects (${[...new Set(linked.map((s) => s.reason))].join("; ")})`);
  for (const s of meta.skipped) if (!linked.includes(s)) console.log(`[scene] skipped ${s.name}: ${s.reason}`);
  for (const c of meta.credits) console.log(`[scene] credits ${c.name}: "${c.author}", ${c.source}, ${c.license}`);
  for (const w of meta.warnings) console.log(`[scene] WARNING ${w}`);
  if (meta.bytes > 8 * 1024 * 1024) {
    console.log(`[scene] WARNING ${kb} KB is over the store's 8 MB per-file bar (docs/asset-store.md); split the scene or thin it`);
  }
  const pinned = SCENE_ASSETS[scene];
  console.log(
    pinned?.sha256 === meta.sha256
      ? `[scene] published: this export is the one the store pins`
      : `[scene] not published: refresh the browser to see it; \`just publish\` before committing a level that shows it`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
