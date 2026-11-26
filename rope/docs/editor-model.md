# Editor model: the node tree, layers, the scene tree, groups, notes, compound bodies

The editor holds a level as its **node tree** ([level-format](level-format.md#the-node-tree), [plans/node-tree.md](../plans/node-tree.md)) and draws, picks and edits it through items, one per thing on the canvas.
This page is the model behind that: the tree and its items, the type layers and the data layers, the scene tree, groups, the selection rules, notes and checkpoints, and compound bodies.
Prefabs, which the model places as instances, are in [prefabs](prefabs.md).

## The node tree

`EdModel.tree` (`EdTree`, `src/editor/tree.ts`) is every node of the level by id, each `EdNode` knowing its parent, its ordered children, its name, whether it is `grouped`, the data layers it is in and whether it is `disabled`.
What a node IS lives on it, once: a body's properties are its node's `body` (`EdBody`, every field present, an absent one written as its default), a placed prefab's are its `instance`, and a chain's and a vine's payload is theirs.
Fields of a class the editor does not model ride along in `extra`, so a load and a save lose nothing on disk.

**Items are the payloads of nodes.**
`EdModel.items` is one `EdItem` per thing the canvas draws: a collision shape, an anchor, a light, a model, a rock, a decoration, a volume, a path or a note.
Each names its node (`item.node`), and the node is what is selected as a set, named, grouped, layered and parented.
`relink` points every item at the nearest body above its node (`bodyOf`, and that body's properties as `body`, shared by every piece under it, so a body's friction is one number however many pieces it has) and at its `unit`: its body's node, or its own when no body carries it.
The gestures and panels that act on "the body this piece is in" act on the unit.

**Placement.**
The editor works in world metres: an item's `pos`/`rot` (and a 3D node's `z` and `tilt`) are where it stands in the world, and the frame it is recorded against is its parent's, worked out on the way to disk.
A node keeps the local placement it was loaded with (`local`), and while it and its parent stand where they were loaded it is written back with exactly those numbers, so opening and saving a level moves nothing by even an ulp, which every recorded replay of it depends on.
A body's frame is its node's own placement, stored and moved only when the body is: an edit to one of its pieces moves that piece alone.

**In and out.**
`modelFromTree` reads a tree (in metres) into a model: it compiles the tree and places every node in the world as the compile placed it, reading the EXPANDED tree so a placed prefab's insides are nodes and items too, marked as the instance's.
`toTree` writes the model back as a tree, each placement in its parent's frame, an instance as its prefab, key, scale and overrides ([prefabs](prefabs.md#in-the-editor)); given a `keep` filter it writes a fragment (the kept nodes, everything above them, the chains and vines strung wholly between them), which is what the clipboard and Duplicate use.
`toLevelData` is `compileLevel(toTree(model))`, the flat level the 3D preview and ▶ Test are built from, and it records which item each compiled object came from, so a pick on the drawn scene names an item.
`modelToDisk` is the level file (the tree in pixels); `modelToFlatDisk` is the flat level that file compiles to, in pixels, for the cases that read a body back and for a test level.
`modelFromDisk` reads any level source (a tree, or a flat level migrated) into a model.

## Layers

Every item carries a **`layer`**, a fixed filter by what the item is, listed in draw order: `scene` (the level itself: every shape, every light, everything in a body, and the plane's two volumes that are things in the level, fog and shelters), `camera` (the camera-behaviour volumes, see [**Camera**](camera.md) below) and `notes` (authoring annotations, see below).
A `fireflies` layer held the firefly paths until fireflies were removed on 2026-11-26.
They are the type filters of the plan's data layers, and the user's own layers sit beside them ([below](#data-layers)).

**Fog and shelters were layers until 2026-11-26** and are scene objects now (`EdObject` `fog` and `shelter`), for the reason lights stopped being one ([below](#layers)): a fog region is not a KIND OF LAYER, it is a thing in the level that owns its fog, and a shelter is a cave's front wall.
A **fog region** is a `FogRegion2D` node: a rect or a circle (its panel switches between them, keeping its extent), a transform, and its own fog - `amount`, `colour` and an inward edge `falloff` (100 px = 1 m) - in `EdItem.fog` ([regional fog](lighting-and-surfaces.md#regional-fog)).
`+Fog` drags one out carrying a fog worth seeing (`NEW_FOG`), and the scene tree's `+` adds one at the view's centre.
A **shelter** is a `Shelter2D` node ([**Shelters**](lighting-and-surfaces.md#shelters)): `+Shelter` clicks out its outline as `+Poly` does, concave corners and all, and its panel carries the wall's `front`.
Neither ever joins a body (`canShareBody`): the camera and the sky read both as fixed in the world.
With fog on the regions there is no level-wide fog left to mask, so the `fogMasked` flag and the Environment panel's **fog regions only** box went with them: a level with no fog region has no fog.

A click on anything off the scene layer selects the item itself, in one click: none of it is in a body, so the body step the scene layer takes first (body, then object) would be a panel of physics, bounce and mover fields for a thing that has none.

There were four, and geometry and lights were two of them.
Merging those is the same correction the format made: a light is not a KIND OF LAYER, it is a scene object like a shape and it belongs to a body exactly as a shape does.
Two layers made that impossible to express - a lamp's fitting and its light sat on different layers, so one could be hidden or locked without the other, and putting them in one body was a cross-layer selection.
What distinguishes them is `EdItem.object`: `collision`, `light`, `anchor`, `model`, `formation` or `decoration`, one item per authored node.

Two of a light's fields deliberately live on the item rather than in its own property object, because the item already has them and a second copy could disagree with what is drawn: its **reach** is the item's `shape`, a circle of exactly that radius, so the radius handle authors it; and its **colour** is the item's `color`, which is the one authored-rather-than-fixed furniture colour. The reach is a READOUT and not a target, though - a click on a light has to land on its source burst (`lightPickRadius`), because the pool is as wide as the room the lamp lights and picking by it made a lamp a transparent sheet over everything it lit.
Every layer that is **visible and unlocked** is hit-testable, so a selection may span layers; the other two states are excluded from picking entirely, and both drop their items from the current selection when they are entered, rather than leaving things selected that a nudge, an inspector field or a Delete would still reach.
The **active** layer is what new items are drawn onto, and it breaks a tie in the pick (`pickOrder`): a camera region blankets the geometry it governs, so a click that could mean either takes the active layer's item, and the layer switch is what says which.
Within a layer a **collision** object wins over a light whose reach it sits inside, since a click means the thing that decides where the player can go, and authored order breaks the rest.
Every visible layer nevertheless draws at **full opacity**, active or not: dimming made a layer harder to read against the geometry it annotates, the layer list already says which one a click will hit, and visibility is the control for getting a layer out of the way.
The layers are the 2D workspace's: the Formations and Decorations workspaces work on the scene layer alone and do not draw the others ([editor](editor.md#workspaces-2d-formations-decorations-texturing)).
The layer list over the scene tree (in the right dock since 2026-11-26, shown in 2D) picks it (**Tab** cycles, in 2D) and carries a **visibility** and a **lock** toggle each; hiding the active layer moves the edit focus off it rather than leaving an invisible edit target, and the last visible layer refuses to go (hiding everything would leave a blank canvas nothing can be clicked on).
The two toggles are deliberately independent: hiding gets a layer *out of the way*, locking keeps it **on screen but out of harm's way** — the reference you are working against.
Both survive a reload: the browser remembers them (`rope.editor.layers`, [editor](editor.md)), and boot applies them through the same setters the toggles use, so a remembered hidden active layer moves the edit focus just as a click would.
So a locked layer draws exactly as before and only loses the edit paths: picking, being drawn into (`refreshToolButtons` offers Select alone while the active layer is locked, and `setTool` refuses a draw tool there so the keyboard shortcuts cannot arm one either), and membership of the selection.
With nothing pickable on it, the empty inspector says the layer is locked rather than repeating the usual "click a body", which would read as the editor being broken.
A paste unlocks the layers it lands on for the same reason it un-hides them.
The list stacks **vertically**, each layer a row of its toggles - eye then padlock - and its name, because a layer stack is a fixed, ordered set you read down rather than a row of toolbar buttons.
The eye and the padlock draw no pressed fill: their drawing (open or shut, lifted or closed) is their state.
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
The band's look is on the shape, beside the speed that moves it, because the game draws the band itself rather than a Blender export: its surface runs round the loop, which a mesh cannot.
The belt panel edits it as `width`, `texture` (a picker of the surfaces, the flat `color` offering cleats), `band colour` (absent takes the body's fill) and `tile scale`.
The wheel the panel's `r` edits is kept in the same set a polygon's picked corners are (`selectedVerts`), so every rule that drops that set drops it too, and every corner edit asks `vertexEditTarget`, which a belt never is.
A fresh item's appearance comes from `newItemStyle`, keyed by what is being DRAWN rather than by the layer alone (the scene layer draws two different things): a shape starts at the body defaults, a light at a warm flame it then authors away from, and camera regions and notes at their fixed editor-furniture colours.

**Nothing in the inspector is always shown** (since 2026-11-26): it is the selection's window, and with nothing selected it is not drawn.
What used to sit above the selection is where it belongs now.
The level's light is its **Sun** and **Environment** nodes ([level-format](level-format.md#the-levels-light)), picked in the scene tree like the spawn, each node's fields carried in its `extra` (`skyFields`, `lightNode`, `environmentOfModel`); deleting the Sun is how a level goes underground.
The background and the 3D camera are the top bar's (`EdModel.background`, `EdModel.camera`).
The level select's `title`, `intro` and `unlisted` (`EdModel.meta`, [**Levels**](levels.md)) have no control, since there is one main level, and are still carried through the model for the reason the spawn's `hang` flag is: the editor rewrites the whole file, so a block the model does not know about is a block the first autosave deletes, and nothing about that loss is visible in the editor.
A level that authors none of them writes no block, which keeps every level from before them byte-identical through a save.

The level's **finish line** is a body `kind` (see [**The finish line**](levels.md#the-finish-line)), picked like any other, and its panel carries no fields at all - being entered is the whole of it - only a line saying what happens when the player gets there, which is the one thing about it that is not on the canvas.
On the canvas it is an area like the others, filled with its own glyph: a chequerboard, cut out of a near-white wash thin enough to see the gantry through (a killzone is drawn to be avoided and can shout; a finish line is drawn around the prop the player is aiming at).

The camera panel carries `off x`/`off y`, `view ×`, `lock x`/`lock y`, `buffer`, `falloff` and `priority`, plus `buf left`/`buf right`/`buf top`/`buf bottom` on a rect region.
A lock is a checkbox plus a value: ticking it seeds the lock from the region's own centre (the sane start for "frame this room"), unticking shows `follow`; a blank `buffer` means the controller default, and a blank per-side buffer means the `buffer` above it.
A region draws as a dashed violet volume labelled with what it does (`cam · off 0,-250 · view ×1.8 · lock xy · buf 200`), and a locked axis draws a gold guide — a line across the region for one axis, a crosshair at the pinned point for both.
An authored `buffer` draws too, as a finely dotted outline of the volume grown by it: a buffer is the region's real reach over the camera, and it is set by eye against the arc a swing actually takes, so it has to be visible while it is being authored.
`pathOutlineGrown` (`render/shapePath.ts`) owns that geometry so it can never disagree with `pointInRegion`, and the two shapes grow differently on purpose - a rect grows per axis with **square corners**, since that is literally what its containment test does, while a polygon grows as a true offset with **filleted corners**, since its containment test is a signed distance and a mitred corner would claim reach the region does not have.

One item type rather than a union per layer is deliberate: a camera region is drawn, picked, dragged, resized, rotated, rubber-banded, duplicated and undone exactly like a body, and one type means those paths cannot drift apart per layer.
The cost is that an item carries the fields of every layer; `toTree` writes each item as its node's class with only the fields that class gives meaning to (`itemFields`), so nothing inapplicable reaches disk.

## Data layers

The user's own **data layers** (Unreal's meaning) sit under the type filters in the toolbar: layers made and named in the editor, saved in the level (`LevelTree.layers`), and any node may be in any number of them (its `layers`).
A node is in its ancestors' layers too (`layersOf`), so a layer holding a body holds everything in it, and hiding a layer hides whole subtrees.
Each row has an eye and a padlock, `+sel` and `−sel` to put the selection in or take it out, and `×` to remove the layer from the level and from every node; `+` in the heading makes one.
A node's own **Node** section lists the layers as checkboxes, one it inherits from a parent ticked and greyed.

A node is drawn only if no layer it is in is hidden, and picked or edited only if none is locked, which is the type layers' meaning of the two toggles.
Hidden and locked are this session's view state, never written; the game ignores layers altogether, as it ignores groups.

## The scene tree

The right dock is the **scene tree** (it replaced the body outliner on 2026-11-26, and moved from the bottom of the left dock to a resizable right dock the same day): every node of the level, nested as the level is nested, each row with its class's mark, `2D` or `3D` (nothing for a node with no place, the Sun and the Environment among them), its name, the group mark, a `+`, an eye and a padlock.
Over it a breadcrumb shows the selected node's path of names, and over that the **data layers** ([below](#data-layers)) and a **search** field with **expand all** and **collapse all**.
A search shows the nodes whose name or class holds the query and the rows down to each (dimmed, opened whatever was open), and the heading counts the matches; Escape or clearing it gives back the tree as it was left.
In the 3D workspaces it lists only what is in the workspace or holds something that is.

- **A row click selects exactly that node**, grouped or not, as Godot's does; Shift or Ctrl extends the selection.
  It is the only way to reach a node with no outline of its own: a light's reach is not where it is picked, an anchor has no shape, and a plain `Node2D` draws nothing.
- **A drag reparents**: onto a row puts the node under it, between rows puts it among those siblings.
  It keeps where the node stands in the world (Unreal's "keep world"), rewriting only the frame it is recorded against; with **Alt** held it keeps its local numbers instead, landing at the same offset on its new parent.
  A drop the tree would not have (`canParent`: under itself, a 2D node under a 3D one, a body under a body that moves or can vanish, a decoration anywhere but on a formation) is not offered, and a refused move is undone with the reason.
  Reparenting and reordering never change a body's build order key, so they change draw order in the editor and nothing in the sim ([level-format](level-format.md#build-order)).
- **Double-click** a name to rename it in place; Enter keeps it (suffixed when a sibling has it), Escape puts it back.
  The Node section's `name` field does the same.
- **`+`** adds a node under the row (the heading's `+`, at the top level): a `Node2D`, a `Node3D`, a static or rigid body, a killzone, an anchor, a fog region, a shelter or a folder `Node`, standing where its parent stands, and the level's `Sun` or `Environment` while it has none, each offered only where the tree would have it (`canParent`: the light stands at the top or in a folder, and holds nothing).
- **Delete** with nodes picked as themselves (a body, a group, the Sun) takes each with everything under it; a node holding the spawn is refused, since the spawn is the level's.
- **The group mark** (⊞) is the node's `grouped` toggle: lit blue on a grouped node, drawn dim under the pointer on one that is not, and a click flips it as Ctrl+G / Ctrl+Shift+G do, one undo step.
- **The eye** hides the node and everything under it (as **H** does), a session view setting like the rest of hiding.
- **The padlock** locks the node ([below](#locking)): amber on a node locked itself, dim and shut on one a node above it locks, and drawn only under the pointer otherwise, so several hundred rows do not read as a column of open padlocks; its column is kept on every row so the eyes line up.

Which rows are open is kept by node id across rebuilds, so a drag does not collapse the tree under the pointer; the tree is rebuilt when the model changes and only re-highlighted when the selection does, since a real level is several hundred nodes.
A canvas pick unfolds the rows down to what it selected and scrolls to it, so the two views cannot disagree about what is selected.

A placed prefab lists what was added under it, and its prefab's insides only once its **editable children** is ticked ([prefabs](prefabs.md#in-the-editor)).

## Groups

Any node can be **grouped** (`grouped`, saved in the level), and grouping changes only what a click on the canvas selects: nothing about transforms or the sim.
Groups nest.

A group is **entered** while its root or anything inside it is selected (Figma's rule).
`clickTarget` (`editor/tree.ts`) applies it from the outermost group root on the path down to the node under the pointer: a group not entered selects its root; an entered one passes the click on to the next group root further down, and with none left the node under the pointer is selected.
So with a shape S inside group G2 inside group G1, three clicks on S select G1, then G2, then S; with S selected a click on its sibling T selects T directly.
Selecting something outside G1 leaves it, and the next click inside selects G1 again.

- **Every body is created grouped**, and migration grouped every existing one, so the canvas keeps the click-the-body-then-click-into-it feel; ungrouping a body makes its pieces directly clickable.
  A placed prefab is grouped too.
- **Alt+click** ignores groups and selects the node under the pointer.
- **A rubber band** selects the outermost group root of everything it takes (`outermostGroup`).
- **The scene tree** ignores groups.
- **Ctrl+G** groups the selection: one node is flagged, several are first put under a new group node (a `Node2D`, or a `Node3D` when all of them are 3D) standing on their centre.
  **Ctrl+Shift+G** ungroups, and the Group / Ungroup button and the Node section's `grouped` box do the same.
- **Per workspace**, only a group root whose class is clickable there stops a click (`clickableIn`, `editor/workspaces.ts`); the rest pass it through.
  2D stops at bodies, shapes, anchors, the plane's volumes, chains, vines and instances; Formations at bodies (since 2026-11-26: a body's Transform and Formation are this workspace's, and a click passed through it to the collision a guide is taken from), `Node3D`, `Formation3D`, `Model3D`, `Light3D` and instances; Decorations at decorations alone, so a click on a fern selects the fern though the body above it is grouped; Texturing at nothing, its work being the brush.

**And clicking again walks on down whatever else is under the pointer** (`pickAt`).
Every rule the pick has - depth, containment, the active layer - can only ever name ONE winner, so an object nested inside or behind other outlines was unreachable with the mouse by construction: every point of it is also a point of the things drawn over it, and there is no pointer position that means it rather than them.
A click that lands where the last one did therefore takes the NEXT answer instead of repeating the same one, cycling down the stack and back round.
The candidates are `topmostAt`'s own rule applied down the stack rather than a second ordering beside it (`pickCandidatesAt` takes its answer, removes it, and asks again), so the first candidate IS the pick and the cycle cannot disagree with it about what is on top.
A fresh click starts exactly where it always did, so this is only what happens past the point the group rule stops.
What counts as a repeat is the same point (within `CLICK_SLOP_PX`), the same stack of candidates, AND the selection still being what the last step left: anything else - the scene tree, a rubber band, an undo, a shift or alt click - has moved on, and continuing the cycle from there would jump to something nobody pointed at.
A multi-selection is the one press that still has no pick at all, since a click that meant to drag it and did not travel must not silently collapse it to one object.

## Locking

Any node can be **locked** (`locked`, saved in the level like `grouped`, Godot's lock): the canvas picks neither it nor anything under it, so a backdrop rock or a finished wall stays on screen as a reference without swallowing the clicks meant for what is in front of it.
It is saved rather than a session setting, as hiding is, because what it records is a decision about the level ("this part is done"), not about this sitting's view; the game and the compile ignore it, and `compileLevel`'s `data` is identical with every node locked or none.

- **Every canvas path asks it**: a click, the cycle down the stack, a rubber band and a double-click all read `pickableItems`, which leaves out what `itemLocked` says; chains, vines and berries are picked by their own nearest-line tests and skip a locked node's (`lockedLinks`); a root branch is not drawn out of a locked root.
- **A locked data layer locks the same way** (`nodeLocked` is the one rule: the node's own flag, an ancestor's, or a locked layer it is in), and since 2026-11-26 that includes chains and vines, which a locked data layer used to leave clickable.
- **The scene tree still selects a locked node**, as Godot's does: it is the deliberate reach, and the way to edit a locked node's fields without unlocking it. A locked node selected so cannot be pressed and dragged on the canvas, since the press finds nothing under the pointer, but the gizmo and a nudge act on it as on any selection.
- **Locking drops what it locks from the selection**, as locking a layer does: "out of harm's way" starts at the lock, not at the next click.
- **Ctrl+L** locks the selection and **Ctrl+Shift+L** unlocks it (Godot's pair); the tree's padlock and the Node section's `locked` box do the same, and each is one undo step. The box is ticked and greyed on a node locked by one above it, and its hover text names that node.

## Selection

The selection is held as four sets, exclusive with one another: the items (`selectedIds`), the nodes selected as such (`selectedBodyIds`: a body, a group, a frame, a placed prefab), the chains and the vines.
`selectedNodeIds` is all of it as node ids, which the scene tree, the data layers and grouping read.
A body selected is its own panel - transform, kind, fill, friction, force - and no shape, material or look, because a body has none of those; an object selected is that object's.
`operandItems` is what Delete, Duplicate, Copy and a nudge act on - a selected body means **all of it** - and they read it rather than the item set, which is what left the body panel's own Delete button doing nothing at all.

A selected body **outlines its objects in blue**, each on its own rather than as the body's union outline.
That is the question it answers - how many objects there are and where each one is, which the union deliberately hides - and it is the only thing on the canvas that says what a body is made of while none of its objects is selected.
It is blue and not the selection orange for the same reason: orange everywhere else means "an edit applies to this", and these objects are outlined precisely because they are NOT selected.
The objects with no outline of their own get a ring at the mark a click has to land on, since a light's own circle is its reach and an anchor has no shape at all.

An object's `x`/`y`/`rot°` in the inspector are **relative to its body**, because that is what the file records - a panel showing world coordinates would be showing a number the level does not contain.
Relative means in the body's own **frame**, rotation included (`localPlacement`): the world-axis distance to the body's origin is a different number the moment the body is turned, and a body turned 15° showed an object the file records at (20, 20) as (14.1, 24.5).
A node that is not a body (a group, a 3D frame, a placed prefab) has a panel of its own: its Node section and its world transform, `z` and tilts for a 3D one, and moving it carries everything under it.

**The body's frame is the body's own**: its node's placement, not a member's.
It was once read off the body's first object, which made that object secretly the body: moving it moved the frame, and every sibling's offset changed to compensate, so nudging one collision shape 10 cm wrote a body moving 10 cm and every other object in it moving 10 cm back.
The frame moves when the BODY moves, and `translateItems` / `rotateItemsAbout` are the one statement of what that means: they carry a frame exactly when everything in it is in the set being moved (`framesCarriedBy`).
So it is one rule rather than a decision at each of the dozen gestures that move something - a drag, a nudge, an inspector field, a gizmo handle, a group rotate - and a gesture cannot move a body's frame by accident.
`captureGroupPose` states the same rule for the gizmo's multi-selection transform, which works from a snapshot rather than a delta (see [editor](editor.md#the-transform-gizmo)): it records the frames it may move when the gesture begins and carries only the bodies that are in the selection whole.

**Origin to COM**, on the body panel, moves a body's origin onto its centre of mass and lets every object's offset take up the step (`originToCentroid`).
Nothing in the level moves; what changes is the frame the placements are recorded against.
It is worth having because the centre of mass is the one point a body is really about - `buildLevelBodies` puts the engine origin there whatever the file says, the panel's `rot°` turns the body about it, and a body's route is a run of offsets from its origin - so with the origin left on a corner of some piece, `x` and `y` read as that corner, turning the body walks them, and the drawn route hangs off that corner rather than off the point the platform travels by.
Two things are recorded *in* the frame and so are carried with it.
The **bearing** (`pivotAt`) is a world point written as an offset from the origin, so it is re-measured and the body goes on turning about the same place in the level.
The **route** is not: its nodes are offsets from node zero - the origin itself - and `moverScript` adds the body's pose back, so leaving them alone is what keeps the travel identical to the bit; the drawn route moves by the same step the origin did, because it is the path the origin takes.
It is offered rather than done automatically, since where a body's origin sits is the author's business: a hinge pinned on the bracket it swings from reads better than one floating in the middle of the assembly, and nothing downstream needs the two to agree.
The `cli render3d` cases assert it across the round trip an author performs - press it, autosave, reopen.

**A new object drawn while a body is selected joins that body**, as a child of the body node.
With a body selected the thing being authored is a part of it - a second shape for a compound wall, the light a lamp throws - and making it a body of its own would mean drawing it and reparenting it every time.
It shares the body's kind, fill and friction because those are the body node's, held once; camera regions, notes and the other plane furniture never join a body (`canShareBody`).

**A collision shape drawn with no body selected gets a body of its own, and which class is asked at the shape** (since 2026-11-26), as Godot's CollisionShape2D needs a PhysicsBody2D above it.
Once the shape is down a **Parent body** menu stands beside it: StaticBody2D, RigidBody2D, and Area2D as each area kind (kill zone, force, water, finish).
The new body already has the class last picked (static to begin with), lit in the menu, so a run of walls or a pile of crates needs no answer: Esc, Enter, any other key, a press anywhere else or any other edit closes it and keeps that class.
A pick changes the new body's class within the draw's own undo step, renames it while its name is still the class's (`StaticBody2D3` becomes `RigidBody2D`), and is what the next shape's body gets (`offerParentPick`, `pickParent`).
A belt asks nothing: it builds only on a static body, so it gets one.
It replaced a `kind` select in a strip over the 2D view, which set the class before the drawing and was easy to leave on the wrong one; a body's class after that is its panel's `kind`.

## Decorations

A decoration (moss, ivy, a fern, a vine, mushrooms, glow flora, a material layer) is a `Decoration3D` node, always a child of the `Formation3D` it grows on: its parent is its host ([formations](formations.md#decorations)).
Placing or painting one on a rock creates it under that rock's node, and the tree refuses a decoration anywhere else.
Decoration used to be a body of geometry objects and no collision object, before that a `collision: false` flag, and before that a `backgrounds` list; `normalizeLevelData` still folds every one of those forms away at load.

## Notes and checkpoints

The **notes** layer is what the player never sees: authoring commentary - a text box or an arrow, recording *why* a piece of geometry is where it is so that it is not later removed as arbitrary - and **checkpoints**, the named places a playtest can be started from.
Nothing on it is drawn in play, and nothing on it collides, is wrapped or reaches the sim, which is why none of it is a `BodyKind`.
A note is a `Note2D` node and compiles to `LevelData.notes` (`NoteData` in `levelFormat.ts`), which no runtime path reads at all; a checkpoint is a `Checkpoint2D` node and compiles to `LevelData.checkpoints` (`CheckpointData`), which is read in exactly one place - where a level is chosen, to move `player` before the level is built (see [**Checkpoints**](running.md#checkpoints)).
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

A **compound body** is a body node with several `CollisionShape2D`s under it.
**New body** (the selection's action row) makes one: the selected pieces are reparented under a new `StaticBody2D` on their centre of mass, each keeping where it stands, and the body is created grouped; dragging a piece out of the body in the scene tree takes it apart again.
Cutting a shape into bodies of its own and folding bodies back into one, settings, anchors, chains and vines kept, are **Cut** and **Join** ([below](#split-and-join)).
Until 2026-11-26 this was Ctrl+G (merge) and Ctrl+Shift+G (split), which now group and ungroup ([Groups](#groups)).
The pieces keep their placement exactly, and what changes is that they now build as a single engine body carrying all their shapes.
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

A body's look is what its node carries - a formation and its decorations, models, lights - which rides the body however it moves; the collision it is built of says nothing about how it looks.

On disk it is simply several `CollisionShape2D` nodes under one body node (any plain `Node2D`s between them included) - there is no tag to agree about, because the containment IS the statement.
A body has one kind, one fill, one friction and one force, and they live **on the body node** rather than being authored per member and collapsed onto the first - which is what the flat form had to do, and what the editor had to keep in step behind it until the node tree.
**Material and thickness are the exception** and stay per piece: a body's mass, centre of mass and inertia are sums over its shapes, so a stone head on a wooden shaft is a compound body of two materials and collapsing them onto the lead's would be the editor overwriting what was authored.
An area may have any number of pieces: overlap, force, water drag and submersion, the killzone and the finish line all go through every piece ([areas-and-friction](areas-and-friction.md#areas-of-several-shapes)), and the editor's refusal to make a compound area went on 2026-11-26.

Because a body is created grouped, it is **selected and moved as one**: clicking any piece selects the body, a rubber band that touches one piece takes the whole body (`outermostGroup`), and **Alt+click** reaches past that to a single piece when its own shape needs editing.
It also **rotates as one**, about the body's area-weighted **centre of mass** - which is where `buildLevelBodies` puts the built body's origin, so the editor's rotation and the body's are the same operation.
That sum weighs each piece at **its own** centre of area (`shapeCentre`) rather than at its placement: a rect and a circle are centred on their origin, but a polygon's origin is wherever the author left it (a corner edit never moves it - see [editor](editor.md)) and its mass is at its centroid, so weighing placements would put the turning point somewhere no mass is.
A whole-body selection therefore gets its own rotate knob (placed by the body's extent, since the pieces have their own angles and the body as a whole has none) and its `rot°` field applies a *delta* to the body rather than writing each piece's own angle.
Every compound body draws a small centre-of-mass diamond so it is identifiable as one body without being selected first, and a selected one adds a dashed hull and spokes to that centre.

A compound body is drawn as **one object**, not as its pieces: the shapes are filled as a union with the nonzero rule (so an overlap contributes one layer of the authored opacity rather than one each) and each piece is stroked only where it lies **outside every sibling**, which is the body's real outline.
The selection halo is the same walk over the **selected** pieces alone rather than over the whole body, which is what makes Alt+click's whole point visible: one piece picked out shows its own full outline, seam edge included, because that outline is what the piece IS, and every piece selected shows the body's outline with no seams drawn across it.
Haloing the body whenever any member was selected said the edit applied to all of it, which for a numeric field or a Delete is exactly what it would not.
Drawn piece by piece it read as a darker patch at every overlap and a crack at every join - a wall with a line down it.
The clip is applied one sibling at a time on purpose: a single even-odd clip keeps the region inside *two* of them, which is exactly where an interior seam sits.
`drawCompoundGeometry` (game) and `strokeCompoundOutline` (editor) are the two implementations of that one rule.
Hook-only bodies keep the per-shape path, since their fill is a grate lattice punched out of each piece and a lattice has no union form.
The headless SVG snapshot still draws the pieces separately - it is a diagnostic view, and there the decomposition is the thing worth seeing.

### Split and join

The two everyday edits of a body's make-up are a pair of tools (`editor/splitJoin.ts`, 2026-11-26), each one undo step, each the other's inverse: a Cut followed by a Join gives back the body as it was, one outline and all.

**Cut** (the Collision group's knife) is two clicks: where the line starts and where it ends.
Every polygon or box the line crosses **from edge to edge** is cut along it, and a run of the line that stops inside a shape cuts nothing there, so a knife has to come out the other side, as a real one does; a concave outline it crosses more than once comes apart into as many pieces.
The line's ends snap to the corners of what it may cut (corner to corner is the exact diagonal), and to the grid otherwise; until the second click the pieces it would leave are drawn washed in turn, orange and blue, so what the click will do is seen first.
With anything selected only the selection is cut, so a cut through a stack of overlapping walls cuts the one being worked on; a cut box becomes polygons.
Each cut shape keeps its largest piece, and its node; the others are new shapes beside it, copies of it in every field but the outline, each with its origin on its own centre as a drawn shape's is.

Then the body is **parted**: its pieces are grouped by what still touches, the pieces of one cut never counting as touching each other (the knife is what separates them), while any other piece touching two of them holds them together, as it would in the level.
The group with the most area stays the body; every other group goes into a **new body that is a copy of it** - kind, friction, bounce, breakable, pivot, spring, mover, fill, group and data layers - with its own build order key, standing in the **same frame**, so a bearing, a swing and a route mean exactly what they did on both halves.
Everything else in the body goes with the group it is on, or nearest to: anchors, and with them the chains and vines hung from them (a chain or vine names its anchors by item id, so moving an anchor's node carries every link on it without touching the link), lights, models, rocks and frames.
**Alt** on the second click keeps the pieces in one body.
A body whose pieces still touch across the cut stays one, and the notice says which.

**Join** (Ctrl+J, or the selection's **Join**) folds the selected bodies into the **first one selected**: it keeps its node, name and every setting, the others' children move under it each where it stands, and the others go.
The notice names any body whose kind differed, since its settings did not survive.
Then the pieces that came from different bodies are **fused** into one outline wherever they overlap or share an edge, and **only when they are the same surface**: every field a piece writes but its outline (material, density, thickness, hook-proof, rail, mud, collision mask, sound material, debug look) and its data layers must agree (`surfaceKey` in `model.ts`, read off `collisionFields`, the one statement of what a piece writes, so a field added later is compared without anyone remembering to).
Pieces that differ, are apart, touch only at a corner, or would close round a hole stay separate pieces of a compound body, and pieces that were already one body's are left as they were.
The union is manifold-3d's `CrossSection` (Clipper2), so a shared edge is exact and a fused outline carries no seam vertices.
A join is refused, changing nothing, when a chain would end up with both ends on the one body (the level drops a chain with nothing to constrain, so the join would silently delete it), when one selected body is inside another, when an area would be left in more than one piece (an area is one shape), and for anything in a placed prefab.

`scripts/test-split-join.ts` (in `bun run test`) holds all of this to its cases, each result compiled with every chain and vine the level had.
