// A solid guide's tree as one closed mesh (docs/formations.md, "Background
// guides").
//
// Each leaf is a primitive in its own frame, placed by its pose (scale, then
// the turn three.js would make of `rot` as Euler XYZ, then `pos`), and each
// inner node a union, difference (the first child less the rest) or
// intersection of its children, all exact in manifold-3d. Milliseconds for a
// guide of a few dozen primitives, so the editor meshes it on every edit.
//
// FRAMES. The tree is in the body's frame as the 3D view draws it (x right,
// y up, z toward the camera, metres). The solid generator takes Blender's:
// (x, y, z) here is (x, -z, y) there, a proper rotation, so a face's winding
// and its outward side survive the change.

import { type Manifold, manifold } from "./manifold";
import type { FormationData, SolidNode, SolidPose, SolidPrim } from "../level/levelFormat";
import { formationRecipe } from "./recipe";
import type { SolidMesh } from "./meshBin";

export type { SolidMesh, StoredMesh } from "./meshBin";

// The stored meshes a tree's mesh leaves name, by store name, as loaded.
export type MeshLibrary = ReadonlyMap<string, SolidMesh>;

export interface SolidResult {
  mesh: SolidMesh | null;
  // Why there is no mesh, or what was left out (a mesh leaf not yet loaded).
  error?: string;
  missing: string[];
}

// How many segments round a cylinder: a guide's coarse form.
const CYLINDER_SEGMENTS = 32;

// Column-major 4x4 of scale, then Euler XYZ (three.js's
// `makeRotationFromEuler`), then translation.
export function poseMatrix(p: SolidPose): number[] {
  const [sx, sy, sz] = p.scale ?? [1, 1, 1];
  const [x, y, z] = p.rot ?? [0, 0, 0];
  const [tx, ty, tz] = p.pos ?? [0, 0, 0];
  const a = Math.cos(x), b = Math.sin(x);
  const c = Math.cos(y), d = Math.sin(y);
  const e = Math.cos(z), f = Math.sin(z);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  // Rows of R = Rx Ry Rz.
  const r = [
    [c * e, -c * f, d],
    [af + be * d, ae - bf * d, -b * c],
    [bf - ae * d, be + af * d, a * c],
  ];
  return [
    r[0]![0]! * sx, r[1]![0]! * sx, r[2]![0]! * sx, 0,
    r[0]![1]! * sy, r[1]![1]! * sy, r[2]![1]! * sy, 0,
    r[0]![2]! * sz, r[1]![2]! * sz, r[2]![2]! * sz, 0,
    tx, ty, tz, 1,
  ];
}

// A stored mesh as a manifold, its vertices welded where they coincide
// (`merge`). Throws (manifold-3d's "Not manifold") for a mesh that is not
// closed and two-sided at every edge.
export function manifoldOfMesh(mesh: SolidMesh): Manifold {
  const m = new manifold.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices });
  m.merge();
  return new manifold.Manifold(m);
}

// A manifold's triangles as a stored mesh.
export function meshOfManifold(solid: Manifold): SolidMesh {
  const mesh = solid.getMesh();
  const positions = new Float32Array(mesh.numVert * 3);
  for (let i = 0; i < mesh.numVert; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * mesh.numProp + k]!;
  }
  return { positions, indices: new Uint32Array(mesh.triVerts) };
}

// A mesh as a guide stores it: through manifold-3d, as every load of the
// guide will mesh it (its constructor tidies a near-degenerate triangle by an
// edge swap), so what is stored is what is drawn and generated, exactly; or
// why manifold-3d will not take it as a solid. A sculpt's commit and a cut
// store this.
export function storedGuideMesh(mesh: SolidMesh): { mesh: SolidMesh } | { problem: string } {
  let solid: Manifold | null = null;
  try {
    solid = manifoldOfMesh(mesh);
    const status = solid.status();
    if (status !== "NoError") return { problem: `is not a closed solid (${status})` };
    if (solid.isEmpty()) return { problem: "encloses nothing" };
    return { mesh: meshOfManifold(solid) };
  } catch (e) {
    return { problem: `is not a closed solid (${(e as Error).message})` };
  } finally {
    solid?.delete();
  }
}

