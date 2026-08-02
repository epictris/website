// 3D rendering cases: the claims the whole `render3d/` scene stands on, checked
// directly rather than through a picture.
//
// The load-bearing one is the CAMERA CORRESPONDENCE. The 3D scene and the 2D
// overlay are two canvases stacked on one frame, and everything that makes the
// overlay useful - a collision outline landing on the geometry it describes, the
// aim reticle sitting where the player is aiming, the editor's handles gripping
// the shape under them - is the two agreeing about where a world point lands in
// view pixels. Agreement by eye at one zoom is not agreement: the perspective
// camera derives its distance from `camera.zoom`, so a wrong constant is a
// misalignment that grows with how far the point is from the centre of the frame
// and closes again as the view zooms, which is exactly the shape of a bug that
// reads as "it looks fine" in a screenshot.
//
// The rest are geometry: an extruded outline has to come out facing the camera
// and the right way up, and the winding it takes is a y-negation away from the
// physics one (see extrude.ts), which is a sign error nothing downstream would
// report as anything but a dark, inside-out prop.

import * as THREE from "three";
import { Vec2 } from "../engine/vec2";
import { VIEW_HEIGHT, VIEW_WIDTH } from "../render/viewport";
import type { Camera } from "../render/camera";
import { FOV_Y_DEG, projectToView, syncCamera } from "../render3d/space";
import { extrudeOutline } from "../render3d/extrude";
import { scaleLevelData, type LevelData } from "../level/levelFormat";
import { modelFromDisk, modelToDisk } from "../editor/model";
import { PIXELS_PER_METER, PX } from "../engine/units";

export interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function camera(x: number, y: number, zoom: number): Camera {
  return {
    position: new Vec2(x, y),
    zoom,
    viewportWidth: VIEW_WIDTH,
    viewportHeight: VIEW_HEIGHT,
  };
}

// Where three.js actually puts a gameplay-plane point on screen, in view pixels:
// the projection the GPU will do, run on the CPU. Nothing here is a
// reimplementation of the correspondence - it is the camera `syncCamera` built,
// asked where a point lands.
function projectThroughThree(cam: Camera, world: Vec2): { x: number; y: number } {
  const threeCam = new THREE.PerspectiveCamera(FOV_Y_DEG, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 1000);
  syncCamera(threeCam, cam);
  threeCam.updateMatrixWorld(true);
  const ndc = new THREE.Vector3(world.x, -world.y, 0).project(threeCam);
  return {
    x: ((ndc.x + 1) / 2) * VIEW_WIDTH,
    y: ((1 - ndc.y) / 2) * VIEW_HEIGHT,
  };
}

// Sub-hundredth of a view pixel. The two projections are the same arithmetic
// reached two ways (a scale, and a perspective divide at a distance chosen to
// produce it), so what is left is float noise on a 1920-wide frame.
const PIXEL_TOL = 0.01;

// Geometry attributes are float32, so a "these are the same number" test on one
// is held to float32 precision at the magnitudes a level uses, not float64.
const F32 = 1e-6;

function cameraCorrespondence(): CaseResult[] {
  const out: CaseResult[] = [];
  // Camera placements across the range a level actually uses: the ball level's
  // base zoom, a region zoomed out to twice the world (viewportScale 2), one
  // zoomed in, and an off-origin camera mid-blend at a zoom between two regions.
  const cams: Array<{ name: string; cam: Camera }> = [
    { name: "origin @ base zoom", cam: camera(0, 0, 2) },
    { name: "off-centre @ base zoom", cam: camera(13.5, -7.25, 2) },
    { name: "zoomed out (viewportScale 2)", cam: camera(-4, 11, 1) },
    { name: "zoomed in (viewportScale 0.5)", cam: camera(2.5, 3.5, 4) },
    { name: "mid-blend zoom", cam: camera(-31.4, 6.28, 1.7307) },
  ];
  // Points spread to the frame's corners, where a wrong camera distance shows up
  // first: the centre agrees under almost any lens.
  const probes = (cam: Camera): Vec2[] => {
    const halfH = VIEW_HEIGHT / 2 / (cam.zoom * PIXELS_PER_METER);
    const halfW = VIEW_WIDTH / 2 / (cam.zoom * PIXELS_PER_METER);
    return [
      cam.position,
      cam.position.add(new Vec2(halfW, halfH)),
      cam.position.add(new Vec2(-halfW, halfH)),
      cam.position.add(new Vec2(halfW, -halfH)),
      cam.position.add(new Vec2(-halfW, -halfH)),
      cam.position.add(new Vec2(halfW * 0.37, -halfH * 0.81)),
    ];
  };
  for (const { name, cam } of cams) {
    let worst = 0;
    let at = Vec2.ZERO;
    for (const p of probes(cam)) {
      const a = projectToView(cam, p);
      const b = projectThroughThree(cam, p);
      const err = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      if (err > worst) {
        worst = err;
        at = p;
      }
    }
    out.push({
      name: `camera correspondence: ${name}`,
      pass: worst <= PIXEL_TOL,
      detail: `worst ${worst.toExponential(2)} px at (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`,
    });
  }
  return out;
}

