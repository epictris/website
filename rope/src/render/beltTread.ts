// A conveyor belt's TREAD: the marks every renderer puts on a belt's loop so a
// running belt reads as running (docs/conveyors.md, "Rendering").
//
// A belt's geometry never moves - only its surface does - so an outline drawn
// once says nothing about which way, or whether, it runs. The tread is short
// ticks across the loop at a fixed pitch, carried round it at the belt's own
// speed. It is the area glyphs' pattern (`areaGlyphs.ts`: a mark phased by
// time), with one difference: the phase is taken from the SIM clock rather than
// the wall clock, because the belt's speed is a sim quantity and a replay has to
// show the same belt at the same frame.
//
// Render-side by construction: everything here reads a loop and a time and
// returns points; nothing writes anything the sim can see.

import { Vec2 } from "../engine/vec2";
import type { BeltLoop } from "../engine/shapes";
import { beltNormalAt, beltOutline, beltPointAt, buildBeltLoop } from "../lib/belt";
import { PATH_FLATTEN_STEP } from "../lib/path";

// The nominal spacing of the tread, in metres. The actual pitch is the nearest
// one that divides the perimeter a whole number of times, so the pattern has no
// seam where the arc length wraps (a short gap or a doubled tick would ride
// round the loop once a lap, which reads as a flaw in the belt).
export const BELT_TREAD_PITCH = 0.2;

// How far a tick reaches INTO the belt from its surface, in metres. Inward only:
// the outline is the collision surface, and a mark standing proud of it would
// be drawn where a crate resting on the belt sits.
const TREAD_DEPTH = 0.05;

// The simulation step: the tread's clock is the sim's frame count.
const STEP = 1 / 60;

// The belt of an on-disk (or editor) shape, in the object's own frame, or null
// for wheels that make no belt (one inside another, one inside the hull, a
// radius or a thickness of no size) - which the build refuses and an editor
// mid-edit still has to draw something for. The build's own rule, asked by
// building the loop, so the two cannot disagree about what is a belt.
export function beltLoopOf(s: { wheels: readonly { x: number; y: number; r: number }[]; thickness: number }): BeltLoop | null {
  try {
    return buildBeltLoop(
      s.wheels.map((w) => ({ c: new Vec2(w.x, w.y), r: w.r })),
      s.thickness,
    );
  } catch {
    return null;
  }
}

// The smallest wheel's own radius: the tightest bend either face of the band
// makes.
function smallestWheel(loop: BeltLoop): number {
  let r = Infinity;
  for (const w of loop.wheels) r = Math.min(r, w.r);
  return r;
}

// The loop flattened for DRAWING, `inset` inside the surface (the band's inner
// face at `loop.thickness`). `beltOutline`'s default step is the path
// flattener's 25 cm, which is sized for camera routes and bars metres long: on
// a 20 cm wheel it leaves three chords round the end, and the belt is drawn
// with an octagon for a wheel while it collides as a true circle. Drawn at no
// coarser than 48 chords a full turn of the smallest wheel instead, the
// rounding is below a pixel at any zoom the game reaches.
const WHEEL_CHORDS = 48;
export function beltDrawOutline(loop: BeltLoop, inset = 0): Vec2[] {
  const step = Math.min(PATH_FLATTEN_STEP, (2 * Math.PI * smallestWheel(loop)) / WHEEL_CHORDS);
  return beltOutline(loop, step, inset);
}

// The BAND as drawn in 2D: its outer loop (the running surface) and its inner
// loop (the wheels' side of it, `thickness` in), in the loop's frame. Filled
// together with the EVEN-ODD rule they are the band and nothing else, so the
// inside of the belt shows whatever is behind it - the backdrop, or the wheel
// props an author has put there. Cached per loop: a built loop never changes,
// and flattening it every frame would allocate two hundred points per belt per
// frame for nothing.
const bands = new WeakMap<BeltLoop, { outer: Vec2[]; inner: Vec2[] }>();
export function beltBand(loop: BeltLoop): { outer: Vec2[]; inner: Vec2[] } {
  let band = bands.get(loop);
  if (!band) {
    band = { outer: beltDrawOutline(loop), inner: beltDrawOutline(loop, loop.thickness) };
    bands.set(loop, band);
  }
  return band;
}

