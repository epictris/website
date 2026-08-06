// Authored outline -> extruded solid. This is what makes the game look fully 3D
// before any asset exists: a geometry object with no prop named on it is drawn
// as its own outline given depth, so a level is fully 3D the moment it loads and
// an author who wants a wall to look like a wall need only say how big it is.
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

// NO EDGE BREAK BY DEFAULT. A bevel exists to catch a highlight along an edge so
// a solid reads as an object rather than as a flat-shaded slab, and it is worth
// having on a prop - but a level is boxes meeting boxes, and a chamfer on every
// one of them softens exactly the corners its silhouette is made of. It is
// authored per object (`GeometryObjectData.bevel`) where it earns its place.
export const DEFAULT_BEVEL = 0;

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

// A CIRCLE IS A CYLINDER, and gets three's own cylinder rather than its outline
// extruded. The two are the same solid, and what differs is the shading: an
// extruded 24-gon has one flat normal per facet, so a barrel lit from the side
// reads as a faceted prism, while a cylinder's side normals point radially and
// the highlight travels round it smoothly. It is also fewer triangles for the
// same silhouette, since a cylinder needs no cap triangulation past its fan.
//
// The bevel is deliberately dropped here. It exists to catch a highlight along
// an EDGE, and a cylinder's only edges are the two rims; chamfering those means
// a second lathe and buys almost nothing on a shape the level views end-on.
const CYLINDER_SEGMENTS = 48;

export function cylinderSolid(radius: number, depth: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, depth, CYLINDER_SEGMENTS, 1, false);
  // UVs IN METRES, the same contract the extruder writes under - a texture has
  // to tile at world scale whichever primitive it is on, or the same stone
  // shows a different brick size on a wall and on the pillar beside it.
  //
  // Rewritten from three's own 0..1 UVs rather than derived from the positions,
  // which is what keeps the seam right: the seam column is a DUPLICATED ring of
  // vertices carrying u = 0 and u = 1, and an angle measured from a position
  // gives both of them the same answer and wraps the last quad backwards over
  // the whole texture.
  const uv = geo.attributes.uv!;
  const pos = geo.attributes.position!;
  const nrm = geo.attributes.normal!;
  const circumference = 2 * Math.PI * radius;
  for (let i = 0; i < uv.count; i++) {
    // Pre-rotation the caps face ±y and the walls point radially, so the normal
    // says which of the two conventions this vertex is under.
    if (Math.abs(nrm.getY(i)) > 0.5) {
      // A cap is measured in the plane it is drawn in, exactly as the extruder's
      // top-face UVs are: after the rotation below that plane is x/y.
      uv.setXY(i, pos.getX(i), -pos.getZ(i));
    } else {
      uv.setXY(i, uv.getX(i) * circumference, pos.getY(i));
    }
  }
  // Three's cylinder stands along y; the gameplay plane's solids run through z,
  // centred on the plane - which is where the lathe already puts the middle.
  geo.rotateX(Math.PI / 2);
  return geo;
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
    // A CHAMFER OFF THE OUTLINE, not a swelling around it. Three's bevel runs
    // from `bevelOffset` at the caps to `bevelOffset + bevelSize` at the middle,
    // so the default 0 leaves the caps on the outline and pushes the middle
    // `bevelSize` PAST it: every drawn solid stood 2 cm proud of the shape it was
    // drawn from on all four sides, and a floor slab that is 2 cm taller than
    // its collision box is a floor the ball visibly sinks into.
    //
    // Offset by -bevelSize instead and the middle lands exactly on the outline
    // with the caps chamfered in, which is what a broken edge is: the solid is
    // then contained by the shape it states, and a body drawn from its own
    // collision outline touches what it collides with.
    bevelOffset: -bevel,
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
