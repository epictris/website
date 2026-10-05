"""Moss: paint painterly moss onto a scene's rocks. Under the paint grows a low
mound whose colour is printed dab by dab - a dark base at the rim, lighter clumps
inside - and whose height follows its colour, the lighter the taller. See
rope/docs/blender-moss.md.

A Blender add-on (an extension in Blender's 4.2+ packaging, blender_manifest.toml
beside this file). The scene exporter imports this package directly and calls
`rebuild_all` so every export grows the moss from its paint afresh, then
`texture_paints` and `paint_map` to paint each texture-only moss into its
rock's baked colour map.

Until 2026-10-02 "moss" was the name of the ivy add-on (tools/blender/ivy), which
carries an older file across (its migrate.py)."""

import bpy

from . import ops, paint, settings, ui

CLASSES = ops.CLASSES + paint.CLASSES + ui.CLASSES


def rebuild_all(scene):
    return ops.rebuild_all(scene)


def texture_paints(scene):
    return ops.texture_paints(scene)


def paint_map(px, uv_px, tri_pos, layers, p):
    from . import build

    return build.paint_map(px, uv_px, tri_pos, layers, p)


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
