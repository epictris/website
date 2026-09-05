// Scripted-mover cases: the two motions a level FILE can author, run by
// `cli movers`.
//
// A mover is a body the level drives rather than one the sim solves - a
// pendulum on a bearing (`LevelBodyData.swingAmp`) and a body travelling a route
// (`movePath`) - so, like the spring body, its whole behaviour has a closed
// form: where it is on frame N is an arithmetic expression in N, and every
// number an author types has a consequence that can be written down. A regression
// is therefore a number rather than a screenshot, which matters more here than
// almost anywhere: a mover reaches no digest and no invariant of its own, so a
// build that quietly stopped reading a field renders a level that looks
// identical, plays differently and violates nothing.
//
// Four claims are asserted that are NOT arithmetic, because they are the whole
// of what makes these bodies what they are:
//
//   - the motion is a pure function of the frame number, so a replay lands it in
//     the same place (`determinism`);
//   - nothing in the level can disturb it, however heavy (`undisturbable`);
//   - it CARRIES what rides it, through the ordinary contact path (`rider`);
//   - and the authored fields are READ - a level with them builds a mover and
//     one without builds the plain static it always did (`authored`).

import { Vec2 } from "../engine/vec2";
import { AnimatableBody2D, RigidBody2D, StaticBody2D } from "../engine/body";
import { rectShape } from "../engine/shapes";
import { World } from "../engine/world";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { PX as PX_FACTOR, PIXELS_PER_METER } from "../engine/units";
import { buildLevelBodies, worldPlacement } from "../level/buildBodies";
import { scaleLevelData, type LevelBodyData, type RawLevelData } from "../level/levelFormat";
import { buildMovePath, easeFraction, moveDistanceAt, pointAlong } from "../level/movers";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { LEVELS } from "../level/registry";

const DT = 1 / 60;

export interface MoverResult {
  name: string;
  passed: boolean;
  details: string[];
}

function ok(name: string, passed: boolean, details: string[]): MoverResult {
  return { name, passed, details };
}

// One authored level, built and stepped - which is the only honest way to check
// a mover, since half of what is being asserted is that the BUILD reads the
// fields. `Level` and `BallLevel` both just run the list this returns, so
// stepping it here is stepping exactly what they step.
class Scene {
  readonly world = new World();
  readonly movers: ReturnType<typeof buildLevelBodies>["movers"];
  readonly bodies: ReturnType<typeof buildLevelBodies>["bodies"];
  frame = 0;

  constructor(raw: RawLevelData) {
    const built = buildLevelBodies(this.world, scaleLevelData(raw, PX_FACTOR), () => {});
    this.movers = built.movers;
    this.bodies = built.bodies;
  }

  // One frame, in the order both level drivers run it: the movers are written
  // from the sim clock first, then the world integrates whatever is riding them.
  step(frames = 1): void {
    for (let i = 0; i < frames; i++) {
      this.frame++;
      const time = this.frame * DT;
      for (const m of this.movers) {
        m.body.beginMove();
        m.script(m.body, time);
        m.body.commitMove(DT);
      }
      this.world.integrate(DT);
    }
  }

  mover(i = 0): AnimatableBody2D {
    const m = this.movers[i];
    if (!m) throw new Error(`no mover ${i}`);
    return m.body;
  }
}

// A ledge to stand things on, at the given place and size, in scene pixels.
function slab(x: number, y: number, w: number, h: number): RawLevelData["bodies"][number] {
  return {
    kind: "static",
    x,
    y,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w, h } }],
  };
}

// The worked pendulum these cases are written against: a 3.5 m arm bolted at the
// origin, swinging 20 degrees either side on a 10 s beat. Deliberately the shape
// of the one `TEST_SWING` authors, so the numbers here mean something about a
// level rather than about a rig.
const SWING_AMP = 0.349;
const SWING_PERIOD = 10;
const SWING_ARM = 350;

function pendulum(opts: { phase?: number; x?: number } = {}): RawLevelData["bodies"][number] {
  return {
    kind: "static",
    x: opts.x ?? 0,
    y: 0,
    rot: 0,
    pivotX: 0,
    pivotY: 0,
    swingAmp: SWING_AMP,
    swingPeriod: SWING_PERIOD,
    ...(opts.phase !== undefined ? { swingPhase: opts.phase } : {}),
    objects: [
      { type: "collision", x: 0, y: SWING_ARM / 2, rot: 0, shape: { kind: "rect", w: 16, h: SWING_ARM } },
      { type: "collision", x: 0, y: SWING_ARM + 12, rot: 0, shape: { kind: "rect", w: 200, h: 24 } },
    ],
  };
}

function swingLevel(bodies: RawLevelData["bodies"]): RawLevelData {
  return { player: { x: -1000, y: 0, radius: 8 }, bodies };
}

