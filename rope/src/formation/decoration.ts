// A decoration's build request and the hash that names its result
// (docs/formations.md, "Decorations"); DOM-free and wasm-free, as recipe.ts.

import type { DecorationAnchor, DecorationKind, DecorationObjectData, DecorationSettings, PaintStamp } from "../level/levelFormat";
import { PAINTED_DECORATIONS } from "../level/levelFormat";
import { canonical } from "./recipe";
import { sha256Hex } from "./sha256";

// Bumped when what a request means changes.
export const DECORATION_VERSION = 1;

export interface DecorationRequest {
  version: number;
  // The formation build it grows on.
  host: string;
  kind: DecorationKind;
  seed?: number;
  settings?: DecorationSettings;
  // The level's focal length, mm (the detail budget's lens).
  lens?: number;
  // A placed one: where it is grown. A painted one: its strokes.
  at?: DecorationAnchor;
  stamps?: PaintStamp[];
}

export function isPainted(kind: DecorationKind): boolean {
  return PAINTED_DECORATIONS.includes(kind);
}

// What growing `d` on the build `host` asks for. A placed decoration is grown
// where it is drawn (`onRock`); a painted one from its strokes.
export function decorationRequest(
  d: Pick<DecorationObjectData, "kind" | "seed" | "settings" | "anchor" | "onRock">,
  host: string,
  strokes: readonly PaintStamp[] | undefined,
  lens?: number,
): DecorationRequest {
  return canonical({
    version: DECORATION_VERSION,
    host,
    kind: d.kind,
    ...(d.seed !== undefined ? { seed: d.seed } : {}),
    ...(d.settings ? { settings: d.settings } : {}),
    ...(lens !== undefined ? { lens } : {}),
    ...(isPainted(d.kind) ? { stamps: strokes ?? [] } : { at: d.onRock ?? d.anchor }),
  }) as DecorationRequest;
}

export function decorationHash(r: DecorationRequest): string {
  return sha256Hex(JSON.stringify(canonical(r)));
}

export function decorationFile(hash: string): string {
  return `/generated/${hash}/decoration.glb`;
}
