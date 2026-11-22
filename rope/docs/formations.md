# Formations: the editor owns the level

A level's rock is generated from guides in the level editor, drawn in the game from a store of built results, and baked only when it is finished.
Blender is a headless backend the editor drives, and a workshop for hand-modelled assets.
The design and its reasons are in [plans/editor-owns-the-level.md](../plans/editor-owns-the-level.md); this is how it works.

## The pieces

| | What | Where |
|---|---|---|
| Formation | A recipe (generator, variant, parameters) and a guide, on a body | `LevelBodyData.formation`, `FormationData` in `src/level/levelFormat.ts` |
| Guide | A copy of the body's collision pieces, or a boolean tree of solids | `CollisionGuide`, `SolidGuide` |
| Decoration | Moss, ivy, a fern, a vine, mushrooms, orbs, glow flora, grown on a formation's rock | `DecorationObjectData`, a body object |
| Paint | A painted decoration's strokes | `levels/paint/<level>.json` |
| Store | Every built result, by the hash of what built it | `public/generated/<hash>/` |
| Asset | A reusable rock for the model library, from a free guide | `formation-assets/<name>.json` |

## Recipes and the hash

`src/formation/recipe.ts` resolves a formation's parameters against the generators' schema and hashes the recipe.
The hash is taken over the recipe as authored: the generator, the variant, every parameter with defaults filled, the recipe version, and the guide as the level holds it.
It is not taken over what the guide is turned into (the outline the pieces' union is, the mesh a tree is), so a manifold upgrade cannot stale every rock at once.
Numbers are rounded to a micrometre first, so a guide that went to disk in pixels and back hashes the same.
A formation is stale when its hash now is not `built.hash`.
A piece's own fields (hook-proof, mud, `passes`) are kept in the guide for "Align collision to guide" and are not in the hash.

The schema, `src/level/formationSchema.json`, is written from the formations add-on by `tools/blender/formations/schema_export.py` (`just formation-schema`): keys, labels, descriptions, types, defaults, bounds, and the rules `params.draw` applies, as data.
`tools/blender/test_formation_schema.py` holds it to the add-on (every worker default, and the fields `draw` shows for every variant).

Units: the guide is level geometry and scales with the level; `params` are the generator's, in metres, and do not; the build record (`built`) is the store's, in metres.
A formation has its own placement in its body (`x`, `y`, `rot`), so moving a body's origin does not move its rock.

## Frames

A level point (x, y) with y down is the generator's outline point [x, -y] (the rock's x and z, z up), and the 3D view's (x, -y, 0).
Blender's (x, y, z) is the 3D view's (x, z, -y): the play plane is Blender y = 0, which is the body frame's z = 0.
`scripts/test-formations.ts` builds an L-shaped outline and checks the section and the bounds land on it, the right way up.

## The store

`public/generated/<hash>/` (gitignored), served by `src/server/formations.ts` with `no-store`:

- `geometry.glb`: the rock without a bake, the iteration look's mesh (at most 150,000 triangles, Decimate), carrying `_facet`, `_edge`, `_crease`;
- `rock.blend`: the rock as the worker built it, with the bake's caps set (what a bake and a decoration start from);
- `tier-<k>.glb`: the bake's tiers, finest first, once baked;
- `meta.json`: the recipe, the worker recipe, the generator's fingerprint, triangle counts, bounds, the play-plane section, the tiers, times, warnings;
- `decoration.glb` and its `meta.json`, for a decoration's hash;
- `meshes/<sha256>.json`: a solid guide's imported meshes.

A save never removes anything.
`bun run formation:sweep` lists what no level file and no pinned bundle names; `--delete` removes it.
An editor's undo history can still name a removed build, so sweep with the editors closed.

## Building

`scripts/formation-build.ts` (`bun run formation:build <recipe.json> [--bake]`, or `--level <level> --body <index>`):

1. **Geometry.**
   `tools/blender/formations/worker.py` builds `rock.blend` from the worker recipe.
   `tools/blender/formation_export.py` bows the long creases as the export will (`scene_export.straight_creases` and `curve.bend`, so the editor draws and fits to the shape the bake ships), cuts the section at the play plane, writes `geometry.gltf` with the iteration look's attributes, measures what a solid variant does to its guide's openings, and saves the rock with the caps.
   The optimiser packs the mesh.
