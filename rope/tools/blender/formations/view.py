"""Looking through the game, and editing outlines as the game sees them.

THE GAME CAMERA is `guide.camera`, which `just scene-guide <level>` bakes into
the level's guide (linked into the scene): the level's lens, animated through
the real camera controller along the level's camera paths or along a recorded
run (src/sim/cameraTrack.ts). `look_through` makes it the scene camera and
gives the scene its frame rate, range and 16:9 frame, so the viewport's camera
view and a render are the game's view at that frame of the route.

EDITING BY PROJECTION. A formation's outline is a polygon in its own X/Z plane,
which may stand tens of metres behind the gameplay plane, tilted and scaled by
its placement. What matters is where its silhouette lands on screen, so the
outlines are edited as they are SEEN: each is projected from the game camera's
eye (at the current frame) onto the gameplay plane, Blender y = 0, as a flat
2D handle curve, and an edited handle point goes back along its camera ray to
the formation's own outline plane. Depth, tilt, mirroring and scale all
survive, and in the camera view a handle sits exactly on the rock it shapes.

Handles are construction only: they live in HANDLES (never rendered), and
every change is validated before any outline is written.
"""

from __future__ import annotations

import json
import math
import uuid

import bpy
from mathutils import Matrix, Vector

from . import core

HANDLES = "Formation outline handles"
STATE = "formations_edit_state"
CLIPBOARD = "formations_polygon_clipboard"
HANDLE_COLOR = (.95, .44, .16, 1)


# --- The game camera ---------------------------------------------------------

def game_camera(scene):
    """The guide's game camera: the scene camera if it is one, else any."""
    if scene.camera is not None and "game_fps" in scene.camera:
        return scene.camera
    return next((ob for ob in scene.objects if ob.type == "CAMERA" and "game_fps" in ob), None)


def eye(scene):
    cam = game_camera(scene)
    if cam is None:
        raise ValueError("No game camera: run `just scene-guide <level>` and reopen the file")
    return cam.matrix_world.translation.copy()


def look_through(context):
    """Make the game camera the scene's, and every 3D view look through it."""
    scene = context.scene
    cam = game_camera(scene)
    if cam is None:
        raise ValueError("No game camera: run `just scene-guide <level>` and reopen the file")
    scene.camera = cam
    scene.render.fps = int(cam["game_fps"])
    scene.render.fps_base = 1
    scene.frame_start = 1
    scene.frame_end = int(cam["game_frames"])
    scene.render.resolution_x = 1920
    scene.render.resolution_y = round(1920 / float(cam.get("game_aspect", 16 / 9)))
    scene.render.resolution_percentage = 100
    cam.data.show_passepartout = True
    cam.data.passepartout_alpha = .85
    for window in context.window_manager.windows:
        for area in window.screen.areas:
            if area.type != "VIEW_3D":
                continue
            space = area.spaces.active
            space.region_3d.view_perspective = "CAMERA"
            space.lock_camera = False
            # The outline handles and the guide's wires are overlays.
            space.overlay.show_overlays = True
            space.clip_end = max(space.clip_end, cam.data.clip_end)
    return cam


# --- Projection ----------------------------------------------------------------

def project(point, center):
    """`point` as seen from `center`, on the gameplay plane (y = 0)."""
    if point.y - center.y <= 1e-6:
        raise ValueError("Outline lies behind the game camera")
    return center + (point - center) * (-center.y / (point.y - center.y))


def unproject(point, center, rock):
    """The point on `rock`'s outline plane that `point` (on the gameplay
    plane) is seen through from `center`, in rock-local X/Z."""
    inverse = core.authored_world(rock).inverted()
    origin = inverse @ center
    direction = inverse.to_3x3() @ (point - center)
    if abs(direction.y) < 1e-9:
        raise ValueError(rock.name + ": outline plane is edge-on to the game camera")
    t = -origin.y / direction.y
    if t <= 0:
        raise ValueError(rock.name + ": outline plane is behind the game camera")
    result = origin + direction * t
    return [result.x, result.z]


# --- Handles -----------------------------------------------------------------

def handles():
    col = bpy.data.collections.get(HANDLES)
    return [ob for ob in col.objects if "formation_handle_owner" in ob] if col else []


def live_handles():
    return [h for h in handles() if not h.get("formation_handle_deleted")]


