// THE ROCK MATERIAL - what a generated rock (rockMesh.ts, docs/rocks.md) is
// drawn with: BAKED LOW-FREQUENCY MASKS from the GLB composed with TILEABLE
// HIGH-FREQUENCY DETAIL from two photographed sets, inside three's own
// MeshStandardMaterial so the lamps, the shadows, the fog, the tone mapping and
// the painted light (paint.ts) treat a rock exactly as they treat every other
// surface (`surfaceOf` builds MeshStandardMaterials too).
//
// The look: STYLISED, HAND-PAINTED stone (the owner's direction, 2026-09-24,
// after a Rafal Urbanski rock study). Faces read as flat planes of tone with
// soft gradients rather than photographic grain; the value is set mostly by
// ORIENTATION - up-facing planes light, side planes mid, down-facing planes
// dark (the hemisphere term below) - with lighter convex edges, cool dark
// cracks between blocks, and only a low-contrast painted mottling from the
// tiles. The hue is one constant (`ROCK_BASE`, the `dark rock` texture's
// mean) and the palette is value variations of it; a cool-slate preset after
// the reference is one edit away (`ROCK_PALETTE`).
//
// WHAT THE GLB CARRIES (the contract tools/blender/rocks.py writes to):
// - TEXCOORD_0: world-metre box UVs. Front and back faces are (x, up), the
//   sides (depth, up), top and bottom (x, depth), so V is the world-up axis on
//   every face that has one, and one unit is one metre.
// - TEXCOORD_1: the body's own AO atlas, which GLTFLoader hands over as
//   `material.aoMap` with `channel = 1`.
// - COLOR_0: MASKS, not colour. r = cavity (1 open surface, 0 deep cavity),
//   g = depth shade (1 the proudest face, about 0.55 the deepest recess),
//   b = a per-shard random in 0..1. Read here as data, so three's own
//   `diffuseColor *= vColor` is removed from the shader.
// Any of the three missing reads as neutral: no aoMap is an AO of 1, no COLOR_0
// is an open, proud, middling surface.
//
// WHAT IS COMPOSED FROM WHAT:
// - ALBEDO: a colour picked by the face's world normal from the palette
//   (GROUND toward -y, SIDE level, SKY toward +y, a smoothstep on normal.y
//   each way); lifted toward EDGE on convex, proud vertices; pulled to the
//   cool CREVICE by the cavity and the AO; times the painted `seaside rock`
//   base at its own 2 m tile, desaturated and normalised by its own mean and
//   then mostly flattened, so it is a low-contrast mottling only; times the
//   depth shade, a per-shard brightness jitter and a share of the AO.
// - NORMAL: the painted `quarry wall` normal at its own 1.8 m tile, at a
//   subtle scale (its facets, not a photograph's grain), sampled with the
//   box UV's axes SWAPPED so the striations (which run along the image's u)
//   run up the columns, plus a second sample at a larger scale to break the
//   repeat. The tangent frame is built here from the SWAPPED coordinate's own
//   screen derivatives (three's `getTangentFrame`, the cotangent frame of
//   http://www.thetenthplanet.de/archives/1180), so the map is read in the
//   frame it is sampled in and no hand rotation of its xy is needed - see
//   `rockFragmentNormal`.
// - ROUGHNESS: the `quarry wall` roughness, lifted by a bias and further in
//   the cavities.
//
// Where a named set is not in the manifest the rock falls back to `dark rock`
// for that role and says so once, so a missing set is a visibly different rock
// rather than a black one.

import * as THREE from "three";
import { authoredMaps, type LoadedMaps, surfaceTile, TEXTURE_ASSETS, trackPending } from "./assets";
import { paintMaterial } from "./paint";

// ---------------------------------------------------------------------------
// Tunables. Colours are sRGB hex as an artist picks them; three converts them
// to the linear working space the shader mixes in.
// ---------------------------------------------------------------------------

// The set whose BASE (albedo) is the colour detail.
export const ROCK_ALBEDO_SET = "seaside rock";
// The set whose NORMAL and ROUGHNESS are the grain.
export const ROCK_DETAIL_SET = "quarry wall";
// What either role wears when its set is not in the manifest.
export const ROCK_FALLBACK_SET = "dark rock";

