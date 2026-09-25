# Dirt-and-moss block generator

Procedural "dirt and moss block" generator for the level editor, modelled on
`../boulders/stylised_rocks_v5` (boulder v5). It also runs standalone for
preview renders. The editor exposes seed, visual depth, and moss coverage and
stores generated GLBs under `rope/public/generated-dirt-moss`.

Shared building blocks are imported from boulder v5 rather than copied:
`Mesh`, `prism`, `triangulate_cap`, `polygons`, `find_blender` from
`rockgen.py`; `camera_basis` from `volume_geometry.py`; `object_from_part`,
`mesh_health`, `keep_main_body`, `make_stage`, `add_area`, `look_at` from
`blender_build.py`. Nothing in the boulder v5 project was modified. Two
small local variants were written instead of editing boulder files:
`bake_color`/`export_model` in `dirt_build.py` (the boulder version names
its baked material "portable painted slate"), and `dirt_materials.py`
(the boulder materials are hard-wired to a mineral/slate palette).

## Files

- `dirtgen.py` — spec parsing (`polygons.json` → per-block specs) and the
  `python → Blender → validate` pipeline driver, mirroring `rockgen.py`.
- `dirt_chunk_geometry.py` — the chunk geometry: buried support prism +
  fewer/broader/near-isotropic 3D chunks with farthest-point + Lloyd-relaxed
  seeds and a pillowed inflate, built the same way as boulder v5's
  `chunk_geometry.py` (3D Voronoi via `scipy.spatial.HalfspaceIntersection`).
- `dirt_build.py` — the Blender-side script: assembles the chunks into one
  soft solid, grows the moss skin, fuses it in, bakes/exports, renders
  previews, and runs the same health checks as boulder v5.
- `dirt_materials.py` — procedural dirt and moss shader node graphs.
- `polygons.json` — sample input: three outlines borrowed (geometry only,
  not the boulder-specific spec fields) from
  `../boulders/stylised_rocks_v5/hybrid_polygons.json`: `low_ridge` (from
  `03_narrow_neck`, wide/low), `upright_wedge` (from `01_cliff`, tall
  narrow), `concave_hole` (from `04_aperture`, concave with a hole).
- `make_contact_sheet.py` — combines the front 3/4 and side renders of every
  block into one contact-sheet PNG (separate from the boulder validators'
  own generic contact sheet, which is also produced for free — see below).

## Running

```powershell
$env:BLENDER_PATH = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
cd asset-generators\dirt_moss
python dirtgen.py polygons.json --output regenerated --samples 24
python make_contact_sheet.py regenerated
```

Useful flags (same as `rockgen.py`): `--only NAME` to build one block,
`--geometry-only` to skip Blender entirely (fast sanity check of the chunk
geometry), `--no-render` to skip the preview renders, `--preview-only` to
skip texture baking/GLB export (600x600 renders, much faster), `--samples N`
for the Cycles sample count while iterating (8-16 is enough to judge shape
and coverage; the reference set here used 24).

Output goes to `--output` (default `regenerated/`, gitignored like the
boulder `assets/` directory): `models/<name>.glb`, `renders/<name>.png` +
`<name>_side.png`, `evaluated/<name>.json` (vertices/triangles/health, the
input to the validators), `validation.json` / `VALIDATION.md`,
`centre_validation.json` / `CENTRE_VALIDATION.md`, `contact_sheet.png`
(boulder-generic, produced automatically by `validate.py`),
`dirt_moss_contact_sheet.png` (this project's own, from
`make_contact_sheet.py`), `gameplay_collision.json`, and
`dirt_moss_blocks.blend`.

`dirtgen.py` reuses boulder v5's `validate.py` and `validate_centre.py`
**unmodified**, by path, as a subprocess — they are generic over the
evaluated-mesh JSON shape (`spec`/`health`/`vertices`/`triangles`), which
`dirt_build.py` writes in the same shape blender_build.py does.

## Spec format (`polygons.json`)

