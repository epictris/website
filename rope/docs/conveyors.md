# Conveyor belts

A **belt** is a band wrapped round the outside of two or more wheels whose surface carries whatever rests on it.
An author places the wheels (a centre and a radius each), a band `thickness` and one signed speed (`ShapeData`'s `belt`, see [level-format](level-format.md)).
The plan it was built from is `plans/conveyor.md`: the two-roller first cut, then the addendum that made it a belt DRIVE of N wheels with a hollow loop, and the revision that named its three knobs and gave it a texture.

## A static with a surface velocity, not a mover

Every mover (see [movers](movers.md)) moves its body's TRANSFORM and derives contact velocity from the per-frame transform delta.
A belt's geometry never moves; only its material does, and the straight runs between the wheels cannot be expressed as any body's transform at all.
So a belt is what Box2D makes a conveyor: a static body whose surface has a tangent speed (`b2SurfaceMaterial.tangentSpeed` in v3, `b2Contact::SetTangentSpeed` in v2).

The engine's one hook for that is `PhysicsBody2D.velocityAtPoint`, which every carry path already reads: the contact solver's normal and tangent solves, the steered ball's ride, the rope's anchor motion, and the grapple avatar's grounded, wall and wall-jump states.
`ConveyorBody` (`lib/belt.ts`, a `StaticBody2D`) answers it with the belt's speed along the loop's tangent at the point of the loop nearest the contact, turned into the world.
Two things follow.

- **The contact-speed bar does not apply.** A mover's surface has to cross under about 2 cm a frame because the character sweep resolves against a surface that has already moved; a belt's surface has not moved, so the sweep sees a static and a belt can run as fast as friction can bring a body up to.
- **Speed 0 is bit-identical to static geometry.** A belt at speed 0 builds the very bodies its pieces authored by hand build, and plays them to the same digest (`cli belts` `static-equivalent`), because `ConveyorBody` answers `Vec2.ZERO` and `surfaceMoves` false until a piece has a speed.

## The three knobs

Three lengths describe a belt, named so they cannot be confused.

- **`r`**, per wheel: the WHEEL's own radius.
  The band lies on the wheel, so the belt's running surface round wheel `i` is a circle of radius `r_i + thickness`.
- **`thickness`**, on the shape: the band's depth IN THE PLANE, a length, `> 0`.
  It is collision: the surface stands this far off every wheel and the run quads are this deep.
  A band of no thickness has no inside and no outside to draw, and is refused.
- **`width`**: how wide the band is ACROSS the pulleys, the 3D extrusion depth.
  It is rendering only and lives where every geometry object's depth lives, on the belt's geometry twin (`depth`).
  The editor's belt panel shows it as `width` beside `thickness` and writes the twin's `depth`, so an author never has to know which object holds it.

The texture is a look too: the twin's `texture`, from the manifest as for any geometry object ([lighting-and-surfaces](lighting-and-surfaces.md)), offered on the belt panel for the same reason.

## The loop is a hull

The running surface is the **convex hull of the discs** of radius `r_i + thickness` about the wheel centres: a taut band round pins.
It alternates an ARC on a wheel with a straight RUN along the external tangent to the next wheel, so it is tangent-continuous everywhere, and two wheels are the old two-roller stadium (or its unequal-radius trapezoid) falling out of the same code.

**Every wheel must lie ON the hull.**
A wheel strictly inside it would be an idler pressing the band inward, which is a different path and is not built: the build throws naming the wheel, and the editor's `setBelt` refuses the edit.
A disc inside (or touching the inside of) another has no external tangent and is the same kind of error, as are fewer than two wheels, a wheel of no size and a band of no thickness (`cli belts` `degenerate`, `hull-refuses`).

**How the hull is found** (`buildBeltLoop`).
For each ordered pair of discs `(i, j)` there is exactly one external tangent that runs from `i` to `j` in the loop's sense: its outward normal `n` satisfies `n·u = (R_i - R_j)/d` for `u` the unit direction between the centres and `d` their distance, so `n` is `u` turned by `-beta` with `cos(beta)` that ratio, turned without trig from the ratio and its partner.
It is a hull edge iff every other disc lies on its inner side, `n·c_m + R_m <= n·from`, to a tolerance of `1e-9` of the belt's extent.
That is brute force, `N²` lines each tested against `N` discs, which at the handful of wheels a belt drive has is nothing and is far easier to get right than rotating calipers.
The loop is then WALKED: from the disc reaching furthest in `+x` (its rim at angle 0 is certainly on the loop), each disc is left by the hull edge whose normal turns LEAST from the one it arrived along, ties to the shorter run, until the walk is about to repeat its first edge.
Every wheel the walk never visits is inside the hull, and is the error named above.

**Degenerate drives.**
A wheel that exactly TOUCHES the band - the middle one of three equal wheels in a row - is on the loop, not an idler: the tolerance keeps rounding from putting it a femtometre inside, and it gets arcs of no sweep.
It touches both runs, so the walk visits it once going each way; that is why the walk chooses by turning angle rather than by "the one edge out of each disc", which would have two answers there.
A turn a hair under a whole one is two normals a rounding apart the wrong way round and is read as no turn, and the build holds the sweeps to exactly one turn between them.
`s = 0` is where the band arrives on wheel 0 (its first visit with an arc, if it is visited twice).

`BeltLoop` (declared in `engine/shapes.ts`, because nothing in `engine/` may import `lib/`) is a SEGMENT LIST in loop order, alternating arc and run: an arc names its wheel, centre, outer radius, start angle and positive sweep; a run its two tangent points, unit direction, outward normal and length.
`cum` and `total` run over the segments, and `pieceAt` names the mounted piece under each.
`beltPointAt`, `beltTangentAt`, `beltNormalAt`, `beltNearest`, `beltClosestS`, `beltPieceAt`, `beltSegmentAt` and `beltOutline` walk the list; `beltPointAt`, `beltTangentAt` and `beltNormalAt` reduce `s` modulo the perimeter themselves, and nothing else does.
`beltNearest` projects onto each run (clamped) and onto each arc (only inside the arc's range, since an angle outside it is nearer an end that is also a run's end) and takes the nearest; at the seams two candidates coincide, so it is continuous.
`beltOutline(loop, step, inset)` flattens the loop `inset` inside the surface, which at the band's thickness is its inner face, the same tangents offset.
`cli belts` `hull-3` holds the three-wheel drive the addendum draws (a small wheel top-left, a large one right, a medium one bottom-left): every disc inside every run, each tangent point on its disc, every wheel touched, the perimeter against a 200000-step integration, the tangent continuous across all six seams, and the row of three.

## The sense convention

**A positive speed turns the loop clockwise on screen: on a two-wheel belt drawn left to right, the top run carries toward the second wheel.**
In the y-down frame that is increasing angle about each wheel, which is also the winding every polygon in the engine has, so the outward normal at `s` is the tangent's Godot orthogonal exactly as for a polygon edge.
A negative speed runs the other way.
It is one signed number for the reason `spinPeriod` is ([movers](movers.md), "A rotor is one signed number"), px/s on disk and m/s in the sim, and it scales with the length factor.
`cli belts` `sense` asserts the convention through the body as well as the loop.

## The build: hollow, and exact where it matters

A belt builds, on its body:

- one `circle` of radius `r_i + thickness` at every wheel, in authored order: the wheel and the band on it as one solid disc;
- one convex QUAD per run, in loop order: the band along that run, from exit tangent point to entry tangent point, `thickness` deep, lying INSIDE the outer run line (`beltRunQuads`).

**Nothing covers the region between the wheels.**
That region is enclosed by the band on every side, so nothing in the plane can reach it, and leaving it empty is what lets an author put a wheel body or a prop inside without it being buried in a static (`cli belts` `hollow`: the middle of the drive and a centimetre under the band's inner face are inside no piece; the band and a wheel's centre are).
**The disc stays solid** because the arcs have to stay EXACT: the wrap resolvers bend a chain round a circle piece's true tangent points, and the ride puts the anchor on the true surface, and a ring-shaped arc piece would be a polygon of chords for both.
The inside of a disc cannot be reached in the plane anyway, so the solid disc costs nothing.
The seams between a disc and its run quads are tangent, as the stadium's were.

A quad goes through the polygon path (`makeShapes` on a `poly`), so it is re-centred and wound exactly as the same four points authored as a polygon; that, and the discs being plain circles, is what makes speed 0 bit-identical to the hand-authored pieces.
The masses are simply the pieces' sum: a belt only builds on a static, whose mass nothing reads, and what they do decide - the body's origin in `mountPieces` - has no older answer to match.
Every piece holds the same `BeltLoop` in the body's local frame (`CollisionShape2D.belt`) and the speed (`beltSpeed`), attached after the body's origin is final (`attachBelts`, the pattern of `attachRails`).

A belt may only be built on a `static` body that is not a mover: on a rigid body or a mover its surface velocity would have to compose with the body's own, and building it as anything else would play a different level from the one authored, so the build throws.

## The predicate: `surfaceMoves`, not `isMobile`

`isMobile` is about the TRANSFORM moving: it decides the AABB tree entry, the rope's continuous-sweep pose baseline and whether a ledge state follows its body.
A belt's transform is still, so it must stay false for all of those.
`PhysicsBody2D.surfaceMoves` asks the other question - may `velocityAtPoint` answer non-zero here - and is `isMobile` for every body but a running belt, so nothing recorded changes.

It replaces `isMobile` where a site is asking "may this surface carry me":

- the grounded state's `carriedVelocity`, its relative projection against a floor and its ceiling carry;
- the wall state's `carriedVelocity` and its relative projection, the wall-jump's relative projection, and the airborne state's relative projection, which is the same line as the wall-jump's;
- the scenery stiction pin (`applyStaticGrip`'s `offer`) and the steered ball's grip (`applySteeringGrip`), which both decline a surface that runs out from under them, since pinned in the belt's still frame a resting crate would be held against the carry.

It does NOT replace it in the grounded state's preference for a static floor as the locomotion basis (a belt underfoot IS the basis, and its frame does not drift), nor in the stuck detector (`mobileBodyNear`).
That detector only arms near a mobile body - a static wall pressed into is exempt - and walking against a belt at its own speed is zero displacement by design: armed on belts it fired `input-frozen` every 45 frames on exactly that treadmill, which `avatar-carried` now holds against.

## The drag is relative to the belt

`contactDamp` takes 2% of a body's velocity on every frame it meets something.
Taken toward the world's rest on a belt, that is 2% of the carry lost every frame and bought back by friction every frame: a crate rode a 2 m/s belt at 1.96 m/s, and a free ball was held on the spot spinning at `-V/r`, since the only state the drag and rolling without slip agree on there is a ball going nowhere - a treadmill.
A drag is a drag against the surface, so a body whose hardest-pushing contact is a running belt is damped relative to the belt's surface velocity there.
A crate now rides at exactly belt speed, and a free ball dropped on a belt is spun backward and dragged forward by friction and then walked by the drag to riding along at belt speed without turning, which is what rolling resistance does to a ball on a real one (`ball-rolls`).
Every other body keeps the literal world-frame product; a rider on a scripted mover has the same lag and is replay-locked.
None of it knows how many wheels the loop has: `carried-3` holds a crate and a free ball on the three-wheel drive's top run to the same numbers.

## The wake

A static is never a contact's leading side, so nothing else notices a running belt carrying a sleeping crate.
`buildLevelBodies` hands the belts back as it hands back the movers, and both `Level` and `BallLevel` call `World.wakeTouching` on every running belt EVERY frame, beside the mover loop, before the avatar, the chain and the contact solve.
A belt at speed 0 is scenery and wakes nothing (`wakes`).

## The energy source

The energy invariant excludes statics and counts every rigid body's kinetic energy, so a crate a belt brings up to speed is energy arriving from nowhere as far as it can tell.
`World.conveyedThisFrame` is set when a running belt's contact ends the contact solve carrying a friction impulse, and cleared at the top of the solve with `launchedThisFrame`; `EnergyMonitor.push` restarts its span on it exactly as it does for a trampoline, because a running belt is a motor the input cannot see (`energy-armed`).
The same motor reaches the ball through the chain while a ride holds it (see [the ride](#the-ride)), hauling a hanging ball along and up over a wheel with no contact of it on the belt at all.
A headless `TEST_BELT` lap fired `energy-gained` at f583 on exactly that lift, +34 J over a 389-frame span, so the monitor also restarts on every frame the ball's chain ends in a ride (`energy-armed` carries a hanging ball round wheel 0 at 3 m/s, and was red without it).
A rider on a scripted mover is the same hole and is out of scope here.

## The ride

A hook that bites a RUNNING belt rides it: the anchor is carried round the loop with the surface it bit, for as long as it holds (`RopeRide`, `lib/belt.ts`).
A belt at speed 0 is scenery and is bitten as scenery, so nothing about a still belt differs from the static pieces it is built from.
It is the third moving attachment beside a rail's clamp and a mud embed, and the simplest, because it is DRIVEN rather than solved: nothing the chain does moves it.

**What rides.**
The ball's manacle bites a belt exactly as it bites a face - the pin one ring radius proud along the arrival facing, the cuff mounted on the belt's body centred on the bite (`BallPlayer.onHookAttached`, after the rail and viscous branches and before the plain bite; a hook-proof belt still repels) - and then the pin, the cuff piece and the angle the cuff makes with the SURFACE are carried together.
The cuff keeps its arrival angle to the outward normal (`phi`), not its world angle, so a cuff carried round a wheel turns with the wheel: over the far wheel of a stadium it turns by exactly pi (`ride-round-roller`), and over the drive's large wheel by exactly that arc's sweep (`ride-3`).
The contact's piece index follows the arc length (`beltPieceAt`): the wheel's disc while the anchor is on an arc, that run's own quad while it is on a run, so the wrap resolvers walk the piece the anchor is on.
The grapple's hook rides the same way with no cuff and no standoff, the hook being a point (`Rope.attachmentAt`); the grapple's `Player` hands its rope the level's clock for it.
Letting go unmounts the cuff exactly as the plain bite's release does (`ride-detach`).

**The arc length is a pure function of the frame.**
`s(frame) = s0 + speed · ((frame − frame0) · dt)`, where `s0` is the arc length of the bite and `frame0` the frame it bit on; it is never accumulated and never reduced outside `beltPointAt`.
That is the rotor's argument ([movers](movers.md)): a reduced `s` would be a whole lap's jump on the seam frame to anything that differenced it, and an accumulated one would put the anchor where the bits of every frame before it put it rather than where the frame does.
So a replay that lands mid-ride, or a ride rebuilt from `s0` and `frame0` alone, puts the anchor on the same bits (`ride-pure`, two laps frame by frame against a fresh rebuild at every frame, and the anchor a level actually carried against its rebuild; `ride-3` again after the large wheel).
The drawn anchor is the same function asked between the last frame and this one (`RopeRide.renderPoint`, through the contact's `renderGlobalPosition`), so the chain, the drape and the cuff run smoothly round a wheel on a static body whose render transform never moves.

**Where the carry runs, and why there.**
`BallLevel` and `Level` carry the ride (`Rope.carryRides`) right after the movers and the belts' wake, and before anything regenerates the chain's path.
The continuous sweep measures the far end's motion from where the LAST regeneration left it (`lastEnd`, see [wrap-detection](wrap-detection.md)), so a carry made before the frame's first regeneration is end motion the sweep sweeps: a 6 m/s belt carrying the anchor 10 cm a frame past a 4 cm post under it wraps the post on the corner it came from, and the same carry with the sweep off goes through it (`ride-wrap-sweep`).
It is also before the chain phase for a second reason: moved to the end of it, just before the stall lease is measured, the carry opens a taut path the solve has already closed its books on, and winding in reads a hanging length that grows (`ride-winch` goes red on that placement, 0.07 mm in a frame).

**The chain round a wheel.**
The anchor goes round a wheel on its arc and comes away along the next run, and the chain bends round the wheel's disc as it passes over it with the wraps the resolvers already produce - several tangent nodes on the circle as the anchor moves round it, not one.
`ride-round-roller` and `ride-3` hold that the chain is wrapped on the disc on EVERY arc frame on which the straight line from the ball to the anchor would cut it by more than a centimetre (25 of 25 and 73 of 73), and on nothing else of the belt; a ball riding the band right behind its anchor needs no wrap, because the chord between them clears the disc.
One rule had to learn about it: a span between two nodes on the same piece is skipped (`shouldIgnorePathCollisions`), because a stretch of chain between two points of one surface lies on it.
An anchor riding round a wheel moves ALONG the piece, away from the wrap the chain took on that wheel as it came over, and skipped, the chord from that wrap to the anchor deepened through the wheel for the whole arc (`chain-clip`, 3-4 cm for twenty frames).
A span that ends on a ride is now tested, and the start resolver bends it round the wheel to the tangent from the anchor.

**What the rope reads as the anchor's velocity.**
`Rope.creditBound`'s opening rate asks each path point how fast it is moving, and a `ConveyorBody` answers `velocityAtPoint` with its SURFACE, which is the right answer for a body resting on the belt and the wrong one for a rope node.
Measured with the ride in place: a wrap node on the belt's tangent seam - a material point of the still frame - reported up to 0.97 m/s of opening rate into a taut chain's bound (the ball hauled up and over a wheel), and the carried pin on an arc was reported 5-7% slow and a few degrees behind the carry, because the belt answers at the loop point nearest the pin and the pin stands off the surface.
So the rope asks the NODE (`Rope.nodeVelocity`): a ride answers its carry exactly (`RopeRide.velocity`, the derivative of the pure function, `speed · (t + t.rotated(phi) · h / R)` on an arc of outer radius `R` and `speed · t` on a run), and any other node on a running conveyor answers zero, its frame being still.
In that scene the change moved the ball by at most 0.13 m/s on one frame; nothing had misbehaved on it, and it is kept because the number it corrects was measured wrong.
Winding in while carried is not read as a block, hanging under the belt or dragged along the running surface it stands on: no chain is paid out, the hanging length only shrinks while taut, the stall lease stays shut and the wind stall never latches (`ride-winch`).

**Not built: release at a wheel.**
The hook is carried for ever, as a mover carries what it holds; a ball hanging under the bottom run is carried round wheel 0, dragged up and over it and on along the top run.
Letting go at a wheel is an authored option for later.
The chain going round a wheel UNDER LOAD - the ball swinging from an anchor on the arc, hauled against the moving wheel - is the one geometry nothing in the corpus resembles; the cases cover the kinematics and the wraps, not the feel, and it is the first thing to play.

## The tear-out

A carry the chain cannot follow tears the cuff out.
The carry is driven, so when geometry holds the ball while the belt takes its anchor away, the only other thing that can give is the stall lease, and it pays the carry out for as long as it lasts.
`TEST_BELT` found it: the ball rode the low belt to its end and dropped to the floor, the anchor came round the far wheel onto the bottom run 20 cm over the floor, and the ball wedged at the mouth of that gap; the lease grew by exactly one frame of carry a frame (25.0 mm at 1.5 m/s) and ran the 1.8 m chain out to 3.04 m in fifty frames (`rope-grew` from f291 of a headless 300-frame script).
So once a ride's lease passes the attach's own snap (`ATTACH_SNAP_TOLERANCE`, 20 cm), the bite gives: the cuff comes out as the dangling tip, clear of the surface along its normal and moving with it, armed as a cuff out of mud is, with the belt's pieces shed so it does not bite straight back into the belt it lies against (`BallPlayer.tearOffOverdrawnRide`, at the top of the frame before the carry).
The lease and not the whole length, because a ride may be anchored at any length: a ball on 86 cm carried into a wall leased to 1.87 m before an absolute bound would have noticed, a metre past its anchoring length (`ride-tear`, red with the tear removed).
The wind-up's own leases against a ride - millimetres, while wound tight and still whirling - are nowhere near it.
The 20 cm is borrowed rather than tuned, and how soon a jammed ball should lose its anchor is for playing.

## Rendering

A belt collides as discs and quads and is drawn as the one BAND it is, and **no wheel is drawn**: an author places wheel props at the wheel centres, inside the band's hollow.

**2D.**
The renderer (`collapseBelts` in `render/renderer.ts`) takes a belt's pieces out of what it draws as geometry and draws the band instead: its outer loop and its inner loop filled together EVEN-ODD, so the inside of the belt shows the backdrop, and both loops edged as a piece's border is (`beltBand`, cached per loop).
The SVG snapshot draws the same path with `fill-rule="evenodd"`, and `outlineOfData` answers the band as a `poly` outline with the inner loop as its `hole`, which the path writers emit reversed so an ordinary nonzero fill leaves it empty - so the editor's fills, strokes and unions show the hollow with no belt-specific code.
Both loops are flattened at no coarser than 48 chords a turn of the smallest wheel (`beltDrawOutline`), since the path flattener's 25 cm step left a 20 cm wheel as three chords.

What says the belt runs in 2D is its **tread**: short ticks across the band, reaching inward from the surface (5 cm, or a third of the smallest arc, or 60% of the band, whichever is least - a tick is a mark ON the band, never a spike through it into the hollow), since the outline is the collision surface and a mark standing proud of it would be drawn where a crate sits (`render/beltTread.ts`).
Their pitch is the nearest to 20 cm that goes round a whole number of times, so there is no seam where `s` wraps.
They are carried round by `(t · speed) mod pitch`, with `t` the SIM time the frame is interpolated to, `(frame - 1 + alpha) / 60` (`beltRenderTime`), which is the instant the bodies riding the belt are drawn at.
So a replay shows the same belt at the same frame, and a paused game shows it standing.
The SVG snapshot pins the phase at 0, as it pins the force arrows, and the editor draws the ticks standing still with an arrowhead over the middle of the longest run for the direction.

**3D: the band is its own geometry** (`BeltRing`, `render3d/beltTread.ts`), not an extruded outline.
A belt's running surface is the OUTER WALL of the ring, and that is the face a texture belongs on, laid by ARC LENGTH along the loop so a rubber tread tiles along the belt without stretching round a wheel.
The ring is cut at stations along the loop - 64 a turn on an arc, a run's two ends, and the perimeter itself last, so the first and last stations are the same point - with eight vertices each: the outer wall at both caps, the front cap's outer and inner rim, the inner wall a `thickness` in at both caps, the back cap's inner and outer rim.
Each face has its own normals (the surface's outward normal, its inverse, `±z`), so the edges are creases and no two faces share a plane: nothing to z-fight.
UVs are in metres, the extruder's convention that `applyTiling` turns into repeats: `u` is arc length along the OUTER surface at a rate that makes one repeat the nearest length that goes round a whole number of times (`beltTextureTile`), so `u` at the last station is a whole number of repeats past the first and there is no seam where `s` wraps; the caps and the inner wall carry the same `u` as the surface they stand on, so the band's edge and its surface agree at the rim.
`v` runs on round the cross-section - outer wall back to front, front cap out to in, inner wall front to back, back cap in to out - so it is continuous over every rim but the one at the back of the outer wall, which this camera never sees.

**The motion** is the texture scrolling: every frame the ring's `u` is `(s - speed · t) · rate`, with `t` the sim time above, reduced into one repeat (`BeltRing.sync`).
It is written into the ring's OWN UV buffer rather than the material's map offset, because materials are shared and cached (`assets.ts`) and an authored set's maps are swapped into the shared material when they arrive; a UV write is a few hundred floats a frame and touches nothing else, and a belt whose phase has not changed skips it.
**Untextured** - the flat colour, `texture: "color"` - the band has nothing to scroll, so it keeps the cleats: a ring of thin pale slats (one `InstancedMesh` per belt) set just inside the surface (4 mm, or a fifth of the band if that is less), through the whole width and 4 mm out past both caps, so what shows is a slat end on the rim of the front cap.
Cleat placement allocates nothing (`beltFrameAt` is `beltPointAt`/`beltTangentAt` written into a scratch record, and `cli render3d` holds the two to agree).
The tread runs at the geometry object's own `speed`, which a matched twin mirrors from the collision object; `Scene3DLevel.frame` is how the clock reaches the scene, and a host with none (the editor's preview) draws the belts still.
A mesh prop standing in for a belt draws what its file draws, with neither.

All of it reads the world and writes nothing.

## The editor

`+ Belt` lays one: the press is wheel 0, which is the item's own position, and the drag places wheel 1; a click drops a two-wheel belt 1.5 m long on 10 cm wheels under a 5 cm band, running at 1 m/s.
More wheels come from the band itself.

- **Insert:** every run shows a midpoint handle; pressing it inserts a wheel under that point (the size of the smaller of that run's two wheels) set so its band just TOUCHES the run there, which changes nothing about the loop, and drags it straight away - the path's insert gesture (`beltInsertWheel`).
- **Remove:** Alt+click on a wheel's centre square removes it, never below two (`beltRemoveWheel`); removing wheel 0 moves the item onto the wheel that takes its place, so the belt stays where it was.
- **Move a wheel:** every wheel has a square centre grip, dragged like a path vertex; wheel 0's is the item's position, so pressing it picks the wheel and moves the whole belt as a press on the body does.
- **Size a wheel:** a round grip on each wheel's rim, facing away from the middle of the belt, drags its radius.
- **Pick a wheel:** pressing a wheel's square or its radius grip picks it (the square fills), and the panel then shows that wheel's `r`.

The panel has `thickness` (px), `width` (px, the geometry twin's `depth`), the twin's `texture` (with `color` meaning the flat fill and the cleats), `speed m/s` (signed: positive runs the loop clockwise on screen), the picked wheel's `r`, and readouts of the loop's **perimeter** and one **lap** of its surface, `P / |speed|` ([editor](editor.md#conveyor-belts), [editor-model](editor-model.md)).
A belt with no geometry twin has no look to edit, and the panel says `Add geometry` gives it one.

Every edit of the wheels or the thickness goes through `setBelt`, which refuses a wheel off the hull, a disc inside another, or a thickness or a radius under a pixel, so no gesture can hand the build a belt it throws on: a drag stalls at the last valid belt.
Wheel 0 staying at the item's origin is kept by the gestures (it has no drag grip of its own, and removing it re-origins the item) rather than demanded by `setBelt`, so a hand-edited file with wheel 0 elsewhere is still editable.
It asks the build's own loop whether the wheels make one (`beltLoopOf`), so the editor and the build cannot disagree about what is a belt.
The editor draws, as editor marks the game does not, a thin circle at each wheel's own radius and a dot at its centre, so the wheels can be seen and grabbed; a click in the hollow between the wheels passes through the belt to whatever is inside it (`pointInBody` picks the band and the wheels, where it collides).
A belt on a body that is not a plain static is a fact about the body rather than the shape, which a kind change or a merge can make true after the belt is drawn.
The editor does not throw on it: its title says `DOES NOT BUILD:` with the build's message, the 3D view keeps the last scene that built and ▶ Test refuses to start.
`cli render3d`'s `belt:` cases hold that `modelFromDisk` then `modelToDisk` keeps every field, the wheel list and the matched twin included, and that `setBelt` refuses the idler, the nested disc and the zero thickness and inserts and removes as described.

## What was rejected

- A rotor plus a traveller: transform-based, bounded by the contact-speed bar, and the straight run has no transform.
- A `force` area over a low-friction bed, the river pattern: it accelerates a volume rather than a surface, has no loop and carries no hook.
- `surfaceMoves` in the stuck detector: armed on belts it fired `input-frozen` on the treadmill (see [the predicate](#the-predicate-surfacemoves-not-ismobile)).
- The drag toward the world's rest on a belt: a crate lagged the belt and a free ball was held on the spot (see [the drag](#the-drag-is-relative-to-the-belt)).
- The carry at the end of the chain phase, and a tear-out bound on the whole chain length rather than the lease (see [the ride](#the-ride) and [the tear-out](#the-tear-out)).
- A solid loop (one quad between two rollers): it buried anything put inside the belt, and a belt drive's wheels are what the author wants to show there.
- Ring-shaped arc pieces instead of solid discs: chords where the wrap resolvers and the ride need the true circle, for an inside nothing can reach.
- Rotating calipers for the hull: correct, but far harder to get right than brute force at the few wheels a belt has.
- The extruded loop with a scrolled map offset (the first cut used cleats instead): the extruder's side-wall UVs are anchored to x/y and turn into the depth axis where the outline goes vertical, and the material's offset is shared by every object wearing it.

## Coverage

`cli belts` (`sim/beltCases.ts`, in `bun run test`) holds the mechanics: the stadium and unequal perimeters, the seams on two and three wheels, the projection round trip and against a brute-force search, the sense, the degenerate inputs, the three-wheel hull and what it refuses (`hull-3`, `hull-refuses`), the hollow build (`hollow`), the format round trip and the build (`authored`), `static-equivalent`, the carry cases (`crate-carried`, `reverse`, `ball-rolls`, `carried-3`, `avatar-carried`, `wakes`, `no-pin`, `undisturbable`, `energy-armed`), and the ride (`ride-pure`, `ride-carried`, `ride-round-roller`, `ride-3`, `ride-wrap-sweep`, `ride-winch`, `ride-detach`, `ride-tear`).
The two-wheel cases were re-authored for the band: each puts the wheel `thickness` inside the surface radius it was written against, so its numbers hold with the surface at `r + thickness`.
`cli render3d`'s `belt:` cases hold the drawing and the editor: the 3D tread's frame against the loop's closed form, the pitch and the phase's sign, one band plus a ring of cleats inside it carried by the sim clock, the ring's walls and caps, its arc-length `u` closing on a whole number of repeats, the scroll, the 2D band's hole, the editor round trip and the editor's refusals.
The feel of the carry - how fast a crate comes up to speed - is `mu`, the author's per-body `friction`; no constant was introduced, so nothing here is tuned.

## Open

- Releasing a ride at a wheel (see [the ride](#the-ride)).
- Belts on moving bodies (rigid or scripted) are refused by the build.
- Idlers: a wheel pressing the band inward is a different path (a concave loop) and is refused.
- A prop at a wheel centre turns only if the author gives it a rotor; "spin with the belt" on a prop is a later step.
- Riders on scripted movers still have the energy hole and the world-frame drag lag that a belt's riders no longer have.
- The 20 cm tear-out threshold is borrowed from `ATTACH_SNAP_TOLERANCE`, not tuned.
- A chain lying ON a running wheel is not dragged by it: its wrap nodes are material points of the still frame, which is what the rope is told (`Rope.nodeVelocity`).
- Not yet seen in a browser: the scrolled texture and the cleats on a real GPU, the 2D band at play zoom, the editor's wheel gestures and its `DOES NOT BUILD` title, the chain round a wheel under a swinging ball, the tear-out's feel, the drawn cuff sliding round a wheel, and a browser bundle on `TEST_BELT` through `cli diverge`.
