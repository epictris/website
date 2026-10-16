// Glass ball cases: the Hard difficulty's ball, which is the iron ball in every
// number but breaks on the first solid thing it touches (see `BallPlayer.glass`
// and `BallLevel.shatterIfStruck`).
//
// Everything about it is a claim a screenshot cannot check: that it breaks on
// the frame it lands and not the one after, that water does not break it and
// the bed under the water does, that the hook biting a ceiling is not the ball
// touching it, that until it breaks it is the iron ball bit for bit, and that a
// recording of it replays as glass. So each is stepped:
//
//   LANDS     - dropped on a floor it breaks on the landing frame, held where
//               it broke, and the iron ball dropped the same way does not.
//   WATER     - dropped through a body of water it comes out whole (and slowed,
//               so it was in it), and breaks on the floor below.
//   HOOK      - hung from a ceiling by its hook, it hangs whole: the hook and
//               the chain touch what they like.
//   IRON      - up to the frame it breaks it is the iron ball, bit for bit,
//               and the iron ball's digests say nothing about glass.
//   RESPAWN   - `SHATTER_RESPAWN_FRAMES` after the break a fresh ball is put at
//               the spawn, in the same level (nothing rebuilt), with the world
//               still running around the broken one meanwhile.
//   FINISHED  - a ball that has crossed the finish line is not broken by what
//               it meets on the way out of the gate.
//   REPLAY    - a recorded glass run replays bit-identically and breaks on the
//               same frame, and the same frames replayed as iron do not.
//
// Every case runs `checkBallInvariants` throughout and fails on any `glass-*`
// violation, so the detectors are exercised on the rigs that can trip them.
//
// Rigs are plain rects in level pixels (100 to the metre), as the finish suite's.

import { BallLevel, SHATTER_RESPAWN_FRAMES } from "../level/ballLevel";
import type { BallPlayer } from "../classes/ballPlayer";
import { emptyFrameInput } from "../input/frameInput";
import type { LevelBodyData, RawLevelData } from "../level/levelFormat";
import { checkBallInvariants, worldDigestBall } from "./trace";
import { recordScript } from "./record";
import { replayRecording } from "./replay";
import type { PlaytestScript } from "./playtest";

export interface GlassResult {
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
  done(name: string): GlassResult {
    return { name, passed: this.passed, details: this.details };
  }
}

function floor(y: number): LevelBodyData {
  return {
    kind: "static",
    x: 0,
    y,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 3000, h: 40 } }],
  };
}

// A floor, and the ball dropped onto it from 2 m.
function dropRig(extra: LevelBodyData[] = []): RawLevelData {
  return { player: { x: 0, y: -200, radius: 8 }, bodies: [floor(20), ...extra] };
}

interface Run {
  level: BallLevel;
  // The first frame any solid contact pushed on the ball.
  firstTouch: number | null;
  // The frame the ball first broke on: a respawn clears the level's own.
  broke: number | null;
  resetAt: number | null;
  violations: string[];
  positions: { x: number; y: number }[];
}

function run(data: RawLevelData, ball: "iron" | "glass", frames: number, watch?: (l: BallLevel) => void): Run {
  const level = new BallLevel(data, { ball });
  let resetAt: number | null = null;
  level.onReset = () => {
    if (resetAt === null) resetAt = level.frame;
  };
  const violations: string[] = [];
  const positions: { x: number; y: number }[] = [];
  let firstTouch: number | null = null;
  let broke: number | null = null;
  for (let f = 0; f < frames && resetAt === null; f++) {
    const input = emptyFrameInput();
    input.mouseWorldPosition = level.ball.globalPosition;
    level.physicsProcess(input, DT);
    if (resetAt !== null) break;
    if (
      firstTouch === null &&
      level.world.frameContacts.some((c) => c.maxNormalImpulse > 0 && (c.a === level.ball || c.b === level.ball))
    ) {
      firstTouch = level.frame;
    }
    if (broke === null) broke = level.shatteredFrame;
    for (const v of checkBallInvariants(level)) {
      if (v.kind.startsWith("glass")) violations.push(`f${v.frame} ${v.kind}: ${v.detail}`);
    }
    positions.push({ x: level.ball.globalPosition.x, y: level.ball.globalPosition.y });
    watch?.(level);
  }
  return { level, firstTouch, broke, resetAt, violations, positions };
}

