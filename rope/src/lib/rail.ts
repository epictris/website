// Rails - the thin bars the manacle clamps AROUND rather than bites into, and
// then slides along: a zipline, a pipe, the handle of a hanging lantern.
//
// A rail is an authored CURVE with a width (`ShapeData`'s `curve`, with
// `CollisionObjectData.rail` set), stroked at load into the convex pieces the
// engine collides as (`lib/stroke.ts`) and leaving behind the one thing this
// module is about: the curve itself, as a `RailCurve` on every one of those
// pieces. The cuff's centre lives on that curve, so where the ring may stand,
// which way the bar runs under it and how far it may travel are all read off
// the line the author drew rather than derived from a box's proportions.
//
// What a rail is NOT is a body. The clamp is a `RopeAttachment` on the rail's
// own body whose contact can move, so the anchored chain keeps every rule it
// has - the rail on a static is a fixed anchor, the rail on a hanging lantern
// is a lever on that lantern, the winch, the credits, the refusals - and
// sliding is one term inside the length solve (see
// `Rope.correctShapePositionAndRotation`). The hook body itself is removed when
// it clamps, exactly as when it bites.
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
//
// The cuff is a RING, not a pin. Its inside RESTS on the bar at one point and
// everything else about it hangs from that point, the way a chain link laid
// over a rod does: the pull does not shift the ring sideways, it swings it,
// and the ring's centre - where the chain ends and the drawn cuff is centred -
// travels the arc of its own bore about the contact (`seat`). That is what
// the anchor, the drawn cuff and the chain hanging off it all read from, so
// the ring can never be drawn spinning about the middle of a bar it is only
// resting on.
//
// Massless to the BALL is not the same as stateless. Three things about the
// ring are its own and are carried from frame to frame rather than re-derived
// from whatever the chain happens to be doing (see `RopeClamp`):
//
//   - which SURFACE of the bar it rests on (`side`), which changes only when
//     the pull clearly comes from the other side of the bar;
//   - how far it has TILTED on that surface (`tilt`), which follows the pull
//     - or gravity, when nothing is pulling - at a bounded rate and never past
//     the angle the bar's own thickness jams it at;
//   - how fast it is RUNNING along the bar (`speed`), which is what lets a
//     ring on a vertical bar fall the moment it is threaded on, and a ring on
//     a zipline keep coasting after the chain goes slack.
//
// Re-deriving the first two from the pull every frame was the version before
// this one, and it had the failures a derived quantity always has: a facing
// with a sign rule that flipped end for end as the pull crossed the bar, a
// ring that tilted to lie flat along a bar it should have jammed on, and no
// answer at all when the chain was slack. A state cannot flip between frames,
// and the ring falls because it has a speed to fall with.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { dmath } from "../engine/dmath";
import { bumpTransformEpoch, type CollisionObject2D } from "../engine/body";
import { bodyContainsPoint, circleOverlap, sweepCircle } from "../engine/collision";
import type { RailCurve, ShapeTransform } from "../engine/shapes";
import { buildPolylineIndex, pointAtArcLength, projectOntoPolyline, tangentAtArcLength } from "./path";
import { RopeAttachment, RopeContact } from "./ropeContact";
import { Intersections } from "./intersections";
import { IntersectionStatus } from "./types";
import { MANACLE_BORE, MANACLE_DISC, MANACLE_RADIUS } from "./manacle";

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

// How many times one `slide` call re-reads the bar under the cuff. On a
// straight rail the second look finds the ring at the cone's edge and stops; on
// a CURVED one the tangent has turned under it, so the step is re-solved
// against the direction the bar now runs - which is what keeps the friction
// cone a statement about the bar rather than about where the ring set off from.
const SLIDE_STEPS = 4;

// The rail curve of a stroked shape: the centreline in the BODY's local frame,
// the bar's half-width and which piece covers each segment. One object shared
// by every piece the stroke produced (see `CollisionShape2D.rail`).
//
// `verts` are already body-local, which is where every `RopeContact` position
// lives, so a clamp on a hanging lantern's handle is welded to the lantern
// however the piece it stands on is mounted.
export function buildRailCurve(
  verts: readonly Vec2[],
  halfWidth: number,
  pieceAt: readonly number[],
): RailCurve {
  return { ...buildPolylineIndex(verts), halfWidth, pieceAt };
}

