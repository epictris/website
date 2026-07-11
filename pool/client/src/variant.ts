// Game variant (pool vs snooker). The variant travels with the room CODE — a
// snooker room's code carries the `snkr-` prefix — so both clients (and a shared
// link, and the lobby) all derive the same variant deterministically, exactly as
// the rack seed is derived from the room id. No server change needed: the code is
// an opaque room key to the relay.

import type { World } from "./physics";

export type Variant = "pool" | "snooker";

export const SNOOKER_PREFIX = "snkr-";

/** The variant a room code selects (default pool). */
export function variantOf(room: string): Variant {
  return room.startsWith(SNOOKER_PREFIX) ? "snooker" : "pool";
}

/** Mint the room path for a fresh game of the given variant. */
export function newRoomPath(variant: Variant, code: string): string {
  return variant === "snooker" ? `/${SNOOKER_PREFIX}${code}` : `/${code}`;
}

/** Infer the variant from a world (used for replays, which carry no room code):
 *  snooker uses ball ids 16..21 (the colours), which pool never has. */
export function variantOfWorld(world: World): Variant {
  return world.balls.some((b) => b.id > 15) ? "snooker" : "pool";
}

// Table PHOTO per variant. Both are top-down tables with a transparent margin;
// their felt-box + opaque-box pixel mappings live in render.ts (TABLE_ART).
export const TABLE_IMG: Record<Variant, string> = {
  pool: "https://iili.io/CaPOw1s.png",
  snooker: "https://iili.io/C0Z9Jzx.png",
};
