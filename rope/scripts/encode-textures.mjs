// Encode a glTF's textures in place, each by the first rule that claims it.
//
//   node scripts/encode-textures.mjs <file.glb> [--lossless-normals] [--baked-maps]
//
// The second half of `assets:optimize` when a flag there gives some maps an
// encoding of their own (scripts/optimize-asset.ts): `optimize` leaves the maps
// unencoded, and this encodes every one - by a rule where one applies, lossy
// WebP at 1k otherwise, which is what `optimize` would have done.
//
// It is the gltf-transform API rather than its `webp` command because that
// command DECODES `EXT_meshopt_compression` and writes the file back without
// it: a river scene went 4.2 MB -> 9.3 MB through one pass, the geometry
// shipped uncompressed. Reading with the decoder and writing with the encoder
// keeps the extension.
//
// Node, not Bun: sharp under Bun 2026-10 encoded the same lossy WebP three
// times from one PNG and returned two different images, one of them at a fifth
// of the brightness. Under Node (where gltf-transform's CLI already runs) the
// encode is stable.

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { textureCompress } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node scripts/encode-textures.mjs <file.glb> [--lossless-normals] [--baked-maps]");
  process.exit(2);
}

const STANDARD = 1024;
const rules = [];

// A map the scene export BAKED (tools/blender/scene_export.py names them
// "<object> baked colour" and "<object> baked normal") is painted stone at up
// to 2k, because its thin edge line needs 256 texels a metre where the game
// frame shows 200 pixels a metre (BALL_ZOOM at 1080p), and the Terrace's 34 m²
// only gets that at 2048. How it is stored was measured on that 2k Terrace:
// - lossy WebP smeared its dark, low-contrast facet tones into blocks and,
//   coding colour at half resolution, into purple and green blotches, at every
//   quality up to 100;
// - lossless WebP is exact but 1.17 MB a map, which put the river near 13 MB
//   against the store's 8 MB bar;
// - AVIF with full-resolution colour (4:4:4) at quality 90 is 114 KB, off by
//   0.77 levels (rms) of 255 and 8 at worst, and keeps the edge lines.
// A baked normal map stays lossless, for the reason `--lossless-normals` exists.
if (argv.includes("--baked-maps")) {
  rules.push({
    name: "baked colour, AVIF 4:4:4",
    pattern: / baked colour$/,
    targetFormat: "avif",
    quality: 90,
    chromaSubsampling: "4:4:4",
    resize: [2048, 2048],
  });
  rules.push({ name: "baked normal, lossless", pattern: / baked normal$/, targetFormat: "webp", lossless: true, resize: [2048, 2048] });
}
// A normal map whose detail is subtle codes as a grid of blocks (optimize-asset.ts).
if (argv.includes("--lossless-normals")) {
  rules.push({ name: "normal map, lossless", slots: /^normalTexture$/, targetFormat: "webp", lossless: true, resize: [STANDARD, STANDARD] });
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
const doc = await io.read(file);

// Each pass takes only maps still PNG or JPEG, so a map a rule encoded is never
// encoded again, and the last pass (everything else) gets exactly the rest.
const RAW = /^image\/(png|jpeg)$/;
const raw = () => doc.getRoot().listTextures().filter((t) => RAW.test(t.getMimeType())).length;
for (const { name, ...rule } of rules) {
  const before = raw();
  await doc.transform(textureCompress({ encoder: sharp, formats: RAW, ...rule }));
  console.log(`[assets] ${before - raw()} texture(s): ${name}`);
}
await doc.transform(textureCompress({ encoder: sharp, formats: RAW, targetFormat: "webp", resize: [STANDARD, STANDARD] }));
await io.write(file, doc);
