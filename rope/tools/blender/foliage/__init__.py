"""Foliage: ferns, leaf-sprig bushes and hanging vines, each placed by hand on
a scene's meshes and grown procedurally from its own settings and seed. See
rope/docs/blender-foliage.md.

The generators are ports of karin-lu's three.js foliage generators (the
blender-background-editor branch of github.com/karin-lu/website), moved into
Blender so a plant is scenery like any other: saved in the .blend, regrown by
`just scene <level>` and drawn by the game from the exported scene.

A Blender add-on (an extension in Blender's 4.2+ packaging, blender_manifest.toml
beside this file). The scene exporter imports this package directly and calls
`rebuild_all` so every export grows the plants afresh."""

import bpy

from . import icons, ops, place, settings, ui

CLASSES = ops.CLASSES + place.CLASSES + ui.CLASSES


def rebuild_all(scene):
    return ops.rebuild_all(scene)


def register():
    settings.register()
    for c in CLASSES:
        bpy.utils.register_class(c)
    icons.register()
    ops.register_handlers()
    place.register_overlay()


def unregister():
    place.unregister_overlay()
    ops.unregister_handlers()
    icons.unregister()
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    settings.unregister()
