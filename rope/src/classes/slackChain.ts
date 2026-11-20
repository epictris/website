// SlackChain — the VISUAL simulation of the ball chain while it hangs loose.
//
// The rope solver models the chain as straight spans between wrap nodes, which
// is exactly right for a taut chain and exactly wrong for a slack one: a metal
// chain with length to spare sags, drapes over ledges and heaps on the floor.
// This class is that drape. It is strictly one-way: it reads body transforms
// and the chain's wrap path, and writes nothing back — no forces, no impulses,
// no positions. Nothing the game measures (replays, invariants, the solver)
// can see it. Cosmetic rendering and the audio observer read its node motion;
// deleting it affects those outputs only, never physics.
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
import { Mathf } from "../engine/mathf";
import { PX } from "../engine/units";
import { CHAIN_LINK_HALF_WIDTH, CHAIN_LINK_LEN } from "../render/chainMetrics";
import { GRAVITY } from "../engine/world";
import { circleOverlapFrom, circleOverlapFromLoop, worldLoop, type WorldLoop } from "../engine/collision";
import type { CollisionObject2D, CollisionShape2D, PhysicsBody2D } from "../engine/body";
import { ringEnd } from "../lib/vineClamp";
import { MANACLE_REACH } from "../lib/manacle";
import { Rope } from "./rope";

// Fixed particle count. Fixed rather than derived from the chain's length so
// the node array never resamples (a resample is a pop), and the rest spacing
// simply scales with the deployed length. 64 segments put a node every 2.8 cm
// on a fully deployed 1.8 m chain — under one drawn link, so the polyline is
// never the resolution bottleneck.
export const SEGMENTS = 64;
// Half the broad link's outside width: the chain's physical half-thickness,
// which is the radius each node keeps clear of geometry. A chain lying on the
// floor then rests ON the floor, and one bent over a corner clears it by
// exactly a link's half-width, which is where a real chain's centreline sits.
// It was a hard-coded 9 mm, half the 1.8 cm link of its day, and stayed 9 mm
// when the links became DIN 766 at the loop's 13.2 mm bar (44.8 mm across):
// every broad link of a resting drape then sat 13.4 mm inside whatever it lay
// on, read as the chain passing through the box it was wrapped round
// (`session-276f`).
export const NODE_RADIUS = CHAIN_LINK_HALF_WIDTH;
// Per-frame velocity retention. Iron is heavy and air is not what stops it —
// contact friction is — so the drag here is a whisper, just enough to bleed
// the numerical hum out of a hanging catenary.
export const DAMPING = 0.995;
// Fraction of a node's tangential motion removed per contact resolution.
// Metal on stone drags hard; this is what lets a thrown chain heap and stay
// heaped instead of creeping downhill forever.
export const FRICTION = 0.7;
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
export const STICK_STEP = 0.25 * PX; // 2.5 mm per step ≈ 0.15 m/s
// Gauss-Seidel passes per step. The pinned ends propagate one node per pass,
// so this must comfortably exceed nothing — it is paired with the long-range
// attachments below, which enforce the global statement the local passes
// converge toward.
const ITERATIONS = 16;
// Constraint iterations between collision resolutions (the final iteration
// always collides last, so the frame ends clear of the scenery), of which
// those where nothing has moved far are skipped (`COLLIDE_MOVE`). Every one:
// the sweeps take each node and segment from where it was last clear, and a
// collision after every pass is what keeps that a short, straight move. At
// every fourth, as before the sweeps, the drape still came off the box on
// `session-58f` and `session-256f` and ended steps across it. Fewer passes
// (8, 10, 12) let it come off the box on `session-58f` again.
export const COLLIDE_EVERY = 1;
// The cadence a step falls back to once it is over its time budget (see
// `timeBudgetMs`): every fourth pass, as before the sweeps.
const COLLIDE_EVERY_BEHIND = 4;
// How far a node may have moved since it was last clear before the next
// collision pass is due, metres; a pass none has moved that far since is
// skipped. The first and last passes of a step always collide. What a skipped
// pass saves is the sweep the next one makes anyway, covering the same short
// move: the sweeps run from where each node was last clear, so nothing goes
// through a piece between passes. A drape at rest on the introduction's rocks
// (`session-310f`) then collides about 5 times a step instead of 16 (0.84 to
// 0.32 ms a step in bun); a drape being thrown still collides on nearly every
// pass. A quarter of the node's radius, 5.6 mm: the drape test holds to
// 10 mm, and at 20 mm the drape came off the box on `session-58f` again.
// Skipping by the clock instead (the budget's every-fourth fallback) is what
// let the drape off the box before the sweeps; skipping by distance keeps
// every sweep short.
// The first pass is not optional: a step that starts with a node inside a
// piece (the segment push-out, which a step ends with, can leave one there)
// has to put it out before the constraints work from it, or the step's one
// final pass met the same node in the same place every step, 15-27 mm in the
// box for 182 frames of `session-256f`.
const COLLIDE_MOVE = NODE_RADIUS / 4;
// How many budgets a step may run to, colliding at the fallback cadence,
// before it stops after its next collision pass.
const BUDGET_STOP = 4;
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
export const SEAM_ROUNDS = 3;

// How close to a face's plane, inside it, a sag-bound target still counts as
// outside that face, metres. The target is on the wrap path, which runs along
// the faces the chain is wrapped round (a lerp between two corners), so it
// lies on them to rounding error - picometres at level coordinates of tens of
// metres. A micrometre is far above that and far below anything a face's
// side could mean.
const BOUND_ON_FACE = 1e-6;
// A node may not move faster than this, metres per step. Purely a safety
// fence around the Verlet integration — the hook itself flies at 12 m/s, i.e.
// 0.2 m per step, an order of magnitude inside it.
export const MAX_STEP = 0.5;
// A shape the drape may touch this step, with everything the per-node test
// reads about it taken ONCE. The narrowphase runs nodes × seam rounds ×
// collision passes times over this list (63 × 3 × 4 = 756 visits a shape a
// step at the four passes of the time), and taking a shape's extents and world centre on every visit was the
// whole cost of the drape: 0.75 of the 0.88 ms a step it took on session-417f,
// nearly all of it in `shapeExtents` and `globalPosition` for shapes the box
// test then rejected. Nothing here can change during a step - the drape moves
// only its own nodes - so it is read at the top and the visits are four
// comparisons on numbers.
const NO_VERTS: readonly Vec2[] = [];

