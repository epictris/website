# Generated rocks

Since 2026-09-23 a level's rock is not drawn as the flat extrusion of its collision outline but as **faceted boulders built offline in headless Blender**, one GLB per level.
It is an MVP: the shape and the swap work, moss and everything under [What is not done](#what-is-not-done) do not.

The reference look is the boulders of "A Difficult Game About Climbing": faceted, pale grey, low detail, stones piled against each other with dark cracks where they meet.
It is the rock half of the [painterly style](art-style.md): large flat planes of tone with crisp edges, which here come from the geometry rather than from a painted normal map.

**The collision outline is a guide, not a contract.**
The author accepted a few centimetres of in-plane deviation and free bulging in depth, capped toward the camera by `FRONT_CAP` so a rock face never covers the ball rolling on the gameplay plane.

## Why offline Blender

- **Clean facets need a remesh and a planar decimate**, which three does not ship and which would be slow to run at load.
- **Cavity shading is baked** (Blender's dirty vertex colours), so the cracks cost nothing per frame.
- **One script reads the level**, so the moss can later follow the attachable flag rather than being painted by hand.
- A model pack cannot follow an authored outline at all.

The cost is a regeneration step whenever a rock's outline changes, which the author accepted; [staleness](#staleness-and-the-hash) makes a forgotten one visible instead of wrong.

## The pipeline

1. **The level file is the source of truth.** `src/render3d/rocks.ts` decides which pieces are rock and lays them out; it is free of three.js so bun and the browser read the level through the same code.
2. **The job.** `scripts/generate-rocks.ts` (`bun run assets:rocks <level>`) reads `levels/<level>.json`, calls `rockBodies`, and writes a JSON job to the temp dir: per rock body its index, hash, and pieces (world-space outline in metres, `depth`, `z`, `mossy`).
3. **Blender.** It runs `blender -b --factory-startup --python tools/blender/rocks.py -- job.json out.glb` (`--blender PATH` or `$BLENDER` overrides the binary) and echoes only the `[rocks]` lines and anything that looks like an error.
4. **The GLB.** `public/rocks/<level>.glb`, gitignored like every other binary the renderer draws. One node per body, named `body-<index>` (`rockNodeName`), carrying `rockIndex` and `rockHash` as glTF extras.
5. **The runtime swap** (below).

**Which pieces are rock.** A body counts when it is `static` and not `passable`; a geometry object on it counts when it is a `primitive` (`rect`, `poly` or `circle`, a circle as 24 sides) wearing one of the `ROCK_TEXTURES`: `dark rock`, `marble cliff`, `rock wall`, `stone`, `moss-dark`, `mossy ground`.
The last two set `mossy`, which the generator ignores today but which is in the hash, so a moss pass will mark every mossy body stale.

**How an outline becomes stone.** The recipe is the author's Rock_Cliff_Sharp geometry-node setup, done with modifiers and numpy: cube, Voronoi position offset, instance on points, bevel, voxel remesh, noise offset.
A body builds a handful of shard templates (a cut cube warped by a Voronoi texture, tapered by `SHARD_TAPER`, bevelled and Catmull-Clark subdivided), then fills each outline with many tall, overlapping instances of them, sized by `SHARD_BASE` times the rock scale S (`ROCK_SCALE`, one constant for the whole level, so a 5 m wall and a 1 m ledge show the same size of stone), randomised within `SHARD_SCALE_MIN..MAX`, spun about the vertical by `SHARD_SPIN`, jittered by `SHARD_OFFSET` and wandered by a large noise (`WANDER`, `WANDER_SCALE`) so the columns lean and stagger.
Their depth is the extrusion's: the authored `depth` centred on the gameplay plane, so the proudest faces stand half of it in front of the plane, exactly where the flat extrusion's front face was (a first version put them at the plane and the ball looked as if it hovered ahead of the rock).
Toward the outline's edge the front falls back by `EDGE_FALL` times S, reaching full fall at the edge and none `BULGE_RADIUS` in from it, the rounded profile of a rock.
A `PROUD_SHARE` of the shards sit at that front (jittered by `DEPTH_JITTER`) and the rest are recessed behind it by up to `RELIEF` times S, which is where the stepped column faces and their shadows come from; both are capped so they fit in the depth.
Every shard is stretched from its front to the back of the solid, so a top face shows shard tops rather than a thin fringe in front of a slab, and one prism of the outline fills in behind the deepest recess, at least `MIN_BACKING` thick.
Each shard that reaches past the outline is intersected, on its own, with one prism of the whole concave outline pushed out by `OUTLINE_TOLERANCE` (Blender's float boolean; a shard is a simple closed solid, so it is exact enough and takes milliseconds).
A geometry object's `bevel` (the extrusion's chamfer, clamped the same way) is honoured by placement, not by cutting, and does two things.
It is the TAPER: within `bevel` of the outline the shard fronts fall along a quarter-round from the full half-depth down to `TAPER_MARGIN` in front of the gameplay plane at the edge, so the rock swells out of the plane toward its middle and meets the ball at the edge, the line the player travels, rather than standing half a depth in front of it.
It is also the RAGGED EDGE: a shard that would reach the outline above or below its position is shortened along the level's up axis so its natural tapered end stops a random way short of the outline, up to the bevel (`RAGGED_FLUSH` of them end exactly on it, the rest are pulled in by a square law, and none is shortened below `RAGGED_MIN_LENGTH` of itself), so the edge reads as a broken skyline of shard ends rather than as the flat plane the clip would have cut.
The cost of the ragged edge is that the visual top can sit below the collision edge by up to the bevel, so the ball may float slightly at the very edge.
On a bevelled piece the backing prism is inset by the bevel (capped by the outline's clearance), so the edge band is shards and air; a slab running up to the outline showed its thin top edge as a plate floating above the ragged ends.
The bevel is in the hash, so changing it in the editor marks the body stale.
Clipping by half-planes against convex parts came before this and could not be made right: every decomposition seam cut the shards along a straight line across the rock, and at a reflex corner the seam plane's extension left a facet belonging to no outline edge.
The convex parts (`decomposeConvex`, shipped by `pieceOf`) now only triangulate the caps of the backing and clip prisms.
By default the shards ship as instanced: the chamfered low-poly pieces, overlapping, with crisp corners and about a hundred triangles each.
With `--remesh` (the author's recipe's step) the lot is instead voxel-remeshed into one solid (`VOXEL_SIZE`), which fuses the shards but rebuilds the skin as a uniform grid at the voxel size, thousands of triangles per square metre, and rounds every corner by a voxel; the templates are Catmull-Clark subdivided (`TEMPLATE_SUBDIV`) only on that path.
Either way the mesh is then warped by the three `DETAIL` offsets (smooth noise at three feature sizes, all scaled by S), stripped of stray islands (`ISLAND_MIN`) and back faces, collapse-decimated (`COLLAPSE_RATIO`), and shaded smooth with edges over `SHARP_ANGLE_DEG` marked sharp.
The offsets move every vertex by the same vector for a given field value, as the author's graph does (a scalar texture times a constant vector), so they warp the rock without rounding it; displacing along the normal instead eroded every shard edge into a blob, and the legacy Voronoi texture's hard cells covered the faces in bubbles.
`depth_shade` then darkens the colour layer with depth (`DEPTH_SHADE`), because the game looks at a rock head-on and lit head-on, where a recessed slab would otherwise be exactly as bright as the one in front of it.
`bun run assets:rocks ball --flat` leaves the texture out so the shape can be judged by its shading alone, and `--decimate 1` skips the collapse so the clean corners the remesh made can be inspected (a whole level at 1 is several million triangles; 0.8 is the iteration compromise, `COLLAPSE_RATIO` the shipping one).
Building a few bodies to `public/rocks/test.glb` and opening the game with `?rocks=test` is the fast loop: the other bodies report stale and keep their extrusions.
Box-projected UVs in world metres (`TEXTURE_TILE`) carry the tileable striated texture `rocktex.py` generates (albedo, normal, roughness, one 1 m tile, WebP in the GLB); a body-wide dark grey in `COLOR_0`, darkened in the cavities by the dirty vertex colours, multiplies it.
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

## Staleness and the hash

`rockHash` is FNV-1a over every piece's depth, z, mossy flag and vertices, **rounded to the millimetre**: editor float noise hashes the same, a vertex nudged by a millimetre is a different rock.
It is written out by hand rather than through `crypto` because bun and the browser must agree bit for bit.

A body whose outline changed since generation, or that was never generated, **keeps its extrusion**, and one `console.info` line lists the stale body indices with the command to rerun.
No level ever fails to draw; a stale rock announces itself by looking flat.

## Tunables

At the top of `tools/blender/rocks.py`, metres unless said otherwise.

| Name | Meaning |
|---|---|
| `ROCK_SCALE` | the scale S everything below is sized by, the same for every piece (the author's numbers are for S = 5 m); `--scale S` overrides it per build |
| `TEMPLATES`, `TEMPLATE_CUTS`, `TEMPLATE_WARP`, `TEMPLATE_CELL` | how many shard shapes a body builds, how the cube is cut, and the Voronoi warp's strength and cell size |
| `TEMPLATE_BEVEL`, `TEMPLATE_BEVEL_SEGMENTS`, `TEMPLATE_BEVEL_ANGLE`, `TEMPLATE_SUBDIV` | the bevel and Catmull-Clark rounding of a template |
| `SHARD_BASE`, `SHARD_TAPER` | a shard's size (across, depth, up) at S = 1 and how much narrower its top is than its bottom |
| `SHARD_SCALE_MIN`, `SHARD_SCALE_MAX`, `SHARD_OFFSET`, `SHARD_SPIN` | the per-shard random scale, plan jitter and spin about the vertical |
| `SHARD_DENSITY`, `MAX_SHARDS` | shards per m^2 of plan area at S = 1, and the cap per piece |
| `WANDER`, `WANDER_SCALE` | the large noise that staggers the columns sideways and vertically, and its feature size in S |
| `BODY_TILT` | the body's strata tilt from vertical (degrees) |
| `EDGE_FALL`, `BULGE_RADIUS`, `DEPTH_JITTER` | how far the front falls back toward the outline's edge (times S), how far in from the edge the fall starts, and the per-shard in-and-out |
| `RELIEF`, `PROUD_SHARE` | how far behind the front a recessed shard may sit (times S), and the share of shards that stay proud |
| `TAPER_MARGIN` | how far in front of the gameplay plane a bevelled piece's taper stops at the edge |
| `RAGGED_FLUSH`, `RAGGED_MIN_LENGTH` | on a bevelled piece, the share of edge shards that end exactly on the outline, and the least a shard is left of itself when shortened |
| `MIN_BACKING` | the backing prism is at least this thick |
| `OUTLINE_TOLERANCE`, `OUTLINE_TOLERANCE_RATIO` | how far past the outline a shard may reach before it is cut, in metres and as a share of S |
| `DEPTH_SHADE` | how much brightness a face loses at the deepest recess |
| `VOXEL_SIZE`, `VOXEL_MIN` | remesh voxel size per S, and its floor |
| `DETAIL` | the three surface offsets after the remesh (mid Voronoi, small Voronoi, fine noise), each a feature size and a strength at S = 5 |
| `COLLAPSE_RATIO` | collapse decimation of the visible faces |
| `SHARP_ANGLE_DEG` | edges over this dihedral angle stay sharp under the smooth shading |
| `ISLAND_MIN` | a connected island smaller than this share of the piece's largest is a stray sliver, dropped |
| `BACK_NORMAL`, `BACK_SETBACK` | a face is back, and dropped, when its normal points this far away from the camera and it sits this far behind the plane |
| `TEXTURE_TILE`, `TEXTURE_SIZE`, `TEXTURE_SEED` | metres per texture tile, its resolution and its seed |
| `ROCK_GREY`, `SHADE_JITTER`, `HUE_JITTER` | the base stone colour (linear) under the texture, and how far each body may wander in brightness and hue |

## Commands and how to look at it

```sh
bun run assets:rocks ball                       # levels/ball.json -> public/rocks/ball.glb
bun run assets:rocks ball --only 3,17           # just those body indices, for a quick look while tuning
bun run assets:rocks ball --out /tmp/try.glb    # somewhere else
bun run assets:rocks ball --flat --decimate 1 --scale 3   # untextured, uncollapsed, finer stone (S = 3 m)
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
