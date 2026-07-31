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
import { LedgeClimbState } from "../classes/states/ledgeClimbState";
import { LedgeHangState } from "../classes/states/ledgeHangState";
import { OnWallState } from "../classes/states/onWallState";
import { WallJumpingState } from "../classes/states/wallJumpingState";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import type { Rope } from "../classes/rope";
import type { World } from "../engine/world";
import type { Level } from "../level/level";
import type { BallLevel } from "../level/ballLevel";
import type { LevelData } from "../level/levelFormat";

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
  data?: LevelData;
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
}

export interface ChainDigest {
  nodes: number;
  pathLen: number;
  maxRope: number;
  blockedSlack: number;
}

export interface WorldDigest {
  frame: number;
  bodies: BodyDigest[];
  chain: ChainDigest | null;
}

function worldDigestOf(frame: number, world: World, rope: Rope | null): WorldDigest {
  const bodies: BodyDigest[] = [];
  for (const body of world.bodies) {
    if (body.removed) continue;
    if (body instanceof RigidBody2D) {
      bodies.push({
        id: body.buildIndex,
        px: body.globalPosition.x,
        py: body.globalPosition.y,
        rot: body.globalRotation,
        vx: body.linearVelocity.x,
        vy: body.linearVelocity.y,
        w: body.angularVelocity,
      });
    } else if (body instanceof CharacterBody2D) {
      bodies.push({
        id: body.buildIndex,
        px: body.globalPosition.x,
        py: body.globalPosition.y,
        rot: body.globalRotation,
        vx: body.velocity.x,
        vy: body.velocity.y,
        w: 0,
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
        }
      : null,
  };
}

export function worldDigest(level: Level): WorldDigest {
  return worldDigestOf(level.frame, level.world, level.player.rope);
}

export function worldDigestBall(level: BallLevel): WorldDigest {
  return worldDigestOf(level.frame, level.world, level.ball.chain);
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

export function worldDigestsEqual(a: WorldDigest, b: WorldDigest): boolean {
  if (a.bodies.length !== b.bodies.length) return false;
  for (let i = 0; i < a.bodies.length; i++) {
    const x = a.bodies[i]!;
    const y = b.bodies[i]!;
    if (
      x.id !== y.id ||
      x.px !== y.px ||
      x.py !== y.py ||
      x.rot !== y.rot ||
      x.vx !== y.vx ||
      x.vy !== y.vy ||
      x.w !== y.w
    ) {
      return false;
    }
  }
  if ((a.chain === null) !== (b.chain === null)) return false;
  if (a.chain && b.chain) {
    if (
      a.chain.nodes !== b.chain.nodes ||
      a.chain.pathLen !== b.chain.pathLen ||
      a.chain.maxRope !== b.chain.maxRope ||
      a.chain.blockedSlack !== b.chain.blockedSlack
    ) {
      return false;
    }
  }
  return true;
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
    total += body.mass * 9.8 * body.gravityScale * -body.globalPosition.y;
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
    const steering =
      level.ball.kinematicRotation && Math.abs(level.ball.angularVelocity) > STEERING_SPIN;
    const bodies = level.world.bodies.filter((b) => !b.removed).length;
    if (anyForcedInput(input) || steering || bodies !== this.bodyCount) {
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
  if (level.anchorKickSpeedGain !== null && level.anchorKickSpeedGain > ANCHOR_KICK_TOLERANCE) {
    out.push({
      frame,
      kind: "rope-anchor-kick",
      detail: `solve added ${level.anchorKickSpeedGain.toFixed(1)} px/s as the chain anchored`,
    });
  }
  if (
    level.chainSolveSpeedGain !== null &&
    level.chainSolveSpeedGain > CHAIN_SOLVE_KICK_TOLERANCE
  ) {
    out.push({
      frame,
      kind: "rope-solve-kick",
      detail: `chain solve added ${level.chainSolveSpeedGain.toFixed(1)} m/s in one frame`,
    });
  }
  if (b.chain) {
    const len = b.chain.getCurrentLength();
    if (b.chainAnchored && len > b.chain.constraintLength + 0.05) {
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