function noViolations(c: Checks, r: Run): void {
  c.check(`no glass-* invariant fired${r.violations.length ? ` (${r.violations.slice(0, 3).join("; ")})` : ""}`, r.violations.length === 0);
}

function caseLands(): GlassResult {
  const c = new Checks();
  let event = null as BallLevel["shatterEvents"][number] | null;
  const glass = run(dropRig(), "glass", 120, (l) => {
    if (l.shatterEvents.length) event = l.shatterEvents[0]!;
  });
  const iron = run(dropRig(), "iron", 120);
  c.check(`the iron ball lands (f${iron.firstTouch}) and stays whole`, iron.firstTouch !== null && iron.level.shatteredFrame === null && !iron.level.ball.shattered);
  c.check(
    `the glass ball breaks on the frame it lands (f${glass.broke}, iron landed f${iron.firstTouch})`,
    glass.broke !== null && glass.broke === iron.firstTouch,
  );
  c.check("...says so to the render side once, with the floor's normal", event !== null && event.normal.y < -0.99);
  c.check("...arriving at the speed it fell at", event !== null && event.velocity.y > 5);
  const at = glass.positions[glass.positions.length - 1];
  const broke = glass.broke === null ? undefined : glass.positions[glass.broke - 1];
  c.check("...and is held where it broke", at !== undefined && broke !== undefined && at.x === broke.x && at.y === broke.y);
  c.check("...collides with nothing", glass.level.ball.passable);
  noViolations(c, glass);
  return c.done("glass-lands");
}

function caseWater(): GlassResult {
  const c = new Checks();
  // A 1.6 m deep body of water hanging in the drop, its bottom 1 m above the
  // floor: the ball falls in, through and out, then lands.
  const water: LevelBodyData = {
    kind: "water",
    x: 0,
    y: -180,
    rot: 0,
    drag: 5,
    objects: [{ type: "collision", shape: { kind: "rect", w: 1200, h: 160 } }],
  };
  const data: RawLevelData = { player: { x: 0, y: -400, radius: 8 }, bodies: [floor(20), water] };
  let leftWater: number | null = null;
  const glass = run(data, "glass", 300, (l) => {
    if (leftWater === null && l.ball.globalPosition.y > -1.0 + l.ball.radius) leftWater = l.frame;
  });
  const dry = run({ player: data.player, bodies: [floor(20)] }, "glass", 300);
  c.check(`it falls clean through the water whole (out by f${leftWater})`, leftWater !== null && (glass.broke ?? Infinity) > leftWater);
  c.check(
    `...and the water slowed it, so it was in it (landed f${glass.broke}, f${dry.broke} without the water)`,
    glass.broke !== null && dry.broke !== null && glass.broke > dry.broke,
  );
  c.check(`...and breaks on the floor below it (f${glass.broke})`, glass.broke !== null);
  noViolations(c, glass);
  return c.done("glass-water");
}

