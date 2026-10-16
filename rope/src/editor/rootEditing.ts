// ROOTS in the editor (docs/roots.md): the tree a root's branches make, and
// the one rule that keeps it a tree - every branch starts ON the branch it
// grows out of.
//
// A root is a body of tapered curves (`EdItem.root`), and each curve is an
// ordinary scene path for every gesture the editor already has for one: its
// nodes and tangent handles are dragged, inserted and deleted exactly as a
// rail's are. What a branch adds is a parent and a place along it (`EdRoot`),
// and its FIRST NODE is that place: `syncRoots` puts it back there after every
// edit, so dragging a trunk drags the base of every branch on it with it while
// their other nodes stay where they were drawn, and dragging a branch's first
// node slides it along its parent instead (`slideRootJunction`).
//
// Everything here is in world metres on the model, as every editor module is.

import { Vec2 } from "../engine/vec2";
import type { RootBarkVariant } from "../level/rootAppearance";
import { buildPolylineIndex, pointAtArcLength, projectOntoPolyline, type PolylineIndex } from "../lib/path";
import { curveLine } from "../lib/stroke";
import {
  bodyFrameOf,
  bodyMembers,
  pathNodes,
  setPathVerts,
  toLocal,
  toWorld,
  type EdItem,
  type EdModel,
} from "./model";

// What a trunk drawn with the root tool starts as: 16 cm at its base, 2.5 cm at
// its tip, both widths at the scale of the ball (40 cm) a root is grabbed by.
export const ROOT_TRUNK_WIDTH = 0.16;
export const ROOT_TIP_WIDTH = 0.025;
// ...and a branch: this fraction of its parent's width where it leaves it,
// tapering to its parent's tip. Leonardo's rule for two children of equal
// girth is 0.71; a little under it reads as a side root rather than a fork.
export const ROOT_BRANCH_SHARE = 0.6;

// How stiff a root made to spring starts (the body panel's Root `springs`), as
// the torsion spring's frequency in Hz: a 1.5 m wooden root held out level
// droops about 3.5° under its own weight at 2 Hz, so it bends visibly under the
// ball without flopping. A guess until it is played.
export const ROOT_SPRING_FREQ = 2;

// An item that is a root branch: a scene-layer curve with a place in a tree.
export type RootItem = EdItem & { shape: Extract<EdItem["shape"], { kind: "path" }>; root: NonNullable<EdItem["root"]> };

export function isRootItem(i: EdItem): i is RootItem {
  return i.root !== null && i.shape.kind === "path" && i.layer === "scene";
}

// All branches in one body share their bark, including across fused joins.
export function setRootBark(model: EdModel, selected: readonly EdItem[], bark: RootBarkVariant): void {
  const bodies = new Set(selected.filter(isRootItem).map(i => i.bodyId));
  for (const item of model.items) if (isRootItem(item) && bodies.has(item.bodyId)) item.root = { ...item.root, bark };
}

// A branch's centreline in world metres, indexed for arc length: the very
// polyline its collision is stroked along (`curveLine`), so a junction placed
// on it is on what the hook bites.
export function rootIndex(item: RootItem): PolylineIndex {
  const s = item.shape;
  const line = curveLine(pathNodes(item), s.width, s.tip).map((p) => toWorld(item, p));
  return buildPolylineIndex(line);
}

// The world point `at` (a fraction of the arc length) along a branch.
export function rootPointAt(item: RootItem, at: number): Vec2 {
  const ix = rootIndex(item);
  return pointAtArcLength(ix, Math.min(1, Math.max(0, at)) * ix.total);
}

// The bar's width `at` along a branch: the linear taper the stroke is built
// with, which is linear in this same arc length.
export function rootWidthAt(item: RootItem, at: number): number {
  const t = Math.min(1, Math.max(0, at));
  const tip = item.shape.tip ?? item.shape.width;
  return item.shape.width + (tip - item.shape.width) * t;
}

// Where `world` lands on a branch: the fraction along it of the nearest point,
// that point, and how far away `world` is from it.
export function projectOntoRoot(item: RootItem, world: Vec2): { at: number; point: Vec2; dist: number } {
  const ix = rootIndex(item);
  const { s, dist } = projectOntoPolyline(ix, world);
  const at = ix.total > 0 ? s / ix.total : 0;
  return { at, point: pointAtArcLength(ix, s), dist };
}

// The root branch a stroke starting at `world` grows out of, if any: the
// nearest branch whose bar - or a band `slop` metres either side of it, so a
// thin tip can still be started from - contains the point. Only branches in an
// unlocked, visible body count; the caller says which (`usable`).
export function rootAt(
  model: EdModel,
  world: Vec2,
  slop: number,
  usable: (i: EdItem) => boolean = () => true,
): { item: RootItem; at: number; point: Vec2 } | null {
  let best: { item: RootItem; at: number; point: Vec2; dist: number } | null = null;
  for (const i of model.items) {
    if (!isRootItem(i) || !usable(i)) continue;
    const hit = projectOntoRoot(i, world);
    if (hit.dist > rootWidthAt(i, hit.at) / 2 + slop) continue;
    if (!best || hit.dist < best.dist) best = { item: i, ...hit };
  }
  return best ? { item: best.item, at: best.at, point: best.point } : null;
}