// ---------------------------------------------------------------------------
// swing-arc: a pendulum stands where the sine says, and its bearing does not
// move at all.
//
// The bearing is asserted at `=== 0` rather than at "small", because it is held
// by construction - the body is mounted ON it, so the mover writes a rotation
// and nothing else - and a bearing that has drifted by a micron means something
// is writing a position that should not be.
// ---------------------------------------------------------------------------
function caseSwingArc(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const scene = new Scene(swingLevel([pendulum()]));
  const body = scene.mover();
  const bearing = body.globalPosition;
  let worstAngle = 0;
  let worstBearing = 0;
  let minRot = Infinity;
  let maxRot = -Infinity;
  for (let f = 1; f <= 900; f++) {
    scene.step();
    const want = SWING_AMP * Math.sin((2 * Math.PI * (f * DT)) / SWING_PERIOD);
    worstAngle = Math.max(worstAngle, Math.abs(body.globalRotation - want));
    worstBearing = Math.max(worstBearing, body.globalPosition.sub(bearing).length());
    minRot = Math.min(minRot, body.globalRotation);
    maxRot = Math.max(maxRot, body.globalRotation);
  }
  check(`the angle follows the sine (worst ${worstAngle.toExponential(1)} rad)`, worstAngle < 1e-12);
  check(`the bearing never moves (${worstBearing} m)`, worstBearing === 0);
  check(
    `the sweep is the authored amplitude (${minRot.toFixed(4)} .. ${maxRot.toFixed(4)} rad of ±${SWING_AMP})`,
    Math.abs(maxRot - SWING_AMP) < 1e-4 && Math.abs(minRot + SWING_AMP) < 1e-4,
  );

  // ...and the period, read off the crossings rather than off the formula that
  // produced them - the one number an author times a jump against.
  let last = 0;
  const crossings: number[] = [];
  const timed = new Scene(swingLevel([pendulum()]));
  for (let f = 1; f <= 2000; f++) {
    timed.step();
    const r = timed.mover().globalRotation;
    if (last <= 0 && r > 0) crossings.push(f * DT);
    last = r;
  }
  const gaps = crossings.slice(1).map((t, i) => t - crossings[i]!);
  const worstGap = Math.max(...gaps.map((g) => Math.abs(g - SWING_PERIOD)));
  check(
    `${crossings.length} crossings ${SWING_PERIOD} s apart (worst error ${worstGap.toFixed(3)} s)`,
    gaps.length > 0 && worstGap < 2 * DT,
  );

  return ok("swing-arc - a pendulum keeps the arc and the beat it was authored at", passed, details);
}

// ---------------------------------------------------------------------------
// swing-phase: the phase means what the field says it means.
//
// Two claims, and the second is the reason the field is in CYCLES: a pendulum
// with no phase stands exactly where it was drawn on frame zero, and one
// authored a quarter of a cycle on is a quarter of a cycle ahead of it - which
// is a statement an author can check by eye and could not if the number were in
// radians.
// ---------------------------------------------------------------------------
function caseSwingPhase(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const scene = new Scene(swingLevel([pendulum(), pendulum({ phase: 0.25, x: 1000 })]));
  const [plain, quarter] = [scene.mover(0), scene.mover(1)];
  check(`a phase-less pendulum spawns at its authored angle (${plain.globalRotation} rad)`, plain.globalRotation === 0);
  check(
    `a quarter-cycle one spawns at its extreme (${quarter.globalRotation.toFixed(4)} of ${SWING_AMP})`,
    Math.abs(quarter.globalRotation - SWING_AMP) < 1e-9,
  );

  // A quarter of a cycle apart in TIME: the second body's angle now is the
  // first's a quarter of a period from now, for every frame of a whole cycle.
  const quarterFrames = Math.round((SWING_PERIOD / 4) / DT);
  const first: number[] = [];
  const second: number[] = [];
  for (let f = 1; f <= 900; f++) {
    scene.step();
    first.push(plain.globalRotation);
    second.push(quarter.globalRotation);
  }
  let worst = 0;
  for (let i = 0; i + quarterFrames < first.length; i++) {
    worst = Math.max(worst, Math.abs(second[i]! - first[i + quarterFrames]!));
  }
  check(`the pair stays a quarter cycle apart (worst ${worst.toExponential(1)} rad)`, worst < 1e-12);

  return ok("swing-phase - a phase is a fraction of a cycle, on frame zero and after", passed, details);
}

