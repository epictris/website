# Foliage in Blender

**The by-hand workflow is retired** (2026-11-26, with the Blender scenes, [blender-scenes](blender-scenes.md)): plants are no longer placed in a level's `.blend` in Blender and shipped by `just scene <level>`, which is gone.
A fern, a hanging vine, mushrooms, orbs or glow flora is now a placed `Decoration3D` child of its rock, placed in the level editor's Decorations workspace and grown headless by `scripts/decoration-build.ts` ([formations](formations.md#decorations)).
That job still runs this add-on's code, so the add-on lives on as a library.
`tools/blender/decoration_prepare.py` lands the plant on the rock and makes it with `foliage.ops.create_plant` (kinds `FERN`, `VINE`, `MUSHROOM`, `ORBS`, `GLOW`), and `tools/blender/scene_export.py` grows and exports it with the add-on's generators, atlas and material.
The editor's Decoration panel shows the add-on's own settings, read off its registered properties by `just decoration-schema`.
So the generators, their port, the settings, the atlas and material and the numbers that chose them are current.
The panel's placing tools, `just foliage-install` and the export of a level's scene describe the retired workflow, and are kept for the reasoning behind them.

## Automatic High-DOF LOD for ferns and vines

Fern and hanging-vine rebuilds/export use the same gameplay-plane blur budget
as ivy. The nearest point in the plant's possible reach sphere determines the
budget, including object scale; foreground and the first 1.5 m behind the plane
stay at authored detail. The guide camera supplies the lens, falling back to
the game's default 34-degree vertical field of view.

Growth paths, collision checks, leaf positions and variety stay authored.
The output drops card rows/columns whose positional error is below the blur
budget, simplifies stem paths within that tolerance, and reduces tube sides
and crown tessellation. Unused vertices are removed. Atlas variants average
premultiplied linear colour at 1/2, 1/4 or 1/8 size, selected from the actual
world-space size of the UV-mapped cards. Near plants retain the original atlas.
The game recognizes every LOD material as foliage for lighting and collisions.
Mushrooms and pendant orbs now use the same distance budget. Their cap, bulb,
neck and stem subdivisions are chosen before generating geometry; tiny raised
gills/flecks and rib relief disappear when unresolved. The luminous rim stays,
and omitted gills contribute their mean emission to the underside. Orb paint
and emission textures average in linear colour down to 32×16; the mushroom's
64×4 emission ramp encodes weights rather than spatial detail and stays intact.

Glow flora selects the coarser of authored detail and an automatic preset per
item, using each solved/edited item's bounds plus sway, transformed into world
space. Large, rotated or nonuniformly scaled patches can contain both sharp
and distant items. Patch generation, edits, collision solving and item counts
remain unchanged. Unresolved gill/rib lines encode their angular mean as a
negative line count in `_EXTRA`; the game shader uses that value directly,
preserving pulse, sway and rim lighting. All custom attributes still export.

`tools/blender/glowing_foliage_lod_check.py` checks both mushroom forms, orbs,
all five glow patch types, near/far transitions, texture emission averages and
a GLB export with the glow attributes.

Check: `blender -b --factory-startup --python-exit-code 1 --python
tools/blender/foliage_lod_check.py` covers all three fern varieties, hanging vines,
material separation and rebuild after moving a plant into the background.


Since 2026-10-08 ferns, leaf-sprig bushes and hanging vines are **placed in a scene in Blender, one plant at a time, and grown procedurally** by the foliage add-on, `tools/blender/foliage/`.
Until 2026-11-26 each plant was an object of its own: placed and aimed by hand, with its own settings and seed, saved in the `.blend`, grown again by `just scene <level>` (retired) and drawn by the game from the exported scene like any other scenery.
See [blender-scenes](blender-scenes.md) for the pipeline it rode on.
Now each plant is a decoration with its own settings and seed in the level, placed, turned and sized in the editor, and grown alone by a decoration build through the same exporter.

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

Retired with the by-hand workflow (2026-11-26): the install only puts the panel and the placing tools in an interactive Blender, which nothing needs now.
`tools/blender/addon_install.py` links `tools/blender/foliage` into Blender's `user_default` extension repository and enables it; the decoration build, like the scene exporter before it, imports the package from the repo and needs no install.
It reaches the shared brush module (`stampbrush`, for the ray cast and `grown_by`) through a symlink inside the package, as the ivy and the moss do.

## Placing a plant

Retired 2026-11-26: a plant is placed with the Decorations workspace's palette and moved, turned and sized with its gizmo ([formations](formations.md#decorations)); `decoration_prepare.py` aims every plant toward the game's camera (Blender -y) from its root, rather than the open-side and downhill aims a click without a drag takes below.
The Blender tools are kept as they stood.

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

