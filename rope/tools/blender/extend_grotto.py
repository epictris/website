"""Dress the river grotto's right bank through editable solid guides.

Run: blender -b assets-src/scenes/river.blend --python tools/blender/extend_grotto.py
Existing named additions are kept, so rerunning preserves subsequent edits.
Pass -- --smooth-guides to round the existing east-bank guides and rebuild.
"""
import json
import shutil
import sys
from pathlib import Path

import bpy
import bmesh

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backdrop
from formations import core, growth

# Front silhouettes in world X/Z, extruded into the background. Feet overlap
# beneath the pool; staggered shelves leave the foreground route readable.
PIECES = [
    ("east-low-bank", 12, 19, 101, [(20,-10.6),(29,-10.6),(29.4,-8.8),(27.6,-8.3),(25.4,-8.4),(24,-8.0),(21.1,-8.2),(20,-8.8)]),
    ("east-high-shelf", 19, 27, 102, [(24,-10.7),(34,-10.7),(34,-6.9),(32.8,-6.4),(30.7,-6.6),(29,-6.0),(26.8,-6.2),(25,-7.0)]),
    ("east-split-pillar", 22, 28, 103, [(31.8,-10.8),(35.6,-10.8),(36,-7.4),(35.5,-4.1),(34.5,-3.6),(33.1,-3.9),(32.4,-5.4)]),
    ("east-water-shelf", 11, 17, 104, [(29,-10.6),(38,-10.6),(38.3,-8.7),(36.8,-8.3),(35.1,-8.5),(33.5,-8.1),(31,-8.5),(29.4,-9.0)]),
    ("east-end-bank", 17, 27, 105, [(36,-10.8),(43,-10.8),(44,-8),(43,-5.7),(41,-5.4),(39.4,-6.1),(38,-6.3),(36.6,-7.6)]),
    ("east-pool-rock", 7, 11, 106, [(26,-10.3),(29.1,-10.3),(29.3,-9.2),(28.7,-8.6),(27.5,-8.5),(26.3,-9.1)]),
]


def round_guide(guide):
    """Round the solid's corners, including its front-to-side transitions."""
    bm = bmesh.new()
    bm.from_mesh(guide.data)
    spans = [max(v.co[i] for v in bm.verts) - min(v.co[i] for v in bm.verts) for i in range(3)]
    width = min(1.1, min(spans) * 0.28)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=width, segments=5,
                    affect="EDGES", profile=0.5, clamp_overlap=True)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    if any(not e.is_manifold for e in bm.edges):
        bm.free()
        raise RuntimeError(guide.name + ": rounded guide is not closed")
    bm.to_mesh(guide.data)
    bm.free()
    guide.data.update()
    print("EAST_ROUND", guide.name, "radius", round(width, 3), flush=True)


def main():
    path = Path(bpy.data.filepath)
    if path.name != "river.blend":
        raise RuntimeError("This composition is authored for river.blend")
    smoothing = "--smooth-guides" in sys.argv
    backup = path.with_name("river.blend.pre-east-smoothing" if smoothing else "river.blend.pre-east-bank")
    if not backup.exists():
        shutil.copy2(path, backup)
    for name, front, back, seed, outline in PIECES:
        name = "backdrop." + name
        existing = bpy.data.objects.get(name)
        if existing:
            if smoothing:
                growth.clear(existing)
            if smoothing and not existing.get("east_guide_rounded"):
                core.assert_rebuildable(existing)
                round_guide(bpy.data.objects[existing["formation_outline"]])
                core.replace_from_worker(existing, backdrop.run_worker(core.recipe_for(existing)))
                assert not core.pending(existing), name
                existing["east_guide_rounded"] = True
                bpy.ops.wm.save_as_mainfile(filepath=str(path))
            continue
        n = len(outline)
        verts = [(x, y, z) for y in (front, back) for x, z in outline]
        faces = [tuple(range(n)), tuple(range(n, 2*n))]
        faces += [(i, (i+1)%n, (i+1)%n+n, i+n) for i in range(n)]
        guide = backdrop.mesh_object(name + " seed", verts, faces, core.collection("East bank construction"))
        round_guide(guide)
        rock = backdrop.create(name, guide, {"seed": seed, "stoneSize": 0.85})
        rock["east_guide_rounded"] = True
        bpy.data.objects.remove(guide, do_unlink=True)
        rock.formation_attachment = "FLOOR"
        rock.formation_moisture = 0.65
        # Stable identity; foliage is authored separately with the painter.
        rock["formation_id"] = name
        rock.parent["formation_root"] = name
        if core.pending(rock):
            raise RuntimeError(name + " was not built from its saved guide")
        bpy.ops.wm.save_as_mainfile(filepath=str(path))
    bpy.ops.wm.save_as_mainfile(filepath=str(path))
    print("EAST_COMPLETE", json.dumps(["backdrop." + p[0] for p in PIECES]), flush=True)


if __name__ == "__main__":
    main()
