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
  // 1-based frame where replay diverged from the recorded digests, or null.
  divergedAtFrame: number | null;
  healthy: boolean;
}

export function replayRecording(rec: Recording): ReplayResult {
  // Self-contained bundles (level-editor exports) carry their own geometry; use
  // it rather than the registry, which won't know the ad-hoc level.
  let isBall: boolean;
  let level: Level | BallLevel;
  if (rec.data) {
    isBall = rec.controller === "ball";
    level = isBall ? new BallLevel(rec.data) : new Level(rec.data);
  } else {
    const spec = LEVELS[rec.level];
    if (!spec) throw new Error(`Unknown level: ${rec.level}`);
    isBall = spec.controller === "ball";
    level = isBall ? new BallLevel(spec.data) : new Level(spec.data, spec.init);
  }
  const deserialize = inputDeserializer();
  const digests: Digest[] = [];
  const violations: Violation[] = [];
  const stuck = new StuckDetector();
  let divergedAtFrame: number | null = null;

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
    if (rec.digests && divergedAtFrame === null) {
      const expected = rec.digests[i];
      if (expected && !digestsEqual(d, expected)) divergedAtFrame = i + 1;
    }
  }

  return {
    level: rec.level,
    framesRun: digests.length,
    violations,
    digests,
    divergedAtFrame,
    healthy: violations.length === 0,
  };
}
