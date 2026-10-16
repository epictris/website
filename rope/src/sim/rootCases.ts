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
import { circleShape, isConvexLoop, polyArea, polyShapeCentred } from "../engine/shapes";
import { World } from "../engine/world";
import { buildLevelBodies } from "../level/buildBodies";
import { DEFAULT_ROOT_COLOR, isCollisionObject, scaleLevelData, type LevelBodyData, type RawLevelData } from "../level/levelFormat";
import { rootProblems } from "../level/roots";
import { curveLine, strokeCurve } from "../lib/stroke";
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
  setRootBark,
  type RootItem,
} from "../editor/rootEditing";
import { rootBarkMaterial, rootGeometry, rootCenterline } from "../render3d/rootMesh";
import { fuseRootForks } from "../render3d/rootFork";
import { buildRootMeshes, rootBuildReady, ROOT_SIMPLIFY_ERROR } from "../render3d/rootBuild";
import { rootMeshKey } from "../render3d/rootKey";
import { readRootBake } from "../render3d/rootBake";
import { encodeRootBake } from "../../scripts/rootBakeEncode";
import { levelStoredFiles } from "../render3d/levelAssets";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import type { CollisionObject2D } from "../engine/body";
import { BallLevel } from "../level/ballLevel";
import { ScriptedInput, scriptSpec, type PlaytestScript } from "./playtest";
import { BodyVisual } from "../render3d/bodyVisuals";
import { AVATAR_CHAIN_MESH, ChainLayer } from "../render3d/chainVisual";
import { Scene3D } from "../render3d/scene";

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

// ---------------------------------------------------------------------------
// fold - a bend tighter than the bar's half-width still strokes into pieces the
// build accepts.
// ---------------------------------------------------------------------------
// The root that stopped ball.json building (2026-10-15), as it was on disk in
// pixels: deleting points left the middle node with 2.8 px handles between
// neighbours 60-75 px away, so the cubic turns 33° within a few centimetres of
// a bar 8 cm wide there. The 5 cm sampling kept a 1.1 cm segment through the
// bend, the mitre lines at its two ends crossed 3.7 cm out on the inner side,
// inside the 4.06 cm half-width, and that quad folded into a concave one
// `polyShape` throws on.
const FOLDED_ROOT = {
  kind: "curve" as const,
  width: 16,
  tip: 2.5,
  verts: [
    { x: 36.666666666666714, y: -193.33333333333337 },
    {
      x: -10.583731669630136,
      y: -119.23126515127524,
      inX: -0.5584160749834588,
      inY: -2.737769379649424,
      outX: 0.5584160749834588,
      outY: 2.737769379649424,
    },
    {
      x: -8.33333333333357,
      y: -58.33333333333333,
      inX: 0.3328022182710555,
      inY: -1.197242423922562,
      outX: -0.665604436542111,
      outY: 2.394484847845113,
    },
  ],
};

