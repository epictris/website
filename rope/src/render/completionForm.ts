// THE PANEL A LEVEL ENDS AT: what the run took, what the player thought of it,
// and the three ways on - Retry, Next Level, Menu.
//
// It is one panel with two halves, and the halves are answerable at different
// rates. The TIME and the exits are what every crossing needs: a level that
// finishes has to say what it took and has to be leavable, every single time.
// The FEEDBACK half is asked for once - the first crossing, or any later one
// where nothing has been sent yet - because a form put in front of someone who
// has nothing new to say collects an answer they did not have, and a level
// worth replaying is exactly the level whose form would be in the way on every
// lap (see `completeLevel` in main.ts). The way back to it afterwards is the
// menu row's `rate` link.
//
// SENDING DOES NOT CLOSE THE PANEL. The two acts are unrelated - one posts a
// rating, the other decides what to play next - and a Submit that navigated
// would be a form that punishes answering it by taking the level away. Submit
// posts, says so, and leaves the player exactly where they were, with the exits
// still under their hand.
//
// It is built from two pages, which is what shapes the rest. On the GAME page
// it comes up over the frozen level; on the LEVEL SELECT it comes up from a
// row's `rate` link with no time and no exits but Close. The level select never
// loads the app at all, so this file has to run without it - no three.js, no
// level, no renderer, nothing from `main.ts`. It is imported by
// `render3d/store.ts`, which is compiled on its own and inlined ahead of the
// app, and separately by `main.ts`.
//
// Every feedback field is optional, and that is the point rather than a
// convenience: a form that insists on a rating collects a rating from people
// who did not have one, which is worse than no answer. SUBMIT is dark until one
// of the three has been filled in, which follows from the same thing - an empty
// submission is a round trip that says nothing - and dark again once what is on
// screen is what was last sent, so pressing it twice cannot append the same
// answer twice.

import { DIFFICULTY_LABELS, MAX_COMMENT, type Difficulty, type Stars } from "../playtest/feedback";

// What the player said, and what `submit` is handed.
export interface FeedbackAnswers {
  stars: Stars | null;
  difficulty: Difficulty | null;
  comment: string | null;
}

// One way out of the panel. The panel closes first and then runs it, so a
// `run` that navigates does not leave the form painted over the page it is
// leaving.
export interface CompletionAction {
  label: string;
  run(): void;
}

export interface CompletionFormOptions {
  // What the heading names. The TITLE rather than the id: the player is being
  // asked about the thing they just played, not about a registry key.
  title: string;
  // The line above it, which is WHY the panel is here: "Finished" from a run
  // that has just crossed the line, and something else from the level select's
  // `rate`, where nothing was played and saying so would be a lie about what
  // just happened.
  eyebrow: string;
  // Seconds from the level's first frame to the crossing, or null where there
  // was no run - the menu's `rate`, which is about a level rather than about a
  // play of it and has no time to report.
  seconds: number | null;
  // The feedback half, or null to leave it out because this player has already
  // sent something about this level.
  ask:
    | (FeedbackAnswers & {
        // Called on every press of Submit, which may happen more than once: the
        // store is append-only and a player who changes their mind after
        // sending has said a second thing rather than corrected the first (see
        // `playtest/feedback.ts`).
        submit(answers: FeedbackAnswers): void;
      })
    | null;
  // The ways out, in order, left to right. THE LAST ONE IS THE DISMISSAL: it is
  // what Esc runs, so it wants to be the one that costs nothing - Menu on the
  // game page, Close on the menu. There is no way to close the panel without
  // running one of these, because on the game page there is nothing behind it
  // but a level that has stopped stepping.
  actions: CompletionAction[];
}

// `M:SS.CC`, which is the one format that reads as a time at every length a
// level can take. Fixed-width by construction, and it stays a time rather than
// becoming "83.45" the moment a run goes over a minute.
function formatTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

