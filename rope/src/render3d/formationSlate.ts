// The iteration look of a formation (docs/formations.md, "Two looks"): the
// painted slate (tools/blender/formations/slate.py) drawn by the game itself,
// so a rock is seen the moment its geometry lands, long before a bake.
//
// It is the slate's graph, node for node where the game can evaluate it:
//
// - the drift between COOL and WARM by a Perlin fBm of the rock's own
//   coordinates (Blender's Noise texture: scale 0.9, detail 2);
// - the per-facet tone, read from `_facet` (formation_export.py copies the
//   face attribute onto the corners), onto 0.92 to 1.08;
// - the grain (scale 35, detail 3) onto 0.96 to 1.04, and the vertical stains
//   (scale 1 through a (3, 3, 0.7) stretch, its 0.35 to 0.65 band onto 0.75 to
//   1);
// - the edge line, which Blender draws where the Bevel node's normal turns
//   from the face's (its dot from 0.995 down to 0.92, onto a mix toward LINE
//   of up to 0.35). The Bevel averages the normals in a disc of BEVEL_RADIUS
//   about the point; near one edge, the far face holds the share of that disc
//   past the edge, so the averaged normal leans toward the far face's by an
//   angle the edge's dihedral and that share decide. `_edge` gives each
//   point's distance to its triangle's three edges and `_crease` each edge's
//   half dihedral angle (formation_export.py `edge_attributes`), and that is
//   computed here exactly;
// - the concave creases' short occlusion (reach CONCAVE_REACH), which darkens
//   a fold onto 0.55 and gates the line off there: estimated from the fold's
//   angle (the share of the hemisphere the far face takes) fading out across
//   the reach.
//
// What it cannot draw: the 0.5 m ambient occlusion (it needs the whole rock,
// not a triangle's edges), the shading Bevel's rounded normals, the chamfer
// strips, and the detail normal map's chips. None is needed to judge how a
// level plays; the bake has all of them.

import * as THREE from "three";

// slate.py's numbers, by the same names.
const COOL = "#2f3546";
const WARM = "#3b3e4a";
const LINE = "#5c6070";
const DRIFT_SCALE = 0.9;
const GRAIN_SCALE = 35;
const FACET_TONE: [number, number] = [0.92, 1.08];
const GRAIN_TONE: [number, number] = [0.96, 1.04];
const STAIN_BAND: [number, number] = [0.35, 0.65];
const STAIN_TONE: [number, number] = [0.75, 1.0];
const BEVEL_RADIUS = 0.03;
const EDGE_DOT: [number, number] = [0.995, 0.92];
const EDGE_MIX = 0.35;
const CONCAVE_REACH = 0.06;
const CONCAVE_AO: [number, number] = [0.5, 1.0];
const CONCAVE_TONE: [number, number] = [0.55, 1.0];
const CONVEX_GATE: [number, number] = [0.85, 0.97];
const SPECULAR = 0.1;

