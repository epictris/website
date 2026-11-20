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
// - Nothing static is across the chain either. No segment between two
//   interior nodes passes through a wrappable static piece. The node check
//   above cannot see it: two nodes each clear of a box on opposite faces
//   hold the segment between them straight through it. Red on `session-53f`
//   (the drape across the 20 x 10 cm box the hook flew round, f36-37), where
//   the sag bound pulled nodes into the box toward targets on its faces and
//   the push-out, with no side for them to have come from, split them out
//   through the two shallowest faces.
//
// Each run must still wrap the box while taut for a stretch, so a change to
// the sim that stops the recordings reproducing their scene fails here rather
// than passing on nothing.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { levelFromRecording } from "../src/sim/replay";
import { recordingDeserializer } from "../src/sim/trace";
import { CHAIN_LINK_HALF_WIDTH } from "../src/render/chainMetrics";
import { circleOverlap } from "../src/engine/collision";
import { MAX_STEP } from "../src/classes/slackChain";
import { StaticBody2D, type CollisionShape2D } from "../src/engine/body";
import type { Vec2 } from "../src/engine/vec2";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "playtests", "drape");
// Frames each run must spend taut with the solver's path wound at least half
// a turn round a static piece, for its statements to be about anything.
// `session-53f` is the shortest: the hook takes on f38 of 53.
const MIN_WRAPPED_TAUT = 10;
// Runs that are about the drape thrown about the real level rather than about
// a piece it wraps (`session-310f`: slack chain swung over the introduction's
// rocks, where the segment push-out threw nodes metres). Their guard is that
// the drape is out for this many frames instead.
const LOOSE_RUNS = new Set(["session-310f.json"]);
const MIN_DRAPE_FRAMES = 120;
// Spacing of the points a segment is tested at, metres: a fifth of the
// thinnest piece the runs wrap (the box's 10 cm), well under a node's 2.8 cm.
const SEGMENT_SAMPLE = 0.005;
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
  let across = { depth: 0, frame: 0, node: 0 };
  let acrossFrames = 0;
  let thrown = { over: 0, frame: 0, node: 0 };
  let lastDrape: unknown = null;
  let lastNodes: Vec2[] | null = null;
  let drapeFrames = 0;
  for (let f = 0; f < rec.frames.length; f++) {
    level.physicsProcess(de(rec.frames[f]), 1 / 60);
    const frame = f + 1;
    const drape = level.ball.chainSlack;
    const chain = level.ball.chain;
    if (drape === null || chain === null) {
      lastDrape = null;
      continue;
    }
    const nodes = drape.nodePositions();
    drapeFrames++;

    // No interior node moves further in a step than the Verlet fence allows
    // beyond what the pins it hangs between moved.
    if (lastDrape === drape && lastNodes !== null) {
      const last = nodes.length - 1;
      const pins = Math.max(nodes[0]!.distanceTo(lastNodes[0]!), nodes[last]!.distanceTo(lastNodes[last]!));
      for (let i = 1; i < last; i++) {
        const over = nodes[i]!.distanceTo(lastNodes[i]!) - MAX_STEP - pins;
        if (over > thrown.over) thrown = { over, frame, node: i };
      }
    }
    lastDrape = drape;
    lastNodes = nodes.slice();

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

    // The segments between interior nodes, as zero-thickness lines: a point
    // of one inside a piece is the drawn chain through it.
    let acrossHere = false;
    for (const body of statics) {
      if (body.removed) continue;
      for (const s of body.getShapes()) {
        if (!s.wrappable) continue;
        for (let i = 1; i + 2 < nodes.length; i++) {
          const a = nodes[i]!;
          const b = nodes[i + 1]!;
          const k = Math.max(1, Math.ceil(a.distanceTo(b) / SEGMENT_SAMPLE));
          for (let j = 1; j < k; j++) {
            const ov = circleOverlap(a.lerp(b, j / k), 0, s);
            if (ov === null || ov.depth <= CLEARANCE_SLOP) continue;
            acrossHere = true;
            if (ov.depth > across.depth) across = { depth: ov.depth, frame, node: i };
          }
        }
      }
    }
    if (acrossHere) acrossFrames++;

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
  if (LOOSE_RUNS.has(file)) {
    check(
      drapeFrames >= MIN_DRAPE_FRAMES,
      `the run still has the drape out (${drapeFrames} frames >= ${MIN_DRAPE_FRAMES})`,
    );
  } else {
    check(
      wrappedTaut >= MIN_WRAPPED_TAUT,
      `the run still wraps a static piece while taut (${wrappedTaut} frames >= ${MIN_WRAPPED_TAUT})`,
    );
  }
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
  check(
    thrown.over <= 0,
    `no node thrown further in a step than MAX_STEP past its pins` +
      (thrown.over > 0 ? ` (${(thrown.over * 100).toFixed(0)} cm over at f${thrown.frame} n${thrown.node})` : ""),
  );
  check(
    acrossFrames === 0,
    `no segment through a static piece (${acrossFrames} frames` +
      (acrossFrames > 0
        ? `, deepest ${(across.depth * 1000).toFixed(1)} mm at f${across.frame} n${across.node}-${across.node + 1}`
        : "") + ")",
  );
  console.log(`${file}\n${lines.join("\n")}`);
}

assert.equal(failed, 0, `${failed} drape check(s) failed`);
console.log("RESULT: PASS");
