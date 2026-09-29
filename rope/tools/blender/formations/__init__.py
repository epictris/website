"""Formations: rock masses generated from outlines, edited as the game camera
sees them, and the moss and sprigs that grow on them. See
rope/docs/blender-formations.md.

A Blender add-on (an extension in Blender's 4.2+ packaging,
blender_manifest.toml beside this file), installed by `just blender-addons`.
The rocks are built by the boulder generator (tools/blender/boulders) in a
separate process; everything else is ordinary, undoable edits of the open
scene, which `just scene <level>` exports like any other scenery."""

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty

from . import growth, ops, ui

CLASSES = ops.CLASSES + ui.CLASSES


def register():
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


def unregister():
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    del bpy.types.Scene.formations_depth_keep_size
    del bpy.types.Scene.formations_depth_step
    del bpy.types.Object.formation_moisture
    del bpy.types.Object.formation_attachment
