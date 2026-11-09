// What plays when: the game's sound EVENTS and the files assigned to them
// (docs/sound.md#events-and-slots).
//
// Each event is a FAMILY - the ball rolling, the cuff attaching, a link winding
// on - and a family that depends on what was touched has a slot per SURFACE as
// well as a default. A surface slot with files of its own plays them; one
// without falls back to the family's default. So one file assigned to
// "Attach" sounds on every surface, and "Attach / Mud" overrides it where the
// cuff bites mud.
//
// The assignments are `soundBank.json`, written by the editor's Sounds menu
// through `/api/sounds/bank` and read by the game at load (and live, from the
// menu, over a BroadcastChannel - see `SoundSystem`).

import bank from "./soundBank.json";
import type { SurfaceKind } from "./surfaces";
import { SURFACE_KINDS } from "./surfaces";

export type SoundFamily = "roll" | "land" | "land-light" | "land-medium" | "land-heavy" | "loop-hit" | "ball-settle" | "attach" | "bounce" | "wind" | "deploy" | "retract" |"slack" | "chain-drag" | "hook-drag" | "chain-hit" | "taut" | "creak" | "wrap" | "whoosh" | "splash" | "wade";

export interface SlotParams {
  // Library keys (`SOUND_ASSETS`). A one-shot picks one at random each time,
  // never the same twice running; a loop picks one when it starts.
  sounds: string[];
  // Gain, dB, at the reference speed.
  volume: number;
  // The speed, m/s, the file sounds right at: a one-shot is played at
  // `volume` when it happens at this speed, quieter slower and louder faster
  // (up to twice as loud); a loop is played at `volume` and at its own pitch.
  refSpeed: number;
  // One-shots: each play is detuned by up to this many semitones either way,
  // so a sound heard many times does not read as one recording repeating.
  pitchJitter: number;
  // Loops: how far the pitch follows the speed - 0 never changes, 1 is pitch
  // in proportion to speed (twice as fast, an octave up).
  pitchFollow: number;
  // Loops: how far the PACE follows the speed - how fast the recording's own
  // time runs, apart from its pitch (docs/sound.md#pace-and-pitch). 0 never
  // changes, 1 is in proportion (twice as fast, the file's texture twice as
  // quick at the same pitch). Equal to `pitchFollow` is a tape played faster.
  paceFollow: number;
}

// How a library file is PLAYED, wherever it plays: the part of it heard and
// its own level and pitch, set in the Sounds menu's clip editor. The file is
// never rewritten - its bytes stay the recording that was uploaded, hashed
// and credited - so an edit is undone by deleting it. Every field is optional
// and absent means the file as it is.
export interface ClipEdit {
  // Where playing starts and stops, seconds into the file.
  start?: number;
  end?: number;
  // Gain, dB, on top of the slot's volume.
  volume?: number;
  // Semitones, on top of the slot's pitch: + is higher and shorter.
  pitch?: number;
}

export interface SoundBank {
  slots: Record<string, Partial<SlotParams>>;
  // By library key.
  clips?: Record<string, ClipEdit>;
}

// A clip edit resolved against the file's length: the window played, seconds
// of the FILE (not of playing time - a pitch changes how long it takes), and
// the gain and playback rate it adds.
export interface ClipPlay {
  start: number;
  end: number;
  gain: number;
  rate: number;
}

// The shortest window a crop may leave, seconds.
export const CLIP_MIN_SECONDS = 0.01;
export const CLIP_VOLUME_RANGE: readonly [number, number] = [-40, 24];
export const CLIP_PITCH_RANGE: readonly [number, number] = [-24, 24];

export function clipPlay(b: SoundBank, key: string, seconds: number): ClipPlay {
  const c = b.clips?.[key] ?? {};
  const end = Math.min(seconds, Math.max(CLIP_MIN_SECONDS, c.end ?? seconds));
  const start = Math.max(0, Math.min(end - CLIP_MIN_SECONDS, c.start ?? 0));
  return {
    start,
    end,
    gain: Math.pow(10, (c.volume ?? 0) / 20),
    rate: Math.pow(2, (c.pitch ?? 0) / 12),
  };
}

