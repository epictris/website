# Foliage in Blender

Since 2026-10-08 ferns, leaf-sprig bushes and hanging vines are **placed in a scene in Blender, one plant at a time, and grown procedurally** by the foliage add-on, `tools/blender/foliage/`.
Each plant is an object of its own: placed and aimed by hand, with its own settings and seed, saved in the `.blend`, grown again by `just scene <level>` and drawn by the game from the exported scene like any other scenery.
See [blender-scenes](blender-scenes.md) for the pipeline it rides on.

## Where it comes from

The generators are ports of karin-lu's three.js foliage generators, from the `blender-background-editor` branch of `github.com/karin-lu/website` (2026-10-08): `render3d/foliage/vine/hangingVine.ts` (the hanging vine) and `render3d/foliage/vine/fern.ts` (the fern in three varieties), with the painted sheets and piece tables they cut from.
On that branch they ran in the level editor's Visuals workspace and saved each plant as a GLB beside the level; here they run in Blender, so a plant is part of the level's look and the editor owns none of it (CLAUDE.md: Blender owns every rendered mesh).
The owner's ask: "a new blender tool for procedurally generating the foliage. I should be able to precisely place individual ferns/vines etc... and control/regenerate their parameters similarly to the current ivy/moss tools."

The port is step for step, with karin's own seeded hash (`surface.rand`, bit for bit), in Blender's z-up world: every constant direction is mapped by three's `(x, y, z)` to Blender's `(x, -z, y)`, a rotation, so cross products and turns carry over unchanged.
It was checked against karin's TypeScript run under bun on the same rock and recipes (six cases: the three fern varieties, a leaflet fern with tiny leaves, a natural vine and a flat one): every frond, leaf, release point and path point count is the same, every vertex of every leaf card, frond, stalk and stem lies within 0.4 µm (ferns) or 5 µm (vines, whose host Blender's BVH holds in single precision) of karin's, and every vertex colour within 1e-7.
Karin's tubes carried a duplicate seam column for a texture they never used; the port drops it, so a stem has `sides` vertices a ring instead of `sides + 1`.

## Install

```sh
just foliage-install      # once per machine; links the add-on into Blender and enables it
```

`tools/blender/addon_install.py` links `tools/blender/foliage` into Blender's `user_default` extension repository and enables it; the scene exporter imports the package from the repo and needs no install.
It reaches the shared brush module (`stampbrush`, for the ray cast and `grown_by`) through a symlink inside the package, as the ivy and the moss do.

## Placing a plant

