# Polygon-authored climbing roots

**Current workflow: flat 2D editor shapes with generated 3D visuals.** Start with
[SIDEVIEW_ROOTS.md](SIDEVIEW_ROOTS.md) and
`sideview_output/sideview_roots_demo.blend`. Gameplay uses 2D outlines and grab
edges; visual depth never changes collision. The documentation below describes
the preserved **legacy version-1 3D cage / face-grabbing workflow**, not the
current side-view workflow.

## Legacy 3D cage workflow

Build the large roots as closed, coarse polygon meshes. Mark the exact faces
players may grab. Generation preserves these faces exactly, adds bark detail
elsewhere, and grows thin decorative branches outside the hand-clearance zone.
Large unmarked faces remain ungrabbable. Thin branches never become grab targets.

## Start with the supplied demo

Open `polygon_output/polygon_roots_demo.blend`. Its two editable source meshes
are in `ROOT_BLOCKOUT_EDIT_THESE`. The rendered results and three GLB detail
levels are already generated in `polygon_output`.

In Blender's Scripting workspace, open `blender_polygon_roots.py` from this
folder and choose **Run Script**. The 3D View sidebar now has a **Root Kit** tab.
Run the script again after reopening Blender; the panel is session-local.

1. Select a source mesh and enter Edit Mode with face selection enabled.
2. Select broad forward-facing polygons. In **Root Kit**, choose **Mark Grab**.
   Marked source faces become cyan. **Clear Grab** removes the marking from the
   selected faces. This edits the active mesh.
3. Adjust the source vertices to design the climbing route. Planar convex quads,
   triangles and convex n-gons are supported. Split twisted quads into triangles.
4. Return to Object Mode and select the source meshes to generate together.
5. Set seed, thin-branch count, hand clearance and output directory; choose
   **Generate and Export Roots**. Each generation replaces this tool's generated
   root collections with the currently selected source meshes.

Use one Blender unit per metre, with Scene Units scale **1.0**. Source transforms
are baked into the export. Apply modifiers before marking polygons. Meshes must
be closed, have consistent outward winding, and contain planar convex faces.
The validator catches invalid indices, open edges, degenerate faces, inconsistent
winding and non-planar/concave polygons. It does not detect every possible
self-intersection or overlap between roots. Check the overlay and grab query
when authoring overlapping geometry.

Marked polygons must be large enough for the player hand footprint. The default
query uses a 5.5 cm radius, so leave at least 11 cm of usable width. Runtime
queries also exclude polygon boundaries by this radius; a colored face does
not make its narrow tips or edges valid. The demo has ten usable marked panels.

## What is generated

| File or collection | Purpose |
| --- | --- |
| `roots_LOD0.glb` | Detailed visible structure and decorative branches; embedded albedo and normal textures |
| `roots_LOD1.glb` | Same structural surfaces with simpler decorative tubes |
| `roots_LOD2.glb` | Same structural surfaces, no decorative branches |
| `roots_collision.glb` | Original closed blockouts for solid collision; not automatically grabbable |
| `roots_grab.glb` | Exact marked polygons, one named node per source face, for debug/custom grab queries |
| `roots.grab.json` | Authoritative polygon vertices, normals, source root IDs and face IDs |
| `blockout.json` | Editable source geometry and markings |
| `ROOTS_GRAB_DEBUG` | Hidden Blender collection showing the grab polygons |

The visible main roots retain the authored polygon silhouette. Grab faces are
not displaced. Other faces receive up to 6 mm of surface irregularity, with
edges pinned. Young/worn bark and slightly lower roughness identify grab panels;
ordinary bark covers the other surfaces. The cyan material is only a debug view.

Decoration is seeded independently, stays at most 3.2 cm in radius, and clears
every marked polygon by 12 cm by default. The generator checks whole triangle
bounds in both decorative LODs, so long triangles cannot cross a grab area
between their vertices. It may generate fewer twigs than requested if there is
insufficient space. Decorative branches have `grabbable: false` metadata and
are absent from the solid and grab exports.

All three LODs use identical structural geometry and the same grab manifest.
The seed cannot move grab surfaces. Face IDs are original polygon indices;
changing topology or polygon ordering requires re-exporting the whole asset.
Do not treat face IDs as permanent saved-game IDs after a topology edit.

## Three.js integration

Copy `three/polygon-roots.js` into your project and import it using your normal
Three.js dependency. Copy the five GLBs and `roots.grab.json` into the same
public asset directory. Serve them over HTTP, as with other web game assets.

