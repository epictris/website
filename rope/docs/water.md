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

Water is drawn in 3D after two of Tris's WebGL studies of 2026-10-05 that share one world: a **pool** (`flow: 0`, no `spill`) is "A quiet cave pool" (`render3d/stillWater.ts`, see **Still water**), and a **current**, with its fall when it has a `spill`, is "Flowing water v14" (`cave-river-waterfall-v14.html`, ported in `render3d/water.ts`).
The river study's river and cascade were rewritten in the pool's own formulation, so the three read as the same water, and what they share lives in `render3d/waterLook.ts`: the clock (`waterTime`), the studies' palette, scale and depth stretch, the wave spectrum both read their ripples from (`waterSurfaceMap`, generated at load), and the impact field a fall draws on the water it lands in.
The 2D overlay's flow-streak glyphs are what the 2D renderer shows, and what the 3D renderer shows for the shapes the water renderer does not draw (anything but a rect or a circle).

**The palette** is the studies' three colours carried onto the authored one (`studyPalette`): the body's `color` stands for the studies' shallow `#178b96`, and the deep (`#13506b`) and the light (`#55bec7`) are moved from it in HSL by whatever separates them from the shallow in the study.
Water with no authored colour is the study's own.
`levels/ball.json`'s water is `#1e7382`, darker and less saturated than the study's shallow.

**The scale.** Both studies are drawn in study metres at `STUDY_SCALE` (0.5 game metres to the study's one) and stretched `DEPTH_STRETCH` (2.5) along the depth (world z), because the game sees its water far more edge-on than the studies' cameras did; the reasons and the measurements are under **Still water**.

**Unlit, not tone mapped, not fogged**, as the pool is: the colours are the studies' display colours, and BALL's haze greyed the teal into a blue-grey sheet.
Both write depth, so the depth of field blurs them like the rock around them.

### A current

A channel is the river study's **closed swept volume**: one tube carrying one material coordinate from the source over the lip into the water the fall lands in (`currentGeometry`).
A station every `RIVER_STEP` (2.5 cm) down the run carries the cross-section, a rounded rectangle walked from the middle of the bed round the back, over the top, down the front and back, so its seam lies under the water; both ends are capped with their own vertices, so a cap shades flat.
The study's section had whole semicircles for sides, which its banks hid; the game looks at a channel's front and keeps the painted channel's slab, a flat front under a flat top with its corners all but square (`SECTION_CORNER`, 5 mm).
Corners rounded 6 cm, as first ported, lost an A/B to it (Tris, 2026-10-06).
The water's front sits `FRONT_INSET` behind the slab's nominal front, because a bank authored to the same depth has its face exactly there and two coplanar faces z-fight; behind by a hair, the bank wins.

Every vertex carries the study's coordinates (`aFlow`): metres travelled (study), the position across the top (study metres, stretched along the depth as the pool's pattern is), the **travel time** from the source, and how far down the fall it is (a fraction of the `spill`).
The pattern is read at the parcel's **Lagrangian** position - across, and the run's speed times its travel time less the clock - so it rides the current at exactly the speed the ball drifts at.
The study ran its pattern at 1.92 times its 1.3 m/s river, which is 1.25 m/s at the game's scale: BALL's 1.2 m/s flow, so the game's channels move on screen as the study's river did.
`aUnroll` continues the across coordinate round the section's perimeter (unstretched past the top), so a pattern painted by it runs down the front face rather than smearing into vertical bars, which one coordinate shared by two faces does.

**The relief** on the river is the painted channel's wave train, not the study's (`PAINTED_HARMONICS`, `riverWaves`): four harmonics of 5 cm riding the current, each churning at its own rate and wandering across the depth, crests sharpened by a 0.75 power, dying out over `PAINTED_END_TAPER` before either end of a run and waving only within `PAINTED_FRONT_FALLOFF` of the top down the front.
The study's relief was ported first - travelling gravity waves of 8.5 study cm, a finer band-limited relief calmer at the banks and the brink, a pressure hump before the lip - and lost an A/B to the old waves (Tris, 2026-10-06): its crests were tighter and sharper along the waterline, and it swelled the top of the front.
Its two longest waves still tilt the light bands (`swellSlope`), as shading only.
The waves are displaced along N (perpendicular to the travel) and the normal is tilted by both slopes, taken by central differences; the finest wave is 0.36 m, so the stations' 2.5 cm resolve it with room to spare (see the Nyquist note below).
Approaching a lip the surface falls into it along the brink's gravity arc, the bed staying put (see **The brink** under **A fall**).


