// Corner cases: hand-built arrangements with the answer written down, run by
// `cli corners`. Two questions about a corner, both pure geometry with no
// state, so both are checked directly rather than through a level, where a
// wrong answer only shows up as a rope in a wall several hundred frames later
// (`session-410f`) or a ball that will not wind up (`session-473f`).
//
// `isExposedCorner` decides whether the rope may bend around a compound body's
// vertex and whether the player may hang from it (`CORNER_CASES`).
// `cullDetachedNodes` decides when a wrap the rope has bent around lets go,
// and `DETACH_CASES` are the corner two bodies share, which arrives on the
// path as two coincident nodes and has to release as one.

import { Vec2 } from "../engine/vec2";
import { StaticBody2D, type CollisionObject2D } from "../engine/body";
import { circleShape, isExposedCorner, rectShape, type ShapeTransform } from "../engine/shapes";
import { cullDetachedNodes } from "../lib/nodeDetachment";
import { RopeAttachment, RopeContact, RopeWrap } from "../lib/ropeContact";
import { WrapDirection } from "../lib/types";

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

// A wrap on the path, in world metres: which of the case's three bodies it is
// on (`A` the lower rock, `B` the upper rock, `P` the ball) and its hand.
interface DetachWrap {
  at: [number, number];
  body: "A" | "B" | "P";
  dir: WrapDirection;
}

export interface DetachCase {
  name: string;
  // The rope's start (on the ball) and end (the anchor), world metres.
  start: [number, number];
  end: [number, number];
  wraps: DetachWrap[];
  // Which of `wraps` must survive the cull, by index.
  keep: number[];
}

const CW = WrapDirection.Clockwise;
const CCW = WrapDirection.CounterClockwise;

// `session-473f`'s corner, in metres: two rocks in `levels/ball.json` (bodies
// 162 and 165) share the vertex C at (27.5, 6.1) - the lower rock's top-right,
// the upper rock's bottom-right - with the upper rock's right face running
// straight up from it to (27.5, 5.7) and its top to (27.3, 5.4) and (26.8,
// 5.4). The ball's hook was on the lower rock's far side at (26.557, 5.886),
// its chain draped over both rocks, and the ball hung under C on the tail.
const C: [number, number] = [27.5, 6.1];
const ANCHOR: [number, number] = [26.557, 5.886];
// The pair at C, one node per rock, both counter-clockwise like every wrap on
// the block, then the block's three corners on to the anchor.
const PAIR: DetachWrap[] = [
  { at: C, body: "A", dir: CCW },
  { at: C, body: "B", dir: CCW },
];
const BLOCK: DetachWrap[] = [
  { at: [27.5, 5.7], body: "B", dir: CCW },
  { at: [27.3, 5.4], body: "B", dir: CCW },
  { at: [26.8, 5.4], body: "B", dir: CCW },
];
// The same corner mirrored about the face's line x = 27.5: the ball on the
// other side, every hand the other way round.
const mirror = (w: DetachWrap): DetachWrap => ({
  at: [55 - w.at[0], w.at[1]],
  body: w.body,
  dir: -w.dir as WrapDirection,
});

