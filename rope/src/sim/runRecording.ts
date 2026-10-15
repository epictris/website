// The run a P press downloads, as the page accumulates it step by step (the
// game's `main.ts` and the editor's test mode both keep one).
//
// The INPUTS are kept whole: a bundle replays from frame 0, and the frames are
// all a replay needs to re-create every digest of the run - which is the point
// of a deterministic sim. The DIGESTS are what the replay is checked against,
// and they are kept in full only for the most recent `DENSE_WINDOW_FRAMES`;
// older than that, one frame in `CHECKPOINT_EVERY` survives as a checkpoint.
//
// Why. A world digest is every body that can move - 273 of them on BALL, about
// 37 KB a frame - and every one of them was retained until the level reset:
// 2.2 MB a second, so a tab left in a level ran out of memory within the hour
// (2026-10-13, the editor tab "paused before potential out-of-memory crash"),
// players' tabs included. A bug a bundle reports is nearly always in its last
// seconds, which keep every frame; before that the checkpoints still say
// whether the replay is the run that was played, to the second, and `cli
// replay`/`diverge` read a bundle's digests by frame number, so a sparse past
// is one they already compare (production runs stream one a second too).
//
// A body digest equal in every field to the same body's on the frame before is
// stored as that frame's object rather than a copy. On BALL that is two bodies
// in three (the sleeping vine links), so the window costs a third of what it
// would. Nothing mutates a digest after it is made, so the sharing is invisible
// to every reader and to the JSON.

import { DIGEST_EVERY } from "../playtest/protocol";
import type { BodyDigest, Digest, SerializedFrame, WorldDigest } from "./trace";

// Thirty seconds of the 60 Hz step.
export const DENSE_WINDOW_FRAMES = 30 * 60;
// One a second, the production stream's own cadence.
export const CHECKPOINT_EVERY = DIGEST_EVERY;

export interface RunBundleParts {
  frames: SerializedFrame[];
  digests: Digest[];
  worldDigests: WorldDigest[];
}

// One digest list: the checkpoints older than the window, then the window, a
// ring of exactly `DENSE_WINDOW_FRAMES` slots. A digest leaving the window is
// overwritten in the same push, so nothing outside it stays reachable (an
// array compacted every window-length held up to twice the window between
// compactions, which read in the browser as a leak that had not gone).
class DigestHistory<T extends { frame: number }> {
  private readonly checkpoints: T[] = [];
  private readonly ring: (T | undefined)[] = new Array<T | undefined>(DENSE_WINDOW_FRAMES).fill(undefined);
  // The oldest digest in the window, and how many there are.
  private head = 0;
  private size = 0;

  push(d: T): void {
    if (this.size < DENSE_WINDOW_FRAMES) {
      this.ring[(this.head + this.size) % DENSE_WINDOW_FRAMES] = d;
      this.size++;
      return;
    }
    const leaving = this.ring[this.head]!;
    if (leaving.frame % CHECKPOINT_EVERY === 0) this.checkpoints.push(leaving);
    this.ring[this.head] = d;
    this.head = (this.head + 1) % DENSE_WINDOW_FRAMES;
  }

  clear(): void {
    this.checkpoints.length = 0;
    this.ring.fill(undefined);
    this.head = 0;
    this.size = 0;
  }

  get last(): T | undefined {
    return this.size > 0 ? this.ring[(this.head + this.size - 1) % DENSE_WINDOW_FRAMES] : undefined;
  }

  list(): T[] {
    const out = this.checkpoints.slice();
    for (let i = 0; i < this.size; i++) out.push(this.ring[(this.head + i) % DENSE_WINDOW_FRAMES]!);
    return out;
  }
}

function sameBody(a: BodyDigest, b: BodyDigest): boolean {
  // `Object.is`, so a -0 is not taken for a 0: the digest keeps the bits the
  // sim produced, and the replay compares them.
  return (
    Object.is(a.id, b.id) &&
    Object.is(a.px, b.px) &&
    Object.is(a.py, b.py) &&
    Object.is(a.rot, b.rot) &&
    Object.is(a.vx, b.vx) &&
    Object.is(a.vy, b.vy) &&
    Object.is(a.w, b.w) &&
    Object.is(a.contactWith, b.contactWith) &&
    Object.is(a.contactPn, b.contactPn) &&
    Object.is(a.hits, b.hits)
  );
}

export class RunRecording {
  private readonly frames: SerializedFrame[] = [];
  private readonly digests = new DigestHistory<Digest>();
  private readonly worldDigests = new DigestHistory<WorldDigest>();

  get length(): number {
    return this.frames.length;
  }

  // One stepped frame: the input it was stepped with and what it left. The
  // world digest's unchanged bodies are swapped for the previous frame's
  // objects in place, which is why it is taken here rather than copied.
  push(frame: SerializedFrame, digest: Digest, world: WorldDigest): void {
    const prev = this.worldDigests.last;
    if (prev) {
      const bodies = world.bodies;
      const before = prev.bodies;
      for (let i = 0; i < bodies.length && i < before.length; i++) {
        if (sameBody(bodies[i]!, before[i]!)) bodies[i] = before[i]!;
      }
    }
    this.frames.push(frame);
    this.digests.push(digest);
    this.worldDigests.push(world);
  }

  clear(): void {
    this.frames.length = 0;
    this.digests.clear();
    this.worldDigests.clear();
  }

  // Fresh arrays, so the bundle is not changed by the steps after the press.
  bundle(): RunBundleParts {
    return {
      frames: this.frames.slice(),
      digests: this.digests.list(),
      worldDigests: this.worldDigests.list(),
    };
  }
}
