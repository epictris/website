// Read-only bridge for Blender. stdout is the game's resolved environment.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeLevelData, type LevelSource } from "../src/level/levelFormat";
import { lightingJob } from "./lightingJob";

const file = resolve(import.meta.dirname, "../levels/ball.json");
const level = JSON.parse(readFileSync(file, "utf8")) as LevelSource;
// The compiled level's block: a format-4 file holds its light as Sun and
// Environment nodes, not as a block of its own (docs/level-format.md).
process.stdout.write(JSON.stringify(lightingJob(normalizeLevelData(level).environment)));
