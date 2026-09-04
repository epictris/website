// The numbers every physics decision is actually made on, for one bundle.
//
// On 2026-09-04 each candidate fix was judged by a scratch scanner that replayed
// ten bundles and printed peak speed, the longest push-credit run and the worst
// over-length, then was re-run with env-var toggles to get the pre-fix column.
// `cli compare` answers one frame of one bundle and the suite answers pass/fail,
// so the question "did this change make the corpus better or worse" had no
// standing tool at all. This is that scanner, standing, and `cli ab` is the
// table it prints.
//
// Every metric is `number | null`, and null means **not available on this
// revision** rather than zero. The A/B column is produced by running this file
// inside a worktree of an older tree (see `cli ab --ref`), where a field it
// reads may simply not exist yet; reporting that as 0 would say the old tree
// scored perfectly on a metric it cannot express. Hence `num()` below, which is
// deliberately written against `unknown`.

import { BallLevel } from "../level/ballLevel";
import { RigidBody2D } from "../engine/body";
import { BallHook } from "../classes/ballHook";
import {
  checkBallInvariants,
  checkInvariants,
  EnergyMonitor,
  inputDeserializer,
  RollMonitor,
  StuckDetector,
  worldDigestBall,
  worldDigest,
  worldDigestDeltas,
  type Recording,
} from "./trace";
import { levelFromRecording } from "./replay";
import { DIVERGENCE_TOLERANCE } from "./replay";

export interface BundleMetrics {
  bundle: string;
  frames: number;
  // Fastest the ball (or grapple avatar) went anywhere in the run, m/s.
  peakV: number | null;
  // Fastest the body the chain's far end sits on went, m/s. The other half of
  // every two-body interaction, and the half no avatar-shaped tool could see:
  // the ball and its 12.6 kg anchor left together at 19 m/s in `session-324f`
  // and only one of them was being measured.
  peakAnchorV: number | null;
  // High-water mark of the blocked-length lease, m (`Rope.blockedSlack`).
  maxLease: number | null;
  // Worst the anchored chain measured over its enforced length, m.
  worstOverLength: number | null;
  // Longest run of consecutive frames the chain phase paid the ball push-out
  // credit above `BallLevel.PUSH_CREDIT_SPEED`. What distinguishes a PUMP from a
  // flick is that it is re-earned for as long as its cause lasts: 18 consecutive
  // frames on `session-324f` against a corpus that never strings 3 together.
  pushRun: number | null;
  // Largest one-frame speed the length solve added beyond what the frame's own
  // winding entitled it to, m/s.
  maxSolveKick: number | null;
  // Largest unforced energy gain the `EnergyMonitor` saw, J.
  energyGain: number | null;
  // How many invariants fired over the run.
  violations: number;
  // The frame the replay first differs from the recording on, field by field
  // (see `worldDigestDeltas`); **0** when it never does, and null when the
  // bundle carries no world digests at all.
  //
  // The two are not the same answer and the table must not print them the same
  // way: "this replays exactly" and "this recorded nothing to compare against"
  // are opposite pieces of evidence.
  divergedAt: number | null;
}

// Present-and-finite, or null. Written against `unknown` on purpose: this file
// is run inside worktrees of older revisions whose `BallLevel` has never heard
// of half the fields below, and there the typed value is simply not there.
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Running maximum that stays null until it sees a real number, so "the field
// does not exist here" and "the field was zero all run" stay distinguishable.
function keepMax(current: number | null, next: number | null): number | null {
  if (next === null) return current;
  return current === null ? next : Math.max(current, next);
}

