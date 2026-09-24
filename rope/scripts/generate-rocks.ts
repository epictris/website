// Generate a level's rocks: `bun run assets:rocks <level> [--only 3,17] [--out f.glb]`
//
// Reads `levels/<level>.json`, lays its rock bodies out in world space
// (`src/render3d/rocks.ts`), and hands them to headless Blender
// (`tools/blender/rocks.py`), which writes `public/rocks/<level>.glb`. The game
// picks the file up by level name; a body whose outline has changed since the
// file was generated keeps its flat extrusion until this is run again (see
// docs/rocks.md).
//
// `--only` builds a subset of bodies (by index into the level's `bodies`) for a
// quick look at one rock while tuning the generator.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PIXELS_PER_METER } from "../src/engine/units";
import { scaleLevelData, type RawLevelData } from "../src/level/levelFormat";
import { rockBodies, rockFileId } from "../src/render3d/rocks";
import {
  checkRockFile,
  printBuildReport,
  printRockFileCheck,
  readBuildReport,
  reportPathOf,
  rockFileDefects,
} from "../src/tools/rockCheck";

const ROOT = resolve(import.meta.dirname, "..");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const USAGE =
  "usage: generate-rocks <level|levels/x.json> [--only i,j] [--out f.glb] [--flat] [--decimate R] [--scale S] [--remesh]\n" +
  "       [--no-check] [--no-debug-attributes] [--no-buried] [--no-cull] [--no-detail] [--no-inset] [--no-repair] [--seed N] [--dump-stages DIR]";
const levelArg = positional[0] ?? fail(USAGE);
const levelPath = levelArg.endsWith(".json") ? resolve(levelArg) : join(ROOT, "levels", `${levelArg}.json`);
if (!existsSync(levelPath)) fail(`no level at ${levelPath}`);
const name = basename(levelPath, ".json");

const raw = JSON.parse(readFileSync(levelPath, "utf8")) as RawLevelData;
const data = scaleLevelData(raw, 1 / PIXELS_PER_METER);
let bodies = rockBodies(data);

const only = flag("only");
if (only !== undefined) {
  const want = new Set(only.split(",").map((s) => Number(s.trim())));
  bodies = bodies.filter((b) => want.has(b.index));
  if (bodies.length === 0) fail(`--only ${only} names no rock body (rock bodies: ${rockBodies(data).map((b) => b.index).join(", ")})`);
}
if (bodies.length === 0) fail(`${name}: no rock bodies (nothing wears a rock texture)`);

const outDir = join(ROOT, "public", "rocks");
mkdirSync(outDir, { recursive: true });
const out = flag("out") ?? join(outDir, `${name}.glb`);

// The job carries only what the generator reads; the geometry objects the
// runtime keys on stay on this side.
// `--flat` skips the ambient-occlusion bake, the slow step, so the shape can be
// iterated on quickly (the runtime material treats a missing AO map as none);
// `--decimate R` replaces the default planar dissolve with a collapse to R of
// the faces (1 = none at all), an inspection tool: the collapse smears facets.
const decimateArg = flag("decimate");
const decimate = decimateArg === undefined ? undefined : Number(decimateArg);
if (decimate !== undefined && !(decimate > 0 && decimate <= 1)) fail(`--decimate ${decimateArg}: expected a ratio in (0, 1]`);
// `--scale S` sets the rock scale in metres (the generator's ROCK_SCALE): the
// size of stone every piece is cut from, so 2 is fine-grained and 6 is coarse.
const scaleArg = flag("scale");
const scale = scaleArg === undefined ? undefined : Number(scaleArg);
if (scale !== undefined && !(scale > 0)) fail(`--scale ${scaleArg}: expected metres > 0`);
// THE DEBUGGING SWITCHES (docs/rocks.md, "Diagnosing"): each turns one step
// off for an A/B build, `--seed N` builds every body under another seed, and
// `--dump-stages DIR` writes each body's mesh after every step. They are
// echoed in the build log and the report, so an A/B file says what it is.
// `--no-debug-attributes` leaves _SHARD and _PROVENANCE out, the shipping
// build (see docs/asset-store.md).
const seedArg = flag("seed");
const seed = seedArg === undefined ? undefined : Number(seedArg);
if (seed !== undefined && !Number.isInteger(seed)) fail(`--seed ${seedArg}: expected an integer`);
const dumpArg = flag("dump-stages");
// The dumps are a debugging artefact, every shard whole before the clip: never
// somewhere the game serves or the asset store picks up.
if (dumpArg !== undefined && resolve(dumpArg).startsWith(join(ROOT, "public"))) fail("--dump-stages: not under public/ (use the scratchpad or /tmp)");
// `--remesh` fuses the shards with a voxel remesh (the author's recipe's step;
// dense and soft, see rocks.py); without it the shards ship as instanced.
const job = {
  level: name,
  flat: args.includes("--flat"),
  remesh: args.includes("--remesh"),
  ...(decimate !== undefined ? { decimate } : {}),
  ...(scale !== undefined ? { scale } : {}),
  noBuried: args.includes("--no-buried"),
  noCull: args.includes("--no-cull"),
  noDetail: args.includes("--no-detail"),
  noInset: args.includes("--no-inset"),
  noRepair: args.includes("--no-repair"),
  debugAttributes: !args.includes("--no-debug-attributes"),
  ...(seed !== undefined ? { seed } : {}),
  ...(dumpArg !== undefined ? { dumpStages: resolve(dumpArg) } : {}),
  // `seed` is the body's `rockSeed` (absent = 0); rocks.py reads it with
  // `body.get("seed", 0)`.
  bodies: bodies.map((b) => ({ index: b.index, hash: b.hash, seed: b.seed, pieces: b.pieces })),
};
const jobPath = join(tmpdir(), `rocks-${name}-${process.pid}.json`);
writeFileSync(jobPath, JSON.stringify(job));

