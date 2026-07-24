// NodeDetachment — culls detached rope wrap points, ported from
// lib/NodeDetachment.cs.

import { Segment } from "./segment";
import { RopeAttachment, RopeNode, RopeWrap } from "./ropeContact";
import { WrapDirection } from "./types";

class PathConstraint {
  constructor(
    public line: Segment,
    public node: PathNode,
  ) {}
}

class PathConstraints {
  private constraints = new Map<WrapDirection, PathConstraint | null>([
    [WrapDirection.Clockwise, null],
    [WrapDirection.CounterClockwise, null],
  ]);

  isConstraintViolated(constraintDir: WrapDirection, segmentToNext: Segment): boolean {
    const constraint = this.constraints.get(constraintDir);
    return (
      !!constraint &&
      // Line passes behind the constraint attachment point
      constraint.line.calculateWrapDirection(segmentToNext.end) === constraintDir &&
      // Line to constraint is shorter than the line to the next node
      constraint.line.length() < segmentToNext.length()
    );
  }

  updateConstraint(
    constraintDir: WrapDirection,
    segmentToNext: Segment,
    newNode: PathNode,
  ): void {
    if (!this.isConstraintViolated(constraintDir, segmentToNext)) {
      this.constraints.set(constraintDir, new PathConstraint(segmentToNext, newNode));
    }
  }

  getViolatedConstraint(segmentToNext: Segment): PathNode | null {
    for (const [dir, constraint] of this.constraints) {
      if (this.isConstraintViolated(dir, segmentToNext)) {
        return constraint?.node ?? null;
      }
    }
    return null;
  }
}

class PathNode {
  constraints = new PathConstraints();
  node: RopeNode;
  previous: PathNode | null;

  constructor(node: RopeNode, previous: PathNode | null = null) {
    this.node = node;
    this.previous = previous;
  }
}

function shouldDetachNode(fromPrevious: Segment, toTarget: Segment, wrap: RopeWrap): boolean {
  return fromPrevious.direction().angleTo(toTarget.direction()) * (wrap.wrapDir as number) < 0;
}

function buildValidPathToTarget(head: PathNode, target: RopeNode, depth = 0): PathNode {
  if (head.node === target) return head;
  depth++;
  if (depth > 50) {
    // Pathological wrap tangle (a degenerate span — e.g. an anchor landing
    // almost on top of the ball — sends the router into an unresolving cycle).
    // Connecting head straight to target instead of throwing keeps the sim
    // alive; the next solve refines the path. Depth>50 is unreachable on any
    // healthy path, so this never fires for well-behaved replays.
    return new PathNode(target, head);
  }

  const toTarget = new Segment(
    head.node.contact.globalPosition,
    target.contact.globalPosition,
  );

  // If the span to target is obstructed by a previously culled node, route via it.
  const violated = head.constraints.getViolatedConstraint(toTarget);
  if (violated) {
    violated.previous = head;
    return buildValidPathToTarget(violated, target, depth);
  }

  const newNode = new PathNode(target, head);

  if (target instanceof RopeWrap) {
    head.constraints.updateConstraint(target.wrapDir, toTarget, newNode);
  }

  // Check if the head node has detached.
  if (head.previous && head.node instanceof RopeWrap) {
    const fromPrevious = new Segment(
      head.previous.node.contact.globalPosition,
      head.node.contact.globalPosition,
    );
    if (shouldDetachNode(fromPrevious, toTarget, head.node)) {
      return buildValidPathToTarget(head.previous, target, depth);
    }
  }

  return newNode;
}

export function cullDetachedNodes(
  start: RopeAttachment,
  end: RopeAttachment,
  wraps: RopeWrap[],
): RopeWrap[] {
  let head: PathNode | null = new PathNode(start);
  for (const node of [...wraps, end] as RopeNode[]) {
    head = buildValidPathToTarget(head!, node);
  }
  const newNodes: RopeWrap[] = [];
  while (head) {
    if (head.node instanceof RopeWrap) newNodes.push(head.node);
    head = head.previous;
  }
  newNodes.reverse();
  return newNodes;
}
