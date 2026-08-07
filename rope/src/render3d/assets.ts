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
// A surface comes from one of two places, and a level cannot tell which. Both
// are keyed into ONE namespace that `surfaceFor` looks up authored-first:
//
// - GENERATED (`TEXTURE_SETS`): a value-noise field turned into an albedo, a
//   height-derived normal map and a roughness map, one entry per material name.
//   Grain, tonal variation, a surface that catches the sun differently as it
//   turns - for a few hundred bytes of code and no download, which is why every
//   level looked fully 3D before a single asset existed and why an unknown
//   texture name still lands on something ordinary rather than on nothing.
// - AUTHORED (`TEXTURE_ASSETS`): a real PBR set - albedo, normal, roughness,
//   metallic and ambient occlusion - fetched from the release store like a prop,
//   sha256-pinned, and swapped into the material once it arrives. Until then the
//   generated surface is what is drawn, so an authored texture is never a white
//   box on a slow connection.
//
// Tiling is a LENGTH in both halves: the extruder writes its UVs in metres
// (extrude.ts), so `tile` is the size of one repeat in the world and a 4 m wall
// and a 0.4 m plank of the same oak show the same grain rather than the same
// number of repeats. A body may override it per shape (`VisualData.tile`).
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
// Authored texture sets
// ---------------------------------------------------------------------------

// One map of an authored PBR set: a file under `public/`, pinned to the bytes
// this revision was written against, exactly as a `MeshAsset` is and for the
// same reasons (see `MeshAsset.file` / `.sha256`).
export interface TextureMap {
  file: string;
  sha256: string;
}

// A surface made of AUTHORED images rather than generated noise. The five maps
// are the five questions a PBR shader asks about a surface, and each is
// optional: a set is whatever of them the author has, and every one absent
// leaves the scalar below (or three.js's own default) doing the job, so a set of
// nothing but an albedo is a legitimate - and often sufficient - thing to ship.
//
// Channel conventions are three.js's, which are glTF's:
//   base       albedo, sRGB. The only one that is colour rather than data.
//   normal     tangent space, linear. +Y up (OpenGL); a DirectX-convention map
//              reads as lighting from the wrong vertical side, so flip it in the
//              texture tool rather than in a shader here.
//   roughness  GREEN channel. A greyscale file has R=G=B and simply works.
//   metallic   BLUE channel, likewise.
//   ao         RED channel, likewise. Read from the same UVs as everything else
//              (`Texture.channel` 0), since the extruder writes one metre-scaled
//              UV set and there is no second one to point it at.
//
// A set REPLACES the generated surface for the material it stands in for; it
// does not blend with it. Until the images arrive the generated one is what is
// drawn (see `fallback`), which is why a level dressed in authored textures is
// never a scene of untextured white boxes on a slow connection.
export interface TextureAsset {
  // The images themselves, nested so the five map slots and the scalars below
  // that scale them cannot collide over a name.
  maps: {
    base?: TextureMap;
    normal?: TextureMap;
    roughness?: TextureMap;
    metallic?: TextureMap;
    ao?: TextureMap;
    // WHERE this surface glows, and in what colour: a picture, added after all
    // lighting and multiplied by the shape's own `emissive` tint. It is what
    // makes the emission a PATTERN rather than the whole face - lit windows in a
    // dark wall, cracks in cooling slag, a strip along a machine - which a flat
    // emissive colour cannot say at all.
    //
    // A set carrying one glows with no level authoring: the shape's `emissive`
    // colour defaults to white, so the map's own colours are what is emitted,
    // and a shape naming a colour tints it. Since a glowing shape LIGHTS (see
    // `EmissiveRig`), a surface with this map lights the room by being worn -
    // `VisualData.emissiveRange` 0 is the opt-out for one that should not.
    emissive?: TextureMap;
  };
  // Size of one repeat in METRES: the world distance this surface was captured
  // over, which is a fact about the texture rather than a choice. It is what a
  // shape's `tileScale` multiplies, so life size is `1` everywhere in every level
  // and stays life size if this set is later replaced by one captured at a
  // different size.
  tile: number;
  // Multipliers, applied on top of whatever the maps say. With no roughness map
  // `roughness` IS the roughness; with one it scales it. Absent = 1, which is
  // "the map alone", and 1 for metalness would make an untextured set fully
  // metal - so a set with no metallic map wants an explicit 0 here, and that is
  // the default rather than a trap left to the author.
  roughness?: number;
  metalness?: number;
  // Relief strength of the normal map, and how hard the AO map bites. Absent =
  // 1 for both, which is the map as authored.
  normalScale?: number;
  aoIntensity?: number;
  // The generated surface to wear until the images load, and to fall back to on
  // a load failure. A missing texture is then a wall that looks like ordinary
  // stone rather than a hole in the level - the same rule the prop placeholder
  // follows. Absent = the default surface.
  fallback?: MaterialName;
  // WHERE THIS CAME FROM, who made it, and what it may be used under - required,
  // and `cli assets` fails without them, for exactly the reasons `MeshAsset`
  // states at length: the file is opaque, the licence lives on a web page nobody
  // revisits, and a binary with no source is a liability rather than an asset.
  source: string;
  author: string;
  license: string;
}