// The edit with what changes nothing left out, so the bank holds what was
// chosen and no more; null when nothing is left.
export function cleanClip(c: ClipEdit, seconds: number): ClipEdit | null {
  const out: ClipEdit = {};
  const round = (v: number): number => Math.round(v * 10000) / 10000;
  if (typeof c.start === "number" && Number.isFinite(c.start) && c.start > 0) out.start = round(c.start);
  if (typeof c.end === "number" && Number.isFinite(c.end) && c.end < seconds) out.end = round(c.end);
  if (out.start !== undefined && out.end !== undefined && out.end - out.start < CLIP_MIN_SECONDS) {
    throw new Error(`a clip must keep at least ${CLIP_MIN_SECONDS * 1000} ms`);
  }
  for (const [field, [lo, hi]] of [
    ["volume", CLIP_VOLUME_RANGE],
    ["pitch", CLIP_PITCH_RANGE],
  ] as const) {
    const v = c[field];
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) out[field] = round(Math.min(hi, Math.max(lo, v)));
  }
  return Object.keys(out).length ? out : null;
}

export interface FamilySpec {
  family: SoundFamily;
  label: string;
  // What it is, for the menu.
  help: string;
  loop: boolean;
  // The surfaces it has slots for, or null for an event that touches nothing.
  surfaces: readonly SurfaceKind[] | null;
  // What the reference speed measures, for the menu.
  speedIs: string;
  defaults: Omit<SlotParams, "sounds">;
}

// The ball never touches a vine (it passes through them), so a vine has no
// roll or landing.
const BALL_SURFACES = SURFACE_KINDS.filter((s) => s !== "vine");

