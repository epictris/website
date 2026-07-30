# Plan: physics debugging tooling

> **Status: landed** (phases 0-10).
> The narrative here is kept as written, because it is the reasoning the work was done from;
> `CLAUDE.md` (**Headless tooling** and **Debugging physics issues**) describes what the tools now do.
>
> What the plan did not anticipate, all of it found by running the new tools:
>
> - **A tolerance has to be sized against measured numbers, not sensible ones.**
>   The ball's mass was 3.3e-4 kg when this was written, so the whole scene's kinetic energy was measured in tens of microjoules;
>   the energy invariant's first tolerance (1 mJ, which reads as small) sat above every quantity in the sim and detected nothing.
>   It was then 1e-4 J, five times the corpus's measured noise floor of 2.1e-5 J.
>   Masses are physical now (the ball is 52 kg of cast iron - see **Mass and materials** in `CLAUDE.md`), which is the second half of the lesson: a tolerance written as a number of joules goes stale the moment a mass changes, so it is written as a **speed** against the ball's own mass and re-derives itself.
> - **The energy invariant's arming gate was the whole problem.**
>   Deploy is hold-to-keep, so gating on "any button held" disarmed it for 90% of every recorded session;
>   it arms on the *forced* actions (retract/extend) and on a kinematic spin that is actually turning the ball.
> - **The A/B cannot reach back past its own imports.**
>   `cli compare` runs current tooling against old physics, which stops working at revisions predating `bodyOverlapCircle` and `World.collectContacts` - which is where several of the historical defects live.
>   Two acceptance tests here were written assuming otherwise (Phase 5's pre-reorder refund, Phase 4's original `1474f` launch frames) and had to be demonstrated by local defect re-introduction and by an equivalent finding instead.
> - **Three findings the tools produced immediately**, none of them what anyone was looking for, and all three now **closed** (see **The contact solver**, **The position pin** and **Resting contacts** in `CLAUDE.md` for the fixes):
>   a resting ball carried a permanent ~21 mm/s that its stick anchor cancelled positionally - restitution applied to a resting contact, which the circle path alone did not gate on approach speed; a settled scene read 1.2e-2 J of kinetic energy and now reads 1e-32;
>   a rigid body resting on the ball kept a permanent ~0.2 m/s into it, because the ball's own static contact was solved outside the constraint list (the one contact still excluded) - folded in, it reads exactly zero, and the circle path is left with the steering alone;
>   and gripped polygons in `session-326f`/`255f`/`166f` slid 0.5 to 2.7 mm per frame at zero velocity, with the stick anchor riding along with them - the pin is relative and anchored in the surface's frame now, Coulomb-capped and offered from both sides of a pair, which takes those three bundles from 662, 529 and 168 mm of settled drift to 8, 8 and 16 mm and turns `cli contacts` `rigid-ramp-hold` from red-on-purpose to green.
>   Finding the first two took one `cli query` each and finding the third took `cli trace`, once it could attribute a *position* change to a phase - which it could not when these were written, and which is the one tool change this list caused.
>
> Distilled from a meta-analysis of the 2026-07-30 debugging sessions.
> The finding: the debugging itself was empirical, but every loop leaked time in the same four places - verification that could not see the bug ("bit-identical" meant the avatar alone), quantitative questions that each required editing code, throwaway probes rebuilt every session, and fixes that only a manual playtest could accept.
> This plan closes those four holes.
> The companion doc changes (**Debugging discipline** and **What the verification suite cannot see** in `CLAUDE.md`) are already landed; each phase here retires one or more entries from that blind-spot list, and the phase is not done until the entry is removed.

## Ground rules

- Every phase keeps `cli selftest` bit-identical and the bundle corpus healthy; tooling reads sim state and never feeds anything back into it.
- Where a phase adds a detector, prove it red-then-green: check out (or locally re-introduce) the historical defect named in its acceptance test and confirm the detector catches it, then confirm green at HEAD.
- Phases are ordered by dependency; 0-4 are the core and worth landing as one arc, 5-9 can each land independently after them.
- Follow the repo conventions: comments state constraints, sentences own their lines in Markdown, no em dashes.

