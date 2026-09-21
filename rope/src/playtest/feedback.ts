// What a player says about a level, on the wire and on disk.
//
// Shared by the page that sends it and the store that keeps it, so a field
// cannot be renamed on one side only - the rule `playtest/protocol.ts` follows
// for runs, and for the same reason.
//
// APPEND-ONLY. Every submission is a new line; nothing is overwritten and
// nothing is deduplicated, so a player who rates a level, plays it again and
// rates it differently leaves two records and the second does not erase the
// first. That is the whole point of collecting it: what changed between them is
// the thing worth reading, and a store that kept only the latest would have
// thrown it away.

export const FEEDBACK_PATH = "/api/playtest/feedback";
export const ADMIN_FEEDBACK = "/api/playtest/admin/feedback";

// The cap on a comment, in characters. Generous for a sentence or two and far
// under the body limit, so a comment can never be the reason a submission is
// refused for size.
export const MAX_COMMENT = 2000;

// At most this many submissions from one address an hour, the same shape of
// guard `NEW_SESSIONS_PER_IP_PER_HOUR` puts on sessions. Higher than that one
// because rating is a thing a player does repeatedly and on purpose.
export const FEEDBACK_PER_IP_PER_HOUR = 60;

export type Stars = 1 | 2 | 3 | 4 | 5;

// HOW HARD IT FELT, on a BIPOLAR scale: 3 is "just right" and the two ends are
// the two ways of being wrong. It is not a 1..5 ramp wearing different labels,
// and the difference is the whole reason the field exists - "2 out of 5 for
// difficulty" is either an easy level or a badly tuned one, and a record that
// cannot say which is a record of nothing. What is wanted from a playtest is
// which SIDE of right a level fell on, and by how far.
//
// Five points rather than three because "a bit" and "way too" are different
// reports - one is a level to nudge and the other is a level to rebuild - and
// rather than seven because a monospace panel has five columns' worth of room
// and a scale nobody can read the ends of is a scale that collects noise.
export type Difficulty = 1 | 2 | 3 | 4 | 5;

// The scale's own words, here rather than in the markup because the form is
// built twice from two pages and both build it from this file (see
// `render/completionForm.ts`). The LABEL is the question: a bare row of five
// boxes is a ramp again, and the player has to be able to see that the middle
// is the good answer without hovering anything.
export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: "Way too easy",
  2: "A bit easy",
  3: "Just right",
  4: "A bit hard",
  5: "Way too hard",
};

export interface FeedbackSubmission {
  // The registry id, and the hash of the level FILE it is about (see
  // `levelFileHash` in sim/treeStamp.ts). The hash is what makes two ratings
  // comparable across every change to the tree that was not a change to the
  // level.
  level: string;
  levelHash: string;
  // The tree the page was served from, exactly as a run carries it.
  commit: string;
  dirty: boolean;
  srcHash: string;
  // All three optional: a player may rate without saying anything, say
  // something without rating, or skip and leave none of it - and "played it,
  // said nothing" is a real answer rather than a missing one.
  stars: Stars | null;
  // How hard it felt, on the bipolar scale above. Optional for the reason the
  // other two are: a player who has no opinion about the difficulty has to be
  // able to say the rest without inventing one.
  //
  // ABSENT on a record written before this field existed, which is what
  // append-only costs and is cheaper than the alternative: readers take
  // `difficulty ?? null` and "never asked" and "asked, no answer" are the same
  // blank in a listing, which is the truth about both.
  difficulty: Difficulty | null;
  comment: string | null;
  // The run that finished the level, when the form came from a crossing rather
  // than from the level select's `rate`. Absent from a re-rating, which is
  // about the level rather than about a run.
  session?: string;
  run?: number;
  completedFrame?: number;
}

// Send one. Returns whether the store took it, and the caller must not depend
// on that: progress is written LOCALLY first, so a failed POST - a dev page
// with no `serve.ts` beside it, a flaky network - still leaves the level
// marked as played. There is no retry, and that is deliberate: a rating is not
// a run, losing one is tolerable, and the player can rate again from the menu.
//
// `credentials: "same-origin"` is what carries the `pid` cookie, which is the
// whole of the attribution (see `FeedbackRecord.player`).
export async function submitFeedback(body: FeedbackSubmission): Promise<boolean> {
  try {
    const res = await fetch(FEEDBACK_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface FeedbackRecord extends FeedbackSubmission {
  id: string;
  // The `pid` cookie, resolved or minted exactly as ingest does, so a player's
  // runs and their ratings share an id and the admin's rename, merge and delete
  // reach both.
  player: string;
  ip: string;
  // The SERVER's clock, not the page's: a client clock is a thing a client
  // controls.
  at: number;
  // What the server was serving when this arrived. A submission carries the
  // page's own stamp above; these two are the server's, so a client lying about
  // either is visible rather than believed.
  hereCommit: string;
  hereLevelHash: string;
}
