# The chain reeling in after a release

Letting go of the chain is instantaneous in the sim: `BallPlayer.releaseChain` drops the rope, the hook body and the cuff in one call, and the next throw can leave on the very same step.
That is the right rule for the game - a redeploy that waited on an animation would be input lag dressed as polish - and on its own it is also a chain that vanishes from the screen between two frames.
The reel is the picture of the release, and it is **purely visual**: nothing about when the next throw may leave changes.

**On always** since 2026-11-09; until then it sat behind a `?retract=1` flag (and `cli shot --retract`) while it was judged.

The aim is a reel that is **plausible but gentle**: it must read as the chain going home, and must not whip about enough to draw the player's eye from the next throw.

## What it is

The slack drape (`SlackChain`, [slack-chain-drape](slack-chain-drape.md)) carrying on (`ChainReel`, `src/render/chainReel.ts`), on the gameplay plane.
Both renderers already draw the deployed chain as the drape's polyline, so the step the chain is gone a `ChainReel` is started from the drape's nodes and their Verlet history (`SlackChain.nodeState`), exactly where the deployed chain was drawn on the last frame, and stepped by the render side from there.

- **The ball is not collided.** A chain wound round the ball is drawn straight through it to the loop rather than round it; the iron ball hides the links inside it. This is the whole fix for the whip (below).
- **The scenery is**, with the drape's contact law: dead restitution, static friction for a creeping node (`STICK_STEP`), velocity friction (`FRICTION`), all relative to the surface, so a node on a moving body rides it.
- **The chain is consumed at the loop**, as a winch consumes it, at the speed it was thrown out at: `REEL_SPEED`, which is `BallPlayer.HOOK_SPEED` (12 m/s), constant to the end (Tris: "make it retract at the same rate it deploys"). The segment nearest the loop is the one whose rest shrinks, the next only once it is gone (`restOf`); consumed segments collapse onto the loop rather than being dropped, so nothing resamples.
- **Follow the leader** (Müller et al. 2012, `reelFollow`) with its momentum correction (`FOLLOW_DAMPING`), and **with the slack taken up first** (`nearestWithin`): a bent node absorbs the pull by straightening, and only a node the chain is already straight through is carried on.
- **No sag bound, no long-range attachment, no buckling kick**, and **chain that is in rides the loop**, all for the reasons the earlier shapes taught (below).

Past zero the reel goes on for the depth of the ball, and the end slides under the ball to its centre with the cuff trailing it in, so the cuff leaves the picture under the ball rather than popping out of existence at the rim.

## What the whip is made of

With the ball collided, a chain wound round it could only come off the way it went on: every turn slid round the rim and through the loop, and the cuff whipped round the ball once per turn wound.
`session-103f` (1.7 turns wound) swept the cuff 978° round the ball in 16 steps.

Measured over six releases - `session-103f` and `ball-wind-up` (12 cm ball) let go at five depths of wind - by how far the cuff travels round the ball and relative to it, the rest of the whip has two causes that have nothing to do with the coil (0.15 m wound still swept 308°):

- **The ball keeps turning after a release**, 140-383° during the reel, as the aim steering turns it back to face the aim, and the loop the chain is eaten through turns with it.
- **The cuff follows the chain's own path in**, and a chain lying round the ball's outside is a path round the ball.

