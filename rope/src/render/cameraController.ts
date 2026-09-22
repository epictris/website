// Camera behaviour: an eased follow of the avatar, reshaped by the level's
// camera regions.
//
// Deliberately render-side, driven by wall-clock dt rather than the fixed
// timestep: the camera is not part of the simulation, so easing it can never
// change a recorded run. (The grapple controller un-projects the cursor through
// the camera, so the camera does reach the sim as *input* — but the recorded
// trace stores the resulting world point, so replays stay bit-identical.)
//
// THREE LAYERS, each smooth in its inputs, so that no rule upstream can jerk
// the screen:
//
//  1. **Progress** (`render/pathProgress.ts`) - where along its route the
//     camera thinks the player is, as a soft projection rather than a nearest
//     point, which is the one thing that makes it a continuous function of
//     where they are.
//  2. **Framing** (`cameraRuleTarget`, `blendCameraTarget`) - the authored
//     idea: a path's lead at the zoom keyed there, a region's lock, offset and
//     scale, blended by weight with the plain follow taking the unclaimed
//     share. Piecewise, and allowed to be.
//  3. **Motion** (`CAMERA_FREQ` and the two caps) - one critically damped
//     spring with an acceleration cap, and the only thing that ever writes the
//     camera's position and zoom.
//
// The third is the load-bearing one, and it is what a pile of local smoothing
// rules was replaced by. The old controller computed a memoryless piecewise
// target every frame and put one first-order ease between it and the screen -
// and every piecewise rule is a STEP IN THE TARGET'S VELOCITY: the vertex
// projection, the window edge, both edges of the lead deadband, the ratchet
// engaging, the pin opening and dropping, the branch challenge, the
// frozen-delta hand-off. A first-order ease at 0.15 s attenuates a 3 Hz
// disturbance by about a third, so every one of them leaked to the screen, and
// most of the file was machinery trying to keep each rule individually
// continuous - which is the wrong place for that guarantee.
//
// A spring with an acceleration cap makes the guarantee GLOBAL instead:
// whatever any rule upstream does, the camera's acceleration is bounded and its
// velocity is continuous. A rule change is a step in the aim, and a step in the
// aim is a bounded swell. That is why there is no cross-fade clock here any
// more, no frozen delta, and no per-region `blend`.
//
// A single mechanism covers default→region, region→region and region→default:
// "no region" is just the plain follow point, which is the share of the camera
// no rule has claimed.
//
// Several regions can govern at once. The lowest `priority` in force wins and
// everything ranked worse is silenced; rules tied at it BLEND, weighted by how
// deep inside each one the avatar stands (see `ruleWeight`,
// `blendCameraTarget`). A hand-off between two sets whose weights have already
// faded freezes a delta of zero, so a region with a `falloff` band crosses over
// without using the blend clock at all.
//
// On top of those sits one one-sided rule, the ANCHORED EPISODE (see `update`):
// while the avatar hangs on a taut line the camera does not walk back down the
// track, because half of a swing is travel the level did not mean. It is not a
// smoothing - it is a constraint, and it is given back as a step in the aim
// when the anchor is released.

import { Vec2 } from "../engine/vec2";
import { PIXELS_PER_METER } from "../engine/units";
import type { CameraPathData, CameraRegionData } from "../level/levelFormat";
import {
  DEFAULT_PATH_FALLOFF_X,
  DEFAULT_PATH_FALLOFF_Y,
  DEFAULT_PATH_LOOKAHEAD_BUFFER_X,
  DEFAULT_PATH_LOOKAHEAD_BUFFER_Y,
  DEFAULT_PATH_LOOKAHEAD_X,
  DEFAULT_PATH_LOOKAHEAD_Y,
  DEFAULT_PATH_RANGE_X,
  DEFAULT_PATH_RANGE_Y,
  DEFAULT_PATH_SOFTNESS,
  DEFAULT_VIEWPORT_SCALE,
} from "../level/levelFormat";
import type { Camera } from "./camera";
import {
  axisBlend,
  buildPolylineIndex,
  ellipseReach,
  flattenPathNodes,
  pathNodesOf,
  pointAtArcLength,
  projectOntoPolyline,
  projectOntoPolylineWindow,
  withProjectionBlocks,
  type PolylineIndex,
} from "../lib/path";
import {
  CAMERA_SAMPLE_STEP,
  CAMERA_TRACK_WINDOW,
  softProjectOntoPolyline,
} from "./pathProgress";
import {
  buildKeyTrack,
  keyValueAt,
  lerpZoom,
  smoothstep,
  type KeyTrack,
} from "../lib/keyframes";
import type { Margin } from "./shapePath";
import { marginSides, uniformMargin } from "./shapePath";

// --- the motion layer's parameters ------------------------------------------
//
// One critically damped spring, an acceleration cap and a speed cap, and
// nothing else ever writes the camera's position or zoom.
//
// The FREQUENCY is the feel: how briskly the camera closes a gap it is allowed
// to close, in hertz rather than as a time constant because a critically damped
// second-order response has no single time constant - it rises, and 1.2 Hz is
// about 0.3 s to settle. It replaced a first-order ease at 0.15 s, which is
// roughly as responsive to a slow move and has no bounded acceleration at all.
//
// The CAP is the guarantee, and it is what the whole design rests on: the
// camera's acceleration is bounded whatever any rule upstream does, so a step
// in the target is a swell rather than a lurch. Measured on the exact aim
// signal the old ease was chasing, over the two 2026-09-22 river bundles:
//
//                                   peak accel / jerk, m/s² and m/s³
//   first-order 0.15 s (the old)     268f  16 / 1533     336f  55 / 2152
//   spring 1.2 Hz, a <= 8 m/s²       268f   8 /  156     336f   8 /  314
//
// The two are tuned against each other and against the frame guarantee below:
// past what the cap can deliver the SPRING is outrun, and past what the spring
// can deliver the FLOOR is, and the floor is the one thing that may never be.
// If play shows the floor binding on ordinary runs, raise the frequency before
// touching the cap - the cap is the guarantee, the frequency is the feel.
//
// The SPEED cap is a backstop rather than a knob: 12 m/s is faster than
// anything the level's framing asks for and slower than a teleport, so what it
// bounds is a hand-off across half a level.
export const CAMERA_FREQ = 1.2;
export const CAMERA_MAX_ACCEL = 8;
export const CAMERA_MAX_SPEED = 12;

// The longest frame the spring will integrate, seconds. A hitched frame is a
// frame the wall clock spent elsewhere, not a frame the camera was allowed to
// fly across the level in; past a tenth of a second the honest answer is that
// the camera lagged, which is what clamping gives.
const CAMERA_MAX_DT = 0.1;

// How far outside a region the avatar must travel before the region lets go,
// when the region does not author a `buffer` of its own. Without it, hovering
// exactly on a boundary re-triggers the cross-fade every frame and the camera
// stutters, so it is sized for jitter and nothing more.
export const REGION_EXIT_MARGIN = 0.15; // metres

// --- the frame guarantee's parameters ---------------------------------------
//
// Global, and deliberately not authorable: a level may frame the avatar however
// it likes and none of those framings is allowed to be "off the bottom of the
// screen", so what the guarantee does is a property of the GAME rather than of
// a room in it. They are tuned together and are what every one of them means:
//
//   CAMERA_EDGE_MARGIN     where the avatar may never go.
//   CAMERA_EDGE_INNER_X/Y  where the override holds them, per axis.
//   CAMERA_EDGE_SMOOTHING  how fast it corrects toward that, in seconds.
//   CAMERA_STICK_TAU       how long its pull lasts once it stops being asked.
//
// Three of them are fractions of the frame, so they mean the same thing at any
// zoom, and the other two are clocks. `edgeReach` turns the first two into the
// distances a given camera actually allows - `innerReach` is the inner one -
// `edgeOffset` is where the override wants the avatar held, and `edgeTakeUp` is
// the rate. The stick is declared with them because it is tuned against them.
//
// The law is a WINDOW, a rate, and a floor, in that order:
//
//   Inside the inner margin the guarantee is not there at all and the level's
//   framing is honoured exactly. Outside it the camera is moved until the
//   avatar is AT the inner margin - not near it, at it - and the only question
//   the parameters answer is how fast. The floor is what that correction may
//   never be outrun past.
//
// The inner margin is therefore where the avatar RESTS whenever the framing in
// force would have put them further out, and the distance between it and the
// floor is transient headroom rather than a second framing: it is the room the
// correction is allowed to still be working in, and `edgeTakeUp` spends it
// faster the less of it is left.
//
// An asymptotic give-way used to live between the two - the override started at
// the inner line and handed the ground over on an exponential, so the avatar
// settled somewhere between the two lines that depended on how much the rule
// was asking for. It is gone because that is exactly what a minimum distance
// from the edge may not do: a framing that asked for a little was held near the
// inner line and one that asked for a lot rode near the floor, so the same
// parameter read as a different margin in every room (measured on
// `session-368f`: 19.7% of the frame from the edge under a path asking for 1.68
// m, 26.7% under a region asking for 0.88 m). The smoothness it was there for
// belongs to the clock and is delivered by it - see CAMERA_EDGE_SMOOTHING, and
// `edge-window-has-no-velocity-step`, which is the same measurement without it.
//
// The override runs in two places, which is what makes it smooth (see
// `CameraController.softEdge` and `holdEdge`): the window shapes what the
// camera is AIMING at, so the camera answers it through its own follow ease and
// its velocity turns over instead of reversing, and the same window plus the
// hard floor is then applied to where the camera actually IS, because an aim
// can be outrun and the guarantee may not be.

// How much of the frame the avatar may never enter, as a fraction of the FULL
// width and height, on every axis and under every rule.
//
// A fraction rather than a distance because the thing being constrained is
// where the avatar is ON SCREEN: a region that zooms out shows more world, and
// a margin in metres would shrink to a sliver of the frame exactly where the
// frame got roomier. Dimensionless also means it means the same thing at both
// controllers' base zooms without either of them stating it.
//
// It is measured to the FOLLOW POINT - the avatar's centre - so it has to be
// wide enough to clear the avatar's own radius and then leave something worth
// seeing. At 0.08 that is 77 cm either side and 43 cm above and below, on the
// 9.6 x 5.4 m a 1080p frame shows at GRAPPLE_ZOOM.
//
// It is the absolute floor rather than the point the override engages at - see
// CAMERA_EDGE_INNER_X/Y, which is where the avatar is actually held. Reaching
// this one at all means the correction was outrun, which is a launch or a
// hand-off and not ordinary play.
//
// At 0 the floor is the frame's own edge, so the guarantee is "the avatar's
// centre is on screen" and the avatar themselves is half off it. Anything
// larger is a real keep-out, and it may not exceed the inner margin.
export const CAMERA_EDGE_MARGIN = 0;

