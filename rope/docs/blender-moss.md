# Moss in Blender

Since 2026-10-02 moss is **painted onto a scene in Blender** with the moss add-on, `tools/blender/moss/`, and grown as a low mound whose colour is printed dab by dab: a dark base at its rim, lighter clumps inside, and the lighter the moss, the taller it stands.
It is the cave sheet study's moss carpet (the record is `cave-sheet-study/moss_study.py` and [cave-look](cave-look.md)), settled with the owner over many rounds on 2026-10-01 and 2026-10-02, made into a tool.
Until that day "moss" was the name of the ivy add-on; it is now [blender-ivy](blender-ivy.md), and the owner's words on the difference were "the current moss pipeline is actually an ivy carpet pipeline. They are different effects".
Like the ivy it lives entirely in Blender: the paint and the settings are saved in the `.blend`, the mound and its print are exported by `just scene <level>`, and the exporter first rebuilds any moss whose saved mound is not what its paint, settings and rock make now (see "The export keeps what is current").

## Install

```sh
just moss-install      # once per machine; links the add-on into Blender and enables it
```

`tools/blender/addon_install.py` links `tools/blender/moss` into Blender's `user_default` extension repository and enables it; the scene exporter imports the package from the repo and needs no install.
The add-on shares its brush, the stamps' storage and the mesh helpers with the ivy in `tools/blender/stampbrush/`, reached through a symlink inside the package (`moss/stampbrush -> ../stampbrush`).

## Painting

The **Moss** tab in the 3D viewport's sidebar (N) has **Paint Moss** and **Erase Moss**, the same brush as the ivy's: left-drag paints on whatever mesh is under the cursor, Ctrl+left-drag erases, `[` and `]` resize, Escape, right-click or Enter end it, and navigation passes through.
The radius is in metres in the world.
Anything grown, moss or ivy, is transparent to the brush (it carries `grown_by`), so moss can be painted under ivy.

The brush paints **the selected moss**; with none selected (a rock, or nothing, is active) **Paint New Moss** creates one with its first stroke, and **New Moss** starts another with the selected one's settings.
A new moss, `<rock>.moss` after the rock it was first painted on, lives in a `Moss` collection, parented to that rock (its **frame**) with an identity transform and found again by the rock's **name** (`moss.host`), as the ivy is; it is selected, so the next painting carries on with it.
**Copy to Selected** hands one moss's settings to others.

### One moss, many rocks