**The look** is the study's `paintedRiver`: three layers of the pool's spectrum read in parcel space, stretched along the flow and turned 90 and ~40 degrees against each other so the spectrum's diagonal never lines up, plus a fine chop churning in its own time (a current is not a mirror), and the long swell's slope.
The same slopes drive soft light bands where the ripples face the light, a little shade where they face away, a crest on the steepest and a broad highlight; the colour drifts down the channel between the deep, the shallow and the light, a little greener here and there.
A **pale wash** stands in for foam: translucent milky streaks drawn along the current, faint in mid-channel and opaque toward the brink.
It is read `WASH_ACROSS` (2.5) times finer across than the study's and cut `WASH_CUT_RAISE` (0.05) higher, so it is narrow lines, half as many as the study's (measured on the field: 14.6 to 7.3 across 12 study metres), and every cut is to the pixel (half a `fwidth` each side), never feathered (Tris, 2026-10-06).
The study also drew it opaque along the banks (a torn band) with a thin rim at the waterline; on the game's channels that read as extra foam down the water's sides, and both were dropped, on the river and on the falling sheet's edges (Tris, 2026-10-06).
The pigment fades toward the deep with the depth under the waterline.
The top is opaque and the front murky glass (`ALPHA_FRONT_*`, the pool's numbers), so a submerged ball stays a silhouette; the tube is closed and its back faces culled, so what shows through is the ball and the rock behind, never the water's own far side.
The study's river mirror (a second reflection pass in the river's plane, at 0.3) is not ported: from the game's camera a channel's top is a few pixels tall, so it would be a scene pass per frame for nothing visible.

### A fall

A channel with a **`spill`** pours off its downstream end - the end `flow` points at.
It lives on the water BODY beside `flow` and `drag`, because where the current goes is a fact about the current; it is a length and converts.

**The brink** (`brinkOf`) is the textbook free overfall, and how fast the water leaves the lip follows from the current rather than being authored.
A current U deep H carries q = U·H per metre of width; pouring off an edge it runs down through critical depth y_c = (q²/g)^⅓ to the brink depth at the edge, `BRINK_DEPTH` (0.715, Rouse) of y_c for a current slower than its wave speed (Froude U/√(gH) under 1), and H·Fr²/(Fr² + 0.4) for a faster one (Rajaratnam), the two meeting at Fr = 1; continuity speeds it up to q/y_b.
BALL's lower channel (1.2 m/s, 0.5 m) leaves at 2.53 m/s and 24 cm deep, the upper (1.2 m/s, 0.6 m) at 2.68 m/s and 27 cm.
The surface follows gravity the whole way down: from where it starts to drop it is one ballistic arc at the lip's horizontal speed, through the lip and on down the fall, so it reaches the edge already falling (2.3 m/s on the lower channel) and never levels out there and then turns.
The arc drops H - y_b by the lip, which fixes where upstream it starts (0.58 m before the lower lip), and its curvature is g/v²: faster water, a gentler brow (0.65 m radius at the apex on BALL, 1.06 m at twice the current, 2.2 m at 3.5 times), as Tris asked (2026-10-06: "faster flowing water should result in a more gradual curve").
Before it, the lip speed was authored (`spillSpeed`): every level carried the editor's 100 px/s, slower than the 120 px/s currents feeding it, so the water braked into the brink on a smoothstep drawdown that levelled out at the edge, then turned down a 10 cm radius - "it goes from flowing straight ahead to quickly flowing down" (Tris) - and a faster current changed nothing.
`spillSpeed` is retired: `normalizeLevelData` drops it on load (`withoutSpillSpeed`), so the levels on disk lose it on their next save and the editor no longer offers it.
It is drawn only: the physics of a fall, if a level wants one, is a second water area turned to point down.

**A channel and its fall are one tube under one shader**, and that is what makes the join seamless: the fall's stations carry on from the river's with the same section, the same attributes and the same material coordinate, so nothing ends at the lip.
Every earlier fall was a separate body whose tube tried to meet the channel's end and never quite did - a step where the waves lifted the surface above a flat brow, an end cap standing exposed under a thin pour, a second translucent surface showing the first through it.

The fall's sections are **vertical slices**, not planes perpendicular to the travel: every layer of the slab leaving the lip follows the same parabola from its own height, so a slice at time t is the lip's carried along the arc unturned.
That is the physics - continuity thins the sheet's perpendicular thickness by exactly `v0 / v`, which a constant vertical depth is - and it kept the slab from folding under the lip while the brow was 10 cm tight, which the study's perpendicular sections would.
The study's sections, thinned by continuity, were tried on BALL beside these (2026-10-06): they did not fold outright, and left the lip thinner and cleaner, but tore a white ribbon off the upper fall's downstream edge where its brow is tightest; Tris kept the vertical slices.
The stations are uniform in time (`FALL_STEPS`), packed into the brow and spread down the drop.
Down the fall the study's folding takes over the relief, the sheet thickens and thins in ridges across it (`thicknessField`), and its edges wander a little (`EDGE_MOTION`).