// The target minimum distance from the edge of the frame, per axis, as a
// fraction of that axis's own full extent - measured from the EDGE, like the
// margin, rather than inward from it.
//
// This is the one of the four a player can see. Whenever the framing in force
// would put the avatar closer to the edge than this, the camera is moved until
// they are exactly here, so it is where the avatar sits during every excursion
// the guarantee answers: at 0.2 vertically, a fifth of the frame's height up
// from the bottom, whatever the rule was asking for and however far past it the
// avatar went.
//
// Two numbers rather than one because a fraction of the axis is not a distance:
// the frame is 16:9, so the same value is an inset 78% deeper in METRES across
// than down. Held equal as fractions the inset reads as proportional to the
// frame; held equal in metres - 0.1125 across to 0.2 down - it reads as a
// uniform border, which is 216 px on all four sides of a 1080p frame. The pair
// is the interim either way: the unit this wants is one distance, stated as a
// fraction of the frame's HEIGHT on both axes.
//
// It is bounded BELOW by the margin (a target inside the floor is the floor)
// and above by half the frame, where `edgeReach` returns 0 and the camera is
// pinned to the avatar - at which point the level has no framing left to
// author, which is the sign it has been set far too deep. 0.2 leaves the
// authored framing 60% of the frame to work in.
export const CAMERA_EDGE_INNER_X = 0.1125;
export const CAMERA_EDGE_INNER_Y = 0.2;

// How long the override takes to give the window's pull, seconds - the third of
// the three, and the one that makes the correction a RATE rather than a
// distance.
//
// The band alone is a statement about distance, and that is not enough on its
// own, because what the override has to undo is the camera's own MOTION. A
// backswing is the case that shows it: the lead is ratcheted forward, so the
// camera is still easing forward while the avatar swings back, and by the time
// the boundary is reached the override is not slowing the camera down, it is
// turning it round. At swing speeds the band is crossed in a handful of frames,
// so however graded the ramp is, the turn arrives as an event.
//
// So the pull is given at a speed set by how much of it is still owed - see
// `edgeTakeUp`, which is where the law is - and this is the constant in it: the
// seconds a correction takes when there is headroom for it, self-shortening to
// nothing as the room runs out. Deeper past the margin is corrected faster,
// the correction fades out as it finishes rather than ending, and the floor is
// never reached at all.
//
// What it buys is measured rather than argued. Worst camera ACCELERATION and
// JERK - which is what "harsh" is - over two recorded swings and a walk out of
// a locked room, in m/s² and m/s³. These four were measured with the old
// asymptotic give-way in place, and what they settle is how the pull is
// DELIVERED, which the window did not change:
//
//                                   118f          137f          walking out
//   bare clamp, outright       127 / 8044    103 / 6148     288 / 17280
//   the pull, given outright    65 / 4412     25 /  972      36 /   886
//   the pull, on a held pull   141 / 8479     26 /  972      30 /   278
//   the pull, at this rate      19 / 1462      17 /  972      14 /   179
//
// Dropping the give-way for the window was measured the same way, on
// `session-368f`, against the give-way at the tuning it was last played at:
//
//                                accel    jerk    where the avatar sat
//   the give-way (ease 0.4 y)      33     1823    11.3% .. 28.5% from the edge
//   the window (inner 0.2 y)       43     2347    14.5% .. 24.2%
//
// The spread in where the avatar sits nearly halves and what is left of it is a
// correction still running rather than a different framing per room; the
// correction is about a third firmer, because the demand is now the whole
// excess rather than a fraction of it. This constant is the knob for that, and
// it is monotone in both directions on that session - 0.10 s reads 50 / 2735
// and rides to 15.6%, this 0.15 s reads 43 / 2347 and 14.5%, 0.20 s reads
// 39 / 2126 and 13.8%, 0.30 s reads 34 / 1873 and 12.8%. Softer is calmer and
// rides deeper, and the floor is what bounds how deep.
//
// The third row of the first table is the design the rate replaced, and its
// 118f column is the reason:
// a pull held across frames goes stale when the geometry turns under it, and
// there it made the override HARSHER THAN THE BARE CLAMP it exists to soften
// (see `edgeAxis`). What is left in the last row is not the override at all -
// 1462 is the lead ratchet engaging on the frame the chain goes taut and 972 is
// the lookahead deadband letting go, both of which are steps in the target's
// velocity that this has nothing to do with.
//
// It is bounded ABOVE by the headroom and the speeds in play: past what the
// headroom can absorb the rate rides the barrier and the camera is turned over
// hard instead of being carried, so much longer than a fifth of a second is a
// sign the INNER MARGIN is too close to the floor for the speeds rather than
// that this is too long.
//
// A SHAPE knob was tried on the give-way first and removed, and is worth not
// re-inventing even though the curve it shaped is gone. The family
// `1 - (1+uk)**(-1/k)` holds the curve's two end conditions for every `k` and
// looks like a free choice of tail, but its curvature at the join is `-(1+k)`:
// a longer tail is a SHARPER bend exactly where the override engages, so the
// knob ran the wrong way and every value of it was worse than `k = 0` (23, 29,
// 44, 77 m/s² of peak acceleration for k = 0.01, 1, 4, 20 on `session-137f`).
// What it was reaching for is a delay, and a delay is a clock.
export const CAMERA_EDGE_SMOOTHING = 0.3;

// An EXPONENT on that headroom term was tried here and rejected by play, and
// this is the note that stops it being re-invented a third time.
//
// The argument for it is a good one. The rate is divided by the headroom the
// demand has eaten, so the time constant shrinks in proportion to the gap left
// to the floor - but the distance to close shrinks with it, so a correction
// takes about as long from anywhere: on the locked-room step an avatar a
// centimetre from the floor is answered at 29 m/s and still takes 0.87 s, the
// same 0.87 s as one a tenth of the way in. Squaring the term makes the rate
// outrun the distance, so the camera would give way softly while there was room
// and close outright when there was not:
//
//   depth into the headroom     as it is      squared
//   10%                        1.02 m/s      1.06 m/s
//   75%                       11.87 m/s     22.58 m/s
//   99%                       28.87 m/s     63.35 m/s, 0.52 s not 0.87 s
//
// Played, the flat one is better, and the numbers say why it might be: what the
// exponent buys is all in the last quarter of the headroom, which ordinary play
// never reaches (`session-368f` spends a quarter of it at its worst). What it
// costs is paid everywhere - the correction's character changes with depth, so
// the camera answers the same excursion differently depending on how far the
// framing in force had already pushed the avatar, and a camera that is one
// thing at one depth and another thing at another is the complaint the window
// itself was written to fix.
//
// The flat-in-time reading is the one to keep: a correction takes about as long
// whatever provoked it, and the only thing that changes near the floor is that
// it is not allowed to take that long - the headroom term is still there, still
// divides, and still diverges, which is what makes the floor unreachable.

// How long the frame guarantee's pull STICKS once it stops being asked for,
// in seconds.
//
// The guarantee shoves the camera to keep the avatar on screen. The question
// this answers is what happens on the frames after a shove ends, and the whole
// of the old anchored latch was one answer to it: pin the camera where the
// guarantee left it and keep it there for the rest of the hang, because a swing
// is an oscillation and the return half says nothing about where the player is
// going. Unpinned and answered instantly, the camera eases back toward its
// target the moment each shove ends and then gets shoved again - a wobble,
// twice a swing, for as long as the avatar hangs there.
//
// The pin worked and cost four mechanisms to keep working: a deadband so
// re-pulling it every frame did not walk it in, an opening clock so a pin born
// deep past the margin was not a step in the camera's velocity, an episode to
// belong to, and a wind release to drop it early when the player wound
// themselves up the line toward an anchor ahead. Every one of those was a patch
// for the pin being a LATCH - a state with an edge, which has to be entered,
// held and handed back.
//
// A decaying pull has no edge. The window shapes the aim outright while it is
// asking, exactly as the pin did; when it stops asking, the aim returns to the
// rule's target on this clock instead of instantly. At 1.5 s:
//
//  * a swing at the edge of the frame asks about once a period - also around
//    1.5 s - so a pull decays only partly before the next one raises it again,
//    and the rocking the latch existed to stop is a few centimetres of slow
//    drift through a spring rather than a pin;
//  * nothing has to be handed back when the anchor releases, nothing creeps (a
//    decaying stick moves outward on its own, so there is nothing for a
//    deadband to stop), and nothing has to open on a clock;
//  * WINDING UP THE LINE toward an anchor ahead needs no special case at all.
//    The player moves toward the middle of the frame, the window stops asking,
//    and the stick decays while the spring glides the camera forward to its
//    lead. That is what `windProgress`, `hangLength`, `windArmed`, `sinceWind`,
//    WIND_REARM_DELAY, WIND_REST_RATE and the path's `windBuffer` field were
//    between them for.
//
// It is not gated on being anchored, and it does not need to be: the guarantee
// is inert in ordinary play (it binds on a locked room the avatar has left, on
// a path leading well off them, and on being outrun), and where it does bind a
// slow return is at worst a calmer camera. The lead RATCHET stays gated on
// anchored, because that one is about backtracking along the route rather than
// about the edge of the frame.
export const CAMERA_STICK_TAU = 1.5;

// The buffer a region actually holds by: its own, or the jitter default.
//
// A rect may state one per side (`bufferLeft` and friends), each falling back to
// the region's own `buffer` and then to the jitter default. A region authoring
// none answers the plain number, so every path that had one is untouched; the
// other two shape kinds have no sides to state and always do (see `Margin`).
export function regionBuffer(r: CameraRegionData): Margin {
  const base = r.buffer ?? REGION_EXIT_MARGIN;
  if (r.shape.kind !== "rect") return base;
  const { bufferLeft, bufferRight, bufferTop, bufferBottom } = r;
  if (
    bufferLeft === undefined &&
    bufferRight === undefined &&
    bufferTop === undefined &&
    bufferBottom === undefined
  ) {
    return base;
  }
  return {
    left: bufferLeft ?? base,
    right: bufferRight ?? base,
    top: bufferTop ?? base,
    bottom: bufferBottom ?? base,
  };
}

export interface CameraTarget {
  pos: Vec2;
  zoom: number;
}

// Is a world point inside a region's (rotated) volume, optionally grown by
// `margin` — one distance on every side, or a rect's per-side set?
export function pointInRegion(r: CameraRegionData, p: Vec2, margin: Margin = 0): boolean {
  if (r.shape.kind === "circle") {
    return p.distanceTo(new Vec2(r.x, r.y)) <= r.shape.r + uniformMargin(margin);
  }
  const l = p.sub(new Vec2(r.x, r.y)).rotated(-r.rot);
  if (r.shape.kind === "rect") {
    // Per side, in the region's own frame: the sides the buffer names, and the
    // one place a rect's grown volume is decided alongside `pathOutlineGrown`,
    // which draws exactly this.
    const m = marginSides(margin);
    const hx = r.shape.w / 2;
    const hy = r.shape.h / 2;
    return l.x >= -hx - m.left && l.x <= hx + m.right && l.y >= -hy - m.top && l.y <= hy + m.bottom;
  }
  // Convex polygon: inside every face plane, each pushed out by the margin. A
  // true offset (rounded corners) rather than the rect's square-cornered growth,
  // which is why the editor and the debug overlay draw a polygon's buffer with
  // filleted corners — the drawn zone is exactly the zone tested here.
  const verts = r.shape.verts;
  const n = verts.length;
  const grow = uniformMargin(margin);
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % n]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    if ((ey * (l.x - a.x) - ex * (l.y - a.y)) / len > grow) return false;
  }
  return true;
}

