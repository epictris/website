// Match replays. Stored entirely on the client and downloaded as JSON — never
// sent to the server. A replay is the initial rack plus the ordered list of
// shots (with any ball-in-hand placement). Because the engine is deterministic,
// re-applying those shots reproduces the whole match exactly.

import type { Ball, PhysicsConfig, Shot, Vec, World } from "./physics";
import { cloneWorld, DEFAULT_CONFIG } from "./physics";

export type ReplayShot = { shot: Shot; place?: Vec; config?: PhysicsConfig };

export type Replay = {
  version: 1;
  createdAt: string;
  breaker: 0 | 1;
  table: { w: number; h: number };
  config: PhysicsConfig;
  initial: { id: number; x: number; y: number }[];
  shots: ReplayShot[];
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
): Replay {
  return {
    version: 1,
    createdAt: nowIso(),
    breaker,
    table,
    config,
    initial: snapshotInitial(cloneWorld(initial)),
    shots: [...shots],
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