def handle_points(ob):
    """A handle's points in world space, on the gameplay plane."""
    if ob.type != "CURVE" or len(ob.data.splines) != 1:
        raise ValueError(ob.name + ": keep one polygon per formation")
    spline = ob.data.splines[0]
    if spline.type != "POLY" or not spline.use_cyclic_u:
        raise ValueError(ob.name + ": the outline must be a closed polygon")
    points = [core.authored_world(ob) @ Vector(p.co[:3]) for p in spline.points]
    for p in points:
        # A handle is a 2D canvas; depth is never an authored value.
        p.y = 0
    return points


# A native 2D curve's local X/Y, turned onto the world X/Z plane: point editing
# has no third axis to wander into.
PLANE = Matrix.Rotation(math.pi / 2, 4, "X")


def make_handle(name, points, owner_id, matrix):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "2D"
    curve.fill_mode = "NONE"
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    spline.use_cyclic_u = True
    for pt, world in zip(spline.points, points):
        pt.co = (world.x, world.z, 0, 1)
    ob = bpy.data.objects.new(name, curve)
    core.collection(HANDLES).objects.link(ob)
    core.collection(HANDLES).hide_render = True
    ob.matrix_world = PLANE
    ob.lock_location = (False, True, False)
    ob.lock_rotation = (True, True, True)
    ob.lock_scale = (False, False, True)
    ob.hide_render = True
    ob.show_in_front = True
    ob.color = HANDLE_COLOR
    ob["formation_handle_owner"] = owner_id
    ob["formation_handle_baseline"] = json.dumps([list(p) for p in points])
    ob["formation_handle_matrix"] = json.dumps([list(row) for row in matrix])
    return ob


def state(scene):
    return json.loads(scene[STATE]) if STATE in scene else None


def owner_for(handle):
    return next((r for r in core.formations() if r["formation_id"] == handle["formation_handle_owner"]), None)


def flush_edit_mode():
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")


def changed_outlines(scene):
    """Every edited handle, validated, before any outline is touched."""
    s = state(scene)
    if s is None:
        return []
    center = Vector(s["center"])
    result = []
    for handle in live_handles():
        points = handle_points(handle)
        baseline = json.loads(handle["formation_handle_baseline"])
        if len(points) == len(baseline) and all((p - Vector(q)).length < 1e-6 for p, q in zip(points, baseline)):
            continue
        rock = owner_for(handle)
        if rock is None:
            raise ValueError("An edited formation was deleted; discard and edit again")
        placed = json.loads(handle["formation_handle_matrix"])
        if any(abs(a - b) > 1e-6 for r1, r2 in zip(core.authored_world(rock), placed) for a, b in zip(r1, r2)):
            raise ValueError(rock.name + ": moved while its outline was being edited; discard and edit again")
        outline = [unproject(p, center, rock) for p in points]
        core.validate_polygon(outline)
        core.assert_rebuildable(rock)
        result.append((handle, rock, outline, points))
    return result


def apply_outlines(scene):
    """Write edited handles into their outlines and retire deleted formations.
    Returns how many outlines changed."""
    flush_edit_mode()
    changed = changed_outlines(scene)
    for handle, rock, outline, points in changed:
        core.write_outline(rock, outline)
        handle["formation_handle_baseline"] = json.dumps([list(p) for p in points])
    s = state(scene)
    if s is not None:
        for handle in [h for h in handles() if h.get("formation_handle_deleted")]:
            rock = owner_for(handle)
            if rock is not None and rock.get("formation_new"):
                # Never built: there is nothing to keep.
                core.remove_formation(rock)
            elif rock is not None:
                retire(rock)
            remove_handle(handle)
        s["new_owners"] = []
        scene[STATE] = json.dumps(s)
    return len(changed)


def retire(rock):
    """Delete a formation reversibly: it and everything on its placement move to
    the backups, hidden."""
    backups = core.helper_collection(core.BACKUPS)
    root = core.placement(rock)
    rock["formation_backup"] = True
    for ob in [root, *root.children_recursive]:
        if any(c.name in (core.RECIPES,) or c.name.startswith("Sources /") for c in ob.users_collection):
            continue
        core.move(ob, backups)


def remove_handle(handle):
    data = handle.data
    bpy.data.objects.remove(handle, do_unlink=True)
    if data.users == 0:
        bpy.data.curves.remove(data)


