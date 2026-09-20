// Rolling-entry cases: the way a level OPENS when its spawn authors one (see
// `SpawnData.roll`, `BallLevel.startRolling` and docs/ball-rolling.md).
//
// The mechanic is two lines of arithmetic gating one frame's input, and that is
// exactly what makes it worth a suite: everything it can get wrong is silent
// and none of it is visible in a screenshot of frame 1.
//
// An entry that never ends is a level that never hands the player their ball -
// the ball rolls past the spawn, through the level and off the end of it with
// the cursor doing nothing, and the page looks like a hung tab rather than a
// broken level. An entry that lets the recorded aim through on one frame is a
// replay that diverges on the first one. An entry that hands over a frame late,
// or early, moves the point the run actually starts at.
//
// Five claims:
//
//   ROLLS IN   - the ball is placed at the authored offset, travelling toward
//                the spawn, spinning at the rate a ball that got there by
//                rolling would be, and arriving hands over at the spawn.
//   HANDS OFF  - while it rolls in, the player's input does NOTHING: the ball's
//                whole path under a hard aim with the button held is
//                BIT-IDENTICAL to the same run under a neutral input, and no
//                chain is thrown. Bit-identical rather than close, because the
//                replay contract is bit-identity.
//   HANDS OVER - the frame the entry ends, the same input that did nothing does
//                something: the aim steers, and a press throws the chain.
//   STALLED    - an entry authored into a wall hands over anyway, rather than
//                holding the player's hands off a ball that is never arriving.
//   ABSENT     - a spawn with no entry opens exactly as it always did, a spawn
//                that asks for both an entry and a hang keeps the hang, and a
//                checkpoint start has no entry at all.
//
// Bodies are rigs of plain rects in level pixels (100 to the metre), on a
// `BallLevel`, as the finish and sleep suites are.

import { Vec2 } from "../engine/vec2";
import { BallLevel } from "../level/ballLevel";
import { emptyFrameInput, type FrameInput } from "../input/frameInput";
import { spawnAtCheckpoint, type LevelBodyData, type RawLevelData } from "../level/levelFormat";

export interface EntryResult {
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
  done(name: string): EntryResult {
    return { name, passed: this.passed, details: this.details };
  }
}

// The entry the cases are measured on: 4 m in from the left, on a floor long
// enough that the ball is on it for the whole run.
const ROLL_PX = -400;
const SPAWN_X = 0;
// The spawn sits one ball radius above the floor's top face, so the run opens
// touching the ground rather than dropping onto it: what is being measured is a
// roll, and a ball that falls the first 10 cm of it arrives with a bounce in it.
const RADIUS_PX = 8;
const SPAWN_Y = -RADIUS_PX * BallLevel.BALL_RADIUS_SCALE;

// A floor, with an optional wall standing in the entry's way.
//
// `wall` is what the STALLED case is: a ball rolling into it stops dead, two
// metres short of the spawn it was rolling to, and the entry has to end anyway.
function rig(roll: number, wall: { x: number } | null = null): RawLevelData {
  const bodies: LevelBodyData[] = [
    {
      kind: "static",
      x: 0,
      y: 20,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: 2000, h: 40 } }],
    },
  ];
  if (wall) {
    bodies.push({
      kind: "static",
      x: wall.x,
      y: -100,
      rot: 0,
      objects: [{ type: "collision", shape: { kind: "rect", w: 40, h: 200 } }],
    });
  }
  return {
    player: { x: SPAWN_X, y: SPAWN_Y, radius: RADIUS_PX, ...(roll ? { roll } : {}) },
    bodies,
  };
}

