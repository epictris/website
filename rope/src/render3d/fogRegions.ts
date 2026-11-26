// The level's fog, region by region. A region (`FogRegionData`) is a volume
// drawn on the gameplay plane with air of its own: an amount (its `FogExp2`
// density, `environment.ts`) and a colour. Regions mask the view at the
// gameplay plane, so near rock and distant backdrop fade at the same authored
// boundary. They do not change sunlight, ambient light or exposure.
//
// THE OVERLAP RULE. Each region gives a ray its own fog factor,
// f_i = w_i * (1 - exp(-(density_i * depth)^2)), w_i its smoothstep edge
// weight where the ray crosses the plane. Overlaps do not add: the surface
// takes the thickest, F = max_i f_i, so two regions laid over each other are
// never foggier than the foggier of them. The colour it mixes toward is the
// regions' colours weighted by what each gives, sum f_i c_i / sum f_i, so the
// tint slides from one region's air to the other's across an overlap rather
// than switching at a line. One region is exactly the old global law masked
// by its edge: F = w * law(depth), its own colour outright, in the same
// float32s three's `fogColor` uniform would carry ("THE COLOUR, TWICE").
//
// No regions authored (`fogRegions` absent) is the level-wide fog of three's
// own uniforms (`fogDensity`, `fogColor`), untouched: `enabled` is 0 and the
// shaders take that path.
import * as THREE from "three";
import { DEFAULT_FOG_FALLOFF, type FogRegionData } from "../level/levelFormat";

// A region's air: the colour to mix toward, as the `THREE.Color` of its hex
// (in the working colour space, as `scene.fog.color` holds it), and its
// `FogExp2` density. Resolved by `Environment.setFogRegions` (`regionAirOf`),
// which knows the level-wide fallbacks.
export interface RegionAir {
  color: THREE.Color;
  density: number;
}

// THE COLOUR, TWICE. Three does not hand `fogColor` to a shader as the
// working-space colour: `refreshFogUniforms` converts it per draw into the
// colour space the frame is being written in (`getUnlitUniformColorSpace`) -
// the screen's (`renderer.outputColorSpace`, sRGB) drawing to the canvas, the
// working space's (linear) into a render target - because the fog is mixed
// after the frame is converted to its output space. A texture cannot change
// per draw, so it holds both, converted on the CPU by the same
// `Color.getRGB`, and each program reads the one its own output space names
// (`fogRegionColours`). Bit for bit the uniform's values: a single working
// colour converted in GLSL would be within a rounding of them, and was
// measured 2/255 off on 3,754 pixels of the ball.
//
// Texels per region, one row each:
//   0 pose:   x, y (the level's, y down), cos(rot), sin(rot)
//   1 shape:  half width (or radius), half height (or radius), falloff, 1 if a circle
//   2 air:    working-space colour r, g, b, FogExp2 density
//   3 screen: the colour in the screen's colour space, r, g, b, unused
const TEXELS = 4;

// A plain container: three's uniform clone keeps this by reference. Updating
// the texture/count therefore reaches every built-in and custom fog shader.
// `shown` is the editor's "show fog" switch for the regions' own air
// (`Environment.setFogShown`); the level-wide fog is hidden by its density.
const state = {
  data: new THREE.DataTexture(new Float32Array(4 * TEXELS), TEXELS, 1, THREE.RGBAFormat, THREE.FloatType),
  count: 0,
  enabled: 0,
  shown: 1,
};
state.data.needsUpdate = true;

export function fogRegionUniforms(): Record<string, THREE.IUniform> {
  return { fogRegions: { value: state } };
}

