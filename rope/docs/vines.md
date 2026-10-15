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

**Where a vine is drawn is where it rests.** A settled hanging vine rests against
its per-link long-range attachments, its joints' give inside their exit bar
putting it there; with the attachments at the drawn arc plus `VINE_LRA_GIVE` a
segment, as they were, it rested 5.4 mm a link LONGER than drawn (BALL's
vines 95-104 mm at the tip). The attachments are now on the drawn arc and the
joints `VINE_LRA_GIVE` short of the spacing (`jointLength` in `buildOne`), the
same give between the two, so it rests on its drawn length (`cli vines` `rest`
holds it to 5 mm). Aiming each joint by what it settled over was tried first
and dropped: the give is different on every settle.

A hanging vine spawns straight down its full authored length, which IS its rest
pose - a link collides with nothing, so there is nothing for it to stop at or
pile on, and the geometry scan the spawn used to run (`dropDistance`, and the
runaway it closed) went with the collisions.
A vine authored longer than the space under its anchor simply hangs through the
floor, and that is the level author's to avoid - the same contract as the rest
of the scenery-ignoring decision.

## Spanning vines

A vine may name a **second anchor** (`VineData.anchor2`) and become a span attached at both ends.
The length stays the whole authored arc, deliberately decoupled from the distance between the anchors: a span longer than the gap **sags into the catenary** that length implies (`level/catenary.ts`), the pose `buildVines` spawns the links in and, for a limp span, where it rests and the editor draws it (a stiff one bows, below).
The catenary is the solver's own fixed point, so a span at rest is at rest on frame one, with nothing for the first frames to correct (`cli vines` `span` bounds the settle movement in millimetres).
The catenary solve is closed-form once its parameter is bisected, sampled BY ARC LENGTH so the links land at their exact spacings; the taut and near-vertical regimes are their own branches (the chord, and the fold).

A span authored **shorter than the gap is built taut at the separation itself**.
The authored figure is a constraint set that cannot be satisfied - the chains' total reach is less than the distance they must cover - and an unsatisfiable set never converges: the vine jitters at ~0.7 m/s for ever and can never sleep.
Taut still sags a little, and the amount is the sweep's own arithmetic: each chain rests up to `CHAIN_TOLERANCE` over its length, and that series of give hangs as `sqrt(3 * gap * give / 8)` - which is how the `span` case bounds it.

A grabbed span gets **two load ropes**, one from each anchor to the grabbed link (`Vine.lra` and `Vine.lra2`), because a span's tension runs to both ends: held by one alone, the run to the other anchor is just pair chains carrying a player - `links * CHAIN_TOLERANCE` of give paid out exactly where the span is supposed to hold.
Both are born at the measured arc to their own side (`arcTo` / `arcFrom2`), for the `rope-anchor-kick` reason the one always was, and both go into the coupled sweep together.
`updateVineLoads` therefore returns the held VINE rather than a load rope, and `vineChainSet` pushes whichever load ropes it carries; `BallLevel.heldVine` is the same value under its ball-side name.

**Stiffness on a span means pinned ends, and a bow.**
A vine lashed at both ends is hinged there, not cantilevered, so a span builds NO ghost clamps - the anchor-side clamp encodes the straight-down rest pose a span is not in - and instead gets the anchor-side joint triples mirrored at the second anchor, so the far end is exactly as smooth as the near one (`buildVineBends`).
A span builds the NEIGHBOUR scale only (since 2026-10-13): the coarser scales are a convergence device for a hanging pole, whose rest pose is straight at every scale, while a span of surplus length is never straight at any and the coarse triples argued with the floors at full rigidity - in the sweep with no fixed point, and once a free span was the island's it was the hold's fight, a 1 mm floor bar (the first answer to `session-133f`'s release twang) having the sweep argue every frame: 44 sweeps and a cap every fifth, 1.8 mm of link jitter a frame, the "shudder" of `session-267` while the ball wound up and down a held span.
Neighbour-only, floors and bends agree (12 sweeps on that hold, 0.5 mm of jitter, no cap), a span keeps its whole arc free (2503 of 2500 mm; 2409 with the coarse set in the island, 2359 in the sweep), and the look is the elastica a rod of that surplus bows into: a 5 m rod over 4 m sags 1.34 m at every stiffness against the catenary's 1.38, so the slider does little on a span, and a pole span bows where it used to read as a taut wire - which was its links crushed into each other, and a rod cannot shorten (`span-stiffness` asserts the arc now).
The triples cannot all be satisfied (a span with slack can never be straight) and do not have to be: XPBD bends are springs, and the equilibrium is a force balance with the chains.
**A stiff vine's joints refuse to shorten** (`VineStrut`, a floor `STRUT_GIVE` under each joint's length), so that balance BOWS the slack rather than absorbing it.
Until 2026-10-12 the joints were rope inequalities only - a compressed joint satisfied - and the bends straightened a span by piling its links into each other: a 3 m span over a 1.49 m gap in testing.json settled as a nearly straight line with 1.8 m of arc, 753 mm off the catenary the editor drew, its slack gone into overlapping links (5 m over 4 m measured sag 1.38 m at stiffness 0, 0.21 at 0.5, 0.09 at 1).
With the floor that span keeps 2.85 m of arc (each strut ending up to its tolerance under its floor) and rests in a bow 184 mm off the catenary.
**The floor only holds up to about 0.5.** Measured on 5 m over a 4 m gap (147 mm joints): arc 5.07 m and sag 1.38 at stiffness 0, 4.64 m and 1.00 at 0.5, but 4.04 m and 0.01-0.03 from 0.75 up, the shortest joint crushed to 96 mm.
There the bends are near-rigid, the set has no solution (straight, and no shorter), and the sweep's Gauss-Seidel compromise still gives the slack to the joints; a true bow needs bends that keep their neighbours' spacing or a solve that ranks the floor above them.
Every span in BALL and testing is at 0.15-0.3 and keeps ~95% of its arc; `span-stiffness` still reads a pole span as a taut wire.
A limp vine builds no struts: a rope pushed end to end folds.
**The struts are swept AFTER the bends** (`Vine.struts`, their own list, pushed last by `vineChainSet` and the build settle), and the order is load-bearing.
A bend pass shortens every joint it straightens, so with the floors solved before the bends a forward sweep ended with every joint one bend pass short of its floor.
At rest that sat inside the exit bar; with the span swinging in it did not, the sweep ran to its 64-sweep cap, and a capped sweep's displacement is what `settleChainBodies` pays out as velocity.
`session-381f` is what that looked like: the ball's chain caught the end link of BALL's 2.5 m span over a 2.19 m gap (stiffness 0.3), and from the release on the span jiggled for ever - a 19-frame limit cycle, the arc breathing between 2347 and 2401 mm, one frame in nineteen hitting the cap and taking the vine from 2.9 J to 15.9 J, the damping never catching it, the vine never sleeping.
Swept last, the forward pass ends on the floors, the sweep leaves on its bar in 5-13 sweeps, and the same span kicked at 3 m/s sleeps in ~90 frames with no sweep capped (`cli vines` `span-kick`, red on the old order).
What the order does not change is the arc the floors keep (2359 mm of 2500 on that span, before and after), and the order is now the hold's alone: free, a stiff span is the island's (next).

