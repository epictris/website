// Level and prefab files in the node-tree form, for the scripts that read
// formations out of them and write builds back (plans/node-tree.md, "Tools
// that read levels").
//
// These scripts work on the AUTHORED view (`loadLevelTree`), not the compiled
// one: a formation's id is its `Formation3D` node's id, its decorations are
// that node's `Decoration3D` children, and a build is written onto the node.
// A level file is only ever written back as a tree, in the text form
// scripts/levels-to-tree.ts writes, so a level that was still flat on disk
// comes out migrated and never the other way.
//
// Writes go to the tree as it was read from disk, in pixels, and touch only
// what was built. Scaling the whole tree to metres and back is not a no-op:
// some lengths come back a last bit off (1660 -> 1660.0000000000002), and a
// retired field folded on load is written in its new form, so a build would
// rewrite numbers nobody edited.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLevelTree, type FormationData, type LevelSource } from "../src/level/levelFormat";
import { findNode, TREE_FORMAT, walkNodes, type DecorationNode, type FormationNode, type LevelNode, type LevelTree, type PrefabData } from "../src/level/nodes";

const ROOT = join(import.meta.dirname, "..");
export const LEVELS_DIR = join(ROOT, "levels");
export const PREFABS_DIR = join(ROOT, "prefabs");

// A level file as a tree, in the file's units (pixels), whatever form it was
// written in.
export function readLevelTree(path: string): LevelTree {
  return loadLevelTree(JSON.parse(readFileSync(path, "utf8")) as LevelSource);
}

// A tree written as a level file: format 3, two-space JSON, a newline last.
export function writeLevelTree(path: string, tree: LevelTree): void {
  writeFileSync(path, JSON.stringify({ ...tree, format: TREE_FORMAT }, null, 2) + "\n");
}

// Every prefab file by name (`prefabs/<name>.json`), read afresh from disk;
// none when the folder does not exist.
export function readPrefabs(): Map<string, PrefabData> {
  const out = new Map<string, PrefabData>();
  if (!existsSync(PREFABS_DIR)) return out;
  for (const file of readdirSync(PREFABS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    out.set(file.slice(0, -5), JSON.parse(readFileSync(join(PREFABS_DIR, file), "utf8")) as PrefabData);
  }
  return out;
}

// Every node's path of names (`nodePath`) by its id, in one walk.
export function nodePaths(nodes: readonly LevelNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const trail: string[] = [];
  walkNodes(nodes, (n, _parent, depth) => {
    trail.length = depth;
    trail.push(n.name);
    out.set(n.id, trail.join("/"));
  });
  return out;
}

// The node a command line names: by id, else by its path of names.
export function resolveNode(nodes: readonly LevelNode[], ref: string): LevelNode | null {
  const byId = findNode(nodes, ref);
  if (byId) return byId;
  for (const [id, path] of nodePaths(nodes)) if (path === ref) return findNode(nodes, id);
  return null;
}

// Every `Formation3D` at or under `nodes`, in tree order, leaving out what a
// `disabled` node takes out of the level.
export function formationNodes(nodes: readonly LevelNode[]): FormationNode[] {
  const out: FormationNode[] = [];
  walkNodes(nodes, (n) => {
    if (n.disabled) return "skip";
    if (n.type === "Formation3D") out.push(n);
  });
  return out;
}

// A formation's decorations: its `Decoration3D` children that are not disabled.
export function decorationsOf(f: FormationNode): DecorationNode[] {
  return (f.children ?? []).filter((c): c is DecorationNode => c.type === "Decoration3D" && !c.disabled);
}

// A formation node as the `FormationData` the recipe, the hash and the build
// take, in the node's units. Its placement is left out (a rock is built in its
// own frame, so where it stands builds nothing), and so is the guide's
// `subset`: in a tree it names `CollisionShape2D` nodes, which mean nothing
// outside the level, and the recipe leaves it out anyway (`formationRecipe`).
export function formationOf(n: FormationNode): FormationData {
  const guide = n.guide.kind === "collision" ? (({ subset: _s, ...g }) => g)(n.guide) : n.guide;
  return {
    id: n.id,
    generator: n.generator,
    ...(n.variant !== undefined ? { variant: n.variant } : {}),
    params: n.params,
    guide,
    ...(n.lod !== undefined ? { lod: n.lod } : {}),
    ...(n.built !== undefined ? { built: n.built } : {}),
  };
}
