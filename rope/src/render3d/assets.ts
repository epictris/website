// Surfaces and props for the 3D scene: what a body is MADE of, turned into
// something the GPU can shade.
//
// Two halves, and the split is the point.
//
// SURFACES are keyed by the material names the level format already has (wood,
// stone, brick, steel, ice, ...), so `material` alone - which an author is
// already choosing, because it is what the body weighs - picks a sensible
// surface and a level needs no visual authoring at all to stop looking like flat
// shading. One `MeshStandardMaterial` per key, shared by every body that names
// it, so 154 bodies are a handful of materials and a handful of draw states.
//
// The maps themselves are GENERATED rather than loaded. A real PBR texture set
// is three 1k images per material and this project ships no binary assets; a
// value-noise field turned into an albedo, a height-derived normal map and a
// roughness map gets most of the way there - grain, tonal variation, a surface
// that catches the sun differently as it turns - for a few hundred bytes of
// code and no download. `TEXTURE_SETS` is the table to replace, one entry at a
// time, if authored maps ever arrive: the loader below already keys on the same
// names and the UVs are already in metres (see extrude.ts), so a real texture
// drops in with a `repeat` and nothing else moves.
//
// PROPS are the GLTF half: a hand-written manifest mapping a key to a file, an
// async cached loader, and a neutral placeholder returned immediately so a
// mesh that has not arrived yet never blocks the frame or the sim.

import * as THREE from "three";
import { MATERIAL_NAMES, type MaterialName } from "../lib/shapeGeometry";

// How a surface looks. `tile` is the size of one texture repeat in METRES, which
// is meaningful because the extruder writes UVs in metres: a 4 m wall and a
// 0.4 m plank of the same oak show the same grain rather than the same number of
// repeats.
export interface TextureSet {
  base: string; // albedo, hex
  // Second tone the noise mixes toward: the grain, the mortar, the rust.
  grain: string;
  roughness: number;
  metalness: number;
  tile: number;
  // How pronounced the surface relief is, 0..1 - what the normal map is derived
  // from. Stone is rough; glass is flat.
  relief: number;
  // Noise frequency in cells per tile. Low is boulders and planks, high is
  // gravel and brushed metal.
  cells: number;
}

// One entry per material the level format knows about, so `materialTexture`
// cannot be handed a name it has no answer for. The colours are the reference
// look's: warm, desaturated, nothing fully black or fully saturated, since ACES
// tone mapping (see environment.ts) has the range to make a mid tone read as
// bright once the sun hits it.
export const TEXTURE_SETS: Record<MaterialName, TextureSet> = {
  wood: { base: "#8a6440", grain: "#5c3f27", roughness: 0.78, metalness: 0, tile: 1.2, relief: 0.5, cells: 3 },
  ice: { base: "#a8c8d8", grain: "#d6ecf5", roughness: 0.12, metalness: 0, tile: 1.6, relief: 0.15, cells: 2 },
  flesh: { base: "#b07a68", grain: "#8a5a4c", roughness: 0.7, metalness: 0, tile: 0.8, relief: 0.3, cells: 4 },
  rubber: { base: "#3a3a3e", grain: "#242427", roughness: 0.95, metalness: 0, tile: 0.6, relief: 0.35, cells: 6 },
  brick: { base: "#9a5a45", grain: "#6d3f30", roughness: 0.85, metalness: 0, tile: 0.9, relief: 0.7, cells: 5 },
  stone: { base: "#8d8b84", grain: "#5f5d58", roughness: 0.9, metalness: 0, tile: 1.5, relief: 0.85, cells: 4 },
  glass: { base: "#9fb6be", grain: "#c2d6dc", roughness: 0.08, metalness: 0, tile: 2, relief: 0.05, cells: 2 },
  aluminium: { base: "#a9adb2", grain: "#7d8288", roughness: 0.35, metalness: 0.9, tile: 1, relief: 0.2, cells: 8 },
  "cast iron": { base: "#4a4a4e", grain: "#2c2c30", roughness: 0.55, metalness: 0.85, tile: 0.8, relief: 0.45, cells: 5 },
  steel: { base: "#8d949c", grain: "#5b6169", roughness: 0.3, metalness: 0.95, tile: 1, relief: 0.2, cells: 7 },
  lead: { base: "#6e7176", grain: "#4a4d51", roughness: 0.6, metalness: 0.8, tile: 1.1, relief: 0.3, cells: 4 },
};

