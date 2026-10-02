"""Carry a .blend from before 2026-10-02, when this add-on was "moss", forward.

The ivy was the moss add-on until the painterly moss (tools/blender/moss) took the
name. A file saved before then keeps the ivy under the old names: the settings in
the system property group `moss` (with `is_moss` set), the objects `<rock>.moss`
and `<rock>.moss.shadow`, the stamps mesh `<rock>.moss.stamps` with `moss_*`
attributes, the anchors' `moss_vine` / `moss_origin` and the decal's `moss_shadow`
properties, the `Moss` collection, the `Moss` and `MossShadow` materials and the
`moss-cutout-atlas-v<N>.png` image. `migrate()` renames every one of them to its
ivy name and moves the settings group across, and is safe to run on any file
again (a migrated file has nothing left to move). It runs when a file is opened,
when the add-on is enabled, and before the scene exporter regrows the ivy.

The new moss add-on's settings live in the same system property slot (`moss`) but
never carry `is_moss`, which is how a legacy group is told apart."""

import bpy

from .stampbrush.brush import GROWN_PROP
from .stampbrush.stamps import LEGACY

RENAMED_PROPS = {"moss_vine": "ivy_vine", "moss_origin": "ivy_origin", "moss_shadow": "ivy_shadow"}
RENAMED_MATERIALS = {"Moss": "Ivy", "MossShadow": "IvyShadow"}


def _renamed(name, old, new):
    """`name` with the suffix or infix `old` (".moss") turned into `new`."""
    if name.endswith(old):
        return name[: -len(old)] + new
    return name.replace(old + ".", new + ".")


def _legacy_group(ob):
    sysp = ob.bl_system_properties_get()
    if sysp is None:
        return None, None
    g = sysp.get("moss")
    if g is None or not hasattr(g, "keys") or "is_moss" not in g.keys():
        return sysp, None
    return sysp, g


def migrate():
    """Rename a moss-era ivy to its ivy names. Returns how many things moved."""
    n = 0
    for ob in list(bpy.data.objects):
        sysp, g = _legacy_group(ob)
        if g is not None:
            # The settings, key for key (`is_moss` becomes `is_ivy`); the stamps
            # mesh is an ID reference and moves as one.
            values = {k: g[k] for k in g.keys()}
            values["is_ivy"] = values.pop("is_moss")
            del sysp["moss"]
            sysp["ivy"] = {}
            dst = sysp["ivy"]
            for k, v in values.items():
                dst[k] = v
            stamps = values.get("stamps")
            if stamps is not None:
                stamps.name = _renamed(stamps.name, ".moss", ".ivy")
                for new, old in LEGACY.items():
                    if old in stamps.attributes and new not in stamps.attributes:
                        stamps.attributes[old].name = new
            ob[GROWN_PROP] = "ivy"
            n += 1
        for old, new in RENAMED_PROPS.items():
            if old in ob.keys():
                ob[new] = ob[old]
                del ob[old]
                if new == "ivy_shadow":
                    ob[GROWN_PROP] = "ivy"
                n += 1
        if ob.get(GROWN_PROP) == "ivy" or any(p in ob.keys() for p in RENAMED_PROPS.values()):
            name = _renamed(ob.name, ".moss", ".ivy")
            if name != ob.name:
                ob.name = name
                if ob.data is not None and ob.type == "MESH":
                    ob.data.name = name
                n += 1
    coll = bpy.data.collections.get("Moss")
    if coll is not None and bpy.data.collections.get("Ivy") is None and any(o.get(GROWN_PROP) == "ivy" or "ivy_vine" in o.keys() or "ivy_origin" in o.keys() for o in coll.all_objects):
        coll.name = "Ivy"
        n += 1
    for old, new in RENAMED_MATERIALS.items():
        mat = bpy.data.materials.get(old)
        if mat is not None and "moss_material" in mat.keys() and bpy.data.materials.get(new) is None:
            mat.name = new
            mat["ivy_material"] = mat["moss_material"]
            del mat["moss_material"]
            n += 1
    for img in list(bpy.data.images):
        if "moss_atlas" in img.keys():
            img.name = img.name.replace("moss-cutout-atlas", "ivy-cutout-atlas")
            img["ivy_atlas"] = img["moss_atlas"]
            del img["moss_atlas"]
            n += 1
    return n


def legacy_present():
    """Does the open file still hold a moss-era ivy?"""
    return any(_legacy_group(ob)[1] is not None for ob in bpy.data.objects)
