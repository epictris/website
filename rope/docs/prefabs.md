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
- **Open** edits the prefab as a scene of its own, in place of the level, with every tool and workspace: the level's model, its undo steps, its name and its view are put aside and given back by **Back to the level**.
  The level is shelved as written (its tree, not its expanded model), so on the way back it is read again through the prefab library and every instance shows the edit, and an undo step cannot carry the prefab's old values back as if they were the level's overrides.

**A prefab is a scene with ONE root node**, as a Godot scene is (2026-11-26, Tris: "the prefabs should themselves be scenes, with a single root node"; "just make whatever change you need to get a robust process").
The open prefab's root is held by id (`prefabRootId` in `editor.ts`), and everything about editing it follows from that:

- **Its tree is the prefab.** The Scene tab lists the root and what is under it; the spawn the editor's model always holds and the level's Sun and Environment it is lit by are neither listed nor saved (`isLevelFurniture`).
  Nor is the spawn drawn or picked: it stands at the prefab's origin, where it drew the 12 cm iron ball over the prefab and took the clicks meant for it (`spawnShown` in `drawEditor`, no `ball` in the editor scene, no spawn hit).
- **Nothing stands beside the root.** Whatever an edit leaves at the top - a prefab placed into it, a body drawn into nothing, a paste, a light - is moved under the root where it stands (`adoptPrefabStrays`, after every edit).
  With nothing selected, a collision shape drawn into a body root joins it, as it would join a selected body (`insertDrawn`).
- **The root is the prefab's origin.** An instance gives the root its own pose (`expandInstances`), so a pose in the file is never seen in a level; the editor opens the root at the origin, pose dropped, so the prefab looks as its instances do (`prefabRootAtOrigin(root, false)`). The root moved or turned while open is saved with that move carried into its children and the root at the origin (`prefabRootAtOrigin(root, true)`), so what was seen is what is kept. Until 2026-11-26 a root turned 11.7° by the gizmo showed `mine-track` straight in the level and tilted in its prefab.
- **It opens framed and head on**, as Home frames it (`wholeBox`: the prefab's own items, a model by what is drawn of it rather than its mark), again once its models have landed unless the view was moved, and aligned to the plane, since a view framed in depth is a turned one with only select and move.
- **Make root** (a right click on a node in the Scene tab; Godot's "Make Scene Root") makes that node the root, where it stands, in one undo step (`makePrefabRoot`). The old root comes under it; a plain group with nothing of its own (the `Node2D` a second top-level node was once wrapped in) is dissolved instead, what it held coming under the new root, and its name goes to a new root still called after its class. Refused, whole, with why, for the root itself, a part of a placed prefab, or anything the prefab could not then be saved as. Undo and redo carry the root with them (`syncPrefabRoot`).
  The same menu offers **Rename** and **Delete** on any row (the root's Delete is refused: a prefab needs its root).
- **The root keeps its id and its class.** What is saved is the root node and its subtree, nothing else. A node the root may not hold (a body under a rigid one), or the root deleted, is NOT saved, and the title says why (`NOT SAVED: ...`) until an edit or an undo clears it; the file keeps its last good state.
  Until 2026-11-26 a second top-level node was wrapped at save in a new `Node2D` with a fresh id, so the root's id and class changed on every such save: instances' overrides of the root came loose, and a body-rooted prefab became a group (`mine-track`).
- **It is a document.** It autosaves 750 ms after an edit as a level does, a pending write is flushed when the page closes, and a write that fails stands in the title. The address names it (`?prefab=NAME`, beside `?level=`, `viewUrl.ts`) and the browser remembers it (`rope.editor.prefab`, `prefs.ts`), so a reload reopens the prefab over its level. **Back to the level** after such a reload loads the level from disk. Opening a level, **New**, or File → Save while a prefab is open write the prefab first; a prefab that cannot be saved asks before it is left.
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
  A scaled instance's override is taken back into the prefab's units, so it survives a change of scale; a node of the prefab that is gone from the model is overridden `disabled`, the topmost only (one gone with its parent is out with it, so reverting the parent brings back all of it).
  A placement left out is zero, so `x: 0` and no `x` are the same placement, not an override.
  An instance whose prefab was missing when it was read is a holder and keeps the overrides it was read with (`holder`); diffed, it once overrode every node of its prefab `disabled` once the library gained it.
- **Copies.** Duplicate, copy and paste (`graftModel`) carry a placed prefab's insides under the copy's fresh id (`copy/node`) and keep their build order keys and placements, so a copy writes exactly as the original does; a pasted prefab arrives whole and never joins the selected body.
- **Disabled nodes** (by an override, or authored so) are out of the compile, so the editor holds their own fields as loaded and writes them back as they were (`holdDisabled` in `modelFromTree`); before 2026-11-26 every save stripped them (a disabled shape lost its shape, a lamp its light).
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
  The folder is off vite's watcher (a write must not restart the server), so the API also watches it itself, as the level API watches `levels/`: a prefab written any other way (by hand, a `git checkout`, a script) invalidates the glob too. Without that, four prefabs written by a script on 2026-11-26 were listed in the Prefabs tab, which reads the folder, while **Place** expanded each against a library that did not hold it, into an empty holder.
  A prefab's paint is `/api/paint/prefabs/<name>` (`src/server/formations.ts`).
