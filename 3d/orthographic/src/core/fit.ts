// Fitting an object's front outline to its trace: the inverse projection.
// Given the silhouette traced in the perspective reference, and top and side
// views designed from understanding the scene, find the front outline whose
// solid (front ∩ top ∩ side) shows exactly inside the trace through the
// camera. Pure; runs in the page and on the server.
//
//   1. Rasterise the front plane over the top view's x range and the side
//      view's z range (cells from a budget of about 700k).
//   2. For each cell, sample depth across the object's y range; a sample is
//      valid where the top view contains (x, y) and the side view (y, z).
//   3. Accept the cell when it has a valid sample and every valid sample
//      projects inside the trace (tested exactly against the polygon, so
//      points off the image still have to stay inside the trace, extended
//      beyond it), and, with restOn, none lies inside one of those objects.
//   4. Keep the largest 4-connected region, fill its holes, and turn it into a
//      polygon by joining cell squares on the integer grid; simplify.
//   5. With trim, replace the top and side by the solid's own shadows, and
//      stretch shared axes so the three views agree exactly.

import { cameraMatrices } from "./camera";
import { buildSolid, projectSolid } from "./mesher";
import { type ImageSize, imageToFrame, overlayGeometry } from "./overlay";
import { frameRay } from "./raycast";
import { polyArea, ringExtent, ringValid, simplify, worldRing } from "./ring";
import type { EditorState, Point, Ring, SceneObject, ViewId } from "./types";
import { VIEW_IDS, VIEWS } from "./views";

export interface FitOptions {
  /** The part to fit (default 0); its top and side are the defaults. */
  part?: number;
  /** Top outline [x, y] in metres (default: the object's own). */
  top?: Ring;
  /** Side outline [y, z] in metres (default: the object's own). */
  side?: Ring;
  /** Objects the fitted solid must not enter (it rests on them). */
  restOn?: SceneObject[];
  /** Replace the top and side by the fitted solid's own shadows (default true). */
  trim?: boolean;
  /** Most points in any fitted outline (default 160). */
  maxPoints?: number;
  /** Cells on the front plane (default about 700k). */
  cells?: number;
  /** Depth samples per cell (default 96). */
  depthSamples?: number;
}

export interface FitResult {
  /** The three outlines in metres, ready for setOutlines. */
  outlines: Record<ViewId, Ring>;
  /** The front plane's cell size in metres. */
  cell: number;
}

export class FitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where a line crosses a ring's edges: for v = c the u values, for u = c the v values; sorted. */
function crossings(ring: Ring, c: number, along: 0 | 1): number[] {
  const out: number[] = [];
  const k = along === 0 ? 1 : 0; // the coordinate held at c
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a[k] > c !== b[k] > c) out.push(a[along] + ((c - a[k]) / (b[k] - a[k])) * (b[along] - a[along]));
  }
  return out.sort((p, q) => p - q);
}

/** Mark samples t0 + (j + 0.5) * dt (j < count) that fall inside the spans of sorted crossings. */
function fillSpans(xs: number[], t0: number, dt: number, count: number, out: Uint8Array, offset = 0) {
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const from = Math.max(0, Math.ceil((xs[k] - t0) / dt - 0.5));
    const to = Math.min(count - 1, Math.ceil((xs[k + 1] - t0) / dt - 0.5) - 1);
    for (let j = from; j <= to; j++) out[offset + j] = 1;
  }
}

/**
 * An exact inside test for a polygon (even-odd), fast for many queries: its
 * edges are indexed by horizontal bands, so a query looks at the few edges
 * crossing its own band. Exact on the image and off it alike.
 */
