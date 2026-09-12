# The ball and chain controller

`BALL` is the **default level** (`DEFAULT_LEVEL`), so a bare `/` runs the
**ball & chain controller** — a separate vertical slice
(`classes/ballPlayer.ts`, `level/ballLevel.ts`, `input/ballInput.ts`,
`renderBall`) that shares nothing with the Player state machine. The ball is a
RigidBody2D (rolls via the opt-in `contactFriction` field on RigidBody2D;
default 0 keeps old replays bit-identical). The chain reuses the Rope wrap
solver: its start contact sits on the ball's edge in the ball's local frame, so
it rotates with the ball, winds around it, and applies torque. `World.integrate`
gives every rigid body a `preContactStep` between the rotation step and the
contact gather, and the ball is the only thing in the game that uses it: its
silhouette turns with it, so it settles onto its own support profile there (see
[**The loop ride**](ball-rolling.md#the-loop-ride)). The chain solve
runs *after* `World.integrate` (see `BallLevel.physicsProcess`), and `Rope`
writes its positional correction straight onto a rigid body — only the grapple
avatar sweeps — so the ball frame ends with `World.depenetrateRigid(ball)`, a
position-only push-out of the solid geometry around it, followed by
`Rope.absorbBlockedLength()`. Without the push-out a point-blank anchor on
the far side of a surface hauls the ball a little deeper every frame until it is
buried in the scenery.
"Solid" there means **any** body the world collides with, statics and other
rigid bodies alike — it meant statics only while rects and polygons were never
physics-driven, so static scenery was the only thing a chain could haul the ball
into. A rigid polygon's face is exactly as solid, and left out of the push-out it
produced the launch in `session-1474f`: the ball buried itself ~16 cm into a
rigid polygon over ~20 frames, and the instant it emerged, the wrap path it
should have been taking all along appeared at full size in one frame — half a
metre of length error, which the solver turned straight into a 96 m/s launch.
The `absorbBlockedLength()` call after it is the winch stall (see `Rope`) applied
where the frame *actually* ends: the push-out moves the ball after the chain has
solved, so re-basing only inside the solve left a point-blank anchor over its
length every single frame.
`Rope.unwindOverLength()` runs between the two, and is the reason the stall stays
rare enough to be safe.
The stall lets chain out and never pulls it in, so nothing may sit behind it
feeding it a blocked correction every frame.
What it lets out is a **lease** (`Rope.blockedSlack`), not a payment into
`maxRopeLength`: it is re-derived from the present geometry every frame and
released, at a bounded rate, the moment the block eases.
`Rope.constraintLength` (`maxRopeLength + blockedSlack`) is what the solver
enforces; `maxRopeLength` stays the length the chain actually has, which is what
retract/extend and the growth invariant are about.
That distinction is the whole thing, because a blocked correction is rarely a
one-off.
Paid into the length, each frame's instalment became the baseline the next frame
measured against, so a chain held over its length by something that was not going
away grew by that much *again* every frame, forever.
All it took was gravity's own 2.7 mm integration step being refused by the
surface the ball was resting on: 16 cm of chain per second, out of a ball hanging
perfectly still (`session-537f`).
Held as a lease the same persistent block costs the same fixed slack every frame,
and across the whole ball corpus permanent growth is now exactly zero.
A lease is only a lease if it is **released before the solve**, and for a long
time it was not: the release ran in `absorbBlockedLength`, after a solve that had
already enforced `maxRopeLength + blockedSlack`, so a taut rope ended the frame at
exactly that length, the block was measured as the lease it was already holding,
and `max(blocked, released)` handed it straight back.
Every instalment a momentary block ever bought was therefore permanent, and it
compounded: a ball swinging on a 108 cm chain carried 53 cm of surplus it had
earned in two brief blocks a thousand frames earlier, a chain half again as long
as it said it was, felt as the chain slowly stretching while hanging
(`session-1080f`).
The release now happens in `Rope.beginFrame`, so the constraint the solve enforces
is genuinely shorter and the surplus is given back as the rope reeling in.
It is gated on whether geometry refused the correction on the frame just gone
(`Rope.noteBlockedByGeometry`, reported by `BallLevel` from its push-out normals),
because releasing into a *live* block is not a trial but grinding - the solve
hauls the ball into a surface it is already resting on, the push-out undoes it,
and the lease is re-earned every frame for as long as the block lasts, which
swung a ball wound up under a ceiling twice as wide as it should.
`rope-grew` cannot see any of this, and that is the point of the invariant that
now covers it: growth is measured against the anchoring length, so a lease held at
a constant value grows by nothing and reads as healthy for ever.
`rope-lease-held` is the sharp statement instead - a lease may not outlive the
block that bought it - and it fires on a lease above 2 cm carried for more than
120 consecutive frames on which *nothing was blocking*, which leaves the
legitimately-held case (a chain anchored point-blank behind a surface the ball
rests on, blocked for hundreds of frames, `session-726f`) alone.
The aim steering did: it is *kinematic* (it overwrites `angularVelocity`, so
nothing the solver does can stop the ball winding on more chain than it has).
Winding it on is the point, and while the solve can pay for it by hauling the
ball in towards the anchor it does; the failure is at the end of that, wound all
the way up with the ball against its anchor and nowhere left to be hauled.
There the solve's correction was undone by the push-out, `physicsStep` turned the
correction into velocity, and the stall covered the difference — the ball flicked
itself along the ground and kept rolling around its anchor while `session-475f`'s
18 cm of chain grew to 366 cm and dragged the anchor 3 m across the level.
Rotation is the one correction that is always available (a circle sweeps no new
ground as it turns, so no geometry blocks it and there is nothing to push out of
afterwards) and it is exactly the motion that overspent, so it is what pays — and
only for the part the chain could not afford, which leaves a frame the solver did
settle untouched.
It pays no more than it spent, either: the correction may walk the rotation back
towards where the frame *started* and no further.
And it is charged **only once the chain is attached** — the unwind and the
spin-share rollback above are both gated on the chain end being fixed.
Until the hook lands, the far end is the ball's own quarter-kilo hook: there is no
anchor to protect from the spin's share, pulling that hook in is the whole of what
winding against it can mean, and nothing about the rotation is something anything
in the scene could refuse.
Refusing it anyway is what `session-315f` reported.
A deployed, unattached chain draped over the scenery blocked its own correction,
so the unwind walked the frame's rotation back every frame — the aim demanding
4 rad/s and getting none of it — while the contact solve, which runs *earlier in
the frame*, had already sold that rotation as roll: a gripping contact drives the
ball's centre until the contact point is stationary, so the ball's whole
along-surface velocity was that spin's and it survived the spin being taken back.
The ball crossed 40 cm of the chain-hung platform it was resting on at 0.46 m/s
with its rotation standing still — 3.4 radians' worth of rolling out of 0.3 of
turning — read from the game as the platform turning to ice for as long as the
chain was out.
A ball with an unattached chain deployed now turns exactly as freely as one with
no chain at all, which is what a chain hanging off it should cost.
`roll-unfunded` (see [headless-tooling.md](headless-tooling.md)) is the detector, and the rule it states is the general
form: a rotation the chain refuses may not have funded traction, wherever the
refusal comes from.
The rest of any over-length is not the spin's doing, and charging the spin for it
spins the ball backwards — at the top of a wind-up that is its own runaway, the
correction subtracting angular velocity while the next frame's push-out leaves a
little more over-length, until a ball winding on at +4 rad/s was unwinding itself
at −15 and shedding wraps (`session-394f`).
The search is Newton on `Rope.lengthPerRadian` (±the ball's radius, since the
chain leaves a circle tangentially) with **backtracking**, keeping the best angle
seen rather than the last tried: path length is not monotone in the angle, so one
full step can swing the contact past its tangent point where the rate flips sign,
and undamped it oscillates between two equally bad angles and lands back where it
started.
Bounding the correction leaves the rest of the over-length for the stall, and
what made *that* survivable is the **frame order**.
The rope pays itself velocity for the correction it writes, Δposition over Δt —
a standard PBD velocity update, and honest, but only if the correction is the
last word on where the body ends up.
The push-out used to run *after* it, so it was not: part of the correction was
undone while the credit for it was kept, and a ball hauled into a surface it was
resting against banked a little more speed every frame and dragged its whole
assembly across the level.
That single mistake was found four separate times — `session-394f`,
`session-458f`, `session-431f`, `session-726f` — each time in a new disguise,
and refunding the difference was tried each time and cannot be made to work: the
credit is taken along the correction and has to be handed back along the contact
normal, so a refund big enough to stop the compounding also injects velocity
sideways, and one small enough not to leaves the compounding.
So the push-out runs **first**: the ball is pushed clear at the top of the chain
phase and the rope moves it last.
A rope correction can still bury the ball for one frame; the next frame's leading
push-out clears it before anything measures a length or a velocity against it,
and `BallLevel` closes the phase by setting the ball's velocity to
`velocityBeforeChain + (realised Δposition)/Δt` — the PBD update taken over where
the frame really ends, both push-outs included, so the ball can never bank speed
for a move that was undone and there is nothing to refund.

Ordering fixes *where* the credit is measured; it does not say **how much of it is earned**, and that is a separate question with its own answer.
Δposition over Δt is honest only while the position error being corrected is error the bodies are still MOVING to create, and nothing in the frame guarantees that: the contact solve runs before the chain phase and can cancel the very velocity that put the ball over its length.
A ball falling onto the floor with its chain already taut arrives over-length by the distance gravity integrated, the contact reverses that velocity and pushes the ball back out, and the chain then corrects the 3.5 cm the push-out left - a real error, correctly corrected - and charges the ball 2.1 m/s for motion the contact had already answered for.
The chain sold the same centimetres twice, and a ball that landed at 0.9 m/s left the floor at 3.0 and rose 43 cm (`session-360f` f305, reported as the ball bouncing far too high).
`rope-solve-kick` never saw it: the gain was 2.1 m/s against a 4 m/s bar.

So the credit is **bounded by the constraint's own velocity-level form** (`Rope.creditBound`).
The rope enforces `length <= constraintLength`, and while it is taut the same statement in velocity is `d(length)/dt <= d(constraintLength)/dt`: the solve may remove exactly the rate at which the path is opening and no more.
Both sides are measurable where the credit is paid — the left from the velocities the bodies carry in, through the **same path Jacobian** the position correction already uses (`resolveCorrectionDir` × `calculateMechanicalAdvantage`, per path object), the right from what the frame's own `retract` took out — so this is the constraint rather than a clamp bolted on top of it.
`Rope.clampCredit` then strips whatever inward speed a credit carries past that bound, along the pull direction only; the swing and the push-outs the phase folded in are not the constraint's to refuse.
The **position** correction is untouched, so the chain still holds its length exactly — what changes is only what the frame is charged for it.

Measuring it over the whole path and not the one body is what makes it survive the cases it must not break.
A moving anchor opens the path with the ball standing still, so the bound is positive and the ball is still hauled and still paid; a body's own radial speed would read zero there and starve it.
The **winch** is the one term the Jacobian cannot see - chain wound onto the ball's own rim shortens the free path with nothing moving, and the ball's rotation is kinematic, so it contributes nothing by construction (the same exclusion `calculateTorqueArm` makes) - so `BallLevel` passes its already-measured `chainWinchSpeedBudget` in as an explicit allowance.
Without it the wind-up would be bounded to nothing, which is `session-322f`'s failure.

The bound is deliberately **not** applied in `settleChainBodies`, and the reason is the shape of the quantity rather than an oversight: that credit is the sum of what a whole coupled set did to a body, and a per-chain bound is not a statement about it.
In a rig where a link and the weight under it fall together, neither chain between them opens at all — their relative motion is zero — while the weight's upward credit is funded by the hanger chain above, through the link.
Bounded chain by chain, every body in such a rig is starved and keeps gravity's step: `cli contacts` `chain-order` leans 178 mm instead of 6 and rings instead of settling.
An honest bound there is a coupled velocity solve over the whole set, which does not exist yet.
The solve moves **every** body on the chain's path — so it settles the ball's spin partly by hauling the far end,
and an anchor that is a rigid body keeps whatever it was given.
That is the fourth piece: the spin is a *kinematic* input with no force behind it
and the unwind is about to refuse it anyway, so `BallLevel` measures how much of
the frame's over-length is the spin's (`|Δrotation| × lengthPerRadian` against the
total) and rolls that share of the solve's correction back off everything but the
ball, leaving the unwind to pay for it in rotation.
Hauling the *ball* is untouched: that is the winch, and it is how winding chain
onto yourself pulls you towards the anchor.
Without it a chain anchored to a rigid polygon resting on the floor was fed a
fresh 0.08 m/s every frame and slid 31 cm across the level with the wound-up ball
riding its corner, peaking at 2.5 m/s instead of 0.5 (`session-265f`).
Refusing the spin *before* the solve instead is the tempting simplification and
it is wrong — the solve paying for the spin by winching the ball in is exactly the
winding mechanic, and pre-refusing it cancelled 197 radians of legitimate spin in
a ten-second wind-up and left the ball at zero wraps.

The rollback reaches every body but the ball - save one, the free chain-hung holder, below - and the whole of the difficulty is what the frame then does with the length the rollback re-creates.
Rolling a body back re-breaks a constraint the solve had just satisfied, and that over-length has to be answered by somebody: by the ball's ROTATION through the unwind, or by the ball's POSITION through a second length solve run with every other path body held immovable (`Rope.solveLengthHolding`) - the winch, stated as a solve.
Which is right turns on whether a coupled constraint holds the body.
A free body, a pivot or a sprung mount is answered by the unwind: there the re-break IS the winch's governor, and weakening it is what ran away on `session-136f` and on `whirl-anchor`.
A body a vine joint holds is answered by the winch: the solve split that correction by effective inverse mass against an anchor usually LIGHTER than the 52 kg ball, so the unwind would be refusing most of the player's aim rather than the spin's own excess.

A **free rigid body a scene chain holds** is answered by neither, because for it the rollback's premise is simply false (`BallLevel.keepsHaul`, 2026-09-12).
The premise - that the winding has no force behind it - is a statement about winding the frame REFUSES: wound tight against its anchor, the ball's turn is handed back by the unwind and the anchor must not keep a haul for chain that never wound on.
Winding that is KEPT was hauled in by a tension, and a tension has two ends: the haul that draws the ball up its chain draws the holder down it by the same impulse, split by the effective masses the solve already split it by.
Rolling such a holder back and hauling the ball alone against it treated it as a body of infinite mass on exactly the frames the tension on it was largest.
`session-149f` is the recording: a 21 kg oak plank hung by its middle from a post, the 52 kg ball hooked to one end and winding itself up in free air as the plank swung back at -4 rad/s.
The solve turned the plank toward the ball by 1.3 rad/s a frame and the rollback handed every bit of it back, thirty frames running, while the winch hauled the ball from 2 to 12 m/s round an anchor that would not answer - the plank swung on barely touched and the player was whipped round the end of it (f83-112), and it replayed HEALTHY, the energy monitor disarmed by the aim.
Keeping the coupled share, the same wind-up stops the plank's swing and reverses it, and the ball, sharing its angular momentum with the plank, peaks at 4.3 m/s instead of 12.
Only in FREE AIR, though - while nothing on the chain's path is touching the ball, by this frame's contact solve or by the pair separation that has just run.
The first cut of this kept the share in the wound-tight regime too, on the argument that the pair push-out (`separateBallFromPathBodies`) keeps that regime honest, and `session-193f-lamp` showed it does not: a ball wound tight onto a hung lamp, the aim snapping 0.78 rad in a frame, was hauled 94 mm into the lamp by the solve, the separation split the overlap by effective mass at the CONTACT - a corner, so the lamp took 43 mm and 2.5 m/s straight down against the ball's 37 - and the winch pass hauled the ball straight back in; the lamp ended each frame knocked into the scenery beneath it and the ball credited 2.7 m/s for a haul the lamp had mostly absorbed, 1 to 7.4 m/s in eight frames with the lamp 117 mm inside a static (f152-177).
That is the kinematic spin reaching the anchor through the separation instead of through the solve, which is the whole of what the rollback is for, and the rollback restoring the holder's pre-solve state is what undid the separation's share of it before.
So a holder the ball is riding is rolled back exactly as it always was, and only a holder the ball is hauling on across open air keeps the reaction.
A vine link stays the winch's (a 0.05 kg holder is the limit case, and its whole vine is the coupled sweep's to apportion), and a pivot or a spring mount keeps its governor, so `hung-anchor`, `whirl-anchor`, `ball-steer` and every pivot replay are exactly where they were.
`cli spring` `winch-anchor-load-hung` is the detector and was red on purpose until this landed; `playtests/rigs/hung-plank-wind.json` is the recording's arena as an instrument.

Both halves were found the hard way, in opposite directions.
Excluding constraint-held bodies from the rollback - which is what the vine's arithmetic seemed to ask for - let a hanging anchor keep the whole of a rotation the unwind then refused in full: the aim wound 0.55 rad a frame onto a ball whose net turn was exactly **zero**, the anchor was hauled and paid for the winding every frame of it, and the pair accelerated together from 3 to 25 m/s over 35 frames while the stall lease let the chain out from 1.18 m to 1.80 (`session-215f`, the ball flung across the level on winding up into a body suspended on a chain; `session-265f`'s failure wearing the one mounting that fix did not cover).
Rolling them back with the length simply DROPPED is the opposite error: against a 12.6 kg anchor the ball keeps 19% of the correction and the unwind refuses the other 81% out of the frame's turn, so the wind-up never starts - the cursor was circled twice right round the ball over 65 frames and it gained no wraps at all (`session-190f`, reported as the rotation being fixed in place).
Forgiving the unwind that length instead was measured and is worse again: un-governed, the same wind-up slings the ball at 31 m/s.
Paid by the winch, all three are right at once, and the vine needs no exclusion of its own - a 0.05 kg link is the same arithmetic taken to its limit (`session-1260f`).
Neither session replays as a violation, which is its own finding: the energy monitor disarms on any frame the aim is turning the ball, and that is every frame of both.
`cli contacts` `hung-anchor` is the slingshot detector - the same weight bolted to the ceiling and hung from it, whipped with identical inputs, 1.6 m/s against 8.5 - and `cli vines` `ball-steer` is the aim detector, 5.8 degrees of loop lag against a 45 degree bar.