// How deep inside its own volume `p` is, in metres: the distance to the nearest
// point of the region's boundary, POSITIVE inside and negative outside. The
// same three shapes `pointInRegion` tests, measured rather than answered yes or
// no, and it agrees with it by construction - the sign flips exactly where the
// containment does.
//
// It is what the blend band is read off (see `ruleWeight`), which is why it
// has to be a distance and not a margin test: the band is a ramp across the
// last few metres of the room, so "how far in" is the question, and asking
// `pointInRegion` at a shrunken margin could only answer it one step at a time.
//
// Outside a rect the number is the largest axis overshoot rather than the true
// Euclidean distance to a corner, because nothing reads the magnitude out
// there - a weight is clamped to zero the moment the sign is negative.
export function regionDepth(r: CameraRegionData, p: Vec2): number {
  if (r.shape.kind === "circle") return r.shape.r - p.distanceTo(new Vec2(r.x, r.y));
  const l = p.sub(new Vec2(r.x, r.y)).rotated(-r.rot);
  if (r.shape.kind === "rect") {
    return Math.min(r.shape.w / 2 - Math.abs(l.x), r.shape.h / 2 - Math.abs(l.y));
  }
  // Convex polygon: the distance to the nearest face plane, which for a convex
  // shape IS the distance to the boundary. Degenerate faces are skipped exactly
  // as they are in the containment test, and a polygon with none left is
  // everywhere-inside there, so it is infinitely deep here.
  const verts = r.shape.verts;
  let outermost = -Infinity;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    outermost = Math.max(outermost, (ey * (l.x - a.x) - ex * (l.y - a.y)) / len);
  }
  return outermost === -Infinity ? Infinity : -outermost;
}


// A rule governing the camera: one of the two kinds of authored thing that can
// reshape it. Both are governed by the SAME priority/buffer logic below, which
// is why they generalise into one list rather than each carrying a copy of it.
//
// A path's `index` is built once, at level construction: it is the authored
// curve FLATTENED into a polyline, in WORLD space (see `lib/path.ts`), and
// nothing mutates a path at runtime. Everything downstream - the projection, the
// arc length, the lookahead, the corridor - rides that polyline and knows
// nothing about the Bézier handles that produced it.
//
// A path's `keys` are its nodes' keyframes (see `CameraPathVert`) laid out by
// arc length, one track per keyed field - built once alongside the index,
// since a node's `s` is only known once the curve into it is flattened.
export type CameraRule =
  | { kind: "region"; region: CameraRegionData }
  | { kind: "path"; path: CameraPathData; index: PolylineIndex; keys: PathKeyTracks };

// The level's rule set, in the order the tie-break reads: regions in author
// order, then paths in author order.
//
// Paths after regions because the tie-break is "later wins", and a path beating
// a region at equal priority is the right default - the path is the level's
// primary guide and a region is the local exception. A region that must win
// anyway says so with `priority`, exactly as regions already outrank each other.
export function buildCameraRules(
  regions: readonly CameraRegionData[],
  paths: readonly CameraPathData[],
): CameraRule[] {
  return [
    ...regions.map((region): CameraRule => ({ kind: "region", region })),
    ...paths.map((path): CameraRule => {
      const flat = flattenPathNodes(pathNodesOf(path.verts), CAMERA_SAMPLE_STEP);
      // Blocks because a camera route is 2 cm sampled and the corridor sweep
      // projects once per sample it draws (see `withProjectionBlocks`).
      const index = withProjectionBlocks(
        buildPolylineIndex(flat.points, new Vec2(path.x, path.y), path.rot, flat.nodeAt),
      );
      return { kind: "path", path, index, keys: pathKeyTracks(path, index) };
    }),
  ];
}

// --- keys -------------------------------------------------------------------
//
// The fields a node may key (see `CameraPathVert`). The first five shape the
// path's TARGET - how much world is on screen, how far ahead the camera looks
// and how much slack that lead is measured with - and are read at the
// committed lead origin. The last five shape the GRIP - the corridor, its
// falloff band and the release hysteresis - and are read at `sNear`, the arc
// length the range is measured from. `pathParamsAt` resolves all ten at
// whatever `s` it is given; the caller knows which `s` a field is about.
export const PATH_KEY_FIELDS = [
  "viewportScale",
  "lookaheadX",
  "lookaheadY",
  "lookaheadBufferX",
  "lookaheadBufferY",
  "rangeX",
  "rangeY",
  "falloffX",
  "falloffY",
  "buffer",
] as const;
export type PathKeyField = (typeof PATH_KEY_FIELDS)[number];

// The keyable fields RESOLVED at one place on the route: every one a number,
// with the path-level field and then the format's default already folded in.
// Everything downstream of the keys reads one of these rather than a
// `CameraPathData`, which is what makes "the lead at this `s`" one lookup.
export type PathParams = Record<PathKeyField, number>;

// One field's keys in arc-length order. Empty = no node keys it.
export type PathKeyTracks = Record<PathKeyField, KeyTrack>;

const PATH_PARAM_DEFAULTS: PathParams = {
  viewportScale: DEFAULT_VIEWPORT_SCALE,
  lookaheadX: DEFAULT_PATH_LOOKAHEAD_X,
  lookaheadY: DEFAULT_PATH_LOOKAHEAD_Y,
  lookaheadBufferX: DEFAULT_PATH_LOOKAHEAD_BUFFER_X,
  lookaheadBufferY: DEFAULT_PATH_LOOKAHEAD_BUFFER_Y,
  rangeX: DEFAULT_PATH_RANGE_X,
  rangeY: DEFAULT_PATH_RANGE_Y,
  falloffX: DEFAULT_PATH_FALLOFF_X,
  falloffY: DEFAULT_PATH_FALLOFF_Y,
  buffer: REGION_EXIT_MARGIN,
};

// The path-level values: what every field is with no keys at all, and what a
// path authored before keys existed is everywhere along its length.
export function pathParamsOf(p: CameraPathData): PathParams {
  const out = { ...PATH_PARAM_DEFAULTS };
  for (const k of PATH_KEY_FIELDS) if (p[k] !== undefined) out[k] = p[k]!;
  return out;
}

// Each field's keys, read off the nodes and placed at the nodes' arc lengths.
// An index built without node positions (a bare polyline) keys nothing.
export function pathKeyTracks(p: CameraPathData, index: PolylineIndex): PathKeyTracks {
  const tracks = {} as PathKeyTracks;
  for (const k of PATH_KEY_FIELDS) {
    tracks[k] = buildKeyTrack(p.verts.map((v) => v[k]), index.nodeS);
  }
  return tracks;
}

// The keyable fields resolved at arc length `s`.
//
// Per field: no keys is the path-level value; before the first key it holds
// that key, past the last it holds that one, and between two it is
// smoothstepped by arc length - flat at each key, so the value has no kink
// where a node sits, for the same reason the falloff band is smoothstepped: a
// kink in the target is a step in the camera's velocity. The view scale
// interpolates GEOMETRICALLY like every other zoom blend here (1 -> 4 passes
// through 2), and the lengths linearly.
//
// Two keys at the same arc length (coincident nodes) take the later one.
export function pathParamsAt(rule: CameraRule & { kind: "path" }, s: number): PathParams {
  const base = pathParamsOf(rule.path);
  for (const k of PATH_KEY_FIELDS) {
    base[k] = keyValueAt(rule.keys[k], s, base[k], k === "viewportScale" ? lerpZoom : undefined);
  }
  return base;
}

// A rule's rank, where the LOWEST number in force wins and rules tied at it
// blend. Absent = 0, so an unprioritised level is one flat rank whose rules all
// blend with each other, and authoring a priority is always a statement about
// beating something rather than about joining it.
export function rulePriority(r: CameraRule): number {
  return (r.kind === "region" ? r.region.priority : r.path.priority) ?? 0;
}

// A rule's share of the camera at `p`, 0..1 - how much of the blend it asks
// for, before the set is normalised (see `blendCameraTarget`).
//
// A region with no `falloff` is all-or-nothing: 1 wherever it applies, which is
// what every region authored before the band existed is, and what keeps a room
// framed right out to its walls. With a band it ramps from 1 at `falloff`
// metres inside its boundary down to 0 AT the boundary, so its influence is
// already spent by the time it stops containing the player and the room it
// overlaps has taken over by exactly as much.
//
// A path's is the complement of its falloff weight, which is the same
// statement about a corridor: 1 within the range, fading across the band, 0 at
// the band's outer edge (see `pathFalloffWeight`). The two bands point opposite
// ways because the authored geometry means opposite things - a region's outline
// is the edge of its claim and a path's polyline is the middle of one.
//
// It is purely positional: it says nothing about whether the rule is in force,
// which is what lets the hand-off ask what a rule the player has just left
// would still be asking for (see `update`).
export function ruleWeight(r: CameraRule, p: Vec2, at: PathStanding | null = null): number {
  if (r.kind === "path") {
    const st = at ?? pathStanding(r.index, p);
    return 1 - pathFalloffWeight(pathParamsAt(r, st.s), st.off);
  }
  const falloff = r.region.falloff ?? 0;
  if (falloff <= 0) return 1;
  return smoothstep(Math.min(Math.max(regionDepth(r.region, p) / falloff, 0), 1));
}

// One rule's claim on the camera: the rule and the share it asks for.
export interface CameraInfluence {
  rule: CameraRule;
  weight: number;
}

// The rules in force paired with their weights, for a player at `p`. `seatAt`
// is the standing against the path in the set, when the caller has a better one
// than a fresh global projection (the controller always does).
export function cameraInfluences(
  members: readonly CameraRule[],
  p: Vec2,
  seatAt: PathStanding | null = null,
): CameraInfluence[] {
  return members.map((rule) => ({
    rule,
    weight: ruleWeight(rule, p, rule.kind === "path" ? seatAt : null),
  }));
}