export interface Candidate {
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
  // The piece in world space, read once for the step's every query against
  // it (`WorldLoop`); null for a circle. Bodies do not move during a drape
  // step, which runs on the frame's final transforms.
  readonly loop: WorldLoop | null;
}

// Every wrappable shape of every SOLID body near `points` this step. Both
// halves are the rope's own notion of what a chain may touch: `wrappable`
// excludes the mounting loop the chain threads through, and a non-solid body
// (`isPassThrough` in Rope) excludes vine links and hook-only grates - the
// real chain never wraps either, so a drape resting on one would be a drawing
// of a collision the level does not contain. `exclude` are bodies the caller
// collides with on its own terms or not at all. The AABB gate keeps the
// per-node narrowphase to the shapes that could possibly matter, and each
// survivor is read once into a `Candidate` (see there). Shared with the
// released chain's reel (render/chainReel.ts).
export function drapeCandidates(
  points: readonly Vec2[],
  bodies: readonly PhysicsBody2D[],
  exclude: readonly CollisionObject2D[],
  cuffBody: CollisionObject2D | null,
): Candidate[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const margin = NODE_RADIUS + MAX_STEP;
  const out: Candidate[] = [];
  for (const body of bodies) {
    if (body.removed || !body.isSolid || exclude.includes(body)) continue;
    let moving: boolean | null = null;
    for (const s of body.getShapes()) {
      if (!s.wrappable) continue;
      const c = s.globalPosition;
      const e = s.extents();
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
        moving = from.x !== now.x || from.y !== now.y || body.renderRotation(0) !== body.globalRotation;
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
        loop: worldLoop(s),
      });
    }
  }
  return out;
}

// Where a world point riding `body` was at the start of the frame, and where
// a point that rode it from the start of the frame is now - the body's
// frame-start pose is its captured render transform, taken at the top of the
// frame before anything moved, so both are exact for the frame rather than a
// velocity times dt.
export function bodyWas(body: CollisionObject2D, p: Vec2): Vec2 {
  const prevPos = body.renderPosition(0);
  const prevRot = body.renderRotation(0);
  return prevPos.add(p.sub(body.globalPosition).rotated(prevRot - body.globalRotation));
}

export function bodyCarried(body: CollisionObject2D, q: Vec2): Vec2 {
  const prevPos = body.renderPosition(0);
  const prevRot = body.renderRotation(0);
  return body.globalPosition.add(q.sub(prevPos).rotated(body.globalRotation - prevRot));
}

