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

- `geometry.glb`: the rock without a bake, the iteration look's mesh (at most 150,000 triangles, Decimate), carrying `_facet`, `_edge`, `_crease`, and each corner's normal its face's (so a facet's triangles shade as one plane; since 2026-11-23, before which the slate was flat shaded per triangle);
- `rock.blend`: the rock as the worker built it, with the bake's caps set (what a bake and a decoration start from);
- `tier-<k>.glb`: the bake's tiers, finest first, once baked;
- `meta.json`: the recipe, the worker recipe, the generator's fingerprint, triangle counts, bounds, the play-plane section, the tiers, times, warnings;
- `decoration.glb` and its `meta.json`, for a decoration's hash;
- `meshes/<sha256>.json`: a solid guide's imported meshes (`{verts, faces}`, named by the hash of the canonical JSON; the leaf's `file` is the bare hash);
- `meshes/<sha256>.bin`: a solid guide's applied, sculpted or cut meshes, binary (`src/formation/meshBin.ts`: a 16-byte little-endian header - `RMSH`, version 1, vertex and triangle counts - then `Float32` positions and `Uint32` indices; 12 bytes a vertex and 12 a triangle where the JSON was ~60 a vertex), named by the hash of its bytes; the leaf's `file` carries the `.bin`. The editor hashes the bytes itself, so a guide names its mesh in the same edit that makes it, and a job waits for uploads still on their way (`meshesStored`).

A save never removes anything.
`bun run formation:sweep` lists what no level file and no pinned bundle names; `--delete` removes it.
An editor's undo history can still name a removed build, so sweep with the editors closed.

## Building

`scripts/formation-build.ts` (`bun run formation:build <recipe.json> [--bake]`, or `--level <level> --body <index>`):

