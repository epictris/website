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
// the caps but reads a side wall's u straight off whichever of x and y varies
// more, which shears a diagonal edge (a 45 degree wall gets 1/sqrt(2) of the
// repeats it should); this measures ALONG the wall instead, so a repeat is a
// metre of surface travelled whatever angle the edge runs at.
//
// `core` is the depth of the straight part of the solid, so the depth axis reads
// zero at `core / 2` - the offset the caller is about to translate the solid by.
// `ExtrudeGeometry` builds from z = 0 and the gameplay plane is the MIDDLE of the
// finished solid, so measuring depth off the raw vertex would anchor a side
// wall's texture to the solid's back face - and re-authoring a wall's `depth`
// would then slide the texture on its returns.
//
// `bevel` is the chamfer's radius, and it is here because THE CHAMFER IS THE CAP
// UNROLLED - see `generateSideWallUV`.
const metreUVs = (core: number, bevel: number): THREE.UVGenerator => {
  const zOrigin = core / 2;
  // Where a point on the chamfer sits on the quarter-round, as the angle three
  // swept to place it: 0 at the ring touching the cap, pi/2 where the round
  // meets the straight wall. `ExtrudeGeometry` lays its bevel rings out at
  // `z = bevelThickness * cos(phi)` beyond the core and `bevelSize * (1 - sin
  // (phi))` in from the outline, and this project asks for the two equal, so the
  // depth alone recovers the angle.
  const bevelAngle = (z: number): number => {
    const beyond = Math.abs(z - zOrigin) - zOrigin;
    return Math.acos(Math.min(1, Math.max(0, beyond / bevel)));
  };
  return {
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
      // THE CHAMFER IS THE CAP, UNROLLED. A quad whose two rings sit at different
      // insets is a band of the bevel rather than a piece of the straight wall,
      // and the depth mapping below is wrong for it twice over: three lays the
      // quarter-round out so the ring nearest the cap barely advances through z at
      // all while covering most of the round's arc, so `p.z` compresses that band
      // to a third of its surface and smears the texture across it - and it
      // compresses the outer band by a different factor again, so the chamfer
      // reads as two mismatched stripes rather than as one surface.
      //
      // So the band is mapped by rolling it flat into the CAP's plane: a point is
      // carried outward along its own bevel offset by the difference between the
      // arc it has travelled and the distance that travel covered in the plane,
      // `bevel * (phi - sin phi)`, and then wears the cap's own rule. That is an
      // isometry - the flattened point moves at exactly the rate the surface does,
      // in every direction - so the texture neither stretches nor bands, and it is
      // exactly zero at the cap ring, where the cap's own vertices are: the two
      // meet with no seam at all.
      //
      // What is left over lands where the chamfer meets the straight wall, which
      // is the solid's silhouette. That is where it belongs: the game's camera
      // looks along the depth axis, so the chamfer is a rim seen nearly face on
      // and foreshortens to nothing at its outer edge, and a break there is a
      // break in the pixels the wall was already about to end in. Anchoring the
      // other way round - continuing the wall's depth mapping inward - puts the
      // same break in the middle of the rim, in full view.
      //
      // `d` shares a contour index with `a` (and `c` with `b`), so the vector
      // between the two is that vertex's own inset offset - along the CORNER
      // BISECTOR three placed it on, which is what keeps the two quads meeting
      // at a corner agreeing about where the texture goes. It is read straight
      // off the geometry rather than rebuilt, so its length and its sign are
      // three's and there is no winding or facing to get right: the front rings
      // run inward as z grows and the back ones outward, and the arithmetic
      // below carries the sign of each with it.
      const insetX = d.x - a.x;
      const insetY = d.y - a.y;
      if (bevel > 0 && Math.hypot(insetX, insetY) > 1e-9) {
        const phiA = bevelAngle(a.z);
        const phiD = bevelAngle(d.z);
        // The two rings are `bevel * (sin phiD - sin phiA)` of that offset
        // apart, so dividing by it turns the arc excess into a share of the
        // vector and the bisector's own length is never needed.
        const spread = Math.sin(phiD) - Math.sin(phiA);
        const flat = (
          p: { x: number; y: number; z: number },
          fromX: number,
          fromY: number,
        ) => {
          const phi = bevelAngle(p.z);
          const k = Math.abs(spread) < 1e-12 ? 0 : (phi - Math.sin(phi)) / spread;
          return new THREE.Vector2(p.x + fromX * k, p.y + fromY * k);
        };
        const bcX = c.x - b.x;
        const bcY = c.y - b.y;
        return [
          flat(a, insetX, insetY),
          flat(b, bcX, bcY),
          flat(c, bcX, bcY),
          flat(d, insetX, insetY),
        ];
      }
      // The wall runs along a-b in the plane, and the other axis it has is the
      // depth. Which of the two is u is decided by WHICH WAY THE EDGE RUNS, and
      // that is what keeps a texture upright: a texture's own u is horizontal, so
      // handing u to the along-edge distance on a VERTICAL edge maps the picture's
      // horizontal onto world-vertical and lays every brick on its end. It is the
      // one thing three's generator gets right and the reason it branches at all.
      //
      // Both axes are anchored in the body's own frame rather than at the corner
      // the quad happens to start from, so a side wall's texture is continuous
      // with the cap's beside it (the caps are world x/y) and a `tileOffset` means
      // the same thing on both. Along a diagonal edge that anchoring is exact only
      // in the direction it is measured; the metre scale is the edge's either way.
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
      // Distance travelled along the edge from a, signed so it grows the way the
      // world axis it stands in for grows.
      const along = (p: { x: number; y: number }) =>
        ((p.x - a.x) * dx + (p.y - a.y) * dy) * (Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : Math.sign(dy));
      const uv =
        Math.abs(dx) >= Math.abs(dy)
          ? // A horizontal-ish edge (a floor's top face, a wall's underside): the
            // along-edge run stands in for world x, and the depth is v.
            (p: { x: number; y: number; z: number }) =>
              new THREE.Vector2(a.x + along(p), p.z - zOrigin)
          : // A vertical-ish edge (a wall's left and right returns): the depth is
            // u and the along-edge run stands in for world y, which is up.
            (p: { x: number; y: number; z: number }) =>
              new THREE.Vector2(p.z - zOrigin, a.y + along(p));
      return [uv(a), uv(b), uv(c), uv(d)];
    },
  };
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
  shape.setFromPoints(loopOfOutline(o));
  return shape;
}

