# The Visuals workspace

Status: in progress (plans/visuals-workspace.md).
Phases 1 and 4 are in: the free view, the guides, and the workspace in the editor (switching, navigation, picking through the guides, editing in the scene, the tools that work on the plane, and a prop placed or dropped on a surface).
The rock and mushroom tools (Phase 5) are not yet in.

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

Offered on the scene layer: Select, **+ Rect**, **+ Circle**, **+ Belt**, **+ Poly**, **+ Curve**, **+ Geometry**, **+ Light**, **+ Glow**, **+ Fireflies**.
The other layers keep their own tools (**+ Rect**, **+ Circle**, **+ Poly**, **+ Path** on the camera layer, **+ Path** on the fireflies layer, **+ Text**, **+ Arrow**, **+ Checkpoint** on notes), since every one of them is a gesture on the plane.

- The drawing tools draw on the gameplay plane through `unprojectToPlane`.
  A rect, circle, belt, light, note or checkpoint is the real item from the press on, drawn by the guides (or, for a geometry object, by the scene) as it is sized, so it needs no draft; a polygon or path is a run of clicks whose draft is drawn in the guides (`polyDraftGuide`), in the warning colour once it would cross itself, closed by Enter or a click on its first corner.
- **+ Geometry** places a PROP with one click rather than dragging out a box: a mesh geometry object wearing the mesh last chosen in a geometry panel's `mesh` picker (`VisualsWorkspace.propMesh`, `rock-1` until one is), on a `PROP_FOOTPRINT` (30 cm) rect, under the pointer in the plane it is drawn in (a prop on a body that collides with nothing stands at `DECOR_Z`).
  With Shift the click places it on the surface under the pointer instead, and with Ctrl too it stands up along the face's normal.
  Drawn into the selected body when one is selected, as the Level workspace's `+ Geometry` is.
- **Not in Visuals**: **+ Chain** and **+ Vine**, whose gesture runs from collision outline to collision outline with a draft only the overlay draws; their buttons are hidden here, and their keys say "not in Visuals" in the status line.

Which workspace offers a tool is `TOOL_WORKSPACES` in `editor.ts` (`both`, `level` or `visuals`); a tool of the Visuals workspace's own registers its press in `sceneToolPress`, which the press handler asks before any plane gesture.

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
| Esc, Delete, arrows, Enter, Ctrl+Z/Y/D/G/C/V, Tab, V R C P T A S O B | as in the Level workspace |
| K | not in Visuals (says so) |

## Where it lives

- `editor/visuals/workspace.ts`: `VisualsWorkspace` (the pose, the guides' ownership, the navigation gestures, `enter`/`leave`/`suspend`/`resume`/`resetView`/`frameBox`/`apply`/`sync`, and the pointer questions `ndc`, `planePoint`, `screenOf`, `tagsAt`, `surfaceAt`, `wheel`), plus the pick rules `handleUnder`, `itemsUnder`, `spawnUnder` and the boxes **F** frames.
- `editor/visuals/surfaceDrop.ts`: the drop's arithmetic.
- `editor.ts`: the switcher, `inScene()`, the press routing, `pickSceneHandle`, `surfaceDropMove`, `placeProp`, `sceneToolPress`, `polyDraftGuide`, `visualsStatus`.

## What green cannot see

`cli render3d`'s `visuals:` cases cover the pose seeding and its keeping across a switch, which guide a click at a corner means (through a real raycast of the guides), the drop's arithmetic, a move through z, and the boxes **F** frames.
The scene cannot be built headlessly, so the press routing, the gizmo, the drop onto a real model and every look were verified by driving `/editor` through the CDP harness; how any of it looks, the line and sprite sizes on a real canvas and the render order against transparent materials need the page.