export function polygonTest(points: Point[]): (x: number, y: number) => boolean {
  const { lo, hi } = ringExtent(points);
  const bands = Math.max(1, Math.min(65536, Math.ceil(hi[1] - lo[1])));
  const bandH = (hi[1] - lo[1]) / bands || 1;
  const index: number[][] = Array.from({ length: bands }, () => []);
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    if (a[1] === b[1]) return;
    const from = Math.max(0, Math.floor((Math.min(a[1], b[1]) - lo[1]) / bandH));
    const to = Math.min(bands - 1, Math.floor((Math.max(a[1], b[1]) - lo[1]) / bandH));
    for (let k = from; k <= to; k++) index[k].push(i);
  });
  return (x, y) => {
    if (y < lo[1] || y >= hi[1] || x < lo[0] || x >= hi[0]) return false;
    let inside = false;
    for (const i of index[Math.min(bands - 1, Math.floor((y - lo[1]) / bandH))]) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
    }
    return inside;
  };
}

/**
 * How far, in frame pixels, a point inside the trace is from its edge, at
 * least (0 or less where unknown, outside or close): an exact distance
 * transform of the trace's raster, less the most a pixel can hide. Samples
 * within that distance of a tested one need no test of their own; anything
 * near the edge is tested exactly. (An outside sliver thinner than a pixel,
 * which no pixel centre lands in, is not seen, as with any raster.)
 */
function clearanceOf(points: Point[], inside: (x: number, y: number) => boolean): (x: number, y: number) => number {
  const { lo, hi } = ringExtent(points);
  const x0 = Math.floor(lo[0]);
  const y0 = Math.floor(lo[1]);
  const w = Math.ceil(hi[0]) - x0 + 1;
  const h = Math.ceil(hi[1]) - y0 + 1;
  if (w * h > 16e6) return () => 0;
  // Squared distance from each pixel centre to the nearest pixel centre outside the trace.
  const INF = 1e20;
  const d = new Float64Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) d[r * w + c] = inside(x0 + c + 0.5, y0 + r + 0.5) ? INF : 0;
  const line = (get: (i: number) => number, set: (i: number, v: number) => void, n: number) => {
    // Felzenszwalb and Huttenlocher's 1D squared distance transform.
    const f = new Float64Array(n);
    for (let i = 0; i < n; i++) f[i] = get(i);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let sv = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (sv <= z[k]) {
        k--;
        sv = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = sv;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      set(q, (q - v[k]) ** 2 + f[v[k]]);
    }
  };
  // Pixels beyond the raster count as outside: pad by treating the border as outside once.
  for (let r = 0; r < h; r++)
    line(
      (c) => (c === 0 || c === w - 1 ? Math.min(d[r * w + c], 1) : d[r * w + c]),
      (c, v) => {
        d[r * w + c] = v;
      },
      w,
    );
  for (let c = 0; c < w; c++)
    line(
      (r) => (r === 0 || r === h - 1 ? Math.min(d[r * w + c], 1) : d[r * w + c]),
      (r, v) => {
        d[r * w + c] = v;
      },
      h,
    );
  return (x, y) => {
    const c = Math.floor(x) - x0;
    const r = Math.floor(y) - y0;
    if (c < 0 || r < 0 || c >= w || r >= h) return 0;
    // The point is within 0.71 px of its pixel's centre, and the edge within 1 px of the nearest outside centre.
    return Math.sqrt(d[r * w + c]) - 1.75;
  };
}

// ---- Cell grids ------------------------------------------------------------------------

