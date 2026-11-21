// Deterministic-replay primitives. Because the ported sim is self-consistent,
// a full session is captured by its per-frame input trace alone: replaying the
// same inputs from the same level reproduces it exactly. Digests let a replay
// assert bit-for-bit reproduction; invariants catch physical nonsense.

import { RootBendUnit } from "../level/rootBends";
import { Vec2 } from "../engine/vec2";
import { wrapAngle } from "../engine/mathf";
import { MANACLE_REACH, MANACLE_THICKNESS } from "../lib/manacle";
import {
  AnimatableBody2D,
  CharacterBody2D,
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
  VineLink,
  type CollisionObject2D,
  type CollisionShape2D,
} from "../engine/body";
import { bodyOverlapCircle, circleOverlap, shapeRadius } from "../engine/collision";
import { shapeContacts } from "../engine/manifold";
import { BallHook } from "../classes/ballHook";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import { isSeamVertex, type Rope } from "../classes/rope";
import type { RopeNode } from "../lib/ropeContact";
import { RopeRide } from "../lib/belt";
import { cuffEnd } from "../lib/rod";
import { shapeCrossesSpan, spanMotionBox, type Pose, type SpanMotion } from "../lib/spanSweep";
import { WrapDirection } from "../lib/types";
import { CONTACT_SLOP, GRAVITY, type ContactConstraint, type World } from "../engine/world";
import type { BallLevel } from "../level/ballLevel";
import type { BallPlayer } from "../classes/ballPlayer";
import type { SceneChain } from "../level/chains";
import type { TieChain } from "../engine/ties";
import type { RawLevelData } from "../level/levelFormat";
import type { SelfReplayVerdict } from "./selfReplay";
import type { RunMeta } from "../playtest/protocol";
import type { InputTraceBundle } from "../input/inputTrace";

// Bit order for the held-action mask in a serialized frame.
export const ACTIONS = [
  "moveLeft",
  "moveRight",
  "jump",
  "retract",
  "extend",
  "fire",
  "retractClick",
  "spawnSmallCircle",
  "spawnLargeCircle",
] as const;
export type Action = (typeof ACTIONS)[number];

export interface SerializedFrame {
  h: number; // bitmask of held actions
  mx: number;
  my: number;
}

export interface Recording {
  level: string;
  // Every frame of the run, from its first: what a replay re-creates the run
  // from, so never trimmed.
  frames: SerializedFrame[];
  // What the replay is checked against, each stamped with its own `frame`, and
  // NOT necessarily one per frame: a browser bundle carries every frame of its
  // last thirty seconds and one a second before that (`sim/runRecording.ts`),
  // a production run one a second. Read them by frame (`digestsByFrame`),
  // never by index.
  digests?: Digest[];
  // The whole scene, not just the avatar (see WorldDigest). Optional and at the
  // same cadence as `digests`: bundles recorded before it existed replay exactly
  // as they always did, and new ones are compared on every body.
  worldDigests?: WorldDigest[];
  // The tree the bundle was recorded on (see `src/sim/treeStamp.ts`): the short
  // commit, whether the working tree differed from it, and a hash over the
  // SOURCE the app was actually built from.
  //
  // `git` alone was a statement about when the dev server started, not about
  // what it was serving: seven bundles said `f0ed27a` on 2026-09-04 while the
  // served tree changed hourly, and two "still broken" recordings turned out to
  // be of code that had already been reverted. `srcHash` moves the moment an
  // edit does, so a replaying command can say whether the tree under it is the
  // tree that recorded this.
  git?: string;
  dirty?: boolean;
  srcHash?: string;
  // Whether this bundle reproduced on the machine that recorded it, checked at
  // the download before the file left the browser (see `sim/selfReplay.ts`).
  // Absent on bundles recorded before the check existed, and on any producer
  // that does not run it.
  selfReplay?: SelfReplayVerdict;
  // Self-contained bundles (e.g. exported from the level editor, whose level
  // isn't in the registry) embed their geometry + controller here. When
  // present, replay builds from `data` instead of looking `level` up.
  controller?: "grapple" | "ball";
  data?: RawLevelData;
  // The named spawn this run started from (`?checkpoint=`, see
  // `CheckpointData`). The level is resolved by NAME here, so without it a run
  // played from a checkpoint would replay from the level's own spawn and diverge
  // on its first frame - the bundle would be evidence about a different run.
  // Absent = the level's own spawn, which is every bundle before this field.
  checkpoint?: string;
  // The ball the run was played with, when it was not the iron one: "glass" is
  // the Hard difficulty (`?ball=glass`, see `BallLevelOptions`), which breaks on
  // the first solid thing it touches. A ball level's own data cannot say this -
  // the same file is both difficulties - so a glass run replayed without it
  // would be an iron run and diverge on the frame the glass broke. Absent =
  // iron, which is every bundle before the field.
  ball?: "glass";
  // The held-action mask the level's FIRST frame was stepped from. A serialized
  // frame carries held bits only and the deserializer derives pressed/released
  // by diffing against the previous frame, so a run that begins with a button
  // still held from before it began (the jump that reset the level, on the
  // frame after) replayed that hold as a fresh press - and a fresh jump press
  // on frame 1 of a ball level is a reset. Absent on bundles from before the
  // field existed, which all began from an empty hand.
  heldAtStart?: number;
  // The raw DOM button story the page saw while these frames were sampled
  // (see `input/inputTrace.ts`, read by `cli clicks`). The frames are what the
  // sim sampled; this is what the browser delivered, so a click that reached
  // neither can be told from one the page dropped. Never read by the sim.
  inputTrace?: InputTraceBundle;
  // Production playtest runs carry who played them and when (see
  // `playtest/protocol.ts`). Never read by the sim.
  meta?: RunMeta;
}

// Recorded digests looked up by the frame they describe rather than by their
// position (see `Recording.digests`): a bundle that carries one a second, or
// every frame only of its last thirty seconds, indexed by position would
// compare frame 2 against the digest of frame 120.
export function digestsByFrame<T extends { frame: number }>(
  list: T[] | undefined,
): (frame: number) => T | undefined {
  if (!list || list.length === 0) return () => undefined;
  const dense = list.every((d, i) => d.frame === i + 1);
  if (dense) return (frame) => list[frame - 1];
  const map = new Map<number, T>();
  for (const d of list) map.set(d.frame, d);
  return (frame) => map.get(frame);
}

export interface Digest {
  frame: number;
  px: number;
  py: number;
  rot: number;
  vx: number;
  vy: number;
  ropeLen: number | null;
  maxRope: number | null;
  state: string;
}

// ---- full-world digest -----------------------------------------------------
// `Digest` is the avatar's, and that is all it has ever been: every other rigid
// body in the scene could jitter, drift, NaN or embed itself in the floor
// without moving a digest by one bit, so "bit-identical" and `maxDrift` spoke
// for the avatar alone. A rigid-pile jitter regression shipped under exactly
// that claim (session-298f).
//
// This is the whole movable scene instead, one entry per body that can move,
// named by build order (see CollisionObject2D.buildIndex) so the same body is
// the same entry across two builds of a level. It carries `w` as well, which no
// avatar digest ever did - the ball's angular velocity is what the no-rolling
// regression (session-314f) changed, and no digest could see it.
//
// Statics and movers are deliberately out. A static cannot move, and a mover's
// pose is a pure function of the frame number, so neither can carry a
// regression that the bodies here do not also show.

export interface BodyDigest {
  id: number; // build-order index within the level's world
  px: number;
  py: number;
  rot: number;
  vx: number;
  vy: number;
  w: number; // angular velocity, rad/s (0 for the grapple avatar, which has none)
  // The strongest contact this body carried this frame, from `World.frameContacts`
  // — the build index of whatever it was pressed against, and that contact's
  // accumulated normal impulse (N·s). Optional because bundles recorded before
  // they existed do not carry them; see the note on the chain fields below.
  //
  // "Was it touching, and how hard" was asked of every frame inspected on
  // 2026-09-04 and answered by re-simulating each time. A pose says a body is
  // 1e-17 m from a slab; only the impulse says whether the slab is holding it up.
  contactWith?: number | null;
  contactPn?: number;
  // Hits a BREAKABLE body has taken so far (`CollisionObject2D.impactHits`), and
  // absent on a body that cannot break - which is every body of every level that
  // authors no threshold, so the digest of one is unchanged to the byte.
  //
  // Optional, and a missing one is "not recorded" rather than zero, for the
  // reason `contactPn` gives: a bundle from before the field has no opinion
  // about it. It is the one number a break leaves behind that a pose cannot
  // show - a floor two hits into three looks exactly like a floor - and the
  // break itself is visible as the body leaving the digest entirely.
  hits?: number;
}

// What the chain phase DECIDED this frame, not only what the chain measured.
//
// The first four are the measurement and always were. The rest are the decision,
// and without them a chain-phase bug is not readable from a bundle at all: the
// ball's angular velocity at frame end reads zero on exactly the frames that
// matter, because a wound-tight unwind refunds the aim's whole turn, so the
// commanded spin was invisible to every digest there was. The lease grant, the
// unwind's refund and the geometry push per frame are the three numbers that
// explained `session-154f`, `session-477f` and `session-324f`.
//
// Every added field is optional, and every reader treats a missing one as "not
// recorded" rather than as zero: a bundle from before they existed has no
// opinion about them, and comparing against an invented zero would report a
// divergence the recording never made. `Recording.worldDigests` itself is
// optional for the same reason.
export interface ChainDigest {
  nodes: number;
  pathLen: number;
  maxRope: number;
  blockedSlack: number;
  // rad/s the steering wrote this frame (`BallLevel.aimSpin`). Zero for the
  // grapple rope, which has no steering.
  aimSpin?: number;
  // rad the unwind gave back (`BallLevel.chainUnwindRefund`). `aimSpin` less
  // this is the turn the frame actually kept.
  unwindRefund?: number;
  // Metres the winch stall had to let out this frame (`Rope.stalledLength`).
  stalled?: number;
  // Metres the frame's push-outs moved the rope's own body (`Rope.geometryPush`),
  // and 0 where the caller does not measure it — the SIZE of the refusal that
  // bounds the lease.
  geometryPush?: number;
  // m/s the frame's own winding entitles the solve to
  // (`BallLevel.chainWinchSpeedBudget`).
  winchBudget?: number;
  // m/s the positional chain phase handed the ball out of a surface it pushed
  // it out of. Not written since the phase was retired (2026-10-19): a bundle
  // from before carries it, and nothing compares it.
  pushCredit?: number;
  // Build index of the body the chain's far end sits on, or null while the end
  // is still the hook in flight. A two-body interaction diagnosed from one
  // body's digest is how the first divergence was attributed to the wrong body
  // on 2026-09-04; this is the pointer at the other one.
  anchorBody?: number | null;
  // 1 while the ball was braced this frame (`BallLevel.chainBraced`): a
  // load-bearing contact off the chain's path, so the spin's reaction is the
  // world's and the holder keeps the haul. 0 in free air, and for the grapple
  // rope. The same ask against the same holder is a refused turn in one and
  // a haul in the other, and the refund alone cannot say which.
  braced?: number;
}

export interface WorldDigest {
  frame: number;
  bodies: BodyDigest[];
  chain: ChainDigest | null;
  // THE FINISH LINE, on a level that has one (see the `finish` body kind):
  // whether it has been crossed.
  //
  // A boolean rather than a frame number, because the frame is already the
  // digest's own: a run that finished a frame late is one whose `finished` is
  // false on a frame the recording says it is true, which is the divergence,
  // stated where it happens.
  //
  // Absent rather than nulled on a level with no finish line, which is the rule
  // `hits` follows on a body: a bundle recorded before the field existed has no
  // opinion about it, and comparing a replay against an invented `false` would
  // report a divergence the recording never made. Absent on BOTH sides compares
  // equal; absent on one is a different scene.
  finished?: boolean;
  // THE GLASS BALL (`BallPlayer.glass`): whether it has broken. Written only
  // for a glass ball, under `finished`'s rule exactly - absent on both sides is
  // two iron runs and compares equal (every bundle before the glass ball, and
  // every Normal run after it), present on one alone is a different ball, and
  // broken in one run only is a different run.
  shattered?: boolean;
  // The SCENE CHAINS, in build order: what each one measured at the end of the
  // frame. Absent on a level with none, and - unlike `finished` - absent on one
  // side is "not recorded" rather than a different scene, since every bundle
  // from before the field has chains it never digested. Present on both sides
  // it is compared field by field (`chain#3.over`), which is what lets `cli
  // diverge` name a chain: on `session-235f` the first thing to differ between
  // two trees was a bridge segment's over-length, and the body digests could
  // only say that a slat had moved.
  chains?: SceneChainDigest[];
  // The TIED CHAINS (`engine/ties.ts`), in build order, under the same rule as
  // `chains`: absent on a level with none, compared where both sides carry it,
  // and named `tie#2.over` by `cli diverge`.
  ties?: SceneChainDigest[];
  // The BALL'S AIM ERROR the steering turned toward this frame
  // (`BallPlayer.aimError`), unwrapped, or null while it was not aiming. It is
  // the one piece of steering state that carries from frame to frame - the
  // lap a whirl has the loop trailing by - and nothing else in the digest can
  // tell a loop a whole turn behind from one level with its aim. Written by
  // the ball driver alone, and compared where both sides carry it, under the
  // rule `chains` follows.
  aimError?: number | null;
  // The spin motor's power share the aim holds (`BallPlayer.aimPowerHeld`): the most
  // the lag reached on the way to the aim, which the lag itself has forgotten.
  // Under the rule `aimError` follows.
  aimPowerHeld?: number;
  // The ball's spin motor's torque over its last step (`RigidBody2D.spinMotorTorque`,
  // N·m): the warm start it carries into the next frame, which no pose shows.
  // Under the rule `aimError` follows.
  spinMotorTorque?: number;
  // The ball's chain's averaged tension (`BallLevel.chainTension`, N), which
  // the chain snaps on and which carries from frame to frame. Under the rule
  // `aimError` follows.
  chainTension?: number;
}

// One scene chain at the end of a frame (see `WorldDigest.chains`), or one
// tied chain (`WorldDigest.ties`).
export interface SceneChainDigest {
  // Path length in metres, and metres over the constraint (zero while slack) -
  // the sweep's own residual, `Rope.overLength`; for a tied chain the segments
  // summed, and the worst segment's over-length.
  len: number;
  over: number;
  // 1 while the chain is out of the frame's set (`SceneChain.asleep`,
  // `TieChain.asleep`).
  asleep: number;
}

// What the level driver decided about its chain this frame. Passed in rather
// than read off the rope, because it is the DRIVER's: the aim's spin, the
// unwind's refund and the winch's budget are both
// `BallLevel` state, and the rope itself has never heard of any of them. Null
// for a driver with no chain phase — the grapple avatar's rope, which is
// steered by nothing and whose caller measures no push-out.
interface ChainPhaseState {
  aimSpin: number;
  unwindRefund: number;
  winchBudget: number;
  braced: boolean;
}

