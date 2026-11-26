// SPLIT AND JOIN (docs/editor-model.md "Split and join"): the knife that cuts
// polygons and parts what no longer touches into bodies of their own, and the
// join that folds bodies into one and fuses the pieces that are the same kind
// of surface into one outline. The editor's halves of the pair; neither is
// anything the sim or the level format knows about - what they write is
// bodies, shapes and anchors, as drawing them by hand would have.
//
// Both keep every authored setting by construction: a split's new body is a
// copy of the body it came out of, standing in the same frame (so a bearing, a
// route and a swing mean the same thing on both halves), and a join keeps the
// first body whole and fuses only pieces whose every field but the outline
// agrees (`surfaceKey`).
//
// What rides a body - anchors, and with them the chains and vines hung from
// them, lights, models, rocks - goes with the half it is on or nearest to:
// chains and vines name their anchors by item id, so moving an anchor's node
// carries every link hung from it without touching the link.

import { manifold } from "../formation/manifold";
import { Vec2 } from "../engine/vec2";
import { polySignedArea2 } from "../engine/shapes";
import { isAreaKind } from "../level/levelFormat";
import { isSimpleLoop, loopContainsPoint, normalizeWinding } from "../lib/polygon";
import {
  addFrameNode,
  addItem,
  centreShapeOrigin,
  cloneShape,
  membersOf,
  moveNode,
  newBodyId,
  relink,
  removeItems,
  surfaceKey,
  toLocal,
  worldOfNode,
  worldVertices,
  type EdItem,
  type EdModel,
} from "./model";
import { outlineOf } from "./render";
import { ancestors, childrenOf, nextOrder, removeSubtree, type EdBody, type EdNode } from "./tree";

// Lengths below this are the same point (metres): far under anything an
// author can place, far over a double's rounding at level scale.
const EPS = 1e-7;
// A piece thinner than this is not a piece (square metres).
const MIN_AREA = 1e-6;

// --- the cut ------------------------------------------------------------------

// Where a knife line meets a loop: its parameter along the line, the point,
// and where on the loop - edge `edge` at `u` along it.
interface Hit {
  t: number;
  p: Vec2;
  edge: number;
  u: number;
}

function hitsOf(loop: readonly Vec2[], a: Vec2, b: Vec2): Hit[] {
  const d = b.sub(a);
  const out: Hit[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const p0 = loop[i]!;
    const e = loop[(i + 1) % n]!.sub(p0);
    const denom = d.cross(e);
    // Parallel: a knife running along an edge cuts nothing there (the run's
    // ends are where the line meets the edges either side).
    if (Math.abs(denom) <= 1e-12 * d.length() * e.length()) continue;
    const w = p0.sub(a);
    const t = w.cross(e) / denom;
    const u = w.cross(d) / denom;
    const tol = EPS / Math.max(e.length(), EPS);
    if (u < -tol || u > 1 + tol || t < -EPS / d.length() || t > 1 + EPS / d.length()) continue;
    const uc = Math.min(1, Math.max(0, u));
    out.push({ t: Math.min(1, Math.max(0, t)), p: p0.add(e.mul(uc)), edge: i, u: uc });
  }
  // A line through a corner meets both edges at it: one hit.
  out.sort((x, y) => x.t - y.t);
  const kept: Hit[] = [];
  for (const h of out) if (!kept.some((k) => k.p.distanceTo(h.p) <= EPS)) kept.push(h);
  return kept;
}

// The distance from a point to a loop's boundary.
function boundaryDistance(loop: readonly Vec2[], p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) best = Math.min(best, segmentDistance(p, loop[i]!, loop[(i + 1) % loop.length]!));
  return best;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = b.sub(a);
  const len2 = ab.lengthSquared();
  const t = len2 > 0 ? Math.min(1, Math.max(0, p.sub(a).dot(ab) / len2)) : 0;
  return p.distanceTo(a.add(ab.mul(t)));
}

