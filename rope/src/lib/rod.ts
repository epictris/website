// A ROD: a rail that runs THROUGH the gameplay plane rather than along it -
// a ladder's rung seen end-on, a handle on a crate, a peg stood out of a wall.
// The plane cuts it as a circle, and that circle is how it is authored: a
// collision circle with `rail` set (`CollisionObjectData.rail`), no thicker
// than the cuff's bore (`ROD_MAX_RADIUS`).
//
// The manacle closes round it CENTRED on its axis, its bore round the bar and
// its own axis through the plane - so it is the one cuff the camera sees
// face-on (`ManaclePose.faceOn`) - and it TURNS FREELY about it: nothing holds
// a ring threaded on a round bar at any angle, so its hinge, where the chain
// is shackled, goes wherever the chain leads it. It is neither the bite (bolted
// to a face at the angle it arrived at) nor the in-plane rail (a ring resting
// on a bar it can slide along and tilts on): the cuff cannot travel, because
// the bar runs away from it into the screen, and it cannot jam, because a
// round bar presents the same face at every angle.
//
// So the anchor is the rod's own axis, a fixed point on the rod's body, and the
// chain's end node is that point - the cuff's centre - as it is for a ring on
// an in-plane rail ("around a rail the ring's centre stays the node", see
// docs/manacle.md). The cuff is massless and turns on a frictionless bar, so
// with the chain taut its hinge lies on the line from the axis to the chain's
// last node, and the length to the axis is the length to the hinge plus the
// hinge's own radius at every angle: the solve needs nothing but the fixed
// point. The hinge is where the drape is pinned and the drawn chain ends
// (`rimPoint`), and it is a pure function of the sim's own path, so the cuff
// carries no state from frame to frame at all - a ring with nothing to flip,
// latch or hunt between.
//
// Slack, a real ring is led round by the chain's weight hanging off its hinge,
// which is the drape's own direction at the cuff; read from the drape that
// would be a render-side quantity steering the thing the drape is pinned to.
// The hinge points along the chain's path instead (`chainEndFacing`), toward
// the chain's next node a manacle's length back - exactly the pull while the
// chain is taut, and the chord it hangs across while it is not.

import { Vec2 } from "../engine/vec2";
import type { CollisionObject2D } from "../engine/body";
import { RopeAttachment, RopeContact, type RopeNode } from "./ropeContact";
import { RopeClamp } from "./rail";
import { MANACLE_BORE, MANACLE_HINGE, MANACLE_REACH, chainEndFacing } from "./manacle";

// The thickest bar the cuff can close round centred: its own bore. A circle
// with `rail` set any thicker than this is an ordinary face, bitten like any
// other (the build ignores the flag, and the editor shrinks a circle to it
// when the box is ticked).
export const ROD_MAX_RADIUS = MANACLE_BORE / 2;

// Straight down in the y-down world: where the hinge points with no chain to
// read a direction from (a path shorter than a node).
const DOWN = new Vec2(0, 1);

export class RopeRod extends RopeAttachment {
  // The chain this cuff ends, ball-side first and ending on this node, read
  // whenever the hinge is asked for: the hinge is the chain's own direction at
  // the cuff, not state of the cuff's.
  private readonly path: () => readonly RopeNode[];

  private constructor(contact: RopeContact, path: () => readonly RopeNode[]) {
    super(contact);
    this.path = path;
  }

  // Close round the rod that is piece `pieceIndex` of `body`, centred on its
  // axis - the circle's centre, whatever point of its surface the hook struck.
  static at(body: CollisionObject2D, pieceIndex: number, path: () => readonly RopeNode[]): RopeRod {
    const piece = body.getShapes()[pieceIndex] ?? body.primaryShape();
    const centre = piece.globalPosition;
    return new RopeRod(new RopeContact(body, centre.sub(body.globalPosition), pieceIndex), path);
  }

  override genIdentifier(): string {
    return "Rod on " + this.contact.genIdentifier();
  }

  get body(): CollisionObject2D {
    return this.contact.obj;
  }

  // The rod's own radius: the circle the cuff is closed round.
  get radius(): number {
    const shape = this.contact.shape.shape;
    return shape.kind === "circle" ? shape.radius : 0;
  }

  // How far the cuff's metal reaches from the axis, at any angle it turns to:
  // the ring seen face-on is a disc of the manacle's bounding radius.
  static readonly CUFF_RADIUS = MANACLE_REACH;

  // Is `world` inside the cuff's disc? A corner of the rod's own body there is
  // metal the chain is already clear of - the chain leaves the cuff at its
  // hinge - not a corner for it to bend round, exactly as inside a rail ring's
  // disc (`RopeClamp.covers`, and `cuffEnd` for every caller). Centred on the
  // axis, which the cuff never leaves, so no hang of the ring moves the
  // answer.
  covers(world: Vec2): boolean {
    return world.distanceTo(this.contact.globalPosition) < RopeRod.CUFF_RADIUS;
  }

  // Which way the hinge points, in the world: along the chain's path from the
  // axis (see the file note).
  facing(): Vec2 {
    return chainEndFacing(
      this.path().map((n) => n.contact.globalPosition),
      DOWN,
    );
  }

  // The hinge pin, where the drape is pinned and the drawn chain ends.
  rimPoint(): Vec2 {
    return this.contact.globalPosition.add(this.facing().mul(MANACLE_HINGE));
  }

  // The same against the render transforms, read off the interpolated path so
  // the drawn cuff turns with the drawn chain rather than at 60 Hz.
  renderRimDir(alpha: number): Vec2 {
    return chainEndFacing(
      this.path().map((n) => n.contact.renderGlobalPosition(alpha)),
      DOWN,
    );
  }

  renderRimPoint(alpha: number): Vec2 {
    return this.contact.renderGlobalPosition(alpha).add(this.renderRimDir(alpha).mul(MANACLE_HINGE));
  }
}

// The chain's end as a CUFF round something whose disc the chain is already
// clear of - a ring on an in-plane rail or one round a rod - or null. What
// the wrap scan, both self-intersection resolvers and the standing cull ask
// (`Rope`), and the one place the two are named together.
export function cuffEnd(end: RopeNode): RopeClamp | RopeRod | null {
  if (end instanceof RopeClamp || end instanceof RopeRod) return end;
  return null;
}