// The strongest contact a body carried this frame: the one with the largest
// accumulated normal impulse. `frameContacts` orients every constraint out of
// `b` toward `a`, so the "other" body is simply whichever end is not this one.
function strongestContact(
  contacts: readonly ContactConstraint[],
  body: PhysicsBody2D,
): { with: number | null; pn: number } {
  let best: ContactConstraint | null = null;
  for (const c of contacts) {
    if (c.a !== body && c.b !== body) continue;
    if (best === null || Math.abs(c.normalImpulse) > Math.abs(best.normalImpulse)) best = c;
  }
  if (!best) return { with: null, pn: 0 };
  const other = best.a === body ? best.b : best.a;
  // Statics carry a build index too (`World.add` stamps every body it appends),
  // so naming one by it is strictly more use than a sentinel would be: "held up
  // by body#34" and "held up by the floor" are the same kind of answer.
  return { with: other.buildIndex, pn: best.normalImpulse };
}

function worldDigestOf(
  frame: number,
  world: World,
  rope: Rope | null,
  phase: ChainPhaseState | null,
  finished: boolean | undefined,
  chains: readonly SceneChain[],
  ties: readonly TieChain[],
): WorldDigest {
  const bodies: BodyDigest[] = [];
  const contacts = world.frameContacts;
  for (const body of world.bodies) {
    if (body.removed) continue;
    if (body instanceof RigidBody2D) {
      const contact = strongestContact(contacts, body);
      bodies.push({
        id: body.buildIndex,
        px: body.globalPosition.x,
        py: body.globalPosition.y,
        rot: body.globalRotation,
        vx: body.linearVelocity.x,
        vy: body.linearVelocity.y,
        w: body.angularVelocity,
        contactWith: contact.with,
        contactPn: contact.pn,
        ...(body.breakForce > 0 ? { hits: body.impactHits } : {}),
      });
    } else if (body.breakForce > 0) {
      // A BREAKABLE static, which is the one static that carries state: it
      // cannot move, but it can count hits and it can leave the world, and
      // neither of those shows anywhere else in the digest. Every other static
      // stays out for the reason given above - a body that cannot change is a
      // body no regression can hide in.
      bodies.push({
        id: body.buildIndex,
        px: body.globalPosition.x,
        py: body.globalPosition.y,
        rot: body.globalRotation,
        vx: 0,
        vy: 0,
        w: 0,
        contactWith: null,
        contactPn: 0,
        hits: body.impactHits,
      });
    } else if (body instanceof CharacterBody2D) {
      // A CharacterBody2D is swept rather than solved, so it appears in no
      // contact constraint at all: its "was it touching" question is answered by
      // `Digest.state` and the physics trace, not here.
      bodies.push({
        id: body.buildIndex,
        px: body.globalPosition.x,
        py: body.globalPosition.y,
        rot: body.globalRotation,
        vx: body.velocity.x,
        vy: body.velocity.y,
        w: 0,
        contactWith: null,
        contactPn: 0,
      });
    }
  }
  return {
    frame,
    bodies,
    chain: rope
      ? {
          nodes: rope.path().length,
          pathLen: rope.getCurrentLength(),
          maxRope: rope.maxRopeLength,
          blockedSlack: rope.blockedSlack,
          aimSpin: phase?.aimSpin ?? 0,
          unwindRefund: phase?.unwindRefund ?? 0,
          stalled: rope.stalledLength,
          geometryPush: rope.geometryPush ?? 0,
          winchBudget: phase?.winchBudget ?? 0,
          anchorBody: anchorBodyOf(rope),
          braced: phase?.braced ? 1 : 0,
        }
      : null,
    ...(finished !== undefined ? { finished } : {}),
    ...(chains.length > 0
      ? {
          chains: chains.map((c) => ({
            len: c.rope.getCurrentLength(),
            over: c.rope.overLength,
            asleep: c.asleep ? 1 : 0,
          })),
        }
      : {}),
    ...(ties.length > 0
      ? {
          ties: ties.map((c) => ({
            len: c.currentLength,
            over: c.over,
            asleep: c.asleep ? 1 : 0,
          })),
        }
      : {}),
  };
}

// The build index of the body the rope's far end sits on, or null while that end
// is a hook still in flight — which is not a body in the scene the digest
// describes, and reading its index would name a body nobody anchored to.
function anchorBodyOf(rope: Rope): number | null {
  const obj = rope.end.contact.obj;
  if (obj instanceof BallHook) return null;
  return obj.buildIndex;
}

export function worldDigestBall(level: BallLevel): WorldDigest {
  const digest = worldDigestOf(
    level.frame,
    level.world,
    level.ball.chain,
    {
      aimSpin: level.aimSpin,
      unwindRefund: level.chainUnwindRefund,
      winchBudget: level.chainWinchSpeedBudget,
      braced: level.chainBraced,
    },
    // Written only on a level that HAS a finish line, so every level without
    // one digests exactly what it always did and every bundle of one compares
    // as it always did (see `WorldDigest.finished`).
    level.hasFinish ? level.completedFrame !== null : undefined,
    level.sceneChains,
    level.tieChains,
  );
  digest.aimError = level.ball.aimError;
  digest.aimPowerHeld = level.ball.aimPowerHeld;
  digest.spinMotorTorque = level.ball.spinMotorTorque;
  digest.chainTension = level.chainTension;
  // Only for a glass ball, so an iron run digests exactly what it always did
  // (see `WorldDigest.shattered`).
  if (level.ball.glass) digest.shattered = level.shatteredFrame !== null;
  return digest;
}

// Worst behavioural difference between two full-world digests, and the name of
// whatever carries it — so a regression in scenery reads as loudly as one in
// the avatar instead of being aggregated into a single number.
//
// A body present in one and not the other, or a chain that exists in one alone,
// is an infinite difference: that is a different scene, not a drifted one.
export interface WorldDrift {
  drift: number;
  name: string;
}

export function worldDigestDrift(a: WorldDigest, b: WorldDigest): WorldDrift {
  let worst: WorldDrift = { drift: 0, name: "" };
  const consider = (drift: number, name: string): void => {
    if (drift > worst.drift) worst = { drift, name };
  };
  const byId = new Map(b.bodies.map((e) => [e.id, e]));
  for (const e of a.bodies) {
    const o = byId.get(e.id);
    if (!o) {
      consider(Infinity, `body#${e.id} (absent in the other run)`);
      continue;
    }
    byId.delete(e.id);
    consider(Math.hypot(e.px - o.px, e.py - o.py), `body#${e.id}`);
  }
  for (const e of byId.values()) consider(Infinity, `body#${e.id} (absent in the other run)`);
  if ((a.chain === null) !== (b.chain === null)) {
    consider(Infinity, "chain (deployed in one run only)");
  } else if (a.chain && b.chain) {
    if (a.chain.nodes !== b.chain.nodes) consider(Infinity, "chain (different wrap topology)");
    consider(Math.abs(a.chain.pathLen - b.chain.pathLen), "chain length");
  }
  // The finish line follows the chain's rule exactly: absent on both is two
  // levels with no finish line and compares equal, present on one alone is a
  // different scene, and finished in one run and not the other is a different
  // run rather than a drifted one - it is the level having been completed or
  // not, which has no magnitude.
  if ((a.finished === undefined) !== (b.finished === undefined)) {
    consider(Infinity, "finish (present in one run only)");
  } else if (a.finished !== b.finished) {
    consider(Infinity, "finish (crossed in one run only)");
  }
  // The glass ball, by the same rule (see `WorldDigest.shattered`).
  if ((a.shattered === undefined) !== (b.shattered === undefined)) {
    consider(Infinity, "glass ball (in one run only)");
  } else if (a.shattered !== b.shattered) {
    consider(Infinity, "glass ball (broken in one run only)");
  }
  // Scene chains drift by their LENGTH, the one quantity a chain has that is a
  // distance; compared only where both runs digested them (see
  // `WorldDigest.chains`).
  if (a.chains && b.chains) {
    if (a.chains.length !== b.chains.length) {
      consider(Infinity, "chains (different count)");
    } else {
      for (let i = 0; i < a.chains.length; i++) {
        consider(Math.abs(a.chains[i]!.len - b.chains[i]!.len), `chain#${i}`);
      }
    }
  }
  if (a.ties && b.ties) {
    if (a.ties.length !== b.ties.length) {
      consider(Infinity, "ties (different count)");
    } else {
      for (let i = 0; i < a.ties.length; i++) {
        consider(Math.abs(a.ties[i]!.len - b.ties[i]!.len), `tie#${i}`);
      }
    }
  }
  return worst;
}

// ---- field-level comparison -------------------------------------------------
// `worldDigestDrift` answers "how far apart", which is the right question for a
// regression and the wrong one for a divergence: on 2026-09-04 the replay's
// first difference from every fresh browser recording was `chain.blockedSlack`
// at f90, one lease instalment of 8.33 mm, eight frames before any body had
// moved a visible distance — and the tooling said `drifted @f98` on the avatar.
// Finding the frame, the quantity and the phase took three throwaway scripts.
//
// So this compares every field of every body and of the chain, names each one,
// and says by how much. It is the whole of `cli diverge` and the summary line
// `cli replay` now carries.

export interface DigestFieldDelta {
  // `body#0.px`, `chain.blockedSlack`, `body#34.contactPn`.
  name: string;
  recorded: number | null;
  replayed: number | null;
  // Absolute difference, or Infinity where the two are not the same KIND of
  // thing: a body present in one run only, a chain deployed in one only, a
  // different contact partner, a different wrap topology. Those are different
  // scenes rather than drifted ones.
  delta: number;
}

// Numeric fields compared on every body, in the order they are reported before
// sorting by magnitude.
const BODY_FIELDS = ["px", "py", "rot", "vx", "vy", "w", "contactPn", "hits"] as const;
// ...and on the chain. `anchorBody` and `contactWith` are identities rather than
// quantities and are compared separately.
const CHAIN_FIELDS = [
  "pathLen",
  "maxRope",
  "blockedSlack",
  "aimSpin",
  "unwindRefund",
  "stalled",
  "geometryPush",
  "winchBudget",
  "braced",
] as const;

// A field the RECORDING does not carry is not compared. A bundle from before a
// field existed has no opinion about it, and measuring the replay against an
// invented zero would report a divergence its recording never made.
function compareNumber(
  out: DigestFieldDelta[],
  name: string,
  recorded: number | undefined,
  replayed: number | undefined,
  tolerance: number,
): void {
  if (recorded === undefined || replayed === undefined) return;
  const delta = Math.abs(replayed - recorded);
  // Written as `!(delta <= tolerance)` so a NaN on either side reports rather
  // than compares equal, which `delta > tolerance` would not do.
  if (!(delta <= tolerance)) out.push({ name, recorded, replayed, delta });
}

function compareIdentity(
  out: DigestFieldDelta[],
  name: string,
  recorded: number | null | undefined,
  replayed: number | null | undefined,
): void {
  if (recorded === undefined || replayed === undefined) return;
  if (recorded === replayed) return;
  out.push({ name, recorded, replayed, delta: Infinity });
}

// Every field of `replayed` that differs from `recorded` by more than
// `tolerance`, unsorted. The default tolerance is the noise floor bit-exactness
// uses: zero.
export function worldDigestDeltas(
  replayed: WorldDigest,
  recorded: WorldDigest,
  tolerance = 0,
): DigestFieldDelta[] {
  const out: DigestFieldDelta[] = [];
  const byId = new Map(recorded.bodies.map((e) => [e.id, e]));
  for (const r of replayed.bodies) {
    const o = byId.get(r.id);
    if (!o) {
      out.push({ name: `body#${r.id}`, recorded: null, replayed: r.id, delta: Infinity });
      continue;
    }
    byId.delete(r.id);
    for (const f of BODY_FIELDS) compareNumber(out, `body#${r.id}.${f}`, o[f], r[f], tolerance);
    compareIdentity(out, `body#${r.id}.contactWith`, o.contactWith, r.contactWith);
  }
  for (const o of byId.values()) {
    out.push({ name: `body#${o.id}`, recorded: o.id, replayed: null, delta: Infinity });
  }
  if ((replayed.chain === null) !== (recorded.chain === null)) {
    out.push({ name: "chain", recorded: null, replayed: null, delta: Infinity });
  } else if (replayed.chain && recorded.chain) {
    // The node count is a topology, not a length: one more wrap is a different
    // path, however close the two measure.
    compareIdentity(out, "chain.nodes", recorded.chain.nodes, replayed.chain.nodes);
    for (const f of CHAIN_FIELDS) {
      compareNumber(out, `chain.${f}`, recorded.chain[f], replayed.chain[f], tolerance);
    }
    compareIdentity(out, "chain.anchorBody", recorded.chain.anchorBody, replayed.chain.anchorBody);
  }
  // A bundle from before the field carries no `finished` and is not compared on
  // it (`compareNumber`'s rule, applied to the field as a whole): measuring a
  // replay against an invented `false` would report a divergence its recording
  // never made.
  if (recorded.finished !== undefined && replayed.finished !== undefined) {
    compareIdentity(out, "finished", Number(recorded.finished), Number(replayed.finished));
  } else if ((recorded.finished === undefined) !== (replayed.finished === undefined)) {
    out.push({ name: "finished", recorded: null, replayed: null, delta: Infinity });
  }
  // The glass ball, under the same rule as `finished`.
  if (recorded.shattered !== undefined && replayed.shattered !== undefined) {
    compareIdentity(out, "shattered", Number(recorded.shattered), Number(replayed.shattered));
  } else if ((recorded.shattered === undefined) !== (replayed.shattered === undefined)) {
    out.push({ name: "shattered", recorded: null, replayed: null, delta: Infinity });
  }
  // Scene chains, where both runs digested them. The count is a property of
  // the level and differs only between different levels.
  if (recorded.chains && replayed.chains) {
    if (recorded.chains.length !== replayed.chains.length) {
      out.push({ name: "chains", recorded: recorded.chains.length, replayed: replayed.chains.length, delta: Infinity });
    } else {
      for (let i = 0; i < recorded.chains.length; i++) {
        const o = recorded.chains[i]!;
        const r = replayed.chains[i]!;
        compareNumber(out, `chain#${i}.len`, o.len, r.len, tolerance);
        compareNumber(out, `chain#${i}.over`, o.over, r.over, tolerance);
        compareIdentity(out, `chain#${i}.asleep`, o.asleep, r.asleep);
      }
    }
  }
  if (recorded.aimError !== undefined && replayed.aimError !== undefined) {
    if (recorded.aimError === null || replayed.aimError === null) {
      compareIdentity(out, "aimError", recorded.aimError, replayed.aimError);
    } else {
      compareNumber(out, "aimError", recorded.aimError, replayed.aimError, tolerance);
    }
  }
  if (recorded.aimPowerHeld !== undefined && replayed.aimPowerHeld !== undefined) {
    compareNumber(out, "aimPowerHeld", recorded.aimPowerHeld, replayed.aimPowerHeld, tolerance);
  }
  if (recorded.spinMotorTorque !== undefined && replayed.spinMotorTorque !== undefined) {
    compareNumber(out, "spinMotorTorque", recorded.spinMotorTorque, replayed.spinMotorTorque, tolerance);
  }
  if (recorded.chainTension !== undefined && replayed.chainTension !== undefined) {
    compareNumber(out, "chainTension", recorded.chainTension, replayed.chainTension, tolerance);
  }
  if (recorded.ties && replayed.ties) {
    if (recorded.ties.length !== replayed.ties.length) {
      out.push({ name: "ties", recorded: recorded.ties.length, replayed: replayed.ties.length, delta: Infinity });
    } else {
      for (let i = 0; i < recorded.ties.length; i++) {
        const o = recorded.ties[i]!;
        const r = replayed.ties[i]!;
        compareNumber(out, `tie#${i}.len`, o.len, r.len, tolerance);
        compareNumber(out, `tie#${i}.over`, o.over, r.over, tolerance);
        compareIdentity(out, `tie#${i}.asleep`, o.asleep, r.asleep);
      }
    }
  }
  return out;
}

