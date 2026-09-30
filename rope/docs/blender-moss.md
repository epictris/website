# Moss in Blender

Since 2026-09-28 moss is **painted onto a scene in Blender** and grown as real geometry: since 2026-09-30 an ivy carpet of flat leaves wherever it is painted, grown out from one origin point, and a vine of the same leaves wherever one is placed.
It is a Blender add-on, `tools/blender/moss/`, and it lives entirely in Blender: the paint, the origin, the vine anchors and the settings are saved in the `.blend`, the grown mesh is exported by `just scene <level>` like any other scenery, and nothing outside Blender edits it.
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
A copy carries only the values the source has *set*; where the source follows a default, so does the copy (`MossSettings.copy_from`).
Until 2026-09-30 it copied every value, which stored that day's defaults on the copy for good: when the ivy's defaults moved, the river's two copied carpets kept the blob carpet's bright greens and 7 cm thickness while their neighbours changed ("why is the moss on boulder-2 so much brighter than on boulder-5?").
Every rebuild now runs `MossSettings.migrate`, which unsets a stored value that is exactly one of those old defaults (`OLD_DEFAULTS`) and drops the blob carpet's own properties, so an old file follows the defaults again; a value the artist chose is untouched.
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

## The origin

Since 2026-09-30 the carpet is ivy that has **grown out from one point**: every leaf points away from the origin and lies over the leaf beyond it, the way runners lay their leaves.
The Carpet panel's **Set Origin** runs like the vine placer: a click on a painted mesh puts that mesh's origin there (a small sphere Empty, `<rock>.origin`, in the `Moss` collection, parented to the rock, carrying the rock's name in `moss_origin`), Ctrl+click removes it, Escape ends it; afterwards the origin is moved with G and deleted with X like any object, and the same watcher that regrows a rock for its vines regrows it for its origin.
A rock with no origin grows from the **top of its paint**, as ivy that came over the crown of the rock does.

The origin only orients and layers the leaves.
**The paint alone decides where ivy grows**: the origin may sit anywhere, even off the paint, and nothing grows toward it or around it.

## What is grown

Since 2026-09-30 the moss is an **ivy carpet of flat leaves grown out from an origin**, after the painted-foliage look of Genshin, Breath of the Wild and The Witness: every leaf is one flat colour, shaded by a smooth normal borrowed from the rock, so the carpet reads as one soft mass of distinct colour blocks; vines of the same leaves hang wherever they are placed.
The owner's brief: "it's more of an ivy carpet I'm going for ... the leaves generate in a realistic way - starting from a point on the carpet and expanding outwards, with leaves further from that point layered underneath the tips of leaves closer to the point".
It replaced the paper-cutout blob carpet of 2026-09-29 (angular blobs in eight hull-parallel layers on a quarter-round shoulder), which in turn replaced the cushion-and-curtains grower of 2026-09-28 that the owner judged not to work ("the only nice part is the ability to paint").
The research behind the cutout look, with the rejected alternatives (shell texturing, a solid cushion, leaf-clump cards, camera-facing cards), is the Moss Collar Study report and `tools/blender/moss-experiments/`; the ivy keeps its hull normal, underlay, facing rule and colour.

All of it is `build.py`, a pure function of the rock's evaluated mesh, its world matrix, the stamps, the vine anchors, the origin and the settings; the same inputs give the same mesh bit for bit, in one process or across processes (the candidates and the anchors are sorted by position before any random draw).

1. **Refinement and mask.** As before: the rock's triangles near a stamp are bisected to `Resolution`; the stamps are composited in painting order into a coverage `m`; the outline is `m = Threshold + Edge Noise x noise(Edge Scale)`.
2. **Hull normal.** The rock's vertex normals smoothed over `Rounding`. Every leaf shades with this normal, whatever facet it sits on, which is what makes a thousand flat quads read as one rounded mass.
3. **Underlay.** The painted part of the rock, clipped on the iso-line a little *inside* where the leaves start, lifted `Underlay` (2 cm), in the leaf colour. Where leaves thin out it is ivy, not rock. It stops short of the leaves so the carpet's silhouette is always leaves: clipped outside them (as until 2026-09-30) its smooth edge showed as a solid rim around the mass in the game.
4. **Growth field.** The origin is snapped to the nearest vertex of the refined mesh (a rock without one takes the highest painted vertex), and the distance from it along the mesh is found by Dijkstra over the refined edges, then smoothed by four umbrella passes so its gradient is not the edge grid's; an island of paint the edges do not reach takes its straight-line distance. The gradient of that field, in the hull's tangent plane, is the **growth direction**: which way the runners went.
5. **Candidates.** `Candidates` points per square metre on the refined triangles inside the paint, each with the coverage, the growth distance and both gradients interpolated; the sheets pick from them. A candidate with fewer than four neighbours within 6 cm is dropped (a leaf alone would float), as is any on the back of the rock, which the game never sees.
6. **Sheets.** `Sheets` (3) layers of leaves 3 cm apart (`STRATUM_GAP`; 6 mm until the leaves cast shadows, when the game's shadow biases needed the room for one sheet to shade the next), sharing `Fill` (3.5) times the paint's area in leaves between them. The properties are `sheets` and `leaf_fill`, new names: the blob carpet's `layers` (8, 8 mm apart) and `fill` (per layer) are still stored in any moss made from a template, and read as sheets they grew 8 sheets 3 cm apart with a thin fill - the river's ground carpet came into the game as leaves floating in the air ("this exploded look"). A renamed property leaves the old values behind; toward the paint's edge a candidate is taken up to `Edge Fill` times more readily (weighted by the square of its distance from the inside), because a gap at the rim shows what is under the carpet. A leaf is a card of `Leaf Min` to `Leaf Max` (7-12 cm, `Taper` smaller toward the far end of the carpet) with its **base at the candidate and its tip down the growth direction**, strayed by up to `Spread` (25 deg); where the field is flat (at the origin) it takes any direction, so the origin is a rosette. Its base stands `Thickness` (4 cm) over the underlay at the origin and slopes down to the rock at the far end, and the card is pitched tip-up by `Tilt` (8 deg) about its own side axis. Neighbours share the growth direction and the pitch, so they are parallel planes offset along the growth: a leaf's tip lies **over** the base of the leaf beyond it, and never cuts through it. (A random tilt was rejected in the cutout study for slicing the card behind; the pitch is not random, so it does not.) `Depth Shade` can darken the lower sheets, but is 0 since the leaves cast shadows: the owner wants no darkness baked into a leaf, "the darkness should only come from soft shadows".
7. **Edge.** In the outer `Shoulder` of the paint (in coverage units) the mound and the pitch fade out and the whole card turns outer-edge-down about the coverage gradient, up to 45 deg at the very edge, so the mass rolls into the stone instead of ending as a shelf. The outward direction is the field's gradient, so neighbours agree.
8. **Facing.** Finally every card is rotated the least that makes it face the game's camera (Blender -y) by `Facing` (a cosine, 0.5 = 60 deg), so the silhouette is made of leaf faces, never of edges; a card seen edge-on is a spike.
9. **Vines.** One per anchor: a 3 mm stem hanging straight down from the anchor, the arrow's length long, with ivy leaves alternating sides, tapering from `Leaf Size` (15 cm) to `Leaf Tip` (4.5 cm) and closing up as they shrink, each hanging tip-down from its base on the stem and leaning out. Every vine point is held in front of the rock's front-most surface by a ray cast from the camera side, because a rock bulges below its shoulder and a vine placed by the nearest surface ends up inside it. The leaves shade with the carpet's hull normal where the anchor sits in paint, else with the rock's own.
10. **Colour.** A vertex colour the material multiplies into a white atlas. Three tones (`Yellow-green`, `Leaf green`, `Blue-green`) patch across the rock by a slow noise at `Tone Scale`, lit toward `Crown` where the hull faces up, darkened by `Depth Shade` and cooled toward `Shade` in the lower sheets, then `Variation` of value per leaf so neighbouring blocks differ.

11. **Shadow.** Since 2026-09-30 (the owner: "soft shadows underneath the ivy leaves", after a reference whose collar throws a broad cool shade down the stone) a **decal** lies 3 mm off the rock's own surface under and around the paint: `Shadow Colour` (a cool dark) at `Strength` (0.7) under the carpet, fading out over `Reach` (25 cm) from the paint's edge and reaching `1 + Drop` (2.5) times further straight down than sideways, as a shadow from above falls. The distance is a multi-source Dijkstra from every painted vertex over the refined mesh with a metric squashed downward (an edge counts shorter going down and longer going up by `Drop / (1 + Drop)` of its rise); the alpha is `Strength x (1 - d / Reach)^2`. To have rock to lay it on, the refinement runs twice: a coarse pass over the stamps widened by the shadow's furthest reach, then the fine pass over the stamps themselves. It is its own object, `<rock>.moss.shadow`, a child of the moss (so the game's no-cast rule covers it) in the `Moss` collection, created and removed by the rebuild, and the brush passes through it like the moss. `Strength` 0 grows none.

**The leaves cast shadows** (since 2026-09-30, the owner: "both the rock and leaves should be shaded by the leaves", after references with soft shade between the leaves; until then the moss was meant not to cast, because a cast shadow between the cutout blobs read as a hole). In Blender the moss object's `visible_shadow` is on (the rebuild sets it, so a moss made earlier turns on too); the decal's is off. In the game the rule is `render3d/sceneDressing.ts` with `render3d/mossShadow.ts`, and three needed three things before a single leaf shaded anything:
- **The name.** GLTFLoader strips the dots from a node's name (`rock.moss` arrives as `rockmoss`) and keeps the original in `userData.name`; the old `.moss` test on `name` had never matched, so the rule that was meant to stop the moss casting never ran either. And in a shipped scene the moss mesh has no name of its own: the optimiser's quantisation needs a transform per mesh, and a node that has children (the rock carries its moss, the moss its decal) gets its mesh moved onto a new, unnamed child. So the rule reads the Blender names of the mesh and every ancestor (`blenderNames`), decal first (`.moss.shadow`), then moss (`.moss`), and logs how many moss meshes it dressed (`[render3d] scene "river": 6 moss meshes cast and receive leaf shadows`); a scene that prints no such line has no moss the rule found.
- **The side.** For a PCF map three draws the shadow pass with the *opposite* side of the material (its trick against acne on a closed mesh); the leaves are single-sided cards, so only their backs were drawn and every leaf facing the sun cast nothing. The moss material gets `shadowSide = DoubleSide`.
- **The biases.** The sun's constant bias is 6 cm of slack on the game's 75 m shadow camera, plus a 3 cm normal push (environment.ts), more than the gap between sheets. A bias belongs to the light in three, so `wearMossShadowBias` scales them inside the moss material's own program: constant x 0.1, normal x 0.5 (6 mm + 1.5 cm, against sheets 3 cm apart; more only thinned the shade), and the PCF radius x 0.33, because the sun's three-texel radius spreads three's nine taps 4.5 cm apart and drew every penumbra as a dither over a carpet that is all penumbra. The text patch on three's shader chunks warns on the console if a three upgrade moves the text.
The rock still receives with the sun's own biases, so the collar's shade on the stone is the part of it more than 6 cm out; the decal above supplies the rest.
**What made them show in play was exposure, not the light.** With all of the above in place the river still read flat, and an A/B with the moss code disabled changed almost nothing. The cause was the leaf colour: the study's tones (0.78 green, lit in Blender at exposure -0.7) under the river's 6.5 sun and 3.8 fill put a lit leaf and a shaded leaf both past the top of the ACES curve, near-white either way, and the shadows went with the contrast. Darkening the moss material by 0.35 in the loader (a temporary test) brought the shadows out at once; the fix is the add-on's default tones (build.Params; the panel's sRGB in settings.py): a third of the study's in green and a fifth in red and blue - a sixth all round was "too dark", and the green came back up further than the rest for "a bit more vibrant" - which is the reference's richer, darker green with its shadows intact. Along the way the level's sun was brought forward and lowered (`ball.json`: `sunZ` -0.2 to -0.6, `fillIntensity` 3.8 to 3.0; in this frame a negative `sunZ` is the camera's side - a positive one darkened every face toward the camera). Note for the future: at the game's 1.5 cm shadow texels a leaf's shadow is a soft blob, which is the look asked for; a map any coarser would lose it. And the sun's shadow frustum now moves in whole texels (`Environment.follow`), because slid continuously it re-rendered every shadow edge at a new sub-texel offset each frame the camera moved, a crawl the leaf shadows made plain.

