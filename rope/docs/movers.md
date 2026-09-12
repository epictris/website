# Scripted movers

A static body may be driven by the LEVEL rather than by the solver: an
`AnimatableBody2D`, infinite mass, carrying the per-frame contact velocities
everything that rides it inherits.
Three motions are authorable and they compose on one body.

A **pendulum** (`LevelBodyData.swingAmp` / `swingPeriod` / `swingPhase`) turns
about its bearing on a sine: `rot(t) = rot + amp · sin(2π · (t/period + phase))`.
A **rotor** (`spinPeriod` / `spinPhase`) turns about the same bearing at a
constant rate and goes round rather than back and forth:
`rot(t) = rot + 2π · (t/period + phase)`.
A **traveller** (`moveNodes` / `moveMode` / `moveSpeed` / `movePhase` /
`moveEase` / `moveAlign`) follows an authored cubic Bézier route.

The point of them being driven rather than simulated is **authority**, and it is
the whole reason this is not a preset for `pivot`.
A `pivot` rigid body IS the physical pendulum: gravity swings it, a player
hanging off the end changes the swing, a chain hauls it round and it eventually
comes to hang.
This one cannot be disturbed at all - the player rides it, hooks it, is swatted
by it and shoves it in vain - which is what a rhythm an author is timing a jump
against has to be.
It is a moving piece of the level rather than a body under the level's physics,
which is exactly what `AnimatableBody2D` already was.

Four things are structural rather than incidental:

- **The bearing is the body's ORIGIN.** `buildBodies` re-origins a swinging body
  onto its authored `pivotX`/`pivotY` (`reoriginShapes`, the half of `reoriginTo`
  that is only about where the origin is), so the mover writes one field and
  `velocityAtPoint` measures `r` from the hinge - a rider inherits the right
  `v + ω × r` with nothing in the contact path knowing there is a pendulum here.
  It is the same pair of fields the rigid pivot uses, because it is the same
  point; `hasBearing` is the one predicate that says which bodies have one.
- **A rotor is one signed number.** `spinPeriod` is the seconds of one full turn
  and its SIGN is the direction, so the whole of a windmill's authored motion is
  "8" or "-8". A rate and a separate direction would be two fields for one
  statement, and seconds-per-turn is the half that reads next to `swingPeriod` -
  both answer "how long does a cycle take".
  The rotation it writes is a RUNNING TOTAL, never wrapped into a turn: the lap
  boundary would otherwise be the one frame of the motion whose transform delta
  is a whole turn the wrong way, which is a contact velocity of tens of radians
  a second thrown at whatever is standing on the blade and a renderer
  interpolating one frame in twenty backwards round the bearing.
  `cli movers` `spin` measures the per-frame step across three laps for exactly
  that.
- **Every phase is in CYCLES.** A row of pendulums at 0, 0.25, 0.5, 0.75 is the
  interleaving an author means, and nobody divides by 2π to write it. A cycle is
  one lap of a `loop`, one THERE-AND-BACK of a `backAndForth` and one end-to-end
  run of a `repeat`, so 0.5 is half way round a circuit and the far end of a
  shuttle.
- **A route is authored as a SPEED, not a duration.** Re-drawing a route then
  makes the trip longer rather than the platform faster, which is what an author
  means by "this lift moves at half a metre a second". Under an ease it is the
  average over a traverse; the peak is `movePeakFactor` times it - 1 for
  `linear`, π/2 for `sine`, 2 for either one-sided ease.
- **The ease is about the ENDS.** A traverse's return leg is the outward one
  mirrored in time, so an ease whose rate falls to zero at an end turns round
  smoothly there and one that does not reverses outright - a step in velocity,
  thrown at whatever is riding the platform. `sine` tapers at both, `easeIn` and
  `easeOut` at one each (which of the two ends turns hard is the thing being
  chosen), `linear` at neither. A `loop` has no ends and ignores it
  (`moveModeEases`).

## The route is a path, and so is a camera path