// The camera the blend asks for: every influence's own target, weighted, with
// whatever share is left over going to the plain follow.
//
// The leftover share is what makes a band fade a lone room out to the default
// camera rather than to nothing, and it is the same mechanism a path's falloff
// band already was - so a path in its band and a region in its band now do the
// literally identical thing, and a path that is the only rule in force blends
// exactly as it did before there was a blend at all.
//
// Weights summing past 1 (two regions with no band, fully overlapping) are
// NORMALISED rather than clipped, so that case is an even average of the two
// instead of an arbitrary winner. Under 1 they are not, because the difference
// is the plain follow's share and normalising it away is what would make a band
// mean nothing.
//
// Position blends linearly and zoom GEOMETRICALLY, as every zoom blend here
// does: 1 -> 4 through 2, not through 2.5.
export function blendCameraTarget(
  influences: readonly CameraInfluence[],
  follow: Vec2,
  baseZoom: number,
  // The committed lead origin, for the path in the set; ignored by regions.
  s = 0,
): CameraTarget {
  let total = 0;
  for (const i of influences) total += Math.max(0, i.weight);
  const scale = total > 1 ? 1 / total : 1;
  const plain = Math.max(0, 1 - total);
  let pos = follow.mul(plain);
  let logZoom = plain * Math.log(baseZoom);
  for (const i of influences) {
    const w = Math.max(0, i.weight) * scale;
    if (w <= 0) continue;
    const t = cameraRuleTarget(i.rule, follow, baseZoom, s);
    pos = pos.add(t.pos.mul(w));
    logZoom += w * Math.log(Math.max(1e-9, t.zoom));
  }
  return { pos, zoom: Math.exp(logZoom) };
}

// The one rule doing most of the framing, for a caller that can only draw or
// assert about one (the debug overlay's label, the cases). Ties go to the later
// rule, which is the only thing authoring order decides beside the path seat.
export function dominantRule(influences: readonly CameraInfluence[]): CameraRule | null {
  let best: CameraInfluence | null = null;
  for (const i of influences) if (!best || i.weight >= best.weight) best = i;
  return best?.rule ?? null;
}

// WHAT WAS HERE: `ruleBlend` and `setBlend`, which resolved how long a hand-off
// between two rule sets took - the `blend` a joining rule authored, failing
// that the one the rule being left authored, failing that CAMERA_BLEND_TIME.
//
// There is no hand-off clock any more. The gap between two sets is a step in
// the aim and the motion layer answers every step the same way, at a bounded
// acceleration, so the only thing a `blend` could have said is "take longer
// than the camera's own physics", which is a second timescale for the same
// motion and is exactly what made the old controller unpredictable. The field
// is folded away at the format's one gate, so every level on disk still loads.

// Are these the same rules, in any order? What decides whether the camera has
// changed hands and the frozen-delta hand-off has to fire.
function sameRules(a: readonly CameraRule[], b: readonly CameraRule[]): boolean {
  return a.length === b.length && a.every((r) => b.includes(r));
}

// How far along the path the camera leads, for a route heading in `dir`.
//
// The pair is blended by that heading rather than read as an ellipse the lead
// must land inside (see `axisBlend`), which is what lets an author zero one
// axis: `lookaheadY: 0` is no lead up a shaft and the full `lookaheadX` down a
// corridor that is a few degrees off the flat, where the ellipse gave neither.
export function pathLookahead(p: PathParams, dir: Vec2): number {
  return axisBlend(p.lookaheadX, p.lookaheadY, dir);
}

// The width of the lead's deadband, for a route heading in `dir` - the same
// blend, so a band authored for a corridor is not most of the vertical screen
// in a shaft, and a zero axis costs the band exactly what that axis was worth
// and nothing more. Both axes zero means no band at all, which falls out.
export function pathLookaheadBuffer(p: PathParams, dir: Vec2): number {
  return axisBlend(p.lookaheadBufferX, p.lookaheadBufferY, dir);
}

// The arc length the lookahead is measured from, held in a deadband around the
// avatar's own projection.
//
// A swing is an oscillation ALONG the route - the projection runs forward and
// back several times a second - and a lead taken from it exactly sloshes the
// camera with it. Clamping the committed point into a band means it does not
// move at all while the avatar stays within `buffer` of it, so an oscillation
// narrower than the band is absorbed completely rather than merely damped: on
// the first half-swing the band is dragged to one edge, and every swing after
// that moves it by nothing.
//
// Clamping rather than "hold, then jump to the avatar" is what keeps it
// CONTINUOUS. The committed point is only ever dragged by the edge of the band,
// so there is no step in the target to be blended away - and the price is that
// on genuine forward travel the lead is short by the band, which is what the
// buffer means and what the author is choosing when they widen it.
//
// `anchored` is the swing regime (see `Level.cameraHang`), and there the
// band is a RATCHET: only its rear edge may drag the origin, so the lead runs
// forward with the swing and is never hauled back by the return. That is the
// bias down the track this whole regime is for - a swing that reaches further
// along the route has said something about where the player is going, and the
// half-swing back has not. The band still absorbs everything narrower than
// itself, exactly as it does rolling; what is dropped is the front edge, which
// is the only thing that ever moved the origin BACKWARD.
//
// It is one-sided rather than frozen because the forward drag is what keeps it
// continuous: the origin is still only ever moved by an edge of the band.
export function committedLeadS(
  s: number,
  held: number,
  buffer: number,
  anchored: boolean,
): number {
  const forward = Math.max(held, s - buffer);
  return anchored ? forward : Math.min(forward, s + buffer);
}

// The range's and falloff's per-axis pairs, floored at zero. Every distance a
// path measures OFF the route goes through these and `ellipseReach`, so the
// corridor, the falloff band and the release are all screen-shaped: the frame
// is 16:9, and a circular corridor wide enough to mean anything horizontally
// is off the bottom of the screen vertically (see DEFAULT_PATH_RANGE_X/_Y).
//
// Unlike the lead's pair - blended against the direction the ROUTE runs, and
// not a boundary at all (see `axisBlend`) - these are a true ellipse, resolved
// against the direction the player actually left the route in, because that is
// the displacement the screen has to hold and the zone the editor draws.
//
// All of them take the path's fields RESOLVED at the player's projection
// (`pathParamsAt`), since the grip fields are keyable along the route.
export function pathRangeAxes(p: PathParams): { x: number; y: number } {
  return { x: Math.max(0, p.rangeX), y: Math.max(0, p.rangeY) };
}

export function pathFalloffAxes(p: PathParams): { x: number; y: number } {
  return { x: Math.max(0, p.falloffX), y: Math.max(0, p.falloffY) };
}

// Does the path have a falloff band ANYWHERE - at the path level or at any
// node's key? What decides whether the band's outer edge is worth drawing.
export function pathHasBand(rule: CameraRule & { kind: "path" }): boolean {
  const base = pathParamsOf(rule.path);
  return (
    base.falloffX > 0 ||
    base.falloffY > 0 ||
    rule.keys.falloffX.some((k) => k.v > 0) ||
    rule.keys.falloffY.some((k) => k.v > 0)
  );
}

// The semi-axes of the falloff band's outer ellipse, and of the release
// ellipse beyond it. Exported so the overlay and the editor draw exactly the
// boundaries the functions below test - the same one-source rule
// `pathOutlineGrown` follows for a region's buffer.
export function pathBandAxes(p: PathParams): { x: number; y: number } {
  const r = pathRangeAxes(p);
  const f = pathFalloffAxes(p);
  return { x: r.x + f.x, y: r.y + f.y };
}

export function pathReleaseAxes(p: PathParams): { x: number; y: number } {
  const band = pathBandAxes(p);
  const b = Math.max(0, p.buffer);
  return { x: band.x + b, y: band.y + b };
}

// How far off the route the path's corridor reaches, for a player displaced
// along `dir`.
export function pathRange(p: PathParams, dir: Vec2): number {
  const r = pathRangeAxes(p);
  return ellipseReach(r.x, r.y, dir);
}

// The outer edge of the falloff band along `dir` - the ellipse with semi-axes
// (rangeX + falloffX, rangeY + falloffY), where the path's target has faded to
// exactly the plain follow.
export function pathBand(p: PathParams, dir: Vec2): number {
  const band = pathBandAxes(p);
  return ellipseReach(band.x, band.y, dir);
}

// How far from the polyline a path keeps its grip along `dir`: the band's
// outer edge grown by the path's jitter hysteresis on both axes - which falls
// back to the same default a region's does. Growing the SEMI-AXES rather than
// adding to the resolved reach is what keeps the release boundary an ellipse,
// so the editor and the overlay can draw exactly the zone tested here.
export function pathRelease(p: PathParams, dir: Vec2): number {
  const rel = pathReleaseAxes(p);
  return ellipseReach(rel.x, rel.y, dir);
}

// How far through the falloff band an avatar displaced by `offset` from their
// projection is, as the weight of the PLAIN FOLLOW in the path's target: 0
// anywhere inside the range ellipse (pure path), 1 at the band's outer ellipse
// and beyond (exactly the null rule's target), smoothstepped between. Both
// boundaries are resolved along the offset's own direction, so the fade is
// screen-shaped exactly as the corridor is.
//
// Interpolating between the two governing TARGETS is the whole design, and it
// replaced a positional drift laid on top of a full-strength path target. The
// drift froze the avatar's screen position through the band, but it left three
// seams: the camera's behaviour flipped character at `range` (riding the route
// one frame, tracking the avatar 1:1 the next), the drift capped at `falloff`
// while the grip held to `range + falloff + buffer` (so the avatar slid again
// in the gap), and the lookahead never faded - so the release still swapped a
// full-lead target for the plain follow, a delta the hand-off blend could
// smooth but never make small. With the weight, the path's target IS the plain
// follow by the time the grip runs out, so the release delta is exactly zero
// and the boundary stops existing perceptually.
//
// Smoothstep rather than linear so the weight is C1 at both edges of the band:
// a kink in the target is a step in the camera's velocity, which reads as the
// camera "catching" at an invisible line.
//
// A zero falloff (both axes) means no band at all - the path keeps its full
// grip out to the release and the hand-off blend covers the swap, which is the
// pre-band behaviour and what an author turning the band off is asking for.
//
// Measured against the avatar's offset from their TRUE projection rather than
// from the deadbanded point the lead is taken from: this is about where they
// actually are relative to the route, which is the same quantity the range is
// measured in.
export function pathFalloffWeight(p: PathParams, offset: Vec2): number {
  const inner = pathRange(p, offset);
  const outer = pathBand(p, offset);
  if (outer - inner < 1e-9) return 0;
  const t = Math.min(Math.max((offset.length() - inner) / (outer - inner), 0), 1);
  return smoothstep(t);
}

// Where the avatar stands relative to a path: the arc length of a projection
// and the displacement from it. The offset's length is the projection's own
// `dist` and its direction is what the range and falloff ellipses are resolved
// along; the arc length is where those ellipses' axes are read from, the grip
// fields being keyable along the route.
export interface PathStanding {
  s: number;
  off: Vec2;
}

// The avatar's standing against their GLOBAL projection onto the polyline.
function pathStanding(index: PolylineIndex, p: Vec2): PathStanding {
  const s = projectOntoPolyline(index, p).s;
  return { s, off: p.sub(pointAtArcLength(index, s)) };
}

