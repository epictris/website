// SlackSimulation — Verlet slack-rope visual sim, ported from
// classes/SlackSimulation.cs. Runs only when the rope is shorter than its
// max length; models the hanging catenary-ish curve and collides it with bodies.

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";
import { RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { Colors, Debug } from "../engine/debug";
import { Intersections } from "../lib/intersections";
import { IntersectionStatus } from "../lib/types";
import { RopeContact, type RopeNode } from "../lib/ropeContact";
import { ShapeGeometry } from "../lib/shapeGeometry";

const SPACING = 5;

class SlackNode {
  previousPosition: Vec2;
  position: Vec2;
  velocity: Vec2;
  contactSurfaceNormal: Vec2 | null = null;

  constructor(position: Vec2, velocity: Vec2) {
    this.position = position;
    this.velocity = velocity;
    this.previousPosition = position.sub(velocity);
  }
}

class SlackNodeObject {
  constructor(
    public node: SlackNode,
    public toPrev: Vec2,
    public toNext: Vec2,
  ) {}
  get bisector(): Vec2 {
    return this.toPrev.add(this.toNext);
  }
  get mechanicalAdvantage(): number {
    return Mathf.max(this.bisector.length(), 0.01);
  }
}

export class SlackSimulation {
  private start: RopeContact;
  private end: RopeContact;
  private slackNodes: SlackNode[] = [];

  constructor(path: RopeNode[], _targetLength: number) {
    // NB: matches the C# naming — `end` is the first path node, `start` the last.
    this.end = path[0]!.contact;
    this.start = path[path.length - 1]!.contact;

    let distanceToNextNode = SPACING;

    for (let i = path.length - 2; i >= 0; i--) {
      const nodeA = path[i]!;
      const fromB = new SegmentLite(
        path[i + 1]!.contact.globalPosition,
        nodeA.contact.globalPosition,
      );
      let remainingSegmentLength = fromB.length();
      const direction = fromB.direction();
      while (remainingSegmentLength > distanceToNextNode) {
        const distanceFromA = remainingSegmentLength - distanceToNextNode;
        this.slackNodes.push(
          new SlackNode(
            nodeA.contact.globalPosition.sub(direction.mul(distanceFromA)),
            Vec2.ZERO,
          ),
        );
        remainingSegmentLength -= distanceToNextNode;
        distanceToNextNode = SPACING;
      }
      distanceToNextNode -= remainingSegmentLength;
    }
  }

  getLength(): number {
    let cumulativeLength = 0;
    if (this.slackNodes.length === 0) {
      return this.start.globalPosition.distanceTo(this.end.globalPosition);
    }
    cumulativeLength += this.start.globalPosition.distanceTo(this.slackNodes[0]!.previousPosition);
    for (let i = 0; i < this.slackNodes.length - 1; i++) {
      cumulativeLength += this.slackNodes[i]!.position.distanceTo(this.slackNodes[i + 1]!.position);
    }
    cumulativeLength += this.slackNodes[this.slackNodes.length - 1]!.position.distanceTo(
      this.end.globalPosition,
    );
    return cumulativeLength;
  }

  private generateSlackNodeObjects(): SlackNodeObject[] {
    const objs: SlackNodeObject[] = [];
    let prevPosition = this.start.globalPosition;
    for (let i = 0; i < this.slackNodes.length - 1; i++) {
      const nodeA = this.slackNodes[i]!;
      const nodeB = this.slackNodes[i + 1]!;
      const toPrev = nodeA.position.directionTo(prevPosition);
      const toNext = nodeA.position.directionTo(nodeB.position);
      objs.push(new SlackNodeObject(nodeA, toPrev, toNext));
      prevPosition = nodeA.position;
    }
    const last = this.slackNodes[this.slackNodes.length - 1]!;
    objs.push(
      new SlackNodeObject(
        last,
        last.position.directionTo(prevPosition),
        last.position.directionTo(this.end.globalPosition),
      ),
    );
    return objs;
  }

  private moveNodes(targetLength: number): void {
    const lengthError = this.getLength() - targetLength;
    const objects = this.generateSlackNodeObjects();
    let totalMechanicalAdvantage = 0;
    const dynamicNodes: SlackNodeObject[] = [];

    for (const slackNode of objects) {
      if (
        slackNode.node.contactSurfaceNormal !== null &&
        slackNode.bisector.dot(slackNode.node.contactSurfaceNormal) < 0
      ) {
        continue;
      }
      const mechAdvantage = slackNode.mechanicalAdvantage;
      totalMechanicalAdvantage += mechAdvantage * mechAdvantage;
      dynamicNodes.push(slackNode);
    }

    const relaxationFactor = 0.5;
    const scaledCorrectionImpulse = (lengthError * relaxationFactor) / totalMechanicalAdvantage;

    for (const slackNode of dynamicNodes) {
      const totalCorrectionMagnitude = scaledCorrectionImpulse * slackNode.mechanicalAdvantage;
      const correctionImpulse = slackNode.bisector.normalized().mul(totalCorrectionMagnitude);
      slackNode.node.position = slackNode.node.position.add(correctionImpulse);
    }
  }

  private applyLengthConstraint(targetLength: number): void {
    if (this.getLength() < targetLength) return;
    for (let i = 0; i < 20; i++) {
      this.moveNodes(targetLength);
      if (this.getLength() <= targetLength) return;
    }
  }

  private distanceConstraintIteration(): void {
    for (let i = 0; i < this.slackNodes.length - 1; i++) {
      const nodeA = this.slackNodes[i]!;
      const nodeB = this.slackNodes[i + 1]!;
      const delta = nodeB.position.sub(nodeA.position);
      const distance = delta.length();
      let difference = 0;
      if (distance > 0) difference = (SPACING - distance) / distance;
      const translate = delta.mul(0.5 * difference);
      nodeA.position = nodeA.position.sub(translate);
      nodeB.position = nodeB.position.add(translate);
    }
  }

  private targetNodeCount(targetLength: number): number {
    return Mathf.floorToInt(targetLength / SPACING - 1);
  }

  private finalSpanLength(targetLength: number): number {
    return targetLength - this.targetNodeCount(targetLength) * SPACING;
  }

  private applyDistanceConstraint(targetLength: number): void {
    const first = this.slackNodes[0]!;
    const startToFirst = first.position.sub(this.start.globalPosition);
    first.position = this.start.globalPosition.add(startToFirst.normalized().mul(SPACING));

    const last = this.slackNodes[this.slackNodes.length - 1]!;
    const lastToEnd = this.end.globalPosition.sub(last.position);
    last.position = this.end.globalPosition.sub(
      lastToEnd.normalized().mul(this.finalSpanLength(targetLength)),
    );

    for (let i = 0; i < 4; i++) this.distanceConstraintIteration();
  }

  step(targetLength: number, bodies: PhysicsBody2D[]): void {
    if (this.slackNodes.length > this.targetNodeCount(targetLength)) {
      this.slackNodes.pop();
    } else if (this.slackNodes.length < this.targetNodeCount(targetLength)) {
      const last = this.slackNodes[this.slackNodes.length - 1]!;
      this.slackNodes.push(
        new SlackNode(
          this.end.globalPosition.add(
            this.end.globalPosition
              .directionTo(last.position)
              .mul(this.finalSpanLength(targetLength)),
          ),
          this.end.obj instanceof RigidBody2D ? this.end.obj.linearVelocity : Vec2.ZERO,
        ),
      );
    }

    if (this.slackNodes.length === 0) return;

    for (const slackNode of this.slackNodes) {
      slackNode.velocity = slackNode.position.sub(slackNode.previousPosition);
      slackNode.velocity = slackNode.velocity.mul(0.99);
      slackNode.velocity = slackNode.velocity.add(Vec2.DOWN.mul(0.1));
      slackNode.previousPosition = slackNode.position;
      slackNode.position = slackNode.position.add(slackNode.velocity);
    }

    this.applyLengthConstraint(targetLength);
    this.applyDistanceConstraint(targetLength);
    this.resolveRopeCollisions(bodies);
  }

  private resolveRopeCollisions(bodies: PhysicsBody2D[]): void {
    const nodesToIgnore = new Set<SlackNode>();
    if (this.end.obj.name === "Player") {
      for (let i = this.slackNodes.length - 1; i >= 0; i--) {
        const node = this.slackNodes[i]!;
        if (
          Intersections.intersectsPoint(this.end.obj.getShape(), node.position) ===
          IntersectionStatus.Overlap
        ) {
          nodesToIgnore.add(node);
        } else {
          break;
        }
      }
    }

    for (const slackNode of this.slackNodes) {
      slackNode.contactSurfaceNormal = null;
      if (nodesToIgnore.has(slackNode)) continue;
      for (const body of bodies) {
        const bodyShape = body.getShape();
        if (
          Intersections.intersectsPoint(bodyShape, slackNode.position) !==
          IntersectionStatus.Overlap
        ) {
          continue;
        }
        if (bodyShape.shape.kind === "circle") {
          const circleCenter = bodyShape.globalPosition;
          const circleRadius = bodyShape.shape.radius;
          const delta = slackNode.position.sub(circleCenter);
          const dist = delta.length();
          if (dist < 0.001) {
            slackNode.position = circleCenter.add(Vec2.UP.mul(circleRadius));
            slackNode.contactSurfaceNormal = Vec2.UP;
          } else {
            slackNode.position = circleCenter.add(delta.div(dist).mul(circleRadius));
            slackNode.contactSurfaceNormal = delta.normalized();
          }
        } else {
          const hw = bodyShape.shape.size.x * 0.5;
          const hh = bodyShape.shape.size.y * 0.5;
          const local = slackNode.position
            .sub(bodyShape.globalPosition)
            .rotated(-bodyShape.globalRotation);
          const dRight = hw - local.x;
          const dLeft = hw + local.x;
          const dBottom = hh - local.y;
          const dTop = hh + local.y;
          const minPen = Mathf.min(Mathf.min(dRight, dLeft), Mathf.min(dBottom, dTop));

          let localPush: Vec2;
          if (minPen === dRight) localPush = new Vec2(dRight, 0);
          else if (minPen === dLeft) localPush = new Vec2(-dLeft, 0);
          else if (minPen === dBottom) localPush = new Vec2(0, dBottom);
          else localPush = new Vec2(0, -dTop);

          slackNode.position = slackNode.position.add(localPush.rotated(bodyShape.globalRotation));
          slackNode.contactSurfaceNormal = localPush.rotated(bodyShape.globalRotation);
        }
      }
    }
  }

  render(): void {
    if (this.slackNodes.length === 0) {
      Debug.drawLine(this.start.globalPosition, this.end.globalPosition, Colors.SandyBrown, 1);
      return;
    }
    Debug.drawLine(this.start.globalPosition, this.slackNodes[0]!.position, Colors.SandyBrown, 1);
    for (let i = 0; i < this.slackNodes.length - 1; i++) {
      Debug.drawLine(
        this.slackNodes[i]!.position,
        this.slackNodes[i + 1]!.position,
        Colors.SandyBrown,
        1,
      );
    }
    Debug.drawLine(
      this.slackNodes[this.slackNodes.length - 1]!.position,
      this.end.globalPosition,
      Colors.SandyBrown,
      1,
    );
  }
}

// Minimal directed segment used internally (avoids the NaN-checking Segment).
class SegmentLite {
  constructor(
    public start: Vec2,
    public end: Vec2,
  ) {}
  length(): number {
    return this.end.sub(this.start).length();
  }
  direction(): Vec2 {
    return this.start.directionTo(this.end);
  }
}