def finish(scene, apply=True):
    """Leave outline editing, applying or discarding what was edited."""
    flush_edit_mode()
    s = state(scene)
    if s is None:
        return
    if apply:
        apply_outlines(scene)
    else:
        for rid in s.get("new_owners", []):
            rock = next((r for r in core.formations() if r["formation_id"] == rid), None)
            if rock:
                core.remove_formation(rock)
    for name, selectable in s["selectable"].items():
        ob = bpy.data.objects.get(name)
        if ob:
            ob.hide_select = not selectable
    for handle in handles():
        remove_handle(handle)
    col = bpy.data.collections.get(HANDLES)
    if col and not col.objects:
        bpy.data.collections.remove(col)
    del scene[STATE]


def start(context, targets):
    """Project `targets`' outlines from the game camera's eye and enter point
    editing on them, looking through the game camera."""
    scene = context.scene
    finish(scene, apply=True)
    if not targets:
        raise ValueError("No formations to edit")
    look_through(context)
    center = eye(scene)
    projected = [(rock, [project(core.authored_world(rock) @ Vector((x, 0, z)), center)
                         for x, z in core.recipe_for(rock)["outline"]]) for rock in targets]
    scene[STATE] = json.dumps({"center": list(center), "frame": scene.frame_current,
                               "selectable": {ob.name: not ob.hide_select for ob in scene.objects},
                               "new_owners": []})
    # Only the handles take clicks while editing.
    for ob in scene.objects:
        ob.hide_select = True
    for rock, points in projected:
        make_handle("Outline / " + rock.name, points, rock["formation_id"], core.authored_world(rock))
    resume_points(context)


def resume_points(context, active=None):
    flush_edit_mode()
    bpy.ops.object.select_all(action="DESELECT")
    available = live_handles()
    for handle in available:
        handle.hide_select = False
        handle.select_set(True)
    if available:
        context.view_layer.objects.active = active if active in available else available[0]
        bpy.ops.object.mode_set(mode="EDIT")


def selected_handles(context):
    editing = context.mode == "EDIT_CURVE"
    flush_edit_mode()
    available = live_handles()
    if editing:
        return [h for h in available if any(p.select for p in h.data.splines[0].points)]
    return [h for h in available if h.select_get()]


def create_polygon(context, entry, offset=(0., 0.)):
    """A new formation from a polygon drawn on the gameplay plane: placed like
    the formation it was copied from (else upright at the edited formations'
    mean depth), awaiting its first rebuild."""
    scene = context.scene
    s = state(scene)
    center = Vector(s["center"])
    points = [Vector((p[0] + offset[0], 0, p[2] + offset[1])) for p in entry["points"]]
    core.validate_polygon([[p.x, p.z] for p in points])
    rid = str(uuid.uuid4())
    name = entry.get("name", "New formation")
    col = core.collection(core.FORMATIONS)
    root = bpy.data.objects.new(name + " / placement", None)
    col.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = .2
    root["formation_root"] = rid
    if entry.get("placement"):
        root.matrix_world = Matrix(entry["placement"])
    else:
        depths = [core.authored_world(core.placement(r)).translation.y for r in core.formations()]
        root.location.y = sum(depths) / len(depths) if depths else 10
    rock = bpy.data.objects.new(name, bpy.data.meshes.new(name))
    col.objects.link(rock)
    rock.parent = root
    rock["formation_id"] = rid
    rock["formation_mode"] = "PROCEDURAL"
    rock["formation_new"] = True
    rock.formation_attachment = entry.get("attachment", "FLOOR")
    rock.formation_moisture = entry.get("moisture", .55)
    context.view_layer.update()
    recipe = json.loads(json.dumps(entry["recipe"]))
    recipe["outline"] = [unproject(p, center, rock) for p in points]
    rock["formation_recipe"] = json.dumps(recipe)
    rock["formation_outline"] = core.outline_object(recipe["outline"], rock.name + " / outline", rock).name
    core.seal(rock)
    for ob in (rock, root):
        s["selectable"][ob.name] = True
        ob.hide_select = True
    s["new_owners"].append(rid)
    scene[STATE] = json.dumps(s)
    handle = make_handle("Outline / " + rock.name, points, rid, core.authored_world(rock))
    for pt in handle.data.splines[0].points:
        pt.select = True
    return handle


