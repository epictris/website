# Light, air and surfaces

## Light and air

`LevelData.environment` is an optional per-level block: sun direction and colour, hemisphere fill, how much generated environment is let in, and background.
Nothing in it is a length, so the whole block passes through `scaleLevelData` untouched - and anything added should keep that property, since a fog density in 1/metres is an inverse length and would have to be scaled the *other* way, which is a trap worth designing out rather than commenting on. `fogAmount` is that rule being applied rather than a hypothetical: it is a fraction at a depth the renderer owns, precisely so the block stays free of lengths (see **There is fog only where a level asks for it**).
Defaults reproduce the mood the game already had: `#1f2430` is both the sky and the page's letterbox colour, so the frame is not a window cut into a different game.

**All of that is the OUTDOOR answer, and a level may decline it.**
A directional light is a light at infinity, so it reaches every surface in the frame equally.
That is exactly what a sky does and exactly wrong underground: it lights a corridor and the rock around it the same, so nothing in the picture has an inside, and a scene meant to be below ground reads as a flat-shaded diagram of one.
`sunIntensity: 0` removes it outright - no `DirectionalLight` is created, so there is no 2048² shadow map rendered every frame for a sun that contributes nothing, and no sun lobe in the generated sky.
`envIntensity` near zero takes the ambient with it, and it has to: turning the sun off alone leaves the image-based lighting still washing every surface from every direction, which is the same flatness one step dimmer.

What lights the level instead is a **light object** (`LightObjectData`, `render3d/lights.ts`): a point or spot light with a placement, a colour, an intensity and a **reach**, sitting inside a body like any other scene object.
Falloff is inverse-square with a hard cut at the reach, and that falloff is doing three jobs a flat renderer needed a hand-authored gradient for:

- **It says where the play space is.** A lamp near the gameplay plane lights the plane; parallax decoration 20 m behind it is far outside the same lamp, so the background darkens on its own and stays readable as background.
- **It frames.** Geometry in *front* of the plane is out of reach too, so a pillar or wall drawn over the level reads as a black silhouette rather than as a lit object in the way. This is the reference look's left-hand edge falling to black, and it costs nothing to author beyond a `z`.
- **It is depth.** Two walls at different depths are lit differently by the same lamp, which is the cue the deliberately narrow FOV takes out of the picture.

The consequence for authoring is that **`range` is the field that shapes the look, not `intensity`**.
Past a couple of metres a brighter lamp is barely a wider pool, and where the light *ends* is where the lit part of the level ends.

**A LIGHT IS IN A BODY, and that is the whole mechanism.**
A lamp is two things - a fitting the player can see and a light they cannot - and the difficulty has always been keeping them together.
They were once *two authored objects at the same point*, a shape carrying an emissive colour and an entry in a top-level `lights` list beside it; either alone was a specific kind of wrong (a light with no emissive is a room lit by nothing visible; an emissive with no light is a lamp that does not work) and nothing kept the pair in step, so moving the sconce left its light behind.
The patch for that was to **derive** a light from the glowing shape, out of seven more fields on the visual describing a light in a second vocabulary - its reach, its cone, its aim, its shadow, its flicker - plus a re-placement pass that measured a prop's bounding box once its GLB arrived, so the source could be pushed clear of the face it shone out of.
All of it is gone.
A light object in the same body as the fitting is a **child of the group that body is drawn in**, so it rides that body's pose for nothing at all: a lantern welded into a swinging crate swings with its light, and there is no per-frame transform in the light rig. One authored thing cannot disagree with itself, and this time that is structural rather than derived.

Emission is therefore **appearance and nothing else**: `emissive`, `emissiveIntensity` and `emissiveTexture` on a geometry object say that this thing reads as bright, and three.js has no global illumination, so they reach nothing. What lights the room is the light object beside them. That separation is what makes both halves say what they mean - a deep-orange flame that lights a whole room is a dim emissive and a wide, bright light, which the fused version could only reach by fighting one knob against the other.

