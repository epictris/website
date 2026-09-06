// Scripted-mover builders shared by hand-written level inits (game-design.md:
// rects only move on authored paths - these are the authored paths), and the
// motion of the two the FILE can author: the pendulum on a bearing
// (`LevelBodyData.swingAmp`) and the body that travels a route (`moveNodes`).
//
// The route's geometry is not here. A route and a camera path are the same
// object - an authored Bezier curve with a direction, an arc length and
// per-node keyframes - so the flattening, the arc-length index and the key
// tracks are `lib/path.ts` and `lib/keyframes.ts`, and what is left in this
// file is the part that is about TIME: how far along a body is on a given
// frame, which way that has turned it, and how a keyed speed makes the first of
// those an integral rather than a division.

import { Vec2 } from "../engine/vec2";
import { AnimatableBody2D } from "../engine/body";
import { rectShape } from "../engine/shapes";
import {
  PATH_FLATTEN_STEP,
  buildPolylineIndex,
  flattenPathNodes,
  pointAtArcLength,
  tangentAngleAt,
  type PathNode,
  type PolylineIndex,
} from "../lib/path";
import { buildKeyTrack, keyValueAt, type KeyTrack } from "../lib/keyframes";
import type { Level } from "./level";
import { moveModeCloses, type MoveEase, type MoveMode } from "./levelFormat";

// Scripted-mover update: sets the body's transform for the given sim time.
// Deterministic - must be a pure function of time (frame * dt), so a replay
// lands every mover in the same place on the same frame. Keep contact speeds
// under ~2 px/frame so movers can't trip the embed invariant.
//
// `dt` is the step the caller is about to commit the move over, and it is here
// for exactly one thing: a motion that JUMPS (a `repeat` route reaching the end
// of its run) has to be able to say so, and saying so means comparing this
// instant with one step ago. Handing the script the step keeps that a question
// about the FUNCTION rather than about the last frame, so the rule above holds -
// a script that remembered where it was would be a mover a replay could not
// reproduce. Every motion that does not jump ignores it.
export type MoverScript = (body: AnimatableBody2D, time: number, dt: number) => void;

// How far a kinematic pendulum has swung from its rest angle, `time` seconds in:
// a sine of the authored half-amplitude (see `LevelBodyData.swingAmp`).
//
// Its own function rather than an expression inside the script below, because
// the script is the only thing that should have to know a body is involved: this
// is the statement, and the script is where it is written onto something.
// Deliberately NOT exported - `cli movers` asserts the arc against the sine
// written out longhand, which is a check rather than a restatement.
//
// An OFFSET rather than an angle, because a route may have turned the body too
// (`moveAlign`, `MoveNodeData.rot`) and a pendulum hung from a travelling cart
// swings about wherever the cart has carried it to. The pose is the sum of what
// each authored motion asks for, and only an offset can be summed.
//
// `phase` is in CYCLES: the whole point of the field is that a quarter of a
// swing is 0.25 rather than π/2.
function swingOffsetAt(amp: number, period: number, phase: number, time: number): number {
  if (period <= 0) return 0;
  return amp * Math.sin(2 * Math.PI * (time / period + phase));
}

