// Rails - the thin bars the manacle clamps AROUND rather than bites into, and
// then slides along: a zipline, a pipe, the handle of a hanging lantern.
//
// A rail is a per-shape flag (`CollisionShape2D.rail`, authored as
// `CollisionObjectData.rail`), so one body may be a rail on one piece and
// hook-proof on the next - the lantern whose handles the hook can grab and
// whose lid, bulb and base it bounces off. This module is everything the flag
// means once it is set: where the cuff's centre lives on the shape (its
// CENTRELINE), how far along it the cuff may travel (its RANGE), and how it
// moves under the chain's pull against the rail's friction (the SLIDE).
//
// What it is NOT is a body. The clamp is a `RopeAttachment` on the rail's own
// body whose contact can move, so the anchored chain keeps every rule it has -
// the rail on a static is a fixed anchor, the rail on a hanging lantern is a
// lever on that lantern, the winch, the credits, the refusals - and sliding is
// one term inside the length solve (see `Rope.correctShapePositionAndRotation`).
// The hook body itself is removed when it clamps, exactly as when it bites.
//
// The cuff is treated as MASSLESS. A quarter-kilo ring under a fifty-kilo
// ball's pull accelerates at thousands of m/s², so within a frame it is
// wherever force balance puts it, and force balance for a ring on a bar is the
// friction cone: while the pull stays inside the cone the ring is stuck, and
// when it leaves the ring runs along the bar until the pull is back on the
// cone's edge. The slide is therefore solved geometrically rather than
// integrated - there is no ring velocity to keep - and that is what makes a
// ball under a frictionless rail coast at constant speed with a vertical chain
// (a zipline), and under a rail with friction `mu` decelerate at `mu·g` with the
// chain trailing at `atan(mu)`, which is Coulomb friction exactly.

import { dmath } from "../engine/dmath";
import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { Mathf } from "../engine/mathf";
import {
  bumpTransformEpoch,
  type CollisionObject2D,
  type CollisionShape2D,
} from "../engine/body";
import { circleOverlap, sweepCircle } from "../engine/collision";
import { polyCentroid, polySignedArea2, type Shape } from "../engine/shapes";
import { RopeAttachment, RopeContact } from "./ropeContact";
import { MANACLE_DISC } from "./manacle";

// Rubber on steel, which is what `friction: 1` means everywhere else in the
// level format (0 = ice, 1 = rubber). The cone test is a pure direction, so
// what these set is the angle the chain's pull may make with the rail's
// NORMAL before the cuff gives way - `atan(mu_s)`, 56° - and where a running
// cuff holds it, `atan(mu_k)`, 54.5°. A hanging ball's own weight is already
// off the normal by the rail's slope, so on a 30° bar the ball may swing 26°
// downhill of plumb before the cuff moves. Scaled by the body's authored
// `friction` exactly as a rigid body's contact friction is, so a zipline
// authored at `friction: 0.1` is slick.
//
// They started at 0.35 / 0.3 and then 0.8 / 0.6, and both read as no grip:
// at 19° every ordinary swing crept the cuff 15-20 cm along a friction-1 bar
// (`session-526f`), and at 31° a 30° slope was the balance point, so the ball
// hanging still rode the cuff down the whole bar at 1 m/s (`session-212f`).
// The gap between the two is kept small on purpose: a breakaway runs the cuff
// from the static cone to the kinetic one in a frame and frees
// `across·(1/cos a_s − 1/cos a_k)` of chain doing it, which at these two is
// 8% of the span rather than the 43% a 2.0 / 1.5 pair would drop the ball by.
// Both are still guesses to be PLAYED; `cli rails` pins Coulomb's law against
// them rather than pinning them.
export const RAIL_STATIC_FRICTION = 1.5;
export const RAIL_KINETIC_FRICTION = 1.4;

// How fast the cuff may run along the bar, m/s. The massless idealisation above
// moves the ring to force balance INSTANTLY, which for a ball swung wide past
// the static cone is a jump of half a metre in one frame; a real quarter-kilo
// ring covers that in two or three frames, and a cap is the cheapest honest
// stand-in for that inertia. The hook's own throw speed: a ring may keep up with
// anything the ball can do on the end of its chain, and no faster.
export const RAIL_MAX_SLIDE_SPEED = 12;

