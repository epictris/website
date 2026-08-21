// Tangent-vertex cases: which corner of a convex piece a rope leaving a point
// bends around, run by `cli tangents`.
//
// `RopeGeneration.calculateTangentVertexIndex` is pure geometry with no state,
// and it decides where a wrap node is BORN - so a wrong answer here is a rope
// bent round the wrong corner for the rest of the run, and a missing answer used
// to be a thrown exception that killed the frame loop mid-step
// (`session-6942f`). Both are checked directly rather than through a level,
// where the `entry && exit` branch that reaches it comes up a handful of times
// in seven thousand frames.
//
// The generated sweep at the bottom is the one that covers the class: the
// answer's defining property is checkable without knowing the answer, so every
// convex loop and every approach angle can be asserted rather than the handful
// somebody thought to write down.

import { Vec2 } from "../engine/vec2";
import { polyShape, rectShape, type ShapeTransform } from "../engine/shapes";
import { RopeGeneration } from "../lib/ropeGeneration";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { WrapDirection } from "../lib/types";

const at = (x: number, y: number, shape: ShapeTransform["shape"]): ShapeTransform => ({
  globalPosition: new Vec2(x, y),
  globalRotation: 0,
  shape,
});

// A convex piece authored by its world corners, the way a decomposed outline
// arrives: `polyShape` takes the loop about its own centroid, so the transform
// carries that centroid and the local loop is what is left.
function piece(corners: [number, number][]): ShapeTransform {
  const verts = corners.map(([x, y]) => new Vec2(x, y));
  let centroid = new Vec2(0, 0);
  for (const v of verts) centroid = centroid.add(v);
  centroid = centroid.mul(1 / verts.length);
  return at(centroid.x, centroid.y, polyShape(verts.map((v) => v.sub(centroid))));
}

export interface TangentCase {
  name: string;
  shape: ShapeTransform;
  point: Vec2;
  wrapDir: WrapDirection;
  // The world corner the rope must bend around, or null for "no tangent".
  want: [number, number] | null;
}

// The quad from `levels/ball.json` (body#3, second piece) that `session-6942f`
// died on, with the span start the recording ended a step short of. Every corner
// of it is visible from there - the far side of the piece is the single edge
// from (3.4,6.1) to (4.3,7.8) - which is exactly what the walk this replaces
// could not answer.
const BALL_LEVEL_QUAD = piece([
  [3.4, 6.1],
  [4.6, 6.1],
  [4.8, 7],
  [4.3, 7.8],
]);
const SESSION_6942F_START = new Vec2(5.6076, 5.7553);

// A plain rectangle, which is all the ported C# walk was ever given: the far
// diagonal corner is hidden from anywhere outside, so both tangents are the ends
// of the visible run and the two routines agree by construction. Pinned so the
// replacement cannot quietly change what every recorded replay already did.
const UNIT_RECT = at(0, 0, rectShape(2, 2));

export const TANGENT_CASES: TangentCase[] = [
  {
    name: "session-6942f: every corner of the quad visible, clockwise",
    shape: BALL_LEVEL_QUAD,
    point: SESSION_6942F_START,
    wrapDir: WrapDirection.Clockwise,
    want: [4.3, 7.8],
  },
  {
    name: "session-6942f: every corner of the quad visible, counter-clockwise",
    shape: BALL_LEVEL_QUAD,
    point: SESSION_6942F_START,
    wrapDir: WrapDirection.CounterClockwise,
    want: [3.4, 6.1],
  },
  {
    name: "triangle seen from beyond one of its own vertices",
    shape: piece([
      [0, 0],
      [1, 0],
      [0, 1],
    ]),
    point: new Vec2(-1, -1),
    wrapDir: WrapDirection.Clockwise,
    want: [1, 0],
  },
  {
    name: "the same triangle, wrapping the other way",
    shape: piece([
      [0, 0],
      [1, 0],
      [0, 1],
    ]),
    point: new Vec2(-1, -1),
    wrapDir: WrapDirection.CounterClockwise,
    want: [0, 1],
  },
  {
    name: "rect from a corner region, clockwise",
    shape: UNIT_RECT,
    point: new Vec2(-2, -2),
    wrapDir: WrapDirection.Clockwise,
    want: [1, -1],
  },
  {
    name: "rect from a corner region, counter-clockwise",
    shape: UNIT_RECT,
    point: new Vec2(-2, -2),
    wrapDir: WrapDirection.CounterClockwise,
    want: [-1, 1],
  },
  {
    name: "rect from square on to a face, clockwise",
    shape: UNIT_RECT,
    point: new Vec2(0, -4),
    wrapDir: WrapDirection.Clockwise,
    want: [1, -1],
  },
  {
    name: "rect from square on to a face, counter-clockwise",
    shape: UNIT_RECT,
    point: new Vec2(0, -4),
    wrapDir: WrapDirection.CounterClockwise,
    want: [-1, -1],
  },
  {
    // Collinear with a face: the rope runs along it and bends at the far end,
    // not at the corner it grazes on the way past.
    name: "rect along the line of a face bends at the far corner",
    shape: UNIT_RECT,
    point: new Vec2(-4, -1),
    wrapDir: WrapDirection.Clockwise,
    want: [1, -1],
  },
  {
    name: "no tangent from inside the loop",
    shape: UNIT_RECT,
    point: Vec2.ZERO,
    wrapDir: WrapDirection.Clockwise,
    want: null,
  },
  {
    // A point sitting exactly ON a vertex has no line to that vertex to measure,
    // and the rope leaving it bends around the neighbour instead.
    name: "a point on a vertex of the loop bends at its neighbour",
    shape: piece([
      [0, 0],
      [1, 0],
      [0, 1],
    ]),
    point: new Vec2(0, 0),
    wrapDir: WrapDirection.Clockwise,
    want: [1, 0],
  },
];

