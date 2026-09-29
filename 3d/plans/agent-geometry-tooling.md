# Plan: tools for turning a reference image into accurate geometry

This plan comes out of one long agent session (2026-09-28/29) that turned `backdrop.png`, a painted misty cave, into scene `8h1SI1O4Hqeg4B9ZlU-gRg`: 20 objects whose perspective silhouettes match the painting on about 98.5% of pixels.
The result was good, but most of the effort went into rebuilding, in throwaway Python scripts, things that belong in the studio.
Those scripts were lost when the session's scratchpad was cleared, and had to be rewritten from the live scene.
Each section below says what hurt, what to build, and how it fits the code as it is now (after `f522917 use meters as unit`).

Read `3d/CLAUDE.md` first.
The conventions apply throughout: a new capability is a command in `core/commands.ts`, an op in `core/ops.ts`, a tool in `api/tools.ts` and a line in `llms.txt`; the schema changes first, then `types.ts`.

## The verdict

Build it in this order; each phase is useful on its own and the later ones lean on the earlier ones.

1. **Exact solids.** Replace the sampled reconstruction with exact polyhedral intersection, and move ray casting and an object-ID rasteriser into `core/` so the server can use them without Chromium.
2. **Traces and comparison.** Let an object carry its outline as traced in the perspective reference, and have `validate` and a `compare_to_reference` tool score every object against it; add an object-ID render and a silhouette-only outline mode.
3. **Fitting and safe editing.** A `fit_front` tool that solves the front outline from a trace plus designed top and side views, a `set_outlines` op that replaces all three views at once, and `baseRevision` on every edit.
4. **Measuring.** `raycast` and `measure` tools, and lens shift on the camera.
5. **Objects in parts.** An object may be a union of parts.
6. **Help with the reference.** Depth estimation and click-to-segment on the reference image.
   This needs a decision on hosting before it starts.

Phases 1 and 2 are the foundation: without exact solids and a cheap way to see which object covers which pixel, every later tool inherits the sampling error and the Chromium round trip.
Phase 3 is the one that removes most of the agent's work.

## Phase 1: exact solids, and geometry the server can use directly

### Why

`core/mesher.ts` samples each object on a `resolution`³ grid (40 by default, 72 at most) over the object's own bounding box and extracts a surface with marching tetrahedra.
In the session this caused three separate problems:

- **Stair-stepped edges on large objects.** The ceiling spans about 17 m across, so at resolution 40 one grid cell was over 0.4 m wide and its lower edge came out as a staircase in the perspective view.
  The fix was to split it into three objects, which drew seam lines in the outline overlay, and then to make it one shallow object instead.
  None of that was about the scene; it was about the grid.
- **Silhouettes that did not match the outlines.** Corners are cut by up to a cell, so the rendered silhouette differs from what the three outlines define.
  Checking what the renderer would actually draw meant importing `mesher.ts` into a Bun script and rasterising its triangles by hand.
- **Slow renders.** At resolution 72 with about 20 objects, one perspective render took about 45 s, most of it meshing inside headless Chromium.
  Verification rounds were limited by this.

Every object is an intersection of three extruded simple polygons, which is an exact polyhedron: no sampling is needed at all.

### What