// Two rail pieces of one body whose centrelines pass within this of each other
// at an end are ONE rail as far as the cuff is concerned: it slides off the end
// of one and onto the other. Measured against the sum of the two bars'
// half-widths (a bar meeting a bar of the same thickness at a mitre, or
// overlapping it at a corner), plus this much slack for a snap grid.
export const RAIL_JOIN_SLACK = 1 * PX;

// A shape's centreline in its own frame: the segment the cuff's centre lives on,
// from `a` to `b`, and the half-width of the bar across it. `a === b` for a peg
// (a circle, a square), which the ring hangs on and pivots about but cannot
// slide along.
export interface Centreline {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly halfWidth: number;
}

// The centreline of a rail shape.
//
// A rect's is its medial axis: along the longer side, shortened by the
// half-thickness at each end so the cuff's centre never leaves the bar. A
// polygon's is the principal axis of its area through its centroid, clipped to
// the outline and shortened by the half-width across the axis, so a bar with
// mitred ends is a rail along its length. A circle's is a point at its centre.
export function railCentreline(shape: Shape): Centreline {
  if (shape.kind === "circle") {
    return { a: Vec2.ZERO, b: Vec2.ZERO, halfWidth: shape.radius };
  }
  if (shape.kind === "rect") {
    const hw = shape.size.x * 0.5;
    const hh = shape.size.y * 0.5;
    if (hw >= hh) {
      const reach = hw - hh;
      return { a: new Vec2(-reach, 0), b: new Vec2(reach, 0), halfWidth: hh };
    }
    const reach = hh - hw;
    return { a: new Vec2(0, -reach), b: new Vec2(0, reach), halfWidth: hw };
  }
  return polyCentreline(shape.verts);
}

// The principal axis of a convex loop's area, clipped to the loop. The second
// moments of area come from the standard polygon formula (the same sums the
// centroid is built from, one degree higher), taken about the centroid, and
// the axis of greatest spread is the eigenvector of the 2×2 covariance they
// form: at angle `atan2(2·Ixy, Ixx − Iyy) / 2` from +x.
function polyCentreline(verts: readonly Vec2[]): Centreline {
  const c = polyCentroid(verts);
  const a2 = polySignedArea2(verts);
  if (Math.abs(a2) < 1e-12 || verts.length < 3) return { a: c, b: c, halfWidth: 0 };
  // ∫x², ∫y², ∫xy over the area, about the centroid. Written against the
  // centred vertices so no parallel-axis shift is needed afterwards, and
  // against the loop's winding: the edge weights carry the signed area's sign,
  // and the half-angle below turns a sign flip on both moments into a QUARTER
  // turn of the axis rather than the half turn that would leave the line
  // alone. An engine shape is always wound positive; an authored outline the
  // editor draws the glyph from may be either.
  const sign = a2 >= 0 ? 1 : -1;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i]!.sub(c);
    const q = verts[(i + 1) % verts.length]!.sub(c);
    const w = p.cross(q) * sign;
    sxx += (p.x * p.x + p.x * q.x + q.x * q.x) * w;
    syy += (p.y * p.y + p.y * q.y + q.y * q.y) * w;
    sxy += (p.x * q.y + 2 * p.x * p.y + 2 * q.x * q.y + q.x * p.y) * w;
  }
  // `sxx`/12 and `syy`/12 are the moments and `sxy`/24 the product; the angle
  // wants 2·product against the moments' difference, which is `sxy`/12
  // against `(sxx - syy)`/12, so the common factor drops out.
  const angle = 0.5 * dmath.atan2(sxy, sxx - syy);
  const axis = new Vec2(dmath.cos(angle), dmath.sin(angle));
  const across = axis.orthogonal();
  // Clip the axis line through the centroid to the loop, and measure the bar's
  // half-width as the widest reach of any vertex across the axis.
  let tMin = 0;
  let tMax = 0;
  let halfWidth = 0;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i]!.sub(c);
    const q = verts[(i + 1) % verts.length]!.sub(c);
    halfWidth = Math.max(halfWidth, Math.abs(p.dot(across)));
    // The edge p→q meets the axis line where its across-coordinate is zero.
    const pa = p.dot(across);
    const qa = q.dot(across);
    if ((pa <= 0 && qa >= 0) || (pa >= 0 && qa <= 0)) {
      const span = qa - pa;
      const u = Math.abs(span) < 1e-12 ? 0 : -pa / span;
      const t = p.add(q.sub(p).mul(u)).dot(axis);
      tMin = Math.min(tMin, t);
      tMax = Math.max(tMax, t);
    }
  }
  const lo = tMin + halfWidth;
  const hi = tMax - halfWidth;
  // A piece wider than it is long has no axis to speak of: a peg.
  if (hi <= lo) return { a: c, b: c, halfWidth };
  return { a: c.add(axis.mul(lo)), b: c.add(axis.mul(hi)), halfWidth };
}

