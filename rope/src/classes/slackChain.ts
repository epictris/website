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
import { RopeClamp } from "../lib/rail";
import { MANACLE_REACH } from "../lib/manacle";
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
    const end = this.chain.end;
    const clamp = end instanceof RopeClamp ? end : null;
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

    const candidates = this.collectCollisionShapes(bodies);
    // Clamped around a rail the chain ends at the centre of a ring threaded on
    // the bar, millimetres from the bar's own surface, and the chain leaves
    // the ring at its rim: the nodes inside the cuff's disc are metal the bar
    // is already threaded through, not chain to be pushed out of it. Pushed,
    // the last few nodes were shoved off the handle every step and the drape
    // twitched at the cuff for as long as the ball hung still (`session-291f`).
    const cuff = clamp !== null ? { body: clamp.body, at: clamp.contact.globalPosition } : null;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      this.solveDistances(restLen, iter % 2 === 1);
      this.solveLongRange(restLen, pinA, pinB);
      if (iter % COLLIDE_EVERY === COLLIDE_EVERY - 1) this.solveCollisions(candidates, cuff);
    }
  }

  // Every wrappable shape of every SOLID body near the chain this step. Both
  // halves are the rope's own notion of what a chain may touch: `wrappable`
  // excludes the mounting loop the chain threads through, and a non-solid body
  // (`isPassThrough` in Rope) excludes vine links and hook-only grates — the
  // real chain never wraps either, so the drape resting on one would be a
  // drawing of a collision the level does not contain. The far end's own body
  // (hook / dangling tip) is skipped: the chain threads into it. The AABB gate
  // keeps the per-node narrowphase to the shapes that could possibly matter.
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
      if (body.removed || !body.isSolid || body === this.tipBody) continue;
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
  // Coulomb-ish tangential friction, both written through the Verlet history,
  // and both measured RELATIVE TO THE SURFACE: a node resting on a body that
  // moves rides it. Measured in world space instead, the static stick held a
  // node still while the lantern it lay on swung out from under it at
  // 2.5 cm a frame, and the node dropped through the gap between the handle
  // and the glass into the lamp's interior (`session-1038f` f858-862, the
  // slack chain falling through the lamp); the same held a drape still on any
  // swinging platform it was heaped on.
  private solveCollisions(
    shapes: readonly CollisionShape2D[],
    cuff: { body: CollisionObject2D; at: Vec2 } | null,
  ): void {
    for (let i = 1; i < SEGMENTS; i++) {
      let p = this.pos[i]!;
      // Repeated until the node ends clear of every shape. A compound body's
      // pieces overlap at their seams (the lantern's handle-top piece stands
      // inside its glass), so a push out of one piece can land inside the
      // next, and a node left inside at the end of a step starts the next one
      // with no side to have come from.
      for (let round = 0; round < SEAM_ROUNDS; round++) {
        let hit = false;
        for (const s of shapes) {
          if (cuff !== null && s.owner === cuff.body && p.distanceTo(cuff.at) < MANACLE_REACH) continue;
          const e = shapeExtents(s);
          const c = s.globalPosition;
          if (
            Math.abs(p.x - c.x) > e.x + NODE_RADIUS ||
            Math.abs(p.y - c.y) > e.y + NODE_RADIUS
          ) {
            continue;
          }
          // Where the node started the step, carried along with the body it
          // is being tested against: which side of a face it came from is a
          // question in the body's own frame. Ejected through the shallowest
          // face instead, a node the constraints had dragged from the top of
          // the lantern's chimney down past its middle left by the SIDE, and
          // the chain it was part of then cut straight through the glass,
          // its two neighbours held 11 cm apart on opposite faces by the
          // push-out (`session-1038f` f858-862).
          const from = SlackChain.carried(s.owner, this.renderFrom[i]!);
          const ov = circleOverlapFrom(p, NODE_RADIUS, s, from);
          if (!ov) continue;
          hit = true;
          p = p.add(ov.normal.mul(ov.depth));
          // How far the surface under the node moved this step: the body's
          // frame-start pose is its captured render transform (taken at the
          // top of the frame, before anything moved), so the point's motion
          // is exact for the frame rather than a velocity times dt.
          const surfaceStep = p.sub(SlackChain.was(s.owner, p));
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
    out.push(end instanceof RopeClamp ? end.renderRimPoint(alpha) : end.contact.renderGlobalPosition(alpha));
    return out;
  }

  // Step-time node positions, for the CLI's SVG frames and debug tooling.
  nodePositions(): readonly Vec2[] {
    return this.pos;
  }
}
