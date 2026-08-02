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
  emissiveMapName,
  emissiveMapNames,
  surfaceKey,
  surfaceName,
  surfaceTile,
  tileMetres,
  wakeEmission,
  textureMaps,
  TEXTURE_ASSETS,
  TEXTURE_SETS,
} from "../render3d/assets";
import {
  DEFAULT_LIGHT_RANGE,
  LightRig,
} from "../render3d/lights";
import {
  scaleLevelData,
  isLightObject,
  type LevelData,
  isCollisionObject,
  isGeometryObject,
  normalizeLevelData,
  type GeometryObjectData,
  type LevelBodyData,
  type SceneObjectData,
  type RawLevelData,
} from "../level/levelFormat";
import { outlineDressings } from "../render3d/bodyVisuals";
import { DECOR_Z, depthOf } from "../level/decor";
import ballLevelJson from "../../levels/ball.json";
const BALL_LEVEL = ballLevelJson as unknown;
import { World } from "../engine/world";
import { buildLevelBodies, localPlacement, worldPlacement } from "../level/buildBodies";
import { modelFromDisk, modelToDisk, type EdItem } from "../editor/model";
import { lightPlaneReach } from "../editor/render";
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

// A level with every body's frame pushed onto its objects and the body left at
// the origin. It is what makes the round trips below comparable at all: a body's
// transform and its objects' placements are two halves of ONE answer, and the
// editor legitimately re-origins a body onto its first object when it saves. A
// byte comparison would read that as a lost field; this compares the thing that
// actually has to survive, which is where every object ends up.
//
// The numbers are rounded to a micrometre, because the flattening is trigonometry
// and a value that has been through px -> m -> px carries float noise in its last
// bits. A micrometre is four orders below the smallest thing any level authors.
function flattened(data: LevelData): string {
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return JSON.stringify(
    data.bodies.map((b) => ({
      kind: b.kind,
      color: b.color,
      opacity: b.opacity,
      friction: b.friction,
      force: b.force,
      // Keys sorted, because two builders that emit the same fields in a
      // different order have not lost anything - and they legitimately do: an
      // object's placement is written where it was authored on one side and
      // where the editor re-derived it on the other.
      objects: b.objects.map((o) => {
        const w = worldPlacement(b, o);
        const flat: Record<string, unknown> = {
          ...o,
          x: round(w.pos.x),
          y: round(w.pos.y),
          rot: round(w.rot),
        };
        return Object.fromEntries(Object.keys(flat).sort().map((k) => [k, flat[k]]));
      }),
    })),
  );
}

// The geometry object that DRESSES a body's own outlines - the one with no shape
// of its own. It is what the retired per-entry `visual` became, so the round-trip
// assertions below read it where they used to read that field.
function dressingOf(b: LevelBodyData): GeometryObjectData | undefined {
  return b.objects.find((o): o is GeometryObjectData => isGeometryObject(o) && o.shape === undefined);
}

// A body's own FORM - a geometry object carrying a shape, which is what
// decoration is.
function formOf(b: LevelBodyData): GeometryObjectData | undefined {
  return b.objects.find((o): o is GeometryObjectData => isGeometryObject(o) && o.shape !== undefined);
}

