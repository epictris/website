// What the avatar is made of, beyond the painted steel it wears: the rules that
// make the ball and its chain the one thing in the frame the player never loses.
//
// One rule, applied to any `MeshStandardMaterial` handed to this module - the
// stand-in sphere and loop, the chain's instanced links, the manacle, and the
// loaded ball model's own materials (inside `shine()`):
//
// THE AVATAR IS DRAWN THROUGH LESS AIR. The fog it takes on is scaled by
// `AVATAR_FOG`, so a level that asks for thick haze still hazes the world with
// depth while the ball stays crisp in it. 0 is three's `fog: false` and 1 is the
// world's own air; neither end is the answer, because a ball exempt from the fog
// altogether reads as a cut-out pasted over a hazy picture. The value is a
// played one.
//
// The avatar reflects the level's own environment, ON PURPOSE. A private sky
// for it (the level's colours lifted toward white, a sun lobe always on) was
// built and played on 2026-09-24 and rejected: a ball reflecting a brighter sky
// than the room it is in looks pasted on. What lights the player is the world
// itself - see "Waking lights" in docs/lighting-and-surfaces.md.
//
// THE AVATAR IS LIT ROUND THE BACK. A lamp's diffuse light on it keeps going
// past the terminator (`AVATAR_WRAP`), so a mushroom beside the ball lights
// the side facing it AND the side facing away, and the ball reads as a lit
// sphere rather than a crescent. It is not a cheat so much as the bounce the
// renderer does not model: the rock the lamp is sitting on is lit hard and
// throws that light back onto the ball's far side, and a wrap term is the
// cheapest honest stand-in for it. Diffuse only - the specular highlight
// stays where the lamp puts it, or the ball would wear a glint on the side no
// light reaches. Played 2026-09-24 after the mushrooms at 30 cd lit one side
// to white and left the other black.
//
// And the wrap is NOT SHADOWED BY THE BALL ITSELF. Three multiplies a light's
// colour by its shadow term before the material sees it, and a shadow-casting
// lamp's map marks the ball's own far half as occluded - which under plain
// Lambert is invisible, since the light reaches zero on exactly that line
// anyway. With the wrap it was a hard cut to black across the sphere at the
// terminator (played 2026-09-24, under the river's shaft). Bounce is light
// that arrives from the lit surroundings, not from the lamp, so the ball's own
// silhouette does not block it: the Lambert part spends the SHADOWED colour
// and the wrap part spends the light as it was before the shadow. Shadows from
// everything else still land on the direct term as before.
//
// SHARING. The materials handed here are cached (`surfaceFor` with `avatar:
// true`, or a GLB's materials shared by every `loadMesh` clone), so everything
// below is idempotent and keyed on the material rather than on the caller.
// The avatar's cache entry is safe to patch only because it is shared with
// nothing but the avatar and because a page has one `Scene3D` drawing one.

import * as THREE from "three";

// How much of the world's fog the avatar takes, as a multiple of it: 0 is none
// (three's `fog: false`), 1 is the air everything else is drawn through.
export const AVATAR_FOG = 0.35;

// The line three's `fog_fragment` chunk mixes toward the fog colour with, and
// the one this module rewrites. Named so the rewrite fails LOUDLY if a three
// upgrade changes the chunk: a `replace` that matches nothing is a patch that
// silently does nothing, and the avatar would go back to the world's air with
// no diagnostic anywhere.
const FOG_MIX = "gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );";

