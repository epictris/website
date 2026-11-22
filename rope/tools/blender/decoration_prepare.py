"""One decoration on one formation's rock, as a .blend the scene exporter
grows and exports (docs/formations.md, "Decorations").

    blender -b STORE/<host>/rock.blend --factory-startup --python-exit-code 1 \
        --python tools/blender/decoration_prepare.py -- request.json OUT.blend

Run by `scripts/decoration-build.ts`, which then exports OUT.blend with the
scene exporter (`blendExport.ts`), the same growth and export a level's
Blender scene gets. `request.json`:

    {"id", "kind": "moss"|"ivy"|"fern"|"vine"|"mushroom"|"orbs"|"glow",
     "seed", "settings": {property: value}, "lens": mm,
     "at": {"p": [x, y, z], "n": [x, y, z]}          (a placed one)
     "stamps": [{"p", "n", "r", "s"}]}               (a painted one)

Points and normals are in the formation's frame as the level holds it (x
right, y up, z toward the camera); Blender's is (x, -z, y) of that.

What the add-ons read from a scene is given to them here, explicitly:

- the HOST: the rock as the game draws it, its long creases bowed as the
  export bows them (scene_export.straight_creases, curve.bend), named
  `formation` so the grown object is `formation.moss`, `formation.ivy`,
  `formation.fern` and the game's loader knows it by its name; hidden from the
  render, so the export grows on it and does not ship it again;
- the DEPTH: the rock stands in its body's frame, whose y = 0 is the play
  plane, so a stamp's depth behind the plane is its own Blender y;
- the LENS: `guide.camera`, which the detail budget reads its slope from
  (stampbrush/lod.py), at the level's focal length;
- the camera's DIRECTION: the add-ons face the game's camera as Blender -y,
  which this frame is already in.

A plant is grown alone, so it avoids no plant before it; placed decorations
are grown once where they stand and only moved after.
"""

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PLANTS = {"fern": "FERN", "vine": "VINE", "mushroom": "MUSHROOM", "orbs": "ORBS", "glow": "GLOW"}


def to_blender(v):
    return Vector((v[0], -v[2], v[1]))


def apply_settings(group, settings):
    for key, value in (settings or {}).items():
        if not hasattr(group, key):
            raise SystemExit(f"the {group.bl_rna.identifier} settings have no {key!r}")
        setattr(group, key, value)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    request = json.loads(Path(argv[0]).read_text())
    out = Path(argv[1])
    scene = bpy.context.scene
    host = bpy.data.objects.get("SceneryRock")
    if host is None:
        raise SystemExit("the host .blend holds no SceneryRock")

    # The rock as it is drawn.
    import scene_export
    from formations import curve, render
    if render.slate_rock(host) and render.setting(host, "export_creases"):
        bows = scene_export.straight_creases(host, host.data)
        curve.bend(host.data, bows)
    host.name = "formation"
    host.hide_render = True

    # The game camera's lens, for the detail budget.
    cam = bpy.data.cameras.new("guide.camera")
    cam.sensor_fit = "VERTICAL"
    cam.sensor_height = 24.0
    cam.lens = float(request.get("lens") or 24.0 / (2 * math.tan(math.radians(34) / 2)))
    co = bpy.data.objects.new("guide.camera", cam)
    scene.collection.objects.link(co)
    co.location = (0.0, -10.0, 0.0)
    co.rotation_euler = (math.radians(90), 0.0, 0.0)

    # Everything lands on the rock as drawn: a point is carried along its
    # normal onto the host (the nearest surface within REACH either way), as
    # the editor carries an anchor (src/editor/decorations.ts). What a placed
    # one landed on is handed back (OUT.landed.json).
    from mathutils.bvhtree import BVHTree
    bvh = BVHTree.FromObject(host, bpy.context.evaluated_depsgraph_get())
    reach = 0.75

    def land(p, n):
        best = None
        for d in (-n, n):
            hit = bvh.ray_cast(p - d * reach, d, 2 * reach)
            if hit[0] is not None and (best is None or abs((hit[0] - p).length) < abs((best[0] - p).length)):
                best = hit
        if best is None:
            return p, n
        normal = best[1] if best[1].dot(n) >= 0 else -best[1]
        return best[0], normal.normalized()

    kind = request["kind"]
    landed = None
    if kind == "moss":
        import moss
        moss.register()
        from moss import ops
        from moss.stampbrush import stamps as stamp_io
        ob = ops.create_moss(host, scene)
        apply_settings(ob.moss, request.get("settings"))
    elif kind == "ivy":
        import ivy
        ivy.register()
        from ivy import ops
        from ivy.stampbrush import stamps as stamp_io
        ob = ops.create_ivy(host, scene)
        apply_settings(ob.ivy, request.get("settings"))
    elif kind in PLANTS:
        import foliage
        foliage.register()
        from foliage import ops
        at = request["at"]
        p, n = land(to_blender(at["p"]), to_blender(at["n"]).normalized())
        landed = {"p": [p.x, p.z, -p.y], "n": [n.x, n.z, -n.y]}
        # A plant leans toward the game's camera (Blender -y) from its root.
        ob = ops.create_plant(PLANTS[kind], host, scene, p, n, Vector((0.0, -1.0, 0.0)))
        apply_settings(ob.foliage, request.get("settings"))
        if request.get("seed") is not None:
            ob.foliage.seed = int(request["seed"])
    else:
        raise SystemExit(f"no decoration kind {kind!r}")

    if kind in ("moss", "ivy"):
        stamps = request.get("stamps") or []
        if not stamps:
            raise SystemExit("a painted decoration with no strokes")
        carried = [land(to_blender(x["p"]), to_blender(x["n"]).normalized()) for x in stamps]
        s = stamp_io.Stamps.empty().appended([(tuple(p), tuple(n), x["r"], x["s"]) for (p, n), x in zip(carried, stamps)])
        settings = ob.moss if kind == "moss" else ob.ivy
        stamp_io.write(settings.stamps, s)
        if request.get("seed") is not None and hasattr(settings, "seed"):
            settings.seed = int(request["seed"])

    if landed is not None:
        out.with_suffix(".landed.json").write_text(json.dumps(landed))
    bpy.ops.wm.save_as_mainfile(filepath=str(out), copy=True)
    print("DECORATION_PREPARED", ob.name, flush=True)


main()
