// What the glass ball, its chain, its manacle and its broken pieces are made of
// (the Hard difficulty, see `BallPlayer.glass`). Glass looks like what it is
// SHAPED like, so there are kinds of it:
//
//   SOLID  - its loop, its links and its cuff, and the ball when its wall is
//            as thick as it is (glassWall.ts): round quartz, which is a lens.
//            `solidGlassMaterial`.
//   HOLLOW - the ball: a quartz shell with a wall of a set thickness, coated
//            outside, seeing the frame behind it. `hollowGlassMaterial`.
//   PIECES - the broken ball's chunks: small, seen through.
//            `pieceGlassMaterial`, two blended draws.
//
// All reflect what Fresnel's equations give for quartz (n = 1.544): 4.6% face-on,
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
// what comes through the hollow ball from a patch of the frame copied out
// before it is drawn (frameCopy.ts), and what comes through a piece is the
// frame behind it, by blending.
//
// WHAT IS LEFT OUT of all of them: absorption (clear glass absorbs well under 1% over
// these lengths), caustics, and shadows: a glass ball's shadow is a faint ring
// around a bright focus, which a shadow map cannot draw, and a solid black disc
// under a clear ball would be the one thing about it that is wrong.

import * as THREE from "three";
import { AVATAR_FOG, avatarFogChunk } from "./avatarSurface";
import { wearProbe } from "./reflectionProbe";
import { COAT_IOR, COAT_THICKNESS_NM } from "./glassCoat";
import { FRAME_COPY_PARS } from "./frameCopy";
import { glassWallFrom } from "./glassWall";

export { COAT_IOR, COAT_THICKNESS_NM };

// The ball's refractive index, the one number the optics are drawn from. It
// is a CRYSTAL ball (Tris, 2026-10-16: "it should have the refractive index of
// quartz, not glass"): crystalline quartz's ordinary ray at the sodium d line,
// so F0 = ((n - 1) / (n + 1))^2 = 0.046. The shards are pieces of it. Quartz is
// birefringent (the extraordinary ray is 0.009 higher), which doubles what is
// seen through a real ball very slightly; one index is traced.
export const GLASS_IOR = 1.5443;
const F0 = ((GLASS_IOR - 1) / (GLASS_IOR + 1)) ** 2;


// The lines of three's shaders this rewrites, named so a three upgrade that
// rewords either fails loudly rather than drawing the glass opaque (see the
// same rule in avatarSurface.ts).
const OPAQUE_LINE = "gl_FragColor = vec4( outgoingLight, diffuseColor.a );";
const FOG_MIX = "gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );";

function glslFloat(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

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
//   1. refracted into the glass at the surface it hits (Snell, n = 1.544),
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
// DISPERSION: quartz bends blue more than red, so every traced path is traced
// three times, once per channel, with that channel's index - crystalline
// quartz's ordinary ray at the C (656 nm), d (588 nm) and F (486 nm) lines,
// Abbe number 70. Through a
// ball lens that splits each bright edge seen through it into colour toward
// the rim, and splits a lamp's internal-reflection flash into a small rainbow.
export const GLASS_IOR_RGB: readonly [number, number, number] = [1.5419, 1.5443, 1.5497];

// THE TWO PATHS traced per channel, from where the view ray meets the glass:
//
//   A - STRAIGHT THROUGH: refracted in, across, refracted out (a sphere never
//       traps a ray past the critical angle, see the header).
//   B - ONCE REFLECTED INSIDE: refracted in, reflected off the inside of the
//       far surface (the share Fresnel reflects there), across again, out. It
//       is the raindrop's path, and with dispersion it is the rainbow: for
//       n = 1.544 its exit directions bunch at about 19 degrees from the point
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

// THE AURORA COATING (Tris, 2026-10-16: an "aurora" crystal ball, "the most
// important part is the rainbow gradient inside it"). An aurora ball is clear
// crystal with a film a few hundred nanometres thick evaporated onto it (its
// material and thickness are in glassCoat.ts): light reflected off the film's
// top and off the glass under it interferes, so each surface reflects some
// wavelengths strongly (17.5% where the film is a quarter wave, against bare
// quartz's 4.6%) and passes the rest. The colour is the film's THICKNESS,
// and the film is not even: the vapour reached the side of the ball facing the
// source most, so it thins from one pole of the ball to the other and its
// colours run in bands across it - through one interference order, orange,
// magenta, purple, blue, green, yellow.
//
// The gradient seen INSIDE the ball is that film on the far side of it: every
// path through the lens leaves through the coated back surface, and the
// internally reflected one is reflected off it, at a place on the film the
// lens chose. So the film is not a tint laid on the front: every surface the
// trace crosses takes its Fresnel from the film where the ray crosses it
// (three's `evalIridescence`, Belcour & Barla's thin-film model, which is also
// what lights the front surface's own reflection). A lossless film reflects the
// same share from either side, so the inside reflections use the same function
// at the outside angle.
//
// The film's index and the thickness it runs between are in glassCoat.ts.
//
// OFF FOR NOW (Tris, 2026-10-16: "remove the coating temporarily"): the
// glass is bare quartz - three compiles no iridescence (`coatOptions`), and
// every surface the trace crosses takes Schlick's quartz (`filmFresnel`).
// `?glasscoat=1` puts the film back.
export const glassCoatShown: { value: boolean } = { value: false };

// The film as three's material options: three lights the front surface's
// reflection through it, and compiles `evalIridescence` for the trace.
function coatOptions(): THREE.MeshPhysicalMaterialParameters {
  return {
    iridescence: glassCoatShown.value ? 1 : 0,
    iridescenceIOR: COAT_IOR,
    iridescenceThicknessRange: [COAT_THICKNESS_NM[0], COAT_THICKNESS_NM[1]],
  };
}

// Three's surface set up, then the film's thickness at this fragment, `nm`.
function coatThicknessChunk(nm: string): string {
  return `#include <lights_physical_fragment>\n\t#ifdef USE_IRIDESCENCE\n\t\tmaterial.iridescenceThickness = ${nm};\n\t#endif`;
}

// Declarations ahead of `main`: the lobe a light is spread over, and the film.
const LENS_PARS = /* glsl */ `
varying vec3 vCoatAxis;
#ifdef COAT_FROM_ATTRIBUTE
	// A broken piece of the ball (glassShards.ts) carries the film it had where
	// it was on the ball, and none on a broken face (glassFracture.ts).
	varying float vCoatNm;
#endif
float coatAt( const in vec3 outward ) {
	#ifdef COAT_FROM_ATTRIBUTE
		return vCoatNm;
	#else
		// Thickest at the pole that faced the source, thinning toward the other.
		return mix( ${glslFloat(COAT_THICKNESS_NM[1])}, ${glslFloat(COAT_THICKNESS_NM[0])}, 0.5 - 0.5 * dot( outward, vCoatAxis ) );
	#endif
}
// The film's reflectance by the cosine on its air side, \`nm\` thick there; bare
// quartz's while the film is off (\`glassCoatShown\`), when three compiles no
// iridescence.
vec3 filmFresnel( const in float cosOutside, const in float nm ) {
	#ifdef USE_IRIDESCENCE
		return evalIridescence( 1.0, ${glslFloat(COAT_IOR)}, saturate( cosOutside ), nm, vec3( ${glslFloat(F0)} ) );
	#else
		return vec3( F_Schlick( ${glslFloat(F0)}, 1.0, saturate( cosOutside ) ) );
	#endif
}
vec3 coatFresnel( const in float cosOutside, const in vec3 outward ) {
	return filmFresnel( cosOutside, coatAt( outward ) );
}
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
	vec3 lensFin = coatFresnel( dot( lensN, - lensD ), lensN );
	vec3 lensIor = vec3( ${r}, ${g}, ${b} );
	vec3 lensOutA[ 3 ];
	vec3 lensOutB[ 3 ];
	vec3 lensPassA;
	vec3 lensPassB;
	// The ball's own glow (\`lensGlow\`), seen along this fragment's view ray.
	vec3 lensGlowSeen;
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
		float f1 = coatFresnel( dot( o1, - in1 ), - in1 )[ c ];
		lensOutA[ c ] = o1;
		// Absorbed along the way (Beer-Lambert) over the chord crossed.
		lensPassA[ c ] = ( 1.0 - lensFin[ c ] ) * ( 1.0 - f1 ) * exp( - lensAbsorb[ c ] * chord1 );
		// B: what the far surface reflected, across again, and out.
		vec3 d2 = reflect( d1, in1 );
		float chord2 = 2.0 * lensRadius * dot( in1, d2 );
		vec3 at2 = at1 + d2 * chord2;
		vec3 in2 = normalize( lensC - at2 );
		vec3 o2 = refract( d2, in2, n );
		float f2 = coatFresnel( dot( o2, - in2 ), - in2 )[ c ];
		lensOutB[ c ] = o2;
		lensPassB[ c ] = ( 1.0 - lensFin[ c ] ) * f1 * ( 1.0 - f2 ) * exp( - lensAbsorb[ c ] * ( chord1 + chord2 ) );
		// The glow is emitted evenly through the ball, so what reaches the eye
		// is what glows along the chord the view ray crosses and along the one
		// the far surface's film reflects into it, out through the front.
		lensGlowSeen[ c ] = lensGlow[ c ] * ( 1.0 - lensFin[ c ] ) * ( chord1 + f1 * chord2 ) / ( 2.0 * lensRadius );
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

// `see` read after each of three's three direct-light calls, in its loops'
// order: point, spot, directional. A point light INSIDE the glass - the ball's
// own glow light (`BALL_GLOW_INTENSITY`, at its centre) - is not a lamp the
// glass sees through itself, and is skipped: the glass draws its glow as the
// traced `lensGlow`. Unguarded, the lens drew it as a lamp seen through the
// ball, a white point at the centre and a white ring at the rim.
function seeEachLight(what: string, see: string, centre: string): string {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  const parts = chunk.split(RE_DIRECT);
  if (parts.length - 1 !== 3 || !parts[0]!.includes("pointLight = pointLights[ i ];")) {
    throw new Error(`glassMaterial: three's lights_fragment_begin no longer calls RE_Direct once per light kind, point lights first; the ${what} lights patch matches nothing`);
  }
  const outside = `if ( distance( pointLight.position, ${centre} ) > lensRadius ) ${see}`;
  return parts[0] + `${RE_DIRECT}\n\t\t${outside}` + parts[1] + `${RE_DIRECT}\n\t\t${see}` + parts[2] + `${RE_DIRECT}\n\t\t${see}` + parts[3];
}

