// Scripted-mover cases: the two motions a level FILE can author, run by
// `cli movers`.
//
// A mover is a body the level drives rather than one the sim solves - a
// pendulum on a bearing (`LevelBodyData.swingAmp`) and a body travelling a route
// (`moveNodes`) - so, like the spring body, its whole behaviour has a closed
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
//
// Several cases below deliberately author the RETIRED `movePath` / `moveClosed`
// form rather than `moveNodes` / `moveMode`. That is not laziness left over from
// the rewrite: it means the shuttle, the lap, the phase and the rider are all
// measured THROUGH the fold in `scaleLevelData`, so a fold that quietly stopped
// working would take them all red rather than being covered only by the one
// case that is about it. `legacy` is that case, and asserts the two forms play
// bit-identically.

import { Vec2 } from "../engine/vec2";
import { AnimatableBody2D, RigidBody2D, StaticBody2D } from "../engine/body";
import { rectShape } from "../engine/shapes";
import { World } from "../engine/world";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { PX as PX_FACTOR, PIXELS_PER_METER } from "../engine/units";
import { buildLevelBodies, worldPlacement } from "../level/buildBodies";
import {
  scaleLevelData,
  type LevelBodyData,
  type MoveMode,
  type RawLevelData,
} from "../level/levelFormat";
import { TANGENT_WINDOW } from "../lib/path";
import { keyValueAt } from "../lib/keyframes";
import {
  buildMoveRoute,
  easeFraction,
  moveAngleAt,
  moveDistanceAt,
  pointAlong,
  type MoveRoute,
} from "../level/movers";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { LEVELS } from "../level/registry";

const DT = 1 / 60;

