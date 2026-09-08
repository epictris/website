// Entry point: fixed-timestep loop driving the level, live input and renderer.

import { Vec2 } from "./engine/vec2";
import { Level } from "./level/level";
import { BallLevel } from "./level/ballLevel";
import { LiveInputSource } from "./input/liveInput";
import { BallInputSource } from "./input/ballInput";
import { BUTTON_BITS, InputTrace } from "./input/inputTrace";
import { drawProbeOutline, render, renderBall } from "./render/renderer";
import { Scene3D } from "./render3d/scene";
import { BALL_ZOOM, GRAPPLE_ZOOM, type Camera } from "./render/camera";
import { fitCanvas, VIEW_HEIGHT, VIEW_WIDTH, viewTransform } from "./render/viewport";
import { CameraController } from "./render/cameraController";
import { PerfProbe } from "./render/perfProbe";
import { drawPerfHud } from "./render/perfHud";
import { SparkSystem } from "./render/sparks";
import { DEFAULT_LEVEL, LEVELS } from "./level/registry";
import {
  digest,
  digestBall,
  recordingDeserializer,
  serializeInput,
  worldDigest,
  worldDigestBall,
  type Digest,
  type Recording,
  type SerializedFrame,
  type WorldDigest,
} from "./sim/trace";
import type { FrameInput } from "./input/frameInput";
import type { IInputSource } from "./input/frameInput";
import { levelFromRecording } from "./sim/replay";
import { PlaytestRecorder } from "./playtest/recorder";
import {
  ADMIN_API,
  DIGEST_EVERY,
  INGEST_PATH,
  PAUSE_RESET_MS,
  type Device,
  type EndReason,
} from "./playtest/protocol";
import { selfReplayLine, verifySelfReplay } from "./sim/selfReplay";
import { showToast } from "./render/toast";
// The tree this page was served from, not the commit the dev server booted at
// (see src/sim/treeStamp.ts).
import { commit, dirty, srcHash } from "virtual:tree-stamp";

const STEP = 1 / 60;
// One real-time step plus at most one step of catch-up per rendered frame, and
// any deeper debt is shed (see the loop). Five used to be the spiral-of-death
// guard, and five IS the spiral on a machine that cannot afford one: a sim step
// over the render budget put the accumulator permanently behind, every frame
// ran the full five steps, and a vine hang that renders at 75 fps when caught
// up was pinned at 13 fps in 76 ms frames - a 5x amplification of being maybe
// 2x over budget (measured, session-198f at 4x CPU). Shedding the debt trades
// that for sim time running slightly slower than the wall while overloaded,
// which degrades gracefully and recovers instantly.
const MAX_STEPS_PER_FRAME = 5;

// Two canvases stacked on the play frame (see index.html): the WebGL scene
// underneath, and the 2D one on top carrying everything that is genuinely 2D.
// The top canvas keeps the pointer events and the 2D context; the bottom one is
// handed to `Scene3D` and never touched again here.
const canvas = document.getElementById("game") as HTMLCanvasElement;
const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// The view is a fixed 16:9 frame (see render/viewport.ts), so the camera's
// viewport is a constant: the window changes how big that frame is drawn, never
// how much world is inside it.
const camera: Camera = {
  position: Vec2.ZERO,
  zoom: GRAPPLE_ZOOM,
  viewportWidth: VIEW_WIDTH,
  viewportHeight: VIEW_HEIGHT,
};
// The camera is driven by the controller (eased follow + camera regions);
// `camera.zoom` is its output, so the framing scale lives here instead.
const cameraCtl = new CameraController();

// Where the frame lands on the canvas — refreshed on resize, since it carries
// the display's DPR as well as the fit.
let view = viewTransform(VIEW_WIDTH, VIEW_HEIGHT);

const params = new URLSearchParams(location.search);

