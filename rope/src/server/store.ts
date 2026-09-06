// The production playtest store: ingest, sealing, players, the index, the
// admin operations and the sweeper (see plans/playtest-recording.md).
//
// Files on disk, because the consumer is a CLI that already reads bundles from
// the filesystem and a corpus runner that already walks directories:
//
//   <dir>/sessions/YYYY-MM/<session>.ndjson   live append log, one batch per line
//   <dir>/runs/YYYY-MM/<session>-r<k>.json.gz sealed Recording bundles
//   <dir>/trash/<deleted-at>-<id>.json.gz      deleted runs, purged after 30 days
//   <dir>/players.json                         player id -> name, aliases, addresses
//   <dir>/annotations.json                     run id -> starred, note
//   <dir>/index.json                           one row per sealed run
//
// A batch is appended to its session's log as one line before it is
// acknowledged, so what the store has said it has, it has. Everything else here
// is derived from those logs: a run is sealed by reading its session's log back,
// and a server restart rebuilds every live session the same way.
//
// NODE ONLY: this reads and writes the filesystem. The page imports
// `playtest/protocol.ts` and nothing from here.

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ACTIONS, type Recording, type SerializedFrame, type WorldDigest } from "../sim/trace";
import {
  IDLE_SEAL_MS,
  MAX_RUN_FRAMES,
  type AdminIndex,
  type Annotation,
  type Batch,
  type EndReason,
  type LiveRow,
  type Player,
  type PlaytestEvent,
  type RunMeta,
  type RunRow,
  type SessionMeta,
} from "../playtest/protocol";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_ID = /^[0-9a-f-]{36}-r\d+$/;
const MAX_EVENTS_PER_BATCH = 1000;
const MAX_FRAMES_PER_EVENT = 6000;
const HELD_MASK_LIMIT = 1 << ACTIONS.length;
const END_REASONS = new Set<EndReason>(["reset", "kill", "unload", "pause"]);
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// A shared address within this window is what makes a new player id
// "probably" an existing player.
const SAME_ADDRESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const NEW_SESSIONS_PER_IP_PER_HOUR = 20;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;

export type Verdict = NonNullable<RunRow["verdict"]>;

export interface StoreOptions {
  dir: string;
  // The tree this server serves, for the index's `here`.
  here: { commit: string; srcHash: string };
  // Replays a sealed bundle and returns its verdict, or null when it cannot.
  // Injected because production runs it in a subprocess (a two-hour run takes
  // tens of seconds to re-simulate, and the event loop has other players to
  // answer) while the cases run it inline.
  verify?: (file: string) => Promise<Verdict | null>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface IngestResult {
  status: number;
  body: unknown;
  // The player id the response should set as the cookie.
  pid: string;
}

interface LiveRun {
  run: number;
  level: string;
  heldAtStart: number;
  frames: number;
  startedAt: number;
  ended: EndReason | null;
  sealed: boolean;
}

interface LiveSession {
  id: string;
  pid: string;
  ips: string[];
  meta: SessionMeta | null;
  // The next batch sequence number expected.
  seq: number;
  runs: LiveRun[];
  startedAt: number;
  lastSeen: number;
  log: string;
}

interface LogLine {
  seq: number;
  at: number;
  ip: string;
  pid: string;
  events: PlaytestEvent[];
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
const isFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown, max = 400): v is string => typeof v === "string" && v.length <= max;

function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function runId(session: string, run: number): string {
  return `${session}-r${run}`;
}

// Whole-file rewrites go through a temporary name and a rename, so a crash
// mid-write leaves the previous file rather than half of the new one.
function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function walk(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, ext));
    else if (entry.name.endsWith(ext)) out.push(p);
  }
  return out.sort();
}