function lensLightsChunk(): string {
  const see = `
		{
			vec3 lensL = normalize( directLight.direction );
			for ( int c = 0; c < 3; c ++ ) {
				lensLights[ c ] += directLight.color[ c ] * (
					lensPassA[ c ] * lensLobe( lensOutA[ c ], lensL, lensWidthA ) +
					lensPassB[ c ] * lensLobe( lensOutB[ c ], lensL, lensWidthB ) );
			}
		}`;
  return seeEachLight("lens", see, "lensC");
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
	gl_FragColor = vec4( outgoingLight + ( lensRoom + lensLights + lensGlowSeen ) * ( 1.0 - glassDust ), 1.0 );`;
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

// THE GLOW (Tris, 2026-10-16: "a slight glow. That doesn't need to be
// realistic because it's a magic crystal ball"): the ball - not its loop or
// chain - gives off a faint light of its own, evenly through its volume, so it
// is brightest where the view crosses the most crystal and fades to the rim.
// What is invented is only that it glows; the light then leaves through the
// aurora film like any other, so the film colours it (`lensGlowSeen`). The
// colour, and the radiance seen straight through the centre (linear, the
// scene's own units: a sunlit rock top reads about 0.25).
// A warm yellow (Tris, 2026-10-16: "glow a warm yellow, not purple"; it was
// 0xdcd8ff, a lavender white).
export const BALL_GLOW = 0xffc857;
export const BALL_GLOW_RADIANCE = 0.025;
// ...and the light it gives the world (Tris: "make it emit actual light (using
// a scene light)"): a point light at the ball's centre (`Scene3D`), in three's
// candela with the inverse square, reaching `BALL_GLOW_RANGE` metres - short,
// so the fragments it cannot reach skip it (lightReach.ts). The cave's lamps
// are ~2. No shadow: a point light's shadow is six more renders a frame.
export const BALL_GLOW_INTENSITY = 0.35;
export const BALL_GLOW_RANGE = 2.5;

// The film carried by a broken piece's vertices (`pieceGlassMaterial`), handed
// to the fragment shader.
const COAT_ATTRIBUTE_PARS = /* glsl */ `
#ifdef COAT_FROM_ATTRIBUTE
	attribute float coatNm;
	varying float vCoatNm;
#endif
`;

// The axis the film thins along (`coatAt`), the piece's own +y carried into view
// space: through each instance's matrix for a link, so every link wears its own
// bands, and through the ball's rotation for the ball, so its bands roll with it.
const COAT_AXIS_VERTEX = /* glsl */ `
	vec3 coatAxis = vec3( 0.0, 1.0, 0.0 );
	#ifdef USE_INSTANCING
		coatAxis = mat3( instanceMatrix ) * coatAxis;
	#endif
	vCoatAxis = normalize( normalMatrix * coatAxis );
	#ifdef COAT_FROM_ATTRIBUTE
		vCoatNm = coatNm;
	#endif
`;

export const SOLID_GLASS_PROGRAM_KEY = `ball-lens:${GLASS_IOR_RGB.join(",")}:paths-ab:${LIGHT_ANGLE}|aurora:${COAT_IOR}:${COAT_THICKNESS_NM.join("-")}|wear:${GREASE_ROUGHNESS}:${GREASE_HAZE_MIPS}:${GREASE_SCATTER}:${SCUFF_SCATTER}|avatar-fog:${AVATAR_FOG}`;

// Solid round glass whose surface curves at `lensRadius` (metres): the ball's
// radius for the ball, a bar's for a link, the loop or the cuff. Lit and seen
// through from the ball's reflection probe (`setProbe` it every frame).
//
// `wear`: the baked surface wear the ball carries (glassWear.ts), or null for
// clean glass. `glow`: the ball's own magic glow (`BALL_GLOW`).
export function solidGlassMaterial(
  lensRadius: number,
  wear: THREE.CubeTexture | null = null,
  glow = false,
): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    // No diffuse: glass scatters nothing. What it shows is reflected (three's
    // specular) or comes through (the trace).
    color: 0x000000,
    metalness: 0,
    roughness: 0,
    ior: GLASS_IOR,
    specularIntensity: 1,
    // The aurora film, so three lights the front surface's reflection through
    // it too; its thickness is set per fragment below (`coatAt`), not by
    // three's range.
    ...coatOptions(),
  });
  mat.name = "solid-glass";
  if (wear) mat.defines = { ...mat.defines, GLASS_WEAR: "" };
  const radius = { value: lensRadius };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.lensRadius = radius;
    shader.uniforms.lensAbsorb = GLASS_ABSORPTION;
    shader.uniforms.lensGlow = { value: new THREE.Color(glow ? BALL_GLOW : 0x000000).multiplyScalar(glow ? BALL_GLOW_RADIANCE : 0) };
    if (wear) shader.uniforms.glassWear = { value: wear };
    for (const line of ["#include <begin_vertex>"]) {
      if (!shader.vertexShader.includes(line)) throw new Error(`glassMaterial: three's vertex shader has no ${line}`);
    }
    for (const line of [
      "#include <color_fragment>",
      "#include <roughnessmap_fragment>",
      "#include <lights_physical_fragment>",
      "#include <lights_fragment_begin>",
    ]) {
      if (!shader.fragmentShader.includes(line)) throw new Error(`glassMaterial: three's fragment shader has no ${line}`);
    }
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", `varying vec3 vGlassLocal;\nvarying vec3 vCoatAxis;\n${COAT_ATTRIBUTE_PARS}\nvoid main() {`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${COAT_AXIS_VERTEX}\n\tvGlassLocal = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `uniform float lensRadius;\nuniform vec3 lensAbsorb;\nuniform vec3 lensGlow;\n${WEAR_PARS}\n${LENS_PARS}\nvoid main() {`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${WEAR_FRAGMENT}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${WEAR_ROUGHNESS}`)
      .replace("#include <lights_physical_fragment>", coatThicknessChunk("coatAt( normalize( normal ) )"))
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
// HOLLOW glass: the ball as a quartz shell with a wall of some thickness
// ---------------------------------------------------------------------------
//
// Tris, 2026-10-16: "I want the crystal ball to have thin walls instead of
// being solid. I want to be able to configure the thickness of the wall" (the
// wall is glassWall.ts). Two concentric spheres, the outer one coated with the
// aurora film, the inner one bare quartz, and air between them and the centre.
// What that does to the light depends on where the view ray meets the ball,
// which is the whole of how a thick glass bulb looks:
//
//   - Inside the hollow's own silhouette (the ray's distance from the centre,
//     its IMPACT PARAMETER, under the inner radius) the ray crosses the wall,
//     the hollow and the far wall: four surfaces. Each wall is a meniscus whose
//     surfaces share a centre, and that is a weak diverging lens, so what is
//     behind the ball is seen through it a little smaller, and bent hard and
//     split into colour toward the hollow's edge, where the ray meets the
//     inner surface at a graze.
//   - Outside it, the ray never reaches the air inside. Quartz keeps
//     n * (impact parameter) the same at every surface of concentric spheres,
//     so a ray whose impact parameter outside is over the inner radius meets
//     the inner surface past the critical angle, or misses it: it stays in the
//     wall and comes out bent as through solid glass. The rim of the ball is a
//     band of solid quartz exactly the wall's thickness wide in the projected
//     radius - the dark, bright-edged ring a glass bulb has.
//
// THE PATHS traced, per fragment, in view space (`hollowToOuter` is one leg):
//
//   A - straight through: in, on through the hollow if it gets there, out.
//       Per channel, with dispersion, as the solid ball.
//   B - reflected once off the far side's film, from inside the glass, and
//       out again: the aurora's colour seen inside the ball (the solid ball's
//       path B). Per channel.
//   C - reflected off the far wall's bare inner surface, from the hollow.
//   D - reflected off the near wall's bare inner surface, from the glass: the
//       second, fainter reflection a thick glass wall shows behind the first.
//       C and D only where the ray crosses the hollow, and traced once, in
//       green: each is a twentieth of the light, uncoloured by the film.
//
// WHAT A PATH SEES. Path A through the hollow leaves the ball close to where
// it was going, and what it sees is the scene right behind the ball, which
// the reflection probe holds a few texels of across the whole ball: it is
// read from the FRAME instead, a patch of it copied out just before the ball
// is drawn (frameCopy.ts), where the leaving ray meets the depth the frame
// holds (two steps of a secant search). Everything else - the rim's rays, the
// reflections, and any of A that lands off the patch or on something in front
// of the ball - is read from the probe, as for the solid ball, with the
// scene's lamps added along it (which the probe has no more of than the frame
// does: a lamp is not drawn, only what it lights). The frame is tone mapped
// and encoded (frameTarget.ts), so it is decoded first (`frameDecode`, the
// exact inverse of three's ACES and sRGB), and the sum encoded again: one
// opaque draw, no blending.
//
// With depth of field on, the ball is drawn after the blur (depthOfField.ts
// takes it as an overlay), so what it sees behind it is out of focus too.