1. **Geometry.**
   `tools/blender/formations/worker.py` builds `rock.blend` from the worker recipe.
   `tools/blender/formation_export.py` rebuilds the long creases on the rock itself and keeps the bows it found on it (`scene_export.keep_bows`, `formation_rebuilt_bows`), gives the rock its paint UV ([Texture layers](#texture-layers)), saves `rock.blend` back, bows a copy as the export will (`curve.bend`, so the editor draws and fits to the shape the bake ships), cuts the section at the play plane, writes `geometry.gltf` with the iteration look's attributes and the paint UV, measures what a solid variant does to its guide's openings, and saves the rock with the caps.
   The bake and a decoration's build take the rebuilt rock as it is: `straight_creases` hands back the kept bows rather than rebuilding it again (since 2026-11-25; a second rebuild re-triangulates the creases' planes, under the paint UV).
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
Both are the **Formations workspace's** ([editor](editor.md#workspaces-2d-formations-decorations)): there it opens first and the body's physics sections are left out, and the dock offers Backdrop, the stack's Add shape and **Generate N out of date**, which builds every rock not generated or stale in one go.

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

Background guides: each of the Formations dock's **Primitives** (or Shift+A with nothing selected) makes a **3D body** (`LevelBodyData.space`: no collision, so free to stand at a depth and tilt, with the full gizmo; see [level-format](level-format.md)) holding a formation on a solid guide of that one shape, standing where the view is looking; Union / Subtract / Intersect fold other guides into it ([editor](editor.md#workspaces-2d-formations-decorations)).
Its guide is edited as a **stack of shapes** (`src/formation/solidStack.ts`, since 2026-11-22), as Blender's boolean cutters and MagicaCSG have it: an ordered list, each shape **Add**, **Subtract** or **Intersect**, applied top to bottom onto the first.
The shapes are boxes, cylinders (standing along their y) and meshes in the store: imported (`.glb`/`.gltf`, welded) or made by **Apply**, a sculpt or a cut ([Sculpting](#sculpting)).
The orthographic route's leaves - ellipsoids, hulls of points, outlines pushed through a depth with a taper, and the Orthographic Studio's three-outline preset - were retired on 2026-11-23 ([plans/sculpt-guides.md](../plans/sculpt-guides.md)).
Meshing one needs manifold-3d, which must not reach the sim path, so they are not folded in by `normalizeLevelData`: a level holding one is refused on load with the command that fixes it, `bun run guides:migrate` (`scripts/migrate-solid-guides.ts`, editor closed), which meshes each retired leaf exactly as the editor did into a stored mesh leaf with its pose kept, holds every migrated guide to the volume it had (manifold-3d's `volume()`, to 1e-6 relative), and leaves every other guide, and so its rock's hash, as it was.
In the panel each row's badge cycles its mode and a row is dragged to reorder; **Shift+A** in the view adds a shape (in the middle of the guide, `guideCentre`); a cut is drawn red and an intersection amber, and any shape but the base (which is the rock: a click on it is a click on the body) is picked by a click in the view.
The level format is unchanged by the stack: it is read from the tree as a left fold and written back as one, so a guide nobody edits keeps its hash, and a subtree that is not part of the fold is one group row.
The picked shape is moved, turned and sized with the gizmo; the guide is meshed live with manifold-3d and drawn through the scene (`src/editor/solidGuides.ts`), in its body's 3D frame: its edges as lines, and its volume as a translucent, lit, faceted shell (depth-tested, stronger while selected), each guide in its own colour, in the Formations workspace only and as its Guides / Rocks / Guide-Rock-Both settings say ([editor](editor.md#workspaces-2d-formations-decorations)).
A click on a guide selects its formation's body, as a click on a mesh does (`SolidGuideView.pickGuides`), so a backdrop nobody has generated is selected by its guide; where the ray meets the guide only beyond the gameplay plane, whatever the plane holds at that point is picked first (`pickCandidatesAt`), and the backdrop is the next click into the stack.
Backdrops behind the plane are picked among themselves nearest first along the ray (the nearer of the rock and its guide), not by the plane's stacking or by which outline holds which: none of them is an outline on the plane, and before 2026-11-23 a rock standing in front of the waterfall cliff lost the click to it.
The handles of a body with no collision and a solid guide (a backdrop) stand on, and it turns about, the middle of its solids - each guide's own centre, carried with its placement - rather than on its frame or its placement points; see [editor](editor.md#the-transform-gizmo).
A solid variant that fills an opening its guide leaves (the Wall variant over an arch fills all of it) is reported in the panel as a warning: measured on the guide's front silhouette's convex hull.

The tier the game loads is chosen per formation: automatic picks tier k where the rock stands far enough behind the plane that 2^k is no larger than (D + depth) / D, D the camera's distance from the plane at the level's zoom (8.8 m).

A formation built by an older generator than the one in the tree is marked so; Regenerate builds it with the current code.
Nothing goes stale when generator code changes.
The job runner (`src/server/formations.ts`) treats a store entry built by another fingerprint as a miss, so asking for it builds it again (`--force`); until 2026-11-25 the store's entry answered, and Regenerate rebuilt nothing.
The fingerprint (`worker.fingerprint`) covers `formation_export.py` since then too: it builds the geometry, the crease rebuild and the paint UV.

## Sculpting

Since 2026-11-23 a solid guide is shaped as Blender sculpts a mesh ([plans/sculpt-guides.md](../plans/sculpt-guides.md), which replaced the orthographic route: outlines seen head on, intersected).
The box and cylinder are starting shapes; a sculpt edits a mesh, not a tree.

**Apply** (the Formation panel; Blender's "apply the modifiers") meshes the whole stack into one stored mesh and makes the guide that one mesh leaf, unposed (`meshLeafTree`, a union of one so a shape added after it lands beside it), as one undo step.
A guide that is already one unposed mesh leaf has nothing to apply (`sculptedMeshOf`).

**Sculpt mode** (`src/editor/sculpt.ts`), Formations only, on one selected solid guide: the dock's **Sculpt** (in Selected), the panel's **Sculpt**, or **Ctrl+Tab** (Chrome keeps Ctrl+Tab for itself in a normal window, so there the buttons are the way in).
Entering applies the stack first when it has to.
It is left by Ctrl+Tab, Esc (with no stroke in progress), **Done**, selecting anything else or leaving the workspace; a guide changed from outside meanwhile (an editor undo, a deleted body) drops the session's unsaved strokes, with a notice.
While it is on, the guide is drawn opaque and flat shaded (Blender's Dyntopo default: a vertex normal averaged across a primitive's two-metre faces streaks them) through a matcap, grey tinted with the guide's colour, its rock and its guide shell hidden, the gizmo put away, the overlay not drawn and the dock the mode's alone; the panel shows only that it is being sculpted, so nothing else edits the guide behind the sculpt's back.
Every key but the view's (Numpad, Home) and the workspaces' (1, 2, 3) is the mode's.

| Key | Does |
|---|---|
| **D** | Draw: the surface under the brush pushed along the brush's area normal (the falloff-weighted mean of the normals under it, so a dab across an edge moves both sides one way); **Ctrl** digs instead |
| **G** | Grab: the vertices under the brush at the press, moved with the pointer in the plane facing the camera, each by its falloff weight, always from where it started (no accumulated error); **Ctrl** smooths while held, and let go, Grab takes up the vertices under the brush afresh |
| **Shift** | Smooth on either brush (each vertex toward its neighbours' mean) |
| **C** | Cut (below), in or out of the mode |
| **F**, **Shift+F** | the brush's radius (move the pointer; the ring is drawn), its strength (move sideways); click, Enter or F sets, Esc keeps the old |
| **Ctrl+Z**, **Ctrl+Shift+Z** / **Ctrl+Y** | undo and redo a stroke |
| **Ctrl+R** | Remesh |

The radius is in screen pixels, Blender's default "view" radius, measured to metres at the depth the brush meets the surface; dabs are spaced at a tenth of it along the stroke (`dabsAlong`), and the modifiers are read per dab, so pressing or letting one go mid-stroke switches mid-stroke.
The cursor is a ring on the surface, turned to it, white for Draw, blue for digging and yellow for smoothing.
How the brushes feel - their rates (`DRAW_RATE`, `SMOOTH_RATE`), falloff and spacing - is a first guess, not yet played, and holds no tests.

**Dyntopo** (on by default, a dock toggle, with the **Detail** size, 2 cm), `src/formation/dyntopo.ts`: Blender's constant-detail Dyntopo, in each dab's region the textbook isotropic remesh (Botsch & Kobbelt 2004) - edges over 4/3 of the detail split longest first, edges under 4/5 collapsed into their midpoint or either end where that keeps the mesh a closed two-manifold, turns no face over and lengthens no edge past 4/3 (an end on a crease, two of its faces meeting at over 30°, keeps its place: merged halfway, crease vertices were pulled off a drawn-over box edge one by one into a sawtooth), and edges flipped toward valence six where the surface is flat across them, only about what this dab changed.
So a box primitive's two-metre faces are split from their long edges inward until only the brush's part is fine, and Draw builds detail where it draws.
4/5 and 4/3 are when to act, not bounds every edge ends inside: the halves of an edge just over 4/3 are 2/3, and collapsing them back would make it again (measured: 81 of 474 edges of a drawn region under 4/5).
Botsch's fourth step, tangential relaxation, evens them; it was tried and left out, as Blender's Dyntopo leaves it out, because it moves the surface under the brush on every dab and took the 81 only to 42 over ten dabs.
Mid-grab only the splits run (each new vertex taken along by the grab, its start and weight its ends' mean); the whole region is tidied when the grab lets go.

**Remesh** (Ctrl+R, the dock's button; Blender's voxel remesh), `src/formation/sculptRemesh.ts`: the mesh rebuilt as the zero set of its signed distance by manifold-3d's `levelSet` at the detail size (coarsened, and said, past 160³ grid points).
The distance is sampled once onto a grid, its size in a band two cells wide about the surface and its sign by winding number along columns (+z rays; any winding but zero is inside, so a fold through itself reads as the union of the overlaps).
No sample is nearer zero than 0.002 of a cell: the marching-tetrahedra degeneracy, every vertex on a lattice point's edges gathered onto one spot where the surface passes within micrometres of it.
A sphere at 3 cm: 75,536 triangles in 0.3 s, the volume within 0.06%.

**Cut** (**C**, `src/formation/sculptCut.ts`): click a polygon on the view, Enter or a click on its first corner closes it (with **Alt** held it cuts the inside away instead), Backspace takes the last corner back, Esc drops it; one that crosses itself is drawn red and refused.
What is kept is what lies inside the polygon as the camera sees it, built as a solid and intersected with the guide in manifold-3d: orthographic, the polygon's prism along the view; perspective, the cone from the eye through it, built as the polygon at a near depth extruded to a far one with its top scaled by far / near (a linear extrusion scaled about the axis is exactly the projective frustum), from in front of the guide to behind it.
In the mode it is a sculpt undo step on the working mesh; out of it, the guide's whole stack is cut and becomes one stored mesh, an editor undo step.

**The working mesh** (`src/formation/sculptMesh.ts`) holds vertices and triangles in slots with spare room, a dead triangle drawn as nothing; its position, normal and index arrays are the very ones the GPU draws, uploaded in runs of the slots a frame wrote.
Every write goes through a journal that records each slot's state before its first write in a stroke, so a stroke is undone and redone slot by slot whatever Dyntopo did to the topology (Blender's sculpt undo, by slot rather than by PBVH node).
Brush and ray queries go through a multi-level hash grid of triangles (`src/formation/sculptGrid.ts`), each at the level whose cell its box fits, re-binned on its own as it changes; a query asks each level in the cheaper way, its covered cells or its triangles one by one.
The plan named three-mesh-bvh; a BVH can only be refit for moved vertices, not for the triangles Dyntopo adds on every dab, and a rebuild is ~100 ms at 300k triangles.
Measured 2026-11-23 in Chromium: 2.6 ms a dab, Dyntopo and Draw, along a stroke on a box at 2 cm (cell walking alone at first: 23 ms, 1.15 s of a 1.3 s stroke on 4 mm cells holding a few stray triangles).

**Commit**: the model is never touched mid-stroke.
A stroke's end is a sculpt undo step; the mesh is stored and named by the guide two seconds after the last stroke and on leaving, the whole session one editor undo step.
What is stored is the mesh through manifold-3d (`storedGuideMesh`), which tidies a near-degenerate triangle by an edge swap as it takes a mesh in, so what is stored is exactly what every later load meshes.
A mesh that folds through itself (segment-against-triangle among the triangles touched since the last commit; manifold-3d takes such a solid and a generator misreads it) or that manifold-3d refuses is not committed while idle - a notice says so - and is remeshed on leaving, with a notice.
`SolidGuideView` and the panel keep each node's mesh and drawn geometry per tree object (`guideMesh`): before, a selection change meshed a 221k-triangle sculpt again and took 0.9 s; now 30 ms.

**The hand-over** (`solidWorkerRecipe`): a guide over 50,000 triangles is simplified (manifold-3d's `simplify`, every surface within 0.25% of the guide's bounding-box diagonal, 9 mm on a 2 m rock) before the generator sees it, so a sculpt's density changes its shape and not how long a generate takes; no guide made before sculpting is that dense (the largest imported mesh is 20,152 triangles), so each is handed over as it was.
And every PINCH is opened (`separatePinches`): manifold-3d keeps a point where two sheets of surface touch (a remesh's saddle, a cut through touching geometry) as one vertex per sheet at one spot, a valid solid, but the generator welds vertices within 10 um (`remove_doubles` in `formations/solidfit.py`) and refused such a guide as "not a closed mesh (2 non-manifold edges)"; each vertex within that of another is moved 30 um toward its own neighbours, into its own sheet.

Measured 2026-11-23, `formation:build` into a scratch store (wall time; generate in brackets):

| Guide | Handed over | Boulder | Cliff |
|---|---|---|---|
| a voxel-remeshed box, 221,506 triangles | as it is | 29.3 s (21.8) | 19.9 s (12.8) |
| the same | decimated, 3,108 | 5.5 s (3.8) | 4.7 s (3.3) |
| a drawn ellipsoid, 296,934 triangles | as it is | 24.4 s (14.7) | 23.2 s (13.7) |
| the same | decimated, 2,088 | 4.5 s (3.0) | 5.4 s (3.7) |

Half the undecimated time was the export (6 to 8 s), which walks the guide too.
The box's rocks came out about the size they were (22,282 and 23,418 triangles for the Boulder, 17,512 and 16,890 for the Cliff); the ellipsoid's did not (9,136 and 11,956 for the Boulder, 11,748 and 16,214 for the Cliff), and the two have not been compared by eye.

## The iteration look

A rock that is not baked is drawn in `src/render3d/formationSlate.ts`, the painted slate's graph where the game can evaluate it: the drift, the per-facet tone, the grain and the stains from object-space Perlin noise, the edge line from the Bevel node's geometry (each point's distance to its triangle's edges and each edge's dihedral angle, computed when the geometry is made), and the concave creases' short occlusion.
It cannot draw the 0.5 m occlusion, the shading Bevel's rounding, the chamfer strips or the detail map's chips.
It has not yet been judged against the bake by Tris.

## Decorations

A decoration is tied to its formation's guide, which a regenerate leaves where it was: its `anchor` is the nearest point of the guide's surface to where the rock was clicked, with the guide's normal there.
Where it is drawn (`onRock`) is the anchor carried along the normal onto the rock that is drawn now (`src/editor/decorations.ts`).
The overlay marks a decoration's point on its rock only while it is selected (since 2026-11-23; a mark on every one was a scatter of glyphs that told nothing the growth does not, and a decoration is picked by what grew, never by its mark).
Decorations are made and edited in the **Decorations workspace** ([editor](editor.md#workspaces-2d-formations-decorations)): its palette arms a kind for a click on any generated rock, a rock's panel lists what grows on it (with a `+` per kind for that rock alone), and **Grow N out of date** grows every stale one.
Its dock's **Select** (on whenever no kind is armed; picking it disarms, as Esc does) is how one is picked: a click on what grew selects that decoration, not its rock's body first as the editor's click-the-body-then-into-it would (since 2026-11-25); a click on bare rock selects the rock.

- **Placed** (a fern, a vine, mushrooms, orbs, glow flora): grown once where it stands, then only moved: dragging it moves the anchor over the guide and lands it on the rock every frame, moved in place without rebuilding the scene.
  **Its gizmo** (since 2026-11-25, `DecorationController.gizmo`) stands on it in 3D, turned as it is; before, it had the 2D object's handles, on its mark carried onto the gameplay plane, and moved only the mark.
  Its move slides it over the rock (the handles' point landed on the rock as a drag lands it); its turn and its size are the decoration's own `turn` (a quaternion) and `scale` (a factor per axis), on top of the anchor's frame, about its root.
  They are drawn, never grown (`placedFrame` in `render3d/formations.ts`, through `decorationDelta`), so turning or sizing one regrows nothing and it keeps both as it moves over the rock; **G**, **R** and **S** do the same through the same handlers.
  The disk keeps them unscaled (`scaleLevelData` lists a decoration's fields, and dropped both until a case in `test-formations.ts` caught it).
  A painted one has no gizmo, nor the 2D rect's corner and turn handles any decoration had (`computeHandles`): it is moved by painting.
  **F** frames what grew (`drawnBox`: every scene object carrying its pick tag), not its 15 cm mark.
- **Painted** (moss, ivy): its strokes are painted and erased on the rock and kept in the level's paint; it grows on a **right-click** while the brush is on (`DecorationController.apply`; a right drag still pans).
  Letting the left button go only ends the stroke, so several strokes, with the view moved between them, wait on one growth (since 2026-11-25; before, every release grew it and the next stroke waited on that).
  **The palette's brush** (moss or ivy armed in the dock) is a tool of the workspace, not of the selection: a press paints the rock it lands on, adding to that rock's paint of the kind (`paintedOn`: the last made, unless lost) or starting it there, selects nothing (since 2026-11-25; selecting the new moss put its panel and gizmo over the rock being painted), and stays armed; its Paint / Erase and radius are in the dock under the palette, and a right-click grows everything it painted since it was armed.
  A right-click with nothing left to grow ends it, back to Select (since 2026-11-25), so painting ends right-click, right-click; "nothing left" is judged by the growth last asked for (`apply` keeps each one's request hash), since a growth on its way still reads as stale and judging by `stale` would ask for it again instead of ending.
  The same holds for the panel's brush and for an armed placed kind (a fern: right-click stops it).
  The coverage dots follow the rock under the pointer, so what is there shows before the first press; an eraser on a rock with none of the paint does nothing.
  **Painting over another patch combines them** (since 2026-11-25; two patches on one stretch of rock were two growths through each other): a press starts on the patch under the brush (or the rock's own), and every other patch of the kind a dab reaches (its coverage covers a point the dab lays weight on: `PaintCoverage.touches`) is taken in, its strokes appended after the painted one's and the patch taken out of the level, in the stroke's undo step (`DecorationController.absorb`).
  Its growth goes with it until the right-click grows the combined patch; the dots show the whole of it meanwhile.
  A decoration's own panel keeps its Paint, Erase and Done, a brush tied to that decoration being selected.
  **The brush's cursor** (`src/editor/paintCursor.ts`, since 2026-11-25) is drawn under the pointer while a painted kind is armed or its brush is on: the Blender stamp brush's ring (its radius on the plane facing the surface, green to paint, red to erase, no depth test) and the dab's footprint, the coverage's own sample points (`RockSamples`, shared and kept per rock) as strong as the weight the dab lays there, so it wraps over an edge and leaves out a face turned away, as the paint does.
  The footprint draws over the coverage (its group's `renderOrder` 40 against the coverage's 12: three sorts a group's children by the group's order, so at 0 an erase's footprint was hidden under the green it would clear).
  While the brush is on, what the paint covers is drawn as the Blender stamp brush draws it: a field of dots over the rock where the composited paint reaches the grower's threshold (`src/editor/paintCoverage.ts`, a port of stampbrush's `Coverage` and `composite`, matched to it at 6.5e-8), so the region on screen is the region that grows, erasing included.
  The dots are the brush's and nothing else's: the brush ends with Done, Esc, a press off the rock, or the selection moving off its decoration (`DecorationController.followSelection`, checked once a frame; placing ends likewise when the selection leaves the formation's body).
  Before 2026-11-23 a change of selection left the brush on with no panel to say so, and Esc or a press off the rock ended it but left its dots drawn (the preview's "stale" key was the same `""` as its "nothing to show" key).
- **After a regenerate** every anchor on that guide is carried onto the new rock; a painted one's strokes are carried too and it is grown again.
  One that finds no rock within 0.75 m of its guide point, or would move further than 0.5 m, is flagged lost and left as it was.
  A large edit to a guide means placing its decorations again.

A decoration's panel offers its add-on's settings as fields, the same sections and fields the add-on's Blender panel shows for its kind and under the same conditions (`src/editor/decorationSettings.ts`), with each field's label, description, type, bounds and options read off the add-on's registered properties into `src/level/decorationSchema.json` by `tools/blender/decoration_schema_export.py` (`just decoration-schema`; a field renamed in an add-on stops it).
A value at its default is not written; colours are kept linear, as Blender's are. A change marks the decoration stale and **Grow again** builds it.

Growth (`scripts/decoration-build.ts`) prepares a `.blend` (`tools/blender/decoration_prepare.py`): the formation's rock as it is drawn, named `formation` and hidden from the render; `guide.camera` at the level's lens for the detail budget; the decoration made through its add-on (`create_moss`, `create_ivy`, `create_plant`) with its settings and seed; a placed one landed on the rock by a ray along its normal.
The scene exporter then grows and exports it exactly as it grows a level's, so what the editor shows is what an export of the same paint would ship.
A solid rock's faces are n-gons flattened after the dissolve (`fitted.flatten`), but not exactly planar, so every path that triangulates one must split it the same way: the growths (`loop_triangles`), the glTF exporter (the baked rock) and `formation_export.py` (the iteration mesh and the section, through `tessellate`) all use Blender's tessellation.
Until 2026-11-23 the iteration mesh was bmesh's BEAUTY split, which turned 161 of a Faceted rock's 380 triangles the other way, and the rock stood through a texture moss's 3 mm shell in rock-coloured triangles.
Depth is the rock's own Blender y (the body frame's play plane is y = 0) and the camera direction is Blender -y, which the add-ons already assume.
A plant grown alone avoids no plant before it.
A texture-only moss is a [texture layer](#texture-layers): a map in its rock's paint UV, not a mesh.
Until 2026-11-25 it shipped as a thin shell 3 mm off the rock wearing its own print (`SCENE_EXPORT_MOSS_SHELL`, still what a rock generated before the paint UV would need), and the rock stood through it in holes wherever the shell and the drawn rock were triangulated apart.

Measured 2026-11-22 on a 3.9 m boulder rock: a fern 1.8 s, ivy 2.1 s, a texture moss shell 2.8 s, a mound moss of ten strokes 80 s (79,309 triangles).

The paint is `levels/paint/<level>.json`, one stroke a line, written with every save; it is a folder of its own because a second `.json` beside a level would be offered as a level.

The **Game camera** button (Numpad 0) shows the level through the game's camera where the view is looking: the level's lens at the zoom its camera regions rest at there.
A ▶ Test is drawn as the game draws it: the depth of field at the player's saved setting, and none of the editor's marks (the paint, the solid guides).

## Texture layers

A texture layer is paint that becomes part of the rock's look rather than a growth over it: today a texture-only moss (`isTextureLayer`: moss with Kind `TEXTURE`), and the dirt brush to come.
Tris, 2026-11-25: "include the moss texture as part of the rock texture not as a shell on top".

- **The paint UV.** Generate unwraps the rock once (`formation_export.paint_unwrap`, the bake's own unwrap code at one colour map's side, every face seen) into the UV map `PaintLayer` (`scene_export.PAINT_UV`), the rock's first.
  So it is TEXCOORD_0 of `geometry.glb` and of every tier of the bake (the bake adds its own unwrap after it as TEXCOORD_1, and keeps it: `remove_unused_uvs` spares it, and `optimize-asset.ts --keep-attributes` stops the optimiser's prune, which took it out and renumbered the bake's UV in its place).
  The bake's unwrap cannot be shared: it is decided by the bake (which faces the camera sees, how many maps).
  Measured on a fitted L: tiers 0 and 1 carry the paint UV of the unbaked mesh exactly at every point they share; tier 2 is simplified and carries it through.
- **The build.** `decoration-build.ts` sends a layer to `tools/blender/decoration_layer.py` instead of the scene export: the moss add-on grows the dabs as the export does for a rock map (`moss.texture_paints`) and `moss.build.layer_map` paints them into `layer.png` at the rock's colour texel, colour sRGB and coverage in straight alpha, the colour carried four texels past the coverage and the coverage past the islands (`_bleed`), so filtering never pulls in an empty texel.
  A layer's request carries `layer: true`, so it never shares a hash with the shell it was; a moss grown before is stale until grown again.
  On a rock generated before the paint UV the build fails with "Generate it again to paint one on it".
  About 3 s on a small rock (the shell was 2.8 s).
- **The game.** The rock wears its layers (`BodyVisual.wearLayers`, `src/render3d/paintLayers.ts`): each of its materials, slate or baked, is copied with up to four layer maps mixed into its colour by their coverage once the colour is final; nothing else of the rock changes.
  The paint UV is read as `aPaintUv`, an alias of `uv` (a baked tier's only with `uv1` beside it: a tier from before has no paint UV).
  A click on a layer picks it (`paintLayerAt`: the hit's paint UV read in the map's alpha, at least 0.3), just in front of its rock, since it has no mesh of its own.
- **Not shipped yet.** Nothing carries a decoration's build to production (neither `decoration.glb` nor `layer.png` is in the build's or the publish's lists); that gap is older than the layers.

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
- `scripts/test-sculpt.ts` (in `bun run test`): the binary store's round trip and refusals; the cut solid in both lenses (a point just inside and just outside the polygon's edge far from the camera included, where a prism would be wrong); Dyntopo (no edge over 4/3, closed and two-manifold, no face turned in, a settled region left as it is); undo and redo slot by slot; the commit round trip; a pinch opened for the generator (red without `separatePinches`); the migration's volumes and the refusal of a retired leaf.
- `tools/blender/test_formation_schema.py` (by hand): the schema against the add-on.
- `cli levels`: formation ids unique, a generator its guide offers, the built hash in the store.
- `cli assets`: the drawn formations published and present.

Not covered by any test: the editor's gestures (placing, dragging, painting, the gizmo on a solid node; Sculpt mode's strokes, cut, remesh, commit and undo), which were exercised by driving the real editor headlessly; and how a brush feels, which waits on being played.
