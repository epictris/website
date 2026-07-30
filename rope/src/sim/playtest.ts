// Headless scripted playtest driver, ported in spirit from tools/Playtest.cs +
// ScriptedInputSource.cs. Drives the sim from a frame-indexed schedule of held
// buttons and mouse aim, checks invariants every frame, and evaluates asserts.

import { Vec2 } from "../engine/vec2";
import { button, emptyFrameInput, type ButtonInput, type FrameInput } from "../input/frameInput";
import { Level, type LevelSpec } from "../level/level";
import { LEVELS } from "../level/registry";
import {
  checkBallInvariants,
  checkInvariants,
  digest,
  digestBall,
  EnergyMonitor,
  kineticEnergy,
  serializeInput,
  StuckDetector,
  worldDigest,
  worldDigestBall,
  type Digest,
  type SerializedFrame,
  type Violation,
  type WorldDigest,
} from "./trace";
import { deepestEmbedding } from "./query";
import { BallLevel } from "../level/ballLevel";
import { PIXELS_PER_METER } from "../engine/units";
import type { LevelData } from "../level/levelFormat";

export type PlaytestAction =
  | "move_left"
  | "move_right"
  | "jump"
  | "retract"
  | "extend"
  | "fire"
  | "deploy"
  | "restart"
  | "retract_click"
  | "spawn_small"
  | "spawn_large";

// The ball controller maps its own actions onto the same FrameInput fields the
// recorder serializes (aim→mouseWorldPosition, deploy→fire, restart→jump), so a
// ball script drives exactly the input stream a recorded session carries.
// `deploy` and `restart` are those two under the names the ball controller uses,
// which is what stops a ball script reading as if it were pressing a fire button
// and jumping.
const ACTION_FIELD: Record<PlaytestAction, keyof FrameInput> = {
  move_left: "moveLeft",
  move_right: "moveRight",
  jump: "jump",
  retract: "retract",
  extend: "extend",
  fire: "fire",
  deploy: "fire",
  restart: "jump",
  retract_click: "retractClick",
  spawn_small: "spawnSmallCircle",
  spawn_large: "spawnLargeCircle",
};

// Each input field once, in a fixed order (the aliases collapse). Iterated to
// build a frame, so the order is part of the deterministic input stream.
const INPUT_FIELDS: (keyof FrameInput)[] = [
  ...new Set(Object.values(ACTION_FIELD)),
];

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
// A window assert: bounds on what the scene did over a range of frames rather
// than at an instant.
//
// This is the shape a MECHANIC has to be asserted in, and mechanics are the
// thing the metrics could not defend: an A/B that wins every drift and runaway
// number can still have destroyed winding, rolling or swinging, and one did -
// the variant that beat every number in `session-475f` had simply stopped the
// chain winding at all. "The ball travelled at least 40 cm along this floor" and
// "the chain wound on at least twelve nodes" are statements no aggregate can be
// substituted for.
//
// Every field is optional and every one is a bound, never an exact value: these
// are behavioural claims, and pinning them to a number would make any physically
// fine change fail.
export interface WindowAssert {
  window: { from: number; to: number };
  // Ceiling on the fastest the avatar goes anywhere in the window.
  maxSpeed?: number;
  // Ceiling on how far it strays from where it started the window (m).
  maxDrift?: number;
  // Signed travel along x over the window (m) — a floor for "it rolled", a
  // ceiling for "it did not drive itself sideways".
  minTravelX?: number;
  maxTravelX?: number;
  // Ceiling on kinetic energy anywhere in the window (J) — "it is at rest".
  maxKinetic?: number;
  // Ceiling on how much the chain's enforced length grows over the window (m).
  maxChainGrowth?: number;
  // Floor on the wrap-path node count reached — the chain wound on.
  minChainNodes?: number;
  // Floor on how much closer to its anchor the ball got (m) — the winch.
  minAnchorApproach?: number;
  // Floor on how many times the ball crossed under its anchor — a swing that
  // swings, rather than a ball hanging in place.
  minSwings?: number;
  // Ceiling on how far into geometry the avatar was at any point (m).
  maxEmbed?: number;
}

