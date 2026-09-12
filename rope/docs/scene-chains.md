# Scene chains

## Chains

**+Chain** (**K**) drags a chain from one body to another: press on the first body, release on the second.
A chain is a real constraint, not decoration - it is a `Rope` with both ends pinned at load (`src/level/chains.ts`), stepped once a frame after `World.integrate` by both level drivers, so a rigid body on either end hangs, swings and is hauled by it while a static is infinite mass and simply holds.
There is deliberately **no new physics**: `Rope` already models a rope between two `RopeContact`s on arbitrary bodies, and a scene chain is that class with neither end being a hook in flight.

What a chain is **not** is collision geometry: nothing stands on it and another rope does not wrap it.
Both would need the chain to be a body per link, which is a different mechanism.

A chain is **scenery** in what may touch it and **level geometry** in what it bends around.
It is drawn behind the level's geometry at 55% alpha, and its spans are solved against the level's wrappable bodies - the statics and the authored rigid bodies, `BuiltBodies.wrapBodies`, the same scene the ball's chain scans - so a chain that swings across a post catches on the post's corner and hangs its load from there, exactly as the ball's chain would.
What it is **not** solved against is the play space: the avatar, its hook and anything spawned in play are never in that list, so nothing the player does can snag on a chain.
The editor draws it dashed and `cli render` dashes it too, which is what tells a scene chain from the ball's in a snapshot.

For a while a chain was solved against **nothing** but the bodies its wrap points named - "hangs between its two bodies and passes through everything else", the empty list being exactly what `Rope.regeneratePath` already does for a span's own two end bodies.
That read as the chain being drawn through a pillar it plainly ran into: `session-497f` hung a weight beside a post on a chain over a pulley, the weight fell past the post's top, and the chain cut straight through the post instead of bending over its corner and hanging the weight from there.
`cli contacts` `chain-post-catch` is the detector, and the scan is broadphased (`World.segmentCandidates`), so handing every chain the whole level costs a tree walk per span rather than a segment test per shape.

There was briefly a `foreground` plane before that - in the play space, drawn over the geometry and solved against the whole scene, avatar included, so the player and the hook could be caught by it - and it was **removed**.
It bought very little that a rigid body on a chain does not already buy, and it charged for that by making every chain a thing the player might silently snag on.
If a chain in the play space is ever wanted again, note that the plane has to stay *one* decision and not two: what a chain is drawn in front of and what it is allowed to touch are the same statement, because a chain hanging visibly behind the level that still snagged the player is a lie the level tells.

`Rope.physicsStep` derives its **own** set of bodies to pay for the correction (`moved` = the bodies on its path) rather than crediting the list it was given: the scene a chain is handed is what it may wrap, not what it moves, and a body whose position the solve corrects but whose velocity nothing credits keeps every frame's gravity - a wrecking ball on a chain sat perfectly still at **119 m/s** by the twelfth second, waiting for the first frame that gave it slack.

The chain set is solved as **one system**, not as a list of independent ropes: `stepSceneChains` opens every chain's frame once and then sweeps the set, alternating direction, until no chain is more than `CHAIN_TOLERANCE` (5 mm) over its length or `MAX_CHAIN_SWEEPS` (64) is spent.
Each chain is a full PBD solve that writes positions and credits itself velocity, so a single pass in list order is Gauss-Seidel with one iteration - the chain that solves first moves the bodies, the next one gets the last word, and the residual is whatever the earlier chains asked for and did not get.
Where two chains hold the **same pair of bodies** - a bridle, a swing seat, any two-point hanger - that residual is not a rounding error and it does not wash out: the ball arena's hanging weight leaned **18 cm** with its link tilted **18°** in a rig symmetrical to the millimetre, and swapping the two chains' order in the level file mirrored the answer digit for digit, which is the whole diagnosis - nothing in the geometry chose that side, the array order did.
The residual is also re-injected every frame, so the rig rang at 0.085 m/s for ever instead of settling.
Sweeping repeatedly is what iteration count is for in any impulse or PBD solver, and the direction alternates so one sweep's order bias is the next's mirror rather than the same one compounded; the bias stays order-driven at any count, but a converged set leaves it a solver residual rather than a feature of the level.

