# Sparks

A steel hook striking hook-proof steel throws sparks: a **burst** where it hits, sized by how hard, and a **stream** while it slides along the face, sized by how fast.
A hook resting against one throws nothing, which is the behaviour the whole feature is judged on.

**Sparks never touch the sim.** That is the rule the shape of this follows.
The simulation is deterministic and replayed bit-for-bit, so what crosses the boundary is a per-frame list of **events** (`level/sparkEvents.ts`) - plain contact facts the sim already had in hand, written by the level and never read back by it - and everything else lives in `render/sparks.ts`: the pool, the randomness, the thresholds, the particle physics and the drawing.
No sim constant, body state or digest field changes, and the whole committed bundle corpus replays byte-for-byte with the feature in, which is the test that the boundary held.

`BallLevel.sparkEvents` and `Level.sparkEvents` are **cleared at the top of every `physicsProcess`** rather than when a renderer drains them.
Headless replay (`cli replay`, `cli bundles`, playtests) steps a level with nothing attached, and an append-only list would grow for the length of a bundle; a frame's events live exactly one frame, and a tool that never looks loses nothing.

**One event per hook per frame: the ARRIVAL if one was reported, and otherwise the latest report** (`BallLevel.reportSpark`).
The sources below do not know about each other and two of them fire on the same frame for the same touch, disagreeing about when: `physicsStep` runs before `World.integrate`, so a bounce is taken at the moment of contact while `collectContactSparks` runs after the solve and carries what the frame left behind.
Which of those is wanted depends on what the touch was, and the two cases want opposite answers.

A **continuation** - the hook already riding a face - wants the later report, the bounce there being one frame stale.
In `session-117f` f75 it is a verbatim copy of f74's contact, 0.19 m back along the floor, one frame of travel at 11.5 m/s.
Kept as two events that doubled the slide's spark rate on the frames both fired and spawned the two halves a fifth of a metre apart, which is what made a steady drag read as a series of separate strikes; kept as the bounce it draws every other frame's sparks a frame behind the hook.

An **arrival** - the throw ending on a wall - wants the bounce, and taking the later report there is exactly wrong.
The solver's contact on that frame is the aftermath: `bounce()` has already reflected the hook and scaled what survives by how glancing the hit was, so a shot straight into a face is killed dead and the solver reports the touch at 0.02 m/s of separation where the hook arrived at 11.99.
Read as the whole of the strike, that is a head-on hit into hook-proof steel throwing **no sparks at all**.

`BallHook.registerBounceCallback`'s `fromFlight` is what separates them, and it is the hook's own state rather than a judgement about the velocity - the hook was in free flight, and now it is not.
Once an arrival is recorded for a hook this frame it is final: nothing later in the frame can be a better account of a touch that has already happened, and `bounce()` ends the flight, so there can only be one.
It is deliberately NOT a field on `SparkEvent`, for the reason given below - it settles which of several reports of one touch is accurate, inside the sim, and the render side still receives one event with no field naming the kind of touch.

**The BALL sparks too**, and by both mechanisms: it is cast iron and the surface is hook-proof steel, so it strikes them off on impact and grinds them off when it skids.
Its ARRIVAL is taken from the pose it had BEFORE the contact solve, which is the same correction `BallHook.bounce` makes by reporting its pre-reflection velocity.
`collectContactSparks` runs after `World.integrate`, and by then the solve has cancelled the very approach the sparks are struck by: a ball dropped twelve metres onto hook-proof steel arrives at 15.4 m/s and is reported at 0.11 m/s of closing, under every threshold, so the slam threw nothing at all.
The hook needs no such reconstruction, its own `bounce()` having read the arrival at the moment of contact; the ball's lever arm is measured from where it ENDED the step, a millimetre out on a 12 cm ball and nothing any threshold here can see.