// Level selection via ?level=NAME (defaults to DEFAULT_LEVEL).
const levelId = ((): string => {
  const requested = params.get("level") ?? DEFAULT_LEVEL;
  return LEVELS[requested] ? requested : DEFAULT_LEVEL;
})();
const levelSpec = LEVELS[levelId]!;
const isBall = levelSpec.controller === "ball";
const baseZoom = isBall ? BALL_ZOOM : GRAPPLE_ZOOM;

// Render mode. The ball & chain plays in 3D; the grapple levels stay on the 2D
// path, because the Player state-machine slice is 2D-only (its rig, its rope and
// its ledge overlay are all drawn on the top canvas) and nothing has asked for
// it in 3D yet. `?render=2d` forces the old path anywhere - it is the escape
// hatch for a machine with no working WebGL, and the mode `shot.html` and
// `cli shot` implicitly use.
const wants3d = (params.get("render") ?? (isBall ? "3d" : "2d")) === "3d";

// The alignment probe (`?probe3d=1`): a known world rect drawn as a box in the
// 3D scene and as an outline on the 2D overlay. They must coincide exactly, at
// every zoom and camera position (see `drawProbeOutline`). Placed at the spawn,
// so it is in frame the moment the page loads.
const wantsProbe = params.get("probe3d") !== null;

// A machine with no WebGL gets the 2D renderer rather than a blank page, so a
// failure here is a downgrade and never a crash.
const scene3d = ((): Scene3D | null => {
  if (!wants3d) return null;
  try {
    return new Scene3D(sceneCanvas);
  } catch (err) {
    console.warn("[render3d] WebGL unavailable, falling back to the 2D renderer:", err);
    return null;
  }
})();
if (!scene3d) sceneCanvas.style.display = "none";

function resize(): void {
  view = scene3d ? fitCanvas([sceneCanvas, canvas]) : fitCanvas(canvas);
  scene3d?.resize(view);
}

resize();
window.addEventListener("resize", resize);

// Replay mode (`?replay=NAME.json`, fetched from the dev server's public dir):
// feed a recorded session's input stream through the real frame loop instead of
// live input. Same fixed step, same renderer, same digests - it exists so a
// recorded perf complaint can be reproduced on the live page exactly, with
// `?hud=1`/`window.__perf` reading where the frames go. After the last recorded
// frame the final input repeats for ever, holding the end pose steady for a
// settled reading.
let replayFrames: FrameInput[] | null = null;
let replayIndex = 0;
const replayName = params.get("replay");
// The aim the RECORDED player had on the frame being replayed, drawn where the
// live reticle would be: a replay watched without it shows a ball steering
// itself. Null when the recording says "not aiming", which the ball's input
// source encodes as the ball's own position at sample time (see
// BallInputSource.sample); the replay is exact, so that is an equality test
// against the ball before the step.
let replayAim: Vec2 | null = null;

function recordedAim(l: Level | BallLevel, input: FrameInput): Vec2 | null {
  const aim = input.mouseWorldPosition;
  if (l instanceof BallLevel) {
    const origin = l.ball.globalPosition;
    if (aim.x === origin.x && aim.y === origin.y) return null;
  }
  return aim;
}

function makeLevel(): Level | BallLevel {
  return isBall ? new BallLevel(levelSpec.data) : new Level(levelSpec.data, levelSpec.init);
}

let level = makeLevel();

// The hook's sparks (see render/sparks.ts). One system for the session: it is
// fed the sim's per-frame events, advanced on the render clock, and cleared
// with the level.
const sparks = new SparkSystem();

// Runs this page has played: the input trace stamps its events with it, so a
// click can be laid beside the frames of the run it landed in.
let resets = 0;

function reset(): void {
  level = makeLevel();
  resets++;
  // A restart must not carry the dead level's embers.
  sparks.reset();
  level.onReset = reset;
  // A reset builds a new level, so it builds a new scene: every extrusion in it
  // belongs to bodies that no longer exist.
  buildScene();
  // Easing in from wherever the camera died would be a swoop across the level.
  cameraCtl.snap();
  recFrames.length = 0;
  recDigests.length = 0;
  recWorldDigests.length = 0;
}
level.onReset = reset;

