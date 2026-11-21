# The backdrop

**Current workflow (2026-11-21):** solid formations now build full-detail masters without camera-dependent stone sizes, depth floors or construction LOD. Assemble them in the authoring scene and use [Build Export Scene](blender-formations.md#asset-masters-and-export-scenes) to derive simpler geometry or baked wall surfaces. The depth-budget sections below record the previous implementation. Existing meshes remain as authored until explicitly regenerated.

Since 2026-10-04 a level's Blender scene can hold a **backdrop**: the far scenery the player sees behind the gameplay, stones cut from closed guide meshes kept in the scene itself.
Since 2026-10-05 each piece is a **solid formation** ([blender-formations](blender-formations.md), generator `solid`): the Formations panel shows its guide, edits its parameters and render settings, and regenerates it, exactly as for an outline's formation.
The river's (`ball` level, `river.blend`) was seeded from the grotto painting through an [Orthographic Studio](../../3d/CLAUDE.md) scene (`ssikuq5cgFgGC20KvbbM_g`: the far wall, the ceiling and its stem, the arch, the waterfall cliff, the ledges and the three boulders in the pool), and is what the level opens on.
It is scenery like everything else in the scene: `just scene ball` exports it, and nothing in it can change how the ball rolls.

## Work on it

**In Blender**, in the Formations tab (N):

- **Show guides** (under Scene) shows every piece's guide in a colour of its own, and **Solid rocks as wireframe** lets them show through the rocks.
- Select a rock (`backdrop.roof`) for its panel: **Regenerate**, **View Guide**, the generator's fields, and **Render (export)**.
- Edit a guide like any mesh; the rock turns pending, and Regenerate (or **Rebuild Changed**) builds it again in a separate Blender, the scene editable meanwhile.
- **Build Formation from Mesh**, offered when a closed mesh is selected, makes a new piece from it.

**Headless**, for a script or an LLM (`tools/blender/backdrop.py`; every run also records the level's start camera and water on the scene, `backdrop_camera`, which the game preview uses):

```sh
cd rope
B="blender -b assets-src/scenes/river.blend --python-exit-code 1 --python tools/blender/backdrop.py -- levels/ball.json"
$B --list                                          # every piece: guide, parameters, render settings, pending
$B --set roof stoneSize=1.2,curveTurn=45 --rebuild changed --save
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

The right bank extension is authored by `tools/blender/extend_grotto.py`
(2026-11-14): six staggered solid guides, from x 20 to 44 m, with low
water-edge shelves, a recessed high shelf and pillar, and a bank joining the
right wall. It uses `backdrop.create` and the Formations worker. The guides'
edges are rounded with a five-segment bevel (0.5–1.1 m by piece thickness)
before generation to soften the extruded silhouettes. Moss is left to the
artist's painter; the initial automatic growth has been removed.
Each `backdrop.east-*` rock retains its
editable guide and recipe. Run it with headless Blender on `river.blend`;
it saves a `river.blend.pre-east-bank` backup before adding anything and
keeps existing named additions on subsequent runs. `-- --smooth-guides`
rounds existing additions once, regenerates them, and removes the automatic
formation growth, with a `river.blend.pre-east-smoothing` backup.
Export separately with
`just scene ball` when the composition is ready for the game.

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

Since 2026-11-13 a piece is cut from its solid into stones that fit it, and each stone is worked as the boulder generator works the top of an outline rock (`formations/solidfit.py`; Tris: "this is the best so far").
The stones are solidfit's, the surface is the boulder's: before, the stones were weathered by [cave-look](cave-look.md)'s recipe F (Tried and dropped, below).
Every length is in screen metres (lengths on the gameplay plane) times the stone's depth over the plane's, so a stone far back is as big on screen as one near.

0. **The solid** (imported from the studio with its feet sunk 0.4 under the water, `backdrop.sink`) is copied into world space, welded and wound outward (`backdrop.prepared`; the studio's arrived inside out, and every step below works along normals; an open mesh is refused by name), and **thickened** away from the eye (`solidfit.thicken`): its camera-facing faces are extruded 0.4 further along their own camera rays and unioned with it.
   A point moved along its ray stays on its pixel, so the silhouette from the start camera is exactly the studio's; only the hidden back grows.
   It is for the skins: where a solid's side is a thin slanted slice seen edge on (the central rock's top left, 2.6 m along the ray and centimetres across it), no stone survived and the outline had holes.
   **The ceiling** runs forward to the level (`backdrop.extend`, the pieces in `EXTEND`; Tris, 2026-10-04: the roof arch should "extend out all the way to the foreground geometry"), cut off under a plane through the eye 0.1 screen metres above the start frame's top edge (`EXTEND_CLEAR`), so the opening shot is the studio's.
   Its stones are cut at no less than the roof's own depth scale before the sweep (`backdrop_floor` on the solid, the **Depth floor** field): by the screen-size rule the sweep's front, at the plane, came to 196 stones a third the size of the rest.
1. **Cells** (`solidfit.Cells`): the boulder generator's 3D Voronoi cells (its anisotropy, `boulders/chunk_geometry.py`), three to a cubic screen metre (over **Stone size** cubed), seeded by its farthest-point pick with each distance divided by the candidate's depth scale, so they spread evenly on screen.
   A grid of boxes (recipe F's cells) read as rectangular blocks in rows; 1.5 cells a cubic metre left Cube.001 sixteen stones with big plain faces.
   Each cell is cut by its 24 nearest seeds and then completed: the seeds whose planes still cut its corners are added, the deepest four a pass, up to 80 planes, until none does, so it is exactly its seed's Voronoi cell (since 2026-11-13).
   The nearest seeds bound a cell only when they surround it; on a seed at the edge of the cloud they all lay to one side, the cell ran to the box across whatever the solid left open, and on Cube.005, a cave, cells 16 m across claimed its far wall and came out a few smooth slabs with ridges at their edges (Tris: "mostly just smooth", "a weird ridge on the inside").
   Adding every cutting seed at once took a test Blender to 36 GB: `halfspaces` tries every three planes.
   **Each cell's taper is decided first** (step 3), because it decides the joints: at each joint the cell that will lie higher reaches 0.12 over its neighbour and the lower stands 0.01 back, where the step between them is at least 0.02.
   Overlapped both ways, as recipe F's cells were, two neighbours tilted differently cut through each other at a grazing angle into thin blades (Tris, 2026-11-13: "jagged edges ... need to be fixed"); held back every way, the stones read as cobblestones set in grout.
2. **Stones**: each cell is intersected with the solid (a Manifold boolean), so a stone's outer faces are the solid's and the stones fit it wherever it bends, alcoves and lobes included.
   A cell with none of the solid's surface in it is left out (the core stands for it).
   **On a curve the cells split** (`_curved`, `Cells.split`): a cell whose piece of the solid turns over 60 degrees in gentle bends (2 to 35 degrees each, times their length, over the cell's longest side; a corner is one sharp bend, not a curve) is halved across the screen, again and again, down to 0.55 wide and 0.35 tall (Tris, 2026-10-04: an arch "should be a gradual curve").
   One thinner than 0.1 or filling under 30 % of its box is joined to the neighbour whose box it overlaps most, and so is one under 30 % of its kind's median volume (`KNUB`, **Merge small**): left out, its corner of the solid had no stone; standing alone, it stuck out as a knub (Tris, 2026-10-04).
3. **The boulder's top** (`solidfit.work`), measured stage by stage on Terrace.002 (whose top is the reference: shingled flat plates, wanted on every face):
   - **sawn flat**: the stone's faces on the solid are grouped by direction (a face more than 35 degrees off a group's starts another, a group needs 12 % of the patch, at most three), and the stone is cut by each group's plane through its centre, so its outer face is one plane per direction as the boulder's pieces are sawn flat by its outline's walls;
   - **the chunk bevel**, the boulder's (`chunkBevelMin` to `chunkBevelMax`, angle-limited);
   - **tapered** as `hybrid_geometry.taper_chunk` tapers a piece: split at its ridge, then every point moved in along the solid's normal (averaged 0.5 about the point nearest the cell's seed) by its distance from the ridge times the stone's own slope on that side (0.32 to 0.66) times its influence (how deep the seed lies).
     A ridge line runs across every face 1.3 D apart (D = 4 / 2.6), along the depth axis the boulder would use there: the camera's axis where it lies in the surface, screen up on a face turned to the camera.
     The boulder's plates reach about 1.1 m from its ridge; ridges 2.6 m apart left a strip of bare core between them that the plates around it framed like the rim of a hollow shell (Tris, 2026-11-13: "why does it look hollow?").
     **Without the roof**: the boulder's taper also sinks every piece by its slope, so its top falls away from the gameplay plane as a whole; on a solid that would repeat at every ridge and leave a groove at each valley, so the mean slope is taken off each stone's (`solidfit.sink`): the steps between stones are the boulder's, the roof is gone.
4. **The boulder's cleanup** (`solidfit.clean`): `solid_chunks.reinforce_chunks` drops slivers and backs shallow wedges, and every convex edge sharper than the boulder's thin-edge angle is bevelled.
   Automatic guide-fitted stones skip the convex-hull backing: a stone may wrap a concave guide or contain separated patches, and a hull bridges those recesses and covers neighbouring stones with a broad flat face. Their separate recessed core supplies the backing. Sliver removal and acute-edge bevels remain; foreground outline slabs retain their original wedge backing. `test_solid_concavity.py` checks both a concave recess and separated patches, plus the unchanged foreground backing.
5. **Core**: the solid itself, rounded and shrunk 0.2 inside in five steps with a remesh after each, opened, and faceted by a 0.15 remesh and the planar dissolve, so a fissure shows recessed stone and never the sky.
6. **The boulder's finish** (`blender_build.assemble_rock`): the core and the stones in one Manifold union, the voxel remesh (1.2 cm times the depth scale), smoothing, the decimation to the boulder's face budget, the rock cut back inside the solid grown by the most a step can rise (`guard`), and the boulder's edge bevel (`limit_edge_bevel`).

**Packing** (Tris, 2026-10-04: "no floating rocks, and the rocks should pack tightly together - overlapping if necessary to avoid gaps").
Every build reports, per piece, the stones that overlap no other stone and not the core and do not stand in the water (`floating`), and the finished rock's faces within two voxels of the core carry a `backdrop_core` attribute, so `backdrop_check.py` can tell stone from fissure.

**Repeatability.** The old three-ray parity test still counted crossings by
restarting each ray `1e-5` beyond its previous hit. At cave world coordinates,
float rounding could leave that origin on the same face: changing the diagonal
of an eight-vertex box flipped an interior point to outside. A missing seed
then shifted the shared random stream; in a Cube.005 check it changed the slopes
of 673 later stones. The inside test now votes on whether each ray's **first**
hit exits the outward-wound solid, without restarting rays or counting crossings.

Automatic stones also have stable lattice-candidate identities assigned before
filtering. Separate random streams keyed by recipe seed, candidate identity,
split branch and operation keep taper and bevel choices local to each stone.
Their orientations and ridge locations use the **authored guide**, rather than
face centres produced by the thickening boolean. Those centres varied with its
triangulation and could change a normal enough to switch the taper's axis.
The thickened mesh still supplies the construction volume.

`test_stone_repeatability.py` covers the eight-vertex failure, translations,
cavities, alternate triangulations, filtering, split randomness and guide-based
orientation. Three complete small builds matched in vertex coordinates,
topology and facet values; three Cube.005 seed-stage runs matched all positions
and taper data exactly. This does not establish bit-for-bit identity of every
large final mesh: Blender's downstream boolean/remesh operations may still vary
in topology. The new random-stream policy changes newly generated layouts;
previously accepted saved meshes are preserved and can be restored directly.

Every piece is one object, `backdrop.<id>`, with its own painted slate.

## Automatic construction detail

Solid-guide formations now default to `adaptiveDepth = true`. This replaces
the need to set **Fixed LOD** or **Depth floor**: they are hidden and ignored
in automatic mode. They remain stored for legacy reproduction with automatic
construction disabled. Imports no longer put a depth floor on the extended roof.

The layout still uses **Stone size**, the seed and curve settings. Each stone
uses its own perspective scale; curvature splitting considers its near extent.
Automatic construction samples a jittered, depth-scaled lattice near the
surface (`cell_sampling.py`), with spacing set by **Stone size**. It has no
fixed candidate-count cap. Deep interior candidates are omitted, since the
core fills that volume. Curvature-split minima, joint widths and fragment
cleanup thresholds scale with Stone size too; the DOF sampling budget remains
independent. Smaller stones require more actual stone construction work.
Cell completion uses a spatial search with a conservative radius, followed by
the existing exact plane test. The native corner solver checks the same plane
intersections and tolerances as the exhaustive Python solver; regression tests
compare their results (`test_stone_size.py`).
Before each boolean, a BVH and triangle-clipping test skips cells containing
no guide surface. Completed pieces stay outside the live scene until their
union, and fragment merging reuses updated bounding boxes. These avoid
repeated scene evaluation and interior stone work at fine size settings.
A roof previously forced to scale 3 will have more, smaller stones near the
gameplay plane after regeneration. This is a construction change, not merely
a different triangulation of the old stones.

The shared core and final voxel finish no longer take their sampling resolution
from the rock's median stone depth. `construction_lod.py` temporarily maps the
connected surface into projective coordinates, applies the existing voxel,
smoothing and decimation operations there, and maps it back. Straight edges
and planar faces remain straight/planar under this transform, so it does not
need a dense preliminary subdivision or independently capped depth slabs.
Voxel size in world space increases toward the background. Planning bounds
the largest inverse-Jacobian stretch across the whole mesh width at every
depth interval, and keeps the uniform near-quality grid when compression would
cost more. Its resolution allowance follows projection or eight samples across
the High-DOF blur diameter, whichever is coarser. This bounds sampling density;
it is not a proof of the complete smoothing/decimation error or perceptual equivalence.

Core insets and opening radii also follow local depth. Offsets use bulk vertex
arrays; intermediate remeshes simplify planar regions before the next volume
conversion. Step counts follow the offset/voxel ratio instead of rebuilding
the volume repeatedly for moves smaller than one voxel. Thin-stone backing and
cleanup use each stone's scale. Bevels hidden entirely by the nearest DOF blur
are omitted. Automatic solids then use the existing slate's nine-degree planar
finish before facet colours are assigned. This keeps the remesh sampling grid
from appearing as many unrelated triangular colour patches on a broad face.
The planar finish merges faces before simplifying crease vertices. Its guarded
vertex pass leaves at least three corners per face and never joins corners
that already share an edge, including edges another removal in the same batch
would create. This prevents the intermittent three/four-face edges observed
when regenerating Cube.005; worker watertightness validation remains unchanged.
`test_facet_topology.py` covers competing crease paths and ordinary planar
simplification. Legacy solids keep their previous finish.
The final export still applies crease smoothing, strips and chip normals.

The existing final manifold/non-degenerate mesh validation still
runs before a generated result can replace a formation.

Existing scene meshes are not silently rewritten. Older solid recipes become
pending for regeneration; **Reload Scripts** or restart Blender to load the new
panel, then regenerate. New recipes record `adaptiveDepth`, and the generator
fingerprint includes the construction budget code. Export-time depth budgets
continue to handle fine surface details and texture atlases after construction.

`test_construction_lod.py` checks the projective inverse, exact planarity,
resolution bounds, camera-pan invariance, ignored legacy controls and a closed
remesh. `test_construction_build.py` runs a complete small solid build and checks
that its geometry is finite, closed and non-degenerate. Run checks with two
CPU cores and `OMP_NUM_THREADS=2` when another export is active.

The complete river roof (`Cube.006`, previously Depth floor 3) was rebuilt in
an isolated worker at 150.9 seconds on two low-priority CPU cores. It produced
320,878 triangles in one connected component, with no boundary or non-manifold
edges, and passed the normal worker validation. This restores foreground
construction detail: its old coarse export had 98,220 triangles, so the new
total is larger. It is not a claim that restoring near detail is free compared
with the old floor override. `benchmark_construction_build.py` reproduces a
bounded full build and records stage timings without saving the source scene.
Those counts describe the initial remeshed surface, before the later broad-plane
finish: that cleanup took 2.2 seconds on the saved roof, retained one closed
component and reduced it to 105,340 polygons (including n-gons).

On identical roof input, increasing native remesh adaptivity from .06 to the
chosen .15 reduced finish time from 41.2 to 24.4 seconds. Foreground samples
(world Y below 3 m) compared in both directions had 95th-percentile distances
of 4.1 and 1.8 mm, maxima 17.5 and 8.8 mm; these are sampled differences, not
guaranteed surface bounds. The more aggressive .3 candidate was not selected.
The [in-game comparison tools](../tools/blender/lod_prototype/README.md) show
the regenerated roof with the full production surface finish and approximate
projected reference illumination. A full scene export must rebake its lighting.

### Legacy uniform construction and rendering

**Depth scale** (`formation_depth_scale` on the rock, measured by its build, and `slate_scale` on its material): the piece's median stone depth over the plane's, 1.5 to 4; it is the rock's `detail_scale` unless that is set by hand (Render, [blender-formations](blender-formations.md#formations)).
The export divides its texel density by it, and its largest map too (4096 over the scale, down to a power of two: the far wall 512, most pieces 1024; capped at 4096 alone, every backdrop rock took 4096 and the river scene 19.4 MB), and the slate shader multiplies every length in its graph by it (the noises' periods, the occlusion reaches, the bevels), so the far wall's stone and edge line are as big on screen as the Terrace's.
**Fine detail by depth of field**: the export's three finer passes (the chamfer strips, the curved creases, the chips and sub-facets) add no detail the game's depth of field would blur away where the rock stands (Tris, 2026-11-13: "if the depth of field blur would make a particular detail indistinguishable, don't bother adding the detail at that distance"; "use the high depth of field").
The game focuses 1.5 m behind the gameplay plane and blurs a point at depth d into a circle of `DOF_MAX_BLUR x (1 - s / d)` of the frame's height as a radius (`src/render3d/depthOfField.ts`); the frame is `2 d tanHalf` tall there, so on the rock the blur is a disc `4 DOF_MAX_BLUR tanHalf (d - s)` across, straight with the depth past the focus (`render.detail_blur`).
The rock's depth is its LOD scale: its detail scale less one, times the start camera's distance from the plane.
Each pass leaves out the features narrower than that disc (a chip by its wider side, a plane whose sub-facet grid is finer, a bow under it, a strip narrower), and is off altogether once its largest is (`render.LARGEST`: strips 8 cm, bows 20 cm, chips and sub-facets 20 cm); at High, with the river's 70 mm lens, that is 1 cm of blur 0.9 m past the focus, 8 cm at 7.3 m and 20 cm at 18 m.
`scripts/scene-export.ts` reads the High numbers from the game and the export refuses to run if `formations/render.py`'s copy (which the panel's Render fields show from) differs; the bake cache keys each rock on its blur, so a change rebakes only the rocks it moves.
A rock's own Chamfer strips, Curved creases or Chips and sub-facets setting overrides it: set on, its pass runs in full.
Before, the passes ran only on the plane (a detail scale of 1: 30 to 45 m back they are a pixel or two, and on the backdrop's 155k recipe F faces they held the export for over half an hour), and a solid formation never had the creases and chips (the river's recipe F Cube spent 747 s of a 1330 s export on its 2714 creases and 1630 chips).
The stones worked as the boulder's top are far coarser: Cube.001 has 155 creases and 251 chips at its depth.
The largest map still goes by the detail scale alone: without that the far wall would have taken a 4096 map for detail nobody can see and drawn its edge line under a pixel wide.
All of it is the level of detail by depth; **Fixed LOD** (the generator's) and the render settings (the export's) set it by hand instead (Tris, 2026-10-05: configurable, not automatic from the distance to the camera).

## Tried and dropped

| Attempt | What | Why dropped |
|---|---|---|
| Rocks over the screen | The fitted generator's search moved to the screen: recipe F rocks of screen sizes placed where the camera ray meets the solid, turned to its surface, fused with the solid as core | Lumpy pillows everywhere, and the fusion lost the silhouettes the studio scene was traced for (the arch and the stem) |
| Small stones | Columns 0.35 to 0.75, strata 0.18 to 0.42, then 0.55 to 1.1 and 0.35 to 0.75 | A busy dry-stone wall; the painting's masses are a few big planes |
| Recipe F stones (2026-10-04 to 2026-11-13) | A leaning grid of boxes (columns 0.8 to 1.6, strata 0.5 to 1.1, slabs 0.9 to 1.8), each cell grown 0.12 every way and cut from the solid, then recipe F's corner cuts, bevel, chisel and relief, an opening, a regrowth to the solid's surface, and its facet collapse unfolded to no convex edge under 80 degrees; about 11 voxel remeshes a stone, 70 s for Cube.001 | Tris, 2026-11-12: slow and "sub-par" beside the outline boulders, whose look was wanted on meshes too. Its packing, fitting and 80 degree work are in git history (`formations/solidfit.py` before 2026-11-13) |
| The boulder's own pieces on a mesh | `meshtop.py` (scratch): the boulder's slabs and Voronoi chunks laid on the guide, sawn by its decimated facets as walls, then the boulder's taper, cleanup and finish | It matched Terrace.002 on Terrace.002's own envelope, but on Cube.001's curves the boulder's pieces, sized and turned for a flat extruded wall, piled up at angles ("too much complex jagged geometry"); solidfit's stones looked better there, hence the two combined |
| Every face sawn by the boulder's roof | The taper kept whole on a solid, ridges 4 m apart | A groove at every valley between ridges, and bare core between the bands of plates |

## Open

- Only the start view is designed: the backdrop runs out to the sides as the camera travels the level, where the sky shows as before.
- No moss, ferns or vines yet (the painting's foliage): the ivy and moss add-ons can paint the pieces like any formation.
- The waterfall in the painting is not modelled; the cliff it falls from is.
