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
import {
  DEFAULT_TEXTURE,
  surfaceName,
  surfaceTile,
  tileMetres,
  textureMaps,
  TEXTURE_ASSETS,
  TEXTURE_SETS,
} from "../render3d/assets";
import { scaleLevelData, type LevelData } from "../level/levelFormat";
import { DECOR_Z, depthOf } from "../level/decor";
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
          tileScale: 2,
          tileOffsetX: 25,
          tileOffsetY: -40,
          bevel: 3,
        },
      },
      { kind: "rigid", x: 0, y: 0, rot: 0, shape: { kind: "circle", r: 25 }, visual: { kind: "none" } },
      // Decoration, in the form it is authored in now...
      {
        kind: "static",
        collision: false,
        x: -400,
        y: 120,
        rot: 0,
        shape: { kind: "rect", w: 900, h: 600 },
        visual: { offsetZ: -600, depth: 20, texture: "quarry-stone", tileScale: 0.5 },
      },
    ],
    // ...and in the retired one, which `normalizeLevelData` folds into the list
    // above. Both round trips run through that gate, so a migration that lost a
    // field would show up here as the trip not being byte-identical.
    backgrounds: [
      {
        x: 900,
        y: 120,
        rot: 0.2,
        shape: { kind: "rect", w: 400, h: 300 },
        group: "g7",
        visual: { offsetZ: -300 },
      },
    ],
  };
  // Compared against the SAME builder run at factor 1 rather than against the
  // authored literal: `scaleLevelData` rebuilds objects field by field, so it
  // also fixes their key order, and a key-order difference is not a lost field.
  // What is being asserted is that every value survives the trip.
  const a = JSON.stringify(scaleLevelData(authored, 1));
  const b = JSON.stringify(scaleLevelData(scaleLevelData(authored, PX), PIXELS_PER_METER));
  // A DIMENSIONLESS field cannot be checked by that round trip at all: scaling it
  // on the way in and back out again is the identity, so `tileScale * factor`
  // would be invisible here while silently making every authored tiling scale a
  // hundred times off in the game. It has to be asserted one way.
  const inMetres = scaleLevelData(authored, PX);
  const dimensionless =
    inMetres.bodies[0]!.visual!.tileScale === 2 &&
    inMetres.bodies[0]!.visual!.scale === 1.4 &&
    inMetres.bodies[2]!.visual!.tileScale === 0.5;
  return [
    {
      name: "level format: visual round-trips px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
    {
      name: "level format: `scale` and `tileScale` are not scaled by the px -> m conversion",
      pass: dimensionless,
      detail: dimensionless
        ? "unchanged in metres"
        : `tileScale ${inMetres.bodies[0]!.visual!.tileScale} / ${inMetres.bodies[2]!.visual!.tileScale}, scale ${inMetres.bodies[0]!.visual!.scale}`,
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
        visual: { depth: 90, texture: "brick", tileScale: 1.5, bevel: 3 },
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

// How deep a shape is drawn, which is what orders two overlapping ones - on both
// canvases and under a click in the editor (see `pickOrder`). One rule, asserted
// here because a wrong answer is not an error anywhere: the level still draws,
// and a backdrop simply swallows clicks meant for the wall in front of it.
function depthOrdering(): CaseResult[] {
  const shape = { kind: "rect" as const, w: 100, h: 100 };
  const solid = { kind: "static" as const, x: 0, y: 0, rot: 0, shape };
  const decoration = { ...solid, collision: false };
  const checks: Array<[string, boolean, string]> = [
    ["solid geometry sits on the gameplay plane", depthOf(solid) === 0, `${depthOf(solid)} m`],
    [
      "decoration falls back behind it rather than to zero",
      depthOf(decoration) === DECOR_Z,
      `${depthOf(decoration)} m`,
    ],
    [
      "an authored offsetZ wins for either",
      depthOf({ ...decoration, visual: { offsetZ: 3 } }) === 3 &&
        depthOf({ ...solid, visual: { offsetZ: -20 } }) === -20,
      "authored depth used as given",
    ],
    [
      "nearest the viewport sorts last, which is what a click takes first",
      [
        { ...solid, visual: { offsetZ: -20 } },
        { ...decoration },
        { ...solid, visual: { offsetZ: 0.5 } },
      ]
        .sort((a, b) => depthOf(a) - depthOf(b))
        .map((b) => depthOf(b))
        .join(",") === `-20,${DECOR_Z},0.5`,
      "back to front",
    ],
  ];
  return checks.map(([name, pass, detail]) => ({ name: `depth: ${name}`, pass, detail }));
}

// Which surface a name resolves to, and at what tiling scale. Pure arithmetic
// over the two manifests, which is why it can live in this suite at all - there
// is no canvas here and no GPU, so the materials themselves cannot be built.
//
// What it is guarding is the ONE namespace. A level names a surface; whether
// that surface is a downloaded set of maps or a few hundred bytes of generated
// noise is `assets.ts`'s answer, and the point of the arrangement is that
// dressing a level in authored textures is adding manifest entries rather than
// re-authoring every body that named the material. Get the precedence backwards
// and every level goes on wearing noise while the downloaded maps sit unused -
// which looks like nothing at all, since the generated surfaces are perfectly
// presentable.
function surfaceResolution(): CaseResult[] {
  const key = "test-quarry-stone";
  // The manifest is a plain record and this is the only way to exercise a
  // resolution rule with an empty one. Removed again below, so no other case
  // (and no build) can see it.
  TEXTURE_ASSETS[key] = {
    maps: { base: { file: "/textures/x-base.webp", sha256: "0" } },
    tile: 2.5,
    source: "test",
    author: "test",
    license: "test",
  };
  try {
    const checks: Array<[string, boolean, string]> = [
      [
        "an authored set resolves to itself",
        surfaceName(key) === key,
        surfaceName(key),
      ],
      [
        "a material name still resolves to its generated surface",
        surfaceName("stone") === "stone",
        surfaceName("stone"),
      ],
      [
        "an unknown name falls back rather than vanishing",
        surfaceName("no-such-surface") === DEFAULT_TEXTURE,
        surfaceName("no-such-surface"),
      ],
      [
        "an authored set's tile is its own",
        surfaceTile(key) === 2.5,
        `${surfaceTile(key)} m`,
      ],
      [
        "a generated set's tile is the table's",
        surfaceTile("stone") === TEXTURE_SETS.stone.tile,
        `${surfaceTile("stone")} m`,
      ],
      [
        "life size is the texture's own size, whatever the texture",
        tileMetres(key) === 2.5 && tileMetres("stone") === TEXTURE_SETS.stone.tile,
        `${tileMetres(key)} m / ${tileMetres("stone")} m`,
      ],
      [
        "a tile scale multiplies that rather than replacing it",
        tileMetres(key, 2) === 5 && tileMetres(key, 0.5) === 1.25 && tileMetres(key, null) === 2.5,
        `x2 -> ${tileMetres(key, 2)} m, x0.5 -> ${tileMetres(key, 0.5)} m`,
      ],
      [
        "only the map slots a set actually carries are enumerated",
        textureMaps(TEXTURE_ASSETS[key]!).length === 1,
        `${textureMaps(TEXTURE_ASSETS[key]!).length} map(s)`,
      ],
    ];
    return checks.map(([name, pass, detail]) => ({
      name: `surfaces: ${name}`,
      pass,
      detail,
    }));
  } finally {
    delete TEXTURE_ASSETS[key];
  }
}

export function runRender3dCases(): CaseResult[] {
  return [
    ...cameraCorrespondence(),
    ...blendStability(),
    ...extrusionGeometry(),
    ...depthOrdering(),
    ...surfaceResolution(),
    ...visualRoundTrip(),
    ...editorRoundTrip(),
  ];
}