// ---------------------------------------------------------------------------
// inherit: a mover hands a rider the velocity it is actually moving at.
//
// `velocityAtPoint` is what every contact reads, and it is `v + w x r` computed
// from the per-frame transform delta - so the check is against the thing it
// stands in for: where a MATERIAL point of the body actually went this frame,
// divided by the step. Get this wrong and a platform is either a wall that
// scrapes its rider off or a floor that leaves them behind, and nothing about
// either reads as a mover bug.
// ---------------------------------------------------------------------------
function caseInherit(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  for (const [what, raw] of [
    ["a pendulum", swingLevel([pendulum()])],
    [
      "a travelling body",
      swingLevel([
        {
          kind: "static",
          x: 0,
          y: 0,
          rot: 0,
          movePath: [{ x: 300, y: -200 }],
          moveSpeed: 80,
          objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
        },
      ]),
    ],
  ] as const) {
    const scene = new Scene(raw);
    const body = scene.mover();
    // A point out at the end of the body, in its own frame, so a rotation
    // contributes as much as a translation does.
    const local = new Vec2(1, 3.5);
    const at = (): Vec2 => body.globalPosition.add(local.rotated(body.globalRotation));
    let worst = 0;
    for (let f = 0; f < 600; f++) {
      const before = at();
      scene.step();
      const measured = at().sub(before).div(DT);
      worst = Math.max(worst, body.velocityAtPoint(at()).sub(measured).length());
    }
    // The residual is the difference between `w x r` at the frame's END and the
    // chord the point actually swept, which is second order in `w·dt` - a
    // millimetre a second at these rates, and zero for a pure translation.
    check(`${what} reports the velocity its surface has (worst ${worst.toExponential(1)} m/s)`, worst < 5e-3);
  }

  return ok("inherit - a mover's contact velocity is the motion its surface has", passed, details);
}

// ---------------------------------------------------------------------------
// undisturbable: nothing in the level moves a mover.
//
// The whole point of a driven body, and the reason it is an `AnimatableBody2D`
// rather than a `rigid` on a bearing: an author timing a jump against a rhythm
// needs the rhythm to be a fact. Asserted as bit-identity against the same mover
// with nothing on it, over a fall heavy enough to visibly shove any body that
// could be shoved.
// ---------------------------------------------------------------------------
function caseUndisturbable(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const platform: RawLevelData["bodies"][number] = {
    kind: "static",
    x: 0,
    y: 0,
    rot: 0,
    // A short route under a wide deck, so the boulder is carried rather than
    // slid off the end - the control below is that it landed and stayed.
    movePath: [{ x: 150, y: 0 }],
    moveSpeed: 60,
    moveEase: "sine",
    objects: [{ type: "collision", shape: { kind: "rect", w: 400, h: 24 } }],
  };
  const boulder: RawLevelData["bodies"][number] = {
    kind: "rigid",
    x: 0,
    y: -300,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "circle", r: 60 }, material: "lead" }],
  };

  const alone = new Scene(swingLevel([platform]));
  const laden = new Scene(swingLevel([platform, boulder]));
  const rock = laden.bodies[1]?.body;
  let worst = 0;
  for (let f = 0; f < 600; f++) {
    alone.step();
    laden.step();
    worst = Math.max(
      worst,
      alone.mover().globalPosition.sub(laden.mover().globalPosition).length(),
    );
  }
  check(`a lead boulder dropped on it changes its path by nothing (${worst} m)`, worst === 0);
  check(
    `...and the boulder is riding it (${rock instanceof RigidBody2D ? rock.globalPosition.y.toFixed(2) : "?"} m of -0.72)`,
    rock instanceof RigidBody2D && rock.globalPosition.y > -1 && rock.globalPosition.y < -0.5,
  );

  // ...and the same for a pendulum, which a falling weight could torque if it
  // were a body the solver owned.
  const swingAlone = new Scene(swingLevel([pendulum()]));
  const swingLaden = new Scene(swingLevel([pendulum(), { ...boulder, y: -600 }]));
  let worstRot = 0;
  for (let f = 0; f < 600; f++) {
    swingAlone.step();
    swingLaden.step();
    worstRot = Math.max(
      worstRot,
      Math.abs(swingAlone.mover().globalRotation - swingLaden.mover().globalRotation),
    );
  }
  check(`the same weight dropped on a pendulum turns it by nothing (${worstRot} rad)`, worstRot === 0);

  return ok("undisturbable - a driven body is a fact the level cannot argue with", passed, details);
}

