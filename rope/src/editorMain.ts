// Entry point for the /editor page: boots the level editor on the canvas.
import { startEditor } from "./editor/editor";

// Two canvases on one rectangle (see editor.html): the WebGL scene underneath
// and the editor's own 2D canvas on top. The editor decides whether the scene is
// drawn at all - its view toggle has a 2D mode that is exactly today's editor.
const canvas = document.getElementById("game") as HTMLCanvasElement;
const sceneCanvas = document.getElementById("scene") as HTMLCanvasElement;
startEditor(canvas, sceneCanvas);
