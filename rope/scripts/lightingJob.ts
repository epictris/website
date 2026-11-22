// Shared by scene guides and Blender's standalone model-lighting preview.
// Keep colours, sky pixels and defaults in the game's own implementation.
import type { EnvironmentData } from "../src/level/levelFormat";
import { EQUIRECT_SIZE, equirectPixels, lightingOf, TONE_MAPPING_EXPOSURE } from "../src/render3d/environment";

export function lightingJob(environment: EnvironmentData | undefined) {
  const l = lightingOf(environment);
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const color = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b].map(round);
  return {
    sun: l.sun && {
      color: color(l.sun.color), intensity: l.sun.intensity,
      dir: l.sun.dir.toArray().map(v => Math.round(v * 1e4) / 1e4),
    },
    fill: { sky: color(l.fill.sky), ground: color(l.fill.ground), intensity: l.fill.intensity },
    sky: { ...EQUIRECT_SIZE, pixels: Array.from(equirectPixels(l.sky), round) },
    envIntensity: l.envIntensity,
    background: l.background,
    hdri: l.hdri,
    toneMappingExposure: TONE_MAPPING_EXPOSURE,
  };
}
