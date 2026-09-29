# Moss in Blender

Since 2026-09-28 moss is **painted onto a scene in Blender** and grown as real geometry: a cushion with a lobed, lumpy outline wherever it is painted, and curtains hanging with fingers and strands wherever the moss runs off a drop.
It is a Blender add-on, `tools/blender/moss/`, and it lives entirely in Blender: the paint and the settings are saved in the `.blend`, the grown mesh is exported by `just scene <level>` like any other scenery, and nothing outside Blender edits it.
See [blender-scenes](blender-scenes.md) for the scene pipeline it rides on.

## Install

```sh
just moss-install      # once per machine; links the add-on into Blender and enables it
```

`tools/blender/moss_install.py` links `tools/blender/moss` into Blender's `user_default` extension repository (so an edit in the repo is what Blender runs after a restart), enables it and saves the preferences.
The add-on is packaged as a Blender 4.2+ extension (`blender_manifest.toml`), which is Blender's name for an add-on; it has nothing to do with the level editor.
The scene exporter does not need it installed: it imports the package from the repo.

## Painting

The **Moss** tab in the 3D viewport's sidebar (N) has **Paint Moss**.
While it runs, left-drag paints on whatever mesh is under the cursor, Ctrl+left-drag erases, `[` and `]` shrink and grow the brush, and Escape, right-click or Enter end it; the middle mouse, the wheel and the numpad still navigate.
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

## What is grown

Since 2026-09-29 the moss is a **carpet of flat leaf blobs layered like paper cutouts**, after the painted-foliage look of Genshin, Breath of the Wild and The Witness: every blob is one flat colour, shaded by a smooth normal borrowed from the rock, so the carpet reads as one soft mass of distinct colour blocks; vines of heart-shaped leaves hang off its front edge.
It replaced the cushion-and-curtains grower of 2026-09-28, which the owner judged not to work ("the only nice part is the ability to paint").
The research that arrived at it, with the rejected alternatives (shell texturing, a solid cushion, leaf-clump cards, camera-facing cards), is the Moss Collar Study report and `tools/blender/moss-experiments/`.

All of it is `build.py`, a pure function of the rock's evaluated mesh, its world matrix, the stamps and the settings; the same inputs give the same mesh bit for bit, in one process or across processes (the candidates are sorted by position before any random draw).

1. **Refinement and mask.** As before: the rock's triangles near a stamp are bisected to `Resolution`; the stamps are composited in painting order into a coverage `m`; the outline is `m = Threshold + Edge Noise x noise(Edge Scale)`.
2. **Hull normal.** The rock's vertex normals smoothed over `Rounding`. Every blob shades with this normal, whatever facet it sits on, which is what makes a thousand flat quads read as one rounded mass.
3. **Underlay.** The painted part of the rock, clipped on the iso-line a little outside where the blobs start, lifted `Underlay` (2 cm), in the leaf colour. Where blobs thin out it is moss, not rock.
4. **Candidates.** `Candidates` points per square metre on the refined triangles inside the paint; the layers pick from them. A candidate with fewer than four neighbours within 6 cm is dropped (a blob alone would float), as is any on the back of the rock, which the game never sees.
5. **Layers.** `Layers` heights from 8 mm up to `Thickness`, each with three sub-heights 2 mm apart. Each layer takes a random share of the candidates sized to lay `Fill` times its area in blobs. A blob is a quad of `Blob Min` to `Blob Max` lying flat on the hull with **no random tilt**: neighbours share a plane, so they overlap like scales and never cut through each other (a card tilted at random slices the blob behind it and breaks the block of colour).
6. **Shoulder.** In the outer `Shoulder` of the paint (in coverage units) a blob sits on a quarter-round of radius `Thickness`: flat on top of the mass, standing against the rock at the paint's edge, a card below the surface tilting in proportion to its depth. The mass rolls into the stone instead of ending as a shelf. The outward direction is the coverage field's gradient, so neighbours agree.
7. **Facing.** Finally every blob is rotated the least that makes it face the game's camera (Blender -y) by `Facing` (a cosine, 0.5 = 60 deg), so the silhouette is made of blob faces, never of edges; a blob seen edge-on is a spike.
8. **Vines.** `Vines per m²` of paint, from front-facing points on the paint's edge at least 15 cm apart: a 3 mm stem starting below the carpet, `Length` long, with heart-shaped leaves alternating sides, tapering from `Leaf Size` to `Leaf Tip` and closing up as they shrink, each hanging tip-down from its base on the stem and leaning out. Every vine point is held in front of the rock's front-most surface by a ray cast from the camera side, because a rock bulges below its shoulder and a vine placed by the nearest surface ends up inside it.
9. **Colour.** A vertex colour the material multiplies into a white atlas. Three tones (`Yellow-green`, `Leaf green`, `Blue-green`) patch across the rock by a slow noise at `Tone Scale`, lit toward `Crown` where the hull faces up, darkened by `Depth Shade` and cooled toward `Shade` in the four lowest layers, then `Variation` of value per blob so neighbouring blocks differ.

