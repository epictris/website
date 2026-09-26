// Triangles in a GLB, read from its JSON chunk alone: an index accessor's count
// (or, unindexed, the POSITION accessor's) is the vertex count of the draw, so
// no binary buffer needs decoding. Blender prints a face count too, but that is
// the count BEFORE the exporter's own triangulation and splits, while this is
// the count three.js will draw.

// glTF primitive modes that draw triangles, and how a vertex count becomes a
// triangle count for each (TRIANGLES 4, TRIANGLE_STRIP 5, TRIANGLE_FAN 6).
const TRIANGLES = (mode: number, count: number): number =>
  mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;

interface Primitive { mode?: number; indices?: number; attributes: Record<string, number> }
interface Gltf {
  accessors?: { count: number }[];
  meshes?: { primitives: Primitive[] }[];
  nodes?: { mesh?: number }[];
}

export function glbJson(bytes: Uint8Array): Gltf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // "glTF" little-endian, then version, then total length (bytes).
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const length = view.getUint32(12, true);
  // The first chunk of a GLB is always its JSON ("JSON" = 0x4e4f534a).
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error("GLB has no JSON chunk first");
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}

export function glbTriangles(bytes: Uint8Array): number {
  const gltf = glbJson(bytes);
  const accessors = gltf.accessors ?? [];
  const meshTriangles = (gltf.meshes ?? []).map((mesh) =>
    mesh.primitives.reduce((sum, p) => {
      const accessor = p.indices ?? p.attributes.POSITION;
      return sum + (accessor === undefined ? 0 : TRIANGLES(p.mode ?? 4, accessors[accessor]?.count ?? 0));
    }, 0),
  );
  // A mesh drawn by two nodes is drawn twice; one never placed is not drawn.
  const placed = (gltf.nodes ?? []).filter((n) => n.mesh !== undefined);
  return placed.length
    ? placed.reduce((sum, n) => sum + (meshTriangles[n.mesh!] ?? 0), 0)
    : meshTriangles.reduce((a, b) => a + b, 0);
}