## Phase 0: make green mean green

The suite cannot gate while one case is red on purpose and there is no single command that runs all of it.

1. Add `expectedFail?: true` to contact cases (`sim/contactCases.ts`) and mark `rigid-ramp-hold` with it.
   The runner counts an expected failure as pass, prints it as `XFAIL`, and **fails** if an expected-fail case passes - a stale marker is a lie about coverage.
2. Add a `test` script to `package.json` that runs, in order: `tsc --noEmit`, `cli selftest`, `cli contacts`, `cli corners`, `cli ledges`, every playtest in `playtests/*.json`, and `cli bundles`.
   One command, one exit code; this is what "all green" means from now on.
3. `cli bundles` keeps digest divergence informational (old bundles legitimately diverge) but the summary line must state how many bundles diverged and the worst drift, so silence never reads as sameness.

**Acceptance:** `bun run test` exits 0 at HEAD; flipping any single case or invariant makes it exit 1; un-breaking `rigid-ramp-hold` (hack the case to pass) makes it exit 1 via the stale-XFAIL rule.

## Phase 1: full-world digests

Retires **Digests are avatar-only**.

1. Add `WorldDigest` to `sim/trace.ts`: per rigid body `{id, px, py, rot, vx, vy, w}` (id = stable build order index), plus the chain `{nodes, pathLen, maxRope, blockedSlack}` when one exists.
   The avatar `Digest` stays untouched - recorded bundles carry it and comparison against a recording stays avatar-shaped.
2. Record it: the P-bundle gains an optional `worldDigests` array (same cadence as `digests`).
   Old bundles without it replay exactly as today; new bundles are compared on the full world.
3. `cli selftest` round-trips the full world and demands bit-exactness on all of it.
4. Divergence reporting names the body: `body#3 drifted @f412 (maxDrift=...)`, so a regression in scenery is as loud as one in the avatar.
5. Note the one thing the avatar digest never carried at all: the ball's `angularVelocity`.
   Add it to `WorldDigest`'s avatar entry - spin regressions (`314f`, the no-rolling bug) were invisible to every digest.

**Acceptance:** re-introduce the `session-298f` defect (static contacts solved outside the constraint list - revert the relevant commit locally) and confirm `cli selftest` or a new-format bundle goes red on rigid-body state where the old digest stayed bit-identical.

## Phase 2: `cli query` - state at a frame, machine-readable

Retires the "every quantitative question is a code change" loop.
This was the single most rebuilt probe: ball angular velocity at frame N, body positions, embedding depth, chain length breakdown - each answered by editing `cli.ts` or writing a scratchpad script.

```
cli query bundle.json --frame N            # one frame, human table
cli query bundle.json --from A --to B --every K --json   # JSONL, one object per frame
cli query bundle.json --frame N --body 3   # filter to one body
```

Per frame, emit the full sim view:

- every body: position, rotation, `linearVelocity`, `angularVelocity`, speed, per-shape kind, current embedding depth against the rest of the scene (reuse `bodyOverlapCircle`/manifold queries), stick anchor state;
- the chain: node list (position, body, `shapeIndex`, span kind), `getCurrentLength`, `maxRopeLength`, `constraintLength`, `blockedSlack`, stall-run length;
- the avatar: digest fields plus state name and support body.