// The loop with the two hits made corners of it, and where each landed. A hit
// on a corner is that corner, not a second vertex beside it.
function withCorners(loop: readonly Vec2[], hs: readonly Hit[]): { ring: Vec2[]; at: number[] } {
  const ring: Vec2[] = [];
  const at = hs.map(() => -1);
  for (let i = 0; i < loop.length; i++) {
    const v = loop[i]!;
    ring.push(v);
    hs.forEach((h, k) => {
      if (at[k] === -1 && h.p.distanceTo(v) <= EPS) at[k] = ring.length - 1;
    });
    const onEdge = hs
      .map((h, k) => ({ h, k }))
      .filter(({ h, k }) => at[k] === -1 && h.edge === i && h.p.distanceTo(v) > EPS && h.p.distanceTo(loop[(i + 1) % loop.length]!) > EPS)
      .sort((x, y) => x.h.u - y.h.u);
    for (const { h, k } of onEdge) {
      ring.push(h.p);
      at[k] = ring.length - 1;
    }
  }
  // A hit on the next corner of the last edge is the first vertex.
  hs.forEach((h, k) => {
    if (at[k] === -1 && h.p.distanceTo(loop[0]!) <= EPS) at[k] = 0;
  });
  return { ring, at };
}

const area = (loop: readonly Vec2[]): number => Math.abs(polySignedArea2(loop)) / 2;

// One chord of the knife line across a loop: two consecutive places it meets
// the boundary with the run between them inside. Split there, or null.
function splitOnce(loop: readonly Vec2[], a: Vec2, b: Vec2): [Vec2[], Vec2[]] | null {
  const hs = hitsOf(loop, a, b);
  for (let k = 0; k + 1 < hs.length; k++) {
    const h1 = hs[k]!;
    const h2 = hs[k + 1]!;
    if (h1.p.distanceTo(h2.p) <= EPS) continue;
    const mid = h1.p.add(h2.p).mul(0.5);
    if (!loopContainsPoint(loop, mid) || boundaryDistance(loop, mid) <= EPS) continue;
    const { ring, at } = withCorners(loop, [h1, h2]);
    const [i, j] = [Math.min(at[0]!, at[1]!), Math.max(at[0]!, at[1]!)];
    if (i < 0 || i === j) continue;
    const one = ring.slice(i, j + 1);
    const two = [...ring.slice(j), ...ring.slice(0, i + 1)];
    if (one.length < 3 || two.length < 3 || area(one) < MIN_AREA || area(two) < MIN_AREA) continue;
    return [one, two];
  }
  return null;
}