So faster is gentler (the longer the reel, the further the ball's turning drags the cuff round), and a chain that goes through the ball has no path round it to follow.

| Reel | Sweep | Cuff travel | Cuff mean speed | Reel lasts |
|---|---|---|---|---|
| 3D, 8 /s and 4 m/s | 489° | 2.09 m | 7.4 m/s | 0.30 s |
| 3D, 12 /s and 6 m/s, kick | 255° | 1.38 m | 7.6 m/s | 0.20 s |
| 3D, 6 /s and 3 m/s, kick | 429° | 2.26 m | 5.9 m/s | 0.40 s |
| 3D, constant 12 m/s, kick | 182° | 1.10 m | 9.4 m/s | 0.13 s |
| **through the ball, constant 12 m/s (the tree)** | **157°** | **0.82 m** | **7.1 m/s** | **0.13 s** |

The rate rows are an earlier shape of the speed, `REEL_RATE` times the chain still out with a floor `REEL_SPEED_MIN`, fast at first and slowing.
Measured on the 3D reel and no help (within ±30° of 489°, or worse): a slower reel (4 /s, 2 m/s: 676°) or one eased in from rest (690°), a heavier cuff, air drag, damping only the swing across the line to the loop, and an entry point that does not turn with the ball (469°, with a speed spike).

## Earlier shapes

Six shapes of the reel were played and rejected, and the receipts are worth keeping:

- **A frozen polyline sliding home** (no physics at all): "very weird" - the chain kept the shape it was let go in and slid along it like a rail.
- **Every segment shrinking at once**, held by the drape's long-range attachment: the cuff went in a straight line at the ball through whatever it was wrapped on, at full speed from the first frame, slack or not.
- **Consumption at the loop with the symmetric passes alone**: each pass moves the error one node, so a 13 cm haul a step stretched the run nearest the ball while the far end sat still, and the chain vanished all at once when the count ran out ("retracts slowly for a few frames then disappears"). The follow pass without its momentum correction, and with the drape's buckling kick still on, then folded the run on the floor into a tangle under the loop as it overran the node the haul had lifted.
- **Plain follow-the-leader** slid a slack chain along its own path like a train on rails ("doesn't take up the slack before pulling the manacle in"), which the slack-first rule fixed.
- **The in-plane reel with the ball collided**, which whipped the cuff round the ball once per turn wound (above).
- **A 3D reel** (2026-11-09): every node given a depth, the ball a sphere with Coulomb friction (μ 0.4, position-based, Macklin et al. 2014 §6.1) that a coil slid off the side of, the coil seeded one link width toward the camera per turn, and the whole chain kicked toward the camera at 4 m/s at the release so it gathered across the ball's face (Tris's idea). It worked - 978° to 182° - but the chain through the ball measured gentler still (the table) and was preferred on playing both: "i like that better than the 3D version". The drape's own contact law on the sphere had held the coil wound (631°), since it drags sideways slip as hard as slip along; Coulomb friction is what let it come off.

## Drawing it

The links are laid from the **reeling end** (`walkChain`, [the chain metrics](../src/render/chainMetrics.ts)), the same order the deployed chain is laid in and for the opposite reason: laid from the end being hauled, the links slide home through the loop with it.
The cuff rides that end hinge-first, faced back along the chain as a free cuff hangs (`chainEndFacing`), and straight into the ball once it is being swallowed.
A glass ball shows the links passing through it, which an iron one hides.

## Who owns it

`render/chainRetract.ts`.
`ChainRetract` is session state the hosts keep beside the sparks (`main.ts`, `shotMain.ts`, the editor's ▶ Test): it is shown the level once per sim step (`observe`), after the step and inside the catch-up loop like `sparks.ingest`, so a chain let go and re-thrown across two steps of one render frame is seen as both.
It keeps hold of the drape of the chain that is out, starts a `ChainReel` from it the step `ball.chain` goes null, steps it against `level.bodies`, and hands both renderers one `RetractFrame` per drawn frame (`resolve(alpha)`: the polyline far end first, then the loop, then the ball's centre, and the cuff's pose).
It is reset with the level, as the sparks are.

**A new throw deletes it.**
The chain that is out is the chain, and a second one still reeling in beside it would be two chains on a ball that has one, so the step a new `Rope` appears whatever was reeling is dropped wherever it had got to.
A release-and-redeploy inside one step therefore plays no reel at all, which is the same statement.

## What it sounds like

One quiet gesture per release, built to pair with the deploy it always follows: a short **zip** of links on the release step, cut from the deploy's own recording, and cut off when the chain's end reaches the loop ([sound](sound.md#what-is-heard)). The reel reports that moment (`ChainReel.seatedAt`, the fraction of the step), and `ChainRetract` keeps it and the release as per-step events (`released`, `seatedAt`), since the reel can finish on the step its end arrives. The deploy's rattle run backwards, a stream of chain-impact clinks, and three sounds for the end arriving (a seat) were tried and rejected by ear.
And the links themselves, exactly as the deployed chain's: the reel reports its scenery contacts in the drape's form (`ChainReel.contactSnapshot`) and its nodes (`nodePositions`), and the sound observer reads them through the same impact, scrape and link-to-link readers, fresh at every release ([sound](sound.md#contact-driven-chain-audio-v29)).
The hosts step the reel before the sound reads it (`main.ts` and the editor's ▶ Test, which keeps its own `ChainRetract` beside its sparks and snap).

## What the sim sees

Nothing.
The reel reads the level and writes nothing back - no event, no field, no digest - so every replay, invariant and the whole bundle corpus are bit-identical with it in.
`SlackChain` no longer has a reel mode: its far end is always pinned, and the reel shares only its scenery collection (`drapeCandidates`) and frame carry (`bodyWas`, `bodyCarried`).

## Verifying it

`cli shot bundle --frames A..B --zoom Z --3d` across a release frame, which the `--frames` filmstrip is for.
`session-103f` f70-86 is 1.26 m wound on a ball flung up off a vine (copy in `playtests/bundles/session-103f-reel.json`).
Run one `cli shot` at a time: two running at once have shared a browser and drawn one bundle's frames under the other's labels.
There is no case for the reel yet, by the rule that a feel is played before it is pinned.