2. **Bake** (`--bake`).
   The scene exporter bakes `rock.blend` as a model (`blendExport.ts`, kind `formation`, every face seen, colour at most 2048 and normal at most 1024), and `scripts/formation-tiers.mjs` derives the lower tiers: a quarter of the triangles each (meshoptimizer; normals dropped, welded by position and UV, simplified, split again and given face normals) and half the maps' side, AVIF 4:4:4 at quality 90, down to a 128 colour map or 400 triangles.

A folder appears whole or not at all (built beside and renamed).

Measured 2026-11-22: the geometry path is 1.5 to 3.3 s for a small rock (2.6 s of it generating), 35.6 s for an 8 m fitted outline (239,656 triangles); a bake is 14.8 s plus 3.7 s of tiers for a small rock.
A cold Blender start is 0.3 s, so a warm Blender would save about 0.6 s of a geometry job; it was not built.

## The job runner

`src/server/formations.ts`, in the dev server:

- `POST /api/jobs` with `{kind: geometry|bake, formation}`, `{kind: decoration, request}` or `{kind: asset, asset}` answers a job id;
- `GET /api/jobs?client=<id>` is a server-sent stream of every job's state;
- `DELETE /api/jobs/<id>` cancels (the process group is killed);
- `GET /api/jobs/<id>/log` is a job's whole output;
- `POST /api/jobs/hold` holds the GPU jobs while an editor's ▶ Test runs (released when its stream closes).

A job is keyed by the hash it will produce: asking for one that is running joins it, and one the store holds is answered done at once.
Geometry and decorations run three at a time; a bake and an asset's accept hold the GPU and run one at a time.
Progress is the scripts' own `<tag> step i/n: label` lines.
A failure carries the last lines of the output and the path of the log.
The editor's Jobs panel (`src/editor/formationJobs.ts`) shows every job from every tab, in the canvas's bottom-right corner while there are any.

## In the editor

A formation is an item of its body (`EdFormation`), so it rides every move of the body, is undone, copied (with a fresh id) and deleted like any object.
A body's panel has a Formation section; selecting the formation itself shows it too.

The collision guide workflow:

1. Draw the collision.
2. Set the recipe, then **Generate**: a body with collision and no formation shows the whole recipe (generator, variant, parameters) on a draft that is not in the level, so it is set up first; Generate puts it in the level (one undo step), takes the guide from the collision (every piece, or the subset ticked) and builds the rock.
   The draft starts from the last recipe set in any Formation section (per kind of guide: collision or solid, the latter also what Backdrop starts from), as Blender's operators start from their last settings; it is kept in this browser, never in a level (`lastRecipe` in `src/editor/formationPanel.ts`).
3. **Fit collision to geometry**: the collision becomes the rock's section at the play plane, simplified within the accuracy (the vertex count shows as it is typed).
   Holes are filled and crumbs dropped; pieces with different fields are each fitted to the part of the section nearest them.
   It is the only path that writes collision from geometry, and it diverges recordings made before it.
4. **Align collision to guide** puts the collision back exactly as the guide was taken, before reshaping.
5. **Align guide to collision** takes the guide again; the rock is stale until regenerated.

The panel says whether the collision matches the guide; after a fit it does not, and that is information.
Merge and Split are refused where they would put two formations in a body or take one from its collision and decorations.

