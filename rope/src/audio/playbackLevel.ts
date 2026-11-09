import type { SoundFamily } from "./slots";
import { CHAIN_LINK_LEN } from "../render/chainMetrics";

// Rolling starts fading immediately on contact loss, but brief hops should
// not slam its envelope shut. No contact latch or airborne gain target.
export function loopGainFollow(family: SoundFamily): number {
  return family === "roll" ? 0.06 : 1 / 60;
}

// Link cues already become denser with motion. Share their level across the
// overlapping recordings instead of multiplying that density by ever louder
// individual hits. Duration is the actual edited, pitched playback window.
export function strikeLevel(family: SoundFamily, speed: number, refSpeed: number, seconds: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  const ratio = speed / Math.max(refSpeed, 1e-3);
  if (family === "wind" || family === "wrap") {
    const overlap = Math.max(1, speed / CHAIN_LINK_LEN * seconds);
    return Math.min(1, ratio) / Math.sqrt(overlap);
  }
  return Math.min(2, ratio);
}