// Three's tone mapping, inverted (`frameDecode`), from its own constants: a
// three upgrade that changes them fails here rather than drawing the scene
// behind the ball the wrong brightness.
const ACES_INPUT = [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777];
const ACES_OUTPUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602];
function acesMatchesThree(): boolean {
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  return (
    chunk.includes("vec3( 0.59719, 0.07600, 0.02840 )") &&
    chunk.includes("vec3( 0.35458, 0.90834, 0.13383 )") &&
    chunk.includes("vec3( 0.04823, 0.01566, 0.83777 )") &&
    chunk.includes("vec3(  1.60475, -0.10208, -0.00327 )") &&
    chunk.includes("vec3( -0.53108,  1.10813, -0.07276 )") &&
    chunk.includes("vec3( -0.07367, -0.00605,  1.07602 )") &&
    chunk.includes("vec3 a = v * ( v + 0.0245786 ) - 0.000090537;") &&
    chunk.includes("vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;") &&
    chunk.includes("color *= toneMappingExposure / 0.6;")
  );
}
function glslMat3(columns: number[]): string {
  return `mat3( ${columns.map(glslFloat).join(", ")} )`;
}
const inverseOf = (columns: number[]): number[] => new THREE.Matrix3().fromArray(columns).invert().toArray();

// Declarations shared by everything drawn over the frame or read out of it
// (the hollow ball, the broken pieces), ahead of `main`.
const FRAME_PARS = /* glsl */ `
// The frame's own encoding of a linear colour: tone mapped and sRGB, as the
// canvas is (frameTarget.ts).
vec3 frameEncode( vec3 linear ) {
	#ifdef TONE_MAPPING
		linear = toneMapping( linear );
	#endif
	return linearToOutputTexel( vec4( linear, 1.0 ) ).rgb;
}
// ...and back: the linear colour a pixel of the frame was. Exact but where the
// tone mapping clipped a channel.
vec3 frameDecode( vec3 encoded ) {
	vec3 c = sRGBTransferEOTF( vec4( encoded, 1.0 ) ).rgb;
	#ifdef TONE_MAPPING
		c = clamp( ${glslMat3(inverseOf(ACES_OUTPUT))} * c, 0.0, 1.0 );
		// RRTAndODTFit's rational, solved for its input: a quadratic.
		vec3 qa = 0.983729 * c - 1.0;
		vec3 qb = 0.4329510 * c - 0.0245786;
		vec3 qc = 0.238081 * c + 0.000090537;
		c = ( - qb - sqrt( max( qb * qb - 4.0 * qa * qc, 0.0 ) ) ) / ( 2.0 * qa );
		c = ${glslMat3(inverseOf(ACES_INPUT))} * c * ( 0.6 / toneMappingExposure );
	#endif
	return max( c, vec3( 0.0 ) );
}
`;

