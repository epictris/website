// Audio identity is independent of density, thickness and collision behaviour.
export const SOUND_MATERIALS = [
  "moss", "stone", "wood", "metal", "mud", "vine", "ivy", "rubber", "brick", "glass", "ice",
] as const;
export type SoundSurface = typeof SOUND_MATERIALS[number];
export type SoundMaterial = SoundSurface | "auto";

export function isSoundSurface(value: unknown): value is SoundSurface {
  return typeof value === "string" && (SOUND_MATERIALS as readonly string[]).includes(value);
}

// Freeze the old density-based sound choice when importing an older shape.
// New editor saves always state a soundMaterial (including "auto"), so future
// physics-material edits cannot change that choice. Auto uses mechanics only.
const LEGACY: Record<string, SoundSurface> = {
  wood: "wood", ice: "ice", flesh: "rubber", rubber: "rubber", brick: "brick",
  stone: "stone", glass: "glass", aluminium: "metal", "cast iron": "metal",
  steel: "metal", lead: "metal",
};
export function soundMaterialOf(shape: {
  soundMaterial?: string; material?: string; viscosity?: number;
  root?: unknown; shape?: { kind: string };
}): SoundMaterial {
  if (shape.soundMaterial === "auto" || isSoundSurface(shape.soundMaterial)) return shape.soundMaterial;
  // These already took precedence over the physical material in old levels.
  if ((shape.viscosity ?? 0) > 0 || shape.root || shape.shape?.kind === "belt") return "auto";
  return LEGACY[shape.material ?? ""] ?? "auto";
}