Background guides: **Backdrop** in the tool grid makes a **3D body** (`LevelBodyData.space`: no collision, so free to stand at a depth and tilt, with the full gizmo; see [level-format](level-format.md)) holding a formation on a solid guide behind the plane.
Its guide is edited as a **stack of shapes** (`src/formation/solidStack.ts`, since 2026-11-22), as Blender's boolean cutters and MagicaCSG have it: an ordered list, each shape **Add**, **Subtract** or **Intersect**, applied top to bottom onto the first.
The shapes are boxes, ellipsoids, hulls of points, outlines pushed through a depth with a taper, the Orthographic Studio's three-outline preset, and imported meshes (`.glb`/`.gltf`, welded, kept in the store).
In the panel each row's badge cycles its mode and a row is dragged to reorder; **Shift+A** in the view adds a shape (in the middle of the guide, `guideCentre`); a cut is drawn red and an intersection amber, and any shape but the base (which is the rock: a click on it is a click on the body) is picked by a click in the view.
The level format is unchanged by the stack: it is read from the tree as a left fold and written back as one, so a guide nobody edits keeps its hash, and a subtree that is not part of the fold is one group row.
The picked shape and its points are moved with the gizmo (an outline's points stay in its plane); the guide is meshed live with manifold-3d and drawn through the scene (`src/editor/solidGuides.ts`), in its body's 3D frame: its edges as lines, and its volume as a translucent, lit, faceted shell (depth-tested, stronger while selected) - always for a guide not generated yet, and only while selected once its rock is, since the rock is then the volume.
A click on a guide selects its formation's body, as a click on a mesh does (`SolidGuideView.pickGuides`), so a backdrop nobody has generated is selected by its guide; where the ray meets the guide only beyond the gameplay plane, whatever the plane holds at that point is picked first (`pickCandidatesAt`), and the backdrop is the next click into the stack.
Backdrops behind the plane are picked among themselves nearest first along the ray (the nearer of the rock and its guide), not by the plane's stacking or by which outline holds which: none of them is an outline on the plane, and before 2026-11-23 a rock standing in front of the waterfall cliff lost the click to it.
The handles of a body with no collision and a solid guide (a backdrop) stand on, and it turns about, the middle of its solids - each guide's own centre, carried with its placement - rather than on its frame or its placement points; see [editor](editor.md#the-transform-gizmo).
A solid variant that fills an opening its guide leaves (the Wall variant over an arch fills all of it) is reported in the panel as a warning: measured on the guide's front silhouette's convex hull.

The tier the game loads is chosen per formation: automatic picks tier k where the rock stands far enough behind the plane that 2^k is no larger than (D + depth) / D, D the camera's distance from the plane at the level's zoom (8.8 m).

A formation built by an older generator than the one in the tree is marked so; Regenerate builds it with the current code.
Nothing goes stale when generator code changes.

## The iteration look

A rock that is not baked is drawn in `src/render3d/formationSlate.ts`, the painted slate's graph where the game can evaluate it: the drift, the per-facet tone, the grain and the stains from object-space Perlin noise, the edge line from the Bevel node's geometry (each point's distance to its triangle's edges and each edge's dihedral angle, computed when the geometry is made), and the concave creases' short occlusion.
It cannot draw the 0.5 m occlusion, the shading Bevel's rounding, the chamfer strips or the detail map's chips.
It has not yet been judged against the bake by Tris.

## Decorations

A decoration is tied to its formation's guide, which a regenerate leaves where it was: its `anchor` is the nearest point of the guide's surface to where the rock was clicked, with the guide's normal there.
Where it is drawn (`onRock`) is the anchor carried along the normal onto the rock that is drawn now (`src/editor/decorations.ts`).

- **Placed** (a fern, a vine, mushrooms, orbs, glow flora): grown once where it stands, then only moved: dragging it moves the anchor over the guide and lands it on the rock every frame, moved in place without rebuilding the scene.
- **Painted** (moss, ivy): its strokes are painted and erased on the rock and kept in the level's paint; it grows again when the brush lets go.
  While the brush is on, what the paint covers is drawn as the Blender stamp brush draws it: a field of dots over the rock where the composited paint reaches the grower's threshold (`src/editor/paintCoverage.ts`, a port of stampbrush's `Coverage` and `composite`, matched to it at 6.5e-8), so the region on screen is the region that grows, erasing included.
- **After a regenerate** every anchor on that guide is carried onto the new rock; a painted one's strokes are carried too and it is grown again.
  One that finds no rock within 0.75 m of its guide point, or would move further than 0.5 m, is flagged lost and left as it was.
  A large edit to a guide means placing its decorations again.

A decoration's panel offers its add-on's settings as fields, the same sections and fields the add-on's Blender panel shows for its kind and under the same conditions (`src/editor/decorationSettings.ts`), with each field's label, description, type, bounds and options read off the add-on's registered properties into `src/level/decorationSchema.json` by `tools/blender/decoration_schema_export.py` (`just decoration-schema`; a field renamed in an add-on stops it).
A value at its default is not written; colours are kept linear, as Blender's are. A change marks the decoration stale and **Grow again** builds it.

Growth (`scripts/decoration-build.ts`) prepares a `.blend` (`tools/blender/decoration_prepare.py`): the formation's rock as it is drawn, named `formation` and hidden from the render; `guide.camera` at the level's lens for the detail budget; the decoration made through its add-on (`create_moss`, `create_ivy`, `create_plant`) with its settings and seed; a placed one landed on the rock by a ray along its normal.
The scene exporter then grows and exports it exactly as it grows a level's, so what the editor shows is what an export of the same paint would ship.
Depth is the rock's own Blender y (the body frame's play plane is y = 0) and the camera direction is Blender -y, which the add-ons already assume.
A plant grown alone avoids no plant before it.
A texture-only moss ships as a thin shell 3 mm off the rock wearing its own print (`SCENE_EXPORT_MOSS_SHELL`), since there is no rock map to paint it into.

