// REMESH (plans/sculpt-guides.md, "Dynamic remeshing"; Blender's voxel
// remesh, Ctrl+R): the whole mesh rebuilt as the zero set of its signed
// distance at a grid of the detail size, by manifold-3d's `levelSet`, which
// answers a closed two-manifold whatever went in. What repairs a guide that
// heavy grabbing folded through itself, and what a commit falls back on when
// the mesh is not a valid solid (`commitCheck`).
//
// The distance is sampled once on a grid (so `levelSet`'s callback is a
// lookup, not a search):
// - its SIGN by winding number: a ray along +z through each column of grid
//   points crosses the surface at each triangle over the column, entering or
//   leaving by the face's facing; a point with any number other than zero
//   below it is inside. Where a fold has made the surface pass through
//   itself, that is the UNION of the overlaps, what was sculpted read as
//   solid; parity (which the plan named) would read the overlap as a hole.
// - its SIZE in a band two cells wide about the surface (each triangle's
//   nearest grid points measured to it); beyond, the band's width, which is
//   all a zero crossing needs.
// The grid is offset from the mesh by a fraction of a cell no edge or vertex
// sits on, so a column never runs exactly along an edge.

import { manifold } from "./manifold";
import type { SolidMesh } from "./meshBin";
import { closestOnTri, rayTri } from "./sculptMesh";
import { meshOfManifold } from "./solid";

// The grid is coarsened (and the caller told) beyond this many points: 160³,
// a few seconds.
const MAX_POINTS = 4_096_000;
// No sample is nearer zero than this fraction of a cell, its sign kept: the
// textbook marching-tetrahedra degeneracy, where the surface passes within
// micrometres of a lattice point and every vertex on that point's edges is
// interpolated onto nearly the same spot. Measured 2026-11-23: 15 vertex
// pairs within 10 um on a 122k-triangle remesh, which Blender welds
// (`remove_doubles` in solidfit.py) into a guide it refuses as "not a closed
// mesh". Kept off zero, they stand at least about this far from the point
// (40 um at a 2 cm cell); the surface moves by less than it.
const OFF_ZERO = 0.002;

export interface RemeshResult {
  mesh: SolidMesh;
  // The cell size used: the detail size, or larger if the grid had to be
  // coarsened.
  cell: number;
}

