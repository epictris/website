// Props out of a model PACK, as one standalone raw model the rest of the asset
// pipeline can take.
//
//   bun run assets:extract ~/Downloads/pbr_rock_cliffs_pack.glb assets-src/rocks.glb \
//     Cliffs_SmallStone_1=rock-1 Cliffs_SmallStone_2=rock-2 ...
//
// A pack is a single file holding dozens of props laid out in a row, sharing a
// handful of materials, and exported by whatever tool the author used - which is
// to say it is a SCENE, not an asset. Four things about it are wrong for a prop,
// and all four are fixed here rather than downstream:
//
//   THE UNITS AND THE AXES. A Sketchfab/FBX export wraps its contents in nodes
//   carrying the centimetres-to-metres scale and the Z-up-to-Y-up rotation, so a
//   node lifted out of the tree on its own is fifty times too big and lying on
//   its side. Each node's WORLD transform is baked into its vertices, so what
//   comes out is in metres, Y-up, and needs no `scale`/`rotX` in its
//   MESH_ASSETS entry - which is the point: 24 rocks out of one pack would
//   otherwise be 24 copies of the same two constants, and one of them typed
//   wrong is a rock that looks right in the editor and wrong in the level.
//
//   WHERE IT STOOD IN THE PACK. That world transform's TRANSLATION is the prop's
//   place in the pack's layout - metres away from its own geometry - and
//   `mountVisual` positions a prop by its file origin (see `MeshAsset.center`),
//   so keeping it would put every rock somewhere other than where the level put
//   it. Only rotation and scale are baked; the translation is dropped, which
//   leaves each prop on the origin its modeller gave it. That is deliberately
//   NOT `assets:optimize --center`: a pack prop is normally modelled about its
//   own centre already, and re-centring on the bounding box would move the
//   origin of any that is not - a boulder modelled to sit on its base, say.
//
//   EVERYTHING ELSE IN THE FILE. Only the named nodes' meshes are copied, so the
//   materials they use come with them and the pack's other texture sets - tens
//   of megabytes of them - do not.
//
//   THE NAMES. A node is renamed to the manifest key that will address it, so
//   the shipped file reads as a list of props rather than as somebody else's
//   naming scheme, and `loadMesh` can find one by the name the level author
//   typed.
//
// WHY ONE FILE RATHER THAN ONE PER PROP. Because a pack shares its materials,
// and a texture set is the overwhelming majority of a prop's bytes: the 24
// rocks are 20 KB of geometry each and 370 KB of 1k maps they all have in
// common, so 24 files is 9.4 MB of which 8.7 MB is the same three images
// copied out 24 times - paid again on download, and again in VRAM, every time a
// level scatters more than one of them. Extracted together they are one 0.9 MB
// file, one fetch and one upload however many of them a level uses. That is
// what `MeshAsset.node` is for: several manifest keys naming one file, each
// addressing a node inside it.
//
// The output is a RAW model, exactly like a single-prop download: it still has
// to go through `assets:optimize --keep-nodes` (the `--keep-nodes` is not
// optional here - the default pipeline joins meshes that share a material,
// which for a pack means all 24 rocks welded into one object with no names
// left to address) and then `assets:publish`. Extraction is a separate step
// from those because it is the one that takes decisions - which nodes, and what
// each prop is called - and because a pack is only re-extractable if the node
// name behind each prop is written down. That somewhere is the prop's
// MESH_ASSETS entry, beside its `source`.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Document, NodeIO, type Node as GLTFNode, type mat4 } from "@gltf-transform/core";
import {
  copyToDocument,
  createDefaultPropertyResolver,
  dedup,
  prune,
  transformMesh,
} from "@gltf-transform/functions";

const [pack, output, ...specs] = process.argv.slice(2);
if (!pack || !output || specs.length === 0) {
  console.error(
    "usage: bun run assets:extract <pack.glb> <out.glb> <NodeName>[=<prop-name>] ...",
  );
  process.exit(2);
}
if (!existsSync(pack)) {
  console.error(`no such file: ${pack}`);
  process.exit(2);
}