// A route as the mover travels it: the authored nodes flattened into a polyline
// of WORLD OFFSETS from the pose the body was built at, arc-length indexed, with
// the node keys laid out along it. Built once, at load, because nothing about a
// route changes at runtime.
//
// Offsets rather than positions so the body's own pose stays the thing the whole
// motion is measured from - node zero is the body, and a body at distance 0
// stands exactly where it was drawn.
//
// `closing` is the leg home. A `loop` is flattened with node zero repeated at
// the end, so the closing leg is a Bezier edge like any other (its shape is node
// zero's `in` handle against the last node's `out`) rather than a straight line
// spliced on afterwards - which is what lets a circuit be genuinely round.
export interface MoveRoute {
  readonly index: PolylineIndex;
  readonly mode: MoveMode;
  readonly total: number;
  // The rot and speed keys, laid out in metres of arc length (see
  // `MoveNodeData`). Empty = no node keys that field, which is every route
  // authored before keys existed.
  //
  // `speedKeys` is held rather than folded away into `pace` because the EDITOR
  // needs the value a node would have anyway, to show as the placeholder its key
  // field starts from. Rebuilding the track there instead is what it did first,
  // and it silently disagreed with this one on a `loop`: the closing repeat of
  // node zero (see `keyOf` below) is in this track and was not in that one, so
  // the panel offered the last key's value where the motion was already easing
  // back toward node zero's - a placeholder that changes the motion when it is
  // typed in, which is the one thing a placeholder must not do.
  readonly rotKeys: KeyTrack;
  readonly speedKeys: KeyTrack;
  // The PACE table: arc lengths up the route against the seconds it takes to
  // reach each of them at the authored speeds. Null when no node keys a speed.
  //
  // NULL IS THE POINT OF IT. With one speed for the whole route the trip time is
  // a division and the distance at a fraction of it is a multiplication, which
  // is the arithmetic every route had before keys existed and the arithmetic
  // every recorded replay was simulated through. A table would give the same
  // answer to within a rounding error, and a rounding error is exactly what a
  // replay cannot afford - so a route that keys no speed does not build one and
  // takes the closed form below.
  //
  // Sampled at its OWN fixed step rather than at the polyline's vertices, and
  // that is not a detail: a straight leg flattens to its two endpoints (a cubic
  // with no handles contributes nothing but its endpoint), so a table built on
  // the vertices would have exactly one entry across a straight run and read a
  // speed that ramps along it as one flat average. The geometry's resolution is
  // about how bent the route is; the pace's is about how fast the speed changes,
  // and the two have no reason to be the same list.
  readonly pace: { readonly s: readonly number[]; readonly t: readonly number[] } | null;
  // One end-to-end trip, in seconds: `total / speed` with no speed keys, and the
  // last entry of the pace table with them.
  readonly traverse: number;
}

// Below this a speed is treated as a stop rather than obeyed: the time to cross
// any length at it is unbounded, so a keyed zero would be a body that never
// reaches the next node and a table full of infinities. A tenth of a millimetre
// a second is stopped as far as anything on screen is concerned.
const MIN_ROUTE_SPEED = 1e-4;

// Metres of route per entry of the pace table (see `MoveRoute.pace`). The
// flattening's own step, because it is the same kind of answer to the same kind
// of question - how finely does a curve have to be cut before a straight-line
// reading of it is indistinguishable - and a second number would be a second
// thing to tune for no reason.
const PACE_STEP = PATH_FLATTEN_STEP;

// Turn the authored nodes into one.
//
// `nodes` are in the BODY's own frame (see `MoveNodeData`) and `rot` is the pose
// it was built at, so the whole route is turned into world offsets here and
// nothing downstream rotates anything - the same one-transform-at-construction
// rule `buildPolylineIndex` states for camera paths.
export function buildMoveRoute(
  nodes: readonly PathNode[],
  mode: MoveMode,
  rot: number,
  speed: number,
  nodeRot: readonly (number | undefined)[],
  nodeSpeed: readonly (number | undefined)[],
): MoveRoute {
  // A loop is the node list with node zero repeated: the closing leg is then an
  // ordinary Bezier edge, and the repeat also lands node zero's keys at BOTH
  // ends of the arc length, which is what makes a keyed value continuous round
  // a lap instead of stepping at the seam.
  const closed = moveModeCloses(mode) && nodes.length > 1;
  const seq = closed ? [...nodes, nodes[0]!] : nodes;
  const flat = flattenPathNodes(seq);
  const index = buildPolylineIndex(flat.points, Vec2.ZERO, rot, flat.nodeAt);
  const keyOf = (v: readonly (number | undefined)[]): (number | undefined)[] =>
    closed ? [...v, v[0]] : [...v];
  const rotKeys = buildKeyTrack(keyOf(nodeRot), index.nodeS);
  const speedKeys = buildKeyTrack(keyOf(nodeSpeed), index.nodeS);
  const base = Math.max(MIN_ROUTE_SPEED, speed);
  const pace = speedKeys.length ? paceTable(index.total, speedKeys, base) : null;
  return {
    index,
    mode,
    total: index.total,
    rotKeys,
    speedKeys,
    pace,
    traverse: pace ? pace.t[pace.t.length - 1]! : index.total / base,
  };
}

