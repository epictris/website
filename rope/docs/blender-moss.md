# Moss in Blender

Since 2026-09-28 moss is **painted onto a scene in Blender** and grown as real geometry: a carpet of flat leaf blobs wherever it is painted, and a vine of lobed leaves wherever one is placed.
It is a Blender add-on, `tools/blender/moss/`, and it lives entirely in Blender: the paint, the vine anchors and the settings are saved in the `.blend`, the grown mesh is exported by `just scene <level>` like any other scenery, and nothing outside Blender edits it.
See [blender-scenes](blender-scenes.md) for the scene pipeline it rides on.

## Install

```sh
just moss-install      # once per machine; links the add-on into Blender and enables it
```

`tools/blender/moss_install.py` links `tools/blender/moss` into Blender's `user_default` extension repository (so an edit in the repo is what Blender runs after a restart), enables it and saves the preferences.
The add-on is packaged as a Blender 4.2+ extension (`blender_manifest.toml`), which is Blender's name for an add-on; it has nothing to do with the level editor.
The scene exporter does not need it installed: it imports the package from the repo.

## Painting

The **Moss** tab in the 3D viewport's sidebar (N) has **Paint Moss** and **Erase Moss**.
While the brush runs, left-drag paints on whatever mesh is under the cursor, Ctrl+left-drag erases, `[` and `]` shrink and grow the brush, and Escape, right-click or Enter end it; the middle mouse, the wheel and the numpad still navigate.
Erase Moss is the same brush the other way round: left-drag erases and Ctrl+left-drag paints, with a red ring instead of a green one.
Each stroke is one undo step.
Moss already grown is transparent to the brush, so painting over it paints the rock beneath.
The brush's radius is in metres in the world, not pixels, so a stroke means the same thing up close and far away.

The first stroke on a rock creates its moss object, `<rock>.moss`, in a `Moss` collection, parented to the rock with an identity transform.
It takes the settings of the moss the panel was showing when painting began, so a look carries from rock to rock; **Copy to Selected** hands one moss's settings to the moss of every selected object.
Selecting a moss object or its rock shows its settings in the panel; with **Live** on, any change regrows it after a short quiet spell.
A patch builds in about 0.1-0.4 s; the panel shows its triangle count and build time.

