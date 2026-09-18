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

A `water` body is drawn in 3D by `render3d/water.ts` as a **digital painting** of water, tuned on 2026-09-17 against two reference pictures: a river of smooth saturated teal with soft tonal drift and thin wispy highlight hairlines running with the flow, and a fall of long soft vertical ribbons under a bright brow, sparkling, into a wide soft cloud of white.
Soft everywhere: no outlines, no hard bands, no lace.
A cel-shaded cut into flat bands with inked edges was the first reading of "painterly" and was not it; the flat-plane and half-ellipse-column falls before that were 2D images on bent planes, and every fall as a separate body had a seam at the lip (see **A fall**).
The 2D overlay's flow-streak glyphs are what the 2D renderer shows, and what the 3D renderer shows for the shapes the water renderer does not draw (anything but a rect or a circle).

The water stays **lit by the scene** - a `MeshStandardMaterial` with a little gloss and a touch of the environment, so the same lamps, fog and tone mapping fall on it as on the rock beside it - and its normal is left the plane's own, so the sheen is a soft wash rather than glints.
That is what keeps a painted surface in a photo-textured scene from reading as a sticker: the colours are stylised, the light is not.

A channel's colour is a smooth **tone field** mapped continuously through deep, body and light (`toneRamp`), a weighted sum of the things that move: the travelling vertex waves, the flipbook's churn (the along-flow component of its normal, which is which side of a ripple the pixel is on), and the strokes.
The strokes are the baked cellular web (`scripts/bake-foam.ts`) sampled with its tile stretched seven times along the flow, so every cell edge is a long thin line running with the current; thresholded high, only the strongest survive, and a second finer sample breaks each along its length into a wisp with soft ends.
Those wisps are the reference's hairline highlights, painted in the pale.
The flipbook does not perturb the lighting normal; it drives the tone field and distorts the strokes, played at half speed so its shapes swell rather than flicker.
The front sheet darkens smoothly into the deep below the waterline under a soft pale line at the seam, and a run pales softly toward its ends the way the reference river pales at its banks.
The palette derives from the authored `color` alone, so a level tunes its water through the one colour field it tunes everything else with - and it derives as four LIGHTNESSES of that one colour, taken in HSL, hue kept and saturation carried nearly whole up the ramp.
The stops are k-means clusters of a third reference picture's own water (2026-09-18, a turquoise gorge, masked to the water by hue): `#1b4657` in the deep, `#1e6c86` and `#3391aa` through the body, `#6ecad9` on the crests, `#a1dce7` going into the foam - one teal at six lightnesses, hue 186-197 throughout.
Saturation is the thing that reference settles.
It does not fall as the water lightens the way a blue pool's does (0.53 at the deepest cluster, 0.58 at the brightest), so the light stop keeps the tint's own saturation outright and only the near-white pale eases off; a ramp that desaturates upward turns a teal's crests grey.
The ramp before it mixed the tint toward black and toward white in linear RGB, and both ends of that greyed.
A whiten in linear space lifts a teal's weak red channel fastest, so the crests desaturated to paper; the deep went a third of the way to near-black.
A teal channel drew as wet concrete with white scum on it, and swapping the authored colour did not help, because the ramp greyed whatever it was given.
`body` is now the tint itself: a level authors the colour its water reads as, not a colour it is derived from.
`levels/ball.json`'s channels are `#2c8896`, which is also what water with no authored colour draws as.

### A fall

A channel with a **`spill`** pours off its downstream end - the end `flow` points at - as a fall dropping `spill` metres to the pool it lands in, leaving the lip at `spillSpeed` (the current's own speed when absent), which sets how far the arc swings out.
Both live on the water BODY beside `flow` and `drag`, because where the current goes is a fact about the current; both are lengths and both convert.
It is drawn only: the physics of a fall, if a level wants one, is a second water area turned to point down.

**A channel and its fall are one mesh under one shader**, and that is what makes the join seamless.
Every earlier fall was a separate body whose tube tried to meet the channel's end and never quite did - a step where the waves lifted the surface above a flat brow, an end cap standing exposed under a thin pour, a second translucent surface showing the first through it - so the fall became the channel's own water leaving its end, built into the same `BufferGeometry` (`appendFall`) with the same attributes.
The tube's first slice IS the channel's end rectangle: the same positions, and the same lit, alpha and texture-frame attributes by face, so the top face and the front sheet run over the lip into the tube with no step and no cap.
Three things make the seam exact rather than close.
The waves die out over `WAVE_END_TAPER` before a run's ends, so the surface meets the tube's flat first slice; a brink goes glassy anyway.
The texture frame of a tube vertex is taken from the lip point it descends from (`aFrozen`), plus the metres travelled past the lip (`aArc`), so the strokes are continuous at the lip and constant down the fall.
And every fall-only term in the shader - the ribbon weights, the brow, the white base - is zero at the lip and eases in over `FALL_BLEND_IN`, while the channel's own terms (the front sheet's murk, the pale bank) carry over it.

The pour is a **volume** whose cross-sections are **vertical slices**, not planes perpendicular to the travel: every layer of the slab leaving the lip follows the same parabola from its own height, so a slice at time t is the lip's rectangle carried along the arc unturned.
That is the physics - the perpendicular thickness then thins by exactly `v0 / v` - and it is what keeps a thick slab from bulging under the lip, which a rigid ring turning with the tangent did.
The rectangle rounds into a superellipse over `FALL_CORNER_BLEND`, the z-width contracts a little by the base, the samples are uniform in time (packed into the brow, spread down the drop), and the tube's inside is culled in the fragment shader.
The surface **draws down** into the brink over `DRAWDOWN_REACH` before the lip, by `DRAWDOWN` of the depth: water approaching a drop speeds up and its surface dips, and that dip is the taper into the fall that a level surface running to a hard edge never has.

Its shading is the channel's on the volume: the strokes stretched along the flow are the fall's long soft **ribbons** through the same tone ramp, the strongest edges its hairlines, a bump of light over the brow, and the base dissolving into white above the cloud.
The texture's along coordinate is **time from the lip at the lip's speed**, so a scrolling texture stretches exactly as the water accelerates.
The water's front face sits `FRONT_INSET` behind the slab's nominal front, because a bank authored to the same depth has its face exactly there and two coplanar faces z-fight; behind by a hair, the bank wins, which is what a channel sunk into rock means.

Spray is one point cloud (`sprayPoints`) whose every particle is a pure function of the clock and its own seed: no CPU update, and a pinned clock draws the same spray twice.
Three populations share it by `aKind`: **mist**, soft airbrushed puffs of white born low and wide around the impact and drifting up and out - the reference's cloud; **splash**, small droplets thrown up from the impact and falling back under gravity; and **sparkle**, tiny white dots riding the sheet's front face down the arc, placed on the tube by solving its superellipse for z in the vertex shader.
Point sprites are sized in pixels, so `updateWater` takes the viewport's height beside the clock to keep a droplet authored in metres the same size when the window changes.
A channel has end caps where nothing pours off it, because an open box was the first thing an orbit view showed.

`levels/ball.json`'s upper channel spills 2 m at 1 m/s onto the lower one.

### The photographic renderer this replaced

The first 3D water was photographic - flipbook normals feeding specular under the lamps, an environment reflection, a smooth murk gradient - and it was a dark glossy surface with sparkle on it, the opposite of the look wanted.
Before it there was a transmissive slab that never looked like water at all; a copy of that one is kept at `assets-src/water-removed/water.ts` with the two normal maps it used.

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
