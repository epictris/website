// PAINTED TEXTURE LAYERS laid over a formation's rock (docs/formations.md,
// "Texture layers"): a texture-only moss, grown as a map in the rock's paint
// UV (tools/blender/decoration_layer.py) rather than a shell over it, mixed
// into the rock's colour by its coverage. Part of the rock's own look, so no
// facet of the rock can stand through it, as it stood through the shell
// wherever the two were triangulated apart (2026-11-25).
//
// The paint UV is the rock's first UV map, made once at Generate
// (formation_export.py `paint_unwrap`): TEXCOORD_0 of the iteration mesh, and
// of every tier of the bake beside the bake's own TEXCOORD_1, so a layer lands
// alike on the unbaked rock and the baked one. Both rock materials are
// wrapped the same way (`layered`): the layers are mixed into the colour once
// it is final, before anything shades it.
//
// A MATERIAL LAYER (docs/formations.md, "Material layers", 2026-11-26) is a
// library material, a Principled BSDF authored in Blender, baked into the
// same paint UV (tools/blender/material_layer.py): its colour, its roughness,
// metallic and height, and its tangent-space normal. It replaces the rock's
// colour, roughness, metalness and shading normal where it covers, the cover
// its mask's (the whole rock without one) sharpened by its height, so its
// high parts come in first and an edge ends along its clods, not as a fade.

import * as THREE from "three";

// The samplers the layers of one rock may take at most: a painted layer
// takes one, a material layer three and a fourth for a mask. The rock's
// own maps, the shadow maps and the reflection probe take the rest of the 16
// a fragment shader is sure of in WebGL2.
export const MAX_PAINT_SAMPLERS = 8;
// How far into a material's height its mask's edge reaches: at a mask of
// one half, texels of height above 1 - MASK_HEIGHT_REACH / 2 are covered.
const MASK_HEIGHT_REACH = 0.6;

const loader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();

// A layer's map, loaded once a page, laid out as glTF lays its UVs (no
// flip): colour (sRGB, coverage in alpha) unless `data`, a map of numbers
// (a material's surface or normal, a mask), read as stored.
export function paintLayerTexture(url: string, data = false): THREE.Texture {
  const key = `${data ? "data" : "colour"}:${url}`;
  let t = textures.get(key);
  if (!t) {
    t = loader.load(url);
    t.flipY = false;
    t.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.anisotropy = 8;
    textures.set(key, t);
  }
  return t;
}

// The rock's paint UV under the one name the layers read, `aPaintUv` (an alias
// of the same buffer, so free). The iteration mesh's is `uv`; a baked tier's
// is `uv` beside the bake's `uv1`. A tier with no `uv1`, or a mesh with no
// `uv`, was made before the paint UV and has none: false.
export function exposePaintUv(geometry: THREE.BufferGeometry, baked: boolean): boolean {
  if (geometry.getAttribute("aPaintUv")) return true;
  const uv = geometry.getAttribute("uv");
  if (!uv || (baked && !geometry.getAttribute("uv1"))) return false;
  geometry.setAttribute("aPaintUv", uv);
  return true;
}

// A baked library material's maps beside its colour (material_layer.py):
// `surface` R roughness, G metallic, B height; `normal` tangent space of the
// paint UV, OpenGL (+Y) as Blender bakes it; `mask` its cover in red, or null
// for the whole rock.
export interface MaterialMaps {
  surface: THREE.Texture;
  normal: THREE.Texture;
  mask: THREE.Texture | null;
}

// One layer a rock wears: its colour map (coverage in alpha for a painted
// layer), a material layer's other maps, and what a click on it picks (the
// decoration's pick tag, `pickTagOf`).
export interface PaintLayer {
  texture: THREE.Texture;
  material?: MaterialMaps;
  tag: unknown;
}

function samplersOf(l: PaintLayer): number {
  return l.material ? (l.material.mask ? 4 : 3) : 1;
}

// The layers that fit MAX_PAINT_SAMPLERS, in order; the rest are not drawn.
function within(layers: readonly PaintLayer[]): PaintLayer[] {
  const kept: PaintLayer[] = [];
  let used = 0;
  for (const l of layers) {
    if (used + samplersOf(l) > MAX_PAINT_SAMPLERS) break;
    used += samplersOf(l);
    kept.push(l);
  }
  return kept;
}