`--json` output is the contract: stable keys, metres and rad/s, no formatted strings (the `fork` state line's px-formatted speed is exactly what this replaces).

**Acceptance:** answer three questions from the 07-30 sessions with one command each and no code edits: the ball's `w` at `314f` f-range (spinning hard, `vx≈0`); the `1474f` embedding ramp (monotonic 49 to 163 mm); the `537f` chain lease at f455.

## Phase 3: `cli trace` - per-phase attribution

Promotes the throwaway written in some form in **every** session (`rbtrace.ts`, `_stage2.ts`, `probe*.ts`, `_diag1474a-e`): which phase of the frame gave this body this velocity.

1. Instrument the frame loop behind a `PhysTrace`-style flag with per-phase snapshots for chosen bodies: after integrate (gravity + areas), after `solveContacts` (plus per-contact applied impulses, normal and tangent), after `moveAndCollide`, after the chain phase broken into push-out, rope solve, unwind, stall lease, and the derived-velocity write, and after stiction/grip events.
2. `cli trace bundle.json --from A --to B [--body id] [--out t.jsonl]` prints per-frame per-phase deltas (`Δvx Δvy Δω` per phase) and writes JSONL for grep.
3. Ball levels are first-class: the chain-phase breakdown above is the part no existing tool shows and the part every rope bug needed.

**Acceptance:** reproduce the `537f` ceiling-traction analysis with one command: contact solve shows +1.2 m/s sideways re-earned per frame, chain solve shows it removed, lease ratchets - visible in the phase columns without a custom script.

## Phase 4: `cli scan` - anomaly sweep

The standing version of the speed-jump scan rewritten by hand each session.
One command over a bundle (or `--all` over the corpus) that prints, per body:

- top-K single-frame `|Δv|` and `|Δω|` spikes with frame numbers;
- max embedding depth and the frame it peaked;
- settled-body drift: any body under a speed threshold for M consecutive frames whose position nevertheless moves more than a tolerance over that window (the `611f` 2.4 mm/frame motor and the `298f` 13 cm ratchet are exactly this shape);
- contact-set flicker rate for resting bodies (the pre-slop stack's 0-to-3-of-6 flicker);
- stall runs and `blockedSlack` high-water mark.

This is the new step 2.5 of the debugging loop: run `scan` before choosing what to inspect.
Update the **Debugging physics issues** steps in `CLAUDE.md` when it lands.

**Acceptance:** `cli scan` on `session-1474f` surfaces the four launch frames (f480/f558/f1198/f1269) in its spike list; on `session-611f` (or a reconstruction) it flags the anchor walk as settled-body drift.

## Phase 5: conservation invariants and a settle harness

Retires the class of bug where the solver quietly invents energy - found late in four disguises (the refund) and once as a friction motor.

1. **Energy invariant** (`sim/trace.ts`): over any frame span with no held input and no aim steering, total kinetic plus potential energy must not increase beyond a small tolerance.
   The gate on input matters: the kinematic spin is a legitimate energy source, so the invariant arms only while the sim is unforced.
   Runs inside every replay for the input-free spans it finds.
2. **Impulse-pair symmetry** (debug flag in `World.solveContacts`): every applied impulse asserts equal-and-opposite bookkeeping; `cli contacts` runs with it on.
   The `momentum` case already pins the aggregate at machine precision; this pins each impulse.
3. **`cli settle bundle.json --from N --frames M`**: continue with zero input (the `_bcont.ts`/`_rest.ts` throwaway), reporting the KE trajectory, final per-body speeds, and net drift, and asserting everything comes to rest and stays there.
   This is the standing form of the check that caught the 68 m/s runaway and later proved KE ~1e-7 at rest.

**Acceptance:** re-introduce the pre-reorder refund (run the old ordering locally) and the energy invariant goes red within a few frames of a wind-up; `cli settle` on the `265f` scene flags the anchor slide as drift; both green at HEAD.

## Phase 6: `cli compare` - first-class A/B against a git rev

Replaces the shell plumbing in `scripts/abtest.sh`, which failed silently twice in one day (an empty `git stash` compared a tree against itself; a wrong cwd ran identical variants).

```
cli compare bundle.json --frame N --ref <rev> [--frames M] [--json]
```

1. Create a temp worktree of `<rev>`, copy the current `src/tools` + `src/sim` in (the existing abtest trick, same caveat about stable physics interfaces), run both sides from the fork frame, and diff full-world digests per frame.
2. Output: first divergent frame, per-body drift table, and the two before/after SVGs; `--json` for scripting.
3. Hard failures instead of silent no-ops: refuse to report "no difference" without also printing both sides' tree identity (rev plus dirty-tree hash) so identical trees are visible as such; resolve every path from the repo root so cwd cannot matter; error if the worktree build fails rather than falling through.

**Acceptance:** `cli compare` on the `298f` bundle against `ff2908a` reproduces the jitter-regression finding (rigid group `w` ±0.08 vs 0.0000); running it with `--ref HEAD` on a clean tree reports "identical trees" explicitly rather than an empty diff.

## Phase 7: ball-aware scripts and a mechanic-preservation suite

Retires **Metrics do not defend mechanics** and the "not ball-aware yet" gap in `cli continue` and playtest scripts.

1. Extend `PlaytestScript` for the ball controller: aim waypoints (world-space, per frame range), deploy/retract/extend holds, and a spawn override; teach `cli continue` and `runScript` to drive `BallLevel`.
2. Build the behavioural suite as `playtests/ball-*.json` (plus contact cases where a script is overkill), each asserting the mechanic itself:
   - **wind-up**: aiming while deployed wraps the chain; wrap count reaches N and `maxRopeLength` is respected;
   - **winch**: winding on pulls the ball measurably toward the anchor;
   - **roll-drive**: a steered ball travels along static *and* rigid floors (the `314f` regression, already a contact case - keep both);
   - **swing**: released from the side on a taut chain, the ball swings through with period and amplitude in bounds;
   - **hang-at-rest**: a ball hanging still stays still - KE to ~0, chain length constant, zero drift (the `537f`/`611f` class);
   - **ceiling-hold**: wound to a ceiling anchor, no lateral self-drive;
   - **wedge**: ball between a static floor and a rigid body settles with no ping-pong (the `284f` class).
3. These become the mandatory success criteria for any physics A/B: a variant that wins every drift metric but fails `wind-up` is a failed variant (`475f`).

**Acceptance:** each scenario demonstrated red under one documented historical defect (spot-check three: `314f` no-rolling, `537f` ceiling slide, `475f` input-clamp variant re-applied locally) and green at HEAD; `bun run test` runs the suite.

## Phase 8: headless bundle recording

Recording is browser-only, so the agent can consume repros but never manufacture one.

1. `cli record <level> <script.json> --out session.json`: run a (now ball-aware) playtest script and serialize a genuine P-format bundle - level snapshot, input frames, digests, `worldDigests`, current git rev.
2. A recorded-then-replayed script must be bit-identical (extend `selftest` with one ball script through this path).

**Acceptance:** record a wind-up script headlessly, replay the bundle, bit-identical and healthy; use it to turn one historical bug scene into a committed regression bundle for Phase 9.

## Phase 9: committed regression corpus

Retires **The bundle corpus is gitignored**.

1. Create `playtests/regressions/` (committed) and move a curated subset of the local corpus into it: every bundle a `CLAUDE.md` postmortem cites (`120f`, `234f`, `265f`, `284f`, `298f`, `306f`, `314f`, `326f`, `358f`, `390f`, `394f`, `410f`, `431f`, `458f`, `475f`, `477f`, `537f`, `611f`, `726f`, `735f`, `1195f`, `1426f`, `1467f`, `1474f` - take what still exists locally).
2. Bundles replay from frame 0 by design, so commit them whole; if size bites, support `.json.gz` in `loadRecording` rather than trimming frames.
3. `cli bundles` (and `bun run test`) runs both directories; the gitignore keeps covering `playtests/bundles/` for local scratch.

**Acceptance:** a fresh clone passes `bun run test` with the full regression corpus and no local files.

## Phase 10 (optional): render diff

The `1467f` class - the sim right, the drawing wrong - currently needs eyes.

1. `cli shot bundle.json --frame N --out f.png`: wrap the `shot.html` + headless-chromium incantation from the debugging loop into one command.
2. `cli shot --diff a.png b.png`: pixel diff with a changed-pixel count and a highlight image, for before/after renderer claims.

This does not make perceptual quality assertable - it makes perceptual *claims* cheap to evidence.
Land it last; everything above is worth more.

## Doc follow-through

When a phase lands:

- update **Headless tooling** and the **Debugging physics issues** steps in `CLAUDE.md` with the new command;
- delete the blind-spot entry the phase retires from **What the verification suite cannot see**;
- update the **Status** line at the top of this file, in the manner of `docs/pair-solver-plan.md`.
