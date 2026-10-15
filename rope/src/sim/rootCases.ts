// Root cases: hand-built roots with the answer written down, run by
// `cli roots` (docs/roots.md).
//
// A root is a tree of TAPERED curves in a hook-only body, and none of it is new
// physics: the taper is a stroke whose quads have two different ends, the tree
// is authoring data, and hook-only and the sprung pivot are the body flags
// every other body has. So what is asserted is that the pieces are what they
// claim to be, and that each existing mechanism is actually wired to them:
//
// - the STROKE tiles a tapered bar exactly with convex pieces, base to tip;
// - the FORMAT carries the taper and the tree through the scale and through
//   the editor's round trip, with a branch's parent named by index even when
//   the editor reorders the body it is written in;
// - the BUILD makes a body the hook catches and nothing else collides with, and
//   a sprung root hinges at the base of its trunk;
// - the EDITOR keeps a branch on its parent (`syncRoots`) through every edit
//   that could break it, and the level lint (`rootProblems`) sees the ones a
//   hand edit makes;
// - the MESH the game draws is a closed tube as wide as the bar it stands for.
//
// What is NOT asserted is how a sprung root feels to swing on - the torsion
// spring's own mechanics are `cli spring`'s, and its default stiffness is a
// guess to be played before anything pins it.

import { Vec2 } from "../engine/vec2";
import { LAYER_HOOK, MASK_ALL, MASK_SOLID, RigidBody2D, type PhysicsBody2D } from "../engine/body";
import { circleShape, isConvexLoop, polyArea } from "../engine/shapes";
import { World } from "../engine/world";
import { buildLevelBodies } from "../level/buildBodies";
import { isCollisionObject, scaleLevelData, type LevelBodyData, type RawLevelData } from "../level/levelFormat";
import { rootProblems } from "../level/roots";
import { strokeCurve } from "../lib/stroke";
import { cubicAt, pathNodesOf } from "../lib/path";
import { PX } from "../engine/units";
import { BallHook } from "../classes/ballHook";
import { BallPlayer } from "../classes/ballPlayer";
import { modelFromDisk, modelToDisk, setPathVerts, toLevelData, toWorld, type EdModel } from "../editor/model";
import {
  isRootItem,
  projectOntoRoot,
  rootDescendants,
  rootPointAt,
  setRootSprings,
  slideRootJunction,
  syncRoots,
  type RootItem,
} from "../editor/rootEditing";
import { rootGeometry } from "../render3d/rootMesh";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import type { CollisionObject2D } from "../engine/body";
import { BallLevel } from "../level/ballLevel";
import { ScriptedInput, scriptSpec, type PlaytestScript } from "./playtest";
import { BodyVisual } from "../render3d/bodyVisuals";
import { ChainLayer } from "../render3d/chainVisual";

const DT = 1 / 60;

export interface RootResult {
  name: string;
  passed: boolean;
  details: string[];
  expectedFail?: true;
}

