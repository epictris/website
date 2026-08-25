# rope

A 2D grappling-hook character-controller playground. **TypeScript port** of a C#/Godot
prototype (`~/projects/character_controller`), rewritten so it runs in the browser and can
be shared with friends to playtest. The novel part is the rope: it models the rope as a
sequence of **wrap points around scene geometry** (PBD length + friction solver), not as
evenly spaced segments.

## Stack

There is **no game engine dependency**. Godot's physics (CharacterBody2D `MoveAndSlide`,
RigidBody2D dynamics, `PhysicsServer2D` raycasts/shape queries) was reimplemented from
scratch in `src/engine/` so the simulation is self-contained and deterministic.

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
Levels author this by putting several collision objects in one body - see **Compound bodies** under the level editor.

**Asking a body for "its shape" is almost always a bug**, and the accessor is called **`primaryShape()`** so that reads as the narrow thing it is.
It answers the *first-mounted* shape, which is the whole body only for the single-shape bodies that were once all of them, and code that reads it as "this body's geometry" goes on believing the rest of the body is not there.
`session-306f` was three of these at once: `BallHook`'s swept attach test flew the hook clean through the rotated slab of a three-piece wall because it swept only the wall's first piece; the overlap probe that eventually caught it anchored at the hook's own **centre** rather than on the surface, leaving the chain ending 2 cm off the corner it caught; and the `chain-clip` and `player-embedded` **invariants** were themselves primary-only, so the whole thing replayed HEALTHY.

Whole-body geometry now goes through **`bodyOverlapCircle` / `bodySweepCircle` / `bodyContainsPoint`** (`engine/collision.ts`), which iterate the shape set for you: deepest overlap, earliest sweep hit.
"Forgot to loop" stops being something a caller can express, and the three hand-rolled copies of that loop (the hook's, the invariants', the ledge hang's) collapse into one.
The remaining `primaryShape()` callers are a body asking about **itself** where it is known single-shape (mass/inertia at construction, the avatar's own radius, the character sweep's moving shape) and areas, which are single-shape by construction - which is exactly why grouping an area is refused outright.
`ShapeGeometry.getShape` was deleted rather than renamed: an alias re-exposing it under the old name is the hole reopening.

Rigid bodies may be any of the three. A polygon resolves through a **contact manifold**
(`engine/manifold.ts`: SAT plus incident-face clipping, up to two points) rather than the
single point a circle produces — one point cannot resist a rotation about itself, so a box
would teeter on a corner instead of settling. Those manifolds feed `World.solveContacts`
(see **The contact solver**), which is where **every** contact is solved - circles against
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
- No CCD, no speculative *sweeps*, no sub-stepping. Body speeds are bounded by the invariants
  and tunnelling has never been the failure mode; the rope's failure modes are geometric and
  have their own tooling. (Contacts *are* speculative in the cheap sense — see `CONTACT_SLOP`.)
- Circles remain single-point; polygon contacts get a real two-point manifold (above).
- `SlackSimulation` is fully ported but currently unwired — the C# `Rope` also left its
  `slackSimulation` field unused; the grapple rope renders straight spans.
  The BALL chain no longer does: `SlackChain` (below) is a fresh visual drape sim, unrelated
  to that port.
- `ApplyFrictionImpulse` is ported behaviour-for-behaviour but, as in the C# source, is
  not invoked from `physicsStep` (the call is commented out there too).

## Running

```sh
cd rope
bun install
bun run dev        # http://localhost:3100
```

Controls (match the Godot input map): **R/T** move · **Space** jump · **left-click** fire
hook · **right-click** retract-tug · **C** retract · **S** extend · **1/2** spawn circles ·
**P** download a replayable session bundle ·
Gamepad (standard mapping, merged with keyboard/mouse): **left stick/dpad** move ·
**A** jump · **right stick** aim (rendered crosshair) · **RT** fire · **LT** retract-tug ·
**RB/LB** retract/extend · **X/Y** spawn circles ·
**L** toggle the debug overlay (render-only). It shows ledge-grab markers (green marker +
dashed grab-radius circle = grabbable now, hollow red = candidate rotated out of reach,
grey X = seam-occluded, face ticks colored by floor/wall/ceiling classification) and an
arrow for the surface normal the player is currently touching (grounded/wall surface, or
both ledge faces while hanging/climbing), colored by the same classification.

`?render=2d` / `?render=3d` picks the renderer (see **3D rendering**): the ball
level plays in 3D by default and the grapple levels stay 2D, and `?render=2d` is
the escape hatch anywhere. `?probe3d=1` draws the alignment probe.

Pick a level with `?level=NAME` (see `src/level/registry.ts`); `TEST_MOVERS` /
`TEST_WINDMILL` are hand-written mover test levels (sliding platform, windmill),
and `TEST_SPRING` is the spring-body one (a leaf over a chasm to hang off - see
**Spring bodies**); `TEST_VINES` hangs three vines over a chasm to swing across
(see **Vines**).
`LEVEL_2` is the grapple arena (the Godot-extracted scene).

`BALL` is the **default level** (`DEFAULT_LEVEL`), so a bare `/` runs the
**ball & chain controller** — a separate vertical slice
(`classes/ballPlayer.ts`, `level/ballLevel.ts`, `input/ballInput.ts`,
`renderBall`) that shares nothing with the Player state machine. The ball is a
RigidBody2D (rolls via the opt-in `contactFriction` field on RigidBody2D;
default 0 keeps old replays bit-identical). The chain reuses the Rope wrap
solver: its start contact sits on the ball's edge in the ball's local frame, so
it rotates with the ball, winds around it, and applies torque. `World.integrate`
gives every rigid body a `preContactStep` between the rotation step and the
contact gather, and the ball is the only thing in the game that uses it: its
silhouette turns with it, so it settles onto its own support profile there (see
**The loop ride**). The chain solve
runs *after* `World.integrate` (see `BallLevel.physicsProcess`), and `Rope`
writes its positional correction straight onto a rigid body — only the grapple
avatar sweeps — so the ball frame ends with `World.depenetrateRigid(ball)`, a
position-only push-out of the solid geometry around it, followed by
`Rope.absorbBlockedLength()`. Without the push-out a point-blank anchor on
the far side of a surface hauls the ball a little deeper every frame until it is
buried in the scenery.
"Solid" there means **any** body the world collides with, statics and other
rigid bodies alike — it meant statics only while rects and polygons were never
physics-driven, so static scenery was the only thing a chain could haul the ball
into. A rigid polygon's face is exactly as solid, and left out of the push-out it
produced the launch in `session-1474f`: the ball buried itself ~16 cm into a
rigid polygon over ~20 frames, and the instant it emerged, the wrap path it
should have been taking all along appeared at full size in one frame — half a
metre of length error, which the solver turned straight into a 96 m/s launch.
The `absorbBlockedLength()` call after it is the winch stall (see `Rope`) applied
where the frame *actually* ends: the push-out moves the ball after the chain has
solved, so re-basing only inside the solve left a point-blank anchor over its
length every single frame.
`Rope.unwindOverLength()` runs between the two, and is the reason the stall stays
rare enough to be safe.
The stall lets chain out and never pulls it in, so nothing may sit behind it
feeding it a blocked correction every frame.
What it lets out is a **lease** (`Rope.blockedSlack`), not a payment into
`maxRopeLength`: it is re-derived from the present geometry every frame and
released, at a bounded rate, the moment the block eases.
`Rope.constraintLength` (`maxRopeLength + blockedSlack`) is what the solver
enforces; `maxRopeLength` stays the length the chain actually has, which is what
retract/extend and the growth invariant are about.
That distinction is the whole thing, because a blocked correction is rarely a
one-off.
Paid into the length, each frame's instalment became the baseline the next frame
measured against, so a chain held over its length by something that was not going
away grew by that much *again* every frame, forever.
All it took was gravity's own 2.7 mm integration step being refused by the
surface the ball was resting on: 16 cm of chain per second, out of a ball hanging
perfectly still (`session-537f`).
Held as a lease the same persistent block costs the same fixed slack every frame,
and across the whole ball corpus permanent growth is now exactly zero.
A lease is only a lease if it is **released before the solve**, and for a long
time it was not: the release ran in `absorbBlockedLength`, after a solve that had
already enforced `maxRopeLength + blockedSlack`, so a taut rope ended the frame at
exactly that length, the block was measured as the lease it was already holding,
and `max(blocked, released)` handed it straight back.
Every instalment a momentary block ever bought was therefore permanent, and it
compounded: a ball swinging on a 108 cm chain carried 53 cm of surplus it had
earned in two brief blocks a thousand frames earlier, a chain half again as long
as it said it was, felt as the chain slowly stretching while hanging
(`session-1080f`).
The release now happens in `Rope.beginFrame`, so the constraint the solve enforces
is genuinely shorter and the surplus is given back as the rope reeling in.
It is gated on whether geometry refused the correction on the frame just gone
(`Rope.noteBlockedByGeometry`, reported by `BallLevel` from its push-out normals),
because releasing into a *live* block is not a trial but grinding - the solve
hauls the ball into a surface it is already resting on, the push-out undoes it,
and the lease is re-earned every frame for as long as the block lasts, which
swung a ball wound up under a ceiling twice as wide as it should.
`rope-grew` cannot see any of this, and that is the point of the invariant that
now covers it: growth is measured against the anchoring length, so a lease held at
a constant value grows by nothing and reads as healthy for ever.
`rope-lease-held` is the sharp statement instead - a lease may not outlive the
block that bought it - and it fires on a lease above 2 cm carried for more than
120 consecutive frames on which *nothing was blocking*, which leaves the
legitimately-held case (a chain anchored point-blank behind a surface the ball
rests on, blocked for hundreds of frames, `session-726f`) alone.
The aim steering did: it is *kinematic* (it overwrites `angularVelocity`, so
nothing the solver does can stop the ball winding on more chain than it has).
Winding it on is the point, and while the solve can pay for it by hauling the
ball in towards the anchor it does; the failure is at the end of that, wound all
the way up with the ball against its anchor and nowhere left to be hauled.
There the solve's correction was undone by the push-out, `physicsStep` turned the
correction into velocity, and the stall covered the difference — the ball flicked
itself along the ground and kept rolling around its anchor while `session-475f`'s
18 cm of chain grew to 366 cm and dragged the anchor 3 m across the level.
Rotation is the one correction that is always available (a circle sweeps no new
ground as it turns, so no geometry blocks it and there is nothing to push out of
afterwards) and it is exactly the motion that overspent, so it is what pays — and
only for the part the chain could not afford, which leaves a frame the solver did
settle untouched.
It pays no more than it spent, either: the correction may walk the rotation back
towards where the frame *started* and no further.
And it is charged **only once the chain is attached** — the unwind and the
spin-share rollback above are both gated on the chain end being fixed.
Until the hook lands, the far end is the ball's own quarter-kilo hook: there is no
anchor to protect from the spin's share, pulling that hook in is the whole of what
winding against it can mean, and nothing about the rotation is something anything
in the scene could refuse.
Refusing it anyway is what `session-315f` reported.
A deployed, unattached chain draped over the scenery blocked its own correction,
so the unwind walked the frame's rotation back every frame — the aim demanding
4 rad/s and getting none of it — while the contact solve, which runs *earlier in
the frame*, had already sold that rotation as roll: a gripping contact drives the
ball's centre until the contact point is stationary, so the ball's whole
along-surface velocity was that spin's and it survived the spin being taken back.
The ball crossed 40 cm of the chain-hung platform it was resting on at 0.46 m/s
with its rotation standing still — 3.4 radians' worth of rolling out of 0.3 of
turning — read from the game as the platform turning to ice for as long as the
chain was out.
A ball with an unattached chain deployed now turns exactly as freely as one with
no chain at all, which is what a chain hanging off it should cost.
`roll-unfunded` (below) is the detector, and the rule it states is the general
form: a rotation the chain refuses may not have funded traction, wherever the
refusal comes from.
The rest of any over-length is not the spin's doing, and charging the spin for it
spins the ball backwards — at the top of a wind-up that is its own runaway, the
correction subtracting angular velocity while the next frame's push-out leaves a
little more over-length, until a ball winding on at +4 rad/s was unwinding itself
at −15 and shedding wraps (`session-394f`).
The search is Newton on `Rope.lengthPerRadian` (±the ball's radius, since the
chain leaves a circle tangentially) with **backtracking**, keeping the best angle
seen rather than the last tried: path length is not monotone in the angle, so one
full step can swing the contact past its tangent point where the rate flips sign,
and undamped it oscillates between two equally bad angles and lands back where it
started.
Bounding the correction leaves the rest of the over-length for the stall, and
what made *that* survivable is the **frame order**.
The rope pays itself velocity for the correction it writes, Δposition over Δt —
a standard PBD velocity update, and honest, but only if the correction is the
last word on where the body ends up.
The push-out used to run *after* it, so it was not: part of the correction was
undone while the credit for it was kept, and a ball hauled into a surface it was
resting against banked a little more speed every frame and dragged its whole
assembly across the level.
That single mistake was found four separate times — `session-394f`,
`session-458f`, `session-431f`, `session-726f` — each time in a new disguise,
and refunding the difference was tried each time and cannot be made to work: the
credit is taken along the correction and has to be handed back along the contact
normal, so a refund big enough to stop the compounding also injects velocity
sideways, and one small enough not to leaves the compounding.
So the push-out runs **first**: the ball is pushed clear at the top of the chain
phase and the rope moves it last.
A rope correction can still bury the ball for one frame; the next frame's leading
push-out clears it before anything measures a length or a velocity against it,
and `BallLevel` closes the phase by setting the ball's velocity to
`velocityBeforeChain + (realised Δposition)/Δt` — the PBD update taken over where
the frame really ends, both push-outs included, so the ball can never bank speed
for a move that was undone and there is nothing to refund.

Ordering fixes *where* the credit is measured; it does not say **how much of it is earned**, and that is a separate question with its own answer.
Δposition over Δt is honest only while the position error being corrected is error the bodies are still MOVING to create, and nothing in the frame guarantees that: the contact solve runs before the chain phase and can cancel the very velocity that put the ball over its length.
A ball falling onto the floor with its chain already taut arrives over-length by the distance gravity integrated, the contact reverses that velocity and pushes the ball back out, and the chain then corrects the 3.5 cm the push-out left - a real error, correctly corrected - and charges the ball 2.1 m/s for motion the contact had already answered for.
The chain sold the same centimetres twice, and a ball that landed at 0.9 m/s left the floor at 3.0 and rose 43 cm (`session-360f` f305, reported as the ball bouncing far too high).
`rope-solve-kick` never saw it: the gain was 2.1 m/s against a 4 m/s bar.

So the credit is **bounded by the constraint's own velocity-level form** (`Rope.creditBound`).
The rope enforces `length <= constraintLength`, and while it is taut the same statement in velocity is `d(length)/dt <= d(constraintLength)/dt`: the solve may remove exactly the rate at which the path is opening and no more.
Both sides are measurable where the credit is paid — the left from the velocities the bodies carry in, through the **same path Jacobian** the position correction already uses (`resolveCorrectionDir` × `calculateMechanicalAdvantage`, per path object), the right from what the frame's own `retract` took out — so this is the constraint rather than a clamp bolted on top of it.
`Rope.clampCredit` then strips whatever inward speed a credit carries past that bound, along the pull direction only; the swing and the push-outs the phase folded in are not the constraint's to refuse.
The **position** correction is untouched, so the chain still holds its length exactly — what changes is only what the frame is charged for it.

Measuring it over the whole path and not the one body is what makes it survive the cases it must not break.
A moving anchor opens the path with the ball standing still, so the bound is positive and the ball is still hauled and still paid; a body's own radial speed would read zero there and starve it.
The **winch** is the one term the Jacobian cannot see - chain wound onto the ball's own rim shortens the free path with nothing moving, and the ball's rotation is kinematic, so it contributes nothing by construction (the same exclusion `calculateTorqueArm` makes) - so `BallLevel` passes its already-measured `chainWinchSpeedBudget` in as an explicit allowance.
Without it the wind-up would be bounded to nothing, which is `session-322f`'s failure.

The bound is deliberately **not** applied in `settleChainBodies`, and the reason is the shape of the quantity rather than an oversight: that credit is the sum of what a whole coupled set did to a body, and a per-chain bound is not a statement about it.
In a rig where a link and the weight under it fall together, neither chain between them opens at all — their relative motion is zero — while the weight's upward credit is funded by the hanger chain above, through the link.
Bounded chain by chain, every body in such a rig is starved and keeps gravity's step: `cli contacts` `chain-order` leans 178 mm instead of 6 and rings instead of settling.
An honest bound there is a coupled velocity solve over the whole set, which does not exist yet.
The solve moves **every** body on the chain's path — so it settles the ball's spin partly by hauling the far end,
and an anchor that is a rigid body keeps whatever it was given.
That is the fourth piece: the spin is a *kinematic* input with no force behind it
and the unwind is about to refuse it anyway, so `BallLevel` measures how much of
the frame's over-length is the spin's (`|Δrotation| × lengthPerRadian` against the
total) and rolls that share of the solve's correction back off everything but the
ball, leaving the unwind to pay for it in rotation.
Hauling the *ball* is untouched: that is the winch, and it is how winding chain
onto yourself pulls you towards the anchor.
Without it a chain anchored to a rigid polygon resting on the floor was fed a
fresh 0.08 m/s every frame and slid 31 cm across the level with the wound-up ball
riding its corner, peaking at 2.5 m/s instead of 0.5 (`session-265f`).
Refusing the spin *before* the solve instead is the tempting simplification and
it is wrong — the solve paying for the spin by winching the ball in is exactly the
winding mechanic, and pre-refusing it cancelled 197 radians of legitimate spin in
a ten-second wind-up and left the ball at zero wraps.

A **sprung anchor** — a torsion-sprung pivot or a spring mount — is rolled back like every other, and then handed the load it is still carrying as an explicit force, because the rollback's premise splits for it.
A ball winding itself up a chain anchored to a sprung branch is hanging off that branch the whole time, so the plain rollback left the branch at its UNLOADED rest angle with the ball dangling from it, then sprang it past that as the wind-up shortened the chain (`session-454f`, the pivoting log pulled up by a wind-up that should bear down on it).
Weakening the rollback is not the answer, and both weakenings were measured before this landed where it is: the rollback re-breaking the constraint is the winch's GOVERNOR — it is what hands the unwind the length to refuse — and a sprung pivot is the anchor it matters most for, its torque-arm effective mass `arm²/I` sitting near the ball's own while its spring damping is a hundredth of the rate the credit is re-earned at.
Exempted from the rollback entirely, the solve's velocity credit compounded at −2 rad/s per frame into a 13 rad/s whip that buried `session-136f`'s log 733 mm in the wall beside it and slung the ball at 24 m/s; keeping only the position share re-broke nothing, so the unwind refused nothing and the same whip arrived through position at −7 rad/s; bounding the credit by `creditBound` does not hold either, because the bound is computed from the bodies' own velocities and chases the runaway once the pump has polluted them (1.9 → 7.9 rad/s while the credit ran away underneath it).
So the rollback stays whole and the load crosses by the ledge hang's mechanism instead (`applyHangLoad`'s statement, made about the chain): the ball's weight, straight down at the anchor point, scaled by the share the rollback removed — a bounded constant force, which a spring answers with a damped, settled droop, where a velocity credit is answered with a whip.
Two gates decide when the chain is what carries the ball, and the second was found the hard way: the ball must hang BELOW the anchor, with NO loaded contact under it.
Aimed along the anchor-to-ball line instead, the force rotates with a swinging ball and pumps the hinge parametrically — gravity's own constant direction cannot — and applied while the ball rides the body it is wound up to, it is a second, phantom 510 N on top of the contact that is already delivering the weight: over 40 such frames the log wound to −4 rad/s with the ball surfing its tip at 13 m/s and flinging off on release (`session-1010f`).
`cli spring` `winch-load` is the detector, over both sprung kinds: the loaded hold, the slow wind (the body carries the load and never springs past rest), and a wound-tight endgame at a hand-whip pace that must neither whip the body nor fling the ball.
The load half is red alone with the impulse removed (the log springs 0.2 rad past rest with the ball hanging off it); `session-136f` and `session-1010f` are the recorded artifacts.

**Open, diagnosed, not fixed: a PIVOT body as the winch's anchor can be whirled into a slingshot.**
The measurement that isolates it (a thin hinged bar the shape of `levels/ball.json`'s pivoting log, the ball anchored to its far arm, the cursor whipped in circles at a turn per 1.5 s for 10 s, identical inputs throughout): a **static** anchor peaks at 2.5 m/s, the same bar **sprung** at 55 m/s, and as a **plain pivot** at 137 m/s.
The winch's governor assumes winding either hauls the ball to the anchor or is refused by the unwind, and a pivot leaks through it: the bar's rotation co-rotates with the whirling ball, so the pair orbits together, the chain never winds tight, nothing is ever refused, and the kinematic aim pays its winch budget into the system every frame with the frictionless bearing storing it.
The share of each correction the rollback leaves (the real-motion share, `1 − spinShare`) lands in the pivot's rotation, whose credit has no velocity-level bound — and bounding it by `creditBound` was implemented and measured ineffective, since the bound reads the bodies' own (by then polluted) velocities.
It is not this feature's regression — a windmill fin has been anchorable since pivot bodies existed — but the sprung branch makes the play pattern common.
The honest fix likely involves the unwind refusing spin whose correction landed in an anchor's ROTATION, which is a solver design question; two bounded attempts are spent, so it is recorded here instead.

The fifth piece is that the frame may not *end* with the chain driving the ball
through a surface.
`World.depenetrateRigid` returns the outward normals it pushed along, and
`BallLevel` cancels any component of the chain phase's derived velocity that
points into one — the same statement as the push-out itself, made in velocity
instead of position.
Leaving it in does not merely look wrong, it powers a drive.
Next frame's `integrate` kills that velocity at the contact and sizes the Coulomb
friction budget from it (`maxImpulse = μ·m·(vnKilled + gravityBite)`), and the
ball is spinning under kinematic aim steering, so the budget is spent *driving*.
A ball held against a ceiling by a taut chain therefore funded its own traction
out of the constraint pulling it up there: +1.2 m/s of Δv per frame, sideways,
which the chain solve then removed and the next frame re-earned.
It slid along the ceiling until it ran out of ceiling, ratcheting 2 mm of chain
out per frame on the way (`session-537f`).
Cancelling it restores the rule the wall case already obeyed: once resting, a
surface gravity does not press the ball into gives no traction, so a spinning
ball cannot climb a wall — or drive along a ceiling.
A constraint is not a force here and may not act like one.

Gravity is, though, and the cancel is bounded because of it.
The ball arrives at that phase already pressing into whatever it rests on —
`integrate` applied gravity and the contact solve does not run again before the
frame ends — so cancelling the component *outright* took gravity's own step with
it, and that step is what a resting contact carries and what the next frame's
Coulomb cone is sized from.
Taken, the contact spent a normal impulse of **0.4** where a chainless one on the
same slope spends **8**, the cone collapsed with it, and a ball resting on a rigid
platform accelerated down a 15° slope at very nearly the full tangential gravity
for as long as the chain stayed anchored: 35 cm in 30 frames, against a free ball
that stops in 15 (`session-291f`).
So the bound is gravity's own per-frame step, and no more than the ball brought
in with it — the rest of the entering approach may be momentum an earlier chain
solve wrote, and refusing that is unchanged.
The ceiling and wall cases are untouched either way, because gravity there points
out of the surface and both bounds are zero.

### The steered ball's grip

`applySteeringGrip` pins the rolling ball's centre to an anchor that **advances
by the roll it intended**, which is how the one frame of gravity creep the
integrator slides in underneath it is removed without touching the roll itself.
That anchor survives a few ungripped frames (`STICK_RELEASE_FRAMES`) because the
grip flickers, and for a crate holding a slope that is right - it drifts
sub-millimetre while the grip is off.
A rolling ball does not drift, it **travels**, and the anchor stands still while
it does, so resuming onto a held anchor yanks the whole lapse out in one frame.
Five ungripped frames at 2.4 m/s put the anchor 21.7 cm behind the ball and the
grip dragged it back there, with no velocity change to show for it: a teleport,
backwards, through its own direction of travel (`session-497f` f376, reported as
the player rubber-banding).
So the anchor is continued only if the grip actually held **last** frame, and
re-seeded otherwise, which costs nothing because this anchor holds no position -
it advances every frame and exists only to remove that one frame of creep.
`cli contacts` `grip-reseed` is the case: a ball rolled across a gap narrower
than `STICK_RELEASE_FRAMES` of flight, which is the only way to make the grip
lapse and return with the anchor still held.

It grips **scenery** as it grips the world, and for a long time it did not.
`applyStaticGrip` declines a `kinematicRotation` body on purpose - a steered
anchor has to advance by the roll rather than hold a point still - and this
routine declined every rigid surface, on the argument that gripping is against
the immovable.
Between them the one body in the game that is always steered had no position pin
at all against a rigid body, so it kept the whole of gravity's integration step
every frame: exactly the leak **The position pin** below is written about, at
0.68 mm of sideways travel a frame, 84 cm down a 20° ramp in fifteen seconds,
reporting a velocity of zero the whole way.
Two things had to change together, and the second is the one worth remembering.
A pair is offered from **both sides**, because which body leads a constraint is
an id ordering and nothing more - against a ramp built before the ball, the ball
is `b`, and reading `a` alone (which was enough while `b` was always a static)
looked straight past the only body this routine exists for.
And resting is what the contact **carried**, not how deep it is: the solve pushes
a resting interface to exactly zero overlap and the pair then falls by the same
gravity step, so a `depth > 0` test reads float noise (see **Resting contacts**)
and dropped the grip every other frame.
Since a lapsed grip re-seeds its anchor wherever the ball has got to, each lapse
kept the creep it was there to remove - still 78 cm, with the grip nominally
holding.
`normalImpulse > 0` is the test instead, which is the same statement `mu * Pn`
already makes about how much grip there is to have.
`cli contacts` `steered-ramp-hold` is the case, and it measures the static ramp
beside the rigid one so the number stands against the same ball on the same
slope.

The third piece is that the anchor advances by the roll **relative to the
surface**, and not by `surfV - ω×r`.
The velocity the grip writes wants the surface's own motion in it - a ball riding
a moving body moves with it - but the anchor is held in that body's frame, so it
is carried along already and counting `surfV` again double-counts it.
Against a static the two are the same vector, which is why every static case was
blind to this.
Against a rigid one it is the whole of what was left: this engine integrates
before it solves, so a body carries a frame of gravity's velocity until something
cancels it, a contact does that every frame and a **chain never does** - a PBD
length constraint corrects position, not velocity.
A chain-hung platform therefore sits still while permanently carrying 0.163 m/s
downward, the grip read that as the surface sliding underneath, and the anchor
chased 54 mm/s of phantom downhill slip at 0.9 mm a frame: 29 cm down a 14°
slope in ten seconds, gripping on every frame, reporting a velocity of zero
(`session-599f`).
`cli contacts` `steered-hung-hold` is that scene - the same slab, held up by two
chains instead of by the ground - and it measures the ball against the SLAB,
because the rig is a pendulum and a ball riding a swinging slab is the ball doing
its job.

### Spin traction on a fresh contact

The steered spin is an infinite reservoir - `kinematicRotation` means no impulse can despin it - and the friction cone is written on the understanding that the normal impulse scaling it is a real load.
An impact's normal impulse is many frames of load delivered in one, and spent against the spin it mints energy: a ball rolling into a wall at 3.9 m/s had the rim's slip stopped outright out of a 234 N·s arrival impulse and left the floor at 4.4 m/s straight up with its spin untouched, an 86 cm launch off a flat wall (`session-773f` f600, felt as being thrown into the air).
So the cone in the spin's drive direction is sized from the pair's SUSTAINED load (`World.pairLoad`), never from the whole accumulated normal impulse: the sustained value never sits under the gravity press (full on a floor, nothing on a wall or a ceiling - the impact-frame statement of "a spinning ball cannot climb a wall"), climbs by one frame of weight per carried frame, and follows the pair's real load down instantly.
A steady load - gravity on a floor, a crate resting on the ball - reaches full funding within a dozen frames and keeps it, so every settled and persistent mechanic is left as it was; an impact decays before the ramp can chase it, and a ball GRINDING on a wall reads zero for ever, because between its own micro-bounces nothing presses it in.
Contact age is deliberately NOT the test: a pair bouncing gently on a wall stays "in contact" indefinitely while carrying no load at all, and maturity-by-age funded a second launch out of exactly that - a 78 cm wall climb off repeated micro-impacts (`session-422f-wall` f373).
The linear share of the slip keeps the full cone (`linearNeed`) - a skidding ball is still braked by a wall it hits - and the load is tracked per body PAIR with a few frames' absence grace (`PAIR_LOAD_GRACE`), because a compound body's touching shape changes while its press persists and a held press flickers out of the constraint set for a frame at a time.
An **anchored chain switches the whole regime off** (`RigidBody2D.constraintTethered`): the wind-up's climb to its anchor starts on a wall the ball has only just met, funded by its own arrival impact, and the chain machinery - the winch budget, the unwind, the lease - is what polices chain-era traction.
The cap therefore guards exactly the FREE ball, whose wall impact has no chain to answer for it.
`spin-overdrive` is the invariant: it reads the applied tangential impulse against the same funding arithmetic the cap enforces, so it is zero by construction while the clamp holds and catches any future path that spends spin-funded impulse outside it.
`ball-roll-wall` is the mechanic test - a ball driven 6 m into a vertical wall rises 26 cm at the old physics and under 5 cm now (`maxClimb`), while still reaching the wall at speed - and `session-773f` (the rolling launch) and `session-422f-wall` (the grinding climb) are the committed regressions.

### The loop cap

Driving the mounting loop into the ground must **never** hop the ball, however
hard it is spinning.
Left to the contact solver it does, and the size of it is set by the loop's
rotation **phase** at the instant it lands, which is the one variable the player
can neither see nor aim.
The loop is a second collision circle offset on the rim, so unlike the ball's own
surface its contact point carries a *normal* component of ω × r; the spin is
kinematic, so the solver may not take that energy back out of it, and all of it
lands in the ball's linear velocity.
The same roll into the same floor launched at 1.7 m/s once and 4.4 m/s a few
hundred frames later (`session-1594f`), which reads as the ball randomly deciding
to fire itself off the level.
So a frame the loop is down on has its outgoing normal speed **capped**
(`BallPlayer.applyLoopCap`), at the plain restitution bounce the ball's own
linear approach was worth.
There was for a while a designed hop written over the cap above a spin threshold
- a ramp from `LOOP_HOP_MIN_SPIN` to `LOOP_HOP_MAX_SPEED` - and it is **gone**:
a loop touch is a touch at any spin, so a wind-up buys speed through the roll and
the chain rather than through the floor.
What the cap removes is exactly the **spin's** own contribution at that contact -
`(ω × r)·n`, scaled by `1 + restitution` because that is what the solve does with
an approach - and not a fraction of the answer.
The difference is the violent cases: a ball slammed into the floor at 4 m/s is
owed its full response, and a blanket cap takes 60% of it away, which leaves the
ball on the ground where the chain then hauls it (`rope-solve-kick` at 5.1 m/s in
`session-477f`).
Capping to *nothing* is worse again: the loop rotating under the ball really does
lift it, so the loop ends up pinned in the ground, its velocity answer removed
every frame while the positional sweep pushes the ball back out - a body
corrected in position and paid nothing for it, which the chain reads as a blocked
correction.
It is written after the contacts and the depenetration sweep, for the same reason
`applySteeringGrip` is: a control input with no force behind it cannot be
expressed as an impulse the solver would cap.
`cli contacts` `loop-cap` is the detector, and it drops the same ball at eight
starting rotations at three spins - ordinary rolling, a hard wind-up, and 90
rad/s, well past anything the aim steering produces.
Every one of them must peak at the drop's own restitution bounce (0.85 m/s, from
2.18 before the cap existed) and the phases must agree (they spread 1.25 m/s
before and are identical now).
The high spin is what stops the hop coming back as a threshold nobody notices:
the phases agree just as well when a launch is being written over them.

The cap is one half of the loop, and the **friction cone** is the other.
A shape mounted at the body's own centre reaches a contact only as slip - its
contact point lies along the normal, so `omega x r` there is purely tangential -
and that slip is the conveyor belt that *is* the rolling mechanic, Coulomb-capped
by the ball's own weight.
The loop is mounted off the centre, so its contact point carries a **normal**
component of `omega x r` as well: spinning presses it into whatever it is
against, which fabricates a normal impulse out of a kinematic spin nothing paid
for, and `mu * Pn` then sizes a friction cone from it.
The cone is the drive, so the ball funded its own traction against a **wall**:
135 N·s of normal impulse out of a ball whose own approach to the wall was zero,
spent as 120 N·s of friction pointing straight up, +2.1 m/s per touch.
It ratcheted 90 cm up a flat wall in 35 frames on nothing but the spin
(`session-200f`), and no invariant saw it - the run replays HEALTHY, because a
ball going up is only a bug once you know it had nothing to climb with.
`World.spinFabricatedNormal` measures that share and takes it off the cone: what
the spin pressed the surface with is not something the surface may press back
with.
It is the same statement the cap makes about the outgoing normal velocity, made
about the tangential half, and as there it is the spin's **own contribution** and
not a fraction of the answer - sized as the impulse that kills the spin's
approach and pays its bounce, so a contact keeps the whole of the cone its own
linear approach earned.
Removing the spin from the tangential **slip** as well is the tempting second
half and it is wrong: a loop bearing down on the floor is bearing the ball's
weight, and there the drive is the mechanic working.
Taken out, a rolling ball loses a fifth of its travel (`ball-roll-drive`, 2.4 m
against 4.9) and a ground wind-up stops paying its chain in
(`ball-ground-wind-up`).
The load is what was fabricated; the slip was always real.
The gate is the **mount** and not the arithmetic - for a centred shape the term
is identically zero, and asking the shape where it is mounted keeps it exactly
zero in floats rather than nearly so, which is what leaves every recorded replay
of a ball rolling on its own rim bit-identical.
`cli contacts` `loop-wall` is the detector, and its floor is **frictionless** on
purpose: a ball rolling on an ordinary floor drives itself into the wall through
its own rim and then bounces up it off a load its impact genuinely paid for,
which is a different question with a different answer, and a scene mixing the two
cannot say which one it is watching.
With no traction under it the ball has no approach to the wall at all, every
newton the wall pushes with is the spin's own doing, and the only honest answer
is that it stays where it is - 3.8 cm of the capped bounce off its own loop,
against 44 cm and 7.4 m uncapped.

### The loop ride

The cap is a statement in **velocity**, and it is only half the loop's descent.

A rolling ball leaves every ascent frame at a normal velocity of exactly 0.000: the cap sees to that, and it is right to.
What lifts it anyway is the contact solve's **positional** correction, which tracks the ball's own silhouette to 0.02 mm all the way to the lug's bottom-dead-centre.
That silhouette is the support function of the ball-and-loop union, `BallPlayer.loopExcess`: `max(0, loopArm·cos θ + LOOP_RADIUS − radius)`, a 35 mm lug standing over an otherwise circular ball for the 84.4° of each turn where the loop reaches past the rim.

Past bottom-dead-centre the loop turns **away** from the surface faster than gravity can drop a 52 kg ball - 2.45 m/s of profile against gravity's 0.163 a frame, at the aim's ordinary 27 rad/s.
The overlap vanishes, no contact is gathered, and nothing holds the ball to its own silhouette: it free-falls the 35 mm instead, `sqrt(2h/g)` = 5.1 frames, once per revolution.
24% of `session-105f`'s frames with no contact at all, so no `applySteeringGrip` and no sideways drive, in runs of four - read from the game as the ball's acceleration cutting out every time it comes round.
The free-fall time does not depend on the spin (it is a fall from 35 mm) but the **fraction of a revolution** does, which is why it is a fast wind-up that feels broken and a slow roll that does not.

`BallPlayer.applyLoopRide` owns the descent, and owns it the way the ascent already happens: as **position**, with the velocity left where it was found.
It is called from `RigidBody2D.preContactStep`, a hook `World.integrate` runs after the rotation step and before the contact gather.
That window is the whole thing and is not interchangeable with either side of it: run before `integrate` and the rotation it answers has not happened; run after the solve and the frame's contacts have already been decided against a pose the ball was not going to keep - which is exactly the difference between rolling and hopping.

Four pieces make it work, and each of them was a bug first.

The ride **places** the ball on `loopExcess` and never lifts it: raising is the solve's, and taking it would put the ride in the business of raising a ball off its own kinematic spin, which is the cap's whole subject.
Where the ball stands is **measured**, not assumed - the clearance the ride left it at last frame, plus the projection of everything that has moved it since.
Assumed instead, the ride's two halves both descend, the same centimetres are spent twice, the ball ends a frame 1.6 mm under its rim, and the depenetration sweep lifts it back out along the **loop**: 2.2 mm high once a revolution, compounding, until it is floating clear of the floor with nothing under it at all.

It also writes the profile's own **rate** along the normal, and this is not the same job as the placement.
Placed but not tracking, the solver reads a contact point separating at the loop's full `ω × r`, and a separating contact carries no load - no normal impulse, no Coulomb cone, no grip.
A ball perfectly on its own profile and still not driving is the bug this exists to fix, arriving as a silent zero rather than as a hop.
The rate is taken **analytically**, `ω · (n × loopDir) · loopArm`, the support function differentiated: a finite difference of `loopExcess` over the step is a chord of the arc, and 0.42 m/s of chord error was enough to make the loop read as separating on the sharpest frame of each revolution.
Gravity's step stays on top of it, because that step is the whole of what a resting contact answers and what sizes its cone.
And it is floored at the rim plus a contact skin: unfloored, the ball reached the rim carrying the profile's 2.1 m/s, which is over `RESTITUTION_THRESHOLD`, and 0.15 of it came back as a bounce - the hop again, wearing the ride's clothes.

The rate is written on the **descent only**.
Writing the rise as velocity would hand the ball up to 2.45 m/s of outgoing normal speed for its own kinematic spin, which is precisely what the cap refuses - and the cap, running later in the frame, takes it straight back off.

The ride ends by setting the ball **down** on its rim and handing the normal velocity back, in that order.
Returning before the placement left the ball wherever the last frame's tracking had reached: 6.4 mm short of the floor at 45 rad/s, a two-frame hop at the end of every ride.
Handing the velocity back before the gather is what keeps the frame the rim takes over from reading the tracking speed as an **approach**: solved as one it is up to 2.45 m/s of `vnKilled` sizing a cone, and the ball is spinning kinematically, so that cone is spent driving - the fabricated traction `spinFabricatedNormal` and the ceiling case exist to refuse, arriving once a revolution.
It is handed back only when the ride actually tracked, because a ride that never had to write has nothing to give back and handing it an opinion anyway reaches past the mechanic (0.42 m/s of `roll-unfunded` in `session-726f`, 8.3 m/s of `rope-solve-kick` in `session-611f`).
Subtracting the written term instead is the other tempting answer and it is worse: by the time a ride ends the solve and gravity have both had their say on it, so taking the whole of it out again is a kick **upward** - 61 airborne frames at 8 rad/s, where setting leaves none.

Three gates decide what may be ridden, and all three are about not fabricating load.

A ride is taken only while the loop is on its way **in** to a surface that was already carrying the ball two frames running - the first half is what separates a ball rolling onto its loop from one landing on it, the second is what stops a ride being picked up halfway down something it never rode up.

The surface must **carry the ball's weight**: `restsOn`, at least half of gravity along the normal, which is every slope out to 60° and no wall at all.
Against a wall the ball has no weight pressing it on, so every newton the wall pushes back with would be the spin's own doing - the same fault `spinFabricatedNormal` refuses, arriving by another door.
Unfenced it climbed 148 cm at 20 rad/s on `loop-wall`'s frictionless floor against an 8 cm bar, and 1.20 m on `ball-roll-wall` against 0.15.
The line is drawn on the **normal** and not on stiction, which is the tempting one-line test (`applySteeringGrip` asks exactly that): the arena's 32° ramp sits a degree and a half past `STATIC_FRICTION`'s breakaway, so a ball rolling down it was refused a ride while carrying 85% of its weight on the surface, and hopped down the slope exactly as before.

An **anchored chain switches the regime off** entirely (`constraintTethered`), exactly as it does for the spin-traction cap.
A ride is a statement about a ball rolling on the ground; a chain gone taut is the one thing in the game that owns where the ball is instead, and the winch budget, the unwind and the lease are what police that era.
A ride laid over the top of it is a second author of the same quantity, and it read as both bugs it could.

Finally, a ride may only ever write what a ride is **worth** - the fastest the profile can move at this spin, plus a step of gravity either side.
Asked for more, the ball is not rolling on that surface and the ride sits the frame out rather than overruling whatever is.
It sits out rather than releasing, because a bound this close to the mechanic's own scale will clip a real ride now and then and a release cannot be undone until the loop comes round again.

`cli contacts` `loop-ride` is the detector, and it asks three things of the same scene at four spins and eight phases each: the ball never leaves the ground, never stands higher than its own lug, and never puts the lug through the floor.
Deleting the loop's collision passes the first two and fails the third; leaving it alone passes the last two and fails the first.
It is green at 0 airborne frames of 1440 everywhere out to 45 rad/s, which is where the aim's proportional gain caps the spin, against 261/353/623 before.
The load-bearing bar is separate and looser, and the gap between them is the honest residue of the profile's corner: on the frame it falls faster than what is left of the lug the ball is held to the rim, so the loop grazes at exactly zero depth while turning away - touching, and carrying nothing.
23 frames of 1440 at 27 rad/s, against 328.
Past the aim's range it degrades rather than breaking: at 90 rad/s the window is one frame wide and the ball still leaves the floor for 623 of 1440, against 1049.

### The coil

Rope wound onto the circular body the rope *starts* on — the ball winding its own
chain around itself — is carried as an **angle**, not as a run of wrap nodes
(`Rope.syncCoil`).

Everywhere else a wrap is a discrete decision about one corner, and that is the
right model: the rope either bends around that corner or it does not. A coil is
not that. It is one continuous quantity, and representing it as a run of twenty
tangent points made every frame's answer a fresh stack of twenty independent
decisions that did not agree frame to frame. `cullDetachedNodes` drops a wrap
once the rope stops bending around it — correct per node, and it **cascades**:
the tail node goes, the one before it inherits the new outgoing span and goes
too. In `session-458f` three went at once and the measured path fell 18.6 cm with
nothing having moved, which the solve "corrected" by snapping the bodies several
centimetres while the winch stall covered the rest.

Three things determine a coil, and each is continuous on its own:

- the material point the rope leaves the body from (`start`), which rotates with
  the body;
- the tangent point it leaves *at*, which is geometry — where a taut line from
  the next node touches the circle — and slides smoothly as that node moves;
- how many whole turns are in between, the only thing that has to be remembered,
  and remembered by **unwrapping** the angle against last frame's rather than
  re-deriving it.

Winding past a full turn and unwinding back through zero are then both ordinary
arithmetic on one number. There is no create, no cull, nothing to cascade. The
nodes are re-derived from the angle at `COIL_NODE_ARC` every regeneration, which
is a *rendering* resolution — only the last of them reaches the length solve,
since `generatePathObjects` already collapses a run of same-circle wraps into the
one that leaves the body.

The coil is also why `regenerateAndMeasure` takes its baseline **after** a coil
sync: the coil's nodes ride the body, so between frames they carry its rotation
with them and the stored path is a turn's worth out of date. Sync first and the
difference is the node set changing; sync after and a ball spinning at 46 rad/s
reads as a 13 cm "discontinuity" that is really just the ball having moved.

Two supporting pieces:

- `Rope.spanLength` measures a span between two nodes on the same circle as the
  **arc**, not the chord. Rope lying on a circle is an arc; chords understate it,
  and by more the coarser the sampling.
- `Rope.topologyCreditScale` is the backstop for whatever discontinuity is left
  anywhere else in the path: the share of a frame's length error that a
  regeneration put there is corrected in position but earns no velocity.
  Δposition over Δt is how half a metre of phantom error once became a 96 m/s
  launch (`session-1474f`).

Across the whole ball corpus this leaves **one** frame with a path discontinuity
over a centimetre, at 1.6 cm — against roughly twenty-five frames reaching
19.7 cm before.

Two invariants back this up (`checkBallInvariants`). `rope-grew` bounds the chain
against the length it anchored at, but only loosely: a single discontinuous jump
in the wrap path can be most of the total on its own (26 cm in one frame in
`session-284f`), which is not this bug. `rope-stalling` is the sharp one — a
*run* of blocked frames is the shape of every chain runaway there has been, and
the corpus split cleanly when it was written, 17 frames at most when healthy
against 79, 51, 36, 32 and 28 for the runaways.
**That margin is now thin**: a healthy `session-431f` runs 59 blocked frames
against the invariant's 60, up from 6, and the rise is what a properly held ball
looks like rather than a runaway - a chain pulling the ball into a surface it is
resting on is now refused *consistently* instead of intermittently, and the run's
chain ends at exactly the length it anchored at (zero growth) in every case.
The counter is a proxy for the runaway and it has drifted toward the thing it
measures against; before trusting it again, re-measure the split across the
corpus and re-derive the bar from what healthy actually reads.
A hard ceiling on the stall itself is **not** an option, tempting as it looks:
a point-blank anchor is legitimately held over its length by the geometry it is
anchored to, and capping the stall leaves the solver fighting the push-out every
frame — over-length, solve-kick and embedding violations in `session-284f` and
`session-1474f`, whose chain anchors 2 cm from a surface the ball is resting on.
The push-out resolves its **two deepest overlaps simultaneously**, the same solve
`moveAndCollide` uses (`d·n1 = depth1`, `d·n2 = depth2`, escaping through the
wedge mouth). Doing them one after the other is what its own comment warns
against — pushing fully out of one surface can push straight into another, and
whichever was handled last wins — and a ball resting on the floor beneath a rigid
polygon is exactly that wedge: sequentially it drove the ball ~10 cm into the
floor over four frames (`session-284f`).
The chain end is
a `BallHook` — a RigidBody2D projectile that anchors to the first surface it
contacts, flying or dangling.
The throw is a **straight line**: the hook carries `gravityScale = 0` for the
deploy and `BallHook.endFlight()` switches gravity back on the moment the throw
ends, so the shot goes exactly where it was aimed and only then falls.

A hook that lands on a hook-proof surface and STAYS there is steel, not a puck
on ice, and four pieces make that true (session: the tip crept indefinitely
across the shallowest slopes; `cli contacts` `hook-rest` is the detector -
holds on 10° and 25°, still slides off 50°).
It carries real coefficients (`contactFriction` 0.55, `staticFriction` 0.6,
breakaway atan(0.6) ≈ 31°) where the RigidBody2D defaults are 0.
`probeContact` deflects a hook-proof contact only above
`PROBE_DEFLECT_MIN_SPEED` (0.5 m/s): the probe's seat holds the hook a margin
clear of the surface, so a RESTING tip deflected every frame hovered outside
the solver's reach for ever - no loaded contact, no normal impulse, no
friction cone however real the coefficients; below the gate the contact solver
owns the tip, and above it the deflection (and the spark stream made of its
reports, well over this speed in every recorded drag) is untouched.
Its rotational inertia is the disc's times `ROLL_RESISTANCE` (1e4), because a
circle with friction ROLLS - the contact point is stationary, the slip Coulomb
acts on is zero, and the stiction gate reads a spin far over `STICK_SPIN` - so
the hook trundled downhill with its friction fully satisfied; a manacle is
nothing like round, and the inertia is that statement (nothing else reads the
hook's rotation - the chain pulls at its centre and the drawn manacle is
oriented by the chain).
And `applyStaticGrip` no longer gates on depth (see **Resting contacts**). Every
ending calls it — the hook attaching, a bounce off a hook-proof surface (the deflected
remainder does arc), the chain snagging geometry, and the chain running out of
length (so the dangling tip swings instead of hanging in the air).

The attach test **must out-reach the solver**, and that is why its sweep runs `CONTACT_SLOP` past the end of the step rather than stopping at it.
`World.integrate`'s constraint gather keeps *speculative* contacts out to that band and cancels the approach velocity of anything that would close the gap within the step, whether or not the two ever overlap.
So a hook that stops short of a surface by under a centimetre never gets a second frame in which to touch it: the solver has already spent the approach, and what is left is tangential.
In `session-593f` the hook fell 200 mm in one step at a hanging plank 193.7 mm away, the sweep wanted `t = 1.033` and returned null, and the solver converted 12 m/s of approach into a 4 m/s skate along the plank's face that carried the hook off its corner over the next twelve frames - a clean shot at a big target that simply did not stick, and which replayed **HEALTHY**, because nothing about it violates an invariant.
The reach costs no accuracy: the anchor is still placed at the swept contact point, which is on the surface.
The overlap probe's margin is deliberately **not** widened to match.
The sweep extrapolates along a known direction of travel; the probe has none, so a `CONTACT_SLOP` probe would anchor to whatever is within a centimetre, float the anchor off the geometry (`session-601f`) and lengthen the chain's path enough to kick the ball as it anchors (it fails `rope-anchor-kick` on `session-576f`).
A near-stationary hook needs no help from it in any case, since the sweep's reach never falls below `CONTACT_SLOP` however slow the hook is.
`playtests/ball-hook-short-step.json` is the scenario in isolation: a throw whose step ends 8 mm short of a ceiling must anchor on that same frame.

Reaching further is still only an **approximation** of the solver, though, and the exact half of the attach test is `BallHook.attachToBlockingContact`, which reads `World.frameContacts` and anchors wherever the solver actually pushed back.
The two measure different things and cannot be made to agree by tuning a distance.
A sweep measures **along the path**; the solver's band is **perpendicular**, so on an oblique approach the path to contact is longer than the gap across it by `1/cos` of the angle between them and a reach of one `CONTACT_SLOP` under-covers a band of one.
The solver is also blind to the contact point sliding off the feature within the step, so it blocks against a corner's face *plane* on paths that clear the corner.
`session-1154f` is 4 mm of exactly that, at the swinging end of the same hanging plank: a 2.9 N·s impulse off the end face's plane turned a 12 m/s throw into 4.9 m/s at 45° off aim, with every predictive test correctly reporting no contact.
Reading the solver's own contacts needs no second copy of its predicate and cannot drift from it, and `normalImpulse > 0` is what separates a contact that pushed from a speculative one that asked for nothing - so a hook coasting parallel to a wall a few millimetres clear still does not anchor to it.
It is one frame late by construction (physicsStep runs before integrate), which is why the sweep exists and runs first: the sweep catches the head-on case on the right frame with the shot's velocity intact, and this catches everything else on the right surface.

It rescues a **throw** only. A dangling tip hangs at exactly `CHAIN_MAX_LENGTH`, so anchoring it on a contact reported while the hook is still millimetres clear buys the chain that much extra path, and a chain going taut-to-slack in one frame drops the ball it had been braking - 0.7 m/s of `rope-anchor-kick` on `session-576f` f60.
A tip drifts into its surface slowly and the probe catches it on real contact, which is what keeps the anchored length honest.
The `hook-blocked-attaches` contact case is the general statement, asserted over a fan of 240 throws past a tilted slab's end rather than at one placed near-miss: **every throw the solver pushes on must anchor**.
A single fixed offset would stop straddling the sub-millimetre margin the moment the manifold changed, and then pass by missing the geometry instead of by handling it.

Whichever surface the hook reaches first decides, and where two are reached at once **an attach beats a bounce**.
Attachable and hook-proof geometry are therefore swept as two separate questions (`bodySweepCircle`'s `only` filter) rather than as one earliest hit.
The two are not comparable outcomes - a bounce is "nothing happened, keep going" and an attach is the throw being over - so ranking them against each other lets whichever surface sorts first decide for both, and at a seam there is nothing to sort by at all, since `t` is equal.
What actually decided was body **build order**, which is to say the order the level file happens to list its bodies in.
`session-596f` is that: the hook came to rest in the seam where a hook-proof disc meets an attachable pillar, touching both, and bounced off the disc at `t = 0` on every frame for 250 frames while sitting on a surface it should have anchored to on the first.
Nothing about it is a velocity - the hook sat still - so the only thing it showed up as was the chain it left dangling: frozen at its deployed length with its tip held by geometry, it fed the winch stall a blocked correction every one of those frames and grew from 64 cm to 3.58 m, read from the game as the chain stretching without limit.
`probeContact` had the same blindness one step further on, and there it needs no tie-break to justify the rule: a probe has no direction of travel, so every surface in the band was reached at once, and a hook-proof surface the tip is also touching does not un-touch the one it caught.
The anchor **point** is the other half.
The swept path places it a radius back along the inward normal from the contact-frame centre, which is the surface only while that centre is genuinely a radius clear of it.
A sweep that *begins* inside the piece returns `t = 0` (see "rest resolution when a sweep starts embedded"), so the centre is the hook where it stands and stepping a radius further buries the anchor - 2 cm inside the pillar, which the chain then runs through.
There the surface answers for itself (`nearestSurfacePoint`), exactly as `probeContact` has it answer for the same reason.
`cli contacts` `hook-seam` is the detector, and it asserts the seam from **both build orders** - an answer that depends on which body was listed first is not an answer - that the anchor lands on the face rather than a radius inside it, and that a hook-proof surface genuinely reached *first* still deflects, which is what stops the fix collapsing to "attach always wins".

At the absolute max length
(`BallPlayer.CHAIN_MAX_LENGTH`) an unattached hook becomes the dangling chain
tip: the chain stays deployed at that length (solver-driven swing) until it
touches a surface and anchors, or is released. A deploying chain
that snags scene geometry mid-flight also converts to the dangling tip: while
the hook is in flight the chain is slack (no length solver), so
`BallPlayer.checkChainReach` runs `Rope.detectSceneCatch` each frame — if the
straight span has caught on a body other than the ball itself (ball
self-winding from aiming is not a catch), it keeps the generated wrap node and
freezes the deploy at the wrapped path length, so the chain wraps the corner
and stops paying out. The chain deploys
through the **loop** — a fixed
material point on the rim (top of the ball at rotation 0). Aiming rotates the
ball so the loop faces the aim direction (proportional steering — also while
the chain is out, which winds it around the ball); the shot always leaves
through the loop. A stick-released frame encodes its aim point as the ball's
own position ("not aiming"). Controls (mouse + gamepad + touch, most-recent aim device
wins): mouse move aim / left-click deploy chain; left
stick aim, RB deploy chain, top face button (X on a Pro Controller)
restart; on touch, the bottom-left on-screen joystick aims (deflect past the
deadzone to steer the loop, like the left stick) and the bottom-right circular
DEPLOY button deploys (no touch restart - reload the page).
Deploy is hold-to-keep: releasing it drops the chain. The touch controls only
appear on a coarse primary pointer (`(pointer: coarse)`), so desktop and
mouse-primary touchscreen laptops get none.
The OS cursor is hidden on the ball controller; a black **aim reticle** stands in
for it, drawn by `renderBall` from `BallInputSource.aimPoint()` (the same aim the
FrameInput carries, null when nothing aims).
Every device writes one piece of state, `aimLocal` - the aim point as an offset
from the ball, in metres. A deflected left stick or on-screen joystick writes it
at exactly the chain's reach (`CHAIN_MAX_LENGTH`).
The mouse has two aim modes behind the `MOTION_AIM` setting in `ballInput.ts`
(default **off**, overridable per session with `?motionAim=1` / `?motionAim=0` so
the two can be compared by feel without a rebuild):
- **position** (default): the aim point is the cursor's **screen** position,
  un-projected through the *current* camera every time it is read
  (`currentAimLocal`), unbounded - the reticle is exactly where the pointer is, a
  drawn stand-in for the hidden OS cursor and nothing more.
  Re-deriving it per read rather than freezing it at mousemove time is what keeps
  it there: held as an offset from the ball, a camera pan, ease or zoom slid the
  reticle across the screen with no hand on the mouse - the cursor visibly
  drifting on its own. Motion aim is exempt (the offset *is* the state, and under
  pointer lock there may be no cursor on screen), as are stick and joystick aim,
  which are ball-relative directions by definition.
- **motion**: `aimLocal` accumulates each mousemove's delta (metres at the
  current zoom) and is held within the reach, and clicking the canvas takes
  **pointer lock** (Esc releases it, the next click takes it back) so the cursor
  stays in the window; while locked the delta comes from `movementX/Y`, falling
  back to cursor travel for synthetic events that carry none.
  Clamping a *position* mapping is what this avoids: past the boundary the drawn
  dot would stop while the real cursor kept travelling outward, so moving back
  inward would do nothing until the real cursor re-entered the reach circle, dead
  travel the player cannot see since the cursor is hidden. Integrating motion
  lets the reticle be bounded without that cost.
  The first move (and the first after another device owned aim) seeds `aimLocal`
  from the real cursor position.
`BALL_ZOOM` is a plain constant: the view is a fixed 16:9 frame scaled to fit the
window (see **The view**), so a landscape phone gets the same framing as a
desktop at a smaller size rather than a smaller slice of the level.
It used to be height-driven, capped at the desktop zoom, which is what let a
short viewport still frame the ball and its chain arc.
The page is an installable full-screen web app (`public/manifest.webmanifest`
with `display: fullscreen`, plus `apple-mobile-web-app-*` metas for iOS and
`viewport-fit=cover`): added to a phone's home screen it launches without
browser chrome. Restart routes
through the `jump`
FrameInput field so it stays in the recorded input stream (BallLevel calls
onReset). Ball inputs map onto the existing FrameInput fields
(aim→mouseWorldPosition, shoot→fire, restart→jump), so
recordings serialize and every headless tool works unchanged - `cli continue`
(`--hold deploy`, `--aim X,Y`) and playtest scripts drive the ball through those
same fields under its own action names.

## Headless tooling

```sh
bun run test                                  # THE suite: typecheck + every check below, one exit code
bun run replay selftest                       # determinism + replay round-trip check (grapple and ball)
bun run src/tools/cli.ts ledges               # generated ledge-grab matrix (speed × angle × negatives)
bun run src/tools/cli.ts corners              # corner-exposure geometry cases (compound-body seams)
bun run src/tools/cli.ts tangents             # tangent-vertex cases (which corner a wrap node is born on)
bun run src/tools/cli.ts decompose            # convex decomposition of authored concave outlines (partition, seams, determinism)
bun run src/tools/cli.ts contacts             # rigid-body contact cases (settle/stack/ramps/impact/momentum/loop-cap/loop-ride)
bun run src/tools/cli.ts spring               # spring-body cases (droop, load and release, per-axis periods, the locks)
bun run src/tools/cli.ts vines                # vine cases (the pass-through guards, drape, grab, winch, the load rope)
bun run src/tools/cli.ts camera               # camera-path geometry, the rule set, and the editor's path round trip
bun run src/tools/cli.ts render3d             # 3D camera correspondence, extrusion winding, depth order, surface resolution, `visual` round trips
bun run src/tools/cli.ts assets               # prop + texture budget, stale bytes, orphans, licences (see The asset store)
bun run src/tools/cli.ts play  playtests/grapple-swing.json
bun run src/tools/cli.ts record playtests/ball-wind-up.json --out session.json  # script → real bundle
bun run src/tools/cli.ts replay session.json  # replay a P-exported bundle, run invariants
bun run src/tools/cli.ts bundles              # replay playtests/regressions/ + playtests/bundles/
bun run src/tools/cli.ts scan session.json    # anomaly sweep: spikes, embedding, drift, flicker, stalls
bun run src/tools/cli.ts scan --all           # the same over the whole corpus, printing only what is notable
bun run src/tools/cli.ts query session.json --frame 314 [--json]  # the full sim state at a frame
bun run src/tools/cli.ts trace session.json --from 450 --to 460 --body 0  # per-phase Δv attribution
bun run src/tools/cli.ts settle session.json --from 500 --frames 600      # continue with zero input, must rest
bun run src/tools/cli.ts dump session.json --from 100 --to 200   # digest+input table
bun run src/tools/cli.ts continue session.json --from 500 --hold left --trace t.jsonl
bun run src/tools/cli.ts render session.json --frame 65 --out f65.svg   # SVG snapshot of one frame
bun run src/tools/cli.ts shot session.json --frame 65 --out f65.png     # the REAL renderer, headless
bun run src/tools/cli.ts shot session.json --frame 65 --3d --out f65.png # ...through the WebGL renderer
bun run src/tools/cli.ts shot session.json --frames 60..120 --every 10 --3d  # a filmstrip + motion profile
bun run src/tools/cli.ts shot --diff before.png after.png               # changed-pixel count + highlight
bun run src/tools/cli.ts chainpath session.json --from 60 --to 70       # chain wrap-node polyline per frame
bun run src/tools/cli.ts fork session.json --frame 979 --frames 24      # state trace + before/after SVG around a frame
bun run src/tools/cli.ts compare session.json --frame 979 --ref <rev>   # A/B this tree against a revision
```

`bun run test` is what "all green" means: typecheck, `selftest`, `contacts`,
`spring`, `vines`, `corners`, `tangents`, `decompose`, `camera`, `render3d`, `assets`, `ledges`, every `playtests/*.json`,
then the bundle corpus, in that order and under one exit code.
A case that is red on purpose carries `expectedFail` (see `sim/contactCases.ts`),
which the runner counts as a pass and, crucially, **fails on if it ever passes**:
a stale marker is a lie about coverage, so the fix that closes the gap has to
remove the marker in the same change.

Playtest scripts are frame-indexed held-button ranges + aim waypoints with
asserts (`reachState`, per-frame `state`/`maxSpeed`/`hasRope`/position bounds,
and `window` asserts over a frame range).
They drive **either controller**: the ball's actions are the same FrameInput
fields under its own names (`deploy`, `restart`, `aim`), and a script may carry
its own `data` (an arena authored inline, as a bundle does) and a `spawn`
override in metres.
`playtests/ball-*.json` is the mechanic suite that lives on top of that; see
**What a mechanic test is for** below.
Invariants checked every frame: NaN, runaway speed, rope-over-length (once
anchored), player-embedded-in-geometry.
Ball runs add: `rope-anchor-kick` (the solve added speed on the frame the chain
anchored — an anchor born over its length), `rope-solve-kick` (the solve added
more than 4 m/s in **any** single frame), `rope-credit-unearned` (the chain phase
took more along its own pull than the constraint was opening at) and `chain-clip`
(a span's interior deep inside static geometry).
`rope-solve-kick` exists because `runaway-speed` is a 1000 m/s ceiling and so
never saw a 96 m/s one-frame launch.
It is measured against what the frame's own **winding** entitles the solve to:
winding chain onto the ball shortens the free span by `|ω|` × the spool rate and
the winch pays for that by hauling the ball in, so at 41 rad/s on the ball's own
rim the chain legitimately reels in 9 cm in a frame - 5.5 m/s, and nothing to do
with a launch (`session-265f` f139).
A launch has no winding behind it, so subtracting the budget leaves that case
exactly as visible while taking the mechanic out of the measurement: past the
subtraction the whole corpus sits under 1 m/s, against a bar of 4. It is the general form of
`rope-anchor-kick`, which only ever watched the anchoring frame.

`rope-credit-unearned` is the **sharp** form of the same idea, and it exists
because `rope-solve-kick` is a bar on the SIZE of a one-frame gain and therefore
has to sit clear of every legitimate one: a chain going taut on a fast swing
brakes several m/s in a frame, so the bar is 4, and `session-360f` slipped under
it at 2.1.
A constraint may only remove the motion **opening** it, so this measures the gain
against that entitlement rather than against a number - a legitimate brake reads
zero however large it is, while the same frame reads 2.18 m/s of speed the chain
was never owed.
It is taken over the phase's realised velocity change rather than over the credit
term alone, so it covers the spin rollback, the unwind and the into-surface
refusal too, and is a statement about the frame rather than a restatement of the
clamp `Rope.clampCredit` applies to one of those terms.
Exactly one frame of the whole ball corpus reaches over the bound at all
(`session-1426f` f714, 0.21 m/s), so the tolerance is 0.6.

`rope-anchor-kick` subtracts **the same budget**, and for the same reason.
The shot leaves through the loop, so the ball is usually still turning when the
hook lands, and a ball spinning as its anchor is born is winding chain onto its
own rim exactly as it is on any other frame - hauling it towards the anchor is
what pays for that, and it is the mechanic rather than a lurch.
Charged to the bare bar it read as the bug at 1.1 m/s out of a 2.7 m/s
entitlement, on frames whose over-length was 100% the winding's (`session-234f`
f84, `session-576f` f61).

What the invariant *is* for still happens, and the cause is an ordering one.
An anchor is born at no less than the length the chain had reached
(`BallPlayer`'s attach callback - the length may GROW to what the hook reached
and never shrinks, so a tip that dangled slack and then touched down keeps its
slack instead of snapping to a straight line, session-161f; `cli contacts`
`attach-keeps-length` is the detector), which is what leaves the constraint
already satisfied on its first frame and the solver with nothing to correct - but that measurement is taken in
the hook's swept attach check at the **top** of the frame, before `integrate` and
the push-out move the ball, so the promise holds only for a ball that then does
not move.
One that does is charged on its very first frame for the distance it travelled
after the chain was already attached: a ball falling the last 2.5 cm onto the
ground had its 6 cm chain measured 2 cm short, and the solve flicked it back off
the floor at 0.9 m/s (`session-1195f` f590) - precisely the resting-ball lurch
the invariant is named for.
So `BallLevel` re-takes the birth length in the chain phase, where the frame
actually leaves the ball, less the **winding's** share of it: chain wound onto
the rim this frame is the winch's to haul in and the unwind's to refuse, and
handing it to the length instead would pay the ball for its own kinematic spin.
It only ever lengthens, so an anchor born slack - the ball travelling towards it -
keeps the length it reached at.
Ball runs also carry **`roll-unfunded`** (`RollMonitor`): a ball gripping a
surface may not travel along it faster than its own spin and the chain account
for.
A contact that is not held at its friction bound has been solved to **no slip** -
the contact point is stationary against the surface - so the ball's centre moves
along that surface at exactly `radius x omega` and nothing else, and the chain
phase's own PBD credit (`BallLevel.chainCreditVelocity`) is the one other thing
entitled to have moved it.
What is left is a body being driven along a surface by nothing at all, which is
the shape of every friction motor here and of `session-315f` (0.5 m/s, sustained,
out of a ball whose spin was 0.03 rad/s).
It fires on 0.15 m/s carried for 30 frames, because the quantity is a **drive**:
an unfunded push is re-earned every frame for as long as its cause lasts, where a
landing or a wrap appearing is over in a handful.
The exemption is `ContactConstraint.limited` and *not* `slipping`, and the
difference is load-bearing: `slipping` is asked of the bare Coulomb cone, while an
aiming ball's cone is faded in the braking direction (`contactBrakeScale`), so a
ball skidding to a halt under the aim sits at exactly its real bound with a
tangent impulse well inside `mu * Pn` and reports `slipping: false` - 11.595
against a faded bound of 11.60 and a cone of 15.32 (`session-477f` f170).
The load-bearing contact is also chosen *before* the bound question is asked
rather than from among the contacts that pass it, or a ball skidding on its rim is
measured at whatever grazing touch its mounting loop happens to have.
Ball runs also carry the **energy invariant** (`energy-gained`): over any span
with no forced input and no kinematic spin, total kinetic plus potential energy
may not rise beyond a tolerance.
The gate matters as much as the check.
Winding the chain in or out does real work and the aim steering is an unbounded
spin source, so the invariant arms only while the sim is unforced; holding
`deploy` is not a source, and gating on "any button held" disarmed it across
almost every recorded session, which is how it was first written and why it
detected nothing.
It is sized against measured numbers rather than round ones, and it is sized as a
**speed** so that it cannot go stale when a mass changes: a span may gain no more
than the ball's kinetic energy at 0.8 m/s (five times the corpus's measured noise
floor), plus 5% of the span's peak kinetic energy.
Solver noise is float error on the energies themselves, so it scales with them;
a tolerance pinned to a joule count does not, and the same bar was written as
1e-4 J while the ball weighed a third of a gram (see **Mass and materials**).
This is the class of bug that was found late four times as the rope refund and
once more as a friction motor, every time by hand.

### Full-world digests

`Digest` is the avatar's and always was, which is why a rigid-pile jitter
regression once shipped under a "bit-identical" claim (`session-298f`).
`WorldDigest` (`sim/trace.ts`) carries every body that can move - position,
rotation, linear velocity and **angular velocity**, which no avatar digest ever
had - plus the chain's node count, path length, `maxRopeLength` and
`blockedSlack`.
Bodies are named by **build order** (`CollisionObject2D.buildIndex`, stamped by
`World.add`) rather than by the process-global `id`, so two builds of the same
level agree; `cli replay` reports world divergence separately from avatar
divergence and names what carried it (`world: body#3 drifted @f412`).
A P bundle gains an optional `worldDigests` array at the same cadence as
`digests`, so old bundles replay exactly as before and new ones are compared on
the whole scene.
`cli selftest` demands bit-exactness on all of it, for a grapple script *and* for
a ball script recorded headlessly through `cli record`.

### What a mechanic test is for

`playtests/ball-*.json` asserts the mechanics themselves - winding, the winch,
rolling, swinging, hanging still, holding a ceiling, wedging - because no
aggregate can stand in for them: the A/B variant that won every drift and
runaway number in `session-475f` had simply stopped the chain winding at all.
Each scenario authors the arena that isolates it inline rather than borrowing the
authored level, so it cannot fail for reasons that are not the mechanic's, and
each asserts BOUNDS over a window rather than values at an instant.
They are the mandatory success criteria for any physics A/B.
`ball-roll-drive-rigid` is the sharpest of them: it is red at `25d8357` with
`travelX=0.0000` (the `session-314f` regression, a ball spinning at 20 rad/s
sitting still on a rigid floor) and green at HEAD at 6.8 m, while its static-floor
twin passes on both sides.

## Debugging physics issues

The debugging loop for gameplay/physics bugs (player stuck, frozen input, bad
launches, mover misbehavior):

1. **Capture.** Reproduce in the browser, press **P** — downloads a bundle
   (level id + full input trace + per-frame avatar and world digests). Recording
   restarts on level reset, so a bundle always replays from frame 0.
   A scenario that can be described as a script needs no browser at all:
   `cli record script.json --out session.json` writes the same format headlessly,
   which is how a fiddly repro (wound up against a ceiling, wedged under a crate)
   becomes reproducible rather than performed.
2. **Make it red.** Drop the bundle into `playtests/bundles/` (gitignored,
   local scratch; `playtests/regressions/` is the committed corpus) and run
   `cli bundles`. Every bundle is re-simulated with
   *current* physics and checked against per-frame invariants — the bug should
   show up as violations at the frames where it was felt. If it doesn't,
   the invariants have a blind spot: fix the detector first, then the bug.
   A fix is only "done" when the bundle that reported it goes green.
2b. **Sweep before choosing where to look.** `cli scan bundle.json` (or
   `cli scan --all` over the corpus) reports, per body, the top single-frame
   `|Δv|` and `|Δω|` spikes, the deepest embedding and when it peaked,
   settled-body drift (a body going nowhere by its own velocity that is
   nevertheless somewhere else), contact-set flicker while resting, and the
   chain's stall runs and lease high-water.
   Those five are the shape of every physics bug there has been, and picking a
   frame to inspect before running this is guessing.
3. **Locate.** `cli query bundle.json --frame N` prints the whole sim state at a
   frame - every body's pose, velocity, spin, embedding depth and stick anchor,
   the chain's nodes and its length broken into `maxRopeLength`, lease and stall,
   and the avatar's state - and `--json` makes it a JSONL stream (`--from A --to
   B --every K`) with stable keys in metres and rad/s.
   Every quantitative question used to be a code change; this is the answer to
   all of them, so reach for it before editing anything.
   `cli dump bundle.json --from A --to B --every N` prints a
   digest+held-input table (re-simulated, not the recorded digests). Look for
   `vx=0.0` runs under held input, state thrash (Grounded↔Airborne flicker),
   or position drifting against input.
3b. **Attribute it to a phase.** A one-frame velocity is never explained by its
   size, only by which part of the frame wrote it - and neither is a one-frame
   *movement*, which is the harder case, because a body can be moved by a phase
   that gives it no velocity at all. `cli trace bundle.json --from
   A --to B [--body ID] [--out t.jsonl]` prints per-phase `Δv`/`Δω` **and `Δp` in
   millimetres** per body:
   `aim`, `gravity`, `contacts` (with per-contact normal and tangent impulses and
   whether they were at the Coulomb limit), `grip`, `circle-contacts`,
   `contact-damp`, `depenetrate`, and the chain phase broken into `push-out`, `rope-solve`,
   `spin-rollback`, `unwind`, `chain-velocity`, `refuse-into-surface` and
   `stall-lease`.
   That breakdown is the part no other tool shows and the part every rope bug has
   needed: "the contact solve re-earns 1.2 m/s sideways every frame and the chain
   solve removes it" is a thing you read here rather than instrument for.
   The position column is the same statement for the creeps, which are the bugs
   with no velocity signature at all: "gravity drops it 2.7 mm, the recovery pushes
   it out along an inclined normal and 0.6 mm of that is sideways, every frame" is
   read straight off the `depenetrate` line. Without it, a body crossing the level
   at 1e-8 m/s is a scan flag with nowhere to go next.
4. **Inspect.** `cli continue bundle.json --from F --hold left --frames 120
   --trace t.jsonl` replays to frame F, then takes over with scripted held
   input (fed through the input deserializer so pressed/released edges are
   correct relative to the recording — do not hand-roll input streams; the
   `InputBuffer`s are edge-triggered and a missed `released` latches a key
   forever). The trace JSONL (`src/engine/physTrace.ts`) has one record per
   `moveAndCollide` contact — collider, `overlap` (depenetration) vs `sweep`,
   normal, mobility, contact-point surface velocity — plus per-frame snapshots
   (state, support body, velocity), state transitions, and ledge-detection
   events (`t:"ledge"` — every grab, and near-miss rejections with a reason:
   wrong-side, below-player, behind-wall, out-of-reach, seam). Grep it: opposite
   normals from the same body in one frame, surface classifications flipping,
   velocity resetting to the collider's `cvel` every frame.
4b. **See it.** For *geometric* bugs (rope/chain clipping through geometry,
   anchoring in mid-air, a hook on the wrong side of a wall) the digest table is
   blind — it only carries the avatar's pos/vel/rope-length, not the chain wrap
   path. `cli render bundle.json --frame N --out f.svg` writes an SVG of the
   whole scene at frame N (bodies, hook-proof surfaces = dashed steel border, hook-only
   (`passable`) bodies = a grate mesh, areas with
   their glyphs — skulls for a killzone, flow arrows for a force area, flow
   streaks for water — chain
   wrap path + wrap-node markers, avatar); convert with `magick f.svg f.png` and
   look.
   `cli chainpath bundle.json --from A --to B` prints the wrap-node polyline per
   frame in px (node count > 2 means the chain caught a corner). Reach for these
   the moment a bug is about position/shape rather than a stuck/velocity number.
4c. **See what the *player* sees.** Everything above draws its own picture of the
   sim state, which is exactly why none of it can see a bug in the drawing.
   `cli shot bundle.json --frame N --out f.png` draws the frame with the **real**
   renderer: it starts the dev server, loads `shot.html` (which replays the
   bundle to that frame at `alpha = 1`, so the grab is reproducible), drives
   headless chromium over the DevTools protocol and tears the server down again.
   `cli shot --diff before.png after.png` gives a changed-pixel count and a
   highlight image, which is how a claim about a renderer change is evidenced.
   `--3d` grabs the same frame through the WebGL renderer instead, which is the
   only headless view that can see the 3D scene at all: every other one draws its
   own picture of the sim state and is blind to the renderer by construction.
   `--frames A..B --every K` draws a filmstrip instead of a frame, in one page
   load, and prints the changed-pixel count between adjacent tiles - which is the
   only headless evidence there is for anything that MOVES (see **Debugging
   rendering**).
   Neither makes perceptual quality *assertable* - no number here says whether a
   settle looks convincing - they make perceptual claims cheap to evidence.
   Reach for it when the report is about what something *looks* like. The chain
   wound onto the ball drew as blank space for want of one `floor` (see
   `drawChainPolyline`), and every CLI tool called that run perfectly healthy,
   because it was.
   **The grab comes with the page's console**, printed as `[page] <level>: ...`,
   and an `error`-level line fails the command (`--allow-errors` to override) and
   puts a red banner on the PNG itself.
   That is not a nicety: a shader that fails to compile draws nothing at all, so
   without it the command reports a perfectly ordinary-looking screenshot of a
   renderer that never ran.
4d. **Leave it alone and watch.** `cli settle bundle.json --from N --frames M`
   continues from a frame with zero input and reports the kinetic-energy
   trajectory, the fastest body, and the net drift, failing unless the scene
   comes to rest and stays there.
   It catches the two opposite failures a replay cannot: energy appearing out of
   nothing, and a body that reports itself at rest while creeping across the
   level.
5. **Verify.** `bun run test` - typecheck, selftest, the case suites, every
   playtest (the ball mechanic suite included) and the whole bundle corpus, under
   one exit code. `selftest` must stay bit-identical, for the avatar *and* for
   the rest of the world (static-path behavior may never change; mobile behavior
   is gated behind `isMobile`/`isRotating` branches). To confirm a fix
   actually changed the felt behaviour — which plain replay *cannot* show once
   the fix diverges the recorded tail (see Bundle semantics) — use the **A/B
   fork**: `cli compare bundle.json --frame <forkFrame> --ref <oldRef>` replays
   the bundle to the fork frame under both the current tree and `oldRef`, then
   runs both past it and diffs the full world per frame. Because the sim is
   deterministic and a fix only bites at the issue frame, both sides reproduce
   the *same* pre-issue state, so the diff (and the two before/after SVGs) is
   exactly the fix's effect. Pick
   `oldRef` = the commit just before the fix, and `forkFrame` = a frame where old
   and new still agree, just before the issue; if they already diverge there the
   command says so in as many words rather than presenting the diff as the
   change's effect. It runs old *physics* with new *tooling* (it copies the
   current `src/tools` + `src/sim` into a worktree of `oldRef`), so the command
   need not exist in `oldRef`; this holds only while the tooling touches stable
   physics interfaces (`physicsProcess`, body/rope fields), and a worktree that
   cannot run is reported as an error rather than as an empty diff.
   It also refuses to compare a tree against itself: both sides' identity is
   always printed (commit plus a hash of any uncommitted diff) and identical
   trees are named as such. The shell script this replaces did exactly that twice
   in one day - an empty `git stash` and a wrong cwd - and both times reported
   "no difference", which reads as a verified fix.

Key invariant — the **`input-frozen` stuck detector** (`src/sim/trace.ts`):
held direction for 45 frames with a mobile body nearby must produce ≥0.25 m of
displacement along the input, or >0.1 m *against* it (yielding to a mover's
push is displacement, not a freeze — wedge rules). Counts every input-held frame regardless of
state (state thrash must not reset the window); exempt: active rope, ledge
hang/climb, wall-jump startup, and purely static blockers (pressing into a
static wall is legit). Runs inside every playtest, replay, and continue.

The corpus lives in two places. `playtests/regressions/` is **committed**
(gzipped, whole - a bundle replays from frame 0 by design, so trimming one makes
it a different bug) and holds every bundle a postmortem here cites, so a fresh
clone can run the same evidence this document argues from. `playtests/bundles/`
stays gitignored local scratch. Both are replayed by `cli bundles` and by
`bun run test`.

Bundle semantics: digest divergence in `cli replay`/`cli bundles` is
**informational, not failure** — a bundle recorded before a physics fix
legitimately diverges from the frame the fix first bites; invariants are the
pass/fail signal.
`replay` distinguishes the two kinds it can see: `bit-identical behaviour (…
float noise)` is a settled body jittering in the last ULP (ignore it), whereas
`drifted @fN (maxDrift=…px)` or `behaviour forked @fN (different state branch)`
is a real path difference — `maxDrift` in the `bundles` line tells a faithful
bundle (≈0px) from a stale one (hundreds of px) at a glance.
Consequence: after a real divergence the re-simulated tail no longer matches
what the user experienced — diagnose via the detector's frame numbers on the
*current* simulation, not the recorded tail, and to check a fix landed at the
felt frame use the **A/B fork** (step 5) rather than reading the diverged tail.

Past root causes worth suspecting again (all found via this loop): absolute
velocity zeroed instead of surface-relative (PROJECT/CEILING cases), locomotion
basis stolen by a mover's corner normal (static-floor preference), separating
depenetration contacts redirecting escape velocity, phantom "hit-from-inside"
sweep normals on thin rotating shapes (guards in `World.moveAndCollide`),
near-threshold face classification flapping on rotating bodies (grip grace in
`lib/surface.ts`), a body left **embedded** in geometry because a depenetration
pass did not cover that geometry's kind (`session-1474f`) or resolved a wedge one
face at a time (`session-284f`) — the rope then pays the whole accumulated path
debt in one frame the moment it emerges, which reads as a launch — and a
**touch reported as an overlap**, which arms the rope's self-intersection
resolvers permanently: a contact stored in its body's local frame sits on the
surface for ever, so "the span is inside the body" is true on every span touching
that anchor, and the resolvers' "already on this vertex, step one place round the
loop" rule then jumps the wrap to whatever corner is next — 1.54 m away on a 3 m
polygon (`session-284f` again), and a **rope contact indexed at the wrong shape**
of a compound body, which sends those same resolvers round a vertex loop the span
never touches, so the rope runs clean through the piece it is anchored to
(`session-234f` — see "A `RopeContact`'s `shapeIndex`" under Shapes).

Three more, all from `session-735f`, all of them things that were *invisible while
every body carried one shape and every rope was handed the whole world*:
**contact velocity measured at the body centre instead of the contact point** -
`resolveRigidCircle` built its approach velocity from `linearVelocity` alone,
which is exactly right for a centred circle (ω × r is purely tangential there and
contributes nothing) and wrong for every offset one, so a compound body's second
circle could not see the spin the first circle's impulse had just added and had no
way to cancel it; two circles resting flat on a floor torqued each other in turn
for ever, a 2 px rock at 6 Hz that never damped;
**a wrap node on a removed body** - every regeneration re-emits the existing wraps
before it looks for new ones, so nothing else ever takes such a node out, and a
chain the hook flew through kept one welded to the spot the hook was destroyed at
for 400 frames (`Rope.dropWrapsOnGoneBodies`);
and **a solve that corrects position for bodies it never credits velocity to**
(see "Chains" - the `moved` set).

The broadest of that family, from `session-306f`: **a query that reads
`primaryShape()` on another body**, which sees the first-mounted piece and treats
the rest of a compound body as empty space. It shows up as tunnelling, as an
anchor floating off the geometry, or - when it is an invariant doing it - as
nothing at all. See "Asking a body for its shape is almost always a bug" under
Shapes; whole-body geometry goes through `bodyOverlapCircle` / `bodySweepCircle`
/ `bodyContainsPoint` now, so the loop cannot be forgotten.

Its twin, from `session-358f`: **an exclusion written by body where it means
shape**. The wrap scan skipped `body === span.from.contact.obj ||
body === span.to.contact.obj`, which is right for the piece the span is tied to
and wrong for that piece's siblings - so the moment the chain wrapped one piece
of a compound wall, every other piece of that wall stopped existing for the
adjacent spans and the chain cut straight through the one in its way. Now
excluded by `contact.shape`; `shouldIgnorePathCollisions` and the coil-run test
in `generatePathObjects` were the same mistake and are shape-level too.
The general rule: **`obj` identity answers "does this move as one rigid piece
with that", `shape` identity answers "is this the same surface"** - and every
collision question is the second one. `lengthPerRadian` and the self-wrap tests
in `generatePathObjects` are genuinely the first, and stay by body.

Structurally, the rope's wrap scan now flattens the scene into a list of
`WrapCandidate` **surfaces** once per regeneration (`wrappableSurfaces`) and
filters that per span, so past that line there is no `PhysicsBody2D` in scope for
the comparison to be written against. A body reappears only where a body is what
is meant: building a `RopeContact`, which names a body *and* a piece of it, and
the seam test, which is about how a body's pieces are arranged.

That last one is also a reminder that a geometric bug can be **completely silent
to the invariants** — `session-234f` replays HEALTHY, with no NaN, no runaway, no
over-length and no embedding, because nothing about it is a velocity. Reach for
`cli render` and `cli chainpath` the moment a report is about where the rope *is*
rather than about how fast something is going.

Those last two share a shape, and it generalises into a rule worth applying before
reaching for the solver: **a one-frame velocity spike is almost never the solver
being wrong about this frame — it is the solver being right about a discontinuity
that should never have built up.** Look for the state that was allowed to drift
out of bounds over the preceding frames (an embedded body, a path the rope was
allowed to route through solid geometry, a contact test that has been answering
"inside" since the moment the rope attached) rather than for the impulse that
finally released it.

### Debugging discipline

Rules distilled from the sessions this loop was built in.
Each one exists because its absence cost a real debugging day.

- **No fix before a measured cause.**
  State the root cause with a number from a replay, probe, or trace before editing the solver.
  A theory that fits the code is not a diagnosis: the rope-refund bug survived four sessions because a plausible neighbour (missing rigid-rigid friction) was fixed instead of the measured energy source (`session-394f`/`458f`/`431f`/`726f`).
- **Your own evidence beats your own theory.**
  When a trace contradicts the current hypothesis, the trace wins, immediately.
  When the corpus passes without a guard, the guard is unnecessary; do not construct a scenario to justify keeping it.
- **Red then green.**
  A fix for a reported bundle needs a detector that goes red on that bundle before the fix and green after (step 2 above).
  Prove it by temporarily reverting the fix: the new detector must catch the original bug on its own.
- **A second report of the same symptom means audit the class.**
  Stop fixing instances: enumerate every site that could carry the same blindness (grep for the pattern) and fix or rule out each.
  The compound-body corner class took four separate user reports (`234f`, `410f`, `306f`, `358f`) because each instance was fixed alone.
- **Two failed attempts means revert and report.**
  After two attempts that each trade one measured problem for another, revert to green, write down the diagnosis and what was tried, and stop.
  A precise diagnosis with no fix is a better deliverable than a half-fix left in the tree (`session-326f`).
- **Prefer the textbook.**
  The rigid bodies here are a solved problem; when a patch fights the structure, ask "what does Box2D do" before inventing (see **The contact solver**).
- **Name what green cannot see.**
  Before claiming a fix verified, state which of the blind spots below apply and what covered them - a probe, a render, or an explicit "needs a manual playtest for X".
- **New physics state ships with detectors.**
  A change that adds simulated state (a new body kind, constraint, or solver path) must extend the digests and invariants to cover that state in the same change, before playtesting.
  Both polygon launch bugs (`1474f`, `284f`) escaped to manual play because the detectors lagged the feature.
- **Edit source with the Edit tool, never scripted string replacement.**
  A `str.replace` that matches nothing silently no-ops and reports success; a real edit with a stale anchor errors.
  The same rule for baselines: compare against a git rev (`cli compare --ref`), never a `git stash` round-trip - an empty stash silently compares a tree against itself, which is why the command now prints both sides' tree identity and refuses an identical pair outright.

### What the verification suite cannot see

The current blind spots, kept here so "all green" is read with them in mind.
Remove an entry when tooling closes it - `plans/tooling-improvements.md` is the plan doing that.

- **Digest divergence does not gate.**
  A behaviour change that stays under every invariant threshold passes silently; only invariants fail a run.
- **Invariants are velocity-shaped.**
  Purely geometric wrongness - a rope through a wall, an anchor floating off a surface - replays HEALTHY (`234f`, `306f`); `cli render`/`cli chainpath` plus eyes are the only detectors.
  `cli scan` covers part of the gap (embedding depth and settled-body drift are geometric), but nothing detects a rope taking a wrong path that is still the right length.
- **Nothing GATES a render.**
  `cli render3d` covers the arithmetic the 3D scene stands on - the camera correspondence, the extrusion's winding, the scene-object round trips (including the REAL ball level, on counts, which is what catches the editor silently dropping something) - and `cli shot` makes the grab, the pixel diff and the motion profile one command each, but nothing runs any of them for you.
  A renderer change is evidenced on request, not gated, and `bun run test` stays green through a scene that looks wrong.
  Every CLI view draws its own picture of the sim, so a bug in the drawing itself (`1467f`) is invisible to all of them.
  What is no longer blind: the page's console reaches the CLI and fails the grab (see **Debugging rendering**), motion is evidencable in one command, and a blank 3D frame reports itself.
- **The editor autosaves, so anything reading a level while it is open is racing a writer.**
  A named model writes itself back 750 ms after any edit, which means an open editor tab is a second author of `levels/*.json` - and a page holding a stale model will happily write that model over a newer file. It has already cost real authored content once. Close the editor before touching a level from a script, and treat a level file's mtime moving while you did not write it as exactly what it is.
- **Perceptual quality has no oracle.**
  Whether a rotation or settle looks convincing is judged only by a human or a render; corpus numbers stayed green through three re-reports of unconvincing rotation.
- **Recorded bundles cannot confirm fixes.**
  After a physics change the recorded tail legitimately diverges, so only `cli compare` or a scripted scenario shows a fix landed.
- **The A/B cannot reach far back.**
  `cli compare` runs current tooling against old physics, which works only while the tooling's imports exist in that revision: it breaks at anything older than `bodyOverlapCircle` and `World.collectContacts`, which is exactly where several of the historical defects live.
  Re-introducing such a defect locally is then the only way to prove a detector catches it.

## Debugging rendering

The physics loop above has a section of discipline because every rule in it was paid for by a debugging day.
The renderer now has one for the same reason: the 2026-08-04 water sessions violated all six of these, and each cost hours.

- **A headless screenshot without its captured console is not evidence.**
  A three.js shader that fails to compile draws nothing and reports the reason only in the page log, so a grab of it looks like an ordinary picture of a scene with something missing.
  Three separate "works in the headless screenshot, broken live" failures happened in one afternoon that way, and zero THREE warnings were seen across a whole day of renderer work.
  `cli shot` now captures `window.__shotLog` (installed by an inline script in `shot.html`, ahead of the module, so a module that throws while evaluating is caught too), prints every entry as `[page] <level>: ...`, **exits nonzero on any `error`** unless `--allow-errors` is passed, and paints a red banner onto the PNG so the artifact says why it is wrong.
  Shader errors are surfaced synchronously before `shotReady`: `Scene3D`'s diagnostic mode (opt-in, `shotMain` only) sets `checkShaderErrors` and an `onShaderError` reporter, and `compilePrograms()` walks every material's program and asks it for its uniforms - which is the call that actually runs three's link check, since neither `compile()` nor `compileAsync()` does.
  A change to a shader is claimed working only with a clean `[page]` log or a live-browser check.
- **Motion claims need multi-frame evidence.**
  Flashing, flicker, wrong advection speed and anything else that only exists BETWEEN frames are structurally invisible to a single grab, and the user was the only detector for two such bugs across 36 grabs and nine rejection rounds.
  `cli shot bundle --frames A..B --every K [--3d]` replays once, draws a labelled filmstrip and prints the changed-pixel count between adjacent tiles, plus min/median/max.
  A steady flow is a flat series and a flashing artifact is a spike pattern in it; the wall clock is pinned per tile (`pinClock(frame / 60)`) so wall-driven animation advances with the sim rather than with when the command was run.
  Nothing gates on the numbers - this is `--diff` for motion, making the claim cheap to evidence rather than assertable.
  Note the whole frame is measured, so a moving camera swamps a small effect: profile a scene at REST when the thing being measured is the animation itself.
- **No tuning on unmeasured geometry.**
  Sampling density against the highest harmonic, UV anchoring and triangulation shape are checkable numbers, and a morning went into tuning aesthetic constants over geometry whose defects were all three at once.
  Check them before touching a constant; constants tuned against broken geometry are rework, all of them.
- **Prefer the textbook, renderer edition.**
  Before hand-rolling a visual effect, survey what three.js ships and what the established technique is - the same rule the physics side states as "what does Box2D do".
  It cuts both ways: `Water2` was surveyed and correctly rejected, with the reasons written down under **Water**, which is worth as much as adopting it would have been.
- **Two rejected aesthetic rounds mean stop.**
  Re-derive the approach and ask for a reference image rather than burning the user as a per-round oracle.
  Nine rounds happened because no rule said stop.
- **Performance claims need real-GPU numbers.**
  Headless chromium runs SwiftShader: the ball arena draws at **4 fps / 250 ms a frame** there and at 60 fps on the 2D path in the same browser, so a frame time measured through `cli shot` is a number about SwiftShader.
  Draw-call and triangle counts ARE transferable and are worth quoting; label them as what they are.
  FPS comes from the live page (below).

### The live-verification workflow

`cli shot` is the channel for reproducible geometry and shading evidence.
The live browser is the channel for anything SwiftShader cannot represent: frame rate, tuned-constant sign-off, and the page's own console.

1. `cd rope && bun run dev`.
2. Drive Chrome with the claude-in-chrome extension (or a human): navigate to the level, `?hud=1` for the on-screen instruments, `?level=NAME` and `?render=2d|3d` as usual.
   **F3 toggles the panel while playing**, which is the form a human wants: the frames worth looking at are the ones being played, not the ones after a reload with a different URL.
3. Read `window.__perf` by JS evaluation - `{fps, frameMs, frameMsP50, frameMsP99, cpuPct, gpuMs, heapMb, drawCalls, triangles, programs, w5}`, rewritten once a second (`render/perfProbe.ts`).
   The 2D path reports the FPS half and zeros for the rest, since it has no draw calls to speak of.
4. Screenshot on a real GPU, and read the live console.

`?hud=1`/F3 draws exactly those numbers under the FPS counter, so what a human eyeballs and what a script reads cannot disagree.
The probe is render-side, allocated once, and touches no sim state, so it can never reach the fixed step.

**A tab the browser has backgrounded renders nothing.**
`requestAnimationFrame` stops when `document.visibilityState` is `hidden`, and a claude-in-chrome screenshot resumes it for the length of the capture - so the panel a script grabs off an unfocused window is a page starting from cold every time, showing 120 ms frames and near-empty graphs.
Check `document.visibilityState` before believing any live reading, and get the window focused (or ask the user to look) rather than reporting the capture's own stall as the game's frame time.

#### What the four rows actually measure

The browser exposes no process CPU and no GPU utilisation, so each row is the honest proxy rather than a task-manager figure, and saying which is which is the difference between an instrument and a decoration:

- **frame** - wall time between rendered frames. The 60 Hz and 30 Hz budgets are the dashed lines on its graph.
- **cpu** - the MAIN THREAD's busy fraction: the previous frame callback's own wall time over the interval it was spent in. 100% means the loop IS the frame; a low number beside a high frame time means the wait is elsewhere (GPU, compositor, vsync).
  Pairing a callback with the `dt` measured *before* it ran reports ratios of two different intervals - it once read 339% - so the loop deliberately reports last frame's cost against this frame's `dt`.
- **gpu** - the GPU's own clock around `renderer.render`, via `EXT_disjoint_timer_query_webgl2` (`render/gpuTimer.ts`). The CPU-side bracket around the same call measures command submission and cannot see a GPU-bound frame at all.
  Queries retire a few frames late and must be polled every frame whether or not a new one is opened; a pool that fills while nothing drains it freezes the reading at its last value for ever, which is what it did.
  Unavailable (and labelled so) on the 2D path and on any driver without the extension.
- **ram** - `performance.memory.usedJSHeapSize`, Chromium-only, polled at 4 Hz. **JS objects only**: textures, geometry and the drawing buffers are GPU memory and appear in no browser API.

Each row carries its five-second average and worst alongside a graph of the same window (`render/perfHistory.ts`, 50 buckets of 100 ms; `w5` in the snapshot is the same fold).
The graphs scale to the window's 90th percentile rather than its worst column, so one 250 ms stall does not flatten five seconds of 7 ms frames into a line along the floor - the spike runs off the top, and the exact figure is the `max` on the row above.
Memory is the exception on both counts: it is not zero-based and it is not clipped, because a heap's shape is its reading.

### What a grab is doing under the hood

`cli shot` drives chromium over CDP (`src/tools/shotRunner.ts`, Bun's own `fetch` and `WebSocket`, no dependency) rather than through `--screenshot`.
Three things follow, and each replaced a guess:

- **The grab is gated on `window.shotReady`**, which the page had always set and nothing had ever polled.
  A grab is taken the moment the page says it is done (a 2D frame in ~0.6 s, a dressed 3D one in ~1.3 s) instead of when a 20 s virtual-time budget expires.
  A page that never becomes ready fails the command inside the wall-clock timeout (`--timeout`, 30 s) with its partial log printed, rather than stalling.
- **`Emulation.setDeviceMetricsOverride` plus a clip** fix the viewport at the game's own 1920x1080 frame.
  That retired the "headless chromium keeps 87px of the window" hack, which never worked: every grab carried an 87px letterbox band along the bottom.
  The frame's pixels are unchanged - a clean-tree grab diffs to 0 against the old runner's top 1080 rows.
- **Virtual time is gone**, and the wall-clock timeout is the only ceiling.
  `Emulation.setVirtualTimePolicy` used to bracket the navigation so the page's clocks ran as fast as its work allowed. What it also does, on chromium 142, is stop OFF-MAIN-THREAD IMAGE DECODING from ever completing: `createImageBitmap` of a JPEG or a WebP returns a promise that never settles, while PNG - decoded on the main thread - is unaffected.
  That is every 3D grab in the project, because `assets:optimize` puts every prop's textures through `--texture-compress webp` and `GLTFLoader` takes the `ImageBitmapLoader` path whenever `createImageBitmap` exists: the mesh promise never resolves, `assetsSettled` never returns, and every scene at once fails with `still waiting for assets: mesh "..."` - which reads as the renderer being broken rather than as an emulation setting.
  The grab does not need it. What makes a picture reproducible is that the page pins its own clock (`Scene3D.pinClock`), waits for every asset before it draws, and is polled on `shotReady` rather than on elapsed time, so the frame is the same frame whether the wall took 1 s or 5; virtual time was only buying speed.
  For the same reason the page does not give up on its assets by its own clock; it names what it is still waiting for (`still waiting for assets: mesh "sewer-arch"`) and the harness's wall clock is what fails the run.

`shotMain` also reports a **blank 3D frame** as an error (`Scene3D.litFraction()`, read off the drawing buffer), since an empty frame is a valid PNG that every other view calls healthy.
The historical late-frame blank flake did not reproduce in 20 consecutive gated runs at `--frame 40`, nor under the old runner, so its cause is still unidentified; what exists now is the detector, which is the half that makes the next occurrence loud instead of silent.

## Level editor

The **`/editor`** page (its own HTML page `editor.html` → `src/editorMain.ts`, distinct
from the game at `/`) runs an in-browser level editor (`src/editor/`, its own canvas loop +
DOM overlay). Dev serves `/editor` via a rewrite in `vite.config.ts`; production maps it to
`dist/editor.html` in `serve.ts`; the build emits both pages (`rollupOptions.input`). It
edits an `EdModel` (positions in world **metres**, one
stable id per body) and manipulates it with the mouse: pan (**middle**-button drag, or the
right button, or a **left** drag on anything not selected), wheel-zoom about the cursor,
click-select, drag a *selected* body to move it, corner/rotate/
radius handles to resize, and `+Rect`/`+Circle`/`+Poly` tools to draw new bodies.
**Selected first, moved second.**
A press on something already selected drags it; a press on anything else pans and selects only if the pointer never really moved (`CLICK_SLOP_PX`).
The level is what you are looking at most of the time, so dragging it about has to be the cheapest gesture there is - and nudging geometry by accident, while reaching for the view, is the one editing mistake that leaves no trace on screen: it still looks like the level, and the level is different.
`+Poly` is the one draw tool that is a run of clicks rather than a drag, because an outline
is a vertex list and not a box: each click places a vertex, **Enter** or a click on
the first vertex closes the loop, **Esc** drops it, and the title carries the count so the
gesture always says where it is up to.
The outline is taken **as clicked**, concave corners included - a C-shaped wall is one
gesture rather than three overlapping boxes, and the loader cuts it into the convex pieces
the engine needs (see **Shapes**).
The convex hull is only the fallback for a draft that is not a shape at all: a loop that
crosses itself has no inside, and the draft draws in a warning colour from the click that
crosses it, so the fallback is visible before it is taken rather than as a shape that
silently is not the one drawn.
A selected polygon is then edited vertex by vertex - square handles move a corner, the
smaller round handles at the edge midpoints insert one and drag it in the same gesture, and
**Alt+click** on a corner removes it (a triangle is the floor). Every one of those goes
through `setPolyVerts`, which re-centres the loop on its centroid (so `pos` stays the centre
of mass, which the rigid-body lever arms assume) and **refuses a result that is not a
shape** - the vertex being dragged stalls at the last position the loop was simple rather
than folding the outline through itself. Denting a corner *inward* is not that and is the
point of the tool; a **camera region** is the one polygon still held convex, since nothing
cuts one up and both its containment test and its buffer zone read a notch as solid.

### Picking corners out of a shape

**Corners are selectable in their own right** (`selectedVerts` in `editor.ts`), which is a second level of selection nested inside the item one: a polygon is the item whose parts are separately editable, so once the shape itself is picked, a click, a rubber band, a Delete, a nudge and a drag can all just as well mean its corners.
Click a corner to pick it out, **Shift+click** to add or drop one, and a **rubber band from empty space** catches every corner inside it (Shift unions).
Picked corners draw as **filled** squares against the hollow ones, which is the same distinction the halo makes about a whole object: the selection orange means "an edit applies to this", and a hollow handle at every corner already means "you may drag me".
**Delete** removes them, the **arrow keys** nudge them, and dragging any one of them moves the whole set - the grabbed corner follows the pointer and the rest ride along at a fixed offset from it, exactly as a group of bodies is dragged.
**Esc**, or a click on empty space, drops the corner selection and leaves the shape selected; a second one drops the shape.

Three things about it are load-bearing.

The offsets a group drag rides at are a difference of two positions **in the shape's own frame**, because `setPolyVerts` re-centres the loop on its centroid every time it is written: the re-centring subtracts the same point from every vertex, so it leaves every difference alone where an absolute local position would drift by the centroid's own motion.

An **index means nothing once the loop it indexes is not the one on screen**, so the set is cleared by every change of selection, by undo/redo, by an Alt+click removal and by `Reverse` on a path - each of which renumbers or replaces the vertices - and read through `selectedVertIndices`, which drops anything past the current end.

And a Delete that would take the shape under its floor (three for a loop, two for an open run) removes **nothing** rather than as many as it can: "delete these four" answered by deleting two leaves a shape nobody asked for, and the corners that survived are not the ones the author would have kept.

The whole thing is the **camera path's** as well, through the same code: a path's nodes are picked, banded, nudged, dragged and deleted identically, minus the wrap, and a deletion filters its `handles` by the same indices so a node and its tangents can never come apart.
While a shape is open for vertex editing a band means its corners rather than the level's bodies, which is why clearing is two steps - it is the way back out.
`vertexEditTarget` is the one statement of when a shape is open at all (a lone poly or path, head on, with its handles actually drawn), so what a band catches, what Delete removes and what an arrow nudges cannot drift apart.

There is no `w`/`h` to type for a polygon, so the inspector shows the vertex count instead,
and beside it the **piece count** the outline builds as - 1 while it is convex, and however
many the cut produces once it is not, which is the number that says whether a fiddly corner
has quietly turned one wall into six. Both are live readouts, refreshed with the number
fields, since a drag can change them while the panel is deliberately not rebuilt.
The vertex count carries how many corners are **picked** where any are (`4 (2 selected)`) rather than taking a row of its own, because it is the same question asked twice and a row reading `0 selected` most of the time is a row that stops being read.
The cut itself is drawn on the canvas as dim dashed lines inside the selected outline
(`decomposeSeams`), because the pieces are what the physics is: the rope wraps the corners
they share with the outline and refuses their seams.
Selection is a **set**: a plain click selects one body, **Shift+click** toggles a body in or out, and dragging any member moves the whole group (the grabbed body leads the snap; the rest keep their offsets).
Dragging from empty space rubber-bands a **rectangle selection**, and the drag *direction* picks between the two CAD selection modes, as in Fusion 360 and AutoCAD: left→right is a **window** (only what the band fully encloses - every rotated corner inside, a circle by its extremes), right→left a **crossing** (anything it touches - a rotated box by SAT, a circle by its nearest point).
The mode has to be legible while the drag is still live, and the box alone cannot show a direction, so the band draws **solid** for a window and **dashed** for a crossing - the CAD convention, so it reads the same way it does there.
A drag with no horizontal travel counts as a window, so a degenerate one falls into the stricter mode.
**Shift** unions the hits into the current selection instead of replacing it, and a click that never moves clears it.
A band is dragged from EMPTY SPACE, which is what keeps it and the left-button pan apart: over nothing there is nothing to pan away from, and over a body there is nothing to band.
Resize handles only appear for a *single* selection, but the inspector is a **group panel** at
any size: every property the selection has in common is shown and every edit applies to all of
them (position and colour always; `rot°` when each body has a meaningful one, `w`/`h` or
`radius` when they are all the same shape, `force` when they are all force areas, `friction`
when none of them is an area or an anchor).
A property the bodies disagree on shows blank with a `mixed` placeholder and only writes once
something is typed into it; the kind picker gains a `mixed` entry for the same reason.
Selected bodies draw an orange halo *under* their own border,
so a hook-proof piece's dashed steel edge stays legible while selected.
**Ctrl+C / Ctrl+V** copy the selection and paste it at the cursor: the clipboard holds copies
detached from the model, and paste re-centres the group's bounding box on the pointer (with
snap on, its top-left corner lands on the grid), leaving the new bodies selected so it can be
repeated. `Ctrl+D` duplicates in place at a 2-cell offset.
**Arrow keys** nudge the whole selection one grid cell (10 cm), or 1 cm with **Ctrl** held; the
nudge is a pure translation (never snapped), so a body keeps any sub-cell offset it has and the
fine step still works with snap on. A run of nudges collapses into one undo step, ending when the
key is released.

Panels are split the way the format is, and **each is reached by selecting the thing it edits**.
An object panel carries what an object has - its form, its placement in its body, its material,
thickness, hook-proof flag and look - and nothing else; kind, friction, force and fill are the
body's, and they appear only when the **body** is selected (outliner row, or a canvas click on an
unselected body).
There is deliberately no body section above a selected object: that is exactly what made a
collision shape look like it had a `kind: static` and a friction of its own, when the file has
never had a place to put them.
The kind picker covers `static`, `rigid`, `killzone`, `force`, `water`; the **hook-proof**
checkbox is per shape, so one piece of a compound body can be the only place a hook will catch,
and it stays on the object panel for that reason (see **Hook-proof surfaces**).
The **hook-only** checkbox beside it is per BODY and offered on `static` and `rigid` alike: it is what the retired `anchor` kind became, and as a flag it also says the thing a kind could not - a leaf on a sprung stem that falls, sags when it is grabbed and stops nothing (see **Hook-only bodies**).
Body fields read and write the body's **collision lead** - the object its record is written from -
and `syncBodyProps` pushes the values to the rest. Going through all the members instead put a
`mixed` in the opacity field of a body whose decoration is deliberately a different opacity from
its walls: that decoration's own opacity is not the body's, and reading it as a second opinion on
the body's fill is reading the wrong field.
The one fill that is *not* the body's is a geometry object's, which `toLevelData`
writes onto the object - and only where it DIFFERS from the body's, so a wall's primitive
takes the colour the wall is painted and states nothing, while a backdrop welded into that
body carries its own.
Every body that can be stood on carries a **surface friction** (0 = ice, 1 = rubber; see below).
Everything that is a piece of stuff rather than a region of space - every kind but the three areas, hook-only bodies included - also carries a **material** and a **thickness**, the shape's depth through the z axis the 2D view cannot show, with a live **mass** readout under them (`area × thickness × density`).
The readout is what makes either number authorable: an author is choosing a weight, and a density and a depth only become one once the shape's own size is in it. See **Mass and materials**; both are per shape, so a selection spanning a compound body edits its pieces individually.
A
`force` area carries a signed **force** magnitude aimed by its own `rot°` - so the rotate
knob steers the current, and force-kind circles get that knob too (a plain circle's rotation
is invisible, so it has none). A `water` area is aimed the same way and carries the two
numbers a current is made of instead: a signed **flow** speed and the **drag** rate it takes
hold at (see **Water**). A toggleable snap (fixed 10 cm, the
backdrop's minor-grid spacing) keeps geometry aligned - **moves** snap the body's top-left
corner, and **corner-resize** anchors the opposite corner (grows toward the drag). Each body
**Undo/redo** (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) keeps 50 model snapshots - one step per
discrete action (each drag, add/delete/duplicate, kind/colour/opacity/numeric edit); New and
Load clear the stack. Each body has an editable **colour + opacity** (inspector); defaults to
dark grey `#555555` at 0.5,
borders always drawn fully opaque in the same colour (`DEFAULT_BODY_COLOR`/`_OPACITY` in
`levelFormat.ts`, carried on the engine body as `fillColor`/`fillOpacity`, rendered the same
way in editor and game via `src/render/color.ts`). Both the editor and the game render
on the shared `src/render/trainingGrid.ts` backdrop (Smash training-mode graph paper).
The editor gains the same stacked WebGL canvas the game page has, and a three-state **view toggle**: **2D** (exactly the editor as it was), **3D** (the scene alone, for judging how a level reads) and **3D + overlay** (the default - the scene beneath, collision outlines, handles and marquee on top with every fill dropped so the geometry stays visible through the thing describing it).
The editor's free camera drives the same correspondence the game's does (see **3D rendering**), so the overlay stays pixel-locked at any pan or zoom and collision authoring is exactly as precise as it was.

**Ctrl + middle-drag ORBITS** that view (`CameraOrbit` in `render3d/space.ts`, editor-only - the game's camera is always head-on), and `⟲ Reset view` in the toolbar faces the gameplay plane again.
It is the one question the authoring view cannot answer on its own: how deep a prop reads, whether a light pool falls where the ring on the plane says it does, what a wall looks like from the side it will be seen from.
The camera swings about the point it is centred on at exactly the dolly distance the zoom asks for, so a turn is a turn - it neither zooms nor slides what it is looking at, and the reset is a return to the picture the level was authored against rather than an approximation of it (`cli render3d` asserts all three, plus that a zero orbit is the head-on camera to the bit).

**A turned view draws no overlay**, and that is the whole cost of it.
The overlay is the gameplay plane projected straight onto the screen, so at any other angle its outlines, handles and bands would sit somewhere the geometry is not - which is worse than drawing nothing, because it looks exactly like an editor that is still aligned.
So the resize handles, the rubber band and the draw tools' previews all go with it: those press like empty space, which is a pan.

**What does not go is what a click MEANS.**
Those two were run together for as long as a pick was resolved on the plane by the 2D camera, and they are different questions: a ray answers for the models (`Scene3D.pick`) and meets the gameplay plane for everything resolved against it (`unprojectToPlane`, `canvasWorld` in `editor.ts`), both at any angle.
So bodies and objects are **selected in a turned view exactly as they are head on** - the drill-in cycle, Shift, Alt, the outliner - and dragging one carries it along the plane, and the **transform gizmo** the pick puts on it is in the scene and works from any angle.
That pairing is the point of the orbit: turn the view to see the depth, then drag the blue arrow to author it, on the thing you turned the view to look at.
`unprojectToPlane` is `projectToView` backwards, and `cli render3d` asserts it as a round trip through three's own projection at a spread of orbits, plus that it is the 2D answer head on and is NOT it turned - an implementation that quietly returned the 2D answer passes the round trip at zero orbit and puts every turned-view click somewhere else.
The one thing zoom gives up there is zooming about the cursor: the zoom is a dolly along the view direction rather than a scale about the screen, so the correction would want a ray through a camera that is not built until the frame is drawn, and a turned view zooms about its centre instead.

Ctrl is on the orbit rather than on the pan because panning is how you get around a level and is wanted in every view, while orbiting is the rarer act and the one you come back from; with no scene to turn (the 2D view) Ctrl+middle simply pans like any other middle drag.

### Geometry is picked by its model, not by an outline

**A geometry object has no outline on the overlay while a scene is drawn underneath, and is selected by clicking the thing that IS drawn** (`Scene3D.pick`, `raycastItems` in `editor.ts`).
The overlay's answer to "where is this object" was a rectangle on the gameplay plane, and that is not what a geometry object is: a primitive is a solid extruded through z, and a **mesh is a prop whose silhouette the authored outline never described at all**.
A lamp bracket 10 cm across placed in a 4 m box was therefore clickable by four metres of empty air around it, and a pipe running behind a wall was clickable through the wall - the box being both the only thing drawn for it and the only thing a click could land on.
Measured on a 4 m box wearing `bulkhead-lamp`: **722 of 729 sample points inside the box selected the prop before, and 1 after** - the one that is the lamp.

The pick is a **raycast through the camera the last frame was drawn with**, so it is about the picture the pointer was actually aimed at, and it holds at any depth and through either lens where an outline test on the plane cannot.
Everything else about picking is untouched: the ray only decides whether a geometry object is HIT, and `pickOrder`'s rules (the active layer, then depth, then a collision object winning a tie with the form drawn over it) still decide which of the things under the pointer wins, so **click the body, then click into it, then into what is behind it** cycles exactly as before.
The chain tool still asks the plane, because an anchor is placed on a body's collision outline.

The chain from a mesh under the pointer back to a row in the outliner is three links, and each is somewhere different: `BodyVisual` stamps every drawn object's group with the authored object it was built from (`pickTagOf`), `toLevelData` records which ITEM wrote each object it writes, and the editor rebuilds that map with the scene so it can never name an item the picture was not built from.
The middle link is the one that can break silently - `toLevelData` writing one object per item, in item order, is an invariant nothing else in the suite depends on - so `cli render3d`'s `pick:` cases assert it directly.
The 3D half cannot be checked headlessly at all: building a `BodyVisual` needs a DOM for the generated textures, so the raycast itself is verified by driving the real page (see `reference_editor_cdp_harness`).

Two things follow from taking the outline away, and both are the same statement said again.
**Selection is shown on the model** (`Scene3D.setHighlight`), in the overlay's own colours - the selection orange, and the blue that means "this is what the selected body is made of" - applied as an emissive over the surface the object already wears, so what is lit up is the shape being judged rather than a box around it.
And **a MESH offers no handles on the plane there** (`hasPlaneHandles`), because every one of them - the corner boxes, the rotate knob, the radius grip, the depth arrow - is a point on an outline that is not drawn and that never described the prop anyway, so left in they are the box that was just taken away redrawn as squares floating in empty space.
Its handle set in a 3D view is the **transform gizmo**, which is in the scene and therefore on the thing being edited, and which covers every field a mesh has.

A **primitive** is the opposite case and keeps its plane handles in every view, because the rule is "the overlay offers handles for exactly what is drawn" rather than "a geometry object has no outline": a primitive IS its own shape extruded, so the solid under the overlay is that outline and the corner boxes land on its corners.
Suppressing them cost the cheapest edit a primitive has - drag a corner to resize it - in the view the editor opens in, and offered the gizmo's scale boxes as the only substitute.
They are projected on the gameplay plane like every other handle, so a primitive pushed off the plane by its `off z` has them where its outline is rather than where the perspective draws its face; an orbited view drops the whole overlay in any case.

In the **2D view none of this applies**: there is no scene to ask, the outline is both what is drawn and what is picked, and every handle is back.
That is not a fallback but the same rule - the overlay picks and offers handles for exactly what it draws.
An **orbited** view picks by exactly these rules (above): the ray answers for geometry as it does head on, and the collision shapes, lights, regions and notes it shares the canvas with are resolved against the plane through `unprojectToPlane` rather than through the 2D camera, so the two halves of a pick agree about where the pointer is aimed at any angle.
What it does not offer there is the plane HANDLES, for the reason this section gives about geometry objects and the orbit section gives about everything else: a handle that is not drawn must not be grabbable either.

### The lens

`⧉ Ortho` (**O**) draws the scene through an **orthographic** camera instead of the perspective one (`ViewProjection` in `render3d/space.ts`).
It is an authoring instrument, not a look: a perspective camera divides by depth, so a prop 2 m behind the plane is drawn a little smaller and pulled toward the centre of the frame - which means two things that are exactly in line in the level do not look it, and two that look it are not.
Orthographic removes the divide, so a metre is the same number of pixels at every depth and what is on screen IS the plan, which is what makes aligning off-plane geometry by eye possible at all.
Both lenses are driven from the same visible height, so the gameplay plane is framed identically through either and the overlay, the handles and the picking are unchanged by the toggle (`cli render3d` asserts both halves: the plane matches the 2D renderer to a hundredth of a view pixel, and 20 m of depth moves a point by nothing).
The two cameras both live on `Scene3D` for the life of the scene rather than one being rebuilt on the toggle, since the gizmo raycasts against whichever is current and wants something stable to be handed.
A **▶ Test is always perspective**, whatever the toggle says: the point of a test is that the framing is the player's, and the player has no lens button.

### The transform gizmo

A single selected object or body carries the standard **red/green/blue handles** in the 3D scene - arrows to move, rings to turn, boxes to size - through three.js's own `TransformControls` (`editor/gizmo.ts`).

**All three sets are on screen at once**, and there is no mode to pick between them.
`TransformControls` is a modal control - one instance draws one mode - so this is three of them sharing one proxy, nested by size: the scale boxes inside, the move arrows through them, the rotation rings around the outside.
A mode toggle is a thing to remember and to get wrong, and reaching for a ring and turning up a move arrow because the toolbar was left on `move` is an edit that looks like the level and is not it - the same mistake **selected first, moved second** exists to prevent on the plane.
Nested, the answer to "what will this drag do" is whatever is drawn under the pointer.

The sizes are read off the geometry three actually builds rather than chosen by eye: an axis handle sits at `0.5 x size` with a picker cone reaching `0.6`, and a rotation ring is drawn at `0.5` with a picker tube `0.1` thick, so `HANDLE_SIZE` puts the scale boxes at 0.056, the move arrows at 0.113 with their pickers stopping at 0.135, and the rings at 0.175 with their pickers starting at 0.14.
The **ratios** between the three are what the nesting rests on, so they are the part that must not be edited one at a time; the overall footprint is a taste call, and it is a quarter of what it first was, which puts the gizmo inside the prop it is transforming rather than around it.
The move arrows are what that costs - their heads are a `0.04` cone, so at this size they are a couple of pixels of drawn arrow - but what is grabbed is the picker, the full-width cone from the origin out, so they stay pickable at sizes they stop being legible at.

Two handles are dropped because the three sets would otherwise bury each other.
The **centre belongs to uniform scale**, that being the one handle a mesh genuinely has (its `scale` is one number, so the centre drag is exact and every single axis is an approximation of it), so the move gizmo's own free-in-the-view-plane centre handle goes - its `XY` plane handle already covers the gameplay plane, which is what that one was wanted for.
Rotation's free-rotation ball goes for the plainer reason that it is a quarter-radius sphere sitting exactly where the move and scale handles are, and scale's plane handles because two axes at once is what the MOVE gizmo means.

What the nesting cannot separate is the **pickers**, because an axis picker is a cone that is widest AT THE ORIGIN: the scale box's cone lies wholly inside the move arrow's and both cover the centre.
So a press is arbitrated (`EditorGizmo.winner`) - innermost drawn first, since at the scale box's radius the box is what is on screen and the arrow is only passing through, with the centre handle beating any axis claim because it is otherwise unreachable.
Both arbitration listeners are on the **window**, and the phase is what makes each work: three's own handlers are on the canvas, so a capturing `pointerdown` runs before them (a losing set is held off with `enabled`, since three re-runs its own hover inside its press handler and would overwrite anything decided earlier) and a bubbling `pointermove` runs after them (two lit handles under one pointer is the gizmo saying it does not know what a press would do).

It is the answer to the question the overlay cannot even ask.
The 2D canvas is the gameplay plane seen head on, so it has handles for the two axes that lie in it and no way to say "10 cm toward the camera", "tipped 15° about x" or "a bit bigger" about a mesh whose outline is not what is drawn - and those are exactly the fields a level is dressed with (`EdVisual.offsetZ`, `rotX`, `rotY`, `scale`), every one of which was a number typed into the inspector and checked by looking.
It is also the only editing there is while the view is **orbited**, which is the view those fields are judged in: the gizmo is in the scene, so it is drawn from wherever the camera is.
The two features are a pair - orbit to see the depth, drag the blue arrow to author it.

**The handles sit at the depth the object is DRAWN at**, which is `itemDepth` and not the authored `offsetZ`: a geometry object authoring no depth is drawn on the gameplay plane if its body collides and at `DECOR_Z` if it does not.
Read as a plain 0, the whole gizmo stood 35 cm in front of every piece of decoration it was attached to - invisible head on, and the first thing you see when the view is turned, which is the view it exists for.
A move is then written as a CHANGE against where the handles started rather than as the pose's own z, or nudging a backdrop sideways would stamp that fallback into the file as an authored `off z` nobody asked for.

**The gizmo never touches the model.** It moves a proxy object and the editor reads that proxy and writes the model, which is what lets it survive the scene being rebuilt from scratch on every model revision - that is, on every drag. A handle attached to a visual is attached to an object that is disposed a frame later, and re-attaching per frame is a gesture that cannot survive its own effect.

**A handle is offered only where the format has somewhere to put its answer** (`GizmoHandlers.axes`), so what is on screen is the level's real degrees of freedom rather than three of everything:

| Target | move | rotate | scale |
|---|---|---|---|
| geometry: mesh | x, y, z | x, y, z | its one `scale` |
| geometry: primitive | x, y, z | z | w/h + depth |
| collision shape | x, y | z | w/h |
| light | x, y, z | z (its aim) | - (its reach is the 2D radius handle) |
| body | x, y | z, as a delta about the centre of mass | - (a body has no size; its objects do) |

A **primitive does not tip**, and that is this table's rule rather than an exception to it.
`EdVisual.rotX`/`rotY` are carried by the holder object `mountVisual` builds for a **prop**, and it returns before that on a primitive - which is its own outline extruded along z and has nowhere to put an out-of-plane angle.
So the x and y rings on a primitive were a dial connected to nothing: the gizmo tilted, `rot x°`/`rot y°` changed, and the level went on looking exactly as it did.
`visualData` stops writing the two fields for a primitive for the same reason `mesh` has always been written only for a mesh - a pose nothing draws is not a pose the file should record.

Two consequences worth knowing before reaching for it.
A **mesh has one `scale`**, so any axis of the handle drives it, by the mean of the three factors - the uniform centre handle is exact and a single axis is an approximation of "bigger", because the file has one number and cannot record more.
And **an axis pointing at the camera cannot be dragged**, which head on is z for a move and the ring for a turn: `TransformControls` hides a handle within a few degrees of the view direction, and maps a ring drag onto the screen direction perpendicular to both the axis and the view, which degenerates as the two line up.
Turning about z head on is therefore the 2D rotate knob's job (or the outer screen-space ring, which a mesh gets since all three of its axes are authorable), and moving through z head on is the **depth handle** below.
Orbited, both gizmo handles behave normally - which is the pairing: orbit to see the depth, drag the blue arrow to author it.

### The depth handle

A selected object that HAS a z - a geometry object or a light - carries one more 2D handle: a small blue up/down arrow beside its right edge, labelled with the value in the inspector's own units.
Dragging it up moves the object toward the camera, at the same scale x and y move at, snapped to the same grid.

It exists because z is the one axis the authoring view has no direction for, and the gizmo cannot cover it in that view for exactly the same reason (above).
So the two are complements rather than duplicates: **this is the head-on control, the gizmo's blue arrow is the orbited one**, and they are drawn in the same blue so they read as the same axis.
A collision shape gets none, because it has no z at all - it is the gameplay plane, which is what makes it collision (`hasDepth` / `depthOf` in `editor/render.ts` are the one statement of both).
A light's handle sits by its source icon rather than out at its reach, for the reason a click on a light lands on the icon: the reach is as wide as the room it lights.

Snapping is the editor's own: the same 10 cm grid and 15° step the 2D drags use, including on the sizes a scale drag writes (`scaleShape`'s `round`), so a gizmo drag and a handle drag cannot land a body in two different places.
The scene is rebuilt in full from the model whenever `modelRev` moves - the model is a couple of hundred shapes, and correctness beats a diff of what an edit touched - through the same `buildLevelBodies` the game loads with, so what is on screen while editing is what will be played rather than a second interpretation of the same file.
Chains stay on the 2D canvas there, and deliberately: the editor draws a chain **straight** because a span between wrap nodes is straight, and solving them to draw them would be a second simulation running under the editor.
A geometry object's panel authors what it is drawn as (**kind** - `primitive` or `mesh` - plus mesh, depth, bevel, texture) alongside the placement and size every object has, since a geometry object states its own form and those fields are what say it.
`mesh` gets a badge on the canvas in the **2D view**, being the one kind whose outline is not what the player sees; a primitive is drawn as exactly the shape on screen, so a badge on it would be a mark on almost every object saying nothing.
In a 3D view the prop itself is drawn, so the badge would be a mark pointing at the thing it is standing on, and it is not drawn (see **Geometry is picked by its model**).

`▶ Test Grapple` / `▶ Test Ball` build a real `Level`/`BallLevel` from
the current model and run it inline (with the real camera, so a camera region is felt exactly as it will play); **Esc** returns to editing.
A test uses the real game render path, so it gets the 3D scene for free - drawn into the letterboxed frame rather than the whole canvas, since the bars are not part of the picture the player is shown.
A test also plays in the game's own fixed 1920 × 1080 frame, fitted into the editor canvas and letterboxed (see **The view**): the point of ▶ Test is that the framing is what the player gets, and an editor-window-shaped view showed a different slice of the level from the one it will be played on.
**B** is the same ball test but spawned **at the cursor**, so a corner of the level can be spot-checked without walking the spawn marker over to it and back.
The override is baked into the `LevelData` the test level is built from rather than into the model, so it never edits the level, and a reset (and the exported P bundle) respawns at the same point.

### Layers

The model is a flat list of `EdItem`s - one per SCENE OBJECT - each carrying a **`layer`** and a **`bodyId`**, listed in draw order: `scene` (the level itself: every shape, every light, everything in a body), `camera` (the camera-behaviour volumes, see **Camera** below) and `notes` (authoring annotations, see below).

There were four, and geometry and lights were two of them. Merging those is the same correction the format made: a light is not a KIND OF LAYER, it is a scene object like a shape and it belongs to a body exactly as a shape does. Two layers made that impossible to express - a lamp's fitting and its light sat on different layers, so one could be hidden or locked without the other, and putting them in one body was a cross-layer selection. What distinguishes them is `EdItem.object`, which is what the FORMAT distinguishes them by: `collision`, `geometry` or `light`, one item per authored object.
There is deliberately **no decoration layer** either: decoration is a geometry object in a body with no collision object, and the inspector's `collision` tick converts a shape between the two kinds.

`EdItem.bodyId` is always set - an item is a scene object, and every scene object is in exactly one body, so an item on its own is a body of ONE rather than a body of none. That replaced "grouping", and the difference is not only vocabulary: a group was an optional tag on items that were otherwise free-standing, so every path had to answer "is this grouped?" before it could answer anything else, and "no group" and "a group of one" were two states meaning the same thing. **Ctrl+G** now moves the selected objects into one body and **Ctrl+Shift+G** takes bodies apart again.

Two of a light's fields deliberately live on the item rather than in its own property object, because the item already has them and a second copy could disagree with what is drawn: its **reach** is the item's `shape`, a circle of exactly that radius, so the radius handle authors it; and its **colour** is the item's `color`, which is the one authored-rather-than-fixed furniture colour. The reach is a READOUT and not a target, though - a click on a light has to land on its source burst (`lightPickRadius`), because the pool is as wide as the room the lamp lights and picking by it made a lamp a transparent sheet over everything it lit.
Every layer that is **visible and unlocked** is hit-testable, so a selection may span layers; the other two states are excluded from picking entirely, and both drop their items from the current selection when they are entered, rather than leaving things selected that a nudge, an inspector field or a Delete would still reach.
The **active** layer is what new items are drawn onto, and it breaks a tie in the pick (`pickOrder`): a camera region blankets the geometry it governs, so a click that could mean either takes the active layer's item, and the layer switch is what says which.
Within a layer the pick is by **depth**: two shapes whose outlines overlap are not ambiguous on screen - one of them is in front - so the click takes the one nearest the viewport (`itemDepth`, which is the editor's side of `depthOf` and therefore the same rule both renderers draw by), and authored order breaks only a genuine tie at one depth.
Both canvases draw decoration back-to-front by that same number, so what is on top on screen, what is on top in the 3D scene and what a click selects cannot disagree - without it a backdrop 20 m behind the level swallows clicks meant for the wall drawn over it, purely because it was authored later.
Every visible layer nevertheless draws at **full opacity**, active or not: dimming made a layer harder to read against the geometry it annotates, the layer list already says which one a click will hit, and visibility is the control for getting a layer out of the way.
The toolbar's layer list picks it (**Tab** cycles) and carries a **visibility** and a **lock** toggle each; hiding the active layer moves the edit focus off it rather than leaving an invisible edit target, and the last visible layer refuses to go (hiding everything would leave a blank canvas nothing can be clicked on).
The two toggles are deliberately independent: hiding gets a layer *out of the way*, locking keeps it **on screen but out of harm's way** — the reference you are working against.
So a locked layer draws exactly as before and only loses the edit paths: picking, being drawn into (`refreshToolButtons` offers Select alone while the active layer is locked, and `setTool` refuses a draw tool there so the keyboard shortcuts cannot arm one either), and membership of the selection.
With nothing pickable on it, the empty inspector says the layer is locked rather than repeating the usual "click a body", which would read as the editor being broken.
A paste unlocks the layers it lands on for the same reason it un-hides them.
The list stacks **vertically**, with the toggles in two icon columns down the left - eye then padlock - because a layer stack is a fixed, ordered set you read down rather than a row of toolbar buttons.
Both are inline SVG (`eyeIcon`, `lockIcon`) rather than emoji or font glyphs, so they inherit the toolbar colour through `currentColor`, stay crisp at any DPI, and look the same on every platform.
The eye is open when the layer draws and a dimmed closed lid when it does not; the padlock's *resting* state is unlocked, so it is the dim one (a row of lit padlocks would read as "everything is locked") and locked is amber, the layer list having already spent the accent blue on "active".
A cross-layer selection gets **one panel per layer** rather than a reconciled mixed one, since the layers' properties have nothing in common (a note has no kind, a camera region no fill); the panels come in layer order, under a summary that carries the single Duplicate/Delete row, which is why the per-layer panels drop theirs (`selectionSpansLayers`) — a row inside the "2 regions" panel that also deleted the selected notes would be lying about its scope.
The inspector scrolls, because that stack can outgrow the viewport.
A paste keeps each item on the layer it was copied from and reveals (and unlocks) any layer it lands on, rather than dropping items where they can be neither seen nor clicked.
The draw tools are per-layer too (`LAYER_TOOLS`): `scene` offers `+Rect`/`+Circle`/`+Poly`/`+Light`/`+Chain`, `camera` the three shape tools, `notes` `+Text`/`+Arrow`, and switching to a layer that cannot draw the armed tool falls back to Select rather than leaving a dead button lit.
`+Light` sits beside the shape tools rather than on a layer of its own, because that is what a light is: another kind of scene object, dropped into the same layer and put into a body with the shape it belongs to. It gets one tool and not the three shape ones because a light is a point with a reach, and a `+Rect` there would have to mean "a light shaped like this", which a light is not.
It is placed with a click at a reach worth having and a drag overrides that - the rule a note is placed under, and for the same reason: dropping a lamp that reaches nowhere until a field is typed into is a lamp that looks broken.
A fresh item's appearance comes from `newItemStyle`, keyed by what is being DRAWN rather than by the layer alone (the scene layer draws two different things): a shape starts at the body defaults, a light at a warm flame it then authors away from, and camera regions and notes at their fixed editor-furniture colours.

The camera panel carries `off x`/`off y`, `view ×`, `lock x`/`lock y`, `blend s`, `buffer` and `priority`, plus `buf left`/`buf right`/`buf top`/`buf bottom` on a rect region.
A lock is a checkbox plus a value: ticking it seeds the lock from the region's own centre (the sane start for "frame this room"), unticking shows `follow`; a blank `blend s` or `buffer` means the controller default, and a blank per-side buffer means the `buffer` above it.
A region draws as a dashed violet volume labelled with what it does (`cam · off 0,-250 · view ×1.8 · lock xy · buf 200`), and a locked axis draws a gold guide — a line across the region for one axis, a crosshair at the pinned point for both.
An authored `buffer` draws too, as a finely dotted outline of the volume grown by it: a buffer is the region's real reach over the camera, and it is set by eye against the arc a swing actually takes, so it has to be visible while it is being authored.
`pathOutlineGrown` (`render/shapePath.ts`) owns that geometry so it can never disagree with `pointInRegion`, and the two shapes grow differently on purpose - a rect grows per axis with **square corners**, since that is literally what its containment test does, while a polygon grows as a true offset with **filleted corners**, since its containment test is a signed distance and a mitred corner would claim reach the region does not have.

One item type rather than a union per layer is deliberate: a camera region is drawn, picked, dragged, resized, rotated, rubber-banded, duplicated and undone exactly like a body, and one type means those paths cannot drift apart per layer.
The cost is that an item carries the fields of every layer; `toLevelData` splits the list by layer and writes only the fields that layer gives meaning to, so nothing inapplicable reaches disk.

### The body outliner

The panel bottom-left lists every **body** in the level and expands each into the scene objects it is made of.

It exists because a body is the unit the format is written in and the canvas cannot show one. On the canvas a body is a diamond and a dashed hull around shapes that look like separate things, and the objects with no outline at all - a light, the mesh a wall is dressed in - are either a faint ring or nothing whatever. So "which body is this in, and what else is in it" was a question you answered by clicking things and watching what else lit up.

**Every body expands, including one holding a single object.** A body and a scene object are different things - one is a container with a transform, a kind and a fill, the other is a shape or a light inside it - and a row that collapsed the two whenever a body happened to hold one object would teach exactly the confusion the format was reshaped to remove.

Selection follows the same distinction, and it is why a body has its **own selection** (`selectedBodyIds`), exclusive with the item and chain selections. Clicking a body row selects THE BODY, and the inspector then shows the body's own properties - transform, kind, fill, friction, force - and no shape, material or look, because a body has none of those. Clicking an object row selects that object alone, which is the only way to reach one with no outline.

It is a **set**, because merging is an operation on two bodies and the tree is where two bodies are picked: Shift or Ctrl on a body row (or on a canvas body, while bodies are what is selected) adds and removes, and the panel then drops the transform - there is no one frame to edit for a set - and offers **Merge**, which puts every object in them into a single body and leaves *that* body selected, so the panel is still showing a body rather than suddenly a heap of objects.
`mergeableBodies` is the one rule both the button and Ctrl+G read: a body merges only if **every** object in it may share one, since an area is single-shape wherever it is used and a merged one would silently act through its first piece alone.
Split is the inverse and hands the selection back to the objects, since the bodies it took apart no longer exist; `afterHistoryChange` drops retired body ids for the same reason, which is what undoing a merge would otherwise leave the panel pointing at.
`operandItems` is what Delete, Duplicate, Copy and a nudge act on - a selected body means **all of it** - and they read it rather than `selectedIds`, which is what left the body panel's own Delete button doing nothing at all.

On the canvas it is **click the body, then click into it**: a click on a body that is not the one being edited selects the body (and a drag on it, once selected, moves all of it), and clicking again once that body is current selects the object under the pointer. Alt still reaches an object directly. A canvas pick also **unfolds that body in the tree and scrolls to it**, so the two views cannot disagree about what is selected.

**And clicking again walks on down whatever else is under the pointer** (`pickAt`).
Every rule the pick has - depth, containment, the active layer - can only ever name ONE winner, so an object nested inside or behind other outlines was unreachable with the mouse by construction: every point of it is also a point of the things drawn over it, and there is no pointer position that means it rather than them.
A click that lands where the last one did therefore takes the NEXT answer instead of repeating the same one, cycling body, its object, the next body, its object, and back round.
The candidates are `topmostAt`'s own rule applied down the stack rather than a second ordering beside it (`pickCandidatesAt` takes its answer, removes it, and asks again), so the first candidate IS the pick and the cycle cannot disagree with it about what is on top.
A fresh click starts exactly where it always did, so the first two clicks anywhere are unchanged and this is only what happens past the point the pick used to stop.
What counts as a repeat is the same point (within `CLICK_SLOP_PX`), the same stack of candidates, AND the selection still being what the last step left: anything else - the outliner, a rubber band, an undo, a shift or alt click - has moved on, and continuing the cycle from there would jump to something nobody pointed at.
A multi-selection is the one press that still has no pick at all, since a click that meant to drag it and did not travel must not silently collapse it to one object.

A selected body **outlines its objects in blue**, each on its own rather than as the body's union outline.
That is the question it answers - how many objects there are and where each one is, which the union deliberately hides - and it is the only thing on the canvas that says what a body is made of while none of its objects is selected.
It is blue and not the selection orange for the same reason: orange everywhere else means "an edit applies to this", and these objects are outlined precisely because they are NOT selected.
The objects with no outline of their own get a ring at the mark a click has to land on, since a light's own circle is its reach and an anchor has no shape at all.

An object's `x`/`y`/`rot°` in the inspector are **relative to its body**, because that is what the file records - a panel showing world coordinates would be showing a number the level does not contain.
Relative means in the body's own **frame**, rotation included (`localPlacement`, the inspector's side of `toLevelData`'s `localOf`): the world-axis distance to the body's origin is a different number the moment the body is turned, and a body turned 15° showed an object the file records at (20, 20) as (14.1, 24.5).

**The body's frame is the body's own** (`EdModel.bodyFrames`), and not a member's.
It was read off the body's FIRST object for as long as the editor had nowhere else to put it, and that made that object secretly the body: moving it moved the frame, and since every sibling is recorded as an offset from the frame, every sibling's offset changed by the same amount to compensate.
Nudging one collision shape 10 cm therefore wrote a body moving 10 cm and every other object in it moving 10 cm back - the same geometry on screen, recorded as an edit nobody made, in a panel that then read as the body having moved rather than the shape.
Stored, an edit to one object changes that object's offset and nothing else.

The frame moves when the BODY moves, and `translateItems` / `rotateItemsAbout` are the one statement of what that means: they carry a body's frame exactly when every one of its objects is in the set being moved.
So it is one rule rather than a decision at each of the dozen gestures that move something - a drag, a nudge, an inspector field, a gizmo handle, a group rotate - and a gesture cannot move a body's frame by accident.
A frame is **absent** until a body holds more than one object, where it means "wherever the first object is": that is exact for a body of one, since any move of that object is a move of the whole body, so a level of simple bodies stores nothing and saves byte-for-byte as it did (a load records none either, which is what keeps the re-origining a save has always done unchanged).
What makes the rest safe is that every body holding more than one object has its frame written down before anything is edited, once per undo step in `beginAction` - membership grows by merging, by drawing into a selected body, by dressing a shape and by pasting, and settling it in one place is what stops the next of those forgetting a rule it is not written into.

**A new object drawn while a body is selected joins that body.** With a body selected the thing being authored is a part of it - the collision box under a mesh, a second shape for a compound wall, the light a lamp throws - and making it a body of its own would mean drawing it, selecting both and merging, every time. It takes the body's kind, fill and friction on the way in (`syncBodyProps`), since a body has one of each. An area is refused for the reason `canShareBody` gives; camera regions and notes are never in a body in any meaningful sense and keep getting one of their own.

### Decoration

**Decoration is a body with no collision object in it** - a geometry object and nothing else (the `collision` checkbox in the inspector converts a shape between the two kinds).
Unticked, a shape is decoration: drawn with its authored colour and opacity, and with **no interaction of any kind** - nothing collides with it, the rope never wraps it, no force reaches through it, and the sim never sees it.

It used to be its own thing entirely - a `backgrounds` list beside the bodies, on the argument that a pass-through `BodyKind` would have to be excluded by every physics path one call site at a time - and then a `collision: false` flag on a body-shaped entry that had to carry, and then ignore, every physics field.
The argument was right about the danger and wrong about the remedy.
A shape that is never **built** is excluded from everything by construction: `buildLevelBodies` drops non-colliding entries before they become `Piece`s, so there is no collision shape, no `World` membership, no mass and no vertex the rope can wrap - the exclusion IS the absence, and there is no call site left to remember.
What that buys is that decoration stops being a second kind of thing with a second set of tools: it is drawn, picked, dragged, rotated, rubber-banded, put in a body, copied, undone and textured by exactly the code every wall goes through, and a wall becomes a backdrop (or back) by unticking a box rather than by being re-drawn on another layer.
Levels on disk still carry the retired list; `normalizeLevelData` folds it into non-colliding bodies at the one gate every level passes through, writing out the panel list's own default fill explicitly so decoration cannot quietly turn grey on load, and **appending** rather than prepending because a retired `ChainData` still named bodies by index at the point that migration ran.

Two rules make it read as decoration, and they are load-bearing rather than cosmetic (`render/decor.ts` is the single implementation of both, shared by the editor and both game renderers, so what is authored is what plays):

- It is **drawn before every body**, whatever its position in the authored list, so nothing the player can touch is ever hidden behind it.
- It is **never stroked**. A border is what makes a shape read as an object; a backdrop has none, and every body draws over it with one. This is how decoration stays distinguishable from a wall without a glyph - see **Decoration** in `docs/game-design.md`, which is the amendment to the pass-through rule that lets it off carrying one.

The editor adds a dashed **teal outline** on top, editor chrome like a handle rather than part of the drawing: an author has to be able to find and click a shape that is dark, huge or nearly transparent, and above all has to be able to tell at a glance which shapes on the canvas are part of the level. It is a saturated colour on purpose - a neutral grey edge vanishes into either the pale grid backdrop or the shape's own fill, whichever it was picked to contrast with.

That edge, and the whole of this pass, belongs to the **2D view**: with a scene drawn underneath there is a model on screen saying where the object is, and a dashed rectangle beside it is the editor stating something the level does not contain (see **Geometry is picked by its model, not by an outline**).
In the 2D view the edge is drawn for **every** geometry object and the fill for only some, by the same rule the game's 2D view follows: a primitive on a colliding body, on that body's own plane, is already filled by the collision shape it was made from, so filling it again would darken every wall in the editor by its own opacity and show the author a level that is not what plays.
One that has been resized or moved off its collision shape then reads as exactly that - a dashed outline standing away from the solid, with the fill still where the body is.
For the same reason a click at that tie takes the **collision** object: the two are one shape on screen, a click means the thing that decides where the player can go, and the form drawn over it is one row away in the tree the pick has already unfolded.

In 3D it keeps the full `visual` field, which is how it earns its place: an `offsetZ` of -20 m is a parallax layer, and a `kind: "mesh"` with the collision unticked is **a prop with no collision at all** - scenery, a lantern, a sign - which is the one thing the old layer could not express, since a background panel was always a flat fill.
Its depth defaults are its own (`DECOR_Z`, `DECOR_DEPTH`): just behind the plane and thin, which is exactly what a flat fill drawn before every body already was, so every migrated panel looks as it did. `thickness` is deliberately not consulted - that is the number a shape's MASS comes from, and decoration has none - and decoration behind the plane casts no shadow across the level in front of it, which was the old panel rule and is kept for the same reason.

Decoration may be put into a body with other objects using **Ctrl+G**, exactly as two collision shapes are - it is the same act, since being in a body is all "grouped" ever meant - and the build resolves its placement into that body's engine frame (`collectDecor`, `BuiltBody.origin`).
It is then drawn in the body's *interpolated* transform, so decoration on a rigid assembly swings, falls and turns with it instead of staying welded to the spot it was authored at, and decoration tracking the 60 Hz pose while its body draws interpolated cannot visibly detach from it between steps.
It stays decoration throughout: it adds no shape, no mass and no seam, so `groupCentroid` weighs the group's *colliding* shapes alone and welding a backdrop on cannot move the point the body turns about, and `groupLead` takes the group's kind, fill and friction from the first colliding member.
`syncBodyProps` leaves a geometry object alone for the same reason material and thickness stay on the collision object - a backdrop is authored to sit *behind* the geometry, so painting it the body's colour is exactly wrong.
A group with no colliding member at all is not an error: it builds no body and its members stay where they were authored, which is what several panels moved as one has always been.
Group membership beats layer visibility and lock in the editor's picking: a group is one object, and picking up half of it would silently re-place the other half against it.

`cli contacts` `decor-group` is the detector, and it exists because nothing else here can see any of this: decoration is never simulated, so a build that stopped attaching it violates no invariant, diverges no digest and passes every bundle while leaving the paint behind as the body swings away from it.
It asserts the five halves together - the shape sharing the body holds its place in the body's frame through a 3.3 m fall and a 20° turn *and* actually travelled; the body still carries only the shapes its collision objects authored and the world holds only those bodies (decoration is not a piece and never reaches the sim); a piece in a body of its own and one in a body with no collision object at all are both drawn exactly where they were authored, which is what stops "everything rides something" passing the case; and the retired `backgrounds` list migrates to exactly the same placement, body and fill, which is the half no level in the corpus can fail loudly, since every level on disk still carried panels in the old form.

The inspector drops the whole physics half for a body of pure decoration - no kind, no friction, no force, no fill, and on its objects no material, no thickness, no hook-proof - because none of them mean anything on it, and a panel headed "Body #12" with its fields missing reads as a body that has lost them.
On disk the same rule holds: `toLevelData` writes no `friction`, `material`, `thickness`, `impermeable` or `force` for decoration, so a migrated panel is byte-stable through a save.
**Images** (a source, plus `scale` / `crop` / `tile`) remain designed for but not implemented; a decorative shape wearing an authored PBR texture set (see **Surfaces**) is most of what they were for.

### Notes

The **notes** layer is authoring commentary: a text box or an arrow, recording *why* a piece of geometry is where it is so that it is not later removed as arbitrary.
It is the one part of a level file that is deliberately **invisible in play** — notes serialize to `LevelData.notes` (`NoteData` in `levelFormat.ts`), and no runtime path reads that list, so `Level`/`BallLevel` and the game renderer never see it and `▶ Test` shows a scene with nothing added.
That is also why it is not a `BodyKind`: a note has no collision, nothing wraps it, and it never reaches the sim.

A note is always a **rectangle** (a circular note has no meaning), so `NoteData` carries `w`/`h` directly rather than a `ShapeData`.
A text note's box holds its **word-wrapped** text (explicit newlines honoured; a word wider than the box gets its own line rather than being broken mid-identifier, since most of what a note names is an identifier).
An **arrow** is a segment, but it is stored as that same box — length × a fixed pick band — so it moves, rotates, rubber-bands, duplicates and undoes through exactly the same code as every other item; the shaft runs along the item's local +X from `(-w/2, 0)` to `(+w/2, 0)` with the head at the +X end, so `rot` aims it.
The one thing it does differently is **editing**: an arrow shows round **endpoint handles** instead of corner boxes and a rotate knob, because dragging one end sets position, length and direction in a single gesture where the box handles would take three (`arrowEnds`/`setArrowEnds` in `model.ts` are the shared conversion, used by both the endpoint drag and the initial draw, so an arrow drawn from scratch and one re-aimed later are identical).

Notes are drawn **above** everything they annotate — commentary hidden behind the geometry it explains would be useless — in green, with a dashed box like every other volume the player passes through so a note can never read as a wall in a screenshot.
Everything about a note is **world-scaled** — glyph height, box, arrow shaft and head — so an annotation keeps its relationship to the geometry it points at instead of swelling over the level as you zoom out; the glyphs themselves are drawn in screen space at the projected size, which keeps them crisp without changing that.
An empty note draws a dimmed `(empty note)` placeholder rather than nothing at all.
Placing a text note focuses the inspector's textarea, so the first act after dropping one is typing rather than a trip to the panel; that textarea snapshots undo on the **first keystroke** rather than on focus, since placing the note focuses it and a focus-time snapshot would make the first Ctrl+Z a visible no-op.
**Double-clicking** a text note opens the same textarea with the caret at the end of what is written - the gesture every canvas editor uses for "edit this thing's content" - and scrolls it into view, since the inspector is a scrolling stack of per-layer panels.
The prose deliberately keeps living in that one textarea rather than gaining a second, in-canvas editor that could disagree with it; the double-click only selects the note and moves the caret.
Both paths go through `focusNoteText`, and the placement one has to `preventDefault` its mousedown: the default action moves focus to the document *after* the listener runs, so without it the textarea was blurred the instant it was focused (which is why placement focus never actually worked).
It is the one canvas press that suppresses the default - every other one must keep it, or clicking the canvas would leave an inspector field focused and the keyboard shortcuts swallowed by it.
Prose stays a single-selection edit (merging text across a group has no sane meaning) while placement stays group-wide like every other layer.

### Compound bodies

**Ctrl+G** welds the selected geometry into one **compound body** (**Ctrl+Shift+G** splits it again); the pieces keep their placement exactly, and what changes is that they now build as a single engine body carrying all their shapes.
That is the whole point, and it is not about saving entries - several overlapping bodies already look the same.
It is that the joins between the pieces stop being corners: the rope refuses to wrap a seam vertex (`isSeamVertex`) and ledge detection refuses to grab one (`isSeamOccluded`), so a span crossing an L's inner corner runs straight instead of snagging where the real surface is smooth.
See **"Convex-only polygons; compound bodies"** in `docs/game-design.md` for why a concave form is several convex pieces at all - and **Authoring a concave outline** there for the case where those pieces are derived from one authored outline instead of welded by hand, which is the same body by the time anything simulates it.

Both of those ask **`isExposedCorner`** (`engine/shapes.ts`), and it decides by **angle, not proximity**.
Every shape covering the vertex contributes the arc of directions pointing *into* it - a wedge at one of its own corners, a half-plane along one of its faces, the whole turn if the vertex is inside it - and the vertex is a real corner exactly when the union of those arcs leaves more than a half-turn uncovered.
That is what a corner *is*: a flat point is covered by exactly half a turn, a reflex one by more, a buried one by all of it.
The vertex's own shape goes into the union with the rest, since it is what establishes there is a corner there at all.

Proximity was the old test - "is the vertex within an epsilon of a sibling" - and it is wrong in the arrangement a snap grid produces most: two pieces whose corners land on the same point.
That point is the **outer** corner of an L, with three quarters of a turn of outside around it, and calling it a seam sent the rope clean through a wall for seven frames (`session-410f`).
`cli corners` runs the arrangements with the answers written down (`sim/cornerCases.ts`) - it is pure geometry, so it is checked directly rather than through a level, where a wrong answer only surfaces as a rope inside a wall several hundred frames later.

Neither caller asks it per query any more. Exposure is a property of how a body's pieces are **arranged**, and that arrangement is rigid - every piece rides the body's transform, so moving or turning the body carries them all and cannot expose or bury a corner.
So it is settled once and cached on the shape (`CollisionShape2D.isVertexExposed`, invalidated when the shape set changes), and `isSeamVertex` is a lookup by vertex index.
`isSeamOccluded` takes that as its first answer and only then asks the *dynamic* half - neighbouring bodies, which do move relative to the corner. That decomposition is exact rather than an optimisation: coverage only grows as geometry is added, so a corner its own body has already closed off cannot be reopened by a neighbour.

A **non-colliding shape** may be a member too (see **Decoration**): it rides the body as decoration rather than becoming a piece of it - no shape, no mass, no seam - which is how a moving object gets a look that is not built out of collision geometry.

On disk it is simply several collision objects in one body's `objects` list - there is no tag to agree about, because the containment IS the statement.
A body has one kind, one fill, one friction and one force, and they live **on the body** rather than being authored per member and collapsed onto the first - which is what the flat form had to do, and what the editor had to keep in step behind it.
**Material and thickness are the exception** and stay per piece: a body's mass, centre of mass and inertia are sums over its shapes, so a stone head on a wooden shaft is a compound body of two materials and collapsing them onto the lead's would be the editor overwriting what was authored.
An area may not share a body with anything: `World.integrate` tests area overlap against `primaryShape()` rather than `getShapes()`, so a killzone or force area of several pieces would silently act through its first one alone, and the editor refuses to merge one.

Because a group is one body, it is **selected and moved as one**: clicking any piece selects all of them, a rubber band that touches one piece takes the whole body (`withWholeGroups`), and **Alt+click** reaches past that to a single piece when its own shape needs editing.
It also **rotates as one**, about the group's area-weighted **centre of mass** - which is where `buildLevelBodies` puts the built body's origin, so the editor's rotation and the body's are the same operation.
A whole-group selection therefore gets its own rotate knob (placed by the group's extent, since the pieces have their own angles and the body as a whole has none) and its `rot°` field applies a *delta* to the group rather than writing each piece's own angle.
Every group draws a small centre-of-mass diamond so it is identifiable as one body without being selected first, and a selected one adds a dashed hull and spokes to that centre.

A compound body is drawn as **one object**, not as its pieces: the shapes are filled as a union with the nonzero rule (so an overlap contributes one layer of the authored opacity rather than one each) and each piece is stroked only where it lies **outside every sibling**, which is the body's real outline.
The selection halo is the same walk over the **selected** pieces alone rather than over the whole body, which is what makes Alt+click's whole point visible: one piece picked out shows its own full outline, seam edge included, because that outline is what the piece IS, and every piece selected shows the body's outline with no seams drawn across it.
Haloing the body whenever any member was selected said the edit applied to all of it, which for a numeric field or a Delete is exactly what it would not.
Drawn piece by piece it read as a darker patch at every overlap and a crack at every join - a wall with a line down it.
The clip is applied one sibling at a time on purpose: a single even-odd clip keeps the region inside *two* of them, which is exactly where an interior seam sits.
`drawCompoundGeometry` (game) and `strokeCompoundOutline` (editor) are the two implementations of that one rule.
Hook-only bodies keep the per-shape path, since their fill is a grate lattice punched out of each piece and a lattice has no union form.
The headless SVG snapshot still draws the pieces separately - it is a diagnostic view, and there the decomposition is the thing worth seeing.

### Chains

**+Chain** (**K**) drags a chain from one body to another: press on the first body, release on the second.
A chain is a real constraint, not decoration - it is a `Rope` with both ends pinned at load (`src/level/chains.ts`), stepped once a frame after `World.integrate` by both level drivers, so a rigid body on either end hangs, swings and is hauled by it while a static is infinite mass and simply holds.
There is deliberately **no new physics**: `Rope` already models a rope between two `RopeContact`s on arbitrary bodies, and a scene chain is that class with neither end being a hook in flight.

What a chain is **not** is collision geometry: nothing stands on it and another rope does not wrap it.
Both would need the chain to be a body per link, which is a different mechanism.

A chain is **scenery**: drawn behind the level's geometry at 55% alpha, and solved against **nothing** - `SceneChain.physicsStep` hands the rope an empty candidate list, so it hangs, swings and hauls its own two bodies and passes through everything else.
The editor draws it dashed and `cli render` dashes it too, so a snapshot never reads a chain lying across a body as a chain caught on it.

There was briefly a second, `foreground` plane - in the play space, drawn over the geometry and solved against the whole scene, so the span wrapped corners and the avatar and its hook could be caught by it - and it was **removed**.
It bought very little that a rigid body on a chain does not already buy, and it charged for that by making every chain a thing the player might silently snag on, and every wrap-and-corner bug in the solver reachable from a piece of decoration.
If a chain in the play space is ever wanted again, note that the plane has to stay *one* decision and not two: what a chain is drawn in front of and what it is allowed to touch are the same statement, because a chain hanging visibly behind the level that still snagged the player is a lie the level tells.

The empty candidate list is exactly right rather than a special case: `Rope.regeneratePath` never wraps a span around the bodies that span starts and ends on, so "the scene is empty" and "only the two anchors exist" are the same solve.
It is also why `Rope.physicsStep` derives its **own** set of bodies to pay for the correction (`moved` = the scene it was handed ∪ the bodies on its path) rather than crediting the list it was given: a chain is handed none of the scene, and a body whose position the solve corrects but whose velocity nothing credits keeps every frame's gravity - a wrecking ball on a chain sat perfectly still at **119 m/s** by the twelfth second, waiting for the first frame that gave it slack.

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
Two details are load-bearing.
The push-out counts **statics only**: a chain-hung body is as often a platform as a weight, and an overlap with something resting on it is a pair the next `integrate` solves for both sides - resolving it here moves the wrong body and then pays it for having moved, which shoved the slab out from under the ball in `steered-hung-hold` and rode the credit 15 m across the level.
And the credit carries `topologyCreditScale`, because this **replaces** the per-pass credits rather than adding to them: a scene chain wraps nothing, but its span is still re-resolved around the corner of the body it is bolted to, and dropping the scale let this rig's span grow 46 cm in one frame as the plank turned under its own anchor and threw it off at 13.9 m/s.
`cli contacts` `chain-hung-jam` is the case, and what it asserts is the **compounding** (peak 6.6 m/s against 14.5) rather than the tunnel, since a runaway is what a tunnel is made of.

Still open there: a hard jam ends 15 s at ~1 m/s rather than at rest, and `energy-gained` still fires on one.
The chain's correction is part rotation and the push-out that answers it is a translation, so the difference is credit nothing takes back - the same fight one derivative up.
An angular push-out is what that wants, and it belongs with the ball's phase, which has the identical hole.

#### Anchors

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

Levels save/load to `rope/levels/*.json` in the **on-disk pixel `LevelData` format**
(same as generated `levelData.ts`), through a **dev-only REST API** (`GET/PUT/DELETE
/api/levels[/<name>]`) added by the `levelApi` Vite plugin in `vite.config.ts`. The built
app has no server, so the editor is a dev tool.

Saving is **automatic** once the model has a name: every edit (including undo/redo) schedules a write 750 ms later, so a drag or a run of nudges collapses into one save, and a pending write is flushed on `pagehide` with a `keepalive` request.
An *unnamed* model never autosaves - the first Save/Save As names the file, and everything after that persists on its own; the title's `*` is therefore a brief in-flight marker, not a standing warning, and an autosave failure shows as `SAVE FAILED` there rather than an alert (a modal mid-drag is worse than the loss it reports).
New/Load/Delete each cancel a queued write, so it can never land on the wrong name or resurrect a deleted file.

Autosave must not reload the page, and by default it would: `levels/ball.json` is *imported* by `registry.ts`, so writing it invalidates a real module and Vite full-reloads every open page - including the editor doing the writing.
So `levelApi` implements `handleHotUpdate` and returns `[]` for anything under `levels/`, dropping those files out of HMR entirely (a level is only read at page load anyway; reload by hand to pick one up), and its `PUT` skips writes whose bytes are unchanged so a redundant autosave never even touches the watcher.

A saved level ships in the build by being **imported** into `src/level/registry.ts`
(`resolveJsonModule`; JSON widens string literals, so the spec casts to `LevelData`). That
is how `levels/ball.json` backs the `BALL` entry: one file, edited in the editor and bundled
into production, rather than a hand-copied TS duplicate.

The canonical, hand-editable schema now lives in `src/level/levelFormat.ts` (superset of
the generated one — adds the `rigid` and `force` kinds, the `cameraRegions` and
`chains` lists, and bodies made of scene objects); `levelData.ts` stays
auto-generated and is structurally assignable to it. Both level drivers construct geometry
through the shared `src/level/buildBodies.ts` (statics, killzones,
force areas, and rigid bodies), so the grapple and ball controllers load identical scenes.
`rigid` bodies get mass/inertia from `ShapeGeometry` and fall under gravity.

## Camera

### The view

The game is drawn into a **fixed 1920 × 1080 frame** scaled to fit the window (`render/viewport.ts`), not into the window itself.
Every layer above the canvas - the camera, the renderer, pointer un-projection - works in those **view pixels** and never sees the window's real size; the window decides one thing, how large the frame is drawn.
It is centred, scaled by the tighter axis, and what is left over on the other axis is background: letterbox bars on a 4:3 display, pillarbox bars on a phone.

Framing is the reason, and it is not cosmetic.
A camera region's `viewportScale` says *how much world is on screen*, and that can only mean something if "the screen" is a fixed shape - sized off the window, a tall monitor saw further up and down than a laptop and a phone in landscape saw a different level again, so a room framed by eye in the editor was framed differently for everyone who played it.
1920 × 1080 because that is what the zoom constants are read on: at that size the frame is 1:1, and it is why `BALL_ZOOM` could stop being height-driven.

`ViewTransform` (a scale plus the frame's origin, in the target's pixels) is the whole interface, and it carries the display's DPR folded into its scale, so the renderer takes one argument for where the frame is and how big.
The same value describes the frame in **client** pixels, which is what `clientToView` un-projects a pointer through: one arithmetic for drawing the frame and for reading a click on it, rather than two that can disagree by a letterbox bar.
It also means the frame does not have to *be* the canvas - the editor's ▶ Test fits it into the whole editor canvas and paints the bars itself (`LETTERBOX_COLOR`), so a level is tested in the frame it will be played in.
The touch controls are positioned inside the frame rather than the window for the same reason.

`cli shot` asks headless chromium for a window 87px taller than the frame, since that is what the browser keeps for itself, so a grab is exactly the frame with no bars.

`render/cameraController.ts` owns the view: an **eased follow** of the avatar, reshaped by the level's **camera regions**.
It is deliberately render-side, driven by the wall-clock frame `dt` rather than the fixed timestep, so easing it can never change a recorded run.
(The grapple controller un-projects the cursor through the camera, so the camera does reach the sim as *input* — but the trace records the resulting world point, so replays stay bit-identical.)
`camera.zoom` is the controller's **output**; the base framing scale lives in the caller (`GRAPPLE_ZOOM`, or `BALL_ZOOM` for the ball).
The default framing puts the avatar **dead centre** for both controllers — the ball's old 3/5-down shift is gone — so shifting the view is a camera region's `offsetX`/`offsetY` and nothing else, one authored mechanism rather than a per-controller rule.

Two smoothings run at deliberately different timescales:

- **Follow lag** (`CAMERA_FOLLOW_TAU`, 0.15 s) — an exponential ease of the camera toward its target, `1 - exp(-dt/tau)` so a 60 Hz and a 144 Hz display behave identically. This is the "not rigidly locked to the player" part.
- **Region hand-off** (`CAMERA_BLEND_TIME`, 0.7 s, per-region `blend` override) - when the governing region changes, the gap between what the outgoing region wanted and what the incoming one wants is **frozen** at that instant and smoothstepped to zero on top of the incoming target, which goes on being evaluated live.

Freezing that delta is the point of the mechanism.
The camera aims at the *correct* position for the region it is now in, displaced by a decaying constant, so two very different configurations that happen to agree at the crossing hand over invisibly - the delta is simply zero.
Cross-fading the two *live* targets instead, as this used to, keeps the outgoing region tracking the avatar for the whole blend, so its decaying share hauls the camera off the correct position and then lets it snap back: rubber banding whose size has nothing to do with how far apart the two cameras actually are.
The delta is measured between the two targets rather than against where the camera *is*: aiming the camera at its own position would drop its velocity to nothing for a frame, which reads as a hitch.
Taken this way the aim point is unchanged on the crossing frame, so the camera carries its follow lag straight through and only the delta decays; a hand-off interrupted part-way folds its remainder into the new delta, so that case is continuous too.
One mechanism therefore covers default→region, region→region and region→default: "no region" is just the null region, whose target is the plain follow point.
`CameraController.snap()` drops the easing for one frame (level start and reset), where easing in from the last frame's position would be a swoop across the level.

### Render interpolation

The sim is a fixed 60 Hz, so drawing its raw state on a 120/144 Hz display repeats and skips frames, which reads as jitter - most visible on the ball at the end of a fast swing.
Every rendered frame therefore draws **between** two sim states: `World.captureRenderTransforms()` runs at the top of each level's `physicsProcess` (before anything moves), and the renderer takes an `alpha` = leftover accumulator ÷ step, clamped to 1 so a frame that hit `MAX_STEPS_PER_FRAME` never extrapolates past the current state.
`CollisionObject2D.renderPosition/renderRotation/renderShape(alpha)` are the whole interface; rotation interpolates the short way round (`wrapAngle`) so a body crossing ±π does not unwind a full turn.
The captured transform is **render-only state the sim never reads**, which is what makes this safe: `replay selftest` stays bit-identical.

Derived geometry follows the same rule rather than being lerped as a shape:

- The rope/chain is drawn from its wrap **nodes**, not the resolved spans. A node is a point in its body's local frame (`RopeContact.renderGlobalPosition`), so re-resolving it against the render transform keeps the chain welded to the drawn ball and the drawn hook — resolved spans would leave it visibly detached between steps.
- The player rig stores its limbs as offsets from the player, so interpolating the whole rig is interpolating one anchor point (`lastP`).
- The ball's loop (and the chain leaving it) comes from `renderLoopCenter/renderLoopDirection`, the same derivation against the interpolated pose.
- The camera follows `cameraRenderPosition(alpha)`, not the raw sim position: tracking the 60 Hz position while the avatar draws interpolated would put the jitter straight back, on screen.

The debug overlay (L) deliberately keeps drawing the **exact** sim state — it exists to show what the simulation believes, so a frame of render smoothing has no business in it.

A **camera region** (`CameraRegionData` in `levelFormat.ts`, its own `cameraRegions` list rather than a `BodyKind`, since it has no collision and nothing may wrap it) computes the target per axis:

```
target.x = lockX ?? (avatar.x + offsetX)
target.y = lockY ?? (avatar.y + offsetY)
zoom     = baseZoom / viewportScale
```

Per-axis locking is what makes one primitive cover all three asks: both axes locked is a fixed camera, one axis locked is a shaft or corridor that pins one and follows the other, neither locked is an offset follow.
`offsetX/offsetY` only apply to the axes that still follow, and `viewportScale` is *how much world is on screen* (2 = twice as much, zoomed out), so it divides the zoom and blends geometrically — 1→4 passes through 2, not 2.5.
The containing region with the highest `priority` wins (later in the list breaks a tie), and the region in force keeps its grip until the avatar leaves it by its **`buffer`** - `REGION_EXIT_MARGIN` (15 cm) when it authors none, which is sized for jitter alone: without that much hysteresis, hovering on a boundary re-triggers the cross-fade every frame and the camera stutters.
Regions are invisible in play, so the **debug overlay** (L) draws every volume and fills the active one: a camera that offsets, zooms or pins otherwise has no on-screen cause.
It takes that region from the controller rather than recomputing it, because the grip depends on which region held the camera last frame - a recomputed answer disagrees with the camera across the whole width of the buffer, which is exactly what the overlay is opened to see.
The active region's buffer draws with it, as a finely dotted outline: the region holds the camera out to there, so without it a region that refuses to let go looks like a bug.

### Buffer

`buffer` is how far outside its own volume a region will follow the avatar before giving the camera up, and it is the answer to swinging.
A player on one attachment point crosses a boundary twice a swing and hands the camera over each time; a buffer wide enough to cover the far side of the arc keeps one camera for the whole thing.
It is pure geometry - no easing, no filtering, no rope state - so it behaves identically at any swing speed and any frame rate, and an author sets it by looking at how far out of the room the arc actually reaches.

Only *leaving* is buffered.
A region takes the camera the moment the avatar is inside it, so the buffer reads as "how far out of this room I may stray without the camera changing its mind" rather than as a second, larger volume that grabs the camera early from outside.
That asymmetry is also what keeps a buffer from fighting its neighbour: two adjoining regions with wide buffers hand over on whichever one the avatar is actually standing in, since only the current one's buffer is ever consulted.

A **rect** region may state one buffer per side instead - `bufferLeft`, `bufferRight`, `bufferTop`, `bufferBottom` - because a room is rarely symmetrical and the arc out of one usually reaches far past one wall and barely past the other, which a single number can only cover by being that wide in all four directions (and a buffer that wide is a region that will not let go).
Sides are the region's **own**, in its local frame - left/right are ∓x and top/bottom are ∓y, so a rotated region's "top" turns with it - and each falls back to `buffer`, which falls back to `REGION_EXIT_MARGIN`, so authoring one side leaves the other three exactly as they were and every level authored before the fields loads unchanged.
A circle has no sides and a polygon's growth is a signed-distance offset with no axis to hang them on (see `pathOutlineGrown`), so both ignore the fields and take `buffer` alone; the editor offers them to rects only rather than showing four controls that do nothing.
`pathOutlineGrown` grows a rect per side for the same reason it grew it per axis before - that is literally what `pointInRegion` tests - so the dotted outline in the editor and the overlay is exactly the volume the region holds by, which is the whole point of drawing it while it is being authored by eye.

`priority` still overrides the grip, and is the escape hatch a wide buffer needs: a small, deliberately-framed volume sitting inside a big buffered one has no other way to take the camera, and saying so explicitly beats shrinking the buffer until the overlap happens to work out.
The consequence to author around is that leaving that priority island drops to whatever contains the avatar *then* - the buffer belongs to the region currently in force, and the island became that region on entry, so the enclosing region's buffer is no longer what is holding.

### The screen-edge guarantee

Whatever rule is in force, the avatar may never enter the outer **`CAMERA_EDGE_MARGIN`** (8%) of the frame, on either axis.
It is the one camera rule with no authored override, and deliberately: a level may frame the avatar however it likes, and none of those framings is allowed to be "off the bottom of the screen".

It is a clamp on **where the camera IS**, applied last in `update` and to the controller's own `pos` rather than to the target.
A target the avatar can outrun is not a guarantee, and outrunning the ease is exactly what a launch does; clamping `this.pos` rather than only what is handed to the `Camera` is also what keeps the next frame continuous, since the camera really is where the constraint put it and carries on easing from there.

The margin is a **fraction of the frame** rather than a distance, because what is being constrained is where the avatar is ON SCREEN: a region that zooms out shows more world, and a margin in metres would shrink to a sliver of the frame exactly where the frame got roomier.
It is measured to the follow POINT, so it has to clear the avatar's own radius and leave something worth seeing - 77 cm either side and 43 cm above and below on the 9.6 x 5.4 m a 1080p frame shows at `GRAPPLE_ZOOM`.

It is **inert in ordinary play**, which is what makes it safe to apply globally.
The default camera centres the avatar, so the only thing that can put it near the edge under the plain follow is outrunning the ease - which settles at a lag of `speed x CAMERA_FOLLOW_TAU`, needing a sustained ~27 m/s before it binds against a hard swing's ~10.
What it does bite on is a locked region the avatar has left, and a path whose lookahead aims the camera well off them.
`cli camera` asserts both of those, plus a one-frame teleport, plus that it never binds at ordinary speed - and each of the three holding cases is red without the clamp.

The debug overlay draws the keep-out box **only on the frames it is binding** (amber, not the camera layer's violet): a camera that has stopped following has no on-screen cause otherwise, and drawing it every frame would make it furniture rather than a diagnosis.

`CameraController.edgeClamp` turns it off, and the **editor's `edge clamp` checkbox is the only thing that ever does** - for ▶ Test alone.
An author tuning a lock or a lookahead has to be able to see the framing that rule is actually ASKING for, and that question is unanswerable while the answer is being silently corrected.
It is an instrument rather than a level property, so it lives on the controller and is written to no file; the game constructs its controller and never touches the switch.
`cli camera` asserts both halves of it - the same walk held on screen with it on and not held with it off - since a toggle connected to nothing passes any test that only checks one side.

### Camera paths

A **camera path** (`CameraPathData`, its own `cameraPaths` list beside `cameraRegions`) is an authored curve the camera rides.
The avatar is projected onto it and the camera targets a point further ALONG the route, so the screen leads the player toward where the level expects them to go.
A region frames a *place* and cannot say anything about where the player is going next, which in a traversal level is the more common thing to want; that is the whole of why this exists.

It is deliberately **not** a region with a funny shape.
A region is a closed volume tested by containment and a path is an open directed polyline tested by distance, so forcing one to impersonate the other would leave every shape helper (`pointInRegion`, `pathOutlineGrown`, the convexity rule) half-lying.
The two are instead generalised into one **rule set** (`CameraRule`, built once per level by `buildCameraRules`), because `activeCameraRegion`'s priority/buffer logic - highest priority wins, later author order breaks a tie, the incumbent keeps its grip inside a grown margin unless strictly outranked, entering is never buffered - is exactly what a path needs too.
`activeCameraRule` is that same function with two kinds of containment in it; `cameraRuleTarget` is `cameraRegionTarget` with a path arm.
Paths are listed **after** regions so a path beats a region at equal priority: the path is the level's primary guide and a region is the local exception, which says so with `priority`.

**Direction is the design**, and the lookahead never flips.
The path is directed by its vert order and always leads toward increasing arc length, so even when the player backtracks the screen keeps arguing for the authored way.
Smart direction inference was rejected rather than deferred - the whole point is that the camera argues.
Clamping at the ends is the correct degenerate behaviour: near the goal the camera comes to rest centred on the path's end rather than staring past it.

#### The lead is an ellipse

`lookaheadX` and `lookaheadY` are how far ahead the camera looks per axis, and they are two numbers because the frame is **16:9**: there is far less screen above and below the avatar than either side of them, so one lead that frames a corridor well throws the player off the bottom of a shaft.
`pathLookahead` reads the pair through `ellipseReach` - as the semi-axes of an ellipse - and answers the arc length whose displacement lands on it - `lookaheadX` along a horizontal route, `lookaheadY` along a vertical one, and what fits between for anything diagonal.
It is resolved against the direction the route actually goes over that lead: the local tangent first, then one refinement against the chord to the point it lands on, since on a bend those are different answers and the ellipse is a statement about the DISPLACEMENT.
One refinement rather than iterating to a tolerance, because the correction is second order in the curvature and a fixed step is deterministic.

#### The lookahead buffer

`lookaheadBufferX` / `lookaheadBufferY` are a **deadband on the arc length the lead is measured from**, and they are the answer to swinging.
A swing is an oscillation ALONG the route - the projection runs forward and back several times a second - so a lead taken from it exactly sloshes the camera with it, which no amount of `CAMERA_FOLLOW_TAU` fixes because the target itself is rocking.
`committedLeadS` clamps the committed point into a band of this width around the projection, so it does not move at all while the avatar stays inside: on the first half-swing the band is dragged to one edge, and every swing after that moves it by nothing.
Absorbed rather than damped, which is the difference from easing harder.

Clamping rather than "hold, then jump to the avatar" is what keeps it CONTINUOUS - the committed point is only ever dragged by the edge of the band, so there is no step in the target for the hand-off machinery to have to blend.
The price is that on genuine forward travel the lead is short by the band, which is what the buffer MEANS and what an author is choosing when they widen it.
It is centred on the avatar on acquisition, like the projection itself: entering is history-free, so the band never carries an offset earned somewhere else on the route.

The pair is resolved through `ellipseReach` - the same helper `pathLookahead` uses, and for the same 16:9 reason - against the direction the route runs where the BAND currently sits, which on a bend is not where the avatar is.

`cli camera` asserts the pair that makes the claim: the same swing with the band absorbs it (the committed point's range is exactly 0 and the camera's travel over the last second is 0) and without it does not (the camera keeps moving), plus that a swing WIDER than the band is dragged by exactly its excursion less the band on each side, and that the same swing is absorbed along a horizontal route and not along a vertical one when the two axes differ.

#### Curves

A path's nodes carry cubic **Bézier tangent handles** (`CameraPathVert`'s `inX/inY/outX/outY`, offsets from the node in the path's own frame), and the whole of what they cost is `flattenPath`: everything downstream rides a polyline, and a flattened cubic IS one.
An edge whose two facing handles are both absent contributes nothing but its endpoint, so a path of corners flattens to exactly its own nodes and every polyline path is bit-identical to what it was before handles existed - which is also why a corner writes four keys and no more.
Sampling is `PATH_FLATTEN_STEP` (25 cm) of control polygon per point, capped per edge; `cli camera` asserts the worst chordal error against the true cubic, which is what `range` is ultimately measured against.

In the editor a node's two grips are drawn at their own offsets, or as a **stub** a fixed screen distance along the edge when unset - a grip sitting exactly on the vertex it belongs to is unpickable, and a stub makes every corner one drag from smooth.
Dragging mirrors the opposite handle in direction and length (a smooth node); Alt at the press breaks the pair into a cusp.
Inserting on an edge is a **de Casteljau split at t = 1/2**, so a bowed edge gains a grip and changes shape by nothing; splitting the chord would straighten it the moment it was subdivided.
`Smooth` writes the Catmull-Rom tangent at every node (a third of the chord between its neighbours) and `Sharpen` zeroes them all.

#### The corridor is an ellipse too

`rangeX` / `rangeY` are how far off the route the player may be while the path still narrates it, and `falloffX` / `falloffY` grow it into the band below - each pair the semi-axes of an ellipse around the route, so the corridor, the band and the release are all **screen-shaped**.
The frame is 16:9 - half of it is 4.8 m across and only 2.7 m down at `view × 1` - so with the old single circular `range` of 4 a player could be fully inside the corridor, the camera still centred on the route, and the ball past the bottom edge of the frame with the falloff not even started: the edge clamp was load-bearing for ordinary vertical excursions, and it is meant to be a backstop.
The defaults are the frame's own ratio (`DEFAULT_PATH_RANGE_Y` = 4 × 9/16 = 2.25), which puts the worst-case vertical offset the band ever asks for (~2.3 m) inside the 2.7 m half-height.

Unlike the lookahead's ellipse - resolved against the direction the ROUTE runs - these are resolved against the direction the player actually left the route in (`pathOffset`, the displacement from their projection), because that is the displacement the screen has to hold.
`pathRange`, `pathBand` and `pathRelease` answer the reach along that direction; `pathReleaseAxes` grows both semi-axes by `buffer`, so the release boundary stays an ellipse and the editor and overlay draw EXACTLY the zone tested - through `pathCorridorEllipseInto`, which builds the polyline's Minkowski sum with the ellipse by running the circular fillet walk in a y-scaled space and letting the canvas transform carry it back.
The retired scalar `range` / `falloff` are folded into both axes by `scaleLevelData` at the one gate, so a level that authored a circle keeps exactly that circle; `cli camera` asserts the fold, the per-axis reaches, and - on the rule set - that acquisition is screen-shaped: 2 m below a 1 m vertical range does not take the path while 3 m past its end inside the horizontal range does, which a circular implementation cannot split.

#### The falloff band

The falloff is the band OUTSIDE the range the path lets go over, and it exists because crossing the range used to swap the rule outright - the camera aiming down the route one frame and at the avatar the next, with the hand-off blend able to smooth that over but never make it small.

Through the band `pathFalloffWeight` interpolates the path's target toward the **null rule's** - the plain follow at the base zoom - smoothstepped from 0 at the range ellipse to 1 at the band's outer ellipse (both resolved along the player's own offset direction, above), so lookahead, viewport scale and everything else the path asks for fade together and by the band's outer edge the two targets are **identical**: the release delta is exactly zero and the boundary stops existing perceptually.
Smoothstep rather than linear so the weight is C1 at both edges - a kink in the target is a step in the camera's velocity, which reads as the camera catching on an invisible line.
A zero falloff (both axes) means no band at all: the path keeps its full grip out to the release and the hand-off blend covers the swap, which is the pre-band behaviour.

This replaced a positional drift that froze the avatar's screen position across the band, and the drift's three seams are why: the camera's behaviour flipped character at the range (riding the route one frame, tracking the avatar 1:1 the next), the drift capped at the falloff while the grip held all the way to the release (so the avatar slid again in the gap), and the lookahead never faded - so the release still swapped a full-lead target for the plain follow, a ~2.7 m delta the blend could smooth but never make small.
The trade accepted with the weight: the avatar's screen position is no longer perfectly frozen inside the band - frozen-screen-position was the drift's mechanism, not the goal, and the goal was no jump.

The weight is measured against the avatar's offset from their TRUE projection rather than from the deadbanded point the lead is taken from: this is about where they actually are relative to the route, which is the quantity the range is measured in - and while held it is the WINDOWED projection's offset, so at a switchback the fade is about the branch being ridden, exactly as the grip is.
The band extends the grip (`pathRelease` is the band's ellipse grown by `buffer` on both axes) but NOT the acquisition, which stays the core range - a graceful exit rather than a wider entrance, the same asymmetry the buffer already has.
Widening the acquisition to the band looks free (the weight is ~1 out there, so grabbing changes nothing on screen) and is not: a path acquired at zero influence still WINS the rule tie-break, so it would silently override a region the player is standing in with what amounts to the plain follow.

`cli camera` asserts the claim the whole thing is for, and all three cases are red without the weight: the weight's shape (0 inside, 1 outside, flat at both edges), the target interpolation with the null rule's target reached identically at the band's edge, and a controller ride in which the camera travels essentially nothing after the release fires.

Straying past the release ellipse **releases** the path, and the camera falls back to whatever rule governs where the player actually is - a region if one contains them, the plain follow otherwise.
Coming back re-acquires it.
Every one of those transitions is a rule change, so the controller's existing frozen-delta hand-off blends all of them for free; the one addition is that an outgoing path is evaluated at its tracked projection rather than at a fresh global one, since both targets have to be measured at the same instant and on the same branch or the frozen delta is a gap that never existed.

#### The windowed projection

The load-bearing piece, and the reason `render/cameraPath.ts` is more than a distance function.
A **global** closest-point query is discontinuous wherever the path passes near itself: on a switchback one frame's projection can teleport many metres of arc length, taking the lookahead target with it, and the hand-off blend cannot help because the rule identity has not changed.

So the controller tracks the projection statefully.
On **acquisition** it is a global `projectOntoPolyline` - entering is unbuffered and history-free, exactly like a region.
While **held** it is `projectOntoPolylineWindow` around last frame's `s`, with the window sized to what the player could plausibly have moved:

```
maxStep = |follow - lastFollow| + PATH_TRACK_SLACK_SPEED * dt
window  = [s - maxStep, s + maxStep]
```

The `followDelta` term means no legitimate move can outrun the window however fast the avatar is flung; the `dt` term keeps it frame-rate independent.
The path's **grip** is then measured to that windowed projection rather than to the global closest point, which is what makes the range mean what the author set it to: a player who drops off an upper branch toward a lower one has the release distance measured against the branch they were actually riding, so the path lets go, the fallback rule takes over with a blend, and the lower branch re-acquires with a fresh global projection and another blend.
`switchback-window` in `cli camera` is the case, and it is red against a window-ignoring implementation while every other case in the file is green.

The window has a failure mode of its own, and the **branch challenge** is its other half.
The grip is per-PATH while the geometry is per-branch, so a player who genuinely leaves the ridden branch and lands inside the corridor of a DIFFERENT branch of the same path was held by the ridden branch's falloff zone in preference to the branch under their feet - the incumbent and the containing rule are the same object, so "keep the incumbent" won, and the window then guaranteed the projection could never walk there.
`session-285f` is the shape of it: the ball fell off the upper branch clean through the lower branch's corridor at 0.05 m while the grip clung to the upper one at 5.4 m, the release finally fired at 1.06 m off the lower branch - 6 cm outside its range, so nothing ever re-acquired - and the ball settled inside the drawn falloff band with the camera plain-following, which reads as the camera being in the wrong place.
So a held path is challenged every frame by its own GLOBAL projection (`branchJump` in the controller): outside the ridden corridor (plus the jitter buffer) and inside the core range at the global answer, it re-acquires there exactly as it would after a release - a fresh projection, a re-centred lead, and the jump run through the frozen-delta hand-off so the arc gap between the branches blends instead of snapping.
The challenge cannot fire on the ridden branch itself, by construction rather than by threshold: a global answer inside the window IS the windowed answer, so the two distances agree and cannot sit on opposite sides of the range - which is what keeps the switchback protection whole.
`switchback-branch-reacquire` asserts both halves (the camera ends held on the branch the ball is on, and no single frame moves it more than 15 cm), and each is red alone: the challenge disabled ends held on the wrong branch, and the challenge without the hand-off snaps 0.29 m in one frame.

The whole thing stays **render-side and wall-clock driven**, so recorded replays and `cli selftest` are bit-identical: nothing here touches the sim.
A level with no `cameraPaths` reduces to a regions-only rule set and every code path is what it was.

`cli camera` (`src/sim/cameraCases.ts`) is the suite: the pure geometry (projection, arc length, the switchback), the controller (leading, backtracking, release, re-acquire, no snap at a hand-off, the path-beats-region tie-break), and the editor's `modelFromDisk`/`modelToDisk` round trip, which is the half nothing else can see - the editor rewrites the whole file every 750 ms, so a dropped field is gone from disk before anyone notices it was read.

In the **editor** a path is a camera-layer item whose `EdShape` is `{ kind: "path" }` - an open curve carrying its points and one handle pair each, `setPathVerts` its one writer (drops consecutive duplicates, requires two verts, re-centres `pos` on the point AVERAGE, a curve having no area centroid; handles are offsets from their own point, so the re-centring leaves them alone).
It is drawn with `+ Path`, a run of clicks finished with Enter or a double-click, and edited by exactly the vertex handles a polygon has minus the wrap.
It is excluded from the pass that fills and strokes closed outlines, because it has none: `outlineOf` can only answer its bounding box, and a box is not the thing.
Its bounds, its pick band and its rubber-band test all read the FLATTENED curve rather than the node points - a bowed edge leaves the node hull, and a box that does not contain what is on screen is a box the pick rejects before it ever tests the shape.
There is no convexity or simplicity rule: a path may cross itself, that being what a switchback is.
Its panel is its own rather than a variant of the region one - a path has no offset, no lock and no per-side buffer, and showing them greyed out would say it might - and it carries a `Reverse` action, direction being meaning.


## 3D rendering

The ball & chain is drawn in 3D (`src/render3d/`, three.js), in the style of *Getting Over It* and *A Difficult Game About Climbing*: gameplay on a single plane, a perspective camera, PBR surfaces, one warm sun with shadows, and - where a level asks for it - fog fading the layers behind.
**The physics is untouched by all of it.**
It is still 2D, still metres, still a fixed 1/60 step, still deterministic, and every replay in `playtests/` still replays bit-for-bit - the 3D renderer is a parallel consumer of exactly the interpolated state the 2D one reads (`renderPosition/renderRotation/renderShapes(alpha)`, `RopeContact.renderGlobalPosition(alpha)`), and it never writes anything the sim can see.

`?render=2d` selects the old path anywhere; `?render=3d` selects the new one.
The default is 3D for the ball level and 2D for the grapple levels, because the Player state-machine slice (its rig, its rope, its ledge overlay) is deliberately still 2D - a grapple level in 3D is a 3D world with a 2D avatar in it, which works but is not what anyone asked for yet.
A machine with no WebGL falls back to the 2D renderer rather than to a blank page.

### Two canvases, one camera

The WebGL canvas sits **under** the existing 2D one, which clears transparent and keeps everything that is genuinely 2D: the debug overlay, the aim reticle, the area glyphs, the FPS counter, the vignette, and in the editor the collision outlines, handles and marquee.
`fitCanvas` sizes both from one arithmetic, so a pixel on one is a pixel on the other, and the top canvas keeps the pointer events - the scene below is drawn, never clicked.
`overlayOnly` on `render`/`renderBall` is what drops the backdrop and the bodies from the 2D pass; it defaults **off**, so `shot.html`, `cli shot` and `cli render` are untouched.

That stacking is what makes "see the collision boundary on top of the geometry it describes" free, and it stands entirely on the **camera correspondence**.
The existing `Camera` (metres + zoom) and `CameraController` (regions, blending, locks, `viewportScale`) stay the authority; the perspective camera is derived from them every frame in `render3d/space.ts`, with **zoom becoming dolly distance**:

```
visibleHeight = camera.viewportHeight / (camera.zoom * PIXELS_PER_METER)   // metres at z = 0
dist          = (visibleHeight / 2) / tan(fovY / 2)
threeCam.position = (camera.position.x, -camera.position.y, dist)
```

So camera regions, blends and `viewportScale` keep working untouched, and props off the plane parallax naturally as the view zooms.
The FOV is a narrow ~34° on purpose: the gameplay plane reads almost orthographic, so a wall at the top of the frame is barely foreshortened and the outline a level was authored against is still what the player sees, while off-plane layers still move at their own rate.

The two projections agreeing is **asserted, not eyeballed**: `cli render3d` runs three.js's own projection against the 2D transform at five camera placements and through a pan, at the corners of the frame where a wrong dolly distance shows first, and holds them to a hundredth of a view pixel.
`?probe3d=1` is the same claim made visible - a known world rect drawn as a plane in the scene and as an outline on the overlay, which must coincide at any zoom, position or mid-blend frame.

### The coordinate mapping

Physics is x right, y **down**, rotation clockwise-positive.
Three is right-handed, y **up**.
The single conversion lives in `space.ts` and nothing converts anywhere else:

```
three.position.x =  body.x
three.position.y = -body.y
three.position.z =  z          // 0 is the gameplay plane, +z toward the camera
three.rotation.z = -body.rot
```

The y-negation also mirrors a polygon loop, which is why `extrude.ts` measures the loop's signed area and re-winds it: physics polygons are wound clockwise-on-screen with y down (see **Shapes**), and `ExtrudeGeometry` wants counter-clockwise in its own frame for the front cap to face the camera.
That happens to be what the negation produces, which is a coincidence worth stating rather than relying on - `cli render3d` asserts the cap's normals.

### Nothing draws a collision shape but a geometry object

A collision object is what a body is **made of**; a geometry object is what it **looks like**; and a body with no geometry object is drawn by nothing at all - a solid, invisible wall, which is a thing a level may want.
They used to be one authored thing: a collision shape drew itself whenever nobody said otherwise, which meant there was no way to say "this collides differently from how it looks" without also saying how it looks, and every question about appearance had to be asked of a shape that had opinions about mass.

**AND IT IS DECOUPLED IN BOTH DIRECTIONS.** A geometry object carries its own `shape` and its own placement, always, and nothing about what is drawn is read off a collision object - not the form, not the position, not the rotation, not the depth, not the surface.
A primitive nudged 10 cm left, turned 5° and made twice as wide moves, turns and grows on screen while the body goes on colliding exactly as it did.

It was not always: a geometry object with no shape used to draw the body's collision outlines, which is how a wall wore brick without restating its outline and what every migrated body was given.
The saving was real and the cost was that the two were not actually separate things - the geometry object's own `x`, `y`, `rot`, `w` and `h` were **dead fields on the commonest object in every level**, silently overridden by the shape it was standing in for, and "this collides differently from how it looks" was still unsayable for the one case (a different SIZE or PLACE) an author reaches for first.

The old default is still written down, twice, and both halves state the outline rather than borrowing it:

- `withGeometryPrimitives` (`levelFormat.ts`) gives a body converted from a **legacy flat entry** one primitive per collision object, each carrying that piece's shape, placement, `thickness` as its `depth` and `material` as its `texture`. That is the only form the old default was ever authored in, and `levelData.ts` still arrives that way from the Godot extractor.
- `scripts/migrate-primitives.ts` did the same thing **once, on disk**, to the levels already in the nested form (`levels/*.json`: 159 dressings became primitives). It inverts the retired `outlineDressings` pairing, so a compound body dressed by one geometry object gets one primitive per piece, and it is kept because it is the record of what those files were.

Both are pixel-identical by construction, and the second is why there is no load-time migration for the nested form at all: a file says what it draws, and the loader does not edit it on the way past.

"No geometry object **at all**" is the load-bearing half of the legacy one. Any geometry object is the body saying how it looks, and that answer stands: a lamp whose collision box carries an authored mesh looks like the lamp, and twinning it too extrudes a grey brick inside the fitting - visible in play, invisible in the editor, and exactly the kind of thing a migration must never invent.
It is idempotent because it has to be - the legacy path is reached by any file still carrying retired panels or lights.

The editor holds the same line at the other end: **Add geometry** on a selected collision shape makes the primitive that draws it (`addGeometryFor`), copying the same five things `primitiveOf` copies, and a draw alone still produces a collision object and nothing else.
The look fields sit on the geometry panel alone; on a collision shape they edited a value `toLevelData` has never written for a collision object, which is a dial connected to nothing.

What this costs, stated plainly because it is the trade the decoupling makes: **a wall widened after it is dressed is widened twice** - there is no longer a single edit that silently means both.
The fix for when that bites is the **matched-outline link**, and it is an editor feature rather than a fallback in the format, which is what keeps the decoupling honest.
`GeometryObjectData.matchCollision` marks a primitive as MIRRORING a collision object in its own body, and the editor keeps the two outlines - `pos`, `rot` and `shape` - equal in **both directions** (`syncMatchedOutlines`, run from `markDirty` so every edit path flows through it without knowing the link exists): resize, move or turn either and the other follows.
The outline is still stated in full on both objects - the game and every loader read a matched file exactly as an unmatched one - and the partner is not named on disk: the editor re-finds the collision object with the identical outline at load, which the link's own invariant guarantees exists, so there is no index to go stale when a body's objects are reordered.
A hand-edited file whose halves have drifted snaps the look back onto the collision shape when the body has one collision object (the collision outline is what the level plays as), and drops the link rather than guessing when it has several.
**Add geometry** creates its twin already matched, since starting in step is what "give this shape a look" almost always wants; the `match collision` checkbox on the geometry panel is where the link is dropped to diverge the two on purpose, and ticking it back snaps the geometry onto the collision shape.
A matched pair follows its collision partner through **Ctrl+Shift+G** the way an anchor follows its shape - the pair is one authored thing, and a gesture about bodies must not break the link as a side effect.
`cli render3d`'s `matchedOutline` cases are the detectors, because none of this is visible in a picture: a level renders identically with or without the link, so a save that drops the flag or a sync that stops propagating is exactly the double-edit pain back again, behind a checkbox claiming otherwise.

A body is a `THREE.Group` carrying the interpolated pose, with one child per collision shape at that piece's `localOffset`/`localRotation` - rigid within the body, so written **once** at build.
The per-frame sync is therefore two writes per body into vectors it already owns; chain links go through one `InstancedMesh` with `count` set per frame rather than per-link `Mesh` churn.

Two rules are inherited from elsewhere rather than invented here:

- A **code-built circle is a sphere and an authored one is a disc**, which is the same split `lib/shapeGeometry.ts` makes about mass (`computeMass` versus `prismMass`). Drawing them by the rule they are weighed by is what stops a 4 cm hook being drawn as a 20 cm slab.
- A geometry object's `depth` is its own, and the migration seeded it from the collision object's **`thickness`** - so a migrated body is as thick as it weighs, and stays that way only for as long as an author wants it to. `thickness` is what a piece's MASS is computed from and is never read for the look again.

Authored colours are kept, but as a **tint with a brightness floor**: the levels were authored for a flat renderer where a body's colour *is* its appearance and most of them are near-black greys, so multiplying a stone texture by `#000000` leaves a hole where a wall should be. The hue is kept exactly and only the lightness is remapped into `TINT_FLOOR..1`, which preserves the authored ordering while leaving every surface enough albedo to show its grain and respond to the sun.

Areas stay on the 2D overlay in both modes - a killzone's skulls and a force area's arrows are flat marks on a region of *space* (see **Area glyphs**, and "pass-through geometry must read as pass-through" in `docs/game-design.md`).
Hook-only bodies do **not**: they extrude a quarter of a metre behind the plane, and in 3D that setback is the whole cue, so the grate lattice is drawn in 2D mode only rather than stamped flat over a body the scene has already put behind the level.

### Bodies and scene objects

A level is a list of **bodies**, and a body is a list of **scene objects**: a collision shape, a piece of 3D geometry, a light, or a chain **anchor**. Everything a body has exactly one of - what it collides as, its fill, its friction, a force area's magnitude - lives on the body; everything it may have several of lives on its objects, placed in the body's own frame.

That shape replaced three separate mechanisms at once, and each of them was working around the same missing thing:

- A **compound body** was a `group` STRING TAG on several flat entries, matched by name at load. It is now one body with several collision objects, so nothing has to agree about a tag and the properties a body has one of cannot be authored several times and then quietly collapsed onto the first member's (`syncGroupProps` is gone with it, and the editor's own "grouping" with it: an item carries the body it is IN, always, so "ungrouped" stopped being a state).
- **Decoration** was `collision: false` on a body-shaped entry - a shape that had to carry, and then ignore, every physics field. It is now a body with a geometry object and no collision object, so there is nothing to ignore.
- A **light** was its own top-level list with no parent, so it could not ride anything (see **Light and air**).

The body's **authored** frame and its **engine** frame are deliberately different points. The engine origin has to be the collision objects' combined centre of mass - every lever arm in the engine is measured from `globalPosition` - and it moves as pieces are added; the authored one has to stay put, or every offset in a body would shift whenever a piece was added to it. `buildLevelBodies` absorbs the difference once, at load (`BuiltBody.origin`), which is the same job the retired `resolveDecor` did for decoration and `buildSceneChains` still does for chain anchors.

A **geometry object** is the choice between the two ways a thing gets a look:

- `kind: "primitive"` (or absent) draws its own `shape` as a solid: a **rect is a rectangular prism**, a **circle is a cylinder** (three's own lathe rather than a 24-gon extrusion, so a barrel's highlight travels round it smoothly) and a polygon is that outline extruded. `depth`, `bevel`, `texture` and `tileScale` are its own; `depth` defaults to `DEFAULT_THICKNESS` on a body that collides and `DECOR_DEPTH` on one that does not, and `bevel` to none.
- `kind: "mesh"` replaces it with a named **GLB prop** from the manifest, placed by the object's own `x`/`y`/`rot` plus `z`, `rotX`, `rotY` and a dimensionless `scale`. It keeps the materials its own file carries **unless** the object names a `texture`, in which case it wears that instead - which is what lets a bare, geometry-only export (~20 KB) be dressed as the same stone the walls are made of, and what makes "a GLB **or** a primitive" the real choice rather than "a GLB or a textured primitive".

There is deliberately no third answer for "drawn by nothing": a body draws its geometry objects and nothing else, so an invisible wall is a body with **no geometry object**, which is also what an editor draw produces before anything dresses it.
A primitive with no `shape` at all draws the same unit placeholder an unfetched prop does - visible and obviously wrong, rather than silently absent.

`drawnObjects` (`render3d/bodyVisuals.ts`) is the whole rule and is one line - a body's geometry objects, in authored order - and it is exported so the claim can be checked without a GPU, a canvas or a DOM: a collision object never appears in it, however bare the body.

The **2D** renderer draws the other half - a body's collision shapes - so it must not also fill the primitive stating the same outline in the same place, which would lay the same colour down twice and darken every wall by its own opacity.
`collectDecor` is where that is decided: a form on a colliding body reaches the 2D pass only if it is **off that body's plane** (a backdrop welded into a swinging crate, which is what a welded `z` means), and a body that collides with nothing is drawn whatever its depth, nothing else in that view standing for it at all.
The 3D renderer needs no such rule, since it never draws a collision shape.

An **extruded solid is contained by the outline it states.** Three's bevel runs from the caps *outward*, so the old 2 cm default put every drawn body 2 cm proud of its own shape on all four sides - a floor slab taller than the collision box the ball rests on, seen as the ball sinking into the ground, and invisible to every check here because the sim was right throughout. `bevelOffset: -bevelSize` makes it a chamfer off the outline instead, and `cli render3d` asserts the bounding box against the authored size *with the bevel on*, which is the case the old size assertions could not make (both asked for `bevel: 0`).

`mountVisual` (`render3d/bodyVisuals.ts`) is the single place that choice is cashed out, and `BodyVisual` is now the ONE class for every body - a wall, a swinging crate, a backdrop 20 m behind the plane and a lamp with no fitting are all a body with objects in it. What used to be a second class for decoration is the case where the body built no engine body: its root stands at the authored transform instead of tracking one, and `sync` has nothing to do.

`material` and `thickness` stay **per collision object**, which is the one property a body does not have just one of: its mass, centre of mass and inertia are sums over its pieces, so a stone head on a wooden shaft is exactly what those sums are for.

Every length goes through `scaleObject` both ways.
Forgetting one is silent (the editor rewrites the whole file every 750 ms, so a dropped field is gone from disk before anyone notices it was read), which is why `cli render3d` asserts both round trips: the format's px → m → px, and the editor's `modelFromDisk`/`modelToDisk`, which goes through a different shape entirely. Both are compared over **flattened** placements rather than bytes, because a body's transform and its objects' placements are two halves of one answer and the editor legitimately re-origins a body onto its first object when it saves; a byte comparison would read that as a lost field.

**The retired flat form is still an input**, and permanently: the Godot extractor writes it, so `levelData.ts` arrives that way. `normalizeLevelData` folds every retired form - the flat entries, the `impermeable` kind, the `backgrounds` list and the top-level `lights` list - into this one, inside `scaleLevelData`, which is the one gate a level cannot reach the sim or the editor without passing through. It is **bit-identical by construction**: a migrated body's own origin is (0, 0, 0) and its objects keep the world placements the flat entries carried, so the centre-of-mass arithmetic reads exactly the numbers it read before, and a group's body is emitted where its first member sat so `World.add` stamps the same build index. The whole committed bundle corpus replays byte-for-byte across the change, which is the test that this is a re-shaping and not a rewrite.

### Light and air

`LevelData.environment` is an optional per-level block: sun direction and colour, hemisphere fill, how much generated environment is let in, and background.
Nothing in it is a length, so the whole block passes through `scaleLevelData` untouched - and anything added should keep that property, since a fog density in 1/metres is an inverse length and would have to be scaled the *other* way, which is a trap worth designing out rather than commenting on. `fogAmount` is that rule being applied rather than a hypothetical: it is a fraction at a depth the renderer owns, precisely so the block stays free of lengths (see **There is fog only where a level asks for it**).
Defaults reproduce the mood the game already had: `#1f2430` is both the sky and the page's letterbox colour, so the frame is not a window cut into a different game.

**All of that is the OUTDOOR answer, and a level may decline it.**
A directional light is a light at infinity, so it reaches every surface in the frame equally.
That is exactly what a sky does and exactly wrong underground: it lights a corridor and the rock around it the same, so nothing in the picture has an inside, and a scene meant to be below ground reads as a flat-shaded diagram of one.
`sunIntensity: 0` removes it outright - no `DirectionalLight` is created, so there is no 2048² shadow map rendered every frame for a sun that contributes nothing, and no sun lobe in the generated sky.
`envIntensity` near zero takes the ambient with it, and it has to: turning the sun off alone leaves the image-based lighting still washing every surface from every direction, which is the same flatness one step dimmer.

What lights the level instead is a **light object** (`LightObjectData`, `render3d/lights.ts`): a point or spot light with a placement, a colour, an intensity and a **reach**, sitting inside a body like any other scene object.
Falloff is inverse-square with a hard cut at the reach, and that falloff is doing three jobs a flat renderer needed a hand-authored gradient for:

- **It says where the play space is.** A lamp near the gameplay plane lights the plane; parallax decoration 20 m behind it is far outside the same lamp, so the background darkens on its own and stays readable as background.
- **It frames.** Geometry in *front* of the plane is out of reach too, so a pillar or wall drawn over the level reads as a black silhouette rather than as a lit object in the way. This is the reference look's left-hand edge falling to black, and it costs nothing to author beyond a `z`.
- **It is depth.** Two walls at different depths are lit differently by the same lamp, which is the cue the deliberately narrow FOV takes out of the picture.

The consequence for authoring is that **`range` is the field that shapes the look, not `intensity`**.
Past a couple of metres a brighter lamp is barely a wider pool, and where the light *ends* is where the lit part of the level ends.

**A LIGHT IS IN A BODY, and that is the whole mechanism.**
A lamp is two things - a fitting the player can see and a light they cannot - and the difficulty has always been keeping them together.
They were once *two authored objects at the same point*, a shape carrying an emissive colour and an entry in a top-level `lights` list beside it; either alone was a specific kind of wrong (a light with no emissive is a room lit by nothing visible; an emissive with no light is a lamp that does not work) and nothing kept the pair in step, so moving the sconce left its light behind.
The patch for that was to **derive** a light from the glowing shape, out of seven more fields on the visual describing a light in a second vocabulary - its reach, its cone, its aim, its shadow, its flicker - plus a re-placement pass that measured a prop's bounding box once its GLB arrived, so the source could be pushed clear of the face it shone out of.
All of it is gone.
A light object in the same body as the fitting is a **child of the group that body is drawn in**, so it rides that body's pose for nothing at all: a lantern welded into a swinging crate swings with its light, and there is no per-frame transform in the light rig. One authored thing cannot disagree with itself, and this time that is structural rather than derived.

Emission is therefore **appearance and nothing else**: `emissive`, `emissiveIntensity` and `emissiveTexture` on a geometry object say that this thing reads as bright, and three.js has no global illumination, so they reach nothing. What lights the room is the light object beside them. That separation is what makes both halves say what they mean - a deep-orange flame that lights a whole room is a dim emissive and a wide, bright light, which the fused version could only reach by fighting one knob against the other.

Two things follow for authoring, and both are the light's own fields rather than a second spelling of them.
A **spot** is what a wall fitting wants: it has a real **distance**, so `range` is a hard edge and the light ends where the author says the room does (an area light has no cutoff at all, and a point light's is a sphere in every direction, including back through the wall the lamp is bolted to), and its shadow is **one render** where a point light's is a cube of six - which is why a lamp can occlude at all.
Its **aim** is authored in the object's own frame, so `rot` turns the beam and the lamp and its light cannot end up pointing different ways; `angle` and `penumbra` shape the cone.

`LIGHT_BUDGET` (16) caps how many lights burn at once and `LIGHT_SHADOW_BUDGET` (4) how many of those occlude, both spent in authored order - by body, then by object within the body. The count budget exists because a light stopped being a scarce top-level thing and became an object anybody can drop into a body: a corridor authored as thirty identical sconces is now an easy thing to write and an expensive thing to draw.

One thing the cone gives away, worth knowing before authoring: a spot lights **what it points at and nothing else**.
A lamp close to the wall behind it throws a small circle rather than a wash - the pool's radius is the distance to the surface times the tangent of the cone angle - so a lamp meant to light a room wants either a wide angle, some distance from what it is lighting, or an aim along the plane rather than into it.

A trap that has already been paid for once: three seeds a `SpotLight`'s position at `Object3D.DEFAULT_UP` rather than at zero, so a light left as constructed sits **a metre above** the fitting it belongs to. `LightRig` zeroes it explicitly, and `cli render3d`'s aim case is what caught it - the level renders either way, and a light in the wrong place is a level that is simply lit somewhere else.

**Shadows are the asymmetry to budget for.**
A directional light's shadow is one render of the scene into an orthographic map; a point light's is a **cube**, six.
A corridor of eight shadow-casting torches is forty-eight shadow passes a frame, which announces itself only as the frame rate quietly halving.
So `castShadow` is opt-in per light and capped at `LIGHT_SHADOW_BUDGET` (4), spent in authored order; past the cap a light still lights and simply does not occlude, which is a much smaller lie than it sounds, since most of what a torch contributes to a wall behind a crate is bounce that none of this models anyway.

`flicker` is render-only and driven by the **wall clock**, exactly like the force areas' drifting arrows, so it can never reach the fixed-step sim.
It is *handed* a clock rather than reading one, because `cli shot --3d` pins it (`Scene3D.pinClock`): a screenshot whose lighting depends on when it was taken is evidence of nothing, which is the same reason that command already waits for every asset before it draws.

**Intensity is the one number in the level format that does not convert between the file's pixels and the sim's metres**, and it is worth knowing why rather than discovering it.
A point light's brightness is candela, which is an irradiance times a distance *squared*, so a field converted with the rest would have to be converted as the **square** of the factor.
Rather than carry the one field that scales differently from every other, it is defined against the sim's metres and passes through untouched.
A round trip cannot see the difference between that and scaling it by the factor and back - the same blind spot `tileScale` has - so `cli render3d` asserts it one way, alongside the light list's px → m → px trip and the editor's.
It also asserts that emission is part of the material **cache key** (`surfaceKey`), because getting that wrong is invisible in every other check: the level renders, every round trip passes, and whichever of two shapes was built first wins, so either every wall of that stone glows or the lamp made of it does not.

Lights are authored on their own **editor layer** (see **Layers**), with `+Light`; the item's circle *is* the reach, so the radius handle authors it and the ring on screen is the volume rather than a drawing of one, and the item's colour *is* the light's colour.

The ring is drawn at the reach **on the gameplay plane**, not at the authored `range`, and that is what gives `z` any feedback at all.
A light has no geometry, so moving one through z changes nothing on the canvas and nothing in the 2D overlay; the field reads as doing nothing until the 3D view is consulted, and at small values its effect on the lighting is subtle enough to look like nothing there too.
The authored reach is a **sphere**'s radius and the level is a plane through it, so what the level actually receives is `sqrt(range² - z²)` (`lightPlaneReach`), which shrinks visibly as the lamp is pulled toward the camera and closes entirely once it is further off the plane than it reaches - a reachable authoring mistake that is otherwise silent, and one the label names outright as `MISSES PLANE`.
The authored `range` stays on screen as a fainter outer ring whenever the two differ, so shrinking one does not hide the other.
`cli render3d` asserts the arithmetic, since it is the only feedback the field has.
`levels/ball.json` is the worked example: sun off, environment near zero, small emissive discs throwing their own warm light, and a `LightData` where there is nothing to see - the cool spot, and the fill that has no fitting.

**There is fog only where a level asks for it.** That is the arrangement the removed version should have had.
As a default it muted every distant surface at exactly the point where the authored textures and the environment started giving those surfaces something worth seeing, and depth was already being said by parallax, by the sun's shadow, by the environment's own gradient and - in a level lit from inside - by the lights' own falloff, which darkens a distant layer more exactly than a fog density ever states it.
None of that is an argument against a level ASKING for air, so `fogAmount` (with `fogColor`, defaulting to the background) authors it per level and `levels/ball.json` is the worked example at 0.2.

Two things about the shape of it are the whole feature, and neither is visible in a picture - a fog measured over the wrong distance still renders a perfectly plausible hazy scene, just not the one that was authored.

**It thickens with distance from the CAMERA**, which is what air does: every surface in the frame is behind some of it and one further back is behind more. `THREE.FogExp2` is that law directly, so the density is a property of the air rather than of where the level happens to be, nothing is re-anchored per frame, and the picture cannot disagree with itself about which of two surfaces is further away.

It was briefly a **linear fog pinned to the gameplay plane**, on the argument that the plane sits ~16 m from the camera (zoom is dolly distance) so a camera-relative fog thick enough to see also tints the plane itself. That is true and it is not a defect - the plane IS 16 m of air away, and a fog starting exactly at it draws the level's foreground props (3 m in front) and the plane at the same haze as each other, which is none. Pinning also made the fog a function of the zoom, so a camera region that pulled back carried the fog with it: the air thinning as you zoom out, which is the wrong way round. The cost of the current form is the same statement pointing the right way - zooming out puts more air between camera and level, so a pulled-back region is hazier.

**The authored number is a FRACTION, not a density**, and that is the trap the environment block's own comment names being designed out rather than commented on. A density is in 1/metres - an inverse length, which would have to be scaled the *opposite* way from every other number in the file. `fogAmount` is instead how much of the fog colour a surface `FOG_REFERENCE_DISTANCE` (20 m, about where the gameplay plane sits at the ball level's zoom) from the camera takes on, so it passes through `scaleLevelData` untouched like the colours and the sun direction, and the metres live once, in the renderer. `fogDensity` is that one conversion, and `cli render3d` asserts both ends of it without a GPU - the round trip at the reference distance, and that the fog actually rises with depth and is zero at the camera.

Measured on the ball arena at 0.2: 0.73% RMSE over the frame - 10% of haze on the props in front of the plane, 14% on the plane, 18% on the scenery behind it.

**There is an environment, and it is generated.** A `MeshStandardMaterial` gets its specular response from what it can reflect, so with lights alone there is nothing in the world to reflect but one directional sun: a roughness map has almost no visible effect and a metal - which is nearly all reflection - renders as a dark, dead shape. The chains hanging in the ball arena were exactly that.

`equirectEnvironment` paints a small equirectangular sky from the level's OWN colours - the hemisphere's sky and ground either side of a soft horizon, plus a warm lobe where the sun is - and `PMREMGenerator` convolves it into the mip chain a rough surface samples. No asset, nothing to download, and it cannot disagree with the fog and the fill about what colour the air is. It is a **float** texture because the sun lobe is several times brighter than the sky, which is the range an LDR image cannot hold: clipped, the highlight it puts on a metal is the same white as the sky around it. Directional for the same reason - a uniform environment is indistinguishable from ambient light and puts a highlight nowhere.

Image-based lighting contributes **diffuse as well as specular**, so the hemisphere fill comes down to meet it (`FILL_WITH_ENV`) rather than the two stacking: measured over the ball arena, the frame's mean brightness moves 0.1304 to 0.1353 - under 4% - while the chains go from nearly invisible to reading as forged metal. `ENV_INTENSITY` is 0.6 rather than higher because past that the dielectrics start losing the sun's directional shading, which is the contrast the fill was tuned for in the first place.

`Scene3D` rebuilds it only when the authored environment actually changes (`envKey`). The lights and the fog are cheap to rebuild and the convolution is not, and the editor reconstructs its scene on every model revision - every drag - none of which changes the sky.

**Or a level names a CAPTURED one instead** (`EnvironmentData.hdri`, a key into `HDRI_ASSETS`), and then that is what it is lit by: a real high-dynamic-range photograph of a real sky, convolved by the same `PMREMGenerator` into the same mip chain.
What it buys is everything a sky has that a vertical gradient with a lobe in it does not - a horizon with a shape, a bright side and a shaded side, bounce off whatever the ground is made of - and what a surface reflects is the whole of that rather than a smear.
Measured on the ball arena with the sun and the fill both at zero, so the environment is the only light in the frame: the generated sky is a brown murk and `golden-gate-hills` lights the same walls as sunlit wood with the ball reading as metal, 1,409,900 pixels of a 2,073,600-pixel frame changed.
It is a per-level choice and not the default because it costs a download; a level that names none is dressed by arithmetic exactly as it always was, and a level naming a sky **this build does not have** is too - the fallback is the generated sky, byte-identical (0 pixels differ), which is the rule an unknown `texture` already follows.

Three things about it are worth knowing before authoring one.

The **sun is unchanged by it**. An environment map is light from every direction at once, so it has no shadow to cast: the hard shadow that says a level is outdoors is still the `DirectionalLight`, and the two agree about where the light comes from only if you point them the same way. `hdriRotation` turns the sky about the vertical axis and the `sun dir` fields turn the light; turning the sky alone visibly relights the scene (at 90° the arena's walls go from sunlit to backlit) while its shadows stay where they were.

A captured sky is usually **brighter than the generated one** - this one's mean linear luminance is 0.72 against the low tenths a level's own colours produce - so `env ×` is the knob that lands it, and a level that switches from generated to captured without touching it is a level that got brighter.

And the **hemisphere fill now says something the sky already says.** `FILL_WITH_ENV` drops it to 0.7 for having an environment at all, which was tuned against the generated one; a capture carries its own sky-above-ground gradient, so the fill is a second, flatter copy of it. Nothing here reduces it automatically - a hidden rule is worse than a knob - but `fill ×` is the first thing to take down if a captured level looks washed out.

**The capture may also be the visible BACKGROUND** (`hdriBackground`), and it is off by default because the two jobs want different resolutions. The reflection is convolved down to a 256-wide mip chain, so 1k is ample and anything more is thrown away before a surface ever reflects it; the background is magnified by the deliberately narrow lens (~34°, so ~100 px of a 1k equirect stretched across 1920) and is visibly soft. It is a level decision, so the flag is authorable and a sharper one is a re-optimise at `--size 2048` or 4096 rather than anything in the renderer. The generated sky is never drawn as a background at all: it is a 128x64 gradient built to be convolved, and stretched across the frame it is a wash of colour with a band in it.

Two mechanics keep it from flickering or leaking. The load is **cached and shared**, and taken SYNCHRONOUSLY when it is already decoded (`loadedHdri`), because a scene rebuilt mid-drag that starts on the generated sky and swaps a frame later is the level's whole lighting flickering once per rebuild. And a load that lands after its `Environment` was disposed is **dropped** rather than written over whatever replaced it - a level change builds a new environment into the same scene, so a slow sky arriving late would otherwise light the level after it.

It is authored in the editor's Environment panel: `sky hdr` picks from the manifest (so a sky added to the store is a sky the panel offers, with nothing in the editor to edit), `hdr °` turns it and `hdr bg` draws it behind the level. Choosing the generated sky drops all three fields rather than writing an empty one, and choosing it on a level that authors no environment block mints none - opening the panel is not authoring.

Tone mapping is ACES, which is what gives the sun range to work in; the vignette is drawn on the **overlay canvas** as one gradient fill rather than as a post-processing pass, because a vignette is a screen-space multiply over the finished frame and the overlay is already exactly that.

The GLTF loader is imported dynamically, so it lands in its own chunk and is fetched only by a page that actually loads a prop.

### Surfaces

A surface comes from one of two places and a level cannot tell which, because both are keyed into **one namespace** that `surfaceFor` looks up authored-first:

- **Generated** (`TEXTURE_SETS`), keyed by the `MATERIALS` names the format already has, so naming the stuff a thing is made of is all it takes to get a sensible surface - a geometry object's `texture` takes a material name as readily as an authored set's, which is what the migration wrote onto every primitive it made. The maps are value noise → albedo, a height-derived normal map and a roughness map from the same field: one height field driving all three is what makes them agree - a dark patch of grain is also a dip and also a rougher spot, as it is on the real material - for a few hundred bytes of code and no download.
- **Authored** (`TEXTURE_ASSETS`), a real PBR set: **base, normal, roughness, metallic, ambient occlusion and emission**, each optional, each a `.webp` fetched from the release store and pinned by `sha256` exactly as a prop is. Channels are three.js's, which are glTF's: albedo and emission in sRGB (they are pictures) and everything else linear, roughness read from green, metallic from blue, AO from red and from the same UV set as everything else (there is only one).

That the two share a namespace is the point of the arrangement: replacing a generated surface with an authored one is **adding a manifest entry under the material's own name**, and every level already naming that material picks it up with no edit at all. An unknown name still lands on a generated surface, so a hand-edited level naming a texture this build does not have looks ordinary rather than invisible.

A **scalar map's channel is not a detail**: roughness, metallic and AO are one number per texel, three.js reads them from green, blue and red respectively, and texture libraries commonly ship the number in red alone. Handing three.js the file as it arrives therefore samples an empty channel and reads 0 - and roughness 0 is a mirror, which looks exactly like the texture not being applied rather than like a channel mistake (`factory_brick`'s roughness shipped this way and was invisible until its channel means were measured). `assets:optimize-texture` flattens every scalar map to grey, and `cli assets` measures the shipped files' channel means to say it happened; a normal map is never flattened, its channels being a vector.

**An emission map is where a surface glows**, as against how much - lit windows in a dark wall, cracks in cooling slag, a strip along a machine, none of which a flat emissive colour can say at all.
It is a picture like the albedo, so it is sRGB and encoded lossy; three.js multiplies it by the material's emissive colour, which means the default black renders the map as *nothing at all* and looks exactly like the map having failed to load.
So a surface carrying one is given a white emissive unless the geometry object names a tint. What it does NOT do is light the room: emission is appearance, and what lights is a light object in the same body (see **Light and air**).

A geometry object may also **borrow another set's** emission map with `emissiveTexture`, which is how a brick wall gets lit windows without the brick becoming a different surface: the base stays whatever it was and only the emission slot comes from elsewhere, tiled by the capture size of the set it is *in* at this shape's `tileScale`, so life size means the same thing for both pictures.
Two rules hold it together.
The emission slot has exactly **one owner** (`dressEmissive`) rather than being written by the general dressing as well - two async paths writing one slot is a race whose winner is whichever image arrived first.
And an unknown key resolves to **no map** rather than to a fallback surface's, which is the one place the texture resolution rules deliberately differ from `texture`'s: an ordinary wall is a fine answer for a missing surface, and a borrowed glow the author never asked for is not.

Authored surfaces are also **not tinted by the body's fill colour**, and that exception is why the tint exists at all: it carries the flat renderer's "colour IS appearance" onto generated noise, which has no colour of its own to defend. A photographed brick does, and multiplying it by the grey somebody typed to mean "this is a wall" makes it darker, flatter and less saturated - the opposite of what the photograph was added for.

An authored set is **drawn in its generated fallback until its images arrive** and then swapped into the same material object, so a level dressed in real textures is never a scene of white boxes on a slow connection, and a map that fails to load leaves that one slot generated rather than the surface missing. `roughness`, `metalness`, `normalScale` and `aoIntensity` on the set are multipliers over whatever the maps say - and with no map, they *are* the value, which is why a set with no metallic map defaults to metalness 0 rather than three's 1.

**Tiling is a length in the manifest and a multiple in the level.** The extruder writes its UVs in **metres** (`extrude.ts`), so one repeat covers a world distance rather than a fraction of a face: two walls of the same stuff show the same brick and only the count differs, whether they are 0.4 m or 40 m long.

Which distance is a **fact about the texture**, and lives once, in the manifest: `TextureAsset.tile` is the size the surface was captured over in metres (Poly Haven publishes it per asset - `factory_brick` is 1.5 m). A geometry object then says only how large it wants it, as a **dimensionless multiple** of that: `tileScale`, 1 (and absent) being life size, 2 twice as large. `tileMetres(name, scale)` is the one multiply, and the editor readout, the material and `cli render3d` all take their answer from it.

Authoring the multiple rather than the metres is what makes `1` mean the same thing everywhere and keeps meaning it after a texture is swapped for one captured at a different size - where an absolute value in every level would silently become wrong. It is also why `tileScale` is one of the two fields `scaleObject` must NOT touch (with `scale`): a dimensionless number scaled on the way in and back out again is the identity, so the round-trip case cannot see the mistake and `cli render3d` asserts the non-scaling directly instead.

**Where the pattern starts** is the other half, and it is a length: a geometry object's `tileOffsetX` / `tileOffsetY` shift the texture in level coordinates (+x right, +y down), in scene pixels on disk - which on this project's scale is centimetres exactly, 100 px to the metre. It is what lines a course of bricks up with the edge of the wall it is on rather than with the world origin, and it moves the pattern only: the collision geometry, which the shape's own `x`/`y` would have moved, stays put. Measured in world distance rather than in repeats, so it means the same thing at any `tileScale`.

`applyTiling` is the one place both land on a texture (`uv * repeat + offset`), and the y sign is the extruder's negation into three's frame showing through - u shifts back where v shifts forward.

**A side wall's texture has to stand up the way the cap's does**, and which of the wall's two axes is `u` is what says so.
A wall has one axis along the edge it was extruded from and one through the depth, and a texture's own `u` is horizontal - so handing `u` to the along-edge distance on a **vertical** edge maps the picture's horizontal onto world-vertical and lays every brick on its end.
That is the left and right returns of every wall, pillar and doorway in a level, which is most of what an author sees of a solid that is not face on.
`generateSideWallUV` picks by the edge's own direction instead: a horizontal-ish edge gets `u` along the edge and `v` through the depth, a vertical-ish one gets them the other way round.
Three's own `WorldUVGenerator` branches for exactly this reason and gets the other half wrong - it reads `u` straight off whichever of x and y varies more, so a 45° wall is tiled by its projected extent and its texture is squashed by `1/sqrt(2)` - which is why the distance is still measured **along** the edge here, and a repeat is a metre of surface travelled at any angle.

Both axes are anchored in the body's own frame rather than at whichever corner the quad starts from: the along-edge run stands in for world x or world y, and the depth reads zero on the **gameplay plane** (`metreUVs` takes the offset `extrudeOutline` is about to translate by).
So a course of bricks crossing from a cap onto a return does not jump, a `tileOffset` means the same thing on both, and re-authoring a wall's `depth` does not slide the texture on its returns.
`cli render3d` asserts all three - upright, continuous, and measured along a diagonal rather than across it - because none of it is visible to anything else here: the solid is the authored size, wound the right way and lit correctly whichever way its texture is turned.

The resolved size and offset are part of the material cache key, because `repeat` and `offset` live on the *texture* rather than the material: two tilings are two `Texture.clone`s sharing one uploaded image.

`cli render3d` asserts the resolution rule directly (`surfaces: …`) - authored beats generated, a material name still resolves to its own surface, an unknown name falls back, and each side's tile is its own - because it is pure arithmetic over the two manifests, and because getting the precedence backwards is invisible: every level goes on wearing perfectly presentable noise while the downloaded maps sit unused.

### The asset store

Four kinds of binary: props (`.glb` under `public/meshes/`), authored texture maps (`.webp` under `public/textures/`), the water renderer's raw maps (`public/water/`) and captured skies (`.hdr` under `public/hdri/`).
Every one of those directories is **gitignored**: the bytes live in a permanent GitHub Release (tag `assets`) on this repo and are fetched at build time (`bun run assets:fetch`, run by the Dockerfile before `bun run build`).
They are the only binaries this tree has - every other surface is generated in code - which is why they carry a process the rest of the project does not need.
`storedAssets()` (`scripts/assetStore.ts`) flattens all four manifests into one list of files, and the fetch, the budget, the sha check, the basename-collision check and the orphan sweep all iterate **that** rather than a manifest, so no kind can be checked while another quietly is not.

**Not git, and specifically not Git LFS**, because an asset has to be **deletable**.
A binary in git history is permanent, and an LFS object pushed to GitHub goes on consuming the quota after the file is removed - the only supported purge is deleting the repository, which is not an option for a repo with a deploy wired to it.
A release asset is one `gh release delete-asset` away.
Being able to change your mind about a prop is worth more here than anything git gives you for the bytes.

The trade, stated once: **deleting an asset breaks builds of old commits**, whose manifest entries name bytes that no longer exist.
That is the direct cost of deletability, and the failure is loud (the fetch stops the build) rather than a quietly different-looking game.

The tag carries no version meaning - it is a file store that happens to live on GitHub, flat, keyed by the basename of `MeshAsset.file`.
Each entry pins a **`sha256`**, because a release asset can be replaced in place: the hash is the only thing that says *which* boulder a given revision of this repo meant, and both the fetch and `cli assets` verify it.
Nothing in the chain is authenticated - the release is public, and a token would have to reach the Docker build as an `ARG`, where it is readable by anyone who pulls the image.

They are also the one thing here that gets **worse silently**.
A level renders identically whether its props are 40 KB or 6 MB, every test stays green, and what changes is how long the first frame takes and how much of the LFS bandwidth quota a month of CI spends - neither of which anybody reads off a build.
So three things are asserted rather than advised.

**A budget, in the suite.** `cli assets` holds the whole directory to **100 MB**, and any single file to **8 MB**.
The store imposes nothing worth budgeting against - a release caps one asset at 2 GiB and neither total size nor download bandwidth at all - so the bar is an engineering one and has to be argued rather than quoted.
Two things pay for these bytes: the Docker image the VM pulls on every deploy, since props are baked in at build, and the time a level takes to dress itself once it is open.
100 MB is roughly where the image stops being something you rebuild and redeploy without thinking about it, and at ~1 MB a prop that is a hundred-odd props - a lot more level than exists.
It is deliberately **not** a quota, so raising it is allowed; do it by deciding those two costs are worth paying, not because the number was in the way.
The per-file bar is not a target to author up to - a textured prop in this game's style is well under 1 MB, and 8 MB is what catches a raw Blender export with 2k PNGs in it before that becomes the habit.

**A pipeline, pinned - one per kind.** `bun run assets:optimize <in> <out>` runs `gltf-transform` with the settings recorded in `scripts/optimize-asset.ts`: meshopt for geometry, WebP textures capped at 1k, and **no mesh simplification by default** - decimation changes the silhouette, the silhouette is what this look is made of, and that is not something a build step gets to do quietly to every prop that passes through.

What that argument does not justify is refusing decimation outright, which is where this stood until a 3 x 3 m background wall panel turned out to be carrying **134,041 triangles**.
`sewer-wall` and `sewer-arch` are a UE5 **Nanite** set: authored for a renderer that streams its own level of detail, dropped into one that has none and draws every triangle.
The ball arena stands four of each two metres behind a gameplay plane it views almost orthographically, so 768k triangles - **95% of the whole scene** - were background scenery, which water's transmission pass then drew a second time on every frame it was visible (see **Water**).
At a tenth of the triangles the same frame differs by 1.5% RMSE, because the brick relief that reads on screen is in the normal map; the geometry was buying self-shadowing at grazing angles and very little else.

So `--simplify <ratio>` is **opt-in, per asset, and recorded**: `bun run assets:optimize in.glb out.glb --simplify 0.1`, with the ratio stored in that prop's `MESH_ASSETS` entry beside its sha256.
Recording it is not bookkeeping - it is the one fact about the shipped bytes that cannot be recovered from them, since a decimated prop and a prop modelled at that density are the same file.
Without it the raw in `assets-src/` cannot be re-optimised into the same asset, and the next person to run the pipeline over it silently ships the full-density mesh again.
The error budget is fixed at 1% of the mesh's own extent so the ratio is what binds; a tight one quietly stops the decimation early and reports success, which reads as the flag not working.

The rule of thumb the sewer set establishes: **check a prop's triangle count against what it is for.** `gltf-transform inspect` prints it. Background parallax geometry wearing a normal map wants thousands, not hundreds of thousands, and an asset advertising Nanite, ZBrush or photogrammetry is one to measure before believing.
Typically 5-10× off an unoptimised export, looking identical.

`--center` is the same shape of flag about a prop's **origin**, and it is opt-in and recorded for the same reason.
`mountVisual` does not recentre a prop, which is deliberate: a pivot at a cage's base or two thirds of the way up a doorway is information about the prop, and a level places it by that point.
What that assumes is that the origin is somewhere on the prop at all, and an asset exported out of a level rather than modelled as a prop carries the world coordinates of wherever it stood in that level instead.
`metal-bars` arrived with its geometry 8.9 m from its own origin, which places as a prop that is most of a room away from where it was put - read as the prop having failed to load rather than as a pivot.
The flag runs `gltf-transform center --pivot center` into a temp file the optimise then reads, and `center: true` goes in that prop's `MESH_ASSETS` entry beside its sha256: a centred prop and a prop modelled about its own centre are the same file, so without the record the raw cannot be re-optimised into the same asset.

**A model PACK is one file and several manifest keys**, and `bun run assets:extract <pack.glb> <out.glb> <Node>=<prop-name> ...` is the step in front of the pipeline that makes one.
A pack shares its materials, and a texture set is the overwhelming majority of a prop's bytes: the 24 rocks of `pbr-rock-cliffs-pack` are ~20 KB of geometry each and 370 KB of 1k maps they all have in common, so one file each is 9.4 MB of which 8.7 MB is the same three images written out 24 times - paid again on every download, and again in VRAM, each time a level scatters more than one of them.
Extracted together they are one **624 KB** file, one fetch and one GPU upload however many of them a level uses.
`MeshAsset.node` is what addresses one: several entries name the same `file` and each names its own node inside it, `loadMesh` caches per FILE rather than per key, and `storedAssets()` lists that file once so the fetch, the budget and the basename-collision check all see one thing rather than 24 of it.
Extraction is a step of its own because it is the one that takes decisions - which nodes, and what each prop is called - and because a pack is only re-extractable if the node name behind each prop is written down, which the prop's `MESH_ASSETS` entry is where it is written.
It also bakes each node's WORLD rotation and scale into its vertices (a Sketchfab/FBX export wraps the pack in the centimetres-to-metres scale and the Z-up-to-Y-up rotation) and drops the translation that is the prop's place in the pack's layout, so what comes out is in metres, Y-up, on its own origin, and needs no `scale`/`rot*` in 24 entries that would each have to agree.
`assets:optimize --keep-nodes` is **not optional** for one: the optimiser joins meshes that share a material by default, which for a pack means every prop welded into a single object with no name left to address.

`bun run assets:optimize-texture <in> <out.webp> --map <base|normal|roughness|metallic|ao|emissive> [--size 1024]` is the same argument for a texture map, through ImageMagick (which this repo already asks for, to turn an SVG snapshot into a PNG - adding a native image dependency to a project whose only binary is its assets would cost more than it saves).
The `--map` is not bookkeeping, it picks the **encoding**: an albedo and an emission map are pictures and go to lossy WebP at q90, while a normal, roughness, metallic or AO map is **data** - a vector or a number per texel - so it is encoded **lossless** and resized in linear space. A lossy codec's ringing around an edge is not a softer picture there, it is a surface that shades wrongly, seen as shimmering highlights along every crack; an sRGB-aware downscale of a roughness map averages numbers as if they were brightnesses and brightens every one of them.
1k is the ceiling for the same reason the prop pipeline caps its textures there.

`bun run assets:optimize-hdri <in.exr|in.hdr> <public/hdri/name.hdr> [--size 1024] [--exposure 1]` is the third pipeline, for a captured sky (see **Light and air**), and it is the one that does **not** go through ImageMagick.
The format choice is the point of it: Poly Haven ships half-float EXR, which for a 2k sky is 24 MB - a quarter of the whole budget for one image nobody looks at directly - while Radiance RGBE carries one shared exponent per pixel instead of three and the same sky at 1k is 1.6 MB, giving up a mantissa of 8 bits per channel where the convolution averages thousands of texels into every sample anyway.
ImageMagick reads the EXR correctly and its Radiance **writer does not round-trip**: the mean linear luminance of this sky comes back 2.9 million times what went in, and the per-pixel ratios are not consistent with each other, so it is not even a scale factor that could be divided out.
A sky wrong by a constant is a level lit wrongly and a sky wrong per pixel is a level lit by noise, and neither announces itself as anything but "the lighting looks off" - so the script decodes with three's own `EXRLoader`, resamples by **area averaging in linear light** and encodes RGBE itself.
Both of those are load-bearing rather than fastidious: a Lanczos or Mitchell kernel rings around a discontinuity and the sun in this sky is 130,000x the mean, so the halo around it is *negative* radiance several times brighter than anything else in the picture; and three's two loaders disagree about row order (`EXRLoader` reports `flipY: false`, `HDRLoader` `flipY: true`), so a conversion that does not reverse them is a level lit by its own ground.
The script **prints its own round trip** - source, resampled and re-decoded mean and peak luminance - because an encoder nobody checks is one that silently stops being one; this sky converts at +0.10% mean and +0.18% peak.
`--size` is the equirect's width and the height is half of it; 1k is ample for lighting and too soft for a visible background (see `hdriBackground`).

Both format choices are about what has to be **paid at runtime**, and this is the trap the pipeline was written around: an optimisation that lands in a glTF's `extensionsRequired` is not a smaller read, it is a file the loader **refuses** - and the prop falls back to its placeholder box, which is a silent failure by design.
So meshopt comes with `setMeshoptDecoder` wired into `gltfLoader()` (~25 KB, ships with three, rides the same dynamic import so a page with no props still fetches neither).
Textures are **WebP rather than KTX2** for the same reason twice over: KTX2 needs the external `ktx` binary at build time *and* `KTX2Loader` plus its transcoder at runtime, where WebP needs neither - three.js reads it through `EXT_texture_webp` - and is within a few percent on disk.
What KTX2 buys is staying compressed in **VRAM**, which is a decision for when there are enough props for VRAM to be the constraint rather than download size. It is not now.

**CC0, or it does not go in the store.** The release is public, so an asset in it is a standalone, reusable copy of that file on a stable URL - which is redistribution however internal the intent, and is exactly what a stock-asset licence like Poliigon's forbids while permitting unlimited use of the same texture *in* a project. The distinction is not the purpose, it is whether the bytes are obtainable as bytes.
Serving the same maps from the deployed game is the ordinary end-product case and is not the same thing; hosting them next to no product is.
So anything that ships through this pipeline comes from a CC0 source (Poly Haven, ambientCG) - which costs nothing at this art style's quality bar - and a licensed asset stays off the manifest entirely. If one is ever genuinely needed, the shape of the answer is a private store with a build-time secret, not a quieter public one.

**Provenance, in the manifest.** `MeshAsset`, `TextureAsset`, `HdriAsset` and `RawAsset` all require `source`, `author` and `license`, and `cli assets` fails without them. It is per ENTRY rather than per file, so a texture set is credited once as a surface however many of its six maps it ships.
The file is opaque and the licence lives on a web page nobody revisits, so a binary with no source is a liability rather than an asset - a year later "can this ship" has no answer but "delete it and remodel".
`author` is separate from `source` because a licence like **CC-BY obliges you to credit a person**, and a link to the page you found it on is not that.

`CREDITS.md` is **generated** from those fields (`bun run assets:credits`) and checked against them by `cli assets`, so it cannot drift.
Attribution is a licence obligation, and a hand-kept credits list is one that gets forgotten on exactly the day the asset is added - a violation that looks like nothing at all. The manifest is the file you cannot avoid editing to add an asset, so the credits derive from it - props and surfaces under their own headings.
Note that the generated file discharges the *record*; a CC-BY asset shipping in the game also wants that credit reachable by a player, which is a UI decision rather than a tooling one.

A grab through `cli shot --3d` **waits for every asset** before it draws (`assetsSettled`), and that is not a convenience: a screenshot that races the loads photographs whichever props and maps happened to have arrived, so the same command produces the placeholder box one run and the real prop the next - evidence of nothing. The game deliberately does not wait, since the placeholder and the generated surface exist precisely to cover that gap.

`cli assets` separates five failures because they have five different fixes: a manifest key with no **file** (usually an unfetched clone, but also what a deleted release asset looks like - in game it draws the grey placeholder, which is deliberate and therefore easy to ship without noticing), a **stale** file whose bytes are not the sha256 its entry names, two entries **colliding** on a basename (one flat namespace in the release, so the second would overwrite the first), an **orphan** file no entry names (bytes in the budget nothing can draw), and a **missing licence**.
It is not part of `cli render3d`, which is deliberately pure - no GPU, no canvas, no level, and no filesystem.

**A prop's own emission needs waking.** glTF's default `emissiveFactor` is black and three.js multiplies the emission map by it, so a prop exported with a beautiful emission map and no factor - which is what a modelling tool will happily write - renders exactly as if the map were not there, and looks like a texture that failed to load rather than like a value that is zero.
`wakeEmission` lifts that one case (a map, and a factor that is exactly black) to white on load; a prop that authors any emissive colour of its own is left alone, and one with no map is untouched.
It is the same rule `surfaceFor` applies to this project's own texture sets, which is the point - a prop and a surface that both ship an emission map should not need different knowledge to light up.
What it does **not** do is light the room: emission is appearance, and what lights is a LIGHT OBJECT in the same body (see **Light and air**), never a prop's materials - reading a light's colour, reach and aim out of a picture is guessing at all three.

The cheapest prop is still the one with **no textures at all**: a `.glb` exported bare and given a `visual.texture` wears that surface (`mountVisual` assigns it over the file's own materials), so a boulder can be ~20 KB of geometry wearing the same stone the extruded walls wear - which also makes it look like it belongs to the level rather than like an import. A prop that names no texture keeps the materials it was exported with.

The output directories and the split that matters: `public/meshes/`, `public/textures/`, `public/water/` and `public/hdri/` are **build output** - only ever the optimised copy, only ever written by `assets:fetch` or the `assets:optimize*` scripts - while `assets-src/` holds the **raw downloads** as they arrived.
Both are gitignored. A raw is kept because re-optimising is what you do when the pipeline's settings change, and it is re-downloadable from the `source` its manifest entry records if it is ever lost.

The whole loop:

```sh
just asset assets-src/rock.glb public/meshes/rock.glb        # optimise + upload a prop
bun run assets:optimize assets-src/gate.glb public/meshes/gate.glb --center   # ...re-origined on its own bounds
# paste the printed MESH_ASSETS entry into src/render3d/assets.ts

# a PACK: many props out of one download, sharing one copy of their materials
bun run assets:extract ~/Downloads/pack.glb assets-src/rocks.glb Cliffs_SmallStone_1=rock-1 ...
bun run assets:optimize assets-src/rocks.glb public/meshes/rocks.glb --keep-nodes
bun run assets:publish public/meshes/rocks.glb
# one MESH_ASSETS entry per prop, all naming that file, each with its own `node`

# a surface is the same loop, once per map it has:
bun run assets:optimize-texture assets-src/stone_col.png public/textures/quarry-stone-base.webp --map base
bun run assets:optimize-texture assets-src/stone_nrm.png public/textures/quarry-stone-normal.webp --map normal
bun run assets:publish public/textures/quarry-stone-base.webp
# paste the printed map lines into ONE TEXTURE_ASSETS entry, with its `tile`

# a captured sky: one file, its own pipeline (NOT ImageMagick - see above)
bun run assets:optimize-hdri assets-src/golden_gate_hills_2k.exr public/hdri/golden-gate-hills.hdr
bun run assets:publish public/hdri/golden-gate-hills.hdr
# paste the printed line into HDRI_ASSETS, with a `label` for the editor's picker

bun run assets:credits                                       # regenerate CREDITS.md
bun run replay assets                                        # check it
just assets                                                  # on another machine
gh release delete-asset assets rock.glb                      # change your mind
```

### Traps

- **`PX`-sized constants do not survive projection.** A fixed on-screen size written as `<px> * PX` assumes the 2D renderer's uniform transform. Everything like that stays on the overlay, and nothing in the 3D scene may depend on `PIXELS_PER_METER` except through `space.ts`.
- **`Scene3D` must be instantiable twice** - the game page and the editor both have one - so everything mutable lives on the instance. The `playerRig.ts` module-global pattern is the anti-pattern this is written against. The material cache in `assets.ts` is shared deliberately: it is immutable once built and belongs to no scene.
- **Transform sync must not allocate**, and must read `renderPosition/renderRotation(alpha)` only. The debug overlay is the one deliberate exception (it exists to show what the sim believes) and it stays 2D.
- **Where the chain's links fall is shared code.** `render/chainMetrics.ts` holds the one continuous arc walk both renderers use, because that is the one part of chain drawing that has ever been wrong (`session-1467f`) and two copies of it would drift.

## Hook-proof surfaces

**Impermeable** is a flag on the **shape** (`CollisionShape2D.impermeable`, authored as `LevelBodyData.impermeable` per level entry): the grapple hook is destroyed on that surface and the ball's is deflected, instead of either anchoring.
It is solid in every other respect - being hook-proof is about the rope and nothing else - so the avatar stands on it, bodies collide with it and the rope still wraps its corners.

It was a body **kind** for as long as it could only ever be static scene geometry, and that cost the two things levels actually want.
A kind is one per body, so nothing could be `rigid` *and* hook-proof: a crate that falls, is hauled about by a chain and still refuses the hook was not expressible at all.
And a compound body was hook-proof in whole or not at all, so a wall with a single attachable ledge among hook-proof faces - the shape of most deliberate level geometry - could not be authored either.
Per shape it is both, and the flag is where the rest of the project already says it should be: **`obj` identity answers "does this move as one rigid piece with that", `shape` identity answers "is this the same surface"**, and which surface the hook reached is the second question (see **Shapes**).

Every path that decides therefore names a **piece**, and each of the three had to be given one:
`World.intersectRay`'s `RayResult` carries the `shape` it hit (the grapple `Hook` reads it), `bodySweepCircle` and `bodyOverlapCircle` return the piece of the earliest / deepest hit (`BallHook`'s sweep and probe), and `attachToBlockingContact` already had one, since a `ContactConstraint` names the shapes it formed on.
The remaining body-level reading was `BallPlayer`'s attach callback, which is a backstop behind `BallHook`'s own decision and now resolves the piece nearest the anchor point.

Rendering is per piece for the same reason - a body that is hook-proof on one face and attachable on the next has to draw as the two things it is.
`geometryStyle` takes the piece (the compound path already strokes each piece where it lies outside its siblings, so it is one style call per stroke), the editor's `strokeCompoundOutline` hands its style callback the item being stroked, and the SVG snapshot's `bodyColor` takes the shape.
Nothing else moved: the ball arena renders **0 pixels** different from before the change.

Levels on disk still carry the retired `kind: "impermeable"`, and `normalizeLevelData` folds it into `static` + `impermeable: true`.
It runs inside `scaleLevelData` rather than at each loader, because that is the one gate a level cannot reach the sim or the editor without passing through - the conversion between the pixels on disk and the metres everything downstream is written in.
A migration a caller can forget is one that is missing wherever the next caller is added, and the failure is silent: the body builds as an ordinary static and the hook simply starts catching on a wall that has repelled it since the level was designed.

`cli contacts` `impermeable-shape` is the detector, and it asserts both hooks against one compound body: the hook-proof piece turns each away, its sibling anchors each, a hook-proof **rigid** body deflects the ball's hook, and the retired kind still loads hook-proof.
Both hooks, because they reach a surface by different means - a raycast that destroys, a sweep/probe that deflects - and a fix applied to one of them alone is exactly the class of bug the shape-versus-body rule exists to stop.

## The slack chain drape

A deployed ball chain with length to spare no longer draws as straight spans: `SlackChain`
(`classes/slackChain.ts`) is a **visual-only** simulation of the loose chain - a fixed-count
Verlet particle chain pinned at the point the chain leaves the ball (the coil's tangent
point) and at the far end (flying hook, dangling tip, or anchor).
It sags in a catenary, drapes over the ball and the scenery, and heaps on the floor.
It is strictly one-way: it reads body transforms and the wrap path at the END of the physics
frame (`BallLevel.physicsProcess` steps it last) and writes nothing back - no forces, no
impulses, no positions - so every replay, digest and invariant is bit-identical with it in
(asserted the usual way: the whole corpus replays byte-for-byte across the change).

Both renderers draw its polyline instead of the chain's spans (`pathLoopToAnchor(alpha)`,
with the coil and both ends still welded to the render transforms so the chain never
detaches from the drawn ball or manacle); `cli render` overlays it in green over the wrap
path's amber, which coincide exactly when the chain is taut.

Four mechanisms carry the requirements:

- **Length is preserved.** The drape's rest length is the free wrap-path length plus the
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
- **Taut is the limit of almost-taut.** Sag grows like the square root of slack, so even
  millimetres of slack sag visibly, and a renderer that switched representation at taut
  would show the chain snapping straight in one frame.
  Instead the drawn chain is ALWAYS this polyline, and below `TAUT_BLEND_SLACK` every node
  is blended toward its arc-length position on the straight wrap path, fully there at zero
  slack - so the drawn shape is a continuous function of the physics state and there is no
  frame on which the representation changes.
  The length the blend hides is bounded by the blend weight times the slack, at most a link
  or two right at the crossover.

Nothing gates the look (a drape is exactly the kind of thing the suite cannot see - see
**What the verification suite cannot see**); what was measured when it was built: worst
single-frame interior-node motion beyond what the endpoints moved is ~2 cm (sub-link), floor
penetration is exactly zero, and the whole sim costs ~0.1 ms a frame inside the 16.7 ms
budget.

## Sparks

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

The hook's half is gated by `cli contacts` **`hook-sparks`**, over three rigs - a head-on throw, a skimming one, and a dangling tip dragged 18 m along hook-proof steel.
It asserts one report per touch and never two, the arrival carrying the velocity the hook came in at rather than what the bounce left behind, a burst on an oblique arrival as well as a head-on one, not one silent frame in the middle of a contact, a slide's sparks travelling along the slide and clear of the face on a floor, a ceiling, a wall and a 45 degree ramp, and a sustained drag grinding at the full per-metre rate where a three-frame strike is charged a fraction of it.
Every one of those is red on its own with the corresponding half reverted, which is the point of writing them as clauses rather than as one number.
The last is stated as the RATIO between the strike and the drag rather than as a bar on either, since either alone is a tuning value and the separation is the behaviour: 6.9 per metre against 30.0 with the ramp, 29.3 against 30.0 without it.
The drag rig has to be built rather than replayed - every hook-proof contact in the recorded corpus is a 2 to 7 frame strike, so nothing in it reaches the far side of the ramp at all.
Particles are counted through the real `SparkSystem` (`bursts` and `slideParticles`, which exist for exactly that and are read by nothing else), since what the sim reports only matters through what the render side makes of it.

The **thresholds and the look** are still ungated, and the three cases to check by hand after touching one are the ones that pin them from all sides.
A hook **skimming** a face must strike once and then trail (`session-127f` f101 onward: one burst, then a stream growing to 63 particles by f109), a tip **dragged** along one must produce a steady stream (`session-152f` f123 onward, and `session-339f`, whose tangential speed reaches 5.4 m/s), and a tip left **resting** against one must produce nothing at all - the resting case fires one or two events every frame for ever, at gravity's own 0.13 m/s of approach and zero tangential speed, so it is silent because both thresholds reject it rather than because nothing is reported.
None of those three is visible to a number: sparks reach no digest and no invariant by construction, so a shower that is the wrong size, the wrong shape or the wrong colour is exactly as green as one that is right.

## Hook-only bodies

A **`passable`** body (`CollisionObject2D.passable`) is the mirror image of a hook-proof surface (see **Hook-proof surfaces**): the hook attaches to it, and **nothing collides with it** - the avatar, the ball, loose debris and the rope/chain all pass straight through.
It is what background scenery you can swing from is made of - a metal grate, a girder, a chandelier, a leaf on a stem - geometry that must not block the level it decorates.

It was the **`anchor` body kind** and an `AnchorBody` class, and it is a flag on the body now for the reason the `impermeable` kind became one, plus one more.
A kind is what a body IS, so hook-only could only ever be immovable scenery; the thing levels actually want it for is a leaf on a sprung stem, which is a `rigid` body that still falls, still sags when the player hangs off it and still stops nothing.
A flag composes with `static` and `rigid` alike.
It stays per BODY and not per shape, which is where hook-proofing lives: hook-proof asks *which surface did the hook reach*, a question about one face, while this asks *is this thing in the way at all*, and a body half in the way is not a thing a level can mean.

Four mechanisms keep it out of the sim, none of them a per-call-site special case:

- `PhysicsBody2D.isSolid` is false while it is set, and every collision path in `World` already filters on that (it is what a `VineLink` is excluded by).
  `moveAndCollide`'s sweep and its depenetration passes, the contact gather and the depenetration sweep all drop it.
- It goes **further** than `isSolid` in the one place a vine deliberately does not: a vine link is blocked by statics, which is how a vine drapes over a ledge, while a `passable` body is blocked by nothing at all.
  `gatherDepenetration` answers with no overlaps for one and `collectContacts` drops its pairs against statics too, which is what stops the scenery a leaf hangs in front of shoving the leaf out of itself.
- Setting it moves the body onto its own collision layer (`LAYER_ANCHOR`), which the setter does rather than the caller, so the two cannot disagree.
  Every existing raycast asks for `LAYER_SOLID`, so they all miss it; the grapple `Hook` is the one query that asks for both, which is exactly what makes it attachable.
  `BallHook`'s swept and probe contacts test no `isSolid` at all, for the same reason.
- `buildLevelBodies` adds it to the world but keeps it **out of the returned wrap list** (the list is exactly the solid bodies), so a passing span has nothing to catch on, and `Rope` itself refuses to wrap a body whose `isSolid` is false (the `isPassThrough` gate in `regeneratePath` *and* in both self-intersection resolvers).
  The second half is not redundant: the wrap list is only the *scan* list, whereas the self-intersection resolvers wrap whatever a rope node is **already attached to**, list or no list.
  Since the hook's whole purpose is to attach to one, that path is reached on every anchored chain - without the gate the chain bent around the grate it was hooked to, which is precisely the collision this exists to avoid.

What it does **not** switch off is the body's own motion: a hook-only `rigid` body still falls, still hangs on its spring, is still dragged by an area current and is still hauled by a chain attached to it.
What it stops having is contacts.

Queries that scan bodies generically (ledge detection, the debug overlay, the embedding invariants) filter on `isSolid` - a grate corner is not a ledge.
The editor offers no friction on one (nothing rests on it) and no hook-proof checkbox (it exists to be caught on).
The 2D renderer, the editor and the SVG snapshot draw it first, behind the solid geometry it sits among, punched with a grate lattice and edged with dots; in **3D** the lattice is dropped and the body's setback behind the gameplay plane is what says the player passes through it.

## Vines

A **vine** hangs from one anchor, free at the bottom - or **spans between two**
(see **Spanning vines** below): the player passes straight through it, and the
hook grabs it **anywhere along its length**.

**Vines ignore the scenery**, and that is a design decision rather than a
simplification the solver forced: a link collides with nothing at all
(`VineLink` is `passable`, the hook-only rule), so a vine neither drapes over a
ledge nor pools on a floor, and levels are authored so that neither situation
ever matters.
What the decision bought is most of what a vine used to cost - the links leave
the contact gather, the depenetration sweep and `settleChainBodies`' static
push-out entirely, and the load path became a straight line by construction, so
the wrap-routing `Rope` that dominated every held frame became a closed-form
constraint.

It is **a chain of small pass-through rigid links joined by closed-form
distance constraints, plus one straight long-range attachment from the vine's
anchor to the grabbed link for exactly as long as the hook holds it**
(`level/vines.ts`).
The links carry the hang and the grab surface; that one extra constraint
carries the load.
The links have to be real bodies because a rope is a **constraint and not a
surface** - there is nothing for the hook's ray to hit halfway along one.

**A vine is allowed a little stretch under load, and the allowance is what it
costs to run.**
A Gauss-Seidel pass over a serial chain leaves an order-dependent residual
(73 mm on a 1.03 m chain, measured in `chains.ts`), converging it scales with
tension, and holding every joint of a swinging stiff vine to the chain bar cost
25-40 sweeps a frame for millimetres nobody can see.
So a vine's joints run to `VINE_TOLERANCE` (15 mm) instead of
`CHAIN_TOLERANCE` (5 mm), per constraint, through
`SceneConstraint.tolerance` - and the stretch that allows is bounded twice
over: per-link long-range attachments (anchor to every link, at the arc plus
the sweep's give) cap the cumulative sag whatever the joints do locally, and
the load rope holds the grabbed link itself at the tight bar, so the player
never sinks.
Spans are the exception and keep the tight bar - see **Spanning vines**.

### A vine link blocks nothing and is blocked by nothing

`VineLink` is a `RigidBody2D` - it needs gravity and mass, and the whole chain
phase (`snapshotChainBodies`, `settleChainBodies`, the credit scaling) is
written against that class - carrying the `passable` flag, so every collision
path drops it by the same rules that drop a hook-only leaf: no contacts against
anything, no depenetration in either direction, out of every wrap list, found
only by the hook's own queries.
It used to be the weaker statement ("a non-solid body blocks nothing, and is
blocked only by statics"), which is how a vine draped and pooled; that
half-rule and its guards are still in the engine for any future body that wants
it, and a vine simply no longer uses it.
`cli vines` asserts the contract on bare bodies (`link-contacts`), through a
level (`scenery`: a vine hanging through a ledge is bit-identical to the same
vine in clear air), and from the ball's side (`ball-vine`).

A vine never stacks, never pushes anything and never fights its own pair
constraints through the contact solver - the "stacking and contact problems"
`docs/game-design.md` cites against body-per-link chains, **removed by
construction rather than solved**.

### The load rope

`updateVineLoads` is called once a frame from `Level.physicsProcess` and derives
the rope from the state of the world rather than from grab and release events:
*if the player's rope ends on a link of this vine there is a load rope from the
vine's anchor to that link, and otherwise there is none*. Release, the hook being
destroyed and re-firing at a different link all fall out of that one statement,
and `cli vines` `release-refire` asserts it frame by frame.

It is a `VineAnchor` (`level/vineAnchor.ts`): a **closed-form point-distance
inequality** from the anchor contact to the grabbed link's centre - textbook
long-range attachment semantics, exact in one projection, with the rotational
term in the effective mass (`w = 1/m + (r x n)^2 / I`) so a rigid, pivot or
spring anchor body is turned and moved honestly.
It was a wrap-routing `SceneChain` while vines collided with the level - a
straight LRA is wrong the moment the vine bends round a corner - and that solve
regenerated a wrap path on every coupled sweep, which was the single most
expensive line of every held frame.
With the scenery ignored, straight is always right, and the same class serves
the anchor-to-first-link joint and the per-link LRAs.

Three things about it are load-bearing.

**Its rest length is the arc the vine actually has**, measured when it is built,
not `spacing x links`. The sweep's tolerance is per chain and a vine is a SERIES
of them, so a settled vine hangs longer than its authored length - invisible,
since nothing on screen says how long the vine should be. A load rope born at
the nominal figure is born SHORT and yanks the grabbed link up on the frame the
player grabs it, which is `rope-anchor-kick` in the ball's words and is answered
the way the ball answers it (`BallPlayer`'s attach callback re-takes the birth
length).

**It keeps the tight `CHAIN_TOLERANCE` bar** while the vine's own joints run
loose: it is the line the player hangs from, and its closed-form solve pays
nothing for the precision.

**It is swept WITH the scene chains, and the set has to converge.** The player's
rope pins to a link, so the two share a body, and solved in separate phases each
one's correction is the other's residual - `session-521f`, at a far worse mass
ratio than the ball ever saw. `stepSceneChains` therefore takes the player's rope
as its `extra`, exactly as `BallLevel` passes the ball's chain, and
`CoupledRope.settleSet` makes the loop wait for the vine's own residuals too
(gated on the coupling alone, a vine got one sweep per frame and came apart).
The sweep count is set by the exit gate rather than the cap now: a held vine
exits in a handful of coupled sweeps (5-11 measured on `session-322f`), the cap
(`MAX_COUPLED_SWEEPS`) being only the bound on a rig that will not converge.

### The numbers, and which of them an author sets

**Spacing is a cost decision.** Everything a vine costs scales with its link
count: a vine is `length / spacing` bodies, that many pair chains, and that many
cheap solves per sweep of the chain phase. One 3 m vine, wall clock per physics
frame, at rest and with the player swinging on the middle of it:

| spacing | links | at rest | swinging |
|---------|-------|---------|----------|
| 0.10 m  | 30    | 1.60 ms | 4.66 ms  |
| 0.15 m  | 20    | 0.84 ms | 3.56 ms  |
| 0.20 m  | 15    | 0.44 ms | 2.67 ms  |

(The table predates vines ignoring the scenery and the closed-form load rope -
the shape of the argument holds and the absolute numbers are now several times
smaller: a nine-vine arena with the player swinging on one runs ~1 ms a physics
frame average, spikes under 5, measured on `session-322f`.)

15 cm is the default. A level pays for all of its vines at once, so the budget is
the TOTAL link count. Coarser spacing costs grab-anywhere nothing (the grab
radius grows with it) and coarsens the curve.

A link no longer costs more on a dense level: `settleChainBodies`' static
push-out early-outs on a `passable` body, so the scan over the level's geometry
that used to double a vine's frame cost (3.9 ms against 1.7 in an empty scene)
is gone with the collisions.

### A settled vine costs nothing

This is the "no sleeping" simplification `docs/game-design.md` lists, taken for
the one body kind that finally needed it. A vine is `length / spacing` bodies and
that many constraints, all swept every frame whether or not anything is happening
to them, and nearly all of that is spent on vines hanging perfectly still. Two
3 m vines in the ball arena, measured:

| state | ms a physics frame |
|---|---|
| awake | 3.91 |
| **asleep** | **0.19** |
| the same arena with no vines at all | 0.21 |

Asleep is therefore free, exactly. A sleeping link is skipped by
`World.integrate` (no gravity, no step) and its vine is left out of the chain
sweep entirely - which is where the cost is (an awake link no longer reaches
the contact gather or the depenetration sweep at all, being `passable`). What
it is NOT skipped by is the hook's raycast: a sleeping vine is still a thing
you can catch, and being caught is what wakes it.

**The test is net DISPLACEMENT over a window, and both halves of that were
arrived at the hard way.**

Not velocity, because a settled vine's links carry a permanent velocity churn:
the chain solve corrects the top links every frame and credits them the velocity
it moved them by, so the second link of a vine hanging still reads 0.27 m/s for
ever. A speed test never sleeps a vine at all - measured, 3.83 ms a frame,
unchanged by it.

And net over half a second rather than per frame, because that churn is a limit
cycle: the same links oscillate 2-7 mm every frame about a point they do not
leave. Per frame they look like a vine moving at 0.4 m/s; over the window they
have gone nowhere, which is what settled means and what a player sees.

A vine wakes on the frame the hook takes it (`updateVineLoads` runs before
`stepVines`, so being held is already known), and on its anchor moving - a vine
hangs FROM something, and a sleeping one would stay behind in mid-air if that
something swings or sags. `cli vines` `sleep` asserts the cycle end to end,
including that a sleeping vine does not move by a micron over 300 frames.

**A link is damped, and nothing else here is.** A pair chain is a PBD POSITION
constraint and a link hanging in free air touches nothing, so `contactDamp` never
reaches it: a vine has no dissipation at all, and once excited it rings for ever.
Worse, the ringing is FED - the sweep's tolerance lets the vine lengthen by a
fraction of a millimetre a frame, and that potential energy has nowhere to go but
into motion. Measured on the ball arena's own vines, left completely alone: the
tip was still moving at 0.33 m/s after 900 frames and 0.65 m/s after 3000, with
total energy flat. `LINK_DAMPING` is 0.98 a frame - `contactDamp`'s own historical
figure, and honest for a vine, which is heavily damped by air and by itself - and
it takes that tip to 0.04 m/s and the vine's positional jitter to 1.9 mm over
600 frames. It is applied BEFORE the chain phase, because `settleChainBodies`
rewrites a link's velocity as what it had at the top of the phase plus what the
phase moved it by.

**Link mass is a solver number.** A PBD correction splits by inverse mass, so
what the player's rope does to a grabbed link is set by the ratio between 70 kg
and that link. The worst the load rope stretched under a player swinging on the
middle of a 3 m vine:

| per link | ratio | stretch | swinging cost |
|----------|-------|---------|---------------|
| 0.4 kg   | 175   | 194 mm  | 11.4 ms       |
| 1.0 kg   | 70    | 32 mm   | 12.0 ms       |
| 2.0 kg   | 35    | 3.4 mm  | 8.2 ms        |
| 3.5 kg   | 20    | 0.0 mm  | 4.7 ms        |

Stretch and cost improve together, because they are the same convergence.
`DEFAULT_VINE_DENSITY` is 25 kg/m, so a link weighs that times the spacing and a
vine weighs the same whatever spacing it is authored at; a 3 m vine is 75 kg.
Nobody sees kilograms, and the bound at the other end is that a vine must not
visibly load the spring body or rigid platform it is anchored to.

**Weight is authorable per vine** (`VineData.density`, kg/m, `kg/m` in the vine
panel with the resulting whole and per-link weight beside it). Per METRE and not
per vine, so it stays put when the end handle is dragged; and it is the one
number on a vine that `scaleLevelData` must NOT scale, since it is already
written per metre while everything beside it is in the file's pixels - scaled, a
25 would have become 2500.

What an author is choosing is not how the vine falls. Gravity is
mass-independent, so a 6 kg vine and a 180 kg one hang in exactly the same place
and swing at exactly the same rate, which `cli vines` `weight` asserts to the
micron. What weight buys is how the vine ANSWERS: the table above, again, as
densities on a 3 m vine at the default spacing -

| density | per link | stretch | swinging cost |
|---------|----------|---------|---------------|
| 2 kg/m  | 0.30 kg  | 622 mm  | 8.3 ms        |
| 8 kg/m  | 1.20 kg  | 23 mm   | 8.1 ms        |
| 25 kg/m | 3.75 kg  | 0 mm    | 3.6 ms        |
| 60 kg/m | 9.00 kg  | 0 mm    | 2.0 ms        |

- and what it leans on the body it hangs from. A light vine is a legitimate
choice with a visible cost, so it is warned about rather than refused: the panel
says so below `LIGHT_LINK_MASS` (1.5 kg in ONE link, a per-link number because
the mass split that decides it is per link), and `MIN_VINE_DENSITY` (1 kg/m) is
only the floor where the solve stops converging at all. A file may say anything;
under the floor it is built at the floor.

Two radii, and they are different numbers: the **grab** radius is the collision
circle at 0.6 x the spacing, so consecutive links overlap and the hook's ray
cannot slip between them, and the **visual gauge** is 3 cm.

### Stiffness

**A vine is a rope by default and can be authored anywhere between a rope and a
pole** (`VineData.stiffness`, 0..1, `level/vineBend.ts`). What it changes is how
much force it takes to BEND the vine; what it deliberately does not change is
where the vine hangs, since its rest pose is straight down either way.

It is a **three-point curvature constraint with a compliance**, solved by XPBD in
the same sweep as the pair chains. Each part of that is forced:

- *Three points*, because a spacing says nothing about shape - any curl or
  zigzag satisfies every pair chain there is - so what the pair chains leave free
  is exactly the curvature at a link, and the curvature at a link is a statement
  about it and its two neighbours. The measure is the middle point's distance
  from the chord midpoint of the outer two, which is zero exactly when the three
  are straight and evenly spaced; as an angle it would want an arctangent per
  joint per pass for a number the solver turns straight back into a
  displacement.
- *A compliance*, because the obvious PBD spelling of "half stiff" - apply half
  of each correction - makes the stiffness a function of the pass count, and
  this sweep's pass count is neither fixed nor knowable: it runs to a residual
  (see `sweepChains`), so a vine would be stiffer on a frame that had a hard rig
  elsewhere in the level. XPBD converges to the same physical rigidity whatever
  the pass count, so `stiffness` means a bending rigidity rather than a solver
  setting.
- *In the same sweep*, because the two disagree by construction: a bend that
  straightens the vine drags two links off their spacing, and the pair solve that
  restores the spacing bends the vine back. That is the statement `sweepChains`
  already makes about two chains sharing a body, one order out - so a bend is a
  `SceneConstraint`, which is what that phase now solves instead of chains
  specifically.

**The constraint is written at every scale, not only between neighbours.** A
stiff serial chain is the one shape a Gauss-Seidel sweep is worst at: news
travels one link per pass, and stiffness is what every pass is arguing about. On
a 3 m vine with a player swinging onto its tip, at the stiffest setting there is:

| bends | sweeps | lean off vertical | worst kink | cost |
|---|---|---|---|---|
| neighbours only | 64 | 28 deg | 15 deg | 6.1 ms |
| neighbours only | 512 | 25 deg | 7 deg | 11.8 ms |
| **every scale** | **64** | **1.7 deg** | **2.8 deg** | **3.7 ms** |

Eight times the solver buys three degrees; the same constraint written between
links 2, 4, 8 and 16 apart buys a pole. It is a multigrid V-cycle spelled as
extra constraints - about 3x the constraints (59 against 20) and LESS wall clock,
because a sweep that converges is one the loop leaves early. Every scale carries
the FULL rigidity rather than a share: split, a single kinked joint - which is
exactly what the hook pulling on ONE link makes - is `log2(links)` times softer
than a smooth bend, and a stiff vine that kinks where it is grabbed is the
artifact the feature exists to prevent.

**It is CLAMPED at the anchor rather than hinged.** Without that, the joints hold
the vine straight and the straight thing swings freely about its bolt - a
pendulum, which is not what a pole bolted to a ceiling does. The clamp is the
same three-point constraint with a GHOST point standing in for the link that
would be above the anchor if the vine carried on through it, and the ghost is a
point on the ANCHOR BODY, so it turns with it: turn a ceiling a quarter turn and
a stiff vine comes with it and holds itself out horizontally under its own 50 kg,
where a rope hangs down as it always did (`cli vines` `stiffness`). The rest
direction it encodes is the one the vine was built at, which is straight down - a
vine has no authored direction.

**The two ends of the slider are read and the middle is measured.** EI is a real
beam quantity - a cantilever of length L under an end load P deflects P.L^3/(3.EI)
- so 1000 is where a 70 kg player on a 3 m vine deflects it by 6.3 m (a rope
whatever it is called) and 1000000 is where the same load deflects it 6.3 mm
(under what the renderer can draw). The map between them is GEOMETRIC, because a
linear one would spend nine tenths of the slider between "sapling" and "pole",
which are the two an author cannot tell apart. Worst lean off vertical and
straightness (chord over arc) with a player swinging onto the tip of a 3 m vine:

| stiffness | EI | worst lean | straightness | reads as |
|---|---|---|---|---|
| 0 | - | 45 deg | 0.917 | a rope |
| 0.25 | 32 | 39 deg | 0.965 | a heavy cord |
| 0.5 | 1000 | 25 deg | 0.996 | a springy branch |
| 0.75 | 31623 | 9.5 deg | 0.999 | a sapling |
| 1 | 1000000 | 1.7 deg | 1.000 | a pole |

**Zero builds nothing.** A vine that does not ask for stiffness has no bend
constraints at all, so it costs exactly what a vine always cost and replays
bit-for-bit - asserted that way in `cli vines` `stiffness`, over 200 frames with
the player hanging off it. Out-of-range values are clamped at load: a negative
compliance is a joint that bends further the harder it is pushed.

The one simplification is that **the anchor end is immovable**: a cantilever
exerts a moment on what it is bolted to, and this one does not. That would want a
torque arm on the anchor body and a share of the phase's velocity credit, so that
scenery could lean on the thing it hangs from - against the existing statement
that a vine must not visibly load its anchor.

### Where a vine spawns

A hanging vine spawns straight down its full authored length, which IS its rest
pose - a link collides with nothing, so there is nothing for it to stop at or
pile on, and the geometry scan the spawn used to run (`dropDistance`, and the
runaway it closed) went with the collisions.
A vine authored longer than the space under its anchor simply hangs through the
floor, and that is the level author's to avoid - the same contract as the rest
of the scenery-ignoring decision.

### Spanning vines

A vine may name a **second anchor** (`VineData.anchor2`) and become a span attached at both ends.
The length stays the whole authored arc, deliberately decoupled from the distance between the anchors: a span longer than the gap **sags into the catenary** that length implies (`level/catenary.ts`), which is both where the editor draws it at rest and the pose `buildVines` spawns the links in.
The catenary is the solver's own fixed point, so a span at rest is at rest on frame one, with nothing for the first frames to correct (`cli vines` `span` bounds the settle movement in millimetres).
The catenary solve is closed-form once its parameter is bisected, sampled BY ARC LENGTH so the links land at their exact spacings; the taut and near-vertical regimes are their own branches (the chord, and the fold).

A span authored **shorter than the gap is built taut at the separation itself**.
The authored figure is a constraint set that cannot be satisfied - the chains' total reach is less than the distance they must cover - and an unsatisfiable set never converges: the vine jitters at ~0.7 m/s for ever and can never sleep.
Taut still sags a little, and the amount is the sweep's own arithmetic: each chain rests up to `CHAIN_TOLERANCE` over its length, and that series of give hangs as `sqrt(3 * gap * give / 8)` - which is how the `span` case bounds it.

A grabbed span gets **two load ropes**, one from each anchor to the grabbed link (`Vine.lra` and `Vine.lra2`), because a span's tension runs to both ends: held by one alone, the run to the other anchor is just pair chains carrying a player - `links * CHAIN_TOLERANCE` of give paid out exactly where the span is supposed to hold.
Both are born at the measured arc to their own side (`arcTo` / `arcFrom2`), for the `rope-anchor-kick` reason the one always was, and both go into the coupled sweep together.
`updateVineLoads` therefore returns the held VINE rather than a load rope, and `vineChainSet` pushes whichever load ropes it carries; `BallLevel.heldVine` is the same value under its ball-side name.

**Stiffness on a span means pinned ends, and slack pressed toward straight.**
A vine lashed at both ends is hinged there, not cantilevered, so a span builds NO ghost clamps - the anchor-side clamp encodes the straight-down rest pose a span is not in - and instead gets the anchor-side joint triples mirrored at the second anchor, so the far end is exactly as smooth as the near one (`buildVineBends`).
The triples cannot all be satisfied (a span with slack can never be straight) and do not have to be: XPBD bends are springs, and the equilibrium is a force balance with the chains.
Because the chains are rope INEQUALITIES - a compressed joint is satisfied - that balance absorbs the slack rather than bowing it: measured on 5 m over a 4 m gap, sag 1.38 m at 0 (the catenary), 1.35 at 0.25, 0.21 at 0.5, 0.09 at 1 - a taut wire - monotone, settling and sleeping at every setting (`cli vines` `span-stiffness`).

**A span keeps the tight bar and the lease a hanging vine gave up.**
Its joints run to `CHAIN_TOLERANCE` and carry the standing-stretch lease (`VinePair.leased`), because the two regimes fail in opposite ways: a taut span's joints sit permanently over under their own tension and must be allowed to bank that residual or the span rings for ever and never sleeps, while a loose-bar joint carrying a lease banks its allowed residual faster than `SLACK_RELEASE_RATE` decays it and pays the vine out at ~7 mm a frame for ever (12.4 m of "5 m" span, found the hard way).
Tight-with-lease and loose-without are the two stable pairings, and `buildOne` couples each vine kind to its own.

One deliberate exclusion: **a dead second anchor falls back to hanging** rather than dropping the vine - one anchor is still a complete vine, unlike a chain end - and so does a span naming its own anchor twice.

Sleep watches **both** anchors, so a span whose far end rides a swinging body wakes exactly as a hanging vine on one does.

### The ball level

`BallLevel` builds and steps vines too, and that is not symmetry for its own
sake: `BALL` is the **default level**, so a bare `/` and the editor's ▶ Test Ball
are where a vine authored in the editor is most likely to be looked at, and left
out of that driver a vine did not exist there at all - not drawn, not simulated,
not grabbable.

The **ball goes through a vine and its CHAIN catches on one**, and those are two
different questions with two different answers. The body passes through because a
link is non-solid like anything else; the chain catches because `BallHook`'s
three attach paths take a link like any other rigid body, and a vine is a thing
to hook rather than a thing to bump into. So the load rope is the ball's too:
`updateVineLoads` runs there against `ball.chain` exactly as it runs in `Level`
against the player's rope, and the coupled sweep takes `settleSet` while a vine
is held for the same reason.

`cli vines` `ball-vine` asserts both halves, each in the form that cannot be
satisfied by a near-miss: 240 frames of the ball falling THROUGH a vine are
bit-identical to the same fall with no vine in the level, the vine over those
frames is bit-identical to the same vine with the ball 15 m away, the thrown
chain catches a link and gets its load rope, and hanging on it for 20 s gains
0.08 J of mechanical energy against a 5 J bar.

#### The spin may not be billed for the sweep's tolerance

Aim steering is kinematic - `BallPlayer.resolveInput` writes the frame's angular
velocity straight from the aim error - so a ball that will not turn is never a
torque problem. Something later in the frame is taking the rotation back, and the
only thing that does is `unwindOverLength`.

Its premise is that over-length still standing at the end of the chain phase is
over-length the solve **could not** pay, so the spin has to give the radian back.
That premise fails for a solve the phase deliberately skipped, and holding a vine
it does: the coupled sweep leaves the ball's chain inside `CHAIN_TOLERANCE`
rather than at zero (see `sweepChains`), and 5 mm of the solver's own convergence
budget is worth an entire frame's turn.

`session-337f` is what that feels like. The chain ended 4.7-5.3 mm over on all
312 frames that were holding a vine, the unwind took the whole frame's rotation
back on 107 of them, the ball's rotation stood at exactly -0.17794 rad while the
aim error wound up to 13.8 rad/s, and the game read as a force resisting the
mouse. So the unwind takes a `forgive` argument, and `BallLevel` passes
`CHAIN_TOLERANCE` while a vine is held and zero otherwise - no other frame in the
game changes, because no other caller leaves its rope unsolved. Worst lag between
the loop and the aim it is steered to, over a hand-speed sweep (one full turn
every 4 s): **109 degrees and 133 pinned frames before, 19 degrees and none
after**, and on `session-337f`'s own input 48 degrees and 35 down to 11 and none
(`cli vines` `ball-steer`).

Two things this deliberately does NOT do. It does not exempt the grabbed link
from the spin rollback (`session-265f`) - the rollback is what stops a kinematic
spin being exported to the body the chain is anchored to, and a vine link would
be dragged by it. And it does not touch the same lag on a STATIC anchor, which is
far worse (178 degrees, 205 pinned frames on that sweep): winding a taut chain
onto the rim against something that cannot move is the mechanic working as
designed, and whether it should be that stiff is a game-feel question rather than
a bug.

**A ball bundle recorded before a level gained a vine is stale.** `session-2504f`
replays `BALL`, and once two vines were authored into `levels/ball.json` its
recorded throws caught one on 1202 of its 2504 frames and winched it about -
`energy-gained` then fires on the work that does, against a 17 J tolerance sized
for the ball on a scene a 3 m vine adds ~940 J to. The control is what says this
is the level having changed rather than the physics: the same bundle against the
same level with the vines removed is clean, and a ball left hanging on a vine
gains nothing. Re-record the bundle, or keep the vines clear of where it throws.

### Drawing

A vine is drawn from its LINK POSITIONS - the anchor and the link centres,
against the render transforms. `chainMetrics.ts` is deliberately not used: that
walk exists to place links along a wrap path because a scene chain has no
per-link bodies, and a vine has real ones, which are the honest source. Both
renderers take that path through `VineCord.path`, so neither can have its own
idea of where a vine is. The load rope is not drawn at all - it is a constraint
rather than a thing, and the links already say where the vine is.

**In 2D** it is a smoothed cord at the visual gauge (`render/vines.ts`); **in 3D
it is real geometry** - one `InstancedMesh` of capsules along the same path
(`render3d/vineVisual.ts`), built on `ChainLayer`'s argument and laid the same
way. Capsules rather than cylinders because the cord bends at every link and the
hemispherical caps fill the notch two cylinders would leave on the outside of a
bend, at any angle and with no mitre to compute.

Drawn in the scene rather than painted flat over it, and that is the whole point
of the 3D half existing: **the 2D overlay is dropped in every 3D-only view the
editor has and in every orbited one**, being a projection of the gameplay plane,
so a vine drawn only there vanishes exactly where an author goes to judge how a
level reads. A vine is the level, not chrome. It also gets what a flat cord never
could - it passes behind the geometry in front of it, and the level's own lights
fall on it.

`drawnElsewhere` in `render3d/scene.ts` is the other half: a link must not ALSO
extrude like scenery, which draws a vine as a stack of brown spheres with the
cord painted down the middle of them. That one was found by running the editor's
▶ Test and is invisible to everything else here.

The editor draws vines in its 3D scene too, and it is the reason `Scene3DLevel`
takes `VineCord`s rather than `Vine`s: the editor's scene is built by
`buildLevelBodies`, which spawns no links, so what it hands over is the
straight-down REST POSE. That is exact rather than guessed - a vine hangs there
until something moves it - which is what separates it from a chain, whose sag
would be a drawing of something the level does not contain and which therefore
still stays on the editor's 2D canvas.

### Authoring

`VineData` names an ANCHOR OBJECT by id and carries a length, exactly as
`ChainData` names its two - which body it hangs from is a question about where
the anchor lives. `+ Vine` in the editor is the chain tool's press followed by a
drag DOWN that pulls the length out; the panel carries the length, the spacing
(blank = the default), a live link count, the density, the stiffness (blank = 0,
a rope, with what it reads as beside it) and the colour, and the vine is listed
under `Vines (N)` beside the chains.
A **span** is authored from a hanging vine: **Shift-drag its end handle onto a body** to attach a second anchor there (the panel gains a live `slack` readout), drag that end handle to re-anchor it as a chain end is re-anchored, and **Shift-drop it over empty space** to detach back to a hanging vine of the same length.
The editor draws a span at its resting catenary, on the canvas and in the 3D scene both, through the same `catenaryPolyline` the builder spawns from.
`TEST_VINES` is the worked level - two vines
over a chasm to swing across, one long enough to pool on the far ledge, and a
span with a metre of slack between the second and third branches.

### What checks it

`cli vines` (`sim/vineCases.ts`), and it is the whole of the coverage, because a
vine reaches no avatar digest and no invariant: it violates nothing when it comes
apart, and a build that quietly stopped making links renders as a level with no
vine in it and passes everything else.

The cases that matter most are the ones nothing else could make: the engine
guards on bare bodies (`link-contacts`, a link touching nothing in either
direction); that 300 frames of walking, jumping and landing are
**bit-identical** with and without a vine in the way (`pass-through`), and 360
frames of a vine hanging through a ledge bit-identical to the same vine in
clear air (`scenery`) - the only forms of "passes through" a nearly-no-op
cannot satisfy; that the anchor-to-grab arc holds in MILLIMETRES under a
swinging player (`grab-hang`); that a winch hauls as far up a vine as up
a static in the same place (`winch`, `ball-winch-hung-anchor`'s methodology);
that the ball still turns to its aim while it hangs on one (`ball-steer`); and
that exactly zero or one load rope exists on every frame of a
fire/grab/release/regrab cycle.
The span cases are `span` - the settled sag against the ANALYTIC catenary, the arc against the authored length, the taut clamp, the spawn-at-rest bound, and that a span sleeps - `span-stiffness` - the slider monotone from catenary to taut wire, settling and sleeping at every setting - and `span-grab`, which holds BOTH load ropes' arcs in millimetres through 400 held frames; `format` carries the `anchor2` round trips and the fallback-to-hanging tolerances.

Two of them are worth reading for HOW they are written rather than what they
assert. `ball-vine` measures the closest the ball ever gets to a link, because
the version before it steered a ball at a vine and never reached it - a ball has
no drive of its own, so the roll travelled 13 cm and passed 1.1 m clear, and the
case passed on an encounter that never happened. `ball-steer` measures the lag
between the loop and the aim in DEGREES over a hand-speed sweep, because the
failure it is written against (the unwind billing the spin for the sweep's
tolerance) leaves every other number in the game looking correct. `playtests/vine-swing.json` is the mechanic end to
end - two chained swings across an 8 m chasm - and
`playtests/regressions/vine-swing-320f.json.gz` is the same run as a bundle.
(It was recorded against the rigid-vine physics, so it legitimately diverges a
few pixels mid-run now; the invariants are the pass signal, per the usual
bundle semantics.)

## Pivot bodies

A rigid body may be **pivot-mounted** (`LevelBodyData.pivot`): bolted to a frictionless bearing at its centre of mass, so it spins under torque and never translates - a windmill fin the player lands on or hooks onto to swing around.
It is a flag on the `rigid` kind rather than a kind of its own, for the reason `impermeable` is a flag: a pivot body IS a rigid body - mass, inertia, Coulomb friction, the rope's torque arm - with one degree of freedom removed, and a kind would restate all of that to say one thing.

Translation is removed at the source rather than fought.
`RigidBody2D.inverseMass` reads 0 while `pivot` is set, so every impulse path - the contact solver, the character push, a cannonball's explosion - moves it nothing by the same arithmetic that moves a static nothing; `World.integrate` skips gravity and zeroes `linearVelocity`, which is what a direct velocity write (an area current, water's flow lerp) needs, since an inverse mass of 0 does not cover one; and `depenetrateRigid` declines the body outright, an overlap it is in being the contact solver's to resolve in rotation.
The origin being the centre of mass is what makes gravity torque-free about the bearing, so an unbalanced fin still hangs exactly where it was authored.
Water's angular drag still applies - a wheel in a river is slowed by it - and the mass stays the pieces' real sum, which is what a pushing character's impulse is sized against.

The rope is the one solver that does not deal in inverse mass - `correctShapePositionAndRotation` splits a correction by `inertia / (inertia + mass·arm²)` - so `getDynamicBodyState` hands it a pivot as `mass: Infinity`, and the one indeterminate limit (`angularFactor`, Inf/Inf) is written out as `1/arm`: the whole correction lands in rotation, and `arm·Δθ` is exactly the length the solve asked the body to remove.
The velocity credit is a no-op for the same reason the axle never moves.
The impulse-pairing audit exempts the linear half - the difference is the bearing's reaction, which nothing models - and keeps the angular half in full.

`cli contacts` `pivot-body` and `pivot-chain` are the detectors: the hold under gravity is exact (integrate skips the body, so the assertion is drift `=== 0`, not small), an off-centre impulse spins it by `cross(r, J)/I` while the axle holds, a falling box torques it the way the blow points through the pair solver, a hung weight turns it through the rope's torque arm (which is what reaches the `1/arm` branch), and the authored flag is asserted READ against a free control body - a build dropping it produces a level that looks identical and plays as a fin that falls out of the sky.
The editor authors it as a `pivot` checkbox on the rigid body's panel and marks the bearing with a ring-and-dot at the centre of mass, drawn for a body of one as well - unlike the compound diamond, being pivot-mounted is otherwise invisible on the canvas.

### An authored bearing, and the torsion spring

The bearing does not have to be the centre of mass.
`LevelBodyData.pivotX`/`pivotY` put it at an authored point in the body's own frame - a branch hinged where it meets the trunk - and `pivotFreq`/`pivotDamping` add a torsion return spring about it, so the body bends away under a load (a hanging player, a thrown crate, chain tension) and springs back to its authored angle when the load leaves.
This is the "tree branch" mechanic, and it is deliberately NOT the linear spring: a spring body translates and never rotates, where a branch is locked to rotating about its hinge.

The implementation is one move and everything else follows: `buildLevelBodies` re-origins the body onto the bearing (`reoriginTo` - the pieces' local offsets absorb the shift, the inertia gains the parallel-axis term, and the centre of mass is kept in the body's local frame as `RigidBody2D.pivotComOffset`).
With the origin AT the hinge, `inverseMass` 0 holds the axle and every lever arm the engine measures from `globalPosition` is the hinged body's own, so contacts, the rope's `1/arm` branch, explosions and the character push are all exact for a hinged body with no code of their own.
What does need code is gravity, which is no longer torque-free about the bearing: `World.integrate` applies `m·g × r` about the hinge, summed with the torsion spring's `-w²·Δθ - 2ζw·ω` into ONE acceleration and applied once - the damping term must read the frame's incoming angular velocity, not one with gravity's increment already in it, or the settled angle sits a measurable 10% off the closed form.
Both terms are guarded so a plain centre-of-mass pivot adds literally nothing and every recorded pivot replay stays bit-identical.

The frequency is in Hz for the linear spring's reasons - a rate crosses `scaleLevelData` untouched, and `k = I·w²` is implied so the free oscillation is mass-independent - while the bearing point is a length and scales.
The angle is deliberately not wrapped: a body wound a full turn unwinds a full turn, which is what a torsion spring does.
`mechanicalEnergy` reads a pivot body's gravitational potential off the CENTRE OF MASS (the bearing origin never moves, so PE read off it turns the whole KE↔PE exchange of a free swing into an unforced gain) and carries the torsion elastic term `0.5·I·w²·Δθ²`.

`cli spring` carries the detectors (`pivot-droop`, `pivot-pendulum`, `pivot-period`, `pivot-authored`, `spawn-at-rest`, and `winch-load` for what a wind-up does to a sprung anchor - see the spin rollback under the ball chain), because like the linear spring the whole behaviour is arithmetic with a closed form: the droop is the root of `I·w²·Δθ = m·g·d·cos θ`, a free off-centre bearing is a physical pendulum at `2π·sqrt(I/(m·g·d))` with the axle asserted at `=== 0` drift, the torsion oscillator runs at `1/f` with the energy flat, and the authored fields are asserted read, scaled, clamped, and bit-for-bit inert on a plain pivot.
`TEST_BRANCH` is the worked level - the spring level's chasm with the leaf replaced by a bough hinged at the far wall.
In the editor, ticking `pivot` offers `pivot x`/`pivot y` (blank = the centre of mass; the axle ring draws at the authored point) and `return (Hz)`/`damping` for the spring; the point is held frame-local in the model (`EdItem.pivotAt`), so every gesture that moves or turns the body carries the bearing with it for free.

### Sprung bodies spawn at rest

A spring body, a torsion-sprung branch and a free off-centre pivot all SPAWN at the rest pose the suite proves they settle to (`applyRestPose` in `buildBodies.ts`), so a level does not open with its leaves and branches visibly falling into place.
The authored pose keeps its whole meaning - it is the spring's anchor and the torsion spring's rest angle - and the spawn displacement is the same closed-form equilibrium `cli spring` asserts the sim settles to: a fixed point of the integrator, the statement `buildVines` already makes about a catenary, so a settled body is at rest on frame one.
A centre-of-mass pivot and a plain rigid body spawn EXACTLY at their authored pose, which is the bit-identity rule; recorded bundles containing spring bodies legitimately diverge (informational, per the usual bundle semantics).

Two frame correspondences are load-bearing.
`BuiltBody.origin` is captured BEFORE the displacement, because `localPlacement` resolves every geometry object, decoration and chain anchor against the frame the authored placements were written in - captured after, a leaf's visual stands at the authored spot while its body hangs below it.
And a chain or vine anchor on a sprung body resolves its material point through `anchorWorldPoint` (`chains.ts`): the authored placement mapped through that correspondence onto the body's spawned transform, so the anchor rides the settle and a taut chain's derived length is the distance between the anchors AS THEY LAND - resolved through the authored placement instead, the chain spawns slack by the droop and yanks on frame one.
The undisplaced path deliberately keeps the plain `worldPlacement` answer, since the local round trip costs two rotations of float noise and every level with no sprung body must stay bit-identical.

The editor shows the same thing twice.
Its 3D scene is built through the same `buildLevelBodies`, so the drawn model simply stands at the rest pose; and the 2D canvas draws a dashed **settled ghost** of each displaced body's collision outlines at the rest pose (`settledGhosts` in `editor/model.ts`, cached per model revision - it is a full level build), while the authored outline stays what is drawn and edited, it being the datum the spring hangs from.
`spawn-at-rest` in `cli spring` pins all of it: the three spawn poses against the closed forms, zero movement over 300 untouched frames, the exact authored spawn of the two controls, the chain length between the anchors as they land, and the ghosts reading the same three displacements with none for the controls.

## Spring bodies

A rigid body may instead be **spring-mounted** (`LevelBodyData.springFreqX` / `springFreqY` / `springDamping`): anchored to its authored position through a two-axis spring-damper, so it sags under its own weight, sags further under a load - a hanging player, a resting rock, chain tension - and springs back with a visible underdamped overshoot when the load leaves.
The first use is a plant whose leaf the player grabs, the spring standing in for the stem bending (`TEST_SPRING`).

It is a flag-set on `rigid` for exactly the reason `pivot` is, and the reason is the load paths: every one of them - contacts, the character push, the rope and chain solvers, explosions, water - already speaks to a `RigidBody2D` through impulses, so a `RigidBody2D` with one extra force couples to all of them with no new plumbing.
The alternative, an `AnimatableBody2D` running its own spring sim, collides as infinite mass and would feel none of them without bespoke force-sensing at every interaction site.

Where `pivot` removes translation, `spring` removes **rotation** - a leaf on a stem translates, it does not spin - and the two are mutually exclusive, since together they describe a body that cannot move at all.
The removal is at the source in the same way: `inverseInertia` reads 0 while `spring` is set, which covers every impulse path at once, and `World.integrate` zeroes `angularVelocity` before the rotation step because an inverse inertia of 0 does not cover a direct write (water's angular drag is one).
It is deliberately NOT `inertia = Infinity`: `mechanicalEnergy` computes `0.5·inertia·w²` and `Infinity·0` is NaN.
The rope is again the one solver that does not deal in inverse inertia, so `getDynamicBodyState` hands it a spring body as `inertia: Infinity` and the split's other indeterminate limit is written out alongside the pivot's (`linearFactor = 1`, `angularFactor = 0`): the whole correction lands in translation, which is the axis the spring then recovers along.

The force is a damped harmonic oscillator per axis about the anchor, `a = -w²·offset - 2·zeta·w·velocity`, folded into the same semi-implicit Euler step gravity takes.
Applied in the gravity phase and not as an impulse, which is what keeps it outside `auditImpulses`'s window - it snapshots velocities around `solveContacts` only, so a force applied there needs no pair bookkeeping, exactly like gravity.
The audit's **angular** half is exempted for a spring body, mirroring the linear exemption a pivot gets: with inverse inertia 0 an applied torque turns it nothing and the difference is the stem's reaction, which nothing models.
The linear half stays audited in full, which is the point - being loadable through ordinary impulses is the whole reason this is a rigid body.

Authored as a **frequency in Hz**, not a stiffness, and the choice carries three things.
It is a 1/s rate, so like `drag` it passes through `scaleLevelData` untouched and there is nothing that can be mis-scaled.
The free oscillation is mass-**independent** (`k = m·w²` is implied), so a leaf re-authored in a heavier material bounces at the same rate and droops the same amount under its own weight.
And the two numbers an author is actually choosing have closed forms - `droop = g/w²`, and an external load `F` adds `F/(m·w²)` - so a heavy stiff plant barely notices the player and a light whippy one plunges.
That second one is deliberately mass-dependent, and the editor shows both as live readouts beside the frequency, next to the mass readout they are tuned against.
0 or absent on an axis **pins** that axis to the anchor instead (a leaf that only bobs vertically); frequencies are clamped to 0..8 Hz, which is already visually rigid and well under the ~19 Hz where semi-implicit Euler stops being stable at the fixed 1/60 step.

The one load path that was missing is the **ledge hang**, which pins the player kinematically to the corner and applies no force to the body it hangs from - correct for a static or a mover, and for a spring body it means a hanging player weighs nothing.
`applyHangLoad` (`classes/states/ledgeLoad.ts`) transfers it explicitly, one frame's `m·g·dt` at the corner, from both `LedgeHangState` and `LedgeClimbState`.
The coupling is one-way and stable by construction: the player is positionally pinned and the hang re-derives the corner's world position every frame, so it rides the droop down the way it already rides a mover, while the body feels a constant weight.
Standing on a spring body is the case that is *not* principled yet - the character push (`CHARACTER_PUSH_FACTOR`) transfers approach velocity rather than standing weight, so a stood-on leaf depresses somewhat but not by a derived `m·g/k`.

`cli spring` is the detector, and it asserts the arithmetic rather than a settled solver: the droop against `g/w²` at three frequencies, the hang against `F/(m·w²)` through `applyHangLoad` itself, a chain-hung weight against the *same* `F/(m·w²)` (the chain is the one load path that is a positional constraint rather than an impulse), the per-axis periods against `1/f` by zero crossings, the two locks at `=== 0` (they are held by a snap, so "small" would be the bug), a box resting on the leaf with the audit armed, the elastic-energy term, the authored fields with their clamp and the pivot exclusion, and a no-spring body's free fall bit-for-bit.

`chain-drain` is the odd one out and worth reading before the next "the swing feels dead" report.
The obvious way to ask whether the chain is treating a spring body honestly is an energy budget - a PBD link is rigid, does no work, so it may remove nothing beyond the dashpot's `2·zeta·w·m·v²` - and it does not work, because the chain rewrites the body's velocity twice a frame (the integrate step, then the solve's credit) and that integral comes out three times larger or smaller depending which sample you take.
What is unambiguous is the **comparison**: two rigs identical but for the anchor, one on a `StaticBody2D` and one on a spring body, same weight, same chain, same kick.
The static rig is the rope solver's own baseline, and this engine's chain is genuinely lossy - a taut pendulum on a rock-solid wall gives up **97% of its kick in 20 seconds**, which is a property of the PBD solve and nothing to do with spring bodies.
Measured side by side the spring anchor gives up 15.83 J against the wall's 15.69 J and leaves the weight moving four times faster, so a swing on a spring body dies no faster than one on a wall; what makes an authored one *feel* dead is the authored damping, which at zeta 0.15 and 1 Hz on a 110 kg body is a ~200 N·s/m dashpot sitting between the chain and the world.
Lower `springDamping`, a higher frequency or a heavier body are the three knobs, and the editor's droop readouts are what they are tuned against.
`mechanicalEnergy` carries the elastic term `0.5·m·(wx²·dx² + wy²·dy²)`, without which the leaf springing back reads to `EnergyMonitor` as an unforced gain; damping only removes energy, so its one-sided bound stays valid.
`playtests/ledge-spring-leaf.json` is the mechanic end to end - run off a lip, catch the leaf, ride it 31 cm down, let go - and it is red on a hang that transfers no weight.
`session-111f` is the recorded artifact: an authored ball level whose chain is anchored to a spring platform, in the corpus so the coupling stays bit-for-bit.
The editor authors the three fields beside the pivot checkbox, each control disabling the other, and marks the mounting with a coil at the centre of mass, aligned to whichever axes are actually sprung.

## Force areas and surface friction

A **`force`** body is a `ForceArea` (`engine/body.ts`, an `Area2D`): a region that
accelerates every velocity-carrying body inside it — the grapple avatar and hook
(`CharacterBody2D`), the ball, its hook and loose debris (`RigidBody2D`). `World.integrate`
applies it before gravity, so a body entering is carried on its first frame inside. The
direction is the area's **own rotation** (local +X, so `rot` 0 flows right) and `force` is a
signed magnitude in px/s² on disk, m/s² in the sim — negative reverses the flow. It is
deliberately an *acceleration*, not a true force: a current carries light and heavy bodies
alike, so one authored number behaves the same for the avatar, a pebble and a boulder. Areas
are not wrap bodies; the rope passes straight through.

What an area *contains* is decided by one predicate, `shapesOverlap`, shared by the force
areas, the killzone notifications and the world's overlap query.
Its vertex-vs-vertex branch is the separating-axis test (`shapeContacts` at slop 0) behind a
bounding-circle reject, and the exact half of that is not optional: it used to be the
bounding circle alone, which for a rect is its half-**diagonal**, so a long thin area reached
as a disc many times its own size.
The ball arena's 31.5 × 0.7 m river current reached 15.75 m in every direction, and a plank
hung on scene chains 5.6 m *above* the water was accelerated sideways at a steady 3 m/s²,
swinging a metre off its anchors and failing `energy-gained` twice in the first 100 frames of
a level nobody was even playing.
The avatar is a circle and circles take the exact branch, which is what kept it looking like
a chain bug: only a rect or polygon body could be in the wrong, and until scene chains there
were none in reach of an area.
`area-reach` (`cli contacts`) is the statement - a body clear of the volume is untouched
however close the bounding circle passes, a body inside is carried, and a body dipping one
corner in is carried too, that last one being what stops the fix collapsing to a
centre-inside test.

**`friction`** (0 = ice, 1 = rubber, default 1) is a property of every non-area body,
carried on the engine body as `CollisionObject2D.surfaceFriction`. It scales the contact
friction terms another body applies *against* it: `GROUND_FRICTION` in `GroundedState`,
`WALL_FRICTION` in `OnWallState`, and a rigidbody's Coulomb `contactFriction`, stiction
`staticFriction` and `contactDamp` in `World.resolveRigidCircle`. Every scaling is a plain
multiply so the default 1 multiplies by *exactly* 1 and is bit-identical to the historical
constants (recorded replays predate the field) — `contactDamp` is the one exception, since
`1 - (1 - 0.98) * 1` does not round back to `0.98`, so it takes an explicit `grip === 1`
branch. Locomotion *acceleration* is untouched: friction models how a surface slows you,
not how hard you can push off it.

A river is the two composed: a `force` area over a low-`friction` bed. On a default rubber
bed the ground friction (≈7 m/s² of deceleration) swamps a 3 m/s² current and the avatar
barely drifts; drop the bed to ~0.15 and the same current carries it.

An authored **`rigid`** body reads that same `friction` in *both* directions: it scales what
the body offers a contact (`surfaceFriction`, as for any body) and, in `buildBodies.ts`, the
Coulomb coefficients the body itself brings to one.
A crate is slippery to stand on and slides on the floor it sits on for the one reason, and
since the contact solve multiplies the two sides together, an ice block on an ice floor is
frictionless read from either end.
`RigidBody2D`'s class defaults are 0 and must stay 0 - recorded replays predate the fields,
and the avatars that want friction set their own - but a piece of level scenery is exactly
what those defaults are wrong for.
With no coefficients the only thing resisting a shove is the 0.98 `contactDamp`, which is a
pure exponential coast and never grips: a crate nudged by the player glided a metre across a
flat floor and was still drifting three hundred frames later (`session-477f`).

**Both** coefficients, because kinetic friction alone is not enough to be called friction.
Coulomb friction is capped at μ × the frame's normal impulse, which on a resting body is
just gravity's bite (g·cosθ·dt), so it cancels the *velocity* gravity adds each frame but
never the *step* the integrator already took with it - a box on a 5° ramp still walked 21 cm
in fifteen seconds and was not slowing.
Holding a slope is what the **stick anchor** does, and `staticFriction` is what arms it.
The cost is real and is the reason stiction is a body-versus-**static** idea and stays one:
the anchor pins the body's along-surface position, so anything else writing that position - a
chain hauling the crate, or the other body's own resolution pass - undoes it every frame.
Against a **static** surface the pin has no rival, and the grip releases the moment the body
moves at all (`STICK_SPEED`), so a chain with any real pull on it still drags the crate;
both bundles with a chain anchored to a rigid polygon stay healthy, with the chain's
blocked-length lease paid back to zero (`session-431f`, `session-1474f`).
The numbers are a slab of scenery's, not the rolling ball's: μ_s ≥ μ_k, as for a body that
slides rather than rolls, and μ_s = 0.7 puts the breakaway at atan(0.7) ≈ 35°.

Turning stiction on for scenery also surfaced a defect in the **manifold** stiction path:
it kept the body's whole normal velocity, including a component pointing *into* the surface,
which a gripped body can never realise.
That path is the one that leaves such a component behind - zeroing the spin discards the
angular half of the normal impulse solved just above it, so the linear approach that impulse
was cancelling survives - and the push-out then hides it.
A crate settled flat on a floor sat at a perfectly stable position while reporting a
permanent 0.275 m/s into the ground, re-earned and re-pushed-out every frame.
The manifold path now keeps only the *separating* part; the circle path deals in a single
contact whose normal impulse is not split, so it is left bit-for-bit alone.

Two more things stiction-on-scenery broke, and both come from the same root: the grip was
written for the **ball**, and a ball is a circle.

The grip **zeroed `angularVelocity`**, which for a circle is free - rotation cannot change
which part of the shape is holding it up, so a settled ball simply should not be spinning.
A vertex shape's orientation *is* its balance, and freezing the spin of a gripped one holds
its pose by fiat: gravity gets no say, and a slab tipped up on a corner can never topple back
down.
Worse, nothing anchors the *angle* the way `stickAnchor` anchors the position, so any
rotation written after the contact solve is kept in full and re-frozen next frame - a chain
that turns the body a fraction of a degree per tug ratchets it round for good.
That is what `session-1195f` reported: a polygon group a chain had walked from -13° to -22.8°
stayed there with the chain gone, reading as gravity having been switched off for it.
The manifold path now leaves rotation alone.
The per-point normal impulses are what resist rotation - which is what a two-point manifold is
*for* - and a body that really is toppling spins past `STICK_SPIN`, releases the grip and
falls.
The grip stays what it is meant to be: a brake on translation, not a lock on pose.

The second is that **rigid-rigid contact friction may not read a motion it cannot answer**.
The one-sided routine measured slip relative to the surface the other body presents, which for a
static body or a scripted mover is right - an infinite-mass surface whose motion is a given, and
being dragged along by it is the whole point.
Two *dynamic* bodies were a different situation, because that routine was not one half of a
reciprocal impulse pair: it wrote only to `body`, and the other direction was a separate call on
a separate pass, sized independently. Nothing made the two equal and opposite, so any impulse
taken from the other body's motion was energy the contact invented, and it became a **motor** the
moment level rigid bodies stopped having `contactFriction = 0`.
A ball merely *hanging* on a chain walked its anchor **3.6 m** across the level that way
(`session-611f`), at a dead-steady 2.4 mm a frame, for ever.

The pair solver makes relative slip legitimate again, and that is the point of it: an equal and
opposite impulse means the reaction is real, so two crates now grip each other properly.
The ball's kinematic spin still drives through friction, and must - that is how a steered ball
rolls. It is bounded by the Coulomb cone rather than by being read out of the slip; see **A
kinematic spin is a conveyor belt** under **The contact solver**.

What is left is longer *legitimate* blocks, because that is what removing the relief valve
means: geometry that no longer slides out from under a taut chain holds it until the ball
itself settles.
The corpus ceiling went 11 → 46 frames (`session-431f`, over which `maxRopeLength` does not
move at all and the lease is repaid to exactly zero), so `CHAIN_STALL_FRAMES_TOLERANCE` is 60.
`rope-grew` holds the gap the blunter count leaves.

The contact solver moved that ceiling again, and there is now **almost no headroom**: the worst
run in the corpus is `session-1195f` at **58** frames against the tolerance of 60, where it was 8.
It is one outlier and not a shift - the second worst is 15 - and the block is real: over the whole
run the ball is at a dead stop, wedged against the face of the rigid polygon its 0.2 m chain is
anchored to, with the chain coiled on its own rim; `maxRopeLength` does not grow (180 cm, against
184.5 before) and the lease is released at f455. A converged solver holds scenery still, and a
chain anchored to a crate that stays put is blocked until the *ball* settles.

The consequence to face is that **the frame count has lost most of its discriminating power**.
It was sharp when healthy runs topped out at 17 and the runaways read 79, 51, 36, 32 and 28; a
legitimate 58 now sits inside that band, so no threshold can separate the two on count alone.
`rope-grew` is what holds the gap, and it is the invariant to sharpen if a runaway ever slips
through - raising `CHAIN_STALL_FRAMES_TOLERANCE` buys margin by giving up detection, which is
the wrong trade in the one place a runaway is still cheap to catch.

## Water

A **`water`** body is a `WaterArea` (`engine/body.ts`, an `Area2D` beside `ForceArea`): a
region that **drags** whatever is inside it toward a current instead of pushing it along one.
It is the same slot in the frame as a force area - `World.applyWaterDrag` runs from
`World.integrate` before gravity, on both velocity-carrying body types, using the same exact
`shapesOverlap` containment test - and a different law:

```
v <- (v + drag*dt*flow) / (1 + drag*dt)
```

`flow` is a **speed** along the area's own rotation (px/s on disk, m/s in the sim, signed as
`force` is) and `drag` is a **rate** in 1/s. Exactly one of them is a length, which is the
thing to get right in `scaleLevelData`: a `drag` scaled by `PX` is water that takes twenty
seconds to notice a body is in it, and neither error shows in the editor, where both are
displayed in the units they were typed in. `cli render3d`'s `water round-trips px -> m -> px`
is what holds it.

Everything a level wants from running water falls out of that one line. The current is a
speed things settle **at** rather than an acceleration with no ceiling, so being slowed by
the water and being pushed by it are the same act - which is what a force area cannot say,
since a body left in one is flung. It is written **implicitly**, so it is stable at any
`drag` and any step and can never overshoot; the explicit form of the same equation diverges
past `drag*dt = 2`, and what that looks like is a body fired backwards out of a river. And
being an acceleration law it is **mass-independent**: the 52 kg ball and the 70 kg avatar
drift at the same speed, which is what makes "carried at a constant speed" a property of the
water rather than of what fell in it.

`submergedFraction` is how much of a body is under, from the boxes, and it scales the drag so
a ball dipping into the channel is slowed by the part of it that is wet. The two questions
are kept apart deliberately: **whether** a body is in the water is the exact overlap test
(see the arena-wide current under **Force areas**), and the boxes only ever say **how much**
of a body already known to be inside is under.

### Water takes traction with it

A current that only pushes free bodies is a current the player never feels, because the
player is not free: the ball rests on the floor of the channel, and the steered ball **grips**
what it rolls on. Two things follow, and both are needed.

`CollisionObject2D.submerged` (0..1, rewritten every frame) scales `surfaceFriction`,
`RigidBody2D.contactFriction` and `staticFriction` through getters, so every friction term in
the engine - the Coulomb cone, the stiction pin, the contact damping, the character
controller's ground and wall friction - reads a submerged body as the greasy thing it is
(`WATER_TRACTION_LOSS`, a fifth of dry grip when fully under). Both halves are needed and they
are not the same statement: the friction against a static floor is the moving body's
coefficient times the floor's, so scaling only what the water is standing **in** leaves a ball
gripping a dry-authored channel bed as though the water were not there. A level with no water
has `submerged === 0` everywhere and every getter answers the authored number, untouched.

Scaling is not enough for the **grip** itself, because that is a position pin rather than a
force: `applySteeringGrip`'s budget test compares gravity's tangential component against the
cone, and on level ground that is zero against anything positive, so it holds at any friction
at all - and the grip writes the ball's whole tangential velocity from the roll, so a gripped
ball in a river is a ball the river cannot move. Past `WATER_GRIP_RELEASE` of submersion the
grip is released outright and the solver's (now much smaller) Coulomb friction is what is left
holding the ball. In the sewer channel that is 0.7 m/s of steady drift against a 1.5 m/s
current: pushed back, but not swept away.

`cli contacts` `water-current` is the case, and its last two lines are the ones worth keeping:
a ball standing in the water is washed 2 m downstream in three seconds, and **the same ball on
the same dry floor holds**. The pair is what says the water did it rather than that the grip is
broken.

### Drawing a body of water

**There is no 3D water renderer. Water is an area like every other one**: nothing is drawn for it in the 3D scene, and the 2D overlay's flow-streak glyphs are the whole of what the player sees, in both renderers.

There was one - an extruded slab with a displaced waterline wearing a transmissive material - and it was removed because it never looked like water.
`buildWater` and `render3d/water.ts` are gone; `bodyVisuals` skips a `water` body explicitly rather than letting it fall through to `buildAuthored`, which would extrude its collision outline and dress it as ordinary stone.
A copy of the removed file is kept at `assets-src/water-removed/water.ts` with the two normal maps it used, since none of it was ever committed.

What follows is what that attempt learned, because every one of these was expensive to find and none of it is visible in the code any more.

- **`transmission` draws the whole scene twice.** Any transmissive object in the frustum makes three.js run `renderTransmissionPass`: every opaque object re-rendered into an offscreen target at full resolution with at least 4x MSAA, resolved, then given a full mipmap chain, once per frame before the visible frame is drawn. Measured on the ball arena: **42 draw calls and 788,844 triangles became 85 and 1,579,340**, and the frame cost 2.2x. Nothing can narrow what that pass renders - it takes the camera's whole opaque list - so the only lever is how heavy the scene already is. `renderer.transmissionResolutionScale` shrinks the target and its mipmap chain, though not the draw calls.
- **Emission is added AFTER transmission resolves**, so water bright enough to see by its own light is water you cannot see *through*. The glow paints over whatever the surface was refracting and the result reads as coloured plastic - which also means paying for that extra scene render to produce something invisible under the paint. A dark sewer wants the lamps to light the water, not the water to light itself.
- **The player sees the FRONT of the slab, not the surface.** The camera is near enough orthographic that a channel's top face is edge-on and a few pixels tall while its front face fills the screen, so ripple normals - the entire authored surface detail - land on a face no lamp reaches and do nothing. Any approach that puts its detail on the top surface is drawing something the player is not looking at. Raising the camera over the channel (a camera region) is the lever that changes this, and it is level authoring rather than rendering.
- **A slab's two faces need different texture coordinates.** On the front, y varies and z is constant; on the top, z varies and y is constant. One shared coordinate is constant on whichever face it is not built from, so a threshold on it has nothing to vary against and every patch smears into a vertical bar.
- **A displaced surface needs a GRID, not an extruded outline.** `ExtrudeGeometry` triangulates its caps by earcut over the perimeter with no interior vertices, so a long thin channel gets triangles running its full depth: measured, **1394 of them spanned more than 0.2 m of a 0.46 m channel**. A displacement with a vertical gradient shears every one of those, and what it draws is smooth hills the size of the channel with the triangulation creasing across them.
- **A wave sum is sampled by the vertices**, so the vertex spacing has to resolve its highest harmonic or the surface is an alias. At a 0.12 m resample a 29.3 rad/m term got 1.79 samples per wavelength, under Nyquist, and drew a beat the size of the channel. Six samples per wavelength is where a sum of sines stops looking sampled.
- **A texture must ride the surface it is painted on.** UVs taken from the undisplaced vertex leave the mesh rising and falling through a texture that stays put, and the surface visibly slides against its own markings.
- **Stretching noise by sampling `x / stretch` breaks tiling**, since it reads only the first `1 / stretch` of the field's width. Every repeat then draws a hard seam. Stretch in the lattice instead.
- **three ships `Water2`** (the Valve dual-cycle flow-map technique) and it does not transfer: its flow-map machinery solves *spatially varying* flow shearing a texture, which a straight channel at constant speed does not have; it targets a flat horizontal surface seen from above; it brings a reflector and a refractor, two more full scene renders on top of the transmission pass; and it draws no side face, which is most of what this water is.

Water's PHYSICS is untouched by any of this - see **Water** above for the drag law, and **Water takes traction with it** for what being submerged does to grip.


## Positional recovery

The contact routines in `World.resolveDynamicCollisions` solve **velocity**.
Position is recovered separately, by a scene-wide sweep at the end of the step: `DEPENETRATION_PASSES` passes, each giving every rigid body one `depenetrateRigid` pass.
The pair solver inherits that split unchanged - it changes velocity resolution only - and keeps a per-pair push of its own (`separatePairs`, one push per `(shape, shape)` pair at that pair's deepest point, split by inverse mass so a light body against a heavy one is the one that gives way).
Leaning on the sweep alone is not equivalent, for the reason below: it resolves only the two deepest overlaps per body per pass.
A speculative contact is skipped there - it is not overlapping, and pushing along a negative depth would drag the pair together.

The standard alternative, if `penetration` ever regresses, is a nonlinear Gauss-Seidel position pass over the *same* `ContactConstraint` list - per-contact, correcting only penetration beyond a slop and only a fraction of it per iteration - which is gentler and converges piles the two-deepest heuristic cannot.
It is also, not coincidentally, what would stop the sweep injecting a same-sign positional drift into a settled pile, which is one of the things `stack` is still measuring.

They used to do both, pushing out per `(shape, shape)` pair along that pair's own deepest contact and in ignorance of every other pair.
That is the wedge failure `moveAndCollide` and `depenetrateRigid` were each fixed for, in their own words - pushing fully out of one surface can push straight into another, and whichever pair was handled last wins - and the fix was simply never applied here, so a body touching two things at once could not settle against either.
A slab leaning on another polygon with its lower end on the floor is exactly that wedge, and it stood **165 mm** inside them, buzzing: penetration that deep churns the contact set frame to frame, so the normal impulse fired about one frame in five while contact friction went on torquing the body every frame, and the slab's spin sawtoothed between -0.18 and +0.13 rad/s for as long as it slid (`session-326f`).
The whole polygon corpus now stands at **5 mm or less**.

Four things about the sweep are load-bearing, and each was found by getting it wrong:

- It runs **after** every body's contacts, not at the end of each body's own pass.
  Depenetration is a race - whoever moves last wins the overlap - so a body recovered mid-loop is answering a scene that is still half-solved, and a heavier or simply later-listed neighbour walks through it.
  Interleaved, a falling slab drove the ball a quarter of a metre into the floor; swept afterwards, the two settle against each other.
- It is **every** rigid body, not only the vertex-shaped ones the bug was visible on, for the same reason: granting the iterated whole-body solve to the polygons alone let them out-muscle the ball by 34 cm.
- The per-pair push-outs are **kept**. Leaning on the sweep alone is not equivalent, since it resolves only the two deepest overlaps per pass, and removing them left the ball 240 mm inside the ground.
- A gripped body's **`stickAnchor` rides along with whatever the sweep moves it by**.
  The anchor is a positional constraint of its own - it is where the surface had hold, and the grip pins the body's along-surface position to it - so putting the position solve after the contact pass took the last word away from it, and the two fought: the grip dragged the body back to an anchor the sweep had already found to be inside something, the sweep pushed it back out, and a polygon resting perfectly still on the floor buzzed **49 mm** back and forth for as long as it sat there (`session-255f`, now 1.2 mm).
  Carrying the anchor with the correction does not weaken the grip, because what stiction exists to cancel is the tangential *drift* gravity integrates in one step, and that is measured against the anchor and unaffected by moving both.
  It is the trick the steered-ball coil path already uses, where the anchor advances by the roll the frame intended and only the creep on top is removed.

`depenetrateRigid`'s **crush** branch was the other half.
Two near-opposite faces have no finite simultaneous solve (the denominator explodes as `c → -1`), and the fallback used to resolve the deepest face in full and accept a residual - which is precisely the sequential pushout the simultaneous solve exists to replace, reintroduced in the one branch where both surfaces are certain to be real, and iterated, so the last pass wins and the error compounds.
A ball resting on the floor with a slab landing on it was shoved 33 mm up out of the floor, which buried it 47 mm in the slab, which shoved it 47 mm back down - net deeper than it began, every frame, until it was a quarter of a metre underground.
The two demands are mutually exclusive, so the branch now **equalises** them: move along the deeper normal by half the difference, leaving both faces at the mean depth and a body already centred between them exactly where it is.
Resolving the *static* side in full instead, on the argument that a static surface cannot get out of the way and a rigid one can, is the tempting refinement and it is wrong - it re-buries the body in the rigid face and the next pass pushes it straight back, which is the same ping-pong under a better motive.

## The contact solver

Rigid-vs-rigid contacts go through **`World.solveContacts`**: the sequential impulse solver (Catto, GDC 2006), the formulation Box2D uses and effectively every 2D engine has converged on.
Nothing about these rigid bodies is novel, so the answer to a design question here is "what does Box2D do" unless the rope gives a specific reason otherwise.
The novel mechanic is the rope, and the rope is exactly the part this does not touch: it stays a PBD pass after `World.integrate`, reading the velocities the contact solve leaves.

`collectContacts` flattens the scene into one `ContactConstraint` per manifold point, over **ordered pairs** (`i < j`).
That is the whole point.
The routines this replaced looped over bodies and, for each body, over every other, so the pair A-B was visited **twice** - once with each as the subject - and each visit wrote only to itself and took `RIGID_PAIR_SHARE` of the contact in ignorance of the other.
Two one-sided solves are not an impulse pair: nothing makes them equal and opposite, so momentum was neither conserved nor transferred, and a body landing on another **stopped** it rather than knocking it round (`session-120f`, where the top of two compound groups lands square on the bottom one and the bottom one's spin is cancelled from 0.10 to -0.06 rad/s by the very contact that should have driven it).
One impulse, computed once, applied both ways: `cli contacts` `momentum` went from an error of 2.4e-3 against a 1.5e-8 tolerance to **4.5e-18**, which is machine precision.

Order is a pure function of body index, shape index and point index; nothing is ordered out of a map or a set.
`a` is chosen without reference to list order - the dynamic body, or the lower id when both are - so adding or removing a body mid-run cannot flip an existing pair's roles and miss every warm-start key it has.

Four things about it are load-bearing.

**Warm starting.** Each constraint begins from last frame's accumulated impulses, matched on `(a, b, shapeA, shapeB, featureId)`, applied equal and opposite before the first iteration.
This is not an optimisation. Cold started, the iterations have to re-derive a pile's entire support load from scratch every frame and with any finite budget never quite get there, which is the class of residual-jitter bug the resting-contact work below has been chasing one symptom at a time.
A cached impulse is a *starting guess* and never a claim about state, so a stale entry is simply dropped, a wrong guess costs iterations and not correctness, and the rope rewriting the ball's velocity after the solve does not invalidate it.

**`CONTACT_SLOP`, and why a resting pile has no contacts without it.**
A pile at rest is pushed to exactly zero overlap, and then every body in it falls by the same gravity step - so the interfaces between them never re-penetrate at all.
At a strict "overlap > 0" a resting stack's own contacts *vanish from the set* on the frames it needs them most: the four-box pile's contact count flickered between 0 and 3 of an expected 6, warm starting had nothing to hold across a frame, and the noise from re-deriving the pile every time its contacts flickered back walked it apart across the floor.
Points within the band are kept as **speculative** contacts carrying a *negative* depth; they ask for no impulse unless something is approaching fast enough to close the gap within the step, and above all they persist. The stack now holds 6/6 contacts with 6/6 warm-start hits.
`shapeContacts`'s `slop` defaults to 0, and must: a caller that pushes bodies out along `depth` would otherwise push a separated pair *together*, which is every positional-recovery site.

**A kinematic spin is a conveyor belt, and the cone is the only thing that bounds it.**
A body whose rotation is driven externally (the ball's aim steering, which overwrites `angularVelocity` every frame) has infinite rotational inertia here, because no impulse applied to its spin survives the next frame.
The slip it presents at a contact is therefore an infinite reservoir, and friction reading that slip *is* a motor - which is exactly the mechanic: it is how a steered ball rolls, and it has to work against a rigid body just as it does against the world.
What keeps it honest is that the drive is Coulomb-capped. The ball can spend `mu` times its own weight; a crate's grip on the ground is `mu_s` times the weight of the crate **and** the ball riding it, which is strictly more, so the crate holds.

The tempting fix is to take the kinematic spin out of the friction slip, on the argument that a contact should not read a velocity it cannot affect.
It is wrong, and the two cases pin it from both sides: it makes `spin-drive` pass by making the ball unable to drive **anything**, which is the same statement as being unable to roll along scenery.
A ball spinning at 20 rad/s rolled 49.5 m along a static floor and **0.0 cm** along the identical floor made of scenery (`session-314f`).
`roll-drive` asserts the two agree; `spin-drive` asserts the crate still holds. Neither can be satisfied by weakening the other.

**Only contacts that pushed back count as contact.**
`contactDamp` is applied once per body per frame, to the bodies that met something - and a speculative contact carries no impulse, so it is not something met.
Damping a body for being merely *near* another is a permanent brake on something that is not touching anything: a ball hanging on a chain a centimetre clear of a crate was slowed 2% every frame, the chain read that refusal as a block, and the winch stall paid out slack against it for ever - 1.7 m of chain grown to 3.7 and never released.

**Static contacts are in the same list.**
They enter as one-sided constraints with zero inverse mass and inertia, which is what lets one solver handle both without a branch - and it is not a tidiness argument, it is the difference between a pile converging and not.
A load path runs *through* a static contact: a four-box pile carries the top box's weight down to the floor and the floor's reaction back up. Solved in two separate systems, the bottom box is pressed on by the box above while the pair solve believes it is unsupported, and the floor corrects it only afterwards - so the error reverses every frame and sawtooths. The pile sheared apart and landed spread over a metre and a half of floor, a triangle resting on the floor held a 0.203 deg limit cycle for ever, and two compound groups leaning on each other jittered at 0.033 rad/s indefinitely while the ball resting on one of them was ratcheted 13 cm downhill by the vibration (`session-298f`).
In one system all three settle to **exactly zero**.
That the answer now responds to `VELOCITY_ITERATIONS` at all is the tell: while the systems were split, 8, 32 and 128 iterations landed within 5 cm of each other.

**No contact stays out**, and the last one that did was a load path.
A circle against static geometry used to be solved whole by `resolveRigidCircle` - normal, friction, grip and pin - in its own pass after the constraint solve.
So a rigid slab resting on the ball was solved against a ball the solver believed was free to move, because the floor holding that ball up was in the other system: the slab pressed, the ball gave way on paper, the circle pass then stopped the ball against the floor, and the slab kept a permanent **0.229 m/s** into a ball that was going nowhere, for as long as it sat there, with the depenetration sweep quietly absorbing the difference every frame.
It is the same argument as the four-box pile, one shape kind later, and it was found by `cli query` on the `ball-wedge` mechanic scene rather than by anything going visibly wrong.
Folded in, that slab reads exactly zero.
What is left of the circle path is `applySteeringGrip`, which is not a contact solve: the aim steering drives the ball's rotation kinematically, with full authority and no force behind it, so the roll it implies is written as a velocity after the solve and cannot be expressed as an impulse the cone would cap.
Vertex shapes have no such path left either: `applyStaticGrip` is all that remains of `resolveRigidLoop`, and it is only the position pin.
The *velocity* half of stiction is gone, because it was always a Coulomb-capped tangential impulse solved at the contact points, which is exactly what the tangential constraint is; keeping a second copy would apply friction twice.
What no velocity constraint can remove is gravity's per-frame integration *step*, since this engine integrates before it solves - so the pin stays, as the honest patch for that ordering rather than as a leftover.

## Resting contacts

A manifold's normal impulses are solved as **one system**: accumulated per point, iterated `NORMAL_SOLVER_ITERATIONS` times on the static path (`VELOCITY_ITERATIONS`, Box2D's 8, over the scene-wide constraint list), with each point's *running total* clamped at zero rather than each increment clamped on its own.

Solved once each behind a `vn < 0` gate, the two points of a resting face cannot converge, and the reason is structural rather than a matter of tuning.
Point A's impulse acts through a lever, so it rotates the body and pushes point B in; B's impulse pushes A in; and because neither may ever *pull*, the pass ends with the pair having overshot in opposite directions.
What is left over is a spin, and next frame it returns with the sign flipped.
A polygon lying still on the floor sawtoothed between -0.07 and +0.11 rad/s for as long as it rested there, wobbling about a third of a degree - some millimetres at the end of a long body, which is what reads as vibration (`session-255f`).

**Restitution is gated on the approach speed** (`RESTITUTION_THRESHOLD`, 1 m/s), everywhere and not only in the pair solver.
A resting contact closes at whatever gravity integrated this frame - 0.163 m/s - and bouncing that back is a bounce that never ends.
The ball is 0.15 elastic, and its own contact path had no such gate, so a ball sitting perfectly still on the floor carried a permanent **21 mm/s upward**: it fell 2.7 mm, was thrown back at 24 mm/s, and did it again every frame for as long as it rested.
Nothing moved - the stick anchor pinned the position it was bobbing around - which is exactly why it survived every check the suite had, while putting the scene's at-rest kinetic energy three orders of magnitude above zero (`cli settle` read 1.2e-2 J for a scene where nothing was moving; it now reads 1e-32).

Accumulating is what buys the fix: a later iteration may hand back part of an earlier one, as long as the point's total stays non-negative, so the pair settles on the load split that actually holds the body still instead of each over-correcting for the other.
This is the standard sequential-impulse formulation, and it is the one thing the resting case genuinely needs.
Restitution is taken from the approach velocity measured **before** any of it, never re-derived per iteration - re-applying a bounce to a velocity that already contains it is how an iterated solver invents energy.

Bodies now go properly to sleep: a settled polygon holds `|ω|` around 0.0007 where it used to hold 0.1, a dropped-and-settled pile finishes at exactly zero velocity, and a stack resting on itself wobbles 0.16° / 1.4 mm against 0.28° / 5.7 mm before.

Static friction is **Coulomb-capped**, at `mu_s` times this frame's normal impulse plus gravity's bite - the same quantity the kinetic path caps against, so the two agree about how much load a contact carries.
It is a limited force, and unclamped it supplied whatever was asked, which welds a resting body to the ground: measured at 1.5x to 7x more tangential impulse than friction there could ever have provided (`session-120f`).
A body resting on a slope is unaffected, since its demand is `m*g*sin(theta)` against a cone of `mu_s*m*g*cos(theta)` - it holds exactly while `tan(theta) <= mu_s`, which is the breakaway angle the grip already advertised.
Asking for more than the cone gives means the contact is sliding, so it gets no position pin and does not count as a grip; the clamped impulses are already Coulomb friction at the limit, which is what a sliding contact should feel.

Static friction is otherwise solved the same way as the normal impulses, and is a decision about the **body** rather than about each point - it is one statement about whether this contact is slipping, and the manifold's points share a normal, so asking per point only let one point grip while its twin ran the kinetic path.
Two things about it were wrong and are worth keeping straight.

It used to **overwrite** the body's velocity, which throws away the linear half of the normal impulse the accumulated solve had just computed: that solve splits one impulse into a Δv and a Δω through the coupled effective mass, and discarding the Δv leaves the Δω behind as an unbalanced torque, a few thousandths of a rad/s freshly minted every frame with nothing to answer it.

And it cancelled the velocity of the body's **centre**.
Static friction forbids the *contact* from sliding and says nothing about the centre; a body pivoting about its contact point must have a moving centre, since that motion is precisely what holds the contact point still.
Forcing the centre still while rotation ran free therefore made the contact slide by construction, and the position pin then held the centre while the shape ground through it - a polygon resting on a corner turned 27° over four seconds at a steady creep that neither settled nor fell over (`session-390f`).
Read at the contact points and solved together, a genuine pivot costs nothing, a sliding body is held, and a body wanting to topple spins past `STICK_SPIN` and stops being gripped at all.
That body now holds, topples once at -0.68 rad/s, and settles dead.

The **position pin anchors the contact point too**, not the body's centre - the same correction as above, in position rather than velocity, and it survived the velocity fix for the same reason it was easy to miss there.
A body pivoting about its contact point must move its centre, so holding the centre still is an instruction to slide.
Held that way, a slab settled on one corner had its spin bled off geometrically - 0.021, 0.013, 0.008, 0.005 rad/s, about a third gone every frame - with no contact anywhere near it doing the braking; it simply stopped mid-turn and stood there (`session-1426f`).
The anchor is a **material** point of the body (`stickLocal`, the gripped contact in the body's own frame), not the manifold point itself: that one is geometric and slides along the contacting face as the body settles, so anchoring it directly sent bodies drifting 80 cm *up* a ramp.

The **stick anchor survives a few ungripped frames** (`STICK_RELEASE_FRAMES`) rather than being dropped on the first.
It has to go eventually, or a body that has left the ground snaps back to a stale spot, but the grip flickers: the normal solve leaves a little spin, and every eighth frame or so it crosses `STICK_SPIN` and the gate says no.
Releasing on a single miss re-seeded the anchor wherever the body had drifted to, and the drift is always downhill, so a crate ratcheted 21 cm down a 30° slope it is meant to hold, a few tenths of a millimetre at a time.

Two things were tried first and are worth not repeating.
**Widening the manifold** so a point within a few mm of the surface stays in it does not help: the second corner of a resting face is not flickering at the micron scale, it is genuinely rocking 3-7.6 mm off the ground, so a slop band only moves the threshold the flicker happens at.
**Damping spin inside the stiction grip** is worse than the disease - it is the pose lock in a softer form, stalling a body part-way through a topple and leaving it to creep, and it took a clean settle from 0.2° to 7.8°.

### The position pin

The pin is **relative**, and its anchor is a material point of the SURFACE, held in the surface's own frame.
Against a static that is the same statement as a world-space anchor, since a static never moves; against another rigid body it is the only statement that means anything, and holding one was the missing piece.
A body resting on a rigid body had no pin at all, so it kept the whole of gravity's integration step every frame: the velocity solve cancels the velocity gravity added and never the *step* already taken with it, and the recovery then resolves that step along the contact face - which on an inclined one turns a 2.7 mm fall into 0.6 mm of **sideways** travel.
Nothing accelerated the body into that motion and nothing ever takes it back, so it is a ratchet: slabs slid 53 cm and 66 cm across `255f` and `326f` while reporting velocities of 1e-8 m/s, which is to say invisibly to every check the suite had.
`cli contacts` `rigid-ramp-hold` was the same thing written down as a case, and carried an `expectedFail` marker until this closed it.
The steered ball reached the same gap from the other side and was fixed later, in `applySteeringGrip` rather than here (see **The steered ball's grip**): it is the one body `applyStaticGrip` declines, so closing the pin for every other body left it as the last one creeping.

Four things make a relative pin friction rather than a weld, and each of them was a red case first:

- **Coulomb, in position.** The correction is capped at `mu_s` times the normal impulse the contact actually carried this frame, as a displacement: `mu*Pn*(1/m_eff)*dt`. Uncapped, a pin whose anchor had gone stale hauled a struck slab 200 mm *inside* the body that struck it.
- **Asking for more than the cone allows means it slipped**, so the capped correction is applied and the anchor is re-seeded where the body now is. Remembering the excess is the pin hauling a body toward a place it slid away from frames ago - 3 mm of positional work per frame in `298f`, which the energy invariant reads (correctly) as 17 J invented out of nothing.
- **Split by inverse mass, applied to both bodies**, so a light body on a heavy one is the one that gives way.
- **A contact is offered a pin by what it CARRIED, never by its depth.** The gather's depth
  is float noise on a resting interface (the solve pushes it to exactly zero) and
  systematically non-positive for a CCD body, which is seated at exact touch every frame -
  the hook is `continuous`, so the old `depth > 0` gate refused its resting contact the grip
  for ever and it slid down the shallowest slope. `normalImpulse > 0` is the honest test,
  the same lesson `steered-ramp-hold` taught the steered grip.
- **One pin per body, to whichever surface carries it** - the pair with the largest normal impulse, offered from *both* sides of every pair. Which body leads a constraint is an id ordering and nothing more, so pinning only the leader pinned whichever of two stacked slabs happened to be built first, and taking the first pair instead of the loaded one let a crate being shoved by a spinning ball anchor itself to the **ball** and let go of the floor (`cli contacts` spin-drive).

The anchor rides along with the **normal** part of what the depenetration sweep moves the body by, and with none of the tangential part.
It has to follow the normal push or the two fight - the grip dragging the body back to an anchor the recovery had just found to be inside something, which buzzed a resting polygon 4 cm back and forth for as long as it sat there (`session-255f`).
Along the surface it is the opposite: the anchor *is* the grip, and carrying it sideways is the same as not being pinned in the direction that moved.
`PIN_RELAX` removes 0.15 of the remaining along-surface error per frame rather than all of it, because a pin at full strength fights the recovery hard enough to leave a settled four-box pile spinning at 0.02 rad/s; at 0.15 the pile reads 0.003 and the creep is gone.

Across the corpus this takes settled drift from 529, 662 and 168 mm (`255f`, `326f`, `166f`) to 8, 8 and 16 mm, and what is left is bodies with a real velocity under the scan's threshold rather than bodies moving with none.

### Area glyphs

Anything the player passes through must never be mistakable for solid geometry in a still
frame — see **"Pass-through geometry must read as pass-through"** in `docs/game-design.md`
for the rule and its rationale. Each such type is stamped with a glyph naming what it does:
`killzone` → **skulls**, `force` → **flow arrows**, `anchor` → a **grate mesh**.

`render/areaGlyphs.ts` holds the glyph geometry as plain closed polygons emitted into an
abstract `PolyPath` sink, so the game canvas, the level editor and the headless SVG snapshot
stamp identical marks from one source (`CanvasRenderingContext2D` satisfies the sink as-is;
`svgFrame.ts` has a small writer that turns it into path data). `render/areaFill.ts` wraps it
for canvas as `fillForceArea` / `fillKillZone` / `fillAnchor`.

The fill is one **even-odd** path — outline plus glyph polygons, clipped to the outline — so
glyphs are **cutouts** showing whatever is behind, legible against any authored colour
including an opaque one. Nested rings flip back to solid under the same rule, which is what
gives the skull its eye sockets. Glyph size *and* lattice spacing are fixed world constants,
so a long river and a small vent read as the same current and only the glyph *count* grows
with the box (a cap thins the lattice on huge areas; glyphs keep their size). Discs get an odd
row count so one row lies on the widest chord. Force arrows drift along the flow at a speed
proportional to the magnitude (clamped), driven by the wall clock — decoration that can never
reach the fixed-step sim; killzone skulls are static, since a killzone does not flow. The SVG
snapshot pins the phase at 0 so a frame render never depends on the wall clock. An anchor's
grate is the same machinery on a much finer pitch (7 cm holes on a 10 cm lattice, so 3 cm
bars) and static —
its holes are literally holes, so the backdrop shows through the body.

## Regenerating level geometry

`levelData.ts` is generated from the prototype's Godot scene; do not hand-edit it:

```sh
bun scripts/extract-level.ts <path-to>.tscn src/level/levelData.ts
```
