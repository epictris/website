// Collision outline -> extruded solid. This is what makes the game look fully
// 3D before any asset exists: a body with no authored visual is drawn as its own
// collision geometry given depth, so what the player sees is exactly what they
// collide with and a level author can ship a level without touching the visual
// field at all.
//
// Three things about it are load-bearing, and each is a sign error away from
// looking merely "broken" rather than wrong:
//
// - WINDING. A physics polygon is wound clockwise on screen with y down, which
//   is what makes `polyEdgeNormal`'s outward normal outward (engine/shapes.ts).
//   Negating y mirrors the loop, so in three's frame it is counter-clockwise -
//   which happens to be the winding `ExtrudeGeometry` wants for its front cap to
//   face +z. That is a coincidence worth stating rather than relying on, so the
//   loop's signed area is measured and re-wound if it is ever not, and
//   `cli render3d` asserts the cap's normals.
// - DEPTH is centred on the gameplay plane, -depth/2 to +depth/2. The plane is
//   where the collision outline is, so a prop straddling it is the only
//   placement under which the 2D overlay's outline lands on the middle of the
//   solid rather than on its front or back face.
// - UVs ARE IN METRES. A texture then tiles at world scale, so a 4 m wall and a
//   0.4 m plank made of the same oak show the same grain rather than the same
//   number of repeats. `assets.ts` sets `texture.repeat` to 1/tile-size, which
//   is only meaningful because the UVs mean something.

import * as THREE from "three";
import type { Outline } from "../render/shapePath";

// How many segments a circle's outline is sampled at. A circle in this game is
// small (a barrel end, a wheel, the ball's own rim is drawn by ballVisual), so
// 24 is smooth at any zoom the camera reaches and costs nothing.
const CIRCLE_SEGMENTS = 24;

// Default edge break, metres. Small on purpose: it exists to catch a highlight
// along an edge so a prop reads as a solid object rather than as a flat-shaded
// slab, not to round the geometry off. ~2 authoring pixels.
export const DEFAULT_BEVEL = 0.02;

export interface ExtrudeOptions {
  // Total depth through z, INCLUDING the bevel: a 0.2 m slab is 0.2 m thick
  // however it is chamfered, so authoring a bevel never changes how thick the
  // thing the player sees is.
  depth: number;
  bevel?: number;
}

// UVs in metres on every face. Three's own `WorldUVGenerator` is metre-scaled on
// the caps but picks between x and y per side wall, which makes a texture jump
// 90 degrees around a corner; this measures along the wall instead.
const metreUVs: THREE.UVGenerator = {
  generateTopUV(_geometry, vertices, indexA, indexB, indexC) {
    return [
      new THREE.Vector2(vertices[indexA * 3]!, vertices[indexA * 3 + 1]!),
      new THREE.Vector2(vertices[indexB * 3]!, vertices[indexB * 3 + 1]!),
      new THREE.Vector2(vertices[indexC * 3]!, vertices[indexC * 3 + 1]!),
    ];
  },
  generateSideWallUV(_geometry, vertices, indexA, indexB, indexC, indexD) {
    const at = (i: number) => ({
      x: vertices[i * 3]!,
      y: vertices[i * 3 + 1]!,
      z: vertices[i * 3 + 2]!,
    });
    const a = at(indexA);
    const b = at(indexB);
    const c = at(indexC);
    const d = at(indexD);
    // The wall runs along a-b in the plane; u is the distance travelled along
    // that direction and v is the depth, both in metres. Measuring every one of
    // the four corners against the same axis is what keeps the quad's texture
    // square instead of sheared.
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    const u = (p: { x: number; y: number }) => (p.x - a.x) * dx + (p.y - a.y) * dy;
    return [
      new THREE.Vector2(u(a), a.z),
      new THREE.Vector2(u(b), b.z),
      new THREE.Vector2(u(c), c.z),
      new THREE.Vector2(u(d), d.z),
    ];
  },
};

// The outline as a three.js Shape, in three's frame (y negated) and wound so the
// front cap faces the camera.
function shapeOfOutline(o: Outline): THREE.Shape {
  const shape = new THREE.Shape();
  if (o.kind === "circle") {
    // Sampled at CIRCLE_SEGMENTS by the extrude options below, which is where
    // three reads a curve's resolution from.
    shape.absarc(0, 0, o.radius, 0, Math.PI * 2, false);
    return shape;
  }
  const local =
    o.kind === "rect"
      ? [
          { x: -o.half.x, y: -o.half.y },
          { x: o.half.x, y: -o.half.y },
          { x: o.half.x, y: o.half.y },
          { x: -o.half.x, y: o.half.y },
        ]
      : o.verts.map((v) => ({ x: v.x, y: v.y }));
  // Into three's frame. This is the one negation, and it is what flips the
  // loop's handedness.
  const pts = local.map((v) => new THREE.Vector2(v.x, -v.y));
  // Signed area: positive is counter-clockwise in three's y-up frame, which is
  // what `ExtrudeGeometry` treats as the outside of the shape.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) pts.reverse();
  shape.setFromPoints(pts);
  return shape;
}

// An outline extruded into a solid centred on the gameplay plane, in three's
// frame. The caller places it; nothing here knows where the body is.
export function extrudeOutline(o: Outline, opts: ExtrudeOptions): THREE.ExtrudeGeometry {
  const bevel = Math.max(0, Math.min(opts.bevel ?? DEFAULT_BEVEL, opts.depth * 0.25));
  const core = Math.max(1e-4, opts.depth - 2 * bevel);
  const geo = new THREE.ExtrudeGeometry(shapeOfOutline(o), {
    depth: core,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: CIRCLE_SEGMENTS,
    steps: 1,
    UVGenerator: metreUVs,
  });
  // `ExtrudeGeometry` builds from z = -bevel to z = core + bevel; the gameplay
  // plane is the middle of the solid, not its back face.
  geo.translate(0, 0, -(core / 2));
  geo.computeVertexNormals();
  return geo;
}
