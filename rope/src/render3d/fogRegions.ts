// Spatial control of the existing art-directed fog. Regions mask the view at
// the gameplay plane, so near rock and distant backdrop fade at the same
// authored boundary. They do not change sunlight, ambient light or exposure.
import * as THREE from "three";
import { DEFAULT_FOG_FALLOFF, type FogRegionData } from "../level/levelFormat";

// A plain container: three's uniform clone keeps this by reference. Updating
// the texture/count therefore reaches every built-in and custom fog shader.
const state = { data: new THREE.DataTexture(new Float32Array(8), 2, 1, THREE.RGBAFormat, THREE.FloatType), count: 0, enabled: 0 };
state.data.needsUpdate = true;
let previous: readonly FogRegionData[] | undefined;
export function fogRegionUniforms(): Record<string, THREE.IUniform> {
  return { fogRegions: { value: state } };
}

export function setFogRegions(regions: readonly FogRegionData[] | undefined): void {
  if (regions === previous) return;
  previous = regions;
  const values = new Float32Array(Math.max(1, regions?.length ?? 0) * 8);
  for (const [i, r] of (regions ?? []).entries()) {
    values.set([r.x, r.y, Math.cos(r.rot), Math.sin(r.rot),
      r.shape.kind === "circle" ? r.shape.r : r.shape.w / 2,
      r.shape.kind === "circle" ? r.shape.r : r.shape.h / 2,
      Math.max(0, r.falloff ?? DEFAULT_FOG_FALLOFF), r.shape.kind === "circle" ? 1 : 0], i * 8);
  }
  const texture = new THREE.DataTexture(values, 2, Math.max(1, regions?.length ?? 0), THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  state.data.dispose();
  state.data = texture;
  state.count = regions?.length ?? 0;
  state.enabled = regions === undefined ? 0 : 1;
}

// CPU counterpart used for editor guides and the boundary/overlap checks.
// Coordinates are the level's (x right, y down), in metres.
export function fogRegionWeight(regions: readonly FogRegionData[] | undefined, x: number, y: number): number {
  if (regions === undefined) return 1;
  let weight = 0;
  for (const r of regions) {
    const dx = x - r.x, dy = y - r.y, c = Math.cos(r.rot), s = Math.sin(r.rot);
    const u = dx * c + dy * s, v = -dx * s + dy * c;
    const inside = r.shape.kind === "circle"
      ? r.shape.r - Math.hypot(u, v)
      : Math.min(r.shape.w / 2 - Math.abs(u), r.shape.h / 2 - Math.abs(v));
    const falloff = Math.max(0, r.falloff ?? DEFAULT_FOG_FALLOFF);
    const t = falloff > 0 ? Math.min(1, Math.max(0, inside / falloff)) : Number(inside >= 0);
    weight = Math.max(weight, t * t * (3 - 2 * t));
  }
  return weight;
}

export const REGION_FOG_GLSL = /* glsl */ `
struct FogRegionUniforms { sampler2D data; int count; int enabled; };
uniform FogRegionUniforms fogRegions;
float regionFogAt( vec2 point ) {
  if ( fogRegions.enabled == 0 ) return 1.0;
  float weight = 0.0;
  for ( int i = 0; i < fogRegions.count; i ++ ) {
    vec4 pose = texelFetch( fogRegions.data, ivec2( 0, i ), 0 );
    vec4 shape = texelFetch( fogRegions.data, ivec2( 1, i ), 0 );
    vec2 d = vec2( point.x, -point.y ) - pose.xy;
    vec2 p = vec2( dot( d, pose.zw ), dot( d, vec2( -pose.w, pose.z ) ) );
    float inside = shape.w > 0.5 ? shape.x - length( p ) : min( shape.x - abs( p.x ), shape.y - abs( p.y ) );
    float f = shape.z > 0.0 ? smoothstep( 0.0, shape.z, inside ) : step( 0.0, inside );
    weight = max( weight, f );
  }
  return weight;
}
float regionFogForRay( vec3 eye, vec3 surface ) {
  float dz = surface.z - eye.z;
  vec2 point = abs( dz ) > 1e-5 ? mix( eye.xy, surface.xy, -eye.z / dz ) : surface.xy;
  return regionFogAt( point );
}
`;
