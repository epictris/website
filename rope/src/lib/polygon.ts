// Simple-polygon geometry: the questions a **concave** vertex loop raises, which
// `engine/shapes.ts` deliberately does not answer.
//
// The engine's polygon primitive is convex, always (see "Convex-only polygons;
// compound bodies" in docs/game-design.md) - the rope's wrap solver walks a
// vertex loop monotonically and can never hold a taut contact on a reflex
// corner, and depenetration has no minimum-translation answer inside a notch.
// That rule is not softened here and is not softened anywhere: what this module
// adds is one step *before* the engine, on the authoring side of the line. A
// level may author a concave outline because a concave outline is what an
// L-shaped ledge, a cave mouth or a notched pillar IS, and the loader cuts it
// into convex pieces of one body (`makePieces` in level/buildBodies.ts) before a
// single solver sees it. Every piece that reaches the engine is convex, and the
// seam between two of them is exactly the seam a hand-authored compound body
// would have had - `isExposedCorner` already refuses to wrap or hang from one.
//
// The cut is a **partition**: the pieces tile the outline with no overlap and no
// gap, so their areas sum to its area and their combined centre of mass is its
// centroid. That is what lets the piece masses be the outline's mass split by
// area, and what keeps a decomposed body weighing what its material and
// thickness say it weighs.
//
// Determinism is a hard requirement rather than a nicety. The cut happens at
// load, so a level's piece list must be the same list on every machine and every
// run or two players' simulations diverge on the geometry itself. Nothing here
// consults a clock, a hash order or a random number: the ear scan takes the
// first ear by index and the merge pass takes the first mergeable diagonal.

import { Vec2 } from "../engine/vec2";
import { isConvexLoop, polyArea, polySignedArea2 } from "../engine/shapes";

// Slack on "these two points are the same" / "this cross product is zero", in
// metres and metres² respectively. Authored geometry is snapped to a grid an
// order of magnitude coarser than this, so the epsilons only ever absorb
// floating-point noise from the rotations and scalings an edit applies.
const POINT_EPSILON = 1e-9;
const CROSS_EPSILON = 1e-12;
// A piece thinner than this is a sliver the ear clipper produced from three
// nearly-collinear vertices, not a piece of the level.
const MIN_PIECE_AREA = 1e-9;

// Is this vertex loop **simple** - a closed outline that never touches or
// crosses itself?
//
// This is the one rule that replaces convexity on the authoring side, and it is
// where the editor stalls a vertex drag now (`setPolyVerts`). A concave loop is
// a shape; a self-crossing one is not a shape at all - it has no inside, so
// there is nothing to cut into pieces, nothing to weigh and nothing to draw.
export function isSimpleLoop(verts: readonly Vec2[]): boolean {
  const n = verts.length;
  if (n < 3) return false;

  // Zero-length edges first: two vertices dragged onto each other leave an edge
  // with no direction, which every test below would have to special-case and
  // which the author cannot see. Non-consecutive duplicates are caught by the
  // crossing test (the two edges meeting there touch).
  for (let i = 0; i < n; i++) {
    if (verts[i]!.distanceTo(verts[(i + 1) % n]!) < POINT_EPSILON) return false;
  }

  // A spike: two consecutive edges collinear and pointing back along each other,
  // so the outline runs out and returns down its own line. The crossing test
  // below skips adjacent edge pairs (they legitimately share a vertex), so this
  // is the one degeneracy it cannot see.
  for (let i = 0; i < n; i++) {
    const e1 = verts[i]!.sub(verts[(i + n - 1) % n]!);
    const e2 = verts[(i + 1) % n]!.sub(verts[i]!);
    if (Math.abs(e1.cross(e2)) <= CROSS_EPSILON && e1.dot(e2) < 0) return false;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Adjacent edges share a vertex by construction; the spike test above is
      // what checks they share nothing else.
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (
        segmentsIntersect(verts[i]!, verts[(i + 1) % n]!, verts[j]!, verts[(j + 1) % n]!)
      ) {
        return false;
      }
    }
  }
  return true;
}

