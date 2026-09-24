// Conveyor belt cases, run by `cli belts`.
//
// A belt is a band `thickness` deep wrapped round the outside of two or more
// wheels - the convex hull of the discs of radius `r + thickness` - whose
// SURFACE runs round the loop while its geometry stays still (`lib/belt.ts`,
// docs/conveyors.md). It is a static body with a surface velocity, not a mover,
// so it reaches no digest of its own and no invariant: a build that quietly
// stopped reading `speed` would render a level that looks identical, plays
// differently and violates nothing. This suite is the whole of its coverage.
//
// The geometry is arithmetic and is asserted as such - the stadium's
// perimeter, the unequal loop against a numerical integration, the three-wheel
// hull (every disc inside every run, the tangent points on the discs, every
// wheel touched, the perimeter), the segment boundaries, a continuous tangent
// across every seam, the projection round trip and the projection against a
// brute-force search - together with the one convention an author has to learn
// (`sense`) and what is not a belt (`degenerate`, `hull-refuses`).
//
// The claims that are NOT arithmetic are the ones that make a belt a belt:
//
//   - it is HOLLOW: a disc per wheel and a quad per run, nothing between the
//     wheels (`hollow`);
//   - at speed 0 it is exactly the static pieces it is built from, down to the
//     digest (`static-equivalent`), which is the no-regression proof;
//   - it CARRIES what rests on it through the ordinary contact path, a crate
//     at belt speed and never pinned (`crate-carried`, `reverse`, `no-pin`), a
//     free ball until it rides (`ball-rolls`) and the grapple avatar, who can
//     walk against it at its own speed and stand still without the stuck
//     detector calling that a freeze (`avatar-carried`), and on a three-wheel
//     belt as on two (`carried-3`);
//   - a running belt wakes what sleeps on it (`wakes`), nothing disturbs it
//     (`undisturbable`), and the energy monitor reads the carry as the source
//     it is rather than as the solver inventing energy (`energy-armed`).
//
//   - a hook that bites a running belt RIDES it (`RopeRide`): where it stands
//     is a pure function of the frame, so a replay lands it to the bit
//     (`ride-pure`); a ball hanging from it is carried at belt speed
//     (`ride-carried`, the grapple's hook too); it goes round a wheel with
//     the chain bent round the wheel and the cuff turning with the surface
//     (`ride-round-roller`, and `ride-3` round the large wheel of a
//     three-wheel belt and on along two runs); the continuous sweep sees the
//     carry as the end's
//     motion and catches a post it carries the chain across
//     (`ride-wrap-sweep`); winding in while carried is not read as a block
//     (`ride-winch`); letting go takes the cuff off the belt
//     (`ride-detach`); and a carry the chain cannot follow tears the cuff
//     out rather than leasing chain without bound (`ride-tear`).
//
// `authored` holds the format's side of the round trip (px -> m -> px, the
// build, the refusals). The EDITOR's side - `modelFromDisk` then `modelToDisk`
// keeping every field of a belt and its matched twin - lives with the rest of
// the belt's rendering cases in `sim/render3dCases.ts` (`belt:`, `cli
// render3d`), because it goes through the same collided-and-drawn body those
// cases build; it is not repeated here.

import { Vec2 } from "../engine/vec2";
import { RigidBody2D, StaticBody2D, type CollisionShape2D } from "../engine/body";
import type { BeltLoop } from "../engine/shapes";
import { World } from "../engine/world";
import { PX, PIXELS_PER_METER } from "../engine/units";
import { buildLevelBodies } from "../level/buildBodies";
import { BallLevel } from "../level/ballLevel";
import { Level } from "../level/level";
import {
  scaleLevelData,
  type CollisionObjectData,
  type LevelBodyData,
  type LevelData,
  type RawLevelData,
  type ShapeData,
} from "../level/levelFormat";
import {
  beltClosestS,
  beltNormalAt,
  beltOutline,
  beltPieceAt,
  beltPointAt,
  beltRunQuads,
  beltSegmentAt,
  beltTangentAt,
  buildBeltLoop,
  ConveyorBody,
  RopeRide,
} from "../lib/belt";
import { bodyContainsPoint } from "../engine/collision";
import { MANACLE_HINGE } from "../lib/manacle";
import { shapeContacts } from "../engine/manifold";
import { BallPlayer } from "../classes/ballPlayer";
import { button, emptyFrameInput, type ButtonInput, type FrameInput } from "../input/frameInput";
import {
  checkBallInvariants,
  EnergyMonitor,
  StuckDetector,
  TunnelMonitor,
  worldDigestBall,
  worldDigestsEqual,
  type Violation,
} from "./trace";

export interface BeltResult {
  name: string;
  passed: boolean;
  details: string[];
}

const DT = 1 / 60;

class Checks {
  passed = true;
  readonly details: string[] = [];
  check(claim: string, got: boolean): void {
    if (!got) this.passed = false;
    this.details.push(`${got ? "ok  " : "BAD "} ${claim}`);
  }
  done(name: string): BeltResult {
    return { name, passed: this.passed, details: this.details };
  }
}

// A deterministic stream of numbers in [0, 1), so a failure reproduces.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// A loop from `[x, y, r]` wheels (metres) and a band thickness.
function loopOf(wheels: readonly (readonly [number, number, number])[], thickness: number): BeltLoop {
  return buildBeltLoop(
    wheels.map(([x, y, r]) => ({ c: new Vec2(x, y), r })),
    thickness,
  );
}

// The unequal, tilted loop the geometry cases are measured on: a 0.3 m first
// surface radius and a 0.12 m second (wheels of 0.26 and 0.08 under a 4 cm
// band), 3.2 m apart on a slope, with wheel 0 off the origin so nothing leans
// on it being there.
function skewLoop(): BeltLoop {
  return loopOf(
    [
      [0.4, -0.25, 0.26],
      [3.4, 0.85, 0.08],
    ],
    0.04,
  );
}

// The belt DRIVE the addendum draws: a small wheel top-left, a large one
// right, a medium one bottom-left, under a 5 cm band - with the top run level,
// so a crate can ride it (the two tops are both 0.2 m above wheel 0's centre).
// Metres; `scale` stretches the centres, not the wheels.
const DRIVE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0.15],
  [1.6, 0.3, 0.45],
  [0.3, 1.3, 0.3],
];
const DRIVE_THICKNESS = 0.05;
function driveLoop(): BeltLoop {
  return loopOf(DRIVE, DRIVE_THICKNESS);
}

// Where segment `i` of a loop starts and ends, from its own record.
function segmentEnds(loop: BeltLoop, i: number): { start: Vec2; end: Vec2 } {
  const seg = loop.segments[i]!;
  if (seg.kind === "run") return { start: seg.from, end: seg.to };
  const at = (t: number): Vec2 => seg.centre.add(new Vec2(Math.cos(t), Math.sin(t)).mul(seg.radius));
  return { start: at(seg.theta), end: at(seg.theta + seg.sweep) };
}

// The loop's length by brute force: a fine polyline through `beltPointAt`,
// which converges on the true length from below as 1/N².
function integratedPerimeter(loop: BeltLoop, n = 200000): number {
  let integral = 0;
  let prev = beltPointAt(loop, 0);
  for (let i = 1; i <= n; i++) {
    const p = beltPointAt(loop, (loop.total * i) / n);
    integral += p.distanceTo(prev);
    prev = p;
  }
  return integral;
}

