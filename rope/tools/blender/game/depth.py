"""Moving formations in depth from the game camera's (camera.py) eye."""

from __future__ import annotations

import bpy
from mathutils import Matrix, Vector

from .camera import eye
from .formations_addon import core


def move_depth(context, rocks, delta, keep_size=True):
    """Move formations `delta` metres away from the camera (negative: toward
    it). With `keep_size`, they scale about the game camera's eye so they keep
    their size and place on screen from there; without, it is a plain move."""
    if context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    roots = list(dict.fromkeys(core.placement(r) for r in rocks))
    if not roots:
        raise ValueError("Select formations first")
    center = eye(context.scene)
    pivot = sum(core.authored_world(root).translation.y for root in roots) / len(roots)
    if pivot - center.y <= .01 or pivot + delta - center.y <= .01:
        raise ValueError("Keep the formations in front of the game camera")
    ratio = (pivot + delta - center.y) / (pivot - center.y)
    transform = (Matrix.Translation(center) @ Matrix.Scale(ratio, 4) @ Matrix.Translation(-center)
                 if keep_size else Matrix.Translation((0, delta, 0)))
    for root in roots:
        for ob in [root, *root.children_recursive]:
            if ob.type == "MESH" and ob.data.vertices and not ob.get("formation_backup"):
                m = transform @ core.authored_world(ob)
                if any((m @ Vector(corner)).y - center.y <= .01 for corner in ob.bound_box):
                    raise ValueError("Move less far forward: part of a formation would pass the camera")
    # Backups hang from the placement they were taken on; they stay put.
    kept = {ob: core.authored_world(ob).copy() for root in roots for ob in root.children_recursive
            if ob.get("formation_backup")}
    for root in roots:
        core.set_authored_world(root, transform @ core.authored_world(root))
    for ob, matrix in kept.items():
        core.set_authored_world(ob, matrix)
    context.view_layer.update()
    return len(roots)
