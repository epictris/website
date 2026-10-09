import * as THREE from "three";

// A moss mound with a PRINTED EDGE (the Blender moss add-on's `Edge: Printed`,
// tools/blender/moss/build.py step 8, since 2026-10-10), dressed for the game
// by a patch on three's own program.
//
// The mound's mesh runs a little past the dabs' outline, at the rock's own
// resolution; the outline itself is in the print's alpha, a signed distance
// to it (SDF_RANGE each side, 0.5 on it), which glTF carries as alphaMode
// MASK at 0.5. Two things, both properties of the print rather than of the
// lights:
//
// THE CUT, anti-aliased. Three's alpha test with `alphaToCoverage` is a
// smoothstep over the alpha's screen-space slope (alphatest_fragment, r18x),
// which on a distance field is exactly a one-pixel anti-aliased edge, and the
// frame target is multisampled (frameTarget.ts), so the coverage lands as
// samples. The lobes are then as fine as the texels and never jagged, at any
// distance: a distance field filters and mips as a distance field.
//
// THE LIP, as shading. A moss cushion's edge rounds over to its lip; the
// mesh edge drew that as rings of triangles (hundreds a metre of outline).
// Here the distance is a height map: a quarter-round roll LIP_ROUND wide
// inside the outline, h(d) = R sqrt(1 - (1 - d / R)^2), and its screen-space
// derivatives bend the normal (Mikkelsen's "bump mapping unparametrized
// surfaces", the listing three's bumpmap_pars_fragment is from, but with the
// position derivatives unnormalized so a metre of height is a metre). Blender
// shows the same through a Bump node (mesh_io.py). The two constants are
// build.py's SDF_RANGE and LIP_ROUND: change both.
const SDF_RANGE = 0.02;
const LIP_ROUND = 0.012;
const PROGRAM_KEY = "moss-mound";

interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
}

const NORMAL_NEEDLE = "#include <normal_fragment_maps>";
const MAP_NEEDLE = "vec4 sampledDiffuseColor = texture2D( map, vMapUv );";

function lip(): string {
  const f = (x: number) => x.toFixed(4);
  return `${NORMAL_NEEDLE}
	#ifdef USE_MAP
	{
		float mossD = ( sampledDiffuseColor.a - 0.5 ) * ${f(2 * SDF_RANGE)};
		float mossX = clamp( mossD / ${f(LIP_ROUND)}, 0.0, 1.0 );
		float mossH = ${f(LIP_ROUND)} * sqrt( max( 0.0, 1.0 - ( 1.0 - mossX ) * ( 1.0 - mossX ) ) );
		vec3 mossSx = dFdx( - vViewPosition );
		vec3 mossSy = dFdy( - vViewPosition );
		vec3 mossR1 = cross( mossSy, normal );
		vec3 mossR2 = cross( normal, mossSx );
		float mossDet = dot( mossSx, mossR1 );
		vec3 mossGrad = sign( mossDet ) * ( dFdx( mossH ) * mossR1 + dFdy( mossH ) * mossR2 );
		normal = normalize( abs( mossDet ) * normal - mossGrad );
	}
	#endif`;
}

function patchable(): boolean {
  // A text patch on three's chunks: say so the moment a three upgrade moves
  // the text, and draw the moss as three ships it rather than half-patched.
  const ok = THREE.ShaderChunk.map_fragment.includes(MAP_NEEDLE);
  if (!ok) console.warn("[render3d] mossMound: three's shader chunks changed; the moss is drawn as a plain material");
  return ok;
}

/** Whether a scene mesh is a moss mound with a printed edge: a `.moss` object (the add-on's name) whose own material (`<rock>.moss`) is alpha-cut. */
export function isPrintedMoss(blenderNames: readonly string[], materials: readonly THREE.Material[]): boolean {
  return (
    blenderNames.some((n) => /\.moss$/.test(n)) &&
    materials.some((m) => /\.moss(\.\d+)?$/.test(m.name) && (m as THREE.MeshStandardMaterial).alphaTest > 0)
  );
}

/** Dress a printed-edge moss material: the anti-aliased cut and the lip's shading. Idempotent: the material is shared. */
export function wearMossMound(mat: THREE.Material): THREE.Material {
  if (mat.userData.mossMound === true) return mat;
  mat.userData.mossMound = true;
  mat.alphaToCoverage = true;
  const prior = mat.onBeforeCompile;
  const priorKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (this: THREE.Material, shader: ShaderSource, renderer: THREE.WebGLRenderer) {
    prior.call(this, shader as Parameters<typeof prior>[0], renderer);
    if (!patchable()) return;
    shader.fragmentShader = shader.fragmentShader.replace(NORMAL_NEEDLE, lip());
  } as typeof mat.onBeforeCompile;
  mat.customProgramCacheKey = function (this: THREE.Material) {
    return `${priorKey.call(this)}|${PROGRAM_KEY}`;
  };
  mat.needsUpdate = true;
  return mat;
}
