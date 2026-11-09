// The released chain being reeled back into the ball - a visual of the
// release and nothing else (see chainRetract.ts, which owns one, and
// docs/chain-retract.md).
//
// The slack drape's own model carried on (Verlet nodes, distance passes,
// follow-the-leader with its momentum correction, the slack taken up before
// the end moves - see `reelFollow`), on the gameplay plane, with one change:
// THE BALL IS NOT COLLIDED. A chain wound round the ball is drawn straight
// through it to the loop, where colliding with the ball meant every turn had
// to slide round the rim and through the loop, and the cuff on the far end
// whipped round the ball once per turn wound (978° in 16 steps at up to
// 16 m/s on `session-103f`, 1.7 turns wound). The iron ball hides the links
// inside it. A 3D reel - the ball a sphere the coil slides off, the chain kicked
// toward the camera - was tried and dropped for this (Tris, 2026-11-09: "i like
// that better than the 3D version"): it measured worse too, the cuff travelling
// 1.10 m relative to the ball at 9.4 m/s mean against this one's 0.82 m at
// 7.0 m/s.
//
// Render-side by construction: it reads the level and writes nothing back.

import { Vec2 } from "../engine/vec2";
import { GRAVITY } from "../engine/world";
import { circleOverlapFrom } from "../engine/collision";
import type { CollisionShape2D, PhysicsBody2D } from "../engine/body";
import { BallPlayer } from "../classes/ballPlayer";
import {
  bodyCarried,
  bodyWas,
  type Candidate,
  COLLIDE_EVERY,
  DAMPING,
  type DrapeContact,
  drapeCandidates,
  FRICTION,
  MAX_STEP,
  NODE_RADIUS,
  SEAM_ROUNDS,
  SEGMENTS,
  STICK_STEP,
} from "../classes/slackChain";
import { chainEndFacing } from "../lib/manacle";

// How fast a let-go chain is reeled back in through the loop, metres per
// second: the speed it went out at, the thrown hook's (Tris, 2026-11-09:
// "make it retract at the same rate it deploys"), constant from the release
// to the swallow.
//
// Faster is GENTLER here, not harsher: the ball keeps turning after a release
// (the aim steering it back to face the aim) and the loop the chain is eaten
// through turns with it, so the longer the reel takes the further the cuff is
// dragged round the ball. Measured on the 3D reel over six releases
// (session-103f and ball-wind-up let go at five depths of wind) by how far
// the cuff swept round the ball: as rate x chain out with a floor, 8 /s and
// 4 m/s 489°, 6 and 3 429° in 0.4 s; this, 182° in 0.13 s (157° on this reel).
export const REEL_SPEED = BallPlayer.HOOK_SPEED;
// Constraint passes per reel step. The haul at the loop reaches the far end
// only by propagating node to node (there is no long-range attachment, see
// `step`), and the follow pass carries it whole once per block; the reel lasts
// a fraction of a second, so the extra passes cost nothing that matters.
const REEL_ITERATIONS = 32;
// The cuff's share of a constraint correction against a link's, as an inverse
// mass: the cuff is heavier than a link of chain, so when the chain comes
// tight between them it is the chain that is pulled straight and the cuff
// that lags and swings.
const CUFF_WEIGHT = 0.2;
// How much of the follow pass's correction is paid back as momentum to the
// node ahead (Müller's s_damping, see `reelFollow`): 1 conserves it whole, 0
// is plain follow-the-leader. The paper's own working value.
const FOLLOW_DAMPING = 0.9;

// One frame of the reel, loop -> far end, as the renderers take it.
export interface ReelFrame {
  readonly path: readonly Vec2[];
  // The way the cuff on the end faces: from its centre toward its hinge and
  // on into the chain (unit).
  readonly dir: Vec2;
}

export class ChainReel {
  // Node positions, Verlet history (`pos - velocity·dt`) and where each node
  // ended the previous step (what the renderer interpolates from). Node 0 is
  // the loop; node SEGMENTS the cuff's hinge.
  private readonly pos: Vec2[] = [];
  private readonly prev: Vec2[] = [];
  private readonly renderFrom: Vec2[] = [];
  // Each node's velocity as integrated this step, m/s, before any constraint
  // or contact moved it (see `report`).
  private readonly integrated: Vec2[] = [];
  // The scenery contacts of this step, for the sound (`contactSnapshot`): per
  // shape, per node, the normal and the fastest approach seen across the
  // step's collision passes. Read-only telemetry, as the drape's is.
  private readonly hits = new Map<CollisionShape2D, Map<number, { normal: Vec2; normalSpeed: number }>>();
  private delta = 1 / 60;
  // Set by the step on which the chain's end reached the loop: the fraction
  // of that step at which it did. Null on every other step.
  seatedAt: number | null = null;
  // The chain still out, metres, going negative once the end has passed the
  // loop and is being swallowed toward the ball's centre.
  private reel: number;
  // A full segment's rest length, fixed at the release: the chain is consumed
  // at the loop, segment by segment (`restOf`), not shrunk all over.
  private readonly rest: number;
  private done = false;

