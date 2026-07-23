// Ledge grab matrix — a generated sweep of grab scenarios (fall speed ×
// ledge angle, run-off catches, seam rejection) run headless against the
// current physics. Pins the detection behavior the states promise
// (game-design.md / controls.md): a deliberate approach grabs at any fall
// speed and any grabbable angle; non-deliberate approaches and seam corners
// never grab. Run via `cli ledges`.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import type { LevelData } from "../level/levelData";
import type { LevelSpec } from "../level/level";
import { runScript, type HoldRange, type PlaytestScript } from "./playtest";

const PLAYER_RADIUS = 8;
const LEDGE_W = 160;
const LEDGE_H = 60;

// Ledge block centred at origin, rotated by `rot`; wide ground far below
// catches every miss so negative cases still terminate grounded.
function ledgeLevel(rot: number, player: { x: number; y: number }): LevelSpec {
  const data: LevelData = {
    player: { ...player, radius: PLAYER_RADIUS },
    bodies: [
      { kind: "static", x: 0, y: 0, rot, shape: { kind: "rect", w: LEDGE_W, h: LEDGE_H } },
      { kind: "static", x: 0, y: 400, rot: 0, shape: { kind: "rect", w: 3000, h: 40 } },
    ],
  };
  return { data };
}

// World position of the block's top-right corner and its right-face normal
// for rotation `rot` (block centred at origin, y-down).
function topRightCorner(rot: number): { vertex: Vec2; wallNormal: Vec2 } {
  return {
    vertex: new Vec2(LEDGE_W / 2, -LEDGE_H / 2).rotated(rot),
    wallNormal: new Vec2(1, 0).rotated(rot),
  };
}

export interface MatrixCase {
  name: string;
  script: PlaytestScript;
  spec: LevelSpec;
}

