// LedgeDetection — the single source of truth for "which corners can the
// player grab right now" (game-design.md, vertex angles and ledge candidates).
// Used by the player states (grab decisions), and by the debug overlay so the
// visualization can never drift from the sim.
//
// Detection is vertex-first: instead of firing a thin ray and snapping the hit
// to the nearest vertex (speed- and angle-sensitive), the query walks every
// candidate vertex and tests it against the player's swept path for the
// current frame. No ray, no tunnelling at any speed.

import { Vec2 } from "../engine/vec2";
import { PX } from "../engine/units";
import { PhysicsBody2D, RigidBody2D } from "../engine/body";
import { circleOverlap } from "../engine/collision";
import { PhysTrace } from "../engine/physTrace";
import { ShapeGeometry } from "./shapeGeometry";
import { Surface } from "./surface";
import { SurfaceType } from "./types";

// Extra reach beyond the player radius for the swept grab test (px) —
// covers lateral near-misses; the swept segment covers fast approaches.
// Also sets the hang rest depth (centre on the grab-radius edge).
export const GRAB_REACH_MARGIN = 0.05;

// A vertex sitting this deep on/inside another blocking body is a
// compound-body seam (game-design.md) — never grabbable.
const SEAM_EPSILON = 0.005;

// Everything the states need to grab a corner. Normals are the *current*
// world-space face normals — recompute via grabInfo every frame for movers.
export interface LedgeGrabInfo {
  vertex: Vec2; // world position of the corner
  wallNormal: Vec2; // outward normal of the face the player hangs against
  floorNormal: Vec2; // outward normal of the walkable top face
}

export interface LedgeGrab extends LedgeGrabInfo {
  body: PhysicsBody2D;
  vertexIndex: number;
}

export interface GrabQuery {
  // Swept player path for this frame, oldest position first. The query tests
  // each vertex against every segment of the path.
  path: Vec2[];
  // Reach radius around the path (player radius + margin).
  reach: number;
  // Required sign of wallNormal.x — which side the player hangs on
  // (-xInputDirection for input-toward-wall grabs).
  wallNormalXSign: number;
}

// How far below the player's centre a corner may sit and still count as
// reachable (px). Corners below centre are never grab targets — flying or
// jumping past a lip must not yank the player down onto it. A fast fall
// still catches: on the frame it passes the corner, the corner ends up above
// centre and the frame's swept segment reaches back to it.
const BELOW_TOLERANCE = 0.02;

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = b.sub(a);
  const lenSq = ab.dot(ab);
  if (lenSq === 0) return p.distanceTo(a);
  const t = Math.max(0, Math.min(1, p.sub(a).dot(ab) / lenSq));
  return p.distanceTo(a.add(ab.mul(t)));
}

function pathDistance(vertex: Vec2, path: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    best = Math.min(best, pointSegmentDistance(vertex, path[i]!, path[i + 1]!));
  }
  if (path.length === 1) best = vertex.distanceTo(path[0]!);
  return best;
}

