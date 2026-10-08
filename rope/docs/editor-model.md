# Editor model: layers, outliner, notes, compound bodies

## Layers

The model is a flat list of `EdItem`s - one per SCENE OBJECT - each carrying a **`layer`** and a **`bodyId`**, listed in draw order: `scene` (the level itself: every shape, every light, everything in a body), `camera` (the camera-behaviour volumes, see [**Camera**](camera.md) below) and `notes` (authoring annotations, see below).

There were four, and geometry and lights were two of them. Merging those is the same correction the format made: a light is not a KIND OF LAYER, it is a scene object like a shape and it belongs to a body exactly as a shape does. Two layers made that impossible to express - a lamp's fitting and its light sat on different layers, so one could be hidden or locked without the other, and putting them in one body was a cross-layer selection. What distinguishes them is `EdItem.object`, which is what the FORMAT distinguishes them by: `collision`, `light` or `anchor`, one item per authored object.
There is deliberately **no decoration layer** either, and no decoration: what a level looks like is its Blender scene (see [**No decoration**](#no-decoration)).

`EdItem.bodyId` is always set - an item is a scene object, and every scene object is in exactly one body, so an item on its own is a body of ONE rather than a body of none. That replaced "grouping", and the difference is not only vocabulary: a group was an optional tag on items that were otherwise free-standing, so every path had to answer "is this grouped?" before it could answer anything else, and "no group" and "a group of one" were two states meaning the same thing. **Ctrl+G** now moves the selected objects into one body and **Ctrl+Shift+G** takes bodies apart again.

Two of a light's fields deliberately live on the item rather than in its own property object, because the item already has them and a second copy could disagree with what is drawn: its **reach** is the item's `shape`, a circle of exactly that radius, so the radius handle authors it; and its **colour** is the item's `color`, which is the one authored-rather-than-fixed furniture colour. The reach is a READOUT and not a target, though - a click on a light has to land on its source burst (`lightPickRadius`), because the pool is as wide as the room the lamp lights and picking by it made a lamp a transparent sheet over everything it lit.
Every layer that is **visible and unlocked** is hit-testable, so a selection may span layers; the other two states are excluded from picking entirely, and both drop their items from the current selection when they are entered, rather than leaving things selected that a nudge, an inspector field or a Delete would still reach.
The **active** layer is what new items are drawn onto, and it breaks a tie in the pick (`pickOrder`): a camera region blankets the geometry it governs, so a click that could mean either takes the active layer's item, and the layer switch is what says which.
Within a layer a **collision** object wins over a light whose reach it sits inside, since a click means the thing that decides where the player can go, and authored order breaks the rest.
Every visible layer nevertheless draws at **full opacity**, active or not: dimming made a layer harder to read against the geometry it annotates, the layer list already says which one a click will hit, and visibility is the control for getting a layer out of the way.
The toolbar's layer list picks it (**Tab** cycles) and carries a **visibility** and a **lock** toggle each; hiding the active layer moves the edit focus off it rather than leaving an invisible edit target, and the last visible layer refuses to go (hiding everything would leave a blank canvas nothing can be clicked on).
The two toggles are deliberately independent: hiding gets a layer *out of the way*, locking keeps it **on screen but out of harm's way** — the reference you are working against.
So a locked layer draws exactly as before and only loses the edit paths: picking, being drawn into (`refreshToolButtons` offers Select alone while the active layer is locked, and `setTool` refuses a draw tool there so the keyboard shortcuts cannot arm one either), and membership of the selection.
With nothing pickable on it, the empty inspector says the layer is locked rather than repeating the usual "click a body", which would read as the editor being broken.
A paste unlocks the layers it lands on for the same reason it un-hides them.
The list stacks **vertically**, with the toggles in two icon columns down the left - eye then padlock - because a layer stack is a fixed, ordered set you read down rather than a row of toolbar buttons.
Both are inline SVG (`eyeIcon`, `lockIcon`) rather than emoji or font glyphs, so they inherit the toolbar colour through `currentColor`, stay crisp at any DPI, and look the same on every platform.
The eye is open when the layer draws and a dimmed closed lid when it does not; the padlock's *resting* state is unlocked, so it is the dim one (a row of lit padlocks would read as "everything is locked") and locked is amber, the layer list having already spent the accent blue on "active".
A cross-layer selection gets **one panel per layer** rather than a reconciled mixed one, since the layers' properties have nothing in common (a note has no kind, a camera region no fill); the panels come in layer order, under a summary that carries the single Duplicate/Delete row, which is why the per-layer panels drop theirs (`selectionSpansLayers`) — a row inside the "2 regions" panel that also deleted the selected notes would be lying about its scope.
The inspector scrolls, because that stack can outgrow the viewport.
A paste keeps each item on the layer it was copied from and reveals (and unlocks) any layer it lands on, rather than dropping items where they can be neither seen nor clicked.
The draw tools are per-layer too (`LAYER_TOOLS`): `scene` offers `+Rect`/`+Circle`/`+Belt`/`+Poly`/`+Light`/`+Chain`, `camera` the three shape tools, `notes` `+Text`/`+Arrow`, and switching to a layer that cannot draw the armed tool falls back to Select rather than leaving a dead button lit.
`+Light` sits beside the shape tools rather than on a layer of its own, because that is what a light is: another kind of scene object, dropped into the same layer and put into a body with the shape it belongs to. It gets one tool and not the three shape ones because a light is a point with a reach, and a `+Rect` there would have to mean "a light shaped like this", which a light is not.
It is placed with a click at a reach worth having and a drag overrides that - the rule a note is placed under, and for the same reason: dropping a lamp that reaches nowhere until a field is typed into is a lamp that looks broken.
An item's `shape` (`EdShape`) is one of five kinds: `rect`, `circle`, `poly`, `path` (a camera path, or on the scene layer a collision curve) and `belt`.
A `belt` is a conveyor (see [**Conveyor belts**](conveyors.md)) and holds `wheels` (each an `EdWheel`: a centre `c` in the item's frame and a radius `r`, wheel 0 at the origin, the item's own `pos`), the band's `thickness`, the signed `speed` in m/s and the band's `look` (`BeltLook`: `width`, `texture`, `color`, `tileScale`); `edShape` and `shapeOf` convert it to and from the file's `{ kind: "belt", wheels: [{ x, y, r }], thickness, speed, ...look }` field for field, and `cli render3d`'s `belt:` round trip holds that, the wheel list included.
The wheel list is REPLACED by its one writer, `setBelt`, never edited in place, and `cloneShape` copies it, so an undo snapshot sharing a list is never rewritten by the edit it exists to undo; `setBeltWheel`, `beltInsertWheel` and `beltRemoveWheel` all go through `setBelt`, which refuses anything the build would.
`localVertices` answers a belt with its flattened OUTER loop, so the bounds, the rubber band and the surface snaps read it as a closed outline; the vertex interface stays gated on `poly` and `path`, so the loop is never edited point by point.
`pointInBody` picks a belt where it collides - on the band or inside a wheel's disc - and not in the hollow between the wheels.
Its mass and centre (`shapeArea`, `shapeCentre`) are the pieces the build weighs - a disc of `r + thickness` per wheel and a quad per run - so the point the editor turns a body about is the one the build mounts it at.
The band's look is on the shape, beside the speed that moves it, because the game draws the band itself rather than the level's Blender scene: its surface runs round the loop, which a mesh cannot.
The belt panel edits it as `width`, `texture` (a picker of the surfaces, the flat `color` offering cleats), `band colour` (absent takes the body's fill) and `tile scale`.
The wheel the panel's `r` edits is kept in the same set a polygon's picked corners are (`selectedVerts`), so every rule that drops that set drops it too, and every corner edit asks `vertexEditTarget`, which a belt never is.
A fresh item's appearance comes from `newItemStyle`, keyed by what is being DRAWN rather than by the layer alone (the scene layer draws two different things): a shape starts at the body defaults, a light at a warm flame it then authors away from, and camera regions and notes at their fixed editor-furniture colours.

Two panels sit above the selection and are always shown, because what they edit is the **level** rather than anything in it: **Level** (the title, `intro` and `unlisted` - see [**Levels**](levels.md)) and **Environment** (the light and air).
Both are carried through the model for the same reason the spawn's `hang` flag is: the editor rewrites the whole file, so a block the model does not know about is a block the first autosave deletes, and nothing about that loss is visible in the editor - the scene is rebuilt from the model, so it goes on looking however the model says.
A level that touches neither panel writes neither block, which is what keeps every level from before them byte-identical through a save.

The level's **finish line** is a body `kind` (see [**The finish line**](levels.md#the-finish-line)), picked like any other, and its panel carries no fields at all - being entered is the whole of it - only a line saying what happens when the player gets there, which is the one thing about it that is not on the canvas.
On the canvas it is an area like the others, filled with its own glyph: a chequerboard, cut out of a near-white wash thin enough to see the gantry through (a killzone is drawn to be avoided and can shout; a finish line is drawn around the prop the player is aiming at).

The camera panel carries `off x`/`off y`, `view ×`, `lock x`/`lock y`, `buffer`, `falloff` and `priority`, plus `buf left`/`buf right`/`buf top`/`buf bottom` on a rect region.
A lock is a checkbox plus a value: ticking it seeds the lock from the region's own centre (the sane start for "frame this room"), unticking shows `follow`; a blank `buffer` means the controller default, and a blank per-side buffer means the `buffer` above it.
A region draws as a dashed violet volume labelled with what it does (`cam · off 0,-250 · view ×1.8 · lock xy · buf 200`), and a locked axis draws a gold guide — a line across the region for one axis, a crosshair at the pinned point for both.
An authored `buffer` draws too, as a finely dotted outline of the volume grown by it: a buffer is the region's real reach over the camera, and it is set by eye against the arc a swing actually takes, so it has to be visible while it is being authored.
`pathOutlineGrown` (`render/shapePath.ts`) owns that geometry so it can never disagree with `pointInRegion`, and the two shapes grow differently on purpose - a rect grows per axis with **square corners**, since that is literally what its containment test does, while a polygon grows as a true offset with **filleted corners**, since its containment test is a signed distance and a mitred corner would claim reach the region does not have.

One item type rather than a union per layer is deliberate: a camera region is drawn, picked, dragged, resized, rotated, rubber-banded, duplicated and undone exactly like a body, and one type means those paths cannot drift apart per layer.
The cost is that an item carries the fields of every layer; `toLevelData` splits the list by layer and writes only the fields that layer gives meaning to, so nothing inapplicable reaches disk.

## The body outliner

The panel bottom-left lists every **body** in the level and expands each into the scene objects it is made of.

It exists because a body is the unit the format is written in and the canvas cannot show one. On the canvas a body is a diamond and a dashed hull around shapes that look like separate things, and the objects with no outline at all - a light, a chain's anchor - are either a faint ring or nothing whatever. So "which body is this in, and what else is in it" was a question you answered by clicking things and watching what else lit up.

**Every body expands, including one holding a single object.** A body and a scene object are different things - one is a container with a transform, a kind and a fill, the other is a shape or a light inside it - and a row that collapsed the two whenever a body happened to hold one object would teach exactly the confusion the format was reshaped to remove.

Selection follows the same distinction, and it is why a body has its **own selection** (`selectedBodyIds`), exclusive with the item and chain selections. Clicking a body row selects THE BODY, and the inspector then shows the body's own properties - transform, kind, fill, friction, force - and no shape, material or look, because a body has none of those. Clicking an object row selects that object alone, which is the only way to reach one with no outline.

It is a **set**, because merging is an operation on two bodies and the tree is where two bodies are picked: Shift or Ctrl on a body row (or on a canvas body, while bodies are what is selected) adds and removes, and the panel then drops the transform - there is no one frame to edit for a set - and offers **Merge**, which puts every object in them into a single body and leaves *that* body selected, so the panel is still showing a body rather than suddenly a heap of objects.
`mergeableBodies` is the one rule both the button and Ctrl+G read: a body merges only if **every** object in it may share one, since an area is single-shape wherever it is used and a merged one would silently act through its first piece alone.
Split is the inverse and hands the selection back to the objects, since the bodies it took apart no longer exist; `afterHistoryChange` drops retired body ids for the same reason, which is what undoing a merge would otherwise leave the panel pointing at.
`operandItems` is what Delete, Duplicate, Copy and a nudge act on - a selected body means **all of it** - and they read it rather than `selectedIds`, which is what left the body panel's own Delete button doing nothing at all.

On the canvas it is **click the body, then click into it**: a click on a body that is not the one being edited selects the body (and a drag on it, once selected, moves all of it), and clicking again once that body is current selects the object under the pointer. Alt still reaches an object directly. A canvas pick also **unfolds that body in the tree and scrolls to it**, so the two views cannot disagree about what is selected.

**And clicking again walks on down whatever else is under the pointer** (`pickAt`).
Every rule the pick has - depth, containment, the active layer - can only ever name ONE winner, so an object nested inside or behind other outlines was unreachable with the mouse by construction: every point of it is also a point of the things drawn over it, and there is no pointer position that means it rather than them.
A click that lands where the last one did therefore takes the NEXT answer instead of repeating the same one, cycling body, its object, the next body, its object, and back round.
The candidates are `topmostAt`'s own rule applied down the stack rather than a second ordering beside it (`pickCandidatesAt` takes its answer, removes it, and asks again), so the first candidate IS the pick and the cycle cannot disagree with it about what is on top.
A fresh click starts exactly where it always did, so the first two clicks anywhere are unchanged and this is only what happens past the point the pick used to stop.
What counts as a repeat is the same point (within `CLICK_SLOP_PX`), the same stack of candidates, AND the selection still being what the last step left: anything else - the outliner, a rubber band, an undo, a shift or alt click - has moved on, and continuing the cycle from there would jump to something nobody pointed at.
A multi-selection is the one press that still has no pick at all, since a click that meant to drag it and did not travel must not silently collapse it to one object.

A selected body **outlines its objects in blue**, each on its own rather than as the body's union outline.
That is the question it answers - how many objects there are and where each one is, which the union deliberately hides - and it is the only thing on the canvas that says what a body is made of while none of its objects is selected.
It is blue and not the selection orange for the same reason: orange everywhere else means "an edit applies to this", and these objects are outlined precisely because they are NOT selected.
The objects with no outline of their own get a ring at the mark a click has to land on, since a light's own circle is its reach and an anchor has no shape at all.

An object's `x`/`y`/`rot°` in the inspector are **relative to its body**, because that is what the file records - a panel showing world coordinates would be showing a number the level does not contain.
Relative means in the body's own **frame**, rotation included (`localPlacement`, the inspector's side of `toLevelData`'s `localOf`): the world-axis distance to the body's origin is a different number the moment the body is turned, and a body turned 15° showed an object the file records at (20, 20) as (14.1, 24.5).

**The body's frame is the body's own** (`EdModel.bodyFrames`), and not a member's.
It was read off the body's FIRST object for as long as the editor had nowhere else to put it, and that made that object secretly the body: moving it moved the frame, and since every sibling is recorded as an offset from the frame, every sibling's offset changed by the same amount to compensate.
Nudging one collision shape 10 cm therefore wrote a body moving 10 cm and every other object in it moving 10 cm back - the same geometry on screen, recorded as an edit nobody made, in a panel that then read as the body having moved rather than the shape.
Stored, an edit to one object changes that object's offset and nothing else.

The frame moves when the BODY moves, and `translateItems` / `rotateItemsAbout` are the one statement of what that means: they carry a body's frame exactly when every one of its objects is in the set being moved.
So it is one rule rather than a decision at each of the dozen gestures that move something - a drag, a nudge, an inspector field, a gizmo handle, a group rotate - and a gesture cannot move a body's frame by accident.
`captureGroupPose` is the third writer and states the same rule for the same reason: the gizmo's multi-selection transform works from a snapshot rather than a delta (see [editor](editor.md#the-transform-gizmo)), so it records the frames it may move at the moment the gesture begins and carries only the bodies that are in the selection whole.
A frame is **absent** until a body holds more than one object, where it means "wherever the first object is": that is exact for a body of one, since any move of that object is a move of the whole body, so a level of simple bodies stores nothing and saves byte-for-byte as it did.
What makes the rest safe is that every body holding more than one object has its frame written down before anything is edited, once per undo step in `beginAction` - membership grows by merging, by drawing into a selected body and by pasting, and settling it in one place is what stops the next of those forgetting a rule it is not written into.

A load records a frame for exactly the bodies whose file **states** one somewhere no object sits, which is the reading that lets an authored origin survive being reopened.
Where the file's frame is simply the first object's placement - every body an editor save has written whose first object carries no offset at all - nothing is recorded and the frame goes on being derived, so a level opened and saved untouched is still byte-stable and a body of one object is still `framedByItself`.
The exception is a frame of **(0, 0, 0)**, which is not a stated frame but what a body migrated out of a retired flat entry is given: the objects keep the world placements the flat entries carried and the origin is left at zero, because that is the only migration that is bit-identical (`normalizeLevelData`).
Read as stated it would leave such a body measuring from the world origin rather than from its own shape, so a frame of all zeroes with nothing at it is re-origined onto the first object as it always was.

**Origin to COM**, on the body panel, moves a body's origin onto its centre of mass and lets every object's offset take up the step (`originToCentroid`).
Nothing in the level moves; what changes is the frame the placements are recorded against.
It is worth having because the centre of mass is the one point a body is really about - `buildLevelBodies` puts the engine origin there whatever the file says, the panel's `rot°` turns the body about it, and a body's route is a run of offsets from its origin - so with the origin left on whichever object happened to be written first, `x` and `y` read as a corner of some piece, turning the body walks them, and the drawn route hangs off that corner rather than off the point the platform travels by.
Two things are recorded *in* the frame and so are carried with it.
The **bearing** (`pivotAt`) is a world point written as an offset from the origin, so it is re-measured and the body goes on turning about the same place in the level.
The **route** is not: its nodes are offsets from node zero - the origin itself - and `moverScript` adds the body's pose back, so leaving them alone is what keeps the travel identical to the bit; the drawn route moves by the same step the origin did, because it is the path the origin takes.
It is offered rather than done automatically, since where a body's origin sits is the author's business: a hinge pinned on the bracket it swings from reads better than one floating in the middle of the assembly, and nothing downstream needs the two to agree.
The four `cli render3d` cases assert it across the round trip an author performs - press it, autosave, reopen - because the frame is the one thing about a body that is not in the model's items, and a load that re-derived it would write the undo to disk on the next autosave.

**A new object drawn while a body is selected joins that body.** With a body selected the thing being authored is a part of it - a second shape for a compound wall, the light a lamp throws - and making it a body of its own would mean drawing it, selecting both and merging, every time. It takes the body's kind, fill and friction on the way in (`syncBodyProps`), since a body has one of each. An area is refused for the reason `canShareBody` gives; camera regions and notes are never in a body in any meaningful sense and keep getting one of their own.

## No decoration

There is no decoration in the editor, because there is none in a level: what a level LOOKS like is its Blender scene (see [blender-scenes](blender-scenes.md)), and the level holds what the game simulates and lights.
An object in the scene named like a body (the body panel's `name`) is that body's dressing and rides it; everything else in the scene is scenery where Blender put it.
A collision shape is drawn in 3D only by its own debug geometry, switched on in its Debug section (see [editor](editor.md#debug-geometry)); a level with no scene is seen by that alone.

Decoration used to be a body of geometry objects and no collision object, before that a `collision: false` flag, and before that a `backgrounds` list.
Every one of those forms is folded away by `normalizeLevelData` at load: the geometry objects are dropped, and a body left with nothing in it is dropped too, since it builds, lights and draws nothing.
The full history of the section is at commit `bfa6597`.

## Notes and checkpoints

The **notes** layer is what the player never sees: authoring commentary - a text box or an arrow, recording *why* a piece of geometry is where it is so that it is not later removed as arbitrary - and **checkpoints**, the named places a playtest can be started from.
Nothing on it is drawn in play, and nothing on it collides, is wrapped or reaches the sim, which is why none of it is a `BodyKind`.
Notes serialize to `LevelData.notes` (`NoteData` in `levelFormat.ts`) and no runtime path reads that list at all; a checkpoint serializes to `LevelData.checkpoints` (`CheckpointData`), which is read in exactly one place - where a level is chosen, to move `player` before the level is built (see [**Checkpoints**](running.md#checkpoints)).
The layer is what a thing is **edited** as; the list it is written to is what the game **does** with it.

A note is always a **rectangle** (a circular note has no meaning), so `NoteData` carries `w`/`h` directly rather than a `ShapeData`.
A text note's box holds its **word-wrapped** text (explicit newlines honoured; a word wider than the box gets its own line rather than being broken mid-identifier, since most of what a note names is an identifier).
An **arrow** is a segment, but it is stored as that same box — length × a fixed pick band — so it moves, rotates, rubber-bands, duplicates and undoes through exactly the same code as every other item; the shaft runs along the item's local +X from `(-w/2, 0)` to `(+w/2, 0)` with the head at the +X end, so `rot` aims it.
The one thing it does differently is **editing**: an arrow shows round **endpoint handles** instead of corner boxes and a rotate knob, because dragging one end sets position, length and direction in a single gesture where the box handles would take three (`arrowEnds`/`setArrowEnds` in `model.ts` are the shared conversion, used by both the endpoint drag and the initial draw, so an arrow drawn from scratch and one re-aimed later are identical).

Notes are drawn **above** everything they annotate — commentary hidden behind the geometry it explains would be useless — in green, with a dashed box like every other volume the player passes through so a note can never read as a wall in a screenshot.
Everything about a note is **world-scaled** — glyph height, box, arrow shaft and head — so an annotation keeps its relationship to the geometry it points at instead of swelling over the level as you zoom out; the glyphs themselves are drawn in screen space at the projected size, which keeps them crisp without changing that.
An empty note draws a dimmed `(empty note)` placeholder rather than nothing at all.
Placing a text note focuses the inspector's textarea, so the first act after dropping one is typing rather than a trip to the panel; that textarea snapshots undo on the **first keystroke** rather than on focus, since placing the note focuses it and a focus-time snapshot would make the first Ctrl+Z a visible no-op.
**Double-clicking** a text note opens the same textarea with the caret at the end of what is written - the gesture every canvas editor uses for "edit this thing's content" - and scrolls it into view, since the inspector is a scrolling stack of per-layer panels.
The prose deliberately keeps living in that one textarea rather than gaining a second, in-canvas editor that could disagree with it; the double-click only selects the note and moves the caret.
Both paths go through `focusNoteText`, and the placement one has to `preventDefault` its mousedown: the default action moves focus to the document *after* the listener runs, so without it the textarea was blurred the instant it was focused (which is why placement focus never actually worked).
It is the one canvas press that suppresses the default - every other one must keep it, or clicking the canvas would leave an inspector field focused and the keyboard shortcuts swallowed by it.
Prose stays a single-selection edit (merging text across a group has no sane meaning) while placement stays group-wide like every other layer.

A **checkpoint** is dropped with `+Checkpoint` (**S**), and it is a named *point*: it has a place, a name, and nothing else.
It is drawn as the **spawn marker's own glyph** - a ring at the avatar radius with a crosshair through it - in the notes green rather than the player blue, since the level has exactly one spawn and a second blue ring would read as a second one.
Its ring is derived from `model.player.radius` every time one is loaded or placed (`checkpointBox`) rather than authored, so nothing on disk holds a size that could drift from the avatar it stands for; with no size to author there is no drag to size it with, no corner handles, no rotate knob and no `rot°` field - the press places it and that is the gesture.
The **name** is `EdNote.text`, the same field a note's prose lives in doing the same job: the one piece of writing the item carries, placed into with the same caret-in-the-field gesture, opened by the same double-click, and undone on the first keystroke for the same reason.
It is a single-line input rather than a textarea because a name is half of a query string, and it is cleaned of newlines and edge whitespace on the way in so a pasted one is still something that can be typed into an address bar; the panel prints the full `?level=…&checkpoint=…` under it, and says so when a marker is still unnamed.
The name is matched trimmed and ignoring case at load, and a blank or repeated one is dropped there with a warning - so the editor lets an unnamed marker exist (an unfinished edit, not a corruption: dropping it at a save would delete a marker that had just been placed) while the game refuses to guess what it meant.
Selecting one and pressing **▶ Test** starts the test from it, through the same spawn override the cursor spot-check (**B**) uses, so a reset during the test and the bundle it exports both come back to the checkpoint.

## Compound bodies

**Ctrl+G** welds the selected geometry into one **compound body** (**Ctrl+Shift+G** splits it again); the pieces keep their placement exactly, and what changes is that they now build as a single engine body carrying all their shapes.
That is the whole point, and it is not about saving entries - several overlapping bodies already look the same.
It is that the joins between the pieces stop being corners: the rope refuses to wrap a seam vertex (`isSeamVertex`) and ledge detection refuses to grab one (`isSeamOccluded`), so a span crossing an L's inner corner runs straight instead of snagging where the real surface is smooth.
See **"Convex-only polygons; compound bodies"** in `docs/game-design.md` for why a concave form is several convex pieces at all - and **Authoring a concave outline** there for the case where those pieces are derived from one authored outline instead of welded by hand, which is the same body by the time anything simulates it.

Both of those ask **`isExposedCorner`** (`engine/shapes.ts`), and it decides by **angle, not proximity**.
Every shape covering the vertex contributes the arc of directions pointing *into* it - a wedge at one of its own corners, a half-plane along one of its faces, the whole turn if the vertex is inside it - and the vertex is a real corner exactly when the union of those arcs leaves more than a half-turn uncovered.
That is what a corner *is*: a flat point is covered by exactly half a turn, a reflex one by more, a buried one by all of it.
The vertex's own shape goes into the union with the rest, since it is what establishes there is a corner there at all.

Proximity was the old test - "is the vertex within an epsilon of a sibling" - and it is wrong in the arrangement a snap grid produces most: two pieces whose corners land on the same point.
That point is the **outer** corner of an L, with three quarters of a turn of outside around it, and calling it a seam sent the rope clean through a wall for seven frames (`session-410f`).
`cli corners` runs the arrangements with the answers written down (`sim/cornerCases.ts`) - it is pure geometry, so it is checked directly rather than through a level, where a wrong answer only surfaces as a rope inside a wall several hundred frames later.

Neither caller asks it per query any more. Exposure is a property of how a body's pieces are **arranged**, and that arrangement is rigid - every piece rides the body's transform, so moving or turning the body carries them all and cannot expose or bury a corner.
So it is settled once and cached on the shape (`CollisionShape2D.isVertexExposed`, invalidated when the shape set changes), and `isSeamVertex` is a lookup by vertex index.
`isSeamOccluded` takes that as its first answer and only then asks the *dynamic* half - neighbouring bodies, which do move relative to the corner. That decomposition is exact rather than an optimisation: coverage only grows as geometry is added, so a corner its own body has already closed off cannot be reopened by a neighbour.

A body's look is its Blender dressing, bound by the body's `name`, which rides the body however it moves; the collision it is built of says nothing about how it looks.

On disk it is simply several collision objects in one body's `objects` list - there is no tag to agree about, because the containment IS the statement.
A body has one kind, one fill, one friction and one force, and they live **on the body** rather than being authored per member and collapsed onto the first - which is what the flat form had to do, and what the editor had to keep in step behind it.
**Material and thickness are the exception** and stay per piece: a body's mass, centre of mass and inertia are sums over its shapes, so a stone head on a wooden shaft is a compound body of two materials and collapsing them onto the lead's would be the editor overwriting what was authored.
An area may not share a body with anything: `World.integrate` tests area overlap against `primaryShape()` rather than `getShapes()`, so a killzone or force area of several pieces would silently act through its first one alone, and the editor refuses to merge one.

Because a group is one body, it is **selected and moved as one**: clicking any piece selects all of them, a rubber band that touches one piece takes the whole body (`withWholeGroups`), and **Alt+click** reaches past that to a single piece when its own shape needs editing.
It also **rotates as one**, about the group's area-weighted **centre of mass** - which is where `buildLevelBodies` puts the built body's origin, so the editor's rotation and the body's are the same operation.
That sum weighs each piece at **its own** centre of area (`shapeCentre`) rather than at its placement: a rect and a circle are centred on their origin, but a polygon's origin is wherever the author left it (a corner edit never moves it - see [editor](editor.md)) and its mass is at its centroid, so weighing placements would put the turning point somewhere no mass is.
A whole-group selection therefore gets its own rotate knob (placed by the group's extent, since the pieces have their own angles and the body as a whole has none) and its `rot°` field applies a *delta* to the group rather than writing each piece's own angle.
Every group draws a small centre-of-mass diamond so it is identifiable as one body without being selected first, and a selected one adds a dashed hull and spokes to that centre.

A compound body is drawn as **one object**, not as its pieces: the shapes are filled as a union with the nonzero rule (so an overlap contributes one layer of the authored opacity rather than one each) and each piece is stroked only where it lies **outside every sibling**, which is the body's real outline.
The selection halo is the same walk over the **selected** pieces alone rather than over the whole body, which is what makes Alt+click's whole point visible: one piece picked out shows its own full outline, seam edge included, because that outline is what the piece IS, and every piece selected shows the body's outline with no seams drawn across it.
Haloing the body whenever any member was selected said the edit applied to all of it, which for a numeric field or a Delete is exactly what it would not.
Drawn piece by piece it read as a darker patch at every overlap and a crack at every join - a wall with a line down it.
The clip is applied one sibling at a time on purpose: a single even-odd clip keeps the region inside *two* of them, which is exactly where an interior seam sits.
`drawCompoundGeometry` (game) and `strokeCompoundOutline` (editor) are the two implementations of that one rule.
Hook-only bodies keep the per-shape path, since their fill is a grate lattice punched out of each piece and a lattice has no union form.
The headless SVG snapshot still draws the pieces separately - it is a diagnostic view, and there the decomposition is the thing worth seeing.
