# Plan: modeling briefs, from blocking geometry to finished assets

This plan comes out of feedback from an agent that took the backdrop scene (`8h1SI1O4Hqeg4B9ZlU-gRg`, 20 objects fitted to the painting `backdrop.png`) and generated a finished asset for each object.
The studio handled metres, world coordinates, bounds and the camera well.
The gaps were all downstream of the geometry: connecting each object to its part of the painting, and saying how freely the geometry may be interpreted.

Two mistakes in that session came straight from those gaps:

- **Missing foliage.** The moss, ferns, mushrooms and vines on the rocks are not modelled, so nothing in the scene said they belong to the rocks, and the first assets left them out.
- **An over-rigid first interpretation.** The outlines were treated as exact manufacturing constraints, when the top and side views were designed by hand and only the camera-facing silhouette was fitted to anything.
  Tris wants attractive natural rocks, not faithful extrusions, and nothing in the scene carried that preference.

Everything else was delivery work the agent did by hand: identifying which pixels belong to which asset, rendering isolated views at a consistent scale, and rebuilding meshes and placements from the document.

Read `3d/CLAUDE.md` first.
The conventions apply throughout: a new capability is a command in `core/commands.ts`, an op in `core/ops.ts`, a tool in `api/tools.ts` and a line in `llms.txt`; the schema changes first, then `types.ts`.
This plan builds on phases 1 and 2 of `agent-geometry-tooling.md` (exact solids, `core/raster.ts`, traces, `compare_to_reference`), which are in the tree.
It does not depend on that plan's later phases, except where noted.

## The verdict

Build it in this order; each phase is useful on its own.

1. **The brief in the document.** Per-object appearance and interpretation settings with scene-wide defaults, decorations (foliage and other dressing) owned by an object with regions in the reference and an include flag, and an explicit pivot.
   A claims picture shows which object owns every pixel of the reference.
2. **Scale anchors.** Reference features of known size as structured data, checked against the geometry.
3. **Isolated views.** `render_objects`: chosen objects alone, from front, back, top, side and three-quarter, at one scale per sheet, on transparent backgrounds, drawn on the server without Chromium; plus camera overrides on `render`.
4. **Mesh and assembly export.** A GLB with one named node per object, stable ids, pivots and world transforms; one GLB per object on request.
5. **Export modeling brief.** One action that writes a folder per object (reference crops, masks, views, mesh, dimensions, instructions) plus a shared assembly and manifest.
6. **Generation results.** Sheets and models attached to objects, with review status, flagged stale when the object's shape or brief changes.

Phases 1 and 2 are what would have prevented the rework.
Phases 3 to 5 make delivery fast, and phase 5 is mostly assembly of the earlier phases.
Phase 6 closes the loop so a scene remembers what was made from it.

## Phase 1: the brief in the document

### Why

- **Which pixels belong to which asset.** An object's `trace` is its silhouette in the reference, but only the rock's.
  The fern growing off its edge, the vines hanging below it and the mushrooms on its ledge are outside the trace, and the agent had to decide by eye, twenty times, what else belonged to each rock.
- **Foliage has no home.** The scene cannot say "this rock has a moss cushion on top and ferns along its front edge", so the asset generator never hears it.
- **Nothing says how exact the geometry is.** A fitted silhouette, a designed plan, and a back face nobody has ever seen all look equally authoritative in the document.
- **Style lives in chat.** "Attractive natural rocks, faceted pale stone like the painting" was said to one agent and lost to the next.

### What

**Scene-wide defaults**, a new `scene.brief`:

```json
"brief": {
  "style": "Natural, attractive rock formations. Faceted pale limestone as in the painting; no blocky extrusions.",
  "interpretation": {
    "silhouette": { "level": "preserve", "tolerance": 0.05 },
    "massing": { "level": "approximate", "tolerance": 0.3 },
    "hidden": { "level": "invent" },
    "appearance": { "level": "reference" }
  }
}
```

