// Build one formation from its recipe into the store (docs/formations.md).
//
//   bun run formation:build <recipe.json> [--bake] [options]
//   bun run formation:build --level <level> --node <id or path> [--generator fitted|boulders] [--bake] [options]
//
// A recipe file is a formation's recipe in metres: `{generator, variant?,
// params, guide}` as a level holds it in memory, or `{generator, params,
// outline: [[x, z], ...]}` with the outline in the rock's frame (x right, z
// up, metres) as the worker takes it. `--level`/`--node` take it from a level
// instead (plans/node-tree.md): a `Formation3D` node's own recipe, or a body
// node's rock's; given `--generator`, or for a body with no rock, a collision
// guide taken from the body's enclosing collision pieces, as "Generate" in
// the editor does, in the rock's frame where the body has one. The node is named
// by its id or its path of names (`Rocks/Ledge`). This builds into the store
// and writes nothing to the level; `formation:build-level` is what writes
// builds back. The retired `--body <index>` named a body by its place in the
// flat list, which a tree has no stable notion of.
//
// Two stages, each run only when the store lacks what it makes:
//
//   geometry  formations/worker.py builds the rock (rock.blend);
//             tools/blender/formation_export.py writes the iteration look's
//             mesh, the play-plane section and the rock with its bake caps;
//             the optimiser packs the mesh. -> geometry.glb, rock.blend, meta.json
//   bake      (--bake) the scene exporter bakes the rock as a model is baked,
//             every face seen, capped at --map-max (2048) colour and half that
//             normal; formation-tiers.mjs derives the lower tiers.
//             -> tier-0.glb ... tier-N.glb, meta.json's `tiers`
//
// The result is `public/generated/<hash>/`, the hash the recipe's
// (`formationHash`). A folder appears whole or not at all (built beside and
// renamed), and a stage that fails ships nothing.
//
// Options: --blender PATH, --python PATH (rope/.venv's by default), --store DIR,
// --triangles N (the iteration mesh's budget, 150000), --map-max N (2048),
// --tiers N (3), --force (build again what the store has).
//
// The last line on success is `FORMATION_BUILT <json>`: the hash, the
// generator's fingerprint, the recipe version and the tiers, which is what a
// level's `formation.built` records. The job runner (src/server/formations.ts)
// reads it, and every `<tag> step i/n: ...` line before it for its bar.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PX } from "../src/engine/units";
import { guideOutline, fromRock, workerRecipe } from "../src/formation/guide";
import { formationRecipe, RECIPE_VERSION, recipeHash } from "../src/formation/recipe";
import { readStoredMesh } from "../src/formation/meshBin";
import { meshFiles, solidWorkerRecipe, type SolidMesh } from "../src/formation/solid";
import { FORMATION_HASH, GEOMETRY_FILE, meshFileName, MESHES, META_FILE, ROCK_FILE, tierFileName, type FormationMeta, type SectionLoop } from "../src/formation/store";
import { isCollisionObject, normalizeLevelData, scaleFormation, scaleNormalized, type FormationData, type FormationTier, type GuidePiece, type SolidNode } from "../src/level/levelFormat";
import { BODY_TYPES, compose2D, enclosesShape, lookNodes, poseOf, poseOfFrame, relative2D, type FormationNode } from "../src/level/nodes";
import { exportBlend, ROOT } from "./blendExport";
import { formationOf, readLevelTree, resolveNode } from "./levelTree";
import { StepProgress } from "./stepProgress";

const TAG = "[formation]";
const usage =
  "usage: bun run formation:build <recipe.json> | --level <level> --node <id or path> [--generator G] [--bake] [--blender PATH] [--python PATH] [--store DIR] [--triangles N] [--map-max N] [--tiers N] [--force]";

