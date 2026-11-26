// Sculpted guides held to what is CORRECTNESS (plans/sculpt-guides.md,
// "Tests"; docs/formations.md "Sculpting"):
//
//   bun run scripts/test-sculpt.ts
//
// - the stored binary mesh survives its round trip, and a damaged one is
//   refused;
// - the cut solid keeps what projects inside the polygon and cuts what
//   projects outside, in both lenses, a point near the polygon's edge far
//   from the camera included (where a perspective cut built as a prism
//   would be wrong);
// - Dyntopo leaves no edge of its region longer than 4/3 of the detail size,
//   the mesh closed and two-manifold with no face turned inward, a settled
//   region as it is under another dab, and the shape as it was (a crease
//   included) where it only remeshed. (The plan asked for every
//   edge within [4/5, 4/3]; those are when Dyntopo acts, not where edges end:
//   the halves of an edge just over 4/3 are 2/3, and collapsing them would
//   make it again - formation/dyntopo.ts.)
// - a stroke's undo puts every slot back exactly, and its redo too;
// - a commit round trip (working mesh, stored, loaded, meshed by `solidMesh`)
//   gives back the same vertices and faces;
// - the hand-over to the generator opens a pinch (two sheets touching at a
//   point) so Blender's weld cannot close it;
// - a level holding a retired orthographic leaf (`RETIRED_SOLID_PRIMS`) is
//   refused on load, naming the leaf. (The one-off migration that meshed
//   them, and its cases, went once no level held one: plans/node-tree.md,
//   "Tools that read levels".)
//
// How a brush FEELS (its rates, falloff and spacing) has no cases until it
// has been played (rope/CLAUDE.md, "Validate the behaviour before writing
// the cases").

import { manifold } from "../src/formation/manifold";
import { decodeMeshBin, encodeMeshBin, type SolidMesh } from "../src/formation/meshBin";
import { manifoldOfMesh, meshOfManifold, solidMesh, solidWorkerRecipe, storedGuideMesh } from "../src/formation/solid";
import { meshLeafTree } from "../src/formation/solidTree";
import { cutRegion, polygonIsSimple, type CutView } from "../src/formation/sculptCut";
import { SculptMesh } from "../src/formation/sculptMesh";
import { COLLAPSE_BELOW, dyntopo, SPLIT_ABOVE } from "../src/formation/dyntopo";
import { drawDab, smoothDab } from "../src/formation/sculptBrush";
import { RETIRED_SOLID_PRIMS, scaleLevelData, type RawLevelData } from "../src/level/levelFormat";

