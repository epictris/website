// NodeDetachment — culls detached rope wrap points, ported from
// lib/NodeDetachment.cs.

import { Segment } from "./segment";
import { RopeAttachment, RopeNode, RopeWrap } from "./ropeContact";
import { WrapDirection } from "./types";

// The band, in metres, either side of a surface in which a corner is treated as
// not deflecting the rope. It is ONE number because it is one band: a corner
// must deflect the path by this much before it becomes a wrap (the grazing gate
// in `Rope.regeneratePath`), and a wrap must be this far the wrong way before it
// is released (`shouldDetachNode` below). Lives here rather than on `Rope`
// because the release half is here and the create half imports it; a create
// threshold that does not match its release threshold is the hole both halves
// exist to close.
export const MIN_WRAP_DEFLECTION = 0.005;

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
  if (fromPrevious.direction().angleTo(toTarget.direction()) * (wrap.wrapDir as number) >= 0) {
    return false;
  }
  // The other half of the band `MIN_WRAP_DEFLECTION` opens on the create side,
  // and it has to be the same number with the other sign or the two disagree
  // about a corner they are both looking at. Creating a wrap asks the corner to
  // deflect the path by half a pixel; releasing one on the bare SIGN of the bend
  // lets go the instant the path is straight, which is not the same thing at
  // all: it leaves half a pixel in which the chain lies against a face with
  // nothing holding it on either side of that face.
  //
  // A chain resting flat along a face lives exactly there. Its bend at the
  // corner it came over is zero by construction - the outgoing span runs down
  // the face - so the sign test fires on float noise, the wrap goes, and the
  // chain is left lying IN the surface. Whichever way the next frame moves is
  // then which side of the body it ends up on, and a 10 cm slat is thin enough
  // to be crossed in one step: `session-323f` f218, where the chain let go of a
  // rail sleeper's near corner at a bend of 0.006 degrees, was through it by
  // f219, and re-wrapped from the far side with the opposite hand - which
  // lassoed the sleeper, pinned the ball against it for 25 frames, and let go
  // of both wraps at once when the solve finally tore it free.
  //
  // So the release waits until the node is genuinely on the wrong side by the
  // width of the band, measured the way the create gate measures it: the node's
  // distance from the chord its two neighbours draw.
  const chord = new Segment(fromPrevious.start, toTarget.end);
  const node = wrap.contact.globalPosition;
  return chord.getClosestPointOnLine(node).distanceTo(node) > MIN_WRAP_DEFLECTION;
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