A **route** and a **camera path** are the same object - an authored curve with a
direction, an arc length and per-node keyframes - so they are the same code.
`lib/path.ts` holds the geometry (`PathNode`, `flattenPathNodes`, `cubicAt`,
`PolylineIndex`, `pointAtArcLength`, `tangentAngleAt`, `splitCubicAtHalf`,
`smoothTangents`) and `lib/keyframes.ts` the keys (`buildKeyTrack`,
`keyValueAt`, the smoothstep-by-arc-length rule and the geometric zoom blend).
Both are pure, with no clock and no DOM, which is what lets the camera read them
render-side and the mover build read them sim-side; the camera's own file
(`render/cameraPath.ts`) is gone, and `cameraController`'s `pathKeyTracks` /
`pathParamsAt` are now thin wrappers over the shared pair.
The editor shares the gestures too: a route's tangent grips are
`tangentGripPoints` (the camera path's own stub logic), an insert is the same
de Casteljau split at t = 1/2, and `smooth`/`sharpen` are the same Catmull-Rom
write and the same zeroing.

`moveNodes` is the route, in the body's own frame, and **NODE ZERO IS THE BODY**,
pinned at (0, 0) - so moving or turning the body carries the whole route with no
gesture knowing the field exists (the same argument `pivotAt` makes).
It is written out anyway rather than implied, because it carries handles and keys
of its own and a node with nowhere to put them is a corner the author cannot
round.
The retired `movePath` (the waypoints AFTER the first, no handles, no keys) folds
into it at `scaleLevelData`, the one gate every level passes through, with the
body prepended - so a level authored before curves keeps exactly the polyline it
authored and nothing downstream reads the retired field.
A leg whose two facing handles are both absent is straight, so a route of corners
writes exactly the points it always did and flattens to exactly its own nodes.

## Modes

`moveMode` is what the body does at the end of an open route, and it is the one
field that decides what a route MEANS:

- **`backAndForth`** - travelled there and back for ever. The ease belongs to
  this one: the return leg is the outward one mirrored in time, so the ends are
  where the body turns round.
- **`loop`** - the last node runs back to the first and the body goes ROUND in
  one direction for ever. Flattened with node zero repeated at the end, so the
  closing leg is an ordinary Bézier edge (shaped by node zero's `in` against the
  last node's `out`) rather than a straight line spliced on - which is what lets
  a circuit be genuinely round - and the repeat also lands node zero's keys at
  both ends of the arc length, so a keyed value is continuous across the seam.
- **`repeat`** - travelled start to end, then TELEPORTED back to the start. The
  jump is the point of it rather than a flaw in it: a run that only makes sense
  in one direction can be repeated without a return leg and without the body
  flying back through the level to do it.

The retired `moveClosed` folds into `loop`/`backAndForth` at the same gate, and
`cli movers` `legacy` asserts the pair plays bit-identically to the modern form.

A `repeat`'s jump is **not motion**, and that is the whole of what it costs.
`AnimatableBody2D.jumped` says so for the frame it happened on, which is what
lets `cli movers` `levels` exclude it from the contact-speed bar: a body that
jumped did not CROSS anything, it stopped being where it was, and measuring the
jump would make the bar unmeetable for the mode rather than informative about it.
What the jump does cost an author is real and is not that: a carrier landing on
top of the player pushes them out, so the start of a repeat is a place to keep
clear.
`AnimatableBody2D` derives its contact velocities from the per-frame transform
delta, so read off the wrap that delta is tens of metres a second handed for one
frame to whatever is standing on the body and to the character sweep -
`AnimatableBody2D.teleported` re-snapshots instead, and the frame's contact
velocities are zero, which is the honest answer: a body that has vanished from
under a rider is carrying it nowhere.
The wrap is DETECTED rather than remembered - the distance falls where it rose -
so `MoverScript` takes the step it is being asked about (`dt`) and asks the
motion where it was one step ago, which keeps the pose a pure function of the
frame with no state a replay could get out of step with.

## Keys

A route node may **key** the body's `rot` and its `speed` where it stands
(`MoveNodeData`), on exactly the terms a camera path's nodes key their framing:
a node that carries one is a keyframe for THAT field only, a node that carries
none is transparent to it, between two the value is smoothstepped by arc length,
before the first and past the last it holds, and a field no node keys is the
body's own.

`rot` is an angle OFFSET in radians from the pose the body was drawn at, so a
minecart keyed -0.3 at the top of a drop and +0.3 at the bottom noses over the
lip and levels out again.
`moveAlign` is the same effect with no keys at all: an aligned body's rotation IS
the route's own direction. The track decides which way the body faces, exactly as
the route already decides where it is, so the drawn rotation stops being an input
to rotation the way the drawn position stopped being an input to position past
node zero. A `rot` key adds on top, which is what makes it a correction to the
track rather than a replacement for it.

It is the one place a mover's pose at time zero is not the pose the file drew,
and the alternative is worse. Measured as the CHANGE in the tangent since the
route began - which is what this was first written as - a cart drawn level on a
track that sets off down a 40° slope keeps a 40° error for the whole route: level
at the top where the track is steep, and 80° nose-down at the far end where the
track is only 40°. The worked minecart in `TEST_LIFT` read -81° against a -41°
rail, riding beside its track rather than on it, which is the one thing align is
for. A cart drawn ON its track is unmoved either way, since there the two agree -
so the absolute form costs an author who drew it right nothing, and corrects one
who did not. `cli movers` `keys` asserts a sloped START, which is exactly where
the two forms differ.

That tangent is the chord across a fixed **window** of arc length
(`TANGENT_WINDOW`, 25 cm either side) rather than the direction of the polyline
segment `s` lands in, and that is not a nicety. A segment's direction is constant
along it, so the segment's answer makes the tangent a STAIRCASE: an aligned body
holds one angle for a whole flattening step and then turns the entire
step-to-step angle on the single frame it crosses a vertex. On the worked
minecart that read as 7.11 cm/frame of surface speed against a 2 cm bar, almost
all of it in one frame in twenty. A window fixes it at the right resolution
too - taken between adjacent VERTICES instead, a corner between two straight legs
would spread its turn over a whole 4 m leg (a straight leg flattens to its two
endpoints) while the same corner on a curved one turned within centimetres, the
same authored shape reading differently for a reason that is about the flattener.
On a smooth stretch the chord's direction is the tangent at its midpoint, so the
window costs a curve nothing; what it spreads is a corner, over half a metre of
track. `cli movers` `keys` asserts the pair - a right angle IS turned, and no
centimetre of route turns the body more than a couple of degrees.

On a **`loop` the window wraps rather than clamping**, because a lap has no ends.
Clamped, the seam frame reads two one-sided chords over opposite halves of the
window and they differ by the route's turn across the whole of it: on a 2 m
circuit that is 0.13 rad delivered in one frame - an 8 rad/s kick, 7.3 cm/frame
of surface against the 2 cm bar - at the one point of a circle that has no right
to be different from any other. It is the same seam `buildMoveRoute` repeats node
zero's keys across and the same one `repeat` guards with `teleported`; the
tangent needed its own answer to it, and `cli movers` `keys` walks a cubic circle
in 1 cm steps and holds the seam step to the same turn as every other (it is 27x
that without the wrap).

`speed` is the load-bearing one, because keying it turns the trip time from a
division into an INTEGRAL: `ds/dt = v(s)` has no closed form for a smoothstepped
v, and integrating it a frame at a time would make where the body is depend on
how it got there - a mover's one inviolable rule broken, and a replay that lands
the platform somewhere else.
So a **pace table** is built at load (`MoveRoute.pace`) - arc lengths against the
seconds to reach them - and inverted per frame; per step the speed is taken as
linear and the time is the exact `L · ln(v1/v0) / (v1 - v0)` for that.
It is sampled at its own fixed step (`PACE_STEP`, the flattening's) rather than
at the polyline's vertices, and that is not a detail: a straight leg flattens to
its two endpoints, so a table built on the vertices reads a speed that ramps
along a straight run as one flat average.
A route that keys NO speed builds no table and takes the closed form it always
took, which is what keeps every level on disk and every recorded replay
arithmetically identical.

The ease and the speed keys compose without either knowing about the other: the
ease reshapes progress through the trip, the keys say how the trip maps onto the
route, and `distanceAtFraction` is where the two meet.

The pose is the **sum** of what the authored motions ask for, and `moverScript`
is one script rather than two composed for exactly that reason: a route may turn
the body and a pendulum certainly does, and two scripts each WRITING
`globalRotation` would mean the later one silently won.

**The constraint an author actually works inside is the contact speed.**
A mover's surface has to cross well under about 2 cm a frame or the character
sweep resolves against a surface that has already crossed the avatar.
A pendulum's fastest point is `amp × 2π/period × radius`, so that number bounds a
swing hard: a rideable one is a slow, heavy one, and shortening the beat or
lengthening the arm buys travel at exactly its expense.
A rotor is bounded harder still, because it never slows down: its far corner
crosses `2π/|period| × radius` on EVERY frame rather than only as it passes the
bottom, so a 1 m blade is already at the bar on a 5 s turn and a sail bolted at
its end needs twice the period a bar bolted through its middle does.
A route's is its FASTEST keyed stretch times what the ease peaks at, plus what
turning the body drags its far corners round at (`peakRouteTurnRate × speed ×
reach`) - which on a tight aligned bend is the larger of the two, and is the
reason the readout had to learn about rotation at all.
The editor's mover panel shows the sum live as a `cm/frame` readout, and
`cli movers` `levels` measures it on every mover the registry ships.

`cli movers` (`src/sim/moverCases.ts`) is the coverage, and it exists for the
reason `cli vines` does: a mover reaches no digest and no invariant, so a build
that quietly stopped reading a field renders a level that looks identical, plays
differently and violates nothing.
Beside the arithmetic (the arc, the beat, the turn and its seam, the route's legs
and laps, the ease's end rates, every phase, the curve's arc length against its
chord, the key interpolation's shape, the pace table against the harmonic mean)
it asserts the four claims that make a mover a mover: the pose is a pure function
of the frame, a lead boulder dropped on one changes its path by **nothing**, a
box resting on one is carried by it, and every authored field survives the
format's `px -> m -> px` and the editor's own round trip.
`repeat` adds the two its jump needs - the wrap imparts no contact velocity, and
a rider is never flung by it - and `legacy` asserts that a route authored before
any of this plays bit-identically to the modern form.

Authored in the editor's body panel (a swing angle and a beat, or a route drawn
on the canvas: drag a node, click a midpoint to insert one, Alt+click to remove
one, drag a round grip to bow a leg, with the body itself as node zero so the
route rides it; `smooth`/`sharpen` round or drop every tangent at once).
Clicking a node opens its keys under the route's own fields - blank is no key and
the placeholder is the value the node has anyway, computed through the very route
the sim builds (`routeOf`) - and a keyed node wears a **diamond** on the canvas,
selected or not, so where the cart tilts or changes pace can be seen without
clicking through every node.
Once a node keys the speed the route-level `speed` field is shown inert, reading
`keyed`, with the keyed nodes in its tooltip, since its value is read only on the
stretches nothing keys.
Both node fields read their placeholder off `MoveRoute`'s own key tracks
(`rotKeys` / `speedKeys`, which is why `speedKeys` is kept rather than folded
away into the pace table): assembling a second track in the panel is what it did
first, and on a `loop` that one was a key short - it missed node zero's closing
repeat and offered the last key's value where the motion was already easing back
toward node zero's, which is a placeholder that changes the motion when it is
typed in.
`TEST_SWING`, `TEST_SPIN` and `TEST_LIFT` are the worked levels - `TEST_SPIN` is
two counter-turning crosses to cross a chasm on and a sail on an authored
bearing, which is where the sign and the off-centre hinge are shown.
`level/movers.ts` holds the part that is about TIME - `swingOffsetAt`,
`buildMoveRoute`, `pointAlong`, `easeFraction`, `distanceAtFraction`,
`moveDistanceAt`, `moveAngleAt`, `moverScript` - shared by the build, the
editor's canvas and the cases, so what is drawn and what is played cannot
disagree.
The hand-written `addSlidingPlatform` / `addWindmill` builders are still there for
a level's `init` hook; a file-authored mover needs none, which is why the BALL
arena can have one at all (the ball driver takes no `init`).
`spinPeriod` is what `addWindmill` always did, offered to a file - which is the
only way the ball arena can have a windmill.
