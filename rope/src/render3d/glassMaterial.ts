// What the glass ball, its chain, its manacle and its shards are made of (the
// Hard difficulty, see `BallPlayer.glass`). Two kinds of glass, because glass
// looks like what it is SHAPED like:
//
//   SOLID - the ball, its loop, its links and its cuff: round glass, which
//           is a lens. `solidGlassMaterial`.
//   THIN  - the shards, plates of a wall a few millimetres thick, which bend
//           nothing. `glassMaterial`. (Until 2026-10-16 the ball was a hollow
//           shell of it too - "a blue bubble", lost against the cave -
//           and `?glass=hollow` still draws that while the two are compared.)
//
// Both reflect what Fresnel's equations give for glass (n = 1.5): 4% face-on,
// rising to all of it at grazing incidence, through three's own physical
// specular. They differ in what comes THROUGH.
//
// NEITHER RENDERS THE SCENE AGAIN. Three's transmission would: a transmissive
// material makes it redraw the whole opaque scene into a full-size target each
// frame, mipmap it, and do it once more inside every other render that sees the
// material (the pool's mirror). That was the solid ball's first version, and
// it was "massive performance drops while the glass ball is active" (Tris,
// 2026-10-16). What comes through solid glass is read from the ball's
// reflection probe instead, which is already drawn (see `solidGlassMaterial`),
// and what comes through thin glass is the frame behind it, by blending.
//
// WHAT IS LEFT OUT of both: absorption (clear glass absorbs well under 1% over
// these lengths), caustics, and shadows: a glass ball's shadow is a faint ring
// around a bright focus, which a shadow map cannot draw, and a solid black disc
// under a clear ball would be the one thing about it that is wrong.

import * as THREE from "three";
import { AVATAR_FOG, avatarFogChunk } from "./avatarSurface";
import { wearProbe } from "./reflectionProbe";

// Glass's refractive index, the one number the optics are drawn from:
// F0 = ((n - 1) / (n + 1))^2 = 0.04 for crown glass.
export const GLASS_IOR = 1.5;
const F0 = ((GLASS_IOR - 1) / (GLASS_IOR + 1)) ** 2;

// How rough the thin glass is: polished, so a lamp is a pinpoint on it. Not
// zero, which aliases a sub-pixel highlight into a shimmer as a shard tumbles.
const GLASS_ROUGHNESS = 0.04;

// The lines of three's shaders this rewrites, named so a three upgrade that
// rewords either fails loudly rather than drawing the glass opaque (see the
// same rule in avatarSurface.ts).
const OPAQUE_LINE = "gl_FragColor = vec4( outgoingLight, diffuseColor.a );";
const FOG_MIX = "gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );";

