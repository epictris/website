# Levels, the bell, and feedback

> **SUPERSEDED IN PART, 2026-09-20.** This was built as written and then the bell
> was scrapped the same day (Tris): *"scrap the finish bell implementation -
> instead I want a much simpler finish where you just add a finish line and if
> the player collides with the finish line they finish the level"*.
>
> Everything else shipped and stands - the level select, `LevelData.meta`, the
> level hash, the completion flow, the `complete` end reason, the feedback form
> and its append-only store, the cross-tab clipboard. What changed is the TRIGGER:
> a `finish` body kind building an `Area2D` the player crosses, in place of a
> pivot bell on a toll rope with a threshold angle.
>
> What shipped is documented in [**Levels**](../docs/levels.md), which is the
> thing to read; the bell sections below are kept for the reasoning that led
> there, and for the measurements, which were real.

Written 2026-09-20 for an implementing agent.
It is a plan, not a spec of the finished thing: every number in it is a starting point to be played and then pinned, per the working practices in `rope/CLAUDE.md`.
Read the doc for each area before editing it (`docs/level-format.md`, `docs/editor.md`, `docs/editor-model.md`, `docs/production-recording.md`, `docs/loading-screen.md`, `docs/pivot-and-spring-bodies.md`, `docs/vines.md`, `docs/collision-layers.md`, `docs/asset-store.md`), and update it in the same change.

## What is being built

1. The game is a set of levels rather than one `BALL` arena.
   `/` opens a **level select screen**: the introduction level first, then every other listed level in alphabetical order of title.
2. Every listed level ends at a **bell**.
   Pulling on its toll rope (hooking the rope with the chain and hauling) swings the bell past a threshold, which rings it and completes the level.
3. On completion the sim freezes, a **feedback form** appears (1 to 5 stars and a comment, both optional), and submitting or skipping returns to the level select.
4. Feedback is stored **append-only** per level and player: every submission is a new version, none overwrites, and each carries the git commit, the tree hash and the level file hash it was played on.
   A player can re-rate from the level select (once they have completed the level) or by ringing the bell again; the form is pre-filled with their last submission.
5. The level select shows per-level status (completed, last rating) from `localStorage`.
6. The editor's **Ctrl+C / Ctrl+V** works across browser tabs and across levels through the system clipboard, so an assembly (the bell, say) built in one level can be pasted into another.

Decisions already taken with Tris (2026-09-20):

- `levels/ball.json` is the introduction level, with a bell added at its end.
  The sandboxes (`rail-test`, `mud-test`, `break-test`, `camera-test`) are **unlisted** and stay reachable by `?level=`.
- Ringing freezes the sim, shows the form, and the form leads back to the level select.
- Re-rating is offered both from the level select and by ringing again.
- Status on the menu comes from `localStorage`, not the server.

Assumptions (state them in the commit if they turn out wrong):

- "paste with Ctrl+B" in the request is a typo for **Ctrl+V**, which is what the editor already binds.
- The clipboard is the **system clipboard** (text), which is the only thing two tabs share without a server round trip.
- Sound for the bell is out of scope; the swing is the feedback.
  A ring sound is a follow-up.

## Ground truths that shape the design

These were read off the tree on 2026-09-20; verify them before leaning on any.

- **One page load is one session and one level.** `main.ts` resolves `?level=` once, the inline store in `index.html` preloads that level's assets at first paint keyed by the same parameter, the recorder's `SessionMeta.level` is fixed per session, and a checkpoint is resolved once per page.
  Navigating to `/?level=ID` for a chosen level keeps every one of those invariants; an in-page level switch would break all of them.
  So the level select is a **page state of `/` with no `?level=`**, and picking a level is a navigation.
- **The recorder ends a run with a reason** (`EndReason` in `src/playtest/protocol.ts`), and the store refuses a reason it does not know (`END_REASONS` in `src/server/store.ts`).
  A new reason `complete` has to land on both ends in the same deploy; the client goes dead on the first 400 otherwise.
