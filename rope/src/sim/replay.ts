// Replays a Recording (input trace) deterministically, checking invariants and,
// if the bundle carries digests, flagging the first frame that diverges.
// Ported in spirit from tools/Replay.cs.

import { Level } from "../level/level";
import { BallLevel } from "../level/ballLevel";
import { LEVELS } from "../level/registry";
import {
  checkBallInvariants,
  checkInvariants,
  digest,
  digestBall,
  EnergyMonitor,
  RollMonitor,
  digestsEqual,
  digestDrift,
  DRIFT_EPSILON,
  inputDeserializer,
  StuckDetector,
  worldDigest,
  worldDigestBall,
  worldDigestDeltas,
  worldDigestDrift,
  worldDigestsEqual,
  type DigestFieldDelta,
  type Digest,
  type Recording,
  type Violation,
  type WorldDigest,
} from "./trace";

// One frame on which the replay's world digest differs from the recording's, and
// every field that carries the difference.
export interface Divergence {
  frame: number; // 1-based, as every other frame number in this tooling is
  fields: DigestFieldDelta[];
}

// The noise floor bit-exactness uses. A replay of a bundle recorded by the SAME
// engine is bit-exact or it is a determinism bug, so anything above zero is a
// real difference; the default is a hair above zero rather than zero itself so a
// last-bit difference in a quantity of order 1 does not fill the report.
export const DIVERGENCE_TOLERANCE = 1e-9;

// How many frames past the first divergence to keep. Five, because the question
// a first difference immediately raises is whether it GROWS: one lease
// instalment that is repaid next frame and one that is re-earned every frame
// look identical at the frame they appear on.
const DIVERGENCE_FRAMES = 6;

export interface ReplayOptions {
  // Absolute tolerance for the per-field divergence report (see `divergences`).
  divergenceTolerance?: number;
  // Which fields the report is allowed to consider, by name (`body#3.px`,
  // `chain.blockedSlack`). Restricting it moves the FIRST divergence too, which
  // is the point: asking where body#3 first differs and being answered about
  // body#0 is not an answer.
  divergenceField?: (name: string) => boolean;
}

export interface ReplayResult {
  level: string;
  framesRun: number;
  violations: Violation[];
  digests: Digest[];
  // 1-based frame where the replay *behaviourally* diverged (positional drift
  // past DRIFT_EPSILON or a state mismatch), or null. This is the honest signal.
  divergedAtFrame: number | null;
  // True when the first behavioural divergence was a state fork (the run took a
  // different branch), vs mere positional drift. null if it never diverged.
  divergedByStateFork: boolean | null;
  // 1-based frame of the first bit-exact mismatch, or null. Float noise on a
  // settled body trips this every recording; use it only for strict same-engine
  // determinism checks (selftest), never as a "the fix broke something" signal.
  bitDivergedAtFrame: number | null;
  // Largest positional drift (metres) between re-sim and recording over the run.
  maxDrift: number;
  healthy: boolean;
  // The same three questions asked of the WHOLE scene rather than of the avatar
  // (see WorldDigest). All null/zero when the bundle carries no `worldDigests` —
  // every bundle recorded before they existed, which replays exactly as before.
  worldDigests: WorldDigest[];
  worldDivergedAtFrame: number | null;
  // What carried the first behavioural divergence: `body#3`, `chain length`, …
  worldDivergedName: string | null;
  worldBitDivergedAtFrame: number | null;
  worldMaxDrift: number;
  worldMaxDriftName: string | null;
  // The first frame whose world digest differs from the recording field by
  // field, and the five after it. Empty when the bundle carries no
  // `worldDigests`, and empty when nothing differs.
  //
  // This is a different question from `worldDivergedAtFrame`, which asks how far
  // apart two runs are and therefore cannot see a difference that is not a
  // distance: the first difference between the browser and bun on 2026-09-04 was
  // `chain.blockedSlack` at f90 - one lease instalment, 8.33 mm - and the tools
  // reported `drifted @f98` on the avatar, eight frames late and on the wrong
  // quantity.
  divergences: Divergence[];
}

// Reconstruct the level a recording plays on. Self-contained bundles
// (level-editor exports) carry their own geometry; use it rather than the
// registry, which won't know the ad-hoc level.
export function levelFromRecording(rec: Recording): Level | BallLevel {
  if (rec.data) {
    return rec.controller === "ball" ? new BallLevel(rec.data) : new Level(rec.data);
  }
  const spec = LEVELS[rec.level];
  if (!spec) throw new Error(`Unknown level: ${rec.level}`);
  return spec.controller === "ball" ? new BallLevel(spec.data) : new Level(spec.data, spec.init);
}