// The pace table: how many seconds it takes to reach each of a run of arc
// lengths up the route, given a speed that varies along it.
//
// This is the whole of what keyed speeds cost, and building it once is what
// keeps the motion a PURE FUNCTION OF THE FRAME. `ds/dt = v(s)` has no closed
// form for a smoothstepped v, and integrating it a frame at a time would make
// where the body is depend on how it got there - a mover's one inviolable rule
// broken (see `MoverScript`), and a replay that lands the platform somewhere
// else. Inverting a table built at load has neither problem: the table is the
// same on every machine and on every frame.
//
// Per step the speed is taken as LINEAR in `s` between its two ends, and the
// time to cross it is the exact integral of 1/v for that:
//
//   ∫ ds / v  =  L · ln(v1/v0) / (v1 - v0)
//
// which is `L / v` when the two agree. Exact for a linear v rather than a
// trapezoid on 1/v, so what is left is the difference between the smoothstep
// and its chord over one step.
function paceTable(
  total: number,
  keys: KeyTrack,
  base: number,
): { s: number[]; t: number[] } {
  const at = (x: number): number => Math.max(MIN_ROUTE_SPEED, keyValueAt(keys, x, base));
  const steps = Math.max(1, Math.ceil(total / PACE_STEP));
  const s = [0];
  const t = [0];
  for (let i = 1; i <= steps; i++) {
    const a = ((i - 1) / steps) * total;
    const b = (i / steps) * total;
    const len = b - a;
    const v0 = at(a);
    const v1 = at(b);
    s.push(b);
    t.push(t[i - 1]! + (len <= 0 ? 0 : v0 === v1 ? len / v0 : (len * Math.log(v1 / v0)) / (v1 - v0)));
  }
  return { s, t };
}

// Where `s` metres along the route is, as an offset from the body's built pose.
//
// Taken modulo the lap on a `loop` and clamped on the two open modes, so neither
// the wrap at the end of a circuit nor a rounding error at the far end of a
// shuttle is a caller's problem. A lap has no end to fall off, which is what
// makes the modulo the right answer there and the clamp the right one otherwise.
export function pointAlong(route: MoveRoute, s: number): Vec2 {
  const total = route.total;
  if (moveModeCloses(route.mode) && total > 0) {
    return pointAtArcLength(route.index, ((s % total) + total) % total);
  }
  return pointAtArcLength(route.index, s);
}

// How far through a traverse the body is at fraction `t` of it (see `MoveEase`).
// Every one of these maps 0 to 0 and 1 to 1 - an ease redistributes a trip and
// never shortens it - and what distinguishes them is the RATE at each end, which
// is what decides whether a there-and-back turns round smoothly or reverses.
export function easeFraction(ease: MoveEase, t: number): number {
  switch (ease) {
    // Zero rate at both ends: the body eases out of each and turns round with no
    // step in velocity at all.
    case "sine":
      return (1 - Math.cos(Math.PI * t)) / 2;
    // Zero rate leaving, full rate arriving - so the near end is smooth and the
    // far end is the hard turn.
    case "easeIn":
      return t * t;
    // ...and the mirror of it: full rate leaving, settling into the far end.
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    default:
      return t;
  }
}

