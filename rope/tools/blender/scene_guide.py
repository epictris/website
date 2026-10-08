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
                "source": "...", "frames": [{"eye": [x, y, z], "halfHeight": ..}, ...],
                "look": {"fog": {"color": "#2a5075", "density": ..} | null,
                         "dofMaxBlur": .008, "dofFocusBand": 1.5}},
     "lighting": {"sun": {"color": [r, g, b], "intensity": .., "dir": [x, y, z]} | null,
                  "fill": {"sky": [r, g, b], "ground": [r, g, b], "intensity": ..},
                  "sky": {"width": 128, "height": 64, "pixels": [r, g, b, a, ...]},
                  "envIntensity": .., "background": "#1c3856", "hdri": null,
                  "toneMappingExposure": 1.0,
                  "lights": [{"kind": "spot", "position": [x, y, z], "direction": [x, y, z],
                              "color": [r, g, b], "intensity": .., "range": .., "angle": ..,
                              "penumbra": .., "castShadow": true}, ...]},
     "bodies": [{"index": 3, "name": "Ledge_03" | null, "kind": "static", "solid": true,
                 "origin": [x, y],
                 "pieces": [{"outline": [[x, y], ...], "hole": [[x, y], ...] | null}, ...]}, ...]}

What is written, all in one collection called `Guide`:

- one flat curve per collision piece on the gameplay plane: a closed POLY
  spline on exactly the editor's points (and a second for a belt's hole), with
  the object's origin at the BODY's origin - so the artist snaps to it, and an
  object placed on the body's origin needs no offset. Named `guide.<name>`, or
  `guide.body-<index>` for an unnamed body, with `.1`, `.2`, ... after it when
  the body has several pieces. A solid is filled translucent grey with its
  wire; an area (water, a force, a killzone, the finish) is the outline alone.
  These COLLISION OUTLINES are a visual reference only: nothing in the scene
  refers to one, so the next run can add, move or drop any of them. The
  Game add-on's "Create Guide from Outline" copies one into a guide of
  the scene's own, which keeps nothing of where it came from.
