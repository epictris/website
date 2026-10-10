# Plan: rope bridges, and many ropes as one system

> **Status: stage 1 landed** (2026-10-10, same day as the proposal), written from `session-235f` and the solver study in `scripts/bridge-solver-study.ts`.
> The brief was the best architecture on the physics and the numbers, irrespective of development cost and of the conventions the chain phase currently follows.
> Vines are out of scope throughout: a bridge is slats and ropes, and this plan is about ropes.
> What landed, and where it departs from the design below, is in **What landed** at the end; the design sections are left as proposed so the departures read against them.

## The ask

A rope bridge: wooden slats hung between two posts, each slat tied to the next by a short rope, the ball rolling across it or hanging from it.
Today that is one `SceneChain` (a full `Rope`) per tie, twenty of them for nineteen slats, solved by `sweepChains` as a Gauss-Seidel sweep over independent rope solves.
`session-235f` is that rig, and it is both wrong and slow.
The question asked was whether one rope that knows every connection point, solved at once, is the way to make it right and cheap.
The answer is yes at the level of the **object** and the **island**, and no at the level of the **linear algebra**, and the rest of this document is the measurements that say which is which.

## What `session-235f` measured

19 slats of 2.625 kg (0.15 x 0.05 m, I = 5.5e-3 kg m²), the 52 kg ball, 20 chains, authored dead straight and exactly taut between posts 6 m apart - the rig `levels/rope-bridge.json` holds (untracked at the time of writing, not yet in the registry).
Replayed on 217e104 (tree mismatch, bundle at 485b912; it replays bit-exact and HEALTHY regardless):

| | |
|---|---|
| chain solves per frame | 1280 (the 64-sweep cap on 20 chains) on 200 of 235 frames; up to 2240 once the ball is hooked and the coupled sweep adds its 48 |
| chain phase per frame, bun | 9 to 21 ms, mean 12.7; the browser's self-replay reports 22 ms per frame |
| share of the frame in the sweep | 95% (CPU profile) |
| cost per chain solve | ~9 µs |
| cost of the same projection written bare | 0.14 µs (the study) |
| slats spinning | 9 of 19, at 373, 746, 1493 and 2239 rad/s: exactly one, two, four and six turns per frame |

Where a chain solve's 9 µs go: `regeneratePath` 31%, `resolveLengthConstraint` 48% (of which `generatePathObjects` 13%), `path()` 11%, `snapshotPathBodies` 8%.
None of that is the constraint.
A tie between two slats is a 15 cm straight segment that will never wrap anything, and every pass of every sweep pays the wrap scan, the self-intersection resolver, the detachment pass, a path-object allocation, a snapshot and three maps for it.
That is the first finding: **the cost is `Rope`'s generality charged per segment per sweep**, roughly sixty times the arithmetic, and the sweep count multiplies it.

The spinning slats and the collapse are the second finding, and they start before play does.
`settleChainsAtBuild` runs the same sweep for up to 600 frames with sleep enabled.
At settle frame 73 the rightmost slat satisfies the rest rule (its chain hauls it back to the same spot every frame, so its displacement window never opens) and falls asleep with its chain, while the other 19 chains are still spending the cap.
From then on the awake neighbour drags the sleeping slat away from its post, the sleeping chain is out of the set so nothing measures or corrects its over-length, and the credit the phase writes for the haul climbs to 178 m/s by frame 380, when the loop gives up.
Play starts with chain 19-3 2.95 m over length, the sweep flings that slat 2.15 m in frame 1 and credits it 743 rad/s, and the whole-turn-per-frame aliasing after that is a slat the chain cannot see turning because it faces the same way every time it is looked at.
So: **a bridge that sleeps one chain at a time is a bridge that lets go of one end**.
Sleep has to be a property of the connected set, which is what an island is.

Third: the rig as authored has zero slack, and a straight taut cable under transverse load has unbounded tension.
Nothing converges that, which is why `chain-order`'s 14-degree V wants 200 sweeps and this 0-degree one wants the cap for ever.
A bridge must be authored with sag, and the authoring below makes that the only thing an author can write.

## The study: what "solve it all at once" means numerically

`scripts/bridge-solver-study.ts` is the rig with nothing else in it: n slats with the bundle's mass and inertia, the ties as inextensible point-to-point inequalities with torque arms, the ball hung from the middle slat, gravity, 60 Hz, 600 frames.
Three solvers on the same projection:

