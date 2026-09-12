# Continuous wrap detection

The wrap scan is a **sample**: each span is tested against the scene where it *is*, once per regeneration.
At speed that is not a path.
`session-126f` dropped the ball from eleven metres with its chain deployed, past a 20 x 10 cm block that lay in the first span's way, and the chain went straight through it: the span moved 25 cm a frame, was above the block on f92 and below it on f94, and on the one frame it landed inside the block (f93) the direction rule - which side is the body's **centre** on - chose the corner the chain was *leaving* by, which `cullDetachedNodes` dropped a frame later.
Every invariant read HEALTHY, because the chain was never inside anything.

The player's chain is the one rope that moves like that, so it is the one that **sweeps** (`Rope.continuous`, set by `BallPlayer.shoot`; scene chains and the grapple rope keep the sample, which is what every one of their recordings was made through).
`Rope.sweepSpan` asks, per span, what passed *through* it since the last regeneration: the span's two ends move linearly from where the last regeneration left them to where they are, a point of the scene moves linearly from where its body's pose then put it, and the point's signed side of the span is a quadratic in time (`lib/spanSweep.ts`).
A net change of side with the crossing inside the span's extent is a crossing; in-and-out is not, and going round the span's end is not - a body the hook flew past is not a body the chain ran into.
A polygon is crossed by any exposed vertex (a seam vertex has no outside to bend round), a circle by its centre, and the side a point came **from** is the wrap direction: the rope bends round the body with the body on the side it entered from, which is what the centre rule gets wrong for a body most of the way through.
A shape found both ways is one shape, and the crossing decides its direction; one that crossed and stands clear of the span's start is wrapped at its **tangent from there**, the same construction the sample uses for a span clean through a shape.

The baseline is kept by **role**, not by node identity: the point the rope leaves its start body from (the last coil node, or the start), the far end, and a pose per mobile body in the scene.
The coil re-derives its node objects every frame and an attach replaces `end`, so identity would lose exactly the two spans that move fastest; a wrap in between is a material point of its body and is placed by that body's recorded pose.
Sweeps chain regeneration to regeneration rather than frame to frame, so every motion of the path is covered once whatever the caller's frame looks like - the ball controller regenerates before its solve, in it, and on an attach, and the sweep between each pair is that step's motion.
`detectSceneCatch` re-records after it discards a coil it found, so a flight's baseline is the straight span it draws.
The rope's own two bodies are never swept for: a span can cross the ball's own disc on a fast swing, the sample has always been free to wrap the rim when a span *overlaps* it (the coil), and a catch on the ball born of a crossing is a wrap the coil machinery has no reading of.
The query is the box the moving span covered (`World.queryShapes`) plus every mobile surface, since a body that moved may have come from anywhere and there are few enough of those to ask each one.

Catching the block is half of it.
The far end of that chain was the quarter-kilo hook, and the 52 kg ball falling at 15 m/s then had to whip it round the block by 40 cm a frame.
The correction step is a straight pull along the last span sized by the whole error, and the last span was 15 cm: the hook was carried a span past the corner, the next iteration pulled it straight back, and ten iterations oscillated about the corner for 3 mm of progress each (f97).
The over-length stood at 0.9 m for four frames, the ball was braked to a standstill by a hook that could not move, and when the hook finally bit the block the solve hauled the ball 40 cm in one frame - an 18 m/s launch straight up.
So on a continuous rope the far end may be drawn **up to** the node it is being pulled towards and no further (`Rope.boundToNode`), and an end that reaches its node has that wrap dropped inside the solve (`roundEndNode`) so the next iteration pulls it on towards the node before.
That is how a light end rounds a corner *within* a frame: the hook whips over the block in the frame the error appears, bites where it lands, and the ball is arrested over the corner as a swing.
Only a scene node is dropped - the coil is `syncCoil`'s to keep and the start is where the rope ends - and the monotone guard forgives a continuous rope a nanometre, because an end snapped onto a node measures the same path to the last bit only in exact arithmetic.

`chain-tunnel` (`TunnelMonitor`) is the detector, and it exists because nothing else could see this.
It runs the same crossing test over the frame rather than over each regeneration - what the sim does within a frame is its business, and what the invariant asserts is the frame's outcome: a wrappable body a span passed through, more than 2 cm beyond the chain and not within 5 cm of the span's start, that the chain does not run over at the frame's end.
A body that crossed and *is* on the path is remembered with the side it came from, because the wrong-corner catch above holds a body for exactly one frame and by the time it is dropped no span crosses anything; a remembered body the chain lets go of on the far side, within a span's extent, went through rather than round.
The chord between the nodes either side of a body's wraps is what records that side for a body that has just arrived on the path - the spans that end on it cannot, since a span never tests the shape it ends on.
`cli contacts` `chain-sweep` is the case: the recording's fall past the block, the same fall past a 5 cm round post, a hook thrown sideways from a falling ball with a post inside the wedge the deploying span sweeps, and a stone dropped through a taut chain (the body moving rather than the chain), each run twice - the sweep on, and off on the identical run so the monitor reports the pass-through - which is what makes every rig a detector rather than a script that happens to pass.
`playtests/regressions/session-126f.json.gz` is the recording.
Across the rest of the corpus the change is invisible: `cli ab --ref` reads identical on every bundle but `session-611f`, whose lease and over-length shrink a little.

