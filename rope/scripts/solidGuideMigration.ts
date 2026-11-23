// Retiring the orthographic route's solid-guide leaves (plans/sculpt-guides.md):
// every `extrude`, `hull` and `ellipsoid` leaf is meshed, exactly as the
// editor meshed it, into a stored binary mesh (formation/meshBin.ts) and
// replaced by a mesh leaf naming it, its pose kept. Nothing else in a guide
// changes, so a guide with no retired leaf keeps its recipe hash and its rock.
//
// Each migrated guide is held to the guide it was: the whole tree meshed
// before and after must enclose the same volume (manifold-3d's `volume()`, to
// 1e-6 relative; float32 vertices are the only difference). A guide that does
// not is left as it was and reported.
//
// The command is scripts/migrate-solid-guides.ts; scripts/test-formations.ts
// runs this on a scratch store.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIXELS_PER_METER } from "../src/engine/units";
import { manifold, type Manifold } from "../src/formation/manifold";
import { encodeMeshBin, readStoredMesh, type SolidMesh } from "../src/formation/meshBin";
import { manifoldOfMesh, meshFiles, meshOfManifold, poseMatrix } from "../src/formation/solid";
import { meshFileName, MESHES } from "../src/formation/store";
import { RETIRED_SOLID_PRIMS } from "../src/level/levelFormat";

// The leaves as they were in the level format, in the file's units (pixels
// for every length).
type Vec3 = [number, number, number];
interface Pose {
  pos?: Vec3;
  rot?: Vec3;
  scale?: Vec3;
}
type RawLeaf =
  | ({ prim: "extrude"; outline: { x: number; y: number }[]; length: number; taper?: number } & Pose)
  | ({ prim: "hull"; points: Vec3[] } & Pose)
  | ({ prim: "box" | "ellipsoid" | "cylinder"; size: Vec3 } & Pose)
  | ({ prim: "mesh"; file: string } & Pose);
export type RawNode = { op: "union" | "difference" | "intersection"; of: RawNode[] } | RawLeaf;
export interface RawDoc {
  bodies?: { name?: string; formation?: { id: string; guide: { kind: string; tree?: RawNode } } }[];
}

export interface MigratedGuide {
  body: number;
  name?: string;
  formation: string;
  volumeBefore: number;
  volumeAfter: number;
  // |after - before| / before.
  off: number;
  ok: boolean;
}

const RETIRED = new Set<string>(RETIRED_SOLID_PRIMS);
const SEGMENTS = 32; // solid.ts's, for an ellipsoid and a cylinder alike
const TOLERANCE = 1e-6;
const m = (v: number): number => v / PIXELS_PER_METER;

// A primitive in its own frame, in metres, as solid.ts meshed it until
// 2026-11-23 (the retired kinds) and still does (the rest).
function ownSolid(n: RawLeaf, meshes: Map<string, SolidMesh>): Manifold {
  switch (n.prim) {
    case "extrude": {
      const cs = manifold.CrossSection.ofPolygons([n.outline.map((q) => [m(q.x), m(q.y)] as [number, number])], "NonZero");
      const top = Math.max(0, 1 - (n.taper ?? 0));
      const out = manifold.Manifold.extrude(cs, m(n.length), 0, 0, [top, top]);
      cs.delete();
      return out;
    }
    case "hull":
      return manifold.Manifold.hull(n.points.map((p) => [m(p[0]), m(p[1]), m(p[2])] as Vec3));
    case "box":
      return manifold.Manifold.cube(n.size.map(m) as Vec3, true);
    case "ellipsoid": {
      const s = manifold.Manifold.sphere(1, SEGMENTS);
      const out = s.scale([m(n.size[0]) / 2, m(n.size[1]) / 2, m(n.size[2]) / 2]);
      s.delete();
      return out;
    }
    case "cylinder": {
      const c = manifold.Manifold.cylinder(1, 1, 1, SEGMENTS, true);
      const up = c.rotate([-90, 0, 0]);
      const out = up.scale([m(n.size[0]) / 2, m(n.size[1]), m(n.size[2]) / 2]);
      c.delete();
      up.delete();
      return out;
    }
    case "mesh": {
      const mesh = meshes.get(n.file);
      if (!mesh) throw new Error(`mesh ${n.file} is not in the store`);
      return manifoldOfMesh(mesh);
    }
  }
}

function whole(n: RawNode, meshes: Map<string, SolidMesh>): Manifold {
  if ("op" in n) {
    const kids = n.of.map((c) => whole(c, meshes));
    try {
      if (n.op === "union") return manifold.Manifold.union(kids);
      if (n.op === "intersection") return manifold.Manifold.intersection(kids);
      return kids.length === 1 ? kids[0]!.translate([0, 0, 0]) : manifold.Manifold.difference(kids);
    } finally {
      for (const k of kids) k.delete();
    }
  }
  const own = ownSolid(n, meshes);
  const pos = n.pos ? (n.pos.map(m) as Vec3) : undefined;
  const placed = own.transform(poseMatrix({ ...n, pos }) as never);
  own.delete();
  return placed;
}

export function hasRetired(n: RawNode): boolean {
  return "op" in n ? n.of.some(hasRetired) : RETIRED.has(n.prim);
}

// Every guide in `doc` (a level or a formation asset, in pixels) migrated in
// place; each retired leaf's mesh written under `store`'s `meshes/` unless
// `dry`. Answers what was done to each guide that held a retired leaf.
export function migrateDoc(doc: RawDoc, store: string, dry = false): MigratedGuide[] {
  const out: MigratedGuide[] = [];
  for (const [i, body] of (doc.bodies ?? []).entries()) {
    const f = body.formation;
    if (f?.guide.kind !== "solid" || !f.guide.tree || !hasRetired(f.guide.tree)) continue;
    const meshes = new Map<string, SolidMesh>();
    for (const name of meshFiles(f.guide.tree as never)) {
      const path = join(store, MESHES, meshFileName(name));
      if (existsSync(path)) meshes.set(name, readStoredMesh(name, readFileSync(path)));
    }
    const stored = new Map<string, Uint8Array>();
    const swap = (n: RawNode): RawNode => {
      if ("op" in n) return { op: n.op, of: n.of.map(swap) };
      if (!RETIRED.has(n.prim)) return n;
      const own = ownSolid(n, meshes);
      try {
        const mesh = meshOfManifold(own);
        const bytes = encodeMeshBin(mesh);
        const file = `${createHash("sha256").update(bytes).digest("hex")}.bin`;
        meshes.set(file, mesh);
        stored.set(file, bytes);
        return { prim: "mesh", file, ...(n.pos ? { pos: n.pos } : {}), ...(n.rot ? { rot: n.rot } : {}), ...(n.scale ? { scale: n.scale } : {}) };
      } finally {
        own.delete();
      }
    };
    const tree = swap(f.guide.tree);
    const before = whole(f.guide.tree, meshes);
    const after = whole(tree, meshes);
    const volumeBefore = before.volume();
    const volumeAfter = after.volume();
    before.delete();
    after.delete();
    const off = Math.abs(volumeAfter - volumeBefore) / Math.max(Math.abs(volumeBefore), 1e-12);
    const ok = off <= TOLERANCE;
    out.push({ body: i, name: body.name, formation: f.id, volumeBefore, volumeAfter, off, ok });
    if (!ok) continue;
    f.guide.tree = tree;
    if (dry) continue;
    mkdirSync(join(store, MESHES), { recursive: true });
    for (const [file, bytes] of stored) {
      const path = join(store, MESHES, file);
      if (!existsSync(path)) writeFileSync(path, bytes);
    }
  }
  return out;
}