/** Keep only the largest 4-connected region of set cells. */
function largestRegion(mask: Uint8Array, nx: number, nz: number): number {
  const label = new Int32Array(nx * nz);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let size = 0;
    label[start] = next;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const x = k % nx;
      const z = (k - x) / nx;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = x + dx;
        const zz = z + dz;
        if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
        const j = zz * nx + xx;
        if (mask[j] && !label[j]) {
          label[j] = next;
          stack.push(j);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  for (let k = 0; k < mask.length; k++) mask[k] = label[k] === best && best ? 1 : 0;
  return bestSize;
}

/** Set every empty cell the grid's border cannot reach through empty cells (4-connected). */
function fillHoles(mask: Uint8Array, nx: number, nz: number) {
  const outside = new Uint8Array(nx * nz);
  const stack: number[] = [];
  const seed = (k: number) => {
    if (!mask[k] && !outside[k]) {
      outside[k] = 1;
      stack.push(k);
    }
  };
  for (let x = 0; x < nx; x++) {
    seed(x);
    seed((nz - 1) * nx + x);
  }
  for (let z = 0; z < nz; z++) {
    seed(z * nx);
    seed(z * nx + nx - 1);
  }
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % nx;
    const z = (k - x) / nx;
    if (x > 0) seed(k - 1);
    if (x < nx - 1) seed(k + 1);
    if (z > 0) seed(k - nx);
    if (z < nz - 1) seed(k + nx);
  }
  for (let k = 0; k < mask.length; k++) if (!outside[k]) mask[k] = 1;
}

/**
 * Fill one empty cell of every diagonal pair (a 2x2 block set on one diagonal
 * only): there the region's outline would touch itself at a corner.
 */
function closeDiagonals(mask: Uint8Array, nx: number, nz: number): boolean {
  let changed = false;
  for (let z = 0; z + 1 < nz; z++)
    for (let x = 0; x + 1 < nx; x++) {
      const a = mask[z * nx + x];
      const b = mask[z * nx + x + 1];
      const c = mask[(z + 1) * nx + x];
      const d = mask[(z + 1) * nx + x + 1];
      if (a && d && !b && !c) {
        mask[z * nx + x + 1] = 1;
        changed = true;
      } else if (b && c && !a && !d) {
        mask[z * nx + x] = 1;
        changed = true;
      }
    }
  return changed;
}

/** One region without holes or corner contacts, as the grid would draw it. */
function solidRegion(mask: Uint8Array, nx: number, nz: number): number {
  let size = largestRegion(mask, nx, nz);
  if (!size) return 0;
  do fillHoles(mask, nx, nz);
  while (closeDiagonals(mask, nx, nz));
  size = 0;
  for (let k = 0; k < mask.length; k++) size += mask[k];
  return size;
}

/**
 * The outline of a region of cells (one 4-connected region without holes or
 * corner contacts) on the integer grid: cell (x, z) is the square x..x+1,
 * z..z+1. Counter-clockwise, collinear corners dropped.
 */
function regionOutline(mask: Uint8Array, nx: number, nz: number): Ring {
  const at = (x: number, z: number) => x >= 0 && z >= 0 && x < nx && z < nz && mask[z * nx + x] === 1;
  // Directed boundary edges with the region on their left, keyed by start corner.
  const from = new Map<number, number>();
  const key = (x: number, z: number) => z * (nx + 1) + x;
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      if (!at(x, z)) continue;
      if (!at(x, z - 1)) from.set(key(x, z), key(x + 1, z));
      if (!at(x + 1, z)) from.set(key(x + 1, z), key(x + 1, z + 1));
      if (!at(x, z + 1)) from.set(key(x + 1, z + 1), key(x, z + 1));
      if (!at(x - 1, z)) from.set(key(x, z + 1), key(x, z));
    }
  const start = from.keys().next().value;
  if (start === undefined) return [];
  const corners: Point[] = [];
  let k = start;
  do {
    corners.push([k % (nx + 1), Math.floor(k / (nx + 1))]);
    k = from.get(k)!;
  } while (k !== start && corners.length <= from.size);
  return corners.filter((p, i) => {
    const a = corners[(i - 1 + corners.length) % corners.length];
    const c = corners[(i + 1) % corners.length];
    return (p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0]) !== 0;
  });
}

// ---- The fit ---------------------------------------------------------------------------

/** The trace in frame pixels, for the camera frame's own size. */
function traceOnFrame(s: EditorState, e: SceneObject, image: ImageSize): Point[] {
  const ref = s.references.perspective;
  if (!e.trace || !ref) throw new FitError("no-trace", `${e.id} has no trace to fit to; record one with set_trace.`);
  const [W, H] = s.camera.frame;
  const g = overlayGeometry(W, H, ref, image);
  return e.trace.points.map((p) => imageToFrame(g, image, p));
}

