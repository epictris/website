// RopeGeneration — tangent-point / tangent-corner solving, ported from
// lib/RopeGeneration.cs.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import type { ShapeTransform } from "../engine/shapes";
import { ShapeGeometry } from "./shapeGeometry";
import { GenerationDirection, WrapDirection } from "./types";

export const RopeGeneration = {
  // The vertex a rope leaving `point` bends around when it wraps this convex
  // piece in `wrapDir` - its **tangent vertex** on that side, the last corner a
  // taut line from `point` touches before the shape is behind it.
  //
  // It is the angular EXTREME of the vertex loop about `point`: the vertex every
  // other vertex of the loop lies to the `wrapDir` side of. `point` outside a
  // convex loop sees its vertices within less than half a turn, so the shape's
  // own interior gives a reference direction none of them is more than half a
  // turn from and the comparison never has to be unwrapped.
  //
  // The C# original walked the loop instead, stopping at the first corner
  // `point` could NOT see and taking the one before it. That is the same vertex
  // whenever some corner is hidden - and for the rectangles it was written for
  // (hence its name) one always is, because the far diagonal corner of a
  // rectangle is occluded from every point outside it. It is not true of a
  // convex loop in general: when the two tangent vertices are ADJACENT the whole
  // far side is a single edge, no vertex is hidden at all, the walk runs out of
  // loop and the old code threw "Could not find valid line to corner". Since
  // authored concave outlines are decomposed into triangles and quads, most
  // wrappable pieces of a level are that shape - a fifth of the straight spans
  // through a piece of `levels/ball.json` approach one from a fan the walk could
  // not answer for, and the throw killed the frame loop mid-step
  // (`session-6942f`, one step past the end of the recording).
  //
  // `null` where there is no tangent to find - a `point` inside the loop, which
  // every direction out of is spanned by. The caller reaches this having found
  // the span crossing clean through, so it should not happen; it means the frame
  // has no wrap to make rather than a wrap to guess at.
  calculateTangentVertexIndex(
    shape: ShapeTransform,
    wrapDir: WrapDirection,
    point: Vec2,
  ): number | null {
    const corners = ShapeGeometry.getGlobalCorners(shape);
    const n = corners.length;
    if (n === 0) return null;

    // The loop's own centroid, which is inside it, so this points into the fan
    // of directions the vertices are spread over.
    let reference = new Vec2(0, 0);
    for (const corner of corners) reference = reference.add(corner);
    reference = reference.mul(1 / n).sub(point);
    if (reference.lengthSquared() === 0) return null;

    let best: number | null = null;
    let bestAngle = 0;
    let bestDistance = 0;
    for (let i = 0; i < n; i++) {
      const toVertex = corners[i]!.sub(point);
      const distance = toVertex.lengthSquared();
      if (distance === 0) continue; // `point` IS this vertex: no line to measure
      const angle = reference.angleTo(toVertex) * (wrapDir as number);
      // Ties are vertices collinear with `point`: the rope runs along that line
      // and bends at the far one, which is also where the walk this replaces
      // ended up.
      if (best === null || angle < bestAngle || (angle === bestAngle && distance > bestDistance)) {
        best = i;
        bestAngle = angle;
        bestDistance = distance;
      }
    }
    if (best === null) return null;
    // A `point` inside the loop has no extreme - every direction out of it is
    // spanned - and the winner above is then whichever vertex sorted first.
    // Reject it by the answer's own defining property: no other vertex may lie
    // on the far side of the ray through it.
    const toBest = corners[best]!.sub(point);
    for (let i = 0; i < n; i++) {
      if (i === best) continue;
      const toVertex = corners[i]!.sub(point);
      if (toBest.cross(toVertex) * (wrapDir as number) < 0) return null;
    }
    return best;
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
