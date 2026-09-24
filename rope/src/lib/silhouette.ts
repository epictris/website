// THE OUTLINE OF A PILE OF TRIANGLES: rasterise them, keep the largest solid
// blob, walk its outer edge, and simplify the walk into a polygon.
//
// What it is for: a generated rock (docs/rocks.md) is built FROM an authored
// outline but does not end ON it - the shards bulge, stagger and fall back - so
// the outline the ball should collide with is the rock's own silhouette as the
// camera sees it head-on. The editor's "fit collision to rock" projects every
// triangle of the generated node along z and hands the flat triangles here.
//
// Why a raster rather than a polygon union: a rock is tens of thousands of
// overlapping, often sliver, triangles, and an exact union of that many is a
// robustness project of its own (every shared edge is a coincident-segment
// case). A grid at 1 cm is exact to a centimetre, has no degenerate cases, and
// the simplification that follows throws away far more than that anyway.
//
// Pure arithmetic, no three and no DOM, so it runs under bun (`cli silhouette`)
// exactly as it runs in the editor. Units are whatever the triangles are in;
// the defaults assume metres.

export interface SilPoint {
  x: number;
  y: number;
}

export type SilTriangle = readonly [SilPoint, SilPoint, SilPoint];

export interface SilhouetteOptions {
  // Grid cell size, in the triangles' units. The traced outline runs along cell
  // edges, so it is within one cell of the true silhouette.
  cell?: number;
  // Ramer-Douglas-Peucker tolerance: no traced point is further than this from
  // the simplified outline.
  tolerance?: number;
  // Empty cells kept round the triangles' bounds, so the walk never touches the
  // grid's edge.
  margin?: number;
  // The largest grid the raster may allocate, in cells; past it the call throws
  // rather than stalling a browser tab on a rock the size of the level.
  maxCells?: number;
}

export interface SilhouetteResult {
  // The simplified outer outline, in the engine's winding (`polySignedArea2`
  // positive: clockwise on screen with y down), no repeated closing vertex.
  verts: SilPoint[];
  // How many cells the largest blob covered, and how many blobs there were:
  // a rock that rasterises to several pieces keeps only the largest, and the
  // caller may want to say so.
  cells: number;
  components: number;
  // The traced loop's vertex count before simplification (collinear runs
  // already merged), for reporting.
  traced: number;
}

export const SILHOUETTE_CELL = 0.01;
export const SILHOUETTE_TOLERANCE = 0.02;
const DEFAULT_MARGIN = 2;
const DEFAULT_MAX_CELLS = 40_000_000;

// Twice the signed area of a loop, in the engine's sense (see
// `engine/shapes.ts` `polySignedArea2`).
function signedArea2(vs: readonly SilPoint[]): number {
  let s = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % vs.length]!;
    s += a.x * b.y - a.y * b.x;
  }
  return s;
}

