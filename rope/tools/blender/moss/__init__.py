"""Moss: paint a carpet of flat leaf blobs onto meshes, layered like paper
cutouts, and hang vines of lobed leaves wherever they are placed.
See rope/docs/blender-moss.md.

A Blender add-on (an extension in Blender's 4.2+ packaging, blender_manifest.toml
beside this file). The scene exporter imports this package directly and calls
`rebuild_all` so every export grows the moss from its paint afresh."""

import bpy

from . import ops, paint, settings, ui

CLASSES = ops.CLASSES + paint.CLASSES + ui.CLASSES


def rebuild_all(scene):
    return ops.rebuild_all(scene)


def register():
    settings.register()
    for c in CLASSES:
        bpy.utils.register_class(c)
    ops.register_handlers()


def unregister():
    ops.unregister_handlers()
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    settings.unregister()