function primitive(n: SolidPrim, meshes: MeshLibrary, missing: string[]): Manifold | null {
  let m: Manifold;
  switch (n.prim) {
    case "box":
      m = manifold.Manifold.cube(n.size, true);
      break;
    case "cylinder": {
      // manifold's stands along z; turned -90° about x it stands along y
      // (z to y), then sized to the extents.
      const c = manifold.Manifold.cylinder(1, 1, 1, CYLINDER_SEGMENTS, true);
      const up = c.rotate([-90, 0, 0]);
      m = up.scale([n.size[0] / 2, n.size[1], n.size[2] / 2]);
      c.delete();
      up.delete();
      break;
    }
    case "mesh": {
      const stored = meshes.get(n.file);
      if (!stored) {
        missing.push(n.file);
        return null;
      }
      m = manifoldOfMesh(stored);
      break;
    }
  }
  const placed = m.transform(poseMatrix(n) as never);
  m.delete();
  return placed;
}

function build(n: SolidNode, meshes: MeshLibrary, missing: string[]): Manifold | null {
  if (!("op" in n)) return primitive(n, meshes, missing);
  const kids = n.of.map((c) => build(c, meshes, missing));
  const present = kids.filter((k): k is Manifold => k !== null);
  try {
    if (!present.length) return null;
    if (n.op === "union") return manifold.Manifold.union(present);
    if (n.op === "intersection") return manifold.Manifold.intersection(present);
    // Difference: the first child less every other. A first child that is
    // missing leaves nothing to cut from.
    if (kids[0] === null) return null;
    return present.length === 1 ? present[0]!.translate([0, 0, 0]) : manifold.Manifold.difference(present);
  } finally {
    for (const k of present) k.delete();
  }
}

// The tree as a manifold (the caller deletes it), or why there is none.
// Mesh leaves come from `meshes` by store name; one not there is left out
// and named in `missing`.
export function solidManifold(tree: SolidNode, meshes: MeshLibrary = new Map()): { solid: Manifold | null; error?: string; missing: string[] } {
  const missing: string[] = [];
  try {
    const solid = build(tree, meshes, missing);
    if (!solid || solid.isEmpty()) {
      solid?.delete();
      return { solid: null, error: "the guide encloses nothing", missing };
    }
    return { solid, missing };
  } catch (e) {
    return { solid: null, error: (e as Error).message, missing };
  }
}

// The tree's mesh. A mesh leaf not in `meshes` is left out and named in
// `missing`, so the editor can draw the rest while it loads.
export function solidMesh(tree: SolidNode, meshes: MeshLibrary = new Map()): SolidResult {
  const { solid, error, missing } = solidManifold(tree, meshes);
  if (!solid) return { mesh: null, error, missing };
  try {
    return { mesh: meshOfManifold(solid), missing };
  } catch (e) {
    return { mesh: null, error: (e as Error).message, missing };
  } finally {
    solid.delete();
  }
}

// Every store name a tree's mesh leaves use.
export function meshFiles(tree: SolidNode): string[] {
  if ("op" in tree) return tree.of.flatMap(meshFiles);
  return tree.prim === "mesh" ? [tree.file] : [];
}

// DECIMATION FOR THE GENERATOR (plans/sculpt-guides.md, phase 6): the
// generators were tuned on coarse guides, and a sculpt is 50k to 300k
// triangles, so a guide over DECIMATE_ABOVE is simplified (manifold-3d's
// `simplify`: a subset of its vertices, every surface within the tolerance)
// to a fraction of its size before the hand-over - a sculpt's density
// changes its shape, not how long a generate takes. No guide made before
// sculpting is that dense (the largest imported mesh is 20,152 triangles), so
// every one is handed over as it was. Measured in docs/formations.md.
const DECIMATE_ABOVE = 50_000;
// Of the guide's bounding-box diagonal: 9 mm on a 2 m rock.
const DECIMATE_TOLERANCE = 0.0025;
// The generator welds vertices nearer than this (`remove_doubles` in
// formations/solidfit.py, for meshes imported unwelded).
const BLENDER_WELD = 1e-5;
// How far a pinch's vertices are moved apart (`separatePinches`).
const PINCH_NUDGE = 3e-5;