// How far the albedo tile is pulled toward its own grey, 0 (as photographed)
// to 1 (grey). The ramp below is what colours the rock; the tile's own hue
// would fight it.
// At 1 the tile is pure luminance: the seaside and quarry photographs are
// brown, and the owner's direction (2026-09-24) is that the rock reads as a
// neutral grey with the warmth only in the gaps.
export const ROCK_DESATURATE = 1.0;
// How much of the tile's brightness variation survives, 0 (none, a flat ramp)
// to 1 (all of it). The tile is divided by its own mean luminance first, so
// this is a contrast and never a change of overall brightness. Low: the
// stylised look keeps the painted tile's mottling and specks, not its grain.
export const ROCK_ALBEDO_CONTRAST = 0.35;

// The one HUE every default colour is a value of: the mean colour of the
// level's `dark rock` texture (its raw scan, #3a342c), a dark, slightly warm
// grey, so a generated rock and a wall still wearing that set read as the
// same stone (the owner's ask).
export const ROCK_BASE = "#3a342c";

// A palette. SKY is a plane facing straight up, SIDE a plane facing level,
// GROUND a plane facing straight down; EDGE is what a SIDE face's exposed
// convex edge lifts to (the lift is applied as the ratio EDGE / SIDE, so an
// up-facing plane's edge is lighter than the plane in the same proportion);
// CREVICE the cool dark of the cracks between blocks.
export interface RockPalette {
  sky: string;
  side: string;
  ground: string;
  edge: string;
  crevice: string;
}

// `base` at another HSL lightness, its hue and saturation kept.
function valueOf(base: string, lightness: number): string {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(base).getHSL(hsl, THREE.SRGBColorSpace);
  return `#${new THREE.Color().setHSL(hsl.h, hsl.s, lightness, THREE.SRGBColorSpace).getHexString(THREE.SRGBColorSpace)}`;
}

export const ROCK_PALETTES = {
  // The default: value variations of ROCK_BASE (lightness 0.20), so the rock
  // stays the dark-rock colour and gains the stylised value range. The
  // crevice alone leaves the hue: a cool near-black, never a warm brown.
  "dark-rock": {
    sky: valueOf(ROCK_BASE, 0.55),
    side: valueOf(ROCK_BASE, 0.27),
    ground: valueOf(ROCK_BASE, 0.12),
    edge: valueOf(ROCK_BASE, 0.4),
    crevice: "#101317",
  },
  // The reference's own cool blue-grey (light faces about #b0b4b8, dark
  // faces about #3a4048).
  "cool-slate": {
    sky: "#b0b4b8",
    side: "#7a828c",
    ground: "#3a4048",
    edge: "#aab0b8",
    crevice: "#161a22",
  },
} satisfies Record<string, RockPalette>;

// Which palette the rocks wear. One edit flips the look. The owner chose the
// reference's cool slate over the dark-rock hue (2026-09-24).
export const ROCK_PALETTE: keyof typeof ROCK_PALETTES = "cool-slate";

// The hemisphere term: the SIDE colour blends to SKY over
// smoothstep(LO, HI, normal.y) and to GROUND over smoothstep(LO, HI, -normal.y).
// The world normal is the geometric one (the GLB's sharp-edged smooth
// shading), so one facet is one tone; the detail normal never enters it.
export const ROCK_SKY_LO = 0.2;
export const ROCK_SKY_HI = 0.8;
export const ROCK_GROUND_LO = 0.2;
export const ROCK_GROUND_HI = 0.8;

// How strongly each input drives the crevice colour: a fully closed cavity
// (COLOR_0.r = 0) contributes CAVITY, a fully occluded AO texel contributes AO;
// the sum is clamped and eased.
export const ROCK_CREVICE_FROM_CAVITY = 1.0;
export const ROCK_CREVICE_FROM_AO = 0.5;
// The crevice blend eases in over this window of the summed drive, so a face
// that is only slightly closed keeps its plane's tone: the dark is drawn in
// the gaps between blocks, never over the rock's own faces.
export const ROCK_CREVICE_LO = 0.35;
export const ROCK_CREVICE_HI = 0.9;

