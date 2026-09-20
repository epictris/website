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
// editor is held to: `toLevelData` is what a SAVE writes, so the round-trip
// cases that hold a save lossless hold a copy lossless, and there is no second
// description of an item to drift from the first. It also means a payload can
// be read - and hand-written - as what it plainly is, a fragment of a level.
//
// WHAT IS NOT IN IT: the player spawn, the level block and the environment.
// None of them is a thing in the level, so none of them is a thing to copy; a
// paste that brought a spawn would move the target level's, which is the one
// edit nobody asked for.

import { PIXELS_PER_METER, PX } from "../engine/units";
import { Vec2 } from "../engine/vec2";
import { scaleLevelData, type LevelData, type RawLevelData } from "../level/levelFormat";
import {
  toLevelData,
  bodyFrameOf,
  type EdBodyFrame,
  type EdChain,
  type EdItem,
  type EdModel,
  type EdVine,
} from "./model";

// The payload's own key, and the version beside it. A pasted string is only
// used when it carries this, so pasting a shopping list into the editor does
// nothing rather than throwing; and the number is what a future change of shape
// is refused by rather than mis-read through.
export const CLIPBOARD_KEY = "rope-clipboard";
export const CLIPBOARD_VERSION = 1;

// A fragment of a level, in on-disk pixels. Every field is the one `LevelData`
// has, so the payload is a level file with the level-wide blocks left out.
export interface ClipboardPayload extends Omit<LevelData, "player" | "meta" | "environment"> {
  [CLIPBOARD_KEY]: number;
}

// The spawn a fragment is scaled against and parsed back with. It is never read
// - the payload carries no player and the parse drops the one it is given - but
// `LevelData` has no shape without it, and a placeholder stated here once is
// better than the same three numbers invented at each end.
const NO_SPAWN = { x: 0, y: 0, radius: 8 };

// The items, chains and vines a copy of `items` actually holds.
//
// A chain needs BOTH ends inside the copy and a vine needs its anchor inside
// it, which is the rule `cloneChainsWithin` / `cloneVinesWithin` apply one step
// later: a chain with one end outside is a chain to a body that is not there,
// and re-pointing it at the original across a level boundary is not even a
// thing that could be meant.
export function clipboardScope(
  model: EdModel,
  items: readonly EdItem[],
): { items: EdItem[]; chains: EdChain[]; vines: EdVine[] } {
  const inside = new Set(items.map((i) => i.id));
  return {
    items: [...items],
    chains: model.chains.filter((c) => inside.has(c.a) && inside.has(c.b)),
    vines: model.vines.filter((v) => inside.has(v.anchor)),
  };
}

// The selection as the text that goes on the clipboard.
//
// It is `modelToDisk` on a SUB-MODEL holding exactly the copied items, which is
// what makes it the same serialisation a save performs rather than a second one
// written for the clipboard. The sub-model carries the frames of the bodies
// involved, since a body's frame is not in its items (see `EdModel.bodyFrames`)
// and a frame re-derived from a member is a bearing that moves.
export function writeClipboard(model: EdModel, items: readonly EdItem[]): string {
  const scope = clipboardScope(model, items);
  const frames = new Map<number, EdBodyFrame>();
  for (const id of new Set(scope.items.map((i) => i.bodyId))) {
    frames.set(id, bodyFrameOf(model, id));
  }
  const sub: EdModel = {
    player: { pos: Vec2.ZERO, radius: NO_SPAWN.radius * PX, hang: false },
    items: scope.items,
    chains: scope.chains,
    vines: scope.vines,
    bodyFrames: frames,
    environment: undefined,
    meta: {},
  };
  const { player: _spawn, ...rest } = scaleLevelData(toLevelData(sub), PIXELS_PER_METER);
  return JSON.stringify({ [CLIPBOARD_KEY]: CLIPBOARD_VERSION, ...rest });
}

// ...and back: a payload as the level data a model is built from, or null for
// text that is not one.
//
// Null rather than a throw for everything, because the input is whatever
// happened to be on the system clipboard: a paste of a sentence, of a half-copied
// fragment, of a payload from a future version. None of those is an error the
// author made, and the editor's answer to all of them is to do nothing at all -
// there is no fallback behind this, and the last one made every middle-click pan
// paste the tab's previous copy (see `pasteClipboard` in `editor.ts`).
export function readClipboard(text: string): RawLevelData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = parsed as Record<string, unknown>;
  if (payload[CLIPBOARD_KEY] !== CLIPBOARD_VERSION) return null;
  if (!Array.isArray(payload.bodies)) return null;
  const { [CLIPBOARD_KEY]: _v, player: _spawn, meta: _meta, environment: _env, ...rest } = payload;
  return { ...rest, player: NO_SPAWN } as RawLevelData;
}