// Resolves once an action has been chosen and run.
export function showCompletionForm(opts: CompletionFormOptions): Promise<void> {
  const root = document.getElementById("complete");
  const eyebrow = document.getElementById("complete-eyebrow");
  const heading = document.getElementById("complete-heading");
  const timeEl = document.getElementById("complete-time");
  const timeValue = document.getElementById("complete-time-value");
  const askEl = document.getElementById("complete-ask-section");
  const starsEl = document.getElementById("complete-stars");
  const diffEl = document.getElementById("complete-difficulty");
  const commentEl = document.getElementById("complete-comment") as HTMLTextAreaElement | null;
  const submitEl = document.getElementById("complete-submit") as HTMLButtonElement | null;
  const thanksEl = document.getElementById("complete-thanks");
  const buttonsEl = document.getElementById("complete-buttons");
  // A page whose markup has no panel in it (the editor, `shot.html`) resolves
  // rather than throwing - the same courtesy `LoadingScreen` extends to a page
  // with no `#loading` on it. The caller's actions are NOT run: a page with no
  // panel never showed the player a choice, and running one of them for them
  // would navigate a page that asked for nothing.
  if (
    !root || !eyebrow || !heading || !timeEl || !timeValue || !askEl || !starsEl ||
    !diffEl || !commentEl || !submitEl || !thanksEl || !buttonsEl
  ) {
    return Promise.resolve();
  }

  eyebrow.textContent = opts.eyebrow;
  heading.textContent = opts.title;
  if (opts.seconds === null) {
    timeEl.setAttribute("hidden", "");
  } else {
    timeValue.textContent = formatTime(opts.seconds);
    timeEl.removeAttribute("hidden");
  }

  // ---- the exits -----------------------------------------------------------
  //
  // Built rather than written into the markup because how many there are is a
  // property of where the panel came from: the last level in the list has no
  // Next Level to offer, and a level nobody just played has nothing to retry.
  buttonsEl.innerHTML = "";
  const cleanups: (() => void)[] = [];
  return new Promise<void>((resolve) => {
    let done = false;
    const close = (action: CompletionAction | null): void => {
      if (done) return;
      done = true;
      root.setAttribute("hidden", "");
      for (const off of cleanups) off();
      // The panel comes off FIRST, so an action that navigates is not doing it
      // from under a dialogue that is still painted over the page.
      action?.run();
      resolve();
    };

    for (const [i, action] of opts.actions.entries()) {
      const b = document.createElement("button");
      b.type = "button";
      // The first is the one the panel leads with, which on a finished level is
      // Retry: the player who just crossed the line and wants another go is the
      // one who should not have to read the row.
      if (i === 0) b.dataset.primary = "1";
      b.textContent = action.label;
      b.addEventListener("click", () => close(action), { once: true });
      buttonsEl.appendChild(b);
    }

    const onKey = (e: KeyboardEvent): void => {
      // Esc runs the LAST action, which is the cheap one. Capture, so a control
      // with the focus does not swallow it. Dismissing to nothing is not on
      // offer: on the game page the level behind this has stopped stepping, so
      // a panel that closed into it would be a picture the player is stuck in.
      if (e.key !== "Escape") return;
      const last = opts.actions.at(-1);
      if (!last) return;
      e.preventDefault();
      close(last);
    };
    document.addEventListener("keydown", onKey, true);
    cleanups.push(() => document.removeEventListener("keydown", onKey, true));

    // ---- the feedback half -------------------------------------------------
    if (!opts.ask) {
      askEl.setAttribute("hidden", "");
      // Nothing takes the focus: a focused star reads as a rating already
      // given, and the panel is a thing to point at. Tab still reaches every
      // control.
      root.removeAttribute("hidden");
      return;
    }
    const ask = opts.ask;
    askEl.removeAttribute("hidden");
    thanksEl.setAttribute("hidden", "");

    let stars: Stars | null = ask.stars;
    let difficulty: Difficulty | null = ask.difficulty;
    commentEl.value = ask.comment ?? "";
    commentEl.maxLength = MAX_COMMENT;

    // What was last POSTED, so Submit can go dark on an answer already sent and
    // come back the moment the player changes one. Null until the first send;
    // a re-rating opened on what was said before starts SENT, because that is
    // what it is - the store has it already.
    let sent: string | null = ask.stars === null && ask.difficulty === null && !ask.comment
      ? null
      : JSON.stringify([ask.stars, ask.difficulty, ask.comment ?? ""]);

    // Five buttons rather than a radio group or a range: a star is a thing you
    // press, and it has to be pressable with the keyboard as well as clicked -
    // which `<button>` gives outright.
    starsEl.innerHTML = "";
    diffEl.innerHTML = "";
    const starButtons: HTMLButtonElement[] = [];
    const diffButtons: HTMLButtonElement[] = [];

    const state = (): string =>
      JSON.stringify([stars, difficulty, commentEl.value.trim().slice(0, MAX_COMMENT)]);
    // SUBMIT IS OFF UNTIL THERE IS SOMETHING NEW TO SEND. An empty submission
    // says nothing and costs a round trip to say it; a repeat submission
    // appends a second identical record, which is worse - the store is
    // append-only precisely so that two records mean two opinions.
    const said = (): boolean =>
      (stars !== null || difficulty !== null || commentEl.value.trim() !== "") && state() !== sent;
    const paint = (): void => {
      for (const [i, b] of starButtons.entries()) {
        // A star rating FILLS UP TO the answer, because that is what a star
        // rating is: three stars is three of them lit.
        const on = stars !== null && i < stars;
        b.textContent = on ? "★" : "☆";
        b.dataset.on = on ? "1" : "0";
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
      for (const [i, b] of diffButtons.entries()) {
        // The difficulty scale LIGHTS ONE, because it is bipolar: filling up to
        // "Just right" would read as a ramp, and a ramp is the answer this
        // scale exists to avoid giving (see `Difficulty` in
        // playtest/feedback.ts).
        const on = difficulty === i + 1;
        b.dataset.on = on ? "1" : "0";
        b.setAttribute("aria-pressed", on ? "true" : "false");
      }
      submitEl.disabled = !said();
    };

    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "complete-star";
      b.setAttribute("aria-label", `${i} star${i === 1 ? "" : "s"}`);
      b.addEventListener("click", () => {
        // Pressing the star that is already the rating CLEARS it, so a rating
        // left by accident can be taken back without the form having a sixth
        // control for "actually, nothing".
        stars = stars === i ? null : (i as Stars);
        paint();
      });
      starButtons.push(b);
      starsEl.appendChild(b);
    }
    // The scale carries its own words rather than numbers under a pair of end
    // captions: "4 out of 5" for difficulty is the ramp reading again, and the
    // point of the thing is that the middle is the good answer.
    for (let i = 1; i <= 5; i++) {
      const d = i as Difficulty;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "complete-diff";
      b.textContent = DIFFICULTY_LABELS[d];
      b.addEventListener("click", () => {
        // Pressing the answer already given clears it, exactly as a star does -
        // the same escape from a press nobody meant.
        difficulty = difficulty === d ? null : d;
        paint();
      });
      diffButtons.push(b);
      diffEl.appendChild(b);
    }

    const onSubmit = (): void => {
      if (!said()) return;
      const text = commentEl.value.trim().slice(0, MAX_COMMENT);
      sent = state();
      ask.submit({ stars, difficulty, comment: text || null });
      // The panel STAYS. What changes is that the send is acknowledged and
      // Submit goes dark until something is edited, so the player can see their
      // answer went somewhere without being thrown out of the page for it.
      thanksEl.removeAttribute("hidden");
      paint();
    };
    // Typing is the third thing that turns Submit on, so the comment drives the
    // same repaint the two scales do.
    commentEl.addEventListener("input", paint);
    submitEl.addEventListener("click", onSubmit);
    cleanups.push(() => {
      commentEl.removeEventListener("input", paint);
      submitEl.removeEventListener("click", onSubmit);
    });
    paint();

    root.removeAttribute("hidden");
  });
}