let failed = 0;
function check(name: string, pass: boolean, detail = ""): void {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${pass || !detail ? "" : `\n        ${detail}`}`);
  if (!pass) failed++;
}

const sphere = (r: number, segments = 48): SolidMesh => {
  const s = manifold.Manifold.sphere(r, segments);
  const m = meshOfManifold(s);
  s.delete();
  return m;
};

// 1. The binary form.
{
  const mesh = sphere(0.7, 24);
  const back = decodeMeshBin(encodeMeshBin(mesh));
  check(
    "a stored mesh comes back bit for bit",
    back.positions.length === mesh.positions.length && back.positions.every((v, i) => v === mesh.positions[i]) && back.indices.every((v, i) => v === mesh.indices[i]),
  );
  const bytes = encodeMeshBin(mesh);
  const refused = (b: Uint8Array): boolean => {
    try {
      decodeMeshBin(b);
      return false;
    } catch {
      return true;
    }
  };
  const badMagic = bytes.slice();
  badMagic[0] = 0;
  const badIndex = bytes.slice();
  new DataView(badIndex.buffer).setUint32(badIndex.length - 4, 1 << 30, true);
  check("a damaged mesh is refused (magic, length, an index past the vertices)", refused(badMagic) && refused(bytes.slice(0, -4)) && refused(badIndex));
}

// 2. The cut solid, in a camera turned and moved off the origin.
{
  const eye = [3, 1.2, 9];
  const turn = new Float64Array(16);
  // The camera turned 20° about y and 8° about x (column-major), at `eye`.
  const ay = (20 * Math.PI) / 180, ax = (8 * Math.PI) / 180;
  const ry = [[Math.cos(ay), 0, Math.sin(ay)], [0, 1, 0], [-Math.sin(ay), 0, Math.cos(ay)]];
  const rx = [[1, 0, 0], [0, Math.cos(ax), -Math.sin(ax)], [0, Math.sin(ax), Math.cos(ax)]];
  const r = ry.map((row) => [0, 1, 2].map((j) => row[0]! * rx[0]![j]! + row[1]! * rx[1]![j]! + row[2]! * rx[2]![j]!));
  for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) turn[c * 4 + rr] = r[rr]![c]!;
  turn[12] = eye[0]!;
  turn[13] = eye[1]!;
  turn[14] = eye[2]!;
  turn[15] = 1;
  const toGuide = (p: number[]): number[] => [0, 1, 2].map((a) => turn[a]! * p[0]! + turn[4 + a]! * p[1]! + turn[8 + a]! * p[2]! + turn[12 + a]!);
  // A point in the camera's frame, as the guide's.
  const inside = (region: ReturnType<typeof cutRegion>, camPoint: number[]): boolean => {
    const p = toGuide(camPoint);
    const probe = manifold.Manifold.cube([0.002, 0.002, 0.002], true).translate(p as [number, number, number]);
    const both = region.intersect(probe);
    const v = both.volume();
    probe.delete();
    both.delete();
    return v > 0.5 * 0.002 ** 3;
  };
  const square: [number, number][] = [[-0.2, -0.15], [0.25, -0.15], [0.25, 0.2], [-0.2, 0.2]];
  // Perspective: the polygon in slopes. A point at depth d with slope (sx, sy)
  // is at (sx d, sy d, -d) in the camera's frame.
  const persp: CutView = { kind: "perspective", polygon: square, cameraToGuide: [...turn], near: 6, far: 14 };
  const pr = cutRegion(persp);
  const at = (sx: number, sy: number, d: number): number[] => [sx * d, sy * d, -d];
  check("perspective: a point projecting inside the polygon is kept", inside(pr, at(0.05, 0.02, 9)));
  check("perspective: a point projecting outside it is cut", !inside(pr, at(0.35, 0.02, 9)));
  // Near the right edge (slope 0.25), far back: inside by a slope of 0.003,
  // which at 13 m is 4 cm. A prism of the polygon as seen at the near depth
  // would put the edge at 0.25 x 6 = 1.5 m and cut it.
  check("perspective: a point just inside the edge, far from the camera, is kept", inside(pr, at(0.247, 0.0, 13)));
  check("perspective: a point just outside the edge, far from the camera, is cut", !inside(pr, at(0.253, 0.0, 13)));
  pr.delete();
  // Orthographic: the polygon in metres, swept along the view.
  const ortho: CutView = { kind: "orthographic", polygon: square, cameraToGuide: [...turn], near: 6, far: 14 };
  const or = cutRegion(ortho);
  check("orthographic: a point inside the polygon is kept, near and far", inside(or, [0.0, 0.0, -6.5]) && inside(or, [0.0, 0.0, -13.5]));
  check("orthographic: a point outside it is cut", !inside(or, [0.3, 0.0, -9]));
  check("orthographic: just inside the edge far back is kept, just outside cut", inside(or, [0.247, 0, -13]) && !inside(or, [0.253, 0, -13]));
  or.delete();
  check("a polygon that crosses itself is not simple; a square is", !polygonIsSimple([[0, 0], [1, 1], [1, 0], [0, 1]]) && polygonIsSimple(square));
}

// 3. Dyntopo: strokes of dabs over a sphere, drawing and smoothing.
{
  const detail = 0.03;
  const mesh = SculptMesh.fromMesh(sphere(1, 24));
  mesh.beginStep();
  const centres: number[][] = [];
  for (let i = 0; i < 30; i++) {
    const a = -0.6 + i * 0.04;
    const c = [Math.sin(a), 0.2, Math.cos(a)];
    const hit = mesh.raycast([c[0]! * 3, c[1]! * 3, c[2]! * 3], [-c[0]!, -c[1]!, -c[2]!]);
    if (!hit) continue;
    centres.push(hit.point);
    dyntopo(mesh, hit.point, 0.18, detail);
    if (i % 3 === 2) smoothDab(mesh, hit.point, 0.18, 0.5);
    else drawDab(mesh, hit.point, 0.18, 0.5, i % 2 ? 1 : -1);
  }
  // The last dab's region, settled by one more dab of Dyntopo alone.
  const last = centres[centres.length - 1]!;
  dyntopo(mesh, last, 0.18, detail);
  const step = mesh.endStep();
  const region = mesh.trisNear(last, 0.18, []);
  let long = 0, short = 0, edges = 0;
  for (const t of region) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.idx[t * 3 + k]!, b = mesh.idx[t * 3 + ((k + 1) % 3)]!;
      if (a > b) continue;
      edges++;
      const l = Math.sqrt(mesh.edgeLength2(a, b)) / detail;
      if (l > SPLIT_ABOVE + 1e-6) long++;
      if (l < COLLAPSE_BELOW - 1e-6) short++;
    }
  }
  check(`Dyntopo: no edge of the region is longer than 4/3 of the detail size (${edges} edges, ${short} under 4/5)`, edges > 50 && long === 0, `${long} long`);
  // Settled: one more dab of Dyntopo alone changes nothing.
  const settled = mesh.toMesh();
  const again = dyntopo(mesh, last, 0.18, detail);
  const still = mesh.toMesh();
  check(
    "Dyntopo: a settled region is left as it is by another dab",
    again.splits + again.collapses + again.flips === 0 && still.positions.every((v, i) => v === settled.positions[i]) && still.indices.every((v, i) => v === settled.indices[i]),
    JSON.stringify(again),
  );
  check("Dyntopo: the mesh is closed and two-manifold", mesh.isManifold());
  let inward = 0;
  const n = [0, 0, 0];
  for (let t = 0; t < mesh.tCount; t++) {
    if (!mesh.tAlive[t]) continue;
    mesh.triNormal(t, n);
    const a = mesh.idx[t * 3]!;
    if (n[0]! * mesh.pos[a * 3]! + n[1]! * mesh.pos[a * 3 + 1]! + n[2]! * mesh.pos[a * 3 + 2]! <= 0) inward++;
  }
  check("Dyntopo: no face turned inward", inward === 0, `${inward} faces`);
  const solid = manifoldOfMesh(mesh.toMesh());
  check("Dyntopo: manifold-3d takes the result as a solid", solid.status() === "NoError");
  solid.delete();

  // Dyntopo alone changes the topology, not the shape: dabs along a box's
  // edge leave every vertex on the box, the crease included (red before
  // feature preservation: 4.5 mm off it).
  const box = manifold.Manifold.cube([2, 2, 2], true);
  const cube = SculptMesh.fromMesh(meshOfManifold(box));
  box.delete();
  for (let i = 0; i < 40; i++) dyntopo(cube, [-0.4 + i * 0.02, 1, 1], 0.17, 0.02);
  let worst = 0;
  for (let v = 0; v < cube.vCount; v++) {
    if (!cube.vAlive[v]) continue;
    const q = [cube.pos[v * 3]!, cube.pos[v * 3 + 1]!, cube.pos[v * 3 + 2]!];
    // Its distance from the box's surface: the least of its distances to the
    // six face planes it lies within.
    worst = Math.max(worst, Math.min(...q.map((c) => Math.abs(Math.abs(c) - 1))));
  }
  check(`Dyntopo alone keeps the shape: dabs along a box's edge leave every vertex on the box (${cube.liveTriangles} triangles)`, worst < 1e-6, `${worst.toExponential(2)} m off it`);

  // 4. Undo and redo, slot by slot.
  const after = mesh.toMesh();
  mesh.restore(step!.before);
  const undone = mesh.toMesh();
  const original = sphere(1, 24);
  const same = (x: SolidMesh, y: SolidMesh): boolean =>
    x.positions.length === y.positions.length && x.indices.length === y.indices.length && x.positions.every((v, i) => v === y.positions[i]) && x.indices.every((v, i) => v === y.indices[i]);
  check("a stroke's undo gives back the mesh it began on, exactly", same(undone, original) && mesh.isManifold());
  mesh.restore(step!.after);
  check("its redo gives back the stroke's mesh, exactly", same(mesh.toMesh(), after));
}

