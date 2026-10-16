# Plan: the moss clear-of-rock blow-up (Blender frozen on a moss stroke)

Written 2026-10-16, at the end of the session where a moss stroke froze Blender for good.
Investigation was stopped there at Tris's request; this is the hand-over, written so a later session can pick it up without re-deriving anything.
## Outcome (2026-10-16, uncommitted, not yet played by Tris)

Fixed in `tools/blender/moss/build.py`, in two layers.
**A build can no longer hang**: it fails instead, with "not grown: ..." in the moss panel and the last mesh kept.
**The runaway's cause is fixed**: the clear pass no longer feeds on vertices it cannot place (see "The fix").

Measured with [repro.py](moss-clear-blowup/repro.py) on the frozen input:

| | before | after |
|---|---|---|
| case A | never converged (aborted at 28,657 triangles; with a split budget 19,193 and 623 cm² in the rock) | 644 -> 3,502 triangles, 7 s, 23 cm² left about 1 mm deep in a 2 mm crack |
| case B | 336 -> 5,742, 0 cm² | bit-identical |
| SCAN (30 strokes) | 11 past 10x their triangles, up to 2,330 cm² left | 29 grown (25 with 0 cm², the rest at most 24 cm²), 1 fails cleanly (split budget) in 3.3 s; every stroke 3 to 15 s |
| BIG (about the frozen stroke's size) | | 3,362 -> 3,896 triangles, 2.7 cm², 63 s |
| river's Terrace.moss | | bit-identical |
| river's Terrace.003.moss | 4,251 triangles, 0 cm² | 4,233 triangles, 0 cm² (a few vertices six lifts left short now find their place along the crease's bisector) |

Every edit to `build.py` changes `ops._code_digest`, so the first scene export after this rebuilds every moss and re-bakes the rocks carrying a texture-only moss.

## What happened

Tris painted a new moss on river's `Terrace.002` (it joined one more rock: two hosts), ended the stroke, and Blender stopped responding.
`py-spy dump` on the frozen process (it needs `sudo`: Fedora's yama `ptrace_scope` is 1) showed the brush's finish -> `ops.rebuild` -> `build.finish` -> `_print` -> `_charts`.
Its locals, at about 18 minutes in:

- area 2.42 m², 1.78 m² inside the outline; decimate target 2,906 triangles (ratio 0.027 of about 108,000).
- `_clear_of_rock` then reported 1,857,119 vertices lifted and 1,858,831 edges split, and still 1,462 cm² of moss in the rock.
- `_charts` was at chart 643,807 of a mesh of at least 3.72 million triangles.

Three defects, each enough to hurt:

1. **`_clear_of_rock` does not converge** where the mound meets the rock over an AREA rather than along a crease line: it splits everything there down to `CLEAR_SPLIT_MIN` (2 mm). Its cost has no bound but `CLEAR_ROUNDS` and the 2 mm floor. This is the root, and it is NOT understood yet.
2. **`_print` loops forever** when the charts cannot fit `max_texture` at any texel: it coarsens the texel by 1.2 in a `while True`, but a chart's box never shrinks below one texel plus its gutter (`2 * CHART_PAD_PRINTED + 1` = 17 texels square), and 640,000+ such boxes are about 186 million texels against 4.2 million (2048²). So the frozen Blender would never have come back.
3. **`_charts` is quadratic**: `np.nonzero(chart == c)` per chart scans every triangle. Harmless at normal sizes, minutes at millions.

The blow-up cost Tris the work since the 16:51 save; it was recovered from Blender's autosave of the same session (22:02:25, before the stroke), see "Files".

## Reproduce

The frozen input is `assets-src/scenes/river-autosave-2026-10-16-2202.blend` (local, gitignored; `river.blend` was restored from it, sha256 `b88ae43f...`, but will move on as Tris edits).
`river-2026-10-16-1651.blend` beside it is the file as saved before.

```sh
cd rope
BLENDER_USER_CONFIG=$(mktemp -d) blender -b --factory-startup \
    assets-src/scenes/river-autosave-2026-10-16-2202.blend \
    --python plans/moss-clear-blowup/repro.py -- A    # or B
```

[repro.py](moss-clear-blowup/repro.py) creates a moss on `Terrace.002` with `Terrace.003.moss`'s settings (a printed edge), lays one horizontal stroke on its front face exactly as the brush would (rays along +y, the first paintable hit, the brush's default radius 0.25 m, spacing and strength, every paintable mesh within the radius joined), rebuilds with `build.DEBUG` on and prints each clear round and one `RESULT` line.
It aborts once the mound passes `CAP` (env, default 40) times the triangles the pass was given, so it is safe on the shipping code; `CAP=0` lets it run.

Measured on the shipping code, 2026-10-16:

