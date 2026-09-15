// SlackChain — the VISUAL simulation of the ball chain while it hangs loose.
//
// The rope solver models the chain as straight spans between wrap nodes, which
// is exactly right for a taut chain and exactly wrong for a slack one: a metal
// chain with length to spare sags, drapes over ledges and heaps on the floor.
// This class is that drape. It is strictly one-way: it reads body transforms
// and the chain's wrap path, and writes nothing back — no forces, no impulses,
// no positions. Nothing the game measures (replays, invariants, the solver)
// can see it; deleting it changes pixels only.
//
// Model: a fixed-count Verlet particle chain pinned at both ends — the
// mounting loop the chain leaves the ball through (the chain's start contact)
// and the chain's far end (flying hook, dangling tip, or anchor). Equality
// distance constraints keep the polyline's total length at the chain's REAL
// length — the whole wrap path's length plus the slack the solver is not
// using — so the drawn chain neither stretches when hanging nor shortens when
// heaped (a heap folds, it does not shrink). Long-range attachments from both
// pins kill the sag-stretch a few Gauss-Seidel passes leave behind, which is
// what makes 1.8 m of cast iron read as inextensible.
//
// The coil is part of the drape, not a kinematic prefix to it. The solver's
// coil is the angle of rim between the loop and the TANGENT point toward the
// next node, which is the right reading of a chain under tension and a fiction
// for one with length to spare: a slack chain has nothing holding it against
// the rim, and it hangs from the loop and lies wherever gravity and the
// scenery put it. Pinned at the tangent point instead, the drape started a
// quarter turn round the ball from the loop and only the run beyond the
// tangent had the slack in it, so a ball that had rolled over its own chain
// drew the chain hugging its underside and climbing its far flank to leave
// cleanly toward the anchor, with the slack folded into the last span
// (`session-232f` f200-232). Hanging from the loop, the rim is scenery the
// drape collides with like any other, and the taut blend below carries the
// nodes onto the solver's coil exactly as the chain comes tight.
//
// Collision is one-way too: nodes are pushed out of every wrappable shape
// (the same set the rope solver may wrap, so the visual chain respects exactly
// the geometry the real one does), with dead restitution and strong tangential
// friction — iron links do not bounce, and they drag to a stop.
//
// The taut transition is the part that earns the class its keep. A chain with
// even a few millimetres of slack sags visibly (sag grows like the square root
// of slack), so a renderer that switched from "simulated drape" to "straight
// spans" the frame the solver went taut would show the chain snapping several
// centimetres in one frame. Instead the drawn chain is ALWAYS this polyline,
// and every node is held within a SAG BOUND of its arc-length position on the
// wrap path: the sag a chain with this much slack can hang with, which closes
// with the square root of the slack and is exactly zero at taut. The drawn
// shape is then a continuous function of the physics state - taut is the
// limit of almost-taut, and there is no frame on which the representation
// changes - and the bound is one a drape never meets on its own, so a chain
// with room to sag hangs by its own physics and is only ever gathered onto the
// path as the slack that let it sag is taken up.
//
// It was a per-step position lerp toward the path, weighted linearly over the
// last 10 cm of slack, and that is effectively a switch: a lerp of even a few
// percent per step moves a node centimetres against gravity's 2.7 mm, so the
// drape was flattened onto the path - and onto the coil's rim - a full 10 cm
// of slack early, read as the chain clinging to the ball's flank while the
// solver still reported 8 cm of slack (`session-232f` f216-232).

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { GRAVITY } from "../engine/world";
import { shapeExtents } from "../engine/shapes";
import { circleOverlapFrom } from "../engine/collision";
import type { CollisionObject2D, CollisionShape2D, PhysicsBody2D } from "../engine/body";
import { ringEnd } from "../lib/vineClamp";
import { chainEndFacing, MANACLE_REACH } from "../lib/manacle";
import { Rope } from "./rope";

