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
//                        own limit (see "The asset store" in CLAUDE.md).
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
//   --simplify false     geometry is left ALONE **by default**. Mesh decimation
//                        is an art decision - it changes the silhouette, and the
//                        silhouette is what this game's look is made of - so it
//                        is not something a build step gets to do quietly to
//                        every prop that passes through.
//
// What that argument does NOT justify is refusing decimation outright, which is
// where this stood until a 3 x 3 m background wall panel turned out to be
// carrying 134,041 triangles. It is one of a UE5 **Nanite** set: authored for
// virtualized geometry that streams its own detail, dropped into a three.js
// scene that has no LOD at all and draws every triangle of it, four times over,
// two metres behind a gameplay plane viewed almost orthographically. Its brick
// relief is in a normal map, so at a tenth of the triangles the same frame
// differs by 1.5% RMSE - and the level had 768k triangles of wall in it, which
// the water's transmission pass then rendered a SECOND time every frame (see
// "Water" and "The asset store" in CLAUDE.md).
//
// So `--simplify <ratio>` is opt-in, per asset, and recorded: the ratio lives in
// that asset's `MESH_ASSETS` entry next to its sha256, which makes it a decision
// somebody made about a particular prop rather than a default applied to props
// nobody looked at. The default is still to leave geometry alone.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const simplifyAt = argv.indexOf("--simplify");
// Pulled out of the positionals so the two paths take the same `<in> <out>`.
// Guarded on the flag being present at all: an absent one is index -1, and
// skipping `simplifyAt + 1` would then skip index 0 - which silently ate the
// INPUT path on the default (no-decimation) invocation, leaving `output`
// undefined and the command printing its own usage.
const simplify = simplifyAt === -1 ? null : Number(argv[simplifyAt + 1]);
const [input, output] =
  simplifyAt === -1
    ? argv
    : argv.filter((_, i) => i !== simplifyAt && i !== simplifyAt + 1);
if (!input || !output) {
  console.error(
    "usage: bun run assets:optimize <input.glb|gltf> <public/meshes/out.glb> [--simplify <ratio>]",
  );
  process.exit(2);
}
if (simplify !== null && !(simplify > 0 && simplify <= 1)) {
  console.error(`--simplify takes a ratio in (0, 1]: got ${argv[simplifyAt + 1]}`);
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
    ...(simplify === null
      ? ["--simplify", "false"]
      : [
          "--simplify",
          "true",
          "--simplify-ratio",
          String(simplify),
          // A fraction of the mesh's own extent, so it means the same thing on a
          // 3 m wall and a 20 cm lamp. Loose enough that the ratio is what
          // binds - a tight error budget quietly stops the decimation early and
          // reports success, which reads as the flag not working.
          "--simplify-error",
          "0.01",
        ]),
  ],
  { stdio: "inherit" },
);
if (r.status !== 0) process.exit(r.status ?? 1);

const after = statSync(output).size;
const mb = (b: number) => `${(b / (1024 * 1024)).toFixed(2)} MB`;
console.log(`[assets] ${mb(before)} -> ${mb(after)} (${(after / before * 100).toFixed(0)}%)  ${output}`);
if (simplify !== null) {
  console.log(`[assets] simplified to ratio ${simplify} - record it as \`simplify: ${simplify}\``);
  console.log(`[assets] in this prop's MESH_ASSETS entry, beside its sha256.`);
}
console.log(`[assets] next: \`bun run assets:publish ${output}\` uploads it and prints its`);
console.log(`[assets] MESH_ASSETS entry, sha256 included.`);
