// WebSocket message protocol shared between the two players. The server relays
// these verbatim (adding a `from` slot). Presence messages (cursor/aim) are
// fire-and-forget; `shot` and `sync` carry authoritative state transitions.

import type { PhysicsConfig, Shot, Vec } from "./physics";
import type { PlayerProfile } from "./profile";

export type AimPresence = {
  angle: number;
  power: number;
  follow: number;
  side: number;
  elevation: number;
  cue: Vec; // cue ball position (matters during ball-in-hand dragging)
};

// One recorded shot (matches ReplayShot). The server keeps an ordered log of
// these per room so a rejoining peer can rebuild the whole game deterministically.
export type LoggedShot = { shot: Shot; place?: Vec; config?: PhysicsConfig };

export type SyncSnapshot = {
  // Full state a host sends to a peer that just joined.
  balls: { id: number; x: number; y: number; potted: boolean }[];
  rules: unknown; // RulesState, kept opaque here to avoid a cycle
  breaker: 0 | 1;
  shotCount: number; // count of *resolved* shots — the receiver adopts only a strictly-newer snapshot
  config: PhysicsConfig;
};

export type Msg =
  | { t: "hello"; slot: number; id: string; peers: { slot: number; id: string }[] }
  | { t: "peer-join"; slot: number; id: string; from?: number }
  | { t: "peer-leave"; slot: number; id: string; from?: number }
  // A player's chosen identity (name / cue colour / emoji). Broadcast on join and
  // re-sent whenever a new peer arrives, so every table can label the banner and
  // colour each cue. Fire-and-forget presence keyed by the sender's slot.
  | { t: "profile"; profile: PlayerProfile; from?: number }
  | { t: "sync"; to: number; snap: SyncSnapshot; from?: number }
  | { t: "need-sync"; from?: number }
  | { t: "cursor"; x: number; y: number; from?: number }
  | { t: "aim"; aim: AimPresence; from?: number }
  // Live table annotation by the *waiting* player during the opponent's turn: a
  // pointing finger + dragged dotted paths shown on the shooter's table. World
  // coords (m). `start` opens a stroke, `move` extends it, `end` releases it (the
  // receiver keeps it visible 5s, then drops it). Fire-and-forget presence.
  | { t: "draw"; phase: "start" | "move" | "end"; x?: number; y?: number; from?: number }
  // A dragged-out emoji stamp: spawns a temporary animated emoji on the other
  // table at world (x,y). Fire-and-forget presence.
  | { t: "emoji"; ch: string; x: number; y: number; from?: number }
  | { t: "shot"; shot: Shot; place?: Vec; config: PhysicsConfig; from?: number }
  | { t: "config"; config: PhysicsConfig; from?: number }
  | { t: "rematch"; breaker: 0 | 1; config: PhysicsConfig; from?: number }
  // A player pressed rematch on the game-over screen. Both participants must vote
  // before the room resets; fire-and-forget, keyed by the sender's slot.
  | { t: "rematch-vote"; from?: number }
  | { t: "resign"; winner: 0 | 1; from?: number }
  // A game just started: the server stores this as the log baseline (initial rack
  // + breaker + config) and clears the shot log.
  | {
      t: "game-init";
      initial: { id: number; x: number; y: number }[];
      breaker: 0 | 1;
      config: PhysicsConfig;
      from?: number;
    }
  // Server → a (re)joining socket: the full game log, so it can rebuild exactly.
  | {
      t: "shot-log";
      initial: { id: number; x: number; y: number }[];
      breaker: 0 | 1;
      config: PhysicsConfig;
      shots: LoggedShot[];
      to?: number;
      from?: number;
    };

export function wsUrl(room: string): string {
  const base = import.meta.env.PROD
    ? `${location.protocol.replace("http", "ws")}//${location.host}`
    : "ws://localhost:8080";
  return `${base}/ws?id=${encodeURIComponent(room)}`;
}

/** HTTP origin of the game server (same host in prod, the relay in dev). */
function apiBase(): string {
  return import.meta.env.PROD ? location.origin : "http://localhost:8080";
}

export type RoomInfo = { code: string; created: number };

/** The lobby: games with a single player waiting for an opponent. */
export async function fetchRooms(): Promise<RoomInfo[]> {
  try {
    const res = await fetch(`${apiBase()}/rooms`);
    return res.ok ? ((await res.json()) as RoomInfo[]) : [];
  } catch {
    return [];
  }
}
