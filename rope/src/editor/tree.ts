// THE EDITOR'S NODE TREE (plans/node-tree.md "Editor").
//
// The level as the editor holds it: every node by id, each knowing its parent
// and its children in order. What a node IS lives on it - a body's properties
// on the body node, once; a shape's on its item - so nothing is held twice and
// nothing has to be kept in step.
//
// Placement. The editor works in WORLD metres throughout: every drag, handle
// and marquee is written that way, so an item's `pos`/`rot` and a node's
// `pos`/`rot` are where it stands in the world, and the frame it is recorded
// against is its parent's, worked out on the way to disk (`toTree`). A node
// keeps the LOCAL placement it was loaded with beside it (`local`), and an
// untouched node is written back with exactly those numbers - so opening and
// saving a level moves nothing by even an ulp, which every recorded replay of
// it depends on.
//
// Selection, groups and the scene tree read this; the canvas reads the items.

import { Vec2 } from "../engine/vec2";
import type { LevelNode, NodeType, Pose3D } from "../level/nodes";
import type { BodyKind, MoveEase, MoveMode } from "../level/levelFormat";
import type { EdRouteNode } from "./model";
import { BODY_TYPES, is2D, is3D, uniqueName, WORLD_FIXED_TYPES } from "../level/nodes";

// What a body node carries: everything a body has exactly one of (`BodyProps`
// in level/nodes.ts), in the editor's units and with every field present, an
// absent one written as its default. Held once, on the body; every item under
// the body reads it through `item.body`.
export interface EdBody {
  // The body's class, as the inspector offers it: a static (an
  // `AnimatableBody2D` once it is given a swing, a spin or a route), a rigid
  // body, or one of the areas.
  kind: BodyKind;
  // The build order key (plans/node-tree.md "Build order").
  order: number;
  color: string;
  opacity: number;
  friction: number;
  bounce: number;
  launch: number;
  breakForce: number;
  durability: number;
  force: number;
  flow: number;
  drag: number;
  spill: number;
  waterZ: number;
  waterDepth: number | null;
  passable: boolean;
  pivot: boolean;
  // The bearing in the body's own frame, null for the centre of mass.
  pivotAt: Vec2 | null;
  pivotFreq: number;
  pivotDamping: number;
  springFreqX: number;
  springFreqY: number;
  springDamping: number;
  swingAmp: number;
  swingPeriod: number;
  swingPhase: number;
  spinPeriod: number;
  spinPhase: number;
  // The route in the body's own frame, node zero the body itself.
  route: EdRouteNode[];
  moveMode: MoveMode;
  moveSpeed: number;
  movePhase: number;
  moveEase: MoveEase;
  moveAlign: boolean;
}

export interface EdInstance {
  prefab: string;
  scale: number;
  overrides: Record<string, Record<string, unknown>>;
  // Show the prefab's insides in the scene tree and let them be picked;
  // every edit made there is written as an override.
  editable: boolean;
}

export interface EdNode {
  id: string;
  type: NodeType;
  name: string;
  parent: string | null;
  children: string[];
  grouped: boolean;
  // Not picked on the canvas, nor is anything under it (Godot's lock); the
  // scene tree still selects it. Saved in the level, read by nothing else.
  locked: boolean;
  layers: string[];
  disabled: boolean;
  // WORLD placement in the plane, for every node that has one. For a node
  // drawn from an item (a shape, a volume, an object) it is the item's.
  pos: Vec2;
  rot: number;
  // ...and off it, for a 3D node: its world depth and tilt.
  z: number;
  tilt: [number, number];
  // The placement in the parent's frame it was loaded with, written back as
  // is while the node and its parent stand where they were loaded.
  local: Pose3D | null;
  // What the node carries, by class.
  item: number | null;
  chain: number | null;
  vine: number | null;
  body: EdBody | null;
  instance: EdInstance | null;
  // Fields of the class this editor does not model, carried through a load
  // and a save untouched so nothing on disk is lost.
  extra: Record<string, unknown>;
}

export interface EdTree {
  nodes: Map<string, EdNode>;
  roots: string[];
}

