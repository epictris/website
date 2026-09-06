// The playtest store's cases (`cli playtest`): ingest sequencing, players and
// addresses, sealing on end and on idle, deletion and expiry, merging, and a
// restart mid-session. Every case runs against a fresh temporary directory
// with a clock it controls, and the frames it posts are real ones from a
// scripted ball run, so the sealed bundle can be replayed and its sparse
// digests compared the way `cli pull` will compare them.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  DIGEST_EVERY,
  IDLE_SEAL_MS,
  INGEST_PATH,
  MAX_BODY_BYTES,
  type PlaytestEvent,
  type SessionMeta,
} from "../playtest/protocol";
import { runScript } from "../sim/playtest";
import { replayRecording } from "../sim/replay";
import { verifySelfReplay } from "../sim/selfReplay";
import type { Recording, SerializedFrame, WorldDigest } from "../sim/trace";
import { handlePlaytest } from "./routes";
import { PlaytestStore, type Verdict } from "./store";

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const META: SessionMeta = {
  commit: "abc1234",
  dirty: false,
  srcHash: "0123456789ab",
  level: "BALL",
  nick: "sam",
  device: "mouse",
  ua: "storeCases",
  viewport: { w: 1280, h: 720 },
  dpr: 1,
  render: "2d",
};

const SESSION_A = "11111111-2222-4333-8444-555555555555";
const SESSION_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const SESSION_C = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

// A real ball run: the chain deployed straight up for three seconds. Its dense
// world digests are thinned to the cadence the page records at.
function scenario(): { frames: SerializedFrame[]; digests: WorldDigest[] } {
  const r = runScript({
    level: "BALL",
    controller: "ball",
    frames: 180,
    holds: [{ action: "deploy", from: 5, to: 180 }],
    aim: [{ from: 1, to: 180, x: 0, y: -1, relative: true }],
  });
  const digests = r.worldDigests.filter((_, i) => (i + 1) % DIGEST_EVERY === 0 || i === r.worldDigests.length - 1);
  return { frames: r.serializedFrames, digests };
}

// The events one run produces, in the order the recorder emits them, as the
// batches it would send: `run` (and `start` for a first run) then a frames
// event per second with its digest, then `end`.
function runBatches(
  frames: SerializedFrame[],
  digests: WorldDigest[],
  run: number,
  reason: "reset" | "kill" | "unload" | "pause" = "reset",
  withStart = run === 0,
): PlaytestEvent[][] {
  const batches: PlaytestEvent[][] = [];
  let head: PlaytestEvent[] = [];
  if (withStart) head.push({ t: "start", meta: META });
  head.push({ t: "run", run, level: "BALL", heldAtStart: 0 });
  for (let from = 0; from < frames.length; from += DIGEST_EVERY) {
    const chunk = frames.slice(from, from + DIGEST_EVERY);
    head.push({ t: "frames", run, from, frames: chunk });
    const d = digests.find((w) => w.frame === from + chunk.length);
    if (d) head.push({ t: "digest", run, world: d });
    batches.push(head);
    head = [];
  }
  head.push({ t: "end", run, frames: frames.length, reason });
  batches.push(head);
  return batches;
}

