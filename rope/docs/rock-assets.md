# Rock and moss props

Since 2026-09-24 a rock in a level is a **hand-authored prop modelled in headless Blender from the body's collision outline**, and the moss on it is a second prop grown from the rock's surface inside the moss body's outline.
Both are placed by their bodies like any `kind: "mesh"` geometry object, so the collision the ball rolls on, the moss the hook attaches to, and what is drawn all come from the same editor geometry.
This page is written for the agent that models the next one: what the tools are, what every knob does to the picture, how to judge a result, and every lesson that cost a round.

It replaced the procedural per-level rocks of [rocks.md](rocks.md), which the owner rejected ("too messy, the texture doesn't look good").
Do not resurrect that pipeline or its constants.

## The loop

1. **The job file** `rocks/<level>-<body>.json` is the authored record of a prop.
   `bun run assets:rock <level> <body>` creates it from the body's collision outline, or refreshes the parts the level owns in an existing one (outline, origin, buried outline), keeping what was authored by hand (cracks, seed, textures, budget).
2. **The build** runs `tools/blender/rock_asset.py` on the job, optimises the result into `public/meshes/<key>.glb` and updates the key's hash and size in the manifest.
   `--preview` writes a preview sheet into `public/rocks/<name>-front.png`, `-quarter.png`, `-quarter2.png`: the game's head-on view with the collision outline drawn in red, and two three-quarter views.
   A moss preview shows the rock it grows on in clay.
3. **Judge the previews**, then the game: `?level=BALL` in the browser, or headlessly a scratch bundle (any recorded BALL run with its `data` replaced by the current level file) through `cli shot <bundle> --frame 1 --3d --at X,Y --zoom 3 --query rocks=0`, where X,Y is the body in sim metres, y down.
   The Blender previews and the game disagree in two ways worth knowing: the game lights a rock nearly head-on with little fill, so a face tilted away from the sun goes black, and the game draws the rock's LOW mesh while a moss preview shows the rock's high.
