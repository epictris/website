"""Everything of a level's Blender scene the editor now owns, as JSON, for
`scripts/migrate-scene.ts` (docs/formations.md, "Migrating a scene").

    blender -b assets-src/scenes/<scene>.blend --factory-startup --python-exit-code 1 \
        --python tools/blender/migrate_scene_dump.py -- OUT.json

Writes, in Blender's world frame (x right, y away from the camera, z up,
metres):

- every live formation (an object with a `formation_recipe`, not one of the
  "<name> / previous" copies a rebuild keeps): its name, its recipe, its world
  matrix, and for a solid one its guide mesh in the world;
- every moss and ivy: its kind, its frame host, its stamps in the host's
  local frame, and its settings (every plain property of its panel);
- every plant of the foliage add-on: its kind, its host, its world matrix,
  its seed and its settings.

Nothing is written back to the .blend.
"""

import json
import sys
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# Properties a decoration's settings never carry: what it is attached to, its
# paint, and the panel's own bookkeeping.
SKIP = {"host", "stamps", "live", "is_plant", "is_ivy", "joined", "status", "order", "kind_shown", "name", "rna_type"}


def settings_of(group):
    out = {}
    for prop in group.bl_rna.properties:
        key = prop.identifier
        if key in SKIP or prop.is_readonly or prop.type not in {"BOOLEAN", "INT", "FLOAT", "ENUM", "STRING"}:
            continue
        if getattr(prop, "is_array", False) or getattr(prop, "array_length", 0):
            continue
        value = getattr(group, key)
        if isinstance(value, (bool, int, float, str)):
            out[key] = value
    return out


def matrix(ob):
    return [list(r) for r in ob.matrix_world]


def main():
    out_path = Path(sys.argv[sys.argv.index("--") + 1])
    import ivy
    import moss
    import foliage
    ivy.register()
    moss.register()
    foliage.register()
    from moss.stampbrush import stamps as stamp_io

    formations, paints, plants = [], [], []
    for ob in bpy.data.objects:
        recipe = ob.get("formation_recipe")
        if recipe is not None and " / previous" not in ob.name and ob.type == "MESH" and not ob.library:
            r = json.loads(recipe)
            entry = {"name": ob.name, "recipe": r, "matrix": matrix(ob)}
            if r.get("generator") == "solid" and r.get("guide"):
                m = ob.matrix_world
                from mathutils import Vector
                entry["guideWorld"] = {"verts": [list(m @ Vector(v)) for v in r["guide"]["verts"]], "faces": r["guide"]["faces"]}
            formations.append(entry)
            continue
        for kind, attr in (("moss", "moss"), ("ivy", "ivy")):
            s = getattr(ob, attr, None)
            if s is None or ob.get("grown_by") != kind or not s.stamps:
                continue
            st = stamp_io.read(s.stamps)
            paints.append({
                "name": ob.name, "kind": kind, "host": s.host, "settings": settings_of(s),
                "stamps": [{"p": list(map(float, st.position[i])), "n": list(map(float, st.normal[i])),
                            "r": float(st.radius[i]), "s": float(st.strength[i])} for i in range(len(st))],
            })
        if ob.get("grown_by") == "foliage" and getattr(ob, "foliage", None) is not None and ob.foliage.is_plant:
            f = ob.foliage
            plants.append({"name": ob.name, "kind": f.kind, "host": f.host, "matrix": matrix(ob),
                           "seed": int(f.seed), "settings": settings_of(f)})
    out_path.write_text(json.dumps({"formations": formations, "paints": paints, "plants": plants}))
    print("MIGRATE_DUMP_OK", len(formations), "formations,", len(paints), "paints,", len(plants), "plants")


main()
