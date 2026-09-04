# Plan: debug tooling improvements

> **Status: implemented (2026-09-04).**
> All seven phases landed, one commit each, `bun run test` green at every commit.
> Three acceptance criteria could not be met as written, and each is recorded where it belongs rather than quietly dropped:
> - Phase 1/2/3's acceptance frames on `session-154f`, `session-324f` and `session-239f` are unreachable, because those bundles were recorded before the fixes they document and now diverge from their own recordings far earlier than the named frames. The mechanisms were verified instead on frames that exist: the wound-tight hammer reads `aimSpin=-41.282 refund=0.6692 push=86.06mm` off `session-154f` f81; the diverging solve and the stalled unwind were reproduced with the monotone guard disabled and on `session-477f` around f215 (`window=0.16056 used=0.01557 residual=27.655mm`).
> - Phase 4's `pushRun 0 | 18` reads `0 | n/a` at `93405ae`: `chainPushCreditFrames` postdates that revision, and `n/a` is the behaviour the phase itself specifies for a metric the reference tree cannot express. `peakV 4.76 | 19.80` is exact.
> - Phase 7's premise is wrong and this is the finding, not a shortfall: a self-replay cannot see the browser/bun knife-edge, because both of its runs are in the browser. Verified with `PUSH_OUT_MIN_DEPTH` back at 0. See **Determinism & correspondence** in `CLAUDE.md` for what it does cover and what covers the rest.
>
> The tooling found a bug on its first day: `playtests/rigs/light-box-anchor.json` is red - the `session-324f` anchor pump against a 1 kg free box, `pushRun 9` against a bar of 6, ball and anchor to 37 m/s. Undiagnosed on purpose; see **What the verification suite cannot see**.
>
> Original proposal follows.
>
> **Was: proposed.**
> Distilled from the 2026-09-04 session that root-caused the wound-tight anchor pump (`session-324f`), the loop hammer (`session-154f`), the diverging length solve (`session-239f`) and the browser/headless determinism knife-edge, and from a review of where that session leaked time.
> Every phase names the moment in that session it would have shortened, the acceptance test that proves it, and the `CLAUDE.md` entry it must update before it counts as done.

## Why

The physics debugging loop is built on three legs: a recorded bundle, a bit-exact headless replay of it, and per-phase attribution of what the replay did.
On 2026-09-04 each leg failed in a way the tools could not report:

- The bundle described the avatar only, so a two-body interaction (the ball against the 12.6 kg hung weight) was diagnosed from one body's digest, and the first divergence was attributed to the wrong body once.
  When world digests arrived (`session-154f`) the true first divergence was a *chain* field, the stall lease, not a body at all.
- The replay diverged from every fresh browser recording on a float-noise branch (an overlap of 1e-17 m read as a push-out), and nothing said so beyond `drifted @f98`.
  Finding the frame, the quantity and the phase took three throwaway scripts (`driftcmp`, `worldcmp`, `series`).
- `cli trace` attributes one frame's motion to phases, but the length solve's iterations are a black box, and the launch in `session-239f` was only visible after a temporary print inside `correctShapePositionAndRotation`.
- Every candidate fix was judged by replaying ten sessions and reading peak speed, lease and push credit off a scratch scanner (`scanmetric`), because the suite answers pass/fail and `cli compare` answers one frame of one bundle.
- The bundle's `git` stamp is taken when the dev server starts, so seven bundles said `f0ed27a` while the served tree changed hourly; two "still broken" recordings were on code already reverted, found by rebuilding variants in a worktree.
- Five headless rigs (whirl, steady hold, crush, creep, light weight) were written by hand with identical wiring and thrown away.
- A determinism knife-edge between the browser and bun was invisible until a recording landed on someone's desk.

Seven phases close those seven holes.
They are independent except where noted, and the order below is the order of payoff.

## Phase 1: the bundle says what the chain phase decided

