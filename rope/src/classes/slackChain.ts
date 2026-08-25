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
// Model: a fixed-count Verlet particle chain pinned at both ends — the point
// the chain leaves the ball (the coil's tangent point, or the start contact
// when nothing is wound on) and the chain's far end (flying hook, dangling
// tip, or anchor). Equality distance constraints keep the polyline's total
// length at the chain's REAL length — free wrap-path length plus the slack the
// solver is not using — so the drawn chain neither stretches when hanging nor
// shortens when heaped (a heap folds, it does not shrink). Long-range
// attachments from both pins kill the sag-stretch a few Gauss-Seidel passes
// leave behind, which is what makes 1.8 m of cast iron read as inextensible.
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
// and as slack approaches zero every node is blended toward its arc-length
// position on the straight wrap path — fully there at zero slack, untouched
// beyond TAUT_BLEND_SLACK. The drawn shape is then a continuous function of
// the physics state: taut is the limit of almost-taut, and there is no frame
// on which the representation changes. The length the blend hides is bounded
// by w·slack, at most a link or two right at the crossover.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { GRAVITY } from "../engine/world";
import { shapeExtents } from "../engine/shapes";
import { circleOverlap } from "../engine/collision";
import type { CollisionShape2D, PhysicsBody2D } from "../engine/body";
import type { RopeNode } from "../lib/ropeContact";
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
const FRICTION = 0.5;
// Gauss-Seidel passes per step. The pinned ends propagate one node per pass,
// so this must comfortably exceed nothing — it is paired with the long-range
// attachments below, which enforce the global statement the local passes
// converge toward.
const ITERATIONS = 16;
// Constraint iterations between collision resolutions (the final iteration
// always collides last, so the frame ends clear of the scenery).
const COLLIDE_EVERY = 4;
// Slack below which the drawn chain starts blending toward the straight wrap
// path, metres. See the header: this is the no-teleport mechanism. 10 cm of
// slack on this chain sags ~26 cm, so the ramp starts while the sag is still
// an honest drape and finishes exactly at taut.
const TAUT_BLEND_SLACK = 0.1;
// A node may not move faster than this, metres per step. Purely a safety
// fence around the Verlet integration — the hook itself flies at 12 m/s, i.e.
// 0.2 m per step, an order of magnitude inside it.
const MAX_STEP = 0.5;

export class SlackChain {
  // Node 0 is pinned where the chain leaves the ball; the last node is pinned
  // at the chain's far end. `prev` is the Verlet history (pos − velocity·dt);
  // `renderFrom` is where each node ENDED the previous step, which is what the
  // renderer interpolates from — the two differ the moment a constraint or a
  // collision moves a node.
  private pos: Vec2[] = [];
  private prev: Vec2[] = [];
  private renderFrom: Vec2[] = [];

  // The far-end body the chain was deployed with — the hook, later the
  // dangling tip. The visual chain threads INTO it (the manacle is drawn over
  // the join), so it is the one solid thing the nodes must not collide with.
  // An anchor on scene geometry is a different body and is not excluded: a
  // chain anchored to a wall drapes against that wall.
  private readonly tipBody: PhysicsBody2D;

  constructor(private readonly chain: Rope) {
    this.tipBody = chain.end.contact.obj as PhysicsBody2D;
  }

  // How many leading wraps are the coil — chain wound onto the shape the rope
  // starts on (the ball's rim). Same predicate as Rope.syncCoil: the coil is
  // kinematic (it rides the ball's rotation), so the drape starts after it.
  private coilRun(): number {
    const body = this.chain.start.contact.obj;
    const shapeIndex = this.chain.start.contact.shapeIndex;
    const wraps = this.chain.wraps;
    let run = 0;
    while (
      run < wraps.length &&
      wraps[run]!.contact.obj === body &&
      wraps[run]!.contact.shapeIndex === shapeIndex
    ) {
      run++;
    }
    return run;
  }

  // The free portion of the wrap path: the take-off node (the coil's tangent
  // point, or the start contact bare), any scene wraps, and the far end.
  private freePathNodes(): RopeNode[] {
    const run = this.coilRun();
    const wraps = this.chain.wraps;
    const takeoff = run > 0 ? wraps[run - 1]! : this.chain.start;
    return [takeoff, ...wraps.slice(run), this.chain.end];
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
    const free = this.freePathNodes();
    const freePoints = free.map((n) => n.contact.globalPosition);

    if (this.pos.length !== SEGMENTS + 1) {
      // First step: lay the chain along the wrap path it is deployed on, at
      // rest relative to the world. During the deploy that path is straight
      // and taut, so this is exact.
      this.pos = SlackChain.sampleByArc(freePoints, SEGMENTS);
      this.prev = this.pos.slice();
      this.renderFrom = this.pos.slice();
    }

    let freeStraightLen = 0;
    for (let i = 1; i < freePoints.length; i++) {
      freeStraightLen += freePoints[i - 1]!.distanceTo(freePoints[i]!);
    }
    // Slack the solver is not using. The wrap path can run OVER the chain's
    // length (the blocked-length lease), which is simply zero slack here.
    const slack = Math.max(0, this.chain.maxRopeLength - this.chain.getCurrentLength());
    const targetLen = freeStraightLen + slack;
    const restLen = targetLen / SEGMENTS;

    const pinA = freePoints[0]!;
    const pinB = freePoints[freePoints.length - 1]!;

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

    // Almost taut: pull every node toward its arc-length position on the
    // straight wrap path, all the way there at zero slack. This is the
    // no-teleport guarantee — see the header.
    const w = 1 - Math.min(slack / TAUT_BLEND_SLACK, 1);
    if (w > 0 && freeStraightLen > 1e-9) {
      const target = SlackChain.sampleByArc(freePoints, SEGMENTS);
      for (let i = 1; i < SEGMENTS; i++) {
        this.pos[i] = this.pos[i]!.lerp(target[i]!, w);
      }
    }

    const candidates = this.collectCollisionShapes(bodies);
    for (let iter = 0; iter < ITERATIONS; iter++) {
      this.solveDistances(restLen, iter % 2 === 1);
      this.solveLongRange(restLen, pinA, pinB);
      if (iter % COLLIDE_EVERY === COLLIDE_EVERY - 1) this.solveCollisions(candidates);
    }
  }

