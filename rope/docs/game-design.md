# Game design constraints

Constraints on what the physics system must model. These bound the problem
deliberately: the rope sim and rigidbody physics should **not** try to handle
scenarios outside this list. If a scenario isn't required here, it is out of
scope — don't add generality "just in case".

## Shape physics eligibility

Shapes fall into two classes with respect to the physics engine.

### Rectangles and polygons — never physics-driven

Rectangles and convex polygons are **never** moved or rotated by the physics
engine. Neither rigidbody dynamics (gravity, collision response) nor the rope
sim may alter their transform. They only ever change position/rotation in one of
two ways:

1. **Static** — fixed for the lifetime of the level.
2. **Explicitly scripted** — moved or rotated by game logic on an authored path
   (e.g. a floating platform sliding left/right, a windmill rotating about a
   pivot). The transform is driven by the script, not by forces.

The rope **wraps** around rectangles and polygons (they are collision geometry
and wrap-point providers), but wrapping never imparts force back onto them. A
player hanging from a rope wrapped around a rectangle does not move that
rectangle. Collisions push the player/circle out; the rectangle stays on its
scripted (or static) transform.

Implication: rectangles/polygons are treated as **infinite mass / kinematic**
by every physics interaction. Contact and rope solvers resolve entirely on the
other body.

### Circles — the only physics-driven shape

Circles are the **only** shape that the physics engine may move. A circle can:

- move when collided with by the player or another shape (rigidbody response),
- be moved by the rope (rope wraps a circle and drags it), and
- move the rope in turn (its motion feeds back into the rope sim).

Circles are the sole dynamic bodies. Any object that needs to be pushed around,
swung, or dragged by the rope must be a circle.

## Pass-through geometry must read as pass-through

A level contains things that stop you and things that do not, and they behave
nothing alike:

- **Solid bodies** — collision geometry. You stand on them, the rope wraps them,
  they stop you.
- **Areas** — regions. Nothing rests on them, the rope passes straight through,
  and they act on whatever is inside (a killzone resets the level, a force area
  accelerates you, water drags you toward its current).
- **Hook-only bodies** (`LevelBodyData.passable`) — scenery. Nothing collides
  with them and the rope never wraps them; only the hook catches on them, so they
  are something to swing from rather than something to land on. A static one is a
  grate, a girder, a chandelier; a rigid one is a leaf on a sprung stem, which
  still falls and still sags when it is grabbed.

Pass-through geometry must **never** be mistakable for a solid body. Fill colour
alone does not carry that distinction: colour is authored per-body, so an author
can — and will — give a killzone the same grey as a wall. The rule is therefore
stronger than "pick a different colour":

> Everything the player passes through carries a **glyph that names what it
> does**, stamped across its whole extent, and no solid body carries one.

The test is a screenshot with no legend and no interaction. Someone looking at a
still of the level — a bug report, an `cli render` snapshot, a design review —
must be able to say what every region does. Anything that only becomes apparent
by walking into it has failed.

Consequences for how the glyphs are drawn:

- **Cutouts, not overlays.** The glyph is punched out of the shape's fill as an
  even-odd hole, so it shows whatever is behind. An overlay needs a contrast
  colour that some authored fill will always defeat; a hole cannot be hidden by
  the fill it is cut from.
- **Tiled across the extent, at a fixed world size.** One badge in a corner is
  ambiguous about where the region ends, and a badge scaled to the box makes a
  big river look like a different thing from a small one.
- **Motion means motion.** A force area's arrows drift along its push, at a
  speed carrying its magnitude. A killzone's skulls are static — it does not
  flow anywhere, and a moving stamp would imply it does.
- **One source of geometry.** The glyph polygons live in `render/areaGlyphs.ts`
  and are emitted into an abstract path sink, so the game canvas, the level
  editor and the headless SVG snapshot all stamp identical marks. A renderer
  that skips them is a bug, not a simplification — the snapshot is exactly the
  case this rule exists for.

Current glyphs: `killzone` → skulls, `force` → flow arrows, `water` → flow
streaks drifting at the current's own speed, `passable` → a grate mesh (holes you
can see the backdrop through, which is what the body is). A new pass-through type
must bring its own before it ships.

**Hook-only bodies are the one pass-through type whose mark is 2D-only.** The
grate lattice is stamped in the 2D renderer, the editor and the SVG snapshot; in
3D the scene sets the body a quarter of a metre behind the gameplay plane
instead, and that setback is what says the player goes through it. A flat lattice
stamped over an object that is visibly behind the level fights the depth cue
rather than adding to it.