The same residual is also what the chains look like they are **made of**, and it is why the loop runs to the residual rather than to a count.
Each solve pins its own chain to exactly its length - `relaxationFactor` is 1, and a lone chain measures **0.00 mm** of stretch under any load at all - but the chain solved after it moves the bodies they share and stretches the first one back out.
On the hanging weight that was **73 mm on a 1.03 m chain**, 7%, read from the game as the chain being made of elastic.
It is not elastic and it is not load: the same rig at four times the mass stretches by the same 72.72 mm, because a PBD position correction is written in mass *ratios*.
Running to a tolerance instead pays at both ends - the single-chain rigs that are most of every level converge on the first sweep and pay for one, against four before, and a coupled rig spends what it needs rather than what looked reasonable when a constant was written.
Convergence is linear and halves per doubling (125 mm at 1 sweep, 73 at 4, 11 at 32, 5.2 at 64), so the **cap** is a straight choice of how much to spend: 64 sweeps costs 0.55 ms a frame for that rig's three chains, against a 16.7 ms budget.
What sets the rate is the chains' **angle** rather than the weight - a shallow V carries a far bigger tension for the same load - so a rig at 14° off horizontal wants ~200 sweeps for 5 mm and gets the cap instead (15 mm, against 191 mm at one sweep).
Authoring those chains steeper is worth more than any cap this side of sane.
`Rope.beginFrame` stays **outside** the sweep loop - it releases the blocked-length lease, and a lease released once per pass is handed back a sweep's worth faster than the geometry that bought it can re-earn it - which is why `Rope.solvePass` exists as its own method, and `Rope.overLength` is what the loop measures convergence by (zero for a slack chain: the constraint is an inequality).
`cli contacts` `chain-order` is the case: one rig, built twice with its two lower chains in opposite orders, must hang near centre, near level, and with its chains near their authored length in both.

The **ball's chain is in that sweep too** whenever the level has chains at all (`sweepChains`, called from `BallLevel`'s chain phase), and for exactly the reason the scene chains are in it with each other: anchor a chain to a body a scene chain also holds and the two share a body, so each one's solve is the last word on where that body ends up and the other's correction is the residual.
Solved once each, they spent every frame undoing one another - the arena's link block moved 10 mm and 0.15 rad one way by its three chains and 11 mm and 0.17 rad back by the ball's, frame after frame, for ever.
The cost of that is **not** the shaking, which nets out in position and is not even visible; it is the **mass ratio**.
A PBD correction is split between the bodies on the path by their inverse effective mass, and the ball's chain, solving alone, split it against the link's own 11.2 kg rather than against the 1758 kg ladder and the ceiling that the link is tied to: four fifths of every winch correction went into hauling an anchor that three other chains put straight back next frame, and the ball - which is the thing winding chain onto yourself is supposed to haul - kept a fifth, which is almost exactly what gravity took off it again.
So a wind-up against that anchor bought 0.55 mm a frame of travel, the length the solve could not reach was charged to the ball's rotation by `unwindOverLength`, and the player's aim was refused **96%** across 200 frames while they held it: a ball that will not turn to face the reticle, reported as the chain being jerky and the ball refusing to roll up it (`session-521f`).
Swept together, the scene chains refuse the anchor *within* the frame and the next pass puts the correction where it can still go, which is the ball.
The aim demand over those same 200 frames falls from 13 rad/s to 1.9, which is the ball tracking the reticle rather than being stuck a long way off it.
`playtests/ball-winch-hung-anchor.json` is the mechanic in isolation - a chain-hung anchor light enough that the mass split is most of the answer - and it winches **1.37 m** against 0.07 m before, next to 1.36 m for the same rig anchored to a static, which is the statement: how far a winch hauls must not depend on what is holding the far end.
The sweep is skipped outright on a level with no chains, so every playtest and recording that predates scene chains replays bit-for-bit.

What that loop measures convergence by is **the disturbance to the coupled rope**, not the set's own residual, and the distinction is the whole cost of the feature.
The scene set's residual is a property of the *level* - this arena's rig wants ~200 sweeps for 5 mm and gets 64, so it is over tolerance on 1616 frames out of 1618 - and a loop waiting for it therefore always spends the whole cap, on the one solve in the set that regenerates a wrap path and is an order dearer than the rest.
That doubled the arena's physics frame, p50 2.3 ms to 3.7 and p99 5.2 to 8.9 with peaks at 15.3 against the 16.7 ms the renderer also draws inside, and it bought nothing: the coupling has stopped changing the answer after the first sweep, and the winch travel is identical to four decimal places either way (`session-1618f`, reported as the frame rate collapsing).
Gated on the disturbance it takes **one** sweep on that arena and the cost is back in the noise.
Worth knowing separately: `stepSceneChains` on its own is 31% of an arena frame (0.74 ms mean, 8.9 ms peak) and spends the cap every frame for pure scenery, which is the authored angle rather than the solver - see the note above about authoring a shallow V steeper.