// A number as a GLSL float literal: `1` is an int in GLSL and would not compile
// in a float multiply.
function glslFloat(v: number): string {
  const s = String(v);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

// Three's own `fog_fragment` chunk with the fog factor scaled by `scale` before
// the mix. Exported so `cli render3d` can read it without a GPU.
export function avatarFogChunk(scale: number = AVATAR_FOG): string {
  const chunk = THREE.ShaderChunk.fog_fragment;
  if (!chunk.includes(FOG_MIX)) {
    throw new Error("avatarSurface: three's fog_fragment chunk changed; the avatar fog patch matches nothing");
  }
  return chunk.replace(
    FOG_MIX,
    `gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * ${glslFloat(scale)} );`,
  );
}

// How far past the terminator a lamp's diffuse light reaches on the avatar:
// three's `dotNL` becomes `(dotNL + AVATAR_WRAP) / (1 + AVATAR_WRAP)`, so 0 is
// three's own Lambert, 1 is half-Lambert (the far side dark only at the exact
// antipode, the sides at half), and more is flatter still. Never brighter than
// Lambert on the lit side, so the number to lower when a lamp blows the near
// side out is the lamp's, not this.
export const AVATAR_WRAP = 1;

// The two lines of three's `RE_Direct_Physical` this rewrites: where the
// irradiance is taken, and where the diffuse term spends it. Named for the
// same reason `FOG_MIX` is - a three upgrade that reworded either must fail
// here, loudly, rather than hand the ball back its crescent.
const DIRECT_IRRADIANCE = "vec3 irradiance = dotNL * directLight.color;";
const DIRECT_DIFFUSE = "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );";
// The three lines of `lights_fragment_begin` that read each direct light, one
// per kind, each followed a few lines later by the shadow multiply. The light
// as read here is the light before its shadow, and the wrap spends that.
const LIGHT_INFO = [
  "getPointLightInfo( pointLight, geometryPosition, directLight );",
  "getSpotLightInfo( spotLight, geometryPosition, directLight );",
  "getDirectionalLightInfo( directionalLight, directLight );",
];
const UNSHADOWED = "avatarUnshadowed";

// Three's own `lights_fragment_begin` chunk with each direct light's colour
// stashed before the shadow is applied to it. Exported for `cli render3d`.
export function avatarLightsBeginChunk(): string {
  let chunk = THREE.ShaderChunk.lights_fragment_begin;
  for (const line of LIGHT_INFO) {
    if (!chunk.includes(line)) {
      throw new Error("avatarSurface: three's lights_fragment_begin chunk changed; the avatar wrap patch matches nothing");
    }
    chunk = chunk.replace(line, `${line}\n\t\t${UNSHADOWED} = directLight.color;`);
  }
  return chunk;
}

// Three's own `lights_physical_pars_fragment` chunk with the direct diffuse
// term wrapped by `wrap`. The specular keeps the unwrapped `irradiance`.
// Exported so `cli render3d` can read it without a GPU.
export function avatarLightChunk(wrap: number = AVATAR_WRAP): string {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(DIRECT_IRRADIANCE) || !chunk.includes(DIRECT_DIFFUSE)) {
    throw new Error(
      "avatarSurface: three's lights_physical_pars_fragment chunk changed; the avatar wrap patch matches nothing",
    );
  }
  const w = glslFloat(wrap);
  // `wrapNL - dotNL` is the part of the wrapped lobe that Lambert does not
  // have: zero on the lit pole, half of the lamp on the terminator, and the
  // whole of the far side. That part is the bounce, and it is unshadowed.
  return `vec3 ${UNSHADOWED} = vec3( 0.0 );\n${chunk}`
    .replace(
      DIRECT_IRRADIANCE,
      `${DIRECT_IRRADIANCE}\n\tfloat wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + ${w} ) / ( 1.0 + ${w} ) );\n\tvec3 wrapIrradiance = irradiance + max( wrapNL - dotNL, 0.0 ) * ${UNSHADOWED};`,
    )
    .replace(
      DIRECT_DIFFUSE,
      "reflectedLight.directDiffuse += wrapIrradiance * BRDF_Lambert( material.diffuseContribution );",
    );
}

// The program-cache key the patch adds. Without it three would hand a patched
// material the program of an unpatched one with the same defines (or the
// reverse), and which of the two the avatar was drawn with would depend on
// which was compiled first.
export const AVATAR_PROGRAM_KEY = `avatar-fog:${AVATAR_FOG}|avatar-wrap:${AVATAR_WRAP}`;

interface ShaderSource {
  fragmentShader: string;
}

// Give a material the avatar's thinner air and its wrapped light. Idempotent, since the materials are
// shared.
export function wearAvatar(mat: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  if (mat.userData.avatar === true) return mat;
  mat.userData.avatar = true;
  // Chained rather than replaced, so a material that already carries a patch
  // keeps it - none of the avatar's do today, and this is what makes it safe
  // when one does.
  const prior = mat.onBeforeCompile;
  const priorKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (
    this: THREE.MeshStandardMaterial,
    shader: ShaderSource,
    renderer: THREE.WebGLRenderer,
  ) {
    prior.call(this, shader as Parameters<typeof prior>[0], renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <fog_fragment>", avatarFogChunk())
      .replace("#include <lights_physical_pars_fragment>", avatarLightChunk())
      .replace("#include <lights_fragment_begin>", avatarLightsBeginChunk());
  } as typeof mat.onBeforeCompile;
  mat.customProgramCacheKey = function (this: THREE.MeshStandardMaterial) {
    return `${priorKey.call(this)}|${AVATAR_PROGRAM_KEY}`;
  };
  mat.needsUpdate = true;
  return mat;
}

// Every `MeshStandardMaterial` under an object, once each.
export function standardMaterialsOf(obj: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const out = new Set<THREE.MeshStandardMaterial>();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const std = m as THREE.MeshStandardMaterial;
      if (std?.isMeshStandardMaterial) out.add(std);
    }
  });
  return [...out];
}
