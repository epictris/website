"""The game look: what the game draws over its camera's view, in Blender.

Three toggles in the Game panel, each the game's own law with the game's numbers,
which `just scene-guide <level>` bakes into the guide (tools/blender/scene_guide.py):

- LIGHTING: the game's light at rest instead of the scene's own. The guide's
  `guide.lights` collection (the sun and the level's always-on lights) is
  linked in, its `guide.world` (the generated sky three reflects, the
  hemisphere fill, the background colour) becomes the scene's world, the
  scene's own lights are hidden, and the view transform becomes three's ACES
  Filmic (ACES 1.3 at three's exposure). All of it is put back when it is off.
- DEPTH OF FIELD at Medium: the scene camera becomes `guide.camera.dof`, the
  game camera through Blender's own depth of field, its aperture set so the
  blur behind the plane is the game's (it also blurs in front, which the game
  does not).
- FOG: three's `FogExp2`, `1 - exp(-(density * depth)^2)` of the level's fog
  colour over a surface `depth` metres down the view axis, never over the sky.
  The game mixes it in after tone mapping, over the colours as they are SHOWN,
  so it is a compositor tree: the render to the display through the scene's
  view transform, the fog mixed in as the fog colour's sRGB bytes, and back
  through the inverse. The viewport runs it in camera view in Material Preview
  and Rendered shading.
"""

from __future__ import annotations

import json

import bpy

from . import camera

TREE = "Game look"
LIGHTS = "guide.lights"
WORLD = "guide.world"
# What the scene had before a toggle took it over, restored when it is off.
SAVED_FOG = "game_fog_saved"
SAVED_LIGHTING = "game_lighting_saved"
ERROR = "game_look_error"
# Depth at or past this is the sky (the world), which the game never fogs.
SKY_DEPTH = 1e6


def toggled(scene, context):
    """The toggles' update: errors land in the panel, which cannot be told
    otherwise from a property update."""
    try:
        apply(context)
        if ERROR in scene:
            del scene[ERROR]
    except ValueError as e:
        scene[ERROR] = str(e)


def enabled(scene):
    return scene.game_fog or scene.game_dof or scene.game_lighting


def apply(context):
    """Make the scene match the toggles. Lighting first: it sets the view
    transform the fog's tree converts through."""
    scene = context.scene
    if camera.game_camera(scene) is None:
        if enabled(scene):
            raise ValueError(camera.NO_CAMERA)
        return
    apply_lighting(scene, context.view_layer)
    apply_dof(scene)
    apply_fog(context)


# --- Depth of field ------------------------------------------------------------

def apply_dof(scene):
    plain = camera.game_camera(scene)
    if plain.get("game_dof"):
        plain = plain.parent
    twin = next((ob for ob in plain.children if ob.get("game_dof")), None)
    if scene.game_dof and twin is None:
        raise ValueError("The guide has no depth of field camera: run `just scene-guide <level>` and reopen the file")
    if scene.camera in (plain, twin):
        scene.camera = twin if scene.game_dof else plain


# --- Lighting ------------------------------------------------------------------

def guide_library(scene):
    cam = camera.game_camera(scene)
    return cam.library if cam is not None else None


def linked(kind, name, library):
    """`name` from the guide file, linked on first use."""
    found = next((x for x in getattr(bpy.data, kind) if x.name == name and x.library == library), None)
    if found is not None:
        return found
    with bpy.data.libraries.load(library.filepath, link=True) as (data_from, data_to):
        if name not in getattr(data_from, kind):
            raise ValueError("The guide has no game lighting: run `just scene-guide <level>` and reopen the file")
        setattr(data_to, kind, [name])
    return getattr(data_to, kind)[0]


def apply_lighting(scene, view_layer):
    library = guide_library(scene)
    on = scene.game_lighting
    if on and SAVED_LIGHTING not in scene:
        if library is None:
            raise ValueError("The game camera is not linked from a guide file")
        world = linked("worlds", WORLD, library)
        lights = linked("collections", LIGHTS, library)
        own = [ob for ob in scene.objects if ob.type == "LIGHT" and ob.library is None
               and not (ob.hide_viewport and ob.hide_render)]
        settings = scene.view_settings
        scene[SAVED_LIGHTING] = json.dumps({
            "world": scene.world.name if scene.world else None,
            "view": [settings.view_transform, settings.look, settings.exposure, settings.gamma],
            "lights": {ob.name: [ob.hide_viewport, ob.hide_render] for ob in own},
        })
        for ob in own:
            ob.hide_viewport = True
            ob.hide_render = True
        if lights.name not in scene.collection.children:
            scene.collection.children.link(lights)
        scene.world = world
        settings.view_transform = world["game_tone_view"]
        settings.look = "None"
        settings.exposure = world["game_tone_exposure"]
        settings.gamma = 1.0
    elif not on and SAVED_LIGHTING in scene:
        saved = json.loads(scene[SAVED_LIGHTING])
        for coll in list(scene.collection.children):
            if coll.name == LIGHTS and coll.library is not None:
                scene.collection.children.unlink(coll)
        scene.world = bpy.data.worlds.get(saved["world"]) if saved["world"] else None
        settings = scene.view_settings
        settings.view_transform, settings.look, settings.exposure, settings.gamma = saved["view"]
        for name, (hide_viewport, hide_render) in saved["lights"].items():
            ob = bpy.data.objects.get(name)
            if ob is not None:
                ob.hide_viewport = hide_viewport
                ob.hide_render = hide_render
        del scene[SAVED_LIGHTING]