// Fixed particle count. Fixed rather than derived from the chain's length so
// the node array never resamples (a resample is a pop), and the rest spacing
// simply scales with the deployed length. 64 segments put a node every 2.8 cm
// on a fully deployed 1.8 m chain — under one drawn link, so the polyline is
// never the resolution bottleneck.
const SEGMENTS = 64;
// Half the broad link's width: the chain's physical half-thickness, which is
// the radius each node keeps clear of geometry. A chain lying on the floor
// then rests ON the floor, and one bent over a corner clears it by exactly a
// link's half-width, which is where a real chain's centreline sits.
const NODE_RADIUS = 0.9 * PX;
// Per-frame velocity retention. Iron is heavy and air is not what stops it —
// contact friction is — so the drag here is a whisper, just enough to bleed
// the numerical hum out of a hanging catenary.
const DAMPING = 0.995;
// Fraction of a node's tangential motion removed per contact resolution.
// Metal on stone drags hard; this is what lets a thrown chain heap and stay
// heaped instead of creeping downhill forever.
const FRICTION = 0.7;
// Static friction, in position. Velocity friction alone cannot stop a chain
// on a slope, for the reason the engine's position pin exists: the verlet step
// takes gravity's displacement BEFORE anything resists it, the collision
// push-out resolves it along the normal, and the tangential remainder
// (~2.7 mm × sinθ per frame) is position creep no velocity term ever sees — a
// drape on a 30° ramp slid at ~8 cm/s while reporting almost no velocity. So
// a contacting node whose tangential travel THIS STEP is under this bound has
// the whole of it removed (and the tangential velocity with it): resting chain
// sticks, and a genuinely hauled or flung one — many millimetres a step —
// slides with only the velocity friction dragging on it.
const STICK_STEP = 0.25 * PX; // 2.5 mm per step ≈ 0.15 m/s
// Gauss-Seidel passes per step. The pinned ends propagate one node per pass,
// so this must comfortably exceed nothing — it is paired with the long-range
// attachments below, which enforce the global statement the local passes
// converge toward.
const ITERATIONS = 16;
// Constraint iterations between collision resolutions (the final iteration
// always collides last, so the frame ends clear of the scenery).
const COLLIDE_EVERY = 4;
// How far a node may stray from its arc-length position on the wrap path, as
// a multiple of sqrt(path length x slack). A shallow chain with slack s over a
// span L hangs with a sag of sqrt(3·L·s/8), 0.61 of that root, so at 1 the
// bound stands clear of an honest drape - a heap on the floor included, whose
// folds stand well inside it at any slack a heap needs - and only shapes the
// chain as the slack runs out. See the header: this is the no-teleport
// mechanism. The last millimetre of slack closes the last two centimetres of
// sag, which is the square root's own slope and what a chain coming tight does.
const SAG_BOUND_FACTOR = 1;
// Passes a node is given over the shapes near it to end a collision step
// clear of all of them (see solveCollisions). Two settles a seam; the third
// is headroom.
const SEAM_ROUNDS = 3;
// A node may not move faster than this, metres per step. Purely a safety
// fence around the Verlet integration — the hook itself flies at 12 m/s, i.e.
// 0.2 m per step, an order of magnitude inside it.
const MAX_STEP = 0.5;
// How fast a let-go chain is reeled back in through the loop (see
// `beginReel`): fast at first and slowing as the chain shortens, the speed
// being REEL_RATE times the chain still out, in metres per second per metre,
// and never under REEL_SPEED_MIN so the last of it (and the swallow past the
// loop) still comes in rather than creeping. The feel knobs: at 5 /s a full
// 1.8 m starts at 9 m/s, is half in after 0.14 s, and reaches the floor with
// 0.4 m to go.
export const REEL_RATE = 8;
export const REEL_SPEED_MIN = 4;
// Constraint passes per reel step. More than the drape's, because the reel
// has no long-range attachment (see `stepReel`): the haul at the loop reaches
// the far end only by propagating node to node, and alternating sweeps carry
// it the whole way in a pair of passes, so this many pairs leave nothing
// visible of the stretch. The reel runs for a quarter of a second, so the
// extra passes cost nothing that matters.
const REEL_ITERATIONS = 32;
// The cuff's share of a constraint correction against a link's, as an
// inverse mass: the cuff on the end is heavier than a link of chain, so when
// the chain comes tight between them it is the chain that is pulled straight
// and the cuff that lags and swings. A visual weight rather than the sim's
// (the chain has no mass in the sim at all); small enough to read, large
// enough that the passes above still close the last segment.
const CUFF_WEIGHT = 0.2;
// How much of the follow pass's correction is paid back as momentum to the
// node ahead (Müller's s_damping, see `reelFollow`): 1 conserves it whole, 0
// is plain follow-the-leader. The paper's own working value.
const FOLLOW_DAMPING = 0.9;

// A shape the drape may touch this step, with everything the per-node test
// reads about it taken ONCE. The narrowphase runs nodes × seam rounds ×
// collision passes times over this list (63 × 3 × 4 = 756 visits a shape a
// step), and taking a shape's extents and world centre on every visit was the
// whole cost of the drape: 0.75 of the 0.88 ms a step it took on session-417f,
// nearly all of it in `shapeExtents` and `globalPosition` for shapes the box
// test then rejected. Nothing here can change during a step - the drape moves
// only its own nodes - so it is read at the top and the visits are four
// comparisons on numbers.
interface Candidate {
  readonly shape: CollisionShape2D;
  readonly owner: CollisionObject2D;
  // World centre and axis-aligned half-extents, already grown by the node
  // radius: a node whose centre is outside this box cannot touch the shape.
  readonly cx: number;
  readonly cy: number;
  readonly ex: number;
  readonly ey: number;
  // Whether the owner moved this frame (its captured frame-start pose differs
  // from its current one). A body that did not move carries a point nowhere,
  // and `carried` / `was` are the identity for it - skipped rather than
  // computed, which is most of the scenery on every frame.
  readonly moving: boolean;
  // Owned by the body the manacle is cuffed to (see the cuff note in `step`).
  readonly cuffed: boolean;
}

