// Grow one decoration on one formation's rock into the store
// (docs/formations.md, "Decorations").
//
//   bun run scripts/decoration-build.ts <request.json> [--force] [--store DIR]
//
// The request: `{host, kind, seed?, settings?, lens?, at?, stamps?}`, `host`
// the hash of the formation build it grows on (its `rock.blend` in the store),
// `at` a placed decoration's anchor on the rock and `stamps` a painted one's
// strokes, both in the formation's frame (tools/blender/decoration_prepare.py).
// Its hash (`decorationHash`) names the result:
//
//   public/generated/<hash>/decoration.glb   what the game draws
//   public/generated/<hash>/layer.png        ...or, for a texture layer
//                                            (`isTextureLayer`), the map the game
//                                            lays over the rock's colour
//   public/generated/<hash>/meta.json        what was asked and what came of it
//
// Two steps: decoration_prepare.py makes a .blend of the host and the
// decoration with the scene's camera and depth given explicitly, and the scene
// exporter grows and exports it exactly as it grows a level's (blendExport.ts),
// so what the editor shows is what an export of the same paint would ship. A
// texture layer's second step is decoration_layer.py instead, which paints the
// same dabs into the rock's paint UV.
//
// The last line on success is `DECORATION_BUILT <json>`.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { decorationHash, isTextureLayer, type DecorationRequest } from "../src/formation/decoration";
import { FORMATION_HASH, ROCK_FILE } from "../src/formation/store";
import { exportBlend, ROOT } from "./blendExport";

const TAG = "[decoration]";
const fail = (msg: string): never => {
  console.error(`${TAG} ${msg}`);
  process.exit(1);
};

const file = process.argv[2] ?? fail("usage: bun run scripts/decoration-build.ts <request.json> [--force]");
const request = JSON.parse(readFileSync(file, "utf8")) as DecorationRequest;
if (!FORMATION_HASH.test(request.host)) fail(`no host build ${request.host}`);
const storeAt = process.argv.indexOf("--store");
const store = storeAt === -1 ? join(ROOT, "public", "generated") : process.argv[storeAt + 1]!;
const layer = isTextureLayer(request);
const rock = join(store, request.host, ROCK_FILE);
if (!existsSync(rock)) fail(`the store has no ${relative(ROOT, rock)}: generate the formation first`);
const hash = decorationHash(request);
const dir = join(store, hash);
if (existsSync(join(dir, layer ? "layer.png" : "decoration.glb")) && !process.argv.includes("--force")) {
  console.log(`${TAG} ${hash.slice(0, 12)}: in the store`);
  const kept = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { landed?: unknown };
  console.log(`DECORATION_BUILT ${JSON.stringify({ hash, landed: kept.landed ?? null })}`);
  process.exit(0);
}
console.log(`${TAG} ${hash.slice(0, 12)}: ${request.kind} on ${request.host.slice(0, 12)}`);
console.log(`${TAG} step 1/2: prepare the host and the ${request.kind}`);
const scratch = mkdtempSync(join(ROOT, ".cache", "decoration-"));
const req = join(scratch, "request.json");
writeFileSync(req, JSON.stringify(request));
const blend = join(scratch, "decoration.blend");
const t0 = performance.now();
const prep = spawnSync(
  process.env["BLENDER_PATH"] ?? "blender",
  ["-b", rock, "--factory-startup", "--python-exit-code", "1", "--python", join(ROOT, "tools", "blender", "decoration_prepare.py"), "--", req, blend],
  { encoding: "utf8" },
);
if (prep.status !== 0 || !existsSync(blend)) {
  writeFileSync(join(scratch, "prepare.log"), prep.stdout + prep.stderr);
  console.error((prep.stdout + prep.stderr).split("\n").filter((l) => l.trim()).slice(-10).join("\n"));
  fail(`decoration_prepare.py failed; its output is in ${relative(ROOT, join(scratch, "prepare.log"))}`);
}
const prepared = (performance.now() - t0) / 1000;
// Where a placed one landed on the rock (decoration_prepare.py `land`).
const landedPath = join(scratch, "decoration.landed.json");
const landed = existsSync(landedPath) ? (JSON.parse(readFileSync(landedPath, "utf8")) as { p: number[]; n: number[] }) : null;
const t1 = performance.now();
if (layer) {
  console.log(`${TAG} step 2/2: paint the layer`);
  const paint = spawnSync(
    process.env["BLENDER_PATH"] ?? "blender",
    ["-b", blend, "--factory-startup", "--python-exit-code", "1", "--python", join(ROOT, "tools", "blender", "decoration_layer.py"), "--", scratch],
    { encoding: "utf8" },
  );
  const out = paint.stdout + paint.stderr;
  if (paint.status !== 0 || !existsSync(join(scratch, "layer.png"))) {
    writeFileSync(join(scratch, "layer.log"), out);
    const why = out.split("\n").find((l) => l.includes("REGENERATE:"));
    if (why) fail(why.slice(why.indexOf("REGENERATE:") + "REGENERATE:".length).trim());
    console.error(out.split("\n").filter((l) => l.trim()).slice(-10).join("\n"));
    fail(`decoration_layer.py failed; its output is in ${relative(ROOT, join(scratch, "layer.log"))}`);
  }
  const painted = JSON.parse(readFileSync(join(scratch, "layer.json"), "utf8")) as { size: number; texels: number };
  const exported = (performance.now() - t1) / 1000;
  const staging = join(store, `.${hash}.${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(join(scratch, "layer.png"), join(staging, "layer.png"));
  writeFileSync(
    join(staging, "meta.json"),
    JSON.stringify({ hash, request, landed: null, layer: painted, nodes: [], warnings: [], times: { prepare: prepared, layer: exported }, builtAt: new Date().toISOString() }, null, 2) + "\n",
  );
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`${TAG} layer ${painted.size}x${painted.size}, ${painted.texels.toLocaleString()} texels; prepare ${prepared.toFixed(1)}s, paint ${exported.toFixed(1)}s`);
  console.log(`DECORATION_BUILT ${JSON.stringify({ hash, landed: null })}`);
  process.exit(0);
}
console.log(`${TAG} step 2/2: grow and export`);
const meta = await exportBlend({
  blend,
  shipped: join(scratch, "decoration.glb"),
  tag: "[decoration-export]",
  kind: "decoration",
  name: hash.slice(0, 16),
  allSeen: true,
  raw: false,
  noCache: true,
  staleOcclusion: false,
  blender: process.env["BLENDER_PATH"] ?? "blender",
});
const exported = (performance.now() - t1) / 1000;
if (!meta.nodes.length) fail(`nothing grew: ${meta.warnings.join("; ") || "the paint makes no surface"}`);
const staging = join(store, `.${hash}.${process.pid}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(join(scratch, "decoration.glb"), join(staging, "decoration.glb"));
writeFileSync(
  join(staging, "meta.json"),
  JSON.stringify({ hash, request, landed, nodes: meta.nodes, warnings: meta.warnings, times: { prepare: prepared, export: exported }, builtAt: new Date().toISOString() }, null, 2) + "\n",
);
rmSync(dir, { recursive: true, force: true });
renameSync(staging, dir);
rmSync(scratch, { recursive: true, force: true });
for (const w of meta.warnings) console.log(`${TAG} WARNING ${w}`);
console.log(`${TAG} ${meta.nodes.length} objects, ${meta.nodes.reduce((t, n) => t + n.triangles, 0).toLocaleString()} triangles; prepare ${prepared.toFixed(1)}s, export ${exported.toFixed(1)}s`);
console.log(`DECORATION_BUILT ${JSON.stringify({ hash, landed })}`);
