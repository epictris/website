# Vines

A **vine** hangs from one anchor, free at the bottom - or **spans between two**
(see **Spanning vines** below): the player passes straight through it, and the
hook grabs it **anywhere along its length**.

**Vines ignore the scenery**, and that is a design decision rather than a
simplification the solver forced: a link collides with nothing at all
(`VineLink` is `passable`, the hook-only rule), so a vine neither drapes over a
ledge nor pools on a floor, and levels are authored so that neither situation
ever matters.
What the decision bought is most of what a vine used to cost - the links leave
the contact gather, the depenetration sweep and `settleChainBodies`' static
push-out entirely, and the load path became a straight line by construction, so
the wrap-routing `Rope` that dominated every held frame became a closed-form
constraint.

It is **a chain of small pass-through rigid links joined by closed-form
distance constraints, plus one straight long-range attachment from the vine's
anchor to the grabbed link for exactly as long as the hook holds it**
(`level/vines.ts`).
The links carry the hang and the grab surface; that one extra constraint
carries the load.
The links have to be real bodies because a rope is a **constraint and not a
surface** - there is nothing for the hook's ray to hit halfway along one.

**A vine is allowed a little stretch under load, and the allowance is what it
costs to run.**
A Gauss-Seidel pass over a serial chain leaves an order-dependent residual
(73 mm on a 1.03 m chain, measured in `chains.ts`), converging it scales with
tension, and holding every joint of a swinging stiff vine to the chain bar cost
25-40 sweeps a frame for millimetres nobody can see.
So a vine's joints run to `VINE_TOLERANCE` (15 mm) instead of
`CHAIN_TOLERANCE` (5 mm), per constraint, through
`SceneConstraint.tolerance` - and the stretch that allows is bounded twice
over: per-link long-range attachments (anchor to every link, at the arc plus
the sweep's give) cap the cumulative sag whatever the joints do locally, and
the load rope holds the grabbed link itself at the tight bar, so the player
never sinks.
Spans are the exception and keep the tight bar - see **Spanning vines**.

## A vine link blocks nothing and is blocked by nothing

`VineLink` is a `RigidBody2D` - it needs gravity and mass, and the whole chain
phase (`snapshotChainBodies`, `settleChainBodies`, the credit scaling) is
written against that class - carrying the `passable` flag, so every collision
path drops it by the same rules that drop a hook-only leaf: no contacts against
anything, no depenetration in either direction, out of every wrap list, found
only by the hook's own queries.
It used to be the weaker statement ("a non-solid body blocks nothing, and is
blocked only by statics"), which is how a vine draped and pooled; that
half-rule and its guards are still in the engine for any future body that wants
it, and a vine simply no longer uses it.
`cli vines` asserts the contract on bare bodies (`link-contacts`), through a
level (`scenery`: a vine hanging through a ledge is bit-identical to the same
vine in clear air), and from the ball's side (`ball-vine`).

A vine never stacks, never pushes anything and never fights its own pair
constraints through the contact solver - the "stacking and contact problems"
`docs/game-design.md` cites against body-per-link chains, **removed by
construction rather than solved**.

## The load rope

`updateVineLoads` is called once a frame from `Level.physicsProcess` and derives
the rope from the state of the world rather than from grab and release events:
*if the player's rope ends on a link of this vine there is a load rope from the
vine's anchor to that link, and otherwise there is none*. Release, the hook being
destroyed and re-firing at a different link all fall out of that one statement,
and `cli vines` `release-refire` asserts it frame by frame.

It is a `VineAnchor` (`level/vineAnchor.ts`): a **closed-form point-distance
inequality** from the anchor contact to the grabbed link's centre - textbook
long-range attachment semantics, exact in one projection, with the rotational
term in the effective mass (`w = 1/m + (r x n)^2 / I`) so a rigid, pivot or
spring anchor body is turned and moved honestly.
It was a wrap-routing `SceneChain` while vines collided with the level - a
straight LRA is wrong the moment the vine bends round a corner - and that solve
regenerated a wrap path on every coupled sweep, which was the single most
expensive line of every held frame.
With the scenery ignored, straight is always right, and the same class serves
the anchor-to-first-link joint and the per-link LRAs.

Three things about it are load-bearing.

**Its rest length is the arc the vine actually has**, measured when it is built,
not `spacing x links`. The sweep's tolerance is per chain and a vine is a SERIES
of them, so a settled vine hangs longer than its authored length - invisible,
since nothing on screen says how long the vine should be. A load rope born at
the nominal figure is born SHORT and yanks the grabbed link up on the frame the
player grabs it, which is `rope-anchor-kick` in the ball's words and is answered
the way the ball answers it (`BallPlayer`'s attach callback re-takes the birth
length).

**It keeps the tight `CHAIN_TOLERANCE` bar** while the vine's own joints run
loose: it is the line the player hangs from, and its closed-form solve pays
nothing for the precision.

**It is swept WITH the scene chains, and the set has to converge.** The player's
rope pins to a link, so the two share a body, and solved in separate phases each
one's correction is the other's residual - `session-521f`, at a far worse mass
ratio than the ball ever saw. `stepSceneChains` therefore takes the player's rope
as its `extra`, exactly as `BallLevel` passes the ball's chain, and
`CoupledRope.settleSet` makes the loop wait for the vine's own residuals too
(gated on the coupling alone, a vine got one sweep per frame and came apart).
The sweep count is set by the exit gate rather than the cap now: a held vine
exits in a handful of coupled sweeps (5-11 measured on `session-322f`), the cap
(`MAX_COUPLED_SWEEPS`) being only the bound on a rig that will not converge.

## The numbers, and which of them an author sets

**Spacing is a cost decision.** Everything a vine costs scales with its link
count: a vine is `length / spacing` bodies, that many pair chains, and that many
cheap solves per sweep of the chain phase. One 3 m vine, wall clock per physics
frame, at rest and with the player swinging on the middle of it:

| spacing | links | at rest | swinging |
|---------|-------|---------|----------|
| 0.10 m  | 30    | 1.60 ms | 4.66 ms  |
| 0.15 m  | 20    | 0.84 ms | 3.56 ms  |
| 0.20 m  | 15    | 0.44 ms | 2.67 ms  |

(The table predates vines ignoring the scenery and the closed-form load rope -
the shape of the argument holds and the absolute numbers are now several times
smaller: a nine-vine arena with the player swinging on one runs ~1 ms a physics
frame average, spikes under 5, measured on `session-322f`.)

15 cm is the default. A level pays for all of its vines at once, so the budget is
the TOTAL link count. Coarser spacing costs grab-anywhere nothing (the grab
radius grows with it) and coarsens the curve.

A link no longer costs more on a dense level: `settleChainBodies`' static
push-out early-outs on a `passable` body, so the scan over the level's geometry
that used to double a vine's frame cost (3.9 ms against 1.7 in an empty scene)
is gone with the collisions.

## A settled vine costs nothing

This was the "no sleeping" simplification `docs/game-design.md` lists, taken for
the one body kind that first needed it; rigid bodies and authored chains sleep by
the same rule now (see [**Sleep: a settled body costs nothing**](sleep.md)). A vine is `length / spacing` bodies and
that many constraints, all swept every frame whether or not anything is happening
to them, and nearly all of that is spent on vines hanging perfectly still. Two
3 m vines in the ball arena, measured:

| state | ms a physics frame |
|---|---|
| awake | 3.91 |
| **asleep** | **0.19** |
| the same arena with no vines at all | 0.21 |

Asleep is therefore free, exactly. A sleeping link is skipped by
`World.integrate` (no gravity, no step) and its vine is left out of the chain
sweep entirely - which is where the cost is (an awake link no longer reaches
the contact gather or the depenetration sweep at all, being `passable`). What
it is NOT skipped by is the hook's raycast: a sleeping vine is still a thing
you can catch, and being caught is what wakes it.

**The test is net DISPLACEMENT over a window, and both halves of that were
arrived at the hard way.**

Not velocity, because a settled vine's links carry a permanent velocity churn:
the chain solve corrects the top links every frame and credits them the velocity
it moved them by, so the second link of a vine hanging still reads 0.27 m/s for
ever. A speed test never sleeps a vine at all - measured, 3.83 ms a frame,
unchanged by it.

And net over half a second rather than per frame, because that churn is a limit
cycle: the same links oscillate 2-7 mm every frame about a point they do not
leave. Per frame they look like a vine moving at 0.4 m/s; over the window they
have gone nowhere, which is what settled means and what a player sees.

A vine wakes on the frame the hook takes it (`updateVineLoads` runs before
`stepVines`, so being held is already known), and on its anchor moving - a vine
hangs FROM something, and a sleeping one would stay behind in mid-air if that
something swings or sags. `cli vines` `sleep` asserts the cycle end to end,
including that a sleeping vine does not move by a micron over 300 frames.

**A link is damped, and nothing else here is.** A pair chain is a PBD POSITION
constraint and a link hanging in free air touches nothing, so `contactDamp` never
reaches it: a vine has no dissipation at all, and once excited it rings for ever.
Worse, the ringing is FED - the sweep's tolerance lets the vine lengthen by a
fraction of a millimetre a frame, and that potential energy has nowhere to go but
into motion. Measured on the ball arena's own vines, left completely alone: the
tip was still moving at 0.33 m/s after 900 frames and 0.65 m/s after 3000, with
total energy flat. `LINK_DAMPING` is 0.98 a frame - `contactDamp`'s own historical
figure, and honest for a vine, which is heavily damped by air and by itself - and
it takes that tip to 0.04 m/s and the vine's positional jitter to 1.9 mm over
600 frames. It is applied BEFORE the chain phase, because `settleChainBodies`
rewrites a link's velocity as what it had at the top of the phase plus what the
phase moved it by.

**Link mass is a solver number.** A PBD correction splits by inverse mass, so
what the player's rope does to a grabbed link is set by the ratio between 70 kg
and that link. The worst the load rope stretched under a player swinging on the
middle of a 3 m vine:

| per link | ratio | stretch | swinging cost |
|----------|-------|---------|---------------|
| 0.4 kg   | 175   | 194 mm  | 11.4 ms       |
| 1.0 kg   | 70    | 32 mm   | 12.0 ms       |
| 2.0 kg   | 35    | 3.4 mm  | 8.2 ms        |
| 3.5 kg   | 20    | 0.0 mm  | 4.7 ms        |

Stretch and cost improve together, because they are the same convergence.
`DEFAULT_VINE_DENSITY` is 25 kg/m, so a link weighs that times the spacing and a
vine weighs the same whatever spacing it is authored at; a 3 m vine is 75 kg.
Nobody sees kilograms, and the bound at the other end is that a vine must not
visibly load the spring body or rigid platform it is anchored to.

**Weight is authorable per vine** (`VineData.density`, kg/m, `kg/m` in the vine
panel with the resulting whole and per-link weight beside it). Per METRE and not
per vine, so it stays put when the end handle is dragged; and it is the one
number on a vine that `scaleLevelData` must NOT scale, since it is already
written per metre while everything beside it is in the file's pixels - scaled, a
25 would have become 2500.

What an author is choosing is not how the vine falls. Gravity is
mass-independent, so a 6 kg vine and a 180 kg one hang in exactly the same place
and swing at exactly the same rate, which `cli vines` `weight` asserts to the
micron. What weight buys is how the vine ANSWERS: the table above, again, as
densities on a 3 m vine at the default spacing -

| density | per link | stretch | swinging cost |
|---------|----------|---------|---------------|
| 2 kg/m  | 0.30 kg  | 622 mm  | 8.3 ms        |
| 8 kg/m  | 1.20 kg  | 23 mm   | 8.1 ms        |
| 25 kg/m | 3.75 kg  | 0 mm    | 3.6 ms        |
| 60 kg/m | 9.00 kg  | 0 mm    | 2.0 ms        |

- and what it leans on the body it hangs from. A light vine is a legitimate
choice with a visible cost, so it is warned about rather than refused: the panel
says so below `LIGHT_LINK_MASS` (1.5 kg in ONE link, a per-link number because
the mass split that decides it is per link), and `MIN_VINE_DENSITY` (1 kg/m) is
only the floor where the solve stops converging at all. A file may say anything;
under the floor it is built at the floor.

Two radii, and they are different numbers: the **grab** radius is the collision
circle at 0.6 x the spacing, so consecutive links overlap and the hook's ray
cannot slip between them, and the **visual gauge** is 3 cm.

## Stiffness

**A vine is a rope by default and can be authored anywhere between a rope and a
pole** (`VineData.stiffness`, 0..1, `level/vineBend.ts`). What it changes is how
much force it takes to BEND the vine; what it deliberately does not change is
where the vine hangs, since its rest pose is straight down either way.

It is a **three-point curvature constraint with a compliance**, solved by XPBD in
the same sweep as the pair chains. Each part of that is forced:

- *Three points*, because a spacing says nothing about shape - any curl or
  zigzag satisfies every pair chain there is - so what the pair chains leave free
  is exactly the curvature at a link, and the curvature at a link is a statement
  about it and its two neighbours. The measure is the middle point's distance
  from the chord midpoint of the outer two, which is zero exactly when the three
  are straight and evenly spaced; as an angle it would want an arctangent per
  joint per pass for a number the solver turns straight back into a
  displacement.
- *A compliance*, because the obvious PBD spelling of "half stiff" - apply half
  of each correction - makes the stiffness a function of the pass count, and
  this sweep's pass count is neither fixed nor knowable: it runs to a residual
  (see `sweepChains`), so a vine would be stiffer on a frame that had a hard rig
  elsewhere in the level. XPBD converges to the same physical rigidity whatever
  the pass count, so `stiffness` means a bending rigidity rather than a solver
  setting.
- *In the same sweep*, because the two disagree by construction: a bend that
  straightens the vine drags two links off their spacing, and the pair solve that
  restores the spacing bends the vine back. That is the statement `sweepChains`
  already makes about two chains sharing a body, one order out - so a bend is a
  `SceneConstraint`, which is what that phase now solves instead of chains
  specifically.

**The constraint is written at every scale, not only between neighbours.** A
stiff serial chain is the one shape a Gauss-Seidel sweep is worst at: news
travels one link per pass, and stiffness is what every pass is arguing about. On
a 3 m vine with a player swinging onto its tip, at the stiffest setting there is:

| bends | sweeps | lean off vertical | worst kink | cost |
|---|---|---|---|---|
| neighbours only | 64 | 28 deg | 15 deg | 6.1 ms |
| neighbours only | 512 | 25 deg | 7 deg | 11.8 ms |
| **every scale** | **64** | **1.7 deg** | **2.8 deg** | **3.7 ms** |

Eight times the solver buys three degrees; the same constraint written between
links 2, 4, 8 and 16 apart buys a pole. It is a multigrid V-cycle spelled as
extra constraints - about 3x the constraints (59 against 20) and LESS wall clock,
because a sweep that converges is one the loop leaves early. Every scale carries
the FULL rigidity rather than a share: split, a single kinked joint - which is
exactly what the hook pulling on ONE link makes - is `log2(links)` times softer
than a smooth bend, and a stiff vine that kinks where it is grabbed is the
artifact the feature exists to prevent.

**It is CLAMPED at the anchor rather than hinged.** Without that, the joints hold
the vine straight and the straight thing swings freely about its bolt - a
pendulum, which is not what a pole bolted to a ceiling does. The clamp is the
same three-point constraint with a GHOST point standing in for the link that
would be above the anchor if the vine carried on through it, and the ghost is a
point on the ANCHOR BODY, so it turns with it: turn a ceiling a quarter turn and
a stiff vine comes with it and holds itself out horizontally under its own 50 kg,
where a rope hangs down as it always did (`cli vines` `stiffness`). The rest
direction it encodes is the one the vine was built at, which is straight down - a
vine has no authored direction.

**The two ends of the slider are read and the middle is measured.** EI is a real
beam quantity - a cantilever of length L under an end load P deflects P.L^3/(3.EI)
- so 1000 is where a 70 kg player on a 3 m vine deflects it by 6.3 m (a rope
whatever it is called) and 1000000 is where the same load deflects it 6.3 mm
(under what the renderer can draw). The map between them is GEOMETRIC, because a
linear one would spend nine tenths of the slider between "sapling" and "pole",
which are the two an author cannot tell apart. Worst lean off vertical and
straightness (chord over arc) with a player swinging onto the tip of a 3 m vine:

| stiffness | EI | worst lean | straightness | reads as |
|---|---|---|---|---|
| 0 | - | 45 deg | 0.917 | a rope |
| 0.25 | 32 | 39 deg | 0.965 | a heavy cord |
| 0.5 | 1000 | 25 deg | 0.996 | a springy branch |
| 0.75 | 31623 | 9.5 deg | 0.999 | a sapling |
| 1 | 1000000 | 1.7 deg | 1.000 | a pole |

**Zero builds nothing.** A vine that does not ask for stiffness has no bend
constraints at all, so it costs exactly what a vine always cost and replays
bit-for-bit - asserted that way in `cli vines` `stiffness`, over 200 frames with
the player hanging off it. Out-of-range values are clamped at load: a negative
compliance is a joint that bends further the harder it is pushed.

The one simplification is that **the anchor end is immovable**: a cantilever
exerts a moment on what it is bolted to, and this one does not. That would want a
torque arm on the anchor body and a share of the phase's velocity credit, so that
scenery could lean on the thing it hangs from - against the existing statement
that a vine must not visibly load its anchor.

## Where a vine spawns

A hanging vine spawns straight down its full authored length, which IS its rest
pose - a link collides with nothing, so there is nothing for it to stop at or
pile on, and the geometry scan the spawn used to run (`dropDistance`, and the
runaway it closed) went with the collisions.
A vine authored longer than the space under its anchor simply hangs through the
floor, and that is the level author's to avoid - the same contract as the rest
of the scenery-ignoring decision.

## Spanning vines

A vine may name a **second anchor** (`VineData.anchor2`) and become a span attached at both ends.
The length stays the whole authored arc, deliberately decoupled from the distance between the anchors: a span longer than the gap **sags into the catenary** that length implies (`level/catenary.ts`), which is both where the editor draws it at rest and the pose `buildVines` spawns the links in.
The catenary is the solver's own fixed point, so a span at rest is at rest on frame one, with nothing for the first frames to correct (`cli vines` `span` bounds the settle movement in millimetres).
The catenary solve is closed-form once its parameter is bisected, sampled BY ARC LENGTH so the links land at their exact spacings; the taut and near-vertical regimes are their own branches (the chord, and the fold).

A span authored **shorter than the gap is built taut at the separation itself**.
The authored figure is a constraint set that cannot be satisfied - the chains' total reach is less than the distance they must cover - and an unsatisfiable set never converges: the vine jitters at ~0.7 m/s for ever and can never sleep.
Taut still sags a little, and the amount is the sweep's own arithmetic: each chain rests up to `CHAIN_TOLERANCE` over its length, and that series of give hangs as `sqrt(3 * gap * give / 8)` - which is how the `span` case bounds it.

A grabbed span gets **two load ropes**, one from each anchor to the grabbed link (`Vine.lra` and `Vine.lra2`), because a span's tension runs to both ends: held by one alone, the run to the other anchor is just pair chains carrying a player - `links * CHAIN_TOLERANCE` of give paid out exactly where the span is supposed to hold.
Both are born at the measured arc to their own side (`arcTo` / `arcFrom2`), for the `rope-anchor-kick` reason the one always was, and both go into the coupled sweep together.
`updateVineLoads` therefore returns the held VINE rather than a load rope, and `vineChainSet` pushes whichever load ropes it carries; `BallLevel.heldVine` is the same value under its ball-side name.

**Stiffness on a span means pinned ends, and slack pressed toward straight.**
A vine lashed at both ends is hinged there, not cantilevered, so a span builds NO ghost clamps - the anchor-side clamp encodes the straight-down rest pose a span is not in - and instead gets the anchor-side joint triples mirrored at the second anchor, so the far end is exactly as smooth as the near one (`buildVineBends`).
The triples cannot all be satisfied (a span with slack can never be straight) and do not have to be: XPBD bends are springs, and the equilibrium is a force balance with the chains.
Because the chains are rope INEQUALITIES - a compressed joint is satisfied - that balance absorbs the slack rather than bowing it: measured on 5 m over a 4 m gap, sag 1.38 m at 0 (the catenary), 1.35 at 0.25, 0.21 at 0.5, 0.09 at 1 - a taut wire - monotone, settling and sleeping at every setting (`cli vines` `span-stiffness`).

**A span keeps the tight bar and the lease a hanging vine gave up.**
Its joints run to `CHAIN_TOLERANCE` and carry the standing-stretch lease (`VinePair.leased`), because the two regimes fail in opposite ways: a taut span's joints sit permanently over under their own tension and must be allowed to bank that residual or the span rings for ever and never sleeps, while a loose-bar joint carrying a lease banks its allowed residual faster than `SLACK_RELEASE_RATE` decays it and pays the vine out at ~7 mm a frame for ever (12.4 m of "5 m" span, found the hard way).
Tight-with-lease and loose-without are the two stable pairings, and `buildOne` couples each vine kind to its own.

One deliberate exclusion: **a dead second anchor falls back to hanging** rather than dropping the vine - one anchor is still a complete vine, unlike a chain end - and so does a span naming its own anchor twice.

Sleep watches **both** anchors, so a span whose far end rides a swinging body wakes exactly as a hanging vine on one does.

## The ball level

`BallLevel` builds and steps vines too, and that is not symmetry for its own
sake: `BALL` is the **default level**, so a bare `/` and the editor's ▶ Test Ball
are where a vine authored in the editor is most likely to be looked at, and left
out of that driver a vine did not exist there at all - not drawn, not simulated,
not grabbable.

The **ball goes through a vine and its CHAIN catches on one**, and those are two
different questions with two different answers. The body passes through because a
link is non-solid like anything else; the chain catches because `BallHook`'s
three attach paths take a link like any other rigid body, and a vine is a thing
to hook rather than a thing to bump into. What the catch then IS - a ring
threaded onto the cord, sliding down it - is [**The ring on a vine**](vine-ring.md) below. So the load rope is the ball's too:
`updateVineLoads` runs there against `ball.chain` exactly as it runs in `Level`
against the player's rope, and the coupled sweep takes `settleSet` while a vine
is held for the same reason.

`cli vines` `ball-vine` asserts both halves, each in the form that cannot be
satisfied by a near-miss: 240 frames of the ball falling THROUGH a vine are
bit-identical to the same fall with no vine in the level, the vine over those
frames is bit-identical to the same vine with the ball 15 m away, the thrown
chain catches a link and gets its load rope, and hanging on it for 20 s gains
0.08 J of mechanical energy against a 5 J bar.

### The spin may not be billed for the sweep's tolerance

Aim steering is kinematic - `BallPlayer.resolveInput` writes the frame's angular
velocity straight from the aim error - so a ball that will not turn is never a
torque problem. Something later in the frame is taking the rotation back, and the
only thing that does is `unwindOverLength`.

Its premise is that over-length still standing at the end of the chain phase is
over-length the solve **could not** pay, so the spin has to give the radian back.
That premise fails for a solve the phase deliberately skipped, and holding a vine
it does: the coupled sweep leaves the ball's chain inside `CHAIN_TOLERANCE`
rather than at zero (see `sweepChains`), and 5 mm of the solver's own convergence
budget is worth an entire frame's turn.

`session-337f` is what that feels like. The chain ended 4.7-5.3 mm over on all
312 frames that were holding a vine, the unwind took the whole frame's rotation
back on 107 of them, the ball's rotation stood at exactly -0.17794 rad while the
aim error wound up to 13.8 rad/s, and the game read as a force resisting the
mouse. So the unwind takes a `forgive` argument, and `BallLevel` passes
`CHAIN_TOLERANCE` while a vine is held and zero otherwise - no other frame in the
game changes, because no other caller leaves its rope unsolved. Worst lag between
the loop and the aim it is steered to, over a hand-speed sweep (one full turn
every 4 s): **109 degrees and 133 pinned frames before, 19 degrees and none
after**, and on `session-337f`'s own input 48 degrees and 35 down to 11 and none
(`cli vines` `ball-steer`).

Two things this deliberately does NOT do. It does not exempt the grabbed link
from the spin rollback (`session-265f`) - the rollback is what stops a kinematic
spin being exported to the body the chain is anchored to, and a vine link would
be dragged by it. And it does not touch the same lag on a STATIC anchor, which is
far worse (178 degrees, 205 pinned frames on that sweep): winding a taut chain
onto the rim against something that cannot move is the mechanic working as
designed, and whether it should be that stiff is a game-feel question rather than
a bug.

**A ball bundle recorded before a level gained a vine is stale.** `session-2504f`
replays `BALL`, and once two vines were authored into `levels/ball.json` its
recorded throws caught one on 1202 of its 2504 frames and winched it about -
`energy-gained` then fires on the work that does, against a 17 J tolerance sized
for the ball on a scene a 3 m vine adds ~940 J to. The control is what says this
is the level having changed rather than the physics: the same bundle against the
same level with the vines removed is clean, and a ball left hanging on a vine
gains nothing. Re-record the bundle, or keep the vines clear of where it throws.

## Drawing

A vine is drawn from its LINK POSITIONS - the anchor and the link centres,
against the render transforms. `chainMetrics.ts` is deliberately not used: that
walk exists to place links along a wrap path because a scene chain has no
per-link bodies, and a vine has real ones, which are the honest source. Both
renderers take that path through `VineCord.path`, so neither can have its own
idea of where a vine is. The load rope is not drawn at all - it is a constraint
rather than a thing, and the links already say where the vine is.

**In 2D** it is a smoothed cord at the visual gauge (`render/vines.ts`); **in 3D
it is real geometry** - one `InstancedMesh` of capsules along the same path
(`render3d/vineVisual.ts`), built on `ChainLayer`'s argument and laid the same
way. Capsules rather than cylinders because the cord bends at every link and the
hemispherical caps fill the notch two cylinders would leave on the outside of a
bend, at any angle and with no mitre to compute.

Drawn in the scene rather than painted flat over it, and that is the whole point
of the 3D half existing: **the 2D overlay is dropped in every 3D-only view the
editor has and in every orbited one**, being a projection of the gameplay plane,
so a vine drawn only there vanishes exactly where an author goes to judge how a
level reads. A vine is the level, not chrome. It also gets what a flat cord never
could - it passes behind the geometry in front of it, and the level's own lights
fall on it.

`drawnElsewhere` in `render3d/scene.ts` is the other half: a link must not ALSO
extrude like scenery, which draws a vine as a stack of brown spheres with the
cord painted down the middle of them. That one was found by running the editor's
▶ Test and is invisible to everything else here.

The editor draws vines in its 3D scene too, and it is the reason `Scene3DLevel`
takes `VineCord`s rather than `Vine`s: the editor's scene is built by
`buildLevelBodies`, which spawns no links, so what it hands over is the
straight-down REST POSE. That is exact rather than guessed - a vine hangs there
until something moves it - which is what separates it from a chain, whose sag
would be a drawing of something the level does not contain and which therefore
still stays on the editor's 2D canvas.

## Authoring

`VineData` names an ANCHOR OBJECT by id and carries a length, exactly as
`ChainData` names its two - which body it hangs from is a question about where
the anchor lives. `+ Vine` in the editor is the chain tool's press followed by a
drag DOWN that pulls the length out; the panel carries the length, the spacing
(blank = the default), a live link count, the density, the stiffness (blank = 0,
a rope, with what it reads as beside it) and the colour, and the vine is listed
under `Vines (N)` beside the chains.
A **span** is authored from a hanging vine: **Shift-drag its end handle onto a body** to attach a second anchor there (the panel gains a live `slack` readout), drag that end handle to re-anchor it as a chain end is re-anchored, and **Shift-drop it over empty space** to detach back to a hanging vine of the same length.
The editor draws a span at its resting catenary, on the canvas and in the 3D scene both, through the same `catenaryPolyline` the builder spawns from.
`TEST_VINES` is the worked level - two vines
over a chasm to swing across, one long enough to pool on the far ledge, and a
span with a metre of slack between the second and third branches.

## What checks it

`cli vines` (`sim/vineCases.ts`), and it is the whole of the coverage, because a
vine reaches no avatar digest and no invariant: it violates nothing when it comes
apart, and a build that quietly stopped making links renders as a level with no
vine in it and passes everything else.

The cases that matter most are the ones nothing else could make: the engine
guards on bare bodies (`link-contacts`, a link touching nothing in either
direction); that 300 frames of walking, jumping and landing are
**bit-identical** with and without a vine in the way (`pass-through`), and 360
frames of a vine hanging through a ledge bit-identical to the same vine in
clear air (`scenery`) - the only forms of "passes through" a nearly-no-op
cannot satisfy; that the anchor-to-grab arc holds in MILLIMETRES under a
swinging player (`grab-hang`); that a winch hauls as far up a vine as up
a static in the same place (`winch`, `ball-winch-hung-anchor`'s methodology);
that the ball still turns to its aim while it hangs on one (`ball-steer`); and
that exactly zero or one load rope exists on every frame of a
fire/grab/release/regrab cycle.
The span cases are `span` - the settled sag against the ANALYTIC catenary, the arc against the authored length, the taut clamp, the spawn-at-rest bound, and that a span sleeps - `span-stiffness` - the slider monotone from catenary to taut wire, settling and sleeping at every setting - and `span-grab`, which holds BOTH load ropes' arcs in millimetres through 400 held frames; `format` carries the `anchor2` round trips and the fallback-to-hanging tolerances.

Two of them are worth reading for HOW they are written rather than what they
assert. `ball-vine` measures the closest the ball ever gets to a link, because
the version before it steered a ball at a vine and never reached it - a ball has
no drive of its own, so the roll travelled 13 cm and passed 1.1 m clear, and the
case passed on an encounter that never happened. `ball-steer` measures the lag
between the loop and the aim in DEGREES over a hand-speed sweep, because the
failure it is written against (the unwind billing the spin for the sweep's
tolerance) leaves every other number in the game looking correct. `playtests/vine-swing.json` is the mechanic end to
end - two chained swings across an 8 m chasm - and
`playtests/regressions/vine-swing-320f.json.gz` is the same run as a bundle.
(It was recorded against the rigid-vine physics, so it legitimately diverges a
few pixels mid-run now; the invariants are the pass signal, per the usual
bundle semantics.)
