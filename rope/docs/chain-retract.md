# The chain reeling in after a release

Letting go of the chain is instantaneous in the sim: `BallPlayer.releaseChain` drops the rope, the hook body and the cuff in one call, and the next throw can leave on the very same step.
That is the right rule for the game - a redeploy that waited on an animation would be input lag dressed as polish - and on its own it is also a chain that vanishes from the screen between two frames.
The reel is the picture of the release, and it is **purely visual**: nothing about when the next throw may leave changes.

**Off by default, behind `?retract=1`** (`cli shot --retract` for a filmstrip), while it is being judged: without the flag no `ChainRetract` is made and a let-go chain vanishes as it always did.

## What it is

The slack drape (`SlackChain`, [slack-chain-drape](slack-chain-drape.md)) carrying on.
Both renderers already draw the deployed chain as the drape's polyline, so the step the chain is gone the drape is put into its reel (`SlackChain.beginReel`) with its nodes exactly where the deployed chain was drawn on the last frame, and from there it is stepped by the render side instead of by `BallLevel`.
There is no frame on which the chain changes shape for any reason but the reel itself: the released chain hangs, swings, drags over the scenery and heaps under the same gravity, friction and collisions it had a moment before, with its far end let go.

The reel (`SlackChain.stepReel`) is the drape's own step with the winch put in:

- **The far end is free.** The last node is integrated and collided like any other (`endPinned`), and takes the smaller share of its segment's correction (`CUFF_WEIGHT`): the cuff is heavier than a link, so the chain is pulled straight and the cuff lags and swings.
- **The chain is consumed at the loop**, as a winch consumes it, fast at first and slowing as the chain shortens: the speed is `REEL_RATE` times the chain still out, never under `REEL_SPEED_MIN` so the last of it still comes in (the feel knobs; at 5 /s a full 1.8 m starts at 9 m/s and is half in after 0.14 s). The segment nearest the loop is the one whose rest shrinks, the next only once it is gone (`reelRestOf`), and every segment beyond keeps its length; consumed segments collapse onto the loop rather than being dropped, so nothing resamples. Slack is therefore taken up before the cuff moves at all, a chain wrapped round a corner is drawn back round it, and the cuff whips round after it.
- **Follow the leader** (Müller et al. 2012, `reelFollow`), with its momentum correction (`FOLLOW_DAMPING`): from the loop out, each node is put within its segment's rest of the node before it, so one sweep carries the haul to the far end whole, and the node ahead is paid the reaction. The symmetric passes still run first for the chain's shape.
- **With the slack taken up first.** Plain follow-the-leader carries a node along its own segment, so a slack chain slides along its path like a train on rails and the cuff moves from the first frame. So a node out of reach of its leader is first looked for inside the reach of both its neighbours (`nearestWithin`): while the chain is bent there the two discs overlap and the node goes to the nearest point of the overlap, absorbing the pull by straightening and passing nothing on. Only a node the chain is already straight through is carried along, and the cuff, last and with no follower, moves only once every bend before it has been pulled out.
- **No sag bound and no long-range attachment**, since both hold nodes to where a chain would be and the reel is the chain going where it is pulled; **no buckling kick**, since nothing pushes a hauled chain; and **chain that is in rides the loop** - a consumed node keeps no motion of its own, its momentum having gone into the ball.

Past zero the reel goes on for the depth of the ball, and `reelPath` draws the end sliding under the ball to its centre with the cuff trailing it in, so the cuff leaves the picture under the ball rather than popping out of existence at the rim.

Three earlier shapes of the reel were played and rejected, and the receipts are worth keeping:

- **A frozen polyline sliding home** (no physics at all): "very weird" - the chain kept the shape it was let go in and slid along it like a rail.
- **Every segment shrinking at once**, held by the drape's long-range attachment: the cuff went in a straight line at the ball through whatever it was wrapped on, at full speed from the first frame, slack or not.
- **Consumption at the loop with the symmetric passes alone**: each pass moves the error one node, so a 13 cm haul a step stretched the run nearest the ball while the far end sat still, and the chain vanished all at once when the count ran out ("retracts slowly for a few frames then disappears"). The follow pass without its momentum correction, and with the drape's buckling kick still on, then folded the run on the floor into a tangle under the loop as it overran the node the haul had lifted.

The links are laid from the **reeling end** (`walkChain`, [the chain metrics](../src/render/chainMetrics.ts)), the same order the deployed chain is laid in and for the opposite reason: laid from the end being hauled, the links slide home through the loop with it.
The cuff rides that end hinge-first, faced back along the chain as a free cuff hangs (`chainEndFacing`), and straight into the ball once it is being swallowed.

## Who owns it

`render/chainRetract.ts`.
`ChainRetract` is session state the hosts keep beside the sparks (`main.ts`, `shotMain.ts`): it is shown the level once per sim step (`observe`), after the step and inside the catch-up loop like `sparks.ingest`, so a chain let go and re-thrown across two steps of one render frame is seen as both.
It keeps hold of the drape of the chain that is out, starts its reel the step `ball.chain` goes null, steps it against `level.bodies`, and hands both renderers one `RetractFrame` per drawn frame (`resolve(alpha)`: the polyline far end first, then the loop, then the ball's centre, and the cuff's pose).
It is reset with the level, as the sparks are.

**A new throw deletes it.**
The chain that is out is the chain, and a second one still reeling in beside it would be two chains on a ball that has one, so the step a new `Rope` appears whatever was reeling is dropped wherever it had got to.
A release-and-redeploy inside one step therefore plays no reel at all, which is the same statement.

## What the sim sees

Nothing.
The reel reads the level and writes nothing back - no event, no field, no digest - so every replay, invariant and the whole bundle corpus are bit-identical with it in.
The drape's own arithmetic for a deployed chain is untouched: `endPinned` is true for the life of a deployed chain, and every loop bound and pin test it gates reduces to what it was.

## Verifying it

`cli shot bundle --frames A..B --zoom Z [--3d]` across a release frame, which the `--frames` filmstrip is for.
`session-1085f` f86-95 is a slack chain lying along the floor being hauled in with the cuff trailing, cut short by the re-throw at f95; `session-193f` f115-131 is the full 1.8 m reeled in over a falling ball.
Run one `cli shot` at a time: two running at once have shared a browser and drawn one bundle's frames under the other's labels.
