// The manacle on the chain's far end: one object the sim collides as and both
// renderers draw, so its dimensions live here rather than in either of them.
//
// The cuff is a RING SEEN EDGE-ON. Its axis lies in the gameplay plane, square
// to the chain, so what the camera sees - and what the sim collides - is the
// ring's silhouette: a bar as long as the ring is wide and as thick as the lock
// housing that stands proudest of its band (`manacleShape`). The chain is
// shackled to the HINGE PIN at one end of that bar and the jaws meet under the
// LOCK at the other, which is the end that bites.
//
// The sim collides the chain end AS that bar, so the drawing and the sim agree
// by construction: nothing has to be lifted, cleared or papered over to keep
// the cuff out of whatever it is resting on, and the reach a throw has past
// the chain's own length is exactly the cuff the player is shown on the end of
// it (`BallPlayer.deployLimit`).

import { PX } from "../engine/units";
import { rectShape, type Shape } from "../engine/shapes";
import { Vec2 } from "../engine/vec2";

// The cuff's centreline radius, and the bar stock it is forged from. The jaws
// are drawn shut always - a manacle on a chain is a ring, and the swing was one
// more thing to keep the collision shape in step with for no gain.
export const MANACLE_RADIUS = 4.5 * PX;
export const MANACLE_BAND = 1.7 * PX;

// The ring's bounding radius: half its length, mouth to hinge, the band's own
// outer edge. How far ANY point of the manacle can stand from its centre, and
// so the clearance every query that treats the cuff as a whole measures with -
// the muzzle it is thrown from, the corners of a rail's body the chain is
// already clear of, the sweep along a bar to the lid that stops it. Nothing on
// the manacle may stand outside it.
export const MANACLE_REACH = MANACLE_RADIUS + MANACLE_BAND / 2;

// The bar the sim collides as: the ring's whole length along its long axis,
// and across it the lock housing, which is the widest thing on the cuff. The
// band and the hinge knuckle both stay inside that depth.
export const MANACLE_LENGTH = 2 * MANACLE_REACH;
export const MANACLE_THICKNESS = MANACLE_BAND * 1.3;

// Where the chain is shackled: the hinge pin, on the ring's centreline at the
// far end from the mouth, as an offset from the cuff's centre along its own +x.
// The chain's end node IS this point - free, clamped or bitten - so the length
// the sim enforces is the length to the pin the links hang from, and the drawn
// chain ends where the physics does.
export const MANACLE_HINGE = MANACLE_RADIUS;

// How far the mouth's outer edge stands beyond the hinge pin, along the axis:
// the whole of the forgiveness a throw has past the chain's length. A face the
// mouth can touch with the pin at full stretch is a face the cuff bites.
export const MANACLE_MOUTH = MANACLE_REACH + MANACLE_HINGE;

// The widest BAR the cuff can close around: its own bore, the ring's inner
// diameter. What a rail's authored width is measured against - a bar thicker
// than this is one the manacle could not encircle - and the width a curve drawn
// in the editor starts at.
export const MANACLE_BORE = 2 * (MANACLE_RADIUS - MANACLE_BAND / 2);

// The manacle's whole width, mouth to hinge. A baseline: it is how far back
// along the chain a steady facing has to be measured over.
export const MANACLE_SPAN = 2 * MANACLE_RADIUS;

// The collision shape, in the cuff's own frame: +x toward the hinge (and so
// toward the chain), -x toward the mouth.
export function manacleShape(): Shape {
  return rectShape(MANACLE_LENGTH, MANACLE_THICKNESS);
}

// The hinge pin in the cuff's own frame.
export const MANACLE_HINGE_LOCAL = new Vec2(MANACLE_HINGE, 0);

// Where the chain runs, seen from the cuff: from the cuff back along the chain,
// measured over a baseline long enough to be steady.
//
// This is the way the hook body is turned every frame while it is free (its
// rotation is driven, not integrated - see `BallHook.alignToChain`), so the
// hinge trails the chain and the mouth leads the throw. A clamped cuff does not
// turn with it - it is bolted to what it bit, and keeps the facing it bit with
// (`BallPlayer.manacleFacing`).
//
// NOT the immediately preceding node. The chain's nodes are as close together as
// the sim needs them, and wound onto the ball they are 3 mm apart - a fifth of a
// link - so the last segment's direction is quantised coil noise, and the drawn
// manacle span it about a full turn per second while the ball rolled. A baseline
// of the manacle's own length is the shortest one that cannot be shorter than
// the thing being aimed.
//
// `path` runs ball-side first, END LAST. `fallback` is used when the whole
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
