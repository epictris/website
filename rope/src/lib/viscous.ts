// A VISCOUS surface - mud, tar, wet clay - and the chain's end embedded in one.
//
// The manacle bites a viscous face as it bites stone - driven in at the angle
// it arrived, with the chain shackled to the hinge pin (see
// `BallPlayer.onHookAttached`) - but it sinks in the WHOLE way: mud does not
// stop a spike at its middle, so the cuff is buried to the hinge and the pin
// sits on the surface, where the chain leaves the mud. What the face does not
// do is hold it still. Mud is a fluid with a very high viscosity,
// and a spike stuck in a fluid moves through it at whatever speed the force on
// it drives, in the direction of that force - so the cuff CREEPS through the
// face along the chain's pull, and how fast is a function of how hard the
// chain is pulling. A ball hanging still draws it slowly toward itself; a
// falling ball caught on it drags it a long way through the mud before it is
// slowed to a hang, and creeps from there; a ball that swings out from a wall
// draws it straight out of the face. Once the MOUTH has crept clear of the
// geometry there is nothing left gripping the cuff, and it drops out as the
// dangling tip it was before it bit (`Rope.onEmbedDrop`). The mouth is not
// the whole test, though: a cuff driven through a slab thinner than itself
// has its mouth out of the far side from the start and is held by the slab it
// passes through, so what is asked is whether ANY of the cuff's buried length
// is in the mud (`RopeEmbed.holding`).
//
// The law is a POWER of the load (`creepSpeed`): a shear-thinning fluid, which
// is what lets both of the things asked of it be true at once. Linear in the
// load, a creep slow enough to hang from for a while makes a hard catch slip
// barely more than the hang does (the ratio of the two is fixed), and one that
// gives way satisfyingly under a fall runs away under a hanging ball. Squared,
// a catch at ten times the hanging load creeps a hundred times as fast, which
// reads as the mud yielding to the shock and then holding.
//
// The cuff is massless and the mud has no elasticity, so the slip is solved
// GEOMETRICALLY inside the chain's length solve rather than integrated
// (`Rope.slipEmbeddedEnd`, the same seat the rail's slide has): at the frame's
// first look the solve knows how far over its length the path is and what the
// chain's effective mass along it is, which together are the force it is about
// to apply - the tension the anchor is under - and the slip is the root of the
// implicit statement that the anchor moves at the creep speed for the tension
// left once it has moved (`slipDistance`). Solved that way a hanging ball's
// steady creep comes out at exactly `VISCOUS_CREEP_SPEED`: the ball descends
// with the cuff, so the frame's error is one frame of creep plus one of
// gravity, and the tension left after the creep is absorbed is the ball's
// weight and nothing else.

import { Vec2 } from "../engine/vec2";
import { dmath } from "../engine/dmath";
import { bumpTransformEpoch, type CollisionObject2D, type CollisionShape2D } from "../engine/body";
import { RopeAttachment, RopeContact } from "./ropeContact";
import { Segment } from "./segment";
import { Intersections } from "./intersections";
import { IntersectionStatus } from "./types";
import { MANACLE_HINGE, MANACLE_REACH } from "./manacle";

// How fast the cuff creeps under `VISCOUS_CREEP_LOAD`, m/s. A guess to be
// played: at 3 cm/s a cuff bitten square into a mud ceiling holds a hanging
// ball for the two seconds it takes the mouth to creep its own depth out of
// the face, and a cuff bitten into a mud wall rides down it at a walking
// crawl.
export const VISCOUS_CREEP_SPEED = 0.03;
// The load the creep speed is quoted at, newtons: about the weight of the
// hanging ball (52 kg at g), so that a plain dead hang IS the quoted creep.
export const VISCOUS_CREEP_LOAD = 500;
// The power of the load the creep grows with. 1 is a Newtonian fluid; above
// it the mud thins under shock (see the note above). A guess to be played.
export const VISCOUS_EXPONENT = 2;
// Halvings of the slip's bracket: forty puts the root within a millionth of
// a nanometre of a metre-sized error, past anything the sim can measure.
const SLIP_BISECTIONS = 40;