// The texture manifest. Hand-written like the prop manifest, and for the same
// reason: an asset is a decision, and a directory scan would make dropping a
// file into a folder silently change what a level looks like.
//
// Empty until sets are added. A `visual.texture` naming a key that is not here
// falls through to the generated surfaces, so an unknown name is an ordinary
// wall rather than an invisible one.
//
// Every entry is `assets:optimize-texture`d, then `assets:publish`ed, and
// `cli assets` holds the whole directory to a byte budget; see "The asset store"
// in CLAUDE.md.
export const TEXTURE_ASSETS: Record<string, TextureAsset> = {
  // Keyed as "brick" - the MATERIAL name - which is the whole point of the one
  // namespace: every body already made of brick wears this the moment it is in
  // the manifest, with no level edited. Name a set something else only when it
  // is a second brick rather than the brick.
  //
  // CC0, and that is a requirement rather than a preference for anything in this
  // store: the maps are served from a PUBLIC release, which is a standalone,
  // reusable copy of the asset however internal the intent - see "The asset
  // store". A licence that forbids redistributing the files forbids that, so a
  // licensed set has to stay off this manifest.
  brick: {
    maps: {
      base: {
        file: "/textures/factory-brick-base.webp",
        sha256: "5a95a794e391636692452711f2d8aa7caf512f4d0b51929e1b7c2ae9cfac4840",
      },
      // Poly Haven ships `nor_gl`, which is the OpenGL convention (+Y up) this
      // renderer wants; a `nor_dx` map would light every crack from the wrong
      // vertical side and has to be flipped in the texture tool rather than here.
      normal: {
        file: "/textures/factory-brick-normal.webp",
        sha256: "3770c43d120a4b3539ce3f6c924602422262d6a831440813048a937e39b9e0a0",
      },
      roughness: {
        file: "/textures/factory-brick-roughness.webp",
        sha256: "14b4965f7d1c70dd5c879e66eeabf258c400f428fcdd7b31bafb7bc83f36303f",
      },
      // No AO and no metallic map in this set, which is ordinary: brick is a
      // dielectric, so `metalness` below says so once rather than as 4 MB of
      // black pixels, and the generated surface's own relief covers the AO.
      // The displacement map the download also carries has nowhere to go - these
      // are extruded prisms, not tessellated surfaces.
    },
    // Metres per repeat, and this one is a FACT rather than a judgement: Poly
    // Haven publishes the real-world size it was captured at (1.5 x 1.5 m, see
    // `scale` on https://api.polyhaven.com/info/factory_brick), and the UVs here
    // are in metres, so the texture lands at life size with no eyeballing. Where
    // a source states no size, this is the number to set by eye instead - and
    // `VisualData.tile` is the per-shape override either way.
    tile: 1.5,
    // A roughness map is present, so this is its multiplier; metalness has no
    // map and is therefore the value itself, which for brick is zero.
    metalness: 0,
    // What is drawn until the maps arrive, and what a failed load falls back to.
    fallback: "brick",
    source: "https://polyhaven.com/a/factory_brick",
    author: "Rob Tuytel",
    license: "CC0",
  },
  // Keyed as a SURFACE rather than as a material name, which is the other half
  // of the one namespace: `stone` already has a generated surface every stone
  // body wears, and this is a particular weathered wall rather than what stone
  // is. A shape asks for it by name (`visual.texture`, the editor's texture
  // picker), and anything that does not goes on wearing the generated stone.
  "rock wall": {
    maps: {
      base: {
        file: "/textures/rock-wall-base.webp",
        sha256: "dc7e2bb63a22f71aa629b7c46cff57818e902c6a88e7abc6f28ba7bab31c4875",
      },
      normal: {
        file: "/textures/rock-wall-normal.webp",
        sha256: "7641c194d6b94261bd36e1fab4b782fbbf896bd5d7428e41e51543c65f09aa7f",
      },
      // Poly Haven ships roughness, metallic and AO packed into one ARM image -
      // R ambient occlusion, G roughness, B metallic - so the two maps this set
      // wants are the same download read on two channels, each flattened to grey
      // by `assets:optimize-texture --channel`. The B channel is a dielectric's
      // zero and is stated below rather than shipped as a black image.
      roughness: {
        file: "/textures/rock-wall-roughness.webp",
        sha256: "0874e41efdaa9ba52803358fa7370bd0732a687339a4202297a50872dda022ae",
      },
      ao: {
        file: "/textures/rock-wall-ao.webp",
        sha256: "d24e98a7701f3aa60e269f22528f568c3f6f1ed02f635ad73a8cd7da067cc148",
      },
    },
    // Poly Haven's own captured size, 1800 mm square
    // (https://api.polyhaven.com/info/rock_wall_08), so the blocks land life
    // size with nothing eyeballed.
    tile: 1.8,
    metalness: 0,
    fallback: "stone",
    source: "https://polyhaven.com/a/rock_wall_08",
    author: "Amal Kumar",
    license: "CC0",
  },
  // Pitted, rust-bloomed iron: what the ball, its mounting loop, its chain and
  // the manacle at the far end are forged from (`ballVisual`/`chainVisual`).
  //
  // Keyed as a SURFACE rather than under `cast iron` or `steel`, which it is
  // near enough to be either of. Those two material names are worn by authored
  // level geometry as well - girders, plate, machinery - and this is a
  // particular weathered, rusted piece rather than what iron is, so a set under
  // the material's name would re-skin every steel body in every level as a side
  // effect of dressing the avatar. The avatar asks for it by name instead.
  "rusted iron": {
    maps: {
      base: {
        file: "/textures/rusted-iron-base.webp",
        sha256: "3a2a9b67cea9f1111d1ac400f37857f60da0da6bb359e5eb519e5b202ca42606",
      },
      // ambientCG ships both conventions; `NormalGL` is the OpenGL one (+Y up)
      // this renderer wants. It is nearly flat (channel means .50/.50/1.00,
      // sigma .003) because the scan is a plate rather than a relief - the rust
      // is a change of colour and roughness far more than of surface - which is
      // also why it costs 23 KB.
      normal: {
        file: "/textures/rusted-iron-normal.webp",
        sha256: "5a8dd07b7b5dbd56860a4288ef05ebe10269a6e3b3f045eb85ae2da6379b1622",
      },
      // The pair that carries the whole look: bare metal is smooth and fully
      // metallic, rust is rough and not metal at all, and having both maps is
      // what lets one surface be the two materials it physically is. Both
      // arrive with the number in RED alone and are flattened to grey by
      // `assets:optimize-texture`.
      roughness: {
        file: "/textures/rusted-iron-roughness.webp",
        sha256: "ecd27be47a577056258dac3d8618e6741d9f2a82b6aa1324ed984da2560f0e05",
      },
      metallic: {
        file: "/textures/rusted-iron-metallic.webp",
        sha256: "c8ea41878743e6e285cffe02ffdba4ea16bd6f22209bf4a3ee14494bd213ede4",
      },
      // No AO map in the set, and nothing to derive one from: an almost flat
      // surface occludes almost nothing.
    },
    // ambientCG states no captured size for this one, so this is the by-eye
    // number the manifest comment above allows for exactly that case - and the
    // bodies wearing it are `SphereGeometry` and `TorusGeometry`, whose UVs run
    // 0..1 over the whole primitive rather than in metres like the extruder's.
    // 1 m is therefore "one repeat over the ball", which is the framing
    // ambientCG's own preview sphere is shot at; the chain's links take a
    // fraction of it each through `tileScale` (see `chainVisual`).
    tile: 1,
    // A multiplier over the map, which reads a mean of 0.29 - a scan of metal
    // polished far brighter than a ball & chain has any business being. At the
    // map's own value the sphere is a mirror, and a mirror in a scene whose
    // environment is a painted sky gradient (see `environment.ts`) reflects a
    // blue sky and nothing else: the rust and the pitting the set was chosen for
    // are wiped out by a reflection of the air. Roughened, the albedo and the
    // metallic map are what is seen, which is the point of having them.
    roughness: 3.2,
    // Metalness has its own map (bare metal reads ~1, rust ~0), and this scales
    // it down rather than replacing it: the map's own bare metal is a 0.91 mean,
    // and metal is nearly ALL reflection, so at the map's value the ball is a
    // 24 cm mirror of the sky in the middle of the frame - the brightest, most
    // moving thing on screen, which is not what the thing you are steering
    // should be. Scaled down it keeps the map's rust/metal contrast and reads as
    // iron rather than as chrome.
    metalness: 0.85,
    fallback: "cast iron",
    source: "https://ambientcg.com/view?id=Metal053B",
    author: "ambientCG (Lennart Demes)",
    license: "CC0",
  },
};

// Every map of every set, which is what the fetch, the budget and the collision
// check all iterate.
export function textureMaps(asset: TextureAsset): TextureMap[] {
  const m = asset.maps;
  return [m.base, m.normal, m.roughness, m.metallic, m.ao, m.emissive].filter(
    (x): x is TextureMap => x !== undefined,
  );
}

// ---------------------------------------------------------------------------
// Procedural maps
// ---------------------------------------------------------------------------

