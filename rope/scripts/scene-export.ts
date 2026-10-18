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

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { nodeNameOf, isSceneName, SCENE_ASSETS, sceneFile, sceneMetaFile, type SceneMeta, type SceneNodeMeta } from "../src/render3d/scenes";
import { StepProgress } from "./stepProgress";

const ROOT = resolve(import.meta.dirname, "..");
const SCENES_SRC = join(ROOT, "assets-src", "scenes");

function fail(msg: string): never {
  console.error(`[scene] ${msg}`);
  process.exit(1);
}

interface Run {
  status: number | null;
  // The signal that stopped it, when one did (Ctrl-C, a kill).
  signal?: NodeJS.Signals;
  error?: Error;
  stdout: string;
  stderr: string;
}

/** Run `cmd`, handing each line of its stdout to `onLine` as it comes (a
 * spawnSync says nothing until the export is over, minutes later). */
function stream(cmd: string, argv: string[], onLine: (line: string) => void): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const line of lines) onLine(line);
    });
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => done({ status: null, error, stdout, stderr }));
    child.on("close", (status, signal) => {
      if (partial) onLine(partial);
      done({ status, signal: signal ?? undefined, stdout, stderr });
    });
  });
}

/** The name and type of every image in the GLB at `path`. */
function glbImages(path: string): { name?: string; mimeType?: string }[] {
  const glb = readFileSync(path);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as { images?: { name?: string; mimeType?: string }[] };
  return json.images ?? [];
}