**Black slivers in Blender's render are Blender's, not the mesh's.** Where several cards sit at the same depth (a flat host with `Tilt` 0 is the worst case) Eevee draws a black hole instead of one of them, and Cycles goes black where a camera ray crosses more than its transparent-bounce limit of card gutters (8; 128 renders clean). The game's renderer does neither: the same export drawn by three.js shows no black. The pitch keeps the default carpet clear of the Eevee case on a rock; the tell-tale is that the marks move when `Tilt` changes.

## Material and texture

One mesh, **one material**, `Moss`: the atlas's colour times the vertex colour, alpha cut at 0.35, back faces culled.
The shadow decal is a second mesh with a second material, `MossShadow`: white times the vertex colour, with the vertex colour's **alpha** as the opacity and no texture, blended (`surface_render_method` BLENDED, back faces culled, no transparent back). The exporter writes it as `alphaMode BLEND` with a four-component `COLOR_0`, the optimiser keeps the alpha through its quantisation (checked: 0 to 0.6 before and after), and three's GLTFLoader draws it transparent without writing depth, depth-tested under the leaves. Its material links the vertex colour's alpha, which is what makes the exporter write four components; the moss mesh's own `COLOR_0` stays three.
The underlay and the stems wear it too, sampling the centre of a round blob cell (alpha 1 there, and with no UV derivative the sampler reads mip 0); the stems are wound to face the camera.
Each node is one the exporter carries to glTF - `baseColorTexture x COLOR_0`, `alphaMode MASK` with `alphaCutoff`, no `doubleSided` - so `just scene` prints no warning, and three's GLTFLoader builds a `MeshStandardMaterial` with `alphaTest 0.35`, `FrontSide` and `vertexColors`.
The cutoff sits below 0.5 because mipmapping eats alpha-tested leaves at a distance.

