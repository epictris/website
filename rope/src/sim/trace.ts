// Deterministic-replay primitives. Because the ported sim is self-consistent,
// a full session is captured by its per-frame input trace alone: replaying the
// same inputs from the same level reproduces it exactly. Digests let a replay
// assert bit-for-bit reproduction; invariants catch physical nonsense.

import { Vec2 } from "../engine/vec2";
import { StaticBody2D } from "../engine/body";
import { circleOverlap } from "../engine/collision";
import { Hook } from "../classes/hook";
import { LedgeClimbState } from "../classes/states/ledgeClimbState";
import { LedgeHangState } from "../classes/states/ledgeHangState";
import { WallJumpingState } from "../classes/states/wallJumpingState";
import { button, emptyFrameInput, type FrameInput } from "../input/frameInput";
import type { Level } from "../level/level";

// Bit order for the held-action mask in a serialized frame.
export const ACTIONS = [
  "moveLeft",
  "moveRight",
  "jump",
  "retract",
  "extend",
  "fire",
  "retractClick",
  "spawnSmallCircle",
  "spawnLargeCircle",
] as const;
export type Action = (typeof ACTIONS)[number];

export interface SerializedFrame {
  h: number; // bitmask of held actions
  mx: number;
  my: number;
}

export interface Recording {
  level: string;
  frames: SerializedFrame[];
  digests?: Digest[];
  git?: string;
}

export interface Digest {
  frame: number;
  px: number;
  py: number;
  rot: number;
  vx: number;
  vy: number;
  ropeLen: number | null;
  maxRope: number | null;
  state: string;
}

export function serializeInput(input: FrameInput): SerializedFrame {
  let h = 0;
  ACTIONS.forEach((a, i) => {
    if (input[a].held) h |= 1 << i;
  });
  return { h, mx: input.mouseWorldPosition.x, my: input.mouseWorldPosition.y };
}

// Rebuild an input stream from serialized held-bits, deriving pressed/released
// by diffing against the previous frame (stateful — call frames in order).
export function inputDeserializer(): (f: SerializedFrame) => FrameInput {
  let prev: FrameInput = emptyFrameInput();
  return (f: SerializedFrame): FrameInput => {
    const input = emptyFrameInput();
    ACTIONS.forEach((a, i) => {
      input[a] = button((f.h & (1 << i)) !== 0, prev[a]);
    });
    input.mouseWorldPosition = new Vec2(f.mx, f.my);
    prev = input;
    return input;
  };
}

export function digest(level: Level): Digest {
  const p = level.player;
  return {
    frame: level.frame,
    px: p.globalPosition.x,
    py: p.globalPosition.y,
    rot: p.globalRotation,
    vx: p.velocity.x,
    vy: p.velocity.y,
    ropeLen: p.rope ? p.rope.getCurrentLength() : null,
    maxRope: p.rope ? p.rope.maxRopeLength : null,
    state: p.state.constructor.name,
  };
}

export function digestsEqual(a: Digest, b: Digest): boolean {
  return (
    a.px === b.px &&
    a.py === b.py &&
    a.rot === b.rot &&
    a.vx === b.vx &&
    a.vy === b.vy &&
    a.ropeLen === b.ropeLen &&
    a.state === b.state
  );
}

export interface Violation {
  frame: number;
  kind: string;
  detail: string;
}

const RUNAWAY_SPEED = 1e5;
const EMBED_TOLERANCE = 3;

// ---- input-frozen detector -------------------------------------------------
// Flags the "player holds a direction but barely moves" class of bug: with a
// mobile body nearby, holding a direction for a sustained window must produce
// real displacement along it. Pressing into a static wall is exempt (no
// mobile body involved). Frames in deliberate-stationary states (ledge hang /
// climb, wall-jump startup) or with an active rope are exempt — but a state
// merely *thrashing* through Airborne must not reset the window, so the
// streak counts every non-exempt input-held frame regardless of state.

const STUCK_WINDOW = 45; // frames of continuous same-direction input
const STUCK_MIN_DISPLACEMENT = 25; // px along the input direction over the window
const STUCK_MOBILE_DIST = 48; // px — a mobile body this close implicates movers
// Yield exemption (wedge rules: movers push, never freeze): a player being
// displaced backward by a mover is moving, not frozen — the treadmill bug
// class this detector exists for pins the player near zero displacement.
// Two signatures qualify: shoved backward over the whole window, or a
// sustained backward drift in the window's tail (the push phase of a window
// that straddles earlier real progress).
const STUCK_PUSHED_BACK_EXEMPT = 10; // px against the input over the window
const STUCK_YIELD_TAIL = 15; // frames — tail length checked for backward drift
const STUCK_YIELD_DISPLACEMENT = 3; // px backward over the tail counts as yielding

function mobileBodyNear(level: Level): boolean {
  const p = level.player;
  for (const body of level.world.bodies) {
    if (body === p || body.removed || !body.isMobile || !body.hasShape()) continue;
    if (body instanceof Hook) continue;
    const s = body.getShape().shape;
    const bound = s.kind === "circle" ? s.radius : Math.hypot(s.size.x, s.size.y) * 0.5;
    if (body.globalPosition.distanceTo(p.globalPosition) <= bound + STUCK_MOBILE_DIST) return true;
  }
  return false;
}