/** Membership of a solid (three world rings) along the fit's grid. */
interface Blocker {
  /** Per column x_i, the y samples inside the top ring. */
  top: Uint8Array;
  /** Per column x_i, the z rows inside the front ring. */
  front: Uint8Array;
  /** Per row z_k, the y samples inside the side ring. */
  side: Uint8Array;
}

/**
 * Fit the front outline of `e` to its trace, keeping the given (or its own)
 * top and side views. Throws FitError when nothing fits.
 */
export function fitFront(s: EditorState, e: SceneObject, image: ImageSize, opts: FitOptions = {}): FitResult {
  const trace = traceOnFrame(s, e, image);
  const top = opts.top ?? worldRing(e, "top", opts.part ?? 0);
  const side = opts.side ?? worldRing(e, "side", opts.part ?? 0);
  for (const [name, r] of [
    ["top", top],
    ["side", side],
  ] as const)
    if (!ringValid(r)) throw new FitError("invalid-outline", `The ${name} outline is not a simple polygon.`);
  const te = ringExtent(top);
  const se = ringExtent(side);
  const [x0, x1] = [te.lo[0], te.hi[0]];
  const [z0, z1] = [se.lo[1], se.hi[1]];
  const [y0, y1] = [Math.max(te.lo[1], se.lo[0]), Math.min(te.hi[1], se.hi[0])];
  if (!(y1 > y0)) throw new FitError("no-common-depth", "The top and side outlines share no depth (y) range.");
  const budget = opts.cells ?? 700_000;
  const cell = Math.sqrt(((x1 - x0) * (z1 - z0)) / budget);
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const ny = opts.depthSamples ?? 96;
  const dy = (y1 - y0) / ny;
  const xOf = (i: number) => x0 + (i + 0.5) * cell;
  const zOf = (k: number) => z0 + (k + 0.5) * cell;
  const yOf = (j: number) => y0 + (j + 0.5) * dy;

  // Per column, the depth samples the top allows; per row, those the side allows.
  const topIn = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) fillSpans(crossings(top, xOf(i), 1), y0, dy, ny, topIn, i * ny);
  const sideIn = new Uint8Array(nz * ny);
  for (let k = 0; k < nz; k++) fillSpans(crossings(side, zOf(k), 0), y0, dy, ny, sideIn, k * ny);

  // Every part of every object rested on is a solid to keep out of.
  const blockers: Blocker[] = (opts.restOn ?? [])
    .flatMap((q) => q.parts.map((_, k) => [q, k] as const))
    .map(([q, k]) => {
      const qTop = worldRing(q, "top", k);
      const qFront = worldRing(q, "front", k);
      const qSide = worldRing(q, "side", k);
      const b: Blocker = {
        top: new Uint8Array(nx * ny),
        front: new Uint8Array(nx * nz),
        side: new Uint8Array(nz * ny),
      };
      for (let i = 0; i < nx; i++) {
        fillSpans(crossings(qTop, xOf(i), 1), y0, dy, ny, b.top, i * ny);
        fillSpans(crossings(qFront, xOf(i), 1), z0, cell, nz, b.front, i * nz);
      }
      for (let k = 0; k < nz; k++) fillSpans(crossings(qSide, zOf(k), 0), y0, dy, ny, b.side, k * ny);
      return b;
    });

  const inTrace = polygonTest(trace);
  const clearance = clearanceOf(trace, inTrace);
  const vp = cameraMatrices(s.camera).vp;
  const [W, H] = s.camera.frame;
  const mask = new Uint8Array(nx * nz);
  const pa = [0, 0];
  const pb = [0, 0];
  const B0 = vp[4];
  const B1 = vp[5];
  const B3 = vp[7];
  for (let k = 0; k < nz; k++) {
    const z = zOf(k);
    for (let i = 0; i < nx; i++) {
      const x = xOf(i);
      // Clip coordinates of (x, y, z) are A + y * B.
      const A0 = vp[0] * x + vp[8] * z + vp[12];
      const A1 = vp[1] * x + vp[9] * z + vp[13];
      const A3 = vp[3] * x + vp[11] * z + vp[15];
      const screen = (y: number, out: number[]): boolean => {
        const w = A3 + y * B3;
        if (w <= 0) return false;
        out[0] = ((A0 + y * B0) / w) * 0.5 * W + 0.5 * W;
        out[1] = (-(A1 + y * B1) / w) * 0.5 * H + 0.5 * H;
        return true;
      };
      const blocked = blockers.filter((b) => b.front[i * nz + k]);
      let valid = 0;
      let ok = true;
      // Runs of consecutive valid samples project to straight segments: a run whose start is
      // further from the trace's edge than the run is long lies inside it whole.
      for (let j = 0; j < ny && ok; ) {
        if (!topIn[i * ny + j] || !sideIn[k * ny + j]) {
          j++;
          continue;
        }
        let end = j;
        while (end + 1 < ny && topIn[i * ny + end + 1] && sideIn[k * ny + end + 1]) end++;
        valid += end - j + 1;
        for (const b of blocked)
          for (let q = j; q <= end && ok; q++) if (b.top[i * ny + q] && b.side[k * ny + q]) ok = false;
        // Step along the run: every sample within the clearance of the last one tested is inside too.
        for (let q = j; q <= end && ok; ) {
          if (!screen(yOf(q), pa)) {
            ok = false;
            break;
          }
          const reach = clearance(pa[0], pa[1]);
          if (reach <= 0) {
            if (!inTrace(pa[0], pa[1])) ok = false;
            q++;
            continue;
          }
          // Along a projected line the distance from pa grows with q: find the last sample within reach.
          const r2 = reach * reach;
          const within = (t: number) => screen(yOf(t), pb) && (pb[0] - pa[0]) ** 2 + (pb[1] - pa[1]) ** 2 < r2;
          let lo = q;
          let hi = end + 1;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (within(mid)) lo = mid;
            else hi = mid;
          }
          q = lo + 1;
        }
        j = end + 1;
      }
      if (ok && valid) mask[k * nx + i] = 1;
    }
  }
  if (!solidRegion(mask, nx, nz))
    throw new FitError(
      "fit-empty",
      `No part of ${e.id}'s front plane shows inside its trace with these top and side views: every column of depth samples projects partly outside the trace${opts.restOn?.length ? " or into an object it rests on" : ""}. Check the top and side views are where the trace says the object is (their x and z ranges, and depth).`,
    );
  const maxPoints = opts.maxPoints ?? 160;
  const grid = regionOutline(mask, nx, nz);
  const frontGrid = simplify(grid, { maxError: 0.75, maxPoints });
  const front: Ring = frontGrid.map(([gx, gz]) => [x0 + gx * cell, z0 + gz * cell] as Point);
  const outlines: Record<ViewId, Ring> = {
    front,
    top: top.map((p) => [...p] as Point),
    side: side.map((p) => [...p] as Point),
  };
  return { outlines: opts.trim === false ? outlines : trim(outlines, cell, maxPoints), cell };
}

