# rope

A 2D grappling-hook character-controller playground.
**TypeScript port** of a C#/Godot prototype (`~/projects/character_controller`), rewritten so it runs in the browser and can be shared with friends to playtest.
The novel part is the rope: it models the rope as a sequence of **wrap points around scene geometry** (PBD length + friction solver), not as evenly spaced segments.

This file is the map, and it stays under 200 lines.
The reasoning, the numbers and the postmortems behind every mechanic live in `docs/`, one file per area (index at the bottom); new material goes there, not here.
**Read the doc for the area you are changing before editing it**, and update it in the same change - a doc that lags the code is how the same bug gets found twice.

## Stack

There is **no game engine dependency**: Godot's physics (`MoveAndSlide`, `RigidBody2D`, raycasts and shape queries) was reimplemented from scratch in `src/engine/` so the simulation is self-contained and deterministic.
Bun runs everything; three.js draws the optional 3D scene; the level editor is a dev-only page.

## Running

```sh
cd rope
bun install
bun run dev        # http://localhost:3100
bun run test       # THE suite: typecheck + every case suite + every playtest + the bundle corpus
```

`?level=NAME` picks a level (`src/level/registry.ts`); `BALL` (the ball & chain controller, 3D) is the default and the grapple levels stay 2D.
`?render=2d|3d`, `?hud=1` (F3 in play), `?aim=cursor|position|motion`, `?probe3d=1`.
`/editor` is the level editor.
**P** downloads a replayable session bundle stamped with the served tree.
Controls, gamepad and touch mapping, the level list and the aim modes: [docs/running.md](docs/running.md).

## Rules that hold everywhere

- **Metres, seconds, kilograms, a fixed 1/60 step.** Pixels exist only in rendering and pointer un-projection. Classify every new constant's dimension ([physics-foundations](docs/physics-foundations.md)).
- **The sim never calls platform `Math` transcendentals.** Everything under `src/engine`, `classes`, `lib`, `level`, `input`, `playtest` and the replay path of `sim` goes through `engine/dmath.ts` (`Mathf`, `Vec2`); `cli dmath` scans for the banned members and `**`.
- **Bit-identity is the contract.** `replay selftest` must stay bit-identical, and every bundle in `playtests/regressions/` replays; a change that diverges recordings does so on purpose and says so. Mobile-body behaviour is gated behind `isMobile`/`isRotating` branches so the static path never moves.
- **Render-side state never reaches the sim**: the camera, render interpolation, sparks, the slack drape and the perf probe read the world and write nothing back.
- **A body has many shapes.** `primaryShape()` is only for a body asking about itself; whole-body geometry goes through `bodyOverlapCircle` / `bodySweepCircle` / `bodySweepConvex` / `bodyContainsPoint`. `obj` identity answers "moves as one piece", `shape` identity answers "same surface", and every collision question is the second.
- **`rect` stays its own kind** beside `poly` - its closed-form paths are what every recorded replay went through.
- **New physics state ships with detectors** (digests and invariants) in the same change, before playtesting.
- **`expectedFail` is a lie the moment it passes**: the runner fails on a marker whose case goes green, so the fix that closes a gap removes the marker.
- **Levels are `levels/*.json`** in the on-disk pixel format, imported into `registry.ts`. `levelData.ts` is generated (`bun scripts/extract-level.ts`), never hand-edited. Every retired form is folded in by `normalizeLevelData` inside `scaleLevelData`, the one gate every level passes through.
- **The editor autosaves 750 ms after any edit**, so an open editor tab is a second author of a level file. Close it before a script touches a level.
- **Binary assets live in a GitHub release**, not git. Every manifest entry pins `sha256` and `bytes` and names `source`, `author` and `license` (redistributable, NC acceptable here); `CREDITS.md` is generated and checked by `cli assets`.

## Working practices

Every one of these was paid for with a debugging day; the receipts are in [debugging-physics](docs/debugging-physics.md) and [debugging-rendering](docs/debugging-rendering.md).