// The worst tangent jump across every seam of a loop, including the wrap.
function worstSeamJump(loop: BeltLoop): number {
  const eps = 1e-11;
  let worst = 0;
  for (let i = 0; i <= loop.segments.length; i++) {
    const s = loop.cum[i]!;
    worst = Math.max(worst, beltTangentAt(loop, s - eps).distanceTo(beltTangentAt(loop, s + eps)));
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Geometry (lib/belt.ts)
// ---------------------------------------------------------------------------

function caseStadium(): BeltResult {
  const c = new Checks();
  const r = 0.2;
  const t = 0.05;
  const d = 4;
  const loop = loopOf(
    [
      [0, 0, r],
      [d, 0, r],
    ],
    t,
  );
  const want = 2 * Math.PI * (r + t) + 2 * d;
  c.check(
    `perimeter is 2·pi·(r + thickness) + 2·d (${loop.total.toFixed(12)} of ${want.toFixed(12)})`,
    Math.abs(loop.total - want) < 1e-12,
  );
  const arcs = loop.segments.filter((s) => s.kind === "arc");
  c.check(
    `two arcs and two runs, each wheel wrapping half a turn at r + thickness (${arcs.map((a) => (a.kind === "arc" ? `${a.sweep.toFixed(12)} at ${a.radius}` : "")).join(", ")})`,
    loop.segments.length === 4 &&
      arcs.length === 2 &&
      arcs.every((a) => a.kind === "arc" && Math.abs(a.sweep - Math.PI) < 1e-12 && Math.abs(a.radius - (r + t)) < 1e-15),
  );
  c.check(
    `the runs are the centre distance long (${(loop.cum[2]! - loop.cum[1]!).toFixed(12)})`,
    Math.abs(loop.cum[2]! - loop.cum[1]! - d) < 1e-12 && Math.abs(loop.cum[4]! - loop.cum[3]! - d) < 1e-12,
  );
  return c.done("stadium - equal wheels: the perimeter is 2·pi·(r + thickness) + 2·d");
}

function caseUnequal(): BeltResult {
  const c = new Checks();
  const loop = skewLoop();
  const integral = integratedPerimeter(loop);
  c.check(
    `perimeter matches a 200000-step integration (${loop.total.toFixed(9)} vs ${integral.toFixed(9)})`,
    Math.abs(loop.total - integral) < 1e-7,
  );
  const [a0, , a1] = loop.segments;
  c.check(
    `the larger wheel wraps more than half a turn (${a0?.kind === "arc" ? a0.sweep.toFixed(4) : "-"} rad) and the two sweeps make one turn`,
    a0?.kind === "arc" && a1?.kind === "arc" && a0.sweep > Math.PI && Math.abs(a0.sweep + a1.sweep - 2 * Math.PI) < 1e-12,
  );
  let worst = 0;
  loop.segments.forEach((seg, i) => {
    if (seg.kind !== "run") return;
    const before = loop.segments[i - 1]!;
    const after = loop.segments[(i + 1) % loop.segments.length]!;
    if (before.kind !== "arc" || after.kind !== "arc") return;
    worst = Math.max(
      worst,
      Math.abs(seg.from.sub(before.centre).dot(seg.dir)),
      Math.abs(seg.to.sub(after.centre).dot(seg.dir)),
    );
  });
  c.check(
    `each run is tangent to both discs (radius square to the run at all four points, worst ${worst.toExponential(2)})`,
    worst < 1e-12,
  );
  return c.done("unequal - unequal wheels: the perimeter against a numerical integration");
}

function caseSeams(): BeltResult {
  const c = new Checks();
  for (const [label, loop] of [
    [
      "stadium",
      loopOf(
        [
          [0, 0, 0.2],
          [4, 0, 0.2],
        ],
        0.05,
      ),
    ],
    ["skew", skewLoop()],
    ["drive", driveLoop()],
  ] as const) {
    let worstPoint = 0;
    const n = loop.segments.length;
    for (let i = 0; i < n; i++) {
      const { start } = segmentEnds(loop, i);
      // Where `s` says the segment starts, and where the one before it ends.
      worstPoint = Math.max(
        worstPoint,
        beltPointAt(loop, loop.cum[i]!).distanceTo(start),
        segmentEnds(loop, (i + n - 1) % n).end.distanceTo(start),
      );
    }
    // ...and the far end of the last segment, the perimeter itself, is the
    // start again.
    worstPoint = Math.max(worstPoint, beltPointAt(loop, loop.total).distanceTo(segmentEnds(loop, 0).start));
    c.check(
      `${label}: every segment boundary is where both segments meeting at it say (worst ${worstPoint.toExponential(2)} m)`,
      worstPoint < 1e-9,
    );
    const jump = worstSeamJump(loop);
    c.check(
      `${label}: the tangent is continuous across all ${n} seams (worst jump ${jump.toExponential(2)})`,
      jump < 1e-9,
    );
  }
  return c.done("seams - the segments meet at their tangent points and the loop is smooth across them");
}

// The three-wheel drive: a taut band round pins. Every disc lies on the inner
// side of every run (the hull), each tangent point is on its disc's outer
// circle, the loop touches every wheel, and the perimeter and seams are what a
// numerical walk of the loop says.
function caseHull3(): BeltResult {
  const c = new Checks();
  const loop = driveLoop();
  const R = DRIVE.map(([, , r]) => r + DRIVE_THICKNESS);
  const centres = DRIVE.map(([x, y]) => new Vec2(x, y));
  let worstInside = -Infinity;
  let worstOnDisc = 0;
  loop.segments.forEach((seg, i) => {
    if (seg.kind !== "run") return;
    const h = seg.normal.dot(seg.from);
    for (let m = 0; m < centres.length; m++) {
      worstInside = Math.max(worstInside, seg.normal.dot(centres[m]!) + R[m]! - h);
    }
    const before = loop.segments[i - 1]!;
    const after = loop.segments[(i + 1) % loop.segments.length]!;
    if (before.kind === "arc" && after.kind === "arc") {
      worstOnDisc = Math.max(
        worstOnDisc,
        Math.abs(seg.from.distanceTo(centres[before.wheel]!) - R[before.wheel]!),
        Math.abs(seg.to.distanceTo(centres[after.wheel]!) - R[after.wheel]!),
      );
    }
  });
  c.check(
    `every disc lies on the inner side of every run (largest reach past a run ${worstInside.toExponential(2)} m, the touching ones at 0)`,
    worstInside < 1e-12,
  );
  c.check(`each tangent point is on its disc's outer circle (worst ${worstOnDisc.toExponential(2)} m)`, worstOnDisc < 1e-12);
  const touched = loop.segments.filter((s) => s.kind === "arc" && s.sweep > 0).map((s) => (s.kind === "arc" ? s.wheel : -1));
  c.check(
    `the loop touches every wheel, in the loop's sense 0 -> 1 -> 2 (${touched.join(" -> ")})`,
    touched.join() === "0,1,2" && loop.segments.length === 6,
  );
  let turned = 0;
  for (const s of loop.segments) if (s.kind === "arc") turned += s.sweep;
  c.check(`the sweeps make one turn (${turned.toFixed(12)} rad)`, Math.abs(turned - 2 * Math.PI) < 1e-12);
  const integral = integratedPerimeter(loop);
  c.check(
    `perimeter matches a 200000-step integration (${loop.total.toFixed(9)} vs ${integral.toFixed(9)})`,
    Math.abs(loop.total - integral) < 1e-7,
  );
  const jump = worstSeamJump(loop);
  c.check(`the tangent is continuous across all six seams (worst jump ${jump.toExponential(2)})`, jump < 1e-9);
  // The top run is level (the drive is drawn so) and runs toward the large
  // wheel at a positive speed: the sense convention on three wheels.
  const top = beltTangentAt(loop, beltClosestS(loop, new Vec2(0.8, -1)));
  c.check(`the top run carries toward the large wheel (${top})`, Math.abs(top.x - 1) < 1e-12 && Math.abs(top.y) < 1e-12);
  // Three equal wheels in a row: the middle one only touches the band, and is
  // on the loop with an arc of no sweep rather than refused as an idler.
  const row = loopOf(
    [
      [0, 0, 0.2],
      [1, 0, 0.2],
      [2, 0, 0.2],
    ],
    0.05,
  );
  // It touches both runs, so the band visits it once each way.
  const middle = row.segments.filter((s) => s.kind === "arc" && s.wheel === 1);
  c.check(
    `a wheel that exactly touches the band is on the loop, visited once each way with arcs of no sweep (${middle.length} arcs on it, perimeter ${row.total.toFixed(9)} of ${(2 * Math.PI * 0.25 + 4).toFixed(9)})`,
    middle.length === 2 &&
      middle.every((s) => s.kind === "arc" && s.sweep === 0) &&
      Math.abs(row.total - (2 * Math.PI * 0.25 + 4)) < 1e-12,
  );
  return c.done("hull-3 - three wheels: the loop is the convex hull of their discs, and touches every one");
}

// What is not a belt drive, refused by name: a wheel inside the loop the others
// make (an idler pressing the band inward), a disc inside another, a band of no
// thickness - from the geometry and from the build alike.
function caseHullRefuses(): BeltResult {
  const c = new Checks();
  const message = (f: () => unknown): string | null => {
    try {
      f();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const idler = message(() => loopOf([...DRIVE, [0.6, 0.55, 0.05]], DRIVE_THICKNESS));
  c.check(`a fourth wheel inside the triangle is refused, naming it (${idler})`, idler !== null && /wheel 3\b/.test(idler) && /inside the loop/.test(idler));
  const nested = message(() => loopOf([...DRIVE.slice(0, 2), [1.65, 0.35, 0.2]], DRIVE_THICKNESS));
  c.check(`a disc inside another is refused, naming both (${nested})`, nested !== null && /wheel 2\b/.test(nested) && /wheel 1\b/.test(nested));
  const flat = message(() => loopOf(DRIVE, 0));
  c.check(`a band of no thickness is refused (${flat})`, flat !== null && /thickness/.test(flat));
  const one = message(() => loopOf([DRIVE[0]!], DRIVE_THICKNESS));
  c.check(`one wheel is refused (${one})`, one !== null);
  // ...and by the build, with the same message, as a curve of one node is.
  const px = PIXELS_PER_METER;
  const built = message(() =>
    buildLevelBodies(
      new World(),
      scaleLevelData(
        {
          player: { x: 0, y: -500, radius: 8 },
          bodies: [
            {
              kind: "static",
              x: 0,
              y: 0,
              rot: 0,
              objects: [
                {
                  type: "collision",
                  shape: {
                    kind: "belt",
                    wheels: [...DRIVE, [0.6, 0.55, 0.05] as const].map(([x, y, r]) => ({ x: x * px, y: y * px, r: r * px })),
                    thickness: DRIVE_THICKNESS * px,
                    speed: 100,
                  },
                },
              ],
            },
          ],
        },
        PX,
      ),
      () => {},
    ),
  );
  c.check(`the build refuses the idler by name too (${built})`, built !== null && /wheel 3\b/.test(built));
  return c.done("hull-refuses - an idler inside the hull, a disc inside another and a band of no thickness are not belts");
}

function caseRoundTrip(): BeltResult {
  const c = new Checks();
  const loop = skewLoop();
  const rand = lcg(7);
  let worst = 0;
  let worstPiece = 0;
  for (let i = 0; i < 1000; i++) {
    const s = rand() * loop.total;
    const back = beltClosestS(loop, beltPointAt(loop, s));
    // Distance round the loop, so a point on the seam at 0 = P reads as close.
    const d = Math.abs(back - s);
    worst = Math.max(worst, Math.min(d, loop.total - d));
    worstPiece = Math.max(worstPiece, beltPieceAt(loop, s) === beltPieceAt(loop, back) ? 0 : 1);
  }
  c.check(`closestS(pointAt(s)) is s for 1000 values (worst ${worst.toExponential(2)} m)`, worst < 1e-9);
  const wrapped = beltPointAt(loop, 2 * loop.total + 0.3).distanceTo(beltPointAt(loop, 0.3));
  const negative = beltPointAt(loop, -loop.total + 0.3).distanceTo(beltPointAt(loop, 0.3));
  c.check(
    `s is reduced modulo the perimeter, both ways (${wrapped.toExponential(2)}, ${negative.toExponential(2)})`,
    wrapped < 1e-9 && negative < 1e-9,
  );
  c.check("the piece under a point round-trips with it", worstPiece === 0);
  return c.done("round-trip - projecting a point of the loop gives back its arc length");
}

function caseOffBelt(): BeltResult {
  const c = new Checks();
  const loop = skewLoop();
  // The brute force: the nearest point of a very finely flattened outline.
  // The flattening's chord error is step²/8r, 4e-8 m at 0.3 mm on the small
  // roller, so agreement to 1e-6 is agreement.
  const fine = beltOutline(loop, 3e-4);
  const nearestOnPolyline = (p: Vec2): Vec2 => {
    let best = fine[0]!;
    let bestSq = Infinity;
    for (let i = 0; i < fine.length; i++) {
      const a = fine[i]!;
      const b = fine[(i + 1) % fine.length]!;
      const ab = b.sub(a);
      const t = Math.min(1, Math.max(0, p.sub(a).dot(ab) / ab.lengthSquared()));
      const q = a.add(ab.mul(t));
      const d = q.sub(p).lengthSquared();
      if (d < bestSq) {
        bestSq = d;
        best = q;
      }
    }
    return best;
  };
  const rand = lcg(11);
  let worst = 0;
  let worstPoint = 0;
  let inside = 0;
  for (let i = 0; i < 200; i++) {
    const p = new Vec2(-0.5 + rand() * 4.8, -1.2 + rand() * 3.2);
    const ours = beltPointAt(loop, beltClosestS(loop, p));
    const brute = nearestOnPolyline(p);
    // The DISTANCE is compared to the chord error; the nearest POINT on a
    // flattened arc can slide along a chord by up to half a step, so that is
    // held to the step.
    worst = Math.max(worst, Math.abs(ours.distanceTo(p) - brute.distanceTo(p)));
    worstPoint = Math.max(worstPoint, ours.distanceTo(brute));
    // How many of the samples were inside the loop, so the claim covers both
    // sides: the outward normal points away from an inside point.
    const s = beltClosestS(loop, p);
    if (p.sub(beltPointAt(loop, s)).dot(beltNormalAt(loop, s)) < 0) inside++;
  }
  c.check(
    `200 points off the belt are as near the loop as a brute-force search says (worst ${worst.toExponential(2)} m)`,
    worst < 1e-6,
  );
  c.check(`...at the point it says, to the flattening's step (worst ${worstPoint.toExponential(2)} m)`, worstPoint < 3e-4);
  c.check(`...from inside the loop as well as outside (${inside} inside)`, inside > 10 && inside < 190);
  return c.done("off-belt - a point off the loop projects to its nearest point");
}

function caseSense(): BeltResult {
  const c = new Checks();
  // A belt drawn LEFT TO RIGHT, y down: the top run is at negative y.
  const loop = loopOf(
    [
      [0, 0, 0.15],
      [3, 0, 0.15],
    ],
    0.05,
  );
  const top = beltClosestS(loop, new Vec2(1.5, -1));
  const bottom = beltClosestS(loop, new Vec2(1.5, 1));
  const t = beltTangentAt(loop, top);
  c.check(`positive s runs along the top run toward the end roller (${t})`, t.x === 1 && t.y === 0);
  const b = beltTangentAt(loop, bottom);
  c.check(`...and back along the bottom run (${b})`, b.x === -1 && b.y === 0);
  const n = beltNormalAt(loop, top);
  c.check(`the normal points out of the loop, up off the top run (${n})`, n.x === 0 && n.y === -1);
  const left = beltTangentAt(loop, beltClosestS(loop, new Vec2(-1, 0)));
  c.check(`...and the first wheel's far side runs up (${left.toString()})`, left.y < -0.999);

  // The same statement made by the BODY: a belt authored at +200 px/s carries
  // a point above its top run rightward at 2 m/s.
  const world = new World();
  const built = buildLevelBodies(world, scaleLevelData(beltLevel(200), PX), () => {});
  const belt = built.belts[0]!;
  const v = belt.velocityAtPoint(new Vec2(2, -0.25));
  c.check(`a +200 px/s belt carries its top run at +2 m/s (${v})`, Math.abs(v.x - 2) < 1e-12 && v.y === 0);
  const vb = belt.velocityAtPoint(new Vec2(2, 0.25));
  c.check(`...and its bottom run back at -2 m/s (${vb})`, Math.abs(vb.x + 2) < 1e-12 && vb.y === 0);
  return c.done("sense - positive speed carries a left-to-right belt's top run toward the second wheel");
}

function caseDegenerate(): BeltResult {
  const c = new Checks();
  const throws = (f: () => unknown): boolean => {
    try {
      f();
      return false;
    } catch {
      return true;
    }
  };
  const two = (d: number, r1: number, r2: number, t = 0.05) => () =>
    loopOf(
      [
        [0, 0, r1],
        [d, 0, r2],
      ],
      t,
    );
  c.check("one wheel inside the other is refused", throws(two(0.1, 0.5, 0.2)));
  c.check("wheels touching on the inside are refused", throws(two(0.3, 0.5, 0.2)));
  c.check("a wheel of no size is refused", throws(two(1, 0, 0.2)));
  c.check("a negative radius is refused", throws(two(1, 0.2, -0.1)));
  c.check("a negative thickness is refused", throws(two(1, 0.2, 0.2, -0.01)));
  c.check("overlapping discs that still have external tangents are a belt", !throws(two(0.4, 0.5, 0.2)));
  return c.done("degenerate - wheels with no external tangents, or of no size, are not a belt");
}

// A belt is HOLLOW: a disc per wheel and a quad per run, and nothing between
// the wheels - so a point in the middle of the drive is inside no piece, while
// a point in the band and a point inside a wheel are.
function caseHollow(): BeltResult {
  const c = new Checks();
  const px = PIXELS_PER_METER;
  const level = scaleLevelData(
    {
      player: { x: 0, y: -500, radius: 8 },
      bodies: [
        {
          kind: "static",
          x: 100,
          y: 100,
          rot: 0,
          objects: [
            {
              type: "collision",
              shape: {
                kind: "belt",
                wheels: DRIVE.map(([x, y, r]) => ({ x: x * px, y: y * px, r: r * px })),
                thickness: DRIVE_THICKNESS * px,
                speed: 100,
              },
            },
          ],
        },
      ],
    },
    PX,
  );
  const body = buildLevelBodies(new World(), level, () => {}).bodies[0]!.body!;
  const shapes = body.getShapes();
  const kinds = shapes.map((s) => s.shape.kind).join(",");
  c.check(`three discs then three run quads (${kinds})`, kinds === "circle,circle,circle,poly,poly,poly");
  const origin = new Vec2(1, 1);
  const loop = shapes[0]!.belt!;
  const toWorld = (v: Vec2): Vec2 => body.globalPosition.add(v.rotated(body.globalRotation));
  // The middle of the drive: the centroid of the three centres, clear of every
  // disc (at least 0.3 m from each rim).
  const middle = origin.add(new Vec2((0 + 1.6 + 0.3) / 3, (0 + 0.3 + 1.3) / 3));
  c.check(`a point in the middle of the drive is inside no piece (${middle})`, !bodyContainsPoint(body, middle));
  const run = loop.segments[1]!;
  const inBand = run.kind === "run" ? toWorld(run.from.add(run.to).mul(0.5).sub(run.normal.mul(DRIVE_THICKNESS / 2))) : Vec2.ZERO;
  c.check(`a point in the band, halfway through it on the top run, is inside a piece (${inBand})`, bodyContainsPoint(body, inBand));
  const inWheel = origin.add(new Vec2(1.6, 0.3));
  c.check(`a point at the large wheel's centre is inside a piece: the disc is solid (${inWheel})`, bodyContainsPoint(body, inWheel));
  // Just inside the band's inner face, between the wheels, is the hollow.
  const underRun = run.kind === "run" ? toWorld(run.from.add(run.to).mul(0.5).sub(run.normal.mul(DRIVE_THICKNESS + 0.01))) : Vec2.ZERO;
  c.check(`a centimetre under the band's inner face mid-run is inside nothing (${underRun})`, !bodyContainsPoint(body, underRun));
  return c.done("hollow - nothing is built between the wheels; the band and the wheels are solid");
}

// ---------------------------------------------------------------------------
// Format and build
// ---------------------------------------------------------------------------

// The band thickness every two-wheel case is authored with, px: a thin band,
// as a level would author one. The cases were written against rollers of a
// SURFACE radius, and keep their numbers by putting the wheel `thickness`
// inside it - the surface is where it always was.
const BAND = 6;

// A two-wheel belt shape in pixels: wheel 0 at the origin, wheel 1 at
// `(dx, dy)`, both with their running surface at `surface` px.
function twoWheels(dx: number, dy: number, surface: number, speed: number): ShapeData {
  return {
    kind: "belt",
    wheels: [
      { x: 0, y: 0, r: surface - BAND },
      { x: dx, y: dy, r: surface - BAND },
    ],
    thickness: BAND,
    speed,
  };
}

// A horizontal stadium belt from (0, 0) to (1200, 0) px, its surface 20 px
// round each wheel, with whatever else the case needs beside it. The player is
// parked far off on a floor of its own.
function beltLevel(speed: number, extra: LevelBodyData[] = [], opts: { length?: number } = {}): RawLevelData {
  return {
    player: { x: -3000, y: -12, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: -3000,
        y: 20,
        rot: 0,
        objects: [{ type: "collision", shape: { kind: "rect", w: 400, h: 40 } }],
      },
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        objects: [
          {
            type: "collision",
            shape: twoWheels(opts.length ?? 1200, 0, 20, speed),
          },
        ],
      },
      ...extra,
    ],
  };
}

function crate(x: number, y = -41): LevelBodyData {
  return {
    kind: "rigid",
    x,
    y,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 40, h: 40 } }],
  };
}

