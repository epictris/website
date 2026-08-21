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
import type { CameraPathData, CameraRegionData } from "../level/levelFormat";
import {
  DEFAULT_PATH_LOOKAHEAD_BUFFER_X,
  DEFAULT_PATH_LOOKAHEAD_BUFFER_Y,
  DEFAULT_PATH_LOOKAHEAD_X,
  DEFAULT_PATH_LOOKAHEAD_Y,
  DEFAULT_PATH_RANGE,
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

export function pathRange(p: CameraPathData): number {
  return p.range ?? DEFAULT_PATH_RANGE;
}

// How far from the polyline a path keeps its grip: its range plus its own
// hysteresis, which falls back to the same jitter default a region's does.
export function pathRelease(p: CameraPathData): number {
  return pathRange(p) + (p.buffer ?? REGION_EXIT_MARGIN);
}

// Does `p` fall inside the rule at all? Containment for a region, distance to
// the polyline for a path - which is the whole difference between the two kinds
// and the reason a path is not a region with a funny shape.
function ruleContains(r: CameraRule, p: Vec2): boolean {
  if (r.kind === "region") return pointInRegion(r.region, p);
  return projectOntoPolyline(r.index, p).dist <= pathRange(r.path);
}

// Does the incumbent keep its grip? Its volume grown by `regionBuffer` for a
// region; `range + buffer` for a path, measured to `pathDist` - the WINDOWED
// projection the controller is tracking, not the global closest point, so a
// switchback passing nearby cannot hold a player who has fallen off the branch
// they were actually on.
function ruleHolds(r: CameraRule, p: Vec2, pathDist: number | null): boolean {
  if (r.kind === "region") return pointInRegion(r.region, p, regionBuffer(r.region));
  const dist = pathDist ?? projectOntoPolyline(r.index, p).dist;
  return dist <= pathRelease(r.path);
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
  // Distance from `p` to the WINDOWED projection on `current`, when `current`
  // is a path. The controller is the only thing that has it, so it passes it in
  // rather than this recomputing a global answer that means something else.
  currentPathDist: number | null = null,
): CameraRule | null {
  let best: CameraRule | null = null;
  for (const r of rules) {
    if (!ruleContains(r, p)) continue;
    if (!best || rulePriority(r) >= rulePriority(best)) best = r;
  }
  if (
    current &&
    rules.includes(current) &&
    ruleHolds(current, p, currentPathDist) &&
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
): CameraTarget {
  if (!rule) return { pos: follow, zoom: baseZoom };
  if (rule.kind === "path") {
    return {
      // pointAtArcLength clamps, which is the correct degenerate behaviour:
      // near the end of the path the camera comes to rest centred on that end
      // rather than staring past it.
      pos: pointAtArcLength(rule.index, s + pathLeadAlong(rule, s)),
      zoom: baseZoom / Math.max(0.01, rule.path.viewportScale ?? DEFAULT_VIEWPORT_SCALE),
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
    return { rule: this.rule, s: this.pathS, leadS: this.pathLeadS };
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
    // the windowed projection rather than to the global closest point.
    const heldPath = this.rule?.kind === "path" ? this.trackPath(this.rule, follow, dt) : null;

    const next = activeCameraRule(rules, follow, this.rule, heldPath?.dist ?? null);

    // Acquiring a path is unbuffered and history-free, exactly as entering a
    // region is: a path that was not the incumbent is projected onto globally.
    const s =
      next?.kind !== "path"
        ? 0
        : next === this.rule
          ? heldPath!.s
          : projectOntoPolyline(next.index, follow).s;

    // Acquiring a path commits the lead to the projection outright - entering
    // is history-free, so the band starts centred on the avatar rather than
    // holding an offset earned somewhere else on the route.
    const leadS =
      next?.kind !== "path"
        ? 0
        : next === this.rule
          ? committedLeadS(
              s,
              this.pathLeadS,
              // Measured where the BAND currently sits, not where the avatar
              // is: the band is the thing being sized, and on a bend the two
              // are different directions.
              pathLookaheadBuffer(next.path, tangentAt(next.index, this.pathLeadS)),
            )
          : s;

    const target = cameraRuleTarget(next, follow, baseZoom, leadS);

    if (!this.started) {
      this.started = true;
      this.rule = next;
      this.pathS = s;
      this.pathLeadS = leadS;
      this.offset = Vec2.ZERO;
      this.zoomRatio = 1;
      this.s = 1;
      this.pos = target.pos;
      this.zoom = target.zoom;
      camera.position = this.pos;
      camera.zoom = this.zoom;
      return;
    }

    if (next !== this.rule) {
      // The discrepancy is measured between the two *targets*, not against
      // where the camera is: aiming at the camera's own position would drop its
      // velocity to nothing for an instant, which reads as a hitch. Taken this
      // way the aim point is unchanged on the crossing frame, so the camera
      // carries its follow lag straight through and only the delta decays.
      // Any remainder of an interrupted hand-off is folded in, which keeps that
      // case continuous too.
      //
      // An outgoing PATH is evaluated at its tracked projection, not at a fresh
      // global one: both targets have to be measured at the same instant and on
      // the same branch, or the frozen delta is a gap that never existed.
      const prev = cameraRuleTarget(this.rule, follow, baseZoom, this.pathLeadS);
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

    camera.position = this.pos;
    camera.zoom = this.zoom;
  }
}