export function worldDigestsEqual(a: WorldDigest, b: WorldDigest): boolean {
  if (a.bodies.length !== b.bodies.length) return false;
  return worldDigestDeltas(a, b, 0).length === 0;
}

export function serializeInput(input: FrameInput): SerializedFrame {
  let h = 0;
  ACTIONS.forEach((a, i) => {
    if (input[a].held) h |= 1 << i;
  });
  return { h, mx: input.mouseWorldPosition.x, my: input.mouseWorldPosition.y };
}

// Rebuild an input stream from serialized held-bits, deriving pressed/released
// by diffing against the previous frame (stateful — call frames in order).
// `heldAtStart` seeds that previous frame (see `Recording.heldAtStart`).
export function inputDeserializer(heldAtStart = 0): (f: SerializedFrame) => FrameInput {
  let prev: FrameInput = emptyFrameInput();
  ACTIONS.forEach((a, i) => {
    if (heldAtStart & (1 << i)) prev[a] = { held: true, pressed: false, released: false };
  });
  return (f: SerializedFrame): FrameInput => {
    const input = emptyFrameInput();
    ACTIONS.forEach((a, i) => {
      input[a] = button((f.h & (1 << i)) !== 0, prev[a]);
    });
    input.mouseWorldPosition = new Vec2(f.mx, f.my);
    prev = input;
    return input;
  };
}

// The deserializer a recording asks for: seeded with the hand it began from.
export function recordingDeserializer(rec: Recording): (f: SerializedFrame) => FrameInput {
  return inputDeserializer(rec.heldAtStart ?? 0);
}

// A frame's digest: the ball's pose and its chain's length.
export function digestBall(level: BallLevel): Digest {
  const b = level.ball;
  return {
    frame: level.frame,
    px: b.globalPosition.x,
    py: b.globalPosition.y,
    rot: b.globalRotation,
    vx: b.linearVelocity.x,
    vy: b.linearVelocity.y,
    ropeLen: b.chain ? b.chain.getCurrentLength() : null,
    maxRope: b.chain ? b.chain.maxRopeLength : null,
    state: b.chainStowed
      ? "BallStowed"
      : b.chainAnchored
        ? "BallAnchored"
        : b.chain
          ? "BallFiring"
          : "Ball",
  };
}

export function digestsEqual(a: Digest, b: Digest): boolean {
  return (
    a.px === b.px &&
    a.py === b.py &&
    a.rot === b.rot &&
    a.vx === b.vx &&
    a.vy === b.vy &&
    a.ropeLen === b.ropeLen &&
    a.state === b.state
  );
}

// Positional distance (metres) between two digests. A recording made in the
// browser and re-simulated in node diverges by sub-mm float noise on a resting
// body every frame; drift is the honest signal of a *behavioural* difference,
// where bit-exact `digestsEqual` cries wolf. State mismatch counts as infinite
// drift — a different state is a different behaviour regardless of position.
export function digestDrift(a: Digest, b: Digest): number {
  if (a.state !== b.state) return Infinity;
  return Math.hypot(a.px - b.px, a.py - b.py);
}

// Above this positional drift (metres, ~1px) a replay has genuinely diverged
// from its recording, not just accumulated float noise on a settled body.
export const DRIFT_EPSILON = 0.01;

export interface Violation {
  frame: number;
  kind: string;
  detail: string;
}

const RUNAWAY_SPEED = 1e3;
const EMBED_TOLERANCE = 0.03;
// The hook is a 2 cm circle, so the player's 3 cm bar would pass a hook buried
// past its own centre: in session-1085f it rode a compound floor's internal
// seam at exactly one radius deep (20 mm) for 90 frames and replayed HEALTHY.
// A seated hook (bounce, probe, dangling rest) sits ON the surface - depth is
// solver-band noise, well under a centimetre.
const HOOK_EMBED_TOLERANCE = 0.01;
// The cuff and the ball are bodies that meet, two-way (`BallPlayer.dangle`), so
// what is left is the soft contact's own give: none of the corpus comes near a
// centimetre.
const TIP_IN_BALL_TOLERANCE = 0.01;

// Ceiling on applied tangential impulse beyond the kinematic spin's traction
// budget (`World.spinDriveOverspend`, N·s). The budget arithmetic is exact -
// the solver clamps to the same expression - so this is noise slack only: on
// the ball's 52 kg, 1 N·s is 0.02 m/s. The wall launch it exists for overspent
// by 193 N·s (`session-773f` f600).
const SPIN_OVERDRIVE_TOLERANCE = 1;
// How far over its constraint length the anchored chain may measure before the
// rope is not being enforced at all - the launch class, a wrap path appearing
// at full size in one frame (`session-1474f`: half a metre of length error,
// 96 m/s).
//
// It is not a statement about a ball crushed against its own point-blank
// anchor, and that regime measures far above what a bar for the launch class
// would suggest: a ball pinned between the floor and a slab it is chained to
// at 5 cm, spun under the aim, escapes along the slab faster than a correction
// aimed mostly INTO the slab can haul it back, the stall lease trails the
// escape by the push-out it is bounded to, and the chain measures 14-17 cm over
// for frames at a time with a STATIC slab and nothing else in the frame. Every
// crush session in the corpus (`477f`, `726f`, `1426f`, all against rigid
// slabs) sat under 5 cm only while those slabs were being pumped toward the
// ball (see `CHAIN_PUSH_CREDIT_FRAMES`); cleared as a pair they measure 6-10.
export const CHAIN_OVER_LENGTH_TOLERANCE = 0.25;
// How much longer than the length it anchored at the ball's chain may get.
// Nothing pays chain out once it is anchored, so the only source of growth is
// `Rope.absorbBlockedLength` letting the constraint sit where geometry is
// actually holding the far end — real and legitimate, and now a lease rather
// than a payment, so none of it is permanent: measured on `maxRopeLength` alone
// the whole ball corpus grows by exactly zero. What this measures is the lease,
// `constraintLength`, which is the honest answer to "how much chain is out right
// now" and still the thing that would run away if the lease stopped being
// released.
//
// The corpus peaks at 63 cm (session-611f), then 44, 37, 25, 25, 25, 13, 11 - so
// 1.0 clears the top of that by half again while still catching a runaway by a
// wide margin: session-475f's wound-up ball reached +349 cm.
//
// It read 43 cm and 0.6 before the contact solve learned to hold a resting body
// still, and the ceiling moved for a reason worth recording rather than being
// quietly accommodated. 611f's ball is wedged in the notch between two polygons
// with its chain anchored point-blank, and a solve that no longer lets a loaded
// contact buzz its way loose is a solve that *keeps* it wedged. The geometry
// therefore refuses more chain than it used to, which is the block being real,
// not the lease running away: `maxRopeLength` does not move a millimetre through
// any of it, and the lease is re-derived from the present geometry every frame.
const CHAIN_GROWTH_TOLERANCE = 1.0;
// Consecutive frames the chain may hold a blocked-length lease while nothing is
// blocking it. The lease is the constraint sitting where geometry is actually
// holding the far end, and it is a *loan*: released at 0.5 m/s the moment the
// geometry stops refusing, so a surplus worth having survives a few dozen frames
// of release at most.
//
// It exists because `rope-grew` is blind to exactly this failure. That check
// measures the constraint against the length the chain anchored at, so a lease
// held at a constant value grows by nothing and reads as healthy for ever -
// which is what a ball swinging on a 108 cm chain did while carrying 53 cm of
// surplus it had earned in two brief blocks a thousand frames earlier
// (session-1080f). The chain is half again as long as it says it is, the player
// feels it stretch, and every invariant passes.
//
// Frames where the geometry IS refusing the correction do not count: a chain
// anchored point-blank behind a surface the ball rests on is legitimately held
// over its length for as long as the ball sits there, which across the corpus is
// hundreds of frames (session-726f). What may not happen is the surplus
// outliving the block that bought it.
const CHAIN_LEASE_HELD_FRAMES_TOLERANCE = 120;
// A chain span may graze a corner (endpoints on a surface), but its interior
// must never run deep inside static geometry — that's the chain clipping
// through the scene. Same 3 cm slack as the embed check.
const CHAIN_CLIP_TOLERANCE = 0.03;
const CHAIN_CLIP_SAMPLES = 24;
// How deep a span may cut into a circle it is wrapped round
// (`chain-cuts-circle`), metres. A span leaving a wrap on a circle leaves along
// the tangent, so the cut is how far the wrap lags the tangent: the rope keeps
// it under `Rope.CIRCLE_CUT` at every regeneration, and the solve after it
// moves the bodies a frame's worth more. `chain-clip`'s 3 cm is most of a
// rung's 3.65 cm radius, which is how a span cut 33 mm into one unseen.
const CHAIN_CIRCLE_CUT_TOLERANCE = 0.003;

// ---- energy invariant ------------------------------------------------------
// The solver may not invent energy.
//
// This is the class of bug that was found late four times in a row and once more
// as a friction motor: the rope's PBD velocity update paying itself for a
// correction that was later undone (`394f`, `458f`, `431f`, `726f`), and
// rigid-rigid friction reading a slip it could not answer (`611f`). Every one of
// them showed up as a body gaining speed with nothing pushing it, and every one
// of them was found by hand, frames at a time, because nothing was watching the
// only quantity that says "this is impossible" rather than "this looks wrong".
//
// The gate on input is what makes it safe to assert. The aim steering is a
// legitimate energy source - it overwrites `angularVelocity` outright, so the
// player can pour in as much spin as they like - and so is retracting the chain.
// The invariant therefore arms only while the sim is UNFORCED: no held button
// and no aim. In those spans nothing may go up but noise.

// Sized as a SPEED rather than as a number of joules, and taken against the
// ball's own mass: an unforced span may gain no more energy than the ball
// carries at 0.8 m/s (0.5·m·v², about 17 J for the 52 kg cast-iron ball). That
// is the same bar the old 1e-4 J was - it was set at exactly this speed, back
// when a body's mass was its area over a thousand and the ball weighed a third
// of a gram - written so it cannot go stale when a mass does. Solver noise is
// float error on the energies themselves, so it scales with them; a tolerance
// pinned to a joule count does not, and a rewrite that makes the scene heavier
// silently turns the invariant into either an assertion about nothing or a
// permanent failure.
//
// 0.8 m/s is five times the measured noise floor of the corpus and far below
// anything visible, so a refund-class bug - which banks speed every frame until
// the assembly is crossing the level - trips it long before it is felt. The
// relative term covers a fast swing, where the same fractional noise is a larger
// number.
const ENERGY_TOLERANCE_SPEED = 0.8; // m/s of ball motion, converted to J per span
const ENERGY_REL_TOLERANCE = 0.05; // plus 5% of the largest kinetic energy in the span
// An unforced span shorter than this is not worth judging: a body still landing
// when the player lets go is exchanging energy with contacts at full rate.
const ENERGY_MIN_SPAN = 30;
// Kinematic spin below which the steering is not meaningfully driving anything
// (rad/s). The aim gain is 15/s, so this is a loop within a milliradian of where
// the player is pointing.
const STEERING_SPIN = 0.02;
// Motor work below which the spin motor is not meaningfully driving anything
// (J a frame): `STEERING_SPIN` at the torque that holds a hanging ball's aim
// (70 N·m) does 0.02 J a frame, so this is a motor all but at rest.
const MOTOR_WORK = 1e-3;

// Along-surface speed the ball is carrying that neither its own spin nor the
// chain paid for (m/s), and how long a run of it is a defect rather than a
// settling transient.
//
// 0.15 m/s is well clear of what a gripping contact leaves behind on an ordinary
// frame (the contact damp alone is 1% of the ball's speed) and far under the
// 0.46 m/s the ball motored at in `session-315f`. 30 frames because the quantity
// is a *drive*: an unfunded push is re-earned every frame for as long as its
// cause lasts, where a landing or a wrap appearing is over in a handful.
const ROLL_UNFUNDED_SPEED = 0.15;
const ROLL_UNFUNDED_FRAMES = 30;

// The ball's travel along the surface it is gripping, less what its own rotation
// and the chain account for.
//
// A contact that is not at its Coulomb limit has been solved to NO SLIP: the
// contact point is stationary against the surface, so the ball's centre moves
// along that surface at exactly `radius x omega` and nothing else. The chain is
// solved in the same island as the contact, so whatever is left is a body
// being driven along a surface by nothing at all - which is the shape of every friction motor this
// project has had, and of `session-315f`, where the chain's unwind took the
// frame's rotation back off the ball while the contact solve had already sold it
// as roll: the ball crossed 40 cm of the platform it rested on, at 0.46 m/s,
// while its rotation stood still.
//
// A contact held at its friction bound is exempt and must be: a sliding ball is
// meant to travel without turning, and the cone is what bounds it there. The
// test is `limited` rather than `slipping`, because an aiming ball's cone is
// faded in the braking direction and a ball skidding to a halt sits at that
// faded bound while `slipping` still reads false (`session-477f` f170).
export class RollMonitor {
  private run = 0;