function caseFold(): RootResult {
  const c = claims();
  const raw = {
    player: { x: 0, y: -300, radius: 8 },
    bodies: [{ kind: "static", passable: true, x: 0, y: 0, rot: 0, objects: [{ type: "collision", shape: FOLDED_ROOT, root: {} }] }],
  } as RawLevelData;
  let built: string | null = null;
  try {
    buildLevelBodies(new World(), scaleLevelData(raw, PX), () => {});
  } catch (err) {
    built = err instanceof Error ? err.message : String(err);
  }
  c.check(`the folded root builds (${built ?? "built"})`, built === null);

  const verts = FOLDED_ROOT.verts.map((v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x * PX])));
  const nodes = pathNodesOf(verts as typeof FOLDED_ROOT.verts);
  const stroke = strokeCurve(nodes, FOLDED_ROOT.width * PX, FOLDED_ROOT.tip * PX);
  const rejected = stroke.pieces.filter((p) => {
    try {
      polyShapeCentred(p);
      return false;
    } catch {
      return true;
    }
  });
  c.check(`...every piece is one the build accepts (${rejected.length} of ${stroke.pieces.length} refused)`, rejected.length === 0);
  const hw = stroke.halfWidths!;
  const tiled = stroke.pieces.reduce((a, p) => a + polyArea(p), 0);
  let integral = 0;
  for (let i = 0; i + 1 < stroke.line.length; i++) integral += (hw[i]! + hw[i + 1]!) * stroke.line[i]!.distanceTo(stroke.line[i + 1]!);
  c.check(`...and they tile the bar: ${fmt(tiled, 5)} m² against ${fmt(integral, 5)} m²`, near(tiled, integral, integral * 0.01));
  const line = curveLine(nodes, FOLDED_ROOT.width * PX, FOLDED_ROOT.tip * PX);
  c.check(
    `...the centreline the mesh reads is the one the pieces were built from (${line.length} / ${stroke.line.length} points)`,
    line.length === stroke.line.length && line.every((p, i) => p.x === stroke.line[i]!.x && p.y === stroke.line[i]!.y),
  );
  let worst = 0;
  for (let e = 0; e + 1 < nodes.length; e++) {
    const a = nodes[e]!;
    const b = nodes[e + 1]!;
    for (let k = 0; k <= 200; k++) {
      const p = cubicAt(a.p, a.p.add(a.out), b.p.add(b.in), b.p, k / 200);
      let d = Infinity;
      for (let i = 0; i + 1 < stroke.line.length; i++) d = Math.min(d, segDist(p, stroke.line[i]!, stroke.line[i + 1]!));
      worst = Math.max(worst, d);
    }
  }
  c.check(`...and its centreline keeps within a centimetre of the cubic (${fmt(worst * 1000, 2)} mm)`, worst <= 0.01);
  return { name: "root-fold - a bend tighter than the half-width strokes into pieces the build accepts", passed: c.passed(), details: c.details };
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
  setRootBark(model, [model.items.find(isRootItem)!], "broad");
  const disk = modelToDisk(model);
  const rootFiles = levelStoredFiles(disk).filter(f => f.file.includes("painted-root"));
  c.check("preloading fetches only the chosen bark variant", rootFiles.length === 1 && rootFiles[0]!.file.endsWith("painted-root-broad-base.webp"));
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
  c.check("bark choice survives save, load and unit scaling on every branch", metres.bodies[0]!.objects
    .filter(isCollisionObject).filter(o => o.root).every(o => o.root!.bark === "broad"));
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
  setRootBark(model, [branch], "original");
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
  c.check("sliding a join retains the chosen bark on the whole root", [trunk, branch, twig].every(i => i.root.bark === "original"));
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
  setRootBark(model, [branch], "broad");
  c.check("changing a separated root does not recolour another body", branch.root.bark === "broad" && trunk.root.bark === "original" && twig.root.bark === "original");
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
  // Find each duplicated UV seam without pinning the tessellation count.
  const uv = g.getAttribute("uv"), age = g.getAttribute("rootAge");
  let seam = true, unit = true, first = 0;
  for (let i = 0; i < pos.count; i++) {
    unit &&= Math.abs(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) - 1) < 1e-5;
    if (i + 1 === pos.count || uv.getY(i + 1) !== uv.getY(i)) {
      seam &&= Math.abs(pos.getX(i) - pos.getX(first)) < 1e-6
        && Math.abs(pos.getY(i) - pos.getY(first)) < 1e-6
        && Math.abs(pos.getZ(i) - pos.getZ(first)) < 1e-6
        && Math.abs(nrm.getX(i) - nrm.getX(first)) < 1e-6
        && Math.abs(nrm.getY(i) - nrm.getY(first)) < 1e-6
        && Math.abs(nrm.getZ(i) - nrm.getZ(first)) < 1e-6
        && Math.abs(uv.getX(i) - uv.getX(first) - 1) < 1e-6;
      first = i + 1;
    }
  }
  c.check("the bark wrap closes in both position and normal, exactly one UV turn apart", seam);
  c.check("fluted surface normals stay unit length, including the caps", unit);
  c.check("the thin tip wears younger skin than the woody base", age.getX(0) > 0.9 && age.getX(pos.count - 1) < 0.1);
  g.dispose();
  return { name: "root-mesh - the drawn root is a closed tube as wide as its bar", passed: c.passed(), details: c.details };
}

