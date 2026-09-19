# The coil and the hook

## The coil

Rope wound onto the circular body the rope *starts* on — the ball winding its own
chain around itself — is carried as an **angle**, not as a run of wrap nodes
(`Rope.syncCoil`).

Everywhere else a wrap is a discrete decision about one corner, and that is the
right model: the rope either bends around that corner or it does not. A coil is
not that. It is one continuous quantity, and representing it as a run of twenty
tangent points made every frame's answer a fresh stack of twenty independent
decisions that did not agree frame to frame. `cullDetachedNodes` drops a wrap
once the rope stops bending around it — correct per node, and it **cascades**:
the tail node goes, the one before it inherits the new outgoing span and goes
too. In `session-458f` three went at once and the measured path fell 18.6 cm with
nothing having moved, which the solve "corrected" by snapping the bodies several
centimetres while the winch stall covered the rest.

Three things determine a coil, and each is continuous on its own:

- the material point the rope leaves the body from (`start`), which rotates with
  the body;
- the tangent point it leaves *at*, which is geometry — where a taut line from
  the next node touches the circle — and slides smoothly as that node moves;
- how many whole turns are in between, the only thing that has to be remembered,
  and remembered by **unwrapping** the angle against last frame's rather than
  re-deriving it.

Winding past a full turn and unwinding back through zero are then both ordinary
arithmetic on one number. There is no create, no cull, nothing to cascade. The
nodes are re-derived from the angle at `COIL_NODE_ARC` every regeneration, which
is a *rendering* resolution — only the last of them reaches the length solve,
since `generatePathObjects` already collapses a run of same-circle wraps into the
one that leaves the body.

The coil is also why `regenerateAndMeasure` takes its baseline **after** a coil
sync: the coil's nodes ride the body, so between frames they carry its rotation
with them and the stored path is a turn's worth out of date. Sync first and the
difference is the node set changing; sync after and a ball spinning at 46 rad/s
reads as a 13 cm "discontinuity" that is really just the ball having moved.

Two supporting pieces:

- `Rope.spanLength` measures a span between two nodes on the same circle as the
  **arc**, not the chord. Rope lying on a circle is an arc; chords understate it,
  and by more the coarser the sampling.
- `Rope.topologyCreditScale` is the backstop for whatever discontinuity is left
  anywhere else in the path: the share of a frame's length error that a
  regeneration put there is corrected in position but earns no velocity.
  Δposition over Δt is how half a metre of phantom error once became a 96 m/s
  launch (`session-1474f`).

Across the whole ball corpus this leaves **one** frame with a path discontinuity
over a centimetre, at 1.6 cm — against roughly twenty-five frames reaching
19.7 cm before.

Two invariants back this up (`checkBallInvariants`). `rope-grew` bounds the chain
against the length it anchored at, but only loosely: a single discontinuous jump
in the wrap path can be most of the total on its own (26 cm in one frame in
`session-284f`), which is not this bug. `rope-stalling` is the sharp one — a
*run* of blocked frames is the shape of every chain runaway there has been, and
the corpus split cleanly when it was written, 17 frames at most when healthy
against 79, 51, 36, 32 and 28 for the runaways.
**That margin is now thin**: a healthy `session-431f` runs 59 blocked frames
against the invariant's 60, up from 6, and the rise is what a properly held ball
looks like rather than a runaway - a chain pulling the ball into a surface it is
resting on is now refused *consistently* instead of intermittently, and the run's
chain ends at exactly the length it anchored at (zero growth) in every case.
The counter is a proxy for the runaway and it has drifted toward the thing it
measures against; before trusting it again, re-measure the split across the
corpus and re-derive the bar from what healthy actually reads.
A hard ceiling on the stall itself is **not** an option, tempting as it looks:
a point-blank anchor is legitimately held over its length by the geometry it is
anchored to, and capping the stall leaves the solver fighting the push-out every
frame — over-length, solve-kick and embedding violations in `session-284f` and
`session-1474f`, whose chain anchors 2 cm from a surface the ball is resting on.
The push-out resolves its **two deepest overlaps simultaneously**, the same solve
`moveAndCollide` uses (`d·n1 = depth1`, `d·n2 = depth2`, escaping through the
wedge mouth). Doing them one after the other is what its own comment warns
against — pushing fully out of one surface can push straight into another, and
whichever was handled last wins — and a ball resting on the floor beneath a rigid
polygon is exactly that wedge: sequentially it drove the ball ~10 cm into the
floor over four frames (`session-284f`).
The chain end is
a `BallHook` — a RigidBody2D projectile that anchors to the first surface it
contacts, flying or dangling.
The throw is a **straight line**: the hook carries `gravityScale = 0` for the
deploy and `BallHook.endFlight()` switches gravity back on the moment the throw
ends, so the shot goes exactly where it was aimed and only then falls.

