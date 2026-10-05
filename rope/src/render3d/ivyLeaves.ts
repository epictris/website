import * as THREE from "three";

// The ivy's leaf material (the Blender ivy add-on's alpha-cut cards), dressed
// for the game by a patch on three's own program. Three things, all of them
// properties of a leaf rather than of the lights:
//
// SHADOW BIASES (2026-09-30). The leaves receive the sun's shadow with a
// fraction of the sun's biases. The sun's constant bias and normal push are
// sized for the level's rock (environment.ts: about 6 cm of depth slack on
// the 75 m shadow camera, plus 3 cm along the normal), which is more than the
// gap between the ivy's sheets of leaves, so with them a leaf could never
// shadow the leaf below it and the carpet read flat. A bias is a property of
// the light, not the receiver, in three; this scales it inside the ivy
// material's own program, where the receiver is known. The leaves are flat
// cards whose normal is the rock's rounded hull, pointing out of the stack
// toward the light, so the small push is enough against acne on them.
// Constant bias x 0.1 and normal bias x 0.5: 6 mm + 1.5 cm, against sheets
// 3 cm apart (build.STRATUM_GAP); more bias (x 0.3 / x 1) only thinned the
// shade between leaves. The filter radius is x 0.33: the sun's 3 texels
// spread three's nine PCF taps 4.5 cm apart on the ivy, which drew every
// penumbra as a dither over the whole carpet (the carpet is all penumbra);
// at one texel the taps are adjacent and the penumbra is a smooth 4.5 cm.
//
// TWO SIDES (2026-10-05). The cards are drawn from behind too, so a gap in
// the front sheet shows the back of a leaf further in rather than the
// background ("gaps in the front cover don't show the background"). A back
// face shades with the SAME hull normal as its front: three's double-sided
// default flips the normal on a back face, which would light the inside of
// the carpet as if it faced into the rock.
//
// TRANSLUCENCY (2026-10-05). A real leaf lets some of the light through
// (after a reference whose shaded leaves are a deep saturated green, not
// black). Three terms:
// - LIT THROUGH: a leaf in another's shadow keeps `LIT_THROUGH` of the light,
//   coloured by its own leaf (the light came through a leaf of that colour),
//   so the inner sheets are a deeper green instead of going dark. The shadow
//   map cannot tell a leaf from the rock, so a leaf the ROCK shades is lifted
//   by as much; a hull facing the sun is rarely behind its own rock.
// - FROM BEHIND: a leaf whose hull faces away from a light still glows with
//   `TRANSMIT` of what reaches it from behind - with the shadow unlifted, so
//   the beard under a rock stays in the rock's shade and an overhanging
//   fringe lit from behind glows.
// - THE FILL FROM BEHIND: the hemisphere fill gives a leaf `TRANSMIT` of the
//   sky its back faces as well as its own side. A carpet hung under a rock
//   faces the dark ground colour and is in the rock's shadow, so without this
//   it was near-black; a thin leaf under a lit sky is not.
let CONSTANT_SCALE = 0.1;
let NORMAL_SCALE = 0.5;
let RADIUS_SCALE = 0.33;
let LIT_THROUGH = 0.45;
let TRANSMIT = 0.4;
const PROGRAM_KEY = "ivy-leaves";

/** For the ivy harness's experiments only (tools/blender/moss-experiments/harness): the scales, before any ivy material is worn. */
export function setIvyLeafScales(s: { constant?: number; normal?: number; radius?: number; litThrough?: number; transmit?: number }): void {
  CONSTANT_SCALE = s.constant ?? CONSTANT_SCALE;
  NORMAL_SCALE = s.normal ?? NORMAL_SCALE;
  RADIUS_SCALE = s.radius ?? RADIUS_SCALE;
  LIT_THROUGH = s.litThrough ?? LIT_THROUGH;
  TRANSMIT = s.transmit ?? TRANSMIT;
}

interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
}

const VERTEX_NEEDLE = "directionalLightShadows[ i ].shadowNormalBias";
const FACE_NEEDLE = "float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;";
const DIR_START = "#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )";
const DIR_END = "#pragma unroll_loop_end";
const HEMI_NEEDLE = "irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );";

