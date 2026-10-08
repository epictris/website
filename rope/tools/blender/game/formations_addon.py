"""The Formations add-on, as Blender runs it.

The Game panel edits formations' guides through the game camera, so it needs
the Formations add-on enabled: its properties on the objects, and the very
modules Formations runs (one import of the repo's package beside it would be
a second copy, with hooks and state of its own). An extension's module is
`bl_ext.<repository>.formations`, so it is found among the enabled add-ons.
"""

import importlib

import bpy


def _module():
    for addon in bpy.context.preferences.addons:
        if addon.module.rsplit(".", 1)[-1] == "formations":
            return importlib.import_module(addon.module)
    raise ImportError("The Game add-on needs the Formations add-on: run `just formations-install`")


_formations = _module()
core = importlib.import_module(_formations.__name__ + ".core")
ops = importlib.import_module(_formations.__name__ + ".ops")
params = importlib.import_module(_formations.__name__ + ".params")