// An estimate of what the frame holds behind a piece of glass drawn by
// blending over it (the broken pieces, which cannot read the frame): the
// probe's room along the view ray, blurred `FRAME_BEHIND_MIPS`, since the
// probe sees it from a little way off and only so far. Only where the
// encoding's curve bends around it depends on it (see "PIECES").
const FRAME_BEHIND_MIPS = 3;
// The darkest the estimate is taken to be: below it the encoding is linear.
const FRAME_BEHIND_FLOOR = "vec3( 1e-3 )";
const FRAME_BEHIND = (dir: string): string => `max( probeOn ? probeIntensity * textureLod( probeCube, transformDirectionByInverseViewMatrix( ${dir}, viewMatrix ), ${glslFloat(FRAME_BEHIND_MIPS)} ).rgb : vec3( 0.0 ), ${FRAME_BEHIND_FLOOR} )`;

// Three's `fog_fragment` for glass that shows the frame behind it: the fog is
// laid over the light the glass ITSELF sends (`glassSeen` is what of the
// frame behind came through, fogged already), in proportion to how much of
// the frame it hides (`glassCover`).
export function seeThroughFogChunk(scale: number = AVATAR_FOG): string {
  const chunk = THREE.ShaderChunk.fog_fragment;
  if (!chunk.includes(FOG_MIX)) {
    throw new Error("glassMaterial: three's fog_fragment chunk changed; the see-through fog patch matches nothing");
  }
  return chunk.replace(
    FOG_MIX,
    `gl_FragColor.rgb = glassSeen + mix( gl_FragColor.rgb - glassSeen, fogColor * glassCover, fogFactor * ${glslFloat(scale)} );`,
  );
}

// One leg of a path through the hollow ball, and the surfaces it crosses.
const HOLLOW_PARS = /* glsl */ `
struct HollowLeg {
	vec3 p;        // where it is
	vec3 d;        // which way it is going
	float pass;    // what the bare inner surfaces crossed have let through
	float glass;   // how far it has gone in quartz (what absorbs)
	float span;    // ...and in all, inside the ball (what glows)
	bool crossed;  // whether it crossed the hollow
	// Where it met the inner surface going in (near) and coming out (far), the
	// way it was going, and its pass and its quartz there, before that surface.
	vec3 nearP; vec3 nearD; float nearPass; float nearGlass;
	vec3 farP; vec3 farD; float farPass; float farGlass;
};
HollowLeg hollowLeg( const in vec3 p, const in vec3 d ) {
	HollowLeg l;
	l.p = p; l.d = d;
	l.pass = 1.0; l.glass = 0.0; l.span = 0.0;
	l.crossed = false;
	l.nearP = p; l.nearD = d; l.nearPass = 0.0; l.nearGlass = 0.0;
	l.farP = p; l.farD = d; l.farPass = 0.0; l.farGlass = 0.0;
	return l;
}
// Bare quartz's reflectance at the inner surface, by the cosine on its air
// side: Fresnel's is the same whichever way the light crosses.
float bareFresnel( const in float cosAir ) {
	return F_Schlick( ${glslFloat(F0)}, 1.0, saturate( cosAir ) );
}
// From inside the quartz on to the outer surface, crossing the hollow on the
// way if the ray reaches it, or turned back by it past the critical angle:
// the leg ends ON the outer surface, still inside, going the way it hits it.
void hollowToOuter( inout HollowLeg l, const in vec3 c, const in float n ) {
	vec3 oc = l.p - c;
	float b = dot( oc, l.d );
	if ( lensInner > 0.0 && b < 0.0 ) {
		float disc = b * b - ( dot( oc, oc ) - lensInner * lensInner );
		if ( disc > 0.0 ) {
			float t = - b - sqrt( disc );
			vec3 h = l.p + l.d * t;
			l.glass += t;
			l.span += t;
			vec3 m = ( h - c ) / lensInner;
			vec3 o = refract( l.d, m, n );
			l.nearP = h; l.nearD = l.d; l.nearPass = l.pass; l.nearGlass = l.glass;
			if ( dot( o, o ) == 0.0 ) {
				// Past the critical angle: the inner surface is a perfect mirror.
				l.d = reflect( l.d, m );
			} else {
				l.pass *= 1.0 - bareFresnel( - dot( o, m ) );
				// Across the hollow: from a point on a sphere, the chord along a
				// unit direction is -2 (p - c) . d long.
				float t2 = - 2.0 * dot( h - c, o );
				h += o * t2;
				l.span += t2;
				vec3 m2 = ( h - c ) / lensInner;
				l.crossed = true;
				l.farP = h; l.farD = o; l.farPass = l.pass; l.farGlass = l.glass;
				l.pass *= 1.0 - bareFresnel( dot( o, m2 ) );
				l.d = refract( o, - m2, 1.0 / n );
			}
			l.p = h;
			oc = l.p - c;
			b = dot( oc, l.d );
		}
	}
	float t = - b + sqrt( max( b * b - ( dot( oc, oc ) - lensRadius * lensRadius ), 0.0 ) );
	l.p += l.d * t;
	l.glass += t;
	l.span += t;
}
`;

