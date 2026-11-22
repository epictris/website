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
//   skips it.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { PIXELS_PER_METER, PX } from "../src/engine/units";
import { Vec2 } from "../src/engine/vec2";
import { fitSection, isSimple } from "../src/formation/fit";
import { formationHash } from "../src/formation/recipe";
import { sha256Hex } from "../src/formation/sha256";
import type { FormationMeta } from "../src/formation/store";
import { isCollisionObject, scaleLevelData, type FormationData, type LevelData, type RawLevelData } from "../src/level/levelFormat";
import { alignCollisionToGuide, collisionMatchesGuide, formationItemOf, guideFromCollision } from "../src/editor/formationEdit";
import { modelFromDisk, modelToDisk } from "../src/editor/model";
import { PaintCoverage } from "../src/editor/paintCoverage";
import { isGroup, moveEntry, setMode, stackOf, treeOf } from "../src/formation/solidStack";
import type { SolidNode } from "../src/level/levelFormat";
import * as THREE from "three";

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
  const disk = scaleLevelData(level, PIXELS_PER_METER) as RawLevelData;
  const back = scaleLevelData(disk, PX);
  const f = back.bodies[0]!.formation!;
  const near = (a: number | undefined, b: number | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < 1e-9;
  check(
    "a formation crosses the disk with its placement, recipe, tier and build record",
    near(f.x, formation.x) && near(f.y, formation.y) && f.rot === formation.rot && f.params["depth"] === 1.3 && f.lod === 1 &&
      f.built?.front === 0.6 && f.built.tiers[0]!.colour === 512 && f.id === "f1",
    JSON.stringify(f),
  );
  // The editor: load, take the guide from the collision, save.
  const model = modelFromDisk(disk);
  const bodyId = model.items[0]!.bodyId;
  const item = formationItemOf(model, bodyId)!;
  check("the editor loads a formation as an item of its body", !!item && item.formation?.id === "f1");
  item.formation = { ...item.formation!, guide: guideFromCollision(model, bodyId) };
  const saved = modelToDisk(model);
  const reloaded = scaleLevelData(modelToDisk(modelFromDisk(saved)), PX).bodies[0]!.formation!;
  const savedF = scaleLevelData(saved, PX).bodies[0]!.formation!;
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
    const disk3d = scaleLevelData(
      { player: { x: 0, y: 0, radius: 0.1 }, bodies: [{ kind: "static", x: 4, y: -2, rot: 0.3, space: "3d", z: -6, tilt: [0.2, -0.4], objects: [], formation: solid }] } as LevelData,
      PIXELS_PER_METER,
    );
    const round3d = scaleLevelData(modelToDisk(modelFromDisk(disk3d as unknown as RawLevelData)), PX).bodies[0]!;
    check(
      "a 3D body's frame, depth and tilt survive the disk and the editor",
      round3d.space === "3d" && near(round3d.x, 4) && near(round3d.y, -2) && near(round3d.rot, 0.3) && near(round3d.z, -6) &&
        near(round3d.tilt?.[0], 0.2) && near(round3d.tilt?.[1], -0.4),
      JSON.stringify({ space: round3d.space, x: round3d.x, y: round3d.y, rot: round3d.rot, z: round3d.z, tilt: round3d.tilt }),
    );
    const flat = scaleLevelData(modelToDisk(modelFromDisk(disk)), PX).bodies[0]!;
    check("a 2D body stays one", flat.space === undefined && flat.z === undefined && flat.tilt === undefined);
  }

  // 3. Align: edit a piece, then put the guide back.
  const before = JSON.stringify(scaleLevelData(modelToDisk(model), PX).bodies[0]!.objects);
  const guide = item.formation!.guide;
  check("the collision matches the guide it was just taken from", guide.kind === "collision" && collisionMatchesGuide(model, bodyId, guide));
  const piece = model.items.find((i) => i.bodyId === bodyId && i.object === "collision")!;
  piece.pos = piece.pos.add(new Vec2(0.3, 0));
  check("an edited collision no longer matches", guide.kind === "collision" && !collisionMatchesGuide(model, bodyId, guide));
  alignCollisionToGuide(model, bodyId, item);
  const after = JSON.stringify(scaleLevelData(modelToDisk(model), PX).bodies[0]!.objects);
  const sameObjects = (a: string, b: string): boolean => {
    const pa = JSON.parse(a) as Record<string, unknown>[];
    const pb = JSON.parse(b) as Record<string, unknown>[];
    const round = (v: unknown): unknown =>
      typeof v === "number" ? Math.round(v * 1e6) / 1e6 : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;
    return JSON.stringify(round(pa)) === JSON.stringify(round(pb));
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
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
}

console.log(`[formations] ${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