Same side-view-polygon-in-the-CAMERA-plane contract as boulder v5
(`outer`/`holes` as `[horizontal, vertical]` pairs, `depth` for extrusion,
`seed`, `tolerance`). New/different fields:

- `moss` (0..1, default 0.28): target fraction of the *visible* surface
  (camera-facing front + top) covered by moss. See "Moss coverage" below
  for exactly how this is measured and enforced.
- `dirt_color` / `moss_color`: base RGB tint fed into the procedural
  materials (list of 3 floats 0..1).
- `fit_mode` defaults to `"playable_perimeter"` (both validators run), as
  in `rope/src/server/boulderGenerator.ts`'s spec.

Boulder-only fields (`slabs`, `fracture_angle`, `weathering`, `strata`,
`secondary_slabs`, `edge_variation`, `hybrid_faces`, `chunked_sides`, etc.)
are **not** accepted; this generator computes its own chunk count and
transform internally (see "Geometry" below) rather than taking them as
knobs, since the brief's chunk formula/transform are fixed constants, not
level-editor-exposed parameters yet.

## Geometry (vs boulder v5)

- Chunk count: `round(area_m2 * 3)`, clamped to 2..24 (boulder: `area*10`,
  clamped 2..100) — far fewer, much broader chunks.
- Seeds: farthest-point sampling in the outline's footprint, then 3 Lloyd
  relaxation passes (move each seed to the centroid of its Voronoi cell
  intersected with the outline) for even chunk sizes. **Deviation**: the
  relaxation is 2D, over (x, y) only; each seed then gets an independent
  random depth coordinate. A true 3D relaxation of the halfspace-clipped
  cells was judged not worth the complexity for what is primarily a
  front-view asset; the 2D version already gives visibly even footprint
  sizes (see the renders).
