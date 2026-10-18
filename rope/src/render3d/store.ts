// Fetching every stored byte, and counting it - AHEAD OF THE APP.
//
// This file is not part of the app's module graph. It is compiled on its own and
// inlined into every page as a plain `<script>` by `storeScript` in
// vite.config.ts, so it runs while the browser is still parsing the HTML: the
// level's 26 MB starts arriving at ~40 ms, before a single byte of three.js has
// been asked for. `render3d/download.ts` is the app-side handle on it, and hands
// the loaders bytes this has already collected.
//
// WHY IT IS NOT AN IMPORT. It was one, loaded by its own `<script type="module"
// src>` ahead of `main.ts` - and vite merges every module script in a page into
// a single entry, so the tag disappeared and the code came back inside the
// 1.14 MB shared chunk, which is exactly the wait it exists to start before.
// Inlined, it cannot be merged into anything. The cost is a `window` global,
// which is what a script outside the graph has instead of an export, and it is
// declared in `globals.d.ts` so the app's side of it is still typed.
//
// WHY THE PAGE FETCHES AT ALL, rather than letting three.js do it. The loading
// screen needs a real fraction, and three.js offers two kinds of progress and
// neither is it: `LoadingManager` counts FILES, which across a 1.6 MB sky and a
// 12 KB mask is a bar that spends its life in the wrong place; and
// `FileLoader.onProgress` does report bytes, but `TextureLoader` does not use
// `FileLoader` - it loads through an `<img>`, which reports nothing at all, and
// images are most of what a level downloads. So the fetch is ours and the decode
// is still theirs: stream the response, count the chunks, and hand the loader a
// `blob:` URL over the bytes already held (see `withDownload`).
//
// Every file in the store is self-contained by construction - a `.glb` with its
// buffers and textures embedded, a `.webp`, a `.hdr` - so a loader given a blob
// URL has nothing relative left to resolve. That is a property of the pipeline:
// `assets:optimize` writes single-file GLBs. A pack that ever shipped with
// sidecar textures would have to keep its own path.
//
// THE SIZE COMES FROM THE MANIFEST, not from the response. Content-Length is
// only known once a request has been answered, and a browser answers six at a
// time: on a throttled connection the last file's headers arrive near the END of
// the load, so a bar measured against what had answered so far ran to 60% in two
// seconds and then stood still for ten while its own denominator caught up
// (measured on the production build at 4 Mbit). Every manifest entry carries its
// `bytes`, so the whole denominator is known before the first byte is asked for.

export {};

// What this browser has done with each level (see render/progress.ts). Bundled
// IN by esbuild, since this file is compiled on its own and inlined ahead of
// the app rather than imported by it.
import { readProgress, writeProgress } from "../render/progress";
import { DIFFICULTIES, levelHref, progressKey, type Ball } from "../render/difficulty";
// The panel the level select's `rate` link opens - the same one a finished
// level ends at, with its time and its exits left out. Bundled in for the same
// reason: this page never loads the app.
import { showCompletionForm } from "../render/completionForm";
import { submitFeedback, type Difficulty, type Stars } from "../playtest/feedback";

// One file being downloaded. Kept after it finishes: the bar's denominator is
// everything the page has asked for, not what is in flight this instant.
interface Download {
  // What the manifest says the file weighs.
  expected: number;
  received: number;
  done: boolean;
  // Decoded, and handed to the thing that will draw it (see `ready`). A file is
  // not progress towards playing until this: its bytes being here is half the
  // work.
  ready: boolean;
}

const downloads = new Map<string, Download>();

// Files started here that nobody has claimed yet, by URL. A claimed entry is
// dropped, so its blob is released once the loader that took it is done -
// holding all of them would keep the level's whole download resident for the
// life of the page.
const unclaimed = new Map<string, Promise<Blob>>();

// Whether this page carried a preload list at all. Only `index.html` does, so
// "nobody preloaded this" is worth reporting on that page and meaningless on the
// editor's.
let preloaded = false;

