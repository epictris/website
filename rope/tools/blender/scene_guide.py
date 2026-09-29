"""Write a level's collision into a Blender file to model against.

    blender -b --factory-startup --python-exit-code 1 \
        --python tools/blender/scene_guide.py -- guide.json <scene>-guide.blend [<scene>.blend]

Run by `scripts/scene-guide.ts` (`just scene-guide <level>`), which writes the
job; see docs/blender-scenes.md.

The job (metres, the GAME's frame: x right, y up, z toward the camera):

    {"level": "ball", "scene": "river",
     "bounds": {"min": [x, y], "max": [x, y]},
     "spawn": {"x": .., "y": .., "r": ..},
     "camera": {"fps": 60, "focalLength": 70.0, "aspect": 1.78, "far": 400,
                "source": "...", "frames": [{"eye": [x, y, z], "halfHeight": ..}, ...]},
     "bodies": [{"index": 3, "name": "Ledge_03" | null, "kind": "static", "solid": true,
                 "origin": [x, y], "depth": 0.2,
                 "outlines": [[[x, y], ...], ...]}, ...]}

What is written, all in one collection called `Guide`:

- one object per body, its collision outlines extruded through the body's drawn
  depth, centred on the gameplay plane, with the object's origin at the BODY's
  origin - so the artist snaps to it, and an object placed on the body's origin
  needs no offset. Named `guide.<name>`, or `guide.body-<index>` for an
  unnamed body. A solid draws as a translucent grey with its wire; an area
  (water, a force, a killzone, the finish) draws as wire alone.
- an empty on every body's origin, `guide.<name>.origin`, plain axes.
- `guide.plane`: the gameplay plane's extent as a wire rectangle.
- `guide.spawn`: a sphere of the avatar's radius at the spawn.
- `guide.camera`: the GAME camera - the level's lens, its location keyed on
  every frame the job's `camera` track holds (the real camera controller along
  the level's camera paths, or along a recorded run; see
  src/sim/cameraTrack.ts). It looks along +y (the game's -z) and never turns, as
  the game's never does. Its `game_fps` and frame count are what the scene
  takes when the Formations panel's "Look through game camera" makes it the
  scene camera.

None of it ever exports: the exporter skips linked objects and any collection
named `guide*`. The guide file is OVERWRITTEN on every run - it is the level's,
not the artist's - and the scene file is created only when it does not exist,
with the `Guide` collection LINKED from the guide file, so reopening the scene
after the level changes shows the current colliders.

Frames: the game's (x, y, z) is Blender's (x, -z, y) - see scene_export.py.
"""

import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

GUIDE_COLLECTION = "Guide"
SOLID_COLOR = (0.55, 0.58, 0.68, 0.35)
AREA_COLOR = (0.35, 0.65, 0.75, 1.0)
PLANE_MARGIN = 2.0  # metres past the level's extent
ORIGIN_SIZE = 0.25


def log(msg):
    print(f"[scene_guide] {msg}", flush=True)


def to_blender(x, y, z=0.0):
    return Vector((x, -z, y))


def link(coll, ob):
    coll.objects.link(ob)
    ob.hide_render = True


def guide_material():
    mat = bpy.data.materials.new("guide")
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = SOLID_COLOR
        bsdf.inputs["Alpha"].default_value = SOLID_COLOR[3]
        bsdf.inputs["Roughness"].default_value = 1.0
    mat.diffuse_color = SOLID_COLOR
    # Blender 4.2+ names the EEVEE blend mode this way; older builds have
    # `blend_method`. Either makes the alpha show in the viewport.
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    elif hasattr(mat, "blend_method"):
        mat.blend_method = "BLEND"
    return mat


def body_mesh(body):
    """The body's outlines extruded through its depth, about the body's origin."""
    bm = bmesh.new()
    ox, oy = body["origin"]
    half = body["depth"] / 2
    for outline in body["outlines"]:
        if len(outline) < 3:
            continue
        # Front toward the camera is +z in the game, so Blender -y.
        front = [bm.verts.new(to_blender(x - ox, y - oy, half)) for x, y in outline]
        back = [bm.verts.new(to_blender(x - ox, y - oy, -half)) for x, y in outline]
        caps = []
        try:
            caps.append(bm.faces.new(front))
            caps.append(bm.faces.new(list(reversed(back))))
        except ValueError:
            pass  # a degenerate outline (repeated vertex); the sides still say where it is
        n = len(outline)
        for i in range(n):
            j = (i + 1) % n
            try:
                bm.faces.new((front[i], front[j], back[j], back[i]))
            except ValueError:
                pass
        if caps:
            bmesh.ops.triangulate(bm, faces=caps)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(f"guide.{body_label(body)}")
    bm.to_mesh(me)
    bm.free()
    return me


def body_label(body):
    return body["name"] or f"body-{body['index']}"


