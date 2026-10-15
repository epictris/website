// What a level's ROOTS must be to be the trees the editor drew (docs/roots.md),
// asked of the data alone: no world built, nothing drawn.
//
// A root is tapered curves in a body (`CollisionObjectData.root`), and the sim
// needs nothing more of it - a branch collides as its own curve wherever its
// nodes put it. What the tree adds is authoring: a branch names the piece it
// grows out of and how far along it, and its first node is meant to sit
// exactly there (`syncRoots` in the editor keeps it so). A hand-edited file,
// or a merge of two that each moved one end, can break that silently: the
// branch still builds, and the gap at its base shows only in 3D, as a root
// floating off the one it grows from. So it is checked, by `cli levels`.

import { Vec2 } from "../engine/vec2";
import { buildPolylineIndex, pathNodesOf, pointAtArcLength } from "../lib/path";
import { curveLine } from "../lib/stroke";
import { worldPlacement } from "./buildBodies";
import {
  isCollisionObject,
  type CollisionObjectData,
  type LevelBodyData,
  type SceneObjectData,
} from "./levelFormat";

// How far a branch's first node may sit from its junction, metres - a
// millimetre, which is float noise from the editor's own round trip and
// nothing an eye could find.
export const ROOT_JUNCTION_TOLERANCE = 0.001;

type RootPiece = CollisionObjectData & { shape: Extract<CollisionObjectData["shape"], { kind: "curve" }> };

function isRootPiece(o: SceneObjectData | undefined): o is RootPiece {
  return o !== undefined && isCollisionObject(o) && o.root !== undefined && o.shape.kind === "curve";
}

// Every way `body`'s roots fail to be trees, as sentences; empty for a body
// whose roots hold together (or that has none). `body` is in metres - the
// junction is measured on the very centreline the build strokes, whose
// simplification is a metric tolerance.
export function rootProblems(body: LevelBodyData): string[] {
  const out: string[] = [];
  body.objects.forEach((o, i) => {
    if (!isCollisionObject(o) || o.root === undefined) return;
    if (o.shape.kind !== "curve") {
      out.push(`object ${i} is a root but a ${o.shape.kind}, not a curve`);
      return;
    }
    if (o.shape.tip !== undefined && !(o.shape.tip > 0)) out.push(`root ${i} has a tip of ${o.shape.tip}`);
    const { parent, at } = o.root;
    if (parent === undefined) return;
    const p = body.objects[parent];
    if (parent === i || !isRootPiece(p)) {
      out.push(`root ${i} grows out of object ${parent}, which is not another root in its body`);
      return;
    }
    if (at === undefined || !(at >= 0 && at <= 1)) {
      out.push(`root ${i} grows ${at ?? "nowhere"} along its parent; it must be a fraction 0..1`);
      return;
    }
    // A loop: following parents from here comes back here.
    const seen = new Set<number>([i]);
    for (let k: number | undefined = parent; k !== undefined; ) {
      if (seen.has(k)) {
        out.push(`root ${i} is in a loop of parents`);
        return;
      }
      seen.add(k);
      const up: SceneObjectData | undefined = body.objects[k];
      k = isRootPiece(up) ? up.root?.parent : undefined;
    }
    const junction = rootPoint(body, p, at);
    const place = worldPlacement(body, o);
    const v = o.shape.verts[0];
    if (!v) return;
    const first = place.pos.add(new Vec2(v.x, v.y).rotated(place.rot));
    const gap = first.distanceTo(junction);
    if (gap > ROOT_JUNCTION_TOLERANCE) {
      out.push(`root ${i}'s first node is ${(gap * 100).toFixed(1)} cm off its junction on root ${parent}`);
    }
  });
  return out;
}

// The world point `at` (a fraction of the arc length) along a root piece's
// collision centreline.
export function rootPoint(body: LevelBodyData, o: RootPiece, at: number): Vec2 {
  const place = worldPlacement(body, o);
  const line = curveLine(pathNodesOf(o.shape.verts), o.shape.width, o.shape.tip).map((p) =>
    place.pos.add(p.rotated(place.rot)),
  );
  const ix = buildPolylineIndex(line);
  return pointAtArcLength(ix, Math.min(1, Math.max(0, at)) * ix.total);
}