// Shared with `water.ts`, which builds its ripple normals from the same value
// noise: a procedural map is a procedural map, and two generators drifting apart
// is two surfaces that stop looking like they belong in one level.
export const MAP_SIZE = 256;

// Value noise on a wrapping lattice, so the map tiles seamlessly. Fractal over a
// few octaves, which is what stops it reading as a single blur.
export function noiseField(cells: number, octaves = 4): Float32Array {
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

export function canvasTexture(write: (data: Uint8ClampedArray) => void): THREE.Texture {
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

// What an authored entry asks its surface to be. One request object rather than
// a positional list, because the four are read together and three of them are
// optional overrides of each other: the texture set falls back to the material
// name, the tile to the set's own, the colour to no tint at all.
export interface SurfaceRequest {
  // A `TEXTURE_ASSETS` key (an authored PBR set) or a `TEXTURE_SETS` one (a
  // generated surface, keyed by material name).
  texture?: string;
  // The shape's material, used when no texture is named - which is almost every
  // body, since naming the stuff a thing is made of is the decision an author is
  // already making.
  material?: string;
  // How large to wear it, as a MULTIPLE of the size the texture was authored at
  // (`TextureAsset.tile` / `TextureSet.tile`, both metres). 1 (and absent) is
  // life size, 2 is twice as large. The absolute size stays a fact about the
  // texture and the level says only how it wants it - see `VisualData.tileScale`.
  tileScale?: number;
  // Where the pattern starts, as a shift in METRES in level coordinates: +x
  // right, +y down. See `VisualData.tileOffsetX`.
  offsetX?: number;
  offsetY?: number;
  // The authored fill colour, already lifted to its brightness floor by the
  // caller. Multiplied against the albedo, so the grain survives the tint rather
  // than being painted over by it.
  color?: string;
  // What the surface GIVES OFF, added after all lighting (see
  // `VisualData.emissive`). It is what makes a lamp's own geometry read as lit
  // when the thing lighting the room is the lamp; it illuminates nothing itself,
  // which is why an authored sconce is this AND a `LightData` at the same point.
  emissive?: string;
  emissiveIntensity?: number;
  // A second manifest key, whose EMISSION MAP is worn over this surface: where
  // the shape glows, as against how much. See `VisualData.emissiveTexture`. It
  // is a separate request field rather than part of `texture` because the two
  // answer different questions - what this is made of, and what is lit on it -
  // and a level pairs them freely.
  emissiveTexture?: string;
}

// The shared surface for a request. Callers must not mutate the result.
//
// Cached on every part of the request that changes what the material IS, so a
// level of 154 bodies in three colours at two tiling scales is six materials and
// six draw states. The tile is part of the key because `repeat` lives on the
// texture rather than on the material: two tiling scales are two texture
// objects, sharing one uploaded image through `Texture.clone`.
// Everything about a request that changes what the material IS, as one string.
//
// Exported so it can be asserted directly (`cli render3d`), which is the only
// way this claim can be checked at all: building a material needs a canvas, and
// that case suite is deliberately pure. It also has to be checked, because
// getting it wrong is invisible everywhere else - the level renders, every round
// trip passes, and what happens is that whichever of two shapes was built first
// wins, so either every wall of that stone glows or the lamp made of it does not.
export function surfaceKey(req: SurfaceRequest): string {
  const name = surfaceName(req.texture ?? req.material);
  const tile = tileMetres(name, req.tileScale);
  const ox = req.offsetX ?? 0;
  const oy = req.offsetY ?? 0;
  // A named emission map is worn whether or not a colour was authored, so it
  // counts as emission for the purpose of the multiplier below.
  const glowMap = emissiveMapName(req.emissiveTexture);
  const emissive = req.emissive ?? "";
  // A multiplier on no emission is not a difference: it multiplies black.
  const emits = emissive !== "" || glowMap !== "" || surfaceEmits(name);
  const emissiveIntensity = emits ? (req.emissiveIntensity ?? 1) : 1;
  return `${name}|${tile}|${ox}|${oy}|${req.color ?? ""}|${emissive}|${emissiveIntensity}|${glowMap}`;
}

// Does this surface glow of its own accord - is there an emission map in the
// set? A shape wearing one is a lamp whether or not the level said so, which is
// what both the material (its emissive must be non-black for the map to show)
// and the light it throws (`EmissiveRig`) have to know.
//
// Generated surfaces never emit: they are noise standing in for stuff, and stuff
// does not glow.
export function surfaceEmits(name: string | undefined): boolean {
  return TEXTURE_ASSETS[surfaceName(name)]?.maps.emissive !== undefined;
}

// A named emission map resolved to the set it is in, or "" for none. Unlike
// `surfaceName` this does NOT fall back to a default surface: an emission map is
// something a shape asked for by name, so a key this build does not have leaves
// the shape unmapped rather than glowing in whatever the fallback happens to
// carry. Every set is checked for the map itself, so naming one that has none is
// the same as naming nothing.
export function emissiveMapName(name: string | undefined): string {
  if (!name) return "";
  return TEXTURE_ASSETS[name]?.maps.emissive !== undefined ? name : "";
}

// Every set that HAS an emission map, which is what an emission-map picker can
// offer. Sorted, so the editor's list is stable between builds.
export function emissiveMapNames(): string[] {
  return Object.keys(TEXTURE_ASSETS)
    .filter((k) => TEXTURE_ASSETS[k]!.maps.emissive !== undefined)
    .sort();
}

export function surfaceFor(req: SurfaceRequest): THREE.MeshStandardMaterial {
  const name = surfaceName(req.texture ?? req.material);
  const tile = tileMetres(name, req.tileScale);
  const ox = req.offsetX ?? 0;
  const oy = req.offsetY ?? 0;
  const emissive = req.emissive ?? "";
  const emissiveIntensity = req.emissiveIntensity ?? 1;
  const glowMap = emissiveMapName(req.emissiveTexture);
  const key = surfaceKey(req);
  const cached = materialCache.get(key);
  if (cached) return cached;
  const authored = TEXTURE_ASSETS[name];
  // An authored set is drawn in its fallback surface until its images arrive.
  // The material is the same object throughout - the maps are swapped into it -
  // so nothing that has already been handed this material has to be told.
  const mat = buildSurface(authored ? (authored.fallback ?? DEFAULT_TEXTURE) : name, tile, ox, oy);
  if (req.color) mat.color = new THREE.Color(req.color);
  // A shape's own emissive colour, or - where the emission comes from a MAP and
  // the level named no colour - white, so the map is emitted in the colours it
  // was painted in. Three.js multiplies the two, so leaving the default black
  // here is an emission map that renders as nothing at all, which looks exactly
  // like the map having failed to load.
  if (emissive || glowMap || surfaceEmits(name)) {
    mat.emissive = new THREE.Color(emissive || "#ffffff");
    mat.emissiveIntensity = emissiveIntensity;
  }
  if (authored) void track(dressWithImages(mat, name, authored, tile, ox, oy), `surface "${name}"`);
  // Where the emission map comes from: the one this shape named, or its own
  // surface's. Tiled by the capture size of the set it is IN at this shape's
  // scale, since a borrowed map is a different picture from the one under it and
  // life size has to mean the same thing for both.
  const glowFrom = glowMap || (surfaceEmits(name) ? surfaceName(name) : "");
  if (glowFrom) {
    void track(
      dressEmissive(mat, glowFrom, TEXTURE_ASSETS[glowFrom]!, tileMetres(glowFrom, req.tileScale), ox, oy),
      `emission map "${glowFrom}"`,
    );
  }
  materialCache.set(key, mat);
  return mat;
}

// ---------------------------------------------------------------------------
// Loading the authored maps
// ---------------------------------------------------------------------------

// Everything still in flight, props and texture maps alike.
//
// The game never waits on this - an asset arriving late is the whole design, and
// the fallback surface (or the placeholder box) is what is drawn until it does.
// A HEADLESS GRAB is the one caller that must: `shot.html` renders one frame and
// declares itself done, so without a settle point it photographs whatever had
// loaded by then. That is not a slow screenshot, it is a screenshot that is not
// reproducible - the same command can produce a generated surface one run and an
// authored one the next, which makes it useless as evidence of either.
// Each load is kept under a NAME, because "the grab is still waiting" is not a
// usable report: a load that never settles hangs the page for ever and the
// screenshot harness had nothing to print but a blank picture. Named, the
// watchdog in `shotMain` can say which asset it is waiting on.
const pending = new Map<Promise<unknown>, string>();

function track<T>(p: Promise<T>, what: string): Promise<T> {
  pending.set(p, what);
  void p.finally(() => pending.delete(p));
  return p;
}

// For loads that live outside this module (the water flipbook) but must still
// hold up a headless grab: same set, same settle point.
export function trackPending<T>(p: Promise<T>, what: string): Promise<T> {
  return track(p, what);
}

// What is still in flight, for a harness reporting a hang.
export function pendingAssets(): string[] {
  return [...pending.values()];
}

// Resolves when nothing is in flight. Loops rather than awaiting once, because
// one load starts another: a prop's own textures are fetched by the GLTF loader
// while the mesh promise is still settling.
export async function assetsSettled(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending.keys()]);
  }
}

