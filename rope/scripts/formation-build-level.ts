// Generate (and with --bake, bake) every formation of a level and grow every
// decoration on it, writing what was built into the level file
// (docs/formations.md, "Building").
//
//   bun run formation:build-level <level> [--bake] [--only <node id or path>] [--solid-only] [--jobs N]
//
// What the editor does a formation and a decoration at a time, for a whole
// level at once: a level whose rocks are stale after a recipe or generator
// change, or one written by a tool rather than built in the editor.
// Formations whose recipe is built already are left alone (the store answers
// at once), and so is a decoration grown already from the request it would
// make now. Each other decoration is grown on its formation's new rock and lands on
// it (decoration_prepare.py): a placed one's `onRock` is where it landed, a
// painted one's strokes are carried onto it.
//
// The level is read as a node tree (scripts/levelTree.ts): a formation is a
// `Formation3D` node and its decorations are its `Decoration3D` children.
// `--only` names one node, by id or by its path of names (`Rocks/Ledge`), and
// builds the formations at or under it. What is built is written onto the
// nodes, and the file is written back as a tree, whatever form it was read in.
// A formation inside a placed prefab is the prefab's, built from the prefab,
// so it is not walked here.
//
// It WRITES the level file: close any editor that has it open first (an open
// editor autosaves over what this writes). Geometry runs N at a time (3);
// bakes one at a time, on the GPU, so a whole level's bake is hours: run it in
// the background.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIXELS_PER_METER, PX } from "../src/engine/units";
import { decorationHash, decorationRequest, isMaterialLayer, isPainted, materialOf } from "../src/formation/decoration";
import { materialLibraryFile } from "../src/formation/materialLayer";
import { sha256Bytes } from "../src/formation/sha256";
import { formationHash } from "../src/formation/recipe";
import type { FormationMeta } from "../src/formation/store";
import { scaleObject, type DecorationAnchor, type DecorationObjectData, type PaintStamp } from "../src/level/levelFormat";
import { scaleLevelTree, walkNodes, type DecorationNode, type FormationNode, type LevelNode } from "../src/level/nodes";
import { decorationsOf, formationNodes, formationOf, LEVELS_DIR, nodePaths, readLevelTree, resolveNode, writeLevelTree } from "./levelTree";

const ROOT = join(import.meta.dirname, "..");
const TAG = "[build-level]";
const argv = process.argv.slice(2);
const level = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--only", "--jobs"].includes(argv[i - 1]!)));
if (!level) {
  console.error(`${TAG} usage: bun run formation:build-level <level> [--bake] [--only <node id or path>] [--solid-only] [--jobs N]`);
  process.exit(2);
}
const bake = argv.includes("--bake");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const slots = Number(argv.includes("--jobs") ? argv[argv.indexOf("--jobs") + 1] : 3);
const levelPath = join(LEVELS_DIR, `${level}.json`);
const paintPath = join(LEVELS_DIR, "paint", `${level}.json`);
if (!existsSync(levelPath)) {
  console.error(`${TAG} no levels/${level}.json`);
  process.exit(2);
}
// What is written back, in pixels as on disk, and what is built from, in
// metres as the store's recipes are. The two share ids.
const disk = readLevelTree(levelPath);
const tree = scaleLevelTree(disk, PX);
const onDisk = new Map<string, LevelNode>();
walkNodes(disk.nodes, (n) => void onDisk.set(n.id, n));
const paths = nodePaths(tree.nodes);
const paint = existsSync(paintPath) ? (JSON.parse(readFileSync(paintPath, "utf8")) as Record<string, PaintStamp[]>) : {};
const store = join(ROOT, "public", "generated");

function run(script: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    const child = spawn("bun", ["run", join(ROOT, "scripts", script), ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("close", (status) => done({ ok: status === 0, out }));
  });
}

