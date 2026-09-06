// The wire format between the page's recorder and the production store, and
// the record a sealed run becomes. Shared by both ends so a field cannot be
// renamed on one side only.
//
// A session is one page load. A run is one level start within it, and the unit
// that replays: a bundle must begin at level start (see main.ts), so a reset
// ends one run and begins the next. Everything a run needs to replay is the
// level id, the tree it was played on, the input trace and the held-button
// state the level's first frame was stepped from. The sparse world digests are
// insurance, not reconstruction: the browser and bun disagreed on a 1e-17 m
// overlap once (see sim/selfReplay.ts), and without a digest a production run
// that replays differently would simply replay differently.

import type { SerializedFrame, WorldDigest } from "../sim/trace";

export const INGEST_PATH = "/api/playtest/events";
export const ADMIN_API = "/api/playtest/admin";

// A batch every second of play. Sixty frames is ~3.5 KB as JSON, comfortably
// under the 64 KB a keepalive request may carry, so a queue that built up
// behind a network outage flushes as several requests rather than one refused
// one.
export const FRAMES_PER_BATCH = 60;
// One world digest a second, and one on the run's last frame.
export const DIGEST_EVERY = 60;
// The store's refusals. Body over the cap is a 413, a run over the cap is a 400,
// and either ends the session on the client: nothing the page can do makes the
// next batch acceptable.
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_RUN_FRAMES = 2 * 60 * 60 * 60;
// A session with no batch for this long is sealed as `idle` and forgotten.
export const IDLE_SEAL_MS = 15 * 60 * 1000;
// A page hidden for longer than this restarts the level when it returns, so the
// run it was in ends with reason `pause` rather than continuing after a gap the
// fixed step never saw.
export const PAUSE_RESET_MS = 60 * 1000;

export type Device = "mouse" | "gamepad" | "touch";

// What the page knows about itself at load. None of it touches the sim; it is
// context for reading a run ("it felt laggy", "the aim kept sticking").
export interface SessionMeta {
  commit: string;
  dirty: boolean;
  srcHash: string;
  level: string;
  // From `?player=NAME` on the invite link, if any. The admin assigns the name
  // that sticks; this only pre-fills it.
  nick: string | null;
  device: Device;
  ua: string;
  viewport: { w: number; h: number };
  dpr: number;
  render: "2d" | "3d";
}

export type EndReason = "reset" | "kill" | "unload" | "pause" | "idle";

export type PlaytestEvent =
  | { t: "start"; meta: SessionMeta }
  | { t: "run"; run: number; level: string; heldAtStart: number }
  | { t: "frames"; run: number; from: number; frames: SerializedFrame[] }
  | { t: "digest"; run: number; world: WorldDigest }
  | { t: "end"; run: number; frames: number; reason: EndReason };

export interface Batch {
  session: string;
  // One counter per session, starting at 0. The store accepts a batch only when
  // it is the next one expected, which gives ordering, deduplication and
  // resumption with a single number.
  seq: number;
  events: PlaytestEvent[];
}

export interface Ack {
  ack: number;
}

// Sent with 409 when `seq` was not the next expected. The client drops every
// queued batch below `expect` (the store already has them) and, if the head of
// its queue is above `expect`, gives up: something it believed acknowledged
// is gone, and a run with a hole in it is worthless.
export interface Rewind {
  expect: number;
}

// What a sealed run carries beside the trace, in the bundle's `meta`.
export interface RunMeta {
  session: string;
  run: number;
  player: string;
  nick: string | null;
  ips: string[];
  device: Device;
  ua: string;
  viewport: { w: number; h: number };
  dpr: number;
  render: "2d" | "3d";
  startedAt: number;
  endedAt: number;
  reason: EndReason;
}

// One row of the store's index, which is what the admin page and `cli pull`
// list. Everything here is derivable from the sealed bundle; the index exists
// so listing a month of runs does not mean gunzipping a month of runs.
export interface RunRow {
  id: string;
  session: string;
  run: number;
  player: string;
  nick: string | null;
  level: string;
  commit: string;
  srcHash: string;
  startedAt: number;
  endedAt: number;
  frames: number;
  reason: EndReason;
  device: Device;
  ips: string[];
  // Null until the seal's verification has run; then the same verdict the
  // browser stamps into a P download.
  verdict: { identical: boolean; firstDivergence: { frame: number; field: string; delta: number } | null } | null;
  file: string;
  bytes: number;
}

export interface Player {
  id: string;
  // Null until the admin names them; the page shows the nick or the id then.
  name: string | null;
  // Player ids merged into this one. A session whose cookie carries an alias
  // is attributed to this player.
  aliases: string[];
  ips: Record<string, { first: number; last: number }>;
  sessions: number;
  firstSeen: number;
  lastSeen: number;
  // Players this one is probably the same person as, by shared address: a
  // cleared cookie or a new device. A human confirms with a merge.
  probably: string[];
}

export interface Annotation {
  starred: boolean;
  note: string;
}

export interface LiveRow {
  session: string;
  player: string;
  nick: string | null;
  level: string;
  run: number;
  frames: number;
  startedAt: number;
  lastSeen: number;
  ip: string | null;
}

export interface StorageStats {
  runs: number;
  runBytes: number;
  trashBytes: number;
  freeBytes: number | null;
}

export interface AdminIndex {
  runs: RunRow[];
  players: Record<string, Player>;
  annotations: Record<string, Annotation>;
  live: LiveRow[];
  storage: StorageStats;
  // The tree the server is serving, so a row can say whether a run was played
  // on the build that is live now.
  here: { commit: string; srcHash: string };
}