**Why one material.** Until 2026-09-30 there were three slots (`MossBlobs`, `MossUnder`, `MossStem`), and the underlay reached the game white.
Blender 5.2's glTF exporter, given a second slot that reads the same colour attribute as the first, records that slot under the attribute's *name* where it later looks for the glTF attribute's name (`io_scene_gltf2/blender/exp/primitive_extract.py`, `materials_use_vc`), decides the slot does not use the colour, and writes its `COLOR_0` as 1.0.
The `.blend` held the right greens; the `.glb` did not.
With one slot there is nothing to mismatch, and the moss is one draw call; the old materials are removed from a file once nothing uses them.

The atlas is **generated**, not downloaded: `mesh_io.atlas()` draws a 4 x 4 sheet of polygon silhouettes - fifteen ivy leaves, three- and five-lobed, each drawn a little differently in how far its lobes reach, how deep its sinuses cut, how blunt its tip is and which way it leans, base at the bottom of the card (`build.LEAF_BASE`) and tip at the top (`build.LEAF_TIP`), and one faceted round for the underlay and the stems - softens them by blurring the alpha and re-thresholding, and writes it once to `assets-src/scenes/textures/moss-cutout-atlas-v<ATLAS_VERSION>.png`, packed into the `.blend`.
The leaves carry no veins: v4 drew them and the owner asked for the lines to go the same day.
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