// 5. A commit round trip: stored, read back, meshed as the guide's tree.
{
  const working = SculptMesh.fromMesh(sphere(0.8, 32));
  working.beginStep();
  for (let i = 0; i < 8; i++) {
    const hit = working.raycast([0.1 * i - 0.4, 0.3, 3], [0, 0, -1])!;
    dyntopo(working, hit.point, 0.2, 0.04);
    drawDab(working, hit.point, 0.2, 0.6, 1);
  }
  working.endStep();
  const checked = storedGuideMesh(working.toMesh());
  if (!("mesh" in checked)) throw new Error(`the working mesh ${checked.problem}`);
  const committed = checked.mesh;
  const name = "commit.bin";
  const loaded = decodeMeshBin(encodeMeshBin(committed));
  const meshed = solidMesh(meshLeafTree(name), new Map([[name, loaded]])).mesh!;
  // Compared as sets of triangles by their corners' positions (manifold-3d
  // may number them afresh), each written from its smallest corner so the
  // winding is kept.
  const tris = (m: SolidMesh): string[] => {
    const out: string[] = [];
    for (let t = 0; t < m.indices.length; t += 3) {
      const c = [0, 1, 2].map((k) => {
        const v = m.indices[t + k]!;
        return `${m.positions[v * 3]},${m.positions[v * 3 + 1]},${m.positions[v * 3 + 2]}`;
      });
      const first = c.indexOf([...c].sort()[0]!);
      out.push([c[first], c[(first + 1) % 3], c[(first + 2) % 3]].join("|"));
    }
    return out.sort();
  };
  const a = tris(committed);
  const b = tris(meshed);
  check(
    `a commit round trip gives back the same vertices and faces (${a.length} triangles)`,
    a.length === b.length && a.every((s, i) => s === b[i]) && meshed.positions.length === committed.positions.length,
  );
}

