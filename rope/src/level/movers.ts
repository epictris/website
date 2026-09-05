// Scripted-mover builders shared by hand-written level inits (game-design.md:
// rects only move on authored paths - these are the authored paths), and the
// motion of the one mover the FILE can author (see `swingScript`).

import { Vec2 } from "../engine/vec2";
import { AnimatableBody2D } from "../engine/body";
import { rectShape } from "../engine/shapes";
import type { Level } from "./level";
import type { MoveEase } from "./levelFormat";

// Scripted-mover update: sets the body's transform for the given sim time.
// Deterministic - must be a pure function of time (frame * dt), so a replay
// lands every mover in the same place on the same frame. Keep contact speeds
// under ~2 px/frame so movers can't trip the embed invariant.
export type MoverScript = (body: AnimatableBody2D, time: number) => void;

// The angle a kinematic pendulum stands at, `time` seconds in: a sine of the
// authored half-amplitude about the angle the body was built at (see
// `LevelBodyData.swingAmp`).
//
// Its own function rather than an expression inside the script below, because
// the script is the only thing that should have to know a body is involved: this
// is the statement, and the script is where it is written onto something.
// Deliberately NOT exported - `cli movers` asserts the arc against the sine
// written out longhand, which is a check rather than a restatement.
//
// `phase` is in CYCLES: the whole point of the field is that a quarter of a
// swing is 0.25 rather than π/2.
function swingAngleAt(
  restRot: number,
  amp: number,
  period: number,
  phase: number,
  time: number,
): number {
  if (period <= 0) return restRot;
  return restRot + amp * Math.sin(2 * Math.PI * (time / period + phase));
}

// ...as the mover that drives it. The body must already be mounted ON its
// bearing (the build re-origins it there), so the whole of the motion is the
// rotation: `AnimatableBody2D` derives the contact velocities from the
// transform delta, and a body whose origin IS the bearing hands the character
// controller the right `v + ω × r` at every point of it without anything here
// computing one.
export function swingScript(restRot: number, amp: number, period: number, phase: number): MoverScript {
  return (body, time) => {
    body.globalRotation = swingAngleAt(restRot, amp, period, phase, time);
  };
}

// A route as the mover travels it: the waypoints in WORLD offsets from the pose
// the body was built at, with the cumulative arc length to each so a distance
// along can be resolved without re-measuring the polyline every frame. Built
// once, at load.
//
// `total` is the whole journey - the sum of the legs, plus the closing leg back
// to the start on a closed route, which is the one difference between going
// round a loop and shuttling along a line.
export interface MovePath {
  readonly points: readonly Vec2[];
  readonly cumulative: readonly number[];
  readonly total: number;
  readonly closed: boolean;
}

// Turn the authored waypoints into one. `offsets` are the further waypoints in
// the body's own frame, already rotated into world (the authored position is
// waypoint zero, so it is prepended here as the origin of the offsets rather
// than being authored - see `LevelBodyData.movePath`).
export function buildMovePath(offsets: readonly Vec2[], closed: boolean): MovePath {
  const points = [Vec2.ZERO, ...offsets];
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1]! + points[i]!.sub(points[i - 1]!).length());
  }
  // The closing leg is part of the journey on a loop and is not a waypoint: a
  // closed route ends where it began, so the last entry of `cumulative` is where
  // the final waypoint sits and `total` runs past it back to the start.
  const closing = closed ? points[points.length - 1]!.sub(points[0]!).length() : 0;
  return { points, cumulative, total: cumulative[cumulative.length - 1]! + closing, closed };
}

// Where `s` metres along the route is. `s` is taken modulo the journey on a
// closed route and clamped on an open one, so neither the wrap at the end of a
// lap nor a rounding error at the far end of a shuttle is a caller's problem.
export function pointAlong(path: MovePath, s: number): Vec2 {
  const { points, cumulative, total, closed } = path;
  if (points.length < 2 || total <= 0) return points[0] ?? Vec2.ZERO;
  const d = closed ? ((s % total) + total) % total : Math.min(Math.max(s, 0), total);
  // A linear scan rather than a binary one: an authored route is a handful of
  // waypoints, and the scan is the version that is obviously right. A zero-length
  // leg (two waypoints authored on the same point) is skipped rather than
  // divided by, which is what leaves it a waypoint that is passed through.
  for (let i = 1; i < points.length; i++) {
    const from = cumulative[i - 1]!;
    const to = cumulative[i]!;
    if (d <= to && to > from) {
      return points[i - 1]!.add(points[i]!.sub(points[i - 1]!).mul((d - from) / (to - from)));
    }
  }
  // Past the last waypoint, which only a closed route reaches - an open one is
  // clamped to `total`, which IS the last waypoint. This is the leg home.
  const last = points[points.length - 1]!;
  const from = cumulative[cumulative.length - 1]!;
  if (total <= from) return last;
  return last.add(points[0]!.sub(last).mul((d - from) / (total - from)));
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

// Where along the route the body is, `time` seconds in: the whole of the motion,
// as one distance.
//
// A CYCLE is one lap of a closed route and one there-and-back of an open one,
// which is what makes `movePhase` mean the same thing on both - 0.5 is half way
// round a loop, and the far end of a shuttle. `speed` is the average over a
// TRAVERSE, so a shuttle's cycle is two of them and the arithmetic below divides
// the journey accordingly rather than the author having to.
export function moveDistanceAt(
  path: MovePath,
  speed: number,
  phase: number,
  ease: MoveEase,
  time: number,
): number {
  if (path.total <= 0 || speed <= 0) return 0;
  const traverse = path.total / speed;
  if (path.closed) {
    return (time / traverse + phase) * path.total;
  }
  // Two traverses to a cycle: out on the first, back on the second. `leg` is the
  // fraction of the OUTWARD trip either way, so the return really is the outward
  // journey played backwards - the same route, the same speed profile mirrored,
  // which is why an ease's rate at an end decides how the turn feels.
  const cycles = time / (2 * traverse) + phase;
  const v = (((cycles % 1) + 1) % 1) * 2;
  const leg = v <= 1 ? v : 2 - v;
  return easeFraction(ease, leg) * path.total;
}

// ...as the mover that drives it. `base` is the pose the body was built at,
// which is waypoint zero - so a body at distance 0 stands exactly where it was
// drawn, and every offset the route carries is measured from there.
export function moveScript(
  base: Vec2,
  path: MovePath,
  speed: number,
  phase: number,
  ease: MoveEase,
): MoverScript {
  return (body, time) => {
    body.globalPosition = base.add(pointAlong(path, moveDistanceAt(path, speed, phase, ease, time)));
  };
}

// The two authored motions as ONE script, which is what lets a body carry both:
// the route writes where the body is and the pendulum writes which way it is
// turned, so a bearing on a travelling body is a pendulum hung from a cart. Null
// for a body that authored neither, which is every static in every level that
// predates them.
export function composeMovers(scripts: readonly MoverScript[]): MoverScript | null {
  if (!scripts.length) return null;
  if (scripts.length === 1) return scripts[0]!;
  return (body, time) => {
    for (const s of scripts) s(body, time);
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
