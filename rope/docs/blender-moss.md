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

All of it is `build.py`, a pure function of the rock's evaluated mesh, its world matrix, the stamps and the settings; the same inputs give the same mesh bit for bit.

1. **Refinement.** The rock's triangles near a stamp are split by Rivara's longest-edge bisection (with LEPP propagation) until every edge there is at most `Resolution` long; far from the paint nothing is split.
   Plain edge splitting on a 5 m facet fans slivers out to the far corner without end, and a bmesh operator per split walks the whole mesh each call (14 s for a patch); the bisection runs on plain Python lists.
2. **Mask.** The stamps composited in painting order: paint lays `m += (1 - m) a w`, erase `m *= 1 - a w`, with `w` a smooth radial falloff times how far the vertex faces the way the stamped surface did (a stamp on a ledge's top does not paint its underside).
3. **Outline.** The mesh is clipped at `m = Threshold + Edge Noise x noise(Edge Scale)`, so the edge is lobed at a size of its own rather than following facets; islands under `Min Patch` are dropped.
4. **Cushion.** Every vertex rises along a smoothed normal (the rock's creases rounded over at `Rounding`) by `Thickness`, ramped up from the outline over `Feather` (a geodesic distance) and modulated by `Lumps` and `Fuzz`.
5. **Lips.** An outline vertex is a lip when the moss runs off a drop: on a top, the ground falls more than `Lip Drop` just beyond it; on a wall, the outline runs downhill.
6. **Curtains.** Every lip vertex grows a column that crawls over the lip (turning down at `Bend Radius`), hangs under gravity, is pushed out of the rock (with a `Gap`) and drawn back onto a wall within `Cling Reach` (so it follows an undercut; a ceiling never draws it).
   A column stops when it lands on ground that faces up.
   Its length is the sheet's (`Length`, varied broadly by `Length Variation`) plus the fingers' (`Finger Width`/`Finger Length`/`Finger Taper` - below 1 rounded lobes, above 1 spikes) and the strands' (`Strands` per metre, `Strand Length`, `Strand Width`), tapered to nothing over `End Taper` at the ends of a lip.
   Once a column hangs clear of any wall only `Free Sheet` of its sheet goes on while its fingers keep their length, so a sheet off an overhang breaks up into drips.
   Neighbouring columns of different lengths are zipped into one sheet whose top row is the cushion's own outline, so the two are one surface; it thins toward the tips (`Curtain Thickness`, `Thinning`) and its fingers wander sideways (`Sway`).
7. **Surface.** UVs per corner: the cushion is projected along the axis each triangle faces most (the texture is noise, so the seams do not read), and a curtain is unrolled along its lip and down its length, so its fingers are never stretched (`Texture Scale` is metres per tile).
   Vertex colour is a **tint** the material multiplies with the texture: `Base` at the outline to `Crown` at full thickness, curtains from the crown's tint to `Tips`, varied by `Variation`.

## Material and texture

Every moss shares the material `MossGrown` (not `Moss`: the generated cavern has one of that name): the moss texture's base colour multiplied by the vertex tint, its normal map and its roughness, both faces drawn.
Each node is one the exporter carries to glTF - `baseColorTexture x COLOR_0`, `normalTexture`, roughness, `doubleSided` - so `just scene` prints no warning for it.
The texture is `grass_05` from [FreeStylized](https://freestylized.com/material/grass_05/) (royalty free, credited through `tools/blender/image_credits.json`, see [blender-scenes](blender-scenes.md#credits)), a painterly grass of mean sRGB (0.41, 0.69, 0.29); the tint defaults pull it to the reference's olive.
The 4k download lives in `assets-src/grass-05/`; the add-on makes 1k copies in `assets-src/scenes/textures/moss-grass05-*.png` the first time the material is built (the optimiser caps a scene's textures at 1k anyway) and packs them into the `.blend`, so the scene exports on any machine.
Both folders are raws under `assets-src/`, gitignored like every raw.
Changing `MATERIAL_VERSION` in `mesh_io.py` rebuilds the material in every file on its next use.

## Export

`scene_export.py` grows every moss object again before it selects anything, so the moss that ships is grown from the paint against the rock as it is now, never the preview saved in the file.
A moss whose rock is gone is hidden from the export with a warning.
Each moss's triangle count and build time is printed as a `[scene_export] moss` line.
The moss node stays a child of its rock through the optimiser (`--keep-hierarchy`), so moss on a rock that dresses a body rides the body.

**Bake to Plain Mesh** copies a moss into an ordinary mesh to hand-edit, and hides the moss object from the render so only the copy exports; the copy is never regrown.

## Verified, and not

2026-09-28: headless, a painted stripe on the river's `01_Near_Ledges_Basalt_R1_Block` built in 0.35 s and went through `scene_export.py` and the optimiser with `POSITION`, `NORMAL`, `TEXCOORD_0`, `COLOR_0`, its textures and its parent intact, and was drawn by `cli shot --3d` at the level's start camera.
The brush was driven for real - GUI Blender on a private headless sway (`WLR_BACKENDS=headless`, a short `XDG_RUNTIME_DIR`, since the socket path is limited to 108 characters) with `--enable-event-simulate` and a simulated left-drag - and laid stamps, created the moss object, grew it, and regrew it on a setting change.
Not yet judged by eye in a play; the look's defaults are a first pass.

## Not yet

- The texture has small pink and yellow flowers, which show as specks in the moss.
- The optimiser encodes a scene's normal maps as lossy WebP, which [asset-store](asset-store.md) says a normal map must not be; true of every scene, not only moss.
- No vertex-group mask; a dense, hand-modelled rock might be easier to weight paint.
