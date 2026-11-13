# Scene export speed: handover

Written 2026-11-13 at the end of one long session, for the next.
The plan it follows is the "Scene export speed plan" doc (https://claude.ai/artifact/99uSSUeRkCEgBu9irU2cFU), whose Progress section was kept current until the Docs connector dropped.

## The goal and Tris's rules for it

- A full export of the river scene (`bun run scene:export ball`, the level that names `river`) in under a minute.
- "Don't rely on caching for the optimization - focus on actual performance improvements by making the most use of my powerful GPU and CPU"; "caching should be the last step once you've done everything else".
- Large structural changes and other languages are fine; quality, robustness and maintainability over development cost.
- Ask Tris before running a full export; test one object or one step at a time otherwise (memory: Minimal compute per iteration).
- Show visual changes as they render (the game, or the shaded result), never as texture-space crops: UV gaps and the background fill read as artefacts (memory: Show the actual render).
- Machine: Ryzen 9 9950X (32 threads), RTX 4070 SUPER 12 GB (OptiX), Blender 5.2 at `~/.local/opt/blender-5.2.0-linux-x64/blender`, g++ 15 with OpenMP, no Rust toolchain.
- Standing rules: no em dashes; Bash timeouts at most 30 s (long runs in the background); never `pkill vite` or `pkill -f` a pattern your own shell matches; never `git checkout levels/*.json`; never `git stash`; edit source with the Edit tool; commits carry no co-author line.
- Another session (website-f2) owns `rope/scripts/blendExport.ts` (the shared export flow behind `scene-export.ts` and `model-export.ts`); message it before changing that file.

## Where it stands

| Run | Blender | Encode | Notes |
| --- | --- | --- | --- |
| Morning, cold | 11,044 s (3 h 4 min) | 271 s | before any change |
| Serial, cold, 13:20 | 1,590 s (26 min 30 s) | 81 s | native kernels, before the packer prune and the workers |
| Workers, cold, 14:21 | 415 s (6 min 55 s) | (81 s) | 8 workers, 4 GPU slots |

The 14:21 run, 415 s: 172 s growing, 225 s for the workers to prepare and bake all 35 objects, about 15 s loading their results, bending and writing the glTF (3 s of it the write).
Its maps matched the serial run's to a median of 0.001/255 rms (the most 0.5/255, occlusion meeting unprepared neighbours), but for Terrace.007, which had an exact duplicate in its place ("Terrace.007 / new", since deleted).
GPU memory peaked at 9.1 of 12.3 GB; the GPU was over 50 % busy in only 78 of 417 seconds, so it is not yet the limit.
Logs and profiles: `/tmp/claude-1000/-home-tris-projects-website/e15a457c-2562-490c-adb9-020f20b7174f/scratchpad/exportprof/` (`cold2.log` + `cold2.prof` serial, `cold3.log` + `cold3.prof` workers, `gpu3.csv`); scratch can vanish, so the numbers above are the record.

Commits, all on `main`: `fc10ad9` (native kernels and everything before, plus website-f2's models work), `74ea7fb` (packer prune), `6db959a` (chip cutters grid), `96dc8e7` (bake workers), `d283da8` (GPU slots, worker mosses, map names).
Uncommitted when this was written: this file only.

## What landed

### The native kernels (`rope/tools/blender/native/`)

- C++17 and OpenMP, called from Blender's Python through ctypes on numpy arrays (`__init__.py`); built by `build.py` (or `bun run native:build`) into `native/build/librk-<hash>.so`, named by a hash of every source and flag, built on first use when missing, checked against `rk_source_hash` on load. `build/` is gitignored.
- Vendored: CDT 2.0.2 (`third_party/cdt`, MPL-2.0, headers). xatlas was tried and removed (its packs overlapped).
- `bows.cpp`: the crease bow field (`curve.field`, `curve.sizing`) through a grid over the bows' reach boxes; same field as the numpy one to 1e-16.
- `crease.cpp`: `curve.rebuild` end to end (merge, sliver folding, edge cuts, patches, jittered grid, constrained Delaunay, triangulation of n-gons, ear clipping where a projected outline crosses itself). Merge is transitive (union-find) and drops opposite-winding pocket pairs (a duplicate face made `detail.crumple` fail on Terrace.002). Terrace.012 186 s -> 1.5 s; non-manifold edges and slivers at parity or better than the Python. `curve.rebuild_mesh` carries every face/point/edge attribute across by source index.
- `bvh.cpp`: a binned-SAH BVH; `seen_faces` rays on every thread (Terrace.012 10.4 s -> 0.65 s, same faces); `hits()` for the detail bake.
- `pack.cpp`: the UV packer: islands rasterised conservatively on a 1024 grid (`PACK_GRID`) in four quarter turns, dilated so texel squares keep the gap, bottom-left first fit, scale bisected; two exact prunes (each row's longest free run; a per-texel free-square map capped at 64 against each mask's inscribed square). Coverage 0.75 to 0.81 against Blender's 0.55 to 0.62; Cube.004 (9,061 islands) 237 s -> 7.5 s with identical UVs. One map per thread, the maps side by side (`scene_export.unwrap`).
- `detail_bake.cpp`: the detail normal map without a boolean or Cycles (`detail.normal_maps`). It reproduces Blender's selected-to-active bake read from `bake.cc` and `object_bake_api.cc` (sources were fetched to `/tmp/claude-1000/blsrc/`): the cage extruded along interpolated VERTEX normals on smooth faces (face normal on flat ones), the nearest high-poly surface within `RAY_DISTANCE`, its flat normal turned to face the ray, tangent space from corner normals and MikkTSpace tangents, the flat normal (0.5, 0.5, 1, 1) on every texel with no hit, in an island or not. The high poly is solved along each ray as the crumpled rock's inside intervals less each cutter's interval (from every crossing to the far side: a ray can start inside the crumpled rock). Cutters come in as their exact half-spaces (`detail.cutter` returns them); planes taken off the convex hull's faces were noise on sliver faces. Final normal maps 1.3/255 rms from the old path.

### The export (`rope/tools/blender/scene_export.py` and friends)

- Bake workers (`run_workers`, `worker_main`, `gpu_slot`): after growing and loading cache hits, the scene is saved to a temp `.blend` and `WORKERS` (8, `SCENE_EXPORT_WORKERS`) worker Blenders take objects off a queue largest first (`work_estimate`), prepare and bake each, and write it as a bake-cache entry (`bake_cache.write_entry`); the export adopts it as a cache hit (`adopt`) and keeps it in the cache when there is one (`Cache.adopt`). Protocol: a worker prints `[scene_worker] ready`, the export writes the next name or closes stdin; only `[scene_export]` lines (not `ships`) are forwarded. At most `GPU_SLOTS` (4, `SCENE_EXPORT_GPU_SLOTS`) hold a Cycles bake at once (flock'd lock files); eight at once reached 11.6 GB. Each worker gets `OMP_NUM_THREADS` of cores / workers.
- `bake_pass` passes `use_clear=False`: cleared, a one-object bake writes the flat normal at alpha 1 over every gap so the background fill skipped them; a several-object bake drops the clear itself.
- `bake_cache.load` clears the image's path once packed: the glTF exporter names a PNG by its file, whose slash is escaped.
- `moss.prepare_texture_paints(scene, host_names)`: a worker computes only its rock's texture mosses (and passes only those).
- `BAKE_SAMPLES` 32 -> 8 (Tris saw no difference: https://claude.ai/artifact/2j4E9oa9N15KQ5RC3h7SQL).
- `render.UV_COVERAGE` 0.6 -> 0.75 (Tris: "good"): 627 M -> 576 M colour texels, four rocks a map fewer.
- `detail.crumple` puts sub-facet points onto the plane's own faces (Tris: "fix it"): Terrace.007's texels meeting the detail 91.3 % -> 99.6 %.
- `detail.build_cutters` tests overlap against a grid of placed chips (same chips; Terrace.012 20.5 s -> 8 s).
- `--all-seen` (for website-f2's models), part of every bake key.
- `optimize-asset.ts` gives the encoder `UV_THREADPOOL_SIZE` = cores (255 s -> 63 s on 115 maps, byte-identical).
- Depth-of-field rule for strips/creases/chips (`render.setting`, the High DoF); it gives backdrop and solid rocks creases they lacked, so the scene has 3.2 M triangles against the Nov 12 export's 2.0 M (backdrop.roof 13 k -> 585 k).

### river.blend

- Cube.002, .004, .005, .007 (the old solid generator's rocks) have `export_creases` and `export_chips` set False (Tris's choice until they are regenerated).
- "Terrace.007 / new" (an exact copy of Terrace.007, same transform and mesh) deleted with its guide and placement (Tris: "get rid of one of the duplicates"); the previous file is `river.blend1`.
- Headless saves drop zero-user data: the 30 old backdrop picture images went at 11:58 (copy of the file before: `scratchpad/river-before-toggles-2026-11-13.blend`).
- `public/scenes/river/` holds the 13:20 serial export (installed by hand, not published; the Nov 12 files are in `scratchpad/scene-backup/`). It predates the variant's deletion.

## Next steps, in order

1. **Regenerate the old rocks** (Tris asked, after the workers run). `blender -b assets-src/scenes/river.blend --python tools/blender/backdrop.py -- levels/ball.json --list` shows the solid formations; `--rebuild Cube.002,...` rebuilds through the Formations worker, `--save` saves. Tris: Cube.004 and Cube.007 have large flat faces near the gameplay plane and he will move them further back himself, so ask before rebuilding those two. Cube.005 "timed out at 900 s" earlier, but the 900 s was the earlier session's own script, not the add-on; its guide has 5,358 vertices and Tris does not see why it should be slow: time and profile its build (`formations/worker.py`, `solidfit.py`) before anything else. After a rebuild, delete the rock's `export_creases`/`export_chips` ID properties so the depth-of-field rule decides again. Check that Tris's Blender does not have river.blend open before saving (it had at 10:43).
2. **The worker stage's critical path is Terrace.012** (8 maps of 4096): its preparation ends at 211 s, its colour bake, detail and normal bake keep one worker busy to about 400 s while the others finish by about 380 s. Splitting a many-map rock over workers (its maps baked side by side) or starting it first with the other workers' queue arranged around it is the lever. Per-object times are in `cold3.log` (forwarded worker lines are wall-clock stamped).
3. **Growth, 172 s, all serial before any bake** (the bakes see moss and ivy; plants are hidden): moss rebuilds (Terrace.moss 59 s when its rock changed; `moss/build.py`), multi-host ivy and moss unions on Blender's EXACT boolean (`stampbrush/hosts.py _union`, 46 s ivy + 20 s moss), and texture-only mosses grown when painted (now inside the workers). Growths are independent of each other: grow them in parallel processes, and move the unions to Manifold or native code.
4. **What is left per object in Python**: `crumple` (62 s summed over the rocks), `cutter` geometry, Smart UV Project, `mark_strips` (17 s), `fill_background` (29 s), PNG packing of every map, and Blender's own per-texel handling around each Cycles call (about 170 ns a texel, single-threaded).
5. **Overlap the tail (Phase 5)**: maps go to the encoder as they are baked, as raw pixels rather than PNG round trips, and a direct glb writer; touches `blendExport.ts` (website-f2's).
6. **Caching, last.**

## How it was measured

- Full cold export to scratch, profiled, wall-clock stamped: `scratchpad/exportprof/prof.py` run as `blender -b river.blend --python prof.py -- out.glb meta.json` with `SCENE_EXPORT_DOF='{"maxBlur":0.016,"focusBand":1.5}'` and `PROF_OUT`; launch it with `setsid nohup` (a session restart killed one run), sample `nvidia-smi --query-gpu=timestamp,memory.used,utilization.gpu --format=csv,noheader -l 1`. Then `bun run scripts/optimize-asset.ts raw.glb opt.glb --keep-nodes --keep-hierarchy --baked-maps` for the encode.
- One object, per stage: `scratchpad/exportprof/bench.py` (exec's `scene_export.py` minus its trailing `main()`, wraps `bpy.ops` and functions with timers; env `OB`, `SAMPLES`, `OUT`).
- `scene_export.py` calls `main()` at import, so tests exec its source minus the last line; `bpy.ops.uv` is a fresh object on every access, so wrap ops through a proxy `bpy` in the exec'd module's globals.
- Kernel A/Bs against the committed version: `git archive HEAD rope/tools/blender/native` into scratch and import it as another package (`scratchpad/native/pack_same.py`).
- Worker parity: `scratchpad/native/worker_smoke.py` (env `W`, `NAMES`, `OUT`) bakes rocks with and without workers and saves their maps.

## Open issues

- Every Blender run that registers the repo's ivy/moss/formations/foliage add-ons prints `unregister_class` tracebacks at exit, because the installed extensions (`~/.config/blender/5.2/extensions/user_default/`) are enabled in the same Blender; harmless, new since the morning (Tris enabled them), not yet silenced.
- Cube.004's growth warns it is stale (its rock changed after its growth was planted).
- The bake-cache key is unchanged by the workers; a warm export with workers was not run.
- The worker snapshot saves in 0.1 s; it works (maps match), but nobody has checked why it is that fast.