The chain phase **closes against the geometry**, the same way `BallLevel` closes the ball's own (`settleChainBodies`).
A chain writes its positional correction straight onto the bodies it holds and pays itself Δposition/Δt for it, which is a standard PBD velocity update and honest only if that correction is the last word on where the body ends up.
For a body a chain hauls into a surface it is not: the frame ends with the body embedded, next frame's `World.integrate` pushes it back out positionally and takes the approach velocity off it at the contact, and the chain then re-corrects a gap that is the push-out's depth **plus** however far the credit it kept has carried the body since.
That is a loop with a gain above one and it doubles every frame.
`session-147f` is the whole of it: a 628 kg plank hung from a static ledge by two chains, swung up so its end jammed under that same ledge, and the chain's credit ran -0.76, -2.44, -4.68, -7.42, -10.36 m/s over five frames while the contact's push-out grew 10, 32, 108, 200, 304 mm to match, until the plank stood **204 mm inside a 100 mm slab** - past half its thickness, so the push-out resolved out of the far face and the plank tunnelled clean through the ledge it hangs from, swung away carrying 2.6 kJ it never earned, fell back on the ledge and did it again.
Every frame of that replays HEALTHY: nothing about it violates an invariant until the energy monitor notices the kJ, 75 frames later.

Refunding the credit is what this cannot be fixed by, in the same words the ball's phase uses: the credit is taken along the correction and would have to be handed back along the contact normal, so a refund big enough to stop the compounding also injects velocity sideways.
Ordering the frame so the question never arises is the fix - push out after the sweep, take the phase's velocity over the displacement that **survives** the push-out, and there is nothing left to refund.
The `funded` bound on the into-surface refusal is `BallLevel`'s and is there for its reason: a body arrives at this phase already pressing into whatever it rests on, so cancelling that share too would leave the frame with no approach velocity and next frame's contact would size its Coulomb cone from nothing.
The ball's own into-surface refusal is taken as a PAIR where the surface is a free rigid body (2026-09-12): the refusal removes the closing rate between the ball and the surface, and written onto the ball alone a body moving AT the ball handed it that speed and kept its own - `session-239f`'s 12.6 kg hung weight, pushed back into the wound-up ball by the pair separation at 1.3 m/s, sped the 52 kg ball up 0.44 m/s a frame for six frames with the aim idle, 40 J the weight could not have paid a quarter of, and `energy-gained` fired at f121 on a trajectory the free-holder change above had only just made reachable.
Split by the effective masses the pair separation splits its push by, rotation about the contact included, the weight is slowed by what the ball is sped up; a static surface has no share and reads exactly as it always did, and a pivot or a spring mount is deliberately left one-sided, an impulse on the bearing being the whirl's seed spin by another door (`whirl-anchor` and `winch-load` both went red with them included).
So is a body the spin rollback has just restored: the closing rate refused against it is the winch's kinematic credit, and a share of that handed over every frame is `session-265f`'s anchor fed the spin by another door again.
Two details are load-bearing.
The push-out counts **statics only**: a chain-hung body is as often a platform as a weight, and an overlap with something resting on it is a pair the next `integrate` solves for both sides - resolving it here moves the wrong body and then pays it for having moved, which shoved the slab out from under the ball in `steered-hung-hold` and rode the credit 15 m across the level.
And the credit carries `topologyCreditScale`, because this **replaces** the per-pass credits rather than adding to them: a scene chain wraps nothing, but its span is still re-resolved around the corner of the body it is bolted to, and dropping the scale let this rig's span grow 46 cm in one frame as the plank turned under its own anchor and threw it off at 13.9 m/s.
`cli contacts` `chain-hung-jam` is the case, and what it asserts is the **compounding** (peak 4.4 m/s against 14.5; 6.6 with the translation push-out described below) rather than the tunnel, since a runaway is what a tunnel is made of.

Still open there: a hard jam ends 15 s at ~1 m/s rather than at rest, and `energy-gained` still fires on one.