The **Foliage** tab in the 3D viewport's sidebar (N) has **Add Fern** and **Add Hanging Vine**.
Press on a mesh where the plant's root goes (a fern's crown, a vine's start), drag to aim it, and release: the arrow drawn while dragging lies in the surface's tangent plane and is the way a fern leans open, or the way a vine sets off.
A click without a drag takes a sensible aim: a fern opens toward the side most rays from its spot escape to (karin's open-side test), a vine sets off downhill, or toward the game's camera (Blender -y) on a flat top.
Ctrl+click on a plant's root removes the plant, and Escape, right-click or Enter end the tool; navigation passes through.
A new plant takes the settings of the plant of its kind that was active when the tool started, and a fresh random seed.

**A plant is an ordinary object, and its transform is its anchor**: its origin is the root, its local +Z the surface normal there, its local +Y its aim, and its scale its size (karin's edit scaled a plant's lengths the same way).
So after it is planted it is moved with G, re-aimed with R (about its own Z; R Z Z), tilted with R, sized with S, and duplicated with Shift+D like anything else, and with **Live** on it grows again a moment later.
The root need not stay exactly on the rock: a vine finds the nearest point within 10 cm (or four stem radii), a fern within 15 cm, and further than that it does not grow and says so in the panel.
**Snap to Surface** puts the selected plants' roots back on the nearest point of their host, standing on its normal, keeping their aim.
The selected plants' roots, normals and aims are drawn over the viewport, so a turn shows where a plant points before it has grown.

The plant is a mesh named `<host>.fern` or `<host>.hanging-vine` in a `Foliage` collection, parented to its host (found again by the host's **name**, `foliage.host`, as the ivy finds its rock, so a re-imported host takes its plants back, each keeping its place in the world).
It carries `grown_by = "foliage"`, so the ivy and moss brushes and the plant tool itself look through it to the rock.
Its mesh is output only: the settings and the transform are the source.

**Scatter Ferns** plants ferns over the selected rock (or the active fern's rock) in its best spots, as karin's scatter did: 220 spots sampled by area, each facing up at least a little, scored for being enclosed (a crack, an inside corner: rays from it that hit the rock within 60 cm) and for facing up, kept `Spacing` apart from each other and from the ferns already there, and kept only where a quick trial fits at least half the fronds.
Each is a fern of its own, aimed at its spot's open side, with the active fern's settings when one is active, to move or edit afterwards.

## Settings

The panel shows the active plant: its kind and host, its triangles, fronds and leaves and build time, **Live**, **Rebuild**, its **Seed** with **New Seed** (for every selected plant), **Snap to Surface**, **Reset** (the defaults; a fern's are its variety's; the seed is kept), **Copy to Selected** (to the selected plants of the same kind; seeds are kept; a value the source follows the default for, the copy follows too, as the ivy's copy does) and **Bake to Plain Mesh** (a hand-editable copy, never regrown; the plant is hidden in render so only the copy exports).
**Rebuild All** grows every plant in the scene again.

A **fern** has a **Variety**, and switching it gives the fern that variety's starting shape (karin's `varietyDefaults`):

- **Painted Fronds**: each frond one painted card from the fern sheet (pick which of the ten in the panel), folded down its midrib.
- **Leaflets**: each frond a compound leaf: a tapered stem with `Leaf Pairs` pairs of leaflet stems, each with `Tiny Leaves` pairs of small painted leaves and one at its tip; with `Tiny Leaves` 0 (the default) the leaves sit straight on the frond as single, slightly sickle-shaped leaves. `Leaf Form` Creased folds them deeply so they overlap like shingles.
- **Leaf Sprigs**: painted sprigs set along each stem at an angle, like louvres: a leafy bush.

Then `Fronds` (how many it tries to fit; a tight spot fits fewer), `Length`, `Droop`, `Spread` (degrees from the clump's axis), `Lean` (toward the aim), `Midrib Fold`, `Twist`, `Fiddleheads` (coiled young fronds standing in the middle, two crossed cards each), `Length Variation`, and for the leafy varieties `Leaf Size`, `Leaf Curve`, `Leaf Variation` and `Mirror Pairs`.

A **hanging vine** has `Length`, `Leaf Size`, `Leaf Gap`, `Stem Radius`, `Cling` (how long it holds to the rock over a steep side or an overhang before it lets go and hangs), `Bend` (how softly a hanging stem turns down), `Leaf Spread`, `Variation` and `Natural Leaves` (gravity droop, curved blades, colour and size by age; off is karin's earlier flat look), and the leaves it picks from: 14 painted watercolour leaves, which keep their own colours, and 24 brush silhouettes, which are white and take a green; **Painted**, **Silhouettes** and **All** choose a whole set, and each leaf is a toggle with its thumbnail.
The defaults are the vines karin placed in the river (`ball.json` on her branch: about a metre long, 10 cm leaves 14 cm apart); her generator's own defaults (3.4 m, 24 cm leaves) were not what she used.

Both kinds have **Colour**: `Paint Tint` (how far a painted piece's own colours move toward the chosen greens, keeping its painted light and dark) and the six **Greens** a plant is tinted from.
Ages walk along the greens from dark to light: a vine's leaves darken toward its root and freshen toward its tip, a fern's outer, older fronds are darker.

## What is grown

**The hanging vine** grows in 1.2-3.5 cm steps from its root, exactly its `Length` long whatever the rock's tessellation.
While it clings, each step is pulled downhill by the slope and wanders sideways a little, and follows the nearest connected surface at `Stem Radius` + 2 mm off it; a side steeper than `Cling` allows, an undercut, or a step that finds no surface lets go, and from there the stem hangs, turning down as softly as `Bend` says and swaying a little with `Variation`.
Every step is pushed out of the rock and its whole segment tested, so it rounds a lip instead of cutting through it; a hollow it cannot pass is a smaller step, never a jump, and a crevice it is trapped in is an error that says to move the root.
Leaves come every `Leaf Gap`, alternating sides, now and then missing or paired: on the rock a blade lies close to it, leaning downhill; hanging, it droops tip down on a stalk that arches up first, its face turned out.
Each blade is a 4 x 5 grid, cupped across its midrib, arched along it, its tip curling back, darker at its base with a lighter midrib.
A blade that would touch the rock leans out and shrinks; one that would pass through another leaf, the stem, or another plant swings round the stem and shrinks; after eight tries it is left out.

**The fern** is a rosette round an axis tilted toward the aim by `Lean`, its fronds spaced by the golden angle.
Outer fronds are placed first: they lie lowest and are the hardest to fit, and younger ones find a layer above them.
Each frond arches up out of the crown and droops toward its tip; one that would enter the rock (or another plant) stands up more, turns toward the open side, droops less, untwists or shortens, and one that would pass through a frond already placed is nudged in angle and turn, in order, until it settles into a layer (60 nudges, then shorter).
Fronds may touch in their lower third, near the crown, as real ones do.
Normals lean toward a dome round the crown and a little toward the sky, so the clump shades as one soft mass, and a dark knot sits on the crown where the fronds meet the rock.
The leaflet and sprig varieties place their leaves one pair at a time, each pair clear of the rock and of every leaf already placed, measured against the leaves' own painted outlines; a pair that does not fit tilts or turns a little about its base on the stem, or shrinks to 85 %, both sides alike, or is left out.

**Order.** Plants grow in a fixed order (`foliage.order`, given at creation, then the name), and each keeps clear of the plants grown before it: their meshes sampled at up to 600 points as spheres of 1.8 cm, as karin's editor kept a new plant clear of those already on its rock.
So a newer plant gives way to an older one, and a plant that changes (or is deleted) grows again every later plant whose reach (a sphere round its root of its length and leaves) its old or new extent meets.
The export grows them all in that order, so it makes exactly what the panel shows.

## Atlas and material

The four painted sheets are scene sources, `assets-src/scenes/textures/foliage/` (`leaf-atlas.webp`, `fern-atlas.webp`, `leaflet-atlas.webp`, `sprig.webp`, karin's, unchanged), and their piece tables are `tools/blender/foliage/pieces/*.json` (karin's too: each piece's rect in its sheet, where its stalk meets it, its width over its length, its average colour, and for fronds and leaflets their measured outlines).
`library.draw_atlas` packs the four, each at half size, into one atlas, `foliage-atlas-v<ATLAS_VERSION>.png` (2048 x 1728) in `assets-src/scenes/textures/`, with a solid white cell, and bleeds the colour out under the alpha so filtering never draws a dark fringe; `mesh_io.atlas` draws it the first time it is needed and packs it into the `.blend`.
A plant is **one mesh with one material**, `Foliage`: the atlas times the vertex colour, alpha cut at 0.35 (the ivy's cutoff, low enough that mip levels do not eat the edges at a distance), both sides drawn; the leaves sample their pieces, the stems and the crown the white cell, so their vertex colour is their colour.
One slot, because Blender 5.2's glTF exporter writes a second slot's `COLOR_0` white when it reads the same colour attribute as the first ([blender-ivy](blender-ivy.md#material-and-texture)); karin's plants were three to five meshes, one per texture.
The optimiser takes the atlas at up to 2048 (`scripts/encode-textures.mjs`, "foliage atlas, 2k"), not the 1k of every other map: a frond 0.45 m long is 90 pixels on a 1080-line screen, and at 1k it would draw from about 80 texels of its painted card, at 2k from 160.
Bump `library.ATLAS_VERSION` to redraw the atlas (a file that packed the old one drops it) and `mesh_io.MATERIAL_VERSION` to rebuild the material in every file.

**In the game** a mesh wearing `Foliage` is dressed as the ivy's leaves are (`render3d/sceneDressing.ts`, `wearIvyLeaves` in `render3d/ivyLeaves.ts`): it casts and receives, two-sided with the front's normal on both sides (karin's ferns did the same), lit through (karin's ferns had their own translucency term; the ivy's is used instead, so foliage and ivy light alike), and with the leaves' finer shadow biases so a frond shades the frond below it.
The game logs `[render3d] scene "<scene>": N plant meshes cast and receive leaf shadows` when it finds them.

## Export

`scene_export.py` grows every plant again after the ivy and the moss, in order, so what ships is grown from the settings against the rock as it now stands.
A plant that cannot grow (its host gone, its root off the surface, a vine trapped) is a warning and stays out of the export; each one grown is a `[scene_export] foliage` line with its triangles, fronds, leaves and build time.
**Plants stay out of the bake**: they are hidden in render while the procedural textures bake, so no leaf card is baked into a rock's occlusion, and no plant is in a rock's bake-cache key; placing or editing a plant re-bakes nothing. The game's own shadows shade the rock under a plant.
The plant stays a child of its host through the optimiser (`--keep-hierarchy`), so a plant on a rock that dresses a body rides the body.

## Not ported

- **Wind.** Karin's plants carried a `sway` weight per vertex (metres of free hang below a vine's release point; distance along a frond) and a vertex-shader patch swayed them. The weights are not computed here, and the game has no foliage wind.
- **Imported leaves.** Karin's editor could cut new leaves from an uploaded image into the vine's atlas.
- **The legacy SVG-leaf vine** (`render3d/hangingVine.ts`), which karin kept only so old recipes stayed editable.
- **Curved ivy cards** (`render3d/ivyGeometry.ts`, "Curve bush leaves"): karin bent the ivy add-on's flat leaf cards at load time in the game. That is a change to the ivy's look, not foliage, and the ivy's cards are flat by the owner's choice ([blender-ivy](blender-ivy.md)).
- **Karin's three placed plants** in her `ball.json`: their hosts are three.js mesh paths from her branch; place them again in `river.blend` if they are wanted.

## Credits

The four sheets are karin-lu's, from her branch ("the painted generators and atlases from the hanging-vines artifact pack"), and their licence is not stated there.
They are not in `tools/blender/image_credits.json` until it is, so every export that ships a plant warns that `foliage-atlas-v1.png` has no credit; add a set for them (author, source, licence) when it is confirmed, and publish the sheets as sources (`bun run assets:publish-sources scenes/textures/foliage/leaf-atlas.webp` and the other three) so `just sources` brings them to another machine.

## Verified, and not

2026-10-08, all on a scratch copy of `river.blend` (never saved over the real one):

- The port against karin's TypeScript, as above.
- Two ferns, a sprig bush and two vines planted by script on `Terrace` and `Terrace.002`: 1.0 s for all five (painted fern 0.3 s, leaflet 0.5 s, sprig 0.05 s, vines 0.02 s).
- `scene_export.py` over that copy, with a copy of the bake cache: the export grew the same five meshes (same triangles), the rocks' bake was unaffected by the plants, and the only foliage warning was the atlas's missing credit. The optimiser kept the material (`Foliage`, MASK 0.35, double-sided), `COLOR_0`, the plant node names and their parenting, and took the atlas through the 2k rule (183 KB WebP at 2048 x 1728).
- The game drawing that export (`cli shot --view` at the Terraces, the published `scene.glb` restored byte-exact after): ferns on the ledge, vines down its face, and `5 plant meshes cast and receive leaf shadows` in the log.
- The real Blender UI on a private headless sway: Add Fern pressed, dragged and released, Add Vine clicked, Ctrl+click removing a fern, the panel and pickers, and Live regrowing on a setting, a variety change and a turn.
- Growing every plant twice gives the same bytes. It did not at first: a plant just created grew from the matrix as set, and the export from the depsgraph's (parent x basis), which differs in the last bit, and a fern's fit is branchy enough to notice; `create_plant` now evaluates first. And the plants' extents are read from their meshes, not `bound_box`, which lagged a plant grown a moment earlier, so the next one did not keep clear of it.

Not yet: the owner's look at any of it, G and S driven by hand in a real session (moves were set by script and regrew), a play, a fern's or vine's numbers tuned for this game (they are karin's), and the sheets' credit and publication.
A host's shape is not watched: after editing the rock, Rebuild (the export always does).