// Edge exposure: smoothstep over the cavity mask (convex is near 1) times
// smoothstep over the depth shade (only proud faces have an exposed edge),
// times the amount; the colour is multiplied by EDGE / SIDE that far.
export const ROCK_EDGE_CAVITY_LO = 0.85;
export const ROCK_EDGE_CAVITY_HI = 1.0;
export const ROCK_EDGE_SHADE_LO = 0.8;
export const ROCK_EDGE_SHADE_HI = 1.0;
export const ROCK_EDGE_AMOUNT = 0.6;

// Per-shard brightness jitter from COLOR_0.b: the shard is scaled by
// 1 + (b - 0.5) * 2 * JITTER, so 0.12 is +-12 %.
export const ROCK_JITTER = 0.12;

// How much of the AO darkens the ALBEDO (and so the direct light too), 0..1.
// The indirect light already takes the full AO the standard way (three's
// `aomap_fragment`); at 1 the ambient would see AO twice. The scene is lit
// nearly head-on, where the sun alone would light the back of a gap as
// brightly as the face in front of it, so most of it goes in.
export const ROCK_AO_DIRECT = 0.7;
// `material.aoMapIntensity`: (ao - 1) * this + 1, three's own rule.
export const ROCK_AO_INTENSITY = 1.0;

// Relief of the detail normal map (three's `normalScale`). Subtle: the planes
// of tone come from the geometry and the hemisphere term; the painted facets
// only break a plane's gradient a little.
export const ROCK_NORMAL_SCALE = 0.3;
// The second detail sample, which breaks the repeat: at this multiple of the
// first sample's frequency (0.37 = features 2.7 times larger), offset so the
// two tiles never line up, blended in at WEIGHT (partial-derivative add).
export const ROCK_DETAIL_SCALE_2 = 0.37;
export const ROCK_DETAIL_WEIGHT_2 = 0.5;
const DETAIL_OFFSET_2 = [0.31, 0.67] as const;

// Roughness = the detail map + BIAS + (1 - cavity) * CAVITY, clamped to 1.
// The painted light floors it at 0.42 anyway (paint.ts).
export const ROCK_ROUGHNESS_BIAS = 0.15;
export const ROCK_CAVITY_ROUGHNESS = 0.15;

// ---------------------------------------------------------------------------

export interface RockMaterialOptions {
  // The body's baked AO atlas as GLTFLoader decoded it (its `channel` is kept,
  // 1 for TEXCOORD_1). Absent = no AO.
  aoMap?: THREE.Texture | null;
  // Whether the geometry carries COLOR_0 masks. Without them the shader reads
  // a neutral surface rather than the zeros a missing attribute would give.
  masks?: boolean;
  side?: THREE.Side;
  // The second detail normal sample (`ROCK_DETAIL_SCALE_2`). Default on.
  secondDetail?: boolean;
}

const f = (x: number): string => x.toFixed(5);
const rgb = (hex: string): string => {
  const c = new THREE.Color(hex);
  return `vec3( ${f(c.r)}, ${f(c.g)}, ${f(c.b)} )`;
};
// a / b per linear channel, as a vec3.
const ratio = (a: string, b: string): string => {
  const x = new THREE.Color(a);
  const y = new THREE.Color(b);
  return `vec3( ${f(x.r / Math.max(y.r, 1e-4))}, ${f(x.g / Math.max(y.g, 1e-4))}, ${f(x.b / Math.max(y.b, 1e-4))} )`;
};
const palette: RockPalette = ROCK_PALETTES[ROCK_PALETTE];

