// Decorations as the editor places, drags, paints and keeps them on their
// rock (docs/formations.md, "Decorations").
//
// An anchor is a point on the formation's GUIDE (stable across regenerates)
// with the guide's normal there; where the decoration is drawn is that point
// carried along the normal onto the ROCK that is drawn now (`onRock`). So:
//
// - a click or a drag on the rock (in the Visuals workspace) is turned into the
//   nearest point of the guide's surface (`anchorAt`), and the decoration is
//   drawn at its projection (`projectOnRock`) - every frame of a drag, so it
//   never floats or sinks while it moves;
// - after a regenerate, every anchor on that guide is projected onto the new
//   rock; one that finds no rock within REACH of its guide point, or would move
//   further than MOVE_LIMIT, is flagged `lost` and left where it was;
// - a painted decoration's strokes are on the rock itself; after a regenerate
//   each is carried along its normal onto the new rock the same way, and it is
//   grown again.
//
// Frames: everything here is in the formation's frame as the 3D view draws it
// (x right, y up, z toward the camera, metres); the editor's world is the
// level's (y down) with the formation item's placement in it.

import * as THREE from "three";
import { manifold } from "../../../3d/orthographic/src/core/manifold";
import { Vec2 } from "../engine/vec2";
import { guideOutline } from "../formation/guide";
import { resolvedParams } from "../formation/recipe";
import { solidMesh } from "../formation/solid";
import type { DecorationAnchor, PaintStamp } from "../level/levelFormat";
import { formationFile, loadFormationFile, decodedFormationFile } from "../render3d/formations";
import { threeRotation, threeY } from "../render3d/space";
import type { EdItem } from "./model";
import { loadedMeshes } from "./solidGuides";
import { itemMatrix } from "./space3d";

// How far along its normal an anchor looks for the rock, either way, metres.
export const REACH = 0.75;
// How far a regenerate may carry an anchor's drawn point before it is lost.
export const MOVE_LIMIT = 0.5;

type V3 = [number, number, number];

// The formation item's frame in the 3D world (three's): its body's 3D frame
// when the body is 3D (space3d.ts).
export function formationMatrix(f: EdItem): THREE.Matrix4 {
  return itemMatrix(f);
}

// A world point and normal (three's) into the formation's frame.
export function toFormation(f: EdItem, point: THREE.Vector3, normal: THREE.Vector3): { p: THREE.Vector3; n: THREE.Vector3 } {
  const inv = formationMatrix(f).invert();
  return { p: point.clone().applyMatrix4(inv), n: normal.clone().transformDirection(inv) };
}

// Where a decoration's mark goes on the plane (the level's world, y down).
export function markPos(f: EdItem, a: DecorationAnchor): Vec2 {
  const w = new THREE.Vector3(...a.p).applyMatrix4(formationMatrix(f));
  return new Vec2(w.x, -w.y);
}

// The guide's surface as a mesh in the formation's frame: a collision guide's
// outline pushed through the rock's thickness (the generators' `depth`, centred
// on the play plane), a solid guide's tree as it is meshed.
const guideMeshes = new Map<string, THREE.Mesh | null>();
export function guideSurface(f: EdItem): THREE.Mesh | null {
  const data = f.formation;
  if (!data) return null;
  const key = JSON.stringify([data.guide, data.params["depth"]]);
  if (guideMeshes.has(key)) return guideMeshes.get(key)!;
  let positions: Float32Array | null = null;
  let indices: Uint32Array | null = null;
  if (data.guide.kind === "collision") {
    const g = guideOutline(data.guide);
    const depth = Number(resolvedParams(data)["depth"] ?? 1);
    if (g.outline) {
      const cs = manifold.CrossSection.ofPolygons([g.outline.map((p) => [p.x, -p.y] as [number, number])], "NonZero");
      const solid = manifold.Manifold.extrude(cs, depth).translate([0, 0, -depth / 2]);
      cs.delete();
      const mesh = solid.getMesh();
      solid.delete();
      positions = new Float32Array(mesh.numVert * 3);
      for (let i = 0; i < mesh.numVert; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * mesh.numProp + k]!;
      indices = new Uint32Array(mesh.triVerts);
    }
  } else {
    const r = solidMesh(data.guide.tree, loadedMeshes());
    if (r.mesh) {
      positions = r.mesh.positions;
      indices = r.mesh.indices;
    }
  }
  let out: THREE.Mesh | null = null;
  if (positions && indices) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    out = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  }
  guideMeshes.set(key, out);
  return out;
}

