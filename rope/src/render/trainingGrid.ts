// Smash Ultimate "training mode" backdrop: light graph paper with a fine minor
// grid, heavier major grid, bold red origin axes, and blue value lines labelled
// at every 5 world units (with "0" at the origin). Drawn in screen space before
// the world transform, so it fills the viewport at any camera pan/zoom.

import { PIXELS_PER_METER } from "../engine/units";
import type { Camera } from "./camera";

const BG = "#eef0f2";
const MINOR = "#d5dae0";
const MAJOR = "#aab2bd";
const VALUE = "#3f6fd6"; // blue lines/labels at multiples of 5
const AXIS = "#e23b3b"; // red origin cross

const MINOR_M = 0.1; // fine cell size — 10 minor lines per metre
const MAJOR_M = 1.0; // heavy grid line every metre
const VALUE_M = 5.0; // bold blue labelled line every 5 metres

export function drawTrainingGrid(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  w: number,
  h: number,
): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  const scale = cam.zoom * PIXELS_PER_METER;
  const left = cam.position.x - w / 2 / scale;
  const right = cam.position.x + w / 2 / scale;
  const top = cam.position.y - h / 2 / scale;
  const bottom = cam.position.y + h / 2 / scale;
  const sx = (x: number) => (x - cam.position.x) * scale + w / 2;
  const sy = (y: number) => (y - cam.position.y) * scale + h / 2;

  // One grid pass: vertical + horizontal lines at `step`, skipped when denser
  // than `minPx` on screen (would smear into a solid block).
  function pass(step: number, color: string, width: number, minPx: number): void {
    if (step * scale < minPx) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
      const px = Math.round(sx(x)) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }
    for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
      const py = Math.round(sy(y)) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
    }
    ctx.stroke();
  }

  pass(MINOR_M, MINOR, 1, 5);
  pass(MAJOR_M, MAJOR, 1, 5);
  pass(VALUE_M, VALUE, 2, 24);

  // Bold red origin axes.
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  const ox = Math.round(sx(0)) + 0.5;
  const oy = Math.round(sy(0)) + 0.5;
  ctx.moveTo(ox, 0);
  ctx.lineTo(ox, h);
  ctx.moveTo(0, oy);
  ctx.lineTo(w, oy);
  ctx.stroke();

  // Value labels along the axes: blue numbers at each ±5 line, "0" at origin.
  ctx.font = "bold 22px monospace";
  ctx.textBaseline = "middle";
  const labelY = Math.min(h - 16, Math.max(16, oy)); // clamp to the visible x-axis
  const labelX = Math.min(w - 16, Math.max(16, ox)); // clamp to the visible y-axis

  ctx.fillStyle = VALUE;
  ctx.textAlign = "center";
  for (let x = Math.ceil(left / VALUE_M) * VALUE_M; x <= right; x += VALUE_M) {
    if (Math.abs(x) < 1e-6) continue;
    ctx.fillText(String(Math.abs(Math.round(x))), sx(x), labelY);
  }
  ctx.textAlign = "left";
  for (let y = Math.ceil(top / VALUE_M) * VALUE_M; y <= bottom; y += VALUE_M) {
    if (Math.abs(y) < 1e-6) continue;
    ctx.fillText(String(Math.abs(Math.round(y))), labelX + 6, sy(y));
  }

  // Origin marker.
  ctx.fillStyle = AXIS;
  ctx.textAlign = "left";
  ctx.fillText("0", labelX + 6, labelY);

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}
