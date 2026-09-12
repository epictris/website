# Debugging physics issues

The debugging loop for gameplay/physics bugs (player stuck, frozen input, bad
launches, mover misbehavior):

1. **Capture.** Reproduce in the browser, press **P** — downloads a bundle
   (level id + full input trace + per-frame avatar and world digests). Recording
   restarts on level reset, so a bundle always replays from frame 0.
   A scenario that can be described as a script needs no browser at all:
   `cli record script.json --out session.json` writes the same format headlessly,
   which is how a fiddly repro (wound up against a ceiling, wedged under a crate)
   becomes reproducible rather than performed.
2. **Make it red.** Drop the bundle into `playtests/bundles/` (gitignored,
   local scratch; `playtests/regressions/` is the committed corpus) and run
   `cli bundles`. Every bundle is re-simulated with
   *current* physics and checked against per-frame invariants — the bug should
   show up as violations at the frames where it was felt. If it doesn't,
   the invariants have a blind spot: fix the detector first, then the bug.
   A fix is only "done" when the bundle that reported it goes green.
2a. **A bundle that does not replay is a determinism finding first.**
   `cli diverge bundle.json` says where the replay first leaves the recording:
   the frame, every field of every body and of the chain that differs, sorted by
   magnitude, the five frames after it (so a difference that is *repaid* reads
   differently from one that is *re-earned*), and a phase trace of that frame and
   the one before it on the bodies that differed.
   Run it before anything else on a bundle `cli replay` calls DIVERGED.
   `cli replay` answers "drifted @f98 (maxDrift=257px)", which is a statement
   about the avatar's POSITION several frames after the fact and cannot see a
   difference that is not a distance.
   With the pair-push-out knife-edge re-introduced locally, `cli replay` reports
   the ball drifting at f300 by 1.18 px; `cli diverge` reports
   `chain.pushCredit` at f227, 1.06e-7 m/s, seventy-three frames earlier and on a
   quantity no body ever moved by - which is the frame the two machines actually
   parted company on.
   On 2026-09-04 the same question took three throwaway scripts to answer, and
   the first divergence was attributed to the wrong body once on the way.
   `--body ID` narrows the whole report (including which frame counts as first)
   to one body; `--tolerance T` moves the noise floor off its 1e-9 default.
   A bundle carrying no `worldDigests` is told so and falls back to the avatar
   digest, which is all such a bundle recorded.
2b. **Sweep before choosing where to look.** `cli scan bundle.json` (or
   `cli scan --all` over the corpus) reports, per body, the top single-frame
   `|Δv|` and `|Δω|` spikes, the deepest embedding and when it peaked,
   settled-body drift (a body going nowhere by its own velocity that is
   nevertheless somewhere else), contact-set flicker while resting, and the
   chain's stall runs and lease high-water.
   Those five are the shape of every physics bug there has been, and picking a
   frame to inspect before running this is guessing.