// The arc length a fraction `u` of one traverse lands on.
//
// With no speed keys this is `u × total`, which is what it always was: one speed
// means arc length and time are proportional, and the fraction of the trip IS
// the fraction of the route. With them it is the table inverted - the time `u`
// of a traverse takes, and the vertex that time reaches - so `u` is a fraction
// of the TRIP rather than of the distance, which is what makes a stretch keyed
// twice as fast take half as long to cross.
//
// That distinction is also what lets the ease keep meaning what it means: the
// ease reshapes progress through the trip, the speed keys say how the trip maps
// onto the route, and the two compose without either having to know about the
// other.
export function distanceAtFraction(route: MoveRoute, u: number): number {
  const f = Math.min(Math.max(u, 0), 1);
  const pace = route.pace;
  if (!pace) return f * route.total;
  const want = f * route.traverse;
  // A linear scan, like `pointAtArcLength`'s: the table is walked once per mover
  // per frame and the scan is the version that is obviously right.
  for (let i = 1; i < pace.t.length; i++) {
    const t0 = pace.t[i - 1]!;
    const t1 = pace.t[i]!;
    if (want > t1) continue;
    const span = t1 - t0;
    const s0 = pace.s[i - 1]!;
    if (span <= 0) return s0;
    return s0 + (pace.s[i]! - s0) * ((want - t0) / span);
  }
  return route.total;
}

// Where along the route the body is, `time` seconds in: the whole of the motion,
// as one distance.
//
// A CYCLE is one lap of a `loop`, one there-and-back of a `backAndForth` and one
// end-to-end trip of a `repeat`, which is what makes `movePhase` mean the same
// thing on all three - 0.5 is half way round a lap, the far end of a shuttle,
// and half way along a run.
export function moveDistanceAt(
  route: MoveRoute,
  phase: number,
  ease: MoveEase,
  time: number,
): number {
  if (route.total <= 0 || route.traverse <= 0) return 0;
  if (route.mode === "backAndForth") {
    // Two traverses to a cycle: out on the first, back on the second. `leg` is
    // the fraction of the OUTWARD trip either way, so the return really is the
    // outward journey played backwards - the same route, the same speed profile
    // mirrored, which is why an ease's rate at an end decides how the turn feels.
    const v = fract(time / (2 * route.traverse) + phase) * 2;
    return distanceAtFraction(route, easeFraction(ease, v <= 1 ? v : 2 - v));
  }
  const u = fract(time / route.traverse + phase);
  // A lap has no ends, so nothing to ease at; a repeat has one of each and reads
  // the ease like a shuttle does (see `moveModeEases`).
  return distanceAtFraction(route, route.mode === "loop" ? u : easeFraction(ease, u));
}

// The fractional part, on the positive side: a negative phase or a negative time
// wraps into the cycle rather than out of it.
function fract(x: number): number {
  return ((x % 1) + 1) % 1;
}

// Which way the route has the body facing, `s` metres along it - the angle
// `moverScript` writes, or ADDS to the pose the body was drawn at when the route
// does not aim it.
//
// An aligned body's rotation IS the route's own direction, not a turn measured
// from where it started. That distinction is the whole of the field: `moveAlign`
// says the track decides which way the body faces, exactly as the route already
// decides where it is, so the drawn rotation stops being an input to rotation
// the way the drawn position stopped being an input to position past node zero.
//
// It is the one place a mover's pose at time zero is not the pose the file drew,
// and the alternative is worse. Measured as the change since the start, a cart
// drawn level on a track that sets off down a 40 degree slope keeps a 40 degree
// error for the whole route: level at the top where the track is steep, and 80
// degrees nose-down at the far end where the track is only 40. It would ride
// beside its rails rather than on them, which is the one thing align is for.
// A cart drawn ON its track is unmoved either way, because there the two agree -
// so what the absolute form costs is nothing an author who drew it right can
// see, and what it buys is that one who did not is corrected onto the rails.
//
// `MoveNodeData.rot` adds on top of whichever it is, which is what makes a key a
// correction to the track rather than a replacement for it.
export function moveAngleAt(route: MoveRoute, align: boolean, s: number): number {
  return (
    (align ? tangentAngleAt(route.index, s, moveModeCloses(route.mode)) : 0) +
    keyValueAt(route.rotKeys, s, 0)
  );
}

