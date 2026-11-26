// THE EDITOR'S CLIPBOARD, as text.
//
// What is copied is a piece of a LEVEL FILE, in the on-disk pixel form, and it
// is put on the SYSTEM clipboard. That is the whole of the design, and both
// halves are doing work.
//
// The system clipboard is the only thing two browser tabs share without a
// server round trip, and two tabs is the case that matters: an assembly built
// once - a finish gantry, a lamp, a rail rig - has to reach the other
// levels, and until now it could not leave the tab it was built in. The editor
// held three in-memory arrays instead (`clipboard`, `clipboardChains`,
// `clipboardVines`), which a reload emptied and a second tab never saw.
//
// The level format is the payload because it is already the serialisation the
// editor is held to: since the node tree (plans/node-tree.md) a copy is a
// FRAGMENT of the tree - the copied nodes, the bodies and groups above them,
// the chains and vines strung between them - written exactly as a save writes
// it (`toTree`), so the round-trip cases that hold a save lossless hold a copy
// lossless, and there is no second description of an item to drift from the
// first. It also means a payload can be read - and hand-written - as what it
// plainly is, a piece of a level.
//
// WHAT IS NOT IN IT: the player spawn, the level block and the environment.
// None of them is a thing in the level, so none of them is a thing to copy; a
// paste that brought a spawn would move the target level's, which is the one
// edit nobody asked for.

import { PIXELS_PER_METER, PX } from "../engine/units";
import { loadLevelTree, type RawLevelData } from "../level/levelFormat";
import { isLevelTree, scaleLevelTree, TREE_FORMAT, type LevelTree } from "../level/nodes";
import { modelFromTree, toTree, type EdItem, type EdModel } from "./model";

export const CLIPBOARD_KEY = "rope-clipboard";
// 2: a tree fragment (`LevelTree` without a spawn). 1 was the flat form's
// body list, which is still read.
export const CLIPBOARD_VERSION = 2;

export interface ClipboardPayload extends LevelTree {
  [CLIPBOARD_KEY]: number;
}

// What a copy of `items` writes: the fragment of the tree they are, in pixels.
export function writeClipboard(model: EdModel, items: readonly EdItem[]): string {
  const nodes = new Set(items.map((i) => i.node));
  const fragment = scaleLevelTree(toTree(model, (id) => nodes.has(id)), PIXELS_PER_METER);
  const { meta: _m, environment: _e, camera: _c, fogMasked: _f, ...rest } = fragment;
  return JSON.stringify({ [CLIPBOARD_KEY]: CLIPBOARD_VERSION, ...rest });
}

// A pasted payload as the model it describes, in metres: what the editor
// grafts in (`graftModel`). Null for anything that is not a payload.
export function readClipboard(text: string): EdModel | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = parsed as Record<string, unknown>;
  const version = payload[CLIPBOARD_KEY];
  const { [CLIPBOARD_KEY]: _v, player: _spawn, meta: _meta, environment: _env, camera: _camera, ...rest } = payload;
  let tree: LevelTree;
  if (version === CLIPBOARD_VERSION && isLevelTree(rest)) {
    tree = { ...(rest as unknown as LevelTree), format: TREE_FORMAT };
  } else if (version === 1 && Array.isArray(rest["bodies"])) {
    // A copy made before the tree: the flat form's bodies, migrated.
    tree = loadLevelTree({ ...rest, player: NO_SPAWN } as RawLevelData);
  } else {
    return null;
  }
  // A fragment carries no spawn of its own; a flat one was given a stand-in.
  tree = { ...tree, nodes: tree.nodes.filter((n) => n.type !== "Spawn2D") };
  return modelFromTree(scaleLevelTree(tree, PX));
}

const NO_SPAWN = { x: 0, y: 0, radius: 8 };