def polygon_action(context, action):
    """Copy, paste, new, delete, add a point, remove points."""
    scene = context.scene
    selected = selected_handles(context)
    active = None
    if action in ("COPY", "DELETE", "ADD_POINT", "REMOVE_POINT") and not selected:
        raise ValueError("Select outline points first (Tab toggles points and outlines)")
    if action == "COPY":
        entries = []
        for handle in selected:
            points = handle_points(handle)
            core.validate_polygon([[p.x, p.z] for p in points])
            rock = owner_for(handle)
            entries.append({"name": rock.name + " copy", "recipe": core.recipe_for(rock),
                            "points": [list(p) for p in points],
                            "placement": [list(row) for row in core.authored_world(core.placement(rock))],
                            "attachment": rock.formation_attachment,
                            "moisture": rock.formation_moisture})
        scene[CLIPBOARD] = json.dumps(entries)
        return f"Copied {len(entries)} outlines"
    if action in ("PASTE", "NEW"):
        if action == "PASTE":
            entries = json.loads(scene.get(CLIPBOARD, "[]"))
            if not entries:
                raise ValueError("Copy an outline first")
        else:
            x, z = scene.cursor.location.x, scene.cursor.location.z
            entries = [{"name": "New formation", "recipe": {"version": 1, "preset": "wall", "params": {}},
                        "points": [[x - 1, 0, z - 1], [x + 1, 0, z - 1], [x + 1, 0, z + 1], [x - 1, 0, z + 1]]}]
        for h in handles():
            for p in h.data.splines[0].points:
                p.select = False
        for entry in entries:
            active = create_polygon(context, entry, (.25, .25) if action == "PASTE" else (0., 0.))
        resume_points(context, active)
        return "Added; rebuild changed formations to generate the rock"
    if action == "DELETE":
        for handle in selected:
            handle["formation_handle_deleted"] = True
            handle.hide_set(True)
            handle.select_set(False)
        resume_points(context)
        return "Removed; apply to keep (the formations go to the backups), or discard"
    changes = []
    for handle in selected:
        old = list(handle.data.splines[0].points)
        chosen = [i for i, p in enumerate(old) if p.select]
        if not chosen:
            raise ValueError("Select points on the outline first")
        if action == "REMOVE_POINT":
            values = [(p.co.copy(), False) for i, p in enumerate(old) if i not in chosen]
        else:
            edges = {i for i in chosen if (i + 1) % len(old) in chosen}
            if not edges and len(chosen) == 1:
                edges = {chosen[0]}
            if not edges:
                raise ValueError("Select one point, or neighbouring points, to add a midpoint")
            values = []
            for i, p in enumerate(old):
                values.append((p.co.copy(), False))
                if i in edges:
                    values.append(((p.co + old[(i + 1) % len(old)].co) * .5, True))
        core.validate_polygon([[p.x, p.y] for p, _ in values])
        changes.append((handle, values))
    for handle, values in changes:
        handle.data.splines.clear()
        spline = handle.data.splines.new("POLY")
        spline.use_cyclic_u = True
        spline.points.add(len(values) - 1)
        for p, (co, select) in zip(spline.points, values):
            p.co = co
            p.select = select
    resume_points(context, selected[0])
    return "Points changed"


# --- Depth ---------------------------------------------------------------------

def move_depth(context, rocks, delta, keep_size=True):
    """Move formations `delta` metres away from the camera (negative: toward
    it). With `keep_size`, they scale about the game camera's eye so they keep
    their size and place on screen from there; without, it is a plain move."""
    flush_edit_mode()
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
    s = state(context.scene)
    snapshots = []
    if s is not None:
        # Unapplied handle edits follow their formation, in its own frame.
        edit_center = Vector(s["center"])
        by_id = {r["formation_id"]: r for r in rocks}
        for handle in handles():
            rock = by_id.get(handle["formation_handle_owner"])
            if rock is None:
                continue
            points = [unproject(p, edit_center, rock) for p in handle_points(handle)]
            baseline = [unproject(Vector(p), edit_center, rock) for p in json.loads(handle["formation_handle_baseline"])]
            snapshots.append((handle, rock, points, baseline, edit_center))
    for root in roots:
        core.set_authored_world(root, transform @ core.authored_world(root))
    for ob, matrix in kept.items():
        core.set_authored_world(ob, matrix)
    for handle, rock, points, baseline, edit_center in snapshots:
        matrix = core.authored_world(rock)
        inverse = core.authored_world(handle).inverted()
        for pt, (x, z) in zip(handle.data.splines[0].points, points):
            local = inverse @ project(matrix @ Vector((x, 0, z)), edit_center)
            pt.co = (local.x, local.y, 0, 1)
        handle["formation_handle_baseline"] = json.dumps(
            [list(project(matrix @ Vector((x, 0, z)), edit_center)) for x, z in baseline])
        handle["formation_handle_matrix"] = json.dumps([list(row) for row in matrix])
    context.view_layer.update()
    return len(roots)
