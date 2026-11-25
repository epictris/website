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
// it is final, before anything shades it; nothing else of the rock changes.

import * as THREE from "three";

// The layers one rock draws at most: one sampler each.
export const MAX_PAINT_LAYERS = 4;

const loader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();

// A layer's map, loaded once a page: sRGB colour and straight coverage in
// alpha, laid out as glTF lays its UVs (no flip).
export function paintLayerTexture(url: string): THREE.Texture {
  let t = textures.get(url);
  if (!t) {
    t = loader.load(url);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    textures.set(url, t);
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

// One layer a rock wears: its map, and what a click on it picks (the
// decoration's pick tag, `pickTagOf`).
export interface PaintLayer {
  texture: THREE.Texture;
  tag: unknown;
}

// A copy of a rock material with `layers` mixed over its colour, in order,
// each by its coverage. The material's own patch (the slate's) runs first;
// the layers go in once the colour is final (before the alpha map, which
// every lit material includes after its colour). The layers are kept on the
// copy (`paintLayerAt`).
export function layered(material: THREE.Material, layers: readonly PaintLayer[]): THREE.Material {
  const n = Math.min(layers.length, MAX_PAINT_LAYERS);
  const m = material.clone();
  const own = material.onBeforeCompile.bind(material);
  const ownKey = material.customProgramCacheKey();
  const kept = layers.slice(0, n);
  const maps = kept.map((l) => l.texture);
  m.userData[LAYERS] = kept;
  m.onBeforeCompile = (shader, renderer) => {
    own(shader, renderer);
    shader.uniforms["paintLayers"] = { value: maps };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aPaintUv;\nvarying vec2 vPaintUv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPaintUv = aPaintUv;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform sampler2D paintLayers[ ${n} ];\nvarying vec2 vPaintUv;`)
      .replace(
        "#include <alphamap_fragment>",
        // Unrolled by three: a sampler array is indexed by constants only.
        `#pragma unroll_loop_start
for ( int i = 0; i < ${n}; i ++ ) {
  vec4 paintLayer = texture2D( paintLayers[ i ], vPaintUv );
  diffuseColor.rgb = mix( diffuseColor.rgb, paintLayer.rgb, paintLayer.a );
}
#pragma unroll_loop_end
#include <alphamap_fragment>`,
      );
  };
  m.customProgramCacheKey = () => `${ownKey}|paint-layers-${n}`;
  return m;
}

const LAYERS = "paintLayers";
// How much of a layer a click must land on to pick it rather than its rock.
const PICK_COVERAGE = 0.3;
const alphas = new WeakMap<THREE.Texture, { w: number; h: number; a: Uint8ClampedArray } | null>();

// The pick tag of the topmost layer a material wears that covers `uv` (a ray
// hit's, in the paint UV), or undefined: a texture layer has no mesh of its
// own, so this is how a click on the moss picks the moss. The maps are read
// back once each, on the first pick that needs them.
export function paintLayerAt(material: THREE.Material | THREE.Material[], uv: THREE.Vector2 | undefined): unknown {
  if (!uv || Array.isArray(material)) return undefined;
  const layers = material.userData[LAYERS] as PaintLayer[] | undefined;
  for (const l of [...(layers ?? [])].reverse()) {
    const px = coverageOf(l.texture);
    if (!px) continue;
    const x = Math.min(px.w - 1, Math.max(0, Math.floor(uv.x * px.w)));
    const y = Math.min(px.h - 1, Math.max(0, Math.floor(uv.y * px.h)));
    if (px.a[(y * px.w + x) * 4 + 3]! >= PICK_COVERAGE * 255) return l.tag;
  }
  return undefined;
}

function coverageOf(t: THREE.Texture): { w: number; h: number; a: Uint8ClampedArray } | null {
  if (alphas.has(t)) return alphas.get(t)!;
  const image = t.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!image?.width) return null; // not landed yet: asked again next time
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, 0, 0);
  // The image's first row is the map's v = 0 (no flip, as it is drawn).
  const got = { w: image.width, h: image.height, a: ctx.getImageData(0, 0, image.width, image.height).data };
  alphas.set(t, got);
  return got;
}
