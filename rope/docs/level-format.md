# Level files and format

`fogRegions?: FogRegionData[]` is where the fog is, and since format 4 what it is.
Each region has `x`, `y`, `rot` (radians), a rectangle (`shape: {kind: "rect", w, h}`) or circle (`shape: {kind: "circle", r}`), and optional `falloff`, `amount` and `color`.
Positions, sizes and falloff are disk pixels, converted to metres by `scaleLevelData`; absent falloff defaults to 3 m, zero makes a hard edge, and the fade runs inward from the boundary.
`amount` (a fraction, as `EnvironmentData.fogAmount`) and `color` are the region's own fog; absent, they fall back to the environment block's `fogAmount` / `fogColor`, which is how the flat form and a format-3 tree wrote one fog for every region.
In the flat form, missing `fogRegions` keeps the environment's fog everywhere and `[]` disables it everywhere; a format-4 tree compiles its `FogRegion2D` nodes to `fogRegions` and nothing to the environment's fog, so a level with no region has no fog.
Regions do not affect physics or illumination.

## Level files

Levels save and load to `rope/levels/*.json` as **node trees** in pixels (`LevelTree`, format 4, [below](#the-node-tree)), through a **dev-only REST API** (`GET/PUT/DELETE /api/levels[/<name>]`) added by the `levelApi` Vite plugin in `vite.config.ts`.
The built app has no server, so the editor is a dev tool.
The flat `LevelData` form (the generated `levelData.ts`, and every level file before 2026-11-26) is still read, and is what a tree compiles to for the sim.

Saving is **automatic** once the model has a name: every edit (including undo/redo) schedules a write 750 ms later, so a drag or a run of nudges collapses into one save, and a pending write is flushed on `pagehide` with a `keepalive` request.
An *unnamed* model never autosaves - the first Save/Save As names the file, and everything after that persists on its own; the title's `*` is therefore a brief in-flight marker, not a standing warning, and an autosave failure shows as `SAVE FAILED` there rather than an alert (a modal mid-drag is worse than the loss it reports).
New/Load/Delete each cancel a queued write, so it can never land on the wrong name or resurrect a deleted file.

Autosave must not disturb the page, and by default it did something far worse than reload it: **it restarted the dev server**.
`levels/*.json` is *imported* by `registry.ts`, which `vite.config.ts` imports for the preload list, so every level file is one of Vite's `configFileDependencies` - and a write to a config dependency is a full server restart, decided in `handleHMRUpdate` before any plugin's `handleHotUpdate` is consulted.
There is no hook that can decline it (the old `handleHotUpdate` returning `[]` never ran), so the only lever is not delivering the event: `server.watch.ignored` drops `levels/*.json` off the watcher entirely.

Nothing else wanted that event.
A level is read once, at page load; the editor holds the authoritative model in memory and saves *through* `/api/levels`; and `PUT` skips writes whose bytes are unchanged, so a redundant autosave never touches the file at all.
What did ride on the watcher is picked up at the write instead, which is the better signal anyway - it is the write, not a guess at what a file event meant:

- **Vite's module cache**: `PUT`/`DELETE` invalidate the level's module in every environment's graph, so a hand reload serves the level as saved rather than as transformed at startup. No HMR is sent with it; reload by hand to pick up a level edit.
  The API is not the only author, though - a hand edit, a `git checkout` or a script writes the file without coming through it - so the plugin keeps a **watcher of its own** (`fs.watch` on `levels/`) that invalidates the same module.
  It is not Vite's watcher, so the event still never reaches `handleHMRUpdate` and a level write still cannot restart the server.
  Without it the two windows disagreed and neither was wrong: the editor re-reads the file per load and showed the edit, while the game held the module transformed at startup and went on opening a level the file had not held for hours.
- **The preload list**: `storeScript` re-reads a file-backed level off disk per page load (see `LevelSpec.file`), rather than using the copy compiled into the config at startup. A read that lands mid-write falls back to that compiled-in copy.

A saved level ships in the build by being **imported** into `src/level/registry.ts`
(`resolveJsonModule`; JSON widens string literals, so the spec casts to `LevelSource`, a tree or a flat level). That
is how `levels/ball.json` backs the `BALL` entry: one file, edited in the editor and bundled
into production, rather than a hand-copied TS duplicate.

## The node tree

Since 2026-11-26 a level file is a **node tree** ([plans/node-tree.md](../plans/node-tree.md)): everything the level holds is a node, as in Godot, with an `id`, a `name` and any number of `children`, and a spatial node's children inherit its transform.
The types are in `src/level/nodes.ts`; a file is a `LevelTree`:

| Field | What it is |
|---|---|
| `format` | 4 (`TREE_FORMAT`, the same number as `LEVEL_FORMAT`: one revision line for both forms) |
| `meta`, `camera` | the level-wide blocks, as in the flat form (below) |
| `background` | what is behind everything (the flat form's `environment.backgroundColor`) |
| `layers` | the editor's data layers by name ([editor-model](editor-model.md#data-layers)); the game ignores them |
| `nodes` | the top-level nodes |

A tree read in metres also carries `lengthScale` (its scale against the file), which is never written: a file is always at 1, in pixels.

**The classes.**
Every node has `id`, `name`, and optionally `children`, `grouped` (what a canvas click selects first, [editor-model](editor-model.md#groups)), `locked` (the canvas picks neither it nor anything under it, [editor-model](editor-model.md#locking)), `layers` (the data layers it is in) and `disabled` (it and everything under it are left out of the level).

| Class | What it is | Its own fields |
|---|---|---|
| `Node` | a folder: no transform, so its children start from the world frame | - |
| `Node2D` | a group in the gameplay plane | `x`, `y`, `rot` in the parent's frame |
| `StaticBody2D` | scenery that never moves | pose, `order`, the body's properties |
| `AnimatableBody2D` | a body moved by script: a pendulum, a rotor, a route ([movers](movers.md)) | as above |
| `RigidBody2D` | a dynamic body, a pivot, a spring mount | as above |
| `Area2D` | a killzone, force, water or finish region, of any number of shapes ([areas-and-friction](areas-and-friction.md#areas-of-several-shapes)) | as above, and `area` |
| `CollisionShape2D` | one collision piece | pose, and every field of a collision object (`shape`, `material`, `thickness`, `debug`, `root`...) |
| `Anchor2D` | a chain or vine end | pose |
| `Spawn2D` | the spawn, exactly one per level | the `player` block's fields |
| `Checkpoint2D` | a named spawn | `checkpoint` (what `?checkpoint=` names), `x`, `y` |
| `CameraRegion2D`, `CameraPath2D`, `Shelter2D`, `FogRegion2D`, `Note2D` | the plane's volumes, paths and notes | their flat entries' fields (a fog region's own `amount` and `color` among them) |
| `Sun` | the level's sunlight, at most one, not spatial ([below](#the-levels-light)) | `sunX`, `sunY`, `sunZ`, `sunColor`, `sunIntensity` |
| `Environment` | the level's sky and fill, at most one, not spatial | `skyColor`, `groundColor`, `fillIntensity`, `envIntensity`, `hdri`, `hdriRotation`, `hdriBackground` |
| `Node3D` | a frame in the scene | `x`, `y`, `z`, `rot`, `tilt: [x, y]` |
| `Formation3D` | rock ([formations](formations.md)) | 3D pose, and a formation's recipe, guide and `built` |
| `Decoration3D` | moss, ivy, a fern... grown on its parent, always a `Formation3D` | a decoration's fields; no pose (its anchor is in the formation's frame) |
| `Model3D` | a model of the library ([blender-models](blender-models.md)) | a model object's fields, `scale` among them |
| `Light3D` | a light | a light object's fields |
| `Chain`, `Vine` | strung between anchors, not spatial | `order`, and the anchors' node ids (`a`, `b`, `via`, `through`; `anchor`, `anchor2`) |
| `Instance` | a placed prefab, of its root's class ([prefabs](prefabs.md)) | `prefab`, 3D pose, `scale`, `order`, `overrides` |

A body's properties (everything `LevelBodyData` has one of: fill, friction, bounce, force, flow, breakability, pivot, spring, swing, spin, route) are held on the body node once, so a compound body's pieces carry no copies.
A `CollisionShape2D` belongs to its **nearest body ancestor**, through any plain `Node2D` between them; an `Anchor2D`, a `Light3D` or a `Model3D` rides its nearest body ancestor, or stands in the world when it has none.
A `Node3D` under a `Node2D` takes the 2D frame lifted into 3D, then its own; scale exists only on a `Model3D` and an `Instance`, so a formation is resized by its guide and regenerated, never scaled.

**Identity.**
A node's `id` is eight random base-36 characters, unique in its file, minted once and never changed by a rename, a move or an edit (`newNodeId`).
It is the one thing a reference uses: a chain names its anchors by node id, a collision guide's `subset` and a root branch's `parent` name `CollisionShape2D` node ids, a prefab override names the prefab node it overrides.
Inside a placed prefab a node's full id is the instance ids down to it and then its own (`instA/instB/node`).
A **name** is a label, unique only among siblings: a clash takes the next free number (`Rock`, `Rock2`, `uniqueName`), so a path of names (`Rocks/Ledge/Formation`, `nodePath`) addresses one node and is printed beside engine body indices, but is never stored as a reference, since it changes whenever something is renamed or moved.

### The level's light

Since format 4 (2026-11-26) the level's light is nodes, as Godot holds it: a **`Sun`** (the directional light, a `DirectionalLight3D`) and an **`Environment`** (a `WorldEnvironment`: the sky, captured or generated, and the hemisphere fill), and the level's fog is its `FogRegion2D` nodes, each owning its `amount` and `color`.
Neither light node is spatial: the sun is a direction and the environment is everywhere, so they stand at the top of the tree or in a folder `Node`, hold no nodes, and a level has at most one of each (`validateTree`; a prefab has none).
`compileLevel` writes them back as the flat form's `environment` block (`environmentOf`): the Sun's fields, the Environment's, and `background` as `backgroundColor`.
**No `Sun` node is no sun** (`sunIntensity: 0`, which builds no light): deleting it is how a level goes underground.
No `Environment` node is the renderer's default sky and fill.

**The format-3 upgrade** (`upgradeTree`, run by `loadLevelTree`, `compileLevel`, `scaleLevelTree` and the editor's `modelFromTree`, and by `migrateToTree` on everything flat) reads a tree's `environment` block into a `Sun` and an `Environment` node at the top of the tree and the `background` property, and moves its fog onto the fog regions: each takes the block's `fogAmount` and `fogColor` where it has none of its own.
A format-3 level with fog EVERYWHERE (no region and no `fogMasked`) gets one region that covers anything a camera can frame (1e7 units square, no falloff), since fog lives in fog nodes now; none of the levels or bundles had one.
The upgrade is pure, the identity on a format-4 tree, and mints its ids from the tree's own, so a file read twice upgrades the same way; the editor writes format 4 the next time it saves the level.

### Compiling: the sim never sees the tree

The sim, and everything else that reads `.bodies`, keeps consuming the flat `LevelData` it always has, and it is given only what it reads: bodies and the shapes they collide as, anchors, chains, vines, the spawn, checkpoints and the plane's volumes.
`compileLevel(tree, prefabs)` produces it:

- every `Instance` is expanded first ([prefabs](prefabs.md#the-instance-node)), so what follows sees only ordinary nodes;
- each body node becomes a `LevelBodyData` at its world pose, its shapes and anchors composed into its frame in pre-order;
- an anchor with no body above it is a point fixed in the world (what a chain or a vine is hung from), held in a body that builds nothing, one per frame such anchors sit in, appended after every body that builds;
- **the look is not compiled** (since 2026-11-26): rocks, decorations, models and lamps are drawn from the tree (`render3d/treeLook.ts`) and read from it by every tool that needs them (`lookNodes` in `nodes.ts`: each with its world frame, the body it rides and a decoration's rock), so a rock with no body above it costs the sim nothing at all;
- node references go back to the numbers the flat form reads: anchor ids are numbered (a numeric id keeps its number), `root.parent` becomes an index.

The editor reads it the same way: `modelFromTree` builds its bodies' shapes and anchors from the compiled level and its rocks, lamps, models and decorations from the tree (`lookNodes`), and its scene is rebuilt when what the look DRAWS changes (`sceneKeyOf`), not when any field of the tree does.

`LevelBodyData.node` carries the node each compiled body came from (its full id and its path of names, which `cli query` and the replay tools print beside the engine body index), `ObjectPlacement.node` the node id each object came from, and `compileLevel().nodeOf` maps every compiled element back to its node, for the editor, which reads the compiled level and edits the tree.
`bodyNodes` lists the node of each compiled body by index.
A recording embeds the level as its tree with every prefab expanded (`embeddedLevelOf`), so a replay draws as well as plays as recorded; a start at a checkpoint and the editor's ▶ Test move the tree's `Spawn2D` (`spawnMovedTo`), and the tree stays a tree.

### Build order

The solver visits contacts in body order, so body order changes how a level plays, and a tree's order must not: grouping two rocks under a `Node2D` would otherwise reorder the bodies and break every replay of the level.
So each body node carries an **`order`** key, and `compileLevel` emits bodies sorted by it (ties in pre-order), not in tree order.
Migration gave each body its index in the old list; a new body takes one past the highest (`nextOrder`); reparenting and reordering siblings never touch it.
Chains and vines carry one too, since the sim builds them in list order.
A body inside an instance keys as the tuple of the instance's `order` and its own, so editing a prefab never reorders the level's other bodies.

### The gate, and the proof

`normalizeLevelData(raw)` is `compileLevel(loadLevelTree(raw))` with the expanded tree attached as `LevelData.tree`, which the 3D renderer draws the look from and the sim never reads.
`loadLevelTree` returns a tree as it is, and runs anything flat through the legacy half of the gate: `normalizeFlat` folds every retired flat form (below), and `migrateToTree` turns the result into a tree with exactly its nesting, keeping every id that exists (formation and decoration ids as they are, anchor numbers as strings) and minting the rest deterministically, so an unconverted level names its nodes the same on every load.
So every level, every recorded bundle and the Godot extractor's output reach the sim through `compileLevel`; `flatLevelOf` is the flat level a source compiles to, without its node references, which is what a recording embeds so it replays as played whatever its prefabs become.

**`cli nodes`** (`src/sim/nodeCases.ts`) is the proof that the tree changes nothing the sim reads:

- a **round trip** over every level and every bundle in the regression corpus: `compileLevel(migrateToTree(F))` equals `F = normalizeFlat(L)` exactly (`Object.is` on every number) in everything the sim reads - the spawn, every body that builds in order with every field and object, the chains, vines, checkpoints and camera volumes - and the bodies that build nothing draw the same things within a micrometre;
- **semantic cases**: composition through a `Node2D`, build order surviving a reparent, the refused states, and the instance cases ([prefabs](prefabs.md#tools));
- per level, a valid tree, **scale commutes** (compiling the tree in metres is the flat level in metres) and scaling px to m and back compiles to the same level.

`cli levels` holds every level's tree and every prefab to the refused states below (`validateTree`, from `src/level/levelLint.ts`), reporting the warnings without failing.

`bun scripts/levels-to-tree.ts --editor-closed [--dry-run] [files]` rewrote every flat file in `levels/` as a tree on 2026-11-26, and does the same for any flat level still to come: per file, it checks the tree compiles to exactly the flat level it came from and holds no refused state before it writes anything.
An open editor tab autosaves the level it has open, so `--editor-closed` is the author saying every tab is closed.
The level hash (`levelFileHash`, over the file's bytes) changed for every level at that rewrite, so feedback recorded either side of the date does not group together.

### States the editor refuses

`validateTree` refuses, and the editor will not make:

- a `CollisionShape2D` with no body above it;
- a 2D node under a 3D one: the plane is the gameplay plane, and a 2D node is in it by definition;
- a body under an `AnimatableBody2D`, a `RigidBody2D`, an `Area2D` or a breakable `StaticBody2D` (`bodyMovesOrVanishes`): in the editor the child would ride its parent, in play it would simulate on its own or be left floating when the parent breaks;
- a `Decoration3D` whose parent is not a `Formation3D`;
- an `Anchor2D` on an area;
- a node the camera, the fog or the sky reads as fixed in the world (`WORLD_FIXED_TYPES`: spawn, checkpoint, camera regions and paths, shelters, fog regions) under something that moves;
- a level without exactly one `Spawn2D`, a prefab with any spawn or checkpoint;
- a second `Sun` or `Environment`, one anywhere but the top of the tree or a folder `Node`, one holding nodes, a prefab holding either;
- a chain or vine naming an anchor that is not in the level, two nodes with one id, two siblings with one name, an instance of a missing prefab or of itself.

A body with no shapes is warned about, not refused: it builds nothing and should be a `Node2D`.

### The flat fields

What follows describes the fields of the flat form, which is what a tree compiles to and what the sim reads.
In a tree each lives on the node that compiles to it: a body's fields on its body node, a collision object's on its `CollisionShape2D`, a light's on its `Light3D`, the `player` block on the `Spawn2D`, a camera region on its `CameraRegion2D`, and so on.
Where the flat form names something by index or number (a root branch's `parent`, a chain's anchor ids), the tree names it by node id.

Beside the geometry a level carries a few lists that are not bodies: `cameraRegions` and `cameraPaths` (how it is framed), `shelters` (the front walls of enclosed caves, which only the sun sees, [**Shelters**](lighting-and-surfaces.md#shelters)), `notes` (authoring commentary nothing reads), `chains` and `vines` (what is strung between bodies), and **`checkpoints`** - named spawns, each a name and a point, which `?checkpoint=NAME` moves `player` to before the level is built (see [**Checkpoints**](running.md#checkpoints)).
A chain names its two anchors and, optionally, the anchors it is routed over (`via`) or **knotted through** (`through`, with `lengths`, `slack` and `substeps` - a rope bridge; see [scene-chains](scene-chains.md#tied-chains)); `scaleLevelData` scales `length` and `lengths` and leaves the ids, the slack ratio and the substep count alone.
`scaleLevelData` converts a checkpoint's placement and leaves its name alone, and it **drops nothing**: that function is the editor's save as much as the game's load, so a rule that deleted a blank or repeated name would delete a marker the author had just placed.
The lookup is what enforces the name instead - trimmed, case-folded, first match wins - and the editor's panel is what reports a name that is missing or already taken.

The `player` block is the spawn (`SpawnData`): a point, the avatar radius, and three fields that say how the run OPENS - **`hang`**, **`roll`** and **`arrival`**.
A spawn with `hang: true` opens the ball & chain run already on its anchor - see [**The spawn anchor**](ball-coil-and-hook.md#the-spawn-anchor) - and one without it starts the ball on the ground, which is every level authored before the field.
It anchors the chain; it does not lift the ball, so a level that starts hanging is authored by putting the spawn where the ball should *hang*, under something to hang from.
The editor offers it as `hang` in the spawn node's Player spawn panel, and carries it through the model for the reason the lens is carried: the editor writes the whole file back, so a field the model does not know about is a field the first autosave *deletes*.

**`roll`** opens the level on the ball rolling in from off to one side - see [**The rolling entry**](ball-rolling.md#the-rolling-entry).
It is a signed offset along x (pixels on disk, metres in the sim), negative to come in from the left: the ball is placed there, rolls to the spawn, and the player's aim and deploy do nothing until it arrives.
So the spawn is still where the run starts, in the sense that matters - it is where the player is handed the ball - and the entry is the only part of the spawn that is not *at* the spawn, which is why the editor draws it as a second ring on a dashed run into the marker.
The camera stands at the spawn for the whole entry rather than following the ball in, so the offset is also how far off the standing frame the ball begins - see [**A rolling entry**](level-design.md#a-rolling-entry).
The two openings contradict each other and the build says so: a hanging ball has nothing to roll on, so a spawn that asks for both keeps the hang, and `cli levels` holds every level file to asking for one.

**`arrival`** opens the level on a recorded run instead - see [**The recorded arrival**](ball-rolling.md#the-recorded-arrival).
It is the NAME of an input stream in `level/arrivals.ts` (`"cave"`), never the frames themselves: seven seconds of input is twenty-four kilobytes, the editor rewrites this file every 750 ms while it is open, and an opening like this is authored by playing it and running `scripts/make-arrival.ts` over the bundle.
The ball starts where the recording started and the level plays the stream back with the player's hands off it, so here the spawn is not where the run begins at all - it is where the player takes the ball over, which is to say where a reset puts them.
It replaces a `roll` authored beside it rather than joining it, and it is dropped by the same drop, at a checkpoint and in the editor's ▶ Test.
The editor carries it through the model without offering it, for the reason `hang` is carried: a field the model does not know about is a field the first autosave deletes.

The **`meta`** block is what the level select reads: a `title` to show, `intro` for the one level shown first, and `unlisted` for a level that is off the menu but still played by `?level=` - see [**Levels**](levels.md).
Nothing in it is a length, so it crosses `scaleLevelData` whole; everything in it is optional, so a level that authors no block is a listed level named after its registry id.
The editor carries it through `EdModel.meta` without offering it (the **Level** panel that did was retired on 2026-11-26: there is one main level), for the reason `hang` is carried: a block the model does not know about is a block the first autosave deletes.

A collision `curve` may **taper**: `tip` is its width at its last node, `width` at its first (a length, absent = a bar of one width, built bit-identically).
A curve may be a **root** branch: `root: {}` for a trunk, `root: { parent, at }` for a branch growing out of the root piece at index `parent` in the same body's `objects`, `at` (a fraction of that piece's arc length) along it, its own first node being that junction - see [**Roots**](roots.md#the-format).
`parent` is an index and `at` a fraction, so `scaleLevelData` carries both untouched; in a tree `parent` is the parent root's `CollisionShape2D` node id, which the compile turns into the index, so reordering or reparenting pieces cannot point it at the wrong one, and `cli levels` reports a branch whose first node is off its junction.

A body may be the level's **finish line**: `kind: "finish"`, the region the player crosses to complete the level - see [**The finish line**](levels.md#the-finish-line).
A KIND rather than a flag, because it is what the body is: a `finish` body builds an `Area2D` and nothing else, exactly as a `killzone` does, and there is no body a finish line and a wall could both be pieces of (`isAreaKind`).
The gantry that marks it is drawn by what the body node carries (a model, a formation), so what is drawn and what is crossed still move together.

A body may also state what it takes to DESTROY it: **`breakForce`** (newtons) and **`durability`** (hits), the breakable pair - see [**Breakable geometry**](breakable.md).
Both are stated in the sim's own units and `scaleLevelData` leaves them alone, for the reason `drag` is left alone: the file's lengths are pixels because the editor draws in pixels, and neither a force nor a count is a length.

A collision object's shape may be a **`belt`**: `{ kind: "belt", wheels: [{ x, y, r }, ...], thickness, speed }`, a conveyor - see [**Conveyor belts**](conveyors.md).
Each wheel is a centre in the object's frame and the WHEEL's own radius; `wheels[0]` is at `(0, 0)`, the object's own origin, and is written out anyway because it carries a radius.
There are two or more, and every one must lie on the convex hull of the discs of radius `r + thickness`: the band wraps the outside of all of them.
`thickness` is the band's depth in the plane, `> 0`, so the running surface round each wheel is at `r + thickness`.
`speed` is one signed number whose sign is the direction (positive turns the loop clockwise on screen).
Every field is a length or a length per second, so `scaleLevelData` scales them all; a belt builds only on a `static` body that is not a mover, and fails the build anywhere else, as it does for a wheel inside the hull, a disc inside another or a zero thickness, naming the wheel.
A belt also carries its band's LOOK (`BeltLook`), because the game draws the band rather than a Blender export - its surface moves (see [**Conveyor belts**](render3d.md#conveyor-belts)):
**`width`**, how wide the band is across the pulleys (a length, absent `DEFAULT_THICKNESS`); **`texture`**, the surface it wears, whose pattern scrolls at `speed` (the reserved `"color"` is a flat fill of **`color`** and carries a ring of cleats instead); and **`tileScale`**, how large it wears the texture, a multiple of the texture's own size and so not a length.
Until 2026-09-29 these were a geometry object's, the belt's matched twin; `withoutLook` moves them onto the shape when a file still has one.
There is no retired two-roller form: nothing committed ever used it, so it was replaced rather than folded.
`levels/belt-test.json` (`?level=TEST_BELT`) is the sandbox.

A **water** body carries its slab's placement through z, since water is drawn by the game rather than by a Blender export (the current moves its surface): **`waterZ`**, the slab's middle off the gameplay plane (+ toward the camera, absent 0), and **`waterDepth`**, its extent through z (absent `DEFAULT_WATER_DEPTH`).
Both are lengths and scale; its tint is the body's `color`.

**A level states no look.**
Until 2026-09-29 a body could carry **geometry objects** (`type: "geometry"`: primitives, meshes from the manifest, image planes, generated boulders and mushroom patches, with their `z`, tilt, texture, taper and `generator` block), and that is how every level was drawn.
They are retired: a level's look is what its nodes carry - formations and their decorations ([formations](formations.md)), models of the library ([blender-models](blender-models.md)) - and `normalizeLevelData` drops them from any file that still carries them (`withoutLook`), keeping only a water body's slab and a belt's band look (above), and dropping a body left with nothing in it.
Every file in `levels/` was rewritten in the new form the same day, and bundles recorded before it still load: a body of nothing but geometry objects built no engine body, so no build index moved.

A body may carry a **`name`** (`LevelBodyData.name`): its body node's name, a label nothing in the sim reads and unique only among the node's siblings ([Identity](#the-node-tree)).
It is a name, so `scaleLevelData` passes it through untouched.
Until 2026-11-26 it was also what a level's Blender scene bound an object to, the level naming that scene once in **`scene`** (`LevelData.scene`), and `cli levels` held body names unique; the scenes are retired ([**Blender scenes**](blender-scenes.md)).

A collision object may carry **`debug`** (`CollisionObjectData.debug`, `DebugDrawData`): `{ on, color?, opacity?, depth? }`, whether the piece is drawn in 3D as its outline extruded in a flat colour, and how - see [**What the scene draws**](render3d.md#what-the-scene-draws).
`on` is the switch and the rest are settings it keeps while off; an absent setting falls back to the body's `color`, opacity 1 and the piece's `thickness`.
`depth` is a length and scales px ↔ m; `color` and `opacity` do not.
Absent is a piece that draws nothing, and the editor writes the block only for a piece that is on or configured, so a level that uses none stays byte-identical.

A level carries **`format`** (`LevelData.format`, `LEVEL_FORMAT`, 3), the revision it was written in; absent is 1.
`normalizeLevelData` stamps the current revision on every level that crosses it, and the editor writes it on every save.
3 is the node tree on disk, and a flat level stamped 3 is one compiled from a tree; the stamp below 3 exists for the one migration the data cannot reveal: a format-1 level that names no scene drew every piece of every non-area body as a grey box, and loads with exactly those pieces' `debug` switched on (`withDebugFromGreybox`).
A format-2 level with every piece switched off holds the same keys as a format-1 one, so the stamp is the only thing that tells them apart.

A **light object** (`LightObjectData`, `type: "light"`) sits in a body like any other scene object and rides its pose - see [**Light and air**](lighting-and-surfaces.md#light-and-air).
Its fields, and what `scaleLevelData` does to each:

| Field | What it is | Scaled px ↔ m |
|---|---|---|
| `kind` | `"point"` (absent) or `"spot"` | no |
| `x`, `y`, `rot` | placement in the body's frame | `x`, `y` yes |
| `z` | off the body's plane, toward the camera | yes |
| `color` | the light's colour | no |
| `intensity` | candela against the sim's metres (see the lighting doc for why it is not scaled) | no |
| `range` | how far it reaches before it is cut to nothing | yes |
| `angle`, `penumbra` | spot only: the cone's half-angle in degrees, and its edge softness 0..1 | no |
| `dirX`, `dirY`, `dirZ` | spot only: the aim, in the object's own frame | no |
| `castShadow` | whether it occludes (capped by `LIGHT_SHADOW_BUDGET`) | no |
| `shadowNear` | the shadow camera's near plane | yes |
| `shadowRadius` | the shadow edge's softness, three's PCF radius in shadow-map texels; absent = 1 | no |
| `flicker` | 0 (steady) .. 1 (guttering); render-only, wall-clock driven | no |
| `beam` | spot only: how visible the lit air in the cone is, 0..1; render-only, wall-clock driven | no |
| `dust` | spot only: how thick the dust drifting in the beam is, 0..1; render-only, wall-clock driven | no |
| `wake` | point only: the distance on the gameplay plane the ball has to come within to wake the light; absent or 0 = always on | yes |
| `wakeDelay` | point only, seconds from the trigger to the start of the rise; absent = 0 | no |
| `wakeRise` | point only, seconds from dark to full; absent = `DEFAULT_WAKE_RISE` (0.6), 0 = instant | no |
| `wakeFall` | point only, seconds from full to dark once the ball has left; absent = `DEFAULT_WAKE_FALL` (1.5), 0 = instant | no |

`beam` and `dust` are the spot's cone made visible - see [**Beams**](lighting-and-surfaces.md#beams).
Both are absent (0) on every light authored before them, and the editor writes them only on a spot and only when nonzero, so a level that never sets one saves byte-identically.
The beam is not occluded by geometry: a shaft that should stop at a floor is authored with a `range` that stops there.

`wake` makes a point light a **waking light**, dark until the ball comes near and fading after it leaves, with the emission of the glowing shapes in its body following it - see [**Waking lights**](lighting-and-surfaces.md#waking-lights).
`wake` is a length and converts like `range`; the three times are seconds and pass through untouched.
The editor writes the four only on a point light with a nonzero `wake`, and each time only when it is set, so a level that never sets one saves byte-identically; a waking light's `castShadow` is ignored.

A light once carried `fireflies` (a swarm of that many motes, the light being the swarm's own glow) and `path` (the firefly path, top-level `fireflyPaths`, it guided the player along).
Fireflies were removed on 2026-11-26: a swarm's light and every firefly path are folded out at load (`dropFireflies` in `nodes.ts`), and a stale `path` on any other light is dropped.

A **model object** (`ModelObjectData`, `type: "model"`) places a 3D model of the library on its body, which carries it - see [blender-models](blender-models.md).
`model` names it (`assets-src/models/<model>.blend`), `z` is its origin's depth off the body's plane toward the camera, `rotX`/`rotY` tilt it about the screen's axes before its turn in the plane, and `scale` sizes it against how it was modelled.
`z` and the placement are lengths and convert; the tilts are radians and `scale` a ratio, and neither does, so a model modelled in metres is its own size whatever the file's units.
Appearance only: a body of nothing but models builds no engine body, and the editor writes every field only when it is not its default.

The canonical, hand-editable schema now lives in `src/level/levelFormat.ts` (superset of
the generated one — adds the `rigid` and `force` kinds, the `cameraRegions` and
`chains` lists, and bodies made of scene objects); `levelData.ts` stays
auto-generated and is structurally assignable to it. `BallLevel` constructs geometry
through the shared `src/level/buildBodies.ts` (statics, killzones, force areas,
water, finish lines and rigid bodies); it was shared so the grapple and ball controllers loaded identical scenes, until the grapple was retired on 2026-10-19.
`rigid` bodies get mass/inertia from `ShapeGeometry` and fall under gravity.

## 2D and 3D bodies

A body is a thing in the gameplay plane: `x`, `y`, `rot` and no depth, because the sim has no third axis.
What stands off the plane is a 3D node: a `Node3D`, `Formation3D`, `Model3D` or `Light3D` with `z` (disk pixels, toward the camera) and `tilt: [x, y]` (radians about three's x then y, applied before `rot`: Euler order ZYX), placed in its parent's frame (`placeBody3d` in `render3d/space.ts` is the convention; `frameOf` in `nodes.ts` composes it).
A background rock is a top-level `Formation3D` with no body above it ([formations](formations.md#in-the-editor)).

The sim's level holds no 3D body: a rock or lamp off the plane is the look, drawn from the tree, and a shape off the plane is a state the tree refuses (a 2D node under a 3D one).
The only 3D collision in the game is the glass ball's shards, which land on what each body draws, render-side ([glass-ball](glass-ball.md)).
Until 2026-11-26 the 3D body (`space: "3d"`) was also how a level file stated a backdrop, and the editor kept its depth and tilt beside the body's frame (`EdModel.bodies3d`); a flat file that still has one migrates into a `Formation3D` (a lone rock, its frame composed with the rock's placement) or a `Node3D` holding the rock and its lights and models.

## Regenerating level geometry

`levelData.ts` is generated from the prototype's Godot scene; do not hand-edit it:

```sh
bun scripts/extract-level.ts <path-to>.tscn src/level/levelData.ts
```