// The span of the curve the cuff may occupy, metres of arc length from its
// start.
export interface ClampRange {
  readonly min: number;
  readonly max: number;
  // Whether each end of the range is an OPEN end of the bar - one the ring
  // runs off rather than stops at (see `railEndIsOpen`).
  readonly openMin: boolean;
  readonly openMax: boolean;
}

// A clamp's slide state, as a value (see `RopeClamp.snapshot`).
export interface ClampState {
  readonly s: number;
  readonly range: ClampRange;
  readonly sliding: boolean;
  readonly pressing: -1 | 0 | 1;
}

// The cuff's centre never leaves the bar, so it stops a half-width in from each
// end - the same distance the ring's own disc would hang off it. A bar shorter
// than it is thick has no room for that and is a PEG: the range collapses to
// its middle, and the ring hangs there and pivots without sliding.
function endInset(curve: RailCurve): { lo: number; hi: number } {
  const lo = curve.halfWidth;
  const hi = curve.total - curve.halfWidth;
  return hi > lo ? { lo, hi } : { lo: curve.total * 0.5, hi: curve.total * 0.5 };
}

// The ring's inner radius: how far the cuff's centre stands from the point of
// the bar its inside is resting on, and so the arm it swings on.
const BORE_RADIUS = MANACLE_BORE * 0.5;

// How fast the ring may TILT on the point it rests on, rad/s. A real ring is
// massless to the pull and would follow it instantly; the bound is there so
// the tilt can never jump between two frames - a jump is what the eye reads
// as the cuff flipping - and it is well above the rate any swing of the chain
// turns the pull at, so in play the ring follows the chain exactly and the
// bound only ever shows on a throw or a catch. A guess to be PLAYED.
export const RAIL_TILT_RATE = 12;

// The pull under which the ring is left hanging where it is rather than
// re-seated: a span this short has no direction worth reading.
const SEAT_EPSILON = 1e-9;

// The curve's left unit normal for the tangent `t`.
function leftNormal(t: Vec2): Vec2 {
  return new Vec2(-t.y, t.x);
}

// Is the bar's end at arc length `s` (0 or the curve's length) an OPEN one -
// an end a ring threaded on the bar can run off - or does the bar run into
// something there?
//
// A lantern's bail is welded to the lantern at both ends: the authored curve
// stops where the metal enters the lid, so its end point is INSIDE another
// piece, and a ring reaching it has nowhere to go. A zipline strung between
// two posts ends inside each post. A bar that ends in the air drops the ring.
//
// Asked of every body in the world other than the bar's own pieces and the
// ones the owner says to ignore (the avatar, and the hook that is about to be
// removed), and of the end point itself: what decides is whether the BAR ends
// in something solid, not whether the ring happens to be touching some of it.
export function railEndIsOpen(
  curve: RailCurve,
  obj: CollisionObject2D,
  s: number,
  ignore: readonly CollisionObject2D[] = [],
): boolean {
  const end = pointAtArcLength(curve, s <= curve.total * 0.5 ? 0 : curve.total);
  const world = end.rotated(obj.globalRotation).add(obj.globalPosition);
  for (const piece of obj.getShapes()) {
    if (piece.rail === curve) continue;
    if (Intersections.intersectsPoint(piece, world) !== IntersectionStatus.Separate) return false;
  }
  const bodies = obj.world?.bodies ?? [];
  for (const other of bodies) {
    if (other === obj || other.removed || ignore.includes(other)) continue;
    if (bodyContainsPoint(other, world)) return false;
  }
  return true;
}

// What one frame of the ring's own motion along the bar came to (see
// `RopeClamp.coast`): whether it stood somewhere new afterwards, whether the
// chain had been pulling on it, and which end of the bar it ran off, if any.
export interface CoastResult {
  readonly moved: boolean;
  readonly loaded: boolean;
  readonly ranOff: -1 | 0 | 1;
}