- **Case A** (x 28.3 to 29.5, z -5.4; hosts `Terrace.002` + `Cube.002`): 644 triangles in, 265 meet the rock in round 0, and MORE every round: 368 (round 5), 718 (10), 2,160 (15), 6,618 (20); aborted at 28,657 triangles after 12.7 s. With the patch's split budget it stops at 19,193 triangles with 623 cm² still in the rock (46 s).
- **Case B** (x 24.7 to 25.9, z -3.9; `Terrace.002` alone): converges, 336 -> 5,742 triangles (2,703 splits, 8 per triangle), 0 cm² left, 6.3 s.

A scan of 30 such 1.2 m strokes over Terrace.002's front face found blow-ups (more than 10 times the triangles) mostly in its upper rows (z -4.4 to -3.4), including single-host strokes; most of those converge given room, like case B.
The same evening Tris painted more moss on Terrace.002 alone (one host, a fresh session on the shipping code) and Blender froze again, memory climbing (3.3 to 3.7 GB in 30 s) at 100% on the main thread: a single host is enough in practice, not only in the scan.
For comparison, river's own moss mounds split 0.1 to 1.3 edges per triangle (Terrace.003.moss: 2,132 -> 3,386 triangles, 627 splits, 0.3 s), and 3.9 where Terrace.002 meets Cube.002 (cleared in full).

## What is known about the cause

- **Case B is the decimate, not the rock.** The bad triangles of round 0 have a median longest edge of 0.37 m (0.26 m in case A): the mound is decimated to `mound_density` without regard to the rock under it, so long chords cut through the curved rock and the clear pass has to split the decimation back out where it bends. It converges, at a cost proportional to how much of the decimation it undoes. A decimate that keeps the rock's clearance as a constraint (or prices it in the quadric) would remove most of this work.
- **Case A does not converge, and the bad count grows.** At round 20 the bad triangles are concentrated in one small patch: about 4,000 of 6,600 in 10 cm cells around (29.3 to 29.6, 1.5 to 1.8, -5.4), the mound having grown round onto `Cube.002` behind Terrace.002 (whose y runs -1 to 1). Their centroids sit at a signed distance of median 0.00003 m, 2,056 of them inside. The 108 rock faces they meet are small (median area 2.4e-3 m²), with mean normal (0.46, -0.39, -0.17). Not yet looked at: the rock's shape there (render or dump `hitfaces`), whether its pseudonormals point out there, and whether the lifted vertices are `stuck` (LIFT_TRIES spent) or are lifted INTO a neighbouring face (lifting along one face's outward direction into the next, the fold of [moss-crease-fold.md](moss-crease-fold.md)). The growing count says each split makes new vertices that land in the rock: start there.
- **Ruled out**: formation guide meshes (no guide encloses any of Terrace.002, and the blow-ups happen without one joined); the union of the two hosts being open (it has no open edges; its 136 non-manifold edges are each shared by four triangles where pieces touch, and none is near case A); the ivy (an earlier "ivy joined as a host" result was a bug in the test script, which took the last ray hit when 16 hits were all grown objects; the brush lays no stamp then).
- **Precedent**: `PARITY_STEP` (moss-crease-fold.md) was an earlier runaway of this same pass, from a wrong inside reading.

## Diagnosis of case A (later the same night)

Measured in a git worktree with the guards applied (then a patch; the split budget ended each run), while an export ran from the main tree.

1. **The leftover is vertices `lift` cannot clear, in crevices.** At the end of case A, 10,187 of the 11,866 triangles still meeting the rock have a corner the distance query itself reads as inside (to -4.5 mm). The rock behind them is not thin (median 45 cm). Measured outward from each bad vertex's nearest rock point to the next rock face, 190 of 426 sampled bad vertices stand in an opening narrower than 2 x `top` (9 mm here), p10 1.8 mm; elsewhere 17 of 444. The patch is where `Cube.002`'s chunks meet: the union there has about 20 small faces along a seam at z -5.34, some facing down (an overhang, normal z -0.94) and some facing into it. A vertex needs `height` (up to `top` = clear + `CLEAR_RAISE`) off every wall, which no point in a crevice narrower than 2 x height has; lifting off one wall lands in the other, and after `LIFT_TRIES` (6) it is left where the last lift put it. Traced one at a time at the bare clearance, the same vertices do get out, ping-ponging between two faces over up to 7 lifts.
2. **Splitting feeds it.** Per round, the area of the triangles meeting the rock falls from 15,595 cm² (round 0) to 743 (round 18), then rises again (859 at round 22) while the stuck vertices go 735 -> 2,887. A triangle with a stuck corner counts as bad and is split; split along an edge to the stuck vertex, the midpoint is halfway into the rock and stuck in turn. Splitting can never clear a stuck vertex.
3. **Case B is the decimate**, as above: no stuck vertices at any round, the area in the rock falls monotonically to 0.

Tried, measured and reverted (rope/CLAUDE.md: two failed attempts):