// The route these cases build by hand: the body as node zero, then the given
// waypoints as plain corners at a plain speed. The retired `buildMovePath`'s
// shape, so every case written against that reads unchanged, and the one place
// the new node form is spelled out for a test.
function route(
  waypoints: readonly Vec2[],
  mode: MoveMode = "backAndForth",
  speed = 1,
  keys: { rot?: (number | undefined)[]; speed?: (number | undefined)[] } = {},
): MoveRoute {
  const pts = [Vec2.ZERO, ...waypoints];
  return buildMoveRoute(
    pts.map((p) => ({ p, in: Vec2.ZERO, out: Vec2.ZERO })),
    mode,
    0,
    speed,
    keys.rot ?? pts.map(() => undefined),
    keys.speed ?? pts.map(() => undefined),
  );
}

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
      // The pose the renderer interpolates FROM, snapshotted before anything
      // moves - where both level drivers take it, and the only place a mover's
      // drawn position can be judged from (see `captureRenderTransform`).
      this.world.captureRenderTransforms();
      for (const m of this.movers) {
        m.body.beginMove();
        m.script(m.body, time, DT);
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
  const path = route([new Vec2(4, 0)]);
  for (const ease of ["linear", "sine", "easeIn", "easeOut"] as const) {
    const atEnd = moveDistanceAt(path, 0, ease, 4);
    const atStart = moveDistanceAt(path, 0, ease, 0);
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

  const open = route([new Vec2(4, 0)]);
  check(
    `half a cycle is the far end of a shuttle (${moveDistanceAt(open, 0.5, "linear", 0).toFixed(4)} m of 4)`,
    Math.abs(moveDistanceAt(open, 0.5, "linear", 0) - 4) < 1e-9,
  );
  check(
    `a whole one is the start again (${moveDistanceAt(open, 1, "linear", 0).toFixed(4)} m)`,
    Math.abs(moveDistanceAt(open, 1, "linear", 0)) < 1e-9,
  );
  const closed = route([new Vec2(2, 0), new Vec2(2, -1), new Vec2(0, -1)], "loop");
  check(`a closed route's journey is its perimeter (${closed.total} m)`, Math.abs(closed.total - 6) < 1e-12);
  check(
    `half a cycle is half way round a loop (${moveDistanceAt(closed, 0.5, "linear", 0).toFixed(4)} m of 6)`,
    Math.abs(moveDistanceAt(closed, 0.5, "linear", 0) - 3) < 1e-9,
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

  const l = route([new Vec2(3, 0), new Vec2(3, -4)]);
  check(`an L is measured along its legs (${l.total} m)`, l.total === 7);
  check("half way is on the first leg", pointAlong(l, 3).sub(new Vec2(3, 0)).length() < 1e-12);
  check("the corner is a waypoint", pointAlong(l, 5).sub(new Vec2(3, -2)).length() < 1e-12);
  check("before the start clamps to it", pointAlong(l, -10).length() === 0);
  check("past the end clamps to it", pointAlong(l, 99).sub(new Vec2(3, -4)).length() < 1e-12);

  const loop = route([new Vec2(2, 0), new Vec2(2, -1), new Vec2(0, -1)], "loop");
  check(`a loop counts the leg home (${loop.total} m)`, loop.total === 6);
  check("a lap wraps to the start", pointAlong(loop, 6).length() < 1e-12);
  check("...and keeps wrapping", pointAlong(loop, 13).sub(new Vec2(1, 0)).length() < 1e-12);
  check("a negative distance wraps too", pointAlong(loop, -1).sub(new Vec2(0, -1)).length() < 1e-12);

  const dup = route([new Vec2(1, 0), new Vec2(1, 0), new Vec2(2, 0)]);
  check(`a repeated waypoint is passed through (${dup.total} m)`, dup.total === 2);
  check("...and does not divide by nothing", Number.isFinite(pointAlong(dup, 1).x));

  const none = route([]);
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
// spin: a rotor turns at its authored rate, for ever, about a bearing that does
// not move - and nothing in the level has an opinion about any of it.
//
// Five claims, and the middle one is the one that is about the design rather
// than about the arithmetic:
//
//   - the angle is exactly `2π · (t/period + phase)`, and the bearing is
//     asserted at `=== 0` drift for the pendulum's reason: the body is mounted
//     ON it, so the script writes a rotation and nothing else;
//   - the sign of the period is the DIRECTION, and a rotor authored at -P is the
//     mirror of one at +P to the bit;
//   - THE LAP HAS NO SEAM. The rotation is a running total rather than an angle
//     wrapped into a turn, so the frame on which the body passes its start is
//     the same small step as every other frame - which is what the contact
//     velocities derived from the transform delta and the renderer interpolating
//     across the frame both need. Measured as the worst per-frame angular
//     velocity across several laps against the constant the rate implies;
//   - an authored bearing is the point that holds still, so a sail bolted at its
//     end sweeps its whole length rather than wagging about its middle;
//   - and a lead boulder dropped on it changes the turn by nothing.
// ---------------------------------------------------------------------------
const SPIN_PERIOD = 8;

function rotor(opts: { period?: number; phase?: number; x?: number; atEnd?: boolean } = {}): RawLevelData["bodies"][number] {
  return {
    kind: "static",
    x: opts.x ?? 0,
    y: 0,
    rot: 0,
    spinPeriod: opts.period ?? SPIN_PERIOD,
    ...(opts.phase !== undefined ? { spinPhase: opts.phase } : {}),
    // A bearing at the body's own origin makes it a sail bolted at its end; with
    // none, the origin is the centre of mass `mountPieces` placed there, which
    // is a bar turning about its middle.
    ...(opts.atEnd ? { pivotX: 0, pivotY: 0 } : {}),
    objects: [
      {
        type: "collision",
        x: opts.atEnd ? 100 : 0,
        y: 0,
        rot: 0,
        shape: { kind: "rect", w: 200, h: 16 },
      },
    ],
  };
}

function caseSpin(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  // Three laps and a quarter, so the seam is crossed three times.
  const FRAMES = Math.round((SPIN_PERIOD * 3.25) / DT);
  const scene = new Scene(swingLevel([rotor(), rotor({ period: -SPIN_PERIOD, x: 400 })]));
  const body = scene.mover();
  const bearing = body.globalPosition;
  const rate = (2 * Math.PI) / SPIN_PERIOD;
  let worstAngle = 0;
  let worstBearing = 0;
  let worstStep = 0;
  let worstMirror = 0;
  for (let f = 1; f <= FRAMES; f++) {
    const was = body.globalRotation;
    scene.step();
    const want = rate * (f * DT);
    worstAngle = Math.max(worstAngle, Math.abs(body.globalRotation - want));
    worstBearing = Math.max(worstBearing, body.globalPosition.sub(bearing).length());
    // The per-frame step, taken off the transform rather than off the clock:
    // this is the number a rider and the interpolator actually see, and a
    // wrapped angle would make one frame of every lap a whole turn of it.
    worstStep = Math.max(worstStep, Math.abs(body.globalRotation - was - rate * DT));
    worstMirror = Math.max(
      worstMirror,
      Math.abs(body.globalRotation + scene.mover(1).globalRotation),
    );
  }
  check(`the rotor stands where the rate says (worst ${worstAngle.toExponential(1)} rad)`, worstAngle < 1e-9);
  check(`...having gone round more than three times (${(body.globalRotation / (2 * Math.PI)).toFixed(2)} turns)`, body.globalRotation > 3 * 2 * Math.PI);
  check(`its bearing does not move at all (${worstBearing} m)`, worstBearing === 0);
  check(
    `every frame of every lap is the same step - no seam (worst ${worstStep.toExponential(1)} rad)`,
    worstStep < 1e-9,
  );
  check(
    `a negative period is the same turn the other way, to the bit (${worstMirror} rad)`,
    worstMirror === 0,
  );
  // ...and the contact velocity the rider meets is that rate at the rim, which
  // is the half of the seam claim that leaves the body.
  const rim = body.globalPosition.add(new Vec2(1, 0));
  check(
    `the rim hands out ω × r (${body.velocityAtPoint(rim).y.toFixed(4)} m/s of ${rate.toFixed(4)})`,
    Math.abs(body.velocityAtPoint(rim).y - rate) < 1e-6,
  );

  // The PHASE, in cycles: a rotor authored at 0.25 stands a quarter turn on from
  // the pose the file drew, and its whole motion is the unphased one a quarter
  // of a period early. The second half is the claim that matters - a phase that
  // was only an offset at spawn would be a rotor that drifts back into step.
  const phased = new Scene(swingLevel([rotor({ phase: 0.25 })]));
  const plain = new Scene(swingLevel([rotor()]));
  check(
    `a phase of 0.25 starts a quarter turn on (${(phased.mover().globalRotation / (2 * Math.PI)).toFixed(4)} turns)`,
    Math.abs(phased.mover().globalRotation - Math.PI / 2) < 1e-12,
  );
  const LEAD = Math.round(SPIN_PERIOD / 4 / DT);
  plain.step(LEAD);
  let worstPhase = 0;
  for (let f = 0; f < 600; f++) {
    phased.step();
    plain.step();
    worstPhase = Math.max(
      worstPhase,
      Math.abs(phased.mover().globalRotation - plain.mover().globalRotation),
    );
  }
  check(
    `...and stays exactly a quarter of a period ahead for ever (${worstPhase.toExponential(1)} rad)`,
    worstPhase < 1e-9,
  );

  // The authored bearing: a sail bolted at its END sweeps its whole length, so
  // the far tip traces a circle of the bar's length rather than of half of it,
  // and the near end stands still.
  const sail = new Scene(swingLevel([rotor({ atEnd: true })]));
  const hinge = sail.mover().globalPosition;
  let farthest = 0;
  let nearest = Infinity;
  for (let f = 0; f < Math.round(SPIN_PERIOD / DT); f++) {
    sail.step();
    for (const p of surfacePoints(sail.mover())) {
      farthest = Math.max(farthest, p.sub(hinge).length());
      nearest = Math.min(nearest, p.sub(hinge).length());
    }
  }
  check(
    `a sail on an authored bearing sweeps its whole length (${farthest.toFixed(3)} m of 2.00)`,
    Math.abs(farthest - Math.hypot(2, 0.08)) < 1e-6,
  );
  check(
    `...and its hinged end stays on the hinge (${nearest.toFixed(3)} m)`,
    Math.abs(nearest - 0.08) < 1e-6,
  );

  // Undisturbable, the rotor's own version of the claim: a rotor is not a
  // `pivot` rigid spun up, so a weight landing on it does not slow it.
  const boulder: RawLevelData["bodies"][number] = {
    kind: "rigid",
    x: 0,
    y: -300,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "circle", r: 60 }, material: "lead" }],
  };
  const alone = new Scene(swingLevel([rotor()]));
  const laden = new Scene(swingLevel([rotor(), boulder]));
  let worstLaden = 0;
  for (let f = 0; f < 600; f++) {
    alone.step();
    laden.step();
    worstLaden = Math.max(
      worstLaden,
      Math.abs(alone.mover().globalRotation - laden.mover().globalRotation),
    );
  }
  check(`a lead boulder dropped on it slows it by nothing (${worstLaden} rad)`, worstLaden === 0);

  return ok("spin - a rotor keeps its own beat, round and round", passed, details);
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
    // A rotor, authored the way one usually is: a negative period, so the
    // SIGN has to survive every gate below as well as the magnitude.
    rotor({ period: -6, phase: 0.2, x: 1000 }),
    // The control: a plain static, which must stay one.
    slab(0, 500, 400, 40),
  ]);
  const scene = new Scene(raw);
  check("a swinging body builds as a mover", scene.bodies[0]?.body instanceof AnimatableBody2D);
  check("a travelling body builds as a mover", scene.bodies[1]?.body instanceof AnimatableBody2D);
  check("a spinning body builds as a mover", scene.bodies[2]?.body instanceof AnimatableBody2D);
  check(
    "a plain static stays a plain static",
    scene.bodies[3]?.body instanceof StaticBody2D && !(scene.bodies[3]?.body instanceof AnimatableBody2D),
  );
  check(`all three are in the mover list and nothing else is (${scene.movers.length})`, scene.movers.length === 3);

  // The scale: two angles, a time and a phase cross untouched; the route's
  // points and the speed are lengths and convert. Asserted as a round trip,
  // which is what a save does.
  const metres = scaleLevelData(raw, PX_FACTOR);
  const back = scaleLevelData(metres as RawLevelData, PIXELS_PER_METER);
  // `RawLevelData` admits the retired flat form too, so the round trip's answer
  // is narrowed back to the modern body these cases author.
  const src = raw.bodies[1] as LevelBodyData;
  const trip = back.bodies[1] as LevelBodyData;
  // The retired `movePath` is FOLDED into `moveNodes` at this gate, with the
  // body prepended as node zero - so what has to survive is the authored
  // waypoint, now at index 1.
  check(
    `the route survives px -> m -> px (${trip.moveNodes?.[1]?.x} of ${src.movePath?.[0]?.x})`,
    trip.moveNodes?.length === 2 &&
      Math.abs((trip.moveNodes?.[1]?.x ?? 0) - (src.movePath?.[0]?.x ?? 0)) < 1e-9 &&
      Math.abs((trip.moveNodes?.[0]?.x ?? 9) - 0) < 1e-12 &&
      Math.abs((trip.moveSpeed ?? 0) - (src.moveSpeed ?? 0)) < 1e-9,
  );
  check(
    `...and the retired fields are gone with it (${trip.movePath}, ${trip.moveClosed})`,
    trip.movePath === undefined && trip.moveClosed === undefined,
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
    `the rotor's period is a TIME and its phase an angle, so neither scales (${metres.bodies[2]?.spinPeriod} s, ${metres.bodies[2]?.spinPhase})`,
    metres.bodies[2]?.spinPeriod === -6 && metres.bodies[2]?.spinPhase === 0.2,
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
  const savedMove = saved.bodies.find((b) => b.moveNodes !== undefined);
  const savedSpin = saved.bodies.find((b) => b.spinPeriod !== undefined);
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
    `the editor keeps the rotor, sign and all (${savedSpin?.spinPeriod} s, phase ${savedSpin?.spinPhase})`,
    Math.abs((savedSpin?.spinPeriod ?? 0) + 6) < 1e-9 && Math.abs((savedSpin?.spinPhase ?? 0) - 0.2) < 1e-9,
  );
  check(
    `the editor keeps the route (${savedMove?.moveNodes?.length} nodes at ${savedMove?.moveSpeed} px/s, ${savedMove?.moveEase})`,
    savedMove?.moveNodes?.length === 2 &&
      Math.abs((savedMove?.moveSpeed ?? 0) - 90) < 1e-9 &&
      savedMove?.moveEase === "easeOut" &&
      Math.abs((savedMove?.movePhase ?? 0) - 0.3) < 1e-9,
  );
  // A route of plain corners writes NO handles and NO keys, which is what keeps
  // a level authored before curves byte-identical through a save.
  check(
    "a route of corners writes no handles and no keys",
    (savedMove?.moveNodes ?? []).every(
      (n) =>
        n.inX === undefined &&
        n.inY === undefined &&
        n.outX === undefined &&
        n.outY === undefined &&
        n.rot === undefined &&
        n.speed === undefined,
    ),
  );
  const wasAt = worldPlacement(raw.bodies[1] as LevelBodyData, { x: 300, y: -200 }).pos;
  const nowAt =
    savedMove && savedMove.moveNodes?.[1]
      ? worldPlacement(savedMove, savedMove.moveNodes[1]).pos
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
// An angle folded into (-π, π], so a turn measured across the seam of a lap is
// the turn and not the branch cut.
function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

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
        // A `repeat`'s wrap is a TELEPORT, and the bar is about how fast a
        // surface CROSSES a frame - a body that jumped did not cross anything,
        // it stopped being where it was. Measuring the jump would make the bar
        // unmeetable for the mode rather than informative about it. (What the
        // jump does cost an author is real and is not this: a carrier landing
        // on top of the player pushes them out, so the start of a repeat is a
        // place to keep clear.)
        if (m.body.jumped) return;
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