// Closed-segment intersection, touching included: two edges of an outline that
// merely graze each other still make it non-simple, because the inside is
// pinched to nothing where they meet.
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  if (d1 === 0 && onSegment(c, d, a)) return true;
  if (d2 === 0 && onSegment(c, d, b)) return true;
  if (d3 === 0 && onSegment(a, b, c)) return true;
  if (d4 === 0 && onSegment(a, b, d)) return true;
  return false;
}

// Sign of the turn a→b→p: +1 left, -1 right, 0 collinear.
function orient(a: Vec2, b: Vec2, p: Vec2): number {
  const cr = b.sub(a).cross(p.sub(a));
  if (cr > CROSS_EPSILON) return 1;
  if (cr < -CROSS_EPSILON) return -1;
  return 0;
}

// Is `p` on segment a→b, given it is already known to be collinear with it?
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - POINT_EPSILON &&
    p.x <= Math.max(a.x, b.x) + POINT_EPSILON &&
    p.y >= Math.min(a.y, b.y) - POINT_EPSILON &&
    p.y <= Math.max(a.y, b.y) + POINT_EPSILON
  );
}

// Is a world point inside a simple (possibly concave) vertex loop? Even-odd ray
// casting, which is the only containment test a concave outline has: the convex
// "inside every face's half-plane" answer calls the whole notch solid.
export function loopContainsPoint(verts: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  const n = verts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = verts[i]!;
    const b = verts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

// Does a simple loop have a reflex vertex - i.e. does it need cutting up at all?
// The negation of `isConvexLoop`, said the way the callers want it, since "this
// shape is concave" is the condition every one of them branches on.
export function isConcaveLoop(verts: readonly Vec2[]): boolean {
  return verts.length >= 3 && !isConvexLoop(normalizeWinding(verts));
}

// The loop in the winding the engine expects (`polySignedArea2` positive:
// clockwise on screen, y being down).
export function normalizeWinding(verts: readonly Vec2[]): Vec2[] {
  return polySignedArea2(verts) >= 0 ? [...verts] : [...verts].reverse();
}

// Cut a simple polygon into convex pieces that tile it exactly.
//
// Ear clipping to triangles, then **Hertel-Mehlhorn**: every diagonal the
// triangulation introduced is dissolved again if the two pieces it separates
// merge into a convex one. The triangulation is the part that is always
// possible; the merge is what stops a five-vertex L from being simulated as
// three triangles with two seams through the middle of a flat face. Neither step
// introduces a vertex the author did not place (no Steiner points), so every
// piece corner is a corner of the outline and `isExposedCorner` sees exactly the
// arrangement a hand-authored compound body would have produced.
//
// A convex loop is returned as itself, in one piece - the fast path matters
// because it is every polygon authored before concave ones were allowed, and it
// is what keeps them building bit-for-bit identically.
//
// Returns [] for a loop that is not simple, which is the caller's cue that there
// is no shape here (the editor refuses such an edit; the loader falls back to
// the convex hull and says so).
export function decomposeConvex(verts: readonly Vec2[]): Vec2[][] {
  if (verts.length < 3) return [];
  const loop = normalizeWinding(verts);
  if (isConvexLoop(loop)) return [loop];
  if (!isSimpleLoop(loop)) return [];

  const tris = earClip(loop);
  if (!tris.length) return [];
  const merged = mergePieces(loop, tris);

  const pieces: Vec2[][] = [];
  for (const piece of merged) {
    const trimmed = dropCollinear(piece.map((i) => loop[i]!));
    if (trimmed.length >= 3 && polyArea(trimmed) > MIN_PIECE_AREA) pieces.push(trimmed);
  }
  return pieces;
}

// Where the cut runs: the internal edges `decomposeConvex` introduced, each
// once, as the pair of points it joins. Nothing in the simulation needs these -
// a seam is an edge two pieces happen to share and no solver asks where it is -
// but an author does, because the pieces are what the physics is and a cut
// through a face is worth seeing before it is a rope behaving oddly there. The
// editor draws them dashed inside the selected outline.
//
// Empty for a convex outline (nothing was cut) and for one that is not a shape.
export function decomposeSeams(verts: readonly Vec2[]): [Vec2, Vec2][] {
  const loop = normalizeWinding(verts);
  const pieces = decomposeConvex(loop);
  if (pieces.length < 2) return [];
  const seams: [Vec2, Vec2][] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i++) {
      const a = piece[i]!;
      const b = piece[(i + 1) % piece.length]!;
      if (isOutlineEdge(loop, a, b)) continue;
      // Every diagonal is walked by both of the pieces it separates, once in
      // each direction, so the key is orientation-free.
      const key = [pointKey(a), pointKey(b)].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      seams.push([a, b]);
    }
  }
  return seams;
}

