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
{ "kind": "boulder", "key": "boulder:0123456789abcdef", "input": { "outline": [[0, 0], [1, 0], [1, 1], [0, 1]] }, "params": { "depth": 1.2 }, "object": "ball/geometry-17" }
```

- `kind` is `boulder` or `mushrooms`, and `key` must be `<kind>:<16 hex digits>` (`KEY` in `service.ts`).
- `input` is the kind's input: a boulder's `outline` is the object's local outline in metres, y up, 3 to 128 vertices within 100 m of the origin; a patch's `positions` is the painted surface as a flat triangle soup in the three.js frame relative to the patch origin, metres.
- `params` holds only the values that differ from the schema's defaults; every key is checked against the schema (type, range, options), and so is every `<name>Min` / `<name>Max` pair after merging with the defaults.
- `object` is optional: any string that names the editor object the mesh is for. A newer request for the same object under another key supersedes the older job (below).

The answer is `{ "key": ..., "state": "done" | "queued" | "running" }`: `done` at once when `public/generated/<kind>/<hash>/mesh.glb` exists, else the job's state.
A bad request is a 400 with `{ "error": ... }` naming the key and its range; a missing tool is a 503 saying which; a body over 12 MB is a 413; a request from another origin is a 403.

The server does not compute the key.
`expectedKey(kind, input, params)` in `service.ts` returns `null` for now, which means "trust the client's key, check only its shape"; the merge with the format phase wires `generatedKey` from `src/render3d/generated.ts` into it, and from then on a key that does not match its content is refused.

`GET /api/generate/<key>` answers a job's state:

```json
{ "state": "done", "elapsed": 6.9, "bytes": 1499436, "triangles": 7504 }
```

`state` is `queued`, `running`, `done`, `failed` or `superseded`.
`elapsed` is seconds waiting (queued), running (running), or what the run took (done, failed, superseded).
`message` carries a failure (below) or why a job was superseded; `bytes` and `triangles` come with `done`.
A key the server has not seen this life but whose mesh is on disk answers `done` from its `meta.json`; anything else is a 404.

`DELETE /api/generate/<key>` cancels a queued or running job outright, past the bake or not, and answers its status.

`GET /generated/<kind>/<hash>/mesh.glb` serves the mesh with `Cache-Control: public, max-age=31536000, immutable`, as the fork served its files: a key names exactly one mesh for ever.

### Jobs

A job writes its request to a scratch directory (`$TMPDIR/trisball-<kind>-*`), runs the kind's command in its own process group, and on success publishes into `public/generated/<kind>/<hash>/`: `meta.json` first, then `mesh.glb` by rename, so "mesh.glb exists" always means "done".
The process group matters because `rockgen.py` starts Blender as its own child; killing Python alone would leave that Blender running.
A failed run's scratch directory is kept, and the failure message says where.

`meta.json` is:

```json
{ "key": "boulder:...", "kind": "boulder", "version": 1, "params": { "depth": 1.2 }, "input": { "outline": [...] },
  "bytes": 1499436, "triangles": 7504, "generatedAt": "2026-09-25T15:46:00.000Z", "blender": "5.2.0", "seconds": 6.9 }
```

A mushroom patch's soup can run to megabytes and `meta.json` is read for every level that uses the mesh, so a patch's `input` is a summary (`{ "triangles": n, "file": "input.json" }`) and the soup sits beside it in `input.json`.

**Supersede.** A request carrying `object` stops every other queued or running job for that object, unless the job is past its bake: the geometry is then final, the bake is most of what is left, and the result is cached under its own key anyway.
"Past the bake" is the run printing `GENERATOR: bake started` (`blender_build.py` at the start of the texture bake; `editor_patch.py` once the node group has been frozen).
A stopped job's state is `superseded`, and its scratch directory is removed.

**Failures.** `failure.ts` is the fork's `generatorFailure.ts`: the validators' `name: PASS|FAIL ...` lines first, then where the output was kept, then the tail of stderr without Blender's deprecation noise, cut on whole lines at about 1200 characters.
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

## The schemas

Each generator has one parameter schema, `tools/blender/<dir>/params.json`, read by the inspector, by the server's validation and by the Python alike, so a default is stated once.

```json
{ "kind": "boulder", "version": 1, "groups": ["Shape", "Fracture", "Surface", "Material", "Bake"],
  "params": [ { "key": "depth", "type": "number", "unit": "m", "default": 1.6, "min": 0.02, "max": 5, "step": 0.05,
                "group": "Shape", "basic": true, "doc": "The solid's depth through the gameplay plane, centred on it." } ] }
