# Editor UX pass (after editor-owns-the-level)

Requested by Tris on 2026-11-22, after testing the formations work.
The aim: testing from the editor should feel exactly the same as playing the level.

## The list, as asked

1. Default movement is 3D.
2. Replace "Reset view" with "Align camera to plane".
3. While orbiting, every control, outline and gizmo stays visible.
4. F with an object selected focuses the orbit on that object.
5. Managing boolean (solid guide) objects is much more intuitive; today it is fiddly. The shape is open: design it.
6. Depth of field is on when testing through the editor.
7. Backdrop bodies get full 3D gizmos, not locked to the 2D plane. This needs bodies to be explicitly 2D or 3D.
8. Then audit the new UX for further improvements, using any tool-design skills found online.
9. The painted area of moss and ivy reads as a region of dots, as in Blender, not a pile of discs.
10. Painted areas (and other authoring marks) are not visible when testing.

## Decisions

- Items 1 to 4 (2026-11-22, Tris): **one 3D editor**. The Level and Visuals workspaces merge: always the free 3D camera (middle drag orbits, Shift + middle or right drag pans, the wheel dollies), every outline and handle drawn in the scene so it works from any angle (porting what Visuals lacked), and "Align camera to plane" returns head on. W and the workspace switch go.

- The rule for every choice (Tris, 2026-11-22): the 3D editing environment should feel **familiar**; no need to reinvent the wheel. Where Blender and Unity agree, do what they do (navigation, framing, gizmo, hierarchy, boolean modifiers); invent nothing a 3D artist would have to learn.

## Design of the one 3D editor

The overlay (`editor/render.ts`, 3,300 lines) draws in world units through a canvas transform, which has no perspective, so it vanished whenever the view turned; the Visuals guides redrew a subset of it in the scene.
Rather than port the rest into the guides and keep two renderers of the same chrome, the overlay is **projected**:

- The 2D `Camera` can carry the 3D view's projection; `worldToScreen` and `screenToWorld` go through it when it does, so every hit test and drag already written against the 2D camera works at any angle.
- The overlay draws through a projecting context: each world point is carried through the 3D camera onto the screen (lines stay lines; arcs and large rects become polylines first; segments are clipped at the near plane). Line widths, dashes and fonts are in head-on pixels, so the chrome keeps its weight.
- Small glyphs (handles, icons, labels) are drawn screen-sized at their projected centre, as Blender draws its overlays; large shapes (a circle body, a light's reach) are projected as what they are.
- Things with a depth (a light's `z`) are drawn at it.
- The free 3D camera is the only navigation (the Visuals gestures); the 2D camera is derived from it each frame. The Level/Visuals split, W, the 2D/3D/overlay toggle and the guides go.

Keys, by the familiar convention: middle drag orbit, Shift + middle (or right) drag pan, wheel dolly, **F** frame the selection and orbit about it (Unity), **Home** frame everything (Blender), **Numpad 1** align to the plane (Blender's front view, also the "Align camera to plane" button), **Numpad 0** the game camera (Blender's camera view).

## Design of 2D and 3D bodies (item 7)

The format holds that a body is a thing in the gameplay plane and has no depth, because the sim has no third axis.
That stays true of every body with collision: a **2D body** (the default) is exactly what it was.
A **3D body** (`space: "3d"` on `LevelBodyData`) is one with nothing the sim sees: no collision objects (the lint refuses one), only what is drawn - its formation, decorations, models, lights.
Its frame gains `z` (pixels on disk, metres in memory, toward the camera) and `tilt: [x, y]` (radians, applied before the in-plane `rot`), and everything in it is drawn in that frame, in the game and in the editor (the body's root group; the solid guides; the decorations' formation frame).
In the editor, the Backdrop tool makes 3D bodies; a collision-free body's inspector offers 2D / 3D; a selected 3D body carries the full gizmo (move x, y, z; turn about all three axes), a 2D body the plane's (move x, y; turn about z).

## Design of the boolean stack (item 5)

Chosen by Tris (2026-11-22): a **flat shape stack**, as Blender's boolean cutters, MagicaCSG and Womp have it.

- A solid guide is presented as an ordered list of shapes, each **Add**, **Subtract** or **Intersect**, applied top to bottom; the first is the base.
- The level format is unchanged (the generator receives the same tree): the stack is read from the tree as a left fold and written back as one (`[a, b+, c-, d-, e∩]` is `intersection(difference(union(a, b), c, d), e)`), so a guide that is a fold round-trips exactly and an existing hash is untouched until it is edited. A subtree that is not a fold appears as one **Group** row (explicit nesting, opened in place).
- In the viewport each shape's wireframe is drawn in its mode's colour (Add the guide colour, Subtract red, Intersect amber) and is picked by a click; the picked shape carries the gizmo (move, turn, size).
- Shift+A adds a shape (box, ellipsoid, extrude, hull) at the view's centre; rows reorder by drag; each row has its mode toggle, a hide (excluded from the preview only) and delete.

## Status

Done and checked in the headless editor (2026-11-22):

- 6, 10: ▶ Test draws the depth of field at the player's saved setting (the frame target is now the picture's size, so the letterboxed test is blurred as the game is; game shots byte-identical before and after) and hides `Scene3D.editorLayer` (paint, solid guides) for the test.
- 9: the paint preview is the stamp brush's coverage dots (`editor/paintCoverage.ts`, matched to stampbrush/geometry.py's `composite` at 6.5e-8; cases in scripts/test-formations.ts).
- 1-4 (first pass): `editor/projectedCanvas.ts` (`ViewProjector`, `ProjectedContext`, homogeneous clipping to a guard band); `Camera.project/unproject`; the workspace object is the editor's camera (`visuals.showGuides = false`, `inVisuals()` is false, entered at boot); the 2D camera is read off the pose each frame (`cameraFromPose`); middle orbit, Shift + middle / right pan, wheel dolly, left drag on an unselected body pans the pose, empty-space drag is the band at any angle; handles, tools, corners and routes work turned; F / Numpad . frame the selection (solid guides by their drawn box, `focusBox`), Home frames all, Numpad 1 aligns, Numpad 0 game camera; the toolbar is Level | Assets and Overlays | Align camera to plane | Ortho | Game camera. `cli render3d` cases: head-on projection equals the 2D camera; turned output stays in the guard band.

