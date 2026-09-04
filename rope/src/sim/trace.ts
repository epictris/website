// Deterministic-replay primitives. Because the ported sim is self-consistent,
// a full session is captured by its per-frame input trace alone: replaying the
// same inputs from the same level reproduces it exactly. Digests let a replay
// assert bit-for-bit reproduction; invariants catch physical nonsense.

import { Vec2 } from "../engine/vec2";
import {
  CharacterBody2D,
  RigidBody2D,
  StaticBody2D,
  type PhysicsBody2D,
} from "../engine/body";
import { bodyOverlapCircle, shapeRadius } from "../engine/collision";
import { Hook } from "../classes/hook";
import { BallHook } from "../classes/ballHook";
import { LedgeClimbState } from "../classes/states/ledgeClimbState";
import { LedgeHangState } from "../classes/states/ledgeHangState";
import { OnWallState } from "../classes/states/onWallState";
import { WallJumpingState } from "../classes/states/wallJumpingState";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import type { Rope } from "../classes/rope";
import type { ContactConstraint, World } from "../engine/world";
import type { Level } from "../level/level";
import type { BallLevel } from "../level/ballLevel";
import type { RawLevelData } from "../level/levelFormat";

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
  frames: SerializedFrame[];
  digests?: Digest[];
  // The whole scene, not just the avatar (see WorldDigest). Optional and at the
  // same cadence as `digests`: bundles recorded before it existed replay exactly
  // as they always did, and new ones are compared on every body.
  worldDigests?: WorldDigest[];
  git?: string;
  // Self-contained bundles (e.g. exported from the level editor, whose level
  // isn't in the registry) embed their geometry + controller here. When
  // present, replay builds from `data` instead of looking `level` up.
  controller?: "grapple" | "ball";
  data?: RawLevelData;
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
  // m/s the chain phase handed the ball out of a surface it pushed it out of
  // (`BallLevel.chainPushOutCredit`). Re-earned every frame is the pump.
  pushCredit?: number;
  // Build index of the body the chain's far end sits on, or null while the end
  // is still the hook in flight. A two-body interaction diagnosed from one
  // body's digest is how the first divergence was attributed to the wrong body
  // on 2026-09-04; this is the pointer at the other one.
  anchorBody?: number | null;
}

export interface WorldDigest {
  frame: number;
  bodies: BodyDigest[];
  chain: ChainDigest | null;
}

// What the level driver decided about its chain this frame. Passed in rather
// than read off the rope, because it is the DRIVER's: the aim's spin, the
// unwind's refund, the winch's budget and the push-out credit are all
// `BallLevel` state, and the rope itself has never heard of any of them. Null
// for a driver with no chain phase — the grapple avatar's rope, which is
// steered by nothing and whose caller measures no push-out.
interface ChainPhaseState {
  aimSpin: number;
  unwindRefund: number;
  winchBudget: number;
  pushCredit: number;
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
          pushCredit: phase?.pushCredit ?? 0,
          anchorBody: anchorBodyOf(rope),
        }
      : null,
  };
}

// The build index of the body the rope's far end sits on, or null while that end
// is a hook still in flight — which is not a body in the scene the digest
// describes, and reading its index would name a body nobody anchored to.
function anchorBodyOf(rope: Rope): number | null {
  const obj = rope.end.contact.obj;
  if (obj instanceof Hook || obj instanceof BallHook) return null;
  return obj.buildIndex;
}

export function worldDigest(level: Level): WorldDigest {
  return worldDigestOf(level.frame, level.world, level.player.rope, null);
}

