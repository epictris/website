// Migrate a level's Blender scene into the level itself (docs/formations.md,
// "Migrating a scene"; plans/editor-owns-the-level.md step 6).
//
//   bun run scripts/migrate-scene.ts <level> [--out <name>] [--solid-only] [--blender PATH]
//
// `--solid-only` carries only the solid formations (and what grows on them):
// the outline formations, the rocks over the level's collision, are left for
// the editor to make anew.
//
// Reads `assets-src/scenes/<scene>.blend` (the level's `scene`) through
// tools/blender/migrate_scene_dump.py and writes `levels/<out>.json` (default
// `<level>-migrated`, so the level being edited is never written to; rename it
// over the original by hand once it is judged) and its paint,
// `levels/paint/<out>.json`:
//
// - each OUTLINE formation (boulders, fitted slate) becomes the formation of
//   the body whose collision it covers most (at least MIN_OVERLAP of its
//   outline), placed in that body where it stood, its outline the guide; one
//   that covers none gets a body of its own with no collision;
// - each SOLID formation becomes a body of its own behind the plane, its
//   guide the Blender guide mesh as an imported mesh leaf (kept in the store's
//   meshes/), its variant and parameters its recipe's;
// - each moss and ivy becomes a painted decoration on its host's formation,
//   its stamps the paint; each plant a placed decoration at its transform;
// - `scene` is removed.
//
// A decoration whose host is not a formation (a hand-made mesh) cannot be
// carried and is listed. Nothing is generated: the formations come out with
// no `built`, to be generated (and baked) in the editor or in a batch.
// Generated, they will not be the same rocks: the recipes are, not the bytes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifold } from "../../3d/orthographic/src/core/manifold";
import { PIXELS_PER_METER, PX } from "../src/engine/units";
import { piecePolygon, type Pt } from "../src/formation/outline";
import { canonical, newFormationId } from "../src/formation/recipe";
import { sha256Hex } from "../src/formation/sha256";
import { MESHES } from "../src/formation/store";
import {
  isCollisionObject,
  scaleLevelData,
  type DecorationKind,
  type DecorationObjectData,
  type FormationData,
  type LevelBodyData,
  type PaintStamp,
  type RawLevelData,
  type SolidVariant,
} from "../src/level/levelFormat";

const ROOT = join(import.meta.dirname, "..");
const TAG = "[migrate]";
// An outline formation goes on a body whose collision covers at least this
// share of it.
const MIN_OVERLAP = 0.5;
// The boulder recipe's version 1 depth (worker.LEGACY_THICKNESS) and slab
// shares (worker.legacy_slab_size).
const LEGACY_THICKNESS = 2.6;

const argv = process.argv.slice(2);
const level = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--")));
const flag = (n: string): string | undefined => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
if (!level) {
  console.error(`${TAG} usage: bun run scripts/migrate-scene.ts <level> [--out <name>] [--blender PATH]`);
  process.exit(2);
}
const out = flag("--out") ?? `${level}-migrated`;
const levelPath = join(ROOT, "levels", `${level}.json`);
const raw = JSON.parse(readFileSync(levelPath, "utf8")) as RawLevelData;
const data = scaleLevelData(raw, PX);
const scene = data.scene;
if (!scene) {
  console.error(`${TAG} ${level} names no scene`);
  process.exit(1);
}
const blend = join(ROOT, "assets-src", "scenes", `${scene}.blend`);
if (!existsSync(blend)) {
  console.error(`${TAG} no ${blend} (\`just sources\`)`);
  process.exit(1);
}

// 1. The scene, read.
const dumpPath = join(ROOT, ".cache", `migrate-${scene}.json`);
mkdirSync(join(ROOT, ".cache"), { recursive: true });
const dumped = spawnSync(flag("--blender") ?? "blender", ["-b", blend, "--factory-startup", "--python-exit-code", "1", "--python", join(ROOT, "tools", "blender", "migrate_scene_dump.py"), "--", dumpPath], { encoding: "utf8" });
if (dumped.status !== 0) {
  console.error(dumped.stdout.split("\n").slice(-15).join("\n"));
  process.exit(1);
}
type M4 = number[][];
interface DumpFormation { name: string; recipe: Record<string, unknown> & { generator?: string; params?: Record<string, number | boolean>; outline?: [number, number][]; version?: number; variant?: string }; matrix: M4; guideWorld?: { verts: number[][]; faces: number[][] } }
interface DumpPaint { name: string; kind: "moss" | "ivy"; host: string; settings: Record<string, number | boolean | string>; stamps: { p: number[]; n: number[]; r: number; s: number }[] }
interface DumpPlant { name: string; kind: string; host: string; matrix: M4; seed: number; settings: Record<string, number | boolean | string> }
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as { formations: DumpFormation[]; paints: DumpPaint[]; plants: DumpPlant[] };

