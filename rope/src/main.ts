// Entry point: fixed-timestep loop driving the level, live input and renderer.

import { Vec2 } from "./engine/vec2";
import { Level } from "./level/level";
import { LiveInputSource } from "./input/liveInput";
import { render } from "./render/renderer";
import type { Camera } from "./render/camera";
import { DEFAULT_LEVEL, LEVELS } from "./level/registry";
import { digest, serializeInput, type Digest, type Recording, type SerializedFrame } from "./sim/trace";
import type { FrameInput } from "./input/frameInput";

const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5; // avoid spiral-of-death after a long stall

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const camera: Camera = {
  position: Vec2.ZERO,
  zoom: 2,
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
};

let cssWidth = window.innerWidth;
let cssHeight = window.innerHeight;

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  cssWidth = window.innerWidth;
  cssHeight = window.innerHeight;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  camera.viewportWidth = cssWidth;
  camera.viewportHeight = cssHeight;
}
resize();
window.addEventListener("resize", resize);

// Level selection via ?level=NAME (defaults to DEFAULT_LEVEL).
const levelId = ((): string => {
  const requested = new URLSearchParams(location.search).get("level") ?? DEFAULT_LEVEL;
  return LEVELS[requested] ? requested : DEFAULT_LEVEL;
})();
const levelSpec = LEVELS[levelId]!;

let level = new Level(levelSpec.data, levelSpec.init);
function reset(): void {
  level = new Level(levelSpec.data, levelSpec.init);
  level.onReset = reset;
  recFrames.length = 0;
  recDigests.length = 0;
}
level.onReset = reset;

const input = new LiveInputSource(canvas, camera);

// Full-session recording — press P to download a replayable bundle. A bundle
// must start at level start to replay deterministically, so the trace isn't
// trimmed; it resets whenever the level resets.
const recFrames: SerializedFrame[] = [];
const recDigests: Digest[] = [];

function downloadRecording(): void {
  const rec: Recording = {
    level: levelId,
    frames: recFrames.slice(),
    digests: recDigests.slice(),
  };
  const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `session-${recFrames.length}f.json`;
  a.click();
  URL.revokeObjectURL(url);
}
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyP") downloadRecording();
});

let last = -1;
let accumulator = 0;
let fps = 0;

function frame(now: number): void {
  if (last < 0) last = now;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  accumulator += dt;

  // Exponential moving average of the render frame rate.
  if (dt > 0) fps += ((1 / dt) - fps) * 0.1;

  let steps = 0;
  while (accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
    const frameInput: FrameInput = input.sample();
    level.physicsProcess(frameInput, STEP);
    recFrames.push(serializeInput(frameInput));
    recDigests.push(digest(level));
    accumulator -= STEP;
    steps++;
  }
  camera.position = level.cameraPosition;

  const dpr = window.devicePixelRatio || 1;
  render(ctx, dpr, cssWidth, cssHeight, level, camera, fps);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