- `LIFT_TRIES` 6 -> 64 (an experiment): stuck vertices 791 instead of 3,597 by round 24, but the area in the rock still turns back up; 884 cm² left.
- **Bridging** (attempt 1): a vertex no lift clears carried out along the sheet normal (`attrs` 1-3, `bridge=`) from where it started, up to 3 cm, until clear. Worse: 1,586 cm² left. The sheet normal there does not lead out of the crevice.
- **Never split an edge to a stuck vertex** (attempt 2): 400 cm² left instead of 623, the minimum 279 cm² at round 30 instead of 743; but new vertices still get stuck (177 -> 1,557 over rounds 30-55) and the area rises again. Case B bit-identical. Part of a fix, not the fix.

Next: give a vertex a target it can reach. Its `height` is infeasible in a crevice narrower than twice it; capping it at half the local opening (the middle of the crevice, measured as in step 1) and accepting the triangles there as clear when their corners are, would end the ping-pong where it starts. Pair it with attempt 2, which stops what is left from spreading, and measure case A to 0 cm² in bounded rounds before anything else. Instrumentation used: a debug line printing, per round, the area of the bad triangles and the stuck count (`stuck.sum()`); the round count alone misleads, as triangles shrink.

## The fix

In `_clear_of_rock`:

- **A vertex goes where it can.** When `LIFT_TRIES` lifts leave it nearer the rock than its `height`, it walks out from its nearest rock point along three ways (that point's outward direction, the outward direction of the wall the first lift reaches, and their bisector), each as far as the open air reaches (a ray, `CLEAR_REACH` 3 cm at most), and takes the first point `height` off everything. In a crease the bisector finds it. In a crevice narrower than twice `height` there is none: the vertex takes the point furthest off both walls and is **cramped**.
- **Never split towards a vertex that cannot be placed.** An edge to a cramped vertex, or to one still in the rock, is never the one split: its midpoint is in the crevice, or halfway into the rock, in turn. A cramped corner counts as raised as far as it goes, so its triangle is still split along its other edges.
- The round loop ends when nothing can be raised or split (it used to spin to `CLEAR_ROUNDS` doing nothing).

The guarantees (any of them fails the build with a `BuildError`, which `ops.rebuild` turns into "not grown: ..." in the panel and the export into a warning):

- `CLEAR_SPLIT_BUDGET`: more than 16 edges split per triangle given (river's mounds split 0.1 to 1.3, the Terrace.002/Cube.002 seam 3.9).
- `BUILD_SECONDS` (300 s; river's builds take 3 to 62 s): `ops.rebuild` runs the growth and finish inside `build.time_limit()`, and the long loops (the clear rounds and lifts, the relax and drape passes, the fold rounds, the growth loop, the print's triangle and chart loops, the area left in the rock) check it. Every loop in the build ends; this bounds the ones that could take long. The export's re-clear on bent rocks (`scene_export.py`) runs inside it too and warns instead of failing the export.
- `_print`: when the charts cannot fit `max_texture` at any texel, a `BuildError` instead of coarsening for good.
- `_charts`: each chart's triangles found once (`argsort` by chart, `searchsorted` bounds) instead of one full scan per chart; bit-identical on synthetic meshes of 125,000 and 245,000 triangles, 3.6 -> 1.8 s and 10.2 -> 3.6 s.

Also (`stampbrush/brush.py`, the brush): `paintable` refuses meshes hidden from render. Formation solid guides (in "Formation recipes", `hide_render`) were joined to mosses as rocks; the scan joined `backdrop.back-wall / guide`, a 782 m³ box, near Terrace.002's left end. Not the cause, but wrong.

Seen with `repro.py`: `LIMIT_SECONDS=5` fails case A with "took over 5 s and was stopped", `BUDGET=2` with "could not be cleared of the rock (1,273 edges split, 2 a triangle at most)".

## Files

- `assets-src/scenes/river-autosave-2026-10-16-2202.blend`: the frozen repro input (Blender's autosave of the session that froze, 22:02:25). Local; keep it while these cases are useful.
- `assets-src/scenes/river-2026-10-16-1651.blend`: river.blend as it was before it was restored from the autosave.
- [moss-clear-blowup/repro.py](moss-clear-blowup/repro.py): cases A, B, BIG and SCAN.

## Open

1. **Case B, the decimate.** The mound is decimated to `mound_density` without regard to the rock, so the clear pass splits it back where it bends: 8 to 26 splits per triangle in Terrace.002's upper row (z -4.4), where one stroke still fails on the budget. A decimate that keeps the clearance (or prices it in its quadric) would remove most of that work.
2. **What is left in crevices** (up to 24 cm², 1 to 4 mm deep) is reported in the panel as moss in the rock; it is in cracks narrower than the clearance, where no clear place exists.
3. **No automated case yet.** The repro needs the frozen `.blend`; a case suite for the moss build would want a small committed rock with a 2 mm crevice.
4. Tris has not painted with it.
