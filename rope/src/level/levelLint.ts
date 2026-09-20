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
//   TWO INTROS   - or none. The menu shows the intro first and the rest after a
//                  rule, so the set has to have exactly one.
//   TWIN TITLES  - two listed levels reading the same in the list, which is a
//                  menu with a row the player cannot tell from another.
//
// Pure and fast: it reads the registry's level data and asserts, with no world
// built and no frame stepped, in the spirit of `cli assets`. Its answers are
// about the files as they are ON DISK, since a file-backed level's `data` is
// its JSON import.
//
// There was a fourth check here and it is worth saying why it went. A finish
// line thinner than the ball's own travel in one step can be passed through
// untouched by a SAMPLED overlap test, so this held one to 60 px across - and
// the first line anybody authored was 10 px, drawn to match the gantry marking
// it. The rule was right about the hazard and wrong about where to fix it: the
// crossing is swept now (see `BallLevel.physicsProcess`), so a level may draw
// its line as thin as the gate it stands in, and the lint has nothing to say
// about the size of one.

import { collides, normalizeLevelData, type LevelData } from "./levelFormat";
import { LEVELS, listedLevels } from "./registry";

export interface LevelCheck {
  name: string;
  pass: boolean;
  detail: string;
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

  // ...and one asked of EVERY level, listed or not, because it is about the
  // spawn rather than about the menu: a spawn cannot both roll the ball in and
  // start it hanging (see `SpawnData.roll`). The build says so too, but it says
  // it into the console of whoever happens to play that level, which is not a
  // place an authoring mistake is found.
  const contradictory = Object.entries(LEVELS).filter(([, s]) => s.data.player.hang && s.data.player.roll);
  checks.push({
    name: "levels: no spawn asks to roll in and to start hanging",
    pass: contradictory.length === 0,
    detail:
      contradictory.length === 0
        ? "every spawn asks for one opening"
        : `${contradictory.map(([id]) => id).join(", ")}: a hanging ball has nothing to roll on, so the entry would be ignored.`,
  });

  return checks;
}