Since 2026-10-09 a moss is not one rock's (the owner: "when I paint moss over the intersection of two pieces of geometry, I want the moss to naturally generate on both surfaces, as one single moss instance", and "remove the one-moss-per rock constraint").
A rock may carry any number of mosses, and a moss grows on every rock its paint reaches: each stamp that paints joins the rock under the cursor and every other visible mesh whose surface is within the brush's radius (`stampbrush/hosts.py`, `Reach`) to the moss's hosts (`moss.joined`, by name like `host`).
The stamps stay in the frame rock's local frame.
A moss on several rocks grows on their **exact boolean union** (Blender's exact solver, self-intersection on, hole tolerant when a rock is open, cached by the rocks' triangles): one surface cut along the line where the rocks meet, sharing its vertices there, so the paint's falloff, the erosion field, the clumps and the Drape all cross the seam as they would cross a crease of one rock, and nothing grows on the faces of one rock buried in another.
On a box sunk 10 cm into a slab with a stroke along the seam (scratch harness, 2026-10-09) the mound is one piece over the floor and up the wall with its light clumps on the seam, and none of it inside the box; one rock, as before, stops dead at the wall.
The union of river's Terrace.003, Terrace.006 and Cube.004 (30k faces) takes 0.9 s.
A moss on one rock skips the union and builds bit for bit as before (river's nine mosses: the same meshes and `built_key`s).
The panel lists a moss's rocks, and for a selected rock its mosses (click one to select it).
**Merge Selected** (with two or more mosses selected) folds the others into the active one: their stamps carried into its frame and appended, their rocks joined, their objects deleted; the active one's settings win.
A joined rock that is missing is left out of the growth with a status line (and an export warning), and found again if it comes back under its name; a missing frame rock stops the moss, as before.
The moss moves with its frame rock only: a moss over a rock that is a moving body's dressing and one that is not would tear in the game.
In Texture Only, the export paints the moss into each of its rocks' colour maps, and the decal previews at the finest of their texels.
A build takes seconds, not milliseconds (river's rocks: 1-25 s each since 2026-10-05), so **Live** (rebuild on every settings change) is off by default, and **the moss never grows while you paint**: a painted moss is hidden and its paint drawn as green points where the coverage passes `Threshold` (the build's own composite of the stamps, at points 1.2 cm apart over the rock, a stroke adding only its own stamps), and every moss the strokes touched grows when painting ends (Esc, right-click or Enter; the header says "growing N objects" and the cursor waits).
Until 2026-10-05 the moss grew at the end of every stroke, which held Blender for the whole build each time; a guess from the last build's time is no help, because a build grows with its paint (a new moss built in 0.8 s took 8.8 s three strokes on). The ivy, whose builds are quick, still grows while painted (`GROW_WHILE_PAINTING` in stampbrush/brush.py).
**Rebuild** and **Rebuild All** are in the panel.
The panel shows the triangle count, the dabs, the print's size, the build time, the dabs per layer and the mound's mean height over the rock per tone step (the check that the light stands tallest).
**Rebuild** acts on every selected moss and every moss on a selected rock (the button says how many); **Rebuild All** on every moss in the scene.

### Detail: moss for the background

`Detail` (1, down to 0.1) coarsens the moss's grain and nothing that places its colour: at Detail d, `Resolution`, the dab sizes, `Texel Size` and `Dab Edge` are 1/d as big, and `Triangles / m²` and `Min Clump` d² as many (the clump never under 1).
`Reference Depth`, the buffers, `Erosion Noise` and `Mottle Scale` stay as authored: they are measured against the painted area, which Detail does not change.
The panel keeps the values as authored and shows the dab sizes the build gets; `settings.params()` applies Detail, and at 1 passes every value through bit for bit.

It was first `Scale` (2026-10-07), which resized all of those as one pattern; on the same paint that darkened the moss, the light lost (Tris: "reducing the amount of bright colors"): a 3x `Reference Depth` scored every patch a third as deep, and the lighter layers, each kept 1.5 of its dab radii inside the one below, ran out of room.
Measured as the share of the printed area at each tone step, against the spread that changing the seed gives: at 1/3, mean tone over seeds went 0.46-0.51 to 0.43-0.48 on mid-ledge and 0.20-0.27 to 0.13-0.27 on the backdrop pool (Scale had taken them to 0.21 and 0.08), with the light steps' shares inside the seed spread; coarse dabs vary more from seed to seed.
Also keeping the lighter layers' room on the authored dab size (`build`'s inset over the coarsening) held mid-ledge but took the pool to 0.28-0.47, its seeds of light that the authored dabs would have dropped under `Min Clump` standing as single big dabs; tried and removed.
A file saved with `Scale` is carried to Detail 1/scale when it is opened (or built), and wants a Rebuild.

Build time goes with the dab count, so with 1/d²: river's mid-ledge (texture only) grew in 21.7 s at 1 and about 4 s at 1/3 (2026-10-07).
It is for moss whose dabs are a few texels of what draws them, and so each moss's own: the river backdrop's rock maps run from 7.7 mm a texel (mid-ledge: the default dabs, 3.2 to 5 cm, 8 to 13 texels across) to 5.9 cm (left-shelf and left-wall: 1 to 2 texels), and the backdrop's mosses at 1 grew for about 50 minutes of a cold export, left-shelf alone 379k dabs and 37 minutes.
A texture-only moss's box says its rock map's texel.

