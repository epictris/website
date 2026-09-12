# Water

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

## Water takes traction with it

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

## Drawing a body of water

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