// The segments between nodes `first`..`last` off the corners of the scenery,
// continuously. The node push-out keeps every node clear, and that is not the
// chain clear: a corner can pass between two nodes as the segment joining them
// moves, both nodes ending clear on two faces of the piece with the segment
// across it, and nothing pushes back on a segment. On `session-53f` the drape
// slung over the end of the 20 x 10 cm box was hauled toward the ball and the
// segment between its nodes on the two faces cut the corner 8 mm, then 29 mm,
// then crossed the box through its middle (f25-27); on `session-58f` corners
// passing between nodes carried the drape from over the box to under it while
// the chain stayed over it, and as the slack ran out the sag bound hauled it
// back through: the chain phasing through the box and snapping back.
//
// So each segment is held off a piece's vertices as the nodes are held off its
// faces: by the broad link's half-width, on the side the vertex was on. Which
// side is the continuous answer, the segment's came-from: the segment is taken
// to have moved linearly from where its nodes started the step (`from`) to
// where they are, and a vertex that lay on the moving segment at some moment
// of that move (`vertexCrossed`, the textbook edge-vertex test: the roots in
// [0, 1] of the quadratic the cross product makes) went through it, so is put
// back on the side it started on. A vertex that did not cross is held on the
// side it is on. Asked in each piece's own frame: for a body that moved the
// start is carried with it, as the node push-out's came-from is. A segment
// that crosses a piece without any vertex having crossed it this step was
// across it when the step began; it is put out on the side away from the
// piece's centre, which is right for a cut while it is shallow.
//
// The move is the textbook edge-vertex contact: the vertex's projection on the
// segment moved clear along the segment's normal, shared between the two nodes
// by where it falls (`1 - t` and `t`, scaled so the point moves the whole way),
// and the normal velocity killed as the node push-out kills it. Vertex loops
// only: a circle has no corner, and the one a drape lies on most is the ball's
// own rim, whose coil chords sit inside the rim by their sagitta (0.7 mm at
// 2.8 cm on the 14 cm rim) - held off it, the coil was pushed out on every
// pass, and a ball pressed against the box the chain is wrapped round pushed
// the drape off its rim into the box.
export function pushSegmentsOut(
  pos: Vec2[],
  prev: Vec2[],
  from: readonly Vec2[],
  carry: readonly boolean[],
  candidates: readonly Candidate[],
  first: number,
  last: number,
  cuff: { body: CollisionObject2D; at: Vec2 } | null,
): void {
  for (let j = first; j < last; j++) {
    // Repeated, as the node push-out is, until the segment ends clear: moving
    // a segment off one vertex turns it, and can lay it over another.
    for (let round = 0; round < SEAM_ROUNDS; round++) {
      const a = pos[j]!;
      const b = pos[j + 1]!;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const len = Math.sqrt(abx * abx + aby * aby);
      if (len < 1e-9) break;
      const ux = abx / len;
      const uy = aby / len;
      // m.w is the cross product u x w: positive with w to the left of a->b.
      const mx = -uy;
      const my = ux;
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);
      // The deepest vertex over every piece the segment's box reaches.
      let depth = 0;
      let t = 0;
      let dir = Vec2.ZERO;
      let owner: Candidate | null = null;
      for (const c of candidates) {
        if (maxX < c.cx - c.ex || minX > c.cx + c.ex || maxY < c.cy - c.ey || minY > c.cy + c.ey) continue;
        if (c.loop === null) continue;
        const verts = c.loop.verts;
        // The segment's ends where they were last clear, and the box the
        // segment swept from there, read when the first vertex projecting
        // into the segment asks: most pieces a segment's box reaches have
        // none, and a moving piece's carry is two rotations.
        let a0 = Vec2.ZERO;
        let b0 = Vec2.ZERO;
        let sx0 = NaN;
        let sx1 = 0;
        let sy0 = 0;
        let sy1 = 0;
        // For a segment already across the piece with no vertex crossing it
        // this step: whether it is (asked once, when first needed), and the
        // side of the segment the piece's centre is on, which every vertex
        // is put back on, the segment going out away from the centre.
        let across: boolean | null = null;
        let centreSide = 0;
        for (const v of verts) {
          // In plain numbers, as in `sweptEntry`.
          const wx = v.x - a.x;
          const wy = v.y - a.y;
          const tv = (wx * ux + wy * uy) / len;
          if (tv <= 0 || tv >= 1) continue;
          const now = mx * wx + my * wy;
          let side = now >= 0 ? 1 : -1;
          if (Number.isNaN(sx0)) {
            a0 = c.moving && carry[j] ? bodyCarried(c.owner, from[j]!) : from[j]!;
            b0 = c.moving && carry[j + 1] ? bodyCarried(c.owner, from[j + 1]!) : from[j + 1]!;
            sx0 = Math.min(minX, a0.x, b0.x);
            sx1 = Math.max(maxX, a0.x, b0.x);
            sy0 = Math.min(minY, a0.y, b0.y);
            sy1 = Math.max(maxY, a0.y, b0.y);
          }
          const swept = v.x >= sx0 && v.x <= sx1 && v.y >= sy0 && v.y <= sy1;
          if (swept && vertexCrossed(a0, b0, a, b, v)) {
            const was = b0.sub(a0).cross(v.sub(a0));
            if (was !== 0) side = was > 0 ? 1 : -1;
          } else {
            across ??= segmentCrossesLoop(a, b, verts);
            if (across) {
              if (centreSide === 0) {
                let cx = 0;
                let cy = 0;
                for (const w of verts) {
                  cx += w.x;
                  cy += w.y;
                }
                centreSide = mx * (cx / verts.length - a.x) + my * (cy / verts.length - a.y) >= 0 ? 1 : -1;
              }
              side = centreSide;
            }
          }
          // The vertex is to be on `side`, NODE_RADIUS off the segment.
          const need = NODE_RADIUS - side * now;
          if (need <= depth) continue;
          if (c.cuffed && cuff !== null && new Vec2(a.x + abx * tv, a.y + aby * tv).distanceTo(cuff.at) < MANACLE_REACH) {
            continue;
          }
          depth = need;
          t = tv;
          dir = new Vec2(mx * -side, my * -side);
          owner = c;
        }
      }
      if (owner === null) break;
      const wa = 1 - t;
      const wb = t;
      const lambda = depth / (wa * wa + wb * wb);
      const na = a.add(dir.mul(wa * lambda));
      const nb = b.add(dir.mul(wb * lambda));
      pos[j] = na;
      pos[j + 1] = nb;
      for (const [i, p] of [[j, na], [j + 1, nb]] as const) {
        const surfaceStep = owner.moving ? p.sub(bodyWas(owner.owner, p)) : Vec2.ZERO;
        const rel = p.sub(prev[i]!).sub(surfaceStep);
        prev[i] = p.sub(surfaceStep.add(rel.sub(dir.mul(rel.dot(dir)))));
      }
    }
  }
}

// Whether the point `v` lay on the segment at some moment of its linear move
// from a0-b0 to a1-b1: the textbook 2D edge-vertex continuous test. With
// a(t) = a0 + t da and b(t) = b0 + t db, the cross product
// (b(t) - a(t)) x (v - a(t)) is a quadratic in t; at each of its roots in
// [0, 1] the point is on the segment's line, and on the segment itself if its
// projection falls within it.
export function vertexCrossed(a0: Vec2, b0: Vec2, a1: Vec2, b1: Vec2, v: Vec2): boolean {
  // In plain numbers, as in `sweptEntry`.
  const dax = a1.x - a0.x;
  const day = a1.y - a0.y;
  const e0x = b0.x - a0.x;
  const e0y = b0.y - a0.y;
  const dex = b1.x - b0.x - dax;
  const dey = b1.y - b0.y - day;
  const w0x = v.x - a0.x;
  const w0y = v.y - a0.y;
  // (e0 + t de) x (w0 - t da) = c0 + c1 t + c2 t^2
  const c0 = e0x * w0y - e0y * w0x;
  const c1 = (dex * w0y - dey * w0x) - (e0x * day - e0y * dax);
  const c2 = -(dex * day - dey * dax);
  let t0 = NaN;
  let t1 = NaN;
  if (Math.abs(c2) < 1e-14) {
    if (Math.abs(c1) > 1e-14) t0 = -c0 / c1;
  } else {
    const disc = c1 * c1 - 4 * c2 * c0;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    t0 = (-c1 - sq) / (2 * c2);
    t1 = (-c1 + sq) / (2 * c2);
  }
  return onSegmentAt(t0, e0x, e0y, dex, dey, w0x, w0y, dax, day) ||
    onSegmentAt(t1, e0x, e0y, dex, dey, w0x, w0y, dax, day);
}

// Whether, at root `t` of `vertexCrossed` (NaN for none), the point projects
// within the segment.
function onSegmentAt(
  t: number, e0x: number, e0y: number, dex: number, dey: number,
  w0x: number, w0y: number, dax: number, day: number,
): boolean {
  if (!(t >= 0 && t <= 1)) return false;
  const ex = e0x + dex * t;
  const ey = e0y + dey * t;
  const wx = w0x - dax * t;
  const wy = w0y - day * t;
  const ee = ex * ex + ey * ey;
  if (ee < 1e-18) return false;
  const s = (wx * ex + wy * ey) / ee;
  return s >= 0 && s <= 1;
}