export const DETACH_CASES: DetachCase[] = [
  {
    // f384: the ball wound up to C and rounded it, now beside the face with
    // its loop 1.9 cm right of the face's line and 4 cm above C - the chain
    // runs from the loop DOWN to C and straight back up the face. Nothing is
    // inside that bend; the corner is 1.7 cm off the chord on the wrong side
    // and has to go. It held for the rest of the recording.
    name: "shared corner: a hairpin under the ball beside the face releases",
    start: [27.519, 6.14],
    end: ANCHOR,
    wraps: [...PAIR, ...BLOCK],
    keep: [2, 3, 4],
  },
  {
    // f396: the wedge the recording ended in. The ball 10 cm above C pressed
    // to the face, the span up the face caught on its own rim (two clockwise
    // wraps on the ball), the hairpin at C still holding the whole thing
    // together. Only the corner goes; the rim wraps are the coil's business.
    name: "shared corner: the hairpin releases under a chain wrapped round the ball's rim",
    start: [27.544, 6.069],
    end: ANCHOR,
    wraps: [
      ...PAIR,
      { at: [27.509, 6.023], body: "P", dir: CW },
      { at: [27.511, 5.925], body: "P", dir: CW },
      ...BLOCK,
    ],
    keep: [2, 3, 4, 5, 6],
  },
  {
    // The ball hanging under C, out on the lower rock's slope: the chain
    // comes up to C from below-left and turns onto the face. That is a corner
    // doing its job, and both nodes stay.
    name: "shared corner: genuinely wrapped from below, both nodes stay",
    start: [27.4, 6.25],
    end: ANCHOR,
    wraps: [...PAIR, ...BLOCK],
    keep: [0, 1, 2, 3, 4],
  },
  {
    // Half a pixel is the band: a corner 2.5 mm the wrong way is still a wrap
    // (`MIN_WRAP_DEFLECTION`), for a pair exactly as for one node.
    name: "shared corner: inside the release band, both nodes stay",
    start: [27.5027, 6.14],
    end: ANCHOR,
    wraps: [...PAIR, ...BLOCK],
    keep: [0, 1, 2, 3, 4],
  },
  {
    // The corner's own body alone, same hairpin: this is the answer a pair
    // must give, and it always did.
    name: "one body's corner: the same hairpin releases",
    start: [27.519, 6.14],
    end: ANCHOR,
    wraps: [PAIR[0]!, ...BLOCK],
    keep: [1, 2, 3],
  },
  {
    // `session-485f` f440: the same hairpin at a corner authored 4.5 mm apart,
    // a rock's bottom-right on the ground's top, the whole chain wound onto
    // the ball pressed against the rock's face above. Judged against the
    // neighbour 4.5 mm away the ground's node was 4.4 mm off the chord, inside
    // the band, and the rock's node bent the right way from it; judged as one
    // corner, both are 12 cm off the chord the exit and the face's top draw.
    name: "shared corner 4.5 mm apart: the hairpin releases",
    start: [19.971, 2.256],
    end: [19.236, 1.866],
    wraps: [
      { at: [19.911, 2.338], body: "P", dir: CW },
      { at: [19.8, 2.4], body: "B", dir: CCW },
      { at: [19.8, 2.3955], body: "A", dir: CCW },
      { at: [19.6, 1.9955], body: "A", dir: CCW },
    ],
    keep: [0, 3],
  },
  {
    // Mirrored, so the pair is clockwise. A coincident target used to record
    // an obstruction with no side, which read clockwise, so releasing a
    // clockwise pair routed the path back through the node just released
    // until the depth cap gave up on it.
    name: "shared corner, clockwise: the hairpin releases without rerouting",
    start: [55 - 27.519, 6.14],
    end: [55 - ANCHOR[0], ANCHOR[1]],
    wraps: [...PAIR, ...BLOCK].map(mirror),
    keep: [2, 3, 4],
  },
];

export interface CornerResult {
  name: string;
  ok: boolean;
  // What went wrong, for a failing case.
  detail: string;
}

function runDetachCase(c: DetachCase): CornerResult {
  const bodies: Record<DetachWrap["body"], CollisionObject2D> = {
    A: new StaticBody2D(),
    B: new StaticBody2D(),
    P: new StaticBody2D(),
  };
  for (const b of Object.values(bodies)) b.setShape(rectShape(0.1, 0.1));
  // Every body sits at the origin unrotated, so a contact's local position is
  // its world position: the cull reads nothing but positions and hands.
  const contact = (at: [number, number], body: DetachWrap["body"]): RopeContact =>
    new RopeContact(bodies[body], new Vec2(at[0], at[1]));
  const wraps = c.wraps.map((w) => new RopeWrap(contact(w.at, w.body), w.dir));
  const start = new RopeAttachment(contact(c.start, "P"));
  const end = new RopeAttachment(contact(c.end, "A"));
  const kept = cullDetachedNodes(start, end, wraps).map((w) => wraps.indexOf(w));
  const ok = kept.length === c.keep.length && kept.every((k, i) => k === c.keep[i]);
  return { name: c.name, ok, detail: `kept [${kept.join(",")}], want [${c.keep.join(",")}]` };
}

export function runCornerCases(): CornerResult[] {
  return [
    ...CORNER_CASES.map((c) => {
      const got = isExposedCorner(c.vertex, c.shapes);
      return { name: c.name, ok: got === c.exposed, detail: `exposed=${got}, want ${c.exposed}` };
    }),
    ...DETACH_CASES.map(runDetachCase),
  ];
}
