"""Emission-only diffuse lighting, exported inside the scene GLB.

Static receivers carry a separate UV lightmap through glTF's emissive slot;
the loader moves it to lightMap. Actual emitters keep their emission and use
the probe field as receivers. Probes are tiny diffuse cards baked together,
then projected into nine real spherical harmonics of outgoing white radiance
(irradiance / pi). No authored point lights are involved.
"""

import json
import importlib.util
import math
import struct
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

UV = "GameLightmap"
KEY = "gameBakedLighting"
# Cast lighting gain; visible emitter materials retain their authored strength.
from emission_strength import GAIN as EMISSION_GAIN


def basis(n):
    x, y, z = np.moveaxis(np.asarray(n), -1, 0)
    return np.stack((np.full_like(x, .282095), .488603*y, .488603*z, .488603*x,
                     1.092548*x*y, 1.092548*y*z, .315392*(3*z*z-1),
                     1.092548*x*z, .546274*(x*x-y*y)), axis=-1)


def emits(mat):
    if not mat or not mat.node_tree:
        return False
    for n in mat.node_tree.nodes:
        if n.type == "EMISSION":
            return True
        if n.type == "BSDF_PRINCIPLED":
            c, s = n.inputs["Emission Color"], n.inputs["Emission Strength"]
            if (s.is_linked or s.default_value > 0) and (c.is_linked or max(c.default_value[:3]) > 0):
                return True
    return False


def mobile(ob, names):
    import re
    while ob:
        name = re.sub(r"[\[\]\.:/]", "", re.sub(r"\s", "_", ob.name))
        if name in names or ob.get("game_dynamic"):
            return True
        ob = ob.parent
    return False


def field_grid(objects, scene):
    """Concentrate samples around emissive geometry, not the distant backdrop.

    Levels may have kilometre-deep kill floors or scenery. Including those
    makes a capped grid too sparse precisely where the player needs it.
    """
    points = []
    for ob in objects:
        if ob.hide_render:
            continue
        if not any(emits(m) for m in getattr(ob.data, "materials", [])):
            continue
        corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        points.extend((c.x, c.z, -c.y) for c in corners)
    if not points:
        return None
    p = np.asarray(points)
    lo = np.array((p[:, 0].min()-8, p[:, 1].min()-8, -2.0))
    hi = np.array((p[:, 0].max()+8, p[:, 1].max()+8, 2.0))
    # Load the shared pure helper without importing Game's registration code.
    spec = importlib.util.spec_from_file_location("emission_bounds", Path(__file__).parent / "game/emission_bounds.py")
    bounds = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bounds)
    a, b = bounds.clip_to_camera(Vector((lo[0],-hi[2],lo[1])), Vector((hi[0],-lo[2],hi[1])), scene)
    lo, hi = np.array((a.x,a.z,-b.y)), np.array((b.x,b.z,-a.y))
    if "game_probe_min" in scene and "game_probe_max" in scene:
        lo, hi = np.array(scene["game_probe_min"], float), np.array(scene["game_probe_max"], float)
    if not np.all(np.isfinite([lo, hi])) or np.any(hi <= lo):
        raise ValueError("game_probe_min/max must define a finite, positive game-space volume")
    spacing = max(.25, float(scene.get("game_probe_spacing", 2)))
    dims = np.maximum(2, np.ceil((hi-lo)/spacing).astype(int)+1)
    while np.prod(dims) > 4096:
        spacing *= 1.2
        dims = np.maximum(2, np.ceil((hi-lo)/spacing).astype(int)+1)
    positions = np.array([(x, y, z) for z in np.linspace(lo[2], hi[2], dims[2])
                          for y in np.linspace(lo[1], hi[1], dims[1])
                          for x in np.linspace(lo[0], hi[0], dims[0])])
    return lo, hi, dims, positions


