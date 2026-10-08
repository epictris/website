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
// breaking into torn patches behind it in one flat tone. The water under it
// is NOT milky (Tris, 2026-10-06: the pale blur spreading out under the
// churn went, the splash's with it).
//
// THE SPLASH is foam too, drawn by the surface shader as a fall's landing is:
// solid where the ball went in, opening into a torn ring carried out to where
// the crown's sheet comes back down. `WaterSplashes`
// is its detector and the wake's: it never touches the sim - it reads where
// the ball is drawn and how fast it is moving, as the lights do - and the
// foam is a pure function of the clock and the splash's own start, so a
// pinned clock draws the same splash twice.

import * as THREE from "three";
import { WaterArea } from "../engine/body";
import { Vec2 } from "../engine/vec2";
import { reflectionUniforms } from "./planarReflection";
import { threeY } from "./space";
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
// replaced by this): the ball churning through the surface leaves foam
// along its path. THE FOAM IS LEFT WHERE THE BALL WAS, AS IT LEAVES (Tris,
// 2026-10-06: "when the ball leaves an area, a wake persists in the place it
// left", and never appears where the ball was not): the trail follows the
// ball's path, as capsules along x, and the newest is drawn out every frame
// to wherever the ball is now, so water the ball uncovers already carries
// its foam and nothing pops in behind it. Each point of a
// capsule is as old as the moment the ball was there (its age runs from the
// capsule's start to its end). (Tried the same day and dropped: one round
// puff at the ball's middle, which drew narrower than the ball and grew;
// puffs born whole at the ball's leading and trailing ends, then off its near
// and far sides, then over the back half it had swept every 14 cm - each
// made foam appear at once, some of it where the ball had not been. Then the
// swept disc itself, spreading: a solid pale slab, "odd".)
//
// WHAT IS DRAWN is a real wake's shape (Tris, 2026-10-06, "more realistic"):
// - HOW MUCH WHITE WATER follows the ball's Froude number U / sqrt(g R): a
//   body moving slower than the surface waves it makes (Fr ~1, ~1.1 m/s for
//   this ball) breaks none, so `share` runs 0 to 1 over WAKE_FROUDE. Below
//   it the ball leaves only a thin strip, short-lived; above it the strip
//   widens toward the ball's width and the arms break.
// - THE STRIP down the middle of the path, the churned water behind the
//   ball: WAKE_STRIP[0] of its waterline radius wide (each side) at share 0,
//   [1] at share 1, when it is laid.
// - THE ARMS, the Kelvin wake's diverging crests breaking at the ball's
//   shoulders: the crest throws its foam out sideways at tan(19.47 deg) of
//   the ball's speed, and the foam, which rides the water and not the wave,
//   is carried only while the crest breaks under it, slowing over
//   WAKE_ARM_DRAG; so the arms flare out of the ball's V and settle parallel
//   behind it, v0 * WAKE_ARM_DRAG further out than the waterline.
//   WAKE_ARM_WIDTH of the waterline radius wide (each side), as strong as
//   `share`.
// - THE FOAM RIDES THE WAKE'S WATER, which is turbulent: each point is drawn
//   with the foam laid where the water now under it was (traced back once):
//   - the ball sheds eddies alternately off its sides (a Karman street, at a
//     Strouhal number of WAKE_STROUHAL: one pair per D / WAKE_STROUHAL of
//     path, whatever the speed, D the ball's diameter), the two rows
//     WAKE_STREET of that apart (von Karman's stable spacing); the strip's
//     water is rolled out toward the eddy on its side, half that spacing,
//     over about one shedding period, so the trail snakes. Its phase is
//     fixed where it was laid (world x), so the snake never slides;
//   - smaller eddies, WAKE_EDDY of D across, stir the strip and the arms at
//     WAKE_TURBULENCE of the ball's speed (a wake's turbulence intensity),
//     one fixed field over the water, so the edges come out ragged;
//   - eddies smaller still mix it outward: the foam spreads as a diffusion,
//     width sqrt(w0^2 + 2 K age), K = WAKE_DIFFUSIVITY * U * D (a wake's
//     eddy viscosity), thinning as it spreads so the foam is conserved.
// - IT DECAYS AS FOAM DOES, into lace: bubbles burst, so a round hole opens
//   in every cell of a jittered grid (WAKE_LACE_CELL across, drawn out
//   WAKE_LACE_STRETCH along the path as the water the ball dragged stretches
//   it) as the amount falls, up to WAKE_LACE_HOLE cell units across, the
//   holes growing until only curved strands are left between them and then
//   those go; solid while the amount is 1 or more; one flat tone cut to the
//   pixel. (Thresholding the cells' edges, F2 - F1, was tried first: it drew
//   straight hairline cracks, like shattered ice.)
// It lasts WAKE_LIFE at full strength, less as the ball goes slower or
// deeper: less air is churned in, and clean water's bubbles burst within a
// second or two; WAKE_PEAK lifts the amount so a cell is covered out to the
// strip's and the arms' widths, not only along their middles. Lengths are
// true metres.
// (Until 2026-10-06 the wake was rings after Tris's stylised ripple
// reference: crests as narrow waves in the slopes and white strokes broken
// into tapered arcs.)
//
// Shared by every still water material, so the trail carries on from the
// pool onto the scene's water beyond it.
//
// A capsule is closed and the next one starts from its end once it is
// WAKE_SPACING long and WAKE_INTERVAL old, so a slot is never taken back
// while its foam lives (WAKE_SLOTS of them cover at least WAKE_SLOTS *
// WAKE_INTERVAL seconds, longer than WAKE_LIFE).
const WAKE_SLOTS = 24;
const WAKE_INTERVAL = 0.15;
const WAKE_LIFE = 1.0;
const WAKE_LINE_LIFE = 0.3;
const WAKE_PEAK = 1.6;
const WAKE_FROUDE = [1.0, 2.0] as const;
const WAKE_STRIP = [0.25, 0.7] as const;
const WAKE_ARM_WIDTH = 0.3;
const WAKE_KELVIN = Math.tan((19.47 * Math.PI) / 180);
const WAKE_ARM_DRAG = 0.25;
const WAKE_STROUHAL = 0.2;
const WAKE_STREET = 0.281;
const WAKE_EDDY = 0.5;
const WAKE_TURBULENCE = 0.1;
const WAKE_DIFFUSIVITY = 0.03;
const WAKE_LACE_CELL = 0.06;
const WAKE_LACE_STRETCH = 2.5;
const WAKE_LACE_HOLE = 0.95;
// How far off the wake's plane a pixel can be and still carry it (m): the
// pool's top and the scene water continuing it, never the front sheet.
const WAKE_PLANE = 0.05;
// Each capsule: where the ball's middle was on the surface at its start and
// at its end (x0, x1 along the world's x - the ball moves in the gameplay
// plane, and still water is never authored turned - then y and z, three's
// frame); when (t0, t1), how strong it is (0 = idle; its life is WAKE_LIFE
// times this) and the ball's speed (m/s); and the ball's waterline radius
// (m), the white water's share (see WAKE_FROUDE), the ball's radius (m) and
// its trail's eddy phase (radians, see WAKE_STROUHAL).
const wakeSpotAt = { value: Array.from({ length: WAKE_SLOTS }, () => new THREE.Vector4()) };
const wakeSpotTime = { value: Array.from({ length: WAKE_SLOTS }, () => new THREE.Vector4()) };
const wakeSpotShape = { value: Array.from({ length: WAKE_SLOTS }, () => new THREE.Vector4()) };
// The small eddies' size (m, see WAKE_EDDY), from the last ball to leave a
// wake: one field over all the water.
const wakeEddy = { value: 1 };

