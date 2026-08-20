// Convex-decomposition cases: authored outlines with the answer written down,
// run by `cli decompose`.
//
// `decomposeConvex` is what stands between an authored concave outline and an
// engine that has no concave anything (see "Convex-only polygons; compound
// bodies" in docs/game-design.md), and it runs at LOAD - so a wrong cut is not a
// crash, it is a wall that is subtly not the wall the level drew, discovered
// several hundred frames into a session as a rope through a corner. It is pure
// geometry with no state, so it is checked directly here rather than through a
// level.
//
// Every case asserts the same five things, because each of them is a different
// way for the cut to be wrong:
//
//   - every piece is CONVEX and has area. This is the rule the whole exercise
//     exists to keep; a sliver piece is the ear clipper failing to notice three
//     collinear vertices.
//   - the pieces TILE the outline: their areas sum to its area, and each sits
//     inside it. Sum alone would pass two pieces overlapping while a notch went
//     unfilled, so both halves are asserted - and together they are what makes a
//     decomposed body weigh what the outline weighs and balance where it
//     balances (`makePieces` splits the object's mass by piece area).
//   - no piece introduces a VERTEX the author did not place. A Steiner point is
//     a corner of the physics that is not a corner of the drawing, and the whole
//     seam rule is written in terms of corners two pieces share.
//   - the corners the rope may bend around are the outline's own convex corners
//     and no others (`isExposedCorner`). This is the cut meeting the solver: a
//     reflex corner must stay unwrappable and a seam must not invent a corner.
//   - the PIECE COUNT is the number written here. Not a correctness property but
//     a quality one: nothing else would notice the day an L starts building as
//     six triangles instead of two.
//
// ...plus determinism, checked once over every case: the cut happens at load, so
// two machines that disagree about it disagree about the geometry itself.

import { Vec2 } from "../engine/vec2";
import {
  isConvexLoop,
  isExposedCorner,
  polyArea,
  polyShape,
  type ShapeTransform,
} from "../engine/shapes";
import { decomposeConvex, loopContainsPoint, normalizeWinding } from "../lib/polygon";

const V = (x: number, y: number): Vec2 => new Vec2(x, y);

// A regular star, as the outline an author would click out: alternating long and
// short radii. The one case here whose reflex corners are not right angles.
function star(points: number, outer: number, inner: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    pts.push(V(Math.cos(a) * r, Math.sin(a) * r));
  }
  return pts;
}

export interface DecomposeCase {
  name: string;
  verts: Vec2[];
  // How many convex pieces the cut should produce. 0 means the outline is not a
  // shape at all and nothing should be built from it.
  pieces: number;
}

export const DECOMPOSE_CASES: DecomposeCase[] = [
  // Controls: a convex outline is one piece and comes back as itself, which is
  // every polygon authored before concave ones were allowed.
  { name: "triangle", verts: [V(0, 0), V(2, 0), V(1, 2)], pieces: 1 },
  { name: "square", verts: [V(0, 0), V(2, 0), V(2, 2), V(0, 2)], pieces: 1 },
  {
    name: "hexagon",
    verts: [V(2, 0), V(1, 1.73), V(-1, 1.73), V(-2, 0), V(-1, -1.73), V(1, -1.73)],
    pieces: 1,
  },
  // The shapes a level actually wants, in the order they get harder.
  { name: "L-shaped ledge", verts: [V(0, 0), V(3, 0), V(3, 1), V(1, 1), V(1, 3), V(0, 3)], pieces: 2 },
  {
    name: "T-shaped pillar",
    verts: [V(0, 0), V(3, 0), V(3, 1), V(2, 1), V(2, 3), V(1, 3), V(1, 1), V(0, 1)],
    pieces: 2,
  },
  {
    name: "C-shaped alcove",
    verts: [V(0, 0), V(1, 0), V(1, 2), V(2, 2), V(2, 0), V(3, 0), V(3, 3), V(0, 3)],
    pieces: 3,
  },
  {
    // Two teeth: the case that catches a decomposition which resolves one reflex
    // vertex by cutting straight through the other one's notch.
    name: "comb, two teeth",
    verts: [
      V(0, 0), V(5, 0), V(5, 3), V(4, 3), V(4, 1), V(3, 1),
      V(3, 3), V(2, 3), V(2, 1), V(1, 1), V(1, 3), V(0, 3),
    ],
    pieces: 4,
  },
  {
    // A staircase: every reflex vertex is a step, and no two of them can be
    // resolved by the same cut.
    name: "staircase, three steps",
    verts: [V(0, 0), V(3, 0), V(3, 3), V(2, 3), V(2, 2), V(1, 2), V(1, 1), V(0, 1)],
    pieces: 3,
  },
  {
    // A chevron: one reflex vertex, and the cut has a choice of two diagonals.
    name: "chevron",
    verts: [V(0, 0), V(2, 2), V(4, 0), V(4, 1), V(2, 3), V(0, 1)],
    pieces: 2,
  },
  { name: "five-pointed star", verts: star(5, 2, 0.8), pieces: 5 },
  {
    // Deep and thin: a slot cut most of the way through a block, which is the
    // arrangement that makes an ear clipper produce slivers if it takes ears in
    // the wrong order.
    name: "slotted block",
    verts: [V(0, 0), V(4, 0), V(4, 4), V(2.2, 4), V(2.2, 0.5), V(1.8, 0.5), V(1.8, 4), V(0, 4)],
    pieces: 3,
  },
  {
    // Authored the other way round. Winding is normalised before anything else
    // happens, so the answer must not depend on which way the author clicked.
    name: "L-shaped ledge, wound anticlockwise",
    verts: [V(0, 3), V(1, 3), V(1, 1), V(3, 1), V(3, 0), V(0, 0)],
    pieces: 2,
  },
  // Not a shape: a loop that crosses itself has no inside to cut up. The editor
  // refuses to author one; the loader refuses to build one.
  { name: "bow tie (self-crossing)", verts: [V(0, 0), V(2, 2), V(2, 0), V(0, 2)], pieces: 0 },
  {
    name: "figure eight (self-crossing)",
    verts: [V(0, 0), V(2, 0), V(0, 2), V(2, 2)],
    pieces: 0,
  },
];

