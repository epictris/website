// RopeContact + rope-path node types, ported from classes/RopeContact.cs.

import { Vec2 } from "../engine/vec2";
import type { CollisionObject2D } from "../engine/body";
import { WrapDirection } from "./types";

export class RopeContact {
  obj: CollisionObject2D;
  // Stored in the body's local frame (pre-rotated), so GlobalPosition re-applies rotation.
  position: Vec2;

  constructor(obj: CollisionObject2D, position: Vec2) {
    this.obj = obj;
    this.position = position.rotated(-obj.globalRotation);
  }

  // Rebuild from already-local data (snapshot restore path — no re-rotation).
  static restore(obj: CollisionObject2D, localPosition: Vec2): RopeContact {
    const c = Object.create(RopeContact.prototype) as RopeContact;
    c.obj = obj;
    c.position = localPosition;
    return c;
  }

  genIdentifier(): string {
    return this.obj.name;
  }

  get globalPosition(): Vec2 {
    return this.obj.globalPosition.add(this.position.rotated(this.obj.globalRotation));
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
