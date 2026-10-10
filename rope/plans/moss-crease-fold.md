# Plan: the moss fold at a crease (the dark wedge)

Written 2026-10-10, at the end of the session that made the printed moss never clip through its rock ([docs/blender-moss.md](../docs/blender-moss.md), step 8, "On the rock").
It is written so the fix can be picked up after the session is compacted, without re-deriving anything below.

## The defect

Tris, in the review file, on Terrace.003's moss by a crease of the wall: a dark wedge with a hard straight edge, the moss's faces there shading near black.
3D cursor on it: **(9.012, -0.6932, -8.844)**, Blender world coordinates, `river.blend`.
The rock is 2.9 mm under the cursor there, its outward direction about (-0.88, 0.01, 0.47): a wall face meeting a steeper one along a convex crease.

It is a **fold**: a few mound faces turned over, facing into the rock, so they shade dark and meet their neighbours along a hard edge.
Measured as "faces within 12 cm of the cursor whose normal faces into the rock" (normal against the rock's outward direction at the face's centre, below 0):

| Mesh | Faces facing into the rock at the spot |
|---|---|
| the old code's mound (as saved in river.blend, grass left out) | 3 faces, 1.0 cm² (2 of them drawn) |
| the new build's full-resolution mound, after the drape | 29 faces, 8.7 cm² |
| the new build after the decimate (into `_clear_of_rock`) | 2 faces, 0.5 cm² |
| the new build after `_clear_of_rock` (what ships) | 8 faces, 7.7 cm² |

So the fold is born in the sheet before the decimate, the decimate mostly hides it, and `_clear_of_rock` brings it back larger.
The likely mechanism of the last step: `_clear_of_rock` lifts a vertex along the ROCK's outward direction, which at a crease is far from the mound's own normal there, so a lifted vertex slides sideways past its neighbours and turns their faces over.

Across whole mounds the new build folds less than the old one (drawn faces facing into the rock, grass left out):

| Moss | Old code (saved mesh) | New build (shipping) |
|---|---|---|
| Terrace.003 | 16 faces, 302 cm² of 4.24 m² drawn | 10 faces, 170 cm² of 4.21 m² drawn |
| Cube.004 | 29 faces, 474 cm² of 0.81 m² drawn | 0 |

The spot is a local regression, and the fold the full-resolution sheet already has is the root to fix.

## Where things stand (shipping, uncommitted)

Tris chose to ship the reviewed state with the wedge and fix it after (option 3).
The full river export with it has NOT been run yet: it was blocked by the permission classifier (it overwrites `public/scenes/river`); Tris runs `just scene ball`, or approves it.
`public/scenes/river` is still the 15:25 export of 2026-10-10 (moss cleared on the straight rock, not yet bent with it).

Uncommitted changes of the session, all in `rope/`:

- `src/render3d/mossMound.ts`: the mound's back faces shaded with the front's normal (black slivers over crests); the lip shading kept.
- `src/shotMain.ts`: `window.__scene3d`, as main.ts has, for live inspection of a grab.
- `tools/blender/stampbrush/hosts.py`: `shells()`; a one-host rock of several closed shells is grown on their union (Cube.004 is 31 overlapping chunks).
- `tools/blender/moss/build.py`: `_Shell`, `_RockDistance` (pseudonormal signed distance per outward shell, ray parity confirming "inside"), `_clear_of_rock` (lift, then raise, then split edges, until no face meets the rock, by `BVHTree.overlap`; optional `weld` for UV seams), `_meets_rock`, `_area_in_rock`, `_split_edges`, `cut_at_print` (+ `in_rock` filter); `Result.in_rock`; `_lift_chords` and the `CHORD_*` constants deleted.
- `tools/blender/moss/mesh_io.py`: `cut_for_bake` / `uncut` (the bake sees each mound cut at its outline), `_in_rock`, `clear_of` (the pass on the finished mesh, UVs carried).
- `tools/blender/moss/__init__.py`, `ops.py`, `settings.py`, `ui.py`: `cut_for_bake`/`uncut` exports; `in_rock` stored, shown in the panel, warned at export.
- `tools/blender/scene_export.py`: the cut swap around the bake; `ob["scene_bows"]` written where the bake bends a rock; `bend_growths` (moss, ivy and formation growth bent with their rocks' bows, moss re-cleared on the bent rock), `hosts_of_names`, `world_mesh`; per-moss `in the rock` log and warnings.
- `docs/blender-moss.md`, `docs/blender-formations.md`: written up.

## Step 1: attribute the fold inside the sheet

The full-resolution mound already folds at the spot (29 faces), so find which of `_mound`'s offsets does it before changing anything.
`_mound` (build.py, the printed-edge branch) builds the sheet in three moves:

1. **laid**: `laid = cv + lay * sheet`, `lay = _spatial_normals(v, t, LAY_RADIUS)` (3 cm), `sheet = floor` (Terrace.003: 1 mm).
2. **draped**: `_drape(laid, lay, ...)`, the membrane bridging steps tighter than `Drape`, the rock as obstacle every `OBSTACLE_EVERY` passes.
3. **piled**: `mv = draped + sn * pile`, `sn = _spatial_normals(draped, ct, PILE_RADIUS)` (8 cm), `pile` up to `floor + lift` (about 9 cm), varying with tone (lighter = taller).

Measure "faces facing into the rock within 12 cm of the cursor" (and whole-mound) after each of the three, by monkeypatching or copying `_mound` in a scratch script (see "Harness").
Expected: the pile.
Offsetting by a height that varies between neighbours, along a direction smoothed over 8 cm that is not the faces' normal near a crease, slides neighbouring vertices sideways by different amounts: the textbook way to invert triangles.
Whatever the answer, state it with the numbers before editing (rope/CLAUDE.md: "No fix before a measured cause").

## Step 2: fix the sheet where it folds

Candidates, by the stage step 1 names:

- **Pile (most likely).** Make the pile offset inversion-free: after computing `mv`, test every triangle's orientation against its draped (pre-pile) orientation (normal dot below 0, or below a small cosine, is a flip); where a triangle flips, lower the pile of its vertices (halve the excess over the neighbours' mean, or clamp the pile difference across each edge to what the edge length and the offset directions allow), and repeat until none flips.
  Equivalent textbook framing: an offset `x + h(x) n(x)` is locally injective while the per-triangle Jacobian of the map stays positive; limit `h`'s gradient where `n` turns.
  Also try offsetting along the draped sheet's own vertex normals instead of `sn` where they differ by more than some angle (the smoothing exists to stop slivers turning, docs step 8, so keep `sn` away from creases).
