# The editor owns the level

Written 2026-11-22 out of a design conversation with Tris, and rewritten the same day as a specification to implement from.
Built the same day, uncommitted and unplayed: how it works now is [docs/formations.md](../docs/formations.md), and section 0 says what stands and what is left.

## 0. Status (2026-11-22, end of the first implementation)

| Step | State | Proved by running |
|---|---|---|
| 1. Recipe to game asset | Done | `ball.json` body 5's outline generated, baked (3 tiers) and drawn in the editor and ▶ Test on its outline, the right way up; `scripts/test-formations.ts` holds the frames with an L |
| 2. Schema and job runner | Done; no warm Blender (below) | Two geometry jobs and a bake together, with progress, and a broken recipe failing with its reason while they finished |
| 3. Formations on collision | Done; the iteration look awaits Tris's judgement | Section 3.3 twice round in the editor, then ▶ Test with the ball resting on the fitted rock |
| 4. Boolean solid guides | Done | An arch by one difference built as all three variants; Wall fills the opening and the panel says so |
| 5. Decorations | Done | A fern, moss and ivy on one rock followed a 5 cm guide edit and a regenerate (the fern moved 7 mm, the painted ones regrown) and were flagged after a 6 m edit |
| 6. Migrate the river | Script done, `levels/ball-migrated.json` written; one body built | Not proved: the full generate and bake (about 40 rocks and 51 decorations, hours of GPU) waits for Tris's go-ahead, and `ball.json` is not touched |
| 7. The Assets tab | Done | `test-rock` made in the tab, accepted into the library, placed three times, one request for its `model.glb` |
| Finishing pass | Not started | |

Departures from the specification, each for a reason given in the doc:

- A formation has its own placement in its body, so an "origin to centre of mass" does not move its rock.
- `depth` is a generator parameter, not a field of the collision guide; guide pieces keep their collision fields for "Align collision to guide".
- An extrusion is along its own +z, turned by its pose, rather than along an `axis`.
- The paint is `levels/paint/<level>.json`: beside the level, a second `.json` would be offered as a level.
- Bundles are where the release keeps formations; the build unpacks only the file each one draws, and the game never fetches a bundle.
- The Assets tab is a third button that swaps what is edited (an asset document) while Level and Visuals stay the views of it.
- No warm Blender: a cold start is 0.3 s, about 0.6 s of a 1.5 to 35 s geometry job.
It replaces the direction of 2026-09-29 ([blender-owns-appearance](blender-owns-appearance.md)), whose only reason was that 3D editing in the editor did not seem worth building.
Tris now judges that cost minor against how cumbersome the Blender scene pipeline is.

How to read this file:

- **Sections 1 to 4** are the design, and every statement in them was agreed by Tris unless it is marked *proposed*.
- **Section 5** is what exists in the code today, with paths and line numbers as of commit `b91bcfd` plus the uncommitted tree of 2026-11-22.
  Line numbers drift; the names are what to search for.
- **Section 6** is the proposed data model and interfaces.
  Names may change in implementation; the meaning may not.
- **Section 7** is the work, step by step, each with what it must prove.
- **Section 8** is what has not been verified, and **section 9** the rules of the repository that apply.

## 1. Why

- A level is designed in Blender today and seen in the game only after `just scene`, which took 48 min 50 s for the river on 2026-11-22 (13 min 33 s of texture bake, 34 min 18 s of Cycles light bake).
- Every rock is baked as its own object at up to 4096, with nothing choosing how much of that a level loads.
  That day's river held 195 colour maps at 4096 and 193 normal maps at 2048: 16 GiB decoded, 21.4 GiB with mips.
  The browser tab died on load (the renderer ran out of memory decoding), and the 12 GiB card could not have held it either.
- The per-level bake carries everything that depends on placement (lightmaps, texels shared out by what the camera sees), so moving one rock invalidates most of an hour.

## 2. Goals, in Tris's words

- "I want to be able to move things around in my level editor and get immediate feedback on how it looks/feels to play."
- "Expensive texture bakes should be rare."
- "I'm expecting to have many objects in my level so it's also important that the level editor can be responsive and performant even with many objects."
- "The overall goal should be that I don't ever need to open blender unless i'm actually doing custom model editing."
- "The cost of implementing the right features is very low. The most important thing is that we're choosing the right features to implement."

## 3. The design

Blender becomes a headless backend the editor drives, and a workshop for hand-modelled assets.
The level editor is the only place a level is laid out.

### 3.1 Three kinds of drawn thing

| Kind | Made from | Belongs to | Regenerates in place | Reusable |
|---|---|---|---|---|
| Formation | A guide in the level | The level, on that guide's body | Yes | No |
| Decoration | Paint or a placement on generated geometry | The level | Follows its guide; regrows when painted | No |
| Library asset | A free guide in the Assets tab, or a hand-modelled `.blend` | The library | No | Yes |

### 3.2 Guides and formations

A guide is a shape in the level that geometry is generated from.
A formation is a recipe attached to one guide, 1:1, and its generated result.

- A **collision guide** is a stored copy of a body's collision pieces.
- A **background guide** is a 3D solid that collides with nothing, drawn as a wireframe in the editor and hidden in play.
- A formation belongs to a **body**, never to a single collision piece.
  For a collision guide it covers the union of the body's pieces by default, with the option to name a subset.
- The recipe (generator, parameters, variant, seed) is stored on the body in the level file.
- The result is level content in a per-level store, not a library asset.
- It is built in the body's own frame, so moving the body costs nothing and the formation rides a moving body.
- Generators follow the guide's type: a 2D outline offers Fitted slate and Boulders, a 3D solid offers Solid (boulder, cliff or wall variant).
- It is edited in place: selecting the body shows a Formation section in its panel.
  There is no workspace switch for a formation.

### 3.3 The collision guide workflow

The guide is a copy kept beside the collision, and the two are brought together only by buttons.

1. Define the collision outline.
2. **Generate**: the guide is taken from the collision, and the geometry is generated from the guide.
3. **Fit collision to geometry**: the collision is refitted to the rock that was actually generated, so the ball rolls on what is drawn.
   The result is ordinary collision whose vertices can be moved by hand afterwards.
