// Per-phase velocity and POSITION attribution: which part of the frame gave this
// body this velocity, and which part moved it.
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
// Position is carried alongside velocity because the ratchets are positional:
// depenetration, the grip pin and the rope's correction all move a body without
// touching its velocity, so a body creeping across the level at 0.6 mm/frame
// reports itself at rest to every velocity-shaped tool there is (the settled
// drift `cli scan` flags in `255f`/`326f`/`166f` is exactly this, and the
// question it leaves - which phase moved it - had no answer before).
//
// Nothing here writes to the sim. It reads state at phase boundaries and
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
  // Metres and radians the phase MOVED the body, without necessarily having
  // given it any velocity to move by.
  dx: number;
  dy: number;
  drot: number;
  // The velocity and pose the phase LEFT, so a record is readable without
  // summing the ones before it.
  vx: number;
  vy: number;
  w: number;
  px: number;
  py: number;
  rot: number;
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

// ---- inside the length solve ------------------------------------------------
// `PhaseDelta` says the rope solve moved the ball 27 cm; it cannot say that it
// took ten iterations to do it, that the error grew on every one of them, and
// that the correction direction flipped sign each time. That is a DIVERGING
// solve, and it is the launch class: `session-239f` f192 spun a 12.6 kg weight
// fourteen turns in one frame and hauled the ball 1.2 m after it, out of a 27 cm
// error, and the only way anyone saw it was a temporary console.log inside
// `correctShapePositionAndRotation`.
//
// The unwind is the same story from the other end: a third of its window unused
// with 2 to 10 cm of residual over-length left standing (`session-477f`) is a
// stalled search, and it read as a chain that simply refused to unwind.

export interface SolveBodyTerm {
  id: number; // build index
  // Mechanical advantage: how much of the path's length this body's motion buys.
  ma: number;
  // Torque arm the correction acts on, metres.
  arm: number;
  // The two halves of the effective inverse mass, `1/m` and `arm²/I`, kept apart
  // because which of them dominates is the difference between a correction that
  // translates a body and one that spins it.
  invMass: number;
  invInertiaArm: number;
  // Unit direction the correction pushed this body along. The sign flipping
  // between iterations is the diverging solve's signature.
  dirX: number;
  dirY: number;
}

export interface SolveIteration {
  t: "solve";
  f: number;
  // Which solve ran: the rope's own pass, the winch's held-body pass
  // (`Rope.solveLengthHolding`), or a pass of the coupled scene sweep.
  pass: "length" | "winch" | "sweep";
  iteration: number;
  // Length error (path minus constraint, metres) before and after this
  // iteration. `errorAfter > errorBefore` is the iteration making things worse.
  errorBefore: number;
  errorAfter: number;
  // The monotone guard restored the bodies and halved the step: this iteration
  // did not happen, and the error stands for the unwind and the stall lease.
  undone: boolean;
  bodies: SolveBodyTerm[];
}

export interface UnwindRecord {
  t: "unwind";
  f: number;
  window: number; // rad the unwind was allowed to walk back over
  used: number; // rad it actually walked back
  residual: number; // over-length left standing, metres (negative = under)
  spool: number; // lengthPerRadian at the rotation it settled on, m/rad
  edgeTried: boolean; // reserved for a future edge/bisection fallback
}

export type PhaseRecord = PhaseDelta | ContactImpulse | SolveIteration | UnwindRecord;

interface Snapshot {
  vx: number;
  vy: number;
  w: number;
  px: number;
  py: number;
  rot: number;
}

function stateOf(body: PhysicsBody2D): Snapshot | null {
  const pose = {
    px: body.globalPosition.x,
    py: body.globalPosition.y,
    rot: body.globalRotation,
  };
  if (body instanceof RigidBody2D) {
    return {
      vx: body.linearVelocity.x,
      vy: body.linearVelocity.y,
      w: body.angularVelocity,
      ...pose,
    };
  }
  if (body instanceof CharacterBody2D) {
    return { vx: body.velocity.x, vy: body.velocity.y, w: 0, ...pose };
  }
  return null;
}

export const PhaseTrace = {
  enabled: false,
  frame: 0,
  // Which solve the `SolveIteration` records coming in belong to. The rope
  // itself does not know - `solvePass` is called by the frame, by the winch and
  // by the coupled scene sweep alike - so the caller that does says so, and it
  // is trace-only state that nothing in the sim reads.
  pass: "length" as SolveIteration["pass"],
  // Build indices to watch, or null for every body that can carry a velocity.
  watch: null as Set<number> | null,
  records: [] as PhaseRecord[],
  // Last-seen state per watched body, so a phase reports the change it made
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
      const v = stateOf(body);
      if (v) this.last.set(body.buildIndex, v);
    }
  },

  // Close off a phase: emit one record per watched body whose velocity OR pose
  // the phase changed. Bodies it left alone emit nothing, so a trace is the
  // phases that actually did something.
  mark(phase: string, world: World): void {
    if (!this.enabled) return;
    for (const body of world.bodies) {
      if (body.removed || !this.watches(body)) continue;
      const v = stateOf(body);
      if (!v) continue;
      const prev = this.last.get(body.buildIndex);
      this.last.set(body.buildIndex, v);
      if (!prev) continue; // spawned mid-frame: nothing to compare against
      const dvx = v.vx - prev.vx;
      const dvy = v.vy - prev.vy;
      const dw = v.w - prev.w;
      const dx = v.px - prev.px;
      const dy = v.py - prev.py;
      const drot = v.rot - prev.rot;
      if (dvx === 0 && dvy === 0 && dw === 0 && dx === 0 && dy === 0 && drot === 0) continue;
      this.records.push({
        f: this.frame,
        t: "phase",
        phase,
        body: body.buildIndex,
        name: body.name || body.constructor.name,
        dvx,
        dvy,
        dw,
        dx,
        dy,
        drot,
        vx: v.vx,
        vy: v.vy,
        w: v.w,
        px: v.px,
        py: v.py,
        rot: v.rot,
      });
    }
  },

  // Run `body` with `pass` set, and put it back afterwards. A no-op that still
  // runs the body when tracing is off, so the sim takes the same path either way.
  inPass<T>(pass: SolveIteration["pass"], body: () => T): T {
    const prev = this.pass;
    this.pass = pass;
    try {
      return body();
    } finally {
      this.pass = prev;
    }
  },

  // One iteration of a length solve: what it was handed, what it left, and the
  // per-body terms that decided where the correction went.
  solve(
    iteration: number,
    errorBefore: number,
    errorAfter: number,
    undone: boolean,
    bodies: SolveBodyTerm[],
  ): void {
    if (!this.enabled) return;
    this.records.push({
      f: this.frame,
      t: "solve",
      pass: this.pass,
      iteration,
      errorBefore,
      errorAfter,
      undone,
      bodies: bodies.slice(),
    });
  },

  // What the unwind's search did with the window it was given.
  unwind(window: number, used: number, residual: number, spool: number): void {
    if (!this.enabled) return;
    this.records.push({
      f: this.frame,
      t: "unwind",
      window,
      used,
      residual,
      spool,
      edgeTried: false,
    });
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