async function download(url: string, bytes: number): Promise<Blob> {
  const entry: Download = { expected: Math.max(0, bytes), received: 0, done: false, ready: false };
  downloads.set(url, entry);
  let res: Response;
  try {
    // LOW PRIORITY, and it is load-bearing. These are 26 MB of textures started
    // at first paint, and the browser gives six connections to a host: at
    // default priority they take all six and the page's OWN SCRIPTS queue behind
    // them, so `main.ts` arrived 46 s into a 3 Mbit load. Nothing can be decoded
    // before the app exists, so the bar's decode half stayed at zero while its
    // byte half climbed - a bar that crawls to the middle and then races - and
    // the level was not playable until long after its bytes were here.
    // Chrome schedules scripts ahead of these with the hint; browsers without
    // Priority Hints ignore the field, which is the behaviour above.
    res = await fetch(url, { priority: "low" } as RequestInit);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${url}`);
  } catch (err) {
    // A file that will never arrive must not hold the bar short of the end: the
    // caller is about to fall back to a generated surface, and the page is about
    // to be played.
    entry.expected = 0;
    entry.done = true;
    throw err;
  }
  // No stream to read (an opaque or already-buffered response): take the whole
  // body and count it in one go. The bar steps rather than sliding for this
  // file, which is better than not counting its bytes at all.
  if (!res.body) {
    const whole = await res.blob();
    entry.received = whole.size;
    entry.done = true;
    return whole;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      entry.received += value.byteLength;
    }
  } finally {
    // A failed read still leaves a finished file behind, for the reason above:
    // an entry that never settles is a bar that never fills.
    entry.done = true;
  }
  return new Blob(chunks as BlobPart[]);
}

// ---------------------------------------------------------------------------
// The preload list
// ---------------------------------------------------------------------------

// What the page inlines beside this script: a table of every file any level
// needs, and per level the indices into it. A table rather than a list per
// level because levels share surfaces, and this is markup that ships on every
// page load (~2 KB gzipped for the whole registry).
interface PreloadManifest {
  // Files, as [url, bytes].
  f: [string, number][];
  // Per level: `b` is 1 for a level that plays in 3D by default (the ball
  // controller), `i` are its indices into `f` in the order the scene will ask
  // for them, `t` is the title the level select shows, and `k` is where it
  // stands on that list - 0 unlisted, 1 listed, 2 the introduction.
  //
  // The title and the listing are HERE, in markup that already ships on every
  // page, because the menu is painted before the app exists and the app is
  // never loaded on the menu at all: reading them out of `registry.ts` would
  // mean downloading the level graph to draw a list of six words.
  l: Record<string, { b: 0 | 1; i: number[]; t: string; k: 0 | 1 | 2 }>;
  // The fallback for a `?level=` nobody has. A BARE url is the menu.
  d: string;
  // The tree this page was served from, and the hash of each level's own file:
  // what a piece of feedback left FROM THE MENU has to stamp itself with (see
  // `FeedbackSubmission`). The game page gets the same facts through
  // `virtual:tree-stamp` and `virtual:level-hashes`, which this page has no app
  // to import them with.
  c?: string;
  y?: 0 | 1;
  s?: string;
  h?: Record<string, string>;
}



// ---------------------------------------------------------------------------
// The level select
// ---------------------------------------------------------------------------

// THE DIFFICULTY SELECT, painted from here and shown by the app.
//
// The menu page (a bare `/`) is the introduction, loaded behind the loading
// bar like any level page, and the menu goes up only once that level is
// downloaded, warmed and prewarmed with both balls (`chooseDifficulty` in
// main.ts, Tris 2026-10-16: "load both ball models then just use whichever the
// user selects") - so picking a difficulty starts the run at once instead of
// starting a wait. Until 2026-10-16 it was a level select painted BEFORE the
// app was loaded, so that a list of six words did not cost a megabyte of
// three.js; with the level behind it there is nothing left to save.
//
// The markup and the painting stay here because the rows are links the store
// already knows how to make (the manifest's titles, `rope.progress`'s marks),
// and the app calls in through `window.__ropeMenu`.
//
// Every row is an `<a href="/?level=ID&ball=...">`, so middle-click, a screen
// reader and a bookmark all work, and a row opened any of those ways is an
// ordinary page at that level and ball.
// PICKING A DIFFICULTY STARTS THE LEVEL in THIS page rather than navigating to
// it, and takes the pointer if the page is ALREADY fullscreen.
//
// It does not take the screen. Fullscreen is offered beside the difficulties
// instead, as a button of its own (`offerScreen`), and is the player's to take
// or leave (Tris, 2026-10-18: "Selecting the difficulty should no longer
// automatically enter the user into fullscreen mode"). The pointer lock is
// still the pick's to take, because it is granted to a user gesture and to
// nothing else and this is the last press the page gets - but only into a
// fullscreen the player has chosen, since a lock held in a window is the one
// thing this game never allows (see input/aimPointer.ts). Taken here, a run
// started fullscreen opens with the virtual cursor live instead of waiting for
// the first click inside the level.
//
// IT CANNOT BE A NAVIGATION, and that is measured rather than assumed: a
// fullscreen taken on this page is gone by the time the next document loads
// (chromium 142, `document.fullscreenElement` null and `(display-mode:
// fullscreen)` false on the page the click opened), and a pointer lock never
// survives a navigation at all. A pick that threw both away would undo the
// button above it. So the anchor's default is prevented and the app already
// running in this document is handed the ball (`__ropePick`).
//
// What the navigation was for is kept: the URL becomes the level's, pushed
// rather than replaced so Back returns to the menu (and reloads it), and the
// session the run is recorded in opens at the pick, with the ball it picked.
// One page load is still one session, one level and one ball.
//
// Every OTHER way of opening a row is left alone: only a plain primary press is
// intercepted, so middle-click, ctrl/cmd-click and "open in new tab" still
// navigate - a background tab is not this tab going fullscreen.
function startOnClick(a: HTMLAnchorElement, manifest: PreloadManifest, id: string, ball: Ball): void {
  a.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // Nobody waiting for a pick - a menu re-painted after one was made - so
    // the link is the way in.
    const pick = window.__ropePick;
    if (!pick) return;
    e.preventDefault();
    if (manifest.l[id]?.b === 1) takePointer();
    history.pushState(null, "", a.href);
    // Back goes to the menu, which is this document with a run going in it,
    // so it is re-loaded rather than re-painted.
    window.addEventListener("popstate", () => location.reload());
    document.getElementById("menu")?.removeAttribute("data-show");
    pick(ball);
  });
}

// The pointer, for a run that starts fullscreen - and only then, since a lock
// held in a WINDOW is the one thing this game never allows (see `AimPointer`:
// windowed, chromium's Wayland pointer drifts out of the page and eats
// presses). A run picked windowed aims with the real pointer, and the canvas
// takes the lock on its own press if the player goes fullscreen later.
//
// The ball controller alone - the grapple controller aims with the desktop
// pointer and draws no reticle of its own, so capturing it would leave nothing
// to aim with. Best-effort: a refusal is the windowed aim, which works.
function takePointer(): void {
  const canvas = document.getElementById("game");
  if (!canvas || !document.fullscreenElement) return;
  void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
}

// GO FULLSCREEN, under the difficulties: the screen on its own press.
//
// The whole document rather than the frame, as everywhere else in the game
// (see `enterFullscreen` in main.ts). The screen ONLY, and no pointer lock with
// it: the menu is still up and is clicked with the desktop pointer, which a
// lock would take away. The pick takes the lock once the player has chosen
// (`takePointer`).
//
// Shown only while there is a fullscreen to go to: not once the page is in one
// (so it comes back if Esc leaves it), and never on a browser with no Fullscreen
// API at all (an iPhone), where the offer would be a button that does nothing.
function offerScreen(signal: AbortSignal, refocus: () => void): void {
  const box = document.getElementById("menu-screen");
  const button = document.getElementById("menu-fullscreen");
  if (!box || !button) return;
  const el = document.documentElement;
  if (typeof el.requestFullscreen !== "function") return;
  const show = (): void => {
    const was = !box.hidden;
    box.hidden = document.fullscreenElement !== null;
    // The button had the keyboard and has just gone: give it to a row rather
    // than to the page, or the arrows and Enter stop doing anything.
    if (was && box.hidden) refocus();
  };
  show();
  document.addEventListener("fullscreenchange", show, { signal });
  button.addEventListener(
    "click",
    () => {
      if (document.fullscreenElement) return;
      void Promise.resolve(el.requestFullscreen()).catch(() => {});
    },
    { signal },
  );
}

// The listeners the last paint left on what outlives it - the menu root, the
// fullscreen button and the document - so a re-paint (a rating sent from the
// menu) replaces them rather than stacking a second set beside them.
let menuPaint: AbortController | null = null;

function paintMenu(manifest: PreloadManifest, note: string): void {
  // The app calls this once the level is ready, by which time the document has
  // long been parsed; the wait is for a re-paint asked for any earlier.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => paintMenu(manifest, note), { once: true });
    return;
  }
  const root = document.getElementById("menu");
  const list = document.getElementById("menu-list");
  if (!root || !list) return;
  document.getElementById("loading")?.setAttribute("hidden", "");
  const noteEl = document.getElementById("menu-note");
  if (noteEl) noteEl.textContent = note;

  const progress = readProgress();
  // THE MENU OFFERS DIFFICULTIES, not levels: Normal and Hard, both of which
  // open the introduction - with the iron ball and with the glass one (see
  // render/difficulty.ts). The other listed levels are reached from there, by
  // the completion panel's Next Level, at the difficulty chosen here; and every
  // level is still reachable by its URL.
  const introId = introOf(manifest);
  const level = manifest.l[introId];
  if (!level) return;

  list.innerHTML = "";
  for (const option of DIFFICULTIES) {
    const id = introId;
    const key = progressKey(id, option.ball);
    const levelTitle = option.ball === "glass" ? `${level.t} (Hard)` : level.t;
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = levelHref(id, option.ball);
    startOnClick(a, manifest, id, option.ball);
    const title = document.createElement("span");
    title.className = "menu-title";
    title.textContent = option.label;
    a.appendChild(title);
    const done = progress[key];
    if (done) {
      const mark = document.createElement("span");
      mark.className = "menu-mark";
      mark.textContent = "done";
      a.appendChild(mark);
      if (done.stars !== null) {
        const stars = document.createElement("span");
        stars.className = "menu-stars";
        // Five glyphs always, so the ratings line up down the list.
        stars.textContent = "\u2605".repeat(done.stars) + "\u2606".repeat(5 - done.stars);
        a.appendChild(stars);
      }
    }
    li.appendChild(a);
    // RE-RATING, offered on every level this browser has finished, and THE ONLY
    // WAY BACK TO THE FORM: the completion flow asks once and never again (see
    // `completeLevel` in main.ts), so this link is what keeps a second opinion
    // reachable rather than a convenience beside it. A rating is about a level
    // rather than about a run, so it carries no session and no run, and it can
    // be left long after the play it is about (see docs/levels.md).
    if (done) {
      const rate = document.createElement("span");
      rate.className = "menu-rate";
      rate.tabIndex = 0;
      rate.role = "button";
      rate.textContent = "rate";
      const open = (): void => {
        void showCompletionForm({
          // Nothing was just played: this is a level the player finished
          // earlier and is saying something about now - so there is no time to
          // report and nothing to retry or move on from.
          eyebrow: "Rate",
          title: levelTitle,
          seconds: null,
          ask: {
            stars: done.stars as Stars | null,
            // `?? null` because an entry written before the scale existed has
            // no `difficulty` on it at all, and `undefined` is not an answer
            // the form knows how to open on (see render/progress.ts).
            difficulty: (done.difficulty ?? null) as Difficulty | null,
            comment: done.comment,
            submit: ({ stars, difficulty, comment }) => {
              // Locally FIRST, so a failed POST still keeps what was said - the
              // rule the completion flow follows (see `submitFeedback`).
              writeProgress(key, { ...done, stars, difficulty, comment, submittedAt: Date.now() });
              void submitFeedback({
                level: id,
                levelHash: manifest.h?.[id] ?? "",
                commit: manifest.c ?? "",
                dirty: manifest.y === 1,
                srcHash: manifest.s ?? "",
                stars,
                difficulty,
                comment,
                ...(option.ball === "glass" ? { ball: "glass" as const } : {}),
              });
              // The row's marks are behind the panel, which stays open: a
              // rating that did not show up on the list it came from would read
              // as not having landed.
              paintMenu(manifest, note);
            },
          },
          // One way out, and it is also what Esc runs (see
          // `showCompletionForm`): the menu is already the page underneath.
          actions: [{ label: "Close", run: () => {} }],
        });
      };
      rate.addEventListener("click", (e) => {
        e.preventDefault();
        open();
      });
      rate.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        open();
      });
      // Beside the row rather than inside its anchor: a link inside a link is
      // not a thing, and a tap on "rate" must not open the level.
      li.appendChild(rate);
      li.style.display = "flex";
      li.style.alignItems = "center";
      li.style.gap = "1ch";
      a.style.flex = "1";
    }
    list.appendChild(li);
  }

  root.dataset.show = "1";
  menuPaint?.abort();
  menuPaint = new AbortController();
  const { signal } = menuPaint;
  // Arrows move, Enter opens - which the anchors give for free once one of them
  // has the focus, and the fullscreen button under them is one more stop. The
  // first row takes it, so the keyboard works without a click and a player who
  // never touches the mouse still starts somewhere.
  //
  // Read afresh on every move, because the button comes and goes with the
  // fullscreen it offers (`offerScreen`).
  const button = document.getElementById("menu-fullscreen");
  const stops = (): HTMLElement[] => {
    const rows: HTMLElement[] = [...list.querySelectorAll("a")];
    if (button && !button.parentElement?.hidden) rows.push(button);
    return rows;
  };
  let at = 0;
  const focus = (i: number): void => {
    const all = stops();
    if (!all.length) return;
    at = (i + all.length) % all.length;
    for (const [k, el] of all.entries()) el.dataset.at = k === at ? "1" : "0";
    if (button && !all.includes(button)) button.dataset.at = "0";
    all[at]?.focus();
  };
  offerScreen(signal, () => focus(0));
  focus(0);
  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "ArrowDown") focus(at + 1);
      else if (e.key === "ArrowUp") focus(at - 1);
      else return;
      e.preventDefault();
    },
    { signal },
  );
  // A click anywhere on a row follows its link, which is what makes a tap on a
  // phone hit the whole row rather than the word in it.
  // Placed by where it is NOW, for the same reason the moves are.
  for (const el of [...list.querySelectorAll("a"), ...(button ? [button] : [])]) {
    el.addEventListener(
      "focus",
      () => {
        const i = stops().indexOf(el);
        if (i >= 0) focus(i);
      },
      { signal },
    );
  }
}

