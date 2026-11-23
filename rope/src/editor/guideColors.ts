// EACH GUIDE ITS OWN BRIGHT COLOUR, in the Formations workspace (docs/editor.md,
// "Guides and rocks"): so a level of many guides, one behind another and
// over the rocks they make, reads as which outline is which.
//
// "Random" but stable: the hue is hashed from the formation's id (FNV-1a,
// spread by the golden ratio), so a guide keeps its colour through a reload,
// an undo and a regenerate, and the same level looks the same to everyone.
// Saturated and light enough to stand out against grey rock and a navy sky.

const GOLDEN = 0.618033988749895;

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// HSL (all 0..1) to 0xRRGGBB.
function hsl(h: number, s: number, l: number): number {
  const k = (n: number): number => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const byte = (v: number): number => Math.round(v * 255);
  return (byte(f(0)) << 16) | (byte(f(8)) << 8) | byte(f(4));
}

export function guideColor(formationId: string): number {
  const hue = ((hash(formationId) / 0x100000000) * 7 * GOLDEN) % 1;
  return hsl(hue, 0.95, 0.62);
}

export function guideCss(formationId: string): string {
  return `#${guideColor(formationId).toString(16).padStart(6, "0")}`;
}
