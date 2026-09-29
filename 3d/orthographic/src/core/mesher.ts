// Reconstructs an object's solid from its three normalised silhouettes,
// exactly: each view's outline is extruded along the view's direction across
// the unit box, and the solid is the intersection of the three prisms
// (manifold-3d). Pure; runs in the editor and in Bun alike, in milliseconds.

import { type CrossSection, type Manifold, type ManifoldVec3, manifold } from "./manifold";
import { polyArea } from "./ring";
import type { Part, Ring, Vec3, ViewId } from "./types";
import { VIEW_IDS } from "./views";

export const MESH_VERSION = "manifold-intersection-v2";

export interface PartMeta {
  /** The part's three outlines share no volume. */
  empty: boolean;
  /** Per view: the fraction of that silhouette the part's solid actually fills. */
  coverage: Record<ViewId, number>;
}

export interface MeshMeta {
  /** No part has a solid. */
  empty: boolean;
  parts: PartMeta[];
}

export interface Mesh {
  /** Vertex positions in the unit box, quantised to 0..65535. */
  pos: Uint16Array;
  /** Vertex normals in unit-box space (world normal times the object's size), quantised to -127..127. */
  norm: Int8Array;
  indices: Uint16Array | Uint32Array;
  meta: MeshMeta;
}

/** Faces meeting at more than this angle keep separate normals: a crease, drawn sharp. */
const CREASE_DEGREES = 35;
/** How far the prisms reach past the unit box, so their caps never coincide with another prism's faces. */
const REACH = 0.01;

// Each view's prism is built with its outline in the XY plane, extruded along
// +Z; these column-major matrices take that frame to the unit box, placing the
// outline's (horizontal, vertical) on the view's axes and Z on its depth axis.
const TO_BOX: Record<ViewId, number[]> = {
  // (u, v, depth) -> (x = u, y = depth, z = v)
  front: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  // (u, v, depth) -> (x = u, y = v, z = depth)
  top: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  // (u, v, depth) -> (x = depth, y = u, z = v)
  side: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
};
/** The inverse of TO_BOX (each is a permutation, so its transpose). */
const FROM_BOX: Record<ViewId, number[]> = Object.fromEntries(
  VIEW_IDS.map((v) => {
    const m = TO_BOX[v];
    const t = [...m];
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) t[c * 4 + r] = m[r * 4 + c];
    return [v, t];
  }),
) as Record<ViewId, number[]>;

/** A ring as a manifold cross-section (either winding). */
const crossSection = (ring: Ring): CrossSection =>
  manifold.CrossSection.ofPolygons([ring as [number, number][]], "NonZero");

/**
 * The exact solid of normalised outlines, in the unit box. The caller owns
 * the result and must delete() it.
 */
export function buildSolid(outlines: Record<ViewId, Ring>): Manifold {
  let solid: Manifold | null = null;
  for (const view of VIEW_IDS) {
    const section = crossSection(outlines[view]);
    const extruded = section.extrude(1 + 2 * REACH);
    const prism = extruded.translate([0, 0, -REACH]).transform(TO_BOX[view] as never);
    section.delete();
    extruded.delete();
    if (!solid) solid = prism;
    else {
      const next: Manifold = solid.intersect(prism);
      solid.delete();
      prism.delete();
      solid = next;
    }
  }
  return solid!;
}

/** The solid's shadow on a view's plane, in that view's normalised (horizontal, vertical) coordinates. Caller deletes. */
export function projectSolid(solid: Manifold, view: ViewId): CrossSection {
  const turned = solid.transform(FROM_BOX[view] as never);
  const shadow = turned.project();
  turned.delete();
  return shadow;
}

/**
 * An object's solid, the union of its parts' (each placed in its box within
 * the object's unit box), with each part's facts. The caller deletes it.
 */
export function objectSolid(parts: Part[]): { solid: Manifold; meta: MeshMeta } {
  const metas: PartMeta[] = [];
  const pieces: Manifold[] = [];
  for (const part of parts) {
    const unit = buildSolid(part.outlines);
    if (unit.isEmpty()) {
      metas.push({ empty: true, coverage: { front: 0, top: 0, side: 0 } });
      unit.delete();
      continue;
    }
    metas.push({ empty: false, coverage: coverageOf(unit, part.outlines) });
    const scaled = unit.scale(part.size as ManifoldVec3);
    unit.delete();
    pieces.push(scaled.translate(part.min as ManifoldVec3));
    scaled.delete();
  }
  const solid = pieces.length === 1 ? pieces[0] : manifold.Manifold.union(pieces);
  if (pieces.length !== 1) for (const p of pieces) p.delete();
  return { solid, meta: { empty: metas.every((m) => m.empty), parts: metas } };
}

/** Per view, the fraction of the outline's area the solid's shadow fills. */
function coverageOf(solid: Manifold, outlines: Record<ViewId, Ring>): Record<ViewId, number> {
  const out = {} as Record<ViewId, number>;
  for (const view of VIEW_IDS) {
    const shadow = projectSolid(solid, view);
    const want = Math.abs(polyArea(outlines[view]));
    out[view] = want > 0 ? Math.min(1, shadow.area() / want) : 1;
    shadow.delete();
  }
  return out;
}