// Start the level's download now - or, on a bare URL, paint the menu instead.
//
// Everything here mirrors a decision `main.ts` makes later - which level, and
// whether it renders in 3D - because the whole point is to act on them before
// `main.ts` exists. They are small, stable rules, and the cost of them drifting
// is a page that preloads the wrong level's assets, which the "not in the
// preload list" warning below reports.
function preload(): void {
  const el = document.getElementById("preload-manifest");
  if (!el?.textContent) return;
  let manifest: PreloadManifest;
  try {
    manifest = JSON.parse(el.textContent) as PreloadManifest;
  } catch {
    return;
  }
  preloaded = true;
  const params = new URLSearchParams(location.search);
  const requested = params.get("level");
  const replay = params.get("replay");

  // NO LEVEL AND NO REPLAY IS THE MENU PAGE: the introduction, loaded like any
  // level, with the difficulty select offered once it is ready (see
  // `chooseDifficulty` in main.ts). The app paints it through `__ropeMenu`.
  //
  // A `?level=` NOBODY HAS is the menu page too, with a line saying so, rather
  // than silently playing something else: a mistyped or stale link that quietly
  // opens a different level is a link nobody can debug.
  if (replay === null && (requested === null || !manifest.l[requested])) {
    const note = requested === null ? "" : `There is no level called "${requested}".`;
    window.__ropeChoose = true;
    window.__ropeMenu = () => paintMenu(manifest, note);
    fetchLevel(manifest, introOf(manifest), params.get("render"));
    return;
  }

  fetchLevel(manifest, requested ?? manifest.d, params.get("render"));
}

