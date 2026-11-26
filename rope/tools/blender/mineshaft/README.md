# Painterly mineshaft kit

Original Blender geometry and materials for the game's cool slate cave palette:
smoked ochre timber, flat painted grain, blue charcoal iron and warm emissive lantern globes.

Rebuild sources and the overview render from the repository root:

```sh
blender -b -noaudio --factory-startup --python rope/tools/blender/mineshaft/build.py
blender -b -noaudio rope/assets-src/studies/mineshaft/mineshaft-kit.blend --python rope/tools/blender/mineshaft/render_details.py
```

Open `rope/assets-src/studies/mineshaft/mineshaft-kit.blend` for the arranged
editable overview. The sixteen reusable files are in `rope/assets-src/models/mine-*.blend`.
Each contains one scene collection named after its model, marked as a Blender asset.
Materials use self-contained procedural nodes and packed painted timber maps;
there are no external textures to relink. The `guide.presentation` collection
contains the overview floor, lights, camera, hook and extra display lantern only.

| Model | Purpose / pivot |
| --- | --- |
| mine-rail-straight | 4 m straight; start at origin, along +X |
| mine-rail-curve | 45° turn, 5 m centre radius; start at origin, along +X |
| mine-rail-broken | 4 m damaged straight; offset rail fractures |
| mine-ladder | Nine rungs, ground pivot |
| mine-crate | Closed box, centre pivot |
| mine-crate-long | Low elongated closed box, centre pivot |
| mine-planks | Four loose planks, ground pivot |
| mine-support | Braced mine entrance frame, ground pivot |
| mine-oil-lantern | Red flaking paint, emissive globe, side arms joined to the tank shoulders and a flat stepped foot; hanging pivot |
| mine-pickaxe | Tapered iron head, ground pivot |
| minecart | Open tapered iron hopper, four spoked wheels, steel push grips at both ends; tread-height pivot |

Build the short tiling track segments the track prefabs draw (two sleepers 1.3 m
apart, the spacing measured on Tris's reference, and 0.65 m of rail beyond each;
2.6 m long), from the kit's straight and broken track files:

```sh
blender -b -noaudio --factory-startup --python-exit-code 1 --python rope/tools/blender/mineshaft/build_rail_segment.py
blender -b -noaudio --factory-startup --python-exit-code 1 --python rope/tools/blender/mineshaft/build_rail_segment.py -- broken
blender -b -noaudio --factory-startup --python-exit-code 1 --python rope/tools/blender/mineshaft/build_rail_segment.py -- bare
cd rope
just model mine-rail-segment
just model mine-rail-segment-broken
just model mine-rail-segment-bare
```

They keep the kit file's sleeper assembly, its Repeat sleepers modifier set to
the segment's length and spacing, and rebuild the rails with the kit's section,
`rail_profile.py`, which `build.py` uses too; their edge wear is baked as
`build.py` bakes it. Rebuild them after rebuilding the kit.

Build the standalone minecart and its two inspection renders:

```sh
blender -b -noaudio --python rope/tools/blender/mineshaft/build_minecart.py
cd rope
bun run model:export minecart
```

The editable source is `assets-src/models/minecart.blend`; previews are
`assets-src/studies/mineshaft/minecart.png`, `minecart-side.png`, and
`minecart-on-rails.png` (using the existing track asset).
The cart travels along X, with its four wheel treads centred on the kit's
1.14 m rail gauge. Place the model origin at rail-head height (0.242 m for
the existing tracks); wheel flanges extend 0.03 m below that origin.
Both short ends carry raised shopping-cart-style handles with brushed steel
grips. The hollow bin uses dark iron with subtle desaturated brown oxide washes, fine
surface grain, and muted rubbed edges. Rust uses a soft two-scale mask;
the underlying steel has restrained directional grain instead of cloudy colour
variation. The frame and grips have less oxidation than the bin panels.
Packed metal/roughness maps on `CartFinishUV` make the rust matte and nearly
nonmetallic while exposed iron retains its reflection. Colour and shallow
surface normals remain procedural in the source and use the game export bake.
Wheels and handles remain separate named meshes; each wheel's local Y axis
passes through its axle for animation. Collision is authored
independently in the editor, as for the rest of the model library.

Metres, Z up, -Y front. Rail centres are 1.14 m apart. Rail collections include
`socket.start` and `socket.end` arrow empties; align a new segment's start to the
previous end, including rotation. The curve endpoint is (3.535534, 1.464466, 0)
with a 45° heading. Collection custom properties also record these values.

The overview is an asset inspection scene, not an edit to a game level. Export
individual models with the existing `just model <name>` workflow when placing
them in a level. Collision remains independently authored in the level editor.

The images the kit's scripts paint (`edge_weathering.py`'s `… • baked edge paint`,
`painted_surfaces.py`'s sleeper grain and end grain) carry a `generated_by` custom
property naming the script, so the exporter credits them as originals; the kit's
`.blend` files built before 2026-11-26 were tagged in place.

## Prefabs

`rope/prefabs/` places the kit with its collision (docs/prefabs.md), in pixels, y down:

