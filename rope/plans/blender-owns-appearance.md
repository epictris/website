# Blender owns appearance

Date: 2026-09-29.
Status: implemented 2026-09-29 (unplayed); the reference is [docs/blender-scenes.md](../docs/blender-scenes.md).
The sections after "As built" are the plan as approved, kept as written; where the build differs, "As built" is what is true.
Supersedes the "a body may still carry geometry objects, the two draw side by side" rule of [blender-scenes](blender-scenes.md).

## As built

- **The grey box is for levels with no scene only.** `ball.json` has a deliberate invisible wall (a collision-only static), which the planned "an undressed body draws grey in a dressed level" would have made visible; so a level with a scene draws the scene and nothing else of its bodies, and `just scene`'s report of names with no object is how a misspelt name is found.
  That also removed the planned asynchronous swap of the box for the dressing.
  The box is each collision piece of a non-area body extruded through that piece's own `thickness` (default `DEFAULT_THICKNESS`), filled with the body's `color`.
- **Water** kept only what a level authored: `waterZ` and `waterDepth` on the body (its tint was already the body's `color`).
  The water shader's `tileScale` and emission overrides, never authored, were removed rather than carried.
- **Belts** carry `BeltLook` (`width`, `texture`, `color`, `tileScale`) on the belt shape; the twin's tilt and lens were dropped.
- **The retired geometry objects are folded by the loader** (`withoutLook` in `normalizeLevelData`'s `finish`): the water and belt looks move, the objects go, and a body left with no objects is dropped (it built no engine body, so no build index moves).
  Every `levels/*.json` was then rewritten through that gate, which is step 4 of the export done for every level at once.
- **Waking glow survived.** A body with a waking light hands its dressing's emissive materials, copied per body, to the light rig when the scene lands (`BodyVisual.adoptDressing`), so the `+ Glow` bodies still brighten as the ball nears.
- **Shadows**: a dressing node on a body that collides always casts; one on a body that does not, and scenery, keep the behind-the-plane rule.
- **The export** was a headless page building each named body's `BodyVisual` (lights, water and belt bands left out) at its rest pose and running `GLTFExporter`, then a Blender script joining each body's meshes into one object named after the body with its origin on the rest pose.
  Bodies were named after their look (`moss-dark-3`, `boulder-2`, `finish-line-1`).
  Three things it had to fix on the way: the importer instances a mesh several bodies share, so each body's copy is made its own before it is moved; three's exporter names textures and never images, so images were named from their textures (`<set>-<slot>`, a prop's `<key>-<slot>`, `generated`) for the credit table; and a model's own credit rides the object as a `credits` custom property.
  The tool was not kept in the tree.
- **Fidelity**: `cli shot --3d` at 11 points along `ball` and `rails`, before against after, differed by 5 to 16,000 of 2,073,600 pixels at a 3% tolerance, all texture re-encoding and edge noise except the post's contact shadow on `rails` (the shadow rule above).
- **Lost**: the moss props' glow (the mask was a shader patch, so the moss arrived with its plain materials and no emission at all), the per-object orthographic lens (unused), and regenerating a boulder from its parameters in the editor.

## Goal

Blender owns every rendered mesh; the editor owns collision and nothing that is only a look.
A level's look lives in one `.blend`, foreground and backdrop alike, with no distinction between them: a mesh is a mesh, whether the ball rolls past it or it stands 40 m back in the fog.

## Decisions (Tris, 2026-09-29)

1. **All levels, not only dressed ones.**
   `GeometryObjectData` leaves the level format.
   A level that names a scene draws its Blender export; a level with no scene (the test levels) draws a **grey extrusion of its collision**, derived at build time and never authored.
2. **The current look is exported as-is.**
   A one-shot tool writes what the game draws today into the level's `.blend`, one object per body, named after the body, so the level looks the same on the day of the switch.
3. **`ball` keeps `river`.**
   Its foreground goes into `river.blend` beside the generated cavern.
4. **One file per level, foreground and backdrop together.**
   The "split a level into a foreground and a backdrop scene" release valve is dropped from the docs.

## What stays runtime-drawn

These are not static meshes: the sim drives them every frame, so Blender cannot own them.
They keep being drawn from level data, and the look fields they borrowed from a geometry object move onto the body.

- **Water**: `buildWater` reads `depth`, `z`, `color`, `tileScale`, `emissive`, `emissiveIntensity` off the body's first geometry object.
  These become water-body fields (`LevelBodyData.water*` or one `water: {...}` block), migrated by `normalizeLevelData`.
- **Belt tread and ring**: read the geometry object's `texture`, `tileScale`, `depth` (band width) and tilt.
  These become belt fields on the belt's collision object, where `speed` already lives.
- **Lights, fireflies, environment, fog, camera**: already not geometry objects; unchanged.
- **Vines, chains, the avatar, sparks, debris**: sim-driven, independent of geometry objects; unchanged.

## The grey extrusion

A body with collision and no Blender dressing draws its collision outlines extruded through `DEFAULT_THICKNESS`, centred on the plane, in one flat grey material.
It generalises what `BodyVisual` already does for a sim-spawned body (`spawnedGeometry`, bodyVisuals.ts:133).
In a level with no scene every colliding body draws it.
In a level with a scene, a body the scene dresses draws the dressing only, and a body it does not dress draws the grey extrusion - so a missing or misspelt name is visible, not an invisible wall.
An intentionally invisible body (a trigger, an invisible wall) is the areas and hook-only bodies that already draw nothing; nothing else is invisible.
Because dressing loads asynchronously, the extrusion is built at once and removed when the scene lands and binds the body, not the other way round (no frame of nothing).

The 2D renderer is unaffected apart from losing its decor layer (`render/decor.ts`): it already draws collision with the body's `color`.

## The export (one-shot migration)

`just scene-from-level <level>`, run once per level, then deleted with the rest of the geometry code.

1. **Name every body that draws.** Bodies without a `name` get a stable one (`<kind>-<index>`, or a readable one from the outliner where it has one), written into the level file before the export.
   `cli levels` already holds names unique.
2. **Render-side export.** A headless page (the shot runner's chromium) builds the level's `Scene3D` exactly as the game does and runs three.js `GLTFExporter` over each body's visual root, one node per body at its world pose, named after the body.
   Textures go out as images (`CanvasTexture` noise sets as PNG), tiling as `KHR_texture_transform`, tint as `baseColorFactor`, image planes as `KHR_materials_unlit`.
3. **Blender import.** Headless Blender imports that `.glb` into the scene's `Dressing` collection, replacing it (idempotent, like `import_into_river.py`), and saves.
4. **Strip the level.** The level's geometry objects are removed and the water and belt look fields moved onto the body in the same write.
5. `just scene <level>` exports as usual; `cli shot --3d` before and after at the start and along the route is the proof that nothing moved.

What an export cannot carry, and is lost unless re-authored in Blender:

- the moss props' glow mask and the waking-light emission it drives (`propGlow.ts`) - exported as a static emissive at most;
- the per-object orthographic lens (`projection.ts`; untried live);
- a generated boulder stays a mesh: it is no longer re-generable from its parameters in the editor (the formations add-on is the Blender-side way to make one).

Levels to export: `ball` (into `river.blend`) and `rails` (a new `rails.blend`), the two real, registered 3D levels with authored dressing.
Everything else (the sandboxes, `cave`, `testing`, `sawmill`, `scoop`, `LEVEL_2`, the `TEST_*` levels) goes grey.

## What is deleted

- **Format**: `GeometryObjectData`, `isGeometryObject`, `withGeometryPrimitives`, `primitiveOf`, `geometryFromLegacy`, `scaleGenerator`, the geometry fallthrough in `scaleObject` (becomes an explicit drop), `level/decor.ts`.
  `normalizeLevelData` drops geometry objects from any file it reads, so the 41 regression bundles that embed them keep loading.
  Body `color`/`opacity` stay (2D and debris read them).
- **Renderer**: `mountVisual` and its primitive/mesh/image branches, `surfaceOf`, `boulderDepth`, the rock taper, `images.ts`, `projection.ts`, `propGlow.ts`, `rocks.ts`, `generated.ts`, `render/decor.ts`, the geometry walks in `levelAssets.ts`.
  `extrude.ts` stays (the grey extrusion).
- **Editor**: the `geometry` item kind, `+ Geometry`, `+ Image`, `+ Rock`, `+ Mushrooms`, the generator loop and panel, match-collision, the rock-fit tools, the visual and placement inspector fields, geometry gizmo handles, the 2D decor pass.
  `+ Glow` becomes collision + light.
  The Visuals workspace stays as a free 3D view of collision, lights, cameras and fireflies against the exported scene.
- **Dev server**: `/api/generators`, `/api/generate`, `/generated/...`, `/api/images`, `generatedMeshesInBuild`.
- **Tools**: the mushrooms generator, `generate-rocks.ts`, `migrate-primitives.ts`, `rock-asset.ts --place`, `generators-check`, `rocks-check`, `silhouette`.
  The boulder generator stays: the formations add-on uses it.
- **Assets**: `generatedAssets.json` empties; `MESH_ASSETS`, `TEXTURE_ASSETS` and `IMAGE_ASSETS` entries whose only consumer was a level are pruned (they live on inside the `.blend` files and their published sources), and `cli assets` gains the rule it lacks today: a manifest entry nothing in code names is an orphan.
  Credits for pruned entries move to `tools/blender/image_credits.json` wherever the exported scene still carries their images.
- **Cases**: every `render3dCases` case about geometry objects goes; new cases below replace the ones that guarded behaviour that survives.

## New cases

- The grey extrusion: a colliding body with no scene draws exactly its collision outlines at `DEFAULT_THICKNESS`; a dressed body draws no extrusion once bound; an undressed body in a dressed level draws one.
- The format: a level with geometry objects loads with them dropped and its water/belt look moved onto the body; a save round-trips with none.
- Water and belt look fields round-trip and reach `buildWater` / the tread.
- `cli assets`: an orphaned manifest entry fails.
- The export: a scratch level of three bodies round-trips through `scene-from-level` into named Blender objects at the right poses.

## Order

1. Water and belt look onto the body (format + renderer + editor fields), levels migrated; nothing visible changes.
2. The export tool; run it for `ball` and `rails`; `just scene`; before/after shots.
3. The grey extrusion and the dressed/undressed rule in `BodyVisual`.
4. Delete geometry objects: format, renderer, editor, server, tools, assets, cases, docs, in that order, `bun run test` green at each step.
5. `just publish` (scenes, sources, pruned manifests) - Tris's upload, asked for first.

## Docs to rewrite

`blender-scenes.md` (binding, the release valve), `render3d.md`, `asset-store.md`, `level-format.md`, `editor.md`, `editor-model.md`, `editor-visuals.md`, `lighting-and-surfaces.md`, `conveyors.md`, `levels.md`, `pivot-and-spring-bodies.md`, `rock-assets.md`, and `CLAUDE.md` (the Running line, the asset rule, the index).
`generators.md` and `rocks.md` are deleted or kept as rejected history.