- **Lay.** The same Jacobian test on `laid`; the lay offset is 1 mm on Terrace.003, so it is unlikely to fold anything.
- **Drape.** If the drape turns faces, the relaxation needs an anti-inversion term (reject a cluster move that flips an incident face).

Keep the textbook rule in mind (rope/CLAUDE.md: "Prefer the textbook").

## Step 3: stop `_clear_of_rock` making folds

Even with a clean sheet, the pass's lift slides vertices sideways at creases.
Measured options (Terrace.003, at the spot / whole mound, straight rock):

| `_clear_of_rock` lift | At the spot | Triangles | Faces meeting the rock |
|---|---|---|---|
| along the rock's outward direction (shipping) | 8 faces, 7.7 cm² | 3,679 (4,491 after the bend) | 0 |
| along the mound's own vertex normal, the rock's direction where they differ by more than ~73 degrees (`LIFT_FACING` 0.3) | 2 faces, 4.4 cm² (3, 6.5 after the bend) | 3,425 (4,093) | 0 |

The normal-direction lift is better on every count but not enough.
Add a **flip guard**: before accepting a vertex move, compare each incident face's normal before and after; if any turns past 90 degrees (or past a smaller angle), do not move the vertex there, and instead mark the incident faces for the split (their longest edge), so the surface gains the vertex it needs to bend rather than folding.
The split already holds a seam together (`weld`); the guard must test faces by point, not by vertex, for the same reason.

## Do not retry (measured 2026-10-10)

- **Unfolding after the fact** (a turned face's corners moved to their neighbours' mean, then lifted clear, each round of the pass): Terrace.003's faces facing into the rock went 24 -> 125 over the rounds, triangles 3,679 -> 5,230, and 8 still met the rock after 64 rounds. Smoothing toward neighbours in a crease pushes points into the rock and the lift then folds them again.
- **A tapered lift** (neighbours of a lifted vertex rise too, fading at 0.25 m/m): folds over 90 degrees 171 -> 148, not worth the shape change.

## Acceptance

All measured with the harness below, grass blades left out of every face count:

- At the spot: no drawn face facing into the rock (the old code had 2).
- Whole mound, drawn faces facing into the rock: at most the shipping build's (Terrace.003 10 faces, 170 cm²; Cube.004 0), and no more on Terrace.002 than now.
- No face meets the rock, on the straight rock (the build) and on the bent rock (after `bend_growths` + `clear_of`), for all three printed mounds.
- Triangles at most about 10 % over the shipping build (Terrace.003 3,679 straight / 4,491 bent; Cube.004 681 / 846 with grass; Terrace.002 6,553).
- Build time: Terrace.003 finish within a few seconds of now (17 s).
- Then Tris looks at a regenerated review file at the cursor before anything else, and only on his go is the full export run.

## Harness (minimal compute: seconds per iteration, never a full export)

Rule from Tris (2026-10-10): isolate the problem and run the least compute that answers it; never a full `just scene` between iterations; ask him before any full export.
Scratch scripts of the session, in the session scratchpad `/tmp/claude-1000/-home-tris-projects-website/8b3af1e1-9412-41f0-8112-71bde3c76341/scratchpad/` (rewrite them from the descriptions if it is gone):

- `fold_origin.py`: grows and finishes Terrace.003 (grass off), captures the mesh into the decimate, into and out of `_clear_of_rock`, and prints faces facing into the rock within 12 cm of the cursor at each stage (about 30 s). Extend it to capture `laid`, `draped` and the piled `mv` for step 1.
- `lift_dir_check.py`: the same build, then whole-mound and spot counts, faces meeting the rock and triangles, on the straight rock and after the bend + re-clear (the rock prepared as the export does: `curve.find_bows`, `curve.rebuild_mesh(..., smooth=True)`, `curve.bend`) (about 35 s). The acceptance numbers come from this.
- `old_turned.py`: the old code's baseline from the saved meshes in river.blend, grass blades left out as connected pieces under 40 vertices.
- `review_blend.py`: writes `terrace003_moss_review.blend` (BEFORE: moss straight on the bent rock; AFTER: bent with it and re-cleared), the file Tris reviews (about 40 s). `terrace003_moss_review_v1.blend` is the reviewed, shipping state.
- `spot_user.py`: on a review file, the faces at the cursor (alpha, facing, clearance) for BEFORE and AFTER, and EEVEE renders of the spot from the game side and from the rock's outward direction into `spots/` (about 20 s). Render engine id in Blender 5.2: `BLENDER_EEVEE`.

Run each as `blender --background <file.blend> --python <script.py>`, `timeout` within 2 minutes, `grep` for the script's own prefix.
Terrace.002 grows in about 50-90 s; leave it to the last check.
Never `pkill -f` (it matched the shell running it); never save over `river.blend` (the review file is written with `save_as_mainfile(copy=True)` into the scratchpad).
