// The chain snapping - a VISUAL of `BallLevel.settleChainStrain`, and nothing
// else.
//
// In the sim a snap is a release: past its strength the chain is let go in one
// call (`BallPlayer.releaseChain`) and the ball flies on. The picture is the
// chain parting in the middle. The half on the anchor stays where it was
// anchored, hanging from the manacle where it bit, for the rest of the run -
// the last `KEPT_HALVES` of them, a level's wreckage; the half on the ball
// stays shackled to its loop, flailing with every turn and swing of the ball,
// until the player lets go of the throw button; and a burst of sparks marks
// the break. A kept half that has come to rest sleeps until its anchor moves.
//
// Both halves are the drape (`SlackChain`) cut in two: on the step the chain
// snapped, the drape's nodes as it last stood are split at their middle node,
// and each half carries on as a loose Verlet chain - pinned at one end, free at
// the broken one - with the drape's own gravity, damping, collision and
// friction, and the motion every node had. A chain parting under eight
// kilonewtons does not just go slack: each half springs back toward its pin
// (`SNAP_RECOIL`).
//
// Render-side by construction, like the sparks and the reel: it reads the
// level and writes nothing back, so no replay, digest or invariant can see it.

import { Vec2 } from "../engine/vec2";
import { GRAVITY } from "../engine/world";
import { shapeExtents } from "../engine/shapes";
import { circleOverlapFrom } from "../engine/collision";
import type { CollisionObject2D, CollisionShape2D, PhysicsBody2D } from "../engine/body";
import type { BallPlayer, ManaclePose } from "../classes/ballPlayer";
import type { Rope } from "../classes/rope";
import { DAMPING, FRICTION, MAX_STEP, NODE_RADIUS, SEGMENTS, type SlackChain } from "../classes/slackChain";
import type { BallLevel } from "../level/ballLevel";
import type { SparkSystem } from "./sparks";

// The node the chain parts at: the middle of the drape, so both halves read.
const BREAK_NODE = SEGMENTS / 2;
// How fast each half's broken end springs back toward its pin at the moment of
// the snap, m/s, falling off linearly to nothing at the pin: the stretch a
// chain at its breaking strain lets go. The feel knob.
const SNAP_RECOIL = 4;
// Constraint passes per step, and how many of them run between collision
// passes (the last always collides, so a step ends clear of the scenery), the
// drape's own (`SlackChain`): a half is 32 segments pinned at one end, held to
// its length from the pin by the long-range attachment on every pass.
const ITERATIONS = 16;
const COLLIDE_EVERY = 4;
// Passes a node is given over the shapes near it to end a collision step clear
// of all of them (compound bodies' pieces overlap at their seams).
const SEAM_ROUNDS = 3;
// How many halves a run keeps on their anchors, the oldest let go first
// (Tris: "persist forever, up to a limit of say 10 per level").
const KEPT_HALVES = 10;
// A kept half whose nodes all moved less than this over a step (m), for
// `SLEEP_STEPS` steps running, stops being stepped until its pin moves: ten
// halves hanging still would otherwise cost a collision pass each, every step,
// for the rest of the run. Under a tenth of a pixel a step is a chain at rest.
const SLEEP_MOTION = 0.1 * NODE_RADIUS;
const SLEEP_STEPS = 30;

// One half of a snapped chain: a Verlet chain pinned at node 0, free at the
// other end.
class ChainPiece {
  private renderFrom: Vec2[];

  constructor(
    private pos: Vec2[],
    private prev: Vec2[],
    // The segment rest length: the drape's spacing as it stood.
    private readonly rest: number,
  ) {
    this.renderFrom = pos.slice();
  }

  // Steps in a row every node has stayed within `SLEEP_MOTION`, and whether
  // the half is asleep: not stepped, and drawn where it lies.
  private still = 0;
  private asleep = false;

  // One fixed step, the pin where it is now - or nothing, for a half asleep
  // whose pin has not moved.
  step(pin: Vec2, bodies: readonly PhysicsBody2D[], delta: number): void {
    if (this.asleep) {
      if (pin.distanceTo(this.pos[0]!) < SLEEP_MOTION) return;
      this.asleep = false;
      this.still = 0;
    }
    this.integrate(pin, bodies, delta);
    let motion = 0;
    for (let i = 0; i < this.pos.length; i++) {
      motion = Math.max(motion, this.pos[i]!.distanceTo(this.renderFrom[i]!));
    }
    this.still = motion < SLEEP_MOTION ? this.still + 1 : 0;
    if (this.still >= SLEEP_STEPS) {
      // At rest: drawn exactly where it lies, and woken with no velocity.
      this.asleep = true;
      this.renderFrom = this.pos.slice();
      this.prev = this.pos.slice();
    }
  }

