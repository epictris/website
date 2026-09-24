# Plan: rock debugging tooling

Written 2026-09-24 after a night of chasing holes in the generated rocks (see [docs/rocks.md](../docs/rocks.md)).
This plan says what to build so that the next report of "there is a hole here" is answered in one build instead of five, and it is written so that it can be implemented without re-deriving the reasons.
It is the rock counterpart of [render-debug-tooling.md](render-debug-tooling.md), which made the renderer evidencable; this makes the generated mesh evidencable.

## Why

Five distinct defects were reported on body 150 in one evening, and every one took a different throwaway probe to attribute:

| Report | Actual cause | Step that caused it | How it was found |
|---|---|---|---|
| "weirdly angled tops" | the warped 2x2 cap grid folded each column end into a crown | shard template | reading the template code |
| "a hole in the top face" (first) | 3 of 275 shards came out of the float boolean wound inside out; the back-face cull then removed their FRONT faces | boolean clip + cull | a signed-volume scan over the chunks |
| "a hole in the top face" (second) | 8 of 275 shards came out of the float boolean with triangles missing | boolean clip | an edge-count scan over the chunks |
| "weird artifacts", sky-coloured triangles | the buried-face pass deleted faces that the detail noise then moved out from under their cover | buried pass + sculpt | an A/B against a patched copy of the script |
| "pixellated ambient occlusion patterns" | coincident coplanar cut faces of overlapping shards z-fighting along the rim | boolean clip | recognising the pattern by eye |

Three things made each of these slow.

**The defect could not be attributed from the picture.**
A hole on screen is a missing face, and a face can go missing in the template, the clip, the buried pass, the cull, the decimation or the export.
Nothing in the mesh said which step last touched a face, so each attribution was a fresh instrumented copy of `rocks.py`, patched with `sed` into the scratchpad.

**The viewpoint could not be reproduced.**
Reports arrived as a cropped screenshot and a position in words ("roughly a metre to the bottom left of the spawn").
`cli shot` takes `--at` and `--orbit`, so every reproduction was a guess at the camera, and the last hole was never reproduced at all.

**The file on screen was not known.**
The level file was rebuilt six times in two hours.
At least one report was almost certainly against a file the browser had cached from before the fix, and there was no way to tell, because the page logs the mount count and nothing about the bytes it mounted.

The two boolean failures are the sharpest lesson.
Both are cheap to detect at build time (a closed solid has every edge on exactly two triangles and a positive signed volume), both were detected by a scratch script within minutes of being suspected, and both shipped in every build for hours because nothing checked.
A check that runs on every build would have refused the file before anyone looked at it.

## Ground rules

- Every check runs where the failure is created, in the generator, and again on the file the game loads, because the two can disagree (the export and the decimation sit between them).
- Every debug view shows one thing and paints it in a colour nothing else uses, so a screenshot of it is evidence without interpretation.
- Every capture is a JSON blob that round-trips into a CLI command, so a report can be replayed headlessly with the same camera and the same file.
- Nothing here changes the shipped look: debug attributes are stripped by a flag on the shipping build, and debug views are behind `?rockdebug=`.
- Names, keys and flags below are the proposal; the implementer keeps them unless there is a reason to change them, and records the change in `docs/rocks.md`.

## Phase 5: capture the view and stamp the file

This is first because it is the cheapest and it makes every later report reproducible.

### The rock file stamps itself

`rockMesh.ts` fetches `/rocks/<level>.glb` and logs `[rocks] ball: 57 mounted`.
It will log the file's size and a short content hash as well, and the same line will be written into the page's `window.__rocks` object for the capture below.

- In `loadLevelRocks`, read the response as an `ArrayBuffer` first, hash it (FNV-1a over the bytes is enough, the aim is identity not security; `rockHash` in `rocks.ts` already has the loop), then hand the buffer to `GLTFLoader.parse`.
- Log `[rocks] ball: 57 mounted, file 60175184 bytes, id 3f9a1c2e`.
- Have the generator print the same id at the end of a build (`bun` can hash the written file in the wrapper, `scripts/generate-rocks.ts`, after Blender exits), so the build log and the page log carry the same number.
- In dev, defeat the browser cache: append `?v=<Date.now()>` to the rocks URL when `import.meta.env.DEV`, or fetch with `cache: "no-store"` since the loader now fetches the buffer itself.
  The stale-file confusion this evening was avoidable at this line.

### The camera capture

