import * as THREE from "three";
import { waterTime } from "./waterLook";
import glowLook from "../../tools/blender/foliage/glow_look.json";

// Glow flora: the Blender foliage add-on's glowing mushrooms, lantern blooms,
// ferns and reeds (tools/blender/foliage/glowflora.py, a port of the
// Glowshroom Generator's glowshrooms.js), drawn with that generator's own
// material. See docs/blender-foliage.md, "Glow flora".
//
// The mesh carries the generator's shader inputs as custom glTF attributes
// (the scene export writes Blender attributes named `_...`; GLTFLoader keeps
// them lower-cased):
//   _glow  vec3  emission colour, linear RGB
//   _gill  vec3  radial direction (x, y) and gill weight (z); z = -1 marks a
//                stem's inner glow
//   _sway  vec3  wind phase, amplitude (world metres), height factor
//   _extra vec2  gill line count, pulse phase
// A mesh is recognised by `_glow`, not by its material's name: the optimiser
// may merge identical materials or swap untextured ones for a palette one,
// and the material is replaced here anyway.
//
// What the shader does, as the generator's does: per-vertex emission with a
// slow pulse; glowing gill lines on a cap's underside and rib lines on a
// bulb (the gill vector's angle, `count` lines round); a stem glowing from
// inside (brighter where it faces the camera); a fresnel rim; and a wind
// sway, coherent between neighbours (the phase is the patch position), that
// grows with height, which the generator's collision pass left room for.
// The body is three's physical surface with the generator's iridescent sheen.
//
// The sway moves vertices, so the plants cast with the same sway (their own
// depth materials), and keep out of the depth prepass, which refuses a
// patched material (depthPrepass.ts). The non-black `emissive` is the
// emission's overall multiplier here.

const look = {
  // Shared with the Blender source material so visible glow and baked spill
  // agree. The live override below remains a preview until the next bake.
  uGlow: { value: glowLook.emissionStrength },
  uPulse: { value: 0.18 },
  uSway: { value: 1 },
  uRim: { value: 0.3 },
};

/** The patch's look, live, for every glow plant at once (the generator's setGlowshroomLook). */
export function setGlowFloraLook(l: { glow?: number; pulse?: number; sway?: number; rim?: number }): void {
  if (l.glow !== undefined) look.uGlow.value = l.glow;
  if (l.pulse !== undefined) look.uPulse.value = l.pulse;
  if (l.sway !== undefined) look.uSway.value = l.sway;
  if (l.rim !== undefined) look.uRim.value = l.rim;
}

const PROGRAM_KEY = "glow-flora-2";

const SWAY_DECLARE = `
attribute vec3 aSway; attribute vec2 aExtra;
uniform float uTime; uniform float uSway;`;

// The generator moved the vertex in its patch's own x and z (its camera on
// +z). A glow plant is planted unturned, so its patch frame is the world's;
// the sway is applied in the world and taken back into the mesh's frame, so
// a plant turned or tilted in Blender still sways across the screen.
const SWAY_BODY = `
{
  float hf = aSway.z * aSway.z;
  float w = uTime * 1.15 + aSway.x;
  vec3 swayWorld = vec3(sin(w), 0.0, cos(w * 0.83 + 0.6) * 0.6) * (aSway.y * hf * uSway);
  transformed += inverse(mat3(modelMatrix)) * swayWorld;
}`;