**Water is the one area that is a thing rather than a mark**, and in 3D it is
drawn as one: a translucent volume with a waterline, deep enough through z that
the ball is inside it (`render3d/water.ts`), with the 2D overlay standing down
where the scene draws it. That is not an exception to the rule above but the
same rule met a different way - nobody has ever mistaken a running channel for a
floor - and the streak glyphs are still what the 2D renderer, the editor and the
SVG snapshot stamp, so a still of the level names it there too.

The mirror-image pair is worth stating outright, because the two are one bit
apart and confusing them would be lethal to a level: an **impermeable** surface
is solid but hook-proof (the hook bounces off it), a **`passable`** body is
hook-only but not solid (everything else passes through it). They are drawn to
be unmistakable — the first keeps a full solid fill with a dashed steel edge,
the second is punched through with holes.

Both are flags rather than kinds, and they are flags on different things, which
is the asymmetry worth stating. Hook-proof is a flag on the **shape**
(`CollisionShape2D.impermeable`), because it changes only what the hook does with
a surface: a hook-proof crate still falls and is still hauled about, and a
compound wall can be attachable on one ledge and hook-proof on every other face.
Hook-only is a flag on the **body** (`CollisionObject2D.passable`), because it
changes whether the thing is in the way at all — it moves the body onto its own
collision layer and out of every collision path in the world, and a body half in
the way is not a thing a level can mean.

`passable` was a body *kind* (`anchor`), and that cost the case it exists for: a
kind is what a body IS, so hook-only could only ever be immovable scenery, while
the thing levels want is a leaf on a stem that hangs, sags and springs back. A
flag composes with `static` and `rigid` alike; a kind excludes every other.

### Rails

A third answer for the hook, beside biting a face and bouncing off one: a
**rail** is a thin bar the manacle clamps *around* and then slides along
(`CollisionShape2D.rail`, authored as `CollisionObjectData.rail`).
A zipline, a pipe, the handle of a hanging lantern.

It is a flag on the shape for exactly hook-proof's reason, and the case it
exists for is a body made of both: a lantern whose handles are rails and whose
lid, bulb and base are hook-proof, so the hook clamps a handle, slides along it
until the cuff meets the lid, and bounces off the bulb.
The bar is solid for everything else - the avatar stands on it, bodies collide
with it, other chains wrap its corners - and hook-proof wins where both are set,
since a hook that bounces off a piece never clamps it.

The cuff lives on the shape's **centreline** - a rect's medial axis, a
polygon's principal axis, a circle's centre (a peg the ring hangs on and pivots
about without sliding) - and it is a **massless ring**: force balance on a ring
on a bar is the friction cone, so the ring is stuck while the chain's pull stays
inside the cone and runs along the bar to the cone's edge when it leaves.
That is Coulomb friction exactly: on a frictionless bar the chain hangs plumb
and the ball coasts at constant speed; on one with grip the chain trails at
`atan(mu)` and the ball is braked at `mu·g`.
The rail's grip is the body's authored `friction` on the rail coefficients, so a
zipline authored slick and a rusted handle authored grippy are one number apart.

Where the cuff may travel is where its disc is clear of the body's other,
non-rail pieces - it stops against the lantern's lid - and it passes from one
rail piece onto a sibling whose centreline meets it, so a curved handle is three
straight bars.
An open end stops the cuff.

It is drawn with a steel line down the bar's middle, where the cuff will sit,
and the clamped cuff is drawn with its axis along the bar - encircling it -
rather than half-buried in a face.

### Viscous surfaces

A fourth answer, beside biting, bouncing and clamping: a **viscous** face - mud,
tar, wet clay - is one the manacle bites as it bites stone, sinks into up to
the hinge, and then creeps through (`CollisionShape2D.viscosity`, authored as
`CollisionObjectData.viscosity`; 0 is solid, 1 the reference mud, 2 twice as
stiff).
The cuff moves in the direction the chain pulls, at a rate that grows with the
square of the pull, so a hanging ball draws it slowly toward itself while a
falling ball caught on it drags it a long way before it is slowed to a hang.
Once the whole cuff has crept clear of the geometry nothing is gripping it,
and it drops out as the dangling tip - still armed, so it bites whatever solid
thing it lands on next, but never again the mud it crept out of until it is
thrown afresh (it leaves touching that face, and would otherwise sink straight
back in).

