// A formation's `geometry.glb` as the triangles a material layer's mask is
// rasterised from (src/formation/materialMask.ts): positions in the
// formation's frame (every node's world transform applied, as the editor's
// loader applies it, render3d/formations.ts) and the paint UV (TEXCOORD_0).

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import type { PaintUvMesh } from "../src/formation/materialMask";

export async function readPaintUvMeshes(file: string): Promise<PaintUvMesh[]> {
  await MeshoptDecoder.ready;
  const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder }).read(file);
  const out: PaintUvMesh[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      const uv = prim.getAttribute("TEXCOORD_0");
      if (!pos || !uv) continue;
      const n = pos.getCount();
      const positions = new Float32Array(n * 3);
      const uvs = new Float32Array(n * 2);
      const p = [0, 0, 0];
      const t = [0, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, p);
        const [x, y, z] = p as [number, number, number];
        positions[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        uv.getElement(i, t);
        uvs[i * 2] = t[0]!;
        uvs[i * 2 + 1] = t[1]!;
      }
      const idx = prim.getIndices();
      const index = idx ? Uint32Array.from(idx.getArray() as ArrayLike<number>) : Uint32Array.from({ length: n }, (_, i) => i);
      out.push({ positions, uvs, index });
    }
  }
  return out;
}