function swayPatch(shader: THREE.WebGLProgramParametersWithUniforms, extraDeclare = "", extraBody = ""): void {
  shader.uniforms.uTime = waterTime;
  shader.uniforms.uSway = look.uSway;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>${SWAY_DECLARE}${extraDeclare}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>${SWAY_BODY}${extraBody}`);
}

function surfaceMaterial(): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    name: "Glow Flora",
    vertexColors: true,
    roughness: 0.42,
    metalness: 0,
    iridescence: 0.4,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [180, 520],
    sheen: 0.25,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color("#ffffff"),
    clearcoat: 0.3,
    clearcoatRoughness: 0.4,
    // The overall emission multiplier.
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: 1,
    side: THREE.FrontSide,
  });
  // The coarse irradiance field includes this patch's boosted emission.
  // Feeding it back into the source washes out its authored pastel colours.
  mat.userData.gameBakedLightingReceiver = false;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, look);
    swayPatch(
      shader,
      `
attribute vec3 aGlow; attribute vec3 aGill;
varying vec3 vGlow; varying vec4 vGill; varying float vPhase;`,
      `
vGlow = aGlow; vGill = vec4(aGill, aExtra.x); vPhase = aExtra.y;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uTime; uniform float uGlow; uniform float uPulse; uniform float uRim;
varying vec3 vGlow; varying vec4 vGill; varying float vPhase;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
{
  float pulse = 1.0 + uPulse * sin(uTime * 1.5 + vPhase * 3.0);
  float fres = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 2.5);
  float k = 1.0;
  if (vGill.w < 0.0) {
    // Baked DOF LOD: unresolved lines keep their angular mean emission.
    k = -vGill.w;
  } else if (vGill.z > 0.01) {
    float ang = atan(vGill.y, vGill.x);
    float line = 1.0 - smoothstep(0.0, 0.42, abs(sin(ang * vGill.w * 0.5)));
    float half_ = (1.0 - smoothstep(0.0, 0.3, abs(sin(ang * vGill.w)))) * smoothstep(0.75, 0.2, vGill.z);
    k = 0.25 + 1.25 * max(line, half_ * 0.65);
  } else if (vGill.z < -0.5) {
    k = 0.55 + 0.9 * pow(1.0 - fres, 2.0);
  }
  totalEmissiveRadiance *= vGlow * (k * pulse + fres * uRim) * uGlow;
}`,
      );
  };
  mat.customProgramCacheKey = () => PROGRAM_KEY;
  mat.userData.glowFlora = true;
  return mat;
}

function swayingDepth<T extends THREE.Material>(mat: T, key: string): T {
  mat.onBeforeCompile = (shader) => swayPatch(shader);
  mat.customProgramCacheKey = () => `${PROGRAM_KEY}-${key}`;
  return mat;
}

// One of each for every glow plant: the look is shared, as the generator's
// one material was.
let shared: { surface: THREE.MeshPhysicalMaterial; depth: THREE.MeshDepthMaterial; distance: THREE.MeshDistanceMaterial } | null = null;

function materials() {
  shared ??= {
    surface: surfaceMaterial(),
    depth: swayingDepth(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), "depth"),
    distance: swayingDepth(new THREE.MeshDistanceMaterial(), "distance"),
  };
  return shared;
}

/** Whether `mesh` is a glow plant: it carries the glow attribute. */
export function isGlowFlora(mesh: THREE.Mesh): boolean {
  const g = mesh.geometry;
  return !!(g.getAttribute("_glow") || g.getAttribute("aGlow"));
}

/** Dress a glow plant with the glow flora material. Idempotent. Returns
 * false (and leaves the mesh as loaded) when an attribute is missing. */
export function wearGlowFlora(mesh: THREE.Mesh): boolean {
  const g = mesh.geometry;
  // The loader's names (lower-cased glTF names) to the shader's: an
  // identifier with a leading underscore is legal GLSL, but a double one is
  // reserved, and these read as what they are.
  for (const [from, to] of [["_glow", "aGlow"], ["_gill", "aGill"], ["_sway", "aSway"], ["_extra", "aExtra"]] as const) {
    const a = g.getAttribute(from);
    if (a) {
      g.setAttribute(to, a);
      g.deleteAttribute(from);
    }
    if (!g.getAttribute(to)) {
      console.warn(`[render3d] glow flora ${mesh.name}: no ${from} attribute; drawn as loaded`);
      return false;
    }
  }
  const m = materials();
  mesh.material = m.surface;
  mesh.customDepthMaterial = m.depth;
  mesh.customDistanceMaterial = m.distance;
  return true;
}

/** Give the glow plants under `root` their swaying depth materials again:
 * three's `Object3D.copy` does not carry `customDepthMaterial`, so every
 * mount (a `clone(true)` of the loaded file) needs this. */
export function reattachGlowFloraDepth(root: THREE.Object3D): void {
  if (!shared) return;
  const m = shared;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.material === m.surface) {
      mesh.customDepthMaterial = m.depth;
      mesh.customDistanceMaterial = m.distance;
    }
  });
}
