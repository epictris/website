// Berry vines: a vine that grows glowing berries on short stalks, and only the
// berries catch the hook (ported from karin-lu's `add-boulder-and-root-generation`
// branch; see docs/vines.md "Berry vines"). The `starberry` name is hers and
// is kept so her level files load; the star-shaped fruit it was named for was
// dropped in the port, and every berry is round.
//
// The settings are authored per vine (`VineData.starberry`). Lengths are in the
// containing level's units - pixels on disk, metres once `scaleLevelData` has
// run. Each berry is placed explicitly: where its stalk leaves the vine (a
// distance along the vine's arc from its anchor) and where the berry hangs
// from there (its `offset`, in the vine's rest pose). So a berry is exactly
// where it was put, and stays with its vine when the vine is moved - and
// where it is when the vine is lengthened, which only adds vine below it. The
// editor will not shorten a vine past its lowest berry (`minBerryVineLength`).

import { Vec2 } from "../engine/vec2";
import { Mathf } from "../engine/mathf";

export interface BerryOffset {
  x: number;
  y: number;
}

export interface StarberrySettings {
  // Where each berry's stalk leaves the vine: the distance along its arc from
  // the (first) anchor.
  along: number[];
  // Retired: the same as fractions of the vine's arc, so a berry moved
  // whenever the vine's length did. Karin's files and the first port's are
  // written in it; `scaleLevelData` folds it into `along` and drops it.
  positions?: number[];
  // Where each berry hangs, from the point its stalk leaves the vine, in berry
  // order - the stalk's reach and direction at rest. Omitted (older plants,
  // karin's files), each berry is `stemLength` out along its `sides` entry.
  offsets?: BerryOffset[];
  // Which side of the vine each stalk grows to when it has no offset, in berry
  // order: -1 left, 1 right. Omitted, they alternate.
  sides?: number[];
  // Each berry's own radius, in berry order; the hook's target is a little
  // inside it. Omitted (older plants), every berry is `radius`.
  radii?: number[];
  // The berry radius a new berry starts at, and every berry's without `radii`.
  radius: number;
  // The stalk's reach for a berry with no offset of its own.
  stemLength: number;
  // 0 holds the stalk stiff, 1 lets the berry swing on it.
  sway: number;
  // What a berry is made of, kilograms per cubic metre: a berry weighs its
  // density times its drawn sphere (`berryMass`), so a big berry on the same
  // plant is heavier than a small one. Absent = `DEFAULT_BERRY_DENSITY`. And
  // what a stalk is made of, kilograms per METRE as the cord's `density` is:
  // the stalk's middle joint (its stem) weighs that times the stalk's reach
  // (`stalkMass`), so a long stalk is heavier than a short one. Absent =
  // `DEFAULT_STALK_DENSITY`. Neither is a length, so `scaleLevelData` leaves
  // them alone, as it leaves the cord's `density`. What they set is how the
  // plant answers the ball, not how it falls: the chain pulls on the berry
  // directly, and a PBD correction is split between the ball and the berry by
  // inverse mass, so a light berry takes the whole of every correction the
  // chain hands it (see `DEFAULT_VINE_DENSITY` for the cord's version of the
  // same table); a heavy one makes the ball swing from something that barely
  // gives.
  berryDensity?: number;
  stalkDensity?: number;
  // How far past its reach a stalk may be drawn out before it is a rope, as a
  // fraction of the reach: 0 caps it at its grown length (the first port), 0.5
  // lets a 0.6 m stalk stretch to 0.9 m on its spring. Across that range the
  // stalk's clamp (`StalkClamp`, with `sway` for its rate) carries a pull along
  // the stalk as a spring, and gives it back: the trampoline (see
  // `DEFAULT_STALK_STRETCH`). Dimensionless, so `scaleLevelData` leaves it
  // alone. Absent = the default.
  stretch?: number;
  glow: number;
  // Render-only seed for the vine's crooked line.
  seed: number;
}