export const FAMILIES: readonly FamilySpec[] = [
  {
    family: "roll",
    label: "Roll",
    help: "Sphere or mounting loop rolling along a surface. Short, varied recording grains at native pitch by default; contact travel controls level and tone rather than repeating a multi-second phrase.",
    loop: true,
    surfaces: BALL_SURFACES,
    speedIs: "rolling speed",
    // Preserve recorded transients; speed controls level and tone instead of
    // extreme time stretching (docs/sound.md#pace-and-pitch).
    defaults: { volume: 0, refSpeed: 3, pitchJitter: 0, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "land",
    label: "Land fallback",
    help: "Fallback sound for a landing or wall impact when a light, medium, or heavy slot has no recording.",
    loop: false,
    surfaces: BALL_SURFACES,
    speedIs: "speed into the surface",
    defaults: { volume: 0, refSpeed: 5, pitchJitter: 1, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "land-light",
    label: "Land · Light",
    help: "Gentle ball contacts: a dull metallic clink. Blends into Medium between 1.2 and 2.4 m/s into the surface.",
    loop: false,
    surfaces: BALL_SURFACES,
    speedIs: "speed into the surface",
    defaults: { volume: -6, refSpeed: 5, pitchJitter: 0.2, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "land-medium",
    label: "Land · Medium",
    help: "Medium-strength impacts. Full Medium from 2.4 to 4.5 m/s; blends with the neighboring strengths outside that range.",
    loop: false,
    surfaces: BALL_SURFACES,
    speedIs: "speed into the surface",
    defaults: { volume: -3, refSpeed: 5, pitchJitter: 0.15, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "land-heavy",
    label: "Land · Heavy",
    help: "Hard ball impacts. Blends in from 4.5 to 6.5 m/s into the surface, then plays on its own.",
    loop: false,
    surfaces: BALL_SURFACES,
    speedIs: "speed into the surface",
    defaults: { volume: 0, refSpeed: 5, pitchJitter: 0.15, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "loop-hit",
    label: "Mounting loop impact",
    help: "The mounting loop striking a surface. Its own recording and volume, independent of ball landing strengths. Unassigned means silent.",
    loop: false,
    surfaces: BALL_SURFACES,
    speedIs: "speed into the surface",
    defaults: { volume: -30, refSpeed: 3, pitchJitter: 0, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "ball-settle",
    label: "Ball returns from loop",
    help: "A quiet contact as the sphere returns after loop-only support. Separate from normal Light/Medium/Heavy landings; hard falls still use those.",
    loop: false,
    surfaces: BALL_SURFACES,
    speedIs: "speed into the surface",
    defaults: { volume: -30, refSpeed: 1, pitchJitter: 0, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "attach",
    label: "Attach",
    help: "The cuff catching hold: biting a surface, clamping a rail or root, threading a vine.",
    loop: false,
    surfaces: SURFACE_KINDS,
    speedIs: "speed of the cuff",
    defaults: { volume: 0, refSpeed: 12, pitchJitter: 1, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "bounce",
    label: "Bounce",
    help: "The cuff glancing off a hook-proof surface it cannot bite.",
    loop: false,
    surfaces: SURFACE_KINDS,
    speedIs: "speed into the surface",
    defaults: { volume: 0, refSpeed: 8, pitchJitter: 1, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "wind",
    label: "Wind link",
    help: "One link of chain winding onto the ball as it turns - played once per link, so a fast wind is a rattle.",
    loop: false,
    surfaces: null,
    speedIs: "winding speed",
    defaults: { volume: -6, refSpeed: 3, pitchJitter: 2, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "deploy",
    label: "Chain deploy",
    help: "Links rattling as the chain pays out during a throw. Stops when the flight ends; louder and quicker at higher payout speeds.",
    loop: true,
    surfaces: null,
    speedIs: "payout speed",
    defaults: { volume: -8, refSpeed: 12, pitchJitter: 0, pitchFollow: 0, paceFollow: 0.6 },
  },
  {
    family: "retract",
    label: "Chain retract",
    help: "One short zip of links as the chain is let go and reels back into the ball. A single gesture, not a rattle for the whole reel: heard every release, so it stays under the deploy it follows. Cut off when the chain's end reaches the loop, and by a new throw.",
    loop: false,
    surfaces: null,
    speedIs: "reel speed",
    defaults: { volume: -8, refSpeed: 12, pitchJitter: 0.25, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "slack",
    label: "Loose-link clinks",
    help: "Short, varied clinks triggered by local bending and relative link motion. No repeating movement loop; rigid translation and resting links stay silent.",
    loop: false,
    surfaces: null,
    speedIs: "loose-link motion",
    defaults: { volume: -12, refSpeed: 1, pitchJitter: 0, pitchFollow: 0, paceFollow: 0.4 },
  },
  {
    family: "hook-drag",
    label: "Hook dragging",
    help: "The free hook sliding over scenery in either direction, including when pulled up on a taut chain. Independent of loose-link motion.",
    loop: true,
    surfaces: SURFACE_KINDS,
    speedIs: "hook surface sliding speed",
    defaults: { volume: -8, refSpeed: 1, pitchJitter: 0, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "chain-drag",
    label: "Chain dragging",
    help: "Slack links sliding against scenery. Silent in the air and at rest; surface slots can override the default recording.",
    loop: true,
    surfaces: SURFACE_KINDS,
    speedIs: "surface sliding speed",
    defaults: { volume: -8, refSpeed: 1, pitchJitter: 0, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "chain-hit",
    label: "Chain link impact",
    help: "Short clinks from individual drape contacts. Approach speed selects intensity; nearby simultaneous hits combine, with repeated solver passes and resting contact suppressed.",
    loop: false,
    surfaces: SURFACE_KINDS,
    speedIs: "chain arrival speed",
    defaults: { volume: -6, refSpeed: 2, pitchJitter: 0, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "taut",
    label: "Chain goes taut",
    help: "A short catch when moving slack is taken up or a deploying chain reaches tension. One cue per catch, not a loop while taut.",
    loop: false,
    surfaces: null,
    speedIs: "slack take-up speed",
    defaults: { volume: -6, refSpeed: 3, pitchJitter: 0.3, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "creak",
    label: "Taut-chain creak",
    help: "Short friction phrases as loaded links start turning or travel farther. Movement triggers each phrase; no repeating playback while still or merely under tension.",
    loop: false,
    surfaces: null,
    speedIs: "loaded angular motion",
    defaults: { volume: -8, refSpeed: 1, pitchJitter: 0.2, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "wrap",
    label: "Chain wraps geometry",
    help: "Metal links striking the contacted material as a taut chain catches or feeds over scenery. Short clinks follow link travel, with rapid crossings grouped into gestures at least 40 ms apart per contact. Stationary wrapping and bend changes alone do not repeat it.",
    loop: false,
    surfaces: SURFACE_KINDS,
    speedIs: "loaded contact motion",
    defaults: { volume: -8, refSpeed: 1.5, pitchJitter: 0.3, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "whoosh",
    label: "Whoosh",
    help: "Wind rush at high player speed, swelling while gaining speed during swing wind-up. Constant-speed turning does not add acceleration boost. Native pitch; silent at walking speed and underwater.",
    loop: true,
    surfaces: null,
    speedIs: "speed through the air",
    defaults: { volume: -6, refSpeed: 12, pitchJitter: 0, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "splash",
    label: "Splash",
    help: "The ball dropping into water.",
    loop: false,
    surfaces: null,
    speedIs: "speed into the water",
    defaults: { volume: 0, refSpeed: 4, pitchJitter: 1, pitchFollow: 0, paceFollow: 0 },
  },
  {
    family: "wade",
    label: "Wade",
    help: "The ball moving through water at its surface. Looped.",
    loop: true,
    surfaces: null,
    speedIs: "speed through the water",
    defaults: { volume: 0, refSpeed: 2, pitchJitter: 0, pitchFollow: 0.3, paceFollow: 0.3 },
  },
];

export function familySpec(family: SoundFamily): FamilySpec {
  return FAMILIES.find((f) => f.family === family)!;
}

export function slotKey(family: SoundFamily, surface: SurfaceKind | null = null): string {
  return surface === null ? family : `${family}.${surface}`;
}

// A slot's settings with the family's defaults filled in.
export function slotParams(b: SoundBank, key: string, family: SoundFamily): SlotParams {
  const own = b.slots[key] ?? {};
  return { ...familySpec(family).defaults, ...own, sounds: own.sounds ?? [] };
}

// The slot that plays for `family` on `surface`: that surface's own if it has
// files, and otherwise the family's default if THAT has files; null is silence.
export function resolveSlot(
  b: SoundBank,
  family: SoundFamily,
  surface: SurfaceKind | null,
): { key: string; params: SlotParams } | null {
  if (surface !== null) {
    const key = slotKey(family, surface);
    const params = slotParams(b, key, family);
    if (params.sounds.length > 0) return { key, params };
  }
  const key = slotKey(family);
  const params = slotParams(b, key, family);
  return params.sounds.length > 0 ? { key, params } : null;
}

export interface LandingLayer {
  family: SoundFamily;
  key: string;
  params: SlotParams;
  weight: number;
}

// Velocity layers change the recording, not just its gain. Squared weights
// sum to one through each crossfade. Surface overrides resolve within each
// strength; legacy banks retain their single landing file as fallback.
export function landingMix(b: SoundBank, surface: SurfaceKind | null, speed: number): LandingLayer[] {
  if (!Number.isFinite(speed) || speed <= 0) return [];
  let weights: [SoundFamily, number][];
  if (speed <= 1.2) weights = [["land-light", 1]];
  else if (speed < 2.4) {
    const t = (speed - 1.2) / 1.2;
    weights = [["land-light", Math.sqrt(1 - t)], ["land-medium", Math.sqrt(t)]];
  } else if (speed <= 4.5) weights = [["land-medium", 1]];
  else if (speed < 6.5) {
    const t = (speed - 4.5) / 2;
    weights = [["land-medium", Math.sqrt(1 - t)], ["land-heavy", Math.sqrt(t)]];
  } else weights = [["land-heavy", 1]];
  const layers = new Map<string, LandingLayer>();
  for (const [family, weight] of weights) {
    const own = resolveSlot(b, family, surface);
    const resolved = own ?? resolveSlot(b, "land", surface);
    if (!resolved) continue;
    const existing = layers.get(resolved.key);
    if (existing) existing.weight = Math.hypot(existing.weight, weight);
    else layers.set(resolved.key, { ...resolved, family: own ? family : "land", weight });
  }
  return [...layers.values()];
}

// Every library key some slot names, which is what `cli assets` holds the
// library to (a file nothing plays is a file to remove).
export function assignedSounds(b: SoundBank): Set<string> {
  const out = new Set<string>();
  for (const slot of Object.values(b.slots)) for (const k of slot.sounds ?? []) out.add(k);
  return out;
}

// Every slot key there is, in the order the menu lists them.
export function allSlotKeys(): string[] {
  return FAMILIES.flatMap((f) => [slotKey(f.family), ...(f.surfaces ?? []).map((s) => slotKey(f.family, s))]);
}

// The bank the game starts with. Mutable, like the library: the editor's menu
// and the BroadcastChannel replace it in place.
export const SOUND_BANK: SoundBank = {
  slots: { ...(bank as SoundBank).slots },
  clips: { ...(bank as SoundBank).clips },
};

export function replaceSoundBank(next: SoundBank): void {
  SOUND_BANK.slots = { ...next.slots };
  SOUND_BANK.clips = { ...next.clips };
}
