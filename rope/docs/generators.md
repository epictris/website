# Generators (retired)

From 2026-09-25 to 2026-09-29 the editor's Visuals workspace drove two procedural pipelines behind the dev server: **boulders** (a collision outline in, a fractured, bevelled, baked stone out) and **mushroom patches** (a painted surface in, a merged mesh of glowing mushrooms out).
Both ran Python and headless Blender, were keyed by a hash of their input, wrote to `public/generated/`, and were published through `assets:publish-generated` and pinned in `generatedAssets.json`.

They were retired with the level's geometry objects on 2026-09-29, when Blender took over every rendered mesh ([blender-scenes](blender-scenes.md), [plans/blender-owns-appearance.md](../plans/blender-owns-appearance.md)).
The service, its endpoints, the editor's generator panel and jobs, `generators:check` and the manifest are gone; the page as it stood is in git history (`docs/generators.md` at `bfa6597`).

What survives, in Blender rather than behind the editor:

- The **boulder generator** (`tools/blender/boulders`) is what the formations add-on builds a formation's rock with ([blender-formations](blender-formations.md)).
  `bun run generators:setup` still makes the `rope/.venv` it runs in (numpy, scipy, shapely).
- The **mushroom patch** add-on (`tools/blender/mushrooms/mushroom_patch_tools.py`) is a Blender add-on in its own right: a patch is grown in the scene file like any other dressing.
