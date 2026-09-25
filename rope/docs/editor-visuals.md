# The Visuals workspace

Status: in progress (plans/visuals-workspace.md).
Phase 1 is in: the free view's arithmetic and the guides the workspace draws into the scene.
The workspace itself - the switcher, the gestures wired to the pointer, picking through guides, the rock and mushroom tools - is not yet in the editor, so nothing below is reachable from `/editor` yet.

The Visuals workspace is a second way of driving the one editor: a free 3D camera navigated Blender's way, with the level's editor furniture drawn into the scene instead of onto the 2D overlay.
The model, undo, the selection, the inspector and the outliner are shared with the Level workspace.

## The view

The workspace holds a `ViewPose` of its own (`render3d/space.ts`, see [Free view pose](render3d.md#free-view-pose)) and hands it to `Scene3D.setViewPose`.
Its target may leave the gameplay plane, which the Level workspace's orbit cannot say.

Navigation is pure functions from a pose to a pose, in `editor/visuals/viewControls.ts`, with the pose's own geometry (`poseEye`, `poseBasis`, `withDistance`, the distance limits) in `editor/visuals/viewPose.ts`.
Screen positions are normalised device coordinates, x right and y up.

- `orbit(pose, dYaw, dPitch)` turns about the target; the target stays at the centre of the frame and the camera at its distance, and the pitch is clamped at `MAX_ORBIT_PITCH` as the Level workspace's orbit is.
- `pan(pose, aspect, from, to)` moves the target along the camera's right and up by the world distance the pointer covered at the target's depth, so a point at that depth stays under the pointer.
- `dolly(pose, toward, factor)` scales the whole camera about the point under the pointer (a `pickSurface` hit, else the plane, else null for the target): that point stays where it is on screen, the eye moves along the ray through it and never past it, and the distance is clamped to `[MIN_VIEW_DISTANCE, MAX_VIEW_DISTANCE]` = [0.2 m, 200 m].
- `frame(pose, bounds, aspect)` centres a box and sizes the view to hold its bounding sphere across the narrower frame axis, with `FRAME_MARGIN` to spare.
- `headOn(camera, lens)` is the Level workspace's camera, to the bit.

`cli render3d`'s `visuals:` cases hold each gesture to its promise through three's own projection of the camera the pose builds, at 1e-9 in normalised device coordinates.

## Guides

`editor/visuals/guides.ts` builds a `Guides` group that the workspace adds to `Scene3D.editorLayer`.
It draws what the 2D overlay draws, in the overlay's colours (imported from `editor/render.ts`, `editor/model.ts` and `render/trainingGrid.ts`, never restated):

- the gameplay plane's grid at the training grid's 10 cm and 1 m spacing over the level's bounds plus 5 m, each line fading as the cell it rules shrinks toward 5 px on screen, so the plane fades into the distance and the minor lines fade as the view dollies back;
- every collision outline on a visible scene layer as a fat line (`LineSegments2`), 1.5 px in the body's colour (or the hook-proof steel, or the mud ochre), dashed where the overlay dashes it, depth test off and drawn after the scene so the collision reads through the geometry that dresses it;
- the selection in the selection orange at 2.5 px, and the pieces of a selected body in the member blue, as the overlay says the two;
- each light's icon (a pixel-sized sprite at the light's own `z`), its reach, range and wake rings and a spot's cone on the plane, and a stalk from the icon to the plane when it is off it;
- the spawn ring, the ball's footprint, the crosshair and a rolling entry's start;
- camera regions, camera paths, firefly paths and notes as their outlines on the plane;
- the selected polygon's or path's corners and edge midpoints as the overlay's handle glyphs, pixel-sized, in the item's own plane (`guidePlaneZ`);
- a tool's draft (`setDraft`), ported from the fork's `SurfaceDraftView`: the placed points, the run to the cursor or the closing edge, the warning colour for a crossed loop, and an optional shaded surface soup.

A hidden layer draws nothing, and a locked layer draws but carries no pick tags.
Collision outlines are drawn per piece, so a compound body shows its seams, which the overlay's union outline does not.

Every pickable part carries a `GuideTag` (`editor/visuals/tags.ts`) as its `userData.pickTag`: `{ guide, id, index? }` with `guide` one of `outline`, `vertex`, `midpoint`, `light`, `spawn` (`id` is `SPAWN_GUIDE_ID`), `region`, `path` or `note`.
`Scene3D.pick` returns them in the same nearest-first list as the models; at a corner the outline's segments and the handle are at one depth, so the caller prefers a handle.
The rings, the grid, the footprint and the draft are readouts and are never picked, which is the overlay's rule for a light's pool.

`sync(view)` rebuilds only when the model's revision, the selection or the layers change (a hash, no allocation, so it may be called every frame).
The pixel-sized parts are resized per frame in place by `update(camera, heightPx)`, which runs from an `onBeforeRender` hook with the camera the frame is drawn through; `setResolution` is for a raycast with no frame drawn yet.
None of it needs a DOM: the icons are `DataTexture`s and three's fat lines build and raycast in bun, so the `visuals:` cases count a small model's guides and pick a corner and an outline through a real raycast.

What green cannot see: how any of it looks, the grid shader, the line and sprite sizes on a real canvas, the render order against transparent scene materials, and the per-frame hook actually firing - all of that needs the page.
