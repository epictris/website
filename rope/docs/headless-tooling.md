# Headless tooling

```sh
bun run test                                  # THE suite: typecheck + every check below, one exit code
bun run replay selftest                       # determinism + replay round-trip check (grapple and ball)
bun run src/tools/cli.ts ledges               # generated ledge-grab matrix (speed × angle × negatives)
bun run src/tools/cli.ts corners              # corner-exposure geometry cases (compound-body seams)
bun run src/tools/cli.ts tangents             # tangent-vertex cases (which corner a wrap node is born on)
bun run src/tools/cli.ts decompose            # convex decomposition of authored concave outlines (partition, seams, determinism)
bun run src/tools/cli.ts dmath                # the deterministic libm: bit-exact vectors on this engine + no platform Math in the sim
bun run dmath:crosscheck                      # how far THIS engine's own Math is from it (an instrument, not a test)
bun run src/tools/cli.ts contacts             # rigid-body contact cases (settle/stack/ramps/impact/momentum/loop-cap/loop-ride)
bun run src/tools/cli.ts spring               # spring-body cases (droop, load and release, per-axis periods, the locks)
bun run src/tools/cli.ts movers               # scripted-mover cases (the arc, the route, the ease, the rider, the speed bar)
bun run src/tools/cli.ts vines                # vine cases (the pass-through guards, drape, grab, winch, the load rope)
bun run src/tools/cli.ts sleep                # sleep cases (a hung body and its chain sleep, the hook / a landing / a platform / an impulse wake, the lead swap, the stack, the arena)
bun run src/tools/cli.ts rails                # rail cases (the stroke, the cone, the clamp, the coast, the jam, the catch)
bun run src/tools/cli.ts viscous              # viscous (mud) cases (the creep law, the hang, the catch, the drop-out, the format)
bun run src/tools/cli.ts camera               # camera-path geometry, the rule set, and the editor's path round trip
bun run src/tools/cli.ts render3d             # 3D camera correspondence, extrusion winding, depth order, surface resolution, `visual` round trips
bun run src/tools/cli.ts assets               # prop + texture budget, stale bytes, orphans, licences (see The asset store)
bun run src/tools/cli.ts latch                # the button latch that carries a sub-step click into the next sample, and the click audit
bun run src/tools/cli.ts clicks session.json  # the DOM button story a P bundle carries, laid against its frames (see The input latch)
bun run src/tools/cli.ts play  playtests/grapple-swing.json
bun run src/tools/cli.ts record playtests/ball-wind-up.json --out session.json  # script → real bundle
bun run src/tools/cli.ts replay session.json  # replay a P-exported bundle, run invariants
bun run src/tools/cli.ts diverge session.json # WHERE a replay first leaves its recording: frame, field, phase
#   every replaying command above prints `tree: match` / `tree: MISMATCH` for the bundle's source stamp
bun run src/tools/cli.ts bundles              # replay playtests/regressions/ + playtests/bundles/
bun run src/tools/cli.ts scan session.json    # anomaly sweep: spikes, embedding, drift, flicker, stalls
bun run src/tools/cli.ts scan --all           # the same over the whole corpus, printing only what is notable
bun run src/tools/cli.ts query session.json --frame 314 [--json]  # the full sim state at a frame
bun run src/tools/cli.ts trace session.json --from 450 --to 460 --body 0  # per-phase Δv attribution
bun run src/tools/cli.ts trace session.json --from 192 --to 192 --solve    # ...plus every length-solve iteration
bun run src/tools/cli.ts settle session.json --from 500 --frames 600      # continue with zero input, must rest
bun run src/tools/cli.ts dump session.json --from 100 --to 200   # digest+input table
bun run src/tools/cli.ts continue session.json --from 500 --hold left --trace t.jsonl
bun run src/tools/cli.ts render session.json --frame 65 --out f65.svg   # SVG snapshot of one frame
bun run src/tools/cli.ts shot session.json --frame 65 --out f65.png     # the REAL renderer, headless
bun run src/tools/cli.ts shot session.json --frame 65 --3d --out f65.png # ...through the WebGL renderer
bun run src/tools/cli.ts shot session.json --frames 60..120 --every 10 --3d  # a filmstrip + motion profile
bun run src/tools/cli.ts shot --diff before.png after.png               # changed-pixel count + highlight
bun run src/tools/cli.ts chainpath session.json --from 60 --to 70       # chain wrap-node polyline per frame
bun run src/tools/cli.ts fork session.json --frame 979 --frames 24      # state trace + before/after SVG around a frame
bun run src/tools/cli.ts compare session.json --frame 979 --ref <rev>   # A/B this tree against a revision, one frame
bun run src/tools/cli.ts ab      playtests/regressions --ref HEAD~1    # ...the metric table over a whole corpus
bun run src/tools/cli.ts rig     playtests/rigs/ceiling-hold.json [--series] [--save f.json]  # a scenario as data
bun run src/tools/cli.ts ab      session.json --metrics peakV,pushRun  # the same metrics on this tree alone
```