4. When the shape itself has to change: **Align collision to guide** (the collision goes back to the guide exactly), then edit the collision.
5. **Align guide to collision**, and regenerate.

Step 4 is what stops drift.
The generated rock never matches its guide exactly, so a guide taken from a collision that was fitted to the rock would move a little further from the design with every regeneration.

Rules that follow:

- A formation is **stale** when its guide differs from the guide it was generated from.
  Editing the collision in step 3 stales nothing.
- The guide keeps the body's collision pieces as they were (shape and placement each), not only their union, so step 4 puts back exactly the pieces step 2 started from.
- The panel says whether the collision currently matches the guide.
  After step 3 it is expected not to; this is information, not a warning.

**Fit collision to geometry** in detail:

- It fits to where the rock meets the **play plane** (the body's plane, z = 0 in the body's frame), and nothing else.
- It takes an **accuracy**: the furthest the fitted outline may stray from the rock's section, as a distance.
  It is not a spacing between points.
  A looser accuracy gives fewer vertices, and the panel shows the vertex count as the accuracy is changed, before anything is applied.
- Where a body's pieces differ in their properties (one hook-proof, one muddy, different `passes`), each piece is fitted on its own.
  Where they are alike they are fitted as one outline.
- This amends the rule of 2026-09-27 (kept 2026-11-13) that collision is never derived from a mesh.
  What still holds: only this button, pressed in the editor, ever writes collision from geometry.
  No regenerate, bake or publish can change how the ball rolls.
- A fit changes the collision, so recordings made before it diverge, on purpose.

### 3.4 Background guides are boolean solids

A background guide is a non-destructive tree of union, difference and intersection over primitives, meshed live with manifold-3d.

- **Extruded outline**: a 2D outline pushed along any axis, with optional taper.
- **Convex hull of points**: a handful of points dragged in 3D, for leaning slabs, wedges and boulders.
- **Box and ellipsoid**: mainly cutters and fillers.
- **Imported mesh**: a fixed closed mesh as a leaf, placed, turned and scaled in the editor, reshaped only in Blender.

The Orthographic Studio's three-outline solid is a special case (the intersection of three extruded outlines, unioned with other parts), offered as a preset that builds that tree.
Difference is what a cave level wants: an arch or a tunnel is one subtraction.

Sculpting is left out on purpose, and not for its cost.
A guide carries only coarse form, and the generator replaces the surface on every regenerate, so sculpted detail would not survive.
If hull and taper prove not organic enough, the next step is smooth blending between parts, which stays parametric.

Box and extruded outline alone are not enough: every one of the river's backdrop solids is a shaped mesh (Tris).

### 3.5 Decorations

Moss, ivy, ferns, hanging vines, glow flora and mushrooms are all decorations, handled alike.
They are objects of the level and are not reusable: their shape depends on the geometry they sit on.

- They are painted or placed **in the context of the whole scene**, with the collision outlines drawn over the 3D geometry, from the free view and from the game camera's view.
  Foreground decoration is placed against the outlines, so the outlines stay visible while painting, including where a rock would hide them.