- **Exact reconstruction.** Build each solid as the intersection of three prisms, each an outline extruded along its view's axis across the object's box, with [manifold-3d](https://github.com/elalish/manifold) (WASM; `CrossSection` from the ring, `extrude`, rotate onto the view's axis, `intersect`).
  The result is exact, watertight, and fast (milliseconds per object).
- **Coverage from the solid.** The `low-coverage` check becomes exact: project the solid onto each view plane (`Manifold.project()` after rotating the view onto XY) and compare its area with the outline's.
- **Drop the resolution setting.** `reconstruction.resolution` and `meshCache` have no purpose once meshing is exact and instant.
  Remove them from the schema (the project does not migrate old documents).
- **Sharp creases.** With exact meshes, `renderer.ts` can draw creases in the outline pass (it skips them today because the sampled meshes bevel every edge).
- **Core geometry for the server.** Move the ray casting now in `perspective/renderer.ts` (`pick`, `rayBox`, `rayTriangle`) into `core/raycast.ts`, and add `core/raster.ts`: a plain TypeScript triangle rasteriser with a depth buffer that renders a camera frame to an object-index buffer and a depth buffer.
  Both run in Bun and in the browser.

### How

- `core/mesher.ts` becomes a thin wrapper around manifold with the same `Mesh` output (positions, normals, indices, `meta.coverage`), so `meshes.ts`, the worker and the renderer keep working.
  Bump `MESH_VERSION`.
- The single-file build must inline manifold's WASM.
  Check this first with `vite-plugin-singlefile`: if the package's loader cannot take inlined bytes, load it from a base64 constant through `WebAssembly.instantiate`.
  This is the one real risk in the phase.
- `api/geometry.ts` stops needing a worker for meshing speed; keep the worker only if manifold blocks for too long on large scenes.
- `core/raster.ts`: project vertices with `cameraMatrices`, rasterise with edge functions, keep the nearest depth per pixel.
  At 1695 × 928 and a few thousand triangles per object, this is well under a second in Bun.

### Tests

- Core unit tests: a box from three rectangles has exactly the box's volume and faces; a solid from a triangle in front and circles in top and side has the analytic volume within 1e-6.
- `low-coverage` fires on a known clipped case and not on a consistent one.
- `core/raster.ts` against the WebGL renderer: render the same scene both ways and require the object-index buffers to agree on at least 99.9% of pixels (e2e test).

### Done when

The ceiling from the session, as one object 17 m wide, renders with a straight-edged lower silhouette; a perspective render of that scene takes a few seconds; `resolution` is gone.

## Phase 2: traces, comparison, and pictures made for checking

### Why

The whole method in the session was: trace each rock's silhouette in the painting, build geometry, and check that the rendered silhouette lands on the trace.
The studio knew nothing about the traces, so all of that happened outside it:

- **The traces lived in a Python file** in a scratchpad and were lost with it.
  The scene held only the geometry, not what the geometry was fitted to.
- **Scoring meant classifying shaded pixels by colour.** A render lights each object, so an underside comes out at 34% brightness and a side face darker still; I classified pixels by chromaticity against the palette, which is fragile with dark faces, similar hues and anti-aliasing.
- **The outline overlay drew internal contours.** Where part of an object hides another part of itself, the overlay draws a spike, which reads as an error and is not one.
- **Checking alignment meant changing the scene.** Seeing outlines over an opaque reference required setting the reference's opacity to 1 in the scene itself, which changed a setting Tris had chosen.
- **Occlusion mistakes were invisible until measured.** Twice an object ended up in front of one it should be behind (the right platform in front of the cliff; the centre pillar over the tall pillar's edge).
  Nothing in `validate` could say so.

### What

- **Traces on objects.** A new optional object field:

  ```json
  "trace": { "points": [[1022, 678], [1060, 668], [1200, 664]], "hidden": [[3, 7]] }
  ```

  `points` is the object's silhouette in the perspective reference image's own pixels (origin top-left, v down), as if nothing stood in front of it; parts may continue off the image.
  Storing image pixels, not frame pixels, keeps a trace valid when the reference is moved, scaled or rotated (`overlayGeometry` maps between them).
  `hidden` optionally marks runs of edges (vertex index ranges) that are guessed because something covers them in the image; they are drawn dashed and excluded from the missing-pixel count.
  The editor draws the trace in the perspective view in the object's colour, dashed, and lets a person edit its points like an outline.
- **Order hints.** An optional `inFrontOf: ["id", ...]` on an object states intent where traces overlap.
- **Comparison.** A `compare_to_reference` tool, and the same checks in `validate` when traces exist.
  Using `core/raster.ts` (no Chromium), for each object with a trace it reports:
  - `spill`: pixels where the object is visible but outside its trace (always wrong, whatever is in front);
  - `missing`: pixels inside its trace, outside hidden runs, where the visible thing is the background or an object whose own trace does not contain the pixel;
  - `iou` of the visible region against the trace minus the regions nearer traced objects cover;
  - `order`: pixels where an `inFrontOf` hint is contradicted.

  Issues: `trace-spill` and `trace-missing` (warnings with a pixel count and bounding box, above small thresholds), `occlusion-order` (warning).
  The tool can also return a diff PNG: correct in grey, spill in red, missing in blue.
- **Pictures made for checking.** New `render` options for the perspective view:
  - `mode: "ids"`: flat, unlit colours, one per object, no anti-aliasing, and a legend `{ "#rrggbb": "objectId" }`; or `mode: "depth"` (16-bit grey, near is white).
  - `outlines: "silhouette"`: only the outer silhouette of each object, no self-occlusion contours.
  - `referenceOpacity`: an override for this picture only, leaving the scene alone.

### How

- Schema: `trace` and `inFrontOf` on objects; `types.ts`, `document.ts` round trip; `commands.ts`/`ops.ts` `setTrace`; tool `set_trace`.
- `core/compare.ts` builds on `core/raster.ts` from phase 1; `validate` calls it when any object has a trace and the perspective reference has an image.
- The `ids` and `depth` modes and the `silhouette` outline mode can be drawn by `core/raster.ts` directly (faster, and no Chromium) and encoded to PNG on the server; the shaded mode stays in the editor.
- The WebGL outline pass already renders per-pixel object ids with depth: `silhouette` there means skipping edges where the object on both sides is the same.

### Tests

- A scene with one box and its exact projection as the trace: IoU 1, no issues.
- Shift the trace by 10 px: `trace-spill` and `trace-missing` fire with the expected counts.
- Two overlapping objects with a contradicted `inFrontOf`: `occlusion-order` fires.
- `mode: "ids"` legend round trip: every legend colour appears, and no other colour does.

## Phase 3: fitting, and editing that cannot lose work

### Why

The core problem is an inverse projection: given a silhouette traced in the painting, a top view and a side view designed from understanding the scene, find the front outline whose perspective silhouette matches.
I wrote a fitter for it (`fit.py`), then a rule that let one rock rest on another (`rest_on`), then logic to trim the top and side views to the solid they actually make.
All of it ran outside the studio and vanished with the scratchpad.
Any agent doing this work needs the same thing, and getting it right took several rounds:

- points must be tested at every depth the top and side views allow, not just the front face;
- off the image, points must still stay inside the (extended) trace, or accepted points surround a rejected region, hole filling puts it back, and the object spills;
- adjacent raster cells must be unioned on an integer grid, or floating-point gaps split the region into columns.

Editing had two hazards:

- **Replacing outlines one view at a time is unsafe.** `set_outline` rescales the other two views to the new box, so setting three new outlines in three calls passes through two distorted states and three undo steps.
  I used `load_document` to replace whole objects instead.
- **`load_document` replaces everything.** Twice the scene had moved on between my turns (revision 11 to 20, 53 to 75) because Tris was working in it.
  I undid, read, and redid to see what had changed before loading, and the first time I overwrote Tris's reference opacity and label settings.
  `PUT /scenes/{id}` already takes `baseRevision` and answers 409; the tools do not.

### What

- **`fit_front`**: `{ sceneId, id, top?, side?, restOn?: [ids], trim?: true, maxPoints?: 160 }`.
  It uses the object's `trace`, its current (or the given) top and side outlines, and the camera, and returns the new front outline, the trimmed top and side (the solid's own projections, when `trim`), and the phase 2 comparison for the object.
  It applies them as one undo step unless `dryRun: true`.
  The algorithm, as proven in the session:
  1. Rasterise the front plane over the top view's x range and the side view's z range (cell size from a budget of about 700k cells).
  2. For each cell, sample depth across the object's y range (about 96 samples); a sample is valid where the top view contains (x, y) and the side view contains (y, z).
  3. Accept the cell when it has at least one valid sample and every valid sample projects inside the trace.
     On the image, test against the traced raster; off the image, against the trace polygon itself.
     With `restOn`, also reject a cell if any valid sample lies inside one of those objects' solids.
  4. Keep the largest 4-connected component, fill its holes, turn it into a polygon by unioning cell squares on the integer grid, and simplify with `simplifyRing`.
  5. With `trim`, project the solid onto the top and side planes the same way, and stretch shared axes so the three views agree exactly.
- **`suggest_views`** (small, optional): from the trace and a depth range, plain prisms, as a starting point that `fit_front` can refine.
- **`set_outlines`**: all three outlines of an object in one command and one undo step, with the box taken from the three together.
- **`upsert_objects`**: add or replace objects by id, with every property, in one step; the natural tool for "change these five objects, keep the rest".
- **`baseRevision` on every mutating tool**, `load_document` included: refused with `revision-conflict` when the scene has moved on.
- **`get_changes { since }`**: the revisions since then, each with the objects added, removed or changed (and which fields), and scene, camera, reference and display changes.
  The history in `scenes.ts` already holds the states to diff.

### How

- `core/fit.ts`, pure TypeScript on typed arrays; it needs point-in-polygon (in `ring.ts` or next to the mesher's `sdf`), connected components and hole filling (a small flood fill), and a raster-to-ring step.
  Run it in the geometry worker on the server.
- `restOn` solids are tested with `core/raycast.ts` point-in-solid (or directly with the three outlines, which is exact and cheaper).
- `baseRevision` goes in the tool wrapper in `api/tools.ts`, once, not in each tool.
- `get_changes` diffs consecutive history states by object id with a field-level compare.

### Tests

- `fit_front` on a box, traced from its own exact render, returns the box's front within one cell.
- A trace with an off-image part does not produce a spilling object (the regression from the session).
- `restOn`: a block fitted onto a cap has its underside within one cell of the cap's top and no volume inside the cap.
- `baseRevision` stale: `revision-conflict`, nothing changed; `get_changes` lists an edit made in between.

## Phase 4: measuring the picture

### Why

- **Scale.** The metres change asks for a scale from things of known size.
  In the painting those were plants and mushrooms.
  Their height in metres depends on their depth, which I worked out by hand from the height of the platform each stands on.
- **Depth checks.** Many questions were "what is at this pixel, and how far away": which object covers a spot, how deep a surface is, whether a rock touches the cap.
  Each took a render and some arithmetic.
- **The horizon.** The painting's horizon is not at mid-frame (tops of platforms above the middle are still visible), but a level camera puts it there, and tilting the camera leans every vertical edge.
  Lens shift is how photographers and painters handle this.

### What

- **`raycast { points, space: "frame" | "reference" }`**: for each pixel, the object hit, the world point (metres), the surface normal and the distance.
- **`measure { from, to, space, at }`**: the length in metres between two pixels.
  `at` is an object id (measure on that object's surface depth at `from`), a depth in metres, or `"surface"` (each end at the depth of whatever it hits).
  This is exactly "a fern 160 px tall standing on the lower-left platform".
- **Lens shift**: `camera.shift: { x, y }` as fractions of the frame, an off-axis projection.
  Verticals stay vertical while the horizon moves.

### How

- `raycast` and `measure` use `core/raycast.ts` from phase 1 and `overlayGeometry` for reference-space points.
- Shift changes the projection matrix in `camera.ts` (the x and y offsets of the frustum) and the ray set-up in `raycast.ts` and `raster.ts`; add it to the camera panel and to `set_camera`.

### Tests

- Raycast at the frame centre of a camera looking at a wall 10 m away returns 10 m.
- `measure` of a 2 m box edge from its render returns 2 m within a pixel's worth.
- With shift, a vertical box edge projects to a vertical line and the horizon sits at the shifted row.

## Phase 5: objects in parts

### Why

A single object is three outlines, so anything whose shape varies in more than one direction at once must be split, and splitting has costs:

- the left cave wall and its upper platform had to be two objects sharing one trace;
- the ceiling split into three pieces drew seam lines between them;
- when Tris asked for the stepped rocks to be part of the right platform, their plan and profile had to be merged by hand into one union, losing the steps' own stepped profile.

### What

An object has either `outlines` or `parts: [{ id?, outlines }]`; the solid is the union of the parts' solids.
Views draw each part's outline and the union's silhouette; the object is selected, coloured, traced and fitted as one, with `fit_front { part }` for a single part.

### How

Manifold `union` of the parts' intersections; everything that reads `e.outlines` gets a helper that yields the object's parts (a plain object is one part).
This touches the ortho views and outline editing the most: a part is selected inside its object.

## Phase 6: help with the reference image

### Why

Depth was the part I had to invent most: which rock is in front of which, how deep each platform is.
The painting's occlusions settle the order only where things overlap.
Tracing, by eye from gridded crops, took many rounds and still missed some edges, for example where the ceiling meets the right wall.

### What

- **`estimate_depth { image }`**: a relative depth map of the reference, from a monocular depth model, stored as an image asset and drawable as an overlay.
  `fit_front` and `suggest_views` could use it to choose depth ranges, and `compare_to_reference` to flag order disagreements.
- **`segment { image, points | box }`**: a polygon in image pixels around the region at the given points, from a promptable segmentation model, ready to become a `trace`.

### Decision needed first

Both need model weights (roughly 100 to 400 MB each, for example Depth Anything V2 small and a small SAM variant as ONNX).
The choices are to run them in the `3d` container with `onnxruntime-node` (simplest to deploy, adds memory and CPU on the host, and cold starts), on a separate worker, or through a hosted API (per-call cost, and the image leaves the server).
This phase should not start until Tris picks one.

## Documentation

Each phase ends with `llms.txt` updated: the tools, and the "Workflow for turning an image into a scene" rewritten around the new loop:

1. Set the camera and the scale.
2. Trace each object.
3. Design its top and side views.
4. `fit_front`.
5. `compare_to_reference`.
6. Adjust and repeat.

The session's lessons go in with it: trace hidden edges on under whatever is in front; walls recede along camera rays; put objects meant to be in front nearer at every pixel their traces share.
