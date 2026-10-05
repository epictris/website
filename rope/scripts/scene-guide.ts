// Write a level's collision into Blender to model against (`just scene-guide <level>`).
//
//   bun run scene:guide <level> [--ride BUNDLE] [--speed M/S] [--blender PATH]
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
//
// The guide also carries the GAME CAMERA, `guide.camera`: the level's lens,
// animated through the real camera controller along the level's camera paths
// (`src/sim/cameraTrack.ts`), or along a recorded run with `--ride`. Looking
// through it in Blender is looking through the game.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { PX } from "../src/engine/units";
import { Vec2 } from "../src/engine/vec2";
import { objectDepth, worldPlacement } from "../src/level/buildBodies";
import {
  isCollisionObject,
  isLightObject,
  scaleLevelData,
  type LevelBodyData,
  type RawLevelData,
} from "../src/level/levelFormat";
import { outlineOfData } from "../src/render/shapePath";
import { DOF_MAX_BLUR, FOCUS_BAND } from "../src/render3d/depthOfField";
import { EQUIRECT_SIZE, equirectPixels, fogOf, lightingOf, TONE_MAPPING_EXPOSURE } from "../src/render3d/environment";
import { wakeParams } from "../src/render3d/glow";
import { swarmParams } from "../src/render3d/fireflies";
import {
  DEFAULT_LIGHT_COLOR,
  DEFAULT_LIGHT_INTENSITY,
  DEFAULT_LIGHT_RANGE,
  DEFAULT_LIGHT_Z,
  DEFAULT_SPOT_ANGLE,
  DEFAULT_SPOT_PENUMBRA,
  LIGHT_BUDGET,
  LIGHT_SHADOW_BUDGET,
} from "../src/render3d/lights";
import * as THREE from "three";
import { isSceneName } from "../src/render3d/scenes";
import { LEVELS } from "../src/level/registry";
import { trackAlongPaths, trackFromRecording, WALK_SPEED, type CameraTrack } from "../src/sim/cameraTrack";
import type { Recording } from "../src/sim/trace";

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

const levelArg =
  positional[0] ?? fail("usage: bun run scene:guide <level> [--ride BUNDLE] [--speed M/S] [--blender PATH]");
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

// A body's collision pieces as world-space outlines, each with its hole if it
// has one (a belt's band).
type Piece = { outline: [number, number][]; hole: [number, number][] | null };
function pieces(b: LevelBodyData): Piece[] {
  const out: Piece[] = [];
  for (const o of b.objects) {
    if (!isCollisionObject(o)) continue;
    const w = worldPlacement(b, o);
    const toGame = (vs: readonly Vec2[]) => vs.map((v) => game(v.rotated(w.rot).add(w.pos)));
    const shape = outlineOfData(o.shape);
    let local: Vec2[];
    let hole: readonly Vec2[] | undefined;
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
      hole = shape.hole;
    }
    out.push({ outline: toGame(local), hole: hole ? toGame(hole) : null });
  }
  return out;
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
    pieces: pieces(b),
  }));
if (!bodies.length) fail(`${levelName} has no collision to guide against`);

