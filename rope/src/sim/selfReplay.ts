// Does this bundle replay on the machine that made it?
//
// The browser and bun disagreed on a 1e-17 m overlap on 2026-09-04 - one read it
// as a surface refusing the chain's correction, the other as clear - and the two
// then disagreed about 8.3 mm of stall lease for good. Nothing in the download
// path could know that, so the disagreement surfaced only when a bundle was
// replayed somewhere else, hours later, and read as a physics bug rather than as
// a determinism one.
//
// So the browser checks before the file leaves it: build a second level from the
// bundle's own data, re-simulate its own recorded inputs through it, and compare
// the two runs field by field. A bundle that does not reproduce on the machine
// that recorded it is a determinism finding by itself, and it says so in those
// words rather than waiting to be discovered as a mystery.
//
// Browser-safe: `sim/replay.ts` has no Node dependencies, which is what makes
// the SAME comparison the CLI runs available at the download.

import { firstDivergence, DIVERGENCE_TOLERANCE } from "./replay";
import type { Recording } from "./trace";

export interface SelfReplayVerdict {
  // Did the re-simulation reproduce the recording on every field of every frame?
  identical: boolean;
  // The first field that differed, if any: enough to name the quantity without
  // carrying the whole report into the bundle.
  firstDivergence: { frame: number; field: string; delta: number } | null;
  // Wall time the check took, ms. Reported because it is paid synchronously on
  // the download and a claim about its cost should be measured, not asserted.
  ms: number;
}

export function verifySelfReplay(rec: Recording): SelfReplayVerdict {
  const started = performance.now();
  const first = firstDivergence(rec, DIVERGENCE_TOLERANCE);
  const ms = Math.round(performance.now() - started);
  if (!first) return { identical: true, firstDivergence: null, ms };
  // The largest difference on the frame, which is the one worth naming: a frame
  // usually differs on several fields at once and only one of them is the cause.
  const worst = [...first.fields].sort((a, b) => b.delta - a.delta)[0];
  return {
    identical: false,
    firstDivergence: worst
      ? { frame: first.frame, field: worst.name, delta: worst.delta }
      : { frame: first.frame, field: "(unknown)", delta: 0 },
    ms,
  };
}

// The verdict as one line, for the download toast and for `cli replay`'s header.
export function selfReplayLine(v: SelfReplayVerdict): string {
  if (v.identical) return `self-replay: replays exactly (${v.ms} ms)`;
  const d = v.firstDivergence;
  return (
    `self-replay: DOES NOT REPLAY on the machine that recorded it — ` +
    `f${d?.frame} ${d?.field} ${d?.delta.toExponential(3)} (${v.ms} ms)`
  );
}
