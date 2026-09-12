# Physics foundations

## Units

The simulation runs in **metres and seconds** (per-frame lengths at the fixed 1/60 step).
Every tuning constant, level coordinate, and stored position/velocity is metres - **never pixels**.
Pixels exist only at the edges: rendering (`render/`) and pointer un-projection (`camera.ts`).

`src/engine/units.ts` holds the single conversion, `PIXELS_PER_METER = 100` (chosen so the ported Godot gravity 980 px/s² reads as 9.8 m/s²), plus `PX = 1 / PIXELS_PER_METER`.
It is applied symmetrically - `÷` on the way in (level import via `scaleLevelData`, input) and `×` on the way out (the render transform is `camera.zoom * PIXELS_PER_METER`; fixed on-screen decoration is written as `<px> * PX`) - so changing it is an invisible reparametrization.
To rescale how large the world appears on screen, change `camera.zoom`; the physics never sees it.

When adding a constant, classify its dimension: lengths/velocities/accelerations scale by `PX` (Coulomb frictions here are per-frame decelerations - **length**, not coefficients); dimensionless coefficients, gains (1/s), angles, and frame counts do not.
`levelData.ts` stays authored in Godot pixels (converted at load); `playtests/*.json` world-coordinate/speed fields are in metres.

## Mass and materials

The third SI unit is the **kilogram**, and a body weighs what its size and its material say it weighs (`lib/shapeGeometry.ts`).
`Density` is a table of real densities in kg/m³ - cast iron 7200 for the ball, steel 7850 for its hook, stone 2400 for the sandbox's loose boulders, oak 700 for anything a level authors and does not say otherwise about - and a mass is that density times the shape's real **volume**.

