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

import re

import bpy
from bpy.app.handlers import persistent
from mathutils import Vector

from .formations_addon import core

# The collection `just scene-guide` links the level's collision in as
# (tools/blender/scene_guide.py GUIDE_COLLECTION).
COLLISION = "Guide"
ORIGIN = re.compile(r"\.origin(\.\d+)?$")


def from_guide(ob):
    """Whether `ob` is a `guide.*` object of the linked guide, or a copy of one
    made local."""
    return (ob is not None and ob.name.startswith("guide.")
            and (ob.library is not None or ob.override_library is not None
                 or any(c.name == COLLISION or c.library is not None for c in ob.users_collection)))


def is_collision_outline(ob):
    """Whether `ob` is one of the level's collision outlines (a `guide.*`
    curve from the linked guide, or a copy of one made local), which is a
    reference only."""
    return from_guide(ob) and ob.type == "CURVE"


def collision_outlines(scene=None):
    scene = scene or bpy.context.scene
    return [ob for ob in scene.objects if is_collision_outline(ob)]


# --- Showing them ---------------------------------------------------------------

def shown_with_outlines(scene):
    """What an opacity of 0 hides: every outline, and the
    `guide.<name>.origin` empty on each body's origin beside them (`.001`
    and on where bodies share a name)."""
    return [ob for ob in scene.objects if is_collision_outline(ob)
            or (from_guide(ob) and ob.type == "EMPTY" and ORIGIN.search(ob.name))]


def outlines_shown(scene):
    """Whether any outline is shown in the view layer (the eye in the
    outliner), which is what the viewport shows."""
    layer = bpy.context.view_layer
    return any(not ob.hide_get(view_layer=layer) for ob in collision_outlines(scene))


# The fill's Mix Shader whose factor is its opacity, and the opacity the guide
# is written with (tools/blender/scene_guide.py OPACITY_NODE, SOLID_ALPHA).
OPACITY_NODE = "Opacity"
DEFAULT_OPACITY = .35


def sync_fills(scene):
    """Give every solid outline's fill the scene's opacity. The fills are the
    guide file's, linked: Blender lets them be set but never saves it, and a
    reload of the guide brings back the file's own, so this runs on every
    depsgraph update and writes only what differs (a write is an update)."""
    opacity = scene.game_outline_opacity
    for mat in bpy.data.materials:
        if mat.library is None or mat.node_tree is None:
            continue
        mix = mat.node_tree.nodes.get(OPACITY_NODE)
        if mix is None:
            continue
        if mix.inputs["Fac"].default_value != opacity:
            mix.inputs["Fac"].default_value = opacity
        if mat.diffuse_color[3] != opacity:
            mat.diffuse_color[3] = opacity


def apply_opacity(scene):
    """The Collision outlines opacity: the solid outlines' fills at it, and at
    0 every outline and its origin hidden, since a wire cannot fade. Hiding is
    the outliner's eye: a linked object's own `hide_viewport` is the guide
    file's to set, but its base in this view layer is the scene's."""
    layer = bpy.context.view_layer
    hide = scene.game_outline_opacity <= 0
    for ob in shown_with_outlines(scene):
        if ob.hide_get(view_layer=layer) != hide:
            ob.hide_set(hide, view_layer=layer)
    sync_fills(scene)


@persistent
def keep_fills(scene, _depsgraph):
    if scene.library is None:
        sync_fills(scene)


def guide_from_outline(outline):
    """A free guide that is an exact copy of collision outline `outline`: the
    same points at the same place, as a 2D curve (a guide's convention, which
    the outlines share). It copies geometry and pose only, so it holds nothing
    that refers back to the outline, and the outline is not touched."""
    if not is_collision_outline(outline):
        raise ValueError("Pick one of the level's collision outlines")
    if len(outline.data.splines) != 1:
        raise ValueError("This outline has a hole (a belt's band); a guide is one closed polygon")
    sp = outline.data.splines[0]
    if sp.type != "POLY" or not sp.use_cyclic_u:
        raise ValueError("This outline is not a closed polygon")
    if outline.data.dimensions == "2D":
        points = [(p.co.x, p.co.y) for p in sp.points]
        frame = core.authored_world(outline).copy()
    else:
        if any(abs(p.co.y) > .001 for p in sp.points):
            raise ValueError("This outline is not flat")
        # A 3D curve on its X/Z plane: that plane laid on the guide's X/Y,
        # the same world points.
        points = [(p.co.x, p.co.z) for p in sp.points]
        frame = core.authored_world(outline) @ core.GUIDE_PLANE
    core.validate_polygon([list(p) for p in points])
    ob = bpy.data.objects.new("Guide", core.guide_curve("Guide", points))
    core.guides_collection().objects.link(ob)
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