// The input a player with their hand on the mouse sends: the cursor WHIRLING
// round the ball, which is how a ball is driven (the loop chases the aim, and
// the spin grips the floor — see docs/ball-rolling.md), with the deploy button
// held from the first frame. Held rather than clicked, because a hand resting
// on the button is the case that decides whether the hand-over throws a chain
// nobody asked for.
//
// A whirl rather than a fixed point because a fixed point is answered once: the
// ball turns to face it and stops, which moves it by a couple of centimetres
// and would make "the entry is what dropped the input" and "there was nothing
// to drop" hard to tell apart.
const WHIRL_RATE = 0.2; // radians a frame
const WHIRL_REACH = 1.5; // metres from the ball
function aiming(level: BallLevel, pressed: boolean): FrameInput {
  const a = level.frame * WHIRL_RATE;
  // Through `Vec2.rotated`, which is the sim's own trig, so this stream is the
  // same stream on every engine (see `engine/dmath.ts`).
  const at = level.ball.globalPosition.add(new Vec2(WHIRL_REACH, 0).rotated(a));
  return {
    ...emptyFrameInput(),
    fire: { held: true, pressed, released: false },
    mouseWorldPosition: at,
  };
}

// The input of a player whose hands are off: the "not aiming" sentinel the
// controller already has (the ball's own position) and no buttons. This is what
// the HANDS OFF case measures the aiming run against.
function neutral(level: BallLevel): FrameInput {
  return { ...emptyFrameInput(), mouseWorldPosition: level.ball.globalPosition };
}

interface Step {
  x: number;
  y: number;
  rollingIn: boolean;
  chained: boolean;
}

function run(level: BallLevel, frames: number, input: (l: BallLevel) => FrameInput): Step[] {
  const steps: Step[] = [];
  for (let f = 0; f < frames; f++) {
    level.physicsProcess(input(level), DT);
    steps.push({
      x: level.ball.globalPosition.x,
      y: level.ball.globalPosition.y,
      rollingIn: level.rollingIn,
      chained: level.ball.chain !== null,
    });
  }
  return steps;
}

function caseRollsIn(): EntryResult {
  const c = new Checks();
  const level = new BallLevel(rig(ROLL_PX));
  const start = level.ball.globalPosition;
  const want = (SPAWN_X + ROLL_PX) / 100;
  c.check(`the ball is placed at the authored offset (x ${start.x}, want ${want})`, start.x === want);
  c.check("...rolling toward the spawn", level.ball.linearVelocity.x === BallLevel.ENTRY_SPEED);
  // Rolling rather than sliding: ω = v / r exactly, so the floor has nothing to
  // correct on the first frame and the entry neither scrubs nor skids.
  c.check(
    `...spinning to match (${level.ball.angularVelocity.toFixed(3)} rad/s)`,
    level.ball.angularVelocity === BallLevel.ENTRY_SPEED / level.ball.radius,
  );
  c.check("...and the level says it is rolling in", level.rollingIn);

  // Long enough for 4 m at 3 m/s with room to spare, so a hand-over that never
  // comes reads as a failure rather than as a run that was cut short.
  const steps = run(level, 240, neutral);
  const handover = steps.findIndex((s) => !s.rollingIn);
  c.check(`the entry ends (f${handover + 1})`, handover >= 0);
  const at = handover >= 0 ? steps[handover]! : null;
  // At the spawn, within two frames' travel: the hand-over is a crossing test
  // taken at the TOP of a frame, so the frame it fires on is the first frame at
  // or past the spawn and never one before it - one frame's travel is how far
  // past the crossing put it, and the second is the rest of the frame it fires
  // on, since these samples are taken at the end of one.
  const slack = 2 * BallLevel.ENTRY_SPEED * DT;
  c.check(
    `...at the spawn (x ${at ? at.x.toFixed(3) : "never"}, within ${slack.toFixed(3)})`,
    at !== null && at.x >= SPAWN_X / 100 - 1e-9 && at.x - SPAWN_X / 100 <= slack,
  );
  c.check("...and never starts again", steps.every((s, i) => (handover >= 0 && i > handover ? !s.rollingIn : true)));
  return c.done("entry-rolls-in — the ball is placed off to the side and rolls to its spawn");
}