  push(level: BallLevel): Violation | null {
    const ball = level.ball;
    // The contact CARRYING the ball, chosen before the slip question is asked
    // and not among the contacts that pass it: the ball is two shapes, and
    // picking the largest non-slipping impulse hands the whole measurement to
    // the mounting loop's grazing touch whenever the rim underneath it is
    // sliding — which is a ball skidding to a halt, read off the wrong contact
    // (`session-477f` f170).
    let best: ContactConstraint | null = null;
    for (const c of level.world.frameContacts) {
      if (c.a !== ball && c.b !== ball) continue;
      if (c.normalImpulse <= 0) continue;
      if (best === null || c.normalImpulse > best.normalImpulse) best = c;
    }
    if (best === null || best.limited) {
      this.run = 0;
      return null;
    }
    const other = best.a === ball ? best.b : best.a;
    const tangent = new Vec2(-best.normal.y, best.normal.x);
    const r = best.point.sub(ball.globalPosition);
    // Rolling without slip puts `-(omega x r)` into the centre's along-surface
    // velocity — the same identity `World.applySteeringGrip` writes its roll
    // from, read backwards.
    const spinAtPoint = new Vec2(-ball.angularVelocity * r.y, ball.angularVelocity * r.x);
    const unfunded =
      ball.linearVelocity
        .sub(other.velocityAtPoint(best.point))
        .dot(tangent) + spinAtPoint.dot(tangent);
    if (Math.abs(unfunded) <= ROLL_UNFUNDED_SPEED) {
      this.run = 0;
      return null;
    }
    this.run++;
    if (this.run <= ROLL_UNFUNDED_FRAMES) return null;
    const run = this.run;
    this.run = 0;
    return {
      frame: level.frame,
      kind: "roll-unfunded",
      detail:
        `ball driven along a gripping contact at ${Math.abs(unfunded).toFixed(2)} m/s ` +
        `for ${run} frames with neither its spin (${ball.angularVelocity.toFixed(2)} rad/s) ` +
        `nor the chain accounting for it`,
    };
  }
}

// How large a REVERSING steered-grip pin correction counts, and how many in a
// row make a buzz.
//
// Magnitude alone says nothing here, and that is the whole difficulty: the pin
// is what enforces roll-without-slip in position, so a ball rolling fast has it
// making up a genuine mismatch of a centimetre a frame, every frame, for as long
// as the roll lasts - `ball-roll-wall` sustains 9.0 mm for the length of the run
// and is the mechanic working exactly as written.
//
// What separates that from a buzz is the SIGN. A correction that means something
// points the same way while its cause lasts; one that reverses frame on frame is
// the pin putting the ball back where it was and then taking it away again, and
// no mismatch behaves like that. In `session-214f` the corrections ran
// -28.7, +30.3, -32.0, +33.4 mm, strictly alternating for 23 frames - because
// the teleport was itself flipping the contact normal that produced it.
//
// 5 mm is an order above the gravity creep the pin exists to remove and well
// under the reversal a rolling ball's own noise can produce; 6 frames is three
// full cycles of a thing that needs two frames to show its shape at all.
const GRIP_PIN_CORRECTION = 0.005;
const GRIP_PIN_FRAMES = 6;

// The steered ball's grip anchor may not drift out of the surface it grips.
//
// The anchor holds an ALONG-SURFACE position: the pin projects its normal
// component straight back out (`d - n(d.n)`), so that component is not a
// quantity anything reads, and for a long time nothing kept it honest either.
// It is a material point of the SURFACE, and a rolling ball is not one - it
// rides the surface at its own radius while the anchor goes wherever the
// surface's rotation carries the point it names - so against a turning rigid
// body the two separate along the normal a couple of millimetres a frame, for as
// long as the grip holds.
//
// That is harmless exactly while the contact normal is still, and the normal is
// never still for long: `d - n(d.n)` resolves the offset against THIS frame's
// normal, so a wobble of `dtheta` hands back `|d| * dtheta` as TANGENT and the
// pin applies it in full, as a position, with no velocity change to show for it.
// On the tilting stool of `session-214f` the offset reached 314 mm, the normal
// wobbled 0.1 rad a frame as the ball crossed a seam, and the ball was teleported
// 30 mm a frame, alternating - which moved it and flipped the contact back, so
// the buzz sustained itself: 6 cm peak to peak for 23 frames, at a reported
// velocity that stayed smooth at 0.5 m/s the whole way through.
//
// So this reads the offset rather than the teleport. The teleport is a
// consequence and needs the normal to move before it appears at all, where the
// offset is the state that makes it possible and is measurable on every gripped
// frame - and it is zero by construction while the re-seat holds, which is the
// same shape `spin-overdrive` has.
//
// Zero on any frame the steered grip did not run, so a ball in the air says
// nothing either way.
export class GripPinMonitor {
  private run = 0;
  private worst = 0;
  private prev: Vec2 = Vec2.ZERO;

  push(level: BallLevel): Violation | null {
    const corr = level.ball.gripPinCorrection;
    const moved = corr.length();
    // Against the PREVIOUS frame's correction, so the run counts reversals and
    // not frames: a pin pulling the same way twice has a cause, whatever its
    // size.
    const reversed = corr.dot(this.prev) < 0;
    this.prev = corr;
    if (moved <= GRIP_PIN_CORRECTION || !reversed) {
      this.run = 0;
      this.worst = 0;
      return null;
    }
    this.run++;
    this.worst = Math.max(this.worst, moved);
    if (this.run <= GRIP_PIN_FRAMES) return null;
    const run = this.run;
    const worst = this.worst;
    this.run = 0;
    this.worst = 0;
    return {
      frame: level.frame,
      kind: "grip-pin-buzz",
      detail:
        `the steered grip's pin teleported the ball along the surface and straight ` +
        `back again for ${run} frames running, worst ${(worst * 1000).toFixed(1)} mm, ` +
        `with no velocity change to show for any of it`,
    };
  }
}

// ---- tip-rock ----------------------------------------------------------------
const TIP_ROCK_TURN = 0.035; // 2 degrees a frame
const TIP_ROCK_FRAMES = 6;

// The dangling tip's rotation may not turn one way and straight back again,
// frame after frame.
//
// The cuff's rotation is driven (`BallHook.alignToChain`), not integrated, so
// nothing in the energy books or the contact solver sees it turn: a cuff that
// alternates between two angles is invisible to every other check, while the
// hinge the chain ends on - half the bar's length from its centre - swings with
// it. On `session-339f` the tip lay on the floor with the chain slack and was
// laid flat a quarter radian about its CENTRE, which lifted the corner it
// stood on 8 mm, past the resting probe's 5 mm; on the next frame it was
// resting on nothing, so it was snapped back to face the chain, its corner
// dug into the floor again, and the cycle repeated: 14 degrees each way at
// 30 Hz, the hinge 12.5 mm back and forth, and the drawn chain sliding in and
// out of the ball with it, for as long as the ball sat still.
//
// Counted against the PREVIOUS frame's turn, so a cuff swinging round on a
// chain that is genuinely pulling it - one way for many frames - never adds up.
export class TipRockMonitor {
  private run = 0;
  private worst = 0;
  private prevRot: number | null = null;
  private prevTurn = 0;
  private tip: BallHook | null = null;

  push(level: BallLevel): Violation | null {
    const tip = level.ball.chainTip;
    if (tip === null || tip !== this.tip) {
      this.tip = tip;
      this.prevRot = tip?.globalRotation ?? null;
      this.prevTurn = 0;
      this.run = 0;
      this.worst = 0;
      return null;
    }
    const rot = tip.globalRotation;
    const turn = wrapAngle(rot - this.prevRot!);
    const reversed = turn * this.prevTurn < 0;
    this.prevRot = rot;
    this.prevTurn = turn;
    if (Math.abs(turn) <= TIP_ROCK_TURN || !reversed) {
      this.run = 0;
      this.worst = 0;
      return null;
    }
    this.run++;
    this.worst = Math.max(this.worst, Math.abs(turn));
    if (this.run <= TIP_ROCK_FRAMES) return null;
    const run = this.run;
    const worst = this.worst;
    this.run = 0;
    this.worst = 0;
    return {
      frame: level.frame,
      kind: "tip-rock",
      detail:
        `the dangling tip turned one way and straight back again for ${run} frames running, ` +
        `worst ${((worst * 180) / Math.PI).toFixed(1)} degrees a frame`,
    };
  }
}

// ---- tip-hinge-flick ---------------------------------------------------------
const TIP_HINGE_GAIN = 3;
const TIP_HINGE_SLACK = 0.01;

// The dangling tip's hinge - the chain's end - may not move further in a
// frame than the tip's own motion carries it: three steps at the larger of
// the hinge point's speeds at the frame's two ends (`v + w x r`, so a turn
// that swings the hinge is counted), plus a centimetre. Generous on purpose:
// the island's substeps can haul a tip faster than it leaves a frame
// (`tip-teleport`), and what this is for is a hinge put somewhere outright.
//
// That is what a cuff whose rotation was DRIVEN did: hoisted off a floor by
// a chain rising to a ledge corner, it was lifted whole, lost the floor and
// was snapped to face the chain in one frame with no spin to show for it,
// the hinge flicking 6-7 cm and the chain going that slack, then laid flat
// again and snapped again every five or six frames (`session-307f`
// f247-272). Turned by the physics, the same swing is a spin.
//
// So a long hinge move is only a flick when the cuff also TURNED further
// than its spin allows on the same measure (`TIP_TURN_SLACK` over three
// steps at the larger of its angular speeds): a turn with no spin behind it.
// Since the ball and its cuff collide (`BallPlayer.dangle`), a ball striking
// the cuff throws it, hinge and all, faster inside the frame than at either
// end, which is motion, not a flick (`ball-roll-wall-dangling` f302).
const TIP_TURN_SLACK = 0.05;

export class TipHingeMonitor {
  private tip: BallHook | null = null;
  private prev: Vec2 = Vec2.ZERO;
  private prevSpeed = 0;
  private prevRot = 0;
  private prevSpin = 0;

  push(level: BallLevel): Violation | null {
    const tip = level.ball.chainTip;
    const fresh = tip === null || tip !== this.tip;
    this.tip = tip;
    if (tip === null) return null;
    const hinge = tip.hinge;
    const speed = tip.velocityAtPoint(hinge).length();
    const moved = hinge.distanceTo(this.prev);
    const allowed = (TIP_HINGE_GAIN * Math.max(speed, this.prevSpeed)) / 60 + TIP_HINGE_SLACK;
    const rot = tip.globalRotation;
    const spin = Math.abs(tip.angularVelocity);
    const turned = Math.abs(wrapAngle(rot - this.prevRot));
    const turnAllowed = (TIP_HINGE_GAIN * Math.max(spin, this.prevSpin)) / 60 + TIP_TURN_SLACK;
    this.prev = hinge;
    this.prevSpeed = speed;
    this.prevRot = rot;
    this.prevSpin = spin;
    if (fresh || moved <= allowed || turned <= turnAllowed) return null;
    return {
      frame: level.frame,
      kind: "tip-hinge-flick",
      detail:
        `the dangling tip's hinge moved ${(moved * 1000).toFixed(1)} mm in a frame against ` +
        `${(allowed * 1000).toFixed(1)} mm its motion allows, turning ${((turned * 180) / Math.PI).toFixed(1)} degrees ` +
        `with no more than ${((turnAllowed * 180) / Math.PI).toFixed(1)} of spin behind it`,
    };
  }
}

// ---- tip-teleport ------------------------------------------------------------
const TIP_TELEPORT_SLACK = 0.005;

// The dangling tip may not be SEATED somewhere its velocity does not carry
// it: on a frame its bounce wrote its position (`BallHook.seatShift`), it may
// move no further than a step at the larger of its speeds at the frame's two
// ends, plus a few millimetres for the contact solver's push-out, plus what
// its driven turn moves a point of the bar (a tip laid flat is turned about
// the corner it stands on, and its centre comes down with it -
// `BallHook.alignToChain`). Asked only on such a frame, because the speeds at
// the frame's ends do not bound a frame's travel: the island's substeps can
// haul a tip faster than it leaves (`ball-roll-wall-dangling` f125: 3.9 m/s
// mid-frame, 1.5 and 2.7 at the ends).
//
// `session-472f`: a tip dragged slowly along a hook-proof floor was swept
// `CONTACT_SLOP` past its step, met the floor it was sliding on near the far
// end of that reach, and was SEATED there by `BallHook.bounce` - 15.5 mm ahead
// of a 6.3 mm step, then flown a step further by integrate. The chain went
// 1.1 cm slack, the tip slowed, the ball took the slack up and yanked it
// again: a lurch every eight to thirteen frames for as long as the drag went
// on, worse the slower the pull.
export class TipTeleportMonitor {
  private tip: BallHook | null = null;
  private prev: Vec2 = Vec2.ZERO;
  private prevSpeed = 0;
  private prevRot = 0;

  push(level: BallLevel): Violation | null {
    const tip = level.ball.chainTip;
    const fresh = tip === null || tip !== this.tip;
    this.tip = tip;
    if (tip === null) return null;
    const at = tip.globalPosition;
    const speed = tip.linearVelocity.length();
    const rot = tip.globalRotation;
    const moved = at.distanceTo(this.prev);
    // The centre's furthest from any point of the bar it can turn about.
    const turned = Math.abs(wrapAngle(rot - this.prevRot)) * Math.sqrt(MANACLE_REACH * MANACLE_REACH + (MANACLE_THICKNESS / 2) * (MANACLE_THICKNESS / 2));
    const allowed = Math.max(speed, this.prevSpeed) / 60 + TIP_TELEPORT_SLACK + turned;
    this.prev = at;
    this.prevSpeed = speed;
    this.prevRot = rot;
    // ...and the seat must account for the excess. Since the ball and its
    // cuff collide (`BallPlayer.dangle`), a ball striking the cuff throws it
    // faster inside the frame than at either end, so a frame can run long
    // with a seat of a few millimetres somewhere in it that did none of it.
    if (fresh || tip.seatShift === 0 || moved <= allowed || tip.seatShift < moved - allowed) return null;
    return {
      frame: level.frame,
      kind: "tip-teleport",
      detail:
        `the dangling tip was seated ${(tip.seatShift * 1000).toFixed(1)} mm by a bounce and moved ` +
        `${(moved * 1000).toFixed(1)} mm in the frame, against ${(allowed * 1000).toFixed(1)} mm ` +
        `its velocity and the push-out allow`,
    };
  }
}

// ---- grip-anchor-behind ----------------------------------------------------
const GRIP_ANCHOR_BEHIND = 0.005;
const GRIP_ANCHOR_BEHIND_FRAMES = 6;