// The outline as a counter-clockwise loop in three's frame (a circle sampled at
// CIRCLE_SEGMENTS, a polygon's hole ignored).
function loopOfOutline(o: Outline): THREE.Vector2[] {
  if (o.kind === "circle") {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      pts.push(new THREE.Vector2(Math.cos(a) * o.radius, Math.sin(a) * o.radius));
    }
    return pts;
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
  if (signedArea(pts) < 0) pts.reverse();
  return pts;
}

function signedArea(pts: readonly THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
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
    // The core is what the translate below is measured from, so the depth axis
    // of a side wall's UVs reads zero on the gameplay plane; the bevel is what
    // says which quads are the chamfer and how far round it each point sits.
    UVGenerator: metreUVs(core, bevel),
  });
  // `ExtrudeGeometry` builds from z = -bevel to z = core + bevel; the gameplay
  // plane is the middle of the solid, not its back face.
  geo.translate(0, 0, -(core / 2));
  geo.computeVertexNormals();
  return geo;
}

// A GENERATED ROCK'S REFERENCE SOLID (docs/rocks.md). The rock pipeline fills
// an outline with shards that stand on it from the back of the solid up to
// `taperStart` in front of the gameplay plane and then lean in from the wall by
// `taperAngle`, so where a rock is drawn by its extrusion - in the editor, and
// in the game while its generated mesh is stale - the extrusion shows THAT
// shape: a straight prism to the start and a roof over it whose height is the
// distance in from the outline times the slope, capped at the front. The
// author reads the taper off this while setting it, in place of the bevel,
// which the generator does not read.
export interface TaperOptions {
  depth: number;
  // Metres in front of the plane where the roof starts (clamped to the solid).
  taperStart: number;
  // Degrees the roof leans in from the outline's wall: 0 is no roof (a
  // straight extrusion), 90 a flat cap at the start.
  taperAngle: number;
}

