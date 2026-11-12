// Where the ball's chain is laid, shared by the 2D and 3D renderers: the path
// its links are walked along (anchor first), at what pitch, and how many.
//
// SHACKLED - whenever no throw is paying chain out - the chain ends on the
// ball's loop, its last link hooked through the loop's hole with that link's
// end bar bearing on the inside of the loop's bar on the side the chain pulls
// toward. A link can only hook a ring square to it: the loop lies in the
// gameplay plane, so the link through it is the edge-on one, and so is the
// link on the cuff's hinge pin at the other end (`ChainLink.broad`). Both ends
// edge-on is an ODD number of links, so a shackled chain always has one: the
// nearest odd count to its length in links, at the pitch that fits exactly
// that many along the drawn run (Tris, 2026-11-12). The chain's length only
// changes while a throw pays it out or a release reels it in, so the count
// only ever snaps at the moment the chain stops moving.
//
// Before this the chain was laid on past the point under the loop to the
// ball's centre, so it ran across the loop's bar and into the ball's surface
// beside it (`session-234f`). That run is still how a chain being thrown is
// laid: its links slide out of the ball as it pays out, any count, too fast to
// be read.

import type { BallPlayer } from "../classes/ballPlayer";
import { Vec2 } from "../engine/vec2";
import { CHAIN_LINK_LEN, chainLinkPitch } from "./chainMetrics";

// The loop as the chain sees it: its centre, and the radii of its hole and its
// outside edge, as the renderer at hand draws it.
export interface ShackleLoop {
  centre: Vec2;
  inner: number;
  outer: number;
}

export interface BallChainLayout {
  // Anchor (the cuff's hinge pin) first.
  path: Vec2[];
  pitch: number;
  // How many links to lay; undefined lays as many as fit (`walkChain`).
  count: number | undefined;
  // Whether the chain ends on the loop rather than running into the ball.
  shackled: boolean;
}

function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += points[i - 1]!.distanceTo(points[i]!);
  return total;
}

// `loopToAnchor` is the drawn chain, loop end first: the drape
// (`SlackChain.pathLoopToAnchor`) or the straight wrap path.
export function ballChainLayout(
  ball: BallPlayer,
  loopToAnchor: readonly Vec2[],
  alpha: number,
  loop: ShackleLoop,
): BallChainLayout {
  const length = ball.chainSlack?.chainLength(alpha) ?? polylineLength(loopToAnchor);

  if (ball.hookInFlight !== null) {
    const path = [...loopToAnchor].reverse();
    path.push(ball.renderPosition(alpha));
    const pitch = ball.chainSlack ? chainLinkPitch(loopToAnchor, length) : CHAIN_LINK_LEN;
    return { path, pitch, count: undefined, shackled: false };
  }

  // The run starts where it leaves the loop: every point of the drawn chain
  // inside the loop's outside edge is chain the loop already holds (the sim's
  // chain starts on the rim under it).
  let first = 0;
  while (first < loopToAnchor.length - 1 && loopToAnchor[first]!.distanceTo(loop.centre) <= loop.outer) first++;
  const toward = loopToAnchor[first]!;
  const off = toward.sub(loop.centre);
  const dir = off.length() > 1e-9 ? off.normalized() : ball.renderLoopDirection(alpha);
  const bearing = loop.centre.add(dir.mul(loop.inner));

  const path: Vec2[] = [];
  for (let i = loopToAnchor.length - 1; i >= first; i--) path.push(loopToAnchor[i]!);
  path.push(bearing);

  const run = polylineLength(path);
  // The nearest odd count to the chain's length in links; none when the cuff
  // sits so close to the loop that not even half a link fits between them (a
  // stowed tip, hinged on the loop itself).
  const odd = 2 * Math.floor(length / CHAIN_LINK_LEN / 2) + 1;
  const count = run < CHAIN_LINK_LEN / 2 ? 0 : odd;
  return { path, pitch: count > 0 ? run / count : CHAIN_LINK_LEN, count, shackled: true };
}
