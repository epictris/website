// One `.blend` through `tools/blender/scene_export.py` and the optimiser into
// the one GLB the game loads: the half of `just scene` and `just model` that
// does not know which of them it is (see scripts/scene-export.ts,
// scripts/model-export.ts, docs/blender-scenes.md and docs/blender-models.md).
//
// Headless Blender exports every shippable object with its world transform
// (and bakes what glTF cannot carry), the pinned prop pipeline optimises the
// result with its node names and parenting kept (`assets:optimize --keep-nodes
// --keep-hierarchy --baked-maps`), and the file is shipped only once every
// check here has passed. What the caller gets back is Blender's own account of
// the export, to write its own `meta.json` from.
//
// An object whose prepared mesh and baked maps are in the bake cache is neither
// prepared nor baked again, and a map whose encode is in the encode cache is
// not encoded again; `noCache` does every one afresh and leaves both caches
// alone (each one's key is in its file).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DOF_MAX_BLUR, FOCUS_BAND } from "../src/render3d/depthOfField";
import type { SceneCredit, SceneNodeMeta } from "../src/render3d/scenes";
import { validateBakedField } from "../src/render3d/bakedLighting";
import { StepProgress } from "./stepProgress";
import { constantColourMaps } from "./bakedMapValidation";

export const ROOT = resolve(import.meta.dirname, "..");

// What `scene_export.py` writes into its meta: the half of a scene's or a
// model's `meta.json` that is Blender's.
export interface BlenderMeta {
  blender: string;
  nodes: SceneNodeMeta[];
  skipped: { name: string; reason: string }[];
  warnings: string[];
  credits: SceneCredit[];
  baked_maps?: string[];
  lighting?: { lightmaps: number; probes: number };
}

export interface BlendExport {
  dynamicNodes?: string[];
  // The `.blend` to export.
  blend: string;
  // Where the shipped GLB goes.
  shipped: string;
  // What it is, for the log and the steps (`[scene]`, `[model]`), and the
  // name its caches and Blender log are kept under.
  tag: string;
  kind: "scene" | "model";
  name: string;
  // Every face counts as seen by the game camera when the unwrap shares out
  // the texels (`scene_export.py --all-seen`): a model may be turned to show
  // any side of itself, where a scene's rock stands facing the camera.
  allSeen: boolean;
  raw: boolean;
  noCache: boolean;
  staleOcclusion: boolean;
  blender: string;
}

export function fail(tag: string, msg: string): never {
  console.error(`${tag} ${msg}`);
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
function stream(cmd: string, argv: string[], onLine: (line: string) => void, env?: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env });
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

interface GlbImage {
  name?: string;
  mimeType?: string;
  // The sha256 of its bytes in the binary chunk.
  sha256: string;
}

/** Every image in the GLB at `path`: its name, its type and its bytes' hash. */
function glbImages(path: string): GlbImage[] {
  const glb = readFileSync(path);
  const length = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + length).toString("utf8")) as {
    images?: { name?: string; mimeType?: string; bufferView?: number }[];
    bufferViews?: { byteOffset?: number; byteLength: number }[];
  };
  const bin = glb.subarray(28 + length);
  return (json.images ?? []).map((im) => {
    const view = im.bufferView !== undefined ? json.bufferViews?.[im.bufferView] : undefined;
    const bytes = view ? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength) : new Uint8Array();
    return { name: im.name, mimeType: im.mimeType, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

function checkLighting(path: string, expected: BlenderMeta["lighting"]): void {
  if (!expected || (!expected.lightmaps && !expected.probes)) return;
  const bytes = readFileSync(path);
  const doc = JSON.parse(bytes.subarray(20, 20+bytes.readUInt32LE(12)).toString("utf8"));
  if (expected.probes) {
    const field = validateBakedField(doc.scenes?.[doc.scene ?? 0]?.extras?.gameBakedLighting);
    if (field.size.reduce((a,b)=>a*b,1) !== expected.probes) throw new Error("Baked probe count changed during export");
  }
  if (expected.lightmaps && !doc.materials?.some((m: {extras?: {gameBakedLighting?: unknown}}) => m.extras?.gameBakedLighting)) {
    throw new Error("Baked lightmap metadata was lost during export");
  }
}

// Levenshtein distance, for naming the flag a typo meant.
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

// The export flags both recipes take, read off `args`; the one positional
// argument is the caller's (a level, a model).
export interface ExportArgs {
  positional: string | undefined;
  raw: boolean;
  noCache: boolean;
  staleOcclusion: boolean;
  blender: string;
}

export function exportArgs(args: string[], tag: string, usage: string): ExportArgs {
  const bare = new Set(["--raw", "--no-cache", "--stale-occlusion"]);
  const valued = new Set(["--blender"]);
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && !bare.has(args[i - 1]!)),
  );
  for (const a of args) {
    if (!a.startsWith("--") || bare.has(a) || valued.has(a)) continue;
    const near = [...bare, ...valued].filter((f) => distance(a, f) <= 2);
    fail(tag, `unknown flag ${a}${near.length ? ` (did you mean ${near.join(" or ")}?)` : ""}\n${usage}`);
  }
  if (args.includes("--no-cache") && args.includes("--stale-occlusion")) fail(tag, "--stale-occlusion reads the bake cache, which --no-cache leaves alone");
  const i = args.indexOf("--blender");
  return {
    positional: positional[0],
    raw: args.includes("--raw"),
    noCache: args.includes("--no-cache"),
    staleOcclusion: args.includes("--stale-occlusion"),
    blender: (i >= 0 ? args[i + 1] : undefined) ?? process.env["BLENDER_PATH"] ?? process.env["BLENDER"] ?? "blender",
  };
}

