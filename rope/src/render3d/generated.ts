// Generated meshes: the key a generated geometry object's `mesh` holds, and
// where the file behind a key lives.
//
// A key is CONTENT-ADDRESSED: `<kind>:<hash>`, the hash taken over everything
// the generator is given (its kind, its schema version, its input and the
// parameters that differ from the defaults). So the level file says what the
// mesh is, "stale" is `mesh !== generatedKey(...)` of the object as it now
// stands, and generating the same thing twice is one Blender run and one file.
//
// The same function runs in the browser (the editor's staleness badge), in bun
// (`cli render3d` pins it) and on the dev server (which refuses a request whose
// key does not match its content), so it is written against nothing but the
// language: no `crypto`, no platform maths, one integer hash over a string whose
// every character is fixed by the ECMAScript spec. It lives in render3d, outside
// the dmath scan, because nothing in the sim may ever depend on it.
//
// Node callers wanting a file's recorded facts (its bytes) use
// `generatedMeta.ts`, kept apart so no `fs` import reaches the browser bundle.

import {
  canonicalParams,
  isGeneratorKind,
  loadSchema,
  roundParam,
  type GeneratorKind,
  type ParamValue,
} from "../level/generatorParams";

// Where generated files are served from, under `public/`. Dev-only for now and
// gitignored; the layout is `<root>/<kind>/<hash>/mesh.glb` beside `meta.json`
// (see docs/render3d.md, "Generated meshes").
export const GENERATED_ROOT = "/generated";
export const GENERATED_MESH_FILE = "mesh.glb";
export const GENERATED_META_FILE = "meta.json";

// A boulder is fitted to an outline: the geometry object's own shape, in its
// own frame, metres, y UP (x right), in the shape's vertex order. The frame is
// the one `mountVisual` places the GLB in, so the generated rock needs no
// transform of its own; y is flipped from the level's y-down because the
// generator (and three) work y up. This is exactly what the fork's editor sent
// (`localVertices(item).map(p => [p.x, threeY(p.y)])`).
export interface BoulderInput {
  outline: [number, number][];
}

// A mushroom patch grows inside a loop painted on a host object's surface. The
// loop is in the PATCH object's own frame, metres, y up, z toward the camera
// off the object's own plane (its `z`); the host is described by what decides
// its drawn surface, placed relative to the patch, so moving the patch and its
// host together (a body move) changes nothing and moving either alone makes
// the patch stale. The triangle soup the generator is actually handed is
// collected from the host's drawn meshes at generation time and is NOT part of
// the key: it is derived from these, and the server checks the key against
// this input, not against the soup.
//
// `facing` is which side of the loop's plane the loop was painted on: a unit
// vector in the patch's frame (y up), the mean of the painted faces' normals.
// The surface collected from the loop depends on it (a loop near a wide face's
// edge has a plane of best fit that could be read either way round), so it is
// part of the key. Absent for a patch saved before it was stored, whose side
// is guessed from its host's middle.
export interface MushroomsInput {
  loop: [number, number, number][];
  facing?: [number, number, number];
  host: PatchHost;
}
export interface PatchHost {
  kind: "primitive" | "mesh";
  mesh: string; // the host's mesh key ("" for a primitive)
  // For a GENERATED host with no mesh yet: the key it would be generated
  // under, so two rocks never generated whose patches sit alike are still two
  // hosts. Absent otherwise - a mesh key already names what is drawn, and a
  // stale host is drawn (and grown on) as the mesh it has.
  generator?: string;
  // A primitive's form, which is its surface: its outline in its own frame (y
  // up) or its radius, and the look fields that change the extrusion or what
  // it wears. Absent for a mesh, whose key already says what it is.
  outline?: [number, number][];
  radius?: number;
  depth?: number | null;
  bevel?: number | null;
  taperStart?: number;
  taperAngle?: number;
  texture?: string;
  projection?: string;
  // The host's frame in the patch's frame, three's axes (y up), metres: the
  // top three rows of the 4x4 affine matrix, row by row. Both frames carry
  // their object's place, turn, tilt (rotX, rotY) and scale, so a patch tipped
  // or scaled on its own, or a host moved, tipped or scaled on its own, is a
  // different key, and a body moved as a whole is not.
  frame: number[];
}

export type GeneratorInput = BoulderInput | MushroomsInput;

// The canonical string: object keys sorted, undefined dropped, every number at
// the parameter resolution (a ten-thousandth, so 0.1 mm for a length), -0 as 0.
// `String` of a double is exactly specified (shortest round-tripping digits),
// so the same value prints the same characters in every engine.
export function canonicalString(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`generatedKey: non-finite number ${value}`);
    return String(roundParam(value));
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalString(o[k])}`).join(",")}}`;
  }
  throw new Error(`generatedKey: cannot canonicalise a ${typeof value}`);
}

// 64-bit FNV-1a over the string's UTF-8 bytes, as 16 hex digits. BigInt keeps
// the 64-bit product exact in every engine; the strings are a few kilobytes at
// most (an outline of a hundred vertices), so its speed does not matter.
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
export function fnv1a64(text: string): string {
  let h = FNV64_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

// The key of the mesh a generator makes from this content. `params` may hold
// defaults and unrounded numbers: they are brought to canonical form here
// (defaults stripped against the CURRENT schema for the kind, keys sorted), so
// every caller gets one key for one rock however it spelled the parameters.
export function generatedKey(
  kind: GeneratorKind,
  version: number,
  input: GeneratorInput,
  params: Readonly<Record<string, ParamValue | null>>,
): string {
  const text = canonicalString({
    kind,
    version,
    input,
    params: canonicalParams(params, loadSchema(kind)),
  });
  return `${kind}:${fnv1a64(text)}`;
}

const KEY_PATTERN = /^(boulder|mushrooms):([0-9a-f]{16})$/;

export function parseGeneratedKey(key: string): { kind: GeneratorKind; hash: string } | null {
  const m = KEY_PATTERN.exec(key);
  if (!m || !isGeneratorKind(m[1])) return null;
  return { kind: m[1], hash: m[2]! };
}

// The directory a key's files live in, as a URL path under `public/`.
export function generatedDir(kind: GeneratorKind, hash: string): string {
  return `${GENERATED_ROOT}/${kind}/${hash}`;
}

// The file a generated key draws, or null for any other key (a manifest key,
// which `loadMesh` then looks up in `MESH_ASSETS`). Its size is not known here
// - the key carries none - so the browser fetches it unweighted and a node
// caller reads `generatedMeta` for it.
export function generatedMeshAsset(key: string): { file: string } | null {
  const parsed = parseGeneratedKey(key);
  if (!parsed) return null;
  return { file: `${generatedDir(parsed.kind, parsed.hash)}/${GENERATED_MESH_FILE}` };
}
