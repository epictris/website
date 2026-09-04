// One frame of the simulation, as data.
//
// Every quantitative question a debugging session asked used to be a code
// change: the ball's angular velocity at a frame, a body's position, how deep
// something was embedded, what the chain's length was made of — each answered by
// editing `cli.ts` or writing a throwaway script, and each thrown away
// afterwards. This is the standing form of that probe. `cli query` prints it;
// nothing here decides anything, it only reads the sim.
//
// The JSON is the contract: stable keys, metres and rad/s, no formatted strings
// (`cli fork`'s px-formatted speed is exactly what this replaces). Anything a
// caller has to parse out of prose is a key that should be here instead.

import { Vec2 } from "../engine/vec2";
import {
  Area2D,
  CharacterBody2D,
  RigidBody2D,
  type CollisionObject2D,
  type PhysicsBody2D,
} from "../engine/body";
import { circleOverlap } from "../engine/collision";
import { shapeContacts } from "../engine/manifold";
import { shapeVertices, type Shape } from "../engine/shapes";
import type { World } from "../engine/world";
import { RopeWrap } from "../lib/ropeContact";
import { Hook } from "../classes/hook";
import { BallHook } from "../classes/ballHook";
import { WrapDirection } from "../lib/types";
import { BallLevel } from "../level/ballLevel";
import type { Level } from "../level/level";
import type { Rope } from "../classes/rope";

export interface ShapeView {
  kind: Shape["kind"];
  radius?: number;
  w?: number;
  h?: number;
  verts?: number;
}

export interface EmbedView {
  depth: number; // metres inside the other body's surface
  into: number | null; // build index of the body it is inside, null for unnamed
  intoName: string;
}

export interface BodyView {
  id: number; // build-order index (see CollisionObject2D.buildIndex)
  name: string;
  type: string; // class name — RigidBody2D, BallPlayer, StaticBody2D, …
  px: number;
  py: number;
  rot: number;
  vx: number;
  vy: number;
  w: number;
  speed: number;
  mass: number | null;
  kinematicRotation: boolean;
  shapes: ShapeView[];
  // Deepest overlap with the rest of the scene right now, or null if clear. The
  // most-asked question of every embedding bug (`1474f`), and the one the
  // digests never carried.
  embed: EmbedView | null;
  // Where stiction has hold, if anywhere: the anchor is a world point the body's
  // along-surface position is pinned to.
  stickAnchor: { x: number; y: number } | null;
  ungrippedFrames: number;
}

export interface ChainNodeView {
  px: number;
  py: number;
  body: number; // build index of the body the node rides on
  bodyName: string;
  shapeIndex: number;
  span: "attachment" | "wrap-cw" | "wrap-ccw";
}

export interface ChainView {
  nodes: ChainNodeView[];
  currentLength: number;
  maxRopeLength: number;
  // What the solver actually enforces: maxRopeLength + the blocked-length lease.
  constraintLength: number;
  blockedSlack: number;
  stalledLength: number;
  // Consecutive frames the winch stall has been letting length out (ball only —
  // it is the level driver that counts, see BallLevel.chainStallFrames).
  stallRun: number;
  anchored: boolean;
  // What the chain phase DECIDED this frame, as `ChainDigest` carries it (see
  // sim/trace.ts, which explains why each is here). Zero for the grapple rope,
  // which is steered by nothing and whose caller measures no push-out.
  aimSpin: number;
  unwindRefund: number;
  geometryPush: number;
  winchBudget: number;
  pushCredit: number;
  // Build index of the body the far end sits on, null while it is still a hook
  // in flight.
  anchorBody: number | null;
}

export interface AvatarView {
  px: number;
  py: number;
  rot: number;
  vx: number;
  vy: number;
  w: number;
  speed: number;
  state: string;
  supportBody: string | null;
}

export interface FrameView {
  frame: number;
  avatar: AvatarView;
  chain: ChainView | null;
  bodies: BodyView[];
}