// What the probe (or, until it has drawn, the level's sky) sees along a view-
// space direction, as an expression. Inline rather than a function: the
// probe's uniforms are declared after everything else ahead of `main` (see
// reflectionProbe.ts `wearProbe`).
const PROBE_SEES = (dir: string, lod: string, roughness: string): string => `( probeOn
		? probeIntensity * textureLod( probeCube, transformDirectionByInverseViewMatrix( ${dir}, viewMatrix ), ${lod} ).rgb
		: hollowSky( ${dir}, ${roughness} ) )`;

// The level's sky along a direction, before the probe has drawn.
const HOLLOW_SKY = /* glsl */ `
vec3 hollowSky( const in vec3 dir, const in float roughness ) {
	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
		// Reflecting a direction off itself is the direction.
		return getIBLRadiance( dir, dir, roughness );
	#else
		return vec3( 0.0 );
	#endif
}
`;

// Before three's lights loop: every path, and what of path A the frame holds.
function hollowTraceChunk(): string {
  const [r, g, b] = GLASS_IOR_RGB.map(glslFloat);
  return `
	vec3 lensP = - vViewPosition;
	vec3 lensN = normalize( normal );
	vec3 lensD = isOrthographic ? vec3( 0.0, 0.0, - 1.0 ) : normalize( lensP );
	vec3 lensC = lensP - lensN * lensRadius;
	vec3 lensFin = coatFresnel( dot( lensN, - lensD ), lensN );
	vec3 lensIor = vec3( ${r}, ${g}, ${b} );
	vec3 lensOutA[ 3 ];
	vec3 lensOutB[ 3 ];
	// Where path A leaves the ball, per channel.
	vec3 lensAt[ 3 ];
	vec3 lensPassA;
	vec3 lensPassB;
	vec3 lensGlowSeen;
	// Paths C and D (green), zero where the ray does not cross the hollow.
	bool hollowCrossed = false;
	vec3 hollowOutC = vec3( 0.0, 0.0, 1.0 );
	vec3 hollowOutD = vec3( 0.0, 0.0, 1.0 );
	vec3 hollowPassC = vec3( 0.0 );
	vec3 hollowPassD = vec3( 0.0 );
	for ( int c = 0; c < 3; c ++ ) {
		float n = lensIor[ c ];
		// A: in, on to the far side, out - losing what the film reflects back.
		HollowLeg a = hollowLeg( lensP, refract( lensD, lensN, 1.0 / n ) );
		hollowToOuter( a, lensC, n );
		vec3 na = ( a.p - lensC ) / lensRadius;
		vec3 oa = refract( a.d, - na, n );
		// (Never past the critical angle on a sphere, but for rounding.)
		float fa = dot( oa, oa ) > 0.0 ? coatFresnel( dot( oa, na ), na )[ c ] : 1.0;
		lensOutA[ c ] = oa;
		lensAt[ c ] = a.p;
		lensPassA[ c ] = ( 1.0 - lensFin[ c ] ) * a.pass * ( 1.0 - fa ) * exp( - lensAbsorb[ c ] * a.glass );
		// B: what the film reflected, on round again, and out.
		HollowLeg bl = a;
		bl.d = reflect( a.d, na );
		hollowToOuter( bl, lensC, n );
		vec3 nb = ( bl.p - lensC ) / lensRadius;
		vec3 ob = refract( bl.d, - nb, n );
		float fb = dot( ob, ob ) > 0.0 ? coatFresnel( dot( ob, nb ), nb )[ c ] : 1.0;
		lensOutB[ c ] = ob;
		lensPassB[ c ] = ( 1.0 - lensFin[ c ] ) * bl.pass * fa * ( 1.0 - fb ) * exp( - lensAbsorb[ c ] * bl.glass );
		// The glow fills the ball, hollow and all (see \`BALL_GLOW\`): what
		// glows along the paths the view takes through it, out the front.
		lensGlowSeen[ c ] = lensGlow[ c ] * ( 1.0 - lensFin[ c ] ) * ( a.span + fa * ( bl.span - a.span ) ) / ( 2.0 * lensRadius );
		if ( c == 1 && a.crossed ) {
			hollowCrossed = true;
			// C: off the far wall's inner surface, back across the hollow, and
			// out through the near wall.
			vec3 m2 = ( a.farP - lensC ) / lensInner;
			vec3 dc = reflect( a.farD, m2 );
			vec3 h3 = a.farP + dc * ( - 2.0 * dot( a.farP - lensC, dc ) );
			vec3 m3 = ( h3 - lensC ) / lensInner;
			HollowLeg cl = hollowLeg( h3, refract( dc, - m3, 1.0 / n ) );
			cl.pass = a.farPass * bareFresnel( dot( a.farD, m2 ) ) * ( 1.0 - bareFresnel( dot( dc, m3 ) ) );
			cl.glass = a.farGlass;
			hollowToOuter( cl, lensC, n );
			vec3 nc = ( cl.p - lensC ) / lensRadius;
			hollowOutC = refract( cl.d, - nc, n );
			hollowPassC = ( 1.0 - lensFin ) * cl.pass * ( 1.0 - coatFresnel( dot( hollowOutC, nc ), nc ) ) * exp( - lensAbsorb * cl.glass );
			// D: off the near wall's inner surface, from inside the quartz,
			// back out of the front.
			vec3 m1 = ( a.nearP - lensC ) / lensInner;
			HollowLeg dl = hollowLeg( a.nearP, reflect( a.nearD, m1 ) );
			dl.pass = a.nearPass * bareFresnel( - dot( refract( a.nearD, m1, n ), m1 ) );
			dl.glass = a.nearGlass;
			hollowToOuter( dl, lensC, n );
			vec3 nd = ( dl.p - lensC ) / lensRadius;
			hollowOutD = refract( dl.d, - nd, n );
			hollowPassD = ( 1.0 - lensFin ) * dl.pass * ( 1.0 - coatFresnel( dot( hollowOutD, nd ), nd ) ) * exp( - lensAbsorb * dl.glass );
		}
	}
	// What path A sees of the frame behind the ball, and how much of A that
	// is (\`hollowW\`): where the green ray, leaving, meets the depth the frame
	// holds, found by stepping from the pixel straight behind, on the patch,
	// and behind where it leaves the ball. Fading out toward the patch's edge,
	// where the probe takes over.
	float hollowW = 0.0;
	vec3 hollowBehind = vec3( 0.0 );
	if ( frameCopyOn && hollowCrossed && lensOutA[ 1 ].z < - 1e-4 ) {
		vec3 q = lensAt[ 1 ];
		vec3 e = lensOutA[ 1 ];
		vec2 px = gl_FragCoord.xy;
		float t = 0.0;
		bool held = true;
		for ( int i = 0; i < 3; i ++ ) {
			t = max( ( frameViewZ( px ) - q.z ) / e.z, 0.0 );
			px = framePixel( q + e * t );
			if ( frameInside( px ) < 1.0 ) {
				held = false;
				break;
			}
		}
		// What it found must be behind where the ray left the ball: anything
		// nearer (the ball's own loop beside it) the ray has already passed.
		if ( held && frameViewZ( px ) < q.z ) {
			hollowW = smoothstep( 0.0, 0.1 * min( frameCopyRect.z, frameCopyRect.w ), frameInside( px ) );
			for ( int c = 0; c < 3; c ++ ) {
				vec2 pc = clamp( framePixel( lensAt[ c ] + lensOutA[ c ] * t ), frameCopyRect.xy + 0.5, frameCopyRect.xy + frameCopyRect.zw - 0.5 );
				hollowBehind[ c ] = frameDecode( frameColour( pc ) )[ c ];
			}
		}
	}
	// How far each path's exit direction turns across one pixel (see
	// \`lensLobe\`), outside any branch.
	float lensWidthA = max( length( fwidth( lensOutA[ 1 ] ) ), ${glslFloat(LIGHT_ANGLE)} );
	float lensWidthB = max( length( fwidth( lensOutB[ 1 ] ) ), ${glslFloat(LIGHT_ANGLE)} );
	float hollowWidthC = max( length( fwidth( hollowOutC ) ), ${glslFloat(LIGHT_ANGLE)} );
	float hollowWidthD = max( length( fwidth( hollowOutD ) ), ${glslFloat(LIGHT_ANGLE)} );
	vec3 lensLights = vec3( 0.0 );
`;
}

