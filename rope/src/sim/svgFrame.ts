// Headless SVG snapshot of a single simulation frame. The digest table shows
// numbers; this shows geometry — the chain wrap path against scene bodies — so a
// glitch like the chain clipping through a wall is obvious at a glance instead
// of reconstructed from coordinates. Pure string output, no browser/canvas.

import { Level } from "../level/level";
import { BallLevel } from "../level/ballLevel";
import { ForceArea, StaticBody2D, RigidBody2D, ImpermeableBody } from "../engine/body";
import { PIXELS_PER_METER } from "../engine/units";
import type { Rope } from "../classes/rope";
import type { PhysicsBody2D } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import { forceAreaGlyphs, killZoneGlyphs, type PolyPath } from "../render/areaGlyphs";

const M = PIXELS_PER_METER; // metres → px

// Areas carry the same glyphs the canvas renderers stamp on them, so a snapshot
// shows what each region does rather than an anonymous translucent box (see
// docs/game-design.md, "Areas must read as areas"). Sink that turns the shared
// glyph polygons into SVG path data.
class SvgPolyPath implements PolyPath {
  private readonly parts: string[] = [];
  moveTo(x: number, y: number): void {
    this.parts.push(`M${(x * M).toFixed(1)} ${(y * M).toFixed(1)}`);
  }
  lineTo(x: number, y: number): void {
    this.parts.push(`L${(x * M).toFixed(1)} ${(y * M).toFixed(1)}`);
  }
  closePath(): void {
    this.parts.push("Z");
  }
  toString(): string {
    return this.parts.join(" ");
  }
}

const f1 = (v: number): string => v.toFixed(1);