// ---------------------------------------------------------------------------
// repeat: a route travelled once and started again, with the way home a
// TELEPORT rather than a return leg.
//
// Three claims, and the last is the one that makes it usable. The body runs the
// route in one direction (never backwards, which is what separates it from a
// shuttle); it is back at the start on the frame after it reaches the end; and
// the jump imparts NO contact velocity, because a jump is not motion - read off
// the transform delta it would be tens of metres a second thrown for one frame
// at whatever is standing on it.
// ---------------------------------------------------------------------------
function caseRepeat(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const r = route([new Vec2(4, 0)], "repeat");
  check(`a repeat's cycle is ONE traverse (${r.traverse} s of 4)`, Math.abs(r.traverse - 4) < 1e-12);
  check(
    `half a cycle is half way along (${moveDistanceAt(r, 0, "linear", 2).toFixed(4)} m of 4)`,
    Math.abs(moveDistanceAt(r, 0, "linear", 2) - 2) < 1e-9,
  );
  // ...and one cycle on is back at the start rather than at the far end, which
  // is the whole difference from a shuttle.
  check(
    `a whole cycle is the START again (${moveDistanceAt(r, 0, "linear", 4).toFixed(4)} m)`,
    Math.abs(moveDistanceAt(r, 0, "linear", 4)) < 1e-9,
  );
  // Forward everywhere but the wrap, which is the whole difference from a
  // shuttle: two runs of a 4 s route over 8 s must step back exactly twice, at
  // the two ends, and nowhere in between.
  let backwards = 0;
  let prev = moveDistanceAt(r, 0, "linear", 0);
  for (let f = 1; f <= Math.round(8 / DT); f++) {
    const d = moveDistanceAt(r, 0, "linear", f * DT);
    if (d < prev) backwards++;
    prev = d;
  }
  check(`it only goes back at the wrap (${backwards} steps back over 2 runs)`, backwards === 2);

  // The level's own answer, and the contact velocity across the wrap.
  const scene = new Scene(
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        moveNodes: [{ x: 0, y: 0 }, { x: 400, y: 0 }],
        moveMode: "repeat",
        moveSpeed: 100,
        objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
      },
    ]),
  );
  const body = scene.mover();
  let far = 0;
  let jumped = false;
  let worstJumpSpeed = 0;
  let travellingSpeed = 0;
  for (let f = 1; f <= Math.round(5 / DT); f++) {
    const was = body.globalPosition.x;
    scene.step();
    const now = body.globalPosition.x;
    far = Math.max(far, now);
    if (now < was - 1e-9) {
      jumped = true;
      worstJumpSpeed = Math.max(worstJumpSpeed, body.linearVelocity.length());
    } else {
      travellingSpeed = Math.max(travellingSpeed, body.linearVelocity.length());
    }
  }
  check(`it reaches the far end (${far.toFixed(3)} m of 4)`, Math.abs(far - 4) < 0.02);
  check("...and jumps home rather than turning round", jumped);
  check(
    `the jump imparts no contact velocity (${worstJumpSpeed.toFixed(4)} m/s, travelling ${travellingSpeed.toFixed(2)})`,
    worstJumpSpeed === 0 && Math.abs(travellingSpeed - 1) < 1e-6,
  );

  // ...and it is not DRAWN travelling either. The renderer interpolates between
  // the pose captured at the top of the step and the one the step ended at, so a
  // jump left uncaptured draws the platform sliding the length of its run over
  // the one frame it went home - seen mid-level, where it never was
  // (`session-439f`). Half way through the step is the frame's worst case.
  const drawn = new Scene(
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        moveNodes: [{ x: 0, y: 0 }, { x: 400, y: 0 }],
        moveMode: "repeat",
        moveSpeed: 100,
        objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
      },
    ]),
  );
  const platform = drawn.mover();
  let worstDrawn = 0;
  let drewBetween = false;
  for (let f = 1; f <= Math.round(5 / DT); f++) {
    const was = platform.globalPosition.x;
    drawn.step();
    const now = platform.globalPosition.x;
    const mid = platform.renderPosition(0.5).x;
    if (now < was - 1e-9) worstDrawn = Math.max(worstDrawn, Math.abs(mid - now));
    else if (Math.abs(mid - now) > 1e-6) drewBetween = true;
  }
  check(`the jump is not drawn as a slide home (${(worstDrawn * 100).toFixed(2)} cm from where it landed)`,
    worstDrawn === 0);
  check("...while a travelling frame is still interpolated", drewBetween);

  // A body ON it is left where it stood rather than flung after it: the whole
  // reason the frame's velocity is zeroed instead of derived.
  const rider = new Scene({
    player: { x: -1000, y: 0, radius: 8 },
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        moveNodes: [{ x: 0, y: 0 }, { x: 300, y: 0 }],
        moveMode: "repeat",
        moveSpeed: 100,
        objects: [{ type: "collision", shape: { kind: "rect", w: 400, h: 24 } }],
      },
      {
        kind: "rigid",
        x: 0,
        y: -40,
        rot: 0,
        objects: [{ type: "collision", shape: { kind: "rect", w: 40, h: 40 } }],
      },
    ],
  });
  const crate = rider.bodies[1]!.body as RigidBody2D;
  let worstFling = 0;
  for (let f = 1; f <= Math.round(4 / DT); f++) {
    rider.step();
    worstFling = Math.max(worstFling, Math.abs(crate.linearVelocity.x));
  }
  check(
    `a rider is never flung by the wrap (${worstFling.toFixed(3)} m/s, carried at 1)`,
    worstFling < 1.5,
  );

  return ok("repeat - a route run once and started again, with a teleport home", passed, details);
}