// A gripped ball may not END a frame away from its grip anchor along the
// surface.
//
// The pin drags the ball to the anchor at the top of the frame, so where the
// two stand apart at the END of one is whatever moved the ball along the
// surface AFTER the pin ran: the depenetration sweep, which carries the anchor
// by its normal part alone on purpose (`World.depenetrate`, sub-millimetre),
// and the chain phase. The chain's haul is the ball's own winding paid for, and
// the pin has no business undoing it - but for a long time it did: the anchor
// walked off by the roll, the solve hauled the ball back by the roll and the
// winding, and the pin teleported it out to the anchor again next frame. Two
// pins with nothing in common but the ball, each a teleport, growing by twice
// the rim speed a frame (17 to 27 mm over twelve frames on `session-367f`), and
// their normal parts - the floor's slope, the chain's elevation - summed to a
// lift that a one-sided contact cannot cancel: the ball hovered off the floor
// 1.5 mm a frame until the contact let go, dropped 2 cm, re-seeded the anchor
// and went round again, every 12 to 33 frames, HEALTHY.
//
// `grip-pin-buzz` cannot see it: the pin pulled the same way on every frame,
// and it was the length solve doing the reversing. This reads the state
// instead: the gap the pin is about to close, which is zero by construction
// once the chain phase carries the anchor with it, and the sweep's tangential
// leftovers otherwise. Read only on a frame the STEERED grip actually held:
// an anchor outliving its grip (`STICK_RELEASE_FRAMES`) says nothing about
// the surface it has left, and a ball that is not aiming holds the crate's pin
// instead (`applyStaticGrip`), whose anchor is a contact point on the surface
// and not the centre - a radius away from the ball by construction.
export class GripAnchorMonitor {
  private run = 0;
  private worst = 0;

  push(level: BallLevel): Violation | null {
    const ball = level.ball;
    const anchor = ball.stickAnchorWorld();
    const n = ball.stickNormal;
    if (anchor === null || n === null || ball.ungrippedFrames !== 0 || !ball.kinematicRotation) {
      this.run = 0;
      this.worst = 0;
      return null;
    }
    const d = ball.globalPosition.sub(anchor);
    const behind = d.sub(n.mul(d.dot(n))).length();
    if (behind <= GRIP_ANCHOR_BEHIND) {
      this.run = 0;
      this.worst = 0;
      return null;
    }
    this.run++;
    this.worst = Math.max(this.worst, behind);
    if (this.run <= GRIP_ANCHOR_BEHIND_FRAMES) return null;
    const run = this.run;
    const worst = this.worst;
    this.run = 0;
    this.worst = 0;
    return {
      frame: level.frame,
      kind: "grip-anchor-behind",
      detail:
        `the ball ended ${run} gripped frames running away from its grip anchor along ` +
        `the surface, worst ${(worst * 1000).toFixed(1)} mm - the chain phase moved it ` +
        `and the pin will teleport it straight back`,
    };
  }
}

// ---- contact-load-runaway ---------------------------------------------------
// A body at rest may not carry a contact load that climbs frame on frame, far
// past its own weight, with nothing moving.
//
// A body wedged between two faces with `mu > 1` can hold any amount of
// internal stress: the floor's friction pushing it into the wall, the wall's
// pushing it into the floor, every impulse balanced by another and none of
// them visible as a velocity. The solve warm starts from that stress and
// cannot see it to take it back, so something that FEEDS it - a positional
// correction driving the body into one of the faces every frame - grows it
// without bound, and the friction it funds holds anything the body does.
// `session-197f` is the recording: the ball dropped into a floor-and-wall
// corner with its loop against the wall, and the static grip's pin, anchored
// along the floor, put it back 0.42 mm into the wall every frame. The two
// contacts climbed 4 N·s a frame, to 531 N·s at f197 - sixty times the ball's
// weight - and held the spin motor's full 360 N·m to a standstill for good,
// replayed HEALTHY.
//
// It reads the symptom rather than the pin, so any positional feed into a
// wedge is caught, not only that one: a body pressed by two STATIC faces at an
// angle (`CONTACT_RUNAWAY_WEDGE`), the load summed over its static contacts
// above `CONTACT_RUNAWAY_WEIGHTS` frames of its weight and rising on every
// frame of a `CONTACT_RUNAWAY_FRAMES` run, the body under
// `CONTACT_RUNAWAY_SPEED`. A stress an impact left behind DECAYS, and a real
// load landing on the body arrives in a handful of frames and then holds; only
// a feed climbs for half a second straight.
//
// Static faces only, and a wedge only, because a rising load is honest
// wherever something moving supplies it, and this cannot weigh that something.
// `session-1426f` has the ball under a 300 kg slab that is settling onto it,
// and `session-1048f` has the ball wound into its own anchor on a ceiling, one
// face, the chain hauling it in harder by the frame - both rising for longer
// than this run, both a question about the chain or the slab rather than about
// a wedge, and neither is what this reads.
const CONTACT_RUNAWAY_WEIGHTS = 10;
const CONTACT_RUNAWAY_FRAMES = 30;
const CONTACT_RUNAWAY_SPEED = 0.05;
// Cosine between two loaded static normals past which they are one face.
const CONTACT_RUNAWAY_WEDGE = 0.9;

export class ContactRunawayMonitor {
  private prev = new Map<number, number>();
  private run = new Map<number, number>();

  push(level: BallLevel): Violation | null {
    const loads = new Map<number, number>();
    const faces = new Map<number, Vec2[]>();
    const press = (body: PhysicsBody2D, n: Vec2, impulse: number): void => {
      loads.set(body.id, (loads.get(body.id) ?? 0) + impulse);
      const list = faces.get(body.id);
      if (list) list.push(n);
      else faces.set(body.id, [n]);
    };
    for (const c of level.world.frameContacts) {
      if (c.normalImpulse <= 0 || !(c.b instanceof StaticBody2D)) continue;
      press(c.a, c.normal, c.normalImpulse);
    }
    let found: Violation | null = null;
    for (const body of level.world.bodies) {
      if (!(body instanceof RigidBody2D) || body.removed) continue;
      const load = loads.get(body.id) ?? 0;
      const prev = this.prev.get(body.id) ?? 0;
      this.prev.set(body.id, load);
      const normals = faces.get(body.id) ?? [];
      const wedged = normals.some((n) => normals.some((m) => n.dot(m) < CONTACT_RUNAWAY_WEDGE));
      const weight = body.mass * GRAVITY.length() * body.gravityScale * (1 / 60);
      const rising =
        wedged &&
        weight > 0 &&
        load > CONTACT_RUNAWAY_WEIGHTS * weight &&
        load > prev &&
        body.linearVelocity.length() < CONTACT_RUNAWAY_SPEED;
      const run = rising ? (this.run.get(body.id) ?? 0) + 1 : 0;
      this.run.set(body.id, run);
      if (run !== CONTACT_RUNAWAY_FRAMES || found) continue;
      found = {
        frame: level.frame,
        kind: "contact-load-runaway",
        detail:
          `${body.name || body.constructor.name} wedged at rest carried ${load.toFixed(1)} N·s of static contact load ` +
          `(${(load / weight).toFixed(0)}x its weight), rising on every one of ${run} frames`,
      };
    }
    return found;
  }
}

// ---- wall-climb ---------------------------------------------------------------
// A free ball may not climb a wall on its own spin.
//
// What it gains through a wall is read as ENERGY, translational and potential,
// summed over the frames on which a wall-like face (`WALL_CLIMB_FACE`) is all
// that presses on it, since the last frame something floor-like did. A ball
// thrown up along a wall loses energy to the wall; one whose spin the wall turns
// into lift gains it, and the airborne frames between strikes conserve it, so a
// hop-by-hop climb adds up. An attached chain is a force of its own and resets
// it, as the drive cap's `tethered` stands aside for it, and so does anything
// that can move or a surface that runs: only static faces are walls here.
// `session-176f` is the recording: the ball in a floor-and-wall corner, the loop
// striking the wall once a revolution with the spin motor behind it, 1.6 m/s
// up per strike, 87 cm up the wall in a hundred frames, replayed HEALTHY -
// `spin-overdrive` audits the drive cap and the motor-driven ball was outside
// the cap altogether.
// The bar is a quarter of a metre of the ball's own weight, a climb no bounce
// off a wall at playing speed earns.
const WALL_CLIMB_FACE = 0.5;
const WALL_CLIMB_HEIGHT = 0.25;

export class WallClimbMonitor {
  private gained = 0;
  private prev: number | null = null;
  private reported = false;

  push(level: BallLevel): Violation | null {
    const ball = level.ball;
    const g = GRAVITY.length() * ball.gravityScale;
    const energy =
      0.5 * ball.mass * ball.linearVelocity.lengthSquared() - ball.mass * g * ball.globalPosition.y;
    const before = this.prev;
    this.prev = energy;
    let floor = false;
    let wall = false;
    let driven = false;
    for (const c of level.world.frameContacts) {
      if (c.normalImpulse <= 0) continue;
      const n = c.a === ball ? c.normal : c.b === ball ? c.normal.neg() : null;
      if (n === null) continue;
      const other = c.a === ball ? c.b : c.a;
      // A body that can move, or a surface that runs, hands the ball energy of
      // its own: a mover striking it at 2.8 m/s is not a climb
      // (`ring-square-322f` f21). Nor is a launch surface's throw, which is
      // what a pad is for: a pad stood on its side is a wall by its normal,
      // and its 5 m/s throw read as 363 J of climb (`session-238f` f238).
      if (!(other instanceof StaticBody2D) || other.surfaceMoves || other.launchSpeed > 0) driven = true;
      else if (n.y < -WALL_CLIMB_FACE) floor = true;
      else if (Math.abs(n.y) <= WALL_CLIMB_FACE) wall = true;
    }
    if (floor || driven || ball.chainAttached) {
      this.gained = 0;
      this.reported = false;
      return null;
    }
    if (!wall || before === null) return null;
    this.gained += energy - before;
    const bar = ball.mass * g * WALL_CLIMB_HEIGHT;
    if (this.reported || this.gained <= bar) return null;
    this.reported = true;
    return {
      frame: level.frame,
      kind: "wall-climb",
      detail:
        `the free ball gained ${this.gained.toFixed(0)} J through wall contacts alone since it last stood ` +
        `on anything (${(this.gained / (ball.mass * g) * 100).toFixed(0)} cm of its own weight)`,
    };
  }
}

// ---- chain-tunnel detector -------------------------------------------------
// The chain may not pass THROUGH a body it could have wrapped. Between the end
// of one frame and the end of the next, every span of the chain sweeps a
// region; a wrappable body with an exposed corner (or a disc's centre) inside
// that region has been run into, and the chain either bends round it by the
// end of the frame or has tunnelled. The wrap scan is a sample of where the
// span IS, and at 15 m/s a 10 cm body fits between two samples with room to
// spare (`session-126f`): the chain was above it on f92 and below it on f94,
// touched it on neither, and every invariant read HEALTHY, because the chain
// was never inside anything.
//
// The same crossing test the rope's own continuous scan uses (`SpanSweep`),
// measured over the frame rather than over each regeneration: what the sim
// does within a frame is its business, and what this asserts is the frame's
// outcome.
//
// Bodies the chain is tied to are not obstacles, nor is any body the chain runs
// over at the frame's end - that IS the catch. A point that crossed by less
// than `CHAIN_TUNNEL_TOLERANCE` is a graze the wrap scan's own deflection gate
// ignores on purpose, and one within `CHAIN_TUNNEL_NEAR_START` of the span's
// start is the ball's rim brushing something, which is contact's business.
//
// A body that crossed a span and IS on the path at the frame's end is a catch
// so far, and it is remembered with the side it came from: a wrap born on the
// wrong corner holds the body for a frame and is culled on the next, and by
// then no span crosses anything - the body is simply on the far side of a
// straight chain (`session-126f` f93-94, the round-post rig of `chain-sweep`).
// So a remembered body that leaves the path is asked which side of the chain it
// is on. Released the way it came, it was let go; on the far side, within the
// span's extent, the chain went through it.
const CHAIN_TUNNEL_TOLERANCE = 0.02;
const CHAIN_TUNNEL_NEAR_START = 0.05;

export class TunnelMonitor {
  private chain: Rope | null = null;
  private exit: Vec2 | null = null;
  private end: Vec2 | null = null;
  private poses = new Map<PhysicsBody2D, Pose>();
  private held = new Map<CollisionShape2D, WrapDirection>();
  private onPath = new Set<CollisionObject2D>();

  push(level: BallLevel): Violation | null {
    const chain = level.ball.chain;
    let violation: Violation | null = null;
    if (chain && chain === this.chain && this.exit && this.end) {
      violation = this.check(level, chain, this.exit, this.end);
    }
    if (chain !== this.chain) this.held.clear();
    this.chain = chain;
    this.exit = null;
    this.end = null;
    this.poses = new Map();
    this.onPath = new Set(chain ? chain.path().map((n) => n.contact.obj) : []);
    if (chain) {
      this.end = chain.end.contact.globalPosition;
      const nodes = chain.path();
      let exit: RopeNode = chain.start;
      for (let i = 1; i < nodes.length - 1; i++) {
        if (!TunnelMonitor.onStartShape(chain, nodes[i]!)) break;
        exit = nodes[i]!;
      }
      this.exit = exit.contact.globalPosition;
      for (const body of level.bodies) {
        if (body.isMobile) {
          this.poses.set(body, { position: body.globalPosition, rotation: body.globalRotation });
        }
      }
    }
    return violation;
  }

  private static onStartShape(chain: Rope, node: RopeNode): boolean {
    return (
      node.contact.obj === chain.start.contact.obj &&
      node.contact.shapeIndex === chain.start.contact.shapeIndex
    );
  }

  private previous(chain: Rope, node: RopeNode, exit: Vec2, end: Vec2): Vec2 | null {
    if (node === chain.end) return end;
    if (TunnelMonitor.onStartShape(chain, node)) return exit;
    const obj = node.contact.obj;
    if (!(obj instanceof PhysicsBody2D) || !obj.isMobile) return node.contact.globalPosition;
    const pose = this.poseOf(obj);
    if (!pose) return null;
    return pose.position.add(node.contact.position.rotated(pose.rotation));
  }

  // Where a mobile body stood at the last look - and where it IS if it got here
  // by teleporting. A `repeat` mover put back at the start of its run did not
  // cross the level to get there, so nothing it passed over is something the
  // chain passed through (`Rope.sweepPose` makes the same exemption for the
  // wrap scan, and this monitor has to agree with it or it reports the chain
  // for not wrapping a body that was never on its path).
  private poseOf(body: PhysicsBody2D): Pose | null {
    if (body instanceof AnimatableBody2D && body.jumped) {
      return { position: body.globalPosition, rotation: body.globalRotation };
    }
    return this.poses.get(body) ?? null;
  }

