# Scene export speed: handover

Written 2026-11-13 at the end of one long session, for the next, and brought up to date at the end of the second (the afternoon of 2026-11-13: "What landed in the second session" and the new last row of the table).
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
| Growth pool + split rocks, cold, 15:12 | 308 s (5 min 8 s) | 77 s | `bun run scene:export ball`, installed in `public/scenes/river/`; Cube.002 and Cube.005 regenerated, so with creases and chips now |

The 15:12 run (the real command, 386 s wall in all): 57 s growing (22 growths in 11 workers, the floor Terrace.moss at 53 s and Terrace.005.moss at 52 s), 227 s for the workers (34 objects, 5 rocks split into 22 map tasks), 14 s loading, bending and writing; 83 MB, 3,385,895 triangles, 51 colour and 50 normal maps.
The worker stage did not shrink with the splitting: it is bound by the total work, not one rock (the GPU over 50 % busy in 70 of its 226 s, VRAM at most 10.1 GB), and it now carries Cube.002's and Cube.005's creases and chips.
Its log is `scratchpad/export.log` and `gpu.csv` of the second session (`/tmp/claude-1000/-home-tris-projects-website/95355890-7b19-4ee6-8f77-07cdfc8f3a10/scratchpad/`); the scene files it replaced are in `scene-before/` there.

The 14:21 run, 415 s: 172 s growing, 225 s for the workers to prepare and bake all 35 objects, about 15 s loading their results, bending and writing the glTF (3 s of it the write).
Its maps matched the serial run's to a median of 0.001/255 rms (the most 0.5/255, occlusion meeting unprepared neighbours), but for Terrace.007, which had an exact duplicate in its place ("Terrace.007 / new", since deleted).
GPU memory peaked at 9.1 of 12.3 GB; the GPU was over 50 % busy in only 78 of 417 seconds, so it is not yet the limit.
Logs and profiles: `/tmp/claude-1000/-home-tris-projects-website/e15a457c-2562-490c-adb9-020f20b7174f/scratchpad/exportprof/` (`cold2.log` + `cold2.prof` serial, `cold3.log` + `cold3.prof` workers, `gpu3.csv`); scratch can vanish, so the numbers above are the record.