def select(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objects:
        ob.hide_set(False)
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def target(mat, image, uv=UV):
    nt = mat.node_tree
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = image
    uv_node = nt.nodes.new("ShaderNodeUVMap")
    uv_node.uv_map = uv
    nt.links.new(uv_node.outputs["UV"], node.inputs["Vector"])
    nt.nodes.active = node
    return node


def diffuse_bake(objects):
    # Cycles rebuilds/synchronizes the scene for each selected object. Sibling
    # surface chunks can share that work: join temporary copies, retaining
    # each material's independent target image and the existing corner UVs.
    groups, singles = {}, []
    for ob in objects:
        parent = ob.parent
        if (parent is not None and parent.type == "EMPTY" and not ob.modifiers
                and ob.name.startswith(parent.name + " chunk ")):
            groups.setdefault(parent, []).append(ob)
        else:
            singles.append(ob)
    hidden, duplicates, meshes = {}, [], []
    try:
        for group in groups.values():
            if len(group) == 1:
                singles.extend(group)
                continue
            copies = []
            for ob in group:
                duplicate = ob.copy()
                duplicate.data = ob.data.copy()
                duplicate.name = 'game.lightmap-batch'
                bpy.context.scene.collection.objects.link(duplicate)
                copies.append(duplicate)
                duplicates.append(duplicate.name)
                meshes.append(duplicate.data)
                hidden[ob] = ob.hide_render
                ob.hide_render = True
            select(copies)
            active = bpy.context.view_layer.objects.active
            bpy.ops.object.join()
            singles.append(active)
        select(singles)
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"},
                            target="IMAGE_TEXTURES", uv_layer=UV, margin=0, use_clear=False,
                            use_selected_to_active=False)
    finally:
        for ob, visibility in hidden.items():
            ob.hide_render = visibility
        for name in duplicates:
            ob = bpy.data.objects.get(name)
            if ob is not None:
                bpy.data.objects.remove(ob, do_unlink=True)
        for mesh in meshes:
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)


