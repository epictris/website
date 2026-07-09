// Match replays. Stored entirely on the client and downloaded as JSON — never
// sent to the server. A replay is the initial rack plus the ordered list of
// shots (with any ball-in-hand placement). Because the engine is deterministic,
// re-applying those shots reproduces the whole match exactly.

import type { Ball, PhysicsConfig, Shot, Vec, World } from "./physics";
import { cloneWorld, DEFAULT_CONFIG } from "./physics";
import type { PlayerProfile } from "./profile";

export type ReplayShot = { shot: Shot; place?: Vec; config?: PhysicsConfig };

export type Replay = {
  version: 1;
  createdAt: string;
  breaker: 0 | 1;
  table: { w: number; h: number };
  config: PhysicsConfig;
  initial: { id: number; x: number; y: number }[];
  shots: ReplayShot[];
  // Each player's identity (name/emoji/cue colour), keyed by slot 0/1. Optional
  // so replays saved before this field still load (the UI falls back to generic
  // labels + default cue colours).
  players?: Partial<Record<0 | 1, PlayerProfile>>;
};

export function snapshotInitial(world: World): Replay["initial"] {
  return world.balls.map((b) => ({ id: b.id, x: b.p.x, y: b.p.y }));
}

export function worldFromInitial(initial: Replay["initial"]): World {
  const balls: Ball[] = initial.map((b) => ({
    id: b.id,
    p: { x: b.x, y: b.y },
    v: { x: 0, y: 0 },
    w: { x: 0, y: 0, z: 0 },
    potted: false,
  }));
  return { balls };
}

export function buildReplay(
  breaker: 0 | 1,
  initial: World,
  shots: ReplayShot[],
  table: { w: number; h: number },
  config: PhysicsConfig,
  players?: Partial<Record<0 | 1, PlayerProfile>>,
): Replay {
  return {
    version: 1,
    createdAt: nowIso(),
    breaker,
    table,
    config,
    initial: snapshotInitial(cloneWorld(initial)),
    shots: [...shots],
    players: players
      ? { 0: players[0], 1: players[1] }
      : undefined,
  };
}

// new Date() is fine in the browser; only workflow scripts forbid it.
function nowIso(): string {
  return new Date().toISOString();
}

export function downloadReplay(replay: Replay) {
  const blob = new Blob([JSON.stringify(replay, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = replay.createdAt.replace(/[:.]/g, "-");
  a.href = url;
  a.download = `pool-replay-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Hand-off slot for "load replay" on the Landing menu: the file is parsed there,
// stashed here, then the fresh Game route consumes it on mount (there is no live
// Game to call loadReplay on from the landing page).
let pending: Replay | null = null;
export function setPendingReplay(r: Replay) {
  pending = r;
}
export function takePendingReplay(): Replay | null {
  const r = pending;
  pending = null;
  return r;
}

export function parseReplay(text: string): Replay {
  const r = JSON.parse(text) as Replay;
  if (r.version !== 1 || !Array.isArray(r.shots) || !Array.isArray(r.initial)) {
    throw new Error("Not a valid pool replay file");
  }
  if (!r.config) r.config = DEFAULT_CONFIG; // tolerate pre-config replays
  return r;
}

// --- Local replay library ------------------------------------------------
// "Save replay" now stores into localStorage rather than downloading; the
// Landing menu lists what's saved, and each entry can still be exported to /
// imported from a JSON file. One key holds the whole (newest-first) list.
export type SavedReplay = { id: string; name: string; replay: Replay };

const STORE_KEY = "pool.replays";
const MAX_SAVED = 50; // cap the library so storage can't grow without bound

export function listReplays(): SavedReplay[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const a = JSON.parse(raw);
    if (!Array.isArray(a)) return [];
    // Keep only structurally-valid entries (tolerate hand-edited storage).
    return a.filter(
      (e): e is SavedReplay =>
        e &&
        typeof e.id === "string" &&
        typeof e.name === "string" &&
        e.replay &&
        Array.isArray(e.replay.shots) &&
        Array.isArray(e.replay.initial),
    );
  } catch {
    return [];
  }
}

function writeReplays(list: SavedReplay[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* storage may be unavailable (private mode) — ignore */
  }
}

// A readable label from the replay's timestamp, e.g. "9 Jul 2026, 14:32".
export function defaultReplayName(r: Replay): string {
  const d = new Date(r.createdAt);
  if (isNaN(d.getTime())) return "Replay";
  const date = d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date}, ${time}`;
}

// Save newest-first; returns the stored entry.
export function saveReplayToStore(replay: Replay, name?: string): SavedReplay {
  const entry: SavedReplay = {
    id: crypto.randomUUID(),
    name: name?.trim() || defaultReplayName(replay),
    replay,
  };
  writeReplays([entry, ...listReplays()].slice(0, MAX_SAVED));
  return entry;
}

export function deleteReplay(id: string): void {
  writeReplays(listReplays().filter((e) => e.id !== id));
}
