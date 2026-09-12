# The loading screen

A flat `#1f2430` page - the tris.sh background - with a white bar on it and the line *Mouse recommended*, covering the page from the first paint until the level's assets are down.
It is `#loading` in `index.html`, filled by `src/render3d/store.ts` (inlined into the page, ahead of the app), and taken off by `src/render/loadingScreen.ts` from the first frame `main.ts` draws.

**The markup is in the HTML, not built by the game.** The wait it covers starts before the game exists: three.js and the level code are a megabyte of their own, and a screen painted by a module could only appear once that module had arrived - which is most of the way through the thing it was meant to cover.
In the HTML it is on the first frame the browser produces.

**So is the download, and so is the bar.** Everything that has to happen while the app is still arriving is in `src/render3d/store.ts`, which is compiled on its own and inlined into every page as a plain `<script>` (`storeScript`, vite.config.ts).
It runs during HTML parsing: it reads the preload list inlined beside it, starts fetching the level's files, counts the bytes, and writes the bar's fill on the animation frame.
`main.ts` arrives later and adopts downloads that are already well under way (`render3d/download.ts` is its handle on the store, through `window.__ropeStore`).

Both halves had to move, and each was measured moving on its own:

| | bar visible | first asset byte | bar starts filling |
|---|---|---|---|
| production, before | 65 ms | 240 ms | 1050 ms |
| dev server, before | 64 ms | 1530 ms | 13 s |
| either, now | ~65 ms | ~95 ms | ~65 ms |

(Throttled to 20 Mbit in headless Chromium, which is where the empty-bar end of it is visible at all.)

And at the other end, between the bar filling and the level appearing, measured in a real browser on localhost: **1100 ms before, 4 ms now** - see the warm frame below.

Starting the fetch earlier fixed nothing on screen by itself: the numbers were right from 94 ms and nothing *painted* them until `main.ts` booted, which is the same empty bar as before.
A bar drawn by the app cannot move until the app has finished downloading, which is exactly the part of the wait a bar is for.

The dev-server row is the one to read twice. Vite serves 5.2 MB of unbundled modules there, so `main.ts` starts 1.5 s in - what looks like a broken loading screen when you are testing is mostly that, and the shipped page was never as bad as it looked.

**It is a `window` global rather than an import** because vite merges every `<script type="module">` in a page into one entry: loaded as its own tagged module the tag simply disappeared and the code came back inside the 1.14 MB shared chunk, which is the wait it exists to start ahead of.
Inlined it cannot be merged into anything, and `globals.d.ts` keeps the app's side of it typed.

**The preload list is resolved at build time** by `levelStoredFiles` (`src/render3d/levelAssets.ts`), which answers "what will this level download" by walking the level data - the same question `Scene3D.setLevel` answers by building the scene, asked where there is no canvas to build one on.
Every level's list is inlined into `index.html` as one shared file table (~2 KB gzipped for the whole registry), keyed by level id, because `?level=` picks the level before the app can.
`?render=2d` preloads nothing, for the reason it exists: a page that will not build a 3D scene must not fetch 26 MB to not draw it.

Nothing can prove the resolver and the scene agree - they walk the same data by different routes - so the guard is at the other end: the store **warns when a file is asked for that the preload list did not name**, which turns drift into a console line the first time the level is played rather than a bar that stops at 94%.
The resolver's 36 files for `BALL` and the 36 the browser actually requests are currently the same 36.

**It is also the gate.** `main.ts` does not call `requestAnimationFrame` until the wait is over, so the level is not stepping behind an opaque rectangle - on a slow connection the ball would be falling, and the first thing handed to the player could be a dead run.
This is the one place the game deliberately waits for an asset; everywhere else a late asset is the design and the generated surface is what is drawn until it lands (see `assetsSettled`).
The wait gives up after **15 s with nothing arriving at all** - a stall, not a wall clock. Nothing in the store is required to draw a level, so a load that never lands costs a slow start and not the session, and the page says in the console which asset it gave up on.
It was a 30 s ceiling, which is less than the honest download time for 26 MB on anything under 8 Mbit: at 3 Mbit the screen was taken away 36 s in, half the level still arriving, and the player was handed an arena wearing fallback surfaces.
A clock cannot tell a hung fetch from a slow connection. Progress is progress however slow; what must not be waited on is a connection that has stopped.
**The scene is warmed behind the screen, from the camera the first frame will use.**
`warmFrame` (main.ts) draws the scene onto the covered canvas every 150 ms while the level is still downloading, and once more when it settles.
Texture upload, mip generation, program compilation and the shadow map all happen on first use, and first use used to be the two frames after the download finished: **546 ms of full bar with nothing on screen**, on a page whose steady-state frame is 1 ms of draw.

Which of those costs it was took three attempts to find, and the two wrong answers are worth keeping:

