// Visual debugger: renders the REAL table (render.ts) and overlays the ACTUAL
// physics collision geometry so the two can be aligned. Bundle with:
//   bun build src/debug-table.ts --outfile <out>.js
// then open a page with <canvas id="c"> that loads the bundle.
import { drawScene, layoutFor, type Layout } from "./render";
import {
  CUSHION_SEGS,
  POCKET_LIST,
  R,
  rackWorld,
  type Vec,
} from "./physics";

const scale = 360;
const layout: Layout = layoutFor(scale, false);
const cv = document.getElementById("c") as HTMLCanvasElement;
cv.width = layout.W;
cv.height = layout.H;
const ctx = cv.getContext("2d")!;

// 1. The real rendered table + rack.
drawScene(ctx, { world: rackWorld(), layout });

// 2. Overlay collision geometry.
const tp = (p: Vec) => ({ x: layout.ox + p.x * scale, y: layout.oy + p.y * scale });

// Cushion collision segments — the ball-CENTRE polygon it bounces off (inset R).
ctx.strokeStyle = "#ff3b3b";
ctx.lineWidth = 2;
for (const s of CUSHION_SEGS) {
  const a = tp(s.a);
  const b = tp(s.b);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

// Pocket pot circles — where a ball's CENTRE must reach to drop.
ctx.strokeStyle = "#39ff88";
ctx.lineWidth = 2;
for (const pk of POCKET_LIST) {
  const c = tp(pk.center);
  ctx.beginPath();
  ctx.arc(c.x, c.y, pk.hole * scale, 0, Math.PI * 2);
  ctx.stroke();
}

// A reference ball touching the top cushion (centre on the collision line).
ctx.strokeStyle = "#ffdd33";
const bc = tp({ x: 0.3, y: R });
ctx.beginPath();
ctx.arc(bc.x, bc.y, R * scale, 0, Math.PI * 2);
ctx.stroke();

// Legend.
ctx.font = "12px monospace";
ctx.fillStyle = "#ff3b3b";
ctx.fillText("red = cushion collision line", 8, layout.H - 44);
ctx.fillStyle = "#39ff88";
ctx.fillText("green = pocket pot circle", 8, layout.H - 28);
ctx.fillStyle = "#ffdd33";
ctx.fillText("yellow = ball radius", 8, layout.H - 12);