// 6. A pinch is opened for the generator.
{
  // Two cubes touching at one corner: one solid, a pinch at the corner.
  const a = manifold.Manifold.cube([1, 1, 1]);
  const b = manifold.Manifold.cube([1, 1, 1]).translate([1, 1, 1]);
  const both = manifold.Manifold.union([a, b]);
  const mesh = meshOfManifold(both);
  [a, b, both].forEach((m) => m.delete());
  const name = "pinch.bin";
  const w = solidWorkerRecipe({ generator: "solid", variant: "boulder", params: {}, guide: { kind: "solid", tree: meshLeafTree(name) } }, new Map([[name, mesh]])) as {
    guide: { verts: [number, number, number][] };
  };
  const near = (i: number, j: number): boolean => Math.hypot(...w.guide.verts[i]!.map((c, k) => c - w.guide.verts[j]![k]!)) < 1e-5;
  let pairs = 0;
  for (let i = 0; i < w.guide.verts.length; i++) for (let j = i + 1; j < w.guide.verts.length; j++) if (near(i, j)) pairs++;
  let coincide = 0;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    for (let j = i + 1; j < mesh.positions.length / 3; j++) {
      if ([0, 1, 2].every((k) => mesh.positions[i * 3 + k] === mesh.positions[j * 3 + k])) coincide++;
    }
  }
  check(`a pinch (${coincide} coincident vertex pair${coincide === 1 ? "" : "s"} from manifold-3d) reaches the generator opened past its 10 um weld`, coincide > 0 && pairs === 0, `${pairs} pairs still within 10 um`);
}

// 7. The refusal of a retired leaf, in either form of level.
{
  const leaves: Record<string, unknown> = {
    ellipsoid: { prim: "ellipsoid", size: [200, 160, 120], pos: [10, 20, -30], rot: [0.3, 0.2, 0.1] },
    hull: { op: "difference", of: [{ prim: "hull", points: [[0, 0, 0], [100, 0, 0], [0, 100, 0], [0, 0, 100], [60, 60, 60]] }, { prim: "box", size: [50, 50, 50] }] },
    extrude: { prim: "extrude", outline: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 60, y: 90 }], length: 80, taper: 0.4, scale: [1, 2, 1] },
  };
  const recipe = (tree: unknown) => ({ generator: "solid", variant: "cliff", params: {}, guide: { kind: "solid", tree } });
  const flat = (tree: unknown) => ({ player: { x: 0, y: 0, radius: 8 }, bodies: [{ kind: "static", x: 0, y: 0, rot: 0, objects: [], formation: { id: "r", ...recipe(tree) } }] });
  const nodeTree = (tree: unknown) => ({ format: 3, nodes: [{ type: "Spawn2D", id: "s", name: "Spawn", x: 0, y: 0, radius: 8 }, { type: "Formation3D", id: "r", name: "Rock", ...recipe(tree) }] });
  const refusal = (level: unknown): string => {
    try {
      scaleLevelData(level as RawLevelData, 0.01);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const refusals = RETIRED_SOLID_PRIMS.flatMap((prim) => [refusal(flat(leaves[prim])), refusal(nodeTree(leaves[prim]))].map((m) => ({ prim, m })));
  const missed = refusals.filter(({ prim, m }) => !m.includes(`retired "${prim}"`));
  check(
    `a level holding a retired leaf (${RETIRED_SOLID_PRIMS.join(", ")}) is refused on load, flat or a tree, naming the leaf`,
    missed.length === 0,
    missed.map(({ prim, m }) => `${prim}: ${m || "it loaded"}`).join("; "),
  );
  const kept = { op: "union", of: [{ prim: "box", size: [100, 100, 100] }, { prim: "cylinder", size: [50, 80, 50] }] };
  check("a guide of the shapes that stay loads, flat or a tree", !refusal(flat(kept)) && !refusal(nodeTree(kept)), refusal(flat(kept)) || refusal(nodeTree(kept)));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