export const LedgeDetection = {
  // Candidacy + reachability for one vertex: interior angle at/below the grab
  // threshold, one incident face currently a floor (the top), the other a
  // wall (the hang face). Null when the corner is not grabbable this frame.
  // Seam occlusion is a separate, body-set-dependent test (isSeamOccluded).
  grabInfo(body: PhysicsBody2D, vertexIndex: number): LedgeGrabInfo | null {
    if (!body.hasShape()) return null;
    const t = body.getShape();
    if (t.shape.kind !== "rect") return null; // circles are never grabbable
    if (!ShapeGeometry.isLedgeCandidate(t.shape, vertexIndex)) return null;

    const [a, b] = ShapeGeometry.getIncidentFaceNormals(t, vertexIndex);
    const aType = Surface.getSurfaceType(a, body.isRotating);
    const bType = Surface.getSurfaceType(b, body.isRotating);
    let floorNormal: Vec2;
    let wallNormal: Vec2;
    if (aType === SurfaceType.FLOOR && bType === SurfaceType.WALL) {
      floorNormal = a;
      wallNormal = b;
    } else if (bType === SurfaceType.FLOOR && aType === SurfaceType.WALL) {
      floorNormal = b;
      wallNormal = a;
    } else {
      return null; // no walkable top, or no face to hang against
    }
    return {
      vertex: ShapeGeometry.getVertexWorldPosition(t, vertexIndex),
      wallNormal,
      floorNormal,
    };
  },

  // Compound-body seam filter (game-design.md): a vertex lying on/inside
  // another blocking body is an interior seam corner, not a real ledge.
  // Rigid debris (circles) is ignored — a ball resting on a lip must not
  // switch the ledge off.
  isSeamOccluded(bodies: readonly PhysicsBody2D[], owner: PhysicsBody2D, vertex: Vec2): boolean {
    for (const body of bodies) {
      if (body === owner || body.removed || !body.hasShape()) continue;
      if (body instanceof RigidBody2D) continue;
      if (!(body instanceof PhysicsBody2D)) continue;
      if (circleOverlap(vertex, SEAM_EPSILON, body.getShape())) return true;
    }
    return false;
  },

  // The nearest grabbable corner along the player's swept path, or null.
  // `bodies` is the level body list; the player itself carries a circle shape
  // and self-filters via grabInfo.
  findGrab(bodies: readonly PhysicsBody2D[], query: GrabQuery): LedgeGrab | null {
    const current = query.path[query.path.length - 1]!;
    let best: LedgeGrab | null = null;
    let bestDist = query.reach;

    for (const body of bodies) {
      if (body.removed || !body.hasShape()) continue;
      const t = body.getShape();
      if (t.shape.kind !== "rect") continue;
      const vertexCount = ShapeGeometry.getLocalVertices(t.shape).length;

      for (let vi = 0; vi < vertexCount; vi++) {
        const info = LedgeDetection.grabInfo(body, vi);
        if (!info) continue;
        const dist = pathDistance(info.vertex, query.path);
        const near = dist <= query.reach * 2; // near-miss tracing window
        const miss = (reason: string): void => {
          if (near && PhysTrace.enabled) {
            PhysTrace.emit({ t: "ledge", event: "miss", reason, d: Math.round(dist) });
          }
        };
        if (info.wallNormal.x * query.wallNormalXSign <= 0) {
          miss("wrong-side");
          continue;
        }
        if (info.vertex.y > current.y + BELOW_TOLERANCE) {
          miss("below-player");
          continue;
        }
        // Never grab through the body: the player must be outside at least
        // one of the corner's incident face half-planes. Only the interior
        // region (behind the wall face AND under the floor face) is rejected
        // — "above a tilted corner" is a legitimate approach.
        const toPlayer = current.sub(info.vertex);
        if (toPlayer.dot(info.wallNormal) < -PX && toPlayer.dot(info.floorNormal) < -PX) {
          miss("behind-wall");
          continue;
        }
        if (dist > bestDist) {
          miss("out-of-reach");
          continue;
        }
        if (LedgeDetection.isSeamOccluded(bodies, body, info.vertex)) {
          miss("seam");
          continue;
        }
        bestDist = dist;
        best = { ...info, body, vertexIndex: vi };
      }
    }

    if (best && PhysTrace.enabled) {
      PhysTrace.emit({
        t: "ledge",
        event: "grab",
        v: best.vertexIndex,
        at: [Math.round(best.vertex.x), Math.round(best.vertex.y)],
      });
    }
    return best;
  },

  // Direction along the wall face pointing away from the top face — the
  // direction the player's body hangs in.
  hangDirection(info: LedgeGrabInfo): Vec2 {
    const along = info.wallNormal.orthogonal();
    return along.dot(info.floorNormal) < 0 ? along : along.neg();
  },

  // Depth below the corner (along the hang face) of the rest pose: the
  // player's centre sits exactly on the edge of the grab radius.
  hangRestDepth(playerRadius: number): number {
    const lateralArm = playerRadius + PX;
    const reach = playerRadius + GRAB_REACH_MARGIN;
    return Math.sqrt(Math.max(0, reach * reach - lateralArm * lateralArm));
  },

  // Player-centre rest position while hanging: against the wall face, centre
  // exactly on the grab-radius edge — identical for every kind of catch.
  hangPosition(info: LedgeGrabInfo, playerRadius: number): Vec2 {
    return info.vertex
      .add(info.wallNormal.mul(playerRadius + PX))
      .add(LedgeDetection.hangDirection(info).mul(LedgeDetection.hangRestDepth(playerRadius)));
  },

  // Player-center target after a climb: resting on the top face, inset past
  // the corner.
  climbTarget(info: LedgeGrabInfo, playerRadius: number): Vec2 {
    return info.vertex
      .add(info.floorNormal.mul(playerRadius + PX))
      .sub(info.wallNormal.mul(playerRadius + PX));
  },
};
