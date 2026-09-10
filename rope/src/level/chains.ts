// Scene chains - a chain strung between two authored bodies, solved by the same
// wrap-point rope the grapple and the ball & chain hang on.
//
// There is deliberately no new physics here. `Rope` already models a rope as a
// sequence of wrap points between two `RopeContact`s on arbitrary bodies, moves
// whatever dynamic bodies lie on its path and leaves statics alone as infinite
// mass, so a scene chain is that class with both ends pinned at load instead of
// one end being a hook in flight. A rigid body on either end therefore hangs,
// swings and is hauled by the chain; a static or an `anchor` simply holds it.
//
// What a chain is NOT is collision geometry: nothing stands on it, and another
// rope does not wrap it. It is a constraint between two bodies plus the drawing
// of that constraint. (Both would need the chain to be a body per link - see
// docs/game-design.md.)
//
// A chain is scenery in what it is drawn behind and in what may touch IT, and
// it is level geometry in what it bends around: its spans are solved against the
// level's wrappable bodies - the statics and the authored rigid bodies, the same
// scene the ball's chain scans (`BuiltBodies.wrapBodies`) - so a chain that
// swings across a post catches on the post's corner and hangs its load from
// there, exactly as the ball's chain would. What it is solved against is NOT
// the avatar or its hook: those are in the play space and a chain is not, so
// nothing the player does can snag on a chain. (There was briefly a
// "foreground" kind the whole scene, avatar included, was solved against, and
// it was dropped for that reason; and for a while after it a chain was solved
// against nothing at all but the bodies its wrap points named, which read as
// the chain being drawn through a pillar it plainly ran into - `session-497f`,
// a weight hung beside a post on a chain over a pulley, the chain cutting
// straight through the post's top as the weight fell past it.)
//
// A wrap point (`ChainData.via`) is the authored route: an anchor the chain is
// routed OVER, which at load becomes an ordinary wrap node on the corner of the
// piece it sits on. From then on it is the same wrap the ball's chain finds by
// scanning - regenerated as the bodies move, culled if the chain ever pulls
// straight past it - which is what a chain over a beam or a pulley does. The
// authoring exists because the scan cannot find it: a chain hung from a hub up
// over a beam and down to a load is, as a straight line, nowhere near the beam.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import {
  PhysicsBody2D,
  RigidBody2D,
  StaticBody2D,
  type CollisionObject2D,
  type CollisionShape2D,
} from "../engine/body";
import { nearestShapeIndex, nearestSurfacePoint } from "../engine/shapes";
import { GRAVITY, isRealPush, type PushOut, type World } from "../engine/world";
import { Rope, type LengthRefusal } from "../classes/rope";
import { RopeContact, RopeWrap } from "../lib/ropeContact";
import { Segment } from "../lib/segment";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { Intersections } from "../lib/intersections";
import { RopeGeneration } from "../lib/ropeGeneration";
import { Calc } from "../lib/calc";
import { GenerationDirection, IntersectionStatus, WrapDirection } from "../lib/types";
import { PhaseTrace } from "../engine/phaseTrace";
import { localPlacement, worldPlacement, type BuiltBodies } from "./buildBodies";
import {
  isAnchorObject,
  type AnchorObjectData,
  type ChainData,
  type LevelData,
} from "./levelFormat";

// The wrap-candidate list for a constraint that bends around nothing: a vine's
// pair chain, or a `SceneChain` built by hand with no scene to give it. A rope's
// two anchor bodies are already the ends of every span, and
// `Rope.regeneratePath` never wraps a span around the bodies that span starts
// and finishes on, so an empty scene is exactly "hangs between its two bodies
// and touches nothing else". An AUTHORED chain is not built with this: see
// `buildSceneChains`.
export const NOTHING: PhysicsBody2D[] = [];

// A body the chain phase pushed out of static geometry this frame, and the
// push-outs that did it (real ones only - see `isRealPush`). What `settle`
// hands each constraint, so a chain can measure how much of its over-length
// those surfaces actually refuse.
export interface BodyPush {
  readonly body: RigidBody2D;
  readonly pushedOutOf: readonly PushOut[];
}

// What the chain phase actually needs of a thing it solves: open a frame, take
// a pass, say how far it still is from being satisfied, and name the bodies it
// moves so the phase can depenetrate them and pay them the velocity it moved
// them by.
//
// It is an interface rather than "the phase solves chains" because a vine's
// STIFFNESS is not a chain (see `level/vineBend.ts`) and cannot be made into
// one: it is a three-point curvature constraint with a compliance, and there is
// no length for `Rope` to hold. But it has to be swept in the SAME loop as the
// pair chains it argues with - a bend correction that straightens the vine
// pulls two links off their spacing, and a pair solve that fixes the spacing
// bends the vine back - which is the same statement this loop already makes
// about two chains sharing a body, one order further out.
//
// Everything else in the phase - the alternating sweep, the residual gate, the
// static depenetration with its funded velocity clamp, the credit scaling - is
// written against this interface and so is unchanged by what implements it.
export interface SceneConstraint {
  // Once a frame, however many passes follow.
  beginFrame(delta: number): void;
  // One pass.
  solve(delta: number): void;
  // Metres of error left after the last pass - what the sweep's exit gate
  // bounds. Zero for a constraint that is satisfied, whatever satisfying it
  // means for that kind (a rope is satisfied slack; a compliant bend is
  // satisfied bent).
  readonly residual: number;
  // The residual this constraint may END a frame at - the bar the sweep's exit
  // gate holds it to. `CHAIN_TOLERANCE` for everything that must not visibly
  // stretch; a vine joint's is looser (`VINE_TOLERANCE`), a little stretch
  // under load being an accepted part of what a vine is - and the difference
  // is most of the sweeps a swinging vine used to cost (see `sweepOneSet`).
  readonly tolerance: number;
  // Every DYNAMIC body this constraint is attached to as it currently stands.
  eachBody(fn: (body: RigidBody2D) => void): void;
  // Whether it is one of them, for the credit scaling below.
  holds(body: RigidBody2D): boolean;
  // The share of this frame's displacement a body it holds may be paid velocity
  // for (see `Rope.topologyCreditScale`). 1 for a constraint whose corrections
  // are all honest motion.
  readonly creditScale: number;
  // The geometry has just refused these bodies their share of the phase's
  // correction (they were pushed back out of it): take that share off the
  // bodies it can still go to, with these held immovable. For a rope that is
  // the winch's own mechanism (`Rope.solveLengthHolding`); a constraint with
  // no length to re-solve does nothing.
  resolveHolding(held: ReadonlySet<RigidBody2D>): void;
  // End of the phase, with every body of this constraint that had to be pushed
  // out of the scenery and what pushed it. Empty when nothing was. May be
  // called more than once a frame (`BallLevel` settles the scene set twice, once
  // on its own and once after the coupled sweep), and what it records about the
  // frame accumulates across the calls.
  settle(pushes: readonly BodyPush[]): void;
}

// How far outside a sleeping chain's box a moving wrap body has to be before
// its motion is none of the chain's business (see `SceneChain.watchedMoved`).
// A quarter of a metre: the fastest thing in a level is the hook at 12 m/s,
// 0.2 m a frame, so a body that could cross the chain's span before the next
// look is inside this by the time it is looked at. Waking early costs a solve;
// waking late is the ball passing through a chain it should have bent.
const WAKE_REACH = 0.25;

export class SceneChain implements SceneConstraint {
  readonly rope: Rope;
  // Authored fill for the links; null = the renderer's own chain colours.
  readonly color: string | null;
  // What this chain's spans may bend around: the level's wrappable bodies for
  // an authored chain (see `buildSceneChains`), a vine's for its load-bearing
  // span (`level/vines.ts`), `NOTHING` for a constraint built with no scene.
  // The scan is broadphased (`World.segmentCandidates`), so handing a chain the
  // whole level costs a tree walk per span rather than a segment test per
  // shape.
  readonly wrapBodies: PhysicsBody2D[];

  // Every body whose transform is an input to this chain's solve: the two end
  // bodies, then anything a span may wrap. Fixed at construction - the rope's
  // ends never re-anchor, and the wrap list is the one it was built with.
  private readonly watchBodies: readonly CollisionObject2D[];

  // Asleep: out of the frame's chain set entirely - not swept, not settled,
  // not re-solved by the coupled sweep. A chain sleeps when every rigid body on
  // its path is asleep (`sleepChains`, at the end of the frame, after
  // `World.settleSleep` has let the bodies decide), and wakes when any of them
  // wakes or when anything it is watching - an anchor on a mover, a wrap body -
  // has moved since (`wakeChains`, at the top of the frame). A chain with no
  // rigid body on it sleeps at once: nothing it could correct can move.
  //
  // The lantern was the case: hanging still, it fell 2.7 mm a frame and was
  // lifted back, so its chain was solved every frame, and again in the coupled
  // sweep whenever the ball was on anything - 12 of the 15 path regenerations
  // a frame on `session-392f`, for six chains nobody was touching.
  asleep = false;
  private readonly sleptAtVersion: number[];
  // `watchBodies`' transform versions as of the last real solve.
  private readonly solvedAtVersion: number[];
  // Whether that solve moved nothing: no watched body's version changed across
  // it. Together with unchanged versions since, it proves the next solve would
  // be the identity - same inputs, and the last run of them was a fixed point -
  // so `solve` may skip the pass outright with every observable (positions,
  // `residual`) exactly as a real pass would leave it. The Gauss-Seidel sweep
  // keeps re-solving a whole component until its WORST constraint converges,
  // and this is what stops the converged chains in it paying a full rope solve
  // per sweep for the privilege of doing nothing.
  private lastSolveWasIdentity = false;
  // Whether any settle THIS frame found geometry refusing this chain a shorter
  // path. Accumulated rather than overwritten because the ball level settles
  // the set twice a frame - once on its own, once after the coupled sweep -
  // and the second settle, finding nothing left to push, said "not blocked"
  // over the first's answer, so a lease against a live block was released
  // while the ball was hooked and re-earned while it was not: a weight on a
  // wedged plank's chain crept up the chain while the ball hung from the post
  // and back down when it let go (`session-527f`).
  private blockedThisFrame = false;