A **sprung anchor** — a torsion-sprung pivot or a spring mount — is rolled back like every other, and then handed the load it is still carrying as an explicit force, because the rollback's premise splits for it.
A ball winding itself up a chain anchored to a sprung branch is hanging off that branch the whole time, so the plain rollback left the branch at its UNLOADED rest angle with the ball dangling from it, then sprang it past that as the wind-up shortened the chain (`session-454f`, the pivoting log pulled up by a wind-up that should bear down on it).
Weakening the rollback is not the answer, and both weakenings were measured before this landed where it is: the rollback re-breaking the constraint is the winch's GOVERNOR — it is what hands the unwind the length to refuse — and a sprung pivot is the anchor it matters most for, its torque-arm effective mass `arm²/I` sitting near the ball's own while its spring damping is a hundredth of the rate the credit is re-earned at.
Exempted from the rollback entirely, the solve's velocity credit compounded at −2 rad/s per frame into a 13 rad/s whip that buried `session-136f`'s log 733 mm in the wall beside it and slung the ball at 24 m/s; keeping only the position share re-broke nothing, so the unwind refused nothing and the same whip arrived through position at −7 rad/s; bounding the credit by `creditBound` does not hold either, because the bound is computed from the bodies' own velocities and chases the runaway once the pump has polluted them (1.9 → 7.9 rad/s while the credit ran away underneath it).
So the rollback stays whole and the load crosses by the ledge hang's mechanism instead (`applyHangLoad`'s statement, made about the chain): the ball's weight, straight down at the anchor point, scaled by the share the rollback removed — a bounded constant force, which a spring answers with a damped, settled droop, where a velocity credit is answered with a whip.
Two gates decide when the chain is what carries the ball, and the second was found the hard way: the ball must hang BELOW the anchor, with NO loaded contact under it.
Aimed along the anchor-to-ball line instead, the force rotates with a swinging ball and pumps the hinge parametrically — gravity's own constant direction cannot — and applied while the ball rides the body it is wound up to, it is a second, phantom 510 N on top of the contact that is already delivering the weight: over 40 such frames the log wound to −4 rad/s with the ball surfing its tip at 13 m/s and flinging off on release (`session-1010f`).
`cli spring` `winch-load` is the detector, over both sprung kinds: the loaded hold, the slow wind (the body carries the load and never springs past rest), and a wound-tight endgame at a hand-whip pace that must neither whip the body nor fling the ball.
The load half is red alone with the impulse removed (the log springs 0.2 rad past rest with the ball hanging off it); `session-136f` and `session-1010f` are the recorded artifacts.