2026-09-30, cast shadows: the study harness (`moss-experiments/harness`) now lights the rock as the game does (a 2048 map over a 30 m box, near 0.5, far 75, the sun's biases and radius, `mossShadow.ts` applied to the moss by its Blender name) and takes `?ground=1` for a floor, `?cb=`, `?nb=`, `?rad=`, `?sd=`, `?ms=` for the sun and `?cs=&ns=&rs=` for the moss's scales. With those the leaves shade the leaves below them, the collar shades the rock and the vines throw leaf shadows; a grid over the scales chose the defaults above. The same in Eevee, where the shadows were always right. `tsc --noEmit` passes. Not yet: a play, or the sun of a real level (its softness and angle are the level's).

2026-09-30, the shadow decal: the same headless rock, 6,052 decal triangles (the underlay-sized skin plus the margin), 0.3 s for the whole build; the export (478 KB) optimised to 112 KB with the decal as `alphaMode BLEND` and its alpha intact, and both Eevee and three.js show the soft cool band under the collar fading down the rock. Not seen in Blender's viewport by hand, nor on a river rock, nor in a play.

2026-09-30, later (the ivy carpet, the origin, no veins): headless only, on the study's chiselled rock with its stamp set, an origin at the front of the crown and two vines: 4,432 triangles (893 leaves) in 0.25 s; rendered in Eevee from the game's side, close and from above, exported to glTF and drawn by three.js through the study harness as one `MeshStandardMaterial` (`alphaTest 0.35`, `FrontSide`, vertex colours, one draw call).
The growth direction was checked numerically on a flat 2 m plane with the origin at a corner: the median leaf points 17 deg from straight away from the origin (`Spread` is 25), no card faces down, and card height falls with distance from the origin (r = -0.71).
Not yet: Set Origin driven in a real Blender session (its modal code is the vine placer's), the watcher regrowing on an origin moved with G, the carpet on a river rock through the brush, an export by `just scene`, or a play; the leaf size, tilt and spread defaults are a first pass.

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
