// Rope — the wrap-point rope model + PBD length/friction solver, ported from
// classes/Rope.cs. Models the rope as a sequence of wrap points around scene
// geometry rather than evenly spaced segments.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { PhysicsBody2D, RigidBody2D } from "../engine/body";
import { Colors } from "../engine/debug";
import { Segment } from "../lib/segment";
import { Intersections, type Intersection } from "../lib/intersections";
import { ShapeGeometry } from "../lib/shapeGeometry";
import { RopeGeneration } from "../lib/ropeGeneration";
import { cullDetachedNodes } from "../lib/nodeDetachment";
import { Calc } from "../lib/calc";
import {
  RopeAttachment,
  RopeContact,
  RopeNode,
  RopeWrap,
} from "../lib/ropeContact";
import { GenerationDirection, IntersectionStatus, WrapDirection } from "../lib/types";
import { PathEnd, PathObject, PathStart, PathWrap } from "../lib/pathObject";
import { Player } from "./player";
import { Hook } from "./hook";

export class RopePath {
  constructor(
    public from: RopeNode,
    public to: RopeNode,
    public span: Segment,
  ) {}
}

interface DynamicBody {
  body: PhysicsBody2D;
  inertia: number;
  mass: number;
  addVelocity(v: Vec2): void;
  addRotation(r: number): void;
}

export class Rope {
  maxRopeLength = 1000;
  maxIterations = 10;
  frictionCoefficient = 0.4;

  start: RopeAttachment;
  end: RopeAttachment;
  wraps: RopeWrap[];

  private frameStartDistanceLookup = new Map<RopeNode, number>();

  constructor(
    start: RopeContact,
    end: RopeContact,
    wraps: RopeWrap[] | null = null,
    initialLength: number | null = null,
  ) {
    this.start = new RopeAttachment(start);
    this.end = new RopeAttachment(end);
    this.registerHookCallbacks();
    this.wraps = wraps ?? [];
    this.maxRopeLength = initialLength ?? this.calculateRopePathLength();
  }

  get isTaut(): boolean {
    return this.calculateRopePathLength() > this.maxRopeLength - 3;
  }

  retract(amount = 1): void {
    // The rope may never be retracted to a negative length.
    this.maxRopeLength = Mathf.max(this.maxRopeLength - amount, 0);
  }

  extend(): void {
    this.maxRopeLength += 1;
  }

  updateFrameStartDistanceLookup(): void {
    this.frameStartDistanceLookup = this.genDistanceToStartLookup();
  }

  path(): RopeNode[] {
    return [this.start, ...this.wraps, this.end];
  }

  // Wires hook attachment callbacks; called on construction and after snapshot restore.
  registerHookCallbacks(): void {
    const endObj = this.end.contact.obj;
    if (endObj instanceof Hook) {
      endObj.registerAttachmentCallback((body, point) => {
        this.end = new RopeAttachment(new RopeContact(body, point.sub(body.globalPosition)));
        this.maxRopeLength = Mathf.max(this.maxRopeLength, this.calculateRopePathLength());
      });
    }
    const startObj = this.start.contact.obj;
    if (startObj instanceof Hook) {
      startObj.registerAttachmentCallback((body, point) => {
        this.start = new RopeAttachment(new RopeContact(body, point.sub(body.globalPosition)));
        this.maxRopeLength = Mathf.max(this.maxRopeLength, this.calculateRopePathLength());
      });
    }
  }

  getSpans(): RopePath[] {
    return this.regenerateSpans();
  }

  getCurrentLength(): number {
    return this.calculateRopePathLength();
  }

  getDistanceToStartLookup(): Map<RopeNode, number> {
    return this.genDistanceToStartLookup();
  }

  render(color: string): void {
    for (const span of this.getSpans()) {
      // Debug.drawLine(span.span.start, span.span.end, color, 1); // drawn by renderer via getSpans
    }
  }