- **gs**: Gauss-Seidel over the ties, alternating direction, exit at 5 mm, a cap of 64 or 512 - `sweepChains` without the rope machinery.
- **sub**: the same projection, the frame split into k substeps with p passes each and no exit test - the "small steps" formulation (Macklin, Müller, Chentanez 2019), which is what Box2D v3's soft step is built on.
- **direct**: every taut tie at once, `J W Jᵀ λ = -C` solved densely and applied, repeated as Newton steps to 5 mm; then damped (no body turns more than 0.1 rad per step) and regularised (a compliance on the diagonal), because the undamped version blew up.

19 slats, 3% slack, the ball swinging on the middle slat at 3 m/s:

| solver | passes/frame | ms/frame | worst end-of-frame over-length | worst rotation per step |
|---|---|---|---|---|
| gs, cap 64 | 58 | 0.12 | 20.7 mm | 0.13 rad |
| gs, cap 512 | 64 | 0.13 | 6.0 mm | 0.16 rad |
| sub k=8 p=2 | 16 | 0.035 | 16.7 mm | 0.043 rad |
| sub k=8 p=4 | 32 | 0.068 | 10.5 mm | 0.038 rad |
| sub k=16 p=2 | 32 | 0.071 | 6.7 mm | 0.016 rad |
| direct, undamped | 7 | 0.16 | 255 mm, slats at 455 rad/s | 7.6 rad |
| direct, damped 0.1 rad | 12 | 0.42 | 70 mm | 0.16 rad |
| direct, damped + regularised 1e-2 | 12 | 0.29 | 39 mm | 0.13 rad |

57 slats, same load:

| solver | passes/frame | ms/frame | worst over-length |
|---|---|---|---|
| gs, cap 64 | 59 | 0.34 | 26.8 mm |
| gs, cap 512 | 104 | 0.60 | 7.4 mm |
| sub k=16 p=2 | 32 | 0.20 | 8.2 mm |
| direct, damped + regularised | 15 | 2.8 (dense) | 117 mm |

The mass ratio, 19 slats, ball swinging, slats scaled heavier:

| ball : slat | gs sweeps to 5 mm | gs cap-64 residual | sub k=16 p=2 residual |
|---|---|---|---|
| 20 : 1 | 64 | 20.7 mm | 6.7 mm |
| 2 : 1 | 28 | 9.2 mm | 2.6 mm |
| 1 : 1 | 27 | 8.4 mm | 2.3 mm |

Four conclusions, each load-bearing for the design:

1. **The arithmetic is not the cost.** Twenty ties at the full cap are 0.12 ms, against 12 ms in the engine.
   A bridge solved with a constraint that is a constraint, and not a rope, is two orders of magnitude cheaper before anything else changes.
2. **Gauss-Seidel sweeps scale with the chain length and with the mass ratio**: 27 sweeps at 1:1, 64 at 20:1, 104 for a 57-slat span.
   That is the "fighting" in the report, and it is intrinsic to sweeping a serial chain - news travels one link per pass, and a light link next to a heavy load is told the wrong thing every pass until the far end answers.
3. **Substeps fix both at fixed cost.** Sixteen substeps of two passes reach the sweep's 512-cap answer in half the passes, with rotations per step ten times smaller, and the cost is a known function of n·k rather than a cap that is always hit.
   Substepping is what the rigid-body literature converged on for exactly this (small steps; Box2D v3's soft step, whose default is four substeps at 60 Hz; Rapier's substep solver, built for high mass ratios).
4. **A direct solve of the whole system is the wrong "all at once".** Exact inextensible ties on a shallow bridge are an ill-conditioned system - the multipliers grow without bound as the sag goes to zero - and a Newton step on it turns a 5.5e-3 kg m² slat by radians.
   Damped it converges worse than a sweep at three times the cost, and the tridiagonal structure that would make it O(n) does not change the conditioning.
   Softness is what makes the problem well-posed, and once the constraints are soft the direct solve has no advantage over substepped relaxation.

So "one rope that knows all the connection points" is right as the thing the author makes and the thing the solver sleeps, wakes and iterates as a unit.
Inside it, the right solver is not a system solve but a substepped, warm-started, soft relaxation over every row of the island, ties and contacts together.

## The design

### One object: a chain tied through bodies

