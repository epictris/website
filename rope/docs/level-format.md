# Level files and format

## Level files

Levels save/load to `rope/levels/*.json` in the **on-disk pixel `LevelData` format**
(same as generated `levelData.ts`), through a **dev-only REST API** (`GET/PUT/DELETE
/api/levels[/<name>]`) added by the `levelApi` Vite plugin in `vite.config.ts`. The built
app has no server, so the editor is a dev tool.

Saving is **automatic** once the model has a name: every edit (including undo/redo) schedules a write 750 ms later, so a drag or a run of nudges collapses into one save, and a pending write is flushed on `pagehide` with a `keepalive` request.
An *unnamed* model never autosaves - the first Save/Save As names the file, and everything after that persists on its own; the title's `*` is therefore a brief in-flight marker, not a standing warning, and an autosave failure shows as `SAVE FAILED` there rather than an alert (a modal mid-drag is worse than the loss it reports).
New/Load/Delete each cancel a queued write, so it can never land on the wrong name or resurrect a deleted file.

Autosave must not reload the page, and by default it would: `levels/ball.json` is *imported* by `registry.ts`, so writing it invalidates a real module and Vite full-reloads every open page - including the editor doing the writing.
So `levelApi` implements `handleHotUpdate` and returns `[]` for anything under `levels/`, dropping those files out of HMR entirely (a level is only read at page load anyway; reload by hand to pick one up), and its `PUT` skips writes whose bytes are unchanged so a redundant autosave never even touches the watcher.

A saved level ships in the build by being **imported** into `src/level/registry.ts`
(`resolveJsonModule`; JSON widens string literals, so the spec casts to `LevelData`). That
is how `levels/ball.json` backs the `BALL` entry: one file, edited in the editor and bundled
into production, rather than a hand-copied TS duplicate.

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