// ---------------------------------------------------------------------------
// rider: a moving platform carries what is standing on it.
//
// The other half of `inherit`: the velocity is reported, and here it is actually
// spent - a box resting on a shuttle travels with the shuttle rather than being
// left behind on the spot. Measured against the platform, because the claim is
// that the two move TOGETHER rather than that the box goes anywhere in
// particular.
// ---------------------------------------------------------------------------
function caseRider(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const scene = new Scene(
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        movePath: [{ x: 500, y: 0 }],
        moveSpeed: 50,
        moveEase: "sine",
        objects: [{ type: "collision", shape: { kind: "rect", w: 400, h: 24 } }],
      },
      {
        kind: "rigid",
        x: 0,
        y: -30,
        rot: 0,
        objects: [{ type: "collision", shape: { kind: "rect", w: 60, h: 40 } }],
      },
    ]),
  );
  const platform = scene.mover();
  const box = scene.bodies[1]?.body as RigidBody2D;
  // A second to settle onto the platform, then the ride.
  scene.step(60);
  const offset = box.globalPosition.sub(platform.globalPosition);
  let worst = 0;
  let travelled = 0;
  for (let f = 0; f < 300; f++) {
    scene.step();
    worst = Math.max(worst, box.globalPosition.sub(platform.globalPosition).sub(offset).length());
    travelled = Math.max(travelled, Math.abs(platform.globalPosition.x));
  }
  check(`the platform actually went somewhere (${travelled.toFixed(2)} m)`, travelled > 1);
  check(`the box rides it rather than being left behind (slipped ${(worst * 100).toFixed(1)} cm)`, worst < 0.15);

  return ok("rider - a moving platform carries what stands on it", passed, details);
}

// ---------------------------------------------------------------------------
// shuttle: an open route is travelled there and back, at the authored speed.
//
// `moveSpeed` is a SPEED and not a duration precisely so that a route can be
// re-drawn without re-timing the level, so the assertion is on the average over
// a traverse rather than on when the body arrives.
// ---------------------------------------------------------------------------
function caseShuttle(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const SPEED = 100; // px/s -> 1 m/s
  const scene = new Scene(
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        movePath: [{ x: 300, y: 0 }, { x: 300, y: -400 }],
        moveSpeed: SPEED,
        objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
      },
    ]),
  );
  const body = scene.mover();
  const start = body.globalPosition;
  const far = new Vec2(3, -4);
  // 7 m of route at 1 m/s: 7 s out and 7 s back.
  const traverse = 7;
  check(`it spawns on waypoint zero (${start.x}, ${start.y})`, start.x === 0 && start.y === 0);

  let worstOvershoot = 0;
  let nearestFar = Infinity;
  let backAtStart = Infinity;
  for (let f = 1; f <= Math.round(2 * traverse / DT); f++) {
    scene.step();
    const p = body.globalPosition.sub(start);
    // The route is an L, so "did it leave the route" is the distance from the
    // two legs - which for this shape is just the two clamped segments.
    const onLeg1 = Math.abs(p.y) < 1e-9 && p.x >= -1e-9 && p.x <= 3 + 1e-9;
    const onLeg2 = Math.abs(p.x - 3) < 1e-9 && p.y <= 1e-9 && p.y >= -4 - 1e-9;
    if (!onLeg1 && !onLeg2) worstOvershoot = Math.max(worstOvershoot, 1);
    nearestFar = Math.min(nearestFar, p.sub(far).length());
    if (f * DT > traverse) backAtStart = Math.min(backAtStart, p.length());
  }
  check("it never leaves the route", worstOvershoot === 0);
  check(`it reaches the far end (${(nearestFar * 100).toFixed(2)} cm short)`, nearestFar < 0.02);
  check(`...and comes back to the start (${(backAtStart * 100).toFixed(2)} cm)`, backAtStart < 0.02);

  // The average speed over one traverse IS the authored one, which is the whole
  // meaning of the field.
  const measured = new Scene(
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        movePath: [{ x: 300, y: 0 }, { x: 300, y: -400 }],
        moveSpeed: SPEED,
        objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
      },
    ]),
  );
  let path = 0;
  let prev = measured.mover().globalPosition;
  for (let f = 1; f <= Math.round(traverse / DT); f++) {
    measured.step();
    path += measured.mover().globalPosition.sub(prev).length();
    prev = measured.mover().globalPosition;
  }
  check(
    `the average speed is the authored one (${(path / traverse).toFixed(4)} m/s of ${SPEED * PX_FACTOR})`,
    Math.abs(path / traverse - SPEED * PX_FACTOR) < 1e-3,
  );

  return ok("shuttle - an open route is travelled there and back at its speed", passed, details);
}

