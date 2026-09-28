"""Install the moss add-on into this machine's Blender (`just moss-install`).

    blender -b --python tools/blender/moss_install.py

Links tools/blender/moss into the user's local extension repository
(`user_default`) rather than copying it, so an edit in the repo is the add-on
Blender runs after a restart (or Blender's "Reload Scripts"), enables it and
saves the preferences. Safe to re-run. The scene exporter does not need this:
it imports the package from the repo itself."""

import os
import sys

import addon_utils
import bpy

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "moss")
MODULE = "bl_ext.user_default.moss"

repo = next((r for r in bpy.context.preferences.extensions.repos if r.module == "user_default"), None)
if repo is None:
    sys.exit("[moss] this Blender has no user_default extension repository")
root = repo.directory
os.makedirs(root, exist_ok=True)
dest = os.path.join(root, "moss")
if os.path.islink(dest):
    if os.path.realpath(dest) != os.path.realpath(SRC):
        os.unlink(dest)
elif os.path.exists(dest):
    sys.exit(f"[moss] {dest} exists and is not a link this script made; remove it first")
if not os.path.islink(dest):
    os.symlink(SRC, dest)
print(f"[moss] {dest} -> {SRC}")

bpy.ops.extensions.repo_refresh_all()
addon_utils.enable(MODULE, default_set=True, persistent=True)
if MODULE not in bpy.context.preferences.addons:
    sys.exit(f"[moss] {MODULE} did not enable; see the errors above")
bpy.ops.wm.save_userpref()
print("[moss] enabled and saved: the Moss tab is in the 3D viewport's sidebar (N)")