A hotkey (**F4**, beside F3's perf HUD in `main.ts`) writes one JSON object to the console and to the clipboard:

```json
{ "level": "ball", "at": [49.31, -3.05], "orbit": [0, 12], "zoom": 4,
  "rocks": "ball", "rocksId": "3f9a1c2e", "hash": { "150": "804ea32d" }, "tree": "82f5b1e" }
```

- `at` is the sim-metre point the camera looks at, `orbit` the yaw and pitch, `zoom` the zoom, all in the units `cli shot` already takes.
  The camera controller owns these numbers; the capture reads them, it does not compute anything.
- `rocks` and `rocksId` are the loaded file's name and stamp from above.
- `hash` is `rockHash` for the bodies currently in view (or all rock bodies, it is small), so a capture says which bodies were mounted and which were stale.
- `tree` is the served tree's stamp, which the bundle already records.
- The clipboard write uses the same path the editor's copy uses (see `docs/editor.md`, clipboard); in a pointer-locked fullscreen game the clipboard API may refuse, so the console line is the fallback and the HUD says "view copied" or "view logged".

`cli shot` gains `--view capture.json`, which sets `--at`, `--orbit`, `--zoom` and `--query rocks=<name>` from the capture and refuses if the file it loads has a different `rocksId` than the capture, unless `--allow-stale-rocks`.
`docs/headless-tooling.md` gets the flag, `docs/rocks.md` gets a "Reporting a defect" paragraph: press F4, paste the JSON, attach the screenshot.

Effort: half a day.
Risk: the camera controller's internal state may not be the `--at`/`--orbit` pair directly; the shot runner already maps those into the controller (`shotMain.ts`), so the capture inverts that mapping and nothing else.

## Phase 4: `cli rocks-check`

A check of a rock file that runs after every build and can be run by hand on any GLB.
It prints one line per body and exits non-zero on anything it calls a defect.

### Two halves, two runtimes

The geometric checks need a BVH and Blender already has one (`mathutils.bvhtree`), so they live in `tools/blender/check.py`, run by `cli rocks-check <glb>` the same way `generate-rocks.ts` runs `rocks.py`, and report as JSON on stdout.
The file-level checks are plain buffer reading and live in bun, in the same CLI command, so a missing attribute or a hash mismatch is reported without starting Blender.

### File-level checks (bun)

- Every `body-<i>` node carries `rockIndex` and `rockHash` extras, and `rockHash` equals `rockBodies(level)[i].hash` for the level named in the file (the wrapper writes the level name into the asset extras; add it if it does not).
  A mismatch is "stale", reported per body, not a failure, because a stale body is a normal state the runtime handles.
- Every primitive has `POSITION`, `NORMAL`, `TEXCOORD_0`, `TEXCOORD_1`, `COLOR_0`, and its material has an `occlusionTexture` on texCoord 1.
- `TEXCOORD_0` spans more than one unit (it is world metres; the level build once shipped it collapsed to 0..1 because the unwrap ran over the previous body) and `TEXCOORD_1` stays within 0..1.
- `COLOR_0` reads as masks: the r channel has values near 1 (open faces exist) and near 0 does not dominate.
- Triangle count and byte size per body, against a soft budget printed as a warning.

### Geometric checks (Blender)

Per body, after importing the GLB:

- **Back-face scan.** From four cameras (head-on at the body's centre and 6 m out, raised 30 degrees, and 30 degrees to each side), cast a ray grid at 2 cm spacing over the body's silhouette and flag every ray whose first hit is a back face (`normal . dir > 0.05`).
  Cluster the hits to 25 cm cells and report count and cell centres.
  This is the definition of "looking into a hole" and it is the check that would have caught both boolean failures.
- **Coincident coplanar faces.** Bucket faces by plane (normal quantised to 1 degree, offset to 1 mm), and within a bucket test face pairs for overlap in the plane (a 2D polygon intersection of two triangles is small enough to do directly).
  Report overlapping pairs whose faces belong to different shards (see Phase 3 for the shard id; before Phase 3 lands, report all pairs).
  This is the z-fighting check.
- **Degenerate triangles.** Area under 1e-8 m^2, or an edge under 0.1 mm, counted and reported; a few are normal, hundreds mean a broken step.
- **Dark caps.** For every up-facing face over 10 cm^2, sample the AO atlas at the face's UV centroid and count faces reading under 0.05; report count and the largest.
  This is the check that would have found the black-cap problem on the first build.
- **Open shards.** Only possible before the cull, so it is a BUILD-time check (below), not a file check; the file check notes that it cannot be done here.

### Build-time checks (in `rocks.py`)

These already exist as prints ("open clips closed: 8 by the exact solver") and become a structured report the wrapper reads:

- per piece: shards placed, shards dropped as slivers, clips repaired (exact solver / filled / still open), chunks re-wound, buried triangles dropped, chunks left open after everything;
- per body: AO atlas size and coverage, faces culled, faces after decimation.

The wrapper prints the table, writes it beside the GLB as `<level>.rocks.json`, and exits non-zero if any chunk is still open after repair.
`cli rocks-check` also reads that file when it exists, so one command shows both halves.

### Wiring

- `bun run assets:rocks <level>` runs the file check on its own output by default; `--no-check` skips it for a quick loop.
- `cli rocks-check public/rocks/test.glb --body 150 --cameras head,above` for a hand run; `--json` for the raw report.
- Not in `bun run test`: it needs Blender and the GLBs are gitignored.
  A future fixture (build body 150 at scale 2, seed 0, compare the report to a committed one) would make it a regression test, and that is written down as the follow-up, not done here.

Effort: one day, most of it the coincident-face check and the wiring.
Risk: the back-face scan's cameras have to be chosen so a legitimately visible interior (a cave, a notch seen from above) is not flagged; report clusters, let a human judge, and never fail the build on this check alone.

## Phase 3: provenance in the mesh

Every face says which step made it and which shard it belongs to, so a hole on screen becomes "shard 143, face from the clip, dropped by nothing".

### Two integer attributes

- `_SHARD`: an integer per vertex, the index of the chunk within its piece (the backing prism is the last index), written by `mesh_from_arrays` in place of the random float `shard` mark.
  The random mark the material reads for its per-shard jitter (`COLOR_0.b`) stays; it is derived from the id by hashing in `masks`, so nothing changes for the material.
- `_PROVENANCE`: an integer per face, written as a per-corner attribute (glTF has no per-face attributes; three reads per-vertex, and the exporter splits vertices between faces that disagree).
  Values, one per step that can create or alter a face: `1` template, `2` float clip, `3` exact clip, `4` hole fill, `5` backing, `6` rim inset, `7` planar dissolve.
  Each step sets the value on the faces it produced; a face that passes through a step untouched keeps its value.

Blender's exporter writes mesh attributes whose names start with an underscore when `export_attributes` is on; three's `GLTFLoader` exposes them as `geometry.attributes._shard` and `_provenance`.
Confirm both on the first build with `cli rocks-check`, which gains a line listing the attributes present.

### What is NOT recorded, and why

A deleted face has no provenance because it has no face.
The steps that delete (sliver filter, buried pass, cull, dissolve) are covered by the build-time counts in Phase 4 and by the stage dumps in Phase 6.
Recording "what would have been here" is what the dumps are for.

### Shipping size

Two extra attributes cost about 5 bytes per vertex before compression.
The shipping build passes `--no-debug-attributes` to the generator, which leaves them out of the export; the dev loop keeps them.
`docs/asset-store.md`'s budget note is updated.

Effort: half a day.
Depends on nothing; Phase 2 and the coincident-face check in Phase 4 want it.

## Phase 2: debug views and picking in the game

`?rockdebug=<view>` swaps every rock body's material for a debug material, and a click picks a face.
The views exist to make one class of defect unmistakable in a screenshot.

### Views

- `backfaces`: the normal material renders front faces only; a second pass renders back faces in flat magenta with the depth test on.
  Any magenta pixel is a hole or an inverted face.
  Implemented as a second `Mesh` per body sharing the geometry with a `MeshBasicMaterial({ color: magenta, side: BackSide })`, added and removed by the view switch, so the real material is untouched.
- `shards`: flat colour per `_SHARD` id (a hash of the id into a hue), lit only by a fixed hemisphere so shards are told apart and nothing else shows.
  Overlaps, z-fighting and buried-pass leftovers are visible as speckle.
- `provenance`: flat colour per `_PROVENANCE` value, with a legend in the HUD (`1 template` grey, `2 float clip` blue, `3 exact clip` orange, `4 fill` red, `5 backing` green, `6 rim` yellow, `7 dissolve` purple).
- `ao`: the AO atlas alone as a greyscale, unlit.
  Black patches on faces the camera sees are atlas defects.
- `normals`: world normal as colour, for winding and smoothing defects.
- `wire`: the real material with `wireframe` on a second pass, for triangulation density.

All views go through one function `setRockDebug(view)` in `rockMesh.ts` that walks the mounted bodies; `main.ts` and `shotMain.ts` read the query as they read `?paint=`.
The views are `ShaderMaterial`s where a stock material cannot express them (`shards`, `provenance` read integer attributes), and they carry no lighting, fog or paint, on purpose.

### Picking

With any `rockdebug` view on, a click (or `?pick=X,Y` in a shot, in pixels) raycasts the rocks group and logs:

```
[rocks] pick body 150 shard 143 provenance 2 (float clip) face 9021 at (49.31, 0.18, 3.02) normal (0.02, -0.99, 0.11) ao 0.31
```

- The raycast is three's `Raycaster` over the rocks group only; the game already raycasts for the editor's `Scene3D.pick`, so the code path exists.
- `face` is the triangle index in the primitive, which `cli rocks-check --face 150:9021` can print the vertices of, and which the stage dumps (Phase 6) can be searched for.
- In pointer-locked fullscreen the click is the game's own input; picking is a windowed-mode and headless tool, and `docs/rocks.md` says so.
- `cli shot` accepts `--pick X,Y` and includes the pick line in its captured console.

### Worked example

The report is a screenshot and an F4 capture.
`cli shot --view capture.json --query rockdebug=backfaces` reproduces it; if the hole is real there is a magenta patch.
`cli shot --view capture.json --query rockdebug=provenance --pick 960,930` names the shard and the step that made the faces around the hole.
`cli rocks-check --body 150` says whether that shard was open, re-wound or repaired at build time.
That is the attribution the first four defects each took an hour to reach.

Effort: one day.
Depends on Phase 3 for `shards` and `provenance`; the other views can land first.

## Phase 6: stage dumps and A/B flags in the generator

When the views point at a step, the step's input and output have to be inspectable without patching the script.

### Flags, passed through the job

Each is a key the wrapper puts in the job JSON and `rocks.py` reads with a default of off:

- `--no-buried`: skip `drop_buried`.
- `--no-cull`: skip the back-face cull.
- `--no-detail`: skip the three `DETAIL` displaces.
- `--no-inset`: skip `inset_wall`.
- `--no-repair`: take the float boolean's result as it is (no exact retry, no fill), which reproduces the two boolean failures on demand.
- `--seed N`: override every body's seed for this build (the editor's per-body `rockSeed` stays the authored value).

Every flag is echoed in the build log and in `<level>.rocks.json`, so an A/B file says what it is.
`cli shot --diff` already compares two renders; the loop is build A, build B, shoot both with the same `--view`, diff.

### Stage dumps

`--dump-stages DIR` writes one GLB per body per stage into `DIR`, each stage a node named `<stage>-body-<i>`:

1. `scatter`: the raw shard soup before the clip, one chunk per shard.
2. `clipped`: after `clip_shard` and `inset_wall`.
3. `buried`: after `drop_buried`.
4. `sculpted`: after the detail displaces.
5. `culled`: after the cull.
6. `final`: what is exported.

Each stage carries `_SHARD` and `_PROVENANCE` (Phase 3), so a face picked in the game (Phase 2) is found in every stage by shard id, and the first stage in which it is missing is the step that removed it.
`cli rocks-check <dump.glb> --body 150 --shard 143` prints, per stage, the shard's triangle count, closedness and bounding box, which is the whole story of one shard in one table.

Dumps are large (the soup before the clip is every shard whole); they are a debugging artefact written under the scratchpad or `/tmp`, never under `public/`.

Effort: half a day; the dumps reuse `mesh_from_arrays` and the exporter call that already exists.

## Order and dependencies

1. **Phase 5** first: an afternoon, no dependencies, and it makes every subsequent report reproducible and every file identifiable.
2. **Phase 4** next, without the shard-aware coincident-face check: it catches the two boolean failure classes at build time from the first run.
3. **Phase 3**: the two attributes; verify them with the Phase 4 attribute listing.
4. **Phase 2**: the views, `backfaces` and `ao` first (no dependency), `shards` and `provenance` once Phase 3 has landed; then picking.
5. **Phase 6**: flags first (an hour), dumps second.
6. Return to Phase 4 for the shard-aware coincident check and the `--shard` stage table.

Total: about four days, and each phase pays for itself alone.

## Process change that goes with the tooling

- A rock defect report is an F4 capture plus a screenshot; the first step of an investigation is `cli shot --view` with `rockdebug=backfaces`, and the second is `cli rocks-check` on the file the capture names.
- No fix to `rocks.py` lands without the build-time report and the file check both clean on body 150 at scale 2, seed 0; `docs/rocks.md` records the counts a clean build prints so a regression is a diff.
- A step that deletes or rewrites faces sets `_PROVENANCE` or is counted in the build report, or it does not land.
- The throwaway scripts written this evening (`rocks-open.py`, `rocks-cap.py`, the BVH scan) are deleted once Phases 3 and 4 cover them; until then they are listed in `docs/rocks.md` under "Diagnosing", so they are found rather than rewritten.
