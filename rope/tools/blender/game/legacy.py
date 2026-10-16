"""Ending an Edit Guides session a file was saved in.

Until 2026-10-16 the Game panel edited formation guides through the game
camera (Edit Guides): it drew each guide projected onto the gameplay plane
as a handle curve, made everything else unselectable while it ran, and wrote
the handles back into the guides on Done. It is gone (Tris: "I want to be able
to simply select a 2d guide in object mode, switch to edit mode, and move
around the points"), but a file saved during a session still holds its state,
with the scene locked. On load the session ends as Done ended it: edited
handles are written into their guides, everything selectable before is again,
and the handles go. A formation Delete marked stays: it is reported, not
retired.
"""

from __future__ import annotations

import json

import bpy
from mathutils import Vector

from .formations_addon import core

# The session's scene key and handle collection, under both names they had.
STATES = ("game_guide_edit_state", "formations_edit_state")
CLIPBOARDS = ("game_guide_clipboard", "formations_polygon_clipboard")
HANDLES = ("Game guide handles", "Formation outline handles")


def unproject(point, center, rock):
    """The point on `rock`'s outline plane that `point` (on the gameplay
    plane) is seen through from `center`, in rock-local X/Z."""
    inverse = core.authored_world(rock).inverted()
    origin = inverse @ center
    direction = inverse.to_3x3() @ (point - center)
    if abs(direction.y) < 1e-9:
        raise ValueError(rock.name + ": guide plane is edge-on to the game camera")
    t = -origin.y / direction.y
    if t <= 0:
        raise ValueError(rock.name + ": guide plane is behind the game camera")
    result = origin + direction * t
    return [result.x, result.z]


def handle_points(handle):
    points = [core.authored_world(handle) @ Vector(p.co[:3]) for p in handle.data.splines[0].points]
    for p in points:
        p.y = 0
    return points


def apply_handle(handle, center):
    """Write an edited handle into its formation's guide, as Done did."""
    points = handle_points(handle)
    baseline = json.loads(handle["formation_handle_baseline"])
    if len(points) == len(baseline) and all((p - Vector(q)).length < 1e-6 for p, q in zip(points, baseline)):
        return
    rock = next((r for r in core.formations() if r["formation_id"] == handle["formation_handle_owner"]), None)
    if rock is None:
        raise ValueError(handle.name + ": its formation is gone")
    core.write_outline(rock, [unproject(p, center, rock) for p in points])
    print("Game: applied", handle.name, "from the Edit Guides session the file was saved in")


def end_edit_session(scene):
    key = next((k for k in STATES if k in scene), None)
    if key is None:
        return
    state = json.loads(scene[key])
    center = Vector(state["center"])
    for name in HANDLES:
        col = bpy.data.collections.get(name)
        if col is None or col.library is not None:
            continue
        for handle in list(col.objects):
            if "formation_handle_owner" in handle:
                if handle.get("formation_handle_deleted"):
                    print("Game:", handle.name, "was marked Delete in the saved Edit Guides session; "
                          "its formation is kept")
                else:
                    try:
                        apply_handle(handle, center)
                    except (ValueError, IndexError) as e:
                        print("Game: could not apply", handle.name, "-", e)
            data = handle.data
            bpy.data.objects.remove(handle, do_unlink=True)
            if data is not None and data.users == 0:
                bpy.data.curves.remove(data)
        if not col.objects:
            bpy.data.collections.remove(col)
    for name, selectable in state.get("selectable", {}).items():
        ob = bpy.data.objects.get(name)
        if ob is not None and ob.library is None:
            ob.hide_select = not selectable
    for k in (*STATES, *CLIPBOARDS):
        if k in scene:
            del scene[k]


def end_edit_sessions():
    for scene in bpy.data.scenes:
        if scene.library is None:
            end_edit_session(scene)