It is a number on the shape for hook-proof's reason - a stone wall with one mud
patch is one body - and a number rather than a flag because how sticky the mud
is IS the puzzle: a ceiling that holds for two seconds and one that holds for
ten are different levels.
Hook-proof wins where both are set, and a rail wins over it.
Solid for everything else.

It is drawn with a dash-dot ochre edge, in the same family as hook-proof's
dashed steel: a face that does something to the hook, and not the thing a plain
wall does.

### Decoration

**Decoration** - what the player sees that is not a body - carries no glyph, and it is worth being explicit about why the rule above does not reach it.
Every type the rule covers is a body or a region: it *does* something to whatever is inside or against it, and the glyph names that behaviour.
Decoration does nothing at all - no collision, no wrap, no force, no reset.
It is not a region the player can be inside; it is paint.
There is no behaviour to name, and stamping a glyph over authored artwork would defeat the only thing it is for.

Since 2026-09-29 decoration is not in the level at all: everything the player sees of a level is its Blender scene ([blender-scenes](blender-scenes.md)), and the level holds only what the sim builds and what lights it.
Before that it was a shape with its collision switched off, then a body with a geometry object and no collision object, and the 2D renderer drew it under every body and never stroked it (`render/decor.ts`, gone with it).
What still keeps a backdrop from reading as a wall that isn't there is the scene's own composition - depth, fog and the shadow rule (scenery wholly behind the gameplay plane casts nothing) - rather than a rule in the renderer.
A scene object bound to a moving body by name rides it, so a moving object can still look like anything.

## Convex-only polygons; compound bodies

Every polygon primitive is **convex**. Concave polygons are never allowed as a
single shape. This keeps collision and wrap-point math to the convex
case only — no concave decomposition at solve time, no reflex vertices *within*
a primitive.

A concave form (an L-shape, a star, a hull with a notch) is therefore a body of
**multiple convex polygons** — a compound body. The pieces share a transform and
move as one; each piece is convex and is collided/wrapped independently. What a
LEVEL authors, though, is the outline the geometry has, notch and all: the
loader cuts a concave outline into exactly such a set of pieces before anything
simulates it (see **Authoring a concave outline** below). The rule is a rule
about the primitive and about the solvers, and it is not softened anywhere; what
moved is where the pieces come from.

Consequence for vertices: a reflex ("inward") corner only ever exists at a
**seam between two convex pieces**, never inside a single primitive. A seam
vertex is an artefact of the decomposition, not a real edge of the body, so a
wrap candidate at a seam never becomes a wrap node: a span crossing the join
runs straight instead of snagging where the real surface is smooth.

What makes a vertex a seam is that the body has closed the outside off around it,
and that is a question about **angle**, not about how near the neighbouring
pieces are. Standing at the vertex, each piece covering it blocks off an arc of
directions; the vertex is still a corner of the body exactly when what is left
over is more than a half turn. A flat point has exactly half a turn left, a
reflex one less, a buried one none at all - and the outer corner of an L, which
two grid-snapped pieces may both own, has three quarters of a turn and is as real
a corner as any. Proximity would call that last one a seam, and did: the rope ran
straight through a wall until the hook happened to anchor to it.

The rule is enforced where the shape is *made*, not where it is used.
`polyShape` (the engine) refuses a non-convex loop outright, so no concave
primitive ever reaches a solver that would have to cope with one, and the cut
below is what every authored outline goes through on its way to that
constructor.

Why the rule is load-bearing rather than a simplification: the rope's wrap
solver decides which side of a body a span passes on from the body's own origin,
walks the vertex loop **monotonically** to find the tangent vertex, and can
never hold a taut contact on a reflex corner. A concave loop breaks all three at
once — the origin can lie outside the material, the walk stops on the wrong
vertex or fails to terminate, and any wrap generated at a reflex corner is
immediately culled and immediately regenerated, which is the flip-flop the
grazing-contact gate exists to suppress. Depenetration has no
minimum-translation answer for a concave shape either: a deep contact inside a
notch pushes out through the wrong wall.

