// The chain reeling back into the ball after it is let go - a VISUAL of the
// release, and nothing else.
//
// In the sim a release is instantaneous: `BallPlayer.releaseChain` drops the
// rope, the hook body and the cuff in one call, and the next throw can leave on
// the very same step. That is the right rule for the game - a redeploy that
// waited on an animation would be input lag dressed as polish - and it is also
// a chain that vanishes from the screen between two frames. This class keeps
// the picture: it watches the ball once per sim step, keeps hold of the slack
// drape of the chain that is out (`SlackChain`, the visual-only particle chain
// both renderers already draw), and the step the chain is gone it puts that
// same drape into its reel (`SlackChain.beginReel`) and steps it from here.
//
// The drape carrying on is the whole point. Its nodes are exactly where the
// deployed chain was drawn on the last frame, so there is no frame on which
// the chain changes shape for any reason but the reel itself: the released
// chain hangs, swings, drags over the scenery and heaps under the same
// gravity, friction and collisions it had a moment before, with its far end
// let go and hauled in through the loop.
//
// Render-side by construction, like the sparks: it reads the level and writes
// nothing back, so no replay, digest or invariant can see it, and the sim
// carries no state for it at all - not even an event.
//
// A NEW THROW DELETES IT. The chain that is out is the chain, and a second one
// still reeling in beside it would be two chains on a ball that has one - so
// the step a chain appears, whatever was reeling is dropped, wherever it had
// got to. A release-and-redeploy inside one step therefore plays no reel at
// all, which is the same statement.

import { Vec2 } from "../engine/vec2";
import type { BallPlayer } from "../classes/ballPlayer";
import type { Rope } from "../classes/rope";
import type { SlackChain } from "../classes/slackChain";
import type { BallLevel } from "../level/ballLevel";
import { MANACLE_HINGE } from "../lib/manacle";

// One frame of the reeling chain, for the renderers: the polyline to lay
// links along - FAR END FIRST, then on through the loop to the ball's centre,
// the same order the deployed chain is laid in and for the opposite reason:
// laid from the end being hauled, the links slide home with it (see
// chainMetrics.ts) - and the cuff at that end, its hinge on the chain's end.
export interface RetractFrame {
  readonly path: readonly Vec2[];
  readonly centre: Vec2;
  readonly dir: Vec2;
}

export class ChainRetract {
  private ball: BallPlayer | null = null;
  // The chain seen at the last `observe`, by identity: a new `Rope` is a new
  // throw whether or not the old one was seen to go.
  private chain: Rope | null = null;
  // The drape of the chain that is out, as of the last step it was out.
  private slack: SlackChain | null = null;
  // The drape now reeling in, or null while nothing is.
  private reeling: SlackChain | null = null;
  // Scratch for the resolved polyline: a frame must not allocate per node.
  private readonly path: Vec2[] = [];

  // Once per sim step, after the step: notice a chain that has gone, keep the
  // drape of the one that is out, and step the reel. `level` is the level
  // just stepped, or null for one without a ball.
  observe(level: BallLevel | null, delta: number): void {
    const ball = level?.ball ?? null;
    if (ball !== this.ball) {
      // A different ball is a different level (a reset, or a replay loaded
      // over the live game): nothing it did not throw can be reeling in.
      this.reset();
      this.ball = ball;
    }
    if (level === null || ball === null) return;
    const chain = ball.chain;
    if (chain !== this.chain) {
      // Let go: the drape as it stands starts reeling in from where it was.
      // A new throw instead: the chain that is out is the chain (see the
      // header), and one still reeling is dropped.
      this.reeling = chain === null && this.slack?.beginReel() ? this.slack : null;
      this.chain = chain;
    }
    this.slack = ball.chainSlack;
    if (this.reeling !== null && !this.reeling.stepReel(level.bodies, delta)) {
      this.reeling = null;
    }
  }

  get active(): boolean {
    return this.reeling !== null;
  }

  // The reeling chain as it stands this frame, or null when there is none.
  // `alpha` is the render interpolation factor the ball is drawn at, so both
  // ends are welded to the drawn ball rather than its sim pose.
  resolve(alpha: number): RetractFrame | null {
    const ball = this.ball;
    const reel = this.reeling?.reelPath(alpha);
    if (ball === null || !reel) return null;
    // Far end first, then the loop, then on into the ball (the tail under the
    // body, as the deployed chain is drawn).
    const path = this.path;
    path.length = 0;
    for (let i = reel.path.length - 1; i >= 0; i--) path.push(reel.path[i]!);
    path.push(ball.renderPosition(alpha));
    // The cuff trails the chain's end hinge-first, as a free cuff hangs: its
    // centre one hinge offset behind the end, against the way it faces.
    const hinge = path[0]!;
    return { path, centre: hinge.sub(reel.dir.mul(MANACLE_HINGE)), dir: reel.dir };
  }

  // Forget everything: the level is being replaced.
  reset(): void {
    this.ball = null;
    this.chain = null;
    this.slack = null;
    this.reeling = null;
  }
}