  physicsStep(bodies: PhysicsBody2D[], delta: number): void {
    this.uncrossAdjacentNodes();
    this.regeneratePath(bodies);

    const prePositions = new Map<PhysicsBody2D, Vec2>();
    const preRotations = new Map<PhysicsBody2D, number>();
    for (const b of bodies) {
      prePositions.set(b, b.globalPosition);
      preRotations.set(b, b.globalRotation);
    }

    if (
      this.start.contact.obj instanceof Player &&
      this.end.contact.obj instanceof Hook &&
      this.wraps.length === 0
    ) {
      // The slack rope sim looks weird while the hook is unfurling.
      this.maxRopeLength = this.calculateRopePathLength();
    } else {
      const endObj = this.end.contact.obj;
      if (endObj instanceof Hook) {
        const lastWrap = this.wraps[this.wraps.length - 1]!;
        endObj.velocity = endObj.globalPosition
          .directionTo(lastWrap.contact.obj.globalPosition)
          .mul(10);
        this.wraps.pop();
        this.end = new RopeAttachment(lastWrap.contact);
        this.maxRopeLength = this.calculateRopePathLength();
        endObj.world?.remove(endObj);
      }
    }

    const correctionImpulse = this.resolveLengthConstraint();
    if (correctionImpulse !== null) {
      // Friction impulse may push the rope past its max length; re-solve.
      this.resolveLengthConstraint();

      for (const body of bodies) {
        const dynamicBody = this.getDynamicBodyState(body);
        if (dynamicBody) {
          dynamicBody.addVelocity(
            body.globalPosition.sub(prePositions.get(body)!).div(delta),
          );
          dynamicBody.addRotation((body.globalRotation - preRotations.get(body)!) / delta);
          // (Godot pushed the mutated transform back into the physics server here;
          // in this engine the body transform is already authoritative.)
        }
      }
    }
  }

  private regenerateSpans(): RopePath[] {
    const p = this.path();
    const spans: RopePath[] = [];
    for (let i = 0; i < p.length - 1; i++) {
      spans.push(
        new RopePath(
          p[i]!,
          p[i + 1]!,
          new Segment(p[i]!.contact.globalPosition, p[i + 1]!.contact.globalPosition),
        ),
      );
    }
    return spans;
  }

  private resolveSelfIntersectionAtStart(fromNode: RopeNode, span: Segment): RopeNode | null {
    const obj = fromNode.contact.obj;
    if (obj instanceof Player && fromNode === this.start) return null;
    if (obj instanceof Hook && fromNode === this.start) return null;

    if (Intersections.intersectsSegment(obj.getShape(), span) !== IntersectionStatus.Overlap) {
      return null;
    }
    const wrapDir = span.calculateWrapDirection(obj.globalPosition);
    if (fromNode instanceof RopeWrap && fromNode.wrapDir !== wrapDir) return null;

    const fromShape = obj.getShape();
    if (
      fromShape.shape.kind === "circle" &&
      Intersections.intersectsPoint(fromShape, span.end) === IntersectionStatus.Separate
    ) {
      const circleCenter = fromShape.globalPosition;
      const circleRadius = ShapeGeometry.getRadius(fromShape);
      // Mirror of the C#: the else branch is always taken here (guarded by Separate above).
      const tangentPoint = RopeGeneration.calculateCircleTangentPoint(
        fromShape,
        wrapDir,
        span.end,
        GenerationDirection.Reversed,
      );
      if (tangentPoint.distanceTo(span.start) > 5) {
        return new RopeWrap(new RopeContact(obj, tangentPoint.sub(circleCenter)), wrapDir);
      }
    } else if (fromShape.shape.kind === "rect") {
      const rectCenter = fromShape.globalPosition;
      const corners = ShapeGeometry.getGlobalCorners(fromShape);
      let nextVertexIndex = 0;
      let minAngle = Infinity;
      for (let i = 0; i < 4; i++) {
        const vertex = corners[i]!;
        if (vertex.distanceSquaredTo(fromNode.contact.globalPosition) < 0.01) {
          nextVertexIndex = Calc.mod(i + (wrapDir as number), 4);
          break;
        }
        const angleToVertex = Calc.absoluteAngle(
          rectCenter.directionTo(fromNode.contact.globalPosition),
          rectCenter.directionTo(vertex),
          wrapDir,
        );
        if (angleToVertex < minAngle) {
          minAngle = angleToVertex;
          nextVertexIndex = i;
        }
      }
      const nextVertex = corners[nextVertexIndex]!;
      if (Intersections.intersectsPoint(fromShape, span.end) === IntersectionStatus.Separate) {
        return new RopeWrap(new RopeContact(obj, nextVertex.sub(rectCenter)), wrapDir);
      }
    }
    return null;
  }

