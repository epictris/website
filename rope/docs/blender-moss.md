# Moss in Blender

Since 2026-10-02 moss is **painted onto a scene in Blender** with the moss add-on, `tools/blender/moss/`, and grown as a low mound whose colour is printed dab by dab: a dark base at its rim, lighter clumps inside, and the lighter the moss, the taller it stands.
It is the cave sheet study's moss carpet (the record is `cave-sheet-study/moss_study.py` and [cave-look](cave-look.md)), settled with the owner over many rounds on 2026-10-01 and 2026-10-02, made into a tool.
Until that day "moss" was the name of the ivy add-on; it is now [blender-ivy](blender-ivy.md), and the owner's words on the difference were "the current moss pipeline is actually an ivy carpet pipeline. They are different effects".
Like the ivy it lives entirely in Blender: the paint and the settings are saved in the `.blend`, the mound and its print are exported by `just scene <level>`, and the exporter grows them again from the paint first.

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

The first stroke on a rock creates its moss object, `<rock>.moss`, in a `Moss` collection, parented to the rock with an identity transform and found again by the rock's **name** (`moss.host`), as the ivy is.
It takes the settings of the moss the panel showed when painting began; **Copy to Selected** hands one moss's settings to others.
A build takes seconds, not milliseconds, so **Live** (rebuild on every settings change) is off by default and the paint rebuilds when a stroke ends; **Rebuild** and **Rebuild All** are in the panel.
The panel shows the triangle count, the dabs, the print's size, the build time, the dabs per layer and the mound's mean height over the rock per tone step (the check that the light stands tallest).

## What is grown

All of it is `build.py`, a pure function of the rock's world triangles, its matrix, the stamps and the settings; the one Blender call, the decimate, is passed in by the caller.

