// The manacle around a VINE: a ring threaded onto the cord, as it is threaded
// onto a rail, that slides along it as it slides through mud.
//
// A vine is a chain of pass-through links (`level/vines.ts`), and the cuff
// used to bite one of them as it bites a rock - a spike driven into a 15 cm
// ball of cord that then held for ever. A ring on a rope does neither. It is
// CONSTRAINED to the rope (a design decision, 2026-09-10): its centre lies on
// the vine's own line, the cord passes through its bore, and it leaves the
// vine only when the player lets go of the chain or it slides off the free
// bottom end - it cannot be pulled off sideways however the ball swings, and a
// span, having no free end, never lets it off at all. And it SLIDES along the
// rope with the physics a cuff in mud has (`lib/viscous.ts`): a creep whose
// speed is a power of the load, in the direction of the pull, rather than a
// rail's Coulomb cone. A ball hanging still under a grabbed vine draws the
// ring slowly down it; a falling ball caught on one drags it a long way
// before it is slowed to a hang; a ball swinging out sideways loads the
// ring's line hardly at all, so it barely moves.
//
// The two halves of that are the two halves of the design:
//
//   - LOCKED to the line. Only the component of the chain's pull ALONG the
//     vine drives the creep, and a creep along it relieves only that
//     component's share of the error (`slipDistance`'s `along`); the rest of
//     the tension is reacted by the vine, which the length solve answers by
//     moving the link the ring stands on - the vine swings toward the ball,
//     as a rope does. The creep is therefore a walk along the polyline
//     through the links (`creep`), never a step off it.
//
//   - The viscous LAW. The creep budget is decided at the solve's first look
//     from the tension it is about to apply (`Rope.slipVineClampedEnd`, the
//     mud's own seat), with one difference the vine forces: the link the ring
//     stands on is a body the length solve may move, but it is held ON the
//     vine by the load rope and the pair chains, which that solve cannot see.
//     So the tension the ring reads is what the bodies the vine does NOT hold
//     put on the chain - the ball - which for a ball hanging under a held
//     vine is the whole of it, exactly as it is for a ball under a fixed
//     anchor. Read with the link in the sum, a 3.75 kg link against a 52 kg
//     ball put the tension at a fourteenth of the truth and the squared law
//     made two hundredths of the creep.
//
// Where the ring stands is a SEGMENT of the vine's polyline (anchor, the link
// centres, the second anchor if there is one) and a FRACTION along it, rather
// than an arc length: a vine's joints run loose (`VINE_TOLERANCE`) and the
// arc breathes with them, while a fraction of a segment stays put. The chain's
// end contact is on the LINK at the lower end of that segment, offset to the
// ring's centre, so the load rope (`updateVineLoads`) finds the link the ring
// hangs from as it found the link a bite was on, and is rebuilt - born at the
// measured arc, as always - when the ring crosses into the next segment. The
// offset gives the pull a lever on the link, and the link's spin means
// nothing (its constraints all act at its centre), so the length solve is
// told the link has no rotational freedom (`Rope.getDynamicBodyState`) and
// the ring's pull moves it by translation alone: the light body in series
// that `session-225f` warns of is answered here by taking its one meaningless
// degree of freedom away.
//
// The ring is a PUSH FIT on the cord - its centre on the vine's own line,
// square to it - rather than the tilting, resting ring a rail carries: the
// cord is thinner than the bore by a few millimetres, and the hang that
// buys is not worth a second copy of the rail's seat. What is kept is the end
// of the ring the chain leaves over (`rimSign`, with the rail's own
// hysteresis), since the drawn chain and the slack drape hang from it.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { bumpTransformEpoch, type VineLink } from "../engine/body";
import { RopeAttachment, RopeContact, type RopeNode } from "./ropeContact";
import { RopeClamp, RIM_FLIP_LEAN } from "./rail";
import { MANACLE_RADIUS, MANACLE_REACH } from "./manacle";

// What the clamp needs of a vine: the line it runs along - the anchor, the
// link centres in order, the second anchor of a span - and how viscous the
// cord is to a ring sliding down it. `Vine` (`level/vines.ts`) is one.
export interface VineLine {
  readonly anchorContact: RopeContact;
  readonly links: readonly VineLink[];
  readonly anchor2Contact: RopeContact | null;
  // The viscosity the creep law reads (see `creepSpeed`): 1 is the reference
  // mud, 0 a ring that never slides.
  readonly viscosity: number;
}

