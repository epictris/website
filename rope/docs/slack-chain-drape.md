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
  The segment push-out below also clears that segment, but by the nearer end of the box: without the target's side, the drape on those frames (and on `session-386f` f38) wound a whole turn the other way round the box from the chain.
  **Segments are held off corners.**
  The node push-out keeps every node clear, but two nodes clear of a piece on two of its faces hold the segment between them across the corner, and nothing pushed back on a segment.
  It grows when a drape slung over the end of a thin piece is hauled: on `session-53f` f25-27 the nodes on the box's two faces were dragged along them away from the end, each kept on its own face by the came-from push-out (right for each node), and the segment between them cut the corner 8 mm, then 29 mm, then crossed the box through its middle.
  Neither switching off the long-range attachments (the crossings moved but did not go) nor colliding after every constraint pass instead of every fourth cleared it.
  `pushSegmentsOut` is the textbook edge-vertex contact: after the nodes, each segment between two free nodes is held the broad link's half-width off every vertex that projects onto it, moved along its normal away from the piece's centre, the move shared between its nodes by where the vertex falls (`1 - t`, `t`) so that the point moves the whole way, repeated up to `SEAM_ROUNDS` times.
  The side is right for any cut caught while it is shallow, and a cut starts at nothing.
  A vertex over the segment on the far side from the piece's centre counts only if the segment crosses the piece's edges: on a piece much bigger than the segment (the introduction's rocks) such a vertex can stand metres off a segment lying nowhere near it.
  The first build did not ask, pushed segments those metres, and threw the drape about on its first playtest (`session-310f`: 2-7 m segments, nodes 6 m past the Verlet fence in a step and 2.26 m deep in rock); the drape test's per-step fence statement holds it, red without the crossing test.
  It handles vertex loops only: a circle has no corner, and the circle a drape lies on most is the ball's rim, where holding the coil's chords off it pushed the coil out 0.7 mm (their sagitta) on every pass and pushed a drape squeezed between the ball and the box into the box.
  The segment check in `scripts/test-chain-drape.ts` was red on all four recordings before it (5, 10, 2 and 4 frames, up to 50 mm through the box: the throw frames the bound's side left, and the taut frames below) and is green after.
  It costs 0.01-0.08 ms a step in bun, 16-30% of the drape's step.
  **A swept push-out was built and taken out.**
  The long-range attachments clamp a node to a straight-line reach of its pin, through whatever the chain is wrapped round: with the ball pulling away at 6 m/s one pass carried a node 16.6 cm from the top face of the box to below its bottom face (`session-256f` f38), where it ended outside the box and the push-out saw nothing.
  Sweeping each node from where it last stood clear, and sampling spans stretched past 1.5 node radii so a corner could not pass between two nodes, was tried on 2026-11-12.
  With the bound's side in place it bought 1-3 frames of a throw on those recordings and cost a quarter more drape time, and the test, which then checked nodes only, was green without it.
  A ball resting against the piece the chain is wrapped round leaves a gap that the solver's chain, which has no thickness, fits and the drawn one does not; the drape is pressed into the ball there (`session-256f` f173, `session-386f` f368, up to 18 mm), and until the segment push-out its segments also cut the piece's corner by 2-9 mm.
  **Open: a drape wound the other way round a piece from the chain flips through it as the slack runs out** (`session-58f`, reported 2026-11-20 as the chain phasing through the box and snapping back once taut).
  The hook flew past the 20 x 10 cm box: the chain touched only its near corner, while the drape, with 6 cm of slack, lay over the box and hung down its far end.
  Two things then carried the drape under the box (f34-36): a long-range pass, with the ball pulling away at 6.7 m/s, dragged four nodes straight through it in one step, ending clear on the far side where the push-out never saw them; and the sag bound pulled nodes over the box straight at arc-length targets on the near face 33 cm away through it.
  When the hook bit under the box (f41) the bound hauled the drape back across.
  Three things were built on 2026-11-20 and taken out, none closing it: a swept push-out (a node whose move crossed a piece stopped where it went in) stopped the tunnelling and moved the flip a frame later; the bound measured round the pieces (the shorter side of the convex hull of node, target and the blocking pieces, the node moved along it) stopped the bound pulling through, but the node then went round the box in one step, which render interpolation still draws as through it; and long-range attachments dropped while a piece stands between node and pin.
  Together they roughly halved the frames the drape winds the other way from the chain on the six drape recordings, but stretched the drawn chain by up to 1.55x its length (from 1.18x), because a drape held on the far side of a piece the chain does not wrap is longer than the chain.
  The root is that a slack drape may honestly wind round a piece the solver's straight span does not, and the arc-length targets know nothing of it; the fix is probably in the drape's notion of where each node belongs, not in its collision.
  The released chain's reel (`render/chainReel.ts`) and a snapped chain's halves (`render/chainSnap.ts`) still collide by node alone.
  They are stepped by the renderer only, so no recording measures them yet, and they were left as they were.
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
