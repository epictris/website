"""An object's render settings: how the scene export draws it (scene_export.py).

Each is an ID property on the object, set in the Formations panel (Render) or
by hand, and overrides what the object's depth would decide (Tris, 2026-10-04:
configurable, not automatic from the distance to the camera). Unset, the
export decides as it always has:

- detail_scale: how many times further back than the gameplay plane the
  object is drawn as if it stood: its texel density is divided by it, its
  largest map too, and its painted slate's lengths are multiplied by it
  (unset: the depth scale a solid formation's build measured, DEPTH_SCALE,
  its stones' median depth over the plane's; else 1);
- export_strips: the slate's chamfer strips painted as edge line;
- export_creases: long straight creases bent into curves (curve.py);
- export_chips: the chips and sub-facets baked into the normal map (detail.py);
- export_map_max: the largest colour map side (0: 4096 over the detail scale,
  to a power of two);
- export_texels: texels per metre (0: 512 over the detail scale).

The three passes run unless the object is `far_back` (a detail scale over 1:
30 to 45 m back they are a pixel or two, and on the river's 155k backdrop
faces they held the export for over half an hour).

Plain Python on the object's ID properties: the export runs without the
add-on registered.
"""

from .slate import OBJECT_SCALE_PROP as DETAIL_SCALE

# What a solid formation's build measured (never set by hand).
DEPTH_SCALE = "formation_depth_scale"
PASSES = ("export_strips", "export_creases", "export_chips")
LIMITS = ("export_map_max", "export_texels")
SETTINGS = (DETAIL_SCALE, *PASSES, *LIMITS)


def detail_scale(ob):
    return float(ob.get(DETAIL_SCALE, ob.get(DEPTH_SCALE, 1.0)))


def far_back(ob):
    return detail_scale(ob) > 1.0


def setting(ob, name):
    """`ob`'s render setting `name`: its own, else what its depth decides."""
    if name in ob:
        return ob[name]
    if name == DETAIL_SCALE:
        return detail_scale(ob)
    if name in PASSES:
        return not far_back(ob)
    return 0


def explicit(ob):
    """The render settings `ob` sets itself."""
    return [n for n in SETTINGS if n in ob]


# The Formations panel's fields (Render), read and written through the rule
# above: a field shows what the export will do, and setting it makes it the
# object's own. Registered by the add-on (__init__.py).
FIELDS = {DETAIL_SCALE: "formation_detail_scale", "export_strips": "formation_export_strips",
          "export_creases": "formation_export_creases", "export_chips": "formation_export_chips",
          "export_map_max": "formation_export_map_max", "export_texels": "formation_export_texels"}


def _getter(name, kind):
    return lambda ob: kind(setting(ob, name))


def _setter(name):
    def put(ob, value):
        ob[name] = value
        if name == DETAIL_SCALE:
            repaint_scale(ob)
    return put


def repaint_scale(ob):
    """Give `ob`'s painted slate its detail scale, so the viewport shows what
    the export bakes; a slate shared with another object is copied first."""
    from . import slate
    if ob.type != "MESH":
        return
    scale = detail_scale(ob)
    for i, mat in enumerate(ob.data.materials):
        if mat is None or not (mat.name == slate.NAME or mat.name.startswith(slate.NAME + ".")):
            continue
        if float(mat.get(slate.SCALE_PROP, 1.0)) == scale:
            continue
        if mat.users > 1:
            mat = mat.copy()
            ob.data.materials[i] = mat
        mat[slate.SCALE_PROP] = scale
        slate.paint(mat)


def reset(ob):
    """Forget `ob`'s own render settings: each is what its depth decides."""
    for name in explicit(ob):
        del ob[name]
    repaint_scale(ob)


def register():
    import bpy
    from bpy.props import BoolProperty, FloatProperty, IntProperty
    O = bpy.types.Object
    O.formation_detail_scale = FloatProperty(
        name="Detail scale", min=.1, max=20, get=_getter(DETAIL_SCALE, float), set=_setter(DETAIL_SCALE),
        description="Drawn as if it stood this many times further back than the gameplay plane: texel "
                    "density and largest map divided by it, the slate's lengths multiplied by it")
    O.formation_export_strips = BoolProperty(
        name="Chamfer strips", get=_getter("export_strips", bool), set=_setter("export_strips"),
        description="Paint the slate's chamfer strips as edge line on export")
    O.formation_export_creases = BoolProperty(
        name="Curved creases", get=_getter("export_creases", bool), set=_setter("export_creases"),
        description="Bend long straight creases into curves on export")
    O.formation_export_chips = BoolProperty(
        name="Chips and sub-facets", get=_getter("export_chips", bool), set=_setter("export_chips"),
        description="Bake the chips and sub-facets of a detail high poly into the normal map on export")
    O.formation_export_map_max = IntProperty(
        name="Largest map", min=0, max=8192, get=_getter("export_map_max", int), set=_setter("export_map_max"),
        description="The largest colour map side in pixels (0: 4096 over the detail scale)")
    O.formation_export_texels = FloatProperty(
        name="Texels per metre", min=0, max=4096, get=_getter("export_texels", float), set=_setter("export_texels"),
        description="Colour map density (0: 512 over the detail scale)")


def unregister():
    import bpy
    for field in FIELDS.values():
        delattr(bpy.types.Object, field)
