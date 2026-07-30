// Corner-exposure cases: hand-built arrangements of convex pieces with the
// answer written down, run by `cli corners`.
//
// `isExposedCorner` decides whether the rope may bend around a compound body's
// vertex and whether the player may hang from it, and it is pure geometry with
// no state - so it is checked directly rather than through a level, where a
// wrong answer only shows up as a rope in a wall several hundred frames later
// (`session-410f`).

import { Vec2 } from "../engine/vec2";
import { circleShape, isExposedCorner, rectShape, type ShapeTransform } from "../engine/shapes";

const rect = (x: number, y: number, w: number, h: number, rot = 0): ShapeTransform => ({
  globalPosition: new Vec2(x, y),
  globalRotation: rot,
  shape: rectShape(w, h),
});
const circle = (x: number, y: number, r: number): ShapeTransform => ({
  globalPosition: new Vec2(x, y),
  globalRotation: 0,
  shape: circleShape(r),
});

// The compound wall from `session-410f`, in metres: a horizontal bar spanning
// x[-8,-4] y[2.7,3.3] and a vertical post spanning x[-4.6,-4] y[0.3,3.3]. Both
// pieces have a corner at (-4, 3.3), which is the outer corner of the L.
const BAR = rect(-6, 3, 4, 0.6);
const POST = rect(-4.3, 1.8, 0.6, 3);
const L = [BAR, POST];

export interface CornerCase {
  name: string;
  vertex: Vec2;
  shapes: ShapeTransform[];
  exposed: boolean;
}

export const CORNER_CASES: CornerCase[] = [
  // The reported bug: a corner both pieces own is still the body's corner.
  { name: "L outer corner, owned by both pieces", vertex: new Vec2(-4, 3.3), shapes: L, exposed: true },
  // ... and the two points where the pieces meet along a straight run are not.
  { name: "L flat point on the right face", vertex: new Vec2(-4, 2.7), shapes: L, exposed: false },
  { name: "L flat point on the bottom face", vertex: new Vec2(-4.6, 3.3), shapes: L, exposed: false },
  { name: "L far corner of the bar", vertex: new Vec2(-8, 3.3), shapes: L, exposed: true },
  { name: "L top corner of the post", vertex: new Vec2(-4, 0.3), shapes: L, exposed: true },
  { name: "lone rect corner", vertex: new Vec2(1, 1), shapes: [rect(0, 0, 2, 2)], exposed: true },
  {
    name: "corner buried inside a sibling",
    vertex: new Vec2(1, 1),
    shapes: [rect(0, 0, 2, 2), rect(1, 1, 4, 4)],
    exposed: false,
  },
  {
    name: "two pieces meeting apex to apex into a straight edge",
    vertex: Vec2.ZERO,
    shapes: [rect(-1, -1, 2, 2), rect(1, -1, 2, 2)],
    exposed: false,
  },
  {
    // A pinch: the body is zero-width at the vertex, so its two 90 degree
    // outsides sit on opposite sides of a point the rope cannot pass through.
    // Nothing can bend around it, and authored geometry does not contain it.
    name: "two pieces touching only at a diagonal corner (pinch)",
    vertex: Vec2.ZERO,
    shapes: [rect(-1, -1, 2, 2), rect(1, 1, 2, 2)],
    exposed: false,
  },
  {
    // Tangent from outside the corner's own wedge: the disc fills the outside
    // in past a half turn, leaving a reflex junction the rope cannot wrap.
    name: "corner tangent to a circle that fills its outside",
    vertex: Vec2.ZERO,
    shapes: [rect(1, 1, 2, 2), circle(0, -1, 1)],
    exposed: false,
  },
  {
    // The same corner with the disc tucked along one face instead: three
    // quarters of a turn minus the disc still leaves an outside.
    name: "corner with a circle resting against one face",
    vertex: Vec2.ZERO,
    shapes: [rect(1, 1, 2, 2), circle(1, -1, 1)],
    exposed: true,
  },
  { name: "corner swallowed by a circle", vertex: Vec2.ZERO, shapes: [rect(1, 1, 2, 2), circle(0.2, 0.2, 1)], exposed: false },
  {
    // Rotation must not change the answer: the L again, turned 30 degrees about
    // the origin, corner and all.
    name: "rotated L outer corner",
    vertex: new Vec2(-4, 3.3).rotated(0.5235987755982988),
    shapes: L.map((s) => ({
      globalPosition: s.globalPosition.rotated(0.5235987755982988),
      globalRotation: s.globalRotation + 0.5235987755982988,
      shape: s.shape,
    })),
    exposed: true,
  },
];

export interface CornerResult {
  name: string;
  ok: boolean;
  got: boolean;
  want: boolean;
}

export function runCornerCases(): CornerResult[] {
  return CORNER_CASES.map((c) => {
    const got = isExposedCorner(c.vertex, c.shapes);
    return { name: c.name, ok: got === c.exposed, got, want: c.exposed };
  });
}
