# 2D level shapes, 3D climbing scenery

This is the current workflow. Draw flat polygons in the level editor. Generate
rounded, textured 3D roots from those polygons. Play and collide entirely in 2D.

The visual direction is stylised weathered wood: broad flowing grey-brown
ribbons, angular painted colour patches, rounded volume, soft directional light,
and a fixed side view. `stylised_bark.py` supplies the shared bark field for the
branch-aligned atlases and the four-band texture sheet.
The climbing silhouettes stay readable. This follows the general 2.5D direction
of Getting Over It and A Difficult Game About Climbing, using original geometry
and generated, branch-aligned bark textures.

## Open the sample

Open `sideview_output/sideview_roots_demo.blend`. The three source objects in
`EDITOR_2D_OUTLINES` are single, flat polygon faces. Overlapping roots generate
one continuous 3D mesh; disconnected roots remain separate. Preview images show the editor, final scenery, and their
alignment from exactly the same orthographic camera.

Run `blender_polygon_roots.py` in Blender's Scripting workspace to register the
**Root Kit** sidebar after opening the file. The panel is session-local.

1. Click **Edit 2D**. Select a source polygon and edit its outline vertices in
   the front orthographic view. Keep every vertex at Blender Y = 0; X is horizontal
   and Z is vertical. Do not extrude the source. Each shape is one filled n-gon.
2. Use edge selection in Edit Mode and **Mark Grab** / **Clear Grab** to choose
   playable boundary segments. Edge `i` joins vertex `i` to vertex `i+1`, wrapping
   at the end. Unmarked edges still collide, but cannot be grabbed.
3. Adjust **Corner rounding** (0–1; 0 keeps straight edges). Select end edges
   in Edit Mode and choose **Broken End** to add chips and exposed end grain.
   **Clear End** removes that treatment. Both controls change the evaluated
   silhouette and its collision together. The simple control polygon stays editable.
4. In Object Mode select the source polygons and choose **Generate and Export
   Roots**. **Visual depth** controls the generated volume only. Objects without
   that custom property use 0.38 m by default.
5. Click **Edit 2D** after generating to see the evaluated wire outline over
   the control polygon, or **Preview 3D** to inspect the result from the same side.
   Regenerate after changing controls. The sample uses rounding 0.78 and four
   marked broken ends; new polygons default to straight edges and no broken ends.

Use one unit per metre and scene unit scale 1.0. Simple concave outlines are
supported. Holes, crossings, touching edges, duplicate adjacent points, and
collinear outline vertices are rejected. Use separate polygons for separate
pieces. Grab marking is stored as the Boolean edge attribute `grab_edge`;
end marking uses `broken_end`. If rounding creates a self-intersection, generation
reports an error so you can reduce rounding or adjust the control points.

Seed and depth cannot move the collision outline or grab edges. Rounded cross-sections,
uneven taper, twisting depth, swollen fork shoulders and raised bark plates
add volume along the depth axis only. Front and back are deliberately asymmetric.
Overlapping shapes merge into a continuous fork instead of intersecting meshes.
The structural mesh projects onto the exact union of the evaluated silhouettes;
enclosed gaps remain open. The editable polygon remains in `blockout.json`, while
the gameplay manifest contains the rounded/chipped contour and a `source_edges`
mapping back to original control edges. Changing rounding or broken-end marks
intentionally changes the route; re-export and rebuild physics colliders together.
Decorative twigs, when enough
space exists, are excluded from physics and kept away from marked edges in
screen space. The supplied demo marks every boundary and therefore generates
no twigs; narrow corners still fail the hand-footprint check.

## Outputs

| File | Use |
| --- | --- |
| `blockout.json` | Editable flat shapes and visual depth |
| `roots.gameplay2d.json` | Authoritative 2D polygons, collision triangles and grab edges |
| `roots_LOD0.glb` | Rounded 3D meshes with embedded albedo, normal and roughness maps |
| `roots_LOD1.glb` | Same structure, simpler optional twigs |
| `roots_LOD2.glb` | Same structure, no twigs |
| `01_flat_editor.png` | Flat authoring preview |
| `02_3d_sideview.png` | Side-on shaded result |
| `03_collision_alignment.png` | Exact 2D outline over the 3D result |
| `00_before_first_pass.png` | Earlier sample for visual comparison |
| `00_before_second_pass.png` | Sample before rounding, layered bark and broken ends |