```

- `type` is `int`, `number`, `bool`, `enum` (with `options`) or `color` (linear RGB triple).
- A `number` whose `default` is `null` is blank by default and derived by the generator: the boulder's `tolerance` is `min(0.04 m, 4 % of the square root of the outline's area)` when blank.
- `unit` `m` marks a length (scaled between px and metres by the level format), `deg` an angle, `px` a texture size, `1/m2` a density; the rest are dimensionless.
- `basic` parameters show by default in the inspector; the rest sit under an Advanced disclosure per group.

The two files in this branch are **provisional**: written by the service phase from the plan's lists so the generators had a schema to run against, and replaced at merge by the format phase's, which owns the format.
The Python and the server read them by key at run time, so a replacement with the same keys works unchanged.

Boulders have 73 parameters in five groups; mushroom patches have 25 in four.
The lists, with every default's source in the fork, are the plan's "The parameter schema" section.

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

A request is `{ "kind": "mushrooms", "version": 1, "positions": [...], "params": { ... } }`; the fork's flat shape (`seed`, `density`, ... at the top level) still reads.
`editor_patch.py` merges `params.json` with the overrides, sets every node group socket from `SOCKETS` (`maxTilt` authored in degrees, the socket in radians), and hands the look knobs (`glow`, `paleness`, `capVariants`, `stripeDarken`, the three roughnesses, `textureSize`) to `make_patch(look=...)`.
`maxSlope`, `maxTriangles` and `maxEstimate` act before Blender: the editor filters the surface by slope, the server bounds the soup and the estimated count.
The add-on installs into Blender as one file, so it keeps its own defaults (the sockets' and `LOOK`); `mushrooms/test_params.py` fails when they drift from `params.json`.
The one deliberate difference is `detail`: the fork's editor sent 0.3 where the add-on's panel starts at 0.5.
The OKLab stops and shade tables stay constants; `capVariants` uses the first n of the eight rows.

## Checks

`bun run generators:check` (`scripts/generators-check.ts`) runs, and prints PASS, FAIL or SKIP with a reason for each:

1. **Service cases** (`scripts/generators.test.ts`, `bun test`): request validation, the key shape, the schemas' own defaults, the failure formatter (the fork's three `.test.mjs` files, rewritten), the GLB triangle count, and the queue against a stand-in `python` that behaves like `rockgen.py` without Blender: one job at a time, supersede before and after the bake, cancel, a failure's verdicts.
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
4. Run `bun run generators:check`: the boulder fixture test must stay green (a default that is not the old constant changes the request) and the mushroom test says where a key has nowhere to go.
5. Move the value once through the endpoint and confirm the GLB changes; a knob that does nothing on one outline may be clamped by another (`tipInset` is capped at 0.14 m, so it does nothing on a 1.6 m deep rock until it drops below 0.0875).

## Adding a generator

1. Put its sources under `tools/blender/<dir>/` with a `params.json`, and make its entry point read the schema defaults, then the request's `params`.
2. Print `GENERATOR: bake started` once its result can no longer change, if it should survive a supersede from there.
3. Write `src/server/generators/<kind>.ts` exporting a `Generator` (`run.ts`): its `dir`, `validateInput`, the `request` it writes, what it is `missing`, its `command`, where it leaves the GLB, a timeout and a failure formatter.
4. Add it to `GENERATORS` and to `KEY` in `service.ts`, and to the `/generated` route's pattern.
5. Add its cases to `scripts/generators.test.ts` and its end-to-end run to `scripts/generators-check.ts`.
