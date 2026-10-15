import { MANACLE_BAND, MANACLE_RADIUS } from "../lib/manacle";
import { leafSpring } from "./vineLeafLag";

// The ball's ring is a solid annulus around the cord: its bore and its rim,
// measured from the cord's axis, and the band's axial thickness.
const RING_BORE = MANACLE_RADIUS - MANACLE_BAND / 2;
const RING_RIM = MANACLE_RADIUS + MANACLE_BAND / 2;
export const RING_HALF_WIDTH = MANACLE_BAND / 2;

// A pressed blade wraps the stem this far off its surface (`VineLayer`'s wrap)
// - or this far inside the ring's bore, if that is nearer the axis. The braid
// stands up to about 3.6 cm from its axis and the bore is 3.65 cm, so through
// the ring there is often no room for a leaf off the braid at all; it is then
// pressed into the braid's lobes, out of sight under the iron, rather than
// through the iron.
export const WRAP_CLEARANCE = .0015; // metres
export function wrapRadius(hingeRadius: number): number {
  return Math.min(hingeRadius + WRAP_CLEARANCE, RING_BORE - WRAP_CLEARANCE);
}

// A ring that moved further than this in a frame is followed in steps of it,
// so it cannot jump a blade it would have had to pass through or over.
const SWEEP_STEP = .004; // metres
const MAX_SWEEP_STEPS = 32;

// How far a blade's chord is from straight: the blade is hinged at its base and
// its tip stands at 0.92 of its length (`vineLeafGeometry`).
export const LEAF_CHORD = .92;

// A leaf folding at its base as the ball's ring slides over it - render-only,
// like the lag at its tip, and on the same spring.
//
// The blade is a straight chord of length `L` hinged at the stem's surface, at
// an angle `θ` from the stem's downstream tangent (0 lies flat down the vine,
// π flat up it). In the plane of the fold, measured from the hinge (axial `a`
// downstream, radial `r` outward), the ring's band is a SOLID RECTANGLE: its
// width along the cord, `x ± w/2` about the ring's centre, by the span from its
// bore to its rim, `gap = bore − ρ` to `rim − ρ`. The blade may not cross it,
// so `θ` may not lie in the angular span of the part of that rectangle within
// `L` of the hinge - an interval, since the part is convex and the hinge outside
// it, and bounded by its corners and by where its edges cross the circle `L`.
//
// The band's WIDTH is what makes a ring get past the hinge at all. A blade's
// base is inside the bore, so a ring can only cross it by folding the blade
// down the vine ahead of it or up the vine behind it, and the width forbids
// every angle in between (28°..152° with the ring centred on the hinge). A
// ring creeping DOWN over a drooping leaf threads over its base with the blade
// in the bore and presses it flatter the further it goes, until it clears the
// tip and lets go; a ring coming UP passes under the blade, meets it near the
// base and turns it over the hinge, laying it flat up the vine inside the bore
// until it has passed the tip. Nothing about which of those happens is decided
// here: the blade is held on whichever side of the forbidden span it was on,
// and a fast ring is followed in short steps so it is never on the wrong one.
// Pressed, it holds still; released, it springs back to its own rest angle.
//
// The state is the fold's DEPARTURE from the blade's own angle, which moves as
// the vine sways: a leaf no ring has touched is exactly at rest, and costs one
// comparison.
export class VineLeafFold {
  // Where the ring is threaded over this blade, in metres along it from the
  // hinge, as the last `update` left it; -1 when it is not. A threaded blade
  // passes through the bore, so it is wrapped round the stem there.
  threadedAt = -1;
  // Radians from the blade's own angle, and its rate.
  private offset = 0;
  private velocity = 0;
  private time = NaN;
  private ringX = NaN;
  private readonly spring: [number] = [0];

  reset(): void { this.offset = 0; this.velocity = 0; this.time = NaN; this.ringX = NaN; this.threadedAt = -1; }