### Bioluminescent cave plants (2026-11-14)

The Foliage panel also has **Add Mushrooms** and **Add Pendant Orbs**. These use the same click/drag placement, object transforms,
host parenting, Live, Seed, Rebuild, Copy, Reset and Bake controls as ferns.
They are solid procedural geometry, with no external painted sheets:

- **Mushrooms / Stemmed Caps:** curved tapered stems, smooth domed caps,
  luminous thin rims and radial gills on the underside.
- **Mushrooms / Wall Shelves:** fleshy fans projecting from a wall, with rounded
  continuous domed tops, shallow undersides and a closed luminous lip and rear
  perimeter. The dome stays raised at the attachment instead of dipping into a
  notch. Dome height varies by
  seed and follows **Cap Dome**. Place on a vertical face; the caps remain horizontal.
- **Pendant Orbs:** round lantern-like bulbs with six broad softly shaded lobes, each attached directly to an underside
  by its own short bare stalk. There are no leaves, shared strands or long vine
  silhouettes: gameplay vines remain visually distinct. Up-facing attachments
  report a placement error rather than growing bulbs through their host.

**Count**, **Cluster Radius**, **Size** and **Size Variation** control each patch.
Size Variation varies width and height independently. **Shape Variation** varies
cap dome profiles, tilt and stem bends, bulb proportions and short stalk lengths.
**Surface Detail** controls interior cap folds, mottling and raised flecks, and soft
orb lobe depth. Mushroom rims stay smooth. Mushrooms have concentric colour bands
and radial gills; orbs have short thick curved necks and luminous centres, with no
mottled patches or hard rib stripes. **Height** applies to stemmed mushrooms;
**Cap Dome** and **Stalk Length** appear for the corresponding kind. A crowded patch may grow
fewer parts; each candidate is checked against its host and earlier plants.
Growth is deterministic for a seed. Surface attachments use face normals, rather
than a nearest-point separating vector that can become tangential through rounding.

**Body Colour**, **Glow Colour** and **Emission** independently control the matte
surface and its luminous parts. Use green/lime near the entrance and teal/cyan
near the pool. Each plant has one `Cave Foliage · <object>` material, vertex body
colours, and a generated, packed emission map sampled by UV. Mushrooms
use a tiny ramp; orbs use a 256×128 soft lobe shading map for colour and emission, with a
dark atlas margin for stalks/collars and a repeating spherical seam. This exports
as `COLOR_0`, `emissiveTexture` and `KHR_materials_emissive_strength`, without
the painted-leaf atlas or the game's leaf-card shader. Rebuild reuses the plant's
material and image datablocks. Existing ferns and vines keep their `Foliage` material.

An orb's neck and body are one continuous surface: the neck's curved cubic profile
meets the bulb shoulder with a matching tangent. Its colour/emission map brightens
and slightly whitens the centre while leaving the rim and neck more saturated,
suggesting a thin membrane around an inner glow. This is simulated translucency,
not see-through glass or alpha blending; it does not transmit the cave behind it.
The centre highlight is painted for the front/back game view, rather than a
view-dependent Fresnel shader, so it remains a standard exportable glTF material.

Moss remains in the existing **Moss** tool: see
[Bioluminescence](blender-moss.md#bioluminescence).

**Lighting:** emission makes the plant bright; it does not illuminate the game.
Add a nearby point light per cluster in the level editor's Visuals workspace,
or a wide spotlight for shelves on a wall. Match its colour and tune range and
intensity independently of emission. Blender lights are not exported by the
scene pipeline. See [lighting-and-surfaces](lighting-and-surfaces.md).

The review scene is reproducible with:

```sh
blender -b --factory-startup --python-exit-code 1 --python tools/blender/foliage/preview_biolume.py
```

It writes `assets-src/studies/biolume/preview.blend`, `preview.png` and
`preview.glb`, with green and blue specimens and demonstration lights. It checks
seed repeatability, finite geometry, one material per cluster, emission-only
moss edits preserving geometry, and glTF emission maps/strength/vertex colours.
Add `-- --no-render` to run the checks without rendering. This never edits a level.
Add `-- --closeups` to also render `orbs-close.png` from below the attachment
and `shelves-close.png` showing the rounded shelf profiles.
The review's green moss uses brighter Dark/Light colours and a lower glow
threshold (0.38); the blue moss keeps its earlier palette and threshold (0.55).
Those are sample settings in the review scene, not changes to existing moss
instances or to the original non-emissive moss defaults.

Validation: the current eight-specimen review checks geometry and glTF emission export.
The emissive curled-frond experiment was removed; existing fern varieties are unchanged.

### Existing fern and vine controls

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

## Glow flora (2026-11-14)

**Add Glow Flora** plants a patch of glowing mushrooms, lantern blooms, glow ferns and reed tufts: the Glowshroom Generator's (`claude.ai/artifact/QgRHgFc9G8JFkepeQ85wND`, Tris's three.js generator page), grown in Blender like any other plant and drawn by the game with that generator's own shader.