function fail(msg: string): never {
  console.error(`${TAG} ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes("--body")) fail(`--body <index> is retired: name the node instead, --level <level> --node <id or path>\n${usage}`);
const VALUED = new Set(["--level", "--node", "--generator", "--blender", "--python", "--store", "--triangles", "--map-max", "--tiers"]);
const BARE = new Set(["--bake", "--force"]);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (!a.startsWith("--")) continue;
  if (VALUED.has(a)) i++;
  else if (!BARE.has(a)) fail(`unknown flag ${a}\n${usage}`);
}
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUED.has(argv[i - 1]!)));
const blender = flag("--blender") ?? process.env["BLENDER_PATH"] ?? process.env["BLENDER"] ?? "blender";
const python = flag("--python") ?? join(ROOT, ".venv", "bin", "python");
const store = resolve(flag("--store") ?? join(ROOT, "public", "generated"));
const triangles = Number(flag("--triangles") ?? 150_000);
const mapMax = Number(flag("--map-max") ?? 2048);
const tierCount = Number(flag("--tiers") ?? 3);
const bake = argv.includes("--bake");
const force = argv.includes("--force");

type Recipe = Pick<FormationData, "generator" | "variant" | "params" | "guide">;

function loadRecipe(): Recipe {
  const level = flag("--level");
  if (level) {
    const ref = flag("--node") ?? fail(`--level needs --node <id or path>\n${usage}`);
    const file = join(ROOT, "levels", `${level}.json`);
    if (!existsSync(file)) fail(`no ${relative(ROOT, file)}`);
    const tree = readLevelTree(file);
    const node = resolveNode(tree.nodes, ref);
    if (!node) fail(`${level} has no node with the id or path "${ref}"`);
    if (node.type !== "Formation3D" && !BODY_TYPES.has(node.type)) fail(`${level} node "${ref}" is a ${node.type}: name a Formation3D or a body`);
    const generator = flag("--generator") as Recipe["generator"] | undefined;
    // The formation's own recipe, its guide in metres.
    if (node.type === "Formation3D" && !generator) return scaleFormation(formationOf(node), PX);
    // The body the node is, or the one its rock rides, and the rock: compiling
    // composes everything between them, and the tree places the rock.
    const data = scaleNormalized(normalizeLevelData(tree), PX);
    const looks = lookNodes(data.tree ?? []);
    const rock = node.type === "Formation3D" ? looks.find((p) => p.node.id === node.id) : looks.find((p) => p.node.type === "Formation3D" && p.body === node.id);
    const bodyId = node.type === "Formation3D" ? rock?.body : node.id;
    const b = bodyId ? data.bodies.find((x) => x.node?.id === bodyId) : undefined;
    // A body's rock as it is, unless another generator is asked for.
    if (rock && !generator) return formationOf(rock.node as FormationNode);
    if (!b) fail(`${level} node "${ref}" ${node.type === "Formation3D" ? "rides no body: a rock with no body is a background rock, so build its own recipe, without --generator" : "compiles to no body (is it, or something above it, disabled?)"}`);
    // Else a guide from the body's collision, in its rock's frame (the body's
    // own when it has no rock yet), in the plane.
    const bodyPose = { x: b.x, y: b.y, rot: b.rot };
    const rockPose = rock ? poseOfFrame(rock.world) : bodyPose;
    const pieces = b.objects
      .filter(isCollisionObject)
      .filter(enclosesShape)
      .map((o): GuidePiece => ({ ...relative2D(rockPose, compose2D(bodyPose, poseOf(o))), shape: o.shape }));
    if (!pieces.length) fail(`${level} node "${ref}" has no enclosing collision pieces to take a guide from`);
    return { generator: generator ?? (rock?.node as FormationNode | undefined)?.generator ?? "fitted", params: {}, guide: { kind: "collision", pieces } };
  }
  const path = positional[0] ?? fail(usage);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Recipe & { outline?: [number, number][] };
  if (raw.outline) {
    // The worker's own form: an outline in the rock's frame, one poly piece.
    return {
      generator: raw.generator ?? "fitted",
      params: raw.params ?? {},
      guide: { kind: "collision", pieces: [{ shape: { kind: "poly", verts: raw.outline.map(([x, z]) => fromRock(x, z)) } }] },
    };
  }
  if (!raw.guide) fail(`${path}: a recipe needs a guide or an outline`);
  return { generator: raw.generator, ...(raw.variant ? { variant: raw.variant } : {}), params: raw.params ?? {}, guide: raw.guide };
}

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  out: string;
}

// Run `cmd`, handing each stdout line to `onLine` as it comes, and keeping
// all of it (stdout and stderr) for the log.
function run(cmd: string, args: string[], onLine: (line: string) => void = () => {}): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let partial = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const l of lines) onLine(l);
    });
    child.stderr.on("data", (chunk: string) => (out += chunk));
    child.on("error", (e) => done({ status: null, signal: null, out: `${out}\n${e.message}` }));
    child.on("close", (status, signal) => done({ status, signal, out }));
  });
}

// The last lines of a failed run worth reading, and where all of it is.
function failRun(progress: StepProgress, what: string, r: Run, log: string): never {
  writeFileSync(log, r.out);
  progress.fail();
  const lines = r.out.split("\n").filter((l) => l.trim() && !/^(Blender|Read prefs|Read blend|Blender quit|Warning: )/.test(l));
  console.error(lines.slice(-12).join("\n"));
  fail(`${what} failed (${r.signal ?? `exit ${r.status}`}); its whole output is in ${relative(ROOT, log)}`);
}

const f = loadRecipe();
const recipe = formationRecipe(f);
const hash = recipeHash(recipe);
if (!FORMATION_HASH.test(hash)) fail(`bad hash ${hash}`);
const dir = join(store, hash);
const metaPath = join(dir, META_FILE);
const logDir = join(ROOT, ".cache", "formation-build");
mkdirSync(logDir, { recursive: true });
mkdirSync(store, { recursive: true });
console.log(`${TAG} ${hash.slice(0, 12)}: ${recipe.generator}${recipe.variant ? ` (${recipe.variant})` : ""}`);

// A solid guide's stored meshes, from the store's `meshes/`, in either form.
function storedMeshes(tree: SolidNode): Map<string, SolidMesh> {
  const out = new Map<string, SolidMesh>();
  for (const name of meshFiles(tree)) {
    const path = join(store, MESHES, meshFileName(name));
    if (existsSync(path)) out.set(name, readStoredMesh(name, readFileSync(path)));
  }
  return out;
}

const haveGeometry = (): boolean => [GEOMETRY_FILE, ROCK_FILE, META_FILE].every((n) => existsSync(join(dir, n)));

// The geometry stage, into a folder built beside the store and renamed in.
async function buildGeometry(): Promise<void> {
  const steps = [
    { id: "generate", label: `generate (${recipe.generator})` },
    { id: "export", label: "section, bake caps, iteration mesh" },
    { id: "optimise", label: "pack the iteration mesh" },
  ];
  const progress = new StepProgress(TAG, steps);
  const scratch = mkdtempSync(join(logDir, `${hash.slice(0, 12)}-`));
  const times: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      times[name] = Math.round(performance.now() - t) / 1000;
    }
  };
  try {
    progress.start("generate");
    let worker: Record<string, unknown>;
    try {
      worker = f.guide.kind === "collision" ? workerRecipe(f) : solidWorkerRecipe(f, storedMeshes(f.guide.tree));
    } catch (e) {
      progress.fail();
      fail(`the guide cannot be built: ${(e as Error).message}`);
    }
    if (f.guide.kind === "collision") {
      const g = guideOutline(f.guide);
      if (g.holes) progress.log(`${TAG} the guide's union has ${g.holes} hole(s); an outline generator fills them`);
    }
    writeFileSync(join(scratch, "input.json"), JSON.stringify(worker));
    const gen = await timed("generate", () =>
      run(python, [join(ROOT, "tools", "blender", "formations", "worker.py"), join(scratch, "input.json"), scratch, "--blender", blender]),
    );
    if (gen.status !== 0 || !existsSync(join(scratch, "rock.blend"))) failRun(progress, "the generator", gen, join(scratch, "generate.log"));
    writeFileSync(join(scratch, "generate.log"), gen.out);

    progress.start("export");
    const exp = await timed("export", () =>
      run(blender, [
        "-b", join(scratch, "rock.blend"), "--factory-startup", "--python-exit-code", "1",
        "--python", join(ROOT, "tools", "blender", "formation_export.py"), "--", scratch,
        "--triangles", String(triangles), "--map-max", String(mapMax),
      ]),
    );
    if (exp.status !== 0 || !exp.out.includes("FORMATION_EXPORT_OK")) failRun(progress, "formation_export.py", exp, join(scratch, "export.log"));

    progress.start("optimise");
    const opt = await timed("optimise", () =>
      run("bun", ["run", join(ROOT, "scripts", "optimize-asset.ts"), join(scratch, "geometry.gltf"), join(scratch, GEOMETRY_FILE), "--keep-nodes"]),
    );
    if (opt.status !== 0) failRun(progress, "the optimiser", opt, join(scratch, "optimise.log"));
    progress.finish();

    const stats = JSON.parse(readFileSync(join(scratch, "stats.json"), "utf8")) as {
      triangles: number; geometryTriangles: number; facet: boolean; area: number; warnings: string[];
      bounds: { min: [number, number, number]; max: [number, number, number] };
    };
    const warnings = [...stats.warnings];
    if (!stats.facet) warnings.push("the rock has no facet attribute; the iteration look will be flat");
    for (const w of warnings) progress.log(`${TAG} WARNING ${w}`);
    const resolved = JSON.parse(readFileSync(join(scratch, "recipe.json"), "utf8")) as { generatorHash: string };
    const section = JSON.parse(readFileSync(join(scratch, "section.json"), "utf8")) as { loops: { closed: boolean; points: [number, number][] }[] };
    // Blender (x, y away, z up) to the 3D view's (x, y up, z toward the camera).
    const { min: bmin, max: bmax } = stats.bounds;
    const meta: FormationMeta = {
      hash,
      recipe,
      workerRecipe: worker,
      generatorHash: resolved.generatorHash,
      recipeVersion: RECIPE_VERSION,
      triangles: stats.triangles,
      geometryTriangles: stats.geometryTriangles,
      bounds: { min: [bmin[0], bmin[2], -bmax[1]], max: [bmax[0], bmax[2], -bmin[1]] },
      area: stats.area,
      section: section.loops.map((l): SectionLoop => ({ closed: l.closed, points: l.points.map(([x, z]) => fromRock(x, z)) })),
      tiers: [],
      times,
      builtAt: new Date().toISOString(),
      warnings,
    };
    const staging = join(store, `.${hash}.${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging);
    cpSync(join(scratch, GEOMETRY_FILE), join(staging, GEOMETRY_FILE));
    cpSync(join(scratch, "bake.blend"), join(staging, ROCK_FILE));
    writeFileSync(join(staging, META_FILE), JSON.stringify(meta, null, 2) + "\n");
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    rmSync(scratch, { recursive: true, force: true });
    const open = meta.section.filter((l) => !l.closed).length;
    console.log(
      `${TAG} geometry: ${stats.triangles.toLocaleString()} triangles (${stats.geometryTriangles.toLocaleString()} drawn), section ${meta.section.length} loop(s)${open ? `, ${open} OPEN` : ""}; ` +
        Object.entries(times).map(([k, v]) => `${k} ${v.toFixed(2)}s`).join(", "),
    );
  } catch (e) {
    progress.fail();
    throw e;
  }
}

// The bake stage: tier 0 by the scene exporter, the rest derived.
async function bakeTiers(): Promise<FormationTier[]> {
  const scratch = mkdtempSync(join(logDir, `${hash.slice(0, 12)}-bake-`));
  const times: Record<string, number> = {};
  let t = performance.now();
  await exportBlend({
    blend: join(dir, ROCK_FILE),
    shipped: join(scratch, tierFileName(0)),
    tag: "[formation-bake]",
    kind: "formation",
    name: hash.slice(0, 16),
    allSeen: true,
    raw: false,
    // A cache entry per hash would only pile up: no two bakes share one.
    noCache: true,
    staleOcclusion: false,
    blender,
  });
  times["bake"] = Math.round(performance.now() - t) / 1000;
  t = performance.now();
  console.log(`${TAG} deriving lower tiers`);
  const derive = await run("node", [join(ROOT, "scripts", "formation-tiers.mjs"), join(scratch, tierFileName(0)), scratch, "--max", String(tierCount)]);
  const line = derive.out.split("\n").find((l) => l.startsWith("TIERS "));
  if (derive.status !== 0 || !line) {
    writeFileSync(join(scratch, "tiers.log"), derive.out);
    console.error(derive.out.split("\n").slice(-12).join("\n"));
    fail(`deriving the tiers failed; the log is in ${relative(ROOT, join(scratch, "tiers.log"))}`);
  }
  times["tiers"] = Math.round(performance.now() - t) / 1000;
  const tiers = JSON.parse(line.slice("TIERS ".length)) as FormationTier[];
  // Tiers first, the meta that lists them last: a reader that sees a tier in
  // the meta finds its file. Each is copied in beside its name and renamed
  // there: the scratch folder is under rope/.cache, and a store on another
  // file system (--store) cannot be renamed into (EXDEV).
  tiers.forEach((_, k) => {
    const target = join(dir, tierFileName(k));
    cpSync(join(scratch, tierFileName(k)), `${target}.partial`);
    renameSync(`${target}.partial`, target);
  });
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as FormationMeta;
  meta.tiers = tiers;
  meta.times = { ...meta.times, ...times };
  writeFileSync(`${metaPath}.partial`, JSON.stringify(meta, null, 2) + "\n");
  renameSync(`${metaPath}.partial`, metaPath);
  rmSync(scratch, { recursive: true, force: true });
  console.log(
    `${TAG} bake: ${tiers.map((x, k) => `tier ${k} ${x.triangles.toLocaleString()} tris ${x.colour}/${x.normal} ${(x.bytes / 1024).toFixed(0)} KB`).join("; ")}; ` +
      Object.entries(times).map(([k, v]) => `${k} ${v.toFixed(1)}s`).join(", "),
  );
  return tiers;
}

if (force || !haveGeometry()) await buildGeometry();
else console.log(`${TAG} geometry: in the store`);
let meta = JSON.parse(readFileSync(metaPath, "utf8")) as FormationMeta;
if (bake) {
  if (force || !meta.tiers.length || !existsSync(join(dir, tierFileName(0)))) await bakeTiers();
  else console.log(`${TAG} bake: in the store (${meta.tiers.length} tiers)`);
  meta = JSON.parse(readFileSync(metaPath, "utf8")) as FormationMeta;
}
console.log(`${TAG} ${relative(ROOT, dir)}`);
console.log(`FORMATION_BUILT ${JSON.stringify({ hash, generatorHash: meta.generatorHash, recipeVersion: meta.recipeVersion, tiers: meta.tiers })}`);
