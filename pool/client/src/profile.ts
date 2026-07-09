// A player's chosen identity: display name, cue colour, and an emoji. Picked on
// the Landing menu, persisted in localStorage (survives reloads), and broadcast
// to the opponent so both tables render the same banner + cue hue.

import type { CueBand } from "./render";

export type PlayerProfile = {
  name: string;
  color: string; // hex; the player's cue colour
  emoji: string;
};

// Cue-colour palette — bright hues that read well over the dark felt.
export const COLOR_CHOICES = [
  "#e0564a", // red
  "#e0873c", // orange
  "#e6c84f", // yellow
  "#6bc46b", // green
  "#45c0b0", // teal
  "#4f9fe0", // blue
  "#9b6bd4", // purple
  "#e070b0", // pink
];

export const EMOJI_CHOICES = [
  "🎱", "🔥", "🦈", "🐉", "👑", "🎯",
  "⚡", "🌟", "🍀", "💀", "🤠", "🧊",
];

const KEY = "pool.profile";

export function loadProfile(): PlayerProfile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PlayerProfile>;
      if (p && typeof p.name === "string") {
        return {
          name: p.name,
          color: typeof p.color === "string" ? p.color : COLOR_CHOICES[0],
          emoji: typeof p.emoji === "string" ? p.emoji : EMOJI_CHOICES[0],
        };
      }
    }
  } catch {
    /* ignore malformed/absent storage */
  }
  return { name: "", color: COLOR_CHOICES[0], emoji: EMOJI_CHOICES[0] };
}

export function saveProfile(p: PlayerProfile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable (private mode) — ignore */
  }
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${hex2((r + m) * 255)}${hex2((g + m) * 255)}${hex2((b + m) * 255)}`;
}

// Darken a colour while keeping it vibrant: lower HSL lightness, and bump
// saturation to counter the chroma loss that pure value-scaling reads as "dull".
function darkenVibrant(hex: string, lMul: number, sBoost: number): string {
  const h = hex.replace("#", "");
  const [hue, s, l] = rgbToHsl(
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  );
  return hslToHex(hue, Math.min(1, s + sBoost), l * lMul);
}

// Build the cue's wrap band from a single chosen colour. render.ts paints the
// wrap ring from band.light — a darker, still-vibrant take on the picked colour
// so the stick reads richer than the flat swatch. dark is kept for parity.
export function cueBand(hex: string): CueBand {
  return { dark: darkenVibrant(hex, 0.55, -0.06), light: darkenVibrant(hex, 0.82, -0.1) };
}