// One 1x1 texture per role until the sets arrive, each the neutral value of
// what it stands for: a grey whose normalised value is 1, a flat normal, full
// roughness. Swapped by value into the shared uniforms, so no program is
// rebuilt when the images land.
function pixel(r: number, g: number, b: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// Shared by every rock material: the tiles are the same for every body, and
// one uniform object shared across programs is updated for all of them at once
// (the pattern `orthoFramedZ` uses in projection.ts).
const shared = {
  rockAlbedo: { value: null as THREE.Texture | null },
  rockAlbedoGain: { value: 1 },
  rockAlbedoRepeat: { value: 1 / 2 },
  rockDetailNormal: { value: null as THREE.Texture | null },
  rockDetailRough: { value: null as THREE.Texture | null },
  rockDetailRepeat: { value: 1 / 1.8 },
};

let loading: Promise<void> | null = null;

function setName(wanted: string): string {
  if (wanted in TEXTURE_ASSETS) return wanted;
  console.info(`[rocks] texture set "${wanted}" is not in the manifest; the rock wears "${ROCK_FALLBACK_SET}" for it`);
  return ROCK_FALLBACK_SET;
}

// The mean LINEAR luminance of an image, so the albedo tile can be divided by
// it and carry variation only - whichever set is worn, the ramp's colours are
// the rock's colours. Read from a small downscale; a failure (no canvas, a
// tainted image) answers null and the tile is worn as it comes.
function meanLuminance(image: unknown): number | null {
  try {
    const src = image as CanvasImageSource;
    const n = 32;
    const canvas = new OffscreenCanvas(n, n);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, n, n);
    const px = ctx.getImageData(0, 0, n, n).data;
    const lin = (v: number): number => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += 0.2126 * lin(px[i]!) + 0.7152 * lin(px[i + 1]!) + 0.0722 * lin(px[i + 2]!);
    }
    const mean = sum / (n * n);
    return mean > 1e-4 ? mean : null;
  } catch {
    return null;
  }
}

function loadTiles(): Promise<void> {
  if (loading) return loading;
  shared.rockAlbedo.value = pixel(128, 128, 128, true);
  shared.rockAlbedoGain.value = 1 / new THREE.Color(0x808080).r;
  shared.rockDetailNormal.value = pixel(128, 128, 255, false);
  shared.rockDetailRough.value = pixel(255, 255, 255, false);
  const albedoSet = setName(ROCK_ALBEDO_SET);
  const detailSet = setName(ROCK_DETAIL_SET);
  const p = (async () => {
    const [albedo, detail] = await Promise.all([
      authoredMaps(albedoSet) ?? Promise.resolve<LoadedMaps>({}),
      authoredMaps(detailSet) ?? Promise.resolve<LoadedMaps>({}),
    ]);
    if (albedo.base) {
      shared.rockAlbedo.value = albedo.base;
      shared.rockAlbedoRepeat.value = 1 / surfaceTile(albedoSet);
      const mean = meanLuminance(albedo.base.image);
      shared.rockAlbedoGain.value = mean ? 1 / mean : 1;    }
    shared.rockDetailRepeat.value = 1 / surfaceTile(detailSet);
    if (detail.normal) shared.rockDetailNormal.value = detail.normal;
    if (detail.roughness) shared.rockDetailRough.value = detail.roughness;
  })();
  loading = trackPending(p, "rock material tiles");
  return loading;
}

// ---------------------------------------------------------------------------
// The shader. Every replacement is asserted (`inject`), so a three.js upgrade
// that renames a chunk fails loudly rather than quietly drawing plain grey.
// ---------------------------------------------------------------------------

const ROCK_VERTEX_PARS = /* glsl */ `#include <uv_pars_vertex>
varying vec2 vRockUv;
varying vec3 vRockWorldNormal;`;

const ROCK_VERTEX_UV = /* glsl */ `#include <uv_vertex>
vRockUv = uv;`;

// `objectNormal` is declared by beginnormal_vertex. The rocks are mounted in
// world space with no transform of their own, but the model matrix is applied
// anyway so the hemisphere term stays right if that ever changes.
const ROCK_VERTEX_NORMAL = /* glsl */ `#include <beginnormal_vertex>
vRockWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`;