// A shape's centreline in its OWNER's local frame - the frame `RopeContact`
// stores positions in - so a clamp on a compound body's piece is welded to the
// body however the piece is mounted.
export function bodyCentreline(shape: CollisionShape2D): Centreline {
  const local = railCentreline(shape.shape);
  return {
    a: shape.localOffset.add(local.a.rotated(shape.localRotation)),
    b: shape.localOffset.add(local.b.rotated(shape.localRotation)),
    halfWidth: local.halfWidth,
  };
}

// Where a body-local point projects onto a centreline: metres along it from
// `a`, clamped to the segment.
function paramAlong(line: Centreline, p: Vec2): number {
  const ab = line.b.sub(line.a);
  const len = ab.length();
  if (len < 1e-12) return 0;
  return Mathf.clamp(p.sub(line.a).dot(ab) / len, 0, len);
}

// The span of the centreline the cuff may occupy on one piece, metres from `a`.
export interface ClampRange {
  readonly min: number;
  readonly max: number;
}

// A clamp's slide state, as a value (see `RopeClamp.snapshot`).
export interface ClampState {
  readonly shapeIndex: number;
  readonly s: number;
  readonly range: ClampRange;
  readonly sliding: boolean;
}

// The chain's end clamped around a rail: an attachment whose contact can move.
//
// `s` is metres along the piece's body-local centreline from its `a` end;
// `range` is where on that line the cuff's disc is clear of the body's other,
// non-rail pieces; `sliding` is the friction state - stuck ends are held by
// the static cone, running ones by the kinetic one, which is the same
// hysteresis the hook's own contact friction has.
export class RopeClamp extends RopeAttachment {
  s: number;
  range: ClampRange;
  sliding = false;
  private line: Centreline;

  private constructor(contact: RopeContact, line: Centreline, s: number, range: ClampRange) {
    super(contact);
    this.line = line;
    this.s = s;
    this.range = range;
  }

  // Clamp around piece `shapeIndex` of `body` at the centreline point nearest
  // the world point the hook bit. The bite is on the bar's surface; the cuff's
  // centre is a half-width in from it, which is the small jump the manacle
  // makes as it closes around the bar.
  static at(body: CollisionObject2D, shapeIndex: number, world: Vec2): RopeClamp {
    const shape = body.getShapes()[shapeIndex] ?? body.primaryShape();
    const line = bodyCentreline(shape);
    const local = world.sub(body.globalPosition).rotated(-body.globalRotation);
    const s = paramAlong(line, local);
    const contact = RopeContact.restore(body, pointAt(line, s), shapeIndex);
    const clamp = new RopeClamp(contact, line, s, { min: 0, max: 0 });
    clamp.range = clamp.measureRange();
    return clamp;
  }

  // The state a slide may change, for the length solve's monotone guard to
  // put back: which piece the cuff is on, where along it, the range there and
  // the friction state.
  snapshot(): ClampState {
    return {
      shapeIndex: this.contact.shapeIndex,
      s: this.s,
      range: this.range,
      sliding: this.sliding,
    };
  }

  restoreState(state: ClampState): void {
    if (state.shapeIndex !== this.contact.shapeIndex) {
      this.contact.shapeIndex = state.shapeIndex;
      this.line = bodyCentreline(this.contact.shape);
    }
    this.range = state.range;
    this.sliding = state.sliding;
    this.setParam(state.s);
  }

  override genIdentifier(): string {
    return "Clamp on " + this.contact.genIdentifier();
  }

  get body(): CollisionObject2D {
    return this.contact.obj;
  }

  // The rail's direction at the cuff, in the world, from `a` toward `b`. Null
  // for a peg, which has no direction to slide in.
  tangent(): Vec2 | null {
    const ab = this.line.b.sub(this.line.a);
    if (ab.lengthSquared() < 1e-24) return null;
    return ab.normalized().rotated(this.body.globalRotation);
  }