The ball's **own** chain has the same closure now, for the rigid bodies on its path - its anchor, and anything it wraps - which no scene constraint holds and `settleChainBodies` therefore never reached (`refuseRopeBodiesIntoStatics`).
`session-133f` is `147f` wearing that mounting: a 91 kg plank lying across two L-shaped posts, the ball re-hooked to it while falling at 1.7 m/s.
The snap credited the plank 0.37 m/s and 0.48 rad/s, the credited spin lifted its far end off its post within a frame, the near post could then only pivot it on the foot's corner, and it went 1.9, 2.5, 3.0, 3.6, 4.1 m/s downward over five frames with the push-out growing 92 to 156 mm to match, until its end stood 89 mm inside a 200 mm foot and the next push-out let it out sideways through the foot's inner face.
HEALTHY on every invariant, all of which were about the ball; `chain-body-embedded` is the one that now watches a path body's depth in the scenery, by the `player-embedded` rule and tolerance.
What is applied is the closure alone - push out of the statics, refuse the velocity into them - and **not** the credit replacement, because the ball's chain bounds its own credit (`creditBound`, the spin-share rollback, the pivot's rotation bound) and those bounds are load-bearing; so the change is bit-identical on every frame no path body stands in a static, which is every frame of every recording before it.
Two things about the refusal turned out to be the fix rather than details.
It is taken **at the pushed point and through the body's inertia** - an impulse there, split between translation and rotation by the effective mass a contact would use - and not as a clamp on the centre's velocity: clamped at the centre, the plank's fall was refused and its spin kept, its end went on turning into the foot 0.47, 0.66, 0.77, 0.90, 1.07, 1.30, 1.59 rad/s over seven frames, and the ball, reading an anchor whose attachment point was chasing it at 0.5 m/s, had its own brake credit clamped to nothing and went on falling until the plank stood on one corner and fell through more slowly.
And the **push-out is at the point too** (`World.depenetrateRigidAtPoints`), for the reason a chain-hauled plank is turned into the foot far more than it is moved: `depenetrateRigid`'s translation along the deepest normal lifted the whole plank by its tip's depth, its far end rose off its own post, and it settled into a ratchet equilibrium 9.3 mm above its rest and 0.007 rad tilted, hauled a little and lifted a little every frame the ball hung there.
Resolved in rotation it ends within the resting sawtooth (1.5 mm, 0.001 rad).
The share of the correction a blocked anchor refuses is still the ball's to take, so the length is solved once more with the blocked bodies held (`solveLengthHolding`, the winch's own mechanism) - otherwise the ball keeps that share as over-length and hangs lower than its chain says, re-corrected and re-refused every frame.
`cli contacts` `plank-anchor` is the case: the recording's own posts and plank, the ball dropped for twelve frames and re-hooked so the chain snaps taut at 2.8 m/s, and the plank must never stand in a post, never tip, and end on both posts where it began (105 mm, 3.1 rad and 123 m of fall on the old physics, with the ball slung at 49 m/s).
The chain's correction is part rotation and the push-out that answers it is a translation, so the difference is credit nothing takes back - the same fight one derivative up.
An angular push-out is what that wants, and it belongs with the ball's phase, which has the identical hole.

The scene settle had that hole too, for every body it closes, and `session-193f` fell through it.
`settleChainBodies` pushed a chain-held body out of the scenery by a **translation** along the deepest normal (`World.depenetrateRigid`), which for a long body hauled by one end is the wrong answer and a compounding one.
That session is a 91 kg plank on two feet, held by a scene chain at one end, the ball hooked to its underside while falling at 3.5 m/s.
The solve turned the plank 0.016 rad and moved it 14 mm down - 35 mm down at the hauled end, 7 mm **up** at the far one - and the foot's translation push-out then lifted the whole plank by the near end's depth, far end included, which the phase's books read as upward motion earned and a turn kept: -0.7 m/s and -0.7 rad/s on the snap frame, -2.2 and -1.7 the next, -3.9 and -3.0, -5.1 and -4.0, until at -6.5 m/s and -6.7 rad/s the plank left both feet and cartwheeled off on its own chain, reported as pulling the plank down making it fly up.
HEALTHY throughout: the energy monitor is disarmed while the aim turns the ball, and the rest of the invariants are about the ball.
The settle now pushes out at the point and through the body's inertia (`World.depenetrateRigidAtPoints`, as `refuseRopeBodiesIntoStatics` already did), so the foot turns the plank back out the way the haul turned it in - the same effective-mass split the solve wrote it with - and the frame's net displacement is the nothing a plank on two feet actually did; the snap frame ends at 0.03 m/s and 0.03 rad/s.
A scene-held body the feet refused is then handed to the ball's chain as **blocked**, so the ball takes the correction its anchor could not (`Rope.solveLengthHolding`, as for a path body no scene chain holds) and is arrested by the plank instead of left falling under it.
`cli contacts` `plank-haul` is the case - `plank-anchor`'s rig with a slack scene chain on the plank's end, which is the whole difference between the two - and it is red with the translation push-out put back.

