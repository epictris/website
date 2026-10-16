// How the glass ball and its loop come apart: the PIECES,
// as solid geometry, computed once while the level loads (`buildFractureSet`)
// so that the frame a ball breaks on does no geometry at all - it only picks a
// pattern and turns it to face the blow (see `GlassShards`).
//
// Pure: no three.js and no physics, so `cli render3d` can check the pieces
// without a GPU, and both renderers can draw the same ones.
//
// THE BALL is solid quartz, and a solid sphere struck hard fails the way glass
// marbles and crystal balls are seen to: a crushed cone of fine fragments at
// the contact, and from it cracks running round the ball toward the far side,
// so the rest comes apart in large WEDGES, like the segments of an orange,
// whose points face the blow. That is a Voronoi fracture with its seeds dense
// at the contact (small cells there, `FINES`) and its metric stretched
// along the axis of the blow (`WEDGE_STRETCH`), so each cell runs from the
// contact toward the far side. Every cell of a Voronoi diagram is convex, so
// each piece is one convex polyhedron: cut out of the sphere by the planes
// between its seed and every other one, and a stretched metric keeps them
// planes (a linear map of space maps planes to planes).
//
// The sphere's own surface stays smooth (its normals are the sphere's) and
// coated - it carries the aurora film (`coatNm`, the film's thickness there,
// glassMaterial.ts `coatAt`) - while every cut face is flat, bare quartz.
//
// A HOLLOW BALL (its wall thinner than its radius, render3d/glassWall.ts)
// fails as a glass bulb or a bauble does: a thin shell cracks THROUGH its
// wall, square to its surface, so every crack is a cut through the ball's
// centre, and the pieces are curved SHARDS of the wall - fine ones round the
// blow, long ones running from it toward the far side. The same seeds, on the
// sphere: a cell is the directions nearer its seed than any other's in the
// squeezed metric (`shellBall`), whose bounds are planes through the centre,
// and a shard is that cell's patch of the wall - the outer surface, coated,
// the inner one, bare, and a bare broken edge between them.
//
// THE LOOP is round bar bent into a ring, and a ring breaks across the bar:
// into two or three ARCS of itself, with a bare flat face at each break. (The
// chain and its cuff do not break: they simply go.)
//
// Frames: every piece is in three's frame (y up, metres), centred on its own
// centre of mass, with `centre` saying where that was in the whole thing's
// frame. The ball's pattern is struck at its BOTTOM (-y): `GlassShards` turns
// it so that pole faces the contact.

import { COAT_THICKNESS_NM } from "../render3d/glassCoat";

export interface FracturePiece {
  // Triangles, three floats a vertex, in the piece's own frame (its centre of
  // mass at the origin).
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  // The aurora film's thickness at each vertex, nm: zero on a broken face.
  readonly coatNm: Float32Array;
  readonly indices: Uint32Array;
  // What it collides as and what the 2D view outlines: its extreme corners
  // in `HULL_DIRECTIONS` directions, whose convex hull is the piece's within a
  // fraction of a millimetre. Every corner was 100-150 points a piece, and a
  // pile of such hulls in contact cost the engine milliseconds a step.
  readonly hull: Float32Array;
  // Where its centre of mass was in the whole thing's frame, and its volume.
  readonly centre: readonly [number, number, number];
  readonly volume: number;
  // A piece of ROUND bar: its centreline (in its own frame) and the bar's
  // radius, which it collides as - a few capsules along it - rather than as
  // its hull, which fills the ring's opening, where a neighbouring link's bar
  // passes.
  readonly bar?: { readonly points: Float32Array; readonly radius: number };
  // A curved SHARD of a hollow ball: convex parts it collides as, each the
  // extreme corners of a patch of it no wider than `PART_ANGLE`. Its whole
  // hull would be a lens filling its curve, and it would rest on that.
  readonly parts?: readonly Float32Array[];
}