// THE SPLASH'S FOAM (see `WaterSplashes`): the water the ball went in through
// churned white, and the ring where the crown's sheet comes back down (see
// CROWN_SPEED), so it is solid at the entry and breaks into a ring of torn
// arcs drifting out, as a fall's foam does: its amount covers a pattern of
// patches in metres (SPLASH_PATCH across a metre, drifting), in the wake's
// flat tone. The core is
// solid out to the ball's radius and spreads by SPLASH_CORE_SPREAD of it as
// the crown's foot falls back, and clears by SPLASH_CORE_LIFE of the splash's
// life (the churned water's bubbles are small and burst first); the ring
// leaves the ball's radius and eases out to where the sheet lands over its
// flight, widening from SPLASH_RING_WIDTH[0] to [1] of the ball's radius,
// and is gone by the splash's life.
const SPLASH_SLOTS = 6;
const SPLASH_FOAM_LIFE = [1.2, 2.4] as const;
const SPLASH_CORE_SPREAD = 0.8;
const SPLASH_CORE_LIFE = 0.55;
const SPLASH_RING_WIDTH = [0.35, 1.2] as const;
const SPLASH_PATCH = 9;
// Where each splash went in (x, y, z in three's frame, start time); its power
// (0 = idle), the ball's radius, its reach (m) and the sheet's flight (s).
const splashFoamAt = { value: Array.from({ length: SPLASH_SLOTS }, () => new THREE.Vector4()) };
const splashFoamHow = { value: Array.from({ length: SPLASH_SLOTS }, () => new THREE.Vector4()) };

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
    shader.uniforms.uWakeTime = wakeSpotTime;
    shader.uniforms.uWakeShape = wakeSpotShape;
    shader.uniforms.uWakeEddy = wakeEddy;
    shader.uniforms.uSplashAt = splashFoamAt;
    shader.uniforms.uSplashHow = splashFoamHow;

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
      uniform vec4 uWakeTime[${WAKE_SLOTS}];
      uniform vec4 uWakeShape[${WAKE_SLOTS}];
      uniform float uWakeEddy;
      uniform vec4 uSplashAt[${SPLASH_SLOTS}];
      uniform vec4 uSplashHow[${SPLASH_SLOTS}];
      varying float vLit;
      varying float vAlpha;
      varying float vUp;
      varying float vDepth;
      varying float vCap;
      varying vec3 vWorld;
      varying vec4 vReflection;
      ${IMPACT_GLSL}
      // The wake's lace: how far a point is from the nearest hole's middle
      // (cell units, one hole per cell, jittered), divided by that hole's
      // own size, so the holes are round and no two the same.
      float swLace(vec2 p) {
        vec2 c = floor(p);
        float best = 8.0;
        for (int j = -1; j <= 1; j++)
        for (int i = -1; i <= 1; i++) {
          vec2 o = vec2(float(i), float(j));
          vec2 cell = c + o;
          float d = distance(o + vec2(h21(cell), h21(cell + 17.31)), p - c) / mix(0.75, 1.2, h21(cell + 41.7));
          best = min(best, d);
        }
        return best;
      }
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

      // THE WAKE: the foam the ball leaves (see the header). Each capsule's
      // amount - the churned strip down the middle of the path and the two
      // arms breaking off the ball's sides - fading over its life; the most
      // of them is the trail's amount here.
      // The small eddies' stir (see WAKE_EDDY): the curl of a stream
      // function, so the water it moves neither piles up nor opens; the
      // noise's slopes are 0.5 rms, so this is 1 rms.
      vec2 swEddyP = vWorld.xz / uWakeEddy;
      float swPsi = paintNoise(swEddyP);
      vec2 swStir = vec2(paintNoise(swEddyP + vec2(0.0, 0.05)) - swPsi, swPsi - paintNoise(swEddyP + vec2(0.05, 0.0))) * 40.0;
      float swWake = 0.0;
      // How far the eddies have carried the foam here since it was laid (the
      // most of the trail's), so its lace rides the water too.
      vec2 swCarried = vec2(0.0);
      for (int i = 0; i < ${WAKE_SLOTS}; i++) {
        vec4 at = uWakeAt[i];
        vec4 tm = uWakeTime[i];
        float span = ${fmt(WAKE_LIFE)} * tm.z;
        if (tm.z <= 0.0 || uTime - tm.y > span || abs(vWorld.y - at.z) > ${fmt(WAKE_PLANE)}) continue;
        // When the ball was nearest here (from where the point is now: the
        // eddies move the water far less than the ball moves meanwhile).
        float len = at.y - at.x;
        float along = abs(len) > 1e-4 ? clamp((vWorld.x - at.x) / len, 0.0, 1.0) : 0.0;
        float age = uTime - mix(tm.x, tm.y, along);
        if (age < 0.0 || age > span) continue;
        vec4 sh = uWakeShape[i];
        float w = sh.x;
        float share = sh.y;
        float u = tm.w;
        float d = 2.0 * sh.z;
        // Where the water here was when the foam was laid on it: back along
        // the small eddies' stir, at the wake's turbulent speed, since then.
        vec2 carried = swStir * (${fmt(WAKE_TURBULENCE)} * u * age);
        vec2 laid = vWorld.xz - carried;
        along = abs(len) > 1e-4 ? clamp((laid.x - at.x) / len, 0.0, 1.0) : 0.0;
        float dx = laid.x - mix(at.x, at.y, along);
        float dz = laid.y - at.w;
        // The strip's water rolled toward the street's eddy on its side, over
        // a shedding period (one street length of the ball's travel).
        float street = d / ${fmt(WAKE_STROUHAL)};
        float roll = ${fmt(WAKE_STREET / 2)} * street * sin(6.2831853 * laid.x / street + sh.w) * (1.0 - exp(-age * u / street));
        // Both spread by the smallest eddies (see WAKE_DIFFUSIVITY), as a
        // diffusion does: a Gaussian's width squared grows by 4 K t, and its
        // peak falls as it widens.
        float spread = ${fmt(4 * WAKE_DIFFUSIVITY)} * u * d * age;
        float life = 1.0 - smoothstep(0.0, 1.0, age / span);
        // The strip: a thin line behind a slow ball, most of its width
        // behind a fast one.
        float strip0 = w * mix(${fmt(WAKE_STRIP[0])}, ${fmt(WAKE_STRIP[1])}, share);
        float stripW = sqrt(strip0 * strip0 + spread);
        float strip = length(vec2(dx, dz - roll)) / stripW;
        // The arms: thrown out from the ball's sides at the Kelvin speed,
        // slowing as their crest stops breaking (see WAKE_ARM_DRAG).
        float arm0 = w * ${fmt(WAKE_ARM_WIDTH)};
        float armW = sqrt(arm0 * arm0 + spread);
        float reach = w + ${fmt(WAKE_KELVIN * WAKE_ARM_DRAG)} * u * (1.0 - exp(-age / ${fmt(WAKE_ARM_DRAG)}));
        float arm = length(vec2(dx, abs(dz) - reach)) / armW;
        float amount = ${fmt(WAKE_PEAK)} * life * max(strip0 / stripW * exp(-strip * strip), share * arm0 / armW * exp(-arm * arm));
        if (amount > swWake) {
          swWake = amount;
          swCarried = carried;
        }
      }
      // The wake's lace (see WAKE_LACE_CELL): a round hole opens in every
      // cell as the amount falls, growing till only strands are left between
      // them, then those go. Under 0 where there is foam; cut to the pixel,
      // taken here in uniform control flow.
      float swHole = ${fmt(WAKE_LACE_HOLE)} * (1.0 - clamp(swWake, 0.0, 1.0));
      float swLaceCover = swHole - swLace((vWorld.xz - swCarried) / vec2(${fmt(WAKE_LACE_CELL * WAKE_LACE_STRETCH)}, ${fmt(WAKE_LACE_CELL)}));
      float swLaceAA = max(0.5 * fwidth(swLaceCover), 1e-4);
      float swWakeFoam = (1.0 - smoothstep(-swLaceAA, swLaceAA, swLaceCover)) * step(0.05, swWake);

      // THE SPLASH'S FOAM (see SPLASH_SLOTS): the churned core and the ring
      // the crown's sheet lands in.
      float swSplash = 0.0;
      for (int i = 0; i < ${SPLASH_SLOTS}; i++) {
        vec4 at = uSplashAt[i];
        vec4 how = uSplashHow[i];
        float age = uTime - at.w;
        float span = mix(${fmt(SPLASH_FOAM_LIFE[0])}, ${fmt(SPLASH_FOAM_LIFE[1])}, how.x);
        if (how.x <= 0.0 || age < 0.0 || age > span || abs(vWorld.y - at.y) > ${fmt(WAKE_PLANE)}) continue;
        float d = length(vWorld.xz - at.xz);
        float out_ = 1.0 - exp(-age / max(how.w, 1e-3));
        float strength = mix(0.6, 1.0, how.x);
        float life = strength * (1.0 - smoothstep(0.25, 1.0, age / span));
        float coreLife = strength * (1.0 - smoothstep(0.1, 1.0, age / (span * ${fmt(SPLASH_CORE_LIFE)})));
        float core = d / (how.y * (1.0 + ${fmt(SPLASH_CORE_SPREAD)} * out_));
        float ringAt = how.y + (how.z - how.y) * out_;
        float ringW = how.y * mix(${fmt(SPLASH_RING_WIDTH[0])}, ${fmt(SPLASH_RING_WIDTH[1])}, out_);
        float ring = (d - ringAt) / ringW;
        swSplash = max(swSplash, max(coreLife * exp(-core * core), life * exp(-ring * ring)));
      }
      // The patches the splash's amount covers, in metres, drifting slowly:
      // under 0 where there is foam. Cut to the pixel, taken here in uniform
      // control flow.
      float swPatch = 0.6 * paintNoise(vWorld.xz * ${fmt(SPLASH_PATCH)} + vec2(0.13, -0.09) * uTime)
        + 0.4 * paintNoise(vWorld.xz * ${fmt(SPLASH_PATCH * 2.3)} - vec2(0.11, 0.17) * uTime + 3.7);
      float swCover = swPatch - swSplash;
      float swFoamAA = max(0.5 * fwidth(swCover), 1e-4);
      float swFoam = max(swWakeFoam, (1.0 - smoothstep(-swFoamAA, swFoamAA, swCover)) * step(0.001, swSplash));

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
      // The wake's and the splash's foam, the fall's tone.
      swCol = mix(swCol, foamTone(uLight), swFoam * vUp);
      // A fall's foam, over the mirror.
      vec4 swPixel = impactPixel(vWorld);
      if (vUp > 0.5) swCol = impactPaint(vWorld, swCol, uLight, swPixel);

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
// draws its trail out behind it (see WAKE_SLOTS), so the trail is as long as
// the ball is fast. A ball further than WAKE_JUMP from where its trail ends
// was placed, or left the water and came back: it starts a new one rather
// than owe foam to the stretch between.
const WAKE_DEPTH = 0.35;
const WAKE_MIN_SPEED = 0.15;
const WAKE_SPACING = 0.14;
const WAKE_JUMP = 0.5;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// THE CROWN'S SHEET, which the foam ring rides out on (see SPLASH_SLOTS): the
// water the ball shoves aside leaves its waterline (CROWN_FROM of its radius
// out) at CROWN_SPEED of the entry speed U, tilted CROWN_TILT (radians) off
// vertical, and comes back down a ballistic range out, one flight later. It
// is not drawn - thrown lumps of foam were tried and removed (Tris,
// 2026-10-06) - only the foam it lands as.
const CROWN_FROM = 0.8;
const CROWN_SPEED = 0.45;
const CROWN_TILT = 0.4;
const GRAVITY = 9.81;
const RANGE_PER_U2 = (CROWN_SPEED * CROWN_SPEED * Math.sin(2 * CROWN_TILT)) / GRAVITY;
const FLIGHT_PER_U = (2 * CROWN_SPEED * Math.cos(CROWN_TILT)) / GRAVITY;