A compound body is expressed either as several overlapping bodies (independent
transforms) or as one body carrying several shapes via
`CollisionObject2D.addShape` (one transform, so the pieces move and rotate as a
unit). Every path that scans geometry — contact generation, raycasts, rope
wrap generation, area overlap — iterates `getShapes()`, so a
compound body is not a special case anywhere. The exception is deliberate and
per-shape: `CollisionShape2D.wrappable` marks a shape that is solid but is *not*
rope geometry, which is what the ball & chain avatar's mounting loop is — the
chain deploys through it, so wrapping it would double-count the one piece of
geometry the chain is already threaded through.

The second form is what the level editor authors: selecting several shapes and
pressing Ctrl+G tags them into one `group`, and `buildLevelBodies` builds the
group as a single body whose origin is the pieces' combined centre of mass, each
piece mounted at its own local offset and angle. Choosing between the two forms
is a real decision and not a preference. Several bodies are several bodies: the
rope wraps the corner where two of them meet. One body with several shapes is
one body: that corner is an interior seam, and the rope runs straight across it. Author the form that matches what the geometry *is* - a wall
with a buttress against it is two bodies, an L-shaped ledge is one.

A compound body is also drawn as one object - its shapes filled as a union, and
outlined only where a piece is not covered by a sibling. This is the same rule as
the seam rule, stated in pixels: if the rope will not catch on a join, the join
is not an edge of the body and must not be drawn as one.

### Authoring a concave outline

A level authors the outline its geometry has, concave corners included, and the loader cuts it into the convex pieces above.
An L-shaped ledge is one polygon with six vertices in the editor and a two-piece compound body in the simulation, and the author never places the second piece.
That is the whole of the feature: the engine's convex-only rule is untouched, and what changed is that the decomposition is derived rather than drawn.

The cut is `decomposeConvex` (`lib/polygon.ts`), run by `makeShapes` as the object is built.
Ear clipping to triangles, then Hertel-Mehlhorn: every diagonal the triangulation introduced is dissolved again wherever the two pieces it separates merge into a convex one, so an L is two pieces rather than four triangles with three seams across its faces.
It has three properties the rest of the system leans on.

- It is a **partition**. The pieces tile the outline exactly, so their areas sum to its area, their masses to its mass, and their combined centre of mass lands on its centroid - which is what lets `makePieces` split one authored object's mass by piece area and get the same body a hand-authored one would have.
- It adds **no vertices**. Every piece corner is a corner the author placed, so the seam rule is decided over the same points either way: a reflex corner of the outline is covered by more than a half turn of material and neither wraps nor grabs, an outline corner is exposed however many pieces meet at it, and a seam is not a corner of anything.
- It is **deterministic**, because it runs at load rather than at author time: two machines reading the same file must cut it into the same pieces or they are simulating different geometry. `cli decompose` asserts all three, per outline, plus the piece counts - nothing else would notice an L that had started building as six pieces.

Two things are still refused, and for different reasons.
An outline that **crosses itself** is not a shape at all: it has no inside, so there is nothing to cut, nothing to weigh and nothing to fill. The editor stalls a vertex drag at the last position the loop was still a shape, and the poly tool falls back to the convex hull of a draft that crossed itself.
A **camera region** must stay convex, because nothing cuts one up: a region is tested by its face half-planes and grown into a buffer zone by offsetting them, and both of those read a notch as solid.
A **camera path** is not a degenerate region and is not held to that rule: it is an OPEN polyline tested by distance rather than a closed volume tested by containment, so it has no inside for a notch to be in, and crossing itself is exactly what a switchback is (see the camera section of `docs/level-design.md`).

A **hole** has no authored form either - one loop cannot express one - so a doughnut is still several bodies, or several outlines in one body.

Choosing between one concave outline and several convex pieces in one body is not a real decision any more: they build the same body, and the outline is the one an author can move a corner of afterwards.
Choosing between one body and several is exactly as real as it was (see above): the rope wraps the corner where two bodies meet and refuses the seam inside one.

## Chains between bodies

A **chain** is a rope strung between two authored bodies and solved every frame
by the same wrap-point solver the ball & chain uses. It is a
constraint and its drawing, and nothing else:

- It **holds** the pair. A rigid body on either end hangs, swings and is hauled
  by it; a static is infinite mass and simply holds.
- It is **not collision geometry**. Nothing stands on a chain, nothing collides
  with it, and another rope does not wrap it. Those would need the chain to be a
  body per link, which is a different mechanism with its own stacking and contact
  problems - and none of the scenarios above requires it.

