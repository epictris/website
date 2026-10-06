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

// Where a fall lands, the receiving water draws a small boiling core, a low
// broken foam apron carried downstream and scattered flecks beyond it, with
// the study's broken ripple arcs running out from the impact. The core is a
// capsule along z, the width of the sheet, in study metres; never stretched
// along the depth, so the footprint meets the crown (water.ts) and the sheet's own
// edges. Module-wide like the wake's rings: every surface material reads the
// one table and draws the impacts that lie in its own plane.
export const IMPACT_SLOTS = 4;
// How far off an impact's plane a pixel may be and still draw it, metres: the
// surface the fall lands in, never the one it leaves (a fall drops further).
export const IMPACT_PLANE = 0.15;
// x, y, z (three's frame, world) and amount (0 = idle); the sheet's half
// width (study metres) and the direction it travels along world x.
export const impactAt = { value: Array.from({ length: IMPACT_SLOTS }, () => new THREE.Vector4()) };
export const impactHow = { value: Array.from({ length: IMPACT_SLOTS }, () => new THREE.Vector4()) };
const impactTaken: boolean[] = Array.from({ length: IMPACT_SLOTS }, () => false);

// A slot for one fall's impact, or -1 when every slot is taken (that fall's
// landing then draws its crown and spray but no footprint).
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