function caseHandsOff(): EntryResult {
  const c = new Checks();
  const FRAMES = 240;
  const played = run(new BallLevel(rig(ROLL_PX)), FRAMES, (l) => aiming(l, l.frame === 1));
  const left = run(new BallLevel(rig(ROLL_PX)), FRAMES, neutral);

  const entryFrames = left.findIndex((s) => !s.rollingIn);
  c.check(`the entry runs for ${entryFrames} frames`, entryFrames > 30);
  c.check(
    "no chain is thrown while it rolls in, button held from frame 1",
    played.slice(0, entryFrames).every((s) => !s.chained),
  );

  let worst = 0;
  let at = -1;
  for (let f = 0; f < entryFrames; f++) {
    const a = played[f]!;
    const b = left[f]!;
    const d = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    if (d > worst) {
      worst = d;
      at = f;
    }
  }
  // BIT-identical, not "close": an aim that moved the ball by a rounding error
  // is an aim that was read, and this is the whole claim.
  c.check(`the entry is bit-identical played and left alone (worst ${worst} at f${at})`, worst === 0);
  // ...and the comparison is a real one: once the ball is the player's, the two
  // runs come apart. Without this the case above passes on a controller that
  // ignores its input entirely.
  const after = played[FRAMES - 1]!;
  const alone = left[FRAMES - 1]!;
  c.check(
    `...and they part company once it is over (${Math.abs(after.x - alone.x).toFixed(3)} m apart at f${FRAMES})`,
    Math.abs(after.x - alone.x) > 0.01 || Math.abs(after.y - alone.y) > 0.01,
  );
  return c.done("entry-hands-off — the player's aim and deploy do nothing while the ball rolls in");
}

function caseHandsOver(): EntryResult {
  const c = new Checks();
  const level = new BallLevel(rig(ROLL_PX));
  // Aiming hard the whole way, with the button HELD from frame 1 and never
  // re-pressed: what arrives with the hand-over is the aim, and the throw waits
  // for a press of its own.
  let arrived = -1;
  for (let f = 0; f < 240 && arrived < 0; f++) {
    level.physicsProcess(aiming(level, level.frame === 1), DT);
    if (!level.rollingIn) arrived = level.frame;
  }
  c.check(`the entry ends (f${arrived})`, arrived > 0);
  // The steering is kinematic while aiming (see `BallPlayer.resolveInput`), so
  // this is the controller saying the aim is being read - on the arrival frame
  // itself, not the one after it.
  c.check("the aim steers on the arrival frame", level.ball.kinematicRotation);
  c.check("...and a button held through the hand-over throws nothing", level.ball.chain === null);

  // A press of its own does throw, on the frame it is made.
  level.physicsProcess(aiming(level, true), DT);
  c.check("a fresh press throws the chain", level.ball.chain !== null);
  return c.done("entry-hands-over — the run starts at the spawn, with the ball in the player's hands");
}

function caseStalled(): EntryResult {
  const c = new Checks();
  // A wall 2 m short of the spawn: the ball rolls into it and stops, so the
  // arrival the entry is waiting for never happens.
  const level = new BallLevel(rig(ROLL_PX, { x: -200 }));
  const steps = run(level, 240, neutral);
  const handover = steps.findIndex((s) => !s.rollingIn);
  c.check(`the entry ends anyway (f${handover + 1})`, handover >= 0);
  const at = handover >= 0 ? steps[handover]! : null;
  c.check(
    `...short of the spawn, where the ball actually is (x ${at ? at.x.toFixed(3) : "never"})`,
    at !== null && at.x < SPAWN_X / 100 - 0.5,
  );
  c.check(
    `...and within a second of stopping (f${handover + 1})`,
    handover >= 0 && handover < 180,
  );
  return c.done("entry-stalled — an entry that cannot arrive hands over where it stands");
}