// Where a node that started its step at `from` (clear of everything) and is
// now at `to` first went into a piece's vertex loop on the way, or `to` if
// the straight move crossed none. Each piece is asked in its own frame: for a
// body that moved, `from` is carried with it, as the push-out's came-from is.
// Circles are left to the push-out, as the segment push-out leaves them.
export function sweptEntry(from: Vec2, carry: boolean, to: Vec2, candidates: readonly Candidate[]): Vec2 {
  let best = 1;
  let at = to;
  for (const c of candidates) {
    if (c.loop === null) continue;
    const a = c.moving && carry ? bodyCarried(c.owner, from) : from;
    // Against the piece's own box, not the one grown by the node's radius:
    // a move that stays outside it crosses no edge of the piece.
    const ex = c.ex - NODE_RADIUS;
    const ey = c.ey - NODE_RADIUS;
    if (
      Math.max(a.x, to.x) < c.cx - ex ||
      Math.min(a.x, to.x) > c.cx + ex ||
      Math.max(a.y, to.y) < c.cy - ey ||
      Math.min(a.y, to.y) > c.cy + ey
    ) {
      continue;
    }
    const verts = c.loop.verts;
    // In plain numbers: run once per node, piece and collision pass, the
    // vectors this was written with were most of what it cost.
    const dx = to.x - a.x;
    const dy = to.y - a.y;
    const dl = Math.sqrt(dx * dx + dy * dy);
    if (dl < 1e-12) continue;
    // A start on a face (where the bound lays a node, see `BOUND_ON_FACE`)
    // goes in through that face at the very start of the move; counted as a
    // crossing at s = 0 rather than missed, which left only the far face's
    // exit and let the node through (`session-58f` f36).
    const onFace = BOUND_ON_FACE / dl;
    for (let k = 0; k < verts.length; k++) {
      const v = verts[k]!;
      const w = verts[(k + 1) % verts.length]!;
      const ex = w.x - v.x;
      const ey = w.y - v.y;
      const den = dx * ey - dy * ex; // move x edge
      if (Math.abs(den) < 1e-15) continue;
      const avx = v.x - a.x;
      const avy = v.y - a.y;
      const s = (avx * ey - avy * ex) / den; // along the move
      const u = (avx * dy - avy * dx) / den; // along the edge
      if (s < -onFace || s >= best || u < 0 || u > 1) continue;
      best = s;
      at = s > 0 ? new Vec2(a.x + dx * s, a.y + dy * s) : a;
    }
  }
  return at;
}

// A piece the sag bound routes round: its world vertex loop drawn in toward
// its centre by `ROUTE_INSET`, and that loop's bounding box. Drawn in so that
// a target on the wrap path, which lies ON the faces the chain is wrapped
// round, stands just outside it: on the hull of the loop it is then a corner
// of its own rather than a point on an edge, and a straight line from it
// along the face it lies on does not count as going through the piece.
interface RouteLoop {
  readonly verts: readonly Vec2[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}
// Metres. Far below anything a drawn chain could show, and ten times below
// `BOUND_ON_FACE`, so a node the route lays along a face reads as outside it.
const ROUTE_INSET = 1e-7;
// Rounds of adding the pieces a route round the first ones runs into.
const ROUTE_ROUNDS = 4;

// The vertex-loop pieces of `candidates`, less the one the cuff is threaded
// on (the chain threads round it, see the cuff in `step`), as `RouteLoop`s.
// Circles are not routed round, as the segment push-out does not push off
// them (see `pushSegmentsOut`).
function routeLoops(candidates: readonly Candidate[]): RouteLoop[] {
  const out: RouteLoop[] = [];
  for (const c of candidates) {
    if (c.cuffed) continue;
    const world = c.loop?.verts ?? NO_VERTS;
    if (world.length < 3) continue;
    let cx = 0;
    let cy = 0;
    for (const v of world) {
      cx += v.x;
      cy += v.y;
    }
    const centre = new Vec2(cx / world.length, cy / world.length);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const verts = world.map((v) => {
      const to = centre.sub(v);
      const d = to.length();
      const w = d > ROUTE_INSET ? v.add(to.mul(ROUTE_INSET / d)) : v;
      if (w.x < minX) minX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.x > maxX) maxX = w.x;
      if (w.y > maxY) maxY = w.y;
      return w;
    });
    out.push({ verts, minX, minY, maxX, maxY });
  }
  return out;
}

function segmentMayHit(a: Vec2, b: Vec2, l: RouteLoop): boolean {
  return !(
    Math.max(a.x, b.x) < l.minX ||
    Math.min(a.x, b.x) > l.maxX ||
    Math.max(a.y, b.y) < l.minY ||
    Math.min(a.y, b.y) > l.maxY
  );
}

