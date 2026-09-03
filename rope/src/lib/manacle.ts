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
