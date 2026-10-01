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
// Type-only, so the loader's module still lands in its own chunk (`gltfLoader`).
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { withDownload } from "./download";
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

// The surface the ball, its manacle and every chain link are made of (see
// `ballVisual`, which wears it, and `levelAssets`, which counts it into a
// level's download). It is named here rather than there because it is a key of
// the manifest above and because both readers have to agree about it: a scene
// with any chain in it loads this set, ball level or not.
export const IRON_SURFACE = "painted steel";

// The avatar's own model (`MESH_ASSETS`, and see `BallVisual`). Named here for
// the same reason the surface above is: the preload list a page starts fetching
// before the app exists has to account for the ball, and the resolver that
// builds it (`levelAssets.ts`) cannot import the avatar's module without
// dragging the sim and three into a build step.
export const BALL_MESH = "iron-ball";
// The radius, in metres, the ball in that model is modelled at (the mean over
// its hammered surface is 99.86 mm). `BallVisual` scales by the ball's own
// radius over this.
export const BALL_MESH_RADIUS = 0.1;

export function textureSetName(name: string | undefined): MaterialName {
  if (name !== undefined && (MATERIAL_NAMES as string[]).includes(name)) return name as MaterialName;
  return DEFAULT_TEXTURE;
}

// The one entry in the surface namespace that is not a surface: a FLAT FILL of
// the geometry object's own `color`, with no pattern, no maps and nothing to
// tile. It is a key rather than a separate `kind` because it answers the same
// question every other key does - what does this wear - so a level swaps a wall
// between brick and a solid block of colour by changing one string, and every
// path that already resolves a surface keeps working.
//
// It is also the one surface the fill colour is worn EXACTLY, rather than as a
// tint lifted to `TINT_FLOOR` over generated noise (see `surfaceOf`): an author
// naming this has said what colour the thing is, and a remap that makes it
// paler is the renderer arguing with them. The whole point of the option is
// that the RGB picked is the RGB drawn.
export const SOLID_SURFACE = "color";

export function isSolidSurface(name: string | undefined): boolean {
  return name === SOLID_SURFACE;
}

// How rough a flat fill is. Matte and non-metallic: the surface carries no
// information of its own, so the only thing shaping it on screen is the form it
// is on, and a shine would read as a material claim this deliberately does not
// make.
const SOLID_ROUGHNESS = 0.8;

// ---------------------------------------------------------------------------
// Authored texture sets
// ---------------------------------------------------------------------------

