// Rewrite every level file in the node-tree form (plans/node-tree.md phase 4).
//
//   bun scripts/levels-to-tree.ts --editor-closed [--dry-run] [file ...]
//
// Each `levels/<name>.json` that is not already a tree is read through the one
// gate (`loadLevelTree`: the retired forms folded, the flat form migrated) and
// written back as `{ format: 3, ..., nodes }`, pixels as ever. Every id that
// existed is kept - formation and decoration ids, anchor numbers as strings -
// so `levels/paint/`, the sculpt store and the formation store need nothing.
//
// The proof that the rewrite changes nothing the sim reads is checked here,
// per file, before anything is written: the tree compiles to exactly the flat
// level it came from (`cli nodes` holds every level and bundle to the same).
//
// An open editor tab autosaves the level it has open 750 ms after any edit, so
// it is a second author of these files: close every one first, which is what
// `--editor-closed` says has been done.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collides, loadLevelTree, normalizeFlat, type RawLevelData } from "../src/level/levelFormat";
import { compileLevel, isLevelTree, TREE_FORMAT, validateTree } from "../src/level/nodes";
import { firstDifference } from "../src/sim/nodeCases";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LEVELS_DIR = join(ROOT, "levels");

const args = process.argv.slice(2);
if (!args.includes("--editor-closed")) {
  console.error("Close every /editor tab first (it autosaves the level it has open), then pass --editor-closed.");
  process.exit(2);
}
const named = args.filter((a) => !a.startsWith("--"));
const files = named.length ? named.map((n) => (n.endsWith(".json") ? n : `${n}.json`)) : readdirSync(LEVELS_DIR).filter((f) => f.endsWith(".json")).sort();

// What the sim reads, for the before/after check: every body that builds, in
// order, without the labels and node references compilation adds.
function simView(bodies: ReturnType<typeof normalizeFlat>["bodies"]): unknown {
  return bodies.filter(collides).map(({ name: _n, node: _node, ...b }) => ({
    ...b,
    objects: b.objects.map(({ node: _o, ...o }) => o),
  }));
}

let failed = 0;
for (const f of files) {
  const path = join(LEVELS_DIR, f.replace(/^.*\//, ""));
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawLevelData;
  if (isLevelTree(raw)) {
    console.log(`  ${f}: already a tree`);
    continue;
  }
  const before = normalizeFlat(raw);
  const tree = loadLevelTree(raw);
  const after = compileLevel(tree).data;
  const diff =
    firstDifference(simView(before.bodies), simView(after.bodies)) ??
    firstDifference(before.chains ?? null, after.chains ?? null) ??
    firstDifference(before.vines ?? null, after.vines ?? null) ??
    firstDifference(before.player, after.player);
  if (diff) {
    console.log(`  FAIL ${f}: the tree compiles to a different level (${diff}); not written`);
    failed++;
    continue;
  }
  const errors = validateTree(tree.nodes).filter((p) => p.error);
  if (errors.length) {
    console.log(`  FAIL ${f}: ${errors.map((e) => e.message).join("; ")}; not written`);
    failed++;
    continue;
  }
  if (!args.includes("--dry-run")) writeFileSync(path, JSON.stringify({ ...tree, format: TREE_FORMAT }, null, 2) + "\n");
  console.log(`  ${f}: ${tree.nodes.length} top-level nodes ${args.includes("--dry-run") ? "would be " : ""}written`);
}
process.exit(failed ? 1 : 0);
