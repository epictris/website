// A solid guide as a STACK OF SHAPES (plans/editor-ux-pass.md, "The boolean
// stack"): an ordered list, each shape Add, Subtract or Intersect, applied top
// to bottom onto the first - Blender's boolean cutters, MagicaCSG, Womp.
//
// The level format is not changed by it: the stack is how the editor READS a
// solid guide's tree (a left fold) and how it WRITES one back. So the
// generator receives the tree it always did, and a guide nobody edits keeps
// its recipe hash.
//
//   [a, b add, c subtract, d subtract, e intersect]
//     = intersection(difference(union(a, b), c, d), e)
//
// A subtree that is not part of the fold (a union inside a difference's cut,
// say) is one entry of its own, a GROUP, whose node is that subtree.

import type { SolidNode, SolidOp } from "../level/levelFormat";

export type StackMode = "add" | "subtract" | "intersect";

export interface StackEntry {
  mode: StackMode;
  node: SolidNode;
  // Where the node is in the tree it was read from (for the selection, the
  // gizmo and the panel, which address nodes by path).
  path: number[];
}

const OP_OF: Record<StackMode, SolidOp["op"]> = { add: "union", subtract: "difference", intersect: "intersection" };
const MODE_OF: Record<SolidOp["op"], StackMode> = { union: "add", difference: "subtract", intersection: "intersect" };

// The tree read as a stack. The first entry is the base (its mode is "add").
export function stackOf(tree: SolidNode, path: number[] = []): StackEntry[] {
  if (!("op" in tree)) return [{ mode: "add", node: tree, path }];
  if (tree.of.length === 0) return [];
  const out = stackOf(tree.of[0]!, [...path, 0]);
  const mode = MODE_OF[tree.op];
  for (let i = 1; i < tree.of.length; i++) out.push({ mode, node: tree.of[i]!, path: [...path, i] });
  return out;
}

// A stack written as a tree: the left fold, consecutive entries of one mode
// joined under one node. Null for an empty stack.
export function treeOf(entries: readonly { mode: StackMode; node: SolidNode }[]): SolidNode | null {
  if (!entries.length) return null;
  let acc: SolidNode = entries[0]!.node;
  // Whether `acc` is an operation made here, which the next entry of the same
  // mode may join rather than nest under.
  let made = false;
  for (const e of entries.slice(1)) {
    const op = OP_OF[e.mode];
    if (made && "op" in acc && acc.op === op) acc = { op, of: [...acc.of, e.node] };
    else acc = { op, of: [acc, e.node] };
    made = true;
  }
  return acc;
}

// Is this entry a group (a subtree of its own) rather than one shape?
export function isGroup(e: StackEntry): boolean {
  return "op" in e.node;
}

// --- edits: each answers the new tree and the index the edited entry is at --

export function setMode(tree: SolidNode, i: number, mode: StackMode): { tree: SolidNode; index: number } {
  const s = stackOf(tree);
  if (i === 0) return { tree, index: 0 };
  s[i] = { ...s[i]!, mode };
  return { tree: treeOf(s)!, index: i };
}

export function moveEntry(tree: SolidNode, from: number, to: number): { tree: SolidNode; index: number } {
  const s = stackOf(tree);
  const [e] = s.splice(from, 1);
  const at = Math.max(0, Math.min(s.length, to));
  s.splice(at, 0, e!);
  // The base is always added; what took its place keeps its own mode below.
  return { tree: treeOf(s)!, index: at };
}

export function removeEntry(tree: SolidNode, i: number): SolidNode | null {
  const s = stackOf(tree);
  s.splice(i, 1);
  return treeOf(s);
}

export function appendEntry(tree: SolidNode, node: SolidNode, mode: StackMode): { tree: SolidNode; index: number } {
  const s = stackOf(tree);
  s.push({ mode, node, path: [] });
  return { tree: treeOf(s)!, index: s.length - 1 };
}
