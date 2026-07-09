// Full emoji catalogue for the "more" picker — every Unicode emoji, in display
// order, sourced from `unicode-emoji-json`. Each entry's `name` folds the CLDR
// name + group into one lowercase search string.

import byEmoji from "unicode-emoji-json/data-by-emoji.json";
import ordered from "unicode-emoji-json/data-ordered-emoji.json";

export type EmojiEntry = { ch: string; name: string };

type Meta = { name: string; group: string };
const data = byEmoji as Record<string, Meta>;

export const EMOJI_DB: EmojiEntry[] = (ordered as string[])
  .filter((ch) => data[ch])
  .map((ch) => {
    const m = data[ch];
    return { ch, name: `${m.name} ${m.group}`.toLowerCase() };
  });