**A PLAIN pivot is handed the same load**, and the reason it was not already is the reason the wind-up unloaded it.
Once the ball is rising under the previous frame's winch credit its own motion closes the constraint, so the whole of the frame's over-length is the winding's, `spinShare` reads 1 and the rollback strips the anchor's entire share - the hanging ball's weight with it.
A plain pivot had no other path for that weight: its rotation credit saturates at the drive rate (the whirl governor), and where a scene chain holds it `settleChainBodies` re-derives its velocity from the phase's snapshot plus the rotation that survived the rollback, which is none.
So `session-106f`'s pulley disc, spun to 2.4 rad/s by the 52 kg ball hanging off its rim, slowed to a stop and reversed under its counterweight the moment the player began to wind - the harder the wind, the less the anchor felt, the inverse of a chain hauling a weight upward.
The impulse is the rollback share of the weight (a frame with no winding leaves the anchor's share of the correction standing, and its credit carries the load: the disc's kept Δθ/dt measured exactly `m·g·r/(I + m·r²)`), applied where the chain LEAVES the holder rather than at the knot (`Rope.endLoadPoint` - a chain wound round its holder pulls at the tangent beside it, and a weight hung on the far side's knot turns the holder the wrong way past a half turn), and applied AFTER the scene-chain settle, which SETS a held body's velocity and so discarded every impulse laid on it earlier in the phase (measured: +0.075 rad/s a frame arriving and being removed to the last digit in the same frame).
The `hang-load` phase mark is where it lands in `cli trace`.
A FREE rigid holder gets no force here, and the omission is measured: handed the same weight `session-324f`'s 12.6 kg hung weight was spun by up to 7 rad/s a FRAME at the wrap's tangent, fought back by its hanger the frame after, and read 85 J of unforced gain against a 47 J bar, and `session-611f`'s 430 kg floor polygon was tipped into a wound-tight pose whose unwind stalls 25 cm over length.
A steady force stands in for a load only where the holder answers it with a bounded state - a bearing takes the torque, a spring droops - and a free body answers with acceleration the impulse model has no same-frame tension to resist; the honest answer for it is the coupled solve keeping the load's share of the correction, which is the rollback's own machinery - and since 2026-09-12 that is what a free chain-hung holder gets (`keepsHaul`, above): it is not rolled back at all, so its share stands with the weight in it.
`cli spring` `winch-anchor-load` is the detector - the disc alone (against the analytic `m·g·arm/I` per taut frame, zero before the fix: the disc coasted) and the disc with a balancing counterweight on a scene chain (wound against held, the disc running away under the weight before the fix) - and `winch-anchor-load-hung` is the free wheel, `expectedFail` until the coupled solve carried it and green since.
The spring runner carries `expectedFail` with the contact runner's rule: the marker is a pass for the exit code and a failure the day the case passes, which is how that one was retired.

**A PIVOT body as the winch's anchor could be whirled into a slingshot**, and closing that took four coordinated halves, each measured load-bearing on its own.
The measurement that isolates the class (a thin hinged bar the shape of `levels/ball.json`'s pivoting log, the ball anchored to it, the cursor whipped in circles at a turn per 1.5 s for 10 s, identical inputs throughout): a **static** mounting peaks at 2.5 m/s, the same bar on a **pivot** - plain or sprung, wherever on the arm the chain lands - at 35-45 m/s with the bar spun up to 24 rad/s.
The winch's governor assumes winding either hauls the ball to the anchor or is refused by the unwind, and a pivot leaked through every layer of it: the bar co-rotates with the whirl so the chain never winds tight, the solve's rotation credit - `addRotation(Δθ/dt)`, an ADD with nothing to damp it - ratcheted the frictionless bearing to 24 rad/s off a 3.3 rad/s drive, the winding the unwind's window could not refund leased into 1.7 m of free chain on a 1.63 m rope, and the raw winch allowance re-fed the ball's orbit 4-7 m/s of fresh credit every frame.
The four answers, in the order the ablation ranked them: a pivot's rotation credit **saturates at the solve's own drive rate** (`Rope.boundRotationCredit` - the standard PBD velocity update is a SET, not an add, and the bound is the solve's own position correction, so unlike the `creditBound` angular clamp that was tried first it cannot chase the polluted velocities); length the solve paid **by rotating a pivot** and the rollback kept is charged back to the ball's spin through the unwind's forgiveness (`pivotSpinDebt` - free rigid bodies are deliberately not charged, their kept share being real momentum transfer); the stall **lease may only be raised when geometry actually refused something** (this frame's push-out normals - in free air what stands over-length is the spin's, not a surface's); and the **winch allowance is granted only for winding that stayed wound** - the raw budget less what the unwind gave back and what the bearing absorbed, so a wound-tight chain's allowance dies with its winding and a whirl's churn earns nothing.
Legitimate pivot loading is untouched and was measured so: a ball hung from a fin's arm still rotates it and settles, a pendulum swing still yanks it and decays, and the `winch-load` slow wind still hauls and bears down.
`cli spring` `whirl-anchor` is the detector - the elbow rig at four anchor points against its static control, whipped for 10 s - and every one of the four halves reverted alone sends it red (19-24 rad/s whips, 21-53 m/s slings).

**A fifth: the lease may not exceed what geometry actually PUSHED**, and not merely whether it touched.
The gate above asks whether this frame's push-out reported a normal, and the existence of a push-out is not evidence of its size: a ball whirled round the bar it is anchored to GRAZES that bar - a few hundredths of a millimetre of overlap, resolved and re-earned frame after frame - which opened the gate as wide as a wall would.
Past that gate `absorbBlockedLength` charged the whole over-length to the surface, and the whole over-length is what a looser constraint then buys: 3 cm of fresh path a frame, each frame's path measured as the next frame's block, until 1.69 m of chain was flying a 2.19 m path and the ball left at **30.1 m/s** (`whirl-anchor` sprung/tip, which the 53.5 mm manacle tipped over - the same rig at 20 mm banks 4 cm of lease and peaks at 5.5, so the hole was always there and the bigger cuff only found it).
So `BallLevel` measures how far each of its three push-outs actually moved the ball and reports the sum (`Rope.noteGeometryPush`), and the lease may not stand higher than where the frame began plus that.
The bound is exact rather than tuned: translating the ball by `d` can lengthen the path by at most `d`, the coil riding the body rather than paying out. A graze buys a graze's worth, the over-length simply stands, and next frame's solve corrects it like any other length error.
A rope whose caller does not measure a push (every caller but `BallLevel` - the scene chains, the vines, the grapple rope) is left unbounded exactly as before.
Measured across the committed corpus this SHORTENS the stall: the longest run falls from 38 frames to 21 against the invariant's 60, `session-1426f`'s 66 cm lease runaway is gone, and `session-726f` - the legitimate point-blank block, held for hundreds of frames - still earns its 56 cm and drifts less than it did.

**A sixth: the lease is measured against what the surfaces make UNREACHABLE, not against where one solve left the path.**
The push bound says how much a surface pushed; it cannot say whether the push was a refusal or a deflection, and a surface the chain pulls *along* rather than *into* only deflects.
A ball resting on a steep slope with its chain anchored a hand's width up the same slope is hauled along a chain that points 27% into the slope; the push-out hands that 27% back along the normal, and that lengthens the path by 7% of what the solve just took out.
The ball could take that residual out by sliding up the slope, and the next solve would, exactly as it takes out any other length error - but read as a block it was leased, the lease loosened the constraint by that much, the loosened constraint let the ball settle that much lower, and the next frame paid the same residual again.
0.2 mm of chain a frame out of a ball doing nothing but resting against a wall: 7 cm of chain had doubled by frame 483 of `session-483f`, and the rig that isolates it let out 20 cm in 600 frames (`ball-slope-rest`, which asserts the growth away).
It is not a regression - the mechanism reproduces on every commit back to 2026-08-25 - but the lease's own premise, "a correction a surface would not let through", applied to a surface that let it through sideways.
So `BallLevel` names the surfaces (`LengthRefusal`: the push-out normals, and the ball they pushed), and `Rope.unreachableShortening` asks what the ball's free span can still lose by moving in a direction none of those normals forbid: to first order, the span can be brought down to its perpendicular distance from the best allowed direction, `s · sqrt(1 - (p · d)²)`.
Point-blank, nothing along the surface shortens the span and the whole over-length is refused, which is the lease exactly as it was; on the slope the span can be closed by sliding, nothing is refused, and the residual stands for the next solve.
The same number is what `noteBlockedByGeometry` now reports, so a lease held against a surface that was only deflecting the solve is released like any other, rather than held for as long as the ball touches it.
A caller that names no surfaces (every caller but `BallLevel`) keeps the whole over-length as its refusal, exactly as before.

**Saturation alone starves a HARD RADIAL YANK**, and the impulse-pair allowance is the other half of the credit's statement.
A ball falling onto a chain anchored to a sprung pivot spins the branch to the drive rate in the arrest's first frames, and from then on each frame's Δθ/dt sits under the spin already earned: the credit clamps to zero while the ball goes on paying real momentum through the same constraint - 0.4-1.1 m/s a frame with the branch credited nothing, Newton's third law severed, 83% of a 2.76 kJ arrival destroyed against an inelastic-jerk ceiling of 28% (`session-209f` f66-70, felt as the branch giving no backlash at the bottom of the arc).
So the pivot may always receive up to the REACTION of the impulse the pass actually paid the other bodies (`Rope.boundRotationCredit`'s `reactionDw`, computed in the credit loop): momentum pairing, which cannot mint - the payer measurably lost what the pivot gains.
Three bounds keep it out of the whirl's hands, and the first is the load-bearing one: a body pays only while receding FASTER than `PAIR_SNAP_MIN_RECESSION` (2.5 m/s) - a snap is fast, the whirl's per-cycle churn runs 0.8-1.6 and a hanging ball's gravity bite 0.16, so neither ever seeds the bearing and the orbit stays at its governed baseline.
Discriminators derived from the aim were both tried first and both read exactly wrong: realized winding is ZERO in a whirl (the bar co-rotates, so the chain never coils) and full in a catch, and the steering snaps the ball's spin to 47 rad/s in an ordinary catch as the ball passes its aim point.
The other two bounds: the paid recession is measured less gravity's own per-frame bite (a hanging ball's static weight reaches a sprung anchor as droop and `applyHangLoad`'s force, never as a velocity trickle - session-136f's rule), and the pairing is inelastic at velocity level too (the tip may be spun up to the payer's receding rate along the pull, never past it).
`cli spring` `yank-catch` is the detector - the drop-through-a-passable-sprung-bar arrest, asserted against the inelastic-jerk energy ceiling and the paired-impulse Δw floor - red with the allowance ablated (1093 J lost of a 511 J ideal) and green with it (803 J); `session-209f` is the committed artifact, and `whirl-anchor` holds the other side of the line.

**A ball HANGING from a sprung pivot is the linear spring's interaction locked to a rotation path**, and two halves make it so - the credit may not refund the spring, and the static load crosses as force.
Hanging still, the ball's per-frame gravity bite is a small position error the solve splits every frame, and the saturation top-up read the torsion spring's own deceleration of the branch as headroom: the spring bit 0.077 rad/s off, the credit handed 0.078 back, and the branch position-marched DOWN at the constant rate of the split - linear, no bounce, straight past a torque balance its spring already out-pulled two to one, and felt as exactly that (`session-333f`, 0.14 rad/s of creep; the march is amplified by the pivot's 1/arm rotation factor wherever the chain runs near-parallel to the hinge-anchor line, which is a wound-tight ball under a down-swung branch).
So the top-up subtracts the restoring Δw the integrate step's own dynamics applied this frame (`RigidBody2D.pivotFrameAccelDw`) - strictly tighter than the bare saturation, so nothing the whirl governor holds is loosened - and, since the credits then no longer stand in for the static load (guarded alone, the branch hovers ABOVE its balance lifting against a weight it never feels), a torsion-sprung holder carries the hanging ball's FULL weight through the `applyHangLoad` mechanism on every hanging frame, not only the winch era's rollback share.
The linear spring body keeps the rollback-share semantics unchanged: its credits are not restoring-guarded and still carry the load, and a second full weight would double it (`chain-load`'s closed form is the detector).
The result is the true statics and the spring's own dynamics: droop to `I·w²·θ* = m·g·armX(θ*)`, an underdamped ring-down at the authored damping, and a settle a hair past the balance (~2ζ·c/ω).
`cli spring` `hang-settle` is the detector, both regimes - the plain hang against its solved torque balance with a decaying ring, and the steep-bar near-parallel geometry against the march - and the ablation table is worth keeping: either half reverted alone is red on `hang-settle` AND on `whirl-anchor` (the two halves are load-bearing for the whirl governor now), and three aim-derived regime gates were tried first and all read wrong (a whirl co-rotates at near-zero relative speed, realized winding is zero in a whirl and full in a catch, and the steering snaps a catching ball's spin to 47 rad/s).
Two failed regime-switch designs (branch-out-of-solve behind velocity gates) are recorded in the session notes so they are not re-tried: every velocity-derived gate flapped on the hang bounce or leaked the whirl.
`session-333f` is the committed artifact; re-simulated, its recorded crawl plays as a live oscillation ringing down to the balance.

The fifth piece is that the frame may not *end* with the chain driving the ball
through a surface.
`World.depenetrateRigid` returns the outward normals it pushed along, and
`BallLevel` cancels any component of the chain phase's derived velocity that
points into one — the same statement as the push-out itself, made in velocity
instead of position.
Leaving it in does not merely look wrong, it powers a drive.
Next frame's `integrate` kills that velocity at the contact and sizes the Coulomb
friction budget from it (`maxImpulse = μ·m·(vnKilled + gravityBite)`), and the
ball is spinning under kinematic aim steering, so the budget is spent *driving*.
A ball held against a ceiling by a taut chain therefore funded its own traction
out of the constraint pulling it up there: +1.2 m/s of Δv per frame, sideways,
which the chain solve then removed and the next frame re-earned.
It slid along the ceiling until it ran out of ceiling, ratcheting 2 mm of chain
out per frame on the way (`session-537f`).
Cancelling it restores the rule the wall case already obeyed: once resting, a
surface gravity does not press the ball into gives no traction, so a spinning
ball cannot climb a wall — or drive along a ceiling.
A constraint is not a force here and may not act like one.

Gravity is, though, and the cancel is bounded because of it.
The ball arrives at that phase already pressing into whatever it rests on —
`integrate` applied gravity and the contact solve does not run again before the
frame ends — so cancelling the component *outright* took gravity's own step with
it, and that step is what a resting contact carries and what the next frame's
Coulomb cone is sized from.
Taken, the contact spent a normal impulse of **0.4** where a chainless one on the
same slope spends **8**, the cone collapsed with it, and a ball resting on a rigid
platform accelerated down a 15° slope at very nearly the full tangential gravity
for as long as the chain stayed anchored: 35 cm in 30 frames, against a free ball
that stops in 15 (`session-291f`).
So the bound is gravity's own per-frame step, and no more than the ball brought
in with it — the rest of the entering approach may be momentum an earlier chain
solve wrote, and refusing that is unchanged.
The ceiling and wall cases are untouched either way, because gravity there points
out of the surface and both bounds are zero.

**Both of those push-out books were written against static geometry, and against a rigid body both halves have to be relative.**
The surface the ball is pushed out of is as often the body it is anchored to, and that body has a velocity of its own along the normal it pushed the ball out along.
The refusal above now measures "into" as the closing rate between the two rather than the ball's world velocity: read in world terms it stripped a ball hauled after an anchor that had just been knocked off at 4.8 m/s of the whole of its 4.2 m/s toward it, every frame, while the solve went on towing it after the anchor in position (`session-307f` f192-194, felt as the ball stopping dead against a block that was running from it).
The push-out itself is the larger half.
The length solve moves every body on the path, split by effective mass, so where the ball rests against the body it is anchored to the solve moves the two INTO each other, and against a light anchor most of the closing is the anchor's: 80% of it for the level's 12.6 kg hung weight under the 52 kg ball.
`World.depenetrateRigid(ball)` then cleared the overlap by moving the ball alone, so the anchor kept its position inside where the ball had been and the velocity the solve credited it for getting there, while the ball, whose books are taken over the phase, was credited the push-out as speed OUT of the anchor.
The two left together, 0.3 to 2.3 m/s of fresh speed a frame, the pair from 1 to 19 m/s in eighteen frames, with the stall lease paying out 3 cm of chain a frame to cover the separation it was being handed as a geometry push (`session-324f` f252-270, the ball and its anchor flung across the level on winding up into the hung weight).
The spin-share rollback cannot reach it, because what it rolls back is the kinematic spin's share of the correction and this over-length is the pair's own motion; `hung-anchor`'s weight is too heavy to show it, and every invariant replayed it HEALTHY, the energy monitor disarmed by the aim.
So the chain phase now clears the ball's overlap with a path body as the pair it is, right after the solve (`BallLevel.separateBallFromPathBodies`): pushed apart along the contact normal, split by effective mass with the body's rotation about the contact in the split, and the body debited the velocity for its share, which is the same PBD velocity update the ball gets over the phase.
Each body is pushed back by the share it was hauled in by, so a ball wound all the way up to a hanging weight sits at the weight's edge with neither of them credited anything: the chain's tension on the weight and the contact's reaction to it are one force seen from its two ends.
Rotation is in the split because the anchor point is on the body's rim, and a translation-only push leaves a light body's turn into the ball and its credit standing, which is the pivot whip by another door.
Only path bodies, because only those did the solve move; the winch pass hauls the ball alone by construction and its overlap is left to the one-sided push-out that follows, since splitting a haul the kinematic spin paid for would hand the spin the anchor's momentum.
Holding the body still for the solve instead, immovable as the winch pass holds it, was tried first and is too coarse: it also stops the chain resisting the body's ROTATION while the ball rides it, so a hung weight turning under a wound-tight ball carried 11 cm of length error the solve was forbidden to correct and took all of it in one frame as a 28 rad/s whip the instant the contact broke (`session-268f` f124-132), and it starved the stall lease in every point-blank crush session in the corpus.
`rope-push-credit` is the invariant, and it is a statement about persistence rather than size: the unwind turning the ball's mounting loop into the scenery is cleared and credited in one frame at up to 2.2 m/s across the corpus, under the pump's per-frame credit, but a pump is re-earned for as long as its cause lasts (18 consecutive frames on `session-324f`, 11 on `session-307f`, never more than 2 anywhere else), so it fires on speed out of a pushed-out surface, relative to that surface, carried for more than 6 frames running.
`session-324f`, `session-307f` and `session-236f` (the same weight, 14 m/s with a 50 cm lease) are the committed artifacts, all three recorded on the pre-fix tree and red on it under `rope-push-credit`.
Three more things came out of replaying what was recorded on that tree, each with its own artifact.
**A push-out has a depth, and float noise is one.**
The leading push-out leaves the ball at exactly zero depth against what it rests on, and the same pair re-measures 1e-17 m deep on one machine and clear on another; read as a refusal, that held the stall lease for a frame the browser released (8.3 mm of chain the two never agreed on again, `session-154f` f89-90) and stripped 1.1 m/s the browser kept (`session-345f` f196), so every bundle recorded in the browser replayed as diverged.
`PushOut` now carries its depth and the chain phase ignores anything under `PUSH_OUT_MIN_DEPTH`, a micron.
**The length solve may not lengthen the path.**
Its step is sized by the whole error along the first span's direction, and on a chain coiled tight onto the ball that is not the path's gradient: the direction flipped every iteration while the anchor turned the same way each time, and ten iterations spun the 12.6 kg weight fourteen turns in one frame, wrapped the chain around it into a 3.8 m path, and the winch hauled the ball 1.2 m after it - a 93 m/s launch out of a 27 cm error (`session-239f` f192, replayed).
An iteration that ends longer than it began is undone and retried at half the step, down to a sixty-fourth, and only then does the pass end with the over-length standing for the unwind and the lease, as a correction geometry refuses always was.
Undoing it outright was the first version and it abandons the constraint exactly where it is most needed: on a coil most of the error is coil, which no translation can remove, the free span from the coil to the anchor is millimetres long and the full step carried the ball straight past its anchor into a longer path (124 mm of error to 262, `session-154f` f86-88), so the solve did nothing for four frames and the pair drifted 28 cm over length; halved until it shortens, the translation takes the span's worth and leaves the coil's worth to the unwind, whose it is.
**A turn the chain refunds is not asked for again** (`BallPlayer.windStall`).
The steering is a proportional controller writing angular velocity outright, and a chain wound all the way up refunds the whole turn every frame, so the loop never reached the aim and the same 40 rad/s was written every frame for ever; every phase that runs before the refund saw that spin as real, and the contact solve read the mounting loop, 14 cm out on the rim, as a hammer at 5.5 m/s with infinite inertia behind it - 35 to 41 N·s a frame into the weight the ball rested against, 3 m/s per blow, the ball thrown off its anchor and hauled back by the chain, over and over (`session-154f` f77-82, felt as violent ejection).
Once the unwind gives back 90% or more of a turn while the ball is resting against a body on the chain's path, the steering may turn that way only as far as the chain's own length allows, `maxRopeLength` less the path, with no lease counted, for as long as that contact lasts or until the player aims the other way.
The contact is the whole of the condition: a decaying memory of the refused spin was tried first and converges to demanding half the command every frame, and a latch with no contact in it froze a ball anchored point-blank to the weight but five centimetres clear of it through a 166 degree sweep of the aim (`session-142f` f73-116), where the ball should turn and ride around its anchor as it always did.
`cli contacts` `ball-sparks` `wound` is the detector on the stall itself (37.5 rad/s commanded, zero turned), `session-154f` and `session-239f` are the committed artifacts, and the reel-in whirl is untouched: a ball reeling at a snapped spin toward a weight in free air still peaks at 7 m/s on `session-236f`, which is the winch's own power.
The latch asks for a chain that WINDS, not merely a turn refunded whole.
The unwind refunds whatever of its window the standing over-length asks for, and that over-length is rarely the spin's own - a ball resting against its anchor body carries millimetres of it from the push-out every frame.
So a ball anchored point-blank to a pulley disc with the chain leaving it radially (a spool of 2.6 mm/rad: turning winds nothing) had a 0.5 rad/s ask refunded 100% in radians by 3.5 mm of push-out that had nothing to do with it (`session-287f` f181), and latched on that the steering was dead through a 200 degree sweep of the aim - the rotation frozen by a refusal that refused nothing, because there was nothing to refuse.
The size of the refund is NOT the discriminator, and that was measured before this landed where it is: gating on the refund being worth `CHAIN_TOLERANCE` of chain freed `session-287f` and sent `session-611f` 25 cm over length - the wound-tight endgame there is a coil that has taken the whole chain, the unwind's search failing for 35 frames with 19 cm standing, and a 3 rad/s ask refunded whole (2.7 mm) at a spool of 52 mm/rad was the one thing that stopped the ball winding further.
What separates the two is the spool: the latch requires `lengthPerRadian` at `BallPlayer.STALL_LATCH_SPOOL_SHARE` (a quarter) of the ball's radius, a chain leaving the rim rather than the loop's face.
`cli contacts` `point-blank-turn` is the detector - the recording's rig, a ball thrown point-blank into a heavy pivot disc and resting against it with the chain radial (asserted, at a tenth of the rim), the aim resting near the loop and then sweeping half a turn: with the bare share test the rest frame latches and the sweep turns the ball 0.00 rad, with the spool gate it turns 1.6 and latches only once the sweep has wound the chain to its length.
That endgame's unwind failure - `used 0%` frame after frame with a window to spend and the residual climbing 5 to 20 mm a frame, on a coil of 44 nodes carrying more arc than the chain has length - was a standing weakness the latch papered over until 2026-09-07, when it went red under bun as well (`dmath` took away the libm path that happened to dodge it) and was found to be the coil's, not the search's.
The coil's nodes ride the body, and its last one is the point the rope leaves the rim at - a tangent fixed in the world by the next node, not a material point - so with the anchor sitting ON the rim every candidate rotation slid that point round the rim away from the anchor and lengthened the chord back to it, in either direction, and the search had nothing to improve; `lengthPerRadian` read the sub-0.1 mm span as no spool at all, or as the rim with either sign.
`unwindOverLength` now measures every candidate with the coil brought to it (`syncCoil` at each rotation), `syncCoil` projects an exit point on or inside the circle onto the rim instead of leaving the coil as it stood (the tangent's own limit as the point comes down onto it, so the wind angle is continuous through the rim), and `lengthPerRadian` counts a coil as exactly its radius in the direction that winds and its leaving span as nothing.
`session-611f` replays at 9 mm over length where it stood 26 cm, `session-477f`'s 31 m/s launch reads 6.5, and `cli contacts` `wound-tight` is the rig: a ball wound along the floor into a steel cube it is anchored to at its own height comes to rest on the floor with the anchor on its rim, nothing over length and the steering latched, where the tree before rode it 85 mm up the face on the frames the search stood still.
Two things came out with it.
`cli vines` `ball-steer`'s sweep, 2.5 turns one way on a chain the ball's rim winds up in one, was measuring the wound-out endgame for its last 240 frames and read as steering only because the old coil sync let the vine link pass INSIDE the ball; it now reverses within half a turn of where it began.
And a ball wound out onto a vine link with momentum left swings under it with the link on its rim, and the coil arc the swing changes - the link's rim projection sweeping round while the start point stands - is one no translation of the solve's can see, so up to 14 cm stands over length for the half-swing and comes back on its own; the same coupling of orbit and spin a yo-yo has at the end of its string, and not modelled.
Two things the pair statement uncovered are recorded on the tolerances it moved.
A ball crushed against its own point-blank anchor (`477f`, `726f`, `1426f`, all against 300-430 kg slabs) escapes along the slab faster than a correction aimed mostly INTO it can haul it back, and the lease trails the escape by the push-out it is bounded to; those sessions sat under `rope-over-length`'s 5 cm only while the pump was dragging the slab toward the ball, and a STATIC slab in the same crush measures 14-17 cm on this tree with nothing else in the frame, so that bar is now 25 cm and says what it always meant, the launch class.
And the energy monitor read the aim from the ball's angular velocity at the END of the frame, which a wound-tight chain's unwind sets to exactly zero while the winch has been fed the whole turn: a ball shoving its 294 kg anchor along the floor at a steady 1 m/s² under a held aim replayed as an unforced gain, so the monitor now also reads `BallLevel.aimSpin`, the spin the steering wrote.
