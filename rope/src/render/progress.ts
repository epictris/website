// WHAT THIS BROWSER HAS DONE WITH EACH LEVEL: completed, and the last rating
// left for it (see docs/levels.md).
//
// The level select reads it to draw its marks, the completion flow writes it,
// and the feedback form reads it back to pre-fill. It is kept in
// `localStorage` rather than on the server because it is a convenience rather
// than a record: the server already has the runs and the feedback, and a menu
// that cannot say what you have played until a fetch answers is a menu that
// flickers. Cross-device progress is a separate feature and is not this.
//
// EVERY ACCESS IS GUARDED, and not as a formality. `localStorage` throws
// outright in some privacy modes, comes back empty after the player clears
// site data, and is absent in a preview or a thumbnail capture - and the menu
// has to paint correctly with no storage at all, since the marks are the one
// thing on it that is not the offer.
//
// It is imported by `render3d/store.ts`, which is compiled on its own and
// inlined into the page ahead of the app, so nothing here may reach for
// anything outside it.

export interface LevelProgress {
  // When the level was first finished, ms since the epoch.
  completedAt: number;
  // The last rating left for it, or null for a completion with no rating -
  // which is what Skip leaves, and it is a real state rather than a missing
  // one: "played it, said nothing" is not "never played it".
  stars: number | null;
  comment: string | null;
  submittedAt: number | null;
}

export const PROGRESS_KEY = "rope.progress";

export function readProgress(): Record<string, LevelProgress> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, LevelProgress>)
      : {};
  } catch {
    return {};
  }
}

// Merge one level's progress in and write the lot back. Returns whether the
// write landed, which the caller may report and must not depend on: a rating is
// not a run, and losing one is tolerable.
export function writeProgress(level: string, entry: LevelProgress): boolean {
  try {
    const all = readProgress();
    all[level] = entry;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}