// The state a creep may change, for the length solve's monotone guard to put
// back (see `RopeVineClamp.snapshot`).
export interface VineClampState {
  readonly segment: number;
  readonly fraction: number;
  readonly slipped: Vec2;
  readonly overrun: number;
  readonly ranOff: boolean;
}

// A closed end of the vine - the anchor, or a span's second anchor - stops
// the ring's centre this far short of it, so the ring's rim reaches the bolt
// and the ring itself is not drawn half inside the body the vine hangs from.
const END_INSET = MANACLE_REACH;

// A segment shorter than this has no direction to creep along: the ring
// steps over it.
const DEGENERATE = 1e-9;

function leftNormal(t: Vec2): Vec2 {
  return new Vec2(-t.y, t.x);
}

// The chain's end as a ring threaded onto something - a rail or a vine - with
// a rim the chain leaves over, for the drape and the renderers; or null for a
// bite, a mud embed, a dangling tip or a hook in flight.
export function ringEnd(end: RopeNode): RopeClamp | RopeVineClamp | null {
  if (end instanceof RopeClamp || end instanceof RopeVineClamp) return end;
  return null;
}

// The chain's end clamped around a vine: an attachment whose contact can move
// along the vine's line, and only along it.
export class RopeVineClamp extends RopeAttachment {
  readonly vine: VineLine;
  // Which segment of the line the ring stands on, 1-based: segment `k` runs
  // from point `k-1` to point `k`, the points being the anchor, then the link
  // centres, then the second anchor if there is one.
  segment: number;
  // How far along that segment, 0..1.
  fraction: number;
  // Metres crept this frame, in the world: what the ring leaves with if it
  // slides off, read and cleared at the next frame's first look
  // (`Rope.settleVineClamp`).
  slipped: Vec2 = Vec2.ZERO;
  // Whether a creep this frame pressed the ring past the free bottom end, and
  // the furthest any one asked to run it past: a ring that slides off leaves
  // at the speed it was being driven at, not the speed the end let it have.
  // The LARGEST refusal and not their sum, because every iteration of the
  // length solve asks for the same frame's budget again and is refused it
  // again.
  private ranOff = false;
  private overrun = 0;
  // Which END of the ring the chain leaves over, as a sign on the line's left
  // normal (see `RopeClamp.rimSign`, whose hysteresis this shares).
  private rimSign: 1 | -1 = 1;

  private constructor(vine: VineLine, contact: RopeContact, segment: number, fraction: number) {
    super(contact);
    this.vine = vine;
    this.segment = segment;
    this.fraction = fraction;
  }