**Per-object brief**, a new optional `brief` on each object, overriding the scene's field by field:

```json
"brief": {
  "appearance": "Tall pale pillar, vertical fractures, darker wet streaks at the base.",
  "interpretation": { "massing": { "level": "approximate", "tolerance": 0.5 } },
  "decorations": [
    {
      "id": "moss-top",
      "kind": "moss",
      "description": "Thick moss cushion over the top, spilling 20-40 cm down the front edge.",
      "regions": [[[1022, 610], [1110, 604], [1118, 640], [1030, 652]]],
      "include": true
    },
    {
      "id": "ivy",
      "kind": "vine",
      "description": "Ivy hanging from the ledge to the water, about 2.5 m long, leaves about 7 cm.",
      "regions": [[[1060, 668], [1084, 668], [1080, 820], [1062, 824]]],
      "include": true
    }
  ]
}
```

The interpretation aspects, each with a `level` and, where it applies, a `tolerance` in metres:

| Aspect | Means | Levels |
|--------|-------|--------|
| `silhouette` | The outline the reference shows from the scene camera (the trace). | `exact`, `preserve` (within tolerance), `approximate`, `free` |
| `massing` | Overall extent, footprint and proportions: the designed top and side views. | same |
| `hidden` | Surfaces the reference does not show. | `invent` (make something plausible in the style), `follow` (keep the blocking shape) |
| `appearance` | Where surface look comes from. | `reference` (the painting wins), `brief` (the text wins where they differ) |

Defaults when neither scene nor object sets them: `silhouette: preserve` at 2% of the object's largest dimension, `massing: approximate` at 10%, `hidden: invent`, `appearance: reference`.
These defaults encode the lesson from the session: the geometry is blocking, not a manufacturing drawing.

**Decorations.** `kind` is a free tag like an object's (suggested: `moss`, `fern`, `vine`, `fungus`, `grass`, `lichen`, `water`, `other`).
`regions` are polygons in the perspective reference image's pixels, like a trace; a decoration may have none (described only, for dressing the reference does not show).
`include: true` means the finished asset must contain it; `false` means it is described for context only (for example, grass on the ground in front, owned by the level rather than this rock).
Each decoration belongs to exactly one object, so ownership is never ambiguous.

**Pivot.** A new optional `pivot: {x, y, z}` in world metres.
The default is the bottom centre of the object's box (centre x and y, lowest z), which is what a rock placed in a level wants.
Internally it is stored normalised to the box like the outlines, so moving or rescaling an object carries it along.

**Object ids are the stable keys.** There is no rename, and this plan keeps it that way: every export, anchor, decoration and generation refers to objects by id.

**The claims picture.** `compare_to_reference { claims: true }` adds a picture in reference-image pixels: each object's trace tinted in its colour, its included decorations hatched in the same colour, excluded decorations outlined only, and pixels nobody claims left untouched.
It also reports `unclaimed` (bounding boxes of large unclaimed areas, above a size threshold) so an agent can ask "is anything in this painting still unassigned?".

**Checks in `validate`:**

- `decoration-detached` (warning): a decoration region neither touches nor comes within 24 px of its owner's trace.
- `decoration-shared` (warning): regions of decorations on two different objects overlap by more than a small area, so the same fern is claimed twice.
- `decoration-duplicate-id` (error) within one object.

### How

- Schema first: `scene.brief`, `objects[].brief`, `objects[].pivot`; then `types.ts`, the `document.ts` round trip (including `derived.pivot` in world metres on export).
- `core/brief.ts`: `effectiveBrief(scene, object)` merges defaults, scene and object field by field; everything downstream reads through it.
- Commands and ops: `setBrief` (scene or object, a partial merge; `null` clears a field back to inherited), `setDecoration` (upsert by id, or `null` to remove), `setPivot`.
  Tools `set_brief`, `set_decoration`, `set_pivot`, and `update_object` does not grow: briefs are their own edits so an agent writing prose cannot clobber geometry.