// A ledge climb is a short scripted traversal (~a second at most); staying in
// LedgeClimbState longer means the climb target is unreachable (e.g. wedged in
// a notch between rects) and the player is locked out of all input.
const CLIMB_STALL_FRAMES = 90;

export class StuckDetector {
  private streak = 0;
  private dir = 0;
  private xs: number[] = [];
  private mobileSeen: boolean[] = [];
  private climbFrames = 0;

  // Call once per frame after level.physicsProcess. Returns a violation when
  // the window criteria trip, then restarts the streak (no per-frame spam).
  push(level: Level, input: FrameInput): Violation | null {
    const p = level.player;

    // Climb-stall check (independent of input — climb ignores input).
    this.climbFrames = p.state instanceof LedgeClimbState ? this.climbFrames + 1 : 0;
    if (this.climbFrames === CLIMB_STALL_FRAMES) {
      return {
        frame: level.frame,
        kind: "climb-stalled",
        detail: `LedgeClimbState for ${CLIMB_STALL_FRAMES}f at (${p.globalPosition.x.toFixed(1)},${p.globalPosition.y.toFixed(1)})`,
      };
    }

    const dir = (input.moveRight.held ? 1 : 0) - (input.moveLeft.held ? 1 : 0);
    const exempt =
      p.rope !== null ||
      p.state instanceof LedgeHangState ||
      p.state instanceof LedgeClimbState ||
      p.state instanceof WallJumpingState;

    if (dir === 0 || exempt || dir !== this.dir) {
      this.dir = dir;
      this.streak = 0;
      this.xs.length = 0;
      this.mobileSeen.length = 0;
      if (dir === 0 || exempt) return null;
    }

    this.streak++;
    this.xs.push(p.globalPosition.x);
    this.mobileSeen.push(mobileBodyNear(level));
    if (this.streak < STUCK_WINDOW) return null;

    const dx = (this.xs[this.xs.length - 1]! - this.xs[0]!) * dir;
    // Peak forward progress within the window, not just endpoint-to-endpoint:
    // a window straddling real progress followed by a mover push-back is
    // movement, not a freeze — the treadmill bug class never advances at all.
    const dxMax = Math.max(...this.xs.map((x) => (x - this.xs[0]!) * dir));
    // Backward drift over the window tail — yielding to an active push.
    const tail = this.xs[this.xs.length - 1 - STUCK_YIELD_TAIL];
    const yielding =
      tail !== undefined &&
      (this.xs[this.xs.length - 1]! - tail) * dir < -STUCK_YIELD_DISPLACEMENT;
    const mobileInvolved = this.mobileSeen.some(Boolean);
    this.xs.shift();
    this.mobileSeen.shift();
    if (
      dxMax < STUCK_MIN_DISPLACEMENT &&
      dx > -STUCK_PUSHED_BACK_EXEMPT &&
      !yielding &&
      mobileInvolved
    ) {
      this.streak = 0;
      this.xs.length = 0;
      this.mobileSeen.length = 0;
      return {
        frame: level.frame,
        kind: "input-frozen",
        detail: `held ${dir > 0 ? "right" : "left"} ${STUCK_WINDOW}f, moved ${dx.toFixed(1)}px (state=${p.state.constructor.name})`,
      };
    }
    return null;
  }
}

// Per-frame sanity checks (ported in spirit from snapshot/InvariantChecker.cs).
export function checkInvariants(level: Level): Violation[] {
  const out: Violation[] = [];
  const p = level.player;
  const frame = level.frame;

  if (!p.globalPosition.isFinite() || !p.velocity.isFinite()) {
    out.push({ frame, kind: "nan", detail: `pos=${p.globalPosition} vel=${p.velocity}` });
    return out; // further checks meaningless
  }
  if (p.velocity.length() > RUNAWAY_SPEED) {
    out.push({ frame, kind: "runaway-speed", detail: `|vel|=${p.velocity.length().toFixed(1)}` });
  }
  if (p.rope) {
    const len = p.rope.getCurrentLength();
    // While the hook is still an unanchored projectile, maxRopeLength is reset to
    // the path length every frame and the hook moves after the rope step, so the
    // length legitimately exceeds it — only meaningful once the rope is anchored.
    const anchored = !(p.rope.end.contact.obj instanceof Hook);
    if (anchored && len > p.rope.maxRopeLength + 5) {
      out.push({
        frame,
        kind: "rope-over-length",
        detail: `len=${len.toFixed(1)} > max=${p.rope.maxRopeLength.toFixed(1)}`,
      });
    }
    if (Number.isNaN(len)) out.push({ frame, kind: "rope-nan", detail: "rope length NaN" });
  }
  const shape = p.getShape().shape;
  if (shape.kind === "circle") {
    for (const body of level.world.bodies) {
      if (!(body instanceof StaticBody2D) || !body.hasShape()) continue;
      const ov = circleOverlap(p.globalPosition, shape.radius, body.getShape());
      if (ov && ov.depth > EMBED_TOLERANCE) {
        out.push({
          frame,
          kind: "player-embedded",
          detail: `depth=${ov.depth.toFixed(2)} in ${body.name || "static"}`,
        });
        break;
      }
    }
  }
  return out;
}
