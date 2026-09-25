// The model edits `+ Rock` and `+ Mushrooms` make, as pure functions of the
// items they read, so the `generator:` cases can hold what a click adds without
// an editor around it. The editor wraps each in one `beginAction` / `markDirty`.

import * as THREE from "three";
import { Vec2 } from "../../engine/vec2";
import { threeY } from "../../render3d/space";
import { cloneShape, defaultVisual, type EdItem } from "../model";
import { loadSchema, roundParam } from "./paramSchema";
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
// stored in the patch's own frame (see `EdPatch.points`), and with it which
// side of the loop's plane it was painted on: `facing`, the painted faces'
// normals summed (world), stored as a unit vector in the patch's frame at the
// key's resolution. No mesh yet.
export function patchFor(
  host: EdItem,
  id: number,
  loop: readonly THREE.Vector3[],
  soup: Float32Array,
  facing: THREE.Vector3,
): EdItem {
  const schema = loadSchema("mushrooms")!;
  const box = new THREE.Box3().setFromArray(soup);
  const origin = box.getCenter(new THREE.Vector3());
  const extent = box.getSize(new THREE.Vector3());
  const pose: ObjectPose = { x: origin.x, y: threeY(origin.y), z: origin.z, rot: 0, rotX: 0, rotY: 0, scale: 1 };
  const inverse = patchMatrix(pose).invert();
  const side = facing.clone().transformDirection(inverse);
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
        patch: {
          hostId: host.id,
          points: loop.map((p) => worldToLoopPoint(inverse, p)),
          // y down, as the points are stored.
          facing: { x: roundParam(side.x), y: roundParam(-side.y), z: roundParam(side.z) },
        },
      },
    },
  };
}

// A patch re-fitted to the surface its loop covers NOW, after Edit loop moved
// points: its origin at the middle of the covered faces' box and its rect and
// depth their extent, as `patchFor` placed it, with its turn, tilt and scale
// kept. `frame` is the patch's frame to three's world as it is drawn
// (`patchMatrix`) and `soup` the covered faces in that world. Moving the origin
// by `c` (in the patch's own frame) moves every loop point by `-c` in it, so
// the loop stays where it was painted. Null for an empty soup.
export function refitPatch(
  item: EdItem,
  frame: THREE.Matrix4,
  soup: Float32Array,
): { pos: Vec2; offsetZ: number; w: number; h: number; depth: number; points: { x: number; y: number; z: number }[] } | null {
  const points = item.visual.generator?.patch?.points;
  if (!points || soup.length < 9) return null;
  const inverse = frame.clone().invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i + 2 < soup.length; i += 3) box.expandByPoint(v.set(soup[i]!, soup[i + 1]!, soup[i + 2]!).applyMatrix4(inverse));
  const c = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const delta = c.clone().applyMatrix4(frame).sub(new THREE.Vector3().applyMatrix4(frame));
  return {
    // Three's world y is up, the model's down.
    pos: item.pos.add(new Vec2(delta.x, -delta.y)),
    offsetZ: item.visual.offsetZ + delta.z,
    w: Math.max(MIN_PATCH_EXTENT, size.x),
    h: Math.max(MIN_PATCH_EXTENT, size.y),
    depth: Math.max(MIN_PATCH_EXTENT, size.z),
    // Stored y down: the local y (up) of a point moves by -c.y, so its stored
    // y moves by +c.y.
    points: points.map((p) => ({ x: p.x - c.x, y: p.y + c.y, z: p.z - c.z })),
  };
}
