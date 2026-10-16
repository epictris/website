// The two difficulties the menu offers, and what each one is.
//
// A difficulty is a BALL, not a different level: Normal is the iron ball and
// Hard is the glass one, which is the same ball in every number the sim reads
// but breaks on the first solid thing it touches (see `BallLevelOptions` and
// `BallLevel.shatterIfStruck`). Both play the same level file, so what a page
// is playing is the pair - the level and the ball - and both halves are in its
// URL (`?level=BALL&ball=glass`).
//
// Shared by the menu (`render3d/store.ts`, which is compiled on its own and
// cannot import the app) and the app (`main.ts`), so it imports nothing.

export type Ball = "iron" | "glass";

// Not `Difficulty`, which is the feedback form's "how hard was it" answer (see
// `playtest/feedback.ts`) - a different question with the same word in it.
export interface DifficultyOption {
  label: string;
  // What the row says under its label: what the choice actually changes.
  hint: string;
  ball: Ball;
}

export const DIFFICULTIES: readonly DifficultyOption[] = [
  { label: "Normal", hint: "an iron ball", ball: "iron" },
  { label: "Hard", hint: "a glass ball - it breaks on anything solid", ball: "glass" },
];

// The page that plays `level` with `ball`. Iron is the plain level URL, which is
// what every link from before the difficulties was.
export function levelHref(level: string, ball: Ball): string {
  const at = `/?level=${encodeURIComponent(level)}`;
  return ball === "glass" ? `${at}&ball=glass` : at;
}

// Where a level's progress is kept in `rope.progress` (see render/progress.ts),
// per difficulty: finishing Hard is not finishing Normal, and the reverse.
// Normal keeps the bare level id, so every entry written before the
// difficulties is still Normal's.
export function progressKey(level: string, ball: Ball): string {
  return ball === "glass" ? `${level}:hard` : level;
}