function caseAuthored(): BeltResult {
  const c = new Checks();
  const raw: RawLevelData = {
    player: { x: 0, y: -500, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 100,
        y: 50,
        rot: 0.3,
        objects: [
          {
            type: "collision",
            x: 20,
            y: -10,
            rot: 0.2,
            shape: {
              kind: "belt",
              wheels: [
                { x: 0, y: 0, r: 29 },
                { x: 640, y: 90, r: 12 },
                { x: 200, y: 300, r: 20 },
              ],
              thickness: 6,
              speed: -150,
            },
          },
          // A plain wall beside it on the same body, so the belt's pieces are
          // not the only ones and the mount indices have to be read, not assumed.
          { type: "collision", x: -200, y: 0, shape: { kind: "rect", w: 40, h: 200 } },
        ],
      },
    ],
  };
  const metres = scaleLevelData(raw, PX);
  const shape = (metres.bodies[0]!.objects[0] as CollisionObjectData).shape;
  const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) < eps;
  const w = shape.kind === "belt" ? shape.wheels : [];
  c.check(
    `px -> m: every wheel, the thickness and the speed convert (${JSON.stringify(shape)})`,
    shape.kind === "belt" &&
      w.length === 3 &&
      near(w[1]!.x, 6.4, 1e-12) &&
      near(w[1]!.y, 0.9, 1e-12) &&
      near(w[0]!.r, 0.29, 1e-12) &&
      near(w[2]!.y, 3, 1e-12) &&
      near(w[2]!.r, 0.2, 1e-12) &&
      near(shape.thickness, 0.06, 1e-12) &&
      near(shape.speed, -1.5, 1e-12),
  );
  const back = scaleLevelData(metres as RawLevelData, PIXELS_PER_METER);
  const trip = (back.bodies[0]!.objects[0] as CollisionObjectData).shape;
  const src = (raw.bodies[0] as LevelBodyData).objects[0] as CollisionObjectData;
  c.check(
    `px -> m -> px keeps every field (${JSON.stringify(trip)})`,
    trip.kind === "belt" &&
      src.shape.kind === "belt" &&
      trip.wheels.length === src.shape.wheels.length &&
      trip.wheels.every(
        (tw, i) =>
          near(tw.x, src.shape.kind === "belt" ? src.shape.wheels[i]!.x : NaN, 1e-9) &&
          near(tw.y, src.shape.kind === "belt" ? src.shape.wheels[i]!.y : NaN, 1e-9) &&
          near(tw.r, src.shape.kind === "belt" ? src.shape.wheels[i]!.r : NaN, 1e-9),
      ) &&
      near(trip.thickness, src.shape.thickness, 1e-9) &&
      near(trip.speed, src.shape.speed, 1e-9),
  );

  const world = new World();
  const built = buildLevelBodies(world, metres, () => {});
  const body = built.bodies[0]!.body;
  c.check("a static with a belt builds as a conveyor", body instanceof ConveyorBody);
  c.check(`...and is handed back as one (${built.belts.length})`, built.belts.length === 1 && built.belts[0] === body);
  c.check("...whose frame does not move and whose surface does", body instanceof ConveyorBody && !body.isMobile && body.surfaceMoves);
  const shapes = body?.getShapes() ?? [];
  const beltShapes = shapes.filter((s) => s.belt !== null);
  const loop = beltShapes[0]?.belt ?? null;
  c.check(`the belt builds six pieces, all holding one loop (${beltShapes.length})`, beltShapes.length === 6 && beltShapes.every((s) => s.belt === loop));
  c.check("...and the wall beside it holds none", shapes.filter((s) => s.belt === null).length === 1);
  c.check(
    `...each carrying the speed in m/s (${beltShapes.map((s) => s.beltSpeed).join(", ")})`,
    beltShapes.every((s) => Math.abs(s.beltSpeed + 1.5) < 1e-12),
  );
  if (loop && body) {
    const kinds = loop.pieceAt.map((i) => shapes[i]?.shape.kind);
    c.check(
      `the loop names its pieces disc, quad, disc, quad, disc, quad (${kinds.join(", ")})`,
      kinds.join() === "circle,poly,circle,poly,circle,poly",
    );
    const worldOf = (p: Vec2): Vec2 => body.globalPosition.add(p.rotated(body.globalRotation));
    let worst = 0;
    loop.segments.forEach((seg, i) => {
      if (seg.kind !== "arc") return;
      const disc = shapes[loop.pieceAt[i]!]!;
      worst = Math.max(worst, worldOf(seg.centre).distanceTo(disc.globalPosition));
      if (disc.shape.kind !== "circle" || Math.abs(disc.shape.radius - seg.radius) > 1e-15) worst = Infinity;
    });
    c.check(`every arc's wheel sits on its own disc, at its radius (worst ${worst.toExponential(2)} m)`, worst < 1e-12);
    // Wheel 0 is the object's own origin, composed through the body.
    const want = new Vec2(1 + 0.2 * Math.cos(0.3) + 0.1 * Math.sin(0.3), 0.5 + 0.2 * Math.sin(0.3) - 0.1 * Math.cos(0.3));
    const w0 = worldOf(loop.wheels[0]!.c);
    c.check(`wheel 0 is the object's placement (${w0} vs ${want})`, w0.distanceTo(want) < 1e-12);
  }

  const throwsWith = (b: LevelBodyData): string | null => {
    try {
      buildLevelBodies(new World(), scaleLevelData({ player: raw.player, bodies: [b] }, PX), () => {});
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const beltObject = src;
  const onRigid = throwsWith({ kind: "rigid", x: 0, y: 0, rot: 0, objects: [beltObject] });
  c.check(`a belt on a rigid body fails the build (${onRigid})`, onRigid !== null && /belt/.test(onRigid));
  const onMover = throwsWith({ kind: "static", x: 0, y: 0, rot: 0, spinPeriod: 4, objects: [beltObject] });
  c.check(`a belt on a mover fails the build (${onMover})`, onMover !== null && /mover/.test(onMover));
  const nested = throwsWith({
    kind: "static",
    x: 0,
    y: 0,
    rot: 0,
    objects: [
      {
        type: "collision",
        shape: {
          kind: "belt",
          wheels: [
            { x: 0, y: 0, r: 50 },
            { x: 10, y: 0, r: 20 },
          ],
          thickness: 6,
          speed: 100,
        },
      },
    ],
  });
  c.check(`nested wheels fail the build (${nested})`, nested !== null);
  return c.done("authored - the kind survives the format and builds a conveyor, only on a still static");
}

// The belt level with the belt swapped for the pieces it is built from,
// authored by hand as plain circle and polygon objects - a disc of
// `r + thickness` per wheel, then a quad per run - in METRES, off the belt's own
// metre-scaled loop, so the comparison is about the build and not about two
// roundings of the same point.
function handAuthored(data: LevelData, bodyIndex: number): LevelData {
  const bodies = data.bodies.map((b, i) => {
    if (i !== bodyIndex) return b;
    const objects = b.objects.flatMap((o) => {
      if (o.type !== "collision" || o.shape.kind !== "belt") return [o];
      const s = o.shape;
      const loop = buildBeltLoop(
        s.wheels.map((w) => ({ c: new Vec2(w.x, w.y), r: w.r })),
        s.thickness,
      );
      const base = { ...o };
      return [
        ...s.wheels.map((w) => ({
          ...base,
          x: (o.x ?? 0) + w.x,
          y: (o.y ?? 0) + w.y,
          shape: { kind: "circle" as const, r: w.r + s.thickness },
        })),
        ...beltRunQuads(loop).map((q) => ({
          ...base,
          shape: { kind: "poly" as const, verts: q.map((v) => ({ x: v.x, y: v.y })) },
        })),
      ];
    });
    return { ...b, objects };
  });
  return { ...data, bodies };
}

function shapesEqual(a: readonly CollisionShape2D[], b: readonly CollisionShape2D[]): string | null {
  if (a.length !== b.length) return `${a.length} shapes against ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.shape.kind !== y.shape.kind) return `shape ${i}: ${x.shape.kind} against ${y.shape.kind}`;
    if (!x.localOffset.equals(y.localOffset) || x.localRotation !== y.localRotation) return `shape ${i} is mounted elsewhere`;
    if (x.globalPosition.x !== y.globalPosition.x || x.globalPosition.y !== y.globalPosition.y) return `shape ${i} stands elsewhere`;
    if (x.shape.kind === "circle" && y.shape.kind === "circle" && x.shape.radius !== y.shape.radius) return `shape ${i}'s radius differs`;
    if (x.shape.kind === "poly" && y.shape.kind === "poly") {
      const vx = x.shape.verts;
      const vy = y.shape.verts;
      if (vx.length !== vy.length || vx.some((v, k) => v.x !== vy[k]!.x || v.y !== vy[k]!.y)) return `shape ${i}'s vertices differ`;
    }
  }
  return null;
}

