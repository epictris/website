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
Approaching a lip the current eases to the lip's speed over `DRAWDOWN_REACH` (the study's 1.9 m acceleration zone) and the surface lowers by `DRAWDOWN` of the half depth, the bed staying put: the taper into a fall that a level surface running to a hard edge never has.

**The look** is the study's `paintedRiver`: three layers of the pool's spectrum read in parcel space, stretched along the flow and turned 90 and ~40 degrees against each other so the spectrum's diagonal never lines up, plus a fine chop churning in its own time (a current is not a mirror), and the long swell's slope.
The same slopes drive soft light bands where the ripples face the light, a little shade where they face away, a crest on the steepest and a broad highlight; restrained deep-to-shallow teal patches ride the current without an extra green tint.
Broken **turquoise strokes** travel downstream, faint in mid-channel and becoming pale at the brink. Over the drawdown reach their pattern blends into the cascade's shared parcel wash. Slab edges carry only faint interrupted teal glints: they do not establish contact with rock and no longer draw continuous white foam borders.
Down the front the glints give out within `RIM_DOWN`, and the pigment fades toward the deep with the depth under the waterline. `BANK_DOWN` still limits the cascade's edge wash.
The top is opaque and the front murky glass (`ALPHA_FRONT_*`, the pool's numbers), so a submerged ball stays a silhouette; the tube is closed and its back faces culled, so what shows through is the ball and the rock behind, never the water's own far side.
The study's river mirror (a second reflection pass in the river's plane, at 0.3) is not ported: from the game's camera a channel's top is a few pixels tall, so it would be a scene pass per frame for nothing visible.

### River refinement (2026-10-06)

The running surface keeps the approved wave geometry and shared pond palette,
but uses restrained deep-to-shallow teal pigment without the extra green tint.
Its ripple layers churn at a quarter of the cascade's rate, with reduced fine
chop and longer downstream patterns. Broken turquoise strokes ride parcel
coordinates; their interior opacity is 0.15, rising toward 0.55 at the lip.
Only the lip and the existing impact field whiten the running surface. A slab
edge does not establish contact with rock, so its former white bank outline is
replaced by faint, interrupted teal glints; actual bank-contact foam would need
a scenery/contact mask. The cascade retains its original churn and whitewater.
BALL's two `spillSpeed` values are now 145 px/s against a 120 px/s current,
giving the rendered approach a modest acceleration instead of slowing to 100.
These exit speeds affect the visible arc, not the gameplay current or drag.

### A fall

