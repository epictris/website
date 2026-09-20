# Levels, the finish line, and finishing one

The game is a set of levels rather than one arena.
`/` is the **level select**; `?level=ID` plays one.
Every listed level ends at a **finish line**, and touching it completes the level.

## What a level says about itself

`LevelData.meta` (see `level/levelFormat.ts`) is the block the level select reads, and it is all a level says about itself as a level rather than as geometry:

| Field | Means |
|---|---|
| `title` | What the menu shows. Absent = the registry id. |
| `intro` | The one level shown first, above the rule. |
| `unlisted` | Off the menu; still played by `?level=`. |

Nothing in it is a length, so it crosses `scaleLevelData` whole, and every field is optional - a level that authors no block is a listed level named after its id, which is every level authored before the block existed.

The editor carries it through `EdModel.meta` and offers it as the **Level** panel.
That is not a convenience: the editor rewrites the whole file every 750 ms, so a block the model does not carry is a block **deleted** from disk the first time the level is opened, and nothing about that loss is visible in the editor.
It is the lesson `SpawnData.hang` and the `environment` block each paid for separately.

`listedLevels()` in `level/registry.ts` derives the menu's list: file-backed ball levels whose `meta` does not say `unlisted`, the intro first and then by title, case-insensitively.
File-backed and ball-driven are both deliberate - the hand-written `TEST_*` specs are rigs with no file to hash and no finish line to cross, and the grapple levels are a controller the completion flow has never been through.
Both stay reachable by `?level=`.

`cli levels` is the lint over all of it, and every failure it names is one that is silent in play: a listed level with no finish line, a finish body carrying only decoration and so building no region at all, a region too thin to catch a fast ball, no introduction or two, and two levels the player cannot tell apart in the list.
It is pure and fast - no world is built and no frame is stepped - in the spirit of `cli assets`.
The mechanic those files are checked against is stepped by `cli finish` instead.

## The finish line

A level ends at a finish line, and touching it is the level's win condition.

It is **one body**: `kind: "finish"`, with a collision object for the region the player crosses and a geometry object carrying the gantry that marks it.
A `finish` body builds an `Area2D` (`classes/finishLine.ts`), and the crossing is decided by the same overlap test in the same place as a killzone's (`World.notifyAreas`, an exact SAT test rather than a bounding circle).
It is the killzone's mirror: the same volume, entered, with the opposite meaning.

That is the whole mechanic, and the plainness is the point.
What it replaced (2026-09-20) was a **bell**: a pivot body on a torsion spring, a toll rope strung from its rim, and a sally on the end of that for the player to hook and haul down, rung by swinging it past a threshold angle.
It worked, and it was three authored bodies, a scene chain, a mass tuned through `thickness` and an angle with a measured margin either side of it - all of it standing between the player and "you have reached the end".
A line you touch needs none of it, reads from across the level, and cannot be arrived at and then missed.

### Authoring one

- The **region** is the piece the player crosses, and it is drawn across the way out: wide enough that a swing cannot miss it, and tall enough that a run along the ground and a run through the air both meet it.
  `cli levels` holds it to at least `MIN_FINISH_SPAN` (60 px) across its narrow axis.
  The crossing is an overlap test run once a frame and the ball travels 23 cm in a frame at the ~14 m/s a long hang reaches, so a line drawn as a *line* - a 2 px strip on the floor - is one a fast run passes clean through, and it looks perfectly right in the editor.
- The **gantry** is a geometry object on the same body: `mesh: "finish-line"`, a chequered arch whose origin sits on the ground between its posts, so the body is placed where the gate stands.
  It is 6.5 x 6.2 m in the file's own metres - a real gantry beside real people, and enormous beside a 24 cm ball - so a level states its own `scale`; the sandbox uses 0.4, a 2.6 m arch.
- Nothing about the region collides.
  An area is not a `PhysicsBody2D` at all, so the player, the hook and the chain pass through it with no mask to author and nothing to get wrong - which is what `cli finish`'s `finish-inert` holds to, bit for bit.