function caseStaticEquivalent(): BeltResult {
  const c = new Checks();

  // The build: a sloped three-wheel belt at speed 0 against its pieces.
  const sloped = scaleLevelData(
    {
      player: { x: 0, y: -500, radius: 8 },
      bodies: [
        {
          kind: "static",
          x: 130,
          y: 70,
          rot: 0,
          objects: [
            {
              type: "collision",
              shape: {
                kind: "belt",
                wheels: [
                  { x: 0, y: 0, r: 36 },
                  { x: 710, y: -160, r: 11 },
                  { x: 300, y: 140, r: 24 },
                ],
                thickness: 6,
                speed: 0,
              },
            },
          ],
        },
      ],
    },
    PX,
  );
  const beltBody = buildLevelBodies(new World(), sloped, () => {}).bodies[0]!.body!;
  const handBody = buildLevelBodies(new World(), handAuthored(sloped, 0), () => {}).bodies[0]!.body!;
  c.check(
    `the body stands at the same origin (${beltBody.globalPosition} vs ${handBody.globalPosition})`,
    beltBody.globalPosition.x === handBody.globalPosition.x && beltBody.globalPosition.y === handBody.globalPosition.y,
  );
  const diff = shapesEqual(beltBody.getShapes(), handBody.getShapes());
  c.check(`...with the very shapes the hand-authored pieces build (${diff ?? "identical"})`, diff === null);
  c.check(
    "...and at speed 0 its surface does not move",
    beltBody instanceof ConveyorBody && !beltBody.surfaceMoves && beltBody.velocityAtPoint(new Vec2(3, 0)) === Vec2.ZERO,
  );
  c.check("the hand-authored one is a plain static", handBody instanceof StaticBody2D && !(handBody instanceof ConveyorBody));

  // The play: a crate dropped on each, through the ball driver, digested every
  // frame for 300. A stadium on the axis, so the tangent points are exact and
  // the two levels can be authored in pixels and still scale to the same bits.
  const drop = [crate(300, -120), crate(900, -300)];
  const beltRaw = beltLevel(0, drop);
  const beltRun = new BallLevel(beltRaw);
  // The same level with the belt authored as its pieces, in pixels: on the
  // axis with equal wheels the tangent points are exactly (0, ±20) and
  // (1200, ±20) and the band's inner face exactly ±14, which is asserted
  // rather than assumed.
  const inner = 20 - BAND;
  const handRaw: RawLevelData = {
    ...beltRaw,
    bodies: beltRaw.bodies.map((b, i) =>
      i !== 1
        ? b
        : {
            ...(b as LevelBodyData),
            objects: [
              { type: "collision", shape: { kind: "circle", r: 20 } },
              { type: "collision", x: 1200, y: 0, shape: { kind: "circle", r: 20 } },
              {
                type: "collision",
                shape: {
                  kind: "poly",
                  verts: [
                    { x: 0, y: -20 },
                    { x: 1200, y: -20 },
                    { x: 1200, y: -inner },
                    { x: 0, y: -inner },
                  ],
                },
              },
              {
                type: "collision",
                shape: {
                  kind: "poly",
                  verts: [
                    { x: 1200, y: 20 },
                    { x: 0, y: 20 },
                    { x: 0, y: inner },
                    { x: 1200, y: inner },
                  ],
                },
              },
            ],
          },
    ),
  };
  const stadium = beltRun.belts[0]!.getShapes()[0]!.belt!;
  const exact = loopOf(
    [
      [0, 0, inner * PX],
      [1200 * PX, 0, inner * PX],
    ],
    BAND * PX,
  );
  const quads = beltRunQuads(exact);
  const top = quads[0]!;
  const bottom = quads[1]!;
  c.check(
    "the stadium's tangent points and inner faces are exact, so the pixel-authored pieces are the same bits",
    top[0]!.x === 0 &&
      top[0]!.y === -20 * PX &&
      top[1]!.x === 1200 * PX &&
      top[2]!.y === -inner * PX &&
      bottom[0]!.y === 20 * PX &&
      bottom[3]!.y === inner * PX &&
      stadium.total > 0,
  );
  const handRun = new BallLevel(handRaw);
  const input = (l: BallLevel): FrameInput => ({ ...emptyFrameInput(), mouseWorldPosition: l.ball.globalPosition });
  let firstDiff = -1;
  for (let f = 1; f <= 300; f++) {
    beltRun.physicsProcess(input(beltRun), DT);
    handRun.physicsProcess(input(handRun), DT);
    if (firstDiff < 0 && !worldDigestsEqual(worldDigestBall(beltRun), worldDigestBall(handRun))) firstDiff = f;
  }
  const crates = (l: BallLevel): RigidBody2D[] =>
    l.world.bodies.filter((b): b is RigidBody2D => b instanceof RigidBody2D && b !== l.ball && !b.removed);
  const landed = crates(beltRun).every((b) => b.linearVelocity.length() < 0.05 && b.globalPosition.y < 0);
  c.check("both crates landed on the belt and came to rest there", landed);
  c.check(
    `the digest is bit-identical for 300 frames (${firstDiff < 0 ? "no difference" : `first difference at f${firstDiff}`})`,
    firstDiff < 0,
  );
  return c.done("static-equivalent - a belt at speed 0 is exactly the static pieces it is built from");
}

// ---------------------------------------------------------------------------
// The carry
// ---------------------------------------------------------------------------

function neutral(l: BallLevel): FrameInput {
  return { ...emptyFrameInput(), mouseWorldPosition: l.ball.globalPosition };
}

function firstRigid(l: BallLevel): RigidBody2D {
  const b = l.world.bodies.find((x): x is RigidBody2D => x instanceof RigidBody2D && x !== l.ball);
  if (!b) throw new Error("no rigid body in the scene");
  return b;
}

// A crate dropped on the top run of a 12 m belt, run until it has gone off the
// end. Returns the per-frame x speed (displacement over dt) and position.
function carryRun(speedPx: number, startX: number): { v: number[]; x: number[]; y: number[]; pinned: boolean; level: BallLevel } {
  const level = new BallLevel(beltLevel(speedPx, [crate(startX)]));
  const box = firstRigid(level);
  const v: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  let pinned = false;
  for (let f = 0; f < 480; f++) {
    const x0 = box.globalPosition.x;
    level.physicsProcess(neutral(level), DT);
    v.push((box.globalPosition.x - x0) / DT);
    x.push(box.globalPosition.x);
    y.push(box.globalPosition.y);
    if (box.stickAnchor !== null) pinned = true;
  }
  return { v, x, y, pinned, level };
}

