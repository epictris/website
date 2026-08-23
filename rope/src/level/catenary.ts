// The catenary a slack cord rests in, sampled by arc length - the rest pose of
// a vine attached at BOTH ends (`level/vines.ts`), and the shape the editor
// draws such a vine at (`editor/model.ts`).
//
// The length is authored and the anchor separation is whatever the anchors are,
// so the three regimes are all real level content rather than edge cases:
//
//   - length <= separation: the cord is taut (or over-taut, which the chain
//     solver spreads as uniform stretch), and the rest pose is the chord;
//   - separation is essentially vertical: the catenary parameter goes to zero
//     and cosh overflows, but the shape it is converging to is plain - straight
//     down from one anchor to a fold and straight back up to the other;
//   - otherwise: the classic curve, solved for its parameter and then sampled
//     in CLOSED FORM by arc length, because the points being placed are link
//     centres at exact spacings and a walk along a polyline approximation would
//     put the spacing error into the spawn pose the solver then has to fix.
//
// Coordinates are the game's own: y is DOWN, so the curve sags toward +y. The
// math below works in a y-up frame with x running horizontally from `a` toward
// `b` and flips on the way out.

import { Vec2 } from "../engine/vec2";

// Below this ratio of horizontal separation to cord length the solve is handed
// to the vertical fold. It is a numerical bound rather than a modelling one:
// the bisection itself is fine well past it, but the sampling's cosh arguments
// grow with it and the fold is already indistinguishable on screen.
const FOLD_RATIO = 1e-4;

// `sinh(u)/u` grows monotonically from 1; the bisection brackets its inverse.
// 350 keeps every `sinh` this file can ask for finite with a factor to spare.
const U_MAX = 350;

// Points along the resting cord from `a` to `b`, at the arc distances `arcs`
// (metres from the `a` end, each in (0, length)). One solve, however many
// samples - which is why this takes the list rather than answering one arc at
// a time.
export function catenaryPoints(
  a: Vec2,
  b: Vec2,
  length: number,
  arcs: readonly number[],
): Vec2[] {
  const chord = b.sub(a);
  const d = chord.length();

  // Taut, or over-taut: the rest pose is the chord, links at their arc's own
  // fraction of it. Over-taut that spreads the stretch uniformly, which is
  // where the solver's fixed point is anyway.
  if (!(length > d) || d < 1e-9) {
    const t = d < 1e-9 ? Vec2.ZERO : chord;
    return arcs.map((s) => a.add(t.mul(s / length)));
  }

  const h = Math.abs(chord.x);

  // Essentially vertical: down from `a` to the fold, straight back up to `b`,
  // with the tiny horizontal offset spread by arc so the pose is continuous
  // with the solved curve as `h` shrinks.
  if (h < FOLD_RATIO * length) {
    const foldY = (length + a.y + b.y) / 2;
    const down = foldY - a.y;
    return arcs.map((s) => {
      const y = s <= down ? a.y + s : foldY - (s - down);
      return new Vec2(a.x + chord.x * (s / length), y);
    });
  }

  // The parameter: `2c sinh(h/2c) = sqrt(L^2 - v^2)` with `v` the height
  // difference, solved for `u = h/2c` by bisection on the monotonic
  // `sinh(u)/u`. `k > h` is guaranteed by `length > d` above.
  const v = -(b.y - a.y);
  const k = Math.sqrt(length * length - v * v);
  const ratio = k / h;
  let lo = 1e-9;
  let hi = 1;
  while (Math.sinh(hi) / hi < ratio && hi < U_MAX) hi *= 2;
  hi = Math.min(hi, U_MAX);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sinh(mid) / mid < ratio) lo = mid;
    else hi = mid;
  }
  const u = (lo + hi) / 2;
  const c = h / (2 * u);

  // Where the vertex sits: `tanh` of the endpoint angles' mean is `v / L`,
  // which is in (-1, 1) because the height difference is a leg of the arc.
  const m = Math.atanh(v / length);
  const xv = h / 2 - c * m;

  // Closed-form arc sampling: `s(x) = c sinh((x - xv)/c)` measured from the
  // vertex, inverted with `asinh`, then the height read straight off the curve.
  const dirX = Math.sign(chord.x);
  const s0 = c * Math.sinh(-xv / c);
  const y0 = c * Math.cosh(-xv / c);
  return arcs.map((s) => {
    const x = xv + c * Math.asinh((s0 + s) / c);
    const yUp = c * Math.cosh((x - xv) / c);
    return new Vec2(a.x + dirX * x, a.y - (yUp - y0));
  });
}

// The resting cord as a polyline from `a` to `b` inclusive, in `segments`
// equal-arc steps - what the editor draws and picks a spanning vine by.
export function catenaryPolyline(a: Vec2, b: Vec2, length: number, segments: number): Vec2[] {
  const arcs: number[] = [];
  for (let i = 1; i < segments; i++) arcs.push((length * i) / segments);
  return [a, ...catenaryPoints(a, b, length, arcs), b];
}