**The velocity is taken AT THE CONTACT POINT, and for the ball that is the whole feature rather than a refinement.**
A rolling ball's contact point is stationary against the ground - that is what rolling is - so `omega x r` cancels its linear velocity there and the slip the render side thresholds on is nothing.
`levels/ball.json`'s terrain is one enormous hook-proof polygon, so the ball is on hook-proof steel on 79 to 99% of the frames of every recording in the corpus, and its measured slip there is a mean of 0.00 to 0.05 m/s: it throws, in total, one particle across three sessions.
Read from `linearVelocity` instead and every ball in the game grinds sparks for as long as it is moving, with no invariant anywhere to notice.
What does spark is a genuine skid - a shove across slick steel throws 844 particles over 227 frames, and the same shove on a grippy floor throws 18 while friction spins it up to rolling and then goes quiet.
It is the honest quantity for the hook too and costs it nothing, a `BallHook` carrying no spin at all (measured at exactly 0 rad/s across the corpus), so one rule serves both.

**Arrivals are tracked PER SOURCE** (`SparkEvent.source`, the reporting body's id), because the ball and its hook can be on hook-proof steel at the same time and the ball very nearly always is.
One counter for the system would read every hook arrival as a continuation of the ball's own grind and fire no burst at all.
The ramp and the fractional carry are per source for the same reason: a hook striking a wall must not inherit how long the ball has been grinding, nor spend the particle the ball's slide was owed.
A source's track is forgotten after `CONTACT_TRACK_TTL` silent steps, which is well past `CONTACT_GAP_FRAMES` so it can never decide whether a touch is an arrival - it only stops the map growing across a session, which mints a fresh hook id on every throw.

Three sources feed it, and each is the one funnel for its case:

- `BallHook.bounce` fires `registerBounceCallback` with the contact point, the surface normal and the **pre-reflection** velocity, behind the same `vn < 0 && speed > BOUNCE_MIN_SPEED` guard the reflection itself sits behind.
  Every impermeable contact the ball's hook has ends there - the flight sweep's hook-proof branch and `probeContact`'s deflection both - so one callback covers all of them.
  That includes the repeated bounces a dangling tip makes while pressed against a wall, which the probe deflects on **every frame**, and those are not a nuisance to be filtered: a tip dragged along hook-proof steel is reported almost entirely through this path, with a normal component of 0.03 m/s and a tangential one running to 3.6, so it is where the SLIDE comes from as much as the bounce.
  The solver's own contacts, below, catch it on a handful of frames and no more.
- The **solver's own contacts**, scanned in `BallLevel.collectContactSparks` after `integrate`.
  A hook the solver is holding against a face may never re-enter `bounce()`, since the contact does the holding, and `World.frameContacts` is exactly the "what did this body touch this frame" question (`attachToBlockingContact` reads it for the same reason).
  It is the one source that is CONTINUOUS through a slide, which is why it is the one that gets the last word.
  It is deliberately **not** filtered on `normalImpulse > 0`, the "it really pushed back" test `attachToBlockingContact` uses: that is the right question for an attach and the wrong one for a drag, since a hook riding along a face it is neither sinking into nor bouncing off carries no normal load at all, so the solver asks for nothing.
  `session-117f` f78-f80 is three consecutive frames of an 8 m/s drag at `normalImpulse = 0.0000`, which is where the stream went silent - and a silence long enough to pass `CONTACT_GAP_FRAMES` is what lets the render side read the far side of it as a fresh arrival and fire a second impact burst mid-slide.
  What is left is exactly the narrowphase's own answer, a pair inside `CONTACT_SLOP` of each other; on a 2 cm hook that band is 1 cm and those slide frames sit 2-3 mm out.
  How fast the two are rubbing is then the render side's question, and `SLIDE_MIN_SPEED` is where it is asked.
  Either side of the pair may be the hook and hook-proof is a per-SHAPE flag, so the surface may be a rigid body: reading `a` alone would answer for half the pairs, and the velocity is taken **relative to the surface** so a hook riding a moving platform is not sliding on it.
- `Hook.onDestroyed` for the grapple hook, which is destroyed rather than deflected by a hook-proof surface, so it gets the burst and never the stream.
  Its `velocity` is a per-frame displacement and is divided by the step on the way out, since every threshold downstream is in m/s.

**A slide throws its sparks ALONG the slide, not against it** (`slideSparkDirection`).
A spark is a chip sheared off the steel and carried away by whatever sheared it, so it leaves at a fraction of the sliding speed in the sliding direction: an angle grinder throws its fan the way the rim is travelling at the contact, and a car scraping the road throws sparks that are moving forwards even though they fall behind the car.
Nothing at the contact can push a chip backwards, which is why the launch fractions are under 1 - the shortfall is the whole of why the shower falls behind the hook.
It was written backwards first, because "trailing the hook" and "moving backwards" are the same picture in the HOOK's frame and opposite ones in the world, and this is drawn in the world; what that looks like is sparks streaming out of the hook's leading edge.
`SLIDE_TILT` then lifts the cone off the face so the stream leaves it rather than grinding along inside it.

**Every threshold is on the render side**, so tuning has one home: the sim reports contacts and pre-judges nothing.
`SparkSystem` splits the event velocity at the surface - the normal component aims the burst, the tangential one sizes the stream - and `SLIDE_MIN_SPEED` is the constant that implements "not while it is stationary".

**The burst is sized and gated by the ARRIVAL SPEED, not by its normal component.**
A strike is a strike however oblique it was, and a hook thrown flat down a floor arrives almost entirely tangentially: `session-117f` f74 is 11.55 m/s along the face against 0.04 m/s into it.
Measured on the normal component alone that scored as no arrival at all, so the one burst a first contact is owed never fired and the whole shower was drag - which is the other half of why a slide read as repeated impacts, the drag particles being 3-4x faster and twice as long-lived as a burst's.
The settle case `IMPACT_MIN_SPEED` exists to reject is slow in EVERY direction, so it is rejected just as firmly by the speed.
The closing half is clamped at zero where it is spent (`vnOut`), since a graze whose first reported contact already has the hook turning away would otherwise throw its sparks backwards into the face.
Across the corpus this adds eight bursts to `session-1085f`, every one of them an oblique throw that previously arrived in silence, and no two bursts in the run are closer than 27 frames apart.

**A burst is for an ARRIVAL**, and only the burst is: the stream runs on every frame the hook is moving along a face.
Once a hook is down and sliding, further normal components are the WALL's shape rather than a new strike, and a faceted hook-proof polygon supplies them constantly - crossing the seam between two facets turns the normal under the hook, so a velocity that was 0.14 m/s into the old facet is 2.78 m/s into the new one with the hook having neither gained speed nor left the surface.
`session-127f` f102-f103 is that exactly: the velocity vector is identical across the seam and only the normal moves, by 15.5 degrees, and it fired a second burst in the middle of a slide.
`CONTACT_GAP_FRAMES` (2) is the rule - a touch is an arrival when nothing reported contact for that many steps - which bridges the single-frame gaps a speculative contact leaves while staying well under the flight time of any skip worth seeing as two strikes.
Across the whole corpus it removes exactly one burst, the one above; all 30 of `session-2504f`'s stay.
Whether the hook is arriving is itself collision information - it was not touching anything, and now it is - so it lives on the render side with every other threshold.
The counter is per SYSTEM rather than per hook, which is exact while at most one hook is in contact at a time (the ball's chain has a single tip, and the grapple hook is destroyed by the surface that would spark).

**Every event is asked BOTH questions, and each answers on its own threshold.**
A head-on hit is all burst, a drag all stream, and a glancing skip is legitimately both; nothing in `render/sparks.ts` knows or cares which part of the sim reported the touch.
That is the design rather than a simplification, and `SparkEvent` therefore carries **no field naming the kind of touch** - only the point, the normal and the velocity.
It carried one first, and the drag case is what that cost: reading a bounce as "an impact, therefore a burst" threw away the tangential half of the only events a dragged tip produces, so the tip ground along the steel in silence (`session-152f`, f123-152, tangential speed climbing 0.44 to 3.64 m/s with not one spark).
A field whose only correct use is "do not branch on me" is a field somebody eventually branches on.
The pool is a fixed 256 with struct-of-arrays `Float32Array`s and swap-remove, so there is no per-frame allocation.
The colour ramp is baked into a lookup for the same reason: 256 formatted `rgba(...)` strings a frame would otherwise be the only thing the draw allocates.

The PRNG is a **seeded** mulberry32 reset by `reset()`, and `advance` takes its `dt` as a parameter, because `shot.html` and `cli shot` replay a bundle and screenshot frames.
The live game passes its render dt and the shot path passes the fixed `STEP`, so two grabs of the same frame are the same picture (asserted: `cli shot --diff` of two runs reports **0 pixels**) and only the live path is nondeterministic, which is the path nobody diffs.

Drawing goes through the renderer rather than around it (`render`/`renderBall` take an optional `SparkSystem`) and is deliberately **not** gated on `overlayOnly`: a spark is an emissive, flat, screen-thin mark over the scene, which is exactly what the 2D canvas keeps in 3D mode alongside the reticle and the anchor grates.
One system therefore serves both render modes.
`main.ts` ingests **inside** the fixed-step catch-up loop rather than after it, so a stall drops no caught-up frame's events, advances once per rendered frame on the render clock, and resets with the level.
The editor's **▶ Test** runs the same three calls in its own loop and resets at every start, so a level is judged with the sparks it will play with - the point of ▶ Test being that what is felt there is what the player gets - and a test never opens carrying the last one's embers.
`sim/svgFrame.ts` is left alone, being a diagnostic projection rather than a look.

Worth knowing before judging a screenshot: the sparks are drawn with `globalCompositeOperation = "lighter"`, which is what makes a shower read as a bright core on the dark 3D scene the ball level plays in, and which is nearly invisible against the **light training-grid backdrop** the 2D path draws.
A 2D grab is evidence that they are in the right place; the 3D one is evidence of the look.

The burst is deliberately the quieter of the two, and its three knobs are not interchangeable.
It is at 21% of the size it was first written at, in two passes by eye: to 30% because a full-speed throw read as an explosion rather than as steel glancing off steel, and to 70% of that again once it stopped being the whole of what a glancing hit produced - before the arrival-speed gate an oblique throw earned no burst at all, so the burst was carrying every strike the player saw.
At the hook's own 12 m/s that is 4 particles where it was 5, and a hit at the cap 4 where it was 6; the count is an integer, so the granularity at these sizes is coarse and a request for 70% lands between 67% and 80% depending on the speed.
`IMPACT_SPARKS_PER_MPS` and `IMPACT_BURST_CAP` move **together** (a cap alone would decide every hit above a certain speed and the burst would stop growing with the throw); the speed fractions set how hard the sparks are thrown and, since a streak is drawn from the velocity, how long each drawn streak is; and `IMPACT_TTL_SCALE` sets how far they get before they wink out.
Reach is speed times lifetime, so all speed reads as a puff and all lifetime as sparks hanging in the air - they are tuned by eye as a pair.

**A STRIKE is a burst and a DRAG is a stream, and `SLIDE_RAMP_STEPS` is what separates them.**
The stream's rate is per METRE of face ground, which is the right law and cannot on its own tell a three-frame glancing strike from a second of grinding: a strike at 51 degrees covers 0.4 m in those three frames, so at the full rate it threw four times the shower of a square hit off the same throw (`session-156f`, whose two throws are the pair this was tuned against).
Cutting the rate closes that gap and takes the long grind down with it - at 5 per metre the pair reads 1.5x and a sustained drag is a trickle - so the fix is a ramp rather than a rate: the stream fades in over the first `SLIDE_RAMP_STEPS` frames of unbroken contact, and both ends are left alone.
The burst is untouched, and a contact that goes on sliding still reaches the full 30 per metre.

The span to fade over is the BURST's own life, because the burst is already the material thrown off at the strike and a stream at full rate over those same frames is the arrival counted twice.
A burst particle lives 4.5 frames at the shortest, 9 on average and 13.5 at the longest, and 8 within that range is where `session-156f` lands at the 1.5x it was tuned to: 6 particles for the 51 degree strike against 4 for the 5 degree one, on both of its angled throws.
Longer ramps quiet the strike further and the drag with it (10 gives 1.25x on the shorter of the two, 14 gives 1.25x on both); shorter ones hand the strike its full grinder's rate back.

Measured on a dangling tip dragged 18 m along hook-proof steel, a sustained drag runs at **30.0 particles per metre** past the ramp - the full rate, to a decimal place - with 40 to 60 alive on screen at any moment.
Nothing in the recorded corpus is that: every hook-proof contact in it is a 2 to 7 frame strike, which is why the drag case has to be built rather than replayed (`cli contacts` `hook-sparks` builds it).

The ball's half is gated by `cli contacts` **`ball-sparks`**, over five rigs, and the pairs are what make each clause a statement: a shove across slick hook-proof steel grinds 848 particles where a rolling ball is silent, a twelve-metre slam strikes twice (it rebounds and lands again) and grinds nothing, and the same skid on ordinary steel reports no touch at all.
The sharpest is the grippy shove, which catches the ball still crossing the level at 1.9 m/s and silent - measured at the ball's centre instead of at the contact it reads 30 particles over the same stretch, which is every ball in the game sparking permanently.
The fifth is the wound-up rig, where the spin the ball CARRIES and the spin it REALISES are different numbers, and its post is one body of two shapes for a reason worth keeping: the chain has to anchor to ordinary steel, and the steel the ball is ground against has to be hook-proof, so the post is a stub of the one at its foot and a shaft of the other above the ball's own resting height.
It used to be the FLOOR, on the argument that a wedge keeps the two apart, and that only ever held by millimetres - a ball hauled up its own chain does not stay on the ground, it is pulled into the post and rides UP its face, and the anchor can never sit lower than one manacle radius off the floor.
At a 20 mm cuff the ball ended 39 mm up with its 35 mm lug still grazing; at 53.5 mm it hangs 53 mm up touching nothing, and the case went red reporting no hook-proof contact at all - the CONTROL failing, with the silence it guards as true as it ever was.

The hook's half is gated by `cli contacts` **`hook-sparks`**, over three rigs - a head-on throw, a skimming one, and a dangling tip dragged 18 m along hook-proof steel.
It asserts one report per touch and never two, the arrival carrying the velocity the hook came in at rather than what the bounce left behind, a burst on an oblique arrival as well as a head-on one, not one silent frame in the middle of a contact, a slide's sparks travelling along the slide and clear of the face on a floor, a ceiling, a wall and a 45 degree ramp, and a sustained drag grinding at the full per-metre rate where a brief skim is charged a fraction of it.
Every one of those is red on its own with the corresponding half reverted, which is the point of writing them as clauses rather than as one number.
The last is stated as the RATIO between the strike and the drag rather than as a bar on either, since either alone is a tuning value and the separation is the behaviour: 12.4 per metre against 30.0 with the ramp, 29.5 against 30.0 without it.
The bar is **2x, and it is the ramp's own arithmetic rather than this rig's skim**: the ramp is linear in contact frames, so a strike lasting N frames is charged `mean(1..N) / RAMP` of the full rate and earns a ratio of `2 * RAMP / (N + 1)` - 3.2x at 4 frames, 2.3x at 6, and 1.8x for the longest strike the ramp covers at all.
It was 3, which is 4 frames' worth exactly, so it was a statement that this rig's hook rides the floor for 4 frames rather than a statement about the ramp - and the 53.5 mm manacle rides it for 6, which sent the case red at 12.4/m with the mechanism working as designed.
The drag rig has to be built rather than replayed - every hook-proof contact in the recorded corpus is a 2 to 7 frame strike, so nothing in it reaches the far side of the ramp at all.
Particles are counted through the real `SparkSystem` (`bursts` and `slideParticles`, which exist for exactly that and are read by nothing else), since what the sim reports only matters through what the render side makes of it.

The **thresholds and the look** are still ungated, and the three cases to check by hand after touching one are the ones that pin them from all sides.
A hook **skimming** a face must strike once and then trail (`session-127f` f101 onward: one burst, then a stream growing to 63 particles by f109), a tip **dragged** along one must produce a steady stream (`session-152f` f123 onward, and `session-339f`, whose tangential speed reaches 5.4 m/s), and a tip left **resting** against one must produce nothing at all - the resting case fires one or two events every frame for ever, at gravity's own 0.13 m/s of approach and zero tangential speed, so it is silent because both thresholds reject it rather than because nothing is reported.
None of those three is visible to a number: sparks reach no digest and no invariant by construction, so a shower that is the wrong size, the wrong shape or the wrong colour is exactly as green as one that is right.
