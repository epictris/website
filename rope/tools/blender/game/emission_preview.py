"""Cycles renders the authored emitting surfaces; no generated light proxies."""
import importlib.util
from pathlib import Path
import sys

import bpy
from . import look


def module(name):
    key = "_game_preview_" + name
    if key not in sys.modules:
        spec = importlib.util.spec_from_file_location(key, Path(__file__).resolve().parent.parent / (name + ".py"))
        loaded = importlib.util.module_from_spec(spec)
        sys.modules[key] = loaded
        spec.loader.exec_module(loaded)
    return sys.modules[key]


def set_enabled(scene, on):
    module("emission_materials").clear()
    for ob in scene.objects:
        if ob.name.startswith(("game.emission-light.", "game.emission-preview")):
            ob.hide_viewport = ob.hide_render = True
    if not on:
        return
    scene.render.engine = "CYCLES"
    scene.cycles.use_preview_denoising = True
    scene.cycles.preview_samples = 64
    scene.cycles.use_denoising = True
    scene.cycles.sample_clamp_direct = 0
    scene.cycles.sample_clamp_indirect = 0
    scene.cycles.use_fast_gi = False


class GAME_OT_bake_emission_preview(bpy.types.Operator):
    # Keep the old id so existing shortcuts still open the current preview.
    bl_idname = "game.bake_emission_preview"
    bl_label = "Preview Emission (Cycles)"
    bl_description = "Render actual mesh emission, shadows and bounce light in Cycles; no preview bake"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        try:
            context.scene.game_lighting = True
            look.apply(context)
            if look.SAVED_LIGHTING not in context.scene:
                raise ValueError("Enable Game Lighting with a current scene guide first")
            set_enabled(context.scene, True)
            for window in context.window_manager.windows:
                for area in window.screen.areas:
                    if area.type == "VIEW_3D":
                        area.spaces.active.shading.type = "RENDERED"
            self.report({"INFO"}, "Cycles mesh-emission preview enabled; materials control emitted light")
            return {"FINISHED"}
        except (ValueError, RuntimeError) as e:
            self.report({"ERROR"}, str(e))
            return {"CANCELLED"}


CLASSES = (GAME_OT_bake_emission_preview,)