export function emptyTree(): EdTree {
  return { nodes: new Map(), roots: [] };
}

export function childrenOf(tree: EdTree, id: string | null): string[] {
  return id === null ? tree.roots : (tree.nodes.get(id)?.children ?? []);
}

// Ancestors from the parent up to the root.
export function ancestors(tree: EdTree, id: string): EdNode[] {
  const out: EdNode[] = [];
  let cur = tree.nodes.get(id)?.parent ?? null;
  while (cur !== null) {
    const n = tree.nodes.get(cur);
    if (!n) break;
    out.push(n);
    cur = n.parent;
  }
  return out;
}

export function isDescendant(tree: EdTree, id: string, of: string): boolean {
  return ancestors(tree, id).some((a) => a.id === of);
}

// Every node under `id`, depth first, not including it.
export function descendants(tree: EdTree, id: string): EdNode[] {
  const out: EdNode[] = [];
  const walk = (list: readonly string[]): void => {
    for (const c of list) {
      const n = tree.nodes.get(c);
      if (!n) continue;
      out.push(n);
      walk(n.children);
    }
  };
  walk(tree.nodes.get(id)?.children ?? []);
  return out;
}

// Pre-order over the whole tree.
export function walkTree(tree: EdTree, visit: (n: EdNode, depth: number) => void | "skip"): void {
  const walk = (list: readonly string[], depth: number): void => {
    for (const id of list) {
      const n = tree.nodes.get(id);
      if (!n) continue;
      if (visit(n, depth) === "skip") continue;
      walk(n.children, depth + 1);
    }
  };
  walk(tree.roots, 0);
}

export function isBodyType(type: NodeType): boolean {
  return BODY_TYPES.has(type);
}

// The nearest body above a node (not the node itself), or null.
// A placed prefab whose root is a body is that body (it takes its root's
// class), so it is asked by what it carries as well as by its type.
export function bodyAbove(tree: EdTree, id: string): EdNode | null {
  for (const a of ancestors(tree, id)) {
    if (isBodyType(a.type) || a.body) return a;
    if (a.type === "Node") return null;
  }
  return null;
}

// A node's path of names, for the breadcrumb and the tools.
export function pathOf(tree: EdTree, id: string): string {
  const n = tree.nodes.get(id);
  if (!n) return "";
  return [...ancestors(tree, id).reverse().map((a) => a.name), n.name].join("/");
}

// --- names -------------------------------------------------------------------

// A name free among `parent`'s children (sibling names are unique, Godot's
// rule: the next free number is appended). `except` is a node being renamed or
// moved, whose own name does not count against it.
export function freeName(tree: EdTree, parent: string | null, name: string, except?: string): string {
  const taken = new Set(childrenOf(tree, parent).filter((c) => c !== except).map((c) => tree.nodes.get(c)?.name ?? ""));
  return uniqueName(name, taken);
}

export function rename(tree: EdTree, id: string, name: string): void {
  const n = tree.nodes.get(id);
  if (!n) return;
  n.name = freeName(tree, n.parent, name, id);
}

// --- structure -----------------------------------------------------------------

// The level's light nodes: not spatial, one of each, never inside anything but
// a folder.
const LIGHT_TYPES: ReadonlySet<NodeType> = new Set(["Sun", "Environment"]);

