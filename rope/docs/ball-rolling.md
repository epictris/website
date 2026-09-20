# The steered ball: grip, spin traction, the loop and the entry

## The steered ball's grip

`applySteeringGrip` pins the rolling ball's centre to an anchor that **advances
by the roll it intended**, which is how the one frame of gravity creep the
integrator slides in underneath it is removed without touching the roll itself.
That anchor survives a few ungripped frames (`STICK_RELEASE_FRAMES`) because the
grip flickers, and for a crate holding a slope that is right - it drifts
sub-millimetre while the grip is off.
A rolling ball does not drift, it **travels**, and the anchor stands still while
it does, so resuming onto a held anchor yanks the whole lapse out in one frame.
Five ungripped frames at 2.4 m/s put the anchor 21.7 cm behind the ball and the
grip dragged it back there, with no velocity change to show for it: a teleport,
backwards, through its own direction of travel (`session-497f` f376, reported as
the player rubber-banding).
So the anchor is continued only if the grip actually held **last** frame, and
re-seeded otherwise, which costs nothing because this anchor holds no position -
it advances every frame and exists only to remove that one frame of creep.
`cli contacts` `grip-reseed` is the case: a ball rolled across a gap narrower
than `STICK_RELEASE_FRAMES` of flight, which is the only way to make the grip
lapse and return with the anchor still held.

It rolls for the spin the chain let **stand**, not the spin the aim wrote (`RigidBody2D.spinDriveShare`, 2026-09-16).
The aim's spin is written before the frame knows whether the chain will refuse it, and both the pin here and the Coulomb cone in `solveTangent` sold the whole ask as roll before the unwind handed the refused part back - which is `session-315f`'s ice and the rule `roll-unfunded` states, a rotation the chain refuses may not have funded traction.
For a long time the wind-stall latch hid it: wound tight, the steering stopped asking, so there was nothing to sell.
A braced ball never latches (see [ball-chain](ball-chain.md)), and `session-518f` is what the sale costs without it: the ball on the floor with a stool hooked to it and balanced against it, the aim asking 3.4 rad/s every frame and the unwind refunding every frame of it whole, the grip driving the centre to rim speed regardless - 0.4 m/s along the floor at zero spin for four hundred frames, the stool riding along, `roll-unfunded` firing three times.
So `BallLevel` hands the ball the share of each frame's ask that stayed wound, one frame late (the unwind runs after the contacts; the frame that refuses a turn has already sold it, the next does not), floored at `STALL_EPSILON` of chain so a converged aim's residual buys its drive whole (`session-379f`).
A quiet frame - an ask under that floor - is no information either way, so the share HOLDS across it rather than resetting: it is a fact about the jam, not about the ask.
Reset to 1 on every quiet frame, a proportional aim that toggles between nothing and a 24 rad/s snap had every snap's first frame funded whole, and each bought the ball rim speed on the floor before the refund came - 2.8 m/s in one frame from a standing start, with the stool going over the top lifting the floor load off it so nothing braked the coast (`session-141f` f77 and f82, reported as the ball sliding very quickly).
Held, a snap into a standing jam buys what the jam last allowed, the first frame the chain does let a turn stand re-earns the drive whole, and the same recording keeps the ball within 6 cm while the stool comes over.
Everywhere the contact solve reads the spin as a fact about the surface, it reads the kept share of it instead: the pin's roll here, the slip `solveTangent` answers, the normal impulse `spinFabricatedNormal` charges an off-centre loop with, and the aim's brake fade - at a share of exactly 1 each product is the spin itself, so every body that is not steered and every recorded replay are bit-identical.
Three of those four were found one at a time on the same afternoon, and the order matters because the first attempt was the wrong shape.
Cutting the CONE on the spin's drive side was tried first and left the ball unable to resist a push the other way: a stool going over the top of the ball shoved it out from under at 3 m/s with friction having nothing to say (`session-184f` f72-96, reported as the ball rapidly sliding opposite the roll).
Taken off the slip instead, the cone stays whole and holds the ball against the push, and what is left of the spin drives what it honestly can - 1.7 m/s.
The aim's brake fade protects momentum the spin earned, and travel a refused spin did not fund is not that, so the fade is undone by the refused share - 1.6 m/s.
And the loop, spun into the floor at the full ask, read as having fabricated the whole of a 26 N s normal impulse the stool's weight had really put there, so the cone read as zero: sized by the kept spin, friction held, and the ball drifts 15 cm while the stool goes over and lands on its far side.
`session-518f` holds the ball to the millimetre for three hundred frames with the stool balanced on it.

