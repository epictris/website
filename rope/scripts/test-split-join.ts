// The editor's split and join held to what is CORRECTNESS (docs/editor-model.md
// "Split and join"; src/editor/splitJoin.ts):
//
//   bun run scripts/test-split-join.ts
//
// - the knife cuts a loop along every run that crosses it edge to edge, and
//   nothing for a run that stops inside, misses, or slides along an edge;
// - a split parts what no longer touches into bodies copied from the one cut,
//   in its frame, and the anchors - with the chain and the vine hung from
//   them - lights and the rest go with the half they are on;
// - a piece touching both halves holds them in one body;
// - join takes the first body's settings, fuses pieces of the same surface
//   that overlap or share an edge, and leaves pieces apart, touching only at
//   a corner, or differing in any setting, as they are;
// - join refuses a chain that would end on one body, and an area left in
//   more than one piece;
// - every result compiles, with every chain and vine the level had.

import { Vec2 } from "../src/engine/vec2";
import { compileLevel, TREE_FORMAT, type LevelTree } from "../src/level/nodes";
import { membersOf, modelFromTree, toTree, type EdItem, type EdModel } from "../src/editor/model";
import { applyCut, cutLoop, joinBodies, planCut, unionLoop } from "../src/editor/splitJoin";

let failed = 0;
function check(name: string, pass: boolean, detail = ""): void {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${pass || !detail ? "" : `\n        ${detail}`}`);
  if (!pass) failed++;
}

const V = (pts: number[][]): Vec2[] => pts.map(([x, y]) => new Vec2(x!, y!));
const area = (l: readonly Vec2[]): number => Math.abs(l.reduce((s, v, i) => s + v.cross(l[(i + 1) % l.length]!), 0)) / 2;
const rect = (id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}) => ({
  type: "CollisionShape2D",
  id,
  name: id,
  x,
  y,
  shape: { kind: "poly", verts: [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }] },
  ...extra,
});

// A plank 400 px long hanging a vine from its left end and chained to a
// crate from its right, with a lamp over its right half.
function plankLevel(): EdModel {
  const tree = {
    format: TREE_FORMAT,
    nodes: [
      { type: "Spawn2D", id: "spawn", name: "Spawn", x: 0, y: -300 },
      {
        type: "StaticBody2D",
        id: "plank",
        name: "Plank",
        order: 0,
        friction: 0.4,
        bounce: 0.3,
        grouped: true,
        children: [
          rect("board", 200, 0, 400, 40),
          { type: "Anchor2D", id: "11", name: "Left", x: 40, y: 20 },
          { type: "Anchor2D", id: "12", name: "Right", x: 360, y: 20 },
          { type: "Light3D", id: "lamp", name: "Lamp", x: 330, y: -40, z: 100, range: 300 },
        ],
      },
      { type: "RigidBody2D", id: "crate", name: "Crate", order: 1, children: [rect("box", 500, 300, 60, 60), { type: "Anchor2D", id: "13", name: "Hook", x: 500, y: 270 }] },
      { type: "Chain", id: "chain", name: "Chain", order: 2, a: "12", b: "13" },
      { type: "Vine", id: "vine", name: "Vine", order: 3, anchor: "11", length: 200 },
    ],
  } as unknown as LevelTree;
  return modelFromTree(tree);
}

const item = (m: EdModel, node: string): EdItem => m.items.find((i) => i.node === node)!;
const anchorItem = (m: EdModel, name: string): EdItem => m.items.find((i) => i.object === "anchor" && m.tree.nodes.get(i.node)?.name === name)!;
const pieces = (m: EdModel, body: string): EdItem[] => membersOf(m, body).filter((i) => i.object === "collision");
function compiles(m: EdModel): { ok: boolean; chains: number; vines: number; problems: string[] } {
  const c = compileLevel(toTree(m));
  return { ok: c.problems.length === 0, chains: c.data.chains?.length ?? 0, vines: c.data.vines?.length ?? 0, problems: c.problems };
}

// 1. The knife.
{
  const sq = V([[0, 0], [2, 0], [2, 2], [0, 2]]);
  const halves = cutLoop(sq, new Vec2(1, -1), new Vec2(1, 3));
  check("a line across a square cuts it in two halves", halves?.length === 2 && halves.every((h) => Math.abs(area(h) - 2) < 1e-9));
  check("corner to corner cuts along the diagonal", cutLoop(sq, new Vec2(0, 0), new Vec2(2, 2))?.every((h) => h.length === 3) === true);
  check("a line that stops inside, misses, or runs along an edge cuts nothing", !cutLoop(sq, new Vec2(1, -1), new Vec2(1, 1)) && !cutLoop(sq, new Vec2(3, -1), new Vec2(3, 3)) && !cutLoop(sq, new Vec2(-1, 0), new Vec2(3, 0)));
  const u = V([[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]]);
  const three = cutLoop(u, new Vec2(-1, 2), new Vec2(4, 2));
  check("a line across both arms of a U cuts it in three, the area kept", three?.length === 3 && Math.abs(three.reduce((s, p) => s + area(p), 0) - area(u)) < 1e-9);
  const flat = cutLoop(u, new Vec2(-1, 1), new Vec2(4, 1));
  check("a cut through the U's inner corners leaves no straight-through corner", flat?.length === 3 && flat.every((p) => p.length === 4));
}

// 2. Union.
{
  const a = V([[0, 0], [1, 0], [1, 1], [0, 1]]);
  check("two squares sharing an edge are one rectangle", unionLoop(a, V([[1, 0], [2, 0], [2, 1], [1, 1]]))?.length === 4);
  check("overlapping squares are one outline", unionLoop(a, V([[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]])) !== null);
  check("squares touching at a corner, or apart, are not one", unionLoop(a, V([[1, 1], [2, 1], [2, 2], [1, 2]])) === null && unionLoop(a, V([[3, 0], [4, 0], [4, 1], [3, 1]])) === null);
  const u = V([[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]]);
  check("a bar closing a U round a hole is not one outline", unionLoop(u, V([[0, 3], [3, 3], [3, 4], [0, 4]])) === null);
}

// 3. Split.
{
  const m = plankLevel();
  const before = compiles(m);
  const board = item(m, "board");
  const x = board.pos.x;
  // The model is in the tree's own units (pixels here): a knife well past the board.
  const plan = planCut([board], new Vec2(x, board.pos.y - 1000), new Vec2(x, board.pos.y + 1000));
  const r = applyCut(m, plan, true);
  check("a cut across the plank parts it into two bodies", typeof r !== "string" && r.bodies.length === 2 && r.made.length === 1, JSON.stringify(r));
  if (typeof r !== "string") {
    const [kept, made] = [m.tree.nodes.get("plank")!, m.tree.nodes.get(r.made[0]!)!];
    check("each body holds one half", pieces(m, kept.id).length === 1 && pieces(m, made.id).length === 1);
    check("the new body is the plank's copy: kind, friction, bounce, name, grouped", made.body!.kind === "static" && made.body!.friction === kept.body!.friction && made.body!.bounce === kept.body!.bounce && made.name.startsWith("Plank") && made.grouped);
    check("...standing in the plank's frame", made.pos.distanceTo(kept.pos) < 1e-12 && made.rot === kept.rot);
    check("...with its own build order", made.body!.order !== kept.body!.order);
    const left = anchorItem(m, "Left");
    const right = anchorItem(m, "Right");
    check("the left anchor stays with the left half, the right with the right", left.bodyOf !== right.bodyOf && pieces(m, left.bodyOf!)[0]!.pos.x < pieces(m, right.bodyOf!)[0]!.pos.x);
    check("the lamp over the right half goes with it", item(m, "lamp").bodyOf === right.bodyOf);
    const c = m.chains[0]!;
    check("the chain still runs from the right anchor to the crate", m.chains.length === 1 && c.a === right.id && c.b === anchorItem(m, "Hook").id);
    check("the vine still hangs from the left anchor", m.vines.length === 1 && m.vines[0]!.anchor === left.id);
    const after = compiles(m);
    check("it compiles, with the chain and the vine", after.ok && after.chains === before.chains && after.vines === before.vines, after.problems.join("; "));

    // 4. Join it back.
    const j = joinBodies(m, ["plank", made.id]);
    check("joining the halves gives one body", typeof j !== "string" && j.body === "plank" && !m.tree.nodes.has(made.id), String(j));
    const one = pieces(m, "plank");
    check("...with the halves fused into one outline, the plank's area", one.length === 1 && one[0]!.shape.kind === "poly" && one[0]!.shape.verts.length === 4 && Math.abs(area(one[0]!.shape.verts) - 400 * 40) < 1e-6, `${one.length} pieces`);
    check("...every anchor, the lamp, the chain and the vine on it", [anchorItem(m, "Left"), anchorItem(m, "Right"), item(m, "lamp")].every((i) => i.bodyOf === "plank") && m.chains.length === 1 && m.vines.length === 1);
    const back = compiles(m);
    check("...and it compiles, with the chain and the vine", back.ok && back.chains === before.chains && back.vines === before.vines, back.problems.join("; "));
  }
}

// 5. Cut without parting (Alt): one body, two pieces.
{
  const m = plankLevel();
  const board = item(m, "board");
  const r = applyCut(m, planCut([board], new Vec2(board.pos.x, -1000), new Vec2(board.pos.x, 1000)), false);
  check("a cut kept in one body leaves two pieces in the plank", typeof r !== "string" && r.made.length === 0 && pieces(m, "plank").length === 2);
}

// 5b. A box is cut as the polygon it is, and its halves are polygons.
{
  const m = modelFromTree({
    format: TREE_FORMAT,
    nodes: [{ type: "RigidBody2D", id: "b", name: "Crate", order: 0, children: [{ type: "CollisionShape2D", id: "box", name: "Box", x: 0, y: 0, rot: 0.3, shape: { kind: "rect", w: 60, h: 60 } }] }],
  } as unknown as LevelTree);
  const box = item(m, "box");
  const r = applyCut(m, planCut([box], new Vec2(-100, -100), new Vec2(100, 100)), true);
  const all = [...m.tree.nodes.values()].filter((n) => n.body).flatMap((n) => pieces(m, n.id));
  check(
    "a turned box cut corner to corner is two rigid bodies of polygons, the box's area between them",
    typeof r !== "string" && r.bodies.length === 2 && all.every((i) => i.shape.kind === "poly") && Math.abs(all.reduce((s, i) => s + area(i.shape.kind === "poly" ? i.shape.verts : []), 0) - 3600) < 1e-6 && r.bodies.every((id) => m.tree.nodes.get(id)!.body!.kind === "rigid"),
    JSON.stringify(r),
  );
}

// 6. A piece touching both halves holds them together.
{
  const m = modelFromTree({
    format: TREE_FORMAT,
    nodes: [{ type: "StaticBody2D", id: "b", name: "B", order: 0, children: [rect("long", 200, 0, 400, 40), rect("post", 200, -60, 40, 100)] }],
  } as unknown as LevelTree);
  const long = item(m, "long");
  const r = applyCut(m, planCut([long], new Vec2(long.pos.x, -1000), new Vec2(long.pos.x, 1000)), true);
  check("a post standing across the cut holds both halves in one body", typeof r !== "string" && r.made.length === 0 && r.held.includes("b") && pieces(m, "b").length === 3, JSON.stringify(r));
}

// 7. Join leaves alone what is not the same surface, or does not touch.
{
  const level = (second: Record<string, unknown>, x2: number, y2 = 0) =>
    modelFromTree({
      format: TREE_FORMAT,
      nodes: [
        { type: "StaticBody2D", id: "a", name: "A", order: 0, friction: 0.2, children: [rect("pa", 0, 0, 100, 100)] },
        { type: "StaticBody2D", id: "b", name: "B", order: 1, friction: 0.9, children: [rect("pb", x2, y2, 100, 100, second)] },
      ],
    } as unknown as LevelTree);
  const fusedWith = (m: EdModel) => {
    const j = joinBodies(m, ["a", "b"]);
    return typeof j === "string" ? j : pieces(m, "a").length;
  };
  check("same surface, sharing an edge: fused", fusedWith(level({}, 100)) === 1);
  check("the joined body keeps the first body's friction", (() => { const m = level({}, 100); joinBodies(m, ["a", "b"]); return m.tree.nodes.get("a")!.body!.friction === 0.2; })());
  check("a different material: two pieces", fusedWith(level({ material: "ice" }, 100)) === 2);
  check("hook-proof on one only: two pieces", fusedWith(level({ impermeable: true }, 100)) === 2);
  check("in different data layers: two pieces", fusedWith(level({ layers: ["back"] }, 100)) === 2);
  check("touching only at a corner: two pieces", fusedWith(level({}, 100, 100)) === 2);
  check("apart: two pieces", fusedWith(level({}, 300)) === 2);
  // Pieces that were one body's already are left as they were.
  const m = modelFromTree({
    format: TREE_FORMAT,
    nodes: [
      { type: "StaticBody2D", id: "a", name: "A", order: 0, children: [rect("a1", 0, 0, 100, 100), rect("a2", 100, 0, 100, 100)] },
      { type: "StaticBody2D", id: "b", name: "B", order: 1, children: [rect("b1", 500, 0, 100, 100)] },
    ],
  } as unknown as LevelTree);
  const j = joinBodies(m, ["a", "b"]);
  check("pieces already in one body are not fused by a join", typeof j !== "string" && j.fused === 0 && pieces(m, "a").length === 3);
}

// 8. Refusals.
{
  const m = plankLevel();
  check("joining two bodies a chain runs between is refused, naming the chain", (() => { const j = joinBodies(m, ["plank", "crate"]); return typeof j === "string" && j.includes("Chain"); })());
  const areas = modelFromTree({
    format: TREE_FORMAT,
    nodes: [
      { type: "Area2D", id: "w1", name: "Water", order: 0, area: "water", children: [rect("p1", 0, 0, 100, 100)] },
      { type: "Area2D", id: "w2", name: "Water2", order: 1, area: "water", children: [rect("p2", 500, 0, 100, 100)] },
    ],
  } as unknown as LevelTree);
  check("joining areas that do not fuse into one outline is refused", typeof joinBodies(areas, ["w1", "w2"]) === "string");
  const touching = modelFromTree({
    format: TREE_FORMAT,
    nodes: [
      { type: "Area2D", id: "w1", name: "Water", order: 0, area: "water", children: [rect("p1", 0, 0, 100, 100)] },
      { type: "Area2D", id: "w2", name: "Water2", order: 1, area: "water", children: [rect("p2", 100, 0, 100, 100)] },
    ],
  } as unknown as LevelTree);
  const j = joinBodies(touching, ["w1", "w2"]);
  check("joining areas that fuse into one outline is one area", typeof j !== "string" && pieces(touching, "w1").length === 1, String(j));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
