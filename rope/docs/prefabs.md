# Prefabs

A **prefab** is a shared asset that is an editable node tree: a lamp, a gantry, a rock with its moss, built once and placed in any number of levels.
It is stored in its own file and opened and edited in the editor like a level; every placement follows the edit.
A placement is an **instance**, a node of the level ([level-format](level-format.md#the-node-tree)) that names the prefab and may override any property of any node inside it.
The design and its reasons are in [plans/node-tree.md](../plans/node-tree.md#prefabs); this is how it works.

## The file

`prefabs/<name>.json` is `{ format: 3, root }` (`PrefabData` in `src/level/nodes.ts`): one node and its subtree, in pixels, as a level file is.
Its paint (the strokes of its painted decorations) is beside it in `prefabs/paint/<name>.json`, as a level's is in `levels/paint/`.
A prefab may hold anything a level may, except the two things that are one per level: a `Spawn2D` and a `Checkpoint2D`.
Its ids are unique within the file, as a level's are within the level.

`prefabLibrary()` is every prefab by name, read once and kept.
In the browser it is Vite's eager glob of the folder; under bun it reads the directory, so `compileLevel` stays synchronous for every caller.
The editor replaces an entry after it saves one (`setPrefab`), so a level compiled in the same session sees what was just written.

`prefabsAt(factor)` is the library at a tree's length scale (`LevelTree.lengthScale`).
It exists because the units differ: a prefab file is in pixels like a level file, while the editor and the sim work in metres, so a tree read in metres has to expand its instances against prefabs scaled the same way, or a lamp placed in a metre-scale level would come out a hundred times too large.
The shared library's scaled copies are kept per factor until a prefab is replaced.

## The instance node

An `Instance` (`InstanceNode`) carries the prefab's name, its own pose (with depth and tilt), a uniform `scale`, an `order` key, `overrides` and any `children` of its own.
It takes the class of the prefab's root, as in Godot (`classOf`): an instance of a prefab whose root is a `StaticBody2D` is a `StaticBody2D` to every rule that reads a class, so where it may sit and what it owns are asked of the instance unchanged.

**Expansion** (`expandInstances`) replaces each instance with a copy of its prefab's tree before anything else reads the level, so the sim, the build order and the round trip see only ordinary nodes:

- the overrides are applied to the copy, then the prefab's own instances are expanded inside it, so prefabs nest;
- every id inside is prefixed with the instance's (`inst/node`), and so is every reference inside (a chain's anchors, a root branch's parent, a guide's `subset`, a swarm's path), so two placements of one lamp never share an id;
- the root takes the instance's id, name, flags and pose, so the instance IS the prefab's root where it stands;
- the instance's own children are appended under the root.

A prefab that reaches itself through its instances is refused, and so is an instance of a prefab that does not exist.
Either expands to a **holder**: a `Node2D` (a `Node3D` when the instance has depth or tilt) with the instance's id, name and pose, holding the instance's own children.
So nothing authored under a missing prefab moves or is lost, and the instance itself is kept by whoever wrote it.

**Overrides** are keyed by the prefab node's **id**, never its name or path, so renaming or moving a node in the prefab keeps every instance's overrides attached: `{ [nodeId]: { [property]: value } }`.
A value of `null` removes the property from that node; `disabled: true` takes the node and everything under it out of the level, which is how one instance drops a node of its prefab.
A `Formation3D`'s `guide`, `params`, `generator` and `variant` are not overridable (`PREFAB_ROCK_RECIPE`): a rock in a prefab is built once, from the prefab, and every instance draws that build, so an instance that needs different rock is made local.
A file holding such an override is refused by `cli levels`, and the compile ignores it and says so; the editor never writes one, and its Formation section on a prefab's rock points at the prefab instead of offering the recipe.
An override naming a node the prefab no longer has is kept on the instance, reported by the compile and by `cli levels` as a warning (not a refusal), and shown as orphaned in the editor, never silently dropped, so undoing the prefab edit restores it.

**Scale** is geometric, about the prefab root's origin (`scaleGeometry`): positions, every length in a shape, a piece's thickness, a body's bearing and route, a light's range, a chain's and a vine's length.
Rates are not lengths and are left alone, so a scaled pendulum swings at the same period.
Collision inside a scaled instance is scaled at compile, so the sim sees ordinary shapes and mass follows from density as for any other piece.
A `Model3D` multiplies its own scale; a `Formation3D` keeps its guide as authored and is drawn scaled with its decorations (`placedScale`, set by the compile alone and never authored), since its build is the prefab's.

**Build order** inside an instance is the instance's `order` followed by the prefab body's own, compared as a tuple, so editing a prefab never reorders the level's other bodies ([level-format](level-format.md#build-order)).

## In the editor

**The Prefabs tab** of the right dock (beside the scene tree's Scene tab, in every workspace) is the library: each prefab with **Place** and **Open**, a name field, **New prefab** and **Save selection as prefab**.
It took the place of the Assets tab (retired 2026-11-26), whose reusable rocks are prefabs now.
An open prefab is edited in the Scene tab, under a banner naming it with **Back to the level**, and is lit by the level's own Sun and Environment, which stand beside it while it is open and are never written into it.

- **Place** puts an instance at the view's centre, grouped and built after every other body (`nextOrder`).
- **Open** edits the prefab in place of the level, with every tool and workspace: the level's model, its undo steps, its name and its view are put aside and given back by **Back to the level**.
  The level is shelved as written (its tree, not its expanded model), so on the way back it is read again through the prefab library and every instance shows the edit, and an undo step cannot carry the prefab's old values back as if they were the level's overrides.
  An open prefab autosaves to its file 750 ms after an edit, as a level does; several top-level nodes are saved under one `Node2D`, the spawn the editor's model always holds is left out, and a state a prefab may not hold (a checkpoint, an instance of itself) is refused with a notice rather than saved.
- **New prefab** saves an empty grouped `Node2D` under the name and opens it.
- **Save selection as prefab** turns the one selected node and everything under it into a new prefab, its pose left out, and replaces it in the level with an instance standing where it stood and keeping its build order key.

A selected instance's inspector has a **Prefab** section: the prefab's name (marked missing when it is), **scale**, **editable children**, each override with **Revert**, **Open prefab** and **Make local**.

- **Editable children** (Godot's term) lists the prefab's insides in the scene tree and lets a click on the canvas reach them.
  Until it is ticked a click anywhere inside the instance selects the instance, whatever the group rule or Alt says (`sealedTarget`).
  It is the session's, never written to the level.
- **Overrides are computed, not recorded** (`instanceOverrides` in `src/editor/model.ts`).
  The model holds an instance expanded, its insides ordinary nodes and items marked as the instance's (`inInstance`), drawn, picked and edited like any others.
  On every write the instance as its prefab alone would place it (expanded at its scale, no overrides) and the insides as they stand now are both written by the same writer, `toTree`, and every field that differs is an override.
  Writing both the same way is what keeps a default spelt one way, or a placement rounded through a frame, from reading as an edit.
  A scaled instance's override is taken back into the prefab's units, so it survives a change of scale; a node of the prefab that is gone from the model is overridden `disabled`.
- **Revert** drops one node's override, back to the prefab's values; an orphaned override's Revert drops it for good.
- **Make local** unpacks the instance: it becomes a node of its root's class, and every node it brought becomes the level's own, with a fresh id and the values it had with the overrides applied.

A painted decoration inside an instance starts from the prefab's strokes (the level's `inst/deco` reads the prefab's `deco`); only strokes painted over in the level are written to the level's paint, so the rest go on following the prefab.

## Tools

- `cli levels` holds every prefab to the tree's rules and to a prefab's own: no spawn or checkpoint, no instance of itself ([level-format](level-format.md#states-the-editor-refuses)).
- `cli nodes` has the instance cases: expansion, prefixed ids and references, overrides, scale and the build order of what an instance brings.
- `cli render3d`'s prefab cases edit inside a placed prefab in the editor model and read the overrides back, in the prefab's units at a scale, and after a reload.
- `formation:build-level` does not walk into instances: a rock inside a placed prefab is the prefab's.
  `formation:sweep` reads every prefab file as well as every level, so a prefab's builds are kept.
- `just publish` packs the formations each registered level draws from its compiled form, instances expanded, so a prefab's rock ships with the levels that place it.
- The dev server's `/api/prefabs` (`prefabApi` in `vite.config.ts`) lists, reads, writes and deletes prefab files, with the level API's four verbs; a write invalidates the module that globs the folder, so a page loaded after a new prefab was saved compiles against it.
  A prefab's paint is `/api/paint/prefabs/<name>` (`src/server/formations.ts`).