// Decomposition adds no vertices of its own (see `decomposeConvex`), so a piece
// edge is an edge of the outline exactly when its two ends are neighbours there.
function isOutlineEdge(loop: readonly Vec2[], a: Vec2, b: Vec2): boolean {
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    if (loop[i]!.distanceTo(a) > POINT_EPSILON) continue;
    if (loop[(i + 1) % n]!.distanceTo(b) <= POINT_EPSILON) return true;
    if (loop[(i + n - 1) % n]!.distanceTo(b) <= POINT_EPSILON) return true;
  }
  return false;
}

function pointKey(p: Vec2): string {
  return `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
}

// Ear clipping, on indices into `loop` so a triangle names the outline's own
// vertices and two triangles cut from the same diagonal name it identically -
// which is what the merge pass matches on.
//
// The scan takes the FIRST ear by index rather than the "best" one by any
// measure. It is the cheapest rule, it is deterministic, and the quality it
// gives up is exactly what the merge pass puts back.
function earClip(loop: readonly Vec2[]): number[][] {
  const idx = loop.map((_, i) => i);
  const tris: number[][] = [];

  while (idx.length > 3) {
    let clipped = false;
    // A convex vertex is remembered in case no vertex passes the full ear test:
    // clipping it anyway is what guarantees the loop shrinks rather than
    // spinning here on a degeneracy the epsilons disagree about.
    let fallback = -1;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length]!;
      const b = idx[k]!;
      const c = idx[(k + 1) % idx.length]!;
      if (!isConvexCorner(loop[a]!, loop[b]!, loop[c]!)) continue;
      if (fallback < 0) fallback = k;
      if (!isEar(loop, idx, a, b, c)) continue;
      tris.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (clipped) continue;
    if (fallback < 0) break; // No convex corner at all: the loop is degenerate.
    const a = idx[(fallback + idx.length - 1) % idx.length]!;
    const c = idx[(fallback + 1) % idx.length]!;
    tris.push([a, idx[fallback]!, c]);
    idx.splice(fallback, 1);
  }
  if (idx.length === 3) tris.push([idx[0]!, idx[1]!, idx[2]!]);
  return tris;
}

function isConvexCorner(a: Vec2, b: Vec2, c: Vec2): boolean {
  return b.sub(a).cross(c.sub(b)) > CROSS_EPSILON;
}

// Is triangle (a,b,c) an ear - does it contain no other vertex of the remaining
// loop? Only REFLEX vertices need testing: a convex vertex inside the triangle
// would drag a reflex one in with it, and testing every vertex rejects ears
// whose neighbours merely touch them.
function isEar(
  loop: readonly Vec2[],
  idx: readonly number[],
  a: number,
  b: number,
  c: number,
): boolean {
  for (let k = 0; k < idx.length; k++) {
    const v = idx[k]!;
    if (v === a || v === b || v === c) continue;
    const prev = loop[idx[(k + idx.length - 1) % idx.length]!]!;
    const next = loop[idx[(k + 1) % idx.length]!]!;
    if (isConvexCorner(prev, loop[v]!, next)) continue;
    if (pointInTriangle(loop[v]!, loop[a]!, loop[b]!, loop[c]!)) return false;
  }
  return true;
}

// Inside or on the boundary. Inclusive on purpose: an ear with a vertex sitting
// exactly on its edge is an ear whose cut runs through that vertex, and the
// pieces either side of the cut would share an edge only one of them has a
// corner on.
function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = b.sub(a).cross(p.sub(a));
  const d2 = c.sub(b).cross(p.sub(b));
  const d3 = a.sub(c).cross(p.sub(c));
  const neg = d1 < -CROSS_EPSILON || d2 < -CROSS_EPSILON || d3 < -CROSS_EPSILON;
  const pos = d1 > CROSS_EPSILON || d2 > CROSS_EPSILON || d3 > CROSS_EPSILON;
  return !(neg && pos);
}

// Hertel-Mehlhorn: dissolve a diagonal whenever the two pieces it separates
// merge into a convex piece, until no diagonal can go. A diagonal is an edge
// shared by two pieces that is NOT an edge of the outline - an outline edge is
// the level's own surface and is never dissolved, which is what keeps the pieces
// inside the shape the author drew.
function mergePieces(loop: readonly Vec2[], tris: number[][]): number[][] {
  const n = loop.length;
  const pieces: (number[] | null)[] = tris.map((t) => [...t]);
  const isOutlineEdge = (u: number, v: number): boolean =>
    (u + 1) % n === v || (v + 1) % n === u;

  let merging = true;
  while (merging) {
    merging = false;
    // First mergeable diagonal in piece order, so the answer does not depend on
    // the order a map happened to hand back.
    outer: for (let i = 0; i < pieces.length && !merging; i++) {
      const a = pieces[i];
      if (!a) continue;
      for (let ai = 0; ai < a.length; ai++) {
        const u = a[ai]!;
        const v = a[(ai + 1) % a.length]!;
        if (isOutlineEdge(u, v)) continue;
        for (let j = 0; j < pieces.length; j++) {
          if (j === i) continue;
          const b = pieces[j];
          if (!b) continue;
          // The neighbour walks the shared edge the other way round, both
          // pieces being wound the same way.
          const bi = b.findIndex((x, k) => x === v && b[(k + 1) % b.length] === u);
          if (bi < 0) continue;
          const merged = joinAcrossEdge(a, ai, b, bi);
          if (!isConvexLoop(merged.map((k) => loop[k]!))) continue;
          pieces[i] = merged;
          pieces[j] = null;
          merging = true;
          break outer;
        }
      }
    }
  }
  return pieces.filter((p): p is number[] => p !== null);
}

// Two loops sharing the edge a[ai]→a[ai+1] = u→v and b[bi]→b[bi+1] = v→u, joined
// into one by walking each from just past the shared edge round to its start:
// a from after v round to u, then b from after u round to v. The shared edge is
// what disappears; its endpoints stay, once each.
function joinAcrossEdge(a: number[], ai: number, b: number[], bi: number): number[] {
  const out: number[] = [];
  for (let k = 2; k <= a.length; k++) out.push(a[(ai + k) % a.length]!);
  for (let k = 2; k <= b.length; k++) out.push(b[(bi + k) % b.length]!);
  return out;
}

// Drop vertices that sit on the straight line between their neighbours. The
// engine tolerates them, but they are an artefact of where a diagonal happened
// to meet a face rather than a corner of anything, and a piece that carries them
// reports more vertices than it has corners everywhere it is inspected.
function dropCollinear(verts: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const prev = out.length ? out[out.length - 1]! : verts[(i + n - 1) % n]!;
    const next = verts[(i + 1) % n]!;
    const e1 = verts[i]!.sub(prev);
    const e2 = next.sub(verts[i]!);
    if (Math.abs(e1.cross(e2)) <= CROSS_EPSILON && e1.dot(e2) > 0) continue;
    out.push(verts[i]!);
  }
  return out;
}