Measured 2026-11-22 on a 3.9 m boulder rock: a fern 1.8 s, ivy 2.1 s, a texture moss shell 2.8 s, a mound moss of ten strokes 80 s (79,309 triangles).

The paint is `levels/paint/<level>.json`, one stroke a line, written with every save; it is a folder of its own because a second `.json` beside a level would be offered as a level.

The **Game camera** button (Numpad 0) shows the level through the game's camera where the view is looking: the level's lens at the zoom its camera regions rest at there.
A ▶ Test is drawn as the game draws it: the depth of field at the player's saved setting, and none of the editor's marks (the paint, the solid guides).

## The Assets tab

**Assets** beside Level and Visuals puts the level aside (its model, its undo and its name) and opens an asset document instead: one body at the origin with a formation on a free guide, an outline drawn as the body's collision or a solid.
Both views and every tool work on it; it saves itself to `formation-assets/<name>.json`.
**Accept into the library** (`scripts/formation-asset.ts`) builds the rock if the store lacks it, copies it to `assets-src/models/<name>.blend`, and exports it as a library model exactly as `just model <name>` does; `+ Model` then places it, drawn from one file however many times.
Pressing Assets again gives the level back as it was.

## Publishing

`bun run assets:publish-formations` (in `just publish`) packs every registered level's built formations into region bundles (bands 30 m wide along x), each every file of every hash it holds under its store name, and uploads them to the asset release as `formations-<level>-r<k>.bin`.
The pins are `src/render3d/formationAssets.json`; a region whose hashes are its pin's is left alone.
`bun run assets:fetch` unpacks the pinned bundles into the store, so a collaborator carries on editing.
The game never downloads a bundle: the build keeps of each formation only the file it draws (`formationServedFile`) and drops the rest of `public/generated` (`exportsInBuild` in `vite.config.ts`), and the preload list names those files.
`cli assets` fails on a formation that is drawn and not published or not in the local store, and counts the drawn files in the total.

## Migrating a scene

`bun run scene:migrate <level>` (`scripts/migrate-scene.ts`, `tools/blender/migrate_scene_dump.py`) reads the level's Blender scene and writes `levels/<level>-migrated.json` and its paint, never the level itself:

- each outline formation goes on the body whose collision covers at least half of it, placed in it where it stood (a version 1 boulder recipe's depth and slab sizes are converted as `params.built` converts them), or on a body of its own;
- each solid formation becomes a body of its own, its guide the Blender guide mesh as an imported mesh leaf;
- each moss and ivy becomes a painted decoration, each plant a placed one, carried into its formation's frame;
- `scene` is removed.

A decoration whose host is not a formation is listed and not carried.
`bun run formation:build-level <level> [--bake] [--only <name>]` then generates every formation, grows every decoration on the new rocks and writes what was built into the level file (close the editor first).

For the river on 2026-11-22: 40 formations (14 onto the collision bodies they were drawn over), 51 decorations (19 painted), 5 not carried (on `Cube.004`, `Terrace.017` and the pool, which are not formations).

## Tests

- `scripts/test-formations.ts` (in `bun run test`): the hash, the disk and editor round trips, the align and match workflow, the fit, and the coordinates through a real build.
- `tools/blender/test_formation_schema.py` (by hand): the schema against the add-on.
- `cli levels`: formation ids unique, a generator its guide offers, the built hash in the store.
- `cli assets`: the drawn formations published and present.

Not covered by any test: the editor's gestures (placing, dragging, painting, the gizmo on a solid node), which were exercised by driving the real editor headlessly.
