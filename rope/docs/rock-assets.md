# Rock and moss props (retired)

From 2026-09-24 to 2026-09-29 a rock in a level was a hand-authored prop modelled in headless Blender from its body's collision outline (`tools/blender/rock_asset.py`, driven by `bun run assets:rock` from a job file), and the moss on it a second prop grown from the rock's surface; both were placed in the level as `kind: "mesh"` geometry objects and published as `MESH_ASSETS` entries (`rock-196`, `moss-145`, ...).

On 2026-09-29 the level's geometry objects were retired and Blender took over every rendered mesh ([blender-scenes](blender-scenes.md)).
The placed props were exported into `river.blend`'s `Dressing` collection with the rest of the level's look, their manifest entries were pruned, and `rock_asset.py`, `scripts/rock-asset.ts` and `tools/rock-texture.py` are gone.
The loop, the job file, how a rock and its moss were made, the texture treatment and how to judge a result are in git history (`docs/rock-assets.md` at `bfa6597`), and still the best record of what reads well for this camera.
A rock is now modelled in the scene file itself; the formations add-on ([blender-formations](blender-formations.md)) and the moss add-on ([blender-moss](blender-moss.md)) are the tools for it.