Each connected visual surface gets one baked bark atlas. An inferred curved
spine makes the grain follow each limb. Child grain coordinates align with the
parent before the bark is synthesized, so fibres turn through forks without
blurring two independent textures together. Raised plates and fine fissures
contrast with smoother, lighter exposed wood. Broken ends have sloped fracture
facets, irregular chips, ring grain and split fibres. Albedo, tangent-space normal
and roughness maps
are embedded in each GLB, using standard PBR materials. No custom runtime shader
or extra Python dependency is required.

Visual nodes list all contributing source IDs in `source_root_ids`, with
`surface_model: continuous_rounded_union`. A fused node's `root_id` identifies
the visual cluster; use the gameplay manifest's original IDs for physics and
saved attachments. Overlapping source boundaries can be inside the combined
solid and are correctly rejected by the 2D grab query.

The three structural LODs currently share geometry. When no decorations are
generated, their meshes are identical. The 2D workflow exports no 3D collision
or grab GLBs. Do not feed the visible meshes into gameplay physics.

## Level-editor data

```json
{
  "version": 2,
  "units": "meters",
  "up_axis": "Y",
  "gameplay": "2D",
  "roots": [{
    "id": "ledge",
    "polygon": [[0,0], [2,0], [2,1], [0,1]],
    "grab_edges": [2],
    "depth": 0.38,
    "corner_rounding": 0.6,
    "broken_edges": [2]
  }]
}
```

Coordinates are `[x,y]` in a conventional Y-up 2D editor/runtime. Either winding
is accepted and edge IDs retain their authored order. Blender maps a point to
`(x, depth, y)` internally; GLB export maps it to `(x, y, -depth)`. Three.js uses
the resulting XY gameplay plane at Z=0, with the camera looking from +Z.

`corner_rounding` and `broken_edges` are optional. Broken-edge indices refer to
the original control polygon. The resolved segment `i` maps back through
`source_edges[i]`. A rounded corner is grabbable only when both adjacent authored
edges are marked. Small connected curve segments are treated as a continuous
hold, while sharp corners and transitions into unmarked edges limit the hand footprint.

For custom JSON, run:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python .\blender_polygon_roots.py -- --input .\sideview_output\blockout.json --out .\sideview_output
```

Regenerate the sample and its images with `build_sideview_demo.py` using the same
Blender background invocation without the arguments after `--`.

## Three.js / 2D physics integration

```js
import { Vector2 } from 'three';
import { loadSideViewRoots } from './sideview-roots.js';

const roots = await loadSideViewRoots('/assets/sideview-roots');
scene.add(roots.group);
roots.setDebug(true); // Green grab edges; red unmarked collision edges.

const colliders = roots.getColliders2D();
// Register collider.polygon with your 2D physics engine.
// Engines requiring convex shapes can use collider.triangles, which index
// collider.polygon. Do not treat internal triangulation edges as grab edges.

const grab = roots.findGrab2D(new Vector2(handX, handY), {
  maxDistance: 0.25,
  handRadius: 0.055,
  obstacles: nearbyWorldPolygons, // Arrays of world-space Vector2 points.
});
// grab.point, grab.normal and grab.handCenter are world-space Vector2 values.
// Attach through your 2D physics system using rootId and sourceEdge.
// sourceEdge is the original control edge; segmentIndex is the evaluated segment.
// roots.dispose() when unloading.
```

Keep player position, velocity, hands and constraints in XY, with render Z fixed.
Use an orthographic side camera; background scenery can have visual depth.
Root transforms may translate, scale and rotate within XY. Out-of-plane
transforms are rejected. Rebuild engine colliders when root transforms change.

The query excludes short/narrow marked spans, interior approaches, unreachable points,
overlapping roots, occupied hand circles, and swept approaches through polygons.
It also accepts `canPlaceHand` and `isPathClear` callbacks for engine-specific
checks. Supply other level colliders through `obstacles`. This repository is an
asset pipeline plus integration adapter; it does not contain the game's level
editor, player controller, physics engine or camera-follow implementation.

## Verification

```powershell
python -m unittest test_sideview_roots test_polygon_roots
node --test .\three\test-sideview-roots.mjs .\three\test-polygon-roots.mjs
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python .\test_blender_sideview.py
```

Tests cover concave triangulation, exact projected boundaries and union areas,
open gaps, continuous watertight forks, branch-aligned grain coordinates,
rounding/chip collision alignment, source-edge mapping, curved holds,
asymmetric volume, bounded PBR maps and end grain,
depth/seed-independent gameplay, clockwise input, invalid outlines,
2D grabs/obstacles/transforms, and Blender edge authoring and repeated exports.
The original version-1 3D face workflow remains available for older assets;
see `POLYGON_ROOTS.md` for that legacy contract.
