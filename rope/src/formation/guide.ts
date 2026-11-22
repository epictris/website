// A formation's guide as the generator takes it (docs/formations.md).
//
// A collision guide is the body's pieces; the outline generators take ONE
// closed outline, which is the pieces' union (manifold-3d's CrossSection,
// the kernel the Orthographic Studio's solids use, imported from where it
// lives rather than copied). A solid guide is a boolean tree, meshed by
// `solid.ts`.
//
// FRAMES. A guide is in its body's frame as the level holds it: metres, x
// right, y DOWN. The generators build in the rock's own frame: Blender's, x
// right, z up, the play plane at y = 0, so a level point (x, y) is the outline
// point [x, -y] (docs/formations.md, "Coordinates"; held by `cli formations`,
// which generates from an asymmetric outline and checks where the rock lands).

import { manifold } from "../../../3d/orthographic/src/core/manifold";
import type { CollisionGuide, FormationData } from "../level/levelFormat";
import { piecePolygon, signedArea, type Pt } from "./outline";
import { formationRecipe } from "./recipe";

export { piecePolygon, signedArea, type Pt };

export interface GuideOutline {
  // The union's outer boundary in the body's frame, or null when there is not
  // exactly one (`error` says why).
  outline: Pt[] | null;
  // Holes in the union, which an outline generator cannot carry and fills.
  holes: number;
  error?: string;
}

// The union of a collision guide's pieces.
export function guideOutline(g: CollisionGuide): GuideOutline {
  const rings: [number, number][][] = [];
  let skipped = 0;
  for (const p of g.pieces) {
    const poly = piecePolygon(p);
    if (!poly) skipped++;
    else rings.push(poly.map((q) => [q.x, q.y]));
  }
  if (!rings.length) {
    return { outline: null, holes: 0, error: skipped ? "the guide's pieces are curves or belts, which enclose nothing" : "the guide has no pieces" };
  }
  // Each piece on its own with NonZero, then the union: a self-touching
  // polygon is one region, as the sim's decomposition reads it.
  const sections = rings.map((r) => manifold.CrossSection.ofPolygons([r], "NonZero"));
  const union = sections.length === 1 ? sections[0]! : manifold.CrossSection.union(sections);
  try {
    const parts = union.decompose();
    try {
      if (parts.length !== 1) {
        return {
          outline: null,
          holes: 0,
          error: parts.length ? `the guide's pieces make ${parts.length} separate shapes; a formation needs them to touch (or a subset that does)` : "the guide encloses nothing",
        };
      }
      const contours = parts[0]!.toPolygons().map((c) => c.map(([x, y]) => ({ x, y })));
      const outer = contours.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a));
      return { outline: outer, holes: contours.length - 1 };
    } finally {
      for (const p of parts) p.delete();
    }
  } finally {
    if (sections.length > 1) for (const s of sections) s.delete();
    union.delete();
  }
}

// The level frame to the rock's: (x, y down) -> [x, z up].
export function toRock(p: Pt): [number, number] {
  return [p.x, -p.y];
}

// The rock's frame to the level's.
export function fromRock(x: number, z: number): Pt {
  return { x, y: -z };
}

// What `formations/worker.py` is given for an outline formation: its outline
// in the rock's frame, clockwise there (as the worker's presets are), and
// every parameter resolved. Throws with the guide's own reason when it has no
// one outline.
export function workerRecipe(f: Pick<FormationData, "generator" | "variant" | "params" | "guide">): Record<string, unknown> {
  const r = formationRecipe(f);
  if (r.guide.kind !== "collision") throw new Error("a solid guide's worker recipe is built by solid.ts");
  const g = guideOutline(r.guide);
  if (!g.outline) throw new Error(g.error ?? "the guide has no outline");
  let outline = g.outline.map(toRock);
  // Clockwise in x/z (z up) has a negative signed area.
  if (signedArea(outline.map(([x, y]) => ({ x, y }))) > 0) outline = outline.reverse();
  return {
    version: r.version,
    generator: r.generator,
    outline: outline.map(([x, z]) => [Math.round(x * 1e6) / 1e6, Math.round(z * 1e6) / 1e6]),
    params: r.params,
  };
}