def unwrap_receiver(ob, scene, log=print):
    """Pack welded islands, retaining the export mesh and its shading seams.

    Export meshes split vertices at normal/UV seams. Projecting those directly
    makes every triangle an island and spends almost the entire image on gaps.
    Reuse the surface export's welded-copy unwrap and pixel-based packer.
    """
    import scene_export

    mesh = ob.data
    mesh.calc_loop_triangles()
    co = np.empty(len(mesh.vertices) * 3, np.float64)
    mesh.vertices.foreach_get("co", co)
    world = co.reshape(-1, 3) @ np.asarray(ob.matrix_world)[:3, :3].T
    tri = np.empty(len(mesh.loop_triangles) * 3, np.int32)
    mesh.loop_triangles.foreach_get("vertices", tri)
    points = world[tri.reshape(-1, 3)]
    area = np.linalg.norm(np.cross(points[:, 1]-points[:, 0], points[:, 2]-points[:, 0]), axis=1).sum() / 2
    override = ob.get("game_lightmap_size", scene.get("game_lightmap_size"))
    if override is not None:
        size = int(override)
        if size not in (128, 256, 512, 1024, 2048, 4096, 8192):
            raise ValueError("game_lightmap_size must be 128, 256, 512, 1024, 2048, 4096 or 8192")
    else:
        # 32 texels/metre for diffuse illumination, allowing for typical 70%
        # coverage. Fine surface detail remains in the separate normal map.
        # Disconnected pieces (moss mounds, ivy) also need room for island
        # padding, even when their combined physical area is small.
        needed = max(32 * math.sqrt(area / .7), 4 * math.sqrt(len(mesh.polygons)))
        size = min(2048, max(128, 2 ** math.ceil(math.log2(max(1, needed)))))
    active = mesh.uv_layers.active.name if mesh.uv_layers.active else None
    render = next((uv.name for uv in mesh.uv_layers if uv.active_render), None)
    if UV in mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[UV])
    # Surface unwrap uses a two-pixel gap. A half-sized packing grid gives
    # the lightmap four pixels between islands, without percentage margins.
    # Spend the atlas on surfaces visible to the game camera, using
    # the same visibility weighting as the colour/normal bake. Hidden backs
    # still receive texels, but no longer consume foreground resolution.
    if scene_export.BAKE_UV in mesh.uv_layers:
        # Surface export already welded, visibility-weighted and repaired
        # these charts. Repack them at lightmap padding instead of repeating
        # visibility rays, Smart Project and its overlap repair from scratch.
        import native
        uv = np.empty((len(mesh.loops), 2), np.float64)
        mesh.uv_layers[scene_export.BAKE_UV].data.foreach_get("uv", uv.ravel())
        weld = np.unique(co.reshape(-1, 3), axis=0, return_inverse=True)[1]
        vertices = np.empty(len(mesh.loops), np.int32)
        mesh.loops.foreach_get("vertex_index", vertices)
        # Different surface atlases may use identical UV coordinates.
        slots = np.repeat([p.material_index for p in mesh.polygons],
                          [p.loop_total for p in mesh.polygons])
        vertices = (weld[vertices] + slots * len(mesh.vertices)).astype(np.int32)
        loops = np.empty((len(mesh.loop_triangles), 3), np.int32)
        mesh.loop_triangles.foreach_get("loops", loops.ravel())
        grid = min(scene_export.PACK_GRID, size // 2)
        gap = max(1, math.ceil(scene_export.PACK_GAP_PX * grid / (size // 2)))
        packed, share = native.pack_islands(uv, vertices, loops, grid, gap)
        if share < 0:
            raise ValueError(f"{ob.name}: surface charts do not fit lightmap")
        mesh.uv_layers.new(name=UV).data.foreach_set("uv", packed.astype(np.float32).ravel())
        log(f"emission lightmap: {ob.name}: reused surface charts; coverage {share:.2f}")
    else:
        seen = scene_export.seen_faces(mesh, ob.matrix_world)
        scene_export.unwrap(ob, seen, [size], [size // 2])
        mesh.uv_layers[-1].name = UV
    repair_lightmap_overlap(ob, size, log)
    if active and active in mesh.uv_layers:
        mesh.uv_layers.active = mesh.uv_layers[active]
    if render and render in mesh.uv_layers:
        mesh.uv_layers[render].active_render = True
    log(f"emission lightmap: {ob.name}: {area:.1f} m², {size}x{size}")
    return size


def repair_lightmap_overlap(ob, size, log=print):
    """Separate self-overlapping projected faces before baking illumination.

    Smart Project can fold an island over itself. Packing that island as a
    unit retains the overlap, allowing hidden faces to overwrite visible ones.
    Only the affected faces become independent charts; geometry stays intact.
    """
    import native
    import scene_export

    mesh = ob.data
    mesh.uv_layers.active = mesh.uv_layers[UV]
    tool = bpy.context.scene.tool_settings
    sync, mode = tool.use_uv_select_sync, tuple(tool.mesh_select_mode)
    select([ob])
    try:
        tool.use_uv_select_sync = True
        tool.mesh_select_mode = (False, False, True)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="DESELECT")
        bpy.ops.uv.select_overlap()
        bpy.ops.object.mode_set(mode="OBJECT")
        overlap = np.empty(len(mesh.polygons), dtype=bool)
        mesh.polygons.foreach_get("select", overlap)
        if not overlap.any():
            return
        uv = np.empty((len(mesh.loops), 2), dtype=np.float64)
        mesh.uv_layers[UV].data.foreach_get("uv", uv.ravel())
        co = np.empty((len(mesh.vertices), 3), dtype=np.float64)
        mesh.vertices.foreach_get("co", co.ravel())
        # Export vertices are split at shading seams; packing must still see
        # the same continuous charts as the welded unwrap.
        weld = np.unique(co, axis=0, return_inverse=True)[1].ravel()
        vert = np.empty(len(mesh.loops), dtype=np.int32)
        mesh.loops.foreach_get("vertex_index", vert)
        vert = weld[vert].astype(np.int32)
        total = np.empty(len(mesh.polygons), dtype=np.int32)
        mesh.polygons.foreach_get("loop_total", total)
        separate = np.flatnonzero(np.repeat(overlap, total))
        vert[separate] = len(mesh.vertices) + np.arange(len(separate))
        mesh.calc_loop_triangles()
        tri = np.empty((len(mesh.loop_triangles), 3), dtype=np.int32)
        mesh.loop_triangles.foreach_get("loops", tri.ravel())
        grid = min(scene_export.PACK_GRID, size // 2)
        gap = max(1, math.ceil(scene_export.PACK_GAP_PX * grid / (size // 2)))
        out, share = native.pack_islands(uv, vert, tri, grid, gap)
        if share < 0:
            raise ValueError(f"{ob.name}: repaired lightmap islands do not fit")
        mesh.uv_layers[UV].data.foreach_set("uv", out.astype(np.float32).ravel())
        log(f"emission lightmap: {ob.name}: separated {overlap.sum()} overlapping faces; coverage {share:.2f}")
    finally:
        if ob.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        tool.use_uv_select_sync, tool.mesh_select_mode = sync, mode


def receiver_targets(ob, scene, log=print):
    """Separate lightmaps for existing spatial colour-atlas sections."""
    sizes = ob.get("game_lightmap_chunk_sizes")
    # A uniform per-section budget follows the surface export's atlas count.
    # Explicit lists remain available for sections with different budgets.
    if sizes is None and "game_lightmap_section_size" in ob:
        sizes = [ob["game_lightmap_section_size"]] * len(ob.material_slots)
    if sizes is None:
        return [(unwrap_receiver(ob, scene, log), list(range(len(ob.material_slots))))]
    if len(sizes) != len(ob.material_slots):
        raise ValueError(f"{ob.name}: game_lightmap_chunk_sizes must match its {len(ob.material_slots)} surface atlas materials")
    mesh = ob.data
    active = mesh.uv_layers.active.name if mesh.uv_layers.active else None
    render = next((uv.name for uv in mesh.uv_layers if uv.active_render), None)
    if UV in mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[UV])
    output = mesh.uv_layers.new(name=UV)
    coords = np.asarray([v.co[:] for v in mesh.vertices])
    uv = np.zeros((len(mesh.loops), 2), dtype=np.float32)
    groups = []
    for slot, side in enumerate(sizes):
        faces = [p for p in mesh.polygons if p.material_index == slot]
        if not faces:
            continue
        vertices = np.concatenate([p.vertices[:] for p in faces])
        unique, inverse = np.unique(vertices, return_inverse=True)
        starts = np.cumsum([0, *[len(p.vertices) for p in faces]])
        part = bpy.data.meshes.new("game.lightmap-section")
        part.from_pydata(coords[unique].tolist(), [],
                         [inverse[a:b].tolist() for a, b in zip(starts[:-1], starts[1:])])
        import scene_export
        loops = np.concatenate([p.loop_indices[:] for p in faces])
        if scene_export.BAKE_UV in mesh.uv_layers:
            source_uv = np.empty((len(mesh.loops), 2), np.float32)
            mesh.uv_layers[scene_export.BAKE_UV].data.foreach_get("uv", source_uv.ravel())
            part.uv_layers.new(name=scene_export.BAKE_UV).data.foreach_set("uv", source_uv[loops].ravel())
        temp = bpy.data.objects.new(f"{ob.name} lightmap section {slot}", part)
        scene.collection.objects.link(temp)
        temp.matrix_world = ob.matrix_world.copy()
        temp["game_lightmap_size"] = side
        try:
            size = unwrap_receiver(temp, scene, log)
            values = np.empty(len(part.loops) * 2, dtype=np.float32)
            part.uv_layers[UV].data.foreach_get("uv", values)
            uv[loops] = values.reshape(-1, 2)
            groups.append((size, [slot]))
        finally:
            bpy.data.objects.remove(temp, do_unlink=True)
            bpy.data.meshes.remove(part)
    output.data.foreach_set("uv", uv.ravel())
    if active and active in mesh.uv_layers:
        mesh.uv_layers.active = mesh.uv_layers[active]
    if render and render in mesh.uv_layers:
        mesh.uv_layers[render].active_render = True
    return groups


def bake_field(objects, scene):
    grid = field_grid(objects, scene)
    if grid is None:
        return None
    lo, hi, dims, positions = grid
    count = 64
    i = np.arange(count)
    y = 1 - 2*(i+.5)/count
    angle = i * math.pi * (3-math.sqrt(5))
    directions = np.column_stack((np.sqrt(1-y*y)*np.cos(angle), y, np.sqrt(1-y*y)*np.sin(angle)))
    total = len(positions)*count
    width = 512
    height = math.ceil(total/width)
    vertices, faces, uvs = [], [], []
    for j, pos in enumerate(positions):
        center = Vector((pos[0], -pos[2], pos[1]))
        for k, d in enumerate(directions):
            n = Vector((d[0], -d[2], d[1]))
            a = n.orthogonal().normalized() * .003
            b = n.cross(a)
            start = len(vertices)
            vertices.extend(center + a*s + b*t for s, t in ((-1,-1),(1,-1),(1,1),(-1,1)))
            faces.append(tuple(range(start, start+4)))
            pixel = j*count+k
            x, row = pixel % width, pixel // width
            uvs.extend(((x/width,row/height),((x+1)/width,row/height),
                        ((x+1)/width,(row+1)/height),(x/width,(row+1)/height)))
    mesh = bpy.data.meshes.new("game.probe-bake")
    mesh.from_pydata(vertices, [], faces)
    uv = mesh.uv_layers.new(name=UV)
    uv.data.foreach_set("uv", np.asarray(uvs, dtype=np.float32).ravel())
    ob = bpy.data.objects.new(mesh.name, mesh)
    scene.collection.objects.link(ob)
    # Cards receive rays for their bake but never occlude or bounce onto one another.
    ob.visible_diffuse = ob.visible_glossy = ob.visible_shadow = ob.visible_transmission = False
    mat = bpy.data.materials.new("game.probe-bake")
    mat.node_tree.nodes.clear()
    diffuse = mat.node_tree.nodes.new("ShaderNodeBsdfDiffuse")
    diffuse.inputs["Color"].default_value = (1,1,1,1)
    out = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(diffuse.outputs[0], out.inputs["Surface"])
    mesh.materials.append(mat)
    image = bpy.data.images.new("game.probe-bake", width, height, float_buffer=True)
    image.generated_color = (0, 0, 0, 0)
    target(mat, image)
    # The prepared scene's textures can exhaust VRAM even for this tiny atlas.
    # Cycles reports FINISHED on that failure and leaves the image unwritten.
    # This small bake is inexpensive on the CPU; keep GPU capacity for surfaces.
    device = scene.cycles.device
    try:
        scene.cycles.device = "CPU"
        diffuse_bake([ob])
        rgba = np.asarray(image.pixels[:], dtype=np.float32).reshape(-1,4)[:total]
        if not np.all(rgba[:, 3] > 0):
            raise RuntimeError("Probe bake left unwritten samples; refusing to export an empty lighting field")
        pixels = rgba[:, :3]
        if not np.isfinite(pixels).all():
            raise ValueError("non-finite probe bake")
        # Least-squares projection avoids the finite Fibonacci set's integration bias.
        coefficients = np.einsum("kn,pnc->pkc", np.linalg.pinv(basis(directions)),
                                 pixels.reshape(-1,count,3))
        return {"version": 1, "min": lo.tolist(), "max": hi.tolist(), "size": dims.tolist(),
                "coefficients": np.round(coefficients, 6).ravel().tolist()}
    finally:
        scene.cycles.device = device
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        bpy.data.materials.remove(mat)
        bpy.data.images.remove(image)


def bake(objects, dynamic_names, log=print, *, surface_only=False, prepare_receiver=None, checkpoint=None):
    scene = bpy.context.scene
    sources = [ob for ob in objects if not mobile(ob, dynamic_names)
               and any(emits(m) for m in getattr(ob.data, "materials", []))]
    if not sources or not scene.get("game_bake_emission", True):
        return {}, None
    noise_threshold = float(scene.get("game_light_noise_threshold", .001))
    if not math.isfinite(noise_threshold) or not 0 <= noise_threshold <= 1:
        raise ValueError("game_light_noise_threshold must be between 0 and 1 (0 disables early stopping)")
    log(f"emission lighting: {len(sources)} emissive meshes")
    saved_world, saved_engine = scene.world, scene.render.engine
    hidden = {ob: ob.hide_render for ob in scene.objects
              if ob.type == "LIGHT" or (ob not in objects and ob.type in {"MESH", "CURVE", "SURFACE", "FONT"})
              or mobile(ob, dynamic_names)}
    dark = bpy.data.worlds.new("game.emission-only")
    dark.color = (0,0,0)
    dark.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0
    scene.world = dark
    scene.render.engine = "CYCLES"
    samples, saved_device = scene.cycles.samples, scene.cycles.device
    sampling_keys = ("use_adaptive_sampling", "adaptive_threshold", "adaptive_min_samples", "time_limit")
    saved_sampling = {key: getattr(scene.cycles, key) for key in sampling_keys}
    saved_layer_samples = [(layer, layer.samples) for layer in scene.view_layers]
    saved_clamps = (scene.cycles.sample_clamp_direct, scene.cycles.sample_clamp_indirect, scene.cycles.use_fast_gi)
    saved_simplify = (scene.render.use_simplify, scene.cycles.texture_limit_render)
    # The irradiance bake needs the normal maps and broad surface colours,
    # not every full-size colour atlas resident on the GPU at once. This
    # matches the isolated high-quality bakes; output maps keep their own size.
    scene.render.use_simplify = True
    scene.cycles.texture_limit_render = "2048"
    scene.cycles.sample_clamp_direct = scene.cycles.sample_clamp_indirect = 0
    scene.cycles.use_fast_gi = False
    scene.cycles.samples = int(scene.get("game_light_samples", 64))
    for ob in hidden:
        ob.hide_render = True
    maps, field = {}, None
    boosted = []
    denoiser = None
    try:
        # Camera-render convergence is too loose for irradiance textures that
        # are magnified and brightened by the game. Raising the maximum alone
        # still lets Cycles stop early and the denoiser leaves broad blotches.
        scene.cycles.use_adaptive_sampling = noise_threshold > 0
        if noise_threshold > 0:
            scene.cycles.adaptive_threshold = noise_threshold
        scene.cycles.adaptive_min_samples = 0
        scene.cycles.time_limit = 0
        for layer, _ in saved_layer_samples:
            layer.samples = 0
        log(f"emission lighting: noise threshold {noise_threshold:g} (0 = fixed samples)")
        if EMISSION_GAIN != 1:
            log(f"emission lighting: Cycles source strength x{EMISSION_GAIN:g}")
            for mat in {m for ob in sources for m in ob.data.materials if m and m.node_tree}:
                nt = mat.node_tree
                for node in list(nt.nodes):
                    key = "Emission Strength" if node.type == "BSDF_PRINCIPLED" else "Strength" if node.type == "EMISSION" else None
                    if key is None:
                        continue
                    socket = node.inputs[key]
                    if socket.is_linked:
                        original = socket.links[0].from_socket
                        scale = nt.nodes.new("ShaderNodeMath")
                        scale.operation = "MULTIPLY"
                        scale.inputs[1].default_value = EMISSION_GAIN
                        nt.links.new(original, scale.inputs[0])
                        nt.links.new(scale.outputs[0], socket)
                        boosted.append((nt,socket,original,scale))
                    else:
                        boosted.append((nt,socket,socket.default_value,None))
                        socket.default_value *= EMISSION_GAIN
        started = time.monotonic()
        field = None if surface_only else bake_field(objects, scene)
        log(f"emission lighting: {math.prod(field['size']) if field else 0} probes")
        log(f"emission timing: probes {time.monotonic()-started:.1f}s")
        started = time.monotonic()
        receivers = []
        images = []
        for ob in objects:
            if ob.type != "MESH" or ob in sources or mobile(ob, dynamic_names) or ob.hide_render:
                continue
            if not ob.data.polygons or not ob.data.materials:
                continue
            # Cards, water and animated foliage use the field; no static card shadows.
            if ob.get("grown_by") == "foliage" or any(m and m.surface_render_method == "BLENDED" for m in ob.data.materials):
                continue
            if not all(m and any(n.type == "BSDF_PRINCIPLED" for n in m.node_tree.nodes) for m in ob.data.materials):
                continue
            ob.data = ob.data.copy()
            sections = (prepare_receiver or receiver_targets)(ob, scene, log)
            # glTF treats the last dot as a file extension and would truncate
            # e.g. "Cube.002 baked light" to "Cube", losing the encoder rule.
            for slot in ob.material_slots:
                slot.material = slot.material.copy()
            for section, (size, slots) in enumerate(sections):
                suffix = f"-{section}" if len(sections) > 1 else ""
                image = bpy.data.images.new(f"{ob.name.replace('.', '-')}{suffix} baked light", size, size, float_buffer=True)
                image.generated_color = (0, 0, 0, 0)
                materials = [ob.material_slots[i].material for i in slots]
                for mat in materials:
                    target(mat, image)
                images.append((ob, image, materials))
            receivers.append(ob)
        log(f"emission timing: UV preparation {time.monotonic()-started:.1f}s")
        if receivers:
            targets = {}
            for ob, image, _ in images:
                targets.setdefault(ob, []).append(image)
            resumed = set()
            if checkpoint is not None:
                for ob, targets_for_object in targets.items():
                    if all([checkpoint.restore(image) for image in targets_for_object]):
                        resumed.add(ob)
                log(f"emission checkpoint: reused {len(resumed)}/{len(receivers)} receivers")
            # A prominent receiver can need cleaner lighting without making
            # every distant rock and the probe field pay for its sample count.
            groups = {}
            for ob in receivers:
                if ob in resumed:
                    continue
                count = int(ob.get("game_light_samples", scene.get("game_light_samples", 64)))
                if count < 1:
                    raise ValueError(f"{ob.name}: game_light_samples must be positive")
                groups.setdefault(count, []).append(ob)
            for count, group in sorted(groups.items()):
                # Keep sibling chunks adjacent so each batch shares a bake.
                group.sort(key=lambda ob: ob.name)
                scene.cycles.samples = count
                log(f"emission lighting: baking {len(group)} receivers at {count} samples")
                started = time.monotonic()
                # Bound the active bake targets as spatial chunks multiply.
                # All scene geometry stays visible to rays; only the selected
                # receivers change between batches. This also exposes progress
                # instead of one silent operation over hundreds of receivers.
                from scene_export import bake_device
                device = bake_device()
                scene.cycles.device = "CPU" if device == "CPU" else "GPU"
                log(f"emission lighting: surface device {device}")
                for first in range(0, len(group), 8):
                    batch = group[first:first + 8]
                    diffuse_bake(batch)
                    for ob in batch:
                        # Cycles can report FINISHED without writing a target.
                        # Detect that here, before spending time on later maps.
                        values = [lightmap_pixels(image) for image in targets[ob]]
                        if any(not np.any(px[:, :, 3] > .5) for px in values):
                            log(f"emission lighting: {ob.name}: unwritten target; retrying on CPU")
                            previous_device = scene.cycles.device
                            try:
                                scene.cycles.device = "CPU"
                                diffuse_bake([ob])
                            finally:
                                scene.cycles.device = previous_device
                            values = [lightmap_pixels(image) for image in targets[ob]]
                        for image, px in zip(targets[ob], values):
                            if not np.any(px[:, :, 3] > .5):
                                raise ValueError(f"empty lightmap bake after CPU retry: {ob.name}")
                            if not np.isfinite(px).all():
                                raise ValueError(f"non-finite lightmap: {ob.name}")
                            if checkpoint is not None:
                                checkpoint.save(image, px)
                    log(f"emission lighting: {min(first + 8, len(group))}/{len(group)} receivers "
                        f"at {count} samples, {time.monotonic()-started:.1f}s")
                log(f"emission timing: {count}-sample bake {time.monotonic()-started:.1f}s")
            from lightmap_denoise import LightmapDenoiser
            denoiser = LightmapDenoiser()
        started = time.monotonic()
        # Wire only after ALL baking: a lightmap must never illuminate another bake.
        for ob, image, materials in images:
            import native
            values = np.empty(image.size[1] * image.size[0] * 4, dtype=np.float32)
            image.pixels.foreach_get(values)
            values = values.reshape(image.size[1], image.size[0], 4)
            # Fill only unbaked background, never genuine zero-light samples.
            # This extends island edges into the gaps for texture filtering.
            if not native.fill_background(values):
                raise ValueError(f"empty lightmap bake: {ob.name}")
            denoiser.apply(values)
            log(f"emission lightmap denoised: {ob.name}")
            values = values.reshape(-1, 4)
            if not np.isfinite(values).all():
                raise ValueError(f"non-finite lightmap: {ob.name}")
            strength = max(1., float(values[:,:3].max()))
            if surface_only:
                linear = np.maximum(0, values[:,:3] / strength)
                values[:,:3] = np.where(linear <= .0031308, linear*12.92, 1.055*linear**(1/2.4)-.055)
            else:
                from lightmap_encoding import encode_lightmap
                values[:,:3] = encode_lightmap(values[:,:3], strength)
            name = image.name
            image.name = name + " linear"
            encoded = bpy.data.images.new(name, image.size[0], image.size[1], alpha=False)
            encoded.colorspace_settings.name = "sRGB"
            encoded["generated_by"] = "tools/blender/emission_bake.py"
            encoded.pixels.foreach_set(values.ravel())
            encoded.pack()
            for mat in materials:
                node = next(n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image == image)
                node.image = encoded
                if surface_only:
                    mat["game_preview_lightmap"] = encoded
                    mat["game_preview_lightmap_strength"] = strength
                else:
                    for bsdf in (n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"):
                        mat.node_tree.links.new(node.outputs["Color"], bsdf.inputs["Emission Color"])
                        bsdf.inputs["Emission Strength"].default_value = 1
                maps[mat.name] = {"version": 1} if surface_only else {
                    "version": 1, "encoding": "log1p", "range": strength}
            bpy.data.images.remove(image)
        log(f"emission timing: denoise and encode {time.monotonic()-started:.1f}s")
        log(f"emission lighting: {len(images)} static lightmaps")
        return maps, field
    finally:
        if denoiser is not None:
            denoiser.close()
        for nt,socket,original,scale in boosted:
            if scale is None:
                socket.default_value = original
            else:
                nt.links.new(original,socket)
                nt.nodes.remove(scale)
        scene.world, scene.render.engine, scene.cycles.samples = saved_world, saved_engine, samples
        scene.cycles.device = saved_device
        for key, value in saved_sampling.items():
            setattr(scene.cycles, key, value)
        for layer, count in saved_layer_samples:
            layer.samples = count
        scene.cycles.sample_clamp_direct, scene.cycles.sample_clamp_indirect, scene.cycles.use_fast_gi = saved_clamps
        scene.render.use_simplify, scene.cycles.texture_limit_render = saved_simplify
        for ob, state in hidden.items():
            ob.hide_render = state
        bpy.data.worlds.remove(dark)
        if objects:
            select(objects)


def lightmap_pixels(image):
    values = np.empty(image.size[1] * image.size[0] * 4, dtype=np.float32)
    image.pixels.foreach_get(values)
    return values.reshape(image.size[1], image.size[0], 4)


def embed(path, maps, field):
    """Keep only our metadata, without exporting all Blender custom properties."""
    if not maps and field is None:
        return
    with open(path, "rb") as f:
        data = f.read()
    length = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20+length])
    for mat in doc.get("materials", []):
        if mat.get("name") in maps:
            mat.setdefault("extras", {})[KEY] = maps[mat["name"]]
    if field:
        doc["scenes"][doc.get("scene", 0)].setdefault("extras", {})[KEY] = field
    raw = json.dumps(doc, separators=(",", ":")).encode()
    raw += b" " * (-len(raw) % 4)
    tail = data[20+length:]
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546c67, 2, 20+len(raw)+len(tail)))
        f.write(struct.pack("<II", len(raw), 0x4e4f534a))
        f.write(raw)
        f.write(tail)
