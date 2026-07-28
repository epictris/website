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
//  2. **Region cross-fade** (CAMERA_BLEND_TIME, ~0.7 s, per-region override) —
//     a smoothstep between the *targets* of the outgoing and incoming regions.
//     Both targets are evaluated live every frame, so the avatar keeps being
//     tracked all the way through a transition instead of the camera dragging
//     from a stale point.
//
// A single mechanism covers default→region, region→region and region→default:
// "no region" is just the null region, whose target is the plain follow point.

import { Vec2 } from "../engine/vec2";
import type { CameraRegionData } from "../level/levelFormat";
import { DEFAULT_VIEWPORT_SCALE } from "../level/levelFormat";
import type { Camera } from "./camera";

// Exponential follow time constant, seconds — the time to close ~63% of the
// distance to the target. Small enough to stay responsive, large enough to take
// the edge off a landing or a hook release.
export const CAMERA_FOLLOW_TAU = 0.15;

// Default region cross-fade, seconds. A region may override it with `blend`.
export const CAMERA_BLEND_TIME = 0.7;

// How far outside a region the avatar must travel before the region lets go.
// Without it, hovering exactly on a boundary re-triggers the cross-fade every
// frame and the camera stutters.
const REGION_EXIT_MARGIN = 0.15; // metres

export interface CameraTarget {
  pos: Vec2;
  zoom: number;
}

// Is a world point inside a region's (rotated) volume, optionally grown by
// `margin` on every side?
export function pointInRegion(r: CameraRegionData, p: Vec2, margin = 0): boolean {
  if (r.shape.kind === "circle") {
    return p.distanceTo(new Vec2(r.x, r.y)) <= r.shape.r + margin;
  }
  const l = p.sub(new Vec2(r.x, r.y)).rotated(-r.rot);
  return Math.abs(l.x) <= r.shape.w / 2 + margin && Math.abs(l.y) <= r.shape.h / 2 + margin;
}

// The region governing the camera for an avatar at `p`. Highest `priority`
// among the containing regions wins; a tie goes to the later one, so the
// authoring order breaks it. `current` (the region in force last frame) keeps
// its grip until the avatar leaves it by REGION_EXIT_MARGIN, unless a region of
// strictly higher priority has taken over.
export function activeCameraRegion(
  regions: readonly CameraRegionData[],
  p: Vec2,
  current: CameraRegionData | null = null,
): CameraRegionData | null {
  let best: CameraRegionData | null = null;
  for (const r of regions) {
    if (!pointInRegion(r, p)) continue;
    if (!best || (r.priority ?? 0) >= (best.priority ?? 0)) best = r;
  }
  if (
    current &&
    regions.includes(current) &&
    pointInRegion(current, p, REGION_EXIT_MARGIN) &&
    (!best || (best.priority ?? 0) <= (current.priority ?? 0))
  ) {
    return current;
  }
  return best;
}

// Where the camera wants to be under a given region, for an avatar at `follow`.
// Per axis: a lock pins it, otherwise it follows plus the region's offset. The
// null region is the default camera — the avatar, at the base zoom.
export function cameraRegionTarget(
  region: CameraRegionData | null,
  follow: Vec2,
  baseZoom: number,
): CameraTarget {
  if (!region) return { pos: follow, zoom: baseZoom };
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

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

// Geometric interpolation — the right one for a scale factor, so blending 1→4
// passes through 2 rather than 2.5 and the zoom reads as even.
const lerpZoom = (a: number, b: number, t: number): number =>
  Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

export class CameraController {
  // The camera's own smoothed state, kept here rather than read back off the
  // Camera: callers are free to post-process camera.position for framing (the
  // ball controller shifts it up a tenth of a viewport) without that shift
  // feeding back into the next frame's easing.
  private pos = Vec2.ZERO;
  private zoom = 1;
  private started = false;

  // Cross-fade state: `from` → `to` over `dur`, with `s` the eased progress.
  private from: CameraRegionData | null = null;
  private to: CameraRegionData | null = null;
  private s = 1;
  private dur = CAMERA_BLEND_TIME;

  // Drop the easing for one frame — the camera arrives at its target instantly.
  // Used on level start/reset, where easing in from the last frame's position
  // would be a swoop across the level.
  snap(): void {
    this.started = false;
  }

  update(
    camera: Camera,
    dt: number,
    follow: Vec2,
    regions: readonly CameraRegionData[],
    baseZoom: number,
  ): void {
    const next = activeCameraRegion(regions, follow, this.to);
    if (next !== this.to) {
      // An interrupted cross-fade restarts from the region it was heading to.
      // The blended target can jump by the unfinished remainder, but the follow
      // ease below low-passes it, so the camera itself stays continuous.
      this.from = this.to;
      this.to = next;
      this.s = 0;
      // Entering a region uses its blend; leaving one back to the default uses
      // the blend of the region being left, so a handoff feels symmetric.
      this.dur = next?.blend ?? this.from?.blend ?? CAMERA_BLEND_TIME;
    }
    this.s = this.dur > 0 ? Math.min(1, this.s + dt / this.dur) : 1;

    const a = cameraRegionTarget(this.from, follow, baseZoom);
    const b = cameraRegionTarget(this.to, follow, baseZoom);
    const k = smoothstep(this.s);
    const target: CameraTarget = {
      pos: a.pos.add(b.pos.sub(a.pos).mul(k)),
      zoom: lerpZoom(a.zoom, b.zoom, k),
    };

    if (!this.started) {
      this.started = true;
      this.s = 1;
      this.from = this.to;
      this.pos = cameraRegionTarget(this.to, follow, baseZoom).pos;
      this.zoom = cameraRegionTarget(this.to, follow, baseZoom).zoom;
    } else {
      // Frame-rate independent exponential ease: the same time constant on a
      // 60 Hz and a 144 Hz display.
      const t = 1 - Math.exp(-Math.max(0, dt) / CAMERA_FOLLOW_TAU);
      this.pos = this.pos.add(target.pos.sub(this.pos).mul(t));
      this.zoom = lerpZoom(this.zoom, target.zoom, t);
    }

    camera.position = this.pos;
    camera.zoom = this.zoom;
  }
}