// Outline of an area in its own local frame, in px.
function outlinePath(hw: number, hh: number, circle: boolean): string {
  if (circle) {
    // Two half-arcs — an exact circle, no polygon approximation needed here.
    return `M${f1(-hw)} 0 A${f1(hw)} ${f1(hw)} 0 1 0 ${f1(hw)} 0 A${f1(hw)} ${f1(hw)} 0 1 0 ${f1(-hw)} 0 Z`;
  }
  return `M${f1(-hw)} ${f1(-hh)} L${f1(hw)} ${f1(-hh)} L${f1(hw)} ${f1(hh)} L${f1(-hw)} ${f1(hh)} Z`;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function grow(box: Box, x: number, y: number, pad = 0): void {
  growXY(box, x, y, pad, pad);
}

function growXY(box: Box, x: number, y: number, padX: number, padY: number): void {
  box.minX = Math.min(box.minX, x - padX);
  box.minY = Math.min(box.minY, y - padY);
  box.maxX = Math.max(box.maxX, x + padX);
  box.maxY = Math.max(box.maxY, y + padY);
}

// Half-extents of a rotated rect's axis-aligned bounding box. Padding by the
// half-diagonal instead (the obvious shortcut) frames a long floor as though it
// were as tall as it is wide, burying the scene in dead space.
function rotatedHalfExtents(hw: number, hh: number, rot: number): { x: number; y: number } {
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  return { x: hw * c + hh * s, y: hw * s + hh * c };
}

function bodyColor(b: PhysicsBody2D): { fill: string; stroke: string } {
  const fill = (b as { fillColor?: string }).fillColor ?? "#555555";
  // Impermeable (hook-proof) bodies get a red stroke so it's clear why a hook
  // bounces off them rather than anchoring.
  const stroke = b instanceof ImpermeableBody ? "#d0506a" : "#8a8a8a";
  return { fill, stroke };
}

function ropeOf(level: Level | BallLevel): Rope | null {
  return level instanceof BallLevel ? level.ball.chain : level.player.rope;
}

function avatar(level: Level | BallLevel): { pos: Vec2; r: number } {
  const b = level instanceof BallLevel ? level.ball : level.player;
  const r = (b as { radius?: number }).radius ?? 0.12;
  return { pos: b.globalPosition, r };
}

export function renderFrameSVG(level: Level | BallLevel): string {
  const bodies = level.world.bodies.filter(
    (b) => (b instanceof StaticBody2D || b instanceof RigidBody2D) && b.hasShape(),
  );
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  // Collect geometry as SVG elements while accumulating the bounding box.
  const shapeEls: string[] = [];
  for (const b of bodies) {
    const { fill, stroke } = bodyColor(b);
    const op = (b as { fillOpacity?: number }).fillOpacity ?? 0.5;
    for (const s of b.getShapes()) {
      const cx = s.globalPosition.x * M;
      const cy = s.globalPosition.y * M;
      if (s.shape.kind === "rect") {
        const w = s.shape.size.x * M;
        const h = s.shape.size.y * M;
        const deg = (s.globalRotation * 180) / Math.PI;
        const rot = deg !== 0 ? ` transform="rotate(${deg.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : "";
        shapeEls.push(
          `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="1"${rot}/>`,
        );
        const ext = rotatedHalfExtents(w / 2, h / 2, s.globalRotation);
        growXY(box, cx, cy, ext.x, ext.y);
      } else {
        const rad = s.shape.radius * M;
        shapeEls.push(
          `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="1"/>`,
        );
        grow(box, cx, cy, rad);
      }
    }
  }

  // Areas (killzones, force areas). Drawn after geometry so their glyphs read
  // over anything they overlap, and with the same even-odd cutout the canvas
  // uses, so a snapshot and the running game agree.
  const defsEls: string[] = [];
  const areaEls: string[] = [];
  for (const area of level.world.areas) {
    if (area.removed || !area.hasShape()) continue;
    const s = area.getShape();
    const cx = s.globalPosition.x * M;
    const cy = s.globalPosition.y * M;
    const circle = s.shape.kind === "circle";
    const half =
      s.shape.kind === "circle"
        ? new Vec2(s.shape.radius, s.shape.radius)
        : s.shape.size.mul(0.5);
    const hw = half.x * M;
    const hh = half.y * M;
    const ext = circle
      ? { x: hw, y: hh }
      : rotatedHalfExtents(hw, hh, s.globalRotation);
    growXY(box, cx, cy, ext.x, ext.y);

    const glyphs = new SvgPolyPath();
    if (area instanceof ForceArea) {
      // Pin the phase: a snapshot of a frame must not depend on the wall clock.
      forceAreaGlyphs(glyphs, half, circle, area.magnitude, 0);
    } else {
      killZoneGlyphs(glyphs, half, circle);
    }

    const outline = outlinePath(hw, hh, circle);
    const isForce = area instanceof ForceArea;
    const fill = area.fillColor ?? (isForce ? "#65bddb" : "#dc3c50");
    const op = area.fillColor ? area.fillOpacity : isForce ? 0.2 : 0.4;
    const deg = (s.globalRotation * 180) / Math.PI;
    const rot = deg !== 0 ? ` rotate(${deg.toFixed(2)})` : "";
    const clipId = `area${area.id}`;
    defsEls.push(`<clipPath id="${clipId}"><path d="${outline}"/></clipPath>`);
    areaEls.push(
      `<g transform="translate(${f1(cx)} ${f1(cy)})${rot}">` +
        `<path d="${outline} ${glyphs}" fill-rule="evenodd" fill="${fill}" fill-opacity="${op}" clip-path="url(#${clipId})"/>` +
        `</g>`,
    );
  }

  // Avatar (ball / player).
  const av = avatar(level);
  const ax = av.pos.x * M;
  const ay = av.pos.y * M;
  grow(box, ax, ay, av.r * M + 4);
  const avatarEl = `<circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="${(av.r * M).toFixed(1)}" fill="#65bddb" fill-opacity="0.85" stroke="#cbccc6" stroke-width="1.5"/>`;

  // Rope / chain path.
  const rope = ropeOf(level);
  const ropeEls: string[] = [];
  if (rope) {
    const nodes = rope.path().map((n) => n.contact.globalPosition);
    for (const n of nodes) grow(box, n.x * M, n.y * M, 4);
    const pts = nodes.map((n) => `${(n.x * M).toFixed(1)},${(n.y * M).toFixed(1)}`).join(" ");
    ropeEls.push(`<polyline points="${pts}" fill="none" stroke="#e0a458" stroke-width="2"/>`);
    // Mark wrap nodes (everything between the two endpoints) — where the chain
    // caught a corner.
    for (let i = 1; i < nodes.length - 1; i++) {
      ropeEls.push(`<circle cx="${(nodes[i]!.x * M).toFixed(1)}" cy="${(nodes[i]!.y * M).toFixed(1)}" r="3" fill="#e0a458"/>`);
    }
  }

  if (!Number.isFinite(box.minX)) {
    box.minX = -100;
    box.minY = -100;
    box.maxX = 100;
    box.maxY = 100;
  }
  const pad = 20;
  const vx = box.minX - pad;
  const vy = box.minY - pad;
  const vw = box.maxX - box.minX + 2 * pad;
  const vh = box.maxY - box.minY + 2 * pad;
  const frame = level.frame;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}" width="${Math.round(vw)}" height="${Math.round(vh)}">`,
    `<rect x="${vx.toFixed(1)}" y="${vy.toFixed(1)}" width="${vw.toFixed(1)}" height="${vh.toFixed(1)}" fill="#1f2430"/>`,
    ...(defsEls.length ? [`<defs>${defsEls.join("")}</defs>`] : []),
    ...shapeEls,
    ...areaEls,
    ...ropeEls,
    avatarEl,
    `<text x="${(vx + 6).toFixed(1)}" y="${(vy + 18).toFixed(1)}" fill="#cbccc6" font-family="monospace" font-size="14">f${frame}</text>`,
    `</svg>`,
  ].join("\n");
}
