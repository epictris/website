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

**Look Through Game Camera** makes it the scene camera and gives the scene its 60 fps, its frame range and a 1920x1080 frame, so scrubbing the timeline is travelling the route and the camera view is the game's view at that frame.
The camera is head-on and never turns, as the game's never does.
What it cannot show is the game's light and fog: those are the level's (`environment`), and the viewport's are Blender's.

## Editing outlines through the camera

A formation's outline is a polygon in its own X/Z plane, which may stand tens of metres behind the gameplay plane, tilted, mirrored and scaled by its placement.
What matters is where its silhouette lands on screen, so **Edit Outlines** edits the outlines as they are seen.
Each is projected from the game camera's eye, at the current frame, onto the gameplay plane (`y = 0`) as a flat 2D handle curve, and the view looks through the game camera, so a handle sits exactly on the rock it shapes.
An edited point goes back along its camera ray to the formation's own outline plane, which keeps depth, tilt, mirroring and scale.
It edits the selected formations, or every formation when none is selected; nothing else takes clicks while it runs.

- **G** moves points, **Tab** toggles between points and whole outlines.
- **Copy** / **Paste** duplicate outlines, placed like the formation they came from; **New** starts a square at the 3D cursor.
- **Delete** retires a formation to the hidden `Formation backups` collection on Apply (one never built is simply removed); **Discard** restores everything since the last Apply.
- **Add Point** puts a midpoint between selected neighbours, or after a single selected point; **Remove Points** keeps at least three.
- **Apply** writes the edits into the outlines, **Done** applies and leaves, **Discard** leaves without.

Every change is validated (a simple polygon, finite, not edge-on to the camera, the formation not moved meanwhile, its mesh not hand-edited) before any outline is written.
The projection is from ONE frame, shown in the panel: scrubbing while editing moves the camera and not the handles.

**Rebuild Changed** rebuilds every formation whose outline differs from the one its mesh was built from, one rock at a time in separate processes; the meshes are swapped only once every rock has built and validated, and Esc discards the lot.
A rebuild keeps the formation's materials, placement, name and id, and keeps the replaced mesh in `Formation backups`.

**Depth**: Forward and Back move the selected formations toward or away from the camera by the step.
With **Keep screen size** they scale about the game camera's eye, so they keep their size and place on screen from there; without, it is a plain move and they shrink with distance.
Growth rides along (it hangs from the placement), and is then stale: it is sized for its depth.

## Formations

A formation is a mesh carrying `formation_recipe` (the outline and the generator's parameters), under a **placement** empty that positions it.
**New Formation** builds one from a preset outline, or from a selected closed poly curve; **Rebuild** and **New Variant** rerun the generator with changed parameters.
A selected curve ticks "From the selected outline" on its own.
A 3D curve gives its outline in its local X/Z plane, as a formation's own outline does; a flat (2D) curve gives it in its local X/Y, and the rock is turned a quarter about X to stand on it.
So a **guide piece** is a ready outline: select `guide.boulder-3` (linked, it need not be made local) and New Formation builds a rock on exactly the collision the ball rolls on, placed on the body's origin.
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

A new rock is one material, the **painted slate** ([cave-look](cave-look.md#surface-the-painted-slate-shader-and-the-v6-rig)), built by `formations/slate.py`, with a random `facet` float for its per-facet tone.
The tone is a function of the face's **orientation** (`slate.tone_facets`): Perlin noise of the object-space face normal times `TONE_SCALE` (1.5), offset by the seed, rank-mapped onto [0, 1], so faces that point almost the same way get almost the same tone and facets at clearly different angles still differ.
The fused rock is a planar dissolve of a remeshed surface, so one visible facet is many faces a few degrees apart; with a random tone per face every triangle of it drew (2026-10-02).
On the river's Terrace the mean tone step across an edge is 0.02 under 5°, 0.11 at 5-10° and 0.23 at 10-20°, against about 0.33 at every angle for a random tone; scale 2.5 left 0.17 at 5-10°.
The rock stays flat shaded, crisp at every edge, with the study's edge line: smooth shading across edges under 20° was tried the same day and was too smooth.
A build tones its rock; **Tone Facets** (Selected / All) brings a rock built earlier to the same state, flat shading included.
Neither moves a vertex, so it leaves the growth and the rebuild state alone (`core.mesh_hash` reads only positions and faces).
The generator's own tinted stones (five slots and a worn edge, the fork's dark teal `[.028, .063, .082]`) are not used since 2026-10-02.
The shader's Ambient Occlusion and Bevel nodes are Cycles only: the export bakes the whole Base Color to an image texture in Cycles ([blender-scenes](blender-scenes.md#what-blender-cannot-carry)), so the game gets the darkened crevices and the edge line, while EEVEE's Material Preview shows the stone without them.
A rebuild keeps the formation's materials, so a rock made before then keeps its teal until its material is replaced (or it is made again).

A generated mesh is sealed (`formation_mesh_hash`); one edited by hand is protected from being rebuilt over, and **Keep As Manual Mesh** says so on purpose.
**Show Source Slabs** and **Assemble Edited Slabs** expose the generator's pieces and join edited ones into a manual mesh.
**Make Unique** gives a duplicate its own mesh, id, outline and slabs.
The outline curves and slabs live in `Formation recipes`, hidden in render, which the exporter honours.

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
