# Breakable geometry

**A breakable body carries two numbers** (`LevelBodyData.breakForce` / `durability`, on `CollisionObject2D` as the same pair): how hard something has to hit it to hurt it, in newtons, and how many such hits it survives.
When the count runs out the body leaves the world, the chain lets go of it if it was holding it, and the render side throws a shower of chunks that fade out inside a second ([the debris](#the-debris)).
`breakForce` 0 is unbreakable, which is every body of every level authored before the pair, and the whole mechanism is behind that test.

**Per BODY, not per shape**, unlike `impermeable`, `rail` and `viscosity`.
Those answer "which surface did the hook reach", which is a question about one face; this destroys the whole thing, and a body half broken is not something a level can mean.
A hit on any piece therefore counts toward the one tally, and the whole body goes at once: the L-shaped piece at the end of `BREAK_TEST` is two rects and one crate.

**Newtons, and they do not scale** (`scaleLevelData` passes both through untouched).
The file's lengths are pixels because the editor draws in pixels, and a force is not drawn: it is stated in the sim's own units, exactly as `drag` is a reciprocal time and `pivotFreq` a frequency.
What makes it authorable is the editor's readout, below.

## What counts as a hit

**The load is the solver's own accumulated normal impulse over the step, divided by the step** (`ContactConstraint.normalImpulse / dt`, summed over every piece ONE other body is pressing on).
It is the honest quantity and it was already computed - the same number `BodyDigest.contactPn` records - so a break is readable from a recorded bundle without re-simulating it.
Summed per striker rather than per contact, because a crate landing flat makes two contact points and hit the floor once.

**A contact reports the weight it is already carrying plus `m·Δv/dt` of arrival, in one frame** (`cli breaks`, case `break-load`, which asserts it against the closed form rather than against a recorded number).
The solver cancels the approach within the step, so the impulse it accumulates is the momentum it removed:

| what hits it | at rest | at 5 m/s | at 10 m/s | at 20 m/s |
|---|---|---|---|---|
| the ball (8 cm cast iron, 15.4 kg) | 151 N | 4.8 kN | 9.4 kN | 18.7 kN |
| a 1 m oak crate (140 kg) | 1.4 kN | 43 kN | 85 kN | 169 kN |

So a threshold is a statement about a mass and a speed and nothing else, and the arithmetic an author needs is `F = m·v·60 + m·g`.
The ball is 926 N per m/s of arrival.

**A strike counts once, however many frames it lands over** (`BreakTracker`, a Schmitt trigger per breakable-and-striker pair).
Over the threshold while the pair is cold: one hit, and the pair goes hot.
Under half of it for three consecutive frames, in contact or not: cold again, and the next crossing is a fresh hit.
A pair nobody has mentioned for a second is forgotten, which is the same as cold; it only stops the map growing.

Three things fall out of that, and they are the three things the feature is judged on:

- **A body resting on a breakable floor hits it once.** A load over the threshold that never lets go is one continuous press, not sixty a second: a crust authored to give way under a weight gives way, and one authored above that weight is not ground down by it.
- **A body sliding along it is not hitting it at all.** A drag carries the weight and nothing more, so nothing new crosses the bar.
- **A body that leaves and comes back is a fresh hit every time.** The cooling runs on the frames a pair is NOT in contact as well as the frames it is pressing gently, which is the whole of what makes a bouncing ball wear a floor down; a tracker that only cooled while touching stayed hot through the airborne half of the bounce and counted the second landing for nothing.

**The grapple avatar cannot break anything**, and that is the engine's answer rather than a rule stated here: a `CharacterBody2D` is swept rather than solved, so it appears in no contact constraint at all.
What breaks geometry on a grapple level is the rigid scenery.
**Rope tension is not a hit either**: the rope moves bodies, it does not press on them, so hanging from a rotten plank does nothing to it.
That is the one thing in `docs/ideas.md` this does not yet do, and it needs the rope's node tension surfaced as a load first.

## Breaking

**The scan runs at the END of the level's step**, after every phase that holds body references (`BallLevel.breakBodies`, `Level.breakBodies`).
A body taken out of the world mid-frame is a body taken out from under the chain phase, the drape or the sleep pass; the contacts the scan reads are the frame's own and nothing above touches them, so waiting costs the measurement nothing.

Then, in order: the event is recorded for the render side, the chain lets go, and the body leaves `World` and the level's body list (the array the rope is handed as its scene, mutated in place).

**The chain DETACHES rather than riding the fragment down** (a design decision, 2026-09-16).
A hook on a body the sim no longer has is an anchor on nothing, and the break is loud enough without it: the surface the player was hanging from is gone, and so is the chain.
Wrap nodes need no such statement - every rope drops its own nodes on a removed body at the top of its next regeneration (`Rope.dropWrapsOnGoneBodies`), which is where a body that leaves the world has always been answered.

**A body an authored chain or a vine hangs FROM cannot be breakable** (`guardBreakables`, at build).
Their ends are fixed at construction and never re-anchor, so a body that leaves the world under one leaves a constraint solving against a contact on nothing.
The level file is where that is stated wrong, so it is said out loud at build and the threshold is dropped: the geometry still plays, it simply cannot break.
A chain that merely WRAPS a breakable body is fine, and deliberately so - it falls off a ledge that gives way.

## The debris

**Entirely render-side** (`render/debris.ts`), on the boundary the sparks keep ([sparks](sparks.md)): the sim contributes one `BreakEvent` - the body, where the finishing hit landed, its normal, the force and the threshold - and the render side owns the shatter, the randomness, the physics and the drawing.
Nothing is read back, so the whole recorded corpus replays byte-for-byte with it running.
The event holds the body itself and is read on the frame it is issued: the body has left the world by then, but the object is intact and is the only thing that knows its own outline, its colour and how fast it was going.

**The chunks are particles, not bodies**, which is what was asked for and is also the right shape: rubble that can be stood on, hooked, wrapped and knocked about is a second level's worth of physics for a second of spectacle, and it leaves the level permanently different in a way nothing authored it to be.
A wall that breaks costs the frame after it exactly what a wall that was never there costs.

**The shatter is a recursive convex split**: a piece is cut by a line through a point near its middle, and each half is cut again until the pieces are about `CHUNK_SIZE` across.
Convex in, convex out, so the cut is one half-plane clip (`clip`, Sutherland-Hodgman against one plane) and nothing here needs a polygon library - and a body that collides as one rect breaks into rubble rather than falling over as a slab.
The cut point is jittered off the centre because cutting through the middle every time tiles a rect into a neat grid, which reads as a jigsaw rather than as something broken.

Each chunk is thrown out from the point the blow landed, biased along the way the blow was travelling, at a speed scaled by how much harder than the threshold the finishing hit was: a break that only just happened crumbles, a slam blows the wall apart.
They carry the body's own velocity, fall at g, spin, and fade over the last 45% of a life of 0.7 to 1.2 s.
They are drawn in the 2D overlay in world space, where the sparks are drawn, so one implementation serves `?render=2d` and `?render=3d` both.

**Both canvases and the editor's ▶ Test drive it**: `main.ts` ingests per sim step and advances on the render clock (the sparks' shape exactly), `shotMain.ts` does both at the fixed step with a seeded PRNG so `cli shot --diff` stays meaningful, and the editor's test run has its own system.

**A breakable body draws with a broken red fringe** under its own edges, in the game's 2D renderer and in the editor (`BREAK_EDGE` in both).
Under, and not instead of, because breaking is the body's property and the hook-proof, mud and pass-through edges are its pieces': a cracked wall with one mud patch has to read as both.
A player who cannot tell which wall gives way cannot plan a route through one.
In 3D the body wears whatever surface it was authored with, so a breakable piece is told apart by what it is made of - which is the level's job, as it is for every other 3D material.

## Authoring

The editor's body panel offers **breakable** on the kinds that build a body, beside the trampoline pair, with the threshold in newtons and the durability in hits.
**The readout is the point of the panel**, exactly as the launch's height is: nobody is choosing 6000, they are choosing "it holds a crate this heavy" or "the ball has to come in this fast", and both are one division away from the force.
So the panel says both, live, for the ball this level's own `player.radius` describes.
A fresh threshold is 6 kN, the ball at about 6.4 m/s.

`BREAK_TEST` (`levels/break-test.json`) is the sandbox: a stair up to a ceiling to swing from, and under it a 2.5 kN ledge, a 5 kN ledge, a 4 kN block that takes three hits, and an L of two pieces that goes as one body, over a four-metre drop to the stone floor.

## Detectors

`cli breaks` (`src/sim/breakCases.ts`) is the whole of the coverage, and it has to be: a build in which a floor quietly stopped counting hits, or counted one per frame, renders identically and plays like a different game.
`break-load` is the measurement the rest are written against (the table above), then the threshold, the durability and what the break leaves behind, the bounce, the drag, the chain letting go, the build guard, and the format round trip.

Two invariants (`checkBreakables`, on both drivers):

- `break-late` - a body still in the world whose count has run out. The scan breaks it on the frame it earns it, so one left standing means a driver stopped calling the scan or stopped acting on what it returned, which nothing else would notice.
- `break-ghost` - a rope anchored to a body that has left the world.

`BodyDigest.hits` carries the count for a breakable body, and a breakable STATIC is in the world digest for exactly this reason: it cannot move, but it can count hits and it can vanish, and neither shows anywhere else.
Every other static stays out, unchanged.
