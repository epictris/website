# Generators

The visuals workspace drives two procedural pipelines from the editor: **boulders** (a collision outline in, a fractured, bevelled, baked stone out) and **mushroom patches** (a painted surface in, a merged mesh of glowing mushrooms out).
Both are Python and headless Blender, ported from the fork at `~/projects/karin_website` (`asset-generators/`), and both run behind the dev server, never in the browser.
This page is the service that runs them, the schemas that configure them, the Python layout, and how to extend either.
The plan they come from is [plans/visuals-workspace.md](../plans/visuals-workspace.md).

## Setup

```sh
cd rope
bun run generators:setup   # python3 -m venv .venv, then pip install -r tools/blender/requirements.txt
bun run generators:check   # the cases below, and a real generation of each kind when the tools are here
```

Blender 5.2 must be on `PATH` (it is at `~/.local/bin/blender` on the owner's machine), or named by `BLENDER_PATH`.
Python is `PYTHON_PATH` if set, else `rope/.venv/bin/python`, else `python3` on `PATH`.
The venv comes before the system interpreter because the system one usually lacks shapely and scipy.
A variable naming a file that is not there finds nothing, so the service says "not found" up front instead of failing every job on a spawn error.
`GET /api/generators` says what was found.

The packages are numpy, shapely (pinned at 2.1.2, as the fork pinned it), scipy, Pillow and matplotlib; only the boulder generator needs them.
The mushroom generator runs inside Blender's own Python and needs nothing installed.

## The service

`src/server/generators/service.ts` is a Vite plugin, registered in `vite.config.ts`, dev server only.
Results are content-addressed: the mesh key names the output directory, so asking again for something already generated is free, and a key never names two different meshes.
Blender runs one job at a time, because one Blender saturates this machine's CPU on its own, so jobs wait in one FIFO queue.

### Endpoints

`GET /api/generators` answers which tools are here:

```json
{ "python": "3.14.0", "blender": "5.2.0", "deps": true, "venv": true, "queue": 0 }
```

`python` and `blender` are versions, or `null` when the tool is missing or would not run; `deps` is whether the Python imports the boulder generator's packages; `venv` is whether `rope/.venv` exists; `queue` counts queued and running jobs.
The probe runs once per server and again after any probe that found something missing, so installing a tool needs no restart.

`POST /api/generate` asks for a mesh:

```json
{ "kind": "boulder", "key": "boulder:c82bc75873f0956b",
  "input": { "outline": [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]] }, "params": { "seed": 7, "depth": 1.2 },
  "object": "ball/geometry-17" }
```

```json
{ "kind": "mushrooms", "key": "mushrooms:...",
  "input": { "loop": [[x, y, z], ...], "facing": [x, y, z],
             "host": { "kind": "mesh", "mesh": "boulder:...", "frame": [r00, r01, r02, tx, r10, r11, r12, ty, r20, r21, r22, tz] } },
  "soup": [x, y, z, x, y, z, ...], "params": { "density": 220 }, "object": "ball/geometry-18" }
```

- `kind` is `boulder` or `mushrooms`, and `key` must be `<kind>:<16 hex digits>` (`parseGeneratedKey` in `src/render3d/generated.ts`).
- `input` is the **key input**, exactly what `generatorInput` (`src/editor/visuals/paramSchema.ts`) builds for the object and what `generatedKey` hashes:
  a boulder's `{ outline }` is the object's local outline in metres, y up, 3 to 128 vertices within 100 m of the origin;
  a patch's `{ loop, facing?, host }` is the painted loop in the patch's frame, the side of the loop's plane it was painted on (a unit vector in the patch's frame, y up; absent for a patch saved before it was stored), and the host as `PatchHost` describes it.
  The host's `frame` is its whole frame in the patch's (the top three rows of the 4x4 affine matrix, row by row, so both objects' place, turn, tilt and scale are in it); a primitive host adds its outline or radius, depth, bevel, taper, `texture` and `projection`; a generated host that has never been generated adds `generator`, the key it would be generated under, so two such rocks are two hosts.
- `soup` is a patch's alone: the host surface inside the loop as a flat triangle soup in the three.js frame relative to the patch origin, metres, collected by the editor at generation time.
  It is what Blender grows on, but it is derived from the key input and is not hashed.
- `params` holds the values that differ from the schema's defaults (defaults are allowed and ignored by the key).
  They are checked by `validateParams` from `src/level/generatorParams.ts`, the editor's own validation, and every `<name>Min` / `<name>Max` pair by `validatePairs` after `mergeDefaults`.
  A `null` for a parameter whose default is `null` (the boulder's `tolerance`) means "derive it", as absent does.
- `object` is optional: any string that names the editor object the mesh is for. A newer request for the same object under another key takes that object off the older job, which stops once no object waits on it (below).

**The key is checked.**
`expectedKey(kind, input, params)` in `service.ts` is `generatedKey(kind, <the schema's version>, input, params)`, and a request whose key differs is a 400 naming both: `The key boulder:0123456789abcdef does not match its content, which makes boulder:c82bc75873f0956b.`
So the client must hash at the schema version the server runs (`loadSchema(kind).version`), not at an older version stored in a level; a level generated under an older version is stale and regenerates under the new one.

The answer is `{ "key": ..., "state": "done" | "queued" | "running" }`: `done` at once when `public/generated/<kind>/<hash>/mesh.glb` exists, else the job's state (`running` when the queue was idle).
A bad request is a 400 with `{ "error": ... }` naming each bad key and why; a missing tool is a 503 saying which; a request from another origin is a 403.
A body over `BODY_LIMIT` is a 413: the limit is sized from the mushroom schema's own `maxTriangles.max` (200 000 triangles, nine numbers each, at the 10 bytes the widest soup number takes at the editor's 0.1 mm rounding) plus a megabyte, 19 MB, so any soup the schema allows fits.
The body is read as bytes and decoded once, so a character split across two network chunks survives.

`GET /api/generate/<key>` answers a job's state:

```json
{ "state": "done", "elapsed": 6.9, "bytes": 1499436, "triangles": 7504 }
```

`state` is `queued`, `running`, `done`, `failed` or `superseded`.
`elapsed` is seconds waiting (queued), running (running), or what the run took (done, failed, superseded).
`message` carries a failure (below) or why a job was superseded; `bytes` and `triangles` come with `done`.
A key the server has not seen this life but whose mesh is on disk answers `done` from its `meta.json`; anything else is a 404.
A path that is not a key, including a malformed escape (a lone `%`), is a 400.

`DELETE /api/generate/<key>` cancels a queued or running job outright, past the bake or not, and answers its status.

`GET /generated/<kind>/<hash>/mesh.glb` serves the mesh with `Cache-Control: public, max-age=31536000, immutable`, as the fork served its files: a key names exactly one mesh for ever.

### Jobs

A job writes its request to a scratch directory (`$TMPDIR/trisball-<kind>-*`), runs the kind's command in its own process group, and on success publishes into `public/generated/<kind>/<hash>/`: `meta.json` first, then `mesh.glb` by rename, so "mesh.glb exists" always means "done".
The process group matters because `rockgen.py` starts Blender as its own child; killing Python alone would leave that Blender running.
A failed run's scratch directory is kept, and the failure message says where.

The generator is handed the parameters in the form the key hashed (`canonicalParams`: rounded to a ten-thousandth, defaults stripped), never the request's own spelling: two requests within a ten-thousandth of each other share a key, so they must build the same mesh.

**A job lives as long as its server.**
Because a run is its own process group, Ctrl+C in the dev server's terminal (delivered to the terminal's foreground group) never reaches it, and a restart forgets it; either used to leave Blender running for minutes beside the one the next server started.
`run.ts` tracks every live group, and the service ends them: a restart (any edit to a config dependency, `levelFormat.ts` among them, restarts vite) closes the old HTTP server, whose `close` stops that service's queued and running jobs; the process's `exit`, `SIGINT` and `SIGTERM` kill every group (a signal handler then takes itself off and re-raises the signal when nothing else handles it, so Ctrl+C still ends the server).
The editor's poll then meets a 404 and reads the job as `lost`, "the dev server restarted: press Generate again", not as a failure (see [The editor's side](#the-editors-side)).

`meta.json` is:

```json
{ "key": "boulder:...", "kind": "boulder", "version": 1, "params": { "depth": 1.2 }, "input": { "outline": [...] },
  "bytes": 1499436, "triangles": 7504, "generatedAt": "2026-09-25T15:46:00.000Z", "blender": "5.2.0", "seconds": 6.9 }
```

It is `GeneratedMeta` (`src/render3d/generatedMeta.ts`) plus `seconds`: `params` in the canonical form the key hashed (defaults stripped, keys sorted), `input` the key input.
A patch's soup can run to megabytes and `meta.json` is read for every level that uses the mesh, so the soup sits beside it in `input.json` as `{ "soup": [...] }`.

**Supersede.** A job holds the set of objects waiting on it: a key is content, so two objects can wait on one job (a rock duplicated mid-generation and generated again is a second object asking for the same key), and a request naming no object is a waiter that never leaves.
A request carrying `object` takes that object off every other job; a queued or running job that nobody is left waiting on stops, unless it is past its bake: the geometry is then final, the bake is most of what is left, and the result is cached under its own key anyway.
A job another object still waits on runs on and answers that object's polls as before.
"Past the bake" is the run printing `GENERATOR: bake started` (`blender_build.py` at the start of the texture bake; `editor_patch.py` once the node group has been frozen).
A stopped job's state is `superseded`, and its scratch directory is removed.

**Failures.** `failure.ts` is the fork's `generatorFailure.ts`: the validators' `name: PASS|FAIL ...` lines first, then where the output was kept, then the tail of stderr without Blender's deprecation noise, cut on whole lines at about 1200 characters.
The validators are the fork's and are strict: the 2 x 1 m rectangle with seed 7 and depth 1.2 (the pinned `boulder:c82bc75873f0956b`) fails its centre slice by 0.1 mm (0.040106 against a 0.04 m tolerance) in the fork's own code as well as here, so a failure is a normal outcome the author answers with another seed or a looser tolerance.
A mushroom run says its own refusals on a `MUSHROOMS:` line ("no mushrooms fit this surface"), which is passed through as it is.

**Triangles** are read from the GLB (`glb.ts`): the JSON chunk's index accessor count (or the POSITION count, unindexed) over three, per primitive, per node that places the mesh.
That is the count three.js draws; Blender's own `Health:` line counts faces before the exporter's splits.

**Timeouts.** A boulder is killed after 600 s and a patch after 300 s, as the fork's were.

### Timings

Measured on the owner's machine (32 threads, Blender 5.2.0), one job at a time, nothing else running:

| Generation | Seconds | Triangles | Bytes |
|---|---|---|---|
| Boulder, the ball.json body 7 outline (0.76 m², 9 vertices), defaults | 6.9 | 7 504 | 1.5 MB |
| Boulder, 1 m square, defaults | 6.4 to 6.8 | 7 040 | 1.6 MB |
| Mushroom patch, 1 m square, defaults (about 150 mushrooms) | 1.7 | 26 076 | 1.4 MB |

Seconds are the service's own `elapsed`, from the job starting to its mesh being published, through `POST /api/generate` on a dev server.
`textureSize` 1024 costs a patch 4.4 s; `bakeSize` 1024 halves a boulder to 3.5 s.

The fork's docs quote 8 to 60 s a boulder on slower machines; most of a boulder's time is the Manifold booleans, the voxel remesh and the 2048² bake.

Through the editor (Phase 5's acceptance run, 2026-09-25, the same machine): a 2 m six-vertex outline took 7.2 s at the defaults and 6.6 s at `depth` 1.2 m (about 7 400 triangles, 1.5 to 1.7 MB); `Next seed` 7.3 s; the 2 x 1 m rectangle 7.2 s to fail and 7.2 s to pass at `tolerance` 0.1 m; a patch of about 0.4 m² on a rock's top 1.8 s (10 000 to 12 000 triangles, 1 MB).
The author waits about a second longer than `elapsed`, the poll's resolution.

## The editor's side

The Visuals workspace's **+ Rock** and **+ Mushrooms** and their panels are the service's one client ([editor-visuals](editor-visuals.md#rocks-and-mushrooms)).
This is what it holds up of the contract.

- **The key is computed at the server's schema version.**
  The editor asks `wantedKey` (`editor/visuals/paramSchema.ts`): `generatedKey(kind, loadSchema(kind).version, generatorInput(item, lookup), params)`, not the version stored in the block, which the server would refuse.
  When the mesh lands, the block's `version` is written up to the one it was made under, in the same undo step as the `mesh`.
- **`params` holds only non-default values**, stripped by `stripDefaults`; a blank field (the boulder's `tolerance`) is absent rather than null.
  The editor runs `validateParams` and `validatePairs` itself first, and says what is wrong without a round trip.
- **`input` is exactly `generatorInput`'s**, and a patch's `soup` is collected at generation time from the host's drawn meshes, in the patch's own frame (`patchMatrix` in `editor/visuals/surfacePatch.ts`, the frame `mountVisual` draws the mesh in), metres to 1e-4.
  `maxSlope` is applied there, as a face filter; `maxTriangles` bounds the cut before the request, and the editor checks `area * density` against `maxEstimate` before sending, with the server's own check behind it.
- **The soup is read off a scene built from the model as it stands.**
  The frame loop rebuilds the scene only while one is drawn, so a patch generated from the Level workspace's 2D view first switches to the Visuals workspace; the collect then builds the scene for the current revision, waits a frame for it to be placed, and abandons (with a status line) if the model changed in the frames it waited, rather than send a soup of an old pose under a new key.
  It refuses a host drawn as something its key does not name: a generated rock never generated (its stand-in extrusion; "generate the host first"), a mesh object with no mesh, or a host whose mesh does not load (a grey placeholder).
- **The key input's shape is part of the key.**
  The schema `version` is the PARAMETERS' version and is bumped when a default changes; a change to what the key input holds (on 2026-09-25 a patch's host `pose` became its whole `frame` and `facing` was added) changes every key it touches by itself, with no version bump, and makes those objects stale.
  That change was made before any patch was saved into a level; the pinned patch key in `cli render3d` was re-pinned for it and says so.
- **`object`** is `<page>/<item id>`, the page part random per editor tab, so a newer request supersedes the older one for the same object in the same tab and never another tab's.
- **Polling** starts at 250 ms and backs off to once a second (`POLL_FIRST_MS`, `POLL_MAX_MS` in `editor/visuals/jobs.ts`).
  A 404 mid-job means the dev server restarted or stopped (a job lives as long as the server, and the old one killed its Blender on the way out): the job is `lost`, and the panel says "the dev server restarted: press Generate again", not `failed`.
  A poll that goes unanswered (a network error, the second a restart takes) is asked again, and the job is called lost only after `POLL_MISSES` (5) in a row.
- **The panel asks for a current mesh's facts** (`GeneratorJobs.facts`, once per key per page) with `GET /api/generate/<key>`.
  A `done` answer gives the triangles and bytes the status line shows; a 404 means the service has neither a job nor a file for the key (a level generated on another machine and not fetched, or a deleted `public/generated/` directory), and the panel reads `stale: file missing` until `bun run assets:fetch` brings back a published one or Generate makes it again.
- **Job state lives in the page.**
  A reload forgets which object waits on which job; the service carries on and caches the result, and the next Generate of the same content joins the running job or finds the mesh at once.
- **A finished mesh goes on its object once**, as one undo step, and only if the object is still there and its `wantedKey` is still that key.
  A result for content the object has since left stays in the cache, where the next Generate of that content finds it at once.
  A result that lands during any gesture waits for it to end: a drag, a gizmo drag (three's own, which the editor's `drag` never sees) or a held arrow's nudge run, each of which is one undo step a swap would split.
  The swap is not the author's edit, so it keeps the redo stack (`beginAction({ keepRedo: true })`) and writes the mesh into every redo state that wants that very key (`landMesh` in `editor/visuals/generatorEdits.ts`).
  A key whose file failed to load earlier in the page (a missing file, then generated) has that failure forgotten (`forgetFailedMesh`) and the scene rebuilt, so the new file is fetched even when the object already names the key.
- **A key that cannot be made** (a non-finite number in a parameter or an outline, which `generatedKey` refuses rather than hash) reads as `stale: invalid value` on the status line and `stale` in the outliner, and Generate says so; neither throws out of the frame loop. A field never writes one.
- **`failed` is an ordinary outcome.**
  The panel leads with the validator lines that say FAIL and, for a rock, the remedy: another seed, or a looser `tolerance`.
  `tolerance` also sets the remesh voxel size, so the deviation grows with it: the 2 x 1 m rectangle failed its centre slice at 0.0418 with the default (0.04 m), at 0.0534 with 0.05 m, and passed with 0.1 m.
  Widen it well past the reported number, or move the seed on.

**Staleness** is `isStale`: the stored `mesh` is not `expectedKey` of the object as it stands (its outline; its loop or facing; its host's key, a primitive host's form, texture and lens, or the host's whole frame relative to the patch, so tipping or scaling either alone counts; its params; or its stored version changed since), or it has never been generated, or it cannot be (a patch whose host is gone).
A stale object keeps drawing its last mesh; the editor never regenerates on its own.
A regenerated rock makes the patches grown on it stale (their host's key moved), and each regrows on the new surface when it is generated.

## The schemas

Each generator has one parameter schema, `tools/blender/<dir>/params.json`, read by the inspector, by the server's validation and by the Python alike, so a default is stated once.
The TypeScript half is `src/level/generatorParams.ts` (types, `loadSchema`, `validateParams`, `validatePairs`, `mergeDefaults`, `stripDefaults`, `scaleParams`, `canonicalParams`), shared by the level format, the editor and the service; the Python half is `boulders/params.py` and `editor_patch.py`'s `patch_values`.

```json
{ "kind": "boulder", "version": 1, "groups": ["Shape", "Fracture", "Surface", "Material", "Bake"],
  "params": [ { "key": "depth", "type": "number", "unit": "m", "default": 1.6, "min": 0.02, "max": 5, "step": 0.05,
                "group": "Shape", "basic": true, "doc": "The solid's depth through the gameplay plane, centred on it." } ] }
```

- `type` is `int`, `number`, `bool`, `enum` (with `options`) or `color` (linear RGB triple).
- A `number` whose `default` is `null` is blank by default and derived by the generator: the boulder's `tolerance` is `min(0.04 m, 4 % of the square root of the outline's area)` when blank.
- `unit` `m` marks a length (scaled between px and metres by the level format) and `deg` an angle; the rest are dimensionless or a rate per metre, which the `doc` says.
- `basic` parameters show by default in the inspector; the rest sit under an Advanced disclosure per group.
- `notes` says where the defaults came from and which fork constants deliberately stay constants.

Boulders have 78 parameters (Shape 10, Fracture 29, Surface 17, Material 16, Bake 6; 12 basic); mushroom patches have 26 (Placement 8, Form 7, Look 9, Limits 2; 8 basic).
Every default is the fork's value, and a request of defaults alone reproduces the fork's GLB byte for byte.

## The Python

### Boulders: `tools/blender/boulders/`

The fork's `asset-generators/boulders/stylised_rocks_v5/` as it stood in its working tree on 2026-09-25 (the version the fork's editor ran), copied whole with its README, sample specs and maintenance scripts.
The module layout and helper names are unchanged: the fork's dirt-moss generator imports `Mesh`, `prism`, `camera_basis`, `object_from_part`, `keep_main_body` and more from these files.

| File | Does | Runs in |
|---|---|---|
| `rockgen.py` | The driver: reads the request, builds the pieces, writes `source_geometry.json`, runs Blender, then `validate.py` and `validate_centre.py` | Python |
| `params.py` | Reads `params.json`; `param(spec, key)` answers from the spec, else the schema default | both |
| `chunk_geometry.py` | The buried support and the 3D anisotropic Voronoi chunks | Python |
| `volume_geometry.py` | The natural slabs (`make_block`), their placement, the chipped outline, the depth ridges | Python |
| `hybrid_geometry.py` | Chunks plus proud slabs plus a varied clip envelope; `taper_chunk` (run in Blender) | both |
| `solid_chunks.py` | Drops slivers, backs shallow wedges | Blender |
| `blender_build.py` | The Blender pipeline: clip, bevel, taper, union, remesh, smooth, decimate, clip again, bevel, bake, export | Blender |
| `stone_materials.py` | The procedural slate that is baked into the colour and normal maps | Blender |
| `validate.py`, `validate_centre.py` | The silhouette and centre-slice checks; a FAIL fails the job | Python |

A request is `{ "kind": "boulder", "version": 1, "outline": [[x, y], ...], "params": { ... } }`.
`read_specs` recognises it by its `outline` and turns it into exactly the document the fork's server wrote (`request_document`): the fork's field names, the slab count `clamp(round(area * slabsPerArea), 2, 100)` with JavaScript's rounding, the auto tolerance with the area summed in the fork's order, and the editor recipe's fixed flags (`EDITOR_RECIPE`).
Every other schema key rides along in the spec under its own name, and each module reads the value it used to hard-code with `param(spec, key)`.
The fork's own document format (`plane`, `defaults`, `rocks`) still works, so the sample specs and the fork's README commands run as before; a key such a document lacks falls back to the schema default.

Constants that stay constants, as the plan decides: validation bounds, the dead `add_surface_relief` and its `strata`, the preview stage, the recipe flags the editor never varied (`hybrid_faces`, `chunked_sides`, `balanced_hybrid`, `broad_side_chunks`, `soften_thin_edges`, `solid_chunk_edges`, `game_low_poly`, `fit_mode`, `camera_yaw`, `camera_pitch`), and the values of the recipe branches the editor never takes.
A knob is threaded only into the branch the editor runs: `chunkTilt` replaces the broad recipe's `0.18` and leaves the narrow recipe's `0.32` alone.

### Mushroom patches: `tools/blender/mushrooms/`

| File | Does |
|---|---|
| `mushroom_patch_tools.py` | Karin's "Mushroom Patch" Blender add-on: the `MushroomPatch` Geometry Nodes group, the generated textures and material, bake and export |
| `editor_patch.py` | The editor's entry: soup in, every socket and look knob set from the spec, GLB out |

A request is `{ "kind": "mushrooms", "version": 1, "positions": [...], "params": { ... } }`, where `positions` is the service request's `soup`; the fork's flat shape (`seed`, `density`, ... at the top level) still reads.
`editor_patch.py` merges `params.json` with the overrides, sets every node group socket from `SOCKETS` (`maxTilt` authored in degrees, the socket in radians), and hands the look knobs (`glow`, `paleness`, `capVariants`, `stripeDarken`, the four roughnesses, `textureSize`) to `make_patch(look=...)`.
`maxSlope`, `maxTriangles` and `maxEstimate` act before Blender: the editor filters the surface by slope, the server bounds the soup and the estimated count.
The add-on installs into Blender as one file, so it keeps its own defaults (the sockets' and `LOOK`); `mushrooms/test_params.py` fails when they drift from `params.json`.
The one deliberate difference is `detail`: the fork's editor sent 0.3 where the add-on's panel starts at 0.5.
The OKLab stops and shade tables stay constants; `capVariants` uses the first n of the eight rows.

## Checks

`bun run generators:check` (`scripts/generators-check.ts`) runs, and prints PASS, FAIL or SKIP with a reason for each:

1. **Service cases** (`scripts/generators.test.ts`, `bun test`): request validation, the key check (the pinned `boulder:c82bc75873f0956b` accepted, a wrong key refused naming both, a patch's key blind to its soup), the failure formatter (the fork's three `.test.mjs` files, rewritten), the GLB triangle count, and the queue against a stand-in `python` that behaves like `rockgen.py` without Blender: one job at a time, supersede before and after the bake, a job two objects wait on running on until both have moved on, cancel, a failure's verdicts, the generator handed the rounded parameters the key hashed; plus a malformed key escape as a 400, a body decoded once across a split character, and the body limit holding the schema's largest soup.
2. **Boulder params** (`tools/blender/boulders/test_params.py`): a request of the ball.json body 7 outline with no overrides becomes, field by field and type by type, the fork's `polygon.json` for that rock (`boulders/fixtures/ball-body-7.polygon.json`), apart from the two recipe changes the fork's server made after that rock was generated (`slabs` 10 became `round(area * 10)` = 8; `game_low_poly` was added); every other schema knob rides along at its default; plus the fork's slab-count cases, the auto tolerance and unknown keys.
3. **Mushroom params** (`tools/blender/mushrooms/test_params.py`, standard library only): the add-on's defaults agree with `params.json`, and every parameter has somewhere to go.
4. **End to end**, when the tools are here: a 1 m square outline through `rockgen.py` and Blender, and a 1 m square surface through the patch, each checked for a GLB with triangles in it.
   Skipped with the reason printed when Python, its packages or Blender are missing.

What the checks do not see: whether a generated rock or patch looks right.
When this port was made, the ported generators were shown to reproduce the fork byte for byte (the GLB of the body 7 outline with no overrides, and of a 1 m patch with no overrides, identical to the fork's own run of the same request), and every Blender-side parameter was shown to change the GLB when moved; neither is a standing check, because each needs the fork checked out.

## Adding a parameter

1. Find the constant in the Python, and the branch the editor runs through it.
2. Add it to `params.json` with its current value as the default, a range that holds that value, a step, a unit if it has one, a group and a one-line `doc`.
3. Read it where the constant was: `param(spec, "key")` in the boulder modules (pass `spec` down to a helper that has none in reach, as an optional argument that falls back to `None`), or a `SOCKETS` row or a `LOOK` key for the patch.
4. Run `bun run generators:check` and `bun run src/tools/cli.ts render3d` (its `generator:` cases hold the schema's shape and the defaults): the boulder fixture test must stay green (a default that is not the old constant changes the request) and the mushroom test says where a key has nowhere to go.
5. Move the value once through the endpoint and confirm the GLB changes; a knob that does nothing on one outline may be clamped by another (`tipInset` is capped at 0.14 m, so it does nothing on a 1.6 m deep rock until it drops below 0.0875).

## Adding a generator

1. Put its sources under `tools/blender/<dir>/` with a `params.json`, and make its entry point read the schema defaults, then the request's `params`.
2. Print `GENERATOR: bake started` once its result can no longer change, if it should survive a supersede from there.
3. Add the kind to `GeneratorKind` and `GENERATOR_SCHEMAS` (`src/level/generatorParams.ts`), its key input to `GeneratorInput` and its prefix to the key pattern (`src/render3d/generated.ts`), and its `generatorInput` branch (`src/editor/visuals/paramSchema.ts`).
4. Write `src/server/generators/<kind>.ts` exporting a `Generator` (`run.ts`): its `dir`, `validateInput`, its `keyInput` and `sidecars`, the `request` it writes, what it is `missing`, its `command`, where it leaves the GLB, a timeout and a failure formatter; add it to `GENERATORS` in `service.ts`.
5. Add its cases to `scripts/generators.test.ts` and its end-to-end run to `scripts/generators-check.ts`.
