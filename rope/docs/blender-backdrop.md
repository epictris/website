# The backdrop

Since 2026-10-04 a level's Blender scene can hold a **backdrop**: the far scenery the player sees behind the gameplay, recipe F stones cut from closed guide meshes kept in the scene itself.
Since 2026-10-05 each piece is a **solid formation** ([blender-formations](blender-formations.md), generator `solid`): the Formations panel shows its guide, edits its parameters and render settings, and regenerates it, exactly as for an outline's formation.
The river's (`ball` level, `river.blend`) was seeded from the grotto painting through an [Orthographic Studio](../../3d/CLAUDE.md) scene (`ssikuq5cgFgGC20KvbbM_g`: the far wall, the ceiling and its stem, the arch, the waterfall cliff, the ledges and the three boulders in the pool), and is what the level opens on.
It is scenery like everything else in the scene: `just scene ball` exports it, and nothing in it can change how the ball rolls.

## Work on it

**In Blender**, in the Formations tab (N):

- **Show guides** shows every piece's guide in a colour of its own, and **Solid rocks as wireframe** lets them show through the rocks.
- Select a rock (`backdrop.roof`) for its box: **Select Guide**, the generator's fields, **Regenerate**, and **Render (export)**.
- Edit a guide like any mesh; the rock turns pending, and Regenerate (or **Rebuild Changed**) builds it again in a separate Blender, the scene editable meanwhile.
- **New Formation** with a closed mesh selected makes a new piece from it.