- an empty on every body's origin, `guide.<name>.origin`, plain axes.
- `guide.plane`: the gameplay plane's extent as a wire rectangle.
- `guide.spawn`: a sphere of the avatar's radius at the spawn.
- `guide.camera`: the GAME camera - the level's lens, its location keyed on
  every frame the job's `camera` track holds (the real camera controller along
  the level's camera paths, or along a recorded run; see
  src/sim/cameraTrack.ts). It looks along +y (the game's -z) and never turns, as
  the game's never does. Its `game_fps` and frame count are what the scene
  takes when the Game panel's "Look through game camera" makes it the
  scene camera. Its `game_look` is the level's fog and the Medium depth of
  field, for the panel's Fog and Depth of Field.
- `guide.camera.dof`: the same camera (riding on it) through Blender's depth
  of field set to the game's, which the panel's Depth of Field swaps in.

Outside the `Guide`, so the scene does not use them until the panel's
Lighting links them in: the game's light at rest, the `guide.lights`
collection (its sun and always-on light objects) and the `guide.world` (the
sky it reflects, its hemisphere fill and its background), from the job's
`lighting` (scripts/scene-guide.ts).

Every collision outline, origin, the plane and the spawn are unselectable
(`hide_select`), so the reference cannot be picked up and edited, made local
or overridden by accident; the cameras stay selectable.

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
# A flat curve lies in its object's X/Y plane; turned a quarter about X, its
# (x, y) is Blender's (x, 0, y), the game's (x, y) on the gameplay plane.
CURVE_UPRIGHT = (math.pi / 2, 0.0, 0.0)


def log(msg):
    print(f"[scene_guide] {msg}", flush=True)


def to_blender(x, y, z=0.0):
    return Vector((x, -z, y))


def link(coll, ob, selectable=False):
    coll.objects.link(ob)
    ob.hide_render = True
    # A reference to look at, never to pick up.
    ob.hide_select = not selectable


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


def piece_curve(name, piece, origin):
    """One collision piece as a flat curve: its outline, and its hole if it has
    one, each a closed POLY spline exactly on the editor's points, about the
    body's origin. Blender fills a flat curve itself and leaves a nested spline
    empty."""
    ox, oy = origin
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "2D"
    for ring in (piece["outline"], piece["hole"]):
        if not ring or len(ring) < 3:
            continue
        spline = curve.splines.new("POLY")
        spline.points.add(len(ring) - 1)
        for pt, (x, y) in zip(spline.points, ring):
            pt.co = (x - ox, y - oy, 0.0, 1.0)
        spline.use_cyclic_u = True
    return curve


def body_label(body):
    return body["name"] or f"body-{body['index']}"


def build_guide(job, coll):
    mat = guide_material()
    for body in job["bodies"]:
        label = body_label(body)
        location = to_blender(*body["origin"])
        pieces = body["pieces"]
        for k, piece in enumerate(pieces):
            name = f"guide.{label}" if len(pieces) == 1 else f"guide.{label}.{k + 1}"
            curve = piece_curve(name, piece, body["origin"])
            ob = bpy.data.objects.new(name, curve)
            ob.location = location
            ob.rotation_euler = CURVE_UPRIGHT
            if body["solid"]:
                curve.fill_mode = "BOTH"
                curve.materials.append(mat)
                ob.color = SOLID_COLOR
            else:
                curve.fill_mode = "NONE"
                ob.color = AREA_COLOR
            link(coll, ob)

        origin = bpy.data.objects.new(f"guide.{label}.origin", None)
        origin.empty_display_type = "PLAIN_AXES"
        origin.empty_display_size = ORIGIN_SIZE
        origin.location = location
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
    ob["game_look"] = json.dumps(track.get("look", {}))
    link(coll, ob, selectable=True)

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
    look = track.get("look", {})
    if look.get("dofMaxBlur"):
        build_dof_camera(ob, frames, look, coll)


def build_dof_camera(plain, frames, look, coll):
    """`guide.camera.dof`: the game camera through Blender's own depth of
    field, which the panel's Depth of Field swaps in as the scene camera (the
    linked camera's settings cannot be changed in the scene file).

    The game blurs with a thin lens focused `dofFocusBand` behind the plane, its
    circle reaching `dofMaxBlur` of the frame's height as a radius at infinity
    (src/render3d/depthOfField.ts). Blender's lens has the same law, a circle of
    diameter f^2 / (N (s - f)) * |1 - s/d| on the sensor, so against the 24 mm
    sensor height the f-number that gives it is f^2 / (48 maxBlur (s - f))
    (measured in EEVEE within a pixel of the game's at 15 m to 1 km). It blurs
    in front of the focus too, where the game keeps everything sharp."""
    cam = plain.data.copy()
    cam.name = "guide.camera.dof"
    cam.dof.use_dof = True
    ob = bpy.data.objects.new("guide.camera.dof", cam)
    for key in plain.keys():
        ob[key] = plain[key]
    ob["game_dof"] = True
    # Riding on the plain camera, so the two are one pose by construction.
    ob.parent = plain
    link(coll, ob, selectable=True)

    cam.animation_data_create()
    action = bpy.data.actions.new("guide.camera.dof")
    cam.animation_data.action = action
    f = cam.lens
    focus, fstop = [], []
    for i, frame in enumerate(frames):
        # The eye's z is its distance from the plane.
        s = frame["eye"][2] + look["dofFocusBand"]
        focus += [i + 1, s]
        fstop += [i + 1, f * f / (48 * look["dofMaxBlur"] * (s * 1000 - f))]
    for path, co in (("dof.focus_distance", focus), ("dof.aperture_fstop", fstop)):
        fc = action.fcurve_ensure_for_datablock(cam, path)
        fc.keyframe_points.add(len(frames))
        fc.keyframe_points.foreach_set("co", co)
        fc.keyframe_points.foreach_set("interpolation", [1] * len(frames))
        fc.update()


# --- The game's light -----------------------------------------------------

LIGHTS_COLLECTION = "guide.lights"
WORLD = "guide.world"
# three's ACES Filmic is Blender's ACES 1.3 view with the exposure three
# applies before its curve (exposure / 0.6): measured over a grey ramp and
# random colours, a mean error of 0.005 of the display range.
TONE_VIEW = "ACES 1.3"
# The sun's shadow: three filters it over 3 texels of a 2048 map 30 m wide, a
# blur of ~0.09 m whatever the distance; Blender's softens with distance, so
# this disc matches it for an occluder about a metre off.
SUN_ANGLE = math.radians(5)


def three_aces(c, exposure):
    """three's ACESFilmicToneMapping and sRGB encoding, linear in, display out."""
    import numpy as np
    c = np.asarray(c, float) * exposure / 0.6
    v = np.array([[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]]) @ c
    v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081)
    v = np.clip(np.array([[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605],
                          [-0.00327, -0.07276, 1.07602]]) @ v, 0, 1)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def untonemapped(hex_color, exposure):
    """The linear colour the tone mapping shows as `hex_color`'s bytes: three
    clears to the background untouched, and Blender draws its world through the
    view transform."""
    import numpy as np
    h = hex_color.lstrip("#")
    want = np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])
    x = np.full(3, .05)
    for _ in range(60):
        r = three_aces(x, exposure) - want
        j = np.empty((3, 3))
        for k in range(3):
            d = np.zeros(3)
            d[k] = 1e-5
            j[:, k] = (three_aces(x + d, exposure) - three_aces(x, exposure)) / 1e-5
        x = np.maximum(x - np.linalg.lstsq(j, r, rcond=None)[0], 0)
    return [float(v) for v in x]