// One decoded set of images per manifest key, however many tiling scales and
// tints ask for it: an image is uploaded to the GPU once and a `Texture.clone`
// shares that upload while carrying its own `repeat`.
const imageCache = new Map<string, Promise<LoadedMaps>>();
type Slot = "base" | "normal" | "roughness" | "metallic" | "ao" | "emissive";
type LoadedMaps = Partial<Record<Slot, THREE.Texture>>;

let textureLoader: THREE.TextureLoader | null = null;

function loadMaps(name: string, asset: TextureAsset): Promise<LoadedMaps> {
  const cached = imageCache.get(name);
  if (cached) return cached;
  textureLoader ??= new THREE.TextureLoader();
  const loader = textureLoader;
  const slots: Array<[Slot, TextureMap | undefined]> = [
    ["base", asset.maps.base],
    ["normal", asset.maps.normal],
    ["roughness", asset.maps.roughness],
    ["metallic", asset.maps.metallic],
    ["ao", asset.maps.ao],
    ["emissive", asset.maps.emissive],
  ];
  const p = Promise.all(
    slots.map(async ([slot, map]): Promise<[Slot, THREE.Texture | null]> => {
      if (!map) return [slot, null];
      try {
        const tex = await loader.loadAsync(map.file);
        // The albedo and the emission are COLOUR; the rest are data and must
        // stay linear, or a roughness of 0.5 is read as 0.21 and every authored
        // surface comes out shinier than it was painted.
        tex.colorSpace =
          slot === "base" || slot === "emissive" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 4;
        return [slot, tex];
      } catch (err: unknown) {
        // One missing map is not a missing surface: the rest of the set still
        // dresses the material and the generated fallback covers this slot.
        console.warn(`[render3d] texture "${name}" map ${slot} failed to load:`, err);
        return [slot, null];
      }
    }),
  ).then((entries) => {
    const out: LoadedMaps = {};
    for (const [slot, tex] of entries) if (tex) out[slot] = tex;
    return out;
  });
  imageCache.set(name, track(p, `texture images "${name}"`));
  return p;
}

// Wear ANOTHER set's emission map over this material - `VisualData.emissiveTexture`,
// which is how a brick wall gets lit windows without the brick being a different
// surface. Only the one slot is taken; everything else the borrowed set carries
// is left where it is.
async function dressEmissive(
  mat: THREE.MeshStandardMaterial,
  name: string,
  asset: TextureAsset,
  tile: number,
  ox: number,
  oy: number,
): Promise<void> {
  const maps = await loadMaps(name, asset);
  const tex = maps.emissive;
  if (!tex) return;
  const clone = tex.clone();
  applyTiling(clone, tile, ox, oy);
  clone.needsUpdate = true;
  mat.emissiveMap = clone;
  mat.needsUpdate = true;
}

// Swap an authored set's maps into a material already in the scene, at this
// material's own tiling scale.
async function dressWithImages(
  mat: THREE.MeshStandardMaterial,
  name: string,
  asset: TextureAsset,
  tile: number,
  ox: number,
  oy: number,
): Promise<void> {
  const maps = await loadMaps(name, asset);
  const at = (slot: Slot): THREE.Texture | null => {
    const tex = maps[slot];
    if (!tex) return null;
    const clone = tex.clone();
    applyTiling(clone, tile, ox, oy);
    clone.needsUpdate = true;
    return clone;
  };
  // Each map REPLACES the generated one rather than joining it: a set that
  // authors an albedo and a normal keeps the generated roughness, which is a
  // sensible surface, and a set that authors all five owes nothing to the noise.
  const base = at("base");
  const normal = at("normal");
  const roughness = at("roughness");
  const metallic = at("metallic");
  const ao = at("ao");
  if (base) mat.map = base;
  if (normal) mat.normalMap = normal;
  if (roughness) mat.roughnessMap = roughness;
  if (metallic) mat.metalnessMap = metallic;
  // The emission slot is deliberately NOT dressed here: which set it comes from
  // is a separate question (a shape may borrow another set's, see
  // `VisualData.emissiveTexture`), and two async paths writing one slot is a
  // race whose winner is whichever image happened to arrive first.
  // With a map present these are multipliers; with none, they are the value.
  // Metalness defaults to 0 rather than 1 because a set with no metallic map is
  // a dielectric - stone, wood, plaster - and a fully metal wall lit by one sun
  // reads as black.
  mat.roughness = asset.roughness ?? (roughness ? 1 : 0.8);
  mat.metalness = asset.metalness ?? (metallic ? 1 : 0);
  const scale = asset.normalScale ?? 1;
  mat.normalScale.set(scale, scale);
  mat.aoMapIntensity = asset.aoIntensity ?? 1;
  mat.needsUpdate = true;
}

// Which named surface a key resolves to, and at what scale it is meant to be
// seen. ONE namespace, looked up authored-first: a level names a surface, and
// whether that surface is a downloaded set of maps or a few hundred bytes of
// generated noise is an answer this module gives rather than a distinction the
// level has to carry. Replacing a generated surface with an authored one is
// therefore adding a manifest entry under the material's own name, and every
// level already naming that material picks it up.
//
// Both answer for an unknown name the way `materialDensity` does for an unknown
// material: a hand-edited level naming a texture this build does not have should
// look ordinary rather than invisible.
// Exported because it is the whole of the resolution rule and it is PURE - no
// canvas, no GPU, no level - which is what lets `cli render3d` assert it (that
// suite deliberately touches none of those).
export function surfaceName(name: string | undefined): string {
  if (name !== undefined && name in TEXTURE_ASSETS) return name;
  return textureSetName(name);
}