function assertCarried(c: Checks, speed: number, run: ReturnType<typeof carryRun>, runFrom: number, runTo: number): void {
  const sign = Math.sign(speed);
  // Up to speed within a second: Coulomb gives v / (mu·g), a third of a second
  // at these numbers, plus the landing.
  const upTo = run.v.findIndex((v) => Math.abs(v - speed) < 0.02 * Math.abs(speed));
  c.check(`the crate comes up to belt speed within a second (f${upTo + 1})`, upTo >= 0 && upTo < 60);
  // The middle of the run: between the two roller-lengths in from each end.
  const mid = run.v.filter((_, i) => {
    const px = run.x[i]!;
    return px > runFrom && px < runTo;
  });
  const worst = Math.max(...mid.map((v) => Math.abs(v - speed) / Math.abs(speed)));
  c.check(
    `over the middle of the run it rides at belt speed (${mid.length} frames, worst ${(worst * 100).toFixed(3)}% off ${speed} m/s)`,
    mid.length > 60 && worst < 0.02,
  );
  const advancing = mid.every((v) => v * sign > 0);
  c.check("...and is NOT pinned: it advances every frame of it", advancing && !run.pinned);
  const off = run.y.findIndex((y) => y > 1);
  c.check(`it rides off the end and falls (below the belt at f${off + 1})`, off > 0);
}

function caseCrateCarried(): BeltResult {
  const c = new Checks();
  assertCarried(c, 2, carryRun(200, 100), 2, 10);
  return c.done("crate-carried - a crate dropped on the top run rides it at belt speed and off the end");
}

function caseReverse(): BeltResult {
  const c = new Checks();
  assertCarried(c, -2, carryRun(-200, 1100), 2, 10);
  const run = carryRun(-200, 1100);
  c.check(`...off the START roller's end (x ${run.x[run.x.length - 1]!.toFixed(2)} m)`, run.x[run.x.length - 1]! < 0);
  return c.done("reverse - a negative speed carries the other way, at the same speed");
}

// A free ball - a rigid disc, not the steered player - dropped on a running
// belt. Rolling without slip against the BELT means the point of the ball
// touching it moves at belt speed. The ball starts still, so friction first
// spins it backward while dragging it forward (angular momentum about the
// contact is conserved), and the contact drag - relative to the belt's
// surface, as a drag is - then walks it to the one state both agree on: the
// ball riding along at belt speed, not turning at all.
function caseBallRolls(): BeltResult {
  const c = new Checks();
  for (const speedPx of [200, -200]) {
    const speed = speedPx / PIXELS_PER_METER;
    const r = 0.15;
    const level = new BallLevel(
      beltLevel(speedPx, [
        {
          kind: "rigid",
          x: speedPx > 0 ? 100 : 2400,
          y: -36,
          rot: 0,
          objects: [{ type: "collision", shape: { kind: "circle", r: r * PIXELS_PER_METER } }],
        },
      ], { length: 2500 }),
    );
    const ball = firstRigid(level);
    let spunBack = true;
    let worstSlip = 0;
    for (let f = 1; f <= 600; f++) {
      level.physicsProcess(neutral(level), DT);
      // The spin is always BACKWARD against the carry: the belt drags the
      // bottom of the ball its way.
      if (ball.angularVelocity * speed > 1e-9) spunBack = false;
      if (f > 30) {
        // The contact point's velocity, y down: the bottom of the ball is
        // (0, r) from its centre, so the spin adds (-w·r, 0) there.
        const contact = ball.linearVelocity.x - ball.angularVelocity * r;
        worstSlip = Math.max(worstSlip, Math.abs(contact - speed));
      }
    }
    const v = ball.linearVelocity.x;
    const w = ball.angularVelocity;
    const label = speed > 0 ? "+" : "-";
    c.check(`${label}: the ball ends riding at belt speed (${v.toFixed(4)} of ${speed} m/s)`, Math.abs(v - speed) < 0.02 * Math.abs(speed));
    c.check(`${label}: ...barely turning (w·r ${(w * r).toFixed(4)} m/s)`, Math.abs(w * r) < 0.02 * Math.abs(speed));
    c.check(`${label}: its spin was never forward of the carry`, spunBack);
    c.check(
      `${label}: past the landing the contact never slips by more than the drag's share (${(worstSlip * 100).toFixed(2)} cm/s)`,
      worstSlip < 0.03 * Math.abs(speed),
    );
  }
  return c.done("ball-rolls - a free ball is dragged into rolling without slip, and ends riding the belt");
}

// The grapple avatar, through `Level`: standing still on the belt it is carried
// at belt speed; walking against a belt running at its own walking speed it
// stands still - the treadmill - and the stuck detector, which arms only near
// a MOBILE body, does not call that a freeze. The avatar is put beside the
// belt body's own origin, which is exactly where the detector would arm if a
// belt counted as mobile to it.
function caseAvatarCarried(): BeltResult {
  const c = new Checks();
  const grapple = (speedPx: number, spawnX: number): RawLevelData => ({
    player: { x: spawnX, y: -60, radius: 16 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        objects: [{ type: "collision", shape: twoWheels(1600, 0, 20, speedPx) }],
      },
    ],
  });
  const run = (level: Level, frames: number, hold: "none" | "right"): { v: number[]; x: number[]; violations: string[] } => {
    const stuck = new StuckDetector();
    let prev: ButtonInput = { held: false, pressed: false, released: false };
    const v: number[] = [];
    const x: number[] = [];
    const violations: string[] = [];
    for (let f = 1; f <= frames; f++) {
      const held = hold === "right" && f > 30;
      const btn: ButtonInput = { held, pressed: held && !prev.held, released: !held && prev.held };
      prev = btn;
      const input: FrameInput = { ...emptyFrameInput(), moveRight: btn };
      const x0 = level.player.globalPosition.x;
      level.physicsProcess(input, DT);
      v.push((level.player.globalPosition.x - x0) / DT);
      x.push(level.player.globalPosition.x);
      const bad = stuck.push(level, input);
      if (bad) violations.push(`${bad.kind} f${bad.frame}`);
    }
    return { v, x, violations };
  };

  const standing = run(new Level(grapple(200, 200)), 240, "none");
  const ride = standing.v.slice(60, 240);
  const worstRide = Math.max(...ride.map((v) => Math.abs(v - 2)));
  c.check(`standing still, the avatar is carried at belt speed (worst ${(worstRide * 100).toFixed(3)} cm/s off 2 m/s)`, worstRide < 0.02);

  // Its walking speed, measured on the same belt standing still.
  const walking = run(new Level(grapple(0, 200)), 150, "right");
  const walk = walking.v[149]!;
  c.check(`walking on a still belt it reaches its walking speed (${walk.toFixed(4)} m/s)`, walk > 1);

  const tread = run(new Level(grapple(-walk * PIXELS_PER_METER, 860)), 300, "right");
  const drift = Math.abs(tread.x[299]! - tread.x[119]!);
  c.check(`walking against a belt run at that speed it stands still (${(drift * 100).toFixed(3)} cm over 3 s)`, drift < 0.01);
  c.check(
    `...and the stuck detector does not call that a freeze (${tread.violations.join(", ") || "no violations"})`,
    tread.violations.length === 0 && standing.violations.length === 0,
  );
  return c.done("avatar-carried - the grapple avatar rides a belt, and walks against one on the spot");
}

function caseWakes(): BeltResult {
  const c = new Checks();
  for (const speedPx of [200, 0]) {
    const level = new BallLevel(beltLevel(speedPx, [crate(400)]));
    const box = firstRigid(level);
    for (let f = 0; f < 90; f++) level.physicsProcess(neutral(level), DT);
    box.sleep();
    const x0 = box.globalPosition.x;
    level.physicsProcess(neutral(level), DT);
    if (speedPx !== 0) {
      c.check("a crate put to sleep on a running belt is awake the next frame", !box.asleep);
      level.physicsProcess(neutral(level), DT);
      // Sleep zeroed its velocity, so it starts again from rest: moving the
      // belt's way and being brought up to speed by friction.
      c.check(
        `...and being carried again (${((box.globalPosition.x - x0) * 100).toFixed(2)} cm in two frames, at ${box.linearVelocity.x.toFixed(3)} m/s)`,
        box.globalPosition.x > x0 && box.linearVelocity.x > 0.1,
      );
    } else {
      c.check("the same crate on a belt standing still sleeps on", box.asleep && box.globalPosition.x === x0);
    }
  }
  return c.done("wakes - a running belt wakes what sleeps on it; a still one is scenery");
}

function caseNoPin(): BeltResult {
  const c = new Checks();
  const running = carryRun(200, 100);
  c.check("a crate riding a running belt is never given a stick anchor", !running.pinned);
  // Read while it rests AWAKE: once it sleeps (half a second still) the grip
  // lets go, as it does on any floor.
  const still = new BallLevel(beltLevel(0, [crate(400)]));
  const box = firstRigid(still);
  let gripped = 0;
  for (let f = 1; f <= 50; f++) {
    still.physicsProcess(neutral(still), DT);
    if (f > 20 && box.stickAnchor !== null && !box.asleep) gripped++;
  }
  c.check(`the same crate at rest on the belt standing still is gripped (the scenery pin, session-477f; ${gripped} of 30 frames)`, gripped === 30);
  return c.done("no-pin - the stiction pin declines a running belt and keeps a still one");
}

function caseUndisturbable(): BeltResult {
  const c = new Checks();
  const boulder: LevelBodyData = {
    kind: "rigid",
    x: 600,
    y: -400,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "circle", r: 60 }, material: "stone" } as CollisionObjectData],
  };
  const level = new BallLevel(beltLevel(200, [boulder]));
  const belt = level.belts[0]!;
  const pose = { p: belt.globalPosition, r: belt.globalRotation };
  const loop = belt.getShapes()[0]!.belt;
  const v0 = belt.velocityAtPoint(new Vec2(5, -0.2));
  for (let f = 0; f < 120; f++) level.physicsProcess(neutral(level), DT);
  const v1 = belt.velocityAtPoint(new Vec2(5, -0.2));
  c.check(
    "a boulder dropped on a belt changes nothing about it: pose, loop and surface speed",
    belt.globalPosition === pose.p && belt.globalRotation === pose.r && belt.getShapes()[0]!.belt === loop && v0.equals(v1),
  );
  return c.done("undisturbable - a belt is a static; nothing dropped on it moves it");
}

