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
- **Hook-only anchors** — scenery. Nothing collides with them and the rope never
  wraps them; only the hook catches on them, so they are something to swing
  from rather than something to land on.

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
streaks drifting at the current's own speed, `anchor` → a grate mesh (holes you
can see the backdrop through, which is what the body is). A new pass-through type
must bring its own before it ships.

**Water is the one area that is a thing rather than a mark**, and in 3D it is
drawn as one: a translucent volume with a waterline, deep enough through z that
the ball is inside it (`render3d/water.ts`), with the 2D overlay standing down
where the scene draws it. That is not an exception to the rule above but the
same rule met a different way - nobody has ever mistaken a running channel for a
floor - and the streak glyphs are still what the 2D renderer, the editor and the
SVG snapshot stamp, so a still of the level names it there too.

The mirror-image pair is worth stating outright, because the two are one bit
apart and confusing them would be lethal to a level: an **impermeable** surface
is solid but hook-proof (the hook bounces off it), an **`anchor`** body is
hook-only but not solid (everything else passes through it). They are drawn to
be unmistakable — the first keeps a full solid fill with a dashed steel edge,
the second is punched through with holes.

They are not, however, the same *kind* of thing, and that asymmetry is
deliberate. Hook-proof is a flag on the **shape** (`CollisionShape2D.impermeable`,
authored per level entry), because it changes only what the hook does with a
surface: a hook-proof crate still falls and is still hauled about, and a
compound wall can be attachable on one ledge and hook-proof on every other face.
An `anchor` is a body kind, because what it changes is what the body *is* — it
occupies its own collision layer and is outside every collision path in the
world, which is a statement about a body and cannot be made a piece at a time.

### Decoration

**Decoration** - a shape with its collision switched off (`LevelBodyData.collision: false`) - is the one thing the player sees that carries no glyph, and it is worth being explicit about why the rule above does not reach it.
Every type the rule covers is a body or a region: it *does* something to whatever is inside or against it, and the glyph names that behaviour.
Decoration does nothing at all - no collision, no wrap, no force, no reset.
It is not a region the player can be inside; it is paint.
There is no behaviour to name, and stamping a glyph over authored artwork would defeat the only thing it is for.

It is a flag on an ordinary shape rather than a type of its own, and that is a deliberate reversal: decoration used to be its own list (`backgrounds`) precisely so the sim could not see it.
The exclusion is now made by never BUILDING the shape - it becomes no collision shape and enters no `World` - which is the same guarantee with none of the cost, since decoration is otherwise an ordinary authored shape with the ordinary 3D visual, the ordinary group tag and the ordinary tools.
A wall becomes a backdrop by unticking a box.

What it must still carry is that it is **not a body**, and that is supplied compositionally rather than by a mark, which is why both halves are in one place (`render/decor.ts`) and shared by the editor and the game:

- **Drawn under everything.** Decoration goes down before any body, whatever its position in the authored list, so nothing the player can touch is ever occluded by it. Anything drawn over decoration is real.
- **Never stroked.** A border is what makes a shape read as an object; a backdrop has none, and every body draws over it with one. A bordered panel is the failure mode this forbids - that is exactly a wall that isn't there.

The still-frame test is met the same way as before: in a screenshot, everything outlined is a body, everything flat and behind them is paint.
The editor draws its own dashed teal outline on decoration, which is editor chrome (it also draws handles, marquees and camera guides), never reaches the game, and is what tells an author at a glance which shapes on the canvas are part of the level.

Decoration may be **welded into a compound body** (the same `group` tag the shapes carry), which makes it decoration *of that body*: it is drawn in the body's frame, so a backdrop on a swinging rigid assembly swings with it.
Nothing else changes - it is still paint, still under every body, still unstroked, and it adds no shape, no mass and no seam to the body it rides.
That is the point of allowing it: without it, decoration can only be authored on scenery that never moves, and a level that wants a moving object to look like anything has to build the look out of collision geometry.

It is also how a **prop with no collision** is placed, since it keeps the full `visual` field: a GLB with its physics unticked is scenery, and the collision it does not have is exactly what makes it scenery rather than an obstacle nobody can see the shape of.

