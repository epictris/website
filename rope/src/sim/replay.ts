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
  digestsEqual,
  digestDrift,
  DRIFT_EPSILON,
  inputDeserializer,
  StuckDetector,
  type Digest,
  type Recording,
  type Violation,
} from "./trace";

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

export function replayRecording(rec: Recording): ReplayResult {
  const level = levelFromRecording(rec);
  const deserialize = inputDeserializer();
  const digests: Digest[] = [];
  const violations: Violation[] = [];
  const stuck = new StuckDetector();
  let divergedAtFrame: number | null = null;
  let divergedByStateFork: boolean | null = null;
  let bitDivergedAtFrame: number | null = null;
  let maxDrift = 0;

  for (let i = 0; i < rec.frames.length; i++) {
    const input = deserialize(rec.frames[i]!);
    level.physicsProcess(input, 1 / 60);
    const d = level instanceof BallLevel ? digestBall(level) : digest(level);
    digests.push(d);
    if (level instanceof BallLevel) {
      violations.push(...checkBallInvariants(level));
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
  };
}