  // `length` null = the path length as built, through `wraps` - "taut as
  // authored" for a chain routed over its wrap points as much as for one
  // strung straight. `wraps` are the initial wrap nodes (a chain's authored
  // wrap points, see `buildOne`); every body they sit on must be in
  // `wrapBodies`, or the scan that re-resolves them each frame would never
  // re-find a corner the chain slid off.
  constructor(
    a: RopeContact,
    b: RopeContact,
    length: number | null,
    color: string | null,
    wrapBodies: PhysicsBody2D[] = NOTHING,
    wraps: RopeWrap[] = [],
  ) {
    this.rope = new Rope(a, b, wraps, length);
    this.color = color;
    this.wrapBodies = wrapBodies;
    this.watchBodies = [a.obj, b.obj, ...wrapBodies];
    this.solvedAtVersion = this.watchBodies.map(() => -1);
    this.sleptAtVersion = this.watchBodies.map(() => -1);
  }

  // Every rigid body on the path is asleep (vacuously true of a chain between
  // two statics). The rope's own path rather than `watchBodies`: a wrap node
  // the sweep put on a crate is a body the solve moves too.
  private bodiesAllAsleep(): boolean {
    for (const node of this.rope.path()) {
      const body = node.contact.obj;
      if (body instanceof RigidBody2D && !body.asleep) return false;
    }
    return true;
  }

  // Has anything moved that could move THIS chain? Its two ends and any body
  // on its path, by moving at all. Any other watched body - the wrap list is
  // the whole level's wrappable geometry, the ball included, so "any watched
  // body moved" was true on every frame the ball rolled anywhere - only by
  // moving into the chain's reach: the box the sleeping chain lies in, grown
  // by `WAKE_REACH`, against the body's own box. A body that moved somewhere
  // else is forgotten (its version re-marked) so it is one box test, once.
  private watchedMoved(): "no" | "carried" | "reached" {
    const watch = this.watchBodies;
    let reached = false;
    for (let i = 0; i < watch.length; i++) {
      const body = watch[i]!;
      if (body.transformVersion === this.sleptAtVersion[i]) continue;
      if (i < 2 || this.onPath(body)) return "carried";
      if (this.withinReach(body)) reached = true;
      else this.sleptAtVersion[i] = body.transformVersion;
    }
    return reached ? "reached" : "no";
  }

  private onPath(body: CollisionObject2D): boolean {
    for (const node of this.rope.path()) if (node.contact.obj === body) return true;
    return false;
  }

  private withinReach(body: CollisionObject2D): boolean {
    for (const s of body.getShapes()) {
      const c = s.globalPosition;
      const e = s.extents();
      if (
        c.x + e.x >= this.sleptMinX &&
        c.x - e.x <= this.sleptMaxX &&
        c.y + e.y >= this.sleptMinY &&
        c.y - e.y <= this.sleptMaxY
      ) {
        return true;
      }
    }
    return false;
  }

  // The box the chain sleeps in: its path's nodes, grown by `WAKE_REACH`.
  // Taken once, here, because nothing on a sleeping chain moves.
  private sleptMinX = 0;
  private sleptMinY = 0;
  private sleptMaxX = 0;
  private sleptMaxY = 0;

  fallAsleep(): void {
    this.asleep = true;
    const watch = this.watchBodies;
    for (let i = 0; i < watch.length; i++) this.sleptAtVersion[i] = watch[i]!.transformVersion;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.rope.path()) {
      const p = node.contact.globalPosition;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    this.sleptMinX = minX - WAKE_REACH;
    this.sleptMinY = minY - WAKE_REACH;
    this.sleptMaxX = maxX + WAKE_REACH;
    this.sleptMaxY = maxY + WAKE_REACH;
  }

  // Top of the frame. An awake chain wakes any body on it still flagged asleep
  // - the solve is about to move it, so it has to integrate - which is a no-op
  // on a body already awake and so never holds one awake (`RigidBody2D.wake`).
  // A sleeping chain looks for a reason to get up: a body on it that something
  // woke, or a watched body that moved, in which case the chain's bodies are
  // woken with it, since an anchor that moved has moved what hangs from it.
  wakeIfDisturbed(): void {
    if (!this.asleep) {
      this.eachBody((body) => body.wake());
      return;
    }
    if (!this.bodiesAllAsleep()) {
      this.asleep = false;
      this.eachBody((body) => body.wake());
      return;
    }
    const moved = this.watchedMoved();
    if (moved === "carried") {
      this.asleep = false;
      this.eachBody((body) => body.keepAwake());
    } else if (moved === "reached") {
      // Something came near: solve this frame and see. The bodies stay as
      // they are until the solve says it moved one (`sleepIfSettled`), so a
      // ball swinging past a row of hanging lanterns costs each a solve on
      // the frames it is close, not a window of gravity and contacts.
      this.asleep = false;
      this.reachWoken = true;
      this.reachMarks.length = 0;
      this.eachBody((body) => this.reachMarks.push({ body, version: body.transformVersion }));
    }
  }

  private reachWoken = false;
  private readonly reachMarks: { body: RigidBody2D; version: number }[] = [];

  // End of the frame, after `World.settleSleep`: the chain follows its bodies.
  // A reach-woken chain first wakes any body its solve moved - a body moved
  // while flagged asleep has velocity the settle credited it and gravity it
  // has not been given, and has to integrate from here.
  sleepIfSettled(): void {
    if (this.reachWoken) {
      this.reachWoken = false;
      for (const m of this.reachMarks) {
        if (m.body.asleep && m.body.transformVersion !== m.version) m.body.wake();
      }
      this.reachMarks.length = 0;
    }
    if (this.asleep) return;
    if (this.bodiesAllAsleep()) this.fallAsleep();
  }

  // Open this chain's frame. Once per frame, however many solve passes follow.
  beginFrame(delta: number): void {
    this.rope.beginFrame(delta);
    // Open the frame's geometry-push account (see `Rope.noteGeometryPush`) so
    // every lease raise this frame - the one each solve pass makes on its own
    // and the settle's - is bounded by what geometry actually pushed. Left
    // unopened, a pass's own raise is unbounded and a sweep that ends short of
    // convergence leases its whole residual as if a surface had refused it.
    this.rope.noteGeometryPush(0);
    this.blockedThisFrame = false;
  }

  resolveHolding(held: ReadonlySet<RigidBody2D>): void {
    let holdsOne = false;
    for (const node of this.rope.path()) {
      if (held.has(node.contact.obj as RigidBody2D)) holdsOne = true;
    }
    if (holdsOne) this.rope.solveLengthHolding(held);
  }