### Quality: poly count and texture

The **Quality** sub-panel (a mound's only: a texture-only moss is printed at its rock map's texel, see below) holds what the export pays for, and nothing that changes the look's design:

- `Triangles / m²` (1500): the poly count; the mound is decimated to this density, at most what `Resolution` refines to.
- `Texel Size` (1.5 mm): the texture quality; the print's texel in the world.
- `Max Texture` (256 to 4096 px, 2048): the print's largest side. A mound that does not fit at `Texel Size` gets coarser texels (x1.2 until it fits), and the panel says so with the texel it got; the export encodes at most 4096.

The panel reads back the triangles and the density reached over the mound's area, and the print's size and texel.
These are `build.FINISH_PARAMS`, and `build.build` is `finish(grow(...))`: `grow` places and tones the dabs and makes the full-resolution mound, `finish` decimates it and prints it.
The add-on keeps each moss's last growth in memory, keyed by a hash of the rock's world triangles, its matrix, the stamps and every other parameter, so a rebuild after a Quality change only finishes again (river's mid-ledge, 2026-10-05: 26 s grown, about 7 s finished at the defaults); the panel says "growth reused".
The finish from a cached growth is identical to a fresh build, mesh and print.

### Build speed

2026-10-05, measured on river's rocks, every change checked bit-identical (mesh, UVs, print) against the build before it: mid-ledge 25.5 s to 17.2 s, central-rock 37.7 s to 22.2 s.
The wins, in order: the KD-tree of the refined rock is filled in a shuffled order (`stampbrush.geometry.kdtree`; Blender's balance degrades on the position-sorted vertices, 9 s against 0.04 s for 300k points); the packing and spacing tests of every layer skip a vertex already closer to a placed dab than any draw could pass (marked with a margin over float32 rounding, the draws still made, so the random stream is unchanged); the print finds each dab's texels on a thread pool and paints them in dab order; the gutter copies neighbours instead of rolling whole images; the erosion's distance walks start from the paint's border instead of every unpainted vertex.
What is left is Python spread thin, roughly equal parts: the growth loop (KD-tree lookups and dab shape draws), the distance walks, the refinement, the print. Measure with wall-clock timers, not cProfile: its per-call overhead made the growth loop look like layer 0 packing and sent the first fix to the wrong loop.

The print (`paint_texels`) paints **front to back**: dabs are packed so tightly that a texel met 12 dabs on average and 91 % of the dab-texel pairs lay under a later dab that covers the texel whole (mid-ledge: 13.3M pairs over 1.09M texels). Top down, each texel keeps how much of what is below still shows; a texel a dab covers whole is final and the dabs below skip it, as does a texel bucket with none open. The algebra is the bottom-up mix's (the comment in `paint_texels` has it); the order of the float sums is not, so the floats differ by under 1e-16 and the 8-bit print is identical (checked on three rocks). With buckets of one `dab_max` instead of 0.3 (fewer lookups a dab, the same texels), mid-ledge's print went from 4.3 s to 1.7 s.

### The export keeps what is current

Every build stores `built_key` on its moss: a hash of the growth's inputs (the rock's evaluated world triangles, the stamps, every setting), the Quality settings, `build.py`, `mesh_io.py`, `stampbrush/geometry.py` and the Blender version. `scene_export.py` calls `prepare_export`, which keeps a mound whose key matches what its inputs make now and rebuilds only the rest; until 2026-10-05 it rebuilt every moss, 162 s of the river's 380 s export.
A texture-only moss grows nothing at that point: its key is part of its rock's bake-cache key, so a cached map already holds it, and its dabs are grown only when the rock is baked. A moss painted in a file from before `built_key` (or with code changed since) is rebuilt by the export until it is rebuilt in Blender and the file saved.
A file load clears the cache, and the scene exporter, a fresh process, always grows.

## What is grown

All of it is `build.py`, a pure function of the rock's world triangles (or the union of its rocks', see "One moss, many rocks"), the frame rock's matrix, the stamps and the settings; the one Blender call, the decimate, is passed in by the caller.