  private resolveSelfIntersectionAtEnd(toNode: RopeNode, span: Segment): RopeNode | null {
    const obj = toNode.contact.obj;
    if (obj instanceof Hook && toNode === this.end) return null;

    const toShape = obj.getShape();
    if (Intersections.intersectsSegment(toShape, span) !== IntersectionStatus.Overlap) return null;

    const wrapDir = span.calculateWrapDirection(obj.globalPosition);
    if (toNode instanceof RopeWrap && toNode.wrapDir !== wrapDir) return null;

    if (
      toShape.shape.kind === "circle" &&
      Intersections.intersectsPoint(toShape, span.start) === IntersectionStatus.Separate
    ) {
      const circleCenter = toShape.globalPosition;
      const tangentPoint = RopeGeneration.calculateCircleTangentPoint(
        toShape,
        wrapDir,
        span.start,
        GenerationDirection.Forward,
      );
      if (tangentPoint.distanceTo(span.end) > 5) {
        return new RopeWrap(new RopeContact(obj, tangentPoint.sub(circleCenter)), wrapDir);
      }
    } else if (toShape.shape.kind === "rect") {
      const rectCenter = toShape.globalPosition;
      const corners = ShapeGeometry.getGlobalCorners(toShape);
      let nextVertexIndex = 0;
      let minAngle = Infinity;
      for (let i = 0; i < 4; i++) {
        const vertex = corners[i]!;
        if (vertex.distanceSquaredTo(toNode.contact.globalPosition) < 0.01) {
          nextVertexIndex = Calc.mod(i - (wrapDir as number), 4);
          break;
        }
        const angleToVertex = Calc.absoluteAngle(
          rectCenter.directionTo(vertex),
          rectCenter.directionTo(toNode.contact.globalPosition),
          wrapDir,
        );
        if (angleToVertex < minAngle) {
          minAngle = angleToVertex;
          nextVertexIndex = i;
        }
      }
      const nextVertex = corners[nextVertexIndex]!;
      if (Intersections.intersectsPoint(toShape, span.start) === IntersectionStatus.Separate) {
        return new RopeWrap(new RopeContact(obj, nextVertex.sub(rectCenter)), wrapDir);
      }
    }
    return null;
  }

  private resolveNodeSelfIntersections(): void {
    const newNodes: RopeWrap[] = [];
    for (const span of this.regenerateSpans()) {
      if (span.from instanceof RopeWrap) newNodes.push(span.from);
      if (this.shouldIgnorePathCollisions(span)) continue;

      const startIntersection = this.resolveSelfIntersectionAtStart(span.from, span.span);
      if (startIntersection instanceof RopeWrap) {
        newNodes.push(startIntersection);
      } else {
        const endIntersection = this.resolveSelfIntersectionAtEnd(span.to, span.span);
        if (endIntersection instanceof RopeWrap) newNodes.push(endIntersection);
      }
    }
    this.wraps = newNodes;
  }

  private shouldIgnorePathCollisions(span: RopePath): boolean {
    return (
      span.from.contact.obj === span.to.contact.obj ||
      span.span.start.distanceTo(span.span.end) < 1
    );
  }

  private isPointOutsideBoundingStrip(point: Vec2, span: Segment): boolean {
    return (
      span.direction().dot(span.start.directionTo(point)) < 0 ||
      span.direction().dot(span.end.directionTo(point)) > 0
    );
  }