// The study's soft noise, shared by the impact field and the crown.
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
// either unit); `impactPaint` lays the footprint and the arcs over a colour,
// pulling the water toward `base` near the landing so the mirror does not
// pull it into white halos. `d` is study metres from the impact, x along the
// sheet's travel; the study's sheet travels toward -x.
export const IMPACT_GLSL = `
  ${ORGANIC_GLSL}
  uniform vec4 uImpactAt[${IMPACT_SLOTS}];
  uniform vec4 uImpactHow[${IMPACT_SLOTS}];
  float impactDistance(vec2 d, float hw) {
    return length(vec2(d.x, max(abs(d.y) - hw * 0.82, 0.0)));
  }
  float impactEnvelope(vec2 d, float hw) {
    float r = impactDistance(d, hw);
    return smoothstep(0.45, 0.95, r) * (1.0 - smoothstep(2.5, 4.0, r)) * exp(-r * 0.28);
  }
  float impactPhase(vec2 d, float hw) {
    float r = impactDistance(d, hw), a = atan(d.y, d.x);
    return 6.2831853 * (r / 1.10 - uTime * 0.84 / 1.10) + 0.24 * sin(a * 6.0 - uTime * 0.65) + 0.16 * sin(a * 11.0 + uTime * 0.73);
  }
  float impactFootprint(vec2 d, float hw) {
    float r = impactDistance(vec2(d.x + 0.06 + 0.07 * sin(d.y * 2.8 - uTime * 1.7), d.y), hw);
    float edge = paintNoise(vec2(d.y * 3.8 - uTime * 0.9, d.x * 4.1 + uTime * 0.65));
    return 1.0 - smoothstep(0.22, 0.46, r + (edge - 0.5) * 0.19 + 0.04 * sin(d.y * 6.0 + uTime * 1.9));
  }
  // The sheet travels toward -x: foam moves away from the contact instead of
  // whitening an equally broad halo on both sides. The patch field travels
  // with it, opening teal gaps between connected foam islands.
  float impactApron(vec2 d, float hw) {
    float downstream = max(-d.x, 0.0);
    float edge = paintNoise(vec2(d.y * 3.2, d.x * 2.7 + uTime * 0.48));
    float across = max(abs(d.y + 0.07 * sin(d.x * 2.4 - uTime * 0.55)) - hw * 0.82, 0.0);
    float spread = 0.20 + 0.18 * smoothstep(0.0, 1.5, downstream);
    float width = 1.0 - smoothstep(spread * 0.55, spread + 0.22, across + (edge - 0.5) * 0.20);
    float reach = (1.0 - smoothstep(0.95, 1.85, downstream)) * (1.0 - smoothstep(0.12, 0.38, d.x));
    vec2 parcel = vec2(d.y * 4.2, (d.x + uTime * 0.48) * 5.1);
    float pigment = paintNoise(parcel) * 0.72 + softNoise(parcel * 2.4 + 7.3) * 0.28;
    float threshold = mix(0.32, 0.56, smoothstep(0.1, 1.6, downstream));
    float islands = smoothstep(threshold, threshold + 0.15, pigment);
    return width * reach * islands * (1.0 - smoothstep(0.3, 1.85, downstream) * 0.42);
  }
  float impactFlecks(vec2 d, float hw) {
    float downstream = -d.x;
    float across = max(abs(d.y) - hw * 0.82, 0.0);
    float envelope = smoothstep(0.45, 0.95, downstream) * (1.0 - smoothstep(1.8, 2.8, downstream))
      * (1.0 - smoothstep(0.3, 0.75, across));
    vec2 parcel = vec2(d.y * 9.0, (d.x + uTime * 0.48) * 8.4);
    float cells = softNoise(parcel + vec2(2.7, 13.1));
    float groups = paintNoise(parcel * 0.35 + 5.9);
    return smoothstep(0.72, 0.86, cells) * smoothstep(0.35, 0.62, groups) * envelope;
  }
  float impactHeight(vec2 d, float hw) {
    float r = impactDistance(d, hw);
    if (r > 4.1) return 0.0;
    float waves = 0.009 * sin(impactPhase(d, hw)) * impactEnvelope(d, hw);
    float boil = impactFootprint(d, hw) * (0.018 + 0.035 * paintNoise(vec2(d.y * 2.4 + uTime * 0.72, d.x * 2.8 - uTime * 0.9)));
    return waves + boil;
  }
  // Study metres from impact i, x turned so the sheet travels toward -x; or
  // a long way off when the slot is idle or out of this plane.
  vec2 impactOffset(int i, vec3 world) {
    vec4 at = uImpactAt[i];
    if (at.w <= 0.0 || abs(world.y - at.y) > ${fmt(IMPACT_PLANE)}) return vec2(1e3);
    vec2 d = (world.xz - at.xz) / ${fmt(STUDY_SCALE)};
    return vec2(-uImpactHow[i].y * d.x, d.y);
  }
  vec2 impactSlope(vec3 world) {
    vec2 slope = vec2(0.0);
    for (int i = 0; i < ${IMPACT_SLOTS}; i++) {
      vec2 d = impactOffset(i, world);
      float hw = uImpactHow[i].x;
      if (impactDistance(d, hw) > 4.1) continue;
      float h = impactHeight(d, hw);
      vec2 g = vec2(impactHeight(d + vec2(0.015, 0.0), hw) - h, impactHeight(d + vec2(0.0, 0.015), hw) - h) / 0.015;
      // Back into the world's x.
      slope += vec2(-uImpactHow[i].y * g.x, g.y);
    }
    return slope;
  }
  // How far a pixel spans, study metres, for the arcs' edges: the study's
  // fwidth of the distance to the impact, which changes by no more than the
  // pixel moves. Taken by the caller in uniform control flow, since the
  // paint is drawn per pixel only where an impact is near.
  float impactSpan(vec3 world) { return length(fwidth(world.xz)) / ${fmt(STUDY_SCALE)}; }
  vec3 impactPaint(vec3 world, vec3 col, vec3 base, vec3 light, float span) {
    for (int i = 0; i < ${IMPACT_SLOTS}; i++) {
      vec2 d = impactOffset(i, world);
      float hw = uImpactHow[i].x;
      float dist = impactDistance(d, hw);
      if (dist > 4.1) continue;
      float n = paintNoise(vec2(d.y * 3.8 - uTime * 0.9, d.x * 4.1 + uTime * 0.65));
      float core = impactFootprint(d, hw) * (0.78 + 0.16 * smoothstep(0.2, 0.66, n));
      float apron = impactApron(d, hw);
      float flecks = impactFlecks(d, hw);
      float phase = impactPhase(d, hw);
      float pd = abs(atan(sin(phase), cos(phase))) / 6.2831853 * 1.10;
      float aa = clamp(span, 0.003, 0.042);
      float group = floor((dist - uTime * 0.84) / 1.10 + 0.5);
      float branch = sin(d.y * 3.5 + d.x * 1.8 + group * 2.7) + 0.62 * sin(d.y * 7.3 - d.x * 3.0 - group * 1.3);
      float ridge = 1.0 - smoothstep(0.018 - aa * 0.35, 0.042 + aa, pd);
      float broken = smoothstep(0.03, 0.57, branch);
      float arc = ridge * broken * impactEnvelope(d, hw) * (1.0 - smoothstep(0.10, 0.9, d.x));
      col = mix(col, base, (1.0 - smoothstep(0.35, 1.8, dist)) * 0.32);
      vec3 white = vec3(0.88, 0.97, 0.99);
      vec3 mint = mix(light, white, 0.58);
      col = mix(col, mint, clamp(apron * 0.66 + flecks * 0.58, 0.0, 0.76));
      col = mix(col, white, clamp(core, 0.0, 0.94));
      col = mix(col, mix(white, light, smoothstep(0.8, 3.5, dist) * 0.80), clamp(arc * 0.65, 0.0, 0.68));
    }
    return col;
  }
`;

export const impactUniforms = { uImpactAt: impactAt, uImpactHow: impactHow };
