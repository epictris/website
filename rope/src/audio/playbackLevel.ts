import type { SoundFamily } from "./slots";
import { CHAIN_LINK_LEN } from "../render/chainMetrics";

// A one-shot is louder the faster it happened, in proportion, up to twice its
// volume at the reference speed (`strikeLevel`); a loop up to this.
export const LOOP_MAX_GAIN = 1.5;

// Movement loops scale with reference speed. Wind uses its separate speed
// threshold and acceleration swell in windLevel; rolling keeps its soft floor.
export function loopLevel(family: SoundFamily, ratio: number): number {
  const fade = family === "roll" ? smoothstep(0, 0.03, ratio) : smoothstep(0.02, 0.1, ratio);
  const level = family === "roll" && ratio < 1 ? Math.pow(ratio, 1.25) : ratio;
  return Math.min(LOOP_MAX_GAIN, level) * fade;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Rolling starts fading immediately on contact loss, but brief hops should
// not slam its envelope shut. No contact latch or airborne gain target.
export function loopGainFollow(family: SoundFamily): number {
  // Payout must fade at attachment, rather than leaving a rattle tail.
  if (family === "deploy") return 0.001;
  if (family === "chain-drag" || family === "hook-drag") return 0.005;
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

// Buffer windows can end mid-waveform after an editor trim. Fade on the audio
// clock, accounting for playback rate, so a crop never creates a cut click.
export function scheduleShotEnvelope(
  param: Pick<AudioParam, "setValueAtTime" | "linearRampToValueAtTime">,
  gain: number, at: number, seconds: number,
): void {
  const attack = Math.min(0.0005, seconds / 4);
  const release = Math.min(0.004, seconds / 4);
  param.setValueAtTime(0, at);
  param.linearRampToValueAtTime(gain, at + attack);
  param.setValueAtTime(gain, at + seconds - release);
  param.linearRampToValueAtTime(0, at + seconds);
}

// Native-pitch wind: speed supplies the bed, positive speed gain supplies a
// bounded swell. Walking is silent; reference speed is the full rush level.
export function windLevel(speed: number, acceleration: number, refSpeed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  const ratio = speed / Math.max(refSpeed, 1e-3);
  const u = Math.max(0, Math.min(1, (ratio - 0.25) / 0.3));
  const gate = u * u * (3 - 2 * u);
  const bed = Math.min(1.25, ratio * ratio) * gate;
  const boost = 1 + 1.25 * Math.max(0, Math.min(1, Number.isFinite(acceleration) ? acceleration / 12 : 0));
  return Math.min(2.2, bed * boost);
}
