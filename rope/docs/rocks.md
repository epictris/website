# Generated rocks (retired)

From 2026-09-23 to 2026-09-24 a level's rock was drawn as faceted boulders built offline in headless Blender from its geometry objects' outlines, one GLB per level (`tools/blender/rocks.py`, `scripts/generate-rocks.ts`, `public/rocks/<level>.glb`).
The owner rejected the results ("too messy, the texture doesn't look good"), and rocks became hand-authored props; the game stopped loading the GLB the same day.
The generator, `cli rocks-check`, `tools/blender/check.py` and the editor's "Fit collision to rock" (`lib/silhouette.ts`) lingered until 2026-09-29, when the level's geometry objects were retired and Blender took over every rendered mesh ([blender-scenes](blender-scenes.md)); all of it is gone.

Do not resurrect the pipeline or its constants.
The page as it stood - the reference and actual outlines, the rock material, the chunking and every lesson it cost - is in git history (`docs/rocks.md` at `bfa6597`).
A rock is now modelled in Blender, and the formations add-on ([blender-formations](blender-formations.md)) builds one from a guide, which the Game add-on ([blender-game](blender-game.md)) edits through the game camera.
