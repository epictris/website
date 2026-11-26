# Node tree: everything is a node

Status: proposed 2026-11-26, not started; awaiting Tris's review.

Decided (Tris, 2026-11-26):

- `Node` is the base class everything inherits from.
- Bodies are split into classes the Godot way (`StaticBody2D`, `RigidBody2D`, `Area2D`), not one body with a `kind`.
- A `CollisionShape2D` belongs to its nearest body ancestor, so plain `Node2D` groups may sit between a body and its shapes.

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
Node                      id, name, children; no transform
├─ Node2D                 x, y, rot in the parent's frame; lives in the gameplay plane
│  ├─ StaticBody2D        static scenery, movers (routed / swing / spin)
│  ├─ RigidBody2D         dynamic bodies, pivots, spring mounts
│  ├─ Area2D              killzone, force, water, finish
│  ├─ CollisionShape2D    shape + per-piece props (material, mask, rail, viscosity, debug, root...)
│  ├─ Anchor2D            a chain or vine end
│  ├─ Spawn2D, Checkpoint2D
│  ├─ CameraRegion2D, CameraPath2D, FireflyPath2D
│  ├─ Shelter2D, FogRegion2D
│  └─ Note2D
├─ Node3D                 position xyz, rotation, scale in the parent's frame
│  ├─ Formation3D         recipe + guide + built
│  ├─ Decoration3D        moss, ivy, fern, vine, mushroom, glow, material
│  ├─ Model3D
│  └─ Light3D
├─ Chain                  references two Anchor2D ids (+ via / through)
└─ Vine                   references one or two Anchor2D ids
```

Level-wide settings that are not things in the level stay as level properties: `meta`, `environment`, `camera` (lens), `scene`, `format`.

### Transform rules

- A `Node2D` composes in the plane with its `Node2D` parent.
- A `Node3D` under a `Node2D` takes the 2D frame lifted into 3D (x, y, 0 and a turn about z), then its own 3D transform.
  So a model on a swinging crate, or a formation dressing a static, rides its body.
- A `Node2D` may not sit under a `Node3D`: the plane is the gameplay plane, and a 2D node is in it by definition.
  The editor refuses the reparent; `cli levels` refuses the file.
- A plain `Node` has no transform.
  As in Godot, its spatial children start from the world frame, so it is a folder and nothing else.
- Reparenting offers both of Unreal's attach rules.
  **Keep world** (the default, and what a drag in the scene tree does) leaves the node where it stands and rewrites its local transform against the new parent.
  **Keep relative** keeps its local numbers, so it moves to the same offset on the new parent.
  Keep world cannot be exact under a non-uniformly scaled, rotated `Node3D` parent (the result would need shear); there it keeps position and rotation and says the scale was approximated.

### Physics ownership

- A `CollisionShape2D` belongs to its **nearest body ancestor** (`StaticBody2D`, `RigidBody2D`, `Area2D`), through any plain `Node2D` between them.
  A shape with no body ancestor is a lint error (Godot's yellow warning), never silently a body of its own.
- A body under another body takes its parent's frame at build and then simulates on its own (Godot's `RigidBody2D` under anything).
  A static under a static is the common case and is just a composed placement.
- An `Anchor2D` is attached to its nearest body ancestor, or to the world when it has none.
- Every per-body property lives on the body node once, so `syncBodyProps` and the body-set selection go away.

### What replaces what

| Today | Node tree |
|---|---|
| body `kind` | the body class (`Area2D` carries `area: killzone \| force \| water \| finish`) |
| body `x`/`y`/`rot`, `bodyFrames` | the body node's own transform |
| 3D body (`space`, `z`, `tilt`), `bodies3d` | a top-level `Node3D` (or `Formation3D`) |
| `formation?` on a body (at most one) | a `Formation3D` child, any number, anywhere |
| `DecorationObjectData.formation` | the decoration is a child of its formation |
| body `name` (Blender binding) | node `name`, matched the same way (`nodeNameOf`) |
| the shelter / fog / camera / fireflies / notes layers | node types; the layer toggles become per-type visibility and lock |
| Ctrl+G merge, Ctrl+Shift+G split | "group under new body", "reparent out" |

## Bit-identity: the sim never sees the tree

The tree is the **authored** form.
The sim keeps consuming exactly what it consumes now, `LevelBodyData[]`, produced by one function:

```
compileLevel(tree) -> LevelData (bodies in depth-first pre-order of body nodes, chains, vines, ...)
```

`src/engine`, `src/classes` and the sim's ~70 readers of `.bodies` do not change.
The legacy reader becomes `migrateToTree(LevelData) -> tree`, run inside `normalizeLevelData`, so every old level, every bundle in `playtests/regressions/` and the Godot extractor's flat form all reach the sim through the same gate.

The proof is a round trip, checked as a suite over every level and every bundle in the corpus:

```
compileLevel(migrateToTree(L)) deep-equals normalizeLevelData(L)   (the sim-relevant part)
```

plus `replay selftest` and the bundle corpus, which must stay bit-identical.
A migrated level has exactly the old nesting (body, then its pieces), so the composition at compile goes through the same arithmetic the build does now.

## Rendering

`render3d` builds one `THREE.Object3D` per spatial node and parents them as the tree is parented.
A body node's object gets its transform from its engine body each frame (interpolated, as now); everything under it follows by the scene graph.
That replaces the per-body carrying code, the 3D-body special case and the formation-on-a-body lookup with one rule.

## Editor

- **Model**: `EdNode` tree (id -> node, parent, ordered children) replaces the flat `EdItem` list, `bodyId`, `bodyFrames`, `bodies3d` and the duplicated body properties.
- **Outliner -> scene tree**: every node, nested; drag to reparent (and reorder siblings, which is draw and build order); "+ child" on a row; a 2D/3D marker and a type icon per row.
- **Selection**: one set of node ids.
  A canvas click picks the outermost unselected ancestor of what is under the pointer, and a click again steps one level deeper - the current body-then-object step, generalised to any depth - with the existing click-again cycling (`pickAt`) kept.
- **Inspector**: shows the fields of the node's class, nothing else.
- **Decorations**: placing or painting one on a rock creates it as a child of that formation.
- **Data layers** (Unreal's term, agreed 2026-11-26): the layer bar becomes visibility and lock filters over the one tree, not separate lists.
  Today's layers (scene, shelter, fog, camera, fireflies, notes) are the starting set.

## Phases

Each phase lands green (`bun run test`, `replay selftest`, the corpus) and changes nothing on disk until phase 4.

0. **Clean start.** The uncommitted material-layer work touches `levelFormat.ts`, `editor.ts`, `decorationPanel.ts` and others this plan rewrites; it lands (or is parked) first.
1. **Types, compile, migrate.** The node classes in `src/level/nodes.ts`, `compileLevel`, `migrateToTree`, the round-trip suite over levels + corpus.
   The game loads `migrate -> compile`, proving the path with no visible change.
2. **Renderer on the tree.** Object3D per node; the 3D-body and formation-on-body paths deleted.
3. **Editor on the tree.** The model, scene tree, selection, inspector, reparenting, decorations as children, layers as filters. The largest phase.
4. **On disk.** `LEVEL_FORMAT = 3` writes `nodes`; one script rewrites `levels/*.json` with the editor closed; backdrop bodies become top-level `Formation3D` nodes and decorations move under their formations.
   The format-2 reader stays forever, as every retired form does.
5. **Docs.** `editor-model`, `level-format`, `formations`, `render3d`, `blender-scenes`, the `CLAUDE.md` map.

## What green cannot see

The round trip proves the sim is unchanged; it says nothing about the editor's feel (picking depth, drag-to-reparent, the tree's readability) or about a migrated backdrop drawing in the same place.
Phase 2 needs a `cli shot --3d --diff` before/after on every level, and phase 3 needs Tris to play the editor before its cases are written.
