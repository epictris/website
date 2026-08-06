// Frame grabber (dev only): replays a recorded bundle to one frame - or to a run
// of frames - and draws it with the REAL renderer, so a headless screenshot
// shows exactly what the game shows. `cli render` cannot: it draws its own SVG
// of the sim state, which is the right tool for geometry and blind to everything
// the canvas does on top. The chain wound onto the ball drew as empty space for
// want of one `floor` (see `drawChainPolyline`), and no CLI tool could have seen
// it.
//
//   /shot.html?bundle=/playtests/bundles/session-1474f.json&frame=300&zoom=9
//   /shot.html?bundle=...&frames=60..120&every=10&render=3d      (a filmstrip)
//
// `&render=3d` grabs the same frame through the WebGL renderer instead (see
// render3d/scene.ts), which is the only way to evidence a claim about the 3D
// scene: every other headless view draws its own picture of the sim state and is
// therefore blind to the renderer entirely.
//
// THE PAGE'S CONSOLE IS PART OF THE ANSWER. `shot.html` installs a log buffer
// before this module is even fetched, and everything below reports through
// `console.*` so the harness reads one channel; an `error` in it fails the
// command, because a screenshot taken over a page error is the most misleading
// possible answer to "does this look right".
//
// `shot.html` is deliberately absent from the build's rollup inputs, so this
// costs the shipped app nothing.
import { render, renderBall } from "./render/renderer";
import { Scene3D } from "./render3d/scene";
import { assetsSettled, pendingAssets } from "./render3d/assets";
import { BallLevel } from "./level/ballLevel";
import type { Level } from "./level/level";
import { levelFromRecording } from "./sim/replay";
import { inputDeserializer, type Recording } from "./sim/trace";
import { BALL_ZOOM, GRAPPLE_ZOOM, type Camera } from "./render/camera";
import { fitCanvas, LETTERBOX_COLOR, VIEW_HEIGHT, VIEW_WIDTH } from "./render/viewport";

interface ShotLogEntry {
  level: string;
  text: string;
}
const shotLog = ((window as unknown as { __shotLog?: ShotLogEntry[] }).__shotLog ??= []);

// How often the page says what it is still waiting for. The 2026-08-04 hang (an
// asset promise that never settled) printed nothing at all, for ever: the
// command sat at its virtual-time budget and came back with a blank picture, so
// a hang and a slow load looked identical.
//
// It reports rather than gives up, and the wall-clock ceiling stays with the
// harness (`cli shot --timeout`), because the page has no honest clock to give
// up by: under `Emulation.setVirtualTimePolicy` its timers run at whatever speed
// the work allows, and twenty virtual seconds go by inside one mesh decode. A
// budget measured on that clock fails perfectly healthy loads.
const ASSET_REPORT_MS = 5000;
const ASSET_REPORTS_MAX = 6;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const q = new URLSearchParams(location.search);
const use3d = q.get("render") === "3d";

// The same fixed 16:9 frame the game draws into, so a grab is what the player is
// shown — a window-shaped canvas would frame the scene differently from the game
// and quietly change what the picture is evidence of.
const view = use3d ? fitCanvas([sceneCanvas, canvas]) : fitCanvas(canvas);

const rec = (await (await fetch(q.get("bundle")!)).json()) as Recording;
const level = levelFromRecording(rec);
const de = inputDeserializer();

// Which frames to draw. `frame=N` is one grab; `frames=A..B` with `every=K` is a
// filmstrip - one page load, one chromium session, N tiles - because a single
// frame cannot show flashing, flicker or the speed something flows at, and those
// were left to the user's eye across nine rejection rounds for exactly that
// reason.
const range = /^(\d+)\.\.(\d+)$/.exec(q.get("frames") ?? "");
const requestedEvery = Number(q.get("every") ?? 1);
const every = Number.isFinite(requestedEvery) ? Math.max(1, Math.floor(requestedEvery)) : 1;
const lastFrame = rec.frames.length;
const clampFrame = (n: number): number => Math.max(0, Math.min(n, lastFrame));
const frames: number[] = [];
if (range) {
  for (let f = clampFrame(Number(range[1])); f <= clampFrame(Number(range[2])); f += every) {
    frames.push(f);
  }
} else {
  frames.push(clampFrame(Number(q.get("frame") ?? 1)));
}
// An inverted or out-of-range span asks for no frames at all, which would draw a
// zero-sized filmstrip. Say so and grab the one frame it named instead: an
// unreadable error beats an image of nothing.
if (frames.length === 0) {
  console.error(`frames=${q.get("frames")} selects no frame of ${lastFrame}; drawing the first`);
  frames.push(clampFrame(Number(range![1])));
}

