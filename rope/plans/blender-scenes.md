# Blender scenes

Date: 2026-09-27.
Status: implemented 2026-09-27 (unplayed); the reference is [docs/blender-scenes.md](../docs/blender-scenes.md).

## Goal

Dress a level in Blender.
The owner models a level's look, foreground and backdrop alike, in one `.blend`, taking advantage of Blender's modelling, texturing and baking tools, and the loop is: edit the scene in Blender, run one `just` recipe, refresh the browser, see the level dressed.
The first target is the river level (`levels/ball.json`), whose reference is a misty cave of layered mossy ledges.

## Decisions

1. **Blender owns appearance and nothing else.**
   Collision stays authored in the editor, exactly as it is; a Blender edit cannot change how the ball rolls.
   Deriving outlines from the meshes was considered and rejected by the owner.
2. **Binding is by name, on both sides.**
   A body gets a stable `name`; a Blender object with the same name is that body's dressing.
   The level declares its scene once (`scene: "river"`), and every Blender object that matches no body is scenery.
   No geometry object, no key, no level write per Blender edit: the level file changes only when a body is named or the scene is set.
3. **Blender places the mesh in the world; the body carries it from there.**
   The exporter keeps every object's world transform, and the renderer mounts a bound node under its body's visual root at Blender pose minus the body's rest pose.
   A rigid body, a mover or a pivot takes its dressing with it, and moving a body in the editor moves its mesh.
4. **The exported file is one GLB per scene, nodes kept**, optimised through the pinned prop pipeline (meshopt, WebP at 1k, no simplification, no joining, no instancing).
   It lives under `public/scenes/<scene>/` beside a `meta.json`, gitignored, and is published to the release as `scene-<scene>.glb`, pinned by sha256 and size in `src/render3d/sceneAssets.json`.
   A scene is replaced in place on publish (the store's stated trade: deleting or replacing an asset breaks builds of old commits).
5. **A guide export goes the other way.**
   `just scene-guide <level>` writes the level's collision, extruded to its drawn depth, one object per body at the body's origin, into `<scene>-guide.blend`, and creates `<scene>.blend` linking that collection when there is none yet.
   Reopening the scene after a level edit shows the current colliders, so the dressing is always modelled against what the ball actually rolls on.
6. **What glTF cannot carry stays in the level or is baked.**
   Lights and cameras are dropped on export (the level's lights carry glow and beam semantics and a budget).
   Procedural materials export as flat colour; the exporter warns about every Base Color that is not an image texture.

## Delivery

- Format: `LevelBodyData.name`, `LevelData.scene`; both cross `scaleLevelData` untouched and round-trip through the editor.
- Renderer: `render3d/scenes.ts` (paths, manifest, meta types), `render3d/sceneDressing.ts` (load, bind, place), mounted by `Scene3D.setLevel`; `levelStoredFiles` names the scene file.
- Store: `sceneAssets.json`, `scripts/publish-scenes.ts` (in `just publish`), `storedAssets()` and `cli assets` cover scenes, `assets:fetch` pulls them.
- Dev server: `src/server/scenes.ts` serves `public/scenes/` uncached (the public handler only knows files its watcher has seen, and the directory is off the watcher).
- Blender: `tools/blender/scene_export.py`, `tools/blender/scene_guide.py`; bun wrappers `scripts/scene-export.ts`, `scripts/scene-guide.ts`; `just scene <level>`, `just scene-guide <level>`.
- Editor: the Level panel's `scene` field, the body panel's `name` field with the exported objects offered and the binding reported.
- Cases: `cli render3d` holds the format round trip, the preload list and the binding maths; `cli levels` holds body names unique.
