// Silhouette cases: flat triangle piles with the outline written down, run by
// `cli silhouette`.
//
// `silhouette` (lib/silhouette.ts) is what the editor's "fit collision to rock"
// turns a generated rock's projected triangles into, and what it produces
// becomes a COLLISION outline - so a wrong answer is a wall the ball meets a
// few centimetres off the rock it can see. It is pure geometry, so it is
// checked directly here rather than through a GLB.
//
// Every case asserts the outline's vertex count, that every vertex is within
// `NEAR` of a true corner and every true corner has a vertex that near, that
// the area is the true area to within a cell's width round the perimeter, and
// that the loop comes back in the engine's winding.

import {
  SILHOUETTE_CELL,
  silhouette,
  type SilPoint,
  type SilTriangle,
} from "../lib/silhouette";

export interface SilhouetteResultRow {
  name: string;
  passed: boolean;
  details: string[];
}

interface SilhouetteCase {
  name: string;
  tris: SilTriangle[];
  // The true outer outline, and how many vertices the simplified one should
  // have (`null` = do not assert the corners, only the count range below).
  truth: SilPoint[];
  corners: boolean;
  count: [number, number];
  // How many separate blobs the raster should find.
  components?: number;
}

const P = (x: number, y: number): SilPoint => ({ x, y });

// A quad as two triangles.
function quad(a: SilPoint, b: SilPoint, c: SilPoint, d: SilPoint): SilTriangle[] {
  return [
    [a, b, c],
    [a, c, d],
  ];
}
function box(x0: number, y0: number, x1: number, y1: number): SilTriangle[] {
  return quad(P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1));
}

// A 30-degree turn, written as numbers: the sim's sources may not call the
// platform's transcendentals (see `cli dmath`).
const COS30 = 0.8660254037844387;
const SIN30 = 0.5;
function turned(p: SilPoint): SilPoint {
  return P(p.x * COS30 - p.y * SIN30 + 3, p.x * SIN30 + p.y * COS30 - 2);
}

