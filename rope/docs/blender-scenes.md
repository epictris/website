# Blender scenes

A level is **dressed in Blender**: one `.blend` holds the level's whole look, and one recipe puts it in the game.
The loop is: edit the scene in Blender, `just scene <level>`, refresh the browser.
This page is what a scene is, how it binds to the level, how the files move, and what Blender cannot carry.
The plans are [plans/blender-scenes.md](../plans/blender-scenes.md) (2026-09-27, the pipeline) and [plans/blender-owns-appearance.md](../plans/blender-owns-appearance.md) (2026-09-29, the ownership below).

**Blender owns every rendered mesh; the editor owns collision.**
Since 2026-09-29 a level carries no look of its own.
The geometry objects it used to draw with are gone from the format, and `withoutLook` (`level/levelFormat.ts`) drops them from any file that still has them.
Collision is authored in the editor exactly as before, and nothing about the sim can change from a Blender edit.
Deriving outlines from the meshes was considered and rejected: a geometry tweak would have been a physics change.

There is no foreground and no backdrop, only meshes.
A ledge the ball rolls past and a wall 40 m back in the fog are objects in the same file, and the file has no layers a level has to know about.

## What the game still draws

Blender cannot own a surface the sim moves every frame, so the game draws these itself, from the level (`render3d/bodyVisuals.ts`):

- **Water** (`render3d/water.ts`): the current runs across its surface.
  Its slab is the water body's own `waterZ` and `waterDepth`, and its tint is the body's `color`.
- **A conveyor's band** (`render3d/beltTread.ts`): the texture, or on a flat colour the cleats, run round the loop at the belt's `speed`.
  Its look is the belt shape's own `BeltLook` (`width`, `texture`, `color`, `tileScale`, see [conveyors](conveyors.md)).