function caseHook(): GlassResult {
  const c = new Checks();
  // A ceiling 1.2 m over the spawn and nothing under it: the spawn hangs the
  // ball from it (`SpawnData.hang`), so the hook is biting the ceiling from
  // the first frame.
  const ceiling: LevelBodyData = {
    kind: "static",
    x: 0,
    y: -320,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 3000, h: 40 } }],
  };
  const data: RawLevelData = { player: { x: 30, y: -200, radius: 8, hang: true }, bodies: [ceiling] };
  let hookTouching = 0;
  const glass = run(data, "glass", 240, (l) => {
    const hookContact = l.world.frameContacts.some((k) => k.a !== l.ball && k.b !== l.ball && k.normalImpulse > 0);
    if (l.ball.chainAttached || hookContact) hookTouching++;
  });
  c.check("the hook bites the ceiling at the spawn", glass.level.ball.chainAttached);
  c.check(`and the ball hangs and swings whole from it for ${glass.positions.length} frames`, glass.level.shatteredFrame === null && glass.positions.length === 240);
  c.check(`...with the chain on the ceiling the whole time (${hookTouching} frames)`, hookTouching === 240);
  noViolations(c, glass);
  return c.done("glass-hook");
}

function caseIron(): GlassResult {
  const c = new Checks();
  const glass = run(dropRig(), "glass", 120);
  const iron = run(dropRig(), "iron", 120);
  const broke = glass.broke ?? 0;
  let same = broke > 0;
  for (let i = 0; i < broke - 1; i++) {
    const a = glass.positions[i]!;
    const b = iron.positions[i]!;
    if (a.x !== b.x || a.y !== b.y) same = false;
  }
  c.check(`the glass ball's path is the iron ball's, bit for bit, until it breaks (f${broke})`, same);
  const ironDigest = worldDigestBall(iron.level);
  const glassDigest = worldDigestBall(glass.level);
  c.check("an iron run's digest carries no `shattered`", !("shattered" in ironDigest));
  c.check("a glass run's does, and says it broke", glassDigest.shattered === true);
  noViolations(c, iron);
  return c.done("glass-iron");
}

function caseRespawn(): GlassResult {
  const c = new Checks();
  // A crate on a shelf to one side, knocked off nothing - it simply falls when
  // the level starts and is still falling as the ball breaks: proof that the
  // world runs on around the broken ball.
  const crate: LevelBodyData = {
    kind: "rigid",
    x: 600,
    y: -900,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 30, h: 30 } }],
  };
  let crateAtBreak: number | null = null;
  let crateLater: number | null = null;
  let broken: BallPlayer | null = null;
  let respawnedAt: number | null = null;
  let respawnedTo: { x: number; y: number } | null = null;
  let respawnedWhole = false;
  // Watched up to the respawn and no further: the fresh ball falls the same
  // two metres and breaks again inside the run.
  const glass = run(dropRig([crate]), "glass", 200, (l) => {
    if (respawnedAt !== null) return;
    const box = l.world.bodies.find((b) => b !== l.ball && b.constructor.name === "RigidBody2D");
    if (broken === null && l.frame === l.shatteredFrame) {
      broken = l.ball;
      if (box) crateAtBreak = box.globalPosition.y;
    }
    if (l.shatteredFrame !== null && l.frame === l.shatteredFrame + 20 && box) crateLater = box.globalPosition.y;
    if (broken !== null && l.ball !== broken) {
      respawnedAt = l.frame;
      respawnedTo = { x: l.ball.globalPosition.x, y: l.ball.globalPosition.y };
      respawnedWhole = !l.ball.shattered && (broken as BallPlayer).removed && l.attempt === 1;
    }
  });
  const broke = glass.broke;
  c.check(
    `a fresh ball is put at the spawn ${SHATTER_RESPAWN_FRAMES} frames after the break (broke f${broke}, respawned f${respawnedAt})`,
    broke !== null && respawnedAt === broke + SHATTER_RESPAWN_FRAMES,
  );
  const to = respawnedTo as { x: number; y: number } | null;
  c.check(
    `...at the spawn, in its first frame of falling (${to ? `${to.x.toFixed(3)}, ${to.y.toFixed(3)}` : "never"})`,
    to !== null && to.x === 0 && to.y > -2 && to.y < -1.99,
  );
  c.check("...in the same level - nothing was rebuilt", glass.resetAt === null);
  c.check("...whole, and the broken one gone from the world", respawnedWhole);
  c.check(
    `...and the world ran on meanwhile (the crate falls from ${crateAtBreak} to ${crateLater})`,
    crateAtBreak !== null && crateLater !== null && crateLater > crateAtBreak,
  );
  noViolations(c, glass);
  return c.done("glass-respawn");
}