  private check(level: BallLevel, chain: Rope, exit: Vec2, end: Vec2): Violation | null {
    const nodes = chain.path();
    const onPath = new Set(nodes.map((n) => n.contact.obj));
    const startObj = chain.start.contact.obj;
    const endObj = chain.end.contact.obj;
    // Bodies remembered from an earlier crossing that the chain has let go of.
    for (const [shape, side] of [...this.held]) {
      const body = shape.owner as PhysicsBody2D;
      if (onPath.has(body)) continue;
      this.held.delete(shape);
      if (body.removed) continue;
      // Against the span the chain straightened INTO: the free span nearest
      // the body among those whose extent covers it. Never a coil span - a
      // 3 mm arc on the ball's rim covers a slab of the whole level in its
      // extent, and a corner half a metre away read as "beyond" it.
      const c = shape.globalPosition;
      let nearest: { i: number; signed: number } | null = null;
      for (let i = 0; i < nodes.length - 1; i++) {
        if (nodes[i]!.contact.shape === nodes[i + 1]!.contact.shape) continue;
        const s1 = nodes[i]!.contact.globalPosition;
        const e1 = nodes[i + 1]!.contact.globalPosition;
        const d = e1.sub(s1);
        const dd = d.lengthSquared();
        if (dd < CHAIN_TUNNEL_NEAR_START * CHAIN_TUNNEL_NEAR_START) continue;
        const u = c.sub(s1).dot(d) / dd;
        if (u < 0 || u > 1) continue;
        const signed = c.sub(s1).cross(d) / Math.sqrt(dd);
        if (nearest === null || Math.abs(signed) < Math.abs(nearest.signed)) nearest = { i, signed };
      }
      if (nearest === null) continue;
      const nowSide = nearest.signed > 0 ? WrapDirection.CounterClockwise : WrapDirection.Clockwise;
      if (nowSide === side || Math.abs(nearest.signed) < CHAIN_TUNNEL_TOLERANCE) continue;
      return {
        frame: level.frame,
        kind: "chain-tunnel",
        detail:
          `the chain let go of ${body.name || body.constructor.name} on the far side of span ${nearest.i}` +
          ` (${(Math.abs(nearest.signed) * 1000).toFixed(0)}mm beyond it): it went through rather than round`,
      };
    }
    // A body the chain has just started running over crossed the CHORD its
    // wraps now bend - the span as it was before the body was on it - and the
    // spans that end on the body cannot say so, since a span never tests the
    // shape it ends on. The chord can, and what it records is the side the body
    // entered from, for the release check above.
    for (let i = 1; i < nodes.length - 1; i++) {
      const body = nodes[i]!.contact.obj;
      if (body === startObj || body === endObj || this.onPath.has(body)) continue;
      let last = i;
      while (last + 1 < nodes.length - 1 && nodes[last + 1]!.contact.obj === body) last++;
      const from = nodes[i - 1]!;
      const to = nodes[last + 1]!;
      const s0 = this.previous(chain, from, exit, end);
      const e0 = this.previous(chain, to, exit, end);
      if (s0 && e0 && body instanceof PhysicsBody2D) {
        const motion: SpanMotion = {
          s0,
          e0,
          s1: from.contact.globalPosition,
          e1: to.contact.globalPosition,
        };
        const pose = body.isMobile ? this.poseOf(body) : null;
        for (const shape of body.getShapes()) {
          if (!shape.wrappable || this.held.has(shape)) continue;
          const crossing = shapeCrossesSpan(shape, pose, motion, (k) => !isSeamVertex(shape, k));
          if (crossing) this.held.set(shape, crossing.side);
        }
      }
      i = last;
    }
    for (let i = 0; i < nodes.length - 1; i++) {
      const from = nodes[i]!;
      const to = nodes[i + 1]!;
      if (from.contact.shape === to.contact.shape) continue;
      const s1 = from.contact.globalPosition;
      const e1 = to.contact.globalPosition;
      if (s1.distanceTo(e1) < 0.01) continue;
      const s0 = this.previous(chain, from, exit, end);
      const e0 = this.previous(chain, to, exit, end);
      if (!s0 || !e0) continue;
      const motion: SpanMotion = { s0, e0, s1, e1 };
      const box = spanMotionBox(motion);
      const candidates = level.world.queryShapes(box.minX, box.minY, box.maxX, box.maxY);
      for (const body of level.bodies) {
        if (body.isMobile) for (const shape of body.getShapes()) candidates.push(shape);
      }
      const seen = new Set<CollisionShape2D>();
      for (const shape of candidates) {
        if (seen.has(shape)) continue;
        seen.add(shape);
        const body = shape.owner;
        if (!(body instanceof PhysicsBody2D) || !body.isSolid || !shape.wrappable) continue;
        if (body === startObj || body === endObj || body instanceof BallHook) continue;
        if (body.removed) continue;
        if (shape === from.contact.shape || shape === to.contact.shape) continue;
        // A body the chain ran over last frame is judged by the release check
        // above and nothing else: its wraps bent the chain out of the chord
        // this test draws, so the chord "crosses" the corner the chain was
        // simply resting on as it lifts off (`session-576f` f70).
        if (this.onPath.has(body)) continue;
        const pose = body.isMobile ? this.poseOf(body) : null;
        const crossing = shapeCrossesSpan(shape, pose, motion, (k) => !isSeamVertex(shape, k));
        if (!crossing) continue;
        if (onPath.has(body)) {
          if (!this.held.has(shape)) this.held.set(shape, crossing.side);
          continue;
        }
        const dir = s1.directionTo(e1);
        const depth = Math.abs(crossing.point.sub(s1).cross(dir));
        if (depth < CHAIN_TUNNEL_TOLERANCE) continue;
        if (crossing.point.distanceTo(s1) < CHAIN_TUNNEL_NEAR_START) continue;
        return {
          frame: level.frame,
          kind: "chain-tunnel",
          detail:
            `span ${i} of the chain passed through ${body.name || body.constructor.name}` +
            ` (${(depth * 1000).toFixed(0)}mm beyond it, ${(crossing.u * 100).toFixed(0)}% along the span)` +
            ` and the chain does not bend round it`,
        };
      }
    }
    return null;
  }
}

// Total mechanical energy of everything that can move: kinetic (linear and
// angular) plus gravitational potential, with y measured downward so height is
// -y. Statics and movers are excluded because their motion is scripted, which is
// exactly the thing that would make this quantity meaningless.
export function mechanicalEnergy(world: World): number {
  let total = 0;
  for (const body of world.bodies) {
    if (body.removed || !(body instanceof RigidBody2D)) continue;
    total += 0.5 * body.mass * body.linearVelocity.lengthSquared();
    total += 0.5 * body.inertia * body.angularVelocity * body.angularVelocity;
    // The height that stores gravitational energy is the CENTRE OF MASS's. For
    // every ordinary body that is `globalPosition`; an off-centre pivot's
    // origin is its bearing, which never moves, and its centre of mass swings
    // with the rotation (`RigidBody2D.pivotComOffset` - ZERO everywhere else,
    // so the sum is unchanged where it always was). Without this a free branch
    // reads its whole KE↔PE exchange as energy appearing and vanishing.
    const com =
      body.pivotComOffset.x !== 0 || body.pivotComOffset.y !== 0
        ? body.globalPosition.add(body.pivotComOffset.rotated(body.globalRotation))
        : body.globalPosition;
    total += body.mass * 9.8 * body.gravityScale * -com.y;
    // A spring body stores ELASTIC potential (see `RigidBody2D.spring`), and
    // without it the leaf springing back reads as kinetic plus gravitational
    // energy appearing out of nowhere - an unforced gain, which is precisely
    // what `EnergyMonitor` fires on. `k = m·w²` by construction, so the stored
    // energy is 0.5·m·w²·d² per axis. Damping only ever removes energy, so the
    // monitor's one-sided bound stays valid with the term in. For every body
    // that is not spring-mounted `spring` is null and the sum is unchanged.
    if (body.spring) {
      const d = body.globalPosition.sub(body.spring.anchor);
      total +=
        0.5 *
        body.mass *
        (body.spring.omegaX * body.spring.omegaX * d.x * d.x +
          body.spring.omegaY * body.spring.omegaY * d.y * d.y);
    }
    // A pivot body's torsion spring stores elastic potential exactly as the
    // linear spring does: `k = I·w²` by construction, so 0.5·I·w²·Δθ². Damping
    // only ever removes energy, so the monitor's one-sided bound stays valid.
    if (body.pivotSpring) {
      const s = body.pivotSpring;
      const d = body.globalRotation - s.restAngle;
      total += 0.5 * body.inertia * s.omega * s.omega * d * d;
    }
  }
  // A bending root's hinges store energy in their springs as a pivot's
  // torsion spring does (`RootHinge.energy`).
  for (const unit of world.ties.units) {
    if (unit instanceof RootBendUnit) for (const h of unit.hinges) total += h.energy;
  }
  return total;
}

// The inputs that put energy into a ball level, as opposed to merely being held.
//
// Deploy (`fire`) is hold-to-keep, so it is held for most of a session and
// gating on "any button" disarms the invariant almost everywhere - which is what
// it did. Holding a chain out is not a source: the chain is a constraint, and
// the one moment the deploy injects anything is the frame the hook is spawned,
// which changes the body set and restarts the span anyway. Winding the chain in
// or out genuinely does work on the ball, so those three are sources.
const FORCED_ACTIONS: Action[] = ["retract", "extend", "retractClick"];

function anyForcedInput(input: FrameInput): boolean {
  return FORCED_ACTIONS.some((a) => input[a].held);
}

export class EnergyMonitor {
  private baseline: number | null = null;
  private span = 0;
  private peakKinetic = 0;
  private bodyCount = 0;
  // The largest gain it has ever reported, in joules. The violation carries the
  // number in its prose, and a metric table cannot parse prose (see the note at
  // the top of `sim/query.ts`): a number that has been through `toExponential`
  // is a number no caller can use.
  worstGain = 0;

  // Call once per frame after physicsProcess, with the frame's input. Returns a
  // violation the first frame an unforced span gains energy, then re-arms.
  push(level: BallLevel, input: FrameInput): Violation | null {
    // The steering is only a source while it is actually turning the ball.
    // Asking "is the player aiming" instead disarms the invariant permanently on
    // any mouse-recorded bundle, where the cursor is somewhere at every instant
    // and the ball is therefore always nominally aiming; what matters is the
    // spin it writes, and a ball whose loop already faces the cursor is handed
    // essentially none. `kinematicRotation` is the sim's own record of having
    // overwritten the spin this frame.
    //
    // Read from the spin the aim WROTE this frame (`BallLevel.aimSpin`) as well
    // as from what the ball ended the frame with, because the two differ by
    // exactly the chain's refusal: a ball wound tight against its anchor has
    // its whole turn refused by the unwind every frame and ends every frame at
    // zero, while the winch has been paid that turn's worth of chain. Read at
    // the end alone, a ball shoving its 294 kg anchor along the floor at a
    // steady 1 m/s² under a held aim was an unforced gain (`session-726f`
    // f430-500).
    //
    // A spin MOTOR (`RigidBody2D.spinMotorActive`) is a source by the work it
    // did, which it measures itself: one holding a still aim against a load
    // pushes and does none.
    const steering =
      (level.ball.kinematicRotation &&
        (Math.abs(level.ball.angularVelocity) > STEERING_SPIN ||
          Math.abs(level.aimSpin) > STEERING_SPIN)) ||
      (level.ball.spinMotorActive && Math.abs(level.ball.spinMotorFrameWork) > MOTOR_WORK);
    // A trampoline pays out of a spring nothing in the scene stores, so a frame
    // one fired is a frame energy legitimately entered the level - the same
    // statement `FORCED_ACTIONS` makes about the winch, and made by the sim
    // itself rather than by the input, because a pad fires on contact and no
    // button is pressed for it (see `World.launchedThisFrame`).
    const launched = level.world.launchedThisFrame;
    // A running conveyor is the same kind of source: it accelerates what rests
    // on it out of a motor nothing in the scene stores, and no button is
    // pressed for it (see `World.conveyedThisFrame`). A rider on a scripted
    // mover is the same hole and is not closed here (docs/conveyors.md).
    const conveyed = level.world.conveyedThisFrame;
    // ...and so is a belt that has the ball's chain by the end: a ride is
    // DRIVEN (`RopeRide`), so the carried anchor hauls a hanging ball along
    // and up over a roller out of that same motor, through the chain rather
    // than a contact, where `conveyedThisFrame` cannot see it (a headless
    // `TEST_BELT` lap fired `energy-gained` at f583 on the lift over the start
    // roller; `cli belts` `energy-armed`).
    const ridden = level.ball.chain?.end instanceof RopeRide;
    // A ball rolling in at the opening of a level is being HELD at its entry
    // speed by the level itself (see `BallLevel.ENTRY_SPEED`), which is a force
    // on it as surely as the winch is - and one no input carries, since the
    // entry is the stretch of the run where the player's input is dropped. Said
    // by the sim rather than read off the stream, exactly as the trampoline
    // below it is.
    const rollingIn = level.rollingIn;
    // THE INPUT THE FRAME WAS PLAYED WITH, which is the caller's everywhere
    // except during a recorded arrival, where the run is played from the
    // recording's stream and the caller's is not the ball's at all (see
    // `BallLevel.playerInput`). Read off the stream there, an arrival's winch
    // is a source the monitor cannot see - seven seconds of chain being wound
    // in under a neutral-looking input, read as energy arriving from nowhere.
    const forced = anyForcedInput(level.playedInput ?? input);
    const bodies = level.world.bodies.filter((b) => !b.removed).length;
    if (forced || steering || launched || conveyed || ridden || rollingIn || bodies !== this.bodyCount) {
      // A body appearing or disappearing (a hook spawned, a hook removed)
      // changes the total by construction, so the span restarts rather than
      // reading the difference as the solver's doing.
      this.bodyCount = bodies;
      this.baseline = null;
      this.span = 0;
      this.peakKinetic = 0;
      return null;
    }

    const energy = mechanicalEnergy(level.world);
    const kinetic = kineticEnergy(level.world);
    this.peakKinetic = Math.max(this.peakKinetic, kinetic);
    if (this.baseline === null) {
      this.baseline = energy;
      this.span = 1;
      return null;
    }
    this.span++;
    if (this.span < ENERGY_MIN_SPAN) return null;
    const floor = 0.5 * level.ball.mass * ENERGY_TOLERANCE_SPEED * ENERGY_TOLERANCE_SPEED;
    const tolerance = floor + ENERGY_REL_TOLERANCE * this.peakKinetic;
    if (energy <= this.baseline + tolerance) return null;
    const gain = energy - this.baseline;
    this.worstGain = Math.max(this.worstGain, gain);
    const span = this.span;
    this.baseline = null;
    this.span = 0;
    this.peakKinetic = 0;
    return {
      frame: level.frame,
      kind: "energy-gained",
      detail:
        `unforced ${span}f span gained ${gain.toExponential(2)} J ` +
        `(tolerance ${tolerance.toExponential(2)})`,
    };
  }
}

export function kineticEnergy(world: World): number {
  let total = 0;
  for (const body of world.bodies) {
    if (body.removed || !(body instanceof RigidBody2D)) continue;
    total += 0.5 * body.mass * body.linearVelocity.lengthSquared();
    total += 0.5 * body.inertia * body.angularVelocity * body.angularVelocity;
  }
  return total;
}

