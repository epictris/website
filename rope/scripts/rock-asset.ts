// Build one rock or moss prop from a level body's collision outline.
//
//   bun run assets:rock <level> <body>                  a rock from body <body>
//   bun run assets:rock <level> <body> --moss-of <rock>  a moss growing on rock body <rock>
//   ... [--preview] [--place] [--no-build] [--blender PATH] [--tile T] [--tris N] [--depth D] [--samples N]
//
// The job file `rocks/<level>-<body>.json` is the authored record of the prop
// (docs/rock-assets.md). This command REFRESHES what the level owns in it (the
// outline, the origin, the authored depth) and KEEPS what was authored by hand
// (cracks, seed, textures, tile, tris, the rock a moss grows on), then runs
// headless Blender, optimises the result into `public/meshes/<key>.glb` and
// updates the key's `sha256`/`bytes` in the manifest when the entry exists.
//
// `--preview` also renders the preview sheet into `public/rocks/<name>-*.png`.
// `--place` puts a `kind: "mesh"` geometry object for the key on the body in
// the level file (replacing its drawn primitives); close the editor first, an
// open editor tab autosaves over what a script writes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256 } from "./assetStore";

const ROOT = resolve(import.meta.dirname, "..");
const JOBS = join(ROOT, "rocks");
const TEXTURES = join(ROOT, "assets-src", "rock-textures");
const PPM = 100;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = process.argv.slice(2);
// Flags that take no value; every other `--flag` consumes the word after it.
const bare = new Set(["--preview", "--place", "--no-build"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !bare.has(args[i - 1])));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const USAGE = "usage: bun run assets:rock <level> <body> [--moss-of <rock body>] [--preview] [--place] [--no-build] [--blender PATH] [--tile T] [--tris N] [--depth D] [--samples N]";
const levelArg = positional[0] ?? fail(USAGE);
const bodyIndex = Number(positional[1] ?? fail(USAGE));
if (!Number.isInteger(bodyIndex)) fail(`body must be an index into the level's bodies, got ${positional[1]}`);
const levelPath = levelArg.endsWith(".json") ? resolve(levelArg) : join(ROOT, "levels", `${levelArg}.json`);
if (!existsSync(levelPath)) fail(`no level at ${levelPath}`);
const levelName = basename(levelPath, ".json");
const mossOf = flag("moss-of");
const kind = mossOf === undefined ? "rock" : "moss";

// ---------------------------------------------------------------- the level

interface Vec {
  x: number;
  y: number;
}
interface Obj {
  type: string;
  kind?: string;
  mesh?: string;
  x?: number;
  y?: number;
  rot?: number;
  depth?: number;
  shape?: { kind: string; verts?: Vec[]; w?: number; h?: number };
  [k: string]: unknown;
}
interface Body {
  x: number;
  y: number;
  rot: number;
  objects: Obj[];
  [k: string]: unknown;
}
interface Level {
  bodies: Body[];
  [k: string]: unknown;
}

const level = JSON.parse(readFileSync(levelPath, "utf8")) as Level;

// The collision outline of a body in world metres, y UP (the sim is y down),
// and the body's own origin in the same frame.
function outlineOf(index: number): { outline: Vec[]; origin: Vec; depth: number | undefined } {
  const body = level.bodies[index] ?? fail(`${levelName} has no body ${index} (bodies: ${level.bodies.length})`);
  const col = body.objects.find((o) => o.type === "collision" && o.shape) ?? fail(`body ${index} has no collision shape`);
  const s = col.shape!;
  let local: Vec[];
  if (s.kind === "poly") local = s.verts!;
  else if (s.kind === "rect") {
    const hx = s.w! / 2;
    const hy = s.h! / 2;
    local = [
      { x: -hx, y: -hy },
      { x: hx, y: -hy },
      { x: hx, y: hy },
      { x: -hx, y: hy },
    ];
  } else fail(`body ${index}: a ${s.kind} collision shape is not supported`);
  const rot = (body.rot ?? 0) + (col.rot ?? 0);
  const c = Math.cos(body.rot ?? 0);
  const sn = Math.sin(body.rot ?? 0);
  const lx = col.x ?? 0;
  const ly = col.y ?? 0;
  const px = body.x + lx * c - ly * sn;
  const py = body.y + lx * sn + ly * c;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const outline = local.map((v) => ({
    x: (px + v.x * cr - v.y * sr) / PPM,
    y: -(py + v.x * sr + v.y * cr) / PPM,
  }));
  const geo = body.objects.find((o) => o.type === "geometry" && o.depth !== undefined);
  return { outline, origin: { x: body.x / PPM, y: -body.y / PPM }, depth: geo?.depth === undefined ? undefined : geo.depth / PPM };
}

// ------------------------------------------------------------------ the job

interface Job {
  name: string;
  key: string;
  kind: "rock" | "moss";
  outline: Vec[];
  origin: Vec;
  depth: number;
  seed: number;
  textures: string;
  tile?: number;
  tris?: number;
  cracks?: Vec[][];
  rock?: string;
  [k: string]: unknown;
}

