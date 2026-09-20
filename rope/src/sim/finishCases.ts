// Finish-line cases: the thing a level ENDS at (see `classes/finishLine.ts`,
// the `finish` body kind and docs/levels.md).
//
// The mechanic is one overlap test, which is exactly why it is worth a suite:
// everything that can go wrong with it is silent. A gate the ball passes
// through untouched is a level nobody can complete; a gate that is entered
// twice and re-dated is a run that finished on a frame it did not; a gate that
// pushes the ball is a wall wearing chequers. None of those shows up in a
// digest of a level that has no finish line in it, and none of them is visible
// in a screenshot of one that has.
//
// Four claims, in the order they matter:
//
//   CROSSED   - the ball entering the region finishes the level, on the frame
//               it touches, and `hasFinish` says the level has one at all.
//   ONCE      - a ball that leaves the region and comes back does not re-date
//               the finish, and `checkBallInvariants` says so too (the
//               `finish-once` detector is run here against the one rig in the
//               tree that actually re-enters).
//   MISSED    - the same rig with the gate moved aside is never finished,
//               however long it runs. Without this, a case that always
//               completes would pass against a `completedFrame` set at build.
//   INERT     - the region moves nothing. The ball's whole trajectory through
//               the gate is BIT-IDENTICAL to the same run with no gate in the
//               level, which is the claim that an area is a region rather than
//               a surface, made the only way it can be made.
//
// Bodies are rigs of plain rects in level pixels (100 to the metre), on a
// `BallLevel`, as the sleep and rail suites are.

import { Vec2 } from "../engine/vec2";
import { BallLevel } from "../level/ballLevel";
import { emptyFrameInput } from "../input/frameInput";
import type { LevelBodyData, RawLevelData } from "../level/levelFormat";
import { checkBallInvariants } from "./trace";

export interface FinishResult {
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
  done(name: string): FinishResult {
    return { name, passed: this.passed, details: this.details };
  }
}

// Where the gate stands, in scene pixels: a 3 m x 2 m region hanging in the
// ball's way, its centre 3.2 m above the floor.
const GATE_X = 0;
const GATE_Y = -320;
const GATE_W = 300;
const GATE_H = 200;

// The rig: a TRAMPOLINE floor under a finish gate, with the ball dropped from
// above it.
//
// The floor bounces on purpose, and it is what makes the ONCE case a real one:
// the ball falls through the gate, is thrown back up by the pad and passes
// through it a SECOND time. A gate that re-dates its finish on every entry
// fails here and nowhere else - a ball that simply drops through one is inside
// it for a handful of frames and never comes back.
//
// `gate` places the finish region; null leaves it out of the level entirely,
// which is the control the INERT case is measured against. It is authored LAST
// so every other body keeps the build index it has without it (see
// `World.add`), and the two levels are the same scene but for the region.
function rig(gate: { x: number; y: number } | null): RawLevelData {
  const bodies: LevelBodyData[] = [
    {
      kind: "static",
      x: 0,
      y: 20,
      rot: 0,
      bounce: 0.9,
      launch: 700,
      objects: [{ type: "collision", shape: { kind: "rect", w: 2000, h: 40 } }],
    },
  ];
  if (gate) {
    bodies.push({
      kind: "finish",
      x: gate.x,
      y: gate.y,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: GATE_W, h: GATE_H } }],
    });
  }
  return { player: { x: 0, y: -700, radius: 8 }, bodies };
}

// Is the ball inside the gate's band this frame, by the same rectangle the
// area test uses? Measured here rather than asked of the area, because what
// the ONCE case is about is the sim's own answer being asked twice.
function insideGate(level: BallLevel, gate: { x: number; y: number }): boolean {
  const p = level.ball.globalPosition;
  const r = level.ball.radius;
  const halfW = GATE_W / 200;
  const halfH = GATE_H / 200;
  return Math.abs(p.x - gate.x / 100) <= halfW + r && Math.abs(p.y - gate.y / 100) <= halfH + r;
}

interface Run {
  finishedAt: number | null;
  entries: number;
  violations: string[];
  path: { x: number; y: number }[];
}

function run(gate: { x: number; y: number } | null, frames: number): Run {
  const level = new BallLevel(rig(gate));
  const path: { x: number; y: number }[] = [];
  const violations: string[] = [];
  let entries = 0;
  let was = false;
  for (let f = 0; f < frames; f++) {
    level.physicsProcess(emptyFrameInput(), DT);
    const now = gate !== null && insideGate(level, gate);
    if (now && !was) entries++;
    was = now;
    for (const v of checkBallInvariants(level)) {
      if (v.kind === "finish-once") violations.push(`f${v.frame}: ${v.detail}`);
    }
    path.push({ x: level.ball.globalPosition.x, y: level.ball.globalPosition.y });
  }
  return { finishedAt: level.completedFrame, entries, violations, path };
}

function caseCrossed(): FinishResult {
  const c = new Checks();
  const gate = { x: GATE_X, y: GATE_Y };
  const level = new BallLevel(rig(gate));
  c.check("the level says it has a finish line", level.hasFinish);
  c.check("...and opens unfinished", level.completedFrame === null);

  // Stepped one frame at a time so the frame the crossing is DATED can be
  // compared against the frame the ball was first in the gate: a finish stamped
  // a frame late is a run whose replay finishes a frame late.
  let firstInside: number | null = null;
  for (let f = 0; f < 200 && level.completedFrame === null; f++) {
    level.physicsProcess(emptyFrameInput(), DT);
    if (firstInside === null && insideGate(level, gate)) firstInside = level.frame;
  }
  c.check(`the ball falling through the gate finishes the level (f${level.completedFrame})`, level.completedFrame !== null);
  c.check(
    `...on the frame it touched it (inside from f${firstInside}, finished f${level.completedFrame})`,
    firstInside !== null && level.completedFrame === firstInside,
  );
  return c.done("finish-crossed — entering the region finishes the level, on the frame it is entered");
}

