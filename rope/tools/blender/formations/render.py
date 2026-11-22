"""Explicit surface-finishing and map settings for full-detail formations.

Generation and export defaults no longer infer quality from camera depth.
Lower-detail representations are derived from evaluated masters by asset_export.
"""

import math
import json

from .slate import OBJECT_SCALE_PROP as DETAIL_SCALE

# What a solid formation's build measured (never set by hand).
DEPTH_SCALE = "formation_depth_scale"
PASSES = ("export_strips", "export_creases", "export_chips")
LIMITS = ("export_map_max", "export_texels", "export_maps")
SETTINGS = (DETAIL_SCALE, *PASSES, *LIMITS, 'export_depth_lod')


def detail_scale(ob):
    return float(ob.get(DETAIL_SCALE, 1.0))


def far_back(ob):
    return detail_scale(ob) > 1.0


# The game's High depth of field (src/render3d/depthOfField.ts): the blur's
# radius at infinity as a share of the frame's height, and the metres behind
# the gameplay plane it focuses at. scripts/scene-export.ts reads them from
# there and the export refuses to run if these differ (`check_dof`).
DOF_MAX_BLUR, DOF_FOCUS_BAND = 0.016, 1.5
# Each pass's largest feature, metres: a strip's widest (slate.STRIP_WIDTH),
# a crease's largest bow (curve.MAX_BOW), and the coarsest of the chips (the
# longest's widest side, detail.SIZE_MAX x WIDE) and the sub-facets (their
# grid, detail.SPACING). Past the depth where the blur outgrows it, the pass
# is off.
LARGEST = {"export_strips": 0.08, "export_creases": 0.2, "export_chips": 0.2}
# Where the scene keeps the start camera (formations/core.py CAMERA).
CAMERA = "backdrop_camera"


def setting(ob, name):
    """Explicit surface settings, otherwise full-detail defaults."""
    if name == 'export_depth_lod':
        return False
    # The master owns these finishing decisions. In particular, jointed
    # rock deliberately keeps straight fractures instead of export bows.
    if name in PASSES and name in json.loads(ob.get('formation_recipe', '{}')).get('surfaceFinish', []):
        return False
    if name in ob:
        return ob[name]
    if name == DETAIL_SCALE:
        return detail_scale(ob)
    if name in PASSES:
        return detail_blur(ob) < LARGEST[name]
    if name == "export_maps":
        return default_maps(ob)
    return 0


def scene_of(ob):
    import bpy
    scenes = getattr(ob, "users_scene", ())
    return scenes[0] if scenes else bpy.context.scene


def detail_blur(ob):
    """Compatibility hook: master surface features are never skipped by depth."""
    return 0.0


def smallest_detail(ob, name):
    """Keep all authored surface features at every placement."""
    return 0.0


def check_dof(given):
    """Refuse an export whose depth of field (scene-export.ts: the game's
    DOF_MAX_BLUR.high and FOCUS_BAND) is not the one written here."""
    want = {"maxBlur": DOF_MAX_BLUR, "focusBand": DOF_FOCUS_BAND}
    if any(not math.isclose(float(given[k]), v) for k, v in want.items()):
        raise SystemExit(f"formations/render.py's depth of field {want} is not the game's {given}: "
                         "update DOF_MAX_BLUR and DOF_FOCUS_BAND from src/render3d/depthOfField.ts")


def default_maps(ob):
    """Zero means automatic allocation without an object-wide atlas cap."""
    return 0  # Automatic: preserve density regardless of object size.


def slate_rock(ob):
    """Whether `ob` wears the formations add-on's painted slate (or a `.001`
    copy an append makes), whose edge line the texel density is for."""
    from .slate import NAME
    data = getattr(ob, "data", None)
    return any(m is not None and (m.name == NAME or m.name.startswith(NAME + "."))
               for m in getattr(data, "materials", ()))


def explicit(ob):
    """The render settings `ob` sets itself."""
    return [n for n in SETTINGS if n in ob]


# The maps the export bakes for an object, sized here so the export
# (scene_export.py) and the moss add-on's preview of a texture-only moss (which
# the export paints into the colour map) read one rule.
#
# Texture resolution follows the surface: this many texels per metre of the
# unwrapped surface, rounded up to a power of two, between these bounds. The
# game frame shows 200 pixels a metre at the gameplay plane (BALL_ZOOM at
# 1080p), and the painted slate's edge line is a texel or two wide, so a map
# under that density draws it magnified and blurred (the Terrace at 1024 got
# 136 texels a metre). Doubled on 2026-10-03 (Tris: "about double the
# resolution"), so the edge line and the chips stay crisp up close. The top is
# the optimiser's cap for baked maps (`--baked-maps`,
# scripts/encode-textures.mjs): a 4096 map is 85 MiB of GPU memory with its
# mips, and WebGL takes no larger on some laptops' GPUs.
TEXELS_PER_METRE = 512
BAKE_SIZE_MIN, BAKE_SIZE_MAX = 64, 4096
# A painted slate rock on the gameplay plane that outgrows one map at
# TEXELS_PER_METRE is split over several (`export_maps`, automatically uncapped), each
# BAKE_SIZE_MAX but the last, at this density: a texel a pixel at 4K at the
# closest zoom (twice BALL_ZOOM's 200 pixels a metre at 1080p). Terrace.001,
# 470 m2 of pile, got 146 texels a metre from one map against Terrace.003's
# 531; 512 there would have cost 64 % more maps at 85 MiB each (Tris chose 400,
# 2026-10-16). Distant rocks retain their depth-adjusted density and map
# cap, but can now allocate additional maps as their surface grows.
TILE_TEXELS_PER_METRE = 400
# The density of a face the game camera can never see, as a share of the
# rest's (scene_export.seen_faces: the stone inside a pile, its back, a
# hidden underside: half of Terrace.001). Not none: the water's mirror and the
# ball's reflection see some of it, and a face just round a silhouette is
# seen from a camera a little off the one tested.
HIDDEN_DENSITY = 0.25
# The baked normal map's side, as a share of the colour map's (Tris,
# 2026-10-04). Lossless, the normals were 16 of the river's 20.7 MB, the
# five Terraces' 3.4 to 4.3 MB each at 4096, against the store's 8 MB a file.
# The detail high poly is still baked at the colour's size: the normal pass
# averages it down rather than resampling a coarse one.
NORMAL_SCALE = 0.5
# The share of the image an unwrap's islands cover after packing. 0.6 was
# Blender's packer (0.55 to 0.62); the export's own packer (native/src/pack.cpp)
# covers 0.75 to 0.81 of a 4096 map and 0.65 of a smaller last map (Terrace.002
# and Terrace.010, 2026-11-13), so the same density takes fewer texels: the
# river's colour maps went from 627 M texels to 576 M (Terrace.002, .005, .006
# and .010 each a map fewer). A rock that packs worse is a few % under its
# density, not over it.
UV_COVERAGE = 0.75
# A last map holding under this share of a full one's surface is left out:
# the others take it at that much under their density.
LAST_MAP_FLOOR = 0.02