What the settle **leases** is measured too, in the ball's phase's words (see `Rope.absorbBlockedLength` and `session-483f`): against what the pushing surfaces make unreachable, and bounded by how far they pushed.
It used to lease the whole residual on the strength of any push at all.
A push-out along a normal does not refuse a correction that was not along that normal, it deflects it: `session-497f`'s weight, hung beside the post on the chain that had just caught the post's corner, was pulled up and **into** the post, the post handed back the into-post share every frame, that share was leased, the loosened constraint let the weight settle a little lower, and the next frame paid the same share again - 0.5 mm of chain a frame, 24 cm over 480 frames, read from the game as the chain growing while the weight slid down the post.
Sliding up the post shortens the span, so nothing is refused, the residual is next frame's ordinary length error, and the weight hangs where its chain says.
`Rope.absorbBlockedLength` takes a refusal per pushed body now, since a scene chain has two ends and either may be the one standing in a surface, and the same account bounds every raise in the frame: `SceneChain.beginFrame` opens the geometry-push account at zero, so a sweep that ends short of convergence leaves its residual as residual rather than leasing it as if a surface had refused it.
The push floor is the engine's `PUSH_OUT_MIN_DEPTH` (`engine/world.ts`, shared with `BallLevel`), so a float-noise depth decides nothing here either.
`chain-post-catch` covers this half as well, and is red with the unmeasured lease put back.

What the pushing surfaces refuse a body is still **owed**, and it goes to whatever else the chain holds: after the push-out the settle re-solves each affected chain with the pushed bodies held immovable (`SceneConstraint.resolveHolding`, which for a chain is `Rope.solveLengthHolding` - the winch's own mechanism, and what the ball's phase already did for its own anchor).
Without that the refused share stood as over-length every frame, and the measured lease was honestly wrong about it: `session-527f`'s plank had fallen off its feet and lay wedged in the corner between the post and its foot, its chain running over the post's corner to the weight hanging free on the far side, and every frame the solve hauled the plank's share of the weight's gravity step 8 mm into the corner, the corner pushed it 8 mm back, and the settle, asked what the corner refused, said "all of it" - the plank's span is wedged shut - and leased it, though the weight could have taken every millimetre.
7.5 mm of chain a frame, the weight creeping down its chain for as long as nothing was hooked.
Hooked to the post it crept **up** instead, and that is the other half: the ball level settles the scene set twice a frame (once alone, once after the coupled sweep), the second settle found nothing left to push and overwrote the first's "blocked" with "not blocked", and the lease was handed back at the release rate into a live block.
A settle now records "blocked" for the frame cumulatively (`SceneChain.blockedThisFrame`, reset in `beginFrame`).
`cli contacts` `chain-wedged-end` is the case, on both legs - the set stepped alone, and inside a `BallLevel` with the ball hooked to a static - and both legs are red with the holding re-solve out (342 mm leased, the weight 243 mm down its chain in five seconds).
The accumulation has no leg of its own: with the refused share re-solved there is no lease for a second settle to release, so it is a correctness fix the case only covers with the re-solve out as well.
The arena's `session-2504f` was the same ratchet by another door: its 140 kg block sliding on a slope at the end of the crane chain leased 2.2 m over 1400 frames, and the release of that lease then winched the block up the slope - 24 J over 32 unforced frames, `energy-gained` at three points of the run - which the holding re-solve closes too, since the crane's hub takes the share the slope refuses the block.

### Anchors

A chain end is an **anchor object** on a body (`AnchorObjectData`), and a chain names its two ends by anchor **id** (`ChainData`) and carries nothing else.
That split is the point: a chain is the one thing in a level that is a **relation** rather than a part, so it belongs to no body and cannot nest - but each of its two *points* does belong to one, and nests like any other object.