// Ball patterns, each its own set of seeds: one is picked per break and turned
// about the axis of the blow, so no two breaks look alike.
export const BALL_PATTERNS = 3;
// What a ball breaks into, as seeds of two kinds:
//   WEDGES - a few seeds in a ring round the axis of the blow, between these
//            counts: each takes a segment of the ball from the contact to the
//            far side. Where most of the glass ends up.
//   FINES  - many seeds crowded at the contact, falling off over `FINES_SCALE`
//            (in radii): the crushed cone under the blow.
//   and a few STRAYS anywhere, so no pattern is a tidy orange.
const WEDGES: readonly [number, number] = [5, 8];
const FINES = 34;
const FINES_SCALE = 0.22;
const STRAYS = 6;
// The metric's squeeze along the axis of the blow: below 1, a cell reaches
// further along the axis than across it - a wedge from the contact outward.
const WEDGE_STRETCH = 0.45;
// How finely the ball's surface is tessellated before it is cut (an icosphere
// of this many subdivisions: 1280 faces at 3). The pieces keep its facets on
// the surface, but with the sphere's normals, so they shade as the ball did.
const SPHERE_DETAIL = 3;
// Each cut piece is shrunk toward its own centre by this fraction, so that
// neighbours do not start the break already touching: a contact between two
// pieces of a ball that has not moved yet would push them apart.
const GAP = 0.004;

// Ring patterns: two or three arcs each.
const RING_PATTERNS = 4;
// Facets round the bar and along a piece of it.
const BAR_SIDES = 10;
const ARC_STEPS = 10;

// How many directions a piece's collision hull is sampled in.
const HULL_DIRECTIONS = 32;

// The widest patch of a shard one convex part of its collision covers
// (radians across): its hull is thicker than the wall by the bow of the
// sphere across it, R (1 - cos(PART_ANGLE / 2)), 3.8 mm on a 12 cm ball.
const PART_ANGLE = 0.5;

export interface FractureSet {
  readonly ball: readonly (readonly FracturePiece[])[];
  readonly loop: readonly (readonly FracturePiece[])[];
}

export interface RingSpec {
  // The bar's centreline: an ellipse of these semi-axes in the x-y plane.
  readonly a: number;
  readonly b: number;
  // The round bar's radius.
  readonly radius: number;
}

// `wall`: the ball's wall (render3d/glassWall.ts); as thick as its radius or
// more, it is solid.
export function buildFractureSet(ballRadius: number, loop: RingSpec, seed = 0x5eed, wall = Infinity): FractureSet {
  const rng = mulberry32(seed);
  const sphere = icosphere(SPHERE_DETAIL);
  const ball: FracturePiece[][] = [];
  for (let p = 0; p < BALL_PATTERNS; p++) {
    ball.push(wall >= ballRadius ? fractureBall(sphere, ballRadius, rng) : fractureShell(sphere, ballRadius, ballRadius - wall, rng));
  }
  const rings = (spec: RingSpec): FracturePiece[][] => {
    const out: FracturePiece[][] = [];
    for (let p = 0; p < RING_PATTERNS; p++) out.push(breakRing(spec, rng));
    return out;
  };
  return { ball, loop: rings(loop) };
}

// ---------------------------------------------------------------------------
// The ball
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

interface Face {
  pts: V3[];
  // On the ball's surface (smooth, coated), or a cut (flat, bare).
  outer: boolean;
}

function fractureBall(sphere: Face[], radius: number, rng: () => number): FracturePiece[] {
  const seeds = ballSeeds(rng);
  // The metric: lengths along y counted short, so a cell stretches along it.
  const m: V3 = [1, WEDGE_STRETCH * WEDGE_STRETCH, 1];
  const mdot = (a: V3, b: V3): number => a[0] * b[0] * m[0] + a[1] * b[1] * m[1] + a[2] * b[2] * m[2];
  const pieces: FracturePiece[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]!;
    // The planes between this seed and every other, nearest first, so the cell
    // shrinks to its size in the first few cuts and the rest are cheap.
    const others = seeds
      .map((o, j) => ({ o, j, d: (o[0] - s[0]) ** 2 + (o[1] - s[1]) ** 2 + (o[2] - s[2]) ** 2 }))
      .filter((e) => e.j !== i)
      .sort((x, y) => x.d - y.d);
    let cell: Face[] = sphere;
    for (const { o } of others) {
      // |p - s|_m <= |p - o|_m  <=>  2 M (o - s) . p <= |o|_m^2 - |s|_m^2
      const n: V3 = [2 * m[0] * (o[0] - s[0]), 2 * m[1] * (o[1] - s[1]), 2 * m[2] * (o[2] - s[2])];
      const d = mdot(o, o) - mdot(s, s);
      cell = clip(cell, n, d);
      if (cell.length === 0) break;
    }
    if (cell.length < 4) continue;
    const piece = toPiece(cell, radius);
    if (piece) pieces.push(piece);
  }
  return pieces;
}

