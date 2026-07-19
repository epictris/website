// Segment — a directed line segment, ported from classes/Segment.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { WrapDirection } from "./types";
import { getIntersectionPoint } from "./intersections";

export class Segment {
  start: Vec2;
  end: Vec2;

  constructor(start: Vec2, end: Vec2) {
    if (
      Number.isNaN(start.x) ||
      Number.isNaN(start.y) ||
      Number.isNaN(end.x) ||
      Number.isNaN(end.y)
    ) {
      throw new Error("NaN detected");
    }
    this.start = start;
    this.end = end;
  }

  length(): number {
    return this.end.sub(this.start).length();
  }

  calculateWrapDirection(point: Vec2): WrapDirection {
    return point.sub(this.start).cross(this.end.sub(this.start)) > 0
      ? WrapDirection.CounterClockwise
      : WrapDirection.Clockwise;
  }

  getClosestPointOnLine(point: Vec2, clamp = true): Vec2 {
    const segmentVector = this.end.sub(this.start);
    const pointVector = point.sub(this.start);
    const segmentLengthSquared = segmentVector.lengthSquared();
    if (segmentLengthSquared === 0) return this.start;
    let t = pointVector.dot(segmentVector) / segmentLengthSquared;
    if (clamp) t = Mathf.clamp(t, 0, 1);
    return this.start.add(segmentVector.mul(t));
  }

  direction(): Vec2 {
    return this.start.directionTo(this.end);
  }

  intersects(other: Segment, tolerance = 0.01): boolean {
    if (getIntersectionPoint(this, other) !== null) return true;
    if (tolerance <= 0) return false;
    return this.minDistance(other) <= tolerance;
  }

  private minDistance(other: Segment): number {
    return Mathf.min(
      Mathf.min(
        other.getClosestPointOnLine(this.start).distanceTo(this.start),
        other.getClosestPointOnLine(this.end).distanceTo(this.end),
      ),
      Mathf.min(
        this.getClosestPointOnLine(other.start).distanceTo(other.start),
        this.getClosestPointOnLine(other.end).distanceTo(other.end),
      ),
    );
  }
}