`bun run test` is what "all green" means: typecheck, `dmath`, `selftest`, `contacts`,
`spring`, `movers`, `vines`, `rails`, `viscous`, `corners`, `tangents`, `decompose`, `camera`, `render3d`, `assets`, `ledges`, every `playtests/*.json`,
then the bundle corpus, in that order and under one exit code.
A case that is red on purpose carries `expectedFail` (see `sim/contactCases.ts`),
which the runner counts as a pass and, crucially, **fails on if it ever passes**:
a stale marker is a lie about coverage, so the fix that closes the gap has to
remove the marker in the same change.

Playtest scripts are frame-indexed held-button ranges + aim waypoints with
asserts (`reachState`, per-frame `state`/`maxSpeed`/`hasRope`/position bounds,
and `window` asserts over a frame range).
They drive **either controller**: the ball's actions are the same FrameInput
fields under its own names (`deploy`, `restart`, `aim`), and a script may carry
its own `data` (an arena authored inline, as a bundle does) and a `spawn`
override in metres.
`playtests/ball-*.json` is the mechanic suite that lives on top of that; see
**What a mechanic test is for** below.
Invariants checked every frame: NaN, runaway speed, rope-over-length (once
anchored), player-embedded-in-geometry.
Ball runs add: `rope-anchor-kick` (the solve added speed on the frame the chain
anchored — an anchor born over its length), `rope-solve-kick` (the solve added
more than 4 m/s in **any** single frame), `rope-credit-unearned` (the chain phase
took more along its own pull than the constraint was opening at), `chain-clip`
(a span's interior deep inside static geometry), `chain-body-embedded` (a
rigid body the chain runs over - its anchor, or anything it wraps - deep inside
static geometry; the chain solve is the one thing that hauls those into the
scenery, and `session-133f`'s plank tunnelled through a post HEALTHY without it)
and `chain-tunnel` (a wrappable body a chain span passed *through* between two
frames without the chain bending round it - see [**Continuous wrap detection**](wrap-detection.md)).
`rope-solve-kick` exists because `runaway-speed` is a 1000 m/s ceiling and so
never saw a 96 m/s one-frame launch.
It is measured against what the frame's own **winding** entitles the solve to:
winding chain onto the ball shortens the free span by `|ω|` × the spool rate and
the winch pays for that by hauling the ball in, so at 41 rad/s on the ball's own
rim the chain legitimately reels in 9 cm in a frame - 5.5 m/s, and nothing to do
with a launch (`session-265f` f139).
A launch has no winding behind it, so subtracting the budget leaves that case
exactly as visible while taking the mechanic out of the measurement: past the
subtraction the whole corpus sits under 1 m/s, against a bar of 4. It is the general form of
`rope-anchor-kick`, which only ever watched the anchoring frame.

`rope-credit-unearned` is the **sharp** form of the same idea, and it exists
because `rope-solve-kick` is a bar on the SIZE of a one-frame gain and therefore
has to sit clear of every legitimate one: a chain going taut on a fast swing
brakes several m/s in a frame, so the bar is 4, and `session-360f` slipped under
it at 2.1.
A constraint may only remove the motion **opening** it, so this measures the gain
against that entitlement rather than against a number - a legitimate brake reads
zero however large it is, while the same frame reads 2.18 m/s of speed the chain
was never owed.
It is taken over the phase's realised velocity change rather than over the credit
term alone, so it covers the spin rollback, the unwind and the into-surface
refusal too, and is a statement about the frame rather than a restatement of the
clamp `Rope.clampCredit` applies to one of those terms.
Exactly one frame of the whole ball corpus reaches over the bound at all
(`session-1426f` f714, 0.21 m/s), so the tolerance is 0.6.

`rope-anchor-kick` subtracts **the same budget**, and for the same reason.
The shot leaves through the loop, so the ball is usually still turning when the
hook lands, and a ball spinning as its anchor is born is winding chain onto its
own rim exactly as it is on any other frame - hauling it towards the anchor is
what pays for that, and it is the mechanic rather than a lurch.
Charged to the bare bar it read as the bug at 1.1 m/s out of a 2.7 m/s
entitlement, on frames whose over-length was 100% the winding's (`session-234f`
f84, `session-576f` f61).