// In each of three's light loops: the lamp along every path the probe is read
// down - path A only for the share of it the frame does not hold.
function hollowLightsChunk(): string {
  const see = `
		{
			vec3 lensL = normalize( directLight.direction );
			for ( int c = 0; c < 3; c ++ ) {
				lensLights[ c ] += directLight.color[ c ] * (
					lensPassA[ c ] * ( 1.0 - hollowW ) * lensLobe( lensOutA[ c ], lensL, lensWidthA ) +
					lensPassB[ c ] * lensLobe( lensOutB[ c ], lensL, lensWidthB ) );
			}
			lensLights += directLight.color * (
				hollowPassC * lensLobe( hollowOutC, lensL, hollowWidthC ) +
				hollowPassD * lensLobe( hollowOutD, lensL, hollowWidthD ) );
		}`;
  return seeEachLight("hollow", see, "lensC");
}

// Three's `opaque_fragment`: everything the paths see, the frame's share
// decoded and the sum encoded here. Exported so `cli render3d` can read it
// without a GPU.
export function hollowGlassChunk(): string {
  const chunk = THREE.ShaderChunk.opaque_fragment;
  if (!chunk.includes(OPAQUE_LINE)) {
    throw new Error("glassMaterial: three's opaque_fragment chunk changed; the hollow patch matches nothing");
  }
  const lod = `glassSmudge * ${glslFloat(GREASE_HAZE_MIPS)}`;
  const rough = `glassSmudge * ${glslFloat(GREASE_ROUGHNESS)}`;
  return chunk.replace(
    OPAQUE_LINE,
    `
	vec3 lensRoom = vec3( 0.0 );
	for ( int c = 0; c < 3; c ++ ) {
		vec3 seenA = ${PROBE_SEES("lensOutA[ c ]", lod, rough)};
		vec3 seenB = ${PROBE_SEES("lensOutB[ c ]", lod, rough)};
		lensRoom[ c ] = seenA[ c ] * lensPassA[ c ] * ( 1.0 - hollowW ) + seenB[ c ] * lensPassB[ c ];
	}
	if ( hollowCrossed ) {
		lensRoom += ${PROBE_SEES("hollowOutC", lod, rough)} * hollowPassC;
		lensRoom += ${PROBE_SEES("hollowOutD", lod, rough)} * hollowPassD;
	}
	// A speck of dust is opaque: what it covers comes through it not at all.
	vec3 hollowThrough = hollowW * hollowBehind * lensPassA * ( 1.0 - glassDust );
	vec3 hollowAdded = outgoingLight + ( lensRoom + lensLights + lensGlowSeen ) * ( 1.0 - glassDust );
	gl_FragColor = vec4( frameEncode( hollowThrough + hollowAdded ), 1.0 );
	// For the fog (\`seeThroughFogChunk\`): the frame's share came fogged.
	vec3 glassSeen = frameEncode( hollowThrough );
	float glassCover = 1.0 - hollowW * dot( lensPassA, vec3( 1.0 / 3.0 ) ) * ( 1.0 - glassDust );`,
  );
}

export const HOLLOW_GLASS_PROGRAM_KEY = `ball-hollow:${GLASS_IOR_RGB.join(",")}:paths-abcd:${LIGHT_ANGLE}|aurora:${COAT_IOR}:${COAT_THICKNESS_NM.join("-")}|wear:${GREASE_ROUGHNESS}:${GREASE_HAZE_MIPS}:${GREASE_SCATTER}:${SCUFF_SCATTER}|frame-copy|see-through-fog:${AVATAR_FOG}`;

// The hollow ball's draw: after every other opaque thing in the scene (so the
// frame it copies holds them) and the solid glass loop (1).
export const HOLLOW_GLASS_ORDER = 2;