function validateMeta(m: unknown): SessionMeta {
  if (!isRecord(m)) throw new Refusal(400, "start: meta is not an object");
  const viewport = m.viewport;
  if (
    !isStr(m.commit, 64) ||
    typeof m.dirty !== "boolean" ||
    !isStr(m.srcHash, 64) ||
    !isStr(m.level, 64) ||
    !(m.nick === null || isStr(m.nick, 40)) ||
    !(m.device === "mouse" || m.device === "gamepad" || m.device === "touch") ||
    !isStr(m.ua, 1000) ||
    !isRecord(viewport) ||
    !isFinite(viewport.w) ||
    !isFinite(viewport.h) ||
    !isFinite(m.dpr) ||
    !(m.render === "2d" || m.render === "3d")
  ) {
    throw new Refusal(400, "start: meta has a field of the wrong shape");
  }
  return {
    commit: m.commit,
    dirty: m.dirty,
    srcHash: m.srcHash,
    level: m.level,
    nick: m.nick,
    device: m.device,
    ua: m.ua,
    viewport: { w: viewport.w, h: viewport.h },
    dpr: m.dpr,
    render: m.render,
  };
}

function validateFrame(f: unknown): SerializedFrame {
  if (!isRecord(f) || !isInt(f.h) || f.h >= HELD_MASK_LIMIT || !isFinite(f.mx) || !isFinite(f.my)) {
    throw new Refusal(400, "frames: a frame is not {h, mx, my}");
  }
  return { h: f.h, mx: f.mx, my: f.my };
}

