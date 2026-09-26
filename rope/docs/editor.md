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
This page is the editor's **Level** workspace; the toolbar's switcher (**W**) turns the same editor into the **Visuals** workspace, a free 3D view for dressing the level and generating rocks and mushroom patches ([Workspaces](#workspaces-level-and-visuals), [editor-visuals](editor-visuals.md), [generators](generators.md)).
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
through `setPolyVerts`, which **refuses a result that is not a
shape** - the vertex being dragged stalls at the last position the loop was simple rather
than folding the outline through itself. Denting a corner *inward* is not that and is the
point of the tool; a **camera region** is the one polygon still held convex, since nothing
cuts one up and both its containment test and its buffer zone read a notch as solid.

**A corner edit moves the corner and nothing else.**
`setPolyVerts` leaves the item's `pos` exactly where it is, and the shape's origin is placed once - by `centreShapeOrigin`, when the outline is first clicked out, onto the drawn loop's centroid (a curve's onto its node average).
It used to re-centre on every write, which kept a polygon's origin its own centre of mass and made every corner drag a **move of the object inside its body**: the shape being dragged stayed put on screen while its placement slid by the centroid's own motion, so the inspector's `x`/`y` for it walked away from zero and a `matchCollision` prop - which copies the collision object's placement as well as its outline - walked across the level with them.
Fitting a collision outline to the mesh it is being fitted *to* moved the mesh, which is the one thing that edit may not do.
What the re-centring was for is still true and is answered from the outline instead: `shapeCentre` gives a shape's own centre of area (a polygon's centroid, a curve's stroke, a rect's or circle's origin), and `bodyCentroid` weighs the body's pieces at those points, so the point the editor turns a body about is still the one `mountPieces` mounts it at.

## Waking lights: `+ Glow` and the awake preview

A point light's panel has a `wake` field below `flicker` (canvas pixels like the reach, metres on disk; blank or 0 is a light that is always on), and with it set, `delay s`, `rise s` and `fall s` (0.05 steps, floored at 0, blank for the renderer's default).
They are the fields of a **waking light** - see [**Waking lights**](lighting-and-surfaces.md#waking-lights).
A spot shows none of them, and turning a waking light into a spot clears its `wake` with a notice in the status line, since the pool that serves waking lights is point lights.
The `shadows` box greys out while `wake` is set: a waking light casts no shadow, and the authored flag is kept so turning the wake off gives it back.

On the canvas the wake is a dashed ring in the light's colour, with longer dashes than the reach's, drawn at the distance itself rather than cut by `z`, because the trigger is measured on the gameplay plane; a round grip on its left drags it like the reach's grip on the right.
The label says `wakes N`.

**`+ Glow`** (beside `+ Light`) places a glowing mushroom with one click: one static body holding a solid purple cube (`GLOW_CUBE` 0.3 m square and deep, `GLOW_COLOR` `#8a3fd6`, glowing `GLOW_EMISSIVE` `#b070ff` at 2), the collision rect it mirrors (`matchCollision`), and a waking point light at its centre (colour `GLOW_EMISSIVE`, `range` 4 m, `intensity` 6, `wake` 3 m, `wakeDelay` 0.25, `wakeRise` 0.6, `wakeFall` 1.5).
It goes through the same loader a level and a paste come in by (`glowModel`), so it is exactly what a file holding that body loads as, and it is one body, so the outliner shows one row and it drags as one.
Those numbers are editor defaults in `editor/model.ts`, not format defaults, and all of them wait on a play; a mushroom on a far wall can lose its collision object.
The cube is a stand-in until the mushroom model exists, and nothing about the light changes when it does.

**The 3D preview shows every waking light AWAKE** (`Scene3D.setGlowPreview(true)`, `LightRig.previewAwake`): each source is held at full without stepping its state, and the pool is spent nearest the view's centre instead of the ball.
There is nobody in the editor's scene to wake anything, and an author has to see what a mushroom lights before anyone does.
**▶ Test** turns the preview off, so a test wakes them for the ball exactly as the game does.

## Fireflies: `+ Fireflies`

A point light's panel has a `fireflies` field above `wake` (a whole count, blank or 0 for an ordinary light, capped at `FIREFLY_MAX`).
With it set the light is a **firefly swarm** (see [Fireflies](lighting-and-surfaces.md#fireflies)): `wake` is where the swarm notices the ball (blank = `DEFAULT_FIREFLY_NOTICE`, shown as the placeholder), the three wake times go away since a swarm is never dark, and `shadows` greys out as for a waking light.
Turning a swarm into a spot clears `fireflies` and `wake` with a notice in the status line.
On the canvas the notice distance is the same dashed ring and grip as a waking light's, drawn at the default when `wake` is blank, and the label says `N fireflies · notice D`.

**`+ Fireflies`** (beside `+ Glow`) places a swarm with one click: a static body holding only the swarm's light, `FIREFLY_COUNT` (12) motes, `wake` `FIREFLY_NOTICE` (2.5 m), `z` `FIREFLY_HOME_Z` (0.5 m) so the knot hangs in the air in front of the rock, and the firefly's own colour, intensity and reach left to the renderer's defaults.
There is no collision: the ball flies through fireflies.

In the editor's 3D view a swarm hovers at its home: the ball drawn at the spawn is not a player, and the preview (`LightRig.previewAwake`) hands no ball to the swarms - before 2026-09-25 it did, and a swarm authored within notice of the spawn flew off its home to hover by it; **▶ Test** has them follow the ball as the game does.

### Firefly paths: the `fireflies` layer

A swarm can be given a route of its own instead of the camera paths: a **firefly path** (see [Fireflies](lighting-and-surfaces.md#fireflies)), authored on the `fireflies` layer (between `camera` and `notes`) with **`+ Path`**, which draws it exactly as a camera path is drawn and edited - click out the nodes start to end, Enter to finish, drag a node or its round grips, an edge midpoint to insert one, Alt+click to remove one, and `Reverse` / `Smooth` / `Sharpen` in its panel.
It carries no framing and no keys, so its panel has only the placement, those three actions, and which swarms follow it.
Each path is numbered (`firefly path N`, minted on draw, kept through a save, fresh on a duplicate), and a swarm's panel has a `path` field under `fireflies` that takes that number; blank (the `camera` placeholder) is the camera paths.
A number naming no path is said under the field, since in play it silently reads as blank.
Duplicating a swarm keeps its `path`; duplicating a swarm together with its path points the copy at the copied path.

On the canvas a firefly path is a dashed line in the firefly's colour with the camera path's direction arrows, a ring at its START (where a swarm that has left the player waits) and a bar across its END (where it leaves them), labelled at the start with its number and how many swarms follow it; a swarm's label gains `path N`.

## Conveyor belts

`+ Belt` (beside `+ Circle`) lays a **conveyor**: press where the first wheel goes and drag to the second, or click to drop a two-wheel belt 1.5 m long running right at 1 m/s on 10 cm wheels under a 5 cm band (see [**Conveyor belts**](conveyors.md)).
The item's own position IS wheel 0, so the ordinary move gesture places the belt and the rotate knob turns it about that wheel.

- Every wheel has a **square grip** at its centre, dragged like a path vertex; wheel 0's is the item's position, so pressing it picks the wheel and moves the whole belt.
- Every wheel has a **round grip** on its rim, facing away from the middle of the belt, the grip a curve's tangent wears, which drags that wheel's radius.
- Every run has a **midpoint handle**, which inserts a wheel there - sized as the smaller of the run's two wheels and set so its band just touches the run, which changes nothing about the loop - and drags it straight away, the path's insert gesture.
- **Alt+click** on a wheel's square removes it, never below two; removing wheel 0 moves the item onto the wheel that takes its place, so the belt stays put.
- Pressing a wheel's square or its radius grip **picks** it (the square fills), and the panel shows that wheel's `r`.

Every one of those, the inspector's fields and the gizmo's scale go through `setBelt`, which **refuses wheels that make no belt** - a wheel inside the hull the others make, a disc inside another, a radius or a thickness under a pixel - asking the build's own loop, so the grip stalls at the last belt, as a polygon's corner stalls at the last simple loop, because the editor rebuilds the level from the model on every edit and a belt the build refuses would take the preview down mid-drag.
The panel has `thickness` (the band's depth in the plane, px as every length there), `width` (how wide the band is across the pulleys: it writes the geometry twin's `depth`), the twin's `texture` (`color` is the flat fill, which keeps the cleats), `speed m/s` (signed: positive runs the loop clockwise on screen), the picked wheel's `r`, and two readouts, the loop's **perimeter** and one **lap** of its surface, `P / |speed|`; a belt with no geometry twin says `Add geometry` gives it one instead of `width` and `texture`.
The outline is `outlineOfData`'s, the one the game draws - the band, hollow inside - with the tread ticks STANDING STILL (nothing runs in the editor) and a small arrowhead over the middle of the longest run saying which way it runs, which a still tread cannot.
The wheels are drawn as editor marks the game does not draw: a thin circle at each wheel's own radius and a dot at its centre.
A click in the hollow between the wheels passes through the belt to whatever an author has put inside it; the band and the wheels pick it, which is where it collides.
A belt builds only on a static body that does not move, and that is a fact about the BODY: a kind change or a merge can break it after the belt is drawn.
The editor does not throw on it - the title says `DOES NOT BUILD:` and the build's own message, the 3D view keeps the last scene that built, and ▶ Test refuses to start - so the author sees what to undo.
The file still saves, and the game refuses it as loudly as the build does.

## Picking corners out of a shape

**Corners are selectable in their own right** (`selectedVerts` in `editor.ts`), which is a second level of selection nested inside the item one: a polygon is the item whose parts are separately editable, so once the shape itself is picked, a click, a rubber band, a Delete, a nudge and a drag can all just as well mean its corners.
Click a corner to pick it out, **Shift+click** to add or drop one, and a **rubber band from empty space** catches every corner inside it (Shift unions).
Picked corners draw as **filled** squares against the hollow ones, which is the same distinction the halo makes about a whole object: the selection orange means "an edit applies to this", and a hollow handle at every corner already means "you may drag me".
**Delete** removes them, the **arrow keys** nudge them, and dragging any one of them moves the whole set - the grabbed corner follows the pointer and the rest ride along at a fixed offset from it, exactly as a group of bodies is dragged.
**Esc**, or a click on empty space, drops the corner selection and leaves the shape selected; a second one drops the shape.

Three things about it are load-bearing.

The offsets a group drag rides at are a difference of two positions **in the shape's own frame**, and that frame stands still through a corner edit (`setPolyVerts` writes the loop and moves nothing), so an offset captured at the press still names the same corner however far the drag goes.

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
**Ctrl+C / Ctrl+V** copy the selection and paste it at the cursor, and they go through the
**system clipboard**, so a copy in one tab pastes into another - and into another LEVEL, which is
how an assembly built once (a finish gantry, a lamp, a rail rig) reaches the rest
of the game. What is on the clipboard is a fragment of a level file in the on-disk pixel form
(`src/editor/clipboard.ts`), produced by the same `toLevelData` a save runs, so the round-trip
cases that hold a save lossless hold a copy lossless too - and a payload can be read, edited or
written by hand.
Paste re-centres the group's bounding box on the pointer (with snap on, its top-left corner lands
on the grid), leaving the new bodies selected so it can be repeated. `Ctrl+D` duplicates in place
at a 2-cell offset and touches no clipboard.

Two things fall out of it being the system clipboard. The shortcuts are `copy` and `paste`
listeners on the document rather than cases in the keydown switch, because those are the only
events that may touch it and neither fires when a keydown handler has already cancelled the key.
And a paste of text that is not a payload does nothing rather than failing - what is on the
clipboard is whatever was last copied anywhere, and a sentence is not a mistake the author made.
It does nothing *at all*: there is no fallback to this tab's own last copy.
The fallback used to be there, and it made the editor paste on its own.
On Linux the browser pastes the X primary selection when the **middle button is released**, and it
does that by dispatching a `paste` at the page - over the canvas, with nothing editable under it,
the event still reaches the document listener carrying whatever text was selected (often none).
Every middle-drag of the view therefore ended in a paste, because text that was not a payload fell
through to the last copy.
So the fallback is gone, and a paste that arrives between a middle-button press and its release is
declined outright: that button means **pan**, and a pan has to be able to end without the level
gaining a copy of something.

A paste **remints anchor ids**, which are content in the file rather than page state: pasting into
a level that already holds anchor 1 would otherwise leave two of them and a chain naming either.
It also carries each body's **frame** (`EdModel.bodyFrames`), so a compound body whose origin was
deliberately put at its bearing arrives turning about that bearing rather than about a corner of
whichever piece was written first - which `Ctrl+D` got wrong until the frames were carried too.
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

### Inspector layout: sections and hover help

A selection's panel keeps its title (`Collision #12`, `Body #3 — rigid`) in view, and every property under it sits in a **collapsible section**, collapsed by default: Transform, Surface, Material, Look, Texture, Emission and Fill on an object; Transform, Physics, Bounce, Breakable, Pivot, Spring, Mover, Rock and Fill on a body; and so on for chains, vines, camera regions and paths, lights and notes.
The level-wide blocks at the top (Level, Player spawn, Environment, 3D camera) are sections of their own.
Action buttons (Merge, Split, Duplicate, Delete) stay outside the sections, always in view.
A section's open state is keyed by name per panel kind (`object/Surface`, `body/Mover`), so opening Surface on one wall opens it on the next, and it survives the inspector's rebuilds and a reload (localStorage, `rope.editor.openSections`).
A section a build leaves empty is dropped (`pruneEmptySections`).

Descriptions are not printed in the panel.
They are **hover help**: a name with a dotted underline (a field's label, a section's header, a panel's title) shows its description in a popup beside the inspector while the pointer rests on it, and at no other time.
Live status stays printed: warnings (a vine's light links, a missing firefly path, the shadow budget), readouts, the checkpoint URL, a generator's status line.
The helpers are `src/editor/panelUi.ts` (`section`, `fieldRow`, `heading`, `describe`); new panel text goes through `describe`, never a paragraph under the field.
A geometry object's whole placement is in its Transform section: its depth off the plane (`visual.offsetZ`) is `z`, after `x` and `y`; `rot x°` and `rot y°` follow `rot°`; a mesh's `scale` comes last.

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
Load clear the stack.
Every colour field in the editor is a swatch that opens the editor's own picker (`src/editor/colorPicker.ts`: saturation/value square, hue strip, hex field; Escape or a click elsewhere closes it), not `<input type="color">`.
The native picker is a browser popup placed by Chromium from where it thinks its window is, and under Wayland it is never told, so opened from the inspector at the right edge of a maximised window it ran off the screen.
The page's picker is clamped into the viewport, flips above the swatch when there is no room below, follows the inspector as it scrolls, and takes its undo step on the first change rather than on opening.
Each body has an editable **colour + opacity** (inspector); defaults to
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
So bodies and objects are **selected in a turned view exactly as they are head on** - the drill-in cycle, Shift, Alt, the outliner - and dragging one carries it along the plane it is drawn in (a light at its `z`, a prop at its depth, so it stays under the pointer), and the **transform gizmo** the pick puts on it is in the scene and works from any angle.
That pairing is the point of the orbit: turn the view to see the depth, then drag the blue arrow to author it, on the thing you turned the view to look at.
`unprojectToPlane` is `projectToView` backwards, and `cli render3d` asserts it as a round trip through three's own projection at a spread of orbits, plus that it is the 2D answer head on and is NOT it turned - an implementation that quietly returned the 2D answer passes the round trip at zero orbit and puts every turned-view click somewhere else.
The one thing zoom gives up there is zooming about the cursor: the zoom is a dolly along the view direction rather than a scale about the screen, so the correction would want a ray through a camera that is not built until the frame is drawn, and a turned view zooms about its centre instead.
The Visuals workspace does zoom about the cursor, because its camera is its own pose rather than the 2D camera, placed the moment a gesture moves it.

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
They are projected on the gameplay plane like every other handle, so a primitive pushed off the plane by its `z` has them where its outline is rather than where the perspective draws its face; an orbited view drops the whole overlay in any case.

In the **2D view none of this applies**: there is no scene to ask, the outline is both what is drawn and what is picked, and every handle is back.
That is not a fallback but the same rule - the overlay picks and offers handles for exactly what it draws.
An **orbited** view picks by exactly these rules (above): the ray answers for geometry as it does head on, and the collision shapes, lights, regions and notes it shares the canvas with are resolved against the plane through `unprojectToPlane` rather than through the 2D camera, so the two halves of a pick agree about where the pointer is aimed at any angle.
What it does not offer there is the plane HANDLES, for the reason this section gives about geometry objects and the orbit section gives about everything else: a handle that is not drawn must not be grabbable either.

## Workspaces: Level and Visuals

The toolbar opens with a switcher, **Level** and **Visuals** (**W** toggles).
Everything in this document is the **Level** workspace: the editor driven by the 2D camera, with the overlay on top.
The **Visuals** workspace ([editor-visuals](editor-visuals.md)) is the same editor - the model, undo, the selection, the layer, the tool and the inspector carry across a switch - driven by a free 3D camera navigated Blender's way (middle drag orbits, Shift + middle or right drag pans, the wheel dollies toward what is under the pointer, **F** frames, **Home** faces the plane), with the overlay's marks drawn into the scene as guides instead: collision outlines, light icons and rings, the spawn, regions, paths, notes, the selected polygon's handles and tool drafts, each carrying a guide tag that `Scene3D.pick` returns beside the models.
It is what the turned view's missing overlay became: where a turned Level view only selects and moves, Visuals edits corners, draws with the plane tools, places props and drops them on surfaces, from any angle.
Each workspace keeps its own view, and `▶ Test` returns to the one it left.
Visuals also offers two tools of its own, **+ Rock** (a boulder generated to fit a collision outline) and **+ Mushrooms** (a patch grown inside a loop painted on a model's surface), each a geometry object with a `generator` block and a schema-built panel, generated by Python and headless Blender behind the dev server ([generators](generators.md); `bun run generators:setup` once per machine).
**+ Chain** and **+ Vine** are Level-only.

The one predicate the press handler asks is `inScene()` - the Visuals workspace, or the Level workspace turned - which says a press is resolved through the scene's camera rather than the 2D camera's scale and offset; where the two differ, each branch says which it is (see [Picking](editor-visuals.md#picking) there).
**Home** resets the Level workspace's orbit as `⟲ Reset view` does.

## The lens

`⧉ Ortho` (**O**) draws the scene through an **orthographic** camera instead of the perspective one (`ViewProjection` in `render3d/space.ts`).
It is an authoring instrument, not a look: a perspective camera divides by depth, so a prop 2 m behind the plane is drawn a little smaller and pulled toward the centre of the frame - which means two things that are exactly in line in the level do not look it, and two that look it are not.
Orthographic removes the divide, so a metre is the same number of pixels at every depth and what is on screen IS the plan, which is what makes aligning off-plane geometry by eye possible at all.
Both lenses are driven from the same visible height, so the gameplay plane is framed identically through either and the overlay, the handles and the picking are unchanged by the toggle (`cli render3d` asserts both halves: the plane matches the 2D renderer to a hundredth of a view pixel, and 20 m of depth moves a point by nothing).
The two cameras both live on `Scene3D` for the life of the scene rather than one being rebuilt on the toggle, since the gizmo raycasts against whichever is current and wants something stable to be handed.
A **▶ Test is always perspective**, whatever the toggle says: the point of a test is that the framing is the player's, and the player has no lens button.

The toggle is the editor's view of the whole scene.
The `lens` picker on the geometry panel is a different thing: it is authored, saved and seen by the player, and it draws one object orthographically inside the perspective frame (see [Per-object projection](render3d.md#per-object-projection)).
An orthographic object's plane handles land on its drawn face at any `z`, since the overlay is itself an orthographic projection of the plane.
The transform gizmo does not follow it yet: the gizmo is drawn in perspective at the object's real position, so off the plane it is not over the object.

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
A move that does not go through z then leaves the field alone rather than writing the pose's own z, or nudging a backdrop sideways would stamp that fallback into the file as an authored `z` nobody asked for.
A move that does go through z writes the new depth OUTRIGHT (`offsetZAfterMove` in `editor/model.ts`), because once written `offsetZ` is where the object is rather than a change from where it fell back to.
Until 2026-09-25 it wrote the displacement into the field as a change, so the first touch of the blue arrow on decoration drawn at `DECOR_Z` jumped it 35 cm toward the camera (found by the Visuals workspace's drop on surface, which goes through the same handler); a group drag had the same fault through its members' authored depths, and a group drag that went out through z and came back left its members where they had been mid-drag.
The one depth the field cannot hold is exactly 0 on a body that collides with nothing, which the format reads as unset.

**The gizmo never touches the model.** It moves a proxy object and the editor reads that proxy and writes the model, which is what lets it survive the scene being rebuilt from scratch on every model revision - that is, on every drag. A handle attached to a visual is attached to an object that is disposed a frame later, and re-attaching per frame is a gesture that cannot survive its own effect.

**The gizmo is offered for one object, one body, or the whole selection** (`gizmoSpec`), ordered by how much is known about the target rather than by how many things it holds: one object offers its own depth, tip and size; one body turns about the centre of mass the engine mounts it at; anything wider is an ARRANGEMENT, and what an arrangement has is a place and an angle.

**A handle is offered only where the format has somewhere to put its answer** (`GizmoHandlers.axes`), so what is on screen is the level's real degrees of freedom rather than three of everything:

| Target | move | rotate | scale |
|---|---|---|---|
| geometry: mesh | x, y, z | x, y, z | its one `scale` |
| geometry: primitive | x, y, z | x, y, z | w/h + depth |
| collision shape | x, y | z | w/h |
| light | x, y, z | z (its aim) | - (its reach is the 2D radius handle) |
| body | x, y | z, as a delta about the centre of mass | - (a body has no size; its objects do) |
| several of either | x, y, z (what has a z) | z, as a delta about the selection's centre | - (each member's own handles) |

**A primitive tips like a prop does**, and that is this table's rule rather than an exception to it: `EdVisual.rotX`/`rotY` belong to what is DRAWN, so `mountVisual` turns an extrusion by them exactly as it turns a prop's holder, and `visualData` writes them for either kind.
The pivot is the object's own origin, and an extrusion is built centred on z (`extrude.ts`), so a rect tipped about x is a ramp hinged on its own middle rather than on its back face.
It was a prop's field alone while nothing in the extrusion path read it - the ring turned, `rot x°` changed, and the level went on looking exactly as it did - which is the shape of the bug this closes, not a reason the plane is special.

What a tipped primitive does NOT do is move the collision: the body still collides with the outline its collision objects state, in the plane, and the 2D renderer still draws that outline face on.
A ramp the ball can actually run up is a collision shape turned by `rot`; this is the look.

**Several things move as one arrangement.** Selecting a handful of objects (or a handful of bodies, which means every object in them - the same set `operandItems` hands Delete, Duplicate and a nudge) puts the handles at their middle, and a drag moves or turns the lot about that point: a run of pillars, a stack of crates, a dressed doorway.
It is the one gesture the plane could never offer, the overlay having handles on one shape and a rotate knob on one body, so laying out an arrangement meant turning every piece about its own centre and dragging each of them back into formation.

Three things decide whether it behaves:

- **The centre is a MEAN of the members' own centres** (`selectionCentre`), not the middle of their bounding box and not `bodyCentroid`.
  A mean is a fixed point of its own rotation, so the handles stay put across a turn where a bounding box would hop sideways the moment one was released; and `bodyCentroid` answers a different question - it is mass-weighted over the COLLIDING shapes alone, because a body has to turn about the point the engine mounts it at, so a backdrop selected beside a wall would be ignored entirely and a small dense block would drag the handles off the middle of what is lit up.
- **The transform is measured from the pose the drag began in** (`captureGroupPose` / `placeGroup`), because a drag re-applies its whole displacement on every pointer move.
  A delta-per-move reads identically for one move and accumulates the snap grid's rounding over a slow one.
- **A body carries its frame only when the whole body is in the selection**, which is `carryBodyFrames`' rule and the one every other group edit already follows: dragging two objects out of a compound body moves those two and leaves the body they came from where it was.

**The blue arrow moves what has a depth and passes over what does not.** It is offered as soon as ONE member has a z - a drawn form's `offsetZ`, a light's own `z` - and every member that has one moves by the drag while a collision shape in the selection stays in the plane.
The stricter reading (no depth handle unless every member could move) was rejected because a level's collision IS the gameplay plane and is never anywhere else, so it would mean that a selection holding one piece of collision could never be pushed back - which is most of them.
Each member keeps its own depth and moves by the displacement, so a backdrop 6 m back and the sign 20 cm in front of it stay 5.8 m apart.

**Size is deliberately absent from a selection.** Every member has its own, in its own units - an outline, an extrusion depth, a mesh's one factor, a light's reach - and one handle over the lot would have to invent a rule for each; the members' own handles say it exactly.

Two consequences worth knowing before reaching for it.
A **mesh has one `scale`**, so any axis of the handle drives it, by the mean of the three factors - the uniform centre handle is exact and a single axis is an approximation of "bigger", because the file has one number and cannot record more.
And **an axis pointing at the camera cannot be dragged**, which head on is z for a move and the ring for a turn: `TransformControls` hides a handle within a few degrees of the view direction, and maps a ring drag onto the screen direction perpendicular to both the axis and the view, which degenerates as the two line up.
Turning about z head on is therefore the 2D rotate knob's job (or the outer screen-space ring, which anything drawn gets since all three of its axes are authorable), and moving through z head on is the **depth handle** below.
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

**The avatar stands at the spawn** (`spawnBall` in `editor.ts`, drawn by `BallVisual` like any other host's), because a level is authored against the thing that plays it.
Every gap, ledge and shelf in the file is a decision about a 12 cm iron ball, and a ring on the overlay says where a run starts without saying how much room it takes - so a slot judged by eye was judged against nothing until it was played.
It is built here from the model rather than borrowed from a `BallLevel`, at the radius it is actually PLAYED at (`BallLevel.BALL_RADIUS_SCALE` over the authored spawn radius, which is the grapple avatar's), and nothing steps it: with no chain thrown there is nothing else of the assembly to draw, so what stands in the scene is the sphere and its mounting loop in the pose a run opens in.
The spawn marker on the overlay gained the same size as a second, fainter ring outside its own: the inner one is the marker - the thing dragged to move the spawn - and the outer one is the ball's footprint, which lands on the drawn sphere's silhouette in a 3D view and is the only thing that says the ball's size in the 2D one.
A geometry object's panel authors what it is drawn as (**kind** - `primitive` or `mesh` - plus mesh, depth, bevel, texture) alongside the placement and size every object has, since a geometry object states its own form and those fields are what say it.

**Generated rocks** add two fields and one button (see [rocks](rocks.md#reference-and-actual-outlines)).
When a selected primitive wears a rock texture (`ROCK_TEXTURES`), **taper start** and **taper angle** take the place of **bevel**: where the rock's taper begins, in pixels in front of the object's plane, and how far its surface leans in, in degrees clamped to 0..90.
The 3D view draws a rock as the solid its generated mesh fills, the outline straight through to the start and then the tapered roof (`taperOutline` in `render3d/extrude.ts`), so the taper is read off the picture as it is set; the bevel is not drawn on a rock, because the generator does not read it.
**bevel** stays for everything else, and a mixed selection offers both.
Both default to 0 and are written to the file only when nonzero, so a level that never touches them saves byte-identically.
They only change the generated rock, which needs `bun run assets:rocks <level>` to see; the editor's own 3D view still draws the flat extrusion.

**Fit collision to rock** sits under **match collision** on a rock's geometry object panel (a single object selected) and beside **Origin to COM** on its body panel.
It is offered on any body `rockBodies` counts as rock; whether it can work is only known once the file is read, so the refusals are said when it is pressed, as a toast.
It reads `/rocks/<level>.glb` (the file this level saves to, or `?rocks=NAME` on the editor's URL), finds the body's node, and refuses with "rock is stale, regenerate" when the node's hash is not the hash of the body as the editor holds it now.
Otherwise it projects every triangle of the node straight along z, traces the silhouette (rasterised at 1 cm, simplified at 2 cm, holes ignored, the largest blob kept), and writes it as the body's collision object's outline, a `poly` in that object's own frame; the object keeps its placement and every other field.
The geometry object's **match collision** is switched off in the same edit, so the reference outline the rock was generated from stays as authored; it is one undo step.
Its limits: a body with exactly one rock geometry object and exactly one collision object (anything else is refused, naming the counts), a collision object that is an outline rather than a curve or a belt, and a missing file (404) is a message and no change.
The projection has no depth cut: a shard far behind the gameplay plane widens the outline as much as one standing on it, and a fragment the raster does not join to the main blob is dropped.

**rock seed** sits in the body properties (the body panel, and the panel for several bodies) when every selected body is one `rockBodies` counts as rock, below the physics fields and above the fill.
It is the body's `rockSeed`: an integer, step 1, never below 0, written to the file only when nonzero, and one undo step per edit like every other field.
It is held on every member of the body rather than only the collision lead, because a rock body may be geometry alone.
**Next seed** below it adds 1 to each selected body's seed, for the loop it exists for: regenerate, look, bump.
Changing the seed marks the rock stale, so play shows the extrusion until `bun run assets:rocks <level>` is run again.
`mesh` gets a badge on the canvas in the **2D view**, being the one kind whose outline is not what the player sees; a primitive is drawn as exactly the shape on screen, so a badge on it would be a mark on almost every object saying nothing.
In a 3D view the prop itself is drawn, so the badge would be a mark pointing at the thing it is standing on, and it is not drawn (see **Geometry is picked by its model**).

`▶ Test Grapple` / `▶ Test Ball` build a real `Level`/`BallLevel` from
the current model and run it inline (with the real camera, so a camera region is felt exactly as it will play); **Esc** returns to editing.
A test uses the real game render path, so it gets the 3D scene for free - drawn into the letterboxed frame rather than the whole canvas, since the bars are not part of the picture the player is shown.
A test also plays in the game's own fixed 1920 × 1080 frame, fitted into the editor canvas and letterboxed (see [**The view**](camera.md#the-view)): the point of ▶ Test is that the framing is what the player gets, and an editor-window-shaped view showed a different slice of the level from the one it will be played on.
**B** is the same ball test but spawned **at the cursor**, so a corner of the level can be spot-checked without walking the spawn marker over to it and back.
Selecting a **checkpoint** and pressing either ▶ Test does the same thing from a place the level itself records (see [**Notes and checkpoints**](editor-model.md#notes-and-checkpoints)): the spot-check is the throwaway version of it and the checkpoint is the one worth keeping, since it is also what `?checkpoint=NAME` asks for in the game.
The override is baked into the `LevelData` the test level is built from rather than into the model, so it never edits the level, and a reset (and the exported P bundle) respawns at the same point.

**A test never plays the level's rolling entry** (`roll` in the Player spawn group - see [**The rolling entry**](ball-rolling.md#the-rolling-entry)): the ball starts at the spawn, in the player's hands, on the first frame.
A test is a spot-check of the thing being edited - press it, see whether the ledge is reachable, Esc, move the ledge - and an entry is the opening of a *run*: two metres of rolling in and a second of hands off, between every edit and the thing it is being checked against.
It is dropped from the data the test is built from rather than skipped by the driver, so the bundle a test exports describes the run that was actually played.
To see the opening itself, play the level (`?level=NAME`), which is where an opening is worth judging anyway - the editor's canvas is not the screen it will be read on.
Starting a test also **detaches the 3D gizmo**: it lives in the scene rather than on the overlay, so a selection left the editing arrows hanging in the middle of the level being played - `gizmoSpec` had always answered "none in test mode" and nothing asked it, the sync running on the edit loop and a test having its own.
