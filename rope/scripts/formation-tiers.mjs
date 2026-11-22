// A baked formation's lower tiers, derived from its finest (docs/formations.md,
// "Level of detail").
//
//   node scripts/formation-tiers.mjs <dir>/tier-0.glb <dir> [--max N]
//
// Tier k has 1/4^k of tier 0's triangles (meshoptimizer's simplifier) and its
// maps at 1/2^k the side, re-encoded as the bake's were (AVIF 4:4:4, quality
// 90: encode-textures.mjs's rule for baked maps). Tiers stop at --max (3) or
// where the colour map would fall under MIN_COLOUR or the mesh under
// MIN_TRIANGLES, whichever comes first.
//
// A formation is flat-shaded: every face carries its own normal, so tier 0's
// vertices are split face by face and the simplifier could collapse nothing.
// A lower tier drops the normals, welds by position and UV, simplifies, splits
// the faces again and gives each its own normal: what the baked normal map was
// baked against (the face's own tangent space) for every face that survives,
// and nearly so for the ones it merged.
//
// Prints `TIERS <json>`: every tier's triangles, map sides and bytes, tier 0
// included.
//
// Node, not Bun, for encode-textures.mjs's reason (sharp under Bun).

import { renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dequantize, normals, quantize, simplify, textureCompress, unweld, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const argv = process.argv.slice(2);
const [tier0, dir] = argv;
const maxAt = argv.indexOf("--max");
const MAX = maxAt === -1 ? 3 : Number(argv[maxAt + 1]);
if (!tier0 || !dir || !(MAX >= 0)) {
  console.error("usage: node scripts/formation-tiers.mjs <tier-0.glb> <dir> [--max N]");
  process.exit(2);
}
const MIN_COLOUR = 128;
const MIN_TRIANGLES = 400;

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

function facts(doc, bytes) {
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      triangles += (idx ? idx.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
    }
  }
  const side = (re) => {
    let s = 0;
    for (const t of doc.getRoot().listTextures()) {
      if (re.test(t.getName())) s = Math.max(s, t.getSize()?.[0] ?? 0);
    }
    return s;
  };
  return { triangles: Math.round(triangles), colour: side(/ baked colour$/), normal: side(/ baked normal$/), bytes };
}

const base = await io.read(tier0);
const tiers = [facts(base, statSync(tier0).size)];
for (let k = 1; k <= MAX; k++) {
  const prev = tiers[0];
  const colour = Math.floor(prev.colour / 2 ** k);
  const normal = Math.floor(prev.normal / 2 ** k);
  const ratio = 1 / 4 ** k;
  if ((prev.colour && colour < MIN_COLOUR) || prev.triangles * ratio < MIN_TRIANGLES) break;
  const doc = await io.read(tier0);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) prim.setAttribute("NORMAL", null);
  }
  await doc.transform(
    dequantize(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01 }),
    unweld(),
    normals({ overwrite: true }),
    quantize(),
  );
  for (const [re, side] of [[/ baked colour$/, colour], [/ baked normal$/, normal]]) {
    if (!side) continue;
    await doc.transform(
      textureCompress({ encoder: sharp, pattern: re, formats: /^image\/avif$/, targetFormat: "avif", quality: 90, chromaSubsampling: "4:4:4", resize: [side, side] }),
    );
  }
  const out = join(dir, `tier-${k}.glb`);
  // Written beside and renamed, so a reader never meets half a file.
  writeFileSync(`${out}.partial`, await io.writeBinary(doc));
  renameSync(`${out}.partial`, out);
  tiers.push(facts(doc, statSync(out).size));
}
console.log(`TIERS ${JSON.stringify(tiers)}`);
