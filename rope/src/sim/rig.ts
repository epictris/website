// A headless scenario as ten lines of data.
//
// `rig.ts`, `hold.ts`, `crush.ts`, `creep.ts` and the hung-anchor leg were each
// thirty to sixty lines of identical wiring on 2026-09-04 - build this arena,
// fire at that body, wind the aim up, hold or whirl it, measure - differing only
// in the arena and the aim pattern, and every one of them was thrown away at the
// end of the day. The committed playtests carry the same expansion by hand:
// `ball-ceiling-hold.json` is 110 aim ranges spelling out "circle the aim, once
// every 24 frames, for 640 frames".
//
// A rig says that in one line. It expands to an ordinary `PlaytestScript`
// (`rigToPlaytest`), which is what makes a rig committable: `cli rig --save`
// writes a playtest `cli play` runs, and asserts are added to it by hand
// afterwards. There is exactly one execution path - `runRig` runs the expansion,
// not a parallel driver - so a saved rig cannot behave differently from the rig
// that produced it.

import type { RawLevelData } from "../level/levelFormat";
import { recordScript } from "./record";
import { bundleMetrics, type BundleMetrics } from "./metrics";
import type { MouseRange, PlaytestResult, PlaytestScript } from "./playtest";
import type { Recording, WorldDigest } from "./trace";

// How the aim is driven once the chain is up.
export type RigDrive =
  // Aim held at a fixed bearing from the ball, degrees clockwise from +x (screen
  // axes, so +y is down). The steady-hold case.
  | { kind: "hold"; deg: number; frames: number }
  // Aim circling the ball, `period` frames per revolution. The wind-up case, and
  // what every crush and pump scenario is driven by.
  | { kind: "whirl"; period: number; frames: number }
  // Aim held at a fixed WORLD point, metres. The "drag it that way" case.
  | { kind: "aimAt"; x: number; y: number; frames: number };

export interface RigSpec {
  // Names the rig in output and in the saved playtest's `level` field.
  name?: string;
  // The arena, inline, exactly as a playtest or a bundle carries it (scene
  // pixels; see `RawLevelData`).
  data: RawLevelData;
  // Where the ball starts, in METRES, overriding the level's own marker.
  spawn?: { x: number; y: number };
  // Where to shoot, in world METRES. Deploy is held from frame 1 and the aim is
  // on this point for the frames the hook needs to get there.
  fireAt: { x: number; y: number };
  // Whirl the aim before the drive begins. `until: "riding"` whirls until the
  // ball is riding the body its chain ends on - the state every wound-tight
  // scenario starts from, and the one that takes a different number of frames to
  // reach in every arena. `until: N` is N frames flat.
  windUp?: { until: "riding" | number; period?: number };
  drive: RigDrive;
}

// Frames spent aiming at `fireAt` before the wind-up takes the aim over. The
// hook has to be given time to reach and attach, and the aim is what points it:
// a wind-up that starts on frame 2 steers the shot itself.
const AIM_LEAD = 20;
// Default frames per revolution for a whirl. Six frames a quarter-turn is what
// the hand-written wind-ups all used.
const DEFAULT_PERIOD = 24;
// Aim samples per revolution. The aim is a POSITION, so a whirl is a sequence of
// held bearings rather than a continuous sweep; 24 is one every 15 degrees,
// which is smooth at the ball's scale and keeps a saved playtest readable.
const WHIRL_STEPS = 24;
// How long the ball must be in contact with its anchor before the wind-up counts
// as having reached "riding". A glancing touch on the way past is not the state
// the rig is trying to reach.
const RIDING_FRAMES = 5;
// Ceiling on the wind-up probe. A rig whose ball never reaches its anchor says
// so rather than whirling for ever.
const RIDING_PROBE_LIMIT = 900;

// One aim range per sample, `relative: true` so the bearing follows the ball.
function whirlRanges(from: number, frames: number, period: number): MouseRange[] {
  const out: MouseRange[] = [];
  if (frames <= 0) return out;
  const hold = Math.max(1, Math.round(period / WHIRL_STEPS));
  for (let i = 0; ; i++) {
    const start = from + i * hold;
    if (start > from + frames - 1) break;
    const angle = (2 * Math.PI * (i * hold)) / period;
    out.push({
      from: start,
      to: Math.min(start + hold - 1, from + frames - 1),
      x: round4(Math.cos(angle)),
      y: round4(Math.sin(angle)),
      relative: true,
    });
  }
  return out;
}

// Four decimals is a tenth of a millimetre on a unit bearing, and it keeps a
// saved playtest from being a wall of 17-digit floats.
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function driveRanges(from: number, drive: RigDrive): MouseRange[] {
  if (drive.frames <= 0) return [];
  if (drive.kind === "whirl") return whirlRanges(from, drive.frames, drive.period);
  const to = from + drive.frames - 1;
  if (drive.kind === "hold") {
    const a = (drive.deg * Math.PI) / 180;
    return [{ from, to, x: round4(Math.cos(a)), y: round4(Math.sin(a)), relative: true }];
  }
  return [{ from, to, x: drive.x, y: drive.y }];
}