// Metres per repeat: the texture's own captured size, scaled by what the shape
// asked for. One multiply in one place, so "life size" stays a property of the
// texture rather than a number every level has to know - and the editor's
// readout, the material built for the GPU and `cli render3d` all get it from
// here rather than each doing the arithmetic.
export function tileMetres(name: string, tileScale?: number | null): number {
  return surfaceTile(name) * (tileScale ?? 1);
}

// Is this surface a set of authored photographs rather than generated noise?
// The tint rule below turns on it (see `surfaceOf`).
export function isAuthoredSurface(name: string): boolean {
  return name in TEXTURE_ASSETS;
}

export function surfaceTile(name: string): number {
  const authored = TEXTURE_ASSETS[name];
  if (authored) return authored.tile;
  return TEXTURE_SETS[name as MaterialName].tile;
}

// The generated maps for one surface, built once however many tiling scales and
// tints a level asks it for: generating a 256² value-noise field three times
// over is the one part of this that is not free, and a clone shares the uploaded
// image while carrying its own `repeat`.
const mapsCache = new Map<string, ReturnType<typeof buildMaps>>();

// How a world-space shift becomes a UV offset, for one texture at one tiling
// scale. Three samples at `uv * repeat + offset`, and the extruder's UVs are
// metres with the y axis NEGATED into three's frame (extrude.ts) - so moving the
// pattern +x in the level means sampling further back along u, while moving it
// +y (down the screen) means sampling further along v. The asymmetry is that one
// negation and nothing else.
function applyTiling(tex: THREE.Texture, tile: number, ox: number, oy: number): void {
  tex.repeat.set(1 / tile, 1 / tile);
  tex.offset.set(-ox / tile, oy / tile);
}

