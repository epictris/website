// GENERATED ROCKS: which of a level's drawn pieces are rock, laid out in world
// space for the offline generator, and the hash that says whether a generated
// mesh still matches what the level authors.
//
// The rocks a level shows are not extruded at runtime. `scripts/generate-rocks.ts`
// turns each rock body's outlines into a job for `tools/blender/rocks.py`, which
// builds faceted boulders in headless Blender and writes one GLB per level to
// `public/rocks/<level>.glb`. At load, `Scene3D.setRocks` names the file and
// `rockMesh.ts` swaps every body whose generated node still matches its
// authored outline for that node, and
// leaves a body whose outline has changed since on its flat extrusion - which is
// how a stale rock announces itself, without any level ever failing to draw.
//
// This module is the one place both sides read the level, so the generator and
// the runtime cannot disagree about WHICH pieces are rock or WHERE they are.
// It is deliberately free of three.js: the generator runs it under bun.

import { Vec2 } from "../engine/vec2";
import { worldPlacement } from "../level/buildBodies";
import {
  isGeometryObject,
  type GeometryObjectData,
  type LevelBodyData,
  type LevelData,
} from "../level/levelFormat";
import { DEFAULT_THICKNESS } from "../lib/shapeGeometry";
import { decomposeConvex } from "../lib/polygon";

// The authored surfaces that mean "this is rock". The names are the level's
// `texture` field, which is the one statement a level makes about what a piece
// is made of; a body wearing wood or iron keeps its extrusion. Moss is rock with
// moss on it, and the generator will grow the moss (see docs/rocks.md).
export const ROCK_TEXTURES: ReadonlySet<string> = new Set([
  "dark rock",
  "marble cliff",
  "rock wall",
  "stone",
  "moss-dark",
  "mossy ground",
]);

// One outline the generator builds a boulder (or a pile of them) from. World
// metres in three's frame: x right, y UP, so the generator never learns the
// sim's y-down convention.
export interface RockPiece {
  verts: { x: number; y: number }[];
  // The same outline cut into convex parts (`decomposeConvex`), for the
  // generator's Voronoi split: a half-plane clip is exact on a convex polygon
  // and produces slivers and bridges on a concave one. A stone that straddles
  // a cut is built as one fragment per part, and the voxel remesh fuses them.
  // Derived from `verts`, so it is not hashed.
  convex: { x: number; y: number }[][];
  // Authored solid depth through z, centred on the gameplay plane.
  depth: number;
  // The piece's own z offset (`GeometryObjectData.z`), + toward the camera.
  z: number;
  // The extrusion's chamfer (`GeometryObjectData.bevel`, clamped as
  // `extrudeOutline` clamps it). The generator reads it as a RAGGED EDGE:
  // shards meeting the outline above or below end a random way short of it,
  // up to the bevel, so the edge is a broken skyline rather than a flat cut.
  bevel: number;
  // Whether the piece wears a mossy surface. Ignored by the generator today;
  // carried so a moss pass changes the job, and therefore the hash.
  mossy: boolean;
}

export interface RockBody {
  // Index into `LevelData.bodies`, which is also the index into
  // `BuiltBodies.bodies` (one per authored body, in authored order).
  index: number;
  // `rockHash` of `pieces`: the generated node carries the hash it was built
  // from, and the runtime only mounts it while the two agree.
  hash: string;
  pieces: RockPiece[];
  // The geometry objects the pieces came from, so the runtime knows which of
  // the body's drawn things the generated mesh stands in for.
  objects: GeometryObjectData[];
}

const CIRCLE_SIDES = 24;

// Only STATIC bodies. A rigid rock that tumbles would need its mesh in the
// body's own frame (the engine's centre of mass, see `BuiltBody`), and a
// hook-only or pass-through body draws set back from the plane; both are left
// to the extrusion until the generator learns them.
function isRockBody(body: LevelBodyData): boolean {
  return body.kind === "static" && body.passable !== true;
}

