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

// Two consecutive wrap nodes within the band of each other (squared metres)
// are ONE corner of the path. A vertex two bodies share arrives as one node per
// body - `Rope.regeneratePath` wraps each body's own corner and
// `cullDuplicateNodes` folds only a body's doubled corner, since two bodies
// meeting at a point is a corner the rope is meant to catch (game-design.md,
// "Convex-only polygons; compound bodies") - on the same authored point, or
// half a pixel off it where the two were placed by hand.
//
// The detachment test below reads the bend at a node from the spans either
// side of it, and releases a node only once it stands the band's width off the
// chord its neighbours draw. A neighbour closer than the band cannot witness
// that: the node is never further from the chord than it is from the nearer
// end of it. Coincident, the span between the two has no direction and read as
// no bend at all; a few millimetres apart, the node was always inside the
// band. Either way neither node of a shared corner could be released,
// whichever way the rope actually ran.
//
// `session-473f` f384-397 is the finding: the ball wound up to a corner two
// rocks share, rounded it and pressed up against the face above, the chain
// from its loop now running DOWN to the corner and straight back up past the
// ball - a hairpin with nothing inside it - and the pair held. Every turn the
// player asked for was refused as wound tight against a corner the chain had
// already left, until the aim crossed the loop and spun the ball back down.
// One node at the same corner released at f320. `session-485f` f282-470 is the
// same hairpin at a corner authored 4.5 mm apart on a rock and the ground it
// sits on, with the whole chain wound on: judged against a neighbour 4.5 mm
// away the corner was 4.4 mm off the chord, under the 5 mm band, for 190
// frames.
export const COINCIDENT_NODE_DISTANCE_SQ = MIN_WRAP_DEFLECTION * MIN_WRAP_DEFLECTION;

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
    // A node at the head's own position obstructs nothing: a zero-length line
    // has no side, so `isConstraintViolated` would read every later span as
    // passing behind it on the clockwise hand and route the path back through
    // a node the detachment test had just released, round and round to the
    // depth cap (the cycle `Rope.cullDuplicateNodes` drops a body's doubled
    // corner to avoid; a corner two bodies share is the same span).
    if (segmentToNext.end.distanceSquaredTo(segmentToNext.start) <= COINCIDENT_NODE_DISTANCE_SQ) return;
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

// The nearest node before `head` that does not sit within the band of head's
// own position, or the path's first node when every node back to it does.
function distinctPrevious(head: PathNode): PathNode {
  const at = head.node.contact.globalPosition;
  let previous = head.previous!;
  while (
    previous.previous &&
    previous.node.contact.globalPosition.distanceSquaredTo(at) <= COINCIDENT_NODE_DISTANCE_SQ
  ) {
    previous = previous.previous;
  }
  return previous;
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

  // Check if the head node has detached. The bend is read from the last node
  // NOT within the band of the head's own position: a corner two bodies share
  // is two nodes at one point, and the first of them contributes no direction
  // (or a few millimetres of one, which is worse: it keeps the second inside
  // the band for ever). The last node of such a run is judged on the corner's
  // real incoming span; once it goes, the recursion re-judges the one before
  // it against the real outgoing span, so the corner releases as a whole
  // exactly when one node there would.
  if (head.previous && head.node instanceof RopeWrap) {
    const fromPrevious = new Segment(
      distinctPrevious(head).node.contact.globalPosition,
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
