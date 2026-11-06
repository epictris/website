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
}

export interface SoundBank {
  slots: Record<string, Partial<SlotParams>>;
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
    help: "The ball rolling along a surface. Looped while it is in contact and moving; louder and higher the faster it rolls.",
    loop: true,
    surfaces: BALL_SURFACES,
    speedIs: "rolling speed",
    defaults: { volume: 0, refSpeed: 3, pitchJitter: 0, pitchFollow: 0.5 },
  },
  {
    family: "land",
    label: "Land",
    help: "The ball arriving on a surface - a landing, or a hit against a wall.",
    loop: false,
    surfaces: BALL_SURFACES,
    speedIs: "speed into the surface",
    defaults: { volume: 0, refSpeed: 5, pitchJitter: 1, pitchFollow: 0 },
  },
  {
    family: "attach",
    label: "Attach",
    help: "The cuff catching hold: biting a surface, clamping a rail or root, threading a vine.",
    loop: false,
    surfaces: SURFACE_KINDS,
    speedIs: "speed of the cuff",
    defaults: { volume: 0, refSpeed: 12, pitchJitter: 1, pitchFollow: 0 },
  },
  {
    family: "bounce",
    label: "Bounce",
    help: "The cuff glancing off a hook-proof surface it cannot bite.",
    loop: false,
    surfaces: SURFACE_KINDS,
    speedIs: "speed into the surface",
    defaults: { volume: 0, refSpeed: 8, pitchJitter: 1, pitchFollow: 0 },
  },
  {
    family: "wind",
    label: "Wind link",
    help: "One link of chain winding onto the ball as it turns - played once per link, so a fast wind is a rattle.",
    loop: false,
    surfaces: null,
    speedIs: "winding speed",
    defaults: { volume: -6, refSpeed: 3, pitchJitter: 2, pitchFollow: 0 },
  },
  {
    family: "whoosh",
    label: "Whoosh",
    help: "The air rushing past the ball. Looped; silent at rest and rising with speed.",
    loop: true,
    surfaces: null,
    speedIs: "speed through the air",
    defaults: { volume: 0, refSpeed: 12, pitchJitter: 0, pitchFollow: 0.3 },
  },
  {
    family: "splash",
    label: "Splash",
    help: "The ball dropping into water.",
    loop: false,
    surfaces: null,
    speedIs: "speed into the water",
    defaults: { volume: 0, refSpeed: 4, pitchJitter: 1, pitchFollow: 0 },
  },
  {
    family: "wade",
    label: "Wade",
    help: "The ball moving through water at its surface. Looped.",
    loop: true,
    surfaces: null,
    speedIs: "speed through the water",
    defaults: { volume: 0, refSpeed: 2, pitchJitter: 0, pitchFollow: 0.3 },
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
export const SOUND_BANK: SoundBank = { slots: { ...(bank as SoundBank).slots } };

export function replaceSoundBank(next: SoundBank): void {
  SOUND_BANK.slots = { ...next.slots };
}
