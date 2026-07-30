// Anomaly sweep over a bundle: the standing form of the speed-jump scan that was
// rewritten by hand in every debugging session.
//
// This is step 2.5 of the debugging loop - run it before choosing what to
// inspect. Its job is not to decide anything but to say where to look, and the
// five things it reports are the five shapes every physics bug so far has had:
//
//  - a one-frame velocity or spin spike (a launch: `1474f`);
//  - a body standing inside geometry (an embedding that the rope later pays for
//    in one frame: `1474f` again, `284f`);
//  - a settled body that nevertheless moves (a friction motor or a ratchet:
//    `611f`'s 2.4 mm per frame, `298f`'s 13 cm);
//  - a resting body whose contact set churns frame to frame (the pre-slop
//    stack's 0-to-3-of-6 flicker, which is what stopped warm starting working);
//  - a chain stall run and how much lease it took out (every chain runaway).
//
// Everything here is measured on the CURRENT simulation, not on the recording:
// the point is what the sim does now.

import { Vec2 } from "../engine/vec2";
import { CharacterBody2D, RigidBody2D, type PhysicsBody2D } from "../engine/body";
import type { World } from "../engine/world";
import { BallLevel } from "../level/ballLevel";
import type { Level } from "../level/level";
import { bodyId, deepestEmbedding } from "./query";
import { inputDeserializer, type Recording } from "./trace";
import { levelFromRecording } from "./replay";

// A body under this speed is a candidate for "settled" (m/s). Generous on
// purpose: the drift this looks for is a fraction of a millimetre a frame, and a
// motor that slow leaves the body's speed indistinguishable from noise.
const SETTLED_SPEED = 0.02;
// Frames it must stay that slow before the run counts as settled, and how far it
// may then travel over such a run before that is worth reporting.
const SETTLED_FRAMES = 60;
const SETTLED_DRIFT = 0.005; // 5 mm

export interface Spike {
  frame: number;
  magnitude: number;
}

export interface BodyScan {
  id: number;
  name: string;
  type: string;
  // Largest single-frame changes in linear and angular velocity, worst first.
  dvSpikes: Spike[];
  dwSpikes: Spike[];
  maxEmbed: number;
  maxEmbedFrame: number;
  maxEmbedInto: string;
  // The worst settled-body drift: how far the body moved over a run of frames it
  // spent essentially stationary, and where that run started.
  settledDrift: number;
  settledDriftFrame: number;
  settledFrames: number;
  // How often this body's contact set changed size while it was resting, as a
  // fraction of its resting frames. A pile that holds its contacts reads ~0; the
  // pre-slop stack read 0.5 and could not warm start.
  contactFlicker: number;
  restingFrames: number;
}

export interface ChainScan {
  longestStallRun: number;
  longestStallRunFrame: number;
  maxBlockedSlack: number;
  maxBlockedSlackFrame: number;
  maxLength: number;
  anchorLength: number | null;
  // What the chain's length solve added to the ball in a single frame, worst
  // first. This is the sharp spike measure and the raw |Δv| one is the blunt
  // one: a ball landing after a fall legitimately changes speed by several m/s
  // in a frame, so raw Δv cannot tell a launch from a landing, while the chain
  // solve is a constraint and can only ever brake - across the whole ball corpus
  // it peaks at 2.1 m/s of gain (see CHAIN_SOLVE_KICK_TOLERANCE).
  solveGainSpikes: Spike[];
}

export interface ScanResult {
  level: string;
  frames: number;
  bodies: BodyScan[];
  chain: ChainScan | null;
}

interface BodyState {
  scan: BodyScan;
  prev: { v: Vec2; w: number } | null;
  slowFor: number;
  slowStartFrame: number;
  slowStartPos: Vec2;
  prevContactCount: number | null;
  contactChanges: number;
}

function velocityOf(body: PhysicsBody2D): Vec2 | null {
  if (body instanceof RigidBody2D) return body.linearVelocity;
  if (body instanceof CharacterBody2D) return body.velocity;
  return null;
}

function pushSpike(list: Spike[], frame: number, magnitude: number, keep: number): void {
  if (magnitude <= 0) return;
  list.push({ frame, magnitude });
  list.sort((a, b) => b.magnitude - a.magnitude);
  if (list.length > keep) list.length = keep;
}

