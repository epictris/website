"""Generation detail budget for High DOF, in world metres.

Matches render3d/depthOfField.ts: radius/H = .016 * (1 - s/d).
For the head-on perspective camera H_world = d * sensor_height/lens,
so radius_world = .016 * sensor_height/lens * (Blender y - 1.5).
Camera distance cancels. Use the nearest painted extent, never the origin.
"""
import math
from dataclasses import replace
import numpy as np

FOCUS_BAND = 1.5
HIGH_BLUR = 0.016
DEFAULT_SLOPE = 2 * math.tan(math.radians(34) / 2)


def budget(matrix, stamps, vines=None, margin=0.0, slope=DEFAULT_SLOPE):
    m = np.asarray(matrix, dtype=float)
    depths = []
    painted = stamps.strength > 0
    if np.any(painted):
        y = (stamps.position[painted] @ m[:3, :3].T + m[:3, 3])[:, 1]
        depths.extend(y - stamps.radius[painted])  # radii are world metres
    if vines is not None and len(vines):
        y = (vines.position @ m[:3, :3].T + m[:3, 3])[:, 1]
        # A strand can bend away from its anchor; its whole length is safe.
        depths.extend(y - vines.length)
    if not depths:
        return 0.0
    radius = HIGH_BLUR * slope * max(0.0, min(depths) - margin - FOCUS_BAND)
    # Two samples per blur radius retain silhouettes and soft colour changes.
    return radius / 2


def scene_slope(scene):
    camera = next((o for o in scene.objects if o.type == "CAMERA" and o.name == "guide.camera"), None)
    return camera.data.sensor_height / camera.data.lens if camera else DEFAULT_SLOPE


def moss_params(p, texel):
    if texel <= 0:
        return p
    # Moss becomes colour on the rock once its grain is unresolved. Waiting
    # for the entire mound height kept distant banks in Mound unnecessarily.
    radius = 2 * texel
    texture_only = radius >= min(p.dab_min, p.floor + p.lift)
    # Scale the dab radius against blur radius, not against mesh spacing.
    # A minimum dab then spans the blur diameter; keep the authored size
    # range's proportions. No fine dabs are generated to downsample later.
    scale = max(1.0, radius / p.dab_min)
    kw = {"resolution": max(p.resolution, radius),
          "texel": max(p.texel, radius),
          "dab_min": p.dab_min * scale,
          "dab_max": p.dab_max * scale,
          "min_clump": max(1, round(p.min_clump / scale**2)),
          "edge_detail": max(p.edge_detail, radius / 2),
          "mound_density": min(p.mound_density, 2 / radius**2)}
    if texture_only or p.kind == "TEXTURE":
        kw.update(kind="TEXTURE", grass=0.0)
    elif radius >= p.grass_height:
        kw["grass"] = 0.0

    return replace(p, **kw)


def ivy_params(p, texel, vine_length=0.0):
    if texel <= 0:
        return p
    # Cutout leaves need more samples than solid moss: the alpha silhouette
    # and gaps between leaves remain visible through High DOF. Keep eight
    # samples per blur radius before switching cards or shrinking the atlas.
    texel *= 0.25
    clumps = p.detail == "CLUMPS" or texel >= p.leaf_min / 4
    kw = {"resolution": max(p.resolution, texel)}
    if clumps:
        kw.update(detail="CLUMPS", clump_min=max(p.clump_min, texel * 4),
                  clump_max=max(p.clump_max, texel * 6))
    # UV cells occupy 1/4 of the atlas; retain gutters and alpha silhouettes.
    extent = max(kw.get("clump_max", p.leaf_max), vine_length, p.leaf_size)
    wanted = max(64, 4 * extent / texel)
    kw["atlas_size"] = min(1024, 2 ** math.ceil(math.log2(wanted)))
    return replace(p, **kw)


def circle_segments(radius, tolerance, maximum, minimum=8, angle=2 * math.pi):
    """Polygon chord error bounded in metres; never finer than authored."""
    if tolerance <= 0 or radius <= 0:
        return maximum
    step = 2 * math.acos(max(-1.0, min(1.0, 1 - tolerance / radius)))
    return min(maximum, max(minimum, math.ceil(angle / max(step, 1e-8))))
