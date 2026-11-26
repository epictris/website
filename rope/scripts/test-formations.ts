// Formations held to their contracts (docs/formations.md).
//
//   bun run scripts/test-formations.ts [--no-blender]
//
// - the recipe hash is SHA-256 (against node:crypto) and survives a level's
//   trip to disk in pixels and back, and through the editor's model;
// - a formation crosses `scaleLevelData` and the editor's load and save with
//   every field (placement, guide, piece fields, build record, tier);
// - "Align collision to guide" puts back exactly the pieces the guide took,
//   every field of each, and the match check sees an edit;
// - the fit fills a section's holes, drops its crumbs, stays within the
//   accuracy, and splits between unlike pieces by nearness;
// - COORDINATES: a rock generated from an asymmetric outline (an L, its foot
//   to the right and at the bottom in the level) lands where the outline is,
//   the right way up, in the level's frame - the sign error a week can go into.
//   Builds in Blender (a few seconds) into a scratch store; `--no-blender`
//   skips it;
// - a MATERIAL LAYER of constants bakes into the rock's paint UV as those
//   constants, channel by channel (with the build above).

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { PIXELS_PER_METER, PX } from "../src/engine/units";
import { Vec2 } from "../src/engine/vec2";
import { fitSection, isSimple } from "../src/formation/fit";
import { formationHash } from "../src/formation/recipe";
import { sha256Bytes, sha256Hex } from "../src/formation/sha256";
import type { FormationMeta } from "../src/formation/store";
import { isCollisionObject, loadLevelTree, scaleLevelData, type DecorationObjectData, type FormationData, type LevelData, type PaintStamp, type RawLevelData } from "../src/level/levelFormat";
import { MaterialMask, MASK_SIDE, rasterizePaintUv, type PaintUvMesh } from "../src/formation/materialMask";
import { decorationRequest } from "../src/formation/decoration";
import { readPaintUvMeshes } from "./paintUvMesh";
import { decorationDelta } from "../src/render3d/formations";
import { alignCollisionToGuide, collisionMatchesGuide, formationItemOf, guideFromCollision } from "../src/editor/formationEdit";
import { modelFromDisk, modelToDisk, modelToFlatDisk } from "../src/editor/model";
import { formationDataOf, lookNodes, poseOfFrame, scaleLevelTree, type DecorationNode, type FormationNode, type LevelTree } from "../src/level/nodes";
import { PaintCoverage, samplesOf } from "../src/editor/paintCoverage";
import { PaintCursor } from "../src/editor/paintCursor";
import { isGroup, moveEntry, setMode, stackOf, treeOf } from "../src/formation/solidStack";
import type { SolidNode } from "../src/level/levelFormat";
import * as THREE from "three";
import sharp from "sharp";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