// Blender's world (x, y away, z up) and the level's: a point (x, y, z) stands at
// level (x, -z), and in the 3D view's frame at (x, z, -y).
const apply = (m: M4, v: number[], w = 1): number[] => [0, 1, 2].map((r) => m[r]![0]! * v[0]! + m[r]![1]! * v[1]! + m[r]![2]! * v[2]! + m[r]![3]! * w);
const toGame = (v: number[]): [number, number, number] => [v[0]!, v[2]!, -v[1]!];
const norm = (v: number[]): number[] => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return v.map((x) => x / l);
};
// The inverse of a rigid (rotation + translation) 4x4.
function invRigid(m: M4): M4 {
  const r = [[m[0]![0]!, m[1]![0]!, m[2]![0]!], [m[0]![1]!, m[1]![1]!, m[2]![1]!], [m[0]![2]!, m[1]![2]!, m[2]![2]!]];
  const t = [m[0]![3]!, m[1]![3]!, m[2]![3]!];
  const ti = r.map((row) => -(row[0]! * t[0]! + row[1]! * t[1]! + row[2]! * t[2]!));
  return [[...r[0]!, ti[0]!], [...r[1]!, ti[1]!], [...r[2]!, ti[2]!], [0, 0, 0, 1]];
}

// 2. The level's collision bodies as polygons in the level, for the matching.
const bodies: LevelBodyData[] = data.bodies.map((b) => ({ ...b, objects: [...b.objects] }));
const bodyPolygons = bodies.map((b) => {
  const c = Math.cos(b.rot);
  const s = Math.sin(b.rot);
  return b.objects.filter(isCollisionObject).flatMap((o) => {
    const poly = piecePolygon({ shape: o.shape, x: o.x, y: o.y, rot: o.rot });
    return poly ? [poly.map((p) => ({ x: b.x + p.x * c - p.y * s, y: b.y + p.x * s + p.y * c }))] : [];
  });
});
const overlap = (a: Pt[], b: Pt[][]): number => {
  if (!b.length) return 0;
  const A = manifold.CrossSection.ofPolygons([a.map((q) => [q.x, q.y] as [number, number])], "NonZero");
  const B = manifold.CrossSection.ofPolygons(b.map((p) => p.map((q) => [q.x, q.y] as [number, number])), "NonZero");
  const I = A.intersect(B);
  const r = I.area() / Math.max(1e-9, A.area());
  A.delete();
  B.delete();
  I.delete();
  return r;
};

const taken = new Set<string>();
// Per Blender formation: the body it went on, and its frame in Blender's world
// (what its host's paint is carried through).
const placed = new Map<string, { body: LevelBodyData; formation: FormationData; frame: M4 }>();
const report: string[] = [];
mkdirSync(join(ROOT, "public", "generated", MESHES), { recursive: true });