Commits, all on `main`: `fc10ad9` (native kernels and everything before, plus website-f2's models work), `74ea7fb` (packer prune), `6db959a` (chip cutters grid), `96dc8e7` (bake workers), `d283da8` (GPU slots, worker mosses, map names), `0540fff` (this file).
The second session's work is the commit after `0540fff` ("scene export: grow in workers, split many-map rocks, publish river"), with the 15:12 river export and river.blend published (`just publish`); the river.blend before Cube.002 and Cube.005 were rebuilt is `river-before-rebuild-2026-11-13.blend` in the second session's scratchpad.

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

- Cube.004 and .007 (the old solid generator's rocks, their guides 6-face boxes) have `export_creases` and `export_chips` set False (Tris's choice until they are regenerated).
- Cube.002 and Cube.005 were regenerated in the second session (`backdrop.py --render NAME export_creases=auto,export_chips=auto --rebuild Cube.002,Cube.005 --save`): 183,676 and 292,862 faces, the depth-of-field rule deciding their creases and chips again.
- "Terrace.007 / new" (an exact copy of Terrace.007, same transform and mesh) deleted with its guide and placement (Tris: "get rid of one of the duplicates"); the previous file is `river.blend1`.
- Headless saves drop zero-user data: the 30 old backdrop picture images went at 11:58 (copy of the file before: `scratchpad/river-before-toggles-2026-11-13.blend`).
- `public/scenes/river/` holds the second session's 15:12 export (`bun run scene:export ball`, not published).

## What landed in the second session

All uncommitted; each measured, and checked against what it replaced.

- **Cube.005's build is not slow**: 82 s profiled from its recipe (`formations/assemble.py` under cProfile), not 900 s. Of it, `remove_degenerate` took 20 s: each `bmesh.ops.collapse` costs as much as the whole 290k-face mesh, 210 calls 25 s. It now collapses in batches of edges whose one-rings no earlier edge of the pass touches (an edge that waits holds back those near it, so the order stays shortest first): 1.0 s, the same mesh to the vertex.
- **Solid rocks failing "must be watertight"**: Blender's Manifold boolean is not deterministic (the solid's first union, `thicken`, came out 7505 or 7502 vertices on the same input), so the rock differs from run to run, and three of four Cube.005 builds failed. The final Triangulate leaves fins (a sliver triangle whose other two edges are its own, hanging off an edge of three faces); `assemble.drop_fins` deletes them first. Verified on a dumped failing mesh: one fin, then closed. A Cube.002 build failed "must have nonzero volume and faces" once in ten and was not caught again (open).
- **The growth workers** (`tools/blender/growth_pool.py`; docs/blender-scenes.md "The growth workers"): every ivy and stale moss grown in factory-startup Blenders side by side, from picklable jobs (`ivy.ops.build_job`/`grow_job`/`apply`, `moss.ops._Inputs.job`/`grow_job`/`apply`/`export_plan`/`apply_grown`), the hosts' union taken in the worker (`stampbrush/hosts.py` `host_parts`, `parts_key`, `surface_of`). Growths on the same hosts go to one worker in turn. Every grown mesh and print byte for byte the serial growth's (41 compared; the 42nd, Terrace.005.moss's print, the serial run kept and did not load). The moss `built_key` now hashes the hosts' triangles before their union, so every moss rebuilds once. Unpainted ivy and moss skip the union (`ivy.build.grows`, `moss.build.has_paint`).
- **Moss print**: `outline_texels` asked `Dab.u` 886k times one dab at a time; `moss.build._Shapes.covers` asks all of a dab's neighbours at once. Terrace.moss and Terrace.003.moss bit for bit as before.
- **Split rocks** (`SPLIT_MAPS`, 2; docs/blender-scenes.md "Split rocks"): a rock of several maps is prepared by one worker, which writes it back with no maps and says `[scene_worker] split NAME COUNT`, then makes its detail geometry (`formations/detail.py` `detail_geometry`, `save_geometry`, `load_geometry`); each map is a task of its own, baked with the other maps' images 1 x 1 stand-ins, and `run_workers` gathers the maps into one entry. Maps against an unsplit run: 0.001 levels rms, at most one, the same as two unsplit runs differ. A worker remembers each object's original materials (`PRISTINE`, the `.original`s: the evaluated ones die at the next evaluation) for a later map of a rock it has already worked on.
- **Workers run with `--python-exit-code 1`**: one whose Python raised exited 0 before, and only a missing file said so.
- **Native background fill** (`native/src/fill.cpp`, `native.fill_background`): bit for bit the numpy pull-push on maps from 1 x 5 to 4096 x 4096; 0.26 s a 4096 map against 0.66 s.
- Pyflakes is clean on every file touched (`uvx ruff check --select F`); the nine findings were older (unused imports and locals in ivy/build.py, moss/build.py, formations/detail.py, and `last` in `moss.build._relax`, read before assignment as pyflakes sees it).

Measured and not changed: one Cycles bake call of Terrace.012's eight colour maps 35.5 s, eight calls of one map 41.5 s (5.2 s each); a bake session holds about 2 GB of the card whether it bakes one map or eight, so splitting does not allow more GPU slots. `im.pack()` of a 4096 map 0.66 s, whatever `quality` (Blender 5.2's PNG writer ignores it). Terrace.012 alone in one worker: 108 s (Cycles calls 47 s, detail 30 s of which `crumple` 14 s and the cutters 9 s, unwrap 10 s, fill 8 s, packing about 7 s); 225 s among the others.

## Next steps, in order