`ChainData` gains `through?: number[]`: ordered anchor ids the chain is **tied to** on its way from `a` to `b`, beside `via`, which is the ids it is **routed over**.
A tie point is a knot: the rope is fixed to the body there, so the length on either side is its own and cannot slide across.
Two consecutive ties on the same body are the body itself (a slat's two ends), and contribute no rope.
A tie and the next tie on a different body are one **segment**, a point-to-point inequality `|p_b - p_a| <= L_i`.
A bridge is therefore one chain: `a` on the left post, through slat 1's left and right anchors, slat 2's, ..., `b` on the right post - one row in the outliner, one selection, one length, one colour, one sleep decision.

The slats are ordinary bodies placed by hand, wherever and however the author wants them: uneven gaps, slats of different lengths, a missing slat, a crate tied in among them.
Nothing in the format or the solver assumes a pitch; the chain is a list of tie points, and each segment's length is its own.
`lengths?: number[]` carries one length per segment, and a segment without one is taut as authored, as `length` means now.
`slack?: number` is the author's shorthand: every unauthored segment is built at its authored gap times `1 + slack`, so a hand-placed row of slats sags without a number per gap, and a per-segment length overrides it where one gap should hang differently.
The loader refuses a `through` chain whose every segment is taut (the unsatisfiable straight bridge above) with a diagnostic rather than simulating it.

What a `through` chain does not have is a wrap list.
A segment between two tie points is straight by construction, and a 15 cm segment that could catch on scenery is a level that is drawn wrong, not a solver case.
That is what makes every segment a row rather than a `Rope`, and it is the whole of the cost difference above.
Should a bridge need to wrap something, the answer is to tie it, not to route it.

The editor's half: the chain tool's drag gets a modifier that **ties** on release over a body instead of ending, so a bridge is one continuous drag post, slat, slat, ..., post.
Laying slats is the author's job, not a generator's: place them at any spacing, drag the chain through them, set `slack`.
A "+ Bridge" convenience may lay a first row along a catenary from a slat length and a gap, but what it produces is ordinary slats and an ordinary `through` chain that the author then moves, deletes from and adds to freely; it is a starting point, never the model.
The chain panel lists tie points in order with each segment's gap and length, editable per segment, and a tie point on a deleted body drops that body's pair of ties and joins the segments either side, the same tolerance a wrap point gets.

### One solver: ties and contacts in one substepped island solve

This is the part that breaks with how the chain phase is built, and it is the part the physics wants.

The engine already has a sequential-impulse contact solver with accumulated impulses, warm starting and Coulomb friction (`docs/contact-solver.md`), and a PBD chain phase that runs after it and writes positions.
A bridge the ball rolls on is both at once, nineteen times over: the ball's contact pushes a slat at velocity level inside `World.integrate`, the tie corrects its position afterwards and rewrites its velocity, and next frame the contact sees a slat that moved under the ball.
That one-derivative gap is the loop `session-147f`, `133f` and `193f` each fell through with one hung plank, and the push-out ordering, the funded refusal and the credit replacement in `settleChainBodies` are the patches that hold it shut for one plank.
Nineteen planks tied in a row is not a case to patch; it is the case the unified solver exists for.

So the solver is Box2D v3's **soft step** (Catto, Solver2D, 2024: substepping, warm starting, soft constraints, relaxation), with rope rows beside contact rows:

```
build islands over the constraint graph (contacts + ties + pivots/springs)
for each awake island, for s in 1..k substeps, h = dt / k:
  integrate velocities (gravity, damping, areas)
  warm start: apply each row's stored impulse
  solve rows with bias: contacts (normal + friction), ties, pivots, springs
  integrate positions
  relax: solve rows again without bias
store impulses; apply restitution; sleep islands whose bodies all rest
```

A **tie row** is the point-to-point inequality.
With `d = p_b - p_a`, `n = d / |d|`, `C = |d| - L`:

```
J   = [ -n,  -(r_a × n),   n,  (r_b × n) ]
m⁻¹ = w_a + w_b,   w = 1/m + (r × n)² / I      (0 for a static; the pivot and spring cases as `effectiveInverse` already reads them)
λ   = -m_eff · (J·v + bias) · massScale - impulseScale · λ_acc
λ_acc = max(λ_acc + λ, 0)                       (a rope pulls, never pushes)
bias = softness(C, hertz, ζ, h)                 (Catto, Soft Constraints, GDC 2011; Box2D's b2MakeSoft)
```

The row is active when `C > -slop`, which keeps a taut segment's impulse warm across the frames it is exactly taut, the same reason `CONTACT_SLOP` exists.
`w` is the quantity `Rope.correctShapePositionAndRotation` already computes per path body, so a tie row is the existing projection moved from position level to velocity level, which is what warm starting and substeps need to work on.
Softness is not a concession: it is what makes the taut-bridge system well-posed (conclusion 4), and at 30 Hz and a damping ratio of 10 (Box2D's contact defaults; ties want stiffer, to be measured) it is invisible at 5 mm.

**Islands** are the connected components of "shares a dynamic body" over every row, which `chainComponents` already computes for chains alone.
An island sleeps as a whole when every body in it satisfies the rest rule, and wakes as a whole when any of them is touched - which closes the build-settle defect above by construction, since no tie can sleep while its neighbour is awake.
The per-chain `watchBodies` wake-by-reach machinery is replaced by the broadphase: a body entering a sleeping island's proxy wakes it, as Box2D does.

**Substeps** are per island, from the island's own demand: four by default, more for an island whose rows are long chains under a heavy load.
A bridge declares its own (`ChainData.substeps`, defaulting from the segment count), since the author can see the rig and the solver cannot.
The study's numbers say eight to sixteen for a 19-slat bridge with the ball on it, at 0.04 to 0.07 ms.

### What happens to `Rope`

`Rope` is the thing that routes around geometry, and nothing in this plan replaces that.
What changes is where its length constraint is enforced.

A rope with a wrap path is **one row**: `C = pathLength - constraintLength`, and its Jacobian is the sum over the path's objects of the terms `generatePathObjects` already produces (direction, mechanical advantage, torque arm) - the quantity `effectiveInverseInertia` sums.
Path regeneration (the scan, the self-intersection resolver, the detachment pass) runs once per substep before the row is solved, not once per sweep per chain, and the row is then solved in the island with everything else.
That gives a crane chain over a beam, a lantern on a hook and the bridge the same solver, and makes the coupled-sweep machinery (`sweepChains`' `extra`, `CoupledRope`, `coupledRoots`, the stall gate) unnecessary: coupling is what an island is.

The ball's chain is the hardest instance and the last to move, because its length constraint carries the winch, the coil, the blocked-length lease and the spin rollback (`docs/ball-chain.md`).
At velocity level most of the credit bookkeeping has no counterpart: an impulse is the velocity change, there is no Δposition/Δt to bound, and the topology credit scale becomes "a row whose path changed this substep warm-starts from zero".
The lease survives as what it is, a per-row allowance for length geometry refuses, raised by the row's unsatisfied residual at the end of a frame.
The winch is a rest-length rate on the row, the coil a path term as now.
This stage is the rewrite of the ball's chain phase, and it is where the risk is; it is staged last so the bridge and the scene chains are proven on the solver before it is attempted.

### Staging

1. **`through` ties as rows in a unified island solver with contacts, substepped.** Bridges work; scene chains and the ball's chain stay on the current phase, running after the solver as they do now.
   This is the deliverable the ask was for.
2. **Every scene chain a row** (wrap path regenerated per substep), the coupled sweep retired for scene constraints, pivots and springs as rows.
3. **The ball's chain a row**, the chain phase reduced to path regeneration and the lease.

Each stage diverges the replay corpus and says so: substepping contacts changes every recording's trajectory, which is the price of one solver, and the invariants, digests and bundles are the net that catches what matters.
`cli diverge` on every regression bundle after stage 1 is the first task of stage 1, not the last.

## What it must do before it is done

The tooling landed first (2026-10-10), before any solver change, so the baseline is in the repo and a regression anywhere reads as a number:

- `cli bridges` (`src/sim/bridgeCases.ts`), the suite below, with the cases this tree fails marked `expectedFail` and carrying the number it measured; the runner fails on a stale marker, so the fix that closes a case removes its marker.
- Four invariants on every replay and playtest, both drivers (`sim/trace.ts`): `chain-over-length`, `chain-body-spin`, `chain-asleep-stretched`, `asleep-moving`.
  `session-235f` replays with 2150 of them where it replayed HEALTHY before.
- The scene chains in the world digest (`WorldDigest.chains`: length, over-length, sleep per chain), so `cli diverge` names `chain#17.over` rather than a slat.
- `cli perf bundle.json`: wall clock per frame, the chain phase's share, and the deterministic work behind it (`engine/solverStats.ts`: sweeps, solves, wrap-path regenerations, frames on the cap).
  The island solver reports through the same counters, so a rig's cost reads the same before and after.
- `scripts/bridge-solver-study.ts`, the standalone study the numbers above come from.

The suite, red before and green after, in the style of `cli contacts`:

| case | asserts | chain phase (before) | island solver (after) |
|---|---|---|---|
| `bridge-build` | the built level trips no chain or sleep invariant; worst over-length under 50 mm; no slat faster than 1 m/s or 10 rad/s | red: 8 invariants, 2028 mm over, a slat asleep at 124.7 m/s | green: 3.5 mm, 0.02 m/s, 0.1 rad/s |
| `bridge-hangs` | 19 slats, 3% slack: every segment within 10 mm over the settled window, no slat past 10 rad/s, mirror-symmetric to 2 mm, asleep whole, no invariant | red: 5.0 mm, a slat at 750 rad/s, 5.5 mm asymmetric, never sleeps, 8484 invariants | green: 3.5 mm, 0.00 rad/s, 0.0 mm, asleep at f600 |
| `bridge-taut` | the same rig with no slack stays bounded: under 50 mm over, no slat past 10 rad/s | red: 144 mm, a slat at 2625 rad/s | green: 4.6 mm, 0.1 rad/s (the loader warns, it does not refuse; see below) |
| `bridge-uneven` | gaps of 8 to 40 px and slats of 10 to 25: hangs within 10 mm, still, asleep whole | red: 7.2 mm and 0.6 rad/s, nothing tripped, but never sleeps whole | green: 4.6 mm, 0.00 rad/s, asleep at f600 |
| `bridge-ball-rolls` | the ball whirled across from the left post reaches the right one within 900 frames, over the deck (gaps of 6 px: the recorded rig's 15 px gaps are as wide as the ball) | red: the ball drops through the spinning deck to the floor | green: across at f170, never below the deck |
| `bridge-ball-hangs` | the ball hooked under the middle slat, wound 240 frames and held still 180: the slat comes down 20 mm, under 50 mm over throughout, no slat past 10 rad/s hanging still | red: the deck sags and spins from the build, the hook is turned away and lands on the floor | green: 240 mm down, 10.4 mm over, 2.3 rad/s |
| `bridge-mass-ratio` | slats at 2:1 and 20:1 against the ball, the ball dropped on the middle: each within 10 mm, still, no invariant; the residual spread is reported | red: 6.8 and 6.5 mm, slats at 1500 rad/s | green: 4.0 and 7.7 mm, 0.72 and 0.56 rad/s |
| `bridge-mass-ratio-200` | the same at 200:1 | red: 5.1 mm, slats at 1500 rad/s | **red, the measured edge**: 3.5 mm and 0.87 rad/s settled, but the drop stretches the segments under the ball to 85 mm for 22 frames |
| `bridge-long` | 60 slats with the ball on the middle: at most 20 constraint solves per segment per frame at rest (eight substeps of a solve and a relax, plus the island's contact rows), within 10 mm | red: 64.0 per segment, the cap | green: 18.4 per segment, 9.0 mm |
| `stack` | the four-box pile from `contactCases`, red since the pair solver landed, green with contacts substepped | red | red (stage 2 territory: the world's own contacts are not substepped) |

The one remaining `expectedFail` is `bridge-mass-ratio-200`, with its number; `cli bridges` fails the day it goes green.

The blind spots, named: the bun numbers are not the browser's (record a bundle on the bridge level and run `cli diverge`); the feel of the ball on a bridge is unplayed and needs Tris; softness parameters for ties are a measurement, not a default to copy from contacts.

## Rejected

- **A linkage object inside the current PBD chain phase**, one `SceneConstraint` holding all the segments and sweeping them internally with bare projections.
  Two orders of magnitude cheaper than today (conclusion 1) and a week's work, and it is the fallback if stage 1 is not taken.
  Rejected as the end state because it keeps the sweep's scaling with length and mass ratio (conclusion 2) and the contact-versus-chain gap for every slat the ball touches.
- **A direct tridiagonal solve of the bridge** (Baraff 1996, linear-time Lagrange multipliers).
  Conclusion 4: ill-conditioned on exactly the rig it is for, and no better than relaxation once the constraints are soft enough to be well-posed.
- **Reduced coordinates** (Featherstone): exact and drift-free, but a rope segment is unilateral - a lifted slat goes slack - and the ball's contacts and hook have to couple into it, which a maximal-coordinate solver gets for free.
- **Keeping one `Rope` per segment and making it cheaper** (skipping the scan for a chain with no wrap list, caching the path).
  It attacks the 9 µs and leaves the 64 sweeps, the per-chain sleep and the phase gap.
- **A higher sweep cap or a looser tolerance.** The cap is already hit on every frame of the rig, and the tolerance is what the renderer can show.

## The bug this found on the way

Chains sleep one at a time, by `bodiesAllAsleep`, and a body whose chain hauls it back to the same place every frame satisfies the displacement-window rest rule while carrying a velocity the phase keeps crediting.
In a set of chains that share bodies that lets one chain drop out of the sweep while its neighbours go on moving the body it holds.
Until islands land, the cheap fix is in `sleepChains` and the build settle: a chain may sleep only when every chain in its component (`chainComponents`) is ready to, and a body on an awake chain is `keepAwake`d.
The build settle is also the one loop that never calls `wakeChains`, so a body an awake chain holds is never woken there as it is on every frame of play.
`bridge-build` and the `chain-asleep-stretched` and `asleep-moving` invariants are the detectors.
They found a second instance the day they landed: `session-527f`'s plank, a single chain on a wedged body, leaves the build settle asleep at 85 m/s and 139 rad/s, so that corpus bundle is red on `chain-body-spin` at frame 1 until the settle is fixed.
Two instances is the class, not the rig.

## What landed (stage 1, 2026-10-10)

`src/engine/ties.ts` (`TieChain`, `TieSegment`, `TiePoint`, `TieSolver`), wired into `World.integrate`; `ChainData.through`/`lengths`/`slack`/`substeps`; `buildTieChains` and `settleTiesAtBuild` in `level/chains.ts`; both level drivers, both renderers, the SVG frame, the digest and the invariants, the editor's model, panel and drawing; `levels/rope-bridge.json` as one tied chain (`ROPE_BRIDGE`, unlisted).
The user-facing account is in [docs/scene-chains.md](../docs/scene-chains.md#tied-chains).
Where it departs from the design above, and why, each measured on `cli bridges`:

- **Which contacts the island owns.** The design put a tied body's contacts with the scenery in the island and left its contacts with the ball to the world, so the ball kept its grip machinery.
  Measured, that left the ball and the slat agreeing after the world's solve and disagreeing by exactly the island's correction: the slat was lifted back onto its bridge and the ball left falling at 0.2 m/s, every frame, and the slat under a resting ball turned ±6 rad/s frame to frame for ever (the 2:1 rig).
  Carrying the tie rows along inside the world's velocity iterations was tried first and fixed the mass-ratio half (a 2.6 kg slat no longer took the ball's weight as 3.3 m/s) but not the disagreement.
  So every contact touching a tied body is the island's, the ball included, solved with its real mass and never integrated there; the island writes the impulses back onto the world's `ContactConstraint`s and the grips and the digest read them as any other.
  The positional pair push gives way to the free body (a tied body counts as a static there).
  Spin under the resting ball went from 6.8 to 0.7 rad/s at 2:1 and from 33 to 0.6 at 20:1.
- **The ball's chain on a slat.** The design left the ball's chain positional and said the bridge would feel it through the credit.
  Measured, the positional solve hauled the slat by its 95% inverse-mass share and the island hauled it back, minting energy until the slat left at 38 m/s; so to a `Rope` a tied body is immovable.
  Handing the bridge the reaction afterwards as an impulse was tried next and is wrong by construction (a 52 kg ball arrested in one frame against an "immovable" anchor implies tens of metres a second on a 2.6 kg slat; it left at 16 m/s).
  What works is the ball's chain as a **guest row** of the island while it runs straight from the coil to the knot (`BallLevel.syncTieGuest`), the chain phase cleaning up the drifted position with no credit.
  The bridge then carries the ball: 240 mm of sag under it, hanging still at 2.3 rad/s.
- **The all-taut refusal.** Not done.
  A straight taut bridge hangs on the rows' softness and reads as stretched (4.6 mm over on the recorded rig, 0.1 rad/s), which is the textbook answer to an ill-posed rig and better than refusing a level; the loader warns once instead.
- **Tuning.** Rows at 60 Hz, damping ratio 2, eight substeps (`TieTuning`, `DEFAULT_TIE_SUBSTEPS`), swept against the 19- and 60-slat rigs:

  | hertz | ζ | substeps | 20:1 over / spin | 2:1 over / spin | 60 slats over / spin |
  |---|---|---|---|---|---|
  | 60 | 2 | 8 | 7.7 mm / 0.56 | 4.0 / 0.72 | 9.0 / 0.31 |
  | 60 | 2 | 16 | 7.8 / 0.70 | 4.1 / 0.58 | 9.1 / 0.25 |
  | 120 | 2 | 8 | 2.5 / 0.92 | 1.2 / 0.81 | 4.4 / 6.01 |
  | 120 | 5 | 16 | 2.7 / 0.92 | 1.2 / 1.10 | 4.2 / 3.08 |
  | 240 | 2 | 16 | 0.9 / 1.19 | 0.3 / 0.80 | 1.5 / 7.43 |

  Stiffer rows halve the over-length and make the long bridge ring (4 to 7 rad/s on sixty slats); 60 Hz is the quiet setting and inside every bar.
- **The edge.** 200:1 (`bridge-mass-ratio-200`): the drop stretches the segments under the ball to 85 mm for 22 frames; 120 Hz gives 34 mm and 83 rad/s, sixteen substeps 85 mm.
  Box2D's guidance for its soft step is a mass ratio near 10:1 across a joint.
  Auto-substepping from the island's mass ratio, or a block solve over the segments under a heavy load, are the two ways past it if a level ever needs one.
- **The editor's half** landed with it: Shift-release over a body ties the chain there and the draft keeps going, a plain click ends it (`finishOrTieChainDraw`), the panel edits slack, substeps and each segment's length.
  The "+ Bridge" convenience that lays a first row of slats along a catenary was not built; slats are placed by hand as the design wanted.
- **Not in stage 1.** A chain wrapped on the way to its knot (the knot is immovable to it and the bridge does not feel it); a `Rope`-based scene chain hung from a tied body (the same); a tie on a pivot or spring body (refused with a diagnostic).
  The chain phase's own build-settle sleep bug (`session-527f`) was fixed beside it: `settleChainsAtBuild` wakes a chain's bodies each settle frame as play does.

## What was tried (stage 2, 2026-10-10): implemented and parked

Every authored chain as a row of the island solver (`RopeRow` in `level/chains.ts`, `Rope.rowPrepare` and `Rope.rowTerms` in `classes/rope.ts`), the wrap path regenerated once a substep, the sweep left to the vines.
Switched on for every level it held `cli contacts`, `cli spring`, `cli sleep` and `cli bridges`, and two corpus bundles of the ball wound tight onto a chain-hung body went unhealthy (`session-324f`: the anchor spun to 77 rad/s under the ball's rim, its chain wound onto it in 51 mm topology jumps, the row 69 mm over, a 32 m/s kick off the ball's positional phase; `session-193f-lamp`, which was the embedded invariants counting a hook-only bracket as a wall, now fixed).
Two rounds of fixes closed `hung-anchor` (17 to 2.4 m/s) and not the corpus, so by the repo's rule the levels went back on the sweep and the row stays in the tree behind `buildSceneChains(data, built, world)`, measured by `chain-row` in `cli bridges`.
The account is in [docs/scene-chains.md](../docs/scene-chains.md#authored-chains-as-rows).

What it established:

- The regime that blocks it is the ball wound tight onto a free hung body - the one the ball's chain phase governs with its spin rollback, its unwind and its lease, apportioned with the scene by the coupled sweep.
  With the ball's chain positional and the hung body a row, that apportionment is gone, and no rule at velocity level stood in for it.
  **Stage 3 comes before stage 2**: the ball's chain as a row of the island is what lets the scene chains leave the sweep.
- Three velocity-level rules the tied chains needed anyway, kept: a rope row reads a kinematic spin's knot at the centre (`knotVelocity`), the guest row holds and never shortens (the winch stays positional), a contact row's friction reads the spin share the unwind let stand (`spinDriveShare`).
- Pivots and springs as rows were not started; a pivot or spring body on a row keeps `World.integrate`'s own step (`islandOwns`), and `cli spring` is 22 of 22 on that.
- Topology jumps are the open question for a rope row: a coil node appearing is a discontinuity in `C` that a soft bias turns into velocity, where the positional phase corrected it in position and paid nothing (`topologyCreditScale`).
  A jump allowance reeled back at a bounded rate, the lease's shape at velocity level, is the candidate.