// The tangent frame of the paint UV from screen derivatives, as three builds
// one for a normal map on a mesh without tangents (normal_fragment_begin's
// `getTangentFrame`, which it declares only for its own normal map).
const TANGENT_FRAME = `
mat3 paintTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
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

// A copy of a rock material with `layers` over it, in order. A painted layer
// is mixed into the colour by its coverage; a material layer into the colour,
// roughness, metalness and shading normal by its cover. The material's own
// patch (the slate's) runs first; each layer goes in where its quantity is
// final (the colour before the alpha map, which every lit material includes
// after its colour; roughness and metalness after their maps; the normal
// after the rock's own normal map). The layers are kept on the copy
// (`paintLayerAt`).
export function layered(material: THREE.Material, layers: readonly PaintLayer[]): THREE.Material {
  const kept = within(layers);
  const m = material.clone();
  const own = material.onBeforeCompile.bind(material);
  const ownKey = material.customProgramCacheKey();
  m.userData[LAYERS] = kept;
  const signature = kept.map((l) => (l.material ? (l.material.mask ? "M" : "m") : "p")).join("");
  m.onBeforeCompile = (shader, renderer) => {
    own(shader, renderer);
    const uniforms: string[] = [];
    const colour: string[] = [];
    const surface: string[] = [];
    const normal: string[] = [];
    kept.forEach((l, i) => {
      shader.uniforms[`paintLayer${i}`] = { value: l.texture };
      uniforms.push(`uniform sampler2D paintLayer${i};`);
      if (!l.material) {
        colour.push(`{ vec4 c = texture2D( paintLayer${i}, vPaintUv ); diffuseColor.rgb = mix( diffuseColor.rgb, c.rgb, c.a ); }`);
        return;
      }
      shader.uniforms[`paintSurface${i}`] = { value: l.material.surface };
      shader.uniforms[`paintNormal${i}`] = { value: l.material.normal };
      uniforms.push(`uniform sampler2D paintSurface${i};`, `uniform sampler2D paintNormal${i};`);
      let cover = "1.0";
      if (l.material.mask) {
        shader.uniforms[`paintMask${i}`] = { value: l.material.mask };
        uniforms.push(`uniform sampler2D paintMask${i};`);
        // The mask's edge reaches into the height: the high parts first.
        cover = `clamp( ( texture2D( paintMask${i}, vPaintUv ).r - ( 1.0 - paintSurf${i}.b ) * ${MASK_HEIGHT_REACH.toFixed(3)} ) / ${(1 - MASK_HEIGHT_REACH).toFixed(3)}, 0.0, 1.0 )`;
      }
      colour.push(
        `vec4 paintSurf${i} = texture2D( paintSurface${i}, vPaintUv );`,
        `float paintCover${i} = ${cover};`,
        `diffuseColor.rgb = mix( diffuseColor.rgb, texture2D( paintLayer${i}, vPaintUv ).rgb, paintCover${i} );`,
      );
      surface.push(
        `roughnessFactor = mix( roughnessFactor, paintSurf${i}.r, paintCover${i} );`,
        `metalnessFactor = mix( metalnessFactor, paintSurf${i}.g, paintCover${i} );`,
      );
      // Green flipped: the frame's B runs along the glTF v, which is
      // Blender's upside down (as GLTFLoader flips normalScale.y for a
      // normal map read through derivative tangents).
      normal.push(
        `{ vec3 t = texture2D( paintNormal${i}, vPaintUv ).xyz * 2.0 - 1.0; t.y = -t.y;`,
        `  vec3 n = normalize( paintTangentFrame( - vViewPosition, nonPerturbedNormal, vPaintUv ) * t );`,
        `  normal = normalize( mix( normal, n, paintCover${i} ) ); }`,
      );
    });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aPaintUv;\nvarying vec2 vPaintUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPaintUv = aPaintUv;");
    let fragment = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${uniforms.join("\n")}\nvarying vec2 vPaintUv;${normal.length ? TANGENT_FRAME : ""}`)
      .replace("#include <alphamap_fragment>", `${colour.join("\n")}\n#include <alphamap_fragment>`);
    if (surface.length) {
      fragment = fragment
        .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>\n${surface.join("\n")}`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n${normal.join("\n")}`);
    }
    shader.fragmentShader = fragment;
  };
  m.customProgramCacheKey = () => `${ownKey}|paint-layers-${signature}`;
  return m;
}

const LAYERS = "paintLayers";
// How much of a layer a click must land on to pick it rather than its rock.
const PICK_COVERAGE = 0.3;
// A map read back for picking: its texels, `stride` bytes each.
interface Readback {
  w: number;
  h: number;
  px: ArrayLike<number>;
  stride: number;
}
const readbacks = new WeakMap<THREE.Texture, Readback | null>();

// The pick tag of the topmost layer a material wears that covers `uv` (a ray
// hit's, in the paint UV), or undefined: a texture layer has no mesh of its
// own, so this is how a click on the moss picks the moss. The maps are read
// back once each, on the first pick that needs them.
export function paintLayerAt(material: THREE.Material | THREE.Material[], uv: THREE.Vector2 | undefined): unknown {
  if (!uv || Array.isArray(material)) return undefined;
  const layers = material.userData[LAYERS] as PaintLayer[] | undefined;
  for (const l of [...(layers ?? [])].reverse()) {
    // A material layer covers by its mask's red, or everywhere without one.
    if (l.material && !l.material.mask) return l.tag;
    const map = l.material?.mask ?? l.texture;
    const px = readback(map);
    if (!px) continue;
    const x = Math.min(px.w - 1, Math.max(0, Math.floor(uv.x * px.w)));
    const y = Math.min(px.h - 1, Math.max(0, Math.floor(uv.y * px.h)));
    const channel = l.material ? 0 : 3;
    if (px.px[(y * px.w + x) * px.stride + Math.min(channel, px.stride - 1)]! >= PICK_COVERAGE * 255) return l.tag;
  }
  return undefined;
}

// A map's texels: a texture made from data (the editor's live mask,
// src/editor/materialMasks.ts) as it holds them now, an image read back once.
function readback(t: THREE.Texture): Readback | null {
  const data = (t as THREE.DataTexture).isDataTexture ? (t.image as { data: Uint8Array; width: number; height: number }) : null;
  if (data?.data) return { w: data.width, h: data.height, px: data.data, stride: data.data.length / (data.width * data.height) };
  if (readbacks.has(t)) return readbacks.get(t)!;
  const image = t.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image?.width) return null; // not landed yet: asked again next time
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  // The image's first row is the map's v = 0 (no flip, as it is drawn).
  const got = { w: image.width, h: image.height, px: ctx.getImageData(0, 0, image.width, image.height).data, stride: 4 };
  readbacks.set(t, got);
  return got;
}