function claims(): { check: (claim: string, got: boolean) => void; details: string[]; passed: () => boolean } {
  const details: string[] = [];
  let passed = true;
  return {
    details,
    check: (claim, got) => {
      if (!got) passed = false;
      details.push(`${got ? "ok  " : "BAD "} ${claim}`);
    },
    passed: () => passed,
  };
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
const fmt = (v: number, d = 4): string => v.toFixed(d);

// A three-level root on disk, in PIXELS: a trunk bowing down and right, a
// branch off it, a branch off that. A light is listed FIRST in the body, which
// the editor writes after the collision objects - so every parent index has to
// be renumbered on the round trip, and a case that reads them back sees it.
function rootLevel(): RawLevelData {
  return {
    player: { x: 0, y: -200, radius: 8 },
    bodies: [
      {
        kind: "static",
        passable: true,
        x: 0,
        y: 0,
        rot: 0,
        color: "#7a5a40",
        objects: [
          { type: "light", x: 0, y: -50 },
          {
            type: "collision",
            shape: {
              kind: "curve",
              width: 16,
              tip: 2.5,
              verts: [
                { x: 0, y: 0, outX: 60, outY: 0 },
                { x: 150, y: 80, inX: -40, inY: -30 },
              ],
            },
            root: {},
          },
        ],
      },
    ],
  } as RawLevelData;
}

// The editor model of `rootLevel` with a branch grown on the trunk and a
// branch grown on that, each started where the editor starts one: on its
// parent, at a fraction along it.
function grownModel(): { model: EdModel; trunk: RootItem; branch: RootItem; twig: RootItem } {
  const model = modelFromDisk(rootLevel());
  const trunk = model.items.find(isRootItem)!;
  const grow = (parent: RootItem, at: number, to: Vec2): RootItem => {
    const from = rootPointAt(parent, at);
    const item = {
      ...parent,
      id: Math.max(...model.items.map((i) => i.id)) + 1,
      pos: Vec2.ZERO,
      rot: 0,
      shape: {
        kind: "path" as const,
        verts: [from, to],
        handles: [
          { in: Vec2.ZERO, out: Vec2.ZERO },
          { in: Vec2.ZERO, out: Vec2.ZERO },
        ],
        keys: [parent.shape.keys[0]!, parent.shape.keys[0]!],
        width: parent.shape.width * 0.6,
        tip: parent.shape.tip,
      },
      root: { parent: parent.id, at },
    } as RootItem;
    model.items.push(item);
    return item;
  };
  const branch = grow(trunk, 0.5, new Vec2(0.4, 1.4));
  const twig = grow(branch, 0.6, new Vec2(-0.3, 1.6));
  syncRoots(model);
  return { model, trunk, branch, twig };
}

// ---------------------------------------------------------------------------
// stroke - a tapered bar tiles exactly, base to tip, in convex pieces.
// ---------------------------------------------------------------------------
function caseStroke(): RootResult {
  const c = claims();
  const straight = strokeCurve(pathNodesOf([{ x: 0, y: 0 }, { x: 2, y: 0 }]), 0.2, 0.04);
  const area = straight.pieces.reduce((a, p) => a + polyArea(p), 0);
  c.check(
    `a straight root is ONE piece, a trapezoid of the right area (${straight.pieces.length} pieces, ${fmt(area, 6)} m² vs 0.24)`,
    straight.pieces.length === 1 && near(area, 0.24, 1e-12) && isConvexLoop(straight.pieces[0]!),
  );
  const ends = (s: typeof straight): [number, number] => {
    const o = s.outline;
    const n = o.length;
    // Down one side and back the other: the base is the first and last
    // points, the tip the middle two.
    return [o[0]!.distanceTo(o[n - 1]!), o[n / 2 - 1]!.distanceTo(o[n / 2]!)];
  };
  const [b0, t0] = ends(straight);
  c.check(`...as wide as authored at the base and the tip (${fmt(b0)} / ${fmt(t0)})`, near(b0, 0.2, 1e-12) && near(t0, 0.04, 1e-12));

  const verts = [
    { x: 0, y: 0, outX: 0.8, outY: 0 },
    { x: 1.5, y: 0.8, inX: -0.4, inY: -0.3, outX: 0.4, outY: 0.3 },
    { x: 2.2, y: 2.0, inX: 0, inY: -0.5 },
  ];
  const bent = strokeCurve(pathNodesOf(verts), 0.16, 0.025);
  c.check(`a bent root's every piece is convex (${bent.pieces.length} pieces)`, bent.pieces.length > 3 && bent.pieces.every((p) => isConvexLoop(p)));
  const hw = bent.halfWidths!;
  const narrowing = hw.every((h, i) => i === 0 || h <= hw[i - 1]! + 1e-15);
  c.check(
    `...and narrows monotonically from ${fmt(hw[0]! * 2)} to ${fmt(hw[hw.length - 1]! * 2)} m`,
    narrowing && near(hw[0]! * 2, 0.16, 1e-12) && near(hw[hw.length - 1]! * 2, 0.025, 1e-12),
  );
  // The pieces tile the bar: their areas sum to the integral of the width
  // along the centreline, segment by segment (each a trapezoid in width), to
  // within what the mitred joints shift between neighbours.
  const tiled = bent.pieces.reduce((a, p) => a + polyArea(p), 0);
  let integral = 0;
  for (let i = 0; i + 1 < bent.line.length; i++) {
    integral += (hw[i]! + hw[i + 1]!) * bent.line[i]!.distanceTo(bent.line[i + 1]!);
  }
  c.check(`...and its pieces tile it: ${fmt(tiled, 5)} m² against ${fmt(integral, 5)} m² of bar`, near(tiled, integral, integral * 0.01));
  // The centreline stays on the authored cubic: within the stroke's tolerance
  // of it plus the 5 cm sampling's own chord error.
  const nodes = pathNodesOf(verts);
  let worst = 0;
  for (let e = 0; e + 1 < nodes.length; e++) {
    const a = nodes[e]!;
    const b = nodes[e + 1]!;
    for (let k = 0; k <= 200; k++) {
      const p = cubicAt(a.p, a.p.add(a.out), b.p.add(b.in), b.p, k / 200);
      let d = Infinity;
      for (let i = 0; i + 1 < bent.line.length; i++) d = Math.min(d, segDist(p, bent.line[i]!, bent.line[i + 1]!));
      worst = Math.max(worst, d);
    }
  }
  c.check(`...and its centreline keeps within a centimetre of the cubic (${fmt(worst * 1000, 2)} mm)`, worst <= 0.01);
  return { name: "root-stroke - a tapered bar tiles exactly, base to tip, in convex pieces", passed: c.passed(), details: c.details };
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const e = b.sub(a);
  const l2 = e.lengthSquared();
  const t = l2 > 0 ? Math.min(1, Math.max(0, p.sub(a).dot(e) / l2)) : 0;
  return p.distanceTo(a.add(e.mul(t)));
}

// ---------------------------------------------------------------------------
// format - the taper and the tree survive the scale and the editor.
// ---------------------------------------------------------------------------
function caseFormat(): RootResult {
  const c = claims();
  const data = scaleLevelData(rootLevel(), PX);
  const trunk = data.bodies[0]!.objects.find(isCollisionObject)!;
  c.check(
    `scaleLevelData scales the tip as a length and carries the root tag (tip ${trunk.shape.kind === "curve" ? trunk.shape.tip : "-"})`,
    trunk.shape.kind === "curve" && near(trunk.shape.tip ?? 0, 0.025, 1e-12) && trunk.root !== undefined,
  );
  const { model } = grownModel();
  const disk = modelToDisk(model);
  const objs = disk.bodies.flatMap((b) => b.objects);
  const roots = disk.bodies[0]!.objects;
  const tags = roots.map((o) => (isCollisionObject(o) ? o.root : undefined));
  c.check(
    `the editor writes the three branches into the root's one body (${disk.bodies.length} body, ${objs.length} objects)`,
    disk.bodies.length === 1 && tags.filter((t) => t !== undefined).length === 3,
  );
  // Indices: the light was listed first on disk and is written LAST, so the
  // trunk is object 0 now, and every parent index must say so.
  const trunkAt = tags.findIndex((t) => t !== undefined && t.parent === undefined);
  const branchAt = tags.findIndex((t) => t?.parent === trunkAt);
  const twigAt = tags.findIndex((t) => t?.parent === branchAt);
  c.check(
    `...each naming its parent by its NEW index (trunk ${trunkAt}, branch ${branchAt} -> ${tags[branchAt]?.parent}, twig ${twigAt} -> ${tags[twigAt]?.parent})`,
    trunkAt === 0 && branchAt > 0 && twigAt > 0 && near(tags[branchAt]!.at ?? -1, 0.5, 1e-12) && near(tags[twigAt]!.at ?? -1, 0.6, 1e-12),
  );
  const again = modelToDisk(modelFromDisk(disk));
  c.check("...and a second round trip writes the same level", JSON.stringify(again.bodies) === JSON.stringify(disk.bodies));
  const metres = scaleLevelData(disk, PX);
  const problems = rootProblems(metres.bodies[0]!);
  c.check(`the lint finds every branch on its junction (${problems.join("; ") || "none"})`, problems.length === 0);
  return { name: "root-format - the taper and the tree survive the scale and the editor", passed: c.passed(), details: c.details };
}

// ---------------------------------------------------------------------------
// build - only the hook finds a root.
// ---------------------------------------------------------------------------
function caseHookOnly(): RootResult {
  const c = claims();
  const { model } = grownModel();
  const data = toLevelData(model);
  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const body = built.bodies[0]!.body as PhysicsBody2D;
  c.check(`the root builds one hook-only body (passable ${body.passable}, solid ${body.isSolid})`, body.passable && !body.isSolid);
  c.check("...that is not in the wrap list, so no chain bends round it", !built.wrapBodies.includes(body));
  c.check("...and that no tapered piece is a rail", body.getShapes().every((s) => s.rail === null));
  // A ray down through the trunk's middle: the solid mask misses it, the
  // grapple hook's (`MASK_ALL`, see docs/hook-surfaces.md) finds it.
  const mid = rootPointAt(model.items.find(isRootItem)!, 0.3);
  const from = mid.add(new Vec2(0, -1));
  const to = mid.add(new Vec2(0, 1));
  const solidHit = world.intersectRay(from, to, { collisionMask: MASK_SOLID });
  const hookHit = world.intersectRay(from, to, { collisionMask: MASK_ALL, collisionLayer: LAYER_HOOK });
  c.check(
    `a solid ray passes through it; the hook's finds it (${solidHit?.collider === body} / ${hookHit?.collider === body})`,
    solidHit?.collider !== body && hookHit?.collider === body,
  );
  // The ball's hook, thrown at it, catches.
  const hook = new BallHook();
  hook.globalPosition = mid.add(new Vec2(0, -0.6));
  hook.linearVelocity = new Vec2(0, BallPlayer.HOOK_SPEED);
  let attached = false;
  hook.registerAttachmentCallback(() => {
    attached = true;
  });
  world.add(hook);
  for (let f = 0; f < 30 && !attached; f++) {
    hook.physicsStep(DT);
    if (attached) break;
    world.integrate(DT);
    hook.physicsStep(DT);
  }
  c.check("the ball's hook thrown at it bites", attached);
  // A loose rock dropped onto it falls straight through.
  const world2 = new World();
  buildLevelBodies(world2, data, () => {});
  const rock = new RigidBody2D();
  rock.setShape(circleShape(0.1));
  rock.mass = 5;
  rock.globalPosition = mid.add(new Vec2(0, -0.5));
  world2.add(rock);
  for (let f = 0; f < 60; f++) world2.integrate(DT);
  c.check(`a rock dropped on it falls through (${fmt(rock.globalPosition.y - mid.y, 2)} m below it after 1 s)`, rock.globalPosition.y > mid.y + 1);
  return { name: "root-hook-only - the hook bites a root and nothing else touches it", passed: c.passed(), details: c.details };
}

// ---------------------------------------------------------------------------
// spring - a sprung root hinges at its trunk's base.
// ---------------------------------------------------------------------------
function caseSpring(): RootResult {
  const c = claims();
  const { model, trunk } = grownModel();
  setRootSprings(model, [trunk], true);
  for (const m of model.items) if (m.bodyId === trunk.bodyId && m !== trunk) Object.assign(m, { kind: trunk.kind, pivot: trunk.pivot, pivotAt: trunk.pivotAt, pivotFreq: trunk.pivotFreq });
  const data = toLevelData(model);
  const b = data.bodies[0]!;
  c.check(`springs makes it a rigid pivot with a return spring (${b.kind}, pivot ${b.pivot}, ${b.pivotFreq} Hz)`, b.kind === "rigid" && b.pivot === true && (b.pivotFreq ?? 0) > 0);
  const world = new World();
  const built = buildLevelBodies(world, data, () => {});
  const body = built.bodies[0]!.body as RigidBody2D;
  const base = toWorld(trunk, trunk.shape.verts[0]!);
  c.check(
    `...hinged at the trunk's base (${fmt(body.globalPosition.distanceTo(base) * 1000, 3)} mm off it)`,
    body.globalPosition.distanceTo(base) < 1e-9,
  );
  const spawn = body.globalRotation;
  for (let f = 0; f < 120; f++) world.integrate(DT);
  c.check(
    `...and spawned at rest: after 2 s it has turned ${fmt(Math.abs(body.globalRotation - spawn) * 180 / Math.PI, 5)}° and its axle not at all`,
    Math.abs(body.globalRotation - spawn) < 1e-4 && body.globalPosition.distanceTo(base) < 1e-9,
  );
  setRootSprings(model, [trunk], false);
  c.check("unticked, it is a static root again", trunk.kind === "static" && !trunk.pivot && trunk.pivotAt === null);
  return { name: "root-spring - a sprung root hinges at its trunk's base", passed: c.passed(), details: c.details };
}

// ---------------------------------------------------------------------------
// tree - the editor keeps every branch on its parent.
// ---------------------------------------------------------------------------
function caseTree(): RootResult {
  const c = claims();
  const { model, trunk, branch, twig } = grownModel();
  const onParent = (child: RootItem, parent: RootItem): number =>
    toWorld(child, child.shape.verts[0]!).distanceTo(rootPointAt(parent, child.root.at));
  c.check(
    `a grown branch starts on its parent (${fmt(onParent(branch, trunk) * 1000, 6)} / ${fmt(onParent(twig, branch) * 1000, 6)} mm)`,
    onParent(branch, trunk) < 1e-9 && onParent(twig, branch) < 1e-9,
  );
  // Reshape the trunk: its tip node swings 40 cm. The branch's base follows,
  // and so (through it) does the twig's, while their tips stay put.
  const branchTip = toWorld(branch, branch.shape.verts[1]!);
  const verts = trunk.shape.verts.map((v, i) => (i === 1 ? v.add(new Vec2(0.1, 0.4)) : v));
  setPathVerts(trunk, verts);
  const changed = syncRoots(model);
  c.check(
    `reshaping the trunk carries both junctions with it (${fmt(onParent(branch, trunk) * 1000, 6)} / ${fmt(onParent(twig, branch) * 1000, 6)} mm)`,
    changed && onParent(branch, trunk) < 1e-9 && onParent(twig, branch) < 1e-9,
  );
  c.check("...and leaves the branch's other nodes where they were drawn", toWorld(branch, branch.shape.verts[1]!).distanceTo(branchTip) < 1e-12);
  // Slide the branch's junction toward the trunk's base.
  const target = rootPointAt(trunk, 0.2).add(new Vec2(0.05, 0.05));
  slideRootJunction(model, branch, target);
  c.check(
    `dragging a branch's first node slides it along its parent (at ${fmt(branch.root.at, 3)}, ${fmt(onParent(branch, trunk) * 1000, 6)} mm off)`,
    near(branch.root.at, projectOntoRoot(trunk, target).at, 1e-12) && branch.root.at < 0.3 && onParent(branch, trunk) < 1e-9,
  );
  c.check(
    `the trunk's descendants are the branch and the twig (${rootDescendants(model, trunk).map((i) => i.id).join(", ")})`,
    rootDescendants(model, trunk).length === 2,
  );
  // Ctrl+G the branch into a body of its own: it is a trunk where it stands,
  // and the twig - still in the old body - is then a trunk too.
  const at = toWorld(branch, branch.shape.verts[0]!);
  branch.bodyId = 99_999;
  syncRoots(model);
  c.check(
    `moved to another body, a branch becomes a trunk where it stood (parent ${branch.root.parent}, ${fmt(toWorld(branch, branch.shape.verts[0]!).distanceTo(at) * 1000, 6)} mm moved)`,
    branch.root.parent === null && toWorld(branch, branch.shape.verts[0]!).distanceTo(at) < 1e-12,
  );
  c.check(`...and so does a branch left growing out of nothing in its body (twig parent ${twig.root.parent})`, twig.root.parent === null);
  return { name: "root-tree - the editor keeps every branch on its parent", passed: c.passed(), details: c.details };
}

// ---------------------------------------------------------------------------
// lint - a hand edit that breaks the tree is seen.
// ---------------------------------------------------------------------------
function caseLint(): RootResult {
  const c = claims();
  const metres = scaleLevelData(modelToDisk(grownModel().model), PX).bodies[0]!;
  const withObjects = (mut: (o: LevelBodyData["objects"]) => void): LevelBodyData => {
    const copy = JSON.parse(JSON.stringify(metres)) as LevelBodyData;
    mut(copy.objects);
    return copy;
  };
  const child = metres.objects.findIndex((o) => isCollisionObject(o) && o.root?.parent !== undefined);
  const drifted = withObjects((objs) => {
    const o = objs[child]!;
    if (isCollisionObject(o) && o.shape.kind === "curve") o.shape.verts[0]!.x += 0.05;
  });
  const p1 = rootProblems(drifted);
  c.check(`a branch whose base drifted 5 cm off its parent is reported (${p1.join("; ")})`, p1.some((p) => p.startsWith(`root ${child}'s`) && p.includes("5.0 cm")));
  const orphan = withObjects((objs) => {
    const o = objs[child]!;
    if (isCollisionObject(o)) o.root = { parent: 17, at: 0.5 };
  });
  c.check("a branch naming no root in its body is reported", rootProblems(orphan).some((p) => p.includes("not another root")));
  const loop = withObjects((objs) => {
    const trunkAt = objs.findIndex((o) => isCollisionObject(o) && o.root !== undefined && o.root.parent === undefined);
    const o = objs[trunkAt]!;
    if (isCollisionObject(o)) o.root = { parent: child, at: 0.5 };
  });
  c.check("a loop of parents is reported", rootProblems(loop).some((p) => p.includes("loop")));
  return { name: "root-lint - a hand edit that breaks the tree is reported", passed: c.passed(), details: c.details };
}

// ---------------------------------------------------------------------------
// mesh - a closed tube as wide as its bar, facing out.
// ---------------------------------------------------------------------------
function caseMesh(): RootResult {
  const c = claims();
  const shape = {
    width: 0.16,
    tip: 0.025,
    verts: [
      { x: 0, y: 0, outX: 0.8, outY: 0 },
      { x: 1.5, y: 0.8, inX: -0.4, inY: -0.3 },
    ],
  };
  const g = rootGeometry(shape, { trunk: true, seed: 3 })!;
  const pos = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  let finite = true;
  let outward = 0;
  let total = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  const stroke = strokeCurve(pathNodesOf(shape.verts), shape.width, shape.tip);
  for (let i = 0; i < pos.count; i++) {
    const p = new Vec2(pos.getX(i), -pos.getY(i));
    const z = pos.getZ(i);
    if (![pos.getX(i), pos.getY(i), z, nrm.getX(i), nrm.getY(i), nrm.getZ(i)].every(Number.isFinite)) finite = false;
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
    // The nearest centreline point, in the plane, then out through z.
    let best = Infinity;
    let foot = Vec2.ZERO;
    for (let k = 0; k + 1 < stroke.line.length; k++) {
      const a = stroke.line[k]!;
      const b = stroke.line[k + 1]!;
      const e = b.sub(a);
      const t = Math.min(1, Math.max(0, p.sub(a).dot(e) / e.lengthSquared()));
      const q = a.add(e.mul(t));
      const d = q.distanceTo(p);
      if (d < best) {
        best = d;
        foot = q;
      }
    }
    const out = { x: p.x - foot.x, y: -(p.y - foot.y), z };
    const dot = out.x * nrm.getX(i) + out.y * nrm.getY(i) + out.z * nrm.getZ(i);
    total++;
    if (dot >= -1e-9) outward++;
  }
  c.check(`every vertex and normal is finite (${pos.count} vertices)`, finite);
  c.check(`...the normals face out of the tube (${outward}/${total})`, outward / total > 0.98);
  // Round through z, as deep as it is wide: the base flare tops it out at
  // (1 + flare)(1 + swell)(1 + lobe) of the base half-width.
  const depth = zMax - zMin;
  c.check(`...it is as deep through z as the bar is wide, flare included (${fmt(depth, 3)} m for a ${shape.width} m base)`, depth > shape.width * 0.9 && depth < shape.width * 1.45 * 1.08 * 1.07 + 1e-6);
  // Centred on the root's plane, off it only by the lobes of its section.
  c.check(
    `...and centred on the root's plane, to within its lobes (${fmt(zMin, 3)} .. ${fmt(zMax, 3)})`,
    Math.abs(zMin + zMax) <= 2 * 0.07 * depth,
  );
  const none = rootGeometry({ width: 0.1, verts: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }, { trunk: true, seed: 0 });
  c.check("a curve of no length grows nothing", none === null);
  return { name: "root-mesh - the drawn root is a closed tube as wide as its bar", passed: c.passed(), details: c.details };
}

// ---------------------------------------------------------------------------
// cuff - bitten into a root, the cuff is drawn in the root, and the chain runs
// from there to the ball on the plane.
// ---------------------------------------------------------------------------
function caseCuffDepth(): RootResult {
  const c = claims();
  // The playtest's own scene and inputs: the ball throws at the root above it
  // and hangs from it. 200 frames in it is swinging on the bite.
  const script = JSON.parse(
    readFileSync(new URL("../../playtests/ball-root-swing.json", import.meta.url), "utf8"),
  ) as PlaytestScript;
  const level = new BallLevel(scriptSpec(script).data);
  const input = new ScriptedInput(script);
  for (let f = 1; f <= 200; f++) level.physicsProcess(input.sample(f, level.ball.globalPosition), DT);
  const built = level.visualSource.built.bodies[0]!;
  const root = built.body!;
  c.check("the ball's cuff has bitten the root", level.ball.anchoredTo === root);
  // The depth the root is drawn at, by the visual that draws it.
  const visual = new BodyVisual(root, built);
  c.check(`the root is drawn behind the plane (${fmt(visual.depth, 3)} m)`, visual.depth < 0);
  const lay = (depthOf: (b: CollisionObject2D) => number): { cuff: number; links: number[] } => {
    const scene = new THREE.Scene();
    const chains = withCanvasStub(() => new ChainLayer(scene));
    chains.sync(level, 1, null, depthOf);
    const cuff = scene.children.find((o) => o instanceof THREE.Group && o.visible)!;
    const mesh = scene.children.find((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh)!;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const links: number[] = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      links.push(p.setFromMatrixPosition(m).z);
    }
    return { cuff: cuff.position.z, links };
  };
  const drawn = lay((b) => (b === root ? visual.depth : 0));
  c.check(`the cuff is drawn at the root's depth (${fmt(drawn.cuff, 4)} m)`, drawn.cuff === visual.depth);
  const first = drawn.links[0]!;
  const last = drawn.links[drawn.links.length - 1]!;
  const rising = drawn.links.every((z, i) => i === 0 || z >= drawn.links[i - 1]! - 1e-12);
  c.check(
    `the chain runs from beside it to the ball's plane (${drawn.links.length} links, ${fmt(first, 3)} .. ${fmt(last, 3)} m)`,
    first < visual.depth * 0.9 && first >= visual.depth && last > -0.02 && rising,
  );
  // The control: a body drawn on the plane leaves the cuff and chain there.
  const flat = lay(() => 0);
  c.check("bitten into a body on the plane, cuff and chain stay on it", flat.cuff === 0 && flat.links.every((z) => z === 0));
  visual.dispose();
  return { name: "root-cuff - bitten into a root, the cuff is drawn in it", passed: c.passed(), details: c.details };
}

// Run `make` with a stand-in `document` whose canvases take pixel writes and
// keep nothing, when there is no real one: the chain's iron generates its
// texture on a canvas (`canvasTexture`), and what is asserted here is where
// the chain is laid, which no texel decides.
function withCanvasStub<T>(make: () => T): T {
  const g = globalThis as { document?: unknown };
  if (g.document !== undefined) return make();
  const ctx = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  };
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  try {
    return make();
  } finally {
    delete g.document;
  }
}

export function runRootCases(): RootResult[] {
  return [caseStroke(), caseFormat(), caseHookOnly(), caseSpring(), caseTree(), caseLint(), caseMesh(), caseCuffDepth()];
}