  private integrate(pin: Vec2, bodies: readonly PhysicsBody2D[], delta: number): void {
    const gravityStep = GRAVITY.mul(delta * delta);
    const n = this.pos.length;
    for (let i = 0; i < n; i++) {
      this.renderFrom[i] = this.pos[i]!;
      if (i === 0) continue;
      let vel = this.pos[i]!.sub(this.prev[i]!).mul(DAMPING);
      const speed = vel.length();
      if (speed > MAX_STEP) vel = vel.mul(MAX_STEP / speed);
      this.prev[i] = this.pos[i]!;
      this.pos[i] = this.pos[i]!.add(vel).add(gravityStep);
    }
    this.prev[0] = this.pos[0]!;
    this.pos[0] = pin;
    const candidates = this.candidates(bodies);
    for (let block = 0; block < ITERATIONS / COLLIDE_EVERY; block++) {
      for (let k = 0; k < COLLIDE_EVERY; k++) {
        this.solveDistances(k % 2 === 1);
        this.solveLongRange();
      }
      this.collide(candidates);
    }
  }

  // The drawn polyline, pin first.
  path(alpha: number, pin: Vec2): Vec2[] {
    const out: Vec2[] = [pin];
    for (let i = 1; i < this.pos.length; i++) out.push(this.renderFrom[i]!.lerp(this.pos[i]!, alpha));
    return out;
  }

  // Equality constraints, the pinned node immovable, alternating sweeps.
  private solveDistances(reversed: boolean): void {
    const segs = this.pos.length - 1;
    for (let k = 0; k < segs; k++) {
      const j = reversed ? segs - 1 - k : k;
      const a = this.pos[j]!;
      const b = this.pos[j + 1]!;
      const d = b.sub(a);
      const len = d.length();
      if (len < 1e-9) continue;
      const corr = d.mul((len - this.rest) / len);
      if (j === 0) {
        this.pos[1] = b.sub(corr);
      } else {
        const half = corr.mul(0.5);
        this.pos[j] = a.add(half);
        this.pos[j + 1] = b.sub(half);
      }
    }
  }

  // Long-range attachment, as the deployed drape holds itself
  // (`SlackChain.solveLongRange`): node `i` is never further from the pin than
  // `i` segments of chain, so the half cannot stretch however hard the ball
  // whips it, and the statement is idle for a chain hanging at rest. Two
  // follow-the-leader passes (the reel's `reelFollow`) were tried first. Plain,
  // every node the pass moved kept the move as velocity, and the free end of a
  // half whipped by the ball's loop ran at twice the loop's speed
  // (`session-646f` f164: 22.9 m/s against 10.3); with the paper's momentum
  // correction it ran at the loop's, but the pass fought the distance passes
  // on a half hanging still and it buzzed 2-3 mm a step for ever, never
  // sleeping. Held by this, the same whip runs at 1.3 times the loop at most
  // and a hanging half swings down to rest.
  private solveLongRange(): void {
    const pin = this.pos[0]!;
    for (let i = 1; i < this.pos.length; i++) {
      const max = i * this.rest;
      const from = this.pos[i]!.sub(pin);
      const d = from.length();
      if (d > max) this.pos[i] = pin.add(from.mul(max / d));
    }
  }