// ---------------------------------------------------------------------------
// curves: a route's nodes carry Bezier tangent handles, and the whole of what
// they cost is the flattening.
//
// The claims are the camera path's own, restated where it matters here: a route
// of corners is bit-identical to the polyline it was, a bowed leg is LONGER than
// its chord and the body actually travels the bow, and the arc length the motion
// is expressed in is the curve's rather than the node hull's.
// ---------------------------------------------------------------------------
function caseCurves(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const corners = route([new Vec2(3, 0), new Vec2(3, -4)]);
  check(`a route of corners is its own legs (${corners.total} m)`, corners.total === 7);

  // One leg bowed out by a pair of handles a metre long each way. A cubic never
  // strays outside its control polygon, so the arc is between the chord and the
  // polygon - longer than 4, shorter than the 6 the polygon walks.
  const bowed = buildMoveRoute(
    [
      { p: Vec2.ZERO, in: Vec2.ZERO, out: new Vec2(0, -2) },
      { p: new Vec2(4, 0), in: new Vec2(0, -2), out: Vec2.ZERO },
    ],
    "backAndForth",
    0,
    1,
    [undefined, undefined],
    [undefined, undefined],
  );
  check(
    `a bowed leg is longer than its chord (${bowed.total.toFixed(3)} m, chord 4)`,
    bowed.total > 4.3 && bowed.total < 8,
  );
  // ...and the body is genuinely off the chord half way along, which a
  // flattening that ignored the handles could not produce.
  const mid = pointAlong(bowed, bowed.total / 2);
  check(
    `half way along is off the chord (${mid.x.toFixed(3)}, ${mid.y.toFixed(3)})`,
    Math.abs(mid.x - 2) < 0.05 && mid.y < -1.4,
  );
  // The chordal error against the true cubic, which is what a route's precision
  // ultimately means: every flattened point is on the curve by construction, so
  // what is measured is the worst SAG of a chord between two of them.
  let worstSag = 0;
  for (let i = 0; i + 1 < bowed.index.verts.length; i++) {
    const a = bowed.index.verts[i]!;
    const b = bowed.index.verts[i + 1]!;
    const t = (bowed.index.cum[i]! + bowed.index.cum[i + 1]!) / 2;
    worstSag = Math.max(worstSag, pointAlong(bowed, t).sub(a.add(b).mul(0.5)).length());
  }
  check(`the flattening holds the curve to a millimetre (${(worstSag * 1000).toFixed(2)} mm)`, worstSag < 0.001);

  // A loop's closing leg is a Bezier edge like any other: handles on node zero's
  // `in` and the last node's `out` bow the way home rather than being ignored.
  const straightHome = buildMoveRoute(
    [
      { p: Vec2.ZERO, in: Vec2.ZERO, out: Vec2.ZERO },
      { p: new Vec2(4, 0), in: Vec2.ZERO, out: Vec2.ZERO },
      { p: new Vec2(4, -3), in: Vec2.ZERO, out: Vec2.ZERO },
    ],
    "loop",
    0,
    1,
    [undefined, undefined, undefined],
    [undefined, undefined, undefined],
  );
  const bowedHome = buildMoveRoute(
    [
      { p: Vec2.ZERO, in: new Vec2(0, 2), out: Vec2.ZERO },
      { p: new Vec2(4, 0), in: Vec2.ZERO, out: Vec2.ZERO },
      { p: new Vec2(4, -3), in: Vec2.ZERO, out: new Vec2(0, 2) },
    ],
    "loop",
    0,
    1,
    [undefined, undefined, undefined],
    [undefined, undefined, undefined],
  );
  check(`a lap of corners is its perimeter (${straightHome.total.toFixed(3)} m of 12)`, Math.abs(straightHome.total - 12) < 1e-9);
  check(
    `...and the closing leg takes its handles (${bowedHome.total.toFixed(3)} m)`,
    bowedHome.total > straightHome.total + 0.2,
  );

  return ok("curves - a route's legs are cubics and its arc length is the curve's", passed, details);
}

