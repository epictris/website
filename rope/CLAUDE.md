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
**P** download a replayable session bundle.

Pick a level with `?level=NAME` (see `src/level/registry.ts`); `TEST_MOVERS` /
`TEST_WINDMILL` are hand-written mover test levels (sliding platform, windmill).

## Headless tooling

```sh
bun run replay selftest                       # determinism + replay round-trip check
bun run src/tools/cli.ts play  playtests/grapple-swing.json
bun run src/tools/cli.ts replay session.json  # replay a P-exported bundle, run invariants
bun run src/tools/cli.ts bundles              # replay every bundle in playtests/bundles/
bun run src/tools/cli.ts dump session.json --from 100 --to 200   # digest+input table
bun run src/tools/cli.ts continue session.json --from 500 --hold left --trace t.jsonl
```

Debugging workflow for gameplay bugs: reproduce in the browser, press **P**, drop the
bundle into `playtests/bundles/` — `cli bundles` replays it with current physics and
fails on invariant violations (including the `input-frozen` stuck detector: held
direction + locomotion state + mobile body nearby + no displacement). Digest
divergence is informational only (bundles recorded before a physics fix legitimately
diverge). `cli continue` replays a bundle to a frame then takes over with scripted
held input; `--trace` writes per-frame JSONL (contacts with normals/classification/
surface velocity, state transitions, snapshots) via `src/engine/physTrace.ts`.

Playtest scripts are frame-indexed held-button ranges + mouse aim with asserts
(`reachState`, per-frame `state`/`maxSpeed`/`hasRope`/position bounds). Invariants
checked every frame: NaN, runaway speed, rope-over-length (once anchored),
player-embedded-in-geometry.

## Regenerating level geometry

`levelData.ts` is generated from the prototype's Godot scene; do not hand-edit it:

```sh
bun scripts/extract-level.ts <path-to>.tscn src/level/levelData.ts
```