function loadGz(file: string): Recording {
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Recording;
}

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), "rope-playtest-"));
  t = Date.parse("2026-09-06T12:00:00Z");
  store: PlaytestStore;

  constructor() {
    this.store = this.open();
  }

  open(): PlaytestStore {
    return new PlaytestStore({
      dir: this.dir,
      here: { commit: "abc1234", srcHash: "0123456789ab" },
      now: () => this.t,
      verify: async (file): Promise<Verdict> => {
        const v = verifySelfReplay(loadGz(file));
        return { identical: v.identical, firstDivergence: v.firstDivergence };
      },
    });
  }

  post(session: string, seq: number, events: PlaytestEvent[], ip = "203.0.113.7", pid: string | null = null) {
    return this.store.ingest(JSON.stringify({ session, seq, events }), ip, pid);
  }

  // Post every batch of a run in order, returning the pid the store answered with.
  play(session: string, batches: PlaytestEvent[][], ip = "203.0.113.7", pid: string | null = null, seq0 = 0): string {
    let p = pid;
    batches.forEach((events, i) => {
      const r = this.post(session, seq0 + i, events, ip, p);
      if (r.status !== 200) throw new Error(`batch ${seq0 + i} refused: ${r.status} ${JSON.stringify(r.body)}`);
      p = r.pid;
    });
    return p!;
  }

  runFiles(): string[] {
    const out: string[] = [];
    const runs = join(this.dir, "runs");
    if (!existsSync(runs)) return out;
    for (const month of readdirSync(runs)) for (const f of readdirSync(join(runs, month))) out.push(join(runs, month, f));
    return out.sort();
  }

  close(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

type Case = (h: Harness, s: { frames: SerializedFrame[]; digests: WorldDigest[] }) => Promise<string> | string;

const CASES: Record<string, Case> = {
  "in-order batches are acked and the run seals on end": async (h, s) => {
    const batches = runBatches(s.frames, s.digests, 0);
    for (let i = 0; i < batches.length; i++) {
      const r = h.post(SESSION_A, i, batches[i]!);
      if (r.status !== 200 || (r.body as { ack: number }).ack !== i) throw new Error(`batch ${i}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const files = h.runFiles();
    if (files.length !== 1 || !files[0]!.endsWith(`${SESSION_A}-r0.json.gz`)) throw new Error(`sealed files: ${files.join(", ")}`);
    const rec = loadGz(files[0]!);
    if (rec.frames.length !== s.frames.length) throw new Error(`sealed ${rec.frames.length} frames, sent ${s.frames.length}`);
    if (rec.worldDigests?.length !== s.digests.length) throw new Error(`sealed ${rec.worldDigests?.length} digests, sent ${s.digests.length}`);
    if (rec.meta?.reason !== "reset" || rec.meta.nick !== "sam" || rec.git !== "abc1234") throw new Error(`meta: ${JSON.stringify(rec.meta)}`);
    return `${rec.frames.length} frames, ${rec.worldDigests.length} digests, ${files[0]!.slice(h.dir.length + 1)}`;
  },

  "a sealed run replays bit-exact on its sparse digests and the verdict lands in the index": async (h, s) => {
    h.play(SESSION_A, runBatches(s.frames, s.digests, 0));
    await h.store.settled();
    const rec = loadGz(h.runFiles()[0]!);
    const r = replayRecording(rec);
    if (r.worldComparedFrames !== s.digests.length) throw new Error(`compared ${r.worldComparedFrames} frames, expected ${s.digests.length}`);
    if (r.worldBitDivergedAtFrame !== null) throw new Error(`world diverged @f${r.worldBitDivergedAtFrame} on ${r.worldMaxDriftName}`);
    const row = h.store.adminIndex().runs[0]!;
    if (!row.verdict?.identical) throw new Error(`verdict: ${JSON.stringify(row.verdict)}`);
    return `compared ${r.worldComparedFrames} digests, verdict identical`;
  },

  "a repeated batch and a gap are both answered 409 with the expected seq": (h, s) => {
    const batches = runBatches(s.frames, s.digests, 0);
    h.post(SESSION_A, 0, batches[0]!);
    h.post(SESSION_A, 1, batches[1]!);
    const again = h.post(SESSION_A, 1, batches[1]!);
    const gap = h.post(SESSION_A, 3, batches[3]!);
    const stranger = h.post(SESSION_B, 2, batches[2]!);
    if (again.status !== 409 || (again.body as { expect: number }).expect !== 2) throw new Error(`repeat: ${again.status} ${JSON.stringify(again.body)}`);
    if (gap.status !== 409 || (gap.body as { expect: number }).expect !== 2) throw new Error(`gap: ${gap.status} ${JSON.stringify(gap.body)}`);
    if (stranger.status !== 409 || (stranger.body as { expect: number }).expect !== 0) throw new Error(`unknown session: ${stranger.status}`);
    const resumed = h.post(SESSION_A, 2, batches[2]!);
    if (resumed.status !== 200) throw new Error(`resume: ${resumed.status}`);
    return "repeat -> 409 expect 2, gap -> 409 expect 2, unknown session -> 409 expect 0, resume -> 200";
  },

  "a malformed frame is refused and leaves the session untouched": (h, s) => {
    const batches = runBatches(s.frames, s.digests, 0);
    h.post(SESSION_A, 0, batches[0]!);
    const bad = h.post(SESSION_A, 1, [{ t: "frames", run: 0, from: 60, frames: [{ h: 1, mx: Number.NaN, my: 0 } as SerializedFrame] }]);
    if (bad.status !== 400) throw new Error(`bad frame: ${bad.status}`);
    const wrongFrom = h.post(SESSION_A, 1, [{ t: "frames", run: 0, from: 61, frames: s.frames.slice(61, 62) }]);
    if (wrongFrom.status !== 400) throw new Error(`wrong from: ${wrongFrom.status}`);
    const ok = h.post(SESSION_A, 1, batches[1]!);
    if (ok.status !== 200) throw new Error(`after refusal: ${ok.status} ${JSON.stringify(ok.body)}`);
    return "NaN aim -> 400, wrong from -> 400, correct batch 1 still accepted";
  },

  "a new browser is minted a player id, the cookie is honoured next time, an unknown cookie is not": (h, s) => {
    const pid = h.play(SESSION_A, runBatches(s.frames, s.digests, 0));
    if (!/^[0-9a-f-]{36}$/.test(pid)) throw new Error(`pid: ${pid}`);
    const same = h.play(SESSION_B, runBatches(s.frames, s.digests, 0), "203.0.113.7", pid);
    if (same !== pid) throw new Error(`cookie ${pid} answered ${same}`);
    const forged = h.play(SESSION_C, runBatches(s.frames, s.digests, 0), "203.0.113.7", "00000000-0000-4000-8000-000000000000");
    if (forged === pid || forged === "00000000-0000-4000-8000-000000000000") throw new Error(`forged cookie answered ${forged}`);
    const players = h.store.adminIndex().players;
    if (players[pid]?.sessions !== 2) throw new Error(`sessions: ${players[pid]?.sessions}`);
    if (!players[forged]?.probably.includes(pid)) throw new Error(`probably: ${JSON.stringify(players[forged]?.probably)}`);
    return `pid honoured across sessions (2 counted); forged cookie minted ${forged.slice(0, 8)} flagged probably ${pid.slice(0, 8)}`;
  },

  "addresses accumulate across a session and land in the sealed meta": (h, s) => {
    const batches = runBatches(s.frames, s.digests, 0);
    let pid: string | null = null;
    batches.forEach((events, i) => {
      pid = h.post(SESSION_A, i, events, i < 2 ? "203.0.113.7" : "198.51.100.9", pid).pid;
    });
    const rec = loadGz(h.runFiles()[0]!);
    if (rec.meta?.ips.join(",") !== "203.0.113.7,198.51.100.9") throw new Error(`ips: ${rec.meta?.ips.join(",")}`);
    const player = h.store.adminIndex().players[pid!]!;
    if (!player.ips["203.0.113.7"] || !player.ips["198.51.100.9"]) throw new Error(`player ips: ${Object.keys(player.ips)}`);
    return `meta.ips = ${rec.meta.ips.join(", ")}`;
  },

  "a session that goes quiet is sealed as idle by the sweep and forgotten": (h, s) => {
    const batches = runBatches(s.frames, s.digests, 0);
    // Everything but the end: the tab closed without a pagehide reaching us.
    h.play(SESSION_A, batches.slice(0, -1));
    h.t += IDLE_SEAL_MS - 1000;
    let r = h.store.sweep();
    if (r.sealed.length !== 0 || h.store.liveSessionCount() !== 1) throw new Error("sealed early");
    h.t += 2000;
    r = h.store.sweep();
    if (r.sealed.length !== 1 || r.forgotten !== 1 || h.store.liveSessionCount() !== 0) throw new Error(`sweep: ${JSON.stringify(r)}`);
    const rec = loadGz(h.runFiles()[0]!);
    if (rec.meta?.reason !== "idle" || rec.frames.length !== s.frames.length) throw new Error(`sealed: ${rec.meta?.reason} ${rec.frames.length}f`);
    if (existsSync(join(h.dir, "sessions", "2026-09", `${SESSION_A}.ndjson`))) throw new Error("session log kept");
    const late = h.post(SESSION_A, batches.length - 1, batches[batches.length - 1]!);
    if (late.status !== 409) throw new Error(`late batch: ${late.status}`);
    return `idle after ${IDLE_SEAL_MS / 60000} min -> sealed idle with all ${rec.frames.length} frames, log removed, late batch 409`;
  },

  "two runs in one session seal separately, the second from the frame the reset left held": (h, s) => {
    const first = runBatches(s.frames, s.digests, 0, "kill");
    const second = runBatches(s.frames, s.digests, 1, "reset", false);
    second[0]![0] = { t: "run", run: 1, level: "BALL", heldAtStart: 4 };
    h.play(SESSION_A, [...first, ...second]);
    const files = h.runFiles();
    if (files.length !== 2) throw new Error(`files: ${files.length}`);
    const a = loadGz(files[0]!);
    const b = loadGz(files[1]!);
    if (a.meta?.reason !== "kill" || b.meta?.reason !== "reset") throw new Error(`reasons ${a.meta?.reason} ${b.meta?.reason}`);
    if (b.heldAtStart !== 4 || a.heldAtStart !== 0) throw new Error(`heldAtStart ${a.heldAtStart} ${b.heldAtStart}`);
    const early = h.post(SESSION_B, 0, [{ t: "start", meta: META }, { t: "run", run: 0, level: "BALL", heldAtStart: 0 }, { t: "run", run: 1, level: "BALL", heldAtStart: 0 }]);
    if (early.status !== 400) throw new Error(`run before end: ${early.status}`);
    return "r0 kill, r1 reset with heldAtStart 4; a run opened over an open run -> 400";
  },

  "delete moves a run to trash, the sweep purges trash after 30 days and expires runs after 90": (h, s) => {
    h.play(SESSION_A, runBatches(s.frames, s.digests, 0));
    h.play(SESSION_B, runBatches(s.frames, s.digests, 0));
    const [a, b] = h.store.adminIndex().runs.map((r) => r.id);
    if (!h.store.deleteRun(a!)) throw new Error("delete returned false");
    const trash = readdirSync(join(h.dir, "trash"));
    if (trash.length !== 1 || h.runFiles().length !== 1 || h.store.hasRun(a!)) throw new Error(`after delete: trash ${trash.length}, runs ${h.runFiles().length}`);
    h.t += 29 * 24 * 3600 * 1000;
    if (h.store.sweep().purged !== 0) throw new Error("purged early");
    h.t += 2 * 24 * 3600 * 1000;
    if (h.store.sweep().purged !== 1 || readdirSync(join(h.dir, "trash")).length !== 0) throw new Error("not purged at 31 days");
    h.t += 61 * 24 * 3600 * 1000;
    const r = h.store.sweep();
    if (r.expired !== 1 || h.store.hasRun(b!) || readdirSync(join(h.dir, "trash")).length !== 1) throw new Error(`expiry: ${JSON.stringify(r)}`);
    return "deleted -> trash; purged at 31 d; the other run expired to trash at 92 d";
  },

  "merging players re-attributes runs and makes the old cookie resolve to the survivor": (h, s) => {
    const p1 = h.play(SESSION_A, runBatches(s.frames, s.digests, 0));
    const p2 = h.play(SESSION_B, runBatches(s.frames, s.digests, 0), "198.51.100.9");
    h.store.renamePlayer(p2, "Sam");
    const merged = h.store.mergePlayers(p1, p2);
    if (!merged || !merged.aliases.includes(p2) || merged.name !== "Sam" || merged.sessions !== 2) throw new Error(`merged: ${JSON.stringify(merged)}`);
    const idx = h.store.adminIndex();
    if (idx.players[p2]) throw new Error("absorbed player still listed");
    if (!idx.runs.every((r) => r.player === p1)) throw new Error("a run still names the absorbed id");
    const back = h.play(SESSION_C, runBatches(s.frames, s.digests, 0), "198.51.100.9", p2);
    if (back !== p1) throw new Error(`alias cookie answered ${back}`);
    return `alias ${p2.slice(0, 8)} -> ${p1.slice(0, 8)}, 2 runs re-attributed, name kept`;
  },

  "deleting a player trashes their runs and forgets their live session": (h, s) => {
    const pid = h.play(SESSION_A, runBatches(s.frames, s.digests, 0));
    h.play(SESSION_B, runBatches(s.frames, s.digests, 0).slice(0, 2), "203.0.113.7", pid);
    const other = h.play(SESSION_C, runBatches(s.frames, s.digests, 0), "198.51.100.9");
    const n = h.store.deletePlayer(pid);
    const idx = h.store.adminIndex();
    // The other player's session stays live until the idle sweep; only the
    // deleted player's must be gone.
    const theirs = idx.live.filter((l) => l.player === pid).length;
    if (n !== 1 || idx.players[pid] || theirs !== 0 || idx.live.length !== 1 || idx.runs.length !== 1 || idx.runs[0]!.player !== other) {
      throw new Error(`deleted ${n}, players ${Object.keys(idx.players).length}, live ${idx.live.length} (${theirs} theirs), runs ${idx.runs.length}`);
    }
    return "1 run trashed, live session forgotten, the other player untouched";
  },

  "a restart mid-session recovers the live state from the log and takes the next batch": (h, s) => {
    const batches = runBatches(s.frames, s.digests, 0);
    const pid = h.play(SESSION_A, batches.slice(0, 2));
    h.store = h.open();
    if (h.store.liveSessionCount() !== 1) throw new Error(`recovered ${h.store.liveSessionCount()} sessions`);
    const stale = h.post(SESSION_A, 1, batches[1]!, "203.0.113.7", pid);
    if (stale.status !== 409 || (stale.body as { expect: number }).expect !== 2) throw new Error(`stale after restart: ${stale.status}`);
    h.play(SESSION_A, batches.slice(2), "203.0.113.7", pid, 2);
    const rec = loadGz(h.runFiles()[0]!);
    if (rec.frames.length !== s.frames.length || rec.meta?.player !== pid) throw new Error(`sealed ${rec.frames.length}f for ${rec.meta?.player}`);
    return `recovered at seq 2, run sealed whole (${rec.frames.length}f) under the same player`;
  },

  "the routes set the pid cookie, refuse an oversize body and serve a run both ways": async (h, s) => {
    const ctx = { store: h.store, socketIp: "203.0.113.7", adminHtml: "<title>admin</title>" };
    const batches = runBatches(s.frames, s.digests, 0);
    const post = (seq: number, events: PlaytestEvent[], cookie?: string) =>
      handlePlaytest(
        new Request(`http://rope.test${INGEST_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.4", ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ session: SESSION_A, seq, events }),
        }),
        ctx,
      );
    const first = (await post(0, batches[0]!))!;
    const setCookie = first.headers.get("set-cookie") ?? "";
    const pid = /pid=([0-9a-f-]{36})/.exec(setCookie)?.[1];
    if (first.status !== 200 || !pid || !setCookie.includes("HttpOnly")) throw new Error(`first: ${first.status} ${setCookie}`);
    for (let i = 1; i < batches.length; i++) {
      const r = (await post(i, batches[i]!, `pid=${pid}`))!;
      if (r.status !== 200) throw new Error(`batch ${i}: ${r.status}`);
    }
    const big = (await handlePlaytest(
      new Request(`http://rope.test${INGEST_PATH}`, { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) }),
      ctx,
    ))!;
    if (big.status !== 413) throw new Error(`oversize: ${big.status}`);
    const index = (await (await handlePlaytest(new Request("http://rope.test/api/playtest/admin/index"), ctx))!.json()) as { runs: { id: string; ips: string[] }[] };
    if (index.runs.length !== 1 || index.runs[0]!.ips[0] !== "192.0.2.4") throw new Error(`index: ${JSON.stringify(index.runs)}`);
    const id = index.runs[0]!.id;
    const asJson = (await handlePlaytest(new Request(`http://rope.test/api/playtest/admin/runs/${id}`), ctx))!;
    const asGz = (await handlePlaytest(new Request(`http://rope.test/api/playtest/admin/runs/${id}/gz`), ctx))!;
    const rec = (await asJson.json()) as Recording;
    const gz = JSON.parse(gunzipSync(Buffer.from(await asGz.arrayBuffer())).toString("utf8")) as Recording;
    if (rec.frames.length !== s.frames.length || gz.frames.length !== s.frames.length) throw new Error("run bodies differ");
    const page = (await handlePlaytest(new Request("http://rope.test/admin"), ctx))!;
    if (!(await page.text()).includes("<title>admin</title>")) throw new Error("admin page not served");
    const missing = (await handlePlaytest(new Request("http://rope.test/api/playtest/admin/runs/nope-r0"), ctx))!;
    const passthrough = await handlePlaytest(new Request("http://rope.test/index.html"), ctx);
    if (missing.status !== 404 || passthrough !== null) throw new Error(`missing ${missing.status}, passthrough ${passthrough?.status}`);
    return `cookie set (${pid.slice(0, 8)}), forwarded address recorded, 413 on ${MAX_BODY_BYTES + 1} bytes, run served as json and gz`;
  },
};

export async function runStoreCases(): Promise<CaseResult[]> {
  const s = scenario();
  const results: CaseResult[] = [];
  for (const [name, fn] of Object.entries(CASES)) {
    const h = new Harness();
    try {
      results.push({ name, pass: true, detail: await fn(h, s) });
    } catch (e) {
      results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      h.close();
    }
  }
  return results;
}