It replaced a body **index** plus a pair of **world** coordinates per end, which was wrong in both halves.
An index made body order load-bearing: the legacy migration had to renumber every chain when several grouped entries collapsed into one body (`bodyOfEntry`), and any future reordering would silently re-tie the level.
A world point had to be re-derived against its body at load rather than simply riding it - the same defect body-relative object placement had already fixed everywhere else.
Now the anchor **is** the end: moving a body moves its anchors, turning it turns them, and there is no second copy of the point anywhere to keep in step.

`normalizeLevelData` converts the retired form at the one gate every level passes through - each end becomes an anchor object on the body it named, placed in that body's frame (the exact mirror of `worldPlacement`), and the chain is rewritten to name the two ids.
Anchors are **appended** to their body's object list, which is what keeps it bit-identical: collision objects build a body's shapes in authored order and an anchor is not one of them.
The anchors are folded in by **copying** the bodies that gained one, never by pushing into `body.objects` - for a file already in the nested form those arrays *are* the caller's, and mutating them made a second load find the first load's anchors and add another set beside them.

In the editor an anchor is an ordinary `EdItem` with `object: "anchor"`: a row in the outliner, a panel of its own, and a member of its body, so a body drag, nudge, rotate, duplicate or paste carries it with no special case.
It is deliberately **not** pickable on the canvas (`hitsItem`) and not caught by a rubber band on its own account - its canvas presence is the ring its chain already draws at it, and that ring is already the drag handle; an invisible 30 cm box sitting on the wall it is bolted to would just steal clicks meant for the wall.
`pruneChains` and `pruneAnchors` are mirrors and both run on delete, since either end may be what was deleted; `splitIntoBodies` sends an anchor out with its body's **first collision object** rather than into a body of its own, which would leave the chain tied to something that builds nothing.
`EdItem.anchorId` is preserved through a load and a save rather than minted fresh, because the id is content: a level that goes through the editor untouched comes back naming the same anchors.