export class WaterSplashes {
  private next = 0;
  private prev: Vec2 | null = null;
  private prevClock = 0;
  // The wake capsule the ball is drawing out (-1 while it makes none) and the
  // surface it lies on.
  private wakeLive = -1;
  private wakeSurface: StillSurface | null = null;
  private nextPuff = 0;
  // The live trail's eddy phase (see WAKE_STROUHAL).
  private wakePhase = 0;

  // Forget every splash and the ball's last position: a new level, a restart.
  reset(): void {
    for (const h of splashFoamHow.value) h.x = 0;
    for (const t of wakeSpotTime.value) t.z = 0;
    this.wakeLive = -1;
    this.prev = null;
  }

  // Once per drawn frame, after the clock is set: did the ball cross a pool's
  // surface since the last frame, and which way? And is it moving through the
  // water near enough the top to leave a wake?
  update(clock: number, surfaces: Iterable<StillSurface>, ball: SplashBall | null): void {
    if (!ball) {
      this.prev = null;
      this.wakeLive = -1;
      return;
    }
    const p = ball.position;
    const q = this.prev;
    const dt = clock - this.prevClock;
    this.prev = p;
    this.prevClock = clock;
    if (!q || p.distanceTo(q) > TELEPORT || dt <= 0) {
      this.wakeLive = -1;
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
      const surfacePoint = (x: number): Vec2 => c.add(new Vec2(x, top).rotated(rot));

      // The wake: inside the pool's span, in the water but not deeper than
      // WAKE_DEPTH below the top, moving along it. A puff of foam is shed
      // every WAKE_SPACING metres travelled, so the trail is even whatever
      // the frame rate.
      const depth = lp.y - top + ball.radius;
      if (Math.abs(lp.x) <= s.halfX && depth > 0 && depth < WAKE_DEPTH + ball.radius) {
        const speed = Math.max(Math.abs(ball.velocity.rotated(-rot).x), Math.abs(drawn.rotated(-rot).x));
        if (speed > WAKE_MIN_SPEED) {
          // The white water's share from the Froude number (see
          // WAKE_FROUDE), and how long it lasts: WAKE_LINE_LIFE for the thin
          // strip a slow ball leaves, WAKE_LIFE for a breaking wake;
          // strongest with the ball breaking the surface, gone by WAKE_DEPTH.
          const froude = speed / Math.sqrt(GRAVITY * ball.radius);
          const share = Math.min(1, Math.max(0, (froude - WAKE_FROUDE[0]) / (WAKE_FROUDE[1] - WAKE_FROUDE[0])));
          const shallow = 1 - Math.max(0, depth - ball.radius * 2) / WAKE_DEPTH;
          const strength = Math.max(0, shallow) * (WAKE_LINE_LIFE + (WAKE_LIFE - WAKE_LINE_LIFE) * share) / WAKE_LIFE;
          if (strength > 0.05) {
            waking = true;
            const at = surfacePoint(lp.x);
            // The ball's waterline: the circle where the surface cuts it, the
            // centre `depth - radius` under (+) or over it.
            const under = depth - ball.radius;
            const waterline = Math.sqrt(Math.max(0, ball.radius * ball.radius - under * under));
            this.drawWake(s, at.x, threeY(at.y), z, clock, strength, speed, waterline, share, ball.radius);
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
      // Started when the ball crossed, a fraction t into the frame, not when
      // the frame is drawn: at 60 Hz that is up to 17 ms of flight.
      this.spawn(w.x, threeY(w.y), z, clock - (1 - t) * dt, power, speed, ball.radius);
    }
    if (!waking) this.wakeLive = -1;
  }

  // Draw the live capsule out to where the ball is now, starting one where
  // there is none (or the last cannot be carried on: another surface, a
  // jump, a clock run back), and closing it for the next, which starts from
  // its end, once it is long and old enough (see WAKE_SLOTS).
  private drawWake(
    surface: StillSurface,
    x: number,
    y: number,
    z: number,
    clock: number,
    strength: number,
    speed: number,
    waterline: number,
    share: number,
    radius: number,
  ): void {
    let i = this.wakeLive;
    if (i >= 0) {
      const at = wakeSpotAt.value[i]!;
      const tm = wakeSpotTime.value[i]!;
      if (this.wakeSurface !== surface || clock < tm.y || Math.abs(x - at.y) > WAKE_JUMP) {
        i = -1;
      } else if (Math.abs(at.y - at.x) >= WAKE_SPACING && clock - tm.x >= WAKE_INTERVAL) {
        i = this.startWake(at.y, y, z, tm.y);
      }
    }
    if (i < 0) {
      // A new trail sheds its eddies in a phase of its own, so two passes
      // over the same water do not snake alike.
      this.wakePhase = (this.wakePhase + GOLDEN_ANGLE) % (2 * Math.PI);
      i = this.startWake(x, y, z, clock);
    }
    this.wakeSurface = surface;
    wakeEddy.value = WAKE_EDDY * 2 * radius;
    wakeSpotAt.value[i]!.y = x;
    wakeSpotTime.value[i]!.set(wakeSpotTime.value[i]!.x, clock, strength, speed);
    wakeSpotShape.value[i]!.set(waterline, share, radius, this.wakePhase);
  }

  private startWake(x: number, y: number, z: number, clock: number): number {
    const i = this.nextPuff;
    this.nextPuff = (i + 1) % WAKE_SLOTS;
    this.wakeLive = i;
    wakeSpotAt.value[i]!.set(x, x, y, z);
    wakeSpotTime.value[i]!.set(clock, clock, 0, 0);
    return i;
  }

  private spawn(
    x: number,
    y: number,
    z: number,
    start: number,
    power: number,
    speed: number,
    radius: number,
  ): void {
    const i = this.next;
    this.next = (i + 1) % SPLASH_SLOTS;
    // The ring carried out to where the crown's sheet lands, over its flight.
    splashFoamAt.value[i]!.set(x, y, z, start);
    splashFoamHow.value[i]!.set(power, radius, CROWN_FROM * radius + RANGE_PER_U2 * speed * speed, FLIGHT_PER_U * speed);
  }
}