  private regeneratePath(bodies: PhysicsBody2D[]): void {
    this.resolveNodeSelfIntersections();
    const newNodes: RopeWrap[] = [];

    for (const span of this.regenerateSpans()) {
      if (span.from instanceof RopeWrap) newNodes.push(span.from);
      if (this.shouldIgnorePathCollisions(span)) continue;

      const colliders: PhysicsBody2D[] = [];
      for (const body of bodies) {
        if (body === span.from.contact.obj || body === span.to.contact.obj) continue;
        const shape = body.getShape();
        if (
          this.isPointOutsideBoundingStrip(body.globalPosition, span.span) &&
          (Intersections.intersectsPoint(shape, span.span.start) === IntersectionStatus.Overlap ||
            Intersections.intersectsPoint(shape, span.span.end) === IntersectionStatus.Overlap)
        ) {
          continue;
        }
        if (Intersections.intersectsSegment(shape, span.span) === IntersectionStatus.Overlap) {
          colliders.push(body);
        }
      }

      colliders.sort(
        (a, b) =>
          span.span.getClosestPointOnLine(a.globalPosition).distanceTo(span.span.start) -
          span.span.getClosestPointOnLine(b.globalPosition).distanceTo(span.span.start),
      );

      for (const body of colliders) {
        const bodyShape = body.getShape();
        const wrapDir = span.span.calculateWrapDirection(body.globalPosition);

        if (bodyShape.shape.kind === "circle") {
          let tangentPoint: Vec2;
          const { entry, exit } = Intersections.getIntersectionsShapeSegment(bodyShape, span.span);
          if (entry && !exit) tangentPoint = entry.point;
          else if (!entry && exit) tangentPoint = exit.point;
          else if (entry && exit) {
            tangentPoint = RopeGeneration.calculateCircleTangentPoint(
              bodyShape,
              wrapDir,
              span.span.start,
              GenerationDirection.Forward,
            );
          } else continue;

          if (tangentPoint.distanceTo(span.span.start) > 5) {
            newNodes.push(
              new RopeWrap(new RopeContact(body, tangentPoint.sub(bodyShape.globalPosition)), wrapDir),
            );
          }
        } else {
          const corners = ShapeGeometry.getGlobalCorners(bodyShape);
          let vertexIndex: number | null = null;
          const { entry, exit } = Intersections.getIntersectionsShapeSegment(bodyShape, span.span);
          if ((entry && !exit) || (!entry && exit) || (!entry && !exit)) {
            let maxVertexAngle = 0;
            for (let i = 0; i < 4; i++) {
              const vertex = corners[i]!;
              if (
                this.isPointOutsideBoundingStrip(vertex, span.span) ||
                span.span.calculateWrapDirection(vertex) === wrapDir
              ) {
                continue;
              }
              const angleToVertex = Calc.absoluteAngle(
                span.span.direction(),
                span.span.start.directionTo(vertex),
                wrapDir === WrapDirection.Clockwise
                  ? WrapDirection.CounterClockwise
                  : WrapDirection.Clockwise,
              );
              if (maxVertexAngle < angleToVertex && angleToVertex < Mathf.Pi / 2) {
                vertexIndex = i;
                maxVertexAngle = angleToVertex;
              }
            }
          } else if (entry && exit) {
            vertexIndex = RopeGeneration.calculateRectangleTangentIndex(
              bodyShape,
              wrapDir,
              span.span.start,
              GenerationDirection.Forward,
            );
          }
          if (
            vertexIndex !== null &&
            corners[vertexIndex]!.distanceTo(span.span.start) > 5
          ) {
            newNodes.push(
              new RopeWrap(
                new RopeContact(body, corners[vertexIndex]!.sub(bodyShape.globalPosition)),
                wrapDir,
              ),
            );
          }
        }
      }
    }
    this.wraps = newNodes;
    this.cullDuplicateNodes();
    this.wraps = cullDetachedNodes(this.start, this.end, this.wraps);
  }

  // Uncross segments adjacent to corner nodes of oppositely-wrapped shapes.
  private uncrossAdjacentNodes(): void {
    for (let i = 0; i < this.wraps.length - 3; i++) {
      const segAB = new Segment(
        this.wraps[i]!.contact.globalPosition,
        this.wraps[i + 1]!.contact.globalPosition,
      );
      const segCD = new Segment(
        this.wraps[i + 2]!.contact.globalPosition,
        this.wraps[i + 3]!.contact.globalPosition,
      );
      if (segAB.intersects(segCD, 0)) {
        const tmp = this.wraps[i + 1]!;
        this.wraps[i + 1] = this.wraps[i + 2]!;
        this.wraps[i + 2] = tmp;
      }
    }
  }

