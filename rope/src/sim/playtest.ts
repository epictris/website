// Headless scripted playtest driver, ported in spirit from tools/Playtest.cs +
// ScriptedInputSource.cs. Drives the sim from a frame-indexed schedule of held
// buttons and mouse aim, checks invariants every frame, and evaluates asserts.

import { Vec2 } from "../engine/vec2";
import { button, emptyFrameInput, type ButtonInput, type FrameInput } from "../input/frameInput";
import { Level, type LevelSpec } from "../level/level";
import { LEVELS } from "../level/registry";
import {
  checkInvariants,
  digest,
  serializeInput,
  StuckDetector,
  type Digest,
  type SerializedFrame,
  type Violation,
} from "./trace";

export type PlaytestAction =
  | "move_left"
  | "move_right"
  | "jump"
  | "retract"
  | "extend"
  | "fire"
  | "retract_click"
  | "spawn_small"
  | "spawn_large";

const ACTION_FIELD: Record<PlaytestAction, keyof FrameInput> = {
  move_left: "moveLeft",
  move_right: "moveRight",
  jump: "jump",
  retract: "retract",
  extend: "extend",
  fire: "fire",
  retract_click: "retractClick",
  spawn_small: "spawnSmallCircle",
  spawn_large: "spawnLargeCircle",
};

export interface HoldRange {
  action: PlaytestAction;
  from: number;
  to: number;
}
export interface MouseRange {
  from: number;
  to: number;
  x: number;
  y: number;
  relative?: boolean;
}
export type PlaytestAssert =
  | { frame: number; state: string }
  | { frame: number; maxSpeed: number }
  | { frame: number; hasRope: boolean }
  | { frame: number; minX?: number; maxX?: number; minY?: number; maxY?: number }
  | { reachState: string; byFrame?: number }
  | { reachAnyState: string[]; byFrame?: number }
  | { neverState: string };

export interface PlaytestScript {
  level: string;
  frames: number;
  holds?: HoldRange[];
  mouse?: MouseRange[];
  asserts?: PlaytestAssert[];
}

function inRange(frame: number, from: number, to: number): boolean {
  return frame >= from && frame <= to;
}

class ScriptedInput {
  private prev: FrameInput = emptyFrameInput();
  constructor(private script: PlaytestScript) {}

  sample(frame: number, playerPos: Vec2): FrameInput {
    const held = new Set<PlaytestAction>();
    for (const h of this.script.holds ?? []) {
      if (inRange(frame, h.from, h.to)) held.add(h.action);
    }
    let mouse = playerPos;
    for (const m of this.script.mouse ?? []) {
      if (inRange(frame, m.from, m.to)) {
        mouse = m.relative ? playerPos.add(new Vec2(m.x, m.y)) : new Vec2(m.x, m.y);
      }
    }

    const input = emptyFrameInput();
    input.mouseWorldPosition = mouse;
    (Object.keys(ACTION_FIELD) as PlaytestAction[]).forEach((action) => {
      const field = ACTION_FIELD[action];
      (input[field] as ButtonInput) = button(held.has(action), this.prev[field] as ButtonInput);
    });
    this.prev = input;
    return input;
  }
}

export interface AssertResult {
  ok: boolean;
  description: string;
}

export interface PlaytestResult {
  level: string;
  framesRun: number;
  violations: Violation[];
  assertResults: AssertResult[];
  digests: Digest[];
  // The exact per-frame inputs fed, so the run can be replayed as a Recording.
  serializedFrames: SerializedFrame[];
  passed: boolean;
}

// `specOverride` runs the script on an ad-hoc level (the ledge matrix builds
// its geometry programmatically); script.level is then only a label.
export function runScript(script: PlaytestScript, specOverride?: LevelSpec): PlaytestResult {
  const spec = specOverride ?? LEVELS[script.level];
  if (!spec) throw new Error(`Unknown level: ${script.level}`);
  if (spec.controller === "ball") {
    throw new Error(`playtest scripts do not support ball levels yet (${script.level})`);
  }
  const level = new Level(spec.data, spec.init);
  let resetFired = false;
  level.onReset = () => {
    resetFired = true;
  };

  const src = new ScriptedInput(script);
  const digests: Digest[] = [];
  const serializedFrames: SerializedFrame[] = [];
  const violations: Violation[] = [];
  const stuck = new StuckDetector();
  const statesSeen = new Set<string>();
  const stateFirstFrame = new Map<string, number>();

  for (let f = 1; f <= script.frames && !resetFired; f++) {
    const input = src.sample(f, level.player.globalPosition);
    serializedFrames.push(serializeInput(input));
    level.physicsProcess(input, 1 / 60);
    const d = digest(level);
    digests.push(d);
    if (!statesSeen.has(d.state)) {
      statesSeen.add(d.state);
      stateFirstFrame.set(d.state, f);
    }
    violations.push(...checkInvariants(level));
    const sv = stuck.push(level, input);
    if (sv) violations.push(sv);
  }

  const assertResults: AssertResult[] = (script.asserts ?? []).map((a) => {
    if ("reachState" in a) {
      const first = stateFirstFrame.get(a.reachState);
      const ok = first !== undefined && (a.byFrame === undefined || first <= a.byFrame);
      return { ok, description: `reach ${a.reachState}${a.byFrame ? ` by ${a.byFrame}` : ""} (first=${first ?? "never"})` };
    }
    if ("reachAnyState" in a) {
      const firsts = a.reachAnyState
        .map((s) => stateFirstFrame.get(s))
        .filter((f): f is number => f !== undefined);
      const first = firsts.length ? Math.min(...firsts) : undefined;
      const ok = first !== undefined && (a.byFrame === undefined || first <= a.byFrame);
      return {
        ok,
        description: `reach any of ${a.reachAnyState.join("|")}${a.byFrame ? ` by ${a.byFrame}` : ""} (first=${first ?? "never"})`,
      };
    }
    if ("neverState" in a) {
      const first = stateFirstFrame.get(a.neverState);
      return {
        ok: first === undefined,
        description: `never ${a.neverState} (first=${first ?? "never"})`,
      };
    }
    const d = digests[a.frame - 1];
    if (!d) return { ok: false, description: `frame ${a.frame} out of range` };
    if ("state" in a) return { ok: d.state === a.state, description: `f${a.frame} state=${d.state} want ${a.state}` };
    if ("maxSpeed" in a) {
      const speed = Math.hypot(d.vx, d.vy);
      return { ok: speed <= a.maxSpeed, description: `f${a.frame} speed=${speed.toFixed(1)} <= ${a.maxSpeed}` };
    }
    if ("hasRope" in a) {
      const has = d.ropeLen !== null;
      return { ok: has === a.hasRope, description: `f${a.frame} hasRope=${has} want ${a.hasRope}` };
    }
    const ok =
      (a.minX === undefined || d.px >= a.minX) &&
      (a.maxX === undefined || d.px <= a.maxX) &&
      (a.minY === undefined || d.py >= a.minY) &&
      (a.maxY === undefined || d.py <= a.maxY);
    return {
      ok,
      description: `f${a.frame} pos=(${d.px.toFixed(1)},${d.py.toFixed(1)}) in x[${a.minX ?? "-∞"},${a.maxX ?? "∞"}] y[${a.minY ?? "-∞"},${a.maxY ?? "∞"}]`,
    };
  });

  const passed = violations.length === 0 && assertResults.every((r) => r.ok);
  return {
    level: script.level,
    framesRun: digests.length,
    violations,
    assertResults,
    digests,
    serializedFrames,
    passed,
  };
}