let probeRect: { x: number; y: number; w: number; h: number } | null = null;

function buildScene(): void {
  if (!scene3d) return;
  scene3d.setLevel(level);
  if (wantsProbe) {
    const at = level.cameraRenderPosition(1);
    probeRect = { x: at.x, y: at.y, w: 4, h: 2 };
  }
  scene3d.setProbe(probeRect);
}
buildScene();

const ballInput = isBall
  ? new BallInputSource(canvas, camera, () => (level as BallLevel).ball.globalPosition)
  : null;
// The ball controller draws its own aim reticle (clamped to the chain's reach),
// so the OS cursor would be a second, misleading pointer — hide it.
if (isBall) canvas.style.cursor = "none";
const liveInput = isBall
  ? null
  : new LiveInputSource(canvas, camera, () => (level as Level).player.globalPosition);
const input: IInputSource = (ballInput ?? liveInput)!;

// The raw DOM button story, downloaded beside the frames (see
// input/inputTrace.ts): the frames say what the sim sampled, this says what
// the browser delivered, and a dropped click is found by which one lacks it.
const inputTrace = new InputTrace(
  canvas,
  () => ({ run: resets, frame: level.frame }),
  () => (isBall ? BUTTON_BITS.ball : BUTTON_BITS.grapple),
);
inputTrace.install();

// Full-session recording — press P to download a replayable bundle. A bundle
// must start at level start to replay deterministically, so the trace isn't
// trimmed; it resets whenever the level resets.
const recFrames: SerializedFrame[] = [];
const recDigests: Digest[] = [];
// The rest of the scene, at the same cadence — every rigid body and the chain,
// so a replay of this bundle is compared on the whole world rather than on the
// avatar alone (see WorldDigest).
const recWorldDigests: WorldDigest[] = [];
// The held mask of the most recent sampled frame, which is the hand the NEXT
// level's first frame is stepped from: the input source's previous-frame state
// survives a reset, so a jump still held on the frame after the one that reset
// the level is held, not pressed. A recording that begins there has to say so
// (see `Recording.heldAtStart`).
let lastHeld = 0;
let recHeldAtStart = 0;

function worldDigestOf(l: Level | BallLevel): WorldDigest {
  return l instanceof BallLevel ? worldDigestBall(l) : worldDigest(l);
}

// Production playtest recording (see playtest/recorder.ts): on in a production
// build, off while replaying, and `?record=1` / `?record=0` override either
// way so the whole path can be exercised against a local `serve.ts`.
const recordWanted =
  replayName === null && (params.has("record") ? params.get("record") !== "0" : import.meta.env.PROD);

function detectDevice(): Device {
  if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) return "touch";
  try {
    if (navigator.getGamepads?.().some((g) => g !== null)) return "gamepad";
  } catch {
    // Gamepad access can throw under a restrictive permissions policy; a mouse
    // is then as good a guess as any.
  }
  return "mouse";
}

// `?player=NAME` on an invite link names the first session; it is remembered so
// the name still arrives when the friend comes back by the bare URL.
function playerNick(): string | null {
  const fromUrl = params.get("player")?.trim().slice(0, 40) || null;
  try {
    if (fromUrl) localStorage.setItem("playtest.nick", fromUrl);
    return fromUrl ?? localStorage.getItem("playtest.nick");
  } catch {
    return fromUrl;
  }
}

const recorder = recordWanted
  ? new PlaytestRecorder(INGEST_PATH, {
      commit,
      dirty,
      srcHash,
      level: levelId,
      nick: playerNick(),
      device: detectDevice(),
      ua: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      render: scene3d ? "3d" : "2d",
    })
  : null;
recorder?.startRun(levelId, 0);