/**
 * Replace the top and side by the shadows of the solid the three outlines
 * make, and stretch all three so they span the solid's own box exactly.
 */
export function trim(outlines: Record<ViewId, Ring>, tolerance: number, maxPoints: number): Record<ViewId, Ring> {
  // Normalise to the three outlines' common box, where the mesher works.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const view of VIEW_IDS)
    VIEWS[view].axes.forEach((axis, j) => {
      for (const p of outlines[view]) {
        lo[axis] = Math.min(lo[axis], p[j]);
        hi[axis] = Math.max(hi[axis], p[j]);
      }
    });
  const size = hi.map((h, a) => h - lo[a]);
  const norm = (view: ViewId, p: Point): Point => {
    const [a, b] = VIEWS[view].axes;
    return [(p[0] - lo[a]) / size[a], (p[1] - lo[b]) / size[b]];
  };
  const unit = Object.fromEntries(VIEW_IDS.map((v) => [v, outlines[v].map((p) => norm(v, p))])) as Record<ViewId, Ring>;
  const solid = buildSolid(unit);
  try {
    if (solid.isEmpty()) throw new FitError("no-common-volume", "The fitted outlines share no volume.");
    const box = solid.boundingBox();
    const out = { ...outlines };
    for (const view of ["top", "side"] as ViewId[]) {
      const shadow = projectSolid(solid, view);
      const polys = shadow.toPolygons();
      shadow.delete();
      const largest = polys.reduce((m, p) => (Math.abs(polyArea(p as Ring)) > Math.abs(polyArea(m as Ring)) ? p : m));
      const [a, b] = VIEWS[view].axes;
      const world = (largest as Point[]).map((p) => [lo[a] + p[0] * size[a], lo[b] + p[1] * size[b]] as Point);
      const simplified = simplify(world, { maxError: tolerance * 0.5, maxPoints });
      if (ringValid(simplified)) out[view] = simplified;
    }
    // The solid's box, in metres; every outline stretched to it on its two axes.
    const bmin = [0, 1, 2].map((a) => lo[a] + box.min[a] * size[a]);
    const bmax = [0, 1, 2].map((a) => lo[a] + box.max[a] * size[a]);
    for (const view of VIEW_IDS) out[view] = stretch(out[view], VIEWS[view].axes, bmin, bmax);
    return out;
  } finally {
    solid.delete();
  }
}

