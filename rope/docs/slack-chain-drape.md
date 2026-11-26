# The slack chain drape

A deployed ball chain with length to spare no longer draws as straight spans: `SlackChain`
(`classes/slackChain.ts`) is a **visual-only** simulation of the loose chain - a fixed-count
Verlet particle chain pinned at the mounting loop the chain leaves the ball through (the
chain's start contact) and at the far end (flying hook, dangling tip, or anchor).
It sags in a catenary, drapes over the ball and the scenery, and heaps on the floor.
When the chain is let go the same drape carries on as the reel that hauls it back in, stepped by the render side from there: [chain-retract](chain-retract.md).

**The coil is part of the drape, not a kinematic prefix to it.**
The solver's coil is the angle of rim between the loop and the tangent point toward the next node, which is the right reading of a chain under tension and a fiction for one with length to spare: nothing holds a slack chain against the rim, so it hangs from the loop and lies wherever gravity and the scenery put it, and the ball's own rim is scenery the drape collides with like any other.
Pinned at the tangent point instead, the drape started a quarter turn round the ball from the loop and only the run beyond the tangent had the slack in it, so a ball that had rolled over its own chain drew the chain hugging its underside and climbing its far flank to leave cleanly toward the anchor with 13 cm of slack folded into the last span (`session-232f` f184-232, reported as the chain sticking to the side of the ball instead of drooping).
At taut the sag bound below carries the nodes onto the solver's rim samples, and the collision pass that ends every step then stands them off the rim by the chain's half-width, so a wound-tight ball draws its coil where the solver says it is, lifted onto its broad links (`cli shot` on a `ball-ground-wind-up` recording is the check).
That lift is the one place the drawn chain cannot be its own length: the solver winds a rope of no thickness onto the rim, and a centreline a half-width `h` out is `h` longer per radian of wrap, so a coil drawn round the 12 cm ball runs 18.7% long and its links are drawn that much longer (see "The links are counted by the chain's length" below).
The same holds, by `h` times the angle turned, round any corner a taut chain wraps.
It is strictly one-way: it reads body transforms and the wrap path at the END of the physics
frame (`BallLevel.physicsProcess` steps it last) and writes nothing back - no forces, no
impulses, no positions - so every replay, digest and invariant is bit-identical with it in
(asserted the usual way: the whole corpus replays byte-for-byte across the change).

Both renderers draw its polyline instead of the chain's spans (`pathLoopToAnchor(alpha)`,
with both ends welded to the render transforms so the chain never detaches from the drawn
ball or manacle); `cli render` overlays it in green over the wrap path's amber, which
coincide exactly when the chain is taut.

**The links are counted by the chain's length, not the polyline's.**
Both renderers lay the ball's chain anchor first, so that a reeling chain is consumed into the ball, and they used to lay it at a fixed link pitch.
But the drape only converges toward its length: a heap held by static friction and a hanging run the passes leave stretched draw a polyline a few percent long, and that error breathes.
At a fixed pitch, every change in it slid the whole train of links along the chain, out of the ball and back in.
On `session-339f` the drape over a ledge ran 1.80 to 2.01 m and back to 1.89 m with the chain's length fixed at 1.80 m, which was drawn as 47 to 53 to 50 links out of the ball: the chain growing and receding into the ball for no reason.
The count is now the chain's length's (`SlackChain.chainLength`, interpolated between steps like the nodes), never the polyline's, and the pitch is whatever lays that many along the polyline (`render/ballChainPath.ts`), each link drawn that long inside so neighbours always bear on each other.
A chain whose length does not change keeps its links; the drape's error shows as links a few percent long instead.

