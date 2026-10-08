# Formations in Blender

Since 2026-09-29 a Blender scene can hold **formations**: rock masses generated from an outline by the boulder generator, edited through the game camera, with moss beds, sprigs and hanging moss grown on them.
They are a Blender add-on, `tools/blender/formations/`, and they are scenery like anything else in a scene: `just scene <level>` exports them (see [blender-scenes](blender-scenes.md)), and no formation can change how the ball rolls.
The Sunken Grotto, `assets-src/scenes/grotto.blend` (the `ball` level's scene), is built from them.

The tools came from karin_website's "Connected v5" background pipeline, which rendered the grotto into near and far layer packages with baked lighting and a camera of their own.
What was kept is the authoring: the outline-to-rock generator, the camera-projected outline editor, depth moves that keep screen size, and the growth.
What was dropped is everything about layers and packages: formations are ordinary scene geometry, lit and fogged by the level like the rest of the scene, and the package camera became the game's own camera (below).

## Install

```sh
just formations-install   # once per machine; links the add-on into Blender and enables it
bun run generators:setup  # once per machine; the Python the generator needs (rope/.venv)
just sources              # the scenes' .blend files and the growth textures, from the release
```

The add-on is the **Formations** tab in the 3D viewport's sidebar (N).
`tools/blender/addon_install.py` links the package into Blender's `user_default` extension repository, as it does the ivy and moss add-ons.
The scene exporter imports the package from the repo itself and needs none of this.

## The game camera

`just scene-guide <level>` bakes the **game camera** into the level's guide as `guide.camera`, linked into the scene with the rest of the guide.
It is the level's lens (its `camera.focalLength`, 35 mm-equivalent against the 24 mm sensor height, so Blender's vertical fit reproduces the field of view exactly) standing where the game's camera stands, keyed on every frame at 60 fps.
The poses come out of the game's own code (`src/sim/cameraTrack.ts`): the real `CameraController` stepped at 1/60, and the 3D pose from `poseFromCamera` with the level's lens, which is what `Scene3D` draws through every frame.

- **Along the paths** (the default): a follow point walks each of the level's camera paths from its start to its end at 3 m/s (`--speed`), and the controller follows it through every region and path rule on the way.
  There is no canonical run of a level, and the route is what the level's camera is authored around.
- **A ride** of a recorded run: `just scene-guide ball --ride playtests/regressions/session-1010f.json.gz` replays the sim and feeds the camera exactly what `cli camera --ride` does, for the view one playthrough had.

**Look Through Game Camera** makes it the scene camera, gives the scene its 60 fps, its frame range and a 1920x1080 frame, and puts it on the first frame, the start of the route, so scrubbing the timeline is travelling the route and the camera view is the game's view at that frame.
The buttons under it ride the camera back along the route, pause it and ride it forward, at the game's pace (the scene drops frames rather than slowing down when it cannot keep up); the frame field beside them scrubs.
The camera is head-on and never turns, as the game's never does.
What it cannot show is the game's light: that is the level's (`environment`), and the viewport's is Blender's.

**Lighting**, **Fog** and **Depth of Field** under it are the game's look over that view, each a toggle (`tools/blender/formations/look.py`), each built from numbers the guide takes straight from the game's code, so nothing is a copy that can drift.