  // From the drape of the chain that was out, as its last step left it
  // (`SlackChain.nodeState`), `length` being the chain's length then.
  constructor(
    private readonly ball: BallPlayer,
    state: { pos: readonly Vec2[]; prev: readonly Vec2[] },
    length: number,
  ) {
    for (let i = 0; i <= SEGMENTS; i++) {
      this.pos.push(state.pos[i]!);
      this.prev.push(state.prev[i]!);
      this.renderFrom.push(state.pos[i]!);
      this.integrated.push(Vec2.ZERO);
    }
    this.reel = length;
    this.rest = length / SEGMENTS;
  }

  // One fixed step, after the physics frame, against its final transforms.
  // False once the whole chain is in.
  //
  // The chain is consumed AT THE LOOP, as a winch consumes it: the segment
  // nearest the loop is the one whose rest shrinks, and the next only once it
  // is gone (`restOf`), so slack is taken up before the cuff moves at all and
  // a chain wrapped round a corner is drawn back round it. No sag bound and no
  // long-range attachment, since both hold nodes to where a chain would be
  // and the reel is the chain going where it is pulled; no buckling kick,
  // since nothing pushes a hauled chain.
  step(bodies: readonly PhysicsBody2D[], delta: number): boolean {
    if (this.done) return false;
    const ball = this.ball;
    const loop = ball.loopCenter;
    const before = this.reel;
    this.reel -= REEL_SPEED * delta;
    // The end reaching the loop this step, as the fraction of the step it
    // took: when the seat sounds (audio/soundObserver.ts).
    this.seatedAt = before > 0 && this.reel <= 0 ? before / (before - this.reel) : null;
    if (this.reel <= -loop.distanceTo(ball.globalPosition)) {
      this.done = true;
      return false;
    }

    // Verlet integrate everything but the loop node, the end included; re-pin
    // the loop to where the ball has it this frame.
    const { pos, prev } = this;
    const gravityStep = GRAVITY.mul(delta * delta);
    this.delta = delta;
    this.hits.clear();
    for (let i = 0; i <= SEGMENTS; i++) {
      this.renderFrom[i] = pos[i]!;
      if (i === 0) continue;
      let vel = pos[i]!.sub(prev[i]!).mul(DAMPING);
      const speed = vel.length();
      if (speed > MAX_STEP) vel = vel.mul(MAX_STEP / speed);
      const step = vel.add(gravityStep);
      this.integrated[i] = step.div(delta);
      prev[i] = pos[i]!;
      pos[i] = pos[i]!.add(step);
    }
    prev[0] = pos[0]!;
    pos[0] = loop;

    // The ball is left out of the scenery: the chain passes through it (see
    // the header).
    const candidates = drapeCandidates(pos, bodies, [ball], null);
    const blocks = REEL_ITERATIONS / COLLIDE_EVERY;
    for (let block = 0; block < blocks; block++) {
      for (let k = 0; k < COLLIDE_EVERY; k++) {
        this.solveDistances((block * COLLIDE_EVERY + k) % 2 === 1);
      }
      this.reelFollow();
      this.collide(candidates);
    }
    // Chain that is in rides the loop. A node the reel has consumed (every
    // segment before it at zero rest) arrives carrying the haul's own speed,
    // and left with it, it overshoots through the loop next step and buckles
    // against the node behind it. Its momentum went into the ball; here that
    // is a node with no motion of its own.
    for (let j = 1; j <= SEGMENTS; j++) {
      if (this.restOf(j - 1) > 0) break;
      prev[j] = pos[j]!;
    }
    return true;
  }

  // The rest length of segment `j` (0 nearest the loop): a full segment for
  // every one the chain still out covers counting from the far end, the
  // remainder for the one being consumed, and nothing for the ones already
  // in. They sum to the chain still out.
  private restOf(j: number): number {
    const out = this.reel - (SEGMENTS - 1 - j) * this.rest;
    return Math.min(this.rest, Math.max(0, out));
  }

