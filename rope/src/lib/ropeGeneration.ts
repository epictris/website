// RopeGeneration — tangent-point / tangent-corner solving, ported from
// lib/RopeGeneration.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import type { ShapeTransform } from "../engine/shapes";
import { Calc } from "./calc";
import { Segment } from "./segment";
import { ShapeGeometry } from "./shapeGeometry";
import { GenerationDirection, WrapDirection } from "./types";

export const RopeGeneration = {
  calculateRectangleTangentIndex(
    rect: ShapeTransform,
    wrapDir: WrapDirection,
    point: Vec2,
    direction: GenerationDirection,
  ): number {
    const sign = direction as number;
    const confirmDirection = sign * -(wrapDir as number);
    const onValidDirection = sign * (wrapDir as number);
    const onInvalidDirection = sign * -(wrapDir as number);

    const corners = ShapeGeometry.getGlobalCorners(rect);
    let index = 0;
    let searchDirection = 0;
    let candidate: number | null = null;

    for (let i = 0; i < corners.length; i++) {
      const corner = corners[index]!;
      const segment = new Segment(corner, point);
      const toPrev = new Segment(corner, corners[(index - 1 + corners.length) % corners.length]!);
      const toNext = new Segment(corner, corners[(index + 1) % corners.length]!);
      const compareDir = segment.direction().mul(sign);

      const isValid =
        Calc.absoluteAngle(toPrev.direction(), compareDir, WrapDirection.CounterClockwise) >=
        Calc.absoluteAngle(toPrev.direction(), toNext.direction(), WrapDirection.CounterClockwise);

      if (isValid) {
        if (searchDirection === confirmDirection) return index;
        candidate = index;
        searchDirection = onValidDirection;
      } else {
        if (candidate !== null) return candidate;
        searchDirection = onInvalidDirection;
      }
      index = (index + searchDirection + corners.length) % corners.length;
    }

    throw new Error("Could not find valid line to corner");
  },

  calculateCircleTangentPoint(
    circle: ShapeTransform,
    wrapDir: WrapDirection,
    fromPoint: Vec2,
    direction: GenerationDirection,
  ): Vec2 {
    const radius = ShapeGeometry.getRadius(circle);
    const center = circle.globalPosition;
    const wrapToConnection = fromPoint.sub(center);
    const sign = direction as number;

    const angleToTangent =
      wrapToConnection.angle() +
      sign * (wrapDir as number) * Mathf.acos(radius / wrapToConnection.length());

    if (Number.isNaN(angleToTangent)) throw new Error("Circle tangent point is NaN");

    const tangentDirection = new Vec2(Mathf.cos(angleToTangent), Mathf.sin(angleToTangent));
    return center.add(tangentDirection.mul(radius));
  },
};