export function scanRecording(rec: Recording, topK = 5): ScanResult {
  const level = levelFromRecording(rec);
  const de = inputDeserializer();
  const states = new Map<number, BodyState>();
  const chain: ChainScan = {
    longestStallRun: 0,
    longestStallRunFrame: 0,
    maxBlockedSlack: 0,
    maxBlockedSlackFrame: 0,
    maxLength: 0,
    anchorLength: null,
    solveGainSpikes: [],
  };
  let sawChain = false;

  for (let i = 0; i < rec.frames.length; i++) {
    level.physicsProcess(de(rec.frames[i]!), 1 / 60);
    const frame = i + 1;
    const world: World = level.world;
    // Contacts as the frame left them, counted per body: this is a question
    // about the SET, so what matters is that it churns, not what it solved.
    const contactCounts = new Map<number, number>();
    // Guarded because this tooling is deliberately run against OLD physics (see
    // `cli compare`), and the constraint list is younger than some of the
    // revisions worth pointing it at. The flicker figure is then simply absent -
    // reported as zero resting frames - rather than the whole sweep dying on a
    // metric that is one of five.
    if (typeof world.collectContacts === "function") {
      for (const c of world.collectContacts()) {
        contactCounts.set(c.a.buildIndex, (contactCounts.get(c.a.buildIndex) ?? 0) + 1);
        contactCounts.set(c.b.buildIndex, (contactCounts.get(c.b.buildIndex) ?? 0) + 1);
      }
    }

    for (let bi = 0; bi < world.bodies.length; bi++) {
      const body = world.bodies[bi]!;
      if (body.removed || !body.hasShape()) continue;
      const v = velocityOf(body);
      if (!v) continue; // statics and movers carry no velocity to attribute
      const id = bodyId(body, bi);
      let st = states.get(id);
      if (!st) {
        st = {
          scan: {
            id,
            name: body.name || body.constructor.name,
            type: body.constructor.name,
            dvSpikes: [],
            dwSpikes: [],
            maxEmbed: 0,
            maxEmbedFrame: 0,
            maxEmbedInto: "",
            settledDrift: 0,
            settledDriftFrame: 0,
            settledFrames: 0,
            contactFlicker: 0,
            restingFrames: 0,
          },
          prev: null,
          slowFor: 0,
          slowStartFrame: frame,
          slowStartPos: body.globalPosition,
          prevContactCount: null,
          contactChanges: 0,
        };
        states.set(id, st);
      }
      const w = body instanceof RigidBody2D ? body.angularVelocity : 0;
      if (st.prev) {
        pushSpike(st.scan.dvSpikes, frame, v.sub(st.prev.v).length(), topK);
        pushSpike(st.scan.dwSpikes, frame, Math.abs(w - st.prev.w), topK);
      }
      st.prev = { v, w };

      const embed = deepestEmbedding(world, body);
      if (embed && embed.depth > st.scan.maxEmbed) {
        st.scan.maxEmbed = embed.depth;
        st.scan.maxEmbedFrame = frame;
        st.scan.maxEmbedInto = embed.intoName;
      }

      // Settled-body drift: a body that is going nowhere by its own velocity but
      // is nevertheless somewhere else than it started. Measured over the whole
      // slow run rather than per frame, because a motor's per-frame step is
      // exactly the size the numerics can excuse.
      if (v.length() < SETTLED_SPEED) {
        if (st.slowFor === 0) {
          st.slowStartFrame = frame;
          st.slowStartPos = body.globalPosition;
        }
        st.slowFor++;
        if (st.slowFor >= SETTLED_FRAMES) {
          const drift = body.globalPosition.distanceTo(st.slowStartPos);
          if (drift > st.scan.settledDrift) {
            st.scan.settledDrift = drift;
            st.scan.settledDriftFrame = st.slowStartFrame;
            st.scan.settledFrames = st.slowFor;
          }
        }
        st.scan.restingFrames++;
        const count = contactCounts.get(id) ?? 0;
        if (st.prevContactCount !== null && count !== st.prevContactCount) st.contactChanges++;
        st.prevContactCount = count;
      } else {
        st.slowFor = 0;
        st.prevContactCount = null;
      }
    }

    if (level instanceof BallLevel) {
      const rope = level.ball.chain;
      if (rope) {
        sawChain = true;
        if (level.chainStallFrames > chain.longestStallRun) {
          chain.longestStallRun = level.chainStallFrames;
          chain.longestStallRunFrame = frame;
        }
        if (rope.blockedSlack > chain.maxBlockedSlack) {
          chain.maxBlockedSlack = rope.blockedSlack;
          chain.maxBlockedSlackFrame = frame;
        }
        chain.maxLength = Math.max(chain.maxLength, rope.maxRopeLength);
        if (level.chainSolveSpeedGain !== null) {
          pushSpike(chain.solveGainSpikes, frame, level.chainSolveSpeedGain, topK);
        }
        if (level.chainAnchorLength !== null && chain.anchorLength === null) {
          chain.anchorLength = level.chainAnchorLength;
        }
      }
    }
  }

  const bodies = [...states.values()].map((s) => {
    s.scan.contactFlicker = s.scan.restingFrames > 0 ? s.contactChanges / s.scan.restingFrames : 0;
    return s.scan;
  });
  return {
    level: rec.level,
    frames: rec.frames.length,
    bodies,
    chain: sawChain ? chain : null,
  };
}