// A quartz shell of outer radius `radius` and wall `wall` (metres), coated
// outside, seeing the frame behind it through `copy`'s patch (`FrameCopy`,
// grabbed as the mesh's `onBeforeRender`) and the room through the ball's
// reflection probe (`setProbe` it every frame). `wear` and `glow` as for
// `solidGlassMaterial`. The wall is a uniform: `setHollowWall` changes it.
export function hollowGlassMaterial(
  radius: number,
  wall: number,
  copy: Record<string, THREE.IUniform>,
  wear: THREE.CubeTexture | null = null,
  glow = false,
): THREE.MeshPhysicalMaterial {
  if (!acesMatchesThree()) {
    throw new Error("glassMaterial: three's ACES tone mapping changed; `frameDecode` no longer inverts it");
  }
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: 0,
    ior: GLASS_IOR,
    specularIntensity: 1,
    ...coatOptions(),
  });
  mat.name = "hollow-glass";
  // Shows the frame behind it: drawn after depth of field's blur, as the see-
  // through things are (depthOfField.ts).
  mat.userData.seesFrame = true;
  if (wear) mat.defines = { ...mat.defines, GLASS_WEAR: "" };
  const uniforms = {
    lensRadius: { value: radius },
    lensInner: { value: Math.max(0, radius - wall) },
    lensAbsorb: GLASS_ABSORPTION,
    lensGlow: { value: new THREE.Color(glow ? BALL_GLOW : 0x000000).multiplyScalar(glow ? BALL_GLOW_RADIANCE : 0) },
    ...copy,
  };
  mat.userData.hollow = uniforms;
  mat.onBeforeCompile = (shader, renderer) => {
    if (renderer && renderer.toneMapping !== THREE.ACESFilmicToneMapping && renderer.toneMapping !== THREE.NoToneMapping) {
      throw new Error("glassMaterial: the hollow ball decodes the frame from ACES tone mapping, and the renderer's is another");
    }
    Object.assign(shader.uniforms, uniforms);
    if (wear) shader.uniforms.glassWear = { value: wear };
    if (!shader.vertexShader.includes("#include <begin_vertex>")) throw new Error("glassMaterial: three's vertex shader has no #include <begin_vertex>");
    for (const line of [
      "#include <color_fragment>",
      "#include <roughnessmap_fragment>",
      "#include <lights_physical_fragment>",
      "#include <lights_fragment_begin>",
      "#include <opaque_fragment>",
      "#include <tonemapping_fragment>",
      "#include <colorspace_fragment>",
      "#include <fog_fragment>",
    ]) {
      if (!shader.fragmentShader.includes(line)) throw new Error(`glassMaterial: three's fragment shader has no ${line}`);
    }
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", `varying vec3 vGlassLocal;\nvarying vec3 vCoatAxis;\n${COAT_ATTRIBUTE_PARS}\nvoid main() {`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${COAT_AXIS_VERTEX}\n\tvGlassLocal = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        `uniform float lensRadius;\nuniform float lensInner;\nuniform vec3 lensAbsorb;\nuniform vec3 lensGlow;\n${WEAR_PARS}\n${LENS_PARS}\n${FRAME_PARS}\n${FRAME_COPY_PARS}\n${HOLLOW_PARS}\n${HOLLOW_SKY}\nvoid main() {`,
      )
      .replace("#include <color_fragment>", `#include <color_fragment>\n${WEAR_FRAGMENT}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${WEAR_ROUGHNESS}`)
      .replace("#include <lights_physical_fragment>", coatThicknessChunk("coatAt( normalize( normal ) )"))
      .replace("#include <lights_fragment_begin>", `${hollowTraceChunk()}\n${hollowLightsChunk()}`)
      .replace("#include <opaque_fragment>", hollowGlassChunk())
      // Encoded by `hollowGlassChunk` already.
      .replace("#include <tonemapping_fragment>", "")
      .replace("#include <colorspace_fragment>", "")
      .replace("#include <fog_fragment>", seeThroughFogChunk());
  };
  mat.customProgramCacheKey = () => HOLLOW_GLASS_PROGRAM_KEY;
  wearProbe(mat);
  return mat;
}

// A new wall for a hollow ball's material, in metres; recompiles nothing.
export function setHollowWall(mat: THREE.Material, wall: number): void {
  const u = mat.userData.hollow as { lensRadius: THREE.IUniform<number>; lensInner: THREE.IUniform<number> } | undefined;
  if (u) u.lensInner.value = Math.max(0, u.lensRadius.value - wall);
}

// ---------------------------------------------------------------------------
// PIECES: the broken ball's chunks, seen through
// ---------------------------------------------------------------------------
//
// A chunk of the ball (render/glassFracture.ts) is a few centimetres of solid
// quartz with flat broken faces, and what it looks like is what is BEHIND it,
// shifted a little, with bright edges and facets that flash: traced as the
// ball is, through the probe, every pixel of a flat face looked along nearly
// the same direction and read one texel of the room - a face drawn as one
// flat colour, like painted plastic (2026-10-16). So a piece is seen through
// by blending, two draws over the frame: TRANSMIT multiplying it by what each
// face passes and LIGHT adding what each face sends the eye.
//
// THE FRAME IS ENCODED (frameTarget.ts: tone mapped and sRGB, as the canvas
// is), and light does not add in encoded values: blended as they are, a dim
// reflection laid over a dark cave came out several times too bright - glass
// drawn this way went milky (the hollow ball's first version, 2026-10-16). A
// blend cannot decode what it lands on, so both draws are written for the
// encoded frame from an estimate of what is behind (`FRAME_BEHIND`) as
//
//   transmit: frame * enc(behind * T) / enc(behind)
//   light:    + enc(behind * T + added) - enc(behind * T)
//
// which is the encoded sum exactly where the estimate is right.
//
// Both faces of a piece are drawn. A FRONT face is the light entering: the
// film's or bare quartz's reflectance at the view angle (`coatNm`, none on a
// broken face), lit by three as the ball's surface is. A BACK face is the
// light leaving: Fresnel from inside, and past quartz's critical angle (40
// degrees) nothing leaves at all - the face reflects everything back into the
// piece, which is the dark facet and the bright flash a glass chunk has. What
// a back face reflects is read from the probe along the reflection, through
// the face it came in by. The bend of the light through the piece is left
// out: across a chunk a few centimetres thick it moves the background less
// than the piece's own edge does.
//
// That is for a CHUNK, whose faces meet at every angle. A SHARD of the hollow
// ball's wall (`setPieceSlabs`) is a curved plate a few millimetres thick: the
// light leaving one face entered by the face opposite, nearly parallel, so it
// leaves at the angle it entered at and is never trapped. Drawn as chunks,
// the shards' back faces went past the critical angle wherever they were seen
// obliquely and showed only the dark cave they reflected (Tris, 2026-10-16:
// "the ugly black areas that appear on the glass after it breaks").

// Shared by both draws, after three's lights: the face's reflectance and
// transmittance, and the estimate of what is behind it.
const PIECE_FACE = /* glsl */ `
	vec3 pieceN = normalize( normal );
	float pieceCos = saturate( dot( pieceN, geometryViewDir ) );
	vec3 pieceR;
	if ( gl_FrontFacing ) {
		pieceR = filmFresnel( pieceCos, vCoatNm );
	} else {
	#ifdef PIECE_SLAB
		// A shard of a thin wall: what leaves a face came in by the face
		// opposite, all but parallel to it, so it leaves at the angle it came in
		// at - never past the critical angle.
		pieceR = filmFresnel( pieceCos, vCoatNm );
	#else
		// Leaving the quartz: Snell's sine outside, or none past the critical angle.
		float pieceSin = ${glslFloat(GLASS_IOR)} * sqrt( 1.0 - pieceCos * pieceCos );
		pieceR = pieceSin >= 1.0 ? vec3( 1.0 ) : filmFresnel( sqrt( 1.0 - pieceSin * pieceSin ), vCoatNm );
	#endif
	}
	vec3 pieceT = 1.0 - pieceR;
	vec3 pieceBehind = ${FRAME_BEHIND("- geometryViewDir")};
	// How much of the piece is left as it fades away: the batch's per-piece
	// colour (render3d/shardVisual.ts), 1 whole to 0 gone.
	#ifdef USE_COLOR_ALPHA
		float pieceFade = vColor.r;
	#else
		float pieceFade = 1.0;
	#endif
`;

