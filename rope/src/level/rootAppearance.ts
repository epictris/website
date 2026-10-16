// Stable saved IDs; labels belong to the editor, not to texture filenames.
export const ROOT_BARK_VARIANTS = ["original", "broad", "soft"] as const;
export type RootBarkVariant = typeof ROOT_BARK_VARIANTS[number];
export const ROOT_BARK_LABELS: Record<RootBarkVariant, string> = {
  original: "Original detailed", broad: "Broad grain", soft: "Soft selective",
};
export function rootBarkVariant(value: unknown): RootBarkVariant {
  return value === "original" || value === "broad" ? value : "soft";
}