export function replayRecording(rec: Recording, options: ReplayOptions = {}): ReplayResult {
  const tolerance = options.divergenceTolerance ?? DIVERGENCE_TOLERANCE;
  const fieldFilter = options.divergenceField;
  const level = levelFromRecording(rec);
  const deserialize = inputDeserializer();
  const digests: Digest[] = [];
  const worldDigests: WorldDigest[] = [];
  const violations: Violation[] = [];
  const stuck = new StuckDetector();
  // Ball levels only: the grapple avatar's locomotion is a forced body by
  // construction, and the mover levels contain scripted geometry that does real
  // work on whatever it touches, so an energy budget there is not an invariant
  // but a description of the level.
  const energy = new EnergyMonitor();
  const roll = new RollMonitor();
  let divergedAtFrame: number | null = null;
  let divergedByStateFork: boolean | null = null;
  let bitDivergedAtFrame: number | null = null;
  let maxDrift = 0;
  let worldDivergedAtFrame: number | null = null;
  let worldDivergedName: string | null = null;
  let worldBitDivergedAtFrame: number | null = null;
  let worldMaxDrift = 0;
  let worldMaxDriftName: string | null = null;
  const divergences: Divergence[] = [];

  for (let i = 0; i < rec.frames.length; i++) {
    const input = deserialize(rec.frames[i]!);
    level.physicsProcess(input, 1 / 60);
    const d = level instanceof BallLevel ? digestBall(level) : digest(level);
    digests.push(d);
    const wd = level instanceof BallLevel ? worldDigestBall(level) : worldDigest(level);
    worldDigests.push(wd);
    if (level instanceof BallLevel) {
      violations.push(...checkBallInvariants(level));
      const ev = energy.push(level, input);
      if (ev) violations.push(ev);
      const rv = roll.push(level);
      if (rv) violations.push(rv);
    } else {
      violations.push(...checkInvariants(level));
      const sv = stuck.push(level, input);
      if (sv) violations.push(sv);
    }
    const expected = rec.digests?.[i];
    if (expected) {
      if (bitDivergedAtFrame === null && !digestsEqual(d, expected)) bitDivergedAtFrame = i + 1;
      const drift = digestDrift(d, expected);
      if (Number.isFinite(drift)) maxDrift = Math.max(maxDrift, drift);
      if (divergedAtFrame === null && drift > DRIFT_EPSILON) {
        divergedAtFrame = i + 1;
        divergedByStateFork = !Number.isFinite(drift);
      }
    }
    const expectedWorld = rec.worldDigests?.[i];
    if (expectedWorld) {
      if (worldBitDivergedAtFrame === null && !worldDigestsEqual(wd, expectedWorld)) {
        worldBitDivergedAtFrame = i + 1;
      }
      const w = worldDigestDrift(wd, expectedWorld);
      if (Number.isFinite(w.drift) && w.drift > worldMaxDrift) {
        worldMaxDrift = w.drift;
        worldMaxDriftName = w.name;
      }
      if (worldDivergedAtFrame === null && w.drift > DRIFT_EPSILON) {
        worldDivergedAtFrame = i + 1;
        worldDivergedName = w.name;
      }
      // Collected on the first differing frame and the five after it, whether or
      // not anything differs on those five: "it appeared once and was repaid" and
      // "it is re-earned every frame" are the two answers, and only the frames
      // after the first can tell them apart.
      if (divergences.length < DIVERGENCE_FRAMES) {
        const all = worldDigestDeltas(wd, expectedWorld, tolerance);
        const fields = fieldFilter ? all.filter((f) => fieldFilter(f.name)) : all;
        // Collecting starts at the first frame that differs and then runs
        // whether or not the frames after it differ: a frame back in agreement
        // is exactly as much of an answer as one that has got worse.
        if (fields.length > 0 || divergences.length > 0) {
          divergences.push({ frame: i + 1, fields });
        }
      }
    }
  }

  return {
    level: rec.level,
    framesRun: digests.length,
    violations,
    digests,
    divergedAtFrame,
    divergedByStateFork,
    bitDivergedAtFrame,
    maxDrift,
    healthy: violations.length === 0,
    worldDigests,
    worldDivergedAtFrame,
    worldDivergedName,
    worldBitDivergedAtFrame,
    worldMaxDrift,
    worldMaxDriftName,
    divergences,
  };
}

// Where a bundle's replay first leaves its recording, field by field, or null if
// it never does (and null for a bundle carrying no `worldDigests`, which has
// nothing to be compared against).
//
// The first command to reach for on a bundle that does not replay: `cli replay`
// answers "it drifted", which is a statement about the avatar's position several
// frames after the fact, and every debugging session that started there spent
// its first hour finding the frame, the quantity and the phase by hand.
export function firstDivergence(
  rec: Recording,
  tolerance = DIVERGENCE_TOLERANCE,
): Divergence | null {
  return replayRecording(rec, { divergenceTolerance: tolerance }).divergences[0] ?? null;
}

// The first difference as one line, for the header `cli replay` and `cli dump`
// print. Null when there is nothing to say.
export function divergenceSummary(divergences: Divergence[]): string | null {
  const first = divergences[0];
  if (!first) return null;
  const worst = [...first.fields].sort((a, b) => b.delta - a.delta)[0];
  if (!worst) return null;
  return `first difference @f${first.frame} ${worst.name} ${worst.delta.toExponential(3)}` +
    (first.fields.length > 1 ? ` (+${first.fields.length - 1} more field(s))` : "");
}
