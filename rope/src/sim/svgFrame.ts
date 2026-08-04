// Headless SVG snapshot of a single simulation frame. The digest table shows
// numbers; this shows geometry — the chain wrap path against scene bodies — so a
// glitch like the chain clipping through a wall is obvious at a glance instead
// of reconstructed from coordinates. Pure string output, no browser/canvas.

import { Level } from "../level/level";
import { BallLevel } from "../level/ballLevel";
import {
  AnchorBody,
  ForceArea,
  WaterArea,
  StaticBody2D,
  RigidBody2D,
} from "../engine/body";
import { PIXELS_PER_METER } from "../engine/units";
import type { Rope } from "../classes/rope";
import type { CollisionShape2D, PhysicsBody2D } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import {
  anchorGlyphs,
  forceAreaGlyphs,
  waterAreaGlyphs,
  killZoneGlyphs,
  type PolyPath,
} from "../render/areaGlyphs";
import { outlineHalfExtents, outlineOfShape, type Outline } from "../render/shapePath";

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

// Outline of a shape in its own local frame, in px. The glyph lattice is laid
// out over the bounding half-extents whichever kind it is (see areaFill), and
// this path is what clips it back to the real boundary.
function outlinePath(o: Outline): string {
  if (o.kind === "circle") {
    // Two half-arcs — an exact circle, no polygon approximation needed here.
    const r = o.radius * M;
    return `M${f1(-r)} 0 A${f1(r)} ${f1(r)} 0 1 0 ${f1(r)} 0 A${f1(r)} ${f1(r)} 0 1 0 ${f1(-r)} 0 Z`;
  }
  const verts =
    o.kind === "poly"
      ? o.verts
      : [
          new Vec2(-o.half.x, -o.half.y),
          new Vec2(o.half.x, -o.half.y),
          new Vec2(o.half.x, o.half.y),
          new Vec2(-o.half.x, o.half.y),
        ];
  return (
    verts
      .map((v, i) => `${i === 0 ? "M" : "L"}${f1(v.x * M)} ${f1(v.y * M)}`)
      .join(" ") + " Z"
  );
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

// Per SHAPE, not per body: hook-proof is a property of the surface, so a
// compound wall repelling the hook on one face and attachable on the next has
// to draw as the two things it is.
function bodyColor(b: PhysicsBody2D, piece: CollisionShape2D): { fill: string; stroke: string } {
  const fill = (b as { fillColor?: string }).fillColor ?? "#555555";
  // Impermeable (hook-proof) surfaces get a red stroke so it's clear why a hook
  // bounces off them rather than anchoring.
  const stroke = piece.impermeable ? "#d0506a" : "#8a8a8a";
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
  const defsEls: string[] = [];

  // Hook-only anchor geometry, drawn behind the solid bodies exactly as the
  // canvas renderers draw it, with the same grate holes cut out of it. A
  // snapshot has to show which bodies the chain can anchor to but not touch —
  // without the mesh, a hook resting in mid-air would look like a bug.
  const anchorEls: string[] = [];
  for (const b of level.world.bodies) {
    if (!(b instanceof AnchorBody) || b.removed || !b.hasShape()) continue;
    // Every piece an anchor carries: grouping makes `anchor` bodies compound
    // like any other, and a snapshot that drew only the first piece would show
    // the hook catching on scenery that is not in the picture.
    b.getShapes().forEach((s, i) => {
      const cx = s.globalPosition.x * M;
      const cy = s.globalPosition.y * M;
      const shape = outlineOfShape(s.shape);
      const circle = shape.kind === "circle";
      const half = outlineHalfExtents(shape);
      const hw = half.x * M;
      const hh = half.y * M;
      const ext = circle ? { x: hw, y: hh } : rotatedHalfExtents(hw, hh, s.globalRotation);
      growXY(box, cx, cy, ext.x, ext.y);

      const glyphs = new SvgPolyPath();
      anchorGlyphs(glyphs, half, circle);
      const outline = outlinePath(shape);
      const deg = (s.globalRotation * 180) / Math.PI;
      const rot = deg !== 0 ? ` rotate(${deg.toFixed(2)})` : "";
      const clipId = `anchor${b.id}_${i}`;
      defsEls.push(`<clipPath id="${clipId}"><path d="${outline}"/></clipPath>`);
      anchorEls.push(
        `<g transform="translate(${f1(cx)} ${f1(cy)})${rot}">` +
          `<path d="${outline} ${glyphs}" fill-rule="evenodd" fill="${b.fillColor ?? "#7a8c9b"}" fill-opacity="${b.fillColor ? b.fillOpacity : 0.38}" clip-path="url(#${clipId})"/>` +
          `</g>`,
      );
    });
  }

  // Collect geometry as SVG elements while accumulating the bounding box.
  const shapeEls: string[] = [];
  for (const b of bodies) {
    const op = (b as { fillOpacity?: number }).fillOpacity ?? 0.5;
    for (const s of b.getShapes()) {
      const { fill, stroke } = bodyColor(b, s);
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
      } else if (s.shape.kind === "circle") {
        const rad = s.shape.radius * M;
        shapeEls.push(
          `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="1"/>`,
        );
        grow(box, cx, cy, rad);
      } else {
        // Convex polygon: the vertex loop placed by the body's transform, and a
        // bounding box grown from the placed vertices themselves (a rotated
        // polygon has no half-extents shortcut worth taking).
        const pts = s.shape.verts.map((v) =>
          s.globalPosition.add(v.rotated(s.globalRotation)).mul(M),
        );
        for (const p of pts) grow(box, p.x, p.y, 0);
        shapeEls.push(
          `<polygon points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="1"/>`,
        );
      }
    }
  }

  // Areas (killzones, force areas, water). Drawn after geometry so their glyphs read
  // over anything they overlap, and with the same even-odd cutout the canvas
  // uses, so a snapshot and the running game agree.
  const areaEls: string[] = [];
  for (const area of level.world.areas) {
    if (area.removed || !area.hasShape()) continue;
    const s = area.primaryShape();
    const cx = s.globalPosition.x * M;
    const cy = s.globalPosition.y * M;
    const shape = outlineOfShape(s.shape);
    const circle = shape.kind === "circle";
    const half = outlineHalfExtents(shape);
    const hw = half.x * M;
    const hh = half.y * M;
    const ext = circle
      ? { x: hw, y: hh }
      : rotatedHalfExtents(hw, hh, s.globalRotation);
    growXY(box, cx, cy, ext.x, ext.y);

    const glyphs = new SvgPolyPath();
    // Pin the phase on anything that drifts: a snapshot of a frame must not
    // depend on the wall clock.
    if (area instanceof ForceArea) {
      forceAreaGlyphs(glyphs, half, circle, area.magnitude, 0);
    } else if (area instanceof WaterArea) {
      waterAreaGlyphs(glyphs, half, circle, area.flow, 0);
    } else {
      killZoneGlyphs(glyphs, half, circle);
    }

    const outline = outlinePath(shape);
    const isForce = area instanceof ForceArea;
    const isWater = area instanceof WaterArea;
    const fill = area.fillColor ?? (isForce ? "#65bddb" : isWater ? "#3a5e4a" : "#dc3c50");
    const op = area.fillColor ? area.fillOpacity : isForce ? 0.2 : isWater ? 0.55 : 0.4;
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

  // Authored scene chains, in a cooler steel than the avatar's rope so the two
  // are never confused in a snapshot. Same treatment otherwise: the wrap-node
  // polyline, with the nodes marked, since a chain catching a corner is exactly
  // what a geometric snapshot is opened to check.
  for (const chain of level.sceneChains) {
    const nodes = chain.rope.path().map((n) => n.contact.globalPosition);
    for (const n of nodes) grow(box, n.x * M, n.y * M, 4);
    const pts = nodes.map((n) => `${(n.x * M).toFixed(1)},${(n.y * M).toFixed(1)}`).join(" ");
    // Chains dashed: they touch nothing but their own two bodies, so a snapshot
    // must not read a chain lying across a body as a chain caught on it (see
    // `SceneChain`).
    ropeEls.push(`<polyline points="${pts}" fill="none" stroke="#8fa3b8" stroke-width="2" stroke-dasharray="7 5"/>`);
    for (let i = 1; i < nodes.length - 1; i++) {
      ropeEls.push(`<circle cx="${(nodes[i]!.x * M).toFixed(1)}" cy="${(nodes[i]!.y * M).toFixed(1)}" r="3" fill="#8fa3b8"/>`);
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
    ...anchorEls,
    ...shapeEls,
    ...areaEls,
    ...ropeEls,
    avatarEl,
    `<text x="${(vx + 6).toFixed(1)}" y="${(vy + 18).toFixed(1)}" fill="#cbccc6" font-family="monospace" font-size="14">f${frame}</text>`,
    `</svg>`,
  ].join("\n");
}