export type PlaytestAssert =
  | { frame: number; state: string }
  | { frame: number; maxSpeed: number }
  | { frame: number; hasRope: boolean }
  | { frame: number; minX?: number; maxX?: number; minY?: number; maxY?: number }
  | { reachState: string; byFrame?: number }
  | { reachAnyState: string[]; byFrame?: number }
  | { neverState: string }
  | WindowAssert;

export interface PlaytestScript {
  level: string;
  frames: number;
  holds?: HoldRange[];
  mouse?: MouseRange[];
  // `aim` is `mouse` under the name the ball controller uses. One list, two
  // spellings: for the ball the mouse position IS the aim point, and a ball
  // script that spoke of "mouse" ranges would be describing a device the
  // controller does not require.
  aim?: MouseRange[];
  asserts?: PlaytestAssert[];
  // Self-contained scripts carry their own geometry, exactly as a bundle does
  // (see Recording.data). A mechanic is asserted against the arena that isolates
  // it — a ceiling and an anchor, a floor and nothing else — and pinning those
  // scenarios to whatever the authored level happens to look like this month
  // would make them fail for reasons that are not the mechanic's.
  data?: LevelData;
  controller?: "grapple" | "ball";
  // Where the avatar starts, in METRES (the rest of the level format is in
  // scene pixels). Overrides the level's own spawn without editing it.
  spawn?: { x: number; y: number };
}

function inRange(frame: number, from: number, to: number): boolean {
  return frame >= from && frame <= to;
}

class ScriptedInput {
  private prev: FrameInput = emptyFrameInput();
  constructor(private script: PlaytestScript) {}

  sample(frame: number, playerPos: Vec2): FrameInput {
    // Held FIELDS, not held actions: two actions may name the same field
    // (`deploy` is `fire` under the ball controller's name for it), and writing
    // the field once per action let the second name overwrite the first with
    // "not held" — a held fire button silently released by an alias nobody used.
    const held = new Set<keyof FrameInput>();
    for (const h of this.script.holds ?? []) {
      if (inRange(frame, h.from, h.to)) held.add(ACTION_FIELD[h.action]);
    }
    // The avatar's own position means "not aiming" for the ball controller (see
    // BallInputSource), so an uncovered frame leaves the ball's rotation to the
    // physics rather than steering it at itself.
    let mouse = playerPos;
    for (const m of [...(this.script.mouse ?? []), ...(this.script.aim ?? [])]) {
      if (inRange(frame, m.from, m.to)) {
        mouse = m.relative ? playerPos.add(new Vec2(m.x, m.y)) : new Vec2(m.x, m.y);
      }
    }

    const input = emptyFrameInput();
    input.mouseWorldPosition = mouse;
    for (const field of INPUT_FIELDS) {
      (input[field] as ButtonInput) = button(held.has(field), this.prev[field] as ButtonInput);
    }
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
  // The whole scene per frame, so a run recorded from a script carries the same
  // evidence a browser bundle does (see WorldDigest).
  worldDigests: WorldDigest[];
  // The exact per-frame inputs fed, so the run can be replayed as a Recording.
  serializedFrames: SerializedFrame[];
  passed: boolean;
}

// The level a script runs on: its own embedded geometry if it carries any, the
// registry otherwise. A `spawn` override is baked into the data rather than
// written onto the level afterwards, so a reset (and any bundle recorded from
// the run) starts from the same point — the same rule the editor's spawn-at-
// cursor test follows.
export function scriptSpec(script: PlaytestScript, specOverride?: LevelSpec): LevelSpec {
  const base: LevelSpec | undefined =
    specOverride ??
    (script.data
      ? // `LevelSpec.controller` spells the grapple case as absent rather than
        // as "grapple", so a script saying "grapple" out loud lands on the same
        // thing every registry entry does.
        { data: script.data, controller: script.controller === "ball" ? ("ball" as const) : undefined }
      : LEVELS[script.level]);
  if (!base) throw new Error(`Unknown level: ${script.level}`);
  if (!script.spawn) return base;
  return {
    ...base,
    data: {
      ...base.data,
      // The script speaks metres; the level format is authored in scene pixels.
      player: {
        ...base.data.player,
        x: script.spawn.x * PIXELS_PER_METER,
        y: script.spawn.y * PIXELS_PER_METER,
      },
    },
  };
}

// `specOverride` runs the script on an ad-hoc level (the ledge matrix builds
// its geometry programmatically); script.level is then only a label.
export function runScript(script: PlaytestScript, specOverride?: LevelSpec): PlaytestResult {
  const spec = scriptSpec(script, specOverride);
  if (spec.controller === "ball") return runBallScript(script, spec);
  const level = new Level(spec.data, spec.init);
  let resetFired = false;
  level.onReset = () => {
    resetFired = true;
  };

  const src = new ScriptedInput(script);
  const digests: Digest[] = [];
  const worldDigests: WorldDigest[] = [];
  const serializedFrames: SerializedFrame[] = [];
  const stats: FrameStat[] = [];
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
    worldDigests.push(worldDigest(level));
    stats.push(frameStat(level));
    if (!statesSeen.has(d.state)) {
      statesSeen.add(d.state);
      stateFirstFrame.set(d.state, f);
    }
    violations.push(...checkInvariants(level));
    const sv = stuck.push(level, input);
    if (sv) violations.push(sv);
  }

