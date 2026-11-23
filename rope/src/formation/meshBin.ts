// A solid guide's stored meshes (`SolidPrim` "mesh", docs/formations.md "The
// store"), in their two forms, read into the one the editor and the build
// work in: flat typed arrays, three floats a vertex and three indices a
// triangle, in metres in the guide's frame.
//
// - JSON (`<sha256>.json`, named by the leaf `<sha256>`): `{verts, faces}`,
//   faces of any size, the form imported meshes have been kept in since
//   2026-11-22. About 60 bytes a vertex.
// - BINARY (`<sha256>.bin`, named by the leaf `<sha256>.bin`, since
//   2026-11-23, plans/sculpt-guides.md): a sculpted guide is 50k to 300k
//   triangles, so it is kept as a little-endian header and the arrays as
//   they are in memory, 12 bytes a vertex and 12 a triangle. Named by the
//   sha256 of the file's bytes, so the same mesh is stored once.
//
// Which form a leaf names is in its name, so a reader knows what to fetch
// without asking the store.

export interface SolidMesh {
  // Flat xyz, three per vertex, in the body's 3D frame.
  positions: Float32Array;
  // Three vertex indices per triangle, outward-facing counterclockwise.
  indices: Uint32Array;
}

// A fixed closed mesh in metres, as the JSON form holds it.
export interface StoredMesh {
  verts: [number, number, number][];
  faces: number[][];
}

// "RMSH" read as a little-endian u32.
const MAGIC = 0x48534d52;
const VERSION = 1;
const HEADER_BYTES = 16;

// A store name: a sha256, and `.bin` for the binary form.
export const MESH_NAME = /^[0-9a-f]{64}(\.bin)?$/;
export const isBinaryMeshName = (name: string): boolean => name.endsWith(".bin");

export function encodeMeshBin(mesh: SolidMesh): Uint8Array {
  const nv = mesh.positions.length / 3;
  const nt = mesh.indices.length / 3;
  const out = new Uint8Array(HEADER_BYTES + nv * 12 + nt * 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, nv, true);
  view.setUint32(12, nt, true);
  let at = HEADER_BYTES;
  for (let i = 0; i < mesh.positions.length; i++, at += 4) view.setFloat32(at, mesh.positions[i]!, true);
  for (let i = 0; i < mesh.indices.length; i++, at += 4) view.setUint32(at, mesh.indices[i]!, true);
  return out;
}

// The mesh a binary file holds, or throws with what is wrong with it: a
// file that is not one, a count that does not match its length, a vertex
// that is not finite or an index past the vertices.
export function decodeMeshBin(bytes: ArrayBuffer | Uint8Array): SolidMesh {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < HEADER_BYTES) throw new Error("not a mesh: shorter than its header");
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not a mesh: no RMSH magic");
  const version = view.getUint32(4, true);
  if (version !== VERSION) throw new Error(`a mesh of version ${version}; this reads ${VERSION}`);
  const nv = view.getUint32(8, true);
  const nt = view.getUint32(12, true);
  if (u8.length !== HEADER_BYTES + nv * 12 + nt * 12) throw new Error(`a mesh of ${nv} vertices and ${nt} triangles is not ${u8.length} bytes`);
  if (!nt) throw new Error("a mesh with no triangles");
  const positions = new Float32Array(nv * 3);
  const indices = new Uint32Array(nt * 3);
  let at = HEADER_BYTES;
  for (let i = 0; i < positions.length; i++, at += 4) {
    const v = view.getFloat32(at, true);
    if (!Number.isFinite(v)) throw new Error(`vertex ${Math.floor(i / 3)} is not finite`);
    positions[i] = v;
  }
  for (let i = 0; i < indices.length; i++, at += 4) {
    const k = view.getUint32(at, true);
    if (k >= nv) throw new Error(`triangle ${Math.floor(i / 3)} names vertex ${k} of ${nv}`);
    indices[i] = k;
  }
  return { positions, indices };
}

// The JSON form as typed arrays, each face a fan of triangles.
export function meshOfStored(stored: StoredMesh): SolidMesh {
  const positions = new Float32Array(stored.verts.length * 3);
  stored.verts.forEach((v, i) => positions.set(v, i * 3));
  const tris: number[] = [];
  for (const f of stored.faces) for (let i = 1; i + 1 < f.length; i++) tris.push(f[0]!, f[i]!, f[i + 1]!);
  return { positions, indices: new Uint32Array(tris) };
}

// A stored file's bytes as the mesh, by the name's form.
export function readStoredMesh(name: string, bytes: ArrayBuffer | Uint8Array): SolidMesh {
  if (isBinaryMeshName(name)) return decodeMeshBin(bytes);
  const text = new TextDecoder().decode(bytes);
  return meshOfStored(JSON.parse(text) as StoredMesh);
}
