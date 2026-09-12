# Debugging rendering

The physics loop above has a section of discipline because every rule in it was paid for by a debugging day.
The renderer now has one for the same reason: the 2026-08-04 water sessions violated all six of these, and each cost hours.

- **A headless screenshot without its captured console is not evidence.**
  A three.js shader that fails to compile draws nothing and reports the reason only in the page log, so a grab of it looks like an ordinary picture of a scene with something missing.
  Three separate "works in the headless screenshot, broken live" failures happened in one afternoon that way, and zero THREE warnings were seen across a whole day of renderer work.
  `cli shot` now captures `window.__shotLog` (installed by an inline script in `shot.html`, ahead of the module, so a module that throws while evaluating is caught too), prints every entry as `[page] <level>: ...`, **exits nonzero on any `error`** unless `--allow-errors` is passed, and paints a red banner onto the PNG so the artifact says why it is wrong.
  Shader errors are surfaced synchronously before `shotReady`: `Scene3D`'s diagnostic mode (opt-in, `shotMain` only) sets `checkShaderErrors` and an `onShaderError` reporter, and `compilePrograms()` walks every material's program and asks it for its uniforms - which is the call that actually runs three's link check, since neither `compile()` nor `compileAsync()` does.
  A change to a shader is claimed working only with a clean `[page]` log or a live-browser check.
- **Motion claims need multi-frame evidence.**
  Flashing, flicker, wrong advection speed and anything else that only exists BETWEEN frames are structurally invisible to a single grab, and the user was the only detector for two such bugs across 36 grabs and nine rejection rounds.
  `cli shot bundle --frames A..B --every K [--3d]` replays once, draws a labelled filmstrip and prints the changed-pixel count between adjacent tiles, plus min/median/max.
  A steady flow is a flat series and a flashing artifact is a spike pattern in it; the wall clock is pinned per tile (`pinClock(frame / 60)`) so wall-driven animation advances with the sim rather than with when the command was run.
  Nothing gates on the numbers - this is `--diff` for motion, making the claim cheap to evidence rather than assertable.
  Note the whole frame is measured, so a moving camera swamps a small effect: profile a scene at REST when the thing being measured is the animation itself.
- **No tuning on unmeasured geometry.**
  Sampling density against the highest harmonic, UV anchoring and triangulation shape are checkable numbers, and a morning went into tuning aesthetic constants over geometry whose defects were all three at once.
  Check them before touching a constant; constants tuned against broken geometry are rework, all of them.
- **Prefer the textbook, renderer edition.**
  Before hand-rolling a visual effect, survey what three.js ships and what the established technique is - the same rule the physics side states as "what does Box2D do".
  It cuts both ways: `Water2` was surveyed and correctly rejected, with the reasons written down under [**Water**](water.md), which is worth as much as adopting it would have been.
- **Two rejected aesthetic rounds mean stop.**
  Re-derive the approach and ask for a reference image rather than burning the user as a per-round oracle.
  Nine rounds happened because no rule said stop.
- **Performance claims need real-GPU numbers.**
  Headless chromium runs SwiftShader: the ball arena draws at **4 fps / 250 ms a frame** there and at 60 fps on the 2D path in the same browser, so a frame time measured through `cli shot` is a number about SwiftShader.
  Draw-call and triangle counts ARE transferable and are worth quoting; label them as what they are.
  FPS comes from the live page (below).

## The live-verification workflow

`cli shot` is the channel for reproducible geometry and shading evidence.
The live browser is the channel for anything SwiftShader cannot represent: frame rate, tuned-constant sign-off, and the page's own console.

1. `cd rope && bun run dev`.
2. Drive Chrome with the claude-in-chrome extension (or a human): navigate to the level, `?hud=1` for the on-screen instruments, `?level=NAME` and `?render=2d|3d` as usual.
   **F3 toggles the panel while playing**, which is the form a human wants: the frames worth looking at are the ones being played, not the ones after a reload with a different URL.
3. Read `window.__perf` by JS evaluation - `{fps, frameMs, frameMsP50, frameMsP99, cpuPct, gpuMs, heapMb, drawCalls, triangles, programs, w5}`, rewritten once a second (`render/perfProbe.ts`).
   The 2D path reports the FPS half and zeros for the rest, since it has no draw calls to speak of.
4. Screenshot on a real GPU, and read the live console.

`?hud=1`/F3 draws exactly those numbers under the FPS counter, so what a human eyeballs and what a script reads cannot disagree.
The probe is render-side, allocated once, and touches no sim state, so it can never reach the fixed step.

