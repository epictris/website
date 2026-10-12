import type { VineCord } from "../level/vines";
import { Vec2 } from "../engine/vec2";
import { restStarberries } from "../level/starberry";
import { naturalStemPoint, roundBerryAttachment, starberryLeaves, stemFraction } from "./starberryArt";

/** Canvas fallback and editor overlay use the same fruit poses as the 3D mesh. */
export function drawStarberry(ctx: CanvasRenderingContext2D, vine: VineCord, alpha: number): void {
  const settings = vine.starberry;
  if (!settings) return;
  const path: Vec2[] = []; vine.path(alpha, path);
  if (path.length < 2) return;
  const berries = vine.berryPoses?.(alpha) ?? restStarberries(path, settings);
  const round = settings.appearance === "round";
  ctx.save(); ctx.lineCap = "round"; ctx.strokeStyle = "#646245";
  let length = 0;
  for (let i = 1; i < path.length; i++) length += path[i]!.distanceTo(path[i - 1]!);
  const segments = Math.max(8, Math.min(350, Math.ceil(length / 0.045)));
  for (let i = 0; i < segments; i++) for (let strand = 0; strand < (round ? 2 : 1); strand++) {
    let a = naturalStemPoint(path, i / segments, settings.seed);
    let b = naturalStemPoint(path, (i + 1) / segments, settings.seed);
    ctx.lineWidth = 0.082 - i / segments * 0.048;
    if (round) {
      const offset = (f: number) => Math.cos(f * length * 10 + Math.sin(f * 11) * 0.7 + settings.seed * 0.1 + strand * Math.PI)
        * (0.034 - f * 0.023) * Math.min(1, (1 - f) * 18);
      a = a.add(new Vec2(offset(i / segments), 0)); b = b.add(new Vec2(offset((i + 1) / segments), 0));
      ctx.lineWidth *= strand ? 0.57 : 0.78;
      ctx.strokeStyle = strand ? "#667443" : "#87905a";
    }
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
    const attachment = roundBerryAttachment(root, berry.fruit, settings.radius), axis = attachment.axis;
    const end = round ? attachment.end
      : berry.fruit.add(root.sub(berry.fruit).normalized().mul(settings.radius * 0.45));
    const side = settings.sides?.[i] ?? (i % 2 ? 1 : -1);
    ctx.lineWidth = 0.055; ctx.strokeStyle = "#646245"; ctx.beginPath();
    ctx.moveTo(root.x, root.y);
    ctx.bezierCurveTo(root.x + (end.x - root.x) * 0.25 + side * 0.025, root.y - 0.055,
      round ? attachment.control.x : end.x + (root.x - end.x) * 0.2,
      round ? attachment.control.y : end.y - 0.045, end.x, end.y); ctx.stroke();
    const { x, y } = berry.fruit, r = settings.radius;
    const haloRadius = r * (round ? 2.25 : 2.9);
    const glow = ctx.createRadialGradient(x, y, r * 0.3, x, y, haloRadius);
    glow.addColorStop(0, `rgba(255,184,40,${Math.min(0.85, settings.glow * (round ? 0.28 : 0.5))})`);
    glow.addColorStop(1, "rgba(255,184,40,0)"); ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(x, y, haloRadius, 0, Math.PI * 2); ctx.fill();
    if (round) {
      ctx.save(); ctx.beginPath();
      ctx.ellipse(x + r * 0.025, y, r * 0.91, r, Math.atan2(axis.x, -axis.y), 0, Math.PI * 2); ctx.clip();
      const body = ctx.createRadialGradient(x - r * 0.15, y + r * 0.1, r * 0.05, x, y, r);
      body.addColorStop(0, "#ffe5a0"); body.addColorStop(0.5, "#edb94e"); body.addColorStop(1, "#b57929");
      ctx.fillStyle = body; ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(axis.x, -axis.y));
      for (const side of [-1, 1, -0.5, 0.5, 0]) {
        ctx.fillStyle = side === 0 ? "#6e8140" : "#4f6335";
        ctx.beginPath(); ctx.moveTo(0, -r * 1.04);
        ctx.bezierCurveTo(side * r * 0.35 - r * 0.22, -r, side * r * 0.7 - r * 0.2, -r * 0.62, side * r * 0.92, -r * 0.48);
        ctx.bezierCurveTo(side * r * 0.6 + r * 0.2, -r * 0.8, side * r * 0.25 + r * 0.2, -r * 1.13, 0, -r * 1.04);
        ctx.fill();
      }
      ctx.strokeStyle = "#a2ab69"; ctx.lineWidth = r * 0.045;
      ctx.beginPath(); ctx.moveTo(0, -r * 1.05); ctx.quadraticCurveTo(-r * 0.04, -r * 0.76, 0, -r * 0.55); ctx.stroke();
      ctx.restore(); continue;
    }
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