// The introduction, which is the level the menu page loads and offers: the one
// level the manifest marks as such, or the default.
function introOf(manifest: PreloadManifest): string {
  return Object.entries(manifest.l).find(([, l]) => l.k === 2)?.[0] ?? manifest.d;
}

// Start every file a level's scene is going to ask for. `render` is the
// `?render=` override, or null for the level's own default.
//
// Its own function because there are two moments a level is chosen: a page
// loaded AT one (above), and one picked off the level select, which starts it
// in this same document (see `startOnClick`).
function fetchLevel(manifest: PreloadManifest, id: string, render: string | null): void {
  const level = manifest.l[id] ?? manifest.l[manifest.d];
  if (!level) return;
  // `?render=2d` is the escape hatch for a machine with no working WebGL, and a
  // page that is not going to build a 3D scene must not fetch 26 MB to not draw
  // (see `wants3d` in main.ts). The reverse - `?render=3d` on a grapple level -
  // is why the list is carried for every level rather than only the 3D ones.
  if ((render ?? (level.b ? "3d" : "2d")) !== "3d") return;
  for (const index of level.i) {
    const entry = manifest.f[index];
    if (!entry) continue;
    const [url, bytes] = entry;
    const started = download(url, bytes);
    unclaimed.set(url, started);
    // Nothing is awaiting this yet, and an unhandled rejection between here and
    // the claim would reach the console as an error the page has in fact
    // handled. Whoever claims it still sees the rejection.
    started.catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

// The loading screen's fill is written from HERE rather than from the app, for
// the same reason the fetching starts here: whoever draws the bar has to be
// running before the thing it is a bar FOR. Driven from `main.ts` the numbers
// were right from 94 ms and nothing put them on screen until 1050 ms
// (production) or 13 s (dev server), which on the screen is the same empty bar
// as before. `LoadingScreen` still owns the screen's life - the wait, and taking
// it off the page - and this owns the one value on it.
let fill: HTMLElement | null = null;
let polling = 0;
// The last fraction PUT ON SCREEN. The denominator grows when something asks
// for a file nothing had asked for yet, and a bar that runs backwards reads as a
// page that has lost its place, so what is displayed only ever climbs.
let shown = 0;

function paint(p: number): void {
  const next = Math.max(shown, Math.min(1, p));
  if (next === shown || !fill) return;
  shown = next;
  fill.style.setProperty("--p", `${next}`);
}

function tick(): void {
  polling = requestAnimationFrame(tick);
  // Looked up per frame until it is found: this script runs in the head, so the
  // element it writes to is further down the page and does not exist yet.
  fill ??= document.getElementById("loading-fill");
  const { received, total } = progressOf();
  // Nothing asked for yet - a level with no stored assets at all. An empty bar
  // is the honest picture of it.
  if (total > 0) paint(received / total);
}

// How far along the page is, in bytes - counting each file's bytes TWICE: once
// when they arrive, and once when they are decoded and ready to draw.
//
// THE BAR IS NOT A DOWNLOAD METER, because the download is not the wait. Over a
// real connection it is most of it, and a bar of bytes received was honest and
// linear. From localhost it is 8% of it: the level's 26 MB lands in 97 ms and
// the page is not playable for another 1.1 seconds, all of it decoding those
// bytes and putting them on the GPU - so the bar filled instantly and then sat
// there, which is the same defect as an empty bar and looks worse.
//
// Counting both halves fixes both ends, because decoding happens as files land
// rather than after them all: over a slow connection each file's two units
// accrue together and the bar stays linear, and over a fast one the first half
// arrives at once and the second fills as the decodes come in. Either way it is
// full when the level is ready, which is the only property that matters.
//
// It is deliberately NOT weighted by how long either half takes. Those
// durations differ by a factor of seventy between localhost and a phone, so no
// fixed split can track them; what a bar owes the reader is that it moves while
// work is happening and stops when the work stops.
//
// A file that finishes a little heavier or lighter than the manifest says (a
// re-published asset with a stale `bytes`, which `cli assets` is what catches)
// is reconciled on the spot rather than left to push the fraction past 1 or
// strand it short of it.
function progressOf(): { received: number; total: number } {
  let received = 0;
  let total = 0;
  for (const d of downloads.values()) {
    const size = d.done ? d.received : Math.max(d.expected, d.received);
    total += 2 * size;
    received += d.received + (d.ready ? size : 0);
  }
  return { received, total };
}

// The app's handle on all of the above (see `globals.d.ts`). A global rather
// than an export because this script is deliberately outside the module graph.
window.__ropeStore = {
  // The bytes of `url`, adopting the download already in flight for it if the
  // preload started one.
  claim(url: string, bytes: number): Promise<Blob> {
    const started = unclaimed.get(url);
    if (started) {
      unclaimed.delete(url);
      return started;
    }
    if (preloaded) {
      // The preload list and the scene disagree about what this level needs (see
      // levelAssets.ts). Nothing breaks - the file is fetched here instead, a
      // beat late - but the bar's denominator was wrong until this moment, and
      // the resolver is what wants fixing.
      console.warn(`[store] ${url} was not in the preload list`);
    }
    return download(url, bytes);
  },

  // This file has been decoded and handed to whatever will draw it, which is
  // the other half of its contribution to the bar (see `progressOf`).
  ready(url: string): void {
    const entry = downloads.get(url);
    if (entry) entry.ready = true;
  },

  // How much has arrived and how much is expected, in the bar's own units (see
  // `progressOf`). Read by the stall watchdog in `LoadingScreen.wait`.
  progress(): { received: number; total: number } {
    return progressOf();
  },

  // Fill the bar and stop driving it. Called from inside the frame that draws
  // the level, just before the screen is taken off the page (see
  // `LoadingScreen.finish`).
  endBar(): void {
    cancelAnimationFrame(polling);
    paint(1);
  },
};

// WHERE THE DESKTOP POINTER LAST WAS, in client pixels, noted from the earliest
// moment anything on this page could note it (read by `AimPointer.birthplace`).
//
// A level opens with the ball already facing the cursor, and windowed the cursor
// IS the desktop pointer - so the aim needs a position before the player has
// moved the mouse, and a mouse event is the only thing that ever reports one.
// The app cannot catch the one that matters: picking a level is the last press
// before the run starts, and the app's own listeners are built from inside that
// press's handler (`startOnClick` below boots it), so the position it carried is
// already history by the time there is anything listening.
//
// This script runs in the head of every page, which is as early as there is, so
// what it catches is the pointer crossing the menu and the press that started
// the level. A page nobody has touched - one loaded straight at `?level=`, with
// the mouse outside the window - leaves it unset, which is the honest answer:
// there is no position to face, and `AimPointer` falls back to its seed.
// A MOVE RIGHT AFTER A PRESS IS A WARP, not a hand: chromium re-bases the
// cursor position it reports whenever a button, a lock change or a fullscreen
// change goes through, and delivers the difference as an ordinary `mousemove`
// (see the trace in input/aimPointer.ts, which counts the same events for the
// same reason). Measured here on the level select: a press on a row at
// (640, 412) is followed one event later by `move 0,0 m=-650,-509`, and taking
// that at face value opens the level aiming at the top-left corner of the page.
//
// So a press is recorded - it is live, and it is the point the browser
// hit-tested the click at - and it makes the next move suspect, which is
// dropped. The move after that carries the warp's inverse and lands where the
// hand really is.
function watchPointer(): void {
  let suspect = 0;
  const moved = (e: MouseEvent): void => {
    if (suspect > 0) {
      suspect--;
      return;
    }
    window.__ropePointer = { x: e.clientX, y: e.clientY };
  };
  const pressed = (e: MouseEvent): void => {
    suspect++;
    window.__ropePointer = { x: e.clientX, y: e.clientY };
  };
  // Capture, so a handler that stops the event travelling cannot hide the
  // position from this; passive, because it is a note and never a preventable.
  addEventListener("mousemove", moved, { capture: true, passive: true });
  addEventListener("mousedown", pressed, { capture: true, passive: true });
}

preload();
watchPointer();
// Only a page with a preload list has a loading screen on it; the editor has
// none, and an animation frame a second forever is not something to leave
// running there.
if (preloaded) polling = requestAnimationFrame(tick);
