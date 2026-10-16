// A light is shaded only where it reaches.
//
// Three's forward renderer runs the whole surface model (`RE_Direct`: the GGX
// specular, the diffuse, the clearcoat and sheen where a material has them)
// for EVERY point and spot light on EVERY fragment, whether the light reaches
// that fragment or not. Past a light's `distance` its attenuation is exactly
// zero (`getDistanceAttenuation`), and outside a spot's cone so is the cone
// term, so all that work adds zero - and it is most of what a lit fragment
// costs once a level has more than a couple of lamps.
//
// Measured live (2026-10-16, ball.json at the spawn, 3701x2082, RTX 4070
// SUPER, interleaved blocks): the main scene pass fell from 4.32 to 3.23 ms
// GPU with this alone, and from 2.04 to 1.74 ms on top of the depth prepass
// (see depthPrepass.ts). The cave's lamps are short-ranged and placed along
// the level, so on any given part of the screen most of them are out of reach.
//
// HOW. Three's own light read (`getPointLightInfo`, `getSpotLightInfo`) sets
// `directLight.visible` to whether the attenuated colour is non-zero, BEFORE
// the shadow is applied - and already uses it to skip the shadow lookup. The
// same flag now guards the surface model. A skipped light is a light whose
// contribution was `0 * finite`, so the picture is identical to the bit
// (checked live: 0 of 7.7 M pixels differ); what changes is that a warp of
// fragments the light cannot reach branches past it.
//
// The directional light (the sun) is always visible, so its call is guarded
// too and never skipped; one rule for all three loops is the simpler patch.
//
// A light whose `range` is huge reaches every fragment and is never skipped:
// range is now a cost as well as a look.

import * as THREE from "three";

// Three's call that lights the surface for one light: once per point, spot and
// directional light in `lights_fragment_begin`. The glass ball's lens patch
// matches this same line (glassMaterial.ts), and still finds all three.
export const RE_DIRECT =
  "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";

const GUARDED = `if ( directLight.visible ) ${RE_DIRECT}`;

// `chunk` (three's `lights_fragment_begin`) with every direct light's surface
// model skipped where that light does not reach. Idempotent. Exported so
// `cli render3d` can read it without a GPU.
export function skipUnreachedLights(chunk: string): string {
  if (chunk.includes(GUARDED)) return chunk;
  const calls = chunk.split(RE_DIRECT).length - 1;
  if (calls !== 3) {
    throw new Error(
      `lightReach: three's lights_fragment_begin calls RE_Direct ${calls} times, not once per light kind; the reach patch matches nothing`,
    );
  }
  return chunk.split(RE_DIRECT).join(GUARDED);
}

// Before any material is made or compiled, as editorFog.ts does its fog: every
// module that lights a surface imports environment.ts, which imports this. A
// chunk changed after a program was compiled would not reach it, since three
// keys built-in programs by their parameters and not by their source.
THREE.ShaderChunk.lights_fragment_begin = skipUnreachedLights(THREE.ShaderChunk.lights_fragment_begin);