// The chain's end clamped around a rail: an attachment whose contact can move.
//
// `s` is metres of arc length along the bar's curve to the point the ring's
// inside is RESTING on; `side` says which of the bar's two surfaces that point
// is on; `tilt` how far the ring has swung on it; `speed` how fast the ring is
// running along the bar of its own accord; `range` where on the curve the
// cuff may stand; `sliding` the friction state - stuck ends are held by the
// static cone, running ones by the kinetic one, which is the same hysteresis
// the hook's own contact friction has.
export class RopeClamp extends RopeAttachment {
  s: number;
  range: ClampRange;
  sliding = false;
  // Which surface of the bar the ring rests on: the rest normal is `side`
  // times the curve's left normal, pointing from the centreline to that
  // surface. Decided once, when the hook threads on - the surface away from
  // the side the hook arrived from, which is the ball's side - and never
  // changed: the ring does NOT swap sides of the bar, however the pull turns
  // (a design decision; it is a ring in this view, not a bead free to roll
  // round its wire). A pull from the far side of the bar leans it as far as
  // it can go toward the pull's run along the bar, and the chain bends.
  side: 1 | -1 = 1;
  // How far the ring has swung on the point it rests on, radians, positive
  // toward the curve's far end. Zero is the ring hanging square to the bar.
  tilt = 0;
  // The ring's own speed along the bar, m/s, positive toward the curve's far
  // end: what it is doing when nothing is pulling it (see `coast`), and what
  // it was last observed doing when something was.
  speed = 0;
  // Which END of the ring the chain leaves over, as a sign on the hang: a ring
  // seen edge-on has metal at the two ends of its long axis and hole everywhere
  // between, so the chain is hooked over whichever end runs toward the pull.
  // Decided by the sim's own pull, so the drawn chain and the drape hang from
  // the same point every frame rather than from whichever end the drape's own
  // last link happened to lean toward.
  private rimSign: 1 | -1 = 1;
  // The furthest the ring may tilt before the bar's thickness jams it: a ring
  // of inner radius `R` tilted by `a` presents an aperture of `R·cos a` across
  // the bar, so `cos a_max = h/R`. Zero for a push fit, which never tilts.
  readonly tiltMax: number;
  readonly curve: RailCurve;
  // Whether the length solve has pulled on the ring since it last coasted, and
  // where the ring stood then - the two things an observed speed is made of.
  private loaded = false;
  private sAtCoast: number;
  // Which end of its range the last slide left the ring pressed against, or 0,
  // and how much further the pull wanted to run it: the speed a ring that
  // runs off an open end leaves with is the speed it was being driven at, not
  // the speed the end let it have.
  private pressing: -1 | 0 | 1 = 0;
  private overrun = 0;

  private constructor(contact: RopeContact, curve: RailCurve, s: number, range: ClampRange) {
    super(contact);
    this.curve = curve;
    this.tiltMax = curve.halfWidth >= BORE_RADIUS ? 0 : dmath.acos(curve.halfWidth / BORE_RADIUS);
    this.s = s;
    this.sAtCoast = s;
    this.range = range;
  }

  // Clamp around `curve` at the point of it nearest the world point the hook
  // bit, resting on the surface AWAY from the bite - the hook arrived from the
  // ball's side and the ring hangs toward the ball - and tilted toward
  // `toward` (the ball) from the first frame, so it does not swing into place
  // after it is drawn.
  static at(
    body: CollisionObject2D,
    curve: RailCurve,
    world: Vec2,
    toward: Vec2,
    ignore: readonly CollisionObject2D[] = [],
  ): RopeClamp {
    const local = world.sub(body.globalPosition).rotated(-body.globalRotation);
    const { lo, hi } = endInset(curve);
    const s = Mathf.clamp(projectOntoPolyline(curve, local).s, lo, hi);
    const contact = RopeContact.restore(body, pointAtArcLength(curve, s), pieceAt(curve, s));
    const clamp = new RopeClamp(contact, curve, s, { min: lo, max: hi, openMin: false, openMax: false });
    const bite = local.sub(pointAtArcLength(curve, s)).dot(leftNormal(tangentAtArcLength(curve, s)));
    clamp.side = bite >= 0 ? -1 : 1;
    clamp.setParam(s);
    clamp.seat(toward, Infinity);
    clamp.range = clamp.measureRange(ignore);
    return clamp;
  }

  // The state a slide may change, for the length solve's monotone guard to put
  // back: where along the bar the cuff stands, the range there and the friction
  // state. Which PIECE the contact names follows from `s`, so it is restored by
  // moving the cuff rather than stored beside it. The hang and the speed are
  // not the solve's to move, so they are not its to restore.
  snapshot(): ClampState {
    return { s: this.s, range: this.range, sliding: this.sliding, pressing: this.pressing };
  }