Nothing in the moss casts a shadow: `create_moss` turns the object's shadow off, and the game does the same for any `.moss` node (`render3d/sceneDressing.ts`). A cast shadow between leaves reads as a black hole in the carpet, and the borrowed normal carries the depth on its own.

## Material and texture

One mesh, three material slots: `MossBlobs` (the atlas's colour times the vertex colour, alpha cut at 0.35, back faces culled), `MossUnder` and `MossStem` (the vertex colour alone).
Each node is one the exporter carries to glTF - `baseColorTexture x COLOR_0`, `alphaMode MASK` with `alphaCutoff`, no `doubleSided` - so `just scene` prints no warning, and three's GLTFLoader builds a `MeshStandardMaterial` with `alphaTest 0.35`, `FrontSide` and `vertexColors`.
The cutoff sits below 0.5 because mipmapping eats alpha-tested leaves at a distance.

The atlas is **generated**, not downloaded: `mesh_io.atlas()` draws a 3 x 3 sheet of polygon silhouettes (spiky blobs, fanned clusters of pointed leaves, faceted rounds, and three heart-shaped leaves with a faint midrib for the vines), softens them by blurring the alpha and re-thresholding, and writes it once to `assets-src/scenes/textures/moss-cutout-atlas.png`, packed into the `.blend`.
It is white everywhere with the alpha as the shape: a black background under the alpha bleeds a dark fringe into every edge through filtering.
It is credited as generated in `tools/blender/image_credits.json`.
A hand-painted atlas can replace it under the same name; bump `ATLAS_VERSION` in `mesh_io.py` to redraw the generated one, `MATERIAL_VERSION` to rebuild the materials in every file.

## Export

`scene_export.py` grows every moss object again before it selects anything, so the moss that ships is grown from the paint against the rock as it is now, never the preview saved in the file.
A moss whose rock is gone is hidden from the export with a warning.
Each moss's triangle, blob and vine count and build time is printed as a `[scene_export] moss` line.
The moss node stays a child of its rock through the optimiser (`--keep-hierarchy`), so moss on a rock that dresses a body rides the body.

**Bake to Plain Mesh** copies a moss into an ordinary mesh to hand-edit, and hides the moss object from the render so only the copy exports; the copy is never regrown.

## Verified, and not

2026-09-29: headless, the reworked grower ran through `ops.create_moss`, `mesh_io.write_stamps` and `ops.rebuild` on a 300-triangle test rock with 20 stamps: 6,937 triangles (1,479 blobs, 4 vines) in 0.32 s, the three materials with no `material_warnings`, a glTF export that the asset optimiser took to 110 KB and that three's GLTFLoader built as `alphaTest 0.35`, `FrontSide`, vertex colours; two processes on the same host produced the same bytes.
The look itself was settled over fourteen review rounds on the study's own rock (see the report), rendered in Eevee from the game's side-on camera and in three.js.
Not yet: painted on a river rock through the brush, exported by `just scene`, or seen in a play.

2026-09-28 (the previous grower): the brush was driven for real on a private headless sway with `--enable-event-simulate`, laid stamps, created the moss object and regrew it on a setting change; that machinery is unchanged.

## Not yet

- The atlas is generated; the reference's brushwork wants a hand-painted one.
- The facing rule assumes the game's side-on camera. A level that looks at a rock far off-axis would see the sides thin out.
- The optimiser encodes a scene's normal maps as lossy WebP, which [asset-store](asset-store.md) says a normal map must not be; true of every scene, not only moss (the moss has no normal map now).
- No vertex-group mask; a dense, hand-modelled rock might be easier to weight paint.