for (const f of dump.formations) {
  const r = f.recipe;
  const generator = (r.generator ?? "boulders").split(/[\\/]/).pop()!;
  const m = f.matrix;
  const origin = { x: m[0]![3]!, y: -m[2]![3]! };
  const id = newFormationId(taken);
  taken.add(id);
  if (generator === "solid" && f.guideWorld) {
    // A body of its own at where the rock stands in the plane; its guide the
    // Blender guide mesh, in the 3D view's frame about that origin.
    const verts = f.guideWorld.verts.map((v) => toGame([v[0]! - origin.x, v[1]!, v[2]! + origin.y]));
    const mesh = canonical({ verts, faces: f.guideWorld.faces }) as { verts: number[][]; faces: number[][] };
    const text = JSON.stringify(mesh);
    const name = sha256Hex(text);
    writeFileSync(join(ROOT, "public", "generated", MESHES, `${name}.json`), text);
    const params = r.params ?? {};
    // A recipe that names no variant and carries no `jointed` flag was written
    // before jointed rock existed (2026-11-21), so it was built with the
    // original boulder surface; the worker's default for a missing flag is
    // now Cliff, which would rebuild it as a different rock. The river's 25
    // solids are all such recipes.
    const variant: SolidVariant = (r.variant as SolidVariant | undefined) ?? (params["faceted"] ? "faceted" : params["stones"] ? "stones" : params["wall"] ? "wall" : params["jointed"] === true ? "cliff" : "boulder");
    const formation: FormationData = { id, generator: "solid", variant, params: { ...params }, guide: { kind: "solid", tree: { prim: "mesh", file: name } } };
    // A 3D body (`LevelBodyData.space`): a backdrop holds nothing that
    // collides, so it carries the full 3D gizmo in the editor.
    const body: LevelBodyData = { kind: "static", name: f.name.replace(/[^\w.-]+/g, "-"), x: origin.x, y: origin.y, rot: 0, space: "3d", objects: [], formation };
    bodies.push(body);
    placed.set(f.name, { body, formation, frame: [[1, 0, 0, m[0]![3]!], [0, 1, 0, 0], [0, 0, 1, m[2]![3]!], [0, 0, 0, 1]] });
    report.push(`${f.name}: solid (${variant}) -> a body of its own`);
    continue;
  }
  if (generator !== "boulders" && generator !== "fitted") {
    report.push(`${f.name}: generator ${generator} not migrated`);
    continue;
  }
  if (argv.includes("--solid-only")) {
    report.push(`${f.name}: ${generator} outline, left out (--solid-only)`);
    continue;
  }
  // The outline in the rock's frame (x, z up) -> the formation's (x, y down).
  const outline = (r.outline ?? []).map(([x, z]) => ({ x, y: -z }));
  const rot = Math.atan2(-m[2]![0]!, m[0]![0]!);
  const params: Record<string, number | boolean> = { ...(r.params ?? {}) };
  if (generator === "boulders" && (r.version ?? 1) < 2) {
    // Built when depth was the construction's and slabs shares of the outline.
    if (typeof params["depth"] === "number") params["depth"] = params["depth"] * LEGACY_THICKNESS;
    const xs = (r.outline ?? []).map((p) => p[0]);
    const zs = (r.outline ?? []).map((p) => p[1]);
    params["slabWidth"] = 0.385 * (Math.max(...xs) - Math.min(...xs));
    params["slabLength"] = 0.31 * (Math.max(...zs) - Math.min(...zs));
  }
  const world = outline.map((p) => ({ x: origin.x + p.x * Math.cos(rot) - p.y * Math.sin(rot), y: origin.y + p.x * Math.sin(rot) + p.y * Math.cos(rot) }));
  // The body whose collision covers it most.
  let best = -1;
  let bestShare = 0;
  bodies.forEach((b, i) => {
    if (b.formation || i >= bodyPolygons.length) return;
    const share = overlap(world, bodyPolygons[i]!);
    if (share > bestShare) {
      bestShare = share;
      best = i;
    }
  });
  const guide = { kind: "collision" as const, pieces: [{ shape: { kind: "poly" as const, verts: outline } }] };
  if (best >= 0 && bestShare >= MIN_OVERLAP) {
    const b = bodies[best]!;
    // The rock's frame in the body's.
    const dx = origin.x - b.x;
    const dy = origin.y - b.y;
    const c = Math.cos(-b.rot);
    const s = Math.sin(-b.rot);
    const formation: FormationData = { id, x: dx * c - dy * s, y: dx * s + dy * c, rot: rot - b.rot, generator: generator as "boulders" | "fitted", params, guide };
    b.formation = formation;
    placed.set(f.name, { body: b, formation, frame: m });
    report.push(`${f.name}: ${generator} -> on body ${best}${b.name ? ` (${b.name})` : ""}, covering ${(bestShare * 100).toFixed(0)}% of it`);
  } else {
    const formation: FormationData = { id, generator: generator as "boulders" | "fitted", params, guide };
    const body: LevelBodyData = { kind: "static", name: f.name.replace(/[^\w.-]+/g, "-"), x: origin.x, y: origin.y, rot, objects: [], formation };
    bodies.push(body);
    placed.set(f.name, { body, formation, frame: m });
    report.push(`${f.name}: ${generator} -> a body of its own (${(bestShare * 100).toFixed(0)}% covered at best)`);
  }
}