export class SlackChain {
  // Wall-clock budget for one step, milliseconds. The drape is visual only,
  // so it is the one simulation in the game allowed to do LESS work when the
  // machine is behind: its step is Gauss-Seidel blocks (constraint passes
  // then a collision pass), and once a block ends past the budget the rest
  // are skipped. Every step runs at least one block, so the frame still ends
  // clear of the scenery; what a cut step loses is convergence - a little
  // stretch in a drape that is being flung about - and the next step takes it
  // up. Infinite by default, which is what the tools want (`cli render`,
  // `cli shot`, the self-replay verdict): a drawn drape that depends on how
  // fast the machine was is not a reference frame. The live page sets it
  // (see main.ts). Measured on session-417f under a 4x CPU throttle, a step
  // that ran to 14 ms with the drape uncapped is the difference between
  // 144 Hz and 27 Hz on the frame the ball hangs off the lamp.
  static timeBudgetMs = Infinity;

  // Node 0 is pinned where the chain leaves the ball; the last node is pinned
  // at the chain's far end. `prev` is the Verlet history (pos − velocity·dt);
  // `renderFrom` is where each node ENDED the previous step, which is what the
  // renderer interpolates from — the two differ the moment a constraint or a
  // collision moves a node.
  private pos: Vec2[] = [];
  private prev: Vec2[] = [];
  private renderFrom: Vec2[] = [];
  // The chain's length as of the last step - the wrap path plus the slack -
  // which is what a reel starts from.
  private length = 0;
  // Reeling in after a release (see `beginReel`): the chain still out, in
  // metres, going negative once the end has passed the loop and is being
  // swallowed toward the ball's centre. Null while the chain is deployed.
  private reel: number | null = null;
  // A full segment's rest length while reeling, fixed at the release: the
  // chain is consumed at the loop, segment by segment (`reelRestOf`), rather
  // than shrunk all over.
  private reelRest = 0;
  // Whether the last node is held at the chain's far end. True for a deployed
  // chain - the end is the hook, the tip or the anchor - and false once it
  // is let go: from then on the end is free and is hauled in by the chain.
  private endPinned = true;

  // The far-end body the chain was deployed with — the hook, later the
  // dangling tip. The visual chain threads INTO it (the manacle is drawn over
  // the join), so it is the one solid thing the nodes must not collide with.
  // An anchor on scene geometry is a different body and is not excluded: a
  // chain anchored to a wall drapes against that wall.
  private readonly tipBody: PhysicsBody2D;

  constructor(private readonly chain: Rope) {
    this.tipBody = chain.end.contact.obj as PhysicsBody2D;
  }

