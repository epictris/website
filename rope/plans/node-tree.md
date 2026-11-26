# Node tree: everything is a node

Status: built 2026-11-26 on the `node-tree` branch (worktree `~/projects/website-node-tree`), all six phases; uncommitted and unplayed.
Phase 4 has run on the branch's copies of the level files only: main's `levels/*.json` are converted at merge time (`bun run scripts/levels-to-tree.ts --editor-closed`), with every editor tab closed first.
The editor, groups, picking, reparenting and prefabs need playing before their feel is called done (see [What green cannot see](#what-green-cannot-see)).

Where the build went its own way:

- `tools/blender/scene_export.py` is kept: it is the shared exporter for models, formations and decorations, not only the retired scene export.
- Bodiless content (a rock, lamp or anchor with no body above it) compiles into a collisionless "gathered" body appended after every body that builds, which is how the flat form and the renderer have always drawn it.
- A tree in memory records its `lengthScale` against its file, so a tree read in metres expands its instances against the prefab library at the same scale (`prefabsAt`): prefab files are pixels, as level files are.
- An instance of a prefab that does not exist expands to a frame holding what was added under it, at the instance's place, and the instance is written back untouched.

Decided (Tris, 2026-11-26):

- `Node` is the base class everything inherits from.
- Bodies are split into classes the Godot way, not one body with a `kind`.
- A `CollisionShape2D` belongs to its nearest body ancestor, so plain `Node2D` groups may sit between a body and its shapes.
- Physics build order is stable, not tree order (see [Build order](#build-order)).
- Bodies may not sit under a body that moves or can vanish (see [Bodies under bodies](#bodies-under-bodies)).
- An `Area2D` may have any number of shapes.
- A singleton formation is never scaled: its guide is scaled and it is regenerated. Only a shared asset is scaled.
- Names are labels, not identity: unique only among siblings (auto-suffixed), so a path names one node. One mechanism identifies a node, its stable id (see [Identity](#identity)).
- `ball-migrated.json` is deleted.
- `rails.json` is deleted, and with it the last level dressed by a Blender scene (see [What Blender drops](#what-blender-drops)).
- The level hash breaks once, at the phase 4 rewrite, and that is accepted.
- A root with bends is one node building several engine bodies; accepted for now, revisited only if it causes trouble.
- Each workspace has its own click rules (see [Workspaces](#workspaces)).
- Prefabs: shared assets that are editable node trees, placed as instances with per-instance overrides.
- One formation class, `Formation3D`, for every guide kind (see [Formations](#formations)).
- `cli query` and the other replay tools print node paths beside engine body indices.
- Grouping, as defined under [Groups](#groups).
- Data layers replace the editor's layers: fixed type filters plus user-created layers (see [Editor](#editor)).
- The Assets tab becomes prefabs (see [The Assets tab becomes prefabs](#the-assets-tab-becomes-prefabs)).
- The editor rewrite is big-bang and that is accepted.

## Why

The level is a two-layer hierarchy today: `LevelData.bodies[]`, each body holding `objects[]` (collision, light, anchor, model, decoration) and at most one `formation`.
Everything that is not a body is a separate top-level list (`cameraRegions`, `cameraPaths`, `fireflyPaths`, `shelters`, `fogRegions`, `notes`, `checkpoints`, `chains`, `vines`).

Two things this cannot say cleanly:

- **Background geometry with no body.** A backdrop rock needs a body to live in, so the format grew the "3D body" (`space: "3d"`, `z`, `tilt`) - a body the sim never sees, whose only job is to be a frame.
- **What a thing is attached to.** A fern is a decoration in the formation's body that names the formation it grows on by id (`DecorationObjectData.formation`).
  The parent-child relationship exists, but as a reference beside the containment rather than as the containment.

The editor carries the cost of the flat model: `EdItem` holds every body property on every member and `syncBodyProps` keeps them in step, `bodyFrames` and `bodies3d` are side tables keyed by body id, and selection has a separate body set (`selectedBodyIds`) beside the item set.

## The model

`Node` is the base class every level element inherits from, as in Godot.
A node has any number of children, and a spatial node's children inherit its transform.

```
Node                        id, name, children, grouped; no transform
├─ Node2D                   x, y, rot in the parent's frame; lives in the gameplay plane
│  ├─ StaticBody2D          scenery that never moves
│  ├─ AnimatableBody2D      movers: routed, swing, spin (scripted motion)
│  ├─ RigidBody2D           dynamic bodies, pivots, spring mounts
│  ├─ Area2D                killzone, force, water, finish; any number of shapes
│  ├─ CollisionShape2D      shape + per-piece props (material, mask, rail, viscosity, debug, root...)
│  ├─ Anchor2D              a chain or vine end
│  ├─ Spawn2D, Checkpoint2D
│  ├─ CameraRegion2D, CameraPath2D, FireflyPath2D
│  ├─ Shelter2D, FogRegion2D
│  └─ Note2D
├─ Node3D                   position xyz, rotation in the parent's frame (no scale)
│  ├─ Formation3D           recipe + guide + built; never scaled
│  ├─ Decoration3D          moss, ivy, fern, vine, mushroom, glow, material
│  ├─ Model3D               a library model or shared asset; the one node with a scale
│  └─ Light3D
├─ Chain                    references two Anchor2D ids (+ via / through)
└─ Vine                     references one or two Anchor2D ids

An Instance of a prefab takes its root's class (see Prefabs).
```

Movers are `AnimatableBody2D` (Godot's name for a scripted-motion body) rather than a `StaticBody2D` with a route, so that "static" means never moves and the rules below can say so by class.

Level-wide settings that are not things in the level stay as level properties: `meta`, `environment`, `camera` (lens), `format`. (`scene` is dropped with the Blender scenes.)

### Transform rules

- A `Node2D` composes in the plane with its `Node2D` parent.
- A `Node3D` under a `Node2D` takes the 2D frame lifted into 3D (x, y, 0 and a turn about z), then its own 3D transform.
  So a model on a swinging crate, or a formation dressing a static, rides its body.
- A `Node2D` may not sit under a `Node3D`: the plane is the gameplay plane, and a 2D node is in it by definition.
- A plain `Node` has no transform.
  As in Godot, its spatial children start from the world frame, so it is a folder and nothing else.
- **Scale exists only on `Model3D` and on a prefab instance** (uniform).
  A singleton formation is resized by scaling its guide and regenerating, so its decorations are grown at the size they are drawn.
  A formation and its decorations shared between places are a prefab, and its instance may be scaled because it is no longer living geometry.
  A `Model3D` is only ever a model made by hand in Blender.
  With no scale anywhere else, nothing can scale a singleton formation from above, and keep-world reparenting is exact everywhere outside a scaled instance.
- Reparenting offers both of Unreal's attach rules.
  **Keep world** (the default, and what a drag in the scene tree does) leaves the node where it stands and rewrites its local transform against the new parent.
  **Keep relative** keeps its local numbers, so it moves to the same offset on the new parent.

### Physics ownership

- A `CollisionShape2D` belongs to its **nearest body ancestor**, through any plain `Node2D` between them.
- An `Anchor2D` is attached to its nearest body ancestor, or to the world when it has none.
- Every per-body property lives on the body node once, so `syncBodyProps` and the body-set selection go away.

### Bodies under bodies

A body may sit under a `StaticBody2D` that is not breakable, or under plain nodes.
It may not sit under an `AnimatableBody2D`, a `RigidBody2D`, an `Area2D`, or a breakable `StaticBody2D`.

The reason is that the editor and the game would disagree: in the editor the child rides its parent, while in play it simulates on its own (or is left floating when its parent breaks).
Under a static that never moves, composing the placement at build is all there is to it.

Non-body children of a moving body (lights, models, formations, decorations, anchors, plain `Node2D` groups of its shapes) are allowed: they are what a moving body is for.

What the rule costs: a moving thing whose parts differ in a **per-body** property cannot be one body, and now cannot be two nested bodies either.
Those properties are friction, bounce and launch, `passable` (hook-only), breakability, and being an area.
Examples: a moving platform with a bouncy pad on it, a swinging log with a hook-only branch, a pendulum with a killzone blade.
Today these need two bodies driven in step, which works for movers (two identical routes) and is impossible for rigid bodies and pivots.
The rule loses nothing that exists, but it blocks the obvious next step.

The answer is Box2D's: friction, restitution and "sensor" are properties of the **fixture** (our `CollisionShape2D`), not the body.
A killzone piece on a pendulum is a sensor fixture on the pendulum's body.
Tris intends to move them onto shapes later (2026-11-26); it is a sim change with its own detectors and is out of scope here.

### Area2D with several shapes

The engine already supports it: area overlap, force, water drag and submersion, the killzone and the finish line all iterate `getShapes()` (`areaOverlapsBody`, `submergedFraction` in `engine/world.ts`), because a concave area outline is already cut into convex pieces at load.
The work is outside the sim:

- **Water drawing** builds from `primaryShape()` and only for a rect or circle (`buildWater`, `render3d/water.ts`), so the second piece of a water area would be invisible.
  It needs to draw every piece, without internal faces where pieces meet, and the spill needs a defined downstream end (the piece furthest along the flow).
- **The editor's refusal** to put an area in a compound body (`mergeableBodies`) goes.
- **Direction** of a force area's push and a water area's current is the `Area2D`'s own frame, shared by all its pieces.
  Water that turns a corner is two areas.
- **Submersion at a seam** is the deepest single piece, not the sum, so a ball straddling two touching pieces reads half-wet.
  This exists already for concave outlines; fix it with the union's coverage if it shows in play.

### States the editor refuses and `cli levels` rejects

- A `CollisionShape2D` with no body ancestor.
- A `Node2D` under a `Node3D`.
- A body under a moving, breakable or area body (above).
- A `Decoration3D` whose parent is not a `Formation3D`: its parent is its host.
- An `Anchor2D` under an `Area2D` (a chain tied to a killzone).
- World-fixed nodes (`Spawn2D`, `Checkpoint2D`, camera regions and paths, firefly paths, shelters, fog regions) under anything that moves: the camera and fog read them as fixed volumes, so in play they would stay put while the editor carried them.
- Not exactly one `Spawn2D`.
- A `Chain` or `Vine` naming an anchor that is not in the level: deleting an anchor asks whether to delete its chains, instead of today's silent drop at load.

Warned, not refused: a body with no shapes (it builds nothing and should be a `Node2D`).

### What replaces what

| Today | Node tree |
|---|---|
| body `kind` | the body class (`Area2D` carries `area: killzone \| force \| water \| finish`) |
| body `x`/`y`/`rot`, `bodyFrames` | the body node's own transform |
| 3D body (`space`, `z`, `tilt`), `bodies3d` | a top-level `Formation3D` or `Node3D` |
| `formation?` on a body (at most one) | a `Formation3D` child, any number |
| `DecorationObjectData.formation` | the decoration is a child of its formation |
| formation, decoration and anchor ids | one node id ([Identity](#identity)) |
| body `name` (Blender binding) | node `name`, a label only; Blender binding is dropped |
| the shelter / fog / camera / fireflies / notes layers | node types, filtered by data layers |
| Ctrl+G merge, Ctrl+Shift+G split | "new body from selection", reparent out; Ctrl+G is grouping |

## Formations

There is one class, `Formation3D`, whatever its guide.
Classes here are split by the space a node lives in and what it does, and every formation does the same thing: it is rock drawn in 3D, built into the store, hosting decorations and paint, with the same LOD and the same hash.
What differs is the guide, which is a property:

- **Outline guide** (`boulders`, `fitted`; today's `CollisionGuide`): closed 2D outlines in the formation's local xy plane.
- **Solid guide** (`solid`; today's `SolidGuide`): a boolean tree of 3D primitives, sculpted.

The two shapes a formation takes (Tris, 2026-11-26):

- **Background asset, no collision**: a top-level `Formation3D` (or one under plain `Node3D`s) with no body.
- **Foreground asset with collision**: a 2D physics body (`StaticBody2D`, or another body class) with the `Formation3D` as a child, beside the `CollisionShape2D`s it dresses.

For the foreground case the link between rock and collision is what the tree has to keep:

- **Fit collision to geometry**, **Align guide to collision** and **Align collision to guide** act between a formation and the shapes of its nearest body ancestor.
  They are offered only when the formation has one and lies in the play plane (every ancestor a `Node2D`, no tilt of its own), since a tilted rock has no outline in the plane to fit.
  A formation with no body ancestor is a background asset, and none of them applies.
- The guide's `subset` (which pieces it was taken from) becomes **node ids** of `CollisionShape2D`s instead of indices into the body's objects, so reordering or reparenting shapes cannot point it at the wrong ones.

Migration follows the same split.
Of `ball.json`'s 40 formations, 2 are on 3D bodies and 24 more are on 2D bodies with no collision: all 26 are background assets and become top-level `Formation3D`s, with their decorations as children.
A collisionless body that also holds lights or models becomes a plain `Node3D` holding the formation and them, so nothing moves.
The other 14 sit on bodies with collision and become that body's `Formation3D` child.
The collisionless bodies build nothing today, so the round trip compares the bodies that build, and dropping them changes nothing the sim sees.

A `Formation2D` would add nothing a 2D parent does not already give: a formation under a `StaticBody2D` is in the plane because its parent is.

## Prefabs

A **prefab** is a shared asset that is an editable node tree, stored in its own file (`prefabs/<name>.json`, beside its paint sidecar), opened and edited in the editor like a level.
An **instance** places it in a level (or in another prefab) and may override any property of any node inside it.

### The instance node

```
Instance                    prefab: name, transform of the root, overrides, extra children
```

- The instance takes the class of the prefab's root (an instance of a lamp prefab whose root is a `StaticBody2D` is a `StaticBody2D`), as in Godot, so every rule that reads the class (nesting, physics ownership) works on instances unchanged.
- **Overrides** are keyed by the prefab node's **id**, not its name or path, so renaming or moving a node in the prefab keeps every instance's overrides attached: `{ [nodeId]: { [property]: value } }`.
  An override whose node no longer exists in the prefab is kept and shown as orphaned, never silently dropped, so undoing the prefab edit restores it.
- **Extra children**: an instance may gain children of its own, under its root (Godot's rule). Removing a node of the prefab from one instance is not supported; override it hidden instead, which is what Godot does.
- **Scale**: an instance has a uniform scale.
  A prefab instance is a shared asset, so formations and decorations inside it may be scaled (they are no longer living geometry, decided 2026-11-26).
  Collision inside a scaled instance is scaled at compile (sizes, vertices, offsets), so the sim sees ordinary shapes and mass follows from density as for any other piece.
- **Nesting**: prefabs may instance prefabs. A prefab that reaches itself is refused.
- **Level-only nodes**: a prefab may not hold a `Spawn2D` or a `Checkpoint2D`, which are one-per-level facts.
- **Publishing**: `just publish` and `formation:sweep` treat every prefab a published level instances as part of that level, so a prefab's builds ship with the levels that use it.

### Editing

- **Open prefab** edits the prefab itself; every instance in every level updates.
- **Editable children** (Godot's term): an instance's inner nodes can be shown in the tree and selected in the canvas, and any edit made to one there is written as an override.
  A changed property shows a revert arrow back to the prefab's value.
- **Save branch as prefab** turns a subtree into a new prefab and replaces it with an instance; **Make local** (unpack) does the reverse.
- An instance is **grouped** by default, so a click selects the instance and a second click enters it.

A node inside an instance is identified as [Identity](#identity) says: the ids of the instances down to it, then its own.

### The Assets tab becomes prefabs

Decided 2026-11-26: a shared rock is a prefab holding a `Formation3D` and its decorations, not a rock baked into the model library.
The Formations workspace's Assets tab becomes the prefab library (new prefab, open, place, save branch as prefab), and `scripts/formation-asset.ts`, `formation-assets/` and `/api/formation-assets` go.
Nothing needs migrating: no asset has been made through the tab yet (the model library holds only `bouncy-mushroom-flat`).
The model library stays for what Blender is still opened for, models made by hand.

### Formations in prefabs

A formation in a prefab is built once, from the prefab, and every instance draws that build.
Its paint lives in the prefab's sidecar.
An instance overriding the formation's recipe or guide would need its own build; the first version refuses those overrides (the guide and recipe are not overridable), and an instance that needs different rock is made local.

### Compile

`compileLevel` expands every instance (applying its overrides and scale) before anything else, so the sim, the build order and the round trip see only ordinary nodes.
Build order inside an instance is the instance's key followed by the prefab body's own key, so editing a prefab never reorders the level's other bodies.

## Identity

Every node has an **id**: eight random base-36 characters (as `newFormationId` mints today), unique within its file (a level or a prefab), minted once and never changed by a rename, a move, a reparent or an edit.
It is the one mechanism for naming a node, and every reference uses it:

| Reference | Today | Node tree |
|---|---|---|
| chain / vine end, `via`, `through` | numeric anchor id | anchor node id |
| decoration -> its rock | `formation` string id | the parent link |
| paint sidecar entry | decoration `id` | decoration node id (the same string, kept) |
| guide `subset` | indices into the body's objects | `CollisionShape2D` node ids |
| root branch `parent` | object index in the body | `CollisionShape2D` node id |
| prefab override | - | prefab node id |
| sculpt guide store, formation jobs | formation `id` | formation node id (the same string, kept) |

Inside an instance, a node's full id is the instance ids down to it, then its own: `instA/instB/node`.
A reference into an instance (a chain tied to an anchor in a placed lamp) is that full id.

Migration keeps every id that exists (formation and decoration ids as they are; anchor numbers written as strings) so the paint sidecars, the sculpt store and the formation store need no change, and mints ids for everything else.
`compileLevel` turns node references back into the indices the sim reads today (`root.parent`, `subset`), which is part of what the round trip checks.

The **path** (`Rocks/Ledge/Formation`) is a human address made of names: shown in the scene tree's breadcrumb and printed by `cli query`, `dump`, `trace` and `scan` beside the id.
It is never stored as a reference, because a path changes every time something is renamed or moved, and a reference that breaks on a move is the problem this section exists to avoid.

**Sibling names are unique** (Tris, 2026-11-26), so every path names exactly one node.
As Godot does, a name that would clash with a sibling's is suffixed with the next free number (`Rock`, `Rock2`, `Rock3`) wherever a node gets a name or a parent: creating, renaming, pasting, duplicating, reparenting, instancing, and migration.
Names are only required to be unique among siblings; the same name under two parents is fine, since the paths differ.
An instance's own extra children share the namespace of the prefab nodes beside them, and a prefab edit that introduces a clash suffixes the instance's child, never the prefab's node, so overrides and the prefab stay as authored.

### Blender linking

After `rails.json` is deleted, nothing in Blender points at a level node, and the plan keeps it that way: **the level points at Blender assets, never the reverse.**
A `Model3D` names the model it draws (`assets-src/models/<model>.blend`); the model knows nothing of where it is placed, so moving, renaming or reparenting the node cannot break anything.

If something in a `.blend` ever does need to name a node again, it carries the node's **id** as a custom property (`node_id`), which Blender's glTF export writes to `extras` and three.js reads into `userData`.
Never a name: matching by name is what made the body name a global namespace in the first place.

### What Blender drops

With no level naming a scene, these go:

- `LevelData.scene`, the Level panel's Scene field, and `render3d/sceneDressing.ts` (name binding, `nodeNameOf`).
- `scripts/scene-guide.ts`, `scripts/scene-export.ts` and their Blender halves (`tools/blender/scene_guide.py`, `scene_export.py`), with their `just`/`package.json` entries.
- `scripts/migrate-scene.ts` (+ `migrate_scene_dump.py`): it turns a Blender scene into a level, and there is no scene left to turn.
- The unique-body-name check in `levelLint.ts`.
- `rails`'s pins in `src/render3d/sceneAssets.json` and `scripts/sceneSources.json`; `just publish` stops publishing scenes once none are named.
- `docs/blender-scenes.md` and the scene half of `docs/blender-game.md` become retired docs, as `generators.md` is.

The 51 body names in `ball.json` (leftovers of the river scene's binding) migrate as ordinary node names.

## Tools that read levels

Two read paths, so most tools change nothing:

- **`scaleLevelData(raw) -> LevelData`**, the compiled sim view, accepting every format (flat, 2, 3) forever.
- **`loadLevelTree(raw) -> tree`**, the authored view, for the editor, the renderer and anything that edits formations.

| Tool | Verdict |
|---|---|
| `extract-level.ts` | unaffected: it writes the flat form, which is an input to the gate forever |
| `bake-roots.ts`, `rootBakeEncode.ts` | unaffected: they read the compiled view, and `rootMeshKey` hashes compiled body data, so every pinned bake key stays valid |
| `bridge-solver-study.ts` | unaffected: its `bodies` is its own rig |
| `src/server/store.ts` | unaffected: its `bodies` are recorded waypoints |
| `test-chain-sound`, `test-speed-wind`, `test-landing-sound`, `test-sound-materials`, `test-berry-vines`, `test-chain-drape`, `test-mushrooms`, `test-vine-braid` | expected unaffected: inline levels through `scaleLevelData` into the sim; confirmed in phase 1 |
| `formation-build.ts` | migrate: `--level --body <index>` becomes `--level --node <id>` |
| `formation-build-level.ts` | migrate: walks `Formation3D` nodes and their decorations; `--only <body name>` becomes `--only <id or path>` |
| `formation-sweep.ts` | migrate: collects built hashes from tree nodes, and from prefab files |
| `formation-asset.ts` | drop: the Assets tab becomes prefabs |
| `test-formations.ts`, `test-sculpt.ts` | migrate: their editor round trips read `bodies[0].formation` |
| `src/server/formations.ts` | migrate: decoration and material requests name their formation by id; the formation travels as a node |
| `src/editor/api.ts` (the level REST API) | migrate: reads and writes the tree |
| `scene-guide`, `scene-export`, `migrate-scene` | drop (above) |
| `solidGuideMigration.ts`, `migrate-solid-guides.ts` | drop if `cli levels` confirms no file still holds a retired orthographic leaf; their cases go with them |

## Workspaces

Each workspace sets which node types are **visible** and which are **clickable**, as a data-layer preset, and the group rule only stops at a group root whose type is clickable there: it passes through the rest.
So in Decorations a click on a fern selects the fern, even though the body above it is grouped, because a body is not clickable in that workspace.

Proposed starting presets, to be settled by playing them in phase 3:

| Workspace | Clickable |
|---|---|
| 2D | bodies, shapes, anchors, chains, vines, the 2D volumes, notes, instances |
| Formations | bodies, `Formation3D`, plain `Node3D`, `Model3D`, `Light3D`, instances |
| Decorations | `Decoration3D` (placed kinds); painted kinds through the brush |
| Texturing | material layers through the brush; nothing by click |

## Build order

The solver visits contacts in body order, so body order changes how a level plays.
In a tree, a drag in the outliner (grouping two rocks under a `Node2D`) would reorder bodies and silently break the level's replays.

So `compileLevel` emits bodies in a stable **build order** that is not tree order: each body node carries an `order` key, migration assigns it the body's index in the old list, and a new body takes one past the highest.
Reparenting and reordering siblings never touch it, so they change draw order in the editor and nothing in the sim.
Duplicate and paste take new keys, exactly as appending a body does today.

## Bit-identity: the sim never sees the tree

The tree is the **authored** form.
The sim keeps consuming exactly what it consumes now, `LevelBodyData[]`, produced by one function:

```
compileLevel(tree) -> LevelData (bodies in build order, chains, vines, ...)
```

`src/engine`, `src/classes` and the sim's ~70 readers of `.bodies` do not change.
The legacy reader becomes `migrateToTree(LevelData) -> tree`, run inside `normalizeLevelData`, so every old level, every bundle in `playtests/regressions/` and the Godot extractor's flat form all reach the sim through the same gate.

The proof is a round trip, checked as a suite over every level and every bundle in the corpus:

```
compileLevel(migrateToTree(L)) deep-equals normalizeLevelData(L)   (the sim-relevant part)
```

plus `replay selftest` and the bundle corpus, which must stay bit-identical.
A migrated level has exactly the old nesting (body, then its pieces), so the composition at compile goes through the same arithmetic the build does now.

`compileLevel` also returns the map from engine body index to node path, which `cli query`, `dump`, `trace` and `scan` print beside every body index.

## Rendering

`render3d` builds one `THREE.Object3D` per spatial node and parents them as the tree is parented.
A body node's object gets its transform from its engine body each frame (interpolated, as now); everything under it follows by the scene graph.
That replaces the per-body carrying code, the 3D-body special case and the formation-on-a-body lookup with one rule.

## Editor

- **Model**: `EdNode` tree (id -> node, parent, ordered children) replaces the flat `EdItem` list, `bodyId`, `bodyFrames`, `bodies3d` and the duplicated body properties.
- **Outliner -> scene tree**: every node, nested; drag to reparent and to reorder siblings; "+ child" on a row; a 2D/3D marker, a type icon and a group marker per row.
  A row click selects exactly that node, groups or not (as in Godot).
- **Selection**: one set of node ids; canvas clicks follow [Groups](#groups).
- **Inspector**: shows the fields of the node's class, nothing else.
- **Decorations**: placing or painting one on a rock creates it as a child of that formation.
- **Data layers** (both kinds decided 2026-11-26), each with visibility and lock, over the one tree rather than separate lists:
  - **Type filters**, fixed: today's layers (scene, shelter, fog, camera, fireflies, notes) recast as filters by node type. The workspace presets are built from these.
  - **User layers**, Unreal's meaning: layers you create and name, and any node can be assigned to any number of them (a layer list on the node, saved in the level). A child is in its ancestors' layers too, so hiding a layer hides whole subtrees.
  A node is shown only if every filter and every layer it is in is visible, and editable only if none of them is locked.
  User layers are editor-only, like groups: the game ignores them.
- Ctrl+G / Ctrl+Shift+G group and ungroup (below); making a compound body is "new body from selection" (the pieces reparented under a new `StaticBody2D`, keep world).

## Groups

Any node can be **grouped** (a flag on the node, saved in the level).
Grouping changes only what a click on the canvas selects; it changes nothing about transforms or the sim.
Groups nest: a grouped node may sit inside another group.

A group is **entered** while its root or anything inside it is selected (Figma's rule, agreed 2026-11-26).
The rule, applied from the outermost group root on the path from the level root down to the node under the pointer:

1. If that group is **not entered**, select its root.
2. If it **is entered**, apply the rule again to the next group root further down the path; if there is none, select the node under the pointer.

So with a shape S inside group G2 inside group G1, three clicks on S select G1, then G2, then S.
With S selected, a click on its sibling T inside G2 selects T directly, and a click on anything in G1 outside G2 selects that, or the root of the group it is in.
Selecting something outside G1 leaves G1, and the next click inside it selects G1 again.

Alongside it:

- **Alt+click** ignores groups and selects the node under the pointer, as it reaches past a body today.
- **Clicking again on what is already selected** steps to the next thing stacked under the pointer (today's `pickAt` cycling).
- **A rubber band** selects the outermost group root of everything it takes.
- **The scene tree** ignores groups.
- **Bodies are created grouped**, so the canvas keeps today's click-the-body-then-click-into-it feel; ungrouping one makes its pieces directly clickable.

## Phases

Each phase lands green (`bun run test`, `replay selftest`, the corpus) and changes nothing on disk until phase 4.

0. **Clean start.** The uncommitted material-layer work touches `levelFormat.ts`, `editor.ts`, `decorationPanel.ts` and others this plan rewrites; it lands (or is parked) first.
   Delete `ball-migrated.json` (Tris, 2026-11-26: `migrate-scene`'s output from the river scene, no longer wanted).
   Delete `rails.json` (its registry entry, its references in `scripts/test.ts` and `src/tools/cli.ts`, its scene pins) and everything under [What Blender drops](#what-blender-drops), so the tree never has to model a Blender-dressed level.
1. **Types, compile, migrate.** The node classes in `src/level/nodes.ts`, `compileLevel` with build order, `migrateToTree`, the validity rules, the round-trip suite over levels + corpus, node paths in the replay tools.
   The game loads `migrate -> compile`, proving the path with no visible change.
2. **Renderer on the tree.** Object3D per node; the 3D-body and formation-on-body paths deleted; water drawn from every piece of its area.
3. **Editor on the tree.** The model, scene tree, selection and groups, inspector, reparenting, decorations as children, data layers. The largest phase, done in one go, with editor feature work paused.
4. **On disk.** `LEVEL_FORMAT = 3` writes `nodes`; one script rewrites `levels/*.json` with every editor tab closed; backdrop bodies become top-level `Formation3D` nodes and decorations move under their formations.
   The format-2 reader stays forever, as every retired form does.
5. **Prefabs.** The prefab file, the `Instance` node and its expansion are in the format from phase 1 (so nothing written later has to be migrated again); this phase is the editor: open prefab, editable children, overrides and revert, save branch as prefab, make local, the prefab library.
6. **Docs.** `editor-model`, `level-format`, `formations`, `render3d`, `areas-and-friction`, `water`, the `CLAUDE.md` map; `blender-scenes` retired.

## Accepted

Accepted, recorded for later: the level hash (`levelFileHash`, over the file's bytes) changes for every level at the phase 4 rewrite, splitting feedback from runs either side of that date; and the node-to-engine-body map is one-to-many because a root with bends builds several hinged engine bodies.

## What green cannot see

The round trip proves the sim is unchanged; it says nothing about the editor's feel (groups, picking, drag-to-reparent, the tree's readability) or about a migrated backdrop drawing in the same place.
Phase 2 needs a `cli shot --3d --diff` before/after on every level, and phase 3 needs Tris to play the editor before its cases are written.
