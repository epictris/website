"""The worker's Blender half: join the generator's slabs into one rock.

    blender -b --factory-startup --python-exit-code 1 --python assemble.py -- OUT_DIR

Reads OUT_DIR/geometry.json and recipe.json (written by worker.py), assembles
the rock with the boulder generator's own `assemble_rock`, dissolves the
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
from params import param  # noqa: E402
from stone_materials import stone_material, worn_edge_color  # noqa: E402

from formations.core import validate_worker  # noqa: E402

out = Path(sys.argv[sys.argv.index("--") + 1])
rock = json.loads((out / "geometry.json").read_text())["rocks"][0]
spec = rock["spec"]
bpy.ops.wm.read_factory_settings(use_empty=True)
dst = bpy.data.collections.new("RESULT")
bpy.context.scene.collection.children.link(dst)
src = bpy.data.collections.new("SOURCE_SLABS")
bpy.context.scene.collection.children.link(src)
mats = [stone_material("Stone " + str(i), spec["color"], .88 + i * param(spec, "variation"), spec) for i in range(5)]
mats.append(stone_material("Worn stone", worn_edge_color(spec["color"], spec), 1, spec))
obj = assemble_rock(rock, dst, src, mats)
obj.name = "SceneryRock"
obj["formation_recipe"] = (out / "recipe.json").read_text()

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

validate_worker(obj, src)
src.hide_render = True
src.hide_viewport = True
(out / "health.json").write_text(json.dumps(mesh_health(obj), indent=2))
bpy.ops.wm.save_as_mainfile(filepath=str(out / "rock.blend"))
print("FORMATION_ROCK_READY", flush=True)
