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

## Convex-only polygons; compound bodies

Every polygon primitive is **convex**. Concave polygons are never allowed as a
single shape. This keeps collision, wrap-point, and ledge math to the convex
case only — no concave decomposition at solve time, no reflex vertices *within*
a primitive.

To build a concave form (an L-shape, a star, a hull with a notch), compose a
body out of **multiple convex polygons** (a compound body). The pieces share a
transform and move as one; each piece is convex and is collided/wrapped
independently.

Consequence for vertices: a reflex ("inward") corner only ever exists at a
**seam between two convex pieces**, never inside a single primitive. Seam
vertices are not ledge candidates (see below) — they are an artefact of the
decomposition, not a real grabbable edge of the body.

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