def to_blender_dir(v):
    return Vector((v[0], -v[2], v[1])).normalized()


def build_lighting(job):
    """The game's light at rest, for the Game panel's Lighting: the
    lights in `guide.lights` (never in the Guide, so the scene does not light
    with them until asked) and the sky as `guide.world`.

    Units, each measured in EEVEE against three's physical lights: a sun's
    strength is three's intensity (both light a white diffuse surface to I/pi),
    a point or spot's power is 4 pi times its candela, and a world of radiance L
    lights a surface as three's environment of L does. three's hemisphere fill
    is irradiance mix(ground, sky, (1 + n.y) / 2) * I, which is exactly what a
    world of sky above and ground below at I/pi gives a diffuse surface."""
    coll = bpy.data.collections.new(LIGHTS_COLLECTION)
    bpy.context.scene.collection.children.link(coll)
    sun = job.get("sun")
    if sun:
        data = bpy.data.lights.new("guide.sun", "SUN")
        data.color = sun["color"]
        data.energy = sun["intensity"]
        data.angle = SUN_ANGLE
        ob = bpy.data.objects.new("guide.sun", data)
        # A sun shines down its -Z; three's `dir` is where its lamp sits.
        ob.rotation_euler = to_blender_dir(sun["dir"]).to_track_quat("Z", "Y").to_euler()
        coll.objects.link(ob)
    for i, light in enumerate(job.get("lights", [])):
        kind = "SPOT" if light["kind"] == "spot" else "POINT"
        data = bpy.data.lights.new(f"guide.light.{i}", kind)
        data.color = light["color"]
        data.energy = 4 * math.pi * light["intensity"]
        data.shadow_soft_size = 0
        data.use_shadow = light["castShadow"]
        # three's reach fades the light out by (1 - (d/range)^4)^2; Blender's
        # cuts it off there.
        data.use_custom_distance = True
        data.cutoff_distance = light["range"]
        if kind == "SPOT":
            data.spot_size = math.radians(light["angle"]) * 2
            data.spot_blend = light["penumbra"]
        ob = bpy.data.objects.new(f"guide.light.{i}", data)
        ob.location = to_blender(*light["position"])
        if kind == "SPOT":
            ob.rotation_euler = (-to_blender_dir(light["direction"])).to_track_quat("Z", "Y").to_euler()
        coll.objects.link(ob)
    build_world(job)
    log(f"game lighting: {'a sun, ' if sun else ''}{len(job.get('lights', []))} lights, "
        f"{'HDRI ' + job['hdri'] + ' (not carried: the generated sky stands in)' if job.get('hdri') else 'generated sky'}")