- The claims picture uses `polygonMask` from `core/compare.ts` at reference resolution and `png.ts` to encode; no Chromium.
- Editor:
  - A **Brief** section in the object panel: appearance text, the four aspects (each shows "inherited from scene" until overridden), the decoration list with kind, description and an include toggle, and the pivot.
  - Decoration regions are drawn in the perspective view over the reference in the owner's colour, hatched when included, and edited like trace points.
  - The pivot is drawn as a small cross in the orthographic views and can be dragged.
  - The scene panel gets the scene-wide style and defaults.

### Tests

- `effectiveBrief`: object override of one aspect keeps the others from the scene; clearing with `null` restores inheritance.
- Document round trip preserves every brief field; an unknown aspect or level is a schema error with a path.
- `decoration-detached` fires for a region 100 px from its owner's trace and not for one touching it; `decoration-shared` fires for two owners' overlapping regions.
- Pivot follows `move_objects` and `set_bounds` (a bottom-centre pivot stays bottom-centre after a rescale).
- Claims picture: every traced pixel carries its owner's tint, and `unclaimed` reports a deliberately untraced rectangle.

## Phase 2: scale anchors

### Why

The scene's scale came from plants: a big fern about 1 m tall, glowing mushrooms about 0.4 m, ivy leaves about 7 cm.
That evidence sits in `scene.scale.basis` as prose.
The asset generator needed it for a different question than the scale: how big the surface detail on a 6 m rock should be, so the moss and ferns on it read at the right size.
Prose had to be re-read and re-interpreted for each object.

### What

`scene.scale.anchors`, next to `basis`:

```json
"anchors": [
  {
    "id": "big-fern",
    "label": "Fern on the lower-left platform",
    "kind": "fern",
    "points": [[312, 702], [318, 590]],
    "dimension": "height",
    "meters": 1.0,
    "range": [0.7, 1.4],
    "confidence": "medium",
    "on": "left-platform"
  }
]
```

`points` is a segment in reference-image pixels across the measured dimension; `on` is the object it stands on or grows from, which fixes its depth; `range` is what is plausible for the kind; `confidence` is `low`, `medium` or `high`.
`basis` stays as the human summary, and `scale-not-set` is satisfied by either.

