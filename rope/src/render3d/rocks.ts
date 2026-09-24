// GENERATED ROCKS: which of a level's drawn pieces are rock, laid out in world
// space for the offline generator, and the hash that says whether a generated
// mesh still matches what the level authors.
//
// `scripts/generate-rocks.ts` turns each rock body's outlines into a job for
// `tools/blender/rocks.py`, which builds faceted boulders in headless Blender
// and writes one GLB per level to `public/rocks/<level>.glb`. That pipeline is
// superseded (docs/rocks.md): the game and the editor both draw a rock as its
// tapered extrusion and never load the GLB. The editor's collision fit and
// `cli rocks-check` still read it.
//
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
  "rock-grey",
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
  // Where the taper begins, metres in front of the piece's own plane
  // (`GeometryObjectData.taperStart`, absent = 0 = the gameplay plane): behind
  // it the rock's walls stand on the outline, from it forward they lean in.
  taperStart: number;
  // How far the tapered surface leans in from the wall, degrees in [0, 90]
  // (`GeometryObjectData.taperAngle`, absent = 0 = no taper, a straight
  // extrusion of the outline; 90 = a flat top at `taperStart`). The piece's
  // `bevel` belongs to the flat extrusion and is not carried here.
  taperAngle: number;
  // Whether the piece wears a mossy surface. Ignored by the generator today;
  // carried so a moss pass changes the job, and therefore the hash.
  mossy: boolean;
}

export interface RockBody {
  // Index into `LevelData.bodies`, which is also the index into
  // `BuiltBodies.bodies` (one per authored body, in authored order).
  index: number;
  // `rockHash` of `pieces` and `seed`: the generated node carries the hash it
  // was built from, and the runtime only mounts it while the two agree.
  hash: string;
  // The body's `rockSeed` (absent = 0), which the generator seeds every random
  // choice in this body's rock from.
  seed: number;
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
    taperStart: g.taperStart ?? 0,
    taperAngle: Math.max(0, Math.min(g.taperAngle ?? 0, 90)),
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
    const seed = body.rockSeed ?? 0;
    out.push({ index, hash: rockHash(pieces, seed), seed, pieces, objects });
  });
  return out;
}

// FNV-1a over the seed and the pieces at millimetre resolution. Coordinates are
// rounded so a level re-saved by the editor with float noise a few nanometres
// off still hashes the same, while a vertex nudged by a millimetre is a
// different rock. The seed goes in first: the same outline under another seed
// is another rock, so a new seed leaves the old node stale until regenerated.
// Written out by hand rather than through `crypto`, because the generator runs
// it under bun and the runtime in a browser and both must agree bit for bit.
export function rockHash(pieces: RockPiece[], seed: number): string {
  let h = 0x811c9dc5;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const mm = (v: number): string => Math.round(v * 1000).toString();
  feed(`s${seed}|`);
  for (const p of pieces) {
    // The angle to a tenth of a degree, the finest step worth telling apart.
    feed(`d${mm(p.depth)}z${mm(p.z)}t${mm(p.taperStart)}a${Math.round(p.taperAngle * 10)}m${p.mossy ? 1 : 0}:`);
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

// A generated file's identity: FNV-1a over its bytes read as 32-bit
// little-endian words (and any tail byte by byte), 8 hex characters. The
// generator prints it at the end of a build, the page logs it when it mounts
// the file, `cli rocks-check` prints it and an F4 view capture carries it, so a
// report names the exact bytes it was made against. Identity, not security;
// words rather than bytes because the level file is 60 MB and the page hashes
// it on load (about a quarter of the byte loop's time). Here rather than in a
// crypto API because bun and the browser must agree bit for bit.
export function rockFileId(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength >>> 2);
  for (let i = 0; i < words.length; i++) {
    h ^= words[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = words.length * 4; i < aligned.byteLength; i++) {
    h ^= aligned[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// A VIEW CAPTURE (F4 in the game): what is needed to put a headless grab on the
// same picture, in the units `cli shot` takes. `cli shot --view capture.json`
// reads it back.
export interface ViewCapture {
  // The registry id of the level played (`?level=`).
  level: string;
  // The sim-metre point the camera looks at (sim y down, as `--at`).
  at: [number, number];
  // Yaw and pitch in degrees (`--orbit`); the game's own view is head-on.
  orbit: [number, number];
  zoom: number;
  // The served tree (see src/sim/treeStamp.ts).
  tree: string;
  srcHash: string;
}
