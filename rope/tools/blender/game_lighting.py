"""The game's light at rest, built in Blender: its sun as a light and its sky
(the generated environment, the hemisphere fill and the background) as a
world, from a lighting job (`scripts/lightingJob.ts`).

Used by the Game add-on's "Preview River Lighting" (game/model_preview.py),
which lights a model's file as the ball level is lit. Split out of the retired
scene guide (2026-11-26, docs/blender-scenes.md), which built the same light
beside a level's collision outlines.

Frames: the game's (x, y, z) is Blender's (x, -z, y) - see scene_export.py.
"""

import math
import os

import bpy
from mathutils import Vector


def log(msg):
    print(f"[game_lighting] {msg}", flush=True)


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


def build_lighting(job, collection_name=LIGHTS_COLLECTION, world_name=WORLD):
    """The game's light at rest: its lights in a collection of their own
    (`collection_name`), linked into the scene, and its sky as a world
    (`world_name`).

    Units, each measured in EEVEE against three's physical lights: a sun's
    strength is three's intensity (both light a white diffuse surface to I/pi),
    a point or spot's power is 4 pi times its candela, and a world of radiance L
    lights a surface as three's environment of L does. three's hemisphere fill
    is irradiance mix(ground, sky, (1 + n.y) / 2) * I, which is exactly what a
    world of sky above and ground below at I/pi gives a diffuse surface."""
    coll = bpy.data.collections.new(collection_name)
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
    world = build_world(job, world_name)
    log(f"game lighting: {'a sun, ' if sun else ''}no copied editor lights, "
        f"{'HDRI ' + job['hdri'] + ' (not carried: the generated sky stands in)' if job.get('hdri') else 'generated sky'}")
    return world, coll


def build_world(job, name=WORLD):
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
    original = settings.file_format, settings.color_depth, settings.color_mode
    try:
        settings.file_format = "OPEN_EXR"
        settings.color_depth = "32"
        settings.color_mode = "RGBA"
        with tempfile.TemporaryDirectory() as scratch:
            path = os.path.join(scratch, "guide.sky.exr")
            image.save_render(filepath=path, scene=bpy.context.scene)
            bpy.data.images.remove(image)
            image = bpy.data.images.load(path)
            image.name = "guide.sky"
            image.pack()
    finally:
        settings.file_format, settings.color_depth, settings.color_mode = original
    image.filepath_raw = "//guide.sky.exr"
    image.colorspace_settings.name = "Linear Rec.709"
    world = bpy.data.worlds.new(name)
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
    hemi = node("ShaderNodeMix", name="Game hemisphere fill", data_type="RGBA")
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
    return world
