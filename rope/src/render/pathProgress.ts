// How far along its route the camera thinks the player is.
//
// This is the bottom layer of the camera (see `plans/camera-motion.md`): every
// framing decision a path makes is a function of one number, `s`, and the whole
// of the camera's smoothness is therefore the smoothness of that number. The
// closest-point projection it replaces is not smooth in the player's position
// and cannot be made so - it has two discontinuities, both intrinsic:
//
//  * a PLATEAU at every vertex. From a distance off the route the closest point
//    sits on a vertex for the whole wedge of that vertex's normal cone, then
//    slides 1:1 along the next segment, so `s` alternates between standing
//    still and running. Finer sampling shrinks it (see `CAMERA_SAMPLE_STEP`)
//    but never removes it.
//  * a TELEPORT on the medial axis. Past a bend's centre of curvature a whole
//    arc of the route is equidistant, and the global closest point flips from
//    one leg to the other - half a metre of arc in a frame on the river level's
//    tightest bend. A tracking window refuses the flip and then rides its own
//    edge instead, which is the same discontinuity with a ramp on it
//    (`session-336f`: `s` sprinting at 6 m/s of arc while the avatar moves at
//    1 to 2.6 m/s, and the camera reaching 5.3 m/s in seven frames).
//
// The answer here is a SOFT projection: rather than the arc length of the one
// nearest point, the arc-length-weighted mean of every point in a window,
// weighted by a Gaussian in distance. It is C-infinity in the player's position
// for any positive softness - there is no "winner" to change - and it collapses
// to the closest point wherever one candidate dominates, which is everywhere on
// a straight or a gently bent route. Both sides of a corner are simply
// averaged, and the average moves smoothly as the weights shift.
//
// Its one cost is a bias: inside a tight corner the mean advances faster than
// the player does, because cutting a corner IS advancing past the bend, and at
// the far end of the window it lags. The motion layer is what turns that into a
// swell rather than a jerk.
//
// Under `render` rather than `lib`, deliberately: `cli dmath` scans the whole
// of `src/lib` for platform transcendentals, and this uses `Math.exp`
// legitimately - it is render-side and reaches the sim through nothing.

import { Vec2 } from "../engine/vec2";
import {
  pointAtArcLength,
  projectOntoPolylineWindow,
  tangentAtArcLength,
  type PolylineIndex,
} from "../lib/path";

// Metres of control polygon per sample of a CAMERA route, where
// `PATH_FLATTEN_STEP` (25 cm) is what everything else flattens at.
//
// Not about the curve's accuracy, which 25 cm already has to well under a
// centimetre. It is about how coarse the plateau above is: the plateau is
// `offset x turn` and the turn at a vertex is proportional to the step, so on
// the river level's bends (segments of 12 to 25 cm turning 5 to 9 degrees) 25 cm
// is a 15 cm plateau and a duty cycle near 5 Hz, and 2 cm is under a degree per
// vertex. The soft projection above does not need it - it spans many samples
// either way - but everything else that rides the polyline does: `sNear`, the
// offset the corridor is measured with, the tangent, and the zone the editor
// draws.
//
// It is the CAMERA's own and not `PATH_FLATTEN_STEP` because that constant is
// shared with the movers, where it is the sim-side quantisation of a scripted
// pace (`PACE_STEP`): changing it there would diverge every recorded mover
// replay. A camera route is render-side and reaches the sim through nothing, so
// it is free to be as fine as it likes - the cost is memory (a 6885-point river
// route) and is paid once at build.
export const CAMERA_SAMPLE_STEP = 0.02;

// How far either side of last frame's progress the window reaches, in metres of
// ARC LENGTH.
//
// It is what keeps a switchback on the branch the player is actually riding:
// the two branches of the river's hairpin are a metre apart in space and twenty
// metres apart along the route, so a global answer would flip between them the
// instant the player was nearer the other one. Beyond the window a candidate
// weighs exactly nothing, and one entering it fades in from zero instead of
// snapping - which is what the hard window it replaces could not do, and the
// reason there is no longer a slack speed to size (`PATH_TRACK_SLACK_SPEED`
// was metres per second of allowance on top of the player's own step; nothing
// needs one now, because the window is not a race).
//
// 2.5 m is about twice the lookahead a path authors and 150 m/s of avatar at
// 60 Hz, so no legitimate move outruns it and no ordinary bend fills it.
export const CAMERA_TRACK_WINDOW = 2.5;

// Where the player stands against a route, softly.
export interface SoftProjection {
  // The soft answer: the arc-length-weighted mean under the Gaussian. What the
  // lead origin and every keyed TARGET field are read at.
  s: number;
  // The nearest point in the window, exactly as the windowed projection this
  // replaces answered it. What the GRIP is measured at - the corridor, the
  // falloff weight and the release - so the zone an author draws is still the
  // zone tested, and only what the camera LOOKS AT moves to the soft answer.
  sNear: number;
  // The distance to that nearest point.
  dist: number;
}