  // The wrappable shapes of the solid bodies near the half, as the drape
  // takes them (`SlackChain.collectCandidates`).
  private candidates(bodies: readonly PhysicsBody2D[]): CollisionShape2D[] {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of this.pos) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const margin = NODE_RADIUS + MAX_STEP;
    const out: CollisionShape2D[] = [];
    for (const body of bodies) {
      if (body.removed || !body.isSolid) continue;
      for (const s of body.getShapes()) {
        if (!s.wrappable) continue;
        const c = s.globalPosition;
        const e = shapeExtents(s);
        if (c.x + e.x < minX - margin || c.x - e.x > maxX + margin) continue;
        if (c.y + e.y < minY - margin || c.y - e.y > maxY + margin) continue;
        out.push(s);
      }
    }
    return out;
  }

  // Every free node out of the scenery, with the drape's dead restitution and
  // tangential friction written through the Verlet history.
  private collide(candidates: readonly CollisionShape2D[]): void {
    for (let i = 1; i < this.pos.length; i++) {
      let p = this.pos[i]!;
      for (let round = 0; round < SEAM_ROUNDS; round++) {
        let hit = false;
        for (const shape of candidates) {
          const ov = circleOverlapFrom(p, NODE_RADIUS, shape, this.renderFrom[i]!);
          if (!ov) continue;
          hit = true;
          p = p.add(ov.normal.mul(ov.depth));
          const rel = p.sub(this.prev[i]!);
          const vn = ov.normal.mul(rel.dot(ov.normal));
          const vt = rel.sub(vn);
          this.prev[i] = p.sub(vt.mul(1 - FRICTION));
        }
        if (!hit) break;
      }
      this.pos[i] = p;
    }
  }
}

// The half left on the anchor: where it is pinned, carried with the body the
// cuff bit, and the cuff itself, in that body's frame.
interface AnchoredHalf {
  piece: ChainPiece;
  body: CollisionObject2D | null;
  // The chain's end (the cuff's hinge) and the cuff's pose, in the body's
  // frame (the world's when it bit nothing that moves).
  hinge: Vec2;
  centre: Vec2;
  dir: Vec2;
  buriedUnder: Vec2 | null;
}

// A half left on its anchor as the renderers draw it: hinge first, and its
// cuff as it bit.
export interface AnchoredFrame {
  readonly path: readonly Vec2[];
  readonly centre: Vec2;
  readonly dir: Vec2;
  readonly buriedUnder: Vec2 | null;
  readonly body: CollisionObject2D | null;
}

// One frame of the snapped chains' halves, for the renderers. Each path is
// laid from its pinned end, so its links stay put there.
export interface SnapFrame {
  // Every half kept on its anchor, oldest first.
  readonly anchored: readonly AnchoredFrame[];
  // The half on the ball, broken end first, then the loop, then the ball's
  // centre (the tail under the body, as the deployed chain is drawn).
  readonly onBall: readonly Vec2[] | null;
}

export class ChainSnap {
  private ball: BallPlayer | null = null;
  // The chain seen at the last `observe`, by identity: a new `Rope` is a new
  // throw, and a new throw takes the ball's half away.
  private chain: Rope | null = null;
  // The drape of the chain that is out, and its cuff's pose and the body it
  // bit, as of the last step it was out: what a snap is cut from, since the
  // step that snaps it has already let it go.
  private slack: SlackChain | null = null;
  private pose: ManaclePose | null = null;
  private anchor: CollisionObject2D | null = null;
  // The halves kept on their anchors, oldest first, at most `KEPT_HALVES`.
  private anchored: AnchoredHalf[] = [];
  private onBall: ChainPiece | null = null;
  // Snaps seen since the last `reset`, so a tool can count them.
  snaps = 0;

  // Once per sim step, after the step: notice a snap, keep what the next one
  // would be cut from, and step the halves. `sparks` gets the break's burst.
  observe(level: BallLevel | null, delta: number, sparks: SparkSystem | null = null): void {
    const ball = level?.ball ?? null;
    if (ball !== this.ball) {
      this.reset();
      this.ball = ball;
    }
    if (level === null || ball === null) return;
    if (level.chainSnapped) this.split(delta, sparks);
    else if (ball.chain !== null && ball.chain !== this.chain) {
      // A new throw: the chain that is out is the chain, and the ball has
      // one. What snapped on the anchors stays.
      this.onBall = null;
    }
    this.chain = ball.chain;
    this.slack = ball.chainSlack;
    this.pose = ball.chainAnchored ? ball.manaclePose(1) : null;
    this.anchor = ball.chainAnchored ? ball.anchoredTo : null;
    // The ball's half goes when the player lets go, as the chain would have.
    if (this.onBall !== null && !(level.playedInput?.fire.held ?? false)) this.onBall = null;
    // A half whose anchor broke away goes with it.
    this.anchored = this.anchored.filter((a) => !a.body?.removed);
    this.onBall?.step(ball.loopCenter, level.bodies, delta);
    for (const a of this.anchored) a.piece.step(this.hingeAt(a, 1), level.bodies, delta);
  }

