"""The level's collision outlines: a visual reference, and a guide copied from one.

The COLLISION OUTLINES are the `guide.*` curves the scene links from
`<scene>-guide.blend` (`just scene-guide <level>`, tools/blender/scene_guide.py).
No rock is ever built from one, and nothing here writes to one. Create Guide
from Outline (`guide_from_outline`) copies one into a free guide, a local
curve in the Formations add-on's GUIDES that keeps nothing of where it came
from, so the editor can add, move or remove collision without any guide or
rock noticing. New Formation (Formations panel) builds from it.
"""

from __future__ import annotations

import math

import bpy
from mathutils import Matrix, Vector

from .formations_addon import core

# The collection `just scene-guide` links the level's collision in as
# (tools/blender/scene_guide.py GUIDE_COLLECTION).
COLLISION = "Guide"


def is_collision_outline(ob):
    """Whether `ob` is one of the level's collision outlines (a `guide.*`
    curve from the linked guide, or a copy of one made local), which is a
    reference only."""
    return (ob is not None and ob.type == "CURVE" and ob.name.startswith("guide.")
            and (ob.library is not None or ob.override_library is not None
                 or any(c.name == COLLISION or c.library is not None for c in ob.users_collection)))


def collision_outlines(scene=None):
    scene = scene or bpy.context.scene
    return [ob for ob in scene.objects if is_collision_outline(ob)]


def guide_from_outline(outline):
    """A free guide that is an exact copy of collision outline `outline`: the
    same points at the same place, as a 3D curve in its own X/Z plane (a
    formation's convention). It copies geometry and pose only, so it holds
    nothing that refers back to the outline, and the outline is not touched."""
    if not is_collision_outline(outline):
        raise ValueError("Pick one of the level's collision outlines")
    if len(outline.data.splines) != 1:
        raise ValueError("This outline has a hole (a belt's band); a guide is one closed polygon")
    sp = outline.data.splines[0]
    if sp.type != "POLY" or not sp.use_cyclic_u:
        raise ValueError("This outline is not a closed polygon")
    if outline.data.dimensions == "2D":
        points = [(p.co.x, p.co.y) for p in sp.points]
        # The flat curve's X/Y turned onto the guide's X/Z: the same world points.
        frame = core.authored_world(outline) @ Matrix.Rotation(-math.pi / 2, 4, "X")
    else:
        if any(abs(p.co.y) > .001 for p in sp.points):
            raise ValueError("This outline is not flat")
        points = [(p.co.x, p.co.z) for p in sp.points]
        frame = core.authored_world(outline).copy()
    core.validate_polygon([list(p) for p in points])
    curve = bpy.data.curves.new("Guide", "CURVE")
    curve.dimensions = "3D"
    line = curve.splines.new("POLY")
    line.points.add(len(points) - 1)
    for pt, (x, z) in zip(line.points, points):
        pt.co = (x, 0, z, 1)
    line.use_cyclic_u = True
    ob = bpy.data.objects.new("Guide", curve)
    col = core.collection(core.GUIDES)
    col.hide_render = True
    col.objects.link(ob)
    ob.matrix_world = frame
    core.style_guide_curve(ob)
    return ob


# --- Picking one in the viewport -----------------------------------------------

def screen_outline(region, rv3d, ob):
    """Collision outline `ob`'s outer polygon in `region`'s pixels, or None
    where part of it is behind the view."""
    from bpy_extras.view3d_utils import location_3d_to_region_2d
    if not ob.data.splines:
        return None
    world = core.authored_world(ob)
    points = []
    for p in ob.data.splines[0].points:
        q = location_3d_to_region_2d(region, rv3d, world @ Vector(p.co[:3]))
        if q is None:
            return None
        points.append(q)
    return points if len(points) >= 3 else None


def polygon_hit(points, x, y, reach=6.0):
    """Whether pixel (x, y) is inside `points` or within `reach` of an edge,
    and the polygon's area (the innermost of nested outlines wins a click)."""
    inside, near, area = False, False, 0.0
    for a, b in zip(points, points[1:] + points[:1]):
        area += a.x * b.y - b.x * a.y
        if (a.y > y) != (b.y > y) and x < a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y):
            inside = not inside
        ab = b - a
        t = 0.0 if ab.length_squared == 0 else max(0.0, min(1.0, (Vector((x, y)) - a).dot(ab) / ab.length_squared))
        near = near or (a + ab * t - Vector((x, y))).length <= reach
    return inside or near, abs(area) / 2


def view_region_at(context, x, y):
    """The 3D viewport's main region under window pixel (x, y), if any."""
    for area in context.window.screen.areas:
        if area.type != "VIEW_3D":
            continue
        for region in area.regions:
            if region.type == "WINDOW" and region.x <= x < region.x + region.width and region.y <= y < region.y + region.height:
                return region
    return None


def outline_at(context, x, y):
    """The collision outline under window pixel (x, y): the smallest one
    whose inside or edge the pixel is on."""
    region = view_region_at(context, x, y)
    if region is None:
        return None
    best = None
    for ob in collision_outlines(context.scene):
        if not ob.visible_get(view_layer=context.view_layer):
            continue
        points = screen_outline(region, region.data, ob)
        if points is None:
            continue
        hit, area = polygon_hit(points, x - region.x, y - region.y)
        if hit and (best is None or area < best[1]):
            best = (ob, area)
    return best[0] if best else None


def draw_hover(op):
    """Highlight the outline under the cursor in the region being drawn."""
    import gpu
    from gpu_extras.batch import batch_for_shader
    from mathutils.geometry import tessellate_polygon
    ob = next((o for o in collision_outlines(bpy.context.scene) if o.name == op._hover), None)
    region = bpy.context.region
    if ob is None or region is None or region.data is None:
        return
    points = screen_outline(region, region.data, ob)
    if points is None:
        return
    gpu.state.blend_set("ALPHA")
    flat = [(p.x, p.y) for p in points]
    fill = gpu.shader.from_builtin("UNIFORM_COLOR")
    tris = batch_for_shader(fill, "TRIS", {"pos": flat}, indices=tessellate_polygon([[(*p, 0) for p in flat]]))
    fill.bind()
    fill.uniform_float("color", (*core.GUIDE_COLOURS[0], .18))
    tris.draw(fill)
    line = gpu.shader.from_builtin("POLYLINE_UNIFORM_COLOR")
    line.uniform_float("viewportSize", (region.width, region.height))
    line.uniform_float("lineWidth", 2.0)
    line.uniform_float("color", (*core.GUIDE_COLOURS[0], 1.0))
    batch_for_shader(line, "LINE_STRIP", {"pos": flat + flat[:1]}).draw(line)
    gpu.state.blend_set("NONE")
