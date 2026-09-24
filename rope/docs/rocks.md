# Generated rocks

Since 2026-09-23 a level's rock is not drawn as the flat extrusion of its collision outline but as **faceted boulders built offline in headless Blender**, one GLB per level.
It is an MVP: the shape and the swap work, moss and everything under [What is not done](#what-is-not-done) do not.

The reference look is the boulders of "A Difficult Game About Climbing": faceted, pale grey, low detail, stones piled against each other with dark cracks where they meet.
It is the rock half of the [painterly style](art-style.md): large flat planes of tone with crisp edges, which here come from the geometry rather than from a painted normal map.

**The geometry outline is the reference, the collision outline is the actual.**
A rock is generated from its geometry object's outline and stands exactly on it at the gameplay plane, bulging freely in depth within the authored `depth` (half of it in front of the plane, tapering back to the plane at the edge where the object says so).
The collision object is then fitted to what was generated and can be tweaked by hand without moving the reference (see "Reference and actual outlines" below).

## Why offline Blender

- **Clean facets need a remesh and a planar decimate**, which three does not ship and which would be slow to run at load.
- **Cavity shading is baked** (Blender's dirty vertex colours), so the cracks cost nothing per frame.
- **One script reads the level**, so the moss can later follow the attachable flag rather than being painted by hand.
- A model pack cannot follow an authored outline at all.

The cost is a regeneration step whenever a rock's outline changes, which the author accepted; [staleness](#staleness-and-the-hash) makes a forgotten one visible instead of wrong.

## The pipeline

1. **The level file is the source of truth.** `src/render3d/rocks.ts` decides which pieces are rock and lays them out; it is free of three.js so bun and the browser read the level through the same code.
2. **The job.** `scripts/generate-rocks.ts` (`bun run assets:rocks <level>`) reads `levels/<level>.json`, calls `rockBodies`, and writes a JSON job to the temp dir: per rock body its index, hash, and pieces (world-space outline in metres, `depth`, `z`, `taperStart`, `taperAngle`, `mossy`).
   Each body also carries `seed`, the body's `rockSeed` (absent = 0), which `rocks.py` reads as `body.get("seed", 0)`.
3. **Blender.** It runs `blender -b --factory-startup --python tools/blender/rocks.py -- job.json out.glb` (`--blender PATH` or `$BLENDER` overrides the binary) and echoes only the `[rocks]` lines and anything that looks like an error.
4. **The GLB.** `public/rocks/<level>.glb`, gitignored like every other binary the renderer draws. One node per body, named `body-<index>` (`rockNodeName`), carrying `rockIndex` and `rockHash` as glTF extras.
5. **The runtime swap** (below).

**Which pieces are rock.** A body counts when it is `static` and not `passable`; a geometry object on it counts when it is a `primitive` (`rect`, `poly` or `circle`, a circle as 24 sides) wearing one of the `ROCK_TEXTURES`: `dark rock`, `marble cliff`, `rock wall`, `rock-grey`, `stone`, `moss-dark`, `mossy ground`.
The last two set `mossy`, which the generator ignores today but which is in the hash, so a moss pass will mark every mossy body stale.

**How an outline becomes stone.** The recipe is the author's Rock_Cliff_Sharp geometry-node setup, done with modifiers and numpy: cube, Voronoi position offset, instance on points, bevel, voxel remesh, noise offset.
A body builds a handful of shard templates (a cut cube warped by a Voronoi texture, tapered by `SHARD_TAPER`, bevelled and Catmull-Clark subdivided), then fills each outline with many tall, overlapping instances of them, sized by `SHARD_BASE` times the rock scale S (`ROCK_SCALE`, one constant for the whole level, so a 5 m wall and a 1 m ledge show the same size of stone), randomised within `SHARD_SCALE_MIN..MAX`, spun about the vertical by `SHARD_SPIN`, jittered by `SHARD_OFFSET` and wandered by a large noise (`WANDER`, `WANDER_SCALE`) so the columns lean and stagger.
Their depth is the extrusion's: the authored `depth` centred on the gameplay plane, so the proudest faces stand half of it in front of the plane, exactly where the flat extrusion's front face was (a first version put them at the plane and the ball looked as if it hovered ahead of the rock).
Toward the outline's edge the front falls back by `EDGE_FALL` times S, reaching full fall at the edge and none `BULGE_RADIUS` in from it, the rounded profile of a rock.
A `PROUD_SHARE` of the shards sit at that front (jittered by `DEPTH_JITTER`) and the rest are recessed behind it by up to `RELIEF` times S, which is where the stepped column faces and their shadows come from; both are capped so they fit in the depth.
Every shard is stretched from its front to the back of the solid, so a top face shows shard tops rather than a thin fringe in front of a slab, and one prism of the outline fills in behind the deepest recess, at least `MIN_BACKING` thick.
The stretch is along the shard's own depth axis about its front-most point, an affine map that keeps every face planar; scaling world depth sheared the spun shards into a lean, and shifting only the back half by a step folded every cap that spanned the depth into a V-shaped crease.
Each shard that reaches past the outline is intersected, on its own, with one straight prism of the whole concave outline (Blender's float boolean; a shard is a simple closed solid, so it is exact enough and takes milliseconds).
The float boolean now and then returns a shard wound inside out (3 of 275 on body 150), and every chunk is re-wound by the sign of its enclosed volume (`outward`): an inside-out shard had its front faces taken by the back-face cull and its back faces kept, a hollow shell whose far wall showed from inside as "a hole in the top face".
It also returns some shards with triangles missing (8 of 275 on body 150), open shells whose missing faces were holes in the rock; `clip_shard` keeps the float result only when it is watertight (`is_closed`), otherwise takes the exact solver's, and fills whatever is still open, and the build reports how many shards needed which.
A result is also refused when it reaches outside the shard's own bounding box, which an intersection cannot do: the exact solver once handed back the clip prism itself for a shard it could not cut, closed and body-sized, and that slab stood at the front of body 110 and hid every real shard behind it (the whole body read as one smooth wall).
The prism is the outline itself, with no tolerance: the faces perpendicular to the camera stand flat on the collision line, which is what the author asked for once the collision outline could be fitted to the rock afterwards (see "Reference and actual outlines").
A tolerance of 6 cm plus 3 % of S came before and stood the walls 12 cm out at S = 2, and a ragged edge (shard ends stopping a random way short of the outline) came and went for the same reason: the top of the rock has to be where the collision outline says it is.
The TAPER is the geometry object's own `taperStart` and `taperAngle` (see [level-format](level-format.md)), honoured by placement, never by cutting.
Below `taperStart` in front of the plane the side walls stand on the outline; from there the surface leans in from the wall by `taperAngle` degrees, a straight chamfer, until it reaches the proudest front at half the depth (`taper_top`).
An angle of 0 is no taper at all, and 90 a flat cap at the start.
Every shard's front is set so the WHOLE shard stands under that surface, read at the shard's nearest extent rather than its centre, so the chamfer is a staircase of whole column ends, one step per shard: an edge shard whose body touches the outline has its top exactly at the start, so along every edge there is a rim about one shard wide at the start's depth, and the columns step up behind it.
A quarter-round taper driven by the extrusion's `bevel` came before this and was rejected: its profile is vertical at the outline, so a strip of the edge showed no taper whatever the margin was, and a narrow arm of an outline that sat entirely within the band never reached full depth while the wide middle did.
Both fields are in the hash, so changing either in the editor marks the body stale; `bevel` is no longer read by the rock pipeline and stays the flat extrusion's chamfer.
The extrusion a rock is drawn with while it has no generated mesh, in the editor and in the game while it is stale, is this same tapered solid (`taperOutline` in `render3d/extrude.ts`: the outline straight through to the start, then a roof whose height is the distance in from the outline times the slope, as a grid of cells clipped to the outline), so the author sets the taper against the shape the rock will fill, and a rock's `bevel` is not drawn at all.
Clipping by half-planes against convex parts came before this and could not be made right: every decomposition seam cut the shards along a straight line across the rock, and at a reflex corner the seam plane's extension left a facet belonging to no outline edge.
The convex parts (`decomposeConvex`, shipped by `pieceOf`) now only triangulate the caps of the backing and clip prisms.
By default the shards ship as instanced: the chamfered low-poly pieces, overlapping, with crisp corners and about a hundred triangles each.
With `--remesh` (the author's recipe's step) the lot is instead voxel-remeshed into one solid (`VOXEL_SIZE`), which fuses the shards but rebuilds the skin as a uniform grid at the voxel size, thousands of triangles per square metre, and rounds every corner by a voxel; the templates are Catmull-Clark subdivided (`TEMPLATE_SUBDIV`) only on that path.
Either way the mesh is then warped by the three `DETAIL` offsets (smooth noise at three feature sizes, all scaled by S), stripped of stray islands (`ISLAND_MIN`) and back faces, planar-dissolved (`DISSOLVE_ANGLE_DEG`, which folds the boolean's coplanar triangles back into facets without moving a vertex), and shaded smooth with edges over `SHARP_ANGLE_DEG` marked sharp.
The offsets move every vertex by the same vector for a given field value, as the author's graph does (a scalar texture times a constant vector), so they warp the rock without rounding it; displacing along the normal instead eroded every shard edge into a blob, and the legacy Voronoi texture's hard cells covered the faces in bubbles.
`depth_shade` then darkens the colour layer with depth (`DEPTH_SHADE`), because the game looks at a rock head-on and lit head-on, where a recessed slab would otherwise be exactly as bright as the one in front of it.
`bun run assets:rocks ball --flat` skips the ambient-occlusion bake so a shape iteration is quick (the material treats a missing AO map as none), and `--decimate R` replaces the planar dissolve with a collapse to R of the faces (1 = none at all); the collapse smears the facets and moves vertices out from under the buried-face pass, so it is an inspection tool rather than the shipping path.
Building a few bodies to `public/rocks/test.glb` and opening the game with `?rocks=test` is the fast loop: the other bodies report stale and keep their extrusions.
The GLB carries no colour or detail texture of its own; the look is composed at runtime by the rock material (see "The rock material") from two tileable Poly Haven sets and the masks the generator bakes.
`TEXCOORD_0` is a box projection in world metres (`TEXTURE_TILE`), V along world up on every face that has one, for the detail tiles.
`TEXCOORD_1` is a per-body atlas (Smart UV Project) carrying Cycles-baked ambient occlusion, sized by `AO_TEXELS` per metre of surface between `AO_SIZE_MIN` and `AO_SIZE_MAX`, `AO_SAMPLES` per texel, occluders within `AO_DISTANCE`, the body baked alone with every other object hidden; it is exported as the material's occlusionTexture, which three mounts as `aoMap` on channel 1, and `--flat` skips it.
The unwrap's island margin has to be tiny (`AO_ISLAND_MARGIN`): a body is tens of thousands of small faces, and at 2 % the packer shrank every island to a dot and the atlas was 2 % covered; the islands are then repacked by `uv.pack_islands`.
The shards overlap, so most of a piece's triangles lie inside neighbouring shards where nobody sees them; `drop_buried` deletes them before the shards are joined, a triangle whose centre pushed `BURIED_EPSILON` outside its own solid lies behind every face plane of another chunk (the half-space test, exact for a convex chunk and only ever conservative for a concave one).
Left in, they were half the triangles and most of the atlas, all of it black, and the small visible column ends packed beside them read black through the texture filtering, which showed as holes in the tops of columns.
An occlusion-based test and a ray-parity test both came first and both deleted visible faces (the bottom of a narrow slit reads no occlusion, and a ray through the shared edge of two coplanar triangles counts twice), so the rock showed the sky through it.
The unwrap runs on this body alone with every other object deselected: every selected mesh enters edit mode with the active one, and the level build's unwrap of one body once re-projected the previous body's box UVs, so its detail tiles all read through the atlas.
The colour layer is `FLOAT_COLOR`, because a byte layer is stored as sRGB and linearised on export, which would hand the shader every mask raised to 2.2.
`COLOR_0` is masks, not colour: r = cavity from Blender's dirty vertex colours (1 open, 0 deep), g = depth shade (1 at the proudest face, 1 - `DEPTH_SHADE` at the deepest recess), b = a per-shard random carried through the build as the "shard" attribute, a = 1.
A generated striated texture (`rocktex.py`) baked into the GLB came before this and was replaced by the scanned sets once the geometry was settled; the tint, hue and shade jitter it needed went with it.
The random stream is seeded from the body's hash, so the same outline always gives the same rock.

## The frames

The job is in three's frame (x right, y **up**, z toward the camera); `pieceOf` flips the sim's y-down so the generator never learns it.
The generator's docstring on how Blender's frame maps to it:

> The game draws in three's frame (x right, y up, z toward the camera).
> Blender is z-up, and its glTF exporter maps Blender (x, y, z) to glTF (x, z, -y), so a boulder is built here with Blender x = game x, Blender z = game y, and Blender y = -(game z): its front face, the one toward the camera, is at NEGATIVE Blender y.
> Objects stay at the origin so the exported node transform is the identity and the vertices ARE world coordinates.

So the runtime mounts a node in world space as it comes, with no transform of its own.

## The runtime swap

Being written alongside this doc; described as designed.

- `Scene3D.setRocks(name)` picks which level's GLB to load. `main.ts` passes `?rocks=<name>` when given (`?rocks=0` turns rocks off), otherwise the level spec's `file` (`ball` for `BALL`). The shot page does the same from the bundle's level id, so `cli shot <bundle> --3d --query rocks=ball` sees them.
- At `setLevel`, `src/render3d/rockMesh.ts` loads `rocksUrl(level)` = `/rocks/<level>.glb`. A 404 is silent: a level with no generated rocks is normal.
- For each node whose `rockHash` still equals the hash of that body's current outlines, it hides the body's flat extrusion of those objects and mounts the node in world space.
- The meshes wear the [painted light](lighting-and-surfaces.md#painted-light) like props, so `?paint=0` is the plain A/B.

## The rock material

Since 2026-09-24 a mounted rock is not drawn with the GLB's own material but with `rockMaterial` (`src/render3d/rockMaterial.ts`).
The look is **stylised, hand-painted stone** (the owner's direction, 2026-09-24), after a Rafal Urbanski stylised rock study.
What makes that look, and what the first, photographic slate material lacked: faces read as **flat planes of tone with soft gradients**, not grain; the value is set mostly by **which way a plane faces** (up light, side mid, down dark); convex edges are a little lighter; the cracks between blocks are a **cool** dark; and the surface detail is only a low-contrast painted mottling with a few dark specks.
The machinery is **baked low-frequency masks plus tileable detail**: Blender bakes what varies over the size of a shard (cavity, depth, occlusion), and two painted tiles supply the mottling and a subtle relief.
The hue stays the level's `dark rock` colour (`ROCK_BASE`, #3a342c, the owner's ask) and the palette is value variations of it; the reference's own cool blue-grey is a second preset one edit away.

It is a `MeshStandardMaterial`, what `surfaceOf` builds for every other surface, patched in `onBeforeCompile`, so shadows, fog, tone mapping and the painted light treat a rock like any other surface; `paintMaterial` is applied after the rock patch and calls it first, and `?paint=0` still gives the plain A/B.
`rockMesh.ts` gives every body node one material (the AO atlas is the body's own), carries over the GLB material's `aoMap` with its `channel`, and disposes the rest of the GLB material.
All materials share one program (`customProgramCacheKey` `rock|2|<palette>`, extended by the paint patch; the palette is compiled in as constants) and one set of tile uniforms, so a tile that lands later updates every rock without a recompile; until then each tile is a 1x1 neutral stand-in.

### The GLB contract

- `TEXCOORD_0`: world-metre box UVs. Front and back faces are (x, up), side faces (depth, up), top and bottom (x, depth), so V is world up on every face that has an up, and one unit is one metre.
- `TEXCOORD_1`: the body's AO atlas UVs; the glTF material's `occlusionTexture` on `texCoord` 1 becomes `material.aoMap` with `channel = 1`.
- `COLOR_0`: **masks, not colour**. r = cavity (1 open surface, 0 deep cavity, from Blender's dirty vertex colours), g = depth shade (1 the proudest face, about 0.55 the deepest recess), b = a per-shard random in 0..1, a = 1.
- glTF vertex colours are linear, so the masks must reach the file as linear values: a Blender `BYTE_COLOR` attribute is stored as sRGB and exported converted, which would hand the shader roughly mask^2.2; `FLOAT_COLOR` is exported as written.
- Nothing else in the GLB material is read.

Any input missing reads as neutral: no `aoMap` is an AO of 1, and a mesh without `COLOR_0` gets a material without `vertexColors` that reads cavity 1, shade 1, variation 0.5, rather than the zeros an absent attribute would feed the shader.
`COLOR_0` reaches the shader through three's own `vColor`, and three's `diffuseColor *= vColor` (`color_fragment`) is replaced, so the masks are never multiplied in as a colour.

### What is composed from what

- **Albedo** (replaces `color_fragment`) is a ramp, built in four steps.
  1. **The hemisphere term** picks the plane's tone by the world normal's y: the palette's `side` blends to `sky` over smoothstep(`ROCK_SKY_LO`, `ROCK_SKY_HI`, y) and to `ground` over smoothstep(`ROCK_GROUND_LO`, `ROCK_GROUND_HI`, -y).
     The normal is the geometric one (the GLB's smooth shading with its sharp edges), never the detail-mapped one, so one facet is one tone; this term does most of the work, and it replaces the old "dust" on up-facing faces.
  2. **The edge lift** multiplies the colour toward `edge / side` (per linear channel) by `ROCK_EDGE_AMOUNT` where the cavity mask is near 1 and the depth shade is high, so a convex, proud face is lighter than its plane in the same proportion whichever way it faces.
  3. **The crevice** blends to the palette's cool `crevice` by a smoothstep of (1 - cavity) and (1 - AO), a dark drawn in the gaps between blocks.
  4. **The mottling**: the painted `seaside rock` base at its 2 m tile, desaturated by `ROCK_DESATURATE`, divided by its own mean linear luminance (measured once from a 32x32 downscale when it loads) and flattened to `ROCK_ALBEDO_CONTRAST`, so it adds soft low-contrast patches and a few specks and never a hue or a change of overall value.
  The result is multiplied by the depth shade, by a per-shard brightness jitter from b, and by `ROCK_AO_DIRECT` of the AO.
- **Normal** (replaces `normal_fragment_maps`): the painted `quarry wall` normal at its 1.8 m tile, plus a second sample at `ROCK_DETAIL_SCALE_2` times the frequency added in at `ROCK_DETAIL_WEIGHT_2` (the `secondDetail` option, on by default), scaled by `ROCK_NORMAL_SCALE`, which is kept subtle: the painted facets only break a plane's gradient a little.
- **Roughness** (replaces `roughnessmap_fragment`): the `quarry wall` roughness (green channel) plus `ROCK_ROUGHNESS_BIAS` plus `ROCK_CAVITY_ROUGHNESS` times (1 - cavity), clamped; the painted light floors it at 0.42 anyway.
- **AO**: `aoMapIntensity` = `ROCK_AO_INTENSITY`, and three's own `aomap_fragment` applies it to the indirect light as usual; `ROCK_AO_DIRECT` is the share that also darkens the albedo, because the scene is lit nearly head-on and the sun alone lights the back of a gap as brightly as the face in front of it.

A set missing from the manifest falls back to `dark rock` for its role, with one `console.info` line.

### The palettes

`ROCK_PALETTES` holds two named presets and `ROCK_PALETTE` picks one; flipping the look is that one edit.

| Palette | sky | side | ground | edge | crevice |
|---|---|---|---|---|---|
| `dark-rock` | `#9c8f7d` | `#4e463b` | `#231f1a` | `#746858` | `#101317` |
| `cool-slate` (default) | `#b0b4b8` | `#7a828c` | `#3a4048` | `#aab0b8` | `#161a22` |

`dark-rock` is built in code from `ROCK_BASE` (HSL lightness 0.20) by `valueOf`, which keeps its hue and saturation and sets the lightness: sky 0.55, side 0.27, ground 0.12, edge 0.40.
So the rock stays the colour of the `dark rock` texture (the owner's ask) and gains the stylised value range; only the crevice leaves the hue, a cool near-black rather than a warm brown.
`cool-slate` is the reference study's own blue-grey (light faces about #b0b4b8, dark faces about #3a4048).
The palette is compiled into the shader as constants and is in the program cache key.

### The painted tiles

Since 2026-09-24 both detail sets are painted by the ordinary pipeline (see [asset-store](asset-store.md)): every map of `seaside rock` and `quarry wall` records `paint: { brush: 36 }`, with no cavity, saturation or strokes.
At the 1024 output a brush of 36 turns the seaside albedo's grain into soft plateaus several centimetres across (the brush is about 7 cm of the 2 m tile; the mottling) and the quarry normal into facets; the cracks the rock shows come from its geometry and masks, not from the tile.
Before that the tiles stayed photographic on purpose, which is what the first material's slate grain was.
`bun run assets:paint "seaside rock" "quarry wall"` rebuilds them from `assets-src/`.

### Why the detail is sampled with its axes swapped

The quarry wall's striations run along the image's u axis, and on the rock they must run up the columns, along the box V.
So the detail is sampled at `rockDetailUv = vRockUv.yx / 1.8`.
The tangent frame is then built in the shader from **the swapped coordinate's own screen derivatives** (three's `getTangentFrame`, the cotangent frame, copied as `rockTangentFrame` because three compiles it only when a `normalMap` is set).
The frame's T and B are the surface gradients of whatever coordinate the map is sampled at, so the map's +x lands along the direction the swapped s grows (world up) and +y along the direction t grows, exactly the frame three would use for a mesh whose uv attribute were the swapped coordinate; no hand correction of the sampled xy is needed.
In the box UV's own frame that correction would have been the transpose (x, y) -> (y, x), a mirror rather than a quarter turn, and the second sample shares the frame because scaling a uv changes the length of its gradients and not their direction.
It was verified on the GPU against three's stock path: the view normals of a rotated box and a dodecahedron, drawn once through `rockMaterial` and once through a plain `MeshStandardMaterial` with the quarry normal map on a geometry whose uv attribute is the swapped, scaled box UV, agree to at most 1/255 on every pixel, while the same comparison with x flipped, y flipped or the axes unswapped differs by 20 to 26/255 on average.

### Tunables

At the top of `src/render3d/rockMaterial.ts`; colours are sRGB hex, converted to linear when the shader is built.

| Name | Default | Meaning |
|---|---|---|
| `ROCK_ALBEDO_SET` | `seaside rock` | the set whose base is the colour detail |
| `ROCK_DETAIL_SET` | `quarry wall` | the set whose normal and roughness are the grain |
| `ROCK_FALLBACK_SET` | `dark rock` | worn for a role whose set is not in the manifest |
| `ROCK_DESATURATE` | 1.0 | how far the albedo tile is pulled to its own grey (1 = luminance only, no brown) |
| `ROCK_ALBEDO_CONTRAST` | 0.35 | how much of the tile's normalised variation survives (mottling only) |
| `ROCK_BASE` | `#3a342c` | the one hue the default palette is values of, the `dark rock` texture's mean |
| `ROCK_PALETTES`, `ROCK_PALETTE` | `cool-slate` | the presets (see "The palettes") and which one is worn |
| `ROCK_SKY_LO`, `ROCK_SKY_HI` | 0.2, 0.8 | the window of normal y over which `side` becomes `sky` |
| `ROCK_GROUND_LO`, `ROCK_GROUND_HI` | 0.2, 0.8 | the window of -normal y over which `side` becomes `ground` |
| `ROCK_CREVICE_FROM_CAVITY`, `ROCK_CREVICE_FROM_AO` | 1.0, 0.5 | how strongly a closed cavity and a dark AO texel drive the crevice colour |
| `ROCK_CREVICE_LO`, `ROCK_CREVICE_HI` | 0.35, 0.9 | the smoothstep window of that drive; a face only slightly closed keeps its plane's tone |
| `ROCK_EDGE_CAVITY_LO`, `ROCK_EDGE_CAVITY_HI` | 0.85, 1.0 | the cavity mask window that counts as convex |
| `ROCK_EDGE_SHADE_LO`, `ROCK_EDGE_SHADE_HI` | 0.8, 1.0 | the depth shade window that counts as proud |
| `ROCK_EDGE_AMOUNT` | 0.6 | how far an exposed edge is lifted toward `edge / side` |
| `ROCK_JITTER` | 0.12 | per-shard brightness wander, plus or minus |
| `ROCK_AO_DIRECT` | 0.7 | the share of AO that darkens the albedo as well as the ambient |
| `ROCK_AO_INTENSITY` | 1.0 | `aoMapIntensity` |
| `ROCK_NORMAL_SCALE` | 0.3 | relief of the detail normal, subtle |
| `ROCK_DETAIL_SCALE_2`, `ROCK_DETAIL_WEIGHT_2` | 0.37, 0.5 | the second, larger detail sample's frequency multiple and weight |
| `ROCK_ROUGHNESS_BIAS`, `ROCK_CAVITY_ROUGHNESS` | 0.15, 0.15 | roughness lift everywhere and extra in cavities |

The stylised defaults were set against `test.glb` body 150 in headless SwiftShader (`public/rocks/preview-stylised.png`, `preview-stylised-orbit.png`); the photographic first pass is `preview-material.png` and `preview-material-orbit.png`.
None of it has been seen on a real GPU or played.
On a few broad recessed faces the AO atlas still draws soft wavy dark smears through the crevice term rather than crisp cracks; `ROCK_CREVICE_FROM_AO` and the window are the knobs if it reads as dirt.

## Staleness and the hash

`rockHash` is FNV-1a over every piece's depth, z, taper start, taper angle (to a tenth of a degree), mossy flag and vertices, **rounded to the millimetre**: editor float noise hashes the same, a vertex nudged by a millimetre is a different rock.
The body's `rockSeed` is fed first (`s<seed>|`), so a new seed on the same outline marks the body stale until it is regenerated.
It is written out by hand rather than through `crypto` because bun and the browser must agree bit for bit.

A body whose outline changed since generation, or that was never generated, **keeps its extrusion**, and one `console.info` line lists the stale body indices with the command to rerun.
No level ever fails to draw; a stale rock announces itself by looking like the smooth tapered solid rather than stone.

## Reference and actual outlines

A rock body carries two outlines, and they are allowed to differ.
The **geometry object's outline is the reference**: it is what the rock is generated from, together with the object's `depth`, `z`, `taperStart` and `taperAngle`, and it is what `rockHash` covers.
The **collision object's outline is the actual one**: it is what the ball collides with, and it is not in the hash, so tweaking it never marks the rock stale.
The generated rock does not end exactly on its reference (the shards bulge, stagger and fall back), so the actual outline is best taken from the rock once it exists, and then touched up by hand where play wants it.

The editor's **Fit collision to rock** does the taking (see [editor](editor.md)).
It loads the level's GLB, checks the body's node against the hash of the body as the editor holds it now (refusing a stale one), and projects every triangle of the node orthographically along z: three's world frame with z dropped, y flipped into the sim's y-down.
The flat triangles are rasterised into a grid at 1 cm per cell (a cell is solid when its centre is inside a triangle), corner-only contacts are closed so the outline cannot touch itself, the largest 4-connected blob is kept, its outer boundary is walked along the cell edges, and the walk is simplified by Ramer-Douglas-Peucker at 2 cm (`src/lib/silhouette.ts`, cases in `cli silhouette`).
A raster rather than an exact polygon union because a rock is tens of thousands of overlapping sliver triangles, whose exact union is a robustness problem of its own; the grid is exact to a centimetre and has no degenerate cases.
On `test.glb`'s body 150 it took 28,927 triangles to a 24-vertex outline in about 0.1 s, every vertex within 1.5 cm of the 21-vertex reference.
The result replaces the collision object's `shape` with a `poly` in the object's own frame and leaves its placement and every other field as they were.

It switches the geometry object's **`matchCollision` off** in the same edit, because that link keeps the two outlines equal in both directions: left on, the fitted outline would be copied straight back onto the reference, the hash would change, and the rock just fitted to would be stale.
With the link off, the reference stays as authored, the rock stays current, and the actual outline is free to be edited on its own.

## Tunables

At the top of `tools/blender/rocks.py`, metres unless said otherwise.

| Name | Meaning |
|---|---|
| `ROCK_SCALE` | the scale S everything below is sized by, the same for every piece (the author's numbers are for S = 5 m); `--scale S` overrides it per build |
| `TEMPLATES`, `TEMPLATE_CUTS`, `TEMPLATE_WARP`, `TEMPLATE_CELL` | how many shard shapes a body builds, how the cube is cut, and the Voronoi warp's strength and cell size |
| `TEMPLATE_CAP_TILT` | how far from square-on a column's end facet may lean; each end cap is flattened to one plane after the warp, because the warped grid had folded every column end into a crown of notches |
| `RIM_INSET` | how far, at most, a clipped shard's cut face is set in from the outline wall, a different amount per shard, so the coincident cut faces of overlapping shards no longer z-fight along the rim (`inset_wall`); the backing's wall stays on the outline as the outermost face |
| `TEMPLATE_BEVEL`, `TEMPLATE_BEVEL_SEGMENTS`, `TEMPLATE_BEVEL_ANGLE`, `TEMPLATE_SUBDIV` | the bevel and Catmull-Clark rounding of a template |
| `SHARD_BASE`, `SHARD_TAPER` | a shard's size (across, depth, up) at S = 1 and how much narrower its top is than its bottom |
| `SHARD_SCALE_MIN`, `SHARD_SCALE_MAX`, `SHARD_OFFSET`, `SHARD_SPIN` | the per-shard random scale, plan jitter and spin about the vertical |
| `SHARD_DENSITY`, `MAX_SHARDS` | shards per m^2 of plan area at S = 1, and the cap per piece |
| `WANDER`, `WANDER_SCALE` | the large noise that staggers the columns sideways and vertically, and its feature size in S |
| `BODY_TILT` | the body's strata tilt from vertical (degrees) |
| `EDGE_FALL`, `BULGE_RADIUS`, `DEPTH_JITTER` | how far the front falls back toward the outline's edge (times S), how far in from the edge the fall starts, and the per-shard in-and-out |
| `RELIEF`, `PROUD_SHARE` | how far behind the front a recessed shard may sit (times S), and the share of shards that stay proud |
| `TAPER_EPSILON` | a taper angle under this is no taper, and over 90 minus this a flat cap (the taper itself is the geometry object's `taperStart` and `taperAngle`) |
| `SLIVER` | a clipped shard whose remnant is thinner than this share of S, across or up, is dropped |
| `MIN_BACKING` | the backing prism is at least this thick |
| `DEPTH_SHADE` | how much brightness a face loses at the deepest recess |
| `VOXEL_SIZE`, `VOXEL_MIN` | remesh voxel size per S, and its floor |
| `DETAIL` | the three surface offsets after the remesh (mid Voronoi, small Voronoi, fine noise), each a feature size and a strength at S = 5 |
| `SHARP_ANGLE_DEG` | edges over this dihedral angle stay sharp under the smooth shading |
| `ISLAND_MIN` | a connected island smaller than this share of the piece's largest is a stray sliver, dropped |
| `BACK_NORMAL`, `BACK_SETBACK` | a face is back, and dropped, when its normal points this far away from the camera and it sits this far behind the plane |
| `TEXTURE_TILE` | metres per unit of `TEXCOORD_0`, the box projection the detail tiles are read through |
| `AO_TEXELS`, `AO_SIZE_MIN`, `AO_SIZE_MAX` | the ambient-occlusion atlas's texels per metre of surface, and its smallest and largest side |
| `AO_SAMPLES`, `AO_DISTANCE`, `AO_MARGIN_PX`, `AO_ISLAND_MARGIN`, `AO_ISLAND_ANGLE` | the bake's samples per texel, how far a face looks for occluders, the bleed past each island, the unwrap's island spacing, and the angle under which neighbouring faces share an island |
| `BURIED_EPSILON`, `BURIED_MARGIN_RATIO` | how far outside its own solid a triangle's centre is probed when deciding it is buried inside another shard, and how deep inside (as a share of S) it has to be, more than the detail noise can move it |
| `DISSOLVE_ANGLE_DEG` | the planar dissolve's angle, the default decimation: coplanar faces within it become one, moving no vertex |

## Commands and how to look at it

```sh
bun run assets:rocks ball                       # levels/ball.json -> public/rocks/ball.glb
bun run assets:rocks ball --only 3,17           # just those body indices, for a quick look while tuning
bun run assets:rocks ball --out /tmp/try.glb    # somewhere else
bun run assets:rocks ball --flat --decimate 1 --scale 3   # no AO bake, uncollapsed, finer stone (S = 3 m)
```

Then play `?level=BALL` (the rocks load by the level's file name), or headless: `bun run src/tools/cli.ts shot <bundle> --3d --query rocks=ball`.
Add `?rocks=0` or `?paint=0` for the A/B.
`--only` with no match prints the level's rock body indices.

## What is not done

- **Moss**, the whole point of the "mossy" textures: a thick carpet on attachable surfaces. `mossy` is carried in the job and the hash but ignored.
- Only `static`, non-`passable` bodies. Rigid bodies (which would need the mesh in the body's own frame) and passable ones keep the extrusion.
- The editor does not load generated rocks.
- Nothing is in the [asset store](asset-store.md) or its budget; `cli assets` does not know about `public/rocks/`.
- The [loading screen](loading-screen.md) does not preload the GLB.
- No per-body caching across levels: every run rebuilds every body.
- One generated texture for every rock; no per-level or per-body variation of it, and no moss or wet variants.
- No cases yet. Per "validate the behaviour before writing the cases", the look has to be played first.
