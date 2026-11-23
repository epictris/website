// Dynamic topology (plans/sculpt-guides.md, "Dynamic remeshing"), Blender's
// Dyntopo in its constant-detail mode: in the brush's region of each dab, the
// textbook isotropic remesh (Botsch & Kobbelt 2004) restricted to the brush -
//
// 1. split every edge longer than 4/3 of the detail size at its midpoint,
//    longest first, until none is;
// 2. collapse every edge shorter than 4/5 of it, shortest first, into its
//    midpoint or else either end, where the collapse keeps the mesh a closed
//    two-manifold, turns no face over (`SculptMesh.canCollapse`) and makes no
//    edge longer than 4/3 that was not already;
// 3. flip an edge where that brings its four vertices' valences nearer six,
//    on a surface flat enough across it that the flip does not change the
//    shape - only about vertices this dab split or collapsed, since the rest
//    of the region was settled by the dab before.
//
// 4/5 and 4/3 are when to act, not bounds every edge ends inside: the halves
// of an edge just over 4/3 are 2/3, under 4/5, and collapsing them back would
// make the long edge again, so they stay (measured 2026-11-23: 81 of 474
// edges of a drawn region short, down to 0.35 of the detail size). What is
// held: no edge longer than 4/3, the mesh closed, and a settled region left
// as it is by another dab (scripts/test-sculpt.ts). Botsch's fourth step,
// tangential relaxation, evens them out; it was tried and left out, as
// Blender's Dyntopo leaves it out: it moves the surface under the brush on
// every dab, and it only took the 81 to 42 over ten dabs.
//
// The region is every triangle that comes within the radius of the dab, so a
// two-metre face of a box primitive under a small brush is split from its
// long edges inward until only the brush's part of it is fine.
//
// COST: a dab is run per few pixels of a stroke, so the region is gathered
// once when nothing changes it, each edge is found once (from the one of its
// two triangles that runs it low slot to high, no set needed), the flips look
// only where this dab changed the topology, and a vertex's valence is its
// triangle count. Measured 2026-11-23 in Chromium: 2.6 ms a dab (Dyntopo and
// Draw) along a stroke on a box at a 2 cm detail.

import type { SculptMesh } from "./sculptMesh";

export const SPLIT_ABOVE = 4 / 3;
export const COLLAPSE_BELOW = 4 / 5;
// Work per dab, so a brush far larger than the detail size builds its detail
// over a few dabs rather than freezing the frame on one.
const MAX_SPLITS = 20000;
const SPLIT_PASSES = 64;
const COLLAPSE_PASSES = 4;
// A flip changes the shape where the two faces are not near flat: cos 20°.
const FLIP_FLAT = Math.cos((20 * Math.PI) / 180);
// A vertex is on a crease where two of its faces meet at more than 30°.
const CREASE = Math.cos((30 * Math.PI) / 180);
// Where a collapse may merge an edge a-b, as a fraction of the way from a:
// the midpoint first, else either end; or only the end on a crease.
const MERGE_AT = [0.5, 0, 1];
const AT_A = [0];
const AT_B = [1];

export interface DyntopoOptions {
  collapse?: boolean;
  flip?: boolean;
  // Told of every split (a grab takes the new vertex along).
  onSplit?: (a: number, b: number, m: number) => void;
}

export interface DyntopoResult {
  splits: number;
  collapses: number;
  flips: number;
}

// The edges of the given triangles, each once, as flat pairs: an edge of a
// closed mesh is run by its two triangles in opposite directions, so it is
// taken where it runs from the lower slot to the higher - or, where that
// triangle is not among the given ones, from the one that is.
let regionStamp = new Uint32Array(0);
let stampNow = 0;
function edgesOf(mesh: SculptMesh, tris: readonly number[], out: number[]): number[] {
  out.length = 0;
  if (regionStamp.length < mesh.tCount) regionStamp = new Uint32Array(Math.max(mesh.tCount * 2, 1024));
  if (++stampNow === 0xffffffff) {
    regionStamp.fill(0);
    stampNow = 1;
  }
  for (const t of tris) regionStamp[t] = stampNow;
  const idx = mesh.idx;
  for (const t of tris) {
    const o = t * 3;
    for (let k = 0; k < 3; k++) {
      const a = idx[o + k]!;
      const b = idx[o + ((k + 1) % 3)]!;
      if (a < b) out.push(a, b);
      else {
        let twinIn = false;
        for (const u of mesh.trisOf(a)) {
          if (u === t || regionStamp[u] !== stampNow) continue;
          const p = u * 3;
          if (idx[p] === b || idx[p + 1] === b || idx[p + 2] === b) twinIn = true;
        }
        if (!twinIn) out.push(b, a);
      }
    }
  }
  return out;
}

