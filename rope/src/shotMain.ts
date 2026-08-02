// Frame grabber (dev only): replays a recorded bundle to one frame and draws it
// with the REAL renderer, so a headless screenshot shows exactly what the game
// shows. `cli render` cannot: it draws its own SVG of the sim state, which is
// the right tool for geometry and blind to everything the canvas does on top.
// The chain wound onto the ball drew as empty space for want of one `floor`
// (see `drawChainPolyline`), and no CLI tool could have seen it.
//
//   /shot.html?bundle=/playtests/bundles/session-1474f.json&frame=300&zoom=9
//
// `&render=3d` grabs the same frame through the WebGL renderer instead (see
// render3d/scene.ts), which is the only way to evidence a claim about the 3D
// scene: every other headless view draws its own picture of the sim state and is
// therefore blind to the renderer entirely.
//
// `shot.html` is deliberately absent from the build's rollup inputs, so this
// costs the shipped app nothing.
import { render, renderBall } from "./render/renderer";
import { Scene3D } from "./render3d/scene";
import { BallLevel } from "./level/ballLevel";
import type { Level } from "./level/level";
import { levelFromRecording } from "./sim/replay";
import { inputDeserializer, type Recording } from "./sim/trace";
import { BALL_ZOOM, GRAPPLE_ZOOM, type Camera } from "./render/camera";
import { fitCanvas, VIEW_HEIGHT, VIEW_WIDTH } from "./render/viewport";

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
// Stepped with `alpha = 1` below: the frame is drawn at the sim state exactly,
// never interpolated, so two grabs of the same frame are the same image.
const frame = Math.min(Number(q.get("frame") ?? 1), rec.frames.length);
for (let i = 0; i < frame; i++) level.physicsProcess(de(rec.frames[i]!), 1 / 60);

const isBall = level instanceof BallLevel;
const camera: Camera = {
  position: level.cameraRenderPosition(1),
  zoom: Number(q.get("zoom") ?? (isBall ? BALL_ZOOM : GRAPPLE_ZOOM)),
  viewportWidth: VIEW_WIDTH,
  viewportHeight: VIEW_HEIGHT,
};
const scene3d = use3d ? new Scene3D(sceneCanvas) : null;
if (scene3d) {
  scene3d.resize(view);
  scene3d.setLevel(level);
  scene3d.render(level, camera, 1);
}
if (isBall) {
  renderBall(ctx, view, level, camera, 60, null, 1, scene3d !== null);
} else {
  render(ctx, view, level as Level, camera, 60, false, null, 1, null, scene3d !== null);
}
// Polled by the screenshotting harness: the page is done drawing.
(window as unknown as { shotReady: boolean }).shotReady = true;
