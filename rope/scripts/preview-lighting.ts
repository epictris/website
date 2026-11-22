// Read-only bridge for Blender. stdout is the game's resolved environment.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RawLevelData } from "../src/level/levelFormat";
import { lightingJob } from "./lightingJob";

const file = resolve(import.meta.dirname, "../levels/ball.json");
const level = JSON.parse(readFileSync(file, "utf8")) as RawLevelData;
process.stdout.write(JSON.stringify(lightingJob(level.environment)));