export interface DecomposeResult {
  name: string;
  passed: boolean;
  details: string[];
}

const AREA_EPSILON = 1e-9;
const POINT_EPSILON = 1e-9;

export function runDecomposeCases(): DecomposeResult[] {
  return DECOMPOSE_CASES.map(runCase);
}

function runCase(c: DecomposeCase): DecomposeResult {
  const details: string[] = [];
  const loop = normalizeWinding(c.verts);
  const pieces = decomposeConvex(c.verts);

  if (pieces.length !== c.pieces) {
    details.push(`piece count ${pieces.length}, want ${c.pieces}`);
  }
  if (c.pieces === 0) {
    return { name: c.name, passed: details.length === 0, details };
  }

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (!isConvexLoop(p)) details.push(`piece ${i} is not convex`);
    if (polyArea(p) <= AREA_EPSILON) details.push(`piece ${i} has no area`);
    // No Steiner points: every piece corner is a corner of the outline.
    for (const v of p) {
      if (!loop.some((w) => w.distanceTo(v) <= POINT_EPSILON)) {
        details.push(`piece ${i} invents a vertex at (${v.x}, ${v.y})`);
      }
    }
    // Inside the outline: the centroid of a convex piece is interior to it, so a
    // piece that has escaped into a notch is caught here rather than by the area
    // sum, which a piece outside plus a gap inside could balance.
    if (!loopContainsPoint(loop, centroid(p))) details.push(`piece ${i} is not inside the outline`);
  }

  const sum = pieces.reduce((s, p) => s + polyArea(p), 0);
  const whole = polyArea(loop);
  if (Math.abs(sum - whole) > AREA_EPSILON) {
    details.push(`pieces cover ${sum.toFixed(9)} m², outline is ${whole.toFixed(9)} m²`);
  }

  // The cut as the solvers see it: the pieces mounted as one body's shapes, and
  // every outline vertex asked whether the rope may bend around it. A convex
  // corner of the outline must survive being cut up, and a reflex one must stay
  // unwrappable however the cut ran through it.
  const shapes: ShapeTransform[] = pieces.map((p) => ({
    globalPosition: Vec2.ZERO,
    globalRotation: 0,
    shape: polyShape(p),
  }));
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i + loop.length - 1) % loop.length]!;
    const b = loop[i]!;
    const cc = loop[(i + 1) % loop.length]!;
    const convex = b.sub(a).cross(cc.sub(b)) > 0;
    const exposed = isExposedCorner(b, shapes);
    if (exposed !== convex) {
      details.push(
        `vertex ${i} (${b.x.toFixed(2)}, ${b.y.toFixed(2)}) is ${convex ? "a corner" : "reflex"} but reads exposed=${exposed}`,
      );
    }
  }

  return { name: c.name, passed: details.length === 0, details };
}

function centroid(verts: readonly Vec2[]): Vec2 {
  let s = Vec2.ZERO;
  for (const v of verts) s = s.add(v);
  return s.div(verts.length);
}

// The cut must be the same cut every time it is asked for: it happens at load,
// so a decomposition that depended on iteration order or on a hash would have
// two machines simulating different geometry from the same file.
export function checkDecomposeDeterminism(): DecomposeResult {
  const details: string[] = [];
  for (const c of DECOMPOSE_CASES) {
    const first = decomposeConvex(c.verts);
    for (let run = 0; run < 3; run++) {
      const again = decomposeConvex(c.verts);
      if (digest(again) !== digest(first)) details.push(`${c.name} cut differently on run ${run + 2}`);
    }
  }
  return { name: "the cut is deterministic", passed: details.length === 0, details };
}

function digest(pieces: readonly (readonly Vec2[])[]): string {
  return pieces
    .map((p) => p.map((v) => `${v.x.toFixed(9)},${v.y.toFixed(9)}`).join(" "))
    .join(" | ");
}
