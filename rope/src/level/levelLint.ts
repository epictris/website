// The LEVEL FILES held to what the level select and the bell mechanic assume
// about them (see `docs/levels.md`).
//
// Everything checked here is silent when it breaks, and every one of the
// failures is a level that looks finished and cannot be finished:
//
//   NO BELL      - a listed level with nothing to ring. It plays, the player
//                  swings to the end of it, and there is no way to complete it
//                  and no way to say so.
//   TWO BELLS    - the build throws (`BallLevel` refuses a second), so the level
//                  does not open at all. Caught here, where it is a line of
//                  output rather than a blank page.
//   NOT A PIVOT  - a `bell` on a body with no bearing. The ring is measured as
//                  a swing about one, so a bell that cannot turn can never be
//                  rung however hard it is hauled on.
//   NO ROPE      - a bell with no toll rope: a scene chain from an anchor on
//                  the bell to a SALLY, the rigid grip on the end of it that the
//                  player hooks and hauls on. The rope is the whole interface,
//                  and the bell itself is in nothing's way, so a bell with no
//                  chain on it is a bell nothing can reach.
//   IN THE WAY   - a bell whose collision shapes stop the player, the hook or
//                  the chain. The body has to exist in the world for the vine's
//                  load rope to have something to load, and it must be in the
//                  way of nothing, or the level is finished by rolling into the
//                  bell rather than by ringing it.
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
  COLLISION_CATEGORIES,
  isAnchorObject,
  isCollisionObject,
  maskFromPasses,
  normalizeLevelData,
  type LevelBodyData,
  type LevelData,
} from "./levelFormat";
import { LEVELS, listedLevels } from "./registry";
import { MASK_ALL } from "../engine/body";

export interface LevelCheck {
  name: string;
  pass: boolean;
  detail: string;
}

// Every anchor id in a body, so "is this vine hanging off the bell" is a
// question about the anchor it names rather than about a body index.
function anchorIdsOf(body: LevelBodyData): number[] {
  return body.objects.filter(isAnchorObject).map((o) => o.id);
}

// What a bell's collision shapes must NOT be in the way of: all three of them.
// The body is in the world so the vine has something with inertia to load, and
// it is in the way of nothing so the rope is the only handle (see
// `docs/collision-layers.md`).
function blocksAnything(body: LevelBodyData): boolean {
  const clear = maskFromPasses(COLLISION_CATEGORIES);
  return body.objects
    .filter(isCollisionObject)
    .some((o) => (maskFromPasses(o.passes) & ~clear & MASK_ALL) !== 0);
}

// The checks one listed level answers for itself.
function checkLevel(id: string, title: string, data: LevelData): LevelCheck[] {
  const where = `${id} ("${title}")`;
  const bells = data.bodies.filter((b) => b.bell === true);
  if (bells.length !== 1) {
    return [
      {
        name: `levels: ${where} has exactly one bell`,
        pass: false,
        detail:
          bells.length === 0
            ? "no body carries `bell`. A listed level ends at a bell; author one (or mark the level `unlisted`)."
            : `${bells.length} bodies carry \`bell\`. The build refuses a second, so this level does not open.`,
      },
    ];
  }
  const bell = bells[0]!;
  const ids = anchorIdsOf(bell);
  // The toll rope: a scene chain with one end bolted to the bell. Its other end
  // is the sally, and that end has to be on something that MOVES - a chain
  // between the bell and a static is a rope nailed to the wall.
  const ropes = (data.chains ?? []).filter((c) => ids.includes(c.a) || ids.includes(c.b));
  const sallyOf = (rope: (typeof ropes)[number]): LevelBodyData | undefined => {
    const far = ids.includes(rope.a) ? rope.b : rope.a;
    return data.bodies.find((b) => anchorIdsOf(b).includes(far));
  };
  const sally = ropes.length === 1 ? sallyOf(ropes[0]!) : undefined;
  return [
    {
      name: `levels: ${where} has exactly one bell`,
      pass: true,
      detail: "one bell body",
    },
    {
      name: `levels: ${where}'s bell is a pivot rigid body`,
      pass: bell.kind === "rigid" && bell.pivot === true,
      detail:
        bell.kind === "rigid" && bell.pivot === true
          ? "rigid, on a bearing"
          : `kind ${bell.kind}, pivot ${bell.pivot === true}. The ring is a swing about a bearing; a bell without one can never be rung.`,
    },
    {
      name: `levels: ${where}'s bell has exactly one toll rope`,
      pass: ropes.length === 1,
      detail:
        ropes.length === 1
          ? `chain ${ropes[0]!.a} -> ${ropes[0]!.b}`
          : `${ropes.length} chains anchored to the bell (anchors ${ids.join(", ") || "none"}). The rope is the only handle: the bell itself is in nothing's way.`,
    },
    {
      name: `levels: ${where}'s toll rope ends at a sally the player can hook`,
      pass: sally !== undefined && sally.kind === "rigid" && sally.pivot !== true,
      detail:
        sally === undefined
          ? "the rope's far end is on no body this level contains"
          : sally.kind === "rigid" && sally.pivot !== true
            ? "a free rigid body on the end of the rope"
            : `the rope ends on a ${sally.pivot ? "pivot" : sally.kind} body. A sally has to hang and be hauled, so it is a free rigid body.`,
    },
    {
      name: `levels: ${where}'s bell is in nothing's way`,
      pass: !blocksAnything(bell),
      detail: blocksAnything(bell)
        ? "a collision shape still collides. Clear player, hook and chain on every shape of the bell, or the level is finished by rolling into it."
        : "player, hook and chain all pass through",
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