**Lighting** is the game's light at rest instead of the scene's own.
`just scene-guide` builds it into the guide file from `lightingOf` (`src/render3d/environment.ts`, which the game's `Environment` builds from too) and the always-on light objects `LightRig` builds (waking lights start dark and fireflies move, so neither is there): a `guide.lights` collection (the sun and the spots and points, outside the `Guide`, so nothing lights the scene until asked) and a `guide.world`.
The toggle links both in, makes `guide.world` the scene's world, hides the scene's own lights, and sets the view transform to the game's tone mapping; off puts the world, the view settings and the lights' visibility back.
Every conversion is measured in EEVEE against three's physical lights rather than assumed:

| Game (three.js) | Blender |
|---|---|
| sun, intensity I | sun, strength I (both light white diffuse to I/pi) |
| spot or point, I candela | power 4 pi I W |
| hemisphere fill, sky over ground, intensity I | the world, sky above and ground below at I/pi (the same diffuse irradiance, linear in the normal's height) |
| the generated sky it reflects, at `envIntensity` | the same pixels in the world, sampled with three's equirectangular mapping |
| the background colour it clears to (never tone mapped) | the world to camera rays, at the colour the tone mapping shows as those bytes |
| ACES Filmic at exposure 1 | ACES 1.3 at exposure log2(1 / 0.6) (three divides by 0.6 first; mean error 0.005 over a grey ramp and random colours) |

A white diffuse card facing the camera under the guide's world and sun renders within 3 % of three's formula with the same numbers.
What is not the same: three's light reach fades out as `(1 - (d/range)^4)^2` and Blender's cuts off at the range; the sun's shadow is softened by a 5 degree disc, which matches the game's fixed-width filter only about a metre from the occluder; the hemisphere fill has no specular in three and the world does in Blender; and the materials are Blender's, not the exported game's.
A level that names a captured sky (`hdri`) still gets the generated one.

**Depth of Field** makes `guide.camera.dof` the scene camera: the game camera (it rides on it) with Blender's own depth of field, its focus and f-number keyed per frame so that the blur behind the plane is the game's Medium (`DOF_MAX_BLUR`, `FOCUS_BAND` in `src/render3d/depthOfField.ts`).
The game's thin lens has a circle of `dofMaxBlur` of the frame's height at infinity times `1 - focus / depth`; Blender's has diameter `f^2 / (N (s - f)) * |1 - s/d|` on the sensor, so the f-number is `f^2 / (48 dofMaxBlur (s - f))` against the 24 mm sensor height (measured within a pixel of the game's at 15 m, 30 m, 100 m and 1 km).
It blurs in front of the focus too, where the game keeps everything sharp.

**Fog** is a compositor tree, `Formations game look`, which the toggle makes the scene's compositor with the Depth pass and the viewport compositor in camera view on (Material Preview and Rendered shading, and renders).
The game mixes its fog in after tone mapping, over the colours as they are shown, so the tree does too: the image goes to the display through the scene's view transform (its exposure applied around the conversion, which takes none), the fog `1 - exp(-(density * depth)^2)` mixes in the fog colour's sRGB bytes (never over the sky), and the result is inverted back to scene linear for the view transform to apply again (a round trip that changes no pixel by more than 1/255).
Off hands the compositor and the Depth pass back as they were; a scene with a compositor of its own refuses it.
A guide written before 2026-10-05 has none of the three: rerun `just scene-guide <level>` and reopen the scene.

## Editing guides through the camera

A formation's **guide** (its outline, recipe key `outline`) is a polygon in its own X/Z plane, which may stand tens of metres behind the gameplay plane, tilted, mirrored and scaled by its placement.
It is the rock's only source; the level's collision outlines never are (see [Formations](#formations)), and nothing here reads or writes one.
What matters is where its silhouette lands on screen, so **Edit Guides** (Edit Outlines until 2026-10-07) edits the guides as they are seen.
Each is projected from the game camera's eye, at the current frame, onto the gameplay plane (`y = 0`) as a flat 2D handle curve, and the view looks through the game camera, so a handle sits exactly on the rock it shapes.
A rock built on the plane from a copy of a collision outline therefore shows its handle right over that outline; the handle is the guide's, and moving it leaves the collision where it was.
An edited point goes back along its camera ray to the formation's own guide plane, which keeps depth, tilt, mirroring and scale.
It edits the selected formations, or every formation when none is selected; nothing else takes clicks while it runs.

- **G** moves points, **Tab** toggles between points and whole guides.
- **Copy** / **Paste** duplicate guides, placed like the formation they came from; **New** starts a square at the 3D cursor.
- **Delete** retires a formation to the hidden `Formation backups` collection on Apply (one never built is simply removed); **Discard** restores everything since the last Apply.
- **Add Point** puts a midpoint between selected neighbours, or after a single selected point; **Remove Points** keeps at least three.
- **Apply** writes the edits into the guides, **Done** applies and leaves, **Discard** leaves without.

Every change is validated (a simple polygon, finite, not edge-on to the camera, the formation not moved meanwhile, its mesh not hand-edited) before any guide is written.
The projection is from ONE frame, shown in the panel: scrubbing while editing moves the camera and not the handles.

**Rebuild Changed** rebuilds every formation whose guide or parameters differ from the ones its mesh was built from, one rock at a time in separate processes; the meshes are swapped only once every rock has built and validated, and Esc discards the lot.
A rebuild keeps the formation's materials, placement, name and id, and keeps the replaced mesh in `Formation backups`.

**Depth**: Forward and Back move the selected formations toward or away from the camera by the step.
With **Keep screen size** they scale about the game camera's eye, so they keep their size and place on screen from there; without, it is a plain move and they shrink with distance.
Growth rides along (it hangs from the placement), and is then stale: it is sized for its depth.

## Formations

A formation is a mesh carrying `formation_recipe` (the guide's outline and the generator's parameters), under a **placement** empty that positions it.
**New Formation** builds one from a preset outline, or from a selected guide (a closed poly curve).

The parameters are also fields on the rock (`Object.formation_params`, `formations/params.py`), shown in the panel whenever the rock, its placement or its outline is the active object.
The recipe records what built the mesh; the fields are what the next build uses.
They are loaded from the recipe when a rock is built, when a file opens and when the add-on is enabled, so they start equal; editing a field makes the formation pending, like an outline edit.
**Regenerate** rebuilds the rock from its fields and current outline at once (no dialog), **New Variant** builds them as a new rock beside it and leaves this one as built, and **Revert to Built** (shown once a field differs) puts the fields back.
Rebuild Changed takes parameter edits along with outline edits.
A rock appended from another file has no fields loaded yet: **Edit Parameters** loads them, and until then it builds from its recipe, as it does in the scene exporter, which never loads them.
The grotto's rocks were built by Karin's pipeline, which recorded `generator` as the boulder generator's directory (`C:\...\boulders`); `params.generator_of` reads that as `boulders`, so they regenerate too (before 2026-10-04 they could not be rebuilt at all).
A selected curve ticks "From the selected guide" on its own.
A 3D curve gives its outline in its local X/Z plane, as a formation's own guide does; a flat (2D) curve is first turned into that in place (its X/Y becomes X/Z and the object a quarter about X, so no point moves).
A **free guide** (one no rock owns) becomes the new rock's own guide: it moves into `Formation recipes` under the rock, renamed `<rock> / guide`, and the placement goes where it stands, so an edit made to it while the rock built shows as pending.
Another rock's guide is only read, and that rock keeps it.

**Collision outlines are a reference, never a source** (2026-10-07, Tris: "The 2D collision outlines should serve exclusively as a visual reference").
The `guide.*` curves the scene links from the level's guide file are unselectable, and New Formation refuses one.
**Create Guide from Outline** (the eyedropper, under New formations) copies one: click a collision outline in the viewport (the one under the cursor is highlighted; the innermost wins where they nest; Shift+click keeps picking, Esc or right-click ends) and a free guide named `Guide` is made in `Formation guides`, the same points at the same place, selected for New Formation.
The copy is geometry and pose only: the guide records nothing about the outline, and nothing is written to the outline, so the editor can add, move or remove collision without any guide or rock in the scene changing.
Edit the guide like any curve (Edit Mode, or Edit Guides once it is a rock's), and the collision stays as the level has it.
A piece with a hole (a belt's band) is two splines and is refused.
The rock is built out of process, by `formations/worker.py` in ordinary Python (rope/.venv) and `formations/assemble.py` in a headless Blender, so the scene stays editable while it builds.
The dialog's **Generator** picks how (the recipe's `generator`; a recipe without one is the boulder generator's), and the **starting outline** (terrace, pillar, wall, arch, distant) is only an outline and a thickness to start from when no curve is selected:

- **Fitted slate** (`fitted`, the default since 2026-10-02, `formations/fitted.py`): [cave-look](cave-look.md)'s recipe F rocks of many sizes, fitted to the outline and fused into one mass.
  Over a grid of the outline as the game camera sees it, it finds the deepest part no rock covers yet, builds a rock a little bigger than that gap (between **Smallest rock** and **Largest rock**, long half-lengths), and keeps the spot and turn about the view axis that covers the most new outline, less what spills past it; so big areas take big rocks and the slivers left between them are not filled with rubble.
  Rocks are built at their real size: their form (corner cuts, bevel) in proportion, their detail (2.5 cm remesh, chisel, relief) in metres, so a big rock is as finely worked as a small one.
  Recipe F's chisel is bounded here, each cut a box reaching 0.2 to 0.5 m, since the study's unbounded planes would take a 45 cm wedge off a 3 m face.
  Behind the rocks is the **core**, the outline extruded, rounded and shrunk 30 cm inside it, so the rock has no hole through it and the collision outline itself is never seen (where it showed, it was a flat end and a straight edge); edge rocks are let spill a little so they reach the outline; a voxel remesh then fuses rocks and core into one body (as the boulder generator fuses its slabs), and the facets are cut over the whole at recipe F's density.
  Nothing is clipped to the outline: clipping looks artificial.
  On `dark-rock-4` (18 m²) it is 14 rocks, about 3900 faces, in about 5 s.
  Tried and dropped on the way, the same day: rocks in fixed tiers (read as a pile of stones, and large areas cut into small rocks), backing layers of bigger stones (their seams met the front's and left holes), a core held inside the outline (the silhouette fell short), and rocks built at 1 m and scaled up (detail grows with the rock).
- **Boulder generator** (`boulders`): `tools/blender/boulders`, unmodified, slabs cut to the outline and unioned.
  Its defaults are the generator's own (`params.json`: 10 slabs per m², a 3000-face budget, detail 1, a 1.2 cm voxel cap, weathering 0.38, the tolerance derived from the outline), the many crisp slabs the editor's boulder service built.
  From 2026-09-29 to 2026-10-04 they were Karin's scenery adapter's (1.3 slabs per m², 1000 faces, detail 0.25, 4.5 cm voxels), which cut a formation into a few big, softly remeshed chunks; Tris preferred the slabs.
  A rock built in that window keeps every one of them in its recipe and its fields, and a regenerate keeps them until they are changed; tolerance is never a field and is always derived from the outline.
- **Solid guide** (`solid`, since 2026-10-05, `formations/solidfit.py`): recipe F stones cut from a closed **guide mesh** instead of an outline, sized and worked by their depth from the game's start camera; the backdrop is made of these ([blender-backdrop](blender-backdrop.md)).
  New Formation with a closed mesh selected makes one (the dialog ticks "From the selected mesh" and picks the generator): the mesh becomes the rock's guide, in world space, and the rock stands at the world origin, since its stones are sized by their depth from the eye.
  Its recipe holds the guide's geometry, the start camera and water (`backdrop_camera` on the scene, which `tools/blender/backdrop.py` writes from the level: a scene without it cannot build one) and the rock's world frame; moving the guide, editing its mesh, moving the rock or changing the start camera makes it pending.
  Its fields: **Seed**, **Stone size** (times every stone's on-screen size; stones on a curve still split down to the small sizes), **Facets** and **Chisel** (shares of recipe F's), **Merge small** (the knub share), **Curve split** (degrees of gentle turning before a cell splits), **Depth floor**, **Fixed LOD** (over 0, every stone is cut, weathered and faceted as if it stood that many times the plane's distance back, instead of at its own depth) and **Facet falloff** (how much coarser on screen the facets get with depth; 0 keeps them as fine at any depth).
  A guide formation stays one: its generator cannot be switched to an outline's, nor an outline's to it.

A new rock is one material, the **painted slate** ([cave-look](cave-look.md#surface-the-painted-slate-shader-and-the-v6-rig)), built by `formations/slate.py`, with a random `facet` float for its per-facet tone.
The tone is a function of the face's **orientation** (`slate.tone_facets`): Perlin noise of the object-space face normal times `TONE_SCALE` (1.5), offset by the seed, rank-mapped onto [0, 1], so faces that point almost the same way get almost the same tone and facets at clearly different angles still differ.
The fused rock is a planar dissolve of a remeshed surface, so one visible facet is many faces a few degrees apart; with a random tone per face every triangle of it drew (2026-10-02).
On the river's Terrace the mean tone step across an edge is 0.02 under 5°, 0.11 at 5-10° and 0.23 at 10-20°, against about 0.33 at every angle for a random tone; scale 2.5 left 0.17 at 5-10°.
The rock stays flat shaded, crisp at every edge, with the study's edge line: smooth shading across edges under 20° was tried the same day and was too smooth.
A build tones its rock; **Tone Facets** (Selected / All) brings a rock built earlier to the same state, flat shading included.
A build also brings its stone in with it, so a file built before `slate.py` changed keeps the old graph; **Repaint Slate** rebuilds every `Painted slate*` material in the file to the current shader in place, no rebuild (the 2026-10-02 flat-tone shader is in [cave-look](cave-look.md#surface-the-painted-slate-shader-and-the-v6-rig)).
Neither moves a vertex, so it leaves the growth and the rebuild state alone (`core.mesh_hash` reads only positions and faces).
The generator's own tinted stones (five slots and a worn edge, the fork's dark teal `[.028, .063, .082]`) are not used since 2026-10-02.
The shader's Ambient Occlusion and Bevel nodes are Cycles only: the export bakes the whole Base Color to an image texture in Cycles ([blender-scenes](blender-scenes.md#what-blender-cannot-carry)), so the game gets the darkened crevices and the edge line, while EEVEE's Material Preview shows the stone without them.
A rebuild keeps the formation's materials, so a rock made before then keeps its teal until its material is replaced (or it is made again).

**Curved creases** (`formations/curve.py`, 2026-10-03, Tris: "Long straight edges should be slightly curved"): at export, every convex crease of a painted slate rock at least 0.4 m long and nearly straight (chord at least 0.97 of its length) is bowed by about 6 % of its length (5 to 7 %; Tris compared 3, 6 and 12 %, took 3, then switched to 6; capped at 20 cm, so the Terrace's 2.7 m crease bows about 16 cm), along its bisector, out of the rock or into it by the seed.
The creases are walked in edge index order, so a rock gets the same bows on every export (walking a set, two runs once differed by a crease).
The bow is a sine along the crease, so its ends and the corners stay put, and it fades with a smoothstep over 40 % of the crease's length across both faces, so the planes bend into the curve and the silhouette bends with it.
The fan-triangulated planes have nothing inside them to bend, and their slivers turn over when bent, so the surface the bows reach is triangulated afresh first (`curve.rebuild_mesh`, 2026-10-03).
Points closer than 0.5 mm are merged, and every triangle under 1.5 mm high over its longest edge is folded away: its far corner moves onto that edge and the edge turns to the neighbour's corner (`edge_rotate`), which keeps the surface and the creases where they were; a needle, its corner beside one end, is welded into that end.
A weld is made only where the two ends share no neighbour but the far corners of the triangles on their edge (the link condition, `collapsible`), and no two welds in one pass touch each other's ring: the unchecked weld pinched the river's Terrace into 14 open edges, and the detail high poly's rebuild then removed a corner it still needed and the export died (2026-10-04).
The Terrace has 902 of them, lying along creases a fraction of a millimetre off; no triangulation of a patch can help a sliver that is the whole patch.
Then the edges the bows reach are cut to the local size (the longest edge the bow bends by about 2 mm in its middle, from the field's second difference in 13 directions, 4 to 30 cm), and each patch (faces joined across folds under 5°, all within 10° of its largest; the formation's dissolve joins faces within 9°, so its fans are not flat) is constrained-Delaunay triangulated over a jittered grid thinned to the local size, the inside points dropped onto the old faces.
No boundary point moves, so creases and silhouette stay; each new face takes the facet tone, chamfer strip and material of the old face under its middle.
On the Terrace: 3048 faces to about 12 k, visible faces turned more than 30° by the bend from about 280 to 4 (none over 60°), no zero-area faces, about 5 s.
The Delaunay's edges run to about 1.5 sizes, so a chord is up to 6 mm off the curve; on well-shaped triangles that is only the curve's faceting.
Tried first and reverted: halving the fans' edges where the bend would leave them over 2 mm off (it only cut the slivers shorter, and its subdivision left duplicate faces), deciding sharp edges before the bend, re-triangulating the planes with `beautify_fill` (sawtooth seams in the baked normal map), and a cleanup that flipped edges by shape alone (across real creases: broken silhouettes); planes grouped within 1° were mostly single slivers.
The bent rock is smooth shaded across folds under 5° and sharp above; flat shaded, each fold of a degree or two drew a thin line across the face under the key.
The rock is rebuilt before the unwrap, every map is baked on it STRAIGHT, and only then is it bent (`curve.rebuild_mesh`, then `curve.bend` after the bakes); the maps' UVs and tangent space move with the vertices.
The detail high poly is built from the straight rebuilt rock (`detail.py` finds planes by flatness) and never bent; built from the rock before the rebuild, the folded slivers' creases sat up to 1.5 mm off it and the bake drew them as dark dashes and pale specks, so it matches the rock exactly at the bake.
Bending both and baking between them was tried first: each was fitted to the curve only to its own tolerance, and that misfit showed twice. Fitted to 4 mm, a long sub-facet triangle of the high poly folded and the bake drew a dark diagonal band; fitted to 0.5 mm against the rock's 2 mm, the bake's rays near a crease hit the high poly's other face, so the edge highlight landed beside the edge with the chips' floors as dark dashes (slate-tone page #15 and #16).
It never touches the scene file's mesh: the rock in Blender keeps its straight edges, and its growth is planted on those, so leaves near a long crease can sit up to the bow off the surface.
`cave-sheet-study/slate_check.py --curve 0|1` renders a rock with and without.

A generated mesh is sealed (`formation_mesh_hash`); one edited by hand is protected from being rebuilt over, and **Keep As Manual Mesh** says so on purpose.
**Show Source Slabs** and **Assemble Edited Slabs** expose the generator's pieces and join edited ones into a manual mesh.
**Make Unique** gives a duplicate its own mesh, id, outline and slabs.
The outline curves and slabs live in `Formation recipes`, hidden in render, which the exporter honours.
Only the outlines and slabs of the rocks in the scene stay there, so **Show guides** draws nothing stale: a backup's (a rebuild's or a Delete's) go with it to `Formation backups`, as do those of a rock deleted by hand, and every file load tidies one saved before this rule (`core.stow_helpers`, 2026-10-07).
**Guides** (since 2026-10-05): **Show guides** shows that collection in the viewport, every guide mesh in a saturated colour of its own (a viewport-only material: Solid shading in Material colour shows it), and **Solid rocks as wireframe** draws the solid formations' rocks as wire so their guides show through.
**Select Guide** (Select Outline on an outline's formation) selects it for editing; it is an ordinary mesh, edited in Edit Mode or by script, and it never renders or exports.

**Render (export)**, in the formation's box (`formations/render.py`): how the scene export draws the rock, each an ID property on it that overrides what its depth would decide, so a change needs an export and no rebuild.
**Detail scale** (its texel density and largest map divided by it, the slate's lengths multiplied by it; unset, the depth scale a solid formation's build measured, `formation_depth_scale`, else 1), **Chamfer strips**, **Curved creases** and **Chips and sub-facets** (the export's three finer passes; unset, on unless the detail scale is over 1), **Largest map** and **Texels per metre** (0: 4096 and 512 over the detail scale).
A field shows what the export will do; setting one makes it the rock's own, and **Passes and Maps From Depth** forgets them all.
The bake cache keys on the three passes too, since the chips change the normal map without changing the mesh.

Each formation has an **Attachment**, which decides what grows on it, and a **Moisture** (how much).

## Growth

**Replant Growth** (Selected, Stale or All) grows, on each formation, as a pure function of its mesh, placement, attachment, moisture and id:

1. **Sites** on the visible contour, sampled with rays from the camera side; on a floor formation only on a real upward shelf, spaced so bare stone shows between.
2. **Surface moss** (floor): a thin decal over the top faces in irregular lobes around the sites.
3. **Sprigs** (floor): small curved cards at each site's root.
4. **Hanging moss** (every attachment): complete strands curving over the lip of a site that spills, pushed clear of the rock along their whole drop.

Replanting an unchanged formation reproduces its growth exactly; the Sunken Grotto's accepted planting was checked this way, piece for piece, on migration.
Growth is sized to read at a constant size on screen: a piece `b` metres behind the plane is `(D + b) / D` times its size on the plane, with `D` the scene's `formations_view_distance` (10.2375 m in the grotto, the game camera at `viewportScale` 0.65 with the 70 mm lens).
The export warns about a formation whose rock changed since it was planted, and about an outline edited and not rebuilt.

The materials are built in the shape glTF carries: an image times a constant tint, alpha clipped at a cutoff, double sided, fully rough, no emission.
The images are packed into the scene; a scene without them loads them from `assets-src/scenes/textures/` (`just sources`).

## The Sunken Grotto

`grotto.blend` was converted from the fork's accepted artist master (`river_dream_layer_editor.blend`) on 2026-09-29: its 13 formations and 56 growth pieces, the "distant ravine" matte 240 m back, and the level's guide linked in.
Dropped with the layers: the reference foreground, the cameras, the Cycles lights, the rock libraries and bootstrap, the mesh backups and the construction data only those referred to.
The stone's emission (a Cycles ambient term) was removed, since the level lights it now; its procedural colour is baked to an image texture by the export.
The fork's two "far" formations were planted by rules that are gone; the one floor formation among them (`cyan twin ridge`) keeps its accepted sprig until it is replanted.

## Not yet

- Unplayed: verified by a headless replant, rebuild and edit round, and `cli shot --3d` of the opening; the look under the level's fog and light is still the play.
  The level's `fogAmount` (0.42) was tuned for the river cavern at 22-45 m, and the grotto stands at 28-80 m.
- The fork's `route chamber 1 bank` arrived with an edited outline it was never rebuilt from; the export says so until it is rebuilt or the edit reverted.
- The four pictures (the foliage atlas, the two moss sheets and the matte) have no credit in `tools/blender/image_credits.json` yet; the export warns about each.
