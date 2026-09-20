// The LEVEL FILES held to what the level select and the finish line assume
// about them (see `docs/levels.md`).
//
// Everything checked here is silent when it breaks, and every one of the
// failures is a level that looks finished and cannot be finished:
//
//   NO FINISH    - a listed level with nothing to cross. It plays, the player
//                  swings to the end of it, and there is no way to complete it
//                  and no way to say so.
//   NO SHAPE     - a finish body carrying only decoration. An area with no
//                  collision object builds nothing at all (see
//                  `buildLevelBodies`), so the gantry is drawn and the level
//                  cannot be finished - the one failure that looks exactly like
//                  success right up until the player reaches it.
//   TOO SMALL    - a finish line the ball can pass without touching. The
//                  crossing is an overlap test, so a region thinner than the
//                  ball travels in a frame is one a fast run tunnels through
//                  (see `MIN_FINISH_SPAN`).
//   TWO INTROS   - or none. The menu shows the intro first and the rest after a
//                  rule, so the set has to have exactly one.
//   TWIN TITLES  - two listed levels reading the same in the list, which is a
//                  menu with a row the player cannot tell from another.
//
// Pure and fast: it reads the registry's level data and asserts, with no world
// built and no frame stepped, in the spirit of `cli assets`. Its answers are
// about the files as they are ON DISK, since a file-backed level's `data` is
// its JSON import.

import {
  collides,
  isCollisionObject,
  normalizeLevelData,
  type LevelBodyData,
  type LevelData,
  type ShapeData,
} from "./levelFormat";
import { LEVELS, listedLevels } from "./registry";

export interface LevelCheck {
  name: string;
  pass: boolean;
  detail: string;
}

// The smallest a finish line may be across its narrow axis, in SCENE PIXELS
// (the unit the files are authored in), which is 60 cm.
//
// The crossing is an overlap test run once a frame, so a region the ball can be
// on both sides of within one step is one it can pass through untouched. The
// ball is 24 cm across and the fastest thing in the game is the ball itself: at
// the ~14 m/s a long hang reaches it travels 23 cm in a frame, so 60 cm is the
// ball plus a frame of its own travel and a little over. It is a floor on the
// AUTHORING rather than a fix for tunnelling - a gate is drawn to be swung
// through and is metres across in both directions - and what it actually
// catches is a line drawn as a line: a 2-pixel strip laid on the floor, which
// looks right in the editor and is not there at 14 m/s.
export const MIN_FINISH_SPAN = 60;

// How wide and how tall a shape is in its own frame, in the units it is
// authored in. A curve's `width` is its THICKNESS rather than a span, so it is
// measured across its own stroke and along its vertices like a polyline.
function shapeSpan(s: ShapeData): { w: number; h: number } {
  if (s.kind === "rect") return { w: s.w, h: s.h };
  if (s.kind === "circle") return { w: s.r * 2, h: s.r * 2 };
  const verts = s.verts;
  const xs = verts.map((v) => v.x);
  const ys = verts.map((v) => v.y);
  const pad = s.kind === "curve" ? s.width : 0;
  return {
    w: Math.max(...xs) - Math.min(...xs) + pad,
    h: Math.max(...ys) - Math.min(...ys) + pad,
  };
}

// The narrowest axis of the WIDEST collision shape a body carries: the piece
// the player is meant to cross is the one that has to be thick enough to catch
// them, and a gate may also carry small pieces (a post's footing) that have
// nothing to do with it.
function narrowestSpanOf(body: LevelBodyData): number {
  let best = 0;
  for (const o of body.objects) {
    if (!isCollisionObject(o)) continue;
    const { w, h } = shapeSpan(o.shape);
    best = Math.max(best, Math.min(w, h));
  }
  return best;
}

// The checks one listed level answers for itself.
function checkLevel(id: string, title: string, data: LevelData): LevelCheck[] {
  const where = `${id} ("${title}")`;
  const lines = data.bodies.filter((b) => b.kind === "finish");
  if (lines.length === 0) {
    return [
      {
        name: `levels: ${where} has a finish line`,
        pass: false,
        detail:
          "no body has the `finish` kind. A listed level ends at a finish line; author one (or mark the level `unlisted`).",
      },
    ];
  }
  // SEVERAL is allowed, and deliberately: a course with two ways down ends at
  // either of them, and the first crossing is the one that counts (see
  // `BallLevel.finish`). What is not allowed is none.
  const built = lines.filter(collides);
  const narrow = built.filter((b) => narrowestSpanOf(b) < MIN_FINISH_SPAN);
  return [
    {
      name: `levels: ${where} has a finish line`,
      pass: true,
      detail: lines.length === 1 ? "one finish line" : `${lines.length} finish lines`,
    },
    {
      name: `levels: ${where}'s finish line is a region, not a drawing`,
      pass: built.length === lines.length,
      detail:
        built.length === lines.length
          ? `${built.length} with collision geometry`
          : `${lines.length - built.length} of ${lines.length} carry no collision object, so they build no area at all and can never be entered.`,
    },
    {
      name: `levels: ${where}'s finish line is thick enough to catch the ball`,
      pass: narrow.length === 0,
      detail:
        narrow.length === 0
          ? `every piece is at least ${MIN_FINISH_SPAN} px across`
          : `${narrow.length} finish line(s) are under ${MIN_FINISH_SPAN} px across their narrow axis (${narrow
              .map((b) => `${Math.round(narrowestSpanOf(b))} px`)
              .join(", ")}). A fast run passes through one in a single frame.`,
    },
  ];
}

export function runLevelChecks(): LevelCheck[] {
  const listed = listedLevels();
  const checks: LevelCheck[] = [];

  checks.push({
    name: "levels: the level select has at least one level on it",
    pass: listed.length > 0,
    detail: listed.length ? `${listed.length} listed` : "every level is unlisted; `/` would be an empty menu",
  });

  const intros = listed.filter((l) => l.intro);
  checks.push({
    name: "levels: exactly one listed level is the introduction",
    pass: intros.length === 1,
    detail:
      intros.length === 1
        ? `${intros[0]!.id}`
        : `${intros.length} intros (${intros.map((l) => l.id).join(", ") || "none"}). The menu shows one level above the rule.`,
  });

  // Case-insensitively, which is how the list is sorted and how a player reads
  // it: two rows differing only in case are two rows nobody can tell apart.
  const seen = new Map<string, string[]>();
  for (const l of listed) {
    const key = l.title.toLowerCase();
    seen.set(key, [...(seen.get(key) ?? []), l.id]);
  }
  const twins = [...seen.values()].filter((v) => v.length > 1);
  checks.push({
    name: "levels: no two listed levels share a title",
    pass: twins.length === 0,
    detail: twins.length === 0 ? "all distinct" : twins.map((v) => v.join(" = ")).join("; "),
  });

  for (const l of listed) {
    const spec = LEVELS[l.id]!;
    // Through the one gate every level passes through on its way to the sim, so
    // the lint reads what the BUILD will read - a retired spelling folded, a
    // chain's anchors minted - rather than what the file happens to spell.
    checks.push(...checkLevel(l.id, l.title, normalizeLevelData(spec.data)));
  }

  return checks;
}
