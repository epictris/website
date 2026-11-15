"""Shared emission gain and reversible Cycles viewport compensation."""
import bpy

GAIN = 50.0
PREFIX = 'Game emission gain / '
MARKER = 'game_emission_gain'


def clear():
    """Restore authored sockets, including linked/procedural strengths."""
    for mat in bpy.data.materials:
        if not mat.node_tree:
            continue
        nt = mat.node_tree
        for node in list(nt.nodes):
            if node.get(MARKER) != 'strength':
                continue
            source = node.inputs[0]
            for link in list(node.outputs[0].links):
                dest = link.to_socket
                if source.is_linked:
                    nt.links.new(source.links[0].from_socket, dest)
                else:
                    value = source.default_value
                    nt.links.remove(link)
                    dest.default_value = value
        for node in list(nt.nodes):
            if node.get(MARKER):
                nt.nodes.remove(node)


def enable(scene):
    """Camera rays retain authored glow; bounce/shadow rays use export gain.

    Reapplying does not compound gain. Nodes are saved with the file and can
    be removed after reload without an in-memory snapshot of original values.
    """
    clear()
    materials = {slot.material for ob in scene.objects for slot in ob.material_slots if slot.material}
    for mat in materials:
        if not mat.node_tree:
            continue
        nt = mat.node_tree
        for node in list(nt.nodes):
            key = 'Emission Strength' if node.type == 'BSDF_PRINCIPLED' else 'Strength' if node.type == 'EMISSION' else None
            if key is None:
                continue
            socket = node.inputs[key]
            if not socket.is_linked and socket.default_value <= 0:
                continue
            path = nt.nodes.new('ShaderNodeLightPath')
            path.name = PREFIX + 'ray'
            path[MARKER] = 'ray'
            factor = nt.nodes.new('ShaderNodeMath')
            factor.name = PREFIX + 'factor'
            factor[MARKER] = 'factor'
            factor.operation = 'MULTIPLY_ADD'
            factor.inputs[1].default_value = 1 - GAIN
            factor.inputs[2].default_value = GAIN
            nt.links.new(path.outputs['Is Camera Ray'], factor.inputs[0])
            scale = nt.nodes.new('ShaderNodeMath')
            scale.name = PREFIX + 'strength'
            scale[MARKER] = 'strength'
            scale.operation = 'MULTIPLY'
            if socket.is_linked:
                nt.links.new(socket.links[0].from_socket, scale.inputs[0])
            else:
                scale.inputs[0].default_value = socket.default_value
            nt.links.new(factor.outputs[0], scale.inputs[1])
            nt.links.new(scale.outputs[0], socket)