// Every length in a `visual` has to survive the px -> m -> px round trip, or the
// field is silently dropped or double-scaled on the next save. `scaleLevelData`
// rebuilds objects field by field, so a field it does not enumerate is simply
// gone - and the editor writes the file back every 750 ms, so the loss lands on
// disk before anyone notices it was ever read.
function visualRoundTrip(): CaseResult[] {
  const authored: RawLevelData = {
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
          emissive: "#ff8844",
          emissiveIntensity: 2.5,
          emissiveRange: 480,
          emissiveFlicker: 0.35,
          emissiveTexture: "furnace",
          emissiveDirX: 0.3,
          emissiveDirY: -1,
          emissiveDirZ: -0.2,
          emissiveAngle: 32,
          emissivePenumbra: 0.25,
          emissiveShadow: true,
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
  const a = flattened(scaleLevelData(authored, 1));
  const b = flattened(scaleLevelData(scaleLevelData(authored, PX), PIXELS_PER_METER));
  // A DIMENSIONLESS field cannot be checked by that round trip at all: scaling it
  // on the way in and back out again is the identity, so `tileScale * factor`
  // would be invisible here while silently making every authored tiling scale a
  // hundred times off in the game. It has to be asserted one way.
  const inMetres = scaleLevelData(authored, PX);
  const dimensionless =
    dressingOf(inMetres.bodies[0]!)!.tileScale === 2 &&
    dressingOf(inMetres.bodies[0]!)!.scale === 1.4 &&
    formOf(inMetres.bodies[2]!)!.tileScale === 0.5;
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
        : `tileScale ${dressingOf(inMetres.bodies[0]!)?.tileScale} / ${formOf(inMetres.bodies[2]!)?.tileScale}, scale ${dressingOf(inMetres.bodies[0]!)?.scale}`,
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
  const authored: RawLevelData = {
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
        visual: {
          depth: 90,
          texture: "brick",
          tileScale: 1.5,
          bevel: 3,
          emissive: "#ff8844",
          emissiveIntensity: 2.5,
        },
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
      // ...and a body with no visual at all, which must come back with the
      // geometry object that draws it and nothing more.
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
  // Both sides flattened, which fixes key order AND absorbs the body frame the
  // editor gives each body on the way out: what is being asserted is that every
  // value survives the trip and every object ends up where it started, not that
  // two builders chose the same origin to measure from.
  const a = flattened(scaleLevelData(authored, 1));
  const b = flattened(scaleLevelData(back, 1));
  // Nothing draws a collision shape but a geometry object, so a body authored
  // under the old default must come back carrying the one that states it - with
  // NO shape of its own, since copying the outline is the drift this avoided.
  const twinned = JSON.stringify(back.bodies[3]!.objects) ===
    JSON.stringify([
      { type: "collision", shape: { kind: "rect", w: 80, h: 80 } },
      { type: "geometry" },
    ]);
  return [
    {
      name: "editor: a level with visuals saves back byte-identical",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  saved    ${b}`,
    },
    {
      name: "editor: a body with no visual gains the geometry object that draws it",
      pass: twinned,
      detail: twinned
        ? "one collision object and one shapeless geometry object"
        : `wrote ${JSON.stringify(back.bodies[3]!.objects)}`,
    },
  ];
}

// How deep a shape is drawn, which is what orders two overlapping ones - on both
// canvases and under a click in the editor (see `pickOrder`). One rule, asserted
// here because a wrong answer is not an error anywhere: the level still draws,
// and a backdrop simply swallows clicks meant for the wall in front of it.
function depthOrdering(): CaseResult[] {
  const shape = { kind: "rect" as const, w: 100, h: 100 };
  const body = (objects: SceneObjectData[]): LevelBodyData => ({
    kind: "static",
    x: 0,
    y: 0,
    rot: 0,
    objects,
  });
  const solid = body([{ type: "collision", shape }]);
  const decoration = body([{ type: "geometry", shape }]);
  const solidAt = (z: number) =>
    body([{ type: "collision", shape }, { type: "geometry", z }]);
  const decorAt = (z: number) => body([{ type: "geometry", shape, z }]);
  const depth = (b: LevelBodyData) =>
    depthOf(b, b.objects.find((o) => o.type === "geometry") as GeometryObjectData | undefined);
  const checks: Array<[string, boolean, string]> = [
    ["solid geometry sits on the gameplay plane", depth(solid) === 0, `${depth(solid)} m`],
    [
      "a body with no collision falls back behind it rather than to zero",
      depth(decoration) === DECOR_Z,
      `${depth(decoration)} m`,
    ],
    [
      "an authored z wins for either",
      depth(decorAt(3)) === 3 && depth(solidAt(-20)) === -20,
      "authored depth used as given",
    ],
    [
      "nearest the viewport sorts last, which is what a click takes first",
      [solidAt(-20), decoration, solidAt(0.5)]
        .sort((a, b) => depth(a) - depth(b))
        .map(depth)
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

// The level's own lights. Two round trips and one thing neither can see.
//
// `intensity` is the trap and it is the reason this case exists at all. Every
// other number on a light is a length and converts between the file's pixels
// and the sim's metres; a point light's brightness is candela, which is an
// irradiance times a distance SQUARED, so a field converted with the rest would
// have to be converted as the square of the factor. It is defined against the
// sim's metres and passes through untouched instead - and a round trip cannot
// tell that apart from scaling it by the factor and back, exactly as it cannot
// for `tileScale`, so it is asserted one way.
function lightRoundTrip(): CaseResult[] {
  const authored: RawLevelData = {
    player: { x: 0, y: 0, radius: 20 },
    // Carries the fields the editor always writes back, so this case is about
    // the lights alone rather than about the body defaults (which
    // `editorRoundTrip` already covers).
    bodies: [
      {
        kind: "static",
        x: 0,
        y: 0,
        rot: 0,
        shape: { kind: "rect", w: 100, h: 100 },
        color: "#555555",
        opacity: 0.5,
        friction: 1,
      },
    ],
    lights: [
      // Every field an authored light has, so a dropped one shows up as the trip
      // not being byte-identical.
      {
        kind: "spot",
        x: 240,
        y: -180,
        z: 60,
        color: "#ffcc88",
        intensity: 22,
        range: 750,
        angle: 24,
        penumbra: 0.6,
        dirX: 0.2,
        // Deliberately NOT the default 1: the editor writes back only what
        // differs from a default, so a field authored at its default is
        // legitimately dropped and would make this case about that instead.
        dirY: 0.8,
        dirZ: -0.3,
        castShadow: true,
        flicker: 0.35,
      },
      // ...and one carrying nothing but a position, which must come back that
      // way rather than filled out with the defaults it was drawn at.
      { x: -400, y: 60 },
    ],
  };
  const a = JSON.stringify(scaleLevelData(authored, 1));
  const b = JSON.stringify(scaleLevelData(scaleLevelData(authored, PX), PIXELS_PER_METER));

  const inMetres = scaleLevelData(authored, PX);
  // The retired top-level light list migrates to a body containing nothing but
  // the light, which is what a light with no visible source is. The body carries
  // the placement and the object carries the rest.
  const litBody = inMetres.bodies.find((b) => b.objects.some(isLightObject))!;
  const lit = litBody.objects.find(isLightObject)!;
  // The lengths converted, the candela did not.
  const scaled = lit.range === 7.5 && lit.z === 0.6 && litBody.x === 2.4;
  const unscaled = lit.intensity === 22 && lit.angle === 24 && lit.penumbra === 0.6;

  // The environment block rides along, and this is the sharp half of the case.
  // The editor rewrites the whole file every 750 ms while a level is open, so a
  // block it does not carry is DELETED from disk the first time the level is
  // opened - and nothing about that is visible in the editor, since the scene is
  // rebuilt from the model and goes on looking however the model says. It showed
  // up as an authored `sunIntensity: 0` sewer being sunlit again on the next
  // game load, with no edit having been made.
  const withEnv: RawLevelData = {
    ...authored,
    environment: { sunIntensity: 0, envIntensity: 0.1, backgroundColor: "#080a0f" },
  };
  const envBack = modelToDisk(modelFromDisk(withEnv));
  const envKept = JSON.stringify(envBack.environment) === JSON.stringify(withEnv.environment);

  const back = modelToDisk(modelFromDisk(authored));
  const ea = flattened(scaleLevelData(authored, 1));
  const eb = flattened(scaleLevelData(back, 1));
  // A level with no lights must gain no `lights` key, or every level authored
  // before the field stops being byte-identical the first time it is opened.
  // A level with no lights must gain none, which now means no body carrying a
  // light object rather than an absent top-level key.
  const none = modelToDisk(modelFromDisk({ ...authored, lights: undefined })).bodies.every(
    (b) => !b.objects.some(isLightObject),
  );

  return [
    {
      name: "level format: lights round-trip px -> m -> px",
      pass: a === b,
      detail: a === b ? "byte-identical" : `\n  authored ${a}\n  round    ${b}`,
    },
    {
      name: "level format: a light's lengths scale and its intensity does not",
      pass: scaled && unscaled,
      detail:
        scaled && unscaled
          ? "range/z/x in metres, intensity in candela"
          : `range ${lit.range}, z ${lit.z}, x ${litBody.x}, intensity ${lit.intensity}, angle ${lit.angle}`,
    },
    {
      name: "editor: a level with lights saves back byte-identical",
      pass: ea === eb,
      detail: ea === eb ? "byte-identical" : `\n  authored ${ea}\n  saved    ${eb}`,
    },
    {
      name: "editor: a level with no lights gains none",
      pass: none,
      detail: none ? "no light object written" : "wrote a light nobody authored",
    },
    {
      name: "editor: a level's environment block survives a save",
      pass: envKept,
      detail: envKept ? "carried verbatim" : `became ${JSON.stringify(envBack.environment)}`,
    },
    ...planeReach(),
    {
      name: "editor: a level with no environment gains none",
      pass: back.environment === undefined,
      detail:
        back.environment === undefined
          ? "no `environment` key written"
          : `wrote ${JSON.stringify(back.environment)}`,
    },
  ];
}

// How far a light reaches ON the gameplay plane, which is what the editor draws
// its ring at. The authored `range` is a sphere's radius and the level is a
// plane through it, so the two agree only for a lamp sitting exactly on the
// plane - and a lamp further off than it reaches lights the level not at all.
//
// It is asserted because `z` is otherwise invisible: a light has no geometry, so
// nothing on the 2D canvas moves when it is authored, and the ring is the only
// feedback the field has.
function planeReach(): CaseResult[] {
  const lit = (range: number, z: number): EdItem => {
    const item = modelFromDisk({
      player: { x: 0, y: 0, radius: 20 },
      bodies: [{ kind: "static", x: 0, y: 0, rot: 0, shape: { kind: "rect", w: 10, h: 10 } }],
      lights: [{ x: 0, y: 0, range, z }],
    }).items.find((i) => i.object === "light")!;
    return item;
  };
  const near = lightPlaneReach(lit(500, 300)); // 5 m sphere, 3 m off: 3-4-5
  const on = lightPlaneReach(lit(500, 0));
  const past = lightPlaneReach(lit(500, 700));
  const exact = lightPlaneReach(lit(500, 500));
  const ok =
    Math.abs(near - 4) < 1e-9 &&
    Math.abs(on - 5) < 1e-9 &&
    past === 0 &&
    exact === 0;
  return [
    {
      name: "editor: a light's reach on the plane shrinks with z, and can reach nothing",
      pass: ok,
      detail: ok
        ? "5 m reach: 5 m on the plane at z 0, 4 m at z 3, none at z >= 5"
        : `on ${on}, near ${near}, exact ${exact}, past ${past}`,
    },
  ];
}

// WHAT KEEPS A LAMP AND ITS LIGHT TOGETHER, which is the whole reason a light is
// an object in a body rather than an entry in a list of its own.
//
// A lamp is two things - a fitting you can see and a light you cannot - and for a
// long time they were two authored objects at the same point that nothing kept in
// step, so moving the sconce left its light behind. The patch was to DERIVE a
// light from the fitting's emissive colour, out of seven fields describing a
// light in a second vocabulary. The guarantee is structural now: the light is
// INSIDE the body, so it rides that body's pose because there is nothing else it
// could do.
//
// Asserted on the scene graph, because nothing else can see it. A light in the
// wrong frame is a level that is simply lit somewhere else - it renders, every
// round trip passes, and no invariant has an opinion.
function lightRidesBody(): CaseResult[] {
  const rig = new LightRig();
  const body = new THREE.Group();
  // A body ten metres from the origin, as any real level has, and turned - which
  // is what a world-framed light gets wrong in two different ways at once.
  body.position.set(10, -4, 0);
  body.rotation.z = Math.PI / 2;
  const mounted = rig.add(body, { type: "light", kind: "spot", range: 5 }, { x: 0.3, y: 0, rot: 0, z: 0 });
  if (!mounted) {
    rig.dispose();
    return [{ name: "lights: a light rides the body it is in", pass: false, detail: "no light built" }];
  }
  body.updateWorldMatrix(true, true);
  const at = new THREE.Vector3();
  mounted.holder.getWorldPosition(at);
  // Placed 30 cm along the body's own +x, and the body is turned a quarter turn,
  // so in the world that 30 cm has become +y. A light left in world space would
  // still be 30 cm to the RIGHT of the body.
  const rode = Math.abs(at.x - 10) < 1e-9 && Math.abs(at.y - (-4 + 0.3)) < 1e-9;

  // ...and it keeps riding: move the body, and the light has moved with it
  // without anything having synced a transform, because it is a child.
  body.position.set(-2, 7, 0);
  body.updateWorldMatrix(true, true);
  mounted.holder.getWorldPosition(at);
  const followed = Math.abs(at.x - -2) < 1e-9 && Math.abs(at.y - 7.3) < 1e-9;
  rig.dispose();
  // Disposing hands the budget slot back; a rig that leaked one would light a
  // reloaded level less than the level it was reloaded from.
  const freed = rig.add(new THREE.Group(), { type: "light" }, { x: 0, y: 0, rot: 0, z: 0 }) !== null;

  return [
    {
      name: "lights: a light is placed in its body's frame, not the world's",
      pass: rode,
      detail: rode
        ? "30 cm along the body's +x lands where the body points"
        : `light at (${at.x.toFixed(3)}, ${at.y.toFixed(3)})`,
    },
    {
      name: "lights: it follows the body with no per-frame sync at all",
      pass: followed,
      detail: followed ? "moved with its parent" : `light at (${at.x.toFixed(3)}, ${at.y.toFixed(3)})`,
    },
    {
      name: "lights: a disposed rig hands its budget back",
      pass: freed,
      detail: freed ? "slot reusable" : "budget leaked",
    },
  ];
}

// Which way a spot throws, and the two conversions it goes through. Authored in
// the OBJECT's own frame, so turning the lamp turns the beam; and +y is DOWN in
// the sim and up in three, so an authored "down the level" has to come back
// negated. A sign error in either is a level that is simply dark, which nothing
// else reports.
function lightAim(): CaseResult[] {
  const rig = new LightRig();
  const scene = new THREE.Group();
  const aimed = (rot: number, dir: { dirX?: number; dirY?: number; dirZ?: number }) => {
    const holder = rig.add(scene, { type: "light", kind: "spot", range: 4, ...dir }, { x: 0, y: 0, rot, z: 0 });
    scene.updateWorldMatrix(true, true);
    const light = holder!.holder.children.find((c) => (c as THREE.SpotLight).isSpotLight) as THREE.SpotLight;
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    light.getWorldPosition(from);
    light.target.getWorldPosition(to);
    return to.sub(from).normalize();
  };
  // Absent, it points down the level - +y in sim terms - which is what a grate
  // overhead does. In three's frame that is -y.
  const def = aimed(0, {});
  const down = Math.abs(def.y + 1) < 1e-9 && Math.abs(def.x) < 1e-9;
  // The object's own rotation turns it. A quarter turn takes "down the level"
  // round to "along -x": rotation is clockwise-positive on screen because +y is
  // DOWN, so sim +y goes to sim -x, which is -x in three as well.
  const turned = aimed(Math.PI / 2, {});
  const rotated = Math.abs(turned.x + 1) < 1e-9 && Math.abs(turned.y) < 1e-9;
  // Authored lengths are arbitrary - it is a direction, so it arrives normalised.
  const long = aimed(0, { dirX: 30, dirY: 0, dirZ: -40 });
  const unit = Math.abs(long.length() - 1) < 1e-9 && Math.abs(long.x - 0.6) < 1e-9;
  // A direction of nothing would be a lamp aiming nowhere, which renders as a
  // lamp that does not work; it falls back rather than being refused.
  const zero = aimed(0, { dirX: 0, dirY: 0, dirZ: 0 });
  const fallback = Math.abs(zero.y + 1) < 1e-9;
  rig.dispose();
  return [
    {
      name: "lights: a spot with no aim points down the level, and a zero aim falls back",
      pass: down && fallback,
      detail: down && fallback ? "+y in the sim, -y in three" : `(${def.x.toFixed(2)}, ${def.y.toFixed(2)})`,
    },
    {
      name: "lights: its aim is in the object's own frame, so turning the lamp turns the beam",
      pass: rotated && unit,
      detail:
        rotated && unit
          ? "a quarter turn takes it to -x; arbitrary lengths normalise"
          : `turned (${turned.x.toFixed(2)}, ${turned.y.toFixed(2)}), unit ${long.length().toFixed(3)}`,
    },
  ];
}

// A body has an AUTHORED frame and an ENGINE frame, and they are deliberately
// not the same point: the engine's origin has to be the pieces' combined centre
// of mass (every lever arm in the engine is measured from it) and it moves as
// pieces are added, while the authored one has to stay put or every offset in a
// body would shift whenever a piece was added to it.
//
// `buildLevelBodies` absorbs the difference once, at load. Getting it wrong is
// silent in the way this whole layer's bugs are silent: the level builds, the
// physics is right, and the lamp is drawn somewhere else.
function bodyFrame(): CaseResult[] {
  const world = new World();
  const data = scaleLevelData(
    {
      player: { x: 0, y: 0, radius: 8 },
      bodies: [
        {
          kind: "static",
          x: 300,
          y: -100,
          rot: Math.PI / 2,
          objects: [
            // Two pieces either side of the body's origin, so the centre of mass
            // is the origin and a light at a local offset is demonstrably not.
            { type: "collision", x: -100, shape: { kind: "rect", w: 100, h: 100 } },
            { type: "collision", x: 100, shape: { kind: "rect", w: 100, h: 100 } },
            { type: "light", x: 0, y: 200, range: 400 },
          ],
        },
      ],
    },
    PX,
  );
  const built = buildLevelBodies(world, data, () => {});
  const b = built.bodies[0]!;
  const engine = b.body!;
  // Two equal pieces at ±1 m along the body's own +x, which a quarter turn sends
  // to ±1 m in y: their centre of mass is the authored origin.
  const com =
    Math.abs(engine.globalPosition.x - 3) < 1e-9 && Math.abs(engine.globalPosition.y - -1) < 1e-9;
  const twoPieces = engine.getShapes().length === 2;
  // The light is 2 m along the body's own +y, which the quarter turn sends to
  // -2 m in x. That is where `worldPlacement` says it is, and where
  // `localPlacement` has to put it relative to whatever the engine chose.
  const light = data.bodies[0]!.objects.find(isLightObject)!;
  const w = worldPlacement(data.bodies[0]!, light);
  const local = localPlacement(b, light);
  const resolved = engine.globalPosition.add(local.pos.rotated(engine.globalRotation));
  const agrees = Math.abs(w.pos.x - 1) < 1e-9 && Math.abs(w.pos.y - -1) < 1e-9;
  const round = resolved.distanceTo(w.pos) < 1e-9;
  return [
    {
      name: "bodies: the engine origin is the pieces' centre of mass, not the authored one",
      pass: com && twoPieces,
      detail:
        com && twoPieces
          ? "two pieces, origin at their centre of mass"
          : `origin (${engine.globalPosition.x.toFixed(3)}, ${engine.globalPosition.y.toFixed(3)}), ${engine.getShapes().length} piece(s)`,
    },
    {
      name: "bodies: an object placed in the body's frame lands where the body points",
      pass: agrees,
      detail: agrees
        ? "2 m along the body's +y, a quarter turn round"
        : `world (${w.pos.x.toFixed(3)}, ${w.pos.y.toFixed(3)})`,
    },
    {
      name: "bodies: resolving it through the engine frame gives the same point back",
      pass: round,
      detail: round ? "authored and engine frames agree" : `off by ${resolved.distanceTo(w.pos).toFixed(6)} m`,
    },
  ];
}

// An emission MAP is where a shape glows, as against how much: another set's
// map worn over whatever surface the shape has (`VisualData.emissiveTexture`).
// Two things about it are invisible everywhere else and are asserted here.
function emissiveMaps(): CaseResult[] {
  // It changes what the material IS - three.js reads the map from the material,
  // not from the mesh - so two shapes differing only in the map they wear may
  // not share one. Getting this wrong is silent: whichever was built first wins,
  // so either every wall glows or the lit one does not.
  const plain = surfaceKey({ material: "brick" });
  const lit = surfaceKey({ material: "brick", emissiveTexture: "brick" });
  // ...but only for a key that HAS an emission map. `brick` in this build does
  // not, so naming it must land on the plain material rather than on a second
  // one that renders identically - a cache split by a field that changes nothing
  // is a draw call per shape for no picture at all.
  const mapped = emissiveMapName("brick") !== "";
  const keyed = mapped ? plain !== lit : plain === lit;
  // An unknown key is nothing rather than a fallback surface's map, which is the
  // one place the texture resolution rules deliberately differ: `texture` falls
  // back so an unknown name is an ordinary wall, and this does not, because a
  // borrowed glow the author never asked for is not ordinary.
  const unknown = emissiveMapName("no such set") === "" && emissiveMapName(undefined) === "";
  const listed = emissiveMapNames().every((k) => emissiveMapName(k) === k);
  return [
    {
      name: "surfaces: an emission map is part of the material key exactly when it exists",
      pass: keyed,
      detail: keyed
        ? mapped
          ? "keyed apart"
          : "no emission map in this manifest, so no split"
        : `${plain} vs ${lit}`,
    },
    {
      name: "surfaces: an unknown emission map is no map at all",
      pass: unknown && listed,
      detail: unknown && listed ? `${emissiveMapNames().length} set(s) carry one` : "resolved to something",
    },
  ];
}


// Emission changes what a material IS, so it has to change the material CACHE
// KEY. Getting it wrong is invisible in every other check: the level renders,
// every round trip passes, and what happens is that whichever of the two was
// built first wins - so either every wall of that stone glows, or the lamp made
// of it does not.
function emissiveMaterials(): CaseResult[] {
  const plain = surfaceKey({ material: "stone" });
  const glowing = surfaceKey({ material: "stone", emissive: "#ff8844", emissiveIntensity: 3 });
  const dimmer = surfaceKey({ material: "stone", emissive: "#ff8844", emissiveIntensity: 1 });
  const again = surfaceKey({ material: "stone", emissive: "#ff8844", emissiveIntensity: 3 });
  const distinct = plain !== glowing && glowing !== dimmer;
  const stable = glowing === again;
  // A brightness multiplier on a shape that emits nothing multiplies black, so
  // it may NOT split the cache: every ordinary wall would otherwise get its own
  // material the moment the editor started writing a default alongside.
  const notSplit = plain === surfaceKey({ material: "stone", emissiveIntensity: 4 });
  return [
    {
      name: "surfaces: emission is part of the material key",
      pass: distinct && stable,
      detail:
        distinct && stable
          ? "one material per (surface, tint, emission)"
          : `distinct ${distinct}, cached ${stable}`,
    },
    {
      name: "surfaces: a glow multiplier with no glow colour does not split the cache",
      pass: notSplit,
      detail: notSplit ? "same key" : `${plain} vs ${surfaceKey({ material: "stone", emissiveIntensity: 4 })}`,
    },
  ];
}

// A prop that ships an emission MAP but no emissive FACTOR emits nothing, since
// glTF's default factor is black and three.js multiplies the two. `wakeEmission`
// lifts exactly that case to white on load. Asserted because the failure is
// silent in both directions: unrepaired, a lamp is simply dark and looks like a
// texture that failed to load; over-eager, it makes surfaces glow that never
// asked to.
function propEmission(): CaseResult[] {
  const withMap = (emissive: number) => {
    const m = new THREE.MeshStandardMaterial();
    m.emissiveMap = new THREE.Texture();
    m.emissive.setHex(emissive);
    wakeEmission(m);
    return m.emissive.getHex();
  };
  const bare = new THREE.MeshStandardMaterial();
  bare.emissive.setHex(0x000000);
  wakeEmission(bare);
  const woken = withMap(0x000000) === 0xffffff;
  const kept = withMap(0xff8844) === 0xff8844;
  const untouched = bare.emissive.getHex() === 0x000000;
  return [
    {
      name: "props: an emission map with no emissive factor is woken to white",
      pass: woken && kept,
      detail:
        woken && kept
          ? "black + map -> white, authored colour left alone"
          : `black -> ${withMap(0x000000).toString(16)}, authored -> ${withMap(0xff8844).toString(16)}`,
    },
    {
      name: "props: a material with no emission map is left dark",
      pass: untouched,
      detail: untouched ? "no map, no glow" : "lit a material that ships no emission",
    },
  ];
}

// THE REAL LEVEL, through the editor's save path. Every case above is a fixture
// small enough to reason about, and a fixture is exactly what a silent drop
// hides from: the loss is in the shape the fixture does not have.
//
// It earns its place because the editor rewrites the whole file every 750 ms
// while a level is open, so anything its round trip does not carry is gone from
// disk before anyone notices it was read - and the failure is invisible in the
// editor itself, which goes on drawing the model it holds. It is asserted on
// COUNTS rather than bytes because the editor legitimately re-origins bodies and
// folds a dressing onto the object it dresses; what may never change is how much
// of the level there is.
//
// The level arrives through the registry's own import rather than off disk, so
// this case keeps `cli render3d` pure - no filesystem, no canvas, no GPU.
function realLevelRoundTrip(): CaseResult[] {
  const tally = (d: LevelData) => ({
    bodies: d.bodies.length,
    objects: d.bodies.reduce((n, b) => n + b.objects.length, 0),
    collision: d.bodies.reduce((n, b) => n + b.objects.filter(isCollisionObject).length, 0),
    geometry: d.bodies.reduce((n, b) => n + b.objects.filter(isGeometryObject).length, 0),
    lights: d.bodies.reduce((n, b) => n + b.objects.filter(isLightObject).length, 0),
    chains: d.chains?.length ?? 0,
  });
  const before = tally(normalizeLevelData(BALL_LEVEL as RawLevelData));
  const after = tally(modelToDisk(modelFromDisk(BALL_LEVEL as RawLevelData)));
  const same = JSON.stringify(before) === JSON.stringify(after);
  return [
    {
      name: "editor: the authored ball level survives a save with nothing dropped",
      pass: same,
      detail: same
        ? `${before.bodies} bodies, ${before.objects} objects (${before.collision} collision, ${before.geometry} geometry, ${before.lights} lights), ${before.chains} chains`
        : `\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`,
    },
  ];
}

// NOTHING BUT A GEOMETRY OBJECT DRAWS. A collision shape used to draw itself
// whenever no one said otherwise, and this is the case that keeps that from
// creeping back: the old default was invisible by construction (a level that
// relied on it looked right, so nothing reported it), and the same is true of a
// regression - a stray extrusion beside an authored mesh reads as a level that
// needs its geometry nudged rather than as a renderer drawing twice.
//
// The migration half matters just as much. Every level on disk was authored
// under the old default, so `withGeometryTwin` is the only thing standing
// between the split and a hundred and twenty-eight invisible bodies.
function renderNeedsGeometry(): CaseResult[] {
  // Built as `LevelData` rather than through `normalizeLevelData`, deliberately:
  // the gate would hand this body the geometry object it is asserting the
  // absence of.
  const level = (objects: SceneObjectData[]): LevelData => ({
    player: { x: 0, y: 0, radius: 8 * PX },
    bodies: [{ kind: "static", x: 0, y: 0, rot: 0, objects }],
  });
  const shape = { kind: "rect" as const, w: 1, h: 1 };
  const drawnBy = (objects: SceneObjectData[]) => outlineDressings(level(objects).bodies[0]!);

  const bare = drawnBy([{ type: "collision", shape }]);
  const dressed = drawnBy([{ type: "collision", shape }, { type: "geometry" }]);
  // One dressing over a compound body covers every piece of it, which is a whole
  // wall wearing one surface rather than the first brick of it being drawn.
  const compound = drawnBy([
    { type: "collision", shape },
    { type: "collision", x: 2, shape },
    { type: "geometry", texture: "brick" },
  ]);

  // ...and the migration that keeps every authored level looking as it did.
  const raw: RawLevelData = level([{ type: "collision", shape }]);
  const once = normalizeLevelData(raw);
  const twice = normalizeLevelData(once);
  const twin = once.bodies[0]!.objects.filter(isGeometryObject);
  const migrated = twin.length === 1 && twin[0]!.shape === undefined;
  const stable = twice.bodies[0]!.objects.length === once.bodies[0]!.objects.length;
  // A body that already says how it looks is left alone. Twinning it too puts an
  // extrusion of the collision box inside the authored prop - a grey brick in the
  // middle of a lamp, drawn in play and absent from the editor.
  const authored = level([
    { type: "collision", shape },
    { type: "geometry", kind: "mesh", mesh: "bulkhead-lamp", shape },
  ]);
  const untouched =
    normalizeLevelData(authored).bodies[0]!.objects.length === authored.bodies[0]!.objects.length;

  return [
    {
      name: "render: a collision shape with no geometry object draws nothing",
      pass: bare.length === 1 && bare[0] === undefined,
      detail: bare[0] === undefined ? "not drawn" : "drawn by something",
    },
    {
      name: "render: a shapeless geometry object draws the body's collision outlines",
      pass: dressed.length === 1 && dressed[0] !== undefined,
      detail: dressed[0] !== undefined ? "drawn by the geometry object" : "not drawn",
    },
    {
      name: "render: one dressing covers every piece of a compound body",
      pass: compound.length === 2 && compound.every((d) => d?.texture === "brick"),
      detail: `${compound.filter(Boolean).length} of ${compound.length} pieces drawn`,
    },
    {
      name: "render: a level authored under the old default gains the object that draws it",
      pass: migrated,
      detail: migrated
        ? "one geometry object, no shape of its own"
        : `wrote ${JSON.stringify(twin)}`,
    },
    {
      name: "render: and gains it exactly once, however many times it is loaded",
      pass: stable,
      detail: stable
        ? `${once.bodies[0]!.objects.length} objects, unchanged on a second pass`
        : `${once.bodies[0]!.objects.length} then ${twice.bodies[0]!.objects.length}`,
    },
    {
      name: "render: a body that already says how it looks is left alone",
      pass: untouched,
      detail: untouched
        ? "authored geometry stands; no extrusion added beside it"
        : "an extrusion was added inside the authored prop",
    },
  ];
}

export function runRender3dCases(): CaseResult[] {
  return [
    ...renderNeedsGeometry(),
    ...cameraCorrespondence(),
    ...blendStability(),
    ...extrusionGeometry(),
    ...depthOrdering(),
    ...surfaceResolution(),
    ...visualRoundTrip(),
    ...editorRoundTrip(),
    ...lightRoundTrip(),
    ...lightRidesBody(),
    ...lightAim(),
    ...bodyFrame(),
    ...emissiveMaps(),
    ...propEmission(),
    ...emissiveMaterials(),
    ...realLevelRoundTrip(),
  ];
}
