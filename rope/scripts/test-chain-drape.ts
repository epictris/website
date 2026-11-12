// The slack drape against what it is wrapped round: three browser runs of the
// ball's chain thrown round a 20 x 10 cm box (`playtests/drape/`), replayed
// from their level and inputs. Played and approved by Tris on 2026-11-12;
// see docs/slack-chain-drape.md for the mechanisms these hold.
//
// Two statements, neither a snapshot of the numbers the fix happened to land:
//
// - Taut, the drawn chain goes round a box the way the chain does. On every
//   frame the chain has no slack, the drape's polyline winds round each static
//   piece the solver's path wraps by the same number of turns (to within half
//   of one). The drape is allowed to disagree while it has slack - its sag can
//   honestly hang under a corner the solver's straight span passes over - but
//   the sag bound gathers it onto the path as the slack runs out. Red before
//   the swept push-out: the drape lost a whole turn round the box for good
//   (`session-256f` 203 frames, `session-386f` 343, `session-276f` 228).
//
// - Nothing static is inside the chain. No node of the drape ends a step
//   closer to a wrappable static piece than the broad link's half-width, less
//   a millimetre. Red at the old 9 mm clearance: broad links sat 13.4 mm deep
//   in the box. The ball is not held to it: resting against the box it leaves
//   a gap the solver's chain, which has no thickness, fits and the drawn one
//   cannot.
//
// Each run must still wrap the box while taut for a good stretch, so a change
// to the sim that stops the recordings reproducing their scene fails here
// rather than passing on nothing.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { levelFromRecording } from "../src/sim/replay";
import { recordingDeserializer } from "../src/sim/trace";
import { CHAIN_LINK_HALF_WIDTH } from "../src/render/chainMetrics";
import { circleOverlap } from "../src/engine/collision";
import { StaticBody2D, type CollisionShape2D } from "../src/engine/body";
import type { Vec2 } from "../src/engine/vec2";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "playtests", "drape");
// Frames each run must spend taut with the solver's path wound at least half
// a turn round a static piece, for its statements to be about anything.
const MIN_WRAPPED_TAUT = 60;
const CLEARANCE_SLOP = 0.001;

// Turns `points` winds round `c`.
function turns(points: readonly Vec2[], c: Vec2): number {
  let a = 0;
  for (let i = 1; i < points.length; i++) {
    const ux = points[i - 1]!.x - c.x;
    const uy = points[i - 1]!.y - c.y;
    const vx = points[i]!.x - c.x;
    const vy = points[i]!.y - c.y;
    a += Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  }
  return a / (2 * Math.PI);
}

let failed = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const rec = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  const level = levelFromRecording(rec);
  const de = recordingDeserializer(rec);
  const statics = level.bodies.filter((b) => b instanceof StaticBody2D);
  let wrappedTaut = 0;
  const mismatched: number[] = [];
  let deepest = { depth: 0, frame: 0, node: 0 };
  for (let f = 0; f < rec.frames.length; f++) {
    level.physicsProcess(de(rec.frames[f]), 1 / 60);
    const frame = f + 1;
    const drape = level.ball.chainSlack;
    const chain = level.ball.chain;
    if (drape === null || chain === null) continue;
    const nodes = drape.nodePositions();

    for (const body of statics) {
      if (body.removed) continue;
      for (const s of body.getShapes()) {
        if (!s.wrappable) continue;
        for (let i = 1; i + 1 < nodes.length; i++) {
          // The drawn link's, not the drape's own radius: the two parting
          // is the bug this holds.
          const ov = circleOverlap(nodes[i]!, CHAIN_LINK_HALF_WIDTH, s);
          if (ov !== null && ov.depth > deepest.depth) deepest = { depth: ov.depth, frame, node: i };
        }
      }
    }

    if (chain.maxRopeLength - chain.getCurrentLength() > 0) continue;
    const path = chain.path();
    const points = path.map((n) => n.contact.globalPosition);
    const wrapped = new Set<CollisionShape2D>();
    for (const n of path) if (n.contact.obj instanceof StaticBody2D) wrapped.add(n.contact.shape);
    let any = false;
    for (const s of wrapped) {
      const c = s.globalPosition;
      const want = turns(points, c);
      if (Math.abs(want) < 0.5) continue;
      any = true;
      if (Math.abs(turns(nodes, c) - want) > 0.5) mismatched.push(frame);
    }
    if (any) wrappedTaut++;
  }

  const lines: string[] = [];
  const check = (ok: boolean, what: string): void => {
    lines.push(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failed++;
  };
  check(
    wrappedTaut >= MIN_WRAPPED_TAUT,
    `the run still wraps a static piece while taut (${wrappedTaut} frames >= ${MIN_WRAPPED_TAUT})`,
  );
  check(
    mismatched.length === 0,
    `taut, the drape winds round what the chain wraps (${mismatched.length} frames off` +
      (mismatched.length > 0 ? `, first f${mismatched[0]}` : "") + ")",
  );
  check(
    deepest.depth <= CLEARANCE_SLOP,
    `no node inside a static piece's link-width clearance (deepest ${(deepest.depth * 1000).toFixed(1)} mm` +
      (deepest.depth > 0 ? ` at f${deepest.frame} n${deepest.node}` : "") + ")",
  );
  console.log(`${file}\n${lines.join("\n")}`);
}

assert.equal(failed, 0, `${failed} drape check(s) failed`);
console.log("RESULT: PASS");