function loopContains(l: RouteLoop, p: Vec2): boolean {
  if (p.x < l.minX || p.x > l.maxX || p.y < l.minY || p.y > l.maxY) return false;
  const v = l.verts;
  let sign = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[(i + 1) % v.length]!.sub(v[i]!).cross(p.sub(v[i]!));
    const s = c > 0 ? 1 : c < 0 ? -1 : 0;
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// Convex hull of `pts`, counter-clockwise by index into `pts`, collinear
// points dropped (Andrew's monotone chain).
function hullOf(pts: readonly Vec2[]): number[] {
  const order = pts.map((_, i) => i).sort((i, j) => pts[i]!.x - pts[j]!.x || pts[i]!.y - pts[j]!.y);
  const turn = (o: number, a: number, b: number): number =>
    pts[a]!.sub(pts[o]!).cross(pts[b]!.sub(pts[o]!));
  const lower: number[] = [];
  for (const i of order) {
    while (lower.length >= 2 && turn(lower[lower.length - 2]!, lower[lower.length - 1]!, i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!;
    while (upper.length >= 2 && turn(upper[upper.length - 2]!, upper[upper.length - 1]!, i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polylineLength(route: readonly Vec2[]): number {
  let len = 0;
  for (let k = 1; k < route.length; k++) len += route[k - 1]!.distanceTo(route[k]!);
  return len;
}

// The sag bound for a node at `p` whose target is `t`, measured round the
// pieces in between. The way round is a side of the convex hull of the node,
// its target and the pieces the straight line runs through (the pieces that
// way round runs into are added and the hull taken again), which is the
// shortest way round one convex piece on that side and the way round the
// outside of several. The side is the one the drape is wound round the piece
// by, not the shorter: on `session-58f` the shorter way from a node at the
// box's top corner to its target on the far face was under the box, while the
// drape and the chain both went over it, and the bound laid the drape under
// it (f37). `pathTo` is the path from the loop to the target (the targets up
// to this node), `drapeTo` the drape from the loop to this node. Returns:
// - null when the straight line is clear, or when the node is inside a piece
//   or the hull does not have both ends on it: the caller's straight bound;
// - `p` itself when the way round is within the bound;
// - otherwise the point on the way round at the bound from the target.
export function boundRoute(
  p: Vec2,
  t: Vec2,
  bound: number,
  loops: readonly RouteLoop[],
  pathTo: readonly Vec2[],
  drapeTo: readonly Vec2[],
): Vec2 | null {
  const blocking: RouteLoop[] = [];
  for (const l of loops) {
    if (loopContains(l, p)) return null;
    if (segmentMayHit(p, t, l) && segmentCrossesLoop(p, t, l.verts)) blocking.push(l);
  }
  if (blocking.length === 0) return null;
  let route: Vec2[] = [];
  for (let round = 0; round < ROUTE_ROUNDS; round++) {
    const pts: Vec2[] = [p, t];
    for (const l of blocking) pts.push(...l.verts);
    const hull = hullOf(pts);
    const ip = hull.indexOf(0);
    const it = hull.indexOf(1);
    if (ip < 0 || it < 0) return null;
    const n = hull.length;
    const forward: Vec2[] = [];
    for (let k = ip; ; k = (k + 1) % n) {
      forward.push(pts[hull[k]!]!);
      if (k === it) break;
    }
    const backward: Vec2[] = [];
    for (let k = ip; ; k = (k - 1 + n) % n) {
      backward.push(pts[hull[k]!]!);
      if (k === it) break;
    }
    // The way round the drape is wound: the side whose loop with the path
    // and the drape (see `encloses`) holds none of the pieces. The shorter
    // only when both or neither do.
    const fwdBad = blocking.some((l) => encloses(pathTo, forward, drapeTo, l));
    const bwdBad = blocking.some((l) => encloses(pathTo, backward, drapeTo, l));
    route = fwdBad !== bwdBad
      ? (fwdBad ? backward : forward)
      : polylineLength(forward) <= polylineLength(backward) ? forward : backward;
    let grew = false;
    for (const l of loops) {
      if (blocking.includes(l)) continue;
      for (let k = 1; k < route.length; k++) {
        if (segmentMayHit(route[k - 1]!, route[k]!, l) && segmentCrossesLoop(route[k - 1]!, route[k]!, l.verts)) {
          blocking.push(l);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }
  const total = polylineLength(route);
  if (total <= bound) return p;
  // Walk from the node along the way round until the rest of it is `bound`.
  let walk = total - bound;
  for (let k = 1; k < route.length; k++) {
    const a = route[k - 1]!;
    const b = route[k]!;
    const leg = a.distanceTo(b);
    if (walk <= leg) return leg > 0 ? a.lerp(b, walk / leg) : b;
    walk -= leg;
  }
  return t;
}

// Whether the closed loop made of `pathTo` (loop -> target), `route`
// reversed (target -> node) and `drapeTo` reversed (node -> loop) winds round
// the piece `l`, tested at its first vertex drawn a little further in (a point
// inside the piece). The drape and the chain are wound round every piece the
// same way when that loop holds none of them; a side of the hull that makes it
// hold one is the way round the drape is not.
function encloses(
  pathTo: readonly Vec2[],
  route: readonly Vec2[],
  drapeTo: readonly Vec2[],
  l: RouteLoop,
): boolean {
  const loop: Vec2[] = [...pathTo];
  for (let k = route.length - 2; k >= 1; k--) loop.push(route[k]!);
  for (let k = drapeTo.length - 1; k >= 0; k--) loop.push(drapeTo[k]!);
  let cx = 0;
  let cy = 0;
  for (const v of l.verts) {
    cx += v.x;
    cy += v.y;
  }
  return windingNumber(loop, new Vec2(cx / l.verts.length, cy / l.verts.length)) !== 0;
}

// The winding number of the closed polygon `poly` about `c`, by signed
// crossings of the rightward ray from `c` (no trigonometry).
function windingNumber(poly: readonly Vec2[], c: Vec2): number {
  let w = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k]!;
    const b = poly[(k + 1) % poly.length]!;
    const left = b.sub(a).cross(c.sub(a));
    if (a.y <= c.y) {
      if (b.y > c.y && left > 0) w++;
    } else if (b.y <= c.y && left < 0) {
      w--;
    }
  }
  return w;
}

function clearLine(a: Vec2, b: Vec2, loops: readonly RouteLoop[]): boolean {
  for (const l of loops) if (segmentMayHit(a, b, l) && segmentCrossesLoop(a, b, l.verts)) return false;
  return true;
}

// Whether segment ab crosses an edge of the vertex loop `verts`.
function segmentCrossesLoop(a: Vec2, b: Vec2, verts: readonly Vec2[]): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i]!;
    const q = verts[(i + 1) % verts.length]!;
    const pqx = q.x - p.x;
    const pqy = q.y - p.y;
    const d1 = abx * (p.y - a.y) - aby * (p.x - a.x);
    const d2 = abx * (q.y - a.y) - aby * (q.x - a.x);
    const d3 = pqx * (a.y - p.y) - pqy * (a.x - p.x);
    const d4 = pqx * (b.y - p.y) - pqy * (b.x - p.x);
    if ((d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0)) return true;
  }
  return false;
}

// Read-only per-step collision telemetry. Repeated constraint/collision passes
// aggregate into one contact per node and shape; audio never feeds the solver.
export interface DrapeContact {
  readonly node: number;
  readonly shape: CollisionShape2D;
  readonly point: Vec2;
  readonly normal: Vec2;
  readonly normalSpeed: number;
  readonly slideSpeed: number;
}

export class SlackChain {
  // Wall-clock budget for one step, milliseconds. The drape is visual only,
  // so it is the one simulation in the game allowed to do LESS work when the
  // machine is behind: its step is constraint passes each followed by a
  // collision pass, and once it is past the budget it collides only every
  // fourth pass (what it gives up is the sweeps' resolution: a node or a
  // segment can travel further between the points it is swept from), and
  // past four budgets it stops after its next collision pass, so the frame
  // still ends clear of the scenery; what a cut step loses is convergence - a
  // little stretch in a drape that is being flung about - and the next step
  // takes it up. Infinite by default, which is what the tools want (`cli render`,
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
  private audioDelta = 1 / 60;
  private audioVelocities: Vec2[] = [];
  private audioHits = new Map<CollisionShape2D, Map<number, DrapeContact>>();

  contactSnapshot(): readonly DrapeContact[] {
    return [...this.audioHits.values()].flatMap(hits => [...hits.values()].map(hit => {
      const point = this.pos[hit.node]!;
      const from = bodyCarried(hit.shape.owner as PhysicsBody2D, this.renderFrom[hit.node]!);
      const velocity = point.sub(from).div(this.audioDelta);
      const tangent = velocity.sub(hit.normal.mul(velocity.dot(hit.normal)));
      return { ...hit, point, slideSpeed: tangent.length() };
    }));
  }

  private beginAudioStep(delta: number): void {
    this.audioDelta = delta;
    this.audioHits.clear();
  }

  private pos: Vec2[] = [];
  private prev: Vec2[] = [];
  private renderFrom: Vec2[] = [];
  // The point on the wrap path the sag bound pulled each node it moved this
  // step toward (null where it moved none): the side such a node is pushed
  // out of the scenery by (see the bound in `step`).
  private boundFrom: (Vec2 | null)[] = [];
  // Where each node was last known clear of the scenery within this step,
  // what every sweep and came-from is taken from: at the start of the step
  // where it ended the last one (or where the bound laid it), then where each
  // collision pass leaves it. `clearCarry` marks a position still in the
  // frame-start pose, carried along with a moving body before it is compared
  // with it.
  private clear: Vec2[] = [];
  private clearCarry: boolean[] = [];
  // Whether each node's long-range attachment to the loop (A) and the far
  // end (B) holds this step: its straight line to the pin is clear of the
  // pieces the bound routes round (see `solveLongRange`).
  private reachA: boolean[] = [];
  private reachB: boolean[] = [];
  // The chain's length as of the last step - the wrap path plus the slack -
  // which is what a reel starts from (render/chainReel.ts), and what the
  // renderers count the links by (`chainLength`). `lengthFrom` is its value a
  // step earlier, interpolated from the way `renderFrom` is for the nodes.
  private length = 0;
  private lengthFrom = 0;

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
    this.beginAudioStep(delta);
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

    const first = this.pos.length !== SEGMENTS + 1;
    if (first) {
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
    this.lengthFrom = first ? targetLen : this.length;
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
      this.audioVelocities[i] = next.sub(this.pos[i]!).div(delta);
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
    //
    // A node the bound moves is pushed out of the scenery by the side of its
    // TARGET, the point on the wrap path it was pulled toward, not the side it
    // started the step on. The solver's path is the chain, so its side of
    // anything the chain is wrapped round is the right one; but a drape whose
    // slack sagged under a box's corner while the solver's straight span
    // passed over it started every step on the wrong side, and the came-from
    // push-out handed each node straight back there. Taut, with the bound at
    // zero, the drape then ran under a 20 x 10 cm box the chain was wrapped
    // over, for good (`session-256f`, `session-386f`, `session-276f`: 203, 343
    // and 228 frames; `scripts/test-chain-drape.ts`).
    // Not where the bound PUT the node: the bound pulls it straight at its
    // target, through whatever is between, and a target on the face of the
    // box the chain is wrapped round put the node inside the box. A side
    // inside the box is no side, the push-out fell back to the shallowest
    // face, and neighbours left by opposite faces drew the segment between
    // them straight through it: 14.5 cm segments across the box the hook flew
    // round on `session-53f` f36-37, the chain phasing through it. The target
    // is on the wrapped face itself, so the push-out reads it as outside a
    // face it lies on (`BOUND_ON_FACE`).
    //
    // And the reach is measured the way the drape would have to go, round the
    // pieces between a node and its target, not through them (`boundRoute`):
    // a node that is too far is moved along that way, so the drape slides
    // round a corner it hangs over rather than being pulled through the piece.
    // Measured straight, the nodes of a drape lying over the 20 x 10 cm box on
    // `session-58f` had their targets on its near face 33 cm off through it,
    // and as the slack ran out the bound pulled them straight through (f36).
    //
    // Clamped around a rail the chain ends at the centre of a ring threaded on
    // the bar, millimetres from the bar's own surface, and the chain leaves
    // the ring at its rim: the nodes inside the cuff's disc are metal the bar
    // is already threaded through, not chain to be pushed out of it. Pushed,
    // the last few nodes were shoved off the handle every step and the drape
    // twitched at the cuff for as long as the ball hung still (`session-291f`).
    // A ring on a vine has no such body: the vine is not scenery the drape
    // collides with at all (see `drapeCandidates`).
    const cuff = clamp !== null ? { body: clamp.contact.obj, at: clamp.contact.globalPosition } : null;
    // Read before the bound, which routes round them, and over the path as
    // well as the nodes, since the bound moves nodes toward the path.
    const candidates = drapeCandidates(this.pos.concat(pathPoints), bodies, [this.tipBody], cuff?.body ?? null);
    const boundFrom: (Vec2 | null)[] = new Array<Vec2 | null>(SEGMENTS + 1).fill(null);
    this.boundFrom = boundFrom;
    const loops = routeLoops(candidates);
    if (pathLen > 1e-9) {
      const bound = SAG_BOUND_FACTOR * Math.sqrt(pathLen * slack);
      const target = SlackChain.sampleByArc(pathPoints, SEGMENTS);
      for (let i = 1; i < SEGMENTS; i++) {
        const routed = boundRoute(this.pos[i]!, target[i]!, bound, loops, target.slice(0, i + 1), this.pos.slice(0, i + 1));
        if (routed !== null) {
          if (routed === this.pos[i]) continue;
          this.pos[i] = routed;
          boundFrom[i] = routed;
          continue;
        }
        const off = this.pos[i]!.sub(target[i]!);
        const dist = off.length();
        if (dist <= bound) continue;
        this.pos[i] = bound > 0 ? target[i]!.add(off.mul(bound / dist)) : target[i]!;
        boundFrom[i] = target[i]!;
      }
    }

    // Which long-range attachments hold this step (see `solveLongRange`).
    for (let i = 1; i < SEGMENTS; i++) {
      this.reachA[i] = clearLine(pinA, this.pos[i]!, loops);
      this.reachB[i] = clearLine(pinB, this.pos[i]!, loops);
    }
    for (let i = 0; i <= SEGMENTS; i++) {
      const b = i === 0 || i === SEGMENTS ? this.pos[i]! : boundFrom[i];
      this.clear[i] = b ?? this.renderFrom[i]!;
      this.clearCarry[i] = b === null || b === undefined;
    }
    // Constraint passes, each followed by a collision pass (COLLIDE_EVERY)
    // where a node has moved far enough since the last to need one
    // (`COLLIDE_MOVE`), and the first and last always, so the last thing a
    // step does is push the nodes clear. The clock is only read when there is a budget to hold, so a
    // tool's run is the same arithmetic whatever the machine. Once the step is
    // over its budget (see `timeBudgetMs`) it collides only every
    // COLLIDE_EVERY_BEHIND passes for the rest, keeping all the passes'
    // convergence and giving up some of the sweeps' resolution, which is what
    // the collision passes cost; past BUDGET_STOP budgets it stops after its
    // next collision pass.
    const budget = SlackChain.timeBudgetMs;
    const timed = Number.isFinite(budget);
    const started = timed ? performance.now() : 0;
    let every = COLLIDE_EVERY;
    let since = 0;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      this.solveDistances(restLen, iter % 2 === 1);
      this.solveBend(restLen);
      this.solveLongRange(restLen, pinA, pinB);
      since++;
      if (iter !== 0 && iter !== ITERATIONS - 1) {
        if ((iter + 1) % every !== 0) continue;
        if (!this.movedSinceClear(COLLIDE_MOVE)) continue;
      }
      // The friction of every pass since the last collision pass, so a
      // drape slides the same however many passes it skipped.
      let keep = 1;
      for (let k = 0; k < since; k++) keep *= 1 - FRICTION;
      since = 0;
      this.solveCollisions(candidates, cuff, keep);
      this.clear = this.pos.slice();
      this.clearCarry.fill(false);
      if (!timed) continue;
      const spent = performance.now() - started;
      if (spent > BUDGET_STOP * budget) break;
      if (spent > budget) every = COLLIDE_EVERY_BEHIND;
    }
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
      const rest = restLen;
      const a = this.pos[j]!;
      const b = this.pos[j + 1]!;
      const d = b.sub(a);
      const len = d.length();
      if (len < 1e-9) continue;
      const err = (len - rest) / len;
      const aPinned = j === 0;
      const bPinned = j + 1 === SEGMENTS;
      if (aPinned && bPinned) continue;
      let corr = d.mul(err);
      if (len < rest * 0.95) {
        const kick = (rest - len) * 0.5 * (j % 2 === 0 ? 1 : -1);
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

  // The bend a chain of rigid links can make. One link can stand square to
  // its neighbour - a chain over a sharp edge turns a quarter at one joint -
  // but cannot fold back on it, so real chain turns at most a quarter turn
  // per link pitch. The drape's segments are shorter than a link (2.8 cm at
  // full reach against 4.2), and without this nothing stopped two of them
  // folding straight back on each other: the buckling nudge above pressed a
  // heap into hairpins one segment wide, a link laid across one had its two
  // ends on the two arms, and it swung through a quarter turn on every
  // millimetre the fold moved (`session-685f` f639, f676-679). Held as the
  // textbook PBD bend: a minimum distance between a node and the next but
  // one, `2·restLen·cos(θ/2)` for the most a node may turn, `θ`, which is
  // the link's quarter turn shared out over the segments in one pitch.
  private solveBend(restLen: number): void {
    const turn = (Math.PI / 2) * Math.min(1, restLen / CHAIN_LINK_LEN);
    const reach = 2 * restLen * Mathf.cos(turn / 2);
    for (let j = 0; j + 2 <= SEGMENTS; j++) {
      const a = this.pos[j]!;
      const c = this.pos[j + 2]!;
      const d = c.sub(a);
      const len = d.length();
      if (len >= reach || len < 1e-9) continue;
      const corr = d.mul((reach - len) / len);
      const aPinned = j === 0;
      const cPinned = j + 2 === SEGMENTS;
      if (aPinned) {
        this.pos[j + 2] = c.add(corr);
      } else if (cPinned) {
        this.pos[j] = a.sub(corr);
      } else {
        const half = corr.mul(0.5);
        this.pos[j] = a.sub(half);
        this.pos[j + 2] = c.add(half);
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
      if (dA > maxA && this.reachA[i] !== false) this.pos[i] = pinA.add(fromA.mul(maxA / dA));
      const maxB = (SEGMENTS - i) * restLen;
      const fromB = this.pos[i]!.sub(pinB);
      const dB = fromB.length();
      if (dB > maxB && this.reachB[i] !== false) this.pos[i] = pinB.add(fromB.mul(maxB / dB));
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
  // Whether any interior node is further than `dist` from where it was last
  // clear (see `COLLIDE_MOVE`).
  private movedSinceClear(dist: number): boolean {
    const limit = dist * dist;
    for (let i = 1; i < SEGMENTS; i++) {
      const dx = this.pos[i]!.x - this.clear[i]!.x;
      const dy = this.pos[i]!.y - this.clear[i]!.y;
      if (dx * dx + dy * dy > limit) return true;
    }
    return false;
  }

  private solveCollisions(
    candidates: readonly Candidate[],
    cuff: { body: CollisionObject2D; at: Vec2 } | null,
    keep: number,
  ): void {
    this.collideNodes(candidates, cuff, keep);
    // After the nodes, whose push-out is what lays a segment across a corner:
    // a node still inside the piece is no end to take a segment from. Once,
    // and last: a node pass after it put corners back across segments (5-8 mm
    // on three of the drape recordings), and a second segment pass, or
    // sweeping the segments until none moved, pushed nodes 20-30 mm into the
    // pieces with nothing after to put them out.
    pushSegmentsOut(this.pos, this.prev, this.clear, this.clearCarry, candidates, 1, SEGMENTS - 1, cuff);
  }

  // `keep` is the share of a contacting node's tangential velocity the pass
  // leaves it: FRICTION's, once for every constraint pass since the last
  // collision pass (see `COLLIDE_MOVE`).
  private collideNodes(
    candidates: readonly Candidate[],
    cuff: { body: CollisionObject2D; at: Vec2 } | null,
    keep: number,
  ): void {
    for (let i = 1; i < SEGMENTS; i++) {
      let p = this.pos[i]!;
      // Swept: a node whose move this step crossed a piece is stopped where
      // it went in, and the push-out below then puts it out by that face.
      // The constraints can carry a node right through a thin piece between
      // two collision passes, and a node that ends clear on the far side is
      // one the push-out never sees: a single long-range pass with the ball
      // pulling away at 6.7 m/s dragged a drape lying over the 20 x 10 cm
      // box through it to hang underneath (`session-58f` f34-35, four nodes
      // in one step). A node the bound moved is swept from where the bound
      // put it, which it reached round the pieces, not through them.
      p = sweptEntry(this.clear[i]!, this.clearCarry[i]!, p, candidates);
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
          // push-out (`session-1038f` f858-862). A node the sag bound moved
          // came from its target on the wrap path, already in this frame's
          // pose, and lying on the faces the chain is wrapped round.
          const was = this.clear[i]!;
          const from = c.moving && this.clearCarry[i] ? bodyCarried(c.owner, was) : was;
          const ov = c.loop !== null
            ? circleOverlapFromLoop(p, NODE_RADIUS, c.loop, from, BOUND_ON_FACE)
            : circleOverlapFrom(p, NODE_RADIUS, c.shape, from, BOUND_ON_FACE);
          if (!ov) continue;
          hit = true;
          p = p.add(ov.normal.mul(ov.depth));
          // How far the surface under the node moved this step: the body's
          // frame-start pose is its captured render transform (taken at the
          // top of the frame, before anything moved), so the point's motion
          // is exact for the frame rather than a velocity times dt. Zero for
          // a body that did not move, without asking it.
          const surfaceStep = c.moving ? p.sub(bodyWas(c.owner, p)) : Vec2.ZERO;
          // Static friction first: a contacting node that has only crept this
          // step, against the surface, is put back where the surface carried
          // it (see STICK_STEP).
          const step = p.sub(this.renderFrom[i]!).sub(surfaceStep);
          const st = step.sub(ov.normal.mul(step.dot(ov.normal)));
          // Measure approach BEFORE contact damping, using the integrated
          // velocity rather than repeated positional corrections as impulses.
          const relative = (this.audioVelocities[i] ?? Vec2.ZERO).sub(surfaceStep.div(this.audioDelta));
          const normalSpeed = Math.max(0, -relative.dot(ov.normal));
          const slideSpeed = st.length() / this.audioDelta;
          let hits = this.audioHits.get(c.shape);
          if (!hits) this.audioHits.set(c.shape, hits = new Map());
          const prior = hits.get(i);
          if (!prior || normalSpeed > prior.normalSpeed || slideSpeed > prior.slideSpeed) {
            hits.set(i, { node: i, shape: c.shape, point: p, normal: ov.normal,
              normalSpeed: Math.max(prior?.normalSpeed ?? 0, normalSpeed),
              slideSpeed: Math.max(prior?.slideSpeed ?? 0, slideSpeed) });
          }
          if (st.length() < STICK_STEP) p = p.sub(st);
          const rel = p.sub(this.prev[i]!).sub(surfaceStep);
          const vn = ov.normal.mul(rel.dot(ov.normal));
          const vt = rel.sub(vn);
          this.prev[i] = p.sub(surfaceStep.add(vt.mul(keep)));
        }
        if (!hit) break;
      }
      this.pos[i] = p;
    }
  }

  // The full drawn polyline, loop → anchor: the simulated drape, its two ends
  // re-welded to their contacts' render transforms so the chain never visibly
  // detaches from the ball or the manacle between physics steps; the interior
  // interpolates the sim.
  // The chain's real length - the wrap path plus the slack the solver is not
  // using - at render time, interpolated between steps as the nodes are.
  // The renderers count the links by THIS, not by the length of the polyline
  // above: the drape only converges toward its length (a heap held by static
  // friction, a hanging run left stretched by the passes), so its polyline
  // runs a few percent long and breathes, and links laid along it at a fixed
  // pitch slid out of the ball and back in for as long as it did - 22 cm out
  // and 12 cm back on `session-339f` f230-250 with the chain's length fixed
  // at 1.8 m. Counted by the length, a chain whose length does not change
  // keeps its links; the drape's error shows as a pitch a few percent long
  // instead (`chainLinkPitch`).
  chainLength(alpha: number): number {
    return this.lengthFrom + (this.length - this.lengthFrom) * alpha;
  }

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

  // Step-time node positions, for the CLI's SVG frames and debug tooling.
  nodePositions(): readonly Vec2[] {
    return this.pos;
  }

  // The nodes and their Verlet history (`pos - velocity·dt`), loop → far
  // end, as of the last step: what a chain that snaps is cut from, so its two
  // halves carry on with the motion the drape had (render/chainSnap.ts). Null
  // if the drape was never stepped.
  nodeState(): { pos: readonly Vec2[]; prev: readonly Vec2[] } | null {
    if (this.pos.length !== SEGMENTS + 1) return null;
    return { pos: this.pos, prev: this.prev };
  }
}
