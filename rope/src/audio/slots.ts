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

export type SoundFamily = "roll" | "land" | "attach" | "bounce" | "wind" | "whoosh" | "splash" | "wade";

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
    help: "The ball rolling along a surface. Looped while it is in contact and moving; louder and quicker the faster it rolls, at the recording's own pitch.",
    loop: true,
    surfaces: BALL_SURFACES,
    speedIs: "rolling speed",
    // The roughness under the ball is struck at a rate in proportion to its
    // speed; the ball and the surface ring at their own frequencies whatever
    // the speed (docs/sound.md#pace-and-pitch).
    defaults: { volume: 0, refSpeed: 3, pitchJitter: 0, pitchFollow: 0, paceFollow: 1 },
  },
  {
    family: "land",
    label: "Land",
    help: "The ball arriving on a surface - a landing, or a hit against a wall.",
    loop: false,
    surfaces: BALL_SURFACES,
    speedIs: "speed into the surface",
    defaults: { volume: 0, refSpeed: 5, pitchJitter: 1, pitchFollow: 0, paceFollow: 0 },
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
    family: "whoosh",
    label: "Whoosh",
    help: "The air rushing past the ball. Looped; silent at rest and rising with speed.",
    loop: true,
    surfaces: null,
    speedIs: "speed through the air",
    defaults: { volume: 0, refSpeed: 12, pitchJitter: 0, pitchFollow: 0.3, paceFollow: 0.3 },
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