// The most berries one vine may carry.
export const MAX_BERRIES = 8;
// No berry's stalk nearer the anchor than this, metres: it would leave from
// the anchor body itself.
export const MIN_BERRY_ALONG = 0.15;
// Where karin's berries were when a file names none, as arc fractions.
export const DEFAULT_BERRY_FRACTIONS = [0.28, 0.58, 0.88];
// The shortest and longest stalk, metres. Shorter, the berry sits on the
// vine; longer, it is a second vine.
export const MIN_STALK = 0.12;
export const MAX_STALK = 1.5;
// How far behind the gameplay plane the cord is DRAWN, metres. The cord is no
// target - only the berries are - and setting it back is what says so: the
// stalks reach forward from it and the berries hang in the plane the ball and
// its chain move in. A look and nothing else: the sim's stalk is the in-plane
// line from the root to the berry, as every other length in the game is
// (`stalkReach`). It was the 3D hypotenuse across this depth from 2026-10-11
// to 2026-10-12, which left every stalk slack at rest by the difference and
// made a pull on a berry read as the berry tipping back toward the cord's
// depth - a half-3D motion Tris found felt wrong in a 2D game.
export const BERRY_CORD_DEPTH = 0.3;
// What a berry vine bends like when it does not say: a sapling (see
// `DEFAULT_VINE_STIFFNESS`), so the berries hang off a vine that holds its line.
export const STARBERRY_STIFFNESS = 0.78;
// A new berry's radius, metres: big beside the ball, as a thing to aim at.
export const DEFAULT_BERRY_RADIUS = 0.15;
// The smallest and largest berry, metres.
export const MIN_BERRY_RADIUS = 0.06;
export const MAX_BERRY_RADIUS = 0.65;
// What a berry is made of when the plant does not say, kilograms per cubic
// metre: a fruit, a little under water, which puts the default 0.15 m berry at
// 9 kg - heavier than a cord link for the cord's own reason
// (`DEFAULT_VINE_DENSITY`): the berry is what the chain pulls on directly, and
// a light one would take the whole of every correction the chain hands it.
// The ball is cast iron at 7200 for comparison.
export const DEFAULT_BERRY_DENSITY = 640;
// The lightest and heaviest a berry may be made of. The floor keeps the
// smallest berry (`MIN_BERRY_RADIUS`) near the convergence floor the cord has
// (`MIN_VINE_DENSITY`, about a kilogram a link); the ceiling is iron.
export const MIN_BERRY_DENSITY = 100;
export const MAX_BERRY_DENSITY = 8000;
// What a stalk is made of when the plant does not say, kilograms per metre
// of stalk: a third of the cord's `DEFAULT_VINE_DENSITY`, which puts the
// default stalk (0.38 m) at 3.2 kg - a solver number as
// the cord's is, heavy enough that the stem between a berry and the cord does
// not take the whole of every correction. And the range it may be authored
// in: the cord's convergence floor (`MIN_VINE_DENSITY`), and a ceiling well
// past anything the ball can swing.
export const DEFAULT_STALK_DENSITY = 8.3;
export const MIN_STALK_DENSITY = 1;
export const MAX_STALK_DENSITY = 200;
// How far past its reach a stalk stretches on its spring before its ropes
// catch it, as a fraction of the reach, when the plant does not say. The
// stalk's ropes are maximum lengths, so at 0 a pull along the stalk is caught
// as a chain catches - inelastically - and the stalk's clamp, a true spring,
// only ever carries the sideways part. A ball dropped half a metre onto a
// hanging BALL berry got 1-11% of its energy back at every sway, two thirds
// of it dying in the one frame the stalk's ropes went taut. With the ropes
// standing half the reach over, the clamp carries the whole pull and the same
// drop returns 47-59% at sway 0 to 0.5 in the chain sweep, and 68-78% with
// the held plant solved as rows of the island (`level/plantRows.ts`), over
// a stroke of 9-25 frames (2026-10-12, measured in the drop rig described in
// docs/vines.md). Above sway 0.5 the stalk sags 0.4 m under the ball's
// standing weight and has no clean catch left in it. The ceiling is the
// stalk doubling.
export const DEFAULT_STALK_STRETCH = 0.5;
export const MIN_STALK_STRETCH = 0;
export const MAX_STALK_STRETCH = 1;