function caseEnergyArmed(): BeltResult {
  const c = new Checks();
  const level = new BallLevel(beltLevel(200, [crate(100)]));
  const monitor = new EnergyMonitor();
  const violations: string[] = [];
  let conveyed = 0;
  for (let f = 0; f < 300; f++) {
    const input = neutral(level);
    level.physicsProcess(input, DT);
    if (level.world.conveyedThisFrame) conveyed++;
    const bad = monitor.push(level, input);
    if (bad) violations.push(`f${bad.frame}: ${bad.detail}`);
  }
  c.check(`the carry is reported as a source (${conveyed} of 300 frames)`, conveyed > 60);
  c.check(`the energy monitor does not fire on a crate carried for 300 frames (${violations.join("; ") || "none"})`, violations.length === 0);
  const still = new BallLevel(beltLevel(0, [crate(100)]));
  let stillConveyed = 0;
  for (let f = 0; f < 120; f++) {
    still.physicsProcess(neutral(still), DT);
    if (still.world.conveyedThisFrame) stillConveyed++;
  }
  c.check(`a belt standing still is no source, so the monitor stays armed over it (${stillConveyed} frames)`, stillConveyed === 0);

  // A RIDE is the same motor reached through the chain: the ball hangs clear
  // of the belt, so no contact of it is conveyed, while the carried anchor
  // hauls it along the bottom run and up over the start roller. Left unread,
  // that lift is an unforced gain (a headless `TEST_BELT` run carried round
  // the loop fired `energy-gained` at f583: +34 J over a 389-frame span, the
  // ball 0.41 m higher than where the span began). Aim left at the ball
  // itself once it rides, so no steering restarts the span on its behalf.
  const rig = new RideRig(underBelt(300));
  const rideMonitor = new EnergyMonitor();
  const rideViolations: string[] = [];
  let riding = 0;
  let lowest = Infinity;
  let highest = -Infinity;
  for (let f = 0; f < 300; f++) {
    const aim = rig.ride ? rig.level.ball.globalPosition : rig.aim(THROW_UP);
    const input: FrameInput = { ...emptyFrameInput(), fire: button(true, rig.lastInput.fire), mouseWorldPosition: aim };
    rig.stepWith(input);
    if (rig.ride) {
      riding++;
      lowest = Math.min(lowest, -rig.level.ball.globalPosition.y);
      highest = Math.max(highest, -rig.level.ball.globalPosition.y);
    }
    const bad = rideMonitor.push(rig.level, input);
    if (bad) rideViolations.push(`f${bad.frame}: ${bad.detail}`);
  }
  c.check(
    `a hanging ball carried round the start roller rode ${riding} frames and was lifted ${(highest - lowest).toFixed(2)} m`,
    riding > 200 && highest - lowest > 0.3,
  );
  c.check(`...and the monitor does not read the ride's lift as unforced (${rideViolations.join("; ") || "none"})`, rideViolations.length === 0);
  return c.done("energy-armed - a running belt is a source the monitor is told about, under a crate and through a ride");
}

// ---------------------------------------------------------------------------
// The ride
// ---------------------------------------------------------------------------

// The ball and a belt, driven through the real deploy wiring with the deploy
// held, every frame checked against the ball's invariants and the chain-tunnel
// monitor. Aimed `throwAt` (metres, from the ball) until the cuff rides, and
// at the pin from then on, so the chain leaves the loop radially and nothing
// winds unless a case asks for it.
class RideRig {
  readonly level: BallLevel;
  readonly violations: Violation[] = [];
  private prev: FrameInput = emptyFrameInput();
  private readonly tunnel = new TunnelMonitor();

  constructor(raw: RawLevelData) {
    this.level = new BallLevel(raw);
  }

  get ride(): RopeRide | null {
    const end = this.level.ball.chain?.end;
    return end instanceof RopeRide ? end : null;
  }

  get belt(): ConveyorBody {
    return this.level.belts[0]!;
  }

  step(aim: Vec2, fire = true): void {
    this.stepWith({ ...emptyFrameInput(), fire: button(fire, this.prev.fire), mouseWorldPosition: aim });
  }

  // The input the last step was played with, for a caller building its own.
  get lastInput(): FrameInput {
    return this.prev;
  }

  stepWith(input: FrameInput): void {
    this.prev = input;
    this.level.physicsProcess(input, DT);
    this.violations.push(...checkBallInvariants(this.level));
    const tunnel = this.tunnel.push(this.level);
    if (tunnel) this.violations.push(tunnel);
  }

  aim(throwAt: Vec2): Vec2 {
    const ride = this.ride;
    return ride ? ride.contact.globalPosition : this.level.ball.globalPosition.add(throwAt);
  }

  // Throw until the cuff rides; the frame index it rode on, or -1.
  throwUntilRiding(throwAt: Vec2, frames = 60): number {
    for (let f = 0; f < frames; f++) {
      this.step(this.aim(throwAt));
      if (this.ride) return f;
    }
    return -1;
  }

  violationSummary(): string {
    return this.violations.slice(0, 3).map((v) => `${v.kind} f${v.frame}`).join(", ") || "none";
  }
}

// A 12 m stadium belt from (-600, 0) to (600, 0) px, its surface 20 px round
// each wheel, with the ball hanging 1.2 m under the middle of its bottom run.
// At a positive speed the bottom run carries toward wheel 0 (leftward).
function underBelt(speedPx: number, extra: LevelBodyData[] = []): RawLevelData {
  return {
    player: { x: 0, y: 120, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: -600,
        y: 0,
        rot: 0,
        objects: [{ type: "collision", shape: twoWheels(1200, 0, 20, speedPx) }],
      },
      ...extra,
    ],
  };
}

const THROW_UP = new Vec2(0, -1.2);

// The ride's position is a pure function of the frame: carried frame by frame
// through two laps (every seam and the modulo wrap crossed), it is at every
// frame the bit-identical position a ride rebuilt from `s0` and `frame0` alone
// lands at that frame - and so is the ride a hooked ball is actually carried
// by, mid-level, which is what a replay seeking into a ride re-simulates.
function caseRidePure(): BeltResult {
  const c = new Checks();
  const rig = new RideRig(underBelt(150));
  const belt = rig.belt;
  const piece = belt.getShapes()[2]!;
  const loop = piece.belt!;
  const frame0 = 7;
  const stepped = RopeRide.restore(belt, piece, 1.234, frame0, DT, 0.3, MANACLE_HINGE, frame0);
  const laps = (2 * loop.total) / (1.5 * DT);
  let mismatch = -1;
  for (let f = frame0 + 1; f <= frame0 + laps; f++) {
    stepped.carry(f);
    const fresh = RopeRide.restore(belt, piece, 1.234, frame0, DT, 0.3, MANACLE_HINGE, f);
    const a = stepped.contact.position;
    const b = fresh.contact.position;
    if (
      a.x !== b.x ||
      a.y !== b.y ||
      stepped.contact.shapeIndex !== fresh.contact.shapeIndex ||
      stepped.facingLocal.x !== fresh.facingLocal.x ||
      stepped.facingLocal.y !== fresh.facingLocal.y
    ) {
      mismatch = f;
      break;
    }
  }
  c.check(
    `carried frame by frame for two laps (${Math.round(laps)} frames), every frame is bit-identical to a ride rebuilt at that frame${mismatch >= 0 ? ` (first differs at f${mismatch})` : ""}`,
    mismatch < 0,
  );

  const bit = rig.throwUntilRiding(THROW_UP);
  c.check(`a ball's hook bites the belt's bottom run and rides it (frame ${bit})`, bit >= 0);
  for (let f = 0; f < 150; f++) rig.step(rig.aim(THROW_UP));
  const ride = rig.ride;
  if (ride) {
    const at = rig.level.frame;
    const rebuilt = RopeRide.restore(belt, piece, ride.s0, ride.frame0, ride.dt, ride.phi, ride.standoff, at);
    const a = ride.contact.position;
    const b = rebuilt.contact.position;
    c.check(
      `...and 150 frames on, the anchor the level carried is where the ride rebuilt from s0 ${ride.s0.toFixed(4)} and f${ride.frame0} puts it at f${at}, to the bit`,
      a.x === b.x && a.y === b.y && ride.contact.shapeIndex === rebuilt.contact.shapeIndex,
    );
  } else {
    c.check("...and is still riding 150 frames on", false);
  }
  return c.done("ride-pure - where a ride stands is a pure function of the frame");
}

// A ball hanging from a running belt's bottom run is carried along it at belt
// speed. The anchor runs at exactly belt speed; the ball, started from rest
// under a support that starts moving, swings as a pendulum about it, so its
// speed is measured over a whole swing. The grapple's hook rides a belt the
// same way.
function caseRideCarried(): BeltResult {
  const c = new Checks();
  const speed = -1; // the bottom run at +100 px/s
  const rig = new RideRig(underBelt(100));
  const bit = rig.throwUntilRiding(THROW_UP);
  c.check(`the hook bites the bottom run and rides it (frame ${bit})`, bit >= 0);
  const pin: number[] = [];
  const ball: number[] = [];
  let worstPin = 0;
  for (let f = 0; f < 330; f++) {
    const p0 = rig.ride?.contact.globalPosition.x ?? NaN;
    rig.step(rig.aim(THROW_UP));
    const p = rig.ride?.contact.globalPosition.x ?? NaN;
    worstPin = Math.max(worstPin, Math.abs((p - p0) / DT - speed));
    pin.push(p);
    ball.push(rig.level.ball.globalPosition.x);
  }
  c.check(`the anchor rides at belt speed every frame (worst ${worstPin.toExponential(2)} m/s off ${speed})`, worstPin < 1e-9);
  // The swing is damped, so its turning points drift toward the anchor from
  // one swing to the next; where the lag crosses zero, the same way, a swing
  // apart, the ball is exactly where the anchor is, and the anchor has gone
  // at belt speed. The crossing is interpolated within its frame.
  const lag = ball.map((b, i) => b - pin[i]!);
  const crossings: { t: number; x: number }[] = [];
  for (let i = 1; i < lag.length; i++) {
    const a = lag[i - 1]!;
    const b = lag[i]!;
    if (a > 0 && b <= 0) {
      const u = a / (a - b);
      crossings.push({ t: (i - 1 + u) * DT, x: ball[i - 1]! + (ball[i]! - ball[i - 1]!) * u });
    }
  }
  const [from, to] = crossings;
  const mean = from !== undefined && to !== undefined ? (to.x - from.x) / (to.t - from.t) : NaN;
  c.check(
    `over a whole swing (${from ? from.t.toFixed(2) : "-"} s to ${to ? to.t.toFixed(2) : "-"} s) the ball travels at belt speed (${mean.toFixed(4)} of ${speed} m/s)`,
    Math.abs(mean - speed) < 0.02 * Math.abs(speed),
  );
  c.check(`no invariant fired (${rig.violationSummary()})`, rig.violations.length === 0);

  // The grapple: its hook, a point with no cuff, rides too, and drags the
  // avatar along under it.
  const level = new Level({
    player: { x: 0, y: 150, radius: 16 },
    bodies: underBelt(100).bodies,
  });
  let prev: FrameInput = emptyFrameInput();
  let rideFrames = 0;
  let worstGrapple = 0;
  const avatar0 = level.player.globalPosition.x;
  for (let f = 0; f < 200; f++) {
    const input: FrameInput = {
      ...emptyFrameInput(),
      fire: button(f >= 2, prev.fire),
      mouseWorldPosition: new Vec2(level.player.globalPosition.x, -1),
    };
    prev = input;
    const end0 = level.player.rope?.end;
    const p0 = end0 instanceof RopeRide ? end0.contact.globalPosition.x : null;
    level.physicsProcess(input, DT);
    const end = level.player.rope?.end;
    if (end instanceof RopeRide) {
      rideFrames++;
      if (p0 !== null) worstGrapple = Math.max(worstGrapple, Math.abs((end.contact.globalPosition.x - p0) / DT - speed));
    }
  }
  const dragged = level.player.globalPosition.x - avatar0;
  c.check(
    `the grapple's hook rides the belt too (${rideFrames} frames, worst ${worstGrapple.toExponential(2)} m/s off belt speed)`,
    rideFrames > 150 && worstGrapple < 1e-9,
  );
  c.check(`...and drags the avatar along under it (${dragged.toFixed(3)} m in 200 frames)`, dragged < -1.5);
  return c.done("ride-carried - a ball hanging from a running belt is carried at belt speed");
}

