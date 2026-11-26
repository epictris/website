// Bake one library material onto one formation's rock into the store
// (docs/formations.md, "Material layers").
//
//   bun run scripts/material-layer-build.ts <host hash> <material> [--force] [--store DIR] [--side N] [--library FILE]
//
// `material` names `assets-src/materials/<material>.blend`, whose material of
// the same name (any case) is a Principled BSDF authored in Blender
// (tools/blender/material_starter.py wrote the first). The bake is
// tools/blender/material_layer.py on the host's `rock.blend`; its hash
// (`materialLayerHash`: the host, the material's name and the library file's
// bytes) names the result. `--library` bakes from another file (the tests'
// constant material):
//
//   <store>/<hash>/color.png     the material's Base Color in the paint UV
//   <store>/<hash>/surface.png   roughness, metallic, height
//   <store>/<hash>/normal.png    its tangent-space normal
//   <store>/<hash>/meta.json     what was asked and what came of it
//
// The last line on success is `MATERIAL_LAYER_BUILT <json>`.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { materialLayerHash, MATERIAL_LAYER_FILES, materialLibraryFile } from "../src/formation/materialLayer";
import { sha256Bytes } from "../src/formation/sha256";
import { FORMATION_HASH, ROCK_FILE } from "../src/formation/store";
import { ROOT } from "./blendExport";

const TAG = "[material-layer]";
const fail = (msg: string): never => {
  console.error(`${TAG} ${msg}`);
  process.exit(1);
};
const usage = "usage: bun run scripts/material-layer-build.ts <host hash> <material> [--force] [--store DIR] [--side N] [--library FILE]";
const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const host = process.argv[2] ?? fail(usage);
const material = (process.argv[3] ?? fail(usage)).toLowerCase();
if (!FORMATION_HASH.test(host)) fail(`no host build ${host}`);
const store = flag("--store") ?? join(ROOT, "public", "generated");
const side = flag("--side");
const rock = join(store, host, ROCK_FILE);
if (!existsSync(rock)) fail(`the store has no ${relative(ROOT, rock)}: generate the formation first`);
const library = flag("--library") ?? join(ROOT, materialLibraryFile(material));
if (!existsSync(library)) fail(`no library material ${relative(ROOT, library)}`);
const libraryHash = sha256Bytes(new Uint8Array(readFileSync(library)));
const request = { host, material, library: libraryHash, ...(side ? { side: Number(side) } : {}) };
const hash = materialLayerHash(request);
const dir = join(store, hash);
if (MATERIAL_LAYER_FILES.every((f) => existsSync(join(dir, f))) && !process.argv.includes("--force")) {
  console.log(`${TAG} ${hash.slice(0, 12)}: in the store`);
  console.log(`MATERIAL_LAYER_BUILT ${JSON.stringify({ hash })}`);
  process.exit(0);
}

console.log(`${TAG} ${hash.slice(0, 12)}: ${material} on ${host.slice(0, 12)}`);
mkdirSync(join(ROOT, ".cache"), { recursive: true });
const scratch = mkdtempSync(join(ROOT, ".cache", "material-layer-"));
const t0 = performance.now();
const bake = spawnSync(
  process.env["BLENDER_PATH"] ?? "blender",
  [
    "-b", rock, "--factory-startup", "--python-exit-code", "1",
    "--python", join(ROOT, "tools", "blender", "material_layer.py"),
    "--", library, material, scratch, ...(side ? [side] : []),
  ],
  { encoding: "utf8" },
);
const out = bake.stdout + bake.stderr;
if (bake.status !== 0 || !MATERIAL_LAYER_FILES.every((f) => existsSync(join(scratch, f)))) {
  writeFileSync(join(scratch, "bake.log"), out);
  const why = out.split("\n").find((l) => l.includes("REGENERATE:"));
  if (why) fail(why.slice(why.indexOf("REGENERATE:") + "REGENERATE:".length).trim());
  console.error(out.split("\n").filter((l) => l.trim()).slice(-10).join("\n"));
  fail(`material_layer.py failed; its output is in ${relative(ROOT, join(scratch, "bake.log"))}`);
}
const baked = JSON.parse(readFileSync(join(scratch, "layer.json"), "utf8")) as { size: number; texels: number; device: string; height: boolean };
const seconds = (performance.now() - t0) / 1000;
const staging = join(store, `.${hash}.${process.pid}`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const f of MATERIAL_LAYER_FILES) cpSync(join(scratch, f), join(staging, f));
writeFileSync(
  join(staging, "meta.json"),
  JSON.stringify({ hash, request, layer: baked, times: { bake: seconds }, builtAt: new Date().toISOString() }, null, 2) + "\n",
);
rmSync(dir, { recursive: true, force: true });
renameSync(staging, dir);
rmSync(scratch, { recursive: true, force: true });
console.log(`${TAG} ${baked.size}x${baked.size}, ${baked.texels.toLocaleString()} texels${baked.height ? "" : ", no height AOV (flat)"}, ${baked.device}, ${seconds.toFixed(1)}s`);
console.log(`MATERIAL_LAYER_BUILT ${JSON.stringify({ hash })}`);