  // Every wrappable shape near the chain this step. Wrappable is the right
  // filter because it is the rope's own notion of solid — the mounting loop
  // the chain threads through is exactly what it exists to exclude. The far
  // end's own body (hook / dangling tip) is skipped: the chain threads into
  // it. The AABB gate keeps the per-node narrowphase to the shapes that could
  // possibly matter.
  private collectCollisionShapes(bodies: readonly PhysicsBody2D[]): CollisionShape2D[] {
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
    const out: CollisionShape2D[] = [];
    for (const body of bodies) {
      if (body.removed || body === this.tipBody) continue;
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
        out.push(s);
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
  private solveDistances(restLen: number, reversed: boolean): void {
    for (let k = 0; k < SEGMENTS; k++) {
      const j = reversed ? SEGMENTS - 1 - k : k;
      const a = this.pos[j]!;
      const b = this.pos[j + 1]!;
      const d = b.sub(a);
      const len = d.length();
      if (len < 1e-9) continue;
      const err = (len - restLen) / len;
      const aPinned = j === 0;
      const bPinned = j + 1 === SEGMENTS;
      if (aPinned && bPinned) continue;
      let corr = d.mul(err);
      if (len < restLen * 0.95) {
        const kick = (restLen - len) * 0.5 * (j % 2 === 0 ? 1 : -1);
        corr = corr.add(d.div(len).orthogonal().mul(kick));
      }
      if (aPinned) {
        this.pos[j + 1] = b.sub(corr);
      } else if (bPinned) {
        this.pos[j] = a.add(corr);
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
  private solveLongRange(restLen: number, pinA: Vec2, pinB: Vec2): void {
    for (let i = 1; i < SEGMENTS; i++) {
      const maxA = i * restLen;
      const fromA = this.pos[i]!.sub(pinA);
      const dA = fromA.length();
      if (dA > maxA) this.pos[i] = pinA.add(fromA.mul(maxA / dA));
      const maxB = (SEGMENTS - i) * restLen;
      const fromB = this.pos[i]!.sub(pinB);
      const dB = fromB.length();
      if (dB > maxB) this.pos[i] = pinB.add(fromB.mul(maxB / dB));
    }
  }

  // Push every interior node out of the scenery. Dead normal restitution and
  // Coulomb-ish tangential friction, both written through the Verlet history.
  private solveCollisions(shapes: readonly CollisionShape2D[]): void {
    for (let i = 1; i < SEGMENTS; i++) {
      let p = this.pos[i]!;
      for (const s of shapes) {
        const e = shapeExtents(s);
        const c = s.globalPosition;
        if (
          Math.abs(p.x - c.x) > e.x + NODE_RADIUS ||
          Math.abs(p.y - c.y) > e.y + NODE_RADIUS
        ) {
          continue;
        }
        const ov = circleOverlap(p, NODE_RADIUS, s);
        if (!ov) continue;
        p = p.add(ov.normal.mul(ov.depth));
        const vel = p.sub(this.prev[i]!);
        const vn = ov.normal.mul(vel.dot(ov.normal));
        const vt = vel.sub(vn);
        this.prev[i] = p.sub(vt.mul(1 - FRICTION));
      }
      this.pos[i] = p;
    }
  }

  // The full drawn polyline, loop → anchor: the coil (welded to the ball's
  // render transform, exactly as the span renderer laid it) followed by the
  // simulated drape. Both simulated ends are re-welded to their contacts'
  // render transforms so the chain never visibly detaches from the ball or
  // the manacle between physics steps; the interior interpolates the sim.
  pathLoopToAnchor(alpha: number): Vec2[] {
    const chain = this.chain;
    if (this.pos.length !== SEGMENTS + 1) {
      // Not stepped yet — fall back to the straight spans.
      return chain.path().map((n) => n.contact.renderGlobalPosition(alpha));
    }
    const run = this.coilRun();
    const free = this.freePathNodes();
    const out: Vec2[] = [];
    if (run > 0) {
      out.push(chain.start.contact.renderGlobalPosition(alpha));
      for (let i = 0; i < run - 1; i++) {
        out.push(chain.wraps[i]!.contact.renderGlobalPosition(alpha));
      }
    }
    out.push(free[0]!.contact.renderGlobalPosition(alpha));
    for (let i = 1; i < SEGMENTS; i++) {
      out.push(this.renderFrom[i]!.lerp(this.pos[i]!, alpha));
    }
    out.push(chain.end.contact.renderGlobalPosition(alpha));
    return out;
  }

  // Step-time node positions, for the CLI's SVG frames and debug tooling.
  nodePositions(): readonly Vec2[] {
    return this.pos;
  }
}