// ---------------------------------------------------------------------------
// keys: a node keys the body's ANGLE and its SPEED where it stands, and the
// value between two of them is eased by arc length.
//
// The minecart, in other words: it noses over on the descent and runs away down
// it. The load-bearing claim is the speed one, because keying a speed turns the
// trip time from a division into an integral - and doing that has to leave a
// route that keys NONE of them at exactly the arithmetic it had.
// ---------------------------------------------------------------------------
function caseKeys(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  // ANGLE. Two nodes 4 m apart, keyed 0 and 90 degrees.
  const turned = route([new Vec2(4, 0)], "backAndForth", 1, { rot: [0, Math.PI / 2] });
  check(`a rot key is the angle at its node (${moveAngleAt(turned, false, 4).toFixed(4)} rad)`,
    Math.abs(moveAngleAt(turned, false, 0)) < 1e-12 &&
      Math.abs(moveAngleAt(turned, false, 4) - Math.PI / 2) < 1e-9);
  // Smoothstepped between them: half way is half the turn, and the rate is FLAT
  // at each key - which is what stops a keyed angle putting a step in the
  // body's angular velocity where a node sits.
  const half = moveAngleAt(turned, false, 2);
  check(`half way is half the turn (${half.toFixed(4)} of ${(Math.PI / 4).toFixed(4)})`,
    Math.abs(half - Math.PI / 4) < 1e-9);
  const rateAtKey = (moveAngleAt(turned, false, 0.004) - moveAngleAt(turned, false, 0)) / 0.004;
  const rateAtMid = (moveAngleAt(turned, false, 2.004) - moveAngleAt(turned, false, 2)) / 0.004;
  check(`the turn is flat at a key and steepest between (${rateAtKey.toFixed(4)} vs ${rateAtMid.toFixed(3)})`,
    rateAtKey < 0.01 && rateAtMid > 0.5);
  // Past the last key and before the first it HOLDS: there is nothing beyond the
  // ends of a route to blend toward.
  check("past the last key it holds", Math.abs(moveAngleAt(turned, false, 99) - Math.PI / 2) < 1e-9);

  // ALIGN, which is the same angle taken from the route's own tangent - as the
  // TURN since the route's start, so the body leaves its drawn angle the way it
  // leaves its drawn position.
  const corner = route([new Vec2(4, 0), new Vec2(4, -4)]);
  check(`aligned, the body starts at the angle it was drawn at (${moveAngleAt(corner, true, 0).toFixed(6)})`,
    Math.abs(moveAngleAt(corner, true, 0)) < 1e-12);
  // ...on a SLOPED start too, which is the half the absolute form got wrong: a
  // platform drawn flat and sent off down a slope (or, the case that shows it,
  // sent LEFT) is asked to travel, not to be re-aimed, and an absolute tangent
  // answers -45 here and 180 for the leftward one - a body arriving upside down
  // having been told only where to go. Red against that implementation, which
  // answers -45 and -180 rather than 0.
  const sloped = route([new Vec2(4, -4), new Vec2(8, -4)]);
  check(`...along a SLOPED start too (${((moveAngleAt(sloped, true, 0) * 180) / Math.PI).toFixed(1)}° of 0)`,
    Math.abs(moveAngleAt(sloped, true, 0)) < 1e-12);
  const leftward = route([new Vec2(-4, 0)]);
  check(`...and sent LEFT it travels rather than flips (${((moveAngleAt(leftward, true, 2) * 180) / Math.PI).toFixed(1)}° of 0)`,
    Math.abs(moveAngleAt(leftward, true, 2)) < 1e-12);
  // What the route TURNS is still the route's own turn: the sloped start levels
  // out over its second leg, which is 45 degrees of turn from where it set off.
  check(`...and turns by what the track turns (${((moveAngleAt(sloped, true, sloped.total) * 180) / Math.PI).toFixed(1)}° of 45)`,
    Math.abs(moveAngleAt(sloped, true, sloped.total) - Math.PI / 4) < 1e-9);
  check(`...and has turned a right angle down the far leg (${moveAngleAt(corner, true, 8).toFixed(4)})`,
    Math.abs(Math.abs(moveAngleAt(corner, true, 8)) - Math.PI / 2) < 1e-9);
  // ...and it turns GRADUALLY. The tangent is the chord across a window rather
  // than a segment's own direction, so a corner is spread over half a metre of
  // track instead of landing entirely on the frame the body crosses a vertex -
  // which read off the segments is a 90 degree step in one frame, and is what
  // this is red against.
  let worstStep = 0;
  for (let x = 0; x < corner.total; x += 0.01) {
    const step = moveAngleAt(corner, true, Math.min(x + 0.01, corner.total)) - moveAngleAt(corner, true, x);
    worstStep = Math.max(worstStep, Math.abs(step));
  }
  check(`...gradually, over the corner rather than at it (${((worstStep * 180) / Math.PI).toFixed(2)}° per cm)`,
    worstStep < 0.05);
  // The turn really does happen AROUND the corner: a quarter-metre before it the
  // body has begun turning, and a quarter-metre after it is nearly done.
  const before = Math.abs(moveAngleAt(corner, true, 4 - TANGENT_WINDOW / 2));
  const after = Math.abs(moveAngleAt(corner, true, 4 + TANGENT_WINDOW));
  check(`...and around the corner rather than along the leg (${((before * 180) / Math.PI).toFixed(1)}° before, ${((after * 180) / Math.PI).toFixed(1)}° after)`,
    before > 0.05 && after > Math.PI / 2 - 1e-9);
  check("unaligned and unkeyed, it never turns at all",
    moveAngleAt(corner, false, 0) === 0 && moveAngleAt(corner, false, 6) === 0);

  // A LOOP has no ends, so the tangent window must not clamp at them. Clamped,
  // the seam frame reads two one-sided chords over opposite halves of the
  // window: the aligned body holds one angle all the way round and then turns
  // the route's whole turn across the window in a single frame, which is a kick
  // handed to whatever is riding it. A circle is the case that shows it, since
  // there every point of the lap is the same as every other and the seam has no
  // right to be different.
  const R = 2;
  const K = (4 / 3) * Math.tan(Math.PI / 8); // the cubic circle's handle length
  const circle = buildMoveRoute(
    [0, 1, 2, 3].map((i) => {
      const a = (i * Math.PI) / 2;
      const p = new Vec2(Math.cos(a) * R, Math.sin(a) * R);
      const t = new Vec2(-Math.sin(a), Math.cos(a)).mul(K * R);
      return { p, in: t.neg(), out: t };
    }),
    "loop",
    0,
    1,
    [undefined, undefined, undefined, undefined],
    [undefined, undefined, undefined, undefined],
  );
  check(`a cubic circle laps its circumference (${circle.total.toFixed(4)} m of ${(2 * Math.PI * R).toFixed(4)})`,
    Math.abs(circle.total - 2 * Math.PI * R) < 0.01);
  // Round the lap in 1 cm steps and take the worst turn in any one of them. On a
  // circle every step should turn by the same tiny amount.
  let worstLap = 0;
  const step = 0.01;
  for (let x = 0; x + step <= circle.total; x += step) {
    worstLap = Math.max(
      worstLap,
      Math.abs(wrapPi(moveAngleAt(circle, true, x + step) - moveAngleAt(circle, true, x))),
    );
  }
  const ideal = step / R;
  check(`...and an aligned body turns evenly round it (worst ${(worstLap / ideal).toFixed(2)}x ideal)`,
    worstLap < ideal * 2);
  // ...and the SEAM is one of those steps rather than a special place. The sim
  // reaches it by wrapping - `moveDistanceAt` runs the arc length back to 0 -
  // so the step to measure is from just before `total` to just after 0, which a
  // monotone scan up the route never crosses. A clamped window answers the
  // one-sided chord at each end and the two differ by the route's turn across
  // the WHOLE window, so the body turns 25 cm of circle in one frame.
  const eps = step / 2;
  const seam = Math.abs(
    wrapPi(moveAngleAt(circle, true, eps) - moveAngleAt(circle, true, circle.total - eps)),
  );
  check(`...the SEAM included (${(seam / ideal).toFixed(2)}x ideal, clamped it is ~${(TANGENT_WINDOW / R / ideal).toFixed(0)}x)`,
    seam < ideal * 2);

  // SPEED. 4 m at 1 m/s is 4 s; the same 4 m keyed at 2 m/s throughout is 2 s.
  const plain = route([new Vec2(4, 0)]);
  const fast = route([new Vec2(4, 0)], "backAndForth", 1, { speed: [2, 2] });
  check(`an unkeyed route's trip is a division (${plain.traverse} s)`, plain.traverse === 4);
  check("...and it builds NO pace table", plain.pace === null);
  check(`a route keyed twice as fast takes half as long (${fast.traverse.toFixed(4)} s of 2)`,
    Math.abs(fast.traverse - 2) < 1e-6);
  check("...and it does build one", fast.pace !== null);

  // The half-and-half case, which is what "speeds up down the slope" IS: 4 m
  // keyed 1 m/s at the start and 3 m/s at the end. Smoothstepped, the mean of
  // 1/v over the route is what the trip time is, and it must land strictly
  // between the 4 s the slow end alone would take and the 4/3 s the fast end
  // would - and nearer the harmonic mean than the arithmetic one, since it is
  // TIME that adds and not speed.
  const slope = route([new Vec2(4, 0)], "backAndForth", 1, { speed: [1, 3] });
  check(`a route that speeds up takes between the two (${slope.traverse.toFixed(4)} s, 1.33..4)`,
    slope.traverse > 4 / 3 && slope.traverse < 4);
  check(`...and longer than the arithmetic mean would say (${slope.traverse.toFixed(4)} s vs 2)`,
    slope.traverse > 2);
  // It really does travel faster at the fast end: the last metre takes less time
  // than the first.
  const tAt = (s: number): number => {
    let lo = 0;
    let hi = slope.traverse;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (moveDistanceAt(slope, 0, "linear", mid) < s) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const firstMetre = tAt(1) - tAt(0);
  const lastMetre = tAt(4) - tAt(3);
  check(`the last metre is quicker than the first (${lastMetre.toFixed(3)} s vs ${firstMetre.toFixed(3)})`,
    lastMetre < firstMetre * 0.6);

  // A keyed speed and an EASE compose: the ease reshapes progress through the
  // trip and the keys say how the trip maps onto the route, so the trip still
  // takes exactly as long and still ends where it ends.
  for (const ease of ["linear", "sine", "easeIn", "easeOut"] as const) {
    const atEnd = moveDistanceAt(slope, 0, ease, slope.traverse);
    const atStart = moveDistanceAt(slope, 0, ease, 0);
    check(`${ease} over a keyed route still runs 0 -> ${slope.total} (${atStart.toFixed(4)}, ${atEnd.toFixed(4)})`,
      Math.abs(atStart) < 1e-9 && Math.abs(atEnd - slope.total) < 1e-6);
  }

  // ...and the level reads all of it, which is the half arithmetic cannot say.
  const scene = new Scene(
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        moveNodes: [
          { x: 0, y: 0, rot: 0, speed: 100 },
          { x: 400, y: 0, rot: Math.PI / 4, speed: 300 },
        ],
        moveSpeed: 100,
        objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
      },
    ]),
  );
  const body = scene.mover();
  check(`a keyed body spawns at its first key's angle (${body.globalRotation.toFixed(6)})`,
    Math.abs(body.globalRotation) < 1e-12);
  let turnedTo = 0;
  for (let f = 1; f <= Math.round(3 / DT); f++) {
    scene.step();
    turnedTo = Math.max(turnedTo, body.globalRotation);
  }
  check(`...and turns to the last one as it arrives (${turnedTo.toFixed(4)} of ${(Math.PI / 4).toFixed(4)})`,
    Math.abs(turnedTo - Math.PI / 4) < 1e-3);

  // ...and ALIGN through the same build, which is where the drawn pose has to
  // survive. A platform drawn at an angle and sent LEFT travels left: it is
  // being told where to go, not which way to face, and the absolute form
  // answered this with a body upside down on frame zero.
  const sentAligned = (dx: number, then?: { x: number; y: number }): Scene =>
    new Scene(
      swingLevel([
        {
          kind: "static",
          x: 0,
          y: 0,
          rot: 0.3,
          moveNodes: [{ x: 0, y: 0 }, { x: dx, y: 0 }, ...(then ? [then] : [])],
          moveSpeed: 100,
          moveAlign: true,
          objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
        },
      ]),
    );
  for (const [way, dx] of [["right", 400], ["left", -400]] as const) {
    const sc = sentAligned(dx);
    const cart = sc.mover();
    check(`an aligned body sent ${way} spawns at the angle it was DRAWN at (${cart.globalRotation.toFixed(6)} of 0.3)`,
      Math.abs(wrapPi(cart.globalRotation - 0.3)) < 1e-12);
    sc.step(Math.round(2 / DT));
    check(`...and holds it down the straight leg (${cart.globalRotation.toFixed(6)})`,
      Math.abs(wrapPi(cart.globalRotation - 0.3)) < 1e-9);
  }
  // The turn itself is untouched: the same body, sent left and then down, has
  // turned a right angle FROM its drawn angle by the far end. (Compared wrapped,
  // because a pose is an angle mod 2π - `commitMove` reads the delta the same
  // way, which is what makes the tangent's own branch cut a non-event.)
  const bend = sentAligned(-400, { x: -400, y: -400 });
  const bent = bend.mover();
  bend.step(Math.round(8 / DT)); // 8 m of track at 1 m/s: the far end
  check(`...and an aligned body turns a right angle from where it was drawn (${wrapPi(bent.globalRotation - 0.3).toFixed(4)})`,
    Math.abs(Math.abs(wrapPi(bent.globalRotation - 0.3)) - Math.PI / 2) < 1e-3);

  // The keys survive both round trips, which is the half nothing else can see.
  const raw = swingLevel([
    {
      kind: "static",
      x: 0,
      y: 0,
      rot: 0,
      moveNodes: [
        { x: 0, y: 0, outX: 50, outY: -20 },
        { x: 400, y: 0, inX: -50, inY: -20, rot: 0.3, speed: 250 },
      ],
      moveMode: "repeat",
      moveSpeed: 100,
      moveAlign: true,
      objects: [{ type: "collision", shape: { kind: "rect", w: 200, h: 24 } }],
    },
  ]);
  const back = scaleLevelData(scaleLevelData(raw, PX_FACTOR) as RawLevelData, PIXELS_PER_METER);
  const n = (back.bodies[0] as LevelBodyData).moveNodes ?? [];
  check(
    `a handle is a LENGTH and converts (${n[0]?.outX?.toFixed(3)} of 50)`,
    Math.abs((n[0]?.outX ?? 0) - 50) < 1e-9 && Math.abs((n[1]?.inY ?? 0) - -20) < 1e-9,
  );
  check(
    `a speed key converts and a rot key does not (${n[1]?.speed}, ${n[1]?.rot})`,
    Math.abs((n[1]?.speed ?? 0) - 250) < 1e-9 && n[1]?.rot === 0.3,
  );
  check(
    `the mode and the alignment cross untouched (${(back.bodies[0] as LevelBodyData).moveMode}, ${(back.bodies[0] as LevelBodyData).moveAlign})`,
    (back.bodies[0] as LevelBodyData).moveMode === "repeat" &&
      (back.bodies[0] as LevelBodyData).moveAlign === true,
  );
  // A LOOP repeats node zero's key at the far end of the arc length, so the
  // value between the last keyed node and the seam eases back toward it. The
  // editor's key placeholders read this very track (`MoveRoute.speedKeys`); a
  // second one assembled from the node list alone is one key short and holds the
  // last key instead, which is a placeholder that changes the motion when it is
  // typed in.
  const lap = route([new Vec2(4, 0), new Vec2(4, -4), new Vec2(0, -4)], "loop", 1, {
    speed: [2, undefined, 5, undefined],
  });
  const lapNodeS = lap.index.nodeS;
  check(`a lap's key track carries node zero at both ends (${lap.speedKeys.length} keys of 3)`,
    lap.speedKeys.length === 3 &&
      lap.speedKeys[0]!.s === 0 &&
      Math.abs(lap.speedKeys[2]!.s - lap.total) < 1e-9 &&
      lap.speedKeys[2]!.v === 2);
  const atLast = keyValueAt(lap.speedKeys, lapNodeS[3] ?? 0, 1);
  check(`...so past the last keyed node it eases back to it (${atLast.toFixed(3)}, not 5)`,
    atLast > 2 && atLast < 5);

  const saved = modelToDisk(modelFromDisk(raw)).bodies.find((b) => b.moveNodes !== undefined);
  const sn = saved?.moveNodes ?? [];
  check(
    `the editor keeps the handles and the keys (${sn.length} nodes, rot ${sn[1]?.rot}, speed ${sn[1]?.speed})`,
    sn.length === 2 &&
      Math.abs((sn[1]?.rot ?? 0) - 0.3) < 1e-9 &&
      Math.abs((sn[1]?.speed ?? 0) - 250) < 1e-9 &&
      Math.abs((sn[0]?.outX ?? 0) - 50) < 1e-6 &&
      Math.abs((sn[1]?.inX ?? 0) - -50) < 1e-6,
  );
  check(
    `...and the mode and the alignment (${saved?.moveMode}, ${saved?.moveAlign})`,
    saved?.moveMode === "repeat" && saved?.moveAlign === true,
  );

  return ok("keys - a node keys the angle and the speed the body has there", passed, details);
}