**A stiff span is a unit of the island solver whenever nothing holds it** (`PlantUnit` in `level/plantRows.ts`, the held berry plant's unit with no berry; `syncSpanUnits`, since 2026-10-12), and that is what ended the ringing for good.
`session-294f` is why: with the floors swept last, the same BALL span let go by the chain at speed still capped the sweep on one frame in twenty as its bow swung in (arc 2341 mm, every floor 4 mm short), and each capped frame was paid out as velocity - 0.7 J to 27.5 J, four times, three seconds of jiggle - and the 5 m span over 4 m of `span-stiffness` never settled at all at stiffness 0.3 (0.16 m/s for ever, on either strut order).
The fight is structural: the coarse bend scales each say "straight over 2k links", a span of surplus length cannot be straight at any scale, and a Gauss-Seidel sweep of them against the floors has no fixed point - whichever is solved last wins the frame, and a frame the cap cuts short is paid out as motion.
Neighbour-scale bends alone were measured first (the release peaked at 5.5 J with no cap, but the 5 m span then pumped at 0.25-0.3, 1 J to 27 J in 300 frames, the lease banking against the bends), as were tighter strut bars (worse at 1 and 2 mm, uncomputable at 0) and the lease switched off (nothing on its own).
The island solves floors and bends in one soft substepped velocity solve, where a row has no last word and nothing is paid out: every joint, floor and bend a row ([scene-chains](scene-chains.md#a-held-berry-plant-as-rows)), four substeps for a free span (`SPAN_SUBSTEPS`; the held plant's eight carry a ball, a span carries itself, and at four it rests a percent long), the vine's own damping and rest rule (`stepVines`; a link never satisfies the world's, so `PlantUnit.asleep` IS `Vine.asleep`), and the build settle steps it through the island (`World.stepTiesStandalone`) so the level and the editor's `restingSpanPath` open on the island's pose.
**What it costs, against the committed tree's sweep** (bun, BALL's six spans, 2026-10-13): asleep, nothing either way; all six kicked awake at 3 m/s, 0.86-0.90 ms a frame over the first two seconds against 0.77-0.80 (the sweep's), 236-243 ms over ten seconds against 240-248 since the island's sleep sooner; held - the player's case - cheaper, the hold being the sweep's with far fewer sweeps now that floors and bends agree: `session-267`'s hold 0.75 ms a frame against 1.39 (p95 1.6 against 3.1), `session-294f`'s 0.69 against 1.57, `session-262f`'s 1.62 against 1.67 (its winding caps are the open item below). Two substeps would match the sweep awake (0.75) at 5% of stretch; eight cost 1.4 ms awake.
**On the ball, the hold is the island's too** (since 2026-10-13): the ring on the cord (`RopeVineClamp`) is a row of the span's island - `BallLevel.syncBallRow` makes the chain a `BallChainRow` of it exactly as it does for a held berry plant, the span keeps its unit through the hold with the load ropes among its rows (rebuilt when a load rope is born, reborn as the ring crosses a link, or dropped: `PlantUnit.lra`, `syncSpanUnits` with `rowed`), and the ring's creep is solved inside the row's own velocity solve (`viscousRopeImpulse`: the row is a viscous slip whose tension lets the ball lengthen the path at the creep's relief, and `Rope.rowCreep` walks the ring by that tension a substep at a time; [vine-ring](vine-ring.md) has the design, the measurements and the five drafts it replaced).
That ended the framerate dips: positional, the ball winding while hung from a span ran the coupled sweep to its 48-sweep cap frame after frame (`session-211f`: 37 frames in 211, `session-262f`: 35 in 262), each sweep regenerating the ball's wrap path, 11-14 ms of chain time in bun and 40 in the browser - the correction splitting by inverse mass so the 3.7 kg link took 93% of it and the load ropes put the link straight back, the ball climbing 7% a sweep. As a row there is no sweep: 0 capped frames on every bundle, `session-211f` at 0.8 ms a frame mean and 1.5 at p95 against 1.5 and 13.
A held span is damped in `stepVines` as a free one is (the island cannot damp a link, `VineLink.canSleep` being false); a held berry plant stays undamped.
What the row hold is NOT yet is as quiet as the sweep's: the sweep dissipated, the island conserves, so a ball caught on a span swings under it as a pendulum and the cord is jerked at each extreme (`session-133f`'s "still" hang carries 4.7 J in the cord, 21 peak, against 0.01 positional), and the row's winch hauls against the soft span (`session-267`'s rolling hold: 4.8 mm of link jitter a frame with the winch, 1.3 without, 0.5 positional). Both are the physics the sweep was hiding, and both are feel: the winch's one knob (`BallChainRow.WINCH_MAX_ACCEL`) and the cord's damping are where to look after playing it.
The grapple level's rope is the sweep's, so its hold is too: the unit is dropped the frame a span is taken and rebuilt the frame it is let go, with the velocities the sweep left.
**The hold ends where the island would have had it.** The sweep leaves a held span in its own pose and the island takes it from there, so whatever the two disagree on is paid out on the release frame: at the joint bar the sweep's floors lost 4 mm a joint to the coarse bends (2370 mm of arc against the island's 2409) and the island's floors paid that out as a 17.7 J twang the frame the chain let go of a span hanging still, the bow overshooting 30 mm and ringing for twenty frames (`session-133f`, "a weird jittery movement when the chain releases"); with the floors no longer argued with (neighbour-scale bends, above) the sweep's PAIRS, each over by `CHAIN_TOLERANCE` with the lease banking it, left the span 2550 mm long under a swinging ball and 2543 under a still one against the island's 2503, and the island's pair rows took that back as 60 J (`session-294f`).
So a span's joints - anchor joint, pairs and struts - run to `SPAN_JOINT_TOLERANCE` (2 mm): the hold ends at 2525 and 2519 and the releases carry 1.0 and 0.8 J, for 16-26 coupled sweeps a frame against 12-16; at 1 mm the hold itself capped and paid out 33 J.
`cli vines` `span-release` holds it (red at the old bars: 26 J).
A span let go mid-swing keeps the swing it had, which is the cord's own momentum and not the handover's.
A stall gate on the worse of the rope's and the set's residual (a new best, not an improvement over the sweep before) was tried against the winding frames first and reverted: they were converging, slowly, not alternating, so it cut no sweeps and turned `grab-hang` red.
Two other handovers were measured and rejected: the held link PINNED to the sweep with the rest of the cord staying rows (the rope hauled a 3.7 kg link at 5.7 m/s and the soft rows lagged it, 190 mm of stretch and a 140 J release), and a bounded recovery rate on the island's floor rows, Box2D's push-out cap (0.05 m/s took the twang to 0.17 J but let the bends crush the free span to 2365 mm and 0.02 to 2320: a bias bound is a weaker floor).
Measured: BALL's span let go at 35 J is under 1 J seven frames later and asleep by 240 (381f: asleep at 240, where the sweep rang for ever); every BALL span kicked at 3 or 6 m/s sleeps in 90-180 frames with no sweep capped (`span-kick` sleeps at 29 against the sweep's 92); the 5 m span over 4 m settles at build at every stiffness.
Two things the island changed about the look, both physical.
**The floors hold to about 0.5 and the bow is real there**: arc 4942 of 5000 mm at 0.3 (2359 of 2500 on BALL's span under the sweep, 2409 now), sag 1.26 m against the catenary's 1.38, and `stiffness` on a span reads as how flat the bow is pressed, as the paragraph above always said.
**Past 0.5 the floors still lose** - 4665 mm at 0.5, flat (4000, sag 0.00) at 0.75 and 1, and at 0.6 the crushed line buckles 10 cm ABOVE its anchors and rests there - because a bend row's frequency is capped at half the length rows' (`SpringRow`: both at one frequency chattered, 5 J for ever at 0.5 with eight substeps and at 0.6 with sixteen, and uncapped a stiffness-1 span left the build at 1e100 J) while its offset is the whole sag, so its bias outruns a floor's millimetres.
A rigid floor row (an inequality with no softness, as the island's contacts are in the relax pass) is the open answer for a pole span that should bow rather than flatten.
**A stiff span settles at build and the editor draws where it rests.** It spawns on the catenary, which is not its rest pose, so it used to settle live over the level's first frames; nothing in the build's settle depends on where it starts, so it now settles there like every vine clear of areas.
The editor's `vineRestPath` draws a stiff span through `restingSpanPath`: the span built and settled alone between its two anchors, which is exactly where the level's span stands when it opens (0.1 mm, measured on every span in BALL and testing), cached by anchors, length, spacing, density and stiffness (8-28 ms a settle).
A limp span keeps the catenary, which is its exact rest pose.

**A span keeps the tight bar and the lease a hanging vine gave up.**
Its joints run to `SPAN_JOINT_TOLERANCE` (2 mm, since 2026-10-13; `CHAIN_TOLERANCE` before) and carry the standing-stretch lease (`VinePair.leased`), because the two regimes fail in opposite ways: a taut span's joints sit permanently over under their own tension and must be allowed to bank that residual or the span rings for ever and never sleeps, while a loose-bar joint carrying a lease banks its allowed residual faster than `SLACK_RELEASE_RATE` decays it and pays the vine out at ~7 mm a frame for ever (12.4 m of "5 m" span, found the hard way).
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

With a `braidSeed`, both renderers use the old three-strand braid from
`add-boulder-and-root-generation`, refined for smooth moving geometry.
`render/vineCurve.ts` interpolates the links with arc-weighted Hermite tangents;
`render/vineBraid.ts` packs three unequal stems in a tangent triangle, varying
their gauges and smoothly tightening/loosening the pitch over seeded growth
stretches without reversing the twist, and tapering along the whole length, then the
last 18 cm (or 30% of a short cord) to a pointed end. Small swollen nodes share
their seeded growth coordinates with the leaf attachments. The 3D renderer uses
three continuous, capped tubes in one mesh per vine (`render3d/vineTube.ts`),
with 12 radial sides, shared ring vertices and smooth transported normals.
Each live
cord exposes its built `restLength` and whether both ends attach; render samples
carry `(link index + spline parameter) * rest spacing` independently of their
current arc length. Braid phase, nodes, leaves and broad bark/olive/moss paint
patches use these material stations, so stretching one link cannot slide the
decoration on another. The editor's equal-arc rest samples use the same mapping.
Shallow longitudinal ridges and restrained contact
darkening describe the stems' fibres and crossings, with matte roughness.
`render/vineLeaves.ts` places sparse leaves on the same interpolated curve.
Unequal seeded growth intervals place nodes in clusters with longer bare
stretches. Leaves grow singly or in staggered pairs, with a broad size range
from small young blades to mature leaves and smaller growth near the tip.
Blade bases attach directly to the outer braid surface; neither renderer draws
little leaf stalks. In 3D, `VineTube.leafSurface` selects an exposed rendered edge
across all three strands at the attachment's material station, so the roots
meet the actual ridges without being buried. The blade's supporting plane keeps
the whole braid behind its base, rather than clearing only one strand.
Blade width stays tangent to that plane, and the blade grows
outward before it droops and gradually turns toward the gameplay plane. The
turn and its normal deformation are shared by lit, depth and point shadows.
The braid test checks blade vertices against the rendered solid, including a
player grabbing a two-ended span, while comparing the physics against plain cords.
The instanced blades have asymmetric outlines, a raised midrib, shallow cups
and drooping tips; most are flatter, with occasional curls. Their shader paints
broad colour patches, a midrib and branching veins, with a softer waxy highlight
and a paler underside. Thin-leaf backlighting uses the scene's direct lights and
their shadow attenuation, strongest at edges and weaker through veins; it is a
local material patch, not a scene-wide painted-light filter.
`render3d/vineLeafLag.ts` gives tips a bounded damped lag behind their attachments on
the simulation clock, with matching vertex deformation in the lit, depth and
point-shadow materials. Pausing freezes it, seeking/teleporting resets it, and
blade roots never detach. The editor uses the same geometry in its rest pose.

**The braid is built once, in its rest pose, and bent on the GPU** (`VineTube`), the way a skinned mesh is posed by its bones.
Everything about it - strands, gauges, taper, ridges, paint, ring topology - is fixed at a material station, so only the centreline changes from frame to frame, and only the centreline is uploaded: a two-row float texture, one texel pair per link point (the point and the curve's tangent there; the twist rod's roll and the stretch either side).
Each vertex carries its station in link units and its offset in the centreline's own frame, and the vertex shader evaluates the same arc-weighted Hermite `sampleVineCurve` does, then lays the offset out on the tangent there, rolled and narrowed; the depth and point-shadow passes run the same deformation.
`VineTube.frameAt` is that evaluation on the CPU, on the same float32 pose, for the leaf roots and for the braid test (`deformedGeometry`), so what the test measures is what the shader draws.
Rebuilding the tube on the CPU every frame instead - a ring every 1.2 cm, three strands, a painted colour per vertex - cost 6.5 ms of a frame for BALL's six vines (`Trace-20261011T201625`, `session-1055f`, 2026-10-11); posing it costs 0.17 ms for all six.

**A leaf folds under the ball's ring as the ring slides over it** (`render3d/vineLeafFold.ts`), render-only like the lag and on the same spring.
The blade is a chord hinged at the stem's surface at an angle `θ` from the downstream tangent.
In the plane of the fold, measured from the hinge, the ring's band is a solid rectangle: its width along the cord about the ring's centre, by the span from its bore to its rim; the blade may not cross it, so `θ` may not lie in the angular span of the part of that rectangle within the blade's reach (`forbiddenSpan`, exact from its corners and its edges' crossings of the reach circle).
The band's WIDTH is what gets a ring past a leaf at all, and the first version, which modelled the ring as a thin disc, let it through the leaf's stem going up the vine (Tris, 2026-10-11): a blade's base is inside the bore, so a ring can only cross it by folding the blade down the vine ahead of it or up the vine behind it, and the width forbids every angle in between.
So a ring creeping down threads over the base with the blade in the bore and presses it flatter as it goes until it clears the tip and the blade springs back; a ring coming up passes under the blade, lifts it, turns it over the hinge and lays it flat up the vine inside the bore until it has passed.
Which of those happens is never decided by rule: the blade stays on whichever side of the forbidden span it was on, and a fast ring is followed in 4 mm steps so it cannot jump a blade.
With no history - the first frame after a seek, or a ring just threaded on over a blade - a ring past the base presses the blade into the bore, as a ring that slid down to there would have; `cli shot --frame N` draws one frame with no history, so look at a fold through `--frames` from before the ring arrives.
The state is the fold's departure from the blade's own swaying angle, so an untouched leaf costs one comparison; a folded blade is its rest frame carried about the hinge, its curl, droop, lag and face turn let go by the square of how far it has folded.

**A blade through the ring wraps the stem** rather than bending flat over it, which was the second thing the first version got wrong: a flat 30 cm blade is 10 cm wide each side and stood out through the iron (Tris, 2026-10-11).
The leaf shader wraps the blade's width onto a cylinder about the stem's axis - fully across the ring's band wherever the ring is threaded over the blade, easing out over a few band widths, and elsewhere by how nearly the blade lies along the stem (`leafWrap`, `leafRing`).
The cylinder has to be ON the axis: the fold plane is measured through the line from the axis to the blade's base (not the leaf's outward direction, since the base sits on whichever strand stands furthest out), a blade not yet flat wraps at its own rising distance from the axis, and the blade follows the stem's curvature under it both toward its face and across it, since a span sags in the gameplay plane.
The braid stands up to about 3.6 cm from its axis against the bore's 3.65 cm, so through the ring there is no room off the braid: the blade wraps at `wrapRadius`, the nearer of just off the braid and just inside the bore, sinking a millimetre into the braid's lobes under the iron rather than through the iron, and the fold's bound reserves that radius so the wrapped edge is inside the bore by construction.
A ring arriving within 3 cm of any part of a blade squares it up to the fold plane first, since its own twist tips one edge down into the ring's path.
Measured with a probe that mirrors the shader on the CPU, sweeping a ring down and back up straight and sagging braided vines at 1 m/s: the deepest any blade vertex reaches into the drawn torus is 0.6 mm, against 15 mm before, bar one frame of 1.4 mm where the cup of a blade standing upright over the hinge grazes the band.
`vine-preview.html`'s **Ring** (`?ring=1&seek=S&view=close`) slides a manacle down the first vine and back up at 1 m/s, for looking at it without the ball.

