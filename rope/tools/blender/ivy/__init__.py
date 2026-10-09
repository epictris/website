"""Ivy: paint a carpet of flat ivy leaves onto meshes, grown out from an
origin point so every leaf lies over the leaf beyond it, and hang vines of
the same leaves wherever they are placed. See rope/docs/blender-ivy.md.

A Blender add-on (an extension in Blender's 4.2+ packaging, blender_manifest.toml
beside this file). The scene exporter imports this package directly and calls
`rebuild_all` so every export grows the ivy from its paint afresh.

Until 2026-10-02 this add-on was "moss"; that name now belongs to the painterly
moss (tools/blender/moss), and migrate.py carries an older file across."""

import bpy

from . import migrate as _migrate
from . import ops, paint, settings, ui

CLASSES = ops.CLASSES + paint.CLASSES + ui.CLASSES


def rebuild_all(scene):
    return ops.rebuild_all(scene)


def host_names(settings):
    """Every object an ivy grows on (`ob.ivy`), its frame host first."""
    return ops.host_names(settings)


def migrate():
    """Carry a file from when this add-on was "moss" to the ivy names."""
    return _migrate.migrate()


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