  private cullDuplicateNodes(): void {
    const newNodes: RopeWrap[] = [];
    let previousNodePosition = this.start.contact.globalPosition;
    for (const node of this.wraps) {
      const shape = node.contact.obj.getShape();
      if (
        shape.shape.kind === "rect" ||
        node.contact.globalPosition.distanceTo(previousNodePosition) > 1
      ) {
        newNodes.push(node);
        previousNodePosition = node.contact.globalPosition;
      }
    }
    this.wraps = newNodes;
  }

  private generatePathObjects(): PathObject[] {
    const spans = this.regenerateSpans();
    const start = new PathStart(this.start.contact.obj as PhysicsBody2D, spans[0]!.span);
    const end = new PathEnd(this.end.contact.obj as PhysicsBody2D, spans[spans.length - 1]!.span);
    const pathWraps: PathWrap[] = [];

    let prevSegment = spans[0]!.span;
    const p = this.path();
    for (let i = 1; i < p.length - 1; i++) {
      const nodeA = p[i]!;
      const nodeB = p[i + 1]!;
      if (nodeA instanceof RopeWrap) {
        const shape = nodeA.contact.obj.getShape();
        if (
          nodeA.contact.obj !== nodeB.contact.obj ||
          shape.shape.kind === "rect" ||
          nodeB === this.end
        ) {
          const nextSegment = new Segment(
            nodeA.contact.globalPosition,
            nodeB.contact.globalPosition,
          );
          pathWraps.push(
            new PathWrap(prevSegment, nextSegment, nodeA.contact.obj as PhysicsBody2D, nodeA.wrapDir),
          );
          prevSegment = nextSegment;
        }
      }
    }
    if (pathWraps.length > 0 && pathWraps[0]!.body === start.body) {
      start.selfWrap = pathWraps[0]!;
      pathWraps.shift();
    }
    if (pathWraps.length > 0 && pathWraps[pathWraps.length - 1]!.body === end.body) {
      end.selfWrap = pathWraps[pathWraps.length - 1]!;
      pathWraps.pop();
    }
    return [start, ...pathWraps, end];
  }

  private calculateRopePathLength(): number {
    let cumulativeLength = 0;
    for (const span of this.regenerateSpans()) {
      cumulativeLength += span.span.start.distanceTo(span.span.end);
    }
    if (this.start.contact.obj instanceof Player) {
      cumulativeLength -= this.start.contact.obj.radialCoMOffset;
    }
    if (this.end.contact.obj instanceof Player) {
      cumulativeLength -= this.end.contact.obj.radialCoMOffset;
    }
    return cumulativeLength;
  }