- A decoration records the **guide** it sits on (by the formation's id) and where: a point in the body's frame, the surface normal there, and its height off the surface.
  It is tied to the guide, which is stable, and never to the generated mesh, which a regenerate rearranges facet by facet.
- **Dragging** moves the anchor over the guide's surface, and each frame the decoration is projected onto the generated mesh and turned to its normal, so it never floats or sinks while it is moved.
  This must feel easy; it is the condition Tris put on the whole scheme.
- **After a regenerate** every anchor on that guide is projected the same way onto the new surface.
  A placed decoration (a fern, a mushroom, a vine's origin) only moves.
  A painted one (moss, an ivy carpet) has its strokes projected and is then regrown, as a job queued behind the rock's.
- An anchor that finds no surface within a tolerance, or moves further than one, is flagged for attention and left where it was.
  A large edit to a guide still means placing its decorations again; nothing avoids that.
- Keeping guides small limits how much one edit disturbs, but adds seams between rocks, so it is a habit and not the mechanism.
- **Texture-only moss** becomes a thin shell that follows the rock, with its own texture, instead of paint in the rock's colour map.
- Paint strokes live in a **sidecar file** beside the level, not in the level JSON.

### 3.6 The Assets tab

A third workspace, for making **reusable** assets from free 2D or 3D guides: edit a guide, choose a generator and its parameters, preview, accept and bake.
A library asset is placed any number of times through the existing `model` object.
Geometry generated from a level's own guides is never offered here, and moss and ivy never are.
Hand-modelled assets (the lantern, the minecart) stay as they are, one `.blend` each through `just model`.

### 3.7 Two looks: iteration and finish

Iteration must be immediate, so everything expensive moves to a finishing pass run on a level that is otherwise done.

| | While iterating | Finishing pass |
|---|---|---|
| Rock colour | A game-side material that approximates the slate, or a faster bake (below) | The full baked textures |
| Light from emissive geometry | Point and spot lights that approximate it | Baked (Cycles), as today |
| Ambient occlusion between neighbours | None | Baked |

- **Colour is still baked** for the finished level.
  The work is to make that bake fast (the Blender slate shader is the cost), or to reproduce the surface without a Blender shader.
  If the game-side version cannot be made close enough to replace the bake, it is the iteration look and the full textures are baked only in the finishing pass.
- **Emissive light** is baked in the finishing pass because three.js cannot light a scene from emissive geometry.
  For realtime feedback it is approximated with point or spot lights; 80 to 90 % of the baked result is enough.
- **Ambient occlusion** is important in the finished level and unnecessary for judging how a level feels.

### 3.8 Level of detail

- Formations do not share maps, by design (they are 1:1 with guides), so texture memory is held down by LOD and not by sharing.
- Each formation's bake keeps several tiers, and the editor sets, per formation, the tier the game loads.
- The default is automatic, from the guide's depth behind the play plane.
- This is what makes the river loadable again; nothing else is planned for that.

### 3.9 Versioning

- A result is a pinned artifact, and it is the truth.
  Its recipe is how to make another, not a promise of the same bytes.
- Each result records the fingerprint of the generator code that built it.
- A change to generator code stales nothing.
  The editor marks a result "built by an older generator" and offers Regenerate, one at a time or all, as a deliberate act.
- The recipe's version is bumped only when a parameter changes meaning, with the old meaning kept readable.

### 3.10 Storing and publishing

- **While editing**: loose files named by content hash, in a local folder the dev server serves.
  Regenerating one formation rewrites one file.
- **Published**: a few bundles per level, split by region, packed by `just publish` and pinned like every other asset.
  Contents keep their hash names inside a bundle, so a collaborator unpacks one back into the loose folder and carries on editing.
- **Recipes** are small and live in the level file.
- **Paint strokes** are large and live in the sidecar.

### 3.11 The job runner

Generation and baking are jobs the dev server runs against headless Blender.
The editor shows every job in progress, with a progress bar wherever one is possible, and surfaces errors clearly.
Regeneration speed is the feature: reshaping a guide must come back as fast as it can be made to.

### 3.12 What goes away

- The per-level Blender scene and `just scene`, once the river is migrated.
- The Game add-on, the pool, and Blender's copies of the game's lighting, fog and depth of field.
  They exist only to imitate the game inside Blender.
- Texels shared out by what the game camera sees; everything is baked all-round.
- The migration regenerates the river's rocks from their recipes.
  That they will not be the same rocks is accepted.

## 4. Left for later, deliberately

- Instancing, GPU-compressed textures (KTX2) and runtime LOD switching.
  Add each when a measurement says the editor or the card needs it.
- Mesh touch-ups from the add-on: Tone Facets, slate Repaint, Keep As Manual Mesh.
- Smooth blending between solid parts.
- A hint that a decoration's surfaces changed without a regenerate.

## 5. What exists today

Paths are under `rope/` unless they start with `3d/`.

### 5.1 Level format (`src/level/levelFormat.ts`)

- On disk a level is in pixels; `PIXELS_PER_METER = 100` (`src/engine/units.ts:15`).
  Load is `scaleLevelData(data, PX)`, save is `scaleLevelData(toLevelData(model), PIXELS_PER_METER)` (`src/editor/model.ts:2766-2772`).
  Angles, ratios and a model's `scale` are not scaled.
- `ShapeData` (:349): `rect {w,h}`, `circle {r}`, `poly {verts:{x,y}[]}`, `curve`, `belt`.
  A `poly` is a simple loop in the object's local frame.
- `ObjectPlacement` (:465) is `{x?, y?, rot?}`.
- `CollisionObjectData` (:479-636): `type:"collision"`, `shape`, `impermeable` (hook-proof), `passes` (which of `"player"|"hook"|"chain"` pass through), `rail`, `viscosity`, `slipFloor`, `material`, `soundMaterial`, `density`, `thickness`, `debug`, `root`.
  These are the properties that decide whether two pieces "differ" for the fit.
- `ModelObjectData` (:954): `{type:"model", model, z?, rotX?, rotY?, scale?}` on `ObjectPlacement`.
- `SceneObjectData` (:970) is the union of collision, light, anchor and model objects; a body's `objects` holds them.
- `LevelBodyData` (:972-1361) has `kind`, `name?`, `x`, `y`, `rot`, many physics fields, and `objects`.
- `LevelData` (:2466) has `bodies`, `scene?`, `format?` and the rest; `LEVEL_FORMAT = 2`.
- **Bodies and objects have no stable id.**
  A body is its array index plus an optional unique `name` (what binds it to a Blender node).
  The editor mints ids per session (`newBodyId`, `src/editor/model.ts:1030`) that are never written.
  Formations and decorations need ids that survive a save, so this plan adds them (section 6).
- **`scaleLevelData` (:3407) rebuilds every field explicitly, and a field it does not list is silently dropped.**
  Objects go through `scaleObject` (:3285), which ends `return o satisfies never`, so a new object type fails the typecheck until it is handled; a new body field does not.
- Everything retired is folded in by `normalizeLevelData` (:2734), inside `scaleLevelData`.

Where a new object type or body field has to be registered, found by following `model`:

- `levelFormat.ts`: the interface, the `SceneObjectData` union, a guard beside `isModelObject` (:1382), the `scaleObject` branch (:3349), the body field list in `scaleLevelData` (about :3721-3815).
- `src/level/levelLint.ts`: `runLevelChecks` (:82), the model check at :161-175; run by `cli levels`.
- `src/editor/model.ts`: the `EdObject` union (:187), `fromLevelData` (model branch :1521), `toLevelData` (:2169, model branch :2362), `bodyLabel` and `objectLabel` (:3638, :3658), `flipItemsH` (:4167).
- `src/editor/editor.ts`: the `Tool` union (:393), `LAYER_TOOLS` (:415), `TOOL_WORKSPACES` (:439), undo `snapshot` (:1111), the gizmo (:1521-1599), the inspector `PANELS` (:8283) and its dispatch (:8329), `cloneBodies` (:8350), hit testing (:10849), `sceneKeyOf` (:1989), which decides when the 3D scene rebuilds.
- `src/editor/render.ts`: `hasDepth` and `setDepth` (:190-202), the marks (:2719).
- `src/render3d/bodyVisuals.ts`: `mountModels` (:495-544); `src/render3d/levelAssets.ts:79`.
- `src/sim/render3dCases.ts:2690-2780`: the scale and disk round trips.

### 5.2 The editor (`src/editor/`)

- `editor.ts` is one 12,651-line file; `startEditor` is at :708.
- **Workspaces**: `type Workspace = "level" | "visuals"` (:2549), `setWorkspace` (:3063), the W key (:11900), restore from the URL (:12376, `viewUrl.ts`).
  There is no registry: a third workspace touches the type, the switcher, `setWorkspace`, the key, `TOOL_WORKSPACES`/`toolOffered` (:3459), `inScene`/`sceneShown` (:745-748) and `viewUrl.ts`.
- **Inspector**: `buildInspector` (:8174); the body panel is `buildBodyPanel` (:5910) with `addBodyProps` (:5641); the model panel is `buildModelsGroup` (:7586); widgets `section`, `numField`, `fieldRow`, `describe` (`panelUi.ts`).
- **Vertex editing**: `setPolyVerts` (`model.ts:3081`, rejects a non-simple loop), `grabVertex`, `pressVertex`, `pressMidpoint` (`editor.ts:9828-9891`), the `polyVertex` drag (:11410).
- **Autosave**: 750 ms after any edit (`scheduleAutosave`, :9705), `PUT /api/levels/<name>`.
  An open editor tab is a second author of a level file.
- **Undo**: whole-model snapshots, 50 deep (`snapshot`, :1111; `beginAction`, :1165).
  Whatever a formation or decoration adds to the model must be cloned there.
- **Visuals workspace** (`visuals/`): `Scene3D.pick` and `pickSurface` (`src/render3d/scene.ts:1180`, :1229) raycast the scene and return a point and world normal; `surfacePlacement` (`visuals/surfaceDrop.ts:21`) drops a light on a surface; `Guides` (`visuals/guides.ts:323`) draws collision outlines as fat lines with the depth test off.
  **It cannot view through the game camera**: Home gives the 2D camera through the level's lens, and only ▶ Test uses the real `CameraController`.
- **No editor UI test suite exists.**
  Headless coverage is model-level: disk round trips in `src/sim/*Cases.ts`, and the `editor:` and `visuals:` cases of `cli render3d`.
  The only CDP code in the repository is `class CDP` in `src/tools/shotRunner.ts:376`.

### 5.3 The dev server

- Routes are vite plugins: `configureServer(server){ server.middlewares.use(PATH, handler) }`, in `src/server/*.ts`, listed in `vite.config.ts:582-593`.
- `levelApi()` (`vite.config.ts:144`): `GET /api/levels`, `GET/PUT/DELETE /api/levels/<name>`.
- `sceneService()` (`src/server/scenes.ts:51`): `/scenes/<scene>/…`, `/models/<model>/…` with `Cache-Control: no-store`, and `GET /api/models`.
- **No background-job mechanism exists**: no EventSource, no WebSocket, no queue.
  The retired generator service of 2026-09-25 to 09-29 had jobs keyed by input hash; it is in git history at `bfa6597` (`docs/generators.md`).
- `scripts/stepProgress.ts` (`StepProgress`: `start`, `note`, `skip`, `log`, `finish`, `fail`) prints progress for a command line only.

### 5.4 The game's loading (`src/render3d/`)

- `sceneDressing.ts`: one decoded file per URL for the page (`files`, :228); `mountExport` is `loaded.clone(true)`, so **geometry and materials are shared across placements**, not copied.
  `loadExportFile` (:261-363) is the one loader for scene and model exports and applies every per-material rule (lightmaps, ivy, moss, foliage, glow flora, pictures, the depth prepass).
- `gltfLoader()` (`assets.ts:1294`): meshopt, and WebP and AVIF through GLTFLoader's own extensions.
  **There is no KTX2, no texture budget, no size clamp at load, and no LOD of any kind.**
  Sizes are decided only when a file is encoded.
- `bakedLighting.ts`: a material with `userData.gameBakedLighting` has its emissive map moved to a lightmap (`restoreLightmap`, :71); a scene's probe field lights every other material (`useBakedLighting`, :200).
  Only a scene carries a field; models receive the level's.
- **Lights** (`lights.ts`): a `LightObjectData` (`levelFormat.ts:725-898`, `kind: "point"|"spot"`, `color`, `intensity` in candela, `range`, `angle`, `castShadow`, waking fields) in a body's `objects` is the only way a light reaches the game.
  `LIGHT_BUDGET = 16` and `LIGHT_SHADOW_BUDGET = 4` (:153-158), spent in authored order.
  **The light count must stay constant during play**, because programs are keyed on it (:57-63).
  A light is shaded only where it reaches (`lightReach.ts`), so range drives cost.
- Generated emission proxy lights existed once and were retired (their generator went in commit `8d410aa`; `scene_export.py:118` still skips `game.emission-light.*`).
  Read `docs/lighting-and-surfaces.md:65-72` and `docs/blender-scenes.md:164-166` for why before building them again.

### 5.5 The asset store

- A manifest entry is `{sha256, bytes, credits}` (`sceneAssets.json`, `modelAssets.json`); release names are `scene-<s>.glb`, `model-<m>.glb`.
- `scripts/publishExports.ts` (`publishExports`, :72) uploads with `gh release upload assets … --clobber` to `epictris/website`, tag `assets` (`scripts/assetStore.ts:38`), and writes the pin.
- `just publish` runs `assets:publish-scenes`, `assets:publish-models`, `assets:publish-sources`, `roots:bake`, `assets:publish-stored`.
- `cli assets` (`src/tools/assetBudget.ts`) fails on a missing, stale, orphaned or undrawn asset and holds budgets: 100 MiB in all (:95), 8 MiB a file with scenes exempt (:101).
  The river's pin alone is 157 MB, and `public/models` is not among `ASSET_DIRS` (:71-80); check how `cli assets` stands before adding a third kind.
- The inlined store and the loading bar are described in `docs/loading-screen.md`.

### 5.6 The export flow (`scripts/`)

- `blendExport.ts`: `exportBlend(opts: BlendExport)` runs `blender -b <blend> --factory-startup --python tools/blender/scene_export.py -- raw.gltf meta.json [--all-seen] [--cache …]`, then `optimize-asset.ts … --keep-nodes --keep-hierarchy --baked-maps`, then its checks, and ships one `.glb`.
  `BlendExport.kind` is `"scene" | "model"` and names the caches under `.cache/<kind>-bake/<name>` and `.cache/<kind>-encode/<name>`.
  Environment: `SCENE_EXPORT_EMISSION` (`"1"` for scenes), `SCENE_EXPORT_DOF`, `SCENE_EXPORT_DYNAMIC`, `SCENE_EXPORT_RESUME_DIR`.
- Since 2026-11-22 Blender writes a `.gltf` beside its `.bin` and `textures/`, and nothing reads a file over 2 GiB whole (`scripts/gltfFile.ts`, `docs/blender-scenes.md`).
- `encode-textures.mjs` picks an encoding by image name: `… baked light` lossless WebP; `… baked colour` and `… baked normal` AVIF 4:4:4 up to 4096; `foliage-atlas` and `.moss` WebP at 2048; `… picture` lossless AVIF; everything else WebP at 1024.
- `model-export.ts` is the thin caller for a model: `allSeen: true`, and it writes `ModelMeta` with the union of the nodes' bounds.

### 5.7 Generators (`tools/blender/formations/`)

- **`worker.py` already builds a rock from a bare recipe, with no scene** (verified 2026-11-22):
  `rope/.venv/bin/python tools/blender/formations/worker.py recipe.json OUT_DIR --blender blender`.
  It writes `OUT_DIR/recipe.json` (resolved, with `generatorHash`), runs `assemble.py` in a headless Blender, and leaves `OUT_DIR/rock.blend` and `health.json`.
- Recipe, outline generators: `{generator: "boulders" | "fitted", outline: [[x,z],…], params: {depth, …}, preset?, version}`.
  The outline is in the rock's local X/Z plane, in metres, z up.
- Recipe, solid generator: `{generator: "solid", guide: {verts: [[x,y,z],…], faces: [[i,j,k,…],…]}, variant: "boulder" | "cliff" | "wall", params}`.
  The guide must be a closed mesh; `build_from_recipe` welds it at 1e-5 and raises if it is open (`solidfit.py:1345`).
- Defaults are `worker.GENERATORS` (:74).
  Boulders: `seed 31, slabsPerArea 10, faceBudget 3000, detail 1, voxelCap .012, weathering .38, edgeBevelWidth .0002, slabWidth 1.5015, slabLength .434`.
  Fitted: `seed 31, smallestRock 0.25, largestRock 3.0`.
  Solid: `seed 0, stoneSize 1.0, knub 0.3, curveTurn 60, surfaceRelief 0.5, jointed true, jointAspect 2.8, wall false`.
- `rock.blend` holds one mesh object, `SceneryRock`, with the recipe in its `formation_recipe` property, one procedural material ("Painted slate", `slate.painted_slate()`), and a per-face float attribute `facet`.
- **Parameter metadata is in `params.py`**: `FIELDS` (:28) maps each generator's recipe keys to properties in panel order, and `FormationParams` (:52) declares each with name, description, default, min and max.
  `draw()` (:117) holds the rules for which fields show.
  This is what the schema is exported from.
- `worker.fingerprint()` (:121) hashes the worker, the generators and the native sources; it is the `generatorHash` of section 3.9.
- "New Variant" (`ops.py:114`) builds again from the same fields and does **not** change the seed.
- Measured 2026-11-22 on the terrace preset (3.3 x 7 m), geometry only, a cold Blender each: boulders 9.95 s (297,205 faces after the bevel), fitted slate 4.24 s.

### 5.8 Baking (`tools/blender/`)

Two bakes exist, and the game understands only the first.

- **The export's** (`scene_export.py`, `bake_procedural_textures`, :1417): per object, an unwrap with a native packer, a Cycles `DIFFUSE` colour pass, a detail normal map cast natively from a crumpled high poly (`formations/detail.py`, no Cycles), a `NORMAL` pass.
  It ships `<object> baked colour` and `<object> baked normal` and no roughness or occlusion map.
  Sizes come from `formations/render.py`: `TEXELS_PER_METRE = 512`, `BAKE_SIZE_MAX = 4096`, `NORMAL_SCALE = 0.5`, per-object limits `export_map_max`, `export_texels`, `export_maps`.
  `--all-seen` makes `seen_faces` (:450) count every face.
  Recorded for one rock in one worker (Terrace.012, `plans/scene-export-speed.md`): 108 s, of which Cycles 47 s, detail 30 s, unwrap 10 s, fill 8 s.
- **The representations'** (`formations/asset_export.py`, `derive(mesh, config, directory)`, :233): `FULL`, `REDUCED` (Decimate to a ratio, new UVs) or `SURFACE` (two triangles), baking `base_color`, `normal`, `roughness` and `ao` PNGs with Cycles on the CPU at 16 samples.
  It makes its own scene, so it runs on a lone mesh.
  Its cache is `.formation-cache/<hash>/`.
- **The slate** (`formations/slate.py`, `paint`, :215) is a procedural node tree in object space: a noise drift between `#2f3546` and `#3b3e4a`, the `facet` attribute mapped to 0.92 to 1.08, grain and stain noise, ambient occlusion at 0.5 m and 0.06 m, an edge line from a bevel node (radius 0.03) mixed toward `#5c6070`, a shading bevel into the normal, roughness 1, specular 0.1.
  The two bevel nodes and the occlusion are what cannot be evaluated outside Cycles.
- **Lighting** (`emission_bake.py`, `bake`, :424): emitters are meshes whose material emits; strength is multiplied by 50; each receiver gets a lightmap (UV `GameLightmap`, log1p encoded) and the scene gets a probe field clipped to the camera's footprint.
  What is known of an emitter, for a proxy light: its world matrix and bounds, its mesh area, its emission colour and strength, and for glow flora the `_GLOW` vertex attribute.

### 5.9 Decorations (`tools/blender/moss`, `ivy`, `foliage`, `mushrooms`)

- **Moss**: `moss.ops.rebuild(ob)` to `build.grow(co, tri, host_matrix, stamps, p)` (`build.py:561`) and `build.finish` (:1060).
  Its inputs are the hosts' evaluated world triangles and the stamps.
  Stamps are a face-less mesh with point attributes `stamp_normal`, `stamp_radius`, `stamp_strength`, in the host's frame (`stampbrush/stamps.py`).
  Output is `<rock>.moss` with its own material and a printed image.
  1 to 25 s a build, up to 53 s.
- **Ivy**: `ivy.ops.build_job(ob)` to `build.build(co, tri, host_matrix, stamps, vines, origin, p)` (`build.py:453`); vines are arrow empties, the origin an empty.
  Output is `<rock>.ivy` and `<rock>.ivy.shadow` on a shared atlas.
  About 3.7 s for 59k triangles.
- **Foliage** (ferns, hanging vines, mushrooms, orbs, glow flora): `foliage.ops.rebuild(ob, depsgraph, surfaces, everyone)` (`ops.py:174`), from the host's world triangles and the plant's own transform.
  0.02 to 2 s.
- **Mushroom patches** (`mushrooms/mushroom_patch_tools.py`) are a geometry-nodes add-on of their own, not hosted on a rock and not called by the export.
- **Three things in them depend on the scene and have to be given explicitly**:
  detail is coarsened by world depth and the game camera's lens (`stampbrush/lod.budget`, `scene_slope`, reading `guide.camera`);
  glow flora faces the game camera;
  a plant avoids the plants before it (`avoid_for`).
- Each runs headless and needs, in the file, the host mesh, its paint mesh and its empties.

### 5.10 The solid core (`3d/orthographic/src/core/`)

- `manifold.ts` loads manifold-3d with a top-level await; importers then use it synchronously.
- `mesher.ts`: `buildSolid(outlines)`, `objectSolid(parts)` (:100, in the object's unit box; the caller scales it and must `delete()` it), `buildMesh(parts, size)`, `unionRings`.
- The core is DOM-free; its only outside imports are `manifold-3d` and `ajv`.
  `rope/scripts/ortho-solids.ts` already imports it by relative path, and the packages resolve from `3d/node_modules`.

## 6. Data model and interfaces (proposed)

Every type here is *proposed*.
On disk, lengths are pixels like the rest of a level; in memory, metres.

### 6.1 In the level file

```ts
// On LevelBodyData. A body has at most one formation.
interface FormationData {
  // Stable for the life of the formation, written to disk, unique in the level.
  id: string;
  generator: "boulders" | "fitted" | "solid";
  variant?: "boulder" | "cliff" | "wall";   // solid only
  params: Record<string, number | boolean>; // the generator's, by recipe key
  // The guide the next Generate will use.
  guide: CollisionGuide | SolidGuide;
  // Which tier the game loads: "auto" is from depth.
  lod?: "auto" | number;
  // What is drawn now. Absent until the first Generate lands.
  built?: {
    // sha256 of the resolved recipe (generator, variant, params, guide), which names the files in the store.
    hash: string;
    generatorHash: string;
    recipeVersion: number;
    // The tiers the store holds for this hash, best first.
    tiers: FormationTier[];
  };
}

// A copy of the body's collision pieces as they were when the guide was taken.
interface CollisionGuide {
  kind: "collision";
  pieces: { shape: ShapeData; x?: number; y?: number; rot?: number }[];
  // Indices into the body's collision objects it was taken from; absent means all.
  subset?: number[];
  depth?: number; // the rock's thickness, the generators' `depth`
}

interface SolidGuide { kind: "solid"; tree: SolidNode; }

type SolidNode =
  | { op: "union" | "difference" | "intersection"; of: SolidNode[] }
  | ({ prim: "extrude"; outline: { x: number; y: number }[]; axis: [number, number, number]; length: number; taper?: number } & Pose)
  | ({ prim: "hull"; points: [number, number, number][] } & Pose)
  | ({ prim: "box" | "ellipsoid"; size: [number, number, number] } & Pose)
  | ({ prim: "mesh"; file: string } & Pose); // a content-hash name in the store

interface Pose { pos?: [number, number, number]; rot?: [number, number, number]; scale?: [number, number, number]; }

interface FormationTier { triangles: number; colour: number; normal: number; bytes: number; }
```

- A formation is **stale** when `sha256(resolved recipe now) !== built.hash`.
- A background guide is a body with no collision objects whose formation has a `SolidGuide`.
  (A body made only of visuals already builds no engine body.)
- Decorations are objects in a body's `objects`, of a new `type: "decoration"`, holding their kind, settings, seed, the `formation` id they sit on, and their anchor.
  A painted one names its strokes in the sidecar by its own id.
- A level names nothing else: there is no `scene` once it is migrated.

### 6.2 The sidecar

`levels/<level>.paint.json`: text, diffable, one entry per painted decoration's id, each a list of stamps `{p: [x,y,z], n: [x,y,z], r, s}` in the body's frame (the stamp attributes the add-ons already use).
The dev API reads and writes it beside the level, and autosave covers it.

### 6.3 The store

- Local: `public/generated/<hash>/` holding `geometry.glb` (the unbaked rock for the iteration look), `tier-<n>.glb` (each self-contained: its mesh and its maps), `meta.json` (the resolved recipe, `generatorHash`, triangle counts, bounds, the play-plane section as a polyline for the fit, times).
  Served by a dev route with `no-store`, as `/scenes/` is.
- Published: `level-<level>-<region>.glb` bundles pinned in a new manifest beside `sceneAssets.json`, each node named by its hash.
- A hash nothing in any level names is garbage and is removed by a sweep, never by a save.

### 6.4 Jobs

- `POST /api/jobs` with `{kind: "geometry" | "bake" | "decoration" | "fit-section", …}` returns a job id; `GET /api/jobs` is a server-sent event stream of every job's state `{id, kind, label, state: "queued" | "running" | "done" | "failed" | "cancelled", progress?: number, step?: string, error?: string, log: string}`; `DELETE /api/jobs/<id>` cancels.
- A job is keyed by the hash it will produce: asking for one that is running joins it, and one whose result is in the store returns at once.
- The runner keeps a warm headless Blender for geometry jobs.
  Bakes use the GPU; no more than one bake runs at a time, and none starts while ▶ Test is running unless asked, because the game is on the same card.
- Progress comes from the `[scene_step]` lines `scene_export.py` already prints, and the same convention added to `worker.py` and `assemble.py`.
- An error carries the last lines of Blender's output and the path of the whole log.

### 6.5 Coordinates

- A level's y runs down; a recipe's outline is in the rock's X/Z plane with z up, in metres.
  The game's (x, y, z) is Blender's (x, -z, y) (`tools/blender/scene_guide.py:76`).
- So a collision vertex `(x, y)` in pixels in the body's frame is the outline point `[x / 100, -y / 100]`.
  Hold this with a test that generates from an asymmetric outline and checks the result's bounds in the game's frame; it is the kind of thing that is wrong by a sign for a week.

## 7. Steps

Each step ends with the game or the editor doing something that can be looked at, and with its doc written.
A step is not done until what it must prove has been proved by running it.

### Step 1. Recipe to game asset, from the command line

Build `scripts/formation-build.ts` (`bun run formation:build <recipe.json> [--bake]`).

- Resolve the recipe, hash it, and run `formations/worker.py` into a scratch directory.
- Geometry path: a new `tools/blender/formation_export.py` opens `rock.blend` and writes `geometry.glb`: the mesh within a triangle budget, with the `facet` attribute exported (custom attributes must be named with a leading underscore to survive the glTF exporter, as glow flora's are), and the play-plane section in `meta.json`.
- Bake path (`--bake`): take `rock.blend` through `exportBlend` with a third `kind`, `"formation"`, and `allSeen: true`, then derive the lower tiers.
  Every tier is capped: colour at most 2048 and normal at most 1024 unless the recipe says otherwise, so no bake can rebuild the 16 GiB scene by accident.
- Write the results into `public/generated/<hash>/`.

It must prove:

- One of the river's `Cube*` bodies, its outline taken from `levels/ball.json`, generates, bakes and draws in the game in the right place and the right way up (section 6.5), placed by hand for now.
- The times of the geometry path and the bake path, per stage, written into this file.
- The first unknown of section 8 that bites.

### Step 2. The schema and the job runner

- `tools/blender/formations/schema_export.py`: writes the generators' parameters (key, label, description, type, default, min, max, the order and the visibility rules of `params.draw`) as JSON, from `params.FIELDS` and `FormationParams`.
  A Blender test holds it to the add-on: every recipe key of `worker.GENERATORS` is in it with the same default.
- `src/server/jobs.ts`: the runner of section 6.4, registered in `vite.config.ts`.
- A jobs panel in the editor: every job, its bar, its step, and a failed job's error with its log a click away.

It must prove: two geometry jobs and a bake asked for together run, show progress, and one made to fail (a recipe with an open guide) shows why without taking the others down.

### Step 3. Formations on collision outlines

- The format: `formation` on a body, registered everywhere section 5.1 lists, with its round trips.
- The Formation section of the body panel, built from the schema: generator, parameters, **Generate / Regenerate** (marked while stale), the tier in use, the generator-version mark.
- The three buttons of section 3.3, each one undo step.
- The fit: section the tier-0 mesh at the play plane (the section is in `meta.json`), simplify it within the accuracy (a tolerance-bounded simplification such as Ramer-Douglas-Peucker), show the vertex count live, write `poly` pieces through `setPolyVerts`.
- Drawing: `BodyVisual` mounts the formation's chosen tier, or `geometry.glb` in the iteration look while no bake exists, through the loader models already use.
- The iteration look: a game-side slate material (section 3.7), judged against the bake by Tris on one rock before it is relied on.
- `cli levels` checks every formation's id is unique and its `built.hash` is in the store.

It must prove: in the editor, on a new body, the whole of section 3.3 from step 1 to step 5, twice round, without leaving the editor, and ▶ Test rolling the ball on the fitted collision.

### Step 4. Boolean solid guides

- Import the solid core from `3d/orthographic/src/core` (do not copy it), and add the primitives of section 3.4 that it lacks: an extrusion along any axis with taper, the hull, the box and ellipsoid, the imported mesh.
- Editing in the Visuals workspace: the tree in the panel, a gizmo on the selected node (the one models use), outline editing in the plane of an extrusion, the three-outline preset.
- The guide is meshed live on every edit and drawn as a wireframe; Generate sends its mesh as the solid recipe's `guide`.
- Default tier from depth behind the play plane.

It must prove: an arch made by one difference generates as each solid variant, or fails with a reason the panel shows (the second unknown of section 8).

### Step 5. Decorations

- The format and the sidecar (sections 6.1, 6.2).
- Headless growth: one Blender entry point per kind that is handed the host triangles (the formation's geometry in the body's frame), the stamps or the placement, the settings, and **explicitly** the depth, the lens and the camera direction the add-ons read from the scene today (section 5.9).
- The brush in the Visuals workspace: paint and erase onto generated geometry through `pickSurface`, with the collision outlines drawn over everything.
- A view through the game camera in the Visuals workspace, which does not exist yet (section 5.2).
- Anchors, dragging along the guide with live projection, projection after a regenerate, the flag for an anchor that lost its surface.
- The thin shell for texture-only moss.

It must prove: moss, ivy and a fern on one rock survive a small edit to its guide and a regenerate without being touched, and a deliberately large edit flags them instead of moving them somewhere wrong.

### Step 6. Migrate the river

- A one-off script reads `assets-src/scenes/river.blend`: each formation's `formation_recipe` becomes a `formation` on its body, each backdrop solid's guide an imported-mesh leaf, each moss and ivy's stamps a decoration and a sidecar entry.
- Regenerate and bake everything as jobs (a couple of hours in the background; about 290 objects).
- Remove `scene` from `levels/ball.json`, and retire `just scene` for it.

It must prove: the river loads in the browser at its automatic tiers within a stated texture budget (measure what the tab holds; the 16 GiB scene is the failure to beat), and plays.

### Step 7. The Assets tab

- The third workspace (section 5.2 lists what it touches): a free guide, 2D or 3D, the same Formation panel, preview, accept and bake into the model library, pinned as models are.
- Placing what it makes with `+ Model`.

It must prove: one asset made there is placed three times in a level and draws from one file.

### After the steps: the finishing pass

- Proxy lights for emissive geometry while iterating (section 3.7), within the light budget and its constant count (section 5.4).
- The finishing pass itself: the full colour bake if the iteration look did not replace it, the Cycles light bake over the placed level, ambient occlusion between neighbours.
  This is today's per-level bake, run rarely and on purpose.

## 8. Not yet verified

Check each at the start of the step that depends on it, before building on it.

1. **Triangle counts.**
   The boulder master was 297,205 faces for one 3.3 x 7 m rock.
   What the geometry path and tier 0 should carry, and whether Decimate keeps the silhouette at that budget, is unmeasured (step 1).
   *Measured:* the geometry path carries at most 150,000 triangles (Decimate, collapse); an 8 m fitted outline came to 239,656 and was decimated to it.
   Tier 0 is the full mesh with its creases bowed (10,570 for `ball.json` body 5's boulders, 16,538 for Terrace.003); lower tiers are a quarter each.
   Whether the silhouette holds at the budget is not judged: no rock large enough has been looked at decimated.
2. **Hollow and concave solid guides.**
   Whether the solid generator fits stones sensibly to a guide with a tunnel through it is unknown; `tools/blender/test_solid_concavity.py` exists, so some handling does (step 4).
   *Measured:* an arch (a box less a box) keeps its opening as Boulder, keeps a blocky one as Cliff, and is filled by Wall (100% of the opening); the geometry stage measures it and warns.
3. **Regeneration time with a warm Blender.**
   The 9.95 s and 4.24 s include starting Blender; how much a warm one saves is unmeasured (step 2).
   *Measured:* a cold `blender -b --factory-startup` is 0.3 s, two of them a job; not worth a long-lived process.
4. **How close a game-side slate can get.**
   The edge line and the shading come from bevel nodes and occlusion that only Cycles evaluates; they may have to be computed into vertex data when the geometry is made (step 3).
   *Built:* the edge line and the concave crease darkening are computed exactly from per-corner edge distances and dihedral angles written at geometry time; the 0.5 m occlusion, the shading Bevel and the detail map are not drawn.
   Not yet judged by Tris.
5. **Decorations outside a scene.**
   The builds read the game camera and depth from the scene and avoid each other; whether handing those over explicitly reproduces today's growth is untested (step 5).
   *Built:* the growth is the scene exporter's own, on a prepared `.blend` with the host at the body frame (depth is its own y) and `guide.camera` at the level's lens; the add-ons face Blender -y by construction.
   A plant grown alone avoids no plant before it.
   Not compared against a river decoration grown in the scene.
6. **The backdrop's sources.**
   The Orthographic Studio's scenes are not persistent, so the plan assumes no backdrop solid has a recoverable three-outline source and migrates them all as fixed meshes.
   *Done so:* all 25 solids migrate as imported mesh leaves.
7. **`cli assets` and a third kind of export.**
   Its budgets and its walk of `public/` predate a 157 MB scene and the model library (section 5.5).
   *Now:* it checks the drawn formations are published and present, and counts their drawn files in the total; the total was already 257.9 MB of a 100 MB budget before any formation, the river scene most of it.
8. **The cost of the migration bake**, estimated from 2026-11-22's export at about 30 s an object.
   *Measured in part:* a small rock bakes in 15 s plus 4 s of tiers; a mound moss grows in up to 80 s, a fern in 2 s.

## 9. Rules of the repository

Read `rope/CLAUDE.md` first; it is the map, and these are the ones this work will meet.

- No em dashes anywhere; a plain dash instead.
- In Markdown, one sentence to a line.
- A commit message never names an agent as co-author.
- A Bash command gets a timeout of at most 30 s unless a longer one is justified; a long run goes in the background, on a workload shrunk until it fits where it can be.
- Tris's dev server is on port 3100: never `pkill vite`, never `git checkout levels/*.json`, never `git stash`.
- The editor autosaves 750 ms after an edit, so close its tab before a script touches a level.
- Edit source with the Edit tool, never a scripted replacement.
- A bug fix starts by reproducing the bug end to end, as close to production as it can be.
- Do not write regression cases for how something feels until Tris has played it and said it is what was asked for.
- Do not run a full scene export without asking Tris; test one object or one step.
- Show a visual change as the game renders it, never as a texture-space crop.
- Cap the memory of an unmeasured heavy run (`systemd-run --user --scope -p MemoryMax=…`); an out-of-memory kill has taken a session before.
- Start a headless Chromium without a display, or it steals Tris's clicks.
- A new kind of sim state ships with its detectors; nothing here should be sim state, and nothing render-side may reach the sim.
- The doc for an area is updated in the change that alters it (`docs/`, indexed in `rope/CLAUDE.md`); each step above adds or rewrites one.
- Blender tests are scripts run by hand (`blender -b --factory-startup --python-exit-code 1 --python tools/blender/test_X.py`), printing an `…_OK` marker; no runner calls them, so say in the step's doc which ones cover it.

## 10. Decisions, in the order they were made (2026-11-22)

For whoever wonders why a thing is as it is.

1. Rock that fits a collision outline must stay possible; outline-fitted geometry is generated, not composed from a library.
2. The editor gets the generation features of the add-ons; Blender is opened only for custom modelling.
3. Moss and ivy were first scoped to an instance of a rock, then made free-standing, then (to survive regeneration) anchored to the guide.
4. Decoration is painted in the scene with the outlines visible, so the reusable-asset workspace is an Assets tab and decoration is level content.
5. Geometry from a collision outline is 1:1 with it and not shareable; then every guide, collision or background, is 1:1 with its geometry.
6. Background guides are boolean solids; orthographic editing is a preset of them; sculpting is out.
7. Texture memory is held down by per-formation LOD chosen in the editor, automatic by default.
8. The guide is a stored copy with align buttons each way, and the collision is fitted to the generated geometry at the play plane with an accuracy.
9. Results are pinned artifacts with the generator's fingerprint; code changes stale nothing.
10. Results are published as regional bundles per level; paint strokes live in a sidecar.