// 3. The decorations, carried into their formation's frame.
const paint: Record<string, PaintStamp[]> = {};
const decorationIds = new Set<string>();
const newDecorationId = (kind: string): string => {
  let id = "";
  do id = `${kind}-${Math.floor(Math.random() * 36 ** 5).toString(36)}`; while (decorationIds.has(id));
  decorationIds.add(id);
  return id;
};
const hostMatrix = (name: string): M4 | null => dump.formations.find((f) => f.name === name)?.matrix ?? null;
const unplaced: string[] = [];
for (const p of dump.paints) {
  const at = placed.get(p.host);
  const hm = hostMatrix(p.host);
  if (!at || !hm) {
    unplaced.push(`${p.name} (${p.kind} on ${p.host}, not a formation)`);
    continue;
  }
  const inv = invRigid(at.frame);
  const strokes: PaintStamp[] = p.stamps.map((s) => {
    const w = apply(hm, s.p);
    const n = norm(apply(hm, s.n, 0));
    return { p: toGame(apply(inv, w)), n: toGame(norm(apply(inv, n, 0))), r: s.r, s: s.s };
  });
  const first = strokes.find((s) => s.s > 0) ?? strokes[0];
  if (!first) continue;
  const id = newDecorationId(p.kind);
  paint[id] = strokes;
  const d: DecorationObjectData = { type: "decoration", id, kind: p.kind, formation: at.formation.id, anchor: { p: first.p, n: first.n }, onRock: { p: first.p, n: first.n }, settings: p.settings };
  at.body.objects.push(d);
}
const PLANT_KINDS: Record<string, DecorationKind> = { FERN: "fern", VINE: "vine", MUSHROOM: "mushroom", ORBS: "orbs", GLOW: "glow" };
for (const p of dump.plants) {
  const at = placed.get(p.host);
  const kind = PLANT_KINDS[p.kind];
  if (!at || !kind) {
    unplaced.push(`${p.name} (${p.kind} on ${p.host}${kind ? ", not a formation" : ""})`);
    continue;
  }
  const inv = invRigid(at.frame);
  const root = toGame(apply(inv, [p.matrix[0]![3]!, p.matrix[1]![3]!, p.matrix[2]![3]!]));
  const up = toGame(norm(apply(inv, [p.matrix[0]![2]!, p.matrix[1]![2]!, p.matrix[2]![2]!], 0)));
  const { seed: _seed, ...settings } = p.settings;
  at.body.objects.push({ type: "decoration", id: newDecorationId(kind), kind, formation: at.formation.id, anchor: { p: root, n: up }, onRock: { p: root, n: up }, seed: p.seed, settings });
}

// 4. The level without its scene.
const { scene: _scene, ...rest } = data;
const migrated = scaleLevelData({ ...rest, bodies }, PIXELS_PER_METER);
writeFileSync(join(ROOT, "levels", `${out}.json`), JSON.stringify(migrated, null, 2) + "\n");
mkdirSync(join(ROOT, "levels", "paint"), { recursive: true });
writeFileSync(join(ROOT, "levels", "paint", `${out}.json`), JSON.stringify(paint, null, 1) + "\n");

for (const line of report) console.log(`${TAG} ${line}`);
const decorations = bodies.reduce((n, b) => n + b.objects.filter((o) => o.type === "decoration").length, 0);
console.log(`${TAG} ${placed.size} formations (${[...placed.values()].filter((p) => p.body.objects.some(isCollisionObject)).length} on collision bodies), ${decorations} decorations, ${Object.keys(paint).length} painted`);
if (unplaced.length) console.log(`${TAG} not carried (their host is not a formation): ${unplaced.join(", ")}`);
console.log(`${TAG} wrote levels/${out}.json and levels/paint/${out}.json; generate its formations in the editor (or \`bun run formation:build-level ${out}\`)`);