### Where it comes from

`tools/blender/foliage/glowflora.py` is a port of the generator's module, `glowshrooms.js`, kept beside it as `tools/blender/foliage/reference/glowshrooms.js`.
It is step for step and in the module's own y-up patch frame (its camera on +z), with its seeded generator (mulberry32), three's colour maths (sRGB to linear and HSL jitter, to the same rounding), and its collision solver, so a seed grows here the patch it grows on the page.
It needs no Blender: `bun tools/blender/foliage/reference/parity.ts` grows ten patches (every kind and palette) both ways on flat ground and compares every item field (to 1e-9) and every vertex position, colour, glow, gill and sway value (to float32 rounding, 3e-8 on 2026-11-14), and fails on any difference.
Python takes about nine times the module's time: 0.4 to 0.9 s for a 14-mushroom patch or a grove on flat ground, about 2 s for a grove on a bumpy rock (the module's 30 to 85 ms).

Two things are generalised, and both reduce to the original on flat ground, which is how the parity holds:

- **The ground is the host.** The original stands everything on the plane y = 0; here the ground under any point of the patch is the host's surface (`glowgrow.HostGround`: a ray down the patch's up axis from 0.6 m above the root, reaching 1.5 m below it, memoised on a 1 cm grid and read bilinearly), and every place the original reads 0 for the ground reads the height under that point: a stem's foot, a cap's clearance, a frond's floor, a lantern leaf's rest, the mound.
- **The host has an edge.** Where no ground faces up within reach (over a drop, into a wall) there is none.
  Nor is there past a ledge: a ray beyond it finds the terrace below, which is another ground, so a grid node is ground only if it is reached from the root's node by steps toward it none of which drops or climbs more steeply than 70° (`MAX_RISE`).
  Until 2026-11-14 (second fix) a patch on a ledge spilled ferns and reeds a metre down the cliff below it (`Terrace.015.glow-flora.001` in `river.blend`).
  A plant standing off the ground walks back toward the root (an `edge` issue), and a solver move that would take a plant off the ground takes the separation alone or is refused.
  The original's escape walks a crowded plant outward ("there is always room outside", true on an endless plane), which on a finite rock fought the edge for all 600 passes (18 s, intersections left).
  A plant whose moves are refused 8 times (`STUCK`) is dropped, as a tight spot fits fewer fronds, and so is one still off the ground after the walk back should have reached the root (its distance over `EDGE_STEP`, plus `STUCK`): the mound or a neighbour keeps pushing it out again, so there is no room for it.
  The panel says how many did not fit.
  On flat ground nothing is refused, so nothing changes.
- **A part over a drop keeps its plant's footing.** A frond, a lantern leaf or the mound's rim reaching out past an edge reads the height under its own plant's base where there is no ground under it, as on the original's plane; a plant whose base is off the ground stands at the root's height while the solver walks it back (`foot`, `Ground.under`).
  Until 2026-11-14 a missing ground read as 1000 m down, and those parts were drawn there: stems a kilometre long under the scene.

### Placing and settings

A glow patch is planted **unturned**: its up is the world's, whatever the slope at its root, so mushrooms stand and bulbs hang, and its camera side is the game camera's (Blender -y), which the original's layout assumes (caps lean away from the camera rather than flattening toward it, lanterns face sideways).
Its transform is still its anchor: G moves it, S sizes it, and R turns or tilts the whole patch (Snap to Surface keeps the turn).
The mesh is grown in the plant's own frame, so a turned patch is the same patch turned.

The **Glow Flora** panel has the original's controls:

