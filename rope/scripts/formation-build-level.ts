// Generate (and with --bake, bake) every formation of a level and grow every
// decoration on it, writing what was built into the level file
// (docs/formations.md, "Migrating a scene").
//
//   bun run formation:build-level <level> [--bake] [--only <body name>] [--solid-only] [--jobs N]
//
// What the editor does a formation and a decoration at a time, for a whole
// level at once: a migrated level comes out of scripts/migrate-scene.ts with
// nothing built. Formations whose recipe is built already are left alone (the
// store answers at once). Each decoration is grown on its formation's new rock
// and lands on it (decoration_prepare.py): a placed one's `onRock` is where it
// landed, a painted one's strokes are carried onto it.
//
// It WRITES the level file: close any editor that has it open first (an open
// editor autosaves over what this writes). Geometry runs N at a time (3);
// bakes one at a time, on the GPU, so a whole level's bake is hours: run it in
// the background.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIXELS_PER_METER, PX } from "../src/engine/units";
import { decorationRequest, isPainted } from "../src/formation/decoration";
import { formationHash } from "../src/formation/recipe";
import type { FormationMeta } from "../src/formation/store";
import { scaleLevelData, type PaintStamp, type RawLevelData } from "../src/level/levelFormat";

const ROOT = join(import.meta.dirname, "..");
const TAG = "[build-level]";
const argv = process.argv.slice(2);
const level = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--only", "--jobs"].includes(argv[i - 1]!)));
if (!level) {
  console.error(`${TAG} usage: bun run formation:build-level <level> [--bake] [--only <body name>] [--solid-only] [--jobs N]`);
  process.exit(2);
}
const bake = argv.includes("--bake");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const slots = Number(argv.includes("--jobs") ? argv[argv.indexOf("--jobs") + 1] : 3);
const levelPath = join(ROOT, "levels", `${level}.json`);
const paintPath = join(ROOT, "levels", "paint", `${level}.json`);
const data = scaleLevelData(JSON.parse(readFileSync(levelPath, "utf8")) as RawLevelData, PX);
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

const save = (): void => {
  writeFileSync(levelPath, JSON.stringify(scaleLevelData(data, PIXELS_PER_METER), null, 2) + "\n");
  writeFileSync(paintPath, JSON.stringify(paint, null, 1) + "\n");
};
const scratch = join(ROOT, ".cache", "formation-jobs");
// `--solid-only` leaves out every formation generated from a 2D collision
// guide (the foreground rocks), and their decorations with them.
const solidOnly = argv.includes("--solid-only");
const bodies = data.bodies.filter((b) => b.formation && (!only || b.name === only) && (!solidOnly || b.formation.guide.kind === "solid"));
const t0 = performance.now();
let failed = 0;

// Formations: geometry N at a time, then the bakes one at a time.
const build = async (b: (typeof bodies)[number], withBake: boolean): Promise<void> => {
  const f = b.formation!;
  const hash = formationHash(f);
  const recipe = join(scratch, `level-${level}-${f.id}.json`);
  writeFileSync(recipe, JSON.stringify({ generator: f.generator, ...(f.variant ? { variant: f.variant } : {}), params: f.params, guide: f.guide }));
  const r = await run("formation-build.ts", [recipe, ...(withBake ? ["--bake"] : [])]);
  if (!r.ok) {
    failed++;
    console.log(`${TAG} FAIL ${b.name ?? f.id}: ${r.out.split("\n").filter((l) => l.trim()).slice(-3).join(" | ")}`);
    return;
  }
  const meta = JSON.parse(readFileSync(join(store, hash, "meta.json"), "utf8")) as FormationMeta;
  b.formation = { ...f, built: { hash, front: meta.bounds.max[2], generatorHash: meta.generatorHash, recipeVersion: meta.recipeVersion, tiers: meta.tiers } };
  console.log(`${TAG} ${b.name ?? f.id}: ${withBake ? `baked, ${meta.tiers.length} tiers` : `${meta.triangles.toLocaleString()} triangles`} (${((performance.now() - t0) / 1000).toFixed(0)}s)`);
  save();
};
await pool(bodies, slots, (b) => build(b, false));
if (bake) await pool(bodies.filter((b) => b.formation?.built), 1, (b) => build(b, true));

// Decorations, on the rocks just built.
const decorations = bodies.flatMap((b) => b.objects.flatMap((o) => (o.type === "decoration" && o.formation === b.formation?.id && b.formation?.built ? [{ b, o }] : [])));
await pool(decorations, slots, async ({ b, o }) => {
  const host = b.formation!.built!.hash;
  const strokes = paint[o.id];
  const request = decorationRequest({ ...o, onRock: o.anchor }, host, strokes, data.camera?.focalLength);
  const file = join(scratch, `level-${level}-${o.id}.json`);
  writeFileSync(file, JSON.stringify(request));
  const r = await run("decoration-build.ts", [file]);
  const line = r.out.split("\n").find((l) => l.startsWith("DECORATION_BUILT "));
  if (!r.ok || !line) {
    // It cannot grow on this rock (its root lands off it, its paint will not
    // print): flagged lost, as the editor flags one that cannot follow its
    // rock, for the author to place or paint again.
    failed++;
    const why = r.out.split("\n").find((l) => l.includes("nothing grew:")) ?? r.out.split("\n").filter((l) => l.trim()).slice(-1)[0] ?? "";
    console.log(`${TAG} LOST ${o.id} on ${b.name ?? b.formation!.id}: ${why.replace(/^.*nothing grew: /, "").slice(0, 160)}`);
    const i = b.objects.indexOf(o);
    b.objects[i] = { ...o, lost: true };
    save();
    return;
  }
  const built = JSON.parse(line.slice("DECORATION_BUILT ".length)) as { hash: string; landed: { p: [number, number, number]; n: [number, number, number] } | null };
  const at = isPainted(o.kind) ? o.anchor : (built.landed ?? o.anchor);
  const i = b.objects.indexOf(o);
  const { lost: _lost, ...rest } = o;
  b.objects[i] = { ...rest, onRock: at, built: { hash: built.hash, host, at } };
  console.log(`${TAG} ${o.id} on ${b.name ?? b.formation!.id}`);
  save();
});
console.log(`${TAG} ${bodies.length} formations, ${decorations.length} decorations, ${failed} failed, in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed ? 1 : 0);