const args = process.argv.slice(2);
const bare =new Set(["--raw", "--no-cache", "--stale-occlusion"]);
const valued = new Set(["--blender"]);
const usage = "usage: bun run scene:export <level> [--blender PATH] [--raw] [--no-cache] [--stale-occlusion]";
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && !bare.has(args[i - 1]!)),
);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// Levenshtein distance, for naming the flag a typo meant.
const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
};
for (const a of args) {
  if (!a.startsWith("--") || bare.has(a) || valued.has(a)) continue;
  const near = [...bare, ...valued].filter((f) => distance(a, f) <= 2);
  fail(`unknown flag ${a}${near.length ? ` (did you mean ${near.join(" or ")}?)` : ""}\n${usage}`);
}
if (args.includes("--no-cache") && args.includes("--stale-occlusion")) fail("--stale-occlusion reads the bake cache, which --no-cache leaves alone");
const levelArg = positional[0] ?? fail(usage);
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
// fail() exits without unwinding the `finally` below, and Ctrl-C without
// even the exit hook unless it is caught (below, once the steps are drawn;
// Blender, in the same process group, gets the Ctrl-C itself).
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
try {
  const raw = join(scratch, "raw.glb");
  const rawMeta = join(scratch, "meta.json");
  // The optimiser's file, shipped only once every check below has passed.
  const optimised = join(scratch, "scene.glb");
  const blenderLog = join(ROOT, ".cache", "scene-export", `${scene}.blender.log`);
  console.log(`[scene] exporting ${relative(ROOT, blend)} for ${levelName}`);
  // The export's steps in order; scene_export.py starts grow, bake and gltf
  // by these ids (its `step()`).
  const STEPS = [
    { id: "open", label: `start Blender, open ${scene}.blend` },
    { id: "grow", label: "grow ivy, moss and foliage" },
    { id: "bake", label: "bake textures" },
    { id: "gltf", label: "write glTF" },
    { id: "optimise", label: "optimise" },
    { id: "encode", label: "encode textures" },
  ];
  const progress = new StepProgress("[scene]", STEPS);
  process.on("SIGINT", () => {
    progress.fail();
    process.exit(130);
  });
  progress.start("open");
  const run = await stream(
    blender,
    ["-b", blend, "--factory-startup", "--python-exit-code", "1", "--python", join(ROOT, "tools", "blender", "scene_export.py"), "--", raw, rawMeta, ...(args.includes("--no-cache") ? [] : ["--cache", join(ROOT, ".cache", "scene-bake", scene)]), ...(args.includes("--stale-occlusion") ? ["--stale-occlusion"] : [])],
    (line) => {
      const marker = /^\[scene_step\] (.*)$/.exec(line);
      if (marker) {
        const { step, note } = JSON.parse(marker[1]!) as { step: string; note: string | null };
        progress.start(step, note ?? undefined);
      } else if (line.startsWith("[scene_export]")) progress.log(line);
    },
  );
  // Everything Blender said, kept: the steps show only the export's own
  // lines, and a bake that went wrong on the device (a black map, 2026-10-18)
  // says why in Cycles' lines, which went nowhere before.
  mkdirSync(dirname(blenderLog), { recursive: true });
  writeFileSync(blenderLog, `${run.stdout}\n--- stderr ---\n${run.stderr}`);
  if (run.error) {
    progress.fail();
    fail(`could not run ${blender}: ${run.error.message} (install Blender 5.2, or name it with --blender or BLENDER_PATH)`);
  }
  if (run.signal) {
    progress.fail();
    fail(`Blender was stopped (${run.signal}); nothing shipped`);
  }
  if (run.status !== 0 || !existsSync(raw) || !existsSync(rawMeta)) {
    progress.fail();
    console.error(run.stderr);
    const err = run.stdout.split("\n").filter((l) => /Error|Traceback|nothing to export/.test(l)).slice(-5);
    fail(`Blender wrote nothing (exit ${run.status}): ${err.join(" | ") || "see above"}; its whole output is in ${relative(ROOT, blenderLog)}`);
  }

  if (args.includes("--raw")) {
    progress.skip("optimise", "--raw");
    progress.skip("encode", "--raw");
    progress.finish();
    writeFileSync(shipped, readFileSync(raw));
    console.log(`[scene] --raw: shipped Blender's own file, unoptimised`);
  } else {
    progress.start("optimise");
    const opt = await stream(
      "bun",
      [
        "run", join(ROOT, "scripts", "optimize-asset.ts"), raw, optimised, "--keep-nodes", "--keep-hierarchy", "--baked-maps",
        ...(args.includes("--no-cache") ? [] : ["--texture-cache", join(ROOT, ".cache", "scene-encode", scene)]),
      ],
      (line) => {
        // encode-textures.mjs counting its maps as they land.
        const encoding = /^\[assets\] encoding textures: (\d+) of (\d+) done$/.exec(line);
        if (encoding) progress.start("encode", `${encoding[1]} of ${encoding[2]} maps`);
        // The optimiser's own summary lines, and none of its MESH_ASSETS
        // advice, which is for a prop.
        else if (/^\[assets\] \d/.test(line)) progress.log(line.replace("[assets]", "[scene]"));
      },
    );
    if (opt.signal) {
      progress.fail();
      fail(`the optimiser was stopped (${opt.signal}); nothing shipped`);
    }
    if (opt.status !== 0) {
      progress.fail();
      console.error(opt.stderr);
      fail("the optimiser failed; `--raw` ships Blender's file as is, to tell whose problem it is");
    }
    progress.finish();
    // Every map Blender baked must be encoded as one: the optimiser finds them
    // by name, and a baked map it misses goes out as lossy WebP at 1k without
    // a word (the four dotted Terraces did until 2026-10-04).
    const baked = /ships (\d+) colour and (\d+) normal maps/.exec(run.stdout);
    const encoded = (kind: string) => Number(new RegExp(`^\\[assets\\] (\\d+) texture\\(s\\): baked ${kind}`, "m").exec(opt.stdout)?.[1] ?? 0);
    if (baked && (encoded("colour") !== Number(baked[1]) || encoded("normal") !== Number(baked[2]))) {
      // By name: the glTF exporter shortens a dotted image name (the rule's
      // miss, shipped at 1k), and drops a one-colour image for a factor (the
      // empty bake of 2026-10-18, shipped black).
      const expected = (JSON.parse(readFileSync(rawMeta, "utf8")) as { baked_maps?: string[] }).baked_maps ?? [];
      const encodedNames = new Set(glbImages(optimised).filter((im) => im.mimeType === "image/avif").map((im) => im.name));
      const missing = expected.filter((name) => !encodedNames.has(name));
      fail(`Blender shipped ${baked[1]} colour and ${baked[2]} normal maps (baked or from its cache) but the optimiser encoded ${encoded("colour")} and ${encoded("normal")} as baked maps; not encoded as one: ${missing.join(", ") || "(none by name)"}. Nothing shipped; Blender's output is in ${relative(ROOT, blenderLog)}`);
    }
    // And every picture (scene_export.py `prepare_pictures`) as one, by the
    // same name rule, or it ships lossy at 1k: the blocks it was made to end.
    const pictures = Number(/ (\d+) pictures, /.exec(run.stdout)?.[1] ?? 0);
    const lossless = Number(/^\[assets\] (\d+) texture\(s\): picture/m.exec(opt.stdout)?.[1] ?? 0);
    if (lossless !== pictures) {
      fail(`Blender shipped ${pictures} pictures but the optimiser encoded ${lossless} as pictures; the rest would ship lossy at 1k (an image name the glTF exporter cut short?). Nothing shipped`);
    }
    // Only now, checked: a file that failed a check never reaches the game.
    copyFileSync(optimised, shipped);
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
  console.log(`[scene] ${relative(ROOT, shipped)}: ${kb} KB, ${meta.nodes.length} objects, ${meta.triangles.toLocaleString()} triangles`);
  console.log(`[scene] on bodies (${bound.length}): ${bound.join(", ") || "-"}`);
  console.log(`[scene] scenery (${scenery.length}): ${scenery.join(", ") || "-"}`);
  if (unbound.length) {
    console.log(`[scene] named in the level, not in the scene (${unbound.length}): ${unbound.map((n) => bodyNodes.get(n)).join(", ")}`);
  }
  // The guide is dozens of linked objects and one fact, and so is a tree of
  // excluded collections (the formations' Sources held 947 objects in the
  // river, 2026-10-07: a thousand lines that buried the rest): counted per top
  // collection, its name up to the first " / ". Every other reason two objects
  // share is counted too. A hidden object, the one an author looks for, is
  // always named.
  const linked = meta.skipped.filter((s) => s.reason.startsWith("linked from") || s.reason.startsWith("data linked from"));
  if (linked.length) console.log(`[scene] skipped ${linked.length} linked objects (${[...new Set(linked.map((s) => s.reason))].join("; ")})`);
  const groups = new Map<string, typeof meta.skipped>();
  for (const s of meta.skipped) {
    if (linked.includes(s)) continue;
    const key = s.reason.startsWith("in collection ") ? s.reason.split(" / ")[0]! : s.reason;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [reason, skipped] of groups) {
    if (skipped.length === 1 || reason === "hidden in render") {
      for (const s of skipped) console.log(`[scene] skipped ${s.name}: ${s.reason}`);
    } else if (reason.startsWith("in collection ")) {
      const collections = new Set(skipped.map((s) => s.reason)).size;
      console.log(`[scene] skipped ${skipped.length} objects ${reason}${collections > 1 ? ` (${collections} collections)` : ""}`);
    } else {
      console.log(`[scene] skipped ${skipped.length} objects: ${reason}`);
    }
  }
  for (const c of meta.credits) console.log(`[scene] credits ${c.name}: "${c.author}", ${c.source}, ${c.license}`);
  for (const w of meta.warnings) console.log(`[scene] WARNING ${w}`);
  const pinned = SCENE_ASSETS[scene];
  console.log(
    pinned?.sha256 === meta.sha256
      ? `[scene] published: this export is the one the store pins`
      : `[scene] not published: refresh the browser to see it; \`just publish\` before committing a level that shows it`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