- **Lights, fireflies, vines, chains, the ball**, and any body the sim spawns (a sandbox rock, the hook).
- **Debug geometry**: a collision piece whose Debug switch is on (`CollisionObjectData.debug`) is drawn as its outline extruded in a flat colour - by default the body's `color`, through the piece's `thickness`.
  It is per piece and opt-in, in a level with a scene as in one without, and **G** hides all of it while playing (see [render3d](render3d.md#what-the-scene-draws)).

A level that names **no scene** has no look at all, so it is seen by the pieces whose debug geometry is on: that is what the test levels are played in and what a new level is blocked out in (a piece drawn in a level with no scene starts switched on).
A level saved before the switch existed (level format 1) drew every piece of every non-area body as a grey box; it loads with exactly those pieces switched on.

A piece whose debug geometry is off draws **nothing**, and neither does a body the scene does not dress.
An invisible wall stays invisible, and `just scene` lists the body names with no object behind them, which is where a misspelt name shows.

## Binding

- A body has a stable **`name`** (`LevelBodyData.name`, the body panel's `name` field).
- The level names its scene once: **`scene`** (`LevelData.scene`, the Level panel's `scene` field) is `assets-src/scenes/<scene>.blend`.
- An object in the exported scene whose name is a body's name is **that body's dressing**: mounted under the body's visual root and carried by it, so a rigid crate, a mover or a pivot takes its dressing along, and moving a body in the editor moves its mesh.
- Every other object is **scenery**, standing in the world where Blender put it.

Names are matched as three.js spells a glTF node's name (`nodeNameOf` in `render3d/scenes.ts`, which is `PropertyBinding.sanitizeNodeName`): whitespace becomes `_`, and `.`, `:`, `/` and square brackets are dropped.
So Blender's `Ledge.001` is the node `Ledge001`, and a body called either is dressed by it.
`cli levels` holds a level's names unique under that rule, since two bodies of one name would dress the first and leave the second bare with nothing on screen to say why.

**Blender places the mesh; the body carries it from there.**
The exporter keeps every object's world transform, and `dressScene` (`render3d/sceneDressing.ts`) mounts a bound node at Blender's pose minus the body's rest pose - the engine origin and rotation for a body that collides, the authored ones for one that does not (`BuiltBody.origin`).
At rest the node is drawn exactly where Blender put it; nothing is written back into the level.
Only the outermost match is taken: an object named like a body inside another such object rides its parent, as it did in Blender.
A bound node answers a pick with the body's first authored object, so clicking the dressing in the editor's 3D view selects the body; scenery answers nothing.

**Shadows.**
A node bound to a body that collides always casts: a cage set back 20 cm so the ball reads in front of it is still the thing the ball is standing in, and without its shadow it reads as a sticker.
A node bound to a body that collides with nothing, and every piece of scenery, keeps the decoration rule: wholly behind the gameplay plane (its front past `SHADOW_Z`) it is a painted distance and casts nothing, and on or in front of it it casts like anything else.

**Glow.**
A body carrying a **waking light** (a light with `wake`, see [lighting-and-surfaces](lighting-and-surfaces.md)) drives the glow of its dressing, as it drove the glow of the shapes it used to carry.
When the node lands, `BodyVisual.adoptDressing` gives the body its own copy of every emissive material in it, so nothing else in the level pulses with it, and hands them to the light rig; the authored emission is the one the scene was exported with.

## The loop

```sh
just scene-guide ball     # once, and again whenever the collision changes
# open rope/assets-src/scenes/river.blend, model on the guide, save
just scene ball           # export, optimise, report
# refresh the browser
just publish              # before committing a level that shows the scene
```

`just scene-guide <level>` (`scripts/scene-guide.ts`, `tools/blender/scene_guide.py`) writes the level's collision into **`<scene>-guide.blend`**: one flat curve per collision piece on the gameplay plane, a closed POLY spline on exactly the editor's points (and a second for a belt's hole), with the object's origin on the body's origin (`guide.<name>`, or `guide.body-<index>` for an unnamed one, then `.1`, `.2`, ... when the body has several pieces), an empty on every body's origin, the gameplay plane's extent as a wire rectangle, and a sphere of the avatar's radius at the spawn.
Solids are filled, areas are the outline alone.
The guide has no depth: it says where the collision is on the plane, and the dressing decides how deep it is.
These collision outlines are a visual reference and nothing else: they, their origins, the plane and the spawn are unselectable (`hide_select`; the cameras are not), nothing in the scene refers to one, and a rock is never built from one.
The formations add-on's **Create Guide from Outline** copies one into a guide of the scene's own, which keeps nothing of where it came from, so the next run can add, move or drop any piece without a guide or rock changing ([blender-formations](blender-formations.md#formations)).
Until 2026-10-02 the guide was meshes, each body's outlines extruded through its thickness; Blender filled their faces along a normal that was never computed, so concave outlines came out as fans of triangles outside the collision.
The guide also carries the **game camera**, `guide.camera`: the level's lens, keyed on every frame at 60 fps through the real camera controller along the level's camera paths (or along a recorded run, `--ride <bundle>`), so looking through it in Blender is looking through the game ([blender-formations](blender-formations.md#the-game-camera)).
Beside it are what the game draws over that view, for the Formations panel's toggles: `guide.camera.dof` (the same camera with the game's depth of field), the game's light at rest (`guide.lights` and `guide.world`, which the scene does not use until the panel's Lighting links them in), and the level's fog on the camera.
It **creates `<scene>.blend`** when there is none, with the `Guide` collection linked from the guide file, so reopening the scene after a level edit shows the current colliders and the dressing is always modelled against the outline the ball actually rolls on.
The guide file is overwritten on every run and never exports.

`just scene <level>` (`scripts/scene-export.ts`, `tools/blender/scene_export.py`) runs headless Blender over the scene: every object with geometry goes out with its world transform and modifiers applied, except one **linked** from another file (the guide), one in a collection named `guide*` or **excluded from the view layer**, and one **hidden in render**, itself or through a collection it is in (the camera icon - render visibility is what ships, viewport visibility is the artist's).
Lights, cameras, empties and armatures never go out.
Before anything is selected, every grown ivy and moss object is grown again from its paint (see [blender-ivy](blender-ivy.md) and [blender-moss](blender-moss.md)), so what ships always matches the rock it grows on as the file now stands.
One whose host is gone is a warning and stays out, with everything parented to it: render visibility is not inherited, and until 2026-10-04 the river shipped the shadow decals of five deleted boulders' ivy as ghostly shading at the level's origin.
A formation whose outline was edited and not rebuilt, or whose growth predates its rock, is a warning ([blender-formations](blender-formations.md)).
The result goes through the pinned prop pipeline with node names kept (`assets:optimize --keep-nodes`, which also turns instancing off, since an instanced node loses its name) and the parenting kept (`--keep-hierarchy`: the optimiser's flatten step would hoist a child to the root at its world pose, which keeps the pose and loses the ride on its parent's body - it was on until 2026-09-28, so the rule above held only for unparented objects) into

```
public/scenes/<scene>/scene.glb    what the game draws
public/scenes/<scene>/meta.json    what was exported, and how it binds
```

and the recipe prints the binding: which objects landed on bodies, which are scenery, which body names have no object behind them, what Blender skipped and why, and every exporter warning.
While it runs, the recipe keeps a live list of its steps at the bottom of the terminal (`scripts/stepProgress.ts`): start Blender, grow ivy and moss, bake textures (with how many objects the cache spared), write glTF, optimise, encode textures (maps done of all), each ticked with its time, the running one counting, the rest still to come.
`scene_export.py` names the step it starts with a `[scene_step]` line; `scene-export.ts` owns the list and its labels.
Off a terminal each step's start is one line and the finished list is printed at the end.
Skipped objects that share a reason are counted on one line (an excluded collection tree such as the formations' Sources by its top collection); an object hidden in render is always named.
The dev server serves `/scenes/` itself, uncached (`src/server/scenes.ts`), because vite's public handler knows only the files its watcher saw at startup and the directory is off the watcher; a refresh shows the new export.
The Level panel shows the export's summary and the body panel offers the exported object names in the `name` field and says whether the name is dressed.

## The bake cache

Preparing and baking is most of an export, and an edit usually touches one or two objects, so every baked object's prepared mesh (modifiers applied, creases rebuilt and still straight, the bake unwrap) and final maps (its `baked colour` and `baked normal` images, as the glTF gets them) are kept in `rope/.cache/scene-bake/<scene>/` (gitignored), and an object whose key has not changed loads them instead (`tools/blender/bake_cache.py`, since 2026-10-04; the mesh since 2026-10-07).
A cached object is neither prepared nor baked: no crease rebuild (100 s for Terrace.011 alone, 170 s for the river's Terraces), no unwrap, no detail high poly.
Its mesh is kept straight with its bows, and bent with the fresh ones after the bakes, so an object still to bake meets its neighbours as a cold export would.
The key is taken on the scene before anything is prepared, since the preparation is a function of what the key holds: the bake code and Blender's version; the scene's Cycles settings a bake reads and its bake settings; the object's evaluated mesh (every attribute), its world transform, detail seed and render settings (depth, strips, creases, chips, map size); every node tree of its materials as the export repaints them, slot by slot, groups and images (by their pixels) included; and every triangle of the rest of the scene within reach of its Ambient Occlusion nodes, with the seed and render settings of a baked neighbour, since the slate's 0.5 m occlusion darkens where a neighbour comes close.
Every input is taken by content, never by name or by its place in the file.
Until 2026-10-07 the key held the names of the export's per-object material copies, which Blender numbers after every material in the file (`Painted slate.058`), so a rebuild anywhere that added a slate material re-baked every rock in the scene; and a neighbour counted whole, so a vertex moved on one backdrop rock re-baked the five others whose boxes it touched.
Now a neighbour's edit re-bakes an object only when the edited triangles are within its occlusion reach.
The bake code is the part of `scene_export.py` the bake reaches from `bake_procedural_textures`, plus the formations modules it imports and those import, each as its syntax tree with its reports left out (a `log`, `step` or `print` whose arguments call only side-effect-free builtins; `log(f"... {curve.rebuild_mesh(...)}")` stays in): a comment, a docstring, a reflow, a log line or an edit to the export's other steps re-bakes nothing; any other edit to the bake's code re-bakes everything.
What decides a pixel is in the key: a missed input ships a stale map without a word, an extra one costs a bake.
Hair curves, point clouds and volumes have no triangles to read, so one counts whole (its data and transform) for every rock its box comes within reach of.
Entries the latest export did not use are removed, so the cache holds one export per scene; the log line says how many objects came from it.
The optimiser's encode has a cache of its own, `rope/.cache/scene-encode/<scene>/` (`scripts/encode-textures.mjs`, `--texture-cache` on `optimize-asset.ts`): each map's AVIF or WebP keyed on the source image's bytes, its colour space, the rule's encoding and the encoder's versions (gltf-transform, sharp and its libraries).
Encoding was most of a warm export once the bake was cached (93 s of the river's 110, 2026-10-07: 57 maps up to 4k), and an unchanged map's PNG comes out of the bake cache byte for byte, so only the maps of re-baked objects are encoded again.
A cached encode goes into the file at the point of the pass that would have made it, and the shipped glb is byte for byte the uncached one's.
`just scene <level> --no-cache` bakes and encodes everything afresh and leaves both caches alone.
After every export `scene-export.ts` checks that the optimiser encoded every baked map as one (`baked colour` and `baked normal`, both AVIF): it finds them by image name, and a name the glTF exporter cut short at a dot (`Terrace.003 baked colour` went out as `Terrace`) shipped the four dotted Terraces as lossy WebP at 1k until 2026-10-04.

## Frames and units

Blender metres are game metres.
Blender is z-up and the exporter writes y-up (Blender `x, y, z` becomes glTF `x, z, -y`), and the game draws in glTF's frame (x right, y up, z toward the camera).
So in Blender the **gameplay plane is `y = 0`**, toward the camera is **negative y**, and a backdrop behind the level sits at **positive y**.
The guide stands in this frame, so none of it has to be remembered while modelling.

## Publishing

The scene is a stored binary like every other (see [asset-store](asset-store.md)): `public/scenes/` is gitignored, and `bun run assets:publish-scenes` (in `just publish`) uploads `scene-<scene>.glb` to the release and pins its sha256 and size in `src/render3d/sceneAssets.json`, which is committed with the level.
A scene is **replaced in place** on publish: it is exported again and again while the level is dressed, and a name per export would leave every draft in the release for ever.
The pin is what says which export a commit meant; `assets:fetch` verifies it, so an older commit whose scene was replaced fails its fetch loudly rather than drawing a different level - the store's stated trade.
`assets:fetch` also refuses a registered level naming a scene the manifest lacks, since that level would ship with no look at all.
`cli assets` fails on a scene a registered level names that the manifest lacks, on a manifest entry no level names, and on a scene name the store cannot take (`SCENE_NAME`: lower-case letters, digits, dashes).
A build keeps only the `scene.glb` of scenes registered levels name (`scenesInBuild` in `vite.config.ts`).

The `.blend` files are raws under `assets-src/`, gitignored like every raw, and they are the only copy of how a scene's dressing was made.
So they are stored too, as **sources**: `bun run assets:publish-sources` (in `just publish`) uploads the `.blend` of every scene a registered level names, and every source already pinned, as `source-<path>` in the same release, replaced in place like a scene, and pins its sha256 and size in `scripts/sceneSources.json` (keyed by the path under `assets-src/`).
Another file becomes a source by naming it once: `bun run assets:publish-sources scenes/textures/soft-moss-v2.png`.
`just sources` (`bun run assets:fetch-sources`) brings them back, and never overwrites a local file that differs from its pin, since that is unpublished work; the build does not fetch them, since a deploy draws exports.

## What Blender cannot carry

- **Procedural materials.** glTF carries a Principled BSDF with image textures and little else.
  What it does carry: a Color Attribute on Base Color, alone or multiplied (factor 1) with an Image Texture, goes out as `COLOR_0` (the shape Blender's glTF importer builds); an Image Texture multiplied by a constant colour in a Mix node (Multiply, factor 1) goes out as the texture times `baseColorFactor`; an alpha run through Less Than and Subtract (`1 - (alpha < cutoff)`) goes out as `alphaMode: MASK` at that cutoff; and a Roughness or Metallic taken from one channel of an Image Texture by a Separate Color, alone or times a constant (a Math Multiply), goes out as glTF's packed metallic-roughness texture (`carries_channel` - the graph Blender's own glTF importer builds).
  A **Base Color** or **Normal** wired to anything else (noise, ramps, mixes, a Bump) is **baked** (`bake_procedural_textures`): on its own copy of the mesh, modifiers applied, the export unwraps the object afresh (Smart UV Project into a UV map `SceneBake`, islands 2 px apart), runs Cycles' diffuse colour pass into an image of the object's own and a tangent-space normal bake into a second, copies the object's materials and wires the images in, so they ship as `baseColorTexture` and `normalTexture`.
  The unwrap runs on a welded copy, the UVs carried back corner by corner: the river's boulders came in through glTF split at every face, and unwrapped as they are they made one speck of an island per face, 21 % of the image covered instead of 54 %.
  Baked maps are 512 texels a metre up to 4096 since 2026-10-03 (were 256 up to 2048; `TEXELS_PER_METRE`, `BAKE_SIZE_MAX`, and `BAKED_MAX` in scripts/encode-textures.mjs).
  The baked normal map is half the colour map's side and lossy AVIF since 2026-10-04 (`NORMAL_SCALE`, scripts/encode-textures.mjs): lossless at the colour's size the five Terraces' normals were 16 of the river's 20.7 MB against the store's 8 MB a file. Tris compared all four on Terrace.003 in the game frame (full or half, lossless or lossy: "barely any difference"); the encoding moved the render by at most 3 levels of 255, the halving by up to 44 along chip edges at twice the game's zoom, and the map went from 4,242 KB to 503 KB. The unwrap keeps its islands `PACK_GAP_PX` apart at the normal map's size, and the detail high poly still bakes at the colour's.
  A face with no area (the planar dissolve leaves collinear slivers) gets one UV for all its corners: after the weld its corners could land on different islands, a streak across the atlas, which drew nothing while the face was flat but became a pale stair-stepped band once the curved creases bent it open after the bake (2026-10-03; `DEGENERATE_AREA`).
  Every texel no island covers is filled (pull-push from the baked texels), since a mip level that averages in background draws a dark line along every seam.
  The image is sized by the surface, 512 texels per metre rounded up to a power of two, between 64 and 4096: the game frame shows 200 pixels a metre at the gameplay plane (`BALL_ZOOM` at 1080p), and the painted slate's pale edge line is a texel or two wide, so a map under that density draws it magnified and blurred (the Terrace's 34 m² at a 1024 cap got 136 texels a metre). A 1000 m² wall still gets only about 100.
  The bake is a render (the edge line is a Bevel node, the crevices Ambient Occlusion, both ray traced) at 32 samples: at 4 the edge line came out as speckle that drew hairy and blurred; 64 differed from 32 by 0.3 levels rms.
  It runs on the first Cycles GPU backend with a device (OptiX, CUDA, HIP, oneAPI, Metal) and on the CPU without, with the same result to 0.008 levels rms; the log line names the device.
  Measured 2026-10-02 on an RTX 4070 SUPER: the river's 15 baked objects (9 of them at 2k) in 30 s, 4.7 MB optimised.
  Measured 2026-10-04, same card, at 4k and with the five Terraces: Blender 163 s, the whole `just scene` 195 s, 7.8 MB optimised. Cycles is most of it (bakes 84 s, writing them back 18 s, the colour pass alone about 87 s); the Terraces' curved creases (`curve.rebuild_mesh`) are about 15 s, down from 76 s once the bow field was evaluated over all bows at once (`curve.Bows`).
  An Ambient Occlusion node bakes what Cycles sees, other exported objects included, so a rock pushed into or under another darkens where they meet (boulder-1 under the river's floor slabs).
  Only the colour is baked, never light: the game lights it.
  A **painted slate** rock also gets a normal map the export bakes from a detail high poly it builds from the rock's own mesh and removes after (sub-facets and chips, `bake_detail_normals`; [rock-detail](rock-detail.md)), which goes in under the slate's shading Bevel so the normal the game gets is both combined, and every painted slate material is rebuilt to the formations add-on's current shader before the bake (`repaint_slate`), as the ivy and moss are regrown.
  An object with a `detail_scale` (a backdrop rock, [blender-backdrop](blender-backdrop.md)) is baked at the texel density divided by it and its slate's lengths multiplied by it, so it is as fine on screen as a rock on the gameplay plane, and skips the chamfer strips, the curved creases and the detail high poly (`far_back`).
  Until 2026-10-02 the colour was baked into a vertex colour instead, which averaged every grain, stain and edge line finer than the faceted mesh's vertices into a smooth tone; a faceted rock has big flat faces, so nothing of the painted stone survived.
  Roughness, metallic and emission wired to anything else still export as flat values, and the exporter warns about each (`meta.json`'s `warnings`, printed by the recipe); a Bump of strength 0 is no loss and is neither baked nor reported.
- **Lights.** The level's own lights carry glow and beam semantics and a budget (see [lighting-and-surfaces](lighting-and-surfaces.md)); a Blender light is dropped.
  Emissive materials do export, and a waking light in the body they dress drives them (above).
- **Volumetrics, fog, compositing.** The level's environment block is where the air is authored.
- **A moving surface.** Water and conveyor bands are the game's to draw (above).
- **Size.** A scene answers to the store's 100 MB total, not to its 8 MB per-file bar, which is a single prop's (2026-10-04); the export prints its size.
  The baked maps have their own encoding (`--baked-maps`, which `just scene` always passes; every other map stays lossy WebP at 1k): a baked colour map ships as **AVIF with full-resolution colour (4:4:4) at quality 90**, up to 4k, and since 2026-10-04 a baked normal map the same way (it was lossless WebP; see below).
  Lossy WebP turned the Terrace's dark, low-contrast 1k bake into 15 KB of blocks and purple-green blotches (it codes colour at half resolution, so even quality 100 kept the blotches); lossless WebP is exact but 1.17 MB at 2k, which would have put the river near 13 MB; AVIF 4:4:4 q90 is 114 KB, 0.77 levels rms off, and keeps the edge lines.
  three's GLTFLoader reads `EXT_texture_avif` itself.

## The levels' scenes

- **`ball`** names **`river`**.
  `river.blend` holds the `Guide`, the level's own dressing in `Dressing` (one mesh object per named body) and the generated cavern in `Cavern`.
- **`rails`** names **`rails`**: `rails.blend` holds the `Guide` and the level's dressing in `Dressing`.
- **`grotto.blend`**, the Sunken Grotto (formations built with the formations add-on, converted from karin_website's v5 background pipeline, [blender-formations](blender-formations.md#the-sunken-grotto)), is on disk and named by no level.
- Every other level names no scene and is drawn as its pieces' debug geometry.

Both `Dressing` collections were written once, on 2026-09-29, by a one-shot export of what the game then drew from the levels' geometry objects: each named body's visual, built by the game's own renderer, written to glTF by three's `GLTFExporter` and imported into the `.blend`, each body's meshes joined into one object with its origin on the body's rest pose.
Before-and-after `cli shot --3d` along both routes differed by a few thousand pixels of texture re-encoding.
From then on they are ordinary Blender objects: edit them, replace them, or model the level afresh around them.

`river.blend`'s `Cavern` collection is generated, not modelled: `assets-src/scenes/cavern/generate_cave.py` builds it in the game frame, composed against the camera the level opens on (the start chamber is traced from the reference painting as frame-fraction polygons; the rest of the cavern continues the same faceted slabs along the level), and `import_into_river.py` replaces the collection with it.
The recipe, the frame, the depths and what each part of the file does are in [assets-src/scenes/cavern/README.md](../assets-src/scenes/cavern/README.md); the point of keeping it a generator is that a change to the painting's reading, the fog or the level's camera is a number, not a remodel.
The level's fog (`fogAmount`, `fogColor`) is half of the look: the far layers are built at 22-45 m so the fog pales them the way the painting's haze does.

## Not yet

- Unplayed: the pipeline was written 2026-09-27 against an empty scene and `cli render3d`, the cavern of 2026-09-28 and the migrated dressing of 2026-09-29 were verified with `cli shot` along the camera routes, and the play is still the play.
- One scene per level. Two levels may share a scene, and a level cannot name two.

## Credits

Every image a scene ships is looked up by name in `tools/blender/image_credits.json` (Blender's `.001` suffix ignored): an image names a credited set (author, source, licence) or says which script `generated` it.
A **model** that is someone else's work has no image to be found by, so it carries its credit itself: a `credits` custom property on the Blender object, naming sets of the same table, comma-separated.
The export writes the sets it found into `meta.json` (`credits`) and prints them; an image the table does not know, or a `credits` name that is not a set, is an export warning.
`just publish` pins the credits beside the scene's sha256 in `src/render3d/sceneAssets.json` (and refuses a `meta.json` that describes a different `scene.glb`), and `bun run assets:credits` lists them in `CREDITS.md` under "Inside Blender scenes".
So a new texture in a scene is one line in the table; `CREDITS.md` stays generated.
