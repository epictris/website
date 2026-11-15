"""Unshadowed game ambient diffuse for Cycles preview, never exported/baked.

A world light is occluded by cave walls; three's hemisphere and environment
diffuse are not. Add both terms to camera-visible materials and remove them
from a local copy of the guide world to avoid counting them twice outdoors.
"""
import bpy
import numpy as np

MARKER = 'game_ambient_preview'
WORLD_SOURCE = 'game_ambient_world_source'


def clear(scene):
    for mat in bpy.data.materials:
        if not mat.node_tree:
            continue
        nt = mat.node_tree
        for node in list(nt.nodes):
            if node.get(MARKER) == 'add' and node.inputs[0].is_linked:
                original = node.inputs[0].links[0].from_socket
                for link in list(node.outputs[0].links):
                    nt.links.new(original, link.to_socket)
        for node in list(nt.nodes):
            if node.get(MARKER):
                nt.nodes.remove(node)
    for world in list(bpy.data.worlds):
        source = world.get(WORLD_SOURCE)
        if source is None:
            continue
        if scene.world == world:
            scene.world = source
        if world.users == 0:
            bpy.data.worlds.remove(world)
    for image in list(bpy.data.images):
        if image.get(MARKER) and image.users == 0:
            bpy.data.images.remove(image)


def environment(world):
    """The generated sky's intensity multiplier, including older guides."""
    for node in world.node_tree.nodes:
        if (node.bl_idname == 'ShaderNodeMix' and node.data_type == 'RGBA'
                and node.blend_type == 'MULTIPLY' and node.inputs[6].is_linked):
            texture = node.inputs[6].links[0].from_node
            if texture.type == 'TEX_IMAGE' and texture.image:
                return node, texture.image
    return None


def diffuse_sky(image, intensity, width=64, height=32):
    """Cosine-convolved radiance E/pi, in the guide's equirectangular frame.

    Solid-angle integration retains directional sky/sun colour rather than
    substituting an exposure boost. Three's roughest PMREM level approximates
    this diffuse convolution; its specular response remains a separate term.
    """
    def directions(w, h):
        longitude = ((np.arange(w) + .5) / w - .5) * (2 * np.pi)
        latitude = ((np.arange(h) + .5) / h - .5) * np.pi
        lon, lat = np.meshgrid(longitude, latitude)
        return np.stack((np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)), axis=-1).reshape(-1, 3), np.cos(lat).reshape(-1)
    w, h = image.size
    pixels = np.empty(w*h*4, np.float32)
    image.pixels.foreach_get(pixels)
    source, weights = directions(w, h)
    normals, _ = directions(width, height)
    radiance = pixels.reshape(-1, 4)[:, :3] * np.asarray(intensity[:3])
    result = np.ones((width*height, 4), np.float32)
    for start in range(0, len(normals), 64):
        kernel = np.maximum(normals[start:start+64] @ source.T, 0) * weights
        result[start:start+64, :3] = (kernel @ radiance) / kernel.sum(axis=1)[:, None]
    output = bpy.data.images.new('Game ambient diffuse sky', width, height, float_buffer=True)
    output[MARKER] = True
    output.colorspace_settings.name = 'Linear Rec.709'
    output.pixels.foreach_set(result.ravel())
    return output


def hemisphere(world):
    if not world or not world.node_tree:
        return None
    # The explicit name is written by new guides. Retain compatibility with
    # existing linked guides, whose hemisphere is the sole RGBA mix driven
    # by the world-direction sign test.
    for node in world.node_tree.nodes:
        if node.bl_idname != 'ShaderNodeMix' or node.data_type != 'RGBA' or node.blend_type != 'MIX':
            continue
        factor = node.inputs['Factor']
        if node.name == 'Game hemisphere fill' or (factor.is_linked and
                factor.links[0].from_node.type == 'MATH' and
                factor.links[0].from_node.operation == 'GREATER_THAN'):
            return node
    return None