  restoreState(state: ClampState): void {
    this.range = state.range;
    this.sliding = state.sliding;
    this.pressing = state.pressing;
    this.setParam(state.s);
  }

  override genIdentifier(): string {
    return "Clamp on " + this.contact.genIdentifier();
  }

  get body(): CollisionObject2D {
    return this.contact.obj;
  }

  // The rail's direction at the cuff, in the world, along increasing arc
  // length. Null for a bar with no length at all - a peg, which has no
  // direction to slide in.
  tangent(): Vec2 | null {
    if (this.curve.total <= 0) return null;
    return tangentAtArcLength(this.curve, this.s).rotated(this.body.globalRotation);
  }

  // Length of the bar's centreline, metres.
  get length(): number {
    return this.curve.total;
  }

  // Move the cuff to `s` along the curve. The contact is body-local, so this is
  // the one write; the transform epoch is bumped because the rope's memoized
  // span list is keyed on it and no body has moved.
  setParam(s: number): void {
    this.s = s;
    this.contact.position = this.centreLocal(s);
    this.contact.shapeIndex = pieceAt(this.curve, s);
    bumpTransformEpoch();
  }

  // How far along the bar the ring's centre stands from the point it rests
  // on: `R·sin(tilt)`, signed toward the curve's far end. What a tilted ring
  // takes up of the room between the rest point and whatever ends the bar.
  reach(tilt = this.tilt): number {
    return this.tiltMax <= 0 ? 0 : BORE_RADIUS * dmath.sin(tilt);
  }

  // Where the REST point may stand, given the tilt: the range less the reach
  // of a ring leaning toward an end that ends in something - a lid, a post,
  // the lantern's base - so the ring's far side never stands inside it. An
  // OPEN end takes the rest point to the bar's very end and lets the ring lean
  // out over it, since it runs off there anyway.
  private restMin(): number {
    return this.range.openMin ? this.range.min : this.range.min + Math.max(0, -this.reach());
  }

  private restMax(): number {
    return this.range.openMax ? this.range.max : this.range.max - Math.max(0, this.reach());
  }

  // The normal from the centreline to the surface the ring rests on, in the
  // body's frame, at arc length `s`.
  private restNormalLocal(s: number): Vec2 {
    return leftNormal(tangentAtArcLength(this.curve, s)).mul(this.side);
  }

  // The cuff's centre for the ring resting at `s`, in the body's frame: the
  // rest point on the bar's surface, plus the bore's radius along the hang -
  // `R·sin(tilt)` along the bar, and `R·cos(tilt) − h` across it on the side
  // away from the surface the ring rests on.
  //
  // Which leaves the bar's cross-section inside the ring's bore whatever the
  // pull is doing - touching it at the one point the ring rests on - so the
  // ring cannot be drawn cutting the bar. A push fit has no room to hang and
  // sits on the centreline.
  private centreLocal(s: number): Vec2 {
    const p = pointAtArcLength(this.curve, s);
    if (this.curve.total <= 0 || this.tiltMax <= 0) return p;
    const t = tangentAtArcLength(this.curve, s);
    const nRest = leftNormal(t).mul(this.side);
    const across = BORE_RADIUS * dmath.cos(this.tilt) - this.curve.halfWidth;
    return p.add(t.mul(BORE_RADIUS * dmath.sin(this.tilt))).sub(nRest.mul(across));
  }

  // The way the ring HANGS, in the body's frame: a unit vector from the point
  // it rests on to its own centre, which is the ring's long axis in this view.
  hangLocal(): Vec2 {
    const t = tangentAtArcLength(this.curve, this.s);
    const nRest = leftNormal(t).mul(this.side);
    return nRest.mul(-dmath.cos(this.tilt)).add(t.mul(dmath.sin(this.tilt)));
  }

  // The end of the ring the chain leaves over, as a direction from the ring's
  // centre in the body's frame (see `rimSign`), and that point in the world:
  // the ring's mean radius out along it, which is where the drawn chain's last
  // link is hooked and where the slack drape is pinned.
  rimLocal(): Vec2 {
    return this.hangLocal().mul(this.rimSign);
  }