// Three's directional-light loop (lights_fragment_begin, r18x) with the leaf's
// biases, the lit-through floor and the light from behind.
function directionalLoop(): string {
  const f = (x: number) => x.toFixed(3);
  return `${DIR_START}

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	vec3 ivyThrough = ${f(LIT_THROUGH)} * diffuseColor.rgb / max( max3( diffuseColor.rgb ), 1e-4 );
	float ivySun;

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		ivySun = 1.0;
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		ivySun = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias * ${f(CONSTANT_SCALE)}, directionalLightShadow.shadowRadius * ${f(RADIUS_SCALE)}, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif

		reflectedLight.directDiffuse += directLight.color * ( ivySun * ${f(TRANSMIT)} * saturate( - dot( geometryNormal, directLight.direction ) ) ) * BRDF_Lambert( material.diffuseContribution );
		directLight.color *= mix( ivyThrough, vec3( 1.0 ), ivySun );

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	${DIR_END}`;
}

function patched(): { vertex: string; normal: string; lights: string } | null {
  const v = THREE.ShaderChunk.shadowmap_vertex;
  const n = THREE.ShaderChunk.normal_fragment_begin;
  const l = THREE.ShaderChunk.lights_fragment_begin;
  const start = l.indexOf(DIR_START);
  const end = start < 0 ? -1 : l.indexOf(DIR_END, start);
  // A text patch on three's chunks: say so the moment a three upgrade moves
  // the text, and draw the leaves as three ships them rather than half-patched.
  if (!v.includes(VERTEX_NEEDLE) || !n.includes(FACE_NEEDLE) || end < 0 || !l.includes(HEMI_NEEDLE) || !l.slice(start, end).includes("getShadow( directionalShadowMap[ i ]")) {
    console.warn("[render3d] ivyLeaves: three's shader chunks changed; the ivy is drawn as a plain material");
    return null;
  }
  return {
    vertex: v.replace(VERTEX_NEEDLE, `( ${VERTEX_NEEDLE} * ${NORMAL_SCALE.toFixed(3)} )`),
    normal: n.replace(FACE_NEEDLE, "float faceDirection = 1.0;"),
    lights: (l.slice(0, start) + directionalLoop() + l.slice(end + DIR_END.length)).replace(
      HEMI_NEEDLE,
      `${HEMI_NEEDLE}\n\t\t\tirradiance += ${TRANSMIT.toFixed(3)} * getHemisphereLightIrradiance( hemisphereLights[ i ], - geometryNormal );`,
    ),
  };
}

/** Dress the ivy's leaf material: cast, two-sided, translucent, with its finer shadow biases. Idempotent: the material is shared. */
export function wearIvyLeaves(mat: THREE.Material): THREE.Material {
  if (mat.userData.ivyLeaves === true) return mat;
  mat.userData.ivyLeaves = true;
  mat.side = THREE.DoubleSide;
  // CAST: for a PCF map three draws the shadow pass with the OPPOSITE side
  // of the material (WebGLShadowMap's `shadowSide` table), its trick against
  // acne on a closed mesh. The leaves are single-sided cards, so that drew
  // their backs only and every leaf facing the sun cast nothing at all.
  mat.shadowSide = THREE.DoubleSide;
  const prior = mat.onBeforeCompile;
  const priorKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (this: THREE.Material, shader: ShaderSource, renderer: THREE.WebGLRenderer) {
    prior.call(this, shader as Parameters<typeof prior>[0], renderer);
    const p = patched();
    if (!p) return;
    shader.vertexShader = shader.vertexShader.replace("#include <shadowmap_vertex>", p.vertex);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <normal_fragment_begin>", p.normal)
      .replace("#include <lights_fragment_begin>", p.lights);
  } as typeof mat.onBeforeCompile;
  mat.customProgramCacheKey = function (this: THREE.Material) {
    return `${priorKey.call(this)}|${PROGRAM_KEY}`;
  };
  mat.needsUpdate = true;
  return mat;
}