# --- Fog -----------------------------------------------------------------------

def fog_of(scene):
    """The guide camera's level fog, or None (a level without fog, or a guide
    written before the look)."""
    cam = camera.game_camera(scene)
    look = json.loads(cam.get("game_look", "{}")) if cam is not None else {}
    return look.get("fog")


def apply_fog(context):
    scene = context.scene
    ours = bpy.data.node_groups.get(TREE)
    if not scene.game_fog:
        if ours is not None and scene.compositing_node_group == ours:
            scene.compositing_node_group = None
            saved = json.loads(scene.get(SAVED_FOG, "{}"))
            context.view_layer.use_pass_z = saved.get("use_pass_z", context.view_layer.use_pass_z)
            shade_viewports(context, "DISABLED")
        if SAVED_FOG in scene:
            del scene[SAVED_FOG]
        return
    fog = fog_of(scene)
    if fog is None:
        raise ValueError("No fog: the level has none, or the guide predates it (rerun `just scene-guide <level>`)")
    if scene.compositing_node_group not in (None, ours):
        raise ValueError(f"The scene composites with \"{scene.compositing_node_group.name}\" already")
    if abs(scene.view_settings.gamma - 1) > 1e-6:
        raise ValueError("The fog needs the scene's colour management gamma at 1")
    if SAVED_FOG not in scene:
        scene[SAVED_FOG] = json.dumps({"use_pass_z": context.view_layer.use_pass_z})
    context.view_layer.use_pass_z = True
    scene.compositing_node_group = build_fog(scene, context.view_layer, fog)
    shade_viewports(context, "CAMERA")


def shade_viewports(context, mode):
    for window in context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.shading.use_compositor = mode


def srgb_bytes(hex_color):
    """A CSS hex as the display values it names (not linearised)."""
    h = hex_color.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def build_fog(scene, view_layer, fog):
    """The fog's tree, rebuilt from scratch each time so it always carries the
    guide's numbers and the scene's view transform."""
    tree = bpy.data.node_groups.get(TREE) or bpy.data.node_groups.new(TREE, "CompositorNodeTree")
    tree.animation_data_clear()
    tree.nodes.clear()
    tree.interface.clear()
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    nodes, links = tree.nodes, tree.links
    x = [0]

    def node(kind, **props):
        n = nodes.new(kind)
        n.location = (x[0], 0)
        x[0] += 220
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def math(op, a, b=None):
        n = node("ShaderNodeMath", operation=op)
        for socket, value in ((n.inputs[0], a), (n.inputs[1], b)):
            if isinstance(value, bpy.types.NodeSocket):
                links.new(value, socket)
            elif value is not None:
                socket.default_value = value
        return n.outputs[0]

    def scaled(image, k):
        n = node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
        n.inputs["Factor"].default_value = 1
        links.new(image, n.inputs[6])
        n.inputs[7].default_value = (k, k, k, 1)
        return n.outputs[2]

    # The conversion node takes no exposure of its own, so the scene's is
    # applied around it.
    exposure = 2 ** scene.view_settings.exposure
    layers = node("CompositorNodeRLayers", scene=scene, layer=view_layer.name)
    depth = layers.outputs["Depth"]
    display = node("CompositorNodeConvertToDisplay")
    copy_view(scene, display)
    links.new(scaled(layers.outputs["Image"], exposure), display.inputs["Image"])

    d = math("MULTIPLY", depth, fog["density"])
    clear = math("EXPONENT", math("MULTIPLY", math("MULTIPLY", d, d), -1.0))
    amount = math("MULTIPLY", math("SUBTRACT", 1.0, clear), math("LESS_THAN", depth, SKY_DEPTH))
    mix = node("ShaderNodeMix", data_type="RGBA", label="Fog")
    links.new(amount, mix.inputs["Factor"])
    links.new(display.outputs["Image"], mix.inputs[6])
    mix.inputs[7].default_value = srgb_bytes(fog["color"])

    back = node("CompositorNodeConvertToDisplay")
    copy_view(scene, back)
    back.inputs["Invert"].default_value = True
    links.new(mix.outputs[2], back.inputs["Image"])
    out = node("NodeGroupOutput")
    links.new(scaled(back.outputs["Image"], 1 / exposure), out.inputs[0])
    return tree


def copy_view(scene, n):
    for key in ("view_transform", "look"):
        setattr(n.view_settings, key, getattr(scene.view_settings, key))
    n.display_settings.display_device = scene.display_settings.display_device