// ---------------------------------------------------------------------------
// loop: a closed route is gone ROUND, in one direction, for ever.
//
// The distinguishing claim is monotone progress: a shuttle turns round at the
// ends and a loop does not, so the body's distance travelled must never fall
// back on itself, and it must be exactly where it started after each lap.
// ---------------------------------------------------------------------------
function caseLoop(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const scene = new Scene(
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        // A 2 m x 1 m rectangle: 6 m round, so 6 s a lap at 1 m/s.
        movePath: [{ x: 200, y: 0 }, { x: 200, y: -100 }, { x: 0, y: -100 }],
        moveClosed: true,
        moveSpeed: 100,
        objects: [{ type: "collision", shape: { kind: "rect", w: 60, h: 24 } }],
      },
    ]),
  );
  const body = scene.mover();
  const start = body.globalPosition;
  const lapFrames = Math.round(6 / DT);

  let reversed = 0;
  let prev = body.globalPosition;
  let prevDir = Vec2.ZERO;
  let worstLap = 0;
  const corners = [new Vec2(0, 0), new Vec2(2, 0), new Vec2(2, -1), new Vec2(0, -1)];
  const nearest = corners.map(() => Infinity);
  for (let f = 1; f <= 3 * lapFrames; f++) {
    scene.step();
    const p = body.globalPosition.sub(start);
    corners.forEach((c, i) => {
      nearest[i] = Math.min(nearest[i]!, p.sub(c).length());
    });
    const step = body.globalPosition.sub(prev);
    // A reversal is a step pointing back down the one it followed, which on a
    // loop only happens at a turn - so it is measured as an about-face rather
    // than as any change of direction.
    if (step.length() > 0 && prevDir.length() > 0 && step.normalized().dot(prevDir) < -0.5) {
      reversed++;
    }
    prevDir = step.length() > 0 ? step.normalized() : prevDir;
    prev = body.globalPosition;
    if (f % lapFrames === 0) worstLap = Math.max(worstLap, p.length());
  }
  check(`it visits every corner (worst ${(Math.max(...nearest) * 100).toFixed(2)} cm)`, Math.max(...nearest) < 0.02);
  check(`it never turns back on itself (${reversed} reversals)`, reversed === 0);
  check(`each lap ends where it began (worst ${(worstLap * 100).toFixed(2)} cm)`, worstLap < 0.02);

  return ok("loop - a closed route is a lap, not a shuttle", passed, details);
}

// ---------------------------------------------------------------------------
// ease: an ease redistributes a traverse and never lengthens it, and what
// separates the four is the rate AT THE ENDS.
//
// The end rate is the whole reason more than one is offered: it decides whether
// the body turns round smoothly or reverses outright, and a reversal is a step
// in velocity thrown at whatever is riding the platform.
// ---------------------------------------------------------------------------
function caseEase(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  for (const ease of ["linear", "sine", "easeIn", "easeOut"] as const) {
    check(`${ease} starts at 0 and ends at 1`, easeFraction(ease, 0) === 0 && easeFraction(ease, 1) === 1);
  }
  // Monotone, or the platform would double back in the middle of a traverse.
  for (const ease of ["linear", "sine", "easeIn", "easeOut"] as const) {
    let monotone = true;
    for (let i = 1; i <= 1000; i++) {
      if (easeFraction(ease, i / 1000) < easeFraction(ease, (i - 1) / 1000)) monotone = false;
    }
    check(`${ease} never goes backwards`, monotone);
  }

  // The rate at each end, as the fraction covered in the first and last
  // thousandth of the trip. `linear` covers the same everywhere; `sine` tapers
  // at both; `easeIn` and `easeOut` are the two halves of that, one each.
  const h = 1e-3;
  const rates = (ease: "linear" | "sine" | "easeIn" | "easeOut"): [number, number] => [
    easeFraction(ease, h) / h,
    (1 - easeFraction(ease, 1 - h)) / h,
  ];
  const [linA, linB] = rates("linear");
  check(`linear turns hard at both ends (${linA.toFixed(2)}, ${linB.toFixed(2)})`, linA > 0.9 && linB > 0.9);
  const [sinA, sinB] = rates("sine");
  check(`sine eases out of both (${sinA.toFixed(3)}, ${sinB.toFixed(3)})`, sinA < 0.02 && sinB < 0.02);
  const [inA, inB] = rates("easeIn");
  check(`easeIn leaves gently and arrives hard (${inA.toFixed(3)}, ${inB.toFixed(2)})`, inA < 0.02 && inB > 1.5);
  const [outA, outB] = rates("easeOut");
  check(`easeOut leaves hard and settles in (${outA.toFixed(2)}, ${outB.toFixed(3)})`, outA > 1.5 && outB < 0.02);

  // ...and none of them changes how long the trip takes: the body is at the far
  // end after exactly one traverse whichever is authored.
  const path = buildMovePath([new Vec2(4, 0)], false);
  for (const ease of ["linear", "sine", "easeIn", "easeOut"] as const) {
    const atEnd = moveDistanceAt(path, 1, 0, ease, 4);
    const atStart = moveDistanceAt(path, 1, 0, ease, 0);
    check(
      `${ease} takes the same 4 s (start ${atStart.toFixed(4)} m, end ${atEnd.toFixed(4)} m of 4)`,
      Math.abs(atStart) < 1e-9 && Math.abs(atEnd - 4) < 1e-9,
    );
  }

  return ok("ease - an ease shapes a traverse without lengthening it", passed, details);
}

