// The glass ball's WALL (Tris, 2026-10-16: "I want the crystal ball to have
// thin walls instead of being solid. I want to be able to configure the
// thickness of the wall"): how thick its quartz is, in metres, from the
// outside in. The rest is air. Read by the ball's look (glassMaterial.ts
// "HOLLOW") and by how it breaks (render/glassFracture.ts), so on its own,
// without three.js, for the pieces' worker.
//
// A wall as thick as the ball's radius, or more, is the solid ball. `?glasswall=`
// on the page's URL sets it for a visit, in millimetres (`solid` for the
// solid ball); `setGlassWall` while it runs.

// 6 mm: a hand-blown sphere's wall, on a ball 24 cm across. The rim's band of
// solid glass is a twentieth of its radius.
export const GLASS_WALL = 0.006;

export const glassWall: { value: number } = { value: GLASS_WALL };

// Whether a ball of `radius` with the current wall is solid quartz.
export function glassBallSolid(radius: number): boolean {
  return glassWall.value >= radius;
}

// `?glasswall=<mm>` or `?glasswall=solid`.
export function glassWallFrom(params: URLSearchParams): void {
  const v = params.get("glasswall");
  if (v === null) return;
  if (v === "solid") {
    glassWall.value = Infinity;
    return;
  }
  const mm = Number(v);
  if (Number.isFinite(mm) && mm > 0) glassWall.value = mm / 1000;
}