function caseFinished(): GlassResult {
  const c = new Checks();
  // A finish gate the ball falls through on its way to the floor.
  const gate: LevelBodyData = {
    kind: "finish",
    x: 0,
    y: -100,
    rot: 0,
    objects: [{ type: "collision", shape: { kind: "rect", w: 300, h: 20 } }],
  };
  const glass = run(dropRig([gate]), "glass", 120);
  c.check(`the ball crosses the line (f${glass.level.completedFrame})`, glass.level.completedFrame !== null);
  c.check(`...and lands after it (f${glass.firstTouch}) whole`, glass.firstTouch !== null && glass.level.shatteredFrame === null);
  noViolations(c, glass);
  return c.done("glass-finished");
}

function caseReplay(): GlassResult {
  const c = new Checks();
  // Long enough to break, respawn and fall again: the respawn has to replay too.
  const script: PlaytestScript = { level: "GLASS_RIG", data: dropRig(), controller: "ball", frames: 200, ball: "glass" };
  const { recording } = recordScript(script);
  c.check("the recording says it was glass", recording.ball === "glass");
  const replayed = replayRecording(recording);
  c.check(
    `it replays bit-identically (${replayed.bitDivergedAtFrame === null ? "identical" : `diverged f${replayed.bitDivergedAtFrame}`})`,
    replayed.bitDivergedAtFrame === null && replayed.divergedAtFrame === null,
  );
  const shatteredAt = recording.worldDigests?.find((d) => d.shattered === true)?.frame ?? null;
  c.check(`...the digests saying it broke (f${shatteredAt})`, shatteredAt !== null);
  const asIron = replayRecording({ ...recording, ball: undefined });
  c.check(
    `the same frames replayed as IRON are a different run (diverged f${asIron.divergedAtFrame})`,
    asIron.divergedAtFrame !== null,
  );
  return c.done("glass-replay");
}

// THE MENU'S PICK (`BallLevel.setBallKind`): the level the menu prewarmed is
// built with one ball and played with the one picked, made so in place. That
// is only sound if it is exactly a level built with the picked ball - which is
// what a replay builds - so the two are stepped side by side, digest by digest,
// through the break and the respawn.
function caseKindSwap(): GlassResult {
  const c = new Checks();
  const swapped = new BallLevel(dropRig(), { ball: "iron" });
  swapped.setBallKind("glass");
  const built = new BallLevel(dropRig(), { ball: "glass" });
  let identical = true;
  let firstDiff: number | null = null;
  for (let f = 0; f < 200; f++) {
    for (const l of [swapped, built]) {
      const input = emptyFrameInput();
      input.mouseWorldPosition = l.ball.globalPosition;
      l.physicsProcess(input, DT);
    }
    if (JSON.stringify(worldDigestBall(swapped)) !== JSON.stringify(worldDigestBall(built))) {
      identical = false;
      firstDiff ??= swapped.frame;
    }
  }
  c.check(
    `a level built iron and made glass before frame 1 steps exactly as one built glass (${identical ? "200 frames identical" : `differs from f${firstDiff}`})`,
    identical && built.attempt === 1,
  );
  let refused = false;
  try {
    swapped.setBallKind("iron");
  } catch {
    refused = true;
  }
  c.check("...and once it has stepped, the ball's kind cannot be changed", refused);
  return c.done("glass-kind-swap");
}

export function runGlassCases(): GlassResult[] {
  return [
    caseLands(),
    caseWater(),
    caseHook(),
    caseIron(),
    caseRespawn(),
    caseFinished(),
    caseReplay(),
    caseKindSwap(),
  ];
}