3. **Locate.** `cli query bundle.json --frame N` prints the whole sim state at a
   frame - every body's pose, velocity, spin, embedding depth and stick anchor,
   the chain's nodes and its length broken into `maxRopeLength`, lease and stall,
   and the avatar's state - and `--json` makes it a JSONL stream (`--from A --to
   B --every K`) with stable keys in metres and rad/s.
   Every quantitative question used to be a code change; this is the answer to
   all of them, so reach for it before editing anything.
   `cli dump bundle.json --from A --to B --every N` prints a
   digest+held-input table (re-simulated, not the recorded digests). Look for
   `vx=0.0` runs under held input, state thrash (Grounded↔Airborne flicker),
   or position drifting against input.
3b. **Attribute it to a phase.** A one-frame velocity is never explained by its
   size, only by which part of the frame wrote it - and neither is a one-frame
   *movement*, which is the harder case, because a body can be moved by a phase
   that gives it no velocity at all. `cli trace bundle.json --from
   A --to B [--body ID] [--out t.jsonl]` prints per-phase `Δv`/`Δω` **and `Δp` in
   millimetres** per body:
   `aim`, `gravity`, `contacts` (with per-contact normal and tangent impulses and
   whether they were at the Coulomb limit), `grip`, `circle-contacts`,
   `contact-damp`, `depenetrate`, and the chain phase broken into `push-out`, `rope-solve`,
   `spin-rollback`, `unwind`, `chain-velocity`, `refuse-into-surface` and
   `stall-lease`.
   That breakdown is the part no other tool shows and the part every rope bug has
   needed: "the contact solve re-earns 1.2 m/s sideways every frame and the chain
   solve removes it" is a thing you read here rather than instrument for.
   The position column is the same statement for the creeps, which are the bugs
   with no velocity signature at all: "gravity drops it 2.7 mm, the recovery pushes
   it out along an inclined normal and 0.6 mm of that is sideways, every frame" is
   read straight off the `depenetrate` line. Without it, a body crossing the level
   at 1e-8 m/s is a scan flag with nowhere to go next.
3c. **Open the solve.** `--solve` adds one line per length-solve **iteration**:
   the pass it belongs to (`length` for the frame's own rope pass, `winch` for
   `Rope.solveLengthHolding`, `sweep` for a pass of the coupled scene sweep,
   which leaves its ropes inside `CHAIN_TOLERANCE` rather than at zero), the
   length error in millimetres before and after, whether the monotone guard
   `UNDONE` it, and per body the mechanical advantage, torque arm, the two halves
   of the effective inverse mass (`1/m` and `arm²/I`) and the correction
   direction.
   A **diverging** solve is what that is for: error climbing iteration on
   iteration while `dir` flips sign, which spun a 12.6 kg weight fourteen turns in
   one frame and launched the ball at 93 m/s out of a 27 cm error (`session-239f`
   f192) and was visible only through a temporary `console.log` inside
   `correctShapePositionAndRotation`.
   The **unwind** gets one record a frame and is printed always, `--solve` or not:
   the window it was allowed, the fraction of it used, the residual over-length it
   left standing, and the spool rate at the rotation it settled on.
   A tenth of the window spent with 27.7 mm still over (`session-477f` around
   f215) is a **stalled search**, and it reads as a chain that simply refuses to
   unwind until you can see that number.
   Nothing here writes to the sim: replaying the whole of `239f`, `477f` and
   `154f` with `PhaseTrace` armed reproduces the untraced run bit for bit, and it
   has to - a trace that moves the thing it measures is not evidence.
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
4b. **See it.** For *geometric* bugs (rope/chain clipping through geometry,
   anchoring in mid-air, a hook on the wrong side of a wall) the digest table is
   blind — it only carries the avatar's pos/vel/rope-length, not the chain wrap
   path. `cli render bundle.json --frame N --out f.svg` writes an SVG of the
   whole scene at frame N (bodies, hook-proof surfaces = dashed steel border, hook-only
   (`passable`) bodies = a grate mesh, areas with
   their glyphs — skulls for a killzone, flow arrows for a force area, flow
   streaks for water — chain
   wrap path + wrap-node markers, avatar); convert with `magick f.svg f.png` and
   look.
   `cli chainpath bundle.json --from A --to B` prints the wrap-node polyline per
   frame in px (node count > 2 means the chain caught a corner). Reach for these
   the moment a bug is about position/shape rather than a stuck/velocity number.
4c. **See what the *player* sees.** Everything above draws its own picture of the
   sim state, which is exactly why none of it can see a bug in the drawing.
   `cli shot bundle.json --frame N --out f.png` draws the frame with the **real**
   renderer: it starts the dev server, loads `shot.html` (which replays the
   bundle to that frame at `alpha = 1`, so the grab is reproducible), drives
   headless chromium over the DevTools protocol and tears the server down again.
   `cli shot --diff before.png after.png` gives a changed-pixel count and a
   highlight image, which is how a claim about a renderer change is evidenced.
   `--3d` grabs the same frame through the WebGL renderer instead, which is the
   only headless view that can see the 3D scene at all: every other one draws its
   own picture of the sim state and is blind to the renderer by construction.
   `cli shot bundle.json --dump A..B` takes no picture: it prints the chain state
   of every frame in the span as one JSON line each (the ball's pose, the hook,
   the anchor, every node of the wrap path with its body, piece and position),
   simulated on the SAME engine that recorded the bundle. It was written when the
   browser and bun disagreed about a 1-ulp libm result and a long recording's
   tail was chaotic in that: what the player saw at f3600 was reproducible only
   there, and every bun-side view (`cli chainpath`, `cli render`, `cli query`) was
   by then describing a different run (`session-3649f`, diverged in bun from f859).
   Since `dmath` (see [**Cross-platform determinism**](physics-foundations.md#cross-platform-determinism)) the two engines compute the
   same bits and the bun-side views describe the player's run; the dump remains
   the way to ask the browser build itself, and the only view of a bundle
   recorded before the change.
   `--frames A..B --every K` draws a filmstrip instead of a frame, in one page
   load, and prints the changed-pixel count between adjacent tiles - which is the
   only headless evidence there is for anything that MOVES (see **Debugging
   rendering**).
   Neither makes perceptual quality *assertable* - no number here says whether a
   settle looks convincing - they make perceptual claims cheap to evidence.
   Reach for it when the report is about what something *looks* like. The chain
   wound onto the ball drew as blank space for want of one `floor` (see
   `drawChainPolyline`), and every CLI tool called that run perfectly healthy,
   because it was.
   **The grab comes with the page's console**, printed as `[page] <level>: ...`,
   and an `error`-level line fails the command (`--allow-errors` to override) and
   puts a red banner on the PNG itself.
   That is not a nicety: a shader that fails to compile draws nothing at all, so
   without it the command reports a perfectly ordinary-looking screenshot of a
   renderer that never ran.
4d. **Leave it alone and watch.** `cli settle bundle.json --from N --frames M`
   continues from a frame with zero input and reports the kinetic-energy
   trajectory, the fastest body, and the net drift, failing unless the scene
   comes to rest and stays there.
   It catches the two opposite failures a replay cannot: energy appearing out of
   nothing, and a body that reports itself at rest while creeping across the
   level.
5. **Verify.** `bun run test` - typecheck, selftest, the case suites, every
   playtest (the ball mechanic suite included) and the whole bundle corpus, under
   one exit code. `selftest` must stay bit-identical, for the avatar *and* for
   the rest of the world (static-path behavior may never change; mobile behavior
   is gated behind `isMobile`/`isRotating` branches). To confirm a fix
   actually changed the felt behaviour — which plain replay *cannot* show once
   the fix diverges the recorded tail (see Bundle semantics) — use the **A/B
   fork**: `cli compare bundle.json --frame <forkFrame> --ref <oldRef>` replays
   the bundle to the fork frame under both the current tree and `oldRef`, then
   runs both past it and diffs the full world per frame. Because the sim is
   deterministic and a fix only bites at the issue frame, both sides reproduce
   the *same* pre-issue state, so the diff (and the two before/after SVGs) is
   exactly the fix's effect. Pick
   `oldRef` = the commit just before the fix, and `forkFrame` = a frame where old
   and new still agree, just before the issue; if they already diverge there the
   command says so in as many words rather than presenting the diff as the
   change's effect. It runs old *physics* with new *tooling* (it copies the
   current `src/tools` + `src/sim` into a worktree of `oldRef`), so the command
   need not exist in `oldRef`; this holds only while the tooling touches stable
   physics interfaces (`physicsProcess`, body/rope fields), and a worktree that
   cannot run is reported as an error rather than as an empty diff.
   It also refuses to compare a tree against itself: both sides' identity is
   always printed (commit plus a hash of any uncommitted diff) and identical
   trees are named as such. The shell script this replaces did exactly that twice
   in one day - an empty `git stash` and a wrong cwd - and both times reported
   "no difference", which reads as a verified fix.
5b. **Present the A/B as a `cli ab` table.** `cli compare` answers one frame of
   one bundle, which is the right question once you know where to look and the
   wrong one for "is the corpus better or worse after this change".
   `cli ab <bundle|dir>... [--ref REV]` replays each bundle on this tree and, with
   `--ref`, on that revision in a detached worktree, and prints one row per bundle
   with a final `WORST` row - because a change is judged by the worst bundle it
   leaves behind, not the average one.
   The columns are the numbers every physics decision on 2026-09-04 was actually
   made on: `peakV`, `peakAnchorV` (the body the chain's far end sits on - the
   half of a two-body interaction no avatar-shaped tool could see), `maxLease`,
   `worstOverLength`, `pushRun` (the longest run of push-out credit, which is what
   distinguishes a pump from a flick), `maxSolveKick`, `energyGain`, `violations`
   and `divergedAt`.
   Each was read off a scratch scanner that was rewritten and thrown away, and
   re-run with env-var toggles to produce the before column; the toggles are a git
   revision now.
   `session-324f --ref 93405ae` prints `peakV 4.76 | 19.80`, `anchorV 5.85 | 20.24`
   and `lease 0.040 | 0.608` - the anchor pump in three columns.
   A metric the reference revision cannot express prints **`n/a`, never `0`**:
   `pushRun` reads `n/a` at `93405ae` because `chainPushCreditFrames` did not exist
   yet, and printing zero there would say the old tree swept a metric it cannot
   even measure.
   The whole 82-bundle corpus A/Bs in about 33 s (one emitter process per side,
   not one per bundle); `--metrics a,b,c` narrows the table and `--json` is the
   machine form.

Key invariant — the **`input-frozen` stuck detector** (`src/sim/trace.ts`):
held direction for 45 frames with a mobile body nearby must produce ≥0.25 m of
displacement along the input, or >0.1 m *against* it (yielding to a mover's
push is displacement, not a freeze — wedge rules). Counts every input-held frame regardless of
state (state thrash must not reset the window); exempt: active rope, ledge
hang/climb, wall-jump startup, and purely static blockers (pressing into a
static wall is legit). Runs inside every playtest, replay, and continue.

The corpus lives in two places. `playtests/regressions/` is **committed**
(gzipped, whole - a bundle replays from frame 0 by design, so trimming one makes
it a different bug) and holds every bundle a postmortem here cites, so a fresh
clone can run the same evidence this document argues from. `playtests/bundles/`
stays gitignored local scratch. Both are replayed by `cli bundles` and by
`bun run test`.

Bundle semantics: digest divergence in `cli replay`/`cli bundles` is
**informational, not failure** — a bundle recorded before a physics fix
legitimately diverges from the frame the fix first bites; invariants are the
pass/fail signal.
`replay` distinguishes the two kinds it can see: `bit-identical behaviour (…
float noise)` is a settled body jittering in the last ULP (ignore it), whereas
`drifted @fN (maxDrift=…px)` or `behaviour forked @fN (different state branch)`
is a real path difference — `maxDrift` in the `bundles` line tells a faithful
bundle (≈0px) from a stale one (hundreds of px) at a glance.
Consequence: after a real divergence the re-simulated tail no longer matches
what the user experienced — diagnose via the detector's frame numbers on the
*current* simulation, not the recorded tail, and to check a fix landed at the
felt frame use the **A/B fork** (step 5) rather than reading the diverged tail.

Past root causes worth suspecting again (all found via this loop): absolute
velocity zeroed instead of surface-relative (PROJECT/CEILING cases), locomotion
basis stolen by a mover's corner normal (static-floor preference), separating
depenetration contacts redirecting escape velocity, phantom "hit-from-inside"
sweep normals on thin rotating shapes (guards in `World.moveAndCollide`),
near-threshold face classification flapping on rotating bodies (grip grace in
`lib/surface.ts`), a body left **embedded** in geometry because a depenetration
pass did not cover that geometry's kind (`session-1474f`) or resolved a wedge one
face at a time (`session-284f`) — the rope then pays the whole accumulated path
debt in one frame the moment it emerges, which reads as a launch — and a
**touch reported as an overlap**, which arms the rope's self-intersection
resolvers permanently: a contact stored in its body's local frame sits on the
surface for ever, so "the span is inside the body" is true on every span touching
that anchor, and the resolvers' "already on this vertex, step one place round the
loop" rule then jumps the wrap to whatever corner is next — 1.54 m away on a 3 m
polygon (`session-284f` again), and a **rope contact indexed at the wrong shape**
of a compound body, which sends those same resolvers round a vertex loop the span
never touches, so the rope runs clean through the piece it is anchored to
(`session-234f` — see "A `RopeContact`'s `shapeIndex`" under Shapes).

Three more, all from `session-735f`, all of them things that were *invisible while
every body carried one shape and every rope was handed the whole world*:
**contact velocity measured at the body centre instead of the contact point** -
`resolveRigidCircle` built its approach velocity from `linearVelocity` alone,
which is exactly right for a centred circle (ω × r is purely tangential there and
contributes nothing) and wrong for every offset one, so a compound body's second
circle could not see the spin the first circle's impulse had just added and had no
way to cancel it; two circles resting flat on a floor torqued each other in turn
for ever, a 2 px rock at 6 Hz that never damped;
**a wrap node on a removed body** - every regeneration re-emits the existing wraps
before it looks for new ones, so nothing else ever takes such a node out, and a
chain the hook flew through kept one welded to the spot the hook was destroyed at
for 400 frames (`Rope.dropWrapsOnGoneBodies`);
and **a solve that corrects position for bodies it never credits velocity to**
(see "Chains" - the `moved` set).

The broadest of that family, from `session-306f`: **a query that reads
`primaryShape()` on another body**, which sees the first-mounted piece and treats
the rest of a compound body as empty space. It shows up as tunnelling, as an
anchor floating off the geometry, or - when it is an invariant doing it - as
nothing at all. See "Asking a body for its shape is almost always a bug" under
Shapes; whole-body geometry goes through `bodyOverlapCircle` / `bodySweepCircle`
/ `bodyContainsPoint` now, so the loop cannot be forgotten.

Its twin, from `session-358f`: **an exclusion written by body where it means
shape**. The wrap scan skipped `body === span.from.contact.obj ||
body === span.to.contact.obj`, which is right for the piece the span is tied to
and wrong for that piece's siblings - so the moment the chain wrapped one piece
of a compound wall, every other piece of that wall stopped existing for the
adjacent spans and the chain cut straight through the one in its way. Now
excluded by `contact.shape`; `shouldIgnorePathCollisions` and the coil-run test
in `generatePathObjects` were the same mistake and are shape-level too.
The general rule: **`obj` identity answers "does this move as one rigid piece
with that", `shape` identity answers "is this the same surface"** - and every
collision question is the second one. `lengthPerRadian` and the self-wrap tests
in `generatePathObjects` are genuinely the first, and stay by body.

Structurally, the rope's wrap scan now flattens the scene into a list of
`WrapCandidate` **surfaces** once per regeneration (`wrappableSurfaces`) and
filters that per span, so past that line there is no `PhysicsBody2D` in scope for
the comparison to be written against. A body reappears only where a body is what
is meant: building a `RopeContact`, which names a body *and* a piece of it, and
the seam test, which is about how a body's pieces are arranged.

That last one is also a reminder that a geometric bug can be **completely silent
to the invariants** — `session-234f` replays HEALTHY, with no NaN, no runaway, no
over-length and no embedding, because nothing about it is a velocity. Reach for
`cli render` and `cli chainpath` the moment a report is about where the rope *is*
rather than about how fast something is going.

Those last two share a shape, and it generalises into a rule worth applying before
reaching for the solver: **a one-frame velocity spike is almost never the solver
being wrong about this frame — it is the solver being right about a discontinuity
that should never have built up.** Look for the state that was allowed to drift
out of bounds over the preceding frames (an embedded body, a path the rope was
allowed to route through solid geometry, a contact test that has been answering
"inside" since the moment the rope attached) rather than for the impulse that
finally released it.

## Debugging discipline

Rules distilled from the sessions this loop was built in.
Each one exists because its absence cost a real debugging day.

- **Record a browser bundle against every physics change, and run `cli diverge` on it.**
  Headless validation alone shipped two defects on 2026-09-04 that a single fresh recording would have caught the same hour: the browser/bun determinism knife-edge, and the loop hammer the hold-then-pair redesign left standing.
  The bundle's own `selfReplay` verdict covers the live-vs-re-simulation class but *cannot* see a browser-vs-bun difference (see [**Determinism & correspondence**](physics-foundations.md#determinism-correspondence-to-the-c-source)); replaying the fresh bundle here is what does.
- **A bundle recorded before `dmath` (2026-09-07) may sit on the libm knife-edge; one recorded after it cannot.**
  Since the sim stopped calling the platform `Math` (see [**Cross-platform determinism**](physics-foundations.md#cross-platform-determinism)), a browser bundle replays bit-exact under bun, and a divergence on a fresh recording is a physics finding rather than a libm one.
  For the historical bundles - `session-3649f` f859, `session-1052f` f379 before the change - the frames after the knife-edge under the old tree were bun's, not the player's, and the way to see the player's run was to build the CLI for the browser's engine: `bun build src/tools/cli.ts --target=node --outfile=<scratch>/cli.node.mjs`, then `node <scratch>/cli.node.mjs diverge bundle.json` (the tree stamp reads MISMATCH under node because the bundled file cannot find the source files it hashes; ignore that line).
  That build still works and is still how a V8-only question is asked; `cli shot --dump` reaches the same truth through headless Chromium at the cost of a browser launch per query.
- **No fix before a measured cause.**
  State the root cause with a number from a replay, probe, or trace before editing the solver.
  A theory that fits the code is not a diagnosis: the rope-refund bug survived four sessions because a plausible neighbour (missing rigid-rigid friction) was fixed instead of the measured energy source (`session-394f`/`458f`/`431f`/`726f`).
- **Your own evidence beats your own theory.**
  When a trace contradicts the current hypothesis, the trace wins, immediately.
  When the corpus passes without a guard, the guard is unnecessary; do not construct a scenario to justify keeping it.
- **Red then green.**
  A fix for a reported bundle needs a detector that goes red on that bundle before the fix and green after (step 2 above).
  Prove it by temporarily reverting the fix: the new detector must catch the original bug on its own.
- **A second report of the same symptom means audit the class.**
  Stop fixing instances: enumerate every site that could carry the same blindness (grep for the pattern) and fix or rule out each.
  The compound-body corner class took four separate user reports (`234f`, `410f`, `306f`, `358f`) because each instance was fixed alone.
- **Two failed attempts means revert and report.**
  After two attempts that each trade one measured problem for another, revert to green, write down the diagnosis and what was tried, and stop.
  A precise diagnosis with no fix is a better deliverable than a half-fix left in the tree (`session-326f`).
- **Prefer the textbook.**
  The rigid bodies here are a solved problem; when a patch fights the structure, ask "what does Box2D do" before inventing (see [**The contact solver**](contact-solver.md#the-contact-solver)).
- **Name what green cannot see.**
  Before claiming a fix verified, state which of the blind spots below apply and what covered them - a probe, a render, or an explicit "needs a manual playtest for X".
- **New physics state ships with detectors.**
  A change that adds simulated state (a new body kind, constraint, or solver path) must extend the digests and invariants to cover that state in the same change, before playtesting.
  Both polygon launch bugs (`1474f`, `284f`) escaped to manual play because the detectors lagged the feature.
- **A bundle whose tree does not match is evidence about a different tree.**
  Every replaying command prints `tree: match` or `tree: MISMATCH` against the bundle's `srcHash` (see [**Running**](running.md)).
  A MISMATCH does not make the numbers wrong; it makes them numbers about code that is not in front of you, which is worse, because they read exactly like numbers about code that is.
  Two "still broken" recordings on 2026-09-04 were of a revert that had already landed.
- **Edit source with the Edit tool, never scripted string replacement.**
  A `str.replace` that matches nothing silently no-ops and reports success; a real edit with a stale anchor errors.
  The same rule for baselines: compare against a git rev (`cli compare --ref`), never a `git stash` round-trip - an empty stash silently compares a tree against itself, which is why the command now prints both sides' tree identity and refuses an identical pair outright.

## What the verification suite cannot see

The current blind spots, kept here so "all green" is read with them in mind.
Remove an entry when tooling closes it - `plans/tooling-improvements.md` is the plan doing that.

- **Digest divergence does not gate.**
  A behaviour change that stays under every invariant threshold passes silently; only invariants fail a run.
- **Invariants are velocity-shaped.**
  Purely geometric wrongness - a rope through a wall, an anchor floating off a surface - replays HEALTHY (`234f`, `306f`); `cli render`/`cli chainpath` plus eyes are the only detectors.
  `cli scan` covers part of the gap (embedding depth and settled-body drift are geometric), but nothing detects a rope taking a wrong path that is still the right length.
- **Nothing GATES a render.**
  `cli render3d` covers the arithmetic the 3D scene stands on - the camera correspondence, the extrusion's winding, the scene-object round trips (including the REAL ball level, on counts, which is what catches the editor silently dropping something) - and `cli shot` makes the grab, the pixel diff and the motion profile one command each, but nothing runs any of them for you.
  A renderer change is evidenced on request, not gated, and `bun run test` stays green through a scene that looks wrong.
  Every CLI view draws its own picture of the sim, so a bug in the drawing itself (`1467f`) is invisible to all of them.
  What is no longer blind: the page's console reaches the CLI and fails the grab (see [**Debugging rendering**](debugging-rendering.md)), motion is evidencable in one command, and a blank 3D frame reports itself.
- **The editor autosaves, so anything reading a level while it is open is racing a writer.**
  A named model writes itself back 750 ms after any edit, which means an open editor tab is a second author of `levels/*.json` - and a page holding a stale model will happily write that model over a newer file. It has already cost real authored content once. Close the editor before touching a level from a script, and treat a level file's mtime moving while you did not write it as exactly what it is.
- **Perceptual quality has no oracle.**
  Whether a rotation or settle looks convincing is judged only by a human or a render; corpus numbers stayed green through three re-reports of unconvincing rotation.
- **Recorded bundles cannot confirm fixes.**
  After a physics change the recorded tail legitimately diverges, so only `cli compare`, `cli ab --ref` or a scripted scenario shows a fix landed.
- **A pump against a LIGHT free anchor is still reachable, and nothing in the suite runs the rig that finds it.**
  `cli rig playtests/rigs/light-box-anchor.json` - a 1 kg free box on the floor, chained point-blank, the aim whirling at 24 frames a revolution - drives ball and anchor together from 0.5 m/s to 37 m/s, with `pushRun 9` against a bar of 6, `maxSolveKick 20.5 m/s` against a bar of 4 and 198 `rope-over-length` violations from f63.
  It is the `session-324f` anchor-pump signature (the pair leaving together, credit re-earned every frame) against a body far lighter than the 12.6 kg hung weight that pump was found and fixed on.
  It survives the whole mass range tested: 5 kg still gives `pushRun 7` and 12.9 m/s.
  Found by the rig tooling on the day it landed, and **not diagnosed** - it needs a measured cause before anything is edited (see **Debugging discipline**).
  Nothing gates it: rigs are instruments and `bun run test` does not run them.
- **The A/B cannot reach far back.**
  `cli compare` runs current tooling against old physics, which works only while the tooling's imports exist in that revision: it breaks at anything older than `bodyOverlapCircle` and `World.collectContacts`, which is exactly where several of the historical defects live.
  Re-introducing such a defect locally is then the only way to prove a detector catches it.