  // The blade's angle this frame. `rest` is its own angle, `ring` the ring's
  // axial offset downstream of the hinge in metres (null: no ring on this
  // vine), `radius` the hinge's distance from the cord's axis, `length` the
  // blade's chord.
  update(rest: number, ring: number | null, radius: number, length: number, time: number): number {
    const dt = time - this.time;
    this.time = time;
    if (!(Number.isFinite(dt) && dt >= 0 && dt <= .1)) {
      // A seek, a teleport or the first frame: no history to carry.
      this.offset = 0; this.velocity = 0; this.ringX = NaN;
    } else if (dt === 0) {
      return rest + this.offset;
    } else if (ring === null || !Number.isFinite(this.ringX)) {
      this.relax(dt);
    }
    this.threadedAt = -1;
    if (ring === null) {
      this.ringX = NaN;
      return rest + this.offset;
    }
    const from = Number.isFinite(this.ringX) ? this.ringX : ring;
    const steps = Math.min(MAX_SWEEP_STEPS, Math.max(1, Math.ceil(Math.abs(ring - from) / SWEEP_STEP)));
    for (let k = 1; k <= steps; k++) {
      const before = rest + this.offset;
      if (Number.isFinite(this.ringX) && dt > 0) this.relax(dt / steps);
      this.hold(from + (ring - from) * k / steps, before, rest, radius, length);
    }
    this.ringX = ring;
    // Threaded: the ring is within the blade's reach and the blade on the
    // bore's side of it - below the span with the ring downstream, above it
    // with the ring upstream - rather than passing over its rim or away.
    const angle = rest + this.offset;
    if (forbiddenSpan(ring, radius, length, this.span) &&
      (ring > 0 ? angle <= this.span[0] + 1e-9 : angle >= this.span[1] - 1e-9)) this.threadedAt = Math.abs(ring);
    return angle;
  }

  private relax(dt: number): void {
    if (this.offset === 0 && this.velocity === 0) return;
    this.offset = leafSpring(this.offset, this.velocity, dt, this.spring);
    this.velocity = this.spring[0];
    if (Math.abs(this.offset) < 1e-6 && Math.abs(this.velocity) < 1e-5) { this.offset = 0; this.velocity = 0; }
  }

  // Push the blade out of the span the ring at `x` forbids, onto the side it
  // was on at `before`.
  private hold(x: number, before: number, rest: number, radius: number, length: number): void {
    if (!forbiddenSpan(x, radius, length, this.span)) return;
    const [lo, hi] = this.span;
    const angle = rest + this.offset;
    // No history - the first frame after a seek, or a ring just threaded on
    // over the blade: take it as the ring that slid down to here, as rings on
    // vines mostly do, or that landed on the blade and squeezed it. Either
    // way the blade is in the bore, not standing clear over the ring.
    if (!Number.isFinite(this.ringX) && x > 0) {
      if (angle > lo) { this.offset = lo - rest; this.velocity = 0; }
      return;
    }
    if (angle <= lo || angle >= hi) return;
    // The side it was on; a blade the span has moved over is put back on the
    // nearer edge, and one with no history (a ring threaded on over it) inside
    // the bore on the ring's far side, which is where a ring sliding along the
    // vine to that point would have left it.
    const pressed = x > 0 ? lo : hi;
    this.offset = (before <= lo ? lo : before >= hi ? hi :
      Number.isFinite(this.ringX) ? (before - lo < hi - before ? lo : hi) : pressed) - rest;
    this.velocity = 0;
  }
  private readonly span: [number, number] = [0, 0];
}

// The angles (lo, hi) a blade of chord `length`, hinged `radius` from the
// cord's axis, may not take with the ring's centre an axial `x` downstream of
// the hinge; false when it cannot reach the ring at all. The extremes of a
// convex region's angular span lie on its boundary, and along a straight edge
// or an arc about the hinge the angle is monotone, so the corners inside the
// circle and the edges' crossings of it are every candidate there is.
export function forbiddenSpan(x: number, radius: number, length: number, out: [number, number]): boolean {
  const a0 = x - RING_HALF_WIDTH, a1 = x + RING_HALF_WIDTH;
  // The bore less the wrap's radius: a blade wrapped at `R` about an axis that
  // rises with the chord stays inside the bore exactly when the chord's rise
  // at the ring is no more than `bore − R`.
  const r0 = RING_BORE - wrapRadius(radius), r1 = Math.max(r0, RING_RIM - radius);
  const l2 = length * length;
  let lo = Infinity, hi = -Infinity;
  const take = (a: number, r: number): void => {
    const angle = Math.atan2(r, a);
    if (angle < lo) lo = angle;
    if (angle > hi) hi = angle;
  };
  for (let i = 0; i < 2; i++) {
    const a = i ? a1 : a0, r = i ? r1 : r0;
    // The corners inside the circle.
    if (a0 * a0 + r * r <= l2) take(a0, r);
    if (a1 * a1 + r * r <= l2) take(a1, r);
    // A side (constant a) crossing it.
    if (a * a <= l2) {
      const across = Math.sqrt(l2 - a * a);
      if (across >= r0 && across <= r1) take(a, across);
    }
    // The bore or the rim (constant r) crossing it, either side of the hinge.
    if (r * r <= l2) {
      const along = Math.sqrt(l2 - r * r);
      if (along >= a0 && along <= a1) take(along, r);
      if (-along >= a0 && -along <= a1) take(-along, r);
    }
  }
  if (!(lo < hi)) return false;
  out[0] = lo; out[1] = hi;
  return true;
}
