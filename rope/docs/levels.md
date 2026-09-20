# Levels, the bell, and finishing one

The game is a set of levels rather than one arena.
`/` is the **level select**; `?level=ID` plays one.
Every listed level ends at a **bell**, and ringing it completes the level.

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
File-backed and ball-driven are both deliberate - the hand-written `TEST_*` specs are rigs with no file to hash and no bell to ring, and the grapple levels are a controller the completion flow has never been through.
Both stay reachable by `?level=`.

`cli levels` is the lint over all of it, and every failure it names is one that is silent in play: a listed level with no bell (or two), a bell that is not on a bearing, a bell with no toll rope, a bell that is in something's way, no introduction or two, and two levels the player cannot tell apart in the list.
It is pure and fast - no world is built and no frame is stepped - in the spirit of `cli assets`.

## The bell

A level ends at a bell, and ringing it is the level's win condition.

The assembly is three things:

- **The bell**: a `rigid` body with `pivot: true`, its bearing (`pivotX`/`pivotY`) at its yoke, a torsion return spring (`pivotFreq`, `pivotDamping`), and `bell: true`.
  Its collision shapes **pass everything** (`passes: ["player", "hook", "chain"]`): the body is in the world so the rope has something with inertia to pull on, and it is in the way of nothing, so the rope is the only handle.
  Without that a level is finished by rolling into the bell.
- **The toll rope**: a scene chain (`ChainData`) from an anchor **on the bell's rim**, not under its bearing.
  That is a bell WHEEL and it is the whole of why a straight pull rings it: a rope hanging directly below the bearing has no lever arm at all, so it can only be rung by swinging the rope about, which is not what hauling on a bell rope means.
- **The sally**: a free `rigid` body on the other end of that chain - the grip the player hooks and pulls down on.

### Sizing it

The bell is a **5.3 cm hand bell** (`MESH_ASSETS.bell`, `scale: 0.00015`), and that raises the one problem the assembly has to solve: a 5 cm casting weighs a couple of hundred grams, and a 52 kg ball hanging off its rope would whip it round and round for ever.