// Every branch growing (at any depth) out of `item`, parents before children.
export function rootDescendants(model: EdModel, item: EdItem): EdItem[] {
  const out: EdItem[] = [];
  const seen = new Set<number>([item.id]);
  for (let k = -1; k < out.length; k++) {
    const of = k < 0 ? item.id : out[k]!.id;
    for (const i of model.items) {
      if (i.root?.parent === of && !seen.has(i.id)) {
        seen.add(i.id);
        out.push(i);
      }
    }
  }
  return out;
}

// HOLD THE TREE TOGETHER after an edit, and answer whether anything moved.
//
// First every branch whose parent is no longer a root branch in its own body
// - deleted, untagged, moved to another body by Ctrl+G, or a link that would
// close a loop - becomes a TRUNK where it stands. That is what makes taking a
// branch out of its body (to hinge it on a pivot of its own) a gesture rather
// than an error, and it is the one place the rule is stated.
//
// Then, parents before children, each branch's first node is put back on its
// parent at its `at`. Only that node: the rest of the branch stays where it was
// drawn, so the branch bends toward its new base rather than being carried
// rigidly - which is also why reshaping a trunk never sweeps its branches'
// tips through the rock they were drawn into.
export function syncRoots(model: EdModel): boolean {
  const byId = new Map(model.items.map((i) => [i.id, i]));
  let changed = false;
  const roots = model.items.filter(isRootItem);
  for (const i of roots) {
    if (i.root.parent === null) continue;
    const p = byId.get(i.root.parent);
    const ok = p !== undefined && p !== i && isRootItem(p) && p.bodyId === i.bodyId && !closesLoop(byId, i);
    if (!ok) {
      i.root = { ...i.root, parent: null, at: 0 };
      changed = true;
    }
  }
  const depth = (i: RootItem): number => {
    let d = 0;
    for (let p = i.root.parent; p !== null && d <= roots.length; d++) p = byId.get(p)?.root?.parent ?? null;
    return d;
  };
  const ordered = roots.map((i) => ({ i, d: depth(i) })).sort((a, b) => a.d - b.d);
  for (const { i } of ordered) {
    if (i.root.parent === null) continue;
    const parent = byId.get(i.root.parent) as RootItem;
    const junction = toLocal(i, rootPointAt(parent, i.root.at));
    const first = i.shape.verts[0]!;
    if (first.distanceTo(junction) <= 1e-9) continue;
    const verts = [junction, ...i.shape.verts.slice(1)];
    // A first node pulled onto its second has no direction left to grow in;
    // the branch is left as it was rather than collapsed to a point.
    if (setPathVerts(i, verts)) changed = true;
  }
  return changed;
}

function closesLoop(byId: ReadonlyMap<number, EdItem>, from: EdItem): boolean {
  const seen = new Set<number>([from.id]);
  for (let p = from.root?.parent ?? null; p !== null; p = byId.get(p)?.root?.parent ?? null) {
    if (seen.has(p)) return true;
    seen.add(p);
  }
  return false;
}

// Slide a branch's junction to wherever `world` projects onto its parent: the
// gesture a drag of a branch's first node means. Answers false for a trunk,
// whose first node is an ordinary node.
export function slideRootJunction(model: EdModel, item: EdItem, world: Vec2): boolean {
  if (!isRootItem(item) || item.root.parent === null) return false;
  const parent = model.items.find((i) => i.id === item.root.parent);
  if (!parent || !isRootItem(parent)) return false;
  item.root = { ...item.root, parent: parent.id, at: projectOntoRoot(parent, world).at };
  syncRoots(model);
  return true;
}

// The point a trunk grows from, in world metres: its first node. Where a root
// body's bearing goes when it is made a pivot (docs/roots.md, "Springing").
export function rootBase(items: readonly EdItem[]): Vec2 | null {
  const trunk = items.find((i) => isRootItem(i) && i.root.parent === null);
  return trunk && trunk.shape.kind === "path" ? toWorld(trunk, trunk.shape.verts[0]!) : null;
}

// Make the roots whose bodies `leads` lead SPRING about their base, or stand
// static again (the body panel's Root `springs`): rigid, on a pivot whose
// bearing is the trunk's first node in the body's own frame, with a torsion
// return spring - `ROOT_SPRING_FREQ` unless one is already authored. The caller
// carries the lead's properties across its body (`syncBodyProps`).
export function setRootSprings(model: EdModel, leads: readonly EdItem[], on: boolean): void {
  for (const b of leads) {
    if (!on) {
      b.kind = "static";
      b.pivot = false;
      b.pivotAt = null;
      continue;
    }
    const base = rootBase(bodyMembers(model.items, b.bodyId));
    const f = bodyFrameOf(model, b.bodyId);
    b.kind = "rigid";
    b.pivot = true;
    // A pivot and a linear spring are exclusive (docs/pivot-and-spring-bodies.md).
    b.springFreqX = 0;
    b.springFreqY = 0;
    b.pivotAt = base ? base.sub(f.pos).rotated(-f.rot) : null;
    if (!(b.pivotFreq > 0)) b.pivotFreq = ROOT_SPRING_FREQ;
  }
}

// The width a new branch sprouting `at` along `parent` starts at, and the tip
// it tapers to.
export function branchWidths(parent: RootItem, at: number): { width: number; tip: number } {
  const tip = parent.shape.tip ?? ROOT_TIP_WIDTH;
  return { width: Math.max(tip, rootWidthAt(parent, at) * ROOT_BRANCH_SHARE), tip };
}