// Seeds inside the unit ball, struck at its bottom pole (0, -1, 0).
function ballSeeds(rng: () => number): V3[] {
  const seeds: V3[] = [];
  const wedges = WEDGES[0] + Math.floor(rng() * (WEDGES[1] - WEDGES[0] + 1));
  const turn = rng() * Math.PI * 2;
  for (let i = 0; i < wedges; i++) {
    const a = turn + ((i + 0.5 * (rng() - 0.5)) / wedges) * Math.PI * 2;
    const r = 0.45 + 0.25 * rng();
    seeds.push([Math.cos(a) * r, -0.1 + 0.5 * rng(), Math.sin(a) * r]);
  }
  // Fines: a distance from the pole drawn from an exponential, in a random
  // direction, kept inside the ball.
  while (seeds.length < wedges + FINES) {
    const d = -FINES_SCALE * Math.log(1 - rng() * 0.999);
    const dir = normalize([rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]);
    const p: V3 = [dir[0] * d, -1 + Math.abs(dir[1]) * d, dir[2] * d];
    if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] < 0.98) seeds.push(p);
  }
  while (seeds.length < wedges + FINES + STRAYS) {
    const p: V3 = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
    if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] < 0.9) seeds.push(p);
  }
  return seeds;
}

// The part of convex `faces` with n . p <= d, closed by a flat cut face.
function clip(faces: Face[], n: V3, d: number): Face[] {
  const eps = 1e-12;
  const side = (p: V3): number => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d;
  let any = false;
  let all = true;
  for (const f of faces) {
    for (const p of f.pts) {
      const s = side(p);
      if (s > eps) any = true;
      else all = false;
    }
  }
  if (!any) return faces;
  if (all) return [];
  const out: Face[] = [];
  const cut: V3[] = [];
  for (const f of faces) {
    const pts: V3[] = [];
    const k = f.pts.length;
    for (let i = 0; i < k; i++) {
      const a = f.pts[i]!;
      const b = f.pts[(i + 1) % k]!;
      const sa = side(a);
      const sb = side(b);
      if (sa <= eps) pts.push(a);
      if ((sa <= eps) !== (sb <= eps)) {
        const t = sa / (sa - sb);
        const x: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        pts.push(x);
        cut.push(x);
      }
    }
    if (pts.length >= 3) out.push({ pts, outer: f.outer });
  }
  const cap = convexLoop(cut, n);
  if (cap.length >= 3) out.push({ pts: cap, outer: false });
  return out;
}

