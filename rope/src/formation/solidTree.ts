// Editing a solid guide's tree (docs/formations.md, "Background guides"):
// nodes addressed by their path from the root, and every edit a new tree, so
// an undo snapshot that holds the old one is never written through.
//
// Frames are the tree's (`SolidGuide`): the body's as the 3D view draws it,
// x right, y up, z toward the camera, metres.

import type { SolidNode, SolidOp, SolidPrim } from "../level/levelFormat";

export type NodePath = readonly number[];

export function nodeAt(tree: SolidNode, path: NodePath): SolidNode | null {
  let n: SolidNode = tree;
  for (const k of path) {
    if (!("op" in n) || !n.of[k]) return null;
    n = n.of[k]!;
  }
  return n;
}

// `tree` with the node at `path` replaced by `make(node)`.
export function replaceAt(tree: SolidNode, path: NodePath, make: (n: SolidNode) => SolidNode): SolidNode {
  if (!path.length) return make(tree);
  if (!("op" in tree)) return tree;
  const [k, ...rest] = path;
  return { op: tree.op, of: tree.of.map((c, i) => (i === k ? replaceAt(c, rest, make) : c)) };
}

// `tree` without the node at `path`; the root cannot go (null is returned).
export function removeAt(tree: SolidNode, path: NodePath): SolidNode | null {
  if (!path.length) return null;
  const parent = path.slice(0, -1);
  const k = path[path.length - 1]!;
  return replaceAt(tree, parent, (p) => ("op" in p ? { op: p.op, of: p.of.filter((_, i) => i !== k) } : p));
}

// Add `child` under the operation at `path` (or, if that is a primitive,
// beside it under its parent; a primitive root is first wrapped in a union).
// Returns the new tree and the child's path.
export function addUnder(tree: SolidNode, path: NodePath, child: SolidNode): { tree: SolidNode; path: number[] } {
  const at = nodeAt(tree, path);
  if (at && "op" in at) {
    return { tree: replaceAt(tree, path, () => ({ op: at.op, of: [...at.of, child] })), path: [...path, at.of.length] };
  }
  if (!path.length) return { tree: { op: "union", of: [tree, child] }, path: [1] };
  return addUnder(tree, path.slice(0, -1), child);
}

// Put the node at `path` inside a new `op` with it as the only child (the
// start of a difference: the node is what is cut from).
export function wrapIn(tree: SolidNode, path: NodePath, op: SolidOp["op"]): SolidNode {
  return replaceAt(tree, path, (n) => ({ op, of: [n] }));
}

// Every node with its path, depth first, for the panel's list.
export function walk(tree: SolidNode, path: number[] = []): { node: SolidNode; path: number[] }[] {
  const here = [{ node: tree, path }];
  if (!("op" in tree)) return here;
  return [...here, ...tree.of.flatMap((c, k) => walk(c, [...path, k]))];
}

export function nodeLabel(n: SolidNode): string {
  if ("op" in n) return `${n.op} (${n.of.length})`;
  switch (n.prim) {
    case "extrude":
      return `outline, ${n.outline.length} points, ${n.length.toFixed(2)} m deep${n.taper ? `, taper ${n.taper}` : ""}`;
    case "hull":
      return `hull of ${n.points.length} points`;
    case "box":
    case "ellipsoid":
      return `${n.prim} ${n.size.map((s) => s.toFixed(2)).join(" × ")}`;
    case "mesh":
      return `mesh ${n.file.slice(0, 8)}`;
  }
}