// CUT A LOOP along the segment a-b: every run of the segment that crosses
// the loop from boundary to boundary is a cut, and a run that stops inside is
// not (a knife that does not come out the other side has cut nothing). A
// concave outline the line crosses more than once comes apart into as many
// pieces. The pieces, each in the engine's winding; null when nothing was cut.
export function cutLoop(loop: readonly Vec2[], a: Vec2, b: Vec2): Vec2[][] | null {
  if (loop.length < 3 || a.distanceTo(b) <= EPS) return null;
  let pieces: Vec2[][] = [normalizeWinding(loop)];
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;
    for (let i = 0; i < pieces.length; i++) {
      const parts = splitOnce(pieces[i]!, a, b);
      if (!parts) continue;
      pieces.splice(i, 1, normalizeWinding(parts[0]), normalizeWinding(parts[1]));
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return pieces.length > 1 ? pieces.map(withoutStraights) : null;
}

// A loop without the corners it runs straight through: a cut through a reflex
// corner leaves that corner flat on the piece below it, and a corner that is
// not one is only something to drag by mistake.
function withoutStraights(loop: readonly Vec2[]): Vec2[] {
  const out = loop.filter((v, i) => {
    const prev = loop[(i + loop.length - 1) % loop.length]!;
    const next = loop[(i + 1) % loop.length]!;
    return Math.abs(v.sub(prev).cross(next.sub(v))) > EPS * prev.distanceTo(next) || v.sub(prev).dot(next.sub(v)) < 0;
  });
  return out.length >= 3 ? out : [...loop];
}

// Can the knife cut this item? A collision polygon or box on the plane.
export function cuttable(i: EdItem): boolean {
  return i.layer === "scene" && i.object === "collision" && (i.shape.kind === "poly" || i.shape.kind === "rect") && i.z === 0;
}

export interface CutPlan {
  item: EdItem;
  // World loops, the largest first: the first stays the item, the rest are new.
  pieces: Vec2[][];
}

// What a knife from a to b would cut among these items.
export function planCut(items: readonly EdItem[], a: Vec2, b: Vec2): CutPlan[] {
  const out: CutPlan[] = [];
  for (const item of items) {
    if (!cuttable(item)) continue;
    const pieces = cutLoop(worldVertices(item), a, b);
    if (pieces) out.push({ item, pieces: pieces.sort((x, y) => area(y) - area(x)) });
  }
  return out;
}

// --- shapes and bodies ---------------------------------------------------------

// Make an item the given world loop: a polygon in its own frame, its origin
// on the loop's centroid as a drawn shape's is (`centreShapeOrigin`).
function setShapeWorld(item: EdItem, loop: readonly Vec2[]): void {
  item.shape = { kind: "poly", verts: normalizeWinding(loop.map((w) => toLocal(item, w))) };
  centreShapeOrigin(item);
}

// A second piece of the same surface: every field the item has, its own id.
function pieceOf(item: EdItem): EdItem {
  return {
    ...item,
    id: newBodyId(),
    shape: cloneShape(item.shape),
    debug: { ...item.debug },
    cam: { ...item.cam },
    light: { ...item.light },
    note: { ...item.note },
    shelter: { ...item.shelter },
    fog: { ...item.fog },
    modelRef: { ...item.modelRef },
  };
}

function cloneBody(b: EdBody, order: number): EdBody {
  return { ...b, order, route: b.route.map((r) => ({ ...r })) };
}

// A collision item's outline in the world, for the touching tests: its
// vertices, or a circle's, a curve's bar or a belt's loop as the renderer has it.
function worldOutline(i: EdItem): Vec2[] {
  const o = outlineOf(i);
  const local =
    o.kind === "circle"
      ? Array.from({ length: 32 }, (_, k) => new Vec2(Math.cos((k / 32) * Math.PI * 2), Math.sin((k / 32) * Math.PI * 2)).mul(o.radius))
      : o.kind === "rect"
        ? [new Vec2(-o.half.x, -o.half.y), new Vec2(o.half.x, -o.half.y), new Vec2(o.half.x, o.half.y), new Vec2(-o.half.x, o.half.y)]
        : [...o.verts];
  return local.map((v) => i.pos.add(v.rotated(i.rot)));
}

// The distance between two loops: 0 when they overlap or touch.
function loopDistance(p: readonly Vec2[], q: readonly Vec2[]): number {
  if (p.some((v) => loopContainsPoint(q, v)) || q.some((v) => loopContainsPoint(p, v))) return 0;
  let best = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    for (let j = 0; j < q.length; j++) {
      const c = q[j]!;
      const d = q[(j + 1) % q.length]!;
      if (segmentsCross(a, b, c, d)) return 0;
      best = Math.min(best, segmentDistance(a, c, d), segmentDistance(b, c, d), segmentDistance(c, a, b), segmentDistance(d, a, b));
    }
  }
  return best;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = b.sub(a).cross(c.sub(a));
  const d2 = b.sub(a).cross(d.sub(a));
  const d3 = d.sub(c).cross(a.sub(c));
  const d4 = d.sub(c).cross(b.sub(c));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pointDistance(p: Vec2, loop: readonly Vec2[]): number {
  return loopContainsPoint(loop, p) ? 0 : boundaryDistance(loop, p);
}

// --- split ----------------------------------------------------------------------

export interface SplitResult {
  // Every body the cut left: the ones cut, and the new ones parted off them.
  bodies: string[];
  // The new ones alone.
  made: string[];
  // Bodies whose pieces were cut but still hold together through another piece.
  held: string[];
}

// CUT, and with `separate`, PART what no longer touches into bodies of its own.
//
// Each cut item keeps its largest piece and node; the others are new pieces
// beside it, copies of it in everything but the outline. Then, per body cut,
// its pieces are grouped by what still touches (the pieces of one cut never
// count as touching each other - the knife is what separates them - but any
// other piece touching two of them holds them together, as it would in the
// level); the group with the most area stays the body, and every other group
// moves into a new body copied from it, in its frame. Everything else in the
// body - anchors and the chains and vines on them, lights, models, rocks,
// frames - goes with the group it is on, or nearest to.
//
// Mutates `model`. The caller takes the undo snapshot first; a string is the
// reason it was refused, after which the model must be restored from it.
export function applyCut(model: EdModel, plan: readonly CutPlan[], separate: boolean): SplitResult | string {
  const cutGroups: string[][] = [];
  const bodies: string[] = [];
  for (const { item, pieces } of plan) {
    const node = model.tree.nodes.get(item.node);
    if (!node) continue;
    if (node.extra["inInstance"] !== undefined || ancestors(model.tree, node.id).some((a) => a.instance)) {
      return `${node.name} is part of a placed prefab: cut it in the prefab, or make the instance local first`;
    }
    const group = [node.id];
    const siblings = childrenOf(model.tree, node.parent);
    for (let k = 1; k < pieces.length; k++) {
      const piece = pieceOf(item);
      setShapeWorld(piece, pieces[k]!);
      const added = addItem(model, piece, node.parent, siblings.indexOf(node.id) + k, node.name);
      const n = model.tree.nodes.get(added.node)!;
      n.layers = [...node.layers];
      group.push(n.id);
    }
    setShapeWorld(item, pieces[0]!);
    cutGroups.push(group);
    if (item.bodyOf !== null && !bodies.includes(item.bodyOf)) bodies.push(item.bodyOf);
  }
  relink(model);
  const result: SplitResult = { bodies: [...bodies], made: [], held: [] };
  if (!separate) return result;
  for (const b of bodies) {
    const parted = partBody(model, b, cutGroups);
    if (typeof parted === "string") return parted;
    if (!parted.length) result.held.push(b);
    result.made.push(...parted);
    result.bodies.push(...parted);
  }
  relink(model);
  return result;
}

// One body's half of `applyCut`: the new bodies it was parted into.
function partBody(model: EdModel, bodyId: string, cutGroups: readonly string[][]): string[] | string {
  const body = model.tree.nodes.get(bodyId);
  if (!body?.body) return [];
  // The units the body is made of are its children: a piece, or a frame
  // holding pieces, moves as one.
  const units = [...body.children];
  const groupOf = new Map<string, number>();
  cutGroups.forEach((g, k) => g.forEach((id) => groupOf.set(id, k)));
  const solid: { id: string; outlines: Vec2[][]; area: number }[] = [];
  const riders: string[] = [];
  for (const u of units) {
    const pieces = membersOf(model, u).filter((i) => i.object === "collision");
    if (pieces.length) {
      const outlines = pieces.map(worldOutline);
      solid.push({ id: u, outlines, area: outlines.reduce((s, o) => s + area(o), 0) });
    } else riders.push(u);
  }
  // Group by touch, never across the pieces of one cut.
  const parent = solid.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const gi = groupOf.get(solid[i]!.id);
      if (gi !== undefined && gi === groupOf.get(solid[j]!.id)) continue;
      const touch = solid[i]!.outlines.some((p) => solid[j]!.outlines.some((q) => loopDistance(p, q) <= EPS));
      if (touch) parent[find(i)] = find(j);
    }
  }
  const comps = new Map<number, number[]>();
  solid.forEach((_, k) => {
    const r = find(k);
    comps.set(r, [...(comps.get(r) ?? []), k]);
  });
  if (comps.size < 2) return [];
  const groups = [...comps.values()]
    .map((ks) => ({ units: ks.map((k) => solid[k]!.id), outlines: ks.flatMap((k) => solid[k]!.outlines), area: ks.reduce((s, k) => s + solid[k]!.area, 0) }))
    .sort((x, y) => y.area - x.area);
  // Riders go with the group they are on or nearest to; the body's own group
  // wins a tie, and a chain or vine node standing in the body stays.
  const rideWith = new Map<string, number>();
  for (const r of riders) {
    const n = model.tree.nodes.get(r);
    if (!n || n.chain !== null || n.vine !== null) continue;
    const members = membersOf(model, r);
    const at = members.length ? members.map((i) => i.pos) : [worldOfNode(model, r).pos];
    let best = 0;
    let bestD = Infinity;
    groups.forEach((g, k) => {
      const d = Math.min(...at.flatMap((p) => g.outlines.map((o) => pointDistance(p, o))));
      if (d < bestD - EPS) {
        bestD = d;
        best = k;
      }
    });
    rideWith.set(r, best);
  }
  const frame = worldOfNode(model, bodyId);
  const made: string[] = [];
  for (let k = 1; k < groups.length; k++) {
    const nb = addFrameNode(model, body.type, body.parent, {
      pos: frame.pos,
      rot: frame.rot,
      name: body.name,
      body: cloneBody(body.body, nextOrder(model.tree)),
      grouped: body.grouped,
      index: childrenOf(model.tree, body.parent).indexOf(bodyId) + k,
    });
    nb.layers = [...body.layers];
    const move = [...groups[k]!.units, ...riders.filter((r) => rideWith.get(r) === k)];
    for (const u of move) {
      const why = moveNode(model, u, nb.id, undefined);
      if (why) return why;
    }
    made.push(nb.id);
  }
  return made;
}