// The creep speed under a load, m/s, through mud of `viscosity` - the law
// itself, in one place. The viscosity scales the load the law reads, so the
// reference mud (1) creeps at the quoted speed under the quoted load and mud
// twice as viscous needs twice the pull for the same creep (see
// `CollisionShape2D.viscosity`).
export function creepSpeed(load: number, viscosity = 1): number {
  if (!(load > 0) || !(viscosity > 0)) return 0;
  return VISCOUS_CREEP_SPEED * dmath.pow(load / (viscosity * VISCOUS_CREEP_LOAD), VISCOUS_EXPONENT);
}

// How far the cuff creeps in one frame of `dt`, given that the chain's path is
// `error` metres over its length and the effective mass the solve sees along
// it is `effectiveMass` (the reciprocal of the path's summed inverse inertia,
// which for a ball on a fixed anchor is the ball's own mass).
//
// Holding the chain rigid would take a positional correction of `error` from
// mass `effectiveMass` in one frame - an impulse of `M·e/dt`, a force of
// `M·e/dt²` - and that force is the anchor's tension. Every metre the anchor
// creeps toward the pull is a metre the bodies are not corrected by, so the
// tension left once it has crept `s` is `M·(e−s)/dt²`, and the creep is the
// `s` at which `s = dt·creepSpeed(M·(e−s)/dt²)`. The left side rises with `s`
// and the right side falls, so the root is unique and a bisection of `[0, e]`
// finds it; it cannot exceed `e`, since past that the chain would be slack
// and there would be no tension to drive it at all.
//
// `along` is the cosine between the pull and the line the cuff is free to
// creep on, for a cuff that is LOCKED to a line rather than free in a face -
// a ring on a vine (`lib/vineClamp.ts`). Only the tension's component along
// the line drives the creep (the rest is reacted by the line), and a creep of
// `s` along it relieves only `along·s` of the error, so the root is of
// `s = dt·creepSpeed(along·M·(e − along·s)/dt²)` over `[0, e/along]`. At 1 -
// mud, where the creep runs with the pull - the arithmetic is bit for bit the
// statement above.
export function slipDistance(
  error: number,
  effectiveMass: number,
  dt: number,
  viscosity = 1,
  along = 1,
): number {
  if (!(error > 0) || !(effectiveMass > 0) || !(dt > 0) || !(viscosity > 0) || !(along > 0)) return 0;
  const toLoad = (along * effectiveMass) / (dt * dt);
  let lo = 0;
  let hi = error / along;
  for (let i = 0; i < SLIP_BISECTIONS; i++) {
    const mid = (lo + hi) * 0.5;
    const residual = dt * creepSpeed(toLoad * (error - along * mid), viscosity) - mid;
    if (residual > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

// What the cuff is buried in: a viscous piece it may go on creeping through
// (and how viscous), a solid piece of the same body that holds it fast, or
// nothing at all - in which case nothing is holding the cuff.
export type EmbedHold =
  | { readonly kind: "viscous"; readonly viscosity: number }
  | { readonly kind: "solid" }
  | { readonly kind: "nothing" };

// An embedded end's state as a value, for the length solve's monotone guard to
// put back (see `RopeEmbed.snapshot`).
export interface EmbedState {
  readonly position: Vec2;
  readonly slipped: Vec2;
}

// The chain's end bitten into a viscous face: an attachment whose contact can
// move. The contact is the HINGE PIN, as it is for every bite, and it starts
// ON the surface with the whole cuff buried behind it; the cuff's axis is
// frozen in the body's frame, bolted at the angle it bit with, and the cuff's
// centre and mouth follow from the pin along it.
export class RopeEmbed extends RopeAttachment {
  // The cuff's axis, mouth to hinge, in the anchor body's frame. Frozen: a
  // cuff dragged through mud is dragged as it stands, it does not turn to
  // trail the pull.
  readonly facingLocal: Vec2;
  // The clamped cuff as a solid piece of the body it bit (`BallPlayer.mountCuff`),
  // which creeps with the contact so the ball is stopped by the cuff where the
  // cuff is drawn. Null where none was mounted - a bite where the ball already
  // stood.
  cuff: CollisionShape2D | null = null;
  // Metres crept this frame, in the world: what the cuff leaves with if it
  // drops out, read and cleared at the next frame's first look
  // (`Rope.settleEmbed`).
  slipped: Vec2 = Vec2.ZERO;

  private constructor(contact: RopeContact, facingLocal: Vec2) {
    super(contact);
    this.facingLocal = facingLocal;
  }

  // Embed at the bite point `bite` on `body`'s piece `pieceIndex`, the cuff
  // lying along `facing` (mouth to hinge, world) and sunk in to the hinge: the
  // pin is the bite point itself, on the surface, and the whole cuff is
  // behind it in the mud.
  static at(body: CollisionObject2D, pieceIndex: number, bite: Vec2, facing: Vec2): RopeEmbed {
    const contact = new RopeContact(body, bite.sub(body.globalPosition), pieceIndex);
    return new RopeEmbed(contact, facing.rotated(-body.globalRotation));
  }

  override genIdentifier(): string {
    return "Embedded in " + this.contact.genIdentifier();
  }

  get body(): CollisionObject2D {
    return this.contact.obj;
  }

  // The cuff's axis in the world, mouth to hinge.
  facing(): Vec2 {
    return this.facingLocal.rotated(this.body.globalRotation);
  }

  // The cuff's centre: one hinge offset back from the pin along the axis. The
  // bite point, on the frame it bit.
  centre(): Vec2 {
    return this.contact.globalPosition.sub(this.facing().mul(MANACLE_HINGE));
  }

  // The tip of the mouth: the deepest point of the cuff, and the last part of
  // it to leave the face.
  mouth(): Vec2 {
    return this.centre().sub(this.facing().mul(MANACLE_REACH));
  }

  // What the cuff is buried in, asked of its whole length from the pin to the
  // mouth rather than of the mouth alone: a cuff driven through a slab thinner
  // than itself is held by the slab, mouth out of the far side or not. The
  // cuff's own piece is not geometry the cuff is held by; the pieces of the
  // anchor body are - a solid one it is stuck in, which wins, since a spike
  // with any of its length in rock does not move; else a viscous one it
  // creeps through; and a cuff in neither is gripping nothing.
  holding(): EmbedHold {
    const axis = new Segment(this.contact.globalPosition, this.mouth());
    let viscous: EmbedHold | null = null;
    for (const piece of this.body.getShapes()) {
      if (piece === this.cuff) continue;
      if (Intersections.intersectsSegment(piece, axis) === IntersectionStatus.Separate) continue;
      if (!piece.viscous) return { kind: "solid" };
      viscous ??= { kind: "viscous", viscosity: piece.viscosity };
    }
    return viscous ?? { kind: "nothing" };
  }

  // Creep by `delta` (world metres): the pin, the cuff and the frame's tally
  // together.
  slip(delta: Vec2): void {
    const body = this.body;
    this.contact.position = this.contact.position.add(delta.rotated(-body.globalRotation));
    this.slipped = this.slipped.add(delta);
    this.syncCuff();
  }

  // The state a slip may change, for the length solve's monotone guard: where
  // the pin stands and what the frame has crept so far. The axis is frozen and
  // the cuff follows the pin, so neither is stored.
  snapshot(): EmbedState {
    return { position: this.contact.position, slipped: this.slipped };
  }

  restoreState(state: EmbedState): void {
    this.contact.position = state.position;
    this.slipped = state.slipped;
    this.syncCuff();
  }

  // Put the mounted cuff where the pin says it stands: its centre one hinge
  // offset back along the axis, in the body's frame. Through `moveShape` so
  // every cache keyed on where the body's pieces are is told; with no cuff
  // mounted the moved contact still bumps the epoch the span list is keyed
  // on, exactly as a rail clamp's does.
  private syncCuff(): void {
    if (this.cuff) {
      this.body.moveShape(this.cuff, this.contact.position.sub(this.facingLocal.mul(MANACLE_HINGE)));
    } else {
      bumpTransformEpoch();
    }
  }
}
