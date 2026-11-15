"""Shared probe bounds; no add-on registration needed by headless exports."""
import math


def camera_footprint(scene):
    """Game camera route projected onto the gameplay plane (Blender y=0)."""
    cam = next((o for o in scene.objects if o.type == "CAMERA" and o.name == "guide.camera"), None)
    if cam is None:
        return None
    frame = scene.frame_current
    points = []
    try:
        step = max(1, math.ceil((scene.frame_end-scene.frame_start)/100))
        for f in range(scene.frame_start, scene.frame_end+1, step):
            scene.frame_set(f)
            origin = cam.matrix_world.translation
            for corner in cam.data.view_frame(scene=scene):
                direction = cam.matrix_world.to_3x3() @ corner
                if abs(direction.y) > 1e-6:
                    t = -origin.y / direction.y
                    if t > 0:
                        points.append(origin + direction*t)
    finally:
        scene.frame_set(frame)
    if not points:
        return None
    return (min(p.x for p in points)-8, max(p.x for p in points)+8,
            min(p.z for p in points)-8, max(p.z for p in points)+8)


def clip_to_camera(lo, hi, scene):
    footprint = camera_footprint(scene)
    if footprint:
        a,b,c,d = footprint
        if min(hi.x,b) > max(lo.x,a) and min(hi.z,d) > max(lo.z,c):
            lo.x,hi.x = max(lo.x,a),min(hi.x,b)
            lo.z,hi.z = max(lo.z,c),min(hi.z,d)
    return lo, hi
