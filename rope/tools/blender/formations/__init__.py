"""Formations: rock masses generated from outlines, edited as the game camera
sees them, and the moss and sprigs that grow on them. See
rope/docs/blender-formations.md.

A Blender add-on (an extension in Blender's 4.2+ packaging,
blender_manifest.toml beside this file), installed by `just blender-addons`.
The rocks are built by the boulder generator (tools/blender/boulders) in a
separate process; everything else is ordinary, undoable edits of the open
scene, which `just scene <level>` exports like any other scenery."""

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, PointerProperty

from . import growth, ops, params, ui

CLASSES = ops.CLASSES + ui.CLASSES


def register():
    for c in params.CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Object.formation_params = PointerProperty(
        type=params.FormationParams, name="Generator parameters",
        description="What the next build of this formation uses")
    bpy.types.Object.formation_attachment = EnumProperty(
        name="Attachment", items=growth.ATTACHMENTS, default="FLOOR",
        description="Where the formation hangs from, which decides what grows on it")
    bpy.types.Object.formation_moisture = FloatProperty(
        name="Moisture", default=.55, min=0, max=1,
        description="How much grows on the formation")
    bpy.types.Scene.formations_depth_step = FloatProperty(
        name="Depth step", default=5, min=.01, soft_max=50, unit="LENGTH",
        description="Metres per Forward/Back click")
    bpy.types.Scene.formations_depth_keep_size = BoolProperty(
        name="Keep screen size", default=True,
        description="Scale about the game camera's eye, so a move in depth keeps a formation's size on screen")
    for c in CLASSES:
        bpy.utils.register_class(c)
    if params.on_load not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(params.on_load)
    # The file open when the add-on is enabled had no load to hear.
    bpy.app.timers.register(params.load_all, first_interval=0)


def unregister():
    if params.on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(params.on_load)
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    del bpy.types.Scene.formations_depth_keep_size
    del bpy.types.Scene.formations_depth_step
    del bpy.types.Object.formation_moisture
    del bpy.types.Object.formation_attachment
    del bpy.types.Object.formation_params
    for c in reversed(params.CLASSES):
        bpy.utils.unregister_class(c)
