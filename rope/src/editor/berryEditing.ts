// Placing a berry vine's berries (`level/starberry.ts`). Each berry is put
// exactly where it is wanted: dragged off the vine (its stalk's root is where
// the drag started on the cord, the berry where it was released), then moved
// by its gizmo or its handle, its root slid along the vine by its own handle.
// Every edit leaves the OTHER berries exactly where they were.

import { Vec2 } from "../engine/vec2";
import {
  MAX_BERRIES,
  MAX_BERRY_RADIUS,
  MIN_BERRY_RADIUS,
  berryOffset,
  berryRadius,
  clampAlong,
  clampStalk,
  starberrySettings,
  type BerryOffset,
  type StarberrySettings,
} from "../level/starberry";

// Every berry's offset, made explicit on first use - an older plant's berries
// stand at its shared stalk length - so that adding, moving or removing one
// cannot move the rest.
export function berryOffsets(settings: StarberrySettings): BerryOffset[] {
  if (!settings.offsets || settings.offsets.length !== settings.along.length) {
    settings.offsets = settings.along.map((_, i) => {
      const o = berryOffset(i, settings);
      return { x: o.x, y: o.y };
    });
    delete settings.sides;
  }
  return settings.offsets;
}

// Every berry's radius, made explicit on first use for the offsets' reason.
export function berryRadii(settings: StarberrySettings): number[] {
  if (!settings.radii || settings.radii.length !== settings.along.length) {
    settings.radii = settings.along.map((_, i) => berryRadius(i, settings));
  }
  return settings.radii;
}

// Berry `index` at radius `radius` (metres), held to the berry range.
export function sizeBerry(settings: StarberrySettings, index: number, radius: number): void {
  berryRadii(settings)[index] = Math.min(MAX_BERRY_RADIUS, Math.max(MIN_BERRY_RADIUS, radius));
}

// A new berry on a vine (whose settings are `settings`, or none yet - a plain
// vine becomes a berry vine by growing one): its stalk leaving the vine
// `along` metres down it, on a vine `length` long, the berry at `offset` from
// there (metres). Returns the settings and the new berry's index, or null if
// the vine is full.
export function growBerry(
  settings: StarberrySettings | undefined,
  along: number,
  offset: Vec2,
  length: number,
): { settings: StarberrySettings; index: number } | null {
  const s = settings ?? starberrySettings({ along: [], offsets: [] }, length);
  if (s.along.length >= MAX_BERRIES) return null;
  const offsets = berryOffsets(s);
  const radii = berryRadii(s);
  s.along.push(clampAlong(along, length));
  offsets.push(clampStalk(offset));
  // At the vine's own berry radius: the last one set, or the default.
  radii.push(s.radius);
  return { settings: s, index: s.along.length - 1 };
}

// Berry `index` hung at `offset` from its root (metres), its root unmoved.
export function placeBerry(settings: StarberrySettings, index: number, offset: Vec2): void {
  berryOffsets(settings)[index] = clampStalk(offset);
}

// Berry `index`'s root slid to `along` metres down a vine `length` long; the
// berry keeps its offset from it.
export function moveBerry(settings: StarberrySettings, index: number, along: number, length: number): void {
  berryOffsets(settings);
  settings.along[index] = clampAlong(along, length);
}

export function removeBerry(settings: StarberrySettings, index: number): void {
  berryOffsets(settings).splice(index, 1);
  berryRadii(settings).splice(index, 1);
  settings.along.splice(index, 1);
}

// How far along `path` (a hanging or spanning vine), metres from its anchor,
// the point on it nearest `target` is - held clear of the anchor.
export function berryAlongAt(path: readonly Vec2[], target: Vec2): number {
  let total = 0;
  let along = 0;
  let best = Infinity;
  let nearest = 0;
  for (let i = 1; i < path.length; i++) total += path[i]!.distanceTo(path[i - 1]!);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const d = path[i]!.sub(a);
    const length = d.length();
    if (!length) continue;
    const delta = target.sub(a);
    const t = Math.min(1, Math.max(0, (delta.x * d.x + delta.y * d.y) / (length * length)));
    const distance = a.add(d.mul(t)).distanceTo(target);
    if (distance < best) {
      best = distance;
      nearest = along + length * t;
    }
    along += length;
  }
  return clampAlong(nearest, total);
}
