import { validateHangingVineRecipe, type HangingVineRecipe } from "./vine/hangingVine";
import { validateFernRecipe, type FernRecipe } from "./vine/fern";
import type { SavedLeaf } from "./leafLibrary";

export type FoliageRecipe = HangingVineRecipe | FernRecipe;
export interface SavedFoliage {
  version: 2;
  kind: "vine" | "fern" | "legacy-vine";
  recipe: FoliageRecipe;
  hostId: number;
  hostMesh: string;
  hostIndex: number;
  customLeaves?: SavedLeaf[];
}

export function validateSavedFoliage(value: unknown): asserts value is SavedFoliage {
  if (!value || typeof value !== "object") throw new Error("Missing plant recipe.");
  const saved = value as SavedFoliage;
  if (saved.version !== 2 || !["vine", "fern"].includes(saved.kind)) throw new Error("Unsupported plant recipe.");
  if (!Number.isSafeInteger(saved.hostId) || saved.hostId < 0 ||
      !Number.isSafeInteger(saved.hostIndex) || saved.hostIndex < 0 || saved.hostIndex > 10000 ||
      typeof saved.hostMesh !== "string" || saved.hostMesh.length > 300) throw new Error("Invalid host reference.");
  // Validators supply historical defaults; validate a copy so callers' undo snapshots stay immutable.
  const recipe = structuredClone(saved.recipe);
  if (saved.kind === "fern") {
    validateFernRecipe(recipe as FernRecipe);
    const r = recipe as FernRecipe;
    if (!Number.isInteger(r.settings.seed) || Math.hypot(...r.normal) < .1 || Math.hypot(...r.open) < .01)
      throw new Error("Choose a valid fern direction and an integer seed.");
  }
  else validateHangingVineRecipe(recipe as HangingVineRecipe);
  if (saved.customLeaves !== undefined) {
    if (!Array.isArray(saved.customLeaves) || saved.customLeaves.length > 36) throw new Error("Too many custom leaves.");
    const ids = new Set<string>();
    for (const leaf of saved.customLeaves) {
      if (!leaf || !/^my-[a-z0-9]{1,16}$/.test(leaf.id) || ids.has(leaf.id) ||
          typeof leaf.png !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(leaf.png) || leaf.png.length > 4000000 ||
          !Number.isFinite(leaf.aspect) || leaf.aspect <= 0 || leaf.aspect > 100 ||
          !Array.isArray(leaf.baseUv) || leaf.baseUv.length !== 2 || !leaf.baseUv.every(n => Number.isFinite(n) && n >= 0 && n <= 1))
        throw new Error("Invalid custom leaf.");
      ids.add(leaf.id);
    }
  }
}

export function isGeneratedFoliage(key: string): boolean {
  return /^(vine-v3|foliage-v1):/.test(key);
}