1. **Refinement and paint.** The rock's triangles under the stamps, plus a dab's reach beyond them, refined to `Resolution` (1.2 cm) with the ivy's longest-edge bisection, sorted by position so every random draw is reproducible; the stamps composited into a coverage, cut at `Threshold`. The paint decides where moss grows; the dabs draw its outline. Nothing is voxel-remeshed: the study remeshed its whole metre-sized rock at 6 mm, which a 5 m cavern rock cannot afford.
2. **Dabs.** A dab is a rounded irregular blob, the polar curve `r(t) = r (1 + a1 cos(t - p1) + a2 cos(2t - p2) + a3 cos(3t - p3))` (owner: "shouldn't be circles at all - rounded blobby irregular"), and it is always **concave**: the owner asked to "remove all the convex shapes" because the blobs "look too round". A draw whose solidity (area over convex hull area) is above 0.97 is drawn again; measured over 2000 draws, the median solidity is 0.985 and 18 % are at or under 0.97, so a dab costs about five draws (a first cut at 0.93 accepted nothing and hung the build).
3. **Layer 0.** The painted area packed with dark dabs (`Dab Min` to `Dab Max`, 3.2-5 cm, packed at 0.3 of the radius sum so there are no pinholes).
4. **The erosion field.** The painted area eroded inward pass after pass by an uneven step (a slow noise decides where a pass bites, a fast one at `Erosion Noise` roughs the outline); a vertex scores, continuously, how many passes it survives. The step is the same for every rock (`Reference Depth` / `Steps`), so a small patch scores low and stays mid-green, as the reference's small patches do.
5. **Lighter layers.** `Layers` (5) layers of smaller dabs (x `Shrink` a layer) grown clump by clump inside the layer below, seeded at the field's summits; each stays `Buffer` inside the extent of the layer below (`First Buffer` for the first). The first two fill to that buffer, so the dark base is only a rim; the rest are islands holding a shrinking share of the parent's dabs. Clumps under `Min Clump` dabs go.
6. **Tone.** Per dab, `Field Mix` of the erosion field at the dab and the rest from its layer, through `Curve`, plus a slow positional `Mottle`, quantised to `Levels` (8) steps from `Dark` to `Light`, spaced in sRGB. There is no per-dab randomness, so neighbours land on the same step and merge into one blotch (the owner: "individual blobs still too obvious - combine more readily"). The default colours are the study's last albedos under its v6 light; the game's light will want its own.
7. **Height.** Lighter is taller (the owner, 2026-10-02): `Floor` (8 mm) for the darkest moss plus the tone painted onto the vertices times `Lift` (9 cm more for the lightest), the tone's share times how much the surface faces up (a wall keeps `Wall Share`, 0.3: a full pile on a wall rises toward the ridge above it, and that slope faces the ground, a dark strip under an overhead key), smoothed over `Height Blur`. At the mound's edge it starts `Sink` (6 mm) under the rock and rises to that height over `Rim`, so it crosses the rock along one line and is **never flush with it across an area**: a mound left flush decimates into slivers whose normals are noise, some 35 degrees downward, which shaded a dark strip along the moss edge (the owner's "dark patch at the edge", found with a camera-ray probe and a per-face dump in the study). While the dabs were also printed on the rock, moss thinner than the sink was print only; with that print dropped it was a hole in the moss, so the darkest moss now stands `Floor` proud.
   Every depth (the buffers, the erosion step, the rim) is scaled by `STUDY_METRIC` (1.35): the study measured depth in hops over its 6 mm voxel remesh, a Manhattan-like metric at 1.42x the straight-line distance (median over 5-25 cm, measured), where paths over the refined mesh run 1.06x; without it the first lighter layer grew a third of the study's dabs.
8. **The mound.** The refined rock where the dabs reach (`Mound Reach` of a dab's outline), offset along the smoothed normal from the rock's own surface - the study first stood it on the voxel shell, which sits up to a centimetre off the facets and left a ledge with a shadow - decimated to `Triangles / m²` (1500), and its open edge seated `Sink` under the rock again, because the decimate drags it up.
9. **The print.** The mound's own texture: the triangles grouped into charts of neighbours facing within 40 degrees of the chart's first face, each projected flat and turned to its principal axes, shelf-packed into a power-of-two square at `Texel` (1.5 mm; coarser if the mound does not fit `Max Texture`), every chart grown 2 texels from its own edge; each texel's position and normal are interpolated, and every dab is evaluated per texel - its outline in its tangent plane, a `Dab Edge` (2 mm) anti-aliased edge, its flat tone over what is below. The edges are crisp (the owner: "edges should not be blurred - that ruins the painted effect - just not jagged"). The outline of the moss is where the mound leaves the rock.

## Material, export and the game

Each moss has its **own material and image**, `<rock>.moss` and `<rock>.moss.print`: a Principled BSDF with the print as the base colour, roughness 1, no specular (the study's moss was a pure matte diffuse), nodes the glTF exporter carries.
The image is 8-bit sRGB, packed, and tagged `generated_by`, which `scene_export.py` takes as an original that owes no credit (the per-rock names could not be listed in `image_credits.json` in advance).
The mound is an ordinary opaque mesh: it casts and receives like the rock.
`sceneDressing.ts` gives the ivy's leaf-shadow biases to `.ivy` meshes, and to an old `.moss` mesh only when its material is alpha-cut, which the mound never is.

## What was tried in the study and dropped

The study's record of rejected looks is in `moss_study.py`'s history and the memory of the sessions: shells, sss, toon, Kuwahara, card dabs, a voxel-quantised carpet, alpha-card edges (the owner: "remove the png cards from the edges"), and the dab fringe printed on the rock's own texture around the mound (tried 2026-10-02; the owner preferred the mound's own edge: "I like how it is without it").

## Verified, and not

2026-10-02: headless only, on the study's rock-b with stamps laid by script over the study's own painted area (up-facing, metre lobes, tongues over the lip), rendered under the study's v6 light (`cave-sheet-study/out/moss/addon*_*.png`). With 14 cm stamps the column grew 1111 / 685 / 631 / 347 / 86 / 13 dabs a layer (the study: 866 / 449 / 341 / 187 / 56 / 8) and the mound's mean height over the rock rose with every tone step, -5 mm to 96 mm. With 9 cm stamps the paint had pinholes between stamps and the moss had holes: paint broadly. A build takes 2-9 s a rock (the boulder: 2,263 triangles, 3,180 dabs, a 2048 print of 664k texels, 8.9 s); a per-triangle chart atlas held each surface point five times over and took 28 s. The scene exporter grew and wrote four moss rocks with their prints and no moss warnings, and exported `river.blend` with its ivy migrated and unchanged.
The print of a 1.5 m² mound at 1.5 mm needs 0.66M texels, so a 2048 square (the charts' boxes fill 47 % of their area; 1024 would need 65 %); `Texel` is the knob, and a better packer is open.
Not yet: the brush driven in a real Blender session (its modal code is the ivy's, moved verbatim into `stampbrush`), a river or grotto rock, an export by `just scene`, the game's light, or a play.