// Where a node may NOT go: under itself or its own descendants, a 2D node under
// a 3D one, a body under a body that moves or can vanish, a decoration
// anywhere but on a formation. The same rules `validateTree` holds a file to,
// asked before a drag lands rather than after.
export function canParent(tree: EdTree, id: string, parent: string | null): string | null {
  const n = tree.nodes.get(id);
  if (!n) return "no such node";
  if (parent === null) {
    if (n.type === "Decoration3D") return "a decoration grows on a formation";
    if (n.type === "CollisionShape2D") return "a collision shape needs a body above it";
    return null;
  }
  if (parent === id || isDescendant(tree, parent, id)) return "a node cannot go inside itself";
  const p = tree.nodes.get(parent);
  if (!p) return "no such parent";
  // The level's light is the level's: at the top of the tree or in a folder,
  // and holding nothing.
  if (LIGHT_TYPES.has(p.type)) return `a ${p.type} holds no nodes`;
  if (LIGHT_TYPES.has(n.type) && p.type !== "Node") return `the ${n.type} stands at the top of the tree or in a folder`;
  if (n.type === "Decoration3D" && p.type !== "Formation3D") return "a decoration grows on a formation";
  // The new parent and its ancestors up to the first plain `Node`, which
  // starts a fresh world frame.
  const path = [p, ...ancestors(tree, parent)];
  const stop = path.findIndex((a) => a.type === "Node");
  const frame = stop < 0 ? path : path.slice(0, stop);
  if (is2D(n.type) && frame.some((a) => is3D(a.type))) return "a 2D node lives in the gameplay plane, not under a 3D one";
  const bodyUp = path.find((a) => isBodyType(a.type) || a.type === "Node");
  if (isBodyType(n.type) && bodyUp && isBodyType(bodyUp.type)) {
    if (bodyUp.type !== "StaticBody2D" || (bodyUp.body?.breakForce ?? 0) > 0) return "a body may not sit under a body that moves or can vanish";
  }
  if (n.type === "CollisionShape2D" && !(bodyUp && isBodyType(bodyUp.type))) return "a collision shape needs a body above it";
  if (n.type === "Anchor2D" && bodyUp?.type === "Area2D") return "an anchor cannot be tied to an area";
  const moves = (a: EdNode): boolean => a.type === "AnimatableBody2D" || a.type === "RigidBody2D" || (a.type === "StaticBody2D" && (a.body?.breakForce ?? 0) > 0);
  if (WORLD_FIXED_TYPES.has(n.type) && frame.some(moves)) return "the camera, fog and sky read this as fixed in the world; it cannot ride something that moves";
  return null;
}

// Move a node under `parent` at `index` (the end when absent). The node keeps
// its WORLD placement - Unreal's "keep world", which a drag in the scene tree
// does - since the editor holds world placements: only the frame it is
// recorded against changes. `keepRelative` instead keeps the numbers it was
// recorded with, so it lands at the same offset on its new parent; the caller
// moves it there (`relativeMove` says by how much).
export function reparent(tree: EdTree, id: string, parent: string | null, index?: number): boolean {
  const n = tree.nodes.get(id);
  if (!n || canParent(tree, id, parent) !== null) return false;
  const from = childrenOf(tree, n.parent);
  const at = from.indexOf(id);
  if (at >= 0) from.splice(at, 1);
  const to = childrenOf(tree, parent);
  const k = index === undefined ? to.length : Math.max(0, Math.min(index, to.length));
  to.splice(k, 0, id);
  if (n.parent !== parent) n.local = null;
  n.parent = parent;
  n.name = freeName(tree, parent, n.name, id);
  return true;
}

// Take a node and everything under it out of the tree.
export function removeSubtree(tree: EdTree, id: string): EdNode[] {
  const n = tree.nodes.get(id);
  if (!n) return [];
  const gone = [n, ...descendants(tree, id)];
  const list = childrenOf(tree, n.parent);
  const at = list.indexOf(id);
  if (at >= 0) list.splice(at, 1);
  for (const g of gone) tree.nodes.delete(g.id);
  return gone;
}

// The highest build order key in the tree, so a new body takes one past it.
export function nextOrder(tree: EdTree): number {
  let max = -1;
  for (const n of tree.nodes.values()) {
    if (n.body) max = Math.max(max, n.body.order);
    const o = n.extra["order"];
    if (typeof o === "number") max = Math.max(max, o);
  }
  return max + 1;
}

// --- groups --------------------------------------------------------------------

