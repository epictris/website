// Camera behaviour: an eased follow of the avatar, reshaped by the level's
// camera regions.
//
// Deliberately render-side, driven by wall-clock dt rather than the fixed
// timestep: the camera is not part of the simulation, so easing it can never
// change a recorded run. (The grapple controller un-projects the cursor through
// the camera, so the camera does reach the sim as *input* — but the recorded
// trace stores the resulting world point, so replays stay bit-identical.)
//
// Two independent smoothings, because they want very different timescales:
//
//  1. **Follow lag** (CAMERA_FOLLOW_TAU, ~0.15 s) — an exponential ease of the
//     camera toward its target. This is the "not rigidly locked to the player"
//     part; it is short enough to never feel like the camera is behind.
//  2. **Region hand-off** (CAMERA_BLEND_TIME, ~0.7 s, per-region override) -
//     when the governing region changes, the gap between what the outgoing
//     region wanted and what the incoming one wants is *frozen* at that instant
//     and smoothstepped to zero on top of the incoming (live) target.
//
// Freezing that delta is the whole point. The camera aims at the correct
// position for the region it is now in, displaced by a decaying constant, so
// two very different configurations that happen to agree at the crossing hand
// over invisibly - the delta is simply zero. Cross-fading the two *live*
// targets instead, as this used to, keeps the outgoing region tracking the
// avatar for the whole blend, so its decaying share hauls the camera off the
// correct position and then lets it snap back: rubber banding whose size has
// nothing to do with how far apart the two cameras actually are.
//
// The avatar is still tracked live throughout, because the delta rides on the
// incoming target rather than replacing it.
//
// A single mechanism covers default→region, region→region and region→default:
// "no region" is just the null region, whose target is the plain follow point.

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
  DEFAULT_VIEWPORT_SCALE,
} from "../level/levelFormat";
import type { Camera } from "./camera";
import {
  buildPolylineIndex,
  flattenPath,
  pathNodesOf,
  pointAtArcLength,
  projectOntoPolyline,
  projectOntoPolylineWindow,
  type PolylineIndex,
} from "./cameraPath";
import type { Margin } from "./shapePath";
import { marginSides, uniformMargin } from "./shapePath";

// Exponential follow time constant, seconds — the time to close ~63% of the
// distance to the target. Small enough to stay responsive, large enough to take
// the edge off a landing or a hook release.
export const CAMERA_FOLLOW_TAU = 0.15;

// Default region cross-fade, seconds. A region may override it with `blend`.
export const CAMERA_BLEND_TIME = 0.7;

// How far outside a region the avatar must travel before the region lets go,
// when the region does not author a `buffer` of its own. Without it, hovering
// exactly on a boundary re-triggers the cross-fade every frame and the camera
// stutters, so it is sized for jitter and nothing more.
export const REGION_EXIT_MARGIN = 0.15; // metres

// Metres per second of allowance, beyond the player's own motion, for the
// window the held path's projection is searched in. The player's `followDelta`
// term means no legitimate move can outrun the window however fast the avatar
// is flung; this is the slack on top of it, and the `dt` it is multiplied by is
// what keeps the window frame-rate independent.
export const PATH_TRACK_SLACK_SPEED = 5;

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
// This is the one camera rule with no authored override, and deliberately: a
// level may frame the avatar however it likes, and none of those framings is
// allowed to be "off the bottom of the screen".
export const CAMERA_EDGE_MARGIN = 0.08;

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


// A rule governing the camera: one of the two kinds of authored thing that can
// reshape it. Both are governed by the SAME priority/buffer logic below, which
// is why they generalise into one list rather than each carrying a copy of it.
//
// A path's `index` is built once, at level construction: it is the authored
// curve FLATTENED into a polyline, in WORLD space (see `cameraPath.ts`), and
// nothing mutates a path at runtime. Everything downstream - the projection, the
// arc length, the lookahead, the corridor - rides that polyline and knows
// nothing about the Bézier handles that produced it.
export type CameraRule =
  | { kind: "region"; region: CameraRegionData }
  | { kind: "path"; path: CameraPathData; index: PolylineIndex };

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
    ...paths.map((path): CameraRule => ({
      kind: "path",
      path,
      index: buildPolylineIndex(
        flattenPath(pathNodesOf(path.verts)),
        new Vec2(path.x, path.y),
        path.rot,
      ),
    })),
  ];
}