def build_world(job):
    """The game's sky as a world: the generated environment three reflects (the
    same pixels, sampled with three's own equirectangular mapping), the
    hemisphere fill, and to the camera the background colour three clears to."""
    sky = job["sky"]
    w, h = sky["width"], sky["height"]
    image = bpy.data.images.new("guide.sky", w, h, float_buffer=True, alpha=True)
    image.colorspace_settings.name = "Linear Rec.709"
    image.pixels.foreach_set(sky["pixels"])
    # A generated image is regenerated blank on load, so it goes into the file
    # as a packed float EXR, written by `save_render` (`save` writes a float
    # image sRGB-encoded).
    import tempfile
    settings = bpy.context.scene.render.image_settings
    settings.file_format = "OPEN_EXR"
    settings.color_depth = "32"
    with tempfile.TemporaryDirectory() as scratch:
        path = os.path.join(scratch, "guide.sky.exr")
        image.save_render(filepath=path, scene=bpy.context.scene)
        bpy.data.images.remove(image)
        image = bpy.data.images.load(path)
        image.name = "guide.sky"
        image.pack()
    image.filepath_raw = "//guide.sky.exr"
    image.colorspace_settings.name = "Linear Rec.709"
    world = bpy.data.worlds.new(WORLD)
    world.use_fake_user = True
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    nodes, links = nt.nodes, nt.links
    x = [0]

    def node(kind, **props):
        n = nodes.new(kind)
        n.location = (x[0], 0)
        x[0] += 200
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def math_node(op, a, b=None):
        n = node("ShaderNodeMath", operation=op)
        for socket, value in ((n.inputs[0], a), (n.inputs[1], b)):
            if isinstance(value, bpy.types.NodeSocket):
                links.new(value, socket)
            elif value is not None:
                socket.default_value = value
        return n.outputs[0]

    coords = node("ShaderNodeTexCoord")
    unit = node("ShaderNodeVectorMath", operation="NORMALIZE")
    links.new(coords.outputs["Generated"], unit.inputs[0])
    xyz = node("ShaderNodeSeparateXYZ")
    links.new(unit.outputs[0], xyz.inputs[0])
    bx, by, bz = xyz.outputs
    # three's direction is Blender's (x, z, -y); its `equirectUv` takes
    # u = atan2(z, x) / 2pi + 0.5 and v = asin(y) / pi + 0.5, row 0 at v = 0.
    u = math_node("ADD", math_node("DIVIDE", math_node("ARCTAN2", math_node("MULTIPLY", by, -1.0), bx), 2 * math.pi), .5)
    v = math_node("ADD", math_node("DIVIDE", math_node("ARCSINE", bz), math.pi), .5)
    uv = node("ShaderNodeCombineXYZ")
    links.new(u, uv.inputs[0])
    links.new(v, uv.inputs[1])
    tex = node("ShaderNodeTexImage", image=image, interpolation="Linear", extension="EXTEND")
    links.new(uv.outputs[0], tex.inputs["Vector"])
    env = node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
    env.inputs["Factor"].default_value = 1
    links.new(tex.outputs["Color"], env.inputs[6])
    env.inputs[7].default_value = [job["envIntensity"]] * 3 + [1]

    fill = job["fill"]
    k = fill["intensity"] / math.pi
    hemi = node("ShaderNodeMix", data_type="RGBA")
    links.new(math_node("GREATER_THAN", bz, 0.0), hemi.inputs["Factor"])
    hemi.inputs[6].default_value = [c * k for c in fill["ground"]] + [1]
    hemi.inputs[7].default_value = [c * k for c in fill["sky"]] + [1]
    light = node("ShaderNodeMix", data_type="RGBA", blend_type="ADD")
    light.inputs["Factor"].default_value = 1
    links.new(env.outputs[2], light.inputs[6])
    links.new(hemi.outputs[2], light.inputs[7])
    lit = node("ShaderNodeBackground")
    links.new(light.outputs[2], lit.inputs["Color"])

    seen = node("ShaderNodeBackground")
    seen.inputs["Color"].default_value = untonemapped(job["background"], job["toneMappingExposure"]) + [1]
    path = node("ShaderNodeLightPath")
    mix = node("ShaderNodeMixShader")
    links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
    links.new(lit.outputs[0], mix.inputs[1])
    links.new(seen.outputs[0], mix.inputs[2])
    out = node("ShaderNodeOutputWorld")
    links.new(mix.outputs[0], out.inputs["Surface"])
    world["game_tone_view"] = TONE_VIEW
    world["game_tone_exposure"] = math.log2(job["toneMappingExposure"] / .6)


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
    if job.get("lighting"):
        build_lighting(job["lighting"])
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