**`check_scale`** reports, for each anchor, the size its segment implies at the depth of its `on` object (ray cast from the segment's first point, which should be the base), whether that lies within `range`, and a suggested `rescale_scene` factor: the confidence-weighted median of `meters / implied`.

**In the brief**, an object lists the anchors that stand on it or fall inside its claimed region, and the anchors of the same kinds as its decorations, so its brief can say "ferns here are about 1 m tall".
A decoration can name an anchor (`anchor: "big-fern"`) to borrow its size.

**Checks:** `scale-anchor-disagrees` (warning) when an anchor's implied size is outside its range; `unknown-object` for a bad `on`.

### How

- `core/raycast.ts` already does ray against solid; `check_scale` casts through `overlayGeometry`'s image-to-frame mapping.
  The same code is the `measure` tool of `agent-geometry-tooling.md` phase 4; build that tool here if it is not yet built, and have `check_scale` call it.
- Command, op and tool `set_scale_anchor` (upsert or `null`), tool `check_scale`.
- The editor draws anchors in the perspective view as dimension lines with their label and implied size, red when outside range.

### Tests

- A 2 m box with an anchor across its edge, `meters: 2`: implied 2 m within a pixel's worth, factor 1.
- Rescale the scene by 0.5: the suggested factor is 2 and the anchor now warns.
- Three anchors with one outlier at `low` confidence: the suggested factor follows the other two.

## Phase 3: isolated views

### Why

The agent rendered each object alone from several sides, cropped and padded the pictures, and laid them out as sheets, all outside the studio.
`render` draws the whole scene, the orthographic views only look from front, top and right, and the perspective view can only use the saved camera, so an isolated or re-aimed picture meant changing the scene.

### What

**`render_objects`**: `{ sceneId, ids, views?, styles?, pixelsPerMeter?, scale?, padding?, background?, azimuth?, elevation? }`.

- `views`: any of `front`, `back`, `left`, `side` (the right side, as elsewhere), `top`, `bottom`, `three-quarter`, `camera`.
  Default: `front`, `back`, `top`, `side`, `three-quarter`.
  `three-quarter` is orthographic from `azimuth` 45° and `elevation` 30° by default; `camera` is the scene camera looking at this object alone.
- `scale`: `sheet` (default: one `pixelsPerMeter` for every view of one object) or `shared` (one for every object in the call, so relative sizes compare).
  The result reports the scale and, for each picture, where it lies in metres, like `render`'s `placements`.
- `padding` in metres (default 5% of the object's largest dimension); `background: "transparent"` (default) or a colour.
- `styles`, each a separate picture per view:
  - `shaded` (default): neutral clay, flat-shaded with a fixed key light, silhouette and crease lines.
  - `lines`: silhouette and crease lines only.
  - `mask`: the solid as white on transparent.
  - `depth` and `normal`: 16-bit depth and world-space normals, for image models that condition on them.
  - `evidence`: surfaces the reference actually shows (seen from the scene camera, not hidden by other objects) in one tint, inferred surfaces in another.
    This is the `hidden` interpretation made visible.
  - `projected`: the reference painting projected from the scene camera onto the seen surfaces, clay elsewhere; the closest thing to "what this rock looks like from behind, as far as the painting knows".
- One `sheet` picture per object on request: the views laid out third-angle with the three-quarter view in the free corner, at the sheet's scale, with a scale bar.

**`render` overrides.** `camera` (any `set_camera` fields) and `isolate: ids` for one picture, leaving the saved scene alone.

### How

- Extend `core/raster.ts` rather than going through Chromium: it already rasterises triangles with depth; add orthographic cameras (a view matrix and an orthographic projection from `core/camera.ts`), flat Lambert shading from face normals, 3 × 3 supersampling with coverage-based alpha, and lines from discontinuities in object id, normal (above `CREASE_DEGREES`) and depth at supersampled resolution.
  The server then renders sheets in milliseconds, deterministically, with no browser queue.
- `evidence` and `projected` use the whole scene's camera raster as a shadow map: a point on the object is seen when its camera depth matches the depth buffer at its frame pixel within a small epsilon.
  `projected` then samples the reference at `frameToImage` of that pixel, so core takes the decoded reference as raw RGBA (decoding is in phase 5's dependency decision; until then `projected` is refused with `needs-decoder` on the server and works in the page from a canvas).
- `render`'s `camera` and `isolate` apply to a copy of the state before it goes to the renderer; the Chromium path and the CPU `ids`/`depth` path both honour them.
- Tool `render_objects`, op `renderObjects` for `window.orthographic`.

### Tests

- A 1 × 2 × 3 m box at `pixelsPerMeter: 100` and no padding: front is 100 × 300 px, top 100 × 200, side 200 × 300, all fully opaque inside and transparent outside.
- `back` is `front` mirrored for a symmetric object; `left` is `side` mirrored.
- `scale: shared` with a 1 m and a 4 m box: their front pictures differ in width by 4×.
- `evidence`: a box behind another box shows its hidden part in the inferred tint.
- The CPU `shaded` silhouette and the WebGL perspective silhouette agree on at least 99.9% of pixels for the same camera (e2e, like the existing `ids` check).

## Phase 4: mesh and assembly export

### Why

Placement could be recovered from the document, but only by re-deriving meshes from outlines and working out transforms by hand.
Downstream tools (Blender, the game's level pipeline, 3D generators that take a blocking mesh) want a mesh file.

### What

- `export` gains `assembly.glb`: one node per object, named by its id, with its pivot as the node translation and its mesh in local coordinates around the pivot; `extras` carry `name`, `kind`, `notes`, the effective brief, bounds in metres, and the shape hash from phase 6.
  One material per object in its colour, so the assembly reads in any viewer.
  The scene camera is included as a glTF camera node with its vertical FOV and aspect.
- `objects/<id>.glb`: one object alone, pivot at the origin.
- **Axes.** The studio is Z up; glTF is Y up.
  All object nodes sit under one root node, `studio`, whose rotation maps Z up to Y up (−90° about X).
  So every child's translation is exactly the object's pivot in studio metres, matching `brief.json` and `get_scene`, and importers that convert glTF to Z up (Blender) show the scene as the studio does.

### How

- `core/gltf.ts`: a small GLB writer (JSON chunk plus one binary chunk, positions, normals, indices, materials, one camera).
  It is a few hundred lines with no dependency, and works in the page (the editor's export menu) and on the server.
- Meshes come from `core/mesher.ts` (exact, already cached by shape in `api/geometry.ts`).
- Export routes and the `export` tool gain the formats; the editor's export menu gets "Assembly (GLB)".

### Tests

- The GLB passes the Khronos glTF validator (run in the test via its npm package).
- Round trip: parse the GLB back, apply each node's world transform, and require the vertices to match the studio mesh in world metres within 1e-6.
- The camera node reproduces the scene camera: a point projected through it lands on the same frame pixel as through `core/camera.ts`.

## Phase 5: export modeling brief

### Why

The single action that would have saved the most time: everything above, gathered per object, in one place, in a form another model can be handed.

### What

**`export_brief`**: `{ sceneId, ids?, views?, styles?, scale?, padding?, contextFactor? }`, returning a manifest inline, a URL per file (for agents that cannot unzip), and a zip URL.
Cached by scene revision and arguments, like renders.

```
<scene>-brief/
  manifest.json          scene id, revision, units and axes, camera, every file with its hash, every object's summary
  assembly.glb
  scene.json             the document without pixels
  reference/
    full.png             the perspective reference
    claims.png           who owns which pixel (phase 1)
  objects/<id>/
    brief.json           dimensions, pivot, world placement, bounds, effective interpretation, appearance,
                         decorations, anchors, crop placements, view placements and scale, hashes
    brief.md             the same as instructions for a person or a model
    mesh.glb             local geometry, pivot at the origin
    reference/
      crop.png           the object's claimed region (trace plus included decorations), padded
      context.png        a wider crop (contextFactor times the region, default 3), region outlined, others dimmed
      mask.png           everything this asset must contain: trace plus included decorations
      mask-body.png      the trace alone
      mask-visible.png   the trace minus what nearer objects cover
      mask-<decoration>.png
      <view>.png         crops of front/top/side reference images, where the scene has them
    views/
      <view>-<style>.png
      sheet.png
```

Masks are 8-bit grey at the crop's size; `brief.json` gives each crop's rectangle in reference pixels so everything can be put back.

**`brief.md`** is generated from `brief.json` by a fixed template, and says, in this order: what the object is and its size in metres; the scene style and the object's appearance; what to preserve, approximate and invent, each pointing at the picture that shows it (`reference/crop.png` for the silhouette, `views/top-shaded.png` for the massing, `views/*-evidence.png` for what is inferred); every included decoration with its mask and any anchored size; excluded decorations, marked as not part of this asset; and the pivot and placement for reassembly.
The template is where "do not treat outlines as exact" and "the foliage must be in the finished asset" are said every time, to every generator.

**Warnings in the manifest:** an object without a trace has no reference crop (`brief-no-region`); an object with decorations that have no regions gets description-only decorations, noted in `brief.md`.

The editor gets **Export modeling brief…** in the export menu for the selected objects (all when none), downloading the zip.

### How

- **Image decoding needs a dependency.** Crops, masks over the reference and `projected` views need the reference's pixels on the server, and there is no decoder today (`png.ts` only encodes).
  Use `sharp` (libvips): it decodes PNG, JPEG and WebP, crops, resizes, composites and encodes, and it runs under Bun with prebuilt binaries for the Debian-based `oven/bun:1-slim` image.
  Check first that it installs and loads in the production image; if it does not, decode in the page instead, through the existing headless Chromium render path.
- **Zip writing:** `fflate` (pure JS, small), or a stored-only writer in `core/` if Tris prefers no dependency; the PNGs are already compressed.
- `api/brief.ts` assembles the folder from phases 1 to 4 and `effectiveBrief`; the per-object work is independent, so objects are built in parallel.
- `brief.md` templates live in `core/briefText.ts` so the editor's Brief panel can preview exactly what a generator will read.

### Tests

- A two-object scene with a trace, one included and one excluded decoration: the folder has every listed file, `mask.png` contains the included decoration and not the excluded one, and `brief.md` names both with the right inclusion.
- Every crop rectangle in `brief.json`, applied to the full reference, reproduces `crop.png` byte for byte.
- Re-exporting at the same revision returns the cached result; after an edit, only the edited object's hashes change.

## Phase 6: generation results

### Why

After the brief comes the generation, and the review.
Nothing tied an approved sheet to the object and geometry it was made from, so when an object changed there was no way to know which approved results were now out of date.

### What

A new optional `generations` list on each object:

```json
"generations": [
  {
    "id": "sheet-1",
    "kind": "sheet",
    "file": "a9f3...",
    "prompt": "brief.md as sent, plus the model's settings",
    "revision": 84,
    "shapeHash": "3c1e...",
    "briefHash": "77ab...",
    "status": "approved",
    "notes": "Good silhouette; moss a bit thin on the ledge.",
    "created": "2026-09-30T10:12:00Z"
  }
]
```

- `kind`: `sheet`, `crop`, `render`, `model`, `texture` or `other`.
- `file` is a content-addressed id in the scene's file store: the image store generalised to also take `model/gltf-binary` (with its own size limit, 50 MB), under the same budget and expiry.
- `shapeHash` is a hash of the object's outlines relative to its pivot (so moving an object does not invalidate its assets, reshaping it does); `briefHash` a hash of its effective brief.
  Both are recorded when the generation is added.
- `status`: `pending`, `approved` or `rejected`, set by a person in the editor or by an agent.

**Checks:** `generation-stale` (warning) on an approved or pending generation whose `shapeHash` or `briefHash` no longer matches, saying which changed.

**Tools:** `add_generation` (from a URL or base64, like `add_image`), `review_generation` (status and notes), and `export_brief` includes each object's approved results under `objects/<id>/approved/`.

**Editor:** the object's Brief section lists its generations as thumbnails (models as a small turntable render from phase 3's rasteriser) with approve and reject buttons, notes, and a stale badge.

### How

- Hashes in `core/brief.ts`: sha256 over canonical JSON (outlines in metres relative to the pivot, rounded to 1e-6); the same hash goes into `brief.json` and the GLB extras.
- `api/scenes.ts`: `images` becomes a file store that still exposes images under `images` in documents, plus a `files` map for non-image blobs; unused-file grace and budget rules stay as they are.

### Tests

- Adding a generation records the current hashes; moving the object leaves it fresh; changing an outline makes it `generation-stale` with reason `shape`; editing the appearance makes it stale with reason `brief`.
- A rejected generation never warns.
- A GLB added as a model round-trips byte for byte through the store.

## Documentation

`llms.txt` gains a section, "Briefing objects for asset generation", with the loop:

1. Set `scene.brief`: the style and the interpretation defaults.
2. For each object: `set_brief` (appearance, any overrides), `set_decoration` for everything that grows on or hangs from it, with regions, and `set_pivot` if bottom-centre is wrong.
3. `compare_to_reference { claims: true }` until nothing important is unclaimed.
4. Record the scale evidence as anchors and `check_scale`.
5. `export_brief`, generate, then `add_generation` and `review_generation`.

And the lessons behind it, stated plainly: the geometry is blocking, and only the silhouette the reference shows is evidence; everything on a rock in the painting is part of that rock's asset unless a decoration says otherwise.