- **`Recording.level` names the level, never embeds it**, and `srcHash` already hashes `levels/*.json`.
  The level file hash the feedback needs is a narrower stamp of one file, computed the way `sourceHash` is: once, in `src/sim/treeStamp.ts`, used by the Vite plugin, the CLI and `serve.ts`.
- **Player identity is the `pid` cookie**, HttpOnly, set by the ingest route from `resolveOrMintPlayer`.
  Feedback attribution must go through the same function so a player's runs and their ratings share an id, and the admin's rename/merge/delete keep working for both.
- **A vine is the thing the hook grabs anywhere along its length**, and its load rope loads the body it is anchored to, a pivot body included (`docs/vines.md`, "The load rope").
  A scene chain is a constraint between two anchors and the hook never grabs it.
  The toll rope is therefore a **vine**.
- **A pivot body with an authored bearing and a torsion spring** (`pivot`, `pivotX/pivotY`, `pivotFreq`, `pivotDamping`) swings about the bearing under a load and returns (`docs/pivot-and-spring-bodies.md`).
  The bell is that: a rigid body hinged at its yoke.
- **Per-shape masks** (`CollisionObjectData.passes`) let a shape stand out of the way of the player, the hook and the chain while the body still exists in the world for a vine anchor to load (`docs/collision-layers.md`).
- **The editor writes the whole file back**, so any new top-level field must be carried through `EdModel` or the first autosave deletes it (`docs/level-format.md`, the `hang` and `environment` precedents).
- **The editor's clipboard is in-memory** (`clipboard`, `clipboardChains`, `clipboardVines` in `src/editor/editor.ts` around line 7124), and Ctrl+C/Ctrl+V are handled in the keydown switch (around line 8877) which `preventDefault`s them.
  A `paste` DOM event does not fire when keydown has cancelled the key, so the handler has to move.
  `cloneBodies` (around line 6200) already remints item ids, body ids and **anchor ids**; anchor ids are content in the file, so a paste into another level must remint them or two chains end up naming one anchor.
- **The sim never calls platform `Math`**, `cli dmath` scans for it, and bit-identity is the contract.
  The ring check is a comparison on a rotation the sim already owns; it must add no arithmetic to any level without a bell.
- **Regression bundles embed their level** (memory: session-2504f), so editing `ball.json` does not diverge the committed corpus.
  Scratch bundles in `playtests/bundles/` recorded on the old `ball.json` will.
- The bell GLB (`~/Downloads/bell.glb`) is Sketchfab, 3,553 triangles, one material with base, normal and metallic-roughness PNGs at 1k (1.5 MB and 0.9 MB), bbox y from 112 to 462 in the file's units and x from -166 to 166.
  The origin is off the geometry (the bell starts 112 units above it), so it wants `--center`, and the units are almost certainly centimetres and want a `scale`.
  Licence **CC BY 4.0**, author **jQueary**, source `https://sketchfab.com/3d-models/bell-897bc8230df54a1cad474492771880d8`.
- Production recording is not yet deployed (memory: needs `ROPE_ADMIN_HASH` secret, `OCI_OS_NAMESPACE` var, `terraform apply`).
  Everything server-side here can be built and tested against a local `bun run serve.ts`, and the deploy is a separate step.
- Tris's dev server is on 3100 with `/editor` possibly open on `ball.json`.
  **Never** `git checkout` a level file and never kill vite; close the editor tab before any script writes a level (`rope/CLAUDE.md`).

## Phase 1: the level format learns about levels

Goal: a level says what it is called, whether it is listed, whether it is the introduction, and which body is its bell.
Nothing plays differently yet.

### `LevelData.meta`

Add to `src/level/levelFormat.ts`:

```ts
export interface LevelMetaData {
  // What the level select shows. Absent = the file name.
  title?: string;
  // The one level shown first. Exactly one listed level may set it.
  intro?: boolean;
  // Off the level select; still playable by ?level=. Sandboxes set it.
  unlisted?: boolean;
}
// on LevelData and RawLevelData:
meta?: LevelMetaData;
```

`scaleLevelData` passes it through untouched (nothing in it is a length).
`EdModel` carries it (`meta: LevelMetaData`), `modelFromDisk` reads it, `modelToDisk` writes it, and the editor's toolbar gets a small **Level** panel with `title`, `intro` and `unlisted` so the fields are authored rather than hand-edited.
Add the round trip to `cli render3d`'s format cases, which is what holds every level field to its list.