const isBall = level instanceof BallLevel;
const camera: Camera = {
  position: level.cameraRenderPosition(1),
  zoom: Number(q.get("zoom") ?? (isBall ? BALL_ZOOM : GRAPPLE_ZOOM)),
  viewportWidth: VIEW_WIDTH,
  viewportHeight: VIEW_HEIGHT,
};

// Diagnostics on: shader compile failures reported into the page log, and a
// readable drawing buffer so the tiles below and the blank-frame check can read
// what was actually drawn.
const scene3d = use3d ? new Scene3D(sceneCanvas, { diagnostics: true }) : null;
if (scene3d) {
  scene3d.resize(view);
  scene3d.setLevel(level);
  // Props and authored texture maps arrive asynchronously, and in the GAME that
  // is the point - the placeholder box and the generated surface cover the gap.
  // A grab may not do the same: photographing whichever assets happened to have
  // arrived makes the same command produce different images on different runs,
  // so it is evidence of nothing. Wait for the scene to be dressed, then draw.
  await settleAssets();
  // Every material through the compiler before the first grab, so a program
  // belonging to something off screen this frame still reports its errors here
  // rather than whenever the camera happens to reach it.
  await scene3d.compilePrograms();
}

// Replay to the first frame wanted, then draw each in turn.
let simFrame = 0;
const advanceTo = (target: number): void => {
  for (; simFrame < target; simFrame++) level.physicsProcess(de(rec.frames[simFrame]!), 1 / 60);
};

if (frames.length === 1) {
  advanceTo(frames[0]!);
  drawFrame(frames[0]!);
} else {
  drawFilmstrip();
}

reportErrors();
// Polled by the screenshotting harness over CDP: the page is done drawing.
(window as unknown as { shotReady: boolean }).shotReady = true;

// ---------------------------------------------------------------------------

// One frame, drawn exactly as the game draws it. Stepped with `alpha = 1`: the
// frame is drawn at the sim state exactly, never interpolated, so two grabs of
// the same frame are the same image.
function drawFrame(frame: number): void {
  camera.position = level.cameraRenderPosition(1);
  if (scene3d) {
    // Freeze the wall clock, and advance it with the SIM from the first frame
    // drawn. The flicker and the water are the parts of the 3D scene driven by
    // the wall rather than by the step, so left alone the same command produces
    // a different exposure every run - and pinned at a CONSTANT, a filmstrip
    // would draw them frozen while everything else moved, which is a picture of
    // something the game never does.
    //
    // Measured from the first frame rather than from frame 0, so a single grab
    // pins it at exactly 0 as it always has and its PNG is unchanged.
    scene3d.pinClock((frame - frames[0]!) / 60);
    scene3d.render(level, camera, 1);
    // A frame that drew nothing is a valid PNG and a lie: `shot --3d` at f35+
    // has come back uniformly blank while the 2D path rendered the same frame
    // fine. Say so where the harness can fail on it.
    const lit = scene3d.litFraction();
    if (lit < 0.001) {
      console.error(
        `blank 3D frame at f${frame}: ${(lit * 100).toFixed(3)}% of the drawing buffer is not black`,
      );
    }
  }
  if (isBall) {
    renderBall(ctx, view, level, camera, 60, null, 1, scene3d !== null);
  } else {
    render(ctx, view, level as Level, camera, 60, false, null, 1, null, scene3d !== null);
  }
}