A **vine** is that other mechanism, and it exists because one scenario does
require it: the hook has to be able to grab the thing anywhere along its length,
and a constraint is not a surface. It is a body per link, and the stacking and
contact problems above are removed rather than solved - a link blocks nothing and
is blocked only by statics, so a vine never stacks, never pushes and never fights
its own constraints through the contact solver. What it costs instead is the
LINKS: a vine is `length / spacing` bodies and that many constraints, all of them
swept every frame, which is why the spacing is a cost decision an author makes
(see `docs/vines.md`).

A chain is **scenery** in what may touch it, and level geometry in what it bends
around. It is drawn behind the level's geometry, faded, and solved against the
level's wrappable bodies but never against the play space: it hangs, swings and
hauls its own two bodies, catches on the corners of the level as the ball's chain
does, and passes straight through the avatar and the hook.

There was briefly a second, "foreground" kind - in the play space, drawn over the
geometry and solved against the whole scene, so the avatar and its hook could push
into it and be caught by it - and it is gone. It bought very little that a rigid
body on a chain does not already buy, and it charged for that by making every
chain a thing the player might silently snag on, and every wrap-and-corner bug in
the solver reachable from a piece of decoration.

A chain's anchor is a point on a body's **surface**, never in its interior. That
is what fastening a chain to something means, and it is also the only form the
solver can hold: a contact inside a body leaves the span starting inside it,
which the wrap generator resolves as a self-intersection and winds the chain
around its own anchor. Both the editor and the loader project an authored anchor
onto the nearest surface point rather than trusting it.

## Mobility classification

"Physics-driven" (above) is a *separate* axis from "can this shape move at all".
A scripted rectangle is not physics-driven, but it still moves. The character
controller cares about the second axis, because a surface's normal can change
under the player's feet.

Every shape is either:

- **Static** — transform is fixed for the level's lifetime. Its surface normals
  never change. A given face is permanently a floor, a wall, or a ceiling.
- **Mobile** — transform can change over time. Covers both scripted
  rects/polygons (moving platform, windmill, pendulum, lift) **and** circles
  (pushed/dragged by physics). A face that was a floor can rotate/shift into
  being a wall (or vice versa) from one frame to the next.

Static vs mobile is a property the character controller must be able to query
per shape.

### Scripted movers

A **scripted mover** is a mobile body whose transform the LEVEL writes rather
than the solver: `AnimatableBody2D`, infinite mass, with the per-frame contact
velocities the controller inherits from.
It is the third thing a body can be, beside static and physics-driven, and the
distinction it exists for is *authority*: a pendulum on a `pivot` rigid body is a
physical pendulum that a landing changes, and a scripted one is a rhythm that
nothing in the level can argue with - which is what a jump timed against it has
to be.

A level authors two of them (see `LevelBodyData.swingAmp` and `moveNodes`): a
body that **swings** about a bearing on a sine, and a body that **travels** an
authored route at an authored speed and under an authored ease.
Both compose on one body, and both are pure functions of the frame number, so a
recorded replay lands them where they were.

A route is a **cubic Bézier curve** - the same node list a camera path is, down
to the field names, and flattened, indexed and keyed by the same two modules
(`lib/path.ts`, `lib/keyframes.ts`) - and node zero is the body itself, so the
route rides the thing it belongs to.
Three **modes** say what happens at the end of it: travelled there and back,
gone round for ever, or run once and *teleported* back to the start.
Its nodes may **key** the body's angle and its speed where they stand, so a
minecart noses over the lip of a drop and runs away down it; `moveAlign` aims the
body along the route's own tangent, which is the same effect with no keys at all.
Keying a speed makes the trip time an integral of 1/speed along the route rather
than a division, which a table built at load inverts - so the pose stays
arithmetic on the frame number, which is what a replay needs it to be.

The constraint an author works inside is the **contact speed**: a mover's surface
must cross well under about 2 cm a frame, or the contact solve resolves against
a surface that has already crossed the ball. That bounds a swing far more than
it looks - a pendulum's fastest point is `amplitude × 2π/period × radius`, so a
rideable swing is a slow, heavy one - and it is what `cli movers` `levels`
measures on every mover the registry ships.

## The grapple character controller (retired)

The sections that stood here - surface reclassification and snapping, deliberate wall attach and the unattached wall jump, velocity inheritance from the supporting surface, and vertex-first ledge grabbing - specified the grapple controller's character movement.
That controller was retired on 2026-10-19; the full text is at commit `6e09e9e`.