**A tab the browser has backgrounded renders nothing.**
`requestAnimationFrame` stops when `document.visibilityState` is `hidden`, and a claude-in-chrome screenshot resumes it for the length of the capture - so the panel a script grabs off an unfocused window is a page starting from cold every time, showing 120 ms frames and near-empty graphs.
Check `document.visibilityState` before believing any live reading, and get the window focused (or ask the user to look) rather than reporting the capture's own stall as the game's frame time.

### What the four rows actually measure

The browser exposes no process CPU and no GPU utilisation, so each row is the honest proxy rather than a task-manager figure, and saying which is which is the difference between an instrument and a decoration:

- **frame** - wall time between rendered frames. The 60 Hz and 30 Hz budgets are the dashed lines on its graph.
- **cpu** - the MAIN THREAD's busy fraction: the previous frame callback's own wall time over the interval it was spent in. 100% means the loop IS the frame; a low number beside a high frame time means the wait is elsewhere (GPU, compositor, vsync).
  Pairing a callback with the `dt` measured *before* it ran reports ratios of two different intervals - it once read 339% - so the loop deliberately reports last frame's cost against this frame's `dt`.
- **gpu** - the GPU's own clock around `renderer.render`, via `EXT_disjoint_timer_query_webgl2` (`render/gpuTimer.ts`). The CPU-side bracket around the same call measures command submission and cannot see a GPU-bound frame at all.
  Queries retire a few frames late and must be polled every frame whether or not a new one is opened; a pool that fills while nothing drains it freezes the reading at its last value for ever, which is what it did.
  Unavailable (and labelled so) on the 2D path and on any driver without the extension.
- **ram** - `performance.memory.usedJSHeapSize`, Chromium-only, polled at 4 Hz. **JS objects only**: textures, geometry and the drawing buffers are GPU memory and appear in no browser API.

Each row carries its five-second average and worst alongside a graph of the same window (`render/perfHistory.ts`, 50 buckets of 100 ms; `w5` in the snapshot is the same fold).
The graphs scale to the window's 90th percentile rather than its worst column, so one 250 ms stall does not flatten five seconds of 7 ms frames into a line along the floor - the spike runs off the top, and the exact figure is the `max` on the row above.
Memory is the exception on both counts: it is not zero-based and it is not clipped, because a heap's shape is its reading.

## What a grab is doing under the hood

`cli shot` drives chromium over CDP (`src/tools/shotRunner.ts`, Bun's own `fetch` and `WebSocket`, no dependency) rather than through `--screenshot`.
Three things follow, and each replaced a guess:

- **The grab is gated on `window.shotReady`**, which the page had always set and nothing had ever polled.
  A grab is taken the moment the page says it is done (a 2D frame in ~0.6 s, a dressed 3D one in ~1.3 s) instead of when a 20 s virtual-time budget expires.
  A page that never becomes ready fails the command inside the wall-clock timeout (`--timeout`, 30 s) with its partial log printed, rather than stalling.
- **`Emulation.setDeviceMetricsOverride` plus a clip** fix the viewport at the game's own 1920x1080 frame.
  That retired the "headless chromium keeps 87px of the window" hack, which never worked: every grab carried an 87px letterbox band along the bottom.
  The frame's pixels are unchanged - a clean-tree grab diffs to 0 against the old runner's top 1080 rows.
- **Virtual time is gone**, and the wall-clock timeout is the only ceiling.
  `Emulation.setVirtualTimePolicy` used to bracket the navigation so the page's clocks ran as fast as its work allowed. What it also does, on chromium 142, is stop OFF-MAIN-THREAD IMAGE DECODING from ever completing: `createImageBitmap` of a JPEG or a WebP returns a promise that never settles, while PNG - decoded on the main thread - is unaffected.
  That is every 3D grab in the project, because `assets:optimize` puts every prop's textures through `--texture-compress webp` and `GLTFLoader` takes the `ImageBitmapLoader` path whenever `createImageBitmap` exists: the mesh promise never resolves, `assetsSettled` never returns, and every scene at once fails with `still waiting for assets: mesh "..."` - which reads as the renderer being broken rather than as an emulation setting.
  The grab does not need it. What makes a picture reproducible is that the page pins its own clock (`Scene3D.pinClock`), waits for every asset before it draws, and is polled on `shotReady` rather than on elapsed time, so the frame is the same frame whether the wall took 1 s or 5; virtual time was only buying speed.
  For the same reason the page does not give up on its assets by its own clock; it names what it is still waiting for (`still waiting for assets: mesh "sewer-arch"`) and the harness's wall clock is what fails the run.

`shotMain` also reports a **blank 3D frame** as an error (`Scene3D.litFraction()`, read off the drawing buffer), since an empty frame is a valid PNG that every other view calls healthy.
The historical late-frame blank flake did not reproduce in 20 consecutive gated runs at `--frame 40`, nor under the old runner, so its cause is still unidentified; what exists now is the detector, which is the half that makes the next occurrence loud instead of silent.
