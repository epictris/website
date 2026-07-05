// WebSocket message protocol shared between the two players. The server relays
// these verbatim (adding a `from` slot). Presence messages (cursor/aim) are
// fire-and-forget; `shot` and `sync` carry authoritative state transitions.

import type { PhysicsConfig, Shot, Vec } from "./physics";

export type AimPresence = {
  angle: number;
  power: number;
  follow: number;
  side: number;
  elevation: number;
  cue: Vec; // cue ball position (matters during ball-in-hand dragging)
};

export type SyncSnapshot = {
  // Full state a host sends to a peer that just joined.
  balls: { id: number; x: number; y: number; potted: boolean }[];
  rules: unknown; // RulesState, kept opaque here to avoid a cycle
  breaker: 0 | 1;
  shotCount: number;
  config: PhysicsConfig;
};

export type Msg =
  | { t: "hello"; slot: number; id: string; peers: { slot: number; id: string }[] }
  | { t: "peer-join"; slot: number; id: string; from?: number }
  | { t: "peer-leave"; slot: number; id: string; from?: number }
  | { t: "sync"; to: number; snap: SyncSnapshot; from?: number }
  | { t: "need-sync"; from?: number }
  | { t: "cursor"; x: number; y: number; from?: number }
  | { t: "aim"; aim: AimPresence; from?: number }
  | { t: "shot"; shot: Shot; place?: Vec; config: PhysicsConfig; from?: number }
  | { t: "config"; config: PhysicsConfig; from?: number }
  | { t: "rematch"; breaker: 0 | 1; config: PhysicsConfig; from?: number }
  | { t: "resign"; winner: 0 | 1; from?: number };

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
