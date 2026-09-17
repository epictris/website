// PAINTED LIGHT - the one shader patch every lit material in the scene wears,
// step two of the painterly look (step one painted the maps; see "Painted
// surfaces" in docs/asset-store.md). The maps carry flat planes of tone and
// crisp breaks; what this does is make the LIGHT fall on them the way a
// painter's does rather than the way a photograph's does, and it does it in
// three places inside three's own physically-based shading, leaving the lamps,
// the shadows, the fog and the tone mapping exactly as they are.
//
// 1. LIGHT FALLS IN BANDS. Lambert's dot(N, L) is a smooth cosine, so two
//    facets a few degrees apart merely shade, and a ball is a smooth gradient
//    from lit to dark - the roundness of a photograph. A painter lays a lit
//    plane down as one tone and the plane beside it as another, and a ball as
//    a lit crescent, a mid tone and a shadow tone with a soft turn between
//    them. So the cosine is run through `paintBands`: wrapped a little into
//    the shadow side (the fill of a real room, and what keeps a facet turned
//    just past the light from going black), then cut into a few bands with a
//    soft edge between neighbours. A facet - a plateau of one normal in the
//    painted maps - lands wholly in one band, so it is one tone; a smooth
//    sphere crosses the bands and turns in soft steps.
//
//    The same bands cut the HEMISPHERE fill's sky-to-ground blend, which in a
//    level lit mostly by fill (the ball arena's fill is twice its sun) is
//    where most of the tone is. The environment map's irradiance is left as it
//    is: it is a fraction of the light and already soft.
//
//    It is not a ramp that saturates - a wrap and a smoothstep that lights
//    every facet facing the sun fully - which is what this was first. Under a
//    sun that hits the wall nearly face-on that put every facet at the same
//    tone, and the painted facets that step one made were flattened away.
//
// 2. NOTHING IS GLOSSY. A painting has no pinpoint highlights; a sheen is a
//    broad soft light on the lit side. Roughness is given a floor, which
//    widens every highlight into a wash and blurs the environment a metal
//    reflects into a soft tone rather than a mirror of the sky. The floor
//    rather than a scale on the specular term, because a metal's whole colour
//    IS its specular - scaled down, the ball goes black - where a rougher metal
//    is the same metal, matte.
//
// 3. ENERGY IS ROUGHLY KEPT. A band's value is the cosine at its middle, so
//    the scene is neither brighter nor darker on average than the photographic
//    one under the same lamps; levels are not re-lit for it.
//
// It patches three's chunks by text, as the water does, and composes with a
// material that already has an `onBeforeCompile` (the water) by calling that
// one first. Every patched material's program cache key is extended, so a
// painted material and an unpainted one of the same kind never share a
// program (see `paintMaterial`).
//
// `?paint=0` turns it off for the session, which is how a change to it is
// judged: the same frame, painted and not, in the live browser (the headless
// runner's SwiftShader is not what the player sees).

import * as THREE from "three";

// How far the lit side wraps past the geometric terminator, in cosine units:
// 0 is Lambert's own edge, 1 lights the back of everything.
export const PAINT_WRAP = 0.15;
// The width of the terminator itself, in cosine units: the wrap fades out
// over this much of the turn so a normal facing away from a lamp gets none.
export const PAINT_TERMINATOR = 0.08;
// How many bands the wrapped cosine is cut into, shadow to full light.
export const PAINT_BANDS = 4;
// The soft edge between two bands, as a fraction of a band: 0 is a cel cut,
// 0.5 turns the bands back into a straight line.
export const PAINT_BAND_SOFTNESS = 0.2;
// The roughness floor: 0.0525 is three's own (a mirror), 1 is chalk.
export const PAINT_ROUGHNESS_FLOOR = 0.5;

const PARAM = "paint";

// Off for the session with `?paint=0`. Read once: a material is patched at
// creation, and a toggle that could change between two materials would give a
// scene that is half painted.
export const PAINT_ENABLED: boolean = (() => {
  if (typeof location === "undefined") return true;
  const v = new URLSearchParams(location.search).get(PARAM);
  return v === null || !(v === "0" || v === "false" || v === "off");
})();

