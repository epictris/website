# The visuals workspace

Date: 2026-09-25.
Status: plan, implementation delegated to subagents on the `visuals-workspace` branch.

## Goal

A second workspace in `/editor` for dressing a level: a proper 3D environment that is navigated by orbiting, panning and dollying a free camera, in which everything the level holds can still be selected, moved, turned, sized and inspected, and in which two procedural pipelines are driven from the inspector:

- **Rocks**: the fork's boulder v5 generator (Python + headless Blender), which turns a collision outline into a fractured, bevelled, baked stone prop.
- **Mushrooms**: the fork's mushroom patch generator (a Blender Geometry Nodes group), which grows a patch of glowing mushrooms over a region of a model's surface that the author paints by clicking on the surface.

Both pipelines exist in `~/projects/karin_website` (branch `add-boulder-and-root-generation`).
They are ported, not reinvented, and their hard-coded constants become configuration parameters that are stored in the level file, shown in the inspector and sent to the generator.
The moss pipeline (`dirt_moss`) stays in the fork and is out of scope; it imports helpers from the boulder sources, so the boulder sources are copied with their module layout intact and are not refactored.

The first workspace the editor has today stays exactly as it is and is called the **Level** workspace from now on.

## What exists

Main already has most of the 3D plumbing (see `docs/editor.md`, `docs/render3d.md`):

- `Scene3D` drawn under the 2D overlay from one `Camera`; `syncCamera` in `render3d/space.ts` derives the three.js camera from the 2D camera, the level's lens and a `CameraOrbit` (Ctrl+middle drag).
- `Scene3D.pick` raycasts geometry objects; `unprojectToPlane` resolves everything else against the gameplay plane at any orbit.
- The transform gizmo (`editor/gizmo.ts`, three nested `TransformControls` on a proxy) works from any angle and writes the model through handlers.
- A turned view draws no 2D overlay, offers no plane handles, and forces the select tool.
- Meshes are placed by `mountVisual` (`render3d/bodyVisuals.ts`) through `loadMesh(key)`; `levelStoredFiles` lists a level's files for the preload list (node only, from `vite.config.ts`).
- The inspector is built from `numField`, `checkField`, `picker`, `addColorField` and readouts in `editor.ts`; there are no sliders.

The fork adds, all dev-server side:

- `src/server/boulderGenerator.ts`: `POST /api/boulders` runs `rockgen.py` and Blender, writes `public/generated-boulders/<uuid>/boulder.glb`, returns the key `boulder-v5:<uuid>:<bytes>`.
- `src/server/mushroomGenerator.ts`: `POST /api/mushrooms` runs Blender with `editor_patch.py`, key `mushroom-patch:<uuid>:<bytes>`.
- `src/editor/surfacePatch.ts`: the surface loop (`frameOf`, `collect`) and its in-scene draft view; `Scene3D.hitsAt`, `pickSurface`, `meshesOf`.
- `render3d/generatedBoulders.ts`, `generatedMushrooms.ts`: key resolvers consulted by `loadMesh` and `levelStoredFiles`.
- The generator sources under `asset-generators/boulders/stylised_rocks_v5/` and `asset-generators/mushrooms/`.

