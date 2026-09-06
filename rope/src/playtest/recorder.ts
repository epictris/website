// Streams a session's runs to the production store as they are played (see
// playtest/protocol.ts for the record and plans/playtest-recording.md for why).
//
// The P download needs a human to press P and to send the file on; a friend
// playtesting does neither, and a tab closed mid-run took the run with it. This
// posts the same input trace a batch at a time, so the store holds every frame
// up to the moment the page went away.
//
// One batch in flight at a time and one sequence number per session. The store
// takes a batch only when it is the next expected, so a lost response is
// retried and then answered 409 with what the store already has, and the queue
// drops to there. Nothing is dropped on the client side: a run with a hole in
// it is worthless, so frames wait in the queue for as long as the outage lasts.

import type { SerializedFrame, WorldDigest } from "../sim/trace";
import {
  FRAMES_PER_BATCH,
  type Batch,
  type EndReason,
  type PlaytestEvent,
  type Rewind,
  type SessionMeta,
} from "./protocol";

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

export class PlaytestRecorder {
  readonly session = crypto.randomUUID();
  private nextSeq = 0;
  private pending: PlaytestEvent[] = [];
  private queue: Batch[] = [];
  private inflight = false;
  // Set when the store refused the session for good (a 4xx that is not a
  // rewind) or the queue fell out of step with it. Nothing is sent after.
  private dead = false;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private run = -1;
  private runOpen = false;
  private runFrames = 0;
  private buffer: SerializedFrame[] = [];
  private bufferFrom = 0;

  constructor(
    private readonly endpoint: string,
    meta: SessionMeta,
  ) {
    this.pending.push({ t: "start", meta });
  }

  get currentRun(): number {
    return this.run;
  }

  get isRunOpen(): boolean {
    return this.runOpen;
  }

  // A fresh level. `heldAtStart` is the hand the level's first frame will be
  // stepped from (see `Recording.heldAtStart`).
  startRun(level: string, heldAtStart: number): void {
    if (this.runOpen) this.endRun("reset");
    this.run++;
    this.runOpen = true;
    this.runFrames = 0;
    this.buffer = [];
    this.bufferFrom = 0;
    this.pending.push({ t: "run", run: this.run, level, heldAtStart });
  }

  // One stepped frame of the current run.
  frame(f: SerializedFrame): void {
    if (!this.runOpen) return;
    this.buffer.push(f);
    this.runFrames++;
    if (this.buffer.length >= FRAMES_PER_BATCH) this.flush();
  }

  digest(world: WorldDigest): void {
    if (!this.runOpen) return;
    this.flushFrames();
    this.pending.push({ t: "digest", run: this.run, world });
  }

  endRun(reason: EndReason, keepalive = false): void {
    if (!this.runOpen) return;
    this.flushFrames();
    this.pending.push({ t: "end", run: this.run, frames: this.runFrames, reason });
    this.runOpen = false;
    this.flush(keepalive);
  }

  // Package what is pending and send. `keepalive` is for the page going away:
  // every queued batch is fired at once, because there will be no second turn
  // to send the next one in, and a batch the store already had is answered 409
  // and dropped if the page turns out to survive.
  flush(keepalive = false): void {
    this.flushFrames();
    if (this.pending.length > 0) {
      this.queue.push({ session: this.session, seq: this.nextSeq++, events: this.pending });
      this.pending = [];
    }
    if (keepalive) {
      for (const batch of this.queue) void this.post(batch, true).catch(() => undefined);
      return;
    }
    void this.send();
  }

  private flushFrames(): void {
    if (this.buffer.length === 0) return;
    this.pending.push({ t: "frames", run: this.run, from: this.bufferFrom, frames: this.buffer });
    this.bufferFrom += this.buffer.length;
    this.buffer = [];
  }

  private post(batch: Batch, keepalive: boolean): Promise<Response> {
    return fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
      keepalive,
      credentials: "same-origin",
    });
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    // Jittered so a room of players who lost the same network do not all come
    // back on the same tick.
    const delay = this.retryMs * (0.5 + Math.random());
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.send();
    }, delay);
  }

  private async send(): Promise<void> {
    if (this.inflight || this.dead || this.queue.length === 0) return;
    this.inflight = true;
    const batch = this.queue[0]!;
    try {
      const res = await this.post(batch, false);
      if (res.ok) {
        this.queue.shift();
        this.retryMs = RETRY_MIN_MS;
      } else if (res.status === 409) {
        const { expect } = (await res.json()) as Rewind;
        this.queue = this.queue.filter((b) => b.seq >= expect);
        if (this.queue.length > 0 && this.queue[0]!.seq > expect) {
          console.warn(`[playtest] store expects batch ${expect}, queue starts at ${this.queue[0]!.seq}; recording stopped`);
          this.dead = true;
        }
      } else if (res.status >= 400 && res.status < 500) {
        console.warn(`[playtest] store refused batch ${batch.seq} with ${res.status}; recording stopped`);
        this.dead = true;
      } else {
        this.scheduleRetry();
      }
    } catch {
      this.scheduleRetry();
    } finally {
      this.inflight = false;
    }
    if (!this.dead && this.queue.length > 0 && this.retryTimer === null) void this.send();
  }
}