/** Map a ring linearly so it spans exactly bmin..bmax on each of its two axes. */
function stretch(ring: Ring, axes: [number, number], bmin: number[], bmax: number[]): Ring {
  const { lo, hi } = ringExtent(ring);
  return ring.map(
    (p) =>
      [0, 1].map((j) => {
        const a = axes[j];
        const span = hi[j] - lo[j];
        return span > 0 ? bmin[a] + ((p[j] - lo[j]) / span) * (bmax[a] - bmin[a]) : p[j];
      }) as Point,
  );
}

/**
 * Plain prisms from the trace and a depth range: the box between y = yMin and
 * y = yMax that the trace's rays pass through, as rectangles in all three
 * views. A starting point for fitFront, which shapes the front from it.
 */
export function suggestViews(
  s: EditorState,
  e: SceneObject,
  image: ImageSize,
  yMin: number,
  yMax: number,
): Record<ViewId, Ring> {
  if (!(yMax > yMin)) throw new FitError("invalid-depth", "The depth range needs min < max (metres along y).");
  const trace = traceOnFrame(s, e, image);
  const [W, H] = s.camera.frame;
  const xs: number[] = [];
  const zs: number[] = [];
  for (const [px, py] of trace) {
    const ray = frameRay(s.camera, px, py, W, H);
    if (Math.abs(ray.dir[1]) < 1e-9) continue;
    for (const y of [yMin, yMax]) {
      const t = (y - ray.origin[1]) / ray.dir[1];
      if (t <= 0) continue;
      xs.push(ray.origin[0] + t * ray.dir[0]);
      zs.push(ray.origin[2] + t * ray.dir[2]);
    }
  }
  if (!xs.length)
    throw new FitError("invalid-depth", "The trace's rays do not reach that depth range: it is behind the camera.");
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const rect = (a0: number, a1: number, b0: number, b1: number): Ring => [
    [a0, b0],
    [a1, b0],
    [a1, b1],
    [a0, b1],
  ];
  return { front: rect(x0, x1, z0, z1), top: rect(x0, x1, yMin, yMax), side: rect(yMin, yMax, z0, z1) };
}