So the bell's **collision circle is its mass, not its outline**, and the mass knob is `thickness`.
The circle still MATCHES the bell (2.6 px, the bell's own radius), because an anchor is snapped to its body's surface - a circle bigger than the bell would hang the rope in mid-air beside it, which is exactly what a 10 px circle looked like.
`thickness` is what a piece's mass is computed from and is never read for the look (see `CollisionObjectData.thickness`), so 200 px through z on a 5 cm bell is invisible everywhere and is what buys the 48 kg that makes a pull **swing** the bell.

The numbers, measured on `levels/bell-test.json` as a fraction of the ball's own 511 N leaned on the rope:

| Pull | | Swing |
|---|---|---|
| the sally hanging on its own | 0 N | 0.018 rad |
| a tenth of the player's weight | 51 N | 0.158 |
| a fifth | 102 N | 0.270 |
| half | 256 N | 0.477 |
| the whole of it | 511 N | 0.557 |

`BELL_RING_ANGLE` sits at 0.25 in the middle of that: about a fifth of the player's weight rings it, and the rope hanging there for ever does not.

A **scene chain and a rigid sally**, rather than a vine.
A vine is the thing the hook grabs anywhere along its length, which reads like the better fit, and it is the wrong one twice over: a vine's load rope pulls on its anchor body only through the link that is held, and the anchor body a vine hangs from is not on the chain's path, so nothing keeps it awake - a sleeping body is not integrated, and the whole of a 500 N haul moved a bell hung on a vine 4e-4 rad.
(That is a real gap in the vine load rope rather than a fact about bells: `docs/vines.md` says the load rope loads the body it is anchored to "a pivot body included", and while that body is asleep it does not. Nothing in the tree hangs a vine from a rigid body, so nothing is red; it wants a fix and a `cli vines` case of its own.)
A scene chain holds both its bodies awake by construction (`SceneChain`), carries tension straight down the rope, and ends on a body the hook bites like any other.

`bell: true` is a flag on the body rather than a kind, for the reason `pivot` itself is one: a bell **is** a pivot body with a meaning.
It is written only on a body that still has a bearing (`toLevelData`), since the ring is measured as a swing about one, and the build refuses a second bell outright - a level with two is one an author has half-finished, and quietly ringing at whichever came first would leave the other inert with nothing to say so.

### The ring

`BallLevel` records the bell's rotation **after the build's settle** (`bellRest`), which is the angle the first frame of play opens on, and at the end of every `physicsProcess`:

```
if (completedFrame === null && |bell.globalRotation - bellRest| >= BELL_RING_ANGLE) completedFrame = frame;
```

`BELL_RING_ANGLE` is 0.25 rad, about 14 degrees, and it is one end of the margin the table above sets out rather than a number on its own.
It is an ANGLE - dimensionless, unscaled - so it crosses `scaleLevelData` the way `swingAmp` does.

Three properties hold it together:

- **A level with no bell runs none of it.** `bellBody` is null, the branch is not entered, and every recording of every level without a bell is bit-identical.
- **`Mathf.abs` is not a transcendental**, so nothing here reaches for a platform `Math` and `cli dmath` has nothing to find. The ring is a comparison on a rotation the sim already owns.
- **The ring is final.** `completedFrame` is written once and never clears; a reset builds a fresh level, which is what starts it over.

Its detectors ship with it: `WorldDigest.bell` carries the swing off rest and whether it has rung (written only on a level that has a bell, so every older bundle compares exactly as it did), `worldDigestDrift` treats absent-on-both as equal and absent-on-one as a different scene, and `bell-rung-once` is the invariant that the ring never moves and never un-fires - the one shape of bug a per-frame check cannot see.
`cli spring`'s `bell-ring` asserts the mechanism and both ends of the margin: a pull DOWN on the rope turns the bell and rings it once, the same rig with the rope cut never rings however long it is hauled on, and the rope hanging there on its own never rings it either.
It hauls the sally directly rather than throwing a scripted hook at it, because whether a pull on the rope rings the bell is a fact about the assembly and whether a player can land a hook on the sally is a fact about the arena - and only the first belongs in a unit case.

The arena's half is `playtests/bell-ring.json`, which plays the real level file through the real input stream - a throw at the sally and then the wind-up, which hauls the ball up the rope and the rope down with it - and asserts `ringsBy`.
And the BROWSER's half is `playtests/regressions/bell-ring-376f.json.gz`: the same run replayed through the page's own frame loop and exported with **P**, which rings on the same frame 77 and diverges from bun by nothing.
That last one is the rule in `rope/CLAUDE.md` being paid rather than a nicety - headless validation cannot see the browser.

### Finishing a level

On the ring the page (`main.ts`) lets the sim run `BELL_LINGER_FRAMES` (60) more steps on live input so the swing is seen, and then **stops stepping**.
Nothing reaches into the level: it carries on being exactly the level it was, so a P download taken afterwards replays and rings on the same frame, and the recorder's sealed run is the frames that were actually played.
Rendering carries on, so the bell is still swinging behind whatever is put over it.

The run is sealed with the end reason **`complete`**, which is its own reason because it is neither a failure nor an interruption - a run sealed as `reset` or `kill` would read as the player having failed at the thing they just did.
A reason has to land on `EndReason` (`playtest/protocol.ts`) and on `END_REASONS` (`server/store.ts`) **in the same deploy**: the store refuses one it does not know and the client goes dead on the first 400.

In the editor's ▶ Test a ring raises a toast and the test carries on.
A test is an authoring instrument - what is being judged there is the swing - and one that froze and asked for a rating would be answering a question nobody in the editor is asking.

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

It comes up from two places and says which: **Rung** from a bell that has just been rung, **Rate** from a completed row's `rate` link on the menu, where nothing was rung.
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