function caseBark(): RootResult {
  const c = claims();
  const bark = rootBarkMaterial(DEFAULT_ROOT_COLOR);
  const custom = rootBarkMaterial("#8b785f");
  c.check("variant materials are isolated and reused by variant and tint", rootBarkMaterial(DEFAULT_ROOT_COLOR, "original") !== bark
    && rootBarkMaterial(DEFAULT_ROOT_COLOR, "broad") !== bark
    && rootBarkMaterial(DEFAULT_ROOT_COLOR, "broad") === rootBarkMaterial(DEFAULT_ROOT_COLOR, "broad"));
  c.check("roots share texture storage across body colours", bark.map === custom.map
    && bark.normalMap === custom.normalMap && bark.roughnessMap === custom.roughnessMap);
  c.check("custom tint never mutates the default material", bark !== custom
    && bark === rootBarkMaterial(DEFAULT_ROOT_COLOR) && bark.color.equals(new THREE.Color(1, 1, 1)));
  c.check("albedo is colour data; relief and roughness are linear data", bark.map!.colorSpace === THREE.SRGBColorSpace
    && bark.normalMap!.colorSpace === THREE.NoColorSpace && bark.roughnessMap!.colorSpace === THREE.NoColorSpace);
  const map = bark.map as THREE.DataTexture;
  const { width, height } = map.image;
  const data = map.image.data!;
  // A tile edge should be no more conspicuous than nearby texel transitions.
  // Check both axes; exact duplicate edge texels are not required for a repeat.
  let edge = 0, interior = 0;
  for (let y = 0; y < height; y++) for (let channel = 0; channel < 3; channel++) {
    edge += Math.abs(data[(y * width) * 4 + channel]! - data[(y * width + width - 1) * 4 + channel]!);
    interior += Math.abs(data[(y * width + 1) * 4 + channel]! - data[y * width * 4 + channel]!);
  }
  for (let x = 0; x < width; x++) for (let channel = 0; channel < 3; channel++) {
    edge += Math.abs(data[x * 4 + channel]! - data[((height - 1) * width + x) * 4 + channel]!);
    interior += Math.abs(data[(width + x) * 4 + channel]! - data[x * 4 + channel]!);
  }
  c.check(`texture boundaries are continuous at texel scale (${fmt(edge / Math.max(1, interior), 2)}× adjacent variation)`, edge < interior * 2 + 1);
  c.check("grain repeats with mipmapping for distant roots", map.wrapS === THREE.RepeatWrapping
    && map.wrapT === THREE.RepeatWrapping && map.generateMipmaps && map.minFilter === THREE.LinearMipmapLinearFilter);
  return { name: "root-bark - shared painted maps wrap cleanly and preserve authored tint", passed: c.passed(), details: c.details };
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
    const mesh = scene.children.find(
      (o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh && o.name === AVATAR_CHAIN_MESH,
    )!;
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

export async function runRootCases(): Promise<RootResult[]> {
  await rootBuildReady;
  return [caseStroke(), caseFold(), caseFormat(), caseHookOnly(), caseSpring(), caseTree(), caseLint(), caseMesh(), caseBark(), caseOrganicFork(), caseCuffDepth(), caseBarkHighlight(),
    caseSimplify(), caseKey(), await caseBake(), caseRestyle()];
}

// ---------------------------------------------------------------------------
// restyle - the editor's in-place rebuild of a root draws from the cache: a
// recolour keeps the geometry and swaps the material, a reshape grows anew.
// ---------------------------------------------------------------------------
function caseRestyle(): RootResult {
  const c = claims();
  const data = scaleLevelData(rootLevel(), PX);
  const built = buildLevelBodies(new World(), data, () => {}).bodies[0]!;
  const visual = new BodyVisual(built.body, built);
  const drawn = (): THREE.Mesh[] => {
    const out: THREE.Mesh[] = [];
    visual.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.getAttribute("rootAge")) out.push(o as THREE.Mesh);
    });
    return out;
  };
  const first = drawn();
  c.check(`the root is drawn on build (${first.length} mesh)`, first.length === 1);
  // Placed in the world: the drawn mesh's bounds, in world space, centre on
  // the authored curve's middle (the body is at the origin, unrotated). The
  // visual stands at its body's pose once synced, as every frame does.
  visual.sync(1);
  visual.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(first[0]!);
  const middle = box.getCenter(new THREE.Vector3());
  c.check(`placed where the curve is (centre ${fmt(middle.x, 3)}, ${fmt(middle.y, 3)})`, middle.x > 0.4 && middle.x < 1.2 && middle.y < 0 && middle.y > -0.8);
  const recoloured = structuredClone(built.data);
  recoloured.color = "#40607a";
  c.check("a recolour rebuilds in place", visual.restyleDebug(recoloured));
  const after = drawn();
  c.check("...with the same geometry and a new material",
    after.length === 1 && after[0]!.geometry === first[0]!.geometry && after[0]!.material !== first[0]!.material);
  const reshaped = structuredClone(recoloured);
  const curve = reshaped.objects.find((o) => isCollisionObject(o) && o.root) as { shape: { verts: { x: number }[] } };
  curve.shape.verts[1]!.x += 0.2;
  c.check("a reshape rebuilds in place", visual.restyleDebug(reshaped));
  const regrown = drawn();
  c.check("...with new geometry", regrown.length === 1 && regrown[0]!.geometry !== first[0]!.geometry);
  c.check("back to the first shape, the first geometry comes back from the cache", visual.restyleDebug(recoloured) && drawn()[0]?.geometry === first[0]!.geometry);
  visual.dispose();
  c.check("disposed, nothing is drawn", drawn().length === 0);
  return { name: "root-restyle - the editor's in-place rebuild draws from the shared cache", passed: c.passed(), details: c.details };
}