const io = new NodeIO();
const source = await io.read(resolve(pack));
const sourceNodes = source.getRoot().listNodes();

// The name a person reading the pack in a viewer sees is the node; the mesh
// under it is usually a child the exporter added per material. Either is a fair
// thing to type on the command line, so both resolve to the same prop.
function findMeshNode(name: string): GLTFNode {
  const named = sourceNodes.find((n) => n.getName() === name);
  if (!named) {
    console.error(`no node named "${name}" in ${pack}`);
    console.error(
      `  ${sourceNodes.length} nodes, e.g. ${sourceNodes.slice(0, 5).map((n) => n.getName()).join(", ")}`,
    );
    process.exit(2);
  }
  const withMesh = named.getMesh() ? named : named.listChildren().find((c) => c.getMesh());
  if (!withMesh) {
    console.error(`node "${name}" carries no mesh, and neither does any child of it`);
    process.exit(2);
  }
  return withMesh;
}

const target = new Document();
const scene = target.createScene(output.replace(/^.*\//, "").replace(/\.[^.]+$/, ""));
// ONE resolver across every copy, which is what makes the shared material and
// its textures cross over once rather than once per prop. Without it each
// `copyToDocument` brings its own copy of `Mat_Cliffs` and the file is 24 times
// the size for identical pixels - the exact cost this command exists to avoid.
const resolver = createDefaultPropertyResolver(target, source);

for (const spec of specs) {
  const [nodeName, propName = nodeName] = spec.split("=");
  const meshNode = findMeshNode(nodeName!);
  const sourceMesh = meshNode.getMesh()!;

  // The world matrix with its translation column zeroed: the rotation and scale
  // of every wrapper node above this one, applied to the vertices, and none of
  // the pack layout's placement.
  const world = [...meshNode.getWorldMatrix()] as mat4;
  world[12] = 0;
  world[13] = 0;
  world[14] = 0;

  const mesh = copyToDocument(target, source, [sourceMesh], resolver).get(
    sourceMesh,
  ) as ReturnType<Document["createMesh"]>;
  transformMesh(mesh, world);
  mesh.setName(propName!);
  scene.addChild(target.createNode(propName!).setMesh(mesh));
}

// `copyToDocument` brings the materials and their textures and nothing else,
// but the pack's own scenes and animation channels can drag other properties
// across behind them; prune is what makes "only these props" true rather than
// intended. `dedup` is the belt to the resolver's braces - it collapses any
// material or texture that did come over twice, so a pack whose props were
// authored with per-prop copies of one material still ships one.
await target.transform(prune(), dedup());

mkdirSync(dirname(resolve(output)), { recursive: true });
await io.write(resolve(output), target);

for (const node of scene.listChildren()) {
  const prim = node.getMesh()!.listPrimitives()[0]!;
  const pos = prim.getAttribute("POSITION")!;
  const min = pos.getMinNormalized([0, 0, 0]) as number[];
  const max = pos.getMaxNormalized([0, 0, 0]) as number[];
  const tris = (prim.getIndices()?.getCount() ?? pos.getCount()) / 3;
  console.log(
    `[assets] ${node.getName().padEnd(12)} ${String(tris).padStart(6)} tris  ` +
      `${min.map((v, i) => (max[i]! - v).toFixed(2)).join(" x ")} m`,
  );
}
const stem = output.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
console.log(
  `[assets] ${scene.listChildren().length} prop(s) -> ${output}, ` +
    `sharing ${target.getRoot().listMaterials().length} material(s) and ` +
    `${target.getRoot().listTextures().length} texture(s)`,
);
console.log(`[assets] next: \`bun run assets:optimize ${output} public/meshes/${stem}.glb --keep-nodes\``);
