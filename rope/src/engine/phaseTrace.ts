// Per-phase velocity attribution: which part of the frame gave this body this
// velocity.
//
// Some form of this was written by hand in every debugging session there has
// been (`rbtrace.ts`, `_stage2.ts`, `probe*.ts`, `_diag1474a-e`) and thrown away
// afterwards, because the question a velocity bug asks is never "what is the
// velocity" - `cli query` answers that - but "which phase put it there". A
// one-frame +1.2 m/s means one thing if the contact solve did it and quite
// another if the chain's derived-velocity write did.
//
// The chain phase is broken out finely on purpose: push-out, rope solve, unwind,
// stall lease and the derived-velocity write are five separate decisions that
// land on the same body within a few lines of each other, and every ball bug so
// far has been an argument about which of them was right.
//
// Nothing here writes to the sim. It reads velocities at phase boundaries and
// subtracts; with `enabled` false it is one boolean test per boundary.

import type { Vec2 } from "./vec2";
import { CharacterBody2D, RigidBody2D, type PhysicsBody2D } from "./body";
import type { World } from "./world";

export interface PhaseDelta {
  f: number;
  t: "phase";
  phase: string;
  body: number; // build index
  name: string;
  dvx: number;
  dvy: number;
  dw: number;
  // The velocity the phase LEFT, so a record is readable without summing the
  // ones before it.
  vx: number;
  vy: number;
  w: number;
}

export interface ContactImpulse {
  f: number;
  t: "contact";
  a: number; // build index of the constraint's `a`
  b: number;
  aName: string;
  bName: string;
  // Accumulated impulses this frame, normal and tangent (N·s).
  pn: number;
  pt: number;
  nx: number;
  ny: number;
  px: number;
  py: number;
  slipping: boolean;
}

export type PhaseRecord = PhaseDelta | ContactImpulse;

interface Snapshot {
  vx: number;
  vy: number;
  w: number;
}

function velocityOf(body: PhysicsBody2D): Snapshot | null {
  if (body instanceof RigidBody2D) {
    return { vx: body.linearVelocity.x, vy: body.linearVelocity.y, w: body.angularVelocity };
  }
  if (body instanceof CharacterBody2D) {
    return { vx: body.velocity.x, vy: body.velocity.y, w: 0 };
  }
  return null;
}

export const PhaseTrace = {
  enabled: false,
  frame: 0,
  // Build indices to watch, or null for every body that can carry a velocity.
  watch: null as Set<number> | null,
  records: [] as PhaseRecord[],
  // Last-seen velocity per watched body, so a phase reports the change it made
  // rather than the state it left.
  last: new Map<number, Snapshot>(),

  reset(): void {
    this.records.length = 0;
    this.last.clear();
    this.frame = 0;
  },

  watches(body: PhysicsBody2D): boolean {
    return this.watch === null || this.watch.has(body.buildIndex);
  },

  // Seed the per-frame baseline. Call at the top of a level's physics step,
  // before anything moves — a phase's delta is against the previous phase of the
  // same frame, and the first phase's is against the frame's opening state.
  begin(frame: number, world: World): void {
    if (!this.enabled) return;
    this.frame = frame;
    this.last.clear();
    for (const body of world.bodies) {
      if (body.removed || !this.watches(body)) continue;
      const v = velocityOf(body);
      if (v) this.last.set(body.buildIndex, v);
    }
  },

  // Close off a phase: emit one record per watched body whose velocity the phase
  // changed. Bodies it left alone emit nothing, so a trace is the phases that
  // actually did something.
  mark(phase: string, world: World): void {
    if (!this.enabled) return;
    for (const body of world.bodies) {
      if (body.removed || !this.watches(body)) continue;
      const v = velocityOf(body);
      if (!v) continue;
      const prev = this.last.get(body.buildIndex);
      this.last.set(body.buildIndex, v);
      if (!prev) continue; // spawned mid-frame: nothing to compare against
      const dvx = v.vx - prev.vx;
      const dvy = v.vy - prev.vy;
      const dw = v.w - prev.w;
      if (dvx === 0 && dvy === 0 && dw === 0) continue;
      this.records.push({
        f: this.frame,
        t: "phase",
        phase,
        body: body.buildIndex,
        name: body.name || body.constructor.name,
        dvx,
        dvy,
        dw,
        vx: v.vx,
        vy: v.vy,
        w: v.w,
      });
    }
  },

  // One record per solved contact touching a watched body: what the contact
  // solve actually spent, normal and tangent. The phase delta says the contacts
  // gave the ball 1.2 m/s sideways; this says which contact did.
  contact(
    a: PhysicsBody2D,
    b: PhysicsBody2D,
    normalImpulse: number,
    tangentImpulse: number,
    normal: Vec2,
    point: Vec2,
    slipping: boolean,
  ): void {
    if (!this.enabled) return;
    if (!this.watches(a) && !this.watches(b)) return;
    if (normalImpulse === 0 && tangentImpulse === 0) return;
    this.records.push({
      f: this.frame,
      t: "contact",
      a: a.buildIndex,
      b: b.buildIndex,
      aName: a.name || a.constructor.name,
      bName: b.name || b.constructor.name,
      pn: normalImpulse,
      pt: tangentImpulse,
      nx: normal.x,
      ny: normal.y,
      px: point.x,
      py: point.y,
      slipping,
    });
  },
};