Two things follow for authoring, and both are the light's own fields rather than a second spelling of them.
A **spot** is what a wall fitting wants: it has a real **distance**, so `range` is a hard edge and the light ends where the author says the room does (an area light has no cutoff at all, and a point light's is a sphere in every direction, including back through the wall the lamp is bolted to), and its shadow is **one render** where a point light's is a cube of six - which is why a lamp can occlude at all.
Its **aim** is authored in the object's own frame, so `rot` turns the beam and the lamp and its light cannot end up pointing different ways; `angle` and `penumbra` shape the cone.

`LIGHT_BUDGET` (16) caps how many lights burn at once and `LIGHT_SHADOW_BUDGET` (4) how many of those occlude, both spent in authored order - by body, then by object within the body. The count budget exists because a light stopped being a scarce top-level thing and became an object anybody can drop into a body: a corridor authored as thirty identical sconces is now an easy thing to write and an expensive thing to draw.

One thing the cone gives away, worth knowing before authoring: a spot lights **what it points at and nothing else**.
A lamp close to the wall behind it throws a small circle rather than a wash - the pool's radius is the distance to the surface times the tangent of the cone angle - so a lamp meant to light a room wants either a wide angle, some distance from what it is lighting, or an aim along the plane rather than into it.

A trap that has already been paid for once: three seeds a `SpotLight`'s position at `Object3D.DEFAULT_UP` rather than at zero, so a light left as constructed sits **a metre above** the fitting it belongs to. `LightRig` zeroes it explicitly, and `cli render3d`'s aim case is what caught it - the level renders either way, and a light in the wrong place is a level that is simply lit somewhere else.

**Shadows are the asymmetry to budget for.**
A directional light's shadow is one render of the scene into an orthographic map; a point light's is a **cube**, six.
A corridor of eight shadow-casting torches is forty-eight shadow passes a frame, which announces itself only as the frame rate quietly halving.
So `castShadow` is opt-in per light and capped at `LIGHT_SHADOW_BUDGET` (4), spent in authored order; past the cap a light still lights and simply does not occlude, which is a much smaller lie than it sounds, since most of what a torch contributes to a wall behind a crate is bounce that none of this models anyway.

`flicker` is render-only and driven by the **wall clock**, exactly like the force areas' drifting arrows, so it can never reach the fixed-step sim.
It is *handed* a clock rather than reading one, because `cli shot --3d` pins it (`Scene3D.pinClock`): a screenshot whose lighting depends on when it was taken is evidence of nothing, which is the same reason that command already waits for every asset before it draws.

**Intensity is the one number in the level format that does not convert between the file's pixels and the sim's metres**, and it is worth knowing why rather than discovering it.
A point light's brightness is candela, which is an irradiance times a distance *squared*, so a field converted with the rest would have to be converted as the **square** of the factor.
Rather than carry the one field that scales differently from every other, it is defined against the sim's metres and passes through untouched.
A round trip cannot see the difference between that and scaling it by the factor and back - the same blind spot `tileScale` has - so `cli render3d` asserts it one way, alongside the light list's px → m → px trip and the editor's.
It also asserts that emission is part of the material **cache key** (`surfaceKey`), because getting that wrong is invisible in every other check: the level renders, every round trip passes, and whichever of two shapes was built first wins, so either every wall of that stone glows or the lamp made of it does not.

Lights are authored on their own **editor layer** (see [**Layers**](editor-model.md#layers)), with `+Light`; the item's circle *is* the reach, so the radius handle authors it and the ring on screen is the volume rather than a drawing of one, and the item's colour *is* the light's colour.

The ring is drawn at the reach **on the gameplay plane**, not at the authored `range`, and that is what gives `z` any feedback at all.
A light has no geometry, so moving one through z changes nothing on the canvas and nothing in the 2D overlay; the field reads as doing nothing until the 3D view is consulted, and at small values its effect on the lighting is subtle enough to look like nothing there too.
The authored reach is a **sphere**'s radius and the level is a plane through it, so what the level actually receives is `sqrt(range² - z²)` (`lightPlaneReach`), which shrinks visibly as the lamp is pulled toward the camera and closes entirely once it is further off the plane than it reaches - a reachable authoring mistake that is otherwise silent, and one the label names outright as `MISSES PLANE`.
The authored `range` stays on screen as a fainter outer ring whenever the two differ, so shrinking one does not hide the other.
`cli render3d` asserts the arithmetic, since it is the only feedback the field has.
`levels/ball.json` is the worked example: sun off, environment near zero, small emissive discs throwing their own warm light, and a `LightData` where there is nothing to see - the cool spot, and the fill that has no fitting.

**There is fog only where a level asks for it.** That is the arrangement the removed version should have had.
As a default it muted every distant surface at exactly the point where the authored textures and the environment started giving those surfaces something worth seeing, and depth was already being said by parallax, by the sun's shadow, by the environment's own gradient and - in a level lit from inside - by the lights' own falloff, which darkens a distant layer more exactly than a fog density ever states it.
None of that is an argument against a level ASKING for air, so `fogAmount` (with `fogColor`, defaulting to the background) authors it per level and `levels/ball.json` is the worked example at 0.2.

Two things about the shape of it are the whole feature, and neither is visible in a picture - a fog measured over the wrong distance still renders a perfectly plausible hazy scene, just not the one that was authored.

**It thickens with distance from the CAMERA**, which is what air does: every surface in the frame is behind some of it and one further back is behind more. `THREE.FogExp2` is that law directly, so the density is a property of the air rather than of where the level happens to be, nothing is re-anchored per frame, and the picture cannot disagree with itself about which of two surfaces is further away.

It was briefly a **linear fog pinned to the gameplay plane**, on the argument that the plane sits ~16 m from the camera (zoom is dolly distance) so a camera-relative fog thick enough to see also tints the plane itself. That is true and it is not a defect - the plane IS 16 m of air away, and a fog starting exactly at it draws the level's foreground props (3 m in front) and the plane at the same haze as each other, which is none. Pinning also made the fog a function of the zoom, so a camera region that pulled back carried the fog with it: the air thinning as you zoom out, which is the wrong way round. The cost of the current form is the same statement pointing the right way - zooming out puts more air between camera and level, so a pulled-back region is hazier.

**The authored number is a FRACTION, not a density**, and that is the trap the environment block's own comment names being designed out rather than commented on. A density is in 1/metres - an inverse length, which would have to be scaled the *opposite* way from every other number in the file. `fogAmount` is instead how much of the fog colour a surface `FOG_REFERENCE_DISTANCE` (20 m, about where the gameplay plane sits at the ball level's zoom) from the camera takes on, so it passes through `scaleLevelData` untouched like the colours and the sun direction, and the metres live once, in the renderer. `fogDensity` is that one conversion, and `cli render3d` asserts both ends of it without a GPU - the round trip at the reference distance, and that the fog actually rises with depth and is zero at the camera.

Measured on the ball arena at 0.2: 0.73% RMSE over the frame - 10% of haze on the props in front of the plane, 14% on the plane, 18% on the scenery behind it.

**There is an environment, and it is generated.** A `MeshStandardMaterial` gets its specular response from what it can reflect, so with lights alone there is nothing in the world to reflect but one directional sun: a roughness map has almost no visible effect and a metal - which is nearly all reflection - renders as a dark, dead shape. The chains hanging in the ball arena were exactly that.

`equirectEnvironment` paints a small equirectangular sky from the level's OWN colours - the hemisphere's sky and ground either side of a soft horizon, plus a warm lobe where the sun is - and `PMREMGenerator` convolves it into the mip chain a rough surface samples. No asset, nothing to download, and it cannot disagree with the fog and the fill about what colour the air is. It is a **float** texture because the sun lobe is several times brighter than the sky, which is the range an LDR image cannot hold: clipped, the highlight it puts on a metal is the same white as the sky around it. Directional for the same reason - a uniform environment is indistinguishable from ambient light and puts a highlight nowhere.

**The texels are painted in the direction three READS them** (`equirectDirection`): three's `equirectUv` takes u from `atan(z, x)` and v from `asin(y)` with v = 0 straight down, and a `DataTexture` is not flipped, so row 0 is the bottom of the sphere.
Until 2026-09-24 the painter used a convention of its own - row 0 straight up, azimuth `atan2(x, z)` - so every generated sky was upside down and mirrored: the ground colour reflected from overhead, the sky from below, and the sun lobe exactly opposite the sun (the peak texel read back at a dot of -0.999 with the sun's direction).
It was found by the avatar's private sky (tried and removed the same day, see below), whose lobe landed on the lower right of a ball lit from the upper left.
Every level on the generated sky changed with the fix; at the time that was the river (`levels/ball.json`, once its HDRI was dropped), `BALL_LEVEL_2`, the untextured test levels, and any level for the frames before its capture arrives.
`cli render3d` holds the painter to three's formula restated independently (`sky: a generated sky is painted as three reads it`), and is red against the old convention.

Image-based lighting contributes **diffuse as well as specular**, so the hemisphere fill comes down to meet it (`FILL_WITH_ENV`) rather than the two stacking: measured over the ball arena, the frame's mean brightness moves 0.1304 to 0.1353 - under 4% - while the chains go from nearly invisible to reading as forged metal. `ENV_INTENSITY` is 0.6 rather than higher because past that the dielectrics start losing the sun's directional shading, which is the contrast the fill was tuned for in the first place.

`Scene3D` rebuilds it only when the authored environment actually changes (`envKey`). The lights and the fog are cheap to rebuild and the convolution is not, and the editor reconstructs its scene on every model revision - every drag - none of which changes the sky.

**Or a level names a CAPTURED one instead** (`EnvironmentData.hdri`, a key into `HDRI_ASSETS`), and then that is what it is lit by: a real high-dynamic-range photograph of a real sky, convolved by the same `PMREMGenerator` into the same mip chain.
What it buys is everything a sky has that a vertical gradient with a lobe in it does not - a horizon with a shape, a bright side and a shaded side, bounce off whatever the ground is made of - and what a surface reflects is the whole of that rather than a smear.
Measured on the ball arena with the sun and the fill both at zero, so the environment is the only light in the frame: the generated sky is a brown murk and `golden-gate-hills` lights the same walls as sunlit wood with the ball reading as metal, 1,409,900 pixels of a 2,073,600-pixel frame changed.
It is a per-level choice and not the default because it costs a download; a level that names none is dressed by arithmetic exactly as it always was, and a level naming a sky **this build does not have** is too - the fallback is the generated sky, byte-identical (0 pixels differ), which is the rule an unknown `texture` already follows.

Three things about it are worth knowing before authoring one.

The **sun is unchanged by it**. An environment map is light from every direction at once, so it has no shadow to cast: the hard shadow that says a level is outdoors is still the `DirectionalLight`, and the two agree about where the light comes from only if you point them the same way. `hdriRotation` turns the sky about the vertical axis and the `sun dir` fields turn the light; turning the sky alone visibly relights the scene (at 90° the arena's walls go from sunlit to backlit) while its shadows stay where they were.

A captured sky is usually **brighter than the generated one** - this one's mean linear luminance is 0.72 against the low tenths a level's own colours produce - so `env ×` is the knob that lands it, and a level that switches from generated to captured without touching it is a level that got brighter.

And the **hemisphere fill now says something the sky already says.** `FILL_WITH_ENV` drops it to 0.7 for having an environment at all, which was tuned against the generated one; a capture carries its own sky-above-ground gradient, so the fill is a second, flatter copy of it. Nothing here reduces it automatically - a hidden rule is worse than a knob - but `fill ×` is the first thing to take down if a captured level looks washed out.

**The capture may also be the visible BACKGROUND** (`hdriBackground`), and it is off by default because the two jobs want different resolutions. The reflection is convolved down to a 256-wide mip chain, so 1k is ample and anything more is thrown away before a surface ever reflects it; the background is magnified by the deliberately narrow lens (~34°, so ~100 px of a 1k equirect stretched across 1920) and is visibly soft. It is a level decision, so the flag is authorable and a sharper one is a re-optimise at `--size 2048` or 4096 rather than anything in the renderer. The generated sky is never drawn as a background at all: it is a 128x64 gradient built to be convolved, and stretched across the frame it is a wash of colour with a band in it.

Two mechanics keep it from flickering or leaking. The load is **cached and shared**, and taken SYNCHRONOUSLY when it is already decoded (`loadedHdri`), because a scene rebuilt mid-drag that starts on the generated sky and swaps a frame later is the level's whole lighting flickering once per rebuild. And a load that lands after its `Environment` was disposed is **dropped** rather than written over whatever replaced it - a level change builds a new environment into the same scene, so a slow sky arriving late would otherwise light the level after it.

It is authored in the editor's Environment panel: `sky hdr` picks from the manifest (so a sky added to the store is a sky the panel offers, with nothing in the editor to edit), `hdr °` turns it and `hdr bg` draws it behind the level. Choosing the generated sky drops all three fields rather than writing an empty one, and choosing it on a level that authors no environment block mints none - opening the panel is not authoring.

Tone mapping is ACES, which is what gives the sun range to work in; the vignette is drawn on the **overlay canvas** as one gradient fill rather than as a post-processing pass, because a vignette is a screen-space multiply over the finished frame and the overlay is already exactly that.

The GLTF loader is imported dynamically, so it lands in its own chunk and is fetched only by a page that actually loads a prop.

## The avatar's own surface

The ball and its chain are the one thing in the frame the player must never lose, and a level's atmosphere is exactly what loses them: a grey metal sphere in a murky grey-blue cave is a murky grey-blue sphere.
Rather than a light carried by the ball (rejected: nothing in the world emits it), the avatar gets a rule of its own in `render3d/avatarSurface.ts`, which is the one place that says what the avatar is made of beside the `MODEL_*` constants in `ballVisual.ts`.
It is applied to every material the avatar is drawn in: the stand-in sphere and loop, the chain's instanced links, the manacle, and the loaded ball model's own materials (inside `shine()`).
The chain's `InstancedMesh` also draws the level's authored scene chains, so those wear the same rule; they are the same forged steel.

**It is its own cache entry.**
`surfaceFor` caches materials by `surfaceKey`, and `dressWithImages` swaps the authored maps into the cached object as they arrive, so the steel `forgedMetal()` asks for is shared with any level geometry that asks for the same surface and tint.
Patching its fog would leak onto that geometry, and cloning it would freeze the clone in the fallback surface before the images land.
So `SurfaceRequest.avatar` is part of the key (`|avatar`, appended only when set, so no existing key moves): the same painted steel, dressed the same way, shared with nothing but the avatar.
It is mutated after it is built, which is safe because a page has one `Scene3D` and that scene draws one avatar; the only other entries mutated after they are built are a waking light's own instance copies (see **Waking lights**).
The loaded model's materials are shared between `loadMesh` clones, and `wearAvatar` guards itself (`userData.avatar`) the way `shine()` already did.

**The avatar is drawn through less air.**
The fog it takes on is three's own `fog_fragment` chunk with `fogFactor` multiplied by `AVATAR_FOG` (0.35) before the mix, patched in `onBeforeCompile` under a `customProgramCacheKey` that names it (`avatar-fog:0.35`) - without the key three would hand the patched material an unpatched program, or the reverse, whichever compiled first.
0 is three's `fog: false` and 1 is the world's air.
The constant exists because a binary exemption reads as a cut-out pasted over a thick fog, and its value is a played one: the ball is drawn through less air than the wall behind it, on purpose, because it is the one thing in the frame the player must never lose.
The patch throws if three's chunk stops containing the line it rewrites, since a `replace` that matches nothing would put the avatar back in the world's air with no diagnostic anywhere; `cli render3d` asserts the key and the rewritten chunk.

**The avatar is lit round the back.**
A lamp's diffuse light on the avatar keeps going past the terminator: in three's `RE_Direct_Physical` the direct diffuse term spends `(dotNL + AVATAR_WRAP) / (1 + AVATAR_WRAP)` instead of `dotNL` (`avatarLightChunk`, patched beside the fog under the same program key, `avatar-wrap:1`).
0 is three's own Lambert, 1 is half-Lambert - the far side dark only at the exact antipode, the sides at half - and the lit side is never brighter than Lambert, so a lamp that blows the near side out is a lamp to turn down, not a wrap to lower.
The specular keeps the unwrapped irradiance, so the highlight stays where the lamp puts it rather than glinting on the side no light reaches.
It is physically the bounce the renderer does not model: a mushroom sits on rock, the rock is lit hard, and it throws that light back onto the ball's far side.
And because it is bounce, the ball's own shadow does not block it: three multiplies a light by its shadow term before the material sees it, and a shadow-casting lamp's map marks the ball's own far half as occluded, which under plain Lambert coincides with the light reaching zero and is invisible, but under the wrap was a hard cut to black across the sphere (played 2026-09-24 under the river's shaft).
So `avatarLightsBeginChunk` stashes each direct light as read, before its shadow, and the wrapped irradiance is the shadowed Lambert part plus `(wrapNL - dotNL)` of the unshadowed light; shadows from everything else still land on the direct term as before.
`cli render3d` asserts all three stashes and the split.
Played 2026-09-24 after the river's mushrooms at 30 cd lit one side of the ball to white and left the other black; at the same time the model's metalness came down from 0.85 to 0.5 and its roughness up from 0.5 to 0.65 (`MODEL_*` in `ballVisual.ts`), because a near-metal's lit side is a reflection and in a cave there is nothing to reflect - old iron is rust, grime and dust over the metal, not chrome.

**The avatar reflects the level's own environment, on purpose.**
A private sky for it (the level's sky and ground lifted toward white, with a sun lobe always on, handed to the ball and chain as their own `envMap`) was built and played on 2026-09-24 and rejected: a ball reflecting a brighter sky than the room it is in looks pasted on.
Do not build it again; what lights the player in a dark level is the world itself, the lichen and the mushrooms of **Waking lights** below.

## Beams

A spot light may show its beam: `beam` (0..1) is how visible the lit air inside its cone is, and `dust` (0..1) how thick the motes drifting in it are, both absent (0) on every spot authored before them, which therefore draws exactly what it drew.
The shaft IS the spot, made visible (`render3d/beam.ts`): `LightRig.add` hangs it on the spot's own holder, turned onto the spot's own aim, `range` long and `range * tan(angle)` wide at the far end (`beamFarRadius`), softened by the spot's `penumbra`, in its colour, and guttering with its `flicker`.
There is nothing new to place and nothing that can drift off its own light, which is why it is two fields on the spot rather than a `shaft` object type (rejected: every one of the editor's light touchpoints again, and a shaft that can disagree with its lamp).

**The cone** is an open `CylinderGeometry` from `BEAM_SOURCE_RADIUS` (6 cm) at the lamp to the far radius, drawn additive, double-sided, with no depth write and `renderOrder` 12 (above the water's spray).
A view ray through a cone of lit air collects light in proportion to the chord it crosses, and for a cone seen from the side that chord is proportional to how squarely the surface faces the view - so each face's alpha is that facing term, the front and back faces summed are the chord, and the cone's own silhouette fades to nothing instead of drawing as a line.
The penumbra shapes the same term, as an exponent from 0.6 (bright to the rim) to 2.2 (gathered on the axis).
Along the cone it fades in from nothing at the lamp to full by `BEAM_FADE_IN` (a tenth of the range) and eases out from `BEAM_FADE_OUT_FROM` (0.35) to nothing at the reach, so the shaft dies in the air rather than at a rim.
The rays are two octaves of a smooth wave around the cone's azimuth (`BEAM_RAYS` 7 and `BEAM_RAYS_FINE` 17, integers so they close on themselves, `BEAM_RAY_DEPTH` 0.55, drifting at `BEAM_RAY_DRIFT` 0.05 rad/s), read per fragment so the seam where the angle wraps is never interpolated across; no grain, per the rule in [art-style](art-style.md).
`BEAM_ALPHA` (0.16) is one face's alpha at `beam = 1`.

**The fog attenuates it** rather than mixing toward the fog colour, as three's chunk would: added light seen through haze is dimmed by it, and a mix toward the fog colour would ADD fog colour wherever the beam is, drawing the cone's outline in fog.

**The dust** is one `THREE.Points` per beam, `dust * DUST_PER_METRE (60) * range` motes capped at `DUST_MAX` (1500), seeded inside the cone (`seedDust`: a random length along the axis, a radius up to the cone's there, square-rooted so the disc fills evenly).
Each mote is a pure function of the clock and its seed, like the spray: it drifts away from the lamp at 1-4.5 cm/s (`DUST_FALL`, down for a shaft aimed down), wanders sideways by up to 5 cm, is clamped back inside the cone, and wraps to the lamp at the reach, where the length fade has already put it out.
It is sized in metres by the spray's `uViewHalfHeight` rule (`DUST_SIZE` 1.4-3.4 cm), dimmer toward the cone's edge, glints slowly as it tumbles, and is drawn additive in the light's colour.
`LightRig.update(clock, viewportHeight)` writes the shared clock and viewport once a frame for every beam in the rig.

**It is not occluded by geometry.**
A shaft that should stop at a floor is authored with a `range` that stops there, and the spot's own `castShadow` gives the pool on the floor and the shadow of anything hanging in the shaft.
Screen-space god rays were rejected because they need the source on screen and a full-screen pass over the frame, and the camera never stops panning while the shaft's source is usually above the frame.

**Budget:** one draw for the cone and one for the dust, per light that asks; neither adds a light or a shadow pass, and `LIGHT_BUDGET` is unchanged (a light past the budget builds no beam either, since the beam is the light).
Neither is pickable (`raycast` is a no-op), so the editor's 3D click goes through a shaft to the wall behind it; the 2D canvas does not draw the cone, the 3D preview does, and the label says `beam` and `dust` on a spot that has them.
`cli render3d` asserts the geometry and the format, never the look: the cone's far ring against `range` and `angle` along a turned aim, every seeded mote inside its cone, both fields passing px → m unscaled and surviving an editor save (and not written for a point light), and a light asking for neither building no beam objects at all.

The river (`levels/ball.json`) is the worked example: a light-only static body 8 m above the spawn, one spot aimed straight down at 7° with `beam` 0.6 and `dust` 0.5, so the ball sits in the shaft at frame 1.

## Waking lights

A dark level is lit by the world itself rather than by anything the player carries: persistent glowing lichen, and mushrooms that come alight as the player approaches, lighting the ball and the rock around it together.
The mushroom is a **waking light**: a point light object with a `wake` distance, whose body's glowing shapes follow it (`render3d/glow.ts` for the law, `render3d/lights.ts` for the pool).
There is no new object type: the lantern pattern (a glowing geometry object and a light object in one body) is already how the format says "this thing is a source", and a mushroom is that pattern with a light that starts dark.
A separate `glow` type was rejected because it would be every editor touchpoint for lights again, and a source that could disagree with its own light.
Lichen is the same light without `wake`; the river's moss props are it (see **Glowing props**).

**It is render-side, driven by the clock the rig is handed**, exactly like flicker and the beams.
The renderer reads the ball's drawn position (`renderPosition(alpha)`) and writes nothing back, so no replay can diverge on it; putting it in the sim would only give it a path into replays and the determinism contract, for a glow that has no effect on the ball.

**The law** (`GlowState`, stepped by the ball's distance and the time since the last frame):

- `dormant` while the ball's centre is further than `wake` from the light, measured on the gameplay plane (the ball lives on the plane, so the trigger is exactly the dashed ring the editor draws, whatever the light's `z`).
- `armed` once it comes within `wake`: the `wakeDelay` runs, and a ball that leaves before it has passed wakes nothing.
- `rising` over `wakeRise` seconds, linearly, from wherever the level was.
- `lit` while the ball stays within `wake * WAKE_HYSTERESIS` (1.15), so a ball resting on the edge does not strobe it.
- `falling` over `wakeFall` seconds once the ball is beyond that. Coming back within `wake` rises again from the current level with no delay: a mushroom half dark does not wait to notice you came back.

A step is clamped to `MAX_GLOW_STEP` (0.1 s), so a tab brought back from the background does not snap every mushroom in the level to full on its first frame, and a clock that runs backwards (a headless grab pinning it) steps nothing.
A rise or fall of 0 is instant and legal.
`DEFAULT_WAKE_RISE` (0.6 s) and `DEFAULT_WAKE_FALL` (1.5 s) are what a light authoring only `wake` gets; the fall is the slower one because a light noticing you is an event and a light forgetting you is not.

**Waking lights mount no THREE light of their own: a fixed POOL serves them.**
Three compiles every lit program against the NUMBER of lights in the scene (a light at intensity 0 still counts; one removed or hidden changes the count), so a light that came and went with the player would compile fresh programs on a played frame - the stutter class `session-1697f` was, and what `Scene3D.prewarm` exists to prevent.
So `LightRig.buildPool`, called at the end of `setLevel` and therefore before `prewarm`, builds `min(GLOW_POOL, waking sources)` point lights (`GLOW_POOL` 6) in world space at intensity 0, and none is removed while the level is loaded.
A level with no waking light builds a pool of zero and is exactly the scene it was.
Each frame, after the bodies are synced (a light rides its body, so its holder's world matrix is brought up to date first), every source is stepped, and the awake ones nearest the ball take the pool lights in order: position, colour and `range` copied, `intensity = authored * level * flicker`.
Pool lights past the awake count sit at 0.
Ties keep authored order, so two mushrooms the same distance away do not swap lights between frames.
A waking light spends none of `LIGHT_BUDGET`; the pool is its cost, and it is fixed.

**Why by distance.**
A level with more awake sources than the pool leaves the furthest dark.
That is the budget spent by distance rather than by authored order, which is the right order for a light that only matters near the player; the always-on lights keep their authored-order budget.

**Why no shadow.**
A point light's shadow is six renders of the scene, and a shadow map handed between sources as they wake and swap would flash.
Pool lights cast none, `castShadow` on a waking light is ignored, and the editor greys the box out.
A light is point-only to wake at all (`wakeParams` answers null for a spot), because the pool is point lights; the editor clears `wake` when a light is turned into a spot.

**The emission follows the light.**
Materials are cached by `surfaceKey` and shared, which is why a flickering lamp's emission does not flicker.
A body carrying a waking light is the exception: every geometry object in it asks for its surface under `SurfaceRequest.instance` (the body's index in the level, appended to the key as `|instance:bN`), so it wears its own dressed copy - still dressed as the images arrive, and shared with nothing else.
The rig drives `emissiveIntensity = authored * level` on the copies of the shapes that author a glow (`emissive` or `emissiveTexture`), a uniform write with no recompile; the stalk under the cap, with no emission, is left alone.
A body with several waking lights follows the brightest.
`authored` comes from the level rather than off the material, which the rig has been writing, and the rig hands it back when the body goes.
Driving the shared material instead was rejected: every purple cube in the level would pulse with the nearest one.

**The editor's preview shows them awake** (`LightRig.previewAwake`): every source held at full without stepping, the pool spent nearest the view's centre, because there is nobody in that scene to wake anything; **▶ Test** hands them back to the ball.
See [editor](editor.md#waking-lights-glow-and-the-awake-preview) for the fields, the ring and `+ Glow`.

**Headless.** `cli shot` pins the clock at `(frame - first frame) / 60`, so a filmstrip advances it with the sim, but only DRAWN frames step a glow, each by at most `MAX_GLOW_STEP`: a filmstrip drawn `--every 6` or finer steps it at the game's rate, and a coarser one slows the rise and fall in proportion.
A single-frame grab therefore draws every waking light as it is before any time has passed - dark, whatever the ball is doing - so a mushroom's lit look is photographed with a filmstrip that runs into it (`--frames A..B --every 6`, the rise complete by `wakeDelay + wakeRise` seconds of drawn frames), or in the editor's awake preview.
`--probe` prints each drawn frame's levels as `glow: [...]` beside the program counts.
Measured on the river (`--frames 100..580 --every 6 --3d --probe all` over a run that rolls up to the first mushroom and back): nothing fresh on any drawn frame, 24 programs throughout, and the first mushroom dark to f148, rising f154-f190, lit to f406, falling f412-f490, dark from f496.

`cli render3d` holds the law (the phases against time, the cancelled delay, the hysteresis, the re-entry, the clamp), the scaling (`wake` like `range`, the times untouched), the pool's assignment and size, the instance key, and the editor's fields and `+ Glow` body; none of the spacing, reach or brightness has a case, because those are the play's to decide.
The river (`levels/ball.json`) carries four `+ Glow` bodies along the route from the spawn, unplayed.

## Fireflies

A swarm of small curious creatures that hovers where it was authored until the ball comes near, then keeps the ball company for the rest of the run: hovering a little ahead of it along the level's camera path, scattering when it comes too close, and regrouping in front of it again.
Its purpose is that the player is lit, by something the world gave them rather than a light they carry (a carried light was rejected in [the atmosphere plan](../plans/atmosphere.md): nothing in the world justifies it).
A swarm is a point light object with `fireflies` set to its firefly count (`render3d/fireflies.ts` for the flight, `render3d/fireflyVisual.ts` for the draw, `LightRig` for the light).
The light object's placement is the swarm's HOME; its `wake` is where it notices the ball (absent = `DEFAULT_FIREFLY_NOTICE`, 2.5 m, measured on the plane like a waking light's); its `color`, `intensity`, `range` and `flicker` are the swarm's light, defaulting to the firefly's own (`FIREFLY_COLOR` `#c8f060`, `FIREFLY_INTENSITY` 5 cd, `FIREFLY_RANGE` 5 m) rather than a lamp's.
Once it follows, it follows for good - unless it has a firefly path (below); a reset builds a new scene, so every swarm starts at home again.
A swarm whose body leaves the world (a breakable rock) is not taken with it: only its home marker goes, and a following swarm keeps following.

**It is render-side**, like the waking lights: the renderer reads the ball's drawn position and writes nothing back, and the flight is stepped by the clock the rig is handed, clamped to `MAX_FIREFLY_STEP` (0.1 s) and integrated in steps of at most 1/60 s so a 30 Hz frame flies the path a 60 Hz one does.
Every firefly's character is seeded from the swarm's authored order, so two builds of a level fly the same swarm and a headless grab is reproducible.

**Every firefly is an agent** with a position and a velocity of its own, steering toward where it wants to be with a capped ACCELERATION and a capped speed - Reynolds' steering behaviours (arrive/pursuit, flee, separation), the textbook for creatures that move plausibly.
A firefly cannot follow a swing, because a swing asks for accelerations no firefly has.

The first design was the opposite, and was played and rejected (2026-09-24, "too coupled with the player's movement - swinging the player around causes the fireflies to swing around accordingly", and gaining and losing velocity "rapidly in time with the player's swing").
It chained a swarm centre to the ball: a lag paid back by the ball's own velocity, every mote carried by the centre's velocity, and leashes to the ball - each of which put the swing straight into every firefly.
None of that survives; what does is the lesson that anything carrying the BALL's velocity into the flight couples it to the swing.

**Where a firefly wants to be: the hover spot**, which is deliberately blind to the swing, and read off the LEVEL, never off the camera.
The level's camera paths are read as geometry - the authored way forward (`Scene3DLevel.cameraRules`, handed to the rig once at `setLevel` by `LightRig.setRoutes`) - and how far along one the player has got is the swarm's own judgement.
A cut that took the camera controller's committed progress (its ratcheted lead origin) was played and rejected: fireflies that move with the camera "feel like they aren't part of the level".

- The swarm uses the route nearest the player, within `ROUTE_REACH` (6 m); the one in use keeps them unless another is nearer by 0.5 m, and it projects the player from a 4 m window around their last arc length, so a switchback does not jump it to the other branch.
- Along the route the spot is the swarm's own PROGRESS: it jumps forward whenever the player's projection gets further along, and drifts back toward a player behind it at only `PROGRESS_RELAX` (0.6 m/s). It is never more than 3.5 m of route ahead of the player (`PROGRESS_WINDOW`), and when the player's own place on the route JUMPS by more than 2 m in a frame (`ROUTE_JUMP`) - a fall onto another part of a route that doubles back - it starts again from them. In `session-1669f` the player fell from s = 34 to s = 9 onto the lower run of such a route; the progress stayed on the upper run, 7 m above them, drifting back for ten seconds, and the swarm abandoned them. `MAX_AHEAD`, measured straight along the way forward, cannot see a gap that is straight up. A swing forward extends it; the swing back barely moves it. Then `LEAD_ROUTE` (2 m) further along the route's way forward (its tangent there, toward increasing arc length), so a player swinging back, rocking or backtracking is still hovered ahead of toward where the level goes.
- Across the route it is the player's offset from the route through a second-order low-pass (`OFFSET_SMOOTH`, 0.5 s twice), so the swing's back-and-forth reaches it attenuated.
- It is `FOLLOW_LIFT` (0.4 m) above that and `FOLLOW_Z` (0.9 m) in front of the plane.
- It is kept between `MIN_AHEAD` (0.3 m) and `MAX_AHEAD` (3.5 m, see the measurements below) ahead of the player along the way forward, by sliding it along that axis: a progress held at a swing's forward extent otherwise parked the swarm 4.9 m from a ball at the back of its swing - the edge of the light's reach.
- It is smoothed over `SPOT_SMOOTH` (0.1 s), so a step in it (a new route taking over, the cap taking over) reaches the fireflies as a glide; short, because it lags a travelling spot by speed times itself (0.3 s ate 0.9 m of the lead on a 3 m/s roll).
- Where the player is in reach of no route (or the level authors none) it is their position through the same low-pass, lifted, with no lead.
- THE DISTANCE BUFFER: the swarm COMMITS to a hover spot and keeps it until the ideal spot above has moved more than `SPOT_DEADBAND` (1 m) from where it was when committed, until the player has drawn within 0.3 m of the spot along the way forward, or until the spot is in rock. Then it commits afresh: the ideal, further ahead by 0.3 s of the swarm's own progress (the progress, not the ball's own speed, which a swing makes large and momentary), moved into open air ahead of the player.
  A spot that slid with every move of the player sent the fireflies to a new place at each: in `session-663f`, rolling the ball about half a turn back and forth (0.6 m) moved the spot 0.7 m sideways and 0.5 m up and down, and the swarm darted between three places - played, "too eager to jump around even when the player moves only a bit".
  The buffer is measured on the ideal BEFORE the search for open air: the search picks between heights as the ideal slides past rock, and measured on its answer a flip of height alone crossed the buffer (three moves to nearly the same place in that same half turn). Replayed through the real sim with the current law, `session-663f` now moves the swarm once, when it first gets ahead of the player, and holds that spot through the half-turn roll.
  Fireflies are not carried by the ideal spot's continuous motion at all (`CARRY` 0): the committed spot does not follow it, so a carried firefly drifted off its place and hopped back.

The way forward is ROTATED toward the route's over 0.4 s, rounding the polyline's corners; a dead reversal (a switchback) turns over the top rather than never turning at all, which is what blending the vectors and renormalising did.

**A firefly path** (`fireflyPaths`, named by the swarm's `path`; see [level-format](level-format.md) and [the editor](editor.md#firefly-paths-the-fireflies-layer)) replaces the camera paths for one swarm, so where the swarm leads can be authored apart from where the camera looks - asked for on 2026-09-25.
Everything above reads it as it reads a camera path (the rig hands the swarm a `SwarmPlace` over that one path, `LightRig.placeFor`), with two differences, both in `Swarm.step`:

- It ENDS. When the player's projection onto the path comes within `PATH_END_SLACK` (0.1 m) of its far end, the swarm stops following (`Swarm.turnBack`) and its spot flies back along the path at `RETURN_SPEED` (2 m/s), at the home's depth, the fireflies in transit behind it as a knot, to the path's START - not the light's placement - where it waits from then on.
- It RE-ARMS. A swarm that has left the player notices nobody until the ball has been outside the notice ring of the start, then notices as before. Without it a path ending near its own start would find the player still there, follow them to the end they are standing at, and turn back again, every frame.

A camera path does not end, and a swarm reading the camera paths follows for good, as before.
A `path` naming no firefly path is warned about once and read as absent.
The end, the return and the re-arm are structural and have a case (`fireflies: a swarm on a firefly path leaves the player at its end...`); `RETURN_SPEED` is feel, and unplayed.

**The flight.**

- ARRIVE, as PURSUIT: each firefly wants the hover spot's own velocity plus a closing speed toward its own point (distance / 0.6 s), capped at `CRUISE_SPEED` (4 m/s), and turns its velocity toward that over 0.4 s with its steering acceleration capped at `CRUISE_ACCEL` (5 m/s²).
  The velocity carried is the UNCAPPED spot's (before `MAX_AHEAD`), which is the swarm's progress and barely swings: carrying the capped spot's put the swing back in, the light swinging 64% as far as the ball.
  Carrying the cap's pull as well, smoothed over one or two seconds, was tried for a player backtracking - whom a swarm carried by the free spot alone trails by up to 4.9 m, since its progress relaxes at 0.6 m/s - and got that to 3.3-3.8 m at the price of a livelier swing (1.2 to 1.4-1.5 m/s mean); it was taken out. A faster `PROGRESS_RELAX` trades the same way (1.2 m/s: 4.3 m and 1.4 m/s; 2.0: 3.5 m and 1.9 m/s), so it stays at the most decoupled.
  Without any carried velocity a firefly trails a moving spot by speed x the closing time, 2.5 m on a 3 m/s roll; and the cruise is faster than a rolling ball, since a firefly has to outpace the player to get in front of them at all.
- CHASE: left more than 2 m off its point, a firefly's speed cap rises toward `CHASE_SPEED` (8 m/s) at 5 m, at the same acceleration, so a player who has run away is chased down plausibly.
- THE HOVER: each firefly has its own PLACE in the swarm's cloud - a point spread uniformly over a disc 0.8 m across the spot (0.4 m at home; flattened vertically; up to 0.25 m in depth), drawn once when the swarm is built and kept. Scaling that by a radius of each firefly's own as well was the first cut, and bunched most places near the middle, where eight fireflies crowding one another kept pushing some out of their places.
- AT ITS PLACE (within 0.5 m, until it strays past it, and back once within 0.3 m) a firefly drifts in at no more than `WANDER_SPEED` (0.35 m/s), trembling.
- ANYWHERE FURTHER it does not glide: it HOPS - a run of darts aimed at its place (give or take 0.45 rad), each up to `HOP_REACH` (0.5 m) at `HOP_SPEED` (2.5 m/s) plus the spot's own speed, snapped to and stopped from at 40 m/s² (a 0.15 s settle), with a 0.05-0.25 s pause after each, shorter the faster the spot is moving. A cut that closed every gap with a smooth drift was played and read as gliding, "it doesn't look right"; the first hops, at the idle dart's 12 m/s² and with a 0.08 s settle, swelled rather than snapped, and coasted half a metre past the place and out of it again.
- It is carried by `CARRY` (60%) of the spot's own motion, and all of it once it is 1.5-3 m behind (a player who has moved on, the full chase). Carried in full always, a firefly glided along with every move of the spot; not at all, hops alone left eight fireflies up to 0.9 m behind a player rolling at 3 m/s.
  There are no WAYPOINTS: a cut that sent each firefly to a fresh random point every 1.2-4 s was played and rejected - near rock it re-picked the moment its point was swallowed, every frame as the spot slid along a wall, and the swarm jumped between points.
- It is ERRATIC at its place on purpose, because real fireflies hang in the air trembling and now and then hop off; a Lissajous wander before that read as too smooth to be alive. Two random parts, from the swarm's seeded generator, neither reading the ball:
  - JITTER: a push of up to `JITTER_ACCEL` (1.2 m/s²) in a random direction, redrawn every 0.15-0.4 s, so a firefly trembles at its place and its drift is never a clean line.
  - DARTS: every 4-10 s, a flit in a random direction that lands within its place (and in the open) - the sudden hop sideways - at `DART_SPEED` (1.5 m/s) over the firefly's own flight, reached with up to 12 m/s², and never further than `DART_DISTANCE` (0.25 m): the dart ends the moment it has covered that, and for 0.2 s after the firefly sheds the extra speed hard (steering over 0.1 s), so it does not coast on. The first cut pushed for a fixed time instead (18 m/s² for 0.12 s, 2.2 m/s gained) and let the firefly coast off it, which carried it 0.6 m or more - played, and "too far too quickly". A dart now adds about 0.24 m to where a firefly would have been anyway.
  CALM: a firefly spends most of its time hovering. The first erratic cut (a 5 m/s² jitter redrawn every 0.08-0.25 s, a dart every 1.5-5 s, waypoints held 0.4-1.8 s and closed on as fast as the cruise allowed) had fireflies under 0.3 m/s only 8% of the time, averaging 0.8 m/s with 19 darts a minute each, and was played as "constantly darting around everywhere". Now, a swarm at rest: under 0.3 m/s 51-61% of the time, 0.5-0.6 m/s mean, 25-30 darts and hops a minute each.
  The jitter rides on top of the steering's acceleration cap, and a dart and its settle raise the cap by what they need, so the limit that keeps the steering plausible never smooths the twitch away.
- FLEE, the scatter: when the ball comes within `AVOID_RADIUS` (1.0 m) of a firefly on the plane, judged 0.3 s ahead on the RELATIVE motion, the firefly accelerates away (up to `FLEE_ACCEL` 12 m/s², `FLEE_SPEED` 4.5 m/s), harder the closer, with a sideways swerve of its own so a swarm scatters rather than backing off in a block.
  Judged on the ball's motion alone, a ball rolling at 3 m/s looked 0.9 m ahead of itself - inside a swarm hovering 1 m ahead - and kept the swarm fleeing a ball it was keeping pace with.
  The scatter goes FORWARD OR SIDEWAYS, never back: the part of the flee pointing back along the way forward is dropped (sideways, its own way, when nothing is left). Fleeing straight away from the ball sent fireflies the ball came up beneath back past it - played as the swarm "rapidly moving behind the player".
  Once the ball has passed, arriving at its place again is the regroup.
- SEPARATION: fireflies closer than 0.25 m push apart, so a swarm hovers as a loose cloud.
- THE LEASH: no firefly strays further from the COMMITTED hover spot (see THE DISTANCE BUFFER; home, at home) than the swarm's own detection range (its `wake`, the notice ring), measured on the plane as the ring is. Past 70% of the range it is pulled back, harder the further, up to 20 m/s² on top of every cap; at the range itself it stops, losing the part of its velocity going further out. A firefly's place in the cloud is never more than 60% of the range out. A firefly in transit - the swarm has just noticed the ball, or has just committed to a spot further than a firefly's place from the last - is not held until it has first come within the range, and flies there (through rock if that is the way) at the chase speed. Held to the spot as it GLIDES from one committed place to the next, the fireflies were dragged along with it the moment they were re-leashed - up to 0.9 m in one frame, which in `session-1669f` looked like fireflies teleporting to the player and back.
- A firefly over its speed cap (a flee or a dart ending) BRAKES to it at 6 m/s² rather than being clamped: the clamp chopped a fleeing firefly's speed in one frame, a 71 m/s² jolt.

**Where it rests.**
Fireflies fly through scene geometry freely: stopping them at solid scenery where they could be seen was built and taken out again the same day, at Tris's word that passing through is fine.
But they never come to REST in front of it: they partly show the player the way, and a swarm hovering in rock points at somewhere the player cannot go.
"Solid" is the scenery the ball collides with (`LAYER_SCENERY`), read from the world by the rig (`LightRig.solidAt`, read-only); a vine or a hook-only body is somewhere the player can be, and does not count.

- The hover spot is kept 0.5 m clear of rock and ALWAYS AHEAD of the player: one in rock is looked for in the open at ahead distances from its own down to `MIN_AHEAD` (0.3 m) in 0.3 m steps, each at heights 0, ±0.4, ±0.8 and 1.2 m off the way forward. Boxed in with rock all round the way ahead, it hovers 0.8 m above the player. The first cut pulled it back toward the ball and on past it, and a swarm near a wall ahead went behind the player - played, and wrong, since the swarm is there to show the way.
- A firefly's place in the cloud is kept at least `MIN_AHEAD` ahead of the player too, and 0.3 m clear of rock by drawing it in toward the spot (to 60%, 30%, then the spot itself) until it is.
- A dart is aimed at open air: one that would land in rock `DART_DISTANCE` away is redrawn, and skipped if four draws all would.
- A firefly that is IN rock is in transit and never lingers: it heads for its place at no less than 2 m/s with 12 m/s² more acceleration, and neither jitters nor darts until it is out.

Measured in bun against a simulated level (a horizontal route, and a 1 m rock wall across it that the ball rolls up to and rests 0.2 m from):
settled in a 3 m pendulum swing (0.4 Hz, the ball sweeping 3.9 m at up to 3.8 m/s), fireflies with a 1 m range average 1.4 m/s and never get further than 0.99 m from the spot, and the light moves 2.2-2.4 m to the ball's 3.9 (1.6 m with the 2.5 m default range, where they average 1.1 m/s).
`MAX_AHEAD` is the knob that trades that against distance: with the leash, the spot's pull back on each swing-back is exactly what the fireflies do, so at 2.5 m the light moved 3.4 m and at 5 m or more (where it stops mattering for this swing) 1.9 m - but a swing-back can then leave the swarm that far ahead of the player, whom its light reaches only to 5 m. It is 3.5 m, between the two.
Resting at the wall, fireflies spend 0.6% of their time in the rock once settled.
Time spent BEHIND the ball along the route: none at rest, after a roll, or backtracking; up to 0.4 m behind for a quarter of the time while 8 fireflies catch up with a roll starting at 3 m/s (2 fireflies: none); some while the ball drives through the swarm faster than it can scatter, regrouping ahead within seconds; and resting against that test wall, a solid block across a straight route with no open air anywhere ahead, the swarm falls back to hovering above the player and its cloud spreads either side (56-73%). In a level, the route climbs over or goes round such an obstacle, and the open air ahead lies along it.
A firefly's target jumps by more than 0.3 m in a frame about once every few seconds at most (a place being drawn in from rock), where the waypoints jumped constantly near rock.
Backtracking against the route at 3 m/s the swarm trails up to 4.9 m ahead of the player (see above), and closes in once they stop.
None of that has a case yet: the flight is feel, and gets its cases once it has been played and settled.

**One light per swarm, from a fixed pool.**
Twelve fireflies each carrying a light would be twelve lights in every lit program; instead each swarm is lit by ONE point light hung at its fireflies' centroid pushed `LIGHT_FORWARD` toward the camera (`Swarm.lightAt`, see **Depth is the look**), from a pool of `min(FIREFLY_POOL, swarms)` (`FIREFLY_POOL` 3) built at `setLevel` beside the waking lights' pool and handed each frame to the swarms nearest the ball.
The count never changes while the level is loaded, for the reason the waking lights' pool exists (three compiles lit programs against the number of lights), and a level with no swarm builds none.
It casts no shadow, like the waking lights.
Every firefly's motion is acceleration-capped, so their centroid is as smooth as they are.

**Depth is the look.**
The first cut flew the swarm 0.6 m in front of the plane, and its light passed a hand's width from the river's rock props and tone-mapped a moss pillar beside the ball to white - the moss lights' own finding again (at the surface a point light is an inverse-square hot spot; out in the air the rock is lit evenly).
At 0.9 m the pool on the rock was even while the swarm circled the ball; once it hovered AHEAD of the ball, its spot sat right against whatever rock was in the way, and the moss pillar right of the river's spawn bleached again.
One point light stands in for a whole swarm, and a spread-out source has no inverse-square hot spot where a point does, so the light hangs `LIGHT_FORWARD` (0.8 m) in front of the fireflies, toward the camera: further from every surface at once, which is what a spread-out source looks like from a metre away.
Measured on the river's pillar (the same zoomed filmstrip, 0-255 luminance): the face's mean fell from 131 to 90 and its brightest from 199 to 147, the floor ahead stayed about as bright on average (123 to 130) with its peak down from 185 to 150, and the ball's mean fell from 41 to 29, since the light is further from it too - `intensity` is the knob if the ball wants more.
`+ Fireflies` puts the home at the same depth, so noticing the ball moves the knot across the level and not toward the camera.

**The motes** are one `THREE.Points` holding every mote of every swarm in the level, in world space, built at `setLevel` and so compiled by `prewarm`: a played frame writes two small attribute buffers and nothing else.
A mote is a point sprite sized in metres (0.2-0.3 m, the beams' dust rule) with a hot core that tone-maps toward white inside a halo in the swarm's colour, blinking on its own period (1.6-4.2 s) from 45% up to full.
The core is about 5 cm across on the larger sprites, bigger than a firefly, because at the camera's widest framing (~125 px/m) the first cut's 1.5 cm core was a single pixel.
Additive, depth-tested so a rock in front hides a mote, not depth-written, and dimmed by the fog as attenuation like the beams.

**Headless.** Like a waking light, a swarm steps only on DRAWN frames, at most 0.1 s each, so a filmstrip at `--every 6` or finer flies it at the game's rate and a single-frame grab shows it at home.
`--probe` prints each swarm as `fireflies: ["home@x,y"]`, `"follow@x,y"` or `"return@x,y"` (its light, in metres), with the ball's position and the way forward each swarm is using beside it.
Measured on the river (`--frames 6..420 --every 6 --3d --probe all` over a run that rolls right from the arrival): nothing fresh on any drawn frame, 26 programs throughout (one more than without a swarm), the swarm home until f114 and following from f120.

The river (`levels/ball.json`) carries one swarm just ahead of where the arrival hands the ball over, authored in the editor.

## Glowing props

The river's moss props (bodies 145, 160, 190, 191 and 192 of `levels/ball.json`) are bioluminescent: they glow, and they light the rock they grow on and the ball that passes them.
Each is the lantern pattern with nothing new in the format: the mesh geometry object authors `emissive` and `emissiveIntensity`, and the body carries an always-on point light of the same colour.

**The glow** (`render3d/propGlow.ts`).
A mesh prop keeps the materials its file was exported with, so an authored emission cannot go through `surfaceFor` as a primitive's does.
When the object authors `emissive` and no `texture`, `mountVisual` swaps every material of the loaded prop for a copy that emits the authored colour, masked by the luminance of the prop's own base colour map.
Three's `emissiveMap = map` was tried first and rejected: it multiplies the glow by the albedo's colour, so the moss glowed the green it is painted and read as green paint.
The mask is stretched over the map's own 5th to 95th luminance percentile (measured once per material on a 64 px thumbnail), because the moss set's albedo spans only 0.12 to 0.23 linear luminance and unstretched the pattern is a flat wash.
It is read `GLOW_MIP_BIAS` (2.5) mip levels coarse, because at the map's own detail it is single-texel white speckle and moss glows in clumps, and it never goes below `GLOW_FLOOR` (0.3), so the hollows glow faintly rather than not at all.
The copies are cached by source material and glow and never mutated, so the editor's rebuild on every revision does not leak them; the patch is one program (`prop-glow`), compiled under the loading screen like any other.
A prop wearing an authored `texture` glows through `surfaceFor` as a primitive does, and a waking light does not drive a prop's glow (only primitives are in its driven set).

**The light** hangs 0.3 m off the moss's outline centroid, away from its rock's centroid, 0.7 m in front of the plane: `#2fe6d0`, 3 cd, 3.5 m reach, no shadow.
At the moss itself (z 0.3 m) it was an inverse-square white hot spot on the rock right beside it; out in the air the rock and the moss are lit evenly.
The glow and the light are one colour on purpose, and the emission is 0.6: higher tone-maps the teal to pale mint, which reads as lit rather than glowing.
These are always-on lights and spend `LIGHT_BUDGET` in authored order: the river has 15 of its 16 after them.
`bun run assets:rock ... --moss-of N --place` writes both for a moss placed for the first time (`MOSS_*` in `scripts/rock-asset.ts`).
None of the colour, strength or placement has a case, because those are the play's to decide; `cli render3d` holds the material swap, the shader splice and the stretch.

## Painted light (removed)

From 2026-09-17 to 2026-09-24 every lit material wore `render3d/paint.ts`, a shader patch that cut the light into bands, gave roughness a floor of 0.42, sampled the reflected environment no sharper than 0.45 with its sun soft-clipped out, and took the sun's highlight away.
It was removed on 2026-09-24 because painterly is no longer the look: every material is now three's plain physically-based shading, and `?paint=0` is gone with it.
The one thing it guarded that is worth remembering is the sticker: a directional sun's highlight, or a sharp reflection of the HDRI's sun, sits where the view puts it rather than where the ball's rotation does, so on the rolling ball it can read as a fixed patch.
Judge that by playing on a real GPU, not off a headless still.

## Surfaces

Generated rocks are the one surface outside this namespace: they wear their own composed material, baked masks from the GLB over the `seaside rock` and `quarry wall` tiles, described under [**The rock material**](rocks.md#the-rock-material).

A surface comes from one of two places and a level cannot tell which, because both are keyed into **one namespace** that `surfaceFor` looks up authored-first:

- **Generated** (`TEXTURE_SETS`), keyed by the `MATERIALS` names the format already has, so naming the stuff a thing is made of is all it takes to get a sensible surface - a geometry object's `texture` takes a material name as readily as an authored set's, which is what the migration wrote onto every primitive it made. The maps are a **painted patch field** (`paintField`, since 2026-09-17) → albedo, normal map and roughness map from the same field: `cells` x `cells` irregular patches on a wrapped jittered lattice, each patch one tone with a gentle gradient across it and a little low-frequency drift crossing them, a dark seam drawn between patches in the albedo, and the normal built from each patch's own tilt so the patches are facets meeting at an angle with no rim. One field driving all three is what makes them agree - a dark patch is also a dip and also a rougher spot, as it is on the real material - for a few hundred bytes of code and no download. The normal is deliberately not the height's finite difference: the height steps at every seam, and a step differenced is a bevel under the normal map, lit on one side and dark on the other, which made the first version's wood read as chocolate tiles rather than paint. Before this the field was fractal value noise, and noise at four octaves is grain - exactly what the authored sets are baked to remove (see [**Painted surfaces**](asset-store.md)).
- **Authored** (`TEXTURE_ASSETS`), a real PBR set: **base, normal, roughness, metallic, ambient occlusion and emission**, each optional, each a `.webp` fetched from the release store and pinned by `sha256` exactly as a prop is. Channels are three.js's, which are glTF's: albedo and emission in sRGB (they are pictures) and everything else linear, roughness read from green, metallic from blue, AO from red and from the same UV set as everything else (there is only one).

That the two share a namespace is the point of the arrangement: replacing a generated surface with an authored one is **adding a manifest entry under the material's own name**, and every level already naming that material picks it up with no edit at all. An unknown name still lands on a generated surface, so a hand-edited level naming a texture this build does not have looks ordinary rather than invisible.

A **scalar map's channel is not a detail**: roughness, metallic and AO are one number per texel, three.js reads them from green, blue and red respectively, and texture libraries commonly ship the number in red alone. Handing three.js the file as it arrives therefore samples an empty channel and reads 0 - and roughness 0 is a mirror, which looks exactly like the texture not being applied rather than like a channel mistake (`factory_brick`'s roughness shipped this way and was invisible until its channel means were measured). `assets:optimize-texture` flattens every scalar map to grey, and `cli assets` measures the shipped files' channel means to say it happened; a normal map is never flattened, its channels being a vector.

**An emission map is where a surface glows**, as against how much - lit windows in a dark wall, cracks in cooling slag, a strip along a machine, none of which a flat emissive colour can say at all.
It is a picture like the albedo, so it is sRGB and encoded lossy; three.js multiplies it by the material's emissive colour, which means the default black renders the map as *nothing at all* and looks exactly like the map having failed to load.
So a surface carrying one is given a white emissive unless the geometry object names a tint. What it does NOT do is light the room: emission is appearance, and what lights is a light object in the same body (see **Light and air**).

A geometry object may also **borrow another set's** emission map with `emissiveTexture`, which is how a brick wall gets lit windows without the brick becoming a different surface: the base stays whatever it was and only the emission slot comes from elsewhere, tiled by the capture size of the set it is *in* at this shape's `tileScale`, so life size means the same thing for both pictures.
Two rules hold it together.
The emission slot has exactly **one owner** (`dressEmissive`) rather than being written by the general dressing as well - two async paths writing one slot is a race whose winner is whichever image arrived first.
And an unknown key resolves to **no map** rather than to a fallback surface's, which is the one place the texture resolution rules deliberately differ from `texture`'s: an ordinary wall is a fine answer for a missing surface, and a borrowed glow the author never asked for is not.

Authored surfaces are also **not tinted by the body's fill colour**, and that exception is why the tint exists at all: it carries the flat renderer's "colour IS appearance" onto generated noise, which has no colour of its own to defend. A photographed brick does, and multiplying it by the grey somebody typed to mean "this is a wall" makes it darker, flatter and less saturated - the opposite of what the photograph was added for.

An authored set is **drawn in its generated fallback until its images arrive** and then swapped into the same material object, so a level dressed in real textures is never a scene of white boxes on a slow connection, and a map that fails to load leaves that one slot generated rather than the surface missing. `roughness`, `metalness`, `normalScale` and `aoIntensity` on the set are multipliers over whatever the maps say - and with no map, they *are* the value, which is why a set with no metallic map defaults to metalness 0 rather than three's 1.

**Tiling is a length in the manifest and a multiple in the level.** The extruder writes its UVs in **metres** (`extrude.ts`), so one repeat covers a world distance rather than a fraction of a face: two walls of the same stuff show the same brick and only the count differs, whether they are 0.4 m or 40 m long.

Which distance is a **fact about the texture**, and lives once, in the manifest: `TextureAsset.tile` is the size the surface was captured over in metres (Poly Haven publishes it per asset - `factory_brick` is 1.5 m). A geometry object then says only how large it wants it, as a **dimensionless multiple** of that: `tileScale`, 1 (and absent) being life size, 2 twice as large. `tileMetres(name, scale)` is the one multiply, and the editor readout, the material and `cli render3d` all take their answer from it.

Authoring the multiple rather than the metres is what makes `1` mean the same thing everywhere and keeps meaning it after a texture is swapped for one captured at a different size - where an absolute value in every level would silently become wrong. It is also why `tileScale` is one of the two fields `scaleObject` must NOT touch (with `scale`): a dimensionless number scaled on the way in and back out again is the identity, so the round-trip case cannot see the mistake and `cli render3d` asserts the non-scaling directly instead.

**Where the pattern starts** is the other half, and it is a length: a geometry object's `tileOffsetX` / `tileOffsetY` shift the texture in level coordinates (+x right, +y down), in scene pixels on disk - which on this project's scale is centimetres exactly, 100 px to the metre. It is what lines a course of bricks up with the edge of the wall it is on rather than with the world origin, and it moves the pattern only: the collision geometry, which the shape's own `x`/`y` would have moved, stays put. Measured in world distance rather than in repeats, so it means the same thing at any `tileScale`.

`applyTiling` is the one place both land on a texture (`uv * repeat + offset`), and the y sign is the extruder's negation into three's frame showing through - u shifts back where v shifts forward.

**A side wall's texture has to stand up the way the cap's does**, and which of the wall's two axes is `u` is what says so.
A wall has one axis along the edge it was extruded from and one through the depth, and a texture's own `u` is horizontal - so handing `u` to the along-edge distance on a **vertical** edge maps the picture's horizontal onto world-vertical and lays every brick on its end.
That is the left and right returns of every wall, pillar and doorway in a level, which is most of what an author sees of a solid that is not face on.
`generateSideWallUV` picks by the edge's own direction instead: a horizontal-ish edge gets `u` along the edge and `v` through the depth, a vertical-ish one gets them the other way round.
Three's own `WorldUVGenerator` branches for exactly this reason and gets the other half wrong - it reads `u` straight off whichever of x and y varies more, so a 45° wall is tiled by its projected extent and its texture is squashed by `1/sqrt(2)` - which is why the distance is still measured **along** the edge here, and a repeat is a metre of surface travelled at any angle.

Both axes are anchored in the body's own frame rather than at whichever corner the quad starts from: the along-edge run stands in for world x or world y, and the depth reads zero on the **gameplay plane** (`metreUVs` takes the offset `extrudeOutline` is about to translate by).
So a course of bricks crossing from a cap onto a return does not jump, a `tileOffset` means the same thing on both, and re-authoring a wall's `depth` does not slide the texture on its returns.
`cli render3d` asserts all three - upright, continuous, and measured along a diagonal rather than across it - because none of it is visible to anything else here: the solid is the authored size, wound the right way and lit correctly whichever way its texture is turned.

**A CHAMFER IS THE CAP, UNROLLED**, and the depth mapping above is not the rim's.
Three lays a bevel out as a quarter-round, so the ring nearest the cap covers most of the arc while advancing almost nothing through z: measured by depth, that band was compressed to 37% of its own surface and the band past it to 90%, which drew the rim of every bevelled solid as two mismatched stripes smeared round the edge of it - `levels/ball.json`'s rocks are half chamfer by depth (a 0.5 m rock bevelled to the extruder's quarter-depth ceiling either side), so it is most of what is on screen for them.
So the rim is rolled flat into the cap's plane instead: a point is carried outward along its own bevel offset by the arc it has swept less the distance that sweep covered in the plane, `bevel * (phi - sin phi)`, and then wears the cap's own world x/y rule.
That is an **isometry** - the flattened point moves at exactly the rate the surface does, in every direction - so the rim neither stretches nor bands, and the correction is exactly zero at the cap ring, whose vertices ARE the cap's: the two meet with no seam at all.
What is left over lands where the chamfer meets the straight wall, which is the silhouette, and that is where it belongs - the camera looks along the depth axis, so the rim is seen nearly face on and foreshortens to nothing at its outer edge, where a break is a break in the pixels the solid was about to end in anyway. Anchoring the other way round, continuing the wall's depth mapping inward, puts the same break in the middle of the rim in full view.
The one residue is the **corner**: the outward direction there is the bisector, which is longer than the edge normal by `1/cos` of the turn, so the unroll over-travels by that much at the outer end of a corner's rim - nothing on the near-collinear vertices a rock outline is made of, 1.41x at a right angle. An exact corner would want the elliptic arc length along the bisector, which has no closed form.
`cli render3d` asserts both halves (`extrude: a chamfer …`), and both are red against the depth mapping.

The resolved size and offset are part of the material cache key, because `repeat` and `offset` live on the *texture* rather than the material: two tilings are two `Texture.clone`s sharing one uploaded image.

**A conveyor belt is the one surface whose tiling is adjusted and whose pattern moves** ([conveyors](conveyors.md#rendering)).
Its band is its own ring of geometry with `u` in metres of ARC LENGTH along the running surface, and the repeat `tileMetres` gives is stretched or squeezed to the nearest length that goes round the loop a whole number of times (`beltTextureTile`), so the loop closes on the pattern with no seam; the material is the ordinary cached one, untouched.
The motion is written into the ring's own UV buffer, never into a map's `offset`: the material and its maps are shared by everything wearing that surface, and an authored set's maps are swapped into the shared material when they arrive, so an offset set on one belt would move every wall of the same stuff, or be lost when the images landed.

`cli render3d` asserts the resolution rule directly (`surfaces: …`) - authored beats generated, a material name still resolves to its own surface, an unknown name falls back, and each side's tile is its own - because it is pure arithmetic over the two manifests, and because getting the precedence backwards is invisible: every level goes on wearing perfectly presentable noise while the downloaded maps sit unused.