## Convex-only polygons; compound bodies

Every polygon primitive is **convex**. Concave polygons are never allowed as a
single shape. This keeps collision, wrap-point, and ledge math to the convex
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
**seam between two convex pieces**, never inside a single primitive. Seam
vertices are not ledge candidates (see below) — they are an artefact of the
decomposition, not a real grabbable edge of the body. The rope holds the mirror
of that rule: a wrap candidate at a seam never becomes a wrap node, so a span
crossing the join runs straight instead of snagging where the real surface is
smooth.

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
unit). Every path that scans geometry — the character sweep, raycasts, ledge
candidacy, rope wrap generation, area overlap — iterates `getShapes()`, so a
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
rope wraps the corner where two of them meet, and ledge detection offers it as a
grab. One body with several shapes is one body: that corner is an interior seam,
and both refuse it. Author the form that matches what the geometry *is* - a wall
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
by the same wrap-point solver the grapple and the ball & chain use. It is a
constraint and its drawing, and nothing else:

- It **holds** the pair. A rigid body on either end hangs, swings and is hauled
  by it; a static (or an `anchor`) is infinite mass and simply holds.
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
(see **Vines** in `CLAUDE.md`).

A chain is **scenery**, and that is all it is. It is drawn behind the level's
geometry, faded, and solved against nothing but its own two bodies: it hangs,
swings and hauls those two, and passes straight through the level, the avatar and
the hook.

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
  rects/polygons (moving platform, windmill) **and** circles (pushed/dragged by
  physics). A face that was a floor can rotate/shift into being a wall (or vice
  versa) from one frame to the next.

Static vs mobile is a property the character controller must be able to query
per shape.

## Surface reclassification (character controller)

When the player is standing on or sliding down a surface, the controller
classifies that contact as floor / wall / ceiling from the surface normal
(relative to gravity), and forces a state transition when the class flips.

The contact normal can change from one frame to the next for **two independent
reasons**, and both must be handled:

1. **The surface moved** (mobile shapes only). A windmill blade rotates and its
   top face tilts past the floor/wall threshold; a rotating platform shifts both
   contact point and normal; a circle rolls under the player.
2. **The player moved** (applies to *every* shape, static included). The player
   walks across a vertex/edge onto a different face — a static ramp's flat top
   onto its steep side, or around a polygon corner — so the surface beneath them
   is now a different face with a different normal.

Because reason 2 applies even to static geometry, the classification is **not**
invariant for static surfaces. There is no "compute once and skip" shortcut:

> The controller must re-evaluate floor / wall / ceiling classification **every
> physics frame** while in surface contact, for static and mobile shapes alike,
> and force the appropriate state transition when the class changes.

The static/mobile distinction (above) still matters for the physics/rope solvers
and for *why* a normal changed, but it does **not** let the controller skip the
per-frame reclassification.

## Surface snapping (character controller)

While in surface contact the controller does not rely on the slide loop alone to
keep the player attached — after each frame's move-and-slide it actively snaps
back onto the surface. This is what lets the player walk over a convex corner or
down a slope crest without launching, and hug a wall whose normal is changing.
Two variants, matching the two contact states:

**Snap-to-ground** (grounded). If the slide loop produced no contact this frame
(the player moved past the edge of the supporting face), do a *test* move one
unit along the inverted stored surface normal (i.e. into where the floor was):

- No hit → genuinely airborne; transition out.
- Hit a **physics-driven body** (circle) → do not snap; go airborne. Snapping
  only targets static/scripted geometry.
- Hit a surface whose normal is too aligned with the player's current
  motion-plus-gravity direction → reject the snap (the candidate face is the one
  the player is moving *away* from); go airborne.
- Otherwise: teleport the player by the test move's travel (skipped while a rope
  is attached — the rope constraint owns position there) and **reclassify** the
  new normal: floor → stay grounded on the new face, wall → wall slide *if
  toward-input is held* (see deliberate wall attach below), otherwise airborne,
  ceiling → airborne. So walking over a rounded crest onto a steep side flows
  directly from grounded into wall-slide via the snap, without an airborne gap,
  but only while the player is inputting into the face.