  rimPoint(): Vec2 {
    return this.contact.globalPosition.add(this.rimLocal().rotated(this.body.globalRotation).mul(MANACLE_RADIUS));
  }

  renderRimPoint(alpha: number): Vec2 {
    return this.contact
      .renderGlobalPosition(alpha)
      .add(this.rimLocal().rotated(this.body.renderRotation(alpha)).mul(MANACLE_RADIUS));
  }

  // The point of the bar the ring's inside is resting on, in the world: on the
  // bar's surface, square across from `s`. The cuff's centre is a bore's
  // radius from it along the hang, whatever the pull is doing, and the drawn
  // ring's inner edge lands on it.
  restPoint(): Vec2 {
    const local = pointAtArcLength(this.curve, this.s).add(
      this.restNormalLocal(this.s).mul(Math.min(this.curve.halfWidth, BORE_RADIUS)),
    );
    return this.body.globalPosition.add(local.rotated(this.body.globalRotation));
  }

  // The axis the bar runs through the cuff on, in the BODY's frame - the
  // direction the drawn cuff is turned about: the bar's tangent turned by the
  // tilt, which is square to the way the ring hangs, since a ring hangs in the
  // plane of what is pulling it. Runs with the bar (`·t = cos a ≥ 0`), so the
  // drawn cuff never flips end for end.
  cuffAxisLocal(): Vec2 {
    const t = tangentAtArcLength(this.curve, this.s);
    if (this.tiltMax <= 0) return t;
    return t.mul(dmath.cos(this.tilt)).add(leftNormal(t).mul(this.side * dmath.sin(this.tilt)));
  }

  // Swing the ring on the point it rests on, toward the world point `toward`
  // - in play the node the chain pulls the cuff at, or straight down when
  // nothing is pulling - by no more than `RAIL_TILT_RATE` lets it turn in
  // `dt`. Returns whether the cuff's centre moved, since the rope's cached
  // path length is only stale if it did.
  //
  // The ring is not pinned through the bar, it is RESTING on it: its inside
  // touches the bar at one point and everything else about it swings from that
  // point, exactly as a chain link laid over a rod does. So the pull does not
  // shift the ring sideways, it swings it - the contact stays where it is on
  // the bar and the ring's centre travels the arc of its own bore around it -
  // and the drawn cuff pivots on the bar rather than spinning about itself.
  //
  // What stops the swing is the bar's own thickness: past `tiltMax` the ring
  // has tilted as far as the bar's width lets it and JAMS. The chain may go on
  // past that angle; the ring does not follow it, which is what a ring does.
  //
  // A pull that comes from the far side of the bar - the ball flung above a
  // bar the ring is hanging under - is not answered by the ring changing
  // sides (see `side`): it leans as far as the jam lets it toward the pull's
  // run along the bar, and where the pull runs squarely through the bar it
  // stays as it is.
  seat(toward: Vec2, dt: number): boolean {
    if (this.tiltMax <= 0 || this.curve.total <= 0) return false;
    const pull = toward.sub(this.contact.globalPosition);
    const len = pull.length();
    if (len < SEAT_EPSILON) return false;
    const p = pull.mul(1 / len).rotated(-this.body.globalRotation);
    const t = tangentAtArcLength(this.curve, this.s);
    const nRest = leftNormal(t).mul(this.side);
    const along = p.dot(t);
    const away = -p.dot(nRest);
    // The chain leaves over the end of the ring that runs toward the pull; a
    // pull square to the ring's axis leaves it on the end it was on.
    const lean = this.hangLocal().dot(p);
    if (lean > 1e-9) this.rimSign = 1;
    else if (lean < -1e-9) this.rimSign = -1;
    let target: number;
    if (away >= 0) target = Mathf.clamp(dmath.atan2(along, away), -this.tiltMax, this.tiltMax);
    else if (along !== 0) target = along > 0 ? this.tiltMax : -this.tiltMax;
    else target = this.tilt;
    // A ring pressed against the lid cannot lean INTO it: the lean would stand
    // its far side inside the lid. Its tilt toward an end that ends in
    // something is bounded by the room the rest point has left there.
    if (target > 0 && !this.range.openMax) {
      target = Math.min(target, dmath.asin(Mathf.clamp((this.range.max - this.s) / BORE_RADIUS, 0, 1)));
    } else if (target < 0 && !this.range.openMin) {
      target = Math.max(target, -dmath.asin(Mathf.clamp((this.s - this.range.min) / BORE_RADIUS, 0, 1)));
    }
    const step = RAIL_TILT_RATE * dt;
    const next = this.tilt + Mathf.clamp(target - this.tilt, -step, step);
    if (next === this.tilt) return false;
    this.tilt = next;
    this.setParam(this.s);
    return true;
  }

