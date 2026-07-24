// Entry point for the /editor page: boots the level editor on the canvas.
import { startEditor } from "./editor/editor";

const canvas = document.getElementById("game") as HTMLCanvasElement;
startEditor(canvas);