// ---------------------------------------------------------------------------
// legacy: a level authored before nodes, modes and keys plays exactly as it did.
//
// The one claim that cannot be got from the arithmetic: `movePath` becomes
// `moveNodes` with the body prepended, `moveClosed` becomes the mode it named,
// and both are folded at `scaleLevelData` - the one gate every level passes
// through - so nothing downstream has a second opinion.
// ---------------------------------------------------------------------------
function caseLegacy(): MoverResult {
  const details: string[] = [];
  let passed = true;
  const check = (label: string, cond: boolean): void => {
    details.push(`${cond ? "ok  " : "BAD "} ${label}`);
    if (!cond) passed = false;
  };

  const legacy = (closed: boolean): RawLevelData =>
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        movePath: [{ x: 200, y: 0 }, { x: 200, y: -100 }],
        ...(closed ? { moveClosed: true } : {}),
        moveSpeed: 100,
        objects: [{ type: "collision", shape: { kind: "rect", w: 100, h: 24 } }],
      },
    ]);
  const modern = (mode: MoveMode): RawLevelData =>
    swingLevel([
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        moveNodes: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: -100 }],
        moveMode: mode,
        moveSpeed: 100,
        objects: [{ type: "collision", shape: { kind: "rect", w: 100, h: 24 } }],
      },
    ]);

  for (const [closed, mode] of [[false, "backAndForth"], [true, "loop"]] as const) {
    const a = new Scene(legacy(closed));
    const b = new Scene(modern(mode));
    let worst = 0;
    for (let f = 1; f <= 600; f++) {
      a.step();
      b.step();
      worst = Math.max(worst, a.mover().globalPosition.sub(b.mover().globalPosition).length());
    }
    check(`moveClosed: ${closed} plays as ${mode}, to the bit (${worst})`, worst === 0);
  }

  const folded = scaleLevelData(legacy(true), 1).bodies[0] as LevelBodyData;
  check(
    `the fold prepends the body as node zero (${folded.moveNodes?.length} nodes)`,
    folded.moveNodes?.length === 3 &&
      folded.moveNodes[0]!.x === 0 &&
      folded.moveNodes[0]!.y === 0 &&
      folded.moveNodes[1]!.x === 200,
  );
  check(`...names the mode (${folded.moveMode})`, folded.moveMode === "loop");
  check(
    `...and drops the retired fields (${folded.movePath}, ${folded.moveClosed})`,
    folded.movePath === undefined && folded.moveClosed === undefined,
  );
  // Idempotent, which is what lets a level cross the gate twice (px -> m -> px)
  // and come back the same.
  const twice = scaleLevelData(scaleLevelData(legacy(true), 1), 1).bodies[0] as LevelBodyData;
  check("the fold is idempotent", JSON.stringify(twice) === JSON.stringify(folded));

  return ok("legacy - a route authored before nodes plays exactly as it did", passed, details);
}

export function runMoverCases(): MoverResult[] {
  return [
    caseSwingArc(),
    caseSwingPhase(),
    caseSpin(),
    caseInherit(),
    caseUndisturbable(),
    caseRider(),
    caseShuttle(),
    caseLoop(),
    caseEase(),
    caseMovePhase(),
    caseRouteGeometry(),
    caseRepeat(),
    caseCurves(),
    caseKeys(),
    caseLegacy(),
    caseDeterminism(),
    caseAuthored(),
    caseLevels(),
  ];
}