  const assertResults = evaluateAsserts(script, digests, stateFirstFrame, stats);
  const passed = violations.length === 0 && assertResults.every((r) => r.ok);
  return {
    level: script.level,
    framesRun: digests.length,
    violations,
    assertResults,
    digests,
    worldDigests,
    serializedFrames,
    passed,
  };
}

// Per-frame numbers the window asserts are evaluated against. Collected for both
// controllers so a window assert means the same thing whichever is running, and
// the fields a given controller cannot answer are null rather than zero — an
// assert on a number that was never measured must fail, not pass.
interface FrameStat {
  pos: Vec2;
  speed: number;
  kinetic: number;
  chainNodes: number | null;
  constraintLength: number | null;
  anchor: Vec2 | null;
  embed: number;
}

function frameStat(level: Level | BallLevel): FrameStat {
  const rope = level instanceof BallLevel ? level.ball.chain : level.player.rope;
  const body = level instanceof BallLevel ? level.ball : level.player;
  const velocity = level instanceof BallLevel ? level.ball.linearVelocity : level.player.velocity;
  // An anchored chain's far end is the anchor; while the hook is still flying
  // there is nothing to measure an approach against.
  const anchored = level instanceof BallLevel ? level.ball.chainAnchored : rope !== null;
  const embed = deepestEmbedding(level.world, body);
  return {
    pos: body.globalPosition,
    speed: velocity.length(),
    kinetic: kineticEnergy(level.world),
    chainNodes: rope ? rope.path().length : null,
    constraintLength: rope ? rope.constraintLength : null,
    anchor: rope && anchored ? rope.end.contact.globalPosition : null,
    embed: embed ? embed.depth : 0,
  };
}