export function silhouette(
  tris: readonly SilTriangle[],
  opts: SilhouetteOptions = {},
): SilhouetteResult {
  const cell = opts.cell ?? SILHOUETTE_CELL;
  const tol = opts.tolerance ?? SILHOUETTE_TOLERANCE;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const maxCells = opts.maxCells ?? DEFAULT_MAX_CELLS;
  const empty: SilhouetteResult = { verts: [], cells: 0, components: 0, traced: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tris) {
    for (const p of t) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!(maxX > minX) || !(maxY > minY)) return empty;

  // The grid. Cell (i, j) covers [ox + i*cell, ox + (i+1)*cell) in x, and the
  // same in y; it is FILLED when its centre is inside some triangle.
  const ox = Math.floor(minX / cell) * cell - margin * cell;
  const oy = Math.floor(minY / cell) * cell - margin * cell;
  const W = Math.ceil((maxX - ox) / cell) + margin + 1;
  const H = Math.ceil((maxY - oy) / cell) + margin + 1;
  if (W * H > maxCells) {
    throw new Error(
      `silhouette: ${W} x ${H} cells at ${cell} is past the ${maxCells}-cell budget`,
    );
  }
  const grid = new Uint8Array(W * H);

  for (const [a, b, c] of tris) {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    // An edge-on face projects to a line and covers nothing; its neighbours
    // on the front do.
    if (!(Math.abs(area) > 1e-14)) continue;
    const s = area > 0 ? 1 : -1;
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - ox) / cell));
    const i1 = Math.min(W - 1, Math.floor((Math.max(a.x, b.x, c.x) - ox) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y, c.y) - oy) / cell));
    const j1 = Math.min(H - 1, Math.floor((Math.max(a.y, b.y, c.y) - oy) / cell));
    // A centre ON a shared edge counts for both triangles, so two faces that
    // meet leave no crack between them.
    const eps = -1e-12 * Math.abs(area);
    for (let j = j0; j <= j1; j++) {
      const py = oy + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const k = j * W + i;
        if (grid[k]) continue;
        const px = ox + (i + 0.5) * cell;
        const e0 = s * ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x));
        if (e0 < eps) continue;
        const e1 = s * ((c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x));
        if (e1 < eps) continue;
        const e2 = s * ((a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x));
        if (e2 < eps) continue;
        grid[k] = 1;
      }
    }
  }

  // No PINCHES. Two filled cells touching only at a corner leave a vertex the
  // outline would pass through twice, which is a polygon touching itself. Fill
  // one of the two empty cells of every such 2x2 block (a centimetre of
  // outline at most) until none is left; filling only ever adds, so it ends.
  for (let changed = true; changed; ) {
    changed = false;
    for (let j = 0; j + 1 < H; j++) {
      for (let i = 0; i + 1 < W; i++) {
        const k = j * W + i;
        const p = grid[k]!;
        const q = grid[k + 1]!;
        const r = grid[k + W]!;
        const t = grid[k + W + 1]!;
        if (p && t && !q && !r) {
          grid[k + 1] = 1;
          changed = true;
        } else if (q && r && !p && !t) {
          grid[k] = 1;
          changed = true;
        }
      }
    }
  }

  // The blobs, 4-connected, and the largest of them.
  const label = new Int32Array(W * H);
  let components = 0;
  let best = 0;
  let bestSize = 0;
  const stack: number[] = [];
  for (let k = 0; k < W * H; k++) {
    if (!grid[k] || label[k]) continue;
    const id = ++components;
    let size = 0;
    label[k] = id;
    stack.push(k);
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const ci = c % W;
      const neighbours = [
        ci > 0 ? c - 1 : -1,
        ci < W - 1 ? c + 1 : -1,
        c >= W ? c - W : -1,
        c < W * (H - 1) ? c + W : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || !grid[n] || label[n]) continue;
        label[n] = id;
        stack.push(n);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  if (best === 0) return empty;

  // The blob's boundary as directed cell edges on the corner lattice (corner
  // (i, j) at x = ox + i*cell, y = oy + j*cell). Every exposed edge is walked
  // the same way round its own cell - top rightward, right side down, bottom
  // leftward, left side up - so the loops come out consistently wound: the
  // outer one clockwise with y down (the engine's winding), each hole the other
  // way. With no pinches every corner starts at most one edge, so the edges
  // link into loops by their start corner alone. The outer loop is the one
  // enclosing the most area; the holes are ignored.
  const CW = W + 1;
  const next = new Map<number, number>();
  const inBlob = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < W && j < H && label[j * W + i] === best;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (label[j * W + i] !== best) continue;
      if (!inBlob(i, j - 1)) next.set(j * CW + i, j * CW + i + 1);
      if (!inBlob(i + 1, j)) next.set(j * CW + i + 1, (j + 1) * CW + i + 1);
      if (!inBlob(i, j + 1)) next.set((j + 1) * CW + i + 1, (j + 1) * CW + i);
      if (!inBlob(i - 1, j)) next.set((j + 1) * CW + i, j * CW + i);
    }
  }
  let outer: SilPoint[] = [];
  let outerArea = 0;
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: SilPoint[] = [];
    let c = start;
    while (!seen.has(c)) {
      seen.add(c);
      loop.push({ x: ox + (c % CW) * cell, y: oy + Math.floor(c / CW) * cell });
      const n = next.get(c);
      if (n === undefined) break;
      c = n;
    }
    const a = Math.abs(signedArea2(loop));
    if (a > outerArea) {
      outerArea = a;
      outer = loop;
    }
  }

  const traced = dropCollinear(outer);
  let verts = simplifyLoop(traced, tol);
  if (signedArea2(verts) < 0) verts = verts.reverse();
  return { verts, cells: bestSize, components, traced: traced.length };
}