const f = (x: number) => x.toFixed(4);

// The band function, defined ahead of every lighting chunk that uses it.
// `paintBands` takes a value in 0..1 and returns it cut into bands with soft
// edges; `paintLambert` wraps a cosine first.
const BANDS_GLSL = `
#define PAINT_ROUGHNESS_FLOOR ${f(PAINT_ROUGHNESS_FLOOR)}
float paintBands( float x ) {
  float b = clamp( x, 0.0, 1.0 ) * ${f(PAINT_BANDS)};
  float i = floor( b );
  float t = smoothstep( ${f(0.5 - PAINT_BAND_SOFTNESS)}, ${f(0.5 + PAINT_BAND_SOFTNESS)}, b - i );
  // The band's value is the cosine at its middle, not its top, so the bands
  // average to the line they replace.
  return min( ( i + t + 0.5 ) / ${f(PAINT_BANDS)}, 1.0 ) - ${f(0.5 / PAINT_BANDS)};
}
float paintLambert( float cosine ) {
  // The wrap lifts the lit side toward the terminator; it never lights a
  // normal turned AWAY from the lamp. Past the geometric terminator the
  // shadow map is at its least reliable (a grazing depth test), and the wrap
  // fed sun to exactly those texels, which drew as white speckles along
  // every crack of a face turned from the sun.
  float facing = smoothstep( 0.0, ${f(PAINT_TERMINATOR)}, cosine );
  return paintBands( ( cosine + ${f(PAINT_WRAP)} ) / ${f(1 + PAINT_WRAP)} ) * facing;
}
`;

// The three chunks with the paint in them. Built once: the text is the same
// for every material. Each replacement is asserted, so a three.js upgrade that
// rewrites a line fails loudly here rather than quietly unpainting the game.
function patched(chunk: keyof typeof THREE.ShaderChunk, from: string, to: string): string {
  const out = THREE.ShaderChunk[chunk].replace(from, to);
  if (out === THREE.ShaderChunk[chunk]) throw new Error(`paint: three's ${chunk} no longer has: ${from}`);
  return out;
}
const PAINTED_LIGHTS =
  BANDS_GLSL +
  patched(
    "lights_pars_begin",
    "float hemiDiffuseWeight = 0.5 * dotNL + 0.5;",
    "float hemiDiffuseWeight = paintBands( 0.5 * dotNL + 0.5 );",
  );
const PAINTED_PHYSICAL = patched(
  "lights_physical_pars_fragment",
  "float dotNL = saturate( dot( geometryNormal, directLight.direction ) );",
  "float dotNL = paintLambert( dot( geometryNormal, directLight.direction ) );",
);
const PAINTED_MATERIAL = patched(
  "lights_physical_fragment",
  "material.roughness = max( roughnessFactor, 0.0525 );",
  "material.roughness = max( roughnessFactor, PAINT_ROUGHNESS_FLOOR );",
);

// Wear the painted light. Idempotent, and a no-op for a material with no
// lighting to paint (a basic or a depth material) and for the session that
// asked for none.
export function paintMaterial(material: THREE.Material): void {
  if (!PAINT_ENABLED) return;
  if (!(material as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
  const tagged = material as THREE.Material & { __painted?: true };
  if (tagged.__painted) return;
  tagged.__painted = true;

  const previous = material.onBeforeCompile;
  // The key the material had BEFORE this patch, whether its own (the water's
  // "water") or three's default, which is the source of the hook it had then -
  // captured now, because after the swap the default would read the wrapper
  // below, whose text is the same for every material, and two materials with
  // different hooks under it would share one program.
  const ownKey = Object.prototype.hasOwnProperty.call(material, "customProgramCacheKey")
    ? material.customProgramCacheKey.bind(material)
    : () => previous.toString();
  material.customProgramCacheKey = () => `${ownKey()}|paint`;

  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <lights_pars_begin>", PAINTED_LIGHTS)
      .replace("#include <lights_physical_pars_fragment>", PAINTED_PHYSICAL)
      .replace("#include <lights_physical_fragment>", PAINTED_MATERIAL);
  };
}

// Every lit material under a node, for a prop that arrived with its own.
export function paintTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) paintMaterial(m);
  });
}