- **Patch**: Grove, Mushrooms, Lanterns, Ferns or Reeds, each with its own options, kept per kind as the page keeps them (`glow_<kind>_<option>`, ranged as the page's sliders): counts, spread, depth, size and variety, lean, bend, cap variety, dome, flare, fan out, cap tilt, spots, glow, mound; arch, bulb size and length, ribs, leaves; fronds, upright, droop, fiddleheads, leaflets; blades, blade width, seed pods.
- **Palette** (Pastel, Moonlight, Toxic, Ember), the plant's **Seed**, and **Detail** (High, Mid about half the triangles, Low about an eighth, for distant patches; a grove is about 50 k triangles at High).
- **Keep Apart**: the collision pass (nothing touches another plant, the mound, the ground or itself, with room for the sway).
  Off, plants may intersect.
- **Paste Patch JSON** takes a patch copied from the page (its Patch JSON): the kind, options, seed and palette, and every plant as edited there, kept in `glow_edits` and locked in the solver as the page locks an edited plant.
  **Copy Patch JSON** puts the patch as grown here on the clipboard, to load on the page (its plants' x and z are the patch's; heights are relative to the ground under them).
  **Clear Edits** forgets the pasted plants.
  Per-plant editing itself is the page's; edit there and paste.

The panel shows triangles, plants and build time, a count still intersecting (the solver gave up; a warning at export too), and how many did not fit on the host.
The page's patch light and ground glow decal are not grown: light the patch with a light in the level editor's Visuals workspace, as any glow.

### The mesh and the material

One mesh per patch, one material shared by every glow plant, `Glow Flora`: the body colour (`Col`, exported as `COLOR_0`) on Base Color and the `_GLOW` attribute as the emission, which is Blender's view of the look only.
Beside the colour the mesh carries the shader's inputs as generic point attributes, named with a leading underscore because those are the ones Blender's glTF exporter writes as custom attributes (`scene_export.py` sets `export_attributes`; Blender's own attributes never start with one):

- `_GLOW`, vec3: emission, linear RGB.
- `_GILL`, vec3: the radial direction round a cap or bulb (x, y) and the gill weight (z); z = -1 marks a stem's inner glow.
- `_SWAY`, vec3: wind phase, amplitude (world metres: the patch's times the plant's scale) and height factor.
- `_EXTRA`, vec2: gill line count, pulse phase.

The original packed gill and sway into two vec4s; Blender's only four-float point attributes are a colour (which the exporter writes as another `COLOR_n`, and the optimiser prunes every `COLOR_n` but `COLOR_0`) or a quaternion, hence vec3 + vec3 + vec2.
The optimiser keeps the `_` attributes as they are (its prune removes only unused `TEXCOORD`, `COLOR_n`, `NORMAL` and `TANGENT`, and its quantisation takes only the standard semantics), unquantised float32, about 44 bytes a vertex.
Checked on 2026-11-14: a grove grown in Blender on flat ground, exported and optimised as the scene export does, and drawn by `render3d/glowFlora.ts` beside the page's own `buildPatch` of the same seed, same camera, lights and time: a mean difference of 0.15 (game framing) and 0.45 (close-up) levels of 255, the larger ones only on silhouettes and the hair-thin gill lines, from the optimiser's 16-bit positions and 8-bit normals.

### In the game

`render3d/glowFlora.ts` dresses a mesh found by its `_glow` attribute (not by its material's name: the optimiser may merge identical materials or swap untextured ones for a palette material) with the original's material: three's physical surface with its iridescent sheen and clear coat, emission per vertex with a slow pulse, glowing gill lines under a cap and rib lines on a bulb, a stem lit from inside, a fresnel rim, and the wind sway, coherent between neighbours and growing with height.
The clock is the scene's (`waterTime`, pinnable for shots); `setGlowFloraLook({ glow, pulse, sway, rim })` sets the look for every glow plant at once.
The game's default surface glow is 0.22 of the generator's emission, keeping the pastel body colours and shading visible on mushrooms, lantern blooms, ferns and reeds. This also softens their bloom, but leaves the grove's baked lighting and authored light sources unchanged. Set `glow: 1` when comparing against the original generator's full-emission look.
The sway is applied in the world and taken back into the mesh's frame, so a turned plant still sways across the screen; the plants cast through depth materials with the same sway, put back on every mount (three's clone drops `customDepthMaterial`; `exportFiles.mountExport`).
A glow plant keeps out of the depth prepass (its material is patched), and the bloom pass re-runs the patch on its emission-only copy, so the glow blooms; `emissive` is the emission's overall multiplier (white), which is also the bloom pass's sign that it emits.
The game logs `[render3d] scene "<scene>": N glow flora meshes glow and sway`.

### Beside the cave plants

The **Mushrooms** and **Pendant Orbs** kinds above (`biolume.py`) are an earlier, separate attempt at cave plants, with a ramp texture for emission and no game shader.
Glow flora does not use or change them.

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

**In the game** a mesh wearing `Foliage` is dressed as the ivy's leaves are (`render3d/exportFiles.ts`, `wearIvyLeaves` in `render3d/ivyLeaves.ts`): it casts and receives, two-sided with the front's normal on both sides (karin's ferns did the same), lit through (karin's ferns had their own translucency term; the ivy's is used instead, so foliage and ivy light alike), and with the leaves' finer shadow biases so a frond shades the frond below it.
The game logs `[render3d] scene "<scene>": N plant meshes cast and receive leaf shadows` when it finds them.

## Export

`scene_export.py` grows every plant again after the ivy and the moss, in order, so what ships is grown from the settings against the rock as it now stands.
Since 2026-11-26 the file it reads is the one a decoration build prepares (one plant on its formation's rock), not a level's scene, and the growth is the same; the rest of this section describes the export of a scene as it stood.
A plant that cannot grow (its host gone, its root off the surface, a vine trapped) is a warning and stays out of the export; each one grown is a `[scene_export] foliage` line with its triangles, fronds, leaves and build time.
**Plants stay out of the bake**: they are hidden in render while the procedural textures bake, so no leaf card is baked into a rock's occlusion, and no plant is in a rock's bake-cache key; placing or editing a plant re-bakes nothing. The game's own shadows shade the rock under a plant.
The plant stays a child of its host through the optimiser (`--keep-hierarchy`), so a plant on a rock that dresses a body rides the body.

## Not ported

- **Wind.** Karin's plants carried a `sway` weight per vertex (metres of free hang below a vine's release point; distance along a frond) and a vertex-shader patch swayed them. The weights are not computed here, and ferns and vines do not sway; only glow flora does.
- **Imported leaves.** Karin's editor could cut new leaves from an uploaded image into the vine's atlas.
- **The legacy SVG-leaf vine** (`render3d/hangingVine.ts`), which karin kept only so old recipes stayed editable.
- **Curved ivy cards** (`render3d/ivyGeometry.ts`, "Curve bush leaves"): karin bent the ivy add-on's flat leaf cards at load time in the game. That is a change to the ivy's look, not foliage, and the ivy's cards are flat by the owner's choice ([blender-ivy](blender-ivy.md)).
- **Karin's three placed plants** in her `ball.json`: their hosts are three.js mesh paths from her branch; place them again in `river.blend` if they are wanted.

## Credits

The four sheets are karin-lu's, from her branch ("the painted generators and atlases from the hanging-vines artifact pack"), and their licence is not stated there.
They are not in `tools/blender/image_credits.json` until it is, so every export that ships a plant warns that `foliage-atlas-v1.png` has no credit; add a set for them (author, source, licence) when it is confirmed, and publish the sheets as sources (`bun run assets:publish-sources scenes/textures/foliage/leaf-atlas.webp` and the other three) so `just sources` brings them to another machine.

## Verified, and not

The records below are dated and kept as written, from when plants were placed in a level's scene by hand (retired 2026-11-26).

2026-10-08, all on a scratch copy of `river.blend` (never saved over the real one):

- The port against karin's TypeScript, as above.
- Two ferns, a sprig bush and two vines planted by script on `Terrace` and `Terrace.002`: 1.0 s for all five (painted fern 0.3 s, leaflet 0.5 s, sprig 0.05 s, vines 0.02 s).
- `scene_export.py` over that copy, with a copy of the bake cache: the export grew the same five meshes (same triangles), the rocks' bake was unaffected by the plants, and the only foliage warning was the atlas's missing credit. The optimiser kept the material (`Foliage`, MASK 0.35, double-sided), `COLOR_0`, the plant node names and their parenting, and took the atlas through the 2k rule (183 KB WebP at 2048 x 1728).
- The game drawing that export (`cli shot --view` at the Terraces, the published `scene.glb` restored byte-exact after): ferns on the ledge, vines down its face, and `5 plant meshes cast and receive leaf shadows` in the log.
- The real Blender UI on a private headless sway: Add Fern pressed, dragged and released, Add Vine clicked, Ctrl+click removing a fern, the panel and pickers, and Live regrowing on a setting, a variety change and a turn.
- Growing every plant twice gives the same bytes. It did not at first: a plant just created grew from the matrix as set, and the export from the depsgraph's (parent x basis), which differs in the last bit, and a fern's fit is branchy enough to notice; `create_plant` now evaluates first. And the plants' extents are read from their meshes, not `bound_box`, which lagged a plant grown a moment earlier, so the next one did not keep clear of it.

Not yet: the owner's look at any of it, G and S driven by hand in a real session (moves were set by script and regrew), a play, a fern's or vine's numbers tuned for this game (they are karin's), and the sheets' credit and publication.
A host's shape is not watched: after editing the rock, Rebuild (the export always does).
