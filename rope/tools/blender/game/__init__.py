"""Game: everything in Blender that comes from the level editor. See
rope/docs/blender-game.md.

The game camera and the game's look over it (lighting, fog, depth of field),
which `just scene-guide <level>` bakes into the level's guide; formation
guides edited as that camera sees them, and formations moved in depth from
its eye; and guides copied from the level's collision outlines. The guides
and the rocks built from them are the Formations add-on's
(tools/blender/formations), which this one needs enabled.

A Blender add-on (an extension in Blender's 4.2+ packaging,
blender_manifest.toml beside this file), installed by `just game-install`.
Everything is an ordinary, undoable edit of the open scene."""

import bpy
from bpy.app.handlers import persistent
from bpy.props import BoolProperty, FloatProperty

from . import edit, look, ops, ui
from .formations_addon import core

CLASSES = ops.CLASSES + ui.CLASSES

# Until 2026-10-08 all of this was the Formations add-on's, and a file saved
# then holds it under these names (the toggles and the depth step as the
# add-on's properties, the rest as custom ones).
RENAMED_PROPERTIES = {"formations_game_fog": "game_fog", "formations_game_dof": "game_dof",
                      "formations_game_lighting": "game_lighting", "formations_depth_step": "game_depth_step",
                      "formations_depth_keep_size": "game_depth_keep_size"}
RENAMED_KEYS = {"formations_game_fog_saved": look.SAVED_FOG, "formations_game_lighting_saved": look.SAVED_LIGHTING,
                "formations_game_look_error": look.ERROR, "formations_edit_state": edit.STATE,
                "formations_polygon_clipboard": edit.CLIPBOARD}
RENAMED_DATA = (("node_groups", "Formations game look", look.TREE),
                ("collections", "Formation outline handles", edit.HANDLES))


@persistent
def on_load(_):
    """Bring a file saved by the Formations add-on's game camera to these
    names, as it was: nothing is re-applied."""
    for scene in bpy.data.scenes:
        if scene.library is not None:
            continue
        system = scene.bl_system_properties_get(do_create=True)
        for old, new in RENAMED_PROPERTIES.items():
            if old in system:
                system[new] = system[old]
                del system[old]
        for old, new in RENAMED_KEYS.items():
            if old in scene:
                scene[new] = scene[old]
                del scene[old]
    for kind, old, new in RENAMED_DATA:
        found = getattr(bpy.data, kind).get(old)
        if found is not None and found.library is None:
            found.name = new


def register():
    bpy.types.Scene.game_depth_step = FloatProperty(
        name="Depth step", default=5, min=.01, soft_max=50, unit="LENGTH",
        description="Metres per Forward/Back click")
    bpy.types.Scene.game_depth_keep_size = BoolProperty(
        name="Keep screen size", default=True,
        description="Scale about the game camera's eye, so a move in depth keeps a formation's size on screen")
    bpy.types.Scene.game_fog = BoolProperty(
        name="Fog", default=False, update=look.toggled,
        description="The level's fog, as the game mixes it over the view (viewport compositor and renders)")
    bpy.types.Scene.game_dof = BoolProperty(
        name="Depth of Field", default=False, update=look.toggled,
        description="Look through the game camera with Blender's depth of field, set to the game's Medium blur "
                    "behind the gameplay plane (it blurs in front of it too, which the game does not)")
    bpy.types.Scene.game_lighting = BoolProperty(
        name="Lighting", default=False, update=look.toggled,
        description="The game's light at rest: its sun, the level's always-on lights, its sky and fill as the "
                    "world, and its tone mapping (ACES). The scene's own lights are hidden until it is off")
    for c in CLASSES:
        bpy.utils.register_class(c)
    # A rebuild or replant in the Formations panel applies the guides being
    # edited here first, and ends the editing.
    if edit.finish not in core.BEFORE_BUILD:
        core.BEFORE_BUILD.append(edit.finish)
    if on_load not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(on_load)
    # The file open when the add-on is enabled had no load to hear.
    bpy.app.timers.register(lambda: on_load(None), first_interval=0)


def unregister():
    if on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(on_load)
    if edit.finish in core.BEFORE_BUILD:
        core.BEFORE_BUILD.remove(edit.finish)
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    del bpy.types.Scene.game_lighting
    del bpy.types.Scene.game_dof
    del bpy.types.Scene.game_fog
    del bpy.types.Scene.game_depth_keep_size
    del bpy.types.Scene.game_depth_step
