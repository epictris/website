# Force areas, surface friction and area glyphs

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