A level may carry **several**, and the first crossing is the one that counts: a course with two ways down ends at either of them.
(Two bells could not be allowed, because the second was inert with nothing to say so. Two lines are two ways to finish.)

`levels/finish-test.json` (`?level=FINISH_TEST`) is the sandbox: a floor, a beam to swing from, and the gantry at the end of it.

### The crossing

`FinishLine` reports the avatar entering, `BallLevel.finish()` takes it, and that is the arithmetic in full:

```
if (completedFrame === null) completedFrame = frame;
```

The frame it names is the one being stepped: `this.frame` is taken at the top of `physicsProcess`, and the areas are notified inside `World.integrate`.

Three properties hold it together:

- **A level with no finish line runs none of it.** There is no area, so nothing is entered, and every recording of every level without one is bit-identical.
- **There is no arithmetic to be non-deterministic about.** The overlap test is the one every area already runs, so nothing new reaches for a platform `Math` and `cli dmath` has nothing to find.
- **The crossing is final.** `completedFrame` is written once and never clears - which matters here in a way it did not for a bell, because a ball can leave a region it has entered and enter it again. A reset builds a fresh level, which is what starts it over.

Its detectors ship with it.
`WorldDigest.finished` carries whether the level has been finished, written only on a level that has a finish line, so every older bundle compares exactly as it did; `worldDigestDrift` treats absent-on-both as equal, absent-on-one as a different scene, and finished-in-one-run-only as a different run rather than a drifted one.
`finish-once` is the invariant that the crossing never moves and never un-fires - the one shape of bug a per-frame check cannot see.

`cli finish` (`sim/finishCases.ts`) steps the mechanic itself, on a rig whose floor is a **trampoline**, so the ball falls through the gate and is thrown back up through it:

| Case | Holds |
|---|---|
| `finish-crossed` | entering the region finishes the level, on the frame it is entered |
| `finish-once` | a second crossing does not re-date the finish, and the invariant stays silent |
| `finish-missed` | the same gate moved aside finishes nothing, however long the run |
| `finish-inert` | the ball's whole path is identical with and without the gate in the level |

The player's own half is `playtests/finish-roll.json`, which drives the ball along the ground into a gate through the real input stream and asserts `finishesBy`.

### Finishing a level

On the crossing the page (`main.ts`) lets the sim run `FINISH_LINGER_FRAMES` (30) more steps on live input, and then **stops stepping**.
The linger is what carries the ball out the far side: freezing on the frame it first touched the chequers stops it inside the gate, which reads as having been caught by it rather than as having gone through.

Nothing reaches into the level: it carries on being exactly the level it was, so a P download taken afterwards replays and finishes on the same frame, and the recorder's sealed run is the frames that were actually played.
Rendering carries on, so the level is still there behind whatever is put over it.

The run is sealed with the end reason **`complete`**, which is its own reason because it is neither a failure nor an interruption - a run sealed as `reset` or `kill` would read as the player having failed at the thing they just did.
A reason has to land on `EndReason` (`playtest/protocol.ts`) and on `END_REASONS` (`server/store.ts`) **in the same deploy**: the store refuses one it does not know and the client goes dead on the first 400.

In the editor's ▶ Test a crossing raises a toast and the test carries on.
A test is an authoring instrument - what is being judged there is where the line is and whether the run arrives at it - and one that froze and asked for a rating would be answering a question nobody in the editor is asking.

## The level select

`/` with no `?level=` and no `?replay=` is the menu, and a `?level=` nobody has is the menu with a line saying so - rather than silently playing something else, which is a mistyped or stale link nobody can debug.

**The menu page never loads the app.** It is markup in `index.html` painted by `render3d/store.ts`, which is compiled on its own and inlined ahead of the module graph (see [loading-screen](loading-screen.md)), and `index.html`'s module tag imports `main.ts` only when the store says there is something to play (`window.__ropePlay`).
A bare `/` must not download a megabyte of three.js and the whole level graph to show a list of six words.
That is also why the titles and the listing ride in the preload manifest (`t` and `k` per level) rather than being read out of `registry.ts`: the manifest is markup that already ships on every page.