| Prefab | Body | Collision |
| --- | --- | --- |
| mine-track | static; origin at the track's start on the ground; draws `mine-rail-segment` at scale 0.6 (Tris, 2026-11-26), so a piece is 1.56 m | Tris's own: a rect under each sleeper |
| mine-rail | static; same frame and scale as mine-track; draws `mine-rail-segment-bare` (the rails alone) | one steel rect over the rails, 1.56 m long, 0.095-0.145 m up (the rail head level with mine-track's) |
| mine-track-broken | static; same frame; draws `mine-rail-segment-broken` | two steel rects from the ground to the rail head, open where both rails are broken (1.249-1.392 m, narrower than the ball) |
| mine-sleeper | static; origin at the foot, centred | one rect, 0.40 x 0.20 m |
| mine-lantern | rigid; origin at the top of the crown loop, the hang point (the model sits 0.305 m up) | the mesh's side-view convex hull, hook-proof, 180 kg/m³ (25 kg); a warm flickering light at the flame and an `Anchor2D` at the origin to chain it from |

Segments butt end to end at 260 px, so a run of track is as long as its segments,
2.6 m at a time, and the sleepers stay 1.3 m apart across every join. The track's collision is a 2D silhouette in
the play plane, which lies between the two rails: the ball rolls at rail-head
height, and the minecart (origin at the rail head) sits on it.

## Adjusting rail slat spacing

Select **Sleepers + attachments • adjust spacing in modifier** inside a rail
collection, open the Modifiers tab, and change **Sleeper spacing** under
**Repeat sleepers • spacing in metres**. This is centre-to-centre distance in
metres (minimum 0.45 m for straight tracks, 0.49 m for curves). Count updates automatically and the two end margins
stay equal. Curved-track assemblies rotate to follow the rails.

The object's base mesh is one wooden sleeper with both rail chairs, clips and
nails. Tab into Edit Mode to edit that assembly. The actual iron rails are
separate objects and are unaffected by this modifier. Geometry Nodes realizes
the repeated assemblies for the existing export pipeline.

Render an unobstructed lantern close-up:

```sh
blender -b -noaudio rope/assets-src/studies/mineshaft/mineshaft-kit.blend --python rope/tools/blender/mineshaft/render_lantern.py
```

Wood shaders use beam-local `paint_coords`, retained through the sleeper array,
for aligned grain and cut-end rings. All ladder, crate, plank, support and pickaxe
timber uses the same soft painted grain and worn ochre edges as the sleepers.
Grain follows the board length with shallow bends; colour washes avoid diagonal
cross-grain bands and use restrained contrast.
Transverse grain coordinates are scaled to each board; `end_coords` supplies
crosscut growth arcs. Hard mesh grain ribbons are omitted. Metal uses fine forged grain
and directional roughness variation. The lantern's side arms terminate at the tank shoulders, leaving its stepped
foot flat, as in the reference.

The current lantern follows the fuller hurricane-lamp reference with chipped red
enamel exposing cool steel in sparse angular patches along exposed rims and handle
attachments. Thin folded rims, sharp seams and subtly faceted arms distinguish it
from clay. Dark iron guards are thickened for small-screen readability.
The large outer carry handle is removed; the small crown loop remains. The
original model pivot is retained so existing level placements stay aligned.
The stylised opaque globe uses a bright amber core, darker honey edges and matte
soot at the crown, without glass reflections or transmission. Matte inner sleeves
keep the vent openings dark. `render_lantern.py` also writes a 160×192 readability
study (`lantern-small.png`); this is a fixed preview, not a game-runtime capture.
The track has separate warm-iron materials and carved ochre sleepers
with broad grain, rather than the finer grain used on the other timber props.

The packed sleeper paint map uses a per-sleeper phase and tint through
`sleeper_seed`. Rails have spatially broken wear on the top and bevels.
Optional array presets use a 0.45 m straight / 0.49 m curved minimum. Independent sleeper assets have no spacing constraint.

## Independent placement assets and rock-style weathering

Use `mine-sleeper-a.blend`, `mine-sleeper-b.blend`, or `mine-sleeper-c.blend`
from `assets-src/models`. Each is one independent asset containing one wooden
sleeper and both sets of fasteners. Its origin is at ground height beneath its
centre; +X is rail travel and the timber spans Y. No spacing modifier is attached.
The three variants differ in outline, open-ended splits, missing corners, angled end cuts, chamfer bites and paint phase.
Cut faces use a packed crosscut map with off-centre, uneven annual growth arcs,
narrow darker latewood bands and sparse tapered drying checks. End and variant
offsets vary the visible part of the grain while preserving its cross-section scale.

`mine-rail-straight-bare.blend`, `mine-rail-curve-bare.blend`, and
`mine-rail-broken-bare.blend` contain rails and alignment sockets only. Place the
sleepers at any X spacing, or rotate them tangent to the curve. All use the same
1.14 m rail-centre gauge and rail foot height. The optional old assembled files
retain their spacing modifier. The overview uses individual sleeper objects.

The wood is now 0.13 m thick. The rail section rises from 0.158 to 0.242 m, rather
than the earlier tall industrial I profile. `edge_weathering.py` adapts the
existing rock shader's `formations/slate.py` Bevel-dot-normal edge mask, chamfer
strip treatment and short ambient-occlusion convex gate. Small-scale variation
breaks the wear up, but geometry determines where it belongs. Rail metal adds
broad olive-brown painted tonal patches and a separate broad mask that makes
the edge highlights intermittent, with sparse rusty patches.

The colour result is baked to a packed 1024px UV map per rail/sleeper object and
256px per individual timber beam or board. This is essential
because the Bevel shader is Cycles-only; the baked result also appears in Eevee
and Material Preview. Original authoring materials remain in unused slots.
Baking does not include direct scene lights. Mesh bevels supply the edge shape.

Research:
- Blender Bevel node: https://docs.blender.org/manual/en/latest/render/shader_nodes/input/bevel.html
- Blender baking: https://docs.blender.org/manual/en/latest/render/cycles/baking.html
- Adobe curvature/AO edge wear: https://experienceleague.adobe.com/en/docs/substance-3d-painter/using/effects/generators/metal-edge-wear