### The bell flag

On `LevelBodyData`:

```ts
// This body is the level's end bell. Its swing past BELL_RING_ANGLE from
// its settled angle completes the level. At most one per level.
bell?: boolean;
```

Passes through `scaleLevelData`, carried by `EdItem`/`EdModel`, authored as a `bell` checkbox on the rigid body's panel next to `pivot`, refused (greyed) unless the body is a pivot rigid body.
The editor marks it on the canvas the way `pivot` is marked, so it is visible without selecting.

### The level hash

In `src/sim/treeStamp.ts`, beside `sourceHash`:

```ts
// 12 hex over the bytes of one level file, so feedback says which authored
// level it is about, independently of the rest of the tree.
export function levelFileHash(root: string, file: string): string
```

- `vite.config.ts`: a `virtual:level-hashes` module (same lazy-cache-and-invalidate shape as `treeStampPlugin`, and invalidated by the level API's own watcher since Vite's watcher ignores `levels/`) exporting `Record<levelId, hash>` for every file-backed level.
  `main.ts` imports it and stamps the page's level.
- `serve.ts` computes the same table at startup from `levels/` (the runner image ships `levels/`) and stamps it into every feedback record as `hereLevelHash`, so a client lying about its hash is visible.
- The CLI prints it in `cli pull` output for feedback rows.

Add `levelHash` to `SessionMeta` too (optional string, validated like `checkpoint`), so a run row can be joined to the feedback about the same level file.
`validateMeta` accepts absent for every page from before the field.

### The registry

`src/level/registry.ts` keeps its explicit imports (it is imported by the Vite config and by the CLI under bun, where `import.meta.glob` does not exist).
Add one derived export:

```ts
export interface ListedLevel { id: string; title: string; intro: boolean }
// The level select's list: file-backed ball levels whose meta does not say
// unlisted; the intro first, then by title, case-insensitive.
export function listedLevels(): ListedLevel[]
```

Set `meta.unlisted: true` in the four sandbox files and `meta: { title: "Introduction", intro: true }` in `ball.json`.
`levels/polygon-test.json` and `levels/chain-group-test.json` are not in the registry and stay that way.

`cli levels` (new subcommand, in `bun run test`) asserts: every listed level has exactly one `bell` body, that body is a pivot rigid body, exactly one vine is anchored to it, its collision shapes pass every category, exactly one listed level is `intro`, and no two listed titles collide.
It is a level-file lint, pure and fast, in the spirit of `cli assets`.

## Phase 2: the bell asset

Follow `docs/asset-store.md` to the letter; the loop is written out at its end.

1. `cp ~/Downloads/bell.glb assets-src/bell.glb`.
2. `bun run assets:optimize assets-src/bell.glb public/meshes/bell.glb --center`.
   No `--simplify`: 3.5k triangles is already a prop's count.
   Check the printed output and `bunx gltf-transform inspect public/meshes/bell.glb`: textures should come out WebP at 1k, geometry meshopt.
3. Measure it with the prop preview harness (memory: `reference_prop_preview_harness`, `loadMesh` plus a `__ropeStore` shim plus `shotRunner.grab`) and read its extent.
   If it is 3.5 m tall the file is in centimetres and the entry gets `scale: 0.01`, giving a 35 cm bell; a hand bell is small, so a `scale` between 0.01 and 0.03 is the range to look at against the 0.5 m avatar, and the number is a level-design choice to be played.
4. `bun run assets:publish public/meshes/bell.glb`, paste the printed `MESH_ASSETS` entry into `src/render3d/assets.ts` with `center: true`, `source`, `author: "jQueary"`, `license: "CC BY 4.0"`, and a comment noting it is a rusty bell, single material, and what the measured extent was.
5. `bun run assets:credits`, then `bun run replay assets` must be green.
6. Verify the material lights correctly in a live browser (memory: headless cannot see shader errors), with `wakeEmission` irrelevant (no emission map).

## Phase 3: the bell mechanic