const emptyMesh = (meta: MeshMeta): Mesh => ({
  pos: new Uint16Array(),
  norm: new Int8Array(),
  indices: new Uint16Array(),
  meta: { ...meta, empty: true },
});

/**
 * The object's surface for drawing. `size` (the object's box in metres) only
 * decides which edges are creases, since angles depend on the box's
 * proportions; the positions are in the unit box.
 */
export function buildMesh(parts: Part[], size: Vec3 = [1, 1, 1]): Mesh {
  const { solid, meta } = objectSolid(parts);
  try {
    if (solid.isEmpty()) return emptyMesh(meta);
    const m = solid.getMesh();
    return surface(m.vertProperties, m.numProp, m.triVerts, size, meta);
  } finally {
    solid.delete();
  }
}

/**
 * Quantise positions, drop triangles that quantising flattens, and give each
 * corner the normal of the faces around its vertex that meet its own face
 * within the crease angle, so curved outlines shade smoothly and corners stay
 * sharp.
 */
function surface(props: Float32Array, numProp: number, tris: Uint32Array, size: Vec3, meta: MeshMeta): Mesh {
  const count = props.length / numProp;
  // Quantise and weld: vertices that land on one quantised point become one.
  const qpos: number[] = [];
  const remap = new Int32Array(count);
  const welded = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const q = [0, 1, 2].map((k) => Math.round(Math.max(0, Math.min(1, props[i * numProp + k])) * 65535));
    const key = q[0] + 65536 * (q[1] + 65536 * q[2]);
    let v = welded.get(key);
    if (v === undefined) {
      v = qpos.length / 3;
      qpos.push(q[0], q[1], q[2]);
      welded.set(key, v);
    }
    remap[i] = v;
  }
  const faces: number[] = [];
  const faceNormals: number[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [remap[tris[i]], remap[tris[i + 1]], remap[tris[i + 2]]];
    if (a === b || b === c || a === c) continue;
    // The world-space normal, area weighted: edges scaled by the box.
    const e1 = [0, 1, 2].map((k) => ((qpos[b * 3 + k] - qpos[a * 3 + k]) / 65535) * size[k]);
    const e2 = [0, 1, 2].map((k) => ((qpos[c * 3 + k] - qpos[a * 3 + k]) / 65535) * size[k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
    faces.push(a, b, c);
    faceNormals.push(n[0], n[1], n[2]);
  }
  if (!faces.length) return emptyMesh(meta);
  const nf = faces.length / 3;
  const unit = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const len = Math.hypot(faceNormals[f * 3], faceNormals[f * 3 + 1], faceNormals[f * 3 + 2]);
    for (let k = 0; k < 3; k++) unit[f * 3 + k] = faceNormals[f * 3 + k] / len;
  }
  // Faces around each vertex.
  const around: number[][] = Array.from({ length: qpos.length / 3 }, () => []);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) around[faces[f * 3 + k]].push(f);
  const cosCrease = Math.cos((CREASE_DEGREES * Math.PI) / 180);
  const outPos: number[] = [];
  const outNorm: number[] = [];
  const outIndex: number[] = [];
  const corners = new Map<string, number>();
  for (let f = 0; f < nf; f++)
    for (let k = 0; k < 3; k++) {
      const v = faces[f * 3 + k];
      const n = [0, 0, 0];
      for (const g of around[v]) {
        const d = unit[f * 3] * unit[g * 3] + unit[f * 3 + 1] * unit[g * 3 + 1] + unit[f * 3 + 2] * unit[g * 3 + 2];
        if (d >= cosCrease) for (let j = 0; j < 3; j++) n[j] += faceNormals[g * 3 + j];
      }
      // Unit-box normal: the renderer divides by the size to get back to world space.
      const u = n.map((x, j) => x * size[j]);
      const len = Math.hypot(u[0], u[1], u[2]) || 1;
      const q = u.map((x) => Math.round((x / len) * 127));
      const key = `${v} ${q[0]} ${q[1]} ${q[2]}`;
      let index = corners.get(key);
      if (index === undefined) {
        index = outPos.length / 3;
        outPos.push(qpos[v * 3], qpos[v * 3 + 1], qpos[v * 3 + 2]);
        outNorm.push(q[0], q[1], q[2]);
        corners.set(key, index);
      }
      outIndex.push(index);
    }
  return {
    pos: Uint16Array.from(outPos),
    norm: Int8Array.from(outNorm),
    indices: outPos.length / 3 > 65535 ? Uint32Array.from(outIndex) : Uint16Array.from(outIndex),
    meta,
  };
}

/** Coverage below this fraction means the other views clip a noticeable part of a silhouette. */
export const COVERAGE_WARNING = 0.85;

/** Whether each part makes a solid, and how much of each outline it fills, without building a surface. */
export function solidMeta(parts: Part[]): MeshMeta {
  const { solid, meta } = objectSolid(parts);
  solid.delete();
  return meta;
}

/** The union of rings in one plane, as the polygons that bound it (outer outlines and holes, by winding). */
export function unionRings(rings: Ring[]): Ring[] {
  const sections = rings.map(crossSection);
  const union = manifold.CrossSection.union(sections);
  const out = union.toPolygons() as Ring[];
  for (const c of [...sections, union]) c.delete();
  return out;
}