export function bundleMetrics(rec: Recording, name: string): BundleMetrics {
  const level = levelFromRecording(rec);
  const deserialize = inputDeserializer();
  const energy = new EnergyMonitor();
  const roll = new RollMonitor();
  const stuck = new StuckDetector();
  let violations = 0;
  let peakV: number | null = null;
  let peakAnchorV: number | null = null;
  let maxLease: number | null = null;
  let worstOverLength: number | null = null;
  let pushRun: number | null = null;
  let maxSolveKick: number | null = null;
  let divergedAt: number | null = rec.worldDigests?.length ? 0 : null;

  for (let i = 0; i < rec.frames.length; i++) {
    const input = deserialize(rec.frames[i]!);
    level.physicsProcess(input, 1 / 60);

    if (level instanceof BallLevel) {
      violations += checkBallInvariants(level).length;
      if (energy.push(level, input)) violations++;
      if (roll.push(level)) violations++;
      const ball = level.ball;
      peakV = keepMax(peakV, num(ball.linearVelocity.length()));
      pushRun = keepMax(pushRun, num((level as { chainPushCreditFrames?: unknown }).chainPushCreditFrames));
      const gain = num((level as { chainSolveSpeedGain?: unknown }).chainSolveSpeedGain);
      const budget = num((level as { chainWinchSpeedBudget?: unknown }).chainWinchSpeedBudget);
      if (gain !== null) maxSolveKick = keepMax(maxSolveKick, gain - (budget ?? 0));
      const chain = ball.chain;
      if (chain) {
        maxLease = keepMax(maxLease, num((chain as { blockedSlack?: unknown }).blockedSlack));
        const constraint = num((chain as { constraintLength?: unknown }).constraintLength);
        // Only while ANCHORED: a chain still deploying is legitimately whatever
        // length the hook has reached, and measuring it over is measuring the
        // shot.
        if (constraint !== null && ball.chainAnchored) {
          worstOverLength = keepMax(worstOverLength, chain.getCurrentLength() - constraint);
        }
        // The body the chain ENDS on, and not the hook still flying towards it:
        // `BallHook` is a RigidBody2D, so the shot itself would otherwise be
        // measured as an anchor doing 12 m/s in every single bundle.
        const anchor = chain.end.contact.obj;
        if (anchor instanceof RigidBody2D && !(anchor instanceof BallHook)) {
          peakAnchorV = keepMax(peakAnchorV, num(anchor.linearVelocity.length()));
        }
      }
    } else {
      violations += checkInvariants(level).length;
      if (stuck.push(level, input)) violations++;
      peakV = keepMax(peakV, num(level.player.velocity.length()));
    }

    const expected = rec.worldDigests?.[i];
    if (expected && divergedAt === 0) {
      const wd = level instanceof BallLevel ? worldDigestBall(level) : worldDigest(level);
      if (worldDigestDeltas(wd, expected, DIVERGENCE_TOLERANCE).length > 0) divergedAt = i + 1;
    }
  }

  return {
    bundle: name,
    frames: rec.frames.length,
    peakV,
    peakAnchorV,
    maxLease,
    worstOverLength,
    pushRun,
    maxSolveKick,
    energyGain: num((energy as { worstGain?: unknown }).worstGain),
    violations,
    divergedAt,
  };
}

// The metric columns, in the order the table prints them, with how each is
// formatted. Kept as data so the table, its maxima row and the JSON form cannot
// disagree about what a column is.
export const METRIC_COLUMNS = [
  { key: "peakV", label: "peakV", unit: "m/s", digits: 2 },
  { key: "peakAnchorV", label: "anchorV", unit: "m/s", digits: 2 },
  { key: "maxLease", label: "lease", unit: "m", digits: 3 },
  { key: "worstOverLength", label: "overLen", unit: "m", digits: 3 },
  { key: "pushRun", label: "pushRun", unit: "f", digits: 0 },
  { key: "maxSolveKick", label: "solveKick", unit: "m/s", digits: 2 },
  { key: "energyGain", label: "energy", unit: "J", digits: 3 },
  { key: "violations", label: "viol", unit: "", digits: 0 },
  { key: "divergedAt", label: "divAt", unit: "f", digits: 0 },
] as const satisfies readonly { key: keyof BundleMetrics; label: string; unit: string; digits: number }[];

export type MetricKey = (typeof METRIC_COLUMNS)[number]["key"];

export function metricValue(m: BundleMetrics, key: MetricKey): number | null {
  const v = m[key];
  return typeof v === "number" ? v : null;
}