export class PlaytestStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly here: StoreOptions["here"];
  private readonly verifier: StoreOptions["verify"];

  private sessions = new Map<string, LiveSession>();
  private players: Record<string, Player>;
  private aliasOf = new Map<string, string>();
  private annotations: Record<string, Annotation>;
  private index = new Map<string, RunRow>();
  private newSessionTimes = new Map<string, number[]>();
  private verifyQueue: string[] = [];
  private verifying = false;

  constructor(opts: StoreOptions) {
    this.dir = opts.dir;
    this.here = opts.here;
    this.verifier = opts.verify;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => undefined);
    for (const sub of ["sessions", "runs", "trash"]) mkdirSync(join(this.dir, sub), { recursive: true });

    this.players = readJson(this.path("players.json"), {});
    for (const p of Object.values(this.players)) for (const a of p.aliases) this.aliasOf.set(a, p.id);
    this.annotations = readJson(this.path("annotations.json"), {});
    for (const row of readJson<RunRow[]>(this.path("index.json"), [])) this.index.set(row.id, row);
    this.reconcileIndex();
    this.recoverSessions();
  }

  private path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  // ---- persistence -----------------------------------------------------------

  private saveIndex(): void {
    const rows = [...this.index.values()].sort((a, b) => b.startedAt - a.startedAt);
    writeAtomic(this.path("index.json"), JSON.stringify(rows));
  }

  private savePlayers(): void {
    writeAtomic(this.path("players.json"), JSON.stringify(this.players));
  }

  private saveAnnotations(): void {
    writeAtomic(this.path("annotations.json"), JSON.stringify(this.annotations));
  }

  // The index is a cache of the runs directory. A row whose file is gone is
  // dropped; a file without a row (a restore from backup, a crash between the
  // rename and the index write) is read back into one.
  private reconcileIndex(): void {
    let changed = false;
    for (const [id, row] of this.index) {
      if (!existsSync(this.path(row.file))) {
        this.index.delete(id);
        changed = true;
      }
    }
    for (const file of walk(this.path("runs"), ".json.gz")) {
      const rel = file.slice(this.dir.length + 1);
      if ([...this.index.values()].some((r) => r.file === rel)) continue;
      try {
        const rec = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Recording;
        const row = this.rowFor(rec, rel, statSync(file).size);
        if (row) {
          this.index.set(row.id, row);
          changed = true;
        }
      } catch (e) {
        this.log(`index: cannot read ${rel}: ${String(e)}`);
      }
    }
    if (changed) this.saveIndex();
  }

  private rowFor(rec: Recording, file: string, bytes: number): RunRow | null {
    const m = rec.meta;
    if (!m) return null;
    return {
      id: runId(m.session, m.run),
      session: m.session,
      run: m.run,
      player: m.player,
      nick: m.nick,
      level: rec.level,
      commit: rec.git ?? "unknown",
      srcHash: rec.srcHash ?? "",
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      frames: rec.frames.length,
      reason: m.reason,
      device: m.device,
      ips: m.ips,
      verdict: rec.selfReplay ? { identical: rec.selfReplay.identical, firstDivergence: rec.selfReplay.firstDivergence } : null,
      file,
      bytes,
    };
  }

  // Every live session is rebuilt from its log through the same state machine
  // ingest runs, so a restart mid-session costs nothing but the batches that
  // were in flight, and those the client still holds.
  private recoverSessions(): void {
    for (const file of walk(this.path("sessions"), ".ndjson")) {
      const id = file.slice(file.lastIndexOf("/") + 1, -".ndjson".length);
      let sess: LiveSession | null = null;
      for (const text of readFileSync(file, "utf8").split("\n")) {
        if (!text) continue;
        let line: LogLine;
        try {
          line = JSON.parse(text) as LogLine;
        } catch {
          continue;
        }
        if (!sess) {
          sess = {
            id,
            pid: line.pid,
            ips: [],
            meta: null,
            seq: 0,
            runs: [],
            startedAt: line.at,
            lastSeen: line.at,
            log: file,
          };
        }
        if (line.seq !== sess.seq) continue;
        try {
          for (const ev of line.events) this.apply(sess, ev, line.at);
        } catch {
          // A line the validator now refuses was accepted by an older server.
          // What it recorded up to here stands.
        }
        sess.seq++;
        sess.lastSeen = line.at;
        if (!sess.ips.includes(line.ip)) sess.ips.push(line.ip);
      }
      if (sess) {
        // Runs ended before the restart were sealed then; a run whose seal is
        // missing is sealed now.
        for (const run of sess.runs) {
          if (run.ended && !this.index.has(runId(sess.id, run.run))) this.seal(sess, run, run.ended);
          else if (run.ended) run.sealed = true;
        }
        this.sessions.set(id, sess);
      }
    }
    if (this.sessions.size > 0) this.log(`recovered ${this.sessions.size} live session(s)`);
  }

  // ---- ingest ----------------------------------------------------------------

  ingest(rawBody: string, ip: string, cookiePid: string | null): IngestResult {
    const now = this.now();
    let batch: unknown;
    try {
      batch = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: "body is not JSON" }, pid: cookiePid ?? "" };
    }
    if (
      !isRecord(batch) ||
      !isStr(batch.session, 36) ||
      !UUID.test(batch.session) ||
      !isInt(batch.seq) ||
      !Array.isArray(batch.events) ||
      batch.events.length === 0 ||
      batch.events.length > MAX_EVENTS_PER_BATCH
    ) {
      return { status: 400, body: { error: "batch is not {session, seq, events[]}" }, pid: cookiePid ?? "" };
    }
    const b = batch as unknown as Batch;

    let sess = this.sessions.get(b.session);
    const isNew = !sess;
    if (!sess) {
      if (b.seq !== 0) return { status: 409, body: { expect: 0 }, pid: cookiePid ?? "" };
      const first = b.events[0];
      if (!isRecord(first) || first.t !== "start") {
        return { status: 400, body: { error: "a session begins with a start event" }, pid: cookiePid ?? "" };
      }
      const refused = this.refuseNewSession(ip, now);
      if (refused) return { status: refused.status, body: { error: refused.message }, pid: cookiePid ?? "" };
      const pid = this.resolveOrMintPlayer(cookiePid, ip, now);
      const month = monthOf(now);
      mkdirSync(this.path("sessions", month), { recursive: true });
      sess = {
        id: b.session,
        pid,
        ips: [],
        meta: null,
        seq: 0,
        runs: [],
        startedAt: now,
        lastSeen: now,
        log: this.path("sessions", month, `${b.session}.ndjson`),
      };
    } else if (b.seq !== sess.seq) {
      return { status: 409, body: { expect: sess.seq }, pid: sess.pid };
    }

    // Validate every event against a copy of the state before touching the
    // real one, so a refused batch leaves the session exactly as it was.
    const trial: LiveSession = { ...sess, runs: sess.runs.map((r) => ({ ...r })), ips: [...sess.ips] };
    const ended: LiveRun[] = [];
    try {
      for (const ev of b.events) {
        const done = this.apply(trial, ev, now);
        if (done) ended.push(done);
      }
    } catch (e) {
      const status = e instanceof Refusal ? e.status : 400;
      return { status, body: { error: e instanceof Error ? e.message : String(e) }, pid: sess.pid };
    }

    const line: LogLine = { seq: b.seq, at: now, ip, pid: sess.pid, events: b.events };
    appendFileSync(sess.log, JSON.stringify(line) + "\n");

    trial.seq = b.seq + 1;
    trial.lastSeen = now;
    if (!trial.ips.includes(ip)) trial.ips.push(ip);
    this.sessions.set(b.session, trial);
    this.touchPlayer(trial.pid, ip, now, isNew ? 1 : 0);
    for (const run of ended) this.seal(trial, trial.runs[run.run]!, run.ended!);
    return { status: 200, body: { ack: b.seq }, pid: trial.pid };
  }

  private refuseNewSession(ip: string, now: number): Refusal | null {
    const free = this.freeBytes();
    if (free !== null && free < MIN_FREE_BYTES) return new Refusal(507, "store is out of space");
    const recent = (this.newSessionTimes.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= NEW_SESSIONS_PER_IP_PER_HOUR) return new Refusal(429, "too many new sessions from this address");
    recent.push(now);
    this.newSessionTimes.set(ip, recent);
    return null;
  }

  // One event against the session's state. Returns the run it ended, if any.
  private apply(sess: LiveSession, ev: unknown, at: number): LiveRun | null {
    if (!isRecord(ev) || typeof ev.t !== "string") throw new Refusal(400, "event is not an object with t");
    const current = sess.runs[sess.runs.length - 1];
    switch (ev.t) {
      case "start": {
        if (sess.meta || sess.seq !== 0) throw new Refusal(400, "start: session already started");
        sess.meta = validateMeta(ev.meta);
        return null;
      }
      case "run": {
        if (!sess.meta) throw new Refusal(400, "run: before start");
        if (!isInt(ev.run) || ev.run !== sess.runs.length) throw new Refusal(400, `run: expected run ${sess.runs.length}`);
        if (current && !current.ended) throw new Refusal(400, "run: previous run has not ended");
        if (!isStr(ev.level, 64) || !isInt(ev.heldAtStart) || ev.heldAtStart >= HELD_MASK_LIMIT) {
          throw new Refusal(400, "run: bad level or heldAtStart");
        }
        sess.runs.push({ run: ev.run, level: ev.level, heldAtStart: ev.heldAtStart, frames: 0, startedAt: at, ended: null, sealed: false });
        return null;
      }
      case "frames": {
        if (!current || current.ended || ev.run !== current.run) throw new Refusal(400, "frames: no open run");
        if (!isInt(ev.from) || ev.from !== current.frames) throw new Refusal(400, `frames: expected from ${current.frames}`);
        if (!Array.isArray(ev.frames) || ev.frames.length === 0 || ev.frames.length > MAX_FRAMES_PER_EVENT) {
          throw new Refusal(400, "frames: bad frame list");
        }
        if (current.frames + ev.frames.length > MAX_RUN_FRAMES) throw new Refusal(400, "frames: run is over the length cap");
        for (const f of ev.frames) validateFrame(f);
        current.frames += ev.frames.length;
        return null;
      }
      case "digest": {
        if (!current || current.ended || ev.run !== current.run) throw new Refusal(400, "digest: no open run");
        const w = ev.world;
        if (!isRecord(w) || !isInt(w.frame, 1) || w.frame > current.frames || !Array.isArray(w.bodies)) {
          throw new Refusal(400, "digest: bad world digest");
        }
        return null;
      }
      case "end": {
        if (!current || current.ended || ev.run !== current.run) throw new Refusal(400, "end: no open run");
        if (ev.frames !== current.frames) throw new Refusal(400, `end: expected ${current.frames} frames`);
        if (typeof ev.reason !== "string" || !END_REASONS.has(ev.reason as EndReason)) throw new Refusal(400, "end: bad reason");
        current.ended = ev.reason as EndReason;
        return current;
      }
      default:
        throw new Refusal(400, `unknown event ${ev.t}`);
    }
  }

  // ---- players ---------------------------------------------------------------

  private canonical(pid: string): string | null {
    if (this.players[pid]) return pid;
    return this.aliasOf.get(pid) ?? null;
  }

  private resolveOrMintPlayer(cookiePid: string | null, ip: string, now: number): string {
    // A cookie the store does not know is not trusted: it is minted fresh, and
    // the address will say whether it was someone we know.
    const known = cookiePid && UUID.test(cookiePid) ? this.canonical(cookiePid) : null;
    if (known) return known;
    const id = randomUUID();
    const probably = Object.values(this.players)
      .filter((p) => p.ips[ip] && now - p.ips[ip]!.last < SAME_ADDRESS_WINDOW_MS)
      .map((p) => p.id);
    this.players[id] = { id, name: null, aliases: [], ips: {}, sessions: 0, firstSeen: now, lastSeen: now, probably };
    return id;
  }

  private touchPlayer(pid: string, ip: string, now: number, newSessions: number): void {
    const p = this.players[pid];
    if (!p) return;
    const seen = p.ips[ip];
    const changed = !seen || newSessions > 0;
    p.ips[ip] = { first: seen?.first ?? now, last: now };
    p.lastSeen = now;
    p.sessions += newSessions;
    if (changed) this.savePlayers();
  }

  // ---- sealing ---------------------------------------------------------------

  private readLog(sess: LiveSession): LogLine[] {
    if (!existsSync(sess.log)) return [];
    const lines: LogLine[] = [];
    for (const text of readFileSync(sess.log, "utf8").split("\n")) {
      if (!text) continue;
      try {
        lines.push(JSON.parse(text) as LogLine);
      } catch {
        // A torn last line from a crash mid-append; the batch it held was never
        // acknowledged, so the client still has it.
      }
    }
    return lines;
  }

  private seal(sess: LiveSession, run: LiveRun, reason: EndReason): void {
    if (run.sealed || !sess.meta) return;
    const frames: SerializedFrame[] = [];
    const worldDigests: WorldDigest[] = [];
    let startedAt = run.startedAt;
    let endedAt = this.now();
    for (const line of this.readLog(sess)) {
      for (const ev of line.events) {
        if (!("run" in ev) || ev.run !== run.run) continue;
        if (ev.t === "run") startedAt = line.at;
        else if (ev.t === "frames") {
          if (ev.from !== frames.length) {
            this.log(`seal ${runId(sess.id, run.run)}: frames out of order at ${ev.from}, have ${frames.length}`);
            return;
          }
          frames.push(...ev.frames);
        } else if (ev.t === "digest") worldDigests.push(ev.world);
        else if (ev.t === "end") endedAt = line.at;
      }
    }
    if (reason === "idle") endedAt = sess.lastSeen;
    const meta: RunMeta = {
      session: sess.id,
      run: run.run,
      player: sess.pid,
      nick: sess.meta.nick,
      ips: [...sess.ips],
      device: sess.meta.device,
      ua: sess.meta.ua,
      viewport: sess.meta.viewport,
      dpr: sess.meta.dpr,
      render: sess.meta.render,
      startedAt,
      endedAt,
      reason,
    };
    const rec: Recording = {
      level: run.level,
      git: sess.meta.commit,
      dirty: sess.meta.dirty,
      srcHash: sess.meta.srcHash,
      heldAtStart: run.heldAtStart,
      frames,
      worldDigests,
      meta,
    };
    const month = monthOf(startedAt);
    mkdirSync(this.path("runs", month), { recursive: true });
    const rel = join("runs", month, `${runId(sess.id, run.run)}.json.gz`);
    const gz = gzipSync(JSON.stringify(rec));
    writeAtomic(this.path(rel), gz);
    run.ended = reason;
    run.sealed = true;
    const row = this.rowFor(rec, rel, gz.length)!;
    this.index.set(row.id, row);
    this.saveIndex();
    this.enqueueVerify(row.id);
  }

  private enqueueVerify(id: string): void {
    if (!this.verifier) return;
    this.verifyQueue.push(id);
    void this.drainVerify();
  }

  private async drainVerify(): Promise<void> {
    if (this.verifying) return;
    this.verifying = true;
    try {
      while (this.verifyQueue.length > 0) {
        const id = this.verifyQueue.shift()!;
        const row = this.index.get(id);
        if (!row) continue;
        try {
          const verdict = await this.verifier!(this.path(row.file));
          // The row may have been deleted while the replay ran.
          const current = this.index.get(id);
          if (current && verdict) {
            current.verdict = verdict;
            this.saveIndex();
          }
        } catch (e) {
          this.log(`verify ${id}: ${String(e)}`);
        }
      }
    } finally {
      this.verifying = false;
    }
  }

  // Wait for every queued verification. For the cases; production never needs to.
  async settled(): Promise<void> {
    while (this.verifying || this.verifyQueue.length > 0) await new Promise((r) => setTimeout(r, 5));
  }

  // ---- the sweeper -----------------------------------------------------------

  sweep(): { sealed: string[]; forgotten: number; expired: number; purged: number } {
    const now = this.now();
    const sealed: string[] = [];
    let forgotten = 0;
    for (const sess of [...this.sessions.values()]) {
      if (now - sess.lastSeen < IDLE_SEAL_MS) continue;
      for (const run of sess.runs) {
        if (!run.ended) {
          this.seal(sess, run, "idle");
          sealed.push(runId(sess.id, run.run));
        }
      }
      rmSync(sess.log, { force: true });
      this.sessions.delete(sess.id);
      forgotten++;
    }
    let expired = 0;
    for (const row of [...this.index.values()]) {
      if (now - row.endedAt > RUN_TTL_MS && this.deleteRun(row.id)) expired++;
    }
    let purged = 0;
    for (const file of walk(this.path("trash"), ".json.gz")) {
      const stamp = Number(file.slice(file.lastIndexOf("/") + 1).split("-")[0]);
      if (Number.isFinite(stamp) && now - stamp > TRASH_TTL_MS) {
        rmSync(file, { force: true });
        purged++;
      }
    }
    return { sealed, forgotten, expired, purged };
  }

  // ---- admin -----------------------------------------------------------------

  private freeBytes(): number | null {
    try {
      const s = statfsSync(this.dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }

  adminIndex(): AdminIndex {
    const live: LiveRow[] = [];
    for (const sess of this.sessions.values()) {
      const run = sess.runs[sess.runs.length - 1];
      live.push({
        session: sess.id,
        player: sess.pid,
        nick: sess.meta?.nick ?? null,
        level: run?.level ?? sess.meta?.level ?? "",
        run: run?.run ?? -1,
        frames: run?.frames ?? 0,
        startedAt: sess.startedAt,
        lastSeen: sess.lastSeen,
        ip: sess.ips[sess.ips.length - 1] ?? null,
      });
    }
    let runBytes = 0;
    for (const row of this.index.values()) runBytes += row.bytes;
    let trashBytes = 0;
    for (const f of walk(this.path("trash"), ".json.gz")) trashBytes += statSync(f).size;
    return {
      runs: [...this.index.values()].sort((a, b) => b.startedAt - a.startedAt),
      players: this.players,
      annotations: this.annotations,
      live: live.sort((a, b) => b.lastSeen - a.lastSeen),
      storage: { runs: this.index.size, runBytes, trashBytes, freeBytes: this.freeBytes() },
      here: this.here,
    };
  }

  hasRun(id: string): boolean {
    return RUN_ID.test(id) && this.index.has(id);
  }

  // The sealed bundle, gzipped as stored.
  readRunGz(id: string): Uint8Array | null {
    const row = this.index.get(id);
    if (!row || !RUN_ID.test(id)) return null;
    return readFileSync(this.path(row.file));
  }

  readRun(id: string): string | null {
    const gz = this.readRunGz(id);
    return gz ? gunzipSync(gz).toString("utf8") : null;
  }

  deleteRun(id: string): boolean {
    const row = this.index.get(id);
    if (!row) return false;
    const dest = this.path("trash", `${this.now()}-${id}.json.gz`);
    if (existsSync(this.path(row.file))) renameSync(this.path(row.file), dest);
    this.index.delete(id);
    if (this.annotations[id]) {
      delete this.annotations[id];
      this.saveAnnotations();
    }
    this.saveIndex();
    return true;
  }

  annotate(id: string, patch: { starred?: boolean; note?: string }): Annotation | null {
    if (!this.index.has(id)) return null;
    const a = this.annotations[id] ?? { starred: false, note: "" };
    if (typeof patch.starred === "boolean") a.starred = patch.starred;
    if (typeof patch.note === "string") a.note = patch.note.slice(0, 2000);
    if (!a.starred && a.note === "") delete this.annotations[id];
    else this.annotations[id] = a;
    this.saveAnnotations();
    return a;
  }

  renamePlayer(id: string, name: string | null): Player | null {
    const p = this.players[id];
    if (!p) return null;
    p.name = name ? name.trim().slice(0, 40) || null : null;
    this.savePlayers();
    return p;
  }

  // `from` becomes an alias of `into`: sessions carrying either cookie land on
  // `into`, and every run and live session of `from` is re-attributed.
  mergePlayers(into: string, from: string): Player | null {
    const a = this.players[into];
    const b = this.players[from];
    if (!a || !b || into === from) return null;
    a.aliases.push(from, ...b.aliases);
    for (const [ip, seen] of Object.entries(b.ips)) {
      const mine = a.ips[ip];
      a.ips[ip] = { first: Math.min(mine?.first ?? seen.first, seen.first), last: Math.max(mine?.last ?? seen.last, seen.last) };
    }
    a.sessions += b.sessions;
    a.firstSeen = Math.min(a.firstSeen, b.firstSeen);
    a.lastSeen = Math.max(a.lastSeen, b.lastSeen);
    a.probably = a.probably.filter((id) => id !== from);
    if (!a.name && b.name) a.name = b.name;
    delete this.players[from];
    for (const alias of [from, ...b.aliases]) this.aliasOf.set(alias, into);
    for (const p of Object.values(this.players)) p.probably = p.probably.filter((id) => id !== from);
    let rows = false;
    for (const row of this.index.values()) {
      if (row.player === from) {
        row.player = into;
        rows = true;
      }
    }
    for (const sess of this.sessions.values()) if (sess.pid === from) sess.pid = into;
    this.savePlayers();
    if (rows) this.saveIndex();
    return a;
  }

  // The player and everything attributed to them: their runs to trash, their
  // live sessions forgotten, their addresses gone.
  deletePlayer(id: string): number {
    if (!this.players[id]) return -1;
    let n = 0;
    for (const row of [...this.index.values()]) {
      if (row.player === id && this.deleteRun(row.id)) n++;
    }
    for (const sess of [...this.sessions.values()]) {
      if (sess.pid === id) {
        rmSync(sess.log, { force: true });
        this.sessions.delete(sess.id);
      }
    }
    for (const alias of this.players[id]!.aliases) this.aliasOf.delete(alias);
    delete this.players[id];
    for (const p of Object.values(this.players)) p.probably = p.probably.filter((x) => x !== id);
    this.savePlayers();
    return n;
  }

  // For the cases.
  liveSessionCount(): number {
    return this.sessions.size;
  }
}