export function worldDigestBall(level: BallLevel): WorldDigest {
  return worldDigestOf(level.frame, level.world, level.ball.chain, {
    aimSpin: level.aimSpin,
    unwindRefund: level.chainUnwindRefund,
    winchBudget: level.chainWinchSpeedBudget,
    pushCredit: level.chainPushOutCredit,
  });
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
const BODY_FIELDS = ["px", "py", "rot", "vx", "vy", "w", "contactPn"] as const;
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
  "pushCredit",
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
export function inputDeserializer(): (f: SerializedFrame) => FrameInput {
  let prev: FrameInput = emptyFrameInput();
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

export function digest(level: Level): Digest {
  const p = level.player;
  return {
    frame: level.frame,
    px: p.globalPosition.x,
    py: p.globalPosition.y,
    rot: p.globalRotation,
    vx: p.velocity.x,
    vy: p.velocity.y,
    ropeLen: p.rope ? p.rope.getCurrentLength() : null,
    maxRope: p.rope ? p.rope.maxRopeLength : null,
    state: p.state.constructor.name,
  };
}

// Ball & chain variant of digest() — same shape so recordings stay uniform.
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
    state: b.chainAnchored ? "BallAnchored" : b.chain ? "BallFiring" : "Ball",
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

// Slack above numerical/geometry noise for the anchor-kick check. Legit anchors
// brake (negative gain); a point-blank shot into a wall the ball is already
// hitting nudges it a few tenths of m/s as it depenetrates. The tip-anchor bug
// injects ~1.9 m/s — well clear of both.
const ANCHOR_KICK_TOLERANCE = 0.6;
// Ceiling on the speed the chain's length solve may add to the ball in a single
// frame. The solve removes over-length by moving bodies and then converts that
// displacement to velocity (Δposition/Δt), so a discontinuous jump in the path
// length becomes a discontinuous jump in speed — a launch. Across the whole ball
// corpus real play peaks at 2.1 m/s of gain in a frame, while the session-1474f
// launch was +7.7 m/s (and +93.7 m/s in the recording), so 4 leaves ~2x headroom
// over anything legitimate and still catches the bug by a wide margin.
// `runaway-speed` never saw it: 96 m/s is far under that 1000 m/s ceiling.
const CHAIN_SOLVE_KICK_TOLERANCE = 4;
// Ceiling on applied tangential impulse beyond the kinematic spin's traction
// budget (`World.spinDriveOverspend`, N·s). The budget arithmetic is exact -
// the solver clamps to the same expression - so this is noise slack only: on
// the ball's 52 kg, 1 N·s is 0.02 m/s. The wall launch it exists for overspent
// by 193 N·s (`session-773f` f600).
const SPIN_OVERDRIVE_TOLERANCE = 1;
// Ceiling on how much inward speed the chain phase may hand the ball beyond what
// its own constraint was opening at (`BallLevel.chainCreditOverBound`).
//
// This is the sharp form of the same idea `rope-solve-kick` states bluntly. That
// one is a bar on the SIZE of a one-frame gain, so it has to sit clear of every
// legitimate one - a chain going taut on a fast swing brakes several m/s in a
// frame - and `session-360f` slipped under it at 2.1 against a bar of 4. A
// constraint may only remove the motion opening it, so measured against that
// entitlement the same frame reads 2.17 m/s of speed the chain was never owed,
// and a legitimate brake reads zero however large it is.
//
// The tolerance is for the phase's other writes, which are real and are not the
// length solve: the spin rollback, the unwind, and the into-surface refusal that
// hands gravity's own step back. Measured over the whole ball corpus, exactly one
// frame reaches over the bound at all - session-1426f f714, at 0.21 m/s - so 0.6
// clears the top of that by nearly threefold while still catching session-360f's
// 2.17 by more than three.
const CHAIN_CREDIT_BOUND_TOLERANCE = 0.6;
// How many consecutive frames the chain phase may hand the ball speed OUT of a
// surface it pushed the ball out of (`BallLevel.chainPushCreditFrames`, counted
// above `BallLevel.PUSH_CREDIT_SPEED`) before it is a pump.
//
// A push-out is the answer to a haul the geometry refused, and against static
// geometry it can never leave the ball further out than it began. Against a
// rigid body it could: hauled by the ball's own chain, the body moved INTO the
// ball, and a push-out that then moved the ball alone credited the ball for the
// body's share of the motion while the body kept its own credit for it - the
// pair leaving together, 0.3 to 2.3 m/s a frame, until a ball and its 12.6 kg
// anchor were doing 19 m/s (`session-324f` f252-270). The chain phase now
// clears that overlap as a pair (`BallLevel.separateBallFromPathBodies`), and
// this is the statement that it stays cleared.
//
// A bar on the SIZE would not do: the unwind turning the ball's mounting loop
// into the scenery is cleared and credited in one frame at up to 2.2 m/s across
// the corpus (`session-234f` f79), and the pump's per-frame credit sat under
// that. What distinguishes a pump is that it is re-earned for as long as its
// cause lasts - 18 consecutive frames on `session-324f`, 11 on `session-307f`
// - where the corpus never strings more than 2 together. Six is the bar.
const CHAIN_PUSH_CREDIT_FRAMES = 6;
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
const CHAIN_OVER_LENGTH_TOLERANCE = 0.25;
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
// Consecutive frames the winch stall may keep letting length out. This is the
// sharp measure, because a *run* of stalls is the shape of every chain runaway
// there has been, and one blocked frame is not. The runaways ran 79, 51, 36, 32
// and 28.
//
// The legitimate ceiling was 11 frames when this was written and is 46 now
// (session-431f), and that is not drift - it is scenery having been given
// friction against the ground it stands on. A stall is the chain being held over
// its length by geometry, so how long one lasts is how long that geometry takes
// to stop holding, and a frictionless rigid body relieved every block for free
// by sliding out from under it. The blocks were short because the level was made
// of ice. A chain anchored to a crate that stays put is now legitimately blocked
// until the *ball* settles, which is tens of frames: 431f's runs 46, over which
// `maxRopeLength` does not move at all and the lease is paid back to exactly
// zero by f420.
//
// The count is correspondingly blunter, and `rope-grew` is what still holds the
// gap: the one genuine chain runaway this change surfaced (session-1195f, a
// point-blank anchor on a body the ball had wedged itself against, whose lease
// climbed to 1.47 m on a 2.9 cm chain) tripped `rope-grew` twenty frames before
// its stall run would have said anything, because a runaway is measured in
// metres of chain and only incidentally in frames.
const CHAIN_STALL_FRAMES_TOLERANCE = 60;
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

// ---- input-frozen detector -------------------------------------------------
// Flags the "player holds a direction but barely moves" class of bug: with a
// mobile body nearby, holding a direction for a sustained window must produce
// real displacement along it. Pressing into a static wall is exempt (no
// mobile body involved). Frames in deliberate-stationary states (ledge hang /
// climb, wall-jump startup, wall slide — attach requires toward-input, so
// pressing into the wall there is deliberate) or with an active rope are
// exempt — but a state merely *thrashing* through Airborne must not reset the
// window, so the streak counts every non-exempt input-held frame regardless
// of state.

const STUCK_WINDOW = 45; // frames of continuous same-direction input
const STUCK_MIN_DISPLACEMENT = 0.25; // m along the input direction over the window
const STUCK_MOBILE_DIST = 0.48; // m — a mobile body this close implicates movers
// Yield exemption (wedge rules: movers push, never freeze): a player being
// displaced backward by a mover is moving, not frozen — the treadmill bug
// class this detector exists for pins the player near zero displacement.
// Two signatures qualify: shoved backward over the whole window, or a
// sustained backward drift in the window's tail (the push phase of a window
// that straddles earlier real progress).
const STUCK_PUSHED_BACK_EXEMPT = 0.1; // m against the input over the window
const STUCK_YIELD_TAIL = 15; // frames — tail length checked for backward drift
const STUCK_YIELD_DISPLACEMENT = 0.03; // m backward over the tail counts as yielding

function mobileBodyNear(level: Level): boolean {
  const p = level.player;
  for (const body of level.world.bodies) {
    if (body === p || body.removed || !body.isMobile || !body.hasShape()) continue;
    if (body instanceof Hook) continue;
    const s = body.primaryShape().shape;
    // The rect form is spelled out rather than routed through `shapeRadius` so
    // the expression stays literally what every recorded run was checked with.
    const bound =
      s.kind === "circle"
        ? s.radius
        : s.kind === "rect"
          ? Math.hypot(s.size.x, s.size.y) * 0.5
          : shapeRadius(s);
    if (body.globalPosition.distanceTo(p.globalPosition) <= bound + STUCK_MOBILE_DIST) return true;
  }
  return false;
}

// A ledge climb is a short scripted traversal (~a second at most); staying in
// LedgeClimbState longer means the climb target is unreachable (e.g. wedged in
// a notch between rects) and the player is locked out of all input.
const CLIMB_STALL_FRAMES = 90;

export class StuckDetector {
  private streak = 0;
  private dir = 0;
  private xs: number[] = [];
  private mobileSeen: boolean[] = [];
  private climbFrames = 0;

  // Call once per frame after level.physicsProcess. Returns a violation when
  // the window criteria trip, then restarts the streak (no per-frame spam).
  push(level: Level, input: FrameInput): Violation | null {
    const p = level.player;

    // Climb-stall check (independent of input — climb ignores input).
    this.climbFrames = p.state instanceof LedgeClimbState ? this.climbFrames + 1 : 0;
    if (this.climbFrames === CLIMB_STALL_FRAMES) {
      return {
        frame: level.frame,
        kind: "climb-stalled",
        detail: `LedgeClimbState for ${CLIMB_STALL_FRAMES}f at (${p.globalPosition.x.toFixed(1)},${p.globalPosition.y.toFixed(1)})`,
      };
    }

    const dir = (input.moveRight.held ? 1 : 0) - (input.moveLeft.held ? 1 : 0);
    const exempt =
      p.rope !== null ||
      p.state instanceof LedgeHangState ||
      p.state instanceof LedgeClimbState ||
      p.state instanceof WallJumpingState ||
      p.state instanceof OnWallState;

    if (dir === 0 || exempt || dir !== this.dir) {
      this.dir = dir;
      this.streak = 0;
      this.xs.length = 0;
      this.mobileSeen.length = 0;
      if (dir === 0 || exempt) return null;
    }

    this.streak++;
    this.xs.push(p.globalPosition.x);
    this.mobileSeen.push(mobileBodyNear(level));
    if (this.streak < STUCK_WINDOW) return null;

    const dx = (this.xs[this.xs.length - 1]! - this.xs[0]!) * dir;
    // Peak forward progress within the window, not just endpoint-to-endpoint:
    // a window straddling real progress followed by a mover push-back is
    // movement, not a freeze — the treadmill bug class never advances at all.
    const dxMax = Math.max(...this.xs.map((x) => (x - this.xs[0]!) * dir));
    // Backward drift over the window tail — yielding to an active push.
    const tail = this.xs[this.xs.length - 1 - STUCK_YIELD_TAIL];
    const yielding =
      tail !== undefined &&
      (this.xs[this.xs.length - 1]! - tail) * dir < -STUCK_YIELD_DISPLACEMENT;
    const mobileInvolved = this.mobileSeen.some(Boolean);
    this.xs.shift();
    this.mobileSeen.shift();
    if (
      dxMax < STUCK_MIN_DISPLACEMENT &&
      dx > -STUCK_PUSHED_BACK_EXEMPT &&
      !yielding &&
      mobileInvolved
    ) {
      this.streak = 0;
      this.xs.length = 0;
      this.mobileSeen.length = 0;
      return {
        frame: level.frame,
        kind: "input-frozen",
        detail: `held ${dir > 0 ? "right" : "left"} ${STUCK_WINDOW}f, moved ${dx.toFixed(1)}px (state=${p.state.constructor.name})`,
      };
    }
    return null;
  }
}

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
// the one other thing entitled to move it, and `BallLevel.chainCreditVelocity`
// is what that phase paid. Whatever is left is a body being driven along a
// surface by nothing at all - which is the shape of every friction motor this
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
        .sub(level.chainCreditVelocity)
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
    const steering =
      level.ball.kinematicRotation &&
      (Math.abs(level.ball.angularVelocity) > STEERING_SPIN ||
        Math.abs(level.aimSpin) > STEERING_SPIN);
    // A trampoline pays out of a spring nothing in the scene stores, so a frame
    // one fired is a frame energy legitimately entered the level - the same
    // statement `FORCED_ACTIONS` makes about the winch, and made by the sim
    // itself rather than by the input, because a pad fires on contact and no
    // button is pressed for it (see `World.launchedThisFrame`).
    const launched = level.world.launchedThisFrame;
    const bodies = level.world.bodies.filter((b) => !b.removed).length;
    if (anyForcedInput(input) || steering || launched || bodies !== this.bodyCount) {
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
export function checkBallInvariants(level: BallLevel): Violation[] {
  const out: Violation[] = [];
  const b = level.ball;
  const frame = level.frame;

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
  // A chain going taut against a fixed anchor can only brake the ball, never
  // accelerate it. A positive solver speed-gain on the anchoring frame means
  // the anchor was born over its max length and the solve dumped the excess
  // into the ball as a one-frame velocity kick (the tip-anchor lurch).
  //
  // Except by the winch, and for exactly the reason `rope-solve-kick` below
  // subtracts the same budget: a ball spinning as its hook lands is winding
  // chain onto its own rim, the free span shortens by |omega| x the spool rate,
  // and hauling the ball towards its anchor is what pays for that. It is the
  // mechanic, not a lurch, and it is not rare on an anchoring frame - the shot
  // leaves through the loop, so the ball is usually still turning when the hook
  // lands. Charged to the bare bar it read as the bug at 1.1 m/s out of a 2.7
  // m/s entitlement, on frames whose over-length was 100% the winding's
  // (`session-234f` f84, `session-576f` f61).
  const anchorKick = (level.anchorKickSpeedGain ?? 0) - level.chainWinchSpeedBudget;
  if (level.anchorKickSpeedGain !== null && anchorKick > ANCHOR_KICK_TOLERANCE) {
    out.push({
      frame,
      kind: "rope-anchor-kick",
      detail:
        `solve added ${level.anchorKickSpeedGain.toFixed(1)} m/s as the chain anchored, ` +
        `${anchorKick.toFixed(1)} of it beyond what winding paid for`,
    });
  }
  // Measured against what the frame's own winding entitles the solve to. Winding
  // chain onto the ball shortens the free span by |omega| x the spool rate, and
  // the winch pays for that by hauling the ball in - so at 41 rad/s on the ball's
  // own rim the chain legitimately reels in 9 cm in a frame, which is 5.5 m/s and
  // nothing to do with a launch. Charging that to the same 4 m/s bar as a
  // phantom one reports the mechanic working (`session-265f` f139, where the
  // whole 4.5 m/s gain is covered by the winding that frame).
  //
  // A launch has no winding behind it - `session-1474f`'s 96 m/s came from a wrap
  // path jumping half a metre with the ball barely turning - so subtracting the
  // budget leaves that case exactly as visible as it was.
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
  const kick = (level.chainSolveSpeedGain ?? 0) - level.chainWinchSpeedBudget;
  if (level.chainSolveSpeedGain !== null && kick > CHAIN_SOLVE_KICK_TOLERANCE) {
    out.push({
      frame,
      kind: "rope-solve-kick",
      detail:
        `chain solve added ${level.chainSolveSpeedGain.toFixed(1)} m/s in one frame, ` +
        `${kick.toFixed(1)} of it beyond what winding paid for`,
    });
  }
  if (
    level.chainCreditOverBound !== null &&
    level.chainCreditOverBound > CHAIN_CREDIT_BOUND_TOLERANCE
  ) {
    out.push({
      frame,
      kind: "rope-credit-unearned",
      detail:
        `chain phase took ${level.chainCreditOverBound.toFixed(2)} m/s more along its own pull ` +
        `than the constraint was opening at`,
    });
  }
  if (level.chainPushCreditFrames > CHAIN_PUSH_CREDIT_FRAMES) {
    out.push({
      frame,
      kind: "rope-push-credit",
      detail:
        `chain phase has handed the ball speed out of a surface it pushed the ball out of ` +
        `for ${level.chainPushCreditFrames} frames running (${level.chainPushOutCredit.toFixed(2)} m/s this frame)`,
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
    if (level.chainStallFrames > CHAIN_STALL_FRAMES_TOLERANCE) {
      out.push({
        frame,
        kind: "rope-stalling",
        detail: `winch stall has let chain out for ${level.chainStallFrames} frames running`,
      });
    }
    // Chain-clip: no span's interior may run deep inside static geometry. A span
    // legitimately touches corners it wraps (endpoints on the surface), so
    // sample interior points and flag only genuine penetration past tolerance.
    const nodes = b.chain.path().map((n) => n.contact.globalPosition);
    const statics = level.world.bodies.filter(
      (body): body is StaticBody2D => body instanceof StaticBody2D && body.hasShape(),
    );
    let clip: { depth: number; name: string } | null = null;
    for (let s = 0; s < nodes.length - 1 && !clip; s++) {
      const a = nodes[s]!;
      const d = nodes[s + 1]!.sub(a);
      for (let k = 1; k < CHAIN_CLIP_SAMPLES && !clip; k++) {
        const p = a.add(d.mul(k / CHAIN_CLIP_SAMPLES));
        for (const body of statics) {
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
  }
  for (const body of level.world.bodies) {
    if (!(body instanceof StaticBody2D) || !body.hasShape()) continue;
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
  // solid circle the world may not swallow. An attached hook is removed from
  // the world, so an anchor legitimately ON a surface never reports here.
  for (const hook of level.world.bodies) {
    if (!(hook instanceof BallHook) || !hook.hasShape()) continue;
    const hs = hook.primaryShape().shape;
    if (hs.kind !== "circle") continue;
    for (const body of level.world.bodies) {
      if (!(body instanceof StaticBody2D) || !body.hasShape()) continue;
      const ov = bodyOverlapCircle(body, hook.globalPosition, hs.radius);
      if (ov && ov.depth > HOOK_EMBED_TOLERANCE) {
        out.push({
          frame,
          kind: "hook-embedded",
          detail: `depth=${(ov.depth * 1000).toFixed(1)}mm in ${body.name || "static"}`,
        });
        break;
      }
    }
  }
  return out;
}

// Per-frame sanity checks (ported in spirit from snapshot/InvariantChecker.cs).
export function checkInvariants(level: Level): Violation[] {
  const out: Violation[] = [];
  const p = level.player;
  const frame = level.frame;

  if (!p.globalPosition.isFinite() || !p.velocity.isFinite()) {
    out.push({ frame, kind: "nan", detail: `pos=${p.globalPosition} vel=${p.velocity}` });
    return out; // further checks meaningless
  }
  if (p.velocity.length() > RUNAWAY_SPEED) {
    out.push({ frame, kind: "runaway-speed", detail: `|vel|=${p.velocity.length().toFixed(1)}` });
  }
  if (p.rope) {
    const len = p.rope.getCurrentLength();
    // While the hook is still an unanchored projectile, maxRopeLength is reset to
    // the path length every frame and the hook moves after the rope step, so the
    // length legitimately exceeds it — only meaningful once the rope is anchored.
    const anchored = !(p.rope.end.contact.obj instanceof Hook);
    if (anchored && len > p.rope.constraintLength + 0.05) {
      out.push({
        frame,
        kind: "rope-over-length",
        detail: `len=${len.toFixed(1)} > max=${p.rope.constraintLength.toFixed(1)}`,
      });
    }
    if (Number.isNaN(len)) out.push({ frame, kind: "rope-nan", detail: "rope length NaN" });
  }
  const shape = p.primaryShape().shape;
  if (shape.kind === "circle") {
    for (const body of level.world.bodies) {
      if (!(body instanceof StaticBody2D) || !body.hasShape()) continue;
      const ov = bodyOverlapCircle(body, p.globalPosition, shape.radius);
      if (ov && ov.depth > EMBED_TOLERANCE) {
        out.push({
          frame,
          kind: "player-embedded",
          detail: `depth=${ov.depth.toFixed(2)} in ${body.name || "static"}`,
        });
        break;
      }
    }
  }
  return out;
}