  // One solve pass. Called after `World.integrate`, so the constraint has the
  // last word on where the bodies it holds end up - the same order the ball
  // controller runs its chain in, and for the same reason (solve before
  // integration ends every fast frame over-length by |v|·dt).
  solve(delta: number): void {
    const watch = this.watchBodies;
    const versions = this.solvedAtVersion;
    if (this.lastSolveWasIdentity) {
      let unchanged = true;
      for (let i = 0; i < watch.length; i++) {
        if (watch[i]!.transformVersion !== versions[i]) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return;
    }
    for (let i = 0; i < watch.length; i++) versions[i] = watch[i]!.transformVersion;
    this.rope.solvePass(this.wrapBodies, delta);
    let identity = true;
    for (let i = 0; i < watch.length; i++) {
      const v = watch[i]!.transformVersion;
      if (v !== versions[i]) {
        identity = false;
        versions[i] = v;
      }
    }
    this.lastSolveWasIdentity = identity;
  }

  // How far over its length it ended the pass. Zero while slack: the constraint
  // is an inequality, and a slack rope is satisfied.
  get residual(): number {
    return this.rope.overLength;
  }

  get tolerance(): number {
    return CHAIN_TOLERANCE;
  }

  get creditScale(): number {
    return this.rope.topologyCreditScale;
  }

  eachBody(fn: (body: RigidBody2D) => void): void {
    for (const node of this.rope.path()) {
      const body = node.contact.obj;
      if (body instanceof RigidBody2D) fn(body);
    }
  }

  holds(body: RigidBody2D): boolean {
    return this.rope.path().some((n) => n.contact.obj === body);
  }

  // Whatever the sweep could not reach is the chain being held over its length
  // by the geometry one of its bodies rests against - the winch stall - and
  // re-basing lets the constraint settle there instead of winding up against
  // the block.
  //
  // "Held" is measured, in the ball's phase's words (see
  // `Rope.absorbBlockedLength`): against what the pushing surfaces make
  // UNREACHABLE, and bounded by how far they pushed. A push-out along a normal
  // does not refuse a correction that was not along that normal; it deflects
  // it. Leased as if it had been refused, a weight hung beside a post on a
  // chain that pulled it up and INTO the post had the post hand back the
  // into-post share every frame, that share leased, the loosened constraint
  // let the weight settle a little lower, and the next frame paid the same
  // share again: 0.5 mm of chain a frame, 24 cm over 480 frames, read from the
  // game as the chain growing while the weight slid down the post
  // (`session-497f`). Measured against what the post refuses - nothing, since
  // sliding up it shortens the span - the residual is next frame's ordinary
  // length error and the weight hangs where its chain says.
  settle(pushes: readonly BodyPush[]): void {
    const refusals: LengthRefusal[] = [];
    let pushed = 0;
    for (const p of pushes) {
      refusals.push({ body: p.body, normals: p.pushedOutOf.map((o) => o.normal) });
      for (const o of p.pushedOutOf) pushed += o.depth;
    }
    this.rope.noteGeometryPush(pushed);
    const refused = this.rope.absorbBlockedLength(refusals);
    // Whether geometry actually refused the chain this frame - only where the
    // surfaces stand in the way of a shorter chain. Next frame's `beginFrame`
    // reads it to decide whether the lease may be handed back.
    if (refused > 0) this.blockedThisFrame = true;
    this.rope.noteBlockedByGeometry(this.blockedThisFrame);
  }
}

// How far over its length any chain may end a frame. This is the statement the
// sweep loop below is written against, and it is what "the chain does not
// stretch" means: 5 mm is half a pixel at PIXELS_PER_METER, i.e. under what the
// renderer can show.
export const CHAIN_TOLERANCE = 0.005;

// ...and the bar a VINE JOINT runs to instead - a pair chain, a bend, a
// per-link long-range attachment. Deliberately looser, and the looseness is a
// design decision rather than a solver concession: a vine is allowed a little
// visible stretch under load (it reads as vine flex), the per-link attachments
// bound the cumulative sag whatever the joints do locally, and the held link
// itself is bound by the load rope at `CHAIN_TOLERANCE`. What the looseness
// buys is the sweep count: a stiff vine's bends and pairs disagree by
// construction and converge at one link per sweep, so holding every joint to
// 5 mm cost a swinging vine 25-40 sweeps a frame (measured, `session-322f`)
// for millimetres nobody can see.
export const VINE_TOLERANCE = 0.015;

// Sweeps the tolerance may spend getting there. A ceiling, not a target - a rig
// that converges leaves the loop on the sweep it converges on, which for the
// single-chain rigs that are most of every level is the first one.
//
// Measured on the ball arena's hanging weight (a link on one chain, a 476 kg
// slab on two more), worst over-length over a settled 300-frame window, and the
// wall clock for 900 frames of all three chains:
//
//   sweeps   over-length   cost
//        1       125 mm      -
//        4        73 mm     84 ms
//       16        22 mm    125 ms
//       32        11 mm    208 ms
//       64       5.2 mm    394 ms
//      128       2.2 mm    786 ms
//
// It halves per doubling and does not stall, so the cap is a straight choice of
// how much to spend: 64 reaches the tolerance on that rig (4.99 mm) for 0.55 ms
// a frame, against a 16.7 ms budget.
//
// The cap and not the tolerance is therefore what a hard rig gets, and it is
// meant to be: convergence rate falls with the chains' angle, because a shallow
// V carries a far bigger tension for the same weight. `cli contacts`
// `chain-order` is one at 14 degrees off horizontal, and it wants ~200 sweeps
// for 5 mm - 1.7 ms a frame for a piece of scenery. It gets 64 and ends 15 mm
// over, against 191 mm at one sweep. Authoring the chains steeper is worth more
// there than any cap this side of sane, and a rig that will not converge is
// bounded rather than silently expensive.
const MAX_CHAIN_SWEEPS = 64;

// The cap when a player rope is coupled into the set. It is a genuine ceiling
// now rather than the working sweep count: a held vine exits on the residual
// gate in a handful of sweeps (5-11 coupled sweeps measured on
// `session-322f`), because its load rope is a closed-form `VineAnchor` (one
// projection, exact) and its joints run to `VINE_TOLERANCE` rather than the
// chain bar. Lowering the cap was measured against that arrangement and
// bought nothing - the exit gate, not the cap, is what sets the count - so it
// stays where the old rigid-vine contract needed it, as the bound on a rig
// that will not converge.
const MAX_COUPLED_SWEEPS = 48;

// Consecutive sweeps that buy nothing before a coupled set is called stalled
// and the loop leaves early. See the stall gate in `sweepOneSet`.
//
// Four, against a measured two. A Gauss-Seidel pass over a coupled set is not
// monotonic, so the bar has to clear the longest run of sweeps a set that IS
// still converging can spend giving ground: over the whole of `cli vines` that
// is 23226 single sweeps, 89 pairs and no run of three, and over every playtest
// it is one. The pathological run this exists to cut short has no length at all
// - `session-231f` f88 reproduces its own answer to the last bit for 46 sweeps -
// so the gap between the two is what the threshold sits in, and doubling the
// observed worst costs a coiled chain one extra sweep of the 48 it was spending.
const STALLED_SWEEPS = 4;

// Metres of progress a sweep must make to count as having made any. A bare
// `<` is a branch on a float comparison, and two thirds of the sweeps this
// gate sees leave the residual bit-identical while a further sixth improve it
// by amounts reaching down to 2.220e-16 m - one ULP on a quantity of order 1,
// which is the width the browser and bun disagree by. Read as progress, a
// knife-edge like that costs the loop a whole extra sweep on one engine and
// not the other, which is `PUSH_OUT_MIN_DEPTH`'s lesson arriving in a new
// place: a threshold anything real sits far above is what stops float noise
// deciding a branch. A picometre is ten thousand times the noise it rejects
// and a billionth of `CHAIN_TOLERANCE`, so nothing a sweep does on purpose
// can fall under it.
const SWEEP_PROGRESS_EPSILON = 1e-12;

// One frame of every scene chain, as ONE system rather than as a list of
// independent ropes.
//
// Each chain is a full PBD solve that writes positions and credits itself
// velocity, so a single pass in list order is Gauss-Seidel with one iteration:
// the first chain solves against the state gravity left, moves both of its
// bodies, and the next solves against a scene the first has already displaced.
// Its correction is then the last word, and the residual is whatever the earlier
// chains wanted and did not get.
//
// That residual is not small and it does not wash out. A weight hung from a link
// by two chains - one pair of bodies, two constraints, which is what any bridle
// or swing seat is - leaned 18 cm off centre with its link tilted 18 degrees, in
// a rig symmetrical to the millimetre. Swapping the two chains' order in the
// level file mirrored the result exactly, digit for digit, which is the whole
// diagnosis: nothing about the geometry chose that side, the array order did.
// Worse, the residual is re-injected every frame, so the rig also rang at
// 0.085 m/s for ever instead of settling.
//
// Sweeping the set repeatedly is the standard answer (this is what iteration
// count is FOR in every impulse or PBD solver), and the direction alternates so
// the order bias of one sweep is the mirror of the next's rather than the same
// one compounded. The bias stays order-driven at any sweep count - swapping the
// file's chains still mirrors the answer - but a converged set leaves it the
// size of a solver residual rather than the size of the level, and the rig
// settles instead of ringing.
//
// The same residual is what the chains look like they are made of. Each solve
// pins its own chain to exactly its length (`relaxationFactor` is 1, and a lone
// chain measures 0.00 mm of stretch under any load at all), but the chain solved
// after it moves the bodies they share and stretches the first one back out. On
// the ball arena's hanging weight that was 73 mm on a 1.03 m chain - 7%, read
// from the game as the chain being made of elastic. It is not: it is the set
// being left unconverged, and it does not care how heavy the weight is (the same
// rig at 4x the mass stretches by the same 72.72 mm, since a PBD position
// correction is written in mass ratios).
//
// So the loop runs to the RESIDUAL rather than to a count: sweep until no chain
// is more than `CHAIN_TOLERANCE` over its length, up to `MAX_CHAIN_SWEEPS`. What
// that buys over a fixed count is both ends at once - the single-chain rigs that
// are most of every level converge on the first sweep and pay for one, and a
// coupled rig spends what it actually needs instead of what looked reasonable
// when the constant was written.
//
// `beginFrame` stays outside the loop: it releases the blocked-length lease, and
// a lease released once per PASS would be handed back a sweep's worth faster
// than the geometry that bought it can re-earn it.
//
// `extra` is a rope that is NOT scenery but shares a body with the set - the
// player's grapple rope while it is holding a vine link (see `level/vines.ts`),
// which is the same situation `BallLevel` passes the ball's chain in for. It is
// forwarded straight to `sweepChains`, which is where the reason lives.
// The level's two sleep passes over its authored chains (see `SceneChain.asleep`).
// `wakeChains` runs at the top of the frame, after integration has had its
// chance to wake a body by contact and before the frame's chain set is built;
// `sleepChains` runs at the very end, after `World.settleSleep`. `awakeChains`
// is the set to hand `vineChainSet` as the authored list, rebuilt into the
// caller's own array so a sleeping level allocates nothing.
export function wakeChains(chains: readonly SceneChain[]): void {
  for (const chain of chains) chain.wakeIfDisturbed();
}

export function sleepChains(chains: readonly SceneChain[]): void {
  for (const chain of chains) chain.sleepIfSettled();
}

// Settle the authored chains at build, so a level arrives with its hanging
// things already asleep - the vine's `settleVinesAtBuild`, for chains. Left to
// settle live, every lantern in the ball arena swung itself out over the
// first five seconds of play (180 to 330 frames to sleep on `session-392f`),
// which is the whole of a short session spent paying for scenery.
//
// Only a chain whose every rigid body hangs CLEAR - overlapping no other body
// and no area, and neither a pivot nor a sprung body, which `World.integrate`
// steps differently - is settled here, because this loop runs gravity and the
// chain phase and nothing else: no contacts, no areas. A chain-hung crate
// resting on a floor would fall through it. Such a chain settles live, as it
// always did. A chain sharing a body with one that cannot be settled here is
// left with it: half a system settled is a system solved against bodies
// nothing is stepping.
const SETTLE_AT_BUILD_CAP = 600;
const CLEAR_MARGIN = 0.05;

export function settleChainsAtBuild(world: World, chains: readonly SceneChain[]): void {
  const clear = new Set<SceneChain>();
  for (const chain of chains) if (chainClearAtBuild(world, chain)) clear.add(chain);
  // Close under shared bodies: drop any candidate sharing a body with a chain
  // that is not one, until nothing changes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const chain of clear) {
      for (const other of chains) {
        if (other === chain || clear.has(other)) continue;
        let shares = false;
        chain.eachBody((body) => {
          if (other.holds(body)) shares = true;
        });
        if (shares) {
          clear.delete(chain);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  const candidates = [...clear];
  if (candidates.length === 0) return;
  const dt = 1 / 60;
  const awake: SceneChain[] = [];
  const bodies: RigidBody2D[] = [];
  for (let frame = 0; frame < SETTLE_AT_BUILD_CAP; frame++) {
    awake.length = 0;
    for (const chain of candidates) if (!chain.asleep) awake.push(chain);
    if (awake.length === 0) break;
    bodies.length = 0;
    const seen = new Set<RigidBody2D>();
    for (const chain of awake) {
      chain.eachBody((body) => {
        if (!seen.has(body)) {
          seen.add(body);
          bodies.push(body);
        }
      });
    }
    // The same step `World.integrate` gives a free body, minus everything a
    // clear body has no use for.
    for (const body of bodies) {
      if (body.asleep) continue;
      body.linearVelocity = body.linearVelocity.add(GRAVITY.mul(body.gravityScale * dt));
      body.globalPosition = body.globalPosition.add(body.linearVelocity.mul(dt));
      body.globalRotation += body.angularVelocity * dt;
    }
    stepSceneChains(awake, world, dt);
    world.settleSleep(bodies);
    sleepChains(awake);
  }
}

function chainClearAtBuild(world: World, chain: SceneChain): boolean {
  let clear = true;
  chain.eachBody((body) => {
    if (!clear) return;
    if (!body.canSleep || body.pivot || body.spring !== null) {
      clear = false;
      return;
    }
    for (const s of body.getShapes()) {
      const c = s.globalPosition;
      const e = s.extents();
      const minX = c.x - e.x - CLEAR_MARGIN;
      const minY = c.y - e.y - CLEAR_MARGIN;
      const maxX = c.x + e.x + CLEAR_MARGIN;
      const maxY = c.y + e.y + CLEAR_MARGIN;
      // Static scenery near a body is allowed: the chain phase's own settle
      // pushes a chain body out of statics (`settleChainBodies`), so a lantern
      // hung an inch off its wall settles here as it would live. Anything that
      // can move - a crate, the ball, a platform - is not, since nothing in
      // this loop would step it or solve the pair.
      for (const o of world.queryShapes(minX, minY, maxX, maxY)) {
        const owner = o.owner;
        if (owner === body || !(owner instanceof PhysicsBody2D)) continue;
        if (owner.isMobile || !(owner instanceof StaticBody2D)) clear = false;
      }
      for (const area of world.areas) {
        if (area.removed) continue;
        for (const a of area.getShapes()) {
          const ac = a.globalPosition;
          const ae = a.extents();
          if (ac.x + ae.x >= minX && ac.x - ae.x <= maxX && ac.y + ae.y >= minY && ac.y - ae.y <= maxY) {
            clear = false;
          }
        }
      }
    }
  });
  return clear;
}

export function awakeChains(chains: readonly SceneChain[], into: SceneChain[]): SceneChain[] {
  into.length = 0;
  for (const chain of chains) if (!chain.asleep) into.push(chain);
  return into;
}

export function stepSceneChains(
  chains: readonly SceneConstraint[],
  world: World,
  delta: number,
  extra: CoupledRope | null = null,
): void {
  if (chains.length === 0) return;
  dampChainBodies(chains);
  const before = snapshotChainBodies(chains, null);
  for (const chain of chains) chain.beginFrame(delta);
  sweepChains(chains, extra, delta);
  settleChainBodies(chains, before, world, delta);
}

// Per-frame velocity retention for a body a scene chain holds. A body on a
// chain is damped by nothing: a PBD length constraint dissipates nothing, a
// body hanging in free air touches nothing, and the sweep's tolerance lets the
// chain lengthen by a fraction of a millimetre a frame, which feeds the swing
// - the vine's finding (`LINK_DAMPING`), exact for a lantern. Undamped, every
// lantern in the ball arena swung for ever at 3-60 mm and never reached the
// rest rule (`session-392f`: six chain-hung bodies awake at frame 300, every
// one restarting its window at 29). Applied BEFORE the phase's snapshot, for
// the reason the vine applies it before its own: `settleChainBodies` rewrites
// a body's velocity as what it had at the top of the phase plus what the
// phase moved it by. A body the avatar's chain has hold of is left alone -
// what a swing on a lantern feels like is the ball's chain phase's to decide,
// and this must not change it - and so is one that is asleep, which has no
// velocity to lose. Lighter than the vine's 0.98: iron on a chain rings
// longer than rope, and a bumped lantern still swings for a few seconds.
const CHAIN_BODY_DAMPING = 0.99;

function dampChainBodies(chains: readonly SceneConstraint[]): void {
  const seen = new Set<RigidBody2D>();
  for (const chain of chains) {
    chain.eachBody((body) => {
      if (seen.has(body) || body.held || body.asleep || !body.canSleep) return;
      seen.add(body);
      body.linearVelocity = body.linearVelocity.mul(CHAIN_BODY_DAMPING);
      body.angularVelocity *= CHAIN_BODY_DAMPING;
    });
  }
}

// The share of this frame's chain-phase displacement each body may be paid
// velocity for: the lowest `topologyCreditScale` among the chains that hold it
// (a body no chain touches is simply absent, and reads as 1). One pass over
// the chains' OWN bodies rather than chains x bodies of `holds` queries, which
// on a level of vines was the single most expensive line of the settle
// (~40 ms of a 340 ms replay, measured on `session-322f`).
function creditScales(chains: readonly SceneConstraint[]): Map<RigidBody2D, number> {
  const scales = new Map<RigidBody2D, number>();
  for (const chain of chains) {
    const scale = chain.creditScale;
    if (scale >= 1) continue;
    chain.eachBody((body) => {
      const prev = scales.get(body);
      if (prev === undefined || scale < prev) scales.set(body, scale);
    });
  }
  return scales;
}

// A body a chain solve is about to move, as it stood before that solve. The
// chain phase's velocity credit is `Δposition / Δt` taken over the WHOLE phase
// (see `settleChainBodies`), so what it needs is one snapshot per body, not the
// per-pass deltas the sweep's individual solves take.
export interface ChainBodyState {
  readonly body: RigidBody2D;
  readonly position: Vec2;
  readonly rotation: number;
  readonly velocity: Vec2;
  readonly spin: number;
}

// Every dynamic body on the given chains' paths, snapshotted. `exclude` is for a
// caller that keeps its own books for one body — `BallLevel` does, for the ball.
export function snapshotChainBodies(
  chains: readonly SceneConstraint[],
  exclude: RigidBody2D | null,
): ChainBodyState[] {
  const states: ChainBodyState[] = [];
  const seen = new Set<RigidBody2D>();
  for (const chain of chains) {
    chain.eachBody((body) => {
      if (body === exclude || seen.has(body)) return;
      seen.add(body);
      states.push({
        body,
        position: body.globalPosition,
        rotation: body.globalRotation,
        velocity: body.linearVelocity,
        spin: body.angularVelocity,
      });
    });
  }
  return states;
}

// Close the chain phase against the geometry, which is what makes a chain-hung
// body's velocity honest.
//
// A chain writes its positional correction straight onto the bodies it holds and
// pays itself velocity for it, Δposition over Δt. That is a standard PBD
// velocity update and it is honest, but ONLY if the correction is the last word
// on where the body ends up. For a body a chain hauls into a surface it is not:
// the frame ends with the body embedded, next frame's `World.integrate` pushes
// it back out positionally and kills the approach velocity at the contact, and
// the chain then re-corrects a gap that is now the push-out's depth PLUS the
// distance the credited velocity carried the body in the meantime. That is a
// feedback loop with a gain above one, and it doubles every frame.
//
// `session-147f` is the whole of it: a 628 kg plank hung from a static ledge by
// two chains, swung up so its end jammed under that same ledge. The chain's
// credit went -0.76, -2.44, -4.68, -7.42, -10.36 m/s over five frames while the
// contact's push-out grew 10, 32, 108, 200, 304 mm to match, until the plank sat
// 204 mm inside a 100 mm slab - deeper than half its thickness, so the contact
// push-out resolved out of the FAR face and the plank tunnelled clean through
// the ledge it hangs from. It then swung free with 2.6 kJ it never earned, fell
// back onto the ledge, and did it again.
//
// This is the same defect `BallLevel` was written around for the ball's own
// chain, and it is fixed the same way, in that phase's words: refunding the
// credit cannot be made to work (the credit is taken along the correction and
// would have to be handed back along the contact normal), so the frame is
// ORDERED so the question never arises. Push out here, derive the phase's
// velocity over the displacement that survives the push-out, and there is
// nothing to refund - a body can never bank speed for a move that was undone.
//
// The `funded` bound is `BallLevel`'s, for its reason: a body arrives at this
// phase already pressing into whatever it rests on, because `integrate` applied
// gravity and the contact solve does not run again before the frame ends.
// Cancelling that share too would leave the frame with no approach velocity at
// all, and next frame's contact would size its Coulomb cone from nothing. So the
// bound is gravity's own per-frame step, and no more than the body brought in
// with it.
//
// What is deliberately NOT applied here is `Rope.creditBound`, which bounds a
// solve's credit by the rate its own constraint was opening (see the ball's
// phase, and `session-360f`). That bound is a statement about ONE rope, and this
// credit is the sum of what a whole coupled set did to a body: a rig whose link
// and weight fall together opens neither of the two chains between them at all -
// their relative motion is zero - while the weight's upward credit is funded by
// the hanger chain above, through the link. Bounded chain by chain, every body in
// such a rig is starved of the credit it is owed, keeps gravity's step, and the
// symmetrical hanging rig `cli contacts` `chain-order` measures leans 178 mm
// instead of 6 and rings instead of settling. The honest bound for a coupled set
// is a coupled velocity solve over the whole set, which is what this would need
// before it could have one.
// The velocity half of a push-out: a body may not END the chain phase moving
// into a surface that has just refused to let it be there. The push-out undid
// the motion in position; this is the same statement in velocity, bounded by
// `funded` for the reason given above `settleChainBodies` - gravity's own step,
// and no more than the body brought into the phase with it.
//
// Taken at the POINT the surface pushed, and paid for as an impulse there -
// through the body's mass and its inertia by the same effective-mass split a
// contact uses - rather than as a linear clamp on the centre. The centre is
// the wrong place for a body that is not a circle. A plank a chain hauls down
// by one end is turned by the solve as much as it is moved, and its credit is
// a spin as much as a fall: clamped at the centre alone, the fall was refused
// and the spin kept, the plank's end went on turning into the foot it rested
// on, and the ball, reading an anchor whose attachment point was chasing it at
// 0.5 m/s, had its own brake credit clamped to nothing and went on falling
// (`session-133f` with the linear clamp: 0.47, 0.66, 0.77, 0.90, 1.07, 1.30,
// 1.59 rad/s over seven frames, the plank lifted clear each frame and rotated
// a little deeper the next, until it stood on one corner and fell through).
// The end's velocity into the surface is the thing the surface refused, and
// the impulse that stops it is the one the foot would have applied.
//
// Shared with the ball's own chain (see `BallLevel`), whose rigid ANCHOR is a
// chain-hung body by every measure that matters here: the solve writes its
// correction onto it and pays it velocity, and a static under it can refuse
// the move exactly as it refuses a scene chain's plank.
export function refuseIntoSurfaces(
  s: ChainBodyState,
  pushedOutOf: readonly PushOut[],
  delta: number,
): void {
  const body = s.body;
  const gravityStep = GRAVITY.mul(body.gravityScale * delta);
  for (const { normal, point } of pushedOutOf) {
    const r = point.sub(body.globalPosition);
    const into = body.velocityAtPoint(point).dot(normal);
    // What the point brought into the phase: the snapshot's velocity, at the
    // same arm.
    const brought = s.velocity.add(new Vec2(-r.y, r.x).mul(s.spin)).dot(normal);
    const funded = Math.max(Math.min(brought, 0), Math.min(gravityStep.dot(normal), 0));
    if (into >= funded) continue;
    const arm = r.cross(normal);
    const invEff = body.inverseMass + arm * arm * body.inverseInertia;
    if (invEff <= 0) continue;
    const j = (funded - into) / invEff;
    body.linearVelocity = body.linearVelocity.add(normal.mul(j * body.inverseMass));
    body.angularVelocity += arm * j * body.inverseInertia;
  }
}

// Every rigid body a rope's path runs over, other than `exclude`, snapshotted as
// `snapshotChainBodies` snapshots a scene set's - the same books, for the
// ball's own chain.
export function snapshotRopeBodies(rope: Rope, exclude: RigidBody2D | null): ChainBodyState[] {
  const states: ChainBodyState[] = [];
  const seen = new Set<RigidBody2D>();
  for (const node of rope.path()) {
    const body = node.contact.obj;
    if (!(body instanceof RigidBody2D) || body === exclude || seen.has(body)) continue;
    seen.add(body);
    states.push({
      body,
      position: body.globalPosition,
      rotation: body.globalRotation,
      velocity: body.linearVelocity,
      spin: body.angularVelocity,
    });
  }
  return states;
}

// Close a rope's rigid path bodies against the scenery WITHOUT replacing the
// credit the rope's own solve paid them. The ball's chain bounds that credit
// itself (`Rope.creditBound`, the spin-share rollback, a pivot's rotation
// bound) and those bounds are load-bearing; what its bodies were missing is
// only the closure `settleChainBodies` gives a scene set - pushed out of the
// statics, and refused the velocity into them. Bit-identical on every frame no
// path body is standing in a static, which is every frame of every recording
// made before it existed.
//
// The push-out is `World.depenetrateRigidAtPoints` - out of the surface in
// rotation as much as in translation, which for a chain-hauled plank is the
// way it went in - and the refusal in velocity is taken at the same points.
//
// Returns the bodies that were pushed: geometry standing in the path's way
// this frame. The caller re-solves the length with those held, so the ball
// takes the correction its anchor could not (`Rope.solveLengthHolding`), and
// the lease release must not run into them (`Rope.noteBlockedByGeometry`).
export function refuseRopeBodiesIntoStatics(
  before: readonly ChainBodyState[],
  world: World,
  delta: number,
): Set<RigidBody2D> {
  const blocked = new Set<RigidBody2D>();
  for (const s of before) {
    const pushedOutOf = world.depenetrateRigidAtPoints(s.body, 4);
    if (pushedOutOf.length === 0) continue;
    blocked.add(s.body);
    refuseIntoSurfaces(s, pushedOutOf, delta);
  }
  return blocked;
}

//
// Returns the bodies the geometry pushed: a caller whose own rope also runs
// over one of them (the ball's chain anchored to a chain-held plank) re-solves
// its length with those held, so its far end takes the correction the pushed
// body could not (`Rope.solveLengthHolding`).
export function settleChainBodies(
  chains: readonly SceneConstraint[],
  before: readonly ChainBodyState[],
  world: World,
  delta: number,
): Set<RigidBody2D> {
  const pushes = new Map<RigidBody2D, PushOut[]>();
  const pushedOutOfBy = new Map<RigidBody2D, PushOut[]>();
  const scales = creditScales(chains);
  for (const s of before) {
    // Out of the SCENERY, and not out of other dynamic bodies. A chain-hung body
    // is as often a platform as a weight, and an overlap with something resting
    // on it is a pair the next `integrate` solves for both sides with an impulse
    // - resolving it here instead moves the wrong body, since the constraint's
    // own body is not the one that has to give way, and then pays it velocity
    // for having moved. `steered-hung-hold` is the case: the ball rests on a
    // chain-hung slab, and a push-out that counted the ball shoved the slab out
    // from under it every frame and rode the credit 15 m across the level.
    //
    // And out of them AT THE POINT the surface met the body, in rotation as
    // much as in translation (`World.depenetrateRigidAtPoints`), which is how
    // the ball's own path bodies have been closed since `session-133f` and
    // was left as the open half of `chain-hung-jam`. A chain hauls a long body
    // by one end, and the correction is a turn about its centre far more than
    // it is a move: a 91 kg plank across two feet, the ball hooked under its
    // near end and the chain snapping taut, was turned 0.016 rad and moved
    // 14 mm down in one solve - 35 mm at the hauled end, 7 mm UP at the far
    // one. The translation push-out then lifted the whole plank by the near
    // end's depth, 23 mm, far end included, and the phase's books read that as
    // 9 mm of upward motion the plank had earned and a turn it had kept:
    // -0.7 m/s and -0.7 rad/s on the first frame, -2.2 and -1.7 on the next,
    // -3.9 and -3.0, -5.1 and -4.0, until at -6.5 m/s and -6.7 rad/s the plank
    // left both feet and cartwheeled off its own chain (`session-193f`, read
    // from the game as pulling the plank down making it fly up). Resolved at
    // the point, the foot turns the plank back out the way the haul turned it
    // in - the same effective-mass split the solve wrote it with - and the
    // frame's net displacement is the nothing a plank on two feet actually did.
    const pushedOutOf = world.depenetrateRigidAtPoints(s.body, 4);
    pushedOutOfBy.set(s.body, pushedOutOf);
    // What the constraints hear of: the pushes that were pushes, not the float
    // noise of a body left at exactly zero depth (see `PUSH_OUT_MIN_DEPTH`).
    const real = pushedOutOf.filter(isRealPush);
    if (real.length > 0) pushes.set(s.body, real);
  }
  // The share of the correction a pushed body could not take is still owed,
  // and it goes to whatever else the constraint holds: the same constraint
  // solved once more with the pushed bodies held immovable, which is the
  // winch's own mechanism and what the ball's phase does for its own anchor.
  // Without it the refused share stood as over-length every frame - a plank
  // wedged in a corner, hauled 8 mm into it and pushed 8 mm back out, frame
  // after frame, while the weight on the chain's other end that could have
  // taken every millimetre of it hung 9 mm low - and the settle below, asked
  // what the corner refused, honestly answered "all of it" and leased it:
  // 7.5 mm of chain a frame, the weight creeping down its chain for as long as
  // the plank stayed wedged (`session-527f`). Before the credit, so the move
  // is paid for over the phase like every other.
  if (pushes.size > 0) {
    const held = new Set(pushes.keys());
    for (const chain of chains) chain.resolveHolding(held);
  }
  for (const s of before) {
    const pushedOutOf = pushedOutOfBy.get(s.body) ?? [];
    // Discounted the same way each solve discounts its own credit, and it has to
    // be carried here because this REPLACES those credits rather than adding to
    // them: a length error the path's own topology put there is corrected in
    // position and earns no velocity (see `Rope.topologyCreditScale`). A scene
    // chain wraps nothing, but its span can still be re-resolved around the
    // corner of the very body it is bolted to, and that jump is not motion - it
    // is the description changing. Dropped, this rig's span grew 46 cm in one
    // frame as the plank turned under its own anchor and the plank left at
    // 13.9 m/s carrying 66 kJ.
    //
    // The lowest scale of the chains holding this body, because the credit being
    // scaled is the sum of what they all did to it and a jump on any one of them
    // is a jump in that sum.
    const credit = scales.get(s.body) ?? 1;
    s.body.angularVelocity =
      s.spin + ((s.body.globalRotation - s.rotation) / delta) * credit;
    s.body.linearVelocity = s.velocity.add(
      s.body.globalPosition.sub(s.position).div(delta).mul(credit),
    );
    refuseIntoSurfaces(s, pushedOutOf, delta);
  }
  // ...and then each constraint is told which of its bodies the geometry
  // pushed, and how, which is what a chain uses to measure the length it could
  // not reach (see `SceneChain.settle`). Per constraint and not per scene: a
  // lease released into a live block spends every frame hauling a body into a
  // surface that is already saying no, and one blocked chain is no reason to
  // hold another's.
  for (const chain of chains) {
    const own: BodyPush[] = [];
    chain.eachBody((body) => {
      const pushedOutOf = pushes.get(body);
      if (pushedOutOf) own.push({ body, pushedOutOf });
    });
    chain.settle(own);
  }
  return new Set(pushes.keys());
}

// A rope swept alongside the scene set because it shares a body with it: the
// ball's chain, or the player's grapple rope while it is holding a vine link.
export interface CoupledRope {
  readonly rope: Rope;
  // What that rope may wrap - the caller's scene, not the chain set's.
  readonly bodies: PhysicsBody2D[];
  // Must the SET reach its own tolerance before the sweep may leave, or is the
  // coupling's residual the whole test?
  //
  // False is the ball's, and it is measured: the arena's three chains want ~200
  // sweeps for 5 mm and get 64, so the set is over tolerance on 1616 frames of
  // 1618, and a loop waiting for it spends the whole cap on the one solve in the
  // set that regenerates a wrap path. That doubled the arena's physics frame for
  // sweeps that had stopped changing the answer after the first (session-1618f,
  // below).
  //
  // True is a vine's, and it is measured too, in the opposite direction. A vine
  // is thirty pair chains in SERIES, which is the one topology a single
  // Gauss-Seidel sweep cannot hold: gated on the coupling alone the set got
  // exactly one sweep per frame from the moment the hook grabbed, every pair
  // ended the frame over its length, the blocked-length lease absorbed the
  // difference, and the vine came apart - link 7 of 30 on the FLOOR four seconds
  // after the grab while the grabbed link hung where it was caught. The set here
  // converges (~12 sweeps at rest, against the arena's never), so requiring it
  // costs the sweeps it actually needs rather than the cap.
  readonly settleSet: boolean;
}

// Which constraints of the set can actually argue with which: the connected
// components of "shares a dynamic body with", by union-find over the bodies.
// Null when the set is one component, which is every level whose chains all hang
// off each other - so those make exactly the calls they always did.
//
// The reason this exists is that the sweep's exit condition is a property of the
// SET while the work is per CONSTRAINT, and a set of independent rigs is
// therefore priced at its hardest member. A vine under a player's weight wants
// twenty-something sweeps and up to the cap on the frame the load arrives;
// everything else awake in the level was paying that bill. On `session-608f`,
// with the player hanging off the rightmost of three vines that hang within a
// metre of each other, 72 pair chains were re-solved ~24 times a frame - 8.8 ms
// of a 15.9 ms physics frame - and 44 of them were the two vines nobody was
// touching, already converged, being swept because a third vine was not.
//
// What makes splitting sound is that a component is CLOSED under the solve: a
// constraint moves only the bodies it holds, so a sweep of one component cannot
// disturb another, and a component swept to its own tolerance stays there
// however long the others then run. Sweeping them in sequence is the same solve
// as sweeping them interleaved, minus the sweeps that were never going to change
// an answer.
//
// Split, each vine takes the sweeps it needs - the held one still 14 to the cap,
// the other two 8 and 14 - and that bundle's swinging window reads:
//
//              mean     p50     p95     max
//   together   15.9    14.3    25.3    48.3
//   split      13.6    12.8    19.5    28.9
//
// The tail is where it shows, because the tail is exactly the frames the held
// vine spent the cap and everything else awake spent it with them.
function chainComponents(chains: readonly SceneConstraint[]): Int32Array | null {
  const parent = new Int32Array(chains.length);
  for (let i = 0; i < chains.length; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  // The first constraint to name a body owns it; every later one that names it
  // joins that set. A constraint holding no dynamic body at all (both ends
  // static) is its own component, which is what it is.
  const owner = new Map<RigidBody2D, number>();
  for (let i = 0; i < chains.length; i++) {
    chains[i]!.eachBody((b) => {
      const j = owner.get(b);
      if (j === undefined) owner.set(b, i);
      else {
        const a = find(i);
        const c = find(j);
        if (a !== c) parent[c] = a;
      }
    });
  }
  let roots = 0;
  for (let i = 0; i < chains.length; i++) if (find(i) === i) roots++;
  if (roots <= 1) return null;
  const out = new Int32Array(chains.length);
  for (let i = 0; i < chains.length; i++) out[i] = find(i);
  return out;
}

// The components `extra` reaches, by its own path bodies rather than by its two
// ends: a rope wrapping a corner picks up bodies mid-path, and one of them being
// a link of the vine the hook holds is the whole reason this coupling exists.
// They are swept as ONE set with the rope, since the rope is what joins them.
function coupledRoots(
  chains: readonly SceneConstraint[],
  comp: Int32Array,
  extra: CoupledRope,
): Set<number> {
  const seeds = new Set<RigidBody2D>();
  for (const node of extra.rope.path()) {
    const body = node.contact.obj;
    if (body instanceof RigidBody2D) seeds.add(body);
  }
  const roots = new Set<number>();
  for (let i = 0; i < chains.length; i++) {
    let touches = false;
    chains[i]!.eachBody((b) => {
      if (seeds.has(b)) touches = true;
    });
    if (touches) roots.add(comp[i]!);
  }
  return roots;
}

// The sweep itself, over a set whose frames are already open, plus optionally
// one more rope that is NOT scenery: the ball's chain, when it is anchored to a
// body a scene chain also holds.
//
// That rope belongs in this loop for exactly the reason the scene chains belong
// in it with each other - they share a body, so each one's solve is the last
// word on where that body ends up and the other's correction is the residual.
// Left out of it, the ball's chain solved once, after the set had converged, and
// the two spent every frame undoing each other: the ball arena's link block was
// moved 10 mm and 0.15 rad one way by its three chains and 11 mm and 0.17 rad
// back by the ball's, frame after frame, for ever (session-521f).
//
// The cost of that is not the shaking, which nets out in position. It is that a
// PBD correction is split between the bodies on the path by their INVERSE MASS,
// and the ball's chain, solving alone, split it against the link's own 11 kg
// rather than against what the link is actually tied to. Four fifths of every
// winch correction was therefore spent moving an anchor that three other chains
// put straight back, and the ball - which is what winding chain onto yourself is
// supposed to haul - kept a fifth. Swept together, the scene chains refuse the
// anchor within the frame and the next pass puts the correction where it can
// still go, which is the ball: a light anchor on a chain went from 7 cm of winch
// travel to 137 cm (`playtests/ball-winch-hung-anchor.json`), against 136 cm for
// the same rig anchored to a static, which is the statement - how far a winch
// hauls must not depend on what is holding the far end.
//
// A set that falls into independent components is swept one component at a time,
// each to its own residual (see `chainComponents`), with `extra` swept alongside
// whichever components it reaches. Only a rig that will not converge pays the
// cap, and only that rig.
export function sweepChains(
  chains: readonly SceneConstraint[],
  extra: CoupledRope | null,
  delta: number,
): void {
  // Every length solve inside this sweep is the SWEEP's, not the frame's own
  // rope pass, and a `cli trace --solve` reader has to be able to tell them
  // apart: the sweep leaves its ropes inside `CHAIN_TOLERANCE` rather than at
  // zero, so an iteration ending short means something different here.
  PhaseTrace.pass = "sweep";
  try {
    sweepChainsInner(chains, extra, delta);
  } finally {
    PhaseTrace.pass = "length";
  }
}

function sweepChainsInner(
  chains: readonly SceneConstraint[],
  extra: CoupledRope | null,
  delta: number,
): void {
  const comp = chainComponents(chains);
  if (comp) {
    const coupled = extra ? coupledRoots(chains, comp, extra) : null;
    const withExtra: SceneConstraint[] = [];
    // Keyed by root, in first-constraint order, and each group keeps the set's
    // own order - which the vine builder chose (pair chains before the bends
    // that argue with them, load rope last) and which a Gauss-Seidel sweep is
    // not free to change.
    const groups = new Map<number, SceneConstraint[]>();
    for (let i = 0; i < chains.length; i++) {
      if (coupled?.has(comp[i]!)) {
        withExtra.push(chains[i]!);
        continue;
      }
      const root = comp[i]!;
      const group = groups.get(root);
      if (group) group.push(chains[i]!);
      else groups.set(root, [chains[i]!]);
    }
    for (const group of groups.values()) sweepOneSet(group, null, delta);
    // Still swept when nothing is coupled to it: the rope is the caller's and
    // has to be solved whatever the scenery is doing.
    if (extra) sweepOneSet(withExtra, extra, delta);
    return;
  }
  sweepOneSet(chains, extra, delta);
}

// One set, swept as one system - the loop this file is written about.
function sweepOneSet(
  chains: readonly SceneConstraint[],
  extra: CoupledRope | null,
  delta: number,
): void {
  const cap = extra ? MAX_COUPLED_SWEEPS : MAX_CHAIN_SWEEPS;
  // What the previous sweep left, so this one can be asked whether it achieved
  // anything (see the stall gate below).
  let prevDisturbed = Infinity;
  let prevWorstSet = Infinity;
  let stalled = 0;
  for (let sweep = 0; sweep < cap; sweep++) {
    if (sweep % 2 === 0) {
      for (let i = 0; i < chains.length; i++) chains[i]!.solve(delta);
    } else {
      for (let i = chains.length - 1; i >= 0; i--) chains[i]!.solve(delta);
    }
    if (extra) {
      // What the scene's pass has just done to the rope being coupled in, and
      // the ONLY thing this loop measures convergence by: the two are done
      // arguing once the scenery stops disturbing the rope, whatever the
      // scenery's own residual is.
      //
      // Gating on that residual instead is gating on a property of the LEVEL,
      // not of the coupling. The ball arena's rig wants ~200 sweeps for 5 mm and
      // gets 64 (see above), so the set is over its tolerance on essentially
      // every frame - 1616 of 1618 - and a loop waiting for it always spends the
      // whole cap. What it spends it on is a ball chain solve, which regenerates
      // a wrap path and is an order dearer than a scene chain's: it doubled the
      // arena's physics frame (p50 2.3 ms to 3.7, p99 5.2 to 8.9, peaks at
      // 15.3 against a 16.7 ms budget the renderer also draws inside) for sweeps
      // that had stopped changing the answer after the first (session-1618f).
      const disturbed = extra.rope.overLength;
      // ...and, where the caller says so, the set's own residual as well (see
      // `CoupledRope.settleSet`). Measured before the extra's solve for the same
      // reason `disturbed` is: it is what this sweep left behind.
      // ...as how far each constraint stands past its OWN bar (see
      // `SceneConstraint.tolerance`): zero or less is a set every member of
      // which is inside what it is allowed to end the frame at.
      let worstSet = 0;
      if (extra.settleSet) {
        for (const chain of chains) {
          worstSet = Math.max(worstSet, chain.residual - chain.tolerance);
        }
      }
      // Solved last, so the frame ends on the rope whose books the caller takes:
      // `BallLevel` credits the ball for the position the chain phase leaves it
      // at, and a scene chain solving after it would move the anchor out from
      // under that measurement.
      // A coupled solve the caller is paying for on every sweep is what
      // `settleSet: false` means, and it is solved unconditionally there so the
      // frame ends on the rope whose books that caller takes.
      //
      // Where the SET is what the loop is waiting for, that would be paying for
      // the dearest solve in the sweep on every one of the sweeps the set needs:
      // a player's rope regenerates its wrap path over the whole level, and a
      // vine wants a dozen sweeps at rest and more under load - 8.2 ms a frame,
      // which is session-1618f's cost arriving by the other door. So it is
      // solved only on the sweeps it is actually over its length on, and the
      // loop leaves only once BOTH are inside the tolerance, measured after this
      // sweep - so nothing has moved since either was last satisfied.
      //
      // What the loop may therefore LEAVE, and the reason `unwindOverLength`
      // has to be told about it, is a coupled rope up to `CHAIN_TOLERANCE` long
      // on the frames it skips (see `BallLevel`, session-337f).
      if (!extra.settleSet || disturbed > CHAIN_TOLERANCE) {
        extra.rope.solvePass(extra.bodies, delta);
      }
      if (disturbed <= CHAIN_TOLERANCE && worstSet <= 0) break;
      // ...and it leaves on a stall as well, because the gate above asks for
      // something a sweep cannot always deliver. A chain coiled onto its own
      // ball carries most of its over-length as coil, and no translation
      // removes coil (see `Rope.resolveLengthConstraint`): rolling with the
      // hook deployed and unattached wound 2.4 turns onto the ball, left the
      // free span 14 mm long against 28 mm of error, and the sweep then
      // reproduced its own answer to the last bit for 46 sweeps while the
      // frame ran 48 ms (`session-231f` f88). The cap is meant as the bound on
      // a rig that will not converge, but paying it in full is only right when
      // the sweeps are still buying something.
      //
      // A RUN of such sweeps rather than one, because a Gauss-Seidel pass over
      // a set is not monotonic: one sweep that gives ground can be the one
      // before the sweep that takes it back, and a held vine is exactly the
      // coupled arrangement where that happens - `cli vines` spends 89 pairs of
      // them and `grab-hang` is red on a bar of two, ending 4.8 mm over its
      // length against the millimetre it holds the player to. See
      // `STALLED_SWEEPS` for where the bar sits and what it was measured
      // against. Improvement in EITHER quantity counts, since with `settleSet`
      // the loop is waiting on both.
      const improved =
        disturbed < prevDisturbed - SWEEP_PROGRESS_EPSILON ||
        worstSet < prevWorstSet - SWEEP_PROGRESS_EPSILON;
      prevDisturbed = disturbed;
      prevWorstSet = worstSet;
      if (improved) stalled = 0;
      else if (++stalled >= STALLED_SWEEPS) break;
      continue;
    }
    // Measured after the sweep, so a set that is already satisfied still pays
    // one solve - the sweep is what discovers that, and gravity has moved the
    // bodies since the last one. Each constraint is held to its own bar (see
    // `SceneConstraint.tolerance`).
    let worst = 0;
    for (const chain of chains) worst = Math.max(worst, chain.residual - chain.tolerance);
    if (worst <= 0) break;
  }
}

// The authored anchor point pushed onto the body's own surface - the nearest
// point of the nearest of its shapes. A chain is bolted to a surface, so this is
// what the anchor means; it is also what keeps the solver sane, since an anchor
// in a body's interior leaves the span starting *inside* that body and the wrap
// generator resolves that as a self-intersection, winding the chain around its
// own anchor (see `nearestOnOutline`). It is applied at load rather than trusted
// from the file so a hand-edited level cannot author the degenerate case.
// The pieces of a body a chain may be tied to or routed over: the wrappable
// ones. An unwrappable piece (`CollisionObjectData.wrappable: false`) is solid
// scenery the rope passes straight through, so an anchor authored on it lands on
// the nearest piece the rope CAN hold instead - the hub inside a wheel's rim, on
// the body that is the two of them welded together. Every piece, for a body
// with no wrappable one: a chain tied there is what was authored, and the rope
// simply never bends around it.
function tieablePieces(obj: CollisionObject2D): { shape: CollisionShape2D; index: number }[] {
  const all = obj.getShapes().map((shape, index) => ({ shape, index }));
  const wrappable = all.filter((p) => p.shape.wrappable);
  return wrappable.length > 0 ? wrappable : all;
}

// A chain END: the nearest point of the nearest tieable piece's surface, and
// which piece that is.
export function snapToSurface(obj: CollisionObject2D, world: Vec2): Vec2 {
  return tieToSurface(obj, world).point;
}

function tieToSurface(
  obj: CollisionObject2D,
  world: Vec2,
): { point: Vec2; shapeIndex: number } {
  const pieces = tieablePieces(obj);
  const p = pieces[nearestShapeIndex(pieces.map((q) => q.shape), world)];
  if (!p) return { point: world, shapeIndex: 0 };
  return { point: nearestSurfacePoint(p.shape, world), shapeIndex: p.index };
}

// The wrap nodes a run of authored wrap points on one piece stands for,
// between the route's previous point and its next.
//
// A wrap node is a statement with a DIRECTION: the rope turns that way at it,
// and `cullDetachedNodes` lets it go the frame the rope stops turning that
// way. So the direction is read off the bend the authored route makes around
// the piece - clockwise on screen or counter - which is also what the scan's
// own chord-against-centre test comes to whenever a chord actually crosses a
// piece; it is only for a route the scan could never have produced (a chain
// that is nowhere near the beam it hangs over, as the crow flies) that the two
// differ, and there the bend is the one that is true of the chain.
//
// ONE direction per run, read at the run's middle between the points either
// side of the whole run, never per point. Read per point, a ring of seven
// points around a pulley gave each its direction from the bend between its
// two rim neighbours, which is next to no bend at all, and the last of them -
// between a rim neighbour and the far-off hub - came out the mirror of the
// other six: its exit tangent was then taken on the pulley's far side, and the
// chain went over the top, back under, and off to the hub (session-110f).
//
// One corner is not always a state the rope can hold. A chain hung over the
// near corner of a beam whose far side the load hangs down is, as one node,
// a chain that turns over the corner and dives back through the beam: the
// self-intersection resolver correctly refuses to continue a wrap whose next
// span circulates the other way, and the scan excludes the span's own shape, so
// nothing would ever mend it. That state is reachable in play only by HISTORY
// (the rope's end carried over the beam), and this is the history: from the
// authored corner, walk the piece's vertices in the bend's direction, adding
// each, until the span on to the next point no longer cuts the piece. A circle
// has no corners to walk and its wrap is two tangent points instead - where
// the rope from the previous point first touches it and where it leaves for
// the next - exactly the pair the scan and the resolver build between them.
function authoredWrap(
  obj: PhysicsBody2D,
  ties: readonly { point: Vec2; shapeIndex: number }[],
  prev: Vec2,
  next: Vec2,
): RopeWrap[] {
  const shapeIndex = ties[0]!.shapeIndex;
  const shape = obj.getShapes()[shapeIndex] ?? obj.primaryShape();
  // The run's middle: on a circle the rim point in the mean direction of its
  // points, which is where the chain crosses the piece; on a polygon its first
  // corner, which is where the walk below starts.
  const mean = ties.reduce((m, t) => m.add(t.point), Vec2.ZERO).div(ties.length);
  const middle = shape.shape.kind === "circle" ? nearestSurfacePoint(shape, mean) : ties[0]!.point;
  const bend = middle.sub(prev).cross(next.sub(middle));
  const wrapDir = bend >= 0 ? WrapDirection.Clockwise : WrapDirection.CounterClockwise;
  const node = (point: Vec2) =>
    new RopeWrap(new RopeContact(obj, point.sub(obj.globalPosition), shapeIndex), wrapDir);

  if (shape.shape.kind === "circle") {
    const radius = shape.shape.radius;
    const centre = shape.globalPosition;
    const tangent = (from: Vec2, dir: GenerationDirection): Vec2 =>
      from.distanceTo(centre) > radius
        ? RopeGeneration.calculateCircleTangentPoint(shape, wrapDir, from, dir)
        : middle;
    const entry = tangent(prev, GenerationDirection.Forward);
    const exit = tangent(next, GenerationDirection.Reversed);
    return entry.distanceTo(exit) < PX ? [node(entry)] : [node(entry), node(exit)];
  }

  const corners = ShapeGeometry.getGlobalCorners(shape);
  const n = corners.length;
  let i = 0;
  for (let k = 1; k < n; k++) {
    if (corners[k]!.distanceSquaredTo(middle) < corners[i]!.distanceSquaredTo(middle)) i = k;
  }
  const out = [node(corners[i]!)];
  for (let steps = 0; steps < n; steps++) {
    const span = new Segment(corners[i]!, next);
    if (Intersections.intersectsSegment(shape, span) !== IntersectionStatus.Overlap) break;
    i = Calc.mod(i + (wrapDir as number), n);
    out.push(node(corners[i]!));
  }
  return out;
}

// A chain WRAP POINT: the corner of the nearest tieable piece nearest the
// authored point - or, on a circle, the rim point - and which piece that is. A
// corner and not a face point, because a corner is what a rope bends around:
// a wrap node on the middle of a face is a node the rope hangs from with no
// geometry under the bend, which the detachment pass keeps for as long as the
// chain happens to bend there and which no scan would ever have produced. On a
// circle any rim point serves - the self-intersection resolvers slide a circle
// wrap to its tangent point every frame.
export function snapToCorner(
  obj: CollisionObject2D,
  world: Vec2,
): { point: Vec2; shapeIndex: number } {
  const pieces = tieablePieces(obj);
  let best: { point: Vec2; shapeIndex: number } | null = null;
  let bestSq = Infinity;
  for (const { shape, index } of pieces) {
    const candidates =
      shape.shape.kind === "circle"
        ? [nearestSurfacePoint(shape, world)]
        : ShapeGeometry.getGlobalCorners(shape);
    for (const c of candidates) {
      const d = c.sub(world).lengthSquared();
      if (d < bestSq) {
        bestSq = d;
        best = { point: c, shapeIndex: index };
      }
    }
  }
  return best ?? { point: world, shapeIndex: 0 };
}

// Build every chain in `data` (metres) against the bodies `buildLevelBodies`
// made. A chain naming an anchor that is not in the level, or one on a body that
// built nothing (decoration, a lone light), or the same body at both ends (which
// has nothing to constrain) is dropped rather than fed to a solver that has no
// meaning for it.
//
// Every chain is solved against the level's wrappable bodies (`wrapBodies`:
// the statics and the authored rigid bodies, areas and pass-through scenery
// excluded), which is the scene the ball's chain scans. It is the one list,
// shared by every chain rather than copied per chain, and it is the level's
// geometry and not the play space: the avatar, its hook and anything spawned
// in play are never in it.
export function buildSceneChains(data: LevelData, built: BuiltBodies): SceneChain[] {
  const anchors = collectAnchorSites(built);
  const chains: SceneChain[] = [];
  for (const c of data.chains ?? []) {
    const chain = buildOne(c, anchors, built.wrapBodies);
    if (chain) chains.push(chain);
  }
  return chains;
}

// Every anchor in the level, by id. A chain names its two ends and nothing else
// - which body an end is on is a question about where its anchor lives, and this
// is where that is answered once for the whole list rather than by scanning the
// bodies per chain. A vine names ONE end the same way, and reads the same map.
export function collectAnchorSites(built: BuiltBodies): Map<number, AnchorSite> {
  const anchors = new Map<number, AnchorSite>();
  for (const b of built.bodies) {
    for (const o of b.data.objects) {
      if (!isAnchorObject(o)) continue;
      // First id wins. Ids are unique by construction, and a file that has been
      // hand-edited into a collision gets the earlier anchor rather than a
      // silently-last-one-wins that depends on body order.
      if (!anchors.has(o.id)) anchors.set(o.id, { built: b, anchor: o });
    }
  }
  return anchors;
}

// An anchor and the body it is on, which is the pair every chain end resolves to.
export interface AnchorSite {
  readonly built: BuiltBodies["bodies"][number];
  readonly anchor: AnchorObjectData;
}

// Where the anchor IS, on the body as it stands now. The authored placement is
// written in the authored frame, and a sprung body spawns displaced from it
// (`applyRestPose`), so on a displaced body the material point is resolved
// through `localPlacement` - the authored-frame correspondence `BuiltBody`
// records - and then carried by the body's own transform, exactly as
// decoration and geometry objects ride it. Resolved through the authored
// placement instead, the anchor lands at the authored SPOT on a body that is
// no longer there, a point off the intended one by the whole droop.
//
// The undisplaced path keeps the plain `worldPlacement` answer deliberately:
// the local round trip costs two rotations of float noise, and every level
// with no sprung body must stay bit-identical.
export function anchorWorldPoint(site: AnchorSite): Vec2 {
  const b = site.built;
  const body = b.body;
  const authored = worldPlacement(b.data, site.anchor).pos;
  if (
    !body ||
    (body.globalPosition.x === b.origin.x &&
      body.globalPosition.y === b.origin.y &&
      body.globalRotation === b.rotation)
  ) {
    return authored;
  }
  const local = localPlacement(b, site.anchor);
  return body.globalPosition.add(local.pos.rotated(body.globalRotation));
}

function buildOne(
  c: ChainData,
  anchors: Map<number, AnchorSite>,
  scene: PhysicsBody2D[],
): SceneChain | null {
  const siteA = anchors.get(c.a);
  const siteB = anchors.get(c.b);
  if (!siteA || !siteB) return null;
  const objA = siteA.built.body;
  const objB = siteB.built.body;
  if (!objA || !objB || objA === objB) return null;
  // The anchor is placed in its BODY's frame, so its world point is the body's
  // transform applied to it - the same `worldPlacement` every other object goes
  // through. The surface snap that follows is unchanged: an anchor left in a
  // body's interior leaves the chain's span starting INSIDE that body, and the
  // wrap generator resolves that as a self-intersection.
  const tieA = tieToSurface(objA, anchorWorldPoint(siteA));
  const tieB = tieToSurface(objB, anchorWorldPoint(siteB));
  // The contact names the piece of the body it lands on, which is what the wrap
  // resolvers walk when the chain has to bend around it.
  const contact = (obj: CollisionObject2D, tie: { point: Vec2; shapeIndex: number }) =>
    new RopeContact(obj, tie.point.sub(obj.globalPosition), tie.shapeIndex);
  const start = contact(objA, tieA);
  const end = contact(objB, tieB);

  // The wrap points, in order from `a` to `b`. Each is an anchor on a body
  // that builds; one that is not there, or is on a body that does not build,
  // is skipped rather than dropping the chain - a chain with its two ends is
  // still a chain, as a vine with a dead second anchor is still a vine.
  const vias: { obj: PhysicsBody2D; tie: { point: Vec2; shapeIndex: number } }[] = [];
  for (const id of c.via ?? []) {
    const site = anchors.get(id);
    const obj = site?.built.body;
    // A wrap point is on a body a rope can bend around, which an area is not.
    if (!site || !(obj instanceof PhysicsBody2D)) continue;
    vias.push({ obj, tie: snapToCorner(obj, anchorWorldPoint(site)) });
  }
  // Consecutive wrap points on ONE piece are one wrap of it - a pulley an
  // author ringed with seven points is still a chain going over a pulley once
  // - and each run becomes the wrap nodes the scan would have left had the
  // chain been dragged over that piece (see `authoredWrap`). The run's
  // neighbours are the authored points either side of it.
  const runs: { obj: PhysicsBody2D; ties: { point: Vec2; shapeIndex: number }[] }[] = [];
  for (const v of vias) {
    const last = runs[runs.length - 1];
    if (last && last.obj === v.obj && last.ties[0]!.shapeIndex === v.tie.shapeIndex) {
      last.ties.push(v.tie);
    } else {
      runs.push({ obj: v.obj, ties: [v.tie] });
    }
  }
  const wraps: RopeWrap[] = [];
  runs.forEach((run, i) => {
    const prev = i === 0 ? tieA.point : runs[i - 1]!.ties[runs[i - 1]!.ties.length - 1]!.point;
    const next = i === runs.length - 1 ? tieB.point : runs[i + 1]!.ties[0]!.point;
    for (const w of authoredWrap(run.obj, run.ties, prev, next)) wraps.push(w);
  });
  // ...and its body is in the set this chain is solved against - the level's
  // wrappable bodies, which every solid body that builds is in - so the corner
  // is re-found as the bodies move and a sibling corner of the same body
  // catches the chain the way it would catch the ball's. A wrap point on a
  // body that is NOT in that set (pass-through scenery) is a node the scan
  // could never re-find; it is seeded all the same and culled the first time
  // the chain pulls straight past it, which is what a wrap on a body the rope
  // cannot hold means.

  // Absent length = exactly taut as authored, which is what dragging a chain out
  // between two bodies in the editor means - measured along the path as the
  // anchors and wrap points actually land, so "taut" is taut. A chain with no
  // wrap points measures the plain distance between its two world points, and
  // must: the rope's own measure reads the same two points back through their
  // bodies' frames, two rotations of float noise away, and every recording
  // that predates wrap points replays bit-for-bit against the direct one.
  const length =
    c.length ?? (wraps.length > 0 ? null : tieA.point.distanceTo(tieB.point));
  return new SceneChain(start, end, length, c.color ?? null, scene, wraps);
}