// Does `p` fall inside the rule at all? Containment for a region, displacement
// from the polyline against the range ellipse for a path - which is the whole
// difference between the two kinds and the reason a path is not a region with
// a funny shape.
function ruleContains(r: CameraRule, p: Vec2): boolean {
  if (r.kind === "region") return pointInRegion(r.region, p);
  const at = pathStanding(r.index, p);
  return at.off.length() <= pathRange(pathParamsAt(r, at.s), at.off);
}

// Does the incumbent keep its grip? Its volume grown by `regionBuffer` for a
// region; the release ellipse for a path, measured at `held` - the standing
// against the WINDOWED projection the controller is tracking, not the global
// closest point, so a switchback passing nearby cannot hold a player who has
// fallen off the branch they were actually on.
function ruleHolds(r: CameraRule, p: Vec2, held: PathStanding | null): boolean {
  if (r.kind === "region") return pointInRegion(r.region, p, regionBuffer(r.region));
  const at = held ?? pathStanding(r.index, p);
  return at.off.length() <= pathRelease(pathParamsAt(r, at.s), at.off);
}

// The standing the controller is tracking against the path it is riding: the
// seat, and where the player is against it. The windowed projection is stateful
// and the grip, the weight and the lead are all measured from it, so the
// controller passes it in rather than anything here recomputing a global answer
// that means something else.
export interface HeldSeat {
  seat: CameraRule & { kind: "path" };
  at: PathStanding;
}

// The rules governing the camera for an avatar at `p` - the SET, since equal
// rank blends.
//
// A rule is a candidate if it contains the player, or if it was in force last
// frame (`current`) and still holds by its buffer. The lowest `priority` among
// the candidates is the rank in force, and every candidate at that rank is in
// the set; anything ranked worse is silenced outright, which is what makes
// priority the escape hatch rather than a second kind of blend.
//
// Entering is deliberately *not* buffered: a rule joins the set the moment the
// avatar is inside it, and only leaving is delayed. That asymmetry is what
// makes the buffer authorable as "how far out of this room I may stray without
// the camera changing its mind" — a swing that leaves through one wall and
// comes straight back keeps one camera for the whole arc, where a buffer on
// entry would instead grab the region early from outside. A region that wants
// to hand over gradually as the player crosses into its neighbour authors a
// `falloff` band and lets the WEIGHT do it, which is a different question from
// the grip and is why they are different fields.
//
// Two PATHS cannot both be in the set: the camera rides one route at a time -
// the projection, the lead deadband and the branch window are all state about
// one polyline - so among tied paths the seat goes to the one already ridden,
// and to the last in the list otherwise.
export function activeCameraRules(
  rules: readonly CameraRule[],
  p: Vec2,
  current: readonly CameraRule[] = [],
  held: HeldSeat | null = null,
): CameraRule[] {
  const candidates = rules.filter(
    (r) =>
      ruleContains(r, p) ||
      (current.includes(r) && ruleHolds(r, p, r === held?.seat ? held.at : null)),
  );
  if (candidates.length === 0) return [];
  let rank = Infinity;
  for (const r of candidates) rank = Math.min(rank, rulePriority(r));
  const members = candidates.filter((r) => rulePriority(r) === rank);
  const paths = members.filter((r) => r.kind === "path");
  if (paths.length < 2) return members;
  const seat = held && paths.includes(held.seat) ? held.seat : paths[paths.length - 1]!;
  return members.filter((r) => r.kind === "region" || r === seat);
}

// The one rule doing most of the framing where the avatar stands, for a caller
// that has no controller to ask (the debug overlay drawing a level nobody is
// playing). A first-order answer: no grip, no seat, no history.
export function activeCameraRule(rules: readonly CameraRule[], p: Vec2): CameraRule | null {
  return dominantRule(cameraInfluences(activeCameraRules(rules, p), p));
}

// Where the camera wants to be under a given rule, for an avatar at `follow`.
//
// A region computes per axis: a lock pins it, otherwise it follows plus the
// region's offset. A path ignores `follow` for position entirely and takes the
// point further along itself than the player's projection `s` (`pathLeadAlong`),
// which is the whole mechanism - the screen leads the player along the route.
// The null rule is the default camera: the avatar, at the base zoom.
//
// `s` is the projection the controller resolved this frame, and is ignored for
// a region and for null. It is passed in rather than recomputed here because
// the held projection is stateful (see `projectOntoPolylineWindow`), so a
// recomputed answer would be a different one.
export function cameraRuleTarget(
  rule: CameraRule | null,
  follow: Vec2,
  baseZoom: number,
  s = 0,
): CameraTarget {
  if (!rule) return { pos: follow, zoom: baseZoom };
  if (rule.kind === "path") {
    // pointAtArcLength clamps, which is the correct degenerate behaviour:
    // near the end of the path the camera comes to rest centred on that end
    // rather than staring past it.
    // Every keyed field is read at `s` - the committed lead origin, which sits
    // still inside the lookahead deadband while a swing runs back and forth
    // under it. Read at the raw projection instead, a swing across a zoom
    // gradient would pump the zoom every half-swing; read here, the buffer
    // absorbs it exactly as it absorbs the lead.
    const params = pathParamsAt(rule, s);
    // This is the target at FULL strength, everywhere in the corridor. Through
    // the falloff band the path asks for less of it and the plain follow takes
    // the rest (see `ruleWeight` and `blendCameraTarget`), so lookahead,
    // viewport scale and everything else the path wants fade together and the
    // release delta is zero by construction - the same fade as before, moved
    // out to where every rule's fade now happens.
    return {
      pos: pointAtArcLength(rule.index, s + pathLeadAlong(rule, s, params)),
      zoom: baseZoom / Math.max(0.01, params.viewportScale),
    };
  }
  const region = rule.region;
  const scale = region.viewportScale ?? DEFAULT_VIEWPORT_SCALE;
  return {
    pos: new Vec2(
      region.lockX ?? follow.x + (region.offsetX ?? 0),
      region.lockY ?? follow.y + (region.offsetY ?? 0),
    ),
    // viewportScale is how much world is shown, so it divides the zoom: 2 =
    // twice as much world on screen. Guarded because a zero would blow up the
    // render transform.
    zoom: baseZoom / Math.max(0.01, scale),
  };
}

// The arc length a path leads by at `s`, resolved against the direction the
// route actually goes over that lead.
//
// Taken from the local tangent and then REFINED once against the chord to the
// point it lands on: on a bend the tangent at `s` and the direction the camera
// ends up displaced in are different answers, and the ellipse is a statement
// about the displacement. One refinement is enough - the correction is second
// order in the curvature - and it is deterministic, unlike iterating to a
// tolerance.
//
// `params` are the path's fields at `s` (see `pathParamsAt`): the lead is a
// keyable field, so it is whatever the route says it is where the lead is
// measured from.
function pathLeadAlong(
  rule: CameraRule & { kind: "path" },
  s: number,
  params: PathParams = pathParamsAt(rule, s),
): number {
  const here = pointAtArcLength(rule.index, s);
  const first = pathLookahead(params, tangentAt(rule.index, s));
  const chord = pointAtArcLength(rule.index, s + first).sub(here);
  return pathLookahead(params, chord.lengthSquared() > 0 ? chord : tangentAt(rule.index, s));
}

// The polyline's direction at `s`, from a short chord across it. A chord rather
// than the segment it falls on, so a projection landing exactly on a vertex
// answers the average of the two edges rather than whichever one wins the tie.
function tangentAt(index: PolylineIndex, s: number): Vec2 {
  const h = 0.05;
  return pointAtArcLength(index, s + h).sub(pointAtArcLength(index, s - h));
}

// How far the camera centre may be from the follow point, per axis, before the
// avatar enters the band `margin` names at the edge of the frame. The default
// is the guarantee's own keep-out; `innerReach` is the inner margin the
// override holds the avatar to.
//
// Zero when the margin is wider than half the frame, which pins the camera on
// the avatar rather than inverting the clamp and shoving it out the far side.
export function edgeReach(camera: Camera, zoom: number, margin = CAMERA_EDGE_MARGIN): Vec2 {
  const scale = Math.max(1e-6, zoom * PIXELS_PER_METER);
  const keep = Math.max(0, 1 - 2 * margin);
  return new Vec2(
    ((camera.viewportWidth / 2) * keep) / scale,
    ((camera.viewportHeight / 2) * keep) / scale,
  );
}

// The inner margin as a distance, per axis - `edgeReach` with each axis's own
// inner fraction in place of the floor's. The one place the two fractions are
// paired, so a call site asks for "the inner reach" rather than restating which
// number goes on which axis.
//
// Never past the floor: an inner margin authored inside the margin would invert
// the window, and the answer to that is that the floor is the target.
export function innerReach(camera: Camera, zoom: number): Vec2 {
  const hard = edgeReach(camera, zoom);
  return new Vec2(
    Math.min(hard.x, edgeReach(camera, zoom, CAMERA_EDGE_INNER_X).x),
    Math.min(hard.y, edgeReach(camera, zoom, CAMERA_EDGE_INNER_Y).y),
  );
}

// The offset from the follow point the camera is allowed to REST at, for one it
// wants of `d` (both distances, so per axis and unsigned).
//
// The window, and all of it: inside the inner margin the camera keeps the
// offset it asked for, outside it the offset is the inner margin exactly. There
// is no third regime, and that is the property the whole guarantee is built to
// have - a minimum distance from the edge that reads the same in every room,
// under every rule, at every speed the correction can keep up with.
//
// What this does NOT say is when the camera gets there. Applied outright it is
// a bare clamp and a step in the camera's velocity; the controller gives it
// over `edgeTakeUp`'s clock instead, and the clock is where every claim about
// smoothness now lives. The two were confused in an earlier design (an
// exponential give-way between this line and the floor), and the cost of
// confusing them is in CAMERA_EDGE_INNER_X/Y: a give-way expressed as distance
// makes where the avatar rests a function of how much the rule was asking for,
// which is the one thing a minimum distance may not be.
//
// The floor is not this function's business. It is applied last and to the
// camera's position rather than to the offset it would like (see `edgeAxis`),
// because what the floor answers is the correction being outrun, and an offset
// that was never granted cannot be outrun.
export function edgeOffset(d: number, inner: number): number {
  return Math.min(d, inner);
}

// How much the window wants the camera pulled in on one axis, in metres: the
// offset it has less the offset it may rest at. Zero anywhere inside the inner
// margin, and the whole of the excess outside it.
export function edgePull(away: number, inner: number): number {
  return Math.max(0, away - edgeOffset(away, inner));
}