def power_of_two(side):
    return int(min(BAKE_SIZE_MAX, max(BAKE_SIZE_MIN, 2 ** math.ceil(math.log2(max(side, 1))))))


def map_sides(area, scale=1.0, map_max=0, texels=0, maps=1):
    """The colour maps' sides for `area` square metres of surface (each face
    counted at its density squared: HIDDEN_DENSITY's for a hidden one):
    TEXELS_PER_METRE over it, divided by the object's `detail_scale`, in one
    map up to BAKE_SIZE_MAX, which a rock standing further back is divided by
    too (rounded down to a power of two). The backdrop's rocks are big (their
    hidden backs and sides included), so a density over the depth alone still
    took every one to 4096 and the river scene to 19.4 MB against the store's
    8 MB bar (2026-10-04). With `maps` over 1, a surface one map cannot hold
    is split over up to that many at TILE_TEXELS_PER_METRE, every one at the
    cap but the last, which is the power of two its share needs. Zero `maps`
    allocates as many as needed. Positive values are explicit quality caps. `map_max`
    and `texels`, over 0, set the cap and the density instead (`setting`)."""
    extent = math.sqrt(area / UV_COVERAGE)
    cap = 2 ** math.floor(math.log2(map_max or BAKE_SIZE_MAX / max(scale, 1.0)))
    side = extent * (texels or TEXELS_PER_METRE / scale)
    if side <= cap or maps == 1:
        return [min(cap, power_of_two(side))]
    need = (extent * (texels or TILE_TEXELS_PER_METRE / scale) / cap) ** 2
    full = max(1, math.floor(need))
    if maps > 0:
        full = min(maps, full)
    rest = need - full
    if (maps > 0 and full == maps) or rest < LAST_MAP_FLOOR:
        return [cap] * full
    return [cap] * full + [min(cap, power_of_two(math.sqrt(rest) * cap))]


def colour_maps(ob, area):
    """The sides of `ob`'s baked colour maps, for `area` square metres of its
    mesh (object space, modifiers applied, as the export bakes it, each face
    weighted as `map_sides` says)."""
    return map_sides(area, detail_scale(ob), int(setting(ob, "export_map_max")),
                     float(setting(ob, "export_texels")), int(setting(ob, "export_maps")) or default_maps(ob))


def colour_texel(ob, area, world_area):
    """How big a texel of `ob`'s baked colour maps is on its surface, metres:
    the maps' texels (`colour_maps`, over `area`, every face counted as seen)
    spread over `world_area`, the same surface in the world, at the unwrap's
    UV_COVERAGE. The export counts the faces the camera never sees at
    HIDDEN_DENSITY, so a seen face gets up to this much finer."""
    return math.sqrt(world_area / UV_COVERAGE / sum(s * s for s in colour_maps(ob, area)))


def map_size(size, kind):
    """The side of an object's `kind` map ("baked colour", ...) when its colour
    map is `size`."""
    return max(BAKE_SIZE_MIN, int(size * NORMAL_SCALE)) if kind == "baked normal" else size


# The Formations panel's fields (Render), read and written through the rule
# above: a field shows what the export will do, and setting it makes it the
# object's own. Registered by the add-on (__init__.py).
FIELDS = {DETAIL_SCALE: "formation_detail_scale", "export_strips": "formation_export_strips",
          "export_creases": "formation_export_creases", "export_chips": "formation_export_chips",
          "export_map_max": "formation_export_map_max", "export_texels": "formation_export_texels",
          "export_maps": "formation_export_maps"}


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
    """Restore the full-detail surface defaults."""
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
        name="Largest map", min=0, max=BAKE_SIZE_MAX, get=_getter("export_map_max", int),
        set=_setter("export_map_max"),
        description="The largest colour map side in pixels (0: 4096 over the detail scale)")
    O.formation_export_texels = FloatProperty(
        name="Texels per metre", min=0, max=4096, get=_getter("export_texels", float), set=_setter("export_texels"),
        description="Colour map density (0: 512 over the detail scale, 400 when split over several maps)")
    O.formation_export_maps = IntProperty(
        name="Most maps", min=0, max=16, get=_getter("export_maps", int), set=_setter("export_maps"),
        description="The most colour maps the surface may be split over once one cannot hold it "
                    "(0: automatic, enough spatial chunks to maintain density)")


def unregister():
    import bpy
    for field in FIELDS.values():
        delattr(bpy.types.Object, field)