**The sheet bows out in the middle.** The banks drag on the water beside them, so each column of a slice leaves the lip at its own speed, with the lip's velocity times `1 - EDGE_LAG (z/b)²` (b the half width), so it leaves on the river's own slope: the middle carries furthest and the edges fall closer to the lip.
The study's ridges are kept at `RIDGE_SHARE` of their contrast; nothing else shapes the edges, since a channel's surface is level across it and its depth at the banks is its depth in the middle.
The study's ridges and folding faded toward the edges for a while (`FOLD_EDGE`), to keep its fixed-across-the-width ridges from puffing BALL's edges out, and were removed with the edge thinning as shaping that is not physics (Tris, 2026-10-06).
An edge thinning (`EDGE_THIN`) was tried and removed the same day: the game sees a fall from the side, which is its edge, and on top of continuity's own thinning (the sheet halves as the water doubles its speed; BALL's lower fall, 18 cm across at the lip to 10 cm at the pool) it drew a 4 cm ribbon (Tris, 2026-10-06: "it looks weird how the stream narrows to a thin band"; "don't add false edge thinning if it isn't physically accurate").
What is left of the narrowing is the real thing (a tap's stream narrows the same way); what is not modelled is the air a real fall takes in, which bulks it back up and roughens it lower down.
The study's ridges sit at fixed places across the width, made for its 4.6 study metre sheet; on BALL's 3 m lower channel they peaked at both edges, and since the vertical slices carry the channel's whole depth over the brow, they puffed both edges ~30 cm out past the middle (Tris, 2026-10-06: "the edges of the waterfall extend further than the middle").

The cascade is the study's `cascadeLook`, blended in over the brow by the drop: the same spectrum drawn out into long ribbons as the water accelerates, labelled by **time from the lip at the lip's speed** (so a scrolling texture stretches exactly as the water does), bands taken against the sheet's own smooth normal, reflections in pale palette tones only (a fold whose normal dipped reflected near-black and read as a dark column), and the river's own wash carried over the brink, filling in, brightening toward white and cut by finer lanes down the sheet.
It is opaque: refracting the shelf behind drew horizontal bluish bands in the study.
**The ripples are the river's own, carried over the brink** and drawn out by the physics (`drawnOut`): a parcel keeps its label (`parcelAt`) as it speeds into the brink and down the fall, so a metre of river surface becomes v/U metres (v here, U the run's speed), and a ripple carried on it keeps its slope across the flow but loses that share of its slope along it.
So the light bands the river's crossing crests draw stay on the river (v = U there) and fade over the brink, while the slanting crests are pulled into streaks down the sheet, as a real falling sheet is striated along its flow.
The cascade once read a pattern of its own, labelled at the lip's speed and drawn out by a factor of the study's (1.6 to 3.5): its crests across the sheet, squeezed further by the grazing angle the game sees its brows at, drew long horizontal shimmers spanning the curtain (Tris, 2026-10-06).
Found by knocking terms out on a close view of the lower fall (ripple slopes zeroed: clean; the sheet's own normal flattened: still banded); turning that pattern to run down the sheet and drawing it out four times further also cleared it, and was replaced the same day by the physics at Tris's word ("make them physically accurate so that they appear on the river instead of the curtain").

**Where it lands.** The fall pours `spill` metres as authored, but the water it lands in is wherever the level put it: `updateWater` finds, every frame, where the sheet's top first meets the top of another water body under it, puts the landing at the middle of the span the sheet crosses that surface over (its bottom a slice depth before its top), and stops drawing the sheet `FALL_SINK` under it; with no water under it the landing is at the authored drop.
On BALL both falls land shorter than authored - the upper channel's 2 m spill meets the lower channel 1.4 m down, the lower's 1.5 m meets the pool 0.9 m down.

**The landing** is **foam lying flat on the water** it lands in, whole at the plunge and breaking into rings that drift out and thin, and short-lived **plumes**, the low splash at the curtain's foot, broad lobes in the middle and small ones outside.
It follows Tris's reference (2026-10-06, a stylised plunge from realtimevfx.com: one flat pale tone, solid at the plunge, broken concentric arcs drifting out, a lighter glow in the water, a small jagged fringe at the foot).
There is **no standing mound of foam**: clean water's bubbles burst as they surface, so its foam does not pile up (stacked froth is what soap does).
A frothing crown stood on the water until then, a heightfield of noise folds and then of round bubble caps; the second read as a bubble bath, and hard cel shadows on it read as wrong on sight (Tris, 2026-10-06).
It is **scaled by the fall's own physics** (Tris, 2026-10-06: the churn should fit the height and the water; the study is no longer the reference).
The sheet strikes at v_i = sqrt(v_lip^2 + 2 g drop) carrying q m^2/s per metre of width.
The boil (the foam and the plumes) is the bubbles the sheet drives down coming back up, so its size is the one length the sheet's momentum per width and gravity make, l = sqrt(q v_i / g): the foam reaches l (`BOIL_REACH` in waterLook.ts), its shapes drawn in units of l / `BOIL_REACH` on a clock run by the square root of that unit, so it moves under the same gravity at any size.
The boil follows **the line the sheet actually strikes along**: its edges leave the lip slower (`EDGE_LAG`), so they strike nearer the lip than its middle (11 cm on BALL's lower fall, solved per column from the arc as the middle of where its slice's bottom and top go in, `impactBend`), and the foam and the plumes bow with it; its straight part spans the sheet's whole width, so the boil wraps round the curtain's sides (it stopped at 0.82 of the half width, the study's sheet's, and BALL's 3 m sheet fell into clear water at its edges; Tris, 2026-10-06).
The plumes start wholly under the water, so they come out of it by their own motion, and fly one ballistic flight under real gravity until they are wholly back under, the water hiding them as they go in (they used to shrink away mid-air); they are drawn in the foam's flat tone and only over the water they come out of.
How much is out follows the air a plunging sheet entrains, q (v_i - v_e) times the width (v_e = `ENTRAIN_ONSET`, ~1 m/s, below which it takes in none), at `PLUMES_PER` per unit.
BALL, measured: the lower fall drops 0.81 m at 4.56 m/s with q 0.24 over 3 m (l 0.33 m, 72 plumes); the upper 1.07 m at 5.89 m/s with q 0.72 over 1.5 m (l 0.66 m, 148 plumes).
Before, every landing was the study's at `STUDY_SCALE` in the study's timing, the same size at every fall and falling at half of real gravity; loose spray drops were thrown too and read as a sprinkler, and splash ribbons arced out of it; both are gone (Tris, 2026-10-06), so nothing is thrown.
**Every piece is opaque and cut to the pixel**, and comes and goes by growing and shrinking: soft alpha masks and fading translucent plumes read as a blurry mist over the stylised scene (Tris, 2026-10-06).
The churn is wider than the sheet on purpose (Tris: "the churn should extend past the edges of the waterfall - that's realistic"), and centred on the impact, so the sheet plunges into its middle; keeping it within the sheet's width, or pressing its upstream half against the sheet's inner face, were tried and dropped the same day.
Every plume is a pure function of the clock and its instance, so a pinned clock draws the same landing twice; the plumes are always in the scene and placed in their vertex shader, so the prewarm compiles them.
The water it lands in draws the **impact field** (`IMPACT_GLSL`, up to `IMPACT_SLOTS` landings in a module-wide table, each read only within `IMPACT_PLANE` of its height and only on a top face).
Its **foam** is an amount, the bubbles surfacing as the outflow carries them off: whole along the line the sheet strikes and dying away as exp(-distance / l) (`impactFoamAmount`).
A pattern of patches carried outward at `FOAM_OUTFLOW`, drawn out along the rings (`impactAlong` unrolls the strike line round its ends) and banded every `FOAM_RING_SPACING` as the plunge sheds them, is covered wherever it is under the amount (`impactCover`), so the foam is solid at the plunge and breaks into thinning arcs further out.
It is one flat tone, the water's light tone toward white by `FOAM_WHITEN` (the reference's pale cyan, `foamColor`), cut to the pixel by how much the cover changes across the pixel in each direction (`impactPixel` hands over the world's x and z per screen pixel; edge-on, the water is far wider per pixel in depth than across, and a single isotropic span smeared the edges).
The water round it is **not milky**: a pale blur out to twice the foam's reach stood there (it also kept the mirror from lighting a white halo round the landing, which no grab has shown since) until Tris had it removed with the wake's (2026-10-06).
The surface **heaves** a few centimetres where the foam is thick, tilting the surface's own slopes - the pool's light bands and its mirror, or a channel's.
**No ripples run out from the landing** (Tris, 2026-10-06: they did not fit the look).
Tried the same day: rings shed from the boil about once per wave period at the deep-water phase speed, sqrt(g L / 2 pi) on the boil's clock, as bumps in the surface's slope like the ball's old wake; first as white broken-arc strokes ("not a ripple texture"), then slope only with a little crest light, then made irregular (jittered shedding, a wavelength per ring so they dispersed, patchy crests, chop round the boil); then removed.
Displacing the surface itself was considered and set aside: the pool's top is one quad per metre and would need a fine grid, and the scene's own water continuing a pool could not follow it.
Everything it lays on the water fades to nothing before the field's 4.1 boil unit reach (`impactFade`); without it the milky water that stood there then ended in a visible ellipse.
The arcs' two ends meet behind the sheet, against the wall it falls from, where the pattern has a seam.

`levels/ball.json`'s upper channel spills onto the lower one, and the lower into the pool.

### Still water

A water body with `flow: 0` and no `spill` is a **pool**, and `render3d/stillWater.ts` draws it after Tris's cave-pool study rather than as a current (2026-10-05).
Its geometry is a slab (`poolGeometry`: the top face, the front sheet and two end caps, never displaced, so only as fine as its light gradient needs) and its colours the shared palette (`studyPalette`).

The study is `cave-pool-water-v2.html` ("A quiet cave pool", a self-contained WebGL page) with Tris's exported settings, and the port is shader for shader.
The surface is **continuous rippling normals**, never a cellular pattern: three layers of a band-limited wave spectrum (a 256 px tiling texture of twelve plane waves, generated at load by `waterSurfaceMap` in `waterLook.ts`, R/G the slopes and B the height) drifting against each other, plus three long sine waves as slopes.
The same slopes drive everything on the water: broad soft turquoise **light bands** where the ripples face the light, a little shade where they face away, a brighter crest on the steepest, a broad highlight from a fixed cave-opening direction, and the **mirror**, pushed about by them so a reflected rock edge bends and breaks as the ripples pass.
The colour runs from deep blue at the back of the slab to shallow teal at its front.
The mirror is strong for what stands within `REFLECT_NEAR` metres of the water and faint past `REFLECT_FAR` (the study reflected its rocks and left its far cave wall out), which is what keeps the water teal rather than a dark mirror of the cave; the distance is the mirrored point recovered from the reflection's depth.
A Fresnel term strengthens it toward grazing.

The palette is the shared one (see **Drawing a body of water**); authoring `#178b96` gives the study's own colours.

What had to change from the study, each measured on BALL:
- **Scale.** The study's lake is 75 m seen from 35 m, and BALL's pool is 6.4 m across at ~0.18 of the study's framing, but at 0.18 the ripples were hairlines: the game sees its pool far more edge-on (12 m of depth is ~200 px of a 1080 px frame). `STUDY_SCALE` is 0.5, and the pattern is stretched `DEPTH_STRETCH` (2.5) times along the depth so its ripples read as the study's broad bands rather than streaks.
- **No mesh displacement.** The study displaced its mesh by the long waves; at this scale that is 4 mm, which no pixel shows and the slab's 1.2 m rows could not carry (see the Nyquist note below). They tilt the normals only.
- **Not fogged.** BALL's air (54% at 20 m) halved the teal's saturation into a grey-blue sheet (front of the pool 29,81,102 fogged against the study's 47,147,159): the study's camera stood in thin air, the game's ~3x as far off. The mirror is the fogged scene, so the level's air is still in what the water reflects; only the water's own colour stands clear of it.
- **Unlit, not tone mapped.** The study's colours are display colours and the mirror is the frame as the player sees it, so neither goes through ACES again.
- **The front sheet** is a cross-section the study never had: between the shallow and the deep colour at the waterline, darkening toward the bed, under a pale waterline. As bright as the surface, unlit and unfogged, it read as a block of teal glass.

**The backdrop's water is the pool's too.** A pool is only as wide as its body's rect, which is also where the ball feels water, so the basin beyond its ends is the Blender scene's own flat plane (`backdrop pool`, laid by `tools/blender/backdrop.py` 2 cm under the water across the whole backdrop, from 6 m behind the gameplay plane to behind the far wall).
`Scene3D.adoptSceneryWater` gives that plane the pool's material (`stillWaterMaterial` with `plane`: no slab attributes, opaque) in the pool's colour, slab ramp and mirror switch, matched to the pool whose surface it lies within `SCENERY_WATER_REACH` of.
The ripples and the deep-to-shallow ramp are both in world x and z, so where the two meet nothing changes but which mesh draws.
The plane is lifted to the pool's own height and not drawn under the pool's top face (`footprint`, set every frame, reaching 1 cm in under it so no crack opens), and the pool's top is opaque: left 2-5 cm under, with the slab at 0.97 alpha over it, the join showed close up as a step with a shade change across it, the mirror being sampled from two different heights (Tris's first report).
Behind the plane's front edge the slab's end caps are not drawn (`openBehind`), since their pale waterline poked above the plane as a dashed seam.

The pool **writes depth**, though its front sheet is translucent. The depth of field draws anything see-through that writes no depth sharp over its blur, whole; a pool reaching the far wall then stayed crisp against the blurred rocks it meets, and disagreed with the plane, which blurs. With depth the blur reads the water's own: sharp at the gameplay plane, soft toward the far wall.
The plane is left out of the mirror with the pool and counts toward whether the pool is in view.
To reach the far wall BALL's pool is authored `waterZ -1500`, `waterDepth 4200` (front edge 6 m in front of the plane, back 36 m behind); in front of the 6 m line beside the pool there is no scene water, only the rock banks.

The study's **shoreline glints** (a field baked from the rocks' waterline outlines) are not ported: here they would need the waterline of every scene mesh standing in the pool, sliced out of the Blender scene at load.

**The mirror** (`render3d/planarReflection.ts`, `Scene3D.mirrorPool`) is the scene drawn again from the camera's reflection in the pool's surface, into a small target of square texels, with the near plane skewed onto the waterline (Lengyel's oblique clip, as three's `Reflector`) so nothing under the water stands up out of the mirror, and the same skewed frustum culls whatever is wholly under it.
It is drawn as the canvas is (flagged as three's XR target, RGBA8, as `FrameTarget` is), so every program is one the frame already compiled.
One pass a frame, for the pool in view nearest the camera and only while the camera is above its water; any other pool goes without its mirror that frame rather than read one taken in another plane.
It leaves out every pool, the editor's guides, the shafts and the depth of field, and reuses last frame's shadow maps.
It runs before the ball's probe, so the pool the ball reflects carries its mirror.
`?mirror=0` turns it off in the game, `setPoolMirror` on `window.__scene3d`, and `cli shot --gl angle --query "scale=2&bench=256&benchmirror=1"` measures it paired off and on (`benchpools=1` pairs the water itself hidden and drawn; `benchdof=low|medium|high` holds a depth-of-field setting for either).
The paired readings are only worth anything with the GPU otherwise idle: close the game's tab first.
**Cropped to the water** (`Scene3D.screenWindow`): a water pixel reads the mirror at its own screen position plus the ripples' push, so the mirror camera's projection is narrowed to the water's screen rectangle (padded `MIRROR_WINDOW_PAD`), which culls whatever reflects outside it and spends the whole target on the water.
The picture is about `TEXELS` (480x270) square texels over that rectangle, none smaller than `MIN_TEXEL` (2) drawing-buffer pixels, drawn into the corner of a target that only grows (`uReflectionArea` tells the pool which part of it is the picture).
Square because the rectangle is wide and short: a target of the canvas's shape spent 480 texels across a full-width window, a texel per 4 screen pixels at 1080p and 8 at 4K.
The mirror camera's picture is the screen's turned left for right (its up is reflected, so its right points the other way), so the crop turns the window's x too; until 2026-10-05 it did not, and an off-centre window drew the mirror image of its own strip of the screen (hidden on BALL, whose window is nearly always the full width).
**Held still in the world.** Even square texels are a couple of screen pixels, and a grid fixed to the screen aliases what slides across it: as the camera panned slowly, reflections slid along with the grid and snapped back to their rocks a texel at a time (Tris, 2026-10-05; invisible in fast pans).
So `PlanarReflection.snap` grows the window out to whole texels of a grid laid through `MIRROR_ANCHOR`, a fixed point on the play plane, as a shadow map is snapped to its texels: whatever stands at that depth is drawn into the same texels every frame, only shifted by whole ones, and the pool's filtered read carries it smoothly.
What stands far off the play plane still slides by its parallax against the grid; the texel's size is kept until the window's area asks for one more than `TEXEL_HYSTERESIS` octaves off it.
Measured with twelve `cli shot --view` grabs stepping the camera 5 mm (~1.5 px) at 1080p, a near rock against its reflection by cross-correlation: the reflection's lag swung 2.47 px peak to peak before (sd 0.87), 0.43 after (sd 0.14), against 0.54 (sd 0.18) for a full-resolution mirror. Square texels alone took it to ~1.5 px; four-sample MSAA in the target added nothing measurable and was left out.
On BALL's gameplay view the water is the band from -0.73 to -0.07 of the screen's height: the pass went from 49 draws, 334k triangles and 1920x1080 at 4K to 44 draws, 264k triangles and (after the line cap) 480x270.
**Its cost is pixels, not draws.** Measured live in Tris's own Chrome on 2026-10-05 (4K fullscreen, RTX 4070 SUPER, settings interleaved in 1.5 s blocks via `window.__scene3d`): leaving the ivy, the moss or the ball out of the mirror saved under 0.05 ms each; 540 lines -> 270 saved 0.17 ms of the mirror's ~0.33 and took the frames over 7.5 ms from 17% to 7%; 135 saved only 0.04 more and the picture at 270 is indistinguishable at 1080p.
The shipped result: no water 5.42 ms GPU (4.0% of frames over 7.5 ms), water without its mirror 5.47 ms (5.0%), water and mirror 5.57 ms (6.6%). The rest of the frame is the budget pressure at 4K/144, not the water.
Measured 2026-10-05 at 4K, RTX 4070 SUPER, before the crop and with the pool reaching the far wall: mirror 0.41 ms (depth of field off) and 0.47 ms (high), the water's own drawing 0.13 and 0.09 ms (`benchpools=1`); with the old 12 m pool the mirror was 0.32 ms. Headless benches after that were spoiled by a game running on the same GPU (the live measurement above replaced them). `--probe all` found no program compiled after the prewarm.
The headless `--gl angle` grab picks the integrated AMD GPU on Tris's machine unless `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json` is set.

Before this, the same day, the pool was a **calm-lake painting** (a colour ramp over the view's grazing angle under flat lighter and darker wavelet dashes in 40%/30% of stretched Voronoi cells; rimming every cell drew "cracked ice") whose reflections and contact lines were left undone; before that a **caustic net** after Tris's reference Blender files (a 3D Voronoi read as F1 minus Blender's smooth F1, white glowing lines over a soft tint).
The net's star glints were built and **rejected on sight** ("they look bad").

**The splash** (`WaterSplashes`, owned by `Scene3D`) is render-side by construction, like the sparks: it reads where the ball is drawn and how fast it moves, and writes nothing back.
When the ball's bottom crosses a pool's surface going in faster than `SPLASH_MIN` it throws a splash scaled by the entry speed; coming out fast, a smaller one.
The entry speed is the larger of the sim's velocity and the velocity **as drawn** between the two frames: the BALL pool's floor is 5 cm under its surface, so the ball stops inside the frame it goes in and the sim's velocity on the frame the crossing is seen is zero.
A splash is **foam on the water**, drawn by the surface shader as a fall's landing is and with the wake's patches, so the splash and the trail the ball leaves after it are one foam (Tris, 2026-10-06: "take inspiration from the waterfall splash").
It is solid where the ball went in and opens into a torn ring drifting out.
The **core** is solid out to the ball's radius, spreads by `SPLASH_CORE_SPREAD` of it and clears by `SPLASH_CORE_LIFE` of the splash's life, so the ring separates from it.
The **ring** rides the crown's sheet: the water the ball shoves aside leaves its waterline at `CROWN_SPEED` of the entry speed U, `CROWN_TILT` off vertical, and comes down a ballistic range out, so the ring eases out to `CROWN_FROM` R + 0.45² sin(0.8) U² / g over the sheet's flight, 2 · 0.45 cos(0.4) U / g (0.63 m in 0.5 s at 6 m/s), widening as it goes.
The sheet itself is not drawn.
The splash starts when the ball crossed, a fraction into the frame, not when the frame is drawn.
Up to `SPLASH_SLOTS` splashes live in a module-wide table (`splashFoamAt`, `splashFoamHow`) beside the wake's, read by every still water material within `WAKE_PLANE` of the splash's height.
Before 2026-10-06 a splash was the stylised reference's: a cel-shaded **crown** (an open ring wall with a jagged rim, flaring and tearing into holes), a Voronoi **lace** of foam over the surface and hollow-ring **droplets**; it read as a white ice crystal and was replaced.
The same day, lumps of foam thrown up ballistically from the waterline in the fall plumes' outline and tone were tried and removed (Tris: "get rid of those clumps!"): a few broad slow ones read as nothing, and enough to read as a crown read as confetti.

**The wake** is foam the ball leaves churning through the surface, drawn by the surface shader in a fall's flat foam tone (`foamTone`) cut to the pixel (Tris, 2026-10-06: the ripple rings went, and the white ring strokes were replaced by foam).
The water under it is **not milky**: a pale halo spread out under the wake and the splash until Tris had it removed (2026-10-06).
While the ball moves along the water with its bottom no deeper than `WAKE_DEPTH` under the top, **the foam is left where the ball was, as it leaves** (Tris, 2026-10-06: "when the ball leaves an area, a wake persists in the place it left", and the ball leaving must not make foam appear where it was not).
The trail follows the ball's path as capsules along x, and the newest is drawn out every frame to wherever the ball is now, so the water the ball uncovers already carries its foam and nothing pops in behind it.
Each point of a capsule is as old as the moment the ball was there (its age runs from the capsule's start time to its end time).
A capsule is closed, and the next starts from its end, once it is `WAKE_SPACING` long and `WAKE_INTERVAL` old, so none of the `WAKE_SLOTS` slots is taken back while its foam lives; a ball further than `WAKE_JUMP` from where its trail ends, on another surface, or under a clock run back starts a new trail.

What is drawn is **a real wake's shape** (Tris, 2026-10-06, after the swept disc read as "odd": "more realistic"):
- **How much white water** follows the ball's Froude number U / sqrt(g R): a body slower than the surface waves it makes (Fr about 1, 1.1 m/s for the 12 cm ball) breaks none, so the white water's share runs 0 to 1 over `WAKE_FROUDE` (1 to 2).
  Below it the ball leaves only a thin strip lasting `WAKE_LINE_LIFE`; a breaking wake lasts `WAKE_LIFE`, less as the ball goes deeper.
- **The strip** down the middle of the path, the churned water behind the ball: from `WAKE_STRIP[0]` of the waterline radius wide (each side) at share 0 to `[1]` at share 1.
- **The arms**, the Kelvin wake's diverging crests breaking: lines that leave the ball's sides and are carried outward at tan(19.47 deg) of its speed since the ball was there, so the two trail back in the wake's V; `WAKE_ARM_WIDTH` of the waterline radius wide (each side), as strong as the share.
- **It decays as foam does**: bubbles burst, so a round hole opens in every cell of a jittered grid (`WAKE_LACE_CELL` across, drawn out `WAKE_LACE_STRETCH` along the path) as the amount falls, up to `WAKE_LACE_HOLE`, until only curved strands are left and then those go; solid while the amount is 1 or more (`WAKE_PEAK` lifts it there).
  Thresholding the cells' edges (F2 - F1) was tried first and drew straight hairline cracks, like shattered ice.
From the game's near edge-on camera the wake is subtle: a few streaks along the waterline, which is what a V wake looks like from near water level.

Tried the same day and dropped: one round puff at the ball's middle scaled by its strength (it drew narrower than the ball and then grew); puffs born whole at the ball's leading and trailing ends; a pair off its near and far sides, growing out of the waterline (a gap down the middle); the back half it had swept, shed every 14 cm (at a slow roll a chunk appeared behind the ball each time); the swept waterline disc itself, solid and spreading at the Kelvin speed (a pale slab, "odd", even after it was made to spread more and go sooner).
The capsule tables are module-wide (`wakeSpotAt`, `wakeSpotTime`, `wakeSpotShape`) and shared by every still water material, so the trail carries on from the pool onto the scene's water beyond it; a pixel more than `WAKE_PLANE` off a capsule's height ignores it.

Until 2026-10-06 the wake was rings after Tris's stylised ripple reference (2026-10-05, a drop on flat blue water): crests coming out of the ball's waterline one after another, each a narrow wave in the slopes under a white stroke broken into tapered arcs, riding the swell, every ring its own.
Before those, the same day: the study's own click ripple (a Gaussian packet of waves) - too big at birth and drawing clean even circles; torn white foam over it, which read first as a stencil (torn in the world's frame, so the rings slid under it), then, torn in each ring's frame and blurred, as jagged; a 0.3 s ease-in that showed each ring 0.6 m behind a 2 m/s ball, running back toward it; and with no ease-in at all, a flash of light every time the ball moved.
The pale line rings that drew the wake first, a mesh of their own, are gone too.

The splash and the wake cost no draw calls of their own: the pool's surface draws both.
Their foam is a pure function of the clock and each slot's start time, so a pinned clock (`cli shot`) draws the same splash twice, and a filmstrip (`cli shot --frames`, which advances the clock with the sim) shows it moving - start the strip before the ball crosses, or the detector never sees the crossing.
Unplayed; no cases until it has been.

### The painted channel the river study replaced

From 2026-09-17 to 2026-10-05 a current was a **soft digital painting**, lit by the scene (a `MeshStandardMaterial`), tuned against Tris's reference pictures: a tone field mapped through a four-stop HSL ramp of the authored colour (`paletteOf`), driven by travelling vertex waves, a crossfaded 60-layer flipbook of real water normals (Cebbi's "Animated Water Normal Map") and hairline strokes from a baked cellular foam mask (`scripts/bake-foam.ts`) stretched along the flow; the fall was the same strokes as ribbons under a bright brow, with mist, splash and sparkle points.
Both maps left the store with it.
Rejected along the way: hard colour bands with inked edges (the first reading of "painterly"), a flat sheet and a half-ellipse column for the fall, every fall as a separate body (the seam at the lip), and a ramp that mixed toward black and white in linear RGB (a teal drew as wet concrete with white scum: a linear whiten lifts a teal's weak red channel fastest).
What it established and the port keeps: a channel and its fall as one mesh under one shader, the fall's vertical slices, the drawdown into the brink, `FRONT_INSET`, and the front sheet as murky glass for the ball's sake.

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