// Ball & chain invariants: NaN, runaway speed, chain-over-length once
// anchored, ball embedded in static geometry. No stuck detector — the ball
// has no direct locomotion input to freeze.
// Breakable geometry, on both drivers (see `level/breakable.ts`).
//
// Two things, and they are the two ways the feature can be quietly wrong rather
// than visibly wrong. A body whose count has run out is a body that should not
// be in the world: the scan breaks it on the frame it earns it, so one left
// standing means the level driver stopped calling the scan or stopped acting on
// what it returned - and nothing else would notice, because a floor that no
// longer breaks looks exactly like a floor. A rope anchored to a body that HAS
// left is the other half: the break has to reach whoever was holding on, or the
// player hangs from geometry that is not there.
function checkBreakables(
  frame: number,
  world: World,
  anchor: CollisionObject2D | null,
): Violation[] {
  const out: Violation[] = [];
  for (const body of world.bodies) {
    if (body.breakForce <= 0 || body.removed) continue;
    if (body.impactHits < body.durability) continue;
    out.push({
      frame,
      kind: "break-late",
      detail: `body ${body.buildIndex} has taken ${body.impactHits} of ${body.durability} hits and is still in the world`,
    });
  }
  if (anchor?.removed) {
    out.push({
      frame,
      kind: "break-ghost",
      detail: `the rope is anchored to body ${anchor.buildIndex}, which has left the world`,
    });
  }
  return out;
}

// What frame each level was LAST seen to have been finished on, so the one
// thing that cannot be asked about a single frame - that the crossing never
// clears and never moves - can be (see `finish-once`).
//
// A WeakMap on the level instance rather than a field: a reset builds a fresh
// `BallLevel`, so a fresh key is exactly "this is a new run" with nothing to
// clear, and the detector stays read-only against the sim. Weak, so a level
// dropped by a replay's rebuild is not held alive by its own watchdog.
const finishedAt = new WeakMap<BallLevel, number>();

// The frame each glass BALL was first seen broken on and where it was held, for
// the same reason as `finishedAt`: "broken once and for good" is a claim about
// frames, not about one. Keyed by the ball rather than the level, because a
// respawn replaces the ball (see `BallLevel.respawn`): the broken one is gone
// for good, and the new one is whole.
const shatteredAt = new WeakMap<BallPlayer, { frame: number; x: number; y: number }>();

// THE GLASS BALL (`BallLevel.shatterIfStruck`). Four ways it can be wrong, all
// silent in a picture of one frame:
//
//   glass-iron       - an iron ball says it broke. Normal must never.
//   glass-intact     - a whole glass ball ended the frame with a contact that
//                      pushed on it, which is a touch the break never heard
//                      about (a phase added after the check, a contact list it
//                      did not read).
//   glass-once       - the break moved, cleared, or the ball mended itself.
//   glass-held       - a broken ball moved from where it broke, or something
//                      still collides with it.
function checkGlassBall(level: BallLevel): Violation[] {
  const out: Violation[] = [];
  const b = level.ball;
  const frame = level.frame;
  if (!b.glass) {
    if (b.shattered || level.shatteredFrame !== null) {
      out.push({ frame, kind: "glass-iron", detail: "an iron ball broke" });
    }
    return out;
  }
  if (level.shatteredFrame === null) {
    if (b.shattered) out.push({ frame, kind: "glass-once", detail: "the ball is broken with no frame it broke on" });
    if (shatteredAt.has(b)) {
      out.push({ frame, kind: "glass-once", detail: `the ball broke on f${shatteredAt.get(b)!.frame} and is whole again` });
    }
    if (level.completedFrame === null) {
      for (const c of level.world.frameContacts) {
        // The most it pushed, as the break reads it: a contact the island
        // solved can push and end the frame on zero (`maxNormalImpulse`).
        if (c.maxNormalImpulse > 0 && (c.a === b || c.b === b)) {
          const other = c.a === b ? c.b : c.a;
          out.push({
            frame,
            kind: "glass-intact",
            detail: `whole after a contact with ${other.name || `body#${other.buildIndex}`} (max pn=${c.maxNormalImpulse.toFixed(3)})`,
          });
          break;
        }
      }
    }
    return out;
  }
  const seen = shatteredAt.get(b);
  const at = b.globalPosition;
  if (seen === undefined) {
    shatteredAt.set(b, { frame: level.shatteredFrame, x: at.x, y: at.y });
  } else {
    if (seen.frame !== level.shatteredFrame) {
      out.push({ frame, kind: "glass-once", detail: `broke on f${seen.frame} and now says f${level.shatteredFrame}` });
    }
    if (at.x !== seen.x || at.y !== seen.y) {
      out.push({ frame, kind: "glass-held", detail: `the broken ball moved from (${seen.x}, ${seen.y}) to ${at}` });
    }
  }
  if (!b.shattered || !b.passable || b.chain !== null) {
    out.push({ frame, kind: "glass-held", detail: "broken, but still solid or still carrying its chain" });
  }
  // From the frame after: the frame it broke on is the one whose contacts broke
  // it.
  for (const c of frame > level.shatteredFrame ? level.world.frameContacts : []) {
    if (c.a === b || c.b === b) {
      out.push({ frame, kind: "glass-held", detail: "something is in contact with the broken ball" });
      break;
    }
  }
  return out;
}

export function checkBallInvariants(level: BallLevel): Violation[] {
  const out: Violation[] = [];
  const b = level.ball;
  const frame = level.frame;
  out.push(...checkBreakables(frame, level.world, b.anchoredTo));

  // BERRY VINES (`level/starberry.ts`): every stalk body finite, no stalk
  // stretched past its berry's reach, the chain never on anything of the
  // vine but a berry - the cord and the stalk joints are no targets - and
  // nothing in contact with a vine body but the ball or its hook with a berry
  // (the one solid vine body, `VineLink.solid`). Asked of the vine's own list
  // of its berries rather than of the flag, which is the thing being checked.
  for (const c of level.world.frameContacts) {
    for (const [side, other] of [
      [c.a, c.b],
      [c.b, c.a],
    ] as const) {
      if (!(side instanceof VineLink)) continue;
      const isBerry = level.vines.some((vine) => vine.berries.some((berry) => berry.fruit === side));
      if (!isBerry || (other !== b && !(other instanceof BallHook))) {
        out.push({ frame, kind: "starberry-contact", detail: `${side.name} in contact with ${other.name}` });
      }
    }
  }
  for (const vine of level.vines) {
    if (!vine.starberry) continue;
    for (const link of vine.allLinks) {
      if (!link.globalPosition.isFinite() || !link.linearVelocity.isFinite()) {
        out.push({ frame, kind: "starberry-nan", detail: `non-finite ${link.name}` });
      }
    }
    for (const berry of vine.berries) {
      const length = berry.fruit.globalPosition.distanceTo(vine.links[berry.parentIndex]!.globalPosition);
      if (length > berry.cap + 0.05) {
        out.push({ frame, kind: "starberry-stretch", detail: `stalk stretched to ${length.toFixed(3)} m` });
      }
    }
    const held = b.chain?.end.contact.obj;
    if (vine.links.some((link) => link === held) || vine.berries.some((berry) => berry.joint === held)) {
      out.push({ frame, kind: "starberry-stem-grab", detail: "the chain is on a berry vine's cord or stalk" });
    }
  }

  // THE CROSSING IS FINAL. `completedFrame` is written once, on the frame the
  // player entered the finish line, and a level that has been finished stays
  // finished - the page freezes the run on it, the recorder seals it, and a
  // bundle that replays has to finish on the same frame or the replay is of a
  // different run. A value that clears or moves is the one shape of bug the
  // per-frame checks cannot see, since each frame on its own looks perfectly
  // reasonable - and it is a live risk rather than a theoretical one, because
  // the ball can leave a finish area it has entered and enter it again.
  if (level.completedFrame !== null) {
    const seen = finishedAt.get(level);
    if (seen === undefined) {
      finishedAt.set(level, level.completedFrame);
    } else if (level.completedFrame !== seen) {
      out.push({
        frame,
        kind: "finish-once",
        detail: `the level was finished on f${seen} and now says f${level.completedFrame}`,
      });
    }
  } else if (finishedAt.has(level)) {
    out.push({
      frame,
      kind: "finish-once",
      detail: `the level was finished on f${finishedAt.get(level)} and is no longer finished`,
    });
  }

  out.push(...checkGlassBall(level));

  if (!b.globalPosition.isFinite() || !b.linearVelocity.isFinite()) {
    out.push({ frame, kind: "nan", detail: `pos=${b.globalPosition} vel=${b.linearVelocity}` });
    return out;
  }
  if (b.linearVelocity.length() > RUNAWAY_SPEED) {
    out.push({
      frame,
      kind: "runaway-speed",
      detail: `|vel|=${b.linearVelocity.length().toFixed(1)}`,
    });
  }
  // Friction fighting the steered spin's slip may spend only what the sustained
  // load (the ball's own weight into the surface) and the linear slip fund -
  // never an impact's normal impulse. The spin is kinematic, so the contact
  // solve cannot despin it: traction beyond that budget converts rim speed into
  // centre velocity with the spin paying nothing, which is energy from nothing.
  // A ball rolling into a wall spent 196 N·s of a 234 N·s impact Pn stopping
  // its rim's slip and left the floor at 4.4 m/s straight up, spin intact
  // (`session-773f` f600). The solver clamps to the budget; this reads what was
  // actually applied, so any new path spending outside it reports here.
  if (level.world.spinDriveOverspend > SPIN_OVERDRIVE_TOLERANCE) {
    out.push({
      frame,
      kind: "spin-overdrive",
      detail:
        `contact friction overspent the kinematic spin's traction budget by ` +
        `${level.world.spinDriveOverspend.toFixed(1)} N·s` +
        (level.world.spinDriveDetail ? ` (${level.world.spinDriveDetail})` : ""),
    });
  }
  if (b.chain) {
    const len = b.chain.getCurrentLength();
    if (b.chainAnchored && len > b.chain.constraintLength + CHAIN_OVER_LENGTH_TOLERANCE) {
      out.push({
        frame,
        kind: "rope-over-length",
        detail: `len=${len.toFixed(1)} > max=${b.chain.constraintLength.toFixed(1)}`,
      });
    }
    if (Number.isNaN(len)) out.push({ frame, kind: "rope-nan", detail: "chain length NaN" });
    // A stowed chain is the whole chain coiled onto the ball with its end on
    // the rim (`BallPlayer.stowIfWoundIn`): nothing solves it, so nothing may
    // move it either - its end stays on the ball and its length stays the
    // chain's, to the closing's own tolerance. The hazard it watches for is a
    // final span read as a full turn rather than as nothing (see
    // `Rope.closeCoil`), which is a metre and a half appearing from nowhere.
    if (b.chainStowed) {
      const onBall = b.chain.end.contact.obj === b;
      const off = Math.abs(len - b.chain.maxRopeLength);
      if (!onBall || off > CONTACT_SLOP) {
        out.push({
          frame,
          kind: "chain-stowed",
          detail: onBall
            ? `stowed chain measures ${len.toFixed(3)} against ${b.chain.maxRopeLength.toFixed(3)}`
            : "stowed chain's end is not on the ball",
        });
      }
    }
    if (
      level.chainAnchorLength !== null &&
      b.chain.constraintLength > level.chainAnchorLength + CHAIN_GROWTH_TOLERANCE
    ) {
      out.push({
        frame,
        kind: "rope-grew",
        detail: `max=${b.chain.constraintLength.toFixed(2)} vs ${level.chainAnchorLength.toFixed(2)} at anchor`,
      });
    }
    if (level.chainLeaseHeldFrames > CHAIN_LEASE_HELD_FRAMES_TOLERANCE) {
      out.push({
        frame,
        kind: "rope-lease-held",
        detail: `${(b.chain.blockedSlack * 100).toFixed(1)}cm of blocked-length lease unrepaid for ${level.chainLeaseHeldFrames} frames with nothing blocking it`,
      });
    }
    // Chain-clip: no span's interior may run deep inside static geometry. A span
    // legitimately touches corners it wraps (endpoints on the surface), so
    // sample interior points and flag only genuine penetration past tolerance.
    const nodes = b.chain.path().map((n) => n.contact.globalPosition);
    // The solid statics: a hook-only, passable piece is one the world
    // collides nothing with, so a chain or a body inside it is not clipping
    // anything (`session-193f-lamp`'s lantern hangs inside its own bracket).
    const statics = level.world.bodies.filter(
      (body): body is StaticBody2D => body instanceof StaticBody2D && body.hasShape() && body.isSolid,
    );
    let clip: { depth: number; name: string } | null = null;
    // The chain's end as a CUFF round a bar (a rail ring, a rod): its last
    // span runs to the cuff's centre and the chain leaves it at the rim, so
    // the stretch inside the cuff's disc is inside the ring, not inside the
    // bar's body - the rule the rope itself wraps by (`cuffEnd`, `inCuff` in
    // `Rope.regeneratePath`). Round a rod the disc holds the rod and the cuff
    // mounted round it, so a last span shorter than 24 samples of the disc's
    // depth put its last sample in both: a ball swung over the top of a rung
    // on a chain gone short read as 3-4 cm of clip on every frame of the fall.
    const cuff = cuffEnd(b.chain.end);
    for (let s = 0; s < nodes.length - 1 && !clip; s++) {
      const a = nodes[s]!;
      const d = nodes[s + 1]!.sub(a);
      for (let k = 1; k < CHAIN_CLIP_SAMPLES && !clip; k++) {
        const p = a.add(d.mul(k / CHAIN_CLIP_SAMPLES));
        for (const body of statics) {
          if (cuff !== null && body === cuff.body && cuff.covers(p)) continue;
          // The whole body, not its primary piece: a compound wall is one body of
          // several convex shapes, and a check that only ever looked at the first
          // could not see a chain buried in any of the others (`session-306f`).
          const ov = bodyOverlapCircle(body, p, 0);
          if (ov && ov.depth > CHAIN_CLIP_TOLERANCE) {
            clip = { depth: ov.depth, name: body.name || "static" };
            break;
          }
        }
      }
    }
    if (clip) {
      out.push({
        frame,
        kind: "chain-clip",
        detail: `chain span ${clip.depth.toFixed(2)}m inside ${clip.name}`,
      });
    }
    // Chain-cuts-circle: no span may cut into a circle one of its ends is
    // wrapped on, static or not - a ladder's rungs swing on a rigid body,
    // which `chain-clip` does not look at, and its 3 cm is most of a rung.
    // The span's closest approach to the circle's centre, exactly, rather than
    // samples. Not a span between two nodes on the same circle, which is the
    // arc the rope lies along there (`Rope.spanLength`), not the chord; not the
    // ball's own coil, which is the ball's; not the stretch of the last span
    // inside a cuff's disc (as `chain-clip`). Red on `session-259f` before the
    // circle gate was a depth: spans cut up to 33 mm into the ladder's rungs
    // (f23-243).
    let cut: { depth: number; span: number } | null = null;
    const path = b.chain.path();
    for (let s = 0; s + 1 < path.length; s++) {
      const n0 = path[s]!;
      const n1 = path[s + 1]!;
      if (n0.contact.shape === n1.contact.shape) continue;
      for (const node of [n0, n1]) {
        // Wraps only, the path's interior: its ends are what the chain is
        // attached to, and a ring threaded on a vine ends it inside the link
        // it rides by construction.
        if (node === path[0] || node === path[path.length - 1]) continue;
        const shape = node.contact.shape;
        if (shape.shape.kind !== "circle" || node.contact.obj === b) continue;
        const a = n0.contact.globalPosition;
        const d = n1.contact.globalPosition.sub(a);
        const c = shape.globalPosition;
        const dd = d.dot(d);
        const t = dd < 1e-18 ? 0 : Math.max(0, Math.min(1, c.sub(a).dot(d) / dd));
        const near = a.add(d.mul(t));
        if (cuff !== null && node.contact.obj === cuff.body && cuff.covers(near)) continue;
        const depth = shape.shape.radius - near.distanceTo(c);
        if (depth > CHAIN_CIRCLE_CUT_TOLERANCE && depth > (cut?.depth ?? 0)) cut = { depth, span: s };
      }
    }
    if (cut) {
      out.push({
        frame,
        kind: "chain-cuts-circle",
        detail: `span ${cut.span} cuts ${(cut.depth * 1000).toFixed(1)} mm into a circle it is wrapped on`,
      });
    }
    // Chain-body-embedded: no rigid body the chain runs over - its anchor, or
    // anything it wraps - may stand deep inside static geometry. The chain
    // solve writes its correction straight onto those bodies and pays them
    // velocity for it, so they are the one class of body a chain can haul into
    // the scenery, and nothing watched them: `session-133f`'s plank tunnelled
    // through the post it rested on, 89 mm deep, and replayed HEALTHY on every
    // invariant, all of which are about the ball. The same tolerance as
    // `player-embedded`, and measured the same way - the deepest manifold
    // point against each static piece.
    for (const node of b.chain.path()) {
      const obj = node.contact.obj;
      if (!(obj instanceof RigidBody2D) || obj === b || obj.removed || !obj.hasShape()) continue;
      let worst: { depth: number; name: string } | null = null;
      for (const shape of obj.getShapes()) {
        for (const body of statics) {
          for (const other of body.getShapes()) {
            const depth =
              shape.shape.kind === "circle"
                ? (circleOverlap(shape.globalPosition, shape.shape.radius, other)?.depth ?? 0)
                : Math.max(0, ...shapeContacts(shape, other).map((c) => c.depth));
            if (depth > (worst?.depth ?? 0)) worst = { depth, name: body.name || "static" };
          }
        }
      }
      if (worst && worst.depth > EMBED_TOLERANCE) {
        out.push({
          frame,
          kind: "chain-body-embedded",
          detail: `${obj.name || obj.constructor.name} ${(worst.depth * 1000).toFixed(0)}mm inside ${worst.name}`,
        });
        break;
      }
    }
  }
  for (const body of level.world.bodies) {
    // A static the world collides nothing with - a hook-only, passable piece
    // - is not one a body can be embedded in.
    if (!(body instanceof StaticBody2D) || !body.hasShape() || !body.isSolid) continue;
    const ov = bodyOverlapCircle(body, b.globalPosition, b.radius);
    if (ov && ov.depth > EMBED_TOLERANCE) {
      out.push({
        frame,
        kind: "player-embedded",
        detail: `depth=${ov.depth.toFixed(2)} in ${body.name || "static"}`,
      });
      break;
    }
  }
  // The hook, by the same rule: whether flying, bounced or dangling it is a
  // solid bar the world may not swallow. An attached hook is removed from the
  // world, so a cuff legitimately half-buried in what it bit never reports
  // here.
  for (const hook of level.world.bodies) {
    if (!(hook instanceof BallHook) || !hook.hasShape()) continue;
    const hs = hook.primaryShape();
    let deepest = 0;
    let where = "";
    for (const body of level.world.bodies) {
      if (!(body instanceof StaticBody2D) || !body.hasShape()) continue;
      for (const s of body.getShapes()) {
        const depth =
          hs.shape.kind === "circle"
            ? (circleOverlap(hook.globalPosition, hs.shape.radius, s)?.depth ?? 0)
            : Math.max(0, ...shapeContacts(hs, s).map((c) => c.depth));
        if (depth > deepest) {
          deepest = depth;
          where = body.name || "static";
        }
      }
    }
    if (deepest > HOOK_EMBED_TOLERANCE) {
      out.push({
        frame,
        kind: "hook-embedded",
        detail: `depth=${(deepest * 1000).toFixed(1)}mm in ${where}`,
      });
    }
  }
  // The dangling cuff may not be inside the ball it is chained to. The throw
  // carries a collision exception between the two (it spawns the mouth on the
  // rim); dangling, they collide (`BallPlayer.dangle`). With the exception
  // kept, a cuff turned by the physics swung about its hinge into the ball and
  // hung there 14 cm deep (`session-311f`).
  // The ball's loop ride (`BallPlayer.applyLoopRide`) may not follow the
  // ball's own dangling cuff: the cuff is moved by the ball's own winch, and a
  // ride tracks its surface's speed, so riding it the ball chased a cuff it was
  // whirling itself - 3.7 m/s a frame, 7.2 m/s in two (`session-291f` f186).
  const riding = (level.ball as unknown as { ride: { body: unknown } | null }).ride;
  if (riding !== null && level.ball.chainTip !== null && riding.body === level.ball.chainTip) {
    out.push({ frame, kind: "ride-on-cuff", detail: "the ball's loop ride is following its own dangling cuff" });
  }
  const tip = level.ball.chainTip;
  if (tip !== null && tip.hasShape()) {
    const ov = circleOverlap(level.ball.globalPosition, level.ball.radius, tip.primaryShape());
    if (ov !== null && ov.depth > TIP_IN_BALL_TOLERANCE) {
      out.push({ frame, kind: "tip-in-ball", detail: `the dangling cuff is ${(ov.depth * 1000).toFixed(1)} mm inside the ball` });
    }
  }
  out.push(...checkSceneChains(frame, level.sceneChains));
  out.push(...checkTieChains(frame, level.tieChains));
  out.push(...checkRootBends(frame, level.world));
  out.push(...checkSleepers(frame, level.world));
  return out;
}

