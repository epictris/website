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

import { type Manifold, manifold } from "../../../3d/orthographic/src/core/manifold";
import type { FormationData, SolidNode, SolidPose, SolidPrim } from "../level/levelFormat";
import { formationRecipe } from "./recipe";

// A fixed closed mesh in metres: what an imported mesh leaf names in the store.
export interface StoredMesh {
  verts: [number, number, number][];
  faces: number[][];
}

export interface SolidMesh {
  // Flat xyz, three per vertex, in the body's 3D frame.
  positions: Float32Array;
  // Three vertex indices per triangle, outward-facing counterclockwise.
  indices: Uint32Array;
}

export interface SolidResult {
  mesh: SolidMesh | null;
  // Why there is no mesh, or what was left out (a mesh leaf not yet loaded).
  error?: string;
  missing: string[];
}

// How many segments round an ellipsoid's equator: a guide's coarse form.
const ELLIPSOID_SEGMENTS = 32;

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

function primitive(n: SolidPrim, meshes: ReadonlyMap<string, StoredMesh>, missing: string[]): Manifold | null {
  let m: Manifold;
  switch (n.prim) {
    case "extrude": {
      if (n.outline.length < 3 || !(n.length > 0)) return null;
      const cs = manifold.CrossSection.ofPolygons([n.outline.map((q) => [q.x, q.y] as [number, number])], "NonZero");
      const top = Math.max(0, 1 - (n.taper ?? 0));
      m = manifold.Manifold.extrude(cs, n.length, 0, 0, [top, top]);
      cs.delete();
      break;
    }
    case "hull":
      if (n.points.length < 4) return null;
      m = manifold.Manifold.hull(n.points);
      break;
    case "box":
      m = manifold.Manifold.cube(n.size, true);
      break;
    case "ellipsoid": {
      const s = manifold.Manifold.sphere(1, ELLIPSOID_SEGMENTS);
      m = s.scale([n.size[0] / 2, n.size[1] / 2, n.size[2] / 2]);
      s.delete();
      break;
    }
    case "mesh": {
      const stored = meshes.get(n.file);
      if (!stored) {
        missing.push(n.file);
        return null;
      }
      const tris = stored.faces.flatMap((f) => f.slice(1, -1).flatMap((_, i) => [f[0]!, f[i + 1]!, f[i + 2]!]));
      const mesh = new manifold.Mesh({
        numProp: 3,
        vertProperties: new Float32Array(stored.verts.flat()),
        triVerts: new Uint32Array(tris),
      });
      mesh.merge();
      m = new manifold.Manifold(mesh);
      break;
    }
  }
  const placed = m.transform(poseMatrix(n) as never);
  m.delete();
  return placed;
}

function build(n: SolidNode, meshes: ReadonlyMap<string, StoredMesh>, missing: string[]): Manifold | null {
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

// The tree's mesh. Mesh leaves come from `meshes` by store name; one not
// there is left out and named in `missing`, so the editor can draw the rest
// while it loads.
export function solidMesh(tree: SolidNode, meshes: ReadonlyMap<string, StoredMesh> = new Map()): SolidResult {
  const missing: string[] = [];
  let solid: Manifold | null = null;
  try {
    solid = build(tree, meshes, missing);
    if (!solid || solid.isEmpty()) return { mesh: null, error: "the guide encloses nothing", missing };
    const mesh = solid.getMesh();
    const positions = new Float32Array(mesh.numVert * 3);
    for (let i = 0; i < mesh.numVert; i++) {
      for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * mesh.numProp + k]!;
    }
    return { mesh: { positions, indices: new Uint32Array(mesh.triVerts) }, missing };
  } catch (e) {
    return { mesh: null, error: (e as Error).message, missing };
  } finally {
    solid?.delete();
  }
}

// Every store name a tree's mesh leaves use.
export function meshFiles(tree: SolidNode): string[] {
  if ("op" in tree) return tree.of.flatMap(meshFiles);
  return tree.prim === "mesh" ? [tree.file] : [];
}

// What `formations/worker.py` is given for a solid formation: the guide mesh
// in Blender's frame, its variant and every parameter resolved. Throws with
// the guide's own reason when it has no mesh.
export function solidWorkerRecipe(
  f: Pick<FormationData, "generator" | "variant" | "params" | "guide">,
  meshes: ReadonlyMap<string, StoredMesh> = new Map(),
): Record<string, unknown> {
  const r = formationRecipe(f);
  if (r.guide.kind !== "solid") throw new Error("an outline formation's worker recipe is built by guide.ts");
  const result = solidMesh(r.guide.tree, meshes);
  if (result.missing.length) throw new Error(`the guide's mesh ${result.missing.join(", ")} is not loaded`);
  if (!result.mesh) throw new Error(result.error ?? "the guide has no mesh");
  const { positions, indices } = result.mesh;
  const verts: [number, number, number][] = [];
  const round = (v: number): number => Math.round(v * 1e6) / 1e6 || 0;
  for (let i = 0; i < positions.length; i += 3) verts.push([round(positions[i]!), round(-positions[i + 2]!), round(positions[i + 1]!)]);
  const faces: number[][] = [];
  for (let i = 0; i < indices.length; i += 3) faces.push([indices[i]!, indices[i + 1]!, indices[i + 2]!]);
  return { version: r.version, generator: "solid", variant: r.variant, params: r.params, guide: { verts, faces } };
}
