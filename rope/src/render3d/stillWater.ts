// Still water: a pool with no current (see docs/water.md, "Still water"), the
// splash the ball throws up when it falls in, and the wake it leaves moving
// through.
//
// THE SURFACE (`stillWaterMaterial`) is Tris's cave-pool study of 2026-10-05
// ported: continuous rippling normals driving soft turquoise light bands and
// a mirror of the scene (planarReflection.ts) that bends with them, deep blue
// at the back of the pool to shallow teal at the front. (A caustic net after
// his Blender reference files came first, then a calm-lake painting of
// wavelet dashes; both were replaced, and the net's star glints were rejected
// outright.) A current (water.ts) is the companion river study, written in
// this same formulation; where a fall lands in a pool, the pool draws its
// impact field (waterLook.ts).
//
// THE WAKE is foam the ball leaves churning through the water, drawn by the
// surface shader as a fall's foam is (waterLook.ts): solid at the ball,
// breaking into torn patches behind it in one flat tone, the water milky
// under it.
//
// THE SPLASH (`WaterSplashes`) is the reference's splash, staged once rather
// than looped under a waterfall: a cel-shaded crown that rises, flares and
// tears into holes; a lace ring of foam spreading over the surface and
// breaking into flecks at its rim; and droplets thrown up and out, some solid,
// some hollow rings. It never touches the sim - it reads where the ball is
// drawn and how fast it is moving, as the lights do, and every particle is a
// pure function of the clock and the splash's own start, so a pinned clock
// draws the same splash twice.

import * as THREE from "three";
import { WaterArea } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import { reflectionUniforms } from "./planarReflection";
import { POINT_VIEW_HALF_HEIGHT, threeY } from "./space";
import {
  DEPTH_STRETCH,
  fmt,
  IMPACT_GLSL,
  impactUniforms,
  LIGHT_FALLOFF,
  STUDY_SCALE,
  studyPalette,
  waterSurfaceMap,
  waterTime,
} from "./waterLook";

// ---------------------------------------------------------------------------
// Shared GLSL: hashing and value noise, for the splash
// ---------------------------------------------------------------------------

const NOISE_GLSL = `
  // PCG-style integer hash: well distributed, no sin(), the same on every GPU.
  uvec3 swPcg3(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }
  vec3 swHash3(vec3 p) {
    return vec3(swPcg3(uvec3(ivec3(floor(p)) + 32768))) / 4294967295.0;
  }
`;

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

// THE LOOK is Tris's cave-pool study of 2026-10-05 (cave-pool-water-v2.html,
// "A quiet cave pool", with his exported settings), ported shader for shader:
// continuous wave normals rather than any cellular pattern - three layers of a
// band-limited wave spectrum drifting against each other plus three long sine
// waves - and the SAME slopes drive everything drawn on the water:
// - broad soft turquoise light bands where the ripples face the light, a
//   slight shade where they face away, and a brighter crest on the steepest;
// - the scene mirrored in the surface (planarReflection.ts), pushed about by
//   the slopes so a reflected rock edge bends and breaks as the ripples pass,
//   strong where what it mirrors is near and faint for the far cave, which is
//   what keeps the water teal rather than a dark mirror;
// - a Fresnel term, so the mirror strengthens toward grazing;
// - deep blue at the back of the pool turning to shallow teal at its front.
// The water is unlit and not tone mapped: its colours are the study's own, and
// the reflection is the frame as the player sees it. The study's shoreline
// glints (a field built from the rocks' waterline outlines) are not ported.
//
// Before this (the same day) the pool was a calm-lake painting - a grazing-
// angle colour ramp under flat light and dark wavelet dashes - and before that
// a caustic net after Tris's Blender files, whose star glints were rejected
// ("they look bad").

// Tris's settings (cave-pool-v2-settings.json): the pattern's size (study
// metres, at STUDY_SCALE; stretched DEPTH_STRETCH along the depth, see
// waterLook.ts), "painterly light", "ripple strength", the clock's rate, the
// reflection's strength and how far the ripples push it about.
const PATCH_SIZE = 0.82 * STUDY_SCALE;
const CONTRAST = 0.6;
const RIPPLE_STRENGTH = 1.01;
const SPEED = 1;
const REFLECTION = 0.61;
const DISTORTION = 0.51;
// The long sine waves' amplitude, in the pattern's units (a slope, so it does
// not scale). They only tilt the normals: the study also displaced its mesh
// by them, by 4 mm at this scale, which no pixel shows and the slab's 1.2 m
// rows could not carry anyway.
const WAVE_HEIGHT = 0.022;
// How the mirror's strength follows what it mirrors: full for what stands
// within NEAR metres of the water, the study's faint reflection of its open
// background past FAR (study: rocks reflected, the far cave wall left out).
const REFLECT_NEAR = 1.5;
const REFLECT_FAR = 6;
// The study's deep-to-shallow ramp was over its world z; here it is over the
// slab's own depth, back (0) to front (1), the same stretch of it that the
// study showed: deep at the back wall, ~0.8 at the near edge of the frame.
const SHALLOW_RAMP = [0.16, 1.21] as const;
// The front sheet, looking into the water: how far from the shallow colour to
// the deep one it starts at the waterline, and the deep colour's brightness at
// the bed. Unlit and unfogged, a front as bright as the surface read as a
// block of teal glass.
const FRONT_TOP_DEEP = 0.5;
const FRONT_BED = 0.7;
const RIM_WIDTH = 0.008;
const RIM_SOFT = 0.016;
const WATERLINE_W = 0.5;

// The slab's opacity: the top is opaque (see the material), the front sheet
// murky glass so a submerged ball stays a visible silhouette (an opaque front
// is better water and worse gameplay).
const ALPHA_FRONT_TOP = 0.94;
const ALPHA_FRONT_BED = 0.8;
// The front sheet, and everything that meets it, sits this far behind the
// slab's nominal front. A bank authored to the same depth as the water has
// its face exactly there too, and two coplanar faces z-fight: the water won
// on some builds and the bank on others. Behind by a hair, the bank wins,
// which is what a pool sunk into rock means.
export const FRONT_INSET = 0.002;
// Rows down the front sheet and its end caps: the light and the opacity are
// interpolated down them.
const FRONT_ROWS = 6;

// ---------------------------------------------------------------------------
// The slab
// ---------------------------------------------------------------------------