// WHAT A CLICK ON THE CANVAS SELECTS (plans/node-tree.md "Groups"). A group is
// ENTERED while its root or anything inside it is selected. From the outermost
// group root on the path down to the node under the pointer: a group not
// entered selects its root; an entered one passes the click on to the next
// group root further down, and with none left the node under the pointer is
// selected. Only group roots whose class is clickable in the workspace stop a
// click; the rest pass it through.
export function clickTarget(
  tree: EdTree,
  hit: string,
  selected: ReadonlySet<string>,
  clickable: (n: EdNode) => boolean,
): string {
  const path = [...ancestors(tree, hit).reverse(), tree.nodes.get(hit)!].filter(Boolean);
  const entered = (root: EdNode): boolean => {
    for (const s of selected) if (s === root.id || isDescendant(tree, s, root.id)) return true;
    return false;
  };
  for (const n of path) {
    if (n.id === hit) break;
    if (!n.grouped || !clickable(n)) continue;
    if (!entered(n)) return n.id;
  }
  return hit;
}

// The outermost group root above (or at) a node, for a rubber band.
export function outermostGroup(tree: EdTree, id: string, clickable: (n: EdNode) => boolean): string {
  const path = [...ancestors(tree, id).reverse(), tree.nodes.get(id)!];
  for (const n of path) if (n && n.grouped && clickable(n)) return n.id;
  return id;
}

// --- data layers -----------------------------------------------------------------

// A node is in its own user layers and in every one its ancestors are in, so
// hiding a layer hides whole subtrees.
export function layersOf(tree: EdTree, id: string): Set<string> {
  const out = new Set<string>();
  const n = tree.nodes.get(id);
  for (const l of n?.layers ?? []) out.add(l);
  for (const a of ancestors(tree, id)) for (const l of a.layers) out.add(l);
  return out;
}

// --- reading a level ---------------------------------------------------------------

// The structure of a level's tree: every node with its parent and children,
// placed in the world. Payloads (items, chains, vines, body properties) are
// attached by the model's loader, which knows how to build them.
export function treeOf(nodes: readonly LevelNode[], place: (n: LevelNode, parent: EdNode | null) => { pos: Vec2; rot: number; z: number; tilt: [number, number] }): EdTree {
  const tree = emptyTree();
  const add = (n: LevelNode, parent: EdNode | null): void => {
    const p = place(n, parent);
    const node: EdNode = {
      id: n.id,
      type: n.type,
      name: n.name,
      parent: parent?.id ?? null,
      children: [],
      grouped: n.grouped === true,
      locked: n.locked === true,
      layers: [...(n.layers ?? [])],
      disabled: n.disabled === true,
      pos: p.pos,
      rot: p.rot,
      z: p.z,
      tilt: p.tilt,
      local: localOf(n),
      item: null,
      chain: null,
      vine: null,
      body: null,
      instance: null,
      extra: {},
    };
    tree.nodes.set(n.id, node);
    childrenOf(tree, parent?.id ?? null).push(n.id);
    for (const c of n.children ?? []) add(c, node);
  };
  for (const n of nodes) add(n, null);
  return tree;
}

function localOf(n: LevelNode): Pose3D | null {
  const p = n as LevelNode & Pose3D;
  if (p.x === undefined && p.y === undefined && p.rot === undefined && p.z === undefined && p.tilt === undefined) return {};
  return {
    ...(p.x !== undefined ? { x: p.x } : {}),
    ...(p.y !== undefined ? { y: p.y } : {}),
    ...(p.rot !== undefined ? { rot: p.rot } : {}),
    ...(p.z !== undefined ? { z: p.z } : {}),
    ...(p.tilt !== undefined ? { tilt: [p.tilt[0], p.tilt[1]] as [number, number] } : {}),
  };
}

// A deep copy of the tree: every node, so an undo snapshot never shares one
// with the model it was taken of.
export function cloneTree(tree: EdTree): EdTree {
  const nodes = new Map<string, EdNode>();
  for (const [id, n] of tree.nodes) {
    nodes.set(id, {
      ...n,
      children: [...n.children],
      layers: [...n.layers],
      tilt: [n.tilt[0], n.tilt[1]],
      local: n.local ? { ...n.local, ...(n.local.tilt ? { tilt: [n.local.tilt[0], n.local.tilt[1]] as [number, number] } : {}) } : null,
      body: n.body ? { ...n.body, route: n.body.route.map((r) => ({ ...r })) } : null,
      instance: n.instance ? structuredClone(n.instance) : null,
      extra: { ...n.extra },
    });
  }
  return { nodes, roots: [...tree.roots] };
}