function glslFloat(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

// Schlick's approximation to the Fresnel reflectance at a cosine.
const SCHLICK = (cosine: string): string =>
  `( ${glslFloat(F0)} + ${glslFloat(1 - F0)} * pow( 1.0 - saturate( ${cosine} ), 5.0 ) )`;

// ---------------------------------------------------------------------------
// SOLID glass: a lens, traced, seeing the room through the reflection probe
// ---------------------------------------------------------------------------
//
// A solid glass sphere is a "ball lens", and that is what makes it read as an
// object: the room behind it is seen through it upside down and shrunk, its
// rim goes dark where the rays entering it bend in from the floor and the walls
// to the sides, and the room's lamps sit on its front as sharp reflections.
//
// THE PATH IS TRACED per fragment (`solidGlassChunk`), in view space:
//
//   1. refracted into the glass at the surface it hits (Snell, n = 1.5),
//   2. carried across to where it meets the far surface - a chord of the
//      sphere of radius `lensRadius` whose surface this is, centred one radius
//      in along the normal,
//   3. refracted out. Always: a sphere meets a ray at its far surface at the
//      angle it refracted in at, so nothing that entered is ever trapped past
//      the critical angle,
//   4. and the light arriving along that exit direction read from the ball's
//      REFLECTION PROBE (reflectionProbe.ts) - a cube of the room seen from the
//      ball's centre with the ball and its chain left out, which the ball
//      draws one face a frame for its own reflection anyway. For the ball it is
//      the exact picture: every exit ray starts inside the sphere the probe sits
//      at the centre of. It also needs no guess at how far behind the scenery
//      stands, which a screen-space read would. And from the scene's LIGHTS,
//      which a probe of the room does not hold (see "THE TWO PATHS" below).
//
// Both surfaces' Fresnel losses are taken off what comes through, and the front
// surface's reflection is three's specular, lit from the same probe. The trace
// is run per colour channel and along a second, once-reflected path as well:
// dispersion and the rainbow (see `GLASS_IOR_RGB`).
//
// THE LOOP, THE LINKS AND THE CUFF are round bar, and the same trace serves them
// with `lensRadius` the bar's: the centre one radius in along the normal is the
// bar's own centreline, so in the plane across the bar the trace is exact, and
// along the bar - where a cylinder bends nothing and the sphere bends a little
// - it is near enough at a few millimetres across. What they see is still the
// probe's view from the ball's centre, which for a link a metre away is the room
// from a metre off; a refracted sliver a few pixels wide does not show it.

const LENS_LINE = OPAQUE_LINE;

// Three's `opaque_fragment` with the traced lens. Needs `wearProbe`'s uniforms
// (`probeCube`, `probeOn`, `probeIntensity`) and the material's `lensRadius`.
// Exported so `cli render3d` can read it without a GPU.
// DISPERSION: glass bends blue more than red, so every traced path is traced
// three times, once per channel, with that channel's index - Schott N-BK7 at
// the C (656 nm), d (588 nm) and F (486 nm) lines, Abbe number 64. Through a
// ball lens that splits each bright edge seen through it into colour toward
// the rim, and splits a lamp's internal-reflection flash into a small rainbow.
export const GLASS_IOR_RGB: readonly [number, number, number] = [1.5143, 1.5168, 1.5224];

// THE TWO PATHS traced per channel, from where the view ray meets the glass:
//
//   A - STRAIGHT THROUGH: refracted in, across, refracted out (a sphere never
//       traps a ray past the critical angle, see the header).
//   B - ONCE REFLECTED INSIDE: refracted in, reflected off the inside of the
//       far surface (the share Fresnel reflects there), across again, out. It
//       is the raindrop's path, and with dispersion it is the rainbow: for
//       n = 1.5 its exit directions bunch at about 23 degrees from the point
//       opposite a light, so a lamp behind the viewer flashes in colour near
//       the rim. Faint against the room (a few percent of it), bright against
//       a lamp.
//
// Each path's exit direction is what it SEES: the reflection probe (the room
// and the sky), and - because a probe of the room holds no lamps, only what
// they light - every one of the scene's own lights, read where three reads
// them for the surface (`lensSeeLight`, in each light's loop), with the light's
// own attenuation and SHADOW, so a lamp the ball cannot see is not seen through
// it either. That is what makes it hold in any lighting: nothing here is
// authored for a level, it is the level's own lights and surroundings.
//
// A lamp is far smaller than a pixel's worth of exit directions, so it is drawn
// as its energy spread over that pixel's footprint (`lensLobe`) - a sharp
// point when the ball is close, a soft spark when it is far, the same light
// either way.

// The angular radius below which a light is a point (radians): a bulb a few
// centimetres across a metre or two away. It only matters where the ball is
// big enough on screen to resolve it.
const LIGHT_ANGLE = 0.012;

// Declarations ahead of `main`: the lobe a light is spread over.
const LENS_PARS = /* glsl */ `
float lensLobe( const in vec3 dir, const in vec3 toLight, const in float width ) {
	float a = acos( clamp( dot( dir, toLight ), - 1.0, 1.0 ) );
	// A disc of radius \`width\`, its edge softened, normalised to the solid angle
	// it covers (0.625 pi w^2 for this falloff) so the light's energy is kept.
	return ( 1.0 - smoothstep( 0.5 * width, width, a ) ) / ( 0.625 * PI * width * width );
}
`;

// Before three's lights loop: the two paths, per channel.
function lensTraceChunk(): string {
  const [r, g, b] = GLASS_IOR_RGB.map(glslFloat);
  return `
	vec3 lensP = - vViewPosition;
	vec3 lensN = normalize( normal );
	vec3 lensD = isOrthographic ? vec3( 0.0, 0.0, - 1.0 ) : normalize( lensP );
	vec3 lensC = lensP - lensN * lensRadius;
	float lensFin = ${SCHLICK("dot( lensN, - lensD )")};
	vec3 lensIor = vec3( ${r}, ${g}, ${b} );
	vec3 lensOutA[ 3 ];
	vec3 lensOutB[ 3 ];
	vec3 lensPassA;
	vec3 lensPassB;
	for ( int c = 0; c < 3; c ++ ) {
		float n = lensIor[ c ];
		// In.
		vec3 d1 = refract( lensD, lensN, 1.0 / n );
		// Across: from a point ON the sphere, the chord along a unit direction
		// is -2 (p - c) . d long.
		float chord1 = 2.0 * lensRadius * dot( lensN, - d1 );
		vec3 at1 = lensP + d1 * chord1;
		vec3 in1 = normalize( lensC - at1 );
		// A: out through the far surface, losing what it reflects back.
		vec3 o1 = refract( d1, in1, n );
		float f1 = ${SCHLICK("dot( o1, - in1 )")};
		lensOutA[ c ] = o1;
		// Absorbed along the way (Beer-Lambert) over the chord crossed.
		lensPassA[ c ] = ( 1.0 - lensFin ) * ( 1.0 - f1 ) * exp( - lensAbsorb[ c ] * chord1 );
		// B: what the far surface reflected, across again, and out.
		vec3 d2 = reflect( d1, in1 );
		float chord2 = 2.0 * lensRadius * dot( in1, d2 );
		vec3 at2 = at1 + d2 * chord2;
		vec3 in2 = normalize( lensC - at2 );
		vec3 o2 = refract( d2, in2, n );
		float f2 = ${SCHLICK("dot( o2, - in2 )")};
		lensOutB[ c ] = o2;
		lensPassB[ c ] = ( 1.0 - lensFin ) * f1 * ( 1.0 - f2 ) * exp( - lensAbsorb[ c ] * ( chord1 + chord2 ) );
	}
	// How far the exit directions turn across one pixel: what a light smaller
	// than that is spread over (see \`lensLobe\`). Taken here, outside any branch.
	float lensWidthA = max( length( fwidth( lensOutA[ 1 ] ) ), ${glslFloat(LIGHT_ANGLE)} );
	float lensWidthB = max( length( fwidth( lensOutB[ 1 ] ) ), ${glslFloat(LIGHT_ANGLE)} );
	// What the scene's lights put down the two paths, gathered in their loops.
	vec3 lensLights = vec3( 0.0 );
`;
}

// Three's call that lights the surface for one light, once per point, spot and
// directional light, with that light's view-space direction and its colour
// already attenuated and shadowed. The lens reads the same light right after.
const RE_DIRECT =
  "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";

function lensLightsChunk(): string {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  if (chunk.split(RE_DIRECT).length - 1 !== 3) {
    throw new Error("glassMaterial: three's lights_fragment_begin no longer calls RE_Direct once per light kind; the lens lights patch matches nothing");
  }
  const see = `${RE_DIRECT}
		{
			vec3 lensL = normalize( directLight.direction );
			for ( int c = 0; c < 3; c ++ ) {
				lensLights[ c ] += directLight.color[ c ] * (
					lensPassA[ c ] * lensLobe( lensOutA[ c ], lensL, lensWidthA ) +
					lensPassB[ c ] * lensLobe( lensOutB[ c ], lensL, lensWidthB ) );
			}
		}`;
  return chunk.split(RE_DIRECT).join(see);
}

// Three's `opaque_fragment`: what the two paths see of the room, added to the
// lights they saw, and to the surface's own reflection.
export function solidGlassChunk(): string {
  const chunk = THREE.ShaderChunk.opaque_fragment;
  if (!chunk.includes(LENS_LINE)) {
    throw new Error("glassMaterial: three's opaque_fragment chunk changed; the lens patch matches nothing");
  }
  const composite = `
	// Through grease the room is hazed - the film scatters what crosses it as
	// it scatters what it reflects - so it is read from a blurrier mip.
	float lensLod = glassSmudge * ${glslFloat(GREASE_HAZE_MIPS)};
	vec3 lensRoom = vec3( 0.0 );
	for ( int c = 0; c < 3; c ++ ) {
		vec3 seenA = vec3( 0.0 );
		vec3 seenB = vec3( 0.0 );
		if ( probeOn ) {
			seenA = textureLod( probeCube, transformDirectionByInverseViewMatrix( lensOutA[ c ], viewMatrix ), lensLod ).rgb;
			seenB = textureLod( probeCube, transformDirectionByInverseViewMatrix( lensOutB[ c ], viewMatrix ), lensLod ).rgb;
			seenA *= probeIntensity;
			seenB *= probeIntensity;
		} else {
			// The level's sky until the probe has drawn. Reflecting a direction
			// off itself is the direction.
			#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
				seenA = getIBLRadiance( lensOutA[ c ], lensOutA[ c ], glassSmudge * ${glslFloat(GREASE_ROUGHNESS)} );
				seenB = getIBLRadiance( lensOutB[ c ], lensOutB[ c ], glassSmudge * ${glslFloat(GREASE_ROUGHNESS)} );
			#endif
		}
		lensRoom[ c ] = seenA[ c ] * lensPassA[ c ] + seenB[ c ] * lensPassB[ c ];
	}
	// A speck of dust is opaque: what it covers comes through it not at all.
	gl_FragColor = vec4( outgoingLight + ( lensRoom + lensLights ) * ( 1.0 - glassDust ), 1.0 );`;
  return chunk.replace(LENS_LINE, composite);
}

// THE WEAR on a glass orb that has been handled (Tris, 2026-10-16: "slight
// surface imperfections/smudge/dust marks ... as realistic as possible"):
// fingerprints, wiped smears and dust, baked once into a mipmapped cube texture
// in the ball's own frame (glassWear.ts has why and how) and read here by the
// direction from the ball's centre, so it rolls with the ball. One filtered
// texture read; the mips are what keep it from shimmering at any distance.
//
// Each is a different physical change to the surface:
//
//   GREASE (R) - skin oil. A greasy surface is rough rather than polished, so
//                the reflection blurs there (three's roughness, raised toward
//                `GREASE_ROUGHNESS`), the room seen through it hazes the same
//                way (a blurrier probe mip), and the film scatters a little of
//                the light that falls on it back out milky (`GREASE_SCATTER`).
//   DUST (G,B) - grains on the surface: a diffuse grey solid (B is how light),
//                lit by the room's lamps like any matt surface, and opaque, so
//                nothing comes through where it lies.
//
// Only the ball wears it: on a link 6 mm across it is below anything a pixel
// can show.

// How rough full grease is (three's roughness, 0 polished to 1 matt).
const GREASE_ROUGHNESS = 0.45;
// How many probe mips full grease blurs the view through it by.
const GREASE_HAZE_MIPS = 3;
// The share of the light on it a full grease film scatters back as a milky
// diffuse - which in a dim cave is most of what makes a print visible at all.
const GREASE_SCATTER = 0.1;
// ...and what a fully scratched texel scatters (SCUFFS, A): a scratch's walls
// are rough fractures, far whiter than a film of oil.
const SCUFF_SCATTER = 0.18;

// Declarations ahead of `main`.
const WEAR_PARS = /* glsl */ `
varying vec3 vGlassLocal;
#ifdef GLASS_WEAR
	uniform samplerCube glassWear;
#endif
`;

// After three's `color_fragment`: the wear at this fragment, and what it adds
// to the diffuse of what was black glass.
const WEAR_FRAGMENT = /* glsl */ `
	float glassSmudge = 0.0;
	float glassDust = 0.0;
	#ifdef GLASS_WEAR
		vec4 glassWorn = texture( glassWear, vGlassLocal );
		// A scratch roughens the surface as grease does, and scatters more of
		// the light that falls on it: it shows as a fine bright line.
		glassSmudge = max( glassWorn.r, glassWorn.a );
		glassDust = glassWorn.g;
		diffuseColor.rgb += vec3( ${glslFloat(GREASE_SCATTER)} ) * glassWorn.r + vec3( ${glslFloat(SCUFF_SCATTER)} ) * glassWorn.a;
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( glassWorn.b ), glassDust );
	#endif
`;

// After three's `roughnessmap_fragment`: the grease's roughness.
const WEAR_ROUGHNESS = /* glsl */ `
	roughnessFactor = max( roughnessFactor, glassSmudge * ${glslFloat(GREASE_ROUGHNESS)} );
`;

// What the solid glass absorbs, per metre of glass crossed, red/green/blue.
// Zero is clear glass. Shared by every solid glass material on the page, so
// one write retints the ball, its loop, its chain and its cuff together.
export const GLASS_ABSORPTION: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0, 0) };