Every row is an `<a href="/?level=ID">`, so middle-click, a bookmark and a screen reader all work, and picking a level is a **navigation**.
That is not a nicety: **one page load is one session and one level**.
The preload is keyed on `?level=`, the recorder's `SessionMeta` is fixed per page, a checkpoint is resolved once, and the level hash is stamped once - an in-page switch would quietly break every one of them.
Arrows move and Enter opens, which the anchors give for free once one of them has the focus; the first row takes it.

Per-level marks - completed, and the last rating as five glyphs - come from `rope.progress` in `localStorage` (`render/progress.ts`), never from the server.
It is a convenience rather than a record: the server already has the runs and the feedback, and a menu that cannot say what you have played until a fetch answers is a menu that flickers.
Every access is guarded, because storage throws outright in some privacy modes, comes back empty after a clear and is absent in a preview - and the menu has to paint correctly with no storage at all, the marks being the one thing on it that is not the offer.
Cross-device progress is a separate feature and is not this.

## The feedback form

`render/feedbackForm.ts`: five stars, a comment, **Submit** and **Skip**, over the frozen level or over the menu's own list.
Both fields are optional and that is the point rather than a convenience - a form that insists on a rating collects a rating from people who did not have one, which is worse than no answer.
Skip is a first-class outcome: the level was finished and nothing was said.
Esc is Skip, the first star takes the focus so the keyboard works without a click, and pressing the star that is already the rating clears it.

It comes up from two places and says which: **Finished** from a run that has just crossed the line, **Rate** from a completed row's `rate` link on the menu, where nothing was played.
A re-rating opens **pre-filled** from the last thing this player said about this level, since one that opened blank would read as the old one having been lost.

**Progress is written locally BEFORE the POST.** A dev page with no `serve.ts` beside it and a flaky network are the same case, and in both the level has still been finished: writing progress only on a successful send would lose the completion along with the rating.
The failure shows as a toast and is not retried - a rating is not a run, losing one is tolerable, and the player can rate again from the menu.

### What is kept

`POST /api/playtest/feedback`, under the existing `/api/playtest` prefix so the Vite proxy and the Caddy rules already cover it, and open for the reason ingest is open: the friends playing have a URL and nothing else.
It shares ingest's `pid` cookie exactly - the same `resolveOrMintPlayer`, the same response header - so a player's runs and their ratings are **one player**, whichever they do first, and the admin's rename, merge and delete reach both.

The store appends one JSON line to `<dir>/feedback.ndjson` and **never rewrites it**.
Nothing dedupes and nothing overwrites: a player who rates a level, plays it again and rates it differently leaves two lines, and what changed between them is the thing worth reading.
The two exceptions are both admin acts and both say so where they are - `deletePlayer` erases a player's ratings with their runs (a delete is meant to be a full erase, and a rating left behind is the one trace nothing else would show), and `mergePlayers` re-attributes them.

Every record carries the page's own claim about which tree and which level file it was played on **and the server's answer beside it** (`hereCommit`, `hereLevelHash`), so a client lying about either is visible rather than believed.

`/admin` gains a **feedback** tab: when, player, level, `v2 of 3`, stars, comment, commit and the level file, with a row whose tree or level file is not the one being served marked the way a run's commit is.
`cli pull` writes the same rows to `playtests/prod/feedback.ndjson` and prints them with their version counts.

## The level hash

`levelFileHash` (`sim/treeStamp.ts`) is 12 hex over the bytes of one level file.
`srcHash` beside it cannot answer the same question: it moves when anything in the tree moves, so two ratings of an untouched level either side of a renderer edit carry different stamps and nothing says the level was the same.

It reaches the page as `virtual:level-hashes` (a Vite plugin, invalidated by the level API's own watcher since `levels/` is deliberately off Vite's) and, for the level select, in the preload manifest beside the tree stamp - that page has no app to import a virtual module with.
It is stamped into `SessionMeta.levelHash` so a run can be joined to the feedback about the same authored level, and `serve.ts` computes the same table from `levels/` at startup so every record carries the server's own answer beside the page's claim.
