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
    case "box":
    case "cylinder":
      return `${n.prim} ${n.size.map((s) => s.toFixed(2)).join(" × ")}`;
    case "mesh":
      return `${n.file.endsWith(".bin") ? "sculpt" : "mesh"} ${n.file.slice(0, 8)}`;
  }
}

// The whole tree sized by `f` about `centre` (its own frame): each leaf's
// position moved out from the centre and its scale multiplied. Exact for
// every leaf, turned or not, because the factor is the same on every axis
// (a per-axis factor on a turned leaf would be a shear no pose can hold).
// **S** on a guide's body (editor.ts).
export function scaleTree(tree: SolidNode, centre: [number, number, number], f: number): SolidNode {
  if ("op" in tree) return { ...tree, of: tree.of.map((c) => scaleTree(c, centre, f)) };
  const p = tree.pos ?? [0, 0, 0];
  const s = tree.scale ?? [1, 1, 1];
  return {
    ...tree,
    pos: [centre[0] + (p[0] - centre[0]) * f, centre[1] + (p[1] - centre[1]) * f, centre[2] + (p[2] - centre[2]) * f],
    scale: [s[0] * f, s[1] * f, s[2] * f],
  };
}

// The primitives a new node can be, as the editor offers them, each a size a
// metre or two across centred on `at`: the starting shapes a guide is then
// sculpted from (plans/sculpt-guides.md). The outline, three-outline, hull
// and ellipsoid shapes were retired on 2026-11-23 (`RETIRED_SOLID_PRIMS` in
// levelFormat.ts).
export type PrimitiveKind = "box" | "cylinder";

export function newPrimitive(kind: PrimitiveKind, at: [number, number, number]): SolidPrim {
  switch (kind) {
    case "box":
      return { prim: "box", size: [2, 2, 2], pos: at };
    case "cylinder":
      return { prim: "cylinder", size: [1.6, 2, 1.6], pos: at };
  }
}

// A SCULPTABLE guide (plans/sculpt-guides.md): one mesh leaf standing where
// its vertices say, with no pose - a stored mesh in the guide's own frame,
// which is what a sculpt edits. Its store name, or null for any other tree
// (which Apply first meshes into one).
export function sculptedMeshOf(tree: SolidNode): string | null {
  const leaf = "op" in tree ? (tree.op === "union" && tree.of.length === 1 ? tree.of[0]! : null) : tree;
  if (!leaf || "op" in leaf || leaf.prim !== "mesh") return null;
  const still = (v: [number, number, number] | undefined, d: number): boolean => !v || v.every((c) => c === d);
  return still(leaf.pos, 0) && still(leaf.rot, 0) && still(leaf.scale, 1) ? leaf.file : null;
}

// Whether Apply has anything to do: the tree is not already one unposed mesh.
export function needsApply(tree: SolidNode): boolean {
  return sculptedMeshOf(tree) === null;
}

// The tree of a guide that is one stored mesh, as Apply and a sculpt's commit
// write it: a union of one, so the stack reads it as its base and a shape
// added after it lands beside it.
export function meshLeafTree(file: string): SolidNode {
  return { op: "union", of: [{ prim: "mesh", file }] };
}