A hook that lands on a hook-proof surface and STAYS there is steel, not a puck
on ice, and four pieces make that true (session: the tip crept indefinitely
across the shallowest slopes; `cli contacts` `hook-rest` is the detector -
holds on 10° and 25°, still slides off 50°).
It carries real coefficients (`contactFriction` 0.55, `staticFriction` 0.6,
breakaway atan(0.6) ≈ 31°) where the RigidBody2D defaults are 0.
`probeContact` deflects a hook-proof contact only above
`PROBE_DEFLECT_MIN_SPEED` (0.5 m/s): the probe's seat holds the hook a margin
clear of the surface, so a RESTING tip deflected every frame hovered outside
the solver's reach for ever - no loaded contact, no normal impulse, no
friction cone however real the coefficients; below the gate the contact solver
owns the tip, and above it the deflection (and the spark stream made of its
reports, well over this speed in every recorded drag) is untouched.
Its rotation is DRIVEN rather than integrated (`kinematicRotation`, the steered
ball's own mechanism): every step turns the bar to face back along the chain
(`BallHook.alignToChain`), so the contact solver and the rope's torque arms
treat it as rotationally locked and no impulse is spent on a spin the next step
overwrites. It used to be a disc with its inertia scaled by 1e4, because a
circle with friction ROLLS - the contact point is stationary, the slip Coulomb
acts on is zero, and the stiction gate reads a spin far over `STICK_SPIN` - so
the hook trundled downhill with its friction fully satisfied; a bar does not
roll, and its facing is the chain's (see [**The manacle**](manacle.md)).
And `applyStaticGrip` no longer gates on depth (see [**Resting contacts**](contact-solver.md#resting-contacts)). Every
ending calls it — the hook attaching, a bounce off a hook-proof surface (the deflected
remainder does arc), the chain snagging geometry, and the chain running out of
length (so the dangling tip swings instead of hanging in the air).

The attach test **must out-reach the solver**, and that is why its sweep runs `CONTACT_SLOP` past the end of the step rather than stopping at it.
`World.integrate`'s constraint gather keeps *speculative* contacts out to that band and cancels the approach velocity of anything that would close the gap within the step, whether or not the two ever overlap.
So a hook that stops short of a surface by under a centimetre never gets a second frame in which to touch it: the solver has already spent the approach, and what is left is tangential.
In `session-593f` the hook fell 200 mm in one step at a hanging plank 193.7 mm away, the sweep wanted `t = 1.033` and returned null, and the solver converted 12 m/s of approach into a 4 m/s skate along the plank's face that carried the hook off its corner over the next twelve frames - a clean shot at a big target that simply did not stick, and which replayed **HEALTHY**, because nothing about it violates an invariant.
The reach costs no accuracy: the anchor is still placed at the swept contact point, which is on the surface.
The overlap probe's margin is deliberately **not** widened to match.
The sweep extrapolates along a known direction of travel; the probe has none, so a `CONTACT_SLOP` probe would anchor to whatever is within a centimetre, float the anchor off the geometry (`session-601f`) and lengthen the chain's path enough to kick the ball as it anchors (it fails `rope-anchor-kick` on `session-576f`).
A near-stationary hook needs no help from it in any case, since the sweep's reach never falls below `CONTACT_SLOP` however slow the hook is.
`playtests/ball-hook-short-step.json` is the scenario in isolation: a throw whose step ends 8 mm short of a ceiling must anchor on that same frame.

Reaching further is still only an **approximation** of the solver, though, and the exact half of the attach test is `BallHook.attachToBlockingContact`, which reads `World.frameContacts` and anchors wherever the solver actually pushed back.
The two measure different things and cannot be made to agree by tuning a distance.
A sweep measures **along the path**; the solver's band is **perpendicular**, so on an oblique approach the path to contact is longer than the gap across it by `1/cos` of the angle between them and a reach of one `CONTACT_SLOP` under-covers a band of one.
The solver is also blind to the contact point sliding off the feature within the step, so it blocks against a corner's face *plane* on paths that clear the corner.
`session-1154f` is 4 mm of exactly that, at the swinging end of the same hanging plank: a 2.9 N·s impulse off the end face's plane turned a 12 m/s throw into 4.9 m/s at 45° off aim, with every predictive test correctly reporting no contact.
Reading the solver's own contacts needs no second copy of its predicate and cannot drift from it, and `normalImpulse > 0` is what separates a contact that pushed from a speculative one that asked for nothing - so a hook coasting parallel to a wall a few millimetres clear still does not anchor to it.
It is one frame late by construction (physicsStep runs before integrate), which is why the sweep exists and runs first: the sweep catches the head-on case on the right frame with the shot's velocity intact, and this catches everything else on the right surface.

Being late means the frame after has to exist, and it does not when the same contact **ends the throw**.
A block hard enough to stop the hook dead is a spent deploy, read off the hook's motion after integrate on that very frame, and the conversion to a dangling tip un-flies the hook before its next `physicsStep` - so this declines, on the one frame it was written for.
`session-401f` is that miss: a 12 m/s shot at an attachable wall, blocked 8.84 mm off the face by a 2.68 N·s impulse (the sweep wanted 210.262 mm of its 210.000 mm reach - the `1/cos` shortfall above, at cos 0.8616), the tangent eaten by the friction cone, 12 m/s down to 0.246 against a `DEPLOY_MIN_SPEED` of 0.5.
The throw ended on f307 and nothing ever anchored: the chain dangled at the 1.027 m it had reached, the winch reeled the hook back in over the next eighty frames, and the run replayed HEALTHY.
So `BallPlayer.checkChainReach` asks this **before** it converts a spent throw, where `World.frameContacts` is the current frame's set and the hook is still the deploying one.
Only on that branch: the chain running out and a scene catch are the chain ending the flight rather than a surface, and an anchor past the chain's own reach is the dishonest forgiveness `hook-mouth-band` exists to keep out (the snap backstop in `onHookAttached` refuses it in any case, exactly as it does for `probeContact`).

It rescues a **throw** only. A dangling tip hangs at exactly `CHAIN_MAX_LENGTH`, so anchoring it on a contact reported while the hook is still millimetres clear buys the chain that much extra path, and a chain going taut-to-slack in one frame drops the ball it had been braking - 0.7 m/s of `rope-anchor-kick` on `session-576f` f60.
A tip drifts into its surface slowly and the probe catches it on real contact, which is what keeps the anchored length honest.
The `hook-blocked-attaches` contact case is the general statement, asserted over fans of throws past a tilted slab rather than at one placed near-miss: **every throw the solver pushes on must anchor**.
A single fixed offset would stop straddling the sub-millimetre margin the moment the manifold changed, and then pass by missing the geometry instead of by handling it.
The throws are made by a `BallPlayer`, through the frame order the game runs, because a backstop that is a frame late is a claim about the whole frame and not about the hook: driven bare, the case held every other part of this property while `session-401f` went by underneath it.
It runs **two tilts** for the same reason, and counts them separately.
Off a steep face a block is glancing, the throw keeps its speed as tangent and stays a throw, and the backstop anchors it on the frame after; off a shallow one the normal impulse is large enough for the friction cone to take the tangent too, the hook stops dead, and the throw is spent on the blocking frame itself.
The case fails unless it finds at least three of each, so a fan that drifts off the second shape says so instead of quietly testing half the property.

Whichever surface the hook reaches first decides, and where two are reached at once **an attach beats a bounce**.
Attachable and hook-proof geometry are therefore swept as two separate questions (`bodySweepConvex`'s `only` filter) rather than as one earliest hit.
The two are not comparable outcomes - a bounce is "nothing happened, keep going" and an attach is the throw being over - so ranking them against each other lets whichever surface sorts first decide for both, and at a seam there is nothing to sort by at all, since `t` is equal.
What actually decided was body **build order**, which is to say the order the level file happens to list its bodies in.
`session-596f` is that: the hook came to rest in the seam where a hook-proof disc meets an attachable pillar, touching both, and bounced off the disc at `t = 0` on every frame for 250 frames while sitting on a surface it should have anchored to on the first.
Nothing about it is a velocity - the hook sat still - so the only thing it showed up as was the chain it left dangling: frozen at its deployed length with its tip held by geometry, it fed the winch stall a blocked correction every one of those frames and grew from 64 cm to 3.58 m, read from the game as the chain stretching without limit.
`probeContact` had the same blindness one step further on, and there it needs no tie-break to justify the rule: a probe has no direction of travel, so every surface in the band was reached at once, and a hook-proof surface the tip is also touching does not un-touch the one it caught.
The anchor **point** is the other half.
The swept path places it at the sweep's own touch point projected onto the piece, which is the surface only while the sweep genuinely travelled to a contact.
A sweep that *begins* inside the piece returns `t = 0` (see "rest resolution when a sweep starts embedded") with the bar's deepest corner for a point, and that corner is inside the geometry - for the disc this used to be, stepping a radius along a normal that meant nothing buried the anchor 2 cm inside the pillar, which the chain then ran through.
There the surface answers for the cuff's centre (`nearestSurfacePoint`), exactly as `probeContact` has it answer for the same reason.
`cli contacts` `hook-seam` is the detector, and it asserts the seam from **both build orders** - an answer that depends on which body was listed first is not an answer - that the anchor lands on the face rather than a radius inside it, and that a hook-proof surface genuinely reached *first* still deflects, which is what stops the fix collapsing to "attach always wins".

**Reach is what the player is shown.** The chain is budgeted to the manacle's HINGE - its own end node - and an attach is forgiven nothing beyond it: the cuff's mouth leads the hinge by `MANACLE_MOUTH`, so a face the mouth can touch with the hinge at full stretch is bitten and one a hair further is not, and the tip stopping at `CHAIN_MAX_LENGTH` with the cuff drawn on the end of it is exactly the reach a throw has.
The chain anchors at the length it reached, to the hinge one ring radius proud of the face, so the anchored path is bounded by `CHAIN_MAX_LENGTH + MANACLE_REACH`.

That forgiveness used to be `ATTACH_SNAP_TOLERANCE` (0.2 m), and it made the reach dishonest.
The constant is the attach callback's **snap backstop** - introduced sized for the ~1 px of solver slop a dangling tip carries when it finally lands, with 20x headroom - and it was later handed to the flight sweep as range without being re-picked for that job.
The result was a chain that stopped at 1.8 m in front of the player and attached at 2.0: in `session-366f` seven throws inside 4 degrees of aim at a wall 1.95-2.01 m out caught four times and missed three, with the sticking ones anchoring further out than the failing ones had reached, and nothing on screen to predict it by.
The backstop keeps the 0.2 m, because what it rejects is an anchor **no throw could reach** - one offered by `probeContact` or by the solver's own contacts - and the longest path a deploy can now anchor at is ~1.85 m against that 2.0 m gate.
It was not always slack: while the flight was forgiven 0.2 m too, the anchor's extra radius put the path a few millimetres over the gate and the chain was dropped on the anchoring frame - eight of the last fourteen throws in `session-1355f`, which reads from the game as the chain **retracting itself while the deploy button is still held**.

There is no separate forgiveness band any more, and the frame-boundary tie it was once moved to the chain-out event to settle is gone with it: the mouth rides `MANACLE_MOUTH` ahead of the hinge inside the ONE sweep, on every frame alike, so there is nothing to sweep twice.
That tie was real while the band was a disc radius budgeted past the flight, swept only on a step that *started* at full stretch: `CHAIN_MAX_LENGTH / (HOOK_SPEED * dt)` = 1.8 / 0.2 is exactly 9, so every straight throw from a stationary player arrived at chain-out precisely on a frame boundary and a few ULP of accumulated rounding in the span decided whether the throw was forgiven at all.
`session-1017f` is 17 throws at one target with the wall inside the band of the day: 8 stuck, 9 dangled, the two sets interleaved across the whole 0.4 degree spread of aim, the same wall span appearing in both (`session-234f` is the same tie over 3 throws).
The flight sweep's rules are what they were: an attach wins a tie, and a hook-proof piece between the cuff and an attachable surface further along blocks the attach without bouncing if the chain runs out first, because it is the chain and not that surface that ended the flight.
`cli contacts` `hook-mouth-band` is the detector.
It still seeds the last flight step so the chain runs out INSIDE it - the hinge at 1.6005, chain-out at `t = 0.9975` - rather than flying a whole throw, because a natural throw can only express the tie itself; a ceiling a hair inside the mouth's reach past full stretch must anchor, one a hair outside it must not, and the anchored path must stay inside `CHAIN_MAX_LENGTH + MANACLE_REACH` with the chain never dropped.
The `chain-out` case carries the other half at throw scale: a ceiling just inside the mouth's lead anchors, one comfortably past it does not, and a hook-proof wall past it is never touched.
**Both cases derive those placements from `MANACLE_MOUTH` rather than writing them down**: written as literals against a 20 mm cuff (15/21 mm and 10/50 mm) every one of them was inside both bands at 53.5 mm - the "out of range" ceiling was legitimately caught, and the hook-proof wall the chain is supposed to stop short of was bounced off before chain-out, so the case's jerk was never measured at all.
Level scenarios authored against the old 0.2 m reach had to move their targets ~20 cm closer to stay in range (`ball-hang-at-rest`, `ball-wind-up`, `ball-winch-hung-anchor`).

At the absolute max length
(`BallPlayer.CHAIN_MAX_LENGTH`) an unattached hook becomes the dangling chain
tip: the chain stays deployed at that length (solver-driven swing) until it
touches a surface and anchors, is released, or is **reeled all the way in**.
Rolling winds the chain onto the rim, and against a dangling tip the winch pays for that by hauling the hook in, which is the whole of what reeling a missed throw means.
The frame the hook's hinge reaches the rim with the path over the chain's length there is nothing left to haul, and the chain is **stowed** (`BallPlayer.stowIfWoundIn`): `Rope.closeCoil` winds the coil to exactly the chain's length and ends the rope there, a material point on the rim, the hook body leaves the world, and the cuff is drawn at the coil's end (`manaclePose`) riding the ball as part of it.
Stowed, the ball is a free ball carrying its chain: `chainAnchored` and `chainAttached` are both false, so the chain phase skips it as it skips a hook in flight, nothing solves it, and it is no tether.
Every node of a stowed chain is a material point of the one body, so its length holds still however the ball turns; the end is the last coil node's own point rather than a point beside it, because `spanLength` reads two same-circle nodes as the arc between them in the wrap's sense and a point a float behind its neighbour is a full turn ahead of it.
`chain-stowed` is the invariant: end on the ball, length within `CONTACT_SLOP` of the chain's.
It pays back out the moment the ball turns the unwinding way (`unstowIfUnwinding`, `Rope.coilUnwindsWith`): the tip is the dangling hook again, born at the coil's end with the ball's linear velocity - not the rim's, which would sling it - and the coil spools off under it as it wound on.
Roll the other way again and it is reeled in and stowed on a coil of the opposite hand.
Before this the coil simply kept growing: the coil is an angle, nothing refuses the ball's rotation on a free tip's account (`spinShare` is zero until the end is fixed, see [**Spin traction on a fresh contact**](ball-rolling.md#spin-traction-on-a-fresh-contact)), so every turn coiled another 0.75 m of chain that did not exist - 1.8 m of chain measuring 3.5 m, drawn wound four times round the ball, `rope-over-length` on every frame from the hook's arrival on (`session-251f` f106, seen in the game as the chain wrapping the ball over and over).
Refusing the turn instead is the ice `session-315f` reported; a hook left as a body riding the rim of a rolling ball is a 2 cm bar striking the floor once a revolution; and retrieving the chain outright was tried first and read from the game as the chain vanishing mid wind-up (`session-105f-stow`).
Both halves of the stow test matter: the hinge at the rim alone is a tip that fell back against the ball with the whole chain draped slack, and the over-length alone is a swing going taut, which is next frame's ordinary correction.
Only a rope that is coil and nothing else is closed: a wrap beyond the coil is real chain lying over the scene, and coiling the whole length onto the ball would pull it through whatever it lay over.
A dangling tip is also **not a tether**: the free-ball guards (the spin-traction cap and the loop ride) stay on while the chain's end is the ball's own hook, and `session-251f` is the regression for the tree that switched them off for it. A deploying chain
that snags scene geometry mid-flight also converts to the dangling tip: while
the hook is in flight the chain is slack (no length solver), so
`BallPlayer.checkChainReach` runs `Rope.detectSceneCatch` each frame — if the
straight span has caught on a body other than the ball itself (ball
self-winding from aiming is not a catch), it keeps the generated wrap node and
freezes the deploy at the wrapped path length, so the chain wraps the corner
and stops paying out.

## A throw that is going nowhere is over

The third conversion is the throw simply stopping (`BallPlayer.deploySpent`).
A deploy is the hook **travelling out**, and every other way one can end had a trigger of its own - the chain running out, a snag on scene geometry, a bite - while the hook being stopped dead or turned around had none.
`BallHook.bounce` only redirects the hook: it has never ended the deploy, deliberately, because a glancing hit off hook-proof steel is still a throw and must go on paying out chain.
A head-on rebound is not, and nothing downstream could end it either - the chain cannot run out for a hook coming home, and a hook sliding down the face it bounced off snags nothing.
So the throw stayed "in flight" for as long as the button was held, the deploy phase outliving the deploy by any number of frames.

The rule is read off the hook's own motion on every frame of the deploy, after integrate: under `DEPLOY_MIN_SPEED` (0.5 m/s, 4% of `HOOK_SPEED`) it has been stopped by something, and a velocity with any component back toward the player is a throw coming home.
One question then covers the rebound, the wedge in the corner the rebound leaves it sitting in, and the solver's own cancellation of an approach that was never reported as a bounce at all.
A throw into a hook-proof wall 1 m out now ends on the frame it rebounds, at the 0.78 m it reached, and the hook swings there as the tip it has become - armed, so the surface it drops onto is still bitten.

The same reading is the last word on an **attachable** surface too, and there ending the throw is not the answer: what stopped the hook is what it was thrown at.
So the spent branch asks `BallHook.attachToBlockingContact` first and only converts if nothing answers (`session-401f`, under the blocking contact above).
Ordering, not a second attach rule: the deploy is what that test reads, and ending the deploy first took away the frame it runs on.

Measured on the hook's velocity and the player's **position**, not on the rate the span between them grows.
The span's rate is the same statement about a hook in flight and a wrong one on the frame it is fired: a ball already travelling faster than `HOOK_SPEED` along its own aim is separating from a hook that is flying perfectly well, and a payout-rate test kills that throw at the muzzle.
The hook being overtaken by the player is the honest form of that case, and it reads here as the hook closing on the player, which is what is asked.
`cli contacts` `deploy-spent` is the detector: the head-on rebound ends the deploy on its bounce frame, the glancing one (still going out at 10.8 m/s) runs on to the chain's full length, the open throw is untouched at 12 m/s, and the same wall made attachable is still bitten.

## The spawn anchor

A spawn may say the run **starts on the anchor** rather than on the ground (`SpawnData.hang`, a checkbox in the editor's Player spawn group).
`BallLevel` builds the level, settles its chains, builds its vines, and then throws: `BallPlayer.anchorOverhead` turns the ball to face straight up exactly as a press does, calls the ordinary `shoot()`, and runs **one** `BallHook.physicsStep` long enough to cover the chain's reach (`CHAIN_MAX_LENGTH / HOOK_SPEED`).

It is the ordinary throw with one big step, and that is the whole design.
Everything the throw knows then holds at the spawn for nothing: the chain-out cap stopping the reach at 1.8 m, an attach beating a hook-proof bounce at a tie, a rail clamped rather than bitten, a vine threaded as a ring, a viscous face bitten to the hinge.
A second attach path written for the spawn would be a second copy of all of it, drifting from this one the first time either is touched.
The step is the reach over the launch speed for the same reason: what ends the flight is the chain running out, not the step running out, so the hook budgets the spawn throw against the same allowance it budgets every other one.

The throw runs **last of the build** because it is swept against the world as it stands - a chain-hung lantern has come to rest (`settleChainsAtBuild`) and the vines exist and know which link belongs to which vine - so the anchor is taken on the same geometry, in the same poses, that the first frame of play will see.

A throw that anchors nothing leaves nothing: no chain, no dangling tip, and the facing the ball spawned with, with a console warning naming the cause.
The test is `chainAttached` and not `chainAnchored`, which is the distinction a spawn with clear sky over it turns on - a throw that finds nothing ends as the dangling tip, and 1.8 m of chain hanging in the air above a ball that never threw it is not a state any level means to author.
The honest reading of "there was nothing up there" is the level starting the way it did before the flag.

**The first press re-throws it.** A spawn chain is one the player never threw, so the press arrives with a chain already out - a state hold-to-keep otherwise cannot reach, since a press while the button is down is not an edge and the toggle grip's own redeploy has dropped the chain a step earlier.
Nothing answered that press, and only the release spoke, so the opening click read as detaching the chain the player was hanging from.
`resolveInput` now re-throws on any firing press (and snaps the facing to the aim on it, or the second throw would leave along the rate-limited turn's leftovers), which is exactly what `BallInputSource.redeploy` has always meant downstream.
The `spawn-hang` case asserts the click leaves a NEW chain rather than an empty hand.

The flag anchors the chain; it does not lift the ball.
The ball hangs at exactly the length the throw paid out, so where the spawn sits is the whole of the authoring: under a ledge is a dead hang, off to one side of it is a level that opens mid-swing, and on the floor is a ball sitting on the floor wearing a chain.

**The anchor is older than the first frame**, and `BallLevel` says so by arming `endWasFixed` at build.
Frame 1 is then an ordinary frame of a chain that already holds the ball, rather than the frame it anchored on - and the difference is the birth-length re-take (see [**the anchor born this frame**](ball-chain.md)), which exists so that an anchor taken at the top of a frame does not charge the ball for the distance it travels over the rest of it.
Applied to an anchor that was born before the frame, that rule hands the chain the first frame's fall: the ball settles 2.7 mm - one gravity step - below the point the level authored, on a chain 2.7 mm longer than the one it was built with, and reads one frame of 0.163 m/s on the way.
Armed, the solve holds the authored pose instead and the level opens at rest in the strong sense: `playtests/ball-spawn-hang.json` reads speed 0.0000, drift 0.0000 and chain growth 0.0000 from frame 1 to frame 300, the same statement `spawn-at-rest` makes for a sprung body.
`playtests/ball-spawn-hang-out-of-reach.json` is the other half - a ceiling 3 m up over a floor 0.2 m down - and asserts no chain at all, the ball resting where it fell.
