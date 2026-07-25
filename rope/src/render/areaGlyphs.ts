// Glyph geometry for non-body areas, as plain closed polygons.
//
// Areas are regions, not surfaces — nothing rests on them and the rope passes
// through — so they must never be mistakable for geometry in a screenshot (see
// docs/game-design.md, "Areas must read as areas"). Each area type carries a
// glyph saying what it does: a force area flows arrows along its push, a
// killzone is stamped with skulls.
//
// The glyphs are emitted as polygons into a `PolyPath` sink rather than drawn,
// so the canvas renderer, the level editor and the headless SVG snapshot all
// lay out the same marks from one source. Callers fill outline-plus-glyphs as a
// single even-odd path, which makes the glyphs *cutouts*: they show whatever is
// behind the area, so they stay legible against any authored fill colour,
// including an opaque one. Nested rings (a skull's eye sockets) flip back to
// solid under the same rule, which is what gives the skull its face.
//
// Everything here is decoration, driven by the wall clock, never by the
// fixed-step sim — it can not influence a recorded replay.

import { Vec2 } from "../engine/vec2";

// Sink for closed polygons. CanvasRenderingContext2D satisfies it as-is.
export interface PolyPath {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

// Glyphs are a fixed world size, not a fraction of the area: a long river and a
// small vent read as the same current, and only the glyph *count* grows with
// the box. Metres.
const GLYPH_SPACING = 0.42; // nominal gap between glyph centres
const ARROW_LEN = 0.26;
const SKULL_SIZE = 0.3; // total height
// Perf guard for a level-sized area. Past this the lattice is thinned (glyphs
// keep their size); it only bites well beyond a screenful.
const MAX_GLYPHS = 1200;
// Drift speed per unit of acceleration, in seconds: the 3 m/s² default current
// scrolls at ~1 m/s, a readable walking pace.
const DRIFT_PER_ACCEL = 0.35;
// Past this the motion just strobes, so speed stops encoding magnitude.
const MAX_DRIFT = 5;

const mod = (a: number, m: number): number => ((a % m) + m) % m;

// A centred lattice at fixed spacing over the area's local frame, scrolled
// along +X by `driftMetres`. The count grows with the area, the spacing does
// not — stretching the lattice to fill the box exactly would make the gap (and
// so the apparent density) depend on the box again.
function lattice(
  half: Vec2,
  circle: boolean,
  driftMetres: number,
  visit: (x: number, y: number) => void,
): void {
  if (half.x <= 0 || half.y <= 0) return;
  const spanX = half.x * 2;
  const spanY = half.y * 2;
  let step = GLYPH_SPACING;
  const wanted = Math.round(spanX / step) * Math.round(spanY / step);
  if (wanted > MAX_GLYPHS) step *= Math.sqrt(wanted / MAX_GLYPHS);

  const cols = Math.max(1, Math.round(spanX / step));
  // A disc's widest chord is through its centre, so it wants a row *on* the
  // centre line: an even count straddles it and leaves the middle bare.
  const fitRows = Math.max(1, Math.round(spanY / step));
  const rows = circle ? Math.max(1, 2 * Math.round((fitRows - 1) / 2) + 1) : fitRows;

  const phase = mod(driftMetres, step);
  for (let iy = 0; iy < rows; iy++) {
    const y = (iy - (rows - 1) / 2) * step;
    // One extra column at each end, so a glyph enters as another leaves.
    for (let ix = -1; ix <= cols; ix++) {
      visit((ix - (cols - 1) / 2) * step + phase, y);
    }
  }
}

// A closed regular polygon, used wherever a glyph wants a disc. Polygons keep
// every sink to three operations, so the SVG writer needs no arc support.
function disc(p: PolyPath, cx: number, cy: number, r: number, segments = 12): void {
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
}

// One block arrow, pointing along `dir` and centred on (cx, cy).
function arrowGlyph(p: PolyPath, cx: number, cy: number, dir: number): void {
  const len = ARROW_LEN;
  const headHalf = len * 0.3;
  const headLen = len * 0.38;
  const shaft = headHalf * 0.34;
  const tail = cx - (dir * len) / 2;
  const tip = cx + (dir * len) / 2;
  const base = tip - dir * headLen;
  p.moveTo(tail, cy - shaft);
  p.lineTo(base, cy - shaft);
  p.lineTo(base, cy - headHalf);
  p.lineTo(tip, cy);
  p.lineTo(base, cy + headHalf);
  p.lineTo(base, cy + shaft);
  p.lineTo(tail, cy + shaft);
  p.closePath();
}

// A skull: cranium arc tapering into a jaw, with eye sockets, a nose and two
// tooth gaps nested inside it. Under the even-odd rule the outline is a hole
// (bone, showing the backdrop) and the nested rings flip back to the area's
// fill (the dark features) — the same way a real skull reads.
function skullGlyph(p: PolyPath, cx: number, cy: number): void {
  const s = SKULL_SIZE;
  const r = 0.375 * s; // cranium radius
  const ccy = cy - 0.125 * s; // cranium centre

  // Cranium: 270° of arc from the lower left, over the top, to the lower right.
  const SEG = 18;
  for (let i = 0; i <= SEG; i++) {
    const a = Math.PI * 0.75 + Math.PI * 1.5 * (i / SEG);
    const x = cx + Math.cos(a) * r;
    const y = ccy + Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  // Jaw, narrower than the cranium so the cheekbones read.
  p.lineTo(cx + 0.22 * s, cy + 0.22 * s);
  p.lineTo(cx + 0.2 * s, cy + 0.5 * s);
  p.lineTo(cx - 0.2 * s, cy + 0.5 * s);
  p.lineTo(cx - 0.22 * s, cy + 0.22 * s);
  p.closePath();

  disc(p, cx - 0.16 * s, cy - 0.15 * s, 0.105 * s);
  disc(p, cx + 0.16 * s, cy - 0.15 * s, 0.105 * s);

  // Nose.
  p.moveTo(cx, cy - 0.01 * s);
  p.lineTo(cx - 0.045 * s, cy + 0.09 * s);
  p.lineTo(cx + 0.045 * s, cy + 0.09 * s);
  p.closePath();

  // Two tooth gaps.
  for (const sx of [-1, 1]) {
    p.moveTo(cx + sx * 0.03 * s, cy + 0.26 * s);
    p.lineTo(cx + sx * 0.085 * s, cy + 0.26 * s);
    p.lineTo(cx + sx * 0.085 * s, cy + 0.46 * s);
    p.lineTo(cx + sx * 0.03 * s, cy + 0.46 * s);
    p.closePath();
  }
}

// Drift of a force area's arrow lattice, in metres, at wall-clock `timeMs`.
// Speed carries the magnitude (clamped): a fast river visibly runs faster than
// a lazy one, and a negative magnitude reverses heads and motion alike.
function arrowDrift(magnitude: number, timeMs: number): number {
  const dir = magnitude < 0 ? -1 : 1;
  return (timeMs / 1000) * dir * Math.min(MAX_DRIFT, Math.abs(magnitude) * DRIFT_PER_ACCEL);
}

// Flow arrows for a force area, in its local frame (+X is the push direction).
export function forceAreaGlyphs(
  p: PolyPath,
  half: Vec2,
  circle: boolean,
  magnitude: number,
  timeMs: number,
): void {
  if (magnitude === 0) return;
  const dir = magnitude < 0 ? -1 : 1;
  lattice(half, circle, arrowDrift(magnitude, timeMs), (x, y) => arrowGlyph(p, x, y, dir));
}

// Skulls for a killzone, in its local frame. Static: a killzone does not flow,
// and a moving stamp would imply it does.
export function killZoneGlyphs(p: PolyPath, half: Vec2, circle: boolean): void {
  lattice(half, circle, 0, (x, y) => skullGlyph(p, x, y));
}
