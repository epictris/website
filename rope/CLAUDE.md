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
that convention is cashed out. Convexity is a hard rule of the format, enforced at
construction; see **"Convex-only polygons; compound bodies"** in `docs/game-design.md` for
why the rope solver cannot survive a reflex vertex, and how a concave form is authored
instead (several convex pieces, one body or several).

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
Levels author this with the `group` tag on `LevelBodyData` - see **Compound bodies** under the level editor.

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
would teeter on a corner instead of settling. `World.resolveRigidLoop` is a sibling of
`resolveRigidCircle` rather than a generalisation of it, so the circle path (and the ball
avatar's steering branch inside it) stays bit-identical to recorded replays.

## Known simplifications (candidates for follow-up)

- `World` rigidbody dynamics are approximate (no stacking solver, one Gauss-Seidel pass per
  frame); the rope drives attached bodies directly, so this mostly affects free-falling
  debris. Polygon contacts do get a real two-point manifold (above); circles remain single-point.
  Rigid-vs-rigid contacts still take the approximate path, and its sharpest limitation is that
  **the two bodies never exchange momentum**: each independently cancels its own approach at
  the shared contact, and neither drives the other. A body landing on another therefore stops
  it rather than knocking it round - the struck body's own rotation is arrested by the contact,
  which is the opposite of what an impact should do (`session-120f`, where the top of two
  compound groups lands square on the bottom one and the bottom one's spin is cancelled from
  0.10 to -0.06 rad/s by the very contact that should have driven it). Fixing that properly
  means a real pair solver - one impulse computed once for the pair and applied equal and
  opposite - rather than the two independent passes below.
  The approximation is: half the push-out, half the
  approach velocity, each body resolving its own `RIGID_PAIR_SHARE` of the contact with no
  knowledge of the other's pass - but they are no longer *torque-free*: in `resolveRigidLoop`
  the normal impulse goes through the coupled linear/angular effective mass, per manifold
  point, so an off-centre contact turns the body. It used to read `linearVelocity` alone and
  write back into `linearVelocity` alone, which a circle can survive (its normal passes
  through its centre, so there is no lever) and a vertex shape cannot: resting on another
  rigid body it could be pushed but never turned, so a body balanced on a corner of one had
  no way to fall off it. A long sliver cantilevered out into thin air over the corner of
  another polygon turned at 0.2 rad/s, on the crumb of friction torque that was the only kind
  reaching it, where it should have whipped round in a fraction of a second - it now peaks at
  3.5 (`session-166f`).
  Positional recovery is no longer part of any of that: the contact routines solve **velocity**
  and `resolveDynamicCollisions` closes the step with a scene-wide sweep of `depenetrateRigid`
  (`DEPENETRATION_PASSES` passes over every rigid body) that solves **position**.
  See **Positional recovery** below.
  They are no longer *frictionless* either: `applyRigidContactFriction`
  gives them the same Coulomb-capped kinetic friction and `contactDamp` the static path
  applies, minus the stiction and the stick anchor, which pin a body to a surface that is
  not going anywhere and would fight the other body's own resolution pass, and minus any
  reading of the *other* body's motion: it writes only to `body`, so it is not one half of a
  reciprocal pair and slip taken relative to another dynamic body is invented energy.
  Slip is measured against the world there, which makes the contact a brake and never a
  motor. See **Force areas and surface friction**.
  Without it, resting on a rigid body was resting on ice — a circle's `contactFriction`
  did nothing at all against a polygon — so gravity did work down a rigid slope for ever,
  and a chain to carry that away made it a motor: a ball hanging on a rigid polygon's face
  slid the pair across the level and, left to run, accelerated to **68 m/s** over eleven
  metres (`session-431f`).
  The other half of that - a rigid body against the **static** geometry it stands on - was
  frictionless for the separate reason that `RigidBody2D`'s coefficients default to 0 and
  nothing but the two avatars ever set them; authored `rigid` bodies now get theirs from
  `buildBodies.ts`. See **Force areas and surface friction**.
- `SlackSimulation` is fully ported but currently unwired — the C# `Rope` also left its
  `slackSimulation` field unused; the rope renders straight spans.
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

Pick a level with `?level=NAME` (see `src/level/registry.ts`); `TEST_MOVERS` /
`TEST_WINDMILL` are hand-written mover test levels (sliding platform, windmill).
`LEVEL_2` is the grapple arena (the Godot-extracted scene).

`BALL` is the **default level** (`DEFAULT_LEVEL`), so a bare `/` runs the
**ball & chain controller** — a separate vertical slice
(`classes/ballPlayer.ts`, `level/ballLevel.ts`, `input/ballInput.ts`,
`renderBall`) that shares nothing with the Player state machine. The ball is a
RigidBody2D (rolls via the opt-in `contactFriction` field on RigidBody2D;
default 0 keeps old replays bit-identical). The chain reuses the Rope wrap
solver: its start contact sits on the ball's edge in the ball's local frame, so
it rotates with the ball, winds around it, and applies torque. The chain solve
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
the corpus splits cleanly, 17 frames at most when healthy against 79, 51, 36, 32
and 28 for the runaways.
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
ends, so the shot goes exactly where it was aimed and only then falls. Every
ending calls it — the hook attaching, a bounce off an impermeable (the deflected
remainder does arc), the chain snagging geometry, and the chain running out of
length (so the dangling tip swings instead of hanging in the air).
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
The camera zoom scales down on short viewports (height-driven, capped at the
desktop zoom) so a landscape phone still frames the ball and its chain arc.
The page is an installable full-screen web app (`public/manifest.webmanifest`
with `display: fullscreen`, plus `apple-mobile-web-app-*` metas for iOS and
`viewport-fit=cover`): added to a phone's home screen it launches without
browser chrome. Restart routes
through the `jump`
FrameInput field so it stays in the recorded input stream (BallLevel calls
onReset). Ball inputs map onto the existing FrameInput fields
(aim→mouseWorldPosition, shoot→fire, restart→jump), so
recordings serialize and `cli replay`/`cli bundles` work unchanged
(`cli continue` and playtest scripts are not ball-aware yet).

## Headless tooling

```sh
bun run replay selftest                       # determinism + replay round-trip check
bun run src/tools/cli.ts ledges               # generated ledge-grab matrix (speed × angle × negatives)
bun run src/tools/cli.ts corners              # corner-exposure geometry cases (compound-body seams)
bun run src/tools/cli.ts play  playtests/grapple-swing.json
bun run src/tools/cli.ts replay session.json  # replay a P-exported bundle, run invariants
bun run src/tools/cli.ts bundles              # replay every bundle in playtests/bundles/
bun run src/tools/cli.ts dump session.json --from 100 --to 200   # digest+input table
bun run src/tools/cli.ts continue session.json --from 500 --hold left --trace t.jsonl
bun run src/tools/cli.ts render session.json --frame 65 --out f65.svg   # SVG snapshot of one frame
bun run src/tools/cli.ts chainpath session.json --from 60 --to 70       # chain wrap-node polyline per frame
bun run src/tools/cli.ts fork session.json --frame 979 --frames 24      # state trace + before/after SVG around a frame
scripts/abtest.sh session.json 979 <oldRef>                             # A/B the current tree vs oldRef from the fork frame
```

Playtest scripts are frame-indexed held-button ranges + mouse aim with asserts
(`reachState`, per-frame `state`/`maxSpeed`/`hasRope`/position bounds). Invariants
checked every frame: NaN, runaway speed, rope-over-length (once anchored),
player-embedded-in-geometry.
Ball runs add: `rope-anchor-kick` (the solve added speed on the frame the chain
anchored — an anchor born over its length), `rope-solve-kick` (the solve added
more than 4 m/s in **any** single frame) and `chain-clip` (a span's interior deep
inside static geometry).
`rope-solve-kick` exists because `runaway-speed` is a 1000 m/s ceiling and so
never saw a 96 m/s one-frame launch; the whole ball corpus peaks at 2.1 m/s of
gain in a frame, so 4 is well clear of real play. It is the general form of
`rope-anchor-kick`, which only ever watched the anchoring frame.

## Debugging physics issues

The debugging loop for gameplay/physics bugs (player stuck, frozen input, bad
launches, mover misbehavior):

1. **Capture.** Reproduce in the browser, press **P** — downloads a bundle
   (level id + full input trace + per-frame digests). Recording restarts on
   level reset, so a bundle always replays from frame 0.
2. **Make it red.** Drop the bundle into `playtests/bundles/` (gitignored,
   local corpus) and run `cli bundles`. Every bundle is re-simulated with
   *current* physics and checked against per-frame invariants — the bug should
   show up as violations at the frames where it was felt. If it doesn't,
   the invariants have a blind spot: fix the detector first, then the bug.
   A fix is only "done" when the bundle that reported it goes green.
3. **Locate.** `cli dump bundle.json --from A --to B --every N` prints a
   digest+held-input table (re-simulated, not the recorded digests). Look for
   `vx=0.0` runs under held input, state thrash (Grounded↔Airborne flicker),
   or position drifting against input.
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
   whole scene at frame N (bodies, impermeable = dashed steel border, hook-only
   anchors = a grate mesh, areas with
   their glyphs — skulls for a killzone, flow arrows for a force area — chain
   wrap path + wrap-node markers, avatar); convert with `magick f.svg f.png` and
   look.
   `cli chainpath bundle.json --from A --to B` prints the wrap-node polyline per
   frame in px (node count > 2 means the chain caught a corner). Reach for these
   the moment a bug is about position/shape rather than a stuck/velocity number.
4c. **See what the *player* sees.** Everything above draws its own picture of the
   sim state, which is exactly why none of it can see a bug in the drawing. With
   `bun run dev` up, `/shot.html?bundle=/playtests/bundles/session-1474f.json&frame=300&zoom=9`
   replays a bundle to one frame and draws it with the **real** renderer, at
   `alpha = 1` so the grab is reproducible; screenshot it headless
   (`chromium-browser --headless --screenshot=out.png --window-size=1200,900 --virtual-time-budget=8000 "<url>"`).
   Reach for it when the report is about what something *looks* like. The chain
   wound onto the ball drew as blank space for want of one `floor` (see
   `drawChainPolyline`), and every CLI tool called that run perfectly healthy,
   because it was.
5. **Verify.** `cli bundles` green + all playtests + `bun run replay selftest`
   (must stay bit-identical — static-path behavior may never change; mobile
   behavior is gated behind `isMobile`/`isRotating` branches). To confirm a fix
   actually changed the felt behaviour — which plain replay *cannot* show once
   the fix diverges the recorded tail (see Bundle semantics) — use the **A/B
   fork**: `scripts/abtest.sh bundle.json <forkFrame> <oldRef>` replays the
   bundle to `forkFrame` under both the current tree and `oldRef`, then traces
   both past it and diffs. Because the sim is deterministic and a fix only bites
   at the issue frame, both sides reproduce the *same* pre-issue state, so the
   diff (and the two before/after SVGs) is exactly the fix's effect. Pick
   `oldRef` = the commit just before the fix, and `forkFrame` = a frame where old
   and new still agree, just before the issue (if they already diverge there, the
   divergence started earlier — walk `forkFrame` back until the pre-fork lines
   match). The script runs old *physics* with new *tooling* (it copies the
   current `src/tools` + `src/sim` into the old worktree), so `cli fork` need not
   exist in `oldRef`; this holds only while the tooling touches stable physics
   interfaces (`physicsProcess`, body/rope fields) — if a change alters those,
   run the two `cli fork`s by hand.

Key invariant — the **`input-frozen` stuck detector** (`src/sim/trace.ts`):
held direction for 45 frames with a mobile body nearby must produce ≥0.25 m of
displacement along the input, or >0.1 m *against* it (yielding to a mover's
push is displacement, not a freeze — wedge rules). Counts every input-held frame regardless of
state (state thrash must not reset the window); exempt: active rope, ledge
hang/climb, wall-jump startup, and purely static blockers (pressing into a
static wall is legit). Runs inside every playtest, replay, and continue.

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

## Level editor

The **`/editor`** page (its own HTML page `editor.html` → `src/editorMain.ts`, distinct
from the game at `/`) runs an in-browser level editor (`src/editor/`, its own canvas loop +
DOM overlay). Dev serves `/editor` via a rewrite in `vite.config.ts`; production maps it to
`dist/editor.html` in `serve.ts`; the build emits both pages (`rollupOptions.input`). It
edits an `EdModel` (positions in world **metres**, one
stable id per body) and manipulates it with the mouse: pan (**middle**-button drag, or the
right button), wheel-zoom about the cursor, click-select, drag to move, corner/rotate/
radius handles to resize, and `+Rect`/`+Circle`/`+Poly` tools to draw new bodies.
`+Poly` is the one draw tool that is a run of clicks rather than a drag, because a convex
outline is a vertex list and not a box: each click places a vertex, **Enter** or a click on
the first vertex closes the loop, **Esc** drops it, and the title carries the count so the
gesture always says where it is up to.
The finished outline is the **convex hull** of the clicked points, so a well-drawn shape
lands exactly as clicked and a dented or out-of-order one becomes the nearest convex shape
instead of being refused after all the clicking.
A selected polygon is then edited vertex by vertex - square handles move a corner, the
smaller round handles at the edge midpoints insert one and drag it in the same gesture, and
**Alt+click** on a corner removes it (a triangle is the floor). Every one of those goes
through `setPolyVerts`, which re-centres the loop on its centroid (so `pos` stays the centre
of mass, which the rigid-body lever arms assume) and **refuses a non-convex result** - the
vertex being dragged stalls at its last convex position rather than the shape turning inside
out. There is no `w`/`h` to type for a polygon, so the inspector shows the vertex count
instead; it is a live readout, refreshed with the number fields, since a drag can change it
while the panel is deliberately not rebuilt.
Selection is a **set**: a plain click selects one body, **Shift+click** toggles a body in or out, and dragging any member moves the whole group (the grabbed body leads the snap; the rest keep their offsets).
Dragging from empty space rubber-bands a **rectangle selection**, and the drag *direction* picks between the two CAD selection modes, as in Fusion 360 and AutoCAD: left→right is a **window** (only what the band fully encloses - every rotated corner inside, a circle by its extremes), right→left a **crossing** (anything it touches - a rotated box by SAT, a circle by its nearest point).
The mode has to be legible while the drag is still live, and the box alone cannot show a direction, so the band draws **solid** for a window and **dashed** for a crossing - the CAD convention, so it reads the same way it does there.
A drag with no horizontal travel counts as a window, so a degenerate one falls into the stricter mode.
**Shift** unions the hits into the current selection instead of replacing it, and a click that never moves clears it.
That is why pan is on the middle button: the left button belongs to the band.
Resize handles only appear for a *single* selection, but the inspector is a **group panel** at
any size: every property the selection has in common is shown and every edit applies to all of
them (position and colour always; `rot°` when each body has a meaningful one, `w`/`h` or
`radius` when they are all the same shape, `force` when they are all force areas, `friction`
when none of them is an area or an anchor).
A property the bodies disagree on shows blank with a `mixed` placeholder and only writes once
something is typed into it; the kind picker gains a `mixed` entry for the same reason.
Selected bodies draw an orange halo *under* their own border,
so an impermeable's dashed steel edge stays legible while selected.
**Ctrl+C / Ctrl+V** copy the selection and paste it at the cursor: the clipboard holds copies
detached from the model, and paste re-centres the group's bounding box on the pointer (with
snap on, its top-left corner lands on the grid), leaving the new bodies selected so it can be
repeated. `Ctrl+D` duplicates in place at a 2-cell offset.
**Arrow keys** nudge the whole selection one grid cell (10 cm), or 1 cm with **Ctrl** held; the
nudge is a pure translation (never snapped), so a body keeps any sub-cell offset it has and the
fine step still works with snap on. A run of nudges collapses into one undo step, ending when the
key is released. The kind picker
covers `static`, `rigid`, `killzone`, `impermeable`, `anchor`, `force`.
Every body that can be stood on carries a **surface friction** (0 = ice, 1 = rubber; see below), and a
`force` area carries a signed **force** magnitude aimed by its own `rot°` - so the rotate
knob steers the current, and force-kind circles get that knob too (a plain circle's rotation
is invisible, so it has none). A toggleable snap (fixed 10 cm, the
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
`▶ Test Grapple` / `▶ Test Ball` build a real `Level`/`BallLevel` from
the current model and run it inline (with the real camera, so a camera region is felt exactly as it will play); **Esc** returns to editing.
**B** is the same ball test but spawned **at the cursor**, so a corner of the level can be spot-checked without walking the spawn marker over to it and back.
The override is baked into the `LevelData` the test level is built from rather than into the model, so it never edits the level, and a reset (and the exported P bundle) respawns at the same point.

### Layers

The model is a flat list of `EdItem`s, each carrying a **`layer`**, listed in draw order: `background` (decoration behind the level, see below), `geometry` (the scene bodies), `camera` (the camera-behaviour volumes, see **Camera** below) and `notes` (authoring annotations, see below).
Every layer that is **visible and unlocked** is hit-testable, so a selection may span layers; the other two states are excluded from picking entirely, and both drop their items from the current selection when they are entered, rather than leaving things selected that a nudge, an inspector field or a Delete would still reach.
The **active** layer is what new items are drawn onto, and it breaks a tie in the pick (`pickOrder`): a camera region blankets the geometry it governs, so a click that could mean either takes the active layer's item, and the layer switch is what says which.
Every visible layer nevertheless draws at **full opacity**, active or not: dimming made a layer harder to read against the geometry it annotates, the layer list already says which one a click will hit, and visibility is the control for getting a layer out of the way.
The toolbar's layer list picks it (**Tab** cycles) and carries a **visibility** and a **lock** toggle each; hiding the active layer moves the edit focus off it rather than leaving an invisible edit target, and the last visible layer refuses to go (hiding everything would leave a blank canvas nothing can be clicked on).
The two toggles are deliberately independent: hiding gets a layer *out of the way*, locking keeps it **on screen but out of harm's way** — the reference you are working against.
So a locked layer draws exactly as before and only loses the edit paths: picking, being drawn into (`refreshToolButtons` offers Select alone while the active layer is locked, and `setTool` refuses a draw tool there so the keyboard shortcuts cannot arm one either), and membership of the selection.
With nothing pickable on it, the empty inspector says the layer is locked rather than repeating the usual "click a body", which would read as the editor being broken.
A paste unlocks the layers it lands on for the same reason it un-hides them.
The list stacks **vertically**, with the toggles in two icon columns down the left - eye then padlock - because a layer stack is a fixed, ordered set you read down rather than a row of toolbar buttons.
Both are inline SVG (`eyeIcon`, `lockIcon`) rather than emoji or font glyphs, so they inherit the toolbar colour through `currentColor`, stay crisp at any DPI, and look the same on every platform.
The eye is open when the layer draws and a dimmed closed lid when it does not; the padlock's *resting* state is unlocked, so it is the dim one (a row of lit padlocks would read as "everything is locked") and locked is amber, the layer list having already spent the accent blue on "active".
A cross-layer selection gets **one panel per layer** rather than a reconciled mixed one, since the layers' properties have nothing in common (a note has no kind, a camera region no fill); the panels come in layer order, under a summary that carries the single Duplicate/Delete row, which is why the per-layer panels drop theirs (`selectionSpansLayers`) — a row inside the "2 backgrounds" panel that also deleted the selected notes would be lying about its scope.
The inspector scrolls, because that stack can outgrow the viewport.
A paste keeps each item on the layer it was copied from and reveals (and unlocks) any layer it lands on, rather than dropping items where they can be neither seen nor clicked.
The draw tools are per-layer too (`LAYER_TOOLS`): `background`/`geometry`/`camera` offer `+Rect`/`+Circle`/`+Poly`, `notes` offers `+Text`/`+Arrow`, and switching to a layer that cannot draw the armed tool falls back to Select rather than leaving a dead button lit.
A fresh item's appearance comes from `LAYER_STYLE`, one table rather than a branch per layer: `background` and `geometry` start at their authored defaults, `camera` and `notes` at the fixed editor-furniture colours.

The camera panel carries `off x`/`off y`, `view ×`, `lock x`/`lock y`, `blend s`, `buffer` and `priority`.
A lock is a checkbox plus a value: ticking it seeds the lock from the region's own centre (the sane start for "frame this room"), unticking shows `follow`; a blank `blend s` or `buffer` means the controller default.
A region draws as a dashed violet volume labelled with what it does (`cam · off 0,-250 · view ×1.8 · lock xy · buf 200`), and a locked axis draws a gold guide — a line across the region for one axis, a crosshair at the pinned point for both.
An authored `buffer` draws too, as a finely dotted outline of the volume grown by it: a buffer is the region's real reach over the camera, and it is set by eye against the arc a swing actually takes, so it has to be visible while it is being authored.
`pathOutlineGrown` (`render/shapePath.ts`) owns that geometry so it can never disagree with `pointInRegion`, and the two shapes grow differently on purpose - a rect grows per axis with **square corners**, since that is literally what its containment test does, while a polygon grows as a true offset with **filleted corners**, since its containment test is a signed distance and a mitred corner would claim reach the region does not have.

One item type rather than a union per layer is deliberate: a camera region is drawn, picked, dragged, resized, rotated, rubber-banded, duplicated and undone exactly like a body, and one type means those paths cannot drift apart per layer.
The cost is that an item carries the fields of every layer; `toLevelData` splits the list by layer and writes only the fields that layer gives meaning to, so nothing inapplicable reaches disk.

### Background

The **background** layer is decoration: shapes drawn behind the level with an authored colour and opacity, and **no interaction of any kind** - nothing collides with them, the rope never wraps them, no force reaches through them, and the sim never sees them.
That is why they are not a `BodyKind` but their own `backgrounds` list (`BackgroundData` in `levelFormat.ts`), for the same reason camera regions are: a pass-through `BodyKind` would have to be excluded by every physics path, one call site at a time.

It is the one editor layer besides `geometry` whose output the **player sees**, which makes two rules load-bearing rather than cosmetic (`render/background.ts` is the single implementation of both, shared by the editor and both game renderers, so what is authored is what plays):

- A panel is **drawn before every body**, so nothing the player can touch is ever hidden behind decoration.
- A panel is **never stroked**. A border is what makes a shape read as an object; a backdrop has none, and every body draws over it with one. This is how a background stays distinguishable from a wall without a glyph - see **Backgrounds** in `docs/game-design.md`, which is the amendment to the pass-through rule that lets it off carrying one.

The editor adds a dashed **teal outline** on top, editor chrome like a handle rather than part of the drawing: an author has to be able to find and click a panel that is dark, huge or nearly transparent. It is a saturated colour on purpose - a neutral grey edge vanishes into either the pale grid backdrop or the panel's own fill, whichever it was picked to contrast with.

The inspector panel is exactly the transform plus the fill (`color` + `opacity`); a background has no kind, no friction and no behaviour to configure.
**Images** (a source, plus `scale` / `crop` / `tile`) are designed for but not implemented: they land as three optional fields on `BackgroundData` read by `fillBackground`, and one more inspector section. Nothing else moves, because the placement, the shape, the layer and the entire editor pipeline are already shared with every other item.

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
See **"Convex-only polygons; compound bodies"** in `docs/game-design.md` for why a concave form has to be authored this way at all.

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

On disk it is a `group` tag on each member (`LevelBodyData.group`), and members are matched by tag alone, so the format stays a flat body list.
A body has one kind, one fill, one friction and one force, so the group takes its **first member's** and the editor keeps the rest in step (`syncGroupProps`) - a file can never disagree with what it draws.
Areas are deliberately not groupable: `World.integrate` tests area overlap against `primaryShape()` rather than `getShapes()`, so a grouped killzone or force area would silently act through its first piece alone, and both the editor and `buildBodies` build one as its own body instead.

Because a group is one body, it is **selected and moved as one**: clicking any piece selects all of them, a rubber band that touches one piece takes the whole body (`withWholeGroups`), and **Alt+click** reaches past that to a single piece when its own shape needs editing.
It also **rotates as one**, about the group's area-weighted **centre of mass** - which is where `buildLevelBodies` puts the built body's origin, so the editor's rotation and the body's are the same operation.
A whole-group selection therefore gets its own rotate knob (placed by the group's extent, since the pieces have their own angles and the body as a whole has none) and its `rot°` field applies a *delta* to the group rather than writing each piece's own angle.
Every group draws a small centre-of-mass diamond so it is identifiable as one body without being selected first, and a selected one adds a dashed hull and spokes to that centre.

A compound body is drawn as **one object**, not as its pieces: the shapes are filled as a union with the nonzero rule (so an overlap contributes one layer of the authored opacity rather than one each) and each piece is stroked only where it lies **outside every sibling**, which is the body's real outline.
Drawn piece by piece it read as a darker patch at every overlap and a crack at every join - a wall with a line down it.
The clip is applied one sibling at a time on purpose: a single even-odd clip keeps the region inside *two* of them, which is exactly where an interior seam sits.
`drawCompoundGeometry` (game) and `strokeCompoundOutline` (editor) are the two implementations of that one rule.
Hook-only anchors keep the per-shape path, since their fill is a grate lattice punched out of each piece and a lattice has no union form.
The headless SVG snapshot still draws the pieces separately - it is a diagnostic view, and there the decomposition is the thing worth seeing.

### Chains

**+Chain** (**K**) drags a chain from one body to another: press on the first body, release on the second.
A chain is a real constraint, not decoration - it is a `Rope` with both ends pinned at load (`src/level/chains.ts`), stepped once a frame after `World.integrate` by both level drivers, so a rigid body on either end hangs, swings and is hauled by it while a static or an `anchor` is infinite mass and simply holds.
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

Anchors are authored in **world** coordinates (`ChainData`), not in a body's local frame, because a grouped body's origin is a centre of mass that moves as pieces are added and a world point is what the editor has under the pointer; `buildSceneChains` converts each into the body's frame once, at load.
Both the editor and the loader push an anchor onto the **nearest point of the body's surface** first (`nearestOnOutline` / `nearestOnCircle`).
That is what a chain bolted to a body means, and it is load-bearing numerically: an anchor in a body's interior leaves the span starting *inside* that body, the wrap generator resolves that as a self-intersection, and the chain winds around its own anchor - a weight authored hanging at rest reached **31 m/s** that way, against 0 once the anchor is on the rim.
The loader applies the same rule rather than trusting the file, so a hand-edited level cannot author the degenerate case either.

`length` absent means **taut** between the two anchors as they land, re-derived at load, which is what dragging one out gives; the inspector's `length` field authors slack, with a live readout of how much.
A chain naming the same engine body at both ends (two members of one compound group, say) is refused in the editor and dropped at load - it has nothing to constrain.
Chains carry their own selection, exclusive with the item selection: a chain has no shape, no placement and no properties in common with an item, so a mixed selection would have nothing an inspector panel could say about it.
They are picked by a screen-space band around their span and edited by two round endpoint handles; dragging one lands it on whatever body is under the pointer, so moving an anchor along its own body and moving it to a different one are the same gesture.
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
the generated one — adds the `rigid`, `anchor` and `force` kinds, the `cameraRegions` and
`chains` lists, and the per-body `group` tag); `levelData.ts` stays
auto-generated and is structurally assignable to it. Both level drivers construct geometry
through the shared `src/level/buildBodies.ts` (statics, killzones, impermeables, anchors,
force areas, and rigid bodies), so the grapple and ball controllers load identical scenes.
`rigid` bodies get mass/inertia from `ShapeGeometry` and fall under gravity.

## Camera

`render/cameraController.ts` owns the view: an **eased follow** of the avatar, reshaped by the level's **camera regions**.
It is deliberately render-side, driven by the wall-clock frame `dt` rather than the fixed timestep, so easing it can never change a recorded run.
(The grapple controller un-projects the cursor through the camera, so the camera does reach the sim as *input* — but the trace records the resulting world point, so replays stay bit-identical.)
`camera.zoom` is the controller's **output**; the base framing scale lives in the caller (`GRAPPLE_ZOOM`, or `ballZoom(viewportHeight)` for the ball, re-derived on resize).
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

`priority` still overrides the grip, and is the escape hatch a wide buffer needs: a small, deliberately-framed volume sitting inside a big buffered one has no other way to take the camera, and saying so explicitly beats shrinking the buffer until the overlap happens to work out.
The consequence to author around is that leaving that priority island drops to whatever contains the avatar *then* - the buffer belongs to the region currently in force, and the island became that region on entry, so the enclosing region's buffer is no longer what is holding.

## Hook-only anchor geometry

An **`anchor`** body is an `AnchorBody` (`engine/body.ts`) — the exact mirror image of
`impermeable`. The hook attaches to it, but **nothing collides with it**: the avatar, the
ball, loose debris and the rope/chain all pass straight through. It is what background
scenery you can swing from is made of — a metal grate, a girder, a chandelier — geometry
that must not block the level it decorates.

Three mechanisms keep it out of the sim, none of them a per-call-site special case:

- It extends `PhysicsBody2D` **directly** rather than `StaticBody2D`. Every collision path
  in `World` (`moveAndCollide`, `resolveDynamicCollisions`) is written as an allowlist of
  `StaticBody2D | RigidBody2D`, so an anchor is excluded by construction.
- It sits on its own collision layer (`LAYER_ANCHOR`). Every existing raycast asks for
  `LAYER_SOLID`, so they all miss it; the grapple `Hook` is the one query that asks for
  both, which is exactly what makes it attachable. `BallHook`'s swept/probe contact names
  `AnchorBody` explicitly for the same reason.
- `buildLevelBodies` adds it to the world but keeps it **out of the returned wrap list**, so
  a passing span has nothing to catch on, and `Rope` itself refuses to wrap a body whose
  `isSolid` is false (the `isPassThrough` gate in `regeneratePath` *and* in both
  self-intersection resolvers).
  The second half is not redundant: the wrap list is only the *scan* list, whereas the
  self-intersection resolvers wrap whatever a rope node is **already attached to**, list or
  no list.
  Since the hook's whole purpose is to attach to an anchor, that path is reached on every
  anchored chain — without the gate the chain bent around the grate it was hooked to, which
  is precisely the collision anchors exist to avoid.

Queries that scan bodies generically (ledge detection, the debug overlay) filter on
`PhysicsBody2D.isSolid`, which is false only for anchors — a grate corner is not a ledge.
Anchors carry no surface friction (nothing rests on them) and are drawn first, behind the
solid geometry they sit among, in both renderers and the SVG snapshot.

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
The cost is real and is the reason `applyRigidContactFriction` refuses stiction against
another *rigid* body: the anchor pins the body's along-surface position, so anything else
writing that position - a chain hauling the crate, or the other body's own resolution pass -
is undone every frame.
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
`resolveRigidLoop` now keeps only the *separating* part; the circle path deals in a single
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
`resolveRigidLoop` now leaves rotation alone.
The per-point normal impulses are what resist rotation - which is what a two-point manifold is
*for* - and a body that really is toppling spins past `STICK_SPIN`, releases the grip and
falls.
The grip stays what it is meant to be: a brake on translation, not a lock on pose.

The second is that **rigid-rigid contact friction may not read the other body's motion**.
`applyRigidContactFriction` measured slip the way the static path does, relative to the surface
the other body presents, and for a static body or a scripted mover that is right - an
infinite-mass surface whose motion is a given, which a body resting on it is dragged along by,
and that is the whole point.
Two *dynamic* bodies are a different situation, and the difference is that this routine is not
one half of a reciprocal impulse pair: it only ever writes to `body`, and the other direction is
a separate call on a separate pass, sized independently from its own mass and its own normal
budget.
Nothing makes the two equal and opposite, so any impulse taken from `other`'s motion is energy
the contact invented - which did not matter while level rigid bodies had `contactFriction = 0`
and the routine did nothing at all, and became a **motor** the moment they did not.
The ball is the worst possible thing to read a surface velocity from: its spin is kinematic (the
aim rewrites it every frame, so nothing the contact does can slow it) and its linear velocity is
whatever the chain solve last credited it, which for a wedged ball is metres per second of motion
the geometry is refusing.
Either one reads as a surface sliding under the crate, and Coulomb friction dutifully drags the
crate along with it - at a dead-steady 2.4 mm a frame, for ever, because the crate's own grip on
the floor is resolved earlier in the same pass and cannot answer a drive that lands after it.
A ball merely *hanging* on a chain walked its anchor **3.6 m** across the level that way
(`session-611f`).
Slip is now measured against the **world**, so the impulse can only oppose the body's own motion:
the contact is a brake and never a motor, which is what the routine was added to be and all
`session-431f` ever needed.
The two bodies still shove each other through the normal channel, which *is* solved as a pair.

What is left is longer *legitimate* blocks, because that is what removing the relief valve
means: geometry that no longer slides out from under a taut chain holds it until the ball
itself settles.
The corpus ceiling went 11 → 46 frames (`session-431f`, over which `maxRopeLength` does not
move at all and the lease is repaid to exactly zero), so `CHAIN_STALL_FRAMES_TOLERANCE` is 60.
`rope-grew` holds the gap the blunter count leaves.

## Positional recovery

The contact routines in `World.resolveDynamicCollisions` solve **velocity**.
Position is recovered separately, by a scene-wide sweep at the end of the step: `DEPENETRATION_PASSES` passes, each giving every rigid body one `depenetrateRigid` pass.

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

## Resting contacts

A manifold's normal impulses are solved as **one system**: accumulated per point, iterated `NORMAL_SOLVER_ITERATIONS` times, with each point's *running total* clamped at zero rather than each increment clamped on its own.
Both the static and the rigid-rigid branch do it; `RIGID_PAIR_SHARE` still scales what a body takes from a rigid pair, since the other body meets that contact again on its own pass.

Solved once each behind a `vn < 0` gate, the two points of a resting face cannot converge, and the reason is structural rather than a matter of tuning.
Point A's impulse acts through a lever, so it rotates the body and pushes point B in; B's impulse pushes A in; and because neither may ever *pull*, the pass ends with the pair having overshot in opposite directions.
What is left over is a spin, and next frame it returns with the sign flipped.
A polygon lying still on the floor sawtoothed between -0.07 and +0.11 rad/s for as long as it rested there, wobbling about a third of a degree - some millimetres at the end of a long body, which is what reads as vibration (`session-255f`).

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
