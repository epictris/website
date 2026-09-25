# The Visuals workspace

Status: in progress (plans/visuals-workspace.md).
Phases 1, 4 and 5 are in: the free view, the guides, the workspace in the editor (switching, navigation, picking through the guides, editing in the scene, the tools that work on the plane, and a prop placed or dropped on a surface), and the two generators' tools and panels (**+ Rock**, **+ Mushrooms**, see [Rocks and mushrooms](#rocks-and-mushrooms)).
Phase 6 (the docs pass and the suite) is not yet done.

The Visuals workspace is a second way of driving the one editor: a free 3D camera navigated Blender's way, with the level's editor furniture drawn into the scene instead of onto the 2D overlay.
It is for dressing a level - putting props on ledges, lights where they read, judging depth from the side it will be seen from - where the Level workspace is for authoring the level against the gameplay plane.
The model, undo, autosave, the clipboard, the selection, the active layer, the armed tool, the inspector and the outliner are shared with the Level workspace.

## Switching

The toolbar opens with a two-button switcher, **Level** and **Visuals**; **W** toggles between them.
A switch changes how the view is driven, what stands in for the overlay and which tools are offered, and nothing about what is being edited: the selection, the layer, the tool (where the other workspace offers it) and the inspector carry across unchanged.

Each workspace keeps its own view.
The Level workspace keeps its 2D camera, its orbit and its `2D / 3D / 3D + overlay` toggle exactly as they were left (that toggle is hidden while Visuals is active, since Visuals is always the scene with its guides).
The Visuals workspace keeps a `ViewPose`: the first entry seeds it from the Level workspace's view to the bit (`headOn` of the 2D camera through the level's lens, so a switch changes nothing on screen), and every later entry takes up the pose that was left.
`⟲ Reset view` (or **Home**) resets the active workspace's own view: head on, framed as the 2D camera frames the plane.

`▶ Test` works from either workspace and returns to the one it left.
A test is the player's camera and picture, so the pose and the guides are set aside for it (`VisualsWorkspace.suspend`) and taken up again when it stops (`resume`).

While Visuals is active the 2D overlay canvas draws nothing but a status line along the bottom (`drawVisualsStatus` in `editor/render.ts`), between the outliner and the inspector: how the view is driven, and what the armed tool or the selection offers here.
The canvas still receives every press; it is what the pointer is on in both workspaces.

## Navigation

