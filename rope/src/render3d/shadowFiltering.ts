import * as THREE from "three";

const MARKER = "// Stable weighted shadow filter";

/** Nine fixed, bilinearly filtered samples; no screen-pixel sampling noise. */
export function stableShadowFiltering(source: string): string {
  if (source.includes(MARKER)) return source;
  const start = source.indexOf("float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;");
  const finish = source.indexOf(") * 0.2;", start);
  if (start < 0 || finish < 0 ||
      !source.slice(start, finish).includes("vogelDiskSample( 4, 5, phi )")) {
    throw new Error("Stable shadow filter hook missing");
  }
  const taps: string[] = [];
  const weights = [1, 2, 1];
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    taps.push(`${weights[x+1]! * weights[y+1]!}.0 * texture(shadowMap,
      vec3(shadowCoord.xy + vec2(${x}.0, ${y}.0) * texelSize * shadowRadius * 0.5, shadowCoord.z))`);
  }
  return source.slice(0, start) + `${MARKER}
    // The renderer has no temporal accumulation to resolve a randomized
    // kernel. Fixed weights stay continuous across pixels and shadow texels,
    // including the smaller radii used by leaves and local lights.
    shadow = (${taps.join(" +\n")}) / 16.0;
  ` + source.slice(finish + ") * 0.2;".length);
}

export function installStableShadowFiltering(): void {
  THREE.ShaderChunk.shadowmap_pars_fragment = stableShadowFiltering(THREE.ShaderChunk.shadowmap_pars_fragment);
}