(Hook-only scenery used to share the word as a `BodyKind`; it is the `passable` flag now, so an anchor is only ever a chain's tie point.)

Both the editor and the loader push an anchor onto the **nearest point of the body's surface** first (`nearestOnOutline` / `nearestOnCircle`).
That is what a chain bolted to a body means, and it is load-bearing numerically: an anchor in a body's interior leaves the span starting *inside* that body, the wrap generator resolves that as a self-intersection, and the chain winds around its own anchor - a weight authored hanging at rest reached **31 m/s** that way, against 0 once the anchor is on the rim.
The loader applies the same rule rather than trusting the file, so a hand-edited level cannot author the degenerate case either.

`length` absent means **taut** between the two anchors as they land, re-derived at load, which is what dragging one out gives; the inspector's `length` field authors slack, with a live readout of how much.
A chain whose two anchors are in the same body (merged together, say) is refused in the editor and dropped at load - it has nothing to constrain - as is one naming an anchor the level does not contain.
Chains carry their own selection, exclusive with the item and body selections: a chain has no shape, no placement and no properties in common with an item, so a mixed selection would have nothing an inspector panel could say about it.
The outliner lists them in a **`Chains (N)` section after the bodies**, and after rather than inside because that is what a chain is - its two anchors are objects and appear under their own bodies, while the chain itself belongs to neither. Each row is named by the two bodies it holds (their outliner numbers, so the name says where to look) with its authored `length` on the right, and clicking one selects that chain. Without it a chain was the one thing in a level with no row at all, findable only by clicking the rope on the canvas.
They are picked by a screen-space band around their span and edited by two round endpoint handles; dragging one **moves the anchor object**, and re-anchoring onto another body is the same act said differently - the anchor changes which body it is in - so sliding an end along its own body and moving it to a different one are one gesture.
In game they draw with the same forged links the ball & chain hangs on, laid along the wrap path and resolved against the render transforms; the editor draws them **straight**, because a span between wrap nodes *is* straight and a guessed sag would be a drawing of something the level does not contain.

Links are laid by **one continuous arc length** measured from the anchor end (`drawChainPolyline`), never per span.
A link straddles a wrap node rather than the run restarting there, which is both what a chain of rigid links does over a corner and the only form that survives a coil: `Rope` re-samples rope wound onto the ball every 0.25 rad, a node every ~3.1 mm on the rim and **shorter than one 3.8 mm link**, so laying links span by span floored every coil step to `floor(3.1 / 3.8)` = zero links.
The entire wound-on part of the chain drew as blank space, one node at a time as the ball turned - read from the game as the chain's nodes being deleted where they lay on the player (`session-1467f`).
The sim was correct throughout and every invariant, replay and bundle passed; see the frame grabber in the debugging steps.

### Wrap points

A chain may be **routed over** geometry: `ChainData.via` is an ordered list of anchor ids the chain passes over on its way from `a` to `b`, and each of those is an ordinary anchor object on a body, exactly as the two ends are.
That is the whole of the format: a wrap point is a point that belongs to a body and rides it, and the chain is still the only thing in a level that is a relation.
It exists because the scan cannot find such a route - a chain hung from a hub, up over a beam and down to a load is, as a straight line from hub to load, nowhere near the beam - and a level author has to be able to say it.

At load (`buildOne` in `level/chains.ts`) each wrap point becomes an **ordinary `RopeWrap`** handed to the `Rope` constructor, and its body is in the chain's wrap-candidate list as every wrappable body of the level is, so from then on it is exactly the wrap the ball's chain finds by scanning: re-resolved as the bodies move, slid along a circle to its tangent point, and **let go** by `cullDetachedNodes` the moment the chain pulls straight past it, which is what a chain over a beam does.
There is deliberately no pinned node kind: the same machinery, with the route seeded rather than discovered.
Three things about the seeding are load-bearing.
The point is snapped to the **nearest corner** of its piece (`snapToCorner`; the rim, for a circle), because a corner is what a rope bends around - a node on the middle of a face is one the rope hangs from with nothing under the bend.
The wrap **direction is the bend the authored route makes there** (`authoredWrap`), clockwise on screen or counter, because that is the statement a wrap node makes and the one the detachment pass holds it to; the scan's own chord-against-centre test agrees whenever a chord actually crosses a piece, and differs precisely on the routes the scan could not produce - read from the chord, the beam wrap was culled on frame one and the load fell.
It is one direction per **run** of consecutive wrap points on one piece, read at the run's middle between the points either side of the whole run, never per point: a pulley ringed with seven points gave each its direction from the near-zero bend between its rim neighbours, the last came out mirrored, and its exit tangent landed on the pulley's far side - the chain went over the top, back under, and off to the hub (`session-110f`).
One wrap point per piece is therefore enough, and a run is collapsed to one wrap of that piece.
And a single corner is completed **round the piece**: a chain over the near top corner of a beam whose far side the load hangs down is, as one node, a chain that turns over the corner and dives back through the beam, which the self-intersection resolver correctly refuses to continue (the next span circulates the other way) and the scan excludes (the span's own shape), so the loader walks the vertices in the bend's direction until the span on to the next point clears the piece.
That state is reachable in play only by history - the rope's end carried over the beam - and the walk is the history.
A wrap point naming an anchor that is not there, or one on a body that builds nothing, is skipped and the chain keeps its ends, as a vine keeps hanging when its second anchor is gone.
`length` absent is still "taut as authored", now measured along the route.

The chain **winds onto its `a` end**: the coil (`syncCoil`) is a property of the rope's start, so the drum of a winch must be the first body the chain was dragged from.

In the editor a wrap point is drawn as a **hollow ring** on the chain's route where an end is a filled one, and the chain is the polyline through them.
**Shift-drag** a selected chain to pull a new wrap point out of the span under the pointer and drop it on a body (over nothing the gesture is abandoned); its handle drags like an end's and lands on the nearest corner of whatever it is dropped on, an end's own body included; the chain panel lists them in route order with a `×` each and a `+ Wrap point` button for a route too short to drag from.
Deleting a wrap point's body drops it from the route and keeps the chain (`pruneChains`); a copy that did not take the body along drops it the same way; `pruneAnchors` counts a wrap point as used.

`cli contacts` `chain-wrap-point` is the crane: a two-piece pivot wheel (chain-through rim, winding hub), a beam with one authored corner, a stone box - the route builds as hub, both top corners, box; the box hangs plumb under the far corner; 4 rad of hub hauls it up by hub radius × angle; unwinding lowers it; the rim is never on the path; and a dead wrap point is skipped.
`cli render3d` checks `via` and `wrappable` through the scale every load applies and through the editor round trip.
