// One raw model in, one shippable `.glb` out.
//
//   bun run assets:optimize ~/Downloads/boulder.glb public/meshes/boulder.glb
//
// This is a pinned, recorded pipeline rather than a command in a document
// because the settings ARE the decision: a prop exported straight out of Blender
// is five to ten times the size of the same prop through here, looks identical,
// and nothing downstream reports the difference (see `cli assets` for why that
// matters). Running the same flags every time is also what stops one prop
// arriving with 2k textures because it was optimised on a different day.
//
// What each flag is for:
//   --compress meshopt   geometry and animation, quantized + entropy coded.
//                        Chosen over Draco: decode is far cheaper, three.js
//                        needs no separate decoder blob, and the size is close.
//   --texture-compress webp / --texture-size 1024
//                        textures at a ceiling of 1k, which is the art style's
//                        own limit (see "Prop assets" in CLAUDE.md).
//                        WebP rather than KTX2 deliberately, for two reasons
//                        that both have to be paid to make KTX2 worth it: it
//                        needs the external `ktx` binary at build time, and it
//                        needs `KTX2Loader` plus its transcoder wired into
//                        `loadMesh`, which today is a plain `GLTFLoader`. WebP
//                        needs neither - three.js reads it through
//                        `EXT_texture_webp` - and is a few percent off KTX2 on
//                        disk. What KTX2 buys is staying compressed in VRAM,
//                        which is a decision for when there are enough props
//                        for VRAM to be the constraint. It is not now.
//   --simplify false     geometry is left ALONE. Mesh decimation is an art
//                        decision - it changes the silhouette, and the
//                        silhouette is what this game's look is made of - so it
//                        belongs in the modelling tool, where it can be seen,
//                        rather than in a build step that quietly reshapes what
//                        someone authored.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: bun run assets:optimize <input.glb|gltf> <public/meshes/out.glb>");
  process.exit(2);
}
if (!existsSync(input)) {
  console.error(`no such file: ${input}`);
  process.exit(2);
}

const before = statSync(input).size;
const r = spawnSync(
  "bunx",
  [
    "@gltf-transform/cli",
    "optimize",
    resolve(input),
    resolve(output),
    "--compress",
    "meshopt",
    "--texture-compress",
    "webp",
    "--texture-size",
    "1024",
    "--simplify",
    "false",
  ],
  { stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);

const after = statSync(output).size;
const mb = (b: number) => `${(b / (1024 * 1024)).toFixed(2)} MB`;
console.log(`[assets] ${mb(before)} -> ${mb(after)} (${(after / before * 100).toFixed(0)}%)  ${output}`);
console.log(`[assets] add it to MESH_ASSETS in src/render3d/assets.ts with its source and licence,`);
console.log(`[assets] then \`bun run replay assets\` to check it against the budget.`);
