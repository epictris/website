// Catenary curve approximation, ported from lib/Catenary.cs.
// Original TypeScript: Copyright (c) 2018, 2023 Jan Hug — MIT license.

import { Vec2 } from "../engine/vec2";

const EPSILON = 1e-6;

export interface CatenaryOptions {
  segments: number;
  iterationLimit: number;
}

const DEFAULT_OPTIONS: CatenaryOptions = { segments: 25, iterationLimit: 6 };

function acosh(x: number): number {
  return Math.log(x + Math.sqrt(x * x - 1));
}

function getCatenaryParameter(h: number, v: number, length: number, limit: number): number {
  const m = Math.sqrt(length * length - v * v) / h;
  let x = acosh(m) + 1;
  let prevx = -1;
  let count = 0;
  while (Math.abs(x - prevx) > EPSILON && count < limit) {
    prevx = x;
    x = x - (Math.sinh(x) - m * x) / (Math.cosh(x) - m);
    count++;
  }
  return h / (2 * x);
}

function getCurve(
  a: number,
  p1: Vec2,
  p2: Vec2,
  offsetX: number,
  offsetY: number,
  segments: number,
): Vec2[] {
  const data: Vec2[] = [new Vec2(p1.x, a * Math.cosh((p1.x - offsetX) / a) + offsetY)];
  const d = p2.x - p1.x;
  const length = segments - 1;
  for (let i = 0; i < length; i++) {
    const x = p1.x + (d * (i + 0.5)) / length;
    const y = a * Math.cosh((x - offsetX) / a) + offsetY;
    data.push(new Vec2(x, y));
  }
  data.push(new Vec2(p2.x, a * Math.cosh((p2.x - offsetX) / a) + offsetY));
  return data;
}

export function getCatenaryCurve(
  point1: Vec2,
  point2: Vec2,
  chainLength: number,
  options: CatenaryOptions = DEFAULT_OPTIONS,
): Vec2[] {
  const { segments, iterationLimit } = options;
  const isFlipped = point1.x > point2.x;
  const p1 = isFlipped ? point2 : point1;
  const p2 = isFlipped ? point1 : point2;
  const distance = p1.distanceTo(p2);

  if (distance < chainLength) {
    const diff = p2.x - p1.x;
    if (diff > 0.01) {
      const h = p2.x - p1.x;
      const v = p2.y - p1.y;
      const a = -getCatenaryParameter(h, v, chainLength, iterationLimit);
      const x = (a * Math.log((chainLength + v) / (chainLength - v)) - h) * 0.5;
      const y = a * Math.cosh(x / a);
      const offsetX = p1.x - x;
      const offsetY = p1.y - y;
      const curveData = getCurve(a, p1, p2, offsetX, offsetY, segments);
      if (isFlipped) curveData.reverse();
      return curveData;
    }

    // Vertical or near-vertical line with sag.
    const mx = (p1.x + p2.x) * 0.5;
    const my = (p1.y + p2.y + chainLength) * 0.5;
    return [new Vec2(p1.x, p1.y), new Vec2(mx, my), new Vec2(p2.x, p2.y)];
  }

  // Chain is taut — straight line.
  return [new Vec2(p1.x, p1.y), new Vec2(p2.x, p2.y)];
}