// The authored motion of a mover, as the one script that drives it.
//
// One script rather than two composed, because the two motions meet on the same
// field: a route may turn the body (`moveAlign`, `MoveNodeData.rot`) and a
// pendulum certainly does, and two scripts each WRITING `globalRotation` would
// mean the later one silently won. The pose is the SUM of what the authored
// motions ask for, and summing it is the only way to say that.
//
// Everything is measured from the pose the body was BUILT at: the route's node
// zero is the body's own origin and the swing's rest angle is the angle it was
// mounted at, which is the same statement `RigidBody2D.pivotSpring.restAngle`
// makes. So a mover at time zero stands exactly where the file drew it, phase
// permitting.
export function moverScript(opts: {
  base: Vec2;
  restRot: number;
  route: {
    route: MoveRoute;
    phase: number;
    ease: MoveEase;
    align: boolean;
  } | null;
  swing: { amp: number; period: number; phase: number } | null;
}): MoverScript {
  const { base, restRot, route, swing } = opts;
  return (body, time, dt) => {
    let pos = base;
    // An ALIGNED route aims the body outright rather than turning it from the
    // pose it was drawn at (see `moveAngleAt`), so the drawn angle is the base
    // only where nothing else is aiming it.
    let rot = route?.align ? 0 : restRot;
    // A `repeat` JUMPS home at the end of its run, and the jump is not motion:
    // read off the transform delta it would be a contact velocity of tens of
    // metres a second, thrown for one frame at whatever is standing on the body.
    // The wrap is detected rather than remembered - the distance falls where it
    // rose, and asking the motion where it was a step ago is a question a pure
    // function of time can answer - so the mover stays a pure function of the
    // frame with no state to get out of step with a replay.
    let jumped = false;
    if (route) {
      const s = moveDistanceAt(route.route, route.phase, route.ease, time);
      pos = base.add(pointAlong(route.route, s));
      rot += moveAngleAt(route.route, route.align, s);
      jumped =
        route.route.mode === "repeat" &&
        dt > 0 &&
        s < moveDistanceAt(route.route, route.phase, route.ease, time - dt);
    }
    // The swing is written whatever the route did, wrap frame included: a
    // pendulum hung from a travelling cart goes on swinging while the cart is
    // put back at the start, and a pose that dropped it for that one frame would
    // be a visible flick.
    if (swing) rot += swingOffsetAt(swing.amp, swing.period, swing.phase, time);
    body.globalPosition = pos;
    body.globalRotation = rot;
    if (jumped) body.teleported();
  };
}

// Horizontal sine shuttle: sweeps base.x ± amplitude. Keep peak speed
// (amplitude * omega) under ~0.02 m/frame (see MoverScript). base/amplitude in
// metres; omega in rad/s.
export function addSlidingPlatform(
  level: Level,
  base: Vec2,
  amplitude: number,
  omega: number,
  width = 1.2,
  height = 0.16,
): void {
  const platform = new AnimatableBody2D();
  platform.name = "SlidingPlatform";
  platform.setShape(rectShape(width, height));
  platform.globalPosition = base;
  level.addMover(platform, (body, time) => {
    body.globalPosition = base.add(new Vec2(amplitude * Math.sin(time * omega), 0));
  });
}

// Constant-rate rotor about its centre. pivot in metres; omega in rad/s.
export function addWindmill(
  level: Level,
  pivot: Vec2,
  omega: number,
  length = 2.2,
  thickness = 0.14,
): void {
  const windmill = new AnimatableBody2D();
  windmill.name = "Windmill";
  windmill.setShape(rectShape(length, thickness));
  windmill.globalPosition = pivot;
  level.addMover(windmill, (body, time) => {
    body.globalRotation = time * omega;
  });
}
