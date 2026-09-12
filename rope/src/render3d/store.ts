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
  // controller), and `i` are its indices into `f`, in the order the scene will
  // ask for them.
  l: Record<string, { b: 0 | 1; i: number[] }>;
  // The level a bare URL plays, and the fallback for a `?level=` nobody has.
  d: string;
}

// Start the level's download now. Everything here mirrors a decision `main.ts`
// makes later - which level, and whether it renders in 3D - because the whole
// point is to act on them before `main.ts` exists. They are small, stable rules,
// and the cost of them drifting is a page that preloads the wrong level's
// assets, which the "not in the preload list" warning below reports.
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
  const level = (requested !== null && manifest.l[requested]) || manifest.l[manifest.d];
  if (!level) return;
  // `?render=2d` is the escape hatch for a machine with no working WebGL, and a
  // page that is not going to build a 3D scene must not fetch 26 MB to not draw
  // (see `wants3d` in main.ts). The reverse - `?render=3d` on a grapple level -
  // is why the list is carried for every level rather than only the 3D ones.
  const render = params.get("render") ?? (level.b ? "3d" : "2d");
  if (render !== "3d") return;
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

preload();
// Only a page with a preload list has a loading screen on it; the editor has
// neither, and an animation frame a second forever is not something to leave
// running there.
if (preloaded) polling = requestAnimationFrame(tick);