// A body's name in tool output. Normally its build index; when this tooling is
// pointed at an OLD revision's physics (see `cli compare`) that field does not
// exist yet, and the body's position in the world's list is the honest stand-in
// — every body still gets a distinct name, which is what the output is for.
export function bodyId(body: CollisionObject2D, listIndex: number): number {
  return Number.isInteger(body.buildIndex) && body.buildIndex >= 0 ? body.buildIndex : listIndex;
}

function shapeView(s: Shape): ShapeView {
  if (s.kind === "circle") return { kind: s.kind, radius: s.radius };
  if (s.kind === "rect") return { kind: s.kind, w: s.size.x, h: s.size.y };
  return { kind: s.kind, verts: shapeVertices(s).length };
}

// Whether a body is geometry another body can be inside. Areas and `passable`
// bodies are pass-through, so an overlap with one is not an embedding.
function isSolidGeometry(body: CollisionObject2D): boolean {
  return !(body instanceof Area2D) && !body.passable;
}

// The deepest overlap of `body` with the solid geometry around it, measured the
// same way the solver measures a contact: a circle through `circleOverlap`, a
// vertex shape through its manifold. Exported because `cli scan` asks the same
// question of every frame.
//
// `skin` inflates the query so a body that is merely *touching* still answers -
// which is what "what is it resting on" needs and what "how far is it embedded"
// must not have. The reported depth is inflated by the same amount, so a caller
// passing a skin is asking about contact and not about penetration.
export function deepestEmbedding(world: World, body: PhysicsBody2D, skin = 0): EmbedView | null {
  let worst: EmbedView | null = null;
  const consider = (depth: number, other: CollisionObject2D): void => {
    if (depth <= 0) return;
    if (worst && worst.depth >= depth) return;
    worst = { depth, into: Number.isInteger(other.buildIndex) ? other.buildIndex : null, intoName: other.name || other.constructor.name };
  };
  if (body.removed || !body.hasShape() || !isSolidGeometry(body)) return null;
  for (const bs of body.getShapes()) {
    for (const other of world.bodies) {
      if (other === body || other.removed || !other.hasShape()) continue;
      if (body.exceptions.has(other.id)) continue;
      if (!isSolidGeometry(other)) continue;
      for (const os of other.getShapes()) {
        if (bs.shape.kind === "circle") {
          const ov = circleOverlap(bs.globalPosition, bs.shape.radius + skin, os);
          if (ov) consider(ov.depth, other);
        } else {
          for (const c of shapeContacts(bs, os, skin)) consider(c.depth, other);
        }
      }
    }
  }
  return worst;
}

// The chain phase's own decisions, which are the level driver's and not the
// rope's; zeroed for a driver that makes none (see `ChainPhaseView`).
interface ChainPhaseView {
  aimSpin: number;
  unwindRefund: number;
  winchBudget: number;
  pushCredit: number;
}

const NO_CHAIN_PHASE: ChainPhaseView = {
  aimSpin: 0,
  unwindRefund: 0,
  winchBudget: 0,
  pushCredit: 0,
};

function chainView(
  rope: Rope | null,
  anchored: boolean,
  stallRun: number,
  phase: ChainPhaseView,
): ChainView | null {
  if (!rope) return null;
  return {
    nodes: rope.path().map((n) => {
      const p = n.contact.globalPosition;
      const span =
        n instanceof RopeWrap
          ? n.wrapDir === WrapDirection.Clockwise
            ? ("wrap-cw" as const)
            : ("wrap-ccw" as const)
          : ("attachment" as const);
      return {
        px: p.x,
        py: p.y,
        body: n.contact.obj.buildIndex,
        bodyName: n.contact.obj.name || n.contact.obj.constructor.name,
        shapeIndex: n.contact.shapeIndex,
        span,
      };
    }),
    currentLength: rope.getCurrentLength(),
    maxRopeLength: rope.maxRopeLength,
    constraintLength: rope.constraintLength,
    blockedSlack: rope.blockedSlack,
    stalledLength: rope.stalledLength,
    stallRun,
    anchored,
    aimSpin: phase.aimSpin,
    unwindRefund: phase.unwindRefund,
    geometryPush: rope.geometryPush ?? 0,
    winchBudget: phase.winchBudget,
    pushCredit: phase.pushCredit,
    anchorBody: anchorBodyOf(rope),
  };
}