// A run of frames as one image: one page load, one chromium session, and a
// changed-pixel count between adjacent tiles printed by the CLI. A flashing
// artifact is a spike pattern in that series and a steady flow is a flat one -
// neither of which a single grab can show at all.
function drawFilmstrip(): void {
  // At most this many columns, and enough of them that the grid fits the frame:
  // with `c` columns the tiles are (1920/c) x (1080/c), so `ceil(n/c) <= c` is
  // what keeps the whole strip inside one 1920x1080 grab.
  const cols = Math.max(1, Math.ceil(Math.sqrt(frames.length)));
  const rows = Math.ceil(frames.length / cols);
  const tileW = Math.floor(VIEW_WIDTH / cols);
  const tileH = Math.floor(VIEW_HEIGHT / cols);

  const strip = document.createElement("canvas");
  strip.width = tileW * cols;
  strip.height = tileH * rows;
  const stripCtx = strip.getContext("2d", { willReadFrequently: true })!;
  stripCtx.fillStyle = LETTERBOX_COLOR;
  stripCtx.fillRect(0, 0, strip.width, strip.height);

  let previous: ImageData | null = null;
  const changed: number[] = [];
  frames.forEach((frame, i) => {
    advanceTo(frame);
    drawFrame(frame);
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * tileH;
    // The composite, in the order the page stacks it: the WebGL scene, then the
    // 2D overlay over it. Blitting one alone photographs half the picture.
    if (scene3d) stripCtx.drawImage(sceneCanvas, x, y, tileW, tileH);
    stripCtx.drawImage(canvas, x, y, tileW, tileH);

    // Read BEFORE the tile is labelled: the label is different text on every
    // tile, so counting it would report motion the game never drew.
    const tile = stripCtx.getImageData(x, y, tileW, tileH);
    if (previous) changed.push(changedPixels(previous, tile));
    previous = tile;

    // A strip of frames with nothing between them reads as one picture. The
    // rule and the frame number are what make it a strip - and what let a
    // printed diff count be matched to the pair it came from.
    stripCtx.strokeStyle = "#00000080";
    stripCtx.lineWidth = 2;
    stripCtx.strokeRect(x + 1, y + 1, tileW - 2, tileH - 2);
    stripCtx.font = "16px monospace";
    stripCtx.textAlign = "left";
    stripCtx.textBaseline = "top";
    stripCtx.fillStyle = "#000000a0";
    stripCtx.fillRect(x + 4, y + 4, 52, 22);
    stripCtx.fillStyle = "#ffffff";
    stripCtx.fillText(`f${frame}`, x + 8, y + 7);
  });

  // The strip replaces what is on screen. The overlay canvas is the top one and
  // is painted opaque here, so nothing of the last frame shows through.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = LETTERBOX_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / strip.width, canvas.height / strip.height);
  ctx.drawImage(
    strip,
    (canvas.width - strip.width * scale) / 2,
    (canvas.height - strip.height * scale) / 2,
    strip.width * scale,
    strip.height * scale,
  );

  // Reported as data rather than as a picture: the CLI prints the series and the
  // min/median/max, and nothing gates on it. This is `--diff` for motion - it
  // makes the claim cheap to evidence, not assertable.
  console.log(
    `motion ${JSON.stringify({
      frames,
      tile: { width: tileW, height: tileH },
      changed,
    })}`,
  );
}

// Pixels that differ between two tiles, in TILE pixels (the strip is a scaled
// composite, so this is a measure of how much moved rather than a count of
// screen pixels). The threshold is what stops a shading gradient's last bit
// reading as motion.
function changedPixels(a: ImageData, b: ImageData): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i]! - b.data[i]!) > 8 ||
      Math.abs(a.data[i + 1]! - b.data[i + 1]!) > 8 ||
      Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 8
    ) {
      n++;
    }
  }
  return n;
}

// Wait for the scene's assets, naming what is outstanding as it goes. Waiting
// for ever is the one outcome with no report at all - and the harness's timeout
// is what turns a wait that never ends into a failed command, with these lines
// as the reason.
async function settleAssets(): Promise<void> {
  let settled = false;
  let reports = 0;
  const tick = setInterval(() => {
    if (settled || reports++ >= ASSET_REPORTS_MAX) {
      clearInterval(tick);
      return;
    }
    console.warn(`still waiting for assets: ${pendingAssets().join(", ") || "(nothing named)"}`);
  }, ASSET_REPORT_MS);
  await assetsSettled();
  settled = true;
  clearInterval(tick);
}

// A blank or wrong PNG has to say why it is wrong, on its own face: the artifact
// travels (into a diff, into a report) without the console that explains it, and
// a silently blank image reads as "the renderer drew nothing" rather than as
// "the shader did not compile".
function reportErrors(): void {
  const errors = shotLog.filter((e) => e.level === "error");
  if (errors.length === 0) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  const scale = canvas.width / VIEW_WIDTH;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#8b1a1a";
  ctx.fillRect(0, 0, VIEW_WIDTH, 34 + 22 * Math.min(errors.length, 3));
  ctx.fillStyle = "#ffffff";
  ctx.font = "18px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`PAGE ERROR (${errors.length}) - this image is not evidence`, 12, 8);
  errors.slice(0, 3).forEach((e, i) => {
    ctx.fillText(e.text.split("\n")[0]!.slice(0, 150), 12, 34 + 22 * i);
  });
  ctx.restore();
}