  // One equality-constraint pass over the segments, alternating the sweep
  // direction between passes. The loop is pinned; the cuff on the far end
  // takes the smaller share of its segment's correction (`CUFF_WEIGHT`).
  private solveDistances(reversed: boolean): void {
    const pos = this.pos;
    for (let k = 0; k < SEGMENTS; k++) {
      const j = reversed ? SEGMENTS - 1 - k : k;
      const d = pos[j + 1]!.sub(pos[j]!);
      const len = d.length();
      if (len < 1e-9) continue;
      const corr = d.mul((len - this.restOf(j)) / len);
      // Shares of the correction taken by the near node and the far one.
      const near = j === 0 ? 0 : j + 1 === SEGMENTS ? 1 / (1 + CUFF_WEIGHT) : 0.5;
      pos[j] = pos[j]!.add(corr.mul(near));
      pos[j + 1] = pos[j + 1]!.sub(corr.mul(1 - near));
    }
  }

  // Follow the leader (Müller et al. 2012, the textbook for a chain that is
  // inextensible from a pinned end): from the loop out, every node is put
  // within its segment's rest of the node before it, moving only itself, so
  // one sweep carries the haul at the loop to the far end WHOLE.
  //
  // With the paper's momentum correction (its DFTL): pulling a node in is a
  // pull on the node ahead of it too, so the node ahead is given the reaction
  // to the correction its follower took, scaled by `FOLLOW_DAMPING`. Without
  // it every node the pass moves keeps the move as velocity that nothing paid
  // for, and the run still on the floor overran the node the haul had lifted
  // off it and folded under the loop.
  //
  // AND WITH THE SLACK TAKEN UP FIRST. Plain follow-the-leader carries a node
  // along its own segment, so a slack chain slides along its own path like a
  // train on rails, every bend kept and the cuff moving from the first frame.
  // So a node out of reach of its leader is first looked for INSIDE THE REACH
  // OF BOTH ITS NEIGHBOURS (`nearestWithin`): while the chain is bent there
  // the two discs overlap and the node goes to the nearest point of the
  // overlap, absorbing the pull by straightening and passing nothing on. Only
  // a node the chain is already straight through is carried along, and the
  // cuff, last and with no follower, moves only once every bend before it has
  // been pulled out.
  private reelFollow(): void {
    const { pos, prev } = this;
    for (let j = 0; j < SEGMENTS; j++) {
      const rest = this.restOf(j);
      const a = pos[j]!;
      const b = pos[j + 1]!;
      const d = b.sub(a);
      const len = d.length();
      if (len <= rest) continue;
      let to: Vec2 | null = null;
      if (j + 1 < SEGMENTS) to = nearestWithin(b, a, rest, pos[j + 2]!, this.restOf(j + 1));
      if (to === null) to = rest > 0 && len > 1e-9 ? a.add(d.mul(rest / len)) : a;
      pos[j + 1] = to;
      if (j === 0) continue;
      // v_j -= s * correction_{j+1}, written into the Verlet history.
      prev[j] = prev[j]!.add(to.sub(b).mul(FOLLOW_DAMPING));
    }
  }

  // Push every node but the loop out of the scenery. The contact law is the
  // drape's: dead normal restitution, static friction in position for a node
  // that has only crept (`STICK_STEP`), and velocity friction (`FRICTION`),
  // all measured relative to the surface, so a node on a moving body rides it.
  private collide(candidates: readonly Candidate[]): void {
    const { pos, prev } = this;
    for (let i = 1; i <= SEGMENTS; i++) {
      let p = pos[i]!;
      for (let round = 0; round < SEAM_ROUNDS; round++) {
        let hit = false;
        for (const c of candidates) {
          if (Math.abs(p.x - c.cx) > c.ex || Math.abs(p.y - c.cy) > c.ey) continue;
          const from = c.moving ? bodyCarried(c.owner, this.renderFrom[i]!) : this.renderFrom[i]!;
          const ov = circleOverlapFrom(p, NODE_RADIUS, c.shape, from);
          if (!ov) continue;
          hit = true;
          p = p.add(ov.normal.mul(ov.depth));
          const surfaceStep = c.moving ? p.sub(bodyWas(c.owner, p)) : Vec2.ZERO;
          this.report(i, c.shape, ov.normal, surfaceStep);
          // Static friction first: a node that has only crept this step,
          // against the surface, is put back where the surface carried it.
          const step = p.sub(this.renderFrom[i]!).sub(surfaceStep);
          const st = step.sub(ov.normal.mul(step.dot(ov.normal)));
          if (st.length() < STICK_STEP) p = p.sub(st);
          // Then the velocity relative to the surface: its normal part
          // killed, its tangential part dragged.
          const rel = p.sub(prev[i]!).sub(surfaceStep);
          const vt = rel.sub(ov.normal.mul(rel.dot(ov.normal)));
          prev[i] = p.sub(surfaceStep.add(vt.mul(1 - FRICTION)));
        }
        if (!hit) break;
      }
      pos[i] = p;
    }
  }