### The assembly, in the level file

Authored in the editor, then copied into every level with the Phase 6 clipboard.
One rigid body:

- `kind: "rigid"`, `pivot: true`, `pivotX/pivotY` at the yoke (top of the bell), `pivotFreq` around 0.6 Hz and `pivotDamping` around 0.25 to start (a bell swings slowly and rings a while).
  Material bronze-ish density is not in the material table; use `iron` or whatever gives a mass of a few kilograms at the chosen scale.
- One collision object approximating the bell (a circle or a short polygon) with `passes: ["player", "hook", "chain"]`.
  The bell body exists in the world (the vine's load rope needs a body with inertia), but nothing touches it: the player rolls through it, the hook cannot bite it, the chain cannot wrap it.
  The rope is the only handle.
- One geometry object `kind: "mesh"`, `mesh: "bell"`, placed so the mesh's yoke sits on the bearing.
- One anchor object at the clapper, **directly below the bearing** at rest, so the vine's own weight puts no torque on the bell and the settled angle equals the authored angle.
- `bell: true`.

One vine (`VineData`): `anchor` on that body, `length` around 2.5 m so the end hangs where a ball on the ground can throw the chain at it, default spacing, `stiffness` 0, `viscosity` low (0.3) so a ring threaded on it does not slide off before the haul takes.
It is drawn by the vine renderer as it is; a distinct rope colour is a follow-up.

Place the assembly at the end of `ball.json` (Tris chooses where; the plan does not) and adjust the camera path's end so the bell is framed.

### The ring, in the sim

In `src/level/ballLevel.ts`:

```ts
// The frame the bell rang, once, or null. Sim state: it is read by the page,
// digested, and asserted by the invariants, and it never goes back to null.
completedFrame: number | null = null;
// Rotation of the bell body at build, after the settle, which is the angle a
// ring is measured from. Null on a level with no bell.
private bellRest: number | null;
```

- After build (after `settleChainsAtBuild`), find the `BuiltBody` whose `data.bell` is set, keep its `RigidBody2D`, and record `bellRest = body.globalRotation`.
  Two bells is a build error (throw, and `cli levels` catches it earlier).
- At the end of `physicsProcess`, on every frame while `completedFrame === null` and a bell exists: `if (Math.abs(bell.globalRotation - bellRest) >= BELL_RING_ANGLE) completedFrame = this.frame` (`Math.abs` is not a transcendental and the sim already uses it; `cli dmath` will say if anything else slips in).
  `BELL_RING_ANGLE` is a constant in `ballLevel.ts` (start at 0.35 rad, about 20 degrees; classify it: an angle, dimensionless, unscaled).
  A level with no bell runs no arithmetic here, so every recording without a bell is bit-identical.
- A reset (`onReset`) builds a new level, so `completedFrame` is fresh by construction.

Detectors, in the same change, before playtesting:

- `WorldDigest` gains an optional `bell?: { rot: number; rung: boolean }` beside `chain`, written only when the level has a bell, and `worldDigestDrift` treats absent-on-both as equal and absent-on-one as a different scene (the rule it already applies to `chain`).
  Older bundles carry no field and compare as before.
- `checkInvariants` gains `bell-rung-once`: `completedFrame` never clears and never decreases across a run.
- `cli spring` (the pivot suite) gains `bell-ring`: a rig with the bell assembly and a static floor, a scripted ball that hooks the vine and winds; assert the bell turns, the ring fires once, at a frame within a window, and that the same rig with the vine cut never rings.
  Write the assertion numbers **after** the mechanic has been played and the angle and spring settled (`rope/CLAUDE.md`, "Validate the behaviour before writing the cases").
- A playtest script `playtests/bell-ring.json` on `ball.json` from a `?checkpoint=` near the bell, so `bun run test` plays the real level's bell.

### The page

In `src/main.ts`:

- After each step, if `level instanceof BallLevel` and `level.completedFrame !== null` and the completion has not been handled: let the sim run `BELL_LINGER_FRAMES` (60) more steps on live input so the swing is seen, then stop stepping (a flag the frame loop checks before the accumulator loop), call `recorder?.endRun("complete")`, release the pointer lock (`document.exitPointerLock`), restore the page cursor, and show the form (Phase 5).
  Rendering continues so the scene stays on screen behind the form.
- `EndReason` gains `complete` in `protocol.ts`; `END_REASONS` in `store.ts` gains it; `admin.html` renders it.
  `cli playtest` gets a case that seals a `complete` run.
- Nothing about the run's frames changes, so the bundle a P press downloads after a ring replays and rings on the same frame; add this to the `bell-ring` case as a replay leg.
- In the editor's ▶ Test, a ring shows a toast (`bell rung at frame N`) and the test carries on; no form there.

Record a browser bundle of a real ring and run `cli diverge` on it before calling the mechanic done.

## Phase 4: the level select

### Markup and first paint

`index.html` gains a `#menu` block beside `#loading`, hidden by default, in the same terminal idiom as the loading screen (the `#1f2430` page, `#cbccc6` text, monospace, hairline borders, square corners, the `#65bddb` accent for the intro title and the focused row).
Rows: title, a `completed` mark, the last rating as five glyphs when rated.
The intro row first with a rule under it, then the rest.
Keyboard: arrows move, Enter opens; each row is an `<a href="/?level=ID">` so middle-click and a screen reader both work.
Touch is a tap.
No gamepad on the menu for now; note it as a follow-up.

The inline store (`src/render3d/store.ts`) already parses `?level=` and picks the default when it is absent.
Change the rule: **no `?level=` and no `?replay=` means the menu**: reveal `#menu`, hide `#loading`, and preload nothing.
The preload manifest (`storeScript` in `vite.config.ts`) gains per level `t` (title) and `k` (0 unlisted, 1 listed, 2 intro), so the inline script can build the rows without the app.
It also reads `localStorage["rope.progress"]` (see below) for the marks; wrap in try/catch, and the menu must render with no storage at all.

### Not loading the game on the menu

`index.html`'s module tag becomes a two-line inline module that dynamically imports `/src/main.ts` only when a level or a replay is asked for, so the menu page fetches none of three.js.
Vite bundles the dynamic import as its own chunk; check `dist/` after a build that `index.html` no longer references the shared chunk statically.
If the dynamic import fights Vite's HTML handling, the fallback is a tiny `src/entry.ts` static module that does the same `import()`.

`main.ts` keeps the `DEFAULT_LEVEL` fallback only for `cli shot`/`shot.html`, which have their own entry; on `index.html` an unknown `?level=` shows the menu with a one-line notice rather than silently playing `BALL`.

### Progress in `localStorage`

Key `rope.progress`, value `Record<levelId, { completedAt: number; stars: number | null; comment: string | null; submittedAt: number | null }>`.
Written by the completion flow (Phase 5) and read by the menu and by the pre-filled form.
Every read and write in try/catch.

### The rate affordance

Each completed row carries a `rate` link that opens the same form (Phase 5) in the menu page, pre-filled from progress, and posts with no session or run.
That means the form module has to run without the game loaded; keep it dependency-free of `main.ts` (a small `src/render/feedbackForm.ts` that both pages import).

## Phase 5: the feedback form and its store

### The form

`#complete` markup in `index.html` (hidden), same idiom: a heading naming the level, five star buttons (toggle, none selected by default), a `textarea` (limit 2000), **Submit** and **Skip**, Esc = Skip.
`src/render/feedbackForm.ts` exports `showFeedbackForm(opts): Promise<void>` where `opts` carries the level id, the pre-fill, and a `submit(payload)` callback; it resolves when the form is dismissed either way.
It focuses the first star so Enter and Space work, and it never takes the pointer lock.

On the game page, after the form resolves, `location.href = "/"`.
On the menu page, the form closes and the row re-renders.
Submit writes progress locally **before** the POST, so a failed POST (dev without `serve.ts`, a flaky network) still records completion; the POST failure shows a toast and is not retried (a rating is not a run; losing one is tolerable and the player can re-rate).

### The wire

`POST /api/playtest/feedback` (under the existing `/api/playtest` prefix so the Vite proxy and the Caddy rules already cover it; the ingest path stays open, only `admin/*` is behind the password).
Body:

```ts
interface FeedbackSubmission {
  level: string;          // registry id
  levelHash: string;      // from virtual:level-hashes
  commit: string; dirty: boolean; srcHash: string;   // the tree stamp
  stars: 1 | 2 | 3 | 4 | 5 | null;
  comment: string | null; // trimmed, <= 2000 chars
  session?: string;       // the recorder's session id when submitted from a ring
  run?: number;           // ...and the run that rang
  completedFrame?: number;
}
```

The server appends one line to `<dir>/feedback.ndjson`:

```ts
interface FeedbackRecord extends FeedbackSubmission {
  id: string;             // uuid
  player: string;         // pid, resolved or minted exactly as ingest does
  ip: string;
  at: number;             // server clock
  hereCommit: string;     // what the server serves
  hereLevelHash: string;  // the server's hash of levels/<file>.json
}
```

Rules: never rewrite the file, never dedupe, never overwrite; a second submission for the same level and player is a second line.
Validation mirrors `validateMeta` (a `Refusal` per bad field, 400).
Rate limit per address like new sessions (`NEW_SESSIONS_PER_IP_PER_HOUR` style, say 60 an hour).
The response sets the `pid` cookie the way ingest does, so a player who rates before their first batch lands still gets one identity.
Move `resolveOrMintPlayer` and the cookie header building into shared helpers rather than copying them.

### Reading it back

- `GET /api/playtest/admin/feedback` returns every record newest first, plus `players` so the page can show names.
- `admin.html` gains a **Feedback** tab: level, player (name or id, with the same rename affordance), stars, comment, at, commit, levelHash, and a `v3 of 3` style version count per level and player, latest first.
  A row's commit and levelHash that differ from `here` are marked, the way runs are.
- `cli pull` also downloads `feedback.ndjson` into `playtests/prod/`, and `cli playtest` gains cases: append-only across two submissions, attribution by cookie, cookie minted on first contact, every refusal, and the admin listing's version counts.
- `deletePlayer` removes the player's feedback lines too (rewrite the file once, atomically, through `writeAtomic`), since the admin's delete is meant to be a full erase; `mergePlayers` re-attributes them.
  These are the only two rewrites of the file, and both are admin acts.

## Phase 6: cross-tab copy and paste in the editor

### Shape of the payload

The clipboard is text, and its text is the level format:

```json
{ "rope-clipboard": 1, "bodies": [...], "chains": [...], "vines": [...], "cameraRegions": [...], "notes": [...], "checkpoints": [...] }
```

Everything in it is in **on-disk pixel form**, produced by `toLevelData` on a sub-model that holds exactly the operand items (`operandItems()`, whole bodies), the chains whose both ends are among them, the vines whose anchor is, and the `bodyFrames` of the bodies involved.
That is the same serialisation a save performs, so it is lossless by the round-trip cases, and it is the same shape a level file has, so a payload can also be pasted from a text editor.

### Copy

Move Ctrl+C out of the keydown switch and into a `copy` listener on `document`:

- Guard: no text field focused (the same test the keydown handler uses), a non-empty selection.
- `e.clipboardData.setData("text/plain", JSON.stringify(payload))`, `e.preventDefault()`.
- Keep an in-memory copy of the same payload string as a fallback for a browser that refuses the clipboard, and for the case where the system clipboard has since been overwritten by something that is not a payload.

The `copy` event fires on Ctrl+C when nothing cancels the key, which is why the keydown case has to go.
`Ctrl+D` (duplicate) is untouched.

### Paste

A `paste` listener on `document`, same guard:

- Read `text/plain`; if it parses and carries `"rope-clipboard": 1`, use it, else fall back to the in-memory payload, else do nothing.
- `modelFromDisk({ player: <dummy>, ...payload })` gives `EdItem`s with page-fresh ids (`nextId`), then run the existing `cloneBodies(items, delta)` plus `cloneChainsWithin` / `cloneVinesWithin` over them, which remints body ids and **anchor ids** against the target model, re-centres on the cursor, snaps, reveals and unlocks layers, and honours `pasteHostBody` exactly as today.
  `beginAction()` first so one Ctrl+Z removes the paste.
- Texture names, mesh keys and material names travel as strings and resolve in the target level as they do at load; an unknown one draws the placeholder, which is the existing behaviour for a hand-edited file.

Retire the three in-memory arrays (`clipboard`, `clipboardChains`, `clipboardVines`) in favour of the one payload string, so in-tab and cross-tab paste are one path.

### Cases and docs

- `cli render3d` gains `clipboard-round-trip`: copy a body with a chain, a vine, a matched geometry object and a wrap point into a payload; paste into a model that already holds anchors with the same ids; assert the pasted anchors got new ids, the chain and vine name them, the placements match the source offset by the delta, and the saved bytes of the pasted body equal the source's modulo ids and position.
- Drive it in a real browser too (memory: `reference_editor_cdp_harness`): two tabs, copy in one, paste in the other, screenshot.
  Note that a headless Chromium must be launched display-less so it does not steal Tris's pointer (memory: `feedback_no_heavy_load_while_playtesting`).
- `docs/editor.md`'s clipboard paragraph (around line 85) is rewritten for the system clipboard and the payload format.

## Phase 7: docs, map, credits

- New `docs/levels.md`: the level select, `meta`, listing rules, the bell assembly and how to add one to a level (paste it), the ring rule and its constants, the completion flow, the feedback record and where it lives, the level hash.
  Add it to the map in `rope/CLAUDE.md` under a new "Levels" heading, and add one line to the Running section: `/` is the level select, `?level=` plays one.
- `docs/level-format.md`: `meta` and `bell`.
- `docs/production-recording.md`: feedback, the `complete` reason, `cli pull` pulling feedback.
- `docs/running.md`: the menu, the form, the `complete` end.
- `docs/editor.md` and `docs/editor-model.md`: the Level panel, the bell checkbox, the clipboard.
- `CREDITS.md` regenerated.
- `plans/playtest-recording.md`: a short note pointing at `docs/levels.md` for feedback.

## Order of work and what each step must show

1. Phase 1 (format, registry, hash, `cli levels`).
   `bun run test` green; the sandboxes carry `unlisted`; `ball.json` carries `meta` and reopens and autosaves byte-stable in the editor.
2. Phase 2 (asset).
   `cli assets` green, the bell renders in the prop harness and in a live browser.
3. Phase 3 (mechanic) in the editor first: build the assembly in a scratch level, ▶ Test it, feel the swing and the ring, and only then pin `BELL_RING_ANGLE`, the spring numbers and the case assertions.
   Then place it in `ball.json`, record a browser bundle of a ring, `cli diverge` it, `bun run test` green.
4. Phase 6 (clipboard) can go before or after 3; it is independent, and it is what makes step 5 cheap.
5. Phase 4 and 5 together (menu, form, store): local `bun run serve.ts` beside the dev server, `?record=1`, ring the bell, submit twice, see two lines in `.playtests/feedback.ndjson`, both on the admin page, the second pre-filled from the first, the menu showing the mark.
   Do the same from the menu's `rate` link.
   Headless screenshots of the menu and the form at phone width and at 1080p; be picky about the pixels (both are the site's own idiom).
6. Phase 7 docs, then the deploy prerequisites from `project_playtest_recording` memory, which are outside this plan.

Commit per phase, not per file.
Do not commit `ball.json` changes that are not the bell (it is already modified in the working tree; look at the diff before staging).

## What green cannot see

Name these in the final report:

- The bell's feel (spring, damping, angle, vine length, viscosity): needs Tris's play.
- Shader and material correctness of the bell mesh: live browser only.
- The menu and form on a real phone (touch, `viewport-fit=cover`, the installed PWA's fullscreen).
- The pointer-lock release and cursor restore at the form on a real mouse under Wayland (memory: `project_input_trace_permanent`).
- The `pid` cookie behaviour over HTTPS behind Caddy: only production shows it.

## Out of scope, noted for later

- A ring sound and any particle on the bell.
- Gamepad navigation of the menu.
- A per-level best time or attempt count on the menu.
- Server-side progress (cross-device status).
- A distinct look for the toll rope.