def build_guide(job, coll):
    mat = guide_material()
    for body in job["bodies"]:
        label = body_label(body)
        me = body_mesh(body)
        ob = bpy.data.objects.new(f"guide.{label}", me)
        ob.location = to_blender(*body["origin"])
        ob.show_wire = True
        if body["solid"]:
            me.materials.append(mat)
            ob.color = SOLID_COLOR
        else:
            ob.display_type = "WIRE"
            ob.color = AREA_COLOR
        link(coll, ob)

        origin = bpy.data.objects.new(f"guide.{label}.origin", None)
        origin.empty_display_type = "PLAIN_AXES"
        origin.empty_display_size = ORIGIN_SIZE
        origin.location = ob.location
        link(coll, origin)

    lo, hi = job["bounds"]["min"], job["bounds"]["max"]
    bm = bmesh.new()
    corners = [
        to_blender(lo[0] - PLANE_MARGIN, lo[1] - PLANE_MARGIN),
        to_blender(hi[0] + PLANE_MARGIN, lo[1] - PLANE_MARGIN),
        to_blender(hi[0] + PLANE_MARGIN, hi[1] + PLANE_MARGIN),
        to_blender(lo[0] - PLANE_MARGIN, hi[1] + PLANE_MARGIN),
    ]
    bm.faces.new([bm.verts.new(c) for c in corners])
    me = bpy.data.meshes.new("guide.plane")
    bm.to_mesh(me)
    bm.free()
    plane = bpy.data.objects.new("guide.plane", me)
    plane.display_type = "WIRE"
    link(coll, plane)

    spawn = job.get("spawn")
    if spawn:
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=spawn["r"])
        me = bpy.data.meshes.new("guide.spawn")
        bm.to_mesh(me)
        bm.free()
        ball = bpy.data.objects.new("guide.spawn", me)
        ball.location = to_blender(spawn["x"], spawn["y"])
        ball.show_wire = True
        me.materials.append(mat)
        link(coll, ball)


def build_camera(track, coll):
    """The game camera, animated. Blender states a lens as a focal length
    against a sensor; the game's is 35 mm-equivalent against the 24 mm height,
    so the vertical fit reproduces its field of view exactly."""
    cam = bpy.data.cameras.new("guide.camera")
    cam.lens = track["focalLength"]
    cam.sensor_fit = "VERTICAL"
    cam.sensor_height = 24.0
    cam.sensor_width = 24.0 * track["aspect"]
    cam.clip_start = 0.1
    cam.clip_end = track["far"]
    ob = bpy.data.objects.new("guide.camera", cam)
    # Looking along Blender +y (the game's -z) with z up: head-on, as always.
    ob.rotation_euler = (math.pi / 2, 0.0, 0.0)
    frames = track["frames"]
    ob.location = to_blender(*frames[0]["eye"])
    ob["game_fps"] = track["fps"]
    ob["game_frames"] = len(frames)
    ob["game_aspect"] = track["aspect"]
    ob["game_source"] = track["source"]
    link(coll, ob)

    ob.animation_data_create()
    action = bpy.data.actions.new("guide.camera")
    ob.animation_data.action = action
    for axis in range(3):
        fc = action.fcurve_ensure_for_datablock(ob, "location", index=axis)
        fc.keyframe_points.add(len(frames))
        co = []
        for i, f in enumerate(frames):
            co += [i + 1, to_blender(*f["eye"])[axis]]
        fc.keyframe_points.foreach_set("co", co)
        fc.keyframe_points.foreach_set("interpolation", [1] * len(frames))  # LINEAR
        fc.update()
    log(f"game camera: {len(frames)} frames at {track['fps']} fps, {cam.lens:.1f} mm, {track['source']}")


def fresh_file():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # No `.blend1` beside a file this script rewrites on every run.
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    return scene


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :]
    if len(argv) < 2:
        raise SystemExit("usage: scene_guide.py -- guide.json guide.blend [scene.blend]")
    job_path, guide_path = argv[0], argv[1]
    scene_path = argv[2] if len(argv) > 2 else None
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)

    scene = fresh_file()
    coll = bpy.data.collections.new(GUIDE_COLLECTION)
    scene.collection.children.link(coll)
    build_guide(job, coll)
    if job.get("camera", {}).get("frames"):
        build_camera(job["camera"], coll)
    os.makedirs(os.path.dirname(os.path.abspath(guide_path)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(guide_path))
    log(f"wrote {guide_path}: {len(job['bodies'])} bodies")

    if scene_path and not os.path.exists(scene_path):
        fresh_file()
        with bpy.data.libraries.load(os.path.abspath(guide_path), link=True) as (data_from, data_to):
            data_to.collections = [GUIDE_COLLECTION]
        linked = data_to.collections[0]
        bpy.context.scene.collection.children.link(linked)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(scene_path), relative_remap=True)
        log(f"created {scene_path} linking {GUIDE_COLLECTION} from {os.path.basename(guide_path)}")
    elif scene_path:
        log(f"{scene_path} exists; left alone (it links the guide, so it sees the new one on open)")


main()
