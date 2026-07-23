# rope

A 2D grappling-hook character-controller playground. **TypeScript port** of a C#/Godot
prototype (`~/projects/character_controller`), rewritten so it runs in the browser and can
be shared with friends to playtest. The novel part is the rope: it models the rope as a
sequence of **wrap points around scene geometry** (PBD length + friction solver), not as
evenly spaced segments.

## Stack

- **Language**: TypeScript, no framework
- **Bundler / dev server**: Vite
- **Runtime**: Bun (dev, build, headless tooling)
- **Rendering**: a single `<canvas>` in the terminal-ish palette (matches tris.sh)

There is **no game engine dependency**. Godot's physics (CharacterBody2D `MoveAndSlide`,
RigidBody2D dynamics, `PhysicsServer2D` raycasts/shape queries) was reimplemented from
scratch in `src/engine/` so the simulation is self-contained and deterministic.

## Layout

| Path | Purpose |
|------|---------|
| `src/engine/` | Godot substitute: `Vec2`, `Mathf`, shapes, body hierarchy (`Static/Rigid/Character/Area`), `World` (swept collision, raycasts, rigidbody integration), `Debug` draw buffer |
| `src/lib/` | Pure geometry/rope math: `Segment`, `Intersections`, `Catenary`, `RopeGeneration`, `NodeDetachment`, `PathObject`, `RopeContact`, `ShapeGeometry`, `Calc`, `Surface`, `Slide` |
| `src/classes/` | `Rope` (wrap-point PBD solver), `SlackSimulation`, `Player`, `Hook`, `CannonBall`, `KillZone`, and `states/` (the player state machine) |
| `src/input/` | `FrameInput`, `LiveInputSource` (keyboard/mouse) |
| `src/level/` | `Level` (world + one physics frame), `levelData.ts` (auto-generated geometry), `registry.ts` |
| `src/render/` | Canvas `renderer`, `camera` |
| `src/sim/` | Deterministic tooling: `trace` (digests, invariants, input serialization), `playtest`, `replay` |
| `src/tools/cli.ts` | Headless CLI: `play`, `replay`, `selftest` |
| `scripts/extract-level.ts` | One-off: regenerates `levelData.ts` from a Godot `.tscn` |

## Determinism & correspondence to the C# source

The sim is a **fixed 1/60 timestep**; input is sampled once per physics frame. It is
self-consistent (a recorded input trace replays bit-for-bit — see `cli selftest`) but **not**
bit-compatible with the C# original (float64 vs float32, reimplemented physics). Class and
method names track the C# sources closely to keep the two diffable.

Godot idioms that were collapsed in the port:
- `Vector2` value-type semantics → **immutable** `Vec2` (every op returns a new vector).
- `PhysicsServer2D.BodySetState(Transform/…)` in `Rope` → no-op; the TS `RigidBody2D`
  transform/velocity **is** the authoritative state.
- `Node._PhysicsProcess` ordering → `Level.physicsProcess` runs player+rope, then hooks,
  then `World.integrate` (rigidbody gravity/collision), mirroring Godot's frame order.

Only circles and body-aligned rectangles exist (as in the prototype); collision code
handles just those two shapes.

## Known simplifications (candidates for follow-up)

- `World` rigidbody dynamics are approximate (no full contact manifold / stacking solver);
  the rope drives attached bodies directly, so this mostly affects free-falling debris.
- `SlackSimulation` is fully ported but currently unwired — the C# `Rope` also left its
  `slackSimulation` field unused; the rope renders straight spans.
- `ApplyFrictionImpulse` is ported behaviour-for-behaviour but, as in the C# source, is
  not invoked from `physicsStep` (the call is commented out there too).

## Running

```sh
cd rope
bun install
bun run dev        # http://localhost:3100
```

Controls (match the Godot input map): **R/T** move · **Space** jump · **left-click** fire
hook · **right-click** retract-tug · **C** retract · **S** extend · **1/2** spawn circles ·
**P** download a replayable session bundle ·
Gamepad (standard mapping, merged with keyboard/mouse): **left stick/dpad** move ·
**A** jump · **right stick** aim (rendered crosshair) · **RT** fire · **LT** retract-tug ·
**RB/LB** retract/extend · **X/Y** spawn circles ·
**L** toggle the debug overlay (render-only). It shows ledge-grab markers (green marker +
dashed grab-radius circle = grabbable now, hollow red = candidate rotated out of reach,
grey X = seam-occluded, face ticks colored by floor/wall/ceiling classification) and an
arrow for the surface normal the player is currently touching (grounded/wall surface, or
both ledge faces while hanging/climbing), colored by the same classification.