const fragmentPars = (): string => /* glsl */ `#include <uv_pars_fragment>
varying vec2 vRockUv;
varying vec3 vRockWorldNormal;
uniform sampler2D rockAlbedo;
uniform float rockAlbedoGain;
uniform float rockAlbedoRepeat;
uniform sampler2D rockDetailNormal;
uniform sampler2D rockDetailRough;
uniform float rockDetailRepeat;

// three's getTangentFrame (normalmap_pars_fragment), which is only compiled
// when a normalMap is set - and this material samples its own. The cotangent
// frame: T and B are the surface gradients of uv.s and uv.t, built from the
// screen derivatives of the view position and of the SAME uv the map is
// sampled at, so whatever mapping produced that uv (a swap, a mirror, a turn)
// the map's +x and +y land where the image's own +s and +t run on the surface.
mat3 rockTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
  vec3 q0 = dFdx( eye_pos.xyz );
  vec3 q1 = dFdy( eye_pos.xyz );
  vec2 st0 = dFdx( uv.st );
  vec2 st1 = dFdy( uv.st );
  vec3 N = surf_norm;
  vec3 q1perp = cross( q1, N );
  vec3 q0perp = cross( N, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * scale, B * scale, N );
}`;

// The albedo, in place of three's `diffuseColor *= vColor`. Declares the masks
// and the detail coordinate at main() scope, where the roughness and normal
// chunks below read them.
const ROCK_FRAGMENT_COLOR = /* glsl */ `
#ifdef USE_COLOR
  float rockCavity = vColor.r;
  float rockShade = vColor.g;
  float rockVary = vColor.b;
#else
  float rockCavity = 1.0;
  float rockShade = 1.0;
  float rockVary = 0.5;
#endif
#ifdef USE_AOMAP
  float rockAo = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
#else
  float rockAo = 1.0;
#endif
  // The detail coordinate: the box UV with its axes SWAPPED, so the image's u
  // (along which the quarry striations run) runs along V = world up.
  vec2 rockDetailUv = vRockUv.yx * rockDetailRepeat;
  {
    vec3 tile = texture2D( rockAlbedo, vRockUv * rockAlbedoRepeat ).rgb;
    tile = mix( tile, vec3( luminance( tile ) ), ${f(ROCK_DESATURATE)} ) * rockAlbedoGain;
    tile = mix( vec3( 1.0 ), tile, ${f(ROCK_ALBEDO_CONTRAST)} );

    // The hemisphere term: the plane's tone by which way it faces.
    float ny = normalize( vRockWorldNormal ).y;
    vec3 ramp = mix( ${rgb(palette.side)}, ${rgb(palette.sky)}, smoothstep( ${f(ROCK_SKY_LO)}, ${f(ROCK_SKY_HI)}, ny ) );
    ramp = mix( ramp, ${rgb(palette.ground)}, smoothstep( ${f(ROCK_GROUND_LO)}, ${f(ROCK_GROUND_HI)}, -ny ) );

    float edge = smoothstep( ${f(ROCK_EDGE_CAVITY_LO)}, ${f(ROCK_EDGE_CAVITY_HI)}, rockCavity )
      * smoothstep( ${f(ROCK_EDGE_SHADE_LO)}, ${f(ROCK_EDGE_SHADE_HI)}, rockShade );
    ramp *= mix( vec3( 1.0 ), ${ratio(palette.edge, palette.side)}, edge * ${f(ROCK_EDGE_AMOUNT)} );

    float drive = ( 1.0 - rockCavity ) * ${f(ROCK_CREVICE_FROM_CAVITY)} + ( 1.0 - rockAo ) * ${f(ROCK_CREVICE_FROM_AO)};
    float crevice = smoothstep( ${f(ROCK_CREVICE_LO)}, ${f(ROCK_CREVICE_HI)}, drive );
    ramp = mix( ramp, ${rgb(palette.crevice)}, crevice );

    float jitter = 1.0 + ( rockVary - 0.5 ) * ${f(2 * ROCK_JITTER)};
    diffuseColor.rgb *= tile * ramp * rockShade * jitter * mix( 1.0, rockAo, ${f(ROCK_AO_DIRECT)} );
  }
`;

const ROCK_FRAGMENT_ROUGHNESS = /* glsl */ `
float roughnessFactor = roughness;
roughnessFactor *= texture2D( rockDetailRough, rockDetailUv ).g;
roughnessFactor = saturate( roughnessFactor + ${f(ROCK_ROUGHNESS_BIAS)} + ( 1.0 - rockCavity ) * ${f(ROCK_CAVITY_ROUGHNESS)} );
`;

