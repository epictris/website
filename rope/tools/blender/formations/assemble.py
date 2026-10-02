"""The worker's Blender half: join the generator's slabs into one rock.

    blender -b --factory-startup --python-exit-code 1 --python assemble.py -- OUT_DIR

Reads OUT_DIR/geometry.json and recipe.json (written by worker.py), assembles
the rock with the boulder generator's own `assemble_rock` - or, for the
`fitted` generator, builds recipe F's rocks fitted to the outline and fuses
them (fitted.py) -
gives it the painted slate (slate.py), dissolves the
microscopic faces its bevel and remesh can leave, validates it exactly as the
Formations panel will before swapping it in, and saves OUT_DIR/rock.blend
holding `SceneryRock` and its `SOURCE_SLABS`.
"""

import json
import sys
from pathlib import Path

import bmesh
import bpy

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "boulders"))
sys.path.insert(0, str(HERE.parent))
from blender_build import assemble_rock, mesh_health  # noqa: E402

from formations.core import validate_worker  # noqa: E402
from formations import fitted  # noqa: E402
from formations.slate import add_facets, painted_slate  # noqa: E402

out = Path(sys.argv[sys.argv.index("--") + 1])
recipe = json.loads((out / "recipe.json").read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
dst = bpy.data.collections.new("RESULT")
bpy.context.scene.collection.children.link(dst)
src = bpy.data.collections.new("SOURCE_SLABS")
bpy.context.scene.collection.children.link(src)
slate = painted_slate()
if recipe.get("generator", "boulders") == "fitted":
    # Recipe F's rocks and the core are the slabs; the rock is them fused.
    obj, _ = fitted.build(recipe["outline"], recipe["params"], src)
    dst.objects.link(obj)
else:
    # The generator tints its slabs from six slots (five stones and the worn
    # edge); a formation is one painted slate instead, its per-slab variety
    # carried by the shader's per-facet tone.
    obj = assemble_rock(json.loads((out / "geometry.json").read_text())["rocks"][0], dst, src, [slate] * 6)
obj.name = "SceneryRock"
obj["formation_recipe"] = (out / "recipe.json").read_text()
obj.data.polygons.foreach_set("material_index", [0] * len(obj.data.polygons))
obj.data.materials.clear()
obj.data.materials.append(slate)

# Bevel and remesh can collapse a triangle to nothing; dissolve only
# microscopic geometry, so the silhouette and the slabs are untouched.
bm = bmesh.new()
try:
    bm.from_mesh(obj.data)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=list(bm.edges))
    bm.normal_update()
    bm.to_mesh(obj.data)
    obj.data.update()
finally:
    bm.free()
add_facets(obj, recipe["params"]["seed"])

validate_worker(obj, src)
src.hide_render = True
src.hide_viewport = True
(out / "health.json").write_text(json.dumps(mesh_health(obj), indent=2))
bpy.ops.wm.save_as_mainfile(filepath=str(out / "rock.blend"))
print("FORMATION_ROCK_READY", flush=True)