// The sim time a frame drawn at interpolation `alpha` stands for, in seconds.
// `frame` is the number of steps taken, and a body at `alpha` is drawn between
// the pose after step `frame - 1` and the one after step `frame`, so the tread
// is drawn at the same instant the bodies riding the belt are.
export function beltRenderTime(frame: number, alpha: number): number {
  return Math.max(0, frame - 1 + alpha) * STEP;
}

// The tread's pitch on this loop: the nominal pitch, adjusted so a whole number
// of them go round.
export function beltTreadPitch(loop: BeltLoop): number {
  const n = Math.max(3, Math.round(loop.total / BELT_TREAD_PITCH));
  return loop.total / n;
}

// The texture repeat a belt's running surface is drawn at, for a surface whose
// own repeat is `tile` metres: the nearest length that goes round the loop a
// whole number of times, so the pattern has no seam where `s` wraps - the
// tread pitch's rule, for the same reason (`render3d/beltTread.ts`).
export function beltTextureTile(loop: BeltLoop, tile: number): number {
  const n = Math.max(1, Math.round(loop.total / tile));
  return loop.total / n;
}

// How far round the loop the tread has been carried at `time`, reduced into one
// pitch. Signed speed, so a negative belt carries it the other way: positive
// `s` is clockwise on screen (`lib/belt.ts`), and so is a positive belt.
export function beltTreadPhase(loop: BeltLoop, speed: number, time: number): number {
  const pitch = beltTreadPitch(loop);
  const d = (time * speed) % pitch;
  return d < 0 ? d + pitch : d;
}

// The arc lengths the ticks sit at, for a phase.
export function beltTreadStations(loop: BeltLoop, phase: number): number[] {
  const pitch = beltTreadPitch(loop);
  const n = Math.round(loop.total / pitch);
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(phase + k * pitch);
  return out;
}

// How deep a tick reaches on this loop: the nominal depth, but never more than
// a third of the smallest arc, so a small wheel's ticks do not meet in the
// middle and read as spokes, and never more than 60% of the band, so a tick is
// a mark ON the band rather than a spike through it into the hollow inside.
export function beltTreadDepth(loop: BeltLoop): number {
  return Math.min(TREAD_DEPTH, (smallestWheel(loop) + loop.thickness) / 3, 0.6 * loop.thickness);
}

// A point of the loop and its unit tangent, written into `out` rather than
// returned: the 3D tread places every cleat every frame, and transform sync may
// not allocate (docs/render3d.md, "Traps"). The same segments and the same
// arithmetic as `beltPointAt` / `beltTangentAt` in `lib/belt.ts`, with the
// platform `Math` a renderer is allowed; `cli render3d` holds the two to agree.
export interface BeltFrame {
  x: number;
  y: number;
  tx: number;
  ty: number;
}

export function beltFrameAt(loop: BeltLoop, s: number, out: BeltFrame): BeltFrame {
  const c = loop.cum;
  let r = s % loop.total;
  if (r < 0) r += loop.total;
  if (r >= loop.total) r = 0;
  // The last segment starting at or before `r`, as `lib/belt.ts` finds it.
  let lo = 0;
  let hi = loop.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid]! <= r) lo = mid;
    else hi = mid - 1;
  }
  const seg = loop.segments[lo]!;
  const along = r - c[lo]!;
  if (seg.kind === "run") {
    out.x = seg.from.x + seg.dir.x * along;
    out.y = seg.from.y + seg.dir.y * along;
    out.tx = seg.dir.x;
    out.ty = seg.dir.y;
  } else {
    const t = seg.theta + along / seg.radius;
    out.x = seg.centre.x + Math.cos(t) * seg.radius;
    out.y = seg.centre.y + Math.sin(t) * seg.radius;
    out.tx = -Math.sin(t);
    out.ty = Math.cos(t);
  }
  return out;
}

// Every tick as a segment in the loop's frame: from the surface, inward along
// the normal.
export function beltTreadTicks(loop: BeltLoop, phase: number): { a: Vec2; b: Vec2 }[] {
  const depth = beltTreadDepth(loop);
  return beltTreadStations(loop, phase).map((s) => {
    const a = beltPointAt(loop, s);
    return { a, b: a.sub(beltNormalAt(loop, s).mul(depth)) };
  });
}