export function voxelRemesh(src: SolidMesh, detail: number): RemeshResult {
  const P = src.positions;
  const I = src.indices;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, P[i + a]!);
      max[a] = Math.max(max[a]!, P[i + a]!);
    }
  }
  let h = detail;
  const pad = (k: number): number => 3 * k;
  const dims = (k: number): number[] => [0, 1, 2].map((a) => Math.ceil((max[a]! - min[a]! + 2 * pad(k)) / k) + 1);
  while (dims(h).reduce((x, y) => x * y, 1) > MAX_POINTS) h *= 1.25;
  const [nx, ny, nz] = dims(h) as [number, number, number];
  // Offset by an irrational fraction of a cell.
  const o = [0, 1, 2].map((a) => min[a]! - pad(h) + h * [0.0123456789, 0.0234567891, 0.0345678912][a]!);
  const at = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  const band = 2 * h;
  const field = new Float32Array(nx * ny * nz).fill(band);

  // The size near the surface.
  const q = [0, 0, 0];
  const p = [0, 0, 0];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]!, b = I[t + 1]!, c = I[t + 2]!;
    const lo = [0, 1, 2].map((ax) => Math.min(P[a * 3 + ax]!, P[b * 3 + ax]!, P[c * 3 + ax]!) - band);
    const hi = [0, 1, 2].map((ax) => Math.max(P[a * 3 + ax]!, P[b * 3 + ax]!, P[c * 3 + ax]!) + band);
    const i0 = Math.max(0, Math.ceil((lo[0]! - o[0]!) / h)), i1 = Math.min(nx - 1, Math.floor((hi[0]! - o[0]!) / h));
    const j0 = Math.max(0, Math.ceil((lo[1]! - o[1]!) / h)), j1 = Math.min(ny - 1, Math.floor((hi[1]! - o[1]!) / h));
    const k0 = Math.max(0, Math.ceil((lo[2]! - o[2]!) / h)), k1 = Math.min(nz - 1, Math.floor((hi[2]! - o[2]!) / h));
    for (let k = k0; k <= k1; k++) {
      p[2] = o[2]! + k * h;
      for (let j = j0; j <= j1; j++) {
        p[1] = o[1]! + j * h;
        for (let i = i0; i <= i1; i++) {
          p[0] = o[0]! + i * h;
          closestOnTri(P, a, b, c, p, q);
          const d = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!);
          const n = at(i, j, k);
          if (d < field[n]!) field[n] = d;
        }
      }
    }
  }

  // The sign, column by column: every triangle over a column gives the
  // height it crosses the column at, and which way - entering the solid
  // going up (its outward normal points down) or leaving it.
  const crossings: number[][] = Array.from({ length: nx * ny }, () => []);
  const up = [0, 0, 1];
  const from = [0, 0, o[2]! - h];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t]!, b = I[t + 1]!, c = I[t + 2]!;
    const lx = Math.min(P[a * 3]!, P[b * 3]!, P[c * 3]!), hx = Math.max(P[a * 3]!, P[b * 3]!, P[c * 3]!);
    const ly = Math.min(P[a * 3 + 1]!, P[b * 3 + 1]!, P[c * 3 + 1]!), hy = Math.max(P[a * 3 + 1]!, P[b * 3 + 1]!, P[c * 3 + 1]!);
    const i0 = Math.max(0, Math.ceil((lx - o[0]!) / h)), i1 = Math.min(nx - 1, Math.floor((hx - o[0]!) / h));
    const j0 = Math.max(0, Math.ceil((ly - o[1]!) / h)), j1 = Math.min(ny - 1, Math.floor((hy - o[1]!) / h));
    if (i0 > i1 || j0 > j1) continue;
    // The z of the face's normal: (b - a) x (c - a), its sign is the way.
    const nz = (P[b * 3]! - P[a * 3]!) * (P[c * 3 + 1]! - P[a * 3 + 1]!) - (P[b * 3 + 1]! - P[a * 3 + 1]!) * (P[c * 3]! - P[a * 3]!);
    const way = nz < 0 ? 1 : -1;
    for (let j = j0; j <= j1; j++) {
      from[1] = o[1]! + j * h;
      for (let i = i0; i <= i1; i++) {
        from[0] = o[0]! + i * h;
        const s = rayTri(P, a, b, c, from, up);
        if (s < Infinity) crossings[j * nx + i]!.push(from[2]! + s, way);
      }
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const flat = crossings[j * nx + i]!;
      const order = Array.from({ length: flat.length / 2 }, (_, q) => q).sort((x, y) => flat[x * 2]! - flat[y * 2]!);
      let next = 0;
      let winding = 0;
      for (let k = 0; k < nz; k++) {
        const z = o[2]! + k * h;
        while (next < order.length && flat[order[next]! * 2]! < z) winding += flat[order[next++]! * 2 + 1]!;
        // Inside (a winding number other than zero) stays positive,
        // manifold-3d's convention for `levelSet`; outside turns negative.
        if (winding === 0) field[at(i, j, k)] = -field[at(i, j, k)]!;
      }
    }
  }

  const offZero = h * OFF_ZERO;
  // Trilinear, outside the grid outside the solid.
  const sample = (x: number, y: number, z: number): number => {
    const fx = (x - o[0]!) / h, fy = (y - o[1]!) / h, fz = (z - o[2]!) / h;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return -band;
    const u = fx - i, v = fy - j, w = fz - k;
    const f = (di: number, dj: number, dk: number): number => field[at(i + di, j + dj, k + dk)]!;
    const x00 = f(0, 0, 0) * (1 - u) + f(1, 0, 0) * u;
    const x10 = f(0, 1, 0) * (1 - u) + f(1, 1, 0) * u;
    const x01 = f(0, 0, 1) * (1 - u) + f(1, 0, 1) * u;
    const x11 = f(0, 1, 1) * (1 - u) + f(1, 1, 1) * u;
    const d = (x00 * (1 - v) + x10 * v) * (1 - w) + (x01 * (1 - v) + x11 * v) * w;
    // Kept off zero (`OFF_ZERO`): a lattice point the surface passes within
    // micrometres of would gather every vertex on its edges onto one spot.
    return d >= 0 ? Math.max(d, offZero) : Math.min(d, -offZero);
  };
  const solid = manifold.Manifold.levelSet(
    (pt) => sample(pt[0], pt[1], pt[2]),
    { min: [o[0]!, o[1]!, o[2]!], max: [o[0]! + (nx - 1) * h, o[1]! + (ny - 1) * h, o[2]! + (nz - 1) * h] },
    h,
  );
  try {
    if (solid.isEmpty()) throw new Error("the remesh enclosed nothing");
    return { mesh: meshOfManifold(solid), cell: h };
  } finally {
    solid.delete();
  }
}

// Whether any two triangles of a mesh that share no vertex cross: the check
// a commit runs on the triangles a sculpt session touched (`only`), since a
// fold through itself is a solid manifold-3d accepts and a generator
// misreads. Segment against triangle both ways (coplanar touching is not
// counted: it encloses nothing wrong).
export function selfIntersects(
  pos: Float32Array,
  idx: Uint32Array,
  alive: Uint8Array,
  near: (t: number, visit: (u: number) => void) => void,
  only: Iterable<number>,
): boolean {
  const seg = (a: number, b: number, t: number): boolean => {
    const o = [pos[a * 3]!, pos[a * 3 + 1]!, pos[a * 3 + 2]!];
    const d = [pos[b * 3]! - o[0]!, pos[b * 3 + 1]! - o[1]!, pos[b * 3 + 2]! - o[2]!];
    const s = rayTri(pos, idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!, o, d);
    return s > 1e-9 && s < 1 - 1e-9;
  };
  for (const t of only) {
    if (!alive[t]) continue;
    const ta = [idx[t * 3]!, idx[t * 3 + 1]!, idx[t * 3 + 2]!];
    let found = false;
    near(t, (u) => {
      if (found || u === t || !alive[u]) return;
      const tb = [idx[u * 3]!, idx[u * 3 + 1]!, idx[u * 3 + 2]!];
      if (ta.some((v) => tb.includes(v))) return;
      for (let k = 0; k < 3 && !found; k++) {
        if (seg(ta[k]!, ta[(k + 1) % 3]!, u) || seg(tb[k]!, tb[(k + 1) % 3]!, t)) found = true;
      }
    });
    if (found) return true;
  }
  return false;
}
