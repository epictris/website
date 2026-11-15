"""Additive Eevee lightmaps, separate from authored surface shaders."""
import bpy

PREFIX = "Game emission preview / "


def clear():
    for mat in bpy.data.materials:
        if not mat.node_tree or not mat.get("game_preview_lightmap"):
            continue
        nt = mat.node_tree
        for n in list(nt.nodes):
            if n.type == "ADD_SHADER" and n.name.startswith(PREFIX):
                source = n.inputs[0].links[0].from_socket if n.inputs[0].is_linked else None
                if source:
                    for link in list(n.outputs[0].links):
                        nt.links.new(source, link.to_socket)
        image = mat["game_preview_lightmap"]
        for n in list(nt.nodes):
            if n.name.startswith(PREFIX) or (n.type == "TEX_IMAGE" and n.image == image):
                nt.nodes.remove(n)
        del mat["game_preview_lightmap"]
        del mat["game_preview_lightmap_strength"]


def enable(on, spill=1):
    for mat in bpy.data.materials:
        if mat.node_tree and mat.get("game_preview_lightmap"):
            for n in mat.node_tree.nodes:
                if n.type == "EMISSION" and n.name.startswith(PREFIX):
                    n.inputs["Strength"].default_value = mat["game_preview_lightmap_strength"] * spill if on else 0


def install():
    count = 0
    for mat in bpy.data.materials:
        image = mat.get("game_preview_lightmap")
        if not image or not mat.node_tree:
            continue
        nt = mat.node_tree
        output = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not output or not output.inputs["Surface"].is_linked or not bsdf:
            continue
        surface = output.inputs["Surface"].links[0].from_socket
        tex = next(n for n in nt.nodes if n.type == "TEX_IMAGE" and n.image == image)
        def node(kind):
            n = nt.nodes.new(kind)
            n.name = PREFIX + n.name
            return n
        # White-diffuse outgoing radiance times the receiver's diffuse colour.
        tint = node("ShaderNodeMixRGB")
        tint.blend_type = "MULTIPLY"
        tint.inputs[0].default_value = 1
        nt.links.new(tex.outputs["Color"], tint.inputs[1])
        base = bsdf.inputs["Base Color"]
        if base.is_linked:
            nt.links.new(base.links[0].from_socket, tint.inputs[2])
        else:
            tint.inputs[2].default_value = base.default_value
        metal = node("ShaderNodeMath")
        metal.operation = "SUBTRACT"
        metal.inputs[0].default_value = 1
        metallic = bsdf.inputs["Metallic"]
        if metallic.is_linked:
            nt.links.new(metallic.links[0].from_socket, metal.inputs[1])
        else:
            metal.inputs[1].default_value = metallic.default_value
        diffuse = node("ShaderNodeVectorMath")
        diffuse.operation = "SCALE"
        nt.links.new(tint.outputs[0], diffuse.inputs[0])
        nt.links.new(metal.outputs[0], diffuse.inputs[3])
        glow = node("ShaderNodeEmission")
        nt.links.new(diffuse.outputs[0], glow.inputs["Color"])
        glow.inputs["Strength"].default_value = mat["game_preview_lightmap_strength"]
        add = node("ShaderNodeAddShader")
        nt.links.new(surface, add.inputs[0])
        nt.links.new(glow.outputs[0], add.inputs[1])
        nt.links.new(add.outputs[0], output.inputs["Surface"])
        count += 1
    return count