// One axis of the guarantee, and the whole of what makes it a delayed override
// rather than an immediate one.
//
// It has NO STATE, and that is the whole of the design. What it returns is a
// function of this frame's geometry alone: how far past the inner margin the
// point is, and how much room is left between that margin and the floor it may
// not pass (see `edgeTakeUp`, which is the rate law).
//
// A carried pull was tried here first and is the thing to not re-invent. The
// argument for it is obvious - the override should not arrive all at once, so
// hold how much of it has been given and take up the rest over a clock - and
// the flaw is that the pull is a DISPLACEMENT held against a geometry that
// moves. A swing turns and the window stops asking within a handful of frames
// while the held pull is still most of its old size, so the camera goes on
// being dragged for a third of a second after the reason for it has gone, and
// then whatever bounds the pull cuts the remainder off in one frame. That is
// the sharp stop at the end of a correction, and it is worse the longer the
// clock is: on `session-118f` the held version peaks at 141 m/s^2 against the
// bare clamp's own 127, which is the override being harsher than the thing it
// replaced.
//
// Nothing is lost by dropping it, because the CAMERA POSITION is already the
// integrator this wants. Applied to `this.pos` every frame (see `holdEdge`), a
// fraction of the demand per frame IS a first-order approach to the inner
// margin - the accumulation happens in the thing being corrected, where it
// cannot go stale, and the correction fades out with the demand that drives it
// because it is nothing but that demand. That approach is also the whole of
// why the window may be a hard clamp: what the avatar sees is the camera
// easing them back to the inner margin over the clock, and what it settles on
// when they stop is the margin itself.
//
// Applied to an AIM, which is rebuilt from the rule every frame and is not
// state, the same fraction would be a permanent weakening of the window rather
// than a delay - so `softEdge` asks for the whole of it there. The exception is
// a latched axis, where the pin IS state and accumulates exactly as the
// position does.
//
// The pull can only ever move the camera TOWARD the avatar, which is what lets
// it compose with everything else: it cannot spring a camera the anchored latch
// is holding, and it cannot fight the rule in force for the camera's return.
//
// The hard floor is applied last and is not delayed by anything, but under this
// rate it is a backstop rather than a mechanism: the rate diverges as the
// camera nears the line, so the camera is turned before it arrives rather than
// caught when it does.
//
// An untouched axis is returned as it came in rather than rebuilt from the
// follow point, and that is not a shortcut: `follow + (pos - follow)` is not
// `pos` in floats, so rebuilding it moves the camera by an ULP on every frame
// of ordinary play and reports the override as engaged on all of them - which
// is what the overlay draws and what the anchored latch pins on.
export function edgeAxis(
  pos: number,
  follow: number,
  inner: number,
  hard: number,
  dt: number,
): { pos: number; pull: number } {
  const d = pos - follow;
  const away = Math.abs(d);
  const side = Math.sign(d);
  const demand = edgePull(away, inner);
  // Nothing asked for - but the FLOOR is not the window's to forgive, so the
  // clamp runs even here.
  if (demand <= 0) return away <= hard ? { pos, pull: 0 } : { pos: follow + side * hard, pull: 0 };
  const pull = demand * edgeTakeUp(demand, hard - (away - demand), dt);
  return { pos: follow + side * Math.min(away - pull, hard), pull };
}

// What fraction of the window's `demand` to give this frame: the rate law, and
// the answer to "how fast should the override correct".
//
// It is a rate set by the ERROR rather than a fixed delay, and the two are not
// the same thing. A fixed delay says the override always takes the same time to
// arrive, so a small incursion is corrected as urgently as a large one and a
// large one is corrected far too late; the avatar reaches the floor while the
// pull is still coming on, and the floor is a rigid clamp - the camera is
// dragged at exactly their speed and stops dead the moment they come back
// inside. That is the harshness this replaces, and it is a discontinuity in the
// camera's VELOCITY however long the delay is. Making the delay longer makes it
// worse, not better, because it guarantees the floor is reached.
//
// A rate set by the error has neither end of that. `demand` is how far the
// point is from where the band wants it, and it is given at
// `demand / CAMERA_EDGE_SMOOTHING` per second, so:
//
//   - at the moment the override engages the demand is zero and so is the
//     correction: nothing starts, it grows;
//   - twice as far past the inner margin is corrected exactly twice as fast,
//     so a shallow incursion is barely answered and a deep one is answered
//     hard;
//   - and the correction fades out as it finishes rather than ending, because
//     the thing driving it is the thing being consumed. There is no arrival and
//     no release, which is what a stateless rate buys over a held pull (see
//     `edgeAxis`): nothing is carried, so there is nothing to discard.
//
// `headroom` is what stops it ever being too late: the metres left between the
// inner margin the camera is being pulled to and the floor it may not pass -
// the window's width, less whatever a latched axis is ignoring. The rate is
// divided by how much of that headroom the demand has eaten, so it diverges as
// the last of it goes. The camera cannot reach the floor - it is turned over
// harder and harder as it approaches, and the harder that is, the more the
// avatar was outrunning it, which is exactly when a hard correction is what the
// player asked for. Deep in the window the override is therefore its own
// undelayed self, and at the inner margin itself it is at its gentlest.
//
// It is also what decides how far past the inner margin a SUSTAINED excursion
// rides, which is the one thing the window does not fix by itself: a steady
// outward speed settles where the correction matches it, so the faster the
// avatar is leaving the more of the headroom is in use. Stopping ends it - the
// demand is the excess and nothing else, so the camera closes the last of it
// and rests the avatar exactly on the inner margin (see
// `edge-window-rests-on-the-inner-margin`).
//
// `Infinity` (a snap, and an aim that wants the band applied outright) and a
// smoothing of 0 both answer 1, which is the whole of the demand at once.
export function edgeTakeUp(demand: number, headroom: number, dt: number): number {
  if (CAMERA_EDGE_SMOOTHING <= 0) return 1;
  const used = demand > 0 && headroom > 0 ? Math.min(demand / headroom, 1) : 0;
  if (used >= 1) return 1;
  const rate = 1 / (CAMERA_EDGE_SMOOTHING * (1 - used));
  return 1 - Math.exp(-Math.max(0, dt) * rate);
}

// The camera position nearest `pos` that the frame guarantee allows, for an
// avatar at `follow`, with the whole of the window's pull taken up at once.
//
// Applied to where the camera ACTUALLY IS rather than to what it is aiming at:
// a target the avatar can outrun is not a guarantee, and outrunning the ease is
// exactly what a fast swing or a launch does.
//
// This is the undelayed answer, which is what the geometry cases assert and
// what the controller reduces to at `CAMERA_EDGE_SMOOTHING = 0`; the controller
// itself gives the same pull over a clock instead (see `edgeTakeUp`).
export function clampToEdge(camera: Camera, zoom: number, follow: Vec2, pos: Vec2): Vec2 {
  const hard = edgeReach(camera, zoom);
  const inner = innerReach(camera, zoom);
  return new Vec2(
    edgeAxis(pos.x, follow.x, inner.x, hard.x, Infinity).pos,
    edgeAxis(pos.y, follow.y, inner.y, hard.y, Infinity).pos,
  );
}

// The camera state the debug overlay draws (see `CameraController.held`).
export interface HeldCamera {
  // Every rule in force, with the share of the camera each is taking. More than
  // one means they are blending, and a weight is exactly how much of the
  // framing on screen belongs to that rule.
  members: readonly CameraInfluence[];
  // The one taking the largest share - what the overlay names and fills
  // brightest. Null when the camera is the plain follow.
  rule: CameraRule | null;
  // The avatar's projection along the path in force, and the deadbanded arc
  // length the lookahead is actually taken from. Both meaningless unless a path
  // is in the set.
  s: number;
  leadS: number;
  // The edge constraint, when it is what is holding the camera this frame:
  // where the camera centre is, how far from the follow point the avatar may
  // ever be (`reach`), and the inner margin it is being held to (`inner`). Null
  // whenever nothing is being overridden, so the overlay drawing it at all
  // means the camera is being held back rather than following.
  edge: { centre: Vec2; reach: Vec2; inner: Vec2 } | null;
  // What the camera is actually aiming at this frame - the rule's target with
  // the frame guarantee's window and its stick already on it. The camera is
  // springing toward this and not toward the rule's own target, so it is the
  // only thing that explains where the camera is going.
  aim: Vec2;
  // The STICK, per axis, in signed metres: how far the guarantee is still
  // holding the aim off the rule's target, decaying over CAMERA_STICK_TAU once
  // it stops being asked for. Nonzero on an axis means the camera is being held
  // there rather than aiming where the level asked.
  stick: { x: number; y: number };
}

// WHAT WAS HERE: `CameraHang`, the avatar's line as the camera saw it - the
// direction it left them along and how much of it was out. The wind release
// read both, to drop the frame-edge pin once the player had wound themselves
// far enough up the line along the route. The pin is gone (see
// CAMERA_STICK_TAU) and winding needs no special case, so what the camera asks
// about a hang is now only whether there IS one - `anchored`, which is what the
// lead ratchet is about.

// One axis of the critically damped spring, over `dt`, in CLOSED FORM.
//
// `x` is the error - where the camera is minus where it is aiming - and `v` its
// rate; the answer is where both are `dt` later, for an aim held constant over
// the step. The closed form rather than an Euler step because it is exact for
// every `dt`, which is the property `1 - exp(-dt/tau)` had and the reason the
// old ease was frame-rate independent: a 60 Hz and a 144 Hz display have to
// show the same motion, and a spring integrated numerically does not.
//
// Critically damped - x'' + 2wx' + w²x = 0, whose solution is
// `(A + Bt)e^(-wt)` with `A = x` and `B = v + wx` - because that is the one
// damping that closes a gap without overshooting it, and a camera that
// overshoots is a camera that has to come back.
function springStep(x: number, v: number, dt: number): { x: number; vel: number } {
  const w = 2 * Math.PI * CAMERA_FREQ;
  const b = v + w * x;
  const decay = Math.exp(-w * dt);
  return { x: (x + b * dt) * decay, vel: (v - w * b * dt) * decay };
}

// One axis of the stick: what the window is asking for now (`want`, a signed
// displacement of the aim, zero when it asks nothing) against what the stick
// was already holding, already decayed one frame (see CAMERA_STICK_TAU).
//
// The HOLD is what makes it work at all, and it is the thing to not simplify
// away. The obvious form is "the stick IS the demand while there is one, and
// decays once there is not" - and measured, that buys nothing whatsoever,
// because the demand is itself continuous: it falls smoothly to zero as the
// avatar comes back inside the inner margin, so by the frame it stops being
// asked there is nothing left to decay. The camera returns to its target at
// exactly the pace the avatar returns, which is the wobble the stick exists to
// stop. Holding the largest recent demand on that side instead means the
// extreme of a swing is what decays, over a second and a half, while the avatar
// swings back under it.
//
// A demand on the OTHER side replaces the hold outright rather than being
// blended with it: the window has just said the camera is wrong in the opposite
// direction, and continuing to hold it the old way would be the one thing the
// guarantee may not do. That is a step in the aim, and a step in the aim is the
// motion layer's to absorb.
function stick(want: number, decayed: number): number {
  if (want === 0) return decayed;
  return want > 0 ? Math.max(want, Math.max(0, decayed)) : Math.min(want, Math.min(0, decayed));
}

