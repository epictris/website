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

## Surfaces

A surface comes from one of two places and a level cannot tell which, because both are keyed into **one namespace** that `surfaceFor` looks up authored-first:

- **Generated** (`TEXTURE_SETS`), keyed by the `MATERIALS` names the format already has, so naming the stuff a thing is made of is all it takes to get a sensible surface - a geometry object's `texture` takes a material name as readily as an authored set's, which is what the migration wrote onto every primitive it made. The maps are value noise → albedo, a height-derived normal map and a roughness map from the same field: one height field driving all three is what makes them agree - a dark patch of grain is also a dip and also a rougher spot, as it is on the real material - for a few hundred bytes of code and no download.
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

`cli render3d` asserts the resolution rule directly (`surfaces: …`) - authored beats generated, a material name still resolves to its own surface, an unknown name falls back, and each side's tile is its own - because it is pure arithmetic over the two manifests, and because getting the precedence backwards is invisible: every level goes on wearing perfectly presentable noise while the downloaded maps sit unused.