// A mesh's positions with every PINCH opened a hair: manifold-3d keeps a
// point where two sheets of surface touch (a voxel remesh's saddle, a cut
// through touching geometry) as one vertex per sheet at the same spot, which
// is a valid solid - but Blender welds them, and the guide opens there
// ("not a closed mesh (2 non-manifold edges)", 2026-11-23, a remeshed
// sculpt). Each vertex within the weld distance of another is moved
// PINCH_NUDGE toward its own neighbours' mean, into its own sheet, so the
// copies part. A mesh with none is returned as it is.
function separatePinches(mesh: SolidMesh): Float32Array {
  const P = mesh.positions;
  const cell = BLENDER_WELD;
  const cells = new Map<string, number[]>();
  const pinched = new Set<number>();
  for (let i = 0; i < P.length / 3; i++) {
    const k = [0, 1, 2].map((a) => Math.floor(P[i * 3 + a]! / cell));
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of cells.get(`${k[0]! + dx},${k[1]! + dy},${k[2]! + dz}`) ?? []) {
            if (Math.hypot(P[i * 3]! - P[j * 3]!, P[i * 3 + 1]! - P[j * 3 + 1]!, P[i * 3 + 2]! - P[j * 3 + 2]!) < BLENDER_WELD) {
              pinched.add(i);
              pinched.add(j);
            }
          }
        }
      }
    }
    const key = k.join(",");
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  }
  if (!pinched.size) return P;
  const sum = new Map<number, [number, number, number, number]>();
  const I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const v = I[t + k]!;
      if (!pinched.has(v)) continue;
      const s = sum.get(v) ?? [0, 0, 0, 0];
      for (const w of [I[t + ((k + 1) % 3)]!, I[t + ((k + 2) % 3)]!]) {
        s[0] += P[w * 3]!;
        s[1] += P[w * 3 + 1]!;
        s[2] += P[w * 3 + 2]!;
        s[3]++;
      }
      sum.set(v, s);
    }
  }
  const out = P.slice();
  for (const [v, s] of sum) {
    const d = [s[0] / s[3] - P[v * 3]!, s[1] / s[3] - P[v * 3 + 1]!, s[2] / s[3] - P[v * 3 + 2]!];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (!(l > 0)) continue;
    for (let a = 0; a < 3; a++) out[v * 3 + a] = P[v * 3 + a]! + (d[a]! / l) * PINCH_NUDGE;
  }
  return out;
}

// What `formations/worker.py` is given for a solid formation: the guide mesh
// in Blender's frame, its variant and every parameter resolved. Throws with
// the guide's own reason when it has no mesh.
export function solidWorkerRecipe(
  f: Pick<FormationData, "generator" | "variant" | "params" | "guide">,
  meshes: MeshLibrary = new Map(),
): Record<string, unknown> {
  const r = formationRecipe(f);
  if (r.guide.kind !== "solid") throw new Error("an outline formation's worker recipe is built by guide.ts");
  const made = solidManifold(r.guide.tree, meshes);
  if (made.missing.length) {
    made.solid?.delete();
    throw new Error(`the guide's mesh ${made.missing.join(", ")} is not loaded`);
  }
  if (!made.solid) throw new Error(made.error ?? "the guide has no mesh");
  let handed: SolidMesh;
  try {
    handed = meshOfManifold(made.solid);
    if (handed.indices.length / 3 > DECIMATE_ABOVE) {
      const box = made.solid.boundingBox();
      const diagonal = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
      const coarse = made.solid.simplify(diagonal * DECIMATE_TOLERANCE);
      handed = meshOfManifold(coarse);
      coarse.delete();
    }
  } finally {
    made.solid.delete();
  }
  const { indices } = handed;
  const positions = separatePinches(handed);
  const verts: [number, number, number][] = [];
  const round = (v: number): number => Math.round(v * 1e6) / 1e6 || 0;
  for (let i = 0; i < positions.length; i += 3) verts.push([round(positions[i]!), round(-positions[i + 2]!), round(positions[i + 1]!)]);
  const faces: number[][] = [];
  for (let i = 0; i < indices.length; i += 3) faces.push([indices[i]!, indices[i + 1]!, indices[i + 2]!]);
  return { version: r.version, generator: "solid", variant: r.variant, params: r.params, guide: { verts, faces } };
}
