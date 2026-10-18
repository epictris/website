// Stable saved IDs; labels belong to the editor, not to texture filenames.
export const ROOT_BARK_VARIANTS = ["woody", "original", "broad", "soft"] as const;
export type RootBarkVariant = typeof ROOT_BARK_VARIANTS[number];
export const ROOT_BARK_LABELS: Record<RootBarkVariant, string> = {
  woody: "Woody painted", original: "Original detailed", broad: "Broad grain", soft: "Soft selective",
};
// A root that says nothing wears the woody bark (since 2026-10-18; the soft
// selective painting before that).
export function rootBarkVariant(value: unknown): RootBarkVariant {
  return value === "original" || value === "broad" || value === "soft" ? value : "woody";
}