```js
import { Vector3 } from 'three';
import { loadPolygonRoots } from './polygon-roots.js';

const roots = await loadPolygonRoots('/assets/climbing-roots');
scene.add(roots.group);
roots.setDebug(true); // Cyan overlay; turn off for the player view.

// Run when evaluating a grab request, using the player's hand world position.
const handWorld = handObject.getWorldPosition(new Vector3());
const grab = roots.findGrab(handWorld, {
  maxDistance: 0.25,
  handRadius: 0.055,
  obstacles: nearbyStaticLevelColliderMeshes,
});

if (grab) {
  // Feed these values to your engine's hand/body attachment system:
  // grab.point       exact contact in Three.js world space
  // grab.normal      outward world-space normal
  // grab.handCenter  sphere center outside the contact surface
  // grab.rootId      original mesh name
  // grab.sourceFace  original marked polygon index
  // grab.pointLocal / grab.normalLocal for attachments relative to roots.group
}

// When unloading this kit:
// roots.dispose();
```

The adapter uses Three.js's [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)
and [Triangle](https://threejs.org/docs/pages/Triangle.html) geometry operations.
It has been tested against Three.js 0.180.0. It provides grab candidates;
it does not implement your engine's character attachment, climbing animation,
body collision, input handling, or physics constraints.

The query rejects back-side approaches, excess reach, hand footprints outside
the original polygon, occupied hand volumes and approaches blocked by another
triangle. Ray checks are two-sided. Supply the nearby level's static closed
collider meshes through `obstacles`; exported root collisions alone cannot know
about your level walls. The hand-volume check also rejects a hand wholly inside
a supplied closed collider. Do not use open decoration sheets as closed solid
obstacles. The root kit's own decorative meshes are handled as surfaces.

For your engine's physics or swept-hand collision tests, pass synchronous
callbacks `canPlaceHand(center, radius, grab)` and
`isPathClear(from, to, radius, grab)`, returning false to reject a candidate.
The built-in path check is a ray, not a swept sphere. These callbacks are where
you account for the full hand motion and other game-specific constraints.

Root world transforms, including nonuniform positive scale, are supported.
Mirrored/zero transforms are rejected. Keep the root children static relative
to their group; call `roots.refreshCollision()` after manually changing child
geometry/transforms. Skinned and instanced obstacle meshes require your physics
callbacks. Hold queries should use `pointLocal` transformed by the current group
matrix when the root group moves.

This reference adapter performs triangle checks for correctness. Query on grab
attempts or at a modest interaction rate, and pass only nearby colliders. For
large levels, replace the obstacle callbacks with your engine's spatial index
and physics queries. LOD distances default to 0, 12 and 25 metres.

### Coordinates and metadata

The JSON source and grab manifest are in metres with **Z up**. Blender exports
the GLBs as **Y up**. The adapter converts JSON coordinates once:
`(x, y, z) -> (x, z, -y)`. Do not rotate the exported roots a second time.

GLB node extras identify `root_role` (`visual`, `decoration`, `collision`, or
`grab`), `root_id`, and, where appropriate, `source_face`/`grabbable`. Three.js
exposes these on `Object3D.userData`. Blender also stores Boolean face attribute
`grabbable` and integer face attribute `source_face` on the generated structures.
Gameplay should use the manifest or grab nodes, not visual-mesh face indices:
the GLB exporter may split or reorder triangles for materials.

## Regenerating without the panel

Run the example, including GLBs, images and a packed Blender file:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python .\build_polygon_demo.py
```

Export your own polygon JSON:

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --python .\blender_polygon_roots.py -- --input .\my_blockout.json --out .\my_roots --seed 1234
```

Use `polygon_output/blockout.json` as a concrete input example. Its schema is:
`{version: 1, units: "meters", up_axis: "Z", roots: [{id, vertices, faces, grab_faces}]}`.
Vertices are `[x,y,z]`, faces are ordered vertex-index lists, and `grab_faces`
contains zero-based face indices. Every root requires this list, even if empty.

`python polygon_roots.py` generates the example JSON and manifest only; Blender
handles textured GLB export. The new workflow uses NumPy and Blender and does
not require the old script's trimesh dependency.

## Verification

```powershell
python .\test_polygon_roots.py
npm install --prefix .\three --ignore-scripts
node --test .\three\test-polygon-roots.mjs
```

The tests cover exact polygon alignment, deterministic generation, safe branch
clearance in each LOD, source validation, front/back/edge/reach behavior,
occlusion, world transforms, and the actual GLBs loaded by Three.js. Node tests
strip texture references only for image-free parsing; embedded texture metadata
is checked, and the full materials are rendered by Blender in the previews.