let failed = 0;
function check(name: string, pass: boolean, detail = ""): void {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${pass || !detail ? "" : `\n        ${detail}`}`);
  if (!pass) failed++;
}

// 1. The hash.
{
  const samples = ["", "a", "formation", "é∑😀", "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(1000)];
  const bad = samples.filter((s) => sha256Hex(s) !== createHash("sha256").update(s).digest("hex"));
  check("sha256Hex is SHA-256", bad.length === 0, `differs on ${bad.map((s) => s.length).join(", ")}-character inputs`);
}

// A level in metres: one static body, two unlike pieces, and a formation
// placed off the body's origin.
const formation: FormationData = {
  id: "f1",
  x: 0.25,
  y: -0.1,
  rot: 0.2,
  generator: "fitted",
  params: { seed: 7, depth: 1.3 },
  lod: 1,
  guide: { kind: "collision", pieces: [] },
  built: { hash: "0".repeat(64), front: 0.6, generatorHash: "g", recipeVersion: 2, tiers: [{ triangles: 10, colour: 512, normal: 256, bytes: 99 }] },
};
const level: LevelData = {
  player: { x: 0, y: -3, radius: 0.08 },
  bodies: [
    {
      kind: "static",
      x: 4,
      y: 2,
      rot: 0.1,
      objects: [
        { type: "collision", shape: { kind: "poly", verts: [{ x: -1, y: -0.5 }, { x: 1, y: -0.6 }, { x: 1.1, y: 0.5 }, { x: -0.9, y: 0.4 }] } },
        { type: "collision", x: 1.5, y: 0.1, rot: 0.3, impermeable: true, viscosity: 0.4, shape: { kind: "rect", w: 0.8, h: 0.5 } },
      ],
      formation,
    },
  ],
};

// 2. Through the disk and the editor.
{
  // The level as its file holds it: a tree in pixels. A rock is the look, so it
  // is read from the tree (`lookNodes`), never from the sim's bodies.
  const disk = scaleLevelTree(loadLevelTree(level), PIXELS_PER_METER);
  const rockOf = (tree: LevelTree): FormationNode => lookNodes(tree.nodes).find((p) => p.node.type === "Formation3D")!.node as FormationNode;
  const f = rockOf(scaleLevelTree(disk, PX));
  const near = (a: number | undefined, b: number | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-9;
  check(
    "a formation crosses the disk with its placement, recipe, tier and build record",
    near(f.x, formation.x) && near(f.y, formation.y) && f.rot === formation.rot && f.params["depth"] === 1.3 && f.lod === 1 &&
      f.built?.front === 0.6 && f.built.tiers[0]!.colour === 512 && f.id === "f1",
    JSON.stringify(f),
  );
  // The editor: load, take the guide from the collision, save.
  const model = modelFromDisk(disk);
  const bodyId = model.items[0]!.unit;
  const item = formationItemOf(model, bodyId)!;
  check("the editor loads a formation as an item of its body", !!item && item.formation?.id === "f1");
  item.formation = { ...item.formation!, guide: guideFromCollision(model, bodyId) };
  const saved = modelToDisk(model);
  const reloaded = formationDataOf(rockOf(scaleLevelTree(modelToDisk(modelFromDisk(saved)), PX)));
  const savedNode = rockOf(scaleLevelTree(saved, PX));
  const savedF = { ...formationDataOf(savedNode), x: savedNode.x, y: savedNode.y, rot: savedNode.rot };
  check("the recipe hash survives the editor's save and load", formationHash(reloaded) === formationHash(savedF), `${formationHash(reloaded)} vs ${formationHash(savedF)}`);
  check(
    "the guide keeps each piece's fields",
    savedF.guide.kind === "collision" && savedF.guide.pieces.length === 2 && savedF.guide.pieces[1]!.piece?.impermeable === true &&
      savedF.guide.pieces[1]!.piece?.viscosity === 0.4,
    JSON.stringify(savedF.guide),
  );
  // Where the formation stands is kept: what it is placed at in the body is
  // what it was placed at.
  check("the formation's placement in its body survives the editor", Math.abs((savedF.x ?? 0) - formation.x!) < 1e-9 && Math.abs((savedF.rot ?? 0) - formation.rot!) < 1e-9, JSON.stringify(savedF));

  // A 3D BODY (`LevelBodyData.space`): a backdrop, only drawn, off the plane
  // by its depth and tilted. Its frame, depth and tilt cross the disk and the
  // editor unchanged, and a 2D body gains none of them.
  {
    const solid: FormationData = { id: "b1", generator: "solid", variant: "boulder", params: {}, guide: { kind: "solid", tree: { prim: "box", size: [3, 2, 2], pos: [0, 1, -2.5] } } };
    // A retired 3D body is read as the rock standing in its frame: the rock's
    // world pose is the body's frame, depth and tilt.
    const disk3d = scaleLevelTree(
      loadLevelTree({ player: { x: 0, y: 0, radius: 0.1 }, bodies: [{ kind: "static", x: 4, y: -2, rot: 0.3, space: "3d", z: -6, tilt: [0.2, -0.4], objects: [], formation: solid }] } as LevelData),
      PIXELS_PER_METER,
    );
    const rock3d = lookNodes(scaleLevelTree(modelToDisk(modelFromDisk(disk3d)), PX).nodes).find((p) => p.node.type === "Formation3D")!;
    const round3d = poseOfFrame(rock3d.world);
    check(
      "a 3D body's frame, depth and tilt survive the disk and the editor",
      rock3d.body === null && near(round3d.x, 4) && near(round3d.y, -2) && near(round3d.rot, 0.3) && near(round3d.z, -6) &&
        near(round3d.tilt[0], 0.2) && near(round3d.tilt[1], -0.4),
      JSON.stringify({ body: rock3d.body, ...round3d }),
    );
    const flat = scaleLevelData(modelToFlatDisk(modelFromDisk(disk)), PX).bodies[0]!;
    check("a 2D body stays one", flat.space === undefined && flat.z === undefined && flat.tilt === undefined);
  }

  // 3. Align: edit a piece, then put the guide back.
  const before = JSON.stringify(scaleLevelData(modelToFlatDisk(model), PX).bodies[0]!.objects);
  const guide = item.formation!.guide;
  check("the collision matches the guide it was just taken from", guide.kind === "collision" && collisionMatchesGuide(model, bodyId, guide));
  const piece = model.items.find((i) => i.unit === bodyId && i.object === "collision")!;
  piece.pos = piece.pos.add(new Vec2(0.3, 0));
  check("an edited collision no longer matches", guide.kind === "collision" && !collisionMatchesGuide(model, bodyId, guide));
  alignCollisionToGuide(model, bodyId, item);
  const after = JSON.stringify(scaleLevelData(modelToFlatDisk(model), PX).bodies[0]!.objects);
  const sameObjects = (a: string, b: string): boolean => {
    const pa = JSON.parse(a) as Record<string, unknown>[];
    const pb = JSON.parse(b) as Record<string, unknown>[];
    const round = (v: unknown): unknown =>
      typeof v === "number" ? Math.round(v * 1e6) / 1e6 || 0 : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;
    // A placement left out is a placement of zero: a piece put back through
    // its rock's frame is at zero to the micrometre, not to the bit.
    const placed = (o: Record<string, unknown>): Record<string, unknown> => {
      const { node: _n, x, y, rot, ...rest } = o;
      return { x: x ?? 0, y: y ?? 0, rot: rot ?? 0, ...rest };
    };
    return JSON.stringify(round(pa.map(placed))) === JSON.stringify(round(pb.map(placed)));
  };
  check("\"Align collision to guide\" puts back every piece and every field", sameObjects(before, after), `${before}\n        ${after}`);
  check("...and then it matches", guide.kind === "collision" && collisionMatchesGuide(model, bodyId, guide));
}

// 4. The fit.
{
  const square = (cx: number, cy: number, h: number) => [
    { x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h },
  ];
  // A wobbly ring (many points), a hole in it, and a crumb beside it.
  const ring = Array.from({ length: 200 }, (_, k) => {
    const a = (k / 200) * Math.PI * 2;
    const r = 2 + 0.01 * Math.sin(a * 23);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  const section = [
    { closed: true, points: ring },
    { closed: true, points: square(0, 0, 0.5) },
    { closed: true, points: square(5, 0, 0.005) },
  ];
  const fit = fitSection(section, 0.03, [[]]);
  const polys = fit.polygons[0]!;
  const worst = Math.max(...ring.map((p) => {
    // Distance from the section's boundary point to the fitted ring.
    const poly = polys[0]!;
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
    }
    return best;
  }));
  check("the fit fills a hole and drops a crumb", polys.length === 1 && fit.dropped === 1, `${polys.length} polygons, ${fit.dropped} dropped`);
  check("the fitted outline stays within the accuracy and is simple", worst <= 0.03 + 1e-9 && isSimple(polys[0]!), `worst ${worst.toFixed(4)} m, ${polys[0]!.length} vertices`);
  check("a looser accuracy gives fewer vertices", fitSection(section, 0.1, [[]]).vertices < fit.vertices);
  // Two unlike pieces side by side: each gets the half nearest it.
  const wide = [{ closed: true, points: [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }] }];
  const split = fitSection(wide, 0.01, [[square(-1, 0, 0.9)], [square(1, 0, 0.9)]]);
  const xs = split.polygons.map((ps) => ps.flat().reduce((s, p) => s + p.x, 0) / ps.flat().length);
  check("unlike pieces are fitted each to the part nearest them", split.polygons.every((p) => p.length === 1) && xs[0]! < 0 && xs[1]! > 0, JSON.stringify(xs));
}

// 4a. The boolean stack (formation/solidStack.ts): a solid guide's tree read
// as an ordered list of shapes and written back as the same left fold.
{
  const box = (x: number): SolidNode => ({ prim: "box", size: [1, 1, 1], pos: [x, 0, 0] });
  const tree: SolidNode = { op: "intersection", of: [{ op: "difference", of: [{ op: "union", of: [box(0), box(1)] }, box(2), box(3)] }, box(4)] };
  const s = stackOf(tree);
  check(
    "a fold reads as its shapes in order, each with its mode",
    s.map((e) => e.mode).join(",") === "add,add,subtract,subtract,intersect" && s.map((e) => (e.node as { pos: number[] }).pos[0]).join(",") === "0,1,2,3,4",
    s.map((e) => `${e.mode}@${e.path.join(".")}`).join(" "),
  );
  check("a fold written back is the same tree (its hash untouched)", JSON.stringify(treeOf(s)) === JSON.stringify(tree));
  const recut = setMode(tree, 1, "subtract").tree;
  check("a shape made a cut joins the cuts after it", stackOf(recut).map((e) => e.mode).join(",") === "add,subtract,subtract,subtract,intersect" && "op" in recut && recut.op === "intersection");
  const moved = stackOf(moveEntry(tree, 4, 1).tree);
  check("a shape moved up the stack keeps its own mode and the rest their order", moved.map((e) => `${e.mode}:${(e.node as { pos: number[] }).pos[0]}`).join(",") === "add:0,intersect:4,add:1,subtract:2,subtract:3");
  const nested: SolidNode = { op: "difference", of: [box(0), { op: "union", of: [box(5), box(6)] }] };
  const g = stackOf(nested);
  check("a subtree that is not part of the fold is one group entry", g.length === 2 && g[1]!.mode === "subtract" && isGroup(g[1]!) && JSON.stringify(treeOf(g)) === JSON.stringify(nested));
}

// 4b. The paint preview: what a moss or ivy will cover, as the Blender brush
// composites it (paintCoverage.ts; checked against stampbrush/geometry.py's
// `composite` at 6.5e-8 on 2026-11-22).
{
  const rock = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  const cov = new PaintCoverage(rock);
  const up: [number, number, number] = [0, 1, 0];
  const dab = { p: [0, 0.5, 0] as [number, number, number], n: up, r: 0.3, s: 1 };
  cov.update([dab], 0.35);
  const one = cov.coveredCount(0.35);
  // A dab of radius r covers about pi (k r)^2 of the top, k where the
  // falloff reaches the threshold: smoothstep(1 - d/r) = 0.35 at d = 0.556 r.
  const expected = Math.PI * (0.556 * 0.3) ** 2 / 0.012 ** 2;
  check("a dab covers the disc the threshold cuts, at the brush's spacing", Math.abs(one - expected) / expected < 0.15, `${one} samples, about ${expected.toFixed(0)} expected`);
  const under = new PaintCoverage(rock);
  under.update([{ ...dab, p: [0, -0.5, 0], n: up }], 0.35);
  check("a dab facing up paints nothing on the underside it touches", under.coveredCount(0.35) === 0, `${under.coveredCount(0.35)} covered`);
  cov.update([dab, { ...dab, r: 0.15, s: -1 }], 0.35);
  // At the centre the paint is ~0.9, so the eraser clears where it takes off
  // over 61% (0.9 x 0.39 < 0.35): smoothstep(1 - d/r) > 0.61, d < 0.43 r.
  const cleared = Math.PI * (0.43 * 0.15) ** 2 / 0.012 ** 2;
  check("erasing takes away the disc it clears", Math.abs(one - cov.coveredCount(0.35) - cleared) / cleared < 0.3, `${one} -> ${cov.coveredCount(0.35)}, about ${cleared.toFixed(0)} cleared expected`);
  check("paint undone past what was composited asks to start over", cov.update([dab], 0.35) === false);

  // The brush's cursor (paintCursor.ts) draws the points a dab there would
  // paint: the same points, over an edge too, and none on a face turned away.
  const cursor = new PaintCursor();
  const at = (p: [number, number, number]) => ({ frame: new THREE.Matrix4(), p: new THREE.Vector3(...p), n: new THREE.Vector3(...up), r: 0.3, erase: false, samples: samplesOf(rock) });
  cursor.set(at([0, 0.5, 0]));
  const painted = new PaintCoverage(rock);
  painted.update([dab], 1e-12);
  check("the cursor's footprint is what a dab there paints", cursor.footprint === painted.coveredCount(1e-12) && cursor.footprint > 0, `${cursor.footprint} drawn, ${painted.coveredCount(1e-12)} painted`);
  cursor.set(at([0.5, 0.5, 0]));
  const pts = samplesOf(rock).points;
  let side = 0;
  samplesOf(rock).reach({ p: [0.5, 0.5, 0], n: up, r: 0.3 }, (i) => {
    if (pts[i * 3]! > 0.5) side++;
  });
  check("at an edge the footprint wraps onto the side", side > 0 && cursor.footprint > side, `${side} of ${cursor.footprint} on the side`);
  cursor.set(at([0, -0.5, 0]));
  check("a cursor facing up draws nothing on the underside", cursor.footprint === 0, `${cursor.footprint} drawn`);
}

// 4c. A placed decoration's own turn and size (`turn`, `scale`): kept by the
// disk unscaled - neither is a length - and drawn about where it stands, on
// top of the move from where it grew. 2026-11-25: the disk's field list
// dropped both, so a fern turned by its gizmo was back as it was on reload.
{
  const at = { p: [0.1, 0.2, 0.3] as [number, number, number], n: [0, 1, 0] as [number, number, number] };
  const turn: [number, number, number, number] = [0, 0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)];
  const dec: DecorationObjectData = { type: "decoration", id: "fern-t", kind: "fern", formation: "f1", anchor: at, onRock: at, turn, scale: [2, 2, 2], built: { hash: "h", host: "f", at } };
  // Across the disk as the file holds it, a tree, the decoration read back
  // from the tree (it is the look, not the sim's).
  const decorationOf = (data: LevelData): DecorationNode => {
    const tree = scaleLevelTree(scaleLevelTree(loadLevelTree(data), PIXELS_PER_METER), PX);
    return lookNodes(tree.nodes).find((p) => p.node.type === "Decoration3D")!.node as DecorationNode;
  };
  const back = decorationOf({ ...level, bodies: [{ ...level.bodies[0]!, objects: [dec] }] });
  check("a decoration's turn and size cross the disk unscaled", JSON.stringify(back.turn) === JSON.stringify(turn) && JSON.stringify(back.scale) === "[2,2,2]", JSON.stringify(back));
  // Grown where it stands, so the move is nothing: the root stays put, and a
  // point a unit up its normal (the frame's z) ends up twice as far, turned.
  const delta = decorationDelta(dec);
  const root = new THREE.Vector3(...at.p).applyMatrix4(delta);
  const up = new THREE.Vector3(...at.p).add(new THREE.Vector3(0, 1, 0)).applyMatrix4(delta);
  check("a turn and a size are drawn about the root", root.distanceTo(new THREE.Vector3(...at.p)) < 1e-9 && Math.abs(up.distanceTo(root) - 2) < 1e-9, `root ${root.toArray()}, up ${up.toArray()}`);
  // A material layer's build names its baked material (`built.maps`), which
  // the disk's field list must carry as it carries the rest.
  const layerDec: DecorationObjectData = { type: "decoration", id: "material-t", kind: "material", formation: "f1", anchor: at, settings: { material: "dirt" }, built: { hash: "h", host: "f", at, maps: "m" } };
  const layerBack = decorationOf({ ...level, bodies: [{ ...level.bodies[0]!, objects: [layerDec] }] });
  check("a material layer's baked material crosses the disk", layerBack.built?.maps === "m" && layerBack.settings?.["material"] === "dirt", JSON.stringify(layerBack.built));
}

// 4d. A MATERIAL LAYER's mask (formation/materialMask.ts), on a unit square
// laid over the whole map in two triangles (its paint UV its own x and y):
// every texel is a point on the square at the texel's centre, a stroke lays
// paint around its point and nowhere a face turned away from it, and a stroke
// list that does not run on from the last (undone, thrown away by Esc) is
// composited again from nothing rather than on top.
{
  const side = 64;
  const square: PaintUvMesh = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    index: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
  const texels = rasterizePaintUv([square], side);
  let placed = true;
  for (let i = 0; i < texels.points.count; i++) {
    const k = texels.texel[i]!;
    const x = (k % side) + 0.5;
    const y = Math.floor(k / side) + 0.5;
    if (Math.abs(texels.points.points[i * 3]! - x / side) > 1e-6 || Math.abs(texels.points.points[i * 3 + 1]! - y / side) > 1e-6) placed = false;
  }
  check("every texel of a fully unwrapped square is its point on the square", texels.points.count === side * side && placed, `${texels.points.count} of ${side * side} texels, placed ${placed}`);
  const front: PaintStamp = { p: [0.25, 0.25, 0], n: [0, 0, 1], r: 0.1, s: 1 };
  const mask = new MaterialMask(texels);
  mask.update([front]);
  const px = mask.write(new Uint8Array(side * side));
  const at = (u: number, v: number): number => px[Math.floor(v * side) * side + Math.floor(u * side)]!;
  check("a stroke paints its point and not across the map", at(0.25, 0.25) > 200 && at(0.75, 0.75) === 0, `at the stroke ${at(0.25, 0.25)}, far ${at(0.75, 0.75)}`);
  const behind = new MaterialMask(texels);
  behind.update([{ ...front, n: [0, 0, -1] }]);
  check("a stroke laid from behind the face paints nothing on it", behind.write(new Uint8Array(side * side)).every((v) => v === 0));
  const erased: PaintStamp = { ...front, s: -1 };
  const after = at(0.25, 0.25);
  mask.update([front, erased]);
  const wiped = mask.write(new Uint8Array(side * side))[Math.floor(0.25 * side) * side + Math.floor(0.25 * side)]!;
  const again = new MaterialMask(texels);
  again.update([{ ...front, p: [0.75, 0.75, 0] }]);
  const redo = new MaterialMask(texels);
  redo.update([front]);
  redo.update([{ ...front, p: [0.75, 0.75, 0] }]);
  const a = again.write(new Uint8Array(side * side));
  const b = redo.write(new Uint8Array(side * side));
  check("an eraser takes the paint away", after > 200 && wiped < 30, `${after} then ${wiped}`);
  check("strokes that do not run on from the last start the mask over", a.every((v, i) => v === b[i]), "the old stroke's paint was kept");
}

// 5. Coordinates, through the real build.
if (!process.argv.includes("--no-blender")) {
  const store = mkdtempSync(join(tmpdir(), "formation-test-"));
  try {
    // An L in the level's frame (metres, y DOWN): a tall stem on the left and
    // a foot along the bottom running right.
    const L = [{ x: 0, y: 0 }, { x: 0.8, y: 0 }, { x: 0.8, y: 1.6 }, { x: 2.4, y: 1.6 }, { x: 2.4, y: 2.4 }, { x: 0, y: 2.4 }];
    const recipe = { generator: "fitted", params: { seed: 3 }, guide: { kind: "collision", pieces: [{ shape: { kind: "poly", verts: L } }] } };
    const file = join(store, "recipe.json");
    await Bun.write(file, JSON.stringify(recipe));
    const run = spawnSync("bun", ["run", join(import.meta.dirname, "formation-build.ts"), file, "--store", store], { encoding: "utf8", timeout: 120_000 });
    const line = run.stdout.split("\n").find((l) => l.startsWith("FORMATION_BUILT "));
    check("an L-shaped outline builds", run.status === 0 && !!line, (run.stdout + run.stderr).split("\n").slice(-8).join("\n        "));
    if (line) {
      const { hash } = JSON.parse(line.slice("FORMATION_BUILT ".length)) as { hash: string };
      const meta = JSON.parse(readFileSync(join(store, hash, "meta.json"), "utf8")) as FormationMeta;
      const pts = meta.section.flatMap((l) => l.points);
      const minX = Math.min(...pts.map((p) => p.x));
      const maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxY = Math.max(...pts.map((p) => p.y));
      // Where the section is wide (the foot) must be the bottom (large y).
      const widthAt = (y: number) => {
        const near = pts.filter((p) => Math.abs(p.y - y) < 0.2);
        return near.length ? Math.max(...near.map((p) => p.x)) - Math.min(...near.map((p) => p.x)) : 0;
      };
      check(
        "the section lands on the outline in the level's frame",
        Math.abs(minX - 0) < 0.35 && Math.abs(maxX - 2.4) < 0.35 && Math.abs(minY - 0) < 0.35 && Math.abs(maxY - 2.4) < 0.35,
        `x ${minX.toFixed(2)}..${maxX.toFixed(2)}, y ${minY.toFixed(2)}..${maxY.toFixed(2)} (outline 0..2.4, 0..2.4)`,
      );
      check("the foot is at the bottom and runs right: the rock is the right way up", widthAt(2.0) > widthAt(0.6) + 0.8, `width at the foot ${widthAt(2.0).toFixed(2)}, at the stem ${widthAt(0.6).toFixed(2)}`);
      // The 3D bounds are the 3D view's frame: y UP, so the outline's y down is -y.
      const b = meta.bounds;
      check(
        "the rock's 3D bounds are the outline's, y up, through the play plane",
        Math.abs(b.min[0] - minX) < 0.2 && Math.abs(b.max[0] - maxX) < 0.2 && Math.abs(b.max[1] + minY) < 0.3 && Math.abs(b.min[1] + maxY) < 0.3 && b.min[2] < 0 && b.max[2] > 0,
        JSON.stringify(b),
      );
      // The paint UV (formation_export.paint_unwrap): the iteration mesh's
      // first UV map, every corner inside the map, islands that do not lie
      // over each other (their UV area no more than the map's), and a fair
      // share of the map used.
      await MeshoptDecoder.ready;
      const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder }).read(join(store, hash, "geometry.glb"));
      const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
      const uv = prim.getAttribute("TEXCOORD_0");
      const pos = prim.getAttribute("POSITION")!;
      let inside = true;
      let uvArea = 0;
      if (uv) {
        const idx = prim.getIndices();
        const n = idx ? idx.getCount() : pos.getCount();
        const at = (i: number): number => (idx ? idx.getScalar(i) : i);
        const a = [0, 0];
        const b = [0, 0];
        const c = [0, 0];
        for (let i = 0; i < uv.getCount(); i++) {
          uv.getElement(i, a);
          if (!(a[0]! >= 0 && a[0]! <= 1 && a[1]! >= 0 && a[1]! <= 1)) inside = false;
        }
        for (let t = 0; t + 2 < n; t += 3) {
          uv.getElement(at(t), a);
          uv.getElement(at(t + 1), b);
          uv.getElement(at(t + 2), c);
          uvArea += Math.abs((b[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (b[1]! - a[1]!)) / 2;
        }
      }
      check("the rock carries its paint UV, inside the map and packed", !!uv && inside && uvArea > 0.3 && uvArea <= 1.0001, `TEXCOORD_0 ${uv ? "present" : "MISSING"}, inside ${inside}, UV area ${uvArea.toFixed(3)}`);

      // A MATERIAL LAYER (material_layer.py): a Principled material whose
      // every channel is a constant (material_layer_fixture.py) bakes into
      // the paint UV as exactly those constants, each in its own map and
      // channel, on every texel (the fill carries them past the islands);
      // its normal is the flat tangent normal.
      const library = join(store, "const.blend");
      const fixture = spawnSync(
        process.env["BLENDER_PATH"] ?? "blender",
        ["-b", "--factory-startup", "--python-exit-code", "1", "--python", join(import.meta.dirname, "..", "tools", "blender", "material_layer_fixture.py"), "--", library],
        { encoding: "utf8", timeout: 30_000 },
      );
      const bake = spawnSync("bun", ["run", join(import.meta.dirname, "material-layer-build.ts"), hash, "Const", "--store", store, "--library", library, "--side", "256"], { encoding: "utf8", timeout: 60_000 });
      const built = /MATERIAL_LAYER_BUILT (.*)/.exec(bake.stdout)?.[1];
      check("a material layer bakes", fixture.status === 0 && bake.status === 0 && !!built, (fixture.stderr + bake.stdout + bake.stderr).split("\n").slice(-6).join("\n        "));
      if (built) {
        const dir = join(store, (JSON.parse(built) as { hash: string }).hash);
        // [map, channel, expected 0..255]: sRGB 0.5; roughness 0.4, metallic
        // 1, height 0.75 (the AOV); the flat normal (0.5, 0.5, 1).
        const expect: [string, number, number][] = [
          ["color.png", 0, 127.5], ["color.png", 1, 127.5], ["color.png", 2, 127.5],
          ["surface.png", 0, 102], ["surface.png", 1, 255], ["surface.png", 2, 191.25],
          ["normal.png", 0, 127.5], ["normal.png", 1, 127.5], ["normal.png", 2, 255],
        ];
        // The normal is exact but for a few texels where the paint UV's
        // tangent frame is ill defined (sliver triangles): 0.04% of them 2
        // or 3 levels off on the fitted L (2026-11-26).
        const off: string[] = [];
        for (const [file, channel, want] of expect) {
          const { data, info } = await sharp(join(dir, file)).raw().toBuffer({ resolveWithObject: true });
          let worst = 0;
          let stray = 0;
          for (let i = channel; i < data.length; i += info.channels) {
            const d = Math.abs(data[i]! - want);
            worst = Math.max(worst, d);
            if (d > 1.5) stray++;
          }
          const normal = file === "normal.png";
          const share = stray / (data.length / info.channels);
          if (info.width !== 256 || (normal ? worst > 3.5 || share > 0.001 : stray > 0)) {
            off.push(`${file}[${channel}] ${info.width}px, ${(100 * share).toFixed(3)}% of texels off from ${want}, by up to ${worst}`);
          }
        }
        check("a constant material bakes as its constants, channel by channel, on every texel", off.length === 0, off.join("; "));

        // A MATERIAL LAYER's build (decoration-build.ts): the material
        // baked, and the mask of one stroke on the L's front face, painted
        // within the stroke's reach of its point on the rock and nowhere
        // else (every painted texel's point, rasterised as the build
        // rasterises it), and naming the material's maps.
        const materials = join(store, "materials");
        mkdirSync(materials, { recursive: true });
        copyFileSync(library, join(materials, "const.blend"));
        const stroke: PaintStamp = { p: [0.4, -1.2, 0.6], n: [0, 0, 1], r: 0.3, s: 1 };
        const layerRequest = decorationRequest(
          { kind: "material", settings: { material: "const" }, anchor: { p: stroke.p, n: stroke.n } },
          hash,
          [stroke],
          undefined,
          sha256Bytes(new Uint8Array(readFileSync(library))),
        )!;
        const requestFile = join(store, "material-request.json");
        writeFileSync(requestFile, JSON.stringify(layerRequest));
        const grow = spawnSync("bun", ["run", join(import.meta.dirname, "decoration-build.ts"), requestFile, "--store", store, "--materials", materials], { encoding: "utf8", timeout: 60_000 });
        const grown = /DECORATION_BUILT (.*)/.exec(grow.stdout)?.[1];
        const result = grown ? (JSON.parse(grown) as { hash: string; maps?: string }) : null;
        check("a material layer builds its mask and names its material", !!result?.maps && existsSync(join(store, result.hash, "mask.png")) && existsSync(join(store, result.maps, "color.png")), (grow.stdout + grow.stderr).split("\n").slice(-6).join("\n        "));
        if (result) {
          const texels = rasterizePaintUv(await readPaintUvMeshes(join(store, hash, "geometry.glb")), MASK_SIDE);
          const { data } = await sharp(join(store, result.hash, "mask.png")).raw().toBuffer({ resolveWithObject: true });
          const channels = data.length / (MASK_SIDE * MASK_SIDE);
          let painted = 0;
          let stray = 0;
          const pts = texels.points.points;
          for (let i = 0; i < texels.points.count; i++) {
            if (data[texels.texel[i]! * channels]! === 0) continue;
            painted++;
            const d = Math.hypot(pts[i * 3]! - stroke.p[0], pts[i * 3 + 1]! - stroke.p[1], pts[i * 3 + 2]! - stroke.p[2]);
            if (d > stroke.r + 0.01) stray++;
          }
          check("a material layer's mask is painted where its stroke reaches and nowhere else", painted > 1000 && stray === 0, `${painted} texels painted, ${stray} beyond the stroke's reach`);
        }
      }
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
}

console.log(`[formations] ${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