// What a berry of `radius` (drawn, metres) weighs on a plant: its density
// times the sphere it is drawn as.
export function berryMass(radius: number, settings: Pick<StarberrySettings, "berryDensity">): number {
  const density = settings.berryDensity ?? DEFAULT_BERRY_DENSITY;
  return density * ((4 / 3) * Mathf.Pi * radius * radius * radius);
}

// How long a stalk is: the in-plane line from its root on the cord to the
// berry, as drawn (see `growBerries`), and no shorter than `MIN_STALK`.
export function stalkReach(span: number): number {
  return Math.max(MIN_STALK, span);
}

// What a stalk's middle joint weighs on a plant: the stalk's density times
// its reach.
export function stalkMass(reach: number, settings: Pick<StarberrySettings, "stalkDensity">): number {
  return (settings.stalkDensity ?? DEFAULT_STALK_DENSITY) * reach;
}

// The farthest a stalk of `reach` may be drawn out on a plant, metres: where
// its ropes catch (`growBerries`), and what the `starberry-stretch` invariant
// holds it to.
export function stalkCap(reach: number, settings: Pick<StarberrySettings, "stretch">): number {
  return reach * (1 + (settings.stretch ?? DEFAULT_STALK_STRETCH));
}

// A settings block as the builder and the renderers use it (metres), for a
// vine `length` long: every number clamped to its range, each root on the
// vine, at most `MAX_BERRIES` berries in their authored order, and each
// berry's offset and side kept with it.
export function starberrySettings(value: Partial<StarberrySettings> | undefined, length: number): StarberrySettings {
  const number = (v: number | undefined, fallback: number, min: number, max: number): number =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v!)) : fallback;
  const kept = (value?.along ?? DEFAULT_BERRY_FRACTIONS.map((f) => f * length))
    .map((a, i) => ({ a, i }))
    .filter((e) => Number.isFinite(e.a))
    .map((e) => ({ ...e, a: clampAlong(e.a, length) }))
    .slice(0, MAX_BERRIES);
  const sides = value?.sides;
  const offsets = value?.offsets;
  const radii = value?.radii;
  const stemLength = number(value?.stemLength, 0.38, MIN_STALK, MAX_STALK);
  const radius = number(value?.radius, DEFAULT_BERRY_RADIUS, MIN_BERRY_RADIUS, MAX_BERRY_RADIUS);
  return {
    along: kept.map((e) => e.a),
    ...(radii ? { radii: kept.map((e) => number(radii[e.i], radius, MIN_BERRY_RADIUS, MAX_BERRY_RADIUS)) } : {}),
    ...(offsets
      ? {
          offsets: kept.map((e) => {
            const o = offsets[e.i];
            if (o && Number.isFinite(o.x) && Number.isFinite(o.y) && (o.x !== 0 || o.y !== 0)) {
              return clampStalk(new Vec2(o.x, o.y));
            }
            const fallback = defaultOffset(e.i, sides?.[e.i], stemLength);
            return { x: fallback.x, y: fallback.y };
          }),
        }
      : {}),
    ...(sides
      ? { sides: kept.map((e) => (sides[e.i] === 1 ? 1 : sides[e.i] === -1 ? -1 : e.i % 2 ? 1 : -1)) }
      : {}),
    radius,
    stemLength,
    // Kept only where authored, so a plant that never said stays on the
    // defaults as they move, and a file without them round-trips unchanged.
    ...(Number.isFinite(value?.berryDensity)
      ? { berryDensity: number(value?.berryDensity, DEFAULT_BERRY_DENSITY, MIN_BERRY_DENSITY, MAX_BERRY_DENSITY) }
      : {}),
    ...(Number.isFinite(value?.stalkDensity)
      ? { stalkDensity: number(value?.stalkDensity, DEFAULT_STALK_DENSITY, MIN_STALK_DENSITY, MAX_STALK_DENSITY) }
      : {}),
    ...(Number.isFinite(value?.stretch)
      ? { stretch: number(value?.stretch, DEFAULT_STALK_STRETCH, MIN_STALK_STRETCH, MAX_STALK_STRETCH) }
      : {}),
    sway: number(value?.sway, 0.65, 0, 1),
    glow: number(value?.glow, 1.5, 0, 3),
    seed: Math.floor(number(value?.seed, 1701, 0, 2147483647)),
  };
}

