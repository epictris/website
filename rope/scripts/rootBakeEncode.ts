// A level's roots as the GLB the game reads (`src/render3d/rootBake.ts`):
// one node per body, named by its key, holding one mesh node per branch,
// named by its object index. Used by `roots:bake`, and by `cli roots`, which
// reads one back through the game's own loader.

import { Document, NodeIO, type Buffer as GltfBuffer, type Node as GltfNode } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { quantize, reorder } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import type * as THREE from "three";

import { rootBodyNodeName, rootPieceNodeName } from "../src/render3d/rootBake";

export interface BakedBody {
  key: string;
  meshes: ReadonlyMap<number, THREE.BufferGeometry>;
}

export async function encodeRootBake(name: string, bodies: readonly BakedBody[]): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(name);
  const written = new Set<string>();
  for (const { key, meshes } of bodies) {
    // Two bodies grown from the same curves in the same place are the same
    // meshes; the bake holds them once.
    if (written.has(key)) continue;
    written.add(key);
    const node = doc.createNode(rootBodyNodeName(key));
    scene.addChild(node);
    for (const [index, geometry] of meshes) node.addChild(pieceNode(doc, buffer, index, geometry));
  }
  // Positions as 16-bit integers over each mesh's own bounds (a twentieth of
  // a millimetre on a metre and a half of root), normals at 12 bits, and the
  // two bark ramps at 12; the bark coordinates run past 1 and stay float, as
  // do the colours, which run past 1 too.
  await doc.transform(
    reorder({ encoder: MeshoptEncoder }),
    quantize({
      pattern: /^(POSITION|NORMAL|_ROOTAGE|_ROOTJOIN)$/,
      quantizePosition: 16,
      quantizeNormal: 12,
      quantizeGeneric: 12,
    }),
  );
  doc.createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  return io.writeBinary(doc);
}

// One branch's mesh as a node: every attribute the bark's material reads,
// the two of its own as glTF's application-specific `_` attributes.
function pieceNode(doc: Document, buffer: GltfBuffer, index: number, geometry: THREE.BufferGeometry): GltfNode {
  const primitive = doc.createPrimitive();
  const semantics: Record<string, string> = {
    position: "POSITION",
    normal: "NORMAL",
    uv: "TEXCOORD_0",
    color: "COLOR_0",
    rootAge: "_ROOTAGE",
    rootJoin: "_ROOTJOIN",
  };
  for (const [name, semantic] of Object.entries(semantics)) {
    const attribute = geometry.getAttribute(name);
    if (!attribute) throw new Error(`root mesh ${index} has no ${name}`);
    const type = ({ 1: "SCALAR", 2: "VEC2", 3: "VEC3" } as const)[attribute.itemSize as 1 | 2 | 3];
    primitive.setAttribute(
      semantic,
      doc.createAccessor().setType(type).setArray(new Float32Array(attribute.array as Float32Array)).setBuffer(buffer),
    );
  }
  const indices = geometry.getIndex()!.array;
  primitive.setIndices(
    doc.createAccessor().setType("SCALAR")
      .setArray(indices instanceof Uint16Array ? new Uint16Array(indices) : new Uint32Array(indices))
      .setBuffer(buffer),
  );
  return doc.createNode(rootPieceNodeName(index)).setMesh(doc.createMesh().addPrimitive(primitive));
}
