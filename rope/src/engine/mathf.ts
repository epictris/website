// Godot Mathf helpers — only the members the game uses. Plain float64 math;
// the simulation is self-consistent (deterministic replay) without matching C#
// float32 bit-for-bit.

export const Mathf = {
  Pi: Math.PI,
  Tau: Math.PI * 2,
  Sqrt2: Math.SQRT2,

  abs: Math.abs,
  sqrt: Math.sqrt,
  cos: Math.cos,
  sin: Math.sin,
  acos: Math.acos,
  cosh: Math.cosh,
  sinh: Math.sinh,
  log: Math.log,
  pow: Math.pow,

  min(a: number, b: number): number {
    return a < b ? a : b;
  },
  max(a: number, b: number): number {
    return a > b ? a : b;
  },
  clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  },
  lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  },
  floorToInt(v: number): number {
    return Math.floor(v);
  },
  degToRad(deg: number): number {
    return (deg * Math.PI) / 180;
  },
  radToDeg(rad: number): number {
    return (rad * 180) / Math.PI;
  },
  isNaN(v: number): boolean {
    return Number.isNaN(v);
  },
};

// C#-style integer modulo used by Calc.Mod (always non-negative for positive b).
export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}
