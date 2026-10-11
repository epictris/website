import type { VineCord } from "../level/vines";
import { Vec2 } from "../engine/vec2";
import { restStarberries } from "../level/starberry";
import { naturalStemPoint, starberryLeaves, stemFraction } from "./starberryArt";

/** Canvas fallback and editor overlay use the same fruit poses as the 3D mesh. */
export function drawStarberry(ctx: CanvasRenderingContext2D, vine: VineCord, alpha: number): void {
  const settings = vine.starberry;
  if (!settings) return;
  const path: Vec2[] = []; vine.path(alpha, path);
  if (path.length < 2) return;
  const berries = vine.berryPoses?.(alpha) ?? restStarberries(path, settings);
  ctx.save(); ctx.lineCap = "round"; ctx.strokeStyle = "#646245";
  let length = 0;
  for (let i = 1; i < path.length; i++) length += path[i]!.distanceTo(path[i - 1]!);
  const segments = Math.max(8, Math.min(350, Math.ceil(length / 0.045)));
  for (let i = 0; i < segments; i++) {
    const a = naturalStemPoint(path, i / segments, settings.seed);
    const b = naturalStemPoint(path, (i + 1) / segments, settings.seed);
    ctx.lineWidth = 0.082 - i / segments * 0.048;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (const [i, leaf] of starberryLeaves(path, settings, berries).entries()) {
    ctx.lineWidth = 0.008; ctx.beginPath(); ctx.moveTo(leaf.root.x, leaf.root.y);
    ctx.lineTo(leaf.base.x, leaf.base.y); ctx.stroke();
    ctx.save(); ctx.translate(leaf.base.x, leaf.base.y); ctx.rotate(-leaf.angle);
    ctx.scale(leaf.size, leaf.size); ctx.fillStyle = ["#4d6040", "#67764c", "#526c47"][i % 3]!;
    ctx.beginPath(); ctx.moveTo(0, 0.13);
    ctx.bezierCurveTo(-0.26, -0.12, -0.58, 0.1, -0.46, 0.43);
    ctx.bezierCurveTo(-0.36, 0.71, -0.11, 0.82, 0, 1);
    ctx.bezierCurveTo(0.12, 0.8, 0.38, 0.68, 0.46, 0.43);
    ctx.bezierCurveTo(0.58, 0.1, 0.26, -0.12, 0, 0.13); ctx.fill(); ctx.restore();
  }
  for (const [i, berry] of berries.entries()) {
    const root = naturalStemPoint(path, stemFraction(path, berry.root), settings.seed);
    const end = berry.fruit.add(root.sub(berry.fruit).normalized().mul(settings.radius * 0.45));
    const side = i % 2 ? 1 : -1;
    ctx.lineWidth = 0.055; ctx.strokeStyle = "#646245"; ctx.beginPath();
    ctx.moveTo(root.x, root.y);
    ctx.bezierCurveTo(root.x + (end.x - root.x) * 0.25 + side * 0.025, root.y - 0.055,
      end.x + (root.x - end.x) * 0.2, end.y - 0.045, end.x, end.y); ctx.stroke();
    const { x, y } = berry.fruit, r = settings.radius;
    const glow = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 2.9);
    glow.addColorStop(0, `rgba(255,184,40,${Math.min(0.85, settings.glow * 0.5)})`);
    glow.addColorStop(1, "rgba(255,184,40,0)"); ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, r * 2.9, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, radius = r * (i % 2 ? 0.53 : 1);
      const px = x + Math.cos(a) * radius, py = y + Math.sin(a) * radius;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fillStyle = berry.held ? "#fff0a0" : "#ffd15c"; ctx.fill();
    ctx.strokeStyle = "#c88725"; ctx.lineWidth = 0.014; ctx.stroke();
  }
  ctx.restore();
}