  // One frame of the ring's OWN motion along the bar, run once a frame before
  // the length solve looks at it.
  //
  // While the chain is pulling on the ring the length solve says where it
  // stands (see `slide`), and all this does is observe the speed that came to,
  // so the ring is not stopped dead the moment the chain goes slack: a ring on
  // a zipline keeps coasting. While nothing is pulling, the ring is a bead on
  // a wire under its own weight - which cancels, so what it accelerates at is
  // gravity's component along the bar, held by Coulomb friction on gravity's
  // component across it, exactly as the loaded ring is held by the cone. That
  // is what makes a ring threaded onto a vertical bar fall at `g` from the
  // frame it is threaded, and a ring on a horizontal bar lie where it was put.
  //
  // A ring reaching an end of its range stops there - unless the end is OPEN
  // (the bar ends in the air rather than in a lid or a post), in which case it
  // runs off, which the result reports for the owner to turn the ring back
  // into a dangling chain tip. An end the length solve has left it pressed
  // against counts the same as one it ran into by itself.
  coast(dt: number, mus: number, muk: number, gravity: Vec2): CoastResult {
    if (this.loaded) {
      const pressed = this.pressing;
      const ranOff = pressed !== 0 && this.openEnd(pressed) ? pressed : 0;
      this.speed = (this.s - this.sAtCoast + (ranOff ? ranOff * this.overrun : 0)) / dt;
      this.loaded = false;
      this.sAtCoast = this.s;
      this.pressing = 0;
      this.overrun = 0;
      return { moved: false, loaded: true, ranOff };
    }
    this.pressing = 0;
    this.overrun = 0;
    if (this.curve.total <= 0 || this.range.max <= this.range.min) {
      this.speed = 0;
      return { moved: false, loaded: false, ranOff: 0 };
    }
    const t = tangentAtArcLength(this.curve, this.s);
    const g = gravity.rotated(-this.body.globalRotation);
    const along = g.dot(t);
    const across = Math.abs(g.cross(t));
    if (this.speed === 0 && Math.abs(along) <= mus * across) {
      this.sAtCoast = this.s;
      return { moved: false, loaded: false, ranOff: 0 };
    }
    let v = this.speed + along * dt;
    const brake = muk * across * dt;
    v = v > 0 ? Math.max(0, v - brake) : Math.min(0, v + brake);
    v = Mathf.clamp(v, -RAIL_MAX_SLIDE_SPEED, RAIL_MAX_SLIDE_SPEED);
    let s = this.s + v * dt;
    let ranOff: -1 | 0 | 1 = 0;
    const hi = this.restMax();
    const lo = this.restMin();
    if (s >= hi) {
      s = hi;
      if (v > 0 && this.openEnd(1)) ranOff = 1;
      v = 0;
    } else if (s <= lo) {
      s = lo;
      if (v < 0 && this.openEnd(-1)) ranOff = -1;
      v = 0;
    }
    this.speed = v;
    const moved = s !== this.s;
    if (moved) this.setParam(s);
    this.sAtCoast = s;
    return { moved, loaded: false, ranOff };
  }

  // Where a ring that has run off the end of the bar in `sign`'s direction is
  // loose, in the world: the manacle's disc just clear of the bar's end face,
  // on the line the bar ran along, so the tip the owner spawns there is not
  // spawned inside the bar it has just left.
  runOffPoint(sign: -1 | 1): Vec2 {
    const end = sign > 0 ? this.curve.total : 0;
    const t = tangentAtArcLength(this.curve, end);
    const local = pointAtArcLength(this.curve, end).add(t.mul(sign * (MANACLE_DISC + 1e-3)));
    return this.body.globalPosition.add(local.rotated(this.body.globalRotation));
  }

  // Has the length solve moved this ring since it last coasted? Told by the
  // solve, once per look (see `Rope.slideClampedEnd`).
  noteLoaded(): void {
    this.loaded = true;
  }