The chain is **shackled to the ball's loop** whenever no throw is paying it out: its last link hooked through the loop's hole, its end bar bearing on the inside of the loop's bar on the side the chain pulls toward.
The loop lies in the gameplay plane, so that link is the edge-on one, as is the link on the cuff's hinge pin; both ends edge-on is an odd number of links, so a shackled chain always has the nearest odd count to its length in links (Tris, 2026-11-12).
The length only changes while a throw pays out or a release reels in, so the count snaps only at the moment the chain stops moving (49 links for the 1.8 m chain).
While a throw pays out, the chain is laid on past the loop into the ball's centre instead, as many links as fit, so they slide out of the ball as it goes.
Laid that way at rest, the chain crossed the loop's bar and ran into the ball's surface beside it (`session-234f`).
The loop the chain is shackled to is the ball model's (`BALL_LOOP_*` in `render/chainMetrics.ts`, measured off `iron-ball.glb`; the stand-in torus drawn before the model lands is the same), the glass ball's ring, or the 2D renderer's circle; the links' bar is the model loop's bar (13.2 mm on the 12 cm ball), and every other link dimension follows from it.
The model's loop is centred 12.24 cm from the ball's centre with a 2.66 cm outside radius; the collision loop (`BallPlayer.LOOP_GAP`, `LOOP_RADIUS`) is centred 13.5 cm out with a 2 cm radius, so the drawn loop and the collided one do not quite coincide.

Each link is laid as the chord between its two ends on the polyline, at `±pitch/2` from its centre (`walkChain`), which is what a rigid link hooked into its neighbours is.
Laid on whichever span its centre fell on, a link at a sharp kink snapped between the two spans' headings on every sub-millimetre jiggle of the node it straddled, a quarter turn back and forth under a ball lying still (`session-685f` f600-685).
With the bend limit below, links turning more than 30 degrees one frame and straight back the next went from 71 to 3 over that recording, the 3 during fast whips.

