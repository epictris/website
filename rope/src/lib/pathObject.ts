// PathObject hierarchy, ported from classes/PathObject.cs. Describes the
// physical span/wrap geometry the rope constraint solver acts on.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import type { PhysicsBody2D } from "../engine/body";
import { Segment } from "./segment";
import { WrapDirection } from "./types";

export abstract class PathObject {
  body: PhysicsBody2D;
  constructor(body: PhysicsBody2D) {
    this.body = body;
  }
  abstract calculateMechanicalAdvantage(): number;
  abstract resolveCorrectionDir(): Vec2;
}

export class PathStart extends PathObject {
  next: Segment;
  directionToNext: Vec2;
  selfWrap: PathWrap | null = null;

  constructor(body: PhysicsBody2D, next: Segment) {
    super(body);
    this.next = next;
    this.directionToNext = next.direction();
  }

  calculateMechanicalAdvantage(): number {
    return 1;
  }

  resolveCorrectionDir(): Vec2 {
    return this.selfWrap ? this.selfWrap.directionToNext : this.directionToNext;
  }
}

export class PathEnd extends PathObject {
  previous: Segment;
  directionToPrevious: Vec2;
  selfWrap: PathWrap | null = null;

  constructor(body: PhysicsBody2D, previous: Segment) {
    super(body);
    this.previous = previous;
    this.directionToPrevious = previous.direction().mul(-1);
  }

  calculateMechanicalAdvantage(): number {
    return 1;
  }

  resolveCorrectionDir(): Vec2 {
    return this.selfWrap ? this.selfWrap.directionToPrevious : this.directionToPrevious;
  }
}

export class PathWrap extends PathObject {
  wrapStartPosition: Vec2;
  wrapEndPosition: Vec2;
  directionToPrevious: Vec2;
  directionToNext: Vec2;
  previous: Segment;
  next: Segment;
  wrapDir: WrapDirection;

  constructor(previous: Segment, next: Segment, body: PhysicsBody2D, wrapDir: WrapDirection) {
    super(body);
    this.previous = previous;
    this.next = next;
    this.directionToPrevious = previous.direction().mul(-1);
    this.directionToNext = next.direction();
    this.wrapStartPosition = previous.end;
    this.wrapEndPosition = next.start;
    this.wrapDir = wrapDir;
  }

  bisector(): Vec2 {
    return this.directionToPrevious.add(this.directionToNext);
  }

  calculateMechanicalAdvantage(): number {
    return Mathf.max(this.bisector().length(), 0.01);
  }

  resolveCorrectionDir(): Vec2 {
    return this.bisector().normalized();
  }
}