It grips **scenery** as it grips the world, and for a long time it did not.
`applyStaticGrip` declines a `kinematicRotation` body on purpose - a steered
anchor has to advance by the roll rather than hold a point still - and this
routine declined every rigid surface, on the argument that gripping is against
the immovable.
Between them the one body in the game that is always steered had no position pin
at all against a rigid body, so it kept the whole of gravity's integration step
every frame: exactly the leak [**The position pin**](contact-solver.md#the-position-pin) below is written about, at
0.68 mm of sideways travel a frame, 84 cm down a 20° ramp in fifteen seconds,
reporting a velocity of zero the whole way.
Two things had to change together, and the second is the one worth remembering.
A pair is offered from **both sides**, because which body leads a constraint is
an id ordering and nothing more - against a ramp built before the ball, the ball
is `b`, and reading `a` alone (which was enough while `b` was always a static)
looked straight past the only body this routine exists for.
And resting is what the contact **carried**, not how deep it is: the solve pushes
a resting interface to exactly zero overlap and the pair then falls by the same
gravity step, so a `depth > 0` test reads float noise (see [**Resting contacts**](contact-solver.md#resting-contacts))
and dropped the grip every other frame.
Since a lapsed grip re-seeds its anchor wherever the ball has got to, each lapse
kept the creep it was there to remove - still 78 cm, with the grip nominally
holding.
`normalImpulse > 0` is the test instead, which is the same statement `mu * Pn`
already makes about how much grip there is to have.
`cli contacts` `steered-ramp-hold` is the case, and it measures the static ramp
beside the rigid one so the number stands against the same ball on the same
slope.

The third piece is that the anchor advances by the roll **relative to the
surface**, and not by `surfV - ω×r`.
The velocity the grip writes wants the surface's own motion in it - a ball riding
a moving body moves with it - but the anchor is held in that body's frame, so it
is carried along already and counting `surfV` again double-counts it.
Against a static the two are the same vector, which is why every static case was
blind to this.
Against a rigid one it is the whole of what was left: this engine integrates
before it solves, so a body carries a frame of gravity's velocity until something
cancels it, a contact does that every frame and a **chain never does** - a PBD
length constraint corrects position, not velocity.
A chain-hung platform therefore sits still while permanently carrying 0.163 m/s
downward, the grip read that as the surface sliding underneath, and the anchor
chased 54 mm/s of phantom downhill slip at 0.9 mm a frame: 29 cm down a 14°
slope in ten seconds, gripping on every frame, reporting a velocity of zero
(`session-599f`).
`cli contacts` `steered-hung-hold` is that scene - the same slab, held up by two
chains instead of by the ground - and it measures the ball against the SLAB,
because the rig is a pendulum and a ball riding a swinging slab is the ball doing
its job.

The fourth is that the anchor holds an **along-surface position and nothing else**, so its normal offset is re-seated to the ball's own every frame.
The pin projects that component straight back out (`d - n(d.n)`), which is why nothing reads it - and for a long time nothing kept it honest either.
The anchor is a material point of the SURFACE and a rolling ball is not one: it rides the surface at its own radius while the anchor goes wherever the surface's rotation carries the point it names, so against a turning rigid body the two separate along the normal by a couple of millimetres a frame, for as long as the grip holds, with nothing anywhere reconciling them.
Against a static that never happens, which is why every static case was blind to this one too.

A stale normal offset is harmless exactly while the contact normal is still, and a contact normal is never still for long.
`d - n(d.n)` resolves the offset against THIS frame's normal, so a wobble of `dtheta` hands back `|d|` times that wobble as **tangent**, and the pin applies it in full, as a position, with no velocity change to show for it.
On the tilting stool of `session-214f` the offset had reached 314 mm after 170 gripped frames; the ball then crossed a seam in the seat and the normal began alternating about 0.1 rad a frame, which bought a 30 mm teleport a frame - and since the teleport moved the ball, it flipped the contact back, so the buzz sustained itself.
Six centimetres peak to peak for 23 frames, out of a `vx` that read a smooth 0.5 m/s the whole way through, which is why nothing velocity-shaped saw it: `cli scan` called the run clean, and the digest table samples every fourth frame at a tenth of a metre, which is the alternation's own period and twice its amplitude.
It was reported from the game as the ball jittering side to side for a third of a second.

`grip-pin-buzz` is the detector, and it reads the teleport rather than the offset behind it.
The offset is the tempting quantity - it is the state that goes wrong - but its honest one-frame value is whatever the ball's own normal motion is, which over the corpus reaches the ball's full radius on a contact hopping to the next face, so a bar on it is a bar on nothing.
The teleport is what the pin *did*, and its legitimate size is the one frame of gravity creep the pin exists to remove: a fraction of a millimetre.
It is measured as a run of REVERSALS (5 mm, 6 frames running) rather than as a magnitude, because magnitude alone says nothing here: the pin is what enforces roll-without-slip in position, so a ball rolling fast has it making up a genuine centimetre a frame for as long as the roll lasts.
What separates that from a buzz is the sign. A correction that means something points the same way while its cause lasts; one that reverses frame on frame is the pin putting the ball back and then taking it away again, and no real mismatch behaves like that.

The fifth thing about the anchor is that it advances by the roll the integrator SPENT - the one the grip wrote last frame - and not by the roll being written now.
Between those two is a whole frame of phase: the grip writes a velocity at the end of a frame, the integrator spends it at the top of the next, so on the frame the pin runs, the step the ball has just taken was paid for by the previous frame's roll.
Advancing by this frame's compares a position against a displacement that has not happened yet, and the pin then applies the entire difference as a teleport.

That is invisible while the roll is steady, because then the two are the same number, and the steered ball's roll is never steady - the aim rewrites it every frame.
So it is the ripple of whatever the player is doing with the aim, resolved into position.
`ball-roll-wall` is where it was measured: the rig stirs a 45 degree step every two frames, the proportional aim tracking that staircase rippled the spin 25.70 / 21.42 rad/s under it, and the pin moved the ball -9.0 / +8.1 mm a frame, alternating, for the length of the run - found by `grip-pin-buzz` on the tree that had just fixed `session-214f`, which is a different cause with the same shape and on a STATIC floor, where nothing about the anchor's normal drift applies.
By the spent roll the same run sits at -0.43 / -0.51 mm, one sign, which is the contact damp's 1% of the step and a correction with a cause behind it.

The sixth is that the **chain phase carries the anchor** with everything it did to the ball (`RigidBody2D.carryStickAnchor`, 2026-09-18): the whole of the displacement onto the anchor, and the along-surface part of the velocity change onto the roll the integrator is about to spend.
Both taken relative to the gripped surface, because the phase moves the surface too when it is a body on the chain's path - the hung platform of `session-599f` - and the anchor, held in that body's frame, is carried by that already; the ball's world displacement on top left it behind by exactly the platform's share.
The steered grip only: a ball that is not aiming holds the crate's pin (`applyStaticGrip`), whose anchor is its stiction, and that one still stands against the chain as it stands against everything else.
The pin and the length solve are both hard positional pins on the same body, and against a taut chain they disagree: the floor's no-slip walks the anchor away from the hook by the roll, the winding hauls the ball toward it by the same amount, and two constraints that cannot both hold along the floor hold together only by leaving it.
`session-367f` is the recording: the ball on a 6 degree floor at the end of a fully paid-out chain to a static, the aim held away from the hook, the anchor walking off 1.3 mm a frame and the solve hauling 1.3 mm plus the winding back.
Each frame the pin teleported the ball out to the anchor and the solve teleported it back, the gap growing by twice the rim speed - 17 to 27 mm over twelve frames - and the normal parts of the two teleports (the floor's slope, the chain 21 degrees above it) summed to 1.5 mm a frame of lift that the one-sided contact could not cancel.
The contact's load decayed from 8.5 to 0.5 N s as the ball hovered out of the speculative band, the contact let go, the ball fell 2 cm at 0.5 m/s, the grip re-seeded on landing and it went round again, every 12 to 33 frames, replayed HEALTHY - `grip-pin-buzz` sees reversals of the pin, and the pin never reversed; it was the solve doing that.
`grip-anchor-behind` reads the gap itself at the end of a gripped frame (see [headless-tooling](headless-tooling.md)), which is the state the pin acts on next, and eleven more bundles in the corpus carried it.

The winding wins.
Carried, the pin removes exactly gravity's creep again (0.3 mm a frame on the same recording), the solve hauls the winding alone (1.5 mm), and a grounded ball winding chain onto itself climbs toward its anchor at rim speed while its spin says the other way - slipping on the floor, which is what a yo-yo pulled along a line above the floor does.
The other way round - the chain refusing a winding the floor's grip will not let the ball follow, refunded through the unwind so `spinDriveShare` withholds the roll and the ball stalls at the end of its chain - was the alternative and was not taken: the chain's haul is a constraint with a length behind it, the pin is a control input's bookkeeping, and the depenetration sweep already made the same call for its normal part (`session-255f`).
The sweep still carries its normal part alone, because its tangential leftovers ARE the creep the pin exists to cancel; the chain phase's are not.

## Spin traction on a fresh contact

The steered spin is an infinite reservoir - `kinematicRotation` means no impulse can despin it - and the friction cone is written on the understanding that the normal impulse scaling it is a real load.
An impact's normal impulse is many frames of load delivered in one, and spent against the spin it mints energy: a ball rolling into a wall at 3.9 m/s had the rim's slip stopped outright out of a 234 N·s arrival impulse and left the floor at 4.4 m/s straight up with its spin untouched, an 86 cm launch off a flat wall (`session-773f` f600, felt as being thrown into the air).
So the cone in the spin's drive direction is sized from the pair's SUSTAINED load (`World.pairLoad`), never from the whole accumulated normal impulse: the sustained value never sits under the gravity press (full on a floor, nothing on a wall or a ceiling - the impact-frame statement of "a spinning ball cannot climb a wall"), climbs by one frame of weight per carried frame, and follows the pair's real load down instantly.
A steady load - gravity on a floor, a crate resting on the ball - reaches full funding within a dozen frames and keeps it, so every settled and persistent mechanic is left as it was; an impact decays before the ramp can chase it, and a ball GRINDING on a wall reads zero for ever, because between its own micro-bounces nothing presses it in.
Contact age is deliberately NOT the test: a pair bouncing gently on a wall stays "in contact" indefinitely while carrying no load at all, and maturity-by-age funded a second launch out of exactly that - a 78 cm wall climb off repeated micro-impacts (`session-422f-wall` f373).
The linear share of the slip keeps the full cone (`linearNeed`) - a skidding ball is still braked by a wall it hits - and the load is tracked per body PAIR with a few frames' absence grace (`PAIR_LOAD_GRACE`), because a compound body's touching shape changes while its press persists and a held press flickers out of the constraint set for a frame at a time.

**A load is a press, and a press points somewhere**, so a pair remembers one per DIRECTION and a contact draws on the press IT renews and no other (`sustainedAlong`).
Held as one number per pair it points everywhere, and a body is not one surface: `levels/ball.json`'s terrain is a single authored outline, so the floor and the 40 cm step in it are the same body PAIR, and the floor's matured 25 N·s funded the step's face - which carries 24% of the ball's weight - at the full `mu` of 3.8.
The ball ratcheted up the step, 3.3 of its own radii, in 24 frames (`session-373f` f318-f344, read from the game as the ball suddenly jumping up the ledge), spending 44 N·s where the face's own press funds 7.8, and the run replays HEALTHY: `spin-overdrive` is zero by construction against whatever rule the cap enforces, and the rule was the one that was wrong.
Directions are merged by PROXIMITY rather than binned on a grid (`PRESS_SAME_DIRECTION`, 22.5 degrees), and that is not a detail: a grid has seams, and a seam is a place where one press is remembered as two that ramp independently and never follow each other down, which at 16 bins puts `atan2`'s own seam on (-1, 0) - a plain vertical wall, straddling it, funding itself, `ball-roll-wall` climbing 21 cm instead of 5.
Merged, a pair with one press behaves exactly as the single number did, and `ball-roll-wall` is bit-identical.
Resolving a press onto a different surface by its COSINE is the tempting near-miss and it was tried: it is what a single force resolved onto a surface would do, and a ball's weight is not that - the floor carries the whole of it and the step in front carries none, so a quarter-credit still funded the face at three times its own press (17 cm of climb against the two-body twin's 9).
The ramp's RATE stays direction-blind (`rampBite`), because what qualifies a load is that it persists rather than where it points, and what it may now climb to is that direction's own normal impulse.

An **attached chain switches the whole regime off** (`RigidBody2D.constraintTethered`): the wind-up's climb to its anchor starts on a wall the ball has only just met, funded by its own arrival impact, and the chain machinery - the winch budget, the unwind, the lease - is what polices chain-era traction.
The cap therefore guards exactly the FREE ball, whose wall impact has no chain to answer for it.
**Attached, and not merely deployed** (`BallPlayer.chainAttached`, the end node on something other than the ball's own hook): a dangling tip is a quarter-kilo weight on a string the ball is holding, the chain phase already charges it nothing (`spinShare` is zero until the end is fixed), and handing the guards over on its account left the ball with neither.
That was `session-251f`: a missed throw dangling on a hook-proof floor, the ball rolled into a rock at 2.5 m/s, and a 290 N·s arrival impulse spent against the spin launched it 3.3 m/s up the rock's 62 degree face, three times over, until it stood on top of a rock the free ball cannot climb - felt as the chain giving the ball more grip, and as the ball bouncing off the rock instead of stopping at it.
`ball-roll-wall-dangling` is the pair to `ball-roll-wall`: the same wall, the same stir, the hook thrown into empty air first so the ball meets the wall with the tip dragging behind it, and the same climb bar - 53 cm on the tree that read the tip as a tether, 5 cm now.
`spin-overdrive` is the invariant: it reads the applied tangential impulse against the same funding arithmetic the cap enforces, so it is zero by construction while the clamp holds and catches any future path that spends spin-funded impulse outside it.
`ball-roll-wall` is the mechanic test - a ball driven 6 m into a vertical wall rises 26 cm at the old physics and under 5 cm now (`maxClimb`), while still reaching the wall at speed - and `session-773f` (the rolling launch), `session-422f-wall` (the grinding climb) and `session-373f` (the step climb) are the committed regressions.

`ball-step-ledge` and `ball-step-ledge-split` are the direction half, and they are a PAIR because neither says anything alone: the same 40 cm step, authored once as a concave outline in one body and once as two bodies tiling the same region, must behave the same.
Direction-blind, the one-body rig climbs the step and rolls 19.7 m over the top while its two-body twin stops dead at the foot (2.0 m, 7 cm of bounce); per direction the two agree to a centimetre.
A `maxClimb` bar alone would have been satisfiable by a ball that simply stopped rolling, and the control is what says the fix is about the pair key rather than about the drive.
What the pair does NOT claim is that the face is unclimbable: `ROLL_FRICTION` is 3.8 and `atan(3.8)` is 75.3 degrees, so a 76 degree face is 0.7 degrees past the ball's own breakaway and a patient player stirring the aim at a turn every 0.75 s still walks up it at 0.2 m/s, funded honestly by the face's own quarter of gravity.
That is the coefficient's margin and a question about level geometry, not the guard.

## The loop cap

Driving the mounting loop into the ground must **never** hop the ball, however
hard it is spinning.
Left to the contact solver it does, and the size of it is set by the loop's
rotation **phase** at the instant it lands, which is the one variable the player
can neither see nor aim.
The loop is a second collision circle offset on the rim, so unlike the ball's own
surface its contact point carries a *normal* component of ω × r; the spin is
kinematic, so the solver may not take that energy back out of it, and all of it
lands in the ball's linear velocity.
The same roll into the same floor launched at 1.7 m/s once and 4.4 m/s a few
hundred frames later (`session-1594f`), which reads as the ball randomly deciding
to fire itself off the level.
So a frame the loop is down on has its outgoing normal speed **capped**
(`BallPlayer.applyLoopCap`), at the plain restitution bounce the ball's own
linear approach was worth.
There was for a while a designed hop written over the cap above a spin threshold
- a ramp from `LOOP_HOP_MIN_SPIN` to `LOOP_HOP_MAX_SPEED` - and it is **gone**:
a loop touch is a touch at any spin, so a wind-up buys speed through the roll and
the chain rather than through the floor.
What the cap removes is exactly the **spin's** own contribution at that contact -
`(ω × r)·n`, scaled by `1 + restitution` because that is what the solve does with
an approach - and not a fraction of the answer.
The difference is the violent cases: a ball slammed into the floor at 4 m/s is
owed its full response, and a blanket cap takes 60% of it away, which leaves the
ball on the ground where the chain then hauls it (`rope-solve-kick` at 5.1 m/s in
`session-477f`).
Capping to *nothing* is worse again: the loop rotating under the ball really does
lift it, so the loop ends up pinned in the ground, its velocity answer removed
every frame while the positional sweep pushes the ball back out - a body
corrected in position and paid nothing for it, which the chain reads as a blocked
correction.
It is written after the contacts and the depenetration sweep, for the same reason
`applySteeringGrip` is: a control input with no force behind it cannot be
expressed as an impulse the solver would cap.
`cli contacts` `loop-cap` is the detector, and it drops the same ball at eight
starting rotations at three spins - ordinary rolling, a hard wind-up, and 90
rad/s, well past anything the aim steering produces.
Every one of them must peak at the drop's own restitution bounce (0.85 m/s, from
2.18 before the cap existed) and the phases must agree (they spread 1.25 m/s
before and are identical now).
The high spin is what stops the hop coming back as a threshold nobody notices:
the phases agree just as well when a launch is being written over them.

The cap is one half of the loop, and the **friction cone** is the other.
A shape mounted at the body's own centre reaches a contact only as slip - its
contact point lies along the normal, so `omega x r` there is purely tangential -
and that slip is the conveyor belt that *is* the rolling mechanic, Coulomb-capped
by the ball's own weight.
The loop is mounted off the centre, so its contact point carries a **normal**
component of `omega x r` as well: spinning presses it into whatever it is
against, which fabricates a normal impulse out of a kinematic spin nothing paid
for, and `mu * Pn` then sizes a friction cone from it.
The cone is the drive, so the ball funded its own traction against a **wall**:
135 N·s of normal impulse out of a ball whose own approach to the wall was zero,
spent as 120 N·s of friction pointing straight up, +2.1 m/s per touch.
It ratcheted 90 cm up a flat wall in 35 frames on nothing but the spin
(`session-200f`), and no invariant saw it - the run replays HEALTHY, because a
ball going up is only a bug once you know it had nothing to climb with.
`World.spinFabricatedNormal` measures that share and takes it off the cone: what
the spin pressed the surface with is not something the surface may press back
with.
It is the same statement the cap makes about the outgoing normal velocity, made
about the tangential half, and as there it is the spin's **own contribution** and
not a fraction of the answer - sized as the impulse that kills the spin's
approach and pays its bounce, so a contact keeps the whole of the cone its own
linear approach earned.
Removing the spin from the tangential **slip** as well is the tempting second
half and it is wrong: a loop bearing down on the floor is bearing the ball's
weight, and there the drive is the mechanic working.
Taken out, a rolling ball loses a fifth of its travel (`ball-roll-drive`, 2.4 m
against 4.9) and a ground wind-up stops paying its chain in
(`ball-ground-wind-up`).
The load is what was fabricated; the slip was always real.
The gate is the **mount** and not the arithmetic - for a centred shape the term
is identically zero, and asking the shape where it is mounted keeps it exactly
zero in floats rather than nearly so, which is what leaves every recorded replay
of a ball rolling on its own rim bit-identical.
`cli contacts` `loop-wall` is the detector, and its floor is **frictionless** on
purpose: a ball rolling on an ordinary floor drives itself into the wall through
its own rim and then bounces up it off a load its impact genuinely paid for,
which is a different question with a different answer, and a scene mixing the two
cannot say which one it is watching.
With no traction under it the ball has no approach to the wall at all, every
newton the wall pushes with is the spin's own doing, and the only honest answer
is that it stays where it is - 3.8 cm of the capped bounce off its own loop,
against 44 cm and 7.4 m uncapped.

## The loop ride

The cap is a statement in **velocity**, and it is only half the loop's descent.

A rolling ball leaves every ascent frame at a normal velocity of exactly 0.000: the cap sees to that, and it is right to.
What lifts it anyway is the contact solve's **positional** correction, which tracks the ball's own silhouette to 0.02 mm all the way to the lug's bottom-dead-centre.
That silhouette is the support function of the ball-and-loop union, `BallPlayer.loopExcess`: `max(0, loopArm·cos θ + LOOP_RADIUS − radius)`, a 35 mm lug standing over an otherwise circular ball for the 84.4° of each turn where the loop reaches past the rim.

Past bottom-dead-centre the loop turns **away** from the surface faster than gravity can drop a 52 kg ball - 2.45 m/s of profile against gravity's 0.163 a frame, at the aim's ordinary 27 rad/s.
The overlap vanishes, no contact is gathered, and nothing holds the ball to its own silhouette: it free-falls the 35 mm instead, `sqrt(2h/g)` = 5.1 frames, once per revolution.
24% of `session-105f`'s frames with no contact at all, so no `applySteeringGrip` and no sideways drive, in runs of four - read from the game as the ball's acceleration cutting out every time it comes round.
The free-fall time does not depend on the spin (it is a fall from 35 mm) but the **fraction of a revolution** does, which is why it is a fast wind-up that feels broken and a slow roll that does not.

`BallPlayer.applyLoopRide` owns the descent, and owns it the way the ascent already happens: as **position**, with the velocity left where it was found.
It is called from `RigidBody2D.preContactStep`, a hook `World.integrate` runs after the rotation step and before the contact gather.
That window is the whole thing and is not interchangeable with either side of it: run before `integrate` and the rotation it answers has not happened; run after the solve and the frame's contacts have already been decided against a pose the ball was not going to keep - which is exactly the difference between rolling and hopping.

Four pieces make it work, and each of them was a bug first.

The ride **places** the ball on `loopExcess` and never lifts it: raising is the solve's, and taking it would put the ride in the business of raising a ball off its own kinematic spin, which is the cap's whole subject.
Where the ball stands is **measured**, not assumed - the clearance the ride left it at last frame, plus the projection of everything that has moved it since.
Assumed instead, the ride's two halves both descend, the same centimetres are spent twice, the ball ends a frame 1.6 mm under its rim, and the depenetration sweep lifts it back out along the **loop**: 2.2 mm high once a revolution, compounding, until it is floating clear of the floor with nothing under it at all.

It also writes the profile's own **rate** along the normal, and this is not the same job as the placement.
Placed but not tracking, the solver reads a contact point separating at the loop's full `ω × r`, and a separating contact carries no load - no normal impulse, no Coulomb cone, no grip.
A ball perfectly on its own profile and still not driving is the bug this exists to fix, arriving as a silent zero rather than as a hop.
The rate is taken **analytically**, `ω · (n × loopDir) · loopArm`, the support function differentiated: a finite difference of `loopExcess` over the step is a chord of the arc, and 0.42 m/s of chord error was enough to make the loop read as separating on the sharpest frame of each revolution.
Gravity's step stays on top of it, because that step is the whole of what a resting contact answers and what sizes its cone.
And it is floored at the rim plus a contact skin: unfloored, the ball reached the rim carrying the profile's 2.1 m/s, which is over `RESTITUTION_THRESHOLD`, and 0.15 of it came back as a bounce - the hop again, wearing the ride's clothes.

The rate is written on the **descent only**.
Writing the rise as velocity would hand the ball up to 2.45 m/s of outgoing normal speed for its own kinematic spin, which is precisely what the cap refuses - and the cap, running later in the frame, takes it straight back off.

The ride ends by setting the ball **down** on its rim and handing the normal velocity back, in that order.
Returning before the placement left the ball wherever the last frame's tracking had reached: 6.4 mm short of the floor at 45 rad/s, a two-frame hop at the end of every ride.
Handing the velocity back before the gather is what keeps the frame the rim takes over from reading the tracking speed as an **approach**: solved as one it is up to 2.45 m/s of `vnKilled` sizing a cone, and the ball is spinning kinematically, so that cone is spent driving - the fabricated traction `spinFabricatedNormal` and the ceiling case exist to refuse, arriving once a revolution.
It is handed back only when the ride actually tracked, because a ride that never had to write has nothing to give back and handing it an opinion anyway reaches past the mechanic (0.42 m/s of `roll-unfunded` in `session-726f`, 8.3 m/s of `rope-solve-kick` in `session-611f`).
Subtracting the written term instead is the other tempting answer and it is worse: by the time a ride ends the solve and gravity have both had their say on it, so taking the whole of it out again is a kick **upward** - 61 airborne frames at 8 rad/s, where setting leaves none.

Three gates decide what may be ridden, and all three are about not fabricating load.

A ride is taken only while the loop is on its way **in** to a surface that was already carrying the ball two frames running - the first half is what separates a ball rolling onto its loop from one landing on it, the second is what stops a ride being picked up halfway down something it never rode up.

The surface must **carry the ball's weight**: `restsOn`, at least half of gravity along the normal, which is every slope out to 60° and no wall at all.
Against a wall the ball has no weight pressing it on, so every newton the wall pushes back with would be the spin's own doing - the same fault `spinFabricatedNormal` refuses, arriving by another door.
Unfenced it climbed 148 cm at 20 rad/s on `loop-wall`'s frictionless floor against an 8 cm bar, and 1.20 m on `ball-roll-wall` against 0.15.
The line is drawn on the **normal** and not on stiction, which is the tempting one-line test (`applySteeringGrip` asks exactly that): the arena's 32° ramp sits a degree and a half past `STATIC_FRICTION`'s breakaway, so a ball rolling down it was refused a ride while carrying 85% of its weight on the surface, and hopped down the slope exactly as before.

An **attached chain switches the regime off** entirely (`constraintTethered`), exactly as it does for the spin-traction cap - and a dangling tip is not one, for the same reason (see above).
A ride is a statement about a ball rolling on the ground; a chain gone taut is the one thing in the game that owns where the ball is instead, and the winch budget, the unwind and the lease are what police that era.
A ride laid over the top of it is a second author of the same quantity, and it read as both bugs it could.

Finally, a ride may only ever write what a ride is **worth** - the fastest the profile can move at this spin, plus a step of gravity either side.
Asked for more, the ball is not rolling on that surface and the ride sits the frame out rather than overruling whatever is.
It sits out rather than releasing, because a bound this close to the mechanic's own scale will clip a real ride now and then and a release cannot be undone until the loop comes round again.

`cli contacts` `loop-ride` is the detector, and it asks three things of the same scene at four spins and eight phases each: the ball never leaves the ground, never stands higher than its own lug, and never puts the lug through the floor.
Deleting the loop's collision passes the first two and fails the third; leaving it alone passes the last two and fails the first.
It is green at 0 airborne frames of 1440 everywhere out to 45 rad/s, which is where the aim's proportional gain caps the spin, against 261/353/623 before.
The load-bearing bar is separate and looser, and the gap between them is the honest residue of the profile's corner: on the frame it falls faster than what is left of the lug the ball is held to the rim, so the loop grazes at exactly zero depth while turning away - touching, and carrying nothing.
23 frames of 1440 at 27 rad/s, against 328.
Past the aim's range it degrades rather than breaking: at 90 rad/s the window is one frame wide and the ball still leaves the floor for 623 of 1440, against 1049.


## The rolling entry

A spawn may say that the run OPENS with the ball rolling in from off to one side, rather than standing where the level put it (`SpawnData.roll`, an offset along x from the spawn).
The ball is placed at that offset, rolls to the spawn, and until it arrives the player's aim and deploy do nothing: the cursor is not drawn and the chain cannot be thrown.
`BallLevel.startRolling` places it, `stepEntry` decides each frame whether the entry is still running, and `playerInput` is the gate - see [**level-format**](level-format.md) for the field and [**level-design**](level-design.md) for how a level is authored around one.

**The gate lives in the sim, not in the input source**, so every way of driving a frame meets it: a browser, a scripted playtest, and a replay of a recording made in either.
It drops the aim by answering with the ball's own position, which is the "not aiming" sentinel a released stick already sends (`BallPlayer.resolveInput`), so the entry is not a new state for the controller to know about - it is the state it is already in when nobody is aiming.
`cli entry`'s `entry-hands-off` is the claim, and it is made the only way it can be: the ball's whole path under a whirling aim with the button held is **bit-identical** to the same run under a neutral input, and the two are metres apart by the end once the hand-over has happened.

**The camera stands at the spawn for the whole entry** and takes the ball over where it arrives (`BallLevel.cameraRenderPosition`, and `cameraPosition` for the rules and the overlay).
A camera that followed the entry would hold the ball in the middle of the screen for the whole of it, which is a ball rolling on the spot in front of a sliding level: the entry only reads as an entry if the frame stands still and the ball comes into it.
Standing where the ball will arrive is also what makes the hand-over invisible - the camera is already looking at the point the ball reaches, so the target it takes over is a couple of centimetres from the one it was holding, well inside the follow's own ease.
The rule set is evaluated at that point too, which is the right reading of it: what a region frames during the entry is the room the ball is arriving in, not the one it is passing through on the way.
It is the camera's ordinary machinery seeing a different anchor, so nothing here is a rule, a priority or a blend of its own.

**The entry's speed is held for as long as it runs** (`ENTRY_SPEED`, 1.5 m/s - a walk, for a 52 kg cast-iron ball trundling in under its own weight), rather than being given to the ball once at build, and the measurement is why.
A ball shoved along a flat floor and left to coast stops in **34 cm** from 1.5 m/s, in 1.83 m from 3 and in 2.64 m from 5, because it climbs its own mounting lug once a revolution and spends the frames after bottom-dead-centre in free fall (see [the loop ride](#the-loop-ride) above).
Every offset that could put the ball off the side of the standing frame is further than a coast survives, so a coasted entry stops in plain view and hands the player a ball that is already still - which is the one thing an opening must not do.
Held, the entry arrives from any authored distance at the same pace, and hands over a ball that is still rolling.
It is held along **x only** - falling onto the floor, climbing the lug and being stopped by what stands in the way are the world's, as they always were, which is what makes an entry authored into a wall something that visibly happens rather than something smuggled through it.
Being a force the player's stream does not carry, it disarms the energy invariant for its frames exactly as the winch and the trampoline do (`EnergyMonitor.push`).

**It ends on arrival, or when it stops arriving.**
The arrival test is a crossing of the spawn's x taken at the top of a frame, so the hand-over is the first frame at or past the spawn and never one before it.
The other end is measured as **ground made** rather than as speed, because a held entry cannot be argued out of its speed - only out of its place, by a wall it was authored into or a step it cannot climb: `ENTRY_PROGRESS` (1 cm) not closed in `ENTRY_STUCK_FRAMES` (30) is half a second in which anything still coming would have made three quarters of a metre.
A spent entry hands over where it stands, because the alternative is a level that never hands the player their ball - the page then looks like a hung tab rather than a broken level.

A button **held** through the hand-over throws nothing: `pressed` is an edge the input source measures against its own last frame, and that edge happened while the ball was not the player's.
The throw costs a fresh press, which is the right price - the alternative is a chain thrown by a hand that was only resting on the mouse.

**The cursor is handed over PARKED**, for the same reason: at its seed, `AIM_SEED_ABOVE` straight above the ball, aimed at and not drawn (`BallInputSource.handOver` → `AimPointer.park`).
The entry drops the aim in the sim, but the input source goes on tracking the mouse through it, and at the hand-over that tracked position would become an aim the player never made - the reticle appearing wherever their hand was resting, with the ball turning to face it on the first frame it was theirs.

It is moved rather than forgotten because **the ball is handed over aiming**.
A cursor with no position is a ball with no aim, which leaves its rotation to the physics: the ball arrives still carrying the entry's roll, climbs its own lug and rocks about half a metre back down it before it settles.
Aimed at the seed, the loop is already pointing where the aim is, so nothing snaps, and the aim's speed-faded brake (see [the steered ball's grip](#the-steered-balls-grip)) stops the ball where it arrived - measured on `CAVE`, at rest with the loop dead vertical.
While it is parked the seed is re-taken every poll, so the cursor rides above the ball instead of sliding out from over it as the camera eases off the spawn onto the avatar (26 cm of ease put the aim 22 degrees off vertical before it did).
The first mouse move, or the first press, takes it over and nothing re-seeds it again.

Windowed there is no virtual cursor to keep - the reticle is the real pointer and is drawn under it on the next move - and what the park buys there is the frames up to that move.

**Four ways a level has no entry**, and the last two are the same thought: no field, a `hang` beside it (a hanging ball has nothing to roll on), a start from a **checkpoint**, and a **▶ Test in the editor**.
Both of those last are places the run is deliberately not being opened - a checkpoint is a place to be dropped into ready to play, and a test is a spot-check of the geometry being edited - and both drop `roll` from the data rather than skipping it in the driver, so the bundle either one exports describes the run that was played (`spawnAtCheckpoint`, `startTest` in `editor/editor.ts`).

`cli entry` is the suite: the placement and the arrival, the hands-off bit-identity, the hand-over, an entry authored into a wall, the camera standing still, and the ways a level has no entry at all.
`playtests/ball-spawn-roll.json` is the same opening as a scripted run, with the aim and the button held from frame 1.
