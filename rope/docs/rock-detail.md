# Rock detail

The 2026-10-03 study that took the painted slate rocks from flat planes to the stylised stone of Tris's references, and what of it ships.
The illustrated review, one section per cycle with every render Tris judged, is a Claude page, [Rock Detail Study](https://claude.ai/artifact/Bh7BAkdLrtuCitnXjSUwWh); it is not versioned with the code, so when the two disagree this page wins.
The look it builds on is the painted slate of [cave-look](cave-look.md).

## What ships

Three things, all deterministic in the rock's seed, none of them in the shipped mesh:

| What | Where it is made | How the game gets it |
|---|---|---|
| Sub-facets and chips | `tools/blender/formations/detail.py`, built by the export from the rock's own mesh | a tangent-space normal map baked from that high poly onto the rock's unwrap (`bake_detail_normals` in `scene_export.py`) |
| Occlusion gradient | the painted slate shader, `formations/slate.py` | baked into the colour map with the rest of the stone |
| Dots and ticks | the painted slate shader | baked into the colour map |

The export repaints every painted slate material to the add-on's current shader before baking (`repaint_slate`), as it regrows the ivy and moss, so a file saved before the shader last changed still ships the current stone.
The pale Bevel edge line the slate carried since 2026-10-01 is gone: Tris rejected every edge wear the study tried (below).

### Sub-facets

The references' "patches" are not noise: enlarged, every big plane is three to six near-coplanar triangles whose edges run corner to corner, each a few degrees off the plane, flat shaded.
That is what a low poly looks like before planar decimation merges its near-coplanar triangles, and the formations recipe decimates planar at 9 degrees, which is exactly where the detail dies.
Cycles 7 to 9 of the study drew patch outlines with noise and Voronoi cells and read as camouflage or mosaic whatever the warp.

`detail.crumple` retriangulates the high poly's planes.
Faces are grouped into visible planes by region growing (within `PLANE_ANGLE` 10 degrees of the region's running normal; a small region bordered by one large one is absorbed, so a bump inside a plane is no hole).
Every edge longer than 1.5 spacings is split to the spacing, in both its faces, so the mesh stays closed and no boundary stretch fans into slivers.
Each plane gets interior points on a jittered hexagonal grid at `SPACING` (10 cm; smaller planes finer, down to `SPACING_MIN`; a narrow plane the grid misses gets one point at its deepest spot), and is triangulated from its boundary and those points by a constrained Delaunay (`mathutils.geometry.delaunay_2d_cdt`, holes respected by dropping the triangles inside them).
Every interior point steps a full half-spacing times tan(`TILT`) in or out, `TILT` 0.5 to 1 degree, never a spread in between: neighbours at the same level merge into one flat patch of a few triangles, neighbours at opposite levels meet at the full tilt.
A spread left most neighbours under a degree apart and the structure vanished.
Outward steps are capped at `PROUD_MAX` 4 mm, inside the bake's 5 mm cage.
A plane whose projected boundary crosses itself (a zigzag of sub-millimetre dissolve slivers) is left flat; about a tenth of the Terrace's surface.

Tris picked the size and tilt from sweeps: 5, 10, 15, 20 and 28 cm at one tilt (cycle 12), then 10 cm at 0.25 to 4 degrees (cycle 13).
Under a key light from above a given tilt reads about half as strong as under a low key, since the lit tops sit near the cosine's flat top.

### Chips

A chip is a flake knocked off a convex crease: the rock above two planes through the chip's deepest point, each tipped along the crease so it comes back out of the rock at one end, so the chip closes at both ends with no walls (`detail.cutter`).
Chips sit on creases sharper than `CREASE_MIN` 18 degrees, denser up to `CREASE_FULL` 40, `DENSITY` 8 per metre of fully sharp crease, 3 to 17.5 cm long on a power law (many small, few large), at least 0.4 times as wide as long, biased toward one face (a plane near the bisector is a bevel and reads as rounding).
The bias is bounded: each side of the chip's plane is at least `BIAS_MIN` a quarter of the crease angle off its face (and `MIN_BITE` 8 degrees), the near side at most `BIAS_MAX` 0.4 of it.
At the 8 degree minimum alone (cycles 1 to 24) a chip leaning toward the shaded face left a sliver a quarter as wide as its length on the lit face, dark along every lit crease and two texels wide in the game: on the exported Terrace 222 of 302 chips, median 8 mm, the worst 4 cm by 5 mm.
With the quarter bound the narrow side is about 40 % wider (median 11 mm, the worst aspect 7:1 instead of 9:1), which thins the slivers without removing them: the sliver is the chip's floor on the face it leans away from, and its aspect is the chip's length against that width.
Stubbier chips (at most 10 cm long, 0.6 to 0.9 as wide as long) would halve the worst aspect (16 mm median, 4.6:1 worst); skipping chips whose narrow side comes under 1.5 cm would drop about two thirds of them.
Neither is applied; Tris's call.
A chip never reaches a concave crease (the cut would leave a pit), never overlaps a chip from another crease (a deeper chip in a shallower one digs a pocket), and every cutter is its own boolean operand with the manifold solver (joined, overlapping cutters left fragments standing in the chips).
The chips are cut into the crumpled rock along the original creases, so the sub-facets never move a crease.

Tris sized them at half the first attempt (cycle 2) and confirmed the layout at cycle 3.
Chips chained end to end along a crease (cycle 5), long shallow "bends" that kink a crease (cycle 6) and cracks wandering off a crease (cycle 4) were all rejected; the study's `chips.py` keeps them behind flags.

### The bake

`bake_detail_normals` builds the high poly per rock (the Terrace: 125 of 136 planes, 2279 points, 303 chips, 11.8 k faces, under a second), stands it at the rock's world transform, and bakes `NORMAL` selected-to-active onto the rock's `SceneBake` unwrap from `CAGE` 5 mm outside the rock inward to `RAY_DISTANCE` 8 cm, then removes it.
The image is the export's usual size (256 texels per metre up to 2048, so about 258 on the Terrace) and goes through the same background fill and lossless WebP as any baked normal map.
A rock that came in through glTF is split at every face, so the bake source is welded first; the shipped mesh is untouched.

### Occlusion gradient

In the references every face shades off toward its bottom and toward the join with the rock below it, lighter near the lit corner.
That is occlusion by the surroundings at a scale of metres, which the game cannot compute, so it is in the colour: an Ambient Occlusion node reaching `OCCLUSION_REACH` 1.5 m multiplies the stone from `OCCLUSION_TONE` 0.7 at full occlusion to 1 in the open.
What Cycles sees occludes, other exported objects included.
The study's Terrace stands alone on its page, so the study baked it over a ground plane; in the river the floor and the neighbouring rocks do that.
Tris picked this (cycle 18 A) over a stronger one and over a painted height term.

### Marks

The references' lit faces carry a dozen tiny light dots and a few short dark ticks each, and nothing else.
Each is a Voronoi cell grid with most cells thrown away, so the survivors land at random: a dot is its cell's centre disc, a tick the same on a grid stretched along a turned direction, so it is a short stroke.
The grids are 2D, laid on the plane facing each face's dominant normal axis: a 3D grid's feature points sit anywhere in a 3D cell, so a face only cuts a mark where the point lies within millimetres of it, and the first pass showed almost nothing.
Both only multiply the stone (`DOT_LIGHT` 1.18, `TICK_DARK` 0.78), so a mark keeps the stone's hue.
Every mark takes its size from its own cell's random (`SIZE_VARY`, half to one and a half times) and its strength likewise (`STRENGTH_VARY`); the dots sit on two grids (round and slightly oval), the ticks on three (stretched 3, 5 and 7 times along three headings); and each mark's edge wobbles by `DOT_WOBBLE` 20 % of its radius (ticks 12 %) under a noise of `WOBBLE_SCALE` 60 per metre, so no dot is a circle.
Tris chose the density (cycle 19 B, half the first), the sizes (cycle 20 B, dots 2.2 cm, ticks 1.3 cm wide), asked for the variety (cycle 20) and set the wobble (cycles 21 to 23: 35 % lumpy, 55 % frayed, 12 % too tame, 20 %).
At 258 texels a metre a dot is five or six texels and a tick three or four wide.

## The light

The warmth in the references is a strong warm light from above on a dark slate, not a warm stone (Tris, cycle 7 and again at cycle 11).
The study's review rig was calibrated against Tris's second reference, sampled by region (lit tops about (160, 140, 106), fronts in shade (48, 52, 61), sky (50, 81, 108), sRGB), by `measure.py` in five damped passes correcting the key and the sky per channel: key (1, 0.527, 0.095) at 18.6 W/m² from (0.35, 0.05, 1), sky (1, 0.964, 0.771) at 2.22, ACES view transform, giving lit (162, 142, 111) and shade (47, 52, 61).
What that says about the slate: the sky fill had to go nearly neutral and about four times stronger than the first rig, because the bluish albedo supplies the shade's blue by itself, and the key deep orange to turn that albedo tan.
The in-game lights have not been matched to this yet (see Open).

## Rejected

| Attempt | Cycle | Why |
|---|---|---|
| Chips chained end to end | 5 | the zigzag was not the unevenness meant |
| Bends kinking long creases | 6 | not the kink meant |
| Cracks | 4 | "forget cracks for now" |
| Albedo colour blocks (Voronoi, noise-wobbled) | 7 | "camouflage": patches that ignore the forms |
| Light-driven blocks: Voronoi cells tilting the normal | 8 | "weird mosaic", straight cell edges |
| Posterised noise and warped cells tilting the normal | 9 | the patches are triangles, not noise (above) |
| Sub-facets fanned from one to four points | 10 | long thin triangles "look unnatural" |
| Sub-facet heights as a spread | 11 | most neighbours under a degree apart; the structure vanished |
| Edge wear: two steps toward a pale slate, then one subtle step, then a geometric mask that followed each chip's rim, then a 5 mm line | 7 to 16 | "I don't like them. Remove them completely." |
| Occlusion at 50 %, and a painted height term toward the base | 18 | A, the 30 % occlusion alone |
| Marks on 3D grids | 19 | almost nothing showed (above) |
| Perfect discs, then 35 % and 55 % wobble | 20, 21 | not perfect circles; 35 % lumpy, 55 % frayed |
| Chips biased to 8 degrees off one face | 1 to 24 | a dark sliver on the other face along every lit crease ("this weird spike"); bounded to a quarter of the crease at cycle 25 |

The edge wear is worth a line more, since it was built four ways.
The mask from Blender's Bevel node only sees turns past about 20 degrees, so it crossed a chip's shallow rim untouched; the geometric mask (the distance of each texel to the nearest worn edge on the chipped high poly, through a position bake) followed the rims, and a per-vertex distance lit whole triangles on a 10 cm mesh.
A multiplier of 1.15 on these tones is under 10 sRGB and vanished under the ACES shoulder; an added constant showed.
All of it is in the study's `paint.py` behind `--wear 1`.

## Lessons

- Measure, then judge: the study's `measure.py` composites a render over the reference's sky and samples the rock by luminance band, and `--against` a control render reports how many rock pixels a change touches and by how much, split into lit tops and dark fronts.
  Three of the study's corrections (invisible wear, invisible ticks, the occlusion bake shadowed by the high poly) were numbers before they were pictures.
- A bake source left in the scene shadows the next bake: the detail high poly sits on the rock's surface and must be removed before any ambient occlusion is baked.
- The planar dissolve leaves sub-millimetre slivers along creases; a plane's boundary can cross itself in projection, and a constrained Delaunay then invents vertices.
  Check for sourceless output vertices and leave the plane alone.
- In zsh a quoted string of flags is one argument: pass flags to a shell function as `"$@"`.

## Open

- The in-game key and sky have not been matched to the calibrated rig: the river's lights still light the slate as before the study.
- The sub-facets, chips and marks are verified on the Terrace in the study's EEVEE rig and in one export; the other river rocks and the grotto have not been looked at under them.
- A 5 mm wear line or a 1 cm tick is under two texels at the export's density; marks that thin would need a higher-resolution bake for the rocks or a runtime distance-field line.
  Nothing that ships is that thin now.