// A two-branch body in metres: a trunk with a branch grown out of it half way.
function forkBody(): LevelBodyData {
  return {
    x: 1, y: 2, rot: 0.3, kind: "static", passable: true,
    objects: [
      { type: "collision", x: 0, y: 0, shape: { kind: "curve", width: 0.12, tip: 0.04, verts: [{ x: 0, y: 0, outX: 0.2 }, { x: 0.7, y: 0.15 }] }, root: {} },
      { type: "collision", x: 0, y: 0, shape: { kind: "curve", width: 0.06, tip: 0.02, verts: [{ x: 0.35, y: 0.08 }, { x: 0.5, y: -0.25 }] }, root: { parent: 0, at: 0.5 } },
    ],
  } as unknown as LevelBodyData;
}

// Every corner of a mesh's triangles, by index or in order.
function trianglesOf(g: THREE.BufferGeometry): number[][] {
  const index = g.getIndex();
  const count = index ? index.count : g.getAttribute("position").count;
  const out: number[][] = [];
  for (let t = 0; t < count; t += 3) out.push([0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k)));
  return out;
}

// The distance from `p` to the nearest of a mesh's triangles.
function distanceToMesh(p: THREE.Vector3, g: THREE.BufferGeometry, matrix?: THREE.Matrix4): number {
  const pos = g.getAttribute("position");
  const tri = new THREE.Triangle(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), q = new THREE.Vector3();
  let best = Infinity;
  for (const [i, j, k] of trianglesOf(g)) {
    a.fromBufferAttribute(pos, i!); b.fromBufferAttribute(pos, j!); c.fromBufferAttribute(pos, k!);
    if (matrix) { a.applyMatrix4(matrix); b.applyMatrix4(matrix); c.applyMatrix4(matrix); }
    tri.set(a, b, c).closestPointToPoint(p, q);
    best = Math.min(best, q.distanceTo(p));
  }
  return best;
}