  // Is the end of the range in `sign`'s direction an open end of the bar?
  private openEnd(sign: -1 | 1): boolean {
    return sign > 0 ? this.range.openMax : this.range.openMin;
  }

  // Slide the cuff under the chain's pull. `prev` is the node the last span runs
  // to (world), `budget` the metres the cuff may still travel this frame (the
  // speed cap's remainder), `mus`/`muk` the rail's static and kinetic
  // coefficients, and `settle` says this is the frame's FIRST look at the
  // clamp. Returns the metres travelled along the rail (signed toward the
  // curve's far end).
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
    for (let step = 0; step < SLIDE_STEPS && remaining > 0; step++) {
      const t = this.tangent();
      if (t === null) {
        if (settle && step === 0) this.sliding = false;
        return travelled;
      }
      const p = prev.sub(this.contact.globalPosition);
      const ds = slideStep(p, t, this.sliding, mus, muk);
      if (ds === 0) {
        // The cone holds the ring where it stands. Whether that is the ring
        // coming to rest is the frame's first look to decide; a later step of
        // the same call has already moved it and is simply done.
        if (settle && step === 0) this.sliding = false;
        return travelled;
      }
      // The pull is outside the cone: the ring is running.
      this.sliding = true;
      // Toward the curve's far end for a positive step, and no further than the
      // range or the frame's budget allow.
      const sign = ds > 0 ? 1 : -1;
      const toEdge = Math.abs(ds);
      const wanted = Math.min(toEdge, remaining);
      const room = sign > 0 ? this.restMax() - this.s : this.s - this.restMin();
      const moved = Math.min(wanted, Math.max(0, room));
      // Stopped by the range (the lantern's lid, or the bar's own end): the
      // ring presses against it, still running in the sense that the pull is
      // still outside the cone - and off an open end, if that is what it is
      // pressed against (see `coast`).
      if (moved < wanted) {
        this.pressing = sign;
        this.overrun += wanted - moved;
      }
      if (moved <= 0) return travelled;
      this.setParam(this.s + sign * moved);
      travelled += sign * moved;
      remaining -= moved;
      if (moved < wanted) return travelled;
      // Cut short by the frame's budget rather than by the bar: next frame
      // decides whether the ball is still driving it.
      if (remaining <= 0) return travelled;
      // Reached the cone's edge for the direction the bar ran where the ring
      // set off. On a straight bar the next look confirms it and stops; on a
      // bend it carries on against the direction the bar runs HERE.
    }
    return travelled;
  }

  // Where along the curve the cuff may stand: the whole bar, less a half-width
  // at each end that is NOT open (the cuff's centre never leaves a bar that
  // ends in something), then clipped by sweeping the manacle's disc from the
  // cuff toward each end against every piece of the body that is not part of
  // THIS bar. The cuff stops where the disc meets the lantern's lid, which is
  // what a ring on a handle does. An open end is where the ring runs off.
  //
  // Only pieces of the SAME body clip the range, because only they are welded
  // to the rail: the answer is a constant of the body. Other bodies do not -
  // the hook body that would have collided with them is gone once it clamps,
  // exactly as when it bites - so a rail run through another body's wall is a
  // level-design mistake rather than a collision. Whether an END is open is
  // asked of every body, though: a zipline strung between two posts ends in
  // the posts, whatever bodies they are.
  private measureRange(ignore: readonly CollisionObject2D[]): ClampRange {
    const { lo, hi } = endInset(this.curve);
    // A peg's range is its middle whatever its ends are; its ends are still
    // asked, because a ring on a peg in the air may lean out over them and a
    // ring against a closed end may not (see `restMax`).
    const peg = hi <= lo;
    const openMin = railEndIsOpen(this.curve, this.body, 0, ignore);
    const openMax = railEndIsOpen(this.curve, this.body, this.curve.total, ignore);
    const minEnd = openMin && !peg ? 0 : lo;
    const maxEnd = openMax && !peg ? this.curve.total : hi;
    const here = this.contact.globalPosition;
    const others = this.body
      .getShapes()
      .filter((s) => s.rail !== this.curve)
      // A disc already inside a piece cannot be swept out of it, and a ring
      // clamped right at a joint with the lid is that case: leave the piece to
      // the pull, which will move the ring away from it.
      .filter((s) => !circleOverlap(here, MANACLE_DISC, s));
    if (!others.length) return { min: minEnd, max: maxEnd, openMin, openMax };
    const min = this.sweepBound(-1, minEnd, others);
    const max = this.sweepBound(1, maxEnd, others);
    return { min: min.s, max: max.s, openMin: openMin && !min.hit, openMax: openMax && !max.hit };
  }

  // How far the cuff's disc travels from where it stands toward `limit` before
  // it meets one of `others`. Walked segment by segment along the curve, since
  // a sweep is a straight line and a bent bar is not.
  private sweepBound(
    sign: 1 | -1,
    limit: number,
    others: readonly ShapeTransform[],
  ): { s: number; hit: boolean } {
    let s = this.s;
    for (let guard = 0; guard < this.curve.verts.length + 2; guard++) {
      if (sign > 0 ? s >= limit : s <= limit) return { s: limit, hit: false };
      const next = sign > 0 ? Math.min(limit, nextVertexS(this.curve, s, 1)) : Math.max(limit, nextVertexS(this.curve, s, -1));
      const from = this.worldAt(s);
      const step = this.worldAt(next).sub(from);
      for (const piece of others) {
        const hit = sweepCircle(from, step, MANACLE_DISC, piece);
        if (hit) return { s: s + (next - s) * hit.t, hit: true };
      }
      s = next;
    }
    return { s: limit, hit: false };
  }

  // The bar's CENTRELINE point `s` metres along it, in the world. What the
  // range is measured along, since where the ring rests on the bar is a matter
  // for the pull and the range is a constant of the body.
  worldAt(s: number): Vec2 {
    return this.body.globalPosition.add(
      pointAtArcLength(this.curve, s).rotated(this.body.globalRotation),
    );
  }
}

