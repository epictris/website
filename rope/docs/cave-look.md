# The cave look study

A record of the 2026-10-01 study that replicated Tris's cave asset sheets in Blender, feature by feature, and then redid the rock geometry and the rock surface until he picked a look.
The moss carpet followed on 2026-10-01 and 2026-10-02, and its final state became the moss add-on ([blender-moss](blender-moss.md)).
This page is the durable version: every number, every attempt that was dropped and why, and where the bytes are.
The illustrated review is a Claude Doc, [Cave Asset Sheets: Blender Replication Report](https://claude.ai/code/artifact/5c4cbc08-0037-4a98-828a-6fdb9067132c); it is not versioned with the code, so when the two disagree this page wins.

## Where everything is

| What | Where | Versioned by |
|---|---|---|
| The scripts | `tools/blender/cave-sheet-study/` (`cave_features.py`, `rock_study.py`, `rock_compare.py`, `moss_study.py`, `moss_compare.py`, `compose.py`, `grid.py`) | git |
| The moss add-on the study became | `tools/blender/moss/` | git |
| Tris's crop of rock-a's crown, the moss reference | `tools/blender/cave-sheet-study/out/moss/ref_crown.png` | nobody yet (see Open) |
| The 11 reference sheets and the 3 texture crops | `assets-src/studies/cave-sheets/sheets/`, `.../texture/` | the release, pinned in `scripts/sceneSources.json` |
| The sheets Tris reviewed (reference beside render) | `assets-src/studies/cave-sheets/review/` | the release, same pin |
| Renders | `tools/blender/cave-sheet-study/out/` | nobody: gitignored, rebuilt by the scripts |

The references and the reviewed sheets are stored exactly as the Blender scenes' sources are (see [asset-store](asset-store.md) and [blender-scenes](blender-scenes.md)): `just sources` fetches them, `bun run assets:publish-sources studies/cave-sheets/<path>` publishes a new one, and the pin says which bytes a commit meant.
They are not in git because a 25 MB folder of pictures in history is permanent and a release asset is deletable; they are not left loose because the renders only mean something beside the pictures they were judged against.
The reference sheets and crops are Tris's own concept art for the game.

## Reproduce

```sh
just sources                                   # the references, once per machine
cd rope/tools/blender/cave-sheet-study
blender -b --python rock_study.py -- --variant pillow --corners 14 --bevel 0.08 --round 4 \
    --big 0.05 --big-scale 1.5 --grit 0.004 --cuts 80 --cut-depth 0.025 --cut-tilt 0.15 \
    --target 1200 --angle 9 --material plain --albedo v6 --spec 0.1 --light v6 --key 3600 \
    --views 3q,front,side,top --save
python3 rock_compare.py                        # out/rock/cmp_*.png, reference beside render
blender -b --python moss_study.py -- --geom layers --views 3q,front,close   # the moss on rock-b, out/moss/
python3 moss_compare.py                        # out/moss/cmp_moss.png and the colour bands
blender -b --python cave_features.py -- --out out && python3 compose.py out   # the first pass, all seven features
```

The geometry is deterministic: the same flags give the same vertices in any process (hash them to check; the PNGs differ run to run because Cycles' sampling does).
Rock-b, the test piece, builds in 1.2 s and renders in about 2 s on the GPU.

## The chosen look

Recipe F for the geometry, the painted slate shader under the v6 light rig for the surface, both picked by Tris on 2026-10-01.

### Geometry, recipe F

One box per stone, from `LAYOUT` in `rock_study.py` (centre, half-size, yaw, metres).
Rock-b is five boxes and a loose pebble; the boxes overlap by about the margin the corner cuts remove, so the finished stones meet and the seams read as fissures.
Then, per stone:

1. **Corner cuts**, `corner_cuts`, 14 per stone (`--corners 14`).
   Each picks a vertex, takes the direction from the centroid, tilts it by a seeded random unit vector scaled 0.3 to 1.0 times `--corner-tilt 0.5`, places a plane 24 to 60 percent of the smallest half-size in from the vertex (`--corner-depth 0.6`), bisects with `bmesh.ops.bisect_plane` (`clear_outer`), caps the hole with `holes_fill` and recalculates normals.
   Vertices in the bottom 40 percent are skipped so the stone keeps a flat base.
2. **Weathering**, `pillow`: a Bevel modifier of 8 percent of the smallest half-size, 6 segments, angle limit 30 degrees (`--bevel 0.08`), a voxel remesh at 2.5 cm, 4 iterations of the Smooth modifier at factor 1 (`--round 4`).
3. **Chisel**, `plane_cuts`: 80 cuts per metre of the stone's largest half-size (`--cuts 80`), each 1 to 2.5 cm deep (`--cut-depth 0.025`), the plane tilted off the face normal by at most 0.15 (`--cut-tilt 0.15`), 60 percent of upward faces skipped so tops stay shelves; then a voxel remesh at 2 cm and 2 Smooth iterations (`--cut-soft 2`).
4. **Relief**, `chisel_field`: each vertex moves along its normal by a 5 cm noise at scale 1.5 (`--big 0.05 --big-scale 1.5`) plus 4 mm of grit at scale 25 (`--grit 0.004`); no crackle domes (`--dome 0`).
5. **Facets**, `facet`: Decimate Collapse (triangulated) to about 1200 triangles per 0.8 m of stone size (`--target 1200`), Decimate Planar at 9 degrees with All Boundaries (`--angle 9`), flat shading, and a random `facet` float per face for the shader.

Rock-b ends at 6 objects, 678 faces, 1566 triangles.

### Surface, the painted slate shader and the v6 rig

`mat_plain` in `rock_study.py`, Object coordinates throughout:

| Node | Setting | Role |
|---|---|---|
| Principled BSDF | roughness 0.95, Specular IOR Level 0.1 (`--spec 0.1`) | matte; the Bevel node's normal feeds Normal |
| Mix of two colours by a Noise (scale 0.9, detail 2) | `#2f3546` cool, `#3b3e4a` warm (`--albedo v6`) | a slow drift across the block |
| Attribute `facet`, Map Range to 0.92 to 1.08 | multiplies | a slightly different tone per facet |
| Noise scale 35, detail 3, Map Range to 0.96 to 1.04 | multiplies | faint grain |
| Noise scale 1 behind a Mapping scale (3, 3, 0.7), Map Range 0.35 to 0.65 onto 0.75 to 1 | multiplies | soft vertical stains |
| Ambient Occlusion distance 0.5 m, 8 samples, Map Range onto 0.55 to 1 | multiplies | crevices darken |
| Bevel node radius 3 cm, 8 samples; dot with the true normal, Map Range 0.995 to 0.92 onto 0 to 0.35 | mixes toward `#5c6070` | the pale line on facet edges |

The v6 rig (`--light v6`), on the study stage from `cave_features.build_stage`:

| Light | Position and aim | Colour | Energy |
|---|---|---|---|
| Key, 3 m area | (-1.9, -2.4, 8.6) aimed at (0, 0, 0.8) | (1.0, 0.74, 0.45) | 3600 W (`--key`) |
| Fill, 5 m area | (4.5, -3.5, 2.5) | (0.45, 0.6, 1.0) | 150 W |
| Rim, 3 m area | (1.0, 4.5, 4.0) | (0.6, 0.75, 1.0) | 90 W |
| World | | (0.008, 0.014, 0.03) | 1 |
| Ground | 20 m plane | `#141a21`, roughness 1 | |

View transform AgX Base Contrast, exposure 0, Cycles OptiX, 64 samples at 640 px for the review renders.

The Bevel node and the Ambient Occlusion node are Cycles only and neither exports: for the game the edge line and the crevice darkening have to be baked to vertex colour or a texture.

### Moss, the dab-painted mound

Settled with Tris over many rounds on 2026-10-01 and 2026-10-02 in `moss_study.py` (`--geom layers`), then ported to the moss add-on, which is now the reference implementation; [blender-moss](blender-moss.md) has every step and setting.
In short: the painted area is packed with dark concave polar-blob dabs (3.2 to 5 cm), an uneven erosion field scores how deep each point sits in its patch, five layers of smaller, lighter dabs grow clump by clump at that field's summits, each kept a buffer inside the one below, and every dab takes one flat tone from the field and its layer, quantised to 8 steps spaced in sRGB with no per-dab randomness so neighbours merge into blotches.
The geometry is one low-poly mound per rock (about 1500 triangles per square metre), 8 mm proud under the darkest moss and up to 9 cm more under the lightest, scaled down on walls, sunk 6 mm under the rock at its rim; the dabs are printed onto the mound's own texture at a 1.5 mm texel with a crisp 2 mm edge, on a matte Principled BSDF (roughness 1, no specular).

The reference is a soft mottled pillow, sampled shade (60, 81, 52), mid (102, 128, 72), lit (148, 172, 86); Tris's crown crop added "patches of light moss that spread out radially, fading to darker moss - not random blotches", "very matte", height tapering to almost nothing at the edges, and colour in blotches, "never as a smooth gradient".
The lightest tone is (154, 169, 77).
Under the v6 rig the albedos are the reference colours times the gains in `out/moss/calib_v6_agx.json` (dark 0.507/0.689/1.176, light 0.308/0.481/0.391, the light then pulled by (0.9, 0.92, 0.6) to the swatch).

## What was tried and dropped

Every row is still runnable: the base forms and light modes stay in `rock_study.py` so a dead end is a command, not a memory.

### Geometry

| Attempt | Recipe | Why dropped |
|---|---|---|
| A | Convex hull of 34 random points in a superellipsoid, planar 15 degrees (the first pass, `cave_features.build_cluster`, `--variant hull`) | Crystalline wedges, 8 to 14 razor faces, a loose pile |
| B | Icosphere, cloud vector displace plus normal turbulence, collapse, planar 25 degrees (Greg Zaal's 2013 recipe, `--variant zaal`) | The right facet scale but round pebbles, no shelves |
| C | Cube, bevel 40 percent, voxel remesh, smooth (`--variant pillow --bevel 0.4`) | Still boxes |
| Crackle domes | C plus Voronoi crackle (F2 minus F1) domes 5 cm high at 30 cm cells (`--dome 0.05 --cell 0.3`) | Crumpled paper |
| Fracture | One pillowed mass split into Voronoi cells by bisector planes between seeds, each cell pillowed and treated (`--variant fracture`) | Cells come out as wedges and shards, the seams open |
| D | C plus 14 corner cuts | The first boulder read, too smooth |
| E | D plus 5 cm noise, collapse and planar facets | Stylised boulders, too few facets |
| G | F plus 1.5 cm crackle domes at 45 cm cells, 2000 triangles, planar 8 degrees | Tris: "too complex" |

### Surface and light

The references, sampled by region: fronts near (33, 42, 59), lit tops between (148, 132, 87) and (173, 149, 110).
Each pass was judged by sampling the render's brightest 8 percent of rock pixels (lit) and its 40th to 60th percentile band (mid) with numpy.

| Pass | Change | Why dropped |
|---|---|---|
| Mosaic | Voronoi cells at 8 cm with pale seams, per-cell tone, Bevel edge light (`--material stone`, the first pass) | Wrong in kind: the references have no pattern |
| v1 to v2 | Warm tan albedo `#8f887b`, then `#6b655b`, under the study lights | Chalky and soap-like |
| v3 to v5 | Neutral dark albedo `#44464a`, a warm area key raised to 55 then 70 degrees, dim blue fill, dark ground | Close, but the base had to be cooler and darker |
| v7 to v8 | Overhead area key, strong blue fill, Standard view transform | The whole scene brown: the key reached the tilted fronts and the ground bounce was warm |
| v9 to v11 | Sun lamp plus a blue sky world, near-black ground, sun to 60 W/m2 (`--light warm`) | Still brown fronts: the ground's rough specular bounced the sun onto them |
| v12 | Specular 0 everywhere, orange sun (1.0, 0.62, 0.3) from behind-left | Lavender tops: blue albedo times orange light |
| v13 | Yellower sun (1.0, 0.72, 0.2) | Olive |
| v14 | Sun straight behind, hue (1.0, 0.66, 0.22) | Tan tops at (177, 161, 127), but the shade a navy far darker than the reference |

### Moss

Each surface below is still a `moss_study.py` flag (`--surface`, `--geom`); the later steps of the layered carpet are only in the script's history.

| Attempt | Recipe | Why dropped |
|---|---|---|
| Sludge | The first pass's voxel shell with a 2 cm Voronoi displacement (`cave_features.mat_moss`, `--surface sludge`) | Clumps read as popcorn |
| Paint, Kuwahara, toon, SSS, card dabs, shells | Up-facing ramp of the reference greens with blotches and dabs; the compositor's anisotropic Kuwahara over the moss; emission ramped by key direction; subsurface; ~3000/m2 flat cards; 5 thinned offset shells | Tris: "None of the approaches you showed come close" |
| Quantised clumps | `--geom clump`: round dabs per voxel cell, tone rising from the rim | Jagged edges, outlines too intricate, too few shades |
| Seeded layers | Each lighter layer grown from pre-placed seeds | "The seed approach is flawed": light areas should come from the patch's shape; replaced by the erosion field, which now places the seeds |
| Dab domes | A dome of geometry per dab | "Each dab creates new geometry": the carpet should be one low-poly shell |
| Edge cards | One alpha card per rim dab along the carpet's edge | Read as a 3D leaf fringe with a dark gap; "remove the png cards" |
| Rock print | The dab fringe printed onto the rock's own texture around the mound, `--combine` unioning the two | Tris: "I like how it is without it" |
| Colour blur | Blurring the tone between dabs | "Ruins the painted effect"; the edges should be crisp, just not jagged |
| Light rigs | `--light soft`, `overcast`, `--view neutral`, `filmic` | Soft equals v6 once calibrated, neutral darkens the rock; stay on v6 and AgX |

## Lessons

- `mathutils.noise.noise_vector` and `noise.random_unit_vector` are seeded per Blender process; `noise.noise`, `noise.voronoi` and `noise.turbulence` are stable.
  Build directions from a seeded `random.Random` and vectors from three `noise.noise` samples at offsets.
- A capped cut hole can be wound inside out, and the next cut that picks that face deletes the whole mesh; always `recalc_face_normals` after `holes_fill`.
- A Decimate Collapse ratio is a fraction of each stone's own count, so big stones get coarser facets than small ones; derive the ratio from a triangle target per metre.
- A blue albedo under a warm light cancels; the light's hue decides pink or olive.
  v6 works because its albedo is only a hair blue and its key only moderately warm.
- Specular ignores albedo: a near-black ground still bounces a strong sun through its rough specular lobe.
  For a painted look set Specular IOR Level to 0 on everything, or keep the lights moderate.
- Measure, do not eyeball: sample the reference by region and the render by percentile, and compare the triples.
- A rock that renders white under any light has no material (Cycles' default surface), not too much light.
- In zsh a `$VAR` holding several flags does not word-split; pass flags as an array.
- `mathutils.noise.noise` returns -1 to 1, not 0 to 1; a `2 n - 1` wrapper made the moss erosion negative and its mottle dark-biased, and cost two rounds.
- `bmesh.ops.delete` re-indexes vertices; colours mapped by a stale `v.index` came out in voxel-row stripes. Keep the original index in an int layer.
- A mound left flush with the rock (within 2 mm) decimates into slivers whose normals are noise, some 35 degrees downward, and shades a dark strip along the moss edge; never leave it flush (the 6 mm sink at the rim). A slope cap on the thinning made it worse.
- Under the v6 key the slate's ~0.04 albedo already renders near 177, on AgX's shoulder, so the moss albedo had to drop to about 0.35 of the reference colours before hue and mottling showed. Space tone steps in sRGB; linear spacing is invisible under AgX.
- Depth in hops over a voxel grid is 1.42 times the straight-line distance, over a refined mesh 1.06; the add-on scales every study depth by 1.35 (`STUDY_METRIC`) so its layers grow as the study's did.
- A small patch must not run the whole tone range: scale the erosion field and the layer tone against one fixed reference depth (0.42 m over 5 steps), not the patch's or the rock's own.

## Open

- v6's fronts are lighter and warmer than reference 3's slate blue (sampled (70, 66, 64) against (33, 42, 59)); the sun-and-sky rig never gave tan tops and slate sides at once, so the next idea is a non-physical two-tone mix driven by how far a facet faces up.
- The rock-b column is squatter than the reference because the corner cuts eat its top: author its box taller.
- The sheet pieces are mostly cliff faces; the next piece to build from recipe F is a tall column.
- The moss is verified headless on rock-b only: not yet on a river or grotto rock, in the game's light, or in play, and its colours are the v6 rig's.
- The moss reference crop (`out/moss/ref_crown.png`) lives only in a gitignored folder; publish it beside the sheets (`bun run assets:publish-sources studies/cave-sheets/...`) so the moss renders keep the picture they were judged against.
- Ground plants are the one feature of the first pass that still needs a different approach (a painted leaf-card atlas); the vines need only new numbers.