- **Record a browser bundle against every physics change and run `cli diverge` on it.** Headless validation cannot see the browser; the bundle's own `selfReplay` verdict cannot see a browser-vs-bun difference.
- **No fix before a measured cause.** State the root cause with a number from a replay, probe or trace before editing the solver. A theory that fits the code is not a diagnosis.
- **Your own evidence beats your own theory.** When a trace contradicts the hypothesis, the trace wins. When the corpus passes without a guard, the guard goes.
- **Red then green.** A fix for a reported bundle needs a detector that is red on that bundle before the fix and green after; prove it by temporarily reverting.
- **A second report of the same symptom means audit the class**, not the instance: grep for the pattern and fix or rule out every site.
- **Two failed attempts means revert and report.** A precise diagnosis with no fix beats a half-fix in the tree.
- **Prefer the textbook.** Rigid bodies: "what does Box2D do". Rendering: "what does three.js ship". Both cut both ways - a rejected technique with the reasons written down is worth as much as an adopted one.
- **A one-frame spike is almost never the solver being wrong about this frame**; it is the solver being right about a discontinuity that was allowed to build up. Look for the drift first.
- **Name what green cannot see.** Before claiming a fix verified, say which blind spots apply and what covered them (a probe, a render, or "needs a manual playtest for X"). The current list is in [debugging-physics](docs/debugging-physics.md#what-the-verification-suite-cannot-see).
- **A bundle whose tree does not match is evidence about a different tree.** Every replaying command prints `tree: match` or `tree: MISMATCH`.
- **Edit source with the Edit tool, never scripted string replacement**; compare against a git revision (`cli compare --ref`), never a `git stash` round trip.
- **A headless screenshot without its captured console is not evidence**, motion claims need a filmstrip (`cli shot --frames`), and frame-time claims need a real GPU and a foreground tab. Two rejected aesthetic rounds mean stop and ask for a reference image.

## The debugging loop

1. **Capture**: reproduce in the browser and press **P**, or `cli record script.json --out session.json` headlessly.
2. **Make it red**: drop the bundle in `playtests/bundles/` and run `cli bundles`. If `cli replay` says DIVERGED, run `cli diverge` first - a bundle that does not replay is a determinism finding. Then `cli scan` before choosing a frame.
3. **Locate**: `cli query --frame N` for the whole state, `cli dump` for the digest table, `cli trace` for per-phase Δv/Δω/Δp, `--solve` to open the length solve.
4. **Inspect**: `cli continue` with scripted input, `cli render` / `cli chainpath` for geometry, `cli shot` (`--3d`, `--frames`, `--diff`) for what the player sees, `cli settle` to watch it come to rest.
5. **Verify**: `bun run test`, then `cli compare --ref <rev>` for one frame or `cli ab --ref <rev>` over a corpus, because a diverged recording's tail cannot confirm a fix.

Every command is listed with its purpose in [headless-tooling](docs/headless-tooling.md).

## Where things live

| Path | What |
|---|---|
| `src/engine/` | bodies, shapes, collision, manifolds, the contact solver, `World`, `dmath`, `trig` |
| `src/classes/` | `Player` state machine, `BallPlayer`, `BallHook`, `Rope`, `SlackChain` |
| `src/lib/` | pure geometry: polygon decomposition, stroke, path, keyframes, rail, viscous, manacle, span sweep |
| `src/level/` | level format, `buildBodies`, chains, vines, movers, registry, generated `levelData.ts` |
| `src/sim/` | invariants, digests and traces, the case suites (`*Cases.ts`), the playtest runner, rigs |
| `src/tools/` | `cli.ts` and the headless shot runner |
| `src/render/`, `src/render3d/` | the 2D and 3D renderers, camera controller, sparks, asset manifests |
| `src/editor/` | the level editor |
| `src/input/` | input sources, the button latch, aim pointer, input trace |
| `src/playtest/`, `src/server/`, `serve.ts` | production run recording and its store |
| `playtests/` | scripts, `rigs/`, the committed `regressions/` corpus, gitignored `bundles/` scratch |
| `levels/`, `plans/`, `docs/`, `scripts/` | authored levels, design plans, the docs below, asset and level pipelines |

## Docs

Foundations

- [physics-foundations](docs/physics-foundations.md) - units, mass and materials, determinism and `dmath`, shapes and compound bodies, known simplifications.
- [running](docs/running.md) - commands, controls, URL parameters, the level list, the tree stamp, ball controls and aim modes.

The ball and chain

- [ball-chain](docs/ball-chain.md) - the chain phase: push-out order, the blocked-length lease, the spin rollback, the winch, sprung and pivot anchors, the pair separation, the wind stall.
- [ball-rolling](docs/ball-rolling.md) - the steered ball's grip, spin traction on a fresh contact, the loop cap and the loop ride.
- [ball-coil-and-hook](docs/ball-coil-and-hook.md) - the coil as an angle, how the hook attaches (sweep, blocking contact, seam, reach), the dangling tip and scene catch.
- [manacle](docs/manacle.md) - the edge-on ring, its hinge pin, driven rotation, the bite and the mounted cuff.
- [slack-chain-drape](docs/slack-chain-drape.md) - the visual-only drape of a chain with length to spare.
- [wrap-detection](docs/wrap-detection.md) - the continuous span sweep and its two exclusions.
- [sparks](docs/sparks.md) - hook and ball sparks on hook-proof steel, render-side by construction.

Rope geometry and surfaces

- [hook-surfaces](docs/hook-surfaces.md) - hook-proof and chain-through pieces, hook-only bodies.
- [rails](docs/rails.md) - authored curves the cuff clamps around and slides along.
- [viscous-surfaces](docs/viscous-surfaces.md) - mud: the cuff sinks, creeps and drops out.
- [scene-chains](docs/scene-chains.md) - authored chains, the coupled sweep, the settle, anchors and wrap points.
- [vines](docs/vines.md) - pass-through link chains, the load rope, stiffness, spans, sleep, drawing, authoring.
- [vine-ring](docs/vine-ring.md) - the manacle threaded onto a vine as a creeping ring.

Bodies and the solver

- [contact-solver](docs/contact-solver.md) - positional recovery, the sequential-impulse solver, resting contacts, the position pin.
- [areas-and-friction](docs/areas-and-friction.md) - force areas, surface friction, stiction on scenery, the stall tolerance, area glyphs.
- [water](docs/water.md) - the drag law, traction loss, and why there is no 3D water renderer.
- [pivot-and-spring-bodies](docs/pivot-and-spring-bodies.md) - pivots, authored bearings with torsion springs, spring mounts, spawn at rest.
- [movers](docs/movers.md) - scripted pendulums, rotors and routed platforms, with keys and the contact-speed bar.
- [sleep](docs/sleep.md) - the displacement-window rest rule, what wakes a body, settle at build.

Tooling

- [headless-tooling](docs/headless-tooling.md) - every `cli` command, `bun run test`, the invariants, full-world digests, mechanic tests and rigs.
- [debugging-physics](docs/debugging-physics.md) - the loop in full, past root causes, the discipline, what the suite cannot see.
- [debugging-rendering](docs/debugging-rendering.md) - renderer discipline, the live-verification workflow, the perf rows, how a grab works.
- [production-recording](docs/production-recording.md) - runs streamed from swing.tris.sh, `/admin`, `replay pull`.
- [input-latch](docs/input-latch.md) - sub-step clicks, the input trace, and the Chromium Wayland pointer-lock drop.

Editor and levels

- [editor](docs/editor.md) - gestures, selection, vertex editing, the 3D view, orbit, the lens, the gizmo, the depth handle, ▶ Test.
- [editor-model](docs/editor-model.md) - layers, the body outliner, decoration, notes, compound bodies.
- [level-format](docs/level-format.md) - level files, the dev REST API, autosave, `levelFormat.ts`, regenerating `levelData.ts`.

Camera

- [camera](docs/camera.md) - the fixed frame, follow and hand-off, regions and buffers, render interpolation, the screen-edge guarantee and its latch.
- [camera-paths](docs/camera-paths.md) - authored routes with lookahead, keys, corridors, falloff and the windowed projection.

Rendering

- [render3d](docs/render3d.md) - two canvases one camera, the coordinate mapping, geometry objects versus collision, bodies and scene objects, traps.
- [lighting-and-surfaces](docs/lighting-and-surfaces.md) - environment, light objects in bodies, fog, HDRI skies, generated and authored PBR surfaces, tiling.
- [asset-store](docs/asset-store.md) - the release-hosted binaries, budgets, the optimise pipelines, licensing and credits.
- [loading-screen](docs/loading-screen.md) - the inlined store, the two-halves bar, the warm frame.

Design documents

- [game-design](docs/game-design.md), [level-design](docs/level-design.md), [controls](docs/controls.md), [ideas](docs/ideas.md), [assets](docs/assets.md), [pair-solver-plan](docs/pair-solver-plan.md), and the phase plans in `plans/`.
