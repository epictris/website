// CUT (plans/sculpt-guides.md, "Cut"): a polygon drawn on the screen keeps
// only what of a guide lies inside it as seen from the camera (or, with Alt,
// cuts that away). The kept region is built as a solid and the guide is
// intersected with it (or has it subtracted) in manifold-3d.
//
// - ORTHOGRAPHIC: the polygon swept along the view, a prism: its
//   cross-section in the camera's x/y, extruded along the camera's -z over
//   the guide's depth.
// - PERSPECTIVE: the cone from the eye through the polygon. The same
//   construction with the cross-section placed on a plane at a near distance
//   (the polygon's slopes times `near`, the origin on the camera's axis) and
//   extruded to a far distance with its top scaled by far / near: a linear
//   extrusion scaled about the axis is exactly the projective frustum, since
//   each side runs from p at depth near to p x far / near at depth far, along
//   the ray from the eye through p.

import { manifold, type Manifold } from "./manifold";

export interface CutView {
  kind: "orthographic" | "perspective";
  // The polygon in the camera's frame: for an orthographic camera its x/y
  // (metres); for a perspective one its slopes, x/-z and y/-z (the point on
  // the plane a metre in front of the eye).
  polygon: readonly (readonly [number, number])[];
  // Camera frame to the guide's frame, column-major 4x4 (rigid).
  cameraToGuide: readonly number[];
  // How far in front of the camera the guide begins and ends (positive,
  // along the view): the region is built between them, with a margin.
  near: number;
  far: number;
}

// The kept region as a solid in the guide's frame (the caller deletes it).
export function cutRegion(view: CutView): Manifold {
  const far = view.far * 1.25 + 0.1;
  // A perspective cone's tip stays a hair in front of the eye; an
  // orthographic prism may start behind it.
  const near = view.kind === "perspective" ? Math.max(1e-3, Math.min(view.near * 0.5, far * 0.01)) : view.near - 0.1 - Math.abs(view.near) * 0.25;
  const scale = view.kind === "perspective" ? near : 1;
  const cs = manifold.CrossSection.ofPolygons([view.polygon.map(([x, y]) => [x * scale, y * scale] as [number, number])], "NonZero");
  try {
    let solid: Manifold;
    if (view.kind === "perspective") {
      const grow = far / near;
      const up = manifold.Manifold.extrude(cs, far - near, 0, 0, [grow, grow]);
      // z 0 (scale 1) to z far-near (scale far/near), turned to run from
      // -near to -far: mirrored in z, then moved back by near.
      const mirrored = up.mirror([0, 0, 1]);
      solid = mirrored.translate([0, 0, -near]);
      up.delete();
      mirrored.delete();
    } else {
      const up = manifold.Manifold.extrude(cs, far - near);
      solid = up.translate([0, 0, -far]);
      up.delete();
    }
    const placed = solid.transform([...view.cameraToGuide] as never);
    solid.delete();
    return placed;
  } finally {
    cs.delete();
  }
}

// The guide cut: what of it is inside the region (or, `subtract`, outside
// it). The caller deletes the result.
export function cutGuide(guide: Manifold, view: CutView, subtract: boolean): Manifold {
  const region = cutRegion(view);
  try {
    return subtract ? guide.subtract(region) : guide.intersect(region);
  } finally {
    region.delete();
  }
}

// Whether a closed polygon (screen points) is simple: no two of its edges
// cross. What Cut refuses while it is drawn, as +Poly does.
export function polygonIsSimple(points: readonly (readonly [number, number])[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]): number => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // Neighbouring edges share a corner and do not count.
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = points[j]!, d = points[(j + 1) % n]!;
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return false;
    }
  }
  return true;
}