// A `visual.texture` or a `material` name resolved to a set. An unknown name
// takes the default surface for the same reason `materialDensity` takes the
// default density: a hand-edited level naming a texture this build does not have
// should look ordinary, not invisible.
export const DEFAULT_TEXTURE: MaterialName = "wood";

export function textureSetName(name: string | undefined): MaterialName {
  if (name !== undefined && (MATERIAL_NAMES as string[]).includes(name)) return name as MaterialName;
  return DEFAULT_TEXTURE;
}

// ---------------------------------------------------------------------------
// Procedural maps
// ---------------------------------------------------------------------------

const MAP_SIZE = 256;

// Value noise on a wrapping lattice, so the map tiles seamlessly. Fractal over a
// few octaves, which is what stops it reading as a single blur.
function noiseField(cells: number, octaves = 4): Float32Array {
  const out = new Float32Array(MAP_SIZE * MAP_SIZE);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = Math.max(2, Math.round(cells * 2 ** o));
    // A deterministic lattice: the same material always generates the same
    // texture, so a screenshot taken twice is the same screenshot.
    const lattice = new Float32Array(n * n);
    let seed = 0x9e3779b9 ^ (n * 2654435761);
    for (let i = 0; i < lattice.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      lattice[i] = seed / 0xffffffff;
    }
    const smooth = (t: number) => t * t * (3 - 2 * t);
    for (let y = 0; y < MAP_SIZE; y++) {
      const fy = (y / MAP_SIZE) * n;
      const y0 = Math.floor(fy) % n;
      const y1 = (y0 + 1) % n;
      const ty = smooth(fy - Math.floor(fy));
      for (let x = 0; x < MAP_SIZE; x++) {
        const fx = (x / MAP_SIZE) * n;
        const x0 = Math.floor(fx) % n;
        const x1 = (x0 + 1) % n;
        const tx = smooth(fx - Math.floor(fx));
        const a = lattice[y0 * n + x0]! * (1 - tx) + lattice[y0 * n + x1]! * tx;
        const b = lattice[y1 * n + x0]! * (1 - tx) + lattice[y1 * n + x1]! * tx;
        out[y * MAP_SIZE + x]! += (a * (1 - ty) + b * ty) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function canvasTexture(write: (data: Uint8ClampedArray) => void): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = MAP_SIZE;
  canvas.height = MAP_SIZE;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(MAP_SIZE, MAP_SIZE);
  write(img.data);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// Albedo, normal and roughness from one height field, which is what makes the
// three agree: a dark patch of grain is also a dip and also a rougher spot,
// exactly as it is on the real material.
function buildMaps(set: TextureSet): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
} {
  const h = noiseField(set.cells);
  const [br, bg, bb] = hexToRgb(set.base);
  const [gr, gg, gb] = hexToRgb(set.grain);
  const map = canvasTexture((d) => {
    for (let i = 0; i < h.length; i++) {
      const t = h[i]!;
      d[i * 4] = br * (1 - t) + gr * t;
      d[i * 4 + 1] = bg * (1 - t) + gg * t;
      d[i * 4 + 2] = bb * (1 - t) + gb * t;
      d[i * 4 + 3] = 255;
    }
  });
  map.colorSpace = THREE.SRGBColorSpace;

  const normalMap = canvasTexture((d) => {
    const at = (x: number, y: number) =>
      h[((y + MAP_SIZE) % MAP_SIZE) * MAP_SIZE + ((x + MAP_SIZE) % MAP_SIZE)]!;
    const strength = set.relief * 4;
    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        // The gradient as a tangent-space normal, renormalised so a flat area is
        // exactly (0,0,1) rather than merely near it.
        const len = Math.hypot(-dx, -dy, 1);
        const i = (y * MAP_SIZE + x) * 4;
        d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
        d[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
        d[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
        d[i + 3] = 255;
      }
    }
  });

  const roughnessMap = canvasTexture((d) => {
    for (let i = 0; i < h.length; i++) {
      // Rougher in the dips, which is where dirt and wear sit.
      const r = Math.max(0, Math.min(1, set.roughness + (h[i]! - 0.5) * 0.35));
      d[i * 4] = 255;
      d[i * 4 + 1] = r * 255; // three reads roughness from the green channel
      d[i * 4 + 2] = 0;
      d[i * 4 + 3] = 255;
    }
  });
  return { map, normalMap, roughnessMap };
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

// Materials and textures are shared across every `Scene3D` on the page. That is
// deliberate and is NOT the module-global state `Scene3D` is forbidden (see the
// playerRig note in docs/3d-rendering-plan.md): a material here is immutable
// once built and belongs to no scene, so the editor and the game holding the
// same one is exactly the sharing a cache is for. Anything a scene MUTATES lives
// on the scene.
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

// The shared surface for a texture-set key. Callers must not mutate the result;
// a body that needs its own tint clones it.
export function surfaceMaterial(name: string | undefined): THREE.MeshStandardMaterial {
  const key = textureSetName(name);
  const cached = materialCache.get(key);
  if (cached) return cached;
  const set = TEXTURE_SETS[key];
  const maps = buildMaps(set);
  for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) {
    t.repeat.set(1 / set.tile, 1 / set.tile);
  }
  const mat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness: 1, // the map is the roughness; this is its multiplier
    metalness: set.metalness,
    normalScale: new THREE.Vector2(1, 1),
  });
  materialCache.set(key, mat);
  return mat;
}