// The anchor bitten on the TOP run goes round the end roller and onto the
// bottom run. While it is on the arc the chain bends round that roller - every
// wrap the chain has on the belt is on the roller's own piece, and it has one
// - and never cuts through it; the contact names the roller while it is on the
// arc and the quad on the runs; and the cuff, which keeps its angle to the
// surface, has turned by exactly the arc's sweep when it comes off it.
// Carry a riding anchor from the run before arc segment `arc` round that arc
// and onto the run after it, asserting what `ride-round-roller` and `ride-3`
// both claim: the contact names the wheel's disc on the arc and each run's own
// quad on the runs, the chain bends round that disc (every wrap it has on the
// belt is on it, and it has one) and never cuts through it, and the cuff,
// which keeps its angle to the surface, has turned by exactly the arc's sweep
// when it comes off it. Returns the frames spent on the arc.
function carryRound(c: Checks, rig: RideRig, ride: RopeRide, throwAt: Vec2, arc: number, frames: number): void {
  const loop = ride.loop;
  const seg = loop.segments[arc]!;
  const n = loop.segments.length;
  const wheelPiece = loop.pieceAt[arc]!;
  const before = (arc + n - 1) % n;
  const after = (arc + 1) % n;
  const segment = (): number => beltSegmentAt(loop, ride.s(rig.level.frame)).index;
  let arcFrames = 0;
  let wrappedFrames = 0;
  // Arc frames on which the straight line from the ball to the anchor would
  // cut the wheel's disc by more than a centimetre, so the chain HAS to bend
  // round it - and how many of those it did. A ball riding the band right
  // behind its anchor needs no wrap: the chord between them clears the disc.
  let needed = 0;
  let wrappedWhenNeeded = 0;
  let strayWrap = "";
  let wrongPiece = "";
  let lastBeforeRot: number | null = null;
  let firstAfterRot: number | null = null;
  let reachedAfter = false;
  const body = rig.belt;
  for (let f = 0; f < frames && !reachedAfter; f++) {
    rig.step(rig.aim(throwAt));
    if (rig.ride !== ride) break;
    const at = segment();
    if (ride.contact.shapeIndex !== loop.pieceAt[at]! && !wrongPiece) {
      wrongPiece = `f${rig.level.frame} names ${ride.contact.shapeIndex} on segment ${at}`;
    }
    const rot = ride.cuff?.localRotation ?? null;
    if (at === before) lastBeforeRot = rot;
    if (at === after && firstAfterRot === null && lastBeforeRot !== null) {
      firstAfterRot = rot;
      reachedAfter = true;
    }
    if (at !== arc) continue;
    arcFrames++;
    const beltWraps = rig.level.ball.chain!.wraps.filter((w) => w.contact.obj === rig.belt);
    const wrapped = beltWraps.some((w) => w.contact.shapeIndex === wheelPiece);
    if (wrapped) wrappedFrames++;
    if (seg.kind === "arc") {
      const centre = body.globalPosition.add(seg.centre.rotated(body.globalRotation));
      const from = rig.level.ball.globalPosition;
      const chord = ride.contact.globalPosition.sub(from);
      const t = Math.min(1, Math.max(0, centre.sub(from).dot(chord) / chord.lengthSquared()));
      if (from.add(chord.mul(t)).distanceTo(centre) < seg.radius - 0.01) {
        needed++;
        if (wrapped) wrappedWhenNeeded++;
      }
    }
    const stray = beltWraps.find((w) => w.contact.shapeIndex !== wheelPiece);
    if (stray && !strayWrap) strayWrap = `f${rig.level.frame} on piece ${stray.contact.shapeIndex}`;
  }
  c.check(`the anchor comes round the wheel onto the next run (${arcFrames} frames on the arc)`, reachedAfter && arcFrames > 0);
  c.check(`...naming the wheel's disc on the arc and each run's quad on the runs${wrongPiece ? ` (${wrongPiece})` : ""}`, !wrongPiece);
  c.check(
    `...with the chain bent round the wheel on every frame the straight line to the anchor would cut it (${wrappedWhenNeeded} of ${needed}; wrapped ${wrappedFrames} of ${arcFrames} arc frames) and on nothing else of the belt${strayWrap ? ` (${strayWrap})` : ""}`,
    needed > 0 && wrappedWhenNeeded === needed && !strayWrap,
  );
  const sweep = seg.kind === "arc" ? seg.sweep : NaN;
  const turned =
    lastBeforeRot !== null && firstAfterRot !== null
      ? (((firstAfterRot - lastBeforeRot) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      : NaN;
  c.check(
    `...and the cuff has turned by the arc's sweep (${turned.toFixed(9)} of ${sweep.toFixed(9)} rad)`,
    Math.abs(turned - sweep) < 1e-9,
  );
}

function caseRideRoundRoller(): BeltResult {
  const c = new Checks();
  const rig = new RideRig({
    player: { x: 300, y: -30, radius: 8 },
    bodies: underBelt(100).bodies,
  });
  const throwAt = new Vec2(1, 0.15);
  const bit = rig.throwUntilRiding(throwAt);
  c.check(`the ball standing on the top run bites it ahead of itself (frame ${bit})`, bit >= 0);
  const ride = rig.ride;
  if (!ride) return c.done("ride-round-roller - the anchor goes round the second wheel");
  // Segment 2 is the arc on wheel 1, the far end of a two-wheel belt.
  carryRound(c, rig, ride, throwAt, 2, 240);
  c.check(`no chain through the wheel, no invariant fired (${rig.violationSummary()})`, rig.violations.length === 0);
  return c.done("ride-round-roller - the anchor goes round the second wheel, the chain bent round it");
}

// The three-wheel drive stretched along x so its level top run is 4 m, running
// at `speedPx`, with the player wherever the case puts it.
function driveLevel(speedPx: number, player: { x: number; y: number }, extra: LevelBodyData[] = []): RawLevelData {
  const px = PIXELS_PER_METER;
  return {
    player: { ...player, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        friction: 1,
        objects: [
          {
            type: "collision",
            shape: {
              kind: "belt",
              wheels: DRIVE.map(([x, y, r]) => ({ x: x * 2.5 * px, y: y * px, r: r * px })),
              thickness: DRIVE_THICKNESS * px,
              speed: speedPx,
            },
          },
        ],
      },
      ...extra,
    ],
  };
}

// A crate on the top run of the three-wheel belt comes up to belt speed and
// rides it, and a free ball on it is brought to rolling without slip against
// the belt - the carry does not care how many wheels the loop has.
function caseCarried3(): BeltResult {
  const c = new Checks();
  const speed = 2;
  // Wheel 0 at the origin, its top (and so the top run) 0.2 m above it.
  const box: LevelBodyData = {
    kind: "rigid",
    x: 60,
    y: -42,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 40, h: 40 } }],
  };
  const level = new BallLevel(driveLevel(200, { x: -3000, y: -500 }, [box]));
  const crate = firstRigid(level);
  const v: number[] = [];
  const onTop: boolean[] = [];
  for (let f = 0; f < 150; f++) {
    const x0 = crate.globalPosition.x;
    level.physicsProcess(neutral(level), DT);
    v.push((crate.globalPosition.x - x0) / DT);
    onTop.push(crate.globalPosition.y < -0.35 && crate.globalPosition.x < 3.8);
  }
  const upTo = v.findIndex((x) => Math.abs(x - speed) < 0.02 * speed);
  c.check(`a crate on the top run comes up to belt speed within a second (f${upTo + 1})`, upTo >= 0 && upTo < 60);
  const riding = v.filter((x, i) => i > upTo + 5 && onTop[i]);
  const worst = Math.max(...riding.map((x) => Math.abs(x - speed) / speed));
  c.check(
    `...and rides the top run at it (${riding.length} frames, worst ${(worst * 100).toFixed(3)}% off ${speed} m/s)`,
    riding.length > 30 && worst < 0.02,
  );

  const r = 0.15;
  const ballLevel = new BallLevel(
    driveLevel(200, { x: -3000, y: -500 }, [
      {
        kind: "rigid",
        x: 60,
        y: -36,
        rot: 0,
        objects: [{ type: "collision", shape: { kind: "circle", r: r * PIXELS_PER_METER } }],
      },
    ]),
  );
  const ball = firstRigid(ballLevel);
  let worstSlip = 0;
  let frames = 0;
  for (let f = 1; f <= 90; f++) {
    ballLevel.physicsProcess(neutral(ballLevel), DT);
    if (f <= 30 || ball.globalPosition.x > 3.6) continue;
    frames++;
    const contact = ball.linearVelocity.x - ball.angularVelocity * r;
    worstSlip = Math.max(worstSlip, Math.abs(contact - speed));
  }
  c.check(
    `a free ball on it rolls without slip against the belt past the landing (${frames} frames, worst ${(worstSlip * 100).toFixed(2)} cm/s)`,
    frames > 30 && worstSlip < 0.03 * speed,
  );
  return c.done("carried-3 - a three-wheel belt carries a crate and a ball as two wheels do");
}

// A hook bitten on the top run of the three-wheel belt rides it round the
// LARGE wheel and on along the next run: where it stands is the pure function
// of the frame all the way round (rebuilt from `s0` and `frame0` at the end, to
// the bit), and while it is on the arc the chain is bent round that wheel's
// disc and nothing else of the belt.
function caseRide3(): BeltResult {
  const c = new Checks();
  // Standing on the top run, two and a half metres short of the large wheel,
  // biting a long throw ahead, so the chain has to bend round the wheel as
  // the anchor goes over it.
  const rig = new RideRig(driveLevel(100, { x: 150, y: -30 }));
  const throwAt = new Vec2(1.6, 0.1);
  const bit = rig.throwUntilRiding(throwAt);
  c.check(`the ball standing on the top run bites it ahead of itself (frame ${bit})`, bit >= 0);
  const ride = rig.ride;
  if (!ride) return c.done("ride-3 - the anchor goes round the large wheel of a three-wheel belt");
  const loop = ride.loop;
  const arc = loop.segments.findIndex((s) => s.kind === "arc" && s.wheel === 1);
  c.check(`the top run leads onto the large wheel's arc (segment ${arc})`, arc === 2 && beltSegmentAt(loop, ride.s(rig.level.frame)).index === 1);
  carryRound(c, rig, ride, throwAt, arc, 400);
  const at = rig.level.frame;
  const piece = rig.belt.getShapes()[0]!;
  const rebuilt = RopeRide.restore(rig.belt, piece, ride.s0, ride.frame0, ride.dt, ride.phi, ride.standoff, at);
  c.check(
    `the anchor the level carried round is where a ride rebuilt from s0 ${ride.s0.toFixed(4)} and f${ride.frame0} puts it at f${at}, to the bit`,
    rig.ride === ride &&
      ride.contact.position.x === rebuilt.contact.position.x &&
      ride.contact.position.y === rebuilt.contact.position.y &&
      ride.contact.shapeIndex === rebuilt.contact.shapeIndex,
  );
  c.check(`no chain through a wheel, no invariant fired (${rig.violationSummary()})`, rig.violations.length === 0);
  return c.done("ride-3 - the anchor goes round the large wheel of a three-wheel belt and on along the next run");
}

