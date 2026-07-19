// Named level registry — the entry point for replay/playtest tooling and the
// live app to resolve a level id to its data.

import { LEVEL_2, type LevelData } from "./levelData";

export const LEVELS: Record<string, LevelData> = {
  LEVEL_2,
};

export const DEFAULT_LEVEL = "LEVEL_2";
