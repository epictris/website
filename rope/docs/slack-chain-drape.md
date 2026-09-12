# The slack chain drape

A deployed ball chain with length to spare no longer draws as straight spans: `SlackChain`
(`classes/slackChain.ts`) is a **visual-only** simulation of the loose chain - a fixed-count
Verlet particle chain pinned at the mounting loop the chain leaves the ball through (the
chain's start contact) and at the far end (flying hook, dangling tip, or anchor).
It sags in a catenary, drapes over the ball and the scenery, and heaps on the floor.

**The coil is part of the drape, not a kinematic prefix to it.**
The solver's coil is the angle of rim between the loop and the tangent point toward the next node, which is the right reading of a chain under tension and a fiction for one with length to spare: nothing holds a slack chain against the rim, so it hangs from the loop and lies wherever gravity and the scenery put it, and the ball's own rim is scenery the drape collides with like any other.
Pinned at the tangent point instead, the drape started a quarter turn round the ball from the loop and only the run beyond the tangent had the slack in it, so a ball that had rolled over its own chain drew the chain hugging its underside and climbing its far flank to leave cleanly toward the anchor with 13 cm of slack folded into the last span (`session-232f` f184-232, reported as the chain sticking to the side of the ball instead of drooping).
At taut the sag bound below puts the nodes onto the solver's rim samples exactly, so a wound-tight ball still draws its coil where the solver says it is (`cli shot` on a `ball-ground-wind-up` recording is the check).
It is strictly one-way: it reads body transforms and the wrap path at the END of the physics
frame (`BallLevel.physicsProcess` steps it last) and writes nothing back - no forces, no
impulses, no positions - so every replay, digest and invariant is bit-identical with it in
(asserted the usual way: the whole corpus replays byte-for-byte across the change).

Both renderers draw its polyline instead of the chain's spans (`pathLoopToAnchor(alpha)`,
with both ends welded to the render transforms so the chain never detaches from the drawn
ball or manacle); `cli render` overlays it in green over the wrap path's amber, which
coincide exactly when the chain is taut.

Four mechanisms carry the requirements:

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