const regionTris: number[] = [];
const edgeScratch: number[] = [];

export function dyntopo(mesh: SculptMesh, c: readonly number[], r: number, detail: number, opts: DyntopoOptions = {}): DyntopoResult {
  const out: DyntopoResult = { splits: 0, collapses: 0, flips: 0 };
  const hi2 = (SPLIT_ABOVE * detail) ** 2;
  const lo2 = (COLLAPSE_BELOW * detail) ** 2;
  // The vertices this dab made or moved by changing the topology: where the
  // flips look.
  const changed = new Set<number>();
  // Whether `regionTris` is the region as it stands (no edit since the query).
  let regionFresh = false;
  const region = (): number[] => {
    if (!regionFresh) mesh.trisNear(c, r, regionTris);
    regionFresh = true;
    return regionTris;
  };

  // 1. Split, pass by pass: each pass takes the region's long edges, longest
  // first (longest-edge bisection, which keeps the triangles well shaped -
  // splitting in any other order fans slivers out of a vertex), until a pass
  // finds none. A settled region costs the one query, shared with step 2.
  const split = (): void => {
    for (let pass = 0; pass < SPLIT_PASSES && out.splits < MAX_SPLITS; pass++) {
      const edges = edgesOf(mesh, region(), edgeScratch);
      const long: [number, number, number][] = [];
      for (let i = 0; i < edges.length; i += 2) {
        const l2 = mesh.edgeLength2(edges[i]!, edges[i + 1]!);
        if (l2 > hi2) long.push([edges[i]!, edges[i + 1]!, l2]);
      }
      if (!long.length) return;
      long.sort((x, y) => y[2] - x[2]);
      for (const [a, b] of long) {
        if (out.splits >= MAX_SPLITS) break;
        if (!mesh.vAlive[a] || !mesh.vAlive[b] || mesh.edgeLength2(a, b) <= hi2) continue;
        const m = mesh.splitEdge(a, b);
        if (m < 0) continue;
        out.splits++;
        changed.add(m);
        regionFresh = false;
        opts.onSplit?.(a, b, m);
      }
    }
  };

  // 2. Collapse, shortest first, a few passes (a collapse can leave its
  // neighbour short).
  const ring: number[] = [];
  const at = [0, 0, 0];
  // No edge out of the merged vertex may come out long (Botsch's condition),
  // or the next dab splits what this one collapsed. An edge that was long
  // already and is not lengthened does not count: at the brush's rim a vertex
  // keeps unrefined neighbours outside it.
  const keepsShort = (a: number, b: number): boolean => {
    for (const v of [a, b]) {
      for (const w of mesh.ring(v, ring)) {
        if (w === a || w === b) continue;
        const dx = mesh.pos[w * 3]! - at[0]!, dy = mesh.pos[w * 3 + 1]! - at[1]!, dz = mesh.pos[w * 3 + 2]! - at[2]!;
        const after = dx * dx + dy * dy + dz * dz;
        if (after > hi2 && after > mesh.edgeLength2(v, w)) return false;
      }
    }
    return true;
  };
  // Whether two faces round a vertex meet at a crease (more than CREASE).
  const na = [0, 0, 0];
  const nb = [0, 0, 0];
  const onCrease = (v: number): boolean => {
    const ts = mesh.trisOf(v);
    for (let i = 0; i < ts.length; i++) {
      mesh.triNormal(ts[i]!, na);
      const la = Math.hypot(na[0]!, na[1]!, na[2]!);
      for (let j = i + 1; j < ts.length; j++) {
        mesh.triNormal(ts[j]!, nb);
        const l = la * Math.hypot(nb[0]!, nb[1]!, nb[2]!);
        if (l > 0 && (na[0]! * nb[0]! + na[1]! * nb[1]! + na[2]! * nb[2]!) / l < CREASE) return true;
      }
    }
    return false;
  };
  const collapse = (): void => {
    for (let pass = 0; pass < COLLAPSE_PASSES; pass++) {
      const es = edgesOf(mesh, region(), edgeScratch);
      const short: [number, number, number][] = [];
      for (let i = 0; i < es.length; i += 2) {
        const l2 = mesh.edgeLength2(es[i]!, es[i + 1]!);
        if (l2 < lo2) short.push([es[i]!, es[i + 1]!, l2]);
      }
      if (!short.length) return;
      short.sort((x, y) => x[2] - y[2]);
      let done = 0;
      for (const [a, b] of short) {
        if (!mesh.vAlive[a] || !mesh.vAlive[b] || mesh.edgeLength2(a, b) >= lo2) continue;
        // Into the midpoint (Blender's), else into either end (Botsch's): at
        // the rim the midpoint lengthens the edge to an unrefined neighbour
        // on the far side. An end on a crease keeps its place (feature
        // preservation): merged halfway to a vertex off the crease, crease
        // vertices were pulled off it one by one and a drawn-over box edge
        // came out a sawtooth (2026-11-23).
        const fa = onCrease(a), fb = onCrease(b);
        for (const s of fa === fb ? MERGE_AT : fa ? AT_A : AT_B) {
          const q = mesh.pos;
          for (let k = 0; k < 3; k++) at[k] = q[a * 3 + k]! + (q[b * 3 + k]! - q[a * 3 + k]!) * s;
          if (!keepsShort(a, b) || !mesh.canCollapse(a, b, at)) continue;
          mesh.collapseEdge(a, b, at);
          changed.add(a);
          regionFresh = false;
          done++;
          break;
        }
      }
      out.collapses += done;
      if (!done) return;
    }
  };

  // 3. Flip toward valence six, about what this dab changed. On a closed
  // mesh a vertex's valence is its triangle count.
  const flip = (): void => {
    const n0 = [0, 0, 0];
    const n1 = [0, 0, 0];
    const valence = (v: number): number => mesh.trisOf(v).length;
    const tried = new Set<number>();
    for (const v of changed) {
      if (!mesh.vAlive[v]) continue;
      for (const w of [...mesh.ring(v, ring)]) {
        const a = Math.min(v, w), b = Math.max(v, w);
        const key = a * 4294967296 + b;
        if (tried.has(key)) continue;
        tried.add(key);
        const ts = mesh.edgeTris(a, b);
        if (ts.length !== 2) continue;
        const opp = (t: number): number => {
          for (let k = 0; k < 3; k++) {
            const x = mesh.idx[t * 3 + k]!;
            if (x !== a && x !== b) return x;
          }
          return -1;
        };
        const cv = opp(ts[0]!);
        const dv = opp(ts[1]!);
        const va = valence(a), vb = valence(b), vc = valence(cv), vd = valence(dv);
        // Never below three: a vertex of valence three loses its fan.
        if (va <= 3 || vb <= 3) continue;
        const before = Math.abs(va - 6) + Math.abs(vb - 6) + Math.abs(vc - 6) + Math.abs(vd - 6);
        const after = Math.abs(va - 7) + Math.abs(vb - 7) + Math.abs(vc - 5) + Math.abs(vd - 5);
        if (after >= before) continue;
        // Nor to an edge a split would take again.
        if (mesh.edgeLength2(cv, dv) > hi2) continue;
        mesh.triNormal(ts[0]!, n0);
        mesh.triNormal(ts[1]!, n1);
        const l = Math.hypot(n0[0]!, n0[1]!, n0[2]!) * Math.hypot(n1[0]!, n1[1]!, n1[2]!);
        if (!(l > 0) || (n0[0]! * n1[0]! + n0[1]! * n1[1]! + n0[2]! * n1[2]!) / l < FLIP_FLAT) continue;
        if (mesh.flipEdge(a, b)) {
          out.flips++;
          regionFresh = false;
        }
      }
    }
  };

  split();
  if (opts.collapse !== false) collapse();
  if (opts.flip !== false && changed.size) flip();
  mesh.updateNormals();
  return out;
}