  // Length of the piece's centreline, metres.
  get length(): number {
    return this.line.b.sub(this.line.a).length();
  }

  // Move the cuff to `s` along the current piece. The contact is body-local, so
  // this is the one write; the transform epoch is bumped because the rope's
  // memoized span list is keyed on it and no body has moved.
  setParam(s: number): void {
    this.s = s;
    this.contact.position = pointAt(this.line, s);
    bumpTransformEpoch();
  }

  // Slide the cuff under the chain's pull. `prev` is the node the last span runs
  // to (world), `budget` the metres the cuff may still travel this frame (the
  // speed cap's remainder), `mus`/`muk` the rail's static and kinetic
  // coefficients, and `settle` says this is the frame's FIRST look at the
  // clamp. Returns the metres travelled along the rail (signed toward `b`).
  //
  // The friction state is decided once a frame, on that first look: a running
  // ring whose pull has come back inside the kinetic cone since the last frame
  // has stopped being driven and is stuck from here (the static cone holds it
  // from then on); one whose pull is still outside it runs to the cone's edge
  // again. The solve's later iterations of the same frame find the ring AT the
  // edge - force balance, nothing to move - and must not read that as the ring
  // having come to rest, or a ring under a ball driving it steadily would
  // re-stick every frame and break away every frame, which is a stick-slip
  // judder at frame rate where a steady slide is the physics: the chain
  // trailing at `atan(mu_k)` and the ball braked at `mu_k·g`.
  //
  // Sliding may leave the chain SLACK - the ring at the cone's edge can be
  // nearer the ball than a span's length - and that is the physics rather than
  // an artefact: a ball swung wide past the static cone is released from its
  // arc, flies, and is caught when the chain comes taut again.
  slide(prev: Vec2, budget: number, mus: number, muk: number, settle: boolean): number {
    let remaining = budget;
    let travelled = 0;
    // A few pieces at most per call: a cuff crossing a joint continues on the
    // next piece with what is left of its budget, and a lantern handle is three.
    for (let hop = 0; hop < 4 && remaining > 0; hop++) {
      const t = this.tangent();
      if (t === null) {
        this.sliding = false;
        return travelled;
      }
      const p = prev.sub(this.contact.globalPosition);
      const ds = slideStep(p, t, this.sliding, mus, muk);
      if (ds === 0) {
        if (settle) this.sliding = false;
        return travelled;
      }
      // The pull is outside the cone: the ring is running.
      this.sliding = true;
      // Toward `b` for a positive step, and no further than the range or the
      // frame's budget allow.
      const sign = ds > 0 ? 1 : -1;
      const toEdge = Math.abs(ds);
      const wanted = Math.min(toEdge, remaining);
      const room = sign > 0 ? this.range.max - this.s : this.s - this.range.min;
      const moved = Math.min(wanted, Math.max(0, room));
      if (moved > 0) {
        this.setParam(this.s + sign * moved);
        travelled += sign * moved;
        remaining -= moved;
      }
      // Reached the cone's edge, or cut short by the frame's budget: either
      // way the ring is still running, and next frame decides whether the
      // ball is still driving it.
      if (moved >= wanted) return travelled;
      // Stopped by the range. At the piece's own end that may be a joint onto a
      // sibling rail; anywhere else it is a wall (the lantern's lid), and the
      // ring presses against it, still running in the sense that the pull is
      // still outside the cone.
      if (!this.hop(sign)) return travelled;
    }
    return travelled;
  }

  // Cross from the end of this piece's centreline onto a sibling rail piece
  // whose centreline passes within a bar's width of that end. Returns false at
  // a range end that is not the centreline's own end (a clipped range: the
  // cuff is against something) or when no sibling joins there.
  private hop(sign: 1 | -1): boolean {
    const atEnd = sign > 0 ? this.s >= this.length - 1e-9 : this.s <= 1e-9;
    if (!atEnd) return false;
    const end = pointAt(this.line, this.s);
    const shapes = this.body.getShapes();
    let best: { index: number; line: Centreline; s: number; d: number } | null = null;
    for (let i = 0; i < shapes.length; i++) {
      if (i === this.contact.shapeIndex) continue;
      const sibling = shapes[i]!;
      if (!sibling.rail) continue;
      const line = bodyCentreline(sibling);
      const s = paramAlong(line, end);
      const d = pointAt(line, s).distanceTo(end);
      const tolerance = this.line.halfWidth + line.halfWidth + RAIL_JOIN_SLACK;
      if (d <= tolerance && (best === null || d < best.d)) best = { index: i, line, s, d };
    }
    if (best === null) return false;
    this.line = best.line;
    this.contact.shapeIndex = best.index;
    this.setParam(best.s);
    this.range = this.measureRange();
    return true;
  }

