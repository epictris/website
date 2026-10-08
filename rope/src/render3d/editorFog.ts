// The editor's fog: every surface hazed exactly as the GAME's camera would haze
// it, wherever the editor's own camera happens to be.
//
// The fog thickens with view depth from the camera (see `environment.ts`). The
// editor's camera is not the player's: it zooms out far past any camera region
// to see the whole level, and orbits, so drawn through its own depth the level
// sinks into the fog colour as it pulls back - and drawn through none of it,
// the level reads clearer than it ever plays.
//
// The game's camera always looks straight down -z (`applyPose`), so the view
// depth it fogs a surface by is exactly `gameCameraZ - surfaceZ`, whatever the
// surface's x and y. So that is the depth the editor fogs by: the same law, the
// same density, and for every surface the same amount of haze the game draws
// on it, including the air between the player's camera and the gameplay plane.
// The editor's camera only decides what is looked at, never how foggy it is.
// What it cannot match is a level whose regions zoom differently: one game
// camera is chosen per frame, the one the game settles at for the place the
// editor is looking at (`restingCameraZoom`), so the haze is the game's there
// and an approximation across a whole zoomed-out level.
//
// HOW EVERY MATERIAL HEARS IT: one uniform object, shared by reference. Three
// clones a material's uniforms from `ShaderLib` when it first compiles, and
// the clone copies a value that is not a three.js object (a Vector, Color,
// Texture...) or an array BY REFERENCE, so `GAME_FOG_CAMERA` - a plain
// `{ x, y }` - added to every fogged `ShaderLib` entry and to
// `UniformsLib.fog` is the same object in every material of the scene, and a
// `vec2` uniform reads a plain `{ x, y }` as readily as a `Vector2`. Writing
// it is a change of uniform values, never a recompile, so ▶ Test can hand the
// scene back and forth freely. A shader that includes the fog chunks without
// carrying the uniform reads (0, 0), the camera's own fog: forgetting it
// costs the look, never the frame.
//
// The light shafts march the same depths with the same object
// (`lightShafts.ts`), so the lit air and the surfaces around it agree.

import * as THREE from "three";

// x: 1 while the game's camera is standing in, 0 for the camera's own fog.
// y: that camera's world z (the gameplay plane is z = 0, +z toward it).
export const GAME_FOG_CAMERA = { x: 0, y: 0 };

// Fog every surface as the game camera at world `z` would, or (null) as the
// camera drawing the frame does.
export function setGameFogCamera(z: number | null): void {
  GAME_FOG_CAMERA.x = z === null ? 0 : 1;
  GAME_FOG_CAMERA.y = z ?? 0;
}

// Three's chunks as they are, which this replaces. Matched exactly (up to
// whitespace) so a three upgrade that changed the fog fails here, loudly,
// rather than drawing the editor in a fog nobody wrote.
const THREE_FOG_PARS_VERTEX = `
#ifdef USE_FOG
	varying float vFogDepth;
#endif
`;
const THREE_FOG_VERTEX = `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif
`;
const THREE_FOG_PARS_FRAGMENT = `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;
const THREE_FOG_FRAGMENT = `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

// The surface's world z, from its view-space position: the view matrix's third
// column is world +z seen from the camera and its fourth the world origin, so
// `dot(col2, v - col3)` is a view point's world z. Linear in the position, so
// it interpolates across a triangle exactly.
const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying float vFogWorldZ;
#endif
`;
const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldZ = dot( viewMatrix[ 2 ].xyz, mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif
`;
const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	uniform vec2 fogGameCamera;
	varying float vFogDepth;
	varying float vFogWorldZ;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	// The depth of air in front of this surface: from the camera drawing it,
	// or from the game's camera while the editor stands one in (editorFog.ts).
	float fogDepth() {
		if ( fogGameCamera.x > 0.5 ) return max( fogGameCamera.y - vFogWorldZ, 0.0 );
		return vFogDepth;
	}
#endif
`;
const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	float fogAirDepth = fogDepth();
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * fogAirDepth * fogAirDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, fogAirDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

function replaceChunk(
  name: "fog_pars_vertex" | "fog_vertex" | "fog_pars_fragment" | "fog_fragment",
  was: string,
  now: string,
): void {
  const chunk = THREE.ShaderChunk[name];
  if (squash(chunk) === squash(now)) return;
  if (squash(chunk) !== squash(was)) {
    throw new Error(`editorFog: three's ${name} chunk changed; the editor fog would replace something it has not read`);
  }
  THREE.ShaderChunk[name] = now;
}

// Before any material is made or compiled: every module that draws fog
// imports this, ahead of its own body.
replaceChunk("fog_pars_vertex", THREE_FOG_PARS_VERTEX, FOG_PARS_VERTEX);
replaceChunk("fog_vertex", THREE_FOG_VERTEX, FOG_VERTEX);
replaceChunk("fog_pars_fragment", THREE_FOG_PARS_FRAGMENT, FOG_PARS_FRAGMENT);
replaceChunk("fog_fragment", THREE_FOG_FRAGMENT, FOG_FRAGMENT);
const shared = (): THREE.IUniform => ({ value: GAME_FOG_CAMERA });
(THREE.UniformsLib.fog as Record<string, THREE.IUniform>).fogGameCamera = shared();
for (const shader of Object.values(THREE.ShaderLib)) {
  if ("fogDensity" in shader.uniforms) shader.uniforms.fogGameCamera = shared();
}

// World z in `camera`'s view space, as (world +z seen from the camera,
// offset): `dot(xyz, v) + w` is a view point's world z, as in `FOG_VERTEX`.
// For the shaft march, which works in view space rather than from the chunks.
export function worldZInView(camera: THREE.Camera, out: THREE.Vector4): THREE.Vector4 {
  const e = camera.matrixWorldInverse.elements;
  const nx = e[8]!;
  const ny = e[9]!;
  const nz = e[10]!;
  return out.set(nx, ny, nz, -(nx * e[12]! + ny * e[13]! + nz * e[14]!));
}
