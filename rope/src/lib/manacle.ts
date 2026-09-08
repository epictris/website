// The manacle on the chain's far end: one object the sim collides as and both
// renderers draw, so its dimensions live here rather than in either of them.
//
// The sim collides the chain end AS this cuff (`MANACLE_DISC`), so the drawing
// and the sim agree by construction: nothing has to be lifted, cleared or
// papered over to keep the cuff out of whatever it is resting on, and the reach
// a throw is forgiven (one hook radius, see `BallPlayer.deployLimit`) is exactly
// the reach the player is shown.

import { PX } from "../engine/units";
import { Vec2 } from "../engine/vec2";

// The cuff's centreline radius, and the bar stock it is forged from. The jaws
// are drawn shut always - a manacle on a chain is a ring, and the swing was one
// more thing to keep the collision shape in step with for no gain.
export const MANACLE_RADIUS = 4.5 * PX;
export const MANACLE_BAND = 1.7 * PX;

// The disc the manacle collides as: the cuff's own outer edge, so the shape the
// sim flies, rests, bounces and anchors is exactly the shape that is drawn.
// Nothing on the manacle may stand outside it - the hinge knuckle is capped at
// the band's own half-width for that reason.
export const MANACLE_DISC = MANACLE_RADIUS + MANACLE_BAND / 2;

// The widest BAR the cuff can close around: its own bore, the ring's inner
// diameter. What a rail's authored width is measured against - a bar thicker
// than this is one the manacle could not encircle - and the width a curve drawn
// in the editor starts at.
export const MANACLE_BORE = 2 * (MANACLE_RADIUS - MANACLE_BAND / 2);

// The manacle's whole width, mouth to hinge. A baseline: it is how far back
// along the chain a steady facing has to be measured over.
export const MANACLE_SPAN = 2 * MANACLE_RADIUS;

// Where the chain runs, seen from the cuff: from the chain's end node back along
// the chain, measured over a baseline long enough to be steady.
//
// This is what the chain's last link is laid against. A clamped cuff does not
// turn with it - it is bolted to what it bit, and keeps the facing it bit with
// (`BallPlayer.manacleFacing`) - so as the ball swings the chain's touch point
// travels round the rim instead, which is what a chain on a ring does.
//
// NOT the immediately preceding node. The chain's nodes are as close together as
// the sim needs them, and wound onto the ball they are 3 mm apart - a fifth of a
// link - so the last segment's direction is quantised coil noise, and the drawn
// manacle span it about a full turn per second while the ball rolled. A baseline
// of the manacle's own length is the shortest one that cannot be shorter than
// the thing being aimed.
//
// `path` runs ball-side first, END NODE LAST. `fallback` is used when the whole
// path is shorter than a manacle (a chain reeled almost to nothing).
export function chainEndFacing(path: readonly Vec2[], fallback: Vec2): Vec2 {
  const end = path[path.length - 1];
  if (end === undefined) return fallback;
  let walked = 0;
  for (let i = path.length - 2; i >= 0; i--) {
    const node = path[i]!;
    walked += node.distanceTo(path[i + 1]!);
    if (walked >= MANACLE_SPAN && end.distanceTo(node) > 1e-6) return end.directionTo(node);
  }
  const first = path[0]!;
  return end.distanceTo(first) > 1e-6 ? end.directionTo(first) : fallback;
}

// Which way a cuff clamped around a RAIL faces - the axis the bar runs through
// it on, which both renderers turn the ring about.
//
// A cuff that bit a face is bolted to it and keeps the facing it bit with. One
// on a rail is not bolted to anything: it is a ring resting on a bar, free to
// swing about the point it rests on, and a ring hangs in the plane of what is
// pulling it - the way a curtain ring hangs off its rail. So the ring's own
// plane holds the way it HANGS (`RopeClamp.hang`), and the axis it turns about
// is square to that: the cuff is drawn end-on down the chain and pivots on the
// bar as the ball swings, rather than standing square to a bar it is merely
// resting on.
//
// `tangent` is the rail's direction at the cuff, which picks which of the two
// square directions to use - the one that runs WITH the bar - so the ring's
// short foreshortened axis stays on the bar's side of the turn and the drawn
// cuff never flips end for end as the pull crosses the plumb.
export function railCuffAxis(tangent: Vec2, hang: Vec2): Vec2 {
  const square = new Vec2(-hang.y, hang.x);
  return square.dot(tangent) >= 0 ? square : square.mul(-1);
}

// Where the chain TOUCHES the cuff, as a direction from the cuff's centre: the
// point of the rim the chain is laid over, which is where its last link is
// drawn hooked.
//
// A cuff that bit a face is drawn flat on - a full circle of metal - so the
// chain touches it wherever it happens to run, `chainDir` itself, and the touch
// point travels round the rim as the ball swings.
//
// A cuff on a RAIL is drawn as a ring seen edge-on with the bar through it, and
// an edge-on ring has exactly two points of rim to be laid over: the ends of
// its long axis, square to the axis the bar runs through it on. Everything
// between them is the hole. Running the chain to `chainDir` there hangs the
// last link in mid-air inside the ring - metal joined to nothing - so it is
// hooked over whichever end it runs toward instead.
export function cuffRimDirection(axis: Vec2, chainDir: Vec2): Vec2 {
  const along = new Vec2(-axis.y, axis.x);
  return along.dot(chainDir) >= 0 ? along : along.mul(-1);
}