1. **Refinement and paint.** The rock's triangles under the stamps, plus a dab's reach beyond them, refined to `Resolution` (1.2 cm) with the ivy's longest-edge bisection, sorted by position so every random draw is reproducible; the stamps composited into a coverage, cut at `Threshold`. The paint decides where moss grows; the dabs draw its outline. Nothing is voxel-remeshed: the study remeshed its whole metre-sized rock at 6 mm, which a 5 m cavern rock cannot afford.
2. **Dabs.** A dab is a rounded irregular blob, the polar curve `r(t) = r (1 + a1 cos(t - p1) + a2 cos(2t - p2) + a3 cos(3t - p3))` (owner: "shouldn't be circles at all - rounded blobby irregular"), and it is always **concave**: the owner asked to "remove all the convex shapes" because the blobs "look too round". A draw whose solidity (area over convex hull area) is above 0.97 is drawn again; measured over 2000 draws, the median solidity is 0.985 and 18 % are at or under 0.97, so a dab costs about five draws (a first cut at 0.93 accepted nothing and hung the build).
3. **Layer 0.** The painted area packed with dark dabs (`Dab Min` to `Dab Max`, 3.2-5 cm, packed at 0.3 of the radius sum so there are no pinholes).
4. **The erosion field.** The painted area eroded inward pass after pass by an uneven step (a slow noise decides where a pass bites, a fast one at `Erosion Noise` roughs the outline); a vertex scores, continuously, how many passes it survives. The step is the same for every rock (`Reference Depth` / `Steps`), so a small patch scores low and stays mid-green, as the reference's small patches do.
5. **Lighter layers.** `Layers` (5) layers of smaller dabs (x `Shrink` a layer) grown clump by clump inside the layer below, seeded at the field's summits; each stays `Buffer` inside the extent of the layer below (`First Buffer` for the first). The first two fill to that buffer, so the dark base is only a rim; the rest are islands holding a shrinking share of the parent's dabs. Clumps under `Min Clump` dabs go.
6. **Tone.** Per dab, `Field Mix` of the erosion field at the dab and the rest from its layer, through `Curve`, plus a slow positional `Mottle`, quantised to `Levels` (8) steps from `Dark` to `Light`, spaced in sRGB. There is no per-dab randomness, so neighbours land on the same step and merge into one blotch (the owner: "individual blobs still too obvious - combine more readily"). The default colours are the study's last albedos under its v6 light; the game's light will want its own.
7. **Height.** Lighter is taller (the owner, 2026-10-02): `Floor` (8 mm) for the darkest moss plus the tone painted onto the vertices times `Lift` (9 cm more for the lightest), the tone's share times how much the surface faces up (a wall keeps `Wall Share`, 0.3: a full pile on a wall rises toward the ridge above it, and that slope faces the ground, a dark strip under an overhead key), smoothed over `Height Blur`. At the mound's edge it starts `Sink` (6 mm) under the rock and rises to that height over `Rim`, so it crosses the rock along one line and is **never flush with it across an area**: a mound left flush decimates into slivers whose normals are noise, some 35 degrees downward, which shaded a dark strip along the moss edge (the owner's "dark patch at the edge", found with a camera-ray probe and a per-face dump in the study). While the dabs were also printed on the rock, moss thinner than the sink was print only; with that print dropped it was a hole in the moss, so the darkest moss now stands `Floor` proud.
   Every depth (the buffers, the erosion step, the rim) is scaled by `STUDY_METRIC` (1.35): the study measured depth in hops over its 6 mm voxel remesh, a Manhattan-like metric at 1.42x the straight-line distance (median over 5-25 cm, measured), where paths over the refined mesh run 1.06x; without it the first lighter layer grew a third of the study's dabs.
8. **The mound.** The refined rock where the dabs reach (`Mound Reach` of a dab's outline), offset along the smoothed normal from the rock's own surface - the study first stood it on the voxel shell, which sits up to a centimetre off the facets and left a ledge with a shadow - decimated to `Triangles / m²` (1500), and its open edge seated `Sink` under the rock again, because the decimate drags it up.
   **Drape** (since 2026-10-09, the owner: "instead of the moss dropping off sharply and creating a right angle, it should slope off the edge"): the mound is a sheet draped over the rock with the pile standing on it, not an offset of every corner. The sheet (the rim and `Floor`) is a membrane under tension pressed onto the rock so that it bends no tighter than `Drape` (1 m): where the rock is flat, convex or curves more gently it lies on the rock, and across a step or a hollow tighter than that it spans it in a curve of that radius, so from a ledge's edge the moss slopes down to the moss below. The pile (the tone's height) stands on the sheet along the sheet's normal, faces up as the sheet does (a slope piles like a slope, not like the wall under it), and the dabs ride the sheet off the rock so the print finds them. `Drape` 0 is the old offset, unchanged. It bridges only what is painted: the sheet's open edge stays on the rock, so a slope needs the moss below the step painted too.
   It is solved as positions, not heights: a height along each vertex's normal folds the sheet in a concave corner, where the wall's and the floor's normals cross. It is the settled sheet, not a count of smoothing passes, so neither `Resolution` nor the patch changes its shape: solved on clusters about 2.5 cm across (a cell's vertices connected inside it, so a thin fin's two faces stay apart) until fewer than 1 % still move (a few at the rim flick on and off the rock for good), then a short pass over the vertices themselves, which smooths the corner each cluster carried along (left, the pile folded across it: 566 flipped triangles on the test step, against 16 at the rim). The pressure is per edge - an edge's rise off the tangent plane over half its length squared, averaged to the mean curvature of a cylinder of the radius - because the sheet bunches its vertices across a corner; a pressure from the mean edge length came out a third of the asked radius. A narrow patch bends tighter than `Drape`, as a membrane held down at its sides does (0.6 m wide at 1 m: 0.42 m).
   Measured on a 25 cm step (scratch harness, 2026-10-09) and on river's Terrace.003, whose stepped runs lost their creases; builds took about a second longer. Not yet seen by the owner, in the game light or played.
9. **The print.** The mound's own texture: the triangles grouped into charts of neighbours facing within 40 degrees of the chart's first face, each projected flat and turned to its principal axes, shelf-packed into a power-of-two square at `Texel` (1.5 mm; coarser if the mound does not fit `Max Texture`), every chart grown 2 texels from its own edge; each texel's position and normal are interpolated, and every dab is evaluated per texel - its outline in its tangent plane, a `Dab Edge` (2 mm) anti-aliased edge, its flat tone over what is below. The edges are crisp (the owner: "edges should not be blurred - that ruins the painted effect - just not jagged"). The outline of the moss is where the mound leaves the rock.

## Material, export and the game

Each moss has its **own material and image**, `<rock>.moss` and `<rock>.moss.print`: a Principled BSDF with the print as the base colour, roughness 1, no specular (the study's moss was a pure matte diffuse), nodes the glTF exporter carries.
The image is 8-bit sRGB, packed, and tagged `generated_by`, which `scene_export.py` takes as an original that owes no credit (the per-rock names could not be listed in `image_credits.json` in advance).
The mound is an ordinary opaque mesh: it casts and receives like the rock.
`sceneDressing.ts` gives the ivy's leaf-shadow biases to `.ivy` meshes, and to an old `.moss` mesh only when its material is alpha-cut, which the mound never is.

## Texture only

**Kind** at the top of a moss's box is **Mound** (everything above) or **Texture Only** (since 2026-10-05, the owner: "a moss painting option that exclusively paints texture onto the rock ... no actual moss geometry - it's just a texture that gets baked onto the rock on export").
A texture-only moss grows the same dabs, layers and tones from the same paint and settings (steps 1-6); there is no mound, so the Height panel is hidden.

- **In Blender** the dabs show on a decal: the refined rock under them, and one ring of triangles more (a dab's outline can cross a triangle with no vertex inside), lifted `DECAL_LIFT` (3 mm) along the smoothed normal, not decimated (a collapse would cut across the rock's creases), printed like a mound with the dabs' coverage as alpha and drawn BLENDED, casting no shadow. The decal is printed at the texel of the rock's baked colour map, uncapped, so it shows the moss as the export paints it (`ops._Inputs`, from `formations/render.py`'s `colour_texel`, the map size the export bakes); the Quality panel, which set this print until 2026-10-07 and so previewed far sharper than what shipped (1.5 mm against the backdrop's 7.7 mm to 5.9 cm), is hidden.
- **On export** the decal is hidden from render (`grow_painted`): never shipped, and out of the bake's rays, where 3 mm off the rock it would darken the slate's occlusion and bevel. The rock is a bake target whatever its material. Right after Cycles bakes its colour map, while the map's alpha still marks the baked texels, `scene_export.paint_moss` rasterises the export's own unwrap (`SceneBake`) and `build.paint_map` paints every dab over every baked texel within reach, a texel counting for a triangle within 0.75 texel of it so the bake's edge texels are painted too, with `build.paint_texels`, the mound print's own per-texel code; the colour is mixed over the rock's in linear by coverage. The background fill then pads the moss into the seams like any baked texel, and every Base Color of the rock's export materials reads the map.
- It works on the export's copy after its mesh work (the crease rebuild, the unwrap), so the `.blend`'s rock is never touched. The moss's key (`moss.texture_paints`: its growth's inputs, the dab edge and `build.py`) is part of the rock's bake-cache key, so a cached map holds its moss.
- The map's density is the rock's (`TEXELS_PER_METRE` in `formations/render.py`, 512 a metre, about 2 mm, up to the rock's map cap), not the moss's; on a big backdrop rock capped at a smaller map the dabs' 2 mm edge is under a texel and softens.

## What was tried in the study and dropped

The study's record of rejected looks is in `moss_study.py`'s history and the memory of the sessions: shells, sss, toon, Kuwahara, card dabs, a voxel-quantised carpet, alpha-card edges (the owner: "remove the png cards from the edges"), and the dab fringe printed on the rock's own texture around the mound (tried 2026-10-02; the owner preferred the mound's own edge: "I like how it is without it").

## Verified, and not

2026-10-02: headless only, on the study's rock-b with stamps laid by script over the study's own painted area (up-facing, metre lobes, tongues over the lip), rendered under the study's v6 light (`cave-sheet-study/out/moss/addon*_*.png`). With 14 cm stamps the column grew 1111 / 685 / 631 / 347 / 86 / 13 dabs a layer (the study: 866 / 449 / 341 / 187 / 56 / 8) and the mound's mean height over the rock rose with every tone step, -5 mm to 96 mm. With 9 cm stamps the paint had pinholes between stamps and the moss had holes: paint broadly. A build takes 2-9 s a rock (the boulder: 2,263 triangles, 3,180 dabs, a 2048 print of 664k texels, 8.9 s); a per-triangle chart atlas held each surface point five times over and took 28 s. The scene exporter grew and wrote four moss rocks with their prints and no moss warnings, and exported `river.blend` with its ivy migrated and unchanged.
The print of a 1.5 m² mound at 1.5 mm needs 0.66M texels, so a 2048 square (the charts' boxes fill 47 % of their area; 1024 would need 65 %); `Texel` is the knob, and a better packer is open.
Not yet: the brush driven in a real Blender session (its modal code is the ivy's, moved verbatim into `stampbrush`), a river or grotto rock, an export by `just scene`, the game's light, or a play.
