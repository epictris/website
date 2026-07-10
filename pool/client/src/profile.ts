// A player's chosen identity: display name, cue colour, and an emoji. Picked on
// the Landing menu, persisted in localStorage (survives reloads), and broadcast
// to the opponent so both tables render the same banner + cue hue.

import type { CueBand } from "./render";

export type PlayerProfile = {
  name: string;
  color: string; // hex; the player's cue colour
  emoji: string;
};

// Cue-colour hues — bright colours that read well over the dark felt. These are
// the pool a fresh player is randomly assigned from.
export const CUE_HUES = [
  "#e0564a", // red
  "#e0873c", // orange
  "#e6c84f", // yellow
  "#6bc46b", // green
  "#45c0b0", // teal
  "#4f9fe0", // blue
  "#9b6bd4", // purple
  "#e070b0", // pink
];

// The full swatch palette shown in the picker: the hues plus neutral off-white
// and very-dark-grey. The neutrals are selectable but excluded from random
// assignment.
export const COLOR_CHOICES = [...CUE_HUES, "#e8e6de", "#1d1d1b"];

// Pick a random cue hue for a brand-new player (no colour saved yet).
export function randomCueColor(): string {
  return CUE_HUES[Math.floor(Math.random() * CUE_HUES.length)];
}

export const EMOJI_CHOICES = [
  "🎱", "🔥", "🦈", "🐉", "👑", "🎯",
  "⚡", "🌟", "🍀", "💀", "🤠", "🧊",
];

// A stable per-browser identity, minted once and kept in localStorage. The
// server uses it to own player slots, so a dropped player who reconnects with the
// same cid reclaims their slot instead of being demoted to a spectator.
const CID_KEY = "pool.cid";
export function loadClientId(): string {
  try {
    let cid = localStorage.getItem(CID_KEY);
    if (!cid) {
      cid = crypto.randomUUID();
      localStorage.setItem(CID_KEY, cid);
    }
    return cid;
  } catch {
    return crypto.randomUUID(); // storage unavailable — a per-session id still works
  }
}

const KEY = "pool.profile";

export function loadProfile(): PlayerProfile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PlayerProfile>;
      if (p && typeof p.name === "string") {
        // Old profiles may predate a saved colour — assign+persist one so it
        // stays stable across reloads instead of re-rolling each visit.
        const color = typeof p.color === "string" ? p.color : randomCueColor();
        const prof = {
          name: p.name,
          color,
          emoji: typeof p.emoji === "string" ? p.emoji : EMOJI_CHOICES[0],
        };
        if (typeof p.color !== "string") saveProfile(prof);
        return prof;
      }
    }
  } catch {
    /* ignore malformed/absent storage */
  }
  // No stored profile: mint a fresh identity with a random cue colour and
  // persist it so the assignment sticks.
  const prof = { name: "", color: randomCueColor(), emoji: EMOJI_CHOICES[0] };
  saveProfile(prof);
  return prof;
}

export function saveProfile(p: PlayerProfile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable (private mode) — ignore */
  }
}

// The quick-select emoji tray (the strip beside the comm button). Persisted
// separately so swaps made via the "more" picker stick across reloads.
const QUICK_KEY = "pool.quickEmojis";
// Long enough to fill a wide tray; the tray shows as many as fit the felt width
// and pads any extra slots from this pool (wrapping) when the stored list is short.
export const QUICK_DEFAULT = [
  "🤏", "🗿", "🤯", "😛", "😂", "🔥", "💀", "👀",
  "🎱", "😎", "🥳", "😳", "🤔", "👍", "❤️", "😅",
];

export function loadQuickEmojis(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_KEY);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string")) return a;
    }
  } catch {
    /* ignore malformed/absent storage */
  }
  return [...QUICK_DEFAULT];
}

export function saveQuickEmojis(a: string[]): void {
  try {
    localStorage.setItem(QUICK_KEY, JSON.stringify(a));
  } catch {
    /* storage may be unavailable — ignore */
  }
}

// Build the cue's wrap band from a single chosen colour. render.ts paints the
// wrap ring from band.light — the picked colour used as-is so the stick matches
// the swatch exactly. dark is kept for parity.
export function cueBand(hex: string): CueBand {
  return { dark: hex, light: hex };
}