1. **Cube.004 and Cube.007**: Tris moves them back, then they are regenerated like Cube.002 and Cube.005 (ask first). Their ivy and moss on Cube.004 have paint but grow nothing, and still take its 31-shell union: 22 s and 27 s, one after the other in one worker, because the ivy and the moss import `stampbrush` as two packages, each with its own union cache (`hosts._unions`). Share the cache (a module both reach) or compute the union once in `growth_pool` and pass it in the job.
2. **The worker stage is bound by its total work** (227 s, 8 workers, GPU busy 70 of 226 s): eight mostly single-threaded Blenders on 32 threads. Levers, largest first: (a) more workers, if memory allows (a worker held up to 5.8 GB on Terrace.012; 60 GB in all, and the main Blender, the dev server and Chrome beside it; GPU slots stay at 4 for VRAM); (b) `crumple` and the cutters native or threaded (Terrace.012 22 s of its 30 s detail; 137 s summed over the scene in the serial run); (c) overlapping growth with the workers' preparation (only the Cycles bakes need the grown plants: strips, creases, unwrap and detail geometry do not), which hides most of the 57 s of growth; (d) Blender's per-texel cost in the bake call (about 310 ns a texel for one 4096 map; no profiler can attach here, `perf` is not installed and ptrace is limited to ancestors, so run Blender under gdb to see inside it).
3. **The growth floor is the moss build** (Terrace.moss 53 s, Terrace.005.moss 52 s in the export): profile Terrace.moss again now that `outline_texels` is vectorised; `_grow` (the dab placement, 23 s cumulative before) and `dab_shape`/`solidity` (6 s) were next.
4. **Overlap the tail (Phase 5)**: maps go to the encoder as they are baked, as raw pixels rather than PNG round trips, and a direct glb writer; touches `blendExport.ts` (website-f2's).
5. **Caching, last.**

## How it was measured

- Full cold export to scratch, profiled, wall-clock stamped: `scratchpad/exportprof/prof.py` run as `blender -b river.blend --python prof.py -- out.glb meta.json` with `SCENE_EXPORT_DOF='{"maxBlur":0.016,"focusBand":1.5}'` and `PROF_OUT`; launch it with `setsid nohup` (a session restart killed one run), sample `nvidia-smi --query-gpu=timestamp,memory.used,utilization.gpu --format=csv,noheader -l 1`. Then `bun run scripts/optimize-asset.ts raw.glb opt.glb --keep-nodes --keep-hierarchy --baked-maps` for the encode.
- One object, per stage: `scratchpad/exportprof/bench.py` (exec's `scene_export.py` minus its trailing `main()`, wraps `bpy.ops` and functions with timers; env `OB`, `SAMPLES`, `OUT`).
- `scene_export.py` calls `main()` at import, so tests exec its source minus the last line; `bpy.ops.uv` is a fresh object on every access, so wrap ops through a proxy `bpy` in the exec'd module's globals.
- Kernel A/Bs against the committed version: `git archive HEAD rope/tools/blender/native` into scratch and import it as another package (`scratchpad/native/pack_same.py`).
- Worker parity: `scratchpad/native/worker_smoke.py` (env `W`, `NAMES`, `OUT`) bakes rocks with and without workers and saves their maps.
- Second session (its scratchpad, above): `bench/bench_one.py` (one object as a worker bakes it, stage timers; env `OB`, `OUT`), `bench/split_test.py` (rocks through `run_workers`, maps saved; env `OBS`, `OUT`, `SCENE_EXPORT_WORKERS`, `SCENE_EXPORT_SPLIT_MAPS`), `bench/split_exp.py` (one bake call against one a map), `grow_test.py` (`grow_painted` on a copy of the scene, every grown mesh and print hashed; `SRC` picks the tree), `mossab/` (one moss built by two trees from the same pickled inputs), `stagehash.py` (assemble.py with a hash of the mesh after every modifier; `DUMP=1` saves the triangulated mesh), `fill_test.py`.
- A worker can be driven by hand: save the scene (`bench/snap.py`), then `printf "NAME\nNAME\t0\n" | blender -b snap.blend --python-exit-code 1 --python tools/blender/scene_export.py -- --worker DIR`.

## Open issues

- Every Blender run that registers the repo's ivy/moss/formations/foliage add-ons prints `unregister_class` tracebacks at exit, because the installed extensions (`~/.config/blender/5.2/extensions/user_default/`) are enabled in the same Blender; harmless, new since the morning (Tris enabled them), not yet silenced.
- Most formations warn their growth is stale and every solid formation is listed as "edited but not rebuilt": the generator's fingerprint (`formations/worker.py`) changed with this morning's solid generator, so `--rebuild changed` would rebuild them all; rebuild by name.
- The bake-cache key is unchanged by the workers; a warm export with workers was not run.
- The worker snapshot saves in 0.1 s; it works (maps match), but nobody has checked why it is that fast.
- Solid rocks failing validation at random: root-caused and fixed after the second session's commit (Blender's triangulate re-making existing edges; `solidfit.triangulate`, docs/blender-formations.md), with Cube.005's runaway Voronoi cells (`solidfit.Cells` completion, docs/blender-backdrop.md); Cube.002 and Cube.005 rebuilt with both.
- `foliage-atlas-v1.png`, `ivy-clump-atlas-v3.png` and `ivy-cutout-atlas-v7.png` have no credit (`tools/blender/image_credits.json`).