// ---------------------------------------------------------------------------
// move-phase: a phase is a fraction of a CYCLE on a route too - one lap of a
// closed one, one there-and-back of an open one - which is what makes 0.5 the
// far end of a shuttle and half way round a loop.
// ---------------------------------------------------------------------------
function caseMovePhase(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const open = buildMovePath([new Vec2(4, 0)], false);
  check(
    `half a cycle is the far end of a shuttle (${moveDistanceAt(open, 1, 0.5, "linear", 0).toFixed(4)} m of 4)`,
    Math.abs(moveDistanceAt(open, 1, 0.5, "linear", 0) - 4) < 1e-9,
  );
  check(
    `a whole one is the start again (${moveDistanceAt(open, 1, 1, "linear", 0).toFixed(4)} m)`,
    Math.abs(moveDistanceAt(open, 1, 1, "linear", 0)) < 1e-9,
  );
  const closed = buildMovePath([new Vec2(2, 0), new Vec2(2, -1), new Vec2(0, -1)], true);
  check(`a closed route's journey is its perimeter (${closed.total} m)`, Math.abs(closed.total - 6) < 1e-12);
  check(
    `half a cycle is half way round a loop (${moveDistanceAt(closed, 1, 0.5, "linear", 0).toFixed(4)} m of 6)`,
    Math.abs(moveDistanceAt(closed, 1, 0.5, "linear", 0) - 3) < 1e-9,
  );

  // ...and the two spawn where that says: a phase-less body on waypoint zero.
  const scene = new Scene(
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        movePath: [{ x: 400, y: 0 }],
        moveSpeed: 100,
        movePhase: 0.5,
        objects: [{ type: "collision", shape: { kind: "rect", w: 60, h: 24 } }],
      },
    ]),
  );
  check(
    `a half-phase body spawns at the far end (${scene.mover().globalPosition.x.toFixed(4)} m of 4)`,
    Math.abs(scene.mover().globalPosition.x - 4) < 1e-9,
  );

  return ok("move-phase - a phase is a fraction of a cycle on a route too", passed, details);
}

// ---------------------------------------------------------------------------
// route-geometry: `pointAlong` answers the route rather than a straight line
// through it.
//
// Pure arithmetic, asserted directly because everything above reads it and a
// route with a zero-length leg in it (two waypoints authored on the same point,
// which a click in the editor can make) is the one input that could divide by
// nothing.
// ---------------------------------------------------------------------------
function caseRouteGeometry(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const l = buildMovePath([new Vec2(3, 0), new Vec2(3, -4)], false);
  check(`an L is measured along its legs (${l.total} m)`, l.total === 7);
  check("half way is on the first leg", pointAlong(l, 3).sub(new Vec2(3, 0)).length() < 1e-12);
  check("the corner is a waypoint", pointAlong(l, 5).sub(new Vec2(3, -2)).length() < 1e-12);
  check("before the start clamps to it", pointAlong(l, -10).length() === 0);
  check("past the end clamps to it", pointAlong(l, 99).sub(new Vec2(3, -4)).length() < 1e-12);

  const loop = buildMovePath([new Vec2(2, 0), new Vec2(2, -1), new Vec2(0, -1)], true);
  check(`a loop counts the leg home (${loop.total} m)`, loop.total === 6);
  check("a lap wraps to the start", pointAlong(loop, 6).length() < 1e-12);
  check("...and keeps wrapping", pointAlong(loop, 13).sub(new Vec2(1, 0)).length() < 1e-12);
  check("a negative distance wraps too", pointAlong(loop, -1).sub(new Vec2(0, -1)).length() < 1e-12);

  const dup = buildMovePath([new Vec2(1, 0), new Vec2(1, 0), new Vec2(2, 0)], false);
  check(`a repeated waypoint is passed through (${dup.total} m)`, dup.total === 2);
  check("...and does not divide by nothing", Number.isFinite(pointAlong(dup, 1).x));

  const none = buildMovePath([], false);
  check("an empty route is a body standing still", none.total === 0 && pointAlong(none, 5).length() === 0);

  return ok("route-geometry - a route is measured and walked along its legs", passed, details);
}

