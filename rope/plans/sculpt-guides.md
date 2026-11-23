# Sculpted guides (replacing the orthographic route)

Requested by Tris on 2026-11-23.

## Status (2026-11-23)

All six phases are built; how it works is [docs/formations.md "Sculpting"](../docs/formations.md#sculpting), and nothing of it has been played yet.
Where the build left this plan, and why:

- **No three-mesh-bvh.**
  Dyntopo adds triangles on every dab, which a BVH can only take by a rebuild; the working mesh keeps a multi-level hash grid of triangles instead (`src/formation/sculptGrid.ts`).
- **The migration replaces each retired leaf, not each guide.**
  "Every solid guide in every level to one mesh leaf" would have changed every solid guide's hash and staled its rock; meshing only the retired leaves (pose kept) leaves every other guide as it was.
  One guide in the tree held one (`ball.json` body 128, never generated).
  Run `bun run guides:migrate` with the editor closed.
- **The Dyntopo test's bar.**
  "Every edge within [4/5, 4/3]" is not what the algorithm reaches: those are when it acts (an edge just over 4/3 splits into halves of 2/3, which a collapse may not undo).
  The test holds the upper bound, the topology and a settled region instead (`scripts/test-sculpt.ts`).
- **Remesh's sign is the winding number, not parity**: a fold reads as the union of its overlaps.
- **Two hand-over fixes the plan did not foresee**: pinches opened past Blender's weld, and samples kept off zero in the remesh (docs/formations.md).
- **Ctrl+Tab** is kept by Chrome in a normal window; the Sculpt buttons are the way in there.
- **The open question** (is `solidfit.py`'s projection along the start camera's rays part of the route?) was taken as the plan assumed: no, it stays.

Below is the plan as written.

## The request, as asked

- Remove the orthogonal projection geometry generation route.
- Move to a sculpting-based approach: the equivalent of Blender's **Draw** and **Grab** sculpt brushes, plus the equivalent of its **dynamic remeshing** (Dyntopo).
- A **Cut** tool: draw a polygon on the current view plane and cut away every part of the guide that is not inside that area.
  It must work in both the perspective and the orthographic view.
- Shortcuts: **G** grab, **D** draw, **C** cut.
- "Holding ctrl while using grab should smooth the sculpture, and holding ctrl while drawing should remove geometry from the structure - like how blender works."

## Where things stand (read first)

- Solid guides are a CSG tree in the level (`FormationData.guide = { kind: "solid", tree }`, `SolidNode` in `src/level/levelFormat.ts`), leaves `box`, `cylinder`, `ellipsoid`, `hull`, `extrude` (an outline pushed through a depth) and `mesh` (a closed mesh in the store by content hash).
  Since 2026-11-23 the editor makes only boxes and cylinders (`newPrimitive`, `SHAPE_KINDS`) plus imported meshes; the other leaves still load, draw and generate, and `levels/ball.json` holds two ellipsoids (and 24 meshes, 2 boxes).
- `src/formation/solid.ts` meshes the tree with manifold-3d in the editor (`solidMesh`) and hands the generator the guide as one mesh in Blender's frame (`solidWorkerRecipe`); Blender never sees the tree, so a guide that is a mesh needs no generator change.
- The editor draws and picks guides in `src/editor/solidGuides.ts` (`SolidGuideView`), edits the tree as a flat Add/Subtract/Intersect stack (`src/formation/solidStack.ts`, the Formation panel), and since 2026-11-23 has, in the Formations workspace (`src/editor/workspaces.ts`): Primitives (a new guide per shape), Union/Subtract/Intersect of whole guides (`carryTree`, `frameBetween`), **G**/**R**/**S** object grab, rotate and scale (`startTransform` in editor.ts, driven through the gizmo's handlers; S on a guide's body scales the whole guide evenly, `scaleTree`), the view cube with Persp/Ortho (`src/editor/viewCube.ts`), and Tab swapping the selection between guide and rock.
- Imported meshes are welded and stored as `StoredMesh` JSON (`{ verts, faces }`) under `public/generated/meshes/` through `MESHES_API` (`src/formation/store.ts`, `importMesh` in `formationPanel.ts`), loaded by `requestMeshes` in `solidGuides.ts`, published with the store.
- The formation hash is the recipe's content, guide included, so any change to a guide marks its rock stale; Tris generates.

## What "the orthogonal projection route" is, and what goes

The route is authoring a solid as outlines seen head on, from the top and from the side, intersected - the Orthographic Studio's method.
In this tree it is:

1. `threeOutlinePreset` and the panel's "+ Three outlines" button - **removed 2026-11-23**, with the "+ Outline", "+ Hull" and "+ Ellipsoid" offers (Tris: "only support box and cylinder as primitives for now").
2. The `extrude` and `hull` leaves' point editing (the panel's point list and the gizmo's in-plane point drags, `pointsOf`/`insertPoint`/`removePoint`), which now only serves leaves made before that: goes with the migration in phase 1.
3. `scripts/ortho-solids.ts` and the seeding of a level's backdrop from a studio scene (docs/blender-backdrop.md, "the start camera", "the lens mapping").
4. `solid.ts` importing manifold-3d through `../../../3d/orthographic/src/core/manifold`: keep manifold-3d, depend on it directly from rope's own `package.json`.
5. The `ellipsoid`, `hull` and `extrude` leaves themselves, once the migration has meshed every one in every level into a mesh leaf (ball.json's two ellipsoids among them).

Open question for Tris: `solidfit.py` keeps "the silhouette from the start camera exactly the guide's; only the hidden back grows" - a projection along camera rays in the generator.
This plan assumes that is NOT part of the route to remove (it is how a rock is fitted, not how a guide is authored); confirm.

Retired forms follow the repo rule (rope/CLAUDE.md): every retired form is folded in on load, never left half supported.
Here the fold cannot live in `normalizeLevelData` (meshing needs the manifold WASM, which is async and must not reach the sim path), so it is a one-off migration script (phase 1) plus a loader that refuses the retired leaves with a message naming the script.

## Design

### A sculpted guide is a mesh leaf

Sculpting edits a mesh, not a tree.
A guide being sculpted is (or first becomes) a single `mesh` leaf: `{ op: "union", of: [{ prim: "mesh", file }] }` with the pose kept on the leaf.

- **Apply** (Blender's "apply the modifiers"): a button in the Formation section, and automatic on entering Sculpt with a tree that is more than one mesh leaf, meshes the whole stack (`solidMesh`) into one stored mesh and replaces the tree with it.
  It is destructive and one undo step, as Union/Subtract/Intersect already are.
  The box and cylinder primitives stay as starting shapes; adding a shape to a sculpted guide's stack keeps working (the stack holds mesh leaves like any other) and Apply folds it in.
- **Store format**: sculpted meshes are far denser than imported ones (50k to 300k triangles), and `StoredMesh` JSON costs ~60 bytes a vertex.
  Add a binary form beside it, named by content hash the same way: a little-endian header (magic, version, vertex count, triangle count), `Float32` positions, `Uint32` indices; `.bin` under `meshes/`, read by `requestMeshes` by extension.
  JSON stays readable for the meshes already stored.
- **Resolution for the generator**: the generators were tuned on coarse guides.
  `solidWorkerRecipe` decimates a dense guide before handing it over (manifold-3d's `simplify(tolerance)`, tolerance a fraction of the rock's size, ~1 cm), so a sculpt's density never changes how long a generate takes, only its shape.
  Measure a Boulder and a Cliff generate on a 200k-triangle sculpt before and after; write the numbers into docs/formations.md.

### Sculpt mode

- Formations only, on one selected solid guide.
  Entered by a **Sculpt** button in the dock's "Selected" group and by **Ctrl+Tab** (Blender's mode switch; plain Tab is already guide/rock).
  Leaving: the same, Esc with no stroke in progress, selecting anything else, or leaving the workspace.
- In Sculpt mode the guide is drawn opaque, lit, matcap-like grey with the guide colour as a tint (the translucent shell is unreadable to sculpt on), its rock hidden (the per-formation view goes to Guide), the gizmo put away, the overlay's other marks hidden.
- Keys in Sculpt mode: **D** Draw, **G** Grab, **C** Cut, **F** brush radius (drag, click to set), **Shift+F** strength, **Ctrl+Z** undoes a stroke.
- Modifiers, held during a stroke (Tris, 2026-11-23, "like how blender works"):
  - **Ctrl with Draw removes**: the stroke digs into the surface instead of building it up (Blender's Draw with Ctrl, its "Subtract" direction).
  - **Ctrl with Grab smooths**: while Ctrl is held the Grab stroke becomes Smooth (each vertex toward its neighbours' mean under the brush), released it grabs again.
    Note for the builder: in Blender, Ctrl on Grab does nothing and Shift is Smooth on every brush; Tris asked for Ctrl here, so Ctrl is the smooth key on Grab, and **Shift** stays Smooth on every brush as Blender has it.
  - The modifier is read per dab (Draw) or per pointer move (Grab), so pressing or releasing it mid-stroke switches mid-stroke, as Blender does; each switch is still one stroke and one undo step.
- Outside Sculpt mode **G**, **R** and **S** stay the object transforms built on 2026-11-23, and F stays frame selection; C is only the Circle tool in the 2D workspace, so nothing collides.
- The brush cursor is a circle drawn on the surface under the pointer (oriented to the surface normal), its radius in screen pixels like Blender's default ("view" radius), shown on the dock with strength and falloff.
- Navigation keeps working mid-mode: middle drag orbits, the wheel dollies, the view cube swings.

### The working mesh

- Held in the editor for the length of the session as typed arrays plus an adjacency (half-edge) structure, in the guide leaf's own frame.
- Ray casts and brush-sphere queries through a BVH: **three-mesh-bvh** (MIT, the standard three.js answer; `shapecast` for the sphere, `raycast` for the hit, `refit` after each dab instead of a rebuild).
- Drawn as one `THREE.Mesh` whose position and normal attributes are updated in place for the touched vertices (`updateRanges`), normals recomputed for the touched region only.
- Never touches the model mid-stroke.
  A stroke's end pushes a sculpt undo step (the touched vertices' before-positions, or for a remeshing stroke the whole region's topology) onto a sculpt-local stack, like Blender's sculpt undo.
- **Commit**: leaving Sculpt mode (and after 2 s idle, so a reload loses little) writes the mesh to the store and sets the leaf's `file` to its hash, one editor undo step for the whole session.
  The rock is then stale like any guide edit.

### Draw

Blender's Draw: each dab moves the vertices within the radius along the brush's area normal (the average normal of the vertices under it, so a dab across an edge does not tear the edge apart), by strength times falloff (smoothstep of distance / radius) times the radius, dabs spaced along the stroke at 10% of the radius.
**Ctrl removes** (the same displacement, inward: the area normal negated); **Shift** is Smooth (each vertex toward its neighbours' mean, the same falloff).
With Dyntopo on, removing thins the surface by real displacement, not by deleting faces: Remesh is what closes a dig that went through.

### Grab

Blender's Grab: at the press, the vertices within the radius of the hit are taken with their falloff weights; while dragging, each moves by weight times the pointer's displacement in the plane facing the camera through the hit point (the plane **G** object grab already uses).
No dabs: one deformation per pointer move, from the stroke's start positions, so it never accumulates error.
**Ctrl smooths** (Tris's call, above): while held, the stroke stops moving vertices with the pointer and smooths those under the brush instead, dab by dab along the pointer's path like Draw; released, Grab takes up the vertices under the brush where it now is, from their current positions.

### Dynamic remeshing (Dyntopo)

Blender's Dyntopo, constant-detail mode first: a detail size (world metres, a dock field, default 2 cm) and, in the brush region of each dab:

1. Split every edge longer than 4/3 of the detail size at its midpoint (longest first).
2. Collapse every edge shorter than 4/5 of it, when the collapse passes the link condition (keeps the mesh manifold) and does not flip a face's normal.
3. Optionally relax valence by edge flips.

This is the textbook isotropic remesh (Botsch & Kobbelt 2004) restricted to the brush, which is what Dyntopo is.
Draw with Dyntopo on builds detail where it is used; Grab pulls long faces that get split as they stretch.
A whole-mesh **Remesh** button (Blender's voxel remesh, Ctrl+R) for repair after heavy grabbing: manifold-3d's `levelSet` over the mesh's signed distance (closest point by the BVH, sign by ray parity) at the detail size.

### Cut

Draw a polygon on the screen - clicks, Enter or the first point closes it, Esc drops it, the same gesture as the 2D +Poly tool - and keep only what lies inside it as seen from the camera:

- **Orthographic**: the kept region is the polygon swept along the view direction, a prism.
  Build it as a `CrossSection` of the polygon in the camera's x/y, extruded along the camera's -z from in front of the guide's bounds to behind them, transformed by the camera's world matrix.
- **Perspective**: the kept region is the cone from the eye through the polygon.
  The same construction with the cross-section placed on a plane at a near distance (points scaled to that plane, origin on the camera axis) and extruded to a far distance with `scaleTop = far / near`: a linear extrusion scaled about the axis is exactly the projective frustum through the polygon.
- The guide's mesh is intersected with that solid in manifold-3d (`Manifold.intersection`), one undo step.
  **Alt** held when closing subtracts instead (cut the inside away), which is the obvious companion and free.
- A non-simple polygon (it crosses itself) is refused while being drawn, in the warning colour, as +Poly does.

Cut works on a guide whether or not Sculpt mode is on (it is a whole-guide edit, like Union); in Sculpt mode it acts on the working mesh and lands on the sculpt undo stack.

### Validity

The generator needs a closed, manifold, non-self-intersecting guide.
Draw and Grab keep the topology but can fold a surface through itself; Dyntopo keeps it manifold by construction.
At commit, `new manifold.Manifold(mesh)` validates; a mesh it refuses is committed through Remesh, with a notice saying so.
A self-intersection check on commit (BVH triangle-triangle) decides whether to remesh.

## Phases

Each phase ends checked in the headless editor (CDP, a scratch level, never Tris's open level; docs/editor.md, memory `reference_editor_cdp_harness`) and with its docs written.

1. **Mesh leaves first.** Binary store format, Apply, manifold-3d as a direct dependency, the migration script (every solid guide in every level to one mesh leaf, hashes recorded), the loader refusing the retired leaves, the orthographic route removed (above, after Tris answers the two questions). `cli render3d` and scripts/test-formations.ts green apart from the known reds.
2. **Sculpt mode shell.** Enter/leave, the opaque draw, the brush cursor, the working mesh with BVH, commit and sculpt undo; Smooth only.
3. **Draw and Grab** with radius, strength, falloff, F/Shift+F, Ctrl (Draw removes, Grab smooths) and Shift (smooth on either).
4. **Dyntopo** (constant detail) and **Remesh**.
5. **Cut**, both lenses, Alt to subtract.
6. **Decimation for the generator**, measured.

## Tests

Per rope/CLAUDE.md "Validate the behaviour before writing the cases": how a brush FEELS (falloff, strength, spacing) gets no regression cases until Tris has sculpted with it.
What is correctness gets cases from the start, in scripts/test-formations.ts or a new `sculpt` suite:

- The cut solid: a point projecting inside the polygon is kept and one outside is cut, in both lenses, including a point near the polygon's edge far from the camera (the perspective scale).
- Dyntopo: after a stroke every edge in the region is within [4/5, 4/3] of the detail size, the mesh is manifold (every edge has two faces) and no face flipped.
- Commit round trip: stored, loaded, meshed by `solidMesh`, the same vertices and faces.
- The migration: every migrated guide meshes to the same volume (manifold's `volume()` within 1e-6) as its tree did.

## Risks

- Frame rate on dense meshes in a dab with Dyntopo on; measure on a 300k-triangle guide on the 4070 (memory `reference_chrome_live_gpu_measure`) before tuning.
- Grab folding a surface through itself: Remesh is the repair, and the commit check is the guard.
- Store growth: a sculpt session commits once, not per stroke, and the store is content-addressed, so abandoned versions are what `cli assets` "no unreferenced files" already reports.