  // Where along the current piece the cuff's disc is clear of the body's other
  // non-rail pieces: the manacle's disc swept from the cuff toward each end of
  // the centreline against every such sibling. The cuff stops where the disc
  // meets the lantern's lid, which is what a ring on a handle does.
  //
  // Only siblings of the SAME body clip the range, because only they are
  // welded to the rail: the answer is a constant of the body. Other bodies do
  // not - the hook body that would have collided with them is gone once it
  // clamps, exactly as when it bites - so a rail run through another body's
  // wall is a level-design mistake rather than a collision.
  private measureRange(): ClampRange {
    const body = this.body;
    const shapes = body.getShapes();
    const here = this.contact.globalPosition;
    const t = this.tangent();
    let min = 0;
    let max = this.length;
    if (t === null) return { min: 0, max: 0 };
    for (let i = 0; i < shapes.length; i++) {
      if (i === this.contact.shapeIndex) continue;
      const sibling = shapes[i]!;
      if (sibling.rail) continue;
      // A disc already inside a sibling cannot be swept out of it, and a ring
      // clamped right at a joint with the lid is that case: leave the piece to
      // the pull, which will move the ring away from it.
      if (circleOverlap(here, MANACLE_DISC, sibling)) continue;
      const toMax = this.length - this.s;
      if (toMax > 0) {
        const hit = sweepCircle(here, t.mul(toMax), MANACLE_DISC, sibling);
        if (hit) max = Math.min(max, this.s + hit.t * toMax);
      }
      const toMin = this.s;
      if (toMin > 0) {
        const hit = sweepCircle(here, t.mul(-toMin), MANACLE_DISC, sibling);
        if (hit) min = Math.max(min, this.s - hit.t * toMin);
      }
    }
    return { min, max };
  }
}

// The point `s` metres along a centreline from `a`.
function pointAt(line: Centreline, s: number): Vec2 {
  const ab = line.b.sub(line.a);
  const len = ab.length();
  if (len < 1e-12) return line.a;
  return line.a.add(ab.mul(s / len));
}

// One slide step on a straight rail, as pure arithmetic.
//
// `p` is the chain's pull as a vector from the cuff to the node the last span
// runs to, `t` the rail's unit tangent, both in the world. The pull splits into
// `along` (signed, toward `b`) and `across`; the ring is stuck while
// `|along| <= mu·across` - inside the friction cone - and otherwise runs
// toward the ball's plumb until the pull is back on the KINETIC cone's edge,
// which is `|along| − muk·across` metres away. The static coefficient holds a
// stuck ring, the kinetic one a running one.
//
// Returns the signed metres to the kinetic cone's edge (positive toward `b`),
// or 0 for a ring the cone holds - which for a running ring means the pull is
// inside the kinetic cone or exactly on its edge, and whether that is the ring
// coming to rest is the caller's call (see `RopeClamp.slide`).
export function slideStep(p: Vec2, t: Vec2, sliding: boolean, mus: number, muk: number): number {
  const along = p.dot(t);
  const across = Math.abs(p.cross(t));
  const mu = sliding ? muk : mus;
  if (Math.abs(along) <= mu * across) return 0;
  const toEdge = Math.abs(along) - muk * across;
  if (toEdge <= 0) return 0;
  return along > 0 ? toEdge : -toEdge;
}

// A shape's centreline placed in the world, for drawing: the renderers hand
// over a placed shape (the game its interpolated render transform, the editor
// an authored item), and both draw the same line the cuff will ride.
export function centrelineAt(shape: Shape, pos: Vec2, rot: number): { a: Vec2; b: Vec2 } {
  const line = railCentreline(shape);
  return { a: pos.add(line.a.rotated(rot)), b: pos.add(line.b.rotated(rot)) };
}

// The centreline of a mounted rail piece in the WORLD, at its sim pose.
export function worldCentreline(shape: CollisionShape2D): { a: Vec2; b: Vec2 } {
  return centrelineAt(shape.shape, shape.globalPosition, shape.globalRotation);
}