**The drape ends where the chain reaches the ring.**
A cuff clamped round a rail (a rod, a vine ring) ends the solver's chain at the ring's centre, and the drape is pinned at the ring's rim instead (`rimPoint`), the end the chain is hooked over.
A wrap closer to the ring's centre than that rim is chain the ring already holds, so the drape's path drops it (never the loop) before it is sampled and measured.
Kept, the path ran on past the rim and doubled back to it.
On `session-668f` the ball wound in against the lantern its cuff is clamped to (the chain 3.1 cm long, the solver's path leased to 6-10 cm round the ball's rim): the last rim wrap lay 2.3 cm from the ring's centre with the rim 4.5 cm out on the loop's side, the drape's path went on round the ball and came 4 cm back, and as that wrap came and went on alternate steps the drape's length flipped between 3.7 and 7.5 cm.
The links are counted by that length, so the chain was drawn one link, then three, then one, folded over itself (f596-606): 60 one-frame link-count blips over the recording, 1 with the path ending at the rim (f467, where the cuff's rim came within half a link of the loop and the renderer drew none for a frame), and none since the one link is drawn rigid (see "Open" below).
The drape's length still steps when the ring's rim moves (the ring tilts, or the chain re-hooks over its other end), which is the sim's own choice of where the chain leaves the ring.

Five mechanisms carry the requirements:

- **Length is preserved.** The drape's rest length is the whole wrap-path length plus the
  slack the solver is not using, so the drawn chain is the length the chain actually has.
  Equality distance constraints plus long-range attachments from both pins kill the
  sag-stretch a few Gauss-Seidel passes leave (measured: within ~3% of target in every
  scenario, where a plain PBD chain drifted 20%).
- **Compression buckles.** A chain pressed shorter than its length must fold, and the
  distance correction acts only along the segment, so a collinear compressed run has no
  lateral gradient and Gauss-Seidel would leave the drawn chain simply shorter for ever.
  A segment compressed past a few percent is nudged perpendicular, alternating sides, and
  gravity plus the floor settle the folds into an honest pile.
- **It bends no tighter than chain can.** One link can stand square to its neighbour (a
  chain over a sharp edge) but cannot fold back on it, so real chain turns at most a
  quarter turn per link pitch. The drape's segments are shorter than a link, and with
  nothing holding that the buckling nudge pressed heaps into hairpins one segment wide.
  A link laid across one had its two ends on the two arms and swung through a quarter
  turn on every millimetre the fold moved (`session-685f` f639, f676-679).
  `solveBend` holds the textbook PBD bend: a minimum distance from each node to the next
  but one, `2·restLen·cos(θ/2)`, with `θ` the quarter turn shared out over the segments
  in one pitch.
- **Friction has a static half, in position.** Velocity friction cannot stop a drape on a
  slope for the reason the engine's position pin exists: the verlet step takes gravity's
  displacement before anything resists it, and the tangential remainder after the push-out
  is position creep no velocity term sees (~8 cm/s on a 30° ramp, at almost no reported
  velocity). A contacting node whose tangential travel this step is under `STICK_STEP`
  (2.5 mm ≈ 0.15 m/s) has the whole of it removed, so resting chain sticks and a genuinely
  hauled one slides against the velocity friction alone.
- **Collision is one-way and wrap-shaped.** Nodes are pushed out of every `wrappable` shape
  of every SOLID body (the same set the rope solver may wrap, so the mounting loop, vine
  links and hook-only grates are excluded and the ball's own rim is not), with dead
  restitution and strong tangential friction; the far-end body itself is skipped, since the
  chain threads into the manacle.
  A node keeps **half the broad link's outside width** clear (`NODE_RADIUS` =
  `CHAIN_LINK_HALF_WIDTH`, derived from the link in `render/chainMetrics.ts`, 22.4 mm at
  the 13.2 mm bar): the broad links lie in the gameplay plane, so they are what a chain
  rests on. It was a hard-coded 9 mm, half the 1.8 cm link of its day, and stayed 9 mm when
  the links grew to DIN 766 proportions; every broad link of a resting drape then sat
  13.4 mm inside what it lay on, read as the chain passing through the box it was wrapped
  round (`session-276f`, 14-16 nodes at that depth in the box and the ball on every frame
  from f214). The reel and the snapped halves share the constant.
  Three things about the push-out were each found on `session-1038f`, the slack chain
  draped over the swinging lantern falling through it, and none of them is optional.
  Friction is measured **relative to the surface** (the body's frame-start pose is its
  captured render transform, so a point's motion over the frame is exact): a node resting
  on a body that moves rides it, where world-space friction held it still while the lantern
  swung out from under it.
  A node inside a vertex loop is pushed out through **the face it came in by**
  (`circleOverlapFrom`: the least penetration among the faces its step-start position,
  carried along with the body, was outside of), not the shallowest one: the constraints
  dragged a node from the top of the lantern's chimney down past its middle in the four
  iterations between collision passes, the shallowest face was then the side, and the
  chain cut straight through the glass with its two neighbours held 11 cm apart on
  opposite faces.
  And a node is passed over the shapes near it **until it ends the step clear of all of
  them** (`SEAM_ROUNDS`): a compound body's pieces overlap at their seams, a push out of
  one lands inside the next, and a node left inside starts its next step with no side to
  have come from. Remembering each node's last clear position as its came-from side was
  tried instead and is worse: a node on the taut path touches a surface every step, so
  that memory dates from before the previous taut episode and points the wrong way.
  **A node the sag bound moved came from its target on the path.**
  The solver's path is the chain, so its side of anything the chain is wrapped round is the right one.
  But a drape thrown round a 20 x 10 cm box sags under a corner while the solver's straight span passes over it (honestly: the solver's spans do not sag), and every step after, the bound pulled its nodes onto the solver's side and the came-from push-out, reading the side they started the step on, handed them straight back.
  Taut, the drape ran under the box while the chain was wrapped over it, for good: 203, 343 and 228 frames of `session-256f`, `session-386f` and `session-276f`.
  Pushed out by the bound's side, the drape is on the solver's side on every taut frame of all three (`scripts/test-chain-drape.ts`, which is red on all three without it).
  The side was first taken from where the bound PUT the node, and that is not always outside: the bound pulls a node straight at its target, through whatever is between, and a target on a face of the box the chain is wrapped round lands the node inside the box.
  A side inside the box is no side, so `circleOverlapFrom` fell back to the shallowest face and neighbours split out through opposite faces.
  On `session-53f` the hook flying round the box took up the slack (4.2 cm to 0.85 cm on f36), the bound pulled nodes 45-58 into the box, 46-49 left by one long face and 50-54 by the other, and the chain was drawn through the box on a 14.5 cm segment (f36-37, reported as the slack chain phasing through the rectangle).
  The side is now the target itself, which lies on the wrapped faces, and the push-out counts a point within a micrometre of a face's plane as outside it (`BOUND_ON_FACE`).
  Without the target's side the drape on those frames (and on `session-386f` f38) wound a whole turn the other way round the box from the chain.
  **The drape collides continuously** (2026-11-20).
  Both ends of the drape are pinned where the chain's are, so as long as neither passes through a piece the two can never be wound round one differently: every frame the drape has gone round a piece the other way from the chain, something of the drape went through it.
  On `session-58f` (reported as the chain phasing through the box and snapping back once taut) the hook flew past the 20 x 10 cm box, the chain touching only its near corner and the drape, with 6 cm of slack, lying over it and hanging down its far end; a long-range pass with the ball pulling away at 6.7 m/s dragged four nodes straight through the box in one step (f34-35), corners passed between nodes, and the bound pulled nodes at arc-length targets 33 cm away through it, until the drape hung under the box the chain was over (f35-40) and was hauled back through as the slack ran out (f41).
  The drape test's statement that it never winds round a piece the other way from the chain, slack or taut, is red on `session-58f`, `session-53f` and `session-386f` without what follows and green with it.
  Every sweep and came-from is taken from where the node was **last clear within the step** (`clear`): where it ended the last step or where the bound laid it, then wherever each collision pass leaves it.
  This is not the last-clear memory across steps rejected above, which dated from before a taut episode; it is reset every step.
  - **Nodes are swept** (`sweptEntry`): a node whose straight move from its last clear position crossed an edge of a piece is put back where it went in, then pushed out by that face; a start on a face counts as going in through it at once, or a node the bound laid on a face slipped out through the far one.
  - **Segments are swept** (`pushSegmentsOut`, `vertexCrossed`): two nodes clear of a piece on two of its faces hold the segment between them across the corner, and nothing else pushes back on a segment.
    Each segment is held the broad link's half-width off every vertex that projects onto it, on the side the vertex was on: a vertex that lay on the segment at some moment of its linear move from its last clear position (the textbook 2D edge-vertex test, the roots in [0, 1] of the quadratic the cross product makes) went through it and is put back on the side it started on; one that did not stays on its side; a segment already across a piece with no vertex crossing it is put out away from the piece's centre.
    The move is the edge-vertex contact, the vertex's projection moved clear along the segment's normal and shared between the two nodes by where it falls (`1 - t`, `t`).
    On `session-53f` f25-27, before it, the segment between nodes on two faces of the box cut its corner 8 mm, then 29 mm, then crossed it through its middle.
    **A corner the solver's chain is wrapped round has no came-from to ask** (`WrapCorner`): its side is the outside, the drape going round it as the chain does, and a crossing of it puts the segment out along the corner's outward bisector whatever side the segment started on.
    The came-from is wrong there in a way the bound makes: it lays nodes on their targets along the wrapped faces, the chord between two targets either side of the corner cuts it, the node pass pushes both ends out, and the corner reads as having crossed the segment, so the came-from put the segment back across the corner.
    On `session-256f-jumps` f187 that put a segment 46 mm into a rock, and the next pass, finding segments across a 1.6 m sliver of it, put them out away from its centre, past its far end: a node thrown 5.4 m in a step (f188).
    Distrusting every crossing of a segment that started across a piece fixed that and sent `session-58f` the wrong way round the box for a frame (f41), where the starting side was the right one; pushing such segments by the smaller of the two moves put segments through the box on the box recordings for up to 340 frames, weighing only the corners that project onto the segment.
    The wrap node is on the vertex itself (0.00 mm on every wrap of that run), so a vertex is matched to it by position.
    Not the circle the chain is coiled on: the circle a drape lies on most is the ball's rim, where holding the coil's chords off it pushed the coil out 0.7 mm (their sagitta) on every pass and pushed a drape squeezed between the ball and the box into the box.
    Every other circle is a **bar** (`Candidate.bar`), a ladder's rung above all, and its centre is the one vertex: a segment is held off it by the bar's radius and the link's half-width, less the sagitta of a chord of the chain's own pitch (`pitch`), so a drape wound round a rung at its pitch is never pushed; the side is the same came-from, the centre crossing the segment this step putting it back on the side it started on.
    A bar is swept as its circle in the node sweep too (`sweptEntry`), and neither answers for the stretch of a bar inside the cuff's disc.
    Without them, on `session-259f` (the ball wound round the rungs of a ladder swinging on a rigid body) a ball pressed against a rung squeezed the drape out of the gap the solver's chain, with no thickness, passes through, and a 10.7 cm segment cut 13 mm into the 36.5 mm rung (93 frames, f141-196).
    With them the drape gives way into the ball instead, as it does beside a box: up to 21 mm, on 94 frames.
    It runs once, after the nodes, and last: a node pass after it put corners back across segments (5-8 mm on three recordings), and a second segment pass or sweeping until nothing moved pushed nodes 20-30 mm into the pieces.
    A first build that put segments out away from the piece's centre without asking whether they crossed it at all pushed segments metres off the introduction's rocks and threw the drape about (`session-310f`: 2-7 m segments, nodes 6 m past the Verlet fence in a step); the drape test's per-step fence statement holds it.
  - **The bound goes round the pieces** (`boundRoute`): a node's reach to its target is measured along a side of the convex hull of the node, its target and the pieces the straight line runs through, and a node too far is moved along it, so the drape slides round a corner rather than being pulled through.
    The side is the one the drape is wound by, not the shorter: on `session-58f` the shorter way from a node at the box's top corner to its target was under the box while drape and chain both went over (f37).
    Which way that is, is asked of the node and the node before it (`windsRound`): the closed loop of the path's span between their two targets, this node's way back from its target, the drape's segment back to the node before, and that node's way to its own target must hold none of the piece (an integer winding number).
    It is asked when the straight line to the target is clear too: a straight line clear under the box is still the wrong way round it when the node before went over.
    And it is asked of the drape as it stood before the bound moved anything, each node's way starting where the node was.
    On `session-256f` f41, without these, a drape thrown over the box hung down its far end and back under it; the bound routed node 31 back over the top and left node 32, whose target on the near face was in reach along the clear straight line under the box, where it was, and the segment between them lay 49 mm through the box.
    The nodes after it, asked against that drape, were routed under the box, and the drape came round it the other way from the chain for three frames (f41-43; f51 of `session-276f` the same).
    A node's way that says nothing about its side (`BoundWay.sided`) is not what the next node is asked against: a node inside a piece, a straight line through one the bound fell back to, or a side picked as the shorter of two that are both the wrong way.
    Asked against node 31 of `session-58f` f36, which the Verlet step had left 7 mm inside the box, every node after it was routed under the box the drape hung over.
    Asked of the whole path and drape from the loop, as a first build of this was, a drape honestly sagging round a rock the chain passes clear of makes every node after it read as the wrong way round that rock, so it is asked of the one stretch between two nodes.
    Across the 194 scratch recordings the change took frames with a segment through a piece from 82 to 0 on `session-234f-loop`, 122 to 0 on `session-485f`, 165 to 5 on `session-473f` and 115 to 77 on `session-211f-1`, and made none worse.
  - **Long-range attachments hold only in the clear** (`reachA`/`reachB`): one clamped through a piece pulls the drape toward the pin the way the chain cannot go, and on `session-58f` pulled the hanging run down and round under the box toward the ball; an attachment whose straight line to its pin crosses a piece is off for the step.
  - **A collision pass wherever a node has moved far since the last** (`COLLIDE_MOVE`, a quarter of the node's radius), and on the first and last constraint pass always, so each sweep is a short, straight move.
    At every fourth pass by count the drape still came off the box on `session-58f` and `session-256f`, and with 8-12 passes instead of 16 it came off on `session-58f` again.
    By distance the drape test holds to 10 mm and fails at 20 mm (`session-58f` off the box again).
    The first pass is not optional: a step that starts with a node inside a piece, which the segment push-out a step ends with can leave, otherwise met the same node in the same place on its one final pass every step (15-27 mm into the box for 182 frames of `session-256f` at 5 mm without it).
    A skipped pass's friction is applied by the next (`keep`), so a drape slides the same however many passes it skipped.
  - **Each piece is read into world space once a step** (`WorldLoop`, `circleOverlapFromLoop`): its face normals and plane offsets as plain numbers, so the per-node test is a few multiplications a face instead of a rotation into the piece's frame, a trig-slot lookup and several allocations.
    The same planes and the same choices as `circleOverlapFrom`, to rounding: asked the same 3.6 million questions on the drape recordings' own states, the two agree to 1e-10 m (a rect counts a point within sqrt(EPS) of its surface as on it, a poly within EPS, and the loop keeps each shape's own answer).
    The sweeps and the segment push-out read the same loop, in plain numbers, bit-identical to the vector code they replace.
  What it costs, in bun on 2026-11-20 (one harness, a warm run of each recording): the drape's step is 0.34-0.46 ms round the box, against 0.16-0.21 ms without the sweeps and 0.45-0.60 ms with a collision pass after every constraint pass; over the introduction's rocks (`session-310f`) it is 0.39 ms, against 0.44-0.51 and 1.6 ms, the drape at rest there colliding about 5 times a step.
  On `session-668f` (2026-11-27, the ball hung wound on a minecart, then wound in against the lantern on it) it is 0.89 ms, over the live budget on 492 of 508 steps: 0.53 ms the node passes, 0.20 the segment pass, 0.09 the candidates and the bound's routes, 0.07 the constraints.
  Two things multiply: 31-37 candidate pieces a step (the cart and the lantern are compound bodies; 5-8 on `session-310f`), and 16 collision passes of 16, because the node next to the loop's pin never settled.
  **The loop end is pinned on the loop's bar** (2026-11-27), a link's half-width out from the rim the solver starts the chain on, where every node lying on the ball is held; the length is still measured from the rim, as the solver measures it.
  Pinned on the rim, the node next to the pin was pushed 22.4 mm out on every collision pass and pulled back by its segment on every constraint pass in every chain shorter than 64 node radii (1.43 m), so the movement gate never skipped a pass; the leg it spent going out is inside the drawn loop.
  On the bar, `session-668f` collides 10.5 times a step instead of 15.7 and its step is 0.72 ms instead of 0.89; the drape recordings collide 2-25% less, except `session-256f-jumps` (8.3 to 9.4).
  What still keeps the gate open there is the drape squeezed into a gap it does not fit: between the ball and the cart's side (f150, a node 23 mm inside the ball) and between the ball and the lantern (f500-656, 15-16 passes a step).
  Measured from the bar, the drape's length changed with the angle the chain left the loop at and the link count stepped as the ball turned (`session-276f` f98), which is why the length is not.
  The live budget is 0.5 ms (main.ts): a step past it keeps all its constraint passes but collides only every fourth from then on (still only where a node has moved far), and past four budgets it stops after its next collision pass.
  With that fallback forced on for whole runs, standing for a machine always behind, the drape test fails 6 statements on 4 recordings (`session-256f`, `session-276f`, `session-386f` crossings, `session-58f` off the box f37-39), against 9 on 5 with a collision pass every pass; at a live 0.25 ms it fails only `session-386f` f371, which fails there either way.
  The drawn chain stands round the outside of a piece by the link's half-width where the solver's chain wraps it with none, so on the box recordings it runs longer than its length more of the time than before (90th percentile 1.15-1.20, from 1.04-1.17), drawn as links a little long.
  `session-256f` f41-43 and `session-276f` f51, which came off the box in the throw, were the sag bound's way round (see "The bound goes round the pieces" above), not the segment pass they were first put down to.
  Open, on the scratch recordings (neither drape test recording): the drape round a piece the other way from the chain on `session-1256f-spin` (6 frames), `session-646f-torque` (8) and `session-406f` (5); a segment through a piece on `session-211f-1` (77), `session-702f` (23), `session-473f` (5), `session-406f` (4) and `session-166f-2` (1); and a taut drape on `session-821f` (the chain wound round the ball, ending on a frame of slabs) ending its steps 20-40 cm off its path from about f599 on, though the bound puts every node on the path at the start of each, and one node thrown 2 cm past the fence (f650); cause not measured yet. All were there before the way round changed.
  Open, measured on `session-668f` (2026-11-27): a chain wound in to a link or two against the body it is anchored on cannot be drawn its length.
  Both pins sit inside the band the drape is held out of: the loop's pin is on the ball's rim, 22.4 mm under the nodes lying on it (the first segment is 2.2 cm long on nearly every frame of every recording, hidden inside the drawn loop), and the ring's rim lands on or inside the ball (r = 11.3 cm on f435).
  The lantern pressed against the ball leaves a gap the solver's chain fits and the drape does not (as beside the box above), and the node sweep holds the drape's nodes behind it: on f569-581 most of them sit in two clumps, one is thrown 9 cm, and the one link drawn is 14-60 cm long.
  Over f375-656 the one or three links drawn are more than a quarter long on 158-181 of 282 frames, with or without the path ending at the rim.
  Three changes to the drape were measured and none taken: holding the drape off the ball only as high as each node can reach from the pins (worst link 16x to 4.7x, but nodes through the ball on 105 frames against 50); dropping long-range attachments whose line crosses a circle (worse on f100-200); and pinning the drape at the loop's bar rather than the rim under it (little change to the stretch; kept for its cost, see above).
  What is drawn is settled instead: a chain short enough to be **one link** is one straight rigid link from the cuff at the loop, whatever the drape is doing (`ballChainLayout`, Tris 2026-11-27), at its own length or across a longer gap the sim leaves; drawn more than a quarter long on 25 frames (at most 1.46x, the gap) against 173, and no link appearing or vanishing for one frame (60 blips before).
  The drape itself still thrashes there, unseen, and costs for it (see the cost below).
  The released chain's reel (`render/chainReel.ts`) and a snapped chain's halves (`render/chainSnap.ts`) still collide by node alone.
  They are stepped by the renderer only, so no recording measures them yet, and they were left as they were.
  **A swept push-out was built and taken out.**
  The long-range attachments clamp a node to a straight-line reach of its pin, through whatever the chain is wrapped round: with the ball pulling away at 6 m/s one pass carried a node 16.6 cm from the top face of the box to below its bottom face (`session-256f` f38), where it ended outside the box and the push-out saw nothing.
  Sweeping each node from where it last stood clear, and sampling spans stretched past 1.5 node radii so a corner could not pass between two nodes, was tried on 2026-11-12.
  With the bound's side in place it bought 1-3 frames of a throw on those recordings and cost a quarter more drape time, and the test, which then checked nodes only, was green without it.
  It is back, swept from where each node was last clear within the step and after every constraint pass (see **The drape collides continuously** above): the drape test now asks which way the drape is wound round each piece, which it then did not, and node sweeps alone did not keep it wound with the chain.
  A ball resting against the piece the chain is wrapped round leaves a gap that the solver's chain, which has no thickness, fits and the drawn one does not; the drape is pressed into the ball there (`session-256f` f173, `session-386f` f368, up to 18 mm), and until the segment push-out its segments also cut the piece's corner by 2-9 mm.
- **Taut is the limit of almost-taut.** Sag grows like the square root of slack, so even
  millimetres of slack sag visibly, and a renderer that switched representation at taut
  would show the chain snapping straight in one frame.
  Instead the drawn chain is ALWAYS this polyline, and every node is held within a **sag
  bound** of its arc-length position on the wrap path - `SAG_BOUND_FACTOR` times
  `sqrt(path length x slack)`, the sag a chain with that much slack can hang with, which
  closes with the square root of the slack and is exactly zero at taut - so the drawn shape
  is a continuous function of the physics state and there is no frame on which the
  representation changes.
  The bound stands clear of an honest drape (a shallow chain sags 0.61 of that root), so a
  chain with room to sag hangs by its own physics and is only gathered onto the path as the
  slack that let it sag is taken up; the last millimetre closes the last two centimetres,
  which is the root's own slope and what a chain coming tight does.
  It was a per-step position lerp toward the path, weighted linearly over the last 10 cm of
  slack, and that is effectively a switch: a lerp of a few percent a step moves a node
  centimetres against gravity's 2.7 mm, so the drape was flattened onto the path - and onto
  the coil's rim - a full 10 cm of slack early (`session-232f` f216-232, 8 cm of slack
  drawn as a taut chain climbing the ball's flank).

Nothing gates the look (a drape is exactly the kind of thing the suite cannot see - see
[**What the verification suite cannot see**](debugging-physics.md#what-the-verification-suite-cannot-see)); what was measured when it was built: worst
single-frame interior-node motion beyond what the endpoints moved is ~2 cm (sub-link), floor
penetration is exactly zero, and the whole sim costs ~0.1 ms a frame inside the 16.7 ms
budget.

**It is the one simulation allowed to run out of time.**
"~0.1 ms a frame" was a hanging chain in an empty scene; a wound coil beside the lamp on the ball arena cost 0.88 ms of a 2.9 ms step in bun (`session-417f`, the ball hanging off the lamp), and under a 4x CPU throttle in Chromium that step was 14 ms, which is what turned 144 Hz into 27 Hz the frame the hook took: a step over 16.7 ms puts the catch-up loop two steps behind every rendered frame.
Nearly all of it was the narrowphase re-reading each candidate shape's extents and world centre on every one of its 756 visits a step (63 nodes x 3 seam rounds x 4 passes), most of them to be rejected by the box test.
Each survivor of the AABB gate is now read once into a `Candidate` (centre, half-extents grown by the node radius, whether its owner moved this frame, whether it is the cuffed body), the visit is four comparisons, and `carried` / `was` - the identity for a body that did not move, which is the scenery - are skipped for one.
Bit-identical drape output on `session-417f`, `session-1038f`, `session-291f` and `session-1080f`, and the step halved (0.49 ms in bun).

What is left is bounded rather than optimised: `SlackChain.timeBudgetMs` is a wall-clock budget per step, checked between the Gauss-Seidel blocks (four constraint passes then a collision pass), and once a block ends past it the rest are skipped.
Every step runs at least one block, so the frame still ends clear of the scenery; a cut step loses convergence - a little stretch in a drape being flung about - and the next step takes it up.
It is `Infinity` by default, which is what every tool and the self-replay verdict want (a drawn drape that depends on the machine is not a reference frame), and main.ts sets it to 0.5 ms for the live page, several times what the drape costs on an idle machine and 3% of the step, so it bites only when the machine is behind.
Measured at the 4x throttle: the drape's share of the step fell from ~4 ms to 2 ms with the cache alone and to 1.1 ms with the budget, the floor being that first block; the step is ~10.5 ms on the hang now, and the rest of it is the coupled scene-chain sweep and the depenetration passes, which are the sim's and not the drape's to cut.

### Audio contact telemetry

`contactSnapshot()` exposes per-step contacts without changing the solve: one node/shape entry across repeated collision passes, with pre-damping normal approach and final surface-relative sliding. Audio uses these for individual link-impact gestures and scraping. Local bend changes drive separate articulation gestures. The snapshot remains cosmetic; it contributes no forces, digests, or replay state. Taut interior shuffle requires genuine endpoint/material transport before it can drive scraping (session-604f).