`Scene3D` hands the layer the ring as the vine it is on and its link-units station (`RopeVineClamp`'s segment and fraction).
Measured on `session-1055f`: the ring at 1.2 m/s presses a 9 cm leaf from 39° to under a degree in four frames, and it springs back in about 0.35 s with a degree of overshoot.
Unplayed; the 2D renderer does not fold.

For **two-ended spans**, both attachments retain their material roll and the
second end keeps its full gauge, rather than tapering to a free tip. The planar
section normal follows the smooth tangent without adding roll; the strand tube
frames use minimal-rotation quaternion transport through bends. Local tensile
strain slightly narrows the bundle by `1 / sqrt(stretch)` (bounded at 30% strain).
`render/vineTwist.ts` adds a render-owned torsional rod on fixed rest stations:
elastic torque is the gradient of `(angle gradient - preferred twist density)`,
where tension relaxes the helical bundle's preferred twist by up to 0.9 rad/m.
Uniform tension cannot unwind rotationally fixed ends; differential strain
creates a small twist between them. Waves travel at 2.8 m/s with 5/s velocity
damping, CFL-safe substeps, and a 0.45 rad visual bound. Pausing freezes angles;
seeking, time gaps over 0.1 s, or clearing the layer resets history.
Nearly coincident attachments (under 2 cm) skip the unresolved twist solve, and
changing material length starts clean angular history. Leaf outward
directions follow the same material roll while their roots stay on the braid's
exposed support edge. Tests exercise differential strain, fixed boundaries,
release/settling and blade clearance under actual player pull and release.
This is a compliant **visual approximation**, not a coupled 3D elastic rod:
the existing deterministic 2D solver still owns tension, bending and player
loads, and decorative torsional torque never changes gameplay. Two-ended vines
are treated as tied at both ends; separately authored axial swivels and 3D
twist-induced buckling are not modelled.

`/vine-preview.html` is a dev-only live-physics material study with close-up,
pause, half-second frame stepping and backlight controls. **Two-ended span**
switches to a real player load fixture; **Pull** deploys/retracts the player's
hook, **Release** removes it and **Reset span** restores the initial pose. Its
frame/load readout supports multi-frame checks. It is excluded from
the production entry points.
Select a gameplay vine and use **Braid selected vine** in its inspector to
author the seed, or **Plain vine** to remove it. The seed is render-only and
survives save/load and copy/undo without changing the physics.

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
The panel's **Braid** section sets `braidSeed`: **Braid selected vine** braids it with the seed in the box (change the seed and press again to regrow it), **Plain vine** clears it, and both undo; the canvas marks a braided vine with a dashed stroke ([Drawing](#drawing)).
`TEST_VINES` is the worked level - two vines
over a chasm to swing across, one long enough to pool on the far ledge, and a
span with a metre of slack between the second and third branches.

## Berry vines

Ported 2026-10-12 from karin-lu's `add-boulder-and-root-generation` branch (f831e14), with changes asked for by Tris.
A berry vine is a vine that grows glowing berries on short stalks, and **only the berries catch the hook**.
The format is `VineData.starberry` (`level/starberry.ts`); the name is karin's and is kept so her files load, though her star-shaped fruit was dropped in the port and every berry is her round lantern berry.

**Placement is explicit.** Each berry has a root on the vine (`along`, a length down its arc from the first anchor), an `offset` from that root to the berry in the vine's rest pose (`offsets`, a length), and its own radius (`radii`).
The root is a LENGTH, not a fraction, so changing the vine's length leaves every berry where it is: lengthening only adds vine below the lowest berry, and the editor will not shorten a berry vine past its lowest root (`minBerryVineLength`).
The roots used to be arc fractions (`positions`, karin's form and the first port's), which moved every berry whenever the length changed; `scaleLevelData` folds them into `along` against the length the file states, and a file naming neither gets karin's three (0.28, 0.58, 0.88 of the arc).
`starberrySettings` holds every root on the vine and at least `MIN_BERRY_ALONG` (15 cm) below the anchor.
Older plants with no `offsets` stand at `stemLength` out along their `sides` entry, and with no `radii` at `radius`; the editor makes both explicit on the first edit so nothing moves.
The builder grows each berry AFTER its cord has settled (`growBerries` in `buildVines`), from the cord link nearest the root toward the authored point.
Grown at spawn, each berry would hang where the cord's settle carried it: a settled hanging vine was a few millimetres a link longer than authored (its joints' give, bounded by the per-link long-range attachments), 76 mm at the third berry of the 3.4 m garden vine, before it was made to rest on its drawn length (see "Where a vine spawns").
**Where a berry is drawn is where it RESTS**, not where it spawns: its weight bends the plant where its stalk joins the cord (41-78 mm on the garden and BALL's plant), so after the settle the builder AIMS each stalk (`aimBerries`): each stalk clamp's rest target is moved by its berry's miss, and the plant settles again.
The unloaded shape is never seen, only the loaded one, so it is the unloaded shape that gives; nothing outside the plant pushes it.
Two rounds (`BERRY_AIM_ROUNDS`) leave every berry 1-4 mm from where it was drawn (`scripts/test-berry-vines.ts` holds it under 10 mm).
Only a vine settled at build is aimed; one settling live (spawned against scenery or in an area) hangs where its weight takes it.

**Physics.** The cord and each stalk's middle joint leave `LAYER_HOOK` out of their masks, so the hook's sweep flies through them; the berry keeps it.
Every body is a `VineLink`. The cord and the stalk joints are `passable` and non-solid, so the ball and its chain pass straight through them and no wrap is ever made on one.
The BERRY is solid (`VineLink.solid`, not `passable`): the ball rolls against it and knocks it about on its stalk, the hook bites it, and the chain wraps it.
Its mask is `LAYER_PLAYER | LAYER_HOOK | LAYER_ROPE` and nothing else, so it never meets the scenery it hangs among (an authored berry overlapping a rock is not shoved out of it) or another berry.
Its collision circle is 0.95 of its drawn radius (`BERRY_BODY_RADIUS`): the drawn berry is a little oval, a radius along its stalk and about 0.92 of one across.
A sleeping berry vine wakes when the ball or its chain touches one of its berries: `touchedBerries` (the world's contacts and the chain's path) is handed to `stepVines`, which wakes the vine and holds it awake for as long as the touch lasts, since the engine's own wake paths leave a link to its vine (`VineLink.wake`). The contact that struck a sleeping berry has already credited it the push, so it moves off with it the next frame.
A berry is bitten as any moving body is, a `RopeAttachment` on it, never the vine ring (`vineFor` skips berry vines), and the manacle's cuff is bolted to it with the berry's own mask, so the cuff meets only what the berry meets.
Each stalk is two bodies on `VinePair`s, with a `VineAnchor` from the cord link to the berry at the stalk's `reach`: the middle joint (the stem), which weighs the plant's `stalkDensity` (kilograms per metre, as the cord's `density` is; 8.3 when the plant does not say, a third of the cord's, which puts the default 0.38 m stalk at 3.2 kg) times the stalk's reach (`stalkMass`), and the berry, which weighs the plant's `berryDensity` times its own drawn sphere (`berryMass` in `level/starberry.ts`), so a bigger berry on the same plant is heavier; the default density is a fruit's, 640 kg/m³, which puts the default 0.15 m berry at 9 kg (the ball is iron at 7200).
Like the cord's `density`, these set how the plant answers the ball rather than how it falls: the chain pulls on the berry directly and the solve splits each correction by inverse mass, so a light berry is whipped about and takes the whole of every pull, and a heavy one is something the ball swings from.
**A link does not turn** (`VineLink.inverseInertia` is zero, as a spring body's is; since 2026-10-12).
Every constraint on a link acts at its centre and the rope solve moves one by translation alone, but the contact solve, the ball's pair separation and its surface refusal all spin a body through its inverse inertia, and a berry is the one link they reach: with the cuff bolted to its rim as a lever, the pair separation handed one -10.5 rad/s over two frames and nothing ever took it back (a held vine is not damped), so the cuff went round at 2 m/s winding coil onto a stalled ball until the stall lease had let a 30 cm chain out to 2.7 m (plans/berry-whip.md).
A fruit on a stalk is held against turning by the stalk, so the lock is the physical statement as well as the solver's.
**A berry is a free holder to the ball's chain** (`BallLevel.keepsHaul`, [ball-chain](ball-chain.md)): it keeps the coupled solve's share of a haul in free air, as the hung plank does, where a pass-through link is rolled back and winched against.
Rolled back, a berry the ball hung from stood at the plant's unloaded rest while the ball wound (`session-501f`, "the berry moves around unnaturally while I'm hanging off it") and a ball whipped round a swinging berry was hauled after a point that never answered (`session-221f`, +2.4 kJ).
`scripts/test-berry-vines.ts` holds the berry's sag through a slow wind and whips BALL's berries at `hung-anchor`'s pace under its bars.
**The reach is the stalk's in-plane length**, root to berry as drawn (`stalkReach`), as every length in the game is; the stalk's spring is at rest there.
From 2026-10-11 to 2026-10-12 it was the 3D hypotenuse across `BERRY_CORD_DEPTH` (a berry drawn 0.36 m out had a 0.47 m stalk), which left every stalk slack at rest by the difference, so a pull first drew the berry out and then swung it in - the plane's picture of a berry tipping back toward the cord's depth.
Tris: the half-3D motion feels wrong in a 2D game, so the depth is a look and nothing else now.
**The stalk's ropes stand past its reach by the plant's `stretch`** (a fraction of the reach, 0.5 when the plant does not say: `DEFAULT_STALK_STRETCH`, `stalkCap`, `VineBerry.cap`; since 2026-10-12), so between the reach and the cap a pull along the stalk is carried by the stalk's clamp, a true spring, and only past the cap by a rope.
This is the trampoline: a ball dropped onto a hanging berry is caught by the spring and thrown back, so a run of well-timed bounces, with the wrap timing, builds speed.
Measured in a drop rig (the ball hung from a BALL berry, lifted 0.5 m on a slack chain and dropped; the energy back is the square of the upward over the downward peak speed): with the ropes at the reach the stalk returned 1-11% at every sway, two thirds of the fall dying in the one frame its ropes went taut, since the stalk was a chain along its own axis and the clamp only ever carried the sideways part; with the ropes half the reach over it returns 47-59% at sway 0 to 0.5, over a stroke of 9-21 frames.
Two things cost the rest, and the second is open.
A heavy berry takes a share of the ball's speed the moment the chain goes taut, as any chain catch does - 26% at BALL's authored 2000 kg/m³ (28 kg against the 52 kg ball), 7% at 300 - so a berry meant to bounce the ball is a light one.
And about half the energy that goes into the stroke still does not come back out of it, and that half is the solve's own time step: the same drop in the same rig stepped at 120 Hz returns 65% and at 240 Hz 83% (sway 0.5, berry 300 kg/m³), against 44% at the frame's 60 Hz.
An XPBD spring is implicit Euler for its force, which damps a mode by about `1/(1 + (ω·dt)²)` of its energy a step, and the stroke here is a 0.7 s period on a 1/60 s step - 37% gone over one half-period, the number the rig reads.
It is not the link damping (a held vine is undamped), not the stem joint's mass (a heavier joint returned less), not the aim's spin (a fixed aim returns the same), and per phase it is nowhere in particular: the plant solved alone (`scene-chains`) and the coupled sweep (`rope-solve`) hand the berry the same tens of joules back and forth each frame and the ball's `chain-velocity` write adds and takes 3-8 J on alternate frames, all of it the implicit step.
The textbook answer is the one the tied-chain island already has - small steps (Macklin et al. 2019) - and it is built: **a plant the ball hangs from is a unit of the island solver** (`PlantUnit` in `level/plantRows.ts`, `Vine.unit`, `BallLevel.syncPlantUnit`; since 2026-10-12), every joint, strut, stalk rope, bend, clamp and its load rope a row, the bends and clamps as undamped spring rows at the frequency their compliance gives them, substepped eight times a frame with the ball's chain row (`BallChainRow`, [scene-chains](scene-chains.md#a-held-berry-plant-as-rows)).
The same drop then returned 68% and 78% on BALL's two clear berries (sway 0.5, berry 300 kg/m³) with the spring rows undamped, against 51% and 53% in the sweep, and no more at sixteen or thirty-two substeps.
Played (`session-846f`, "the berries jiggle around weirdly and the end of the main stem keeps moving up and down while the berry stem attachments stay fixed"), that first cut had three things wrong, each measured and each in `PlantTuning`:
the cord's joints were built `VINE_LRA_GIVE` short and rest a give OVER their ceilings in the sweep's loose bar, which a row holds exactly, so the cord contracted 103 mm and the whole plant rose under the hanging ball (the rows take the joints at the spacing);
the tied chains' 60 Hz rows on 8 kg links were a 38 kN/m spring carrying the ball, 10 cm of stem-end bob through a bounce (the plant's length rows run at 120 Hz, the most eight substeps allow, and the cord then swings 0 to 7 mm);
and the spring rows had no damping at all, so a hung plant bobbed ±90 mm for ever (a damping ratio of 0.3 in each row's own mode settles it within five seconds).
The drawn stalk roots sit at an arc length from the anchor, which is why a stretching cord read as "the attachments stay fixed while the stem moves".
With all three the drop returns 57% on both berries against the sweep's 51 and 53, and what the rows buy beside the return is the catch: a 3.5 m/s catch left the sweep's cord 7 to 14 cm shorter for a second with the tail at up to 2.7 m/s, and leaves the rows' within 16 mm, the tail at 1.8 to 2.6 m/s and the plant calm in six frames.
The damping is the one trade the plant has - the bob of a hanging ball and the return of a bounce are the same mode - and the numbers either way are in `PlantTuning`.
A held frame costs 1.03 ms in bun against the sweep's 0.99 on the hang rig, and only while a berry is held; the plant is back in the chain sweep the frame the chain lets go, with the velocities the island left it.
`BallLevel.PLANT_ROWS` is the switch, and `scripts/test-berry-vines.ts` measures the return both ways.
Blind spot, named: on a row frame the ball is a body the island integrates and the world's positional push-out is skipped for it (as for a slat), so a ball swung hard into a wall while hanging from a berry can end a frame some centimetres inside it (32 mm once on `session-846f` re-simulated with the undamped rows, nothing with the damped) - the same gap the bridge rows have, listed in [scene-chains](scene-chains.md#the-balls-chain-as-a-row).
Above sway 0.5 the stalk sags 0.4 m under the ball's standing weight and has no clean catch left in it; the stretch has no effect on an unloaded plant, which the clamps hold at its drawn rest either way.
Held to its in-plane span (the first port), the stalk was taut from the start and every pull down swung the berry in toward the cord: 39 mm in for 70 mm down, against 13 mm in for 57 mm down now.
**The stalk's stiffness is internal to the plant** (`StalkClamp`, `buildStalkBends` in `level/vineBend.ts`): the joint and the berry are each held where they grew in the frame of the cord edge above the root, and the joint straight between root and berry, with compliance from `0.5 - sway * 0.2` as a vine's bends read it.
The cord edge is as long as the stalk is wide (`ceil(span / spacing)` links): over one 15 cm link the clamp pulled on that link with a lever ~2.7 times the stalk, the sweep left it unconverged at its exit bar, and the leftover fed a bob of 2-3 J that never let the garden's plants sleep.
The first port bent stalks with a `VineBend` clamp, whose ghost and anchor are immovable ends: every correction pushed the berry back toward a WORLD direction with nothing pushing the cord the other way.
Under the chain that was a force from nowhere (session-97f: ball and plant gained 220 kg·m/s toward the berry's side in ten frames, and the vine swung away from the pull); `scripts/test-berry-vines.ts` asserts a pass of the stalk constraints moves the plant's mass by nothing and that turning the plant rigidly changes nothing they ask for.
A held berry loads the cord at its stalk's link: `updateVineLoads` ties the load rope to `parentIndex`.
`allLinks` is everything the vine owns (registered, damped, slept, woken together); `links` stays the ordered cord the curve and the arcs are measured on.
A berry vine with no stiffness authored builds at `STARBERRY_STIFFNESS` (0.78, a sapling).
`checkBallInvariants` reports `starberry-nan`, `starberry-stretch` (a stalk past its cap + 5 cm), `starberry-stem-grab` (the chain on a cord link or stalk joint) and `starberry-contact` (a contact on any vine body but a berry, or on a berry with anything but the ball or its hook).

**Drawing** (`render3d/starberryVisual.ts`, `render/starberry.ts`, `render/starberryArt.ts`).
The cord is set **`BERRY_CORD_DEPTH` (30 cm, in `level/starberry.ts`; a look only, the sim's stalk is in the plane) behind the gameplay plane**, so it reads as scenery rather than a target: one thin bare strand (`berryCordRadius`, 2 cm tapering to 1.1 cm, under a plain vine's 3 cm) in a dark woody brown, along karin's crooked render-only line, with no leaves.
Each stalk leaves the cord heading toward the camera and turns into its berry, which hangs in the plane at its physics position; the stalks are the cord's own brown and material, so the leaves are the only green.
A stalk is drawn leaving the cord at the berry's authored length down it (`berryPoses`), not at the link it is tied to: that link is the nearest one, up to half a spacing away, and the settled cord is a few millimetres a link longer than drawn, so on BALL's plant a stalk drawn from its link left the cord 10-22 cm below where the editor draws it and climbed to its berry instead of drooping into it.
Measured along the settled cord, the root is within 2-17 mm of the editor's.
The cord itself still settles long (5.4 mm a link on BALL's plant): aiming its joints as the stalks are aimed was tried and dropped, the give being different on every settle (shortened by it, the next settle gave a third as much and left tips 26-70 mm short).
The berry's SHAPE is karin's (`roundBerryGeometry`); its look follows Tris's reference (`render3d/roundBerry.ts`): a dark, glossy, translucent amber fruit with a faint warm light at its heart, pale flecks in the flesh catching it.
The light is computed in the shader from how square the surface faces the eye, so it is at the berry's heart whichever way the stalk turns it, and in small linear numbers because the scene's ACES Filmic curve lifts and bleaches anything bright.
It stays inside the berry: karin's additive halo and her per-plant point light are removed.
The berry's growth axis is UP, leaned 15% toward where its stalk comes from (`roundBerryAttachment`): a fruit hangs from its stalk, so the stalk comes down into its top and the cap sits there, as in Tris's reference (karin's axis pointed at the stalk and put the cap on the berry's shoulder).
The cap is a brown knot and one mesh of leaves per berry (`berryCapGeometry`).
The knot (`roundBerryKnot`) is the stalk's end swelling into the berry's top, sized by the stalk (`STALK_RADIUS`) rather than the berry and closed at the top, and the stalk runs into that top (`STALK_KNOT_HEIGHT`, `roundBerryAttachment`).
EVERY leaf grows out of it: its base is blended onto a collar round the knot, clasping part way round, each tier a little higher up the knot than the one under it, so no leaf starts in a ring of bare fruit away from the stalk.
The leaves are painted by the standard vine's leaf material (`makeVineLeafMaterial`: its veins, mottle and light through the leaf) in the reference's muted olives, yellowing toward the tip.
Each leaf is long and pointed, folded along a raised midrib (`LEAF_FOLD`), rising out of the stalk, arching down over the berry's shoulder in three tiers (`CAP_TIERS`), and curling its tip out and up.
The leaves DRAPE: each is laid over the fruit and over every leaf laid before it, a leaf's thickness above whatever is under it (`LEAF_THICKNESS`), so neighbours overlap like real leaves and none stands off into the air except its curled tip, which no later leaf rests on.
A leaf is stiff: each row across it is its folded section seated as one piece, leaning onto the highest of what is under it, and along its length it is eased so it bends over what it crosses rather than taking every bump.
Every berry's cap is its own (the vine's seed and the berry's index): leaf count, place round the stalk, length, width, bow, sweep, curl and green.
Rejected on the way: a flat instanced blade (a flat leaf touches a sphere at one point and the rest of it hangs in the air), leaves on fixed-height shells (a leaf did not follow the one under it), and leaves following every bump under them (the cap read as wilted lettuce).
The 2D canvas draws the cap side on, varied per berry the same way.
A grab brightens the berry for half a second (`settings.glow` scales the light; 1.5 is the look as made); karin's grab chime is removed.
The 2D canvas draws the same poses flat, cord first.

**Authoring** is in [editor](editor.md#berry-vines).
`BERRY_TEST` is the sandbox: two berry plants beside an ordinary vine.

## What checks it

`cli vines` (`sim/vineCases.ts`), and it is the whole of the coverage, because a
vine reaches no avatar digest and no invariant: it violates nothing when it comes
apart, and a build that quietly stopped making links renders as a level with no
vine in it and passes everything else.
Berry vines have theirs, `scripts/test-berry-vines.ts` (a step of `bun run test`): the format and unit round trips, that a real fast hook flies through the cord and catches a sleeping berry, that each berry rests where it was placed and at its own size, that a stalk's stiffness bends the plant and cannot push it, the fold of the retired arc fractions, a real throw's catch, swing and release with no contact or wrap on any vine body but a berry, bit-identical replays, the ball landing on a sleeping berry (waking its vine, knocking the berry, not sinking in) and falling straight through the cord, the chain wrapping a berry it does not hold, the editor's grow, place, slide, size and remove, with a lengthened vine leaving every berry where it was, that a wind-up keeps the hanging ball's weight on the berry (the sag held through a slow wind on BALL's three berries), and that a berry cannot be whipped into a slingshot (`hung-anchor`'s whirl on BALL's berries at its pace and twice it: ball and berry under the bars, the berry's spin exactly zero on every frame, the lease and the chain's length bounded, the berry still held).
Nothing there pins how a berry vine feels to swing on; that is played first.
The braid has its own test, `scripts/test-vine-braid.ts` (a step of `bun run test`): it renders braided vines through `VineLayer` and checks the leaves against the tube, and it simulates braided and plain vines side by side, frame by frame, to prove the seed never reaches the sim.

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
