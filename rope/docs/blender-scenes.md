# Blender scenes

Environment lighting, shelters and [fog regions](lighting-and-surfaces.md#regional-fog) are authored and previewed in the level editor without a Blender export. Blender's Fog preview does not reproduce regional masks; judge those transitions in the level editor.

A level is **dressed in Blender**: one `.blend` holds the level's whole look, and one recipe puts it in the game.
The loop is: edit the scene in Blender, `just scene <level>`, refresh the browser.
This page is what a scene is, how it binds to the level, how the files move, and what Blender cannot carry.
The plans are [plans/blender-scenes.md](../plans/blender-scenes.md) (2026-09-27, the pipeline) and [plans/blender-owns-appearance.md](../plans/blender-owns-appearance.md) (2026-09-29, the ownership below).

**Blender owns every rendered mesh; the editor owns collision.**
Since 2026-09-29 a level carries no look of its own.
The geometry objects it used to draw with are gone from the format, and `withoutLook` (`level/levelFormat.ts`) drops them from any file that still has them.
Collision is authored in the editor exactly as before, and nothing about the sim can change from a Blender edit.
Deriving outlines from the meshes was considered and rejected: a geometry tweak would have been a physics change.

**A body may also carry a model of the library** ([blender-models](blender-models.md), since 2026-11-13): a `.blend` of its own, placed by the level on any body and carried by it.
The scene is for what stands in the level; a rigid body, or anything used more than once, is better a model, since a scene node bound by name has to be placed at its body's rest pose by hand in one level's file.

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
Each outline is in the colour its piece is shown in (`debugColorOf`: the piece's debug colour, else its body's colour, set in the editor), so a piece is recoloured in the editor and the next `just scene-guide` carries it over (2026-10-17, Tris).
A solid's fill is that colour at 35 % opacity (the Game add-on's Collision outlines **Opacity** sets it in the scene, [blender-game](blender-game.md#guides-from-collision-outlines)), flat (an Emission shader), so Material Preview shows the colour itself; until 2026-10-17 every solid was one lit blue-grey, which Material Preview drew near white.
The rectangle on the gameplay plane (`guide.plane`) is edges only: a face drew as an opaque white sheet behind the level in Material Preview, though the object displays as wire.
The guide has no depth: it says where the collision is on the plane, and the dressing decides how deep it is.
These collision outlines are a visual reference and nothing else: they, their origins, the plane and the spawn are unselectable (`hide_select`; the cameras are not), nothing in the scene refers to one, and a rock is never built from one.
The Game add-on's **Create Guide from Outline** copies one into a guide of the scene's own, which keeps nothing of where it came from, so the next run can add, move or drop any piece without a guide or rock changing ([blender-game](blender-game.md#guides-from-collision-outlines)).
Until 2026-10-02 the guide was meshes, each body's outlines extruded through its thickness; Blender filled their faces along a normal that was never computed, so concave outlines came out as fans of triangles outside the collision.
The guide also carries the **game camera**, `guide.camera`: the level's lens, keyed on every frame at 60 fps through the real camera controller along the level's camera paths (or along a recorded run, `--ride <bundle>`), so looking through it in Blender is looking through the game ([blender-game](blender-game.md#the-game-camera)).
Beside it are what the game draws over that view, for the Game panel's toggles: `guide.camera.dof` (the same camera with the game's depth of field), the game's light at rest (`guide.lights` and `guide.world`, which the scene does not use until the panel's Lighting links them in), and the level's fog on the camera.
It **creates `<scene>.blend`** when there is none, with the `Guide` collection linked from the guide file, so reopening the scene after a level edit shows the current colliders and the dressing is always modelled against the outline the ball actually rolls on.
The guide file is overwritten on every run and never exports.

`just scene <level>` (`scripts/scene-export.ts`, `tools/blender/scene_export.py`) runs headless Blender over the scene: every object with geometry goes out with its world transform and modifiers applied, except one **linked** from another file (the guide), one in a collection named `guide*` or **excluded from the view layer**, and one **hidden in render**, itself or through a collection it is in (the camera icon - render visibility is what ships, viewport visibility is the artist's).
Lights, cameras, empties and armatures never go out.
Before anything is selected, every grown ivy and moss object is grown again from its paint (see [blender-ivy](blender-ivy.md) and [blender-moss](blender-moss.md)), and every plant from its settings and placement ([blender-foliage](blender-foliage.md)), so what ships always matches the rock it grows on as the file now stands.
Plants are hidden in render while the textures bake, so they are in no rock's occlusion and no rock's cache key.
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

Unused empty material slots are tolerated during baking: the export copy fills them with an existing material while retaining slot indices. The source `.blend` is unchanged. Faces referencing an empty or missing slot still fail with the object and slot numbers; validation uses the evaluated mesh so modifier-generated faces are checked too. This fixes Cube.006's unused second slot blocking the river export (2026-11-14).
Workers validate and retain the original slots before their first task. Later map tasks reuse those validated materials: a prepared mesh has additional slots per texture map, so its face indices cannot be checked against the original slot count.

Preparing and baking is most of an export, and an edit usually touches one or two objects, so every baked object's prepared mesh (modifiers applied, creases rebuilt and still straight, the bake unwrap) and final maps (its `baked colour` and `baked normal` images, as the glTF gets them) are kept in `rope/.cache/scene-bake/<scene>/` (gitignored), and an object whose key has not changed loads them instead (`tools/blender/bake_cache.py`, since 2026-10-04; the mesh since 2026-10-07).
A cached object is neither prepared nor baked: no crease rebuild (100 s for Terrace.011 alone, 170 s for the river's Terraces), no unwrap, no detail high poly.
Its mesh is kept straight with its bows, and bent with the fresh ones after the bakes, so an object still to bake meets its neighbours as a cold export would.
The key is taken on the scene before anything is prepared, since the preparation is a function of what the key holds: the bake code and Blender's version; the scene's Cycles settings a bake reads and its bake settings; the object's evaluated mesh (every attribute), its world transform, detail seed and render settings (depth, strips, creases, chips, map size); every node tree of its materials as the export repaints them, slot by slot, groups and images (by their pixels) included; and every triangle of the rest of the scene within reach of its Ambient Occlusion nodes, with the seed and render settings of a baked neighbour, since the slate's 0.5 m occlusion darkens where a neighbour comes close.
Every input is taken by content, never by name or by its place in the file.
Until 2026-10-07 the key held the names of the export's per-object material copies, which Blender numbers after every material in the file (`Painted slate.058`), so a rebuild anywhere that added a slate material re-baked every rock in the scene; and a neighbour counted whole, so a vertex moved on one backdrop rock re-baked the five others whose boxes it touched.
Now a neighbour's edit re-bakes an object only when the edited triangles are within its occlusion reach.
A neighbour is only what the render shows: Cycles leaves out an object hidden in render, itself or through its collections, so it never darkens a map (a hidden cube over a plane's 2 m occlusion: 0.98 mean colour, as with nothing there; shown, 0.75).
Until 2026-10-08 the scan counted them too, so the guides (`guide.plane` and every collision outline, all hidden in render) were in nearly every rock's key, and editing or re-copying an outline re-baked every rock near it without changing a pixel.
Adding a rock still re-bakes the rocks within its reach, and must: its occlusion darkens them where it comes close.
`just scene <level> --stale-occlusion` skips those while iterating: the key is in two parts, the object's own (everything above but its neighbours, kept in the entry's `meta.json`) and its neighbours' hashed on top, and with the flag an object whose own part is unchanged loads its last bake whatever its neighbours did.
Its colour map then holds the occlusion of where its neighbours stood at that bake, so the export names every such object in its warnings and the step line counts them ("2 with stale occlusion"); the entry keeps its old key, so the next export without the flag re-bakes them, and that is the one to publish.
An entry written before 2026-10-08 has no own part and is never found this way.
The bake code is the part of `scene_export.py` the bake reaches from `bake_procedural_textures`, plus the formations modules it imports and those import, each as its syntax tree with its reports left out (a `log`, `step` or `print` whose arguments call only side-effect-free builtins; `log(f"... {curve.rebuild_mesh(...)}")` stays in): a comment, a docstring, a reflow, a log line or an edit to the export's other steps re-bakes nothing; any other edit to the bake's code re-bakes everything.
What decides a pixel is in the key: a missed input ships a stale map without a word, an extra one costs a bake.
Hair curves, point clouds and volumes have no triangles to read, so one counts whole (its data and transform) for every rock its box comes within reach of.
Entries the latest export did not use are removed, so the cache holds one export per scene; the log line says how many objects came from it.
The optimiser's encode has a cache of its own, `rope/.cache/scene-encode/<scene>/` (`scripts/encode-textures.mjs`, `--texture-cache` on `optimize-asset.ts`): each map's AVIF or WebP keyed on the source image's bytes, its colour space, the rule's encoding and the encoder's versions (gltf-transform, sharp and its libraries).
Encoding was most of a warm export once the bake was cached (93 s of the river's 110, 2026-10-07: 57 maps up to 4k), and an unchanged map's PNG comes out of the bake cache byte for byte, so only the maps of re-baked objects are encoded again.
A cached encode goes into the file at the point of the pass that would have made it, and the shipped glb is byte for byte the uncached one's.
`just scene <level> --no-cache` bakes and encodes everything afresh and leaves both caches alone.
After every export `scene-export.ts` checks that the optimiser encoded every baked map as one (`baked colour` and `baked normal`, both AVIF): it finds them by image name, and a name the glTF exporter cut short at a dot (`Terrace.003 baked colour` went out as `Terrace`) shipped the four dotted Terraces as lossy WebP at 1k until 2026-10-04.
On a miss it names the maps the optimised file lacks (Blender's meta lists them, `baked_maps`).
The optimiser writes into the export's scratch directory and the file is copied into `public/scenes/<scene>/` only once every check has passed, so a failed export leaves the last good scene in place; until 2026-10-18 the checks ran on the shipped file, and a failed export left its broken file in the game.

A bake that writes no texel into a map fails the export, naming the object, the pass and the map (`fill_baked` in `scene_export.py`), before anything is cached.
An empty map fills to solid black, the glTF exporter ships a one-colour image as a factor with no image, and the bake cache would keep it for every export after.
That is how Cube.003 went out a black rock on 2026-10-18: its colour map was empty while its normal map, from the same run, was whole, and baking it again from the same file (alone, and in one bake with the three rocks baked beside it, on the same OptiX device) wrote it whole, so the cause is not in the file; with Chrome holding 6 GB of the 12 GB card, device memory is the suspect, unconfirmed.
Blender's whole output from the latest export, Cycles' lines included, is kept in `rope/.cache/scene-export/<scene>.blender.log`; the steps show only the export's own lines, and before 2026-10-18 the rest went nowhere.

## The bake workers

The objects the export prepares and bakes (those the bake cache does not hold) are shared among worker Blenders that run side by side (`run_workers` in `scene_export.py`, since 2026-11-13; `WORKERS`, 8, or `SCENE_EXPORT_WORKERS`, where 1 bakes them all in the export's own Blender).
Blender handles a bake's every texel on one thread, and preparing a rock (the strips, the creases, the unwrap, the detail) is mostly one thread too, so one Blender left the other cores idle.
The export saves the scene as it stands at that moment, grown, its plants hidden and its mosses cut for the bake, to a temporary file (`save_as_mainfile`, a copy), and each worker opens it, takes the next object off a queue (largest first, `work_estimate`), prepares and bakes it as the export would, and writes its prepared mesh and maps as the bake cache keeps an entry (`bake_cache.write_entry`).
The export takes each back as it takes a cached object (`adopt`), keeps it in the cache when there is one, bends it with the rest and writes the glTF as before; only its `[scene_export]` lines come through, and a worker that fails fails the export with its last lines.
A worker computes its texture-only mosses for the rocks it bakes alone (`moss.prepare_texture_paints`).
On three rocks the workers' maps matched the export's own to 1/255, 16.5 s against 31.6 s.
At most `GPU_SLOTS` (4) of them bake at once (a lock file each, `gpu_slot`): each Cycles session holds the whole scene on the card, about 1.2 GB on the river, and eight at once took the 12 GB 4070 SUPER to 11.6 GB beside other programs; with four, 9.1 GB at the peak.
The river's cold export went from 26 min 30 s of Blender to 6 min 55 s (2026-11-13): 172 s growing, 225 s for the workers to prepare and bake all 35 objects, 15 s loading their results, bending and writing; its maps matched the serial export's to a median of 0.001/255 rms, the most 0.5/255 where a rock's occlusion met its neighbours unprepared, but for Terrace.007, which shared its place with an exact copy ("Terrace.007 / new"), so its occlusion was whichever face a ray met first.
A map taken back from a file (a worker's or the cache's) is named by its image, not its file (`bake_cache.load` clears the path once packed): the glTF exporter names a PNG by its file, whose slash is escaped.
Baking one object at a time showed that a bake of one object, cleared (Blender's default), writes the flat normal at alpha 1 over every texel off its islands, so the background fill saw nothing to fill there, while a bake of several drops the clear; every bake now passes `use_clear=False`, which writes only the texels it bakes, whatever the count.
A worker runs with `--python-exit-code 1`: until 2026-11-13 one whose bake raised exited 0, and only the missing result said anything had gone wrong.

### Split rocks

A rock of `SPLIT_MAPS` (2) maps or more is shared among the workers map by map (since 2026-11-13; `SCENE_EXPORT_SPLIT_MAPS` overrides it, a large number splits nothing).
Terrace.012's eight 4096 maps kept one worker busy for 108 s alone and 225 s among the others, the last to finish by 20 s.
The worker that takes the rock prepares it (strips, creases, unwrap), writes it back as an entry with no maps and says `[scene_worker] split NAME COUNT`, then makes the geometry of its detail (`detail.detail_geometry`: the crumpled rock and the chip cutters, 22 s of Terrace.012) and saves it beside the entry (`detail.save_geometry`).
Each map is then a task of its own at the front of the queue (`NAME<tab>MAP`): the worker that takes it loads the prepared rock as a cached one is loaded and bakes that map alone, every other map's images 1 x 1 stand-ins (`stand_in`, neither filled, packed nor handed back), so its rays meet the whole rock as one bake of every map would; it waits for the detail geometry only once its colour is baked, casts that map's detail rays (`detail.normal_maps` with the geometry given) and bakes its normals.
`run_workers` moves each map's images into the rock's entry, which then holds them all as an unsplit rock's does; a worker with nothing to take waits while a rock it might be handed is still being prepared, and the first worker to fail stops the others.
A worker keeps one Blender for all its tasks, so the materials each object had in the saved scene are taken before its first task there (`PRISTINE`, the originals, not the depsgraph's evaluated copies, which go at its next evaluation): a later map of a rock it already worked on starts from them, as its own copies are wired to their baked maps by then.
On Terrace.012 one bake call for all eight colour maps took 35.5 s and eight calls of one map each 41.5 s in all, 5.2 s apiece; each map differed from the one-call bake by one 8-bit level at most.
A bake session holds about 2 GB of the card whatever it bakes (2.25 GB at the peak for one map or eight), so splitting does not let more bakes share it.

The background fill (`fill_background`, pull-push) is the native kernel's (`native/src/fill.cpp`, since 2026-11-13): the same float operations in the same order as the numpy it replaced, bit for bit on maps from 1 x 5 to 4096 x 4096, on every thread; 0.26 s a 4096 map against 0.66 s.

## The growth workers

The ivy and the moss the export grows (every ivy, and each moss whose `built_key` is stale) are grown side by side in factory-startup worker Blenders (`tools/blender/growth_pool.py`, since 2026-11-13; up to half the cores, `SCENE_EXPORT_GROWERS`, where 1 grows them in the export's own Blender).
A growth needs nothing of the scene but its hosts' world triangles, its paint and its settings, so the export takes those (`ivy.ops.build_job`, `moss.ops._Inputs.job`) before writing any back, a worker unions the hosts and builds (`grow_job`), and the export writes each result into its object exactly as a rebuild in place would (`ivy.ops.apply`, `moss.ops.apply_grown`), logging them in the order it always did.
Growths on the same hosts go to one worker one after another, so their union is made once (Terrace.002's two ivies on Terrace.002 + Cube.002 each made it in 31 s); one with no paint and no vine makes no union at all (Cube.004's ivy and moss each spent 45 s on the union of its 31 shells to grow nothing).
On the river every grown mesh and print came out byte for byte as the serial growth's, in 85 s against 222 s, both while other work shared the machine; the longest growth is now the floor (Terrace.moss, 60 s alone).

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
  A **Base Color** or **Normal** wired to anything else (noise, ramps, mixes, a Bump) is **baked** (`bake_procedural_textures`): on its own copy of the mesh, modifiers applied, the export unwraps the object afresh (Smart UV Project into a UV map `SceneBake`, packed with islands 2 px apart), runs Cycles' diffuse colour pass into an image of the object's own and a tangent-space normal bake into a second, copies the object's materials and wires the images in, so they ship as `baseColorTexture` and `normalTexture`.
  The unwrap runs on a welded copy, the UVs carried back corner by corner: the river's boulders came in through glTF split at every face, and unwrapped as they are they made one speck of an island per face, 21 % of the image covered instead of 54 %.
  Baked maps are 512 texels a metre up to 4096 since 2026-10-03 (were 256 up to 2048; `TEXELS_PER_METRE`, `BAKE_SIZE_MAX`, and `BAKED_MAX` in scripts/encode-textures.mjs).
  The baked normal map is half the colour map's side and lossy AVIF since 2026-10-04 (`NORMAL_SCALE`, scripts/encode-textures.mjs): lossless at the colour's size the five Terraces' normals were 16 of the river's 20.7 MB against the store's 8 MB a file. Tris compared all four on Terrace.003 in the game frame (full or half, lossless or lossy: "barely any difference"); the encoding moved the render by at most 3 levels of 255, the halving by up to 44 along chip edges at twice the game's zoom, and the map went from 4,242 KB to 503 KB. The unwrap keeps its islands `PACK_GAP_PX` apart at the normal map's size, and the detail high poly still bakes at the colour's.
  A face with no area (the planar dissolve leaves collinear slivers) gets one UV for all its corners: after the weld its corners could land on different islands, a streak across the atlas, which drew nothing while the face was flat but became a pale stair-stepped band once the curved creases bent it open after the bake (2026-10-03; `DEGENERATE_AREA`).
  Every texel no island covers is filled (pull-push from the baked texels), since a mip level that averages in background draws a dark line along every seam.
  The image is sized by the surface, 512 texels per metre rounded up to a power of two, between 64 and 4096: the game frame shows 200 pixels a metre at the gameplay plane (`BALL_ZOOM` at 1080p), and the painted slate's pale edge line is a texel or two wide, so a map under that density draws it magnified and blurred (the Terrace's 34 m² at a 1024 cap got 136 texels a metre).
  The surface counted is what the game camera can see (`seen_faces`, since 2026-10-16): a face is seen if it faces the 70 mm head-on camera from somewhere in its 16:9 frame (a 5 x 5 grid of directions, 10 % past the edges) and a ray from its centre or a corner leaves the rock without hitting the rock again, and every face touching a seen one by a vertex is seen too.
  The rays are cast by the native kernels (`tools/blender/native/src/bvh.cpp`, a BVH over Blender's own triangles of the faces, every thread; since 2026-11-13): one at a time through `mathutils` they were 617 M calls and 1,216 s of a cold river export, and Terrace.012's 582 k faces now take 0.65 s against 10.4, the same faces seen but for 3 of Terrace.007's 7,644 grazed by a ray.
  `--all-seen` counts every face seen, for a model the game can turn to show any side of; it is part of every object's bake key.
  Only the rock's own surface occludes, so a neighbour's moving never changes which faces are seen without changing the rock's bake key.
  The rest (the stone inside a pile, its back, a hidden underside: half of Terrace.001) is unwrapped apart and packed at a quarter of the density (`render.HIDDEN_DENSITY`), not none, since the water's mirror and the ball's reflection see some of it.
  A painted slate rock on the gameplay plane that one 4096 map cannot hold at 512 texels a metre is split over several (`render.TILE_TEXELS_PER_METRE`, `MAX_MAPS`, the Formations panel's **Most maps**): 400 texels a metre, a texel a pixel at 4K at the closest zoom, every map 4096 but the last, which takes the power of two its share needs.
  Each map has its own copy of the rock's materials (`split_materials`), so the glTF mesh has a primitive per map, and its islands are dealt out in order along the rock's longest side, so each map's faces lie together and three culls each by its own box.
  The maps are named `<rock> map <n> baked colour` (and `baked normal`).
  Before this, Terrace.001 (a 37 x 18 m pile, 470 m²) got 146 texels a metre from its one map against Terrace.003's 531; Tris chose 400 over 512, which would have cost 64 % more maps at 85 MiB of GPU memory each (a 4096 map with its mips).
  A rock further back keeps one map (its density and its cap are already divided by its depth), and so does anything that is not painted slate (the backdrop's pool plane).
  The islands are packed by the native packer (`tools/blender/native/src/pack.cpp`, since 2026-11-13), each map on its own thread and the maps side by side: every island rasterised conservatively on a 1024-texel grid in its four quarter turns, placed largest first at its lowest, then leftmost, free place, with the gap kept between the texels' squares, at the largest scale that fits (bisection).
  It covers 0.75 to 0.81 of Terrace.002's and Terrace.010's maps where Blender's concave packer covered 0.55 to 0.62, with no island closer than the gap (checked texel by texel at full size), and Terrace.010's unwrap went from 124 s to 9.5 s; xatlas's packer was tried first and rejected, its packs overlapping.
  A map of many tiny islands was its worst case: the old generator's Cube.004 (9,061 islands) took 237 s, every row below the packed frontier walked run by run to prove nothing fits there; within a row only the columns where the atlas has a free square as big as the largest the island's dilated mask holds are tried now (a per-texel free-square map, capped at 64 and kept up to date near each placement), and it packs the same islands to the same UVs in 7.5 s (2026-11-13).
  The map plan counts on that (`render.UV_COVERAGE` 0.6 -> 0.75, Tris: "good"): the same density in fewer texels, the river's colour maps from 627 M texels to 576 M, Terrace.002, .005, .006 and .010 each a map fewer.
  Turning by right angles is what took Blender's packer from 0.47 to 0.59 on Terrace.001's maps (without, it would have needed a sixth map), and any island running longer than half its map's side is cut into squares first (`cut_islands`): Smart UV Project keeps a run of near-coplanar faces whole however far it runs, and on Terrace.001 one ran the width of a map, so the packer shrank every island until it fit and filled 9 % of the map.
  The bake is a render (the edge line is a Bevel node, the crevices Ambient Occlusion, both ray traced) at 8 samples since 2026-11-13 (`BAKE_SAMPLES`; 32 before): against 32 the colour map moved 0.75 levels rms and the normal map 1.1, Terrace.002's bake calls took 7.0 s against 12.4, and Tris saw no difference on the [comparison page](https://claude.ai/artifact/2j4E9oa9N15KQ5RC3h7SQL); at 1 the speckle is back (2.5 and 4 levels rms, single texels off by 229), and in 2026-10 at 4 the edge line came out as speckle that drew hairy and blurred; 64 differed from 32 by 0.3 levels rms.
  It runs on the first Cycles GPU backend with a device (OptiX, CUDA, HIP, oneAPI, Metal) and on the CPU without, with the same result to 0.008 levels rms; the log line names the device.
  Measured 2026-10-02 on an RTX 4070 SUPER: the river's 15 baked objects (9 of them at 2k) in 30 s, 4.7 MB optimised.
  Measured 2026-10-04, same card, at 4k and with the five Terraces: Blender 163 s, the whole `just scene` 195 s, 7.8 MB optimised. Cycles is most of it (bakes 84 s, writing them back 18 s, the colour pass alone about 87 s); the Terraces' curved creases (`curve.rebuild_mesh`) are about 15 s, down from 76 s once the bow field was evaluated over all bows at once (`curve.Bows`).
  Measured 2026-10-08, cold, with the solid formations Cube, Cube.004 and Cube.005 (depth scale under 1, so every pass runs): 1330 s, 63 % of it those three rocks' curved creases and detail high polys; Cube alone 747 s (2714 creases took it from 24,850 to 523,396 faces, then 534 s of detail).
  Three causes, all fixed with the meshes unchanged (the rebuilt and bent rock byte for byte, the high poly face for face): the creases' grid and its clearance were tested point by point in Python (`detail.points_in_polygon`, `edge_distances` now take every point at once); the bow field was evaluated in blocks of `FIELD_BLOCK` over every bow (96 points a block on Cube) and measured every pair (now blocks over the bows that can reach the points, and only the pairs in a bow's box); and `crumple` deleted each plane on its own, every delete walking the whole mesh (110 ms a delete at 360 k faces; now one delete).
  Cube: 94 s of creases and 24 s of detail.
  An Ambient Occlusion node bakes what Cycles sees, other exported objects included, so a rock pushed into or under another darkens where they meet (boulder-1 under the river's floor slabs).
  Only the colour is baked, never light: the game lights it.
  A **painted slate** rock also gets a detail normal map of the sub-facets and chips the export makes from the rock's own mesh (`bake_detail_normals`, each texel cast natively at the detail since 2026-11-13; [rock-detail](rock-detail.md)), which goes in under the slate's shading Bevel so the normal the game gets is both combined, and every painted slate material is rebuilt to the formations add-on's current shader before the bake (`repaint_slate`), as the ivy and moss are regrown.
  An object with a `detail_scale` (a backdrop rock, [blender-backdrop](blender-backdrop.md)) is baked at the texel density divided by it and its slate's lengths multiplied by it, so it is as fine on screen as a rock on the gameplay plane.
  The chamfer strips, curved creases and chips each leave out what the game's High depth of field would blur away where the rock stands, and the whole pass once its largest feature is (`render.setting`, since 2026-11-13; before, a solid formation skipped the creases and chips at any depth, `SOLID_SKIPS`); a rock's own Render toggles override that (the river's four old-generator rocks have creases and chips off).
  Until 2026-10-02 the colour was baked into a vertex colour instead, which averaged every grain, stain and edge line finer than the faceted mesh's vertices into a smooth tone; a faceted rock has big flat faces, so nothing of the painted stone survived.
  Roughness, metallic and emission wired to anything else still export as flat values, and the exporter warns about each (`meta.json`'s `warnings`, printed by the recipe); a Bump of strength 0 is no loss and is neither baked nor reported.
- **Pictures.** An image shown as it is on a plane (what Image as Plane builds) goes out whole since 2026-10-17 (`prepare_pictures`).
  A material is a picture when one Image Texture feeds both a Principled BSDF's Base Color and its Alpha (lit), or when it is the "shadeless" shape: a Mix Shader of a Transparent BSDF and an Emission of the image's colour at strength 1, mixed by the image's alpha (unlit).
  An image a tool drew (the moss prints, `generated_by`) is not one.
  The glTF exporter reads the shadeless shape as a black surface glowing with the image, opaque: the alpha was lost and the river's root-room backdrop drew every cutout as a black box, outlined in the blocks lossy WebP leaves in the colour under a transparent texel.
  It carries a Transparent BSDF mixed with a colour as `KHR_materials_unlit`, blended by the Mix's factor, so the export takes the Emission out (at strength 1 it changes nothing) and the picture ships unlit with `alphaMode: BLEND`.
  Each picture's image ships as a copy named `<image> picture` (once per file, however many Blender images load it), with the colour under every fully transparent texel filled from the visible ones (`fill_background`'s pull-push): straight alpha is filtered colour and alpha apart, so a painted cutout, black under its alpha, drew a dark rim wherever a texel at the outline or a mip level averaged that black in.
  No visible texel and no alpha changes.
  The encoder keeps it exactly: **lossless AVIF at its own size**, since lossless WebP rewrites the colour under a transparent texel (to black or a prediction) and AVIF codes colour and alpha apart (bg_10, 1143 x 1065: PNG 2.30 MB, lossless WebP 1.20, lossless AVIF 1.27).
  `scene-export.ts` fails an export where a picture missed that rule, as it does for a baked map.
- **Lights.** The level's own lights carry glow and beam semantics and a budget (see [lighting-and-surfaces](lighting-and-surfaces.md)); a Blender light is dropped.
  Emissive materials do export, and a waking light in the body they dress drives them (above).
- **Volumetrics, fog, compositing.** The level's environment block is where the air is authored.
- **A moving surface.** Water and conveyor bands are the game's to draw (above).
- **Size.** A scene answers to the store's 100 MB total, not to its 8 MB per-file bar, which is a single prop's (2026-10-04); the export prints its size.
  The baked maps have their own encoding (`--baked-maps`, which `just scene` always passes; a picture is lossless at its own size, above, and every other map stays lossy WebP at 1k): a baked colour map ships as **AVIF with full-resolution colour (4:4:4) at quality 90**, up to 4k, and since 2026-10-04 a baked normal map the same way (it was lossless WebP; see below).
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