function buildSurface(
  name: string,
  tile: number,
  ox: number,
  oy: number,
): THREE.MeshStandardMaterial {
  const set = TEXTURE_SETS[name as MaterialName];
  let maps = mapsCache.get(name);
  if (!maps) {
    maps = buildMaps(set);
    mapsCache.set(name, maps);
  }
  maps = {
    map: maps.map.clone(),
    normalMap: maps.normalMap.clone(),
    roughnessMap: maps.roughnessMap.clone(),
  };
  for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) applyTiling(t, tile, ox, oy);
  return new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness: 1, // the map is the roughness; this is its multiplier
    metalness: set.metalness,
    normalScale: new THREE.Vector2(1, 1),
  });
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
  // The `--simplify` ratio this prop was decimated at, absent if its geometry
  // was left alone (which is the default - see scripts/optimize-asset.ts).
  //
  // Recorded because it is the one thing about the shipped bytes that cannot be
  // recovered from them: a decimated prop and a prop somebody modelled at that
  // density are the same file, so without this the raw in `assets-src/` cannot
  // be re-optimised into the same asset, and the next person to run the pipeline
  // over it silently ships the full-density mesh again. It is also the argument
  // for the decimation, in the one place somebody weighing it up will look.
  simplify?: number;
  // Whether the pipeline was asked to re-origin this prop on its own bounds
  // (`assets:optimize --center`), absent if the file's own origin was kept -
  // which is the default, since a pivot at a cage's base or two thirds of the
  // way up a doorway is information about the prop and `mountVisual` places it
  // by that point.
  //
  // It is here for the same reason `simplify` is: a centred prop and a prop
  // modelled about its own centre are the same file, so this is the one fact
  // about the shipped bytes that cannot be recovered from them, and without it
  // the raw in `assets-src/` cannot be re-optimised into the same asset.
  center?: boolean;
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
// holds the whole directory to a byte budget; see "The asset store" in CLAUDE.md.
export const MESH_ASSETS: Record<string, MeshAsset> = {
  // A wall-mounted bulkhead lamp. Its material ships an EMISSION MAP, so the
  // glass reads as lit on its own (via `wakeEmission` - the export carries no
  // emissive factor, and glTF's default is black). What it does not do is light
  // the wall: that comes from the shape it is mounted on carrying
  // `VisualData.emissive`, which is where a light's colour and reach are
  // authored. 25 x 14 x 9 cm as exported, a real bulkhead lamp's size, so it
  // wears no `scale`.
  "bulkhead-lamp": {
    file: "/meshes/bulkhead-lamp.glb",
    sha256: "1d9f7e121da014f7bdd06e7f4d67bd411f12f498dbc622a22ceb5106de7836f7",
    // CC BY, so the author is an obligation rather than a note: the credit has
    // to name the person, and a link to where it was found is not that (see
    // "Provenance, in the manifest" in CLAUDE.md).
    source: "https://sketchfab.com/3d-models/bulkhead-lamp-game-ready-c7ecba33758a46c78537c1c9e6161aeb",
    author: "andersonmat",
    license: "CC BY 4.0",
  },
  // A barred cage, the kind a sewer level hangs over a drop. 1.18 x 2.0 x
  // 1.18 m as exported, a real cage's size, so it wears no `scale`, and it
  // stands upright about its own y with nothing to face, so it wears no
  // rotation either - the two pipes need one because a pipe has a direction and
  // a cage does not.
  //
  // Its materials are doubleSided, and here that is the whole prop rather than a
  // detail left as exported: every bar is seen from both sides at once and the
  // far side of the cage is back-facing from every angle, so single-sided it is
  // a half a cage.
  //
  // `simplify` because it was MEASURED, and the obvious argument against it was
  // wrong. A cage is see-through, so unlike a wall panel its silhouette is not
  // one outline but forty - every bar is its own edge against the background,
  // and no normal map recovers a bar that decimation ate. That reasoning is
  // sound and it is about the wrong meshes: 59% of the 28,920 triangles are
  // EIGHT meshes at 2,118 each, the wooden posts, whose relief is in the normal
  // map exactly as the sewer wall's is. The bars are the 128-triangle meshes,
  // and the simplifier's 1% error budget stops early on them rather than
  // thinning them, so they come through every ratio intact.
  //
  // 0.3 rather than the wall's 0.1: measured at 1.27% / 1.81% / 4.16% RMSE over
  // the prop's own pixels at 0.5 / 0.3 / 0.1, the first two are
  // indistinguishable and the third visibly facets the posts. (Over the prop's
  // crop, so it is a stricter number than the wall's 1.5% whole-frame one.)
  //
  // The bytes are NOT what this buys: the file is texture, and the whole
  // decimation is worth 124 KB of 567. What it buys is the draw, on a prop a
  // level will stand several of behind a nearly orthographic camera - which is
  // the sewer set's lesson and the reason to check a count against what a prop
  // is for. Its 12.53 MB raw was a 2048² normal PNG at 5.66 MB, a 2048²
  // occlusion/metallic-roughness PNG at 4.67 MB and a 2048² JPEG albedo, which
  // the pipeline's 1k WebP ceiling takes to 443 KB.
  cage: {
    file: "/meshes/cage.glb",
    sha256: "a74b6e26e6de89963b542dce1395509d9519fe1ab83a0dc1b91d6f7814ebc6ee",
    simplify: 0.3, // 28,920 -> 8,675 triangles
    source: "https://sketchfab.com/3d-models/cage-7f86e8c4f839424fab8a6d43cdf2b4fc",
    author: "AAA (@BitoRaccoon)",
    license: "CC BY 4.0",
  },
  // A square barred cage standing on a stone plinth - the dungeon's own cage,
  // where `cage` is the hanging one. Both of these two are by the same author
  // and are credited separately for the same reason the sewer pair is: the
  // manifest is per ENTRY, and these are two files rather than two maps of one
  // surface.
  //
  // It is the one prop here that is NOT authored in metres, which is what
  // `scale` is for: as exported it is 2.28 x 5.70 x 2.28 m, a cage three times
  // the height of a person and wide enough to park in. 0.4 puts it at 0.91 x
  // 2.28 x 0.91 - a cage somebody stands up in, its plinth included - which is
  // the size the other two cages already are and the size the sewer set is
  // built around. Stating it here rather than in `visual.scale` is the point of
  // the field: every level that places one gets the same cage.
  //
  // ITS PIVOT IS ITS BASE (min y is 0 as exported), and `mountVisual` does not
  // recentre a prop - the file's origin is where the geometry object's position
  // lands. So this one is placed by the point it STANDS on, while `cage`, which
  // was exported centred on its own origin, is placed by its middle. Worth
  // knowing before assuming a cage is half a metre out.
  //
  // No `simplify`: 1,817 triangles across the cage, the plinth and the cap ring
  // is already a background prop's worth, and every byte of the 2.36 MB raw was
  // texture - two 1024² PNGs, which the pipeline's WebP re-encode takes to
  // 233 KB without touching a pixel of resolution. Its materials are
  // doubleSided as exported, which is what a see-through prop wants: every bar
  // is seen from both sides at once and the far side of the cage is back-facing
  // from every angle.
  "cage-dungeon": {
    file: "/meshes/cage-dungeon.glb",
    sha256: "8632afc6dada82dcdc32380174c917736cd0b1a0fbf55ea8ca5bea2d1da9e68f",
    scale: 0.4, // 2.28 x 5.70 x 2.28 m as exported -> 0.91 x 2.28 x 0.91
    source: "https://sketchfab.com/3d-models/dungeon-cage-34dcb15847ef439eb9f0c991ae1078f8",
    author: "Samuel F. Angrick-Johanns (@oneironauticus)",
    license: "CC BY 4.0",
  },
  // A round, very rusty one-person cage. 1.01 x 2.00 x 1.01 m as exported, a
  // real cage's size, so it wears no `scale`; base-pivoted like `cage-dungeon`
  // above, and doubleSided for the same reason. It stands upright about its own
  // y and is a body of revolution, so there is nothing for a rotation to face.
  //
  // No `simplify`, and unlike `cage` that is not a measurement - it is the
  // shape of the prop. 6,704 triangles is one see-through mesh of bars and
  // hoops with no solid post anywhere in it, so there is no relief a normal map
  // is already carrying and nothing for a simplifier to take that is not an
  // edge against the background. `cage`'s decimation paid off because 59% of
  // its triangles were eight wooden posts; there is no equivalent here, and the
  // 2.24 MB raw was again all texture (a 1k JPEG albedo and a 1k PNG
  // occlusion/metallic-roughness, 259 KB as WebP).
  "cage-rusty": {
    file: "/meshes/cage-rusty.glb",
    sha256: "0ebbe7a821d0910a7d28c1368eccc3eff3c1ce93f699ecff8b9c8ecc687b6a79",
    source: "https://sketchfab.com/3d-models/rusty-dungeon-cage-3e404a7e3fec4340b52519942ff229e0",
    author: "Samuel F. Angrick-Johanns (@oneironauticus)",
    license: "CC BY 4.0",
  },
  // A concrete drainage pipe, the kind stacked on a construction site. 63 cm
  // across and 2 m long as exported, a real culvert section's size, so it wears
  // no `scale`, and the same `rotY` as `pipe-long` for the same reason: it is
  // extruded along its own z, so untouched it points its bore at the camera.
  //
  // Its material is doubleSided, which is what a pipe you can see through wants
  // - the far inside wall is back-facing from every angle - and is left as
  // exported rather than normalised away.
  //
  // No `simplify`: 768 triangles is a cylinder's worth already, and the file's
  // 1.04 MB was texture - a 1k JPEG albedo and two 1k PNGs, which the pipeline
  // takes to 86 KB by re-encoding rather than by resizing.
  "pipe-concrete": {
    file: "/meshes/pipe-concrete.glb",
    sha256: "6b5eed66d54fc1f39660cb07b0e35e78f4450cffba67352d6634f16a76cea158",
    rotY: Math.PI / 2,
    source: "https://sketchfab.com/3d-models/concrete-pipe-game-ready-92d1cbc20e8c440aad9be60586d5efa6",
    author: "PT34",
    license: "CC BY 4.0",
  },
  // A length of large-bore metal pipe - the kind that runs along a sewer wall.
  // 48 cm across and 1.23 m long as exported, a real pipe's size, so it wears
  // no `scale`.
  //
  // It DOES wear a `rotY`, which is what that field is for: the model is
  // extruded along its own z, so head on it draws as a 48 cm disc with 1.23 m
  // of pipe hidden behind it, pointing at the camera. A quarter turn about y
  // lays it along x, running across the level, which is the orientation a
  // length of pipe is placed in. A level turns it further with the geometry
  // object's own `rotX`/`rotY` (which compose over this one) - so a pipe end
  // poking out of a wall is still one field away.
  //
  // No `simplify`: at 2,058 triangles the geometry is already a background
  // prop's worth, and everything this file weighed was texture - three 2048²
  // PNGs, 15.43 MB, which the pipeline's 1k WebP ceiling takes to 397 KB.
  "pipe-long": {
    file: "/meshes/pipe-long.glb",
    sha256: "42bb6ae3b07fda693df314a9215d2859210d52f5885421ea00f11a10a1bedd21",
    rotY: Math.PI / 2,
    source: "https://sketchfab.com/3d-models/pipe-metalic-metal-14mb-48182e0a4c7943f596dced21a167379b",
    author: "Mehdi Shahsavan (@ahmagh2e)",
    license: "CC BY 4.0",
  },
  // Two pieces of the same sewer brick set, credited once each because the
  // manifest is per ENTRY and these are two files rather than two maps of one
  // surface. Both are authored in real-world metres - the arch is 3.0 x 1.9 x
  // 1.9 m (`Sewer_Walls_Arch_02`), the wall a 3.0 x 3.0 m panel half a metre
  // thick (`Sewer_Walls_01`) - so neither wears a `scale`.
  //
  // BOTH ARE DECIMATED, and this set is why `--simplify` exists at all. It is a
  // UE5 **Nanite** set, which is to say it is authored for a renderer that
  // streams its own level of detail: the wall panel shipped 134,041 triangles
  // and the arch 57,885. This one has no LOD whatever, and the ball arena stands
  // four of each two metres behind a gameplay plane it views almost
  // orthographically - 768k triangles of background scenery, 95% of the whole
  // scene, which the water's transmission pass then draws a SECOND time on every
  // frame it is visible (see "Water" in CLAUDE.md).
  //
  // A tenth of the triangles costs 1.5% RMSE on that frame, because the brick
  // relief that reads on screen is in the normal map rather than in the mesh -
  // the geometry was buying self-shadowing at grazing angles and very little
  // else. Decimating is what a Nanite asset needs to enter a renderer without
  // one, not a corner cut.
  "sewer-arch": {
    file: "/meshes/sewer-arch.glb",
    sha256: "db582f170e41f459690e3bc9cfb41c44b88b7b47c01ac85ae6a66b59fa92b980",
    simplify: 0.1, // 57,885 -> 5,787 triangles
    source:
      "https://sketchfab.com/3d-models/sewer-brick-walls-set-midpoly-ue5-nanite-27143020c0bb4624aaf4f5257fd603bd",
    author: "MightyPinecone",
    license: "CC BY 4.0",
  },
  "sewer-wall": {
    file: "/meshes/sewer-wall.glb",
    sha256: "d1e9d88eee42649cf9ac306766363c3e0dcb435350447593c1ce94013f1122d5",
    simplify: 0.1, // 134,041 -> 13,404 triangles
    source:
      "https://sketchfab.com/3d-models/sewer-brick-walls-set-midpoly-ue5-nanite-27143020c0bb4624aaf4f5257fd603bd",
    author: "MightyPinecone",
    license: "CC BY 4.0",
  },
  // An arched stone doorway, from the SAME author's second sewer set - a
  // separate model page, so a separate credit. 3.04 x 3.03 m and 47 cm thick as
  // exported, real-world metres, so it wears no `scale`. Nor a rotation: it is
  // a flat panel already standing in the xy plane with its face towards the
  // camera, which is the plane a level is authored in (the pipes need a `rotY`
  // because they are extruded along their own z; a doorway is not).
  //
  // Its origin is neither the base nor the centre - the panel runs from -1.78 to
  // +1.25 in y - so it is placed by a point about two thirds of the way up the
  // opening. `mountVisual` does not recentre a prop, so that is the point the
  // geometry object's position puts on the level.
  //
  // DECIMATED, this being Nanite geometry again (see `sewer-arch`), but at 0.3
  // rather than 0.1 and that ratio was measured rather than inherited: 1.28% /
  // 1.98% / 3.74% RMSE at 0.5 / 0.3 / 0.1, over a frame the prop FILLS, which is
  // a stricter test than the wall's whole-frame number. At 0.1 the stones stop
  // reading as stones - unlike the wall panel, whose brick relief lives in its
  // normal map, this one's per-brick rounding is in the MESH, so the simplifier
  // flattens each face and the picture turns smooth and glassy. 0.3 is
  // indistinguishable from the full 56,286 triangles and keeps a third of them.
  //
  // Its 57.51 MB raw was texture, and mostly one file: a 4096² normal PNG at
  // 34.58 MB plus a 4096² occlusion/metallic-roughness PNG at 20.12 MB, which
  // the pipeline's 1k WebP ceiling takes to 769 KB all in.
  "sewer-doorway": {
    file: "/meshes/sewer-doorway.glb",
    sha256: "437af23c1dfa0ba50133843e44def247d0b9294b27dc298ee9e1213a2d292484",
    simplify: 0.3, // 56,286 -> 16,884 triangles
    source:
      "https://sketchfab.com/3d-models/sewer-brick-walls-set-2-midpoly-ue5-nanite-5a5ae221432444f898336627dc192567",
    author: "MightyPinecone",
    license: "CC BY 4.0",
  },
  // A carry lantern - a metal cage around glass panes, a knob on the lid and a
  // wide flat carry hoop standing up over it. 3,782 triangles (32 of them the
  // glass, its own alpha-BLEND material), so no `simplify`; the 2.5 MB raw was
  // three 1024² PNGs, 265 KB as WebP.
  //
  // It IS scaled, and by eye: the export is 0.90 x 2.51 x 0.87 m - a Sketchfab
  // FBX with a x100 baked into its mesh node, and no captured size stated at
  // any unit. 0.2 puts the whole thing at 50 cm with the hoop, an 18 cm
  // footprint and a 34 cm body, which is a real hand lantern's size (the
  // bulkhead lamp is 25 cm for comparison).
  //
  // No rotation: its height is already world y and the hoop's plane faces the
  // camera. Its origin is INSIDE the upper body (the export runs -0.87 to
  // +1.65 of its 2.51 about it), so it is placed by a point near where the
  // hoop meets the lid rather than by its base - about right for hanging one
  // from a hook, which is what a lantern in a level mostly does.
  //
  // NO EMISSION MAP: the materials are albedo/normal/roughness only, so the
  // flame is authored as a light object in the same body (see "Light and
  // air"), and there is no `wakeEmission` case to trip over.
  lantern: {
    file: "/meshes/lantern.glb",
    sha256: "251bb6dc9d0cf480b950802237c7826f21fba690d41f2f0fc40d74689e559de7",
    scale: 0.2, // 0.90 x 2.51 x 0.87 m as exported -> 0.18 x 0.50 x 0.17
    source: "https://sketchfab.com/3d-models/lantern-f0b0ea89f20b4f10bb583c449ae04d9c",
    author: "Mandrake (@mandrake_3d)",
    license: "CC BY 4.0",
  },
  // A barred iron gate with a hinged door - dungeon bars, the kind that close
  // off a corridor. Two meshes as exported (the frame of bars and the door
  // leaf), 3,564 triangles between them, so no `simplify`: like `cage-rusty`
  // it is all see-through bars whose every edge is silhouette, and the 8.3 MB
  // raw was texture (2048² PNGs, which the pipeline's 1k WebP ceiling takes to
  // 570 KB).
  //
  // It is modelled lying ALONG ITS OWN Z - head on it draws as a 4 cm sliver
  // with 2.4 m of gate pointing at the camera - so it wears the same `rotY`
  // the pipes do, laying it across the level. 2.40 m wide and 1.57 m tall as
  // exported, a real gate's size, so it wears no `scale`.
  //
  // Base-pivoted in y (min y is 0) like `cage-dungeon`, so it is placed by the
  // point it STANDS on - and off-centre along its width (its span runs -1.69
  // to +0.70 about the origin, the pivot sitting at the door's hinge side), so
  // the placement point is near one end rather than the middle. Its materials
  // are doubleSided as exported, which see-through bars want: the far side of
  // the gate is back-facing from every angle.
  "iron-gate": {
    file: "/meshes/iron-gate.glb",
    sha256: "03a875919280ec49f84a592b25f1179c8e1f08826e2adc114eb22b57102d02ed",
    rotY: Math.PI / 2,
    source: "https://sketchfab.com/3d-models/dungeonprison-bars-door-410e6acfc4c448d3835929e1b6d6df3a",
    author: "Yukitsu-Senpai",
    license: "CC BY 4.0",
  },
  // A flat panel of vertical prison bars in a frame - a barred window or gate
  // set into a wall, where `iron-gate` is a door that swings. 2.00 x 2.50 m and
  // 11 cm thick as exported, a real gate's size, so it wears no `scale`; nor a
  // rotation, being a flat panel already standing in the xy plane with its face
  // to the camera, which is the plane a level is authored in.
  //
  // CENTRED, and it is the prop this flag was added for. As downloaded its
  // geometry sat at x 2.89..4.89, y 6.75..9.25 - the world coordinates of
  // wherever it stood in the level it was exported from, so its origin was 8.9 m
  // of empty space away from the bars themselves. `mountVisual` does not
  // recentre a prop, so placed by that origin it would draw most of a room away
  // from where it was put, which reads as the prop having failed to load rather
  // than as a pivot.
  //
  // No `simplify`: 1,068 triangles is a background prop's worth already, and a
  // barred panel is the shape decimation has least to take - every bar is its
  // own edge against the background, and there is no solid post whose relief a
  // normal map is carrying (which is what `cage`'s ratio was measured against).
  // Its 1.22 MB raw was one 1024² PNG albedo, 115 KB as WebP, and its material
  // is doubleSided as exported - what a see-through panel wants, the far side of
  // every bar being back-facing.
  //
  // NO NORMAL, ROUGHNESS OR METALLIC MAP: albedo alone, so the bars take their
  // shading from the geometry and read flatter under a lamp than the sewer set
  // does. A `texture` on the geometry object is the lever if that matters at the
  // depth one is placed at.
  "metal-bars": {
    file: "/meshes/metal-bars.glb",
    sha256: "c8295b057cb082a3bbc325d3f6f9c52744cf758d4e931cc934b2d2d7ad8687ef",
    center: true, // exported at its level coordinates, 8.9 m off its own geometry
    // CC BY, so the credit names the person rather than the page (see
    // "Provenance, in the manifest" in CLAUDE.md). Noted with the entry because
    // the file is opaque and this is the one place the question gets asked: the
    // model is ripped from Poppy Playtime (MOB Games - the mesh is named
    // `SM_BarsGate_Level5_A`), so the uploader's CC BY is not theirs to grant,
    // and the store's own rule about what may be redistributed does not really
    // cover it. Kept deliberately; it is the entry to delete first if the
    // release is ever audited.
    source:
      "https://sketchfab.com/3d-models/poppy-playtime-4-prison-door-bars-5dc2f7af7ec144afb2443fe86c74c288",
    author: "FuzerGamesTV",
    license: "CC BY 4.0",
  },
  yellow_barrel: {
    file: "/meshes/yellow_barrel.glb",
    sha256: "90038a5e6bedf98d2c791669c81bdaeb5ee3b29814ece05ad51024f5a4296597",
    source:
      "https://sketchfab.com/3d-models/low-poly-closed-barrels-8df46c47099a4b9d9bc4a69edcad1b88",
    author: "Anna Denisova (@Den1121)",
    license: "CC BY 4.0",
  },
};