// Corners only: a lattice walk has a vertex at every cell corner along a
// straight run, and those carry no shape.
function dropCollinear(loop: readonly SilPoint[]): SilPoint[] {
  const out: SilPoint[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n]!;
    const b = loop[i]!;
    const c = loop[(i + 1) % n]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) out.push(b);
  }
  return out;
}

// Squared distance from p to the segment ab.
function segDist2(p: SilPoint, a: SilPoint, b: SilPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = a.x + dx * t - p.x;
  const ey = a.y + dy * t - p.y;
  return ex * ex + ey * ey;
}

// Ramer-Douglas-Peucker on an open run, iteratively (a traced rock edge is
// thousands of points, and a recursion that deep is a stack overflow waiting).
function rdp(pts: readonly SilPoint[], tol2: number): boolean[] {
  const keep = pts.map(() => false);
  if (pts.length === 0) return keep;
  keep[0] = true;
  keep[pts.length - 1] = true;
  const spans: Array<[number, number]> = [[0, pts.length - 1]];
  while (spans.length) {
    const [s, e] = spans.pop()!;
    let worst = -1;
    let worstD = tol2;
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(pts[i]!, pts[s]!, pts[e]!);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = true;
    spans.push([s, worst], [worst, e]);
  }
  return keep;
}

// RDP on a closed loop. The loop is cut at two anchors - its lowest-then-
// leftmost point, which is a corner of any loop, and the point furthest from it
// - and each half simplified on its own. The anchors are then asked the same
// question as every other point: an anchor that lies within tolerance of the
// line its neighbours make (and so do the points between them) is dropped, so
// the cut does not leave a vertex in the middle of a straight side.
export function simplifyLoop(loop: readonly SilPoint[], tol: number): SilPoint[] {
  const n = loop.length;
  if (n <= 3) return [...loop];
  const tol2 = tol * tol;
  let a = 0;
  for (let i = 1; i < n; i++) {
    const p = loop[i]!;
    const q = loop[a]!;
    if (p.y > q.y || (p.y === q.y && p.x < q.x)) a = i;
  }
  let b = a;
  let far = -1;
  for (let i = 0; i < n; i++) {
    const dx = loop[i]!.x - loop[a]!.x;
    const dy = loop[i]!.y - loop[a]!.y;
    if (dx * dx + dy * dy > far) {
      far = dx * dx + dy * dy;
      b = i;
    }
  }
  // Indices round the loop from a to b, then from b back to a.
  const run = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      out.push(i);
      if (i === to) break;
    }
    return out;
  };
  const r1 = run(a, b);
  const r2 = run(b, a);
  const k1 = rdp(r1.map((i) => loop[i]!), tol2);
  const k2 = rdp(r2.map((i) => loop[i]!), tol2);
  const kept = new Set<number>();
  r1.forEach((i, k) => k1[k] && kept.add(i));
  r2.forEach((i, k) => k2[k] && kept.add(i));
  let idx = [...kept].sort((x, y) => x - y);

  // The anchors' second look.
  for (const anchor of [a, b]) {
    if (idx.length <= 3) break;
    const at = idx.indexOf(anchor);
    if (at < 0) continue;
    const prev = idx[(at + idx.length - 1) % idx.length]!;
    const nextI = idx[(at + 1) % idx.length]!;
    let ok = true;
    for (let i = (prev + 1) % n; i !== nextI; i = (i + 1) % n) {
      if (segDist2(loop[i]!, loop[prev]!, loop[nextI]!) > tol2) {
        ok = false;
        break;
      }
    }
    if (ok) idx = idx.filter((i) => i !== anchor);
  }
  return idx.map((i) => loop[i]!);
}