  get active(): boolean {
    return this.anchored.length > 0 || this.onBall !== null;
  }

  // The halves as they stand this frame. `alpha` is the render interpolation
  // factor, so the pinned ends are welded to the drawn ball and anchor.
  resolve(alpha: number): SnapFrame | null {
    const ball = this.ball;
    if (ball === null || !this.active) return null;
    const anchored = this.anchored.map((a): AnchoredFrame => {
      const rot = a.body ? a.body.renderRotation(alpha) : 0;
      const origin = a.body ? a.body.renderPosition(alpha) : Vec2.ZERO;
      return {
        path: a.piece.path(alpha, this.hingeAt(a, alpha)),
        centre: origin.add(a.centre.rotated(rot)),
        dir: a.dir.rotated(rot),
        buriedUnder: a.buriedUnder ? a.buriedUnder.rotated(rot) : null,
        body: a.body,
      };
    });
    let onBall: Vec2[] | null = null;
    if (this.onBall !== null) {
      onBall = this.onBall.path(alpha, ball.renderLoopCenter(alpha)).reverse();
      onBall.push(ball.renderPosition(alpha));
    }
    return { anchored, onBall };
  }

  // Forget everything: the level is being replaced.
  reset(): void {
    this.ball = null;
    this.chain = null;
    this.slack = null;
    this.pose = null;
    this.anchor = null;
    this.anchored = [];
    this.onBall = null;
    this.snaps = 0;
  }

  // Cut the drape as it last stood in two at `BREAK_NODE`.
  private split(delta: number, sparks: SparkSystem | null): void {
    const state = this.slack?.nodeState();
    const pose = this.pose;
    if (!state || pose === null) return;
    this.snaps++;
    const n = state.pos.length;
    let length = 0;
    for (let i = 1; i < n; i++) length += state.pos[i - 1]!.distanceTo(state.pos[i]!);
    const rest = length / (n - 1);
    // The ball's half, loop out to the break; the anchor's, hinge back to it.
    const ballPos = state.pos.slice(0, BREAK_NODE + 1);
    const ballPrev = state.prev.slice(0, BREAK_NODE + 1);
    const anchorPos = state.pos.slice(BREAK_NODE).reverse();
    const anchorPrev = state.prev.slice(BREAK_NODE).reverse();
    ChainSnap.recoil(ballPos, ballPrev, delta);
    ChainSnap.recoil(anchorPos, anchorPrev, delta);
    this.onBall = new ChainPiece(ballPos, ballPrev, rest);
    const body = this.anchor;
    const toLocal = (p: Vec2): Vec2 => (body ? p.sub(body.globalPosition).rotated(-body.globalRotation) : p);
    const turn = (v: Vec2): Vec2 => (body ? v.rotated(-body.globalRotation) : v);
    this.anchored.push({
      piece: new ChainPiece(anchorPos, anchorPrev, rest),
      body,
      hinge: toLocal(anchorPos[0]!),
      centre: toLocal(pose.centre),
      dir: turn(pose.dir),
      buriedUnder: pose.buriedUnder ? turn(pose.buriedUnder) : null,
    });
    if (this.anchored.length > KEPT_HALVES) this.anchored.shift();
    const at = state.pos[BREAK_NODE]!;
    sparks?.snapBurst(at.x, at.y);
  }

  // Where the anchor's half is pinned: the cuff's hinge, carried with the body.
  private hingeAt(a: AnchoredHalf, alpha: number): Vec2 {
    if (a.body === null) return a.hinge;
    return a.body.renderPosition(alpha).add(a.hinge.rotated(a.body.renderRotation(alpha)));
  }

  // Each half springs back toward its pin (node 0): the broken end at
  // `SNAP_RECOIL`, nothing at the pin, along the chain toward the node before,
  // written into the Verlet history as a velocity.
  private static recoil(pos: readonly Vec2[], prev: Vec2[], delta: number): void {
    const n = pos.length - 1;
    for (let i = 1; i <= n; i++) {
      const back = pos[i]!.sub(pos[i - 1]!);
      const len = back.length();
      if (len < 1e-9) continue;
      prev[i] = prev[i]!.add(back.mul((SNAP_RECOIL * delta * (i / n)) / len));
    }
  }
}