function rulePriority(r: CameraRule): number {
  return (r.kind === "region" ? r.region.priority : r.path.priority) ?? 0;
}

function ruleBlend(r: CameraRule | null): number | undefined {
  return r === null ? undefined : r.kind === "region" ? r.region.blend : r.path.blend;
}

// The distance along `dir` that lands on the ellipse with semi-axes `ax`, `ay`.
//
// This is how every per-axis distance on a path is resolved into the one arc
// length the geometry deals in: moving by `L` along `dir` displaces by
// `L * dir`, and this is the `L` that puts that displacement on the ellipse. So
// a horizontal route takes `ax`, a vertical one `ay`, and a diagonal what fits
// between - which is the whole point of the pairs, since a 16:9 frame has far
// less screen above and below the player than either side of them.
//
// `dir` need not be normalised, and a zero one answers `ax`: a path with
// nowhere left to go is horizontal as far as this is concerned.
function ellipseReach(ax: number, ay: number, dir: Vec2): number {
  const a = Math.max(1e-6, ax);
  const b = Math.max(1e-6, ay);
  const len = dir.length();
  if (len < 1e-9) return a;
  return 1 / Math.hypot(dir.x / len / a, dir.y / len / b);
}

// How far along the path the camera leads, for a route heading in `dir`.
export function pathLookahead(p: CameraPathData, dir: Vec2): number {
  return ellipseReach(
    p.lookaheadX ?? DEFAULT_PATH_LOOKAHEAD_X,
    p.lookaheadY ?? DEFAULT_PATH_LOOKAHEAD_Y,
    dir,
  );
}