There are two volume rules and they belong to different halves of the project.
The **code-built** round bodies (the ball, its hook, a cannonball, the sandbox's rocks) go through `computeMass`, where a circle is a **sphere**: extruding a ball to a slab's thickness makes small ones absurd, a 4 cm hook outweighing a 5 cm rock six times over.
**Authored level geometry** goes through `prismMass` instead and is always a **prism** - `area × thickness × density` - a circle included, because an authored circle is a disc seen face on (a wheel, a barrel end) and a `thickness` some shape kinds quietly ignored would be a field that lies about what it does.
The avatar is the one body that states its mass outright (`Player.MASS`, 70 kg): its collision circle stands in for a person and its radius says nothing about what that person weighs.

The point of the absolute scale is that ratios become **checkable**. The ball is a 24 cm cast-iron sphere at 52 kg, its hook is 0.26 kg, the slab it hauls is 63 kg - and each of those is a number a person can hold against the real object rather than only against the other bodies in the scene.
The scale itself is behaviour-neutral: gravity is an acceleration and every constraint here is written in mass *ratios*, so multiplying every mass by 1.6e5 (which is what this change did) leaves the sim where it was. Before it, masses were "area in m² over a thousand" and the ball was a third of a gram.

What is **not** neutral is anything written in units that carry a mass: an impulse (`CannonBall`'s explosion), an energy tolerance (the `energy-gained` invariant, `cli settle`'s at-rest bar), a momentum floor.
Each of those was restated in terms it can keep - a target speed, a fraction of the ball's kinetic energy - rather than rescaled to a new constant, so the next mass change does not silently turn a check into an assertion about nothing.
A circle's **moment of inertia** stays the disc's `1/2·m·r²` rather than the sphere's `2/5`: rotation in this engine is planar, and the sphere's figure is a fifth easier to spin, which measurably loosens the wind-up (see the note on `computeMomentOfInertia`).
Level geometry names **its own material and thickness**, per *shape* rather than per body (`LevelBodyData.material` / `thickness`, authored in the editor's inspector alongside a live mass readout).
`MATERIALS` is the authorable table - wood, ice, flesh, rubber, brick, stone, glass, aluminium, cast iron, steel, lead, each at its real density - and a shape names one rather than carrying a raw number, because naming the stuff is the decision an author is making and the density is a fact about the material the level should not restate.
Absent, a shape is 20 cm of oak, which is what every body authored before the fields was, so an old level loads with exactly the masses it always had; an unknown material name loads as that default rather than as a body of no mass.

Per shape and not per body is the whole point, and it is the one property a body does **not** have just one of (`syncBodyProps` leaves it alone): a body's mass, centre of mass and moment of inertia are sums over its pieces, so a stone head on a wooden shaft is exactly what those sums are for, and its origin lands near the head.
That also means the build cannot re-derive a compound body's piece masses from its mounted shapes - a `CollisionShape2D` carries no material - so `setCompoundInertia` takes the masses `makePiece` computed, which is what stops the inertia disagreeing with the centre of mass the origin was just placed at.
`cli contacts` `materials` is the detector: the arithmetic asserted directly (a slab in oak and in stone, twice as thick, a steel disc that is *not* the sphere's 4110 kg, and an oak+lead group whose centre of mass is at 0.44 m rather than the midpoint), because authored state nothing checks is authored state that quietly stops being read - a build ignoring one of these fields produces a level that looks identical, plays differently and violates no invariant.

## Determinism & correspondence to the C# source

The sim is a **fixed 1/60 timestep**; input is sampled once per physics frame. It is
self-consistent (a recorded input trace replays bit-for-bit — see `cli selftest`) but **not**
bit-compatible with the C# original (float64 vs float32, reimplemented physics). Class and
method names track the C# sources closely to keep the two diffable.

**Every bundle carries its own self-replay verdict.**
Before a P-download leaves the browser (and the editor's ▶ Test download too),
the page builds a second level from the bundle's own data, re-simulates the
recorded inputs through it, compares the two field by field with the same
`firstDivergence` the CLI uses, and writes the result into the bundle as
`selfReplay` - shown in the download toast and printed on `cli replay`'s header.
A 415-frame ball session checks in **292 ms** in Chromium, paid synchronously on
the download.
A false verdict is a **determinism finding**, and it outranks anything the replay
that follows it says: a recording that does not reproduce where it was *made*
cannot be evidence about physics anywhere else.

What it can and cannot see is worth stating exactly, because the two runs it
compares are both in the browser:
- It **catches** the live-run-against-re-simulation class - a dropped or
  duplicated frame, a variable `dt` leaking into the sim, the live input source
  and the deserializer disagreeing, live state the rebuild does not reproduce.
  None of that was checked anywhere before.
- It **cannot** catch a browser-against-bun disagreement, which is what the
  2026-09-04 knife-edge was (a 1e-17 m overlap read as a push-out on one engine
  and as clear on the other). Two runs in the same float environment agree about
  a 1e-17 m overlap by construction. Verified: with `PUSH_OUT_MIN_DEPTH` set back
  to 0, a browser recording still downloads `identical: true`.
  **`cli diverge` on a fresh browser bundle is what covers that**, and it is the
  reason the process rule below says to record one against every physics change.
`cli selftest` holds the detector to both halves: a clean bundle must verify
`identical`, and a bundle with one recorded digest value nudged by 1e-3 must come
back false naming `chain.blockedSlack` at exactly that frame.

### Cross-platform determinism

The sim computes the **same bits on every engine and every platform**, and that is an engineering decision rather than a property JavaScript hands out.
IEEE 754 fixes `+ - * /` and `Math.sqrt` as correctly rounded, and every engine honours that; what ECMAScript leaves **implementation-defined** is the transcendentals - `Math.sin`, `cos`, `tan`, `atan2`, `exp`, `log`, `pow`, `sinh`, `cosh`, `hypot` and the rest.
V8 ships fdlibm ports for some and glibc's or LLVM libc's for others (it changed in May 2026), JavaScriptCore calls the platform libm, SpiderMonkey carries its own fork, and they agree to within an ulp and differ in the last bit.
Measured with `bun run dmath:crosscheck`: bun's `Math` differs from fdlibm on 2-27% of inputs per function, node 24's on none but `pow`.
A physics step that tests `depth > 0` on a 1e-17 m overlap turns that last bit into a different branch and a different game, which is what every "libm knife-edge" in this document was (`session-1052f` f379, `session-3649f` f859).

So the sim never asks the engine.
**`engine/dmath.ts`** is a port of fdlibm 5.3 (the code Java's `StrictMath` mandates for exactly this reason) written against the operations the spec does pin down, with every constant built from its hex bit pattern rather than a decimal literal (the spec guarantees correctly rounded parsing only to 20 significant digits and fdlibm prints 21), and `hypot` is V8's two-argument form.
Everything in `src/engine`, `src/classes`, `src/lib`, `src/level`, `src/input`, `src/playtest` and the replay path of `src/sim` calls `dmath.sin` and never `Math.sin`; `Mathf` and `Vec2` route through it.
`cli dmath` is the detector and it is part of `bun run test`: every function against a committed table of bit-exact answers (`src/sim/dmathVectors.json`, inputs and outputs as hex) plus a digest over twenty thousand more inputs, a set of closed-form facts, and a **scan of those sources for the banned `Math` members and for `**`** (which is `Math.pow`).
The table was written on V8, where every function but `pow` was also checked to agree with `Math` bit for bit over 200k random inputs (V8 13.6 uses glibc's correctly rounded `pow`; fdlibm's is within an ulp), and it reproduces to the bit on bun and in Chromium 142.
`cli dmath --write` regenerates it, and that is a determinism change made on purpose: every recording made before it may replay differently.

What it costs is nothing, and that took a second piece.
`dmath.sin` is 1.5-3.5x the platform's per call (about 20 ns against 5-14), and the ball arena was making **84,000** `sin`/`cos` calls a frame - every whole-body overlap query re-rotating each shape's mount offset, the slack chain's node scan re-taking every shape's extents per node - nearly all of them on a rotation that changes once a frame at most.
Replaying `session-1052f` went from 2.0 s to 2.4 s.
So `engine/trig.ts` memoises cos/sin per rotation **bit pattern** (a direct-mapped table in front of `dmath`; a hit is the bits a fresh computation gives, +0 and -0 kept apart, and `cli dmath` asserts that), `Vec2.rotated` and `shapeExtents` read it, and the same replay is back at 2.0 s - a hair under the tree before the change.

What that buys is that a bundle recorded in any browser replays bit-exact under bun, node and every other browser, so the node-built CLI (see [debugging-physics.md](debugging-physics.md#debugging-discipline)) is a tool for recordings that predate the change rather than a standing requirement.
`session-1052f` is the measurement: recorded in Chromium, bun left it at f379 before the change and follows it to f932 after, exactly as V8 does.
What it does not cover is a NaN's payload (not pinned by the spec either, and the sim never produces one) and anything outside the sim that feeds it - the level file's numbers parse identically everywhere (JSON is correctly rounded), and the render side may use whatever `Math` it likes, since nothing there reaches the fixed step.

The same rule - same expression, same bits, computed once - is what the **transform caches** are (2026-09-10, `session-392f`: the ball hanging off a lantern took a 4x-throttled Chromium step to 12 ms, and half of a bun profile was re-deriving world-space positions of bodies that had not moved).
`CollisionObject2D.transformVersion` is bumped by the only two writes a transform has (the `globalPosition` / `globalRotation` setters), and against it `CollisionShape2D.globalPosition`, `CollisionShape2D.worldVertices` (the loop `shapeWorldVertices`, the manifold and `ShapeGeometry.getGlobalCorners` all hand out - shared and read-only, nobody writes into it) and `RopeContact.globalPosition` keep their last answer, keyed on everything else the answer read (the mount offset, the shape, the contact's body, since a rail clamp re-seats a contact).
`polyEdgeNormal` memoises per vertex array, which a static local loop is for the life of its shape and a world loop is for the life of its transform.
`wrappableSurfaces` hands back the last list while a walk over the same bodies finds the same pass-through flags, shape arrays and `wrappable` bits, and `sweepSpan` takes its mobile candidates from that list once instead of scanning all three hundred surfaces per span.
Every one of these is a cache of a pure function of state that has a version, so the whole corpus replays byte-for-byte across them (`cli bundles`, the same set of drifted-since-recorded bundles before and after), and the anchored step on `session-392f` went from 2.6 to 2.0 ms in bun, 12 to 9.5 ms under the throttle.
What they could not do is make the frame cheap: the rest was six hanging chains solved twice a frame with a full path regeneration each, rigid bodies that never slept being depenetrated against scenery they never touched, and the coupled sweep - the sim's behaviour and not its arithmetic, which is what [**Sleep: a settled body costs nothing**](sleep.md) then took on.

Godot idioms that were collapsed in the port:
- `Vector2` value-type semantics → **immutable** `Vec2` (every op returns a new vector).
- `PhysicsServer2D.BodySetState(Transform/…)` in `Rope` → no-op; the TS `RigidBody2D`
  transform/velocity **is** the authoritative state.
- `Node._PhysicsProcess` ordering → `Level.physicsProcess` runs player+rope, then hooks,
  then `World.integrate` (rigidbody gravity/collision), mirroring Godot's frame order.

## Shapes

Three collision shapes exist: **circles**, body-aligned **rects**, and **convex
polygons** (`engine/shapes.ts`). A polygon is a vertex loop wound so that consecutive
edge cross-products are positive (clockwise on screen, y being down), which is what makes
the outward normal of edge a→b its Godot orthogonal — `polyEdgeNormal` is the one place
that convention is cashed out. Convexity is a hard rule of the ENGINE, enforced at
construction; see **"Convex-only polygons; compound bodies"** in `docs/game-design.md` for
why the rope solver cannot survive a reflex vertex.

A **level** authors a *simple* outline instead, concave corners and all, because a concave
outline is what an L-shaped ledge or a notched pillar is. `decomposeConvex`
(`lib/polygon.ts`, ear clipping + Hertel-Mehlhorn) cuts one into the convex pieces that
tile it as the object is built (`makeShapes`), so the body a solver sees is the compound
body an author used to have to assemble by hand — same pieces, same seams, same mass, and
`isExposedCorner` classifies its corners with no idea the cut was derived. The cut is a
partition, introduces no vertex the author did not place, and is deterministic because it
runs at load; `cli decompose` is where those are asserted. A loop that crosses itself is
refused at both ends (the editor stalls the drag, the loader fails the build), and a camera
region stays convex since nothing cuts one up.

A level authors a fourth kind for the same reason: a **`curve`**, a cubic Bezier node list
with a WIDTH, which is the bar a rail is made of and which no box or vertex loop can state
without an author placing the boxes by hand. `strokeCurve` (`lib/stroke.ts`) offsets its
flattened, simplified centreline into the convex quads that tile it, mitred at every joint,
and the build cuts it there exactly as it cuts a concave outline (`makeShapes` again) — so
past that line nothing knows it was ever a curve. See [**Rails**](rails.md), whose centreline it is.

`rect` deliberately stays its own kind rather than being folded into `poly`, even though a
rect *is* a convex polygon: every collision path has a closed-form slab implementation for
it and those are what every recorded replay was simulated through. A four-vertex `poly`
takes the general convex path and agrees geometrically, but not bit-for-bit — so the two
branches sit side by side throughout `engine/collision.ts` and `lib/intersections.ts`
rather than being merged. `shapeVertices` / `ShapeGeometry.getLocalVertices` is the single
accessor every vertex-walking query goes through, so rect and poly share the loop code
(ledge candidacy, wrap generation, SAT) without sharing the analytic fast paths.

`IntersectionStatus` is a **three-way** answer and the middle value carries weight:
`Touching` means contact with no penetration, and it is *not* `Overlap`. A polygon query
must decide between them by how far the query actually reaches inside — the rect routines
do this by construction (slab clip, then the signed distance at the interior midpoint) and
the polygon ones mirror it. "Any edge the segment intersects ⇒ Overlap" is the trap,
because an edge intersection includes a touch, and a rope contact stored in its body's
local frame sits exactly on the surface for ever: that reads as a permanent overlap and
leaves the wrap solver armed on every span reaching the anchor (`session-284f`).

A body may carry **several shapes** (`addShape`, `getShapes()`) — a compound body. Every
scanning path iterates them: the character sweep, raycasts, area overlap, ledge candidacy
and the rope's wrap scan (whose candidates are shapes, not bodies, so a `RopeContact`
carries a `shapeIndex`). `CollisionShape2D.wrappable` is the one opt-out: solid, but not
rope geometry (the ball's mounting loop).
A `RopeContact`'s `shapeIndex` must name the piece it actually sits on, and an **attachment** to scene geometry has to resolve it from the contact point (`RopeContact.at`) rather than defaulting to the primary.
Defaulting was invisible while every attachable body had one shape, and silently wrong the moment compound bodies became authorable: `resolveSelfIntersectionAtStart`/`AtEnd` test the span against `contact.shape`, so a hook anchored on piece 1 but indexed at piece 0 tested a piece the span never touches, found no overlap, and let the chain run **straight through** the polygon it was anchored to instead of bending around its corner (`session-234f`).
The failure has no velocity signature at all - the run is healthy on every invariant - so it is only visible through `cli render` / `cli chainpath`.
A mounted shape carries a `localOffset` **and** a `localRotation`, both in the body's own frame.
The rotation exists because a compound body is authored as pieces at their own angles (an L of two rects meeting at 45°) and one body rotation cannot express that; the default 0 makes a shape's rotation exactly the body's, which is what every single-shape body has, so it is bit-identical for every level that predates it.
The body's origin is the pieces' combined **centre of mass** and its mass/inertia are the sum with the parallel-axis term (`buildBodies.ts`), because every rigid-body lever arm in the engine is measured from `globalPosition`.
That includes the rope's: `Rope.calculateTorqueArm` measures from `body.globalPosition`, never from a shape's, since the primary shape's origin is the body's only while the body has one shape.
Levels author this by putting several collision objects in one body - see [**Compound bodies**](editor-model.md#compound-bodies) under the level editor.

**Asking a body for "its shape" is almost always a bug**, and the accessor is called **`primaryShape()`** so that reads as the narrow thing it is.
It answers the *first-mounted* shape, which is the whole body only for the single-shape bodies that were once all of them, and code that reads it as "this body's geometry" goes on believing the rest of the body is not there.
`session-306f` was three of these at once: `BallHook`'s swept attach test flew the hook clean through the rotated slab of a three-piece wall because it swept only the wall's first piece; the overlap probe that eventually caught it anchored at the hook's own **centre** rather than on the surface, leaving the chain ending 2 cm off the corner it caught; and the `chain-clip` and `player-embedded` **invariants** were themselves primary-only, so the whole thing replayed HEALTHY.

Whole-body geometry now goes through **`bodyOverlapCircle` / `bodySweepCircle` / `bodySweepConvex` / `bodyContainsPoint`** (`engine/collision.ts`), which iterate the shape set for you: deepest overlap, earliest sweep hit.
"Forgot to loop" stops being something a caller can express, and the three hand-rolled copies of that loop (the hook's, the invariants', the ledge hang's) collapse into one.
The remaining `primaryShape()` callers are a body asking about **itself** where it is known single-shape (mass/inertia at construction, the avatar's own radius, the character sweep's moving shape) and areas, which are single-shape by construction - which is exactly why grouping an area is refused outright.
`ShapeGeometry.getShape` was deleted rather than renamed: an alias re-exposing it under the old name is the hole reopening.

Rigid bodies may be any of the three. A polygon resolves through a **contact manifold**
(`engine/manifold.ts`: SAT plus incident-face clipping, up to two points) rather than the
single point a circle produces — one point cannot resist a rotation about itself, so a box
would teeter on a corner instead of settling. Those manifolds feed `World.solveContacts`
(see [**The contact solver**](contact-solver.md#the-contact-solver)), which is where **every** contact is solved - circles against
static geometry included. What is left outside it is the ball avatar's aim **steering**
(`applySteeringGrip`), which is a kinematic control input rather than a contact.

## Known simplifications (candidates for follow-up)

- **Positional corrections do no energy bookkeeping.** The depenetration sweep and the
  position pin move bodies without asking what that costs, which is standard (position and
  velocity are recovered separately here as in every impulse engine) but means the pin is
  tuned rather than derived: `PIN_RELAX` is how much of the along-surface error it removes
  per frame, and it is 0.15 because 1.0 makes a resting pile buzz against its own recovery
  and 0.05 leaves creep in. The Coulomb cap is what keeps it honest - see **The position
  pin** - but a solver that corrected position through pseudo-velocities would not need the
  number at all.
- `World` rigidbody dynamics carry no broadphase, no islands and no sleeping; the pair loop is
  O(n²), which at this scene scale is complexity with no payoff. Sleeping is the standard
  answer to "momentum transfer destabilises settled piles", and is the wheel to import if that
  ever bites harder than `settle`/`stack` tolerate — rather than more damping.
  What the *loop* costs is indeed nothing; what it used to cost was the **narrowphase** it ran
  at the end of every arm of it. `collectContacts` and `gatherDepenetration` both reject on the
  two shapes' world AABBs first now (`shapeExtents`), which on the ball arena takes 99.9% of the
  SAT calls out - 743 shape pairs a frame examined to find the one within reach - and
  `World.integrate` from 1.475 ms a frame to 0.374. It is exactly conservative rather than
  approximately so: the contact gather drops anything at `depth <= -CONTACT_SLOP` and the
  depenetration gather anything not actually overlapping, so a pair whose boxes are that far
  apart is a pair those routines would have gathered nothing from. Every bundle in the corpus
  replays bit-for-bit across the change, which is the test that it is a rejection and not an
  approximation. A grid or a BVH is the next step if body counts ever justify it, and this is
  the thing to measure it against rather than against the version with no rejection at all.
- No sub-stepping, and no CCD for bodies beyond the two small fast circles that set
  `RigidBody2D.continuous` (the ball and its hook). The one *sweep* is the player's chain's
  wrap scan (see [**Continuous wrap detection**](wrap-detection.md)): a span is swept between two looks at it,
  because at 15 m/s a 10 cm body fits between them. Scene chains keep the plain sample.
  (Contacts *are* speculative in the cheap sense — see `CONTACT_SLOP`.)
- Circles remain single-point; polygon contacts get a real two-point manifold (above).
- `SlackSimulation` is fully ported but currently unwired — the C# `Rope` also left its
  `slackSimulation` field unused; the grapple rope renders straight spans.
  The BALL chain no longer does: `SlackChain` ([slack-chain-drape.md](slack-chain-drape.md)) is a fresh visual drape sim, unrelated
  to that port.
- `ApplyFrictionImpulse` is ported behaviour-for-behaviour but, as in the C# source, is
  not invoked from `physicsStep` (the call is commented out there too).
