// The model edits `+ Rock` and `+ Mushrooms` make, as pure functions of the
// items they read, so the `generator:` cases can hold what a click adds without
// an editor around it. The editor wraps each in one `beginAction` / `markDirty`.

import * as THREE from "three";
import { Vec2 } from "../../engine/vec2";
import { threeY } from "../../render3d/space";
import { cloneShape, defaultVisual, type EdItem } from "../model";
import { loadSchema } from "./paramSchema";
import { patchMatrix, worldToLoopPoint, type ObjectPose } from "./surfacePatch";

// The collision outline a rock is fitted to, from what was clicked: a scene
// collision polygon or rect itself, or the geometry object matched to one.
// Null for anything else (a circle, a curve, a belt, an area's outline is fine
// as long as it is a polygon or rect - the rock is only a look).
export function rockSource(items: readonly EdItem[], clicked: EdItem): EdItem | null {
  const source =
    clicked.object === "collision"
      ? clicked
      : clicked.object === "geometry" && clicked.matchId !== 0
        ? (items.find((i) => i.id === clicked.matchId && i.object === "collision") ?? null)
        : null;
  if (!source || source.layer !== "scene") return null;
  return source.shape.kind === "poly" || source.shape.kind === "rect" ? source : null;
}

// The rock already dressing `source`, if it has one: a geometry object matched
// to it that carries a boulder block. `+ Rock` on it again selects that rock
// rather than stacking a second.
export function existingRock(items: readonly EdItem[], source: EdItem): EdItem | null {
  return (
    items.find(
      (i) =>
        i.object === "geometry" &&
        i.bodyId === source.bodyId &&
        i.matchId === source.id &&
        i.visual.generator?.kind === "boulder",
    ) ?? null
  );
}

// A new generated rock on `source`'s body: a mesh geometry object matched to
// the outline (so it follows every edit of it), with a boulder block of
// nothing but defaults and no mesh yet. `id` is the caller's (`newBodyId`).
// The same copy `Add geometry` makes of a collision object, with the look
// replaced.
export function rockFor(source: EdItem, id: number): EdItem {
  const schema = loadSchema("boulder")!;
  return {
    ...source,
    id,
    object: "geometry",
    shape: cloneShape(source.shape),
    cam: { ...source.cam },
    light: { ...source.light },
    note: { ...source.note },
    anchorId: 0,
    pathId: 0,
    matchId: source.id,
    visual: {
      ...defaultVisual(),
      kind: "mesh",
      mesh: "",
      generator: { kind: "boulder", version: schema.version, params: {}, patch: null },
    },
  };
}

// Where an item is drawn, as `patchMatrix` wants it: `z` is its drawn depth
// (`guidePlaneZ`), which an object with no `offsetZ` of its own takes from its
// body.
export function objectPose(item: EdItem, z: number): ObjectPose {
  return {
    x: item.pos.x,
    y: item.pos.y,
    z,
    rot: item.rot,
    rotX: item.visual.rotX,
    rotY: item.visual.rotY,
    scale: item.visual.scale,
  };
}

// The smallest a patch's footprint or depth is made (m), so a patch on a flat
// face still has a box the 2D view can draw and a click can land in.
export const MIN_PATCH_EXTENT = 0.05;

// A new mushroom patch in `host`'s body, grown inside `loop` (three's world
// frame, on the host's surface) over the faces `soup` (world triangle soup,
// already collected). Its origin is the middle of the soup's box, unturned, so
// the mesh is placed by an ordinary position and depth and turns about its own
// centre; its rect is the soup's extent (the fork's placement). The loop is
// stored in the patch's own frame (see `EdPatch.points`). No mesh yet.
export function patchFor(host: EdItem, id: number, loop: readonly THREE.Vector3[], soup: Float32Array): EdItem {
  const schema = loadSchema("mushrooms")!;
  const box = new THREE.Box3().setFromArray(soup);
  const origin = box.getCenter(new THREE.Vector3());
  const extent = box.getSize(new THREE.Vector3());
  const pose: ObjectPose = { x: origin.x, y: threeY(origin.y), z: origin.z, rot: 0, rotX: 0, rotY: 0, scale: 1 };
  const inverse = patchMatrix(pose).invert();
  return {
    ...host,
    id,
    object: "geometry",
    pos: new Vec2(pose.x, pose.y),
    rot: 0,
    shape: { kind: "rect", w: Math.max(MIN_PATCH_EXTENT, extent.x), h: Math.max(MIN_PATCH_EXTENT, extent.y) },
    cam: { ...host.cam },
    light: { ...host.light },
    note: { ...host.note },
    anchorId: 0,
    pathId: 0,
    matchId: 0,
    visual: {
      ...defaultVisual(),
      kind: "mesh",
      mesh: "",
      offsetZ: origin.z,
      depth: Math.max(MIN_PATCH_EXTENT, extent.z),
      generator: {
        kind: "mushrooms",
        version: schema.version,
        params: {},
        patch: { hostId: host.id, points: loop.map((p) => worldToLoopPoint(inverse, p)) },
      },
    },
  };
}