A channel with a **`spill`** pours off its downstream end - the end `flow` points at - leaving the lip at `spillSpeed` (the current's own speed when absent), which sets how far the arc swings out.
Both live on the water BODY beside `flow` and `drag`, because where the current goes is a fact about the current; both are lengths and both convert.
It is drawn only: the physics of a fall, if a level wants one, is a second water area turned to point down.

**A channel and its fall are one tube under one shader**, and that is what makes the join seamless: the fall's stations carry on from the river's with the same section, the same attributes and the same material coordinate, so nothing ends at the lip.
Every earlier fall was a separate body whose tube tried to meet the channel's end and never quite did - a step where the waves lifted the surface above a flat brow, an end cap standing exposed under a thin pour, a second translucent surface showing the first through it.

The fall's sections are **vertical slices**, not planes perpendicular to the travel: every layer of the slab leaving the lip follows the same parabola from its own height, so a slice at time t is the lip's carried along the arc unturned.
That is the physics - the sheet's perpendicular thickness then thins by exactly `v0 / v` - and it is what keeps a slab thicker than the brow's radius of curvature (v0²/g, 10 cm at BALL's 1 m/s) from folding under the lip, which the study's perpendicular sections would: its 2.2 m/s lip had the room, the game's do not.
The study's sections, thinned by continuity, were tried on BALL beside these (2026-10-06): they did not fold outright, and left the lip thinner and cleaner, but tore a white ribbon off the upper fall's downstream edge where its brow is tightest; Tris kept the vertical slices.
The stations are uniform in time (`FALL_STEPS`), packed into the brow and spread down the drop.
Down the fall the study's folding takes over the relief, the sheet thickens and thins in ridges across it (`thicknessField`), and its edges wander a little (`EDGE_MOTION`).

The cascade is the study's `cascadeLook`, blended in over the brow by the drop: the same spectrum drawn out into long ribbons as the water accelerates, labelled by **time from the lip at the lip's speed** (so a scrolling texture stretches exactly as the water does), bands taken against the sheet's own smooth normal, reflections in pale palette tones only (a fold whose normal dipped reflected near-black and read as a dark column), and the river's own wash carried over the brink, filling in, brightening toward white and cut by finer lanes down the sheet, its edges milky like the banks.
It is opaque: refracting the shelf behind drew horizontal bluish bands in the study.

**Where it lands.** The fall pours `spill` metres as authored, but the water it lands in is wherever the level put it: `updateWater` finds, every frame, where the sheet's top first meets the top of another water body under it, puts the landing at the middle of the span the sheet crosses that surface over (its bottom a slice depth before its top), and stops drawing the sheet `FALL_SINK` under it; with no water under it the landing is at the authored drop.
On BALL both falls land shorter than authored - the upper channel's 2 m spill meets the lower channel 1.4 m down, the lower's 1.5 m meets the pool 0.9 m down.

**The landing** uses four distinct layers at `STUDY_SCALE`: a lower, narrower **crown** with a compact white contact core and broken teal edges, kept on the receiving water; forty translucent short-lived **plumes** with low rounded lobes; a **mist** pass with 48 rising turquoise wisps and 40 denser base puffs; and 88 irregular **surface foam patches**. The taller mist expands and drifts slowly upward, fades at the surface and draws behind the froth. Roughly two thirds of the wisps and some low plumes follow a bowed path around each side of the sheet; the foam follows the same path before drifting downstream. Its x extent comes from the sheet's actual contact span, recalculated by `land`, and its z bends just past each edge.

The extra base mist stays just downstream of the contact or outside the sheet's sides, so the opaque waterfall does not hide its source. Its 1.4–2.6 second cycles fade in over the first 7% and hold until 70%, with a shorter 0.19–0.30 study metre lift and about 0.12–0.16 metre downstream drift per cycle. These low overlapping puffs have about 2.4 times the taller veil's per-puff opacity (0.32 versus 0.135), a soft foam-colour highlight, and a height envelope that fades out between 0.38 and 0.86 study metres. Their waterline fade reaches full strength at 0.07 metres instead of 0.16; both mist groups measure each billboard fragment's actual height in the body's frame, including camera tilt. The denser source and dilute rising veil share one draw call, keeping the four-pass landing and visible surface foam.

Foam quads lie in the receiving surface's xz plane, 0.024–0.036 study metres above it, with independently varied lengths, widths, rotation and 2.0–4.2 second lifetimes. Filled mint/white paint silhouettes have ragged edges, internal teal gaps, and layered brush highlights, replacing the former hollow bubble billboards. They drift at 0.08–0.18 study metres per second and a sparse subset has tiny integrated glints. Foam clips to the receiving water and all layers retain ordinary depth tests against rock. The angled splash ribbons and velocity-aligned flying droplets, including their tip drops and return rings, were removed following Karin's close-up feedback on 2026-10-06; the separate painterly outgoing surface ripples remain.
Foam shadows, highlights and mist are derived from the authored water palette; nearly white colour is concentrated at the contact and in small foam highlights. `land` derives a bounded visual strength from the actual impact speed (0.7..1.4 relative to BALL's lower fall), so a shorter landing is quieter than a taller one. It changes only visual emission height/spread, never the simulation. Plume, mist and foam variations change per emission cycle, with fades hiding the reset.
Every particle is a pure function of the clock and its instance, so a pinned clock draws the same landing twice; all four are always in the scene and placed in their vertex shaders, so the prewarm compiles them. The pass has no scene-depth texture for soft intersection fading: ordinary depth tests occlude particles against rocks and the mist's surface fade prevents a hard waterline.
The water it lands in draws the **impact field** (`IMPACT_GLSL`, up to `IMPACT_SLOTS` landings in a module-wide table, each read only within `IMPACT_PLANE` of its height and only on a top face): a compact boiling core, a low broken mint foam apron travelling downstream with teal gaps, sparse farther flecks, and painterly outgoing ripple strokes. Gently warped capsule waves share their phase between surface slopes and colour, retaining coherent outward motion at 0.84 study metres per second. Their wider, broken strokes taper into rounded ends, with turquoise underpaint, a mint body and a fine leading highlight; broad gaps and varying widths keep them from reading as uniform concentric outlines. The lower boil and arcs tilt the surface's own slopes - the pool's light bands and its mirror, or a channel's.

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
A splash is a cel-shaded **crown** (an open ring wall with a jagged rim of periodic sines, rising, flaring and tearing into holes as it falls), a **lace** ring of foam over the surface (Voronoi edges in log-polar space, so its cells stretch along the spokes, breaking into torn flecks at the rim, with two broken ripple rings ahead) clipped to the pool's footprint, and **droplets** thrown up ballistically, some solid, some hollow rings.

**The wake** is rings the ball sheds moving through the water, drawn by the surface shader itself rather than as marks over the water, after Tris's stylised ripple reference (2026-10-05, a drop on flat blue water).
While the ball moves along the water with its bottom no deeper than `WAKE_DEPTH` under the top, it sheds a ring every `WAKE_SPACING` metres travelled (by distance, so the spacing does not depend on the frame rate) but no sooner than `WAKE_INTERVAL` after the last, so none of the `RIPPLES` slots is taken back while its ring lives (`RIPPLE_LIFE`).
A ring is born on the ball's **waterline** (the circle where the surface cuts the ball, from how deep it sits), measured in true metres - only its spread beyond the waterline is stretched; measured from the centre in the stretched frame, a 12 cm ball's ring was born 30 cm in front of and behind it - and its `CRESTS` come out of it one after another, so the set starts small and grows, the leading crest running out `RING_REACH` over the ring's life and easing out.
Each crest is a narrow wave, tilting the same slopes that light the bands and bend the mirror, under a **white stroke broken into tapered arcs**: a smooth noise round the ring (whole frequencies, so no seam) cut at `ARC_CUT`, the cut rising over the ring's life so its arcs shorten and part, higher for each crest behind the first so the inner ones are sparser and thinner. The crests stray `RING_WOBBLE` off a true circle, each its own way, from a seed taken from when the ring was shed.
Lengths along the depth are stretched `DEPTH_STRETCH`, as the pattern is, so a ring reads round on screen.
**No two rings alike**: each has two seeds, hashed on the CPU from where and when it was shed (so a pinned clock draws the same ring), that pick its reach, crest spacing, wobble, how broken it is (`VARY_*`) and which whole frequencies its arcs and wobble are made of; seeded only by a phase, every ring was the same ring turned.
**The strokes ride the swell** rather than lying on it like a decal: pushed in and out by the pattern's height under them (`STROKE_WARP`), and thicker where the swell faces the light, thinner where it faces away (`STROKE_FACING`).

What came first, the same day: the study's own click ripple (a Gaussian packet of waves, `cos(ring * 10.5)`) - too big at birth and drawing clean even circles; torn white foam over it, which read first as a stencil (torn in the world's frame, so the rings slid under it), then, torn in each ring's frame and blurred, as jagged; a 0.3 s ease-in that showed each ring 0.6 m behind a 2 m/s ball, running back toward it; and with no ease-in at all, a flash of light every time the ball moved.

The ring table is module-wide (`rippleAt`, `rippleHow`) and shared by every still water material, so a ring carries on from the pool onto the scene's water beyond it; a pixel more than `RING_PLANE` off a ring's height ignores it.
The pale line rings that drew the wake before, a mesh of their own, are gone.

All of the splash is three draw calls, always in the scene so the prewarm compiles them: up to `SLOTS` splashes live in uniform tables, every particle is a pure function of the clock and its slot's start time, and an idle slot collapses outside the clip volume in the vertex shader.
A pinned clock (`cli shot`) draws the same splash twice.
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