// The nearest point of the guide's surface to `p`, with that face's outward
// normal: an anchor. Null for a guide with no surface.
export function anchorAt(f: EdItem, p: THREE.Vector3): DecorationAnchor | null {
  const mesh = guideSurface(f);
  if (!mesh) return null;
  const pos = mesh.geometry.getAttribute("position");
  const idx = mesh.geometry.getIndex()!;
  const tri = new THREE.Triangle();
  const at = new THREE.Vector3();
  let best = Infinity;
  let bestP = new THREE.Vector3();
  let bestN = new THREE.Vector3(0, 0, 1);
  for (let t = 0; t < idx.count; t += 3) {
    tri.a.fromBufferAttribute(pos, idx.getX(t));
    tri.b.fromBufferAttribute(pos, idx.getX(t + 1));
    tri.c.fromBufferAttribute(pos, idx.getX(t + 2));
    tri.closestPointToPoint(p, at);
    const d = at.distanceToSquared(p);
    if (d < best) {
      best = d;
      bestP = at.clone();
      tri.getNormal(bestN);
    }
  }
  return { p: [bestP.x, bestP.y, bestP.z], n: [bestN.x, bestN.y, bestN.z] };
}

// The rock a formation draws now, decoded (the editor's own copy of what the
// scene mounts), or null until it has landed.
export function rockOf(f: EdItem, landed: () => void): THREE.Object3D | null {
  const data = f.formation;
  const which = data ? formationFile({ ...data }) : null;
  if (!which) return null;
  const ready = decodedFormationFile(which);
  if (ready === undefined) {
    void loadFormationFile(which).then(() => landed());
    return null;
  }
  if (ready) ready.updateMatrixWorld(true);
  return ready;
}

const raycaster = new THREE.Raycaster();
// `a` carried along its normal onto `rock` (the formation's frame): the nearest
// hit within REACH either way, with the rock's normal there. Null when there
// is no rock that near.
export function projectOnRock(rock: THREE.Object3D, a: DecorationAnchor, reach = REACH): DecorationAnchor | null {
  const p = new THREE.Vector3(...a.p);
  const n = new THREE.Vector3(...a.n).normalize();
  let best: THREE.Intersection | null = null;
  let bestD = Infinity;
  for (const dir of [n.clone().negate(), n]) {
    raycaster.set(p.clone().addScaledVector(dir, -reach), dir);
    raycaster.far = 2 * reach;
    for (const hit of raycaster.intersectObject(rock, true)) {
      const d = Math.abs(hit.distance - reach);
      if (d < bestD) {
        bestD = d;
        best = hit;
      }
    }
  }
  if (!best || bestD > reach) return null;
  const normal = best.face ? best.face.normal.clone().transformDirection(best.object.matrixWorld) : n;
  // Outward: the side the anchor's normal is on.
  if (normal.dot(n) < 0) normal.negate();
  return { p: [best.point.x, best.point.y, best.point.z], n: [normal.x, normal.y, normal.z] };
}

// After the rock changed: where an anchor now lands, or `lost` with the old
// point kept when it lands nowhere near or would move too far.
export function reproject(rock: THREE.Object3D, a: DecorationAnchor, old: DecorationAnchor | undefined): { onRock: DecorationAnchor; lost: boolean } {
  const now = projectOnRock(rock, a);
  const was = old ?? a;
  if (!now) return { onRock: was, lost: true };
  const moved = new THREE.Vector3(...now.p).distanceTo(new THREE.Vector3(...was.p));
  return moved > MOVE_LIMIT ? { onRock: was, lost: true } : { onRock: now, lost: false };
}

// A painted decoration's strokes carried along their normals onto a new rock;
// a stroke that lands nowhere is kept as it was (the growth simply has less
// under it), and counted.
export function reprojectStrokes(rock: THREE.Object3D, strokes: readonly PaintStamp[]): { strokes: PaintStamp[]; lost: number } {
  let lost = 0;
  const out = strokes.map((s) => {
    const hit = projectOnRock(rock, { p: s.p, n: s.n });
    if (!hit) {
      lost++;
      return s;
    }
    return { p: hit.p, n: hit.n, r: s.r, s: s.s } satisfies PaintStamp;
  });
  return { strokes: out, lost };
}

export function v3(v: THREE.Vector3): V3 {
  return [v.x, v.y, v.z];
}
