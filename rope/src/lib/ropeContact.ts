// RopeContact + rope-path node types, ported from classes/RopeContact.cs.

import { Vec2 } from "../engine/vec2";
import { nearestShapeIndex } from "../engine/shapes";
import type { CollisionObject2D, CollisionShape2D } from "../engine/body";
import { WrapDirection } from "./types";

export class RopeContact {
  obj: CollisionObject2D;
  // Stored in the BODY's local frame (pre-rotated), so GlobalPosition re-applies
  // rotation. Deliberately the body's frame and not the shape's: a body may
  // carry several shapes, and one origin for all of them is what keeps a wrap
  // node welded to the body it rides on however the body is put together.
  position: Vec2;
  // Which of the body's shapes this contact sits on. 0 — the primary — for
  // every single-shape body, which is nearly all of them; a compound body's
  // wraps need it so the tangent walk uses the right vertex loop rather than
  // whichever shape happens to be first.
  shapeIndex: number;

  constructor(obj: CollisionObject2D, position: Vec2, shapeIndex = 0) {
    this.obj = obj;
    this.position = position.rotated(-obj.globalRotation);
    this.shapeIndex = shapeIndex;
  }

  // A contact where the rope has just landed on a body, at a world point, with
  // the shape index resolved from that point rather than defaulted to the
  // primary. This is what every *attachment* to scene geometry has to use: a
  // hook anchors on whichever piece of a compound body it hit, and a contact
  // that says shape 0 while resting on shape 1 sends `resolveSelfIntersection*`
  // round the wrong vertex loop - it tests the span against a piece the span
  // never touches, finds no overlap, and the rope runs straight through the
  // piece it is actually anchored to instead of bending around its corner.
  //
  // A single-shape body resolves to 0, so this is exactly the old behaviour
  // everywhere except on a compound body, which is the only place the old
  // behaviour was wrong.
  static at(obj: CollisionObject2D, world: Vec2): RopeContact {
    return new RopeContact(
      obj,
      world.sub(obj.globalPosition),
      nearestShapeIndex(obj.getShapes(), world),
    );
  }

  // Rebuild from already-local data (snapshot restore path — no re-rotation).
  static restore(obj: CollisionObject2D, localPosition: Vec2, shapeIndex = 0): RopeContact {
    const c = Object.create(RopeContact.prototype) as RopeContact;
    c.obj = obj;
    c.position = localPosition;
    c.shapeIndex = shapeIndex;
    return c;
  }

  // The shape this contact is on. Falls back to the primary for a body whose
  // shape set has shrunk under it (a removed auxiliary), so a stale index can
  // never throw mid-solve.
  get shape(): CollisionShape2D {
    return this.obj.getShapes()[this.shapeIndex] ?? this.obj.getShape();
  }

  genIdentifier(): string {
    return this.obj.name;
  }

  get globalPosition(): Vec2 {
    return this.obj.globalPosition.add(this.position.rotated(this.obj.globalRotation));
  }

  // `globalPosition` against the body's interpolated render transform. The
  // contact is stored in the body's local frame, so a wrap node follows the
  // body it sits on exactly — the drawn rope stays attached to the drawn body
  // rather than to its 60 Hz sim position.
  renderGlobalPosition(alpha: number): Vec2 {
    return this.obj
      .renderPosition(alpha)
      .add(this.position.rotated(this.obj.renderRotation(alpha)));
  }
}

export abstract class RopeNode {
  contact: RopeContact;
  constructor(contact: RopeContact) {
    this.contact = contact;
  }
  abstract genIdentifier(): string;
}

export class RopeAttachment extends RopeNode {
  genIdentifier(): string {
    return "Attachment to " + this.contact.genIdentifier();
  }
}

export class RopeWrap extends RopeNode {
  wrapDir: WrapDirection;
  constructor(contact: RopeContact, wrapDir: WrapDirection) {
    super(contact);
    this.wrapDir = wrapDir;
  }
  genIdentifier(): string {
    return WrapDirection[this.wrapDir] + " Wrap around " + this.contact.genIdentifier();
  }
}