What the invariant *is* for still happens, and the cause is an ordering one.
An anchor is born at no less than the length the chain had reached
(`BallPlayer`'s attach callback - the length may GROW to what the hook reached
and never shrinks, so a tip that dangled slack and then touched down keeps its
slack instead of snapping to a straight line, session-161f; `cli contacts`
`attach-keeps-length` is the detector), which is what leaves the constraint
already satisfied on its first frame and the solver with nothing to correct - but that measurement is taken in
the hook's swept attach check at the **top** of the frame, before `integrate` and
the push-out move the ball, so the promise holds only for a ball that then does
not move.
One that does is charged on its very first frame for the distance it travelled
after the chain was already attached: a ball falling the last 2.5 cm onto the
ground had its 6 cm chain measured 2 cm short, and the solve flicked it back off
the floor at 0.9 m/s (`session-1195f` f590) - precisely the resting-ball lurch
the invariant is named for.
So `BallLevel` re-takes the birth length in the chain phase, where the frame
actually leaves the ball, less the **winding's** share of it: chain wound onto
the rim this frame is the winch's to haul in and the unwind's to refuse, and
handing it to the length instead would pay the ball for its own kinematic spin.
It only ever lengthens, so an anchor born slack - the ball travelling towards it -
keeps the length it reached at.
Ball runs also carry **`roll-unfunded`** (`RollMonitor`): a ball gripping a
surface may not travel along it faster than its own spin and the chain account
for.
A contact that is not held at its friction bound has been solved to **no slip** -
the contact point is stationary against the surface - so the ball's centre moves
along that surface at exactly `radius x omega` and nothing else, and the chain
phase's own PBD credit (`BallLevel.chainCreditVelocity`) is the one other thing
entitled to have moved it.
What is left is a body being driven along a surface by nothing at all, which is
the shape of every friction motor here and of `session-315f` (0.5 m/s, sustained,
out of a ball whose spin was 0.03 rad/s).
It fires on 0.15 m/s carried for 30 frames, because the quantity is a **drive**:
an unfunded push is re-earned every frame for as long as its cause lasts, where a
landing or a wrap appearing is over in a handful.
The exemption is `ContactConstraint.limited` and *not* `slipping`, and the
difference is load-bearing: `slipping` is asked of the bare Coulomb cone, while an
aiming ball's cone is faded in the braking direction (`contactBrakeScale`), so a
ball skidding to a halt under the aim sits at exactly its real bound with a
tangent impulse well inside `mu * Pn` and reports `slipping: false` - 11.595
against a faded bound of 11.60 and a cone of 15.32 (`session-477f` f170).
The load-bearing contact is also chosen *before* the bound question is asked
rather than from among the contacts that pass it, or a ball skidding on its rim is
measured at whatever grazing touch its mounting loop happens to have.
Ball runs also carry the **energy invariant** (`energy-gained`): over any span
with no forced input and no kinematic spin, total kinetic plus potential energy
may not rise beyond a tolerance.
The gate matters as much as the check.
Winding the chain in or out does real work and the aim steering is an unbounded
spin source, so the invariant arms only while the sim is unforced; holding
`deploy` is not a source, and gating on "any button held" disarmed it across
almost every recorded session, which is how it was first written and why it
detected nothing.
It is sized against measured numbers rather than round ones, and it is sized as a
**speed** so that it cannot go stale when a mass changes: a span may gain no more
than the ball's kinetic energy at 0.8 m/s (five times the corpus's measured noise
floor), plus 5% of the span's peak kinetic energy.
Solver noise is float error on the energies themselves, so it scales with them;
a tolerance pinned to a joule count does not, and the same bar was written as
1e-4 J while the ball weighed a third of a gram (see [**Mass and materials**](physics-foundations.md#mass-and-materials)).
This is the class of bug that was found late four times as the rope refund and
once more as a friction motor, every time by hand.

## Full-world digests

`Digest` is the avatar's and always was, which is why a rigid-pile jitter
regression once shipped under a "bit-identical" claim (`session-298f`).
`WorldDigest` (`sim/trace.ts`) carries every body that can move - position,
rotation, linear velocity and **angular velocity**, which no avatar digest ever
had - plus the chain's node count, path length, `maxRopeLength` and
`blockedSlack`.
Bodies are named by **build order** (`CollisionObject2D.buildIndex`, stamped by
`World.add`) rather than by the process-global `id`, so two builds of the same
level agree; `cli replay` reports world divergence separately from avatar
divergence and names what carried it (`world: body#3 drifted @f412`).
A P bundle gains an optional `worldDigests` array at the same cadence as
`digests`, so old bundles replay exactly as before and new ones are compared on
the whole scene.
`cli selftest` demands bit-exactness on all of it, for a grapple script *and* for
a ball script recorded headlessly through `cli record`.

The digest also carries what the chain phase **decided**, not only what the chain
measured, because a chain-phase bug was not readable from a bundle at all
without re-simulating it.
Each field answers one question that was asked by hand on 2026-09-04:

| Field | The question it answers |
|-------|-------------------------|
| `chain.aimSpin` | What did the steering command this frame? (`BallLevel.aimSpin`) |
| `chain.unwindRefund` | How much of that turn did the unwind hand straight back? (`BallLevel.chainUnwindRefund`) |
| `chain.stalled` | How much length did the winch stall have to let out? (`Rope.stalledLength`) |
| `chain.geometryPush` | How far did the frame's push-outs move the ball - the SIZE of the refusal? (`Rope.geometryPush`) |
| `chain.winchBudget` | How much speed did the frame's own winding entitle the solve to? |
| `chain.pushCredit` | How much speed did the phase hand the ball out of a surface it pushed it out of? |
| `chain.anchorBody` | Which body is the far end on - the OTHER half of a two-body interaction? |
| `body.contactWith` / `body.contactPn` | Was this body touching, and how hard? (strongest of `World.frameContacts`) |

`aimSpin` and `unwindRefund` are the pair that make a wound-tight frame legible
at all.
A chain wound tight refuses the whole commanded turn, so the ball's angular
velocity at frame *end* reads exactly zero on precisely the frames that matter,
and every digest there was showed a ball sitting perfectly still while the
steering was writing 41 rad/s at it and the winch was being fed the whole turn's
worth of chain (`session-154f`, `session-477f`, `session-726f`).
`anchorBody` is there because a two-body interaction was diagnosed from one
body's digest and the first divergence was attributed to the wrong body once: the
ball's digest cannot say anything about the 12.6 kg weight it is hauling against
unless something points at it.

All of them are **optional** on the wire and every reader treats a missing one as
*not recorded* rather than as zero: a bundle from before a field existed has no
opinion about it, and measuring a replay against an invented zero would report a
divergence its recording never made.
`cli dump` prints them under each digest row (plus the avatar's strongest contact
on the row itself) and `cli query` prints them on the chain's own line, so both
are read off the bundle rather than re-derived.

## What a mechanic test is for

`playtests/ball-*.json` asserts the mechanics themselves - winding, the winch,
rolling, swinging, hanging still, holding a ceiling, wedging - because no
aggregate can stand in for them: the A/B variant that won every drift and
runaway number in `session-475f` had simply stopped the chain winding at all.
Each scenario authors the arena that isolates it inline rather than borrowing the
authored level, so it cannot fail for reasons that are not the mechanic's, and
each asserts BOUNDS over a window rather than values at an instant.
They are the mandatory success criteria for any physics A/B.
`ball-roll-drive-rigid` is the sharpest of them: it is red at `25d8357` with
`travelX=0.0000` (the `session-314f` regression, a ball spinning at 20 rad/s
sitting still on a rigid floor) and green at HEAD at 6.8 m, while its static-floor
twin passes on both sides.

**A new scenario starts as a rig spec and is committed as a playtest.**
`playtests/rigs/*.json` are `RigSpec`s (`sim/rig.ts`): an arena, a point to fire
at, an optional wind-up and one aim pattern - ten lines of data for what used to
be thirty to sixty lines of identical wiring per scenario, written five times on
2026-09-04 and thrown away the same day.
`cli rig spec.json` builds the arena, fires, winds up, drives the aim and prints
the `cli ab` metric row; `--series` prints the per-frame ball speed, anchor
speed, lease, over-length, push credit, aim spin and node count; `--save`
writes the expansion as an ordinary playtest and `--bundle` writes a real
bundle, so a rig that finds something is immediately a repro every other command
here can read.
`windUp: { until: "riding" }` whirls until the ball is riding the body its chain
ends on, resolved by a probe run rather than by a guessed frame count - and read
straight out of the world digest's `chain.anchorBody` and `body.contactWith`,
which is the question those fields were added for.
There is one execution path: `runRig` runs the same expansion `--save` writes, so
a saved rig cannot behave differently from the rig that produced it.
`playtests/rigs/ceiling-hold.json` is 14 lines and expands to a 274-line playtest
that `cli play` runs green; the hand-written equivalent
(`playtests/ball-ceiling-hold.json`) is 821 lines, 110 of its aim ranges spelling
out "circle the aim once every 24 frames".
The five shipped rigs are the five from that session: the hung trapezoid on a
1.6 m chain (`hung-trapezoid-whirl`), the steady ceiling hold (`ceiling-hold`),
the static and rigid crush slabs (`crush-static-slab`, `crush-rigid-slab`) and
the free box on the floor (`light-box-anchor`).
A rig is an **instrument, not a test**: `bun run test` does not run them (the
runner's playtest glob is not recursive), and a rig that comes back red is a
finding to chase rather than a build to fix. `light-box-anchor` is red today -
see [**What the verification suite cannot see**](debugging-physics.md#what-the-verification-suite-cannot-see).