function pieceTransmitChunk(): string {
  const chunk = THREE.ShaderChunk.opaque_fragment;
  if (!chunk.includes(OPAQUE_LINE)) throw new Error("glassMaterial: three's opaque_fragment chunk changed; the piece patch matches nothing");
  return chunk.replace(
    OPAQUE_LINE,
    `${PIECE_FACE}
	gl_FragColor = vec4( mix( vec3( 1.0 ), frameEncode( pieceBehind * pieceT ) / frameEncode( pieceBehind ), pieceFade ), 1.0 );`,
  );
}

function pieceLightChunk(): string {
  const chunk = THREE.ShaderChunk.opaque_fragment;
  if (!chunk.includes(OPAQUE_LINE)) throw new Error("glassMaterial: three's opaque_fragment chunk changed; the piece patch matches nothing");
  return chunk.replace(
    OPAQUE_LINE,
    `${PIECE_FACE}
	vec3 pieceAdded = outgoingLight;
	if ( ! gl_FrontFacing ) {
		// Reflected inside off this face (whose outward normal faces away from
		// the eye), from light that came in by a front face.
		vec3 pieceIn = reflect( - geometryViewDir, - pieceN );
		vec3 pieceRoom = probeOn ? probeIntensity * textureLod( probeCube, transformDirectionByInverseViewMatrix( pieceIn, viewMatrix ), 0.0 ).rgb : vec3( 0.0 );
		pieceAdded = pieceRoom * pieceR * ${glslFloat(1 - F0)};
	}
	vec3 pieceThrough = pieceBehind * pieceT;
	gl_FragColor = vec4( ( frameEncode( pieceThrough + pieceAdded ) - frameEncode( pieceThrough ) ) * pieceFade, 1.0 );
	vec3 glassSeen = vec3( 0.0 );
	float glassCover = ( 1.0 - dot( pieceT, vec3( 1.0 / 3.0 ) ) ) * pieceFade;`,
  );
}

// Whether the pieces' material draws shards of a thin wall (see "PIECES"):
// set when the pieces are cut, before anything is drawn with it.
export function setPieceSlabs(mat: THREE.Material, slabs: boolean): void {
  const defines = (mat.defines ??= {}) as Record<string, string>;
  if ((defines.PIECE_SLAB !== undefined) === slabs) return;
  if (slabs) defines.PIECE_SLAB = "";
  else delete defines.PIECE_SLAB;
  mat.needsUpdate = true;
}

// The pieces' two draws, after the opaque scene (the hollow ball among it)
// and the water, the transmit first.
export const PIECE_TRANSMIT_ORDER = 2;
export const PIECE_LIGHT_ORDER = 3;

const PIECE_KEY = `piece-fade:${F0}:${GLASS_IOR}|aurora:${COAT_IOR}|behind-${FRAME_BEHIND_MIPS}|see-through-fog:${AVATAR_FOG}`;

// The two draws of the broken pieces (see "PIECES"), TRANSMIT first. Both lit
// from the ball's probe (`setProbe` them both). For a `BatchedMesh` whose
// geometry carries `coatNm`.
export function pieceGlassMaterial(pass: "transmit" | "light"): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: 0,
    ior: GLASS_IOR,
    specularIntensity: 1,
    ...coatOptions(),
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    ...(pass === "transmit"
      ? {
          blending: THREE.CustomBlending,
          blendEquation: THREE.AddEquation,
          blendSrc: THREE.ZeroFactor,
          blendDst: THREE.SrcColorFactor,
          blendEquationAlpha: THREE.AddEquation,
          blendSrcAlpha: THREE.ZeroFactor,
          blendDstAlpha: THREE.OneFactor,
        }
      : { blending: THREE.AdditiveBlending }),
  });
  mat.name = `glass-piece-${pass}`;
  // Both faces of the double-sided piece in one pass each, back then front;
  // the order does not matter to a multiply or a sum.
  mat.forceSinglePass = true;
  mat.defines = { ...mat.defines, COAT_FROM_ATTRIBUTE: "" };
  mat.onBeforeCompile = (shader) => {
    for (const line of ["#include <begin_vertex>"]) {
      if (!shader.vertexShader.includes(line)) throw new Error(`glassMaterial: three's vertex shader has no ${line}`);
    }
    for (const line of [
      "#include <lights_physical_fragment>",
      "#include <opaque_fragment>",
      "#include <tonemapping_fragment>",
      "#include <colorspace_fragment>",
      "#include <fog_fragment>",
    ]) {
      if (!shader.fragmentShader.includes(line)) throw new Error(`glassMaterial: three's fragment shader has no ${line}`);
    }
    shader.uniforms.lensRadius = { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", `varying vec3 vCoatAxis;\n${COAT_ATTRIBUTE_PARS}\nvoid main() {`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${COAT_AXIS_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `uniform float lensRadius;\n${LENS_PARS}\n${FRAME_PARS}\nvoid main() {`)
      .replace("#include <lights_physical_fragment>", coatThicknessChunk("vCoatNm"))
      .replace("#include <opaque_fragment>", pass === "transmit" ? pieceTransmitChunk() : pieceLightChunk())
      // Encoded by the chunk above already.
      .replace("#include <tonemapping_fragment>", "")
      .replace("#include <colorspace_fragment>", "")
      .replace("#include <fog_fragment>", pass === "transmit" ? "" : seeThroughFogChunk());
  };
  mat.customProgramCacheKey = () => `${PIECE_KEY}|${pass}|${mat.defines?.PIECE_SLAB !== undefined ? "slab" : "chunk"}`;
  wearProbe(mat);
  return mat;
}

// Whether the ball wears its baked wear (glassWear.ts) - off for now (Tris,
// 2026-10-16: "remove all the dust/smears/fogginess for now (not forever)"):
// unbaked, and the ball compiled clean. `?glasswear=1` puts it back.
export const glassWearShown: { value: boolean } = { value: false };

// Read by main.ts and shotMain.ts off their URL: `?glasswall=<mm>` (the
// ball's wall, glassWall.ts), `?glasswear=1` (above), `?glasscoat=1` (the
// aurora film, `glassCoatShown`) and `?glasstint=R,G,B`, the glass's
// absorption per metre (`GLASS_ABSORPTION`) - `glasstint=0.4,3,11` is amber.
export function glassOptionsFrom(params: URLSearchParams): void {
  glassWallFrom(params);
  if (params.get("glasswear") === "1") glassWearShown.value = true;
  if (params.get("glasscoat") === "1") glassCoatShown.value = true;
  const tint = params.get("glasstint")?.split(",").map(Number);
  if (tint?.length === 3 && tint.every((v) => Number.isFinite(v) && v >= 0)) {
    GLASS_ABSORPTION.value.set(tint[0]!, tint[1]!, tint[2]!);
  }
}
