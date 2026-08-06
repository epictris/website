# Plan: render debugging tooling

> **Status: implemented (2026-08-05).**
> All five phases landed; the discipline half is the **Debugging rendering** section in `rope/CLAUDE.md`, which is the live document.
> Four deviations, each with its reason:
>
> - **Phase 1's POST transport was never built.** It exists in the plan only to be retired by Phase 2, and the two landed as one arc, so the log comes back over CDP from the start. `vite.config.ts` is untouched and there is no `playtests/_shot-log.json`.
> - **The asset watchdog reports rather than gives up.** A page-side budget is measured on the virtual clock, and one mesh decode spends twenty virtual seconds, so a budget there fails healthy loads (it did, the first time). The page names what it is waiting for and the harness's wall clock is what fails the run.
> - **The late-frame blank flake did not reproduce**, in 20 consecutive gated runs at `--frame 40` or under the old runner, so it has no root cause written down. The plan's fallback landed instead: `shotMain` detects an all-black drawing buffer and fails loudly.
> - **`cli shot`'s PNG is now 1920x1080 rather than 1920x1167.** The retired window-size hack had been leaving an 87px letterbox band on every grab; the frame's own pixels are unchanged (a clean-tree grab diffs to 0 against the old runner's top 1080 rows).
>
> Original plan follows.
> Distilled from a meta-analysis of the 2026-08-04 water-renderer sessions (`4908deb9`, `1d1e9c16`).
> The finding: both sessions debugged the 3D renderer through an evidence channel that cannot see the failure class being debugged.
> Three separate "works in the headless screenshot, broken live" failures in one afternoon, all traceable to the page console being invisible to `cli shot`;
> two motion artifacts (foam flashing, wrong advection speed) structurally invisible to single-frame grabs, so the user served as the only detector across nine rejection rounds;
> and a morning of shader-constant tuning against geometry whose defects (Nyquist-violating sampling, UVs anchored to undisplaced vertices, earcut caps shearing under displacement) were measurable up front and never measured.
> This plan closes the tooling half; Phase 5 writes the discipline half into `CLAUDE.md`.

## Ground rules

- Every phase keeps `cli selftest` bit-identical and the bundle corpus healthy; everything here reads sim state and never feeds anything back into it.
- A clean tree's `cli shot` PNG output stays pixel-identical through every phase (assert with `cli shot --diff`); new pixels appear only when an error is being reported.
- No new npm dependencies.
  The CDP client in Phase 2 is Bun's own `fetch` + `WebSocket`; image work stays on ImageMagick, which the repo already requires.
- `shot.html` stays out of the build's rollup inputs; nothing here may grow the shipped app.
- Where a phase adds a detector, prove it red-then-green: re-introduce the historical defect named in its acceptance test, confirm the detector catches it, revert, confirm green.
- Follow repo conventions: comments state constraints, sentences own their lines in Markdown, no em dashes, Bash timeouts under 30s.

## Phase 1: the page console reaches the CLI

The single biggest gap.
A three.js shader compile error renders the mesh invisible and logs the diagnostic after the screenshot returns, so `cli shot --3d` reported "working" on code whose shader never compiled, three times in one session.
Zero THREE warnings surfaced across an entire day of renderer work.

What lands:

- **A page-side log buffer, installed before anything else runs.**
  An inline `<script>` in `shot.html`, ahead of the module script, wraps `console.log/info/warn/error`, `window.onerror` and `unhandledrejection` into `window.__shotLog: {level, text}[]`, then delegates to the originals.
  Inline and first because a module import that throws during evaluation must still be caught.
- **Shader errors are captured synchronously, before `shotReady`.**
  `Scene3D` gains an opt-in diagnostic mode (constructor flag or method, used only by `shotMain`): set `renderer.debug.checkShaderErrors = true` and install `renderer.debug.onShaderError` pushing the full program info log into `window.__shotLog`.
  `shotMain` then forces compilation to completion before its render - `renderer.compileAsync(scene, camera)` (or `compile` plus an explicit program-status sweep; investigate which one three's async pipeline actually blocks on) - so a compile failure exists in the buffer before the grab is taken.
  The requirement, stated as the acceptance test below: a GLSL error must be in the captured log by the time `shotReady` is set.
  The trap that motivates this: three defers `getProgramInfoLog` behind `KHR_parallel_shader_compile`, which is why the error historically arrived after the screenshot.
- **The buffer reaches the CLI.**
  A `POST /api/shot-log` endpoint beside the existing `levelApi` middleware in `vite.config.ts`, dev-only like the level API; `shotMain` posts the buffer just before setting `shotReady`, the server writes it next to the served bundle (`playtests/_shot-log.json`), and `cli shot` reads and deletes it after chromium exits.
  (Phase 2 replaces this transport with a CDP read of `window.__shotLog` and retires the endpoint; build it minimal.)
- **The CLI acts on it.**
  Every captured entry prints as `[page] <level>: <text>`.
  Any `error`-level entry fails the command (exit 1) unless `--allow-errors` is passed, because a screenshot taken over a page error is the most misleading possible answer to "does this look right".
- **A blank PNG explains itself.**
  On any `error`-level entry, `shotMain` paints a red banner with the first error line onto the 2D overlay canvas before `shotReady`, so the artifact itself says why it is wrong instead of being silently blank.

Acceptance:

- Red: re-introduce the foam include-order defect (a fragment-stage sample read before `normal_fragment_maps` declares it - see the GLSL include-order note in **Water** history / `rope-water-renderer` memory) and run `cli shot --3d`.
  The command must exit nonzero and print the compile log; the PNG must carry the banner.
- Green: revert; `cli shot` and `cli shot --3d` exit 0 with zero `[page]` errors, and the 2D PNG is pixel-identical to pre-phase output.
- The virtual-clock asset hang from 2026-08-04 (`fetch`+`createImageBitmap` never settling) would have printed nothing forever; add a `shotMain` watchdog that logs an error naming the unsettled state if `assetsSettled` has not resolved within the page's own budget, so the next hang is a named error rather than a blank page.

## Phase 2: the grab is gated on `shotReady`, not on a guessed time budget

`shotMain` sets `window.shotReady` and nothing has ever polled it; the grab fires when `--virtual-time-budget=20000` expires, which is a guess in both directions.
Too early is the late-frame blank flake (`shot --3d` at f35+ returning uniformly blank while 2D renders the same frame fine); too late is 6s median per grab, 56 grabs and 25 wasted minutes in one session.

What lands:

- **A CDP runner replacing `--screenshot` mode.**
  Launch chromium with `--headless --remote-debugging-port=0`, read the port from `DevToolsActivePort` in a throwaway `--user-data-dir`, connect over Bun's native `WebSocket`.
  Drive: `Emulation.setVirtualTimePolicy` (keep virtual time - it is what makes grabs reproducible), `Page.navigate`, poll `Runtime.evaluate("window.shotReady")`, then `Page.captureScreenshot` with a clip rect.
  The clip retires the measured "headless chromium keeps 87px of the window" hack.
- **Log retrieval moves onto the same channel.**
  Read `window.__shotLog` via `Runtime.evaluate` after `shotReady`; delete the Phase 1 POST endpoint and the `_shot-log.json` shuffle.
  Subscribe to `Runtime.consoleAPICalled` as well, so messages from contexts the inline hook cannot reach (workers, if any ever appear) are not lost.
- **Root-cause the late-frame blank flake.**
  With errors now visible and the grab gated on readiness, reproduce `shot --3d --frame 40` on a bundle from the corpus and find what actually blanks it; the memory note (`shot3d-blind-spots`) records the symptom, not the cause.
  Fix it or, if it is genuinely a SwiftShader defect, detect the all-black canvas in `shotMain` and log it as an error so it fails loudly.
- A hard wall-clock timeout (the current 30s server-wait discipline) so a hung page kills the run with the partial log printed, never a silent stall.

Acceptance:

- 20 consecutive `cli shot --3d --frame 40` runs on the same bundle produce non-blank images (changed-pixel count against a black frame above a floor) - the current runner cannot pass this.
- A deliberately never-ready page (temporarily skip setting `shotReady`) exits nonzero within the timeout with the partial log printed.
- Grab latency: median wall time per `cli shot` at or below the current runner's (expected well below - the poll fires the moment the page is ready).

## Phase 3: motion is evidencable in one command

Single frames cannot show flashing, flicker, or wrong advection speed.
The user was the only detector for both motion bugs; 36 grabs never flagged either.

What lands:

- **`cli shot bundle.json --frames A..B --every K [--3d]`** - one page load, one chromium session.
  `shotMain` replays to frame A, then loops: render, blit the composite (WebGL canvas plus 2D overlay) into the next tile of a filmstrip canvas, compute the changed-pixel count against the previous tile via `getImageData`, advance the sim K frames with the recording's own inputs.
  At the end the filmstrip replaces the visible canvases, per-pair diff counts land in `window.__shotLog`, `shotReady` fires.
  Tiles scale to a grid at most 1920 wide (4 columns is fine); the wall-clock flicker stays pinned (`pinClock` per rendered frame index, so animation driven by the sim advances and animation driven by the wall clock stays deterministic - advance the pinned clock by K/60 per tile so flipbook-style effects animate reproducibly).
- **The CLI prints the motion profile**: one line per adjacent pair, `f60->f70: 48211 px changed`, plus min/median/max.
  A flashing artifact is a spike pattern in that series; a steady flow is a flat one.
  No threshold gates it - this makes motion claims cheap to evidence, exactly as `--diff` does for stills.

Acceptance:

- A probe recording over the arena (spawn override near the point of interest, per the `shot3d-blind-spots` workaround) renders a strip whose tiles visibly animate.
- Red: introduce a frame-parity discontinuity into any wall-clock-driven effect (e.g. floor the pinned clock to 0.5s steps) - adjacent diff counts must show the alternating spike signature.
  Revert; counts return to a flat series.
- A `--frames` run costs one chromium session, not B-A/K of them.

## Phase 4: real-GPU numbers exist

Yesterday's performance question was answered with draw-call counts under SwiftShader at 2.87 s/frame.
No FPS number was ever produced, and tuned constants shipped unverified on real hardware.

What lands:

- **`window.__perf` on the game page**: a render-side probe updated once per second - rolling FPS, frame-time p50/p99 over the last second, `renderer.info.render.calls`/`triangles`, and `renderer.info.programs.length`.
  Read-only, allocated once, no sim access; absent in 2D mode except the FPS/frame-time half.
- **`?hud=1`**: extends the existing FPS counter with frame ms and draw calls on the overlay canvas, so a human eyeballing the live page sees the same numbers the probe exposes.
- **A documented live-verification workflow** (lands in the Phase 5 CLAUDE.md section): dev server + the claude-in-chrome extension - navigate to the level, read `window.__perf` by JS evaluation, screenshot on a real GPU, read the live console.
  This is the channel for FPS claims, tuned-constant sign-off, and anything SwiftShader cannot represent; `cli shot` remains the channel for reproducible geometry/shading evidence.

Acceptance:

- On the arena with water in frame, `__perf.drawCalls` equals `renderer.info.render.calls` read directly, and the HUD numbers move when the transmission-pass-style load is simulated (e.g. temporarily doubling prop draw distance).
- `bun run test` green; the probe adds nothing to any headless path.

## Phase 5: the discipline is written down

`CLAUDE.md` already carries **Debugging physics issues** and its discipline block; both sessions violated the same principles in the render domain because nothing states them there.

What lands - a **Debugging rendering** section in `rope/CLAUDE.md`, parallel to the physics one, carrying:

- **A headless screenshot without its captured console is not evidence.**
  A shader change is claimed working only with a clean `[page]` log (Phase 1) or a live-browser check (Phase 4 workflow).
- **Motion claims need multi-frame evidence.**
  Anything animated - flicker, advection, flow speed - is evidenced with `--frames` (Phase 3), never a single grab.
- **No tuning on unmeasured geometry.**
  Sampling density against the highest harmonic, UV anchoring, triangulation shape are checkable numbers; check them before touching an aesthetic constant.
  Constants tuned against broken geometry are rework, all of them (the 2026-08-04 morning session is the case study).
- **Prefer the textbook, renderer edition.**
  Before hand-rolling a visual effect, survey what three.js ships and what the established technique is - the same rule the physics side states as "what does Box2D do".
- **Two rejected aesthetic rounds mean stop.**
  Re-derive the approach and ask for a reference image rather than burning the user as a per-round oracle; nine rounds happened because no rule said stop.
- **Performance claims need real-GPU numbers.**
  SwiftShader draw-call and triangle counts are proxies and must be labelled as such; FPS comes from the Phase 4 workflow.

And the bookkeeping the plan's own rule demands:

- Update **What the verification suite cannot see**: the "real renderer has no automatic check" entry shrinks to what remains true (nothing *gates* renders; perceptual quality still has no oracle), and the console-blindness and motion-blindness halves are removed as each phase lands.
- Update the **Headless tooling** command block with the new `shot` flags and the failure semantics.

## Order and independence

Phase 1 first; it is the evidence channel every later phase reports through, and it is the phase that would have caught all three of yesterday's silent failures.
Phase 2 builds directly on it and retires its transport; land them as one arc if possible.
Phases 3 and 4 are independent of each other and of Phase 2 (Phase 3 is nicer post-2 - one session instead of N - but works on the Phase 1 runner).
Phase 5 lands last and only documents what actually shipped; each earlier phase is not done until its blind-spot entry is retired there.