**Goal.** A bundle recorded anywhere (game, editor test mode, `cli record`) carries enough per-frame state that a chain-phase bug is readable from the bundle alone, without re-simulating.

**What was missing on the day.**
The ball's angular velocity at frame end reads zero on exactly the frames that matter, because the unwind refunds the aim's turn; the aim's commanded spin was invisible.
The lease grant, the unwind's refund and the geometry push per frame were the three numbers that explained `session-154f`, `session-477f` and `session-324f`, and none of them is in any digest.

**Design.**
Extend `ChainDigest` in `src/sim/trace.ts`:

```ts
export interface ChainDigest {
  nodes: number;
  pathLen: number;
  maxRope: number;
  blockedSlack: number;
  // New, all zero when the chain is not anchored.
  aimSpin: number;        // rad/s the steering wrote this frame (BallLevel.aimSpin)
  unwindRefund: number;   // rad the unwind gave back (rotation before vs after unwindOverLength)
  stalled: number;        // Rope.stalledLength this frame
  geometryPush: number;   // sum of push-out distances the chain phase reported
  winchBudget: number;    // BallLevel.chainWinchSpeedBudget
  pushCredit: number;     // BallLevel.chainPushOutCredit
  anchorBody: number | null; // buildIndex of the body the chain ends on, null for the hook
}
```

`Rope.geometryPush` is private; expose it as a getter, as `blockedByGeometry` already is.
`unwindRefund` is measured in `BallLevel` around the `unwindOverLength` call (the `rotationBeforeUnwind` local already exists there for `windStall`) and stored on the level as `chainUnwindRefund`.

Extend `BodyDigest` with the body's frame contacts summarised, because "was it touching and how hard" was asked of every frame inspected:

```ts
export interface BodyDigest {
  // existing fields...
  // New: the strongest contact this body carried this frame, from World.frameContacts.
  contactWith: number | null;  // buildIndex of the other body, -1 for static
  contactPn: number;           // that contact's accumulated normal impulse
}
```

Both are written by `worldDigestOf`, so every producer (`main.ts`, `editor.ts`, `record.ts`) picks them up with no further change.
Old bundles lack the fields and every reader must treat a missing field as zero, as `worldDigests` itself is optional today.

**Also in this phase.** `cli dump` prints the new chain columns, and `cli query --frame N` prints the same for the frame.

**Acceptance.**
`bun run replay selftest` stays bit-exact.
`cli dump playtests/regressions/session-154f.json.gz --from 76 --to 82` shows `aimSpin` around 38 to 41 rad/s, `unwindRefund` around 0.6 rad and `contactPn` of 35 to 41 on body 0 with `contactWith` 34, which is the hammer read straight off the bundle.
`cli dump session-324f --from 252 --to 270` shows `geometryPush` of 20 to 40 mm a frame beside a `blockedSlack` growing by the same, which is the pump.

**Done when** the **Full-world digests** section of `CLAUDE.md` lists the new fields and says which question each answers.

## Phase 2: `cli diverge`

**Goal.** One command that says where a bundle's replay first leaves its recording, on which body or chain field, by how much, and in which phase of that frame.

**What was missing on the day.**
`cli replay` reports `drifted @f98 (maxDrift=257px)` on the avatar and, with world digests, `body#0 drifted @f98`.
The actual first difference in `session-154f` was `chain.blockedSlack` at f90, exactly one lease instalment (8.33 mm), eight frames earlier, and finding it took a hand-written comparison over every digest field.

**Design.**
`cli diverge <bundle> [--body ID] [--tolerance T]`:

1. Replay the bundle and, for every frame, compare every field of every `BodyDigest` and of `ChainDigest` against the recording, at an absolute tolerance (default 1e-9, the noise floor `worldDigestsEqual` already uses).
2. Print the first differing frame with every differing field and its magnitude, sorted by magnitude.
3. Print the next five frames the same way, so the reader sees whether it grows.
4. Then run `PhaseTrace` over the first differing frame and the one before it for the bodies that differed (reuse `cmdTrace`'s loop), so the phase that wrote the difference is on screen.
5. If the bundle has no `worldDigests`, say so and fall back to the avatar digest.

The comparison lives in `src/sim/replay.ts` as `firstDivergence(rec, tolerance): { frame, fields: {name, recorded, replayed, delta}[] } | null`, so `cli replay` can print the same one-line summary (`first difference @f90 chain.blockedSlack 8.33e-3`) instead of only the drift frame.

**Acceptance.**
On a copy of `session-154f` replayed against a tree with `PUSH_OUT_MIN_DEPTH` set to 0 (re-introducing the knife-edge locally), `cli diverge` names f90 and `chain.blockedSlack = 8.33e-3` in its first line and the `pair-push-out` phase of f89 in its trace.
On the committed tree it reports no divergence for the five bundles recorded on 2026-09-04 after the depth floor landed, or names the frame if one appears.

**Done when** `cli replay`'s summary line carries the first differing field, and **Debugging physics issues** in `CLAUDE.md` names `cli diverge` as the first command to run on a bundle that does not replay.

## Phase 3: the solve is not a black box

**Goal.** `cli trace` can show what the length solve did inside a frame: each iteration's error before and after, the correction direction, the effective masses, and whether the monotone guard undid it; and it shows the unwind's window, the rotation it used and its residual.

**What was missing on the day.**
The `session-239f` launch was a diverging solve, error growing 271 to 284 mm while the direction flipped each iteration, visible only through a temporary `console.log` inside `correctShapePositionAndRotation`.
The unwind's stall in `session-477f` (a third of the window unused with 2 to 10 cm of residual) was found the same way.

**Design.**
Two new `PhaseRecord` kinds in `src/engine/phaseTrace.ts`, emitted only while `PhaseTrace.enabled`:

```ts
export interface SolveIteration {
  t: "solve";
  f: number;
  pass: "length" | "winch" | "sweep"; // physicsStep, solveLengthHolding, coupled sweep
  iteration: number;
  errorBefore: number;
  errorAfter: number;
  undone: boolean;              // the monotone guard restored this iteration
  bodies: { id: number; ma: number; arm: number; invMass: number; invInertiaArm: number; dirX: number; dirY: number }[];
}
export interface UnwindRecord {
  t: "unwind";
  f: number;
  window: number;     // rad available
  used: number;       // rad walked back
  residual: number;   // over-length left, metres
  spool: number;      // lengthPerRadian at the result
  edgeTried: boolean; // reserved for a future edge/bisection fallback
}
```

`Rope.resolveLengthConstraint` emits one `SolveIteration` per iteration (it already computes `error` before and after each since the monotone guard landed), and `unwindOverLength` emits one `UnwindRecord`.
`cmdTrace` prints them under the frame with a `--solve` flag, one line per iteration, and prints `UnwindRecord` always.

**Acceptance.**
`cli trace session-239f --from 192 --to 192 --solve` on a tree with the monotone guard disabled shows ten iterations with `errorAfter > errorBefore` and alternating `dirX` signs; on the committed tree it shows the first iteration marked `undone` and the pass ending.
`cli trace session-477f --from 200 --to 200` shows an `unwind` line with `used` below `window` and a positive `residual`.

**Done when** the `cli trace` entry in **Headless tooling** documents `--solve` and the two record kinds.

## Phase 4: `cli ab`, a metric table over a corpus

**Goal.** One command that replays a set of bundles on this tree and on a reference revision and prints, per bundle and per tree, the numbers every physics decision on 2026-09-04 was made on.

**What was missing on the day.**
Each candidate fix was judged by a scratch scanner over ten bundles printing peak speed, longest push-credit run and worst over-length, then re-run with env-var toggles to get the pre-fix column.
`cli compare` does one frame of one bundle; the suite says green or red.

**Design.**
`cli ab <bundle|dir>... [--ref REV] [--metrics list]`:

- Metrics, each computed by replaying the bundle once and reading `BallLevel` and `Rope` state per frame:
  `peakV` (ball), `peakAnchorV` (the anchor body's speed, from `chain.anchorBody`), `maxLease`, `worstOverLength` (path minus constraint while anchored), `pushRun` (longest run of `chainPushOutCredit > PUSH_CREDIT_SPEED`), `maxSolveKick` (`chainSolveSpeedGain` less the winch budget), `energyGain` (largest unforced gain the `EnergyMonitor` saw), `violations` (count), `divergedAt` (Phase 2's first-difference frame).
- The reference column is produced by the worktree mechanism `cmdCompare` already has (`git worktree add --detach`, run an emitter there, parse JSON), generalised: the emitter is `cli ab-emit <bundle> --json`, written against the same public surface `compare-emit` restricts itself to, and the caveat in `plans/tooling-improvements.md` applies unchanged: a revision older than the metric's inputs prints `n/a` for that metric rather than failing the table.
- Output is one table, bundles as rows, `now | ref` pairs as columns, with a final row of column maxima, and a `--json` form for scripts.
- With no `--ref`, print the single column; this replaces the scratch scanner outright.

**Acceptance.**
`cli ab playtests/regressions/session-324f.json.gz --ref 93405ae` prints `peakV 4.6 | 19.8` and `pushRun 0 | 18` in one line.
`cli ab playtests/regressions --ref HEAD~1` runs the whole corpus inside a minute.

**Done when** **Debugging physics issues** says an A/B is presented as a `cli ab` table and the `cli compare` entry points to it for the corpus-wide question.

## Phase 5: the bundle names the tree it was recorded on

**Goal.** A bundle carries an identity of the *served source*, not the last commit, and the CLI says whether the tree it is replaying on is that source.

**What was missing on the day.**
`__GIT_COMMIT__` is `git rev-parse` at Vite config load, so a dev server started at 08:02 stamped every bundle for the rest of the day with a commit two behind `HEAD`, and none of them said which uncommitted edits were live.

**Design.**
A Vite plugin in `vite.config.ts`, beside `levelApi`:

- Serves a virtual module `virtual:tree-stamp` exporting `{ commit, dirty, srcHash }` where `srcHash` is a short hash over the contents of every file under `src/` and `levels/` that the build would include, computed at server start and recomputed on the file watcher's change events; the module is invalidated on change so a full reload picks up the new stamp.
- `main.ts` and `editor.ts` write `git: commit`, `dirty`, and `srcHash` into the bundle (`Recording` gains the two optional fields).
- `cli` computes the same hash over the working tree (`src/sim/treeStamp.ts`, shared with the plugin) and every replaying command prints `tree: match` or `tree: MISMATCH (bundle abc123, here def456)` on its header line.
- `cli restamp` learns the new fields.

**Acceptance.**
Record a bundle, edit any file under `src/`, replay it: the header says `MISMATCH`.
Revert the edit: `match`.

**Done when** the P-download paragraph in **Running** and the `cli replay` entry describe the stamp, and the **Debugging discipline** list gains: a bundle whose tree does not match is evidence about a different tree.

## Phase 6: rigs as data

**Goal.** A headless scenario (build this arena, fire at that body, wind up, hold or whirl the aim, measure) is ten lines of data, runs from the CLI, prints the Phase 4 metrics, and can be saved as a playtest script so it outlives the session.

**What was missing on the day.**
`rig.ts`, `hold.ts`, `crush.ts`, `creep.ts` and the hung-anchor leg were each thirty to sixty lines of the same wiring, differing only in the arena and the aim pattern.

**Design.**
`src/sim/rig.ts`:

```ts
export interface RigSpec {
  data: RawLevelData;                 // the arena, inline, as playtests carry it
  spawn?: { x: number; y: number };
  fireAt: { x: number; y: number };   // world metres; fire held from frame 1
  windUp?: { until: "riding" | number; period?: number }; // whirl until the ball rides its anchor, or N frames
  drive: { kind: "hold"; deg: number; frames: number }
       | { kind: "whirl"; period: number; frames: number }
       | { kind: "aimAt"; x: number; y: number; frames: number };
}
export function runRig(spec: RigSpec): RigResult;   // Phase 4 metrics plus per-frame series
export function rigToPlaytest(spec: RigSpec): PlaytestScript; // holds + aim ranges, so it can be committed
```

`cli rig <spec.json> [--series] [--save playtests/foo.json]`.
The aim patterns are expanded to `mouse`/`aim` ranges with `relative: true`, which `ScriptedInput` already supports, so a saved rig is an ordinary playtest and gains `asserts` by hand afterwards.
Ship the five rigs from 2026-09-04 as `playtests/rigs/*.json` with the arena definitions used that day (the level's trapezoid weight on a 1.6 m chain, the static and rigid crush slabs, the free box on the floor).

**Acceptance.**
`cli rig playtests/rigs/hung-trapezoid-whirl.json` reproduces the trap rig's numbers from the session (ball peak about 3 m/s, lease under 10 cm).
`cli rig ... --save` produces a script `cli play` runs green.

**Done when** **What a mechanic test is for** says a new scenario starts as a rig spec and is committed as a playtest.

## Phase 7: the browser proves its own bundle replays

**Goal.** A recording is checked for determinism on the machine that made it, before it reaches anyone else.

**What was missing on the day.**
The browser and bun disagreed on a 1e-17 m overlap.
Nothing in the download path could know that, so the disagreement surfaced only when a bundle was replayed elsewhere.

**Design.**
On P-download (`main.ts`) and on the editor's test download (`editor.ts`):

1. Build a second level from the bundle's own `data` and `controller` (the same `levelFromRecording` path the CLI uses; it is importable in the browser, `sim/replay.ts` has no Node dependencies beyond what `cli.ts` adds on top).
2. Re-simulate the recorded `frames` through it and compare digests with Phase 2's `firstDivergence`.
3. Write the result into the bundle as `selfReplay: { identical: boolean; firstDivergence: {frame, field, delta} | null; ms: number }`.
4. Show it in the download toast: "replays exactly" or "does not replay: f90 chain.blockedSlack".

`cli replay` prints the bundle's `selfReplay` line on its header.
A bundle that did not replay on its own machine is a determinism finding by itself, and the CLI says so in those words.

Cost: a 1000-frame ball session re-simulates in well under a second headlessly and the browser is comparable; run it synchronously on download and report the time.

**Acceptance.**
With `PUSH_OUT_MIN_DEPTH` set to 0 locally, a wound-tight recording downloads with `selfReplay.identical === false` and names the lease field.
On the committed tree a fresh recording downloads `identical: true` and `cli replay` reports it bit-identical.

**Done when** the **Determinism & correspondence** section states that every bundle carries its own self-replay verdict and what a false verdict means.

## Order and dependencies

1. Phase 1 first: Phases 2, 4 and 7 read its fields.
2. Phase 2 next: Phase 4's `divergedAt` and Phase 7's verdict use `firstDivergence`.
3. Phase 3 and Phase 5 are independent and can run in parallel with anything.
4. Phase 4 after 1 and 2.
5. Phase 6 after 4, because `runRig` returns Phase 4's metrics.
6. Phase 7 last, after 1, 2 and 5.

Each phase is one commit with its `CLAUDE.md` entry, and `bun run test` is green at every commit; the selftest's bit-exactness is the guard that none of the recording changes altered physics.

## Process change that goes with the tooling

Record a browser bundle against every physics change before calling it verified, and replay it with `cli diverge`.
Headless validation alone shipped two defects on 2026-09-04 that a single fresh recording would have caught the same hour: the determinism knife-edge, and the loop hammer that the hold-then-pair redesign left standing.
Add that sentence to **Debugging discipline** with the two sessions as the record of why.