// Restart the level from outside a physics step: the page was hidden for long
// enough that continuing would be a run with a gap in it the fixed step never
// saw, or it came back out of the back/forward cache after its run was ended.
function restartRun(reason: EndReason | null): void {
  if (reason) recorder?.endRun(reason);
  reset();
  recHeldAtStart = lastHeld;
  recorder?.startRun(levelId, lastHeld);
}

let hiddenAt: number | null = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = performance.now();
    recorder?.flush(true);
  } else if (hiddenAt !== null) {
    const away = performance.now() - hiddenAt;
    hiddenAt = null;
    if (recorder?.isRunOpen && away > PAUSE_RESET_MS) restartRun("pause");
  }
});
window.addEventListener("pagehide", () => recorder?.endRun("unload", true));
window.addEventListener("pageshow", (e) => {
  if (e.persisted && recorder && !recorder.isRunOpen) restartRun(null);
});

function downloadRecording(): void {
  const rec: Recording = {
    level: levelId,
    git: commit,
    dirty,
    srcHash,
    heldAtStart: recHeldAtStart,
    frames: recFrames.slice(),
    digests: recDigests.slice(),
    worldDigests: recWorldDigests.slice(),
    inputTrace: inputTrace.bundle(),
  };
  // Before the file leaves: does this bundle reproduce HERE? The browser and bun
  // once disagreed on a 1e-17 m overlap and nothing in this path could know it,
  // so the disagreement surfaced hours later on someone else's machine and read
  // as a physics bug (see sim/selfReplay.ts). Run synchronously - a 1000-frame
  // ball session re-simulates in well under a second - and reported either way.
  rec.selfReplay = verifySelfReplay(rec);
  showToast(
    `session-${recFrames.length}f.json\n${selfReplayLine(rec.selfReplay)}`,
    rec.selfReplay.identical ? "ok" : "warn",
  );
  const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `session-${recFrames.length}f.json`;
  a.click();
  URL.revokeObjectURL(url);
}
// Debug overlay toggle. Render-side only — deliberately outside the
// deterministic FrameInput stream so toggling never affects recordings.
let showDebug = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "KeyP") downloadRecording();
  if (e.code === "KeyL") showDebug = !showDebug;
  if (e.code === "F3") {
    // The browser's own F3 is find-again; a game with an instrument panel on
    // that key does not want it.
    e.preventDefault();
    showPerfHud = !showPerfHud;
  }
});

// Three places a replay can come from: a file under `public/` (the original,
// for a bundle copied there by hand), `prod/<name>` for a pulled production run
// the dev server serves out of `playtests/prod/`, and `run:<id>` for a run
// fetched straight from the production store, which is what the admin page's
// Watch button opens. The last two are the same bundle at different distances.
function replaySource(name: string): string {
  if (name.startsWith("run:")) return `${ADMIN_API}/runs/${encodeURIComponent(name.slice(4))}`;
  if (name.startsWith("prod/")) return `/playtests/${name}`;
  return `/${name}`;
}

if (replayName) {
  void (async () => {
    const res = await fetch(replaySource(replayName));
    if (!res.ok) {
      showToast(`replay ${replayName}: ${res.status} ${res.statusText}`, "warn");
      return;
    }
    const rec = (await res.json()) as Recording;
    // A run played on a different tree is still worth watching, but it is
    // evidence about that tree and not this one, and the page says so before
    // the first frame rather than leaving it to be noticed.
    if (rec.srcHash && rec.srcHash !== srcHash) {
      showToast(`recorded on ${rec.git ?? rec.srcHash}, this page is ${commit}: the tree differs`, "warn");
    }
    const deserialize = recordingDeserializer(rec);
    const frames = rec.frames.map(deserialize);
    // A self-contained recording (level-editor export) carries its own
    // geometry; play it on that, not on the registry level the URL named.
    level = levelFromRecording(rec);
    level.onReset = reset;
    sparks.reset();
    buildScene();
    cameraCtl.snap();
    replayFrames = frames;
    replayIndex = 0;
  })();
}

