// Which SURFACE a piece is, for what it sounds like (docs/sound.md#surfaces).
//
// The level says what a piece does - the hook bites it or it is hook-proof, it
// is mud, a belt, a root, a vine, a rail - and only sometimes what it is made
// of (`CollisionObjectData.material`, which is mostly a density). A surface is
// decided by the most specific of those it has, in this order:
//
// 1. What the piece IS mechanically, where that settles the material: mud
//    (`viscosity`), a belt's band (rubber), a vine, a root (wood).
// 2. The material the level authored for the piece, where it named one.
// 3. A rail is a bar of steel.
// 4. Hook-proof is stone. In `BALL` every hook-proof piece is a dark rock or a
//    boulder, and a face the cuff cannot bite is a hard one.
// 5. A moving body is wood: its mass was computed as wood (the default
//    material), so that is what it is.
// 6. Everything else - scenery the hook can bite - is the soft ground it bites
//    into: moss over earth, which is what `BALL`'s biteable rocks are.

import { RigidBody2D, VineLink, type CollisionObject2D, type CollisionShape2D } from "../engine/body";

export type SurfaceKind =
  | "stone"
  | "moss"
  | "wood"
  | "metal"
  | "glass"
  | "brick"
  | "ice"
  | "rubber"
  | "mud"
  | "vine";

export const SURFACE_KINDS: readonly SurfaceKind[] = [
  "moss",
  "stone",
  "wood",
  "metal",
  "mud",
  "vine",
  "rubber",
  "brick",
  "glass",
  "ice",
];

// What each surface is in the levels, for the menu: the name, and where it
// comes from, so an author knows which slot a thing in the level plays.
export const SURFACE_LABELS: Record<SurfaceKind, { label: string; is: string }> = {
  moss: { label: "Moss", is: "scenery the cuff can bite, with no material set (BALL's mossy rocks)" },
  stone: { label: "Stone", is: "hook-proof scenery (BALL's dark rocks and boulders), or material stone" },
  wood: { label: "Wood", is: "roots, moving bodies, material wood" },
  metal: { label: "Metal", is: "rails, material steel, cast iron, aluminium or lead" },
  mud: { label: "Mud", is: "viscous pieces" },
  vine: { label: "Vine", is: "vines (the cuff threads onto them; the ball passes through)" },
  rubber: { label: "Rubber", is: "conveyor belts, material rubber or flesh" },
  brick: { label: "Brick", is: "material brick" },
  glass: { label: "Glass", is: "material glass" },
  ice: { label: "Ice", is: "material ice" },
};

// The authored material names (`MATERIALS` in lib/shapeGeometry.ts) as
// surfaces. `flesh` is soft and elastic: rubber rather than moss.
const MATERIAL_SURFACE: Record<string, SurfaceKind> = {
  wood: "wood",
  ice: "ice",
  flesh: "rubber",
  rubber: "rubber",
  brick: "brick",
  stone: "stone",
  glass: "glass",
  aluminium: "metal",
  "cast iron": "metal",
  steel: "metal",
  lead: "metal",
};

export function surfaceOf(piece: CollisionShape2D | null, body: CollisionObject2D): SurfaceKind {
  if (body instanceof VineLink) return "vine";
  if (piece !== null) {
    if (piece.viscous) return "mud";
    if (piece.belt !== null) return "rubber";
    if (piece.rail?.root) return "wood";
    const authored = piece.material !== null ? MATERIAL_SURFACE[piece.material] : undefined;
    if (authored !== undefined) return authored;
    if (piece.rail !== null) return "metal";
    if (piece.impermeable) return "stone";
  }
  if (body instanceof RigidBody2D) return "wood";
  return "moss";
}