export function buildLedgeMatrix(): MatrixCase[] {
  const cases: MatrixCase[] = [];

  // --- Deliberate falling grabs: every angle × every fall speed must hang,
  // then (input still held toward the wall) climb out on top.
  // Angle limits: the hang face must stay a wall and the top face a floor
  // (lib/surface.ts thresholds) — ±0.5 rad is near the wall-face limit.
  const angles = [0, 0.25, -0.25, 0.5, -0.5];
  const fallHeights = [40, 160, 400, 800]; // 800 px ≈ 21 px/frame at impact
  for (const rot of angles) {
    for (const h of fallHeights) {
      const { vertex } = topRightCorner(rot);
      // Vertical fall line a horizontal player-radius-plus-margin outside the
      // corner: passes within grab reach at corner height for every angle
      // (a tilted-normal offset drifts the line onto the top face for
      // overhanging rotations).
      const spawn = new Vec2(vertex.x + PLAYER_RADIUS + 2, vertex.y - h);
      // Free-fall until just before the corner passes, then hold toward the
      // wall — holding earlier would drift the player over the top face
      // before the corner is ever reached (input-toward grabs never take a
      // corner below centre, so the catch happens just after the pass).
      const cornerFrame = Math.ceil(Math.sqrt((2 * h) / 980) * 60);
      const holdFrom = Math.max(1, cornerFrame - 4);
      const frames = cornerFrame + 200;
      cases.push({
        name: `fall-grab rot=${rot} h=${h}`,
        spec: ledgeLevel(rot, { x: spawn.x, y: spawn.y }),
        script: {
          level: `matrix`,
          frames,
          holds: [{ action: "move_left", from: holdFrom, to: frames }],
          asserts: [
            // A hard wall impact can redirect upward (wall-run) and grab as
            // a climb instead of a hang — either counts as a caught ledge.
            { reachAnyState: ["LedgeHangState", "LedgeClimbState"], byFrame: frames - 100 },
            { reachState: "GroundedState", byFrame: frames },
          ],
        },
      });
    }
  }

  // --- Ledge jump mid-climb: grab, climb on held toward-input, then a
  // buffered jump mid-climb launches into the wall-jump state.
  {
    const { vertex } = topRightCorner(0);
    const spawn = new Vec2(vertex.x + PLAYER_RADIUS + 2, vertex.y - 160);
    const cornerFrame = Math.ceil(Math.sqrt((2 * 160) / 980) * 60);
    cases.push({
      name: "climb-jump-launches",
      spec: ledgeLevel(0, { x: spawn.x, y: spawn.y }),
      script: {
        level: "matrix",
        frames: cornerFrame + 120,
        holds: [
          { action: "move_left", from: Math.max(1, cornerFrame - 4), to: cornerFrame + 120 },
          { action: "jump", from: cornerFrame + 10, to: cornerFrame + 14 },
        ],
        asserts: [
          { reachState: "LedgeClimbState", byFrame: cornerFrame + 10 },
          { reachState: "WallJumpingState", byFrame: cornerFrame + 30 },
        ],
      },
    });
  }

  // --- Universal rule: the same fall with no input never grabs.
  {
    const { vertex, wallNormal } = topRightCorner(0);
    const spawn = vertex.add(wallNormal.mul(PLAYER_RADIUS + 2)).add(new Vec2(0, -400));
    cases.push({
      name: "fall-no-input-no-grab",
      spec: ledgeLevel(0, { x: spawn.x, y: spawn.y }),
      script: {
        level: "matrix",
        frames: 300,
        asserts: [
          { neverState: "LedgeHangState" },
          { neverState: "LedgeClimbState" },
          { reachState: "GroundedState", byFrame: 300 },
        ],
      },
    });
  }

  // --- Running off a lip never grabs it, with or without down (S) held —
  // the run-off catch mechanic was removed (controls.md).
  const runoffSpawn = { x: 0, y: -LEDGE_H / 2 - PLAYER_RADIUS };
  for (const withS of [true, false]) {
    const holds: HoldRange[] = [{ action: "move_right", from: 1, to: 30 }];
    if (withS) holds.push({ action: "extend", from: 1, to: 240 });
    cases.push({
      name: withS ? "runoff-with-S-falls" : "runoff-without-S-falls",
      spec: ledgeLevel(0, runoffSpawn),
      script: {
        level: "matrix",
        frames: 300,
        holds,
        asserts: [
          { neverState: "LedgeHangState" },
          { neverState: "LedgeClimbState" },
          { reachState: "GroundedState", byFrame: 300 },
        ],
      },
    });
  }

  // --- Compound-body seam: two flush-stacked blocks form an interior corner
  // mid-wall; falling past it with toward-input must never grab it.
  {
    const seamData: LevelData = {
      player: { x: LEDGE_W / 2 + PLAYER_RADIUS + 2, y: -LEDGE_H, radius: PLAYER_RADIUS },
      bodies: [
        { kind: "static", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: LEDGE_W, h: LEDGE_H } },
        { kind: "static", x: 0, y: -LEDGE_H, rot: 0, shape: { kind: "rect", w: LEDGE_W, h: LEDGE_H } },
        { kind: "static", x: 0, y: 400, rot: 0, shape: { kind: "rect", w: 3000, h: 40 } },
      ],
    };
    cases.push({
      name: "seam-vertex-never-grabs",
      spec: { data: seamData },
      script: {
        level: "matrix",
        frames: 300,
        holds: [{ action: "move_left", from: 1, to: 300 }],
        asserts: [
          { neverState: "LedgeHangState" },
          { neverState: "LedgeClimbState" },
          { reachState: "GroundedState", byFrame: 300 },
        ],
      },
    });
  }

  return cases;
}

export interface MatrixResult {
  name: string;
  passed: boolean;
  details: string[];
}

export function runLedgeMatrix(): MatrixResult[] {
  return buildLedgeMatrix().map((c) => {
    const r = runScript(c.script, c.spec);
    const details = [
      ...r.violations.map((v) => `f${v.frame} ${v.kind}: ${v.detail}`),
      ...r.assertResults.filter((a) => !a.ok).map((a) => `FAIL ${a.description}`),
    ];
    return { name: c.name, passed: r.passed, details };
  });
}

// Rough impact speed print helper for the case table (px/s at the corner).
export function impactSpeed(fallHeight: number): number {
  return Mathf.sqrt(2 * 980 * fallHeight);
}
