# Level editor

The **`/editor`** page (its own HTML page `editor.html` → `src/editorMain.ts`, distinct
from the game at `/`) runs an in-browser level editor (`src/editor/`, its own canvas loop +
DOM overlay). Dev serves `/editor` via a rewrite in `vite.config.ts`; production maps it to
`dist/editor.html` in `serve.ts`; the build emits both pages (`rollupOptions.input`). It
edits an `EdModel` (positions in world **metres**, one
stable id per body) and manipulates it with the mouse: pan (**middle**-button drag, or the
right button, or a **left** drag on anything not selected), wheel-zoom about the cursor,
click-select, drag a *selected* body to move it, corner/rotate/
radius handles to resize, and `+Rect`/`+Circle`/`+Poly` tools to draw new bodies.
**Selected first, moved second.**
A press on something already selected drags it; a press on anything else pans and selects only if the pointer never really moved (`CLICK_SLOP_PX`).
The level is what you are looking at most of the time, so dragging it about has to be the cheapest gesture there is - and nudging geometry by accident, while reaching for the view, is the one editing mistake that leaves no trace on screen: it still looks like the level, and the level is different.
`+Poly` is the one draw tool that is a run of clicks rather than a drag, because an outline
is a vertex list and not a box: each click places a vertex, **Enter** or a click on
the first vertex closes the loop, **Esc** drops it, and the title carries the count so the
gesture always says where it is up to.
The outline is taken **as clicked**, concave corners included - a C-shaped wall is one
gesture rather than three overlapping boxes, and the loader cuts it into the convex pieces
the engine needs (see [**Shapes**](physics-foundations.md#shapes)).
The convex hull is only the fallback for a draft that is not a shape at all: a loop that
crosses itself has no inside, and the draft draws in a warning colour from the click that
crosses it, so the fallback is visible before it is taken rather than as a shape that
silently is not the one drawn.
A selected polygon is then edited vertex by vertex - square handles move a corner, the
smaller round handles at the edge midpoints insert one and drag it in the same gesture, and
**Alt+click** on a corner removes it (a triangle is the floor). Every one of those goes
through `setPolyVerts`, which re-centres the loop on its centroid (so `pos` stays the centre
of mass, which the rigid-body lever arms assume) and **refuses a result that is not a
shape** - the vertex being dragged stalls at the last position the loop was simple rather
than folding the outline through itself. Denting a corner *inward* is not that and is the
point of the tool; a **camera region** is the one polygon still held convex, since nothing
cuts one up and both its containment test and its buffer zone read a notch as solid.

## Picking corners out of a shape

**Corners are selectable in their own right** (`selectedVerts` in `editor.ts`), which is a second level of selection nested inside the item one: a polygon is the item whose parts are separately editable, so once the shape itself is picked, a click, a rubber band, a Delete, a nudge and a drag can all just as well mean its corners.
Click a corner to pick it out, **Shift+click** to add or drop one, and a **rubber band from empty space** catches every corner inside it (Shift unions).
Picked corners draw as **filled** squares against the hollow ones, which is the same distinction the halo makes about a whole object: the selection orange means "an edit applies to this", and a hollow handle at every corner already means "you may drag me".
**Delete** removes them, the **arrow keys** nudge them, and dragging any one of them moves the whole set - the grabbed corner follows the pointer and the rest ride along at a fixed offset from it, exactly as a group of bodies is dragged.
**Esc**, or a click on empty space, drops the corner selection and leaves the shape selected; a second one drops the shape.

Three things about it are load-bearing.

The offsets a group drag rides at are a difference of two positions **in the shape's own frame**, because `setPolyVerts` re-centres the loop on its centroid every time it is written: the re-centring subtracts the same point from every vertex, so it leaves every difference alone where an absolute local position would drift by the centroid's own motion.

An **index means nothing once the loop it indexes is not the one on screen**, so the set is cleared by every change of selection, by undo/redo, by an Alt+click removal and by `Reverse` on a path - each of which renumbers or replaces the vertices - and read through `selectedVertIndices`, which drops anything past the current end.

And a Delete that would take the shape under its floor (three for a loop, two for an open run) removes **nothing** rather than as many as it can: "delete these four" answered by deleting two leaves a shape nobody asked for, and the corners that survived are not the ones the author would have kept.

The whole thing is the **camera path's** as well, through the same code: a path's nodes are picked, banded, nudged, dragged and deleted identically, minus the wrap, and a deletion filters its `handles` by the same indices so a node and its tangents can never come apart.
While a shape is open for vertex editing a band means its corners rather than the level's bodies, which is why clearing is two steps - it is the way back out.
`vertexEditTarget` is the one statement of when a shape is open at all (a lone poly or path, head on, with its handles actually drawn), so what a band catches, what Delete removes and what an arrow nudges cannot drift apart.

There is no `w`/`h` to type for a polygon, so the inspector shows the vertex count instead,
and beside it the **piece count** the outline builds as - 1 while it is convex, and however
many the cut produces once it is not, which is the number that says whether a fiddly corner
has quietly turned one wall into six. Both are live readouts, refreshed with the number
fields, since a drag can change them while the panel is deliberately not rebuilt.
The vertex count carries how many corners are **picked** where any are (`4 (2 selected)`) rather than taking a row of its own, because it is the same question asked twice and a row reading `0 selected` most of the time is a row that stops being read.
The cut itself is drawn on the canvas as dim dashed lines inside the selected outline
(`decomposeSeams`), because the pieces are what the physics is: the rope wraps the corners
they share with the outline and refuses their seams.
Selection is a **set**: a plain click selects one body, **Shift+click** toggles a body in or out, and dragging any member moves the whole group (the grabbed body leads the snap; the rest keep their offsets).
Dragging from empty space rubber-bands a **rectangle selection**, and the drag *direction* picks between the two CAD selection modes, as in Fusion 360 and AutoCAD: left→right is a **window** (only what the band fully encloses - every rotated corner inside, a circle by its extremes), right→left a **crossing** (anything it touches - a rotated box by SAT, a circle by its nearest point).
The mode has to be legible while the drag is still live, and the box alone cannot show a direction, so the band draws **solid** for a window and **dashed** for a crossing - the CAD convention, so it reads the same way it does there.
A drag with no horizontal travel counts as a window, so a degenerate one falls into the stricter mode.
**Shift** unions the hits into the current selection instead of replacing it, and a click that never moves clears it.
A band is dragged from EMPTY SPACE, which is what keeps it and the left-button pan apart: over nothing there is nothing to pan away from, and over a body there is nothing to band.
Resize handles only appear for a *single* selection, but the inspector is a **group panel** at
any size: every property the selection has in common is shown and every edit applies to all of
them (position and colour always; `rot°` when each body has a meaningful one, `w`/`h` or
`radius` when they are all the same shape, `force` when they are all force areas, `friction`
when none of them is an area or an anchor).
A property the bodies disagree on shows blank with a `mixed` placeholder and only writes once
something is typed into it; the kind picker gains a `mixed` entry for the same reason.
Selected bodies draw an orange halo *under* their own border,
so a hook-proof piece's dashed steel edge stays legible while selected.
**Ctrl+C / Ctrl+V** copy the selection and paste it at the cursor: the clipboard holds copies
detached from the model, and paste re-centres the group's bounding box on the pointer (with
snap on, its top-left corner lands on the grid), leaving the new bodies selected so it can be
repeated. `Ctrl+D` duplicates in place at a 2-cell offset.
**Arrow keys** nudge the whole selection one grid cell (10 cm), or 1 cm with **Ctrl** held; the
nudge is a pure translation (never snapped), so a body keeps any sub-cell offset it has and the
fine step still works with snap on. A run of nudges collapses into one undo step, ending when the
key is released.

Panels are split the way the format is, and **each is reached by selecting the thing it edits**.
An object panel carries what an object has - its form, its placement in its body, its material,
thickness, hook-proof flag and look - and nothing else; kind, friction, force and fill are the
body's, and they appear only when the **body** is selected (outliner row, or a canvas click on an
unselected body).
There is deliberately no body section above a selected object: that is exactly what made a
collision shape look like it had a `kind: static` and a friction of its own, when the file has
never had a place to put them.
The kind picker covers `static`, `rigid`, `killzone`, `force`, `water`; the **hook-proof**
checkbox is per shape, so one piece of a compound body can be the only place a hook will catch,
and it stays on the object panel for that reason (see [**Hook-proof surfaces**](hook-surfaces.md#hook-proof-surfaces)).
The **hook-only** checkbox beside it is per BODY and offered on `static` and `rigid` alike: it is what the retired `anchor` kind became, and as a flag it also says the thing a kind could not - a leaf on a sprung stem that falls, sags when it is grabbed and stops nothing (see [**Hook-only bodies**](hook-surfaces.md#hook-only-bodies)).
A `static` body's panel also carries its **scripted motion** - a swing angle and a beat make it a pendulum about its bearing, a spin time makes it a rotor about the same bearing (negative turns it the other way), and a route drawn on the canvas makes it a platform (see [**Scripted movers**](movers.md)), with a live `cm/frame` readout of how fast its surface crosses a frame, which is the one number a mover can get wrong with nothing else saying so.
The canvas marks all three: a pendulum's swept arc, a rotor's whole swept circle with a barb saying which way round, and the route as a dashed polyline.
Both the arc and the circle are drawn at `sweptReach` - the farthest CORNER from the bearing, which is the same geometry the `cm/frame` readout is computed from, so the picture and the number it is judged by cannot be about different shapes.
Measured off the shapes' centres instead, which is what it did first, a cross drawn round its own axle has every piece centred on the bearing and draws a circle of no radius at all.
The route is shaped on the canvas rather than in the panel: an amber dashed polyline with a square at every waypoint, dragged to move one, its midpoint handles clicked to insert one and Alt+click to remove one, and the body itself is waypoint zero - so moving the body carries the whole route with it, which is what makes the waypoints frame-local in the model (the same argument `pivotAt` makes).
Body fields read and write the body's **collision lead** - the object its record is written from -
and `syncBodyProps` pushes the values to the rest. Going through all the members instead put a
`mixed` in the opacity field of a body whose decoration is deliberately a different opacity from
its walls: that decoration's own opacity is not the body's, and reading it as a second opinion on
the body's fill is reading the wrong field.
The one fill that is *not* the body's is a geometry object's, which `toLevelData`
writes onto the object - and only where it DIFFERS from the body's, so a wall's primitive
takes the colour the wall is painted and states nothing, while a backdrop welded into that
body carries its own.
Every body that can be stood on carries a **surface friction** (0 = ice, 1 = rubber; see below).
Everything that is a piece of stuff rather than a region of space - every kind but the three areas, hook-only bodies included - also carries a **material** and a **thickness**, the shape's depth through the z axis the 2D view cannot show, with a live **mass** readout under them (`area × thickness × density`).
The readout is what makes either number authorable: an author is choosing a weight, and a density and a depth only become one once the shape's own size is in it. See [**Mass and materials**](physics-foundations.md#mass-and-materials); both are per shape, so a selection spanning a compound body edits its pieces individually.
A
`force` area carries a signed **force** magnitude aimed by its own `rot°` - so the rotate
knob steers the current, and force-kind circles get that knob too (a plain circle's rotation
is invisible, so it has none). A `water` area is aimed the same way and carries the two
numbers a current is made of instead: a signed **flow** speed and the **drag** rate it takes
hold at (see [**Water**](water.md)). A toggleable snap (fixed 10 cm, the
backdrop's minor-grid spacing) keeps geometry aligned - **moves** snap the body's top-left
corner, and **corner-resize** anchors the opposite corner (grows toward the drag). Each body
**Undo/redo** (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) keeps 50 model snapshots - one step per
discrete action (each drag, add/delete/duplicate, kind/colour/opacity/numeric edit); New and
Load clear the stack. Each body has an editable **colour + opacity** (inspector); defaults to
dark grey `#555555` at 0.5,
borders always drawn fully opaque in the same colour (`DEFAULT_BODY_COLOR`/`_OPACITY` in
`levelFormat.ts`, carried on the engine body as `fillColor`/`fillOpacity`, rendered the same
way in editor and game via `src/render/color.ts`). Both the editor and the game render
on the shared `src/render/trainingGrid.ts` backdrop (Smash training-mode graph paper).
The editor gains the same stacked WebGL canvas the game page has, and a three-state **view toggle**: **2D** (exactly the editor as it was), **3D** (the scene alone, for judging how a level reads) and **3D + overlay** (the default - the scene beneath, collision outlines, handles and marquee on top with every fill dropped so the geometry stays visible through the thing describing it).
The editor's free camera drives the same correspondence the game's does (see [**3D rendering**](render3d.md)), so the overlay stays pixel-locked at any pan or zoom and collision authoring is exactly as precise as it was.

**Ctrl + middle-drag ORBITS** that view (`CameraOrbit` in `render3d/space.ts`, editor-only - the game's camera is always head-on), and `⟲ Reset view` in the toolbar faces the gameplay plane again.
It is the one question the authoring view cannot answer on its own: how deep a prop reads, whether a light pool falls where the ring on the plane says it does, what a wall looks like from the side it will be seen from.
The camera swings about the point it is centred on at exactly the dolly distance the zoom asks for, so a turn is a turn - it neither zooms nor slides what it is looking at, and the reset is a return to the picture the level was authored against rather than an approximation of it (`cli render3d` asserts all three, plus that a zero orbit is the head-on camera to the bit).

**A turned view draws no overlay**, and that is the whole cost of it.
The overlay is the gameplay plane projected straight onto the screen, so at any other angle its outlines, handles and bands would sit somewhere the geometry is not - which is worse than drawing nothing, because it looks exactly like an editor that is still aligned.
So the resize handles, the rubber band and the draw tools' previews all go with it: those press like empty space, which is a pan.

**What does not go is what a click MEANS.**
Those two were run together for as long as a pick was resolved on the plane by the 2D camera, and they are different questions: a ray answers for the models (`Scene3D.pick`) and meets the gameplay plane for everything resolved against it (`unprojectToPlane`, `canvasWorld` in `editor.ts`), both at any angle.
So bodies and objects are **selected in a turned view exactly as they are head on** - the drill-in cycle, Shift, Alt, the outliner - and dragging one carries it along the plane, and the **transform gizmo** the pick puts on it is in the scene and works from any angle.
That pairing is the point of the orbit: turn the view to see the depth, then drag the blue arrow to author it, on the thing you turned the view to look at.
`unprojectToPlane` is `projectToView` backwards, and `cli render3d` asserts it as a round trip through three's own projection at a spread of orbits, plus that it is the 2D answer head on and is NOT it turned - an implementation that quietly returned the 2D answer passes the round trip at zero orbit and puts every turned-view click somewhere else.
The one thing zoom gives up there is zooming about the cursor: the zoom is a dolly along the view direction rather than a scale about the screen, so the correction would want a ray through a camera that is not built until the frame is drawn, and a turned view zooms about its centre instead.

Ctrl is on the orbit rather than on the pan because panning is how you get around a level and is wanted in every view, while orbiting is the rarer act and the one you come back from; with no scene to turn (the 2D view) Ctrl+middle simply pans like any other middle drag.

## Geometry is picked by its model, not by an outline

**A geometry object has no outline on the overlay while a scene is drawn underneath, and is selected by clicking the thing that IS drawn** (`Scene3D.pick`, `raycastItems` in `editor.ts`).
The overlay's answer to "where is this object" was a rectangle on the gameplay plane, and that is not what a geometry object is: a primitive is a solid extruded through z, and a **mesh is a prop whose silhouette the authored outline never described at all**.
A lamp bracket 10 cm across placed in a 4 m box was therefore clickable by four metres of empty air around it, and a pipe running behind a wall was clickable through the wall - the box being both the only thing drawn for it and the only thing a click could land on.
Measured on a 4 m box wearing `bulkhead-lamp`: **722 of 729 sample points inside the box selected the prop before, and 1 after** - the one that is the lamp.

The pick is a **raycast through the camera the last frame was drawn with**, so it is about the picture the pointer was actually aimed at, and it holds at any depth and through either lens where an outline test on the plane cannot.
Everything else about picking is untouched: the ray only decides whether a geometry object is HIT, and `pickOrder`'s rules (the active layer, then depth, then a collision object winning a tie with the form drawn over it) still decide which of the things under the pointer wins, so **click the body, then click into it, then into what is behind it** cycles exactly as before.
The chain tool still asks the plane, because an anchor is placed on a body's collision outline.

The chain from a mesh under the pointer back to a row in the outliner is three links, and each is somewhere different: `BodyVisual` stamps every drawn object's group with the authored object it was built from (`pickTagOf`), `toLevelData` records which ITEM wrote each object it writes, and the editor rebuilds that map with the scene so it can never name an item the picture was not built from.
The middle link is the one that can break silently - `toLevelData` writing one object per item, in item order, is an invariant nothing else in the suite depends on - so `cli render3d`'s `pick:` cases assert it directly.
The 3D half cannot be checked headlessly at all: building a `BodyVisual` needs a DOM for the generated textures, so the raycast itself is verified by driving the real page (see `reference_editor_cdp_harness`).

Two things follow from taking the outline away, and both are the same statement said again.
**Selection is shown on the model** (`Scene3D.setHighlight`), in the overlay's own colours - the selection orange, and the blue that means "this is what the selected body is made of" - applied as an emissive over the surface the object already wears, so what is lit up is the shape being judged rather than a box around it.
And **a MESH offers no handles on the plane there** (`hasPlaneHandles`), because every one of them - the corner boxes, the rotate knob, the radius grip, the depth arrow - is a point on an outline that is not drawn and that never described the prop anyway, so left in they are the box that was just taken away redrawn as squares floating in empty space.
Its handle set in a 3D view is the **transform gizmo**, which is in the scene and therefore on the thing being edited, and which covers every field a mesh has.

A **primitive** is the opposite case and keeps its plane handles in every view, because the rule is "the overlay offers handles for exactly what is drawn" rather than "a geometry object has no outline": a primitive IS its own shape extruded, so the solid under the overlay is that outline and the corner boxes land on its corners.
Suppressing them cost the cheapest edit a primitive has - drag a corner to resize it - in the view the editor opens in, and offered the gizmo's scale boxes as the only substitute.
They are projected on the gameplay plane like every other handle, so a primitive pushed off the plane by its `off z` has them where its outline is rather than where the perspective draws its face; an orbited view drops the whole overlay in any case.

In the **2D view none of this applies**: there is no scene to ask, the outline is both what is drawn and what is picked, and every handle is back.
That is not a fallback but the same rule - the overlay picks and offers handles for exactly what it draws.
An **orbited** view picks by exactly these rules (above): the ray answers for geometry as it does head on, and the collision shapes, lights, regions and notes it shares the canvas with are resolved against the plane through `unprojectToPlane` rather than through the 2D camera, so the two halves of a pick agree about where the pointer is aimed at any angle.
What it does not offer there is the plane HANDLES, for the reason this section gives about geometry objects and the orbit section gives about everything else: a handle that is not drawn must not be grabbable either.

## The lens

`⧉ Ortho` (**O**) draws the scene through an **orthographic** camera instead of the perspective one (`ViewProjection` in `render3d/space.ts`).
It is an authoring instrument, not a look: a perspective camera divides by depth, so a prop 2 m behind the plane is drawn a little smaller and pulled toward the centre of the frame - which means two things that are exactly in line in the level do not look it, and two that look it are not.
Orthographic removes the divide, so a metre is the same number of pixels at every depth and what is on screen IS the plan, which is what makes aligning off-plane geometry by eye possible at all.
Both lenses are driven from the same visible height, so the gameplay plane is framed identically through either and the overlay, the handles and the picking are unchanged by the toggle (`cli render3d` asserts both halves: the plane matches the 2D renderer to a hundredth of a view pixel, and 20 m of depth moves a point by nothing).
The two cameras both live on `Scene3D` for the life of the scene rather than one being rebuilt on the toggle, since the gizmo raycasts against whichever is current and wants something stable to be handed.
A **▶ Test is always perspective**, whatever the toggle says: the point of a test is that the framing is the player's, and the player has no lens button.

## The transform gizmo

A single selected object or body carries the standard **red/green/blue handles** in the 3D scene - arrows to move, rings to turn, boxes to size - through three.js's own `TransformControls` (`editor/gizmo.ts`).

**All three sets are on screen at once**, and there is no mode to pick between them.
`TransformControls` is a modal control - one instance draws one mode - so this is three of them sharing one proxy, nested by size: the scale boxes inside, the move arrows through them, the rotation rings around the outside.
A mode toggle is a thing to remember and to get wrong, and reaching for a ring and turning up a move arrow because the toolbar was left on `move` is an edit that looks like the level and is not it - the same mistake **selected first, moved second** exists to prevent on the plane.
Nested, the answer to "what will this drag do" is whatever is drawn under the pointer.

The sizes are read off the geometry three actually builds rather than chosen by eye: an axis handle sits at `0.5 x size` with a picker cone reaching `0.6`, and a rotation ring is drawn at `0.5` with a picker tube `0.1` thick, so `HANDLE_SIZE` puts the scale boxes at 0.056, the move arrows at 0.113 with their pickers stopping at 0.135, and the rings at 0.175 with their pickers starting at 0.14.
The **ratios** between the three are what the nesting rests on, so they are the part that must not be edited one at a time; the overall footprint is a taste call, and it is a quarter of what it first was, which puts the gizmo inside the prop it is transforming rather than around it.
The move arrows are what that costs - their heads are a `0.04` cone, so at this size they are a couple of pixels of drawn arrow - but what is grabbed is the picker, the full-width cone from the origin out, so they stay pickable at sizes they stop being legible at.

Two handles are dropped because the three sets would otherwise bury each other.
The **centre belongs to uniform scale**, that being the one handle a mesh genuinely has (its `scale` is one number, so the centre drag is exact and every single axis is an approximation of it), so the move gizmo's own free-in-the-view-plane centre handle goes - its `XY` plane handle already covers the gameplay plane, which is what that one was wanted for.
Rotation's free-rotation ball goes for the plainer reason that it is a quarter-radius sphere sitting exactly where the move and scale handles are, and scale's plane handles because two axes at once is what the MOVE gizmo means.

What the nesting cannot separate is the **pickers**, because an axis picker is a cone that is widest AT THE ORIGIN: the scale box's cone lies wholly inside the move arrow's and both cover the centre.
So a press is arbitrated (`EditorGizmo.winner`) - innermost drawn first, since at the scale box's radius the box is what is on screen and the arrow is only passing through, with the centre handle beating any axis claim because it is otherwise unreachable.
Both arbitration listeners are on the **window**, and the phase is what makes each work: three's own handlers are on the canvas, so a capturing `pointerdown` runs before them (a losing set is held off with `enabled`, since three re-runs its own hover inside its press handler and would overwrite anything decided earlier) and a bubbling `pointermove` runs after them (two lit handles under one pointer is the gizmo saying it does not know what a press would do).

It is the answer to the question the overlay cannot even ask.
The 2D canvas is the gameplay plane seen head on, so it has handles for the two axes that lie in it and no way to say "10 cm toward the camera", "tipped 15° about x" or "a bit bigger" about a mesh whose outline is not what is drawn - and those are exactly the fields a level is dressed with (`EdVisual.offsetZ`, `rotX`, `rotY`, `scale`), every one of which was a number typed into the inspector and checked by looking.
It is also the only editing there is while the view is **orbited**, which is the view those fields are judged in: the gizmo is in the scene, so it is drawn from wherever the camera is.
The two features are a pair - orbit to see the depth, drag the blue arrow to author it.

**The handles sit at the depth the object is DRAWN at**, which is `itemDepth` and not the authored `offsetZ`: a geometry object authoring no depth is drawn on the gameplay plane if its body collides and at `DECOR_Z` if it does not.
Read as a plain 0, the whole gizmo stood 35 cm in front of every piece of decoration it was attached to - invisible head on, and the first thing you see when the view is turned, which is the view it exists for.
A move is then written as a CHANGE against where the handles started rather than as the pose's own z, or nudging a backdrop sideways would stamp that fallback into the file as an authored `off z` nobody asked for.

**The gizmo never touches the model.** It moves a proxy object and the editor reads that proxy and writes the model, which is what lets it survive the scene being rebuilt from scratch on every model revision - that is, on every drag. A handle attached to a visual is attached to an object that is disposed a frame later, and re-attaching per frame is a gesture that cannot survive its own effect.

**A handle is offered only where the format has somewhere to put its answer** (`GizmoHandlers.axes`), so what is on screen is the level's real degrees of freedom rather than three of everything:

| Target | move | rotate | scale |
|---|---|---|---|
| geometry: mesh | x, y, z | x, y, z | its one `scale` |
| geometry: primitive | x, y, z | z | w/h + depth |
| collision shape | x, y | z | w/h |
| light | x, y, z | z (its aim) | - (its reach is the 2D radius handle) |
| body | x, y | z, as a delta about the centre of mass | - (a body has no size; its objects do) |

A **primitive does not tip**, and that is this table's rule rather than an exception to it.
`EdVisual.rotX`/`rotY` are carried by the holder object `mountVisual` builds for a **prop**, and it returns before that on a primitive - which is its own outline extruded along z and has nowhere to put an out-of-plane angle.
So the x and y rings on a primitive were a dial connected to nothing: the gizmo tilted, `rot x°`/`rot y°` changed, and the level went on looking exactly as it did.
`visualData` stops writing the two fields for a primitive for the same reason `mesh` has always been written only for a mesh - a pose nothing draws is not a pose the file should record.

Two consequences worth knowing before reaching for it.
A **mesh has one `scale`**, so any axis of the handle drives it, by the mean of the three factors - the uniform centre handle is exact and a single axis is an approximation of "bigger", because the file has one number and cannot record more.
And **an axis pointing at the camera cannot be dragged**, which head on is z for a move and the ring for a turn: `TransformControls` hides a handle within a few degrees of the view direction, and maps a ring drag onto the screen direction perpendicular to both the axis and the view, which degenerates as the two line up.
Turning about z head on is therefore the 2D rotate knob's job (or the outer screen-space ring, which a mesh gets since all three of its axes are authorable), and moving through z head on is the **depth handle** below.
Orbited, both gizmo handles behave normally - which is the pairing: orbit to see the depth, drag the blue arrow to author it.

## The depth handle

A selected object that HAS a z - a geometry object or a light - carries one more 2D handle: a small blue up/down arrow beside its right edge, labelled with the value in the inspector's own units.
Dragging it up moves the object toward the camera, at the same scale x and y move at, snapped to the same grid.

It exists because z is the one axis the authoring view has no direction for, and the gizmo cannot cover it in that view for exactly the same reason (above).
So the two are complements rather than duplicates: **this is the head-on control, the gizmo's blue arrow is the orbited one**, and they are drawn in the same blue so they read as the same axis.
A collision shape gets none, because it has no z at all - it is the gameplay plane, which is what makes it collision (`hasDepth` / `depthOf` in `editor/render.ts` are the one statement of both).
A light's handle sits by its source icon rather than out at its reach, for the reason a click on a light lands on the icon: the reach is as wide as the room it lights.

Snapping is the editor's own: the same 10 cm grid and 15° step the 2D drags use, including on the sizes a scale drag writes (`scaleShape`'s `round`), so a gizmo drag and a handle drag cannot land a body in two different places.
The scene is rebuilt in full from the model whenever `modelRev` moves - the model is a couple of hundred shapes, and correctness beats a diff of what an edit touched - through the same `buildLevelBodies` the game loads with, so what is on screen while editing is what will be played rather than a second interpretation of the same file.
Chains stay on the 2D canvas there, and deliberately: the editor draws a chain **straight** because a span between wrap nodes is straight, and solving them to draw them would be a second simulation running under the editor.
A geometry object's panel authors what it is drawn as (**kind** - `primitive` or `mesh` - plus mesh, depth, bevel, texture) alongside the placement and size every object has, since a geometry object states its own form and those fields are what say it.
`mesh` gets a badge on the canvas in the **2D view**, being the one kind whose outline is not what the player sees; a primitive is drawn as exactly the shape on screen, so a badge on it would be a mark on almost every object saying nothing.
In a 3D view the prop itself is drawn, so the badge would be a mark pointing at the thing it is standing on, and it is not drawn (see **Geometry is picked by its model**).

`▶ Test Grapple` / `▶ Test Ball` build a real `Level`/`BallLevel` from
the current model and run it inline (with the real camera, so a camera region is felt exactly as it will play); **Esc** returns to editing.
A test uses the real game render path, so it gets the 3D scene for free - drawn into the letterboxed frame rather than the whole canvas, since the bars are not part of the picture the player is shown.
A test also plays in the game's own fixed 1920 × 1080 frame, fitted into the editor canvas and letterboxed (see [**The view**](camera.md#the-view)): the point of ▶ Test is that the framing is what the player gets, and an editor-window-shaped view showed a different slice of the level from the one it will be played on.
**B** is the same ball test but spawned **at the cursor**, so a corner of the level can be spot-checked without walking the spawn marker over to it and back.
The override is baked into the `LevelData` the test level is built from rather than into the model, so it never edits the level, and a reset (and the exported P bundle) respawns at the same point.