// The detail normal, in place of three's normal_fragment_maps (which compiles
// to nothing here: no normalMap is set). The frame is built from
// `rockDetailUv` itself, so the swap needs no correction of the sampled xy:
// the map's +x is read along the surface direction in which rockDetailUv.s
// grows (world up, since .s is the box V) and +y along .t (the box U) - the
// directions the image's own +u and +v are laid along. Relative to the box
// UV's frame that is the TRANSPOSE (x, y) -> (y, x) of the sampled xy, which
// is what a hand correction applied in three's own frame would have to be.
// DOUBLE_SIDED follows normal_fragment_begin: T and B flip with the face.
const rockFragmentNormal = (second: boolean): string => /* glsl */ `
{
  mat3 rockTbn = rockTangentFrame( - vViewPosition, normal, rockDetailUv );
  #ifdef DOUBLE_SIDED
    rockTbn[0] *= faceDirection;
    rockTbn[1] *= faceDirection;
  #endif
  vec3 mapN = texture2D( rockDetailNormal, rockDetailUv ).xyz * 2.0 - 1.0;
  ${
    second
      ? `// The same frame serves the larger sample: scaling a uv changes the
  // length of its gradients, not their direction, and the frame is normalised.
  vec3 mapN2 = texture2D( rockDetailNormal, rockDetailUv * ${f(ROCK_DETAIL_SCALE_2)} + vec2( ${f(DETAIL_OFFSET_2[0])}, ${f(DETAIL_OFFSET_2[1])} ) ).xyz * 2.0 - 1.0;
  mapN.xy += mapN2.xy * ${f(ROCK_DETAIL_WEIGHT_2)};`
      : ""
  }
  mapN.xy *= ${f(ROCK_NORMAL_SCALE)};
  normal = normalize( rockTbn * mapN );
}
`;

function inject(src: string, chunk: string, to: string): string {
  const from = `#include <${chunk}>`;
  if (!src.includes(from)) throw new Error(`rockMaterial: three's shader no longer includes <${chunk}>`);
  return src.replace(from, to);
}

// A rock body's material. One per body (its AO atlas is its own); every one
// shares one program and the detail tiles.
export function rockMaterial(opts: RockMaterialOptions = {}): THREE.MeshStandardMaterial {
  void loadTiles();
  const masks = opts.masks ?? true;
  const second = opts.secondDetail ?? true;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1, // the detail map is the roughness; this is its multiplier
    metalness: 0,
    // The masks reach the fragment shader as three's own vColor varying; the
    // multiplication three would do with it is replaced by the ramp below.
    vertexColors: masks,
    side: opts.side ?? THREE.FrontSide,
  });
  if (opts.aoMap) {
    mat.aoMap = opts.aoMap;
    mat.aoMapIntensity = ROCK_AO_INTENSITY;
  }
  mat.name = "rock";
  // The palette is compiled into the program as constants, so it is in the key.
  mat.customProgramCacheKey = () => `rock|${second ? 2 : 1}|${ROCK_PALETTE}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    let vs = shader.vertexShader;
    vs = inject(vs, "uv_pars_vertex", ROCK_VERTEX_PARS);
    vs = inject(vs, "uv_vertex", ROCK_VERTEX_UV);
    vs = inject(vs, "beginnormal_vertex", ROCK_VERTEX_NORMAL);
    shader.vertexShader = vs;
    let fs = shader.fragmentShader;
    fs = inject(fs, "uv_pars_fragment", fragmentPars());
    fs = inject(fs, "color_fragment", ROCK_FRAGMENT_COLOR);
    fs = inject(fs, "roughnessmap_fragment", ROCK_FRAGMENT_ROUGHNESS);
    fs = inject(fs, "normal_fragment_maps", rockFragmentNormal(second));
    shader.fragmentShader = fs;
  };
  // After the hook above: the painted light calls it first and extends its key.
  paintMaterial(mat);
  return mat;
}