export class CameraController {
  // The camera's own state, kept here rather than read back off the Camera:
  // callers are free to post-process camera.position for framing (the ball
  // controller shifts it up a tenth of a viewport) without that shift feeding
  // back into the next frame.
  //
  // A position AND A VELOCITY, which is the motion layer: the camera is a
  // second-order system, so where it is going is as much its state as where it
  // is, and that is what makes its velocity continuous across a step in the
  // target. The zoom is the same spring in LOG space, which is the geometric
  // blend every zoom transition here already uses - 1 to 4 through 2.
  private pos = Vec2.ZERO;
  private vel = Vec2.ZERO;
  private logZoom = 0;
  private zoomVel = 0;
  private started = false;

  // The zoom the frame guarantee reads: its margins are fractions of the frame
  // and the frame is what the zoom decides. A getter because the spring's state
  // is the LOG, and there is no second copy to disagree with it.
  private get zoom(): number {
    return Math.exp(this.logZoom);
  }

  // The rules in force last frame, with the weights they were blended at.
  private members: CameraInfluence[] = [];

  // The path among them, if any: the one route the camera is riding, and what
  // all the path tracking state below is about (see `activeCameraRules`).
  private seat: (CameraRule & { kind: "path" }) | null = null;

  // Path tracking, alongside the smoothing state and reset with it by `snap()`.
  //
  // `pathS` is last frame's SOFT progress along the held path (see
  // `softProjectOntoPolyline`) - what the target is built from, and what this
  // frame's window is centred on. `pathNearS` is the nearest point in that
  // window, which is what the GRIP is measured at: the corridor an author draws
  // is a distance off the route, so it has to be answered by a point on the
  // route and not by a mean of several.
  private pathS = 0;
  private pathNearS = 0;
  // The arc length the LEAD is measured from: `pathS` held in the path's
  // lookahead deadband (see `committedLeadS`). Equal to `pathS` on acquisition
  // and whenever the band is being dragged; anywhere inside it while a swing
  // runs back and forth underneath.
  private pathLeadS = 0;

  // Set on any frame the edge clamp actually moved the camera (see
  // `clampToEdge`), for the debug overlay and for nothing else.
  private edge: { centre: Vec2; reach: Vec2; inner: Vec2 } | null = null;

  // The STICK: how far the frame guarantee is still holding the aim off the
  // rule's target, per axis, in signed metres (see CAMERA_STICK_TAU).
  //
  // While the window is asking, this IS what it asked for - the aim is the
  // window's answer outright, exactly as it always was. When it stops asking,
  // this decays rather than vanishing, so the camera returns to the rule's
  // target over a second and a half instead of on the next frame. That is the
  // whole of what the anchored pin, its deadband, its opening clock and its
  // wind release did between them, and it needs no episode to belong to.
  //
  // Per axis because the window is per axis: a swing that drops the avatar out
  // of the bottom of the frame has said nothing about the horizontal lead, and
  // holding x for it would freeze the route the camera is narrating.
  private stickX = 0;
  private stickY = 0;

  // What the camera aimed at on the last frame - the rule's target with the
  // window and the stick already on it. Recorded for the overlay, which cannot
  // otherwise explain where the camera is going.
  private aim = Vec2.ZERO;

  // How far the band moved the AIM on this frame, per axis, in metres. A
  // record of what just happened rather than carried state - the override has
  // none, which is the whole of why it cannot go stale (see `edgeTakeUp`) -
  // read by the anchored latch to know the guarantee shoved this axis, and by
  // the overlay to know to draw the keep-out boxes.
  private aimPullX = 0;
  private aimPullY = 0;

  // The screen-edge guarantee, which the GAME never turns off: it is the one
  // camera rule a level may not opt out of (see CAMERA_EDGE_MARGIN).
  //
  // The editor's ▶ Test turns it off as an INSTRUMENT, so an author can see the
  // framing a lock or a lookahead is actually asking for rather than the one
  // the backstop allowed. That is a question about the rule being tuned, and it
  // is unanswerable while the answer is being silently corrected - but it is a
  // question the editor asks, not a property of the level, so it lives here and
  // is never written to a file.
  edgeClamp = true;

  // The rule doing most of the framing, for a caller that wants one name for
  // what the camera is doing. It cannot be recomputed outside: the grip depends
  // on which rules held the camera last frame, so a recomputed answer disagrees
  // with the camera for the whole width of the buffer, which is exactly what
  // the overlay is opened to see.
  get activeRule(): CameraRule | null {
    return dominantRule(this.members);
  }

  // What the overlay needs to draw the rule in force, in one object so the
  // renderer's parameter list does not grow a field at a time. It cannot be
  // recomputed there: the grip, the windowed projection and the lead deadband
  // are all stateful, so a recomputed answer disagrees with the camera exactly
  // where the overlay is opened to look.
  get held(): HeldCamera {
    return {
      members: this.members,
      rule: dominantRule(this.members),
      s: this.pathS,
      leadS: this.pathLeadS,
      edge: this.edge,
      aim: this.aim,
      stick: { x: this.stickX, y: this.stickY },
    };
  }

  // Drop the easing for one frame — the camera arrives at its target instantly.
  // Used on level start/reset, where easing in from the last frame's position
  // would be a swoop across the level.
  snap(): void {
    this.started = false;
  }

  // The held path's progress, continued from last frame's: the soft mean the
  // target is built from, the nearest point in the window the grip is measured
  // at, and the distance to it (see `softProjectOntoPolyline`).
  //
  // The window is what makes a switchback behave: the global closest point
  // flips branches the instant the player is nearer the other one, many metres
  // of arc length in a frame, and no blend can help because the rule identity
  // has not changed. What is new is that a branch entering the window fades in
  // from zero weight rather than arriving, and that there is nothing to size
  // against the player's speed - the window is a neighbourhood, not a race.
  private trackPath(
    rule: CameraRule & { kind: "path" },
    follow: Vec2,
  ): { s: number; sNear: number; dist: number } {
    return softProjectOntoPolyline(
      rule.index,
      follow,
      this.pathS,
      CAMERA_TRACK_WINDOW,
      rule.path.softness ?? DEFAULT_PATH_SOFTNESS,
    );
  }