// The width of the lead's deadband, for a route heading in `dir` - the same
// ellipse, so a band authored for a corridor is not most of the vertical screen
// in a shaft. Both axes zero means no band at all, which `ellipseReach`'s floor
// would otherwise turn into a micron of one.
export function pathLookaheadBuffer(p: CameraPathData, dir: Vec2): number {
  const bx = Math.max(0, p.lookaheadBufferX ?? DEFAULT_PATH_LOOKAHEAD_BUFFER_X);
  const by = Math.max(0, p.lookaheadBufferY ?? DEFAULT_PATH_LOOKAHEAD_BUFFER_Y);
  if (bx === 0 && by === 0) return 0;
  return ellipseReach(bx, by, dir);
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
export function committedLeadS(s: number, held: number, buffer: number): number {
  return Math.min(Math.max(held, s - buffer), s + buffer);
}

// The range's and falloff's per-axis pairs, floored at zero. Every distance a
// path measures OFF the route goes through these and `ellipseReach`, so the
// corridor, the falloff band and the release are all screen-shaped: the frame
// is 16:9, and a circular corridor wide enough to mean anything horizontally
// is off the bottom of the screen vertically (see DEFAULT_PATH_RANGE_X/_Y).
//
// Unlike the lookahead's ellipse - which is resolved against the direction the
// ROUTE runs - these are resolved against the direction the player actually
// left the route in, because that is the displacement the screen has to hold.
export function pathRangeAxes(p: CameraPathData): { x: number; y: number } {
  return {
    x: Math.max(0, p.rangeX ?? DEFAULT_PATH_RANGE_X),
    y: Math.max(0, p.rangeY ?? DEFAULT_PATH_RANGE_Y),
  };
}

export function pathFalloffAxes(p: CameraPathData): { x: number; y: number } {
  return {
    x: Math.max(0, p.falloffX ?? DEFAULT_PATH_FALLOFF_X),
    y: Math.max(0, p.falloffY ?? DEFAULT_PATH_FALLOFF_Y),
  };
}

// The semi-axes of the falloff band's outer ellipse, and of the release
// ellipse beyond it. Exported so the overlay and the editor draw exactly the
// boundaries the functions below test - the same one-source rule
// `pathOutlineGrown` follows for a region's buffer.
export function pathBandAxes(p: CameraPathData): { x: number; y: number } {
  const r = pathRangeAxes(p);
  const f = pathFalloffAxes(p);
  return { x: r.x + f.x, y: r.y + f.y };
}

export function pathReleaseAxes(p: CameraPathData): { x: number; y: number } {
  const band = pathBandAxes(p);
  const b = p.buffer ?? REGION_EXIT_MARGIN;
  return { x: band.x + b, y: band.y + b };
}

// How far off the route the path's corridor reaches, for a player displaced
// along `dir`.
export function pathRange(p: CameraPathData, dir: Vec2): number {
  const r = pathRangeAxes(p);
  return ellipseReach(r.x, r.y, dir);
}

// The outer edge of the falloff band along `dir` - the ellipse with semi-axes
// (rangeX + falloffX, rangeY + falloffY), where the path's target has faded to
// exactly the plain follow.
export function pathBand(p: CameraPathData, dir: Vec2): number {
  const band = pathBandAxes(p);
  return ellipseReach(band.x, band.y, dir);
}

// How far from the polyline a path keeps its grip along `dir`: the band's
// outer edge grown by the path's jitter hysteresis on both axes - which falls
// back to the same default a region's does. Growing the SEMI-AXES rather than
// adding to the resolved reach is what keeps the release boundary an ellipse,
// so the editor and the overlay can draw exactly the zone tested here.
export function pathRelease(p: CameraPathData, dir: Vec2): number {
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
export function pathFalloffWeight(p: CameraPathData, offset: Vec2): number {
  const inner = pathRange(p, offset);
  const outer = pathBand(p, offset);
  if (outer - inner < 1e-9) return 0;
  const t = Math.min(Math.max((offset.length() - inner) / (outer - inner), 0), 1);
  return smoothstep(t);
}

// The avatar's displacement from their global projection onto the polyline.
// Its length is the projection's own `dist`; its direction is what the range
// and falloff ellipses are resolved along.
function pathOffset(index: PolylineIndex, p: Vec2): Vec2 {
  return p.sub(pointAtArcLength(index, projectOntoPolyline(index, p).s));
}

// Does `p` fall inside the rule at all? Containment for a region, displacement
// from the polyline against the range ellipse for a path - which is the whole
// difference between the two kinds and the reason a path is not a region with
// a funny shape.
function ruleContains(r: CameraRule, p: Vec2): boolean {
  if (r.kind === "region") return pointInRegion(r.region, p);
  const off = pathOffset(r.index, p);
  return off.length() <= pathRange(r.path, off);
}

// Does the incumbent keep its grip? Its volume grown by `regionBuffer` for a
// region; the release ellipse for a path, measured to `pathOff` - the
// displacement from the WINDOWED projection the controller is tracking, not
// from the global closest point, so a switchback passing nearby cannot hold a
// player who has fallen off the branch they were actually on.
function ruleHolds(r: CameraRule, p: Vec2, pathOff: Vec2 | null): boolean {
  if (r.kind === "region") return pointInRegion(r.region, p, regionBuffer(r.region));
  const off = pathOff ?? pathOffset(r.index, p);
  return off.length() <= pathRelease(r.path, off);
}

// The rule governing the camera for an avatar at `p`. Highest `priority` among
// the rules containing it wins; a tie goes to the later one, so the authoring
// order breaks it. `current` (the rule in force last frame) keeps its grip
// anywhere inside its own buffer zone, unless a rule of strictly higher
// priority has taken over.
//
// Entering is deliberately *not* buffered: a rule takes over the moment the
// avatar is inside it, and only giving it up is delayed. That asymmetry is what
// makes the buffer authorable as "how far out of this room I may stray without
// the camera changing its mind" — a swing that leaves through one wall and
// comes straight back keeps one camera for the whole arc, where a buffer on
// entry would instead grab the region early from outside.
//
// Priority still overrides the grip, and is the escape hatch for the case a
// wide buffer creates: a small, deliberately-framed volume sitting inside a big
// buffered one needs some way to take the camera, and saying so explicitly is
// better than shrinking the buffer until the overlap happens to work out.
export function activeCameraRule(
  rules: readonly CameraRule[],
  p: Vec2,
  current: CameraRule | null = null,
  // Displacement from the WINDOWED projection on `current` to `p`, when
  // `current` is a path. The controller is the only thing that has it, so it
  // passes it in rather than this recomputing a global answer that means
  // something else.
  currentPathOffset: Vec2 | null = null,
): CameraRule | null {
  let best: CameraRule | null = null;
  for (const r of rules) {
    if (!ruleContains(r, p)) continue;
    if (!best || rulePriority(r) >= rulePriority(best)) best = r;
  }
  if (
    current &&
    rules.includes(current) &&
    ruleHolds(current, p, currentPathOffset) &&
    (!best || rulePriority(best) <= rulePriority(current))
  ) {
    return current;
  }
  return best;
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
  // The falloff weight (see `pathFalloffWeight`), resolved by the controller
  // from the avatar's true projection. Zero for a region and for null.
  w = 0,
): CameraTarget {
  if (!rule) return { pos: follow, zoom: baseZoom };
  if (rule.kind === "path") {
    // pointAtArcLength clamps, which is the correct degenerate behaviour:
    // near the end of the path the camera comes to rest centred on that end
    // rather than staring past it.
    const pathPos = pointAtArcLength(rule.index, s + pathLeadAlong(rule, s));
    const pathZoom = baseZoom / Math.max(0.01, rule.path.viewportScale ?? DEFAULT_VIEWPORT_SCALE);
    // Through the falloff band the target is interpolated toward the NULL
    // rule's - the plain follow at the base zoom - so lookahead, viewport
    // scale and everything else the path asks for fade together, and at the
    // band's outer edge the two targets are identical: the release delta is
    // zero by construction. The zoom interpolates geometrically like every
    // zoom blend here, so it reads as even.
    if (w <= 0) return { pos: pathPos, zoom: pathZoom };
    return {
      pos: pathPos.add(follow.sub(pathPos).mul(w)),
      zoom: lerpZoom(pathZoom, baseZoom, w),
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
function pathLeadAlong(rule: CameraRule & { kind: "path" }, s: number): number {
  const here = pointAtArcLength(rule.index, s);
  const first = pathLookahead(rule.path, tangentAt(rule.index, s));
  const chord = pointAtArcLength(rule.index, s + first).sub(here);
  return pathLookahead(rule.path, chord.lengthSquared() > 0 ? chord : tangentAt(rule.index, s));
}

// The polyline's direction at `s`, from a short chord across it. A chord rather
// than the segment it falls on, so a projection landing exactly on a vertex
// answers the average of the two edges rather than whichever one wins the tie.
function tangentAt(index: PolylineIndex, s: number): Vec2 {
  const h = 0.05;
  return pointAtArcLength(index, s + h).sub(pointAtArcLength(index, s - h));
}

// How far the camera centre may be from the follow point, per axis, before the
// avatar enters the keep-out band at the edge of the frame.
//
// Zero when the margin is wider than half the frame, which pins the camera on
// the avatar rather than inverting the clamp and shoving it out the far side.
export function edgeReach(camera: Camera, zoom: number): Vec2 {
  const scale = Math.max(1e-6, zoom * PIXELS_PER_METER);
  const keep = Math.max(0, 1 - 2 * CAMERA_EDGE_MARGIN);
  return new Vec2(
    ((camera.viewportWidth / 2) * keep) / scale,
    ((camera.viewportHeight / 2) * keep) / scale,
  );
}

// The nearest camera position to `pos` that keeps `follow` out of the frame's
// edge band. Applied to where the camera ACTUALLY IS rather than to what it is
// aiming at: a target the avatar can outrun is not a guarantee, and outrunning
// the ease is exactly what a fast swing or a launch does.
export function clampToEdge(camera: Camera, zoom: number, follow: Vec2, pos: Vec2): Vec2 {
  const r = edgeReach(camera, zoom);
  return new Vec2(
    Math.min(Math.max(pos.x, follow.x - r.x), follow.x + r.x),
    Math.min(Math.max(pos.y, follow.y - r.y), follow.y + r.y),
  );
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

// Geometric interpolation — the right one for a scale factor, so blending 1→4
// passes through 2 rather than 2.5 and the zoom reads as even.
const lerpZoom = (a: number, b: number, t: number): number =>
  Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

// The camera state the debug overlay draws (see `CameraController.held`).
export interface HeldCamera {
  rule: CameraRule | null;
  // The avatar's projection along a held path, and the deadbanded arc length
  // the lookahead is actually taken from. Both meaningless unless `rule` is a
  // path.
  s: number;
  leadS: number;
  // The edge constraint, when it is what is holding the camera this frame:
  // where the camera centre is and how far from the follow point it is allowed
  // to be. Null whenever the clamp is not binding, so the overlay drawing it at
  // all means the camera is being held rather than following.
  edge: { centre: Vec2; reach: Vec2 } | null;
}

export class CameraController {
  // The camera's own smoothed state, kept here rather than read back off the
  // Camera: callers are free to post-process camera.position for framing (the
  // ball controller shifts it up a tenth of a viewport) without that shift
  // feeding back into the next frame's easing.
  private pos = Vec2.ZERO;
  private zoom = 1;
  private started = false;

  // The rule in force last frame.
  private rule: CameraRule | null = null;

  // Path tracking, alongside the smoothing state and reset with it by `snap()`.
  // `pathS` is last frame's projection along the held path and `lastFollow` is
  // where the avatar was when it was taken; together they size the window this
  // frame's projection is searched in (see `trackPath`).
  private pathS = 0;
  private lastFollow = Vec2.ZERO;
  // The arc length the LEAD is measured from: `pathS` held in the path's
  // lookahead deadband (see `committedLeadS`). Equal to `pathS` on acquisition
  // and whenever the band is being dragged; anywhere inside it while a swing
  // runs back and forth underneath.
  private pathLeadS = 0;

  // Set on any frame the edge clamp actually moved the camera (see
  // `clampToEdge`), for the debug overlay and for nothing else.
  private edge: { centre: Vec2; reach: Vec2 } | null = null;

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

  // Hand-off state: the target gap frozen when the rule last changed - the
  // outgoing position minus the incoming one, and the outgoing zoom over the
  // incoming one - decayed to nothing over `dur`, with `s` the raw progress.
  private offset = Vec2.ZERO;
  private zoomRatio = 1;
  private s = 1;
  private dur = CAMERA_BLEND_TIME;

  // The rule actually in force, for the debug overlay. It cannot be recomputed
  // there: the grip depends on which rule held the camera last frame, so a
  // recomputed answer disagrees with the camera for the whole width of the
  // buffer, which is exactly what the overlay is opened to see.
  get activeRule(): CameraRule | null {
    return this.rule;
  }

  // What the overlay needs to draw the rule in force, in one object so the
  // renderer's parameter list does not grow a field at a time. It cannot be
  // recomputed there: the grip, the windowed projection and the lead deadband
  // are all stateful, so a recomputed answer disagrees with the camera exactly
  // where the overlay is opened to look.
  get held(): HeldCamera {
    return { rule: this.rule, s: this.pathS, leadS: this.pathLeadS, edge: this.edge };
  }

  // Drop the easing for one frame — the camera arrives at its target instantly.
  // Used on level start/reset, where easing in from the last frame's position
  // would be a swoop across the level.
  snap(): void {
    this.started = false;
  }

  // The held path's projection, searched only within what the player could
  // plausibly have moved along it. The `followDelta` term means no legitimate
  // move can outrun the window however fast the avatar is flung, and the `dt`
  // term keeps it frame-rate independent.
  //
  // Confining it is what makes a switchback behave: the global closest point
  // flips branches the instant the player is nearer the other one, many metres
  // of arc length in a frame, and the hand-off blend cannot help because the
  // rule identity has not changed.
  private trackPath(
    rule: CameraRule & { kind: "path" },
    follow: Vec2,
    dt: number,
  ): { s: number; dist: number } {
    const maxStep = follow.distanceTo(this.lastFollow) + PATH_TRACK_SLACK_SPEED * Math.max(0, dt);
    return projectOntoPolylineWindow(rule.index, follow, this.pathS - maxStep, this.pathS + maxStep);
  }

  update(
    camera: Camera,
    dt: number,
    follow: Vec2,
    rules: readonly CameraRule[],
    baseZoom: number,
  ): void {
    if (!this.started) {
      // A snap is history-free: there is no incumbent to keep a grip, and no
      // tracked projection or committed lead to continue from.
      this.rule = null;
      this.pathS = 0;
      this.pathLeadS = 0;
      this.lastFollow = follow;
    }

    // Resolved BEFORE the rule decision, because a path's grip is measured to
    // the windowed projection rather than to the global closest point. The
    // offset is the same displacement as a vector, which is what the range and
    // falloff ellipses are resolved along.
    const heldPath = this.rule?.kind === "path" ? this.trackPath(this.rule, follow, dt) : null;
    const heldOffset =
      this.rule?.kind === "path" && heldPath
        ? follow.sub(pointAtArcLength(this.rule.index, heldPath.s))
        : null;

    const next = activeCameraRule(rules, follow, this.rule, heldOffset);

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
    let proj =
      next?.kind !== "path"
        ? null
        : next === this.rule
          ? heldPath!
          : projectOntoPolyline(next.index, follow);
    let offset =
      next?.kind !== "path"
        ? null
        : next === this.rule
          ? heldOffset!
          : follow.sub(pointAtArcLength(next.index, proj!.s));
    let branchJump = false;
    if (
      next?.kind === "path" &&
      next === this.rule &&
      offset!.length() > pathRange(next.path, offset!) + (next.path.buffer ?? REGION_EXIT_MARGIN)
    ) {
      const g = projectOntoPolyline(next.index, follow);
      const goff = follow.sub(pointAtArcLength(next.index, g.s));
      if (goff.length() <= pathRange(next.path, goff)) {
        proj = g;
        offset = goff;
        branchJump = true;
      }
    }
    const s = proj?.s ?? 0;

    // Acquiring a path commits the lead to the projection outright - entering
    // (a branch jump included) is history-free, so the band starts centred on
    // the avatar rather than holding an offset earned somewhere else on the
    // route.
    const leadS =
      next?.kind !== "path"
        ? 0
        : next === this.rule && !branchJump
          ? committedLeadS(
              s,
              this.pathLeadS,
              // Measured where the BAND currently sits, not where the avatar
              // is: the band is the thing being sized, and on a bend the two
              // are different directions.
              pathLookaheadBuffer(next.path, tangentAt(next.index, this.pathLeadS)),
            )
          : s;

    // The falloff weight, from the avatar's TRUE displacement off the route -
    // the windowed one while held, so at a switchback the weight is about the
    // branch they are actually on, exactly as the grip is.
    const w = next?.kind !== "path" ? 0 : pathFalloffWeight(next.path, offset!);

    const target = cameraRuleTarget(next, follow, baseZoom, leadS, w);

    if (!this.started) {
      this.started = true;
      this.rule = next;
      this.pathS = s;
      this.pathLeadS = leadS;
      this.offset = Vec2.ZERO;
      this.zoomRatio = 1;
      this.s = 1;
      this.zoom = target.zoom;
      this.pos = this.applyEdge(camera, target.pos, follow);
      camera.position = this.pos;
      camera.zoom = this.zoom;
      return;
    }

    if (next !== this.rule || branchJump) {
      // The discrepancy is measured between the two *targets*, not against
      // where the camera is: aiming at the camera's own position would drop its
      // velocity to nothing for an instant, which reads as a hitch. Taken this
      // way the aim point is unchanged on the crossing frame, so the camera
      // carries its follow lag straight through and only the delta decays.
      // Any remainder of an interrupted hand-off is folded in, which keeps that
      // case continuous too.
      //
      // A branch jump comes through here too even though the rule identity is
      // unchanged: the jump in arc length moves the lookahead target by the
      // gap between the branches, and freezing that delta is exactly what this
      // machinery is for.
      //
      // An outgoing PATH is evaluated at its tracked projection, not at a fresh
      // global one: both targets have to be measured at the same instant and on
      // the same branch, or the frozen delta is a gap that never existed.
      const prev = cameraRuleTarget(
        this.rule,
        follow,
        baseZoom,
        this.pathLeadS,
        this.rule?.kind === "path" && heldOffset
          ? pathFalloffWeight(this.rule.path, heldOffset)
          : 0,
      );
      const rest = 1 - smoothstep(this.s);
      this.offset = prev.pos.add(this.offset.mul(rest)).sub(target.pos);
      this.zoomRatio = (prev.zoom * this.zoomRatio ** rest) / target.zoom;
      this.s = 0;
      // Entering a rule uses its blend; leaving one back to the default uses
      // the blend of the rule being left, so a handoff feels symmetric.
      this.dur = ruleBlend(next) ?? ruleBlend(this.rule) ?? CAMERA_BLEND_TIME;
      this.rule = next;
    }
    this.pathS = s;
    this.pathLeadS = leadS;
    this.lastFollow = follow;
    this.s = this.dur > 0 ? Math.min(1, this.s + dt / this.dur) : 1;

    // What is left of the hand-off discrepancy, laid on top of the live target.
    const k = 1 - smoothstep(this.s);
    const aim: CameraTarget = {
      pos: target.pos.add(this.offset.mul(k)),
      zoom: target.zoom * this.zoomRatio ** k,
    };

    // Frame-rate independent exponential ease: the same time constant on a
    // 60 Hz and a 144 Hz display.
    const t = 1 - Math.exp(-Math.max(0, dt) / CAMERA_FOLLOW_TAU);
    this.pos = this.pos.add(aim.pos.sub(this.pos).mul(t));
    this.zoom = lerpZoom(this.zoom, aim.zoom, t);

    // LAST, and on the camera's own state rather than on the target: the avatar
    // may never be in the frame's edge band, whatever rule is in force and
    // however fast it got there. Clamping `this.pos` rather than only what is
    // handed to the Camera is what keeps the next frame's ease continuous -
    // the camera really is where the constraint put it, so it carries on from
    // there instead of being dragged back to an illegal position every frame.
    this.pos = this.applyEdge(camera, this.pos, follow);

    camera.position = this.pos;
    camera.zoom = this.zoom;
  }

  private applyEdge(camera: Camera, pos: Vec2, follow: Vec2): Vec2 {
    if (!this.edgeClamp) {
      this.edge = null;
      return pos;
    }
    const clamped = clampToEdge(camera, this.zoom, follow, pos);
    this.edge =
      clamped.x !== pos.x || clamped.y !== pos.y
        ? { centre: clamped, reach: edgeReach(camera, this.zoom) }
        : null;
    return clamped;
  }
}