// --- join -----------------------------------------------------------------------

export interface JoinResult {
  body: string;
  // How many fusions were made (each takes one piece away).
  fused: number;
  // The joined bodies whose kind differed from the first's, by name: their
  // body settings did not survive.
  otherKinds: string[];
}

// JOIN: the first body takes in every other's children, each where it
// stands, and the others go; then, among the pieces that came from different
// bodies, every pair that is the same kind of surface (`surfaceKey`) and
// overlaps or shares an edge is fused into one outline, the pieces that were
// already one body's left as they were. A fused outline that would have a hole
// or touch itself at a point stays two pieces.
//
// Refused, with the reason, when a chain would end up with both ends on the
// one body (the level drops a chain with nothing to constrain), when a body is
// inside another being joined, and when an area would be left more than one
// piece. Mutates `model`; the caller takes the undo snapshot first and puts
// it back on a refusal.
export function joinBodies(model: EdModel, ids: readonly string[]): JoinResult | string {
  const nodes = [...new Set(ids)].map((id) => model.tree.nodes.get(id)).filter((n): n is EdNode => !!n?.body);
  if (nodes.length < 2) return "Join needs two or more bodies selected";
  const [target, ...others] = nodes as [EdNode, ...EdNode[]];
  const inSet = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    if (n.extra["inInstance"] !== undefined || ancestors(model.tree, n.id).some((a) => a.instance)) return `${n.name} is part of a placed prefab: make the instance local first`;
    const outer = ancestors(model.tree, n.id).find((a) => inSet.has(a.id));
    if (outer) return `${n.name} is inside ${outer.name}: join the bodies that stand side by side`;
  }
  const bodyOfItem = new Map(model.items.map((i) => [i.id, i.bodyOf]));
  for (const c of model.chains) {
    const a = bodyOfItem.get(c.a);
    const b = bodyOfItem.get(c.b);
    if (a && b && inSet.has(a) && inSet.has(b)) {
      const name = [...model.tree.nodes.values()].find((n) => n.chain === c.id)?.name ?? "a chain";
      return `${name} runs between two of these bodies; joined, both its ends would be on one body, which the level drops. Re-anchor or delete it first.`;
    }
  }
  // Which body each piece came from, so only pieces of different bodies fuse.
  const origin = new Map<string, Set<string>>();
  for (const n of nodes) for (const c of n.children) origin.set(c, new Set([n.id]));
  for (const o of others) {
    for (const c of [...o.children]) {
      const why = moveNode(model, c, target.id, undefined);
      if (why) return why;
    }
    removeSubtree(model.tree, o.id);
  }
  relink(model);
  const fused = fusePieces(model, target, origin);
  relink(model);
  if (isAreaKind(target.body!.kind)) {
    const pieces = membersOf(model, target.id).filter((i) => i.object === "collision");
    if (pieces.length !== 1) return `${target.name} is an area, and an area is one piece: these did not fuse into one outline (they differ in their settings, or do not touch)`;
  }
  return { body: target.id, fused, otherKinds: others.filter((o) => o.body!.kind !== target.body!.kind).map((o) => o.name) };
}