  // Clamp around `vine` at the point of its line nearest the world point the
  // hook struck, with the chain leaving over the end of the ring that faces
  // `toward` (the ball).
  static at(vine: VineLine, world: Vec2, toward: Vec2): RopeVineClamp {
    const pts = linePoints(vine);
    let best = { segment: 1, fraction: 0, dist: Infinity };
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1]!;
      const d = pts[k]!.sub(a);
      const len2 = d.lengthSquared();
      const f = len2 > 0 ? Mathf.clamp(world.sub(a).dot(d) / len2, 0, 1) : 0;
      const dist = a.add(d.mul(f)).distanceTo(world);
      if (dist < best.dist) best = { segment: k, fraction: f, dist };
    }
    const body = vine.links[bodyIndex(vine, best.segment)]!;
    const clamp = new RopeVineClamp(vine, RopeContact.restore(body, Vec2.ZERO, 0), best.segment, best.fraction);
    clamp.sync();
    // A strike on the last link's grab circle from BELOW projects onto the
    // very end of the cord, and a ring threaded onto the very end of a rope
    // is off it on the next pull. The ring is as big as it is: it threads on
    // no nearer a free end than its own reach, so a throw straight up a vine
    // from under it catches the tip of the cord and slides off it, rather
    // than catching nothing.
    if (clamp.bottomOpen && best.segment === pts.length - 1) {
      const len = pts[best.segment]!.sub(pts[best.segment - 1]!).length();
      if (len > DEGENERATE) {
        const room = Math.max(0, len - END_INSET) / len;
        if (clamp.fraction > room) {
          clamp.fraction = room;
          clamp.sync();
        }
      }
    }
    const t = clamp.tangent();
    if (t !== null) {
      const lean = leftNormal(t).dot(toward.sub(clamp.contact.globalPosition));
      clamp.rimSign = lean >= 0 ? 1 : -1;
    }
    return clamp;
  }

  override genIdentifier(): string {
    return "Ring on " + this.contact.genIdentifier();
  }

  // The link the ring stands on: the one at the lower end of its segment.
  get link(): VineLink {
    return this.vine.links[bodyIndex(this.vine, this.segment)]!;
  }

  // Is the end of the line past the last link a free end the ring can slide
  // off? A hanging vine's is; a span ends in its second anchor.
  get bottomOpen(): boolean {
    return this.vine.anchor2Contact === null;
  }

  // Put the contact where the segment and fraction say the ring's centre is,
  // on the current line: the link at the segment's lower end, offset to that
  // point in the link's own frame. Once a frame before the path is read
  // (`Rope.settleVineClamp`), so a ring rides the vine as it swings rather
  // than staying where its link's frame was, and after every creep. Returns
  // whether the centre moved in the world. Through the transform epoch, since
  // the rope's memoized span list is keyed on it and no body has moved.
  sync(): boolean {
    const before = this.contact.globalPosition;
    const pts = linePoints(this.vine);
    const a = pts[this.segment - 1]!;
    const b = pts[this.segment]!;
    const centre = a.lerp(b, this.fraction);
    const body = this.link;
    this.contact.obj = body;
    this.contact.position = centre.sub(body.globalPosition).rotated(-body.globalRotation);
    this.contact.shapeIndex = 0;
    bumpTransformEpoch();
    const after = this.contact.globalPosition;
    return after.x !== before.x || after.y !== before.y;
  }

  // The line's direction at the ring, in the world, toward the bottom (the
  // free end of a hanging vine, the second anchor of a span). Null for a
  // segment with no length.
  tangent(): Vec2 | null {
    const pts = linePoints(this.vine);
    const d = pts[this.segment]!.sub(pts[this.segment - 1]!);
    const len = d.length();
    return len > DEGENERATE ? d.mul(1 / len) : null;
  }

  // Creep `distance` metres along the line - positive toward the bottom -
  // crossing from segment to segment as it goes. The top end is closed (the
  // vine is bolted there) and so is a span's far end; the ring stops
  // `END_INSET` short of either. A hanging vine's bottom is OPEN: a ring
  // driven past the last link's centre has slid off, which is recorded for
  // the frame's first look to act on (`takeRunOff`), the ring itself left
  // sitting at the end. Returns the signed metres actually travelled.
  creep(distance: number): number {
    const pts = linePoints(this.vine);
    const last = pts.length - 1;
    let remaining = distance;
    let moved = 0;
    for (let guard = 0; guard < pts.length + 2 && remaining !== 0; guard++) {
      const a = pts[this.segment - 1]!;
      const len = pts[this.segment]!.sub(a).length();
      const at = this.fraction * len;
      if (remaining > 0) {
        const room = len - at;
        // The last segment of a span ends in the second anchor: closed, and
        // inset like the top.
        const limit = this.segment === last && !this.bottomOpen ? Math.max(0, room - END_INSET) : room;
        if (remaining < limit) {
          this.fraction = (at + remaining) / len;
          moved += remaining;
          remaining = 0;
        } else if (this.segment < last) {
          moved += room;
          remaining -= room;
          this.segment++;
          this.fraction = 0;
        } else {
          moved += limit;
          remaining -= limit;
          this.fraction = len > DEGENERATE ? (at + limit) / len : 1;
          if (this.bottomOpen) {
            this.ranOff = true;
            this.overrun = Math.max(this.overrun, remaining);
          }
          remaining = 0;
        }
      } else {
        const back = -remaining;
        const limit = this.segment === 1 ? Math.max(0, at - END_INSET) : at;
        if (back < limit) {
          this.fraction = (at - back) / len;
          moved -= back;
          remaining = 0;
        } else if (this.segment > 1) {
          moved -= at;
          remaining += at;
          this.segment--;
          this.fraction = 1;
        } else {
          moved -= limit;
          this.fraction = len > DEGENERATE ? (at - limit) / len : 0;
          remaining = 0;
        }
      }
    }
    if (moved !== 0) this.sync();
    return moved;
  }

  // Has the ring been driven off the free end since the last look, and how
  // far past it the pull wanted to run it? Read and cleared once a frame.
  takeRunOff(): { ranOff: boolean; overrun: number } {
    const result = { ranOff: this.ranOff, overrun: this.overrun };
    this.ranOff = false;
    this.overrun = 0;
    return result;
  }

  // The state a creep may change, for the length solve's monotone guard.
  snapshot(): VineClampState {
    return {
      segment: this.segment,
      fraction: this.fraction,
      slipped: this.slipped,
      overrun: this.overrun,
      ranOff: this.ranOff,
    };
  }

  restoreState(state: VineClampState): void {
    this.segment = state.segment;
    this.fraction = state.fraction;
    this.slipped = state.slipped;
    this.overrun = state.overrun;
    this.ranOff = state.ranOff;
    this.sync();
  }

  // Decide which end of the ring the chain leaves over, from the world point
  // the chain pulls the ring toward - or the caller's stand-in for a slack
  // chain, which moves it nowhere (see `RopeClamp.seat`).
  seat(toward: Vec2, pulling: boolean): void {
    if (!pulling) return;
    const t = this.tangent();
    if (t === null) return;
    const pull = toward.sub(this.contact.globalPosition);
    const len = pull.length();
    if (len <= 0) return;
    const lean = leftNormal(t).dot(pull.mul(1 / len)) * this.rimSign;
    if (lean < -RIM_FLIP_LEAN) this.rimSign = -this.rimSign as 1 | -1;
  }

  // The end of the ring the chain leaves over, as a direction from its centre
  // in the world: square to the cord, on the side the pull runs. The ring's
  // long axis in the edge-on view, and so the way the drawn cuff faces.
  rimDir(): Vec2 {
    const t = this.tangent() ?? Vec2.RIGHT;
    return leftNormal(t).mul(this.rimSign);
  }

  renderRimDir(alpha: number): Vec2 {
    const pts = linePoints(this.vine, alpha);
    const d = pts[this.segment]!.sub(pts[this.segment - 1]!);
    const len = d.length();
    const t = len > DEGENERATE ? d.mul(1 / len) : Vec2.RIGHT;
    return leftNormal(t).mul(this.rimSign);
  }

  // That end in the world, the ring's mean radius out along it: where the
  // drawn chain's last link is hooked and where the slack drape is pinned.
  rimPoint(): Vec2 {
    return this.contact.globalPosition.add(this.rimDir().mul(MANACLE_RADIUS));
  }

  renderRimPoint(alpha: number): Vec2 {
    return this.contact.renderGlobalPosition(alpha).add(this.renderRimDir(alpha).mul(MANACLE_RADIUS));
  }
}

// The index into `vine.links` of the body a ring on segment `k` stands on:
// the link at the segment's lower end, or the last link for a span's final
// segment, which ends in the second anchor.
function bodyIndex(vine: VineLine, segment: number): number {
  return Math.min(segment - 1, vine.links.length - 1);
}

// The vine's line, top to bottom: the anchor, every link's centre, and the
// second anchor of a span - against the sim transforms, or the render ones
// for an `alpha`.
function linePoints(vine: VineLine, alpha?: number): Vec2[] {
  const pts: Vec2[] = [];
  if (alpha === undefined) {
    pts.push(vine.anchorContact.globalPosition);
    for (const link of vine.links) pts.push(link.globalPosition);
    if (vine.anchor2Contact) pts.push(vine.anchor2Contact.globalPosition);
  } else {
    pts.push(vine.anchorContact.renderGlobalPosition(alpha));
    for (const link of vine.links) pts.push(link.renderPosition(alpha));
    if (vine.anchor2Contact) pts.push(vine.anchor2Contact.renderGlobalPosition(alpha));
  }
  return pts;
}
