# Hanging vines and ferns

The level editor's **Visuals** workspace includes **+ Hanging vine** and **+ Fern**. Their generators and painted atlases come from the newer `artifacts/hanging-vines/hanging-vines-share.zip`; the examples ZIP supplies reference exports. The extracted source and artwork live in `src/render3d/foliage`. `python scripts/import-foliage-pack.py` reproduces the import from the archive, including its fern placement scoring. The older SVG generator remains available for editing existing `vine-v3` plants.

Run `bun run dev` from `website/rope` and open `/editor.html`. Saving generated plants requires the development server. Plants are decorative geometry attached to the host body; they do not add physics collision.

For a vine, click its root on a drawn model, then click the same model to choose its initial crawl direction. Set length, leaf size and spacing, then choose **Preview vine**. **Shape and variation** exposes cling, bend, radius, seed, leaf angle, variation, natural colours and leaf selection. The leaf thumbnails include both painted leaves and silhouettes. **Import leaves** accepts images, adds them to the leaf picker and preserves the imported PNGs in the saved recipe. **Keep imported colours** controls their tint.

For a fern, click the crown on a model and optionally click again to aim its opening. Choose painted fronds, leaflets, or sprig, adjust its size and shape, then choose **Preview fern**. To fill a rock, select its geometry or a body containing exactly one geometry object and choose **Preview scatter**. Count, spacing and seed control the batch; placement scores surface support and clearance, and respects existing plant crowns.

**Apply** saves the current preview as one undoable editor action. **Edit selected plant** restores a saved plant's recipe and host; Apply replaces that plant. **Re-place**, **Re-aim**, **New seed**, **Reset** and **Cancel** let you revise the draft. Changing growth settings discards the previous preview. Preview wind can be enabled or adjusted without regenerating geometry. Escape cancels the draft.

Each new plant stores `public/generated-vines/<uuid>/vine.glb` and a version 2 `recipe.json`, referenced by a `foliage-v1:<uuid>:<bytes>` mesh key. Keep both files with the level: the mesh contains its painted textures and sway weights, while the sidecar contains editable settings, imported leaves and the host reference. Existing `vine-v3` keys continue to resolve to the same directory layout. Missing or changed hosts are reported rather than silently generating against another surface.

Growth checks the selected host's visible triangles and samples other generated plants on that body for clearance. These are bounded geometric checks, not a full physics simulation, and separate bodies are not obstacles. Dense previews are limited to 10,000 estimated fern blades and 600,000 vertices. Saved plants sway in the editor and game, with matching shadow motion; fern translucency is restored when their GLBs load.

Validation: `bun run typecheck`, `bun run scripts/test-foliage.ts`, and `bun run scripts/test-hanging-vines.ts`. `bun run build --config scripts/foliage-build.config.ts` verifies production bundles and imported atlases without copying unrelated public exports.