**Why a brush and not weight painting.** A weight lives on a vertex and is blended linearly across a triangle, and the river's cavern rocks have 2-5 m facets, so the finest mask weights could hold there is a smear the width of a facet; making them paintable would mean subdividing the rocks, which ship.
The brush's stamps (centre, surface normal, radius, signed strength, in painting order) are independent of the rock's topology, stored on the moss object as the vertices of a face-less mesh (`moss.stamps`) in the rock's local frame.
The moss object finds its rock by **name** (`moss.host`) and sits in its own collection, so a rock deleted and re-imported under the same name (the river's `Cavern` collection is, whenever `import_into_river.py` runs) is found again and its moss grows back on the new mesh.

## Placing vines

Since 2026-09-30 nothing places a vine but the artist; the grower used to scatter them along the paint's front edge, and the owner wanted them "explicitly placed in the scene".
The Vines panel's **Place Vines** runs like the brush: a click on a mesh hangs a vine from that point, Ctrl+click on an anchor removes it, Escape ends it.
A click on a rock with no paint creates its moss object too, so a bare rock can wear a vine.

An anchor is an ordinary object: an arrow Empty named `<rock>.vine`, in the `Moss` collection, parented to the rock, pointing down, carrying the rock's name in a `moss_vine` property (found by name like the paint, so it survives a re-import).
**The arrow's length in the world is the vine's**: a new one gets the panel's `New Length`, and afterwards it is moved with G, lengthened with S and deleted with X like anything else.
The add-on watches the anchors after every depsgraph update (`ops._on_depsgraph`: names, matrices and sizes compared with the last look, one walk of the objects) and regrows the rock's moss when its set changed, from a timer, never inside the handler; opening a file takes its anchors as the baseline and regrows nothing.
Anchors are empties, so the exporter skips them as it skips every non-mesh.

## What is grown

Since 2026-09-29 the moss is a **carpet of flat leaf blobs layered like paper cutouts**, after the painted-foliage look of Genshin, Breath of the Wild and The Witness: every blob is one flat colour, shaded by a smooth normal borrowed from the rock, so the carpet reads as one soft mass of distinct colour blocks; vines of lobed ivy leaves hang wherever they are placed.
It replaced the cushion-and-curtains grower of 2026-09-28, which the owner judged not to work ("the only nice part is the ability to paint").
The research that arrived at it, with the rejected alternatives (shell texturing, a solid cushion, leaf-clump cards, camera-facing cards), is the Moss Collar Study report and `tools/blender/moss-experiments/`.

All of it is `build.py`, a pure function of the rock's evaluated mesh, its world matrix, the stamps, the vine anchors and the settings; the same inputs give the same mesh bit for bit, in one process or across processes (the candidates and the anchors are sorted by position before any random draw).

1. **Refinement and mask.** As before: the rock's triangles near a stamp are bisected to `Resolution`; the stamps are composited in painting order into a coverage `m`; the outline is `m = Threshold + Edge Noise x noise(Edge Scale)`.
2. **Hull normal.** The rock's vertex normals smoothed over `Rounding`. Every blob shades with this normal, whatever facet it sits on, which is what makes a thousand flat quads read as one rounded mass.
3. **Underlay.** The painted part of the rock, clipped on the iso-line a little *inside* where the blobs start, lifted `Underlay` (2 cm), in the leaf colour. Where blobs thin out it is moss, not rock. It stops short of the blobs so the carpet's silhouette is always blobs: clipped outside them (as until 2026-09-30) its smooth edge showed as a solid rim around the mass in the game.
4. **Candidates.** `Candidates` points per square metre on the refined triangles inside the paint; the layers pick from them. A candidate with fewer than four neighbours within 6 cm is dropped (a blob alone would float), as is any on the back of the rock, which the game never sees.
5. **Layers.** `Layers` heights from 8 mm up to `Thickness`, each with three sub-heights 2 mm apart. Each layer takes a random share of the candidates sized to lay `Fill` times its area in blobs, and toward the paint's edge a candidate is taken up to `Edge Fill` times more readily (weighted by the square of its distance from the inside), because the shoulder thins the upper layers there and a gap at the rim shows what is under the carpet. A blob is a quad of `Blob Min` to `Blob Max` lying flat on the hull with **no random tilt**: neighbours share a plane, so they overlap like scales and never cut through each other (a card tilted at random slices the blob behind it and breaks the block of colour).
6. **Shoulder.** In the outer `Shoulder` of the paint (in coverage units) a blob sits on a quarter-round of radius `Thickness`: flat on top of the mass, standing against the rock at the paint's edge, a card below the surface tilting in proportion to its depth. The mass rolls into the stone instead of ending as a shelf. The outward direction is the coverage field's gradient, so neighbours agree.
7. **Facing.** Finally every blob is rotated the least that makes it face the game's camera (Blender -y) by `Facing` (a cosine, 0.5 = 60 deg), so the silhouette is made of blob faces, never of edges; a blob seen edge-on is a spike.
8. **Vines.** One per anchor: a 3 mm stem hanging straight down from the anchor, the arrow's length long, with lobed ivy leaves alternating sides, tapering from `Leaf Size` (15 cm) to `Leaf Tip` (4.5 cm) and closing up as they shrink, each hanging tip-down from its base on the stem and leaning out. Every vine point is held in front of the rock's front-most surface by a ray cast from the camera side, because a rock bulges below its shoulder and a vine placed by the nearest surface ends up inside it. The leaves shade with the carpet's hull normal where the anchor sits in paint, else with the rock's own.
9. **Colour.** A vertex colour the material multiplies into a white atlas. Three tones (`Yellow-green`, `Leaf green`, `Blue-green`) patch across the rock by a slow noise at `Tone Scale`, lit toward `Crown` where the hull faces up, darkened by `Depth Shade` and cooled toward `Shade` in the four lowest layers, then `Variation` of value per blob so neighbouring blocks differ.

Nothing in the moss casts a shadow: `create_moss` turns the object's shadow off, and the game does the same for any `.moss` node (`render3d/sceneDressing.ts`). A cast shadow between leaves reads as a black hole in the carpet, and the borrowed normal carries the depth on its own.

## Material and texture

One mesh, **one material**, `Moss`: the atlas's colour times the vertex colour, alpha cut at 0.35, back faces culled.
The underlay and the stems wear it too, sampling the centre of a round blob cell (alpha 1 there, and with no UV derivative the sampler reads mip 0); the stems are wound to face the camera.
Each node is one the exporter carries to glTF - `baseColorTexture x COLOR_0`, `alphaMode MASK` with `alphaCutoff`, no `doubleSided` - so `just scene` prints no warning, and three's GLTFLoader builds a `MeshStandardMaterial` with `alphaTest 0.35`, `FrontSide` and `vertexColors`.
The cutoff sits below 0.5 because mipmapping eats alpha-tested leaves at a distance.

**Why one material.** Until 2026-09-30 there were three slots (`MossBlobs`, `MossUnder`, `MossStem`), and the underlay reached the game white.
Blender 5.2's glTF exporter, given a second slot that reads the same colour attribute as the first, records that slot under the attribute's *name* where it later looks for the glTF attribute's name (`io_scene_gltf2/blender/exp/primitive_extract.py`, `materials_use_vc`), decides the slot does not use the colour, and writes its `COLOR_0` as 1.0.
The `.blend` held the right greens; the `.glb` did not.
With one slot there is nothing to mismatch, and the moss is one draw call; the old materials are removed from a file once nothing uses them.

The atlas is **generated**, not downloaded: `mesh_io.atlas()` draws a 4 x 4 sheet of polygon silhouettes (twelve angular blobs - spiky, fanned clusters of pointed leaves, faceted rounds - and four lobed ivy leaves with veins to every lobe for the vines), softens them by blurring the alpha and re-thresholding, and writes it once to `assets-src/scenes/textures/moss-cutout-atlas-v<ATLAS_VERSION>.png`, packed into the `.blend`.
It is white everywhere with the alpha as the shape: a black background under the alpha bleeds a dark fringe into every edge through filtering.
**Every cell has a transparent gutter.** A card's UV quad covers only the inner 76 % of its cell (`build.ATLAS_INSET`, 12 % a side) and the shape is drawn inside that, so on both sides of every cell border the alpha is 0 for 30 texels: bilinear filtering and the first four mip levels never blend a neighbour into a card's edge.
Cells packed edge to edge (v2, one evening) drew a faint dotted outline of every card square, in Blender and in the game, because the solid alpha-1 cells sat right under the leaf row and each blob touched its cell's border.
It is credited as generated in `tools/blender/image_credits.json`.
The file is named by version, so bumping `ATLAS_VERSION` in `mesh_io.py` redraws it and a file that packed the old sheet drops it; `MATERIAL_VERSION` rebuilds the material in every file.
A hand-painted atlas can replace the generated one under the current name.

## Export

`scene_export.py` grows every moss object again before it selects anything, so the moss that ships is grown from the paint against the rock as it is now, never the preview saved in the file.
A moss whose rock is gone is hidden from the export with a warning.
Each moss's triangle, blob and vine count and build time is printed as a `[scene_export] moss` line; the vine anchors themselves are empties and are skipped like every non-mesh.
The moss node stays a child of its rock through the optimiser (`--keep-hierarchy`), so moss on a rock that dresses a body rides the body.

**Bake to Plain Mesh** copies a moss into an ordinary mesh to hand-edit, and hides the moss object from the render so only the copy exports; the copy is never regrown.

## Verified, and not

2026-09-30 (erase, placed vines, one material, edge fill, ivy leaves): headless, a scratch copy of `river.blend` with three anchors planted on `boulder-4` by script went through `scene_export.py` and the optimiser (0 warnings, 11,500 triangles for that moss: 2,469 blobs, 3 vines), was swapped into `public/scenes/river/` and shot with `cli shot --view` at the boulder, then the shipped file was restored byte-exact.
In the shot the underlay is leaf green where the shipped file shows white, the carpet's lower edge is blob silhouettes, and the vines wear the lobed leaves at about twice the old size.
The same build on a test rock was bit-identical across two runs, and three's GLTFLoader built it as one `MeshStandardMaterial`, `alphaTest 0.35`, `FrontSide`, vertex colours.
Not yet: the Erase Moss and Place Vines tools driven in a real Blender session (their modal code is the brush's), the anchor watcher regrowing on G/S/X, or a play.

2026-09-29: headless, the reworked grower ran through `ops.create_moss`, `mesh_io.write_stamps` and `ops.rebuild` on a 300-triangle test rock with 20 stamps: 6,937 triangles (1,479 blobs, 4 vines) in 0.32 s, the three materials with no `material_warnings`, a glTF export that the asset optimiser took to 110 KB and that three's GLTFLoader built as `alphaTest 0.35`, `FrontSide`, vertex colours; two processes on the same host produced the same bytes.
The look itself was settled over fourteen review rounds on the study's own rock (see the report), rendered in Eevee from the game's side-on camera and in three.js.
Not yet: painted on a river rock through the brush, exported by `just scene`, or seen in a play.

2026-09-28 (the previous grower): the brush was driven for real on a private headless sway with `--enable-event-simulate`, laid stamps, created the moss object and regrew it on a setting change; that machinery is unchanged.

## Not yet

- The atlas is generated; the reference's brushwork wants a hand-painted one.
- The facing rule assumes the game's side-on camera. A level that looks at a rock far off-axis would see the sides thin out.
- The optimiser encodes a scene's normal maps as lossy WebP, which [asset-store](asset-store.md) says a normal map must not be; true of every scene, not only moss (the moss has no normal map now).
- No vertex-group mask; a dense, hand-modelled rock might be easier to weight paint.