// Export `opts.blend` and ship it to `opts.shipped`. Returns Blender's meta;
// exits the process on any failure, having shipped nothing.
export async function exportBlend(opts: BlendExport): Promise<BlenderMeta> {
  const { tag, name } = opts;
  // Large lightmap tile buffers and worker snapshots can exhaust a RAM-backed
  // /tmp. Keep export scratch on the project drive, including Blender workers.
  const exportTemp = join(ROOT, ".cache", "export-tmp");
  mkdirSync(exportTemp, { recursive: true });
  const scratch = mkdtempSync(join(exportTemp, `${opts.kind}-export-`));
  let shipped = false;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (!shipped && existsSync(join(scratch, "raw.glb"))) {
      console.error(`${tag} retained baked scene for recovery: ${scratch}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  // fail() exits without unwinding the `finally` below, and Ctrl-C without
  // even the exit hook unless it is caught (below, once the steps are drawn;
  // Blender, in the same process group, gets the Ctrl-C itself).
  process.on("exit", cleanup);
  try {
    mkdirSync(dirname(opts.shipped), { recursive: true });
    const raw = join(scratch, "raw.glb");
    const rawMeta = join(scratch, "meta.json");
    // The optimiser's file, shipped only once every check below has passed.
    const optimised = join(scratch, "export.glb");
    const blenderLog = join(ROOT, ".cache", `${opts.kind}-export`, `${name}.blender.log`);
    // The export's steps in order; scene_export.py starts grow, bake and gltf
    // by these ids (its `step()`).
    const STEPS = [
      { id: "open", label: `start Blender, open ${relative(ROOT, opts.blend)}` },
      { id: "grow", label: "grow ivy, moss and foliage" },
      { id: "bake", label: "bake textures" },
      { id: "lighting", label: "bake mesh emission (Cycles)" },
      { id: "gltf", label: "write glTF" },
      { id: "optimise", label: "optimise" },
      { id: "encode", label: "encode textures" },
    ];
    const progress = new StepProgress(tag, STEPS);
    process.on("SIGINT", () => {
      progress.fail();
      process.exit(130);
    });
    progress.start("open");
    const resume = process.env["SCENE_EXPORT_RESUME_DIR"];
    const run: Run = resume ? (() => {
      copyFileSync(join(resume, "raw.glb"), raw);
      copyFileSync(join(resume, "meta.json"), rawMeta);
      const stdout = readFileSync(join(resume, "blender.log"), "utf8");
      console.log(`${tag} resuming completed Blender output from ${resume}`);
      for (const { id } of STEPS.slice(0, 5)) progress.skip(id, "retained bake");
      return { status: 0, stdout, stderr: "" };
    })() : await stream(
      opts.blender,
      [
        "-b", opts.blend, "--factory-startup", "--python-exit-code", "1",
        "--python", join(ROOT, "tools", "blender", "scene_export.py"), "--", raw, rawMeta,
        ...(opts.allSeen ? ["--all-seen"] : []),
        ...(opts.noCache ? [] : ["--cache", join(ROOT, ".cache", `${opts.kind}-bake`, name)]),
        ...(opts.staleOcclusion ? ["--stale-occlusion"] : []),
      ],
      (line) => {
        const marker = /^\[scene_step\] (.*)$/.exec(line);
        if (marker) {
          const { step, note } = JSON.parse(marker[1]!) as { step: string; note: string | null };
          progress.start(step, note ?? undefined);
        } else if (line.startsWith("[scene_export]")) progress.log(line);
      },
      // The finer detail passes add nothing the game's High depth of field
      // would blur away (formations/render.py `detail_blur`), with its numbers.
      { ...process.env, TMPDIR: exportTemp, SCENE_EXPORT_DOF: JSON.stringify({ maxBlur: DOF_MAX_BLUR.high, focusBand: FOCUS_BAND }),
        SCENE_EXPORT_EMISSION: opts.kind === "scene" ? "1" : "0",
        SCENE_EXPORT_DYNAMIC: JSON.stringify(opts.dynamicNodes ?? []),
      },
    );
    // Everything Blender said, kept: the steps show only the export's own
    // lines, and a bake that went wrong on the device (a black map, 2026-10-18)
    // says why in Cycles' lines, which went nowhere before.
    mkdirSync(dirname(blenderLog), { recursive: true });
    writeFileSync(blenderLog, `${run.stdout}\n--- stderr ---\n${run.stderr}`);
    writeFileSync(join(scratch, "blender.log"), run.stdout);
    if (run.error) {
      progress.fail();
      fail(tag, `could not run ${opts.blender}: ${run.error.message} (install Blender 5.2, or name it with --blender or BLENDER_PATH)`);
    }
    if (run.signal) {
      progress.fail();
      fail(tag, `Blender was stopped (${run.signal}); nothing shipped`);
    }
    if (run.status !== 0 || !existsSync(raw) || !existsSync(rawMeta)) {
      progress.fail();
      console.error(run.stderr);
      const err = run.stdout.split("\n").filter((l) => /Error|Traceback|nothing to export/.test(l)).slice(-5);
      fail(tag, `Blender wrote nothing (exit ${run.status}): ${err.join(" | ") || "see above"}; its whole output is in ${relative(ROOT, blenderLog)}`);
    }

    if (opts.raw) {
      checkLighting(raw, (JSON.parse(readFileSync(rawMeta, "utf8")) as BlenderMeta).lighting);
      progress.skip("optimise", "--raw");
      progress.skip("encode", "--raw");
      progress.finish();
      writeFileSync(opts.shipped, readFileSync(raw));
      console.log(`${tag} --raw: shipped Blender's own file, unoptimised`);
    } else {
      progress.start("optimise");
      const opt = await stream(
        "bun",
        [
          "run", join(ROOT, "scripts", "optimize-asset.ts"), raw, optimised, "--keep-nodes", "--keep-hierarchy", "--baked-maps",
          ...(opts.noCache ? [] : ["--texture-cache", join(ROOT, ".cache", `${opts.kind}-encode`, name)]),
        ],
        (line) => {
          // encode-textures.mjs counting its maps as they land.
          const encoding = /^\[assets\] encoding textures: (\d+) of (\d+) done$/.exec(line);
          if (encoding) progress.start("encode", `${encoding[1]} of ${encoding[2]} maps`);
          // The optimiser's own summary lines, and none of its MESH_ASSETS
          // advice, which is for a prop.
          else if (/^\[assets\] \d/.test(line)) progress.log(line.replace("[assets]", tag));
        },
      );
      if (opt.signal) {
        progress.fail();
        fail(tag, `the optimiser was stopped (${opt.signal}); nothing shipped`);
      }
      if (opt.status !== 0) {
        progress.fail();
        console.error(opt.stderr);
        fail(tag, "the optimiser failed; `--raw` ships Blender's file as is, to tell whose problem it is");
      }
      progress.finish();
      // Every map Blender baked must be encoded as one: the optimiser finds them
      // by name, and a baked map it misses goes out as lossy WebP at 1k without
      // a word (the four dotted Terraces did until 2026-10-04).
      //
      // By name: the glTF exporter shortens a dotted image name (the rule's
      // miss, shipped at 1k), and drops a one-colour image for a factor (the
      // empty bake of 2026-10-18, shipped black). A map whose bytes are another
      // encoded map's is not missing: the optimiser merges identical images,
      // and copies of one object baked in its own space (a model's four
      // posts, 2026-11-13) bake identical maps, which ship as one.
      const baked = /ships (\d+) colour and (\d+) normal maps/.exec(run.stdout);
      const encoded = (kind: string) => Number(new RegExp(`^\\[assets\\] (\\d+) texture\\(s\\): baked ${kind}`, "m").exec(opt.stdout)?.[1] ?? 0);
      if (baked) {
        const expected = (JSON.parse(readFileSync(rawMeta, "utf8")) as BlenderMeta).baked_maps ?? [];
        const rawHash = new Map(glbImages(raw).map((im) => [im.name, im.sha256]));
        const encodedNames = new Set(glbImages(optimised).filter((im) => im.mimeType === "image/avif").map((im) => im.name));
        const encodedHashes = new Set(expected.filter((map) => encodedNames.has(map)).map((map) => rawHash.get(map)));
        let missing = expected.filter((map) => !encodedNames.has(map) && !(rawHash.has(map) && encodedHashes.has(rawHash.get(map))));
        if (missing.length) {
          // A uniformly painted chunk may become a material factor. Verify
          // every pixel and the factor on the corresponding exported mesh;
          // accepting a missing name alone would conceal a lost/empty bake.
          const constants = await constantColourMaps(raw, optimised, missing);
          missing = missing.filter((map) => !constants.has(map));
        }
        if (missing.length) {
          fail(tag, `Blender shipped ${baked[1]} colour and ${baked[2]} normal maps (baked or from its cache) but the optimiser encoded ${encoded("colour")} and ${encoded("normal")} as baked maps; not encoded as one: ${missing.join(", ")}. Nothing shipped; Blender's output is in ${relative(ROOT, blenderLog)}`);
        }
      }
      // And every picture (scene_export.py `prepare_pictures`) as one, by the
      // same name rule, or it ships lossy at 1k: the blocks it was made to end.
      const pictures = Number(/ (\d+) pictures, /.exec(run.stdout)?.[1] ?? 0);
      const lossless = Number(/^\[assets\] (\d+) texture\(s\): picture/m.exec(opt.stdout)?.[1] ?? 0);
      if (lossless !== pictures) {
        fail(tag, `Blender shipped ${pictures} pictures but the optimiser encoded ${lossless} as pictures; the rest would ship lossy at 1k (an image name the glTF exporter cut short?). Nothing shipped`);
      }
      // Only now, checked: a file that failed a check never reaches the game.
      checkLighting(optimised, (JSON.parse(readFileSync(rawMeta, "utf8")) as BlenderMeta).lighting);
      copyFileSync(optimised, opts.shipped);
    }
    const meta = JSON.parse(readFileSync(rawMeta, "utf8")) as BlenderMeta;
    shipped = true;
    return meta;
  } finally {
    cleanup();
  }
}