| Gesture | Does |
|---|---|
| middle drag | orbit about the pose's target, at the Level workspace's rate (`ORBIT_RADIANS_PER_PX`, 0.006 rad per pixel) |
| Shift + middle drag, or right drag | pan: the target moves in the camera's right and up at its own depth, so what is at that depth under the pointer stays under it |
| wheel | dolly toward the nearest model surface under the pointer, else the gameplay plane, never through it; the point aimed at stays under the pointer (`DOLLY_PER_WHEEL`, the Level wheel's step) |
| **F** | frame the selection (what Delete and a nudge would act on), or the scene layer and the spawn when nothing is selected (`itemsBox`, `levelBox`) |
| **Home**, `⟲ Reset view` | head on, framed as the 2D camera frames the plane |
| left drag on empty space | nothing: there is no rubber band here (see Editing), and the status line says so |

A left drag never navigates in Visuals, unlike the Level workspace, where a left drag on anything unselected pans: the view is the middle and right buttons' here, and a left press is a click or a drag of what is selected.

The workspace holds its `ViewPose` (`render3d/space.ts`, see [Free view pose](render3d.md#free-view-pose)) and hands it to `Scene3D.setViewPose` every frame.
It also places the scene's camera at the pose the moment a gesture moves it (`VisualsWorkspace.apply`), so a pick made between a gesture and the next frame is answered by the view the gesture left.
Its target may leave the gameplay plane, which the Level workspace's orbit cannot say.

The gestures are pure functions from a pose to a pose, in `editor/visuals/viewControls.ts`, with the pose's own geometry (`poseEye`, `poseBasis`, `withDistance`, the distance limits) in `editor/visuals/viewPose.ts`.
Screen positions are normalised device coordinates, x right and y up.

- `orbit(pose, dYaw, dPitch)` turns about the target; the target stays at the centre of the frame and the camera at its distance, and the pitch is clamped at `MAX_ORBIT_PITCH` as the Level workspace's orbit is.
- `pan(pose, aspect, from, to)` moves the target along the camera's right and up by the world distance the pointer covered at the target's depth, so a point at that depth stays under the pointer.
- `dolly(pose, toward, factor)` scales the whole camera about the point under the pointer (a `pickSurface` hit, else the plane, else null for the target): that point stays where it is on screen, the eye moves along the ray through it and never past it, and the distance is clamped to `[MIN_VIEW_DISTANCE, MAX_VIEW_DISTANCE]` = [0.2 m, 200 m].
- `frame(pose, bounds, aspect)` centres a box and sizes the view to hold its bounding sphere across the narrower frame axis, with `FRAME_MARGIN` to spare.
- `headOn(camera, lens)` is the Level workspace's camera, to the bit.

`cli render3d`'s `visuals:` cases hold each gesture to its promise through three's own projection of the camera the pose builds, at 1e-9 in normalised device coordinates.

## What is drawn: the guides

`editor/visuals/guides.ts` builds a `Guides` group that the workspace adds to `Scene3D.editorLayer` while it is active, and removes when it is not (a raycast does not skip an invisible object, and the Level workspace's pick must not meet the guides).
It draws what the 2D overlay draws, in the overlay's colours (imported from `editor/render.ts`, `editor/model.ts` and `render/trainingGrid.ts`, never restated):

- the gameplay plane's grid at the training grid's 10 cm and 1 m spacing over the level's bounds plus 5 m, each line fading as the cell it rules shrinks toward 5 px on screen, so the plane fades into the distance and the minor lines fade as the view dollies back;
- every collision outline on a visible scene layer as a fat line (`LineSegments2`), 1.5 px in the body's colour (or the hook-proof steel, or the mud ochre), dashed where the overlay dashes it, depth test off and drawn after the scene so the collision reads through the geometry that dresses it;
- the selection in the selection orange at 2.5 px, and the pieces of a selected body in the member blue, as the overlay says the two;
- each light's icon (a pixel-sized sprite at the light's own `z`), its reach, range and wake rings and a spot's cone on the plane, and a stalk from the icon to the plane when it is off it;
- the spawn ring, the ball's footprint, the crosshair and a rolling entry's start;
- camera regions, camera paths, firefly paths and notes as their outlines on the plane;
- the selected polygon's or path's corners and edge midpoints as the overlay's handle glyphs, pixel-sized, in the item's own plane (`guidePlaneZ`);
- a tool's draft (`setDraft`), ported from the fork's `SurfaceDraftView`: the placed points, the run to the cursor or the closing edge, the warning colour for a crossed loop, and an optional shaded surface soup.

Geometry objects have no outline here, as they have none on the overlay in a 3D view: the model is what is drawn and what is picked, and the selection is shown on it (`Scene3D.setHighlight`).
Not drawn by the guides: chains, vines, anchors, a belt's wheels, a mover's route, and a rect's or circle's corner, rotate and radius handles.

A hidden layer draws nothing, and a locked layer draws but carries no pick tags.
Collision outlines are drawn per piece, so a compound body shows its seams, which the overlay's union outline does not.

Every pickable part carries a `GuideTag` (`editor/visuals/tags.ts`) as its `userData.pickTag`: `{ guide, id, index? }` with `guide` one of `outline`, `vertex`, `midpoint`, `light`, `spawn` (`id` is `SPAWN_GUIDE_ID`), `region`, `path` or `note`.
`Scene3D.pick` returns them in the same nearest-first list as the models.
The rings, the grid, the footprint and the draft are readouts and are never picked, which is the overlay's rule for a light's pool.

`sync(view)` rebuilds only when the model's revision, the selection or the layers change (a hash, no allocation, so it may be called every frame).
The draft is rebuilt only when it changes (`VisualsWorkspace.sync` compares a signature of its points and cursor, and the surface soup by identity), since each rebuild is fresh geometry.
The pixel-sized parts are resized per frame in place by `update(camera, heightPx)`, which runs from an `onBeforeRender` hook with the camera the frame is drawn through; `setResolution` is for a raycast with no frame drawn yet.
None of it needs a DOM: the icons are `DataTexture`s and three's fat lines build and raycast in bun, so the `visuals:` cases count a small model's guides and pick a corner and an outline through a real raycast.

## Picking

A press is resolved by the raycast that drew what is under the pointer first, and on the plane through the pose's camera second (`canvasWorld`, which asks `unprojectToPlane` whenever `inScene()` - the Visuals workspace, or the Level workspace turned).
The steps, in order:

1. **A handle.** If the selection is a shape open for vertex editing (a lone polygon or path), a corner or midpoint handle anywhere in the pick list is what the press means (`handleUnder`, `pickSceneHandle`).
   Anywhere, not only nearest: the guides are drawn with the depth test off, so a handle is on top wherever it is along the ray, and at a corner the outline's segments come back at the very same depth - in build order the outline is first, which a nearest-first rule would take.
   A corner beats a midpoint.
2. **A tool of the workspace's own** (`sceneToolPress`), then the plane tools both workspaces share (see Tools).
3. **The spawn**, by its ring's guide or by the disc inside it on the plane.
4. **Items**, by `pickOrder`'s rules exactly as head on: the active layer, then depth, then a collision object winning a tie with the form drawn over it, the drill-in cycle ("click the body, then click into it, then into what is behind it"), Shift to extend, Alt to drill straight to the object.
   What counts as under the pointer is widened by the guides (`itemsUnder`): an outline names its collision object (so a thin wall is hit a few pixels either side of its edge as well as inside it), a light's icon names the light, and a region, a path or a note names itself.
   A geometry object is hit by its model, as in any 3D view.
   A light is hit by its icon ONLY: it hangs at its own `z`, and a disc on the plane under it is somewhere it is not drawn.
   The 2D minimum sizes (a checkpoint's and the spawn's 12 px floor) are in 2D camera pixels, which are not the view on screen here, so they do not apply; a guide's own pick band is the floor.
5. **Empty space**: a click drops the picked corners first, then the selection, as head on; a drag does nothing and the status line says there is no rubber band.

Chains and vines are not picked on the canvas here (the guides draw neither); the outliner and the Level workspace reach them.

## Editing

- **Move on the plane**: a drag of what is selected moves it as head on (selected first, moved second), resolved in the plane the grabbed item is DRAWN in (`guidePlaneZ`: a light at its `z`, a prop at its depth), so it stays under the pointer at any angle.
  The Level workspace's turned view drags the same way.
- **The gizmo** is the one it is in a turned view, and is how things move through z, tip and size.
- **Corners**: a drag on a corner handle moves it (and the rest of the picked set at their offsets) on the item's own plane through `setPolyVerts`/`setPathVerts`, which refuse a result that is not a shape; a midpoint inserts a corner and drags it; Alt+click removes one (never below the loop's floor); Shift+click builds the set.
  Delete, the arrows and Esc act on the picked corners first, as head on (`vertexEditTarget` answers for Visuals too).
  The overlay and the guides share the press code (`pressVertex`, `pressMidpoint`), so a corner press cannot mean two different things.
- **No rubber band**: a screen rectangle is a slanted quadrilateral on the plane at any angle, so what is dragged out and what is caught could not be the same shape; Shift+click builds a set of items or corners instead.
- **Drop on surface**: Shift-drag of the selected prop (geometry object) or light puts its origin on the nearest model surface under the pointer, leaving out its own body; with Ctrl held as well a prop's up is turned onto the face's normal by the smallest turn, from the tilt it had when the drag began (`surfaceDrop.ts`: `surfacePlacement`, `alignUp`).
  It is written through the gizmo's own item handlers (`pos`, `offsetZ` or a light's `z`, `rot`/`rotX`/`rotY`), with the grid off since the point is where the face is, and it is one undo step per drag.
  Over no surface the object stays where it last landed.
  A Shift press that never travels is the Shift+click it would otherwise have been.
- Everything that is about the model rather than the view - Delete, duplicate, copy and paste (at the plane point under the pointer), nudge, merge and split, the outliner, the inspector, B (test from the plane point under the pointer) - is unchanged.

## Tools

Offered on the scene layer: Select, **+ Rect**, **+ Circle**, **+ Belt**, **+ Poly**, **+ Curve**, **+ Geometry**, **+ Rock**, **+ Mushrooms**, **+ Light**, **+ Glow**, **+ Fireflies**.
**+ Rock** and **+ Mushrooms** are the Visuals workspace's own (see [Rocks and mushrooms](#rocks-and-mushrooms)); the Level workspace does not offer them.
The other layers keep their own tools (**+ Rect**, **+ Circle**, **+ Poly**, **+ Path** on the camera layer, **+ Path** on the fireflies layer, **+ Text**, **+ Arrow**, **+ Checkpoint** on notes), since every one of them is a gesture on the plane.

- The drawing tools draw on the gameplay plane through `unprojectToPlane`.
  A rect, circle, belt, light, note or checkpoint is the real item from the press on, drawn by the guides (or, for a geometry object, by the scene) as it is sized, so it needs no draft; a polygon or path is a run of clicks whose draft is drawn in the guides (`polyDraftGuide`), in the warning colour once it would cross itself, closed by Enter or a click on its first corner.
- **+ Geometry** places a PROP with one click rather than dragging out a box: a mesh geometry object wearing the mesh last chosen in a geometry panel's `mesh` picker (`VisualsWorkspace.propMesh`, `rock-1` until one is), on a `PROP_FOOTPRINT` (30 cm) rect, under the pointer in the plane it is drawn in (a prop on a body that collides with nothing stands at `DECOR_Z`).
  With Shift the click places it on the surface under the pointer instead, and with Ctrl too it stands up along the face's normal.
  Drawn into the selected body when one is selected, as the Level workspace's `+ Geometry` is.
- **Not in Visuals**: **+ Chain** and **+ Vine**, whose gesture runs from collision outline to collision outline with a draft only the overlay draws; their buttons are hidden here, and their keys say "not in Visuals" in the status line.

Which workspace offers a tool is `TOOL_WORKSPACES` in `editor.ts` (`both`, `level` or `visuals`); a tool of the Visuals workspace's own registers its press in `sceneToolPress`, which the press handler asks before any plane gesture.

## Rocks and mushrooms

The two procedural generators ([generators](generators.md)) are driven from here: a **generated rock** fitted to a collision outline, and a **mushroom patch** grown on a model's surface inside a loop painted on it.
Both are geometry objects carrying a `generator` block ([level format](level-format.md)): which generator, its schema version, the parameters that differ from the defaults, and for a patch the loop and its host.
Their `mesh` is the key of the generated file, content-addressed, so the editor can tell a mesh that matches its block from a stale one by comparing keys, and generating the same thing twice costs nothing.
The editor never generates on its own: an edit makes the object **stale**, and **Generate** (or Ctrl+Enter) asks for the new mesh.

### + Rock

A click on a collision outline (a scene polygon or rect, by its guide line or anywhere inside it on the plane) or on the geometry object matched to one adds, as one undo step, a mesh geometry object matched to that outline (`matchCollision`) with a boulder block of defaults and no mesh, selects it, and asks for its generation.
An outline that already has a generated rock has that rock selected and generated instead of a second one stacked on it (`existingRock`).
A circle, a curve or a belt has no outline the generator fits, so the click says so.
The same is **Generate rock** beside **Add geometry** on a lone collision polygon's or rect's panel, and on the body panel of a body with exactly one.
Until its mesh arrives a rock with no mesh stands in as its outline extruded to the block's `depth` (1.6 m by default) and chamfered in toward the camera (`BOULDER_STANDIN_TAPER`, 45°, in `render3d/bodyVisuals.ts`), so its volume reads while Blender works; a regeneration keeps drawing the previous mesh until the new one lands.

### + Mushrooms

Clicks place points on the drawn surface under the pointer (`Scene3D.pickSurface`), on any scene geometry object but a patch, and a rubber band runs from the last point to the surface under the pointer.
The loop stays on the model its first point was placed on, since a patch grows on one host; a click elsewhere says so.
Enter or a click on the first point closes it, Backspace takes the last point back, and Esc drops the loop.
Closing it collects the faces inside the loop (`selectSurface`, below) and, if there are any, adds as one undo step a patch object in the host's BODY: a mesh geometry object at the middle of those faces, unturned, its rect their extent and its depth their thickness, with a mushroom block whose loop is stored in the patch's own frame and whose host is the object painted on; it is selected and its generation asked for.
A loop that covers nothing (every face under it steeper than `maxSlope`, 75° by default) stays open with a notice, for Backspace or Esc.
A patch with no mesh draws nothing at all: its rect is only the extent of the surface, and a box of that size would stand over the rock the mushrooms are for.

**The surface** (`editor/visuals/surfacePatch.ts`, ported from the fork) is judged on the loop's plane of best fit: a face is taken where its middle lands inside the loop, it faces the loop's side of the plane, it is no steeper than `maxSlope`, and it lies within a band of the plane (the loop's own deviation plus a third of its size), so the back of a rock and a wall behind it are left out.
Faces are cut down to a step of a 48th of the loop's size (1 to 10 cm) so a big facet is cut at the painted edge; a soup over `maxTriangles` is cut more coarsely, and one over it with nothing left to cut is refused rather than searched for ever (the fork's loop could not end there).
The surface is collected again from the host's CURRENT meshes every time the patch is generated, after the frame loop has rebuilt and placed the scene (a body built this instant is not placed until its first frame), so a regenerated rock is followed by a regenerated patch on demand.
It is sent in the patch's own frame (`patchMatrix`, the frame `mountVisual` draws the mesh in), so the mushrooms land where the loop was painted however the patch has been placed since.
The stored loop has no normals (the file holds points); which side of the loop's plane is out is taken from the host's middle.

**Edit loop** on the Mushrooms group shows the patch's loop closed on the host, the covered faces shaded, and its points as handles: a drag moves a point to where the pointer meets the host's surface (off the host it stays put), one undo step per drag, and the shading follows on release.
Enter, Esc or a press anywhere but a point ends it (the press then goes on as a press).

### The Rock and Mushrooms groups

A lone generated object's panel ends with its generator's group (`editor/visuals/generatorPanel.ts`, `buildGeneratorGroup`), built from the schema rather than written out:

- the **status line**: `queued`, `generating N s`, `failed:` with the check that refused it (for a rock, and the remedy), `superseded`, `stale` in the warning colour once the object is no longer what its mesh was made from, `stale: never generated`, a warning for a patch whose host is gone, or the mesh's triangles and size once current (asked of the service once per key);
- **Generate** (Ctrl+Enter while the object is selected, also from inside one of its fields), **Next seed** (the seed on by one, then Generate), **Reset** (every parameter back to its default, no generation), **Copy** and **Paste** (the parameters as JSON `{ kind, version, params }` through the clipboard, so a look moves between objects and levels; a paste of another kind's, or of a value out of range, is refused by name), and for a patch **Edit loop**;
- for a patch, what the surface was when last collected: `faces · m² · up to N mushrooms`;
- any `<name>Min` above its `<name>Max` once the defaults are in, before the server has to say so;
- then each schema group: its basic parameters, and the rest under an **Advanced** disclosure that stays open across rebuilds.

Each field is of its schema type: a number field (the step the schema's, the default as its placeholder, blank for the default, typed values held to the range), a checkbox, a picker, or a colour swatch (the linear RGB triple shown as sRGB).
The label is the key's words and its unit (`depth (m)`, `slab yaw°`), cut with an ellipsis where the panel is too narrow, and the tooltip is the schema's `doc` and default.
Lengths are in METRES here, the schema's unit, where the rest of the panel shows scene pixels: the steps, ranges and docs are all stated in metres (the file stores them in pixels like every length).
Only values that differ from the default are written (`withParam`): setting a field back to its default, or clearing it, removes the key.

The outliner row of a generated object carries the same word as a badge (`generating`, `queued`, `failed`, `stale`), and its body's row the loudest of its objects', so a collapsed body still says it holds something stale.

### Generating

A request is exactly what the key is made from: `generatorInput` (the rock's outline, or the patch's loop and a description of its host), the parameters that differ from the defaults, and the schema version this build runs, plus a patch's surface soup ([generators](generators.md#the-editors-side)).
The job client (`editor/visuals/jobs.ts`, `GeneratorJobs`) submits it, polls the job (every 250 ms at first, backing off to once a second), and when the mesh is there puts its key on the object as ONE undo step, bringing the block's `version` up to the one it was made under; nothing else about the object changes.
It does that only if the object is still there and would still be generated under that very key; otherwise the result simply waits in the service's cache for the object to come back round to it.
A result that lands during a drag waits for the drag to end (the frame loop's `jobs.flush`), so an undo step is never pushed into the middle of a gesture.
A newer Generate for the same object stops the client following the older job, and tells the service, which stops it unless it is past its bake.
`failed` is an ordinary outcome: the boulder's validators are strict ([generators](generators.md#jobs), "Failures"), and a plain 2 x 1 m rectangle fails its centre slice at the default tolerance; the panel says which check failed, and another seed or a much looser `tolerance` (it also sets the remesh voxel, so the deviation grows with it: 0.05 m still failed at 0.053, 0.1 m passed) is the answer.
On entering the workspace the editor asks the service what it has (`GET /api/generators`), and the toolbar says what is missing, if anything (Blender for both, Python and its packages for rocks).
## Not in Visuals

Each of these is the overlay's, and the guides do not draw it, so it is not offered (a handle only where the format can store its answer, and only where it is drawn):

- the rect's corner boxes, the rotate knob, a circle's radius grip, a light's reach and wake grips, the depth handle (the gizmo covers move, turn and size, and the inspector the reach and wake);
- a path's tangent grips, a belt's wheel and radius grips, a mover's route nodes and grips, an arrow note's ends;
- a chain's or vine's ends and wrap points, and picking either on the canvas;
- the rubber band.

## Keys

| Key | Does |
|---|---|
| **W** | switch workspace |
| **F** | frame the selection or the level (Visuals) |
| **Home** | head on (either workspace resets its own view) |
| Ctrl+Enter | generate the selected generated object |
| Enter, Backspace, Esc | close, shorten or drop the mushroom loop; Enter or Esc ends Edit loop |
| Esc, Delete, arrows, Enter, Ctrl+Z/Y/D/G/C/V, Tab, V R C P T A S O B | as in the Level workspace |
| K | not in Visuals (says so) |

## Where it lives

- `editor/visuals/workspace.ts`: `VisualsWorkspace` (the pose, the guides' ownership, the navigation gestures, `enter`/`leave`/`suspend`/`resume`/`resetView`/`frameBox`/`apply`/`sync`, and the pointer questions `ndc`, `planePoint`, `screenOf`, `tagsAt`, `surfaceAt`, `wheel`), plus the pick rules `handleUnder`, `itemsUnder`, `spawnUnder` and the boxes **F** frames.
- `editor/visuals/surfaceDrop.ts`: the drop's arithmetic.
- `editor/visuals/surfacePatch.ts`: `frameOf`, `collect`, `selectSurface`, `minUpOf`, the patch frame (`patchMatrix`, `loopPointToWorld`, `worldToLoopPoint`) and `soupInFrame`.
- `editor/visuals/surfaceLoop.ts`: `SurfaceLoop`, the loop being painted, and `closedDraft` for Edit loop.
- `editor/visuals/generatorEdits.ts`: the model edits the tools make (`rockSource`, `existingRock`, `rockFor`, `patchFor`, `objectPose`).
- `editor/visuals/jobs.ts`: `GeneratorJobs`, the service's client, and `missingTools`.
- `editor/visuals/generatorPanel.ts`: `buildGeneratorGroup` and its pure half (`withParam`, `clampParam`, `hexOfLinear`/`linearOfHex`, `nextSeedParams`, `paramIssues`, `paramsPayload`/`parseParamsPayload`, `generatorStatus`, `generatorBadge`, `paramLabel`).
- `editor/visuals/paramSchema.ts`: `generatorInput`, `expectedKey`, `wantedKey` (the key at the version this build runs) and `isStale`.
- `editor.ts`: the switcher, `inScene()`, the press routing, `pickSceneHandle`, `surfaceDropMove`, `placeProp`, `sceneToolPress`, `polyDraftGuide`, `visualsStatus`, and the generators' wiring (`placeRock`, `dressWithRock`, `paintLoop`, `closeSurfaceLoop`, `collectPatch`, `generate`, `editLoop`, the `jobs` host, the outliner badges).

## What green cannot see

`cli render3d`'s `visuals:` cases cover the pose seeding and its keeping across a switch, which guide a click at a corner means (through a real raycast of the guides), the drop's arithmetic, a move through z, and the boxes **F** frames.
The scene cannot be built headlessly, so the press routing, the gizmo, the drop onto a real model and every look were verified by driving `/editor` through the CDP harness; how any of it looks, the line and sprite sizes on a real canvas and the render order against transparent materials need the page.

For the generators, the `generator:` cases cover the surface a loop collects on a box (area, triangle count, the slope filter, the band, the cap), the patch frame against the one `mountVisual` builds, the objects `+ Rock` and `+ Mushrooms` add and what they save as, the panel's parameter writes (the `stripDefaults` round trip through the setters, clamping, paste, a Min over its Max), the status line, and the job client against a scripted service (one swap per finished job, supersede, a failure keeps the model, a result waits out a drag, a deleted or edited object gets nothing).
They cannot see the scene: the click on an outline, the loop painted on a real rock, the surface collected from a mesh the scene has just rebuilt, the one-undo-step claims, the panel's layout and the look of a rock or a patch were verified by driving `/editor` through the CDP harness with real Blender runs (2026-09-25), and the look is the owner's to judge.