// A body's authored fill colour, applied to a copy of its surface. Levels are
// authored with colours and those colours are how an author distinguishes one
// wall from another, so the 3D scene TINTS the material rather than ignoring it:
// the texture supplies the grain and the relief, the authored colour supplies
// the hue.
//
// Tints are cached on the same key-plus-colour, so a level of 154 bodies in
// three colours is three materials.
export function tintedSurface(
  texture: string | undefined,
  color: string | undefined,
): THREE.MeshStandardMaterial {
  const base = surfaceMaterial(texture);
  if (!color) return base;
  const key = `${textureSetName(texture)}|${color}`;
  const cached = materialCache.get(key);
  if (cached) return cached;
  const mat = base.clone();
  // Multiplied against the albedo map, so the grain survives the tint rather
  // than being painted over by it.
  mat.color = new THREE.Color(color);
  materialCache.set(key, mat);
  return mat;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MeshAsset {
  // Path under `public/`, so vite serves it in dev and copies it in a build.
  // Under `public/meshes/`, which is gitignored and populated by
  // `bun run assets:fetch` - the bytes live in a GitHub Release, not in git (see
  // scripts/assetStore.ts for why). The basename is also the asset's name in
  // that release, so it must be unique across the manifest.
  file: string;
  // The bytes this revision of the repo was written against. A release asset can
  // be replaced in place, so this is the only thing that says WHICH boulder a
  // given commit meant; the fetch verifies it and fails hard on a mismatch.
  // `bun run assets:publish` prints it.
  sha256: string;
  // Uniform scale from the model's own units to metres. A model authored at a
  // real-world size in metres is 1; anything else states its conversion here
  // rather than every level that uses it restating it in `visual.scale`.
  scale?: number;
  // Rotation applied before the body's, radians - a model whose forward axis is
  // not the one this game uses is fixed once, here.
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  // WHERE THIS CAME FROM, who made it, and what it may be used under. All three
  // required, and `cli assets` fails without them, because provenance is exactly
  // the thing that goes missing: the file is opaque, the licence lives on a web
  // page nobody revisits, and a year later "can this ship" has no answer but
  // "delete it and remodel". A binary with no source is a liability rather than
  // an asset.
  //
  // `author` is separate from `source` because a licence like CC-BY obliges you
  // to credit a PERSON, and a link to the page you found it on is not that.
  // CREDITS.md is generated from these fields (`bun run assets:credits`) and
  // checked against them, so an asset cannot ship uncredited.
  source: string;
  author: string;
  license: string;
}

// The prop manifest. Hand-written on purpose: an asset is a decision (this rock,
// at this size, facing this way), and a directory scan would make adding a file
// silently change what a level looks like. It is also the licence record - see
// `source`/`license` above - so it is the one place an asset is described rather
// than a name paired with a file somewhere else.
//
// Empty until assets are added. `kind: "mesh"` naming a key that is not here
// draws the placeholder, which is a grey box of the body's own size - visible,
// obviously wrong, and never a hole in the level.
//
// Every entry is `assets:optimize`d, then `assets:publish`ed, and `cli assets`
// holds the whole directory to a byte budget; see "Prop assets" in CLAUDE.md.
export const MESH_ASSETS: Record<string, MeshAsset> = {
  yellow_barrel: {
    file: "/meshes/yellow_barrel.glb",
    sha256: "90038a5e6bedf98d2c791669c81bdaeb5ee3b29814ece05ad51024f5a4296597",
    source:
      "https://sketchfab.com/3d-models/low-poly-closed-barrels-8df46c47099a4b9d9bc4a69edcad1b88",
    author: "Anna Denisova (@Den1121)",
    license: "CC BY 4.0",
  },
};

const gltfCache = new Map<string, Promise<THREE.Object3D | null>>();

// The GLTF loader is imported DYNAMICALLY, so it lands in a chunk of its own and
// is fetched only by a page that actually loads a prop. It is a large module,
// the manifest is empty for a level that authors no meshes, and the editor never
// needs it eagerly - which is exactly the case chunk splitting is for.
let loaderPromise: Promise<{ loadAsync(url: string): Promise<{ scene: THREE.Object3D }> }> | null =
  null;

function gltfLoader(): Promise<{ loadAsync(url: string): Promise<{ scene: THREE.Object3D }> }> {
  // The meshopt decoder is NOT optional. `assets:optimize` runs every prop
  // through `--compress meshopt`, which lands `EXT_meshopt_compression` in the
  // file's `extensionsRequired` - so a loader without the decoder does not
  // degrade to an uncompressed read, it refuses the file outright and the prop
  // falls back to its placeholder box. It is ~25 KB, it ships with three, and it
  // rides the same dynamic import as the loader, so a page with no props still
  // fetches neither.
  loaderPromise ??= Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ]).then(([{ GLTFLoader }, { MeshoptDecoder }]) =>
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),
  );
  return loaderPromise;
}

// The prop for a manifest key, as a fresh instance the caller owns. Resolves to
// null for an unknown key or a load failure, which is the caller's cue to keep
// its placeholder.
export function loadMesh(key: string): Promise<THREE.Object3D | null> {
  const cached = gltfCache.get(key);
  if (cached) return cached.then((o) => (o ? o.clone(true) : null));
  const asset = MESH_ASSETS[key];
  if (!asset) return Promise.resolve(null);
  const p = gltfLoader()
    .then((loader) => loader.loadAsync(asset.file))
    .then((gltf) => {
      const root = gltf.scene;
      const s = asset.scale ?? 1;
      root.scale.setScalar(s);
      root.rotation.set(asset.rotX ?? 0, asset.rotY ?? 0, asset.rotZ ?? 0);
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      return root as THREE.Object3D;
    })
    .catch((err: unknown) => {
      console.warn(`[render3d] mesh "${key}" failed to load:`, err);
      return null;
    });
  gltfCache.set(key, p);
  return p.then((o) => (o ? o.clone(true) : null));
}
