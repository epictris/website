// Hex + alpha → canvas rgba() string. Accepts #rgb or #rrggbb.
export function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Hex → its channels. Accepts #rgb or #rrggbb.
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// The same hue at `factor` of its brightness (0 = black, 1 = unchanged). Used
// where one authored colour has to yield a matching darker one - a chain's
// alternating links, which read as interlocking loops only if the two differ.
export function shade(hex: string, factor: number): string {
  const { r, g, b } = hexToRgb(hex);
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v * factor)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