let last = -1;
let accumulator = 0;
// The previous frame callback's wall time, spent in the interval this frame's
// `dt` measures (see `cpuMs` in the loop).
let lastCpuMs = 0;
let fps = 0;

// What the renderer is costing on THIS machine, which is the one thing a
// headless grab cannot report (see render/perfProbe.ts). `window.__perf` is a
// live handle a script can read; the HUD puts the same numbers on the overlay
// for a human. The probe itself is always on - it is a few adds a frame and one
// sort a second - and only the HUD is opt-in.
const perf = new PerfProbe();
(window as unknown as { __perf: typeof perf.snapshot }).__perf = perf.snapshot;
// `?hud=1` opens the page with it up; F3 toggles it while playing, because the
// frames worth looking at are the ones being played rather than the ones after a
// reload with a different URL.
let showPerfHud = params.get("hud") !== null;

// The JS heap, read on its own slow cadence. `performance.memory` is a
// Chromium-only getter that walks bookkeeping rather than reading a counter, and
// the heap is a level that moves in seconds - reading it every frame would put
// the HUD's own cost into the frame it is measuring. Null everywhere the getter
// does not exist, which the HUD reports as unavailable rather than as 0 MB.
const HEAP_POLL_MS = 250;
let heapMb: number | null = null;
let heapLimitMb: number | null = null;
let heapPolledAt = -Infinity;

function pollHeap(now: number): void {
  if (now - heapPolledAt < HEAP_POLL_MS) return;
  heapPolledAt = now;
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (!memory) return;
  heapMb = memory.usedJSHeapSize / (1024 * 1024);
  heapLimitMb = memory.jsHeapSizeLimit / (1024 * 1024);
}

