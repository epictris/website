# Offline formation depth chunks: in-game prototype

These are isolated preview tools; the production exporter does not import them.
The accepted experiment is now integrated through `formations/depth_lod.py`,
`formations/depth_budget.py` and the existing surface generation/export passes.
See [production documentation](../../../docs/blender-scenes.md#offline-depth-budgets).

## Production integration check

`production_preview.py` runs the actual partition, atlas allocation, chip and
sub-facet generation, and surface bake on the extracted cave rock. It retains
original illumination UVs; crease deformation is disabled only for this visual
check because moving the surface would invalidate that comparison. The small
`../test_depth_lod_export.py` regression exercises creases, baking, cache reload
and final child-mesh export together. The preview is 128 near texels/metre,
one sample and CPU-only; it is below production texture quality.

From `rope/`, after preparing the original snapshot described below:

```sh
timeout 360s env OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 taskset -c 0,1 nice -n 10 blender -b --factory-startup --disable-autoexec -noaudio -t 2 --python-exit-code 1 --python tools/blender/lod_prototype/production_preview.py -- /tmp/river-lod-source-cave.json public/generated/lod-production
taskset -c 0,1 nice -n 10 bun tools/blender/lod_prototype/capture.ts /tmp/river-lod-production-review --production
python3 tools/blender/lod_prototype/comparison.py /tmp/river-lod-production-review
```

The generation benchmark is separate (`../benchmark_depth_lod.py`). It compares
identical authored geometry at uniform foreground detail and automatic depth
budgets, with no texture bake. A final optional face limit defaults to 12000;
250000 includes the complete cave rock. Neither tool saves the source scene.

For the roof construction check, `../benchmark_construction_build.py` rebuilds
one real solid into a separate directory. Pass the scene path, `Cube.006` and an
output directory after `--`, using two low-priority CPU cores and a timeout.
Extract `Cube.006` from the reference GLB with `extract.mjs`, then pass the
generated `rock.blend` as a third argument to `production_preview.py`, targeting
`public/generated/lod-roof`. Capture with `capture.ts <review-dir> --roof`.
This renders the genuinely regenerated geometry in the game. Reference lighting
UVs are projected onto the new surface, so illumination is approximate until a
real scene export. Regenerated geometry runs the complete production crease,
five-degree smoothing, strip and chip passes, at 512 near texels/metre and
eight bake samples. Atlas sides are capped at 2048; additional atlases
preserve the requested density. Reference UVs are projected after the finish,
so they cannot interfere with the actual crease rebuild. This is intentionally
more expensive than the original one-sample geometry check, which omitted
the smoothing and fine surface finish visible on the foreground rocks.
`view_sampling.py` restricts full-density visibility to these four fixed views;
occluded/off-screen faces keep the normal hidden density. The entire roof stays
present for shading and occlusion. Production exports retain their visibility
over every camera pan; this preview allocation does not change that policy.
Use `capture.ts <review-dir> --roof --assets=/generated/<alternate-directory>`
to compare an independently prepared variant without replacing the old assets.
When the GPU is available, `production_preview.py ... --gpu` bakes one atlas
per burst, with 1.5-second pauses and the same two-core preparation limit.
Add `--unrestricted` when those resource limits are no longer needed: CPU
preparation uses the available cores and GPU bursts have no artificial pause.
Constructed Cube.005 previews use the cave camera positions; Cube.006 uses
the roof positions. Both retain full production surface passes.
For Cube.005, `--contact` frames the foreground platforms and the background
wall together, plus the reported empty-wall view. Its camera positions are stored in the preview manifest
and used by both texture visibility and the game viewer. Use the same flag
for both sides of a comparison so the cameras and texture budgets agree.
Other targets become 1-pixel stand-ins during each burst; the whole mesh
remains an occluder. Without this flag the bake stays on the CPU.
`comparison.py <review-dir> --previous <earlier-review-dir>` adds the earlier
adaptive preview as a before image, alongside the original scene export.

`--diagnose` also captures plain materials, unshadowed shading and vertex
normals, separating geometry folds from maps and self-shadowing. Optional
`--probe=x,y` arguments record the visible meshes hit at capture-pixel positions.
Automatic solid roofs run the production crease-fold repair before the rebuild
and bake; the full construction recipe is retained so this eligibility check
matches a normal export. Broad crease bows are chosen before the repair, keeping
unrelated curves unchanged.

The complete roof finish also exercises spatial cuts followed by chip tangent
baking. Multi-axis cuts can create pentagons; `surface_subdivision.py` now
tessellates these with their corner attributes intact before either bake.
`test_surface_subdivision.py` checks the oblique-cut case, UVs, area, normals
and tangent computation.

## Real cave comparison

`viewer.html` mounts one modified **Cube.005** from the river scene in the actual
`Scene3D` renderer. It uses High DOF, the 70 mm gameplay lens, zoom `2 / .65`,
1920 × 1080 output, frozen time, original lighting and the original lightmap UVs.
Four camera positions show the cave bank and wall. Simulation Y is downward;
the cave bank camera is `(61.7, 0)`. No animation loop runs.

The three useful comparisons are:

- Original exported formation.
- Depth chunks with the original textures: isolates geometry/splitting changes.
- Depth chunks with a fresh, bounded production-slate surface bake: previews
  finer foreground texture allocation and coarser distant allocation. **This
  changes material scale too, so it is not a controlled equivalence test.**

A fourth diagnostic colours the depth regions. The source is already exported
geometry; the prototype cannot restore fine chip geometry removed upstream.
The fresh bake includes slate colour, AO and bevel normals, but no regenerated
high-poly chip/detail pass. It uses one Cycles sample and colour-map caps of
2048/2048/1024/512/256, with half-size normal maps. These preview caps undershoot
the policy's full foreground density. All chunks share world material
coordinates and remain present as occluders. No artificial cut caps are added.

The source snapshot is isolated at `public/scenes/lod-prototype-reference` and
the preview level at `public/generated/lod-prototype/level.json` refers to it.
These ignored assets must be prepared from one completed river export before
running the tools. Do not copy files while that export is replacing them.

From `rope/`, with the snapshot already prepared:

```sh
taskset -c 0 nice -n 10 bun tools/blender/lod_prototype/extract.mjs public/scenes/lod-prototype-reference/scene.glb /tmp/river-lod-source-cave.json Cube.005
python3 tools/blender/lod_prototype/prepare_actual.py /tmp/river-lod-source-cave.json public/generated/lod-prototype
python3 tools/blender/lod_prototype/run_bake.py public/generated/lod-prototype /tmp/river-lod-source-cave.json
taskset -c 0,1 nice -n 10 bun tools/blender/lod_prototype/capture.ts /tmp/river-lod-review
python3 tools/blender/lod_prototype/comparison.py /tmp/river-lod-review
```

Open `/tmp/river-lod-review/index.html` for a server-free wipe comparison. Or
serve `tools/blender/lod_prototype/viewer.html` with the existing Vite dev server
for direct rendering. The capture command starts and cleans up its own local
server/browser; its network sandbox must permit localhost. It uses one frozen
frame per selection, not continuous gameplay. Its repeated reference capture
must be pixel-identical before `comparison.py` writes the report.

The actual rock measured 201,840 source triangles → 211,502 after cutting →
189,094 after simplification. Two chunks retain their cut geometry because the
boundary check rejected their simplified result. Exact position welding of a
quantized exported mesh can expose malformed topology; this is why the failure
must be explicit rather than silently accepting cracks. Partitioning took
0.35 s; complete preparation took 20.3 s on one core. The one-sample surface
bake plus UV work took 45 s on two low-priority cores, with **no GPU baking**.
These are prototype timings, not savings over the production generation path.
The source texture averaged only about 44 texels/metre, so the geometry control
does not further reduce it: doing so would not test the proposed density policy.

The final bake mesh now gets a second UV overlap check **after** the production
unwrap transfers its welded-copy charts back. The first visual preview missed
that step: a tiny face's transferred corners spanned another chart, overwriting
the near rock with a dark triangle and streaks. `repair_final_uvs` projects
distorted slivers and overlapping final triangles into separate planar charts,
repacks, and refuses to bake if overlaps remain after its bounded repair passes.
It verifies actual intersection area, ignoring shared edges and float32 rounding
slivers below 0.001 layout texel². Edit-mode checks use disposable mesh copies
so Blender cannot rotate the final mesh's corner order. It does not alter geometry,
normals or illumination UVs. The manifest records repaired-face counts.
`capture.ts --diagnose` provides colour-only and normal-only controls for this
failure. Rebaking starts from `chunks-before-bake.json`, avoiding cumulative
re-unwrapping of already expanded preview geometry.
New bake images and buffers have unique generation names; the manifest switches
to them only after every chunk completes, preserving the last complete preview
if a later attempt fails.

Very small bake targets cannot fit all of the exported mesh's repaired UV
islands. The preview lays out charts at a minimum 1024 resolution and samples
the distant maps more sparsely. Production integration must remove imperceptible
detail before creating those islands. The first eight-sample bake did not
complete; only the complete one-sample result is published in `chunks.json`.

## Synthetic boundary checks

From the repository root:

```sh
python3 -m unittest discover -s rope/tools/blender/lod_prototype -v
python3 rope/tools/blender/lod_prototype/run.py --output /tmp/formation-lod-example
```

Use a fresh output directory. The experiment writes `prototype.blend` and
`report.json`. The blend contains one formation parent with five child chunks,
the unchanged reference hidden beside them, preserved original UVs, and custom
normals. Viewport Object colours distinguish the chunks; they share one material.
The scene has no baked textures or render camera.

The launcher pins Blender and its simplifier child to **one CPU core**, lowers
process priority, limits numeric-library threads to one, and sets a 90-second
timeout. It uses a synthetic fixture below 10,000 triangles, never loads a level,
and performs no rendering, texture baking, native compilation or scene export.
Dependencies are the existing Blender, Bun and `rope/node_modules/meshoptimizer`.
It uses temporary Blender user resources, not the artist's settings. Some sandbox
configurations block Blender's audio-thread shutdown even with `-noaudio`; use
the normal approved command execution environment if it times out after success.

## What it establishes

- `budget.py` reads High DOF and the focus band from the runtime TypeScript.
  The demo camera is explicitly synthetic: 10 m from the plane, tan(FOV/2)=0.15,
  evaluated at 2160 lines. World Y is depth behind the gameplay plane.
- Detail follows the larger of the projected pixel footprint and one eighth
  of the world-space blur diameter. Power-of-two bands round **toward more
  detail**. Each band's near side sets its quality; camera panning has no effect.
  A closer zoom or a different maximum supported resolution requires replanning.
- Geometry error starts at half a sharp pixel; texture density starts at the
  existing 512 texels/metre. Each successive band doubles permitted error and
  halves texel density. These are conservative starting hypotheses, not a proved
  perceptual threshold. Normal/UV weights and all thresholds still need in-game
  High-DOF image comparisons.
- `surface.py` cuts triangles at the band boundaries. Each crossing on a shared
  edge is computed once, including edges shared by hard normals or UV seams.
  Cutting preserves surface area, material IDs, `facet` values and interpolated
  corner normals/UVs. It adds **no internal caps**. Work follows input triangles
  and actual intersections, rather than making a whole-mesh copy per band.
- `simplify.mjs` processes all chunks in one Bun invocation using the existing
  meshoptimizer. Absolute error and locked borders keep their joins compatible;
  attribute seams stay protected. It does not force a triangle-reduction ratio.
  The normal weights (0.05) are experimental, while UV weights are 1.0.
- The demo checks shared positions, edge topology, UVs and normals before/after
  simplification, and checks Blender readback under a nonidentity/nonuniform
  authored transform. Whole-surface edges must have exactly two incident faces
  with opposite winding. It measures Blender custom-normal storage error
  separately from the shared boundary contract.
- Each output mesh keeps the source coordinate frame and marks cut boundaries
  with the Boolean edge attribute `lod_partition_edge`. These cuts must never
  become artificial bevels, chipped edges or painted creases in a later finish.

## Interpreting the measurements

`report.json` records partition time, simplification time including process/JSON
overhead, per-band triangle counts, peak Blender RSS and estimated texel demand.
It distinguishes original triangles from the extra triangles introduced by cuts.
Texture estimates are **surface area x density squared**, without atlas packing,
padding, mip chains or compression. They are not measured bake-time savings.

The initial tests show that boundary splitting is cheap on the small fixture,
but cuts themselves add triangles. A coarse 6,192-triangle fixture initially grew
to 6,526 after splitting/simplification; geometry savings are not automatic.
The current fixture samples its corrugations more densely along depth to exercise
actual simplification. Preserve the original count comparison when assessing it.

The one-core run on 2026-11-21 produced five chunks: 8,224 source triangles,
8,480 after cutting, and 7,842 after simplification (4.6% fewer than the source).
All 128 shared boundary edges survived. Partitioning took 14 ms and the
simplification invocation including JSON/process overhead took 94 ms. Blender
peak RSS was 317 MiB. Estimated texture samples fell from 101.8 M to 17.4 M
(82.9%); this is not an actual texture bake or a visual quality measurement.

The synthetic detailed source is a test oracle. This experiment does **not** prove
that real formation generation or export is faster, and its timings do not
include Blender startup/shutdown or saving unless explicitly labelled.

## Production integration still required

1. Plan depth bands from the guide before expensive detail work. Preserve one
   deterministic stone layout and one procedural material coordinate frame.
   Keep formations within one band on the existing inexpensive path.
2. Partition the coarse assembled surface, then finish each region at its own
   resolution while honouring the shared boundary contract. The current final
   whole-rock uniform voxel remesh must be replaced; placing this splitter after
   that pass would save no generation work. The existing solid generator requires
   closed guides, so these uncapped chunks cannot simply be fed back into it.
3. Shared boundary positions and shading must remain protected through all local
   refinement/displacement, not only simplification. Any shared boundary detail
   must be generated once at the more demanding side's quality. The prototype
   does not yet implement a boundary-preserving adaptive voxel remesher.
4. Give the detail passes and texture allocator explicit per-chunk budgets. Do
   not reuse `detail_scale` to implement this: today it also changes physical
   material lengths. Allocate smaller charts **before** material evaluation;
   preserve filtered average colour/normal information rather than dropping all
   sub-blur features. Keep enough chart padding for the required mip range.
5. Preserve formation hierarchy/growth attachment, include the policy/camera in
   cache keys, and ensure cuts never affect bevel/AO/crease painting. This demo
   only carries normals, UV layers, material indices and the `facet` attribute;
   it is not a general arbitrary-Blender-attribute transport yet.
6. Compare High-DOF renders and generation/export wall time on a representative
   large formation, plus an all-foreground control. Include split overhead and
   memory. No full-resolution regeneration or scene export was run for this
   first prototype, to leave resources for the user's in-progress export.