  private resolveLengthConstraint(): number | null {
    let cumulativeCorrectionImpulse = 0;
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const correctionImpulse = this.correctShapePositionAndRotation();
      if (correctionImpulse !== null) {
        cumulativeCorrectionImpulse += correctionImpulse;
      } else if (iteration === 0) {
        return null;
      } else {
        break;
      }
    }
    return cumulativeCorrectionImpulse;
  }

  // Perpendicular lever from the body's centre of rotation to the correction force.
  private calculateTorqueArm(segment: PathObject): number {
    const correctionDir = segment.resolveCorrectionDir();

    if (segment instanceof PathStart) {
      if (segment.body instanceof Player) return 0;
      const shape = segment.body.getShape();
      const leverArm = segment.selfWrap
        ? segment.selfWrap.next.start.sub(shape.globalPosition)
        : segment.next.start.sub(shape.globalPosition);
      return leverArm.cross(correctionDir);
    }
    if (segment instanceof PathEnd) {
      const shape = segment.body.getShape();
      const leverArm = segment.selfWrap
        ? segment.selfWrap.previous.end.sub(shape.globalPosition)
        : segment.previous.end.sub(shape.globalPosition);
      return leverArm.cross(correctionDir);
    }
    if (segment instanceof PathWrap && segment.body.getShape().shape.kind === "rect") {
      const leverArm = segment.wrapStartPosition.sub(segment.body.globalPosition);
      const torqueFromStart = leverArm.cross(segment.directionToPrevious);
      const torqueFromEnd = leverArm.cross(segment.directionToNext);
      return (torqueFromStart + torqueFromEnd) / segment.calculateMechanicalAdvantage();
    }
    // Wrapped circle: force passes through the centre.
    return 0;
  }

  private getDynamicBodyState(body: PhysicsBody2D): DynamicBody | null {
    if (body instanceof RigidBody2D) {
      return {
        body,
        inertia: body.inertia,
        mass: body.mass,
        addVelocity: (v) => {
          body.linearVelocity = body.linearVelocity.add(v);
        },
        addRotation: (r) => {
          body.angularVelocity += r;
        },
      };
    }
    if (body instanceof Player) {
      return {
        body,
        inertia: body.inertia,
        mass: body.mass,
        addVelocity: (v) => {
          body.velocity = body.velocity.add(v);
        },
        addRotation: (r) => {
          body.globalRotation += r;
        },
      };
    }
    return null;
  }

  private correctShapePositionAndRotation(): number | null {
    const currentLength = this.calculateRopePathLength();
    if (currentLength <= this.maxRopeLength) return null;

    const pathObjects = this.generatePathObjects();
    const lengthError = currentLength - this.maxRopeLength;
    let totalEffectiveInverseInertia = 0;
    const dynamicPathObjects: PathObject[] = [];

    for (const segment of pathObjects) {
      const dynamicBody = this.getDynamicBodyState(segment.body);
      if (dynamicBody) {
        dynamicPathObjects.push(segment);
        const mechanicalAdvantage = segment.calculateMechanicalAdvantage();
        const torqueArm = this.calculateTorqueArm(segment);
        const inverseEffectiveMass =
          1 / dynamicBody.mass + (torqueArm * torqueArm) / dynamicBody.inertia;
        totalEffectiveInverseInertia +=
          mechanicalAdvantage * mechanicalAdvantage * inverseEffectiveMass;
      }
    }

    const relaxationFactor = 1;
    if (totalEffectiveInverseInertia < 1e-6) return 0;
    const scaledCorrectionImpulse = (lengthError * relaxationFactor) / totalEffectiveInverseInertia;

    for (const pathObject of dynamicPathObjects) {
      const dynamicBody = this.getDynamicBodyState(pathObject.body);
      if (!dynamicBody) continue;
      const correctionDir = pathObject.resolveCorrectionDir();
      if (correctionDir.lengthSquared() < 0.0001) continue;
      const mechanicalAdvantage = pathObject.calculateMechanicalAdvantage();
      if (mechanicalAdvantage < 1e-6) continue;
      const torqueArm = this.calculateTorqueArm(pathObject);
      const inverseEffectiveMass =
        1 / dynamicBody.mass + (torqueArm * torqueArm) / dynamicBody.inertia;
      const totalCorrectionMagnitude =
        scaledCorrectionImpulse * mechanicalAdvantage * inverseEffectiveMass;

      const torqueSquared = torqueArm * torqueArm;
      if (torqueSquared > 0) {
        const denominator = dynamicBody.inertia + dynamicBody.mass * torqueSquared;
        const linearFactor = dynamicBody.inertia / denominator;
        const angularFactor = (dynamicBody.mass * torqueArm) / denominator;
        dynamicBody.body.globalPosition = dynamicBody.body.globalPosition.add(
          correctionDir.mul(totalCorrectionMagnitude * linearFactor),
        );
        dynamicBody.body.globalRotation += totalCorrectionMagnitude * angularFactor;
      } else {
        dynamicBody.body.globalPosition = dynamicBody.body.globalPosition.add(
          correctionDir.mul(totalCorrectionMagnitude),
        );
      }
    }
    return scaledCorrectionImpulse;
  }

  private genDistanceToStartLookup(): Map<RopeNode, number> {
    const lookup = new Map<RopeNode, number>();
    lookup.set(this.start, 0);
    let prev: RopeNode = this.start;
    let cumulativeLength = 0;
    for (const node of this.path()) {
      if (node instanceof RopeWrap) {
        const distanceToPrev = node.contact.globalPosition.distanceTo(prev.contact.globalPosition);
        cumulativeLength += distanceToPrev;
        lookup.set(node, cumulativeLength);
        prev = node;
      }
    }
    return lookup;
  }
}