// The route point at `s`, with the route treated as CONTINUING STRAIGHT past
// either end along the tangent there.
//
// The extension is what makes the mean unbiased at the ends, and it is the one
// place this differs from `pointAtArcLength`, which clamps. Clamped, a window
// that runs off the end of the route is one-sided: a player standing exactly on
// the first node has nothing behind them to average against, so the mean sits
// half a Gaussian - about 0.4 m at the default softness - further along than
// they are, and every keyed field near either end is read that far off. Along
// the tangent the window is symmetric there like anywhere else, and the mean at
// the first node is the first node.
//
// The answer may therefore be outside [0, total], which is correct and is not
// a problem downstream: the lead target, the keys and the corridor all clamp,
// so being 30 cm before the start of a route means the camera is looking at its
// start, which is what it should be looking at.
function routePointExtended(ix: PolylineIndex, s: number): Vec2 {
  if (s < 0) return ix.verts[0]!.add(tangentAtArcLength(ix, 0).mul(s));
  if (s > ix.total) {
    return ix.verts[ix.verts.length - 1]!.add(tangentAtArcLength(ix, ix.total).mul(s - ix.total));
  }
  return pointAtArcLength(ix, s);
}

// How much a piece of route `u` of the way to the window's rim counts for: a
// falling smoothstep, 1 at the middle of the window, 0 at the rim and beyond,
// flat at both.
//
// Flat at the RIM is the load-bearing half, and it is what the hard window this
// replaces could not do. A candidate crossing into the window starts
// contributing at zero RATE as well as at zero weight, so there is no kink in
// `s` where the rim passes over a piece of route - where the hard window
// admitted a whole branch the moment its edge reached it.
//
// Exported because those are the two facts the window is for, and they are
// asserted directly rather than inferred from a rig (`soft-progress-keeps-its-
// branch`).
export function windowWeight(u: number): number {
  if (u >= 1) return 0;
  if (u <= 0) return 1;
  return 1 - u * u * (3 - 2 * u);
}

// The soft progress of `p` along `ix`, continued from `sPrev`.
//
// `window` is the half-width in arc length (see `CAMERA_TRACK_WINDOW`) and
// `sigma` is the path's softness in metres: the distance off the route over
// which two candidates count as comparable. Softness well under the corridor's
// own width behaves like the closest point at the corridor's edge and only
// softens near the route; softness comparable to the bend radii is what removes
// the medial axis.
//
// The samples are taken at a fixed arc-length step rather than at the
// polyline's own vertices, and that is not an implementation detail: a straight
// authored edge flattens to its two endpoints whatever the step is, so vertex
// sampling would weigh a 10 m leg as two candidates 10 m apart. Stepping by arc
// length also makes every sample stand for the same `ds`, which is what stops
// the flattener's density biasing the mean.
export function softProjectOntoPolyline(
  ix: PolylineIndex,
  p: Vec2,
  sPrev: number,
  window: number,
  sigma: number,
): SoftProjection {
  const near = projectOntoPolylineWindow(ix, p, sPrev - window, sPrev + window);
  if (ix.verts.length < 2 || ix.total <= 0) return { s: near.s, sNear: near.s, dist: near.dist };

  const lo = sPrev - window;
  const hi = sPrev + window;
  const span = hi - lo;
  const steps = Math.max(1, Math.ceil(span / CAMERA_SAMPLE_STEP));
  const ds = span / steps;
  // Two passes, because the exponent is conditioned on the closest candidate:
  // subtracting `dMinSq` makes the largest weight exactly one whatever the
  // player's distance from the route is, so a player ten metres off it gets the
  // same shape of answer as one standing on it rather than an underflow.
  const dSq: number[] = new Array(steps + 1);
  let minSq = Infinity;
  for (let k = 0; k <= steps; k++) {
    const q = routePointExtended(ix, lo + k * ds);
    const d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
    dSq[k] = d;
    if (d < minSq) minSq = d;
  }
  const twoSigmaSq = 2 * Math.max(1e-6, sigma) * Math.max(1e-6, sigma);
  let sum = 0;
  let weight = 0;
  for (let k = 0; k <= steps; k++) {
    const s = lo + k * ds;
    const b = windowWeight(Math.abs(s - sPrev) / window);
    if (b <= 0) continue;
    // `ds` is the arc length this sample stands for, so the sums are an
    // integral over the route rather than a count of samples. It is constant
    // here and therefore cancels, and it is written out because what cancels it
    // is the UNIFORM step: it would not cancel if the samples were the
    // polyline's own vertices.
    const w = Math.exp(-(dSq[k]! - minSq) / twoSigmaSq) * b * ds;
    sum += w * s;
    weight += w;
  }
  // Every sample negligible (the player far outside the corridor, or a window
  // that fell entirely on coincident verts): the nearest point is still an
  // answer, and the path's release will be firing on `off` anyway.
  return { s: weight > 0 ? sum / weight : near.s, sNear: near.s, dist: near.dist };
}
