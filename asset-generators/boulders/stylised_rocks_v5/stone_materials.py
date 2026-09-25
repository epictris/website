"""Quiet painted slate for the exported boulder meshes.

Keep the base colour independent of mesh curvature and ambient occlusion. The
mesh has many small Boolean/remesh triangles at chunk intersections, so those
signals turn the baked albedo into dark spots and a bright triangular web.
"""
import bpy


def worn_edge_color(color):
    """A pale, slightly desaturated version of the requested stone colour."""
    average = sum(color) / 3
    return tuple(min(.38, (average * .75 + channel * .25) * 1.8)
                 for channel in color)


def stone_material(name, color, variation, spec=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()

    def node(kind, label, x, y):
        result = nodes.new(kind)
        result.label = label
        result.location = (x, y)
        return result

    def noise(label, vector, scale, detail, x, y):
        result = node('ShaderNodeTexNoise', label, x, y)
        result.inputs['Scale'].default_value = scale
        result.inputs['Detail'].default_value = detail
        result.inputs['Roughness'].default_value = .5
        links.new(vector, result.inputs['Vector'])
        return result.outputs['Fac']

    def ramp(label, source, stops, x, y):
        result = node('ShaderNodeValToRGB', label, x, y)
        result.color_ramp.interpolation = 'EASE'
        for index, (position, rgb) in enumerate(stops):
            element = (result.color_ramp.elements[index] if index < 2
                       else result.color_ramp.elements.new(position))
            element.position = position
            element.color = (*rgb, 1)
        links.new(source, result.inputs[0])
        return result.outputs['Color']

    tex = node('ShaderNodeTexCoord', 'Rock coordinates', -900, 150)
    coord = tex.outputs['Object']
    broad = noise('Broad mineral clouds', coord, 1.25, 2, -670, 350)
    # Variation is deliberately narrow. Chunk-to-chunk colour and the broad
    # clouds should read as slate, even where several chunks meet.
    tint = min(1.12, max(.84, variation))
    base = tuple(min(.32, channel * tint) for channel in color)
    dark = tuple(channel * .78 for channel in base)
    light = tuple(channel * 1.25 for channel in base)
    albedo = ramp('Soft slate colour', broad, [
        (.34, dark), (.50, base), (.66, light),
    ], -370, 330)

    out = node('ShaderNodeOutputMaterial', 'Surface', 620, 200)
    shader = node('ShaderNodeBsdfPrincipled', 'Dry slate', 350, 200)
    shader.inputs['Roughness'].default_value = .88
    shader.inputs['Specular IOR Level'].default_value = .18
    links.new(albedo, shader.inputs['Base Color'])
    links.new(shader.outputs[0], out.inputs['Surface'])

    # Very shallow continuous relief, with no hard cell boundaries or isolated
    # dark pits. Actual beveled geometry catches the pale edge lighting.
    fine = noise('Subtle stone grain', coord, 18, 1, -370, -120)
    bump = node('ShaderNodeBump', 'Shallow stone grain', 90, -90)
    bump.inputs['Strength'].default_value = .085
    bump.inputs['Distance'].default_value = .0025
    links.new(fine, bump.inputs['Height'])
    links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    return mat