const jobPath = join(JOBS, `${levelName}-${bodyIndex}.json`);
const found = outlineOf(bodyIndex);
let job: Job;
if (existsSync(jobPath)) {
  job = JSON.parse(readFileSync(jobPath, "utf8")) as Job;
  // Authored cracks are in the job's frame; a body that moved keeps them at
  // the same place ON THE ROCK, which is what the author drew them on.
  if (job.cracks && (job.origin.x !== found.origin.x || job.origin.y !== found.origin.y)) {
    const dx = job.origin.x - found.origin.x;
    const dy = job.origin.y - found.origin.y;
    const oldC = centre(job.outline);
    const newC = centre(found.outline);
    // The rock's outline moved by (newC - oldC) in the world; cracks follow it.
    const sx = newC.x - oldC.x + dx;
    const sy = newC.y - oldC.y + dy;
    job.cracks = job.cracks.map((line) => line.map((p) => ({ x: p.x + sx, y: p.y + sy })));
  }
} else {
  job = {
    name: `${kind}-${bodyIndex}`,
    key: `${kind}-${bodyIndex}`,
    kind,
    outline: found.outline,
    origin: found.origin,
    depth: found.depth ?? (kind === "moss" ? 0.5 : 1.0),
    seed: 0,
    textures: kind === "moss" ? "moss-ground-01" : "cliff-rocks-07",
  };
  if (kind === "rock") job.cracks = [];
  console.log(`[rock] new job ${relative(jobPath)}; author cracks/seed/textures in it and rerun`);
}
job.kind = kind;
job.outline = found.outline;
job.origin = found.origin;
if (found.depth !== undefined) job.depth = found.depth;
if (kind === "moss") {
  const rockJob = `${levelName}-${mossOf}.json`;
  if (!existsSync(join(JOBS, rockJob))) fail(`the moss needs its rock's job first: bun run assets:rock ${levelName} ${mossOf}`);
  job.rock = rockJob;
}
mkdirSync(JOBS, { recursive: true });
writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n");
console.log(`[rock] ${relative(jobPath)}: ${kind}, outline ${job.outline.length} verts, depth ${job.depth} m, origin (${job.origin.x.toFixed(3)}, ${job.origin.y.toFixed(3)})`);

function centre(pts: Vec[]): Vec {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}
function relative(p: string): string {
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
}

if (has("no-build")) process.exit(0);

// ---------------------------------------------------------------- the build

for (const set of [job.textures, ...(kind === "moss" ? [(JSON.parse(readFileSync(join(JOBS, job.rock!), "utf8")) as Job).textures] : [])]) {
  if (!existsSync(join(TEXTURES, set, "basecolor.png"))) {
    fail(`no texture set at assets-src/rock-textures/${set}/ - prepare it with tools/rock-texture.py (docs/rock-assets.md)`);
  }
}

const blender = flag("blender") ?? process.env["BLENDER"] ?? "blender";
const outDir = join(tmpdir(), "rock-asset");
mkdirSync(outDir, { recursive: true });
const raw = join(outDir, `${job.name}.glb`);
const blenderArgs = ["-b", "--factory-startup", "--python", join(ROOT, "tools", "blender", "rock_asset.py"), "--", jobPath, raw];
for (const f of ["tile", "tris", "depth", "samples"]) {
  const v = flag(f);
  if (v !== undefined) blenderArgs.push(`--${f}`, v);
}
if (has("preview")) {
  mkdirSync(join(ROOT, "public", "rocks"), { recursive: true });
  blenderArgs.push("--render", join(ROOT, "public", "rocks"));
}
const result = spawnSync(blender, blenderArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) fail(`could not run ${blender}: ${result.error.message}`);
for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
  if (line.startsWith("[rock]") || /Error|Traceback|Exception/.test(line)) console.log(line);
}
if (result.status !== 0 || !existsSync(raw)) fail(`blender wrote nothing at ${raw}`);

const shipped = join(ROOT, "public", "meshes", `${job.key}.glb`);
const opt = spawnSync("bun", ["run", join(ROOT, "scripts", "optimize-asset.ts"), raw, shipped], { encoding: "utf8" });
if (opt.status !== 0) fail(`optimise failed:\n${opt.stdout}\n${opt.stderr}`);
const bytes = readFileSync(shipped);
const hash = sha256(bytes);
console.log(`[rock] ${relative(shipped)}: ${bytes.length} bytes, sha256 ${hash}`);

// The manifest entry, updated in place when it exists; printed when it does not.
const manifestPath = join(ROOT, "src", "render3d", "assets.ts");
const manifest = readFileSync(manifestPath, "utf8");
const entry = new RegExp(`("${job.key}": \\{[^}]*?sha256: ")[0-9a-f]{64}(",\\n\\s*bytes: )\\d+`, "s");
if (entry.test(manifest)) {
  writeFileSync(manifestPath, manifest.replace(entry, `$1${hash}$2${bytes.length}`));
  console.log(`[rock] manifest: "${job.key}" updated`);
} else {
  console.log(`[rock] manifest: add to MESH_ASSETS in src/render3d/assets.ts:\n  "${job.key}": {\n    file: "/meshes/${job.key}.glb",\n    sha256: "${hash}",\n    bytes: ${bytes.length},\n    source: "tools/blender/rock_asset.py from ${relative(jobPath)}; textures <set source>",\n    author: "<you> (textures: <set author>)",\n    license: "CC0",\n  },`);
}

if (has("place")) {
  const body = level.bodies[bodyIndex];
  body.objects = [...body.objects.filter((o) => o.type !== "geometry"), { type: "geometry", kind: "mesh", mesh: job.key }];
  writeFileSync(levelPath, JSON.stringify(level, null, 2) + "\n");
  console.log(`[rock] ${relative(levelPath)}: body ${bodyIndex} now draws "${job.key}" (reload an open editor tab before editing)`);
} else {
  const draws = level.bodies[bodyIndex].objects.some((o) => o.type === "geometry" && o.kind === "mesh" && o.mesh === job.key);
  if (!draws) console.log(`[rock] body ${bodyIndex} does not draw "${job.key}" yet: rerun with --place, or add the mesh object in the editor`);
}
console.log(`[rock] next: bun run assets:publish ${relative(shipped)}`);