// ---------------------------------------------------------------------------
// determinism: the motion is a pure function of the frame number.
//
// The rule every mover script keeps and the reason a recorded replay can contain
// one at all: two builds of the same level, stepped the same number of frames,
// must agree to the bit - and the state must be a function of the FRAME rather
// than of the history, so a scene stepped straight to frame 600 is where one
// stepped a frame at a time got to.
// ---------------------------------------------------------------------------
function caseDeterminism(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const raw = swingLevel([
    pendulum(),
    {
      kind: "static",
      x: 500,
      y: 0,
      rot: 0,
      movePath: [{ x: 300, y: -200 }, { x: 0, y: -400 }],
      moveClosed: true,
      moveSpeed: 90,
      movePhase: 0.3,
      objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
    },
  ]);
  const a = new Scene(raw);
  const b = new Scene(raw);
  a.step(600);
  b.step(600);
  let worst = 0;
  for (let i = 0; i < a.movers.length; i++) {
    worst = Math.max(worst, a.mover(i).globalPosition.sub(b.mover(i).globalPosition).length());
    worst = Math.max(worst, Math.abs(a.mover(i).globalRotation - b.mover(i).globalRotation));
  }
  check(`two builds agree to the bit at frame 600 (${worst})`, worst === 0);

  // ...and the pose is the frame's, not the history's: the scripts are called
  // with `frame * dt` and nothing else, so a scene handed the same time lands in
  // the same place however it got there.
  const jumped = new Scene(raw);
  jumped.frame = 599;
  jumped.step();
  let worstJump = 0;
  for (let i = 0; i < a.movers.length; i++) {
    worstJump = Math.max(worstJump, a.mover(i).globalPosition.sub(jumped.mover(i).globalPosition).length());
    worstJump = Math.max(worstJump, Math.abs(a.mover(i).globalRotation - jumped.mover(i).globalRotation));
  }
  check(`the pose is a function of the frame, not the history (${worstJump})`, worstJump === 0);

  return ok("determinism - a mover's pose is arithmetic on the frame number", passed, details);
}

// ---------------------------------------------------------------------------
// authored: the fields are READ, scaled, and survive both round trips.
//
// The half nothing else can see. A build that ignored one of these produces a
// level that looks identical in a screenshot and plays differently; and the
// editor rewrites the whole file every 750 ms, so a field it drops is gone from
// disk before anybody notices it was read.
// ---------------------------------------------------------------------------
function caseAuthored(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const raw = swingLevel([
    pendulum(),
    {
      kind: "static",
      x: 500,
      y: 0,
      rot: 0,
      movePath: [{ x: 300, y: -200 }],
      moveSpeed: 90,
      movePhase: 0.3,
      moveEase: "easeOut",
      objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
    },
    // The control: a plain static, which must stay one.
    slab(0, 500, 400, 40),
  ]);
  const scene = new Scene(raw);
  check("a swinging body builds as a mover", scene.bodies[0]?.body instanceof AnimatableBody2D);
  check("a travelling body builds as a mover", scene.bodies[1]?.body instanceof AnimatableBody2D);
  check(
    "a plain static stays a plain static",
    scene.bodies[2]?.body instanceof StaticBody2D && !(scene.bodies[2]?.body instanceof AnimatableBody2D),
  );
  check(`both are in the mover list and nothing else is (${scene.movers.length})`, scene.movers.length === 2);

  // The scale: two angles, a time and a phase cross untouched; the route's
  // points and the speed are lengths and convert. Asserted as a round trip,
  // which is what a save does.
  const metres = scaleLevelData(raw, PX_FACTOR);
  const back = scaleLevelData(metres as RawLevelData, PIXELS_PER_METER);
  // `RawLevelData` admits the retired flat form too, so the round trip's answer
  // is narrowed back to the modern body these cases author.
  const src = raw.bodies[1] as LevelBodyData;
  const trip = back.bodies[1] as LevelBodyData;
  check(
    `the route survives px -> m -> px (${trip.movePath?.[0]?.x} of ${src.movePath?.[0]?.x})`,
    Math.abs((trip.movePath?.[0]?.x ?? 0) - (src.movePath?.[0]?.x ?? 0)) < 1e-9 &&
      Math.abs((trip.moveSpeed ?? 0) - (src.moveSpeed ?? 0)) < 1e-9,
  );
  check(
    `the pendulum's amplitude is an ANGLE and does not scale (${metres.bodies[0]?.swingAmp})`,
    metres.bodies[0]?.swingAmp === SWING_AMP && metres.bodies[0]?.swingPeriod === SWING_PERIOD,
  );
  check(
    `the phase and the ease cross untouched (${trip.movePhase}, ${trip.moveEase})`,
    trip.movePhase === 0.3 && trip.moveEase === "easeOut",
  );
  check(
    `the route's SPEED is a length per second and converts (${metres.bodies[1]?.moveSpeed?.toFixed(2)} m/s)`,
    Math.abs((metres.bodies[1]?.moveSpeed ?? 0) - 0.9) < 1e-9,
  );

  // ...and the editor's own round trip, which goes through a different shape
  // entirely and is the one a save actually takes.
  const model = modelFromDisk(raw);
  const saved = modelToDisk(model);
  const savedSwing = saved.bodies.find((b) => b.swingAmp !== undefined);
  const savedMove = saved.bodies.find((b) => b.movePath !== undefined);
  check(
    `the editor keeps the pendulum (${savedSwing?.swingAmp}, ${savedSwing?.swingPeriod} s)`,
    Math.abs((savedSwing?.swingAmp ?? 0) - SWING_AMP) < 1e-9 &&
      Math.abs((savedSwing?.swingPeriod ?? 0) - SWING_PERIOD) < 1e-9,
  );
  // Compared as the WORLD point rather than as the pair of numbers: the editor
  // legitimately re-origins a body onto its first object when it saves, so the
  // frame the bearing is written in is not the frame it was authored in and only
  // the point it resolves to is the thing that has to survive.
  const bearingWas = worldPlacement(raw.bodies[0] as LevelBodyData, { x: 0, y: 0 }).pos;
  const bearingNow = savedSwing
    ? worldPlacement(savedSwing, { x: savedSwing.pivotX ?? 0, y: savedSwing.pivotY ?? 0 }).pos
    : null;
  check(
    `...and its bearing lands on the same point (${bearingNow?.x.toFixed(3)}, ${bearingNow?.y.toFixed(3)})`,
    bearingNow !== null && bearingNow.sub(bearingWas).length() < 1e-6,
  );
  check(
    `the editor keeps the route (${savedMove?.movePath?.length} waypoints at ${savedMove?.moveSpeed} px/s, ${savedMove?.moveEase})`,
    savedMove?.movePath?.length === 1 &&
      Math.abs((savedMove?.moveSpeed ?? 0) - 90) < 1e-9 &&
      savedMove?.moveEase === "easeOut" &&
      Math.abs((savedMove?.movePhase ?? 0) - 0.3) < 1e-9,
  );
  const wasAt = worldPlacement(raw.bodies[1] as LevelBodyData, { x: 300, y: -200 }).pos;
  const nowAt =
    savedMove && savedMove.movePath?.[0]
      ? worldPlacement(savedMove, savedMove.movePath[0]).pos
      : null;
  check(
    `...at the waypoint it was authored at (${nowAt?.x.toFixed(3)}, ${nowAt?.y.toFixed(3)})`,
    nowAt !== null && nowAt.sub(wasAt).length() < 1e-6,
  );

  return ok("authored - every field is read, scaled and saved", passed, details);
}

