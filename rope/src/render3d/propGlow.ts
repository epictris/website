// A prop that glows in its own pattern: bioluminescent moss, whose bright tips
// give off light and whose hollows do not (docs/lighting-and-surfaces.md,
// "Glowing props").
//
// A mesh prop keeps the materials its file was exported with, so the geometry
// object's `emissive` and `emissiveIntensity` cannot go through `surfaceFor`
// the way a primitive's do. Instead every material of the loaded prop is
// swapped for a copy that emits the authored colour, masked by the LUMINANCE
// of the prop's own base colour map, stretched over that map's own range.
//
// Why not three's `emissiveMap = map`: that multiplies the glow by the albedo's
// colour, so moss glows the green it is painted rather than the colour the
// author chose, and its albedo spans so little (the moss set's 5th to 95th
// percentile is 0.12..0.23 linear luminance) that the pattern reads as a flat
// wash. The stretch is measured per map rather than written down per set, so a
// prop from any texture set glows with its full contrast.

import * as THREE from "three";

// The luminance percentiles the mask runs from dark to full. Not 0 and 100:
// the extremes of a baked map are its refilled seams and specks.
export const GLOW_MASK_LOW = 0.05;
export const GLOW_MASK_HIGH = 0.95;

// How much the darkest hollows still glow: bioluminescence is the whole mat,
// brightest on its tips, and a mask to zero reads as white paint on moss.
export const GLOW_FLOOR = 0.3;

// Mip levels coarser the mask is read at than the surface is drawn.
export const GLOW_MIP_BIAS = 2.5;

// The side of the thumbnail the range is measured on: the percentiles of a
// photographed surface are stable far below its resolution.
const SAMPLE = 64;

// A prop's glowing copies of its own materials, keyed by the source material
// and the glow. Cached rather than cloned per mount because the editor rebuilds
// its scene on every revision, and a mount frees geometry, never materials. The
// copies are never mutated after they are built, so sharing them is safe.
const glowing = new Map<string, THREE.Material>();

// Every material of a loaded prop swapped for its glowing copy.
export function glowProp(obj: THREE.Object3D, color: string, intensity: number): void {
  const copyOf = (m: THREE.Material): THREE.Material => {
    const std = m as THREE.MeshStandardMaterial;
    if (!std.isMeshStandardMaterial) return m;
    const key = `${m.uuid}|${color}|${intensity}`;
    let copy = glowing.get(key);
    if (!copy) {
      copy = glowingCopy(std, color, intensity);
      glowing.set(key, copy);
    }
    return copy;
  };
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copyOf) : copyOf(mesh.material);
  });
}

function glowingCopy(
  src: THREE.MeshStandardMaterial,
  color: string,
  intensity: number,
): THREE.MeshStandardMaterial {
  const copy = src.clone();
  copy.emissive = new THREE.Color(color);
  copy.emissiveIntensity = intensity;
  // With no map there is no pattern to follow, and the prop glows flat.
  if (!src.map) return copy;
  const range = luminanceRange(src.map.image as CanvasImageSource | undefined);
  if (!range) return copy;
  copy.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowRange = { value: new THREE.Vector2(range[0], range[1]) };
    shader.fragmentShader = patchGlow(shader.fragmentShader);
  };
  copy.customProgramCacheKey = () => "prop-glow";
  return copy;
}

// The emission masked by the base map's stretched luminance, read GLOW_MIP_BIAS
// mip levels coarser than the surface is drawn: at the map's own detail the
// mask is single-texel speckle, and moss glows in clumps. The texel is sRGB
// decoded by three's sampler, the same as the albedo it is measured against.
export function patchGlow(fragment: string): string {
  const chunk = "#include <emissivemap_fragment>";
  if (!fragment.includes(chunk)) throw new Error("propGlow: three's emissivemap_fragment is gone");
  return fragment
    .replace("void main() {", "uniform vec2 uGlowRange;\nvoid main() {")
    .replace(
      chunk,
      `${chunk}
	vec3 glowTexel = texture2D( map, vMapUv, ${GLOW_MIP_BIAS.toFixed(1)} ).rgb;
	float glowLum = dot( glowTexel, vec3( 0.2126, 0.7152, 0.0722 ) );
	totalEmissiveRadiance *= mix( ${GLOW_FLOOR.toFixed(2)}, 1.0, smoothstep( uGlowRange.x, uGlowRange.y, glowLum ) );`,
    );
}

// The GLOW_MASK_LOW and GLOW_MASK_HIGH percentiles of an sRGB image's linear
// luminance, or null when the image cannot be read (not decoded yet, or no DOM).
function luminanceRange(image: CanvasImageSource | undefined): [number, number] | null {
  if (!image || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
  const px = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  const lum: number[] = [];
  for (let i = 0; i < px.length; i += 4) {
    lum.push(0.2126 * linear(px[i]!) + 0.7152 * linear(px[i + 1]!) + 0.0722 * linear(px[i + 2]!));
  }
  return stretch(lum);
}

// The mask's range over a set of luminances: the two percentiles, held apart
// so a uniform map does not divide by nothing.
export function stretch(lum: number[]): [number, number] {
  const sorted = [...lum].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const lo = at(GLOW_MASK_LOW);
  return [lo, Math.max(at(GLOW_MASK_HIGH), lo + 1e-3)];
}

function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