// The regions every shader reads, with their resolved air (`air[i]` is
// `regions[i]`'s). Undefined is the level-wide fog. `screen` is the
// renderer's `outputColorSpace`, the colour space the canvas is written in.
export function setFogRegions(
  regions: readonly FogRegionData[] | undefined,
  air: readonly RegionAir[] = [],
  screen: THREE.ColorSpace = THREE.SRGBColorSpace,
): void {
  const count = regions?.length ?? 0;
  const values = new Float32Array(Math.max(1, count) * TEXELS * 4);
  const shown = { r: 0, g: 0, b: 0 };
  for (const [i, r] of (regions ?? []).entries()) {
    const a = air[i];
    if (a) a.color.getRGB(shown, screen);
    values.set([r.x, r.y, Math.cos(r.rot), Math.sin(r.rot),
      r.shape.kind === "circle" ? r.shape.r : r.shape.w / 2,
      r.shape.kind === "circle" ? r.shape.r : r.shape.h / 2,
      Math.max(0, r.falloff ?? DEFAULT_FOG_FALLOFF), r.shape.kind === "circle" ? 1 : 0,
      a?.color.r ?? 0, a?.color.g ?? 0, a?.color.b ?? 0, a?.density ?? 0,
      a ? shown.r : 0, a ? shown.g : 0, a ? shown.b : 0, 0], i * TEXELS * 4);
  }
  const texture = new THREE.DataTexture(values, TEXELS, Math.max(1, count), THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  state.data.dispose();
  state.data = texture;
  state.count = count;
  state.enabled = regions === undefined ? 0 : 1;
}

// The regions' air drawn or held at none (the editor's fog toggle).
export function setFogRegionsShown(shown: boolean): void {
  state.shown = shown ? 1 : 0;
}

// What the shaders are reading now, for the cases.
export function fogRegionState(): Readonly<typeof state> {
  return state;
}

// One region's edge weight at (x, y): 1 inside, easing to 0 over `falloff`
// inside the edge, 0 outside. Level coordinates (x right, y down), metres.
function edgeWeight(r: FogRegionData, x: number, y: number): number {
  const dx = x - r.x, dy = y - r.y, c = Math.cos(r.rot), s = Math.sin(r.rot);
  const u = dx * c + dy * s, v = -dx * s + dy * c;
  const inside = r.shape.kind === "circle"
    ? r.shape.r - Math.hypot(u, v)
    : Math.min(r.shape.w / 2 - Math.abs(u), r.shape.h / 2 - Math.abs(v));
  const falloff = Math.max(0, r.falloff ?? DEFAULT_FOG_FALLOFF);
  const t = falloff > 0 ? Math.min(1, Math.max(0, inside / falloff)) : Number(inside >= 0);
  return t * t * (3 - 2 * t);
}

// CPU counterpart of `regionFogAt`, used for editor guides and the
// boundary/overlap checks: the strongest edge weight at (x, y), where the
// regions put any air at all. Level coordinates (x right, y down), metres.
export function fogRegionWeight(regions: readonly FogRegionData[] | undefined, x: number, y: number): number {
  if (regions === undefined) return 1;
  let weight = 0;
  for (const r of regions) weight = Math.max(weight, edgeWeight(r, x, y));
  return weight;
}

// CPU counterpart of `regionFog`: the fog factor a surface `depth` metres of
// air away takes on a ray crossing the plane at (x, y), and the colour it is
// mixed toward (null where no region gives it any). The same law, max and
// running weighted mean as the shader, step for step, in doubles.
export function fogRegionFog(
  regions: readonly FogRegionData[],
  air: readonly RegionAir[],
  x: number,
  y: number,
  depth: number,
): { factor: number; tint: THREE.Color | null } {
  let factor = 0;
  let total = 0;
  let tint: THREE.Color | null = null;
  for (const [i, r] of regions.entries()) {
    const a = air[i];
    if (!a) continue;
    const f = edgeWeight(r, x, y) * (1 - Math.exp(-a.density * a.density * depth * depth));
    if (!(f > 0)) continue;
    tint = tint ? tint.lerp(a.color, f / (total + f)) : a.color.clone();
    total += f;
    factor = Math.max(factor, f);
  }
  return { factor, tint };
}

// `regionFog` keeps its tint as a running weighted mean rather than a sum
// divided at the end, so a ray only one region fogs takes that region's
// colour bit for bit (a sum f*c divided by f need not be c in floats), which
// is what keeps one region at the old global fog's exact picture.
export const REGION_FOG_GLSL = /* glsl */ `
struct FogRegionUniforms { sampler2D data; int count; int enabled; float shown; };
uniform FogRegionUniforms fogRegions;
// Region i's edge weight at a point of the plane (three's x, y: y up).
float fogRegionWeight( int i, vec2 point ) {
  vec4 pose = texelFetch( fogRegions.data, ivec2( 0, i ), 0 );
  vec4 shape = texelFetch( fogRegions.data, ivec2( 1, i ), 0 );
  vec2 d = vec2( point.x, -point.y ) - pose.xy;
  vec2 p = vec2( dot( d, pose.zw ), dot( d, vec2( -pose.w, pose.z ) ) );
  float inside = shape.w > 0.5 ? shape.x - length( p ) : min( shape.x - abs( p.x ), shape.y - abs( p.y ) );
  return shape.z > 0.0 ? smoothstep( 0.0, shape.z, inside ) : step( 0.0, inside );
}
// The strongest edge weight at a point: where the regions put any air at all.
// 1 everywhere with none authored.
float regionFogAt( vec2 point ) {
  if ( fogRegions.enabled == 0 ) return 1.0;
  float weight = 0.0;
  for ( int i = 0; i < fogRegions.count; i ++ ) weight = max( weight, fogRegionWeight( i, point ) );
  return weight;
}
// Where a view ray from the eye through a surface crosses the gameplay plane:
// the point the regions are read at.
vec2 regionFogPoint( vec3 eye, vec3 surface ) {
  float dz = surface.z - eye.z;
  return abs( dz ) > 1e-5 ? mix( eye.xy, surface.xy, -eye.z / dz ) : surface.xy;
}
// Which of a region's colours this program mixes the fog in (see "THE COLOUR,
// TWICE"): the working space's (texel 2) where the program writes the working
// space unchanged - into a render target - and the screen's (texel 3)
// otherwise. \`linearToOutputTexel\` is three's own conversion to this
// program's output space, so it is the identity exactly when three would hand
// \`fogColor\` over unconverted.
int fogRegionColours() {
  return linearToOutputTexel( vec4( 0.5, 0.5, 0.5, 1.0 ) ).r == 0.5 ? 2 : 3;
}
// The regions' fog on a ray crossing the plane at \`point\`, over \`depth\` of air:
// the factor (the thickest any region gives), and the colour to mix toward in
// \`tint\` (each region's weighted by what it gives, read from texel
// \`colours\`; left as it came where none gives any). Only with regions
// authored (\`fogRegions.enabled == 1\`).
float regionFog( vec2 point, float depth, int colours, inout vec3 tint ) {
  float factor = 0.0;
  float total = 0.0;
  for ( int i = 0; i < fogRegions.count; i ++ ) {
    float w = fogRegionWeight( i, point );
    if ( w <= 0.0 ) continue;
    float density = texelFetch( fogRegions.data, ivec2( 2, i ), 0 ).a;
    float f = w * ( 1.0 - exp( - density * density * depth * depth ) );
    if ( f <= 0.0 ) continue;
    vec3 colour = texelFetch( fogRegions.data, ivec2( colours, i ), 0 ).rgb;
    tint = total > 0.0 ? mix( tint, colour, f / ( total + f ) ) : colour;
    total += f;
    factor = max( factor, f );
  }
  return factor * fogRegions.shown;
}
`;
