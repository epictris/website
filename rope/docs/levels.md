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
- **The toll rope**: a scene chain (`ChainData`) from an anchor on the bell.
- **The sally**: a free `rigid` body on the other end of that chain - the grip the player hooks and hauls on.

A **scene chain and a rigid sally**, rather than a vine.
A vine is the thing the hook grabs anywhere along its length, which reads like the better fit, and it is the wrong one twice over: a vine's load rope pulls on its anchor body only through the link that is held, and the anchor body a vine hangs from is not on the chain's path, so nothing keeps it awake - a sleeping body is not integrated, and the whole of a haul moved a bell hung on a vine 4e-4 rad.
A scene chain holds both its bodies awake by construction (`SceneChain`), carries tension straight down the rope, and ends on a body the hook bites like any other.

`bell: true` is a flag on the body rather than a kind, for the reason `pivot` itself is one: a bell **is** a pivot body with a meaning.
It is written only on a body that still has a bearing (`toLevelData`), since the ring is measured as a swing about one, and the build refuses a second bell outright - a level with two is one an author has half-finished, and quietly ringing at whichever came first would leave the other inert with nothing to say so.

### The ring

`BallLevel` records the bell's rotation **after the build's settle** (`bellRest`), which is the angle the first frame of play opens on, and at the end of every `physicsProcess`:

```
if (completedFrame === null && |bell.globalRotation - bellRest| >= BELL_RING_ANGLE) completedFrame = frame;
```

`BELL_RING_ANGLE` is 0.35 rad, about 20 degrees: past the swing a hanging bell takes from being brushed, and inside what one haul on the rope buys.
It is an ANGLE - dimensionless, unscaled - so it crosses `scaleLevelData` the way `swingAmp` does.

Three properties hold it together:

- **A level with no bell runs none of it.** `bellBody` is null, the branch is not entered, and every recording of every level without a bell is bit-identical.
- **`Mathf.abs` is not a transcendental**, so nothing here reaches for a platform `Math` and `cli dmath` has nothing to find. The ring is a comparison on a rotation the sim already owns.
- **The ring is final.** `completedFrame` is written once and never clears; a reset builds a fresh level, which is what starts it over.

Its detectors ship with it: `WorldDigest.bell` carries the swing off rest and whether it has rung (written only on a level that has a bell, so every older bundle compares exactly as it did), `worldDigestDrift` treats absent-on-both as equal and absent-on-one as a different scene, and `bell-rung-once` is the invariant that the ring never moves and never un-fires - the one shape of bug a per-frame check cannot see.
`cli spring`'s `bell-ring` asserts the mechanism: a haul on the rope turns the bell and rings it once, and the same rig with the rope cut never rings however long it is hauled on.
It hauls the sally directly rather than throwing a scripted hook at it, because whether a pull on the rope rings the bell is a fact about the assembly and whether a player can land a hook on the sally is a fact about the arena - and only the first belongs in a unit case.

### Finishing a level

On the ring the page (`main.ts`) lets the sim run `BELL_LINGER_FRAMES` (60) more steps on live input so the swing is seen, and then **stops stepping**.
Nothing reaches into the level: it carries on being exactly the level it was, so a P download taken afterwards replays and rings on the same frame, and the recorder's sealed run is the frames that were actually played.
Rendering carries on, so the bell is still swinging behind whatever is put over it.

The run is sealed with the end reason **`complete`**, which is its own reason because it is neither a failure nor an interruption - a run sealed as `reset` or `kill` would read as the player having failed at the thing they just did.
A reason has to land on `EndReason` (`playtest/protocol.ts`) and on `END_REASONS` (`server/store.ts`) **in the same deploy**: the store refuses one it does not know and the client goes dead on the first 400.

In the editor's ▶ Test a ring raises a toast and the test carries on.
A test is an authoring instrument - what is being judged there is the swing - and one that froze and asked for a rating would be answering a question nobody in the editor is asking.

## The level hash

`levelFileHash` (`sim/treeStamp.ts`) is 12 hex over the bytes of one level file.
`srcHash` beside it cannot answer the same question: it moves when anything in the tree moves, so two ratings of an untouched level either side of a renderer edit carry different stamps and nothing says the level was the same.

It reaches the page as `virtual:level-hashes` (a Vite plugin, invalidated by the level API's own watcher since `levels/` is deliberately off Vite's), and is stamped into `SessionMeta.levelHash` so a run can be joined to the feedback about the same authored level.