// One map of an authored PBR set: a file under `public/`, pinned to the bytes
// this revision was written against, exactly as a `MeshAsset` is and for the
// same reasons (see `MeshAsset.file` / `.sha256`).
export interface TextureMap {
  file: string;
  sha256: string;
  // The file's size in bytes, which is what the loading screen's bar is a
  // fraction OF (see render3d/download.ts). It is stated here rather than read
  // off the responses because a denominator that arrives with the download is
  // not a denominator: the browser opens six connections and queues the rest, so
  // the last file's Content-Length lands near the END of the load, and a bar
  // measured against what has answered so far races to 60% and then sits still
  // while the total catches up. Known up front, the bar is simply true.
  //
  // Written by `assets:publish` beside the hash and held to the file on disk by
  // `cli assets`, exactly as `sha256` is - it is the same kind of fact, and one
  // nobody should be typing by hand.
  bytes: number;
  // WHERE THIS MAP CAME FROM: the source image under `assets-src/`, and for a
  // scalar map (roughness, metallic, AO) which of its channels carries the
  // number (default red - Poly Haven's packed ARM is AO in R, roughness in G,
  // metallic in B). With these two and `paint` below, `bun run assets:paint`
  // rebuilds the shipped file from the raw with nothing typed by hand, and
  // that is the whole reason they are here: a map that cannot be re-baked is
  // a map whose recipe is lost the day it needs changing. Absent on the older
  // sets, which predate the record; `assets:paint` names them as such.
  raw?: string;
  channel?: "r" | "g" | "b";
  // How the map was PAINTED on its way through `assets:optimize-texture`: the
  // brush in output pixels, and for an albedo whether its cracks were baked in
  // from the set's own AO map, its saturation and its tint (see "Painted
  // surfaces" in docs/asset-store.md). Recorded for the reason a prop's
  // `simplify` is: a painted map and one painted by hand are the same file, so
  // without this the raw cannot be optimised into the same asset again.
  // Absent = as shot.
  paint?: { brush: number; soften?: number; cavity?: true; saturate?: number; tint?: string };
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
  // BRUSH STROKES over the whole set, laid on after every map is flattened
  // (`scripts/stroke-textures.ts`, run by `assets:paint`): one dab layout the
  // albedo, the normal and the rest all wear, each sampling its own value, so
  // a stroke is one plane of colour, one facet and one sheen. `width` is the
  // stroke in output pixels. A set-level record because the layout is shared,
  // which is what makes the strokes on the three maps the same strokes.
  strokes?: { width: number };
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

// The texture manifest: the photographed or baked surfaces the GAME wears -
// the ball and chain's, and whatever a conveyor band names (`BeltLook.texture`).
// A level's own surfaces are in its Blender scene. Hand-written like the prop
// manifest, and for the same reason: an asset is a decision.
//
// A texture key naming nothing here falls through to the generated surfaces
// (`TEXTURE_SETS`), so an unknown name is an ordinary surface rather than an
// invisible one.
//
// Every entry is `assets:optimize-texture`d, then `assets:publish`ed, and
// `cli assets` holds the whole directory to a byte budget; see
// docs/asset-store.md.
export const TEXTURE_ASSETS: Record<string, TextureAsset> = {
  // The ball and chain's own surface: oil strokes, not a photograph. Baked by
  // `scripts/bake-strokes.ts` into `assets-src/painted-steel/` and then
  // through the ordinary pipeline like any set, so it is reproducible and
  // published like the rest. Tuned to a reference painting of a clean
  // polished steel ball (2026-09-17): a mid-grey ground under soft,
  // low-contrast strokes that turn with the ball, and the scene's own
  // reflection for the shine. See docs/art-style.md.
  "painted steel": {
    maps: {
      base: {
        file: "/textures/painted-steel-base.webp",
        raw: "painted-steel/painted-steel-base.png",
        sha256: "0680b33ddd3e17d5b3dc42e8f26563920e43593c97f8a3d36e77b81dbac258e5",
        bytes: 93760,
      },
      normal: {
        file: "/textures/painted-steel-normal.webp",
        raw: "painted-steel/painted-steel-normal.png",
        sha256: "fa5cdcf7f990abeba8b2a0fe1bb9bb4444a2a7993a59ec9f805a94c8795fb7a1",
        bytes: 1097266,
      },
      roughness: {
        file: "/textures/painted-steel-roughness.webp",
        raw: "painted-steel/painted-steel-roughness.png",
        sha256: "ea86551538e9682c4f8e0855a8a98c9d03f24941dec91fbd4c5d3a2dd3f19f7e",
        bytes: 188044,
      },
    },
    // A stroke is 30-80 px of a 1024 map; at two metres per repeat that is
    // 6-16 cm, a third of the ball, which is the broad stroke the reference
    // paints it with. (Half a metre made them 2 cm, three pixels at play size
    // - grain again.)
    tile: 2,
    // The ridges along the strokes, kept faint: at full strength they were a
    // second grain on top of the strokes.
    normalScale: 0.5,
    // Half the map's roughness (a 0.47 mean, streaky dab by dab), so the
    // links shine: at the map's own value they were a soft matte sheen. Metal
    // enough that the reflection is most of their colour, with a little of
    // the strokes' own mid grey left to carry their value in a dark level - a
    // cave's environment is dark, and a mirror of a dark room is a dark chain.
    //
    // Then matched to the ball model (2026-10-01), which this set exists to
    // sit beside: 0.39 of the map's 0.47 is the ball's worn ~0.18, and 0.62
    // its worn metalness, so the links take the same gloss and the same
    // half-diffuse lobe as the painted iron they hang off.
    roughness: 0.39,
    metalness: 0.62,
    fallback: "steel",
    source: "scripts/bake-strokes.ts",
    author: "generated by this repository",
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

// A PAINTED height field: patches rather than grain. The surface is tiled into
// `cells` x `cells` irregular patches (a jittered lattice, nearest-point cells,
// wrapped so the map tiles), and each patch is one tone with a gentle gradient
// across it - the flat planes of tone a painter lays down, which under the sun
// are facets, each turned a little from its neighbours. A little low-frequency
// drift crosses the patches so the tiling does not read as a grid of chips.
//
// `seam` is returned beside the height, 1 on a boundary and 0 inside a patch, so
// the albedo can darken its seams the way a painting DRAWS the line between two
// facets. The SLOPE the normal map is built from is returned as well, and it is
// NOT the height's finite difference: the height steps at every seam (two
// patches, two levels), and a step differenced is a spike - a bevel under the
// normal map, lit on one side and dark on the other, which makes a surface of
// patches read as paving rather than paint (the first version did this and the
// wood came out as chocolate tiles). The slope is each patch's own tilt, one
// direction per patch, plus the drift's gentle gradient: facets that meet at an
// angle with no rim, which is what a painter's flat planes of tone are under a
// light.
//
// This replaced the fractal value noise `noiseField` alone gave the generated
// surfaces on 2026-09-17, when every surface went painterly (see "Painted
// surfaces" in docs/asset-store.md): noise at four octaves IS grain, and grain
// is exactly what the authored sets are baked to remove.
const SEAM_WIDTH = 0.07; // in cells; how far a seam's darkening reaches
const PATCH_TILT = 0.15; // the tone gradient across a patch, per cell
const PATCH_SLOPE = 0.05; // a patch's tilt as a slope, before the set's relief
export interface PaintField {
  height: Float32Array;
  seam: Float32Array;
  slopeX: Float32Array;
  slopeY: Float32Array;
}
export function paintField(cells: number): PaintField {
  const n = Math.max(2, Math.round(cells));
  const px = new Float32Array(n * n);
  const py = new Float32Array(n * n);
  const level = new Float32Array(n * n);
  const gx = new Float32Array(n * n);
  const gy = new Float32Array(n * n);
  // The same deterministic lattice rule as `noiseField`, for the same reason.
  let seed = 0x7f4a7c15 ^ (n * 2654435761);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < n * n; i++) {
    px[i] = rand();
    py[i] = rand();
    level[i] = rand();
    const a = rand() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const drift = noiseField(Math.max(2, Math.round(n / 2)), 2);
  const driftAt = (x: number, y: number) =>
    drift[((y + MAP_SIZE) % MAP_SIZE) * MAP_SIZE + ((x + MAP_SIZE) % MAP_SIZE)]!;
  const height = new Float32Array(MAP_SIZE * MAP_SIZE);
  const seam = new Float32Array(MAP_SIZE * MAP_SIZE);
  const slopeX = new Float32Array(MAP_SIZE * MAP_SIZE);
  const slopeY = new Float32Array(MAP_SIZE * MAP_SIZE);
  for (let y = 0; y < MAP_SIZE; y++) {
    const fy = (y / MAP_SIZE) * n;
    const cy = Math.floor(fy);
    for (let x = 0; x < MAP_SIZE; x++) {
      const fx = (x / MAP_SIZE) * n;
      const cx = Math.floor(fx);
      let f1 = Infinity;
      let f2 = Infinity;
      let id = 0;
      let dx = 0;
      let dy = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const wx = (((cx + ox) % n) + n) % n;
          const wy = (((cy + oy) % n) + n) % n;
          const j = wy * n + wx;
          const ex = cx + ox + px[j]! - fx;
          const ey = cy + oy + py[j]! - fy;
          const d = Math.hypot(ex, ey);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            id = j;
            dx = ex;
            dy = ey;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
      const i = y * MAP_SIZE + x;
      const t = Math.min(1, (f2 - f1) / SEAM_WIDTH);
      const inside = t * t * (3 - 2 * t);
      seam[i] = 1 - inside;
      // The patch's own level, a gradient across it and the drift: clamped to
      // the unit range the albedo mixes over.
      const tone = level[id]! * 0.25 + (dx * gx[id]! + dy * gy[id]!) * PATCH_TILT + drift[i]! * 0.5;
      height[i] = Math.max(0, Math.min(1, tone));
      slopeX[i] = gx[id]! * PATCH_SLOPE + (driftAt(x + 1, y) - driftAt(x - 1, y)) * 0.5;
      slopeY[i] = gy[id]! * PATCH_SLOPE + (driftAt(x, y + 1) - driftAt(x, y - 1)) * 0.5;
    }
  }
  return { height, seam, slopeX, slopeY };
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
// three agree: a dark patch is also a dip and also a rougher spot, exactly as it
// is on the real material. The field is `paintField`'s: patches with a crease
// between them, so the albedo is flat tones with drawn seams and the normal is
// facets - the same look the authored sets are baked to.
const SEAM_DARKEN = 0.12; // how dark the albedo goes on a seam, 0..1
function buildMaps(set: TextureSet): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
} {
  const { height: h, seam, slopeX, slopeY } = paintField(set.cells);
  const [br, bg, bb] = hexToRgb(set.base);
  const [gr, gg, gb] = hexToRgb(set.grain);
  const map = canvasTexture((d) => {
    for (let i = 0; i < h.length; i++) {
      const t = h[i]!;
      // A seam is a line drawn over the patch, not a shift toward the grain.
      const k = 1 - SEAM_DARKEN * seam[i]!;
      d[i * 4] = (br * (1 - t) + gr * t) * k;
      d[i * 4 + 1] = (bg * (1 - t) + gg * t) * k;
      d[i * 4 + 2] = (bb * (1 - t) + gb * t) * k;
      d[i * 4 + 3] = 255;
    }
  });
  map.colorSpace = THREE.SRGBColorSpace;

  const normalMap = canvasTexture((d) => {
    // The field's own slope (a patch's tilt, not the height differenced - see
    // `paintField`), scaled by how pronounced this surface's relief is.
    const strength = set.relief * 4;
    for (let p = 0; p < h.length; p++) {
      const dx = slopeX[p]! * strength;
      const dy = slopeY[p]! * strength;
      // The slope as a tangent-space normal, renormalised so a flat area is
      // exactly (0,0,1) rather than merely near it.
      const len = Math.hypot(-dx, -dy, 1);
      const i = p * 4;
      d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      d[i + 3] = 255;
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
  // How large to wear it, as a MULTIPLE of the size the texture was authored at
  // (`TextureAsset.tile` / `TextureSet.tile`, both metres). 1 (and absent) is
  // life size, 2 is twice as large. The absolute size stays a fact about the
  // texture and the caller says only how it wants it - see `BeltLook.tileScale`.
  tileScale?: number;
  // The fill colour, already lifted to its brightness floor by the caller.
  // Multiplied against the albedo, so the grain survives the tint rather than
  // being painted over by it.
  color?: string;
  // The avatar's own copy of this surface (the ball, its loop, the chain, the
  // manacle - see `render3d/avatarSurface.ts`). The same painted maps, dressed
  // the same way as the images arrive, under a key of its own so that the
  // avatar's rule (less fog) can be set on it without leaking onto
  // a wall that happens to ask for the same steel in the same tint. Cloning the
  // shared one instead would freeze the clone in the fallback surface, since the
  // authored maps are swapped into the cached object when they land.
  avatar?: boolean;
}

// The shared surface for a request. Callers must not mutate the result - with
// one exception: an `avatar` request, whose material is shared with the avatar
// alone and is dressed by `avatarSurface.ts`.
//
// Cached on every part of the request that changes what the material IS, so a
// hundred grey boxes in three colours are three materials and three draw
// states. The tile is part of the key because `repeat` lives on the texture
// rather than on the material: two tiling scales are two texture objects,
// sharing one uploaded image through `Texture.clone`.
//
// Exported so it can be asserted directly (`cli render3d`), which is the only
// way this claim can be checked at all: building a material needs a canvas, and
// that case suite is deliberately pure. It also has to be checked, because
// getting it wrong is invisible everywhere else - whichever of two shapes was
// built first wins, and the other wears its colour.
export function surfaceKey(req: SurfaceRequest): string {
  const name = surfaceName(req.texture);
  const tile = tileMetres(name, req.tileScale);
  const avatar = req.avatar === true ? "|avatar" : "";
  return `${name}|${tile}|${req.color ?? ""}${avatar}`;
}

// Does this surface glow of its own accord - is there an emission map in the
// set? The material's emissive must then be non-black for the map to show.
//
// Generated surfaces never emit: they are noise standing in for stuff, and stuff
// does not glow.
export function surfaceEmits(name: string | undefined): boolean {
  return TEXTURE_ASSETS[surfaceName(name)]?.maps.emissive !== undefined;
}

export function surfaceFor(req: SurfaceRequest): THREE.MeshStandardMaterial {
  const name = surfaceName(req.texture);
  const tile = tileMetres(name, req.tileScale);
  const key = surfaceKey(req);
  const cached = materialCache.get(key);
  if (cached) return cached;
  const authored = TEXTURE_ASSETS[name];
  // An authored set is drawn in its fallback surface until its images arrive.
  // The material is the same object throughout - the maps are swapped into it -
  // so nothing that has already been handed this material has to be told.
  const mat = buildSurface(authored ? (authored.fallback ?? DEFAULT_TEXTURE) : name, tile);
  if (req.color) mat.color = new THREE.Color(req.color);
  // A set carrying an emission map glows by being worn, so its emissive colour
  // is white: three.js multiplies the map by it, and the default black is an
  // emission map that renders as nothing at all.
  if (surfaceEmits(name)) mat.emissive = new THREE.Color("#ffffff");
  if (authored) void track(dressWithImages(mat, name, authored, tile), `surface "${name}"`);
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
export type LoadedMaps = Partial<Record<Slot, THREE.Texture>>;

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
        // Through the byte-counting downloader rather than straight at the URL,
        // so the loading screen can see this arriving (see download.ts). The
        // decode is still `TextureLoader`'s, over the bytes it holds.
        const tex = await withDownload(map.file, map.bytes, (href) => loader.loadAsync(href));
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

// Swap an authored set's maps into a material already in the scene, at this
// material's own tiling scale.
async function dressWithImages(
  mat: THREE.MeshStandardMaterial,
  name: string,
  asset: TextureAsset,
  tile: number,
): Promise<void> {
  const maps = await loadMaps(name, asset);
  const at = (slot: Slot): THREE.Texture | null => {
    const tex = maps[slot];
    if (!tex) return null;
    const clone = tex.clone();
    applyTiling(clone, tile);
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
  const emissive = at("emissive");
  if (base) mat.map = base;
  if (normal) mat.normalMap = normal;
  if (roughness) mat.roughnessMap = roughness;
  if (metallic) mat.metalnessMap = metallic;
  if (emissive) mat.emissiveMap = emissive;
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
  if (name === SOLID_SURFACE) return SOLID_SURFACE;
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
  // A flat fill has no pattern, so there is nothing for a repeat to be a repeat
  // OF. It answers 1 so the tiling arithmetic above stays total rather than
  // being special-cased at each caller; nothing samples a texture with it.
  if (name === SOLID_SURFACE) return 1;
  const authored = TEXTURE_ASSETS[name];
  if (authored) return authored.tile;
  return TEXTURE_SETS[name as MaterialName].tile;
}

// The generated maps for one surface, built once however many tiling scales and
// tints a level asks it for: generating a 256² value-noise field three times
// over is the one part of this that is not free, and a clone shares the uploaded
// image while carrying its own `repeat`.
const mapsCache = new Map<string, ReturnType<typeof buildMaps>>();

// One texture at one tiling scale: the extruder's UVs are metres (extrude.ts),
// so a repeat of `tile` metres is a UV repeat of its reciprocal.
function applyTiling(tex: THREE.Texture, tile: number): void {
  tex.repeat.set(1 / tile, 1 / tile);
}

function buildSurface(name: string, tile: number): THREE.MeshStandardMaterial {
  // A flat fill: no maps at all. The colour itself is applied by `surfaceFor`
  // like every other tint, so this is only the absence of a pattern.
  if (name === SOLID_SURFACE) {
    return new THREE.MeshStandardMaterial({ roughness: SOLID_ROUGHNESS, metalness: 0 });
  }
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
  for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) applyTiling(t, tile);
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
  // that release, so two entries naming DIFFERENT files may not share one.
  //
  // Several entries may name the SAME file, and then each addresses one prop
  // inside it by `node` - see there.
  file: string;
  // Which prop inside `file`, by node name, for a file holding more than one.
  // Absent means the file is one prop and its whole scene is it, which is what
  // every asset modelled and downloaded on its own is.
  //
  // This exists because a model PACK shares its materials, and a texture set is
  // the overwhelming majority of a prop's bytes: the 24 rocks are ~20 KB of
  // geometry each and 370 KB of 1k maps they all have in common. One file each
  // is 9.4 MB, of which 8.7 MB is the same three images written out 24 times -
  // paid again on every download, and again in VRAM, each time a level scatters
  // more than one of them. Together they are one 624 KB file, one fetch and one
  // GPU upload however many of them a level uses. `assets:extract` builds one;
  // `assets:optimize --keep-nodes` is what stops the optimiser welding a pack's
  // props into a single nameless object.
  //
  // The names are the manifest keys, which is what makes a pack readable: the
  // node inside `rocks.glb` that key "rock-7" draws is called `rock-7`. A name
  // that is not in the file loads nothing and draws the placeholder, exactly as
  // an unknown key does.
  node?: string;
  // The bytes this revision of the repo was written against. A release asset can
  // be replaced in place, so this is the only thing that says WHICH boulder a
  // given commit meant; the fetch verifies it and fails hard on a mismatch.
  // `bun run assets:publish` prints it.
  sha256: string;
  // The file's size in bytes, which is what the loading screen's bar is a
  // fraction OF (see render3d/download.ts). It is stated here rather than read
  // off the responses because a denominator that arrives with the download is
  // not a denominator: the browser opens six connections and queues the rest, so
  // the last file's Content-Length lands near the END of the load, and a bar
  // measured against what has answered so far races to 60% and then sits still
  // while the total catches up. Known up front, the bar is simply true.
  //
  // Written by `assets:publish` beside the hash and held to the file on disk by
  // `cli assets`, exactly as `sha256` is - it is the same kind of fact, and one
  // nobody should be typing by hand.
  bytes: number;
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
  // Whether the normal map was kept out of lossy WebP
  // (`assets:optimize --lossless-normals`), absent if it went lossy with every
  // other map. Recorded for the reason the two above are: re-optimising the
  // raw without it silently brings back the blocky highlight it removed.
  losslessNormals?: boolean;
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

// The prop manifest: the models the GAME draws itself. A level's own props are
// in its Blender scene (docs/blender-scenes.md), so what is here is only what
// code asks for by name. Hand-written on purpose: an asset is a decision, and a
// directory scan would make adding a file silently change what is drawn. It is
// also the licence record - see `source`/`license` above.
//
// Every entry is `assets:optimize`d, then `assets:publish`ed, and `cli assets`
// holds the whole directory to a byte budget; see docs/asset-store.md.
export const MESH_ASSETS: Record<string, MeshAsset> = {
  // THE AVATAR. A hammered cast-iron ball with a thin forged loop at its pole,
  // modelled for this game - the first prop here that is not scenery, and the
  // one thing on screen the player looks at for the whole of a run (see
  // `BallVisual`, which wears it, and `BALL_MESH` below, which is the name both
  // it and the preload resolver address it by).
  //
  // Metres, Y up, the ball centred on the origin at `BALL_MESH_RADIUS` (10 cm)
  // and the loop in the XY plane at +Y, its top at 1.24 radii - just inside
  // the collision lug's reach (`radius + BallPlayer.LOOP_EXCESS`, 1.29 radii
  // at the level's 12 cm ball), where the previous delivery stood at 1.40, a
  // centimetre proud of it. `BallVisual` scales the whole assembly from the
  // modelled radius to the ball's own, so a level that authors a different
  // one (`SpawnData.radius`) needs no second asset, and the loop rides the
  // ball's rotation as the material point it is.
  //
  // The sixth delivery (`hammered_iron_ball_LOD0_stylized_fitted.glb`, raw
  // at `assets-src/iron-ball.glb`), through `assets:optimize --keep-nodes
  // --lossless-normals`: its hammering is a subtle normal map on a glossy
  // sphere, and lossy WebP drew the highlight in stair-stepped blocks. One
  // node, `HammeredIronBall` (40,752 triangles, ball and loop in one mesh),
  // and no `simplify`: a sphere's silhouette IS the thing, this one is drawn
  // once and it is the closest object to the camera in every frame. One
  // material with a full PBR set. The normal and packed AO/roughness/
  // metalness maps are on the first UV set, a wrap with no background; the
  // albedo is a hand-painted map on a SECOND set (`texCoord: 1`), two
  // hemisphere discs with the loop inside the lower one, its gaps already
  // edge-filled so nothing bleeds in down the mips.
  "iron-ball": {
    file: "/meshes/iron-ball.glb",
    sha256: "4e24bc4ab17d7ce76ca60173e6d51e95622ae4f8b076b7c2ccc4aad9d6be7ae6",
    bytes: 1121832,
    losslessNormals: true,
    // A private commission rather than a download, so `source` is what it is
    // rather than a URL, and the author is deliberately unnamed - the modeller
    // asked for no credit. It still states a person and a permission, because
    // what this field is FOR is answering "can this ship" a year from now, and
    // "no attribution required" is the answer to a different question than
    // "may it be redistributed" (see docs/asset-store.md, which requires both
    // of any asset in the public store).
    source: "modelled for this game, delivered as a glTF binary",
    author: "a private commission, credit declined",
    license: "used with permission, redistributable, no attribution required",
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
  // The file's size in bytes, which is what the loading screen's bar is a
  // fraction OF (see render3d/download.ts). It is stated here rather than read
  // off the responses because a denominator that arrives with the download is
  // not a denominator: the browser opens six connections and queues the rest, so
  // the last file's Content-Length lands near the END of the load, and a bar
  // measured against what has answered so far races to 60% and then sits still
  // while the total catches up. Known up front, the bar is simply true.
  //
  // Written by `assets:publish` beside the hash and held to the file on disk by
  // `cli assets`, exactly as `sha256` is - it is the same kind of fact, and one
  // nobody should be typing by hand.
  bytes: number;
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
    bytes: 5068428,
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
    bytes: 94482,
    source: "scripts/bake-foam.ts (generated in this repository)",
    author: "Tristan Bray",
    license: "CC0",
  },
};

// A captured sky, as an equirectangular high-dynamic-range image: what a level
// can be lit BY, in place of the sky `environment.ts` generates from its own
// colours (`EnvironmentData.hdri` names one of these).
//
// It is the same store, fetch, budget and provenance rules as every other
// binary and a namespace of its own, for the reason `RAW_ASSETS` has one: this
// list is what the editor's `sky hdr` picker enumerates, so an entry here is a
// thing an author can choose and nothing else belongs in it.
//
// The bytes are always Radiance RGBE (`.hdr`) through `assets:optimize-hdri`,
// never the EXR a library ships - see that script for why, and for the round
// trip that says the conversion kept the light it was given.
export interface HdriAsset {
  // Path under `public/` - `/hdri/...`, gitignored and populated by
  // `bun run assets:fetch` like every other stored file.
  file: string;
  sha256: string;
  // The file's size in bytes, which is what the loading screen's bar is a
  // fraction OF (see render3d/download.ts). It is stated here rather than read
  // off the responses because a denominator that arrives with the download is
  // not a denominator: the browser opens six connections and queues the rest, so
  // the last file's Content-Length lands near the END of the load, and a bar
  // measured against what has answered so far races to 60% and then sits still
  // while the total catches up. Known up front, the bar is simply true.
  //
  // Written by `assets:publish` beside the hash and held to the file on disk by
  // `cli assets`, exactly as `sha256` is - it is the same kind of fact, and one
  // nobody should be typing by hand.
  bytes: number;
  // What the picker shows, since a manifest key is a slug and a sky is a place.
  label: string;
  // As on `MeshAsset`, and required for the same reasons.
  source: string;
  author: string;
  license: string;
}

export const HDRI_ASSETS: Record<string, HdriAsset> = {
  "golden-gate-hills": {
    file: "/hdri/golden-gate-hills.hdr",
    sha256: "d989c2b8483a783341137c05ab40d56ab4d803dd321e3cedff37bef6ca6135da",
    bytes: 1635416,
    label: "Golden Gate hills - open sky, afternoon sun",
    source: "https://polyhaven.com/a/golden_gate_hills (2k EXR, resampled to 1k RGBE)",
    author: "Greg Zaal, Rico Cilliers (Poly Haven)",
    license: "CC0",
  },
};

// The keys an author may pick from, sorted, so the editor's picker and anything
// else enumerating skies cannot disagree about what exists.
export function hdriNames(): string[] {
  return Object.keys(HDRI_ASSETS).sort();
}

// One decode per file however many scenes ask for it. The editor rebuilds its
// whole scene on every model revision - every drag - so an uncached load would
// re-fetch and re-decode 1.6 MB of sky for the length of a drag.
const hdriCache = new Map<string, Promise<THREE.DataTexture | null>>();
// The same, settled, for a caller that must decide SYNCHRONOUSLY whether it has
// a sky (see `Environment`): a scene rebuilt while the sky is already in memory
// must be built lit by it, rather than built on the generated fallback and
// swapped a frame later - which across a drag is the whole level's lighting
// flickering once per rebuild.
const hdriReady = new Map<string, THREE.DataTexture>();

export function loadedHdri(key: string): THREE.DataTexture | null {
  const asset = HDRI_ASSETS[key];
  return (asset && hdriReady.get(asset.file)) ?? null;
}

// Dynamically imported for the same reason the GLTF loader is: it is a large
// module, most levels name no sky at all, and a page that does not load one
// should not carry the decoder for it.
let hdrLoaderPromise: Promise<{ loadAsync(url: string): Promise<THREE.DataTexture> }> | null = null;

function hdrLoader(): Promise<{ loadAsync(url: string): Promise<THREE.DataTexture> }> {
  hdrLoaderPromise ??= import("three/examples/jsm/loaders/HDRLoader.js").then(
    ({ HDRLoader }) => new HDRLoader() as unknown as { loadAsync(url: string): Promise<THREE.DataTexture> },
  );
  return hdrLoaderPromise;
}

// The sky a level named, or null for one this build does not have - which is not
// an error and is drawn as the generated sky, exactly as an unknown texture name
// lands on a generated surface. A level built against a manifest this build does
// not carry should look ordinary rather than unlit.
//
// Tracked (`trackPending`) because a headless grab must WAIT for it: a
// screenshot taken while the sky is still arriving photographs the fallback, and
// the whole point of `cli shot --3d` is that the same command produces the same
// picture twice.
export function loadHdri(key: string): Promise<THREE.DataTexture | null> {
  const asset = HDRI_ASSETS[key];
  if (!asset) return Promise.resolve(null);
  const cached = hdriCache.get(asset.file);
  if (cached) return cached;
  // The decoder chunk and the sky itself are fetched at the same time rather
  // than one after the other: `hdrLoader()` starts the import here, and
  // `withDownload` starts the download on the call, so the 1.6 MB of sky is
  // already arriving while the module that will parse it is still on its way.
  const loading = hdrLoader();
  const p = track(
    withDownload(asset.file, asset.bytes, (href) => loading.then((loader) => loader.loadAsync(href)))
      .then((tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        hdriReady.set(asset.file, tex);
        return tex;
      })
      .catch((err: unknown) => {
        // A missing file is the unfetched-clone case and draws the generated
        // sky; saying which key and which file is what turns "the lighting looks
        // wrong" into `bun run assets:fetch`.
        console.warn(`[render3d] hdri "${key}": ${String(err)} <- ${asset.file}`);
        return null;
      }),
    `hdri "${key}"`,
  );
  hdriCache.set(asset.file, p);
  return p;
}

// Keyed by FILE rather than by manifest key, because a file can hold several
// props (see `MeshAsset.node`): keying it by the manifest key would fetch and
// decode `rocks.glb` once per rock a level uses, which is exactly the cost
// packing them together is for. Two keys naming one file share the fetch, the
// decode and the GPU upload of its material.
const gltfCache = new Map<string, Promise<THREE.Object3D | null>>();

// The GLTF loader is imported DYNAMICALLY, so it lands in a chunk of its own and
// is fetched only by a page that actually loads a prop. It is a large module,
// the manifest is empty for a level that authors no meshes, and the editor never
// needs it eagerly - which is exactly the case chunk splitting is for.
let loaderPromise: Promise<GLTFLoader> | null = null;

export function gltfLoader(): Promise<GLTFLoader> {
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

// One decoded scene per file, shared by every manifest key that names it. What
// is cached is the file AS EXPORTED - no `scale`, no rotation - because those
// are per ENTRY and two entries may address different nodes of one file with
// different ones.
function loadFile(file: string, bytes: number): Promise<THREE.Object3D | null> {
  const cached = gltfCache.get(file);
  if (cached) return cached;
  // Loader chunk and file in parallel, as `loadHdri` does, and the file's bytes
  // counted on the way past (see download.ts). Every GLB in the store is
  // self-contained, so a loader handed a `blob:` URL has no sidecar left to
  // resolve against it.
  const loading = gltfLoader();
  const p = withDownload(file, bytes, (href) => loading.then((loader) => loader.loadAsync(href)))
    .then((gltf) => {
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        wakeEmission(mesh.material);
      });
      return gltf.scene as THREE.Object3D;
    })
    .catch((err: unknown) => {
      // The failure stays cached: a file that is not there is asked for once,
      // not on every scene rebuild.
      console.warn(`[render3d] mesh file "${file}" failed to load:`, err);
      return null;
    });
  gltfCache.set(file, track(p, `mesh file "${file}"`));
  return p;
}

// The prop for a manifest key, as a fresh instance the caller owns. Resolves to
// null for an unknown key or a load failure, which is the caller's cue to keep
// its placeholder.
export function loadMesh(key: string): Promise<THREE.Object3D | null> {
  const asset = MESH_ASSETS[key];
  if (!asset) return Promise.resolve(null);
  return loadFile(asset.file, asset.bytes).then((root) => {
    if (!root) return null;
    const picked = asset.node === undefined ? root : root.getObjectByName(asset.node);
    if (!picked) {
      // A pack whose node was renamed by a re-export is the one way this
      // happens, and it is indistinguishable on screen from a fetch that failed
      // - so it says which name it looked for.
      console.warn(`[render3d] mesh "${key}": no node "${asset.node}" in ${asset.file}`);
      return null;
    }
    const obj = picked.clone(true);
    if (picked !== root) {
      // A node lifted out of a file keeps the transform it inherited inside it,
      // so a prop nested under a wrapper node lands where the file puts it
      // rather than at the wrapper's origin. (`assets:extract` writes packs flat
      // and untransformed, so for those this is the identity; it is here so that
      // `node` addresses a node of ANY file rather than only of one this
      // project's own pipeline built.)
      picked.updateWorldMatrix(true, false);
      picked.matrixWorld.decompose(obj.position, obj.quaternion, obj.scale);
    }
    // The entry's own scale and rotation ride a wrapper rather than the prop, so
    // they compose with whatever transform the node brought with it instead of
    // overwriting it.
    const holder = new THREE.Group();
    holder.scale.setScalar(asset.scale ?? 1);
    holder.rotation.set(asset.rotX ?? 0, asset.rotY ?? 0, asset.rotZ ?? 0);
    holder.add(obj);
    return holder as THREE.Object3D;
  });
}
