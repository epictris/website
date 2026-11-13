# The contact solver

## Positional recovery

The contact routines in `World.resolveDynamicCollisions` solve **velocity**.
Position is recovered separately, by a scene-wide sweep at the end of the step: `DEPENETRATION_PASSES` passes, each giving every rigid body one `depenetrateRigid` pass.
The pair solver inherits that split unchanged - it changes velocity resolution only - and keeps a per-pair push of its own (`separatePairs`, one push per `(shape, shape)` pair at that pair's deepest point, split by inverse mass so a light body against a heavy one is the one that gives way).
Leaning on the sweep alone is not equivalent, for the reason below: it resolves only the two deepest overlaps per body per pass.
A speculative contact is skipped there - it is not overlapping, and pushing along a negative depth would drag the pair together.

The standard alternative, if `penetration` ever regresses, is a nonlinear Gauss-Seidel position pass over the *same* `ContactConstraint` list - per-contact, correcting only penetration beyond a slop and only a fraction of it per iteration - which is gentler and converges piles the two-deepest heuristic cannot.
It is also, not coincidentally, what would stop the sweep injecting a same-sign positional drift into a settled pile, which is one of the things `stack` is still measuring.

They used to do both, pushing out per `(shape, shape)` pair along that pair's own deepest contact and in ignorance of every other pair.
That is the wedge failure `moveAndCollide` and `depenetrateRigid` were each fixed for, in their own words - pushing fully out of one surface can push straight into another, and whichever pair was handled last wins - and the fix was simply never applied here, so a body touching two things at once could not settle against either.
A slab leaning on another polygon with its lower end on the floor is exactly that wedge, and it stood **165 mm** inside them, buzzing: penetration that deep churns the contact set frame to frame, so the normal impulse fired about one frame in five while contact friction went on torquing the body every frame, and the slab's spin sawtoothed between -0.18 and +0.13 rad/s for as long as it slid (`session-326f`).
The whole polygon corpus now stands at **5 mm or less**.

Four things about the sweep are load-bearing, and each was found by getting it wrong:

- It runs **after** every body's contacts, not at the end of each body's own pass.
  Depenetration is a race - whoever moves last wins the overlap - so a body recovered mid-loop is answering a scene that is still half-solved, and a heavier or simply later-listed neighbour walks through it.
  Interleaved, a falling slab drove the ball a quarter of a metre into the floor; swept afterwards, the two settle against each other.
- It is **every** rigid body, not only the vertex-shaped ones the bug was visible on, for the same reason: granting the iterated whole-body solve to the polygons alone let them out-muscle the ball by 34 cm.
- The per-pair push-outs are **kept**. Leaning on the sweep alone is not equivalent, since it resolves only the two deepest overlaps per pass, and removing them left the ball 240 mm inside the ground.
- A gripped body's **`stickAnchor` rides along with whatever the sweep moves it by**.
  The anchor is a positional constraint of its own - it is where the surface had hold, and the grip pins the body's along-surface position to it - so putting the position solve after the contact pass took the last word away from it, and the two fought: the grip dragged the body back to an anchor the sweep had already found to be inside something, the sweep pushed it back out, and a polygon resting perfectly still on the floor buzzed **49 mm** back and forth for as long as it sat there (`session-255f`, now 1.2 mm).
  Carrying the anchor with the correction does not weaken the grip, because what stiction exists to cancel is the tangential *drift* gravity integrates in one step, and that is measured against the anchor and unaffected by moving both.
  It is the trick the steered-ball coil path already uses, where the anchor advances by the roll the frame intended and only the creep on top is removed.

`depenetrateRigid`'s **crush** branch was the other half.
Two near-opposite faces have no finite simultaneous solve (the denominator explodes as `c → -1`), and the fallback used to resolve the deepest face in full and accept a residual - which is precisely the sequential pushout the simultaneous solve exists to replace, reintroduced in the one branch where both surfaces are certain to be real, and iterated, so the last pass wins and the error compounds.
A ball resting on the floor with a slab landing on it was shoved 33 mm up out of the floor, which buried it 47 mm in the slab, which shoved it 47 mm back down - net deeper than it began, every frame, until it was a quarter of a metre underground.
The two demands are mutually exclusive, so the branch now **equalises** them: move along the deeper normal by half the difference, leaving both faces at the mean depth and a body already centred between them exactly where it is.
Resolving the *static* side in full instead, on the argument that a static surface cannot get out of the way and a rigid one can, is the tempting refinement and it is wrong - it re-buries the body in the rigid face and the next pass pushes it straight back, which is the same ping-pong under a better motive.

## The contact solver

Rigid-vs-rigid contacts go through **`World.solveContacts`**: the sequential impulse solver (Catto, GDC 2006), the formulation Box2D uses and effectively every 2D engine has converged on.
Nothing about these rigid bodies is novel, so the answer to a design question here is "what does Box2D do" unless the rope gives a specific reason otherwise.
The novel mechanic is the rope, and the rope is exactly the part this does not touch: it stays a PBD pass after `World.integrate`, reading the velocities the contact solve leaves.

`collectContacts` flattens the scene into one `ContactConstraint` per manifold point, over **ordered pairs** (`i < j`).
That is the whole point.
The routines this replaced looped over bodies and, for each body, over every other, so the pair A-B was visited **twice** - once with each as the subject - and each visit wrote only to itself and took `RIGID_PAIR_SHARE` of the contact in ignorance of the other.
Two one-sided solves are not an impulse pair: nothing makes them equal and opposite, so momentum was neither conserved nor transferred, and a body landing on another **stopped** it rather than knocking it round (`session-120f`, where the top of two compound groups lands square on the bottom one and the bottom one's spin is cancelled from 0.10 to -0.06 rad/s by the very contact that should have driven it).
One impulse, computed once, applied both ways: `cli contacts` `momentum` went from an error of 2.4e-3 against a 1.5e-8 tolerance to **4.5e-18**, which is machine precision.

Order is a pure function of body index, shape index and point index; nothing is ordered out of a map or a set.
`a` is chosen without reference to list order - the dynamic body, or the lower id when both are - so adding or removing a body mid-run cannot flip an existing pair's roles and miss every warm-start key it has.

Four things about it are load-bearing.

**Warm starting.** Each constraint begins from last frame's accumulated impulses, matched on `(a, b, shapeA, shapeB, featureId)`, applied equal and opposite before the first iteration.
This is not an optimisation. Cold started, the iterations have to re-derive a pile's entire support load from scratch every frame and with any finite budget never quite get there, which is the class of residual-jitter bug the resting-contact work below has been chasing one symptom at a time.
A cached impulse is a *starting guess* and never a claim about state, so a stale entry is simply dropped, a wrong guess costs iterations and not correctness, and the rope rewriting the ball's velocity after the solve does not invalidate it.

**`CONTACT_SLOP`, and why a resting pile has no contacts without it.**
A pile at rest is pushed to exactly zero overlap, and then every body in it falls by the same gravity step - so the interfaces between them never re-penetrate at all.
At a strict "overlap > 0" a resting stack's own contacts *vanish from the set* on the frames it needs them most: the four-box pile's contact count flickered between 0 and 3 of an expected 6, warm starting had nothing to hold across a frame, and the noise from re-deriving the pile every time its contacts flickered back walked it apart across the floor.
Points within the band are kept as **speculative** contacts carrying a *negative* depth; they ask for no impulse unless something is approaching fast enough to close the gap within the step, and above all they persist. The stack now holds 6/6 contacts with 6/6 warm-start hits.
`shapeContacts`'s `slop` defaults to 0, and must: a caller that pushes bodies out along `depth` would otherwise push a separated pair *together*, which is every positional-recovery site.

**A kinematic spin is a conveyor belt, and the cone is the only thing that bounds it.**
A body whose rotation is driven externally (the ball's aim steering, which overwrites `angularVelocity` every frame) has infinite rotational inertia here, because no impulse applied to its spin survives the next frame.
The slip it presents at a contact is therefore an infinite reservoir, and friction reading that slip *is* a motor - which is exactly the mechanic: it is how a steered ball rolls, and it has to work against a rigid body just as it does against the world.
What keeps it honest is that the drive is Coulomb-capped. The ball can spend `mu` times its own weight; a crate's grip on the ground is `mu_s` times the weight of the crate **and** the ball riding it, which is strictly more, so the crate holds.

The tempting fix is to take the kinematic spin out of the friction slip, on the argument that a contact should not read a velocity it cannot affect.
It is wrong, and the two cases pin it from both sides: it makes `spin-drive` pass by making the ball unable to drive **anything**, which is the same statement as being unable to roll along scenery.
A ball spinning at 20 rad/s rolled 49.5 m along a static floor and **0.0 cm** along the identical floor made of scenery (`session-314f`).
`roll-drive` asserts the two agree; `spin-drive` asserts the crate still holds. Neither can be satisfied by weakening the other.

**Only contacts that pushed back count as contact.**
`contactDamp` is applied once per body per frame, to the bodies that met something - and a speculative contact carries no impulse, so it is not something met.
Damping a body for being merely *near* another is a permanent brake on something that is not touching anything: a ball hanging on a chain a centimetre clear of a crate was slowed 2% every frame, the chain read that refusal as a block, and the winch stall paid out slack against it for ever - 1.7 m of chain grown to 3.7 and never released.
On a running conveyor the drag is taken relative to the belt's surface velocity rather than toward rest, or a belt could never carry anything at its own speed (see [**The drag is relative to the belt**](conveyors.md#the-drag-is-relative-to-the-belt)).

**Static contacts are in the same list.**
They enter as one-sided constraints with zero inverse mass and inertia, which is what lets one solver handle both without a branch - and it is not a tidiness argument, it is the difference between a pile converging and not.
A load path runs *through* a static contact: a four-box pile carries the top box's weight down to the floor and the floor's reaction back up. Solved in two separate systems, the bottom box is pressed on by the box above while the pair solve believes it is unsupported, and the floor corrects it only afterwards - so the error reverses every frame and sawtooths. The pile sheared apart and landed spread over a metre and a half of floor, a triangle resting on the floor held a 0.203 deg limit cycle for ever, and two compound groups leaning on each other jittered at 0.033 rad/s indefinitely while the ball resting on one of them was ratcheted 13 cm downhill by the vibration (`session-298f`).
In one system all three settle to **exactly zero**.
That the answer now responds to `VELOCITY_ITERATIONS` at all is the tell: while the systems were split, 8, 32 and 128 iterations landed within 5 cm of each other.

**No contact stays out**, and the last one that did was a load path.
A circle against static geometry used to be solved whole by `resolveRigidCircle` - normal, friction, grip and pin - in its own pass after the constraint solve.
So a rigid slab resting on the ball was solved against a ball the solver believed was free to move, because the floor holding that ball up was in the other system: the slab pressed, the ball gave way on paper, the circle pass then stopped the ball against the floor, and the slab kept a permanent **0.229 m/s** into a ball that was going nowhere, for as long as it sat there, with the depenetration sweep quietly absorbing the difference every frame.
It is the same argument as the four-box pile, one shape kind later, and it was found by `cli query` on the `ball-wedge` mechanic scene rather than by anything going visibly wrong.
Folded in, that slab reads exactly zero.
What is left of the circle path is `applySteeringGrip`, which is not a contact solve: the aim steering drives the ball's rotation kinematically, with full authority and no force behind it, so the roll it implies is written as a velocity after the solve and cannot be expressed as an impulse the cone would cap.
Vertex shapes have no such path left either: `applyStaticGrip` is all that remains of `resolveRigidLoop`, and it is only the position pin.
The *velocity* half of stiction is gone, because it was always a Coulomb-capped tangential impulse solved at the contact points, which is exactly what the tangential constraint is; keeping a second copy would apply friction twice.
What no velocity constraint can remove is gravity's per-frame integration *step*, since this engine integrates before it solves - so the pin stays, as the honest patch for that ordering rather than as a leftover.

## A compound body's surface, not its pieces'

A concave outline is cut into convex pieces at load, and each piece has faces and corners the body does not: the **seams** where it meets its siblings (`CollisionShape2D.isFaceInternal`), and the outline's **reflex corners**, where the surface bends inward and the material round the vertex is more than half a turn (`isVertexExposed` false).
Neither is anything a moving shape can strike: a seam is inside the body, and a flat face cannot touch a reflex corner on its own, since it would meet a face either side of it first.
Taken as the contact anyway they are the ghost collisions of a compound, the reason Box2D ships chain shapes for terrain.
So the polygon manifold (`loopVsLoop`) never takes a seam as the reference face, and a contact whose deepest point is a corner the incident body does not have is made against the other side's face instead.
The separating-axis test still reads every face: a seam is a real edge of its piece, and the two shapes are as far apart along it as they ever were.

Found on a dangling hook (2026-10-19, `session-599f` f116): resting on a floor that bends up 10°, its bar's corner on the bend, it was made a contact against its own end face with the normal straight back along the floor, and the chain dragging it towards the ball held it there while the ball wound 11 m of coil onto itself.
Against the floor's surface the contact is the slope's face, and the hook rides up it (`cli contacts` `seam-reflex-corner`).

**The other side's face has to be one the shape crosses** (`crossesFace`, 2026-10-25).
Kept off its seams, a piece walled in by siblings may have no face left but its far one, and a shape that pokes across a seam into it lies wholly short of that face: it is inside the piece only by way of the seam, whose far side is the sibling's surface.
`session-141f` f117: a stool resting 3 mm into a terrain's sloped skin had its seat on a reflex corner, 1 mm into the 5 m quad beneath, and every face of that quad but the bottom was a seam.
The bottom was taken, 4.92 m deep and straight down, and the chain phase's push-out (`depenetrateRigid` on the holders) sent the stool through the floor in one frame - the chain then measured 20.7 m against 0.06.
So the fallback is taken only when the shape reaches back out past the face it would be given, and otherwise the first manifold stands; the hook of `session-599f` did cross the slope it was given, by a few millimetres, and still rides it.
The same face is reachable without the fallback: when the shape's own faces all lie deeper still - a stool tipped so that each of its faces sees the 40 m quad's far corners - the quad's bottom is the reference outright (`session-325f` f239, 5.09 m).
So a reference face that was chosen only because the seams were set aside, and that the shape does not cross, is no contact at all: the piece says nothing, and the sibling across the seam makes the contact.
`cli contacts` `seam-fallback-crosses` is the case, one placing for each path: on the old manifold the box is pushed 5.32 m and 5.41 m through the block.
At a reflex corner a circle needs none of this: its one contact is on the nearest feature of the piece, and there that is the bend itself, which a circle can genuinely rest in.

**A circle never leaves a piece through a seam either** (2026-11-13).
It was once thought to need nothing, and that holds only while its centre is outside the body.
Once the centre is inside a piece, the nearest feature can be the seam, and the answer then pushes the circle across into the sibling, whose own nearest feature is the same seam from the other side.
Two pieces each sending the circle into the other make the seam a trap: the depenetration sweep put it back on the seam on every pass and the contact solve held it there.
`session-459f`: the ball's mounting loop stands 35 mm past the rim, and the swept step stops only the rim (`integrateContinuous`), so a loop struck into rock ends up with its centre inside it.
A sliver of rock in `ball.json`, cut into two pieces along its length, is 5 cm thick where the ball struck it at 4.8 m/s, and the loop came to rest with its centre on the seam (to 0.1 mm, frame after frame).
The ball hung on the rock with 875 N·s a frame pressing either way - a hundred times its weight - from f306 to the end of the run, and `contact-load-runaway` caught it at f455.
So when the face a circle would leave a seamed piece by is a seam - the shallowest plane from inside, or the inside of the seam edge as the nearest point from outside - it is pushed out of the **body** instead: to the nearest point of the body's surface, every non-seam face of every piece (`CollisionShape2D.surfaceExit`).
The nearest way out can be a sibling's face: 3 mm past that seam the loop reached neither half's own outer face, and a piece-only rule (the circle form of `crossesFace`) left the rock saying nothing at all.
One piece answers for the body, the first-mounted one containing the centre, so a circle on a seam is one push and not two.
Both paths ask it: the contact manifold (`loopVsCircle`) and the overlap query the depenetration sweep and the character sweep use (`circleOverlap`, rect pieces included).
A circle that never meets a seam is answered exactly as before; the seam ends are corners, which a circle meets as it always did.
`cli contacts` `seam-circle` is the case: the sliver as the level builds it, a loop-sized circle on the seam at the two frames the ball hung, and 3 mm either side, each required to be pushed out of the face it came in by and be clear of the rock after one depenetration call.
On the old answer the manifold pushed it 176 degrees the wrong way and the recovery moved it 3 mm, back onto the seam.

## Trampolines: bounce and launch

A surface states how it throws back what meets it with two body properties, `restitution` and `launchSpeed` (authored as `bounce` and `launch`), read off both sides of a contact with the larger winning.
`contactBounce` (`engine/bounce.ts`) turns them into the outgoing normal speed a contact is solved to, and every solver that meets a launch surface asks it: the world's one-pass solve (`World.solveContacts`), the tied-chain island (`TieSolver`, `applyRestitution`), the ball's loop cap and the hook's deflection.

**Restitution is a ratio** and has the usual dead zone: below `RESTITUTION_THRESHOLD` (1 m/s of approach) it gives nothing back, so a body resting on a lively floor does not hum on the velocity gravity re-adds each frame.

**A launch is the speed it throws the ball, and nothing may rest on it.**
Any contact that touches a launch surface leaves at the full throw, however it arrived - dropped 2 mm or 2 m, resting, already leaving slowly, or hanging on the ball's chain.
There is no dead zone and no ramp.

**What a pad throws depends on what it throws** (since 2026-11-12).
Every pad in `ball.json` was tuned with the ball as the only thing that would touch it, so `launch` means the speed the pad throws the ball.
The pad's face is a mass, `LAUNCH_FACE_MASS` (the iron ball's 52.1 kg), moving out at `launch`, and what it gives a body of effective mass `m` at the contact is an elastic hit from that face with the body at rest: `2·M·launch / (M + m)` (`launchThrow`, `engine/bounce.ts`).
The ball leaves at exactly `launch`; a 105 kg root at 0.66x; a 33 kg root segment about 1.2x; the 1.7 kg cuff at 1.94x, and nothing past 2x.
`m` is the contact's inverse effective mass along the normal as each solve computes it, both bodies, lever arms included.
The arrival is never the face's: an elastic hit off a face always moving at `launch` hands a body lighter than the face up to `2·launch` more on every bounce, and a link bouncing on a pad would pump itself without limit, so the face throws from rest and the arrival is the restitution's.
Until then a launch was a speed floor for everything, and `session-406f`'s 33 kg root segment, hinged to a static, came off a mushroom at the ball's 6.5 m/s at the contact, solved against its free-body mass.
The island pays a launch after its substeps, against each contact's free-body mass, so a jointed body is thrown as if it were loose and its joints take the excess back the next frame.
An impulse is what survives that: a hinge's reaction acts through the hinge point and cannot touch the angular momentum the throw gave the body about it.
With its chain let go just before the bounce, the segment now leaves at 10.9 rad/s (660 J), where it left at 9.0 (440 J).
With the ball still hanging from it, most of either throw goes into yanking the ball up through the chain: 3.3 rad/s against 2.7.
Until 2026-11-06 the launch faded in between 1 and 2 m/s of approach so a body could settle on a pad, and the ball dropping 8 cm onto one left at 1.7 m/s where a 25 cm drop left at 10 (`session-188f` f42 against f135).

"Touches" is each solver's own question:

- The world solve pays a contact that is touching (depth >= 0) or a speculative one closing its gap within the step, and solves it to the launch itself without the gap taken off.
  With the gap subtracted, the throw depended on where in the step the body met the pad: `session-188f` f42 left 0.54 m/s short off a 9 mm gap.
  A speculative contact that will not close is not paid, or a body would be thrown off a surface up to `CONTACT_SLOP` away.
- The island pays any contact row that carried load in its substeps (`maxN > 0`), after them, as Box2D applies restitution.
  The ball's contacts are the island's whenever its chain is anchored, and before the island knew of launches a ball swung into a pad on its chain came to rest against it (`session-68f` f56-68).

**The hook glances off a launch surface** as it does off a hook-proof one (`hookDeflects`, see [hook-surfaces](hook-surfaces.md)): every attach path declines it, and its deflection sets the normal speed to the pad's throw for the hook's mass (1.94x the launch) and keeps the tangential, where a hook-proof face scales the reflection by how glancing the hit was.
A dangling tip lying on a pad is thrown by the probe however slowly it is moving.
The strike is heard (the bounce sound event) but strikes no sparks, which are hook-proof steel's.

A launch does work out of a spring the sim does not model, so a frame that pays one sets `World.launchedThisFrame` (the island through `TieSolver.launched`) and the energy invariant stands down for it.
Every path is gated on `launchSpeed > 0`, so a level without a launch replays bit-identically.
`cli contacts` `trampoline` holds the ratio, the speed, the 2 mm and 8 cm drops and the hook; `playtests/ball-trampoline-no-rest.json` and `ball-trampoline-hang.json` hold a ball set on a pad and a ball hanging against one.

## Resting contacts

A manifold's normal impulses are solved as **one system**: accumulated per point, iterated `NORMAL_SOLVER_ITERATIONS` times on the static path (`VELOCITY_ITERATIONS`, Box2D's 8, over the scene-wide constraint list), with each point's *running total* clamped at zero rather than each increment clamped on its own.

Solved once each behind a `vn < 0` gate, the two points of a resting face cannot converge, and the reason is structural rather than a matter of tuning.
Point A's impulse acts through a lever, so it rotates the body and pushes point B in; B's impulse pushes A in; and because neither may ever *pull*, the pass ends with the pair having overshot in opposite directions.
What is left over is a spin, and next frame it returns with the sign flipped.
A polygon lying still on the floor sawtoothed between -0.07 and +0.11 rad/s for as long as it rested there, wobbling about a third of a degree - some millimetres at the end of a long body, which is what reads as vibration (`session-255f`).

**Restitution is gated on the approach speed** (`RESTITUTION_THRESHOLD`, 1 m/s), everywhere and not only in the pair solver.
A resting contact closes at whatever gravity integrated this frame - 0.163 m/s - and bouncing that back is a bounce that never ends.
The ball is 0.15 elastic, and its own contact path had no such gate, so a ball sitting perfectly still on the floor carried a permanent **21 mm/s upward**: it fell 2.7 mm, was thrown back at 24 mm/s, and did it again every frame for as long as it rested.
Nothing moved - the stick anchor pinned the position it was bobbing around - which is exactly why it survived every check the suite had, while putting the scene's at-rest kinetic energy three orders of magnitude above zero (`cli settle` read 1.2e-2 J for a scene where nothing was moving; it now reads 1e-32).

Accumulating is what buys the fix: a later iteration may hand back part of an earlier one, as long as the point's total stays non-negative, so the pair settles on the load split that actually holds the body still instead of each over-correcting for the other.
This is the standard sequential-impulse formulation, and it is the one thing the resting case genuinely needs.
Restitution is taken from the approach velocity measured **before** any of it, never re-derived per iteration - re-applying a bounce to a velocity that already contains it is how an iterated solver invents energy.

Bodies now go properly to sleep: a settled polygon holds `|ω|` around 0.0007 where it used to hold 0.1, a dropped-and-settled pile finishes at exactly zero velocity, and a stack resting on itself wobbles 0.16° / 1.4 mm against 0.28° / 5.7 mm before.

Static friction is **Coulomb-capped**, at `mu_s` times this frame's normal impulse plus gravity's bite - the same quantity the kinetic path caps against, so the two agree about how much load a contact carries.
It is a limited force, and unclamped it supplied whatever was asked, which welds a resting body to the ground: measured at 1.5x to 7x more tangential impulse than friction there could ever have provided (`session-120f`).
A body resting on a slope is unaffected, since its demand is `m*g*sin(theta)` against a cone of `mu_s*m*g*cos(theta)` - it holds exactly while `tan(theta) <= mu_s`, which is the breakaway angle the grip already advertised.
Asking for more than the cone gives means the contact is sliding, so it gets no position pin and does not count as a grip; the clamped impulses are already Coulomb friction at the limit, which is what a sliding contact should feel.

Static friction is otherwise solved the same way as the normal impulses, and is a decision about the **body** rather than about each point - it is one statement about whether this contact is slipping, and the manifold's points share a normal, so asking per point only let one point grip while its twin ran the kinetic path.
Two things about it were wrong and are worth keeping straight.

It used to **overwrite** the body's velocity, which throws away the linear half of the normal impulse the accumulated solve had just computed: that solve splits one impulse into a Δv and a Δω through the coupled effective mass, and discarding the Δv leaves the Δω behind as an unbalanced torque, a few thousandths of a rad/s freshly minted every frame with nothing to answer it.

And it cancelled the velocity of the body's **centre**.
Static friction forbids the *contact* from sliding and says nothing about the centre; a body pivoting about its contact point must have a moving centre, since that motion is precisely what holds the contact point still.
Forcing the centre still while rotation ran free therefore made the contact slide by construction, and the position pin then held the centre while the shape ground through it - a polygon resting on a corner turned 27° over four seconds at a steady creep that neither settled nor fell over (`session-390f`).
Read at the contact points and solved together, a genuine pivot costs nothing, a sliding body is held, and a body wanting to topple spins past `STICK_SPIN` and stops being gripped at all.
That body now holds, topples once at -0.68 rad/s, and settles dead.

The **position pin anchors the contact point too**, not the body's centre - the same correction as above, in position rather than velocity, and it survived the velocity fix for the same reason it was easy to miss there.
A body pivoting about its contact point must move its centre, so holding the centre still is an instruction to slide.
Held that way, a slab settled on one corner had its spin bled off geometrically - 0.021, 0.013, 0.008, 0.005 rad/s, about a third gone every frame - with no contact anywhere near it doing the braking; it simply stopped mid-turn and stood there (`session-1426f`).
The anchor is a **material** point of the body (`stickLocal`, the gripped contact in the body's own frame), not the manifold point itself: that one is geometric and slides along the contacting face as the body settles, so anchoring it directly sent bodies drifting 80 cm *up* a ramp.

The **stick anchor survives a few ungripped frames** (`STICK_RELEASE_FRAMES`) rather than being dropped on the first.
It has to go eventually, or a body that has left the ground snaps back to a stale spot, but the grip flickers: the normal solve leaves a little spin, and every eighth frame or so it crosses `STICK_SPIN` and the gate says no.
Releasing on a single miss re-seeded the anchor wherever the body had drifted to, and the drift is always downhill, so a crate ratcheted 21 cm down a 30° slope it is meant to hold, a few tenths of a millimetre at a time.

Two things were tried first and are worth not repeating.
**Widening the manifold** so a point within a few mm of the surface stays in it does not help: the second corner of a resting face is not flickering at the micron scale, it is genuinely rocking 3-7.6 mm off the ground, so a slop band only moves the threshold the flicker happens at.
**Damping spin inside the stiction grip** is worse than the disease - it is the pose lock in a softer form, stalling a body part-way through a topple and leaving it to creep, and it took a clean settle from 0.2° to 7.8°.

### The position pin

The pin is **relative**, and its anchor is a material point of the SURFACE, held in the surface's own frame.
Against a static that is the same statement as a world-space anchor, since a static never moves; against another rigid body it is the only statement that means anything, and holding one was the missing piece.
A body resting on a rigid body had no pin at all, so it kept the whole of gravity's integration step every frame: the velocity solve cancels the velocity gravity added and never the *step* already taken with it, and the recovery then resolves that step along the contact face - which on an inclined one turns a 2.7 mm fall into 0.6 mm of **sideways** travel.
Nothing accelerated the body into that motion and nothing ever takes it back, so it is a ratchet: slabs slid 53 cm and 66 cm across `255f` and `326f` while reporting velocities of 1e-8 m/s, which is to say invisibly to every check the suite had.
`cli contacts` `rigid-ramp-hold` was the same thing written down as a case, and carried an `expectedFail` marker until this closed it.
The steered ball reached the same gap from the other side and was fixed later, in `applySteeringGrip` rather than here (see [**The steered ball's grip**](ball-rolling.md#the-steered-balls-grip)): it is the one body `applyStaticGrip` declines, so closing the pin for every other body left it as the last one creeping.
Declines while its spin is KINEMATIC: since the spin motor (2026-10-23, [ball-chain](ball-chain.md#the-spin-motor-branch-torque-spin-2026-10-23-unplayed)) the ball never is, so it holds this pin like any other body and `applySteeringGrip` does not run for it.

Four things make a relative pin friction rather than a weld, and each of them was a red case first:

- **Coulomb, in position.** The correction is capped at `mu_s` times the normal impulse the contact actually carried this frame, as a displacement: `mu*Pn*(1/m_eff)*dt`. Uncapped, a pin whose anchor had gone stale hauled a struck slab 200 mm *inside* the body that struck it.
- **Asking for more than the cone allows means it slipped**, so the capped correction is applied and the anchor is re-seeded where the body now is. Remembering the excess is the pin hauling a body toward a place it slid away from frames ago - 3 mm of positional work per frame in `298f`, which the energy invariant reads (correctly) as 17 J invented out of nothing.
- **Split by inverse mass, applied to both bodies**, so a light body on a heavy one is the one that gives way.
- **A contact is offered a pin by what it CARRIED, never by its depth.** The gather's depth
  is float noise on a resting interface (the solve pushes it to exactly zero) and
  systematically non-positive for a CCD body, which is seated at exact touch every frame -
  the hook is `continuous`, so the old `depth > 0` gate refused its resting contact the grip
  for ever and it slid down the shallowest slope. `normalImpulse > 0` is the honest test,
  the same lesson `steered-ramp-hold` taught the steered grip.
- **One pin per body, to whichever surface carries it** - the pair with the largest normal impulse, offered from *both* sides of every pair. Which body leads a constraint is an id ordering and nothing more, so pinning only the leader pinned whichever of two stacked slabs happened to be built first, and taking the first pair instead of the loaded one let a crate being shoved by a spinning ball anchor itself to the **ball** and let go of the floor (`cli contacts` spin-drive).

The anchor rides along with the **normal** part of what the depenetration sweep moves the body by, and with none of the tangential part.
It has to follow the normal push or the two fight - the grip dragging the body back to an anchor the recovery had just found to be inside something, which buzzed a resting polygon 4 cm back and forth for as long as it sat there (`session-255f`).
Along the surface it is the opposite: the anchor *is* the grip, and carrying it sideways is the same as not being pinned in the direction that moved.

The same holds for **every other surface pressing on the body**, and for a long time the pin knew only its own.
It holds the gap along one face, and a body in a corner is pressed by two: closing the floor's gap can mean driving the body straight back into the wall the contact solve has just pushed it out of.
`session-197f` is the recording: the ball dropped into a floor-and-wall corner with its loop against the wall, the pin anchored along the floor, and every frame the solve pushed the ball out of the wall and the pin put it back, 0.42 mm a frame.
A corner with `mu > 1` holds any internal stress - the floor's friction pressing the body into the wall and the wall's pressing it into the floor balance each other and show up as no velocity at all - and the warm-started solve cannot see that stress to take it back, so the push-out the pin re-earned every frame fed it.
The two contacts climbed 4 N·s a frame, to 531 N·s at f197, sixty times the ball's weight, and friction at that load held the spin motor's full 360 N·m: the ball stuck in the corner, not turning, for as long as the aim pushed.
So the gap the pin may close is taken out of every static surface pressing on the body this frame, and the anchor follows the part taken out, as it follows the depenetration sweep's normal push.
A floor and a wall on one body are one `other` to the pin, so the surfaces are told apart by their normals (`pressing`), and the pin's own face is the one left out (`PIN_OWN_SURFACE`).
Static surfaces only, because a static is the one surface that cannot give way: a body pressing from the other side is a load, and holding against a load's push is what stiction is for.
Counting every pressing body was tried first and took the floor pin away from a rigid ramp whenever the ball on it leaned on it, so ramp and ball slid 6.7 m down the floor together (`steered-ramp-hold`), and the boxes of a pile let go of each other (`stack`).
Should two pressing surfaces at an angle leave the gap nowhere to go, the pin lets the body be for that frame.
`contact-load-runaway` is the detector (see [headless-tooling](headless-tooling.md)).
What the fix does not change is the stress the corner was handed on the frame the ball landed in it: an impact's, which the corner holds as it held the pin's and lets go of only as it decays - `session-197f` still stands for 80 frames before the ball turns again.

`PIN_RELAX` removes 0.15 of the remaining along-surface error per frame rather than all of it, because a pin at full strength fights the recovery hard enough to leave a settled four-box pile spinning at 0.02 rad/s; at 0.15 the pile reads 0.003 and the creep is gone.

Across the corpus this takes settled drift from 529, 662 and 168 mm (`255f`, `326f`, `166f`) to 8, 8 and 16 mm, and what is left is bodies with a real velocity under the scan's threshold rather than bodies moving with none.