// ---------------------------------------------------------------------------
// simplify - the drawn root is the grown one, simplified within its error,
// and still one closed surface across the fork.
// ---------------------------------------------------------------------------
function caseSimplify(): RootResult {
  const c = claims();
  const body = forkBody();
  const simplified = buildRootMeshes(body);
  // The same growth, unsimplified, in the same frame.
  const grown = new Map<number, THREE.BufferGeometry>();
  body.objects.forEach((o, i) => {
    if (!isCollisionObject(o) || o.shape.kind !== "curve" || !o.root) return;
    const g = rootGeometry(o.shape, { trunk: o.root.parent === undefined, seed: i })!;
    g.rotateZ(-body.rot);
    const p = new Vec2(body.x, body.y);
    g.translate(p.x, -p.y, 0);
    grown.set(i, g);
  });
  const fused = fuseRootForks(grown, new Map([[1, 0]]));
  const count = (set: Map<number, THREE.BufferGeometry>): number => [...set.values()].reduce((n, g) => n + trianglesOf(g).length, 0);
  const before = count(fused), after = count(simplified);
  // A short fixture keeps a larger share than a level's long roots do
  // (ball.json keeps 22%).
  c.check(`simplified to under half the grown triangles (${before} -> ${after})`, after > 0 && after * 2 < before);
  // Every grown vertex lies within the error of the simplified surface (with
  // slack for the error being measured by the simplifier's own metric).
  let worst = 0;
  const p = new THREE.Vector3();
  for (const [i, g] of fused) {
    const pos = g.getAttribute("position");
    for (let v = 0; v < pos.count; v += 7) worst = Math.max(worst, distanceToMesh(p.fromBufferAttribute(pos, v), simplified.get(i)!));
  }
  c.check(`the simplified surface stays within ${ROOT_SIMPLIFY_ERROR * 1000} mm of the grown one (worst ${fmt(worst * 1000, 3)} mm)`, worst <= ROOT_SIMPLIFY_ERROR * 1.5);
  // Closed: every edge, by position, has exactly two triangles across both
  // branches' meshes - the cut between them held where it was.
  const edges = new Map<string, number>();
  let degenerate = 0;
  for (const g of simplified.values()) {
    const pos = g.getAttribute("position");
    const point = (i: number): string => [pos.getX(i), pos.getY(i), pos.getZ(i)].map((v) => Math.round(v * 1e7)).join(",");
    for (const tri of trianglesOf(g)) {
      const keys = tri.map(point);
      if (new Set(keys).size < 3) { degenerate++; continue; }
      for (let k = 0; k < 3; k++) {
        const a = keys[k]!, b = keys[(k + 1) % 3]!;
        const key = a < b ? `${a}/${b}` : `${b}/${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
  }
  const open = [...edges.values()].filter((n) => n !== 2).length;
  c.check(`the simplified fork is still one closed surface (${open} unmatched edges, ${degenerate} degenerate)`, open === 0);
  const attributes = ["position", "normal", "uv", "color", "rootAge", "rootJoin"];
  c.check("every attribute the bark reads survives", [...simplified.values()].every((g) => attributes.every((a) => g.getAttribute(a))));
  return { name: "root-simplify - the drawn root is the grown one within its error, still closed", passed: c.passed(), details: c.details };
}

// ---------------------------------------------------------------------------
// key - what a body's root meshes are known by (in the cache and the bake).
// ---------------------------------------------------------------------------
function caseKey(): RootResult {
  const c = claims();
  const body = forkBody();
  const key = rootMeshKey(body);
  const edit = (change: (b: LevelBodyData) => void): string => {
    const b = structuredClone(body);
    change(b);
    return rootMeshKey(b);
  };
  c.check(`a body with roots has a 16-digit key (${key})`, /^[0-9a-f]{16}$/.test(key));
  c.check("the same body has the same key", rootMeshKey(structuredClone(body)) === key);
  c.check("colour and bark are the material's, not the mesh's", edit((b) => {
    b.color = "#ff0000";
    (b.objects[0] as { root: { bark?: string } }).root.bark = "broad";
  }) === key);
  c.check("a node moved is a different mesh", edit((b) => {
    ((b.objects[0] as { shape: { verts: { x: number }[] } }).shape.verts[1]!).x += 0.01;
  }) !== key);
  c.check("the body moved is a different mesh (it is grown in the world)", edit((b) => { b.x += 0.5; }) !== key);
  c.check("a branch made a trunk is a different mesh", edit((b) => { (b.objects[1] as { root: object }).root = {}; }) !== key);
  c.check("a body with no roots has none", edit((b) => { b.objects = []; }) === "");
  return { name: "root-key - a body's root meshes are known by what they are grown from", passed: c.passed(), details: c.details };
}

// ---------------------------------------------------------------------------
// bake - a bake read back through the game's loader is the build it was made
// from, within its quantisation.
// ---------------------------------------------------------------------------
async function caseBake(): Promise<RootResult> {
  const c = claims();
  const body = forkBody();
  const key = rootMeshKey(body);
  const built = buildRootMeshes(body);
  const bytes = await encodeRootBake("case", [{ key, meshes: built }]);
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ]);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
  const found = readRootBake(gltf.scene);
  const set = found.get(key);
  c.check(`the bake (${(bytes.byteLength / 1024).toFixed(0)} KB) holds the body under its key`, set !== undefined);
  if (!set) return { name: "root-bake - a bake read back is the build it was made from", passed: false, details: c.details };
  c.check("...with every branch", [...built.keys()].every((i) => set.has(i)) && set.size === built.size);
  let worstPosition = 0, worstNormal = 0, worstUv = 0, sameTriangles = true;
  const v = new THREE.Vector3(), n = new THREE.Vector3(), w = new THREE.Vector3();
  for (const [i, original] of built) {
    const baked = set.get(i)!;
    const matrix = baked.matrix ?? new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    sameTriangles &&= trianglesOf(baked.geometry).length === trianglesOf(original).length;
    // The bake reorders vertices for the GPU, so each is compared with the
    // original vertex at its position.
    const pos = original.getAttribute("position"), nor = original.getAttribute("normal"), uv = original.getAttribute("uv");
    const bpos = baked.geometry.getAttribute("position"), bnor = baked.geometry.getAttribute("normal"), buv = baked.geometry.getAttribute("uv");
    const byPosition = new Map<string, number>();
    const cell = (p: THREE.Vector3): string => [p.x, p.y, p.z].map((x) => Math.round(x * 2e4)).join(",");
    for (let k = 0; k < pos.count; k++) byPosition.set(cell(v.fromBufferAttribute(pos, k)), k);
    for (let k = 0; k < bpos.count; k++) {
      v.fromBufferAttribute(bpos, k).applyMatrix4(matrix);
      let match = byPosition.get(cell(v));
      if (match === undefined) {
        // Nearest by search when quantisation crossed a cell boundary.
        let best = Infinity;
        for (let o = 0; o < pos.count; o++) {
          const d = w.fromBufferAttribute(pos, o).distanceToSquared(v);
          if (d < best) { best = d; match = o; }
        }
      }
      worstPosition = Math.max(worstPosition, w.fromBufferAttribute(pos, match!).distanceTo(v));
      n.fromBufferAttribute(bnor, k).applyMatrix3(normalMatrix).normalize();
      worstNormal = Math.max(worstNormal, n.angleTo(w.fromBufferAttribute(nor, match!)));
      // U is compared a turn apart: at the bark's wrap one position is two
      // vertices, U a whole turn apart, and either may be the one found.
      const du = buv.getX(k) - uv.getX(match!);
      worstUv = Math.max(worstUv, Math.abs(du - Math.round(du)), Math.abs(buv.getY(k) - uv.getY(match!)));
    }
  }
  c.check("the same triangles", sameTriangles);
  c.check(`positions within a twentieth of a millimetre (worst ${fmt(worstPosition * 1000, 4)} mm)`, worstPosition < 5e-5);
  c.check(`normals within a degree (worst ${fmt(THREE.MathUtils.radToDeg(worstNormal), 3)} deg)`, worstNormal < THREE.MathUtils.degToRad(1));
  c.check(`bark coordinates exact (worst ${worstUv})`, worstUv < 1e-6);
  const ages = [...set.values()].every((p) => p.geometry.getAttribute("rootAge") && p.geometry.getAttribute("rootJoin"));
  c.check("the bark's own attributes arrive under the names its shader reads", ages);
  return { name: "root-bake - a bake read back is the build it was made from", passed: c.passed(), details: c.details };
}

function caseBarkHighlight(): RootResult {
  const c = claims(), scene = new THREE.Scene(), tag = {};
  const source = new THREE.MeshStandardMaterial(), mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
  mesh.userData.pickTag = tag; scene.add(mesh);
  // Exercise the selection logic without a WebGL context. The texture arrives
  // after selection, as it does the first time an editor variant is chosen.
  const preview = Object.create(Scene3D.prototype) as Scene3D;
  const clones = new Map<string, THREE.Material>();
  Object.assign(preview, { scene, editorLayer: new THREE.Group(), highlighted: new Map(), highlightMaterials: clones });
  const sync = () => (preview as unknown as { syncHighlight(): void }).syncHighlight();
  preview.setHighlight(new Map([[tag, "#ffaa00"]])); sync();
  const before = mesh.material;
  source.map = new THREE.Texture(); source.needsUpdate = true; sync();
  c.check("a selected root refreshes its highlight when the authored texture arrives", mesh.material !== before && mesh.material.map === source.map);
  const loaded = mesh.material; sync();
  c.check("a loaded highlighted material is reused on subsequent frames", mesh.material === loaded);
  preview.setHighlight(new Map()); sync();
  c.check("deselecting restores the loaded source material", mesh.material === source);
  for (const m of clones.values()) m.dispose();
  source.map.dispose(); source.dispose(); mesh.geometry.dispose();
  return { name: "root-bark-highlight - asynchronous variant loading stays visible while selected", passed: c.passed(), details: c.details };
}

function caseOrganicFork(): RootResult {
  const c = claims();
  const corner = { width: 0.12, tip: 0.05, verts: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }] };
  const before = JSON.stringify(corner);
  const line = rootCenterline(corner, 0);
  let abrupt = 0;
  for (let i = 1; i + 1 < line.length; i++) {
    const a = line[i]!.sub(line[i - 1]!).normalized(), b = line[i + 1]!.sub(line[i]!).normalized();
    if (a.dot(b) < 0.95) abrupt++;
  }
  c.check("a right-angle authoring corner becomes a continuously turning visual spine", abrupt === 0);
  c.check("rounding preserves endpoints and never rewrites the collision curve", JSON.stringify(corner) === before && line[0]!.distanceTo(new Vec2(0, 0)) < 1e-9 && line.at(-1)!.distanceTo(new Vec2(0.5, 0.5)) < 1e-9);
  const parent = rootGeometry({ width: 0.12, tip: 0.06, verts: [{ x: 0, y: 0 }, { x: 0.6, y: 0 }] }, { trunk: true, seed: 0 })!;
  const child = rootGeometry({ width: 0.065, tip: 0.025, verts: [{ x: 0.3, y: 0 }, { x: 0.48, y: -0.28 }] }, { trunk: false, seed: 1 })!;
  const meshes = fuseRootForks(new Map([[0, parent], [1, child]]), new Map([[1, 0]]));
  c.check("the fused surface retains both authored branch identities for picking", meshes.has(0) && meshes.has(1));
  const edges = new Map<string, number>();
  let invalid = 0;
  let grainJumps = 0, joinedVertices = 0;
  for (const g of meshes.values()) {
    const p = g.getAttribute("position"), n = g.getAttribute("normal");
    const uv = g.getAttribute("uv"), join = g.getAttribute("rootJoin");
    const point = (i: number): string => [p.getX(i), p.getY(i), p.getZ(i)].map(v => Math.round(v * 1e7)).join(",");
    for (let i = 0; i < p.count; i++) {
      const norm = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i) + norm) || norm < 0.99 || norm > 1.01) invalid++;
      if (join.getX(i) > 0.5) joinedVertices++;
    }
    const index = g.getIndex();
    const corner = (t: number): number => (index ? index.getX(t) : t);
    const corners = index ? index.count : p.count;
    for (let t = 0; t < corners; t += 3) {
      const tri = [corner(t), corner(t + 1), corner(t + 2)];
      const vertices = tri.map(point);
      for (let k = 0; k < 3; k++) {
        const ia = tri[k]!, ib = tri[(k + 1) % 3]!;
        const length = Math.hypot(p.getX(ia) - p.getX(ib), p.getY(ia) - p.getY(ib), p.getZ(ia) - p.getZ(ib));
        if (length < 0.015 && Math.abs(uv.getY(ia) - uv.getY(ib)) > 0.06) grainJumps++;
        const a = vertices[k]!, b = vertices[(k + 1) % 3]!;
        const key = a < b ? `${a}/${b}` : `${b}/${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    g.dispose();
  }
  const open = [...edges.values()].filter(count => count !== 2).length;
  c.check(`the fork is one closed surface, with no open join or buried caps (${open} unmatched edges)`, open === 0);
  c.check("the blended fork has finite vertices and unit shading normals", invalid === 0);
  c.check(`the grain has no phase jump across the fork (${grainJumps} short edges with discontinuous grain)`, grainJumps === 0);
  c.check("the saddle carries a local shading transition", joinedVertices > 0);
  return { name: "root-organic-fork - rounded growth and a continuous pickable junction", passed: c.passed(), details: c.details };
}