// Which piece of the body covers arc length `s`.
function pieceAt(curve: RailCurve, s: number): number {
  const segments = curve.pieceAt.length;
  if (segments === 0) return 0;
  for (let i = 0; i < segments; i++) {
    if (s <= (curve.cum[i + 1] ?? curve.total)) return curve.pieceAt[i]!;
  }
  return curve.pieceAt[segments - 1]!;
}

// The arc length of the first polyline vertex strictly past `s` in `sign`'s
// direction, or the curve's own end.
function nextVertexS(curve: RailCurve, s: number, sign: 1 | -1): number {
  if (sign > 0) {
    for (const c of curve.cum) if (c > s + 1e-9) return c;
    return curve.total;
  }
  for (let i = curve.cum.length - 1; i >= 0; i--) {
    const c = curve.cum[i]!;
    if (c < s - 1e-9) return c;
  }
  return 0;
}

// One slide step on a rail, as pure arithmetic.
//
// `p` is the chain's pull as a vector from the cuff to the node the last span
// runs to, `t` the rail's unit tangent, both in the world. The pull splits into
// `along` (signed, toward the curve's far end) and `across`; the ring is stuck
// while `|along| <= mu·across` - inside the friction cone - and otherwise runs
// toward the ball's plumb until the pull is back on the KINETIC cone's edge,
// which is `|along| − muk·across` metres away. The static coefficient holds a
// stuck ring, the kinetic one a running one.
//
// Returns the signed metres to the kinetic cone's edge (positive toward the far
// end), or 0 for a ring the cone holds - which for a running ring means the pull
// is inside the kinetic cone or exactly on its edge, and whether that is the
// ring coming to rest is the caller's call (see `RopeClamp.slide`).
export function slideStep(p: Vec2, t: Vec2, sliding: boolean, mus: number, muk: number): number {
  const along = p.dot(t);
  const across = Math.abs(p.cross(t));
  const mu = sliding ? muk : mus;
  if (Math.abs(along) <= mu * across) return 0;
  const toEdge = Math.abs(along) - muk * across;
  if (toEdge <= 0) return 0;
  return along > 0 ? toEdge : -toEdge;
}

// A rail curve placed in the world, for drawing: the renderers hand over a
// pose (the game its interpolated render transform, the editor an authored
// item's) and both draw the same line the cuff will ride.
export function railPolyline(curve: RailCurve, pos: Vec2, rot: number): Vec2[] {
  return curve.verts.map((v) => pos.add(v.rotated(rot)));
}
