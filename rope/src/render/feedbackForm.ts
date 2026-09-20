// The form a level ends at: five stars, a comment, Submit and Skip.
//
// It appears twice and from two pages, which is what shapes it. On the GAME
// page it comes up over the frozen level when the line has been crossed (see
// `completeLevel` in main.ts); on the LEVEL SELECT it comes up from a row's
// `rate` link. The level select never loads the app at all, so this file has to
// run without it - no three.js, no level, no renderer, nothing from `main.ts`.
// It is imported by `render3d/store.ts`, which is compiled on its own and
// inlined ahead of the app, and separately by `main.ts`.
//
// Both optional, and that is the point rather than a convenience: a form that
// insists on a rating collects a rating from people who did not have one, which
// is worse than no answer. Skip is a first-class outcome and is recorded as a
// completion with nothing said - which is why SUBMIT is dark until one of the
// two has been filled in: an empty submission is a skip that cost a round trip.

import { MAX_COMMENT, type Stars } from "../playtest/feedback";

export interface FeedbackFormOptions {
  // What the heading names. The TITLE rather than the id: the player is being
  // asked about the thing they just played, not about a registry key.
  title: string;
  // The line above it, which is WHY the form is here: "Finished" from a run
  // that has just crossed the line, and something else from the level select's
  // `rate`, where nothing was played and saying so would be a lie about what
  // just happened.
  eyebrow: string;
  // The last thing this player said about this level, to open on. A re-rating
  // that started blank would read as the old one having been lost.
  stars: Stars | null;
  comment: string | null;
  // Called with whatever the player settled on, before the form closes.
  // `skipped` is a dismissal rather than an empty submission, and the caller
  // treats the two differently: a skip still records the completion locally and
  // sends nothing.
  submit(result: { stars: Stars | null; comment: string | null }): void;
  skip?(): void;
}

// Resolves when the form is dismissed, either way.
export function showFeedbackForm(opts: FeedbackFormOptions): Promise<void> {
  const root = document.getElementById("complete");
  const eyebrow = document.getElementById("complete-eyebrow");
  const heading = document.getElementById("complete-heading");
  const starsEl = document.getElementById("complete-stars");
  const commentEl = document.getElementById("complete-comment") as HTMLTextAreaElement | null;
  const submitEl = document.getElementById("complete-submit") as HTMLButtonElement | null;
  const skipEl = document.getElementById("complete-skip");
  // A page whose markup has no form in it (the editor, `shot.html`) resolves
  // rather than throwing - the same courtesy `LoadingScreen` extends to a page
  // with no `#loading` on it.
  if (!root || !eyebrow || !heading || !starsEl || !commentEl || !submitEl || !skipEl) {
    return Promise.resolve();
  }

  let stars: Stars | null = opts.stars;
  eyebrow.textContent = opts.eyebrow;
  heading.textContent = opts.title;
  commentEl.value = opts.comment ?? "";
  commentEl.maxLength = MAX_COMMENT;

  // Five buttons rather than a radio group or a range: a star is a thing you
  // press, and it has to be pressable with the keyboard as well as clicked -
  // which `<button>` gives outright.
  starsEl.innerHTML = "";
  const buttons: HTMLButtonElement[] = [];
  // SUBMIT IS OFF UNTIL THERE IS SOMETHING TO SEND. An empty submission and a
  // skip are the same act - the level was finished and nothing was said - so
  // offering both was offering the same button twice, and the one that POSTs a
  // blank rating is the one that costs a round trip to say nothing.
  //
  // Disabled rather than hidden, and Skip stays lit beside it, so the way out
  // of an empty form is always visible (see `#complete-buttons button:disabled`
  // in index.html).
  const said = (): boolean => stars !== null || commentEl.value.trim() !== "";
  const paint = (): void => {
    for (const [i, b] of buttons.entries()) {
      const on = stars !== null && i < stars;
      b.textContent = on ? "★" : "☆";
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
    buttons.push(b);
    starsEl.appendChild(b);
  }
  paint();

  return new Promise<void>((resolve) => {
    let done = false;
    const close = (): void => {
      if (done) return;
      done = true;
      root.setAttribute("hidden", "");
      document.removeEventListener("keydown", onKey, true);
      commentEl.removeEventListener("input", paint);
      resolve();
    };
    const onSubmit = (): void => {
      const text = commentEl.value.trim().slice(0, MAX_COMMENT);
      opts.submit({ stars, comment: text || null });
      close();
    };
    const onSkip = (): void => {
      opts.skip?.();
      close();
    };
    const onKey = (e: KeyboardEvent): void => {
      // Esc is Skip, which is the dismissal every dialogue has. Capture, so a
      // star button with the focus does not swallow it.
      if (e.key === "Escape") {
        e.preventDefault();
        onSkip();
      }
    };
    // Typing is the other half of what turns Submit on, so the comment drives
    // the same repaint the stars do.
    commentEl.addEventListener("input", paint);
    submitEl.addEventListener("click", onSubmit, { once: true });
    skipEl.addEventListener("click", onSkip, { once: true });
    document.addEventListener("keydown", onKey, true);

    root.removeAttribute("hidden");
    // The first star takes the focus, so Enter and Space work without a click
    // and a keyboard player can rate and submit by tabbing. It never takes the
    // pointer lock - the form is a thing to point at.
    buttons[0]?.focus();
  });
}