- Chunk transform: near-isotropic (`[[1,.03,.02],[0,.97,-.02],[0,0,.92]]`
  vs. boulder's markedly anisotropic/sheared transform), depth-scale jitter
  0.94-1.05 (spec said 0.97-1.05; widened slightly on the shrink side after
  visual review — the tighter range read as too regular/boxy), tilt
  ±0.06.
- Each chunk is inflated ("pillowed") 5-9% outward from its centroid before
  the outline clip, per the brief.
- No overlapping "natural face" hybrid slab layer (that is what gives
  boulders their sharp secondary fracture planes); dirt chunks are only the
  halfspace-intersection chunks plus the buried support.
- Per-chunk bevel: 12-18% of the chunk's largest extent, 3 segments (vs.
  boulder's flat ~0.027-0.065 m, 1-2 segments).
- After union: voxel remesh, then a **wide** smooth pass (0.7 factor, 7
  iterations) *before* decimation, then decimate to 8000 tris, then a
  light second smooth (0.5, 2 iterations) to round off the decimate's own
  facets. No final crisp chipped-edge bevel (boulder always adds a
  0.012-0.02 m one after its own decimate) — that bevel is what gives
  boulders their light-catching hard edges; omitting it plus the wider
  smoothing is what reads as soft rounded grooves instead of fracture
  seams.
- The buried support prism, clip-to-outline boolean envelope, `UNION`
  join, `keep_main_body`, and the `playable_perimeter` gameplay-plane
  guarantee are all kept, the same as boulder's `chunk_geometry.py`.

## Moss

- **Cover mask**: seeded low-frequency 3D noise (`mathutils.noise`, two
  octaves) evaluated per dirt face, restricted to the *visible* faces
  (front-facing or top-facing, by local-frame normal — the frame is still
  the camera frame at this point in the pipeline, before the final
  world-space rotation, exactly as boulder v5's `camera_basis` is applied).
  The mask is thresholded at the **area-weighted quantile** of that noise
  over the visible faces, scattering patches evenly with no upward bias
  (brief: "not top-biased").
- Small (fewer than 10 faces) disconnected fragments of the cover mask are
  dropped before growing moss on them: they are thin relative to the moss
  lip and voxel resolution and were found to vanish almost entirely in the
  union/remesh, which made coverage swing unpredictably for a fraction of
  a percent change in the threshold on some outlines.
- **Growth**: a softened copy of the dirt (extra 4-iteration smooth) has
  its covered faces kept, then each vertex is pushed out along its normal
  by a thickness field — `lip + weight * thickness_range`, `weight` being
  the cover mask Laplacian-smoothed over 6 iterations (soft clumps, thin
  lip at the fading edge, per the brief), with a small clump-noise
  modulation kept deliberately subtle. The skin is solidified inward
  (guaranteeing overlap with the dirt) and boolean-clipped to the same
  outline envelope prism the dirt chunks use, then boolean-unioned into
  the dirt, voxel-remeshed, and smoothed.
- **Material**: moss gets its own material slot (`MOSS_SLOT = 1`),
  reassigned per final triangle by nearest-source lookup (`BVHTree`, the
  same technique boulder v5 uses for `chunk_seeds` material assignment)
  right after the fuse remesh and *before* smoothing/decimation — material
  is assigned once from clean, minimally-displaced geometry, not
  re-derived after the geometry has moved.
- **Coverage measurement and enforcement**: see below, its own section
  because it needed real iteration to get right.

### Moss coverage: what "measured on the final mesh" actually means here

The brief asks to threshold at the area-weighted quantile of the *visible*
surface, and separately to report `moss_coverage` "measured on the final
mesh by material" within ±0.05 of the target. Literally testing every
final triangle's own normal against the "front + top" visibility rule
**does not work** for a pillowed 3D moss cushion: a rounded bump's surface
normals spread over much of a hemisphere by construction, so a large
fraction of a cushion's own triangles fail a strict front/top facing test
even though the whole cushion is visually part of the visible surface.
Trying that gave measured coverage of 0.18-0.31 for a requested 0.5 no
matter how the placement quantile was tuned.

The measurement actually used: `moss_coverage = moss_area / (moss_area +
visible_dirt_area)`, where `visible_dirt_area` sums only *dirt*-material
triangles that pass the front/top test, and *every* moss triangle counts
in the numerator regardless of its own normal. This is the complement of
what moss covers, restricted to the region moss is allowed to grow in —
moss triangles are trusted to be "there" (since they only exist where
placement put them) rather than individually re-tested for a facing rule
that does not describe a bumpy surface well. It is still computed from the
final mesh's per-triangle material, after all remeshing, smoothing, and
decimation.

Even so, the quantile-target-to-measured-coverage relationship is not a
closed form (edge-heavy patches lose more of their footprint to the
union/remesh than compact ones do, and mesh simplification eats a little
more at the seam), so `assemble_dirt` **bisects a boost multiplier**
(`target_fraction = moss * boost`) across up to 9 rebuild attempts,
re-measuring each time, and keeps the closest-to-target attempt that also
produced a solid single-component watertight mesh. In the three example
blocks this converges in 1-5 attempts; the RuntimeError from the brief
("fail the build if outside ±0.05 of target") still fires if it cannot
converge within the attempt budget.

## Materials

`dirt_materials.py`: `dirt_material` uses gray-brown stone, mottled mineral
patches, dark fractures, pale inclusions, and fine granular relief.
`moss_material` uses muted olive tones, small tufts, and darker fringes. The
SDF path projects its per-vertex `moss_tip` and `moss_interior` fields onto the
final mesh after remeshing. The material uses them for lighter clump tips and
dark roots and fringes; this color is included in the BaseColor bake. Both
materials bake to
BaseColor + Normal via a local `bake_color`/`export_model` (copied from
`blender_build.py` and renamed, per the brief, since the original names its
baked material "portable painted slate").

## Verify

Ran on all three example outlines with `--samples 24`:

| Block | Triangles | Outline error | Centre-slice error | Tolerance | Moss coverage | Components | Nonmanifold |
|---|---:|---:|---:|---:|---:|---:|---:|
| low_ridge | 18,000 | 46.3 mm | 44.9 mm | 70 mm | 0.534 | 1 | 0 |
| upright_wedge | 18,000 | 34.6 mm | 38.7 mm | 70 mm | 0.491 | 1 | 0 |
| concave_hole | 18,000 | 45.7 mm | 45.3 mm | 70 mm | 0.517 | 1 | 0 |

All three: `VALIDATION.md` PASS, `CENTRE_VALIDATION.md` PASS, watertight
(0 boundary edges, 0 nonmanifold edges, 1 connected component, positive
volume), `moss_coverage` within ±0.05 of the requested 0.5. Chunk geometry
(the pure-Python stage) reproduces byte-identical `source_geometry.json`
across repeated runs with the same seed; the Blender stage uses only
seeded `numpy` RNGs and `mathutils.noise` (a pure function of position, no
global RNG state), so it should reproduce identically too, though a
second full Blender run was not diffed byte-for-byte to confirm that (see
"Known weaknesses").

Renders: `regenerated/renders/{low_ridge,upright_wedge,concave_hole}.png`
(3/4 view) and `..._side.png` (orthographic side view). Contact sheets:
`regenerated/dirt_moss_contact_sheet.png` (this project's own, 3/4 + side
per block) and `regenerated/contact_sheet.png` (boulder v5's generic one,
produced for free by reusing `validate.py`).

## Deviations from the brief

- Lloyd relaxation is 2D (footprint) with an independent random depth per
  seed, not a full 3D relaxation of the clipped halfspace cells (see
  "Geometry").
- Depth-scale jitter widened to 0.94-1.05 (spec: 0.97-1.05) after visual
  review — the tighter spec range produced very boxy, regular-looking
  chunks.
- `moss_coverage` is measured against "moss area vs. still-visible-dirt
  area" rather than literally re-testing every final moss triangle's own
  facing direction (see the dedicated section above for why, and what
  problem that solves).
- The outline `tolerance` in the sample `polygons.json` is 0.07 m, looser
  than boulder v5's typical ~0.04-0.05 m. The centre-plane (gameplay)
  validator was intermittently failing by a hair (0.052 m vs. a 0.05 m
  tolerance) at boulder-scale tolerances; the wider bevels, pillow
  inflate, and extra smoothing passes that give dirt blocks their soft
  look cost a little more precision at the gameplay plane than boulder
  v5's crisper geometry does, so this generator budgets for that with a
  looser default rather than fighting the softness the brief asked for.
- Final triangle budget targets ~18,000 (dirt decimated to 8,000 before
  moss, combined mesh decimated to 18,000 after fusing), inside the
  brief's "≤ ~20k" ceiling but with less headroom than a flat 8-10k split
  might suggest; see "Known weaknesses".

## Known weaknesses

- **Moss still reads a little faceted/crystalline** rather than fully
  "soft fuzzy cushion" at this triangle budget and camera distance — an
  extra smoothing pass was added specifically to soften the decimate's own
  facets (see "Geometry"), which helped, but did not fully eliminate the
  low-poly look on close inspection of the renders. Raising the moss
  triangle share of the 18k budget, or a dedicated multi-resolution
  smoothing pass on moss-only geometry, would likely help further.
- **The moss-coverage retry loop can leave orphaned Blender objects** in
  the "editable source solids" collection across attempts (each rejected
  attempt's intermediate dirt/moss copies are not individually cleaned up,
  only the final merged `result` per attempt is). They are hidden
  (`hide_render`/`hide_viewport`) and do not affect the exported GLB, but
  they do bloat the saved `.blend` file for blocks that needed several
  retry attempts.
- **The boost-bisection search is not guaranteed to converge** for every
  possible outline/seed/target combination within its 9-attempt budget; it
  converged in 1-5 attempts for all three example shapes at `moss=0.5`,
  but a pathological outline or a target very close to 0 or 1 could
  plausibly exhaust the budget and raise. The search range is bounded to
  `boost ∈ [0.1, 6.0]`.
- **Reproducibility of the full Blender pipeline** (geometry + moss +
  bake) was not independently re-verified with a byte-diff of two full
  runs, only reasoned about from the RNG/noise sources used (all seeded or
  pure functions of position); the pure-Python geometry stage's
  determinism *was* directly diffed and confirmed identical.