Pick a level with `?level=NAME` (see `src/level/registry.ts`); `TEST_MOVERS` /
`TEST_WINDMILL` are hand-written mover test levels (sliding platform, windmill).

## Headless tooling

```sh
bun run replay selftest                       # determinism + replay round-trip check
bun run src/tools/cli.ts ledges               # generated ledge-grab matrix (speed × angle × negatives)
bun run src/tools/cli.ts play  playtests/grapple-swing.json
bun run src/tools/cli.ts replay session.json  # replay a P-exported bundle, run invariants
bun run src/tools/cli.ts bundles              # replay every bundle in playtests/bundles/
bun run src/tools/cli.ts dump session.json --from 100 --to 200   # digest+input table
bun run src/tools/cli.ts continue session.json --from 500 --hold left --trace t.jsonl
```

Playtest scripts are frame-indexed held-button ranges + mouse aim with asserts
(`reachState`, per-frame `state`/`maxSpeed`/`hasRope`/position bounds). Invariants
checked every frame: NaN, runaway speed, rope-over-length (once anchored),
player-embedded-in-geometry.

## Debugging physics issues

The debugging loop for gameplay/physics bugs (player stuck, frozen input, bad
launches, mover misbehavior):

1. **Capture.** Reproduce in the browser, press **P** — downloads a bundle
   (level id + full input trace + per-frame digests). Recording restarts on
   level reset, so a bundle always replays from frame 0.
2. **Make it red.** Drop the bundle into `playtests/bundles/` (gitignored,
   local corpus) and run `cli bundles`. Every bundle is re-simulated with
   *current* physics and checked against per-frame invariants — the bug should
   show up as violations at the frames where it was felt. If it doesn't,
   the invariants have a blind spot: fix the detector first, then the bug.
   A fix is only "done" when the bundle that reported it goes green.
3. **Locate.** `cli dump bundle.json --from A --to B --every N` prints a
   digest+held-input table (re-simulated, not the recorded digests). Look for
   `vx=0.0` runs under held input, state thrash (Grounded↔Airborne flicker),
   or position drifting against input.
4. **Inspect.** `cli continue bundle.json --from F --hold left --frames 120
   --trace t.jsonl` replays to frame F, then takes over with scripted held
   input (fed through the input deserializer so pressed/released edges are
   correct relative to the recording — do not hand-roll input streams; the
   `InputBuffer`s are edge-triggered and a missed `released` latches a key
   forever). The trace JSONL (`src/engine/physTrace.ts`) has one record per
   `moveAndCollide` contact — collider, `overlap` (depenetration) vs `sweep`,
   normal, mobility, contact-point surface velocity — plus per-frame snapshots
   (state, support body, velocity), state transitions, and ledge-detection
   events (`t:"ledge"` — every grab, and near-miss rejections with a reason:
   wrong-side, below-player, behind-wall, out-of-reach, seam). Grep it: opposite
   normals from the same body in one frame, surface classifications flipping,
   velocity resetting to the collider's `cvel` every frame.
5. **Verify.** `cli bundles` green + all playtests + `bun run replay selftest`
   (must stay bit-identical — static-path behavior may never change; mobile
   behavior is gated behind `isMobile`/`isRotating` branches).

Key invariant — the **`input-frozen` stuck detector** (`src/sim/trace.ts`):
held direction for 45 frames with a mobile body nearby must produce ≥25 px of
displacement along the input, or >10 px *against* it (yielding to a mover's
push is displacement, not a freeze — wedge rules). Counts every input-held frame regardless of
state (state thrash must not reset the window); exempt: active rope, ledge
hang/climb, wall-jump startup, and purely static blockers (pressing into a
static wall is legit). Runs inside every playtest, replay, and continue.

Bundle semantics: digest divergence in `cli replay`/`cli bundles` is
**informational, not failure** — a bundle recorded before a physics fix
legitimately diverges from the frame the fix first bites; invariants are the
pass/fail signal. Consequence: after early divergence, the re-simulated tail
no longer matches what the user experienced — diagnose stuck windows via the
detector's frame numbers on the *current* simulation, not the recorded tail.

Past root causes worth suspecting again (all found via this loop): absolute
velocity zeroed instead of surface-relative (PROJECT/CEILING cases), locomotion
basis stolen by a mover's corner normal (static-floor preference), separating
depenetration contacts redirecting escape velocity, phantom "hit-from-inside"
sweep normals on thin rotating shapes (guards in `World.moveAndCollide`), and
near-threshold face classification flapping on rotating bodies (grip grace in
`lib/surface.ts`).

## Regenerating level geometry

`levelData.ts` is generated from the prototype's Godot scene; do not hand-edit it:

```sh
bun scripts/extract-level.ts <path-to>.tscn src/level/levelData.ts
```