function caseAbsent(): EntryResult {
  const c = new Checks();
  // No entry: the ball stands at its spawn, at rest, with the player's hands on
  // it from frame 1 - which is every level authored before the field.
  const plain = new BallLevel(rig(0));
  c.check("a spawn with no entry is not rolling in", !plain.rollingIn);
  c.check(
    "...and its ball starts at the spawn, at rest",
    plain.ball.globalPosition.x === SPAWN_X / 100 &&
      plain.ball.linearVelocity.x === 0 &&
      plain.ball.angularVelocity === 0,
  );

  // An entry and a hang together: the hang decides where the ball is, so the
  // entry is the one that gives way (see `BallLevel.startRolling`).
  const both = rig(ROLL_PX);
  both.player = { ...both.player, hang: true };
  const hung = new BallLevel(both);
  c.check(
    "a spawn that asks for both an entry and a hang keeps the hang",
    !hung.rollingIn && hung.ball.globalPosition.x === SPAWN_X / 100,
  );

  // A checkpoint start is not the level's opening, so it has no entry at all -
  // and, kept, the entry would have put the ball an entry's length to one side
  // of the point that was asked for.
  const withCheckpoint: RawLevelData = {
    ...rig(ROLL_PX),
    checkpoints: [{ name: "here", x: 500, y: SPAWN_Y }],
  };
  const dropped = new BallLevel(spawnAtCheckpoint(withCheckpoint, "here"));
  c.check(
    `a checkpoint start has no entry (x ${dropped.ball.globalPosition.x})`,
    !dropped.rollingIn && dropped.ball.globalPosition.x === 5,
  );
  return c.done("entry-absent — no entry, an entry beside a hang, and an entry at a checkpoint");
}

// The camera stands at the spawn for the whole entry and takes the ball over
// where it arrives (see `BallLevel.cameraRenderPosition`).
//
// Worth a case of its own because the failure is not a crash or a number: a
// camera that follows the entry holds the ball in the middle of the screen for
// the whole of it, which is a ball rolling on the spot in front of a sliding
// level - an opening that is not an entry at all, and one no assertion about
// the ball's own path can tell apart from a good one.
function caseCameraHolds(): EntryResult {
  const c = new Checks();
  const level = new BallLevel(rig(ROLL_PX));
  const spawn = new Vec2(SPAWN_X / 100, SPAWN_Y / 100);
  let worst = 0;
  let entryFrames = 0;
  // Sampled at both ends of the render interpolation, since the camera reads
  // this at whatever alpha the display frame lands on.
  const off = (alpha: number): number => level.cameraRenderPosition(alpha).sub(spawn).length();
  c.check(`the camera stands at the spawn from the first frame (${off(1).toFixed(4)} m off)`, off(1) === 0);
  for (let f = 0; f < 240 && level.rollingIn; f++) {
    level.physicsProcess(neutral(level), DT);
    if (level.rollingIn) {
      entryFrames++;
      worst = Math.max(worst, off(0), off(0.5), off(1));
    }
  }
  c.check(`...and never moves for the ${entryFrames} frames of the entry (worst ${worst.toFixed(4)} m)`, worst === 0);
  c.check("...while the ball crosses the frame to reach it", entryFrames > 60);

  // The hand-over is invisible because the camera is already looking at the
  // point the ball arrives at: what it takes over is a target a couple of
  // centimetres from the one it was holding, well inside the follow's own ease.
  const step = level.cameraRenderPosition(1).sub(spawn).length();
  c.check(`the camera takes the ball over where it stands (${(step * 100).toFixed(1)} cm)`, step < 0.1);
  c.check(
    "...and follows it from there",
    level.cameraRenderPosition(1).x === level.ball.renderPosition(1).x,
  );
  return c.done("entry-camera-holds — the frame stands still and the ball rolls into it");
}

export function runEntryCases(): EntryResult[] {
  return [caseRollsIn(), caseHandsOff(), caseHandsOver(), caseStalled(), caseCameraHolds(), caseAbsent()];
}