  // Note node `i` touching `shape` (pushed out along `normal`, its surface
  // having moved `surfaceStep` this step), at the speed it was arriving: its
  // integrated velocity relative to the surface, into it. Measured before the
  // contact damps it, as the drape measures its own.
  private report(i: number, shape: CollisionShape2D, normal: Vec2, surfaceStep: Vec2): void {
    const relative = this.integrated[i]!.sub(surfaceStep.div(this.delta));
    const normalSpeed = Math.max(0, -relative.dot(normal));
    let nodes = this.hits.get(shape);
    if (!nodes) this.hits.set(shape, (nodes = new Map()));
    const prior = nodes.get(i);
    if (!prior || normalSpeed > prior.normalSpeed) nodes.set(i, { normal, normalSpeed });
  }

  // This step's scenery contacts in the drape's own form (`DrapeContact`), so
  // the sound reads the reel exactly as it reads the deployed chain
  // (audio/chainSurfaceAudio.ts): a contact per node and shape, at the node's
  // final position, with its approach speed and how fast it is sliding over
  // the surface, measured from where it ended the last step carried with the
  // surface.
  contactSnapshot(): DrapeContact[] {
    const out: DrapeContact[] = [];
    for (const [shape, nodes] of this.hits) {
      const owner = shape.owner as PhysicsBody2D;
      for (const [node, hit] of nodes) {
        const point = this.pos[node]!;
        const velocity = point.sub(bodyCarried(owner, this.renderFrom[node]!)).div(this.delta);
        const slide = velocity.sub(hit.normal.mul(velocity.dot(hit.normal)));
        out.push({ node, shape, point, normal: hit.normal, normalSpeed: hit.normalSpeed, slideSpeed: slide.length() });
      }
    }
    return out;
  }

  // The nodes as they ended the last step, loop -> end: what the link-to-link
  // clinks are read from (audio/chainArticulationAudio.ts), as the drape's
  // nodes are.
  nodePositions(): readonly Vec2[] {
    return this.pos;
  }

  // The reel as drawn, loop -> end, `alpha` being the render interpolation
  // the ball is drawn at. Past zero the end slides from the loop to the
  // ball's centre with the cuff trailing it in, so the cuff leaves the
  // picture under the ball rather than popping out at the rim.
  frame(alpha: number): ReelFrame | null {
    if (this.done) return null;
    const ball = this.ball;
    const loop = ball.renderLoopCenter(alpha);
    const centre = ball.renderPosition(alpha);
    const inward = loop.distanceTo(centre) > 1e-9 ? loop.directionTo(centre) : Vec2.DOWN;
    if (this.reel <= 0) {
      const depth = Math.min(-this.reel, loop.distanceTo(centre));
      return { path: [loop, loop.add(inward.mul(depth))], dir: inward };
    }
    const path: Vec2[] = [loop];
    for (let i = 1; i <= SEGMENTS; i++) path.push(this.renderFrom[i]!.lerp(this.pos[i]!, alpha));
    return { path, dir: chainEndFacing(path, inward) };
  }
}

// The point nearest `p` that is within `ra` of `a` and within `rc` of `c`, or
// null when no such point exists (the two discs do not meet). The candidates
// are `p` itself, its projection onto either circle, and the two points where
// the circles cross; the nearest admissible one wins.
function nearestWithin(p: Vec2, a: Vec2, ra: number, c: Vec2, rc: number): Vec2 | null {
  const inA = (q: Vec2): boolean => q.distanceTo(a) <= ra + 1e-9;
  const inC = (q: Vec2): boolean => q.distanceTo(c) <= rc + 1e-9;
  if (inA(p) && inC(p)) return p;
  let best: Vec2 | null = null;
  let bestD = Infinity;
  const offer = (q: Vec2): void => {
    if (!inA(q) || !inC(q)) return;
    const d = q.distanceTo(p);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  };
  offer(p.distanceTo(a) > 1e-9 ? a.add(a.directionTo(p).mul(ra)) : a);
  offer(p.distanceTo(c) > 1e-9 ? c.add(c.directionTo(p).mul(rc)) : c);
  const ac = a.distanceTo(c);
  if (ac > 1e-9 && ac <= ra + rc) {
    const along = (ac * ac - rc * rc + ra * ra) / (2 * ac);
    const h2 = ra * ra - along * along;
    if (h2 >= 0) {
      const h = Math.sqrt(h2);
      const ex = a.directionTo(c);
      const ey = ex.orthogonal();
      const mid = a.add(ex.mul(along));
      offer(mid.add(ey.mul(h)));
      offer(mid.sub(ey.mul(h)));
    }
  }
  return best;
}