// A window assert, evaluated over the frames it names. Each bound is reported
// with the number it was measured against, so a failure says what happened
// rather than that something did.
function evaluateWindow(a: WindowAssert, stats: FrameStat[]): AssertResult {
  const from = Math.max(1, a.window.from);
  const to = Math.min(stats.length, a.window.to);
  const slice = stats.slice(from - 1, to);
  if (slice.length === 0) {
    return { ok: false, description: `window f${a.window.from}..${a.window.to} is empty` };
  }
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const parts: string[] = [];
  let ok = true;
  const check = (pass: boolean, text: string): void => {
    if (!pass) ok = false;
    parts.push(`${pass ? "" : "!"}${text}`);
  };

  if (a.maxSpeed !== undefined) {
    const worst = Math.max(...slice.map((s) => s.speed));
    check(worst <= a.maxSpeed, `maxSpeed=${worst.toFixed(4)}<=${a.maxSpeed}`);
  }
  if (a.maxDrift !== undefined) {
    const worst = Math.max(...slice.map((s) => s.pos.distanceTo(first.pos)));
    check(worst <= a.maxDrift, `drift=${worst.toFixed(4)}<=${a.maxDrift}`);
  }
  if (a.minTravelX !== undefined) {
    const travel = last.pos.x - first.pos.x;
    check(travel >= a.minTravelX, `travelX=${travel.toFixed(4)}>=${a.minTravelX}`);
  }
  if (a.maxTravelX !== undefined) {
    const travel = Math.max(...slice.map((s) => Math.abs(s.pos.x - first.pos.x)));
    check(travel <= a.maxTravelX, `|travelX|=${travel.toFixed(4)}<=${a.maxTravelX}`);
  }
  if (a.maxKinetic !== undefined) {
    const worst = Math.max(...slice.map((s) => s.kinetic));
    check(worst <= a.maxKinetic, `maxKE=${worst.toExponential(2)}<=${a.maxKinetic}`);
  }
  if (a.maxEmbed !== undefined) {
    const worst = Math.max(...slice.map((s) => s.embed));
    check(worst <= a.maxEmbed, `maxEmbed=${worst.toFixed(4)}<=${a.maxEmbed}`);
  }
  if (a.minChainNodes !== undefined) {
    const nodes = slice.map((s) => s.chainNodes).filter((n): n is number => n !== null);
    const best = nodes.length ? Math.max(...nodes) : null;
    check(best !== null && best >= a.minChainNodes, `chainNodes=${best ?? "no chain"}>=${a.minChainNodes}`);
  }
  if (a.maxChainGrowth !== undefined) {
    const lens = slice.map((s) => s.constraintLength).filter((n): n is number => n !== null);
    const base = lens[0];
    const growth = base === undefined ? null : Math.max(...lens) - base;
    check(growth !== null && growth <= a.maxChainGrowth, `chainGrowth=${growth?.toFixed(4) ?? "no chain"}<=${a.maxChainGrowth}`);
  }
  if (a.minAnchorApproach !== undefined) {
    const dists = slice
      .map((s) => (s.anchor ? s.pos.distanceTo(s.anchor) : null))
      .filter((d): d is number => d !== null);
    const approach = dists.length ? dists[0]! - Math.min(...dists) : null;
    check(
      approach !== null && approach >= a.minAnchorApproach,
      `anchorApproach=${approach?.toFixed(4) ?? "no anchor"}>=${a.minAnchorApproach}`,
    );
  }
  if (a.minSwings !== undefined) {
    let swings = 0;
    let side = 0;
    for (const s of slice) {
      if (!s.anchor) continue;
      const now = Math.sign(s.pos.x - s.anchor.x);
      if (now !== 0 && side !== 0 && now !== side) swings++;
      if (now !== 0) side = now;
    }
    check(swings >= a.minSwings, `swings=${swings}>=${a.minSwings}`);
  }
  return { ok, description: `f${from}..${to} ${parts.join(" ")}` };
}

function evaluateAsserts(
  script: PlaytestScript,
  digests: Digest[],
  stateFirstFrame: Map<string, number>,
  stats: FrameStat[],
): AssertResult[] {
  return (script.asserts ?? []).map((a) => {
    if ("window" in a) return evaluateWindow(a, stats);
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
}

// The ball & chain driver. Deliberately its own loop rather than a branch inside
// the grapple one: the two controllers share the input stream and nothing else,
// and the ball has no state machine, no stuck detector (it has no locomotion
// input to freeze) and its own invariants.
function runBallScript(script: PlaytestScript, spec: LevelSpec): PlaytestResult {
  const level = new BallLevel(spec.data);
  let resetFired = false;
  level.onReset = () => {
    resetFired = true;
  };

  const src = new ScriptedInput(script);
  const digests: Digest[] = [];
  const worldDigests: WorldDigest[] = [];
  const serializedFrames: SerializedFrame[] = [];
  const stats: FrameStat[] = [];
  const violations: Violation[] = [];
  const energy = new EnergyMonitor();
  const stateFirstFrame = new Map<string, number>();

  for (let f = 1; f <= script.frames && !resetFired; f++) {
    const input = src.sample(f, level.ball.globalPosition);
    serializedFrames.push(serializeInput(input));
    level.physicsProcess(input, 1 / 60);
    const d = digestBall(level);
    digests.push(d);
    worldDigests.push(worldDigestBall(level));
    stats.push(frameStat(level));
    if (!stateFirstFrame.has(d.state)) stateFirstFrame.set(d.state, f);
    violations.push(...checkBallInvariants(level));
    const ev = energy.push(level, input);
    if (ev) violations.push(ev);
  }

  const assertResults = evaluateAsserts(script, digests, stateFirstFrame, stats);
  const passed = violations.length === 0 && assertResults.every((r) => r.ok);
  return {
    level: script.level,
    framesRun: digests.length,
    violations,
    assertResults,
    digests,
    worldDigests,
    serializedFrames,
    passed,
  };
}