Two things about the fork are deliberately not carried over.
The generation parameters are not stored in the level (only in a sidecar next to the GLB, and the editor's inputs reset to their defaults), so a rock cannot be regenerated or compared.
And the keys are random UUIDs, so generating the same thing twice costs two Blender runs and leaves two files.

Blender 5.2 is at `~/.local/bin/blender` and the fork's `.venv` (numpy, shapely 2.1.2, scipy, Pillow, matplotlib) works on this machine.

## Decisions

1. **The generators stay Python + Blender behind the dev server.**
   Booleans, voxel remesh, decimation and a Cycles bake have no in-browser equivalent, and the look was approved as those tools produce it.
   The cost is an 8 to 60 s round trip per generation, which the workspace hides with asynchronous jobs, a placeholder while a job runs, a staleness badge, and a content-addressed cache so repeating a generation is free.
2. **Generation parameters are level content.**
   A generated geometry object carries a `generator` block: which generator, its version, the parameters that differ from the defaults, and for a mushroom patch the painted loop.
   The mesh key is derived from that content, so the file says what the mesh is and staleness is a comparison, not a sidecar lookup.
3. **One parameter schema per generator, read by TypeScript and Python alike.**
   `tools/blender/boulders/params.json` and `tools/blender/mushrooms/params.json` list every parameter with its type, default, range, step, unit, group and a one-line description.
   The inspector is generated from the schema, the server validates against it, and the Python reads the merged values from it.
   No constant is stated in two places.
4. **The workspace is a mode of the existing editor, not a second page.**
   The model, undo, autosave, clipboard, outliner, inspector, layers and tools are shared; the workspace changes how the view is driven, what is drawn for the overlay, and which tools are offered.
   New code goes in `src/editor/visuals/` and `src/server/generators/`; `editor.ts` gains a workspace switch and routing, nothing else that could live elsewhere.
5. **A free camera pose replaces the orbit as the source of the 3D camera in the workspace.**
   `syncCamera`'s arithmetic is factored into `poseFromCamera` (the 2D camera plus lens plus orbit, exactly as today, asserted to the bit by `cli render3d`) and `applyPose`; the workspace owns a `ViewPose` of its own whose target may leave the gameplay plane.
6. **The overlay moves into the scene.**
   The 2D overlay stays off in the workspace; a `Guides` group in the scene draws the gameplay plane grid, every collision outline, light icons and reach rings, the spawn, the selected polygon's vertex handles and tool drafts, all raycast-picked through `Scene3D.pick` with guide tags.
   Collision outlines draw with depth test off, so the collision stays readable through the geometry that dresses it, which is what the head-on overlay was for.
7. **Nothing here reaches the sim.** Generated meshes are geometry objects; collision stays the authored outline.
   `replay selftest`, the regression corpus and every level's saved bytes are unchanged by this work unless a level is edited.
8. **Generated files are dev-only for now**, under `public/generated/<generator>/<hash>/`, gitignored, copied to `dist` by the build as in the fork.
   Publishing them to the release store is a follow-up (see "Follow-ups"); the plan keeps the key and the file layout compatible with it.

## The level format

`GeometryObjectData` gains one optional field:

```ts
generator?: {
  kind: "boulder" | "mushrooms";
  version: number;                 // the generator's schema version, from params.json
  params?: Record<string, number | boolean | string>;   // only values that differ from the defaults
  patch?: {                        // mushrooms only
    host: number;                  // index of the host geometry object within this body's objects
    points: { x: number; y: number; z: number }[];   // the painted loop, body-local, disk px / model metres
  };
};
```

- Lengths inside `params` are scaled between px and metres by `scaleObject` using the schema's `unit` (`m` scales, everything else does not); `patch.points` scale like any position.
- `EdVisual` gains `generator?: EdGenerator` with the same shape but in metres and with `patch.host` resolved to an item id (`hostId`), written back as an index by `toLevelData` and re-resolved by `fromLevelData`.
  A host index that names no geometry object loads as a patch with no host, shown as a warning in the panel, and the loop is kept.
- `mesh` stays the key of the generated file: `boulder:<hash>` or `mushrooms:<hash>`, where `<hash>` is `generatedKey(kind, version, outline | patch, params)`, a 64-bit hash of a canonical string (sorted keys, numbers to 4 decimals of a metre, outline as body-local metres y up).
  The same function runs in bun, the browser and the server, in `src/render3d/generated.ts`; `cli render3d` pins its output on fixed inputs.
- The object is **stale** when `mesh !== generatedKey(...)` of its current outline and params; the editor never regenerates on its own.
- A `generator` block with no `mesh` is an object that has never been generated: it draws as the tapered extrusion (rocks) or nothing (mushrooms) and the panel offers Generate.
- Only non-default values are written, and every branch of `snapshot`, `cloneBodies`, `addGeometryFor`, the clipboard and the `render3dCases` round trips carries the block.
  A level that has no generated object saves byte-identically.

## The parameter schema

`params.json` (one per generator):

```json
{
  "kind": "boulder", "version": 1,
  "groups": ["Shape", "Fracture", "Surface", "Material", "Bake"],
  "params": [
    { "key": "seed", "type": "int", "default": 31, "min": 0, "max": 2147483647, "step": 1, "group": "Shape", "basic": true,
      "doc": "Every random choice is drawn from it; the same outline and seed give the same rock." },
    { "key": "depth", "type": "number", "unit": "m", "default": 1.6, "min": 0.02, "max": 5, "step": 0.05, "group": "Shape", "basic": true,
      "doc": "The solid's depth through the gameplay plane, centred on it." },
    ...
  ]
}
```

`type` is `int`, `number`, `bool`, `enum` (with `options`) or `color` (linear RGB triple on disk, a hex field in the inspector).
`basic: true` parameters are shown by default; the rest sit under an **Advanced** disclosure per group.
A `unit` of `m` marks a length; `deg` and dimensionless values are not scaled.

### Boulder parameters

Every constant in the fork's boulder sources that is a design knob becomes a parameter with its current value as the default; validation bounds, dead code (`add_surface_relief`, `strata`), preview-only stage settings and the recipe flags that the editor never varied (`hybrid_faces`, `chunked_sides`, `balanced_hybrid`, `broad_side_chunks`, `soften_thin_edges`, `solid_chunk_edges`, `game_low_poly`, `fit_mode`, `camera_yaw`, `camera_pitch`) stay constants in Python.
The list, by group (basic ones marked):

- **Shape**: `seed`*, `depth`* (m), `tolerance` (m, blank = `min(0.04, sqrt(area) * 0.04)`), `edgeVariation`* (0..1, chip budget), `weathering`* (0..1), `taperSlopeMin`/`taperSlopeMax` (0.32/0.66), `taperReach` (0.8, times depth), `supportSlope` (0.38), `supportDepth` (0.38, times depth).
- **Fracture**: `slabsPerArea`* (10 per m², the fork's `round(area * 10)`, clamped 2..100), `chunkShare` (0.65), `chunkDepth` (0.64, times depth), `chunkFlatten`* (0.73), `chunkShrinkMin`/`Max` (0.970/0.988), `chunkDepthScaleMin`/`Max` (0.95/1.20), `chunkDepthShift` (0.13), `chunkTilt` (0.18), `chunkBevelMin`/`Max` (m, 0.027/0.065), `slabProud`* (0.22, times depth), `slabWidthMin`/`Max` (0.29/0.48 of the outline's width), `slabThicknessMin`/`Max` (0.35/0.60 of depth), `slabLengthMin`/`Max` (0.19/0.43 of the height), `slabYaw` (deg, 28), `fractureAngle` (deg, 4), `backSlabEvery` (4), `secondarySlabs` (0..1, 0), `ridgeAmplitude` (0.10), `ridgeFine` (0.045), `coreDepth` (0.30).
- **Surface**: `detail`* (0.25..4), `voxelCap` (m, 0.012), `remeshAdaptivity` (0.06), `smoothFactor` (0.65), `smoothIterations` (2), `faceBudget`* (3000 per 8.5 m of perimeter), `thinEdgeAngle` (deg, 70), `thinEdgeOffset` (m, 0.045), `edgeBevelWidth`* (m, 0.018), `edgeBevelAngle` (deg, 36), `edgeBevelSegments` (1), `tipBand` (0.015 of depth, cap 0.022 m), `tipInset` (0.09 of depth, cap 0.14 m), `sliverVolume` (0.0006), `sliverThickness` (0.028), `backingDepth` (0.105).
- **Material**: `color`* (linear RGB, [0.13, 0.15, 0.18]), `roughness`* (0.86), `variation` (0.055 per variant), `tintMin`/`tintMax` (0.84/1.12), `darkShade`/`lightShade` (0.78/1.25), `rampLow`/`rampMid`/`rampHigh` (0.34/0.50/0.66), `noiseScale` (1.25), `grainScale` (18), `bumpStrength` (0.085), `wornEdgeLift` (1.8), `wornEdgeCap` (0.38).
- **Bake**: `bakeSize` (enum 1024/2048/4096, 2048), `bakeSamples` (8), `bakeMarginColor`/`bakeMarginNormal` (8/12 px), `uvAngle` (deg, 60), `uvMargin` (0.015).

The Python side reads every one of these from the spec that `rockgen.py` is handed (`read_specs` merges `params.json` defaults, then the request's overrides) and threads them to the module that used the constant.
Where a constant was inside a helper with no spec in reach, the spec is passed down; the module layout is otherwise untouched so the fork's dirt-moss generator can still import from it.
A Python test (`tools/blender/boulders/test_params.py`, run by `bun run generators:check`) asserts that a spec built from the defaults alone produces the exact request body the fork's server sent (the fork's `polygon.json` for body 7 of `ball.json` is the fixture), so the port changes nothing about an already-approved rock.

### Mushroom parameters

Every input socket of the `MushroomPatch` node group and the texture constants that shape the look, current values as defaults:

- **Placement** (basic): `seed`*, `density`* (per m², 150), `spacing` (m, 0.02), `noOverlaps` (true), `gap` (m, 0.003), `clumping`* (0.75), `clumpSize` (m, 0.2), `maxSlope`* (deg, 75, editor-side face filter).
- **Form** (basic): `height`* (m, 0.16), `sizeMin`/`sizeMax` (0.3/1.0), `maxTilt` (deg, 15), `bend` (0.7), `capSize`* (1.0), `detail`* (0..1, 0.3).
- **Look**: `glow`* (2.0, emissive strength), `paleness` (0.5), `capVariants` (8), `stripeDarken` (0.14), `capRoughness` (0.15), `gillRoughness` (0.6), `stemRoughness` (0.55), `textureSize` (enum 512/1024, 512 wide).
- **Limits** (advanced, editor-side): `maxTriangles` (40000 soup cap), `maxEstimate` (3000 mushrooms).

`editor_patch.py` sets every socket from the spec and `mushroom_patch_tools.py` reads the texture constants from it; the stops and OKLab tables stay constants.

## The workspace

### Switching

A two-button switcher at the top of the toolbar: **Level** and **Visuals** (key **W** toggles).
Each workspace keeps its own view: the Level workspace the 2D camera, orbit and view mode it has today; the Visuals workspace a `ViewPose`.
Entering Visuals seeds the pose from the current 2D framing (head-on, target on the plane at the lens's `zOffset`) the first time and keeps it thereafter; `⟲ Reset view` returns to head-on framing of the 2D camera.
The selection, active layer, tool and inspector carry across unchanged.
The 2D overlay canvas draws nothing but the status line while Visuals is active.
`▶ Test` works from either workspace and returns to the one it left.

### Navigation

Blender's conventions, since the workspace is a modelling view rather than a plan:

| Gesture | Does |
|---|---|
| middle drag | orbit about the pose's target |
| Shift + middle drag, or right drag | pan: the target moves in the camera's right and up at the target's depth, so what is under the pointer stays under it |
| wheel | dolly toward the point under the pointer (the nearest hit, else the plane), never through it; the target moves so the dolly is a zoom about the cursor |
| **F** | frame the selection (or the level when nothing is selected): the target on its centre, the distance from its bounds |
| **Home** / ⟲ | head-on, framed as the 2D camera frames the plane |
| left drag on empty space | nothing (a band is a plane gesture; see "Editing") |

`viewControls.ts` holds the arithmetic as pure functions on a `ViewPose` (`orbit`, `pan`, `dolly`, `frame`, `headOn`) and `cli render3d` asserts: head-on pose equals today's camera to the bit; a pan keeps a plane point under the pointer; a dolly keeps the hit point on its ray; an orbit keeps the target's screen position.
The pitch is clamped as `MAX_ORBIT_PITCH` clamps the orbit; the distance is clamped to `[0.2 m, 200 m]`.

### What is drawn: the guides

`src/editor/visuals/guides.ts` builds a `THREE.Group` added to `scene3d.scene` (the gizmo already lives there), rebuilt when `modelRev` moves and refreshed per frame for the pixel-sized parts:

- the **gameplay plane**: a faint grid at z = 0 matching the training grid's 1 m major and 10 cm minor spacing, extent the level's bounds plus a margin, fading with distance (`GridHelper` is not used: it is square and centred, the level is neither);
- **collision outlines** of every visible scene body, as `Line2`/`LineSegments2` (`three/addons/lines`) at 1.5 px in the body's colour, depth test off, drawn after the scene; the selected body's in the selection orange; hidden layers and locked layers as the 2D overlay treats them;
- **lights**: a camera-facing icon (`Sprite`, `sizeAttenuation: false`) at the source and the reach and wake rings as `Line2` circles on the plane, coloured as the 2D overlay colours them;
- the **spawn** ring and the ball's footprint on the plane; camera regions and paths, firefly paths and notes as their outlines on the plane (draw only, picked on their layers);
- the selected polygon's **vertex handles** and edge midpoints as pixel-sized sprites on the plane (a primitive's on its drawn face, as the 2D overlay places them);
- **tool drafts**: the rock outline being drawn, the mushroom loop (the fork's `SurfaceDraftView`, ported), the belt and path drafts if those tools are enabled here.

Every guide object sets `userData.pickTag` to a guide tag `{ guide: "outline" | "vertex" | "midpoint" | "light" | "spawn" | "region" | "path" | "note", id, index? }`, so `Scene3D.pick` returns guides in the same nearest-first list as models.
`Scene3D` learns `Raycaster.params.Line2.threshold` for fat lines and takes the guide group into account in `pick`, excluding it from `setHighlight`.

### Picking and editing

- A click resolves through `Scene3D.pick` first and `unprojectToPlane` second, as the turned view does today; `pickOrder`'s drill-in cycle, Shift and Alt are unchanged.
  A guide tag names its item and part, so a click on an outline selects the collision object, on a vertex picks the corner, on a light the light.
- **Move on the plane**: dragging a selected item moves it along the gameplay plane, as the turned view already does through `canvasWorld`; the head-on `orbited()` test becomes `inScene()` = Visuals or turned.
- **The gizmo** is unchanged and is the way to move through z, tip and size.
- **Vertex editing** in the scene: a drag on a vertex handle moves that corner (and the picked set) on the plane through `setPolyVerts`; a midpoint inserts; Alt+click removes; Delete, arrows and Esc behave as they do head-on.
  The rubber band is not offered in Visuals (there is no plane to band on at an angle); Shift+click builds the set.
- **Drop on surface** (rock assembly): with **Shift** held, dragging a selected geometry object or light snaps it to the nearest surface hit under the pointer, placing the object's origin on the hit point and, for a mesh, aligning its up to the hit normal when **Ctrl** is also held.
  It writes `pos`, `offsetZ`, `rotX`/`rotY` through the same handlers the gizmo uses, one undo step per drag.
- **Tools** offered in Visuals on the scene layer: Select, **+ Rock**, **+ Mushrooms**, + Light, + Glow, + Fireflies, + Geometry (a mesh prop placed on the plane at the click, or on a surface with Shift); on the other layers their own tools as today.
  The 2D drawing tools (+Rect, +Circle, +Poly, +Belt, +Curve) draw on the plane through `unprojectToPlane` with their previews in the guides; +Poly and +Rect are required, the rest follow the same path and are done in the same phase if the draft rendering generalises, else listed as follow-ups.
- Everything else (delete, duplicate, copy/paste, nudge, merge/split, outliner, inspector) is model-level and needs no change.

### The rock tool and panel

`+ Rock`: click a collision outline (a scene-layer `poly` or `rect`, or the geometry object matched to one) to add, in one undo step, a geometry object `{ kind: "mesh", matchCollision: true, generator: { kind: "boulder", version, params: {} } }` on that body, select it, and start a generation.
The same is offered as **Generate rock** on the body panel of any qualifying body.

The **Rock** group on a generated object's panel:

- the parameters from the schema, basic first, each group's advanced ones under a disclosure, every field a `numField`/`checkField`/`picker`/colour field with the schema's step, placeholder showing the default, blank meaning default;
- **Generate** (Ctrl+Enter), **Next seed**, **Reset to defaults**, **Copy params** / **Paste params** (through the clipboard as JSON, so a look transfers between rocks and levels);
- a status line: `stale` in the warning colour when the key no longer matches, `queued`, `generating 12 s`, `failed: <message>` with the validator lines the fork's `generatorFailure.ts` extracts, or the mesh's triangle count and bytes when done;
- the outliner row of a stale or generating object carries the same badge.

While a job runs the object keeps drawing whatever it drew (the previous mesh, or the tapered extrusion for a first generation); the mesh swaps in when the job lands and the model is untouched except for `mesh`.
A job whose outline or params change while it runs is superseded: its result is still cached under its own key, and the panel says `superseded`.

### The mushroom tool and panel

`+ Mushrooms`: as in the fork, click a loop onto model surfaces (any geometry object on the scene layer except a mushroom patch), Enter or a click on the first point closes it, Esc drops it, Backspace removes the last point; the draft draws in the guides.
Closing the loop creates the patch object in the host's body: `{ kind: "mesh", generator: { kind: "mushrooms", version, params: {}, patch: { hostId, points } }, shape: rect of the soup's extent, offsetZ, depth }` and starts a generation.

The **Mushrooms** group is the rock group's twin: schema fields, Generate, Next seed, Reset, Copy/Paste, status, plus a readout of the collected surface (`faces · m² · up to N mushrooms`) and an **Edit loop** button that reopens the loop for editing (its points are guide handles dragged along the surface: a drag re-picks the surface under the pointer).
A patch is stale when its host's mesh key, its loop or its params changed; the surface is re-collected from the host's current meshes at generation time, so a regenerated rock is followed by a regenerated patch on demand.

## The generator service

`src/server/generators/`:

- `service.ts`: the Vite plugin. One queue, jobs keyed by mesh key, at most one Blender at a time (Blender is single-flight on this machine's CPU), a job superseded by a newer request for the same object is cancelled (`child.kill`) unless it is past the bake.
  Endpoints, dev only, same-origin checked:
  - `GET /api/generators` → `{ blender: "5.2.0" | null, python: "3.x" | null, venv: boolean, queue: number }`, shown in the workspace's toolbar when something is missing.
  - `POST /api/generate` `{ kind, key, input, params }` → `{ key, state: "done" | "queued" }`; `done` at once when `public/generated/<kind>/<hash>/mesh.glb` exists.
  - `GET /api/generate/<key>` → `{ state: "queued" | "running" | "done" | "failed" | "superseded", elapsed, message?, bytes?, triangles? }`.
  - `GET /generated/<kind>/<hash>/mesh.glb` is served from `public/` with immutable caching, as the fork served its files.
- `boulder.ts`, `mushrooms.ts`: build the spec from the schema defaults plus the request's overrides, validate types and ranges from the schema, write the job dir, spawn, parse the failure lines, write `meta.json` `{ key, kind, version, params, input, bytes, triangles, generatedAt, blender }`.
- `hash.ts` re-exports `generatedKey` from `src/render3d/generated.ts` so the server can refuse a request whose key does not match its content.
- Python and Blender are found as the fork finds them (`PYTHON_PATH`, `.venv`, `BLENDER_PATH`, `which blender`), with the venv at `rope/.venv` and `bun run generators:setup` creating it from `tools/blender/requirements.txt`.
- `render3d/generated.ts`: `generatedKey`, `generatedMeshAsset(key)` → `{ file }` (consulted by `loadMesh` before `MESH_ASSETS`), and `generatedMeta(key)` for node callers; `levelStoredFiles` reads `bytes` from `meta.json` for the preload list.
- The generator sources move to `tools/blender/boulders/` (the whole `stylised_rocks_v5` directory, with its README, unchanged apart from reading the spec) and `tools/blender/mushrooms/`.
- `public/generated/` is gitignored and watch-ignored.

## Phases

Each phase names its owner, the files it may touch, its acceptance and its tests.
Phases 1, 2 and 3 are independent and run in parallel in their own worktrees; 4 and 5 follow and are sequential because both edit `editor.ts`; 6 closes.
No phase touches `levels/*.json`.

### Phase 1: the free view and the scene guides (render side)

Files: `src/render3d/space.ts`, `src/render3d/scene.ts`, new `src/editor/visuals/viewPose.ts`, `viewControls.ts`, `guides.ts`, `src/sim/render3dCases.ts`.

- `ViewPose { target: {x,y,z}, yaw, pitch, distance, fovYDeg }` in three's frame; `poseFromCamera(camera, lens, orbit)` and `applyPose(threeCam, pose, aspect)` factored out of `syncCamera`, which becomes the composition and stays bit-identical (the head-on branch keeps its written-out form).
- `Scene3D.setViewPose(pose | null)`: when set, `render` places the camera by it; `pick`, `unprojectToPlane` and the gizmo see the same camera.
- `Scene3D.hitsAt(x, y)`, `pickSurface(x, y, accept)`, `meshesOf(tag)` ported from the fork (`scene.ts`), including its fix of the `hit.point.sub` mutation.
- `Scene3D` gains `editorLayer: THREE.Group`, kept across `setLevel`, raycast by `pick` (fat-line threshold set) and skipped by `setHighlight`.
- `viewControls.ts` pure functions and `guides.ts` as specified, with the guide tag type in `src/editor/visuals/tags.ts`.
- Cases: pose equality with today's camera at five placements and three orbits; pan/dolly/orbit invariants; `unprojectToPlane` round trip under a free pose; guide tags of a small model (outline count, vertex handle count for a selected poly, a light's icon and rings).

### Phase 2: the format and the schema

Files: `src/level/levelFormat.ts`, `src/editor/model.ts`, `src/editor/clipboard.ts`, `src/render3d/generated.ts`, `src/render3d/assets.ts` (`loadMesh`), `src/render3d/levelAssets.ts`, `tools/blender/boulders/params.json`, `tools/blender/mushrooms/params.json`, `src/editor/visuals/paramSchema.ts` (types, validation, default merging, px/m scaling by unit, canonical form), `src/sim/render3dCases.ts`, `docs/level-format.md`.

- The `generator` block through `GeometryObjectData`, `scaleObject`, `EdVisual`, `fromLevelData`/`toLevelData` (host index ↔ item id), `visualData`, `cloneBodies`-style deep copies in `model.ts` helpers so `editor.ts`'s `snapshot` has one function to call.
- `generatedKey` and the resolvers; `loadMesh` consults `generatedMeshAsset` first; `levelStoredFiles` reads `meta.json`.
- The two schemas, complete per the lists above, each parameter with `doc`.
- Cases: level round trip with a boulder object and a mushroom patch (px ↔ m, host index ↔ id, byte-identical save of an untouched level); `generatedKey` pinned on fixed inputs; scaling by unit; validation rejects out-of-range and unknown keys; defaults merge.

### Phase 3: the generator service and the Python port

Files: `src/server/generators/*`, `vite.config.ts` (register the plugin, ignore `public/generated`), `tools/blender/boulders/**`, `tools/blender/mushrooms/**`, `tools/blender/requirements.txt`, `package.json` scripts (`generators:setup`, `generators:check`), `.gitignore`, `docs/generators.md` (new).

- Copy the fork's sources; thread every schema parameter through the Python (`read_specs` loads `params.json`; each module reads from the spec it is handed).
- The service as specified; `generatorFailure.ts` ported.
- `bun run generators:check`: the Python defaults test above (the fork's `polygon.json` fixture is copied to `tools/blender/boulders/fixtures/`), the request validation and key tests from the fork's `.test.mjs` files rewritten as bun tests, and an end-to-end generation of a small square outline through Blender when `blender` is on the path (skipped with a printed reason otherwise, never silently).
- Acceptance: with the dev server up, `curl -X POST /api/generate` with the fixture outline and empty params produces a GLB whose triangle count is within 5 % of the fork's for the same outline and seed.

### Phase 4: the workspace in the editor

Files: `src/editor/editor.ts`, `src/editor/render.ts` (status only), `editor.html` (if styles need it), `src/editor/visuals/workspace.ts` (the controller: pose state, pointer routing, guide ownership, tool state), `docs/editor.md`, new `docs/editor-visuals.md`.

- The switcher, the pose per workspace, navigation, guides, picking through guide tags, plane moves, vertex editing, drop on surface, tools on the plane, Reset, F, Home, W.
- The `orbited()` predicate generalised; every `turned` branch audited (the list in the survey: draft rendering, `pickHandle`, spawn drag, chain/vine handles, marquee) and given its scene equivalent or an explicit "not in Visuals" that the status line states.
- Acceptance: driven through the CDP harness (memory note `reference_editor_cdp_harness.md`) on a scratch level (never a named level): switch, orbit, pan, dolly, select a body through its outline, drag it, pick a vertex and drag it, gizmo move through z, delete, undo, switch back and confirm the 2D overlay is where it was.

### Phase 5: the rock and mushroom tools

Files: `src/editor/editor.ts`, `src/editor/visuals/generatorPanel.ts` (schema-driven fields, status, buttons), `src/editor/visuals/jobs.ts` (client of the service: submit, poll, supersede, swap the key into the model in one undo step), `src/editor/visuals/surfacePatch.ts` (ported), `docs/editor-visuals.md`, `docs/generators.md`.

- `+ Rock`, Generate rock, the Rock group; `+ Mushrooms`, Edit loop, the Mushrooms group; staleness, badges, Copy/Paste params.
- Acceptance through the CDP harness plus a real Blender run: generate a rock for a square, see the mesh swap in, change `depth`, see `stale`, regenerate, see the new key; paint a loop on the rock, generate, see the patch; undo the generation and see the previous key back.

### Phase 6: docs, map and the suite

- `docs/editor-visuals.md` (the workspace: navigation, guides, editing, the two tools, what is not offered), `docs/generators.md` (the service, the schemas, the Python layout, how to add a parameter, how to add a generator), `docs/level-format.md` (the block), `docs/editor.md` (the switcher and a pointer), `CLAUDE.md` map rows for the two docs (under 200 lines), `docs/rock-assets.md` gets a note that boulders are the generated alternative and the hand-authored path remains for the accepted props.
- `bun run test` green apart from the suites already red on main (contacts, movers, vines, sleep, bundles per memory), each of which is checked against a clean `main` worktree before being blamed on this branch.

## Verification blind spots

- The suite cannot see the scene: every guide, pick and gesture claim needs the CDP harness with the console captured, and the look of a generated rock needs a real browser screenshot or the owner's eye.
- `cli shot` pins the camera on the avatar and cannot show the workspace.
- Blender timing on a laptop CPU is the round trip the owner will feel; report measured seconds for the fixture.

## Follow-ups (not in this plan)

- Publishing generated meshes to the release store with manifest entries (`source: "generated:boulder:<hash>"`), so a level with generated objects deploys.
- Moss (`dirt_moss`) as a third generator on the same service.
- A waking light hung on a mushroom patch, as `+ Glow` does for its cube.
- Bloom for the mushroom emissive.
- Camera bookmarks in the workspace.

## Working rules for the implementers

- Branch `visuals-workspace` in the worktree at `~/projects/website-visuals`; phase worktrees branch from it and merge back.
  Commit on the branch, with plain messages, no co-author lines.
- The owner's dev server on port 3100 serves `~/projects/website`; never touch it, never `pkill vite`, never write `levels/*.json` anywhere.
  A worktree's dev server uses its own port (3102 and up) and its own `node_modules` (`bun install` in the worktree).
- No em dashes anywhere.
  Bash timeouts of 30 s or less; a Blender run goes in the background with its log tailed.
- Edit with the Edit tool, never scripted string replacement.
- Every new constant states its dimension; every new field is written only when non-default; every new nested object is cloned in `snapshot`.
- Docs are updated in the same change as the code they describe.
- Before claiming a phase done, run `bun run typecheck` and the `render3d` cases, and say what green cannot see.
