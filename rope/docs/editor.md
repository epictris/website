# Level editor

The **`/editor`** page (its own HTML page `editor.html` → `src/editorMain.ts`, distinct
from the game at `/`) runs an in-browser level editor (`src/editor/`, its own canvas loop +
DOM overlay). Dev serves `/editor` via a rewrite in `vite.config.ts`; production maps it to
`dist/editor.html` in `serve.ts`; the build emits both pages (`rollupOptions.input`). It
edits an `EdModel` (positions in world **metres**, one
stable id per body) and manipulates it with the mouse: pan (**middle**-button drag, or the
right button), orbit (**Alt + middle** drag), wheel-zoom about the cursor,
click-select, a **left** drag anywhere to band-select, the gizmo (or G, or the arrows) to move what is selected, corner/rotate/
radius handles to resize, and `+Rect`/`+Circle`/`+Poly` tools to draw new bodies.
The editor is arranged as four **workspaces**, one per workflow - 2D, Formations, Decorations and Texturing ([below](#workspaces-2d-formations-decorations-texturing)).
The editor edits the level's **node tree** ([level-format](level-format.md#the-node-tree)), listed in the **scene tree** (the right dock), with groups, data layers and prefabs ([editor-model](editor-model.md), [prefabs](prefabs.md)).
How the screen is laid out is [below](#authoring-interface).
What a level LOOKS like is what its nodes carry - formations and the decorations grown on them ([formations](formations.md)), models of the library ([blender-models](blender-models.md)) - and a collision shape is drawn in 3D only by its own **debug geometry** ([below](#debug-geometry)).
**A left drag is always a band** (since 2026-11-27, Blender's Select Box).
With the select tool, a left press is a click until the pointer leaves `CLICK_SLOP_PX`, and then it rubber-bands, wherever it started: on empty space, on something not selected, or on the selection itself.
What is selected moves only by the gizmo, **G** or the arrow keys, never by a drag that may have meant to band, so geometry cannot be nudged out of place by a gesture that meant something else - the one editing mistake that leaves no trace on screen.
What still grabs on a left press is what is plainly a grip: the selection's handles (corners, midpoints, rotate, radius, depth, belt wheels), the gizmo, the spawn marker (it has no gizmo), a vine's drag-out of a berry, and the Shift gestures on a selected light (drop on surface) or chain (wrap point).
Until then the rule was **selected first, moved second**: a press on the selection dragged it and a press on anything else panned, so a band could only be started from empty space - and in a 3D view, with rock behind nearly everything, there was rarely any.
The middle button pans and **Alt + middle** orbits, in every workspace ([The 3D view](#the-3d-view-since-2026-11-22)).
**Cut**, in Select's block of the toolbar (it makes nothing, it works on what is there), is a knife: two clicks draw a line, every polygon or box it crosses edge to edge is cut, and what no longer touches becomes a body of its own, taking the anchors (with their chains and vines) on its side; **Join** (Ctrl+J) folds the selected bodies into the first, fusing pieces of the same surface ([editor-model](editor-model.md#split-and-join)).

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
It used to re-centre on every write, which kept a polygon's origin its own centre of mass and made every corner drag a **move of the object inside its body**: the shape being dragged stayed put on screen while its placement slid by the centroid's own motion, so the inspector's `x`/`y` for it walked away from zero, and everything drawn against that placement walked across the level with them.
What the re-centring was for is still true and is answered from the outline instead: `shapeCentre` gives a shape's own centre of area (a polygon's centroid, a curve's stroke, a rect's or circle's origin), and `bodyCentroid` weighs the body's pieces at those points, so the point the editor turns a body about is still the one `mountPieces` mounts it at.

## Waking lights: `+ Glow` and the awake preview

A point light's panel has a `wake` field below `flicker` (canvas pixels like the reach, metres on disk; blank or 0 is a light that is always on), and with it set, `delay s`, `rise s` and `fall s` (0.05 steps, floored at 0, blank for the renderer's default).
They are the fields of a **waking light** - see [**Waking lights**](lighting-and-surfaces.md#waking-lights).
A spot shows none of them, and turning a waking light into a spot clears its `wake` with a notice in the status line, since the pool that serves waking lights is point lights.
The `shadows` box greys out while `wake` is set: a waking light casts no shadow, and the authored flag is kept so turning the wake off gives it back.

On the canvas the wake is a dashed ring in the light's colour, with longer dashes than the reach's, drawn at the distance itself rather than cut by `z`, because the trigger is measured on the gameplay plane; a round grip on its left drags it like the reach's grip on the right.
The label says `wakes N`.

**`+ Glow`** (beside `+ Light`) places a glowing mushroom with one click: one static body filled `GLOW_COLOR` `#8a3fd6`, holding a collision square (`GLOW_CUBE`, 0.3 m) and a waking point light at its centre (colour `GLOW_EMISSIVE` `#b070ff`, `range` 4 m, `intensity` 6, `wake` 3 m, `wakeDelay` 0.25, `wakeRise` 0.6, `wakeFall` 1.5).
It goes through the same loader a level and a paste come in by (`glowModel`), so it is exactly what a file holding that body loads as, and it is one body, so the scene tree shows one body node and it drags as one.
Those numbers are editor defaults in `editor/model.ts`, not format defaults, and all of them wait on a play; a mushroom on a far wall can lose its collision object.
It is seen by the square's debug geometry, in the body's purple; a model or rock put under the body is its look, and the emissive materials of whatever the body carries follow the light as it wakes ([waking lights](lighting-and-surfaces.md#waking-lights)).

**The 3D preview shows every waking light AWAKE** (`Scene3D.setGlowPreview(true)`, `LightRig.previewAwake`): each source is held at full without stepping its state, and the pool is spent nearest the view's centre instead of the ball.
There is nobody in the editor's scene to wake anything, and an author has to see what a mushroom lights before anyone does.
**▶ Test** turns the preview off, so a test wakes them for the ball exactly as the game does.

## Fireflies (removed)

Fireflies - the `+ Fireflies` tool, a light's `fireflies` and `path` fields, and the `fireflies` layer of firefly paths - were removed from the game and the editor on 2026-11-26 at Tris's call.
A level that still holds any loses them at load (`dropFireflies`, [level-format](level-format.md#the-levels-light)); the git history has the feature as it was.

## Berry vines

A berry vine is any vine with berries on it ([vines](vines.md#berry-vines)).
Place the vine with `+ Vine`, then, with the select tool, **press on the vine and drag out**: the stalk leaves the vine where you pressed and the berry grows where you let go.
A plain vine becomes a berry vine by its first berry, and goes back to plain (its cord a target again) when its last berry is removed.
A click on a vine that does not leave the click's slop only selects it.

**Click a berry** to pick it out: it wears the selection, the 3D view's gizmo stands on it, and Delete removes it rather than the vine.
Move it with the gizmo (a drag from the berry bands, as anywhere); its root on the vine stays put and the stalk follows.
The gizmo's scale sizes it (it is round, so either handle scales the whole berry).
The picked berry shows a square at its root, which slides the root along the vine; the berry keeps its offset from it.
**Alt-click** a berry removes it.

The panel's **Berries** section has the vine's `new berry radius` (what a new berry starts at, 15 by default), berry sway, glow and vine seed (the cord's crooked line), `berry density kg/m³` (what the berries are made of, so each weighs its own size; blank is a fruit's 640) and `stem density kg/m` (what the stalks are made of, per metre like the cord, so a longer stalk's stem weighs more; blank is 8.3), neither a pixel length, like the cord's `density` in the Physics section, `stem stretch` (how far a stalk stretches on its spring before its ropes catch it, as a fraction of its length: the bounce; blank is 0.5, and 0 is a stalk that catches the ball dead), a button per berry to pick it, and for the picked berry its `x` and `y` in the level, its `radius` and the `weight` that gives it, its stem's `weight`, where its stalk leaves the vine (`stalk leaves at`, in pixels down the vine from its anchor) and Remove.
A berry's root is a length down the vine, so changing the vine's length leaves every berry where it is, and neither the length field nor the length handle will make a berry vine shorter than its lowest berry's root.
A berry vine's cord is its own woody brown, so the Look and Color sections are not shown for one.
At most eight berries a vine.

## Roots

`+ Root` (beside `+ Vine`) draws a root: press for each node and drag before releasing to pull out its Bézier handles, then Enter or a double-click (see [**Roots**](roots.md)).
A stroke started ON a root grows a branch out of it, at any depth; anywhere else it starts a new root, a static hook-only body of its own.
While the tool is armed a card at the foot of the view has `start width` and `tip` (px), which set the widths new roots are drawn at, remembered by the browser; mid-draw they set the root or branch being drawn.
While the tool is armed the selection's handles and gizmo stand down, so a press on a root always starts a branch.
With the select tool a branch is edited like any curve, except that its first node is its junction: dragging it slides the branch along its parent, and it cannot be removed.
Delete takes a branch and everything growing out of it; moving a branch into a body of its own (**New body**, or a drag in the scene tree) makes it a trunk where it stands.
The item panel has `start width`, `tip width` and `grows from`; the body panel's **Root** section has `springs`, which hinges the root at its trunk's base on a torsion spring.

## Conveyor belts

`+ Belt` (beside `+ Circle`) lays a **conveyor**: press where the first wheel goes and drag to the second, or click to drop a two-wheel belt 1.5 m long running right at 1 m/s on 10 cm wheels under a 5 cm band (see [**Conveyor belts**](conveyors.md)).
The item's own position IS wheel 0, so the ordinary move gesture places the belt and the rotate knob turns it about that wheel.

- Every wheel has a **square grip** at its centre, dragged like a path vertex; wheel 0's is the item's position, so pressing it picks the wheel and moves the whole belt.
- Every wheel has a **round grip** on its rim, facing away from the middle of the belt, the grip a curve's tangent wears, which drags that wheel's radius.
- Every run has a **midpoint handle**, which inserts a wheel there - sized as the smaller of the run's two wheels and set so its band just touches the run, which changes nothing about the loop - and drags it straight away, the path's insert gesture.
- **Alt+click** on a wheel's square removes it, never below two; removing wheel 0 moves the item onto the wheel that takes its place, so the belt stays put.
- Pressing a wheel's square or its radius grip **picks** it (the square fills), and the panel shows that wheel's `r`.

Every one of those, the inspector's fields and the gizmo's scale go through `setBelt`, which **refuses wheels that make no belt** - a wheel inside the hull the others make, a disc inside another, a radius or a thickness under a pixel - asking the build's own loop, so the grip stalls at the last belt, as a polygon's corner stalls at the last simple loop, because the editor rebuilds the level from the model on every edit and a belt the build refuses would take the preview down mid-drag.
The panel has `thickness` (the band's depth in the plane, px as every length there), `speed m/s` (signed: positive runs the loop clockwise on screen), the picked wheel's `r`, two readouts, the loop's **perimeter** and one **lap** of its surface, `P / |speed|`, and the band's look (`BeltLook`, on the shape): `width` (how wide the band is across the pulleys), `texture` (`color` is the flat fill, which keeps the cleats), `band colour` (absent takes the body's fill) and `tile scale`.
The band is the one look the editor authors, because the game draws it itself: its surface runs round the loop, which an exported mesh cannot.
The outline is `outlineOfData`'s, the one the game draws - the band, hollow inside - with the tread ticks STANDING STILL (nothing runs in the editor) and a small arrowhead over the middle of the longest run saying which way it runs, which a still tread cannot.
The wheels are drawn as editor marks the game does not draw: a thin circle at each wheel's own radius and a dot at its centre.
A click in the hollow between the wheels passes through the belt to whatever is inside it; the band and the wheels pick it, which is where it collides.
A belt builds only on a static body that does not move, and that is a fact about the BODY: a kind change or a move into another body can break it after the belt is drawn.
The editor does not throw on it - the title says `DOES NOT BUILD:` and the build's own message, the 3D view keeps the last scene that built, and ▶ Test refuses to start - so the author sees what to undo.
The file still saves, and the game refuses it as loudly as the build does.

## Picking corners out of a shape

**Corners are selectable in their own right** (`selectedVerts` in `editor.ts`), which is a second level of selection nested inside the item one: a polygon is the item whose parts are separately editable, so once the shape itself is picked, a click, a rubber band, a Delete, a nudge and a drag can all just as well mean its corners.
Click a corner to pick it out, **Shift+click** to add or drop one, and a **rubber band** (dragged from anywhere but a handle) catches every corner inside it (Shift unions).
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
Selection is a **set**: a plain click selects one body, **Shift+click** toggles a body in or out, and the gizmo, G or the arrows move the whole set.
A left drag from anywhere (but a handle) rubber-bands a **rectangle selection**, and the drag *direction* picks between the two CAD selection modes, as in Fusion 360 and AutoCAD: left→right is a **window** (only what the band fully encloses - every rotated corner inside, a circle by its extremes), right→left a **crossing** (anything it touches - a rotated box by SAT, a circle by its nearest point).
The mode has to be legible while the drag is still live, and the box alone cannot show a direction, so the band draws **solid** for a window and **dashed** for a crossing - the CAD convention, so it reads the same way it does there.
A drag with no horizontal travel counts as a window, so a degenerate one falls into the stricter mode.
**Shift** unions the hits into the current selection instead of replacing it.
A press that never leaves the click's slop is a click: on something it picks that thing (the drill-in cycle, Shift and Alt as ever), on empty space it clears.
Until 2026-11-27 a band could only start from EMPTY SPACE, because a left drag on a body panned or moved it ([above](#level-editor)).
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
(`src/editor/clipboard.ts`, version 2 since the node tree): the copied nodes, the bodies and groups above them and the chains and vines strung wholly between them, produced by the same `toTree` a save runs, so the round-trip
cases that hold a save lossless hold a copy lossless too - and a payload can be read, edited or
written by hand.
A version 1 payload (the flat form's body list, from before 2026-11-26) still pastes, migrated as a level is.
The spawn, the level block and the environment are never in it: none of them is a thing in the level to copy.
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
It also carries each body's **frame** (its node's own placement), so a compound body whose origin was
deliberately put at its bearing arrives turning about that bearing rather than about a corner of
whichever piece was written first - which `Ctrl+D` got wrong until the frames were carried too.
**Arrow keys** nudge the whole selection one grid cell (10 cm), or 1 cm with **Ctrl** held; the
nudge is a pure translation (never snapped), so a body keeps any sub-cell offset it has and the
fine step still works with snap on. A run of nudges collapses into one undo step, ending when the
key is released.

### Flip H: turning a route round

**Flip H** (in the selection's action row, beside Duplicate and Delete) mirrors the selection left-for-right about the vertical line through the middle of what it covers, so a stretch of level built to go right can be turned round to go left without being redrawn (`flipItemsH` in `editor/model.ts`).
The line is the middle of the selection's bounding box, a light counted as its point rather than its reach; flipping twice gives back what was there.
Everything is mirrored as its mirror image would behave: outlines, curves and their tangents, belt wheels (and the belt runs the other way), a spot's aim, a force area's push and a current's flow, a camera region's lock and its left/right buffers, a body's bearing and route (route turn keys negated), a pendulum (half a cycle on, so it starts out to the other side), a rotor (spins the other way), and berry stalks on a vine hanging from the selection.
A placement is a position and an angle, and an angle cannot hold a mirror, so each item turns one of its own axes over: most take `-rot` with their own x negated (a box at 0° stays at 0°, a text note stays readable); a force area, a water area and an arrow note take `π - rot` with their own y negated, because their angle IS a direction.
A body's frame and what is measured in it (bearing, route) are mirrored only when the whole body is selected, the rule every move and turn follows.
Two things are turned rather than mirrored: a library **model** has no mirror switch, so it keeps its handedness and takes the mirrored placement with its vertical-axis turn negated; and a vine's crooked line comes from its seed.
**A rock is not reflected**: a formation takes the mirrored placement like any item, and its guide and its build are left as they are, so a lopsided rock keeps its handedness.
One undo step.

Panels are split the way the format is, and **each is reached by selecting the thing it edits**.
An object panel carries what an object has - its form, its placement in its body, its material,
thickness and hook-proof flag - and nothing else; kind, friction, force and fill are the
body's, and they appear only when the **body** is selected (its scene tree row, or a canvas click on an
unselected body).
There is deliberately no body section above a selected object: that is exactly what made a
collision shape look like it had a `kind: static` and a friction of its own, when the file has
never had a place to put them.

### Inspector layout: sections and hover help

A selection's panel keeps its title (`Collision #12`, `Body #3 — rigid`) in view, and every property under it sits in a **collapsible section**, collapsed by default: Transform, Surface and Material on an object; Transform, Physics, Bounce, Breakable, Pivot, Spring, Mover and Fill on a body; and so on for chains, vines, camera regions and paths, lights and notes.
Every node's panel opens with its **Node** section: its name, its class and path (its id on hover), whether it is grouped ([editor-model](editor-model.md#groups)) and locked ([editor-model](editor-model.md#locking)), and the data layers it is in.
The level-wide blocks at the top (Level, Player spawn, Environment, 3D camera) are sections of their own.
Action buttons (New body, Group or Ungroup, Duplicate, Delete) stay outside the sections, always in view.
A section's open state is keyed by name per panel kind (`object/Surface`, `body/Mover`), so opening Surface on one wall opens it on the next, and it survives the inspector's rebuilds and a reload (localStorage, `rope.editor.openSections`).
A section a build leaves empty is dropped (`pruneEmptySections`).

Descriptions are not printed in the panel.
They are **hover help**: a name with a dotted underline (a field's label, a section's header, a panel's title) shows its description in a popup beside the inspector while the pointer rests on it, and at no other time.
Live status stays printed: warnings (a vine's light links, the shadow budget), readouts, the checkpoint URL.
The helpers are `src/editor/panelUi.ts` (`section`, `fieldRow`, `heading`, `describe`); new panel text goes through `describe`, never a paragraph under the field.

The kind picker covers `static`, `rigid`, `killzone`, `force`, `water`; the **hook-proof**
checkbox is per shape, so one piece of a compound body can be the only place a hook will catch,
and it stays on the object panel for that reason (see [**Hook-proof surfaces**](hook-surfaces.md#hook-proof-surfaces)).
The **hook-only** checkbox beside it is per BODY and offered on `static` and `rigid` alike: it is what the retired `anchor` kind became, and as a flag it also says the thing a kind could not - a leaf on a sprung stem that falls, sags when it is grabbed and stops nothing (see [**Hook-only bodies**](hook-surfaces.md#hook-only-bodies)).
A `static` body's panel also carries its **scripted motion** - a swing angle and a beat make it a pendulum about its bearing, a spin time makes it a rotor about the same bearing (negative turns it the other way), and a route drawn on the canvas makes it a platform (see [**Scripted movers**](movers.md)), with a live `cm/frame` readout of how fast its surface crosses a frame, which is the one number a mover can get wrong with nothing else saying so.
The canvas marks all three: a pendulum's swept arc, a rotor's whole swept circle with a barb saying which way round, and the route as a dashed polyline.
Both the arc and the circle are drawn at `sweptReach` - the farthest CORNER from the bearing, which is the same geometry the `cm/frame` readout is computed from, so the picture and the number it is judged by cannot be about different shapes.
Measured off the shapes' centres instead, which is what it did first, a cross drawn round its own axle has every piece centred on the bearing and draws a circle of no radius at all.
The route is shaped on the canvas rather than in the panel: an amber dashed polyline with a square at every waypoint, dragged to move one, its midpoint handles clicked to insert one and Alt+click to remove one, and the body itself is waypoint zero - so moving the body carries the whole route with it, which is what makes the waypoints frame-local in the model (the same argument `pivotAt` makes).
Body fields read and write the body node itself, which holds each of them once for every piece under it.
Every body that can be stood on carries a **surface friction** (0 = ice, 1 = rubber; see below).
Everything that is a piece of stuff rather than a region of space - every kind but the three areas, hook-only bodies included - also carries a **material**, a **density** and a **thickness**, the shape's depth through the z axis the 2D view cannot show, with a live **mass** readout under them (`area × thickness × density`). The material is a PRESET density: picking one sets the **density** field (kg/m³) to its value, and typing a density makes the material **custom** (the picker shows so as it is typed; `custom` is never picked, there being no density for it to set).
The readout is what makes either number authorable: an author is choosing a weight, and a density and a depth only become one once the shape's own size is in it. See [**Mass and materials**](physics-foundations.md#mass-and-materials); both are per shape, so a selection spanning a compound body edits its pieces individually.
A
`force` area carries a signed **force** magnitude aimed by its own `rot°` - so the rotate
knob steers the current, and force-kind circles get that knob too (a plain circle's rotation
is invisible, so it has none). A `water` area is aimed the same way and carries the two
numbers a current is made of instead: a signed **flow** speed and the **drag** rate it takes
hold at (see [**Water**](water.md)), and the slab the game draws it as: `water z`, where it sits through z, and `water depth`, how deep it is (blank for the renderer's default). A toggleable snap (fixed 10 cm, the
backdrop's minor-grid spacing) keeps geometry aligned - **moves** snap the body's top-left
corner, and **corner-resize** anchors the opposite corner (grows toward the drag). Each body
**Undo/redo** (Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y) keeps 50 model snapshots - one step per
discrete action (each drag, add/delete/duplicate, kind/colour/opacity/numeric edit); New and
Open clear the stack.
Every colour field in the editor is a swatch that opens the editor's own picker (`src/editor/colorPicker.ts`: saturation/value square, hue strip, hex field, eyedropper; Escape or a click elsewhere closes it), not `<input type="color">`.
The **eyedropper** (the pipette beside the hex field, 2026-10-17) picks a colour off anything the editor shows: the pointer becomes a crosshair with the colour under it beside it, a click takes it, and Escape or a right-click cancels without closing the picker.
It is the editor's own (`src/editor/eyedropper.ts`), since the browser's `EyeDropper` exists only on Windows, macOS and ChromeOS: it reads the elements under the point front to back, each canvas by its pixel and anything else by its background colour, so it sees the 3D view, the overlay and the panels' swatches, but not text.
The 3D canvas keeps no drawing buffer, so the pixel is read in an animation frame that runs after the editor's own has drawn it; a pick matched the screenshot's pixel exactly.
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
It is the one question the authoring view cannot answer on its own: how deep the scene reads behind the collision, whether a light pool falls where the ring on the plane says it does, what a ledge looks like from the side it will be seen from.
The camera swings about the point it is centred on at exactly the dolly distance the zoom asks for, so a turn is a turn - it neither zooms nor slides what it is looking at, and the reset is a return to the picture the level was authored against rather than an approximation of it (`cli render3d` asserts all three, plus that a zero orbit is the head-on camera to the bit).

**A turned view draws no overlay**, and that is the whole cost of it.
The overlay is the gameplay plane projected straight onto the screen, so at any other angle its outlines, handles and bands would sit somewhere the geometry is not - which is worse than drawing nothing, because it looks exactly like an editor that is still aligned.
So the resize handles, the rubber band and the draw tools' previews all go with it: those press like empty space, which is a pan.

**What does not go is what a click MEANS.**
Those two were run together for as long as a pick was resolved on the plane by the 2D camera, and they are different questions: a ray answers for the models (`Scene3D.pick`) and meets the gameplay plane for everything resolved against it (`unprojectToPlane`, `canvasWorld` in `editor.ts`), both at any angle.
So bodies and objects are **selected in a turned view exactly as they are head on** - the drill-in cycle, Shift, Alt, the scene tree - and dragging one carries it along the plane it is drawn in (a light at its `z`, so it stays under the pointer), and the **transform gizmo** the pick puts on it is in the scene and works from any angle.
That pairing is the point of the orbit: turn the view to see the depth, then drag the blue arrow to author it, on the thing you turned the view to look at.
`unprojectToPlane` is `projectToView` backwards, and `cli render3d` asserts it as a round trip through three's own projection at a spread of orbits, plus that it is the 2D answer head on and is NOT it turned - an implementation that quietly returned the 2D answer passes the round trip at zero orbit and puts every turned-view click somewhere else.
The one thing zoom gives up there is zooming about the cursor: the zoom is a dolly along the view direction rather than a scale about the screen, so the correction would want a ray through a camera that is not built until the frame is drawn, and a turned view zooms about its centre instead.
The Visuals workspace does zoom about the cursor, because its camera is its own pose rather than the 2D camera, placed the moment a gesture moves it.

Ctrl is on the orbit rather than on the pan because panning is how you get around a level and is wanted in every view, while orbiting is the rarer act and the one you come back from; with no scene to turn (the 2D view) Ctrl+middle simply pans like any other middle drag.

## Picking what the scene draws

**With a scene drawn underneath, a pick is a raycast through the camera the last frame was drawn with** (`Scene3D.pick`, `raycastItems` in `editor.ts`), so it is about the picture the pointer was actually aimed at, and it holds at any depth.
What the ray can meet, and what each answers with (`pickTagOf`):

- a piece's **debug geometry** answers with the collision object it is the extrusion of;
- a **model**, **formation**, **decoration** or **light** answers with its node's id (`TreeLook`, [render3d](render3d.md#the-look-from-the-node-tree)), which the editor maps to the node's item, so the group rule then decides what the click selects;
- in the Visuals workspace, a **guide** answers with its guide tag.

`pickOrder`'s rules (the active layer, then a collision object winning over a light whose reach it sits inside) still decide which of the things under the pointer wins, so **click the body, then click into it, then into what is behind it** cycles exactly as before.
**In the 2D workspace the plane comes first** (`pickCandidatesAt`, 2026-11-24): within the active layer, whatever is hit on the plane itself (an outline, a model's marker, a light's icon) is ahead of anything only the ray meets, however near, and the plane's own rules settle it among them.
Before, the nearest thing drawn won there too, so a rock on a 2D body, which bulges out in front of the plane, took the click on the collision outline drawn over it: on a copy of `ball.json` seen from its spawn, 79 of 364 grid points drilled into the rock instead of the collision piece.
The rock is still reached by clicking again (body, its collision, its rock, then what is behind).
**A line off the scene layer comes before all of it** (2026-11-24): a click on a camera path or a note's arrow picks it first, whichever layer is active, as a chain or a vine is picked.
It is a stroke a few pixels wide, so it cannot swallow the clicks around it as an area on another layer would, which is why the active layer leads otherwise; behind it, the river's camera path over water or a backdrop rock took three to five clicks, or more than the cycle reached.
A collision curve, on the scene layer, is a bar with a width and keeps the ordinary rules.
Once a path is selected a press on its line may land on its own handles (a node, a grip, an edge midpoint, which inserts a node), so to reach what is under a selected path, click just beside the line.
The chain tool still asks the plane, because an anchor is placed on a body's collision outline.

The chain from a mesh under the pointer back to a row in the scene tree is three links: the renderer stamps the drawn group with what it stands for (a piece's debug geometry with its compiled collision object, the look with its node's id), `toLevelData` records which ITEM each compiled element came from (through `compileLevel`'s `nodeOf`), and the editor rebuilds that map with the scene so it can never name an item the picture was not built from.
The middle link is the one that can break silently, so `cli render3d`'s `pick:` cases assert it directly.

**Selection is shown on the model** (`Scene3D.setHighlight`), in the overlay's own colours - the selection orange, and the blue that means "this is what the selected body is made of" - applied as an emissive over the surface the piece already wears.

In the **2D view** there is no scene to ask, and the outline is both what is drawn and what is picked.
An **orbited** view picks by exactly these rules: the ray answers for what the scene draws as it does head on, and the collision shapes, lights, regions and notes it shares the canvas with are resolved against the plane through `unprojectToPlane` rather than through the 2D camera, so the two halves of a pick agree about where the pointer is aimed at any angle.
What it does not offer there is the plane HANDLES: a handle that is not drawn must not be grabbable either.

## Names

Every node's **`name`** is a label: what the scene tree lists it by and what the replay tools print beside an engine body index, unique among its siblings (a clash takes the next free number as it is typed), and never what anything refers to it by ([level-format](level-format.md#the-node-tree)).
It is edited in the Node section, in the body panel, or by a double-click on its scene tree row.
Until 2026-11-26 the Level panel had a **`scene`** field naming the Blender scene the level was dressed in, and a body's name was what that scene's objects were bound to; both went with the scenes ([blender-scenes](blender-scenes.md)).

## Models: `+ Model`

**`+ Model`** places a 3D model of the library ([blender-models](blender-models.md)) with one click: into the selected body when one is selected (a lantern on the chained body it hangs as), otherwise as a `Model3D` standing on its own.
It places the model last picked or selected, else the first the editor offers.
Its panel names the model (typed, held to a model's spelling, offered the models exported here or published from `GET /api/models`) with a line saying the export's triangles, size and age and whether it is published, then `z`, `tilt x°`, `tilt y°` and `scale`.
A model is picked by clicking it in the 3D view (body, then object, as everywhere); on the plane it is a dashed cube mark with its name, which is what a click lands on where no scene is drawn.
It has a depth handle and the gizmo's blue arrow (`hasDepth`, `setDepth` in `editor/render.ts` are the one statement of what has a z), the gizmo's three rings (the plane ring is its `rot`, the other two its tilts) and its boxes, any of which scales it uniformly.
An anchor's and a model's boxes are marks, not sizes, so neither panel offers `w`/`h`.

## Debug geometry

A collision shape's panel has a **Debug** section (`addDebugFields`), and its **draw** box is the one switch: ticked, the shape is drawn in 3D - here, in ▶ Test and in the game - as its outline extruded in a flat colour (`CollisionObjectData.debug`, see [render3d](render3d.md#what-the-scene-draws)).
Under it the section offers **colour** (the body's fill until one is picked; **body colour** goes back to it), **opacity** (0 to 1; below 1 the shape is see-through and casts no shadow) and **depth** (pixels, blank = the shape's own `thickness`).
They are offered ticked or not: unticking keeps them, so a shape switched back on comes back as it was, and an unticked shape can be tuned before it is switched on, or while **all debug** draws it.
A belt has no Debug section: it draws its own band.

A shape drawn on the scene layer starts ticked, since a new piece is seen by its debug geometry, as every piece a level is blocked out in is.
A level saved before the switch existed opens with the shapes its grey box used to draw ticked ([level-format](level-format.md)).
**G** hides every shape's debug geometry in ▶ Test, as in the game; every test opens with it shown, and authoring always shows it.

The toolbar's **all debug** box (offered only with a 3D view) draws every shape's debug geometry in 3D, ticked or not, each with its own settings - in the editor's view and in ▶ Test - so the collision under a dressed level can be seen without flipping each shape's **draw**.
It is an editor setting like **snap**, never written to the level, and it is the renderer's (`Scene3D.setAllDebugShown` → `BodyVisual.setDebugForced`), not the data's: no shape's `debug` changes, a test's recording carries the level as authored, and the game draws each shape as authored.
**G** still hides all of it in ▶ Test.

The toolbar's **reflections** box (ticked by default, offered only with a 3D view) turns off the ball's reflection probe and the pools' mirror, in the editor's view and in ▶ Test; unticked, the ball reflects the sky again.
Both passes draw the scene into targets of their own, and the probe's is linear and not tone mapped, so every material it sees needs a second shader program.
That program is compiled the first time new scenery comes into the pass, mid-run, because the editor runs no `Scene3D.prewarm`.
In a 2026-10-09 trace of a `ball` test, the probe and the mirror each cost a frame of 13-17 ms plus a 130-140 ms GPU-process stall, which made them the worst hitches after the test's first frame.
Like **all debug**, it is an editor setting, the renderer's (`setReflectionProbe`, `setPoolMirror`), and never written to the level.

The **shadows** box beside it (ticked by default) stops the sun and every lamp from casting, for the same reason.
The shadow pass compiles one depth program per kind of caster, the first time such a caster is inside a shadow camera, and in the same trace one of those cost a 44 ms frame.
It is the renderer's (`Scene3D.setShadows`, which reaches `Environment.setShadows` and `LightRig.setShadows`), so no light's **cast shadow** changes, and ticking it again gives the same lamps their shadows back within the shadow budget.
Switching it either way changes the shadow count three keys every lit program by, so the next frame recompiles them all: expect one long frame at the click.

The **water** box (ticked by default) hides the water: pools, currents, falls and the scene's water continuing a pool, and a hidden pool draws no mirror.
The water's shaders are compiled the first time a body of it comes into view; in a 2026-10-09 trace that was a 16 ms frame plus a 149 ms GPU-process stall.
Only the picture goes: the ball still floats and drags in the water.
It is the renderer's (`Scene3D.setWaterShown` → `BodyVisual.setWaterShown`), never written to the level.

The **roots** box (ticked by default) hides the roots, and more than hides them: no root mesh is grown at all while it is off.
An edit to a branched root regrows that body's mesh (~250 ms on `ball.json`'s, see [**roots**](roots.md#simplified-and-baked-roots)), so untick it to draw and reshape a root without that stall on every edit; the overlay outline still shows where each root is.
Ticking it again grows each root as it now is, and a root nothing changed comes back from the cache.
Only the picture goes: the hook still bites the roots.
It is the renderer's (`Scene3D.setRootsShown` → `BodyVisual.setRootsShown`), never written to the level.

The **scene** box (ticked by default) hides the level's look: its formations, decorations and models alike, on a body or standing on their own, so the collision and what the game draws itself (water, belts, chains, lights, the ball) stand alone, in the editor's view and in ▶ Test.
It is the renderer's (`Scene3D.setSceneShown` → `TreeLook.setShown`), held for a file that has not landed yet, and never written to the level.
Hidden scenery is not picked and not dropped onto: `Scene3D.hitsAt` skips any hit whose object or an ancestor is invisible, because three's raycaster tests hidden objects too.

The toolbar's view boxes - **snap**, **edge clamp**, **all debug**, **reflections**, **shadows**, **water**, **roots** and **scene** - are remembered by the browser (`localStorage` key `rope.editor.view`, `editor/prefs.ts`), so the editor opens as it was last left; each box writes itself back when it changes.
So is the layer stack's hidden and locked state (`rope.editor.layers`), per browser rather than per level, written by every path that changes it (the eye and padlock, a paste or pick that reveals a layer); a stored name that is no longer a layer is dropped, and a stack stored with every layer hidden opens with none hidden.
So is the level last open (`rope.editor.level`), which a fresh editor reopens: it is written by File > Open and Save As, and cleared by New and Delete File, so an editor last left on an unnamed model opens empty.
The reopen waits for the level list and is skipped for a name no longer on disk (forgotten, without a dialog) and for a model already edited while the list was on its way.

**The view is in the address bar**, the way a map keeps its centre and zoom, so a reload - the dev server's, after an edit to the editor itself - comes back looking at the same place instead of at the spawn (`editor/viewUrl.ts`):

```
/editor?level=ball&cam=12.5,-3.25,2,-0.6,0.3&vis=12.5,3.25,0,0.9,0.24,1.73&ws=visuals&lens=ortho
```

`level` is the level open, and wins over the remembered one, since it is this tab's where `rope.editor.level` is the browser's.
`cam` is the Level workspace's view: the 2D camera's centre (sim metres, y down) and zoom, then the orbit's yaw and pitch (radians) when it is turned.
`vis` is the Visuals workspace's pose once it has one - target (three's frame, y up), yaw, pitch, half height; the field of view is the level's lens, so it is not carried.
`ws=visuals` and `lens=ortho` are the workspace and the lens when they are not the defaults.
Each workspace keeps its own view, so both are written and each gets its own back.
The view is taken up only over the level it was written for: a `level` no longer on disk opens the editor empty and the stale view is dropped.
It is written with `replaceState` (no history entries) at most twice a second, never during ▶ Test, and not at all until the boot load has taken the address's view up, since the first frames are of the empty model and would overwrite it.
Any other query parameter is left alone.

`cli shot --probe --query "reflections=0&shadows=0&water=0&roots=0"` replays a bundle with the same four switches off, so its log lists what an editor test set up that way still compiles mid-run.

## Sounds

**File > Sounds…** opens the menu that assigns sound files to the game's events - rolling and landing per surface, the cuff attaching and bouncing, links winding on, the whoosh, splash and wade - with upload, preview and each file's credit, and a clip editor per file (its waveform, cropped by dragging, with its own volume and pitch).
It is not part of any level: what it writes is `src/audio/soundBank.json` and the sound library, and a change is heard straight away in ▶ Test and in a game open in another tab.
See [sound](sound.md#the-sounds-menu).

## Workspaces: 2D, Formations, Decorations, Texturing

Since 2026-11-23 the editor is workspaces, tabs in the middle of the command bar (**1**, **2**, **3**, and **4** for Texturing since 2026-11-26), as Blender's Layout / Modeling / Texture Paint tabs are.
Tris asked for it because one editor offering everything at once was too busy: each workflow should have its own UI readily to hand and nothing else's in the way.
The policy is one module, `src/editor/workspaces.ts`; the editor asks it.

| | 2D | Formations | Decorations | Texturing |
|---|---|---|---|---|
| View | free 3D, opening on the gameplay plane head on | free 3D | free 3D | free 3D |
| Toolbar | Select, Cut; Rectangle, Circle, Polygon, Curve, Belt; Chain, Vine, Root, the bouncy and the glowing mushroom; Light, Model; Fog region, Shelter (the camera layer: Rectangle, Circle, Polygon, Camera path; the notes layer: Text, Arrow, Checkpoint) | Select; Add box, Add cylinder; with a solid guide selected Union, Subtract, Intersect; while sculpting Draw, Grab, Cut instead | Select; Moss, Ivy (painted); Fern, Hanging vine, Mushrooms, Pendant orbs, Glow flora (placed) | Select; Paint |
| Tool settings | none: a new shape's body class is asked at the shape ([editor-model](editor-model.md)), and Root's widths are a card at the foot of the view while it is armed (the type layers are over the scene tree, in 2D only) | the selection's Guide / Rock / Both (Tab) and Sculpt (Ctrl+Tab; the strip is Sculpt's while it is on), Add to guide, a combine's Apply / Cancel; Show Guides / Rocks, Generate N out of date | the brush's radius while Moss or Ivy is armed; Show Collision, Grow N out of date | Material (picking one picks up Paint), the brush's radius while painting; Show Collision, Bake N out of date |
| Drawn and picked | everything on the plane, all layers; not what stands in 3D (a rock or model with no body above it) or decorations | the scene layer's formations and the collision their guides are taken from; the solid guides | the scene layer's formations and decorations but material layers | the scene layer's formations and their material layers |
| Inspector | everything but the Formation, Decorations and Materials sections | the spawn, Sun and Environment, a body's Transform and Formation | the spawn, Sun and Environment, a rock's Decorations, a decoration's panel | the spawn, Sun and Environment, a rock's Materials, a material layer's panel |

**What is in a workspace** is `inWorkspace`: it filters what the overlay draws (`shownModel`, `shownLayers`), what a click or a band picks (`pickableItems`), and what the scene tree lists (in the 3D workspaces, only the nodes in the workspace and those holding one, and the Sun and the Environment, which every rock is judged under).
What a click on a grouped node stops at is the workspace's too (`clickableIn`, [editor-model](editor-model.md#groups)): in Decorations a click on a fern selects the fern, though the body above it is grouped.
Chains, vines, berries and the spawn marker are the plane's and are picked in 2D only; the solid guides are drawn and picked in Formations only, where in the others they were wireframe in front of the rock.
The scene itself is drawn whole in every workspace: the rocks are the reference 2D is drawn against, and the collision outlines are a formation's guide.
Switching drops from the selection whatever the new workspace does not hold, as hiding a layer does: it could be neither seen nor clicked, but a nudge, a field or a Delete would still reach it.
The draw tools are 2D's (`setTool` refuses one elsewhere, so their keys arm nothing), and the brush ends whenever the workspace changes.
The right dock's **Scene** and **Prefabs** tabs, the same in every workspace, show the tree of what is open or the prefab library ([prefabs](prefabs.md#in-the-editor)).
They replaced the Level / Prefabs buttons that sat over the old left dock (and those the Formations dock's **Level** / **Assets** pair, retired 2026-11-26, whose reusable rocks are prefabs now).
Texturing is painting a rock with materials from the library, live: [formations](formations.md#material-layers).

**The inspector** is filtered by section key (`sectionShown`, applied by `pruneEmptySections`), so a rock's panel in Formations is its recipe rather than its bounce, friction and mover first.
The section a workspace's work is done in (`PRIMARY_SECTIONS`: Formation, Decorations, a decoration's own; and the panels that ARE their node - the spawn's, the Sun's, the Environment's, a fog region's Fog, a shelter's Wall) starts open until the author closes it, remembered as opened sections are (`setDefaultOpen` in `panelUi.ts`).

**The 2D view is navigated as the others are** (since 2026-11-26; it was locked head on before): the middle or right drag pans, Alt + middle orbits (since 2026-11-27; the middle drag orbited and Shift + middle panned before), the wheel dollies toward what is under the pointer, and the view cube turns it.
Everything 2D draws and picks works at any angle, through the plane under the pointer ([below](#the-3d-view-since-2026-11-22)); **Align camera to plane** (top left, Numpad 1) faces the plane again, and is lit while the view is turned.
**A switch never moves the camera**: every workspace keeps the camera's position and direction exactly (Tris, 2026-11-25).
Until then each 3D workspace came back at the yaw, pitch and depth it was left at, which moved the camera on every switch between Formations and Decorations.

**Guides and rocks** (Formations, 2026-11-23).
Every guide is drawn in its own bright colour (`guideColor` in `src/editor/guideColors.ts`): a hue hashed from the formation's id, so it is "random" but keeps its colour through a reload, an undo or a regenerate, and the solid guides' volumes and edges and the collision guides' dashed outlines (`drawFormationGuide`) wear it alike.
The tool settings' **Show** has two globals, **Guides** and **Rocks**, remembered by the browser (`guides`, `rocks` in `prefs.ts`): every guide in the level drawn or not, every generated rock drawn or not.
**Selected** switches the selected formations between **Guide** (the rock hidden), **Rock** (the guide hidden) and **Both**; **Tab** swaps guide and rock, as Blender's Tab swaps object and edit mode.
A per-formation choice (`formationView`) overrides the globals until either global is set again, which clears them all, so a global always means every formation in the level.
A guide just made (**+ Box**, **+ Cylinder**, Shift+A) or just added a shape to is shown whatever **Guides** says (`revealGuide`, 2026-11-24): it is given its own override (Guide, or Both where its rock shows), since an add that draws nothing reads as an add that did nothing.
A rock not generated has nothing but its guide, so Rock and Both are offered only for one that is.
A hidden rock is hidden as an H-hidden body is (`Scene3D.setHidden`, from `syncHighlight`), so it is not picked either; a hidden guide is not handed to `SolidGuideView` at all.
Outside Formations the rocks are always drawn and the guides are not.
Until this change a generated rock's guide was drawn only while it was selected; now Guides decides.

**Primitives** (Formations, 2026-11-23; the toolbar's **Add box** and **Add cylinder** since 2026-11-26): the box and the cylinder - the starting shapes a guide is sculpted from; outlines, the three-outline preset, hulls and ellipsoids were retired the same day ([formations](formations.md#in-the-editor)) - each make a new guide of their own - a top-level `Formation3D` with no body, whose solid guide is that one shape (`createBackdrop` with a shape) - standing at the view's target, depth included, and selected, as Blender adds at the 3D cursor; **Shift+A** with no guide selected offers the same.
With a solid guide selected the tool settings add **Add to guide** (the same shapes into its stack, as Shift+A then does) and the toolbar **Union**, **Subtract** and **Intersect** (combining other guides into it; **Select** ends a combine, as Esc does).
The cylinder is a primitive of the format since this change (`prim: "cylinder"`, `size` its full extents, standing along its y), meshed by manifold-3d like the others; the generator is handed the guide's mesh, so nothing in Blender changed.

**Sculpt** (Formations, 2026-11-23, Selected in the tool settings, the panel, or **Ctrl+Tab**): the selected solid guide shaped with **D** Draw, **G** Grab and **C** Cut, Dyntopo and Remesh, as Blender's sculpt mode; while it is on, the toolbar is its three tools and the tool settings its brush's and every key but the view's and the workspaces' is too, so **G** is the Grab brush there, not the object grab below.
**C** outside the mode cuts the selected guide's whole stack to a polygon drawn on the view.
All of it is in [formations](formations.md#sculpting).

**Combining guides**: with a solid guide selected, **Union**, **Subtract** or **Intersect**, then a click on each other guide to fold in (in the view or its scene tree row; again to leave it out), **Enter** (or Apply) to apply, **Esc** to drop it.
Each picked guide is carried into the selected guide's frame (`carryTree` with `frameBetween` in `solidGuides.ts`: the two body frames are rigid, so each leaf's pose re-decomposes exactly over its own scale) and appended to its stack in that mode (`appendEntry`); a guide that is one shape becomes one row, a larger one a group row.
It is destructive and one undo step: the picked guides leave the level, with the decorations tied to them, and the notice says how many.
The picked guides are drawn in front and tinted (`COMBINE_PICK`) while it is chosen; selecting anything else ends it.

**Grab, Rotate, Scale** (**G**, **R**, **S**, any workspace, 2026-11-23, Blender's modal transforms): what the gizmo would move, turn or size follows the pointer - a body, a rock or frame standing in 3D, a guide's picked shape, a multi-selection - through the gizmo's own handlers (`handlersFor`), so each does exactly what the matching handle drag would, as one undo step (`startTransform` and friends in editor.ts).
A click or **Enter** places; **Esc** or a right click puts it back and takes the undo step away again; **X**, **Y**, **Z** hold it to that axis, and **Shift+X**, **Y**, **Z** to the plane of the other two (the same key again frees it; a turn held to a plane turns about the axis left out, as Blender's does).
The gizmo is put away meanwhile, so the placing click cannot land on a handle.
A readout over the viewport's top left says what it is doing and which keys apply (`xformReadout`), as Blender's header does, beside the toolbar; the status line's notice is along the viewport's foot.

**Typed amounts** (2026-11-24, Blender's numeric input): digits make it exact, **metres** for a grab, **degrees** for a turn, a **factor** for a size (Tris's choice over metres of size: Blender's meaning).
**S 1 0** sizes by 10 on every axis, **S X 5** by 5 along X, **S Shift+Y 1 2** by 12 along X and Z; **G X 5** moves 5 m along X; **R Z 9 0** turns 90° about Z, right-handed (counterclockwise seen head on), and **R 9 0** about the view axis the same way.
While a number is typed the pointer is ignored; **Backspace** takes it back a character at a time (**Ctrl+Backspace** all of it), and with nothing typed the pointer leads again.
**-** negates (refused for a size: a negative factor turns a solid inside out); a size is held above `MIN_SCALE_FACTOR`.
There is one number per free axis, **Tab** (**Shift+Tab** back) stepping between them, so **G 1 Tab 2 Tab 3** moves by (1, 2, 3); a size's first number sizes every free axis until Tab is pressed.
The axis may be chosen before or after the number.
A typed amount is applied with the grid snap off (`applyTransform`), since the handlers' snap would round it: G X 0.05 on a 0.1 m grid moves 0.05.

- **G** moves in the plane facing the camera through where the target stood, or in a plane parallel to the gameplay plane for a target that cannot leave it; an axis is a world axis.
- **R** turns by the pointer's angle round the target's centre on screen (counterclockwise on screen turns it counterclockwise as seen), about the view axis, or the world z for a target that turns only in the plane; an axis is a world axis. It snaps to 15° while snap is on, as the rings do.
- **S** sizes by the pointer's distance from the target's centre on screen over the distance it started at; an axis is one of the target's own (the scale boxes are local too).
  A body has no size, so **S** on a body holding a solid guide sizes the guide: every shape, about its middle (`guideScaleHandlers`).
  Along an axis of the guide's frame too, as long as every shape lies along its axes, turned by right angles or not at all (`scaleTreeAxes`: each shape's own axis takes the factor of the frame axis it lies along); a guide holding a shape turned any other way sizes evenly only (`scaleTree`), since a per-axis factor on such a shape is a shear no pose can hold, and X / Y / Z say so; pick one shape in the stack to size it along an axis then.

**R** and **S** take the key only when the selection has something to turn or size; otherwise they arm the Rect and Checkpoint tools in 2D as before.

**The gizmo's centre box** (2026-11-23) moves the target in the plane facing the camera, so a rock standing in 3D is placed in one drag rather than one per axis.
It is three's own move-centre handle (`XYZ`) drawn as a box (`reshapeHandle` in `gizmo.ts`); the uniform-scale box that held the centre until then is gone, and a model's one-number scale follows any one axis box.

**The palette** (`DecorationController.arm`) arms a kind for the next click on any generated rock; before, a decoration was started from a button in one rock's panel and landed on that rock only.
A kind stays armed and selects nothing it makes (since 2026-11-25): a row of ferns is a row of clicks, and moss or ivy is a brush that paints whichever rock it is pressed on (a right drag erases) and grows on Enter, its radius under the palette ([formations](formations.md#decorations)).
While a painted kind is armed or its brush is on, the brush's ring and footprint follow the pointer over the rock.
Esc (which also throws away the strokes since the last Enter), its button again, **Select**, a press off every rock, or Enter with nothing left to grow disarms it; a placed kind is disarmed by a right-click too.
**Select**, the toolbar's tool whenever nothing is armed, picks what grew: a click on moss, ivy or a fern selects that decoration, not its rock's body first.

**Collision** (Decorations' dock, Show, 2026-11-23): the collision outlines drawn over the rocks, as 2D draws them, for reference while dressing; never picked, so a click still lands on the rock (`referenceOutline` in `shownModel`, outside `inWorkspace`).
Off by default, remembered by the browser (`collision` in `prefs.ts`).
An outline is drawn in its body's colour, so over a piece whose debug geometry is on it is lost in the box of the same colour.

**Generate N out of date** asks a geometry build of every formation that is not generated or is stale (`isStale`) and has no build of its recipe queued or running; Bake stays per rock.
**Grow N out of date** does the same for decorations (`DecorationController.stale`), skipping a painted one with no paint and one that is lost.

The workspace is remembered by the browser (`rope.editor.workspace`) and written to the address (`ws=2d|formations|decorations`); the address wins on a reload.

## The 3D view (since 2026-11-22)

The editor has one view: a free 3D camera, navigated as 3D editors are, with the overlay drawn through it at any angle ([plans/editor-ux-pass.md](../plans/editor-ux-pass.md)).
The Level and Visuals workspaces it replaced, and **W**, are gone; **Level** and **Prefabs** say what is being edited rather than how it is seen, and every workspace navigates it the same way, 2D included since 2026-11-26 ([Workspaces](#workspaces-2d-formations-decorations-texturing)).

| Gesture or key | Does |
|---|---|
| middle drag, right drag | pan (but a right drag on the rock with the paint brush on erases) |
| Alt + middle drag | orbit about the view's target |
| wheel | dolly toward what is under the pointer |
| left drag, from anywhere but a handle or the gizmo | the selection band, at any angle (a click picks) |
| **F**, Numpad . | frame the selection and orbit about it (a solid guide by its own 3D box) |
| **Home** | frame everything |
| **Numpad 1**, `Align camera to plane` | the gameplay plane head on, where the view is looking |
| **Numpad 0**, `Game camera` | the game's camera where the view is looking |
| `Overlays` | the overlay over the scene, or the scene alone |
| **H**, Shift+H, Alt+H, the scene tree's eye | hide the selected nodes, hide every other one, show them all; a row's eye toggles that node and everything under it |

**Hiding** is Blender's viewport hide: a hidden body is not drawn (not in the overlay, the scene - `Scene3D.setHidden` - or the solid guides) and not picked, and is deselected as it goes. It is a view setting of the session, never in the level, and ▶ Test plays the level whole.

**The overlay is projected** (`editor/projectedCanvas.ts`).
It draws in world metres through a canvas transform, which is affine and so can only draw the plane head on; turned, a `ProjectedContext` stands in for the 2D context and carries every point through the scene's camera (`ViewProjector`), clipping each path in homogeneous coordinates to the eye and a guard band four screens wide before it reaches the canvas (a canvas clip region does not survive coordinates in the millions).
Line widths, dashes and fonts stay in head-on pixels, and a glyph - a circle or square a few pixels across, which is every handle and icon - is drawn screen-sized at its projected centre, as a 3D editor draws its overlays.
The 2D `Camera` carries the same projection while the view is turned (`Camera.project`/`unproject`), so `worldToScreen` and `screenToWorld`, and with them every handle, hit test, drag and tool, work at any angle.
It is drawn projected whenever there is a scene, head on too: the plane is the same picture either way (`cli render3d` holds the two to 1e-6 px, `visuals: head on, the projected overlay is the 2D camera's mapping`), but a mark at a depth - a selected decoration at its point on its rock, a model at its `z` - lands where it is drawn only through the camera.
A formation on a solid guide has no mark on the plane: its guide is drawn and picked in the scene.
The camera is the `VisualsWorkspace` pose (its guides are not drawn); the 2D camera is read off it every frame (`cameraFromPose`).
A chain knotted through bodies (a rope bridge, `ChainData.through`; see [scene-chains](scene-chains.md#tied-chains)) is strung out with the same tool: **Shift-release** on a body ties the chain there and keeps the draft going past the release, each further **Shift-click** on a body ties another knot, a plain click on a body ends the chain there and **Esc** drops it - so a bridge is one gesture, post, each slat's two ends, ..., post, and it starts with 3% slack.
It is drawn with small filled rings at its knots, and its panel lists the knots with a `×` each and carries `slack`, `substeps` and a length per segment in place of the one length.

The one predicate the press handler asks is `inScene()` - the Visuals workspace, or the Level workspace turned - which says a press is resolved through the scene's camera rather than the 2D camera's scale and offset; where the two differ, each branch says which it is (see [Picking](editor-visuals.md#picking) there).
**Home** resets the Level workspace's orbit as `⟲ Reset view` does.

## The view cube

Since 2026-11-23 the top right of the viewport holds a **view cube** (`src/editor/viewCube.ts`), as Blender's, Fusion's and Unity's navigation gizmos are, with the lens under it (**Persp | Ortho**, below) and the inspector under that.
The cube turns with the view: six labelled faces drawn on a small 2D canvas through the pose's own basis (`poseBasis`), back to front, each label laid on its face by an affine transform so it turns and foreshortens with it.
A click on a face swings the view to look from that side - Front (the gameplay plane head on, ending as "Align camera to plane" does), Back, Left, Right, Top (straight down, the front at the foot of the screen, as Blender's top view has it) and Bottom - about the same target and at the same distance, eased over 220 ms (`swingView`); an orbit, a pan or the wheel during the swing takes over from it.
Face on, the other five faces are edge-on and cannot be clicked, so four arrows round the cube (Fusion's) go to the face next to it that way: the face whose normal is nearest the screen's right, left, up or down.
Every workspace has the cube, 2D included since its head-on lock went (2026-11-26).

Top and Bottom are at the poles, which the view could not reach before: the pitch was clamped at 80 degrees (`MAX_ORBIT_PITCH`), because `applyPose` aimed the camera with world +y as its up, which degenerates there.
The editor's pose now goes to ±90 degrees (`MAX_VIEW_PITCH`, also the orbit drag's limit, so an orbit away from Top does not snap back to 80); past 80 degrees `applyPose` takes its up from the pose's own basis, which is the same direction there and the only one defined at the pole, and up to 80 it is world +y exactly as before.
A `CameraOrbit` (`poseFromCamera`) is still clamped at 80 degrees, so the cameras built from one are the bit they were (`cli render3d`'s `visuals: a pose from the 2D camera is today's camera to the bit`); `visuals: orbit ... clamps the pitch at the pole` checks the camera at the pole looks at its target, at its distance.

## The lens

**Persp | Ortho** under the view cube (**O** toggles) draws the scene through an **orthographic** camera instead of the perspective one (`ViewProjection` in `render3d/space.ts`).
It is an authoring instrument, not a look: a perspective camera divides by depth, so a ledge 2 m behind the plane is drawn a little smaller and pulled toward the centre of the frame - which means two things that are exactly in line in the level do not look it, and two that look it are not.
Orthographic removes the divide, so a metre is the same number of pixels at every depth and what is on screen IS the plan, which is what makes aligning off-plane geometry by eye possible at all.
Both lenses are driven from the same visible height, so the gameplay plane is framed identically through either and the overlay, the handles and the picking are unchanged by the toggle (`cli render3d` asserts both halves: the plane matches the 2D renderer to a hundredth of a view pixel, and 20 m of depth moves a point by nothing).
**The orthographic camera stands at least 200 m back** (`ORTHO_STANDOFF`, since 2026-11-27), whatever the zoom.
It orbits about the same target in the same direction as the perspective one, but its distance is not in its picture, and its near plane is: at the perspective distance, which a close zoom brings down to 0.2 m, the near plane sliced flat through every rock between the eye and the target.
Standing back draws all of it, and three's orthographic raycast starts at the eye, so it is picked too (a negative near would have drawn it and left it unclickable); `cli render3d`'s `orthographic: nothing in front of the target is clipped zoomed in` holds it.
The two cameras both live on `Scene3D` for the life of the scene rather than one being rebuilt on the toggle, since the gizmo raycasts against whichever is current and wants something stable to be handed.
A **▶ Test is always perspective**, whatever the toggle says: the point of a test is that the framing is the player's, and the player has no lens button.

The toggle is the editor's view of the whole scene, never saved and never seen by the player.

**The editor's fog is the game's.**
The level's fog (its fog regions', [lighting-and-surfaces](lighting-and-surfaces.md#regional-fog)) is hidden while authoring unless **fog in editor** is ticked in **Preview settings**, and when it is shown it - and the spots' lit air, which is drawn either way - hazes every surface by the depth the game's camera sees it from rather than the editor camera's, so zooming out or orbiting changes what is seen and never how foggy it is.
That camera is the one the game settles at for the place the editor is looking at.
▶ Test draws the fog from its own camera, which is the game's.
See [lighting-and-surfaces](lighting-and-surfaces.md#light-and-air) for how.

## SpaceMouse

Since 2026-11-25 a 3Dconnexion SpaceMouse flies the view (`src/editor/ndof.ts`, `VisualsWorkspace.ndof`).
It is a camera flying through the scene, not an orbit about a point: the cap moves the eye and turns it about itself, so it passes between and through rocks.

| Cap | Free 3D (perspective) | 2D, or Ortho |
|---|---|---|
| push away / pull back | fly forward / back | zoom in / out about the target |
| slide right, left, lift, press down | fly that way in the view's own frame | pan |
| twist anticlockwise / clockwise (from above) | turn right / left about the world's up | Ortho: orbit about the target; 2D: nothing |
| tilt back / forward | look down / up, on over the poles into an upside-down view | Ortho: orbit about the target, over the poles too; 2D: nothing |
| roll | nothing (a level view has no roll) | nothing |
| left side button | Escape, as the key (a keydown and keyup dispatched where the focus is) | the same |
| right side button | Enter, as the key, the same way (since 2026-11-26; until then the right button was Escape and the left did nothing) | the same |

The turns are the cap moving the scene, not the camera: Tris found the camera-like senses (twist anticlockwise turns left, tilt back looks up) inverted on the first play, 2026-11-25.

**Upside down** (2026-11-25): the cap's tilt carries the view on over a pole, so it can loop right round.
The pose has no roll, so upside down is a pitch past ±90 degrees (`ViewPose.pitch` in (-π, π], `wrapPitch`); `poseBasis` and `applyPose` take any pitch, their up pointing below the horizon past a pole and the level `right` turning over continuously.
Upside down the world's up points to the foot of the screen, so the twist is applied the other way about it (`fly`) and still turns the view the same way on screen.
The mouse's orbit still stops at the poles from an upright view (`nextPitch`); from a view the cap turned over it orbits on round rather than snapping upright, and stops at the poles again once it is back.

**A fixed speed.**
Full deflection flies 8 m/s (`FLY_SPEED_M_PER_S`; 4 on the first play was too slow) and turns a quarter turn a second (`FLY_TURN_RAD_PER_S`); both are linear below full deflection, as Blender's NDOF is.
The first version scaled the speed by the distance to the surface in the middle of the view, and Tris had it removed the same day.
The 2D and Ortho views are plans, so there the pan is screen-relative (a view height a second) and push/pull zooms (`FLY_ZOOM_PER_S`).
When the cap comes to rest after a flight, the view's target is put on the surface in the middle of the view (`refocus`: one centre ray, `Scene3D.drawnSurfaceAt`; the eye and so the picture are kept), so the middle-drag orbit afterwards pivots on what was being looked at.
Over open space the ray meets nothing and the target stays where it was.

**How the cap reaches the page.**
On Linux the device belongs to `spacenavd` (the daemon Blender listens to too; it grabs the evdev node).
A page cannot open its UNIX socket, so the dev server does: `src/server/ndof.ts` connects on the first editor's `ndof:hello` and forwards the cap's motion and its buttons over Vite's HMR WebSocket (`ndof:motion`, `ndof:button`), retrying every 3 s while the daemon is missing.
That needs no udev rule and no browser permission prompt (WebHID would need both), and spacenavd's own sensitivity, dead zone and axis settings (`spnavcfg`, `/etc/spnavrc`) apply here as they do in Blender.
The axes are converted to the view's as Blender converts them (`GHOST_NDOFManagerUnix`: `t = (x, y, -z)`, `r = (-rx, -ry, rz)`), normalised by 350 counts at full deflection.
Every tab hears the cap; only the focused, visible one flies, and a tab that loses focus drops the cap to rest (the release would otherwise go unheard).
It is a dev-server feature: the production editor has no bridge and ignores the device.
`SPNAV_SOCKET` points the bridge at another socket, which is how it was driven headless (a fake daemon writing protocol-0 packets).

## The transform gizmo

A single selected object or body carries the standard **red/green/blue handles** in the 3D scene - arrows to move, rings to turn, boxes to size - through three.js's own `TransformControls` (`editor/gizmo.ts`).

**All three sets are on screen at once**, and there is no mode to pick between them.
`TransformControls` is a modal control - one instance draws one mode - so this is three of them sharing one proxy, nested by size: the scale boxes inside, the move arrows through them, the rotation rings around the outside.
A mode toggle is a thing to remember and to get wrong, and reaching for a ring and turning up a move arrow because the toolbar was left on `move` is an edit that looks like the level and is not it - the same mistake a left drag that only ever bands exists to prevent on the plane.
Nested, the answer to "what will this drag do" is whatever is drawn under the pointer.

The sizes are read off the geometry three actually builds rather than chosen by eye: an axis handle sits at `0.5 x size` with a picker cone reaching `0.6`, and a rotation ring is drawn at `0.5` with a picker tube `0.1` thick, so `HANDLE_SIZE` puts the scale boxes at 0.056, the move arrows at 0.113 with their pickers stopping at 0.135, and the rings at 0.175 with their pickers starting at 0.14.
The **ratios** between the three are what the nesting rests on, so they are the part that must not be edited one at a time; the overall footprint is a taste call, and it is a quarter of what it first was, which puts the gizmo inside the thing it is transforming rather than around it.
The move arrows are what that costs - their heads are a `0.04` cone, so at this size they are a couple of pixels of drawn arrow - but what is grabbed is the picker, the full-width cone from the origin out, so they stay pickable at sizes they stop being legible at.

Two handles are dropped because the three sets would otherwise bury each other.
The **centre belongs to uniform scale**, so the move gizmo's own free-in-the-view-plane centre handle goes - its `XY` plane handle already covers the gameplay plane, which is what that one was wanted for.
Rotation's free-rotation ball goes for the plainer reason that it is a quarter-radius sphere sitting exactly where the move and scale handles are, and scale's plane handles because two axes at once is what the MOVE gizmo means.

What the nesting cannot separate is the **pickers**, because an axis picker is a cone that is widest AT THE ORIGIN: the scale box's cone lies wholly inside the move arrow's and both cover the centre.
So a press is arbitrated (`EditorGizmo.winner`) - innermost drawn first, since at the scale box's radius the box is what is on screen and the arrow is only passing through, with the centre handle beating any axis claim because it is otherwise unreachable.
Both arbitration listeners are on the **window**, and the phase is what makes each work: three's own handlers are on the canvas, so a capturing `pointerdown` runs before them (a losing set is held off with `enabled`, since three re-runs its own hover inside its press handler and would overwrite anything decided earlier) and a bubbling `pointermove` runs after them (two lit handles under one pointer is the gizmo saying it does not know what a press would do).

It is the answer to the question the overlay cannot even ask.
The 2D canvas is the gameplay plane seen head on, so it has handles for the two axes that lie in it and no way to say "10 cm toward the camera" about a lamp.
It is also the only editing there is while the view is **orbited**: the gizmo is in the scene, so it is drawn from wherever the camera is.
The two features are a pair - orbit to see the depth, drag the blue arrow to author it.

**The handles sit at the depth the object is drawn at** (`handleZ`): a light's `z`, a solid guide's middle (below), and the gameplay plane for everything else, which is where collision is.

**The gizmo never touches the model.** It moves a proxy object and the editor reads that proxy and writes the model, which is what lets it survive the scene being rebuilt from scratch on any revision that changes what it draws - that is, on most drags. A handle attached to a visual is attached to an object that is disposed a frame later, and re-attaching per frame is a gesture that cannot survive its own effect.

**The gizmo is offered for one object, one body, or the whole selection** (`gizmoSpec`), ordered by how much is known about the target rather than by how many things it holds: one object offers what it has of a depth, a turn and a size; one body turns about the centre of mass the engine mounts it at; anything wider is an ARRANGEMENT, and what an arrangement has is a place and an angle.

**A backdrop turns about the middle of its solids** (`bodyTurnPoint`, `solidCentre`), whichever control turns it - the gizmo, the 2D knob, the panel's `rot°`.
A rock with nothing that collides under it has no centre of mass to agree with, and its placement points are not where it is: a solid guide is a mesh standing anywhere in its frame, and the backdrops migrated from the river's Blender scene kept the scene's coordinates with their frame at the level's origin (or on a decoration's anchor), so until 2026-11-23 their handles stood at the top-left of the level, at z 0, metres in front of a rock 18 m deep.
The middle is each guide's own box centre carried by its placement, a point OF the solid, so it turns with the rock and the handles do not hop at the end of a turn as they would on a box measured in the world.
A rock standing in 3D (no body above it) does the same through `pivoted` (they stand at the middle, the handlers are handed the pose of the frame, and a turn swings the frame round the handles), and so does a single formation picked inside one, whose handles are also carried into the body's 3D frame (`lifted`) rather than drawn where it would be on an untilted plane.

**A handle is offered only where the format has somewhere to put its answer** (`GizmoHandlers.axes`), so what is on screen is the level's real degrees of freedom rather than three of everything:

| Target | move | rotate | scale |
|---|---|---|---|
| collision shape | x, y | z | w/h |
| light | x, y, z | z (its aim) | - (its reach is the 2D radius handle) |
| body | x, y | z, as a delta about the centre of mass | - (a body has no size; its objects do) |
| several of either | x, y, z (what has a z) | z, as a delta about the selection's centre | - (each member's own handles) |

**Several things move as one arrangement.** Selecting a handful of objects (or a handful of bodies, which means every object in them - the same set `operandItems` hands Delete, Duplicate and a nudge) puts the handles at their middle, and a drag moves or turns the lot about that point: a run of pillars, a stack of crates, a doorway and its lamp.
It is the one gesture the plane could never offer, the overlay having handles on one shape and a rotate knob on one body, so laying out an arrangement meant turning every piece about its own centre and dragging each of them back into formation.

Three things decide whether it behaves:

- **The centre is a MEAN of the members' own centres** (`selectionCentre`), not the middle of their bounding box and not `bodyCentroid`.
  A mean is a fixed point of its own rotation, so the handles stay put across a turn where a bounding box would hop sideways the moment one was released; and `bodyCentroid` answers a different question - it is mass-weighted over the COLLIDING shapes alone, because a body has to turn about the point the engine mounts it at, so a lamp selected beside a wall would be ignored entirely and a small dense block would drag the handles off the middle of what is lit up.
- **The transform is measured from the pose the drag began in** (`captureGroupPose` / `placeGroup`), because a drag re-applies its whole displacement on every pointer move.
  A delta-per-move reads identically for one move and accumulates the snap grid's rounding over a slow one.
- **A body carries its frame only when the whole body is in the selection**, which is `framesCarriedBy`'s rule and the one every other group edit already follows: dragging two objects out of a compound body moves those two and leaves the body they came from where it was.

**The blue arrow moves what has a depth and passes over what does not.** It is offered as soon as ONE member has a z - a light's own `z` - and every member that has one moves by the drag while a collision shape in the selection stays in the plane.
The stricter reading (no depth handle unless every member could move) was rejected because a level's collision IS the gameplay plane and is never anywhere else, so it would mean that a lamp selected with its bracket's collision could never be pulled forward.
Each member keeps its own depth and moves by the displacement, so two lamps 50 cm apart through z stay 50 cm apart.

**Size is deliberately absent from a selection.** Every member has its own, in its own units - an outline, a light's reach - and one handle over the lot would have to invent a rule for each; the members' own handles say it exactly.

One consequence worth knowing before reaching for it: **an axis pointing at the camera cannot be dragged**, which head on is z for a move and the ring for a turn: `TransformControls` hides a handle within a few degrees of the view direction, and maps a ring drag onto the screen direction perpendicular to both the axis and the view, which degenerates as the two line up.
Turning about z head on is therefore the 2D rotate knob's job, and moving through z head on is the **depth handle** below.
Orbited, both gizmo handles behave normally - which is the pairing: orbit to see the depth, drag the blue arrow to author it.

## The depth handle

A selected object that HAS a z - a light - carries one more 2D handle: a small blue up/down arrow beside its right edge, labelled with the value in the inspector's own units.
Dragging it up moves the object toward the camera, at the same scale x and y move at, snapped to the same grid.

It exists because z is the one axis the authoring view has no direction for, and the gizmo cannot cover it in that view for exactly the same reason (above).
So the two are complements rather than duplicates: **this is the head-on control, the gizmo's blue arrow is the orbited one**, and they are drawn in the same blue so they read as the same axis.
A collision shape gets none, because it has no z at all - it is the gameplay plane, which is what makes it collision (`hasDepth` / `depthOf` in `editor/render.ts` are the one statement of both).
A light's handle sits by its source icon rather than out at its reach, for the reason a click on a light lands on the icon: the reach is as wide as the room it lights.

Snapping is the editor's own: the same 10 cm grid and 15° step the 2D drags use, including on the sizes a scale drag writes (`scaleShape`'s `round`), so a gizmo drag and a handle drag cannot land a body in two different places.
The scene is rebuilt in full from the model - correctness beats a diff of what an edit touched - through the same `buildLevelBodies` the game loads with, so what is on screen while editing is what will be played rather than a second interpretation of the same file.
It is rebuilt whenever something it DRAWS changes other than debug geometry, and only then (`sceneKeyOf`): the key is the level as the builder gets it, with every collision piece's geometry and debug settings left out (a belt's kept) and each body's frame replaced by its objects' world placements, on every body whose pose at rest does not depend on its mass (not a pivot, a spring, a mover or water).
When the key has not moved, what has changed is at most some pieces' debug geometry, and that is rebuilt **in place** (`Scene3D.restyleDebug` → `BodyVisual.restyleDebug`): each body compares a signature of its drawn pieces (world placement, outline, resolved look) and rebuilds only its own debug pieces, placed against the frame the scene was built in and still tagged with the objects the pick map names.
So a corner dragged on a dressed rock rebuilds nothing, and one dragged on a drawn piece rebuilds that body's debug meshes and nothing else, which matters: a full rebuild on `ball` measured ~30 ms of building and nine shader programs re-linked (2026-10-07), every frame of a drag, and vertex drags on `ball` and on `cave` (all debug geometry) went from ~200 ms frames to the idle baseline with no program re-linked.
Since 2026-10-17 a full rebuild re-links nothing either: the scene it replaces is disposed only after the new one has drawn a frame and taken its programs over ([**A level's scene**](render3d.md#a-levels-scene-built-shown-retired)), and nudging a body on `ball` went from ~830 ms over four frames to one ~50 ms frame.
A new opacity below 1 compiles the see-through variant once; switching a piece on or off, recolouring it or moving its corners compiles nothing.
The world the scene keeps is then a step behind the collision until the next rebuild, which nothing drawn in the preview reads.
Chains stay on the 2D canvas there, and deliberately: the editor draws a chain **straight** because a span between wrap nodes is straight, and solving them to draw them would be a second simulation running under the editor.

**The avatar stands at the spawn** (`spawnBall` in `editor.ts`, drawn by `BallVisual` like any other host's), because a level is authored against the thing that plays it.
Every gap, ledge and shelf in the file is a decision about a 12 cm iron ball, and a ring on the overlay says where a run starts without saying how much room it takes - so a slot judged by eye was judged against nothing until it was played.
It is built here from the model rather than borrowed from a `BallLevel`, at the radius it is actually PLAYED at (`BallLevel.BALL_RADIUS_SCALE` over the authored spawn radius, which was the grapple avatar's), and nothing steps it: with no chain thrown there is nothing else of the assembly to draw, so what stands in the scene is the sphere and its mounting loop in the pose a run opens in.
The spawn marker on the overlay gained the same size as a second, fainter ring outside its own: the inner one is the marker - the thing dragged to move the spawn - and the outer one is the ball's footprint, which lands on the drawn sphere's silhouette in a 3D view and is the only thing that says the ball's size in the 2D one.

**Retired 2026-09-29**: the panel fields and tools for how a level looks - geometry objects (primitive, mesh and image), `+ Geometry`, `+ Image`, the per-object lens, match collision, the rock taper, **Fit collision to rock** and the rock seed - went when the level's look moved to its Blender scene ([blender-scenes](blender-scenes.md)); the full text is at commit `bfa6597`.

## Testing a level

`▶ Test` builds a real `BallLevel` from
the current model and run it inline (with the real camera, so a camera region is felt exactly as it will play); **Esc** returns to editing.
A test uses the real game render path, so it gets the 3D scene for free - drawn into the letterboxed frame rather than the whole canvas, since the bars are not part of the picture the player is shown.
A test also plays in the game's own fixed 1920 × 1080 frame, fitted into the editor canvas and letterboxed (see [**The view**](camera.md#the-view)): the point of ▶ Test is that the framing is what the player gets, and an editor-window-shaped view showed a different slice of the level from the one it will be played on.
**B** is the same ball test but spawned **at the cursor**, so a corner of the level can be spot-checked without walking the spawn marker over to it and back.
Selecting a **checkpoint** and pressing ▶ Test does the same thing from a place the level itself records (see [**Notes and checkpoints**](editor-model.md#notes-and-checkpoints)): the spot-check is the throwaway version of it and the checkpoint is the one worth keeping, since it is also what `?checkpoint=NAME` asks for in the game.
The override is baked into the `LevelData` the test level is built from rather than into the model, so it never edits the level, and a reset (and the exported P bundle) respawns at the same point.

**A test never plays the level's rolling entry** (`roll` in the Player spawn group - see [**The rolling entry**](ball-rolling.md#the-rolling-entry)): the ball starts at the spawn, in the player's hands, on the first frame.
A test is a spot-check of the thing being edited - press it, see whether the ledge is reachable, Esc, move the ledge - and an entry is the opening of a *run*: two metres of rolling in and a second of hands off, between every edit and the thing it is being checked against.
It is dropped from the data the test is built from rather than skipped by the driver, so the bundle a test exports describes the run that was actually played.
To see the opening itself, play the level (`?level=NAME`), which is where an opening is worth judging anyway - the editor's canvas is not the screen it will be read on.
Starting a test also **detaches the 3D gizmo**: it lives in the scene rather than on the overlay, so a selection left the editing arrows hanging in the middle of the level being played - `gizmoSpec` had always answered "none in test mode" and nothing asked it, the sync running on the edit loop and a test having its own.

**A test is the game's picture** (since 2026-11-22): the depth of field at the level the player's settings panel left (`readSettings().depthOfField`; the editor's own view is drawn without it), and nothing of the editor's in it - `Scene3D.editorLayer` (the paint coverage, the solid guides) is hidden for the test.
The depth of field reads the whole frame, so the frame target is the picture's own size rather than the canvas's with the picture in a corner (`render3d/frameTarget.ts`); the letterboxed test is then blurred exactly as the game is, and a game frame is byte-identical to before the change.

**Going in and coming back out are seamless** (2026-10-17).
Until then each cost about a second on `ball`: a ~1030 ms frame on the press and ~950 ms over three frames on Esc, measured headless on the RTX 4070.
About 800 ms of each was three.js linking the same nine shader programs again, because the editor threw its scene away for the test's and then the test's away for a fresh one of its own, and a disposed material frees its program ([**A level's scene**](render3d.md#a-levels-scene-built-shown-retired)); the rest was building the level and its scene.
Now the editor's scene is **parked** for the length of the test (`Scene3D.show` hands it back still built, and `stopTest` puts it back up), so Esc rebuilds nothing, and the test's scene is drawn with the programs the parked one keeps alive.
The test's level and its scene are **built ahead** (`prebuildTest`), because building them is real work - the level's chains and vines are settled to rest at build, ~80 ms on `ball`, and its scene is ~30 ms more.
They are built when the pointer comes onto a ▶ Test button, the click being on its way, and when the editor has been idle for 1.5 s (no edit, press, key or wheel), the level and the scene on two frames.
What was built ahead is used only if it is of exactly the data the press would build (compared as JSON, controller and start included), so a stale level is never played; `B`, from the cursor, cannot be built ahead and builds at the press.
Measured over hover, a click 250 ms later and Esc: no frame over the 16.7 ms vsync on the way in or out, and no program linked.
What is left is the idle build's own frame (~70-100 ms, 1.5 s after the last thing done), and the first test of a session still compiles what the editor's view never drew - on `ball`, one pool-mirror program (~40 ms) - which the **reflections** toggle is for.

## Authoring interface

The authoring tools are named **Just Swing**.
The editor, sound mixer and audition lab share `src/styles/studio.css`: a docked navy workspace with blue selection and amber time/clip emphasis, selected through Impeccable previews.
The editor has no navigation row of its own (since 2026-11-26): the sound mixer and the audition lab are its Sounds menu's **Edit layers ↗** and **Compare sounds ↗**.

The editor's screen (since 2026-11-26) is laid out around an unobstructed viewport:

- **The top bar** is one row: the **File** menu, then the level's own few settings - **Background** (what is behind everything, `LevelTree.background`), **Lens mm** and **Cam z** (the 3D camera, `LevelTree.camera`; blank is the default) - the workspace tabs, and **Test level**.
  **File** (`editor/menu.ts`) holds **New**, **Open ▸** (the saved levels, the open one ticked), **Save**, **Save As…**, **Sounds…** and **Delete File**, as a desktop menu: the arrows move through it and into Open's flyout, Enter picks, Esc closes, and no key reaches the editor's shortcuts while it is open.
  The level's light is not here: it is its **Sun** and **Environment** nodes, and its fog is its **fog regions** ([level-format](level-format.md#the-levels-light)).
  The level select's `title`, `intro` and `unlisted` have no control any more (there is one main level); a level that has them keeps them.
- **The tool settings** (Blender's tool header, since 2026-11-26): a strip across the viewport's top holding what the workspace's tools are set to (a brush's radius, Paint's material, a combine under way), then at its far end what is drawn and the workspace's bulk action (Generate, Grow, Bake).
  It is one row and scrolls sideways rather than wrapping, so the viewport under it never moves; hints that were paragraphs in the old dock are a line here.
  2D has none, and its view starts under the top bar: a drawn shape's body class is asked at the shape, and Root's widths are a card at the foot of the view while Root is armed.
- **The toolbar** (`editor/toolbar.ts`, `editor/toolIcons.ts`, since 2026-11-26), as Blender draws its own: each workspace's tools as a column of icons down the viewport's left edge, in blocks of related tools, the active one lit blue ([the table below](#workspaces-2d-formations-decorations-texturing)).
  The icons are one 24-unit line-art set, stroked in the text colour with one mint accent on the part that says what the tool makes.
  A tool's name, its key and what it does are its tooltip, beside it after a short rest (or at once from the keyboard); the description is the button's own `title`, taken into the tooltip as the pointer arrives, so the browser's never shows over it.
  A column too tall for the window carries on in a second, and what stands beside the toolbar moves over for it (`--toolbar-w`, measured off the blocks, since a wrapping flex column does not grow wider by itself).
  It replaced the left dock of text buttons under headings, which took a quarter of the window in every workspace for a handful of buttons and options.
  What a layer or a workspace is for is its button's tooltip, which is where the empty inspector used to say it.
- **The right dock** is the **scene tree** (its Scene tab), with the layers over it - 2D's type layers (scene, camera, notes, stacked one a row) and the data layers - and a **search** field and **expand all** / **collapse all** under its heading, or the **prefab library** (its Prefabs tab, [prefabs](prefabs.md#in-the-editor)); a prefab open for editing says so over the tree, with **Back to the level**.
  It is as wide as its left edge is dragged (double-click for the default), remembered per browser (`rope.editor.dockWidth`).
- **Over the viewport**: along its top left the view's own controls - **Overlays**, **Align camera to plane**, **Game camera** and the **Preview settings** menu (snap, edge clamp, all debug, reflections, shadows, water, roots, scene, fog in editor; editor settings, remembered per browser, never in the level); down its right edge the view cube and **Persp | Ortho**, and under them the **inspector**, a window holding the selection's panels.
  With nothing selected there is no window.
  The spawn, the Sun and the Environment are nodes like any other: their panels are what the inspector shows when the scene tree picks them.
- **The status line** along the viewport's foot says what is open, whether it is saved, what is in it, and the draft or notice of the moment.

The top bar wraps on a narrow window, and everything under it follows (`--chrome-top`, measured as it resizes).
At phone widths the scene tree's dock becomes a drawer, **Scene**, starting closed, leaving the canvas reachable; the toolbar and the tool settings stay. Native Tab navigation works while a toolbar button or disclosure has focus; Tab from the canvas still cycles edit layers. Inspector sections and sound event families are keyboard-accessible buttons with expanded state. A tool's shortcut is in its tooltip, and active tool, layer and view controls expose pressed state.
