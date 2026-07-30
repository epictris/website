// The data an A/B against another revision compares: the whole world, per frame,
// from the fork frame on.
//
// It is deliberately NOT `WorldDigest`. A comparison runs the current tooling
// against an OLD revision's physics (see `cli compare`), and a body's build
// index is a field the old engine does not have; reading it there would silently
// produce `undefined` ids and a diff that could not line the two runs up. So the
// id is derived here, in the tooling that both sides share: a body's position in
// the movable-body list. Both sides compute it the same way by construction, and
// a body set that has genuinely diverged shows up as a body count difference
// rather than as a silently mismatched pairing.

import { CharacterBody2D, RigidBody2D } from "../engine/body";
import { BallLevel } from "../level/ballLevel";
import type { Level } from "../level/level";

export interface CompareBody {
  id: number;
  type: string;
  px: number;
  py: number;
  rot: number;
  vx: number;
  vy: number;
  w: number;
}

export interface CompareFrame {
  frame: number;
  bodies: CompareBody[];
  chain: { nodes: number; len: number; max: number; slack: number } | null;
}

export function compareFrame(level: Level | BallLevel): CompareFrame {
  const bodies: CompareBody[] = [];
  for (const body of level.world.bodies) {
    if (body.removed) continue;
    const rigid = body instanceof RigidBody2D ? body : null;
    const character = body instanceof CharacterBody2D ? body : null;
    if (!rigid && !character) continue;
    const v = rigid ? rigid.linearVelocity : character!.velocity;
    bodies.push({
      id: bodies.length,
      type: body.name || body.constructor.name,
      px: body.globalPosition.x,
      py: body.globalPosition.y,
      rot: body.globalRotation,
      vx: v.x,
      vy: v.y,
      w: rigid ? rigid.angularVelocity : 0,
    });
  }
  const rope = level instanceof BallLevel ? level.ball.chain : level.player.rope;
  return {
    frame: level.frame,
    bodies,
    chain: rope
      ? {
          nodes: rope.path().length,
          len: rope.getCurrentLength(),
          max: rope.maxRopeLength,
          slack: rope.blockedSlack,
        }
      : null,
  };
}

export interface BodyDelta {
  id: number;
  type: string;
  drift: number; // metres between the two runs at the last compared frame
  dv: number; // m/s difference in speed
  dw: number; // rad/s difference in spin
}

export interface CompareDiff {
  frames: number;
  firstDivergentFrame: number | null;
  firstDivergentBody: string | null;
  bodies: BodyDelta[];
  chainLengthDelta: number | null;
  maxDrift: number;
}

// Above this the two runs have genuinely parted company rather than differing in
// the last bits; the same 1 px the replay divergence check uses.
const DIVERGENCE_EPSILON = 0.01;

export function diffCompareFrames(oldSide: CompareFrame[], newSide: CompareFrame[]): CompareDiff {
  const frames = Math.min(oldSide.length, newSide.length);
  let firstDivergentFrame: number | null = null;
  let firstDivergentBody: string | null = null;
  let maxDrift = 0;
  for (let i = 0; i < frames; i++) {
    const a = oldSide[i]!;
    const b = newSide[i]!;
    if (a.bodies.length !== b.bodies.length) {
      if (firstDivergentFrame === null) {
        firstDivergentFrame = b.frame;
        firstDivergentBody = `body count (${a.bodies.length} vs ${b.bodies.length})`;
      }
      continue;
    }
    for (let k = 0; k < a.bodies.length; k++) {
      const x = a.bodies[k]!;
      const y = b.bodies[k]!;
      const drift = Math.hypot(x.px - y.px, x.py - y.py);
      maxDrift = Math.max(maxDrift, drift);
      if (drift > DIVERGENCE_EPSILON && firstDivergentFrame === null) {
        firstDivergentFrame = b.frame;
        firstDivergentBody = `body#${y.id} ${y.type}`;
      }
    }
  }

  const lastA = oldSide[frames - 1];
  const lastB = newSide[frames - 1];
  const bodies: BodyDelta[] = [];
  if (lastA && lastB) {
    for (let k = 0; k < Math.min(lastA.bodies.length, lastB.bodies.length); k++) {
      const x = lastA.bodies[k]!;
      const y = lastB.bodies[k]!;
      bodies.push({
        id: y.id,
        type: y.type,
        drift: Math.hypot(x.px - y.px, x.py - y.py),
        dv: Math.hypot(y.vx, y.vy) - Math.hypot(x.vx, x.vy),
        dw: y.w - x.w,
      });
    }
  }
  return {
    frames,
    firstDivergentFrame,
    firstDivergentBody,
    bodies,
    chainLengthDelta:
      lastA?.chain && lastB?.chain ? lastB.chain.len - lastA.chain.len : null,
    maxDrift,
  };
}