// A root held on a vine `length` long and clear of its anchor (metres). A
// vine shorter than the clearance keeps its roots at its end.
export function clampAlong(along: number, length: number): number {
  return Math.min(length, Math.max(Math.min(MIN_BERRY_ALONG, length), along));
}

// The shortest a berry vine may be made: down to its lowest berry's root, and
// no shorter (`floor`, the shortest any vine may be).
export function minBerryVineLength(settings: StarberrySettings | undefined, floor: number): number {
  return Math.max(floor, ...(settings?.along ?? []));
}

// An offset held to the stalk's range (metres), direction kept.
export function clampStalk(offset: Vec2): BerryOffset {
  const length = offset.length();
  const held = Math.min(MAX_STALK, Math.max(MIN_STALK, length));
  const o = length > 0 ? offset.mul(held / length) : new Vec2(0, held);
  return { x: o.x, y: o.y };
}

// Out to `side` and down, `stemLength` long: a berry with no offset of its own.
function defaultOffset(index: number, side: number | undefined, stemLength: number): Vec2 {
  const s = side ?? (index % 2 === 0 ? -1 : 1);
  return new Vec2(s * 0.78, 0.626).normalized().mul(stemLength);
}

// Where one berry is this frame: the point on the vine its stalk leaves from,
// the stalk's middle joint, and the berry itself, with its radius. `held` is
// the hook's.
export interface StarberryPose {
  root: Vec2;
  joint: Vec2;
  fruit: Vec2;
  radius: number;
  held: boolean;
}

// Berry `index`'s radius.
export function berryRadius(index: number, settings: StarberrySettings): number {
  return settings.radii?.[index] ?? settings.radius;
}

// Berry `index`'s stalk at rest, from the vine to the berry.
export function berryOffset(index: number, settings: StarberrySettings): Vec2 {
  const o = settings.offsets?.[index];
  return o ? new Vec2(o.x, o.y) : defaultOffset(index, settings.sides?.[index], settings.stemLength);
}

// Which side of the vine berry `index` hangs to: -1 left, 1 right.
export function berrySide(index: number, settings: StarberrySettings): number {
  return berryOffset(index, settings).x < 0 ? -1 : 1;
}

// The point `distance` along a polyline from its start, by arc length; its
// end for a distance past it.
export function pointAlong(path: readonly Vec2[], distance: number): Vec2 {
  let remaining = distance;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const d = a.distanceTo(b);
    if (remaining <= d && d > 0) return a.add(b.sub(a).mul(remaining / d));
    remaining -= d;
  }
  return path[path.length - 1] ?? Vec2.ZERO;
}

// The berries of a vine at rest along `path`: what the editor draws and picks,
// and what the renderers fall back to for a cord with no live berries.
export function restStarberries(path: readonly Vec2[], settings: StarberrySettings): StarberryPose[] {
  return settings.along.map((a, i) => {
    const root = pointAlong(path, a);
    const offset = berryOffset(i, settings);
    return {
      root,
      joint: root.add(offset.mul(0.5)),
      fruit: root.add(offset),
      radius: berryRadius(i, settings),
      held: false,
    };
  });
}