  // `anchored` is whether the avatar is hanging on a taut line rather than
  // moving under their own feet (see `Level.cameraAnchored`), and it opens the
  // one one-sided rule left in the controller: the committed lead origin
  // RATCHETS forward (see `committedLeadS`), so the target only ever moves
  // further along the route.
  //
  // A swing is an oscillation, so half of it is travel the level did not mean:
  // the forward half says where the player is going and the return half says
  // nothing, and a camera that answers both equally spends the whole arc
  // rocking. The ratchet is that said at the level of the ROUTE. It used to be
  // said a second time at the level of the FRAME - the edge guarantee latched
  // where it had shoved the camera, for the rest of the hang - and that half is
  // now the stick (see CAMERA_STICK_TAU), which needs no episode: a swing at
  // the edge of the frame asks about once a period, so the pull barely decays
  // between asks and the camera stays where the guarantee left it anyway.
  update(
    camera: Camera,
    dt: number,
    follow: Vec2,
    rules: readonly CameraRule[],
    baseZoom: number,
    anchored: boolean,
  ): void {
    if (!this.started) {
      // A snap is history-free: there is no incumbent to keep a grip, and no
      // tracked projection or committed lead to continue from.
      this.members = [];
      this.seat = null;
      this.pathS = 0;
      this.pathNearS = 0;
      this.pathLeadS = 0;
      this.aimPullX = 0;
      this.aimPullY = 0;
      this.stickX = 0;
      this.stickY = 0;
    }

    // Resolved BEFORE the rule decision, because a path's grip is measured to
    // the tracked projection rather than to the global closest point. The grip
    // reads `sNear` and not the soft progress: a corridor is a distance OFF the
    // route, so it has to be answered by a point on the route rather than by a
    // mean of several, and the zone an author draws is then exactly the zone
    // tested. The offset is that same displacement as a vector, which is what
    // the range and falloff ellipses are resolved along.
    const seat = this.seat;
    const heldPath = seat ? this.trackPath(seat, follow) : null;
    const heldOffset = heldPath ? follow.sub(pointAtArcLength(seat!.index, heldPath.sNear)) : null;
    const heldSeat: HeldSeat | null =
      seat && heldPath && heldOffset ? { seat, at: { s: heldPath.sNear, off: heldOffset } } : null;

    const nextRules = activeCameraRules(
      rules,
      follow,
      this.members.map((m) => m.rule),
      heldSeat,
    );
    // The path in the new set - at most one, by construction (see
    // `activeCameraRules`), which is what lets one seat's worth of tracking
    // state serve the whole blend.
    const nextSeat = (nextRules.find((r) => r.kind === "path") ?? null) as
      | (CameraRule & { kind: "path" })
      | null;

    // Acquiring a path is unbuffered and history-free, exactly as entering a
    // region is: a path that was not the incumbent is projected onto globally.
    //
    // A HELD path may also re-acquire its OWN other branch (`branchJump`). The
    // windowed projection is authoritative while held and deliberately cannot
    // walk to another branch (see `trackPath`) - which also means a player who
    // has genuinely left the ridden branch and landed inside the corridor of a
    // DIFFERENT branch of the same path would otherwise stay held by the
    // ridden branch's falloff zone in preference to the branch under their
    // feet, until the release finally let go somewhere the core range no
    // longer reaches. session-285f is exactly that: the ball fell off the
    // upper branch through the lower branch's corridor at 0.05 m while the
    // grip clung to the upper one at 5.4 m, released at 1.06 m off the lower
    // branch - 6 cm outside its range - and the path never re-acquired at all.
    //
    // So a held path is challenged by its own GLOBAL projection: outside the
    // ridden corridor (plus the jitter buffer) and inside the core range at
    // the global answer, it re-acquires there exactly as it would after a
    // release - a fresh projection, a re-centred lead, and the jump in the
    // target run through the frozen-delta hand-off below so it blends rather
    // than snaps. The challenge cannot fire on the ridden branch itself: a
    // global answer inside the window IS the windowed answer, so the two
    // distances agree and cannot sit on opposite sides of the range.
    //
    // Two arc lengths come out of this, and keeping them apart is the whole of
    // the layer: `progress` is the soft mean the TARGET is built from, and
    // `nearS` is the nearest point on the route, which the GRIP is measured at
    // (see `softProjectOntoPolyline`). They agree everywhere one candidate
    // dominates, which is most of a level.
    let progress = 0;
    let nearS = 0;
    let offset: Vec2 | null = null;
    if (nextSeat) {
      if (nextSeat === seat) {
        progress = heldPath!.s;
        nearS = heldPath!.sNear;
        offset = heldOffset!;
      } else {
        // Acquiring is history-free, so there is no window to be soft within:
        // the global closest point is both answers, and the soft mean starts
        // centred on it.
        const g = projectOntoPolyline(nextSeat.index, follow);
        progress = g.s;
        nearS = g.s;
        offset = follow.sub(pointAtArcLength(nextSeat.index, g.s));
      }
    }
    let branchJump = false;
    if (
      nextSeat &&
      nextSeat === seat &&
      offset!.length() >
        pathRange(pathParamsAt(nextSeat, nearS), offset!) + pathParamsAt(nextSeat, nearS).buffer
    ) {
      const g = projectOntoPolyline(nextSeat.index, follow);
      const goff = follow.sub(pointAtArcLength(nextSeat.index, g.s));
      if (goff.length() <= pathRange(pathParamsAt(nextSeat, g.s), goff)) {
        progress = g.s;
        nearS = g.s;
        offset = goff;
        branchJump = true;
      }
    }
    const s = progress;

    // Acquiring a path commits the lead to the projection outright - entering
    // (a branch jump included) is history-free, so the band starts centred on
    // the avatar rather than holding an offset earned somewhere else on the
    // route.
    const leadS = !nextSeat
      ? 0
      : nextSeat === seat && !branchJump
        ? committedLeadS(
            s,
            this.pathLeadS,
            // Measured where the BAND currently sits, not where the avatar
            // is: the band is the thing being sized, and on a bend the two
            // are different directions. Its width is keyable, so it is read
            // there too.
            pathLookaheadBuffer(
              pathParamsAt(nextSeat, this.pathLeadS),
              tangentAt(nextSeat.index, this.pathLeadS),
            ),
            anchored,
          )
        : s;

    // Each rule's share of the camera. A path's is read from the avatar's TRUE
    // displacement off the route - the windowed one while held, so at a
    // switchback the weight is about the branch they are actually on, exactly
    // as the grip is.
    const members = cameraInfluences(nextRules, follow, offset ? { s: nearS, off: offset } : null);
    const target = blendCameraTarget(members, follow, baseZoom, leadS);

    if (!this.started) {
      this.started = true;
      this.members = members;
      this.seat = nextSeat;
      this.pathS = s;
      this.pathNearS = nearS;
      this.pathLeadS = leadS;
      // A snap is the spring placed at its aim AT REST: a velocity carried over
      // from before a reset would be a swoop across the level, which is the one
      // thing `snap` exists to stop.
      this.vel = Vec2.ZERO;
      this.zoomVel = 0;
      this.logZoom = Math.log(Math.max(1e-9, target.zoom));
      this.aim = this.softEdge(camera, target.pos, follow, Infinity);
      this.pos = this.holdEdge(camera, this.aim, follow, Infinity);
      camera.position = this.pos;
      camera.zoom = this.zoom;
      return;
    }

    // WHAT WAS HERE: the frozen-delta hand-off. When the rule set changed - or
    // a branch jumped, or an anchor released, or a pin dropped - the gap
    // between what the outgoing set wanted and what the incoming one wants was
    // frozen at that instant and smoothstepped to zero over `CAMERA_BLEND_TIME`
    // on top of the incoming target.
    //
    // Every one of those is a step in the AIM, and the motion layer below
    // answers a step in the aim with a bounded swell whatever caused it, so
    // there is nothing left for a hand-off to do. What is lost with it is real
    // and worth naming: the blend was tunable per rule and the swell is not, so
    // a room that wanted a slow, deliberate crossing can no longer buy one.
    // What is gained is that there is exactly one timescale in the camera's
    // motion rather than two fighting over the same frames - which is what made
    // the old one unpredictable, since which of the two you got depended on
    // whether a rule identity happened to change.
    this.members = members;
    this.seat = nextSeat;
    this.pathS = s;
    this.pathNearS = nearS;
    this.pathLeadS = leadS;

    // A hitched frame is a frame the wall clock spent elsewhere, not a frame
    // the camera was allowed to fly across the level in.
    const step = Math.min(Math.max(0, dt), CAMERA_MAX_DT);

    // The zoom first, because the frame guarantee is a fraction of the frame and
    // the frame is what the zoom decides. Through the same spring, in log space.
    const zoomStep = springStep(
      this.logZoom - Math.log(Math.max(1e-9, target.zoom)),
      this.zoomVel,
      step,
    );
    this.zoomVel = zoomStep.vel;
    this.logZoom += this.zoomVel * step;

    // The frame guarantee, in its two halves (see CAMERA_EDGE_MARGIN and the
    // parameters beside it). The SOFT half shapes what the camera is aiming
    // at, so the camera answers it through its own motion and its velocity
    // turns over rather than reversing; the HARD half is applied last and to
    // where the camera actually IS, because a target the avatar can outrun is
    // not a guarantee and outrunning the spring is exactly what a launch does.
    const aimPos = this.softEdge(camera, target.pos, follow, step);
    this.aim = aimPos;
    const before = this.pos;
    // The spring, then the caps, then integrate what is left. The caps are
    // taken as VECTOR lengths over both axes so a diagonal move is not faster
    // than an axial one, and the position is integrated from the capped
    // velocity rather than from the spring's own closed-form displacement -
    // which is what makes the cap bound the motion rather than only the
    // velocity that was asked for.
    const sx = springStep(this.pos.x - aimPos.x, this.vel.x, step);
    const sy = springStep(this.pos.y - aimPos.y, this.vel.y, step);
    let dv = new Vec2(sx.vel - this.vel.x, sy.vel - this.vel.y);
    const dvMax = CAMERA_MAX_ACCEL * step;
    if (dv.lengthSquared() > dvMax * dvMax) dv = dv.normalized().mul(dvMax);
    let vel = this.vel.add(dv);
    if (vel.lengthSquared() > CAMERA_MAX_SPEED * CAMERA_MAX_SPEED) {
      vel = vel.normalized().mul(CAMERA_MAX_SPEED);
    }
    this.vel = vel;
    this.pos = this.pos.add(vel.mul(step));
    const held = this.holdEdge(camera, this.pos, follow, step);
    // The floor may move the camera, and when it does the spring's velocity has
    // to become what the frame ACTUALLY moved: carried over unchanged it would
    // spend the next frame fighting a constraint that has already won, which is
    // the camera pressing against the floor instead of riding it.
    if (step > 0 && (held.x !== this.pos.x || held.y !== this.pos.y)) {
      this.vel = held.sub(before).div(step);
    }
    this.pos = held;

    camera.position = this.pos;
    camera.zoom = this.zoom;
  }

  // The SOFT half of the frame guarantee, applied to what the camera is AIMING
  // at rather than to where it is.
  //
  // That is the whole of what makes it smooth. Applied to the position it can
  // only ever be a correction - the camera's velocity is whatever the
  // correction happens to need this frame, and on a backswing that is a
  // reversal, since the camera is still advancing into a lead the avatar has
  // already left. Applied to the aim, the camera answers it through the motion
  // layer: the forward motion is bled off and turned over at a bounded
  // acceleration, and there is no frame on which the camera's speed jumps.
  //
  // The aim can be outrun, which is exactly why it is only the soft half; the
  // floor below cannot.
  //
  // The band is given OUTRIGHT rather than over a clock, because an aim is
  // rebuilt from the rule every frame and holds nothing: a fraction of it per
  // frame would be a band permanently weakened to that fraction rather than a
  // delayed one, and the delay belongs to the camera's own motion.
  //
  // And this is where the STICK lives (see CAMERA_STICK_TAU). While the window
  // is asking, the aim is its answer outright and the stick IS that answer;
  // when it stops asking, the stick decays instead of vanishing, so the aim
  // comes back to the rule's target over a second and a half. Held as a signed
  // displacement rather than as a coordinate, so a target that crosses the
  // follow point carries the stick with it rather than having it re-applied on
  // the wrong side.
  private softEdge(camera: Camera, aim: Vec2, follow: Vec2, dt: number): Vec2 {
    if (!this.edgeClamp) {
      this.aimPullX = 0;
      this.aimPullY = 0;
      this.stickX = 0;
      this.stickY = 0;
      return aim;
    }
    const hard = edgeReach(camera, this.zoom);
    const inner = innerReach(camera, this.zoom);
    const x = edgeAxis(aim.x, follow.x, inner.x, hard.x, Infinity);
    const y = edgeAxis(aim.y, follow.y, inner.y, hard.y, Infinity);
    this.aimPullX = x.pull;
    this.aimPullY = y.pull;
    // `Infinity` here is a snap and wants no decay at all - the camera is being
    // placed, not moved.
    const decay = Number.isFinite(dt) ? Math.exp(-Math.max(0, dt) / CAMERA_STICK_TAU) : 0;
    this.stickX = stick(x.pos - aim.x, this.stickX * decay);
    this.stickY = stick(y.pos - aim.y, this.stickY * decay);
    return new Vec2(aim.x + this.stickX, aim.y + this.stickY);
  }

  // The HOLDING half, on where the camera actually IS and applied last: the
  // same band given at the rate law, and the hard floor under it. The avatar
  // may never be in the frame's edge band, whatever rule is in force and
  // however fast they got there.
  //
  // The aim can be outrun and this cannot, which is why there are two of them
  // rather than one. What outruns it is not only a launch but the camera's own
  // motion: a critically damped spring trails a steady target by `2 * speed /
  // omega` and cannot turn faster than CAMERA_MAX_ACCEL at all, so a sustained
  // excursion would otherwise ride the floor - the one place a step is left -
  // even though the aim it is chasing is comfortably inside.
  //
  // This is where the SMOOTHING lives, and it is the one place a fraction of
  // the demand per frame means a delay rather than a weakening: `this.pos` is
  // carried to the next frame, so the fractions accumulate in it and what the
  // camera performs is a first-order approach to the inner margin. Nothing
  // beside the position holds any of it (see `edgeAxis`).
  //
  // Clamping `this.pos` rather than only what is handed to the Camera is what
  // keeps the next frame's ease continuous - the camera really is where the
  // constraint put it, so it carries on from there instead of being dragged
  // back to an illegal position every frame.
  private holdEdge(camera: Camera, pos: Vec2, follow: Vec2, dt: number): Vec2 {
    if (!this.edgeClamp) {
      this.edge = null;
      return pos;
    }
    const reach = edgeReach(camera, this.zoom);
    const inner = innerReach(camera, this.zoom);
    const hx = edgeAxis(pos.x, follow.x, inner.x, reach.x, dt);
    const hy = edgeAxis(pos.y, follow.y, inner.y, reach.y, dt);
    const clamped = new Vec2(hx.pos, hy.pos);
    const engaged = this.aimPullX > 0 || this.aimPullY > 0;
    this.edge =
      engaged || clamped.x !== pos.x || clamped.y !== pos.y
        ? { centre: clamped, reach, inner }
        : null;
    return clamped;
  }
}