const pieces = bodies.reduce((n, b) => n + b.pieces.length, 0);
console.log(`[rocks] ${name}: ${bodies.length} rock bodies, ${pieces} pieces -> ${out}`);
if (job.flat) {
  // The stylised material draws the cracks between slabs and the shading at
  // every step from the baked AO; without it the relief is there but reads as
  // one flat wall, which has been mistaken for a stale body.
  console.log("[rocks] --flat: no AO bake, so the rock will read flat in the game; drop the flag to judge the look");
}

const blender = flag("blender") ?? process.env["BLENDER"] ?? "blender";
// The build report, beside the GLB (`<level>.rocks.json`), which
// `cli rocks-check` reads back.
const reportPath = reportPathOf(out);
rmSync(reportPath, { force: true });
const result = spawnSync(
  blender,
  ["-b", "--factory-startup", "--python", join(ROOT, "tools", "blender", "rocks.py"), "--", jobPath, out, reportPath],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (result.error) fail(`could not run ${blender}: ${result.error.message}`);

// Blender is chatty; keep the generator's own lines and anything that smells
// like a failure.
const lines = `${result.stdout}\n${result.stderr}`.split("\n");
for (const line of lines) {
  if (line.startsWith("[rocks]") || /Error|Traceback|Exception/.test(line)) console.log(line);
}
if (result.status !== 0) {
  console.error(lines.slice(-40).join("\n"));
  fail(`blender exited ${result.status}`);
}
if (!existsSync(out)) fail(`blender wrote nothing at ${out}`);

// The file's stamp, the same number the page logs when it mounts it
// (`[rocks] ball: 57 mounted, file N bytes, id X`), so a build log and a
// report can be matched without guessing which build the browser had.
const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
console.log(`[rocks] ${name}: file ${bytes.byteLength} bytes, id ${rockFileId(bytes)} -> ${out}`);

// The build's own counts, and a chunk still open after repair fails the build:
// it is a hole in the rock, which nobody should have to find by eye.
let failed = false;
const report = readBuildReport(out);
if (!report) {
  console.error(`[rocks] no build report at ${reportPath}`);
  failed = true;
} else if (printBuildReport(report) > 0) {
  console.error("[rocks] FAIL: chunks still open after repair (the OPEN column); the file is written but has holes");
  failed = true;
}

// The file check on what was just written (`--no-check` skips it).
if (!args.includes("--no-check")) {
  const check = checkRockFile(out, ROOT);
  printRockFileCheck(check);
  if (rockFileDefects(check) > 0) {
    console.error(`[rocks] FAIL: ${rockFileDefects(check)} file defect(s)`);
    failed = true;
  }
}
if (failed) process.exit(1);