  // Sample `points` (a polyline) at `count`+1 arc-length fractions. Degenerate
  // polylines (all points coincident) collapse to the first point.
  private static sampleByArc(points: readonly Vec2[], count: number): Vec2[] {
    const at: number[] = [0];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += points[i - 1]!.distanceTo(points[i]!);
      at.push(total);
    }
    const out: Vec2[] = [];
    if (total < 1e-9) {
      for (let i = 0; i <= count; i++) out.push(points[0]!);
      return out;
    }
    let seg = 0;
    for (let i = 0; i <= count; i++) {
      const s = (total * i) / count;
      while (seg < points.length - 2 && at[seg + 1]! < s) seg++;
      const span = at[seg + 1]! - at[seg]!;
      const t = span > 1e-9 ? (s - at[seg]!) / span : 0;
      out.push(points[seg]!.lerp(points[seg + 1]!, t));
    }
    return out;
  }

  // One fixed step. Reads the frame's FINAL body transforms (call it at the
  // end of the physics frame) and moves only this class's own nodes.
  step(bodies: readonly PhysicsBody2D[], delta: number): void {
    // The wrap path, loop → far end: the start contact, every wrap (the coil's
    // rim samples included), and the end.
    const pathPoints = this.chain.path().map((n) => n.contact.globalPosition);
    // Clamped around a rail the chain ends at the centre of a ring, but it is
    // hooked over the ring's RIM, and that is where it hangs from: the drape
    // is pinned there (`RopeClamp.rimPoint`), so its last link leaves the end
    // of the ring the pull runs over rather than being re-pointed at draw time
    // from a node that was pinned inside the cuff. Re-pointed, the first link
    // ran from the rim back toward a node a bore's radius from the centre and
    // flickered with it (`session-407f`).
    // A ring on a vine hangs the drape from its rim the same way.
    const end = this.chain.end;
    const clamp = ringEnd(end);
    if (clamp !== null) pathPoints[pathPoints.length - 1] = clamp.rimPoint();

    if (this.pos.length !== SEGMENTS + 1) {
      // First step: lay the chain along the wrap path it is deployed on, at
      // rest relative to the world. During the deploy that path is straight
      // and taut, so this is exact.
      this.pos = SlackChain.sampleByArc(pathPoints, SEGMENTS);
      this.prev = this.pos.slice();
      this.renderFrom = this.pos.slice();
    }

    // The wrap path's length as the polyline through its nodes. The coil's
    // samples chord its arc (a quarter of a radian apiece, 0.3% short of the
    // arc); the solver measures the arc itself, and the difference is well
    // under a link on a chain wound several turns.
    let pathLen = 0;
    for (let i = 1; i < pathPoints.length; i++) {
      pathLen += pathPoints[i - 1]!.distanceTo(pathPoints[i]!);
    }
    // Slack the solver is not using. The wrap path can run OVER the chain's
    // length (the blocked-length lease), which is simply zero slack here.
    const slack = Math.max(0, this.chain.maxRopeLength - this.chain.getCurrentLength());
    const targetLen = pathLen + slack;
    const restLen = targetLen / SEGMENTS;
    this.length = targetLen;

    const pinA = pathPoints[0]!;
    const pinB = pathPoints[pathPoints.length - 1]!;

    // Verlet integrate the interior; re-pin the ends to this frame's contacts.
    const gravityStep = GRAVITY.mul(delta * delta);
    for (let i = 0; i <= SEGMENTS; i++) {
      this.renderFrom[i] = this.pos[i]!;
      if (i === 0 || i === SEGMENTS) continue;
      let vel = this.pos[i]!.sub(this.prev[i]!).mul(DAMPING);
      const speed = vel.length();
      if (speed > MAX_STEP) vel = vel.mul(MAX_STEP / speed);
      const next = this.pos[i]!.add(vel).add(gravityStep);
      this.prev[i] = this.pos[i]!;
      this.pos[i] = next;
    }
    this.prev[0] = this.pos[0]!;
    this.pos[0] = pinA;
    this.prev[SEGMENTS] = this.pos[SEGMENTS]!;
    this.pos[SEGMENTS] = pinB;

    // The sag bound: every node held within reach of its arc-length position
    // on the wrap path, the reach closing with the slack and gone at taut.
    // This is the no-teleport guarantee - see the header - and it is also
    // what winds the drape onto the coil: the solver's rim samples are part of
    // the path, so a chain coming tight on a wound ball is drawn round the rim
    // exactly where the solver says the coil is.
    if (pathLen > 1e-9) {
      const bound = SAG_BOUND_FACTOR * Math.sqrt(pathLen * slack);
      const target = SlackChain.sampleByArc(pathPoints, SEGMENTS);
      for (let i = 1; i < SEGMENTS; i++) {
        const off = this.pos[i]!.sub(target[i]!);
        const dist = off.length();
        if (dist <= bound) continue;
        this.pos[i] = bound > 0 ? target[i]!.add(off.mul(bound / dist)) : target[i]!;
      }
    }

    // Clamped around a rail the chain ends at the centre of a ring threaded on
    // the bar, millimetres from the bar's own surface, and the chain leaves
    // the ring at its rim: the nodes inside the cuff's disc are metal the bar
    // is already threaded through, not chain to be pushed out of it. Pushed,
    // the last few nodes were shoved off the handle every step and the drape
    // twitched at the cuff for as long as the ball hung still (`session-291f`).
    // A ring on a vine has no such body: the vine is not scenery the drape
    // collides with at all (see `collectCandidates`).
    const cuff = clamp !== null ? { body: clamp.contact.obj, at: clamp.contact.globalPosition } : null;
    const candidates = this.collectCandidates(bodies, cuff?.body ?? null);
    // Blocks of COLLIDE_EVERY constraint passes, each ended by a collision
    // pass, so the last thing a step does is push the nodes clear. The budget
    // is checked between blocks (see `timeBudgetMs`); the clock is only read
    // when there is a budget to hold, so a tool's run is the same arithmetic
    // whatever the machine.
    const budget = SlackChain.timeBudgetMs;
    const timed = Number.isFinite(budget);
    const started = timed ? performance.now() : 0;
    const blocks = ITERATIONS / COLLIDE_EVERY;
    for (let block = 0; block < blocks; block++) {
      for (let k = 0; k < COLLIDE_EVERY; k++) {
        const iter = block * COLLIDE_EVERY + k;
        this.solveDistances(restLen, iter % 2 === 1);
        this.solveLongRange(restLen, pinA, pinB);
      }
      this.solveCollisions(candidates, cuff);
      if (timed && performance.now() - started > budget) break;
    }
  }

  // Every wrappable shape of every SOLID body near the chain this step. Both
  // halves are the rope's own notion of what a chain may touch: `wrappable`
  // excludes the mounting loop the chain threads through, and a non-solid body
  // (`isPassThrough` in Rope) excludes vine links and hook-only grates — the
  // real chain never wraps either, so the drape resting on one would be a
  // drawing of a collision the level does not contain. The far end's own body
  // (hook / dangling tip) is skipped: the chain threads into it. The AABB gate
  // keeps the per-node narrowphase to the shapes that could possibly matter,
  // and each survivor is read once into a `Candidate` (see there).
  private collectCandidates(
    bodies: readonly PhysicsBody2D[],
    cuffBody: CollisionObject2D | null,
  ): Candidate[] {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of this.pos) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const margin = NODE_RADIUS + MAX_STEP;
    const out: Candidate[] = [];
    for (const body of bodies) {
      if (body.removed || !body.isSolid || body === this.tipBody) continue;
      let moving: boolean | null = null;
      for (const s of body.getShapes()) {
        if (!s.wrappable) continue;
        const c = s.globalPosition;
        const e = shapeExtents(s);
        if (
          c.x + e.x < minX - margin ||
          c.x - e.x > maxX + margin ||
          c.y + e.y < minY - margin ||
          c.y - e.y > maxY + margin
        ) {
          continue;
        }
        if (moving === null) {
          const from = body.renderPosition(0);
          const now = body.globalPosition;
          moving =
            from.x !== now.x || from.y !== now.y || body.renderRotation(0) !== body.globalRotation;
        }
        out.push({
          shape: s,
          owner: body,
          cx: c.x,
          cy: c.y,
          ex: e.x + NODE_RADIUS,
          ey: e.y + NODE_RADIUS,
          moving,
          cuffed: body === cuffBody,
        });
      }
    }
    return out;
  }

  // One equality-constraint pass over the segments. Alternating the sweep
  // direction between passes symmetrises convergence between the two pins.
  //
  // Compression needs a second term. A chain shorter than its rest length must
  // BUCKLE — fold out of line, the way real chain heaps — but the distance
  // correction acts purely along the segment, so a run of collinear compressed
  // nodes (a chain pressed flat on the floor between its pins) has no lateral
  // gradient at all and Gauss-Seidel leaves it compressed for ever: the drawn
  // chain simply loses the length. So a segment compressed past a few percent
  // is also nudged perpendicular, alternating sides by node index, which gives
  // the fold a direction to grow in; the verlet step, gravity and the floor
  // then settle it into an honest pile.
  //
  // Reeling, each segment has its own rest (`reelRestOf`) and the cuff on
  // the end takes the smaller share of its segment's correction
  // (`CUFF_WEIGHT`). A deployed chain goes through neither branch.
  private solveDistances(restLen: number, reversed: boolean): void {
    const reeling = this.reel !== null;
    for (let k = 0; k < SEGMENTS; k++) {
      const j = reversed ? SEGMENTS - 1 - k : k;
      const rest = reeling ? this.reelRestOf(j) : restLen;
      const a = this.pos[j]!;
      const b = this.pos[j + 1]!;
      const d = b.sub(a);
      const len = d.length();
      if (len < 1e-9) continue;
      const err = (len - rest) / len;
      const aPinned = j === 0;
      const bPinned = this.endPinned && j + 1 === SEGMENTS;
      if (aPinned && bPinned) continue;
      let corr = d.mul(err);
      // No buckling kick while reeling: nothing pushes a hauled chain, and a
      // segment shorter than its rest there is the run behind a node the
      // haul has just lifted, still sliding on its own momentum - which the
      // kick folded into a tangle under the loop rather than letting the
      // along-segment correction straighten it (`reelFollow` takes the
      // momentum itself).
      if (!reeling && len < rest * 0.95) {
        const kick = (rest - len) * 0.5 * (j % 2 === 0 ? 1 : -1);
        corr = corr.add(d.div(len).orthogonal().mul(kick));
      }
      if (aPinned) {
        this.pos[j + 1] = b.sub(corr);
      } else if (bPinned) {
        this.pos[j] = a.add(corr);
      } else if (reeling && j + 1 === SEGMENTS) {
        this.pos[j] = a.add(corr.mul(1 / (1 + CUFF_WEIGHT)));
        this.pos[j + 1] = b.sub(corr.mul(CUFF_WEIGHT / (1 + CUFF_WEIGHT)));
      } else {
        const half = corr.mul(0.5);
        this.pos[j] = a.add(half);
        this.pos[j + 1] = b.sub(half);
      }
    }
  }

  // Long-range attachment: node i can be at most i·restLen of chain from pin
  // A, and (SEGMENTS−i)·restLen from pin B. A hanging chain violates this
  // slightly for many passes of the local solver (each pass moves the error
  // one node); clamping against the pins directly removes the visible
  // sag-stretch in one statement.
  //
  // A reeling chain (`endPinned` false) has no pin B: its end is one more
  // free node, held only by the chain running back to the loop.
  private solveLongRange(restLen: number, pinA: Vec2, pinB: Vec2): void {
    const last = this.endPinned ? SEGMENTS - 1 : SEGMENTS;
    for (let i = 1; i <= last; i++) {
      const maxA = i * restLen;
      const fromA = this.pos[i]!.sub(pinA);
      const dA = fromA.length();
      if (dA > maxA) this.pos[i] = pinA.add(fromA.mul(maxA / dA));
      if (!this.endPinned) continue;
      const maxB = (SEGMENTS - i) * restLen;
      const fromB = this.pos[i]!.sub(pinB);
      const dB = fromB.length();
      if (dB > maxB) this.pos[i] = pinB.add(fromB.mul(maxB / dB));
    }
  }

  // Push every interior node out of the scenery. Dead normal restitution and
  // Coulomb-ish tangential friction, both written through the Verlet history,
  // and both measured RELATIVE TO THE SURFACE: a node resting on a body that
  // moves rides it. Measured in world space instead, the static stick held a
  // node still while the lantern it lay on swung out from under it at
  // 2.5 cm a frame, and the node dropped through the gap between the handle
  // and the glass into the lamp's interior (`session-1038f` f858-862, the
  // slack chain falling through the lamp); the same held a drape still on any
  // swinging platform it was heaped on.
  private solveCollisions(
    candidates: readonly Candidate[],
    cuff: { body: CollisionObject2D; at: Vec2 } | null,
  ): void {
    // A reeling chain's free end collides like any other node.
    const last = this.endPinned ? SEGMENTS - 1 : SEGMENTS;
    for (let i = 1; i <= last; i++) {
      let p = this.pos[i]!;
      // Repeated until the node ends clear of every shape. A compound body's
      // pieces overlap at their seams (the lantern's handle-top piece stands
      // inside its glass), so a push out of one piece can land inside the
      // next, and a node left inside at the end of a step starts the next one
      // with no side to have come from.
      for (let round = 0; round < SEAM_ROUNDS; round++) {
        let hit = false;
        for (const c of candidates) {
          if (Math.abs(p.x - c.cx) > c.ex || Math.abs(p.y - c.cy) > c.ey) continue;
          if (c.cuffed && cuff !== null && p.distanceTo(cuff.at) < MANACLE_REACH) continue;
          // Where the node started the step, carried along with the body it
          // is being tested against: which side of a face it came from is a
          // question in the body's own frame. Ejected through the shallowest
          // face instead, a node the constraints had dragged from the top of
          // the lantern's chimney down past its middle left by the SIDE, and
          // the chain it was part of then cut straight through the glass,
          // its two neighbours held 11 cm apart on opposite faces by the
          // push-out (`session-1038f` f858-862).
          const from = c.moving
            ? SlackChain.carried(c.owner, this.renderFrom[i]!)
            : this.renderFrom[i]!;
          const ov = circleOverlapFrom(p, NODE_RADIUS, c.shape, from);
          if (!ov) continue;
          hit = true;
          p = p.add(ov.normal.mul(ov.depth));
          // How far the surface under the node moved this step: the body's
          // frame-start pose is its captured render transform (taken at the
          // top of the frame, before anything moved), so the point's motion
          // is exact for the frame rather than a velocity times dt. Zero for
          // a body that did not move, without asking it.
          const surfaceStep = c.moving ? p.sub(SlackChain.was(c.owner, p)) : Vec2.ZERO;
          // Static friction first: a contacting node that has only crept this
          // step, against the surface, is put back where the surface carried
          // it (see STICK_STEP).
          const step = p.sub(this.renderFrom[i]!).sub(surfaceStep);
          const st = step.sub(ov.normal.mul(step.dot(ov.normal)));
          if (st.length() < STICK_STEP) p = p.sub(st);
          const rel = p.sub(this.prev[i]!).sub(surfaceStep);
          const vn = ov.normal.mul(rel.dot(ov.normal));
          const vt = rel.sub(vn);
          this.prev[i] = p.sub(surfaceStep.add(vt.mul(1 - FRICTION)));
        }
        if (!hit) break;
      }
      this.pos[i] = p;
    }
  }

  // Where a world point riding `body` was at the start of the frame, and
  // where a point that rode it from the start of the frame is now - the
  // body's frame-start pose is its captured render transform, taken at the
  // top of the frame before anything moved, so both are exact for the frame
  // rather than a velocity times dt.
  private static was(body: CollisionObject2D, p: Vec2): Vec2 {
    const prevPos = body.renderPosition(0);
    const prevRot = body.renderRotation(0);
    return prevPos.add(p.sub(body.globalPosition).rotated(prevRot - body.globalRotation));
  }

  private static carried(body: CollisionObject2D, q: Vec2): Vec2 {
    const prevPos = body.renderPosition(0);
    const prevRot = body.renderRotation(0);
    return body.globalPosition.add(q.sub(prevPos).rotated(body.globalRotation - prevRot));
  }

  // The full drawn polyline, loop → anchor: the simulated drape, its two ends
  // re-welded to their contacts' render transforms so the chain never visibly
  // detaches from the ball or the manacle between physics steps; the interior
  // interpolates the sim.
  pathLoopToAnchor(alpha: number): Vec2[] {
    const chain = this.chain;
    if (this.pos.length !== SEGMENTS + 1) {
      // Not stepped yet — fall back to the straight spans.
      return chain.path().map((n) => n.contact.renderGlobalPosition(alpha));
    }
    const out: Vec2[] = [chain.start.contact.renderGlobalPosition(alpha)];
    for (let i = 1; i < SEGMENTS; i++) {
      out.push(this.renderFrom[i]!.lerp(this.pos[i]!, alpha));
    }
    const end = chain.end;
    const ring = ringEnd(end);
    out.push(ring !== null ? ring.renderRimPoint(alpha) : end.contact.renderGlobalPosition(alpha));
    return out;
  }

  // ---- Reeling in after a release -----------------------------------------
  //
  // Letting go of the chain is instantaneous in the sim (`releaseChain`), and
  // the picture of it is this drape carrying on: the same nodes, exactly
  // where the deployed chain left them, with the far end unpinned and the
  // rest length shrinking at `REEL_RATE` - so the chain is hauled back in
  // through the loop under its own gravity, friction and collisions, and
  // there is no frame on which it changes shape for any reason but the reel.
  // Owned from here by the render side (`render/chainRetract.ts`), which
  // steps it each fixed step as `BallLevel` stepped the deployed drape.

  // Begin reeling. False if the drape was never stepped (nothing is laid to
  // reel), in which case the chain simply vanishes as it always did.
  beginReel(): boolean {
    if (this.pos.length !== SEGMENTS + 1) return false;
    this.reel = this.length;
    this.reelRest = this.length / SEGMENTS;
    this.endPinned = false;
    return true;
  }

  // One fixed step of the reel, called where `step` was: after the physics
  // frame, against its final transforms. False once the whole chain is in.
  //
  // The chain is consumed AT THE LOOP, as a winch consumes it: the segment
  // nearest the loop is the one whose rest length shrinks, and the next only
  // once it is gone (`reelRestOf`), while every segment beyond keeps the
  // length it had. So the haul is felt first by the run nearest the ball and
  // reaches the far end only through the chain - slack is taken up before the
  // cuff moves at all, a chain wrapped round a corner is drawn back round
  // it, and the cuff whips round after it. Shrinking every segment at once
  // was tried first, with the drape's long-range attachment holding each
  // node within its chain-length of the loop, and that is a chain whose end
  // is pulled straight at the ball through whatever it was wrapped on, at
  // the reel speed from the first frame, slack or not. Neither the sag bound
  // nor the long-range attachment applies here for the same reason: both
  // hold nodes to where a chain would be, and the reel is the chain going
  // where it is pulled.
  //
  // Consumed segments collapse onto the loop rather than being dropped, so
  // the node arrays never resample (a resample is a pop, see SEGMENTS);
  // `walkChain` skips the coincident points. Past zero the reel goes on for
  // the depth of the ball, and `reelPath` draws the end sliding under the
  // ball to its centre with the cuff trailing it in, so the cuff leaves the
  // picture under the ball rather than popping out of it at the rim.
  stepReel(bodies: readonly PhysicsBody2D[], delta: number): boolean {
    if (this.reel === null) return false;
    const start = this.chain.start.contact;
    const loop = start.globalPosition;
    const centre = start.obj.globalPosition;
    this.reel -= Math.max(REEL_SPEED_MIN, REEL_RATE * this.reel) * delta;
    if (this.reel <= -loop.distanceTo(centre)) {
      this.reel = null;
      return false;
    }

    // Verlet integrate everything but the loop node, the end included; re-pin
    // the loop to where the ball has it this frame.
    const gravityStep = GRAVITY.mul(delta * delta);
    for (let i = 0; i <= SEGMENTS; i++) {
      this.renderFrom[i] = this.pos[i]!;
      if (i === 0) continue;
      let vel = this.pos[i]!.sub(this.prev[i]!).mul(DAMPING);
      const speed = vel.length();
      if (speed > MAX_STEP) vel = vel.mul(MAX_STEP / speed);
      const next = this.pos[i]!.add(vel).add(gravityStep);
      this.prev[i] = this.pos[i]!;
      this.pos[i] = next;
    }
    this.prev[0] = this.pos[0]!;
    this.pos[0] = loop;

    // The blocks `step` runs, under the same budget, with more passes and no
    // long-range attachment (see above); no cuff, since the end is free.
    const candidates = this.collectCandidates(bodies, null);
    const budget = SlackChain.timeBudgetMs;
    const timed = Number.isFinite(budget);
    const started = timed ? performance.now() : 0;
    const blocks = REEL_ITERATIONS / COLLIDE_EVERY;
    for (let block = 0; block < blocks; block++) {
      for (let k = 0; k < COLLIDE_EVERY; k++) {
        const iter = block * COLLIDE_EVERY + k;
        this.solveDistances(this.reelRest, iter % 2 === 1);
      }
      this.reelFollow();
      this.solveCollisions(candidates, null);
      if (timed && performance.now() - started > budget) break;
    }
    // Chain that is in rides the loop. A node the reel has consumed (every
    // segment before it at zero rest) arrives carrying the haul's own speed,
    // and left with it, it overshoots through the loop next step, is pushed
    // back out of the ball and buckles against the node behind it - a heap of
    // links growing on the loop as the chain came in. Its momentum went into
    // the ball; here that is a node with no motion of its own.
    for (let j = 1; j <= SEGMENTS; j++) {
      if (this.reelRestOf(j - 1) > 0) break;
      this.prev[j] = this.pos[j]!;
    }
    return true;
  }

  // Follow the leader (Müller et al. 2012, the textbook for a chain that is
  // inextensible from a pinned end): from the loop out, every node is put
  // within its segment's rest of the node before it, moving only itself. One
  // sweep carries the haul at the loop to the far end WHOLE, which the
  // symmetric passes cannot do: each of those moves the error one node, so
  // on their own a 13 cm haul a step stretched the run nearest the ball while
  // the far end sat still, and the chain then vanished all at once when the
  // count ran out (reported as "retracts slowly for a few frames then
  // disappears"). The symmetric passes still run first for the chain's
  // shape; this pass is the statement that it cannot be longer than it is.
  //
  // With the paper's momentum correction (its DFTL): pulling a node in is a
  // pull on the node ahead of it too, so the node ahead is given the reaction
  // to the correction its follower took, scaled by `FOLLOW_DAMPING`. Without
  // it the follow pass conjures momentum from nothing - every node it moves
  // keeps the move as velocity and none of that is paid for - and the run of
  // chain still on the floor overran the node the haul had lifted off it and
  // folded under the loop.
  //
  // AND WITH THE SLACK TAKEN UP FIRST. Plain follow-the-leader moves a node
  // along its own segment by whatever its leader moved, so a slack chain
  // slides along its own path like a train on rails - every bend kept, the
  // cuff moving from the first frame - when a hauled chain straightens its
  // bends first and moves its end only once it has to. So a node that is
  // out of reach of its leader is first looked for INSIDE THE REACH OF BOTH
  // ITS NEIGHBOURS: while the chain is bent there the two discs overlap and
  // the node is put at the nearest point of the overlap, absorbing the pull
  // by straightening and passing nothing on. Only when they no longer
  // overlap - the chain through it already straight - is it carried along
  // its segment as the paper has it, and the pull goes on to the next node.
  // The cuff is last and has no follower, so it is carried only when every
  // bend before it has been pulled out.
  private reelFollow(): void {
    for (let j = 0; j < SEGMENTS; j++) {
      const rest = this.reelRestOf(j);
      const a = this.pos[j]!;
      const b = this.pos[j + 1]!;
      const d = b.sub(a);
      const len = d.length();
      if (len <= rest) continue;
      let to: Vec2 | null = null;
      if (j + 1 < SEGMENTS) {
        to = SlackChain.nearestWithin(b, a, rest, this.pos[j + 2]!, this.reelRestOf(j + 1));
      }
      if (to === null) to = rest > 0 && len > 1e-9 ? a.add(d.mul(rest / len)) : a;
      this.pos[j + 1] = to;
      if (j === 0) continue;
      // v_j -= s * correction_{j+1}, written into the Verlet history.
      this.prev[j] = this.prev[j]!.add(to.sub(b).mul(FOLLOW_DAMPING));
    }
  }

  // The point nearest `p` that is within `ra` of `a` and within `rc` of `c`,
  // or null when no such point exists (the two discs do not meet). The
  // candidates are `p` itself, its projection onto either circle, and the
  // two points where the circles cross; the nearest admissible one wins.
  private static nearestWithin(p: Vec2, a: Vec2, ra: number, c: Vec2, rc: number): Vec2 | null {
    const inA = (q: Vec2): boolean => q.distanceTo(a) <= ra + 1e-9;
    const inC = (q: Vec2): boolean => q.distanceTo(c) <= rc + 1e-9;
    if (inA(p) && inC(p)) return p;
    let best: Vec2 | null = null;
    let bestD = Infinity;
    const offer = (q: Vec2): void => {
      if (!inA(q) || !inC(q)) return;
      const dist = q.distanceTo(p);
      if (dist < bestD) {
        bestD = dist;
        best = q;
      }
    };
    const onA = p.distanceTo(a) > 1e-9 ? a.add(a.directionTo(p).mul(ra)) : a;
    const onC = p.distanceTo(c) > 1e-9 ? c.add(c.directionTo(p).mul(rc)) : c;
    offer(onA);
    offer(onC);
    const dist = a.distanceTo(c);
    if (dist > 1e-9 && dist <= ra + rc) {
      const x = (dist * dist - rc * rc + ra * ra) / (2 * dist);
      const h2 = ra * ra - x * x;
      if (h2 >= 0) {
        const h = Math.sqrt(h2);
        const ex = a.directionTo(c);
        const ey = ex.orthogonal();
        const mid = a.add(ex.mul(x));
        offer(mid.add(ey.mul(h)));
        offer(mid.sub(ey.mul(h)));
      }
    }
    return best;
  }

  // The rest length of segment `j` (0 nearest the loop) while reeling: a
  // full segment for every one the chain still out covers counting from the
  // far end, the remainder for the one being consumed, and nothing for the
  // ones already in. They sum to the chain still out.
  private reelRestOf(j: number): number {
    const out = this.reel! - (SEGMENTS - 1 - j) * this.reelRest;
    return Math.min(this.reelRest, Math.max(0, out));
  }

  // The reeling chain as drawn: its polyline loop → end (the end being the
  // cuff's hinge), and the way the cuff faces there - back along the chain,
  // as a free cuff hangs (`chainEndFacing`), and straight into the ball once
  // it is being swallowed. Null while the chain is deployed or gone.
  reelPath(alpha: number): { path: Vec2[]; dir: Vec2 } | null {
    if (this.reel === null) return null;
    const start = this.chain.start.contact;
    const loop = start.renderGlobalPosition(alpha);
    const centre = start.obj.renderPosition(alpha);
    const inward = loop.distanceTo(centre) > 1e-9 ? loop.directionTo(centre) : Vec2.DOWN;
    if (this.reel <= 0) {
      const depth = Math.min(-this.reel, loop.distanceTo(centre));
      return { path: [loop, loop.add(inward.mul(depth))], dir: inward };
    }
    const path: Vec2[] = [loop];
    for (let i = 1; i <= SEGMENTS; i++) path.push(this.renderFrom[i]!.lerp(this.pos[i]!, alpha));
    return { path, dir: chainEndFacing(path, inward) };
  }

  // Step-time node positions, for the CLI's SVG frames and debug tooling.
  nodePositions(): readonly Vec2[] {
    return this.pos;
  }
}
