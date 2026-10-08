"""Looking through the game camera.

THE GAME CAMERA is `guide.camera`, which `just scene-guide <level>` bakes into
the level's guide (linked into the scene): the level's lens, animated through
the real camera controller along the level's camera paths or along a recorded
run (src/sim/cameraTrack.ts). `look_through` makes it the scene camera and
gives the scene its frame rate, range and 16:9 frame, so the viewport's camera
view and a render are the game's view at that frame of the route.
"""

from __future__ import annotations

import bpy

NO_CAMERA = "No game camera: run `just scene-guide <level>` and reopen the file"


def game_camera(scene):
    """The guide's game camera: the scene camera if it is one, else any."""
    if scene.camera is not None and "game_fps" in scene.camera:
        return scene.camera
    # Not the depth of field twin, which the panel swaps in itself.
    return next((ob for ob in scene.objects if ob.type == "CAMERA" and "game_fps" in ob and not ob.get("game_dof")),
                None)


def eye(scene):
    cam = game_camera(scene)
    if cam is None:
        raise ValueError(NO_CAMERA)
    return cam.matrix_world.translation.copy()


def look_through(context):
    """Make the game camera the scene's, and every 3D view look through it."""
    scene = context.scene
    cam = game_camera(scene)
    if cam is None:
        raise ValueError(NO_CAMERA)
    scene.camera = cam
    scene.render.fps = int(cam["game_fps"])
    scene.render.fps_base = 1
    scene.frame_start = 1
    scene.frame_end = int(cam["game_frames"])
    scene.render.resolution_x = 1920
    scene.render.resolution_y = round(1920 / float(cam.get("game_aspect", 16 / 9)))
    scene.render.resolution_percentage = 100
    cam.data.show_passepartout = True
    cam.data.passepartout_alpha = .85
    for window in context.window_manager.windows:
        for area in window.screen.areas:
            if area.type != "VIEW_3D":
                continue
            space = area.spaces.active
            space.region_3d.view_perspective = "CAMERA"
            space.lock_camera = False
            # The whole game frame, not a zoom into it the file was saved with.
            region = next(r for r in area.regions if r.type == "WINDOW")
            with context.temp_override(window=window, area=area, region=region):
                bpy.ops.view3d.view_center_camera()
            # The guide handles and the guide's wires are overlays.
            space.overlay.show_overlays = True
            space.clip_end = max(space.clip_end, cam.data.clip_end)
    return cam


def look_from_start(context):
    """Look through the game camera from the start of its route, held there."""
    cam = look_through(context)
    scene = context.scene
    if context.screen.is_animation_playing:
        bpy.ops.screen.animation_cancel(restore_frame=False)
    # Played at the game's pace, frames dropped if the scene cannot keep up.
    scene.sync_mode = "FRAME_DROP"
    scene.frame_set(scene.frame_start)
    # The game look follows the scene's view transform, which may have changed.
    from . import look
    look.apply(context)
    return cam


def ride(context, direction):
    """Move the game camera along its route: 1 forward, -1 back, 0 paused."""
    if context.screen.is_animation_playing:
        bpy.ops.screen.animation_cancel(restore_frame=False)
    if direction:
        bpy.ops.screen.animation_play(reverse=direction < 0)
