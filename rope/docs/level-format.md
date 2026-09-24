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

The `player` block is the spawn (`SpawnData`): a point, the avatar radius, and three fields that say how the run OPENS - **`hang`**, **`roll`** and **`arrival`**.
A spawn with `hang: true` opens the ball & chain run already on its anchor - see [**The spawn anchor**](ball-coil-and-hook.md#the-spawn-anchor) - and one without it starts the ball on the ground, which is every level authored before the field.
It anchors the chain; it does not lift the ball, so a level that starts hanging is authored by putting the spawn where the ball should *hang*, under something to hang from.
The editor offers it as `hang` in the Player spawn group, and carries it through the model for the reason the environment block is carried: the editor writes the whole file back, so a field the model does not know about is a field the first autosave *deletes*.

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
The editor carries it through `EdModel.meta` and offers it as the **Level** panel, for the reason `hang` and the environment block are carried: a block the model does not know about is a block the first autosave deletes.

A body may be the level's **finish line**: `kind: "finish"`, the region the player crosses to complete the level - see [**The finish line**](levels.md#the-finish-line).
A KIND rather than a flag, because it is what the body is: a `finish` body builds an `Area2D` and nothing else, exactly as a `killzone` does, and there is no body a finish line and a wall could both be pieces of (`isAreaKind`).
The gantry that marks it is an ordinary geometry object on the same body (`mesh: "finish-line"`), so what is drawn and what is crossed are one thing to place.

A body may also state what it takes to DESTROY it: **`breakForce`** (newtons) and **`durability`** (hits), the breakable pair - see [**Breakable geometry**](breakable.md).
Both are stated in the sim's own units and `scaleLevelData` leaves them alone, for the reason `drag` is left alone: the file's lengths are pixels because the editor draws in pixels, and neither a force nor a count is a length.

A collision object's shape may be a **`belt`**: `{ kind: "belt", wheels: [{ x, y, r }, ...], thickness, speed }`, a conveyor - see [**Conveyor belts**](conveyors.md).
Each wheel is a centre in the object's frame and the WHEEL's own radius; `wheels[0]` is at `(0, 0)`, the object's own origin, and is written out anyway because it carries a radius.
There are two or more, and every one must lie on the convex hull of the discs of radius `r + thickness`: the band wraps the outside of all of them.
`thickness` is the band's depth in the plane, `> 0`, so the running surface round each wheel is at `r + thickness`; how wide the band is across the pulleys is the geometry twin's `depth`, a look.
`speed` is one signed number whose sign is the direction (positive turns the loop clockwise on screen).
Every field is a length or a length per second, so `scaleLevelData` scales them all; a belt builds only on a `static` body that is not a mover, and fails the build anywhere else, as it does for a wheel inside the hull, a disc inside another or a zero thickness, naming the wheel.
A geometry object may carry a `belt` shape too: it draws the band as its own ring, with its `texture` scrolling at its own `speed` (the flat `color` fill keeps a ring of cleats instead; see [**Conveyor belts**](render3d.md#conveyor-belts)), and in the editor `+ Belt` draws the collision object and `Add geometry` gives it its matched twin, as for any shape.
There is no retired two-roller form: nothing committed ever used it, so it was replaced rather than folded.
`levels/belt-test.json` (`?level=TEST_BELT`) is the sandbox.

The canonical, hand-editable schema now lives in `src/level/levelFormat.ts` (superset of
the generated one — adds the `rigid` and `force` kinds, the `cameraRegions` and
`chains` lists, and bodies made of scene objects); `levelData.ts` stays
auto-generated and is structurally assignable to it. Both level drivers construct geometry
through the shared `src/level/buildBodies.ts` (statics, killzones, force areas,
water, finish lines and rigid bodies), so the grapple and ball controllers load identical scenes.
`rigid` bodies get mass/inertia from `ShapeGeometry` and fall under gravity.

## Regenerating level geometry

`levelData.ts` is generated from the prototype's Godot scene; do not hand-edit it:

```sh
bun scripts/extract-level.ts <path-to>.tscn src/level/levelData.ts
```
