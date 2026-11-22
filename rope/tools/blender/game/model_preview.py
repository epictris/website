"""The river's environment in any model scene, without a guide or camera.

The button reads ball.json through the game's own TypeScript lighting code.
The generated world (including its packed sky) and sun are saved locally, so
opening a preview needs neither a guide library nor a running Bun process.
"""
import json
from pathlib import Path
import shutil
import subprocess

import bpy

RIVER = "game_preview_river"
WORLD = "game_preview_river_world"
LIGHTS = "game_preview_river_lights"


def is_river(scene):
    return bool(scene.get(RIVER))


def lighting(scene):
    world, lights = scene.get(WORLD), scene.get(LIGHTS)
    if not isinstance(world, bpy.types.World) or not isinstance(lights, bpy.types.Collection):
        raise ValueError("Refresh River Lighting to rebuild the missing preview environment")
    return world, lights


def read_river():
    root = Path(__file__).resolve().parents[3]
    bun = shutil.which("bun")
    if bun is None:
        # GUI launches commonly have a shorter PATH than the user's shell.
        candidates = [Path.home() / ".bun/bin/bun",
                      *sorted((Path.home() / ".nvm/versions/node").glob("*/bin/bun"), reverse=True)]
        bun = next((str(p) for p in candidates if p.is_file()), None)
    if bun is None:
        raise ValueError("Bun was not found. Install the project's dependencies with `just setup swing`")
    try:
        result = subprocess.run([bun, "run", str(root / "scripts/preview-lighting.ts")],
                                cwd=root, text=True, capture_output=True, timeout=20, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        detail = getattr(error, "stderr", None) or str(error)
        raise ValueError("Could not read river lighting: " + detail[-1000:]) from error


def discard(world, lights):
    """Drop an unused previous preset; never remove data another scene uses."""
    if lights is not None and lights.users == 0:
        for ob in list(lights.objects):
            if len(ob.users_collection) == 1:
                data = ob.data
                bpy.data.objects.remove(ob, do_unlink=True)
                if data is not None and data.users == 0:
                    bpy.data.batch_remove(ids=[data])
        bpy.data.collections.remove(lights)
    if world is not None:
        world.use_fake_user = False
        if world.users == 0:
            images = {n.image for n in world.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image}
            bpy.data.worlds.remove(world)
            for image in images:
                if image.users == 0:
                    bpy.data.images.remove(image)


def activate(context, job=None):
    from . import emission_preview, look
    scene = context.scene
    # Read and build before touching the active lighting: a missing runtime
    # or invalid level file leaves the user's scene as it was.
    job = read_river() if job is None else job
    builder = emission_preview.module("scene_guide")
    world, lights = builder.build_lighting(job, "game.light-preview.river", "River model preview")
    scene.collection.children.unlink(lights)
    world.use_fake_user = False
    for ob in lights.objects:
        ob.name = "game.light-preview.river.sun"
        ob.hide_select = True
    old_world, old_lights = scene.get(WORLD), scene.get(LIGHTS)
    scene.game_lighting = False
    look.apply_lighting(scene, context.view_layer)
    scene[WORLD], scene[LIGHTS], scene[RIVER] = world, lights, True
    discard(old_world, old_lights)
    scene.game_lighting = True
    look.apply(context)
    for _, _, shading in look.viewports(scene):
        shading.type = "RENDERED"


class GAME_OT_preview_river_lighting(bpy.types.Operator):
    bl_idname = "game.preview_river_lighting"
    bl_label = "Preview River Lighting"
    bl_description = "Preview with the ball level's current sun, sky, ambient fill and tone mapping; keep your own view"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            activate(context)
            self.report({"INFO"}, "River lighting enabled; orbit normally or use your scene camera")
            return {"FINISHED"}
        except (ValueError, RuntimeError, OSError) as error:
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}


class GAME_OT_restore_scene_lighting(bpy.types.Operator):
    bl_idname = "game.restore_scene_lighting"
    bl_label = "Restore Scene Lighting"
    bl_description = "Restore the scene's world, lights, colour management, renderer and viewport shading"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        from . import look
        context.scene.game_lighting = False
        look.apply_lighting(context.scene, context.view_layer)
        context.scene.pop(RIVER, None)
        return {"FINISHED"}


CLASSES = (GAME_OT_preview_river_lighting, GAME_OT_restore_scene_lighting)