// ---------------------------------------------------------------------------
// Raw maps
// ---------------------------------------------------------------------------

// A stored file that is neither a prop nor a slot of a PBR surface set: the
// water renderer's animation flipbook and its baked foam mask (see
// `render3d/water.ts`, which is their only consumer). They get a manifest of
// their own rather than a slot in `TEXTURE_ASSETS` because that manifest is
// also the `surfaceFor` namespace - an entry there is a surface a level can
// name and a wall can wear, and a 10x6 flipbook atlas worn as brick would be
// a nameable mistake. Same store, same fetch, same budget, same provenance
// rules; only the namespace differs.
export interface RawAsset {
  // Path under `public/` - `/water/...`, gitignored and populated by
  // `bun run assets:fetch` like every other stored file.
  file: string;
  sha256: string;
  // As on `MeshAsset`, and required for the same reasons.
  source: string;
  author: string;
  license: string;
}

export const RAW_ASSETS: Record<string, RawAsset> = {
  // 60 of the source's 120 frames (every second one), downscaled 1024 -> 256
  // and packed into a 10x6 atlas by `magick montage` (see the note in
  // water.ts); the original loops at 30 fps, so the shipped layers play at 15
  // with a crossfade. Lossless, because normals are data (same argument as
  // optimize-texture's scalar maps).
  "water-normal-flip": {
    file: "/water/water-normal-flip.webp",
    sha256: "ca1c14cfa3cf1d2afb946668315630411a3a5ab2a55e48781f5594619bc5aef9",
    source:
      "https://textures.pixel-furnace.com (Animated Water Normal Map; via https://blenderartists.org/t/animated-water-normal-map-tileable-looped/673140)",
    author: "Cebbi (Pixel-Furnace)",
    license: "Pixel-Furnace free licence (CC0-like: commercial use allowed, credit appreciated but not required)",
  },
  // Generated in-repo by `scripts/bake-foam.ts` (deterministic - the same
  // script is the same picture). Stored anyway so a fresh clone is dressed by
  // the fetch alone; re-bake and re-publish together.
  "water-foam": {
    file: "/water/water-foam.webp",
    sha256: "da1b8900131770f284ea3ab55977cd98ab65728709d7ca0133d1da37bb927f9f",
    source: "scripts/bake-foam.ts (generated in this repository)",
    author: "Tristan Bray",
    license: "CC0",
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

// A prop that ships an emission MAP but no emissive FACTOR emits nothing, and
// this lifts it to white so the map is emitted in the colours it was painted in.
//
// glTF's default `emissiveFactor` is [0,0,0] and three.js multiplies the map by
// it, so a material carrying a beautifully authored emission map renders exactly
// as if the map were not there. It is the single most common way a lamp arrives
// dark, because a modelling tool will happily export the map while the material
// it came from resolves to no emission at all - and the failure looks like the
// texture having failed to load rather than like a value being zero.
//
// The repair is deliberately NARROW: a map, and a factor that is exactly black.
// A prop that authors any emissive colour of its own is left alone, and one with
// no map is untouched, so nothing here can make a surface glow that was not
// already carrying a picture of its own glow. It is the same rule `surfaceFor`
// applies to this project's own texture sets, which is the point - a prop and a
// surface that both ship an emission map should not need different knowledge to
// light up.
//
// Note what this does NOT do: the light a lamp throws comes from the shape's
// `VisualData.emissive` (see `EmissiveRig`), never from a prop's own materials.
// A prop is a picture, and reading a light's colour and reach out of one would
// be guessing at both.
export function wakeEmission(material: THREE.Material | THREE.Material[]): void {
  for (const m of Array.isArray(material) ? material : [material]) {
    const std = m as THREE.MeshStandardMaterial;
    if (!std.emissiveMap || !std.emissive) continue;
    if (std.emissive.r !== 0 || std.emissive.g !== 0 || std.emissive.b !== 0) continue;
    std.emissive.setRGB(1, 1, 1);
    std.needsUpdate = true;
  }
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
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        wakeEmission(mesh.material);
      });
      return root as THREE.Object3D;
    })
    .catch((err: unknown) => {
      console.warn(`[render3d] mesh "${key}" failed to load:`, err);
      return null;
    });
  gltfCache.set(key, track(p, `mesh "${key}"`));
  return p.then((o) => (o ? o.clone(true) : null));
}
