# Blender scenes

Since 2026-09-27 a level can be **dressed in Blender**: one `.blend` holds the level's look, foreground ledges and backdrop alike, and one recipe puts it in the game.
The loop is: edit the scene in Blender, `just scene <level>`, refresh the browser.
This page is what a scene is, how it binds to the level, how the files move, and what Blender cannot carry.
The plan is [plans/blender-scenes.md](../plans/blender-scenes.md).

**Blender owns appearance and nothing else.**
Collision is authored in the editor exactly as before, and nothing about the sim can change from a Blender edit; a scene is to a level what a geometry object is to a body, at the scale of the whole level.
Deriving outlines from the meshes was considered and rejected: a geometry tweak would have been a physics change.

## Binding

- A body has a stable **`name`** (`LevelBodyData.name`, the body panel's `name` field).
- The level names its scene once: **`scene`** (`LevelData.scene`, the Level panel's `scene` field) is `assets-src/scenes/<scene>.blend`.
- An object in the exported scene whose name is a body's name is **that body's dressing**: mounted under the body's visual root and carried by it, so a rigid crate, a mover or a pivot takes its dressing along, and moving a body in the editor moves its mesh.
- Every other object is **scenery**, standing in the world where Blender put it.
- A body may still carry geometry objects, and a dressed body usually carries none; the two draw side by side, so a level is dressed a body at a time.

Names are matched as three.js spells a glTF node's name (`nodeNameOf` in `render3d/scenes.ts`, which is `PropertyBinding.sanitizeNodeName`): whitespace becomes `_`, and `.`, `:`, `/` and square brackets are dropped.
So Blender's `Ledge.001` is the node `Ledge001`, and a body called either is dressed by it.
`cli levels` holds a level's names unique under that rule, since two bodies of one name would dress the first and leave the second bare with nothing on screen to say why.

**Blender places the mesh; the body carries it from there.**
The exporter keeps every object's world transform, and `dressScene` (`render3d/sceneDressing.ts`) mounts a bound node at Blender's pose minus the body's rest pose - the engine origin and rotation for a body that collides, the authored ones for one that does not (`BuiltBody.origin`).
At rest the node is drawn exactly where Blender put it; nothing is written back into the level.
Only the outermost match is taken: an object named like a body inside another such object rides its parent, as it did in Blender.
A bound node answers a pick with the body's first authored object, so clicking the dressing in the editor's 3D view selects the body; scenery answers nothing.

Scenery keeps the shadow rule decoration has: behind the gameplay plane it is a painted distance and casts nothing, on or in front of it (its nearest point past `SHADOW_Z`) it casts like anything else.
A bound node is the body and always casts.

## The loop

```sh
just scene-guide ball     # once, and again whenever the collision changes
# open rope/assets-src/scenes/river.blend, model on the guide, save
just scene ball           # export, optimise, report
# refresh the browser
just publish              # before committing a level that shows the scene
```

`just scene-guide <level>` (`scripts/scene-guide.ts`, `tools/blender/scene_guide.py`) writes the level's collision into **`<scene>-guide.blend`**: one object per body, its collision outlines extruded through the body's drawn depth (its first geometry object's `depth`, a generated boulder's `depth` parameter or that schema's default, else the extruder's 20 cm) and centred on the gameplay plane, with the object's origin on the body's origin (`guide.<name>`, or `guide.body-<index>` for an unnamed one), an empty on every origin, the gameplay plane's extent as a wire rectangle, and a sphere of the avatar's radius at the spawn.
Solids draw translucent with their wire, areas as wire.
It **creates `<scene>.blend`** when there is none, with the `Guide` collection linked from the guide file, so reopening the scene after a level edit shows the current colliders and the dressing is always modelled against the outline the ball actually rolls on.
The guide file is overwritten on every run and never exports.

`just scene <level>` (`scripts/scene-export.ts`, `tools/blender/scene_export.py`) runs headless Blender over the scene: every object with geometry goes out with its world transform and modifiers applied, except one **linked** from another file (the guide), one in a collection named `guide*` or **excluded from the view layer**, and one **hidden in render** (the camera icon - render visibility is what ships, viewport visibility is the artist's).
Lights, cameras, empties and armatures never go out.
The result goes through the pinned prop pipeline with node names kept (`assets:optimize --keep-nodes`, which also turns instancing off, since an instanced node loses its name) into

```
public/scenes/<scene>/scene.glb    what the game draws
public/scenes/<scene>/meta.json    what was exported, and how it binds
```

and the recipe prints the binding: which objects landed on bodies, which are scenery, which body names have no object behind them, what Blender skipped and why, and every exporter warning.
The dev server serves `/scenes/` itself, uncached (`src/server/scenes.ts`), because vite's public handler knows only the files its watcher saw at startup and the directory is off the watcher; a refresh shows the new export.
The Level panel shows the export's summary and the body panel offers the exported object names in the `name` field and says whether the name is dressed.

## Frames and units

Blender metres are game metres.
Blender is z-up and the exporter writes y-up (Blender `x, y, z` becomes glTF `x, z, -y`), and the game draws in glTF's frame (x right, y up, z toward the camera).
So in Blender the **gameplay plane is `y = 0`**, toward the camera is **negative y**, and a backdrop behind the level sits at **positive y**.
The guide stands in this frame, so none of it has to be remembered while modelling.

## Publishing

The scene is a stored binary like every other (see [asset-store](asset-store.md)): `public/scenes/` is gitignored, and `bun run assets:publish-scenes` (in `just publish`) uploads `scene-<scene>.glb` to the release and pins its sha256 and size in `src/render3d/sceneAssets.json`, which is committed with the level.
Unlike a generated mesh a scene is **replaced in place** on publish: it is exported again and again while the level is dressed, and a name per export would leave every draft in the release for ever.
The pin is what says which export a commit meant; `assets:fetch` verifies it, so an older commit whose scene was replaced fails its fetch loudly rather than drawing a different level - the store's stated trade.
`cli assets` fails on a scene a registered level names that the manifest lacks, on a manifest entry no level names, and on a scene name the store cannot take (`SCENE_NAME`: lower-case letters, digits, dashes).
A build keeps only the `scene.glb` of scenes registered levels name (`scenesInBuild` in `vite.config.ts`).

The `.blend` files are raws under `assets-src/`, gitignored like every raw; publish them to the release by hand when a scene is accepted, or the recipe of the dressing is lost with the machine.

## What Blender cannot carry

- **Procedural materials.** glTF carries a Principled BSDF with image textures and nothing else; a Base Color wired to a noise, a colour ramp or a mix exports as a flat colour.
  The exporter warns about every such socket (`meta.json`'s `warnings`, printed by the recipe).
  Bake it to an image, or texture with images to begin with.
- **Lights.** The level's own lights carry glow and beam semantics and a budget (see [lighting-and-surfaces](lighting-and-surfaces.md)); a Blender light is dropped.
  Emissive materials do export.
- **Volumetrics, fog, compositing.** The level's environment block is where the air is authored.
- **Size.** The per-file bar is 8 MB and textures are capped at 1k by the optimiser; the recipe warns past the bar.
  Splitting a level into a foreground and a backdrop scene is the release valve, and is not supported yet: a level names one scene.

## Not yet

- Unplayed: written 2026-09-27 against an empty scene and `cli render3d`; the first real dressing of the river level is the play.
- One scene per level. Two levels may share a scene, and a level cannot name two.
- Credits: textures inside a scene are not credited; a scene that ships someone else's textures needs a `CREDITS.md` line by hand.