function area(vs: readonly SilPoint[]): number {
  let s = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % vs.length]!;
    s += a.x * b.y - a.y * b.x;
  }
  return s / 2;
}
function perimeter(vs: readonly SilPoint[]): number {
  let s = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i]!;
    const b = vs[(i + 1) % vs.length]!;
    s += Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
  }
  return s;
}
function dist(a: SilPoint, b: SilPoint): number {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

// A traced corner sits on the cell lattice, so it is within a cell's diagonal
// of the true one.
const NEAR = SILHOUETTE_CELL * 1.5;

const rotatedRect = [P(-0.8, -0.3), P(0.8, -0.3), P(0.8, 0.3), P(-0.8, 0.3)].map(turned);
const outerRing = [P(0, 0), P(2, 0), P(2, 2), P(0, 2)];

const CASES: SilhouetteCase[] = [
  {
    // Off the grid on every side, so each edge is snapped to the lattice.
    name: "a box of two triangles is a 4-vertex rectangle",
    tris: box(0.123, -0.37, 1.456, 0.58),
    truth: [P(0.123, -0.37), P(1.456, -0.37), P(1.456, 0.58), P(0.123, 0.58)],
    corners: true,
    count: [4, 4],
  },
  {
    // Two squares overlapping at a corner: one blob, the eight corners of the
    // union and none of the corners buried inside it.
    name: "two overlapping squares are one 8-vertex outline",
    tris: [...box(0, 0, 1, 1), ...box(0.6, 0.6, 1.6, 1.6)],
    truth: [P(0, 0), P(1, 0), P(1, 0.6), P(1.6, 0.6), P(1.6, 1.6), P(0.6, 1.6), P(0.6, 1), P(0, 1)],
    corners: true,
    count: [8, 8],
  },
  {
    name: "two squares sharing a side are one rectangle",
    tris: [...box(0, 0, 1, 1), ...box(1, 0, 2, 1)],
    truth: [P(0, 0), P(2, 0), P(2, 1), P(0, 1)],
    corners: true,
    count: [4, 4],
  },
  {
    // Slanted edges trace as staircases; the 2 cm simplification takes them
    // back to straight lines.
    name: "a triangle stays a triangle",
    tris: [[P(0, 0), P(1, 0.2), P(0.3, 0.9)]],
    truth: [P(0, 0), P(1, 0.2), P(0.3, 0.9)],
    corners: true,
    count: [3, 3],
  },
  {
    name: "a turned rectangle stays four corners",
    tris: quad(rotatedRect[0]!, rotatedRect[1]!, rotatedRect[2]!, rotatedRect[3]!),
    truth: rotatedRect,
    corners: true,
    count: [4, 4],
  },
  {
    // A frame of four boxes round a hole: the outline is the outside, and the
    // hole is not a second loop.
    name: "a hole is ignored",
    tris: [...box(0, 0, 2, 0.5), ...box(0, 1.5, 2, 2), ...box(0, 0.5, 0.5, 1.5), ...box(1.5, 0.5, 2, 1.5)],
    truth: outerRing,
    corners: true,
    count: [4, 4],
  },
  {
    // A stray fragment well clear of the rock: the largest blob wins.
    name: "the largest blob is kept",
    tris: [...box(0, 0, 1, 1), ...box(3, 3, 3.2, 3.2)],
    truth: [P(0, 0), P(1, 0), P(1, 1), P(0, 1)],
    corners: true,
    count: [4, 4],
    components: 2,
  },
  {
    // Winding the other way in, and triangles of mixed winding: the outline
    // does not care which way a triangle was wound.
    name: "triangle winding does not matter",
    tris: [
      [P(0, 0), P(0, 1), P(1, 1)],
      [P(0, 0), P(1, 1), P(1, 0)],
    ],
    truth: [P(0, 0), P(1, 0), P(1, 1), P(0, 1)],
    corners: true,
    count: [4, 4],
  },
];

// A 64-triangle fan: a disc of radius 0.5, the case with no true corners, so
// only the count range, the area and the radius are asserted.
{
  const fan: SilTriangle[] = [];
  const ring: SilPoint[] = [];
  // Unit circle points by rotation, no platform trig: a 64-gon's step.
  const c = 0.9951847266721969; // cos(2pi/64)
  const s = 0.0980171403295606; // sin(2pi/64)
  let x = 0.5;
  let y = 0;
  for (let i = 0; i < 64; i++) {
    ring.push(P(x + 5, y + 5));
    const nx = x * c - y * s;
    y = x * s + y * c;
    x = nx;
  }
  for (let i = 0; i < 64; i++) fan.push([P(5, 5), ring[i]!, ring[(i + 1) % 64]!]);
  CASES.push({ name: "a disc of 64 slivers", tris: fan, truth: ring, corners: false, count: [8, 40] });
}

function runCase(c: SilhouetteCase): SilhouetteResultRow {
  const details: string[] = [];
  const r = silhouette(c.tris);
  const vs = r.verts;
  details.push(`${vs.length} vertices (traced ${r.traced}), ${r.cells} cells, ${r.components} blob(s)`);
  let ok = vs.length >= c.count[0] && vs.length <= c.count[1];
  if (!ok) details.push(`expected ${c.count[0]}..${c.count[1]} vertices`);
  if (c.components !== undefined && r.components !== c.components) {
    ok = false;
    details.push(`expected ${c.components} blobs`);
  }
  if (area(vs) <= 0) {
    ok = false;
    details.push("not in the engine's winding (signed area not positive)");
  }
  const trueArea = Math.abs(area(c.truth));
  const slack = perimeter(c.truth) * SILHOUETTE_CELL;
  const err = Math.abs(area(vs) - trueArea);
  details.push(`area ${area(vs).toFixed(5)} against ${trueArea.toFixed(5)} (slack ${slack.toFixed(5)})`);
  if (!(err <= slack)) {
    ok = false;
    details.push("area off by more than a cell round the perimeter");
  }
  if (c.corners) {
    for (const v of vs) {
      const d = Math.min(...c.truth.map((t) => dist(v, t)));
      if (d > NEAR) {
        ok = false;
        details.push(`vertex (${v.x.toFixed(4)}, ${v.y.toFixed(4)}) is ${d.toFixed(4)} from every true corner`);
      }
    }
    for (const t of c.truth) {
      const d = vs.length ? Math.min(...vs.map((v) => dist(v, t))) : Infinity;
      if (d > NEAR) {
        ok = false;
        details.push(`true corner (${t.x}, ${t.y}) has no vertex within ${NEAR} (nearest ${d.toFixed(4)})`);
      }
    }
  } else {
    // The disc: every vertex within a cell plus the tolerance of the circle.
    for (const v of vs) {
      const d = Math.abs(dist(v, P(5, 5)) - 0.5);
      if (d > SILHOUETTE_CELL * 1.5 + 0.02) {
        ok = false;
        details.push(`vertex (${v.x.toFixed(4)}, ${v.y.toFixed(4)}) is ${d.toFixed(4)} off the circle`);
      }
    }
  }
  return { name: c.name, passed: ok, details };
}

export function runSilhouetteCases(): SilhouetteResultRow[] {
  return CASES.map(runCase);
}