// What both recipes print about what Blender left out: the guide is dozens of
// linked objects and one fact, and so is a tree of excluded collections (the
// formations' Sources held 947 objects in the river, 2026-10-07: a thousand
// lines that buried the rest), counted per top collection, its name up to the
// first " / ". Every other reason two objects share is counted too. A hidden
// object, the one an author looks for, is always named.
export function reportSkipped(tag: string, skippedList: { name: string; reason: string }[]): void {
  const linked = skippedList.filter((s) => s.reason.startsWith("linked from") || s.reason.startsWith("data linked from"));
  if (linked.length) console.log(`${tag} skipped ${linked.length} linked objects (${[...new Set(linked.map((s) => s.reason))].join("; ")})`);
  const groups = new Map<string, typeof skippedList>();
  for (const s of skippedList) {
    if (linked.includes(s)) continue;
    const key = s.reason.startsWith("in collection ") ? s.reason.split(" / ")[0]! : s.reason;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [reason, skipped] of groups) {
    if (skipped.length === 1 || reason === "hidden in render") {
      for (const s of skipped) console.log(`${tag} skipped ${s.name}: ${s.reason}`);
    } else if (reason.startsWith("in collection ")) {
      const collections = new Set(skipped.map((s) => s.reason)).size;
      console.log(`${tag} skipped ${skipped.length} objects ${reason}${collections > 1 ? ` (${collections} collections)` : ""}`);
    } else {
      console.log(`${tag} skipped ${skipped.length} objects: ${reason}`);
    }
  }
}