const glslColor = (hex: string): string => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(6)}, ${c.g.toFixed(6)}, ${c.b.toFixed(6)})`;
};
const f = (x: number): string => x.toFixed(6);

const NOISE = /* glsl */ `
vec3 slateHash(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return normalize(fract((p.xxy + p.yzz) * p.zyx) * 2.0 - 1.0);
}
// Gradient (Perlin) noise, about -1..1.
float slatePerlin(vec3 p) {
  vec3 i = floor(p);
  vec3 w = fract(p);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float n000 = dot(slateHash(i), w);
  float n100 = dot(slateHash(i + vec3(1, 0, 0)), w - vec3(1, 0, 0));
  float n010 = dot(slateHash(i + vec3(0, 1, 0)), w - vec3(0, 1, 0));
  float n110 = dot(slateHash(i + vec3(1, 1, 0)), w - vec3(1, 1, 0));
  float n001 = dot(slateHash(i + vec3(0, 0, 1)), w - vec3(0, 0, 1));
  float n101 = dot(slateHash(i + vec3(1, 0, 1)), w - vec3(1, 0, 1));
  float n011 = dot(slateHash(i + vec3(0, 1, 1)), w - vec3(0, 1, 1));
  float n111 = dot(slateHash(i + vec3(1, 1, 1)), w - vec3(1, 1, 1));
  return 1.6 * mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
                   mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// Blender's Noise texture's Fac: fBm of 'detail' octaves past the first
// (the last one fractional), roughness 0.5, lacunarity 2, onto 0..1.
float slateNoise(vec3 p, float detail) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  float whole = floor(detail);
  for (int o = 0; o <= 4; o++) {
    if (float(o) > whole) break;
    sum += amp * slatePerlin(p);
    norm += amp;
    amp *= 0.5;
    p *= 2.0;
  }
  float rest = detail - whole;
  if (rest > 0.0) {
    sum += rest * amp * slatePerlin(p);
    norm += rest * amp;
  }
  return clamp(0.5 + 0.5 * sum / norm, 0.0, 1.0);
}
float slateRemap(float x, float lo, float hi, float a, float b) {
  return mix(a, b, clamp((x - lo) / (hi - lo), 0.0, 1.0));
}
// The angle the Bevel's averaged normal leans from the face's at distance d
// from an edge whose half dihedral angle is h: the far face holds the share
// of a disc of radius R past a chord d from its centre.
float slateLean(float d, float h, float R) {
  float t = clamp(d / R, 0.0, 1.0);
  float share = (acos(t) - t * sqrt(1.0 - t * t)) / 3.14159265;
  float turn = 2.0 * abs(h);
  return atan(share * sin(turn), (1.0 - share) + share * cos(turn));
}
`;

// One shared material: every formation's geometry wears it (its program is
// compiled once).
let shared: THREE.MeshPhysicalMaterial | null = null;

export function formationSlateMaterial(): THREE.MeshPhysicalMaterial {
  if (shared) return shared;
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 0, flatShading: true });
  m.name = "Formation slate (iteration)";
  // Principled's Specular IOR Level 0.1 is a fifth of its default reflectance.
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float aFacet;
attribute vec3 aEdge;
attribute vec3 aCrease;
varying float vFacet;
varying vec3 vEdge;
varying vec3 vCrease;
varying vec3 vRock;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vFacet = aFacet;
vEdge = aEdge;
vCrease = aCrease;
// The rock's own frame as Blender's (x, y away, z up): the noises are of
// Object coordinates there, and the stains stretch along its z.
vRock = vec3(position.x, -position.z, position.y);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying float vFacet;
varying vec3 vEdge;
varying vec3 vCrease;
varying vec3 vRock;
${NOISE}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
{
  vec3 base = mix(${glslColor(COOL)}, ${glslColor(WARM)}, slateNoise(vRock * ${f(DRIFT_SCALE)}, 2.0));
  float tone = mix(${f(FACET_TONE[0])}, ${f(FACET_TONE[1])}, vFacet);
  tone *= mix(${f(GRAIN_TONE[0])}, ${f(GRAIN_TONE[1])}, slateNoise(vRock * ${f(GRAIN_SCALE)}, 3.0));
  tone *= slateRemap(slateNoise(vRock * vec3(3.0, 3.0, 0.7), 2.0), ${f(STAIN_BAND[0])}, ${f(STAIN_BAND[1])}, ${f(STAIN_TONE[0])}, ${f(STAIN_TONE[1])});
  float edge = 0.0;
  float ao = 1.0;
  for (int i = 0; i < 3; i++) {
    float h = vCrease[i];
    float d = vEdge[i];
    if (h > 0.0) {
      float dotN = cos(slateLean(d, h, ${f(BEVEL_RADIUS)}));
      edge = max(edge, slateRemap(dotN, ${f(EDGE_DOT[0])}, ${f(EDGE_DOT[1])}, 0.0, ${f(EDGE_MIX)}));
    } else if (h < 0.0) {
      // The far face rises by the fold's turn: of the hemisphere's cosine
      // weight it takes (1 - cos(turn)) / 2 at the crease, nothing a reach out.
      float taken = 0.5 * (1.0 - cos(-2.0 * h)) * max(0.0, 1.0 - d / ${f(CONCAVE_REACH)});
      ao = min(ao, 1.0 - taken);
    }
  }
  tone *= slateRemap(ao, ${f(CONCAVE_AO[0])}, ${f(CONCAVE_AO[1])}, ${f(CONCAVE_TONE[0])}, ${f(CONCAVE_TONE[1])});
  edge *= slateRemap(ao, ${f(CONVEX_GATE[0])}, ${f(CONVEX_GATE[1])}, 0.0, 1.0);
  diffuseColor.rgb = mix(base * tone, ${glslColor(LINE)}, edge);
}`,
      );
  };
  m.customProgramCacheKey = () => "formation-slate-v1";
  // Three's dielectric reflectance at Specular 0.5 is 0.04; Principled's
  // level scales it, so 0.1 is 0.008.
  m.specularIntensity = SPECULAR / 0.5;
  shared = m;
  return m;
}

// A geometry.glb mesh made ready for the slate: its attributes under the
// names the shader reads (GLTFLoader lower-cases a custom one, and an
// identifier starting with "_" is not one GLSL may take), its positions out
// of the optimiser's quantised frame into the rock's own (the noises are of
// the rock's coordinates), its node transform folded in. Returns false for a
// mesh that has no slate attributes, which keeps whatever it wore.
export function prepareSlateGeometry(mesh: THREE.Mesh, toRock: THREE.Matrix4): boolean {
  const g = mesh.geometry;
  const facet = g.getAttribute("_facet");
  if (!facet) return false;
  const out = new THREE.BufferGeometry();
  const floats = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute => {
    const arr = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) arr[i * a.itemSize + k] = a.getComponent(i, k);
    return new THREE.BufferAttribute(arr, a.itemSize);
  };
  const position = floats(g.getAttribute("position"));
  position.applyMatrix4(toRock);
  out.setAttribute("position", position);
  const normal = g.getAttribute("normal");
  if (normal) {
    const n = floats(normal);
    // Normalised per vector by `Vector3.applyNormalMatrix`.
    n.applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(toRock));
    out.setAttribute("normal", n);
  }
  out.setAttribute("aFacet", floats(facet));
  const edge = g.getAttribute("_edge");
  const crease = g.getAttribute("_crease");
  out.setAttribute("aEdge", edge ? floats(edge) : new THREE.BufferAttribute(new Float32Array(position.count * 3).fill(1e3), 3));
  out.setAttribute("aCrease", crease ? floats(crease) : new THREE.BufferAttribute(new Float32Array(position.count * 3), 3));
  if (g.index) out.setIndex(g.index.clone());
  out.computeBoundingBox();
  out.computeBoundingSphere();
  mesh.geometry = out;
  g.dispose();
  mesh.material = formationSlateMaterial();
  return true;
}
