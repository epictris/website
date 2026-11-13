# Blender models

A **model** is a 3D model of the game's library, modelled in a `.blend` of its own and placed by a level on any of its bodies, which carries it.
A lantern on its chain, a crate, a mover's platform: anything the sim moves, or anything a level uses more than once.
The loop is: edit `assets-src/models/<model>.blend`, `just model <model>`, refresh the browser.
Every body carrying a `model` object of that name, in every level, draws the new export.

## Why models and scenes both exist

A level's [Blender scene](blender-scenes.md) places what STANDS in it.
A scene object named like a body rides that body, but it is placed by hand at that body's rest pose in that one file.
That is the right tool for a ledge or a cave wall, and the wrong one for a rigid body: six lanterns are six objects to model and line up, a seventh is a scene re-export, and nothing about a lantern can be reused by another level.
A model is authored once and placed by the level like any other object, so the level's layout and the model's look are edited in the places each one belongs (2026-11-13, Tris: "blender can't be the sole source of truth for 3d geometry - only for static geometry. For rigidbodies I need to be able to specify a 3d model").

Name binding stays: a one-off dressed body is still dressed by its scene.
A body may have both, and draws both.

**Appearance only, as the scene is.**
A model has no collision, nothing wraps it, the sim never sees it, and a body made of nothing but models builds no engine body.
What a body collides as is its collision objects, drawn by hand in the editor, and never derived from the mesh (Tris, 2026-11-13, keeping the rule of 2026-09-27).
So no model edit can change how the ball rolls.

## The level side: the `model` object

A model is placed by a scene object of its own, `{ type: "model", model, x, y, rot, z, rotX, rotY, scale }` (`ModelObjectData` in `level/levelFormat.ts`), in its body's frame like a light or an anchor.

- `model` names the model: `assets-src/models/<model>.blend`, held to lower-case letters, digits and dashes (`MODEL_NAME` in `render3d/models.ts`), since it is a directory and a release asset too.
- `x`, `y`, `rot` are the placement every object has: an offset in the body's frame and a turn in the plane.
- `z` is how far off the body's plane the model's origin sits, toward the camera; a length, so it scales with the file.
- `rotX`, `rotY` tilt it about the screen's horizontal and vertical axes, in radians, right-handed in three's frame (y up, z toward the camera).
  They are applied BEFORE the turn in the plane (three's Euler order `ZYX`), so a model tilted to show its side keeps showing it as its body swings.
- `scale` is a uniform factor against the modelled size.
  It is a ratio, not a length: a level authored in pixels does not rescale a model modelled in metres.

Every field left at its default is left out of the file, as everywhere else in the format.
`cli levels` holds every model object to a model's spelling and a positive scale.

## The Blender side: the model's file

A model is modelled in the game's own frame, Blender's front view: metres, -y toward the camera, z up.
Its **origin is Blender's world origin**, not any object's: the point the level places, and the point a body's turn pivots the model about.
Model a lantern with its origin where it hangs from, a crate with its origin at its centre.

Everything a scene file can hold, a model file can hold, because `just model` runs the same exporter (`tools/blender/scene_export.py`): procedural materials are baked, pictures go out whole, ivy and moss grow, a `credits` custom property credits someone else's mesh, and a guide collection or an object hidden in render stays out.
The one difference is `--all-seen`: a scene's rock faces the camera and its unseen back is unwrapped at a quarter of the texel density, but a level may turn a model to show any side of it, so every face counts as seen.

## The loop

```sh
# create rope/assets-src/models/lantern.blend, model it, save
just model lantern
# refresh the browser
```

`just model <model>` (`scripts/model-export.ts`) exports `assets-src/models/<model>.blend` to `public/models/<model>/model.glb` and writes `meta.json` beside it: Blender's account of the export, the shipped file's sha256 and size, and the model's **bounds** in its own frame, which the editor's panel shows as a size.
It takes the scene recipe's flags (`--raw`, `--no-cache`, `--stale-occlusion`, `--blender PATH`), and its caches are `.cache/model-bake/<model>/` and `.cache/model-encode/<model>/`.
Running Blender, optimising and checking what ships is `scripts/blendExport.ts`, shared with `just scene`, so a model is held to every check a scene is (every baked map encoded as one, every picture lossless).

In the editor, **`+ Model`** places a model with a click: into the selected body when one is selected, so selecting a lantern's body and clicking puts the lantern on it, otherwise as a body of its own.
It places the last model picked.
The model's panel offers the models exported here or published (`GET /api/models` on the dev server), and says how big the export is, when it was made and whether it is published.
The model draws in the 3D view and is picked by clicking it; on the plane it is a dashed cube mark with its name, and the depth handle and the gizmo's blue arrow move its `z`.
The gizmo's rings turn it about all three axes (the in-plane ring is `rot`, the other two its tilts) and any of its boxes scales it uniformly.

## How it is drawn

`BodyVisual.mountModels` (`render3d/bodyVisuals.ts`) puts a holder for each model object on the body's group, placed against the frame the visual is built in and carrying the depth, tilts and scale, and clones the loaded file into it.
The file is loaded once a page through the same loader a scene's is (`loadModelFile` in `render3d/sceneDressing.ts`), so the same rules apply to its meshes: ivy and plants cast leaf shadows, opaque meshes lay their depth first, pictures after.
A model already decoded is mounted on the spot, so an editor rebuild never draws a frame without it.
A model on a body that collides always casts, wherever it has been set back to, and one on a body that collides with nothing keeps the scenery's rule (behind the plane it casts nothing), as a dressing node does.
A body with a waking light drives the glow of its model's emissive materials, as it drives its dressing's.
A model answers a pick with its own object, so clicking it in the editor selects the model rather than its body.
The editor's scene toggle hides models with the scene: both are the look.
The glass ball's shards collide with a model like any other mesh its body draws, and the collision is rebuilt when a model lands.

## Publishing

`just publish` runs `assets:publish-models` (`scripts/publish-models.ts`): every model a registered level carries is uploaded to the asset release as `model-<model>.glb` when this machine's export differs from its pin, and pinned in `src/render3d/modelAssets.json` with its credits.
As a scene is, a model is REPLACED in place: the pin is what says which export a commit meant (`scripts/publishExports.ts`, shared with the scenes).
Its `.blend` is published as a source beside the scenes' (`scripts/sceneSources.ts`), since it is the only copy of how the model was made.
`assets:fetch` pulls the pinned models into `public/models/` and refuses a level carrying one the store does not hold; the build ships only the models some level carries (`exportsInBuild` in `vite.config.ts`).
`cli assets` checks the store holds exactly the models the levels carry, and `CREDITS.md` lists the credits inside them under "Inside Blender models".

## Not yet

- Unplayed: the pipeline was proved on a throwaway lantern through the editor and the game render path headlessly (2026-11-13); no level carries a model yet.
- Collision is not suggested from the model.
  A body's outline is traced by hand over the model drawn in the 3D view.