async function pool<T>(items: T[], n: number, work: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const save = (): void => writeLevelTree(levelPath, disk);
const label = (n: LevelNode): string => `${paths.get(n.id) ?? n.name} (${n.id})`;
const diskOf = <T extends LevelNode>(n: T): T => onDisk.get(n.id) as T;
// A decoration's anchor in metres as the file holds it, in pixels.
const anchorOnDisk = (a: DecorationAnchor): DecorationAnchor =>
  (scaleObject({ type: "decoration", id: "", kind: "moss", formation: "", anchor: a } as DecorationObjectData, PIXELS_PER_METER) as DecorationObjectData).anchor;

const scratch = join(ROOT, ".cache", "formation-jobs");
mkdirSync(scratch, { recursive: true });
let scope: readonly LevelNode[] = tree.nodes;
if (only) {
  const n = resolveNode(tree.nodes, only);
  if (!n) {
    console.error(`${TAG} levels/${level}.json has no node with the id or path "${only}"`);
    process.exit(2);
  }
  scope = [n];
}
// `--solid-only` leaves out every formation generated from a 2D collision
// guide (the foreground rocks), and their decorations with them.
const solidOnly = argv.includes("--solid-only");
const formations = formationNodes(scope).filter((n) => !solidOnly || n.guide.kind === "solid");
if (only && !formations.length) console.log(`${TAG} nothing to build: no formation at or under ${only}${solidOnly ? " on a solid guide" : ""}`);
const t0 = performance.now();
let failed = 0;

// Formations: geometry N at a time, then the bakes one at a time.
const build = async (n: FormationNode, withBake: boolean): Promise<void> => {
  const f = formationOf(n);
  const hash = formationHash(f);
  const recipe = join(scratch, `level-${level}-${f.id}.json`);
  writeFileSync(recipe, JSON.stringify({ generator: f.generator, ...(f.variant ? { variant: f.variant } : {}), params: f.params, guide: f.guide }));
  const r = await run("formation-build.ts", [recipe, ...(withBake ? ["--bake"] : [])]);
  if (!r.ok) {
    failed++;
    console.log(`${TAG} FAIL ${label(n)}: ${r.out.split("\n").filter((l) => l.trim()).slice(-3).join(" | ")}`);
    return;
  }
  const meta = JSON.parse(readFileSync(join(store, hash, "meta.json"), "utf8")) as FormationMeta;
  // A record of the build, the same in either unit.
  const built = { hash, front: meta.bounds.max[2], generatorHash: meta.generatorHash, recipeVersion: meta.recipeVersion, tiers: meta.tiers };
  n.built = built;
  diskOf(n).built = built;
  console.log(`${TAG} ${label(n)}: ${withBake ? `baked, ${meta.tiers.length} tiers` : `${meta.triangles.toLocaleString()} triangles`} (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
  save();
};
await pool(formations, slots, (n) => build(n, false));
if (bake) await pool(formations.filter((n) => n.built), 1, (n) => build(n, true));

// Decorations, on the rocks just built.
const decorations = formations.flatMap((f) => (f.built ? decorationsOf(f).map((d) => ({ f, d })) : []));
await pool(decorations, slots, async ({ f, d }: { f: FormationNode; d: DecorationNode }) => {
  const host = f.built!.hash;
  const strokes = paint[d.id];
  // A material layer's material, as its library file is now.
  const libraryFile = isMaterialLayer(d) ? join(ROOT, materialLibraryFile(materialOf(d))) : null;
  const library = libraryFile && existsSync(libraryFile) ? sha256Bytes(new Uint8Array(readFileSync(libraryFile))) : null;
  const request = decorationRequest({ ...d, onRock: d.anchor }, host, strokes, tree.camera?.focalLength, library);
  const written = diskOf(d);
  if (!request) {
    failed++;
    console.log(`${TAG} SKIPPED ${d.id} on ${label(f)}: no library material "${materialOf(d)}"`);
    return;
  }
  // Grown already from this very request: left as it is, so where the editor
  // carried it onto the rock (`onRock`) is not replaced by the rule below.
  if (!d.lost && d.built?.host === host && d.built.hash === decorationHash(request)) {
    console.log(`${TAG} ${d.id} on ${label(f)}: current`);
    return;
  }
  const file = join(scratch, `level-${level}-${d.id}.json`);
  writeFileSync(file, JSON.stringify(request));
  const r = await run("decoration-build.ts", [file]);
  const line = r.out.split("\n").find((l) => l.startsWith("DECORATION_BUILT "));
  if (!r.ok || !line) {
    // It cannot grow on this rock (its root lands off it, its paint will not
    // print): flagged lost, as the editor flags one that cannot follow its
    // rock, for the author to place or paint again.
    failed++;
    const why = r.out.split("\n").find((l) => l.includes("nothing grew:")) ?? r.out.split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "";
    console.log(`${TAG} LOST ${d.id} on ${label(f)}: ${why.replace(/^.*nothing grew: /, "").slice(0, 160)}`);
    written.lost = true;
    save();
    return;
  }
  const built = JSON.parse(line.slice("DECORATION_BUILT ".length)) as { hash: string; landed: { p: [number, number, number]; n: [number, number, number] } | null; maps?: string };
  // Where it is drawn, in pixels: a placed one where it landed, a painted one
  // (or a placed one that did not land) at its anchor as the file holds it,
  // so that is not rounded through metres and back.
  const landed = !isPainted(d.kind) && built.landed ? built.landed : null;
  const at = landed ? anchorOnDisk(landed) : structuredClone(written.anchor);
  delete written.lost;
  written.onRock = at;
  written.built = { hash: built.hash, host, at: structuredClone(at), ...(built.maps ? { maps: built.maps } : {}) };
  console.log(`${TAG} ${d.id} on ${label(f)}`);
  save();
});
console.log(`${TAG} ${formations.length} formations, ${decorations.length} decorations, ${failed} failed, in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed ? 1 : 0);