// A body drawn at the centre of the frame must not move when the CAMERA moves
// and the body moves with it: the correspondence has to be a translation, not a
// translation plus a perspective wobble. This is the region-blend case - the
// camera easing across the level while the avatar sits still relative to it -
// which is the one the acceptance criterion calls out.
function blendStability(): CaseResult[] {
  const offsets = [0, 0.37, 1.6, 4.2, 11.9];
  let worst = 0;
  for (const d of offsets) {
    const cam = camera(d, -d * 0.6, 2);
    const p = cam.position.add(new Vec2(3.2, -1.7));
    const a = projectToView(cam, p);
    const b = projectThroughThree(cam, p);
    worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  return [
    {
      name: "camera correspondence: stable through a pan",
      pass: worst <= PIXEL_TOL,
      detail: `worst ${worst.toExponential(2)} px over ${offsets.length} camera positions`,
    },
  ];
}

// The extrusion's winding and depth. A physics polygon is wound clockwise ON
// SCREEN with y down (see engine/shapes.ts); after the y-negation that is
// counter-clockwise in three's frame, which is the winding `ExtrudeGeometry`
// needs for its front faces to point at +z. Get it wrong and the prop renders
// unlit and inside out - visible, but only as "the materials look broken".
function extrusionGeometry(): CaseResult[] {
  const out: CaseResult[] = [];
  const half = new Vec2(1, 0.5);
  const geo = extrudeOutline({ kind: "rect", half }, { depth: 0.4, bevel: 0 });
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  // Centred on the gameplay plane and the authored size, with y negated (a rect
  // is symmetric, so this is about the extent rather than the sign) and the
  // depth split either side of z = 0. Geometry attributes are float32, so the
  // tolerance is float32 epsilon at this magnitude rather than float64's.
  const sizeOk =
    Math.abs(bb.min.x + 1) < F32 &&
    Math.abs(bb.max.x - 1) < F32 &&
    Math.abs(bb.min.y + 0.5) < F32 &&
    Math.abs(bb.max.y - 0.5) < F32 &&
    Math.abs(bb.min.z + 0.2) < F32 &&
    Math.abs(bb.max.z - 0.2) < F32;
  out.push({
    name: "extrude: rect is authored size, centred on the plane",
    pass: sizeOk,
    detail: `bbox (${bb.min.x},${bb.min.y},${bb.min.z}) .. (${bb.max.x},${bb.max.y},${bb.max.z})`,
  });

  // The front cap must face the camera. Its normals are the first thing a wrong
  // winding flips, and a flipped cap is the whole prop in shadow.
  const normals = geo.getAttribute("normal");
  let frontFacing = 0;
  let backFacing = 0;
  const pos = geo.getAttribute("position");
  for (let i = 0; i < normals.count; i++) {
    if (Math.abs(pos.getZ(i) - 0.2) > F32) continue; // front cap only
    if (normals.getZ(i) > 0.9) frontFacing++;
    if (normals.getZ(i) < -0.9) backFacing++;
  }
  out.push({
    name: "extrude: front cap faces +z (toward the camera)",
    pass: frontFacing > 0 && backFacing === 0,
    detail: `${frontFacing} front-facing, ${backFacing} back-facing cap vertices`,
  });

  // A polygon authored in the physics winding must come out the same way up as
  // the rect does: the y-negation is applied to the vertices, so the loop's
  // signed area flips and the outline has to be re-wound for three.
  const tri = extrudeOutline(
    {
      kind: "poly",
      verts: [new Vec2(-1, 1), new Vec2(1, 1), new Vec2(0, -1)],
    },
    { depth: 0.2, bevel: 0 },
  );
  tri.computeBoundingBox();
  const tb = tri.boundingBox!;
  // The apex is at physics y = -1, which is three y = +1: a prop that came out
  // upside down would put it at -1.
  out.push({
    name: "extrude: poly keeps its orientation through the y-negation",
    pass: Math.abs(tb.max.y - 1) < F32 && Math.abs(tb.min.y + 1) < F32,
    detail: `y extent ${tb.min.y} .. ${tb.max.y}`,
  });

  const triNormals = tri.getAttribute("normal");
  const triPos = tri.getAttribute("position");
  let triFront = 0;
  let triBack = 0;
  for (let i = 0; i < triNormals.count; i++) {
    if (Math.abs(triPos.getZ(i) - 0.1) > F32) continue;
    if (triNormals.getZ(i) > 0.9) triFront++;
    if (triNormals.getZ(i) < -0.9) triBack++;
  }
  out.push({
    name: "extrude: poly front cap faces +z",
    pass: triFront > 0 && triBack === 0,
    detail: `${triFront} front-facing, ${triBack} back-facing cap vertices`,
  });

  // A circle extrudes to a disc of the authored radius, not to its bounding box.
  const disc = extrudeOutline({ kind: "circle", radius: 0.35 }, { depth: 0.1, bevel: 0 });
  disc.computeBoundingBox();
  const db = disc.boundingBox!;
  const r = Math.max(db.max.x, db.max.y);
  out.push({
    name: "extrude: circle radius survives",
    pass: Math.abs(r - 0.35) < 2e-3,
    detail: `radius ${r.toFixed(5)} (curve-sampled, so a hair under 0.35)`,
  });
  return out;
}

// Every length in a `visual` has to survive the px -> m -> px round trip, or the
// field is silently dropped or double-scaled on the next save. `scaleLevelData`
// rebuilds objects field by field, so a field it does not enumerate is simply
// gone - and the editor writes the file back every 750 ms, so the loss lands on
// disk before anyone notices it was ever read.
function visualRoundTrip(): CaseResult[] {
  const authored: LevelData = {
    player: { x: 0, y: 0, radius: 20 },
    bodies: [
      {
        kind: "static",
        x: 100,
        y: -250,
        rot: 0.3,
        shape: { kind: "rect", w: 400, h: 60 },
        visual: {
          kind: "mesh",
          mesh: "rock-a",
          offsetX: 12,
          offsetY: -8,
          offsetZ: 35,
          rotX: 0.2,
          rotY: -1.1,
          rotZ: 0.75,
          scale: 1.4,
          depth: 90,
          texture: "stone",
          bevel: 3,
        },
      },
      { kind: "rigid", x: 0, y: 0, rot: 0, shape: { kind: "circle", r: 25 }, visual: { kind: "none" } },
    ],
    backgrounds: [
      {
        x: -400,
        y: 120,
        rot: 0,
        shape: { kind: "rect", w: 900, h: 600 },
        visual: { offsetZ: -600, depth: 20 },
      },
    ],
  };
  // Compared against the SAME builder run at factor 1 rather than against the
  // authored literal: `scaleLevelData` rebuilds objects field by field, so it
  // also fixes their key order, and a key-order difference is not a lost field.
  // What is being asserted is that every value survives the trip.
  const a = JSON.stringify(scaleLevelData(authored, 1));
  const b = JSON.stringify(scaleLevelData(scaleLevelData(authored, PX), PIXELS_PER_METER));
  return [
    {
      name: "level format: visual round-trips px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
  ];
}

// The editor is the other round trip, and the one that actually runs: it
// rewrites the whole file every 750 ms while a level is open, so a field it
// drops is a field that is gone from disk before anyone notices it was read.
// `modelFromDisk`/`modelToDisk` go through `EdItem`, which is a different shape
// from `LevelBodyData` entirely - the visual becomes a live object the inspector
// mutates - so the format round trip above says nothing about this one.
function editorRoundTrip(): CaseResult[] {
  const authored: LevelData = {
    player: { x: 0, y: 0, radius: 20 },
    bodies: [
      // A mesh visual with every placement field set...
      {
        kind: "static",
        x: 100,
        y: -250,
        rot: 0.3,
        shape: { kind: "rect", w: 400, h: 60 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        visual: {
          kind: "mesh",
          mesh: "rock-a",
          offsetX: 12,
          offsetY: -8,
          offsetZ: 35,
          rotX: 0.2,
          rotY: -1.1,
          rotZ: 0.75,
          scale: 1.4,
        },
      },
      // ...an extrusion override...
      {
        kind: "rigid",
        x: 0,
        y: 0,
        rot: 0,
        shape: { kind: "circle", r: 25 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        material: "stone",
        visual: { depth: 90, texture: "brick", bevel: 3 },
      },
      // ...an invisible wall...
      {
        kind: "static",
        x: -300,
        y: 40,
        rot: 0,
        shape: { kind: "rect", w: 100, h: 100 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
        visual: { kind: "none" },
      },
      // ...and a body with no visual at all, which must come back with none.
      {
        kind: "static",
        x: 500,
        y: 0,
        rot: 0,
        shape: { kind: "rect", w: 80, h: 80 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
      },
    ],
    backgrounds: [
      {
        x: -400,
        y: 120,
        rot: 0,
        shape: { kind: "rect", w: 900, h: 600 },
        color: "#313244",
        opacity: 1,
        visual: { offsetZ: -600 },
      },
    ],
  };
  const back = modelToDisk(modelFromDisk(authored));
  // Both sides through `scaleLevelData` at factor 1, which rebuilds objects
  // field by field and so fixes their key order: what is being asserted is that
  // every value survives the trip, not that two builders emit keys in the same
  // sequence.
  const a = JSON.stringify(scaleLevelData(authored, 1));
  const b = JSON.stringify(scaleLevelData(back, 1));
  const untouched = back.bodies[3]!.visual === undefined;
  return [
    {
      name: "editor: a level with visuals saves back byte-identical",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  saved    ${b}`,
    },
    {
      name: "editor: a body with no visual gains none",
      pass: untouched,
      detail: untouched
        ? "no `visual` key written"
        : `wrote ${JSON.stringify(back.bodies[3]!.visual)}`,
    },
  ];
}

export function runRender3dCases(): CaseResult[] {
  return [
    ...cameraCorrespondence(),
    ...blendStability(),
    ...extrusionGeometry(),
    ...visualRoundTrip(),
    ...editorRoundTrip(),
  ];
}