// ---- scene chains -----------------------------------------------------------
// What `session-235f` replayed HEALTHY with: nine slats of a rope bridge
// spinning at exactly one, two, four and six turns a frame, a chain 2.9 m over
// its length from frame 1, and the rightmost slat asleep at 125 m/s from the
// build settle on. Every invariant there was looked at the ball; these look at
// the scenery a chain holds.

// Metres a scene chain may end a frame over its length. Ten times the sweep's
// tolerance: a rig the cap binds on ends at 15 mm (`chain-order`), and the one
// that is actually broken ends at metres.
const SCENE_CHAIN_OVER_LIMIT = 0.05;
// Rad/s a body on a chain may turn at: a quarter turn a frame. The rope's
// correction is written against the body's pose at the start of the pass, so
// a body turning further than that between two looks is one the solve is
// wrong about by construction - and at a whole turn a frame it is one the
// solve cannot see turning at all, which is how the bridge's slats stayed at
// 373 rad/s for two hundred frames. Nothing a chain legitimately holds spins
// at 15 rev/s; the wound-up ball is not a chain body and is not read here.
const CHAIN_SPIN_LIMIT = Math.PI / 2 / (1 / 60);
// A SLEEPING body is one the integrator skips; one skipped while carrying
// speed is frozen in mid-air with a jump banked for whenever it wakes. A body
// hanging on a chain idles at gravity's per-frame bite (0.16 m/s), so the bar
// sits well clear of that.
const ASLEEP_SPEED_LIMIT = 1;
const ASLEEP_SPIN_LIMIT = 10;
// Metres a SLEEPING chain may be over its length before it counts as stretched
// by something awake. The invariant's own over-length bar rather than the
// sweep's tolerance: the one frame a mid-frame wake leaves a chain asleep can
// stretch it by what its body moved that frame - 7 mm on `session-291f`'s
// link block under the ball's haul, twice in 290 frames, and gone the next
// frame - while a chain that has really been let go of is over by decimetres
// and stays so.
const SCENE_CHAIN_SLEEP_STRETCH = SCENE_CHAIN_OVER_LIMIT;

export function checkSceneChains(frame: number, chains: readonly SceneChain[]): Violation[] {
  const out: Violation[] = [];
  if (chains.length === 0) return out;
  const spinning = new Set<RigidBody2D>();
  // Which chains hold each rigid body, for the half-asleep rule below.
  const holders = new Map<RigidBody2D, SceneChain[]>();
  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i]!;
    const over = chain.rope.overLength;
    if (over > SCENE_CHAIN_OVER_LIMIT) {
      out.push({
        frame,
        kind: "chain-over-length",
        detail:
          `chain#${i} (${chainBodies(chain)}) ${(over * 1000).toFixed(0)}mm over its length` +
          (chain.asleep ? " while asleep" : ""),
      });
    }
    chain.eachBody((body) => {
      const list = holders.get(body);
      if (list) list.push(chain);
      else holders.set(body, [chain]);
      if (chain.asleep || spinning.has(body)) return;
      if (Math.abs(body.angularVelocity) > CHAIN_SPIN_LIMIT) {
        spinning.add(body);
        out.push({
          frame,
          kind: "chain-body-spin",
          detail:
            `body#${body.buildIndex} on chain#${i} turning at ${body.angularVelocity.toFixed(0)} rad/s ` +
            `(${(Math.abs(body.angularVelocity) / 60 / (2 * Math.PI)).toFixed(2)} turns a frame)`,
        });
      }
    });
  }
  // A body one chain holds asleep and another holds awake is a set that has
  // let go of one end: the sleeping chain is out of the sweep, so nothing
  // measures or corrects its length while the awake one goes on moving the
  // body it shares. The sleeping chain being STRETCHED is what makes it a
  // defect rather than a frame's lag: a body a contact wakes mid-frame leaves
  // its chains asleep until the next frame's `wakeChains`, which is one frame
  // of the two states disagreeing and nothing moved (`session-291f` f22, the
  // arena's link block, once in 170 frames), where a chain that is asleep and
  // over its tolerance has had its body taken from it.
  for (const [body, list] of holders) {
    if (list.length < 2) continue;
    const asleep = list.filter((c) => c.asleep && c.rope.overLength > SCENE_CHAIN_SLEEP_STRETCH);
    if (asleep.length === 0 || asleep.length === list.length) continue;
    const worst = Math.max(...asleep.map((c) => c.rope.overLength));
    out.push({
      frame,
      kind: "chain-asleep-stretched",
      detail:
        `body#${body.buildIndex} held by ${list.length} chains, ${asleep.length} asleep and stretched ` +
        `(${(worst * 1000).toFixed(1)}mm over; body ${body.asleep ? "asleep" : "awake"})`,
    });
  }
  return out;
}

function chainBodies(chain: SceneChain): string {
  const ids: number[] = [];
  for (const node of chain.rope.path()) ids.push(node.contact.obj.buildIndex);
  return ids.join("-");
}

// A bending root's hinges (`RootHinge`, level/rootBends.ts): the two anchors
// of a hinge further apart at the end of a frame than `ROOT_HINGE_OPEN_LIMIT`
// is the joint having come apart - the soft point constraint holds them to a
// couple of millimetres under the ball's whole weight, so a centimetre is the
// solver having let go, not its softness.
export function checkRootBends(frame: number, world: World): Violation[] {
  const out: Violation[] = [];
  for (const unit of world.ties.units) {
    if (!(unit instanceof RootBendUnit)) continue;
    unit.hinges.forEach((h, j) => {
      if (h.over > ROOT_HINGE_OPEN_LIMIT) {
        out.push({
          frame,
          kind: "root-hinge-open",
          detail: `hinge ${j} (body#${h.a.buildIndex}-body#${h.b.buildIndex}) ${(h.over * 1000).toFixed(1)}mm apart`,
        });
      }
    });
  }
  return out;
}

const ROOT_HINGE_OPEN_LIMIT = 0.01;

// The same three questions of the tied chains (`engine/ties.ts`), per
// segment: a segment over `SCENE_CHAIN_OVER_LIMIT` at the end of a frame, a
// body on an awake chain turning faster than a solve can see, and a chain
// asleep with a segment stretched past the bar - which for an island, where
// nothing can sleep one body at a time, would be the solver having let go.
export function checkTieChains(frame: number, ties: readonly TieChain[]): Violation[] {
  const out: Violation[] = [];
  if (ties.length === 0) return out;
  const spinning = new Set<RigidBody2D>();
  for (let i = 0; i < ties.length; i++) {
    const chain = ties[i]!;
    for (let j = 0; j < chain.segments.length; j++) {
      const s = chain.segments[j]!;
      if (s.over <= SCENE_CHAIN_OVER_LIMIT) continue;
      out.push({
        frame,
        kind: chain.asleep ? "chain-asleep-stretched" : "chain-over-length",
        detail:
          `tie#${i} segment ${j} (body#${s.a.body.buildIndex}-body#${s.b.body.buildIndex}) ` +
          `${(s.over * 1000).toFixed(0)}mm over its length` +
          (chain.asleep ? " while asleep" : ""),
      });
    }
    if (chain.asleep) continue;
    for (const body of chain.bodies) {
      if (spinning.has(body)) continue;
      if (Math.abs(body.angularVelocity) > CHAIN_SPIN_LIMIT) {
        spinning.add(body);
        out.push({
          frame,
          kind: "chain-body-spin",
          detail:
            `body#${body.buildIndex} on tie#${i} turning at ${body.angularVelocity.toFixed(0)} rad/s ` +
            `(${(Math.abs(body.angularVelocity) / 60 / (2 * Math.PI)).toFixed(2)} turns a frame)`,
        });
      }
    }
  }
  return out;
}

export function checkSleepers(frame: number, world: World): Violation[] {
  const out: Violation[] = [];
  for (const body of world.bodies) {
    if (!(body instanceof RigidBody2D) || body.removed || !body.asleep) continue;
    const speed = body.linearVelocity.length();
    const spin = Math.abs(body.angularVelocity);
    if (speed > ASLEEP_SPEED_LIMIT || spin > ASLEEP_SPIN_LIMIT) {
      out.push({
        frame,
        kind: "asleep-moving",
        detail: `body#${body.buildIndex} asleep at ${speed.toFixed(1)} m/s, ${spin.toFixed(1)} rad/s`,
      });
    }
  }
  return out;
}