// A pool's geometry, in the body's local frame (three's y-up, +z toward the
// camera): the top face at the waterline from the back of the slab to its
// front, the front sheet hanging from its front edge to the bed, and a cap at
// each end. The surface is never displaced (its ripples are normals), so the
// faces are flat grids only as fine as their light gradient needs.
// Attributes beyond position and normal:
//   aLit   - how far the light gets: 1 at the waterline, 0 LIGHT_FALLOFF
//            below it; read back as the depth under the waterline
//   aAlpha - opacity
//   aUp    - 1 on the top face, 0 on the front sheet and the caps
export function poolGeometry(halfX: number, halfY: number, frontZ: number, backZ: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const lit: number[] = [];
  const alpha: number[] = [];
  const up: number[] = [];
  const index: number[] = [];
  frontZ -= FRONT_INSET;
  const depth = halfY * 2;
  const frontLit = (t: number): number => Math.max(0, 1 - (t * depth) / LIGHT_FALLOFF);
  const frontAlpha = (t: number): number => ALPHA_FRONT_TOP + (ALPHA_FRONT_BED - ALPHA_FRONT_TOP) * t;
  // A grid of (rows + 1) x (cols + 1) vertices from `at(r, c)`, wound so its
  // face points along `n`.
  const grid = (
    rows: number,
    cols: number,
    at: (t: number, u: number) => [number, number, number],
    n: [number, number, number],
    face: (t: number) => [number, number, number],
  ): void => {
    const base = pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        pos.push(...at(r / rows, c / cols));
        nor.push(...n);
        const [l, a, u] = face(r / rows);
        lit.push(l);
        alpha.push(a);
        up.push(u);
      }
    }
    const stride = cols + 1;
    const p = (i: number): THREE.Vector3 => new THREE.Vector3(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
    const flip = p(base + stride).sub(p(base)).cross(p(base + 1).sub(p(base))).dot(new THREE.Vector3(...n)) < 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = base + r * stride + c;
        const d = a + stride;
        if (flip) index.push(a, a + 1, d, a + 1, d + 1, d);
        else index.push(a, d, a + 1, a + 1, d, d + 1);
      }
    }
  };
  const cols = Math.max(2, Math.ceil(halfX * 2));
  const x = (u: number): number => -halfX + u * halfX * 2;
  // The top: the back of the slab (t 0) to its front.
  grid(1, cols, (t, u) => [x(u), halfY, backZ + (frontZ - backZ) * t], [0, 1, 0], () => [1, 1, 1]);
  // The front sheet, waterline (t 0) to bed; its top row is the top face's
  // front row.
  grid(FRONT_ROWS, cols, (t, u) => [x(u), halfY - depth * t, frontZ], [0, 0, 1], (t) => [frontLit(t), frontAlpha(t), 0]);
  // The caps, so the slab is not an open box from any view but the game's.
  for (const sign of [-1, 1]) {
    grid(FRONT_ROWS, 4, (t, u) => [sign * halfX, halfY - depth * t, backZ + (frontZ - backZ) * u], [sign, 0, 0], (t) => [
      frontLit(t),
      frontAlpha(t),
      0,
    ]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute("aLit", new THREE.Float32BufferAttribute(lit, 1));
  geometry.setAttribute("aAlpha", new THREE.Float32BufferAttribute(alpha, 1));
  geometry.setAttribute("aUp", new THREE.Float32BufferAttribute(up, 1));
  geometry.setIndex(index);
  return geometry;
}

// ---------------------------------------------------------------------------
// The material
// ---------------------------------------------------------------------------

// A pool's material and the switch for its mirror: on only for the pool the
// scene drew the reflection for this frame (see `Scene3D.mirrorPool`), so a
// pool never reads a reflection taken in another pool's plane. And the world z
// behind which the slab's end caps are not drawn: where the scene's own water
// continues the pool past its ends (`Scene3D.adoptSceneryWater`), a cap is a
// wall standing in open water, and its waterline showed as a pale seam. And
// the pool's top face in the world (min x, max x, min z, max z), set by the
// scene every frame (`Scene3D.mirrorPool`): the scene's water continuing the
// pool is not drawn under it.
export interface StillWaterMaterial {
  material: THREE.MeshBasicMaterial;
  reflect: { value: number };
  openBehind: { value: number };
  footprint: { value: THREE.Vector4 };
}

// `openBehind` with nothing continuing the pool: every cap drawn.
const CAPS_CLOSED = -1e9;
// How far the scene's water reaches in under the pool's top face, metres.
const FOOTPRINT_OVERLAP = 0.01;

// THE WAKE is foam, drawn as a fall's foam is (waterLook.ts, impactPaint;
// Tris, 2026-10-06: the ripple rings went, and the white ring strokes were
// replaced by this): the ball churning through the surface leaves puffs of
// foam along its path, each solid where the ball broke the water and gone by
// WAKE_LIFE (clean water's bubbles burst within a second or two).
// IT SPREADS WITH THE BALL'S SPEED (Tris, 2026-10-06: it should expand out
// more when the ball moves): the water the ball shoves aside moves out at
// the Kelvin wake's half-angle, tan(19.47 deg) of the ball's speed, never
// slower than WAKE_SPREAD (a ball hardly moving still stirs a little), and
// slows as that water loses its push, the spread easing to a stop over about
// WAKE_EASE seconds. The puffs add to one foam amount, and a shared pattern of
// patches in metres (WAKE_PATCH across a metre, drifting) is covered wherever
// it is under that amount, so the trail is solid at the ball and breaks into
// torn patches behind it, one flat tone cut to the pixel; the water under it
// is milky, out to twice each puff's spread. Lengths are true metres.
// (Until 2026-10-06 the wake was rings after Tris's stylised ripple
// reference: crests as narrow waves in the slopes and white strokes broken
// into tapered arcs.)
//
// Shared by every still water material, so the trail carries on from the
// pool onto the scene's water beyond it.
//
// The ball sheds a puff every WAKE_SPACING metres it travels, but no sooner
// than WAKE_INTERVAL after the last, so a slot is never taken back while its
// puff lives (WAKE_SLOTS of them cover WAKE_SLOTS * WAKE_INTERVAL seconds,
// longer than WAKE_LIFE).
const WAKE_SLOTS = 24;
const WAKE_INTERVAL = 0.15;
const WAKE_LIFE = 1.6;
const WAKE_SPREAD = 0.3;
const WAKE_KELVIN = Math.tan((19.47 * Math.PI) / 180);
const WAKE_EASE = 0.6;
const WAKE_PATCH = 9;
// How far off the wake's plane a pixel can be and still carry it (m): the
// pool's top and the scene water continuing it, never the front sheet.
const WAKE_PLANE = 0.05;
// Where each puff was shed (x, y, z in three's frame, start time); how strong
// it is (0 = idle), the ball's waterline radius it starts at (m) and how fast
// it spreads (m/s).
const wakeSpotAt = { value: Array.from({ length: WAKE_SLOTS }, () => new THREE.Vector4()) };
const wakeSpotHow = { value: Array.from({ length: WAKE_SLOTS }, () => new THREE.Vector3()) };

// `backZ`/`frontZ` are the slab's z range, which is the world's: a water body's
// root stands on the gameplay plane. The deep-to-shallow ramp runs over it in
// world z, so anything else wearing a pool's water continues its colours.
//
// `plane` is that anything else: the scene's own flat water beyond the pool
// (the backdrop's "backdrop pool", see `Scene3D.adoptSceneryWater`), worn with
// the pool's colour, slab and mirror switch so the two meet without a seam.
// It is a plain surface with none of the slab's attributes, opaque, drawn
// before the slab, at the pool's own height and not under the pool's top face
// (`footprint`): one surface at one height, so there is no step at the join
// and the mirror is sampled from the same plane on both sides of it.
export function stillWaterMaterial(
  color: string | undefined,
  backZ: number,
  frontZ: number,
  plane: { reflect: { value: number }; footprint: { value: THREE.Vector4 } } | null = null,
): StillWaterMaterial {
  const { deep, shallow, light } = studyPalette(color);
  const reflect = plane ? plane.reflect : { value: 0 };
  const openBehind = { value: CAPS_CLOSED };
  const footprint = plane ? plane.footprint : { value: new THREE.Vector4() };
  // Unlit (the water's colour is the study's, not the cave lights') and not
  // tone mapped (the study's colours are display colours, and so is the
  // reflection it mixes with; see planarReflection.ts).
  //
  // NOT FOGGED. The study's air was thin where its camera stood (7% at its
  // pool), and the game's stands ~3x as far off at the study's scale: BALL's
  // haze (54% at 20 m) took half the teal's saturation and left a grey-blue
  // sheet (2026-10-05, measured front of pool 29,81,102 fogged vs the study's
  // 47,147,159). The mirror is still the fogged scene, so the level's air is in
  // what the water reflects; only the water's own colour stands clear of it.
  //
  // WRITES DEPTH, translucent front sheet and all. The depth of field draws
  // anything see-through that writes none sharp over its blur, whole (it
  // cannot blur what it has no depth for); a pool reaching back to the far
  // wall then stayed crisp against the blurred rocks it meets, and a shade
  // off the scene's water beyond its ends, which blurs (Tris, 2026-10-05).
  // With depth, the blur reads the water's own: sharp at the plane, soft
  // toward the far wall, as the rocks standing in it are.
  const mat = new THREE.MeshBasicMaterial({
    color: shallow,
    transparent: !plane,
    depthWrite: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  if (plane) mat.defines = { SW_PLANE: "" };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, reflectionUniforms);
    shader.uniforms.uTime = waterTime;
    shader.uniforms.uSurfaceMap = { value: waterSurfaceMap() };
    Object.assign(shader.uniforms, impactUniforms);
    shader.uniforms.uReflect = reflect;
    shader.uniforms.uOpenBehind = openBehind;
    shader.uniforms.uFootprint = footprint;
    shader.uniforms.uSlabZ = { value: new THREE.Vector2(backZ, Math.max(frontZ - backZ, 1e-3)) };
    shader.uniforms.uDeep = { value: deep };
    shader.uniforms.uShallow = { value: shallow };
    shader.uniforms.uLight = { value: light };
    shader.uniforms.uWakeAt = wakeSpotAt;
    shader.uniforms.uWakeHow = wakeSpotHow;

    shader.vertexShader = `
      #ifndef SW_PLANE
        attribute float aLit;
        attribute float aAlpha;
        attribute float aUp;
      #endif
      uniform mat4 uReflectionMatrix;
      uniform vec2 uSlabZ;
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying float vDepth;
      varying float vCap;
      varying vec3 vWorld;
      varying vec4 vReflection;
    ${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      #ifdef SW_PLANE
        vLit = 1.0;
        vAlpha = 1.0;
        vUp = 1.0;
        vCap = 0.0;
      #else
        vLit = aLit;
        vAlpha = aAlpha;
        vUp = aUp;
        // The end caps face along x; the top and the front sheet do not.
        vCap = abs(normal.x);
      #endif
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      // Back of the slab 0, front 1.
      vDepth = (vWorld.z - uSlabZ.x) / uSlabZ.y;
      vReflection = uReflectionMatrix * vec4(vWorld, 1.0);`,
    );

    shader.fragmentShader = `
      uniform float uTime;
      uniform sampler2D uSurfaceMap;
      uniform sampler2D uReflection;
      uniform sampler2D uReflectionDepth;
      uniform mat4 uReflectionInverse;
      uniform vec4 uReflectionArea;
      uniform float uReflect;
      uniform float uOpenBehind;
      uniform vec4 uFootprint;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform vec3 uLight;
      uniform vec4 uWakeAt[${WAKE_SLOTS}];
      uniform vec3 uWakeHow[${WAKE_SLOTS}];
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying float vDepth;
      varying float vCap;
      varying vec3 vWorld;
      varying vec4 vReflection;
      ${IMPACT_GLSL}
      // The reflection is stored as the canvas is, sRGB encoded.
      vec3 swDecode(vec3 c) {
        return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
      }
      // A point of the picture (0..1 over the water's window) in the texture
      // it is drawn into the corner of, kept half a texel inside it.
      vec2 swReflectionAt(vec2 uv) {
        return clamp(uv, uReflectionArea.zw, 1.0 - uReflectionArea.zw) * uReflectionArea.xy;
      }
      vec3 swReflection(vec2 uv) {
        return swDecode(texture2D(uReflection, swReflectionAt(uv)).rgb);
      }
    ${shader.fragmentShader}`
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
      // An end cap where the scene's water carries on past it.
      if (vCap > 0.5 && vWorld.z < uOpenBehind) discard;
      #ifdef SW_PLANE
        // The scene's water under the pool's top face, which draws there. A
        // hair inside it, so the two overlap rather than leave a crack; where
        // they overlap they are the same colour at the same height.
        if (vWorld.x > uFootprint.x + ${fmt(FOOTPRINT_OVERLAP)} && vWorld.x < uFootprint.y - ${fmt(FOOTPRINT_OVERLAP)}
          && vWorld.z > uFootprint.z + ${fmt(FOOTPRINT_OVERLAP)} && vWorld.z < uFootprint.w - ${fmt(FOOTPRINT_OVERLAP)}) discard;
      #endif
      // THE SURFACE, the study's shader (see the header). Lengths are in the
      // pattern's units.
      vec2 swP = vWorld.xz / vec2(${fmt(PATCH_SIZE)}, ${fmt(PATCH_SIZE * DEPTH_STRETCH)});
      float swT = uTime * ${fmt(SPEED)};
      // Three layers of the wave spectrum on independent, opposing drifts, so
      // their sum changes shape rather than sliding.
      vec4 swA = texture2D(uSurfaceMap, swP * vec2(0.048, 0.064) + vec2(0.011, -0.014) * swT);
      vec4 swB = texture2D(uSurfaceMap, swP * vec2(0.067, 0.086) + vec2(-0.009, 0.010) * swT + vec2(0.31, 0.57));
      vec4 swC = texture2D(uSurfaceMap, swP * vec2(0.11, 0.14) + vec2(0.016, 0.005) * swT + 0.73);
      // The finest layer fades out where a pixel spans too much of it.
      float swFine = 1.0 - smoothstep(0.14, 0.8, length(fwidth(swP)));
      vec2 swSlope = (swA.rg * 2.0 - 1.0) * vec2(0.11, 0.17)
                   + (swB.rg * 2.0 - 1.0) * vec2(0.085, 0.14)
                   + (swC.rg * 2.0 - 1.0) * vec2(0.035, 0.045) * swFine;
      // And three long waves, as slopes only.
      swSlope += ${fmt(WAVE_HEIGHT)} * (
          vec2(0.23, 1.12) * cos(dot(swP, vec2(0.23, 1.12)) - swT * 0.94)
        + vec2(-0.86, 1.58) * 0.55 * cos(dot(swP, vec2(-0.86, 1.58)) + swT * 1.17)
        + vec2(1.65, 0.93) * 0.28 * cos(dot(swP, vec2(1.65, 0.93)) - swT * 1.36));
      swSlope *= ${fmt(RIPPLE_STRENGTH)};
      // Where a fall lands in the pool, the boil and the rings it sends out
      // (waterLook.ts); the top face only, never the front sheet beside it.
      swSlope += impactSlope(vWorld) * vUp;

      // THE WAKE: the foam the ball leaves (see the header). Each puff's
      // amount, solid out to its spread and falling away past it, fading
      // over its life; the most of them is the trail's amount here, and the
      // milky water under it reaches twice as far.
      float swWake = 0.0;
      float swMilk = 0.0;
      for (int i = 0; i < ${WAKE_SLOTS}; i++) {
        vec4 at = uWakeAt[i];
        vec3 how = uWakeHow[i];
        float age = uTime - at.w;
        if (how.x <= 0.0 || age < 0.0 || age > ${fmt(WAKE_LIFE)} || abs(vWorld.y - at.y) > ${fmt(WAKE_PLANE)}) continue;
        // Out at its own rate, easing to a stop (see WAKE_EASE).
        float spread = how.y + how.z * ${fmt(WAKE_EASE)} * (1.0 - exp(-age / ${fmt(WAKE_EASE)}));
        float r = length(vWorld.xz - at.xz) / max(spread, 1e-3);
        float life = how.x * (1.0 - smoothstep(0.3, 1.0, age / ${fmt(WAKE_LIFE)}));
        swWake = max(swWake, life * exp(-r * r));
        swMilk = max(swMilk, life * exp(-0.25 * r * r));
      }
      // The patches the amount covers, in metres, drifting slowly: under 0
      // where there is foam. Cut to the pixel, taken here in uniform control
      // flow.
      float swPatch = 0.6 * paintNoise(vWorld.xz * ${fmt(WAKE_PATCH)} + vec2(0.13, -0.09) * uTime)
        + 0.4 * paintNoise(vWorld.xz * ${fmt(WAKE_PATCH * 2.3)} - vec2(0.11, 0.17) * uTime + 3.7);
      float swCover = swPatch - swWake;
      float swFoamAA = max(0.5 * fwidth(swCover), 1e-4);
      float swFoam = (1.0 - smoothstep(-swFoamAA, swFoamAA, swCover)) * step(0.001, swWake);

      vec3 swN = normalize(vec3(-swSlope.x, 1.0, -swSlope.y));
      vec3 swEye = normalize(cameraPosition - vWorld);
      float swNV = clamp(dot(swN, swEye), 0.0, 1.0);
      float swFresnel = 0.02 + 0.98 * pow(1.0 - swNV, 5.0);
      float swFore = smoothstep(${fmt(SHALLOW_RAMP[0])}, ${fmt(SHALLOW_RAMP[1])}, vDepth);
      vec3 swCol = mix(uDeep, uShallow, swFore * 0.91);

      // Broad soft light bands on the ripples facing the light, shade on the
      // ones facing away, a crest on the steepest.
      float swFacing = swSlope.y + swSlope.x * 0.24;
      float swBroad = smoothstep(0.012, 0.052, swFacing);
      float swCrest = smoothstep(0.078, 0.125, swFacing) * smoothstep(0.28, 0.65, swB.b);
      float swShade = smoothstep(0.015, 0.14, -swFacing);
      swCol *= 1.0 - swShade * 0.22;
      swCol = mix(swCol, uLight, swBroad * ${fmt(CONTRAST)} * (0.12 + swFore * 0.36));
      vec3 swBase = swCol;

      // The mirror, pushed about by the same slopes, three taps along the
      // ripples. Strong for what stands near the water, faint for the far
      // cave: the mirrored point is recovered from the reflection's depth.
      vec2 swUV = vReflection.xy / vReflection.w + swSlope * vec2(0.11, 0.075) * ${fmt(DISTORTION)};
      vec3 swMirror = swReflection(swUV) * 0.5
                    + swReflection(swUV + vec2(0.0015, 0.0007)) * 0.25
                    + swReflection(swUV - vec2(0.0015, 0.0007)) * 0.25;
      vec2 swDepthUV = clamp(swUV, uReflectionArea.zw, 1.0 - uReflectionArea.zw);
      vec4 swHit = uReflectionInverse
        * vec4(vec3(swDepthUV, texture2D(uReflectionDepth, swReflectionAt(swDepthUV)).r) * 2.0 - 1.0, 1.0);
      float swNear = 1.0 - smoothstep(${fmt(REFLECT_NEAR)}, ${fmt(REFLECT_FAR)}, length(swHit.xyz / swHit.w - vWorld));
      float swMirrorW = ${fmt(REFLECTION)} * mix(0.13 + swFresnel * 0.32, 0.82 + swFresnel * 0.16, swNear) * uReflect;
      swCol = mix(swCol, swMirror, clamp(swMirrorW, 0.0, 0.92));

      // A broad highlight from the cave's opening rather than a sun's hot
      // spot, and the crests.
      vec3 swHalf = normalize(swEye + normalize(vec3(-0.36, 0.78, -0.43)));
      swCol += uLight * pow(max(0.0, dot(swN, swHalf)), 100.0) * 0.16 * ${fmt(RIPPLE_STRENGTH)};
      swCol += uLight * swCrest * ${fmt(CONTRAST * 0.16)};
      // The wake's milky water and its foam, the fall's tone.
      vec3 swFoamTone = foamTone(uLight);
      swCol = mix(swCol, mix(swBase, swFoamTone, 0.35), swMilk * 0.6 * vUp);
      swCol = mix(swCol, swFoamTone, swFoam * vUp);
      // A fall's foam and the milky water under it, over the mirror.
      vec4 swPixel = impactPixel(vWorld);
      if (vUp > 0.5) swCol = impactPaint(vWorld, swCol, swBase, uLight, swPixel);

      // THE FRONT SHEET, a cross-section looking into the water: between the
      // shallow and the deep colour under the waterline, darkening toward the
      // bed, under a pale line at the waterline. How far below the waterline
      // a pixel is, in metres: the geometry's light falloff (aLit, 1 at the
      // waterline to 0 LIGHT_FALLOFF below) read back as a distance.
      float swBelow = (1.0 - vLit) * ${fmt(LIGHT_FALLOFF)};
      vec3 swFront = mix(mix(uShallow, uDeep, ${fmt(FRONT_TOP_DEEP)}), uDeep * ${fmt(FRONT_BED)},
        smoothstep(0.0, 0.5, swBelow));
      float swLine = 1.0 - smoothstep(${fmt(RIM_WIDTH)}, ${fmt(RIM_WIDTH + RIM_SOFT)}, swBelow);
      swFront = mix(swFront, mix(uLight, vec3(1.0), 0.5), ${fmt(WATERLINE_W)} * swLine);

      diffuseColor.rgb = max(mix(swFront, swCol, vUp), vec3(0.0));
      // The top face opaque, as the study's water and the scene's water
      // continuing it are: at the slab's 0.97 the bed showed through and the
      // pool read a shade off the water beyond its ends.
      diffuseColor.a = mix(vAlpha, 1.0, vUp);`,
      );
  };
  mat.customProgramCacheKey = () => (plane ? "still-water-plane" : "still-water");
  return { material: mat, reflect, openBehind, footprint };
}

// ---------------------------------------------------------------------------
// The splash
// ---------------------------------------------------------------------------

// A pool the splash can happen on, in the frames the detector needs: the body
// (its pose, in the sim's metres, y down), the rect's half extents, and the
// slab's z range in the body's frame (three's, +z toward the camera). And for
// the mirror (planarReflection.ts): the drawn slab, which the reflection
// leaves out, and its material's switch.
export interface StillSurface {
  body: WaterArea;
  halfX: number;
  halfY: number;
  backZ: number;
  frontZ: number;
  mesh: THREE.Mesh;
  reflect: { value: number };
  openBehind: { value: number };
  footprint: { value: THREE.Vector4 };
  // The pool's colour, for the scene's own water that continues it, and that
  // water once adopted (see `Scene3D.adoptSceneryWater`).
  color: string | undefined;
  scenery: THREE.Mesh[];
}

// The ball as the detector reads it: where it is DRAWN this frame and how fast
// the sim says it is moving. Read, never written.
export interface SplashBall {
  position: Vec2;
  velocity: Vec2;
  radius: number;
}

// How many splashes can be in the air at once; the oldest is reused.
const SLOTS = 6;
// Entry speeds (m/s, downward through the surface): under SPLASH_MIN nothing,
// SPLASH_FULL and over the whole splash. A ball leaving the water upward
// faster than EXIT_MIN throws a smaller one (EXIT_POWER of its speed's).
const SPLASH_MIN = 0.6;
const SPLASH_FULL = 7;
const SPLASH_FLOOR = 0.15;
const EXIT_MIN = 1.5;
const EXIT_POWER = 0.5;
// A ball that moved further than this between two drawn frames was placed,
// not thrown (a restart, a seek): no splash.
const TELEPORT = 1.5;

// THE WAKE: while the ball moves through the water with its bottom no deeper
// than WAKE_DEPTH under the top (and faster than WAKE_MIN_SPEED along it), it
// sheds a puff of foam (see WAKE_SLOTS) every WAKE_SPACING metres, so the
// trail is as long as the ball is fast.
const WAKE_DEPTH = 0.35;
const WAKE_MIN_SPEED = 0.15;
const WAKE_FULL_SPEED = 3;
const WAKE_SPACING = 0.14;

// THE CROWN: an open ring wall that rises out of the surface, flares outward
// and tears into holes as it falls - the reference's cloud-displaced
// cylinders, cel-shaded pale cyan with white blotches and a white fringe.
const CROWN_SEG = 48;
const CROWN_ROWS = 8;
const CROWN_LIFE = [0.45, 0.8] as const;
const CROWN_HEIGHT = [0.12, 0.42] as const;
// Starting radius as a multiple of the ball's, and how far it spreads (m).
const CROWN_R0 = 1.05;
const CROWN_SPREAD = [0.06, 0.2] as const;
const CROWN_FLARE = 0.55;
const CROWN_FRONT = "#a6e8f6";
const CROWN_BACK = "#5cc0d8";

// THE LACE: foam spreading over the surface from where the ball went in -
// radial lace near the middle, breaking into torn flecks at its rim. (Two
// broken ripple rings ran ahead of it until 2026-10-06, Tris: the ball's
// ripple rings went with the wake's.)
const LACE_LIFE = [1.1, 2.0] as const;
const LACE_RADIUS = [0.35, 1.1] as const;
const LACE_COLOR = "#c6f1fa";
const LACE_SPOKES = 22;

// THE DROPLETS: thrown up and out, ballistic; most solid dots, some hollow
// rings, like the reference's.
const DROPS = 40;
const DROP_UP = [1.4, 3.6] as const;
const DROP_OUT = [0.3, 1.5] as const;
const DROP_SIZE = [0.012, 0.034] as const;
const DROP_RING_ODDS = 0.3;
const DROP_GRAVITY = 9.81;
const DROP_COLOR = "#effbfd";

// The shared shader prelude: the slot table and the collapse for an idle slot.
const SLOT_GLSL = `
  uniform float uTime;
  uniform vec4 uAt[${SLOTS}];     // x, y, z (three's frame), start time
  uniform vec4 uHow[${SLOTS}];    // power 0..1 (0 = idle), seed, ball radius, -
  uniform vec4 uClip[${SLOTS}];   // the pool's xmin, xmax, zmin, zmax
  attribute float aSlot;
  // Outside the clip volume: an idle slot's triangles all land here and vanish.
  const vec4 SW_GONE = vec4(0.0, 0.0, 2.0, 1.0);
`;

const lerpGlsl = (r: readonly [number, number], t: string): string => `mix(${fmt(r[0])}, ${fmt(r[1])}, ${t})`;

interface SplashSlot {
  at: THREE.Vector4;
  how: THREE.Vector4;
  clip: THREE.Vector4;
}

export class WaterSplashes {
  readonly root = new THREE.Group();
  private readonly slots: SplashSlot[] = [];
  private next = 0;
  private prev: Vec2 | null = null;
  private prevClock = 0;
  // Where and when the last wake ring was shed, while the ball is still
  // making one.
  private wakeFrom: Vec2 | null = null;
  private wakeAt = -Infinity;
  private nextPuff = 0;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor() {
    for (let i = 0; i < SLOTS; i++) {
      this.slots.push({ at: new THREE.Vector4(), how: new THREE.Vector4(), clip: new THREE.Vector4() });
    }
    const uniforms = {
      uTime: waterTime,
      uAt: { value: this.slots.map((s) => s.at) },
      uHow: { value: this.slots.map((s) => s.how) },
      uClip: { value: this.slots.map((s) => s.clip) },
    };
    this.add(new THREE.Mesh(...this.crown(uniforms)), 12);
    this.add(new THREE.Mesh(...this.lace(uniforms)), 11);
    this.add(new THREE.Points(...this.drops(uniforms)), 13);
  }

  private add(obj: THREE.Mesh | THREE.Points, order: number): void {
    // Always in the scene and always "visible", so the prewarm compiles all
    // three programs; an idle slot collapses in the vertex shader instead.
    obj.frustumCulled = false;
    obj.renderOrder = order;
    this.geometries.push(obj.geometry);
    this.materials.push(obj.material as THREE.Material);
    this.root.add(obj);
  }

  // Forget every splash and the ball's last position: a new level, a restart.
  reset(): void {
    for (const s of this.slots) s.how.x = 0;
    for (const h of wakeSpotHow.value) h.x = 0;
    this.wakeFrom = null;
    this.wakeAt = -Infinity;
    this.prev = null;
  }

  // Once per drawn frame, after the clock is set: did the ball cross a pool's
  // surface since the last frame, and which way? And is it moving through the
  // water near enough the top to leave a wake?
  update(clock: number, surfaces: Iterable<StillSurface>, ball: SplashBall | null): void {
    if (!ball) {
      this.prev = null;
      this.wakeFrom = null;
      return;
    }
    const p = ball.position;
    const q = this.prev;
    const dt = clock - this.prevClock;
    this.prev = p;
    this.prevClock = clock;
    if (!q || p.distanceTo(q) > TELEPORT || dt <= 0) {
      this.wakeFrom = null;
      return;
    }
    // The ball's velocity as DRAWN between the two frames, beside the sim's
    // own. A pool over a shallow bed stops the ball within the frame it goes
    // in (the BALL pool's floor is 5 cm under its surface), so the sim's
    // velocity on the frame the crossing is seen is already zero.
    const drawn = p.sub(q).div(dt);
    let waking = false;
    for (const s of surfaces) {
      const c = s.body.globalPosition;
      const rot = s.body.globalRotation;
      const lp = p.sub(c).rotated(-rot);
      const lq = q.sub(c).rotated(-rot);
      const top = -s.halfY;
      // The ball sits on the gameplay plane, which the slab may not contain
      // when it is shifted through z.
      const z = Math.min(Math.max(0, s.backZ), s.frontZ);
      // The pool's footprint for the lace (an axis-aligned
      // box: still water is never authored turned).
      const ex = Math.abs(Math.cos(rot)) * s.halfX + Math.abs(Math.sin(rot)) * s.halfY;
      const clip: [number, number, number, number] = [c.x - ex, c.x + ex, s.backZ, s.frontZ];
      const surfacePoint = (x: number): Vec2 => c.add(new Vec2(x, top).rotated(rot));

      // The wake: inside the pool's span, in the water but not deeper than
      // WAKE_DEPTH below the top, moving along it. A puff of foam is shed
      // every WAKE_SPACING metres travelled, so the trail is even whatever
      // the frame rate.
      const depth = lp.y - top + ball.radius;
      if (Math.abs(lp.x) <= s.halfX && depth > 0 && depth < WAKE_DEPTH + ball.radius) {
        const speed = Math.max(Math.abs(ball.velocity.rotated(-rot).x), Math.abs(drawn.rotated(-rot).x));
        if (speed > WAKE_MIN_SPEED) {
          waking = true;
          const at = surfacePoint(lp.x);
          const due = !this.wakeFrom || this.wakeFrom.distanceTo(at) >= WAKE_SPACING;
          // (A clock run back, a seek, owes nothing to the ring before it.)
          if (due && (clock - this.wakeAt >= WAKE_INTERVAL || clock < this.wakeAt)) {
            this.wakeFrom = at;
            // Strongest with the ball breaking the surface, gone by WAKE_DEPTH;
            // and with speed.
            const shallow = 1 - Math.max(0, depth - ball.radius * 2) / WAKE_DEPTH;
            const fast = Math.min(1, speed / WAKE_FULL_SPEED);
            const strength = Math.max(0, shallow) * (0.35 + 0.65 * fast);
            if (strength > 0.05) {
              this.wakeAt = clock;
              // Born on the ball's waterline: the circle where the surface
              // cuts it, the centre `depth - radius` under (+) or over it.
              const under = depth - ball.radius;
              const waterline = Math.sqrt(Math.max(0, ball.radius * ball.radius - under * under));
              this.shedFoam(at.x, threeY(at.y), z, clock, strength, waterline, Math.max(WAKE_SPREAD, WAKE_KELVIN * speed));
            }
          }
        }
      }

      // The splash is when the ball's BOTTOM meets the water, going in, and
      // when it leaves it, coming out.
      const r = ball.radius;
      const entering = lq.y + r < top && lp.y + r >= top;
      const leaving = lq.y + r >= top && lp.y + r < top;
      if (!entering && !leaving) continue;
      const t = (top - lq.y - r) / (lp.y - lq.y);
      const x = lq.x + (lp.x - lq.x) * t;
      if (Math.abs(x) > s.halfX) continue;
      const simDown = ball.velocity.rotated(-rot).y;
      const drawnDown = drawn.rotated(-rot).y;
      const down = entering ? Math.max(simDown, drawnDown) : Math.min(simDown, drawnDown);
      const speed = entering ? down : -down * EXIT_POWER;
      if (speed < (entering ? SPLASH_MIN : EXIT_MIN * EXIT_POWER)) continue;
      const power = Math.min(1, Math.max(SPLASH_FLOOR, (speed - SPLASH_MIN) / (SPLASH_FULL - SPLASH_MIN)));
      const w = surfacePoint(x);
      this.spawn(w.x, threeY(w.y), z, clock, power, ball.radius, clip);
    }
    if (!waking) this.wakeFrom = null;
  }

  private shedFoam(
    x: number,
    y: number,
    z: number,
    clock: number,
    strength: number,
    waterline: number,
    spread: number,
  ): void {
    const i = this.nextPuff;
    this.nextPuff = (i + 1) % WAKE_SLOTS;
    wakeSpotAt.value[i]!.set(x, y, z, clock);
    wakeSpotHow.value[i]!.set(strength, waterline, spread);
  }

  private spawn(
    x: number,
    y: number,
    z: number,
    clock: number,
    power: number,
    radius: number,
    clip: [number, number, number, number],
  ): void {
    const slot = this.slots[this.next]!;
    this.next = (this.next + 1) % SLOTS;
    slot.at.set(x, y, z, clock);
    // The seed varies the crown's jag and the lace's cells from splash to
    // splash; taken from the clock so a pinned clock draws the same one.
    slot.how.set(power, (clock * 7.31) % 97, radius, 0);
    slot.clip.set(...clip);
  }

  private crown(uniforms: Record<string, THREE.IUniform>): [THREE.BufferGeometry, THREE.ShaderMaterial] {
    const slot: number[] = [];
    const ring: number[] = [];
    const index: number[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const base = slot.length;
      for (let r = 0; r <= CROWN_ROWS; r++) {
        for (let k = 0; k <= CROWN_SEG; k++) {
          slot.push(s);
          ring.push((k / CROWN_SEG) * Math.PI * 2, r / CROWN_ROWS);
        }
      }
      const cols = CROWN_SEG + 1;
      for (let r = 0; r < CROWN_ROWS; r++) {
        for (let k = 0; k < CROWN_SEG; k++) {
          const a = base + r * cols + k;
          index.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(slot.length * 3), 3));
    g.setAttribute("aSlot", new THREE.Float32BufferAttribute(slot, 1));
    g.setAttribute("aRing", new THREE.Float32BufferAttribute(ring, 2));
    g.setIndex(index);
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uFront: { value: new THREE.Color(CROWN_FRONT) },
        uBack: { value: new THREE.Color(CROWN_BACK) },
      }]),
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        ${SLOT_GLSL}
        attribute vec2 aRing;
        varying vec2 vRing;
        varying float vU;
        varying float vSeed;
        void main() {
          int s = int(aSlot + 0.5);
          vec4 at = uAt[s];
          vec4 how = uHow[s];
          float power = how.x;
          float life = ${lerpGlsl(CROWN_LIFE, "power")};
          float u = (uTime - at.w) / life;
          if (power <= 0.0 || u < 0.0 || u > 1.0) { gl_Position = SW_GONE; return; }
          float a = aRing.x;
          float v = aRing.y;
          float sd = how.y;
          // The jagged rim: a periodic sum of sines round the ring, sharpened
          // so the crown has points rather than a wavy hem.
          float jag = 0.5 + 0.5 * (0.55 * sin(5.0 * a + sd) + 0.3 * sin(9.0 * a + sd * 1.7) + 0.25 * sin(14.0 * a + sd * 2.3));
          jag = pow(clamp(jag, 0.0, 1.0), 1.5);
          // Up fast, then down: risen by a third of its life, collapsing after.
          float rise = smoothstep(0.0, 0.32, u);
          float fall = 1.0 - smoothstep(0.4, 1.0, u);
          float h = ${lerpGlsl(CROWN_HEIGHT, "power")} * rise * (0.25 + 0.75 * fall) * (0.4 + 0.8 * jag);
          float r0 = how.z * ${fmt(CROWN_R0)} + ${lerpGlsl(CROWN_SPREAD, "power")} * sqrt(u);
          float r = r0 + v * v * h * ${fmt(CROWN_FLARE)} * (0.6 + 1.2 * u);
          r *= 1.0 + 0.14 * v * sin(3.0 * a + sd * 3.1);
          vec3 p = vec3(at.x + r * cos(a), at.y - 0.01 + v * h, at.z + r * sin(a));
          vRing = aRing;
          vU = u;
          vSeed = sd;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uFront;
        uniform vec3 uBack;
        varying vec2 vRing;
        varying float vU;
        varying float vSeed;
        ${NOISE_GLSL}
        float swCell(vec2 p) {
          vec2 c = floor(p);
          float d = 8.0;
          for (int j = -1; j <= 1; j++)
          for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j));
            // Wrapped round the ring so the seam at angle 0 does not show.
            vec2 cell = vec2(mod(c.x + o.x, 12.0), c.y + o.y);
            d = min(d, distance(o + swHash3(vec3(cell, vSeed)).xy, p - c));
          }
          return d;
        }
        void main() {
          vec2 q = vec2(vRing.x / 6.2832 * 12.0, vRing.y * 2.5);
          // Holes that open as the crown falls: it tears into lace and goes.
          float hole = swCell(q * 1.6 + vec2(0.0, vU * 0.8));
          if (hole < smoothstep(0.3, 1.0, vU) * 0.75) discard;
          vec3 col = gl_FrontFacing ? uFront : uBack;
          // White blotches, and a white fringe along the points.
          float blot = step(0.62, swCell(q + 3.7));
          col = mix(col, vec3(1.0), max(blot * 0.8, step(0.82, vRing.y)));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      side: THREE.DoubleSide,
      fog: true,
    });
    // The slot table by reference, after the merge: merge CLONES, and a
    // cloned table is one `spawn` never writes to.
    Object.assign(m.uniforms, uniforms);
    return [g, m];
  }

  private lace(uniforms: Record<string, THREE.IUniform>): [THREE.BufferGeometry, THREE.ShaderMaterial] {
    const slot: number[] = [];
    const corner: number[] = [];
    const index: number[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const b = slot.length;
      for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        slot.push(s);
        corner.push(cx, cz);
      }
      index.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(slot.length * 3), 3));
    g.setAttribute("aSlot", new THREE.Float32BufferAttribute(slot, 1));
    g.setAttribute("aCorner", new THREE.Float32BufferAttribute(corner, 2));
    g.setIndex(index);
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(LACE_COLOR) } }]),
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        ${SLOT_GLSL}
        attribute vec2 aCorner;
        varying vec2 vQ;
        varying vec3 vWorld;
        varying float vU;
        varying float vPower;
        varying float vSeed;
        varying float vR0;
        varying vec4 vClip;
        void main() {
          int s = int(aSlot + 0.5);
          vec4 at = uAt[s];
          vec4 how = uHow[s];
          float power = how.x;
          float u = (uTime - at.w) / ${lerpGlsl(LACE_LIFE, "power")};
          if (power <= 0.0 || u < 0.0 || u > 1.0) { gl_Position = SW_GONE; return; }
          // Big enough for the flecks past its rim.
          float reach = ${lerpGlsl(LACE_RADIUS, "power")} * 1.5;
          vQ = aCorner * reach;
          vec3 p = vec3(at.x + vQ.x, at.y + 0.004, at.z + vQ.y);
          vWorld = p;
          vU = u;
          vPower = power;
          vSeed = how.y;
          vR0 = how.z;
          vClip = uClip[s];
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uColor;
        varying vec2 vQ;
        varying vec3 vWorld;
        varying float vU;
        varying float vPower;
        varying float vSeed;
        varying float vR0;
        varying vec4 vClip;
        ${NOISE_GLSL}
        // F1 and F2 of a 2D Voronoi whose x wraps every 'wrap' cells - the
        // angle - so a field laid out in polar coordinates has no seam.
        vec2 swVoronoi(vec2 p, float wrap, float seed) {
          vec2 c = floor(p);
          float f1 = 8.0;
          float f2 = 8.0;
          for (int j = -1; j <= 1; j++)
          for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j));
            vec2 cell = vec2(mod(c.x + o.x, wrap), c.y + o.y);
            float d = distance(o + swHash3(vec3(cell, seed)).xy, p - c);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
          }
          return vec2(f1, f2);
        }
        void main() {
          if (vWorld.x < vClip.x || vWorld.x > vClip.y || vWorld.z < vClip.z || vWorld.z > vClip.w) discard;
          float r = length(vQ);
          float th = atan(vQ.y, vQ.x) / 6.2832 + 0.5;
          float u = vU;
          float rMax = ${lerpGlsl(LACE_RADIUS, "vPower")};
          // The front runs out fast and slows; the middle hollows behind it.
          float front = vR0 + (rMax - vR0) * (1.0 - pow(1.0 - u, 2.2));
          float inner = front * mix(0.2, 0.75, u);
          // The lace: Voronoi edges in log-polar space, so its cells stretch
          // out along the spokes the way the reference's do; thick when young,
          // thinning as it spreads.
          vec2 lp = vec2(th * ${fmt(LACE_SPOKES)}, log(max(r, 0.01)) * 4.0);
          vec2 f = swVoronoi(lp, ${fmt(LACE_SPOKES)}, vSeed);
          float web = 1.0 - smoothstep(mix(0.42, 0.12, u) - 0.02, mix(0.42, 0.12, u), f.y - f.x);
          float band = smoothstep(inner * 0.9, inner, r) * (1.0 - smoothstep(front * 0.8, front, r));
          float lace = web * band;
          // Torn flecks at and past the rim: some cells kept whole, stretched
          // round the ring.
          vec2 fp = vec2(th * ${fmt(LACE_SPOKES * 2)}, r * 9.0);
          vec2 fc = floor(fp);
          float keep = step(swHash3(vec3(mod(fc.x, ${fmt(LACE_SPOKES * 2)}), fc.y, vSeed + 5.0)).x, 0.3);
          vec2 g = swVoronoi(fp, ${fmt(LACE_SPOKES * 2)}, vSeed + 5.0);
          float fleck = keep * step(g.x, mix(0.42, 0.18, u))
            * smoothstep(front * 0.75, front * 0.85, r) * (1.0 - smoothstep(front * 1.15, front * 1.3, r));
          float fade = 1.0 - smoothstep(0.6, 1.0, u);
          float a = max(lace, fleck) * fade;
          if (a < 0.02) discard;
          gl_FragColor = vec4(uColor, a * 0.95);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // The slot table by reference, after the merge: merge CLONES, and a
    // cloned table is one `spawn` never writes to.
    Object.assign(m.uniforms, uniforms);
    return [g, m];
  }

  private drops(uniforms: Record<string, THREE.IUniform>): [THREE.BufferGeometry, THREE.ShaderMaterial] {
    const slot: number[] = [];
    const seed: number[] = [];
    let n = 987654321;
    const rnd = (): number => {
      n = (n * 1103515245 + 12345) & 0x7fffffff;
      return n / 0x7fffffff;
    };
    for (let s = 0; s < SLOTS; s++) {
      for (let i = 0; i < DROPS; i++) {
        slot.push(s);
        seed.push(rnd(), rnd(), rnd(), rnd());
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(slot.length * 3), 3));
    g.setAttribute("aSlot", new THREE.Float32BufferAttribute(slot, 1));
    g.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 4));
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uViewHalfHeight: POINT_VIEW_HALF_HEIGHT,
        uColor: { value: new THREE.Color(DROP_COLOR) },
      }]),
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        ${SLOT_GLSL}
        uniform float uViewHalfHeight;
        attribute vec4 aSeed;
        varying float vRing;
        void main() {
          int s = int(aSlot + 0.5);
          vec4 at = uAt[s];
          vec4 how = uHow[s];
          float power = how.x;
          // A drop leaves a little after the ball goes in, and only as many
          // drops as the splash has power for.
          float t = uTime - at.w - aSeed.w * 0.12;
          if (power <= 0.0 || t < 0.0 || aSeed.w > 0.25 + 0.75 * power) { gl_Position = SW_GONE; return; }
          float a = aSeed.x * 6.2832;
          vec2 dir = vec2(cos(a), sin(a));
          float up = ${lerpGlsl(DROP_UP, "aSeed.y")} * mix(0.45, 1.0, power);
          float out_ = ${lerpGlsl(DROP_OUT, "aSeed.z")} * mix(0.4, 1.0, power);
          vec3 p = vec3(at.x, at.y + 0.02, at.z) + vec3(dir.x, 0.0, dir.y) * how.z;
          p += vec3(dir.x * out_, up, dir.y * out_) * t;
          p.y -= 0.5 * ${fmt(DROP_GRAVITY)} * t * t;
          // Back in the water: gone.
          if (p.y < at.y) { gl_Position = SW_GONE; return; }
          vRing = step(fract(aSeed.y * 7.31), ${fmt(DROP_RING_ODDS)});
          float size = ${lerpGlsl(DROP_SIZE, "fract(aSeed.x * 13.7)")} * mix(0.6, 1.0, power) * (1.0 + 0.6 * vRing);
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = max(2.0, size * projectionMatrix[1][1] * uViewHalfHeight / -mvPosition.z);
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uColor;
        varying float vRing;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float dot_ = 1.0 - smoothstep(0.4, 0.5, d);
          float ring = dot_ * smoothstep(0.24, 0.32, d);
          float a = mix(dot_, ring, vRing);
          if (a < 0.05) discard;
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // The slot table by reference, after the merge: merge CLONES, and a
    // cloned table is one `spawn` never writes to.
    Object.assign(m.uniforms, uniforms);
    return [g, m];
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
