// Reconstructs an object's solid from its three normalised silhouettes: each
// view's outline becomes a signed-distance mask, the solid is where all three
// masks are inside, and marching tetrahedra extracts its surface. Pure; runs in
// a worker in the editor and directly in Bun for validation.

import type { Ring, ViewId } from "./types";

export const MESH_VERSION = "signed-distance-intersection-marching-tetrahedra-v1";

export interface MeshMeta {
  empty: boolean;
  /** Per view: the fraction of that silhouette the reconstructed solid actually fills. */
  coverage: Record<ViewId, number>;
  occupied: number;
  grid: number;
}

export interface Mesh {
  /** Vertex positions in the unit box, quantised to 0..65535. */
  pos: Uint16Array;
  /** Vertex normals, quantised to -127..127. */
  norm: Int8Array;
  indices: Uint16Array | Uint32Array;
  meta: MeshMeta;
}

function sdf(poly: Ring, x: number, y: number): number {
  let inside = false;
  let min = 1e20;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const den = dx * dx + dy * dy;
    const t = den ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / den)) : 0;
    min = Math.min(min, (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2);
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return (inside ? 1 : -1) * Math.sqrt(min);
}

export function buildMesh(outlines: Record<ViewId, Ring>, res = 40): Mesh {
  const n = res + 3;
  const nn = n * n;
  const total = nn * n;
  const coords = Array.from({ length: n }, (_, i) => (i - 1) / res);
  const field = new Float32Array(total);
  const masks = {} as Record<ViewId, Float32Array>;
  for (const v of ["front", "top", "side"] as ViewId[]) {
    const a = new Float32Array(nn);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) a[i + n * j] = sdf(outlines[v], coords[i], coords[j]);
    masks[v] = a;
  }
  let occupied = 0;
  const projected = { front: new Uint8Array(nn), top: new Uint8Array(nn), side: new Uint8Array(nn) };
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const d = Math.min(masks.front[x + n * z], masks.top[x + n * y], masks.side[y + n * z]);
        field[x + n * y + nn * z] = Math.abs(d) < 1e-9 ? -1e-9 : d;
        if (d > 0) {
          occupied++;
          projected.front[x + n * z] = 1;
          projected.top[x + n * y] = 1;
          projected.side[y + n * z] = 1;
        }
      }
  const coverage = {} as Record<ViewId, number>;
  for (const v of ["front", "top", "side"] as ViewId[]) {
    let demand = 0;
    let hit = 0;
    for (let i = 0; i < nn; i++)
      if (masks[v][i] > 0.6 / res) {
        demand++;
        if (projected[v][i]) hit++;
      }
    coverage[v] = demand ? hit / demand : 1;
  }
  if (!occupied)
    return {
      pos: new Uint16Array(),
      norm: new Int8Array(),
      indices: new Uint16Array(),
      meta: { empty: true, coverage, occupied: 0, grid: res },
    };

  const pts: number[] = [];
  const ind: number[] = [];
  const edgeMap = new Map<number, number>();
  const cornerOffsets = [0, 1, 1 + n, n, nn, nn + 1, nn + n + 1, nn + n];
  const tets = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
  ];
  const at = (index: number) => {
    const z = Math.floor(index / nn);
    const y = Math.floor((index - z * nn) / n);
    const x = index - z * nn - y * n;
    return [coords[x], coords[y], coords[z]];
  };
  const vertex = (i: number, j: number) => {
    if (i > j) [i, j] = [j, i];
    const key = i * total + j;
    let v = edgeMap.get(key);
    if (v !== undefined) return v;
    const a = at(i);
    const b = at(j);
    const t = field[i] / (field[i] - field[j]);
    v = pts.length / 3;
    pts.push(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]));
    edgeMap.set(key, v);
    return v;
  };
  const tri = (a: number, b: number, c: number, out: number[]) => {
    if (a === b || b === c || a === c) return;
    const ia = a * 3;
    const ib = b * 3;
    const ic = c * 3;
    const ab = [pts[ib] - pts[ia], pts[ib + 1] - pts[ia + 1], pts[ib + 2] - pts[ia + 2]];
    const ac = [pts[ic] - pts[ia], pts[ic + 1] - pts[ia + 1], pts[ic + 2] - pts[ia + 2]];
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    if (normal[0] * out[0] + normal[1] * out[1] + normal[2] * out[2] < 0) [b, c] = [c, b];
    ind.push(a, b, c);
  };
  const center = (ids: number[]) => ids.map(at).reduce((s, p) => s.map((v, i) => v + p[i] / ids.length), [0, 0, 0]);
  for (let z = 0; z < n - 1; z++)
    for (let y = 0; y < n - 1; y++)
      for (let x = 0; x < n - 1; x++) {
        const base = x + n * y + nn * z;
        const ci = cornerOffsets.map((q) => base + q);
        let count = 0;
        for (const k of ci) if (field[k] > 0) count++;
        if (count === 0 || count === 8) continue;
        for (const tet of tets) {
          const ins: number[] = [];
          const outs: number[] = [];
          for (const k of tet) (field[ci[k]] > 0 ? ins : outs).push(ci[k]);
          if (!ins.length || !outs.length) continue;
          const a = center(ins);
          const b = center(outs);
          const out = b.map((v, i) => v - a[i]);
          if (ins.length === 1) {
            const i = ins[0];
            tri(vertex(i, outs[0]), vertex(i, outs[1]), vertex(i, outs[2]), out);
          } else if (ins.length === 3) {
            const o = outs[0];
            tri(vertex(o, ins[0]), vertex(o, ins[1]), vertex(o, ins[2]), out);
          } else {
            const p = vertex(ins[0], outs[0]);
            const q = vertex(ins[0], outs[1]);
            const r = vertex(ins[1], outs[1]);
            const s = vertex(ins[1], outs[0]);
            tri(p, q, r, out);
            tri(p, r, s, out);
          }
        }
      }
  const normal = new Float32Array(pts.length);
  for (let i = 0; i < ind.length; i += 3) {
    const a = ind[i] * 3;
    const b = ind[i + 1] * 3;
    const c = ind[i + 2] * 3;
    const ab = [pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]];
    const ac = [pts[c] - pts[a], pts[c + 1] - pts[a + 1], pts[c + 2] - pts[a + 2]];
    const nrm = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    for (const j of [a, b, c]) for (let k = 0; k < 3; k++) normal[j + k] += nrm[k];
  }
  const pos = new Uint16Array(pts.length);
  const norm = new Int8Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    const len = Math.hypot(normal[i], normal[i + 1], normal[i + 2]) || 1;
    for (let k = 0; k < 3; k++) {
      pos[i + k] = Math.round(Math.max(0, Math.min(1, pts[i + k])) * 65535);
      norm[i + k] = Math.round((normal[i + k] / len) * 127);
    }
  }
  return {
    pos,
    norm,
    indices: pts.length / 3 > 65535 ? new Uint32Array(ind) : new Uint16Array(ind),
    meta: { empty: false, coverage, occupied, grid: res },
  };
}

/** Coverage below this fraction means the other views clip a noticeable part of a silhouette. */
export const COVERAGE_WARNING = 0.85;