// Frames of wind-up, resolving `until: "riding"` by running the wind-up alone
// and looking for the state in its own world digests.
//
// It is a probe rather than a formula because "riding its anchor" is a fact
// about a simulation, not about a spec, and it lands on a different frame in
// every arena. Deterministic, since the probe is the same sim: the same spec
// resolves to the same number every time, which is what lets a saved playtest be
// the rig.
export function resolveWindUp(spec: RigSpec): number {
  const windUp = spec.windUp;
  if (!windUp) return 0;
  if (typeof windUp.until === "number") return windUp.until;
  const probe = buildScript(spec, RIDING_PROBE_LIMIT, { kind: "hold", deg: 0, frames: 0 });
  const { result } = recordScript(probe);
  let run = 0;
  for (const wd of result.worldDigests) {
    // Both halves come from the world digest itself: the chain's `anchorBody`
    // and the ball's strongest contact. Neither existed before the chain-phase
    // digest fields landed, and this is precisely the question they were added
    // for - which body is the other half, and is it being pressed against.
    const anchor = wd.chain?.anchorBody ?? null;
    const ball = wd.bodies.find((b) => b.id === 0);
    const riding = anchor !== null && ball !== undefined && ball.contactWith === anchor;
    run = riding ? run + 1 : 0;
    if (run >= RIDING_FRAMES) return wd.frame;
  }
  return RIDING_PROBE_LIMIT;
}

function buildScript(spec: RigSpec, windUpFrames: number, drive: RigDrive): PlaytestScript {
  const period = spec.windUp?.period ?? DEFAULT_PERIOD;
  const windUpFrom = AIM_LEAD + 1;
  const driveFrom = windUpFrom + windUpFrames;
  const frames = driveFrom + drive.frames - 1;
  return {
    level: spec.name ?? "rig",
    controller: "ball",
    frames,
    ...(spec.spawn ? { spawn: spec.spawn } : {}),
    data: spec.data,
    // Deploy from frame 1: the aim is already on `fireAt`, so the shot leaves in
    // the right direction on the frame it is fired, and holding it for the run
    // is what keeps the chain attached.
    holds: [{ action: "deploy", from: 1, to: frames }],
    aim: [
      { from: 1, to: AIM_LEAD, x: spec.fireAt.x, y: spec.fireAt.y },
      ...whirlRanges(windUpFrom, windUpFrames, period),
      ...driveRanges(driveFrom, drive),
    ],
  };
}

// The rig as an ordinary playtest. Committable as-is: add `asserts` by hand and
// `cli play` runs it like any other.
export function rigToPlaytest(spec: RigSpec): PlaytestScript {
  return buildScript(spec, resolveWindUp(spec), spec.drive);
}

// One frame of a rig, in the quantities a rig is read on. Taken straight from
// the run's world digests rather than by re-simulating: since the chain phase
// writes its decisions into the digest, everything here is already recorded.
export interface RigSample {
  frame: number;
  ballSpeed: number;
  anchorSpeed: number | null;
  lease: number;
  overLength: number;
  pushCredit: number;
  aimSpin: number;
  nodes: number;
}

export interface RigResult {
  spec: RigSpec;
  script: PlaytestScript;
  // Frames of wind-up the spec resolved to. For `until: "riding"` this is the
  // answer the probe found, and it is the number a reader wants first.
  windUpFrames: number;
  // A real bundle, so a rig that finds something is immediately a repro every
  // other command in this tooling can read.
  recording: Recording;
  playtest: PlaytestResult;
  metrics: BundleMetrics;
  series: RigSample[];
}

function rigSeries(worldDigests: WorldDigest[]): RigSample[] {
  return worldDigests.map((wd) => {
    const ball = wd.bodies.find((b) => b.id === 0);
    const anchorId = wd.chain?.anchorBody ?? null;
    const anchor = anchorId === null ? undefined : wd.bodies.find((b) => b.id === anchorId);
    const chain = wd.chain;
    return {
      frame: wd.frame,
      ballSpeed: ball ? Math.hypot(ball.vx, ball.vy) : 0,
      anchorSpeed: anchor ? Math.hypot(anchor.vx, anchor.vy) : null,
      lease: chain?.blockedSlack ?? 0,
      // Against the length the solver actually enforces, which is the rope's own
      // length plus the lease - the same quantity `worstOverLength` measures.
      overLength: chain ? chain.pathLen - (chain.maxRope + chain.blockedSlack) : 0,
      pushCredit: chain?.pushCredit ?? 0,
      aimSpin: chain?.aimSpin ?? 0,
      nodes: chain?.nodes ?? 0,
    };
  });
}

export function runRig(spec: RigSpec): RigResult {
  const windUpFrames = resolveWindUp(spec);
  const script = buildScript(spec, windUpFrames, spec.drive);
  const { recording, result } = recordScript(script);
  return {
    spec,
    script,
    windUpFrames,
    recording,
    playtest: result,
    metrics: bundleMetrics(recording, spec.name ?? "rig"),
    series: rigSeries(result.worldDigests),
  };
}
