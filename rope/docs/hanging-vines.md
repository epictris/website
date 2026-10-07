# Hanging vines and ferns

Open the level editor's **Visuals** workspace and choose **+ Hanging vine** or **+ Fern**. These use the painted generators and atlases from the hanging-vines artifact pack, ported from the other branch.

For a vine, click its root on a Blender model, then click the same model to choose the crawl direction. Adjust length, leaves and shape, choose **Preview vine**, and **Apply** to save. For a fern, click its crown on a model, optionally click again to aim it, then **Preview fern** and **Apply**. To scatter ferns, choose a host in **Plant or host**, adjust count and spacing, and choose **Preview scatter**.

The plant picker also lists saved plants. Select one and choose **Edit selected plant** to restore its settings, or **Remove selected plant** to delete it. Apply, replacement and removal are undoable. Preview controls include seed, individual leaves, imported leaves, natural colours and wind. Escape cancels the draft.

Plants are decorative and do not add collision. They are attached to Blender model surfaces: bound models carry them with their body; scenery hosts keep them in the backdrop. The level's `foliage` list stores each plant's mesh key, stable scene host and host-local matrix in metres. Missing hosts are reported instead of moving plants to another surface.

Saving requires the local development server. Keep each plant's `public/generated-vines/<uuid>/vine.glb` and `recipe.json` beside the level. The GLB contains painted textures and sway weights; the recipe retains editable settings and imported leaves. The models render in the game as well as the editor.

Checks: `bun run typecheck`, `bun run scripts/test-foliage.ts`, `bun run scripts/test-hanging-vines.ts`, and `bun run build`.
