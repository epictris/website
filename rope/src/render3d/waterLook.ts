// What every body of water shares (see docs/water.md, "Drawing a body of
// water"): the clock, the palette and scale of Tris's cave studies, the wave
// spectrum both the pool and the current read their ripples from, and the
// impact field a fall draws on the water it lands in.
//
// Both studies are one world: "A quiet cave pool" (cave-pool-water-v2.html,
// ported in stillWater.ts) and "Flowing water v14" (cave-river-waterfall-v14
// .html, ported in water.ts), whose river and cascade were rewritten in the
// pool's own formulation so the three read as the same water. They share the
// palette, the spectrum and the scale here for the same reason.

import * as THREE from "three";

export const fmt = (n: number): string => n.toFixed(4);

// Wall-clock seconds, shared by every water material so two bodies of water in
// one level can never drift apart. Written once per frame by `Scene3D`, from
// the same clock (pinnable) the light flicker reads.
export const waterTime = { value: 0 };

// Game metres per study metre. The pool study's world is a 75 m lake seen from
// 35 m and the BALL pool is 6.4 m across, framed ~0.18 as large - but at 0.18
// the ripples were hairlines, because the game sees its water far more edge-on
// (see DEPTH_STRETCH); 0.5 gives bands the size of the study's on screen. The
// river study shares the pool's world, so it shares the scale. The studies'
// speeds are in their own units, so they scale with them.
export const STUDY_SCALE = 0.5;
// The game looks at its water far more edge-on than the studies' cameras did
// (the BALL pool's 12 m of depth is ~200 px of a 1080 px frame), so a pattern
// round in plan is crushed into hairlines on screen. Stretched this much
// along the depth (world z), its ripples read as the studies' broad bands.
export const DEPTH_STRETCH = 2.5;
// How far below the waterline the light gets down a front sheet, metres: the
// surface weight (1 at the waterline) falls to 0 here.
export const LIGHT_FALLOFF = 0.5;

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

// The studies' three colours. A water body's authored colour stands in for the
// shallow one, and the deep and the light are moved from it in HSL by whatever
// separates them from the shallow in the study, so an authored pool keeps its
// own colour and BALL's (#1e7382) lands near the study. Water with no authored
// colour is the study's own.
const STUDY_SHALLOW = "#178b96";
const STUDY_DEEP = "#13506b";
const STUDY_LIGHT = "#55bec7";

export interface StudyPalette {
  deep: THREE.Color;
  shallow: THREE.Color;
  light: THREE.Color;
}

// `c` moved in HSL (in sRGB: HSL is a statement about the colour as authored,
// the hex a level types) by what separates `to` from `from`: hue turned by the
// difference, saturation and lightness scaled by the ratio.
function relative(c: THREE.Color, from: string, to: string): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  const a = { h: 0, s: 0, l: 0 };
  const b = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  new THREE.Color(from).getHSL(a, THREE.SRGBColorSpace);
  new THREE.Color(to).getHSL(b, THREE.SRGBColorSpace);
  return new THREE.Color().setHSL(
    (hsl.h + b.h - a.h + 1) % 1,
    Math.min(1, (hsl.s * b.s) / a.s),
    Math.min(1, (hsl.l * b.l) / a.l),
    THREE.SRGBColorSpace,
  );
}

export function studyPalette(color: string | undefined): StudyPalette {
  const shallow = new THREE.Color(color ?? STUDY_SHALLOW);
  return {
    deep: relative(shallow, STUDY_SHALLOW, STUDY_DEEP),
    shallow,
    light: relative(shallow, STUDY_SHALLOW, STUDY_LIGHT),
  };
}

// ---------------------------------------------------------------------------
// The wave spectrum
// ---------------------------------------------------------------------------

