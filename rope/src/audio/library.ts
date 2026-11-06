// The sound files the game can play: its LIBRARY (docs/sound.md#the-library).
//
// The same store, fetch, budget and provenance rules as every other binary
// (docs/asset-store.md): the bytes are gitignored under `public/sounds/` and
// published to the `assets` release, and each entry pins `sha256` and `bytes`
// and names `source`, `author` and `license`.
//
// JSON rather than code because it is WRITTEN BY A TOOL: the editor's Sounds
// menu uploads a file to `/api/sounds` (src/server/sounds.ts), which transcodes
// it, hashes it and pins it here in one step, so the hash and the size are
// never typed by hand. What a file is FOR - which event plays it - is the
// bank's business (`soundBank.json`, audio/slots.ts), not the library's.

import manifest from "./soundAssets.json";

export interface SoundAsset {
  // Path under `public/` - `/sounds/<key>.ogg`, mono Opus at 48 kHz.
  file: string;
  sha256: string;
  bytes: number;
  // How long it plays, seconds - shown in the menu, and what a preview of a
  // loop is cut to.
  seconds: number;
  // The file's name as it was uploaded, so the menu can say what it is.
  name: string;
  // As on every stored asset, and required for the same reasons: `cli assets`
  // fails on an entry missing any of them, and CREDITS.md is generated from
  // them. The upload cannot know them, so the menu asks.
  source: string;
  author: string;
  license: string;
}

// Where the files live under `public/`, and so the URL they are served at.
export const SOUNDS_DIR = "/sounds";

export function soundFile(key: string): string {
  return `${SOUNDS_DIR}/${key}.ogg`;
}

// Mutable: the editor registers what it has just uploaded, edited or removed so
// the open page can play it without a reload, and so does the dev server for
// its own copy. Only the editor and the dev server write it.
export const SOUND_ASSETS: Record<string, SoundAsset> = { ...(manifest as Record<string, SoundAsset>) };

export function replaceSoundAssets(next: Record<string, SoundAsset>): void {
  for (const key of Object.keys(SOUND_ASSETS)) delete SOUND_ASSETS[key];
  Object.assign(SOUND_ASSETS, next);
}

export function soundKeys(): string[] {
  return Object.keys(SOUND_ASSETS).sort();
}