// The bar for "worth looking at" in the one-line summary of a whole corpus.
//
// The raw one is deliberately high. A ball landing off a fall changes speed by
// 4 to 8 m/s in the frame it lands, right across the corpus, so a bar low enough
// to catch a small launch flags every bundle there is and says nothing. What
// catches a launch is `NOTABLE_SOLVE_GAIN` below, on the chain solve alone.
export const NOTABLE_DV = 12; // m/s in one frame
export const NOTABLE_EMBED = 0.03; // 3 cm, the same slack the embed invariant uses
// The chain solve is a constraint: it can brake the ball and it may haul it
// towards an anchor, and across the whole ball corpus that peaks at 2.1 m/s in a
// frame. Anything past 2.5 is the solve paying out a discontinuity, which is
// what a launch is. The `rope-solve-kick` invariant fails at 4; this only points.
export const NOTABLE_SOLVE_GAIN = 2.5;

// A hook is launched at `HOOK_SPEED` and stopped dead when it anchors, so its
// velocity spikes are the mechanic working and would flag on every single
// bundle. It stays in the per-body table, where it can be read on purpose.
function spikesAreDeliberate(b: BodyScan): boolean {
  return b.type === "BallHook" || b.type === "Hook";
}

export function notable(scan: ScanResult): string[] {
  const out: string[] = [];
  for (const b of scan.bodies) {
    const dv = b.dvSpikes[0];
    if (dv && dv.magnitude > NOTABLE_DV && !spikesAreDeliberate(b)) {
      out.push(`body#${b.id} ${b.name}: |Δv|=${dv.magnitude.toFixed(2)} m/s @f${dv.frame}`);
    }
    if (b.maxEmbed > NOTABLE_EMBED) {
      out.push(
        `body#${b.id} ${b.name}: embedded ${(b.maxEmbed * 1000).toFixed(0)}mm in ` +
          `${b.maxEmbedInto} @f${b.maxEmbedFrame}`,
      );
    }
    if (b.settledDrift > SETTLED_DRIFT) {
      out.push(
        `body#${b.id} ${b.name}: settled drift ${(b.settledDrift * 1000).toFixed(1)}mm over ` +
          `${b.settledFrames}f from f${b.settledDriftFrame}`,
      );
    }
    if (b.restingFrames > SETTLED_FRAMES && b.contactFlicker > 0.25) {
      out.push(
        `body#${b.id} ${b.name}: contact set flickers on ${(b.contactFlicker * 100).toFixed(0)}% ` +
          `of ${b.restingFrames} resting frames`,
      );
    }
  }
  if (scan.chain && scan.chain.longestStallRun > 20) {
    out.push(
      `chain: stall run ${scan.chain.longestStallRun}f ending @f${scan.chain.longestStallRunFrame}, ` +
        `lease peaked at ${(scan.chain.maxBlockedSlack * 100).toFixed(1)}cm`,
    );
  }
  const gains = (scan.chain?.solveGainSpikes ?? []).filter((s) => s.magnitude > NOTABLE_SOLVE_GAIN);
  if (gains.length > 0) {
    out.push(
      `chain solve added ` +
        gains.map((s) => `${s.magnitude.toFixed(1)} m/s @f${s.frame}`).join(", ") +
        ` (real play peaks at 2.1)`,
    );
  }
  return out;
}