- compiling every program in the scene up front (`compilePrograms`) cost 278 ms and took **nothing** off the renders that followed;
- uploading every texture up front (`initTexture` over the whole scene) took 80 ms off 450.

The actual fault was the CAMERA. The pre-render drew from the camera's initial pose - the origin, since `CameraController` had not run yet - so it warmed whatever happened to be at the origin, and the first real frame, drawn after the controller had put the camera on the avatar, paid the full cost again for the part of the level that is on screen.
Running the controller first, against the same follow point the first frame uses, took that 546 ms under 100 ms over a throttled connection.

**Warm on every frame, not on a timer.** The timer was written for a slow connection, where there are seconds of download to spread the work across.
From localhost there is no such window: the bytes are in at 228 ms and the app does not exist until 700, so a 150 ms tick fired about once, warmed a scene that was still mostly fallback textures, and left the real upload to pile into one 309 ms frame after the bar was already full.
On every frame it is 82 ms, and it is inside the wait rather than after it.

**MEASURE THIS IN A REAL BROWSER, and a visible one.** Headless Chromium on ANGLE gets the cold-frame costs wrong in both directions, and worse, a tab that is not the foreground tab never fires `requestAnimationFrame` at all - so the warm loop never runs, the game never starts, and the page reports timings for a load that did not finish.
Two rounds of this were measured in a background tab before that was noticed. `scratchpad/marks-visible.ts` in a session's scratch is the shape that works: a real window, no `--headless`, no ozone override, driven over CDP.
**There is no fade.** The screen is removed from inside the frame callback that has just drawn both canvases, so the removal and the picture are composited together and the swap is one frame: full bar, then game.
Taken off any earlier the page would show a frame of bare canvas, and faded it would show a quarter of a second of neither, after the wait it exists to cover is already over.

**The bar counts each file's bytes TWICE: once when they arrive, and once when they are decoded.**
It is not a download meter, because the download is not the wait.
Over a real connection it is most of it; **from localhost it is 8%** - the level's 26 MB lands in 228 ms and the page is not playable for another two seconds, all of it decoding those bytes and putting them on the GPU.
A bar of bytes received was honest and linear over a throttled link and filled instantly and sat there on a fast one, which is the same defect as an empty bar and looks worse.

Counting both halves fixes both ends, because decoding happens as files land rather than after them all: over a slow connection each file's two units accrue together and the bar stays linear, and over a fast one the first half arrives at once and the second fills as the decodes come in.
It is deliberately **not** weighted by how long either half takes - those durations differ by a factor of seventy between localhost and a phone, so no fixed split can track them.
What a bar owes the reader is that it moves while work is happening and is full when the work is done.

**The preload fetches at LOW priority, and that is what keeps the halves together.**
A browser gives six connections to a host, and 26 MB of textures started at first paint take all six: the page's own scripts queue behind them, and at 3 Mbit `main.ts` arrived **46 seconds** into the load.
Nothing can be decoded before the app exists, so the decode half sat at zero while the byte half climbed - a bar that crawls to the middle and then races - and the level was not playable until long after its bytes were here.
With `fetch(url, { priority: "low" })` the same load has every script in at **7.1 s** and the two halves within ten points of each other the whole way down.
A browser without Priority Hints ignores the field and gets the old behaviour, which is a slower start rather than a broken one.

**The store is the one place stored bytes are fetched:** it streams each response, counts the chunks, and hands the loader a `blob:` URL over the bytes it already holds, so the fetch is ours and the decode is still three.js's.
That indirection exists because neither kind of progress three.js offers is the one a bar needs - `LoadingManager` counts FILES, which across a 1.6 MB sky and a 12 KB mask is a bar that spends its life in the wrong place, and `FileLoader.onProgress` does report bytes but `TextureLoader` does not use `FileLoader`: it loads through an `<img>`, which reports nothing, and images are most of what a level downloads.
Every file in the store is self-contained by construction (a GLB with its buffers and textures embedded, a WebP, an HDR), so a loader handed a blob URL has nothing relative left to resolve; a pack that ever shipped with sidecar textures would need its own path.
`cli shot --diff` over the same frame before and after the change: **0 pixels**.

The download half's total is read off **`bytes` in the manifest** rather than off Content-Length, and that is the whole difference between a bar and a decoration.
A browser answers six requests at a time and queues the rest, so on a throttled connection the last file's headers arrive near the END of the load: measured against what had answered so far, the bar ran to 60% in two seconds and then stood still for ten while its own denominator caught up (production build, 4 Mbit).
Stated up front it is simply true - at a fixed throttle the bar fills linearly, and it stands still exactly when the connection does.
Nothing on the screen animates on its own: an empty bar means nothing has arrived, which is a thing worth being able to see.