// The primitives a new node can be, as the panel offers them, each a size a
// metre or two across centred on `at`.
export function newPrimitive(kind: "box" | "ellipsoid" | "hull" | "extrude", at: [number, number, number]): SolidPrim {
  switch (kind) {
    case "box":
      return { prim: "box", size: [2, 2, 2], pos: at };
    case "ellipsoid":
      return { prim: "ellipsoid", size: [2, 1.6, 1.6], pos: at };
    case "hull":
      return {
        prim: "hull",
        points: [[-1, -0.8, -0.6], [1.1, -0.8, -0.5], [0.2, -0.8, 0.8], [-0.3, 1.1, 0.1], [0.6, 0.6, -0.4]],
        pos: at,
      };
    case "extrude":
      // An outline in its own x/y pushed along its +z: centred on `at` in z.
      return {
        prim: "extrude",
        outline: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1.2, y: 0.6 }, { x: 0, y: 1.2 }, { x: -1.1, y: 0.5 }],
        length: 1.5,
        pos: [at[0], at[1], at[2] - 0.75],
      };
  }
}

// The Orthographic Studio's solid: the intersection of three outlines pushed
// through a box from the front, the top and the side, each a rectangle of the
// box to start from, each then edited in its own plane. The front's outline is
// in x/y pushed along z; the top's is in x/z pushed along y (turned -90° about
// x, so its own y is the world's -z); the side's in z/y pushed along x (turned
// 90° about y, its own x the world's -z).
export function threeOutlinePreset(size: [number, number, number], at: [number, number, number]): SolidOp {
  const [w, h, d] = size;
  const rect = (a: number, b: number) => [
    { x: -a / 2, y: -b / 2 }, { x: a / 2, y: -b / 2 }, { x: a / 2, y: b / 2 }, { x: -a / 2, y: b / 2 },
  ];
  const [x, y, z] = at;
  return {
    op: "intersection",
    of: [
      { prim: "extrude", outline: rect(w, h), length: d, pos: [x, y, z - d / 2] },
      { prim: "extrude", outline: rect(w, d), length: h, rot: [-Math.PI / 2, 0, 0], pos: [x, y - h / 2, z] },
      { prim: "extrude", outline: rect(d, h), length: w, rot: [0, Math.PI / 2, 0], pos: [x - w / 2, y, z] },
    ],
  };
}

// The editable points of a primitive in its own frame: a hull's points, an
// extrusion's outline (z 0, its base plane). Null for one with none.
export function pointsOf(n: SolidNode): [number, number, number][] | null {
  if ("op" in n) return null;
  if (n.prim === "hull") return n.points.map((p) => [...p] as [number, number, number]);
  if (n.prim === "extrude") return n.outline.map((p) => [p.x, p.y, 0]);
  return null;
}

// The primitive with its point `k` at `p` (its own frame). An outline point is
// held to the outline's plane: its z is dropped.
export function withPoint(n: SolidPrim, k: number, p: [number, number, number]): SolidPrim {
  if (n.prim === "hull") return { ...n, points: n.points.map((q, i) => (i === k ? p : q)) };
  if (n.prim === "extrude") return { ...n, outline: n.outline.map((q, i) => (i === k ? { x: p[0], y: p[1] } : q)) };
  return n;
}

// ...with a point added after `k` (between it and the next), or removed.
export function insertPoint(n: SolidPrim, k: number): SolidPrim {
  if (n.prim === "hull") {
    const a = n.points[k]!;
    const b = n.points[(k + 1) % n.points.length]!;
    const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.3, (a[2] + b[2]) / 2];
    return { ...n, points: [...n.points.slice(0, k + 1), mid, ...n.points.slice(k + 1)] };
  }
  if (n.prim === "extrude") {
    const a = n.outline[k]!;
    const b = n.outline[(k + 1) % n.outline.length]!;
    return { ...n, outline: [...n.outline.slice(0, k + 1), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ...n.outline.slice(k + 1)] };
  }
  return n;
}

export function removePoint(n: SolidPrim, k: number): SolidPrim {
  if (n.prim === "hull" && n.points.length > 4) return { ...n, points: n.points.filter((_, i) => i !== k) };
  if (n.prim === "extrude" && n.outline.length > 3) return { ...n, outline: n.outline.filter((_, i) => i !== k) };
  return n;
}