**Snap-to-wall** (on wall). Every frame still on the wall, the controller moves
the player *into* the wall (a large motion along the inverted wall normal); the
resulting collision both re-presses the player against the surface and refreshes
the stored wall normal from the hit. Around this snap the wall state also
probes:

- A vertex-first ledge query (see the ledge section below): if a grabbable
  corner lies within grab reach of the player's swept path, the wall ends in a
  ledge — moving up transitions into ledge climb, otherwise into ledge hang.
  Detection is by corner, not by ray, so approach speed and wall angle cannot
  produce misses; the reachability rules (floor top face, wall hang face) are
  evaluated on the corner itself.
- A ray into the wall from the player's position: no hit → the wall ran out;
  go airborne.
- After the snap, if the refreshed normal now classifies as **floor** (the wall
  curved or rotated under the threshold) → transition to grounded.

Both snaps are the mechanism that makes the per-frame reclassification (above)
concrete: the snap collision is where the fresh normal comes from.

Two wedge rules keep the player controllable when a **mobile** surface presses
them against other geometry:

- **Ground contact wins over a mover's wall.** While grounded, a wall-classified
  contact with a mobile shape that is *not* the supporting surface (a windmill
  blade sweeping into a player standing on the floor) does not transfer the
  player into wall-slide — they stay grounded and can keep running along the
  floor. Static walls, and the player's own support steepening past the floor
  threshold, still hand over to the wall state.
- **Stops are relative to the surface.** Where a collision would kill the
  player's velocity (running into a wall), against a mobile surface the player
  instead keeps their velocity *relative* to it — only the relative normal
  component stops, so input still moves them along the surface and an advancing
  mover pushes rather than freezes them. Against static geometry this reduces
  to the plain stop.
- **Separating contacts are positional only.** A depenetration pushout from an
  advancing mover while the player already moves away from it corrects position
  but never redirects velocity — otherwise the pushout would rotate an escape
  velocity into the opposite wedge face.
- **Rotating faces get grip grace.** A face on a *rotating* body classifies as
  floor up to a steeper angle (~65° instead of ~55°). A blade face hovering at
  the static threshold would otherwise flip the player between grounded and
  wall-slide and treadmill them against the rotation. Translating movers and
  static geometry keep the normal thresholds.

## Deliberate wall attach and the unattached wall jump

Touching a wall never captures the player by itself.
The wall states (wall run / wall slide) are only entered while the player is actively inputting movement toward the wall, mirroring the deliberate-grab rule for ledges (below).

- Airborne or grounded contact with a wall under toward-input attaches; contact with no input, or with away-input, does not.
  The wall still stops the normal component of motion, but the player keeps falling (or stays grounded) past it.
- The toward-input requirement is continuous while sliding: releasing it detaches the player into a fall.
- This subsumes the old mover-wedge attach guard: no wall, mobile or static, captures a grounded player without input.

Wall jumps do not require being attached.
A buffered jump while airborne, with a wall face within touch range (player radius plus a small margin, probed on both sides, held direction first), launches a wall jump off that wall exactly as if jumped from the wall state.
Falling flush against a wall with no input therefore still allows jumping off it.

## Velocity inheritance from the supporting surface

While the player stands on or slides down a mobile surface, they inherit that
surface's velocity **at the point of contact** — not its absolute / centre-of-mass
velocity.

For a body with linear velocity `v` and angular velocity `ω`, the velocity at a
contact point offset `r` from the pivot is:

```
v_contact = v + ω × r
```

Consequences:

- **Rotating rectangle/polygon (windmill).** The pivot has zero linear velocity,
  but the contact point does. A player near the blade tip is carried much faster
  than one near the hub — different points on the *same* body impart different
  velocities. Using the body's absolute velocity (which for a pure rotation is
  ~zero at the centre) would be wrong; it must be the per-contact-point velocity.
- **Sliding platform.** Pure translation, `ω = 0`, so `v_contact = v` everywhere
  — the player is carried at the platform's linear velocity.