const points = bodies.flatMap((b) => b.pieces.flatMap((p) => p.outline));
const xs = points.map((p) => p[0]);
const ys = points.map((p) => p[1]);
// The game camera: along the level's camera paths, or along a recorded run.
function cameraTrack(): CameraTrack {
  const spec = Object.entries(LEVELS).find(([, s]) => s.file === levelName);
  const ride = flag("ride");
  if (ride) {
    const bytes = readFileSync(resolve(ride));
    const rec = JSON.parse((ride.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8")) as Recording;
    if (spec && rec.level !== spec[0]) {
      console.warn(`[scene-guide] ${basename(ride)} is a run of ${rec.level}, not ${spec[0]}; its camera is that level's`);
    }
    return trackFromRecording(rec, rec.data ?? raw, `ride of ${basename(ride)} (${rec.frames.length} frames)`);
  }
  const speed = Number(flag("speed") ?? WALK_SPEED);
  if (!(speed > 0)) fail(`--speed must be a positive number of m/s`);
  return trackAlongPaths(raw, (spec?.[1].controller ?? "ball") === "ball", speed);
}
const camera = cameraTrack();
const cameraJob = {
  ...camera,
  frames: camera.frames.map((f) => ({ eye: f.eye.map(round), halfHeight: round(f.halfHeight) })),
  // What the game draws over the view, for the Formations panel's game look:
  // the level's fog and the Medium depth of field (src/render3d/depthOfField.ts).
  look: { fog: fogOf(level.environment), dofMaxBlur: DOF_MAX_BLUR.medium, dofFocusBand: FOCUS_BAND },
};

// The game's light at rest, for the Formations panel's Lighting: what
// `Environment` builds from the level's block (sun, hemisphere fill, the
// generated sky it reflects, background, tone mapping) and the always-on light
// objects `LightRig` builds, in its order and under its budgets. Waking lights
// start dark and fireflies move, so neither is here. Three's frame, linear
// colours, metres.
function lightingJob() {
  const l = lightingOf(level.environment);
  const lin = (c: THREE.Color): number[] => [c.r, c.g, c.b].map((v) => Math.round(v * 1e6) / 1e6);
  const vec = (v: THREE.Vector3): number[] => [v.x, v.y, v.z].map(round);
  const lights: object[] = [];
  let shadows = LIGHT_SHADOW_BUDGET;
  for (const b of level.bodies) {
    for (const o of b.objects) {
      if (!isLightObject(o) || wakeParams(o) || swarmParams(o) || lights.length >= LIGHT_BUDGET) continue;
      const w = worldPlacement(b, o);
      // The holder turns by -rot about +z (three's frame), and a spot's
      // direction is local to it.
      const rot = -w.rot;
      const dx = o.dirX ?? 0;
      const dy = -(o.dirY ?? 1);
      const castShadow = o.castShadow === true && shadows > 0;
      if (castShadow) shadows--;
      lights.push({
        kind: o.kind === "spot" ? "spot" : "point",
        position: [round(w.pos.x), round(-w.pos.y), round(objectDepth(o.z, DEFAULT_LIGHT_Z))],
        direction: [dx * Math.cos(rot) - dy * Math.sin(rot), dx * Math.sin(rot) + dy * Math.cos(rot), o.dirZ ?? 0],
        color: lin(new THREE.Color(o.color ?? DEFAULT_LIGHT_COLOR)),
        intensity: o.intensity ?? DEFAULT_LIGHT_INTENSITY,
        range: round(o.range ?? DEFAULT_LIGHT_RANGE),
        angle: o.angle ?? DEFAULT_SPOT_ANGLE,
        penumbra: o.penumbra ?? DEFAULT_SPOT_PENUMBRA,
        castShadow,
      });
    }
  }
  return {
    sun: l.sun && { color: lin(l.sun.color), intensity: l.sun.intensity, dir: vec(l.sun.dir) },
    fill: { sky: lin(l.fill.sky), ground: lin(l.fill.ground), intensity: l.fill.intensity },
    // RGBA floats, row 0 straight down, as three reads them (`equirectDirection`).
    sky: { ...EQUIRECT_SIZE, pixels: Array.from(equirectPixels(l.sky), (v) => Math.round(v * 1e6) / 1e6) },
    envIntensity: l.envIntensity,
    // The CSS hex three clears to: shown as these sRGB bytes, never tone mapped.
    background: l.background,
    hdri: l.hdri,
    toneMappingExposure: TONE_MAPPING_EXPOSURE,
    lights,
  };
}

const job = {
  level: levelName,
  scene,
  bounds: { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] },
  spawn: { x: round(level.player.x), y: round(-level.player.y), r: round(level.player.radius) },
  bodies,
  camera: cameraJob,
  lighting: lightingJob(),
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
console.log(
  `[scene-guide] game camera: ${camera.frames.length} frames at ${camera.fps} fps, ${camera.focalLength.toFixed(1)} mm, ${camera.source}`,
);
console.log(`[scene-guide] open ${relative(ROOT, scenePath)}, model on the guide, then \`just scene ${levelName}\``);
