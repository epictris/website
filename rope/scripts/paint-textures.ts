// Rebuild every shipped texture map from its raw source, by the recipe the
// manifest records - so the whole texture store is reproducible from
// `assets-src/` and `TEXTURE_ASSETS` alone, and adding or re-painting a set
// is one manifest entry and one command.
//
//   bun run assets:paint                 every set that records its raws
//   bun run assets:paint "dark rock"     one set (a manifest key)
//   bun run assets:paint --publish       ...and upload every map whose bytes changed
//   bun run assets:paint --check         exit 1 if any map's bytes differ from the manifest
//
// For each map with a `raw` it runs `assets:optimize-texture` with exactly the
// flags the entry records - the slot, the scalar channel, the paint brush, the
// albedo's cavity (taken from the set's OWN `ao` map's raw), saturation and
// tint - writes the shipped `.webp`, and then compares its sha256 and size
// with what the manifest says. Maps that came out different are printed as
// the manifest lines to paste, exactly as `assets:publish` prints them, so the
// recipe, the bytes and the record cannot drift apart without this saying so.
//
// It never edits the manifest itself: `sha256` and `bytes` are pasted by the
// person who changed the recipe, which is the one moment they should be
// looking at what changed.
//
// ADDING A TEXTURE is therefore:
//   1. put the raw images under `assets-src/<set>/`
//   2. add a `TEXTURE_ASSETS` entry whose maps name `file`, `raw`, (`channel`)
//      and `paint`, with `sha256: ""` and `bytes: 0`
//   3. `bun run assets:paint "<set>" --publish`, and paste what it prints
//
// The bakes run in parallel: a mean shift at a 15-pixel window over a 512
// map is a few seconds, and there are four maps to a set.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { TEXTURE_ASSETS, type TextureAsset, type TextureMap } from "../src/render3d/assets";
import { sha256 } from "./assetStore";

const ROOT = resolve(import.meta.dir, "..");
const RAW_DIR = resolve(ROOT, "assets-src");

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const check = args.includes("--check");
const only = args.filter((a) => !a.startsWith("--"));

type Slot = keyof TextureAsset["maps"];
const SLOTS: Slot[] = ["base", "normal", "roughness", "metallic", "ao", "emissive"];

interface Job {
  set: string;
  slot: Slot;
  map: TextureMap;
  argv: string[];
}

// The optimize-texture command line for one map, from its record alone.
function jobFor(set: string, asset: TextureAsset, slot: Slot, map: TextureMap): Job | string {
  if (!map.raw) return `${set}/${slot}: no \`raw\` recorded, cannot be re-baked`;
  const raw = resolve(RAW_DIR, map.raw);
  if (!existsSync(raw)) return `${set}/${slot}: raw missing: assets-src/${map.raw}`;
  const argv = [raw, resolve(ROOT, "public", map.file.replace(/^\//, "")), "--map", slot];
  if (map.channel) argv.push("--channel", map.channel);
  const paint = map.paint;
  if (paint) {
    argv.push("--paint", String(paint.brush));
    if (paint.cavity) {
      const ao = asset.maps.ao;
      if (!ao?.raw) return `${set}/${slot}: paint.cavity needs the set's \`ao\` map to record its raw`;
      argv.push("--cavity", resolve(RAW_DIR, ao.raw), "--cavity-channel", ao.channel ?? "r");
    }
    if (paint.saturate !== undefined) argv.push("--saturate", String(paint.saturate));
    if (paint.tint !== undefined) argv.push("--tint", paint.tint);
  }
  return { set, slot, map, argv };
}

function run(argv: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const p = spawn("bun", ["run", resolve(ROOT, "scripts/optimize-texture.ts"), ...argv], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

async function pool<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

const sets = Object.entries(TEXTURE_ASSETS).filter(([key]) => only.length === 0 || only.includes(key));
for (const key of only) {
  if (!(key in TEXTURE_ASSETS)) {
    console.error(`no such texture set: "${key}"`);
    process.exit(2);
  }
}

const jobs: Job[] = [];
const skipped: string[] = [];
for (const [key, asset] of sets) {
  for (const slot of SLOTS) {
    const map = asset.maps[slot];
    if (!map) continue;
    const job = jobFor(key, asset, slot, map);
    if (typeof job === "string") skipped.push(job);
    else jobs.push(job);
  }
}
if (jobs.length === 0) {
  console.error("nothing to bake" + (skipped.length ? `:\n  ${skipped.join("\n  ")}` : ""));
  process.exit(2);
}

console.log(`[paint] baking ${jobs.length} maps across ${new Set(jobs.map((j) => j.set)).size} sets`);
const failed: string[] = [];
await pool(jobs, Math.max(1, Math.min(8, Math.floor(cpus().length / 4))), async (job) => {
  const { code, out } = await run(job.argv);
  const summary = out.split("\n").find((l) => l.startsWith("[assets] " + job.slot)) ?? out.trim();
  console.log(`  ${job.set}/${job.slot}: ${summary.replace(/^\[assets\] \w+: /, "")}`);
  if (code !== 0) failed.push(`${job.set}/${job.slot}:\n${out}`);
});
if (failed.length) {
  console.error(`[paint] ${failed.length} bake(s) FAILED:\n${failed.join("\n")}`);
  process.exit(1);
}

// What changed, as the lines to paste.
const changed: Job[] = [];
for (const job of jobs) {
  const path = resolve(ROOT, "public", job.map.file.replace(/^\//, ""));
  const bytes = readFileSync(path);
  const hash = sha256(bytes);
  const size = statSync(path).size;
  if (hash !== job.map.sha256 || size !== job.map.bytes) {
    changed.push(job);
    console.log(`\n[paint] ${job.set}/${job.slot} differs from the manifest - its entry wants:`);
    console.log(`        sha256: "${hash}",`);
    console.log(`        bytes: ${size},`);
  }
}
// The older sets predate the record and have no raw; one line per set rather
// than one per map, or the report is mostly them.
const bySet = new Map<string, string[]>();
for (const s of skipped) {
  const [set, rest] = s.split(": ", 2) as [string, string];
  bySet.set(set.split("/")[0]!, [...(bySet.get(set.split("/")[0]!) ?? []), `${set.split("/")[1]} (${rest})`]);
}
for (const [set, maps] of bySet) console.log(`[paint] not reproducible - ${set}: ${maps.join(", ")}`);
console.log(
  `[paint] ${jobs.length} baked, ${changed.length} differ from the manifest` +
    (skipped.length ? `, ${skipped.length} not reproducible` : ""),
);

if (publish) {
  for (const job of changed) {
    const file = resolve(ROOT, "public", job.map.file.replace(/^\//, ""));
    console.log(`\n[paint] publishing ${job.set}/${job.slot}`);
    const p = Bun.spawnSync(["bun", "run", resolve(ROOT, "scripts/publish-asset.ts"), file], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (p.exitCode !== 0) process.exit(p.exitCode);
  }
}
if (check && changed.length) process.exit(1);