- **Circle.** The player inherits the circle's surface velocity at the touch
  point (linear plus spin, if the circle rolls).

This carried velocity is added to the player's own locomotion — moving on top of
a platform composes the platform's contact-point velocity with the player's walk
input, so walking against the platform's motion behaves correctly. When contact
is lost (jump, walk off the edge, surface rotates away) the player keeps the
contact-point velocity they had at separation as their launch velocity.

## Vertex angles and ledge candidates

For each vertex of a rectangle or polygon, store the **interior angle** between
its two incident edges. This drives ledge detection — whether the player can
grab and hang from that corner.

- A sufficiently **convex** corner (interior angle at/below a grab threshold — a
  rectangle's 90° corner qualifies) is a valid **ledge candidate**.
- A flat/near-straight vertex (interior angle ≈ 180°) is **not** grabbable.
- Within a single convex primitive no vertex is reflex (convex-only, above). A
  reflex corner can only appear at a **compound-body seam**, and seam vertices
  are **not** ledge candidates.

The interior angle is **rotation-invariant** — rotating or translating the shape
does not change the angle between two edges. So it is computed **once** per
vertex (at level build / mesh definition) and stored, for static and mobile
shapes alike. Mobile shapes never need it recomputed.

What *does* change under rotation is the **world orientation** of the ledge:
whether the corner currently faces up enough to be reachable and which side the
player must approach from. So ledge grabbing splits into:

1. **Candidacy** — from the stored interior angle. Fixed per vertex.
2. **Reachability** — evaluated against the vertex's *current* world position and
   edge normals (per frame for mobile shapes, since a rotating corner can swing
   into or out of a grabbable orientation).

Grabbing is also **deliberate**: a ledge is only grabbed while the player is
actively inputting movement toward the wall. Sliding up past a lip with no
toward-input continues past it with the current velocity — candidacy and
reachability gate what *can* be grabbed, input gates what *is*.

Reachability requires the ledge's **top surface to classify as a floor** (same
normal-vs-gravity thresholds as the character controller's floor / wall /
ceiling classification above) and the adjacent face to classify as a **wall**
(the face the player hangs against). If the surface on top of the corner is
steep enough to count as a wall — or faces down as a ceiling — the corner is
**not grabbable**, even though its interior angle keeps it a candidate. A
rotating shape can therefore carry a permanent candidate vertex in and out of
grabbability as its top face crosses the floor/wall threshold.

Detection is **vertex-first** (`lib/ledgeDetection.ts`, the single source of
truth for states and debug overlay alike): every candidate corner is tested
against the player's **swept path for the current frame** with a reach radius
of player radius plus a margin. There is no probe ray, so approach speed and
surface angle cannot cause misses; there is deliberately no multi-frame grab
memory (no coyote grabs). Additional gates:

- **Interior rejection.** The player must be outside at least one incident face
  half-plane of the corner — never grab through the body from behind.
- **Direction rule.** Corners below the player's centre are never grab
  targets — rising or falling, jumping or flying past a lip must not yank the
  player down onto it. Fast falls still catch: on the frame the corner is
  passed it ends up above centre, and that frame's swept segment reaches back
  to it.
- **Seam filter.** A candidate vertex lying on/inside another blocking body is
  a compound-body seam corner and never grabs (rigid debris is ignored so a
  ball resting on a lip cannot switch the ledge off).

The **catch** swings the body down the hang face — entry momentum plus easing,
decaying under grip friction — to the one rest pose: the player's centre
**exactly on the edge of the grab radius**. Only once the catch settles can
toward-input start a climb. The hang is a **lock to the grabbed body**: the
pose is derived from the corner's current transform and set directly each
frame, so a mover carries the player exactly and imparts no forces. A
catch blocked by geometry times out into a release rather than pinning the
player. The **climb** runs in two phases — up along the hang face until the
body clears the lip, then laterally onto the top face — with a timeout as a
dead-man switch. Hanging and climbing both offer a **ledge jump**: a buffered
jump launches up-and-away using the wall-jump vector. Running off a ledge
never grabs it — the player leaves the lip with their velocity.