function frame(now: number): void {
  // The whole callback's wall time, which is the HUD's "cpu": the share of each
  // frame the main thread is actually busy in. Everything below is inside it,
  // the panel's own drawing included - an instrument that leaves its own cost
  // out of the reading is the wrong instrument.
  const cpuT0 = performance.now();
  // LAST frame's callback over THIS frame's dt, because that is the interval it
  // was spent in: `dt` is the gap since the previous callback started, so the
  // work it contains is the previous callback's. Dividing a callback by the dt
  // measured before it ran reported 339% busy for one 30 ms frame that followed
  // a 9 ms one - a ratio of two different intervals, and a number that cannot
  // mean anything.
  const cpuMs = lastCpuMs;
  if (last < 0) last = now;
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  accumulator += dt;

  // Exponential moving average of the render frame rate.
  if (dt > 0) fps += ((1 / dt) - fps) * 0.1;

  let steps = 0;
  let simMs = 0;
  while (accumulator >= STEP && steps < MAX_STEPS_PER_FRAME) {
    const frameInput: FrameInput = replayFrames
      ? replayFrames[Math.min(replayIndex++, replayFrames.length - 1)]!
      : input.sample();
    if (replayFrames) replayAim = recordedAim(level, frameInput);
    const simT0 = performance.now();
    const stepped = level;
    level.physicsProcess(frameInput, STEP);
    simMs += performance.now() - simT0;
    // Drained inside the catch-up loop rather than after it: a frame that runs
    // several steps would otherwise silently drop every caught-up step's events.
    sparks.ingest(level.sparkEvents);
    const serialized = serializeInput(frameInput);
    lastHeld = serialized.h;
    if (level !== stepped) {
      // The step reset the level (a jump press, or the kill zone). The input
      // belongs to the run that just ended - the old level stepped it - and the
      // fresh level has not seen it, so it is not the first frame of the new run.
      // Recording it as one is what made runs after a reset replay a frame out.
      recorder?.frame(serialized);
      recorder?.digest(worldDigestOf(stepped));
      recorder?.endRun(frameInput.jump.pressed ? "reset" : "kill");
      recHeldAtStart = serialized.h;
      recorder?.startRun(levelId, serialized.h);
    } else {
      recFrames.push(serialized);
      recDigests.push(level instanceof BallLevel ? digestBall(level) : digest(level));
      const wd = worldDigestOf(level);
      recWorldDigests.push(wd);
      recorder?.frame(serialized);
      if (level.frame % DIGEST_EVERY === 0) recorder?.digest(wd);
    }
    accumulator -= STEP;
    steps++;
  }
  // Debt beyond what the capped loop repaid is dropped, keeping only the
  // sub-step remainder for interpolation. Banking it is what turned overload
  // into a death spiral (see MAX_STEPS_PER_FRAME); dropping it means a machine
  // that cannot run 60 sim steps a second plays slightly slowed down instead of
  // at a slideshow frame rate. Recorded bundles are untouched - they capture
  // executed steps, and shedding executes none.
  if (accumulator >= STEP) accumulator %= STEP;
  // Render interpolation: how far past the last completed physics step this
  // frame lands. The sim runs at a fixed 60 Hz; drawing its raw state on a
  // faster display repeats and skips frames, which reads as jitter.
  const alpha = Math.min(1, accumulator / STEP);

  // Once per rendered frame, on the render clock: the sparks are outside the
  // fixed step entirely, like the camera ease.
  sparks.advance(dt);

  // Camera: eased follow of the avatar, reshaped by the level's camera regions.
  // Driven by the render dt, so it is frame-rate independent and outside the
  // deterministic fixed step. The default framing centres the avatar; shifting
  // it is a camera region's job (offsetX/offsetY), not a per-controller rule.
  // It follows the *interpolated* avatar, so the two never disagree on screen.
  cameraCtl.update(
    camera,
    dt,
    level.cameraRenderPosition(alpha),
    level.cameraRules,
    baseZoom,
    level.cameraAnchored,
  );

  // Poll-based aim (gamepad sticks) refreshes per rendered frame, not per
  // physics step, so the reticle/crosshair moves at display rate on a monitor
  // faster than the 60 Hz sim.
  input.pollAim?.();

  // The 3D scene first, then the 2D canvas over it. Both read the same
  // interpolated state at the same `alpha` and the same camera, so they are one
  // picture rather than two that agree most of the time.
  const draw3dT0 = performance.now();
  scene3d?.render(level, camera, alpha);
  const draw3dMs = performance.now() - draw3dT0;

  const draw2dT0 = performance.now();
  if (level instanceof BallLevel) {
    renderBall(
      ctx,
      view,
      level,
      camera,
      fps,
      replayFrames ? replayAim : ballInput!.aimPoint(),
      alpha,
      scene3d !== null,
      sparks,
    );
  } else {
    render(
      ctx,
      view,
      level,
      camera,
      fps,
      showDebug,
      replayFrames ? replayAim : liveInput!.crosshairAim(),
      alpha,
      cameraCtl.held,
      scene3d !== null,
      sparks,
    );
  }
  const draw2dMs = performance.now() - draw2dT0;

  if (probeRect) drawProbeOutline(ctx, view, camera, probeRect);

  // The panel reads the readings the LAST frame produced, which is what lets the
  // sample below cover this frame's own drawing of it.
  if (showPerfHud) drawPerfHud(ctx, view, perf.snapshot, perf.history);

  // After the frame is drawn, so the draw-call and triangle counts are this
  // frame's rather than the last one's, and so the CPU figure covers all of it.
  pollHeap(now);
  perf.sample(dt, scene3d?.renderStats() ?? null, {
    simMs,
    draw3dMs,
    draw2dMs,
    cpuMs,
    // The GPU's own clock, from a query that retired a frame or two ago (see
    // render/gpuTimer.ts). Null on the 2D path, which has no WebGL context to
    // ask.
    gpuMs: scene3d?.gpuFrameMs() ?? null,
    heapMb,
    heapLimitMb,
  });

  lastCpuMs = performance.now() - cpuT0;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