// A fast belt carries the anchor 10 cm a frame past a 4 cm post hanging just
// under the bottom run: the span between the ball and the anchor passes the
// post within a frame. The continuous sweep sees the carry as the end's motion
// and wraps the post on the side it came from; the same run with the sweep off
// lands the sampled span inside the post, bends it round the wrong corner and
// lets go of it on the far side - which the tunnel monitor reports, so the rig
// is a detector rather than a script that happens to pass.
function caseRideWrapSweep(): BeltResult {
  const c = new Checks();
  const post: LevelBodyData = {
    kind: "static",
    x: -60,
    y: 33,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 4, h: 4 } }],
  };
  const run = (sweep: boolean): { rig: RideRig; caught: Vec2 | null; heldFor: number } => {
    const rig = new RideRig(underBelt(600, [post]));
    let caught: Vec2 | null = null;
    let heldFor = 0;
    for (let f = 0; f < 20; f++) {
      if (!sweep && rig.level.ball.chain) rig.level.ball.chain.continuous = false;
      rig.step(rig.aim(THROW_UP));
      const onPost = rig.level.ball.chain?.wraps.find((w) => w.contact.obj !== rig.belt && w.contact.obj !== rig.level.ball);
      if (onPost) {
        caught ??= onPost.contact.globalPosition;
        heldFor++;
      }
    }
    return { rig, caught, heldFor };
  };
  const on = run(true);
  c.check(
    `the carried chain catches the post (${on.caught ? `at ${on.caught.x.toFixed(3)},${on.caught.y.toFixed(3)}` : "never"}, held ${on.heldFor} frames)`,
    on.caught !== null && on.heldFor >= 5,
  );
  // The anchor comes from the right, so the chain meets the post's RIGHT
  // side, and the top corner is the one it bends round under the belt.
  c.check("...on the corner it came from (the post's top right)", on.caught !== null && Math.abs(on.caught.x + 0.58) < 1e-6 && Math.abs(on.caught.y - 0.31) < 1e-6);
  c.check(`...and nothing went through anything (${on.rig.violationSummary()})`, on.rig.violations.length === 0);
  const off = run(false);
  const tunnel = off.rig.violations.find((v) => v.kind === "chain-tunnel");
  c.check(`with the sweep off the same carry goes through the post (${tunnel ? `chain-tunnel f${tunnel.frame}` : "not reported"})`, tunnel !== undefined);
  return c.done("ride-wrap-sweep - the sweep sees the carry, and catches a post it carries the chain across");
}

// Winding in while carried: the ball winds its chain onto itself (the aim
// circling it) and hauls itself to the moving anchor - hanging under the
// bottom run, in free air, and standing on the top run with the anchor ahead
// of it, where it is dragged along the running surface it rests on and the
// stall lease, which only ever answers a surface, is live. The carry is the
// anchor's own motion, made before the frame's chain phase and reported to the
// rope as such (`RopeRide.velocity`), so none of it is read as a block: the
// hanging length only shrinks, the stall lease never opens and the wind-stall
// latch never closes, all the way in.
function caseRideWinch(): BeltResult {
  const c = new Checks();
  const scenes: { name: string; raw: RawLevelData; throwAt: Vec2; whirl: number }[] = [
    { name: "hanging", raw: underBelt(100), throwAt: THROW_UP, whirl: -30 },
    { name: "standing", raw: { player: { x: 300, y: -30, radius: 8 }, bodies: underBelt(100).bodies }, throwAt: new Vec2(1, 0.15), whirl: 30 },
  ];
  for (const scene of scenes) {
    const rig = new RideRig(scene.raw);
    const bit = rig.throwUntilRiding(scene.throwAt);
    c.check(`${scene.name}: the hook bites and rides (frame ${bit})`, bit >= 0);
    for (let f = 0; f < 20; f++) rig.step(rig.aim(scene.throwAt));
    const chain = rig.level.ball.chain!;
    const start = chain.hangingLength();
    const from = rig.level.ball.loopDirection.angle();
    let rise = 0;
    let lease = 0;
    let stalled = 0;
    let last = start;
    let frames = 0;
    const length = chain.maxRopeLength;
    let paidOut = 0;
    for (; frames < 200 && last > 0.2; frames++) {
      const bearing = from + (2 * Math.PI * (frames + 1)) / scene.whirl;
      // Taut going into the frame: a slack chain's hanging length is only
      // geometry, and the loop turning under it moves it both ways.
      const taut = chain.getCurrentLength() >= chain.maxRopeLength - 1e-3;
      rig.step(rig.level.ball.globalPosition.add(new Vec2(Math.cos(bearing), Math.sin(bearing))));
      const now = chain.hangingLength();
      if (taut) rise = Math.max(rise, now - last);
      last = now;
      paidOut = Math.max(paidOut, chain.maxRopeLength - length);
      lease = Math.max(lease, chain.blockedSlack);
      if (rig.level.ball.windStall !== 0) stalled++;
    }
    c.check(`${scene.name}: still riding throughout`, rig.ride !== null && rig.level.ball.chain === chain);
    c.check(`${scene.name}: winding hauls the ball in (${start.toFixed(3)} m -> ${last.toFixed(3)} m in ${frames} frames)`, last <= 0.2);
    c.check(
      `${scene.name}: ...no chain paid out (${(paidOut * 1000).toFixed(4)} mm) and the hanging length only ever shrinking while taut (largest rise ${(rise * 1000).toFixed(4)} mm)`,
      paidOut === 0 && rise <= 1e-6,
    );
    c.check(
      `${scene.name}: ...with the stall lease shut (largest ${(lease * 1000).toFixed(4)} mm) and the wind stall never latched (${stalled} frames)`,
      lease === 0 && stalled === 0,
    );
    c.check(`${scene.name}: no invariant fired (${rig.violationSummary()})`, rig.violations.length === 0);
  }
  return c.done("ride-winch - winding in while carried is not read as a block");
}

// A carry the chain cannot follow tears the cuff out: a ball hanging under the
// bottom run is carried into a wall that stands up to 15 cm under the belt,
// too narrow a gap for it, and the belt goes on taking the anchor away. The
// stall lease pays that out at the carry's own rate; once it passes the
// attach's snap the cuff comes out as the dangling tip, clear of the belt and
// with its cuff unmounted, rather than the chain running out without bound
// (`rope-grew`, which is what `TEST_BELT`'s low belt did before).
function caseRideTear(): BeltResult {
  const c = new Checks();
  const wall: LevelBodyData = {
    kind: "static",
    x: -150,
    y: 97.5,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 20, h: 125 } }],
  };
  const rig = new RideRig(underBelt(150, [wall]));
  const pieces = rig.belt.getShapes().length;
  const bit = rig.throwUntilRiding(THROW_UP);
  c.check(`the hook bites the bottom run and rides it (frame ${bit})`, bit >= 0);
  let tore = -1;
  let lease = 0;
  let tipClear = false;
  for (let f = 0; f < 200 && tore < 0; f++) {
    rig.step(rig.aim(THROW_UP));
    const chain = rig.level.ball.chain;
    if (chain) lease = Math.max(lease, chain.blockedSlack);
    if (!rig.ride) {
      tore = rig.level.frame;
      const tip = rig.level.ball.chainTip;
      tipClear = tip !== null && rig.belt.getShapes().every((piece) => shapeContacts(piece, tip.primaryShape()).length === 0);
    }
  }
  const carryPerFrame = 1.5 * DT;
  c.check(`the belt tears the cuff out (f${tore})`, tore >= 0 && rig.level.ball.chain !== null);
  c.check(
    `...once the lease passed the attach's snap, and no further than a frame of carry past it (largest ${(lease * 1000).toFixed(1)} mm)`,
    lease > BallPlayer.ATTACH_SNAP_TOLERANCE && lease <= BallPlayer.ATTACH_SNAP_TOLERANCE + carryPerFrame + 1e-9,
  );
  c.check(`...as the dangling tip, clear of the belt`, tipClear);
  c.check(`...with the cuff unmounted (${rig.belt.getShapes().length} of ${pieces} pieces)`, rig.belt.getShapes().length === pieces);
  c.check(`no invariant fired, rope-grew included (${rig.violationSummary()})`, rig.violations.length === 0);
  return c.done("ride-tear - a carry the chain cannot follow tears the cuff out");
}

// Letting go of a ride takes the cuff off the belt: the belt body is back to
// its own three pieces, and a fresh throw rides again with a fresh cuff.
function caseRideDetach(): BeltResult {
  const c = new Checks();
  const rig = new RideRig(underBelt(100));
  const pieces = rig.belt.getShapes().length;
  const bit = rig.throwUntilRiding(THROW_UP);
  const ride = rig.ride;
  c.check(`the hook rides (frame ${bit}) with its cuff mounted on the belt (${pieces} -> ${rig.belt.getShapes().length} pieces)`, ride !== null && ride.cuff !== null && rig.belt.getShapes().length === pieces + 1);
  for (let f = 0; f < 30; f++) rig.step(rig.aim(THROW_UP));
  const cuff = ride?.cuff ?? null;
  rig.step(rig.level.ball.globalPosition.add(THROW_UP), false);
  c.check(
    `letting go drops the chain and unmounts the cuff (${rig.belt.getShapes().length} pieces, cuff ${cuff !== null && rig.belt.getShapes().includes(cuff) ? "still there" : "gone"})`,
    rig.level.ball.chain === null && rig.belt.getShapes().length === pieces && (cuff === null || !rig.belt.getShapes().includes(cuff)),
  );
  for (let f = 0; f < 5; f++) rig.step(rig.level.ball.globalPosition.add(THROW_UP), false);
  const again = rig.throwUntilRiding(THROW_UP);
  c.check(
    `a fresh throw rides again (frame ${again}) with one cuff (${rig.belt.getShapes().length} pieces)`,
    rig.ride !== null && rig.ride !== ride && rig.belt.getShapes().length === pieces + 1,
  );
  return c.done("ride-detach - letting go takes the cuff off the belt");
}

export function runBeltCases(): BeltResult[] {
  return [
    caseStadium(),
    caseUnequal(),
    caseSeams(),
    caseRoundTrip(),
    caseOffBelt(),
    caseSense(),
    caseDegenerate(),
    caseHull3(),
    caseHullRefuses(),
    caseHollow(),
    caseAuthored(),
    caseStaticEquivalent(),
    caseCrateCarried(),
    caseReverse(),
    caseBallRolls(),
    caseCarried3(),
    caseAvatarCarried(),
    caseWakes(),
    caseNoPin(),
    caseUndisturbable(),
    caseEnergyArmed(),
    caseRidePure(),
    caseRideCarried(),
    caseRideRoundRoller(),
    caseRide3(),
    caseRideWrapSweep(),
    caseRideWinch(),
    caseRideDetach(),
    caseRideTear(),
  ];
}