export interface TangentResult {
  name: string;
  ok: boolean;
  detail: string;
}

export function runTangentCases(): TangentResult[] {
  const out: TangentResult[] = TANGENT_CASES.map((c) => {
    const index = RopeGeneration.calculateTangentVertexIndex(c.shape, c.wrapDir, c.point);
    if (c.want === null) {
      return {
        name: c.name,
        ok: index === null,
        detail: index === null ? "null" : `got vertex ${index}`,
      };
    }
    if (index === null) return { name: c.name, ok: false, detail: "got null" };
    const got = ShapeGeometry.getGlobalCorners(c.shape)[index]!;
    const want = new Vec2(c.want[0], c.want[1]);
    const ok = got.distanceTo(want) < 1e-9;
    return {
      name: c.name,
      ok,
      detail: `got (${got.x.toFixed(4)}, ${got.y.toFixed(4)}), want (${want.x}, ${want.y})`,
    };
  });
  out.push(sweepSupportingVertex());
  return out;
}

// The property, over generated convex loops: whatever vertex comes back, no
// other vertex of the loop may lie on the far side of the ray from the point
// through it - that IS what a tangent vertex is. Asserting the property rather
// than an answer is what makes this cover loops nobody wrote down, which is
// where the walk this replaces failed: a triangle or a quad approached from
// beyond one of its own vertices.
//
// Deterministic: a fixed seed, so a failure names a case that can be replayed.
function sweepSupportingVertex(): TangentResult {
  let seed = 20260821;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let checked = 0;
  for (let trial = 0; trial < 20000; trial++) {
    const n = 3 + Math.floor(rnd() * 10);
    const angles: number[] = [];
    for (let i = 0; i < n; i++) angles.push(rnd() * Math.PI * 2);
    angles.sort((a, b) => a - b);
    const rx = 0.3 + rnd() * 3;
    const ry = 0.3 + rnd() * 3;
    const verts = angles.map((a) => new Vec2(Math.cos(a) * rx, Math.sin(a) * ry));
    // Vertices closer together than a millimetre are not a loop the editor can
    // author (`setPolyVerts` stalls the drag), and `polyShape` rejects them.
    let degenerate = false;
    for (let i = 0; i < n; i++) {
      if (verts[i]!.distanceTo(verts[(i + 1) % n]!) < 1e-3) degenerate = true;
    }
    if (degenerate) continue;

    let centroid = new Vec2(0, 0);
    for (const v of verts) centroid = centroid.add(v);
    centroid = centroid.mul(1 / n);
    let shape: ShapeTransform;
    try {
      shape = at(centroid.x, centroid.y, polyShape(verts.map((v) => v.sub(centroid))));
    } catch {
      continue; // not a convex loop after the winding normalisation
    }

    const bearing = rnd() * Math.PI * 2;
    const point = new Vec2(Math.cos(bearing), Math.sin(bearing)).mul(4 + rnd() * 16);
    const world = ShapeGeometry.getGlobalCorners(shape);
    for (const wrapDir of [WrapDirection.Clockwise, WrapDirection.CounterClockwise]) {
      const index = RopeGeneration.calculateTangentVertexIndex(shape, wrapDir, point);
      if (index === null) {
        return {
          name: "sweep: every convex loop has a tangent vertex from outside it",
          ok: false,
          detail: `trial ${trial} wrapDir ${wrapDir}: got null for a point outside the loop`,
        };
      }
      const toBest = world[index]!.sub(point);
      for (let i = 0; i < world.length; i++) {
        if (i === index) continue;
        if (toBest.cross(world[i]!.sub(point)) * (wrapDir as number) < -1e-12) {
          return {
            name: "sweep: the answer is a supporting vertex of the loop",
            ok: false,
            detail: `trial ${trial} wrapDir ${wrapDir}: vertex ${i} lies past the ray through vertex ${index}`,
          };
        }
      }
      checked++;
    }
  }
  return {
    name: "sweep: supporting vertex over generated convex loops",
    ok: true,
    detail: `${checked} loop/direction pairs`,
  };
}
