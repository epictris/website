# Dirt paint

**Superseded on 2026-11-26 by material layers** ([docs/formations.md](../docs/formations.md#material-layers)): dirt is now a Blender material (`assets-src/materials/dirt.blend`, a Principled BSDF) painted in the editor's Texturing workspace, not a numpy generator and a decoration kind of its own.
Steps 1 and 2 below are not to be built; "The look" still describes the target for `dirt.blend`, and its rules (show the actual render, two rejected looks means ask) still hold.

Requested by Tris on 2026-11-25: "I also want a dirt painting mode that works in the same way".
"The same way" is the moss work of that day, all uncommitted and unplayed when this was written:

- a palette brush in the Decorations workspace (cursor ring and footprint, Paint / Erase and radius in the dock, selects nothing);
- left drag lays paint, a right-click grows it, a right-click with nothing unconfirmed goes back to Select;
- painting over another patch of the same kind combines them;
- the result is a **texture layer**: part of the rock's own look, painted into the rock's paint UV, never a shell over it.

Read first: [docs/formations.md](../docs/formations.md) "Decorations" and "Texture layers", and `src/editor/decorationPanel.ts`.
The bugs found that day, open and fixed, are in [bugs-2026-11-25.md](bugs-2026-11-25.md); two of them (old rocks need Regenerate, old texture mosses need growing again) are in the way of testing dirt on a real level.

## The look

Tris's reference (2026-11-25), with one change: "it should look kinda like this except with fewer stones".
It is [plans/dirt/reference.png](dirt/reference.png) (512 x 512, taken from that conversation's transcript).
What it shows, with colours measured from it (sRGB, as the image stores them):

- hand-painted, flat-lit brown earth, a dark warm brown: median `#4c3019`, the clods' shaded halves about `#4a2e17` and lit halves about `#4f331b` (a narrow range: the clods read by their outlines, not by contrast); no photographic noise;
- soft rounded **clods**, 5 to 15 cm across at the rock's scale, each a slightly different tone, lighter on its upper edge as if painted lit from above;
- **darker crack lines** between the clods (the darkest 5% average `#3d230e`), thin and continuous, wider where three clods meet;
- faint fine striations inside some clods, like dried silt;
- **pebbles**: small pale grey-beige stones (1 to 3 cm) with a dark rim and a light top, gathered along the cracks, sometimes in small clusters; they cover well under 1% of the image, and its lightest 0.2% of pixels (their tops) average `#755b47`, so even a pebble stays muted against the earth.
  Tris wants fewer of them than the reference has: start at about a quarter of its density, and make the density a setting.

Rules that hold for any look in this repo:

- A rejected look twice in a row means stop and ask Tris, not a third guess (rope/CLAUDE.md).
- Show Tris the actual render, the dirt on a rock as the game draws it, never a texture-space crop (memory: feedback_show_actual_render).
- Validate the look with Tris before writing any case that pins its numbers (root CLAUDE.md, "Validate the behaviour before writing the cases").

## Recommended approach

A new painted kind, `dirt`, built as a texture layer through the same path as a texture-only moss, with a look of its own computed per texel from the texel's **position on the rock**, not from its UV.
Position-based means the pattern is continuous across the paint UV's island seams, which a UV-space pattern would not be, and the same on the unbaked and the baked rock.

Rejected: dirt as a brown texture-only moss.
The moss print is overlapping round dabs, dark at the rim and lighter in clumps; the reference is cells separated by cracks.
It is worth one look as a cheap first comparison (moss settings with brown colours), but not the plan.

### 1. The kind, end to end (plumbing, no look yet)

- `src/level/levelFormat.ts`: `DecorationKind` gains `"dirt"`; `PAINTED_DECORATIONS` gains it.
- `src/formation/decoration.ts`: `isTextureLayer` is true for every dirt (dirt has no mesh form).
- `src/editor/decorationPanel.ts`: `DECORATION_LABELS.dirt = "Dirt"`.
  Everything keyed by kind already works for a new painted kind: `paintedOn`, `patchesOn` and `absorb` (patches of the same kind combine), `apply`, the cursor, the coverage dots.
  Check `PaintCoverage`'s threshold: it reads the decoration's `threshold` setting or `DEFAULT_THRESHOLD` (0.35); dirt should have its own default if its edge is built differently.
- `src/editor/editor.ts`: the Decorations dock's Paint group lists Moss and Ivy by name (`paletteButtons.get("moss")`, `"ivy"`); add Dirt there, and make the brush controls show for it (`brushOn` uses `PAINTED_DECORATIONS`, so it should follow).
- The cursor's colour (`src/editor/paintCursor.ts`) is the stamp brush's green; consider a brown for a dirt brush so the tool reads at a glance.
- `tools/blender/decoration_prepare.py` makes the decoration through its add-on per kind; dirt needs a branch (see step 2).
- `scripts/decoration-build.ts` already sends every texture layer to `tools/blender/decoration_layer.py`; that script today asks the moss add-on for its dabs (`moss.texture_paints`), so it needs a dirt branch.
- Settings fields come from the add-on's registered properties through `src/level/decorationSchema.json`, regenerated by `just decoration-schema` (`tools/blender/decoration_schema_export.py`); a dirt add-on's properties appear in the panel that way.

### 2. The dirt generator (Blender side, pure functions)

A small add-on, `tools/blender/dirt/`, modelled on the moss add-on's split (pure `build.py`, `settings.py`, a thin `ops.py`), registered by `decoration_prepare.py` for `kind == "dirt"`.
Its one job here: given the stamps and the rock, return each texel's colour and coverage, as `moss.build.paint_texels` does for moss.

- **Coverage** from the stamps, composited as every painted kind composites them (`tools/blender/stampbrush`, `composite` in `geometry.py`; the editor's dots are a port of it, `src/editor/paintCoverage.ts`), then cut at the threshold with its edge broken by a noise of the rock position, so the patch ends in clods and crumbs rather than a smooth disc outline.
- **Clods**: a 3D cellular (Voronoi) noise of the rock position at the clod size; per cell a tone jitter; F2 minus F1 small is a crack, darkened and widened at triple points; a lighter rim on the side of the cell facing up (the rock's +z in Blender), kept subtle since the game lights the rock too.
- **Striations**: an anisotropic fine noise inside cells, low contrast.
- **Pebbles**: a second, smaller cellular grid; a cell holds a pebble with a probability (the density setting), biased toward cells near a crack; a pebble is an ellipse with a dark rim and a light top; on a texel it replaces the dirt colour.
- Everything vectorised over the texels in numpy (`_map_texels` already returns each texel's world point and face normal; reuse it); a 2048 map is a few million texels at most.
- Settings to start with: clod size, crack width, crack darkness, tone colours (base, crack, highlight, pebble), pebble density, edge breakup, threshold, seed.

`moss.build.layer_map` already does the map plumbing (texel gathering, sRGB encode, straight alpha, `_bleed` past the coverage and the islands).
Lift it into a shared place (it is not moss-specific) and have both kinds call it with their own `paint_texels`.

### 3. Layer order in the game

`BodyVisual.mountFormation` hands a rock its layers in the body's object order, mixed in that order (`src/render3d/paintLayers.ts`, at most four).
Dirt should sit under moss whatever order they were painted in: sort the layers by kind (dirt, then moss) before `wearLayers`.
Decide with Tris whether dirt and moss on one rock should interact (moss erasing dirt under it is free: it is drawn over it).

### 4. Look iteration

Iterate the look on the Blender side first, before any editor work, on one known rock:

- Generate a test rock into a temp store (no `public/` writes): `bun run scripts/formation-build.ts <recipe.json> --bake --store <tmp>`; the fitted L used on 2026-11-25 was `{"generator": "fitted", "params": {"seed": 3}, "guide": {"kind": "collision", "pieces": [{"shape": {"kind": "poly", "verts": [{"x":0,"y":0},{"x":0.8,"y":0},{"x":0.8,"y":1.6},{"x":2.4,"y":1.6},{"x":2.4,"y":2.4},{"x":0,"y":2.4}]}}]}}` (about 20 s with the bake).
- Build a layer: a request JSON `{version: 1, host: <rock hash>, kind: "dirt", seed, stamps: [{p, n, r, s}], layer: true}` (points in the formation's frame: x right, y up, z toward the camera; the L's front face is z about 0.65, its top y 0) through `bun run scripts/decoration-build.ts <request.json> --store <tmp>`.
- See it as the game draws it: a scratch page under `rope/.cache/` (gitignored, served by the dev server) that imports `/src/render3d/formations.ts` (`loadFormationFile`), `/src/render3d/sceneDressing.ts` (`mountExport`) and `/src/render3d/paintLayers.ts` (`exposePaintUv`, `layered`, `paintLayerTexture`), loads `tier-0.glb` and `geometry.glb` of the rock side by side and renders them under a hemisphere and a directional light.
  The store route serves `/generated/<hash>/...` from `public/generated` only, so copy the two hash folders there for the look session and delete them after (new hashes, nothing references them; `public/generated` is outside vite's watcher).
- Compare against the reference at the game's zoom (about 200 px a metre at 1080p) and close up.

## Testing

Once the look is agreed:

- `scripts/test-formations.ts` (runs in `bun run test`): a dirt layer build on the test rock gives a `layer.png` whose coverage lies where the stamps are and nowhere on a face turned away from them; the pebble density setting scales the pebble count.
- Editor gestures (the palette Dirt button, paint, right-click grow, combining two dirt patches, Select picks a dirt patch through `paintLayerAt`) driven headlessly per memory reference_editor_cdp_harness.

## Hazards (paid for on 2026-11-25)

- Tris's dev server is on 3100 with an editor tab open; never `pkill` vite, never touch `levels/*.json` by hand, md5 `levels/ball.json` and `levels/paint/ball.json` before and after any headless editor run, and drive a scratch level copy (`PUT /api/levels/<scratch>` and `PUT /api/paint/<scratch>`, deleted after) in a fresh Chromium profile launched display-less.
- Never force-rebuild a rock hash his level draws: a geometry-only rebuild drops its bake tiers.
- Editing `src/server/formations.ts` restarts every dev server (it is a config dependency); say so when it happens.
- A rock generated before 2026-11-25 has no paint UV; a texture layer on it fails with "Generate it again"; Regenerate it first (it reads "Built by an older generator").

## Open, for Tris

- Should dirt erase where moss is painted over it, or simply lie under it? (Under is free.)
- Is "fewer stones" a fixed choice or a setting he wants to tune per patch?
- Production: no decoration build (mesh or layer) is shipped by the build or by publish yet; dirt inherits that gap with moss.