- 7: `LevelBodyData.space/z/tilt` (scaled, lint "a 3D body holds nothing that collides"), `placeBody3d` in render3d/space.ts for the game's body root, `EdModel.bodies3d` (load, save, clipboard, duplicate, undo), `editor/space3d.ts` (`itemMatrix`, the resolver) for the solid guides and decorations, `body3dHandlers` (move x/y/z, turn x/y/z at the body origin), the inspector's space 2D | 3D with z and tilts, Backdrop makes 3D bodies, migrate-scene writes `space: "3d"`. Cases in scripts/test-formations.ts. ball.json's 25 backdrops are still 2D (needs Tris's editor closed to convert).

- 5 (first pass): `formation/solidStack.ts` (stackOf/treeOf left fold, setMode/moveEntry/removeEntry/appendEntry), the panel's stack rows (mode badge cycling Add/Subtract/Intersect, drag to reorder, delete), cutters red and intersections amber in the view with click-to-pick of any shape but the base (`SolidGuideView.pickShape`), Shift+A add-shape menu, new shapes placed at the guide's middle (`guideCentre`). Not yet: the per-row hide (eye), opening a Group row in place.

- Cleanup: the Visuals routing is out of editor.ts (`inVisuals`, the guides' pick and status line, the tool-workspace table); docs/editor.md ("The 3D view", the test's picture), docs/editor-visuals.md (marked merged), docs/formations.md (the stack, the paint dots), docs/level-format.md ("2D and 3D bodies") and rope/CLAUDE.md are updated.

- 8 (audit, first pass): fixed - a middle or right drag that starts over the gizmo navigates (the gizmo's hover swallowed it); a `<label>` field row that forwarded a click to the first of two buttons. Found, for Tris to prioritise: see "Audit findings" below.

- Clicking a backdrop's guide selects it (Tris, 2026-11-22): every solid guide has an invisible pick surface (`SolidGuideView.pickGuides`) that `raycastItems` adds; a guide met only behind the gameplay plane ranks after what the plane holds there (`pickCandidatesAt`). Checked headless: a guide click selects the backdrop, a click where the floor slab overlaps the guide selects the slab.

## Audit findings (2026-11-22, not yet acted on)

1. Left drag on an unselected object pans; in Blender and Unity it selects and moves (or box-selects). The editor's "selected first, moved second" rule is deliberate, so this is Tris's call.
2. Number fields clip their values (a body's x reads "977.4(" at 1600 px wide).
3. Inspector sections open collapsed, so a new backdrop's stack and a body's Transform are below a click; the section a tool just made should open.
4. No on-screen key hints since the Visuals status line went: a one-line status bar (Blender's) with the navigation keys and what the selection offers.
5. The selection tint on a body in the scene is a strong blue wash over the whole rock; an outline (Blender's) would keep the rock readable.
6. A 3D body's plane mark (the overlay's formation glyph) is drawn on the gameplay plane at the body's x, y, not at its depth.
7. Lights are drawn on the plane in the projected overlay rather than at their `z` (`atDepth` exists, unused).
8. Shift+A says nothing when no solid formation is selected.
9. "Origin to COM" is shown (disabled) on a 3D body, where it has no meaning.

Next:

- `visuals/guides.ts`, `draftView.ts`, `tags.ts` and `drawVisualsStatus` are now unused by the editor (the workspace still constructs its guides object; the `visuals:` cases still exercise them): delete with the cases that cover only them.
- Lights drawn at their `z` in the projected overlay (`atDepth`).
- The stack's per-row hide, and opening a group row in place.
- ball.json's 25 backdrops to 3D bodies (needs Tris's editor closed).
- 5: boolean (solid guide) management, designed after Blender's boolean modifier stack and Unity ProBuilder.
- 8: audit, and search for tool-design skills.
