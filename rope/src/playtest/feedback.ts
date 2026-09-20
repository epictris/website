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
  // Both optional: a player may rate without saying anything, say something
  // without rating, or skip and leave neither - and "played it, said nothing"
  // is a real answer rather than a missing one.
  stars: Stars | null;
  comment: string | null;
  // The run that rang the bell, when the form came from a ring rather than from
  // the level select's `rate`. Absent from a re-rating, which is about the
  // level rather than about a run.
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
