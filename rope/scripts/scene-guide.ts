// Write a level's collision into Blender to model against (`just scene-guide <level>`).
//
//   bun run scene:guide <level> [--blender PATH]
//
// Reads the level, turns every body's collision objects into world-space
// outlines (metres, the game's frame: x right, y up, z toward the camera),
// and has headless Blender (`tools/blender/scene_guide.py`) write them as one
// `Guide` collection into
//
//   assets-src/scenes/<scene>-guide.blend    overwritten every run
//   assets-src/scenes/<scene>.blend          created if missing, linking the guide
//
// so the scene file always shows the current colliders when it is opened, and
// a dressed body is modelled on the very outline the ball rolls on. The guide
// never exports (docs/blender-scenes.md).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { PX } from "../src/engine/units";
import { Vec2 } from "../src/engine/vec2";
import { worldPlacement } from "../src/level/buildBodies";
import { DECOR_DEPTH } from "../src/level/decor";
import { loadSchema } from "../src/level/generatorParams";
import {
  isCollisionObject,
  isGeometryObject,
  scaleLevelData,
  type LevelBodyData,
  type RawLevelData,
} from "../src/level/levelFormat";
import { DEFAULT_THICKNESS } from "../src/lib/shapeGeometry";
import { outlineOfData } from "../src/render/shapePath";
import { isSceneName } from "../src/render3d/scenes";

const ROOT = resolve(import.meta.dirname, "..");
const SCENES_SRC = join(ROOT, "assets-src", "scenes");
// A circle's outline, as the extruder draws it.
const CIRCLE_SEGMENTS = 32;

function fail(msg: string): never {
  console.error(`[scene-guide] ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const levelArg = positional[0] ?? fail("usage: bun run scene:guide <level> [--blender PATH]");
const levelPath = levelArg.endsWith(".json") ? resolve(levelArg) : join(ROOT, "levels", `${levelArg}.json`);
if (!existsSync(levelPath)) fail(`no level at ${levelPath}`);
const levelName = basename(levelPath, ".json");
const raw = JSON.parse(readFileSync(levelPath, "utf8")) as RawLevelData;
const scene = raw.scene;
if (!scene) fail(`${levelName} names no scene: set one in the editor's Level panel (\`scene\`) first`);
if (!isSceneName(scene)) fail(`"${scene}" is not a scene name (lower-case letters, digits and dashes)`);

// Metres, so Blender gets the sizes the game draws.
const level = scaleLevelData(raw, PX);

// The game's frame from the sim's: y up.
const game = (p: Vec2): [number, number] => [round(p.x), round(-p.y)];
const round = (v: number): number => Math.round(v * 10000) / 10000;

function outlines(b: LevelBodyData): [number, number][][] {
  const out: [number, number][][] = [];
  for (const o of b.objects) {
    if (!isCollisionObject(o)) continue;
    const w = worldPlacement(b, o);
    const shape = outlineOfData(o.shape);
    let local: Vec2[];
    if (shape.kind === "circle") {
      local = [];
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        local.push(new Vec2(Math.cos(a) * shape.radius, Math.sin(a) * shape.radius));
      }
    } else if (shape.kind === "rect") {
      const h = shape.half;
      local = [new Vec2(-h.x, -h.y), new Vec2(h.x, -h.y), new Vec2(h.x, h.y), new Vec2(-h.x, h.y)];
    } else {
      local = [...shape.verts];
    }
    out.push(local.map((v) => game(v.rotated(w.rot).add(w.pos))));
  }
  return out;
}

// How thick the body is DRAWN, which is what a dressing is modelled to: its
// first geometry object's depth - a generated boulder's being its generator's
// `depth` parameter, or the schema's default when the level states none -
// else the extruder's default for a body that collides.
function depthOf(b: LevelBodyData): number {
  for (const o of b.objects) {
    if (!isGeometryObject(o)) continue;
    if (o.generator?.kind === "boulder") {
      const authored = o.generator.params?.["depth"];
      if (typeof authored === "number") return authored;
      const spec = loadSchema("boulder")?.params.find((p) => p.key === "depth");
      if (typeof spec?.default === "number") return spec.default;
    }
    if (o.depth !== undefined) return o.depth;
  }
  return b.objects.some(isCollisionObject) ? DEFAULT_THICKNESS : DECOR_DEPTH;
}

const SOLID_KINDS = new Set(["static", "rigid"]);
const bodies = level.bodies
  .map((b, index) => ({ b, index }))
  .filter(({ b }) => b.objects.some(isCollisionObject))
  .map(({ b, index }) => ({
    index,
    name: b.name ?? null,
    kind: b.kind,
    solid: SOLID_KINDS.has(b.kind),
    origin: game(new Vec2(b.x, b.y)),
    depth: round(depthOf(b)),
    outlines: outlines(b),
  }));
if (!bodies.length) fail(`${levelName} has no collision to guide against`);

const xs = bodies.flatMap((b) => b.outlines.flat().map((p) => p[0]));
const ys = bodies.flatMap((b) => b.outlines.flat().map((p) => p[1]));
const job = {
  level: levelName,
  scene,
  bounds: { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] },
  spawn: { x: round(level.player.x), y: round(-level.player.y), r: round(level.player.radius) },
  bodies,
};

const blender = flag("blender") ?? process.env["BLENDER_PATH"] ?? process.env["BLENDER"] ?? "blender";
mkdirSync(SCENES_SRC, { recursive: true });
const guidePath = join(SCENES_SRC, `${scene}-guide.blend`);
const scenePath = join(SCENES_SRC, `${scene}.blend`);
const scratch = mkdtempSync(join(tmpdir(), "scene-guide-"));
try {
  const jobPath = join(scratch, "guide.json");
  writeFileSync(jobPath, JSON.stringify(job));
  const run = spawnSync(
    blender,
    ["-b", "--factory-startup", "--python-exit-code", "1", "--python", join(ROOT, "tools", "blender", "scene_guide.py"), "--", jobPath, guidePath, scenePath],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error) fail(`could not run ${blender}: ${run.error.message} (install Blender 5.2, or name it with --blender or BLENDER_PATH)`);
  for (const line of run.stdout.split("\n")) if (line.startsWith("[scene_guide]")) console.log(line);
  if (run.status !== 0 || !existsSync(guidePath)) {
    console.error(run.stderr);
    fail(`Blender wrote no guide (exit ${run.status})`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const named = bodies.filter((b) => b.name).length;
console.log(`[scene-guide] ${bodies.length} bodies (${named} named) from ${relative(ROOT, levelPath)}`);
console.log(`[scene-guide] open ${relative(ROOT, scenePath)}, model on the guide, then \`just scene ${levelName}\``);