function isRockObject(g: GeometryObjectData): boolean {
  if ((g.kind ?? "primitive") !== "primitive") return false;
  if (g.texture === undefined || !ROCK_TEXTURES.has(g.texture)) return false;
  const s = g.shape;
  return s !== undefined && (s.kind === "rect" || s.kind === "poly" || s.kind === "circle");
}

// The object's outline in its own frame, metres.
function localVerts(g: GeometryObjectData): Vec2[] {
  const s = g.shape!;
  if (s.kind === "rect") {
    const hx = s.w / 2;
    const hy = s.h / 2;
    return [new Vec2(-hx, -hy), new Vec2(hx, -hy), new Vec2(hx, hy), new Vec2(-hx, hy)];
  }
  if (s.kind === "circle") {
    const out: Vec2[] = [];
    for (let i = 0; i < CIRCLE_SIDES; i++) {
      const a = (i / CIRCLE_SIDES) * Math.PI * 2;
      out.push(new Vec2(Math.cos(a) * s.r, Math.sin(a) * s.r));
    }
    return out;
  }
  if (s.kind === "poly") return s.verts.map((v) => new Vec2(v.x, v.y));
  return [];
}

function pieceOf(body: LevelBodyData, g: GeometryObjectData): RockPiece {
  const place = worldPlacement(body, g);
  const world = localVerts(g).map((v) => {
    const w = place.pos.add(v.rotated(place.rot));
    // Sim y is down; the generator's is up (see `threeY`).
    return new Vec2(w.x, -w.y);
  });
  const plain = (vs: readonly Vec2[]): { x: number; y: number }[] => vs.map((v) => ({ x: v.x, y: v.y }));
  // A loop that is not simple decomposes to nothing; the generator then gets
  // the outline whole, which is what the extrusion draws too.
  const parts = decomposeConvex(world);
  const depth = g.depth ?? DEFAULT_THICKNESS;
  return {
    verts: plain(world),
    convex: (parts.length > 0 ? parts : [world]).map(plain),
    depth,
    z: g.z ?? 0,
    bevel: Math.max(0, Math.min(g.bevel ?? 0, depth * 0.25)),
    mossy: g.texture === "moss-dark" || g.texture === "mossy ground",
  };
}

// Every rock body in the level, with its pieces laid out in world space.
export function rockBodies(data: LevelData): RockBody[] {
  const out: RockBody[] = [];
  data.bodies.forEach((body, index) => {
    if (!isRockBody(body)) return;
    const objects = body.objects.filter(isGeometryObject).filter(isRockObject);
    if (objects.length === 0) return;
    const pieces = objects.map((g) => pieceOf(body, g));
    out.push({ index, hash: rockHash(pieces), pieces, objects });
  });
  return out;
}

// FNV-1a over the pieces at millimetre resolution. Coordinates are rounded so a
// level re-saved by the editor with float noise a few nanometres off still
// hashes the same, while a vertex nudged by a millimetre is a different rock.
// Written out by hand rather than through `crypto`, because the generator runs
// it under bun and the runtime in a browser and both must agree bit for bit.
export function rockHash(pieces: RockPiece[]): string {
  let h = 0x811c9dc5;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const mm = (v: number): string => Math.round(v * 1000).toString();
  for (const p of pieces) {
    feed(`d${mm(p.depth)}z${mm(p.z)}b${mm(p.bevel)}m${p.mossy ? 1 : 0}:`);
    for (const v of p.verts) feed(`${mm(v.x)},${mm(v.y)};`);
    feed("|");
  }
  return h.toString(16).padStart(8, "0");
}

// The generated node's name for a body, and the two facts the generator stamps
// on it as glTF extras (which three hands back as `userData`).
export function rockNodeName(index: number): string {
  return `body-${index}`;
}
export const ROCK_INDEX_KEY = "rockIndex";
export const ROCK_HASH_KEY = "rockHash";

// Where a level's generated rocks are served from. Under `public/rocks/`, which
// is gitignored like every other binary the renderer draws.
export function rocksUrl(level: string): string {
  return `/rocks/${level}.glb`;
}