// The points of a cut, which all lie in one plane of normal `n`, as the convex
// loop round them, wound so `n` is its outward normal.
function convexLoop(points: V3[], n: V3): V3[] {
  const unique: V3[] = [];
  for (const p of points) {
    if (!unique.some((q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < 1e-18)) unique.push(p);
  }
  if (unique.length < 3) return [];
  const len = Math.hypot(n[0], n[1], n[2]);
  const nn: V3 = [n[0] / len, n[1] / len, n[2] / len];
  // A basis in the plane.
  const u = normalize(Math.abs(nn[0]) < 0.9 ? cross(nn, [1, 0, 0]) : cross(nn, [0, 1, 0]));
  const v = cross(nn, u);
  const c: V3 = [0, 0, 0];
  for (const p of unique) for (let i = 0; i < 3; i++) c[i] += p[i]! / unique.length;
  const angle = (p: V3): number => {
    const q: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return Math.atan2(dot(q, v), dot(q, u));
  };
  // Counter-clockwise about +n: outward.
  return unique.sort((p, q) => angle(p) - angle(q));
}

// A cell, scaled to the ball's radius, shrunk by `GAP`, triangulated and moved
// onto its own centre of mass.
function toPiece(faces: Face[], radius: number): FracturePiece | null {
  const tris: { a: V3; b: V3; c: V3; outer: boolean }[] = [];
  for (const f of faces) {
    for (let i = 1; i + 1 < f.pts.length; i++) tris.push({ a: f.pts[0]!, b: f.pts[i]!, c: f.pts[i + 1]!, outer: f.outer });
  }
  const { volume, centre } = massOf(tris.map((t) => [t.a, t.b, t.c]));
  if (volume <= 1e-9) return null;
  const k = radius * (1 - GAP);
  const positions: number[] = [];
  const normals: number[] = [];
  const coat: number[] = [];
  const corners: V3[] = [];
  const place = (p: V3): V3 => [(p[0] - centre[0]) * k, (p[1] - centre[1]) * k, (p[2] - centre[2]) * k];
  for (const t of tris) {
    const flat = normalize(cross(sub(t.b, t.a), sub(t.c, t.a)));
    for (const p of [t.a, t.b, t.c]) {
      const q = place(p);
      positions.push(...q);
      normals.push(...(t.outer ? normalize(p) : flat));
      coat.push(t.outer ? coatAt(normalize(p)) : 0);
      if (!corners.some((c) => (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2 < 1e-14)) corners.push(q);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    coatNm: new Float32Array(coat),
    indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
    hull: extremes(corners),
    centre: [centre[0] * radius, centre[1] * radius, centre[2] * radius],
    volume: volume * k * k * k,
  };
}

// The film's thickness at a direction from the ball's centre, as the whole
// ball wears it (glassMaterial.ts `coatAt`, along the ball's +y).
function coatAt(dir: V3): number {
  const [thin, thick] = COAT_THICKNESS_NM;
  return thick + (thin - thick) * (0.5 - 0.5 * dir[1]);
}

// Volume and centre of mass of a closed, outward-wound triangle mesh: the sum
// of the signed tetrahedra each triangle makes with the origin.
function massOf(tris: readonly (readonly [V3, V3, V3])[]): { volume: number; centre: V3 } {
  let vol = 0;
  const c: V3 = [0, 0, 0];
  for (const [a, b, d] of tris) {
    const v = dot(a, cross(b, d)) / 6;
    vol += v;
    for (let i = 0; i < 3; i++) c[i] += (v * (a[i]! + b[i]! + d[i]!)) / 4;
  }
  return { volume: vol, centre: vol > 0 ? [c[0] / vol, c[1] / vol, c[2] / vol] : [0, 0, 0] };
}

// A unit icosphere as outward-wound triangles, all on the ball's surface.
function icosphere(detail: number): Face[] {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => normalize(v as V3));
  let tris: [V3, V3, V3][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ].map(([a, b, c]) => [verts[a!]!, verts[b!]!, verts[c!]!]);
  for (let i = 0; i < detail; i++) {
    const next: [V3, V3, V3][] = [];
    for (const [a, b, c] of tris) {
      const ab = normalize(mid(a, b));
      const bc = normalize(mid(b, c));
      const ca = normalize(mid(c, a));
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  return tris.map((pts) => ({ pts, outer: true }));
}

// ---------------------------------------------------------------------------
// A hollow ball
// ---------------------------------------------------------------------------

// The shards of a shell of outer radius `outer` and inner radius `inner`.
function fractureShell(sphere: Face[], outer: number, inner: number, rng: () => number): FracturePiece[] {
  const seeds = ballSeeds(rng).map((p) => normalize(p));
  // The squeezed metric on directions: a direction's cell is the seed whose
  // squeezed copy it is most along, so every bound between two cells is a
  // plane through the centre, and a cell reaches further along the axis of
  // the blow than across it (`WEDGE_STRETCH`).
  const squeeze = (v: V3): V3 => normalize([v[0], v[1] * WEDGE_STRETCH, v[2]]);
  const keys = seeds.map(squeeze);
  const pieces: FracturePiece[] = [];
  for (let i = 0; i < keys.length; i++) {
    const s = keys[i]!;
    const others = keys
      .map((o, j) => ({ o, j, d: dot(o, s) }))
      .filter((e) => e.j !== i)
      .sort((x, y) => y.d - x.d);
    let patch: Face[] = sphere;
    for (const { o } of others) {
      // u . S(o) <= u . S(s), with S the squeeze (a linear map, here S^T = S):
      // S (o - s) . u <= 0.
      const n: V3 = [o[0] - s[0], (o[1] - s[1]) * WEDGE_STRETCH, o[2] - s[2]];
      patch = clipSurface(patch, n);
      if (patch.length === 0) break;
    }
    if (patch.length === 0) continue;
    const piece = toShard(patch, outer, inner);
    if (piece) pieces.push(piece);
  }
  return pieces;
}

// The part of a patch of the sphere's surface with n . p <= 0, left open.
function clipSurface(faces: Face[], n: V3): Face[] {
  const eps = 1e-12;
  const side = (p: V3): number => dot(n, p);
  const out: Face[] = [];
  for (const f of faces) {
    const pts: V3[] = [];
    const k = f.pts.length;
    for (let i = 0; i < k; i++) {
      const a = f.pts[i]!;
      const b = f.pts[(i + 1) % k]!;
      const sa = side(a);
      const sb = side(b);
      if (sa <= eps) pts.push(a);
      if ((sa <= eps) !== (sb <= eps)) {
        const t = sa / (sa - sb);
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
    }
    if (pts.length >= 3) out.push({ pts, outer: true });
  }
  return out;
}

// A patch of the unit sphere as a shard of the wall: the patch at `outer`
// (coated), again at `inner` (bare, facing in), and its edge between them,
// broken across the wall (bare, flat). Shrunk by `GAP` and moved onto its own
// centre of mass, as a solid piece is (`toPiece`).
function toShard(patch: Face[], outer: number, inner: number): FracturePiece | null {
  // The patch's edge: every side of its polygons that no other polygon has,
  // once welded (a cut point is computed apart by the two faces it splits).
  const key = (p: V3): string => p.map((v) => Math.round(v * 1e9)).join(",");
  const welded = new Map<string, V3>();
  const weld = (p: V3): V3 => {
    const k = key(p);
    const had = welded.get(k);
    if (had) return had;
    welded.set(k, p);
    return p;
  };
  const polys = patch.map((f) => f.pts.map(weld));
  const sides = new Map<string, { a: V3; b: V3; count: number }>();
  for (const pts of polys) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const ka = key(a);
      const kb = key(b);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const had = sides.get(k);
      if (had) had.count++;
      else sides.set(k, { a, b, count: 1 });
    }
  }
  type Tri = { p: [V3, V3, V3]; n: [V3, V3, V3]; coat: boolean };
  const tris: Tri[] = [];
  const at = (p: V3, r: number): V3 => [p[0] * r, p[1] * r, p[2] * r];
  for (const pts of polys) {
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = pts[0]!;
      const b = pts[i]!;
      const c = pts[i + 1]!;
      // The outside, wound outward with the sphere's normals, and the inside
      // wound the other way, its normals toward the centre.
      tris.push({ p: [at(a, outer), at(b, outer), at(c, outer)], n: [normalize(a), normalize(b), normalize(c)], coat: true });
      tris.push({
        p: [at(a, inner), at(c, inner), at(b, inner)],
        n: [scale(normalize(a), -1), scale(normalize(c), -1), scale(normalize(b), -1)],
        coat: false,
      });
    }
  }
  for (const { a, b, count } of sides.values()) {
    if (count !== 1) continue;
    // Wound as the polygon it bounds runs a -> b, seen from outside, so the
    // patch is to its left: the broken face looks the other way, e x n.
    const out = normalize(cross(sub(b, a), normalize(mid(a, b))));
    const quad: [V3, V3, V3, V3] = [at(a, outer), at(b, outer), at(b, inner), at(a, inner)];
    for (const t of [[quad[0], quad[2], quad[1]], [quad[0], quad[3], quad[2]]] as [V3, V3, V3][]) {
      const f = normalize(cross(sub(t[1], t[0]), sub(t[2], t[0])));
      const tri: [V3, V3, V3] = dot(f, out) < 0 ? [t[0], t[2], t[1]] : t;
      tris.push({ p: tri, n: [out, out, out], coat: false });
    }
  }
  const { volume, centre } = massOf(tris.map((t) => t.p));
  if (volume <= 1e-12) return null;
  const k = 1 - GAP;
  const place = (p: V3): V3 => [(p[0] - centre[0]) * k, (p[1] - centre[1]) * k, (p[2] - centre[2]) * k];
  const positions: number[] = [];
  const normals: number[] = [];
  const coat: number[] = [];
  const corners: V3[] = [];
  for (const t of tris) {
    for (let v = 0; v < 3; v++) {
      const q = place(t.p[v]!);
      positions.push(...q);
      normals.push(...t.n[v]!);
      coat.push(t.coat ? coatAt(t.n[v]!) : 0);
      if (!corners.some((c) => (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2 < 1e-14)) corners.push(q);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    coatNm: new Float32Array(coat),
    indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
    hull: extremes(corners),
    centre,
    volume: volume * k * k * k,
    parts: shardParts(polys, outer, inner).map((pts) => extremes(pts.map(place))),
  };
}

// The shard's patch in pieces no wider than `PART_ANGLE` - grouped round as
// many centres as that takes (a few rounds of k-means on the directions of
// its polygons) - each as the corners of its polygons on both surfaces.
function shardParts(polys: readonly V3[][], outer: number, inner: number): V3[][] {
  const dirs = polys.map((pts) => normalize(pts.reduce((m, p) => [m[0] + p[0], m[1] + p[1], m[2] + p[2]] as V3, [0, 0, 0] as V3)));
  // Its extent: the widest angle from its mean direction, doubled.
  const mean = normalize(dirs.reduce((m, d) => [m[0] + d[0], m[1] + d[1], m[2] + d[2]] as V3, [0, 0, 0] as V3));
  const reach = Math.max(...dirs.map((d) => Math.acos(Math.min(1, dot(d, mean)))));
  const count = Math.max(1, Math.min(dirs.length, Math.ceil(((2 * reach) / PART_ANGLE) ** 2)));
  // Centres from spread-out polygons (each the furthest from those picked).
  const centres: V3[] = [dirs[0]!];
  while (centres.length < count) {
    let best = 0;
    let far = -1;
    dirs.forEach((d, j) => {
      const near = Math.min(...centres.map((c) => 1 - dot(c, d)));
      if (near > far) {
        far = near;
        best = j;
      }
    });
    centres.push(dirs[best]!);
  }
  let group = new Array<number>(dirs.length).fill(0);
  for (let round = 0; round < 6; round++) {
    group = dirs.map((d) => {
      let best = 0;
      centres.forEach((c, j) => {
        if (dot(c, d) > dot(centres[best]!, d)) best = j;
      });
      return best;
    });
    for (let j = 0; j < centres.length; j++) {
      const sum: V3 = [0, 0, 0];
      dirs.forEach((d, i) => {
        if (group[i] === j) for (let x = 0; x < 3; x++) sum[x] += d[x]!;
      });
      if (sum[0] || sum[1] || sum[2]) centres[j] = normalize(sum);
    }
  }
  const parts: V3[][] = centres.map(() => []);
  polys.forEach((pts, i) => {
    for (const p of pts) parts[group[i]!]!.push(scale(p, outer), scale(p, inner));
  });
  return parts.filter((p) => p.length >= 4);
}

// ---------------------------------------------------------------------------
// Rings: the loop, the links, the cuff
// ---------------------------------------------------------------------------

// A ring broken across its bar at two or three places, the arcs between them.
function breakRing(spec: RingSpec, rng: () => number): FracturePiece[] {
  const count = rng() < 0.6 ? 2 : 3;
  const start = rng() * Math.PI * 2;
  // Breaks spread round the ring, not bunched: each arc between 60% and 140%
  // of an even share.
  const shares: number[] = [];
  for (let i = 0; i < count; i++) shares.push(0.6 + 0.8 * rng());
  const total = shares.reduce((a, b) => a + b, 0);
  const pieces: FracturePiece[] = [];
  let t0 = start;
  for (const s of shares) {
    const t1 = t0 + (s / total) * Math.PI * 2;
    pieces.push(arcPiece(spec, t0, t1));
    t0 = t1;
  }
  return pieces;
}

// One arc of the ring, from parameter t0 to t1, as a closed bar with a bare
// flat face at each end.
function arcPiece(spec: RingSpec, t0: number, t1: number): FracturePiece {
  const { a, b } = spec;
  // The cross-section's outline, in (radial out, along the ring's axis z).
  const section: [number, number][] = Array.from({ length: BAR_SIDES }, (_, i) => {
    const t = (i / BAR_SIDES) * Math.PI * 2;
    return [Math.cos(t) * spec.radius, Math.sin(t) * spec.radius];
  });
  const rings: V3[][] = [];
  const outs: V3[][] = [];
  const line: V3[] = [];
  for (let i = 0; i <= ARC_STEPS; i++) {
    const t = t0 + ((t1 - t0) * i) / ARC_STEPS;
    const c: V3 = [Math.cos(t) * a, Math.sin(t) * b, 0];
    line.push(c);
    // Outward in the ring's plane: the ellipse's normal.
    const nOut = normalize([Math.cos(t) * b, Math.sin(t) * a, 0]);
    const ring: V3[] = [];
    const out: V3[] = [];
    for (const [r, z] of section) {
      ring.push([c[0] + nOut[0] * r, c[1] + nOut[1] * r, z]);
      out.push(normalize([nOut[0] * r, nOut[1] * r, z]));
    }
    rings.push(ring);
    outs.push(out);
  }
  const tris: { p: [V3, V3, V3]; n: [V3, V3, V3]; outer: boolean }[] = [];
  const k = section.length;
  for (let i = 0; i < ARC_STEPS; i++) {
    for (let j = 0; j < k; j++) {
      const j1 = (j + 1) % k;
      const p00 = rings[i]![j]!;
      const p01 = rings[i]![j1]!;
      const p10 = rings[i + 1]![j]!;
      const p11 = rings[i + 1]![j1]!;
      // Round bar: smooth, its normals the section's.
      const n = (ii: number, jj: number): V3 => outs[ii]![jj]!;
      tris.push({ p: [p00, p10, p01], n: [n(i, j), n(i + 1, j), n(i, j1)], outer: true });
      tris.push({ p: [p01, p10, p11], n: [n(i, j1), n(i + 1, j), n(i + 1, j1)], outer: true });
    }
  }
  // The broken ends.
  for (const [i, flip] of [[0, false], [ARC_STEPS, true]] as const) {
    const ring = rings[i]!;
    for (let j = 1; j + 1 < k; j++) {
      const tri: [V3, V3, V3] = flip ? [ring[0]!, ring[j + 1]!, ring[j]!] : [ring[0]!, ring[j]!, ring[j + 1]!];
      const f = normalize(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
      tris.push({ p: tri, n: [f, f, f], outer: false });
    }
  }
  // Wound outward whichever way the parameter ran: a negative volume is an
  // inside-out mesh.
  let { volume, centre } = massOf(tris.map((t) => t.p));
  if (volume < 0) {
    for (const t of tris) {
      t.p = [t.p[0], t.p[2], t.p[1]];
      t.n = [t.n[0], t.n[2], t.n[1]];
    }
    ({ volume, centre } = massOf(tris.map((t) => t.p)));
  }
  const positions: number[] = [];
  const normals: number[] = [];
  const coat: number[] = [];
  const corners: V3[] = [];
  for (const t of tris) {
    for (let v = 0; v < 3; v++) {
      const q: V3 = sub(t.p[v]!, centre);
      positions.push(...q);
      normals.push(...t.n[v]!);
      coat.push(t.outer ? coatAt(normalize(t.p[v]!)) : 0);
      if (!corners.some((c) => (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2 < 1e-16)) corners.push(q);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    coatNm: new Float32Array(coat),
    indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
    hull: extremes(corners),
    centre,
    volume,
    bar: { points: new Float32Array(line.flatMap((p) => sub(p, centre))), radius: spec.radius },
  };
}

// The corners furthest along each of `HULL_DIRECTIONS` directions spread
// evenly over the sphere (a Fibonacci spiral), without repeats.
function extremes(corners: readonly V3[]): Float32Array {
  const picked = new Set<number>();
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < HULL_DIRECTIONS; i++) {
    const y = 1 - (2 * (i + 0.5)) / HULL_DIRECTIONS;
    const r = Math.sqrt(1 - y * y);
    const d: V3 = [Math.cos(i * golden) * r, y, Math.sin(i * golden) * r];
    let best = 0;
    let far = -Infinity;
    corners.forEach((c, j) => {
      const along = dot(c, d);
      if (along > far) {
        far = along;
        best = j;
      }
    });
    picked.add(best);
  }
  return new Float32Array([...picked].flatMap((j) => corners[j]!));
}

// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function mid(a: V3, b: V3): V3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