// The body the rope's far end sits on, or null while that end is a hook still in
// flight — which is not a body in the scene this view describes.
function anchorBodyOf(rope: Rope): number | null {
  const obj = rope.end.contact.obj;
  return obj instanceof Hook || obj instanceof BallHook ? null : obj.buildIndex;
}

function bodyViews(world: World): BodyView[] {
  const out: BodyView[] = [];
  for (let i = 0; i < world.bodies.length; i++) {
    const body = world.bodies[i]!;
    if (body.removed || !body.hasShape()) continue;
    const rigid = body instanceof RigidBody2D ? body : null;
    const character = body instanceof CharacterBody2D ? body : null;
    // Statics are listed too: their geometry is what everything else is measured
    // against, and a scripted mover's pose is a legitimate question. They simply
    // carry no velocity.
    const vel = rigid ? rigid.linearVelocity : character ? character.velocity : Vec2.ZERO;
    const stickAnchor = rigid ? rigid.stickAnchorWorld() : null;
    out.push({
      id: bodyId(body, i),
      name: body.name,
      type: body.constructor.name,
      px: body.globalPosition.x,
      py: body.globalPosition.y,
      rot: body.globalRotation,
      vx: vel.x,
      vy: vel.y,
      w: rigid ? rigid.angularVelocity : 0,
      speed: vel.length(),
      mass: rigid ? rigid.mass : null,
      kinematicRotation: rigid ? rigid.kinematicRotation : false,
      shapes: body.getShapes().map((s) => shapeView(s.shape)),
      embed: rigid || character ? deepestEmbedding(world, body) : null,
      stickAnchor: stickAnchor ? { x: stickAnchor.x, y: stickAnchor.y } : null,
      ungrippedFrames: rigid ? rigid.ungrippedFrames : 0,
    });
  }
  return out;
}

export function frameView(level: Level | BallLevel): FrameView {
  if (level instanceof BallLevel) {
    const b = level.ball;
    return {
      frame: level.frame,
      avatar: {
        px: b.globalPosition.x,
        py: b.globalPosition.y,
        rot: b.globalRotation,
        vx: b.linearVelocity.x,
        vy: b.linearVelocity.y,
        // The one field no avatar digest ever carried, and the one the
        // no-rolling regression moved (session-314f).
        w: b.angularVelocity,
        speed: b.linearVelocity.length(),
        state: b.chainAnchored ? "BallAnchored" : b.chain ? "BallFiring" : "Ball",
        supportBody: supportOf(level.world, b),
      },
      chain: chainView(b.chain, b.chainAnchored, level.chainStallFrames, {
        aimSpin: level.aimSpin,
        unwindRefund: level.chainUnwindRefund,
        winchBudget: level.chainWinchSpeedBudget,
        pushCredit: level.chainPushOutCredit,
      }),
      bodies: bodyViews(level.world),
    };
  }
  const p = level.player;
  const state = p.state as { supportBody?: PhysicsBody2D | null };
  return {
    frame: level.frame,
    avatar: {
      px: p.globalPosition.x,
      py: p.globalPosition.y,
      rot: p.globalRotation,
      vx: p.velocity.x,
      vy: p.velocity.y,
      w: 0,
      speed: p.velocity.length(),
      state: p.state.constructor.name,
      supportBody: state.supportBody
        ? state.supportBody.name || state.supportBody.constructor.name
        : null,
    },
    chain: chainView(p.rope, p.rope !== null, 0, NO_CHAIN_PHASE),
    bodies: bodyViews(level.world),
  };
}

// What the ball is resting on, for the frames where "on what?" is the question.
// The ball has no support-body state of its own (it is a rigid body, not a state
// machine), so this is the nearest solid geometry within a contact's reach - a
// resting body is pushed to zero overlap and then re-separated by the frame's
// gravity step, so a strict overlap test answers "nothing" on most frames.
const SUPPORT_SKIN = 0.01;

function supportOf(world: World, body: PhysicsBody2D): string | null {
  const near = deepestEmbedding(world, body, SUPPORT_SKIN);
  return near ? near.intoName : null;
}