## A crossing out of a shape the span was already cutting is not a pass-through

A crossing is discarded when the span was **already cutting the shape at the last look** (`cutAtLastLook` in `lib/spanSweep.ts`): the old span, carried along with the body's motion since, is tested for overlap against the shape as it is now, and a shape it overlapped was on neither side of it.
A vertex of such a shape crossing now is the span coming back *out* of the shape, or going deeper in, and either is the overlap test's business.
Read as a pass-through it is wrong in exactly the way that matters: the side that vertex "came from" is the side it alone had poked through to, the opposite of where the rest of the shape stood, so the rope is bent round the body the wrong way and, since the span's start is clear, from the **tangent vertex on the body's far side**.

`session-3649f` f3474 is the finding (f2633 of the same run went the same way, seventeen seconds earlier).
The ball on the ground was winding its deployed chain in against a hook hanging at full length, and the span from the coil's exit was cutting 4 mm through the tip of a polygon corner 3 cm from the exit - close enough that the start-proximity gate (5 cm) had declined to wrap it, which is the tolerated-penetration state every gate leaves behind.
One more frame of winding slid the corner back out to the body's side; the sweep reported it arriving from above, wrapped the body counter-clockwise, and chose the tangent vertex 80 cm away on its far side.
The path was 2 cm over length through a corner the rope never touched, the hanging hook was hauled 1.3 m in one frame to make it fit, and the attach two frames later anchored the chain over that phantom wrap, which is what was seen: the chain draped over a vertex nowhere near the straight line to its anchor.
Only the `--dump` of `cli shot` could show it - the bundle diverges in bun from f859 on the libm knife-edge, and the tail is chaotic in that - and the fixed page reproduces the recording bit for bit up to f2633, where the rule first bites.
`cli contacts` `chain-sweep-slide-off` is the detector: the recording's polygon and its two spans exactly, played forwards (the slide-off, no crossing) and backwards (the rope arriving from clear onto the corner: a clockwise crossing at the corner itself), so a rule that silenced the sweep outright fails the second half.

## A corner two statics share is the span's own end

A point that stood within a nanometre of the old span's line was **on** it, not on a side of it (`NO_SIDE` in `lib/spanSweep.ts`), and a crossing is only reported for a point that had a side to come from.
The side is the sign of a cross product, and below float noise that sign is not a fact about the scene.

`session-1052f` f932 is the finding.
The ball level's crane beam ends in a 20 cm block authored to share the beam's right face and both corners on it, a few ulps off round numbers (`x: 1069.9999999999998`), so the block's corner and the beam's coincident one stand 1.8e-15 m apart.
The ball hung from the block's underside on a chain over that corner, wound itself up beside the block and spun, and the span from its loop to the corner turned through horizontal as the loop came round.
That turn changed which side of the span's line the beam's corner was on - by 7e-18 m² - and the sweep read it as the beam passing through the span at u = 1: a wrap on the beam, counter-clockwise, at its tangent vertex on the far side, 20 cm away.
The path was 28 cm over length through a corner the chain never went near; the solve hauled the ball 19 cm into the block to fit, the push-out threw it 10 cm back out, and the frame closed at 7.4 m/s - and every invariant read HEALTHY, because the kick was a *reversal* (the speed-gain bar under-reads those: 5.0 m/s of gain less the winding budget sat at 3.7 against a bar of 4) and the solve was entitled to what the phantom path opened.
What was seen was the chain drawn from the ball to the beam's top corner and back down the face to its anchor under the block.
The flip is deterministic, not chance: the two corners differ in x only, so the side reads as the sign of the span's y-extent, and it changes every time the loop crosses the corner's own height with the chain bent there.
The same geometry with the sweep's floor in place drops the corner wrap that frame, as the straight line to the anchor no longer cuts the block, and the ball swings on.
The bundle diverges in bun from f379 on the libm knife-edge; the fix was measured on V8 (see [**Debugging discipline**](debugging-physics.md#debugging-discipline)), where the tree reproduces the recording bit for bit up to f932 and leaves it there.
`cli contacts` `chain-shared-corner` is the detector, both halves red without the floor: the recording's block, beam and f931 -> f932 spans asked directly (coincident to noise and not to zero, and not a crossing), with the catch that put the chain over the corner twenty frames earlier as the control (the block's own corner arriving from clear, 6 mm² of commitment, still counter-clockwise at the corner); and the scene end to end, the ball seeded with the recording's state at the shot and steered by its cursor path, where the beam is never on the chain's path, no frame moves the ball more than 10 cm (18.3 without the floor) and none lengthens the path by more than 5 cm (11.3).
`playtests/regressions/session-1052f.json.gz` is the recording.
