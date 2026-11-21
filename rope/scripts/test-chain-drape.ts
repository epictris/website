// The slack drape against what it is wrapped round: browser runs of the
// ball's chain thrown round a 20 x 10 cm box, and wound round a ladder's
// rungs (`playtests/drape/`), replayed from their level and inputs. The box
// runs were played and approved by Tris on 2026-11-12; see
// docs/slack-chain-drape.md for the mechanisms these hold.
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
// "A piece" in all of these is also a rod (a ladder's rung, a handle), on
// whatever body carries it: `session-259f` is the ball wound round the rungs
// of a ladder swinging on a rigid body. The stretch of chain inside the cuff
// round the rod the chain ends on is inside the ring, not the rod. Red on
// `session-259f` before the drape held its segments off circles: a ball
// pressed against a rung squeezed the drape out of the gap the solver's chain
// passes through, and a 10.7 cm segment cut 13 mm into the 36.5 mm rung
// (93 frames).
//
// And no node is thrown further in a step than the Verlet fence (MAX_STEP)
// past what its pins moved. Red on `session-256f-jumps` before a corner the
// chain is wrapped round put the segments across it on its outside: a node
// thrown 5.4 m off a rock at f188.
//
// Each run must still wrap a piece while taut for a stretch, so a change to
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
import { cuffEnd } from "../src/lib/rod";
import type { Vec2 } from "../src/engine/vec2";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "playtests", "drape");
// Frames each run must spend taut with the solver's path wound at least half
// a turn round a static piece, for its statements to be about anything.
// `session-53f` is the shortest: the hook takes on f38 of 53.
const MIN_WRAPPED_TAUT = 10;
// Runs that are about the drape thrown about the real level rather than about
// a piece it wraps (`session-310f`: slack chain swung over the introduction's
// rocks, where the segment push-out threw nodes metres; `session-256f-jumps`:
// slack round a rock's corners, thrown 5.4 m off it). Their guard is that the
// drape is out for this many frames instead.
const LOOSE_RUNS = new Set(["session-310f.json", "session-256f-jumps.json"]);
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
  // What the drape is held to: every wrappable static piece, and every rod
  // (a ladder's rung) whatever body carries it - the ladder of `session-259f`
  // swings on a rigid body.
  const pieces = (): CollisionShape2D[] => {
    const out: CollisionShape2D[] = [];
    for (const body of level.bodies) {
      if (body.removed) continue;
      const fixed = body instanceof StaticBody2D;
      for (const sh of body.getShapes()) if (sh.wrappable && (fixed || sh.rod)) out.push(sh);
    }
    return out;
  };
  let wrappedTaut = 0;
  const mismatched: number[] = [];
  let deepest = { depth: 0, frame: 0, node: 0 };
  let across = { depth: 0, frame: 0, node: 0 };
  let acrossFrames = 0;
  const otherWay: number[] = [];
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

    // The cuff round a bar the chain ends on: the stretch of chain inside
    // its disc on its own body is inside the ring, not the bar (`chain-clip`'s
    // rule, and the drape's).
    const cuff = cuffEnd(chain.end);
    const inCuff = (s: CollisionShape2D, p: Vec2): boolean =>
      cuff !== null && s.owner === cuff.body && cuff.covers(p);
    const here = pieces();
    for (const s of here) {
      for (let i = 1; i + 1 < nodes.length; i++) {
        if (inCuff(s, nodes[i]!)) continue;
        // The drawn link's, not the drape's own radius: the two parting
        // is the bug this holds.
        const ov = circleOverlap(nodes[i]!, CHAIN_LINK_HALF_WIDTH, s);
        if (ov !== null && ov.depth > deepest.depth) deepest = { depth: ov.depth, frame, node: i };
      }
    }

    // The segments between interior nodes, as zero-thickness lines: a point
    // of one inside a piece is the drawn chain through it.
    let acrossHere = false;
    for (const s of here) {
      for (let i = 1; i + 2 < nodes.length; i++) {
        const a = nodes[i]!;
        const b = nodes[i + 1]!;
        const k = Math.max(1, Math.ceil(a.distanceTo(b) / SEGMENT_SAMPLE));
        for (let j = 1; j < k; j++) {
          const p = a.lerp(b, j / k);
          if (inCuff(s, p)) continue;
          const ov = circleOverlap(p, 0, s);
          if (ov === null || ov.depth <= CLEARANCE_SLOP) continue;
          acrossHere = true;
          if (ov.depth > across.depth) across = { depth: ov.depth, frame, node: i };
        }
      }
    }
    if (acrossHere) acrossFrames++;

    const path = chain.path();
    const points = path.map((n) => n.contact.globalPosition);
    const wrapped = new Set<CollisionShape2D>();
    // Not a rod the chain ends on: its last node is then the rod's axis,
    // round which no winding means anything.
    for (const [k, n] of path.entries()) {
      const s = n.contact.shape;
      if (s.rod && k === path.length - 1) continue;
      if (n.contact.obj instanceof StaticBody2D || s.rod) wrapped.add(s);
    }

    // Slack or taut, the drape is never wound round a piece the chain touches
    // the other way from the chain: both ends are pinned where the chain's
    // are, so it can only get there through the piece. Red on `session-58f`
    // before the sweeps: the drape went under the box the chain was over
    // (f35-40) and was hauled back through it as the slack ran out. Red on
    // `session-256f` f41-43 and `session-276f` f51 before the sag bound asked
    // which way round a node goes of the node before it, as the drape stood
    // before the bound moved any, and when the straight line was clear too.
    for (const s of wrapped) {
      const c = s.globalPosition;
      if (Math.abs(turns(nodes, c) - turns(points, c)) > 0.5) {
        otherWay.push(frame);
        break;
      }
    }

    if (chain.maxRopeLength - chain.getCurrentLength() > 0) continue;
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
      `the run still wraps a piece while taut (${wrappedTaut} frames >= ${MIN_WRAPPED_TAUT})`,
    );
  }
  check(
    mismatched.length === 0,
    `taut, the drape winds round what the chain wraps (${mismatched.length} frames off` +
      (mismatched.length > 0 ? `, first f${mismatched[0]}` : "") + ")",
  );
  check(
    deepest.depth <= CLEARANCE_SLOP,
    `no node inside a piece's link-width clearance (deepest ${(deepest.depth * 1000).toFixed(1)} mm` +
      (deepest.depth > 0 ? ` at f${deepest.frame} n${deepest.node}` : "") + ")",
  );
  check(
    thrown.over <= 0,
    `no node thrown further in a step than MAX_STEP past its pins` +
      (thrown.over > 0 ? ` (${(thrown.over * 100).toFixed(0)} cm over at f${thrown.frame} n${thrown.node})` : ""),
  );
  check(
    acrossFrames === 0,
    `no segment through a piece (${acrossFrames} frames` +
      (acrossFrames > 0
        ? `, deepest ${(across.depth * 1000).toFixed(1)} mm at f${across.frame} n${across.node}-${across.node + 1}`
        : "") + ")",
  );
  check(
    otherWay.length === 0,
    `the drape never winds round a piece the other way from the chain (${otherWay.length} frames` +
      (otherWay.length > 0 ? `, f${otherWay[0]}-f${otherWay[otherWay.length - 1]}` : "") + ")",
  );
  console.log(`${file}\n${lines.join("\n")}`);
}

assert.equal(failed, 0, `${failed} drape check(s) failed`);
console.log("RESULT: PASS");