**Headless**, for a script or an LLM (`tools/blender/backdrop.py`; every run also records the level's start camera and water on the scene, `backdrop_camera`, which every build reads):

```sh
cd rope
B="blender -b assets-src/scenes/river.blend --python-exit-code 1 --python tools/blender/backdrop.py -- levels/ball.json"
$B --list                                          # every piece: guide, parameters, render settings, pending
$B --set roof stoneSize=1.2,facets=0.7 --rebuild changed --save
$B --render roof export_chips=true,export_map_max=2048 --save     # `auto` forgets one
$B --rebuild all --save
blender -b assets-src/scenes/river.blend --python tools/blender/backdrop_check.py   # the rules, below
just scene ball
```

A guide can be edited by script too: it is the mesh `backdrop.<id> / guide` in `Formation recipes`, parented to its rock (its vertices in the rock's frame, which for a backdrop rock is the world), and a rebuild reads it as it stands.
The parameters are `solidfit.PARAMS`, the render settings `formations/render.py`; both are listed with what they do in [blender-formations](blender-formations.md#formations).

**Seeding from a reference** (once, or for a piece the scene does not have yet):

```sh
bun scripts/ortho-solids.ts <studio scene id> /tmp/solids.json
$B --import /tmp/solids.json [--only id] --save
```

The studio is a reference for a first build, not a source the backdrop depends on: its scenes do not persist.
`ortho-solids.ts` fetches a studio scene (or reads a saved `scene.json`) and writes each rock's exact solid, meshed by the studio's own code (`3d/orthographic/src/core/mesher.ts`: the union of its parts, each the intersection of its front, top and side outlines' prisms), with the studio's camera.
`--import` maps each into the game's view (below), sinks its feet, runs the roof's ceiling forward, and builds it as a solid formation whose guide it is, with its provenance in `formation_import`.
A piece the scene already has is kept, edits and all, unless `--only` names it, which replaces it.
`--adopt` turned the 2026-10-04 backdrop (a mesh per piece in `Backdrop sources`, its rock in `Backdrop`) into solid formations with the seeds and floor they were built with; only the pool is left in `Backdrop`, rebuilt after every build.

## Where it stands

The level opens with the camera locked by the camera region the spawn stands in (`lockX`, `lockY`; for the river (10.85, 8.0) m), at the guide camera's distance from the gameplay plane (10.24 m) with the level's 70 mm lens, a 19.5 degree vertical field.
The studio picture was drawn through a 40 degree lens, so the solids cannot simply be moved and scaled into the game's view: from the game's eye they would show only the middle third of the picture.
Instead every point keeps the angle it makes with the studio camera's axis, times `s`, at `k` times its depth.
That is a scale of `s k` across and up and `k` along the view, about the eye, and from the eye it is exactly the studio picture, `s` times smaller in angle.

- `s` is the ratio of the two lenses' half-heights (0.471), so the picture fills the frame from top to bottom; the frame is wider than the picture, and the studio objects run on past its sides.
- `k` stands the studio's pool on the level's own water: the studio eye is 0.94 m above its pool, the game's 1.53 m above the water under the start frame, so `k` = 3.47 and the backdrop is 1.64 times the studio's size across and 3.47 times its depth along the view.

The nearest boulder stands 4.3 m behind the gameplay plane, the far wall 29 to 36 m.
The stretch along the view is invisible from the eye; it shows only as parallax once the camera moves, and in the plan views (the guides from above).
The picture's horizon is a little above its middle (the studio camera's `shift`); the game's camera has none, so the backdrop's horizon is the frame's middle and the picture sits about 40 pixels lower than it did in the studio.

**The pool**: the level draws its own water only where its water bodies are, 6 m behind the plane at most (`waterDepth`), so the backdrop gets a plane at the water's height, 2 cm under it, from there to behind the far wall, in the water's deep colour (`#1b4657`, flat, not baked).
Everything under it is left unbuilt.
The game draws it as the pool's own water (ripples, mirror and colour carried on without a seam; [water](water.md#still-water)), so its Blender colour is only what Blender and an export preview show; it must keep the name `backdrop pool` for the game to find it.

## The rocks

The look is [cave-look](cave-look.md)'s recipe F in the painted slate, as on the formations: recipe F builds a piece from stacked boxes, one stone each, with the seams between them reading as fissures (`formations/solidfit.py`).
A backdrop piece is a solid, so the boxes are cut from it:

0. **The solid** (imported from the studio with its feet sunk 0.4 under the water, `backdrop.sink`: the studio's stop a few centimetres under their pool, and a weathered stone's foot rounds up by more, so the boulders hung above the water) is copied into world space, welded and wound outward (`backdrop.prepared`; the studio's arrived inside out, signed volume negative, and every step below works along normals; an open mesh is refused by name), and **thickened** away from the eye (`solidfit.thicken`): its camera-facing faces are extruded 0.4 further along their own camera rays and unioned with it.
   A point moved along its ray stays on its pixel, so the silhouette from the start camera is exactly the studio's; only the hidden back grows.
   It is for the skins: where a solid's side is a thin slanted slice seen edge on (the central rock's top left, 2.6 m along the ray and centimetres across it), no stone survived the opening and the 80 degree rule, and the outline had holes.
   **The ceiling** runs forward to the level (`backdrop.extend`, the pieces in `EXTEND`; Tris, 2026-10-04: the roof arch should "extend out all the way to the foreground geometry").
   The studio's roof is a slab 25 m back with only its stem and right wall reaching forward, so from the side, and once the camera moves, the sky showed between it and the level's own rock.
   Its largest section along the view is swept forward to y 0.5 (the formations' back) and cut off under a plane through the eye, 0.1 screen metres above the start frame's top edge (`EXTEND_CLEAR`): from the start camera none of it shows and the opening shot is the studio's as before, and its underside slopes down toward the level along that plane.
   Its stones are cut at no less than the roof's own depth scale before the sweep (`backdrop_floor` on the solid, `cells(floor)`): by the screen-size rule the sweep's front, at the plane, came to 196 stones a third the size of the rest.
1. **Cells**: the solid is sliced along the view into slabs, each slab into columns, each column into strata of its own, every joint leaning up to 7 degrees off square.
   Sizes are in screen metres (lengths on the gameplay plane) times the slab's depth over the plane's, so a stone far back is as big on screen as one near: columns 0.8 to 1.6, strata 0.5 to 1.1, slabs 0.9 to 1.8 along the view.
   They were two thirds of that until Tris asked for a backdrop "predominantly composed of large bodies, not many overlapping small bodies" (2026-10-04; the roof was 154 stones); twice the old sizes overdid it, and the roof's arch, 6.5 m across, was two stones meeting in a point.
   **On a curve the cells split** (`_curved`, `_split`): a cell whose piece of the solid turns over 60 degrees in gentle bends (2 to 35 degrees each, times their length, over the cell's longest side; a corner is one sharp bend, not a curve) is halved across the screen, again and again, down to the old sizes (columns 0.55, strata 0.35).
   At 1.5 times the old sizes the lower arch's opening and the roof's arch were still one or two stones each, faceted into straight runs meeting in a point (Tris, 2026-10-04: "it should be a gradual curve"; the lower arch "looked good before"), while the far wall's flat cells stay whole: the arch's cells turn 100 to 450 degrees, the far wall's 10 to 50.
   A curve's stones are faceted at recipe F's full density, and measured for knubs against their own kind's median, not the big stones'.
2. **Stones**: each cell, grown 0.12 every way so neighbours overlap, is intersected with the solid (a Manifold boolean), so a stone's outer faces are the solid's.
   A cell with none of the solid's surface in it is left out (the core stands for it).
   One thinner than 0.1 or filling under 30 % of its box (a corner of the solid in a cell, which weathers into a spike or a sheet) is joined to the neighbour whose box it overlaps most (`_neighbour`, `_union`); left out, its corner of the solid had no stone.
   So is one under 30 % of the piece's median cell volume (`KNUB`; 15 % before the stones doubled in size): a chunk of the solid's edge in a cell's corner weathered into a little stone of its own and stuck out of the big one beside it as a knub (Tris, 2026-10-04).
3. **Weathering**: recipe F's corner cuts, bevel, chisel and relief (`solidfit.weather`), each length times the stone's depth scale.
   The chisel makes a quarter of recipe F's cuts (`CHISEL`): its steps stood out of the stones as little plates.
   The corner cuts and the bevel go as the stone's smallest half up to 0.4 (`CUT_HALF`, the old sizes' typical half): on the bigger stones they carved a curve into planes instead of taking the corners off.
   The corner cuts aim at the corners of the stone's box and stand inside its furthest point that way (`solidfit.corner_cuts`): recipe F aims at a random vertex, which on its boxes is a corner, but a stone cut from a curved solid has hundreds of vertices bunched along the curve and their average off centre, and on the central rock ten such cuts took most of a stone away.
4. **Opening** (`open_thin`): the stone shrinks by 0.02 and grows back by as much, in three steps each way with a voxel remesh after every step, so anything thinner than 0.04 is gone (a lip a chisel box left along an edge, a fin the relief folded up) and the mass keeps its size.
5. **Regrowth** (`regrow`): the stone grows along its normals, in steps with a remesh, until 75 % of the solid's surface in its cell is inside it again (at most 0.08; 90 % and 0.15 blew a stone up to twice its cell's volume and rounded it into a potato).
   The weathering takes a stone in from its cell all round, so stones cut edge to edge stood apart with the core and the sky between them, and the outline shrank: measured from the start camera, 10.8 % of the solids' silhouettes were not stone (a boulder 25 %; `backdrop_check.py`, below).
   Scaling a stone back to its cell's box was tried first: it helped the walls and not the boulders, whose corner cuts eat a rounded outline (rock-a went to 38 %).
6. **Facets**: recipe F's Decimate Collapse, to 0.55 of its 120 triangles a screen square metre (`FACETS`; at recipe F's the roof's underside was a mesh of small faces, Tris, 2026-10-04) thinned once more by the depth scale (`facets_per_m2`: the further back, the coarser on screen too; Tris, 2026-10-04, after the roof alone came to 59k faces), and a planar dissolve at 15 degrees, then `unfold`: the collapse turns a sliver of triangles back over itself here and there, and each such fold's sharpest edge is collapsed to a point, which deletes the sliver.
   A collapse that would pinch the surface (its edge's ends sharing more neighbours than its triangles' far corners) is tried on another edge.
   A stone that cannot be unfolded cleanly, or would lose more than 5 % of its surface doing it, is faceted again 1.4, 2, 2.8 and 4 times finer; one that still fails is left out (with only the first three, the lower arch's left leg was, and the arch stood on one).
   Parts under 0.1 across or 2 % of the stone's surface go (`drop_scraps`): a ball 6 cm across once floated in front of the waterfall cliff.
7. **Core**: the solid itself, rounded and shrunk 0.2 inside in five steps with a remesh after each, opened like a stone, faceted by a 0.15 remesh and the planar dissolve, so a fissure shows recessed stone and never the sky.
   0.06 was tried first: the weathering takes a stone's face back by about a tenth of its size, so the core stood in front of the stones and its flat planes were most of what showed.

**Not blobby** (Tris, 2026-10-04: "too blobby compared to the foreground rocks", and the rounding of the points "has overcompensated").
Measured as each rock's edge length by dihedral angle and the share of its area in its largest tenth of planes: the Terraces have about 25 % of their edge length in gentle 5 to 20 degree folds and 78 to 90 % of their area in their largest planes, the backdrop had 60 to 65 % and 44 to 57 %.
Recipe F's smoothing (4 passes after the bevel, 2 after the chisel) is halved for the backdrop (`ROUND`, `CUT_SOFT`), the opening's radius halved, and the dissolve raised from 9 to 15 degrees (`FACET_ANGLE`, passed to `fitted._facets`; the formations keep 9).
Tried on the way: regrowing by scaling the stone's box (crisper, but the arch and the boulders opened 7 to 10 % holes), no smoothing at all (rock-c 27 % holes), a 20 degree dissolve (a large face folded into a plate standing out of a stone).

**Packing** (Tris, 2026-10-04: "no floating rocks, and the rocks should pack tightly together - overlapping if necessary to avoid gaps").
Every build reports, per piece, the stones that overlap no other stone and not the core and do not stand in the water (`floating`), and the core's faces carry a `backdrop_core` attribute so a check can tell stone from fissure.

**No convex edge under 80 degrees** (Tris, 2026-10-04, after flat planes jutting out of the boulders' waterlines and pointy curved slivers on the walls).
The first build had about 3300 of them, most under 45 degrees, and they came from three places, each measured on single stones stage by stage:

- the core, shrunk 0.2 in one step along its normals, folded through itself wherever the solid is thinner than that, and the folds faceted into flat fins along the boulders' waterlines;
- a stone a few voxels thin faceted into a flat two-face sheet (hence the 0.1 minimum thickness);
- the facet decimation folds a rounded stone over itself, at any face target (16 edges on 35 stones at recipe F's density, 19 at three times it).

Tried and dropped on the way: chamfering every sharp edge across its bisector (it met the rule, but Tris: the jutting parts still look weird blunted - a fin has to go, not be trimmed), relaxing the vertices on a fold (a pulled-in tip sharpened its neighbours; 7 of 16 left), and faceting by a voxel remesh and the planar dissolve instead of the collapse (folds nothing, but every curved face bands along the voxel grid; kept for the core only, which shows in the fissures).
The river's backdrop measures 0 convex edges under 80 degrees and 0 non-manifold edges after the build.

Every piece is one object, `backdrop.<id>`, with its own painted slate.

**Depth scale** (`formation_depth_scale` on the rock, measured by its build, and `slate_scale` on its material): the piece's median stone depth over the plane's, 1.5 to 4; it is the rock's `detail_scale` unless that is set by hand (Render, [blender-formations](blender-formations.md#formations)).
The export divides its texel density by it, and its largest map too (4096 over the scale, down to a power of two: the far wall 512, most pieces 1024; capped at 4096 alone, every backdrop rock took 4096 and the river scene 19.4 MB), and the slate shader multiplies every length in its graph by it (the noises' periods, the occlusion reaches, the bevels), so the far wall's stone and edge line are as big on screen as the Terrace's.
Unless its render settings say otherwise, a rock with a detail scale over 1 skips the chamfer strips, the curved creases and the chips and sub-facets altogether (`render.far_back`): 30 to 45 m back they are a pixel or two, and on the backdrop's 155k faces (before the facets thinned with depth) those Python passes held the export for over half an hour (Tris, 2026-10-04).
Without it the far wall would have taken a 4096 map for detail nobody can see and drawn its edge line under a pixel wide.
All of it is the level of detail by depth; **Fixed LOD** and **Facet falloff** (the generator's) and the render settings (the export's) set it by hand instead (Tris, 2026-10-05: configurable, not automatic from the distance to the camera).

## Tried and dropped

| Attempt | What | Why dropped |
|---|---|---|
| Rocks over the screen | The fitted generator's search moved to the screen: recipe F rocks of screen sizes placed where the camera ray meets the solid, turned to its surface, fused with the solid as core | Lumpy pillows everywhere, and the fusion lost the silhouettes the studio scene was traced for (the arch and the stem) |
| Small stones | Columns 0.35 to 0.75, strata 0.18 to 0.42, then 0.55 to 1.1 and 0.35 to 0.75 | A busy dry-stone wall; the painting's masses are a few big planes |

## Open

- Only the start view is designed: the backdrop runs out to the sides as the camera travels the level, where the sky shows as before.
- No moss, ferns or vines yet (the painting's foliage): the ivy and moss add-ons can paint the pieces like any formation.
- The waterfall in the painting is not modelled; the cliff it falls from is.