function caseOnce(): FinishResult {
  const c = new Checks();
  const r = run({ x: GATE_X, y: GATE_Y }, 400);
  c.check(`the ball passes through the gate more than once (${r.entries} entries)`, r.entries >= 2);
  c.check(`the finish is dated once and never moves (f${r.finishedAt})`, r.finishedAt !== null);
  c.check(
    `the finish-once detector is silent${r.violations.length ? `: ${r.violations[0]}` : ""}`,
    r.violations.length === 0,
  );
  return c.done("finish-once — a second crossing does not re-date the finish");
}

function caseMissed(): FinishResult {
  const c = new Checks();
  // The same gate, moved 10 m to the side: the ball falls past where it was and
  // the level is never finished.
  const r = run({ x: GATE_X + 1000, y: GATE_Y }, 400);
  c.check("the ball never enters the moved gate", r.entries === 0);
  c.check(`...so the level is never finished (${r.finishedAt ?? "never"})`, r.finishedAt === null);

  // ...and a level with NO finish line at all says so, which is what keeps
  // every level authored before the kind digesting exactly what it always did.
  const bare = new BallLevel(rig(null));
  for (let f = 0; f < 200; f++) bare.physicsProcess(emptyFrameInput(), DT);
  c.check("a level with no finish line has none to report", !bare.hasFinish && bare.completedFrame === null);
  return c.done("finish-missed — a gate the ball does not touch finishes nothing");
}

// A gate as thin as the prop that marks it, crossed at the speed the corpus
// says this game actually reaches.
//
// This is the case the swept crossing exists for. The area's own entry test is
// a sample taken once a frame, so a region W across is passed through untouched
// by a ball that travels more than W plus its own diameter in one step - and
// the first finish line anybody authored was 10 px (`levels/ball.json`, Tris,
// 2026-09-20), drawn to match a gantry seen edge-on, which a 21 m/s swing jumps.
//
// It asserts the miss as well as the catch: the ball's positions on the frames
// either side of the crossing are both clear of the gate, so a sampled test
// looking at those two frames would have found nothing. Without that half the
// case would pass on a mechanic that never needed the sweep at all.
function caseThinGateAtSpeed(): FinishResult {
  const c = new Checks();
  const THIN = 10; // px across, which is what ball.json's own gate is
  const SPEED = 30; // m/s; the corpus tops out at 34.5 in a rig, 24.8 in a session
  const level = new BallLevel({
    // Started off a whole number of steps from the gate, so the crossing
    // straddles it rather than landing on it: a ball that stops exactly on the
    // line is a ball a sampled test catches, and then this case is asserting
    // nothing.
    player: { x: -275, y: -400, radius: 8 },
    bodies: [
      {
        kind: "finish",
        x: 0,
        y: -400,
        rot: 0,
        objects: [{ type: "collision", shape: { kind: "rect", w: THIN, h: 300 } }],
      },
    ],
  });
  // Fired flat across the gate, with gravity's drop over a handful of frames
  // being neither here nor there against 30 m/s sideways.
  level.ball.linearVelocity = new Vec2(SPEED, 0);

  let before: number | null = null;
  let after: number | null = null;
  const clear = (x: number): boolean => Math.abs(x) > THIN / 200 + level.ball.radius;
  for (let f = 0; f < 60 && after === null; f++) {
    const was = level.ball.globalPosition.x;
    // The velocity is re-asserted each frame: what is being measured is a
    // crossing at a speed, not how long the ball holds one.
    level.ball.linearVelocity = new Vec2(SPEED, level.ball.linearVelocity.y);
    level.physicsProcess(emptyFrameInput(), DT);
    const now = level.ball.globalPosition.x;
    if (was < 0 && now > 0) {
      before = was;
      after = now;
    }
  }
  c.check(
    `the ball crosses the gate in one step (${before?.toFixed(2)} m -> ${after?.toFixed(2)} m)`,
    before !== null && after !== null,
  );
  c.check(
    `...and is clear of a ${THIN} px gate on BOTH of those frames, so a sampled test sees nothing`,
    before !== null && after !== null && clear(before) && clear(after),
  );
  c.check(
    `the level is finished anyway (f${level.completedFrame})`,
    level.completedFrame !== null,
  );
  return c.done(`finish-swept — a ${THIN} px gate crossed at ${SPEED} m/s is not jumped`);
}

function caseInert(): FinishResult {
  const c = new Checks();
  const FRAMES = 400;
  const withGate = run({ x: GATE_X, y: GATE_Y }, FRAMES);
  const without = run(null, FRAMES);
  c.check("the gate is crossed in the run that has one", withGate.finishedAt !== null);

  let worst = 0;
  let at = -1;
  for (let f = 0; f < FRAMES; f++) {
    const a = withGate.path[f]!;
    const b = without.path[f]!;
    const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    if (d > worst) {
      worst = d;
      at = f;
    }
  }
  // BIT-identical, not "close": a region that moved the ball by a rounding
  // error is still a region that moved it, and this is the whole claim.
  c.check(
    `the ball's ${FRAMES}-frame path is identical with and without the gate (worst ${worst} at f${at})`,
    worst === 0,
  );
  return c.done("finish-inert — the region is passed through, not collided with");
}

export function runFinishCases(): FinishResult[] {
  return [caseCrossed(), caseOnce(), caseMissed(), caseThinGateAtSpeed(), caseInert()];
}
