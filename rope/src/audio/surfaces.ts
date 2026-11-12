// Sound materials select impact and friction recordings independently of mass.
// An explicit per-shape soundMaterial wins. Automatic uses mechanical surface
// behaviour, never the density preset; legacy choices are migrated at build.

import { RigidBody2D, VineLink, type CollisionObject2D, type CollisionShape2D } from "../engine/body";
import { SOUND_MATERIALS, isSoundSurface, type SoundSurface } from "../lib/soundMaterial";

export type SurfaceKind = SoundSurface;

export const SURFACE_KINDS: readonly SurfaceKind[] = SOUND_MATERIALS;

// What each surface is in the levels, for the menu: the name, and where it
// comes from, so an author knows which slot a thing in the level plays.
export const SURFACE_LABELS: Record<SurfaceKind, { label: string; is: string }> = {
  moss: { label: "Moss", is: "moss sound material; automatic biteable scenery" },
  stone: { label: "Stone", is: "stone sound material; automatic hook-proof scenery" },
  wood: { label: "Wood", is: "wood sound material; automatic roots and moving bodies" },
  metal: { label: "Metal", is: "metal sound material; automatic rails" },
  mud: { label: "Mud", is: "viscous pieces" },
  vine: { label: "Vine", is: "vines (the cuff threads onto them; the ball passes through)" },
  ivy: { label: "Ivy", is: "shapes assigned the ivy sound material" },
  rubber: { label: "Rubber", is: "rubber sound material; automatic conveyor belts" },
  brick: { label: "Brick", is: "brick sound material" },
  glass: { label: "Glass", is: "glass sound material" },
  ice: { label: "Ice", is: "ice sound material" },
};

export function surfaceOf(piece: CollisionShape2D | null, body: CollisionObject2D): SurfaceKind {
  if (piece && isSoundSurface(piece.soundMaterial)) return piece.soundMaterial;
  if (body instanceof VineLink) return "vine";
  if (piece !== null) {
    if (piece.viscous) return "mud";
    if (piece.belt !== null) return "rubber";
    if (piece.rail?.root) return "wood";
    if (piece.rail !== null) return "metal";
    if (piece.impermeable) return "stone";
  }
  if (body instanceof RigidBody2D) return "wood";
  return "moss";
}
