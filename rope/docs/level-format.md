# Level files and format

## Level files

Levels save/load to `rope/levels/*.json` in the **on-disk pixel `LevelData` format**
(same as generated `levelData.ts`), through a **dev-only REST API** (`GET/PUT/DELETE
/api/levels[/<name>]`) added by the `levelApi` Vite plugin in `vite.config.ts`. The built
app has no server, so the editor is a dev tool.

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
(`resolveJsonModule`; JSON widens string literals, so the spec casts to `LevelData`). That
is how `levels/ball.json` backs the `BALL` entry: one file, edited in the editor and bundled
into production, rather than a hand-copied TS duplicate.

Beside the geometry a level carries a few lists that are not bodies: `cameraRegions` and `cameraPaths` (how it is framed), `notes` (authoring commentary nothing reads), `chains` and `vines` (what is strung between bodies), and **`checkpoints`** - named spawns, each a name and a point, which `?checkpoint=NAME` moves `player` to before the level is built (see [**Checkpoints**](running.md#checkpoints)).
`scaleLevelData` converts a checkpoint's placement and leaves its name alone, and it **drops nothing**: that function is the editor's save as much as the game's load, so a rule that deleted a blank or repeated name would delete a marker the author had just placed.
The lookup is what enforces the name instead - trimmed, case-folded, first match wins - and the editor's panel is what reports a name that is missing or already taken.

The `player` block is the spawn (`SpawnData`): a point, the avatar radius, and **`hang`**, which is the only thing in it that is not geometry.
A spawn with `hang: true` opens the ball & chain run already on its anchor - see [**The spawn anchor**](ball-coil-and-hook.md#the-spawn-anchor) - and one without it starts the ball on the ground, which is every level authored before the field.
It anchors the chain; it does not lift the ball, so a level that starts hanging is authored by putting the spawn where the ball should *hang*, under something to hang from.
The editor offers it as `hang` in the Player spawn group, and carries it through the model for the reason the environment block is carried: the editor writes the whole file back, so a field the model does not know about is a field the first autosave *deletes*.

A body may also state what it takes to DESTROY it: **`breakForce`** (newtons) and **`durability`** (hits), the breakable pair - see [**Breakable geometry**](breakable.md).
Both are stated in the sim's own units and `scaleLevelData` leaves them alone, for the reason `drag` is left alone: the file's lengths are pixels because the editor draws in pixels, and neither a force nor a count is a length.

The canonical, hand-editable schema now lives in `src/level/levelFormat.ts` (superset of
the generated one — adds the `rigid` and `force` kinds, the `cameraRegions` and
`chains` lists, and bodies made of scene objects); `levelData.ts` stays
auto-generated and is structurally assignable to it. Both level drivers construct geometry
through the shared `src/level/buildBodies.ts` (statics, killzones,
force areas, and rigid bodies), so the grapple and ball controllers load identical scenes.
`rigid` bodies get mass/inertia from `ShapeGeometry` and fall under gravity.

## Regenerating level geometry

`levelData.ts` is generated from the prototype's Godot scene; do not hand-edit it:

```sh
bun scripts/extract-level.ts <path-to>.tscn src/level/levelData.ts
```