def enable(scene):
    clear(scene)
    source = scene.world
    hemi = hemisphere(source)
    if hemi is None:
        return 0  # Not a Game guide world.
    ground, sky = tuple(hemi.inputs[6].default_value), tuple(hemi.inputs[7].default_value)
    world = source.copy()
    world.name = 'Game ambient preview world'
    world.use_fake_user = False
    world[WORLD_SOURCE] = source
    local_hemi = hemisphere(world)
    for link in list(local_hemi.outputs[2].links):
        socket = link.to_socket
        world.node_tree.links.remove(link)
        socket.default_value = (0, 0, 0, 1)
    scene.world = world
    env = environment(world)
    sky_image = None
    if env:
        multiplier, image = env
        sky_image = diffuse_sky(image, multiplier.inputs[7].default_value)
        # Keep the world for glossy rays, but don't double-count its diffuse
        # contribution on exposed surfaces. Camera background stays intact.
        nt = world.node_tree
        destinations = [link.to_socket for link in multiplier.outputs[2].links]
        path = nt.nodes.new('ShaderNodeLightPath')
        mask = nt.nodes.new('ShaderNodeMixRGB')
        mask.inputs[2].default_value = (0, 0, 0, 1)
        nt.links.new(path.outputs['Is Diffuse Ray'], mask.inputs[0])
        nt.links.new(multiplier.outputs[2], mask.inputs[1])
        for socket in destinations:
            nt.links.new(mask.outputs[0], socket)
    count = 0
    materials = {slot.material for ob in scene.objects for slot in ob.material_slots if slot.material}
    for mat in materials:
        if not mat.node_tree:
            continue
        nt = mat.node_tree
        def node(kind, label):
            value = nt.nodes.new(kind)
            value.name = 'Game ambient / ' + label
            value[MARKER] = label
            return value
        def connect(socket, destination):
            if socket.is_linked:
                nt.links.new(socket.links[0].from_socket, destination)
            else:
                destination.default_value = socket.default_value
        for bsdf in list(nt.nodes):
            if bsdf.type != 'BSDF_PRINCIPLED' or not bsdf.outputs[0].is_linked:
                continue
            destinations = [link.to_socket for link in bsdf.outputs[0].links]
            normal = node('ShaderNodeNewGeometry', 'normal')
            xyz = node('ShaderNodeSeparateXYZ', 'vertical')
            socket = bsdf.inputs['Normal']
            nt.links.new(socket.links[0].from_socket if socket.is_linked else normal.outputs['Normal'], xyz.inputs[0])
            weight = node('ShaderNodeMath', 'hemisphere weight')
            weight.operation = 'MULTIPLY_ADD'
            weight.inputs[1].default_value = .5
            weight.inputs[2].default_value = .5
            nt.links.new(xyz.outputs['Z'], weight.inputs[0])
            tint = node('ShaderNodeMixRGB', 'fill')
            tint.inputs[1].default_value = ground
            tint.inputs[2].default_value = sky
            nt.links.new(weight.outputs[0], tint.inputs[0])
            fill = tint.outputs[0]
            if sky_image:
                def math_node(operation, a, b):
                    value = node('ShaderNodeMath', operation)
                    value.operation = operation
                    nt.links.new(a, value.inputs[0])
                    if isinstance(b, (float, int)):
                        value.inputs[1].default_value = b
                    else:
                        nt.links.new(b, value.inputs[1])
                    return value.outputs[0]
                u = math_node('ADD', math_node('DIVIDE', math_node('ARCTAN2', math_node('MULTIPLY', xyz.outputs['Y'], -1), xyz.outputs['X']), 2*np.pi), .5)
                v = math_node('ADD', math_node('DIVIDE', math_node('ARCSINE', xyz.outputs['Z'], 0), np.pi), .5)
                uv = node('ShaderNodeCombineXYZ', 'sky coordinates')
                nt.links.new(u, uv.inputs[0]);nt.links.new(v, uv.inputs[1])
                texture = node('ShaderNodeTexImage', 'diffuse sky')
                texture.image = sky_image
                texture.extension = 'EXTEND'
                nt.links.new(uv.outputs[0], texture.inputs['Vector'])
                total = node('ShaderNodeMixRGB', 'total ambient')
                total.blend_type = 'ADD';total.inputs[0].default_value = 1
                nt.links.new(fill, total.inputs[1]);nt.links.new(texture.outputs[0], total.inputs[2])
                fill = total.outputs[0]
            albedo = node('ShaderNodeMixRGB', 'albedo')
            albedo.blend_type = 'MULTIPLY'
            albedo.inputs[0].default_value = 1
            nt.links.new(fill, albedo.inputs[1])
            connect(bsdf.inputs['Base Color'], albedo.inputs[2])
            diffuse = node('ShaderNodeMath', 'diffuse fraction')
            diffuse.operation = 'SUBTRACT'
            diffuse.inputs[0].default_value = 1
            connect(bsdf.inputs['Metallic'], diffuse.inputs[1])
            opacity = node('ShaderNodeMath', 'opacity')
            opacity.operation = 'MULTIPLY'
            nt.links.new(diffuse.outputs[0], opacity.inputs[0])
            connect(bsdf.inputs['Alpha'], opacity.inputs[1])
            path = node('ShaderNodeLightPath', 'camera')
            strength = node('ShaderNodeMath', 'camera strength')
            strength.operation = 'MULTIPLY'
            nt.links.new(opacity.outputs[0], strength.inputs[0])
            nt.links.new(path.outputs['Is Camera Ray'], strength.inputs[1])
            glow = node('ShaderNodeEmission', 'fill emission')
            nt.links.new(albedo.outputs[0], glow.inputs['Color'])
            nt.links.new(strength.outputs[0], glow.inputs['Strength'])
            add = node('ShaderNodeAddShader', 'add')
            nt.links.new(bsdf.outputs[0], add.inputs[0])
            nt.links.new(glow.outputs[0], add.inputs[1])
            for destination in destinations:
                nt.links.new(add.outputs[0], destination)
            count += 1
    return count