4. **Change one authored thing at a time** (a crack, a job field, a constant), rebuild, look again.
   A build is 15 to 25 seconds including the bake and the previews.
   `--place` writes the prop object onto the body, keeping whatever was authored on a prop object already there (its glow, its depth).
   A moss placed for the first time also gets its glow: `emissive` on the prop object and a point light hung 0.3 m off the moss, away from its rock (see [Glowing props](lighting-and-surfaces.md#glowing-props)).
5. When the owner accepts it: `bun run assets:publish public/meshes/<key>.glb`, then `bun run assets:credits`.

The first rock (body 196 of `ball`) took about twenty rounds; most of what follows is what those rounds found.

## The job file

```json
{
  "name": "rock-196", "key": "rock-196", "kind": "rock",
  "outline": [{"x": 11.6, "y": -9.05}, ...],
  "origin": {"x": 17.85, "y": -10.81},
  "depth": 0.9, "seed": 0,
  "textures": "cliff-rocks-07",
  "cracks": [[{"x": 11.75, "y": -8.35}, {"x": 12.1, "y": -8.3}, ...], ...]
}
```

- `outline`, `origin`: world metres, y **up** (the sim is y down; the wrapper flips).
  `origin` is the **body's** position, and the mesh object sits at body-local 0,0, so editing the outline in the editor only means regenerating, never re-placing the mesh.
  These two are the level's and are overwritten on every refresh.
- `depth`: the solid's depth through the gameplay plane, centred on it.
  Seeded from the geometry object's `depth` when the job is created, then the job's: a refresh used to copy it again from the extruded geometry, so a depth set before `--place` was overwritten.
  For a rock it should be about the rock's width: the authored 2 m on a 1 m rock made a loaf of butter.
- `cracks`: polylines in the same frame, each carved as a soft groove that wraps over the front, top and back.
  Author them like a sculptor: one across the lower third, one splitting the top block, a short shoulder crack.
  They are the only per-rock geometry decision besides the outline; the wrapper keeps them on the rock when the body moves.
  A crack laid along the crease where chisel planes meet renders as a hard black slit: rock-197's low bedding crack did once `front` put planes there, and was removed.
- `seed`: every random choice (chisel cuts, wobble) is seeded from it; the same job always gives the same rock.
- `textures`: a set name under `assets-src/rock-textures/<name>/` holding `basecolor.png`, `normal.png`, `roughness.png`, prepared by `bun run assets:rock-texture <zip> assets-src/rock-textures/<name>` (see "Textures").
- There is no per-rock tile: metres per repeat belong to the texture set (`SET_TILE` in `rock_asset.py`), so every prop wearing a set shows it at the same world size.
  1.0 m was chosen for the rock set (1.6 m read as one band across a rock, 0.6 m as fine strata), 0.5 m for the moss.
  A per-job tile let rock-197 fall back to 1.6 m beside rock-196's 1.0 m ("the texture scale should be based on the world size").
- `detail`: metres, the size every detail constant (voxel, corner rounding, chisel depth, crack width) is scaled from, as if it were a rock that big; the rock's larger side by default.
  Set it for a long, low rock: body 197 (4.5 x 1.4 m) detailed at 4.5 m got 31 cm corner rounding and 40 cm chisel cuts and shrank well inside its outline, so it carries `"detail": 1.4`.
- `cuts`: how many chisel planes (34 by default, right for about a square metre of face); rock-197 carries 110.
- `front`: the share of chisel cuts made on the face toward the camera (0 to 1); without it each cut picks its side by coin toss.
  rock-197's seed put the big planes on the back, which the game never shows ("you've put the interesting geometry on the side facing away from the camera"); it carries 0.85.
- `bury`: metres to push every outline edge the rock shares with another body's collision (the roof or wall it comes out of) into that neighbour, for the mesh only, so its rounded rim is hidden inside the neighbour.
  `bun run assets:rock` finds the shared edges and writes the result into the job as `buriedOutline` (level-owned, rewritten on every refresh): shared edges are sampled every 5 cm, pushed out, ramped in at a junction with a free edge, and each sample pulled back until it lies inside the rock or a neighbour, so a thin spike of the roof is never poked through.
  rock-199 without it met the roof's flat underside along a rounded edge and looked stuck on; its first version (`buryTop`, the top edge only) could not bury rock-200, whose top slants and whose side runs down a roof wall.
  Its depth must stay under the roof's: at equal depth its buried front fought the roof's front face and showed through as a white patch (rock-199 and rock-200 are 0.9 m under a 1.0 m roof).
  The 5 cm recess that leaves shows as a thin shadow of the roof's edge on the rock's face.
  A roof body whose own outline still runs round the rock draws over it: rock-199 was invisible until body 193's outline was re-routed along the rock's top.
- `taper`: `{root, tip, share}` narrows the depth, eased, from the root to `share` at the tip.
  Tried on rock-199 and dropped by the owner ("far too severe", the tip a blade the moss wrapped as two lobes); no job uses it.
- `tris`: the shipped triangle budget (2500 for a rock, 1800 for moss by default). 17k was "way too many for a single rock".
- A moss job has `"kind": "moss"` and `"rock": "<level>-<body>.json"`, the rock it grows on.
  `"drip"` (metres, default 0.12 toward the camera) sets how far the lobes cut back into the outline and `"fill"` (metres, default 0.05) how far the skin may grow off the rock toward its outline; a small moss hanging below a rock (moss-145, moss-160: 0.04 and 0.12) needs both to reach its collider.
  The skin grows along each face's own side-view direction, so a moss under a rock's tip fills down to its outline as well as up and sideways.
  `"lobes": "upper"` puts the scalloped edge on the moss's upper edge, reaching up the face, for a moss under a rock's tip (moss-190); the default is the lower edge, drooping (moss-192).
  Its `outline` is the moss body's own collision, which is what the hook attaches to.

## How a rock is made

`rock_asset.py`, stages in order, every constant near the top of the file.

1. **The mass.** The outline is extruded through `depth`, its front and back rims rounded hard (`RIM_BEVEL`, a share of the half depth) and its silhouette corners lightly (`SIDE_BEVEL`), so the band at the gameplay plane is exactly the outline and the rounding is in depth.
   Voxel remesh at `VOXEL` (1.2 cm on a 1 m rock; constants scale with the rock's size), a light smooth.
2. **Chisel facets.** `CUTS` flat planes are shaved off the blob, each `CUT_DEPTH` in from its support point, with normals that have at least `CUT_MIN_Y` of depth component, so they face the camera or away and never cut the silhouette.
   This is where the reference's flat planes meeting at crisp edges come from.
   A cut that would cross the outline in the gameplay plane is rejected (steep cuts shaved rock-199's silhouette inside its collision), and a cut whose section the fill cannot close is undone (one such cut collapsed rock-199's high to 200 triangles).
   Then a second remesh rebuilds a uniform skin over the cuts.
3. **Cracks.** Each authored polyline is a curtain through the depth; vertices within `CRACK_RADIUS` of it in the side view move inward along their normal by up to `CRACK_DEPTH`, a soft V, with a smooth `CRACK_WOBBLE`.
   The groove is wide and shallow (6 cm, 2.2 cm) on purpose: at 4 cm and 3.5 cm the groove walls were steep enough that their baked normals faced away from the game's sun and every crack was a harsh black band.
   The carve fades to nothing at the gameplay plane itself, so a crack ending at a side wall does not notch the silhouette.
   Anything the carve pushed outside the outline is pulled back onto it.
4. **The high mesh is this dense skin as it is** (about 48k triangles), one light smooth, shaded smooth.
   A planar dissolve and an edge bevel used to follow here to save triangles, and they were the cause of "messy crevices": the dissolve chopped the curved groove walls into strips and the bevel fragmented them, and the bake copied both.
   A bake source does not need fewer triangles.
5. **The low mesh** is not a collapse of the high: quadric collapse merged the two walls of a groove into jagged bridging triangles ("lumps and teeth in every crack").
   It is a coarse voxel remesh of the high, sized from the surface area and the budget (`LOW_REMESH_OVER`), which turns a groove into a clean shallow valley, a light smooth, a planar dissolve (moves no vertex), and a mild collapse only if that lands over the budget.
6. **The bake.** Smart UV unwrap of the low, then Cycles bakes the high onto it, selected-to-active: base colour, roughness, tangent-space normal, ambient occlusion.
   The source material is a hand-built **triplanar** with a different offset per axis: Blender's own box projection read the same tile region on the front and the side of a rock about one tile across, and one pale patch of the set showed twice ("why is this part here").
   The cage is 1.2 cm and rays reach 6 cm: larger values let rays cross a groove and sample the far wall, black specks in every crack.
   Every atlas texel the bake left unwritten (marker colour), wrote black (a ray that hit a back face) or gave a normal pointing into the surface is refilled from its neighbours.
   A texel the bake's margin blended with the marker counts as the marker (red and blue both clear green by 0.12): rock-197's first bake left such texels as magenta streaks.
   The build logs the share of the atlas it refilled; a jump between builds means the low has left the high by more than the rays reach.
   The normal map is exported at `NORMAL_STRENGTH` 0.7, because a full-strength tilt goes black under the game's light.
7. **Export**: one GLB at the origin, PNG textures, which `assets:optimize` turns into meshopt geometry and 1k WebP.
   The script ends by checking the shipped mesh is watertight.

## How the moss is made

The moss is **the rock's own surface inside the moss outline, thickened into a skin**, so it wraps over the top and down the faces like a growth and its boundary is exactly the editor's moss outline.
A slab built from the moss outline alone was rejected: "a random blob on top of the rock instead of a growth that wraps around part of the rock face".

1. The rock's high is rebuilt from its job (same seed, same depth) and moved into the moss's frame.
   The moss job must reference the rock job, and both must be fresh: an outline that moved in the editor since the rock job was written puts the moss over empty air ("the moss outline covers no face of the rock").
2. A **softened copy** of that rock is built from the rock job with its `cracks` stripped, remeshed at `MOSS_BASE_VOXEL` and smoothed `MOSS_BASE_SMOOTH` times.
   The skin grows from this copy, not the rock: an offset of the real surface inherits every chisel facet and crack as a bump, and a groove's end under the moss survived as a dimple.
3. `cover_weights` gives every vertex of the copy a cover in 0..1: zero outside the moss outline (strictly, the outline is where the moss ends on every side), fading in over `MOSS_FALLOFF` from an edge that is scalloped inward (`MOSS_EDGE_WOBBLE`, `MOSS_EDGE_SCALE`).
   Toward the camera the lower edge **droops in lobes**: a sinusoid along the edge with wavelength `MOSS_DRIP_SCALE`, zero retreat at a lobe's centre and `MOSS_DRIP_FRONT` between lobes, amplitude jittered by noise.
   A thresholded noise came first and gave tongues a few centimetres wide however wide its features were, "sharp points" the owner did not want; a sinusoid is a gradual curve by construction.
   Elsewhere the retreat is only `MOSS_DRIP`.
4. The covered faces are copied and pushed out along their normals by a **thickness field**: `MOSS_THICKNESS` over a face, `MOSS_TOP_EXTRA` more on faces that face up, grown out toward the moss outline (straight up on top faces, sideways on side faces, capped at `MOSS_FILL_MAX`), thinning to `MOSS_LIP` at the edge, modulated a little by soft bulges (`MOSS_CLUMP`, `MOSS_CLUMP_AMOUNT`).
   The field is Laplacian-smoothed over the mesh (`MOSS_FIELD_SMOOTH`): per-vertex reaches gave neighbours wildly different thicknesses and a spiky skin.
   Keep the bulges small: "the moss shouldn't bulge outward, it should droop downward along the side of the rock".
5. The skin is clipped to the outline in the side view, closed into the rock with a solidify deep enough (`MOSS_LIP` plus 9 cm) that the later smoothing cannot lift the lip off the rock, remeshed at `MOSS_VOXEL` and smoothed `MOSS_SMOOTH` times.
6. **The rock cap.** A rock peak can come up between the moss's vertices, where no vertex-by-vertex lift catches it (a white disc on the moss survived four such lifts).
   So a cap is fused in: the drawn rock's faces inside the cover, from a dense 2 cm remesh of the rock's LOW (its dissolved facets are long thin triangles, and one whose centre was inside the cover reached far outside it, "weird points protruding down"), pushed out by `MOSS_CLEARANCE` scaled by the same cover weight so the cap sinks under the skin toward the edge (a fixed offset emerged as a ledge, "a discontinuity on the surface"), clipped to the outline, joined with the skin and fused by the remesh.
   The moss then encloses every peak by construction.
7. The moss low comes from the same remesh route with its voxel capped at 3 cm and a gentle dissolve, and is lifted clear of the rock's low once more, last.
   The rock stays in the scene through the moss bake so the occlusion darkens under the lip.

### Open: black specks on moss-145's lip

A few hard-edged black specks show on moss-145's upper-left lip in the game (and were in the owner's screenshot); investigation stopped on 2026-09-24 at the owner's request.
What is known, each by an A/B in `cli shot`:

- It is the **normal map**: stripping `normalTexture` from the GLB removes them, stripping `occlusionTexture` does not; at `normalScale` 0.2 one blob survives, so it is not a strong but valid tilt.
- Ruled out as the cause, each tried and reverted: refilling normals over 40 degrees off their 5x5 mean, exporting tangents (`export_tangents`), refilling occlusion under 0.1, renormalising the normal map after the refill.
- No UV-degenerate triangles and no bad tangents in the mesh.
- The raw normal map has a handful of texels 0.3 to 0.5 long, and WebP shortens thousands more below 0.8; renormalising did not remove the specks, so that is not the whole story.

Next: find the specks' texels (a UV-coloured debug render of the moss, or reading the atlas at the pixel's UV) before changing anything else.

## Textures

Both sets are CC0 from freestylized.com, downloaded by hand (no API): `cliff_rocks_07_4k.zip` and `moss_ground_01_4k.zip` in `~/Downloads`.

`bun run assets:rock-texture <zip or dir> assets-src/rock-textures/<name> [--plain]` unpacks a set and writes the three maps a job reads.
For the rock set the base colour is treated (see the script's docstring): desaturated to 15 percent, remapped to a mean of 150 on 255 with a faint cool cast, because the file as shipped is a dark grey with ochre strata ("too dark", "weird brown streaks"), and its crumbly pale patches flattened, because each one is a recognisable stamp on a rock about one tile across.
The moss sets are used as they are (`--plain`); the owner preferred moss ground 01 over 02.

`assets-src/` is gitignored; the sets are re-downloadable from the manifest entry's `source`.

## Judging a result

- **Geometry first, texture second.** Build with `--no-bake` for a clay render when in doubt about a shape; a texture hides and invents things.
- **Something wrong at the same place every build is not the geometry you just changed.** The white disc on the moss was chased as a sag, a peak of the high, a peak of the low, a crack dimple and a hole before the cap fixed it; the two tongues were the cap, not the droop; the droop itself had never applied because a comparison was inverted.
  Measure: count boundary edges (after merging the glTF importer's seam splits), extract the atlas and look for the colour, strip a map from the GLB and shoot the game again.
- **A/B in the game with maps stripped** is cheap and decisive: removing `occlusionTexture` or `normalTexture` from the GLB's JSON chunk and re-shooting told which one made the harsh black crack.
- **Crops.** The owner's screenshots are of small regions; crop the game shot to the same region at 2x before deciding anything is fixed.

## Files

| Path | What |
|---|---|
| `rocks/<level>-<body>.json` | the authored job files (committed) |
| `scripts/rock-asset.ts` | `bun run assets:rock`: job refresh, build, optimise, manifest update, `--preview`, `--place` |
| `tools/blender/rock_asset.py` | the modelling, high-to-low bake and previews |
| `tools/rock-texture.py` | `bun run assets:rock-texture`: a downloaded set into the three maps, treated or plain |
| `assets-src/rock-textures/<name>/` | the prepared sets (ignored) |
| `public/meshes/<key>.glb` | the shipped props (ignored, in the release store) |
| `public/rocks/<name>-*.png` | preview sheets (ignored) |