function fusePieces(model: EdModel, body: EdNode, origin: Map<string, Set<string>>): number {
  let fused = 0;
  for (let guard = 0; guard < 1024; guard++) {
    const pieces = body.children
      .map((id) => model.tree.nodes.get(id))
      .map((n) => (n?.item != null ? model.items.find((i) => i.id === n.item) : undefined))
      .filter((i): i is EdItem => !!i && cuttable(i));
    let done = false;
    for (let i = 0; i < pieces.length && !done; i++) {
      for (let j = i + 1; j < pieces.length && !done; j++) {
        const p = pieces[i]!;
        const q = pieces[j]!;
        const op = origin.get(p.node) ?? new Set<string>();
        const oq = origin.get(q.node) ?? new Set<string>();
        if ([...op].some((o) => oq.has(o))) continue;
        if (surfaceKey(model, p) !== surfaceKey(model, q)) continue;
        const loop = unionLoop(worldVertices(p), worldVertices(q));
        if (!loop) continue;
        // The body's own piece is the one kept: its node, its name.
        const [keep, drop] = oq.has(body.id) && !op.has(body.id) ? [q, p] : [p, q];
        for (const c of [...(model.tree.nodes.get(drop.node)?.children ?? [])]) moveNode(model, c, keep.node, undefined);
        setShapeWorld(keep, loop);
        origin.set(keep.node, new Set([...op, ...oq]));
        removeItems(model, [drop]);
        relink(model);
        fused++;
        done = true;
      }
    }
    if (!done) break;
  }
  return fused;
}

// Two loops as one outline, or null when they are not one: apart, touching
// only at a point, or closing round a hole.
export function unionLoop(a: readonly Vec2[], b: readonly Vec2[]): Vec2[] | null {
  const arr = (l: readonly Vec2[]): [number, number][] => l.map((v) => [v.x, v.y]);
  const cs = new manifold.CrossSection([arr(a), arr(b)], "NonZero");
  const simple = cs.simplify(EPS);
  const polys = simple.toPolygons();
  cs.delete();
  simple.delete();
  if (polys.length !== 1) return null;
  const loop = polys[0]!.map(([x, y]) => new Vec2(x, y));
  if (loop.length < 3 || !isSimpleLoop(loop)) return null;
  // A pinch: the same point twice on one outline is two pieces meeting at a corner.
  for (let i = 0; i < loop.length; i++) for (let j = i + 1; j < loop.length; j++) if (loop[i]!.distanceTo(loop[j]!) <= EPS) return null;
  return normalizeWinding(loop);
}