// ---------------------------------------------------------------------------
// levels: the movers the registry actually ships stay under the contact-speed
// bar the mover contract states.
//
// A mover that outruns it is not a bug in the mover, it is a bug in the LEVEL -
// the character sweep resolves against a surface that has already crossed the
// avatar - and it is invisible until somebody plays that corner of that level.
// Measured as the fastest any point of the body's own outline travels in a
// frame, which is what a rider actually meets.
// ---------------------------------------------------------------------------
// Every point of a body a rider can actually meet: the corners of its vertex
// shapes, in the order the shape set gives them, plus the centre of a circle
// (whose fastest point is its centre's speed plus its own spin, and no shipped
// mover is one). Measured rather than bounded, because a bound that overstates a
// rotation by the shape's half-diagonal fails levels that are within the rule.
function surfacePoints(body: AnimatableBody2D): Vec2[] {
  const points: Vec2[] = [];
  for (const s of body.getShapes()) {
    let any = false;
    for (let i = 0; ; i++) {
      const v = s.globalVertex(i);
      if (!v) break;
      points.push(v);
      any = true;
    }
    if (!any) points.push(s.globalPosition);
  }
  return points;
}

function caseLevels(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  // Two centimetres a frame, the figure `MoverScript` states.
  const BAR = 0.02;
  let found = 0;
  for (const [name, spec] of Object.entries(LEVELS)) {
    const scene = new Scene(spec.data);
    if (!scene.movers.length) continue;
    found++;
    let worst = 0;
    let worstAt = "";
    // 20 s, which covers a whole cycle of anything worth authoring.
    for (let f = 0; f < 1200; f++) {
      const before = scene.movers.map((m) => surfacePoints(m.body));
      scene.step();
      scene.movers.forEach((m, i) => {
        const after = surfacePoints(m.body);
        after.forEach((p, k) => {
          const moved = p.sub(before[i]![k]!).length();
          if (moved > worst) {
            worst = moved;
            worstAt = `${name} mover ${i}`;
          }
        });
      });
    }
    check(
      `${name}: fastest surface ${(worst * 100).toFixed(2)} cm/frame of ${BAR * 100} (${worstAt})`,
      worst <= BAR,
    );
  }
  check(`the registry ships movers to check (${found} levels)`, found > 0);

  return ok("levels - every shipped mover stays under the contact-speed bar", passed, details);
}

export function runMoverCases(): MoverResult[] {
  return [
    caseSwingArc(),
    caseSwingPhase(),
    caseInherit(),
    caseUndisturbable(),
    caseRider(),
    caseShuttle(),
    caseLoop(),
    caseEase(),
    caseMovePhase(),
    caseRouteGeometry(),
    caseDeterminism(),
    caseAuthored(),
    caseLevels(),
  ];
}