export const SOLID_GLASS_PROGRAM_KEY = `ball-lens:${GLASS_IOR_RGB.join(",")}:paths-ab:${LIGHT_ANGLE}|wear:${GREASE_ROUGHNESS}:${GREASE_HAZE_MIPS}:${GREASE_SCATTER}:${SCUFF_SCATTER}|avatar-fog:${AVATAR_FOG}`;

// Solid round glass whose surface curves at `lensRadius` (metres): the ball's
// radius for the ball, a bar's for a link, the loop or the cuff. Lit and seen
// through from the ball's reflection probe (`setProbe` it every frame).
//
// `wear`: the baked surface wear the ball carries (glassWear.ts), or null for
// clean glass.
export function solidGlassMaterial(
  lensRadius: number,
  wear: THREE.CubeTexture | null = null,
): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    // No diffuse: glass scatters nothing. What it shows is reflected (three's
    // specular) or comes through (the trace).
    color: 0x000000,
    metalness: 0,
    roughness: 0,
    ior: GLASS_IOR,
    specularIntensity: 1,
  });
  mat.name = "solid-glass";
  if (wear) mat.defines = { ...mat.defines, GLASS_WEAR: "" };
  const radius = { value: lensRadius };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.lensRadius = radius;
    shader.uniforms.lensAbsorb = GLASS_ABSORPTION;
    if (wear) shader.uniforms.glassWear = { value: wear };
    for (const line of ["#include <begin_vertex>"]) {
      if (!shader.vertexShader.includes(line)) throw new Error(`glassMaterial: three's vertex shader has no ${line}`);
    }
    for (const line of ["#include <color_fragment>", "#include <roughnessmap_fragment>", "#include <lights_fragment_begin>"]) {
      if (!shader.fragmentShader.includes(line)) throw new Error(`glassMaterial: three's fragment shader has no ${line}`);
    }
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "varying vec3 vGlassLocal;\nvoid main() {")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n\tvGlassLocal = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `uniform float lensRadius;\nuniform vec3 lensAbsorb;\n${WEAR_PARS}\n${LENS_PARS}\nvoid main() {`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${WEAR_FRAGMENT}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${WEAR_ROUGHNESS}`)
      .replace("#include <lights_fragment_begin>", `${lensTraceChunk()}\n${lensLightsChunk()}`)
      .replace("#include <opaque_fragment>", solidGlassChunk())
      // Opaque, so the avatar's thinner air is the plain chunk's patch.
      .replace("#include <fog_fragment>", avatarFogChunk());
  };
  mat.customProgramCacheKey = () => SOLID_GLASS_PROGRAM_KEY;
  // After the lens patch, which reads the probe's uniforms: `wearProbe` chains
  // onto the `onBeforeCompile` it finds and declares them ahead of `main`.
  wearProbe(mat);
  return mat;
}

// ---------------------------------------------------------------------------
// THIN glass: a wall, blended
// ---------------------------------------------------------------------------
//
// A wall a few millimetres thick shifts what is behind it sideways by a
// fraction of its own thickness, so the background through it is the
// background, and the glass is a blend: each surface passes (1 - F) of what
// reaches it and adds its own reflection, so a wall - two surfaces - is drawn
// premultiplied, as
//
//   colour = reflection + background * (1 - F)^2
//
// with three's own physical lighting supplying the reflection (the inner
// surface reflects the same again, less what the outer one kept). Drawn
// double-sided, three draws the far face and then the near one, which is the
// light path's own order.
//
// THE AVATAR'S THINNER AIR is kept (`AVATAR_FOG`), rewritten for a premultiplied
// colour: the fog is laid over the light the glass ITSELF adds, in proportion to
// how much of the background it hides, because the background behind it has
// had its own fog already.

// Three's `opaque_fragment` chunk, with the wall's coverage as the alpha.
// Exported so `cli render3d` can read it without a GPU.
export function glassOpaqueChunk(): string {
  const chunk = THREE.ShaderChunk.opaque_fragment;
  if (!chunk.includes(OPAQUE_LINE)) {
    throw new Error("glassMaterial: three's opaque_fragment chunk changed; the glass patch matches nothing");
  }
  return chunk.replace(
    OPAQUE_LINE,
    [
      // The reflectance at this fragment's view angle. `normal` faces the
      // viewer on both faces (three flips it on a back face), so it is the
      // angle at whichever surface this is.
      `float glassF = ${SCHLICK("dot( normal, geometryViewDir )")};`,
      // A wall's two surfaces, each passing (1 - F).
      "float glassT = ( 1.0 - glassF ) * ( 1.0 - glassF );",
      // The inner surface reflects as the outer does, of what the outer let in,
      // and passes it back out through the outer again.
      "vec3 glassLight = outgoingLight * ( 1.0 + glassT );",
      "gl_FragColor = vec4( glassLight, 1.0 - glassT );",
    ].join("\n"),
  );
}

// Three's `fog_fragment` chunk for a premultiplied colour, at the avatar's
// thinner air. Exported for `cli render3d`.
export function glassFogChunk(scale: number = AVATAR_FOG): string {
  const chunk = THREE.ShaderChunk.fog_fragment;
  if (!chunk.includes(FOG_MIX)) {
    throw new Error("glassMaterial: three's fog_fragment chunk changed; the glass fog patch matches nothing");
  }
  return chunk.replace(
    FOG_MIX,
    `gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * gl_FragColor.a, fogFactor * ${glslFloat(scale)} );`,
  );
}

// TEMPORARY, while the two are compared: which glass ball is drawn - the solid
// crystal ball (the default) or the hollow shell it replaced (`?glass=hollow`,
// set by main.ts like `waterShimmer`).
export const glassBallStyle: { value: "solid" | "hollow" } = { value: "solid" };

// TEMPORARY, for the same comparisons, read by main.ts and shotMain.ts off
// their URL: `?glass=hollow` (above) and `?glasstint=R,G,B`, the solid glass's
// absorption per metre (`GLASS_ABSORPTION`) - `glasstint=0.4,3,11` is amber.
export function glassOptionsFrom(params: URLSearchParams): void {
  if (params.get("glass") === "hollow") glassBallStyle.value = "hollow";
  const tint = params.get("glasstint")?.split(",").map(Number);
  if (tint?.length === 3 && tint.every((v) => Number.isFinite(v) && v >= 0)) {
    GLASS_ABSORPTION.value.set(tint[0]!, tint[1]!, tint[2]!);
  }
}

export const GLASS_PROGRAM_KEY = `glass-wall:${F0}|glass-fog:${AVATAR_FOG}`;

// A new thin-glass material. `probe`: lit from the ball's reflection probe as
// well as the room (see reflectionProbe.ts) - the shards, which fly from where
// the probe stands.
export function glassMaterial(probe = false): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    // No diffuse at all: glass scatters nothing, it reflects and transmits.
    color: 0x000000,
    metalness: 0,
    roughness: GLASS_ROUGHNESS,
    ior: GLASS_IOR,
    specularIntensity: 1,
    side: THREE.DoubleSide,
    transparent: true,
    // The background has been drawn; the glass is laid over it and hides
    // nothing behind it from what is drawn later. It is also what depth of
    // field reads as "a see-through thing near the plane" and draws sharp over
    // the blur (see depthOfField.ts `seeThrough`).
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  mat.name = "glass";
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <opaque_fragment>", glassOpaqueChunk())
      .replace("#include <fog_fragment>", glassFogChunk());
  };
  mat.customProgramCacheKey = () => GLASS_PROGRAM_KEY;
  // After the glass patch, so the probe's chains onto it (`wearProbe` keeps
  // whatever `onBeforeCompile` it finds).
  if (probe) wearProbe(mat);
  return mat;
}