// The texture the ripples are read from, generated here rather than stored
// (the pool study's `createSurfaceTextureData`, number for number): a sum of
// twelve plane waves on whole-number wave vectors, so it tiles. R and G are the
// two slopes, B the height, A a soft value noise; data, not colour.
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x ^ seed, 374761393) ^ Math.imul(y + seed, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function tileNoise(u: number, v: number, n: number, seed: number): number {
  const mod = (x: number): number => ((x % n) + n) % n;
  const x = u * n;
  const y = v * n;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash2(mod(ix), mod(iy), seed);
  const b = hash2(mod(ix + 1), mod(iy), seed);
  const c = hash2(mod(ix), mod(iy + 1), seed);
  const d = hash2(mod(ix + 1), mod(iy + 1), seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

const SURFACE_MAP_SIZE = 256;
const SURFACE_MODES: readonly (readonly [number, number, number])[] = [
  [2, 5, 0.2], [-3, 7, 0.16], [1, 9, 0.13], [4, 3, 0.12], [-2, 13, 0.095],
  [5, 11, 0.075], [-4, 17, 0.055], [8, 6, 0.05], [1, 21, 0.035],
  [7, 19, 0.03], [-9, 11, 0.03], [11, 23, 0.018],
];

let surfaceMap: THREE.DataTexture | null = null;

export function waterSurfaceMap(): THREE.DataTexture {
  if (surfaceMap) return surfaceMap;
  const size = SURFACE_MAP_SIZE;
  const data = new Uint8Array(size * size * 4);
  const terms = SURFACE_MODES.map(([x, y, w], i) => ({
    x,
    y,
    w,
    phi: hash2(i, 17, 819) * Math.PI * 2,
    dx: x / Math.hypot(x, y),
    dy: y / Math.hypot(x, y),
  }));
  const total = SURFACE_MODES.reduce((s, m) => s + m[2], 0);
  const byte = (v: number): number => Math.round(255 * Math.max(0, Math.min(1, v)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let dx = 0;
      let dy = 0;
      let h = 0;
      for (const m of terms) {
        const phase = Math.PI * 2 * (m.x * u + m.y * v) + m.phi;
        const c = Math.cos(phase) * m.w;
        dx += c * m.dx;
        dy += c * m.dy;
        h += Math.sin(phase) * m.w;
      }
      const i = (y * size + x) * 4;
      data[i] = byte(0.5 + (dx / total) * 0.9);
      data[i + 1] = byte(0.5 + (dy / total) * 0.9);
      data[i + 2] = byte(0.5 + (h / total) * 0.75);
      data[i + 3] = byte(tileNoise(u, v, 8, 109) * 0.6 + tileNoise(u, v, 16, 41) * 0.4);
    }
  }
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  surfaceMap = map;
  return map;
}

// ---------------------------------------------------------------------------
// The impact field
// ---------------------------------------------------------------------------

// Where a fall lands, the water it lands in draws the impact field: the foam
// lying flat on it, whole at the plunge and breaking into rings that drift
// out and thin, the water milky round it with the bubble cloud under it, a
// heave where the foam is thick and ripples running out. A capsule along z,
// the width of the sheet, in boil units; never stretched along the depth, so
// it meets the sheet's own edges. Module-wide like the wake's rings: every
// surface material reads the one table and draws the impacts that lie in its
// own plane.
export const IMPACT_SLOTS = 4;
// The boil's length l in boil units: how far its foam reaches (water.ts, THE
// LANDING'S SCALE, sets the unit from the fall's own physics).
export const BOIL_REACH = 1.16;
// The foam lies flat on the water, after Tris's reference (2026-10-06, a
// stylised plunge: one pale tone, whole at the plunge and breaking into
// broken rings that drift out and thin). It reaches the boil's length, is
// carried out at FOAM_OUTFLOW boil units per tick of the boil's clock, and is
// shed in rings FOAM_RING_SPACING apart (the study's ring arcs' numbers).
const FOAM_REACH = BOIL_REACH;
const FOAM_OUTFLOW = 0.84;
const FOAM_RING_SPACING = 1.1;
// The foam's tone: the water's light tone toward white by this much, so it
// sits in the water's own palette (the reference's foam is a pale cyan, not
// white). In GLSL `foamTone(light)` (IMPACT_GLSL), shared with the ball's
// wake (stillWater.ts).
const FOAM_WHITEN = 0.45;
// How far the field reaches (boil units); what it lays on the water fades to
// nothing from IMPACT_FADE on, so it has no edge of its own. HEAVE_HEIGHT is
// the boil's heave where the foam is thick. No rings of ripple run out from
// the landing: tried as the ball's wake draws them (slope bumps, then made
// irregular) and removed - they did not fit the look (Tris, 2026-10-06).
const IMPACT_REACH = 4.1;
const IMPACT_FADE = 2.6;
const HEAVE_HEIGHT = 0.08;
export function foamColor(light: THREE.Color): THREE.Color {
  return light.clone().lerp(new THREE.Color(1, 1, 1), FOAM_WHITEN);
}
// How far off an impact's plane a pixel may be and still draw it, metres: the
// surface the fall lands in, never the one it leaves (a fall drops further).
export const IMPACT_PLANE = 0.15;
// x, y, z (three's frame, world) and amount (0 = idle); the sheet's half
// width (boil units), the direction it travels along world x, metres per boil
// unit and the boil's clock rate (water.ts, BOIL_REACH).
export const impactAt = { value: Array.from({ length: IMPACT_SLOTS }, () => new THREE.Vector4()) };
export const impactHow = { value: Array.from({ length: IMPACT_SLOTS }, () => new THREE.Vector4()) };
// How far upstream the sheet's edges strike the water of its middle, boil
// units (the sheet bows: its edges leave the lip slower, water.ts EDGE_LAG):
// the boil follows the line the sheet actually strikes along.
export const impactBend = { value: Array.from({ length: IMPACT_SLOTS }, () => 0) };
const impactTaken: boolean[] = Array.from({ length: IMPACT_SLOTS }, () => false);

// A slot for one fall's impact, or -1 when every slot is taken (that fall's
// landing then draws its plumes but no foam).
export function takeImpactSlot(): number {
  const i = impactTaken.indexOf(false);
  if (i >= 0) impactTaken[i] = true;
  return i;
}

export function freeImpactSlot(i: number): void {
  if (i < 0) return;
  impactTaken[i] = false;
  impactAt.value[i]!.set(0, 0, 0, 0);
}

// The study's soft noise, shared by the impact field and the plumes.
export const ORGANIC_GLSL = `
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float softNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + 1.0), f.x), f.y);
  }
  float paintNoise(vec2 p) { return softNoise(p) * 0.72 + softNoise(p * 2.07 + 9.7) * 0.28; }
`;

// The field, for a surface material (needs `uTime`). `impactSlope` is the
// tilt the rings and the boil give the surface (dimensionless, so the same in
// either unit); `impactPaint` lays the foam and the milky water under it over
// a colour. `d` is boil units from the impact, x along the sheet's travel;
// the sheet travels toward -x.
export const IMPACT_GLSL = `
  ${ORGANIC_GLSL}
  uniform vec4 uImpactAt[${IMPACT_SLOTS}];
  uniform vec4 uImpactHow[${IMPACT_SLOTS}];
  uniform float uImpactBend[${IMPACT_SLOTS}];
  // From the line the sheet strikes along, the whole of its width, so the
  // boil wraps round the sheet's sides. (Its straight part once stopped at
  // 0.82 of the half width, the study's sheet's, which on a wide sheet left
  // its edges falling into clear water.)
  float impactDistance(vec2 d, float hw) {
    return length(vec2(d.x, max(abs(d.y) - hw, 0.0)));
  }
  // How much foam is on the water (0 to 1): the bubbles the sheet drove down
  // surfacing as the outflow carries them off, whole along the line the sheet
  // strikes and dying away over the boil's length.
  float impactFoamAmount(float dist) { return exp(-dist / ${fmt(FOAM_REACH)}); }
  // The field's own fade (see IMPACT_REACH).
  float impactFade(float dist) { return 1.0 - smoothstep(${fmt(IMPACT_FADE)}, ${fmt(IMPACT_REACH)}, dist); }
  // Where round the ring a point is (boil units): the line the sheet strikes,
  // unrolled round its ends, so the foam's patches lie along the rings. (Its
  // two ends meet behind the sheet, against the wall it falls from.)
  float impactAlong(vec2 d, float hw, float dist) {
    float beyond = max(abs(d.y) - hw, 0.0);
    return sign(d.y) * (min(abs(d.y), hw) + atan(beyond, -d.x) * dist);
  }
  // The foam's patches: carried outward at FOAM_OUTFLOW, drawn out along the
  // rings, and banded every FOAM_RING_SPACING as the plunge sheds them. Foam
  // covers the pattern wherever it is under the amount, so it is whole where
  // the amount is and breaks into thinning arcs as the amount dies away.
  float impactFoamPattern(vec2 d, float hw, float dist, float t) {
    float s = dist - t * ${fmt(FOAM_OUTFLOW)};
    float n = paintNoise(vec2(impactAlong(d, hw, dist) * 1.4 + t * 0.15, s * 5.0));
    float bands = 0.5 - 0.5 * cos(6.2831853 * s / ${fmt(FOAM_RING_SPACING)});
    return 0.55 * n + 0.45 * bands;
  }
  // The surface heaves a few centimetres where the foam is thick.
  float impactHeight(vec2 d, float hw, float t) {
    float r = impactDistance(d, hw);
    if (r > ${fmt(IMPACT_REACH)}) return 0.0;
    return ${fmt(HEAVE_HEIGHT)} * impactFoamAmount(r) * impactFade(r) * paintNoise(vec2(d.y * 2.4 + t * 0.72, d.x * 2.8 - t * 0.9));
  }
  // Boil units from impact i, x turned so the sheet travels toward -x; or
  // a long way off when the slot is idle or out of this plane.
  vec2 impactOffset(int i, vec3 world) {
    vec4 at = uImpactAt[i];
    if (at.w <= 0.0 || abs(world.y - at.y) > ${fmt(IMPACT_PLANE)}) return vec2(1e3);
    vec2 d = (world.xz - at.xz) / uImpactHow[i].z;
    d.x *= -uImpactHow[i].y;
    // Measured from where the sheet strikes at this point across it.
    float across = clamp(d.y / max(uImpactHow[i].x, 1e-3), -1.0, 1.0);
    d.x -= uImpactBend[i] * across * across;
    return d;
  }
  vec2 impactSlope(vec3 world) {
    vec2 slope = vec2(0.0);
    for (int i = 0; i < ${IMPACT_SLOTS}; i++) {
      vec2 d = impactOffset(i, world);
      float hw = uImpactHow[i].x;
      if (impactDistance(d, hw) > ${fmt(IMPACT_REACH)}) continue;
      float t = uTime * uImpactHow[i].w;
      float h = impactHeight(d, hw, t);
      vec2 g = vec2(impactHeight(d + vec2(0.015, 0.0), hw, t) - h, impactHeight(d + vec2(0.0, 0.015), hw, t) - h) / 0.015;
      // Back into the world's x.
      slope += vec2(-uImpactHow[i].y * g.x, g.y);
    }
    return slope;
  }
  // Under 0 where there is foam.
  float impactCover(vec2 d, float hw, float t) {
    float dist = impactDistance(d, hw);
    return impactFoamPattern(d, hw, dist, t) - impactFoamAmount(dist) * impactFade(dist);
  }
  // How far a pixel spans across the water, metres: the world's x and z
  // across the screen's x (xy) and y (zw). Taken by the caller in uniform
  // control flow, since the paint is drawn per pixel only where an impact is
  // near.
  vec4 impactPixel(vec3 world) { return vec4(dFdx(world.xz), dFdy(world.xz)); }
  // The foam's flat tone (see FOAM_WHITEN).
  vec3 foamTone(vec3 light) { return mix(light, vec3(1.0), ${fmt(FOAM_WHITEN)}); }
  vec3 impactPaint(vec3 world, vec3 col, vec3 base, vec3 light, vec4 pixel) {
    for (int i = 0; i < ${IMPACT_SLOTS}; i++) {
      vec2 d = impactOffset(i, world);
      float hw = uImpactHow[i].x;
      float dist = impactDistance(d, hw);
      if (dist > ${fmt(IMPACT_REACH)}) continue;
      float t = uTime * uImpactHow[i].w;
      vec3 foam = foamTone(light);
      // The water itself milky with the bubble cloud under it, out to twice
      // the foam's reach; this also keeps the mirror from lighting a white
      // halo round the landing.
      col = mix(col, mix(base, foam, 0.35), impactFoamAmount(0.5 * dist) * impactFade(dist) * 0.75);
      // The foam, one flat tone cut to the pixel: a clean edge, never a mist.
      // The edge is as wide as the cover changes across the pixel, from its
      // slope in boil units turned back into the world's x and z (seen
      // edge-on, the water is far wider per pixel in depth than across).
      float cover = impactCover(d, hw, t);
      vec2 g = vec2(impactCover(d + vec2(0.01, 0.0), hw, t) - cover, impactCover(d + vec2(0.0, 0.01), hw, t) - cover) / 0.01;
      vec2 gw = vec2(-uImpactHow[i].y * g.x, g.y) / uImpactHow[i].z;
      float aa = max(0.5 * (abs(dot(gw, pixel.xy)) + abs(dot(gw, pixel.zw))), 1e-4);
      col = mix(col, foam, 1.0 - smoothstep(-aa, aa, cover));
    }
    return col;
  }
`;

export const impactUniforms = { uImpactAt: impactAt, uImpactHow: impactHow, uImpactBend: impactBend };