// Under this angle there is no taper, and over 90 minus it the roof is flat -
// the generator's `TAPER_EPSILON`.
const TAPER_EPSILON = 0.05;
// The roof is a height field over the outline: it is sampled at about this many
// cells across the outline's longer side, between these cell sizes in metres.
// The height is the distance to the outline, which is exact at every sample,
// so the ridge where the roof meets the front cap is the only thing the
// sampling softens.
const ROOF_CELLS = 32;
const ROOF_CELL_MIN = 0.04;
const ROOF_CELL_MAX = 0.5;

export function taperOutline(o: Outline, opts: TaperOptions): THREE.BufferGeometry {
  const half = opts.depth / 2;
  const angle = Math.max(0, Math.min(90, opts.taperAngle));
  if (angle <= TAPER_EPSILON || (o.kind === "poly" && o.hole !== undefined)) {
    if (o.kind === "circle") return cylinderSolid(o.radius, opts.depth);
    return extrudeOutline(o, { depth: opts.depth, bevel: 0 });
  }
  const start = Math.max(-half, Math.min(half, opts.taperStart));
  const rise = angle >= 90 - TAPER_EPSILON ? 0 : 1 / Math.tan((angle * Math.PI) / 180);
  const loop = loopOfOutline(o);
  const n = loop.length;

  // THE ROOF IS A GRID OF CELLS, each the piece of the outline inside one cell
  // of a grid over it (a Sutherland-Hodgman clip of the loop by the cell,
  // which is exact because the cell is convex), triangulated on its own. The
  // vertices on the outline have height `start`, so the roof meets the wall's
  // top edge exactly, and every other vertex is the roof's true height there.
  // Earcut over the outline with the grid points as Steiner points came
  // first and drew the slope as long slivers fanning from the corners, whose
  // smoothed normals streaked the surface; cells give well-shaped triangles.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of loop) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const cell = Math.max(ROOF_CELL_MIN, Math.min(ROOF_CELL_MAX, Math.max(maxX - minX, maxY - minY) / ROOF_CELLS));
  const heightAt = (p: THREE.Vector2): number => Math.min(half, start + distanceToLoop(p, loop) * rise);
  // Smooth normals over the roof, accumulated by position so the cells share
  // them: a sampled slope then reads as one surface rather than as the grid
  // it was sampled on.
  const key = (p: THREE.Vector2): string => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
  const normals = new Map<string, THREE.Vector3>();
  const roof: { pts: THREE.Vector2[]; z: number[]; tris: number[][] }[] = [];
  const a3 = new THREE.Vector3();
  const b3 = new THREE.Vector3();
  const c3 = new THREE.Vector3();
  const face = new THREE.Vector3();
  for (let x0 = minX; x0 < maxX; x0 += cell) {
    for (let y0 = minY; y0 < maxY; y0 += cell) {
      const piece = clipLoopToCell(loop, x0, y0, Math.min(x0 + cell, maxX), Math.min(y0 + cell, maxY));
      if (piece.length < 3 || Math.abs(signedArea(piece)) < 1e-10) continue;
      const tris = THREE.ShapeUtils.triangulateShape(piece.map((p) => p.clone()), []);
      const z = piece.map((p) => heightAt(p));
      for (const t of tris) {
        if (signedArea([piece[t[0]!]!, piece[t[1]!]!, piece[t[2]!]!]) < 0) t.reverse();
        a3.set(piece[t[0]!]!.x, piece[t[0]!]!.y, z[t[0]!]!);
        b3.set(piece[t[1]!]!.x, piece[t[1]!]!.y, z[t[1]!]!);
        c3.set(piece[t[2]!]!.x, piece[t[2]!]!.y, z[t[2]!]!);
        face.subVectors(b3, a3).cross(c3.sub(a3));
        for (const i of t) {
          const k = key(piece[i]!);
          const acc = normals.get(k);
          if (acc) acc.add(face);
          else normals.set(k, face.clone());
        }
      }
      roof.push({ pts: piece, z, tris });
    }
  }
  for (const nrm of normals.values()) if (nrm.lengthSq() > 0) nrm.normalize();

  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    uv.push(u, v);
  };
  // The roof, with the cap's UV rule: measured in the plane it is drawn in.
  for (const { pts, z, tris } of roof) {
    for (const t of tris) {
      for (const i of t) {
        const p = pts[i]!;
        const nrm = normals.get(key(p))!;
        push(p.x, p.y, z[i]!, nrm.x, nrm.y, nrm.z, p.x, p.y);
      }
    }
  }
  // The back cap, facing away.
  for (const t of THREE.ShapeUtils.triangulateShape(loop.map((p) => p.clone()), [])) {
    if (signedArea([loop[t[0]!]!, loop[t[1]!]!, loop[t[2]!]!]) < 0) t.reverse();
    for (const i of [t[0]!, t[2]!, t[1]!]) push(loop[i]!.x, loop[i]!.y, -half, 0, 0, -1, loop[i]!.x, loop[i]!.y);
  }
  // The walls, from the back to the start, u along the outline and v through
  // depth reading zero on the plane - the extruder's rule for a side wall.
  if (start > -half + 1e-4) {
    let u = 0;
    for (let i = 0; i < n; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % n]!;
      const len = a.distanceTo(b);
      // Outward for a counter-clockwise loop.
      const nx = (b.y - a.y) / len;
      const ny = -(b.x - a.x) / len;
      push(a.x, a.y, -half, nx, ny, 0, u, -half);
      push(b.x, b.y, -half, nx, ny, 0, u + len, -half);
      push(b.x, b.y, start, nx, ny, 0, u + len, start);
      push(a.x, a.y, -half, nx, ny, 0, u, -half);
      push(b.x, b.y, start, nx, ny, 0, u + len, start);
      push(a.x, a.y, start, nx, ny, 0, u, start);
      u += len;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

// The part of the loop inside the axis-aligned cell: Sutherland-Hodgman, one
// half-plane per cell side. The subject may be concave; the clipper is convex,
// which is all the algorithm needs. Where the loop leaves and re-enters the
// cell the result carries a zero-width bridge along the cell's side, which
// triangulates to nothing and draws as nothing.
function clipLoopToCell(loop: readonly THREE.Vector2[], x0: number, y0: number, x1: number, y1: number): THREE.Vector2[] {
  let out: THREE.Vector2[] = loop.map((p) => p.clone());
  const sides: ((p: THREE.Vector2) => number)[] = [
    (p) => p.x - x0,
    (p) => x1 - p.x,
    (p) => p.y - y0,
    (p) => y1 - p.y,
  ];
  for (const inside of sides) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length]!;
      const b = input[i]!;
      const da = inside(a);
      const db = inside(b);
      if (db >= 0) {
        if (da < 0) out.push(a.clone().lerp(b, da / (da - db)));
        out.push(b);
      } else if (da >= 0) {
        out.push(a.clone().lerp(b, da / (da - db)));
      }
    }
    if (out.length === 0) return out;
  }
  // Consecutive duplicates (a vertex exactly on a side) would be zero-length
  // edges to the triangulation.
  return out.filter((p, i) => p.distanceToSquared(out[(i + out.length - 1) % out.length]!) > 1e-14);
}

function distanceToLoop(p: THREE.Vector2, loop: readonly THREE.Vector2[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + ex * t), p.y - (a.y + ey * t)));
  }
  return best;
}
